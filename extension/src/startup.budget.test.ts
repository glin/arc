// @module-tag subprocess
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeAll, test, vi } from 'vitest';
import {
  initializeBudgetHost,
  workspace,
  replaceWorkspace,
  modules,
  paddedRoot,
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
import { tempDir } from './temproot.ts';

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

// Serves `activate` from a fresh workspace and returns the step that restores the shared one.
async function useWorkspace(prefix: string) {
  const { budgetWorkspace } = await import('./budgetworkspace.ts');
  const environment = ['ARC_HOME', 'ARC_PROJECTS_ROOT', 'ARC_CODEX_ROOT'];
  const savedEnvironment = environment.map((name) => process.env[name]);
  const next = budgetWorkspace(paddedRoot(tempDir(prefix)));
  const saved = replaceWorkspace(next);
  vi.stubEnv('ARC_HOME', next.home);
  vi.stubEnv('ARC_PROJECTS_ROOT', next.projects);
  vi.stubEnv('ARC_CODEX_ROOT', next.codexSessions);
  return {
    workspace: next,
    restore() {
      replaceWorkspace(saved);
      environment.forEach((name, index) => vi.stubEnv(name, savedEnvironment[index]));
    },
  };
}

test('discovery reaches a settled list while listed sessions gain turns', async () => {
  const { workspace, restore } = await useWorkspace('discovery-writes-');
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(modules.BUDGET_CLOCK);
  const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation((() => 0) as unknown as typeof setInterval);
  const active = activate({ stubReadPasses: true });
  const { provider, worker } = active;
  const send = worker.run.bind(worker);
  let fullRequests = 0;
  let completeReplies = 0;
  const replies: string[] = [];
  worker.run = async (request: any, ...rest: any[]) => {
    if (request.kind === 'claude-children' && !request.spendOnly) fullRequests++;
    const result = await send(
      request.kind === 'claude-children' && !request.spendOnly ? { ...request, quantumBytes: 64 * 1024 } : request,
      ...rest,
    );
    if (request.kind === 'claude-children') {
      replies.push(result?.value.kind ?? 'missing');
      if (result?.value.kind === 'claude-children') completeReplies++;
    }
    return result;
  };
  const trace: object[] = [];
  const writers = [workspace.parents[3], workspace.parents[4], workspace.dispatches[0].target];
  const quiet = () =>
    completeReplies > 0 &&
    !provider.dispatchDiscoveryPending &&
    !provider.dispatchSpendPending &&
    !provider.refreshController &&
    !provider.pendingRefresh;
  try {
    void active.receive({ type: 'ready' });
    for (let step = 0; step < 128; step++) {
      await Promise.all(active.started.splice(0));
      if (step > 0) {
        for (const source of writers) {
          workspace.growSource(source, Date.now());
          provider.pendingWatch.noteFileEvent(
            path.dirname(source.file),
            path.basename(source.file),
            'change',
            modules.normalizeFsPath,
          );
        }
        provider.runPendingWatch({ cause: 'quiet', firstAt: Date.now(), lastAt: Date.now(), firedAt: Date.now() });
      }
      vi.advanceTimersByTime(1000);
      await Promise.all(active.started.splice(0));
      trace.push({
        step,
        fullRequests,
        completeReplies,
        members: provider.dispatchDiscoveryPending,
        spend: provider.dispatchSpendPending,
        writer: provider.dispatchDiscoveryPendingWriter,
      });
      if (quiet() && completeReplies > 1) break;
    }
    assert.ok(
      quiet(),
      `discovery never settles while listed sessions gain turns: ${JSON.stringify({ trace, replies })}`,
    );
    assert.ok(fullRequests <= 18, `discovery takes ${fullRequests} full requests`);
    assert.equal(provider.authoritativeCatalog.length, 120);
    assert.equal(provider.claudeChildReferences.filter((reference: any) => reference.kind === 'dispatch').length, 6);
  } finally {
    provider.dispose();
    worker.stop();
    interval.mockRestore();
    vi.useRealTimers();
    restore();
  }
});

test.each([
  [32, 120],
  [64, 120],
  [128, 120],
  [32, 240],
  [32, 2],
])('a native write takes at most two host requests with %i receipt blocks and %i sessions', async (blocks, listed) => {
  const { workspace, restore } = await useWorkspace('discovery-pass-');
  const { receiptDispatchFixture } = await import('./turnfixtures.ts');
  const extra = receiptDispatchFixture(workspace.root, 'claude', 'codex');
  for (let index = 0; index < blocks; index++)
    extra.launch(
      { ...extra.parent, sessionId: 'eeeeeeee-1111-2222-3333-444444444444' },
      extra.child,
      true,
      false,
      36 * 1024,
    );
  // These sources sit outside the workspace folders and supply receipt bytes alone.
  for (const source of extra.catalog) fs.unlinkSync(source.file);
  if (listed === 2) {
    for (const source of [...workspace.parents.slice(1), ...workspace.children, ...workspace.rollouts.slice(1)])
      fs.unlinkSync(source.file);
  }
  for (let index = 120; index < listed; index++) {
    const original = workspace.parents[index % workspace.parents.length];
    const id = `ffffffff-${index.toString(16).padStart(4, '0')}-4000-8000-000000000000`;
    const file = path.join(path.dirname(original.file), `${id}.jsonl`);
    const records = fs
      .readFileSync(original.file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    records[0].sessionId = id;
    records[0].uuid = id;
    fs.writeFileSync(file, JSON.stringify(records[0]) + '\n' + JSON.stringify(records.at(-1)) + '\n');
    fs.utimesSync(file, new Date(modules.BUDGET_CLOCK), new Date(modules.BUDGET_CLOCK));
  }
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(modules.BUDGET_CLOCK);
  const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation((() => 0) as unknown as typeof setInterval);
  const active = activate({ stubReadPasses: true });
  const { provider, worker } = active;
  const send = worker.run.bind(worker);
  let requests = 0;
  let receiptBytes = 0;
  let receiptSlices = 0;
  let transcriptSlices = 0;
  let publishedBeforeComplete = false;
  worker.run = async (request: any, ...rest: any[]) => {
    const full = request.kind === 'claude-children' && !request.spendOnly;
    if (full && provider.dispatchDiscoveryPending && provider.authoritativeCatalog?.length)
      publishedBeforeComplete = true;
    if (full) requests++;
    const result = await send(
      full ? { ...request, discoveryBytes: 32 * 1024, quantumBytes: 32 * 1024 } : request,
      ...rest,
    );
    if (full) {
      receiptBytes += result?.value.charges?.receiptBytes ?? 0;
      receiptSlices += result?.value.charges?.receiptPassEnds ?? 0;
      transcriptSlices += result?.value.charges?.transcriptPassEnds ?? 0;
    }
    return result;
  };
  try {
    void active.receive({ type: 'ready' });
    await active.settle();
    assert.equal(provider.authoritativeCatalog.length, listed);
    assert.equal(provider.dispatchDiscoveryPending, false);
    assert.equal(publishedBeforeComplete, true, 'the first sessions wait for the full pass');
    if (listed === 2) assert.equal(transcriptSlices, 0, 'the cold-start fixture ends a request on transcripts');
    requests = receiptBytes = receiptSlices = 0;
    provider.settledDiscovery = undefined;
    provider.refreshFrom('transcript', true, false, null);
    await active.settle();
    const unchanged = requests;
    requests = receiptBytes = receiptSlices = 0;
    const native = workspace.parents[listed === 2 ? 0 : 20];
    vi.advanceTimersByTime(1000);
    workspace.growSource(native, Date.now());
    provider.pendingWatch.noteFileEvent(
      path.dirname(native.file),
      path.basename(native.file),
      'change',
      modules.normalizeFsPath,
    );
    provider.runPendingWatch({ cause: 'quiet', firstAt: Date.now(), lastAt: Date.now(), firedAt: Date.now() });
    await active.settle();
    assert.ok(receiptBytes >= 20 * 32 * 1024, 'the receipt scan fits fewer than twenty byte slices');
    assert.equal(provider.authoritativeCatalog.length, listed);
    assert.equal(provider.dispatchDiscoveryPending, false);
    assert.ok(requests <= 2, `one native write takes ${requests} host requests`);
    assert.ok(unchanged <= 2, `unchanged inputs take ${unchanged} host requests`);
    if (blocks === 32 && listed === 120) {
      const sources = [workspace.parents[20], workspace.rollouts[10]].map((original, index) => {
        const sessionId = `${index ? 'dddddddd' : 'cccccccc'}-aaaa-4000-8000-000000000000`;
        const file = path.join(
          path.dirname(original.file),
          original.agent === 'codex' ? `rollout-${sessionId}.jsonl` : `${sessionId}.jsonl`,
        );
        fs.writeFileSync(file, fs.readFileSync(original.file, 'utf8').replaceAll(original.sessionId, sessionId));
        fs.utimesSync(file, new Date(Date.now()), new Date(Date.now()));
        return { ...original, sessionId, file };
      });
      const [native, child] = sources;
      const { payloadSha256 } = await import('./sessionwrites.ts');
      const { launchId } = extra.receipts.reserve({
        origin: 'a'.repeat(24),
        requester: { provider: native.agent, id: native.sessionId },
        policy: null,
        promptSha256: payloadSha256('Review the assigned work.'),
        completion: 'manual',
        alias: null,
        transport: 'standalone',
        standalone: {
          provider: child.agent,
          command: child.agent,
          args: [],
          cwd: child.cwd,
          model: 'test',
          effort: 'high',
          name: 'Review',
          agentRun: true,
          background: false,
          env: {},
          sessionHint: null,
          logAlias: null,
          deadlineMs: 1000,
        },
      });
      const bytes = fs.readFileSync(child.file);
      const opening = bytes.subarray(0, bytes.indexOf(10) + 1);
      const stat = fs.statSync(child.file, { bigint: true });
      const ancestor = path.dirname(child.file);
      const directory = fs.statSync(ancestor, { bigint: true });
      extra.receipts.startup(launchId, {
        file: child.file,
        identity: `${stat.dev}:${stat.ino}`,
        ancestor,
        directory: `${directory.dev}:${directory.ino}`,
        cwd: fs.realpathSync.native(child.cwd),
        bytes: opening.length,
        sha256: payloadSha256(opening.toString()),
      });
      extra.receipts.standaloneSession(launchId, child.sessionId);
      provider.refreshFrom('transcript', true, false, null);
      await active.settle();
      assert.ok(provider.authoritativeCatalog.some((row: any) => row.sessionId === native.sessionId));
      assert.ok(provider.authoritativeCatalog.some((row: any) => row.sessionId === child.sessionId));
      assert.ok(
        provider.claudeChildReferences.some(
          (row: any) => row.sessionId === child.sessionId && row.parentSessionId === native.sessionId,
        ),
      );
    }
  } finally {
    provider.dispose();
    worker.stop();
    interval.mockRestore();
    vi.useRealTimers();
    restore();
  }
});
