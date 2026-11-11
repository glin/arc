// @module-tag subprocess
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeAll, test, vi } from 'vitest';
import {
  initializeBudgetHost,
  workspace,
  modules,
  paddedRootPath,
  serializedBytes,
  ROOT_BYTES,
  workerTemporaryEnvironment,
  counts,
  difference,
  outsideBudget,
  activate,
  CHECKPOINT_WAIT_MS,
  BUDGET_FILE,
} from '../test/budgethostfixture.ts';
import type { Counts } from '../test/budgethostfixture.ts';

beforeAll(() => initializeBudgetHost());

test('a temporary root takes one serialized byte length on each platform', () => {
  const branches = [
    { paths: path.win32, base: 'C:\\Temp\\run' },
    { paths: path.posix, base: '/private/var/folders/run' },
    { paths: path.posix, base: '/tmp/run' },
  ];
  for (const { paths, base } of branches)
    for (const real of [base, `${base}é漢`, paths.join(base, 'deeper', 'still')])
      assert.equal(serializedBytes(paddedRootPath(real, paths)), ROOT_BYTES, real);
});

test('the worker stops its receipt walk at the real temporary directory on macOS', async () => {
  const { safeDispatchPath } = await import('./dispatchreceipts.ts');
  const unresolved = '/var/folders/ab/T';
  const resolved = `/private${unresolved}`;
  const environment = workerTemporaryEnvironment(unresolved, (file) => (file === unresolved ? resolved : file));
  const saved = Object.keys(environment).map((name) => [name, process.env[name]] as const);
  Object.assign(process.env, environment);
  try {
    // The walk makes no file check at its boundary, so it returns for a path that exists on no host.
    assert.doesNotThrow(() => safeDispatchPath(resolved, 'darwin'));
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('each step of the session list script stays within its recorded counts', async () => {
  const { normalizeFsPath, POLL_BACKSTOP_WALK_MS, BUDGET_CLOCK } = modules;
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(BUDGET_CLOCK);
  const intervals: Array<() => void> = [];
  const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
    intervals.push(callback);
    return 0;
  }) as typeof setInterval);
  const measured: Record<string, Counts> = {};
  let active = activate({ stubReadPasses: true });
  let before: Counts = {};
  const step = async (name: string, act: () => void | Promise<void>) => {
    await act();
    await active.settle();
    const after = counts(active.provider.performanceCounters, active.posts);
    measured[name] = difference(after, before);
    before = after;
  };
  const watcherEvent = (file: string) => {
    active.provider.pendingWatch.noteFileEvent(path.dirname(file), path.basename(file), 'change', normalizeFsPath);
    active.provider.runPendingWatch({ cause: 'quiet', firstAt: 0, lastAt: 0, firedAt: 0 });
  };
  try {
    await step('cold start', () => void active.receive({ type: 'ready' }));
    // Only the host's own checkpoint writes the cache here. A host that stops after a checkpoint keeps what that checkpoint saved.
    await step('automatic save', async () => {
      const child = workspace.children[3];
      workspace.growSource(child, Date.now());
      watcherEvent(child.file);
      await active.settle();
      vi.advanceTimersByTime(CHECKPOINT_WAIT_MS);
    });
    assert.ok(fs.existsSync(workspace.derivedCacheFile), 'the automatic save never wrote the derived cache');
    // A grown parent that the panel selects takes a prompt scan and changes nothing else that the cache saves. The warm start
    // finds that scan only if the scan marked the cache dirty before this second save.
    await step('prompt scan save', async () => {
      const parent = workspace.parents[20];
      workspace.growSource(parent, Date.now());
      void active.receive({ type: 'showSession', session: parent.sessionId });
      await active.settle();
      vi.advanceTimersByTime(CHECKPOINT_WAIT_MS);
    });
    active.provider.writeDerivedCache = () => true;
    active.provider.dispose();
    active.worker.stop();
    intervals.length = 0;
    active = activate({ stubReadPasses: false });
    before = {};
    await step('warm start', () => void active.receive({ type: 'ready' }));
    await step('completion', () => {
      workspace.completeRunningRollout(Date.now());
      watcherEvent(workspace.runningRollout.file);
    });
    await step('child watcher event', () => {
      const child = workspace.children[7];
      workspace.growSource(child, Date.now());
      watcherEvent(child.file);
    });
    await step(
      'selection switch',
      () => void active.receive({ type: 'showSession', session: workspace.parents[50].sessionId }),
    );
    await step('session list update', () => void active.receive({ type: 'setRailFilters', railFilters: [] }));
    await step(
      'repeated record coverage',
      () => void active.provider.repeatedCoverage(workspace.parents[60].file, 'worker'),
    );
    await step('enrichment stale file', () => {
      const file = workspace.parents[61].file;
      const enrichment = active.provider.prepareRailEnrichment;
      let answered = false;
      active.provider.prepareRailEnrichment = async (...args: unknown[]) => {
        if (answered) return enrichment.apply(active.provider, args);
        answered = true;
        return { changed: true, progress: false, stale: [file] };
      };
      active.provider.refreshFrom('enrichment', true, true, null);
    });
    const poll = intervals.find((callback) => callback.toString().includes('pollCatalog'));
    assert.ok(poll, 'polling never started');
    await step('poll and backstop walk', async () => {
      vi.setSystemTime(Date.now() + 5_000);
      poll();
      await active.settle();
      vi.setSystemTime(Date.now() + POLL_BACKSTOP_WALK_MS);
      poll();
    });
    await step('collision walk', async () => {
      workspace.addCollisions(Date.now());
      vi.setSystemTime(Date.now() + POLL_BACKSTOP_WALK_MS);
      poll();
      await active.settle();
      vi.setSystemTime(Date.now() + POLL_BACKSTOP_WALK_MS);
      poll();
    });
  } finally {
    active.provider.dispose();
    active.worker.stop();
    interval.mockRestore();
    vi.useRealTimers();
  }
  const failures = outsideBudget(measured, JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8')).rows);
  assert.equal(failures.length, 0, failures.join('\n'));
});
