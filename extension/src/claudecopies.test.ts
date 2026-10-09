import { afterEach, describe, test, vi } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  CLAUDE_COPY_CHECKPOINT_BYTES,
  ClaudeCopyDetector,
  claudeRecordIdentity,
  createClaudeCopyFilter,
  forgetClaudeCopyLookups,
  insideClaudeCopy,
  validClaudeCopyState,
} from './claudecopies';
import { indexSpendFile, type IndexSpendFileResult, type SpendFileIndex } from './projectspend';
import { tempDir } from './temproot';
import { createClaudeUsageLineReducer } from './transcript';

const root = tempDir('claude-copies-');
afterEach(() => vi.restoreAllMocks());

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
function spyReads(through: (position: number, read: () => number) => number): void {
  const readSync = fs.readSync.bind(fs) as unknown as PositionedRead;
  const spied: PositionedRead = (fd, buffer, offset, length, position) =>
    through(position, () => readSync(fd, buffer, offset, length, position));
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
    const filter = createClaudeCopyFilter();
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
    const copies = new Set([702, 1605, 1606]);
    const file = write(records);
    const lines = linesOf(file);
    const filter = createClaudeCopyFilter();
    const whole = lines.map((line) => filter(line.text));
    assert.deepEqual(
      whole.flatMap((copy, line) => (copy ? [line] : [])),
      [...copies],
    );
    for (const maxBytes of [Infinity, 200_000, 64 * 1024 + 7]) {
      const { record } = indexAll(file, maxBytes);
      assert.ok(record.claudeCopies!.checkpoints.length / 3 > 2, 'the fixture spans checkpoints');
      assert.deepEqual(
        lines.map((line) => insideClaudeCopy(record.claudeCopies, line.start)),
        whole,
        `slices of ${maxBytes} bytes`,
      );
      assert.equal(requests(record), records.length - copies.size, `slices of ${maxBytes} bytes`);
    }
  });

  test('a copy near the end of a file reads one checkpoint interval within the slice budget', () => {
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
    assert.ok(read <= size + CLAUDE_COPY_CHECKPOINT_BYTES + 64 * 1024, `read ${read} bytes of a ${size}-byte file`);
    const sliceStart = before * maxBytes;
    assert.equal(results[before - 1].record.scanOffset, sliceStart);
    assert.equal(results[before].complete, false, 'the slice that looked up the copy did not charge the lookup');
    assert.ok(results[before].record.scanOffset! - sliceStart <= 64 * 1024);
  });

  test('the slices of a long copied run read each interval of its originals once', () => {
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
      read <= size + originalBytes + CLAUDE_COPY_CHECKPOINT_BYTES + 64 * 1024,
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
    assert.equal(lost.record.claudeCopies, undefined);
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
    assert.equal(insideClaudeCopy(record.claudeCopies, lines[2].start), false, 'the older record is genuine');
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
    const filter = createClaudeCopyFilter();
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
      lines.map((line) => insideClaudeCopy(record.claudeCopies, line.start)),
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
      next = bytes + CLAUDE_COPY_CHECKPOINT_BYTES;
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
    forgetClaudeCopyLookups(file);
    // The clock passes the deadline when the first lookup of a slice starts its first read.
    let time = 0;
    let afterDeadline = 0;
    spyReads((position, real) => {
      if (position < tail) {
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
    assert.deepEqual(record.claudeCopies?.copies, unbounded.claudeCopies?.copies);
    assert.equal(requests(record), requests(unbounded));
    assert.equal(requests(record), records.length - count);
  });

  test('a copied run read with its lookups forgotten each slice reads its originals once', () => {
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
      forgetClaudeCopyLookups(file);
      results.push(slice(file, record, 128 * 1024));
      record = results[results.length - 1].record;
    } while (!results[results.length - 1].complete && results.length < 10_000);
    vi.restoreAllMocks();
    assert.equal(requests(record), records.length - originals.length);
    assert.ok(results.length > 50, 'the run spans many slices');
    // Forward reads, one pass over the originals, the first lookup's interval, and one reread
    // chunk for each slice that a lookup stopped.
    const bound = size + originalBytes + CLAUDE_COPY_CHECKPOINT_BYTES + results.length * 2 * 64 * 1024;
    assert.ok(read <= bound, `read ${read} bytes of a ${size}-byte file, bound ${bound}`);
    assert.ok(read <= 2.5 * size, `read ${read} bytes of a ${size}-byte file`);
  });

  test('a restored detector confirms a line that crosses its read chunk', () => {
    const records = [billed('first', 1), ...fillers('a', 900, 10)];
    const file = write(records);
    const lines = linesOf(file);
    const crossing = lines.filter((line) => line.start < 1024 * 1024).pop()!;
    const bytes = fs.readFileSync(file);
    const detector = new ClaudeCopyDetector();
    for (const [index, line] of lines.entries()) {
      detector.copyAt(line.text, line.start, index + 1 < lines.length ? lines[index + 1].start : bytes.length);
    }
    const saved = detector.snapshot();
    assert.ok(validClaudeCopyState(saved));
    assert.equal(saved.checkpoints[0], 0);
    assert.ok(saved.checkpoints[3] > 1024 * 1024, 'the crossing line belongs to the first interval');
    const restored = new ClaudeCopyDetector(saved, bufferReader(bytes));
    const end = bytes.length + Buffer.byteLength(crossing.text) + 1;
    assert.equal(restored.copyAt(crossing.text, bytes.length, end), true);
    assert.ok(restored.takeConfirmingBytes() <= saved.checkpoints[3]);
    const fresh = billed('fresh', 3000);
    assert.equal(restored.copyAt(JSON.stringify(fresh), end, end + 10), false);
    const short = new ClaudeCopyDetector(saved, () => 0);
    assert.equal(short.copyAt(crossing.text, bytes.length, end), null);
    assert.equal(short.copyAt(JSON.stringify(fresh), end, end + 10), null);
  });

  test('saved detector state is checked before a slice resumes from it', () => {
    const good = {
      through: 100,
      newest: 50,
      checkpoints: [0, 0, 40, 60, 50, 60],
      copies: [70, 90],
      origin: 80,
      searched: 0,
    };
    assert.ok(validClaudeCopyState(good));
    const bad: Array<[string, unknown]> = [
      ['pairs instead of triples', { ...good, checkpoints: [0, 0, 60, 50] }],
      ['a first checkpoint after byte 0', { ...good, checkpoints: [10, 0, 40] }],
      ['falling checkpoint offsets', { ...good, checkpoints: [0, 0, 40, 0, 50, 60] }],
      ['a falling newest timestamp', { ...good, checkpoints: [0, 20, 40, 60, 10, 60] }],
      ['a checkpoint past the offset', { ...good, checkpoints: [0, 0, 40, 200, 50, 60] }],
      ['a checkpoint newer than the newest timestamp', { ...good, checkpoints: [0, 0, 40, 60, 70, 60] }],
      ['an empty copied run', { ...good, copies: [70, 70] }],
      ['overlapping copied runs', { ...good, copies: [10, 30, 20, 40] }],
      ['a copied run past the offset', { ...good, copies: [70, 110] }],
      ['a fractional offset', { ...good, through: 1.5 }],
      ['a negative newest timestamp', { ...good, newest: -1 }],
      ['a missing copy map', { ...good, copies: undefined }],
      ['an origin past the offset', { ...good, origin: 101 }],
      ['a search position past the offset', { ...good, searched: 101 }],
      ['a missing origin', { ...good, origin: undefined }],
    ];
    for (const [name, state] of bad) assert.equal(validClaudeCopyState(state), false, name);
  });
});
