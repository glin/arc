// Measure two builds on one frozen fixture, in series, and fail past a margin.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { arcHome } from '../../src/store.ts';

// A candidate regresses when its value exceeds the baseline by this ratio and by the floor of its kind.
export const MARGINS = { time: 1.5, count: 1.5, bytes: 1.5, memory: 1.25 } as const;
// Differences below these floors are noise on a shared machine, whatever their ratio.
export const FLOORS = { time: 1000, count: 5, bytes: 1024 * 1024, memory: 64 * 1024 * 1024 } as const;
type Kind = keyof typeof MARGINS;

export interface Measure {
  name: string;
  kind: Kind;
  baseline: number | null;
  candidate: number | null;
  ratio: number | null;
  margin: number;
  regressed: boolean;
}

interface RunResult {
  source?: string;
  complete?: boolean;
  note?: string | null;
  firstUsableRowMs?: number | null;
  lines?: Array<{ event?: string; milestone?: string; elapsedMs?: number }>;
  startupRecord?: { stages?: Record<string, number>; memory?: { processLifetimeMaximumRssBytes?: number } } | null;
  memory?: { peakWorkingSetBytes?: number | null; sampledMaximumWorkingSetBytes?: number | null };
  soak?: { end?: Record<string, number> | null };
}

const COUNTS = new Set([
  'publications',
  'partialPublications',
  'continuations',
  'dispatchSpendVisits',
  'dispatchSpendRootRestarts',
  'catalogWalks',
]);
const BYTES = new Set(['dispatchSpendBytes', 'readBytes']);

// Read the comparison's measures from one runner result.
export function measuresOf(result: RunResult): Map<string, { kind: Kind; value: number | null }> {
  const out = new Map<string, { kind: Kind; value: number | null }>();
  const milestone = (name: string) =>
    result.lines?.find((line) => line.event === 'startup' && line.milestone === name)?.elapsedMs ?? null;
  out.set('firstUsableRowMs', {
    kind: 'time',
    value: result.startupRecord?.stages?.firstUsableRow ?? result.firstUsableRowMs ?? null,
  });
  out.set('firstPassMs', {
    kind: 'time',
    value: result.startupRecord?.stages?.completeRender ?? milestone('completeRender'),
  });
  for (const [name, value] of Object.entries(result.soak?.end ?? {})) {
    const kind: Kind =
      COUNTS.has(name) || name.startsWith('refreshCount:') ? 'count' : BYTES.has(name) ? 'bytes' : 'time';
    out.set(name, { kind, value });
  }
  out.set('peakHostMemoryBytes', {
    kind: 'memory',
    value:
      result.memory?.peakWorkingSetBytes ??
      result.memory?.sampledMaximumWorkingSetBytes ??
      result.startupRecord?.memory?.processLifetimeMaximumRssBytes ??
      null,
  });
  return out;
}

export function compareResults(baseline: RunResult, candidate: RunResult): Measure[] {
  const before = measuresOf(baseline);
  const after = measuresOf(candidate);
  const names = [...new Set([...before.keys(), ...after.keys()])];
  return names.map((name) => {
    const kind = (before.get(name) ?? after.get(name))!.kind;
    const a = before.get(name)?.value ?? null;
    const b = after.get(name)?.value ?? null;
    const ratio = a !== null && b !== null ? (a === 0 ? (b === 0 ? 1 : Infinity) : b / a) : null;
    const margin = MARGINS[kind];
    // A measure only the candidate reports compares with zero, so a new refresh reason still counts.
    const regressed = b !== null && b - (a ?? 0) > FLOORS[kind] && (a === null || a === 0 || b / a > margin);
    return { name, kind, baseline: a, candidate: b, ratio, margin, regressed };
  });
}

function figure(value: number | null, kind: Kind): string {
  if (value === null) return 'not reported';
  if (kind === 'time') return `${(value / 1000).toFixed(1)} s`;
  if (kind === 'bytes' || kind === 'memory') return `${(value / 1024 / 1024).toFixed(1)} MiB`;
  return String(value);
}

export function markdownTable(measures: Measure[], baseline: string, candidate: string): string {
  const rows = measures.map(
    (m) =>
      `| ${m.name} | ${figure(m.baseline, m.kind)} | ${figure(m.candidate, m.kind)} | ${
        m.ratio === null ? 'n/a' : Number.isFinite(m.ratio) ? m.ratio.toFixed(2) : 'new'
      } | ${m.margin} | ${m.regressed ? 'regressed' : 'within'} |`,
  );
  return [
    `| Measure | ${baseline} | ${candidate} | Ratio | Margin | Result |`,
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

// The commit of the installed build, from the owner's newest startup history record.
export function installedCommit(
  startup = path.join(arcHome(), 'startup'),
): { commit: string; dirty: boolean; at: string } | null {
  let newest: { commit: string; dirty: boolean; at: string } | null = null;
  try {
    for (const name of fs.readdirSync(startup).filter((entry) => entry.endsWith('.jsonl'))) {
      for (const text of fs.readFileSync(path.join(startup, name), 'utf8').split('\n')) {
        if (!text.trim()) continue;
        const record = JSON.parse(text) as { at?: string; artifact?: { sourceCommit?: string; dirty?: boolean } };
        const commit = record.artifact?.sourceCommit;
        if (commit && record.at && (!newest || record.at > newest.at))
          newest = { commit, dirty: record.artifact?.dirty === true, at: record.at };
      }
    }
  } catch {
    return null;
  }
  return newest;
}

function runMeasure(args: string[], log: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(__dirname, '../../node_modules/tsx/dist/cli.mjs'), path.join(__dirname, 'measure.ts'), ...args],
      {
        cwd: path.resolve(__dirname, '../..'),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const output = fs.createWriteStream(log);
    let text = '';
    child.stdout.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
      output.write(chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output.write(chunk);
      process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', () => {
      output.end();
      const scratch = /^Owned paths and artifacts: (.+)$/m.exec(text)?.[1]?.trim();
      if (!scratch) reject(new Error(`The runner named no run directory. Read ${log}.`));
      else resolve(path.join(scratch, 'result.json'));
    });
  });
}

function write(output: string, report: Record<string, unknown>, table: string): void {
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'compare.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(output, 'compare.md'), table + '\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const output = path.resolve(value('--output') ?? path.join(os.tmpdir(), `arc-compare-${Date.now()}`));
  const installed = installedCommit();
  let baselineResult: RunResult;
  let candidateResult: RunResult;
  let baselineLabel: string;
  let candidateLabel: string;
  let fixture: Record<string, unknown> | null = null;
  const results = value('--results');
  if (results) {
    // Compare two saved runner results without launching an editor.
    const [a, b] = [results, args[args.indexOf('--results') + 2]];
    baselineResult = JSON.parse(fs.readFileSync(a, 'utf8')) as RunResult;
    candidateResult = JSON.parse(fs.readFileSync(b, 'utf8')) as RunResult;
    baselineLabel = baselineResult.source?.slice(0, 9) ?? 'baseline';
    candidateLabel = candidateResult.source?.slice(0, 9) ?? 'candidate';
  } else {
    const manifest = value('--fixture');
    const candidate = value('--candidate');
    const baseline = value('--baseline') ?? installed?.commit;
    if (!manifest || !candidate || !baseline)
      throw new Error('Name --fixture and --candidate. Name --baseline when no installed build is recorded.');
    const soak = value('--soak') ?? '10';
    const timeout = value('--timeout') ?? '900';
    fs.mkdirSync(output, { recursive: true });
    const manifestText = fs.readFileSync(manifest);
    fixture = {
      manifest: path.resolve(manifest),
      sha256: createHash('sha256').update(manifestText).digest('hex'),
      frozen: (JSON.parse(manifestText.toString('utf8')) as { frozen?: unknown }).frozen ?? null,
    };
    // Each build runs its warm-up launch and its measured launch back to back. The builds never overlap.
    const run = (ref: string, label: string) =>
      runMeasure(
        [
          '--fixture',
          manifest,
          '--commit',
          ref,
          '--warm-up',
          '--soak',
          soak,
          '--timeout',
          timeout,
          ...(args.includes('--keep') ? ['--keep'] : []),
        ],
        path.join(output, `${label}.log`),
      );
    const baselineFile = await run(baseline, 'baseline');
    fs.copyFileSync(baselineFile, path.join(output, 'baseline-result.json'));
    const candidateFile = await run(candidate, 'candidate');
    fs.copyFileSync(candidateFile, path.join(output, 'candidate-result.json'));
    baselineResult = JSON.parse(fs.readFileSync(baselineFile, 'utf8')) as RunResult;
    candidateResult = JSON.parse(fs.readFileSync(candidateFile, 'utf8')) as RunResult;
    baselineLabel = baseline.slice(0, 9);
    candidateLabel = candidate.slice(0, 9);
  }
  const measures = compareResults(baselineResult, candidateResult);
  const complete = baselineResult.complete === true && candidateResult.complete === true;
  const regressions = measures.filter((m) => m.regressed).map((m) => m.name);
  const table = markdownTable(measures, baselineLabel, candidateLabel);
  write(
    output,
    {
      baseline: {
        label: baselineLabel,
        source: baselineResult.source ?? null,
        complete: baselineResult.complete ?? false,
        note: baselineResult.note ?? null,
      },
      candidate: {
        label: candidateLabel,
        source: candidateResult.source ?? null,
        complete: candidateResult.complete ?? false,
        note: candidateResult.note ?? null,
      },
      installed,
      fixture,
      margins: MARGINS,
      floors: FLOORS,
      measures,
      regressions,
      complete,
    },
    table,
  );
  process.stdout.write(`\n${table}\n\nComparison: ${output}\n`);
  if (!complete) {
    process.stderr.write('A run remained incomplete, so the comparison proves nothing.\n');
    process.exitCode = 2;
  } else if (regressions.length) {
    process.stderr.write(`The candidate regressed past its margin: ${regressions.join(', ')}.\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename)
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
