import { test, vi } from 'vitest';
import assert from 'node:assert';
import {
  BoundedTrailingScheduler,
  IntegrityScheduler,
  listedFilesFor,
  mergeRefreshRequests,
  PendingWatcherWake,
  RefreshRequest,
  SchedulerClock,
  watcherRefreshDecision,
} from './scheduler.ts';

test('integrity deadlines survive continuous targeted work and cold discovery includes mixed folders', async () => {
  vi.useFakeTimers();
  try {
    const checked: { file: string; at: number }[] = [];
    const discoveries: number[] = [];
    const scheduler = new IntegrityScheduler(
      async (files) => {
        checked.push(...files.map((file) => ({ file, at: Date.now() })));
      },
      () => discoveries.push(Date.now()),
      undefined,
      1,
    );
    scheduler.update([
      { file: '/mixed/warm', warm: true },
      { file: '/mixed/cold', warm: false },
      { file: '/old/archived', warm: false },
    ]);
    scheduler.start();
    const start = Date.now();
    for (let second = 0; second < 910; second += 10) {
      scheduler.promote(['/targeted']);
      await vi.advanceTimersByTimeAsync(10_000);
    }
    assert.ok(checked.some((check) => check.file === '/mixed/warm' && check.at >= start + 30_000));
    assert.ok(checked.some((check) => check.file === '/mixed/cold'));
    assert.ok(checked.some((check) => check.file === '/old/archived'));
    assert.equal(discoveries.length, 1);
    scheduler.pause();
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    vi.useRealTimers();
  }
});

test('integrity passes retain progress and one global batch through slow checks and disposal', async () => {
  vi.useFakeTimers();
  try {
    let release!: () => void;
    let current!: () => boolean;
    const visits: string[] = [];
    let active = 0;
    let maximum = 0;
    const scheduler = new IntegrityScheduler(
      async (files, valid) => {
        active++;
        maximum = Math.max(maximum, active);
        visits.push(...files);
        current = valid;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        active--;
      },
      () => {},
      undefined,
      1,
    );
    scheduler.update([
      { file: 'a', warm: true },
      { file: 'b', warm: true },
    ]);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1);
    assert.deepEqual(visits, ['a']);
    scheduler.promote(['a']);
    await vi.advanceTimersByTimeAsync(90_000);
    assert.deepEqual(visits, ['a']);
    release();
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(visits[1], 'a');
    release();
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(visits[2], 'b');
    scheduler.pause();
    assert.equal(current(), false);
    release();
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(maximum, 1);
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    vi.useRealTimers();
  }
});

test('targeted integrity extraction visits only its admitted batch', async () => {
  vi.useFakeTimers();
  try {
    let visited = 0;
    class CountedSet extends Set<string> {
      override *[Symbol.iterator](): SetIterator<string> {
        for (const file of super[Symbol.iterator]()) {
          visited++;
          yield file;
        }
      }
    }
    const scheduler = new IntegrityScheduler(
      async (files) => {
        assert.equal(files.length, 16);
        scheduler.pause();
      },
      () => {},
    );
    (scheduler as unknown as { pending: Set<string> }).pending = new CountedSet();
    scheduler.promote(Array.from({ length: 1024 }, (_, index) => String(index)));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(visited, 16, 'taking a small batch traversed the targeted backlog');
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

class FakeClock implements SchedulerClock {
  private nextId = 1;
  private timers = new Map<number, { at: number; callback: () => void }>();
  time = 0;

  now(): number {
    return this.time;
  }

  setTimer(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id;
  }

  clearTimer(timer: unknown): void {
    this.timers.delete(timer as number);
  }

  advanceTo(target: number): void {
    while (true) {
      const due = [...this.timers]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) {
        break;
      }
      this.time = due[1].at;
      this.timers.delete(due[0]);
      due[1].callback();
    }
    this.time = target;
  }
}

test('one event runs after the trailing quiet period', () => {
  const clock = new FakeClock();
  const runs: { at: number; cause: string }[] = [];
  const scheduler = new BoundedTrailingScheduler(
    200,
    1_000,
    (event) => runs.push({ at: event.firedAt, cause: event.cause }),
    clock,
  );

  scheduler.offer();
  clock.advanceTo(199);
  assert.deepEqual(runs, []);
  clock.advanceTo(200);
  assert.deepEqual(runs, [{ at: 200, cause: 'quiet' }]);
});

test('a continuous watcher stream runs at most once per maximum-wait interval', () => {
  const clock = new FakeClock();
  const runs: number[] = [];
  const scheduler = new BoundedTrailingScheduler(200, 1_000, (event) => runs.push(event.firedAt), clock);

  for (let at = 0; at < 20_000; at += 50) {
    clock.advanceTo(at);
    scheduler.offer();
  }
  clock.advanceTo(20_000);

  assert.equal(runs.length, 20);
  assert.deepEqual(
    runs,
    Array.from({ length: 20 }, (_, index) => (index + 1) * 1_000),
  );
});

test('a final event just before the maximum neither postpones nor duplicates the run', () => {
  const clock = new FakeClock();
  const runs: { at: number; cause: string }[] = [];
  const scheduler = new BoundedTrailingScheduler(
    200,
    1_000,
    (event) => runs.push({ at: event.firedAt, cause: event.cause }),
    clock,
  );

  for (let at = 0; at <= 900; at += 100) {
    clock.advanceTo(at);
    scheduler.offer();
  }
  clock.advanceTo(999);
  scheduler.offer();
  clock.advanceTo(1_000);
  clock.advanceTo(1_300);

  assert.deepEqual(runs, [{ at: 1_000, cause: 'maximum' }]);
});

test('four known watcher files produce one targeted batch with four paths', () => {
  const clock = new FakeClock();
  const pending = new PendingWatcherWake();
  const batches: ReturnType<PendingWatcherWake['take']>[] = [];
  const scheduler = new BoundedTrailingScheduler(200, 1_000, () => batches.push(pending.take()), clock);

  for (const name of ['a.jsonl', 'b.jsonl', 'c.jsonl', 'd.jsonl']) {
    pending.noteFileEvent('records', name, 'change');
    scheduler.offer();
    clock.advanceTo(clock.now() + 50);
  }
  clock.advanceTo(350);

  assert.equal(batches.length, 1);
  assert.equal(batches[0].eventCount, 4);
  assert.equal(batches[0].changedPaths.length, 4);
  assert.deepEqual(
    watcherRefreshDecision(batches[0], () => true),
    {
      kind: 'targeted',
      changedPaths: batches[0].changedPaths,
    },
  );
});

test('unknown filenames and rename events retain the broad watcher path', () => {
  const missing = new PendingWatcherWake();
  missing.noteFileEvent('records', null, 'change');
  assert.deepEqual(
    watcherRefreshDecision(missing.take(), () => true),
    {
      kind: 'broad',
      changedPaths: [],
    },
  );

  const renamed = new PendingWatcherWake();
  renamed.noteFileEvent('records', 'new.jsonl', 'rename');
  assert.equal(watcherRefreshDecision(renamed.take(), () => true).kind, 'broad');

  const unknown = new PendingWatcherWake();
  unknown.noteFileEvent('records', 'unknown.jsonl', 'change');
  assert.equal(watcherRefreshDecision(unknown.take(), () => false).kind, 'broad');
});

test('live activity with no card names listed transcripts and draws only for a shown session', () => {
  const catalog = [
    { sessionId: 'shown', file: 'shown.jsonl' },
    { sessionId: 'listed', file: 'listed.jsonl' },
    { sessionId: 'listed', file: 'listed-continued.jsonl' },
  ];
  const listed = new PendingWatcherWake();
  listed.noteActivityFallback(listedFilesFor(['listed'], catalog), false);
  const quiet = listed.take();
  assert.deepEqual(
    watcherRefreshDecision(quiet, () => true),
    { kind: 'targeted', changedPaths: ['listed-continued.jsonl', 'listed.jsonl'] },
    'a session with two listed transcripts did not name both',
  );
  assert.equal(quiet.drawRequired, false);
  assert.deepEqual(quiet.reasons, ['activity-fallback']);

  const shown = new PendingWatcherWake();
  shown.noteActivityFallback(listedFilesFor(['shown'], catalog), true);
  const drawn = shown.take();
  assert.equal(watcherRefreshDecision(drawn, () => true).kind, 'targeted');
  assert.equal(drawn.drawRequired, true);
  assert.equal(shown.take().drawRequired, false, 'a taken draw stays pending for the next wake');

  const unlisted = new PendingWatcherWake();
  unlisted.noteActivityFallback(listedFilesFor(['listed', 'new'], catalog), false);
  assert.equal(watcherRefreshDecision(unlisted.take(), () => true).kind, 'broad');
});

test('a large burst of known transcript changes revalidates every file by name', () => {
  const pending = new PendingWatcherWake();
  for (let index = 0; index < 200; index++) {
    pending.noteFileEvent('records', `${index}.jsonl`, 'change');
  }
  pending.noteActivityFallback(['listed.jsonl'], false);
  const burst = pending.take();
  assert.equal(burst.changedPaths.length, 201);
  assert.equal(
    watcherRefreshDecision(burst, () => true).kind,
    'targeted',
    'a burst of known transcript changes walked the whole catalog',
  );
});

test('the ledger maximum bounds continuous changes and finish flushes the pending save once', () => {
  const clock = new FakeClock();
  const runs: { at: number; cause: string }[] = [];
  const scheduler = new BoundedTrailingScheduler(
    500,
    5_000,
    (event) => runs.push({ at: event.firedAt, cause: event.cause }),
    clock,
  );

  for (let at = 0; at < 20_000; at += 30) {
    clock.advanceTo(at);
    scheduler.offer();
  }
  scheduler.flush();
  scheduler.flush();

  assert.equal(runs.length, 4);
  assert.ok(runs.slice(1, -1).every((run, index) => run.at - runs[index].at >= 5_000));
  assert.equal(runs.at(-1)?.cause, 'flush');
});

test('disposal flushes one pending save and no timer runs it twice', () => {
  const clock = new FakeClock();
  const runs: string[] = [];
  const scheduler = new BoundedTrailingScheduler(500, 5_000, (event) => runs.push(event.cause), clock);

  scheduler.offer();
  clock.advanceTo(100);
  assert.equal(scheduler.pendingAge(), 100);
  assert.equal(scheduler.flush(), true);
  assert.equal(scheduler.flush(), false);
  clock.advanceTo(6_000);

  assert.deepEqual(runs, ['flush']);
});

test('a trigger that waits behind a refresh keeps the strongest request', () => {
  const request = (overrides: Partial<RefreshRequest>): RefreshRequest => ({
    reason: 'watcher',
    force: false,
    reuseCatalog: false,
    metadataAfterRender: false,
    changedPaths: null,
    ...overrides,
  });
  const watcherA = request({ changedPaths: ['a.jsonl'] });
  const watcherB = request({ changedPaths: ['b.jsonl', 'a.jsonl'] });
  const poll = request({ reason: 'poll' });
  const selection = request({ reason: 'direct', force: true, reuseCatalog: true, metadataAfterRender: true });

  assert.deepEqual(mergeRefreshRequests(null, watcherA), watcherA);
  assert.deepEqual(
    mergeRefreshRequests(watcherA, watcherB),
    request({ changedPaths: ['a.jsonl', 'b.jsonl'] }),
    'two watcher batches did not revalidate the union of their files',
  );
  assert.deepEqual(
    mergeRefreshRequests(watcherA, poll),
    request({ reason: 'coalesced' }),
    'a poll behind a watcher batch lost its broad walk',
  );
  assert.deepEqual(
    mergeRefreshRequests(selection, watcherA),
    request({ reason: 'coalesced', force: true, changedPaths: ['a.jsonl'] }),
    'a forced repaint that reuses the catalog widened a targeted batch or lost its repaint',
  );
  assert.deepEqual(
    mergeRefreshRequests(selection, request({ reason: 'direct', force: true, reuseCatalog: true })),
    request({ reason: 'direct', force: true, reuseCatalog: true }),
    'a request that wants metadata before its render was rendered before metadata',
  );
});
