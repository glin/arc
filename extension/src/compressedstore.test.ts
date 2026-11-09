import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import defaultFs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { test, vi } from 'vitest';
import { takeCodexOpeningsLock } from './codexopenings.ts';
import {
  adoptCompressedTwin,
  compareRankedEntries,
  compressedPairKey,
  compressedEntryBatches,
  compressedEntryCurrent,
  compressedEntryVersions,
  CompressedStoreFollower,
  CompressedStoreHolder,
  COMPRESSED_FACTS_VERSION,
  readCompressedStore,
  readCompressedStoreInSteps,
  postCompressedBatches,
  recordCompressedAdoption,
  recordCompressedNames,
  STORE_LOCK,
  withKeptUndercount,
  type CompressedFactEntry,
  type CompressedStoreOptions,
} from './compressedstore.ts';
import { hashCompressedRollout } from './compressedrollouts.ts';
import { normalizeSpendFile, type SpendFileIndex } from './projectspend.ts';
import { tempDir } from './temproot.ts';

const encode = (zlib as { zstdCompressSync?: (input: Buffer) => Buffer }).zstdCompressSync;

// The listing bounds of the design, with a test store small enough to hold one shard.
const STEADY_NAMES = 72;
const CRASH_NAMES = 91;

function entry(file: string, overrides: Partial<CompressedFactEntry> = {}): CompressedFactEntry {
  return {
    file,
    pairKey: file.replace(/\.zst$/, ''),
    ...compressedEntryVersions(),
    size: 100,
    mtimeMs: 1_000,
    threadId: 't',
    complete: true,
    adopted: true,
    ...overrides,
  };
}

// The start of the test clock, well before any file the test run creates, so a fresh lock never reads as stale.
const STORE_CLOCK_START = Date.UTC(2026, 0, 1);

// A store directory, a controlled wall clock and timers that fire only when the test advances them.
function storeFixture(name: string, options: Partial<CompressedStoreOptions> = {}) {
  const directory = path.join(tempDir(name), 'facts');
  fs.mkdirSync(directory, { recursive: true });
  let now = STORE_CLOCK_START;
  const timers: { at: number; run: () => void }[] = [];
  const clock = {
    get now() {
      return now;
    },
    advance(milliseconds: number) {
      now += milliseconds;
      for (const timer of timers.filter((held) => held.at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.run();
      }
    },
    // Moves the clock and fires no timer, so a held lease and its idle release stay as they are.
    jump(milliseconds: number) {
      now += milliseconds;
    },
  };
  const make = (extra: Partial<CompressedStoreOptions> = {}) =>
    new CompressedStoreHolder(directory, {
      now: () => now,
      schedule: (milliseconds, run) => {
        const timer = { at: now + milliseconds, run };
        timers.push(timer);
        return () => {
          const at = timers.indexOf(timer);
          if (at >= 0) timers.splice(at, 1);
        };
      },
      retryDelay: () => 5_000,
      yieldStep: async () => {},
      exists: () => true,
      statOf: () => null,
      ...options,
      ...extra,
    });
  return { directory, clock, make, names: () => fs.readdirSync(directory).sort() };
}

const stale = (lock: string, clock: { now: number }) => {
  const past = new Date(clock.now - 31_000);
  fs.utimesSync(lock, past, past);
};

const threadCount = (directory: string) => readCompressedStore(directory).entries.size;

test('a store holds every appended entry across its own segments and names each file for its holder', async () => {
  const { directory, make } = storeFixture('store-append');
  const holder = make();
  await holder.append([entry('a.jsonl.zst')]);
  await holder.append([entry('b.jsonl.zst')]);
  const segments = fs.readdirSync(directory).filter((name) => name.startsWith('segment-'));
  assert.equal(segments.length, 1, 'one holder writes one open segment');
  assert.match(segments[0], /^segment-1-\d+\.[0-9a-f-]+-0$/);
  assert.equal(threadCount(directory), 2);
  assert.deepEqual([...readCompressedStore(directory).entries.keys()].sort(), ['a.jsonl.zst', 'b.jsonl.zst']);
  holder.dispose();
  assert.equal(fs.existsSync(path.join(directory, STORE_LOCK)), false, 'dispose left the lock');
});

test('a reader skips an incomplete trailing line', async () => {
  const { directory, make } = storeFixture('store-trailing');
  const holder = make();
  await holder.append([entry('a.jsonl.zst')]);
  holder.dispose();
  const segment = fs.readdirSync(directory).find((name) => name.startsWith('segment-'))!;
  fs.appendFileSync(path.join(directory, segment), '{"file":"b.jsonl.zst"');
  assert.deepEqual([...readCompressedStore(directory).entries.keys()], ['a.jsonl.zst']);
});

test('the merge ranks the current fact version, then an equal stat, then the later line', () => {
  const stat = { size: 10, mtimeMs: 5 };
  const ranked = (overrides: object) =>
    ({
      entry: { file: 'x', pairKey: 'x', factsVersion: COMPRESSED_FACTS_VERSION },
      epoch: 1,
      token: 'a',
      input: 'i',
      offset: 0,
      seq: 0,
      ...overrides,
    }) as Parameters<typeof compareRankedEntries>[0];
  const old = ranked({ entry: { file: 'x', pairKey: 'x', factsVersion: 0, size: 10, mtimeMs: 5 } });
  const current = ranked({
    entry: { file: 'x', pairKey: 'x', factsVersion: COMPRESSED_FACTS_VERSION, size: 1, mtimeMs: 1 },
  });
  assert.ok(compareRankedEntries(current, old, stat) > 0, 'an older fact version ranked first');
  const equal = ranked({
    entry: {
      file: 'x',
      pairKey: 'x',
      factsVersion: COMPRESSED_FACTS_VERSION,
      size: 10,
      mtimeMs: 5,
    },
  });
  const newer = ranked({
    entry: { file: 'x', pairKey: 'x', factsVersion: COMPRESSED_FACTS_VERSION, size: 9, mtimeMs: 6 },
  });
  assert.ok(compareRankedEntries(equal, newer, stat) > 0, 'an equal stat lost to a greater mtime');
  assert.ok(compareRankedEntries(ranked({ seq: 2 }), ranked({ seq: 1 }), stat) > 0, 'the later file lost');
  assert.ok(compareRankedEntries(ranked({ offset: 9 }), ranked({ offset: 2 }), stat) > 0, 'the later line lost');
  assert.ok(compareRankedEntries(ranked({ token: 'b' }), ranked({ token: 'a' }), stat) > 0, 'the greater token lost');
  assert.ok(
    compareRankedEntries(ranked({ epoch: 3, seq: 0 }), ranked({ epoch: 2, seq: 9 }), stat) > 0,
    'the higher epoch lost',
  );
  const decoded = ranked({
    entry: { file: 'x', pairKey: 'x', factsVersion: COMPRESSED_FACTS_VERSION, decodedLength: 4 },
  });
  assert.ok(compareRankedEntries(decoded, ranked({ seq: 9 }), stat) > 0, 'a decoded length lost to a later line');
});

test('an entry is current only when its stat and each version match this build', () => {
  const stat = { size: 100, mtimeMs: 1_000 };
  assert.equal(compressedEntryCurrent(entry('a'), stat), true);
  assert.equal(compressedEntryCurrent(entry('a'), { ...stat, mtimeMs: 2 }), false);
  for (const field of ['factsVersion', 'codexMetaVersion', 'metadataGeneration', 'spendGeneration'] as const) {
    assert.equal(compressedEntryCurrent(entry('a', { [field]: 0 }), stat), false, field);
  }
});

test('a lock with another token at a check abandons, and the holder resumes after the jitter with no entry lost', async () => {
  const { directory, clock, make } = storeFixture('store-abandon');
  const holder = make();
  await holder.append([entry('a.jsonl.zst')]);
  const lock = path.join(directory, STORE_LOCK);
  // Another holder took the lock while this one was paused.
  fs.writeFileSync(lock, 'other-token');
  await holder.append([entry('b.jsonl.zst')]);
  assert.equal(holder.held, false, 'the holder kept writing under another token');
  assert.equal(holder.pending, 1, 'the abandonment dropped the queued entry');
  assert.equal(threadCount(directory), 1);
  // The other holder ends. The lock ages past the takeover threshold, and the retry takes it over.
  stale(lock, clock);
  clock.advance(5_000);
  await holder.work();
  await holder.append([]);
  assert.equal(holder.pending, 0);
  assert.equal(threadCount(directory), 2);
  holder.dispose();
});

test('a loser of the lock repeats the jitter wait until the lock is free', async () => {
  const { directory, clock, make } = storeFixture('store-loser');
  const lock = path.join(directory, STORE_LOCK);
  fs.writeFileSync(lock, 'live-holder');
  const holder = make();
  await holder.append([entry('a.jsonl.zst')]);
  assert.equal(holder.held, false);
  clock.advance(5_000);
  await holder.work();
  assert.equal(holder.held, false, 'the lock is still live, so the retry loses again');
  fs.rmSync(lock);
  clock.advance(5_000);
  await holder.work();
  assert.equal(holder.pending, 0);
  assert.equal(threadCount(directory), 1);
  holder.dispose();
});

test('an append reports an entry as durable only when its line is on disk', async () => {
  const { directory, clock, make } = storeFixture('store-durable');
  const lock = path.join(directory, STORE_LOCK);
  fs.writeFileSync(lock, 'live-holder');
  const holder = make();
  const queued = entry('a.jsonl.zst');
  assert.deepEqual(await holder.append([queued]), [false], 'an entry behind a live lock read as durable');
  let durable: boolean | null = null;
  void holder.durable([queued]).then((value) => (durable = value));
  await vi.waitFor(() => assert.equal(holder.pending, 1));
  assert.equal(durable, null, 'the durable report settled before the write');
  assert.equal(threadCount(directory), 0);
  fs.rmSync(lock);
  clock.advance(5_000);
  await holder.work();
  await vi.waitFor(() => assert.equal(durable, true));
  assert.equal(threadCount(directory), 1);
  assert.deepEqual(await holder.append([entry('b.jsonl.zst')]), [true]);
  holder.dispose();
});

test('a disposed holder reports a queued entry as not durable', async () => {
  const { directory, make } = storeFixture('store-disposed');
  fs.writeFileSync(path.join(directory, STORE_LOCK), 'live-holder');
  const holder = make();
  const queued = entry('a.jsonl.zst');
  await holder.append([queued]);
  const report = holder.durable([queued]);
  holder.dispose();
  assert.equal(await report, false);
  assert.equal(await holder.durable([queued]), false);
});

test('an append during the trailing compaction is written and the idle release is armed again', async () => {
  let late: CompressedStoreHolder | null = null;
  let arrived = false;
  const { directory, clock, make } = storeFixture('store-trailing-compaction', {
    segmentBytes: 64,
    compactSegments: 99,
    fault: (at) => {
      if (at === 'compact:start' && late && !arrived) {
        arrived = true;
        void late.append([entry('late.jsonl.zst')]);
      }
    },
  });
  const holder = make();
  late = holder;
  await holder.append([entry('a.jsonl.zst')]);
  clock.jump(300_001);
  await holder.append([entry('b.jsonl.zst')]);
  assert.equal(arrived, true, 'the trailing compaction did not run');
  await vi.waitFor(() => assert.equal(holder.pending, 0, 'an append during the compaction stayed queued'));
  assert.equal(threadCount(directory), 3);
  clock.advance(20_000);
  assert.equal(fs.existsSync(path.join(directory, STORE_LOCK)), false, 'the idle release did not fire');
  holder.dispose();
});

test('a lock missing at renewal is recreated and the holder keeps writing', async () => {
  const { directory, clock, make, names } = storeFixture('store-renew-missing');
  const holder = make();
  await holder.append([entry('a.jsonl.zst')]);
  const lock = path.join(directory, STORE_LOCK);
  fs.rmSync(lock);
  clock.advance(10_000);
  assert.equal(fs.readFileSync(lock, 'utf8').length > 0, true, 'renewal did not recreate the lock');
  assert.equal(holder.held, true, 'the holder abandoned a removed lock');
  await holder.append([entry('b.jsonl.zst')]);
  assert.equal(threadCount(directory), 2);
  assert.ok(names().length <= STEADY_NAMES, `listing ${names().length}`);
  holder.dispose();
});

test('a lock missing at a publish check follows the renewal rule and keeps the entry', async () => {
  const { directory, make } = storeFixture('store-publish-missing');
  const holder = make();
  await holder.append([entry('a.jsonl.zst')]);
  fs.rmSync(path.join(directory, STORE_LOCK));
  await holder.append([entry('b.jsonl.zst')]);
  assert.equal(holder.held, true);
  assert.equal(threadCount(directory), 2);
  holder.dispose();
});

test('a renewal that finds another token abandons within one renewal interval', async () => {
  const { directory, clock, make } = storeFixture('store-renew-other');
  const holder = make();
  await holder.append([entry('a.jsonl.zst')]);
  fs.writeFileSync(path.join(directory, STORE_LOCK), 'other');
  clock.advance(10_000);
  assert.equal(holder.held, false);
  assert.equal(threadCount(directory), 1, 'an abandonment lost a written entry');
  holder.dispose();
});

test('an overwritten epoch makes the holder abandon at the next publish and resume with no entry lost', async () => {
  const { directory, clock, make } = storeFixture('store-epoch');
  const holder = make();
  await holder.append([entry('a.jsonl.zst')]);
  fs.writeFileSync(path.join(directory, 'epoch'), JSON.stringify({ e: 99, token: 'paused' }));
  await holder.append([entry('b.jsonl.zst')]);
  assert.equal(holder.held, false);
  assert.equal(holder.pending, 1);
  // The abandonment released the lock, so the retry takes it at once after the jitter.
  clock.advance(5_000);
  await holder.work();
  assert.equal(holder.pending, 0);
  assert.equal(threadCount(directory), 2);
  const epoch = JSON.parse(fs.readFileSync(path.join(directory, 'epoch'), 'utf8'));
  assert.ok(epoch.e > 99, 'the new epoch does not pass the overwritten one');
  holder.dispose();
});

test('a takeover through a removed lock fences the old holder, and no entry is lost', async () => {
  const { directory, clock, make, names } = storeFixture('store-takeover-removed', {
    segmentBytes: 256,
  });
  const first = make();
  await first.append([entry('a.jsonl.zst')]);
  fs.rmSync(path.join(directory, STORE_LOCK));
  const second = make();
  await second.append([entry('b.jsonl.zst')]);
  assert.equal(second.held, true);
  await first.append([entry('c.jsonl.zst')]);
  assert.equal(first.held, false, 'the old holder wrote after the takeover');
  assert.equal(first.pending, 1);
  second.dispose();
  clock.advance(5_000);
  await first.work();
  assert.equal(first.pending, 0);
  assert.equal(threadCount(directory), 3);
  assert.ok(names().length <= CRASH_NAMES);
  first.dispose();
});

test('a record of 5 MiB gets a segment of its own and drops its title entry', async () => {
  const { directory, make, names } = storeFixture('store-large');
  const holder = make();
  await holder.append([entry('small.jsonl.zst')]);
  const large = entry('large.jsonl.zst', {
    title: { label: 'Big', fullLabel: 'Big', size: 1, mtimeMs: 1 } as CompressedFactEntry['title'],
    spend: { file: 'large.jsonl', notes: 'x'.repeat(5 * 1024 * 1024) } as unknown as SpendFileIndex,
  });
  await holder.append([large]);
  const stored = readCompressedStore(directory).entries.get('large.jsonl.zst')!;
  assert.equal(stored.title, undefined, 'an entry above 1 MiB kept its title entry');
  assert.deepEqual(stored.carriedName, { label: 'Big', fullLabel: 'Big' });
  assert.ok(stored.spend, 'the spend record was lost');
  const segments = fs.readdirSync(directory).filter((name) => name.startsWith('segment-'));
  const sizes = segments.map((name) => fs.statSync(path.join(directory, name)).size).sort((a, b) => a - b);
  assert.equal(segments.length, 2, 'the large record shared a segment');
  assert.ok(sizes[0] < 4096, 'the small segment holds the small entry alone');
  assert.ok(sizes[1] > 5 * 1024 * 1024);
  assert.ok(names().length <= STEADY_NAMES, `listing ${names().length}`);
  holder.dispose();
});

test('compaction at the closed segment count folds segments into shards and keeps the listing bound', async () => {
  const { directory, make, names } = storeFixture('store-compact', {
    segmentBytes: 64,
    compactSegments: 8,
  });
  const holder = make();
  const entries = Array.from({ length: 40 }, (_, at) => entry(`rollout-${at}.jsonl.zst`));
  for (const single of entries) await holder.append([single]);
  assert.equal(threadCount(directory), 40);
  assert.ok(
    names().some((name) => name.startsWith('manifest-')),
    'compaction wrote no manifest',
  );
  assert.ok(
    names().some((name) => name.startsWith('shard-')),
    'compaction wrote no shard',
  );
  assert.ok(names().length <= STEADY_NAMES, `listing ${names().length}`);
  holder.dispose();
});

test('compaction drops an entry whose two forms are both absent and keeps the rest', async () => {
  const { directory, make } = storeFixture('store-compact-absent', {
    segmentBytes: 64,
    compactSegments: 2,
    exists: (file) => file.startsWith('kept'),
  });
  const holder = make();
  await holder.append([entry('gone.jsonl.zst'), entry('kept.jsonl.zst'), entry('kept-other.jsonl.zst')]);
  assert.deepEqual([...readCompressedStore(directory).entries.keys()].sort(), [
    'kept-other.jsonl.zst',
    'kept.jsonl.zst',
  ]);
  holder.dispose();
});

// A crash at a named step of a compaction or recovery compaction. The test's own holder dies by throwing.
class Crash extends Error {}

async function crashAt(point: string, options: Partial<CompressedStoreOptions> = {}) {
  const fixture = storeFixture(`store-crash-${point.replace(/\W/g, '-')}`, {
    segmentBytes: 64,
    compactSegments: 4,
    ...options,
  });
  const holder = fixture.make({
    fault: (at) => {
      if (at === point) throw new Crash(point);
    },
  });
  const entries = Array.from({ length: 12 }, (_, at) => entry(`rollout-${at}.jsonl.zst`));
  let crashed = false;
  try {
    for (const single of entries) await holder.append([single]);
  } catch (error) {
    if (!(error instanceof Crash)) throw error;
    crashed = true;
  }
  // Every line flushed before the crash is durable. The queue of the dead holder is not.
  return { ...fixture, durable: threadCount(fixture.directory), crashed };
}

for (const point of [
  'compact:shard-written',
  'compact:before-manifest',
  'compact:manifest-saved',
  'compact:inputs-deleted',
]) {
  test(`a crash at ${point} loses no entry, and a takeover ends inside the listing bound`, async () => {
    const { directory, clock, make, names, durable, crashed } = await crashAt(point);
    assert.equal(crashed, true, 'the crash point was not reached');
    assert.ok(durable >= 4, `${durable} durable entries`);
    assert.ok(names().length <= CRASH_NAMES, `crashed listing ${names().length}`);
    stale(path.join(directory, STORE_LOCK), clock);
    clock.advance(1);
    const next = make();
    await next.append([entry('after-crash.jsonl.zst')]);
    assert.equal(threadCount(directory), durable + 1, 'the recovery lost an entry');
    assert.ok(names().length <= CRASH_NAMES, `recovered listing ${names().length}`);
    next.dispose();
  });
}

test('a crash during the recovery compaction loses no entry and the next takeover ends inside the listing bound', async () => {
  const { directory, clock, make, names, durable, crashed } = await crashAt('compact:shard-written');
  assert.equal(crashed, true);
  stale(path.join(directory, STORE_LOCK), clock);
  clock.advance(1);
  const recovering = make({
    fault: (at) => {
      if (at === 'compact:shard-written') throw new Crash(at);
    },
  });
  await assert.rejects(() => recovering.append([entry('x.jsonl.zst')]), Crash);
  assert.ok(names().length <= CRASH_NAMES, `crashed listing ${names().length}`);
  stale(path.join(directory, STORE_LOCK), clock);
  clock.advance(1);
  const last = make();
  await last.append([entry('after.jsonl.zst')]);
  assert.equal(threadCount(directory), durable + 1, 'a crash during recovery lost an entry');
  assert.ok(names().length <= CRASH_NAMES, `recovered listing ${names().length}`);
  last.dispose();
});

test('a takeover after a worker thread exited under a running host deletes its temporaries inside the grace period', async () => {
  const { directory, clock, make, names } = storeFixture('store-worker-exit');
  const first = make();
  await first.append([entry('a.jsonl.zst')]);
  // A worker thread exits without closing its lease. Its process, the extension host, keeps running.
  const lock = path.join(directory, STORE_LOCK);
  const other = `${process.pid}.11111111-1111-4111-8111-111111111111`;
  fs.writeFileSync(path.join(directory, `manifest-9-x-0.${other}.${clock.now}.tmp`), 'partial');
  fs.writeFileSync(lock, other);
  stale(lock, clock);
  clock.advance(1);
  const next = make();
  await next.append([entry('b.jsonl.zst')]);
  assert.equal(
    names().filter((name) => name.endsWith('.tmp')).length,
    0,
    'recovery kept a temporary of a running process',
  );
  assert.equal(threadCount(directory), 2);
  assert.ok(names().length <= CRASH_NAMES, `listing ${names().length}`);
  next.dispose();
});

test('recovery deletes unnamed shards and the older manifest and never touches an unknown-version file', async () => {
  const { directory, clock, make, names } = storeFixture('store-recovery', {
    segmentBytes: 64,
    compactSegments: 3,
  });
  const holder = make();
  for (const at of [1, 2, 3]) await holder.append([entry(`r${at}.jsonl.zst`)]);
  const lockFile = path.join(directory, STORE_LOCK);
  const manifest = names().find((name) => name.startsWith('manifest-'));
  assert.ok(manifest);
  // A crash left an unnamed shard, an older manifest whose shards are present, and files of a newer build.
  fs.writeFileSync(path.join(directory, 'shard-1-dead-0'), `${JSON.stringify(entry('unnamed.jsonl.zst'))}\n`);
  const held = readCompressedStore(directory);
  const older = JSON.parse(fs.readFileSync(path.join(directory, manifest), 'utf8'));
  fs.writeFileSync(
    path.join(directory, 'manifest-0-old-0'),
    JSON.stringify({ ...older, epoch: 0, token: 'old', seq: 0, inputs: [] }),
  );
  const newer = { ...entry('newer.jsonl.zst'), factsVersion: COMPRESSED_FACTS_VERSION + 1 };
  fs.writeFileSync(path.join(directory, 'segment-5-newer-0'), `${JSON.stringify(newer)}\n`);
  fs.writeFileSync(path.join(directory, 'shard-5-newer-1'), `${JSON.stringify(newer)}\n`);
  holder.dispose();
  assert.equal(fs.existsSync(lockFile), false);
  clock.advance(1);
  const next = make();
  await next.append([entry('r9.jsonl.zst')]);
  const after = names();
  assert.equal(after.includes('shard-1-dead-0'), false, 'recovery kept an unnamed shard');
  assert.equal(after.includes('manifest-0-old-0'), false, 'recovery kept the older manifest');
  assert.ok(after.includes('segment-5-newer-0'), 'recovery touched a newer segment');
  assert.ok(after.includes('shard-5-newer-1'), 'recovery touched a newer shard');
  const read = readCompressedStore(directory);
  assert.deepEqual([...read.entries.keys()].sort(), [...held.entries.keys(), 'r9.jsonl.zst'].sort());
  assert.equal(read.entries.has('newer.jsonl.zst'), false, 'a reader merged a newer version');
  next.dispose();
});

test('a reader ignores a shard that no valid manifest names and skips an input that one names', async () => {
  const { directory, make, names } = storeFixture('store-validity', {
    segmentBytes: 64,
    compactSegments: 3,
  });
  const holder = make();
  for (const at of [1, 2, 3]) await holder.append([entry(`r${at}.jsonl.zst`)]);
  holder.dispose();
  // A manifest naming an absent shard is invalid, so its inputs still count.
  fs.writeFileSync(
    path.join(directory, 'manifest-77-x-0'),
    JSON.stringify({
      factsVersion: COMPRESSED_FACTS_VERSION,
      epoch: 77,
      token: 'x',
      seq: 0,
      shards: ['shard-77-x-1'],
      inputs: names(),
    }),
  );
  fs.writeFileSync(path.join(directory, 'shard-88-y-0'), `${JSON.stringify(entry('orphan.jsonl.zst'))}\n`);
  const read = readCompressedStore(directory);
  assert.deepEqual([...read.entries.keys()].sort(), ['r1.jsonl.zst', 'r2.jsonl.zst', 'r3.jsonl.zst']);
});

test('a compactor paused past its lease retires no input, so a takeover loses no entry', async () => {
  const { directory, clock, make } = storeFixture('store-paused-compactor', {
    segmentBytes: 64,
    compactSegments: 4,
  });
  const lock = path.join(directory, STORE_LOCK);
  const second = make();
  const takeovers: Promise<unknown>[] = [];
  const paused = make({
    fault: (at) => {
      if (at !== 'compact:before-manifest' || takeovers.length) return;
      // The compactor pauses here. The lease goes stale and the second holder takes over, deletes the unnamed shards and
      // yields while it scans the inputs.
      stale(lock, clock);
      takeovers.push(second.append([entry('second.jsonl.zst')]));
    },
  });
  for (const at of [1, 2, 3, 4]) await paused.append([entry(`rollout-${at}.jsonl.zst`)]);
  assert.equal(takeovers.length, 1, 'the compaction did not reach its manifest');
  await Promise.all(takeovers);
  assert.equal(paused.held, false, 'the paused holder kept its lease');
  assert.equal(threadCount(directory), 5, 'a retired input took entries with it');
  assert.deepEqual([...readCompressedStore(directory).entries.keys()].sort(), [
    'rollout-1.jsonl.zst',
    'rollout-2.jsonl.zst',
    'rollout-3.jsonl.zst',
    'rollout-4.jsonl.zst',
    'second.jsonl.zst',
  ]);
  paused.dispose();
  second.dispose();
});

// What a holder reads for the name of a segment it still has open, after another holder removed the file.
const SEGMENT_REMOVALS = [
  ['linux', 'an unlink removes the name', false],
  ['darwin', 'an unlink removes the name', false],
  ['win32', 'a delete-pending file reads as absent', false],
  ['win32', 'a refused delete keeps the name', true],
] as const;

// A holder pauses before its write of one entry, then retries. The outcome holds what the holder and the store report.
async function pausedWriteOutcome(name: string, present: boolean, pause: (segment: string, directory: string) => void) {
  let paused: string | null = null;
  let armed = false;
  const { directory, clock, make, names } = storeFixture(name, { compactSegments: 99 });
  const holder = make({
    segmentPresent: (file) => present || path.basename(file) !== paused,
    fault: (at) => {
      if (at !== 'segment:checked' || !armed) return;
      armed = false;
      paused = names().find((stored) => stored.startsWith('segment-'))!;
      pause(paused, directory);
    },
  });
  await holder.append([entry('a.jsonl.zst')]);
  armed = true;
  const late = entry('b.jsonl.zst');
  const written = await holder.append([late]);
  const queued = holder.pending;
  const held = holder.held;
  fs.rmSync(path.join(directory, STORE_LOCK), { force: true });
  clock.advance(5_000);
  await holder.work();
  await vi.waitFor(() => assert.equal(holder.pending, 0));
  const durable = await holder.durable([late]);
  const stored = readCompressedStore(directory).entries.has('b.jsonl.zst');
  holder.dispose();
  return { written, queued, held, durable, stored };
}

const REQUEUED = { written: [false], queued: 1, held: false, durable: true, stored: true };

// Another holder takes the lease, folds the open segment into a shard and retires it.
function compactAsNewHolder(segment: string, directory: string) {
  const token = 'new-holder';
  fs.writeFileSync(path.join(directory, STORE_LOCK), token);
  fs.writeFileSync(path.join(directory, 'epoch'), JSON.stringify({ e: 9, token }));
  fs.copyFileSync(path.join(directory, segment), path.join(directory, 'shard-9-new-holder-0'));
  fs.writeFileSync(
    path.join(directory, 'manifest-9-new-holder-1'),
    JSON.stringify({
      factsVersion: COMPRESSED_FACTS_VERSION,
      epoch: 9,
      token,
      seq: 1,
      shards: ['shard-9-new-holder-0'],
      inputs: [segment],
    }),
  );
}

for (const [platform, removal, present] of SEGMENT_REMOVALS) {
  test(`a takeover during a paused write keeps the entry queued (${platform}, ${removal})`, async () => {
    const name = `store-paused-takeover-${platform}-${present}`;
    assert.deepEqual(await pausedWriteOutcome(name, present, compactAsNewHolder), REQUEUED);
  });
}

for (const [platform, removal] of SEGMENT_REMOVALS.filter(([, , present]) => !present)) {
  test(`a segment removed during a paused write keeps the entry queued under a held lease (${platform}, ${removal})`, async () => {
    assert.deepEqual(await pausedWriteOutcome(`store-paused-removed-${platform}`, false, () => {}), REQUEUED);
  });
}

test('a compaction whose named shard is gone retires no input', async () => {
  const { directory, make, names } = storeFixture('store-shard-gone', {
    segmentBytes: 64,
    compactSegments: 3,
  });
  const holder = make({
    fault: (at) => {
      if (at !== 'compact:manifest-saved') return;
      for (const name of names()) if (name.startsWith('shard-')) fs.rmSync(path.join(directory, name));
    },
  });
  for (const at of [1, 2, 3]) await holder.append([entry(`r${at}.jsonl.zst`)]);
  assert.equal(names().filter((name) => name.startsWith('segment-')).length, 3, 'a compaction retired its inputs');
  assert.equal(threadCount(directory), 3);
  holder.dispose();
});

test('recovery that lost its lease since the listing deletes nothing', async () => {
  const { directory, names, make } = storeFixture('store-recovery-paused');
  const lock = path.join(directory, STORE_LOCK);
  fs.writeFileSync(path.join(directory, 'shard-1-dead-0'), `${JSON.stringify(entry('unnamed.jsonl.zst'))}\n`);
  const holder = make({
    fault: (at) => {
      if (at === 'recovery:start') fs.writeFileSync(lock, 'other');
    },
  });
  await holder.append([entry('a.jsonl.zst')]);
  assert.equal(holder.held, false);
  assert.ok(names().includes('shard-1-dead-0'), 'a paused recovery deleted a file from its stale listing');
  holder.dispose();
});

test('an input that cannot be read ends the compaction with every input kept', async () => {
  let denied: string | null = null;
  const { directory, clock, make, names } = storeFixture('store-unreadable', {
    segmentBytes: 64,
    compactSegments: 3,
    openInput: (file) => {
      if (denied && file.endsWith(denied)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return fs.openSync(file, 'r');
    },
  });
  const holder = make();
  await holder.append([entry('a.jsonl.zst')]);
  await holder.append([entry('b.jsonl.zst')]);
  denied = names().find((name) => name.startsWith('segment-'))!;
  await holder.append([entry('c.jsonl.zst')]);
  assert.equal(names().filter((name) => name.startsWith('segment-')).length, 3, 'the compaction retired an input');
  assert.equal(
    names().filter((name) => /^(shard|manifest)-/.test(name)).length,
    0,
    'the failed compaction left output',
  );
  assert.equal(holder.held, true, 'a read failure ended the lease');
  assert.equal(threadCount(directory), 3);
  denied = null;
  clock.advance(300_001);
  await holder.append([entry('d.jsonl.zst')]);
  assert.ok(
    names().some((name) => name.startsWith('manifest-')),
    'the next compaction did not run',
  );
  assert.equal(threadCount(directory), 4);
  holder.dispose();
});

test('an older fact version stays a readable stale candidate and a compaction folds it', async () => {
  const { directory, clock, make, names } = storeFixture('store-older-version', {
    segmentBytes: 64,
    compactSegments: 2,
  });
  const older = {
    ...entry('older.jsonl.zst', { carriedName: { label: 'Kept', fullLabel: 'Kept' } }),
    factsVersion: COMPRESSED_FACTS_VERSION - 1,
  };
  const newer = { ...entry('newer.jsonl.zst'), factsVersion: COMPRESSED_FACTS_VERSION + 1 };
  fs.writeFileSync(path.join(directory, 'segment-3-old-0'), `${JSON.stringify(older)}\n`);
  fs.writeFileSync(path.join(directory, 'segment-3-new-0'), `${JSON.stringify(newer)}\n`);
  const before = readCompressedStore(directory).entries;
  assert.equal(before.get('older.jsonl.zst')?.carriedName?.label, 'Kept', 'an older fact version removed the entry');
  assert.equal(before.has('newer.jsonl.zst'), false, 'a reader merged a newer fact version');
  const holder = make();
  await holder.append([entry('a.jsonl.zst')]);
  await holder.append([entry('b.jsonl.zst')]);
  clock.advance(1);
  assert.ok(
    names().some((name) => name.startsWith('manifest-')),
    'the compaction did not run',
  );
  assert.equal(names().includes('segment-3-old-0'), false, 'the older input was left out of the compaction');
  assert.ok(names().includes('segment-3-new-0'), 'a compaction took a newer file');
  const after = readCompressedStore(directory).entries;
  assert.equal(
    after.get('older.jsonl.zst')?.factsVersion,
    COMPRESSED_FACTS_VERSION - 1,
    'the compaction dropped the older entry',
  );
  holder.dispose();
});

test('an entry in a later file of a holder wins over an earlier file, whatever the listing order', () => {
  const { directory } = storeFixture('store-write-order');
  // The name of the later file, seq 10, sorts before seq 9.
  fs.writeFileSync(
    path.join(directory, 'segment-1-t-10'),
    `${JSON.stringify(entry('x.jsonl.zst', { threadId: 'later' }))}\n`,
  );
  fs.writeFileSync(
    path.join(directory, 'segment-1-t-9'),
    `${JSON.stringify(entry('x.jsonl.zst', { threadId: 'earlier' }))}\n`,
  );
  assert.equal(readCompressedStore(directory).entries.get('x.jsonl.zst')?.threadId, 'later');
});

test('a renewal with an unchanged lock and an overwritten epoch abandons within one interval', async () => {
  const { directory, clock, make } = storeFixture('store-renew-epoch');
  const holder = make();
  await holder.append([entry('a.jsonl.zst')]);
  fs.writeFileSync(path.join(directory, 'epoch'), JSON.stringify({ e: 99, token: 'paused' }));
  clock.advance(10_000);
  assert.equal(holder.held, false, 'the renewal did not check the epoch');
  holder.dispose();
});

test('an error in the renewal timer abandons and retries, and the entry is written', async () => {
  let failing = false;
  const fixture = storeFixture('store-renew-error');
  const { directory, clock, make } = fixture;
  const holder = make({
    now: () => {
      if (failing) throw new Error('disk fault');
      return clock.now;
    },
  });
  await holder.append([entry('a.jsonl.zst')]);
  failing = true;
  clock.advance(10_000);
  failing = false;
  assert.equal(holder.held, false, 'a store error during renewal did not end the lease');
  await holder.append([entry('b.jsonl.zst')]);
  assert.equal(threadCount(directory), 2);
  holder.dispose();
});

test('a store error during a run abandons, retries and never rejects the append', async () => {
  let failing = true;
  const { directory, clock, make } = storeFixture('store-work-error', {
    yieldStep: async () => {
      if (failing) throw new Error('disk fault');
    },
  });
  const holder = make();
  // The first yield rejects after the entry's line is written.
  assert.deepEqual(await holder.append([entry('a.jsonl.zst')]), [true]);
  assert.equal(holder.held, false, 'a store error did not end the lease');
  assert.equal(fs.existsSync(path.join(directory, STORE_LOCK)), false, 'the abandonment left the lock');
  failing = false;
  await holder.append([entry('b.jsonl.zst')]);
  clock.advance(1);
  assert.equal(threadCount(directory), 2);
  holder.dispose();
});

test('a failed epoch write abandons instead of wedging the holder, and the retry writes the entry', async () => {
  const { directory, clock, make } = storeFixture('store-fence-error');
  // A directory at the epoch path makes the rename of a new epoch file fail on every platform.
  fs.mkdirSync(path.join(directory, 'epoch'));
  const holder = make();
  assert.deepEqual(await holder.append([entry('a.jsonl.zst')]), [false]);
  assert.equal(holder.held, false);
  assert.equal(fs.existsSync(path.join(directory, STORE_LOCK)), false, 'the failed fence left the lock');
  fs.rmdirSync(path.join(directory, 'epoch'));
  clock.advance(5_000);
  await holder.work();
  await vi.waitFor(() => assert.equal(holder.pending, 0));
  assert.equal(threadCount(directory), 1);
  holder.dispose();
});

test('unknown-version segments do not count toward the compaction roll at a takeover', async () => {
  const { directory, make, names } = storeFixture('store-roll-newer', {
    segmentBytes: 64,
    compactSegments: 2,
  });
  const newer = { ...entry('newer.jsonl.zst'), factsVersion: COMPRESSED_FACTS_VERSION + 1 };
  fs.writeFileSync(path.join(directory, 'segment-5-newer-0'), `${JSON.stringify(newer)}\n`);
  fs.writeFileSync(path.join(directory, 'segment-5-newer-1'), `${JSON.stringify(newer)}\n`);
  fs.writeFileSync(path.join(directory, 'segment-5-newer-2'), `${JSON.stringify(newer)}\n`);
  const holder = make();
  await holder.append([entry('a.jsonl.zst')]);
  assert.equal(
    names().filter((name) => name.startsWith('manifest-')).length,
    0,
    'a newer segment started a compaction',
  );
  holder.dispose();
});

test('a compaction syncs each shard and manifest before it deletes its inputs', async () => {
  const { directory, make } = storeFixture('store-sync', { segmentBytes: 64, compactSegments: 3 });
  const opened = vi.spyOn(defaultFs, 'openSync');
  const synced = vi.spyOn(defaultFs, 'fsyncSync');
  try {
    const holder = make();
    for (const at of [1, 2, 3]) await holder.append([entry(`r${at}.jsonl.zst`)]);
    const temporaries = opened.mock.calls.flatMap(([name], index) =>
      /\.tmp$/.test(String(name)) ? [{ name: String(name), fd: opened.mock.results[index].value as number }] : [],
    );
    assert.ok(
      temporaries.some(({ name }) => /[/\\]shard-/.test(name)) &&
        temporaries.some(({ name }) => /[/\\]manifest-/.test(name)),
      'the compaction wrote no shard or manifest through a temporary',
    );
    const fds = new Set(synced.mock.calls.map(([fd]) => fd));
    for (const { name, fd } of temporaries) assert.ok(fds.has(fd), `${path.basename(name)} was not synced`);
    holder.dispose();
    assert.ok(threadCount(directory) === 3);
  } finally {
    opened.mockRestore();
    synced.mockRestore();
  }
});

test('the idle holder releases its lock and the next append takes it again with a higher epoch', async () => {
  const { directory, clock, make } = storeFixture('store-idle');
  const holder = make();
  await holder.append([entry('a.jsonl.zst')]);
  clock.advance(20_000);
  assert.equal(holder.held, false);
  assert.equal(fs.existsSync(path.join(directory, STORE_LOCK)), false);
  await holder.append([entry('b.jsonl.zst')]);
  assert.equal(holder.held, true);
  const epoch = JSON.parse(fs.readFileSync(path.join(directory, 'epoch'), 'utf8'));
  assert.equal(epoch.e, 2);
  holder.dispose();
});

test('recording a compressed list resolves each directory once and yields between slices', async () => {
  const { directory, make } = storeFixture('store-names', { segmentBytes: 4096 });
  const holder = make();
  await holder.append([entry('known.jsonl.zst')]);
  const root = tempDir('store-names-rollouts');
  for (const name of ['a', 'b']) fs.mkdirSync(path.join(root, name));
  const names = [
    'known.jsonl.zst',
    ...Array.from({ length: 200 }, (_, at) => path.join(root, at % 2 ? 'a' : 'b', `rollout-${at}.jsonl.zst`)),
  ];
  const resolved = vi.spyOn(defaultFs.realpathSync, 'native');
  let clock = 0;
  let yields = 0;
  try {
    await recordCompressedNames(names, holder, {
      now: () => (clock += 5),
      yieldStep: async () => {
        yields++;
      },
      statOf: () => null,
    });
  } finally {
    const calls = resolved.mock.calls.length;
    resolved.mockRestore();
    assert.ok(calls <= 2, `${calls} directory resolutions for 2 directories`);
  }
  assert.ok(yields >= 30, `${yields} yields across 200 names at 5 ms each`);
  const stored = readCompressedStore(directory).entries;
  assert.equal(stored.get(names[1])?.nameOnly, true);
  assert.equal(stored.get('known.jsonl.zst')?.nameOnly, undefined, 'a known name got a second record');
  holder.dispose();
});

test('a stepped read of the store yields after every file', async () => {
  const { directory } = storeFixture('store-read-steps');
  for (const at of [1, 2, 3])
    fs.writeFileSync(path.join(directory, `segment-1-t-${at}`), `${JSON.stringify(entry(`r${at}.jsonl.zst`))}\n`);
  let yields = 0;
  const read = await readCompressedStoreInSteps(
    directory,
    () => null,
    async () => {
      yields++;
    },
  );
  assert.equal(read.entries.size, 3);
  assert.ok(yields >= 3, `${yields} yields across 3 files`);
});

test('a follower reads only the bytes appended since its last poll and a compaction repeats no entry', async () => {
  const { directory, clock, make, names } = storeFixture('store-follow', {
    segmentBytes: 4096,
    compactSegments: 99,
  });
  const first = make();
  await first.append([entry('a.jsonl.zst')]);
  const follower = new CompressedStoreFollower(
    directory,
    () => null,
    async () => {},
  );
  assert.deepEqual(
    (await follower.poll()).map((item) => item.file),
    ['a.jsonl.zst'],
  );
  const firstBytes = follower.bytesRead;
  await first.append([entry('a2.jsonl.zst')]);
  const segment = names().find((name) => name.startsWith('segment-'))!;
  const grown = fs.statSync(path.join(directory, segment)).size;
  assert.deepEqual(
    (await follower.poll()).map((item) => item.file),
    ['a2.jsonl.zst'],
    'the appended entry did not arrive',
  );
  assert.equal(follower.bytesRead, grown, 'the follower read the whole file again after an append');
  assert.ok(grown > firstBytes);
  const initial = follower.bytesRead;
  assert.deepEqual(await follower.poll(), [], 'an unchanged store gave an entry');
  assert.equal(follower.bytesRead, initial, 'a poll with no appended bytes read the store again');
  first.dispose();
  // Another window takes the lease and appends.
  const second = make();
  await second.append([entry('b.jsonl.zst')]);
  // A takeover folds the first window's segment into a shard, so the present files are the only new bytes.
  const newBytes = names()
    .filter((name) => /^(segment|shard)-/.test(name))
    .map((name) => fs.statSync(path.join(directory, name)).size)
    .reduce((sum, size) => sum + size, 0);
  assert.deepEqual(
    (await follower.poll()).map((item) => item.file),
    ['b.jsonl.zst'],
    "the other window's entry did not arrive",
  );
  assert.equal(follower.bytesRead, initial + newBytes, 'the follower read more than the appended bytes');
  second.dispose();
  clock.advance(1);
  // A compaction writes the same entries into shards.
  const third = make({ segmentBytes: 64, compactSegments: 2 });
  await third.append([entry('c.jsonl.zst')]);
  await third.append([entry('d.jsonl.zst')]);
  assert.ok(
    names().some((name) => name.startsWith('manifest-')),
    'the compaction did not run',
  );
  assert.deepEqual(
    (await follower.poll()).map((item) => item.file).sort(),
    ['c.jsonl.zst', 'd.jsonl.zst'],
    'a compaction repeated a known entry',
  );
  third.dispose();
});

test('successive load batches wait one second between posts', async () => {
  vi.useFakeTimers();
  try {
    const big = (name: string) => entry(name, { threadId: 'x'.repeat(3 * 1024 * 1024) });
    const posted: string[][] = [];
    const answer = postCompressedBatches([big('a'), big('b'), big('c')], new AbortController().signal, (batch) =>
      posted.push(batch.map((item) => item.file)),
    );
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(posted, [['a']]);
    await vi.advanceTimersByTimeAsync(999);
    assert.deepEqual(posted, [['a']], 'a second batch came before one second passed');
    await vi.advanceTimersByTimeAsync(1);
    assert.deepEqual(posted, [['a'], ['b']]);
    await vi.advanceTimersByTimeAsync(1_000);
    assert.deepEqual(
      (await answer).map((item) => item.file),
      ['c'],
      'the last batch was not left for the reply',
    );
  } finally {
    vi.useRealTimers();
  }
});

test('a batch of entries holds at most 4 MiB, or one larger record', () => {
  const big = entry('big', { threadId: 'x'.repeat(5 * 1024 * 1024) });
  const small = entry('small');
  const batches = compressedEntryBatches([small, big, small]);
  assert.equal(batches.length, 3);
  assert.deepEqual(
    batches.map((batch) => batch.map((item) => item.file)),
    [['small'], ['big'], ['small']],
  );
});

test('a marked derivation never replaces a higher spend record and takes the mark', () => {
  const spend = (dollars: number) =>
    ({
      file: 'x',
      buckets: [{ requests: dollars, reportedCost: dollars, reportedCostBasis: 'list' }],
    }) as unknown as SpendFileIndex;
  const previous = entry('x', { spend: spend(7), undercount: false });
  const marked = entry('x', { spend: spend(3), undercount: true });
  const kept = withKeptUndercount(previous, marked);
  assert.equal(kept.spend, previous.spend);
  assert.equal(kept.undercount, true);
  const higher = entry('x', { spend: spend(9), undercount: true });
  assert.equal(withKeptUndercount(previous, higher).spend, higher.spend);
  const unmarked = entry('x', { spend: spend(1) });
  assert.equal(
    withKeptUndercount(previous, unmarked).spend,
    unmarked.spend,
    'an unmarked derivation kept the old total',
  );
});

const THREAD = '01a032c9-1a92-7931-845c-723117d24dbe';
const OTHER_THREAD = '01a032c9-984d-7972-a0e5-abe29d0f50cf';

function twinFixture(name: string, firstLine: string, plainThread = THREAD) {
  const directory = tempDir(name);
  const plain = path.join(directory, `rollout-2026-08-25T12-00-00-${plainThread}.jsonl`);
  const twin = `${plain}.zst`;
  fs.writeFileSync(twin, encode!(Buffer.from(firstLine)));
  const stat = fs.statSync(twin, { bigint: true });
  return {
    plain,
    twin,
    mtimeMs: Number(stat.mtimeNs / 1_000_000n) + Number(stat.mtimeNs % 1_000_000n) / 1_000_000,
  };
}

const opening = (id: string) =>
  `${JSON.stringify({ type: 'session_meta', timestamp: '2026-08-25T12:00:00Z', payload: { id, cwd: 'c:/repo' } })}\n`;
const meta = (id: string) => ({ sessionId: id, cwd: 'c:/repo' }) as CompressedFactEntry['opening'];
const completeSpend = { file: 'x', complete: true, buckets: [] } as unknown as SpendFileIndex;

test.skipIf(!encode)('an adopted twin takes the plain title, opening and spend record with a hash', async () => {
  const { plain, twin, mtimeMs } = twinFixture('adopt-ok', opening(THREAD));
  const title = {
    label: 'Work',
    fullLabel: 'Work',
    mtimeMs,
    size: 12,
  } as CompressedFactEntry['title'];
  const { adopted, entry: taken } = await adoptCompressedTwin({
    twin,
    plain,
    plainMtimeMs: mtimeMs,
    title,
    opening: meta(THREAD),
    spend: completeSpend,
  });
  assert.equal(adopted, true);
  assert.equal(taken.title?.label, 'Work');
  assert.equal(taken.size, fs.statSync(twin).size, 'the title keeps the plain size');
  assert.equal(taken.title?.size, taken.size);
  assert.equal(taken.spend, completeSpend);
  assert.equal(taken.complete, true);
  assert.equal(typeof taken.hash, 'string');
  assert.equal(taken.adoptionFailed, undefined);
});

for (const [name, firstLine, plainThread, mtimeShift, spendRecord] of [
  ['of another thread', opening(OTHER_THREAD), THREAD, 0, completeSpend],
  ['with no newline within 1 MiB', 'x'.repeat(1024 * 1024 + 8), THREAD, 0, completeSpend],
  ['of a different time', opening(THREAD), THREAD, 1, completeSpend],
  ['with an incomplete plain record', opening(THREAD), THREAD, 0, { ...completeSpend, complete: false }],
] as const) {
  test.skipIf(!encode)(`a twin ${name} keeps no plain fact and marks the backfill`, async () => {
    const { plain, twin, mtimeMs } = twinFixture(`adopt-${name.replace(/\W/g, '-')}`, firstLine, plainThread);
    const { adopted, entry: taken } = await adoptCompressedTwin({
      twin,
      plain,
      plainMtimeMs: mtimeMs + mtimeShift,
      title: {
        label: 'Work',
        fullLabel: 'Work',
        mtimeMs,
        size: 12,
      } as CompressedFactEntry['title'],
      opening: meta(plainThread),
      spend: spendRecord,
    });
    assert.equal(adopted, false);
    assert.equal(taken.adoptionFailed, true);
    assert.equal(taken.title, undefined);
    assert.equal(taken.spend, undefined);
  });
}

test.skipIf(!encode)('an adoption behind a live lock answers only after its entry is on disk', async () => {
  const { plain, twin, mtimeMs } = twinFixture('adopt-durable', opening(THREAD));
  const { directory, clock, make } = storeFixture('adopt-durable-store');
  const openings = storeFixture('adopt-durable-openings').make();
  const lock = path.join(directory, STORE_LOCK);
  fs.writeFileSync(lock, 'live-holder');
  const holder = make();
  let answered = false;
  const answer = recordCompressedAdoption(
    { twin, plain, plainMtimeMs: mtimeMs, opening: meta(THREAD), spend: completeSpend },
    holder,
    openings,
  ).then((result) => {
    answered = true;
    return result;
  });
  await vi.waitFor(() => assert.equal(holder.pending, 1));
  assert.equal(answered, false, 'the adoption answered before its entry reached the disk');
  fs.rmSync(lock);
  clock.advance(5_000);
  const result = await answer;
  assert.equal(result.durable, true);
  assert.equal(readCompressedStore(directory).entries.get(twin)?.adopted, true);
  holder.dispose();
  openings.dispose();
});

test.skipIf(!encode)('a twin replaced while its adoption waits for the lease restarts the adoption', async () => {
  const { plain, twin, mtimeMs } = twinFixture('adopt-wait-replaced', opening(THREAD));
  const { directory, clock, make } = storeFixture('adopt-wait-replaced-store');
  const openings = storeFixture('adopt-wait-replaced-openings').make();
  const lock = path.join(directory, STORE_LOCK);
  fs.writeFileSync(lock, 'live-holder');
  const holder = make();
  const answer = recordCompressedAdoption(
    { twin, plain, plainMtimeMs: mtimeMs, opening: meta(THREAD), spend: completeSpend },
    holder,
    openings,
  );
  await vi.waitFor(() => assert.equal(holder.pending, 1));
  // Another thread's compression replaces the twin after its validation and before the append.
  fs.writeFileSync(twin, encode!(Buffer.from(opening(OTHER_THREAD))));
  const replaced = new Date(mtimeMs + 60_000);
  fs.utimesSync(twin, replaced, replaced);
  fs.rmSync(lock);
  clock.advance(5_000);
  const result = await answer;
  assert.equal(result.adopted, false, "the queue published the replaced twin's facts");
  assert.equal(result.durable, true);
  const stored = readCompressedStore(directory).entries.get(twin);
  assert.equal(stored?.adopted, undefined, "the store holds the replaced twin's facts");
  assert.equal(stored?.adoptionFailed, true);
  assert.equal(stored?.threadId, OTHER_THREAD);
  holder.dispose();
  openings.dispose();
});

test.skipIf(!encode)('an adoption whose holder stops answers not durable', async () => {
  const { plain, twin, mtimeMs } = twinFixture('adopt-stop', opening(THREAD));
  const { directory, make } = storeFixture('adopt-stop-store');
  const openings = storeFixture('adopt-stop-openings').make();
  fs.writeFileSync(path.join(directory, STORE_LOCK), 'live-holder');
  const holder = make();
  const answer = recordCompressedAdoption(
    { twin, plain, plainMtimeMs: mtimeMs, opening: meta(THREAD), spend: completeSpend },
    holder,
    openings,
  );
  await vi.waitFor(() => assert.equal(holder.pending, 1));
  holder.dispose();
  assert.equal((await answer).durable, false);
  assert.equal(threadCount(directory), 0);
  openings.dispose();
});

test.skipIf(!encode)('a twin replaced during its hash fails the adoption', async () => {
  const { plain, twin, mtimeMs } = twinFixture('adopt-replaced', opening(THREAD));
  const { adopted, entry: taken } = await adoptCompressedTwin(
    { twin, plain, plainMtimeMs: mtimeMs, opening: meta(THREAD), spend: completeSpend },
    async (file) => {
      // Another thread's compression replaces the file between the header read and the hash.
      fs.writeFileSync(twin, encode!(Buffer.from(opening(OTHER_THREAD))));
      return hashCompressedRollout(file);
    },
  );
  assert.equal(adopted, false, 'the facts of one revision took the hash of another');
  assert.equal(taken.adoptionFailed, true);
  assert.equal(taken.hash, undefined);
});

test.skipIf(!encode)('a twin whose first line is not an opening fails the adoption', async () => {
  const { plain, twin, mtimeMs } = twinFixture('adopt-no-opening', `${JSON.stringify({ type: 'response_item' })}\n`);
  const { adopted, entry: taken } = await adoptCompressedTwin({
    twin,
    plain,
    plainMtimeMs: mtimeMs,
    opening: meta(THREAD),
    spend: completeSpend,
  });
  assert.equal(adopted, false, 'a file name passed as thread evidence');
  assert.equal(taken.adoptionFailed, true);
});

test.skipIf(!encode)('a twin that does not decode keeps no plain fact', async () => {
  const { plain, twin, mtimeMs } = twinFixture('adopt-corrupt', opening(THREAD));
  fs.writeFileSync(twin, Buffer.from('not a zstd stream'));
  const { adopted, entry: taken } = await adoptCompressedTwin({
    twin,
    plain,
    plainMtimeMs: fs.statSync(twin).mtimeMs,
    opening: meta(THREAD),
    spend: completeSpend,
  });
  assert.equal(adopted, false);
  assert.equal(taken.adoptionFailed, true);
  assert.ok(mtimeMs > 0);
});

test('a pair key through a directory alias meets the ledger path after the plain file is gone', () => {
  const root = tempDir('store-pair-alias');
  const real = path.join(root, 'real');
  fs.mkdirSync(real);
  const alias = path.join(root, 'alias');
  fs.symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const name = `rollout-x-${THREAD}.jsonl`;
  fs.writeFileSync(path.join(real, name), '{}');
  const ledgerPath = normalizeSpendFile(path.join(real, name));
  fs.rmSync(path.join(real, name));
  assert.equal(compressedPairKey(path.join(alias, `${name}.zst`)), ledgerPath);
});

test('a lock held by a live holder with a fresh mtime keeps a second holder out', () => {
  const directory = tempDir('store-live-lock');
  const lock = path.join(directory, STORE_LOCK);
  const token = takeCodexOpeningsLock(lock);
  assert.ok(token);
  assert.equal(takeCodexOpeningsLock(lock), null);
  fs.rmSync(lock);
});
