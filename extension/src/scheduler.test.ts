import { test, vi } from 'vitest';
import assert from 'node:assert';
import {
  BoundedTrailingScheduler,
  IntegrityScheduler,
  listedFilesFor,
  mergeRefreshRequests,
  PendingWatcherWake,
  POLL_BACKSTOP_WALK_MS,
  PollDirectoryGate,
  RefreshRequest,
  SchedulerClock,
  sessionDirectoryOwners,
  unknownPathExtension,
  unknownPathShapes,
  watcherRefreshDecision,
} from './scheduler.ts';

test('watch priorities retain promotions for the same lifetime as integrity checks', () => {
  const clock = new FakeClock();
  const scheduler = new IntegrityScheduler(
    async () => {},
    () => {},
    clock,
  );
  scheduler.update([
    { file: 'warm', warm: true },
    { file: 'cold', warm: false },
  ]);
  assert.deepEqual([...scheduler.warmFiles()], ['warm']);
  scheduler.promote(['cold']);
  clock.time = 7 * 86_400_000 - 1;
  assert.deepEqual([...scheduler.warmFiles()], ['warm', 'cold']);
  clock.time++;
  assert.deepEqual([...scheduler.warmFiles()], ['warm']);
});

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
      broadReasons: [],
      ownedPaths: 0,
      walkListedPaths: 0,
      unknownPaths: [],
    },
  );
});

test('unknown filenames and rename events retain the broad watcher path and name their cause', () => {
  const missing = new PendingWatcherWake();
  missing.noteFileEvent('records', null, 'change');
  assert.deepEqual(
    watcherRefreshDecision(missing.take(), () => true),
    {
      kind: 'broad',
      changedPaths: [],
      broadReasons: ['missingFilename'],
      ownedPaths: 0,
      walkListedPaths: 0,
      unknownPaths: [],
    },
  );

  const renamed = new PendingWatcherWake();
  renamed.noteFileEvent('records', 'new.jsonl', 'rename');
  assert.deepEqual(watcherRefreshDecision(renamed.take(), () => true).broadReasons, ['createOrRename']);

  const unknown = new PendingWatcherWake();
  unknown.noteFileEvent('records', 'unknown.jsonl', 'change');
  assert.deepEqual(watcherRefreshDecision(unknown.take(), () => false).broadReasons, ['unknownPath']);

  const requested = new PendingWatcherWake();
  requested.requireBroad('transcript');
  assert.deepEqual(watcherRefreshDecision(requested.take(), () => true).broadReasons, ['requested']);

  const unnamed = { ...requested.take(), broadRequired: true, broadReasons: [] };
  assert.deepEqual(watcherRefreshDecision(unnamed, () => true).broadReasons, ['unspecified']);

  const empty = new PendingWatcherWake();
  assert.deepEqual(
    watcherRefreshDecision(empty.take(), () => true),
    {
      kind: 'broad',
      changedPaths: [],
      broadReasons: ['noPaths'],
      ownedPaths: 0,
      walkListedPaths: 0,
      unknownPaths: [],
    },
  );

  const both = new PendingWatcherWake();
  both.noteFileEvent('records', null, 'change');
  both.noteFileEvent('records', 'new.jsonl', 'rename');
  assert.deepEqual(watcherRefreshDecision(both.take(), () => true).broadReasons, ['createOrRename', 'missingFilename']);
  assert.deepEqual(both.take().broadReasons, [], 'a taken batch kept its broad causes');
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
    {
      kind: 'targeted',
      changedPaths: ['listed-continued.jsonl', 'listed.jsonl'],
      broadReasons: [],
      ownedPaths: 0,
      walkListedPaths: 0,
      unknownPaths: [],
    },
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
  assert.deepEqual(
    watcherRefreshDecision(unlisted.take(), () => true),
    {
      kind: 'broad',
      changedPaths: [],
      broadReasons: ['activityFallbackNoFile'],
      ownedPaths: 0,
      walkListedPaths: 0,
      unknownPaths: [],
    },
  );
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

// Each platform's path rules, as `normalizeFsPath` applies them, independent of the host running the test.
const platformPaths = {
  windows: {
    normalize: (file: string) => file.replace(/\\/g, '/').toLowerCase(),
    parent: 'C:\\Users\\Greg\\.claude\\projects\\C--Repo\\Parent-Session.jsonl',
    child: 'c:\\users\\greg\\.claude\\PROJECTS\\c--repo\\parent-session\\SubAgents\\agent-a1.jsonl',
    owned: true,
  },
  macos: {
    normalize: (file: string) => file,
    parent: '/Users/Greg/.claude/projects/-Users-Greg-Repo/Parent-Session.jsonl',
    child: '/Users/Greg/.claude/projects/-Users-Greg-Repo/Parent-Session/subagents/agent-a1.jsonl',
    owned: true,
  },
  linux: {
    normalize: (file: string) => file,
    parent: '/home/greg/.claude/projects/-home-greg-Repo/Parent-Session.jsonl',
    child: '/home/greg/.claude/projects/-home-greg-repo/parent-session/subagents/agent-a1.jsonl',
    owned: false,
  },
};

const directoryOf = (file: string) => file.slice(0, Math.max(file.lastIndexOf('\\'), file.lastIndexOf('/')));
const nameOf = (file: string) => file.slice(Math.max(file.lastIndexOf('\\'), file.lastIndexOf('/')) + 1);

test.each(Object.entries(platformPaths))(
  'a new child transcript under a listed session directory is owned by that session on %s',
  (_platform, { normalize, parent, child, owned }) => {
    const catalog = [
      { agent: 'claude', file: parent, sessionId: 'Parent-Session' },
      { agent: 'claude', file: child.replace('a1', 'a0'), sessionId: 'a0', childTranscript: true },
      { agent: 'codex', file: parent.replace('.jsonl', '-codex.jsonl'), sessionId: 'Parent-Session-codex' },
    ];
    const owners = sessionDirectoryOwners(catalog, normalize);
    assert.deepEqual(owners(normalize(child)), owned ? [parent] : null);
    // A file directly in the session directory belongs to it too. A file in the project directory does not.
    assert.deepEqual(owners(`${directoryOf(directoryOf(normalize(child)))}/tool.jsonl`), owned ? [parent] : null);
    assert.equal(owners(normalize(parent.replace('Parent-Session', 'Other'))), null);
  },
);

test('a Windows rename event for a new child transcript under a listed session revalidates the owner', () => {
  const { normalize, parent, child } = platformPaths.windows;
  const owners = sessionDirectoryOwners([{ agent: 'claude', file: parent, sessionId: 'Parent-Session' }], normalize);
  const known = (file: string) => file === normalize(parent);
  const created = new PendingWatcherWake();
  created.noteFileEvent(directoryOf(child), nameOf(child), 'rename', normalize);
  created.noteFileEvent(directoryOf(child), nameOf(child), 'change', normalize);
  assert.deepEqual(watcherRefreshDecision(created.take(), known, owners), {
    kind: 'targeted',
    changedPaths: [parent],
    broadReasons: [],
    ownedPaths: 1,
    walkListedPaths: 0,
    unknownPaths: [],
  });

  // A new top-level transcript beside it still walks, and so does a listed transcript that moved.
  const both = new PendingWatcherWake();
  both.noteFileEvent(directoryOf(child), nameOf(child), 'rename', normalize);
  both.noteFileEvent(directoryOf(parent), 'New-Session.jsonl', 'rename', normalize);
  assert.deepEqual(watcherRefreshDecision(both.take(), known, owners).broadReasons, ['createOrRename']);
  const moved = new PendingWatcherWake();
  moved.noteFileEvent(directoryOf(parent), nameOf(parent), 'rename', normalize);
  assert.deepEqual(watcherRefreshDecision(moved.take(), known, owners).broadReasons, ['createOrRename']);
  // A path under no listed session directory stays an unknown path.
  const stray = new PendingWatcherWake();
  stray.noteFileEvent('C:\\elsewhere', 'other.jsonl', 'change', normalize);
  assert.deepEqual(watcherRefreshDecision(stray.take(), known, owners).broadReasons, ['unknownPath']);
});

test('a path that the last walk listed and the held catalog lacks is targeted, and a path in neither walks', () => {
  // The batch spells each path with forward slashes on every host.
  const slash = (file: string) => file.replace(/\\/g, '/');
  const known = (file: string) => file === 'records/held.jsonl';
  const walked = (file: string) => file === 'records/walked.jsonl';
  const listed = new PendingWatcherWake();
  listed.noteFileEvent('records', 'walked.jsonl', 'change', slash);
  listed.noteFileEvent('records', 'held.jsonl', 'change', slash);
  assert.deepEqual(
    watcherRefreshDecision(listed.take(), known, () => null, walked),
    {
      kind: 'targeted',
      changedPaths: ['records/held.jsonl', 'records/walked.jsonl'],
      broadReasons: [],
      ownedPaths: 0,
      walkListedPaths: 1,
      unknownPaths: [],
    },
  );
  // One path in neither catalog makes the whole batch one walk.
  const mixed = new PendingWatcherWake();
  mixed.noteFileEvent('records', 'walked.jsonl', 'change', slash);
  mixed.noteFileEvent('records', 'stray.jsonl', 'change', slash);
  assert.deepEqual(
    watcherRefreshDecision(mixed.take(), known, () => null, walked),
    {
      kind: 'broad',
      changedPaths: [],
      broadReasons: ['unknownPath'],
      ownedPaths: 0,
      walkListedPaths: 0,
      unknownPaths: ['records/stray.jsonl'],
    },
  );
  // A walk-listed path in a create or rename event walks, as a held path does.
  const renamed = new PendingWatcherWake();
  renamed.noteFileEvent('records', 'walked.jsonl', 'rename', slash);
  assert.deepEqual(watcherRefreshDecision(renamed.take(), known, () => null, walked).broadReasons, ['createOrRename']);
});

// One source layout per platform. The changed paths spell the walked files in another case, so the walked-file shapes
// depend on each platform's case rules.
const shapeLayouts = {
  windows: {
    normalize: platformPaths.windows.normalize,
    sep: '\\',
    claudeRoot: 'C:\\Users\\Greg\\.claude\\projects',
    codexRoot: 'C:\\Users\\Greg\\.codex\\sessions',
    project: 'C--Repo',
    changedClaude: 'c:\\users\\greg\\.claude\\PROJECTS\\c--repo',
    changedCodex: 'c:\\users\\greg\\.codex\\SESSIONS\\2026\\10\\27',
    elsewhere: 'D:\\Elsewhere',
    caseFolded: true,
  },
  macos: {
    normalize: platformPaths.macos.normalize,
    sep: '/',
    claudeRoot: '/Users/Greg/.claude/projects',
    codexRoot: '/Users/Greg/.codex/sessions',
    project: '-Users-Greg-Repo',
    changedClaude: '/Users/Greg/.claude/projects/-Users-Greg-Repo',
    changedCodex: '/Users/Greg/.codex/sessions/2026/10/27',
    elsewhere: '/Volumes/Elsewhere',
    caseFolded: false,
  },
  linux: {
    normalize: platformPaths.linux.normalize,
    sep: '/',
    claudeRoot: '/home/greg/.claude/projects',
    codexRoot: '/home/greg/.codex/sessions',
    project: '-home-greg-Repo',
    changedClaude: '/home/greg/.claude/projects/-home-greg-Repo',
    changedCodex: '/home/greg/.codex/sessions/2026/10/27',
    elsewhere: '/srv/Elsewhere',
    caseFolded: false,
  },
};

// Each shape with the file that produces it. A walked file's name differs in case from the walk's record of it, so
// only Windows finds it among the walked files, and the other platforms find a new file beside a listed one.
const shapeCases: {
  shape: string;
  directory: 'claude' | 'child' | 'codex' | 'otherProject' | 'elsewhere';
  name: string;
  caseSensitive?: string;
}[] = [
  {
    shape: 'walkListedNotHeld',
    directory: 'claude',
    name: 'DROPPED-SESSION.jsonl',
    caseSensitive: 'newBesideClaudeTranscript',
  },
  {
    shape: 'walkedUnlistedChild',
    directory: 'child',
    name: 'AGENT-OLD.jsonl',
    caseSensitive: 'newBesideChildTranscript',
  },
  {
    shape: 'walkedUnlistedClaude',
    directory: 'claude',
    name: 'EXCLUDED.jsonl',
    caseSensitive: 'newBesideClaudeTranscript',
  },
  {
    shape: 'walkedUnlistedCodex',
    directory: 'codex',
    name: 'ROLLOUT-OTHER.jsonl',
    caseSensitive: 'newBesideCodexRollout',
  },
  { shape: 'newBesideClaudeTranscript', directory: 'claude', name: 'New-Session.jsonl' },
  { shape: 'newBesideChildTranscript', directory: 'child', name: 'agent-a1.jsonl' },
  { shape: 'newBesideCodexRollout', directory: 'codex', name: 'rollout-new.jsonl' },
  { shape: 'unlistedDirectory', directory: 'otherProject', name: 'Other-Session.jsonl' },
  { shape: 'outsideRoots', directory: 'elsewhere', name: 'Stray.jsonl' },
];

test.each(
  Object.entries(shapeLayouts).flatMap(([platform, layout]) =>
    shapeCases.map((one) => ({
      platform,
      layout,
      ...one,
      expected: one.caseSensitive && !layout.caseFolded ? one.caseSensitive : one.shape,
    })),
  ),
)(
  'an unknown path counts as $expected for the $shape fixture on $platform',
  ({ layout, directory, name, expected }) => {
    const { normalize, sep, claudeRoot, codexRoot, changedClaude, changedCodex, elsewhere } = layout;
    const project = `${claudeRoot}${sep}${layout.project}`;
    const date = `${codexRoot}${sep}2026${sep}10${sep}27`;
    const orphanChildren = `${project}${sep}Orphan-Session${sep}subagents`;
    const catalog = [
      { agent: 'claude', file: `${project}${sep}Listed-Session.jsonl`, sessionId: 'Listed-Session' },
      { agent: 'claude', file: `${orphanChildren}${sep}agent-a0.jsonl`, sessionId: 'a0', childTranscript: true },
      { agent: 'codex', file: `${date}${sep}rollout-listed.jsonl`, sessionId: 'listed' },
    ];
    // The last walk listed a session that the held catalog has since dropped. Both roots end in separators.
    const dropped = { agent: 'claude', file: `${project}${sep}Dropped-Session.jsonl`, sessionId: 'Dropped-Session' };
    const walked = {
      listed: [...catalog, dropped],
      claude: {
        root: `${claudeRoot}${sep}${sep}`,
        files: [
          ...[catalog[0], catalog[1], dropped].map((row) => row.file),
          `${project}${sep}Excluded.jsonl`,
          `${orphanChildren}${sep}agent-old.jsonl`,
        ],
      },
      codex: { root: `${codexRoot}${sep}`, files: [catalog[2].file, `${date}${sep}rollout-other.jsonl`] },
    };
    const changedDirectory = {
      claude: changedClaude,
      child: orphanChildren,
      codex: changedCodex,
      otherProject: `${claudeRoot}${sep}Other-Project`,
      elsewhere,
    }[directory];
    const known = new Set(catalog.map((row) => normalize(row.file)));
    // The batch spells the path as the watcher does on the platform, which `path.join` on the test host cannot.
    const batch = {
      ...new PendingWatcherWake().take(),
      eventCount: 1,
      changedPaths: [normalize(`${changedDirectory}${sep}${name}`)],
      reasons: ['transcript' as const],
    };
    const decision = watcherRefreshDecision(
      batch,
      (file) => known.has(normalize(file)),
      sessionDirectoryOwners(catalog, normalize),
    );
    assert.deepEqual(decision.broadReasons, ['unknownPath']);
    assert.deepEqual(decision.unknownPaths.map(unknownPathShapes(catalog, walked, normalize)), [expected]);
    // Before any walk records its files, no shape can be told.
    assert.deepEqual(decision.unknownPaths.map(unknownPathShapes(catalog, null, normalize)), ['unclassified']);
  },
);

test('an unknown path names only the transcript extension, so a file name never becomes a capture key', () => {
  assert.equal(unknownPathExtension('C:\\Users\\Greg\\Rollout.JSONL'), '.jsonl');
  assert.equal(unknownPathExtension('/home/greg/lock.session-123'), 'other');
  assert.equal(unknownPathExtension('/home/greg/no-extension'), 'other');
});

// Directory stats keyed by path, with each directory's modification time set by the test.
function directoryTimes(entries: [string, number | null][]) {
  const times = new Map(entries);
  const stated: string[] = [];
  const statOf = async (directory: string) => {
    stated.push(directory);
    const time = times.get(directory);
    return time === undefined || time === null ? null : { mtimeMs: time, print: String(time) };
  };
  return { times, stated, statOf };
}

test('the poll walks for a listing directory that moved since the last walk started, or a due backstop', async () => {
  const { times, statOf } = directoryTimes([
    ['projects', 900],
    ['projects/repo', 900],
    ['projects/repo/s1/subagents', 900],
    ['projects/repo/s2/subagents', null],
  ]);
  const gate = new PollDirectoryGate(statOf);
  const directories = {
    listing: ['projects', 'projects/repo'],
    children: ['projects/repo/s1/subagents', 'projects/repo/s2/subagents'],
  };
  let walk = { generation: 1, startedAt: 1_000, pendingSince: null as number | null };
  let now = 1_000;
  const decide = () =>
    gate.decide(
      directories,
      () => walk,
      () => now,
    );
  assert.deepEqual(
    await gate.decide(
      null,
      () => walk,
      () => now,
    ),
    { kind: 'walk', cause: 'noListing' },
  );
  now = 5_000;
  assert.deepEqual(await decide(), { kind: 'reuse' }, 'a directory the walk read before it changed walked again');
  assert.equal(gate.stats, 4);
  // A directory that appears, or changes, moves.
  times.set('projects/repo/s2/subagents', 6_000);
  now = 10_000;
  assert.deepEqual(await decide(), { kind: 'children', directories: ['projects/repo/s2/subagents'] });
  times.set('projects/repo', 11_000);
  times.set('projects/repo/s1/subagents', 11_000);
  now = 15_000;
  assert.deepEqual(await decide(), { kind: 'walk', cause: 'directory' });
  // The walk that follows listed both changes, so the next poll compares with its start and does not walk again.
  walk = { generation: 2, startedAt: 16_000, pendingSince: null };
  now = 20_000;
  assert.deepEqual(await decide(), { kind: 'reuse' }, 'a change the last walk listed walked again');
  // A change after the walk started and before the gate's first stat since that walk still moves.
  walk = { generation: 3, startedAt: 21_000, pendingSince: null };
  times.set('projects', 22_000);
  now = 25_000;
  assert.deepEqual(await decide(), { kind: 'walk', cause: 'directory' }, 'a change before the first stat waited');
  now = 21_000 + POLL_BACKSTOP_WALK_MS;
  assert.deepEqual(await decide(), { kind: 'walk', cause: 'backstop' });
  // A walk that is still running holds the backstop.
  walk = { ...walk, pendingSince: now - 1_000 };
  assert.deepEqual(await decide(), { kind: 'reuse' }, 'the backstop queued a walk behind a running walk');
});

test('a poll whose stats outlast a walk or a stop decides nothing from them', async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let time = 900;
  const gate = new PollDirectoryGate(async () => {
    await held;
    return { mtimeMs: time, print: String(time) };
  });
  const directories = { listing: ['projects'], children: [] };
  let walk = { generation: 1, startedAt: 1_000, pendingSince: null as number | null };
  const now = () => 1_000 + POLL_BACKSTOP_WALK_MS;
  const raced = gate.decide(directories, () => walk, now);
  walk = { generation: 2, startedAt: now(), pendingSince: null };
  release();
  assert.deepEqual(await raced, { kind: 'reuse' }, 'a poll asked for a backstop walk behind a walk that just ran');
  // Stats that arrive after a stop hold nothing, so the next poll compares with the walk again.
  const stopped = new PollDirectoryGate(async () => ({ mtimeMs: time, print: String(time) }));
  const pending = stopped.decide(directories, () => walk, now);
  stopped.clear();
  assert.deepEqual(await pending, { kind: 'reuse' });
  time = now() + 1;
  assert.deepEqual(await stopped.decide(directories, () => walk, now), { kind: 'walk', cause: 'directory' });
});

test('a poll stats at most the limit and reaches every directory in rotation', async () => {
  for (const [listingCount, childCount] of [
    [2, 25],
    [14, 6],
  ]) {
    const listing = Array.from({ length: listingCount }, (_, index) => `p${index}`);
    const children = Array.from({ length: childCount }, (_, index) => `s${index}/subagents`);
    const { times, stated, statOf } = directoryTimes([...listing, ...children].map((directory) => [directory, 900]));
    const gate = new PollDirectoryGate(statOf, 12);
    const directories = { listing, children };
    const walk = () => ({ generation: 1, startedAt: 1_000, pendingSince: null });
    const now = () => 5_000;
    for (let poll = 0; poll < 3; poll++) {
      assert.deepEqual(await gate.decide(directories, walk, now), { kind: 'reuse' });
      assert.ok(gate.stats <= 12, `a poll stated ${gate.stats} directories`);
    }
    assert.equal(new Set(stated).size, listingCount + childCount, 'a directory was never stated');
    times.set(children.at(-1)!, 6_000);
    const moved: string[] = [];
    for (let poll = 0; poll < 3; poll++) {
      const decision = await gate.decide(directories, walk, now);
      if (decision.kind === 'children') moved.push(...decision.directories);
    }
    assert.deepEqual(moved, [children.at(-1)], 'a rotated directory never reported its move');
  }
});

test('merged requests keep the files that reusing requests name', () => {
  const request = (reuseCatalog: boolean, changedPaths: string[] | null): RefreshRequest => ({
    reason: 'r',
    force: false,
    reuseCatalog,
    metadataAfterRender: false,
    changedPaths,
  });
  assert.deepEqual(mergeRefreshRequests(request(true, ['a']), request(true, null)).changedPaths, ['a']);
  assert.deepEqual(mergeRefreshRequests(request(true, ['a']), request(false, ['b'])).changedPaths, ['a', 'b']);
  assert.equal(mergeRefreshRequests(request(true, ['a']), request(false, null)).changedPaths, null);
});
