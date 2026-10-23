import { afterEach, describe, test, vi } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  CLAUDE_REPEATED_CHECK_BYTES,
  CLAUDE_REPEATED_CHECKPOINT_BYTES,
  ClaudeRepeatedDetector,
  ClaudeRepeatedPrefix,
  blankClaudeRepeated,
  claudeRecordIdentity,
  createClaudeRepeatedFilter,
  streamedClaudeRecordIdentity,
  forgetClaudeRepeatedLookups,
  forgetClaudeRepeatedMaps,
  adoptClaudeRepeatedMap,
  claudeRepeatedMap,
  heldClaudeRepeatedMap,
  insideClaudeRepeated,
  onClaudeRepeatedCoverage,
  publishClaudeRepeatedLedger,
  validClaudeRepeatedState,
} from './clauderepeated';
import { indexSpendFile, type IndexSpendFileResult, type SpendFileIndex } from './projectspend';
import { tempDir } from './temproot';
import { closeReadWindow, openReadWindow } from './readmeter';
import { retainedParserPayload } from './parserstate';
import { readClaudeHistoryPage, readClaudeSessionIncrementalAsync } from './claudehistory';
import {
  createClaudeSessionReducer,
  createClaudeUsageLineReducer,
  discoverClaudeNewestTurn,
  readSession,
  readSessionActivity,
  readSessionMeta,
  readSessionTurnStarts,
  readSessionWork,
  tailOf,
} from './transcript';
import { ProgressiveWorker } from './progressiveworker';
import { buildSync } from 'esbuild';

const root = tempDir('claude-repeated-');
afterEach(() => vi.restoreAllMocks());

test('prefix duplicate lookup resumes through oversized lines without retaining historical identities', () => {
  const record = (uuid: string, timestamp: string, text = '') =>
    JSON.stringify({ uuid, timestamp, type: 'progress', text }) + '\n';
  const old = record('old', '2026-01-01T00:00:00Z');
  const newer = record('new', '2026-01-02T00:00:00Z');
  const body = Buffer.from(old + record('large', '2026-01-01T00:00:01Z', 'x'.repeat(2 * 1024 * 1024)) + newer);
  let bytes = 0;
  const offsets: number[] = [];
  const repeated = new ClaudeRepeatedPrefix((offset, length) => {
    bytes += length;
    offsets.push(offset);
    return body.subarray(offset, offset + length);
  });
  const first = repeated.repeated(newer.trim(), body.length - Buffer.byteLength(newer));
  assert.deepEqual(first.next(), { done: true, value: false });
  const unique = record('older-unique', '2026-01-01T00:00:00Z').trim();
  const lookup = repeated.repeated(unique, body.length);
  let passes = 0;
  for (;;) {
    const before = bytes;
    const next = lookup.next();
    assert.ok(bytes - before <= 64 * 1024);
    if (next.done) {
      assert.equal(next.value, false);
      break;
    }
    passes++;
  }
  assert.ok(passes > 32, 'lookup passes continue within a large irrelevant record');
  assert.ok(offsets.every((offset, index) => index === 0 || offset > offsets[index - 1]));
  const duplicate = repeated.repeated(old.trim(), body.length);
  assert.equal(duplicate.next().done, false);
  assert.deepEqual(duplicate.next(), { done: true, value: true });
  for (let index = 3; index < 3000; index++) {
    const line = record(`unique-${index}`, new Date(Date.UTC(2026, 0, index)).toISOString()).trim();
    assert.deepEqual(repeated.repeated(line, body.length).next(), { done: true, value: false });
  }
  assert.ok(retainedParserPayload(repeated) < 4096, 'actual classifier fields remain bounded after unique identities');
});

let written = 0;
function write(records: object[]): string {
  const file = path.join(root, `t${written++}.jsonl`);
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  return file;
}

const start = Date.parse('2026-01-01T00:00:00.000Z');
const at = (second: number) => new Date(start + second * 1000).toISOString();

// A billed answer. `pad` adds two-byte characters, so read chunks split characters too.
function billed(id: string, second: number, pad = 0): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid: `u-${id}`,
    timestamp: at(second),
    requestId: `r-${id}`,
    sessionId: 's',
    message: {
      id: `m-${id}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'é'.repeat(pad) }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
}

function fillers(prefix: string, count: number, from: number, pad = 1000): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, item) => billed(`${prefix}${item}`, from + item, pad));
}

const requests = (record: SpendFileIndex) =>
  (record.lifetimeBuckets ?? []).reduce((sum, bucket) => sum + bucket.requests, 0);

function slice(file: string, previous: SpendFileIndex | undefined, maxBytes: number, now?: () => number) {
  return indexSpendFile(previous, file, root, createClaudeUsageLineReducer, 1, {
    maxBytes,
    maxMilliseconds: Infinity,
    ...(now ? { now } : {}),
  });
}

function indexAll(file: string, maxBytes: number, previous?: SpendFileIndex) {
  const results: IndexSpendFileResult[] = [];
  let record = previous;
  do {
    results.push(slice(file, record, maxBytes));
    record = results[results.length - 1].record;
  } while (!results[results.length - 1].complete && results.length < 10_000);
  return { record, results };
}

type PositionedRead = (fd: number, buffer: Buffer, offset: number, length: number, position: number) => number;

// Routes every positioned `fs.readSync` call through `through`, which can call the real read.
function spyReads(through: (position: number, read: () => number, length: number) => number): void {
  const readSync = fs.readSync.bind(fs) as unknown as PositionedRead;
  const spied: PositionedRead = (fd, buffer, offset, length, position) =>
    through(position, () => readSync(fd, buffer, offset, length, position), length);
  vi.spyOn(fs, 'readSync').mockImplementation(spied as unknown as typeof fs.readSync);
}

// Line starts of a file, with the line texts.
function linesOf(file: string): Array<{ start: number; text: string }> {
  const bytes = fs.readFileSync(file);
  const lines: Array<{ start: number; text: string }> = [];
  for (let from = 0; from < bytes.length;) {
    const newline = bytes.indexOf(10, from);
    lines.push({ start: from, text: bytes.subarray(from, newline).toString('utf8') });
    from = newline + 1;
  }
  return lines;
}

function bufferReader(bytes: Buffer) {
  return (buffer: Buffer, position: number, length: number) =>
    bytes.copy(buffer, 0, position, Math.min(bytes.length, position + length));
}

describe('Claude repeated records', () => {
  test('identity comes from top-level fields only', () => {
    const time = at(1);
    const nested = { type: 'assistant', timestamp: time, message: { content: [{ input: { uuid: 'nested' } }] } };
    assert.equal(claudeRecordIdentity(JSON.stringify(nested)), null);
    assert.deepEqual(claudeRecordIdentity(JSON.stringify({ ...nested, uuid: 'outer' })), {
      uuid: 'outer',
      timestamp: Date.parse(time),
    });
    const quoted = { text: 'say "uuid":"x" and {"timestamp":"y"}', uuid: 'u', timestamp: time };
    assert.equal(claudeRecordIdentity(JSON.stringify(quoted))?.uuid, 'u');
    assert.equal(claudeRecordIdentity(JSON.stringify({ uuid: 'u' })), null, 'a record without a timestamp');
    assert.equal(claudeRecordIdentity(JSON.stringify({ uuid: 7, timestamp: time })), null);
    assert.equal(claudeRecordIdentity(JSON.stringify({ uuid: 'u', timestamp: time }).slice(0, -1)), null);
    assert.equal(claudeRecordIdentity(`[${JSON.stringify({ uuid: 'u', timestamp: time })}]`), null);
  });

  test('a line read in pieces gives the identity the whole line gives', () => {
    const time = at(1);
    const lines = [
      JSON.stringify({
        type: 'assistant',
        uuid: 'outer',
        timestamp: time,
        message: { content: [{ input: { uuid: 'n' } }] },
      }),
      JSON.stringify({ text: 'say "uuid":"x" and {"timestamp":"y"} \\ end', uuid: 'u\\"é', timestamp: time }),
      JSON.stringify({ uuid: 'u' }),
      JSON.stringify({ uuid: 7, timestamp: time }),
      JSON.stringify({ uuid: 'u', timestamp: time }).slice(0, -1),
      `[${JSON.stringify({ uuid: 'u', timestamp: time })}]`,
      `${JSON.stringify({ uuid: 'u', timestamp: time })} x`,
      `  ${JSON.stringify({ uuid: 'u', timestamp: time })}  `,
      `{"\\u0075uid":"escaped","timestamp":"${time}","uuid":"later"}`,
      `{"\\u0075uid":"escaped","timestamp":"${time}"}`,
      `{"uuid":"u","timestamp":"${time}","uuid":null}`,
      `{"uuid":"u","timestamp":["${time}"]}`,
      `{"uuid":"\\ud83d\\ude00","timestamp":"\\u0032${time.slice(1)}"}`,
      JSON.stringify({ uuid: 'u'.repeat(1024), timestamp: time }),
      JSON.stringify({ uuid: 'u'.repeat(1025), timestamp: time }),
      JSON.stringify({ uuid: 'é'.repeat(512), timestamp: time }),
      JSON.stringify({ uuid: 'é'.repeat(513), timestamp: time }),
      JSON.stringify({ pad: 'é'.repeat(3000), uuid: 'big', timestamp: time }),
      '',
      'not json',
    ];
    for (const line of lines) {
      const expected = claudeRecordIdentity(line);
      for (const piece of [1, 2, 3, 7, 64, 1 << 20]) {
        assert.deepEqual(
          streamedClaudeRecordIdentity(Buffer.from(line), piece),
          expected,
          `${piece}: ${line.slice(0, 60)}`,
        );
      }
    }
    assert.equal(claudeRecordIdentity(lines[8])?.uuid, 'later');
    assert.equal(claudeRecordIdentity(lines[13])?.uuid.length, 1024);
    assert.equal(claudeRecordIdentity(lines[14]), null, 'a uuid longer than the field limit');
    assert.equal(claudeRecordIdentity(lines[16]), null, 'a uuid whose bytes pass the field limit');
  });

  test('two billed records that share a nested uuid both count', () => {
    const nested = (id: string) => {
      const record = billed(id, 5);
      delete record.uuid;
      (record.message as { content: unknown[] }).content.push({
        type: 'tool_use',
        id: `t-${id}`,
        name: 'Edit',
        input: { uuid: 'shared' },
      });
      return record;
    };
    const records = [billed('first', 1), nested('a'), nested('b'), billed('last', 9)];
    const file = write(records);
    const filter = createClaudeRepeatedFilter();
    assert.deepEqual(
      records.map((record) => filter(JSON.stringify(record))),
      [false, false, false, false],
    );
    for (const maxBytes of [Infinity, 300]) {
      assert.equal(requests(indexAll(file, maxBytes).record), 4, `slices of ${maxBytes} bytes`);
    }
  });

  // Claude Code gives each rewrite of a growing response its own uuid, so the local corpus holds no
  // repeated uuid with a new timestamp. The rule still counts such a record as genuine.
  test('a record classifies the same through every reader', () => {
    const original = billed('original', 10);
    const late = billed('late', 15);
    const rewrite = { ...billed('rewrite', 500), uuid: 'u-reuse' };
    const records = [
      original,
      billed('reuse', 11),
      ...fillers('a', 700, 20),
      original,
      ...fillers('b', 500, 800),
      late,
      rewrite,
      ...fillers('c', 400, 1400),
      late,
      original,
      billed('end', 2000),
    ];
    const repeats = new Set([702, 1605, 1606]);
    const file = write(records);
    const lines = linesOf(file);
    const filter = createClaudeRepeatedFilter();
    const whole = lines.map((line) => filter(line.text));
    assert.deepEqual(
      whole.flatMap((copy, line) => (copy ? [line] : [])),
      [...repeats],
    );
    for (const maxBytes of [Infinity, 200_000, 64 * 1024 + 7]) {
      const { record } = indexAll(file, maxBytes);
      assert.ok(record.claudeRepeated!.checkpoints.length / 3 > 2, 'the fixture spans checkpoints');
      assert.deepEqual(
        lines.map((line) => insideClaudeRepeated(record.claudeRepeated, line.start)),
        whole,
        `slices of ${maxBytes} bytes`,
      );
      assert.equal(requests(record), records.length - repeats.size, `slices of ${maxBytes} bytes`);
    }
  });

  test('a repeated record near the end of a file reads one checkpoint interval within the slice budget', () => {
    const original = billed('original', 1);
    const records = [original, ...fillers('a', 1700, 10), original, ...fillers('b', 400, 2000)];
    const file = write(records);
    const size = fs.statSync(file).size;
    const copyStart = linesOf(file)[1701].start;
    // Slices end just before the copy, so the slice that looks it up reads it in its first chunk.
    const before = Math.ceil((copyStart - 100) / (900 * 1024));
    const maxBytes = Math.floor((copyStart - 100) / before);
    let read = 0;
    spyReads((_, real) => {
      const count = real();
      read += count;
      return count;
    });
    const { record, results } = indexAll(file, maxBytes);
    vi.restoreAllMocks();
    assert.equal(requests(record), records.length - 1);
    // Forward reads cover each byte once. The lookup reads the first interval, under 1 MiB plus a line.
    assert.ok(read <= size + CLAUDE_REPEATED_CHECKPOINT_BYTES + 64 * 1024, `read ${read} bytes of a ${size}-byte file`);
    const sliceStart = before * maxBytes;
    // Each slice charges the revision check of its restored detector to its budget.
    const scanOffset = results[before - 1].record.scanOffset!;
    assert.ok(
      scanOffset <= sliceStart && scanOffset >= sliceStart - before * CLAUDE_REPEATED_CHECK_BYTES,
      `${scanOffset}`,
    );
    assert.equal(results[before].complete, false, 'the slice that looked up the copy did not charge the lookup');
    assert.ok(results[before].record.scanOffset! - sliceStart <= 64 * 1024);
  });

  test('the slices of a long repeating run read each interval of its originals once', () => {
    const originals = fillers('o', 700, 10);
    const records = [...originals, ...fillers('a', 700, 1000), ...originals, billed('end', 3000)];
    const file = write(records);
    const size = fs.statSync(file).size;
    const originalBytes = linesOf(file)[700].start;
    let read = 0;
    spyReads((_, real) => {
      const count = real();
      read += count;
      return count;
    });
    const { record, results } = indexAll(file, 128 * 1024);
    vi.restoreAllMocks();
    assert.equal(requests(record), records.length - originals.length);
    assert.ok(results.length > 20, 'the run spans many slices');
    // Lookups read the originals' intervals once, plus at most one interval past them.
    assert.ok(
      read <= size + originalBytes + CLAUDE_REPEATED_CHECKPOINT_BYTES + 64 * 1024,
      `read ${read} bytes of a ${size}-byte file`,
    );
  });

  test('a file removed during a slice keeps classifying through the open file', () => {
    const original = billed('original', 1);
    const records = [original, ...fillers('a', 800, 10), original, billed('end', 2000)];
    const file = write(records);
    const copyStart = linesOf(file)[801].start;
    const first = slice(file, undefined, copyStart - 4096);
    assert.equal(first.complete, false);
    let calls = 0;
    const second = slice(file, first.record, Infinity, () => {
      if (++calls === 1) fs.unlinkSync(file);
      return 0;
    });
    assert.equal(second.complete, true);
    assert.equal(requests(second.record), records.length - 1);
    const third = slice(file, { ...second.record, complete: false }, Infinity);
    assert.equal(third.found, false);
  });

  test('a short lookup read invalidates the slice and the next slice rebuilds', () => {
    const original = billed('original', 1);
    const records = [original, ...fillers('a', 800, 10), original, billed('end', 2000)];
    const file = write(records);
    const copyStart = linesOf(file)[801].start;
    const first = slice(file, undefined, copyStart - 4096);
    const restoredAt = first.record.offset;
    spyReads((position, real) => (position < restoredAt ? 0 : real()));
    const lost = slice(file, first.record, Infinity);
    vi.restoreAllMocks();
    assert.equal(lost.invalidated, true);
    assert.equal(lost.complete, false);
    assert.equal(lost.record.claudeRepeated, undefined);
    assert.equal(lost.record.offset, restoredAt);
    const rebuilt = slice(file, lost.record, Infinity);
    assert.equal(rebuilt.rebuilt, true);
    assert.equal(requests(rebuilt.record), records.length - 1);
  });

  test('a lookup cut short by a truncated file leaves no identities for the rebuild', () => {
    // The third record is genuine and older than the record before it.
    const records = [billed('first', 1), billed('second', 100), billed('older', 50), ...fillers('a', 800, 200)];
    records.push(billed('first', 1));
    const file = write(records);
    const lines = linesOf(file);
    const first = slice(file, undefined, lines[lines.length - 1].start - 4096);
    const restoredAt = first.record.offset;
    // The lookup reads its first chunk, then the file ends.
    let lookups = 0;
    spyReads((position, real) => (position >= restoredAt || lookups++ === 0 ? real() : 0));
    const lost = slice(file, first.record, Infinity);
    vi.restoreAllMocks();
    assert.equal(lost.invalidated, true);
    const { record } = indexAll(file, Infinity, lost.record);
    assert.equal(insideClaudeRepeated(record.claudeRepeated, lines[2].start), false, 'the older record is genuine');
    assert.equal(requests(record), records.length - 1);
  });

  test('a lookup across many intervals stays within each slice budget and resumes', () => {
    // Each interval holds one genuine record older than every interval before it ends. A late
    // record of that age can have its original in any of them.
    const oldest = (interval: number) => billed(`old${interval}`, 1 + interval / 100, 8000);
    const records: Record<string, unknown>[] = [];
    for (let interval = 0; interval < 31; interval++) {
      records.push(oldest(interval), ...fillers(`f${interval}-`, 64, 1000 + interval * 100, 8000));
    }
    const order = Array.from({ length: 30 }, (_, interval) => (interval * 7) % 30);
    records.push(billed('late', 1.5), ...order.map((interval) => oldest(interval)), billed('end', 9000));
    const file = write(records);
    const lines = linesOf(file);
    const longest = Math.max(...lines.map((line) => Buffer.byteLength(line.text) + 1));
    const filter = createClaudeRepeatedFilter();
    const whole = lines.map((line) => filter(line.text));
    const tail = lines[lines.length - 32].start;
    const maxBytes = 1024 * 1024;
    let read = 0;
    spyReads((_, real) => {
      const count = real();
      read += count;
      return count;
    });
    // One slice reads every line before the tail.
    let record = slice(file, undefined, tail).record;
    assert.equal(record.offset, tail);
    const perSlice: number[] = [];
    let result: IndexSpendFileResult;
    do {
      read = 0;
      result = slice(file, record, maxBytes);
      perSlice.push(read);
      record = result.record;
    } while (!result.complete && perSlice.length < 1000);
    vi.restoreAllMocks();
    assert.ok(perSlice.length > 30, `the tail took ${perSlice.length} slices`);
    // A slice reads its budget, then at most one probe of 256 KiB, two lookup chunks, and two lines.
    const bound = maxBytes + 256 * 1024 + 2 * 64 * 1024 + 2 * longest;
    assert.ok(Math.max(...perSlice) <= bound, `a slice read ${Math.max(...perSlice)} bytes, bound ${bound}`);
    assert.deepEqual(
      lines.map((line) => insideClaudeRepeated(record.claudeRepeated, line.start)),
      whole,
    );
    assert.equal(requests(record), records.length - 30);
  });

  test('lookups after the deadline stop the slice and resume in the next', () => {
    // Each original opens a checkpoint interval, so the first chunk a lookup reads holds it.
    const count = 8;
    const records: Record<string, unknown>[] = [];
    const originals: Record<string, unknown>[] = [];
    let bytes = 0;
    let next = 0;
    let second = 1;
    // Adds a record and returns its line length.
    const push = (record: Record<string, unknown>) => {
      records.push(record);
      return Buffer.byteLength(JSON.stringify(record)) + 1;
    };
    for (let interval = 0; interval < count; interval++) {
      while (bytes < next) bytes += push(billed(`f${second}`, second++, 1000));
      next = bytes + CLAUDE_REPEATED_CHECKPOINT_BYTES;
      originals.push(billed(`o${interval}`, second++));
      bytes += push(originals[interval]);
    }
    // The tail fits in one forward chunk.
    push(billed('newest', second++));
    for (const original of originals) push(original);
    push(billed('end', second++));
    const file = write(records);
    const lines = linesOf(file);
    const tail = lines[lines.length - count - 2].start;
    const restored = slice(file, undefined, tail).record;
    assert.equal(restored.offset, tail);
    const unbounded = slice(file, restored, Infinity).record;
    forgetClaudeRepeatedLookups(file);
    // The clock passes the deadline when the first lookup of a slice starts its first read.
    let time = 0;
    let afterDeadline = 0;
    // Revision checks read a few bytes at a time, and only lookup chunks count.
    spyReads((position, real, length) => {
      if (position < tail && length > CLAUDE_REPEATED_CHECK_BYTES) {
        time = 15;
        afterDeadline++;
      }
      return real();
    });
    const perSlice: number[] = [];
    let record = restored;
    let result: IndexSpendFileResult;
    do {
      time = 0;
      afterDeadline = 0;
      result = indexSpendFile(record, file, root, createClaudeUsageLineReducer, 1, {
        maxBytes: 1024 * 1024,
        maxMilliseconds: 15,
        now: () => time,
      });
      perSlice.push(afterDeadline);
      record = result.record;
    } while (!result.complete && perSlice.length < 100);
    vi.restoreAllMocks();
    // The lookup that passed the deadline reads one chunk, and the next lookup reads nothing.
    assert.equal(perSlice[0], 1, `the first slice read ${perSlice[0]} lookup chunks after its deadline`);
    // A later slice opens on a lookup, which reads one probe chunk and one interval chunk.
    assert.ok(Math.max(...perSlice) <= 2, `lookup chunks read after each deadline: ${perSlice.join(', ')}`);
    assert.equal(perSlice.length, count);
    assert.deepEqual(record.claudeRepeated?.runs, unbounded.claudeRepeated?.runs);
    assert.equal(requests(record), requests(unbounded));
    assert.equal(requests(record), records.length - count);
  });

  test('a repeating run read with its lookups forgotten each slice reads its originals once', () => {
    const originals = fillers('o', 3000, 10);
    const records = [...originals, ...fillers('a', 300, 5000), ...originals, billed('end', 9000)];
    const file = write(records);
    const size = fs.statSync(file).size;
    const originalBytes = linesOf(file)[3000].start;
    let read = 0;
    spyReads((_, real) => {
      const count = real();
      read += count;
      return count;
    });
    const results: IndexSpendFileResult[] = [];
    let record: SpendFileIndex | undefined;
    do {
      forgetClaudeRepeatedLookups(file);
      results.push(slice(file, record, 128 * 1024));
      record = results[results.length - 1].record;
    } while (!results[results.length - 1].complete && results.length < 10_000);
    vi.restoreAllMocks();
    assert.equal(requests(record), records.length - originals.length);
    assert.ok(results.length > 50, 'the run spans many slices');
    // Forward reads, one pass over the originals, the first lookup's interval, and one reread
    // chunk for each slice that a lookup stopped.
    const bound = size + originalBytes + CLAUDE_REPEATED_CHECKPOINT_BYTES + results.length * 2 * 64 * 1024;
    assert.ok(read <= bound, `read ${read} bytes of a ${size}-byte file, bound ${bound}`);
    assert.ok(read <= 2.5 * size, `read ${read} bytes of a ${size}-byte file`);
  });

  test('a restored detector confirms a line that crosses its read chunk', () => {
    const records = [billed('first', 1), ...fillers('a', 900, 10)];
    const file = write(records);
    const lines = linesOf(file);
    const crossing = lines.filter((line) => line.start < 1024 * 1024).pop()!;
    const bytes = fs.readFileSync(file);
    const detector = new ClaudeRepeatedDetector();
    for (const [index, line] of lines.entries()) {
      detector.repeatedAt(line.text, line.start, index + 1 < lines.length ? lines[index + 1].start : bytes.length);
    }
    const saved = detector.snapshot();
    assert.ok(validClaudeRepeatedState(saved));
    assert.equal(saved.checkpoints[0], 0);
    assert.ok(saved.checkpoints[3] > 1024 * 1024, 'the crossing line belongs to the first interval');
    const restored = new ClaudeRepeatedDetector(saved, bufferReader(bytes));
    const end = bytes.length + Buffer.byteLength(crossing.text) + 1;
    assert.equal(restored.repeatedAt(crossing.text, bytes.length, end), true);
    assert.ok(restored.takeConfirmingBytes() <= saved.checkpoints[3]);
    const fresh = billed('fresh', 3000);
    assert.equal(restored.repeatedAt(JSON.stringify(fresh), end, end + 10), false);
    const short = new ClaudeRepeatedDetector(saved, () => 0);
    assert.equal(short.repeatedAt(crossing.text, bytes.length, end), null);
    assert.equal(short.repeatedAt(JSON.stringify(fresh), end, end + 10), null);
  });

  test('saved detector state is checked before a slice resumes from it', () => {
    const good = {
      through: 100,
      newest: 50,
      checkpoints: [0, 0, 40, 60, 50, 60],
      runs: [70, 90],
      origin: 80,
      searched: 0,
    };
    assert.ok(validClaudeRepeatedState(good));
    const bad: Array<[string, unknown]> = [
      ['pairs instead of triples', { ...good, checkpoints: [0, 0, 60, 50] }],
      ['a first checkpoint after byte 0', { ...good, checkpoints: [10, 0, 40] }],
      ['falling checkpoint offsets', { ...good, checkpoints: [0, 0, 40, 0, 50, 60] }],
      ['a falling newest timestamp', { ...good, checkpoints: [0, 20, 40, 60, 10, 60] }],
      ['a checkpoint past the offset', { ...good, checkpoints: [0, 0, 40, 200, 50, 60] }],
      ['a checkpoint newer than the newest timestamp', { ...good, checkpoints: [0, 0, 40, 60, 70, 60] }],
      ['an empty repeated run', { ...good, runs: [70, 70] }],
      ['overlapping repeated runs', { ...good, runs: [10, 30, 20, 40] }],
      ['a repeated run past the offset', { ...good, runs: [70, 110] }],
      ['a fractional offset', { ...good, through: 1.5 }],
      ['a negative newest timestamp', { ...good, newest: -1 }],
      ['a missing repeated-record map', { ...good, runs: undefined }],
      ['an origin past the offset', { ...good, origin: 101 }],
      ['a search position past the offset', { ...good, searched: 101 }],
      ['a missing origin', { ...good, origin: undefined }],
    ];
    for (const [name, state] of bad) assert.equal(validClaudeRepeatedState(state), false, name);
  });
});

// A transcript with two compactions in one process. The second appends a repeated run that starts
// at the first compaction boundary and repeats its summary and the prompts after it. `withRun`
// false gives the same transcript without the repeated run. `freshPrompt` false ends the file at
// the second compaction. `repeating` picks the records the run repeats, as a range of the records
// before the second compaction. `again` gives the run new identities, so every reader counts it as
// genuine records. `ending` 'prompt' ends the file with one turn and no compaction, and 'none' ends
// it with the run.
function repeatedTranscript(
  withRun: boolean,
  freshPrompt = true,
  repeating: [number, number] = [10, 22],
  { again = false, ending = 'compaction' }: { again?: boolean; ending?: 'compaction' | 'prompt' | 'none' } = {},
): { file: string; runBytes: number; freshBytes: number } {
  const meta = { sessionId: 's', cwd: '/w', version: '2.0.0' };
  const prompt = (id: string, second: number, text: string, parent: string | null) => ({
    type: 'user',
    uuid: `p-${id}`,
    parentUuid: parent,
    timestamp: at(second),
    ...meta,
    message: { role: 'user', content: text },
  });
  const answer = (id: string, second: number, parent: string) => ({
    type: 'assistant',
    uuid: `a-${id}`,
    parentUuid: parent,
    timestamp: at(second),
    requestId: `r-${id}`,
    ...meta,
    message: {
      id: `m-${id}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: `answer ${id} ${'é'.repeat(2000)}` }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  });
  const boundary = (id: string, second: number) => ({
    type: 'system',
    subtype: 'compact_boundary',
    uuid: `b-${id}`,
    parentUuid: null,
    timestamp: at(second),
    ...meta,
    content: 'Conversation compacted',
    compactMetadata: { trigger: 'auto', preTokens: 5000 },
  });
  const summary = (id: string, second: number) => ({
    type: 'user',
    uuid: `s-${id}`,
    parentUuid: `b-${id}`,
    timestamp: at(second),
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
    ...meta,
    message: { role: 'user', content: 'This session is being continued from a previous conversation.' },
  });
  const early: Record<string, unknown>[] = [];
  let parent: string | null = null;
  for (let turn = 0; turn < 10; turn++) {
    if (turn === 5) {
      early.push(boundary('1', 100), summary('1', 101));
      parent = 's-1';
    }
    const second = turn < 5 ? turn * 10 : 100 + turn * 10;
    early.push(prompt(`${turn}`, second, turn === 7 ? 'find the needle' : `prompt ${turn}`, parent));
    early.push(answer(`${turn}`, second + 1, `p-${turn}`));
    parent = `a-${turn}`;
  }
  const run = early.slice(...repeating).map((record) => ({
    ...record,
    version: '2.1.0',
    cwd: '/other',
    ...(again ? { uuid: `${record.uuid}-again` } : {}),
  }));
  const fresh: Record<string, unknown>[] = ending === 'compaction' ? [boundary('2', 1000), summary('2', 1001)] : [];
  if (freshPrompt && ending !== 'none') {
    fresh.push(
      prompt('last', 1002, 'newest prompt', ending === 'prompt' ? 'a-9' : 's-2'),
      answer('last', 1003, 'p-last'),
    );
  }
  const bytes = (records: Record<string, unknown>[]) =>
    records.reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record)) + 1, 0);
  return { file: write([...early, ...(withRun ? run : []), ...fresh]), runBytes: bytes(run), freshBytes: bytes(fresh) };
}

const shape = (read: ReturnType<typeof readSession>) => ({
  prompts: read.turns.map((turn) => turn.prompt),
  compactions: read.compactions.length,
});

describe('windowed readers skip Claude repeated records', () => {
  afterEach(() => forgetClaudeRepeatedMaps());

  test('a tail window that starts inside a run larger than the window reads only genuine records', () => {
    const clean = repeatedTranscript(false);
    const repeating = repeatedTranscript(true);
    assert.ok(repeating.runBytes > 2 * repeating.freshBytes, 'the run is larger than the window');
    const window = repeating.freshBytes + Math.floor(repeating.runBytes / 2);
    assert.deepEqual(
      shape(readSession(repeating.file, 's', { tailBytes: window })),
      shape(readSession(clean.file, 's', { tailBytes: clean.freshBytes + 1 })),
    );
  });

  test('the session reducer counts no repeated compaction summary or prompt', () => {
    const whole = { tailBytes: 1 << 30, maxTurns: 100 };
    assert.deepEqual(
      shape(readSession(repeatedTranscript(true).file, 's', whole)),
      shape(readSession(repeatedTranscript(false).file, 's', whole)),
    );
  });

  test('a session reducer fed lines without offsets skips a line it already read', () => {
    const reduced = (file: string) => {
      const reducer = createClaudeSessionReducer('s', { maxTurns: 100 });
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) reducer.pushLine(line);
      return shape(reducer.finish());
    };
    assert.deepEqual(reduced(repeatedTranscript(true).file), reduced(repeatedTranscript(false).file));
  });

  test('a history page that walks backward into a run reads the genuine prompts before it', () => {
    const page = (file: string, targetTurns: number) => {
      const result = readClaudeHistoryPage(file, 's', null, { chunkBytes: 4096, targetTurns }).page;
      return { prompts: result?.turns.map((turn) => turn.prompt), compactions: result?.compactions.length };
    };
    assert.deepEqual(page(repeatedTranscript(true).file, 8), page(repeatedTranscript(false).file, 8));
    // A run that repeats the first prompts, whose originals lie outside the page.
    assert.deepEqual(page(repeatedTranscript(true, true, [0, 10]).file, 3), page(repeatedTranscript(false).file, 3));
  });

  test('newest-turn discovery passes over a repeated prompt to its original', async () => {
    const located = async (fixture: { file: string; freshBytes: number }) => {
      const tail = tailOf(fixture.file, fixture.freshBytes + 1, true);
      const found = await discoverClaudeNewestTurn(fixture.file, tail.cursor!, { chunkBytes: 4096 }, tail.lines);
      assert.equal(found.kind, 'found');
      const bytes = fs.readFileSync(fixture.file);
      let start = bytes.length - (found as { readBytes: number }).readBytes;
      if (bytes[start] === 10) start++;
      const line = bytes.subarray(start, bytes.indexOf(10, start)).toString('utf8');
      const genuine = bytes.lastIndexOf(10, bytes.indexOf('"uuid":"p-9"')) + 1;
      return { uuid: (JSON.parse(line) as { uuid: string }).uuid, genuine: start === genuine };
    };
    const repeating = await located(repeatedTranscript(true, false));
    assert.deepEqual(repeating, await located(repeatedTranscript(false, false)));
    assert.equal(repeating.uuid, 'p-9');
  });

  test('a history page takes no child figure from a repeated completion notice', () => {
    const notice = (tokens: number) => ({
      type: 'attachment',
      uuid: 'n-1',
      timestamp: at(3),
      sessionId: 's',
      attachment: {
        type: 'queued_command',
        timestamp: at(3),
        commandMode: 'task-notification',
        prompt:
          '<task-notification><task-id>child-bg1</task-id><tool-use-id>bg1</tool-use-id><status>completed</status></task-notification>' +
          `<subagent_tokens>${tokens}</subagent_tokens>`,
      },
    });
    const prompt = (id: string, second: number) => ({
      type: 'user',
      uuid: `p-${id}`,
      timestamp: at(second),
      sessionId: 's',
      message: { role: 'user', content: `prompt ${id}` },
    });
    const reply = (id: string, second: number, content: unknown[], stop: string) => ({
      type: 'assistant',
      uuid: `a-${id}`,
      timestamp: at(second),
      sessionId: 's',
      message: {
        role: 'assistant',
        id: `m-${id}`,
        model: 'claude-opus-5',
        stop_reason: stop,
        content,
        usage: { input_tokens: 20, output_tokens: 10 },
      },
    });
    const launch = {
      type: 'tool_use',
      id: 'bg1',
      name: 'Agent',
      input: { description: 'Trace', subagent_type: 'Explore' },
    };
    const file = write([
      prompt('1', 0),
      reply('1', 1, [launch], 'tool_use'),
      reply('2', 2, [{ type: 'text', text: 'started' }], 'end_turn'),
      notice(10),
      prompt('2', 4),
      reply('3', 5, [{ type: 'text', text: 'done' }], 'end_turn'),
      notice(999),
    ]);
    const turns = readClaudeHistoryPage(file, 's', null, { targetTurns: 10 }).page?.turns ?? [];
    assert.deepEqual(
      turns.flatMap((turn) => turn.agents.map((agent) => agent.tokens)),
      [10],
    );
  });

  test('attachment recovery passes over a repeated model attachment to the genuine one', async () => {
    const attachment = (id: string, second: number, modelId: string) => ({
      type: 'attachment',
      uuid: `m-${id}`,
      timestamp: at(second),
      sessionId: 's',
      attachment: { type: 'model', identity: { modelId } },
    });
    const prompt = (id: string, second: number) => ({
      type: 'user',
      uuid: `p-${id}`,
      timestamp: at(second),
      sessionId: 's',
      message: { role: 'user', content: `prompt ${id}` },
    });
    const reply = (id: string, second: number) => ({
      type: 'assistant',
      uuid: `a-${id}`,
      timestamp: at(second),
      sessionId: 's',
      message: {
        role: 'assistant',
        id: `r-${id}`,
        model: 'claude-opus-5-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Done' }],
        usage: { input_tokens: 100, output_tokens: 10 },
      },
    });
    const filler = Array.from({ length: 3 }, () => ({ type: 'ignored', text: 'x'.repeat(4096) }));
    // The older turn ends the history page, so the page scans the records before it for the attachment.
    const file = write([
      attachment('sonnet', 0, 'claude-sonnet-5-5[1m]'),
      attachment('opus', 1, 'claude-opus-5-5[1m]'),
      attachment('sonnet', 0, 'claude-sonnet-5-5[1m]'),
      ...filler,
      prompt('0', 2),
      reply('0', 3),
      prompt('1', 10),
      reply('1', 11),
    ]);
    const options = { tailBytes: 2048, maxTurns: 40 };
    let forward = await readClaudeSessionIncrementalAsync(file, 's', undefined, options, {
      attachmentBudget: { maxBytes: 1 << 20, maxMilliseconds: Infinity },
    });
    assert.ok((forward.checkpoint?.coveredFrom ?? 0) > 0, 'the forward read holds the attachments');
    for (let pass = 0; forward.recoveryPending && pass < 20; pass++) {
      forward = await readClaudeSessionIncrementalAsync(file, 's', forward.checkpoint ?? undefined, options, {
        attachmentBudget: { maxBytes: 1 << 20, maxMilliseconds: Infinity },
      });
    }
    assert.equal(forward.read?.turns.at(-1)?.modelAttachment, 'claude-opus-5-5[1m]', 'attachment recovery');
    const page = readClaudeHistoryPage(file, 's', null, { chunkBytes: 4096, targetTurns: 1 }).page;
    assert.equal(page?.turns.length, 1, 'the history page holds more than one turn');
    assert.equal(page?.turns.at(-1)?.modelAttachment, 'claude-opus-5-5[1m]', 'the history older-evidence scan');
  });

  test('search over a repeated prompt finds it once, where the transcript holds it', () => {
    const needles = (file: string, tailBytes: number) =>
      readSession(file, 's', { tailBytes, maxTurns: Number.MAX_SAFE_INTEGER, turnsOnly: true }).turns.filter((turn) =>
        turn.prompt.includes('needle'),
      ).length;
    const repeating = repeatedTranscript(true);
    const clean = repeatedTranscript(false);
    assert.equal(
      needles(repeating.file, repeating.freshBytes + repeating.runBytes - 100),
      needles(clean.file, clean.freshBytes + 1),
    );
    assert.equal(needles(repeating.file, 1 << 30), needles(clean.file, 1 << 30));
  });
});

describe('bounded readers before the repeated-record map covers their window', () => {
  afterEach(() => forgetClaudeRepeatedMaps());
  const bounded = (file: string, tailBytes: number) =>
    shape(
      readSession(file, 's', {
        tailBytes,
        maxTurns: 100,
        boundedRepeated: true,
      }),
    );
  const waited = (file: string, tailBytes: number) => shape(readSession(file, 's', { tailBytes, maxTurns: 100 }));
  const coverage = (file: string) =>
    new Promise<void>((resolve) => {
      const stop = onClaudeRepeatedCoverage((covered) => {
        if (covered !== file) return;
        stop();
        resolve();
      });
    });

  test('a ledger map published at load lets a bounded read skip repeats whose originals lie before its window', () => {
    const repeating = repeatedTranscript(true);
    const clean = repeatedTranscript(false);
    const record = indexAll(repeating.file, 1 << 30);
    forgetClaudeRepeatedMaps();
    publishClaudeRepeatedLedger([{ ...record.record, file: repeating.file }]);
    const window = repeating.freshBytes + Math.floor(repeating.runBytes / 2);
    assert.deepEqual(bounded(repeating.file, window), waited(clean.file, clean.freshBytes + 1));
  });

  test('with no map a bounded read never counts a repeat, and draws the clean value once the map completes', async () => {
    const repeating = repeatedTranscript(true);
    const clean = repeatedTranscript(false);
    const window = repeating.freshBytes + Math.floor(repeating.runBytes / 2);
    const expected = waited(clean.file, clean.freshBytes + 1);
    const done = coverage(repeating.file);
    const first = bounded(repeating.file, window);
    assert.ok(
      first.prompts.every((prompt) => expected.prompts.includes(prompt)),
      'a repeated prompt counted',
    );
    assert.ok(first.compactions <= expected.compactions, 'a repeated compaction counted');
    await done;
    assert.deepEqual(bounded(repeating.file, window), expected);
  });

  test('a bounded read charges map reads and lookups to its own window', () => {
    const repeating = repeatedTranscript(true);
    const window = repeating.freshBytes + repeating.runBytes;
    // The held map stops where the run starts, so each line of the window needs a lookup of its original.
    claudeRepeatedMap(repeating.file, fs.statSync(repeating.file).size - window);
    const meter = openReadWindow();
    bounded(repeating.file, window);
    const read = closeReadWindow(meter).bytes;
    assert.ok(read <= 2 * window + 4096, `read ${read} bytes for a ${window}-byte window`);
  });

  test('an equal-size rewrite in place and a truncation followed by regrowth drop the held map', () => {
    const repeating = repeatedTranscript(true);
    const cleanBytes = fs.readFileSync(repeatedTranscript(false).file);
    const filler = (length: number) => {
      const base = JSON.stringify({ type: 'filler', pad: '' });
      return Buffer.from(
        JSON.stringify({
          type: 'filler',
          pad: 'x'.repeat(length - base.length - 1),
        }) + '\n',
      );
    };
    const expected = shape(
      readSession(repeatedTranscript(false).file, 's', {
        tailBytes: 1 << 30,
        maxTurns: 100,
      }),
    );
    const size = fs.statSync(repeating.file).size;
    shape(readSession(repeating.file, 's', { tailBytes: 1 << 30, maxTurns: 100 }));
    const fd = fs.openSync(repeating.file, 'r+');
    fs.writeSync(fd, Buffer.concat([cleanBytes, filler(size - cleanBytes.length)]), 0, size, 0);
    fs.closeSync(fd);
    fs.utimesSync(repeating.file, new Date(), new Date(Date.now() + 5000));
    assert.equal(fs.statSync(repeating.file).size, size);
    assert.deepEqual(shape(readSession(repeating.file, 's', { tailBytes: 1 << 30, maxTurns: 100 })), expected);
    const regrown = repeatedTranscript(true);
    shape(readSession(regrown.file, 's', { tailBytes: 1 << 30, maxTurns: 100 }));
    fs.truncateSync(regrown.file, 0);
    fs.writeFileSync(regrown.file, Buffer.concat([cleanBytes, filler(size)]));
    assert.deepEqual(shape(readSession(regrown.file, 's', { tailBytes: 1 << 30, maxTurns: 100 })), expected);
  });

  // Each bounded reader below reads a window that holds part of a repeated run and none of its
  // originals, with no map published. Before background completion covers the file, the reader never
  // shows the value that counting the repeats gives. After it, the reader shows the clean value.
  // `mapped` covers a file whose reads give the reference values.
  const mapped = (file: string) => (claudeRepeatedMap(file, Number.MAX_SAFE_INTEGER), file);
  const metadataTurns = (file: string, bytes: number) =>
    readSessionMeta(file, bytes, 's').stats?.turns.map((turn) => turn.startedAt) ?? [];
  const turnStarts = (file: string, bytes: number) => readSessionTurnStarts(file, bytes).starts;
  for (const [name, reader] of [
    ['metadata', metadataTurns],
    ['turn starts', turnStarts],
  ] as const) {
    test(`${name} never counts a repeated prompt and shows the clean value once the map completes`, async () => {
      const repeating = repeatedTranscript(true, true, [10, 22], { ending: 'prompt' });
      const window = repeating.freshBytes + Math.floor(repeating.runBytes / 2);
      const expected = reader(
        mapped(repeatedTranscript(false, true, [10, 22], { ending: 'prompt' }).file),
        repeating.freshBytes + 1,
      );
      const counted = reader(
        mapped(repeatedTranscript(true, true, [10, 22], { again: true, ending: 'prompt' }).file),
        window,
      );
      assert.notDeepEqual(counted, expected, 'the run changes no counted value');
      forgetClaudeRepeatedMaps();
      const done = coverage(repeating.file);
      assert.notDeepEqual(reader(repeating.file, window), counted);
      await done;
      assert.deepEqual(reader(repeating.file, window), expected);
    });
  }

  test('activity and work never take a repeated record time and show the clean value once the map completes', async () => {
    const repeating = repeatedTranscript(true, true, [0, 10], { ending: 'none' });
    const clean = repeatedTranscript(false, true, [0, 10], { ending: 'none' });
    // The window holds only repeated records, so it holds no genuine activity.
    const window = repeating.runBytes - 100;
    const counted = readSessionActivity(
      mapped(repeatedTranscript(true, true, [0, 10], { ending: 'none', again: true }).file),
      window,
    );
    assert.notEqual(counted, null, 'the run holds no activity');
    const work = readSessionWork(mapped(clean.file), window);
    assert.notEqual(work, null);
    forgetClaudeRepeatedMaps();
    const done = coverage(repeating.file);
    assert.equal(readSessionActivity(repeating.file, window), null);
    const before = readSessionWork(repeating.file, window);
    assert.ok(before === null || before === work, `work ${before}`);
    await done;
    assert.equal(readSessionActivity(repeating.file, window), null);
    assert.equal(readSessionWork(repeating.file, window), work);
  });

  test(
    'the progressive worker starts from the host map, or completes its own and shows the newest genuine records',
    { tags: ['subprocess'], timeout: 60_000 },
    async () => {
      const source = buildSync({
        entryPoints: [path.join(__dirname, 'progressiveworker-entry.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node18',
        write: false,
      }).outputFiles[0].text;
      const clean = repeatedTranscript(false, true, [10, 22], { ending: 'prompt' });
      const covered = new Map<string, () => void>();
      const worker = new ProgressiveWorker(source, undefined, (file) => covered.get(file)?.());
      const read = async (file: string, tailBytes: number) => {
        const stat = fs.statSync(file);
        const session = { agent: 'claude' as const, sessionId: 's', file, size: stat.size, mtimeMs: stat.mtimeMs };
        const result = await worker.run({ kind: 'metadata', session, tailBytes }, 1, new AbortController().signal);
        assert.ok(result?.value.kind === 'metadata');
        return result.value.entry.stats?.turns.map((turn) => turn.startedAt) ?? [];
      };
      try {
        const repeating = repeatedTranscript(true, true, [10, 22], { ending: 'prompt' });
        const window = repeating.freshBytes + Math.floor(repeating.runBytes / 2);
        const expected = await read(mapped(clean.file), repeating.freshBytes + 1);
        const counted = await read(
          mapped(repeatedTranscript(true, true, [10, 22], { again: true, ending: 'prompt' }).file),
          window,
        );
        forgetClaudeRepeatedMaps();
        assert.notDeepEqual(counted, expected, 'the run changes no counted value');
        const reached = new Promise<void>((resolve) => covered.set(repeating.file, resolve));
        assert.notDeepEqual(await read(repeating.file, window), counted);
        await reached;
        assert.deepEqual(await read(repeating.file, window), expected);
        // A map the extension host holds reaches the worker with the request.
        const published = repeatedTranscript(true, true, [10, 22], { ending: 'prompt' });
        forgetClaudeRepeatedMaps();
        claudeRepeatedMap(published.file, Number.MAX_SAFE_INTEGER);
        assert.deepEqual(await read(published.file, window), expected);
      } finally {
        worker.stop();
      }
    },
  );

  test('a bounded read never reads past its allowance to confirm a record, and leaves it uncounted', () => {
    // The original's interval starts with a 4 MiB record of the same time, so a confirming lookup reads it first.
    const big = { type: 'assistant', uuid: 'big', timestamp: at(0), pad: 'x'.repeat(4 * 1024 * 1024) };
    const small = { uuid: 'b', timestamp: at(0) };
    const line = JSON.stringify(small);
    const allowance = 70;
    assert.ok(Buffer.byteLength(line) < allowance);
    // A complete line that the map extends over, and an unfinished last line past a covering map.
    for (const ending of ['\n', '']) {
      const file = write([big, small]);
      claudeRepeatedMap(file, Number.MAX_SAFE_INTEGER);
      const offset = fs.statSync(file).size;
      fs.appendFileSync(file, line + ending);
      const meter = openReadWindow();
      const [kept] = blankClaudeRepeated(file, [line], offset, fs.statSync(file).size, allowance);
      const read = closeReadWindow(meter).bytes;
      assert.equal(kept.trim(), '', `the unconfirmed record counted (ending ${JSON.stringify(ending)})`);
      // Each held-map revision check reads its samples, which count against the allowance.
      assert.ok(
        read <= allowance + Buffer.byteLength(line) + 3 * CLAUDE_REPEATED_CHECK_BYTES,
        `read ${read} bytes with a ${allowance}-byte allowance`,
      );
    }
  });

  test('background completion crosses a record larger than its step and reaches the genuine records after it', () => {
    const prompt = (id: string, second: number, text: string) => ({
      type: 'user',
      uuid: `p-${id}`,
      timestamp: at(second),
      sessionId: 's',
      cwd: '/w',
      version: '2.0.0',
      message: { role: 'user', content: text },
    });
    const huge = {
      type: 'assistant',
      uuid: 'a-huge',
      timestamp: at(1),
      sessionId: 's',
      message: { id: 'm-huge', role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(5 * 1024 * 1024) }] },
    };
    const answer = (id: string, second: number) => ({
      type: 'assistant',
      uuid: `a-${id}`,
      timestamp: at(second),
      sessionId: 's',
      requestId: `r-${id}`,
      message: {
        id: `m-${id}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: `answer ${id}` }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    const tail = [
      prompt('1', 10, 'second prompt'),
      answer('1', 11),
      prompt('0', 0, 'first prompt'),
      prompt('2', 20, 'third prompt'),
      answer('2', 21),
    ];
    const file = write([prompt('0', 0, 'first prompt'), huge, ...tail]);
    const window = tail.reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record)) + 1, 1);
    const prompts = () =>
      readSession(file, 's', { tailBytes: window, maxTurns: 100, boundedRepeated: true }).turns.map(
        (turn) => turn.prompt,
      );
    // Each step reads at most 4 MiB, as a background completion step does.
    let steps = 0;
    for (let covered = false; !covered; steps++) {
      assert.ok(steps < 10, 'background completion stopped advancing');
      const map = claudeRepeatedMap(file, Number.MAX_SAFE_INTEGER, 4 * 1024 * 1024, Infinity, false);
      assert.ok(map, 'the map was dropped');
      assert.ok(map.readBytes <= 4 * 1024 * 1024 + 64 * 1024, `a step read ${map.readBytes} bytes`);
      covered = map.covered;
    }
    assert.equal(steps, 2);
    assert.deepEqual(prompts(), ['second prompt', 'third prompt']);
  });

  test('background completion looks up past an original longer than its step in steps of its budget and one chunk', () => {
    const prompt = (id: string, second: number, text = `prompt ${id}`) => ({
      type: 'user',
      uuid: `p-${id}`,
      timestamp: at(second),
      sessionId: 's',
      message: { role: 'user', content: text },
    });
    const first = prompt('a', 0);
    const long = prompt('x', 1, 'x'.repeat(3 * 1024 * 1024));
    const after = prompt('b', 2);
    const file = write([first, long, after]);
    claudeRepeatedMap(file, Number.MAX_SAFE_INTEGER);
    // The genuine record older than the newest has no original, so its lookup reads the whole long line.
    const tail = [first, prompt('d', 0.5), after, prompt('c', 3)];
    fs.appendFileSync(file, tail.map((record) => JSON.stringify(record)).join('\n') + '\n');
    const allowance = 16 * 1024;
    const chunk = 64 * 1024;
    // The clock passes the deadline after its first reading in each step.
    let readings = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (readings++ === 0 ? 0 : 10));
    const perStep: number[] = [];
    let map: ReturnType<typeof claudeRepeatedMap>;
    do {
      readings = 0;
      map = claudeRepeatedMap(file, Number.MAX_SAFE_INTEGER, allowance, 10, false);
      assert.ok(map, 'the map was dropped');
      perStep.push(map.readBytes);
    } while (!map.covered && perStep.length < 1000);
    vi.restoreAllMocks();
    // A step reads its budget, one lookup chunk, and its revision checks: the held map at the start and
    // the end, the paused line, the bytes read forward, and the samples of the new map.
    const bound = allowance + chunk + 5 * CLAUDE_REPEATED_CHECK_BYTES;
    assert.ok(Math.max(...perStep) <= bound, `a step read ${Math.max(...perStep)} bytes, bound ${bound}`);
    // Each step reads at least one chunk of the long line. Each of the three lookups can stop a step once more.
    const longBytes = Buffer.byteLength(JSON.stringify(long)) + 1;
    assert.ok(perStep.length <= Math.ceil(longBytes / chunk) + 4, `completion took ${perStep.length} steps`);
    forgetClaudeRepeatedMaps();
    const unbounded = claudeRepeatedMap(file, Number.MAX_SAFE_INTEGER);
    assert.ok(unbounded?.covered);
    assert.equal(unbounded.runs.length, 4);
    assert.deepEqual([map.through, map.newest, map.runs], [unbounded.through, unbounded.newest, unbounded.runs]);
  });

  test('an unfinished last prompt older than the newest record stays when no earlier record repeats it', () => {
    const clean = repeatedTranscript(false);
    const late = {
      type: 'user',
      uuid: 'p-late',
      parentUuid: 'a-last',
      timestamp: at(500),
      sessionId: 's',
      cwd: '/w',
      version: '2.0.0',
      message: { role: 'user', content: 'older unfinished prompt' },
    };
    fs.appendFileSync(clean.file, JSON.stringify(late));
    const prompts = readSession(clean.file, 's', {
      tailBytes: 1 << 30,
      maxTurns: 100,
    }).turns.map((turn) => turn.prompt);
    assert.ok(prompts.includes('older unfinished prompt'), prompts.join(' | '));
  });
});

// Each state a step carries to a later step must follow the file's revision. After each kind of file
// change, completing the map from that state gives the map one unbounded pass over the final bytes gives.
describe('repeated-record state follows the file revision', () => {
  afterEach(() => forgetClaudeRepeatedMaps());
  const MAX = Number.MAX_SAFE_INTEGER;
  // The timestamp comes last, so a step that stops inside a long line has read only its uuid.
  const prompt = (uuid: string, second: number, text = `prompt ${uuid}`) => ({
    uuid,
    type: 'user',
    sessionId: 's',
    message: { role: 'user', content: text },
    timestamp: at(second),
  });
  const LONG = 3 * 1024 * 1024;
  const long = (uuid: string, second: number, extra = 0) => prompt(uuid, second, 'x'.repeat(LONG + extra));
  const lineOf = (record: object) => JSON.stringify(record) + '\n';
  const joined = (records: object[]) => Buffer.from(records.map(lineOf).join(''));
  const fresh = () => path.join(root, `revision-${written++}.jsonl`);
  const shapeOf = (map: ReturnType<typeof claudeRepeatedMap>) =>
    map && { through: map.through, newest: map.newest, runs: map.runs };
  const reference = (bytes: Buffer, end = MAX) => {
    const other = fresh();
    fs.writeFileSync(other, bytes);
    return shapeOf(claudeRepeatedMap(other, end));
  };
  // Background steps of 4 MiB until the map covers the file.
  const complete = (file: string) => {
    let map: ReturnType<typeof claudeRepeatedMap> = null;
    for (let steps = 0; steps < 40 && !map?.covered; steps++)
      map = claudeRepeatedMap(file, MAX, 4 << 20, Infinity, false);
    assert.ok(map?.covered, 'background completion did not finish');
    return shapeOf(map);
  };
  // A genuine record, the long original, the newest record, a repeat of the original, and a genuine
  // record older than the newest, whose lookup reads the long line.
  const base = [prompt('p-a', 0), long('p-x', 2), prompt('p-b', 3), prompt('p-x', 2, 'repeat'), prompt('p-x', 1)];
  const v1 = joined(base);
  const aEnd = lineOf(base[0]).length;
  // The long original rewritten as another record, longer by `extra` bytes, with the records after it.
  const rewritten = (extra: number) =>
    Buffer.from(v1.toString('utf8').replace(lineOf(base[1]), lineOf(long('p-y', 1, extra))));
  const grown = Buffer.concat([rewritten(7), joined([prompt('p-y', 1, 'repeat'), prompt('p-c', 6)])]);
  const changes: Array<[string, Buffer, (file: string) => void]> = [
    ['an append', Buffer.concat([v1, joined([prompt('p-x', 2, 'again'), prompt('p-c', 6)])]), () => {}],
    ['a truncation', v1.subarray(0, aEnd + 100), () => {}],
    ['a same-size rewrite', rewritten(0), (file) => fs.utimesSync(file, new Date(), new Date(Date.now() + 5000))],
    ['a rewrite with growth', grown, () => {}],
    ['a replacement under the same name', grown, () => {}],
    ['a deletion and recreation', grown, () => {}],
  ];
  const change = (name: string, file: string, bytes: Buffer, after: (file: string) => void) => {
    if (name === 'a replacement under the same name') {
      const other = `${file}.new`;
      fs.writeFileSync(other, bytes);
      fs.renameSync(other, file);
    } else if (name === 'a deletion and recreation') {
      fs.rmSync(file);
      assert.equal(claudeRepeatedMap(file, MAX), null);
      fs.writeFileSync(file, bytes);
    } else if (name === 'a truncation') {
      fs.truncateSync(file, bytes.length);
    } else {
      const fd = fs.openSync(file, 'r+');
      fs.writeSync(fd, bytes, 0, bytes.length, 0);
      fs.closeSync(fd);
    }
    after(file);
  };
  // Each kind builds its state on the first bytes, and returns what it does after the change.
  // A map kind also reads up to the end of the first bytes, which a valid held map answers without reading.
  const kinds: Array<[string, (file: string) => (file: string) => void, boolean?]> = [
    [
      'a paused partial identity',
      (file) => {
        fs.truncateSync(file, v1.length - lineOf(base[4]).length);
        claudeRepeatedMap(file, MAX);
        fs.appendFileSync(file, lineOf(base[4]));
        const paused = claudeRepeatedMap(file, MAX, 1536 * 1024, Infinity, false);
        assert.ok(paused && !paused.covered, 'the lookup did not pause');
        return () => {};
      },
    ],
    ['a held map', (file) => (claudeRepeatedMap(file, MAX), () => {}), true],
    [
      'a ledger-restored map',
      (file) => {
        const record = indexAll(file, 1 << 30).record;
        forgetClaudeRepeatedMaps();
        publishClaudeRepeatedLedger([{ ...record, file }]);
        return () => {};
      },
      true,
    ],
    [
      'an adopted map',
      (file) => {
        claudeRepeatedMap(file, MAX);
        const held = heldClaudeRepeatedMap(file)!;
        forgetClaudeRepeatedMaps();
        return (changed) => {
          // The worker's own map covers the first record when the host's map arrives.
          claudeRepeatedMap(changed, aEnd);
          adoptClaudeRepeatedMap(changed, held);
        };
      },
      true,
    ],
    [
      'a coverage cursor',
      (file) => {
        const step = claudeRepeatedMap(file, MAX, 2 << 20, Infinity, false);
        assert.ok(step && !step.covered && step.through === aEnd, 'the step did not stop inside the long line');
        return () => {};
      },
    ],
  ];
  for (const [kindName, build, early] of kinds) {
    for (const [changeName, bytes, after] of changes) {
      test(`${kindName} after ${changeName} gives the map of the final bytes`, { tags: ['subprocess'] }, () => {
        const expected = reference(bytes);
        const file = fresh();
        fs.writeFileSync(file, v1);
        const resume = build(file);
        change(changeName, file, bytes, after);
        resume(file);
        if (early) assert.deepEqual(shapeOf(claudeRepeatedMap(file, v1.length)), reference(bytes, v1.length));
        assert.deepEqual(complete(file), expected);
      });
    }
  }

  test('a paused lookup restarts a long line rewritten in place before an append, and keeps a genuine record', () => {
    const file = fresh();
    fs.writeFileSync(file, joined([prompt('p-a', 0), long('p-x', 2), prompt('p-b', 3)]));
    claudeRepeatedMap(file, MAX);
    // A genuine record older than the newest. Its lookup stops inside the long line after its uuid.
    fs.appendFileSync(file, lineOf(prompt('p-x', 1)));
    const paused = claudeRepeatedMap(file, MAX, 16 * 1024, Infinity, false);
    assert.ok(paused && !paused.covered, 'the lookup did not pause');
    const before = lineOf(long('p-x', 2));
    const after = lineOf(long('p-y', 1));
    assert.equal(before.length, after.length);
    const bytes = Buffer.concat([
      Buffer.from(fs.readFileSync(file, 'utf8').replace(before, after)),
      joined([prompt('p-z', 5)]),
    ]);
    fs.writeFileSync(file, bytes);
    const expected = reference(bytes);
    assert.deepEqual(expected?.runs, []);
    assert.deepEqual(complete(file), expected);
  });

  test('a map held at the current revision outranks a further map from before a rewrite in place', () => {
    const file = fresh();
    fs.writeFileSync(file, v1);
    claudeRepeatedMap(file, MAX);
    const held = heldClaudeRepeatedMap(file)!;
    forgetClaudeRepeatedMaps();
    // The rewrite keeps every byte after the long line, so the further map passes its samples.
    const bytes = Buffer.concat([rewritten(0), joined([prompt('p-c', 6)])]);
    fs.writeFileSync(file, bytes);
    claudeRepeatedMap(file, aEnd);
    adoptClaudeRepeatedMap(file, held);
    assert.deepEqual(complete(file), reference(bytes));
  });
  test('a held map drops when the file shrinks above its end, also when its samples hold', () => {
    const file = fresh();
    const tail = Buffer.from('{"uuid":"p-unfinished","timestamp":"');
    fs.writeFileSync(file, Buffer.concat([v1, tail, tail]));
    claudeRepeatedMap(file, MAX);
    // The rewrite keeps the length of the long line, so every sample of the map holds.
    const bytes = Buffer.concat([rewritten(0), tail]);
    fs.writeFileSync(file, bytes);
    assert.deepEqual(shapeOf(claudeRepeatedMap(file, MAX)), reference(bytes));
  });

  test('a ledger map goes when its file is seen gone, so a recreated file with the same sampled bytes rebuilds', () => {
    const file = fresh();
    fs.writeFileSync(file, v1);
    const record = indexAll(file, 1 << 30).record;
    forgetClaudeRepeatedMaps();
    publishClaudeRepeatedLedger([{ ...record, file }]);
    fs.rmSync(file);
    assert.equal(claudeRepeatedMap(file, MAX), null);
    const bytes = Buffer.concat([rewritten(0), joined([prompt('p-c', 6)])]);
    fs.writeFileSync(file, bytes);
    assert.deepEqual(complete(file), reference(bytes));
  });

  test('the cost index rebuilds a file whose bytes before its saved detector changed as it grew', () => {
    const file = fresh();
    fs.writeFileSync(file, v1);
    const saved = indexAll(file, 1 << 30).record;
    assert.ok(saved.claudeRepeated?.samples?.length, 'the saved detector holds no samples');
    fs.writeFileSync(file, grown);
    const resumed = indexAll(file, 1 << 30, saved).record;
    const other = fresh();
    fs.writeFileSync(other, grown);
    const rebuilt = indexAll(other, 1 << 30).record;
    assert.deepEqual(
      [resumed.offset, resumed.claudeRepeated?.runs, resumed.claudeRepeated?.newest],
      [rebuilt.offset, rebuilt.claudeRepeated?.runs, rebuilt.claudeRepeated?.newest],
    );
  });
});
