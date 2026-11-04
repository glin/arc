// Opens one 70 MiB Codex rollout plain and compressed, each in a fresh Node.js process, and compares their peak
// resident memory. The compressed open fails when it uses more than the decoded length plus 16 MiB above the plain
// open. Run: node extension/scripts/compressed-open-memory.mjs
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';
import { buildSync } from 'esbuild';

const MIB = 1024 * 1024;
const source = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

if (!zlib.zstdCompressSync) {
  console.log(`Skipped: Node.js ${process.versions.node} has no zstd encoder.`);
  process.exit(0);
}

// The same rollout as the history page test: finished turns, then a newest turn of 8 MiB.
function rollout() {
  const at = (second) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
  const output = 'o'.repeat(60 * 1024);
  const lines = [
    JSON.stringify({
      timestamp: at(0),
      type: 'session_meta',
      payload: { id: 'large', cwd: 'c:\\large', model_provider: 'openai' },
    }),
  ];
  const turn = (index, outputs) => {
    const turnId = `turn-${index}`;
    lines.push(
      JSON.stringify({
        timestamp: at(index * 10),
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: turnId },
      }),
      JSON.stringify({
        timestamp: at(index * 10 + 2),
        type: 'event_msg',
        payload: { type: 'user_message', message: `request ${index}` },
      }),
    );
    for (let call = 0; call < outputs; call++)
      lines.push(
        JSON.stringify({
          timestamp: at(index * 10 + 3),
          type: 'response_item',
          payload: {
            type: 'custom_tool_call_output',
            call_id: `call-${index}-${call}`,
            output: [{ type: 'input_text', text: output }],
          },
        }),
      );
    lines.push(
      JSON.stringify({
        timestamp: at(index * 10 + 4),
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: turnId },
      }),
    );
  };
  for (let index = 1; index <= 270; index++) turn(index, 4);
  turn(271, 8 * 17);
  return Buffer.from(lines.join('\n') + '\n');
}

// The child opens the window as the worker does: the tail, the newest turn's start, then the window from that start.
const child = `
import { readCodexSessionIncrementalAsync } from './codexhistory';
import { discoverCodexNewestTurn, openingRecordOf } from './codex';
import { tailOf } from './transcript';
import { compressedByteSource, decodeCompressedRollout } from './compressedrollouts';
const [mode, file] = process.argv.slice(2);
let work = {};
let tail = (bytes) => tailOf(file, bytes, true);
let decoded = 0;
if (mode === 'compressed') {
  const opened = await decodeCompressedRollout(file);
  if (opened.kind !== 'body') throw new Error('The compressed rollout did not decode: ' + opened.kind);
  const body = compressedByteSource(opened.body);
  const opening = openingRecordOf(body.opening());
  work = { revision: body.revision, readRange: body.readRange, opening: () => opening };
  tail = (bytes) => body.tail(bytes, true);
  decoded = opened.body.length;
}
const options = { maxTurns: 40, tailBytes: 4 * 1024 * 1024 };
const first = await readCodexSessionIncrementalAsync(file, 'large', undefined, options, work);
const found = await discoverCodexNewestTurn(file, tail(options.tailBytes).cursor, undefined, {
  readRange: work.readRange,
  ...(work.opening ? { agentPath: work.opening()?.agentPath ?? null } : {}),
});
const read = await readCodexSessionIncrementalAsync(file, 'large', undefined, { ...options, tailBytes: found.readBytes }, work);
process.stdout.write(JSON.stringify({ maxRSS: process.resourceUsage().maxRSS * 1024, decoded, turns: read.read.turns.length, first: first.read.turns.length }));
`;

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-compressed-open-'));
try {
  const body = rollout();
  const plain = path.join(directory, 'rollout-large.jsonl');
  const compressed = path.join(directory, 'rollout-large.jsonl.zst');
  fs.writeFileSync(plain, body);
  fs.writeFileSync(compressed, zlib.zstdCompressSync(body));
  const bundle = path.join(directory, 'open.mjs');
  buildSync({
    stdin: { contents: child, resolveDir: source, loader: 'ts', sourcefile: 'open.ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: bundle,
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
  const open = (mode, file) => {
    const run = spawnSync(process.execPath, [bundle, mode, file], { encoding: 'utf8' });
    if (run.status !== 0) throw new Error(`The ${mode} open failed: ${run.stderr}`);
    return JSON.parse(run.stdout);
  };
  const plainOpen = open('plain', plain);
  const compressedOpen = open('compressed', compressed);
  const allowed = compressedOpen.decoded + 16 * MIB;
  const above = compressedOpen.maxRSS - plainOpen.maxRSS;
  const mib = (bytes) => (bytes / MIB).toFixed(1);
  console.log(
    `Node.js ${process.versions.node} on ${process.platform}: plain ${mib(plainOpen.maxRSS)} MiB, compressed ${mib(compressedOpen.maxRSS)} MiB, ` +
      `${mib(above)} MiB above plain, allowed ${mib(allowed)} MiB (decoded ${mib(compressedOpen.decoded)} MiB plus 16 MiB). ` +
      `Window turns: plain ${plainOpen.turns}, compressed ${compressedOpen.turns}.`,
  );
  if (plainOpen.turns !== compressedOpen.turns || plainOpen.first !== 0) {
    console.error('The two opens read different windows.');
    process.exitCode = 1;
  } else if (above > allowed) {
    console.error('The compressed open used more memory than the decoded length plus 16 MiB above the plain open.');
    process.exitCode = 1;
  }
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
