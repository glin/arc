import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import v8 from 'node:v8';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { readPreviousLines, readSession, tailOf } from '../src/transcript.ts';
import { readCodexSession } from '../src/codex.ts';
import { retainedRangeFingerprint } from '../src/turnread.ts';

export const MIB = 1024 * 1024;
export const ORDINARY_TAIL_BYTES = 4 * MIB;
export const HISTORY_CHUNK_BYTES = 1 * MIB;
export const PAGE_TURN_TARGET = 20;

const DEFAULT_FIXTURE_TARGETS = {
  normal: 1 * MIB,
  overTail: 5 * MIB,
  overCeiling: 33 * MIB,
};
const CODEX_META_BYTES = 128 * 1024;
const INITIAL_TURN_LIMIT = 40;
const FORMATS = ['claude', 'codex'];
const SHAPES = ['normal', 'overTail', 'overCeiling'];
const STRATEGIES = ['bounded', 'eager', 'chunkedPage'];
const PATHS = ['unchangedRefresh', 'appendOpenTurn', 'firstSelection', 'olderPageRequest'];

let recordSequence = 0;

function stamp(second) {
  return new Date(Date.UTC(2026, 7, 31, 12, 0, second % 60)).toISOString();
}

function payload(size, seed) {
  const unit = `${seed.toString(36).padStart(4, '0')}:abcdefghijklmnopqrstuvwxyz0123456789:`;
  return unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
}

function writeLine(fd, record) {
  const line = `${JSON.stringify(record)}\n`;
  return fs.writeSync(fd, line, undefined, 'utf8');
}

function claudePrompt(text, second) {
  return {
    type: 'user',
    promptId: `prompt-${++recordSequence}`,
    timestamp: stamp(second),
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

function writeClaudeTurn(fd, turn, bodyBytes, open) {
  let written = writeLine(fd, claudePrompt(`Generated request ${turn}`, turn));
  let item = 0;
  while (written < bodyBytes) {
    const id = `tool-${turn}-${item}`;
    written += writeLine(fd, {
      type: 'assistant',
      timestamp: stamp(turn + 1),
      message: {
        role: 'assistant',
        id: `message-${turn}-${item}`,
        model: 'claude-opus-5',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `inspect-${item}` } }],
        usage: { input_tokens: 20, output_tokens: 10 },
      },
    });
    written += writeLine(fd, {
      type: 'user',
      timestamp: stamp(turn + 2),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: payload(48 * 1024, turn * 1000 + item) }],
      },
    });
    item += 1;
  }
  if (!open) {
    written += writeLine(fd, {
      type: 'assistant',
      timestamp: stamp(turn + 3),
      message: {
        role: 'assistant',
        id: `answer-${turn}`,
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: `Completed generated request ${turn}.` }],
        usage: { input_tokens: 20, output_tokens: 10 },
      },
    });
  }
  return written;
}

const CODEX_SESSION_ID = '01a032c9-1a92-7931-845c-723117d24dbe';

function codexRecord(type, second, payloadValue) {
  return { timestamp: stamp(second), type, payload: payloadValue };
}

function writeCodexTurn(fd, turn, bodyBytes, open) {
  const turnId = `01a032c9-1e07-78b2-ae0c-${turn.toString().padStart(12, '0')}`;
  let written = writeLine(
    fd,
    codexRecord('event_msg', turn, {
      type: 'task_started',
      turn_id: turnId,
      model_context_window: 258400,
    }),
  );
  written += writeLine(
    fd,
    codexRecord('turn_context', turn + 1, {
      turn_id: turnId,
      cwd: 'c:\\generated',
      model: 'gpt-5.6-sol',
      effort: 'high',
    }),
  );
  written += writeLine(
    fd,
    codexRecord('event_msg', turn + 2, {
      type: 'user_message',
      message: `Generated request ${turn}`,
    }),
  );
  let item = 0;
  while (written < bodyBytes) {
    const callId = `call-${turn}-${item}`;
    written += writeLine(
      fd,
      codexRecord('response_item', turn + 3, {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: callId,
        input: `const result = inspect(${item});`,
      }),
    );
    written += writeLine(
      fd,
      codexRecord('response_item', turn + 4, {
        type: 'custom_tool_call_output',
        call_id: callId,
        output: [{ type: 'input_text', text: payload(48 * 1024, turn * 1000 + item) }],
      }),
    );
    item += 1;
  }
  if (!open) {
    written += writeLine(
      fd,
      codexRecord('event_msg', turn + 5, {
        type: 'task_complete',
        turn_id: turnId,
        last_agent_message: `Completed generated request ${turn}.`,
        duration_ms: 1000,
      }),
    );
  }
  return written;
}

function writeFixture(file, format, shape, targetBytes) {
  const fd = fs.openSync(file, 'w');
  try {
    if (format === 'codex') {
      writeLine(
        fd,
        codexRecord('session_meta', 0, {
          session_id: CODEX_SESSION_ID,
          id: CODEX_SESSION_ID,
          cwd: 'c:\\generated',
          originator: 'codex_vscode',
          source: 'vscode',
          model_provider: 'openai',
        }),
      );
    }
    const completedTurns = shape === 'normal' ? 48 : 24;
    const completedBody =
      shape === 'normal' ? Math.max(4 * 1024, Math.floor(targetBytes / completedTurns)) : 192 * 1024;
    for (let turn = 1; turn <= completedTurns; turn += 1) {
      if (format === 'claude') {
        writeClaudeTurn(fd, turn, completedBody, false);
      } else {
        writeCodexTurn(fd, turn, completedBody, false);
      }
    }
    const newestStart = fs.fstatSync(fd).size;
    if (format === 'claude') {
      writeClaudeTurn(fd, completedTurns + 1, targetBytes, shape !== 'normal');
    } else {
      writeCodexTurn(fd, completedTurns + 1, targetBytes, shape !== 'normal');
    }
    const size = fs.fstatSync(fd).size;
    return { format, shape, file, size, newestTurnBytes: size - newestStart };
  } finally {
    fs.closeSync(fd);
  }
}

export function generateFixtures(root, targets = DEFAULT_FIXTURE_TARGETS) {
  fs.mkdirSync(root, { recursive: true });
  const fixtures = [];
  for (const format of FORMATS) {
    for (const shape of SHAPES) {
      fixtures.push(writeFixture(path.join(root, `${format}-${shape}.jsonl`), format, shape, targets[shape]));
    }
  }
  return fixtures;
}

function readFor(format, file, tailBytes, maxTurns, prepareNewestTurnDiscovery = false) {
  const options = { tailBytes, maxTurns, prepareNewestTurnDiscovery };
  return format === 'claude'
    ? readSession(file, 'benchmark-session', options)
    : readCodexSession(file, CODEX_SESSION_ID, options);
}

function sourceReadBytes(format, size, tailBytes) {
  return Math.min(size, tailBytes) + (format === 'codex' ? Math.min(size, CODEX_META_BYTES) : 0);
}

function isBoundary(format, text) {
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return false;
  }
  if (format === 'claude') {
    if (record.type !== 'user' || record.message?.role !== 'user') {
      return false;
    }
    const content = record.message?.content;
    return Array.isArray(content) && content.some((block) => block?.type === 'text');
  }
  return record.type === 'event_msg' && record.payload?.type === 'task_started';
}

function sampleMemory(samples) {
  const memory = process.memoryUsage();
  samples.rss = Math.max(samples.rss, memory.rss);
  samples.heap = Math.max(samples.heap, memory.heapUsed);
}

async function scanPage(format, file, samples) {
  const size = fs.statSync(file).size;
  const initial = tailOf(file, HISTORY_CHUNK_BYTES, true);
  let bytesRead = Math.min(size, HISTORY_CHUNK_BYTES);
  let boundaries = initial.lines.reduce((count, line) => count + Number(isBoundary(format, line)), 0);
  let tailBytes = bytesRead;
  let cursor = initial.cursor;
  sampleMemory(samples);
  while (boundaries < PAGE_TURN_TARGET && cursor) {
    const batch = readPreviousLines(file, cursor, HISTORY_CHUNK_BYTES);
    assert(batch, 'fixture changed during page scan');
    bytesRead += cursor.end - batch.cursor.end;
    for (const line of batch.lines) {
      if (!isBoundary(format, line.text)) {
        continue;
      }
      boundaries += 1;
      if (boundaries === PAGE_TURN_TARGET) {
        tailBytes = size - Math.max(0, line.offset - 1);
        break;
      }
    }
    cursor = boundaries >= PAGE_TURN_TARGET ? undefined : batch.cursor;
    if (cursor?.end === 0) {
      cursor = undefined;
      tailBytes = size;
    }
    sampleMemory(samples);
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (boundaries < PAGE_TURN_TARGET) {
    tailBytes = size;
  }
  const read = readFor(format, file, tailBytes, PAGE_TURN_TARGET);
  bytesRead += sourceReadBytes(format, size, tailBytes);
  return { read, bytesRead, largestReadBytes: Math.min(size, tailBytes), boundaries };
}

async function currentFirstSelection(format, file, samples) {
  const size = fs.statSync(file).size;
  const initial = readFor(format, file, ORDINARY_TAIL_BYTES, INITIAL_TURN_LIMIT, true);
  let bytesRead = sourceReadBytes(format, size, ORDINARY_TAIL_BYTES);
  sampleMemory(samples);
  if (!initial.newestTurnCursor) {
    const retained = fingerprintRead(file, initial);
    return {
      read: initial,
      bytesRead: bytesRead + retained,
      largestReadBytes: Math.min(size, ORDINARY_TAIL_BYTES),
    };
  }
  let discoveredBytes = 0;
  const readRange = (source, start, length, revision) => {
    let fd = -1;
    try {
      fd = fs.openSync(source, 'r');
      const before = fs.fstatSync(fd);
      if (!sameRevision(before, revision)) {
        return null;
      }
      const buffer = Buffer.allocUnsafe(length);
      let read = 0;
      while (read < length) {
        const count = fs.readSync(fd, buffer, read, length - read, start + read);
        if (count <= 0) {
          return null;
        }
        read += count;
      }
      if (!sameRevision(fs.fstatSync(fd), revision)) {
        return null;
      }
      discoveredBytes += length;
      sampleMemory(samples);
      return buffer;
    } catch {
      return null;
    } finally {
      if (fd >= 0) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
  };
  const options = {
    chunkBytes: HISTORY_CHUNK_BYTES,
    readRange,
    pause: async () => {
      sampleMemory(samples);
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
  const module = format === 'claude' ? await import('../src/transcript.ts') : await import('../src/codex.ts');
  const result =
    format === 'claude'
      ? await module.discoverClaudeNewestTurn(file, initial.newestTurnCursor, options)
      : await module.discoverCodexNewestTurn(file, initial.newestTurnCursor, initial.newestTurnState, options);
  assert.notEqual(result.kind, 'stale');
  assert.notEqual(result.kind, 'cancelled');
  const finalBytes = result.kind === 'found' ? result.readBytes : size;
  const read = readFor(format, file, finalBytes, INITIAL_TURN_LIMIT);
  const retained = fingerprintRead(file, read);
  bytesRead += discoveredBytes + sourceReadBytes(format, size, finalBytes) + retained;
  return {
    read,
    bytesRead,
    largestReadBytes: Math.max(Math.min(size, ORDINARY_TAIL_BYTES), Math.min(size, finalBytes)),
  };
}

function sameRevision(stat, revision) {
  return (
    stat.size === revision.size &&
    stat.mtimeMs === revision.mtimeMs &&
    stat.dev === revision.dev &&
    stat.ino === revision.ino
  );
}

function retainedBytes(read, size) {
  return Math.min(size, Math.max(0, read.readBytes));
}

function fingerprintRead(file, read) {
  const size = fs.statSync(file).size;
  const bytes = retainedBytes(read, size);
  const fingerprint = retainedRangeFingerprint(file, size - bytes, size);
  assert(fingerprint, 'retained range could not be fingerprinted');
  return bytes;
}

function appendRecord(format) {
  if (format === 'claude') {
    return `${JSON.stringify({
      type: 'assistant',
      timestamp: stamp(59),
      message: {
        role: 'assistant',
        id: 'append-message',
        model: 'claude-opus-5',
        stop_reason: 'tool_use',
        content: [{ type: 'text', text: 'Appended update.' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })}\n`;
  }
  return `${JSON.stringify(
    codexRecord('event_msg', 59, {
      type: 'agent_message',
      message: 'Appended update.',
      phase: 'commentary',
    }),
  )}\n`;
}

async function runOperation(kind, format, file, samples) {
  if (kind === 'unchangedRefresh') {
    const cached = fs.statSync(file);
    const measuredStarted = performance.now();
    const current = fs.statSync(file);
    assert.equal(current.size, cached.size);
    assert.equal(current.mtimeMs, cached.mtimeMs);
    return { read: null, bytesRead: 0, largestReadBytes: 0, measuredStarted };
  }
  const size = fs.statSync(file).size;
  if (kind === 'bounded') {
    return {
      read: readFor(format, file, ORDINARY_TAIL_BYTES, INITIAL_TURN_LIMIT),
      bytesRead: sourceReadBytes(format, size, ORDINARY_TAIL_BYTES),
      largestReadBytes: Math.min(size, ORDINARY_TAIL_BYTES),
    };
  }
  if (kind === 'eager') {
    return {
      read: readFor(format, file, size, INITIAL_TURN_LIMIT),
      bytesRead: sourceReadBytes(format, size, size),
      largestReadBytes: size,
    };
  }
  if (kind === 'chunkedPage') {
    return scanPage(format, file, samples);
  }
  if (kind === 'firstSelection') {
    return currentFirstSelection(format, file, samples);
  }
  if (kind === 'olderPageRequest') {
    const selected = await currentFirstSelection(format, file, samples);
    const oldBytes = retainedBytes(selected.read, size);
    global.gc?.();
    const measuredStarted = performance.now();
    const oldFingerprint = retainedRangeFingerprint(file, size - oldBytes, size);
    assert(oldFingerprint);
    const bytes = Math.min(size, 2 * ORDINARY_TAIL_BYTES);
    const read = readFor(format, file, bytes, 2 * INITIAL_TURN_LIMIT);
    const newBytes = fingerprintRead(file, read);
    const measuredElapsedMs = performance.now() - measuredStarted;
    return {
      read,
      bytesRead: oldBytes + sourceReadBytes(format, size, bytes) + newBytes,
      largestReadBytes: bytes,
      measuredElapsedMs,
    };
  }
  if (kind === 'appendOpenTurn') {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'history-append-'));
    const copy = path.join(temporaryRoot, path.basename(file));
    try {
      fs.copyFileSync(file, copy);
      const selected = await currentFirstSelection(format, copy, samples);
      const oldSize = fs.statSync(copy).size;
      const oldBytes = retainedBytes(selected.read, oldSize);
      fs.appendFileSync(copy, appendRecord(format));
      const newSize = fs.statSync(copy).size;
      global.gc?.();
      const measuredStarted = performance.now();
      const oldFingerprint = retainedRangeFingerprint(copy, oldSize - oldBytes, oldSize);
      assert(oldFingerprint);
      const nextBytes = Math.min(newSize, oldBytes + newSize - oldSize);
      const read = readFor(format, copy, nextBytes, INITIAL_TURN_LIMIT);
      const newBytes = fingerprintRead(copy, read);
      const measuredElapsedMs = performance.now() - measuredStarted;
      return {
        read,
        bytesRead: oldBytes + sourceReadBytes(format, newSize, nextBytes) + newBytes,
        largestReadBytes: Math.max(oldBytes, nextBytes),
        measuredElapsedMs,
      };
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
  throw new Error(`Unknown operation: ${kind}`);
}

function warmFile(file) {
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let position = 0;
    while (fs.readSync(fd, buffer, 0, buffer.length, position) > 0) {
      position += buffer.length;
    }
  } finally {
    fs.closeSync(fd);
  }
}

async function worker(args) {
  const [kind, format, file] = args;
  warmFile(file);
  global.gc?.();
  const beforeMemory = process.memoryUsage();
  const beforeMaxRss = process.resourceUsage().maxRSS * 1024;
  const samples = { rss: beforeMemory.rss, heap: beforeMemory.heapUsed };
  const defaultStarted = performance.now();
  const outcome = await runOperation(kind, format, file, samples);
  sampleMemory(samples);
  const elapsedMs = outcome.measuredElapsedMs ?? performance.now() - (outcome.measuredStarted ?? defaultStarted);
  const afterMaxRss = process.resourceUsage().maxRSS * 1024;
  const retainedBytesValue = outcome.read ? v8.serialize(outcome.read).byteLength : 0;
  return {
    elapsedMs,
    bytesRead: outcome.bytesRead,
    largestReadBytes: outcome.largestReadBytes,
    peakRssBytes: Math.max(samples.rss, afterMaxRss),
    baselineRssBytes: Math.max(beforeMemory.rss, beforeMaxRss),
    peakHeapBytes: samples.heap,
    baselineHeapBytes: beforeMemory.heapUsed,
    retainedDerivedBytes: retainedBytesValue,
    turnCount: outcome.read?.turns.length ?? 0,
  };
}

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)];
}

function summarize(records) {
  const numeric = [
    'elapsedMs',
    'bytesRead',
    'largestReadBytes',
    'peakRssBytes',
    'baselineRssBytes',
    'peakHeapBytes',
    'baselineHeapBytes',
    'retainedDerivedBytes',
    'turnCount',
  ];
  return Object.fromEntries(numeric.map((key) => [key, median(records.map((record) => record[key]))]));
}

function runWorker(kind, fixture) {
  const result = spawnSync(
    process.execPath,
    ['--expose-gc', '--import', 'tsx', fileURLToPath(import.meta.url), '--worker', kind, fixture.format, fixture.file],
    { cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`Worker failed for ${fixture.format}/${fixture.shape}/${kind}:\n${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout.trim());
}

export function validateReport(report) {
  assert.equal(report.fixtures.length, FORMATS.length * SHAPES.length, 'fixture matrix is incomplete');
  assert.equal(
    report.matrix.length,
    FORMATS.length * SHAPES.length * STRATEGIES.length,
    'strategy matrix is incomplete',
  );
  assert.equal(report.paths.length, FORMATS.length * PATHS.length, 'refresh-path matrix is incomplete');
  const fixtureKeys = new Set(report.fixtures.map((row) => `${row.format}/${row.shape}`));
  const matrixKeys = new Set(report.matrix.map((row) => `${row.format}/${row.shape}/${row.strategy}`));
  const pathKeys = new Set(report.paths.map((row) => `${row.format}/${row.path}`));
  assert.deepEqual(
    fixtureKeys,
    new Set(FORMATS.flatMap((format) => SHAPES.map((shape) => `${format}/${shape}`))),
    'fixture coordinates are incomplete',
  );
  assert.deepEqual(
    matrixKeys,
    new Set(
      FORMATS.flatMap((format) =>
        SHAPES.flatMap((shape) => STRATEGIES.map((strategy) => `${format}/${shape}/${strategy}`)),
      ),
    ),
    'strategy coordinates are incomplete',
  );
  assert.deepEqual(
    pathKeys,
    new Set(FORMATS.flatMap((format) => PATHS.map((pathName) => `${format}/${pathName}`))),
    'refresh-path coordinates are incomplete',
  );
  for (const fixture of report.fixtures) {
    assert(fixture.size > 0, `${fixture.format}/${fixture.shape} is empty`);
    if (fixture.shape === 'normal') {
      assert(fixture.newestTurnBytes < ORDINARY_TAIL_BYTES, 'normal newest turn crossed the ordinary tail');
    } else if (fixture.shape === 'overTail') {
      assert(fixture.newestTurnBytes > ORDINARY_TAIL_BYTES, 'over-tail newest turn did not cross the ordinary tail');
      assert(fixture.newestTurnBytes < 32 * MIB, 'over-tail newest turn crossed the current ceiling');
    } else {
      assert(fixture.newestTurnBytes > 32 * MIB, 'over-ceiling newest turn did not cross the current ceiling');
    }
  }
  return report;
}

function formatMiB(bytes) {
  return (bytes / MIB).toFixed(2);
}

function printReport(report) {
  console.log('Fixtures');
  for (const fixture of report.fixtures) {
    console.log(`${fixture.format}\t${fixture.shape}\t${fixture.size}\t${fixture.newestTurnBytes}`);
  }
  console.log('\nMatrix (median of fresh processes)');
  console.log(
    'format\tshape\tstrategy\tms\tread MiB\tlargest MiB\tpeak RSS MiB\tRSS delta MiB\tpeak heap MiB\theap delta MiB\tretained KiB\tturns',
  );
  for (const row of report.matrix) {
    console.log(
      [
        row.format,
        row.shape,
        row.strategy,
        row.elapsedMs.toFixed(2),
        formatMiB(row.bytesRead),
        formatMiB(row.largestReadBytes),
        formatMiB(row.peakRssBytes),
        formatMiB(Math.max(0, row.peakRssBytes - row.baselineRssBytes)),
        formatMiB(row.peakHeapBytes),
        formatMiB(Math.max(0, row.peakHeapBytes - row.baselineHeapBytes)),
        (row.retainedDerivedBytes / 1024).toFixed(2),
        row.turnCount,
      ].join('\t'),
    );
  }
  console.log('\nRefresh paths (median of fresh processes)');
  console.log('format\tpath\tms\tread MiB\tlargest MiB\tretained KiB');
  for (const row of report.paths) {
    console.log(
      [
        row.format,
        row.path,
        row.elapsedMs.toFixed(2),
        formatMiB(row.bytesRead),
        formatMiB(row.largestReadBytes),
        (row.retainedDerivedBytes / 1024).toFixed(2),
      ].join('\t'),
    );
  }
}

async function main(args) {
  if (args[0] === '--worker') {
    process.stdout.write(JSON.stringify(await worker(args.slice(1))));
    return;
  }
  let repetitions = 3;
  let jsonFile = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--repetitions') {
      repetitions = Number(args[++i]);
    } else if (args[i] === '--json') {
      jsonFile = path.resolve(args[++i]);
    } else {
      throw new Error(`Unknown argument: ${args[i]}`);
    }
  }
  assert(Number.isInteger(repetitions) && repetitions > 0, 'repetitions must be a positive integer');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-benchmark-'));
  try {
    const fixtures = generateFixtures(root);
    const matrix = [];
    for (const fixture of fixtures) {
      for (const strategy of STRATEGIES) {
        const records = Array.from({ length: repetitions }, () => runWorker(strategy, fixture));
        matrix.push({ format: fixture.format, shape: fixture.shape, strategy, ...summarize(records) });
      }
    }
    const paths = [];
    for (const format of FORMATS) {
      const fixturesForFormat = fixtures.filter((fixture) => fixture.format === format);
      const byShape = new Map(fixturesForFormat.map((fixture) => [fixture.shape, fixture]));
      for (const pathName of PATHS) {
        const fixture = byShape.get('overTail');
        const records = Array.from({ length: repetitions }, () => runWorker(pathName, fixture));
        paths.push({ format, path: pathName, fixture: fixture.shape, ...summarize(records) });
      }
    }
    const report = validateReport({
      generatedAt: new Date().toISOString(),
      repetitions,
      constants: {
        ordinaryTailBytes: ORDINARY_TAIL_BYTES,
        currentCeilingBytes: 32 * MIB,
        historyChunkBytes: HISTORY_CHUNK_BYTES,
        pageTurnTarget: PAGE_TURN_TARGET,
      },
      fixtures: fixtures.map(({ file: _file, ...fixture }) => fixture),
      matrix,
      paths,
    });
    if (jsonFile) {
      fs.writeFileSync(jsonFile, `${JSON.stringify(report, null, 2)}\n`);
    }
    printReport(report);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
