// @module-tag subprocess
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildSync } from 'esbuild';
import { beforeAll, test, vi } from 'vitest';
import { tempDir } from './temproot.ts';
import type { BudgetWorkspace } from './budgetworkspace';

vi.stubGlobal('PANEL_CSS', '');
vi.stubGlobal('PANEL_JS', '');
vi.stubGlobal('PANEL_DEV_SERVER_URL', null);

// The budget table. A row limits one counter in one step of the script below.
const BUDGET_FILE = path.join(__dirname, '..', '..', 'scripts', 'test-budget.json');
const FILE_CAP_MS = 5_000;
const COUNTER_PREFIXES = [
  'openingsRead:',
  'discoveryRequest:',
  'walk:requested:',
  'renderPost:',
  'railPostRows:',
  'humanPromptStat:',
  'cachedLinks:',
  'watcher:grownMemberMiss:',
];
// Bytes depend on the platform's path separators, so these counters may fall below budget without a change in the work.
const ONE_SIDED = new Set(['readBytes']);

type Counts = Record<string, number>;
interface BudgetRow {
  reason: string;
  budget: number;
  margin: number;
}
let modules: {
  PanelProvider: any;
  ProgressiveWorker: any;
  CommitRepositories: any;
  RepositoryCommits: any;
  normalizeFsPath: (file: string) => string;
  POLL_BACKSTOP_WALK_MS: number;
  BUDGET_CLOCK: number;
};
let workspace: BudgetWorkspace;
let workerSource: string;

beforeAll(async () => {
  const root = tempDir('count-budget-');
  vi.stubEnv('ARC_HOME', path.join(root, 'arc'));
  vi.stubEnv('ARC_PROJECTS_ROOT', path.join(root, 'projects'));
  vi.stubEnv('ARC_CODEX_ROOT', path.join(root, 'sessions'));
  const [{ budgetWorkspace, BUDGET_CLOCK }, host, worker, commits, repository, transcript, scheduler] =
    await Promise.all([
      import('./budgetworkspace.ts'),
      import('./panelhost.ts'),
      import('./progressiveworker.ts'),
      import('./commitrepositories.ts'),
      import('./gitcommits.ts'),
      import('./transcript.ts'),
      import('./scheduler.ts'),
    ]);
  modules = {
    PanelProvider: host.PanelProvider,
    ProgressiveWorker: worker.ProgressiveWorker,
    CommitRepositories: commits.CommitRepositories,
    RepositoryCommits: repository.RepositoryCommits,
    normalizeFsPath: transcript.normalizeFsPath,
    POLL_BACKSTOP_WALK_MS: scheduler.POLL_BACKSTOP_WALK_MS,
    BUDGET_CLOCK,
  };
  workspace = budgetWorkspace(root);
  const bundle = buildSync({
    entryPoints: [path.join(__dirname, 'progressiveworker-entry.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    write: false,
  }).outputFiles[0].text;
  // A frozen worker clock keeps every pass inside its deadlines, so one pass reads the same files on every run.
  workerSource = `performance.now=()=>0;process.env.ARC_HOME=${JSON.stringify(workspace.home)};${bundle}`;
}, FILE_CAP_MS);

function counts(counters: { snapshot(): any }): Counts {
  const snapshot = counters.snapshot();
  const row: Counts = {};
  for (const [name, count] of Object.entries<number>(snapshot.work))
    if (name === 'catalogWalk' || COUNTER_PREFIXES.some((prefix) => name.startsWith(prefix))) row[name] = count;
  for (const [name, entry] of Object.entries<{ count: number }>(snapshot.refreshes))
    if (name === 'catalog-enumeration' || name.startsWith('catalog-enumeration:'))
      row[`refreshCount:${name}`] = entry.count;
  for (const name of ['readBytes', 'receiptScanOpensAfterCompletion', 'dispatchSpendVisits'])
    if (snapshot.discovery[name] !== undefined) row[name] = snapshot.discovery[name];
  return row;
}

function difference(after: Counts, before: Counts): Counts {
  const row: Counts = {};
  for (const name of new Set([...Object.keys(after), ...Object.keys(before)]))
    row[name] = (after[name] ?? 0) - (before[name] ?? 0);
  return row;
}

// Names each counter that differs from its row, each nonzero counter with no row, and each row that no step measures. A
// counter with no record in one step reads 0, so a row of 0 needs that counter reported by some other step.
function outsideBudget(measured: Record<string, Counts>, rows: Record<string, BudgetRow>): string[] {
  const failures: string[] = [];
  const reported = new Set(Object.values(measured).flatMap((row) => Object.keys(row)));
  for (const [key, budget] of Object.entries(rows)) {
    const [step, counter] = key.split(' | ');
    if (measured[step]?.[counter] !== undefined || (budget.budget === 0 && reported.has(counter))) continue;
    failures.push(
      `Step "${step}", counter ${counter}: not measured, recorded budget ${budget.budget}. The step or the counter was renamed or removed. Rename the row in scripts/test-budget.json with the code, or find the cause.`,
    );
  }
  for (const [step, row] of Object.entries(measured)) {
    for (const [counter, count] of Object.entries(row)) {
      const budget = rows[`${step} | ${counter}`];
      if (!budget) {
        if (count !== 0)
          failures.push(
            `Step "${step}", counter ${counter}: measured ${count}, with no budget row. If the work is intended, add a row to scripts/test-budget.json with a reason.`,
          );
        continue;
      }
      const high = count > budget.budget + budget.margin;
      const low = !ONE_SIDED.has(counter) && count < budget.budget - budget.margin;
      if (high || low)
        failures.push(
          `Step "${step}", counter ${counter}: measured ${count}, recorded budget ${budget.budget} with margin ${budget.margin}. The count ${high ? 'rose' : 'fell'}. If the change is intended, ${high ? 'raise' : 'lower'} the row in scripts/test-budget.json with a reason.`,
        );
    }
  }
  return failures;
}

// One activation of the panel host. The host, its worker and its counters are real. The test owns the clock, the panel and
// the watcher events.
function activate() {
  const { PanelProvider, ProgressiveWorker, CommitRepositories, RepositoryCommits } = modules;
  vi.spyOn(PanelProvider.prototype, 'wireEditorListeners').mockImplementation(() => {});
  vi.spyOn(PanelProvider.prototype, 'createRepositoryScope').mockImplementation(() => ({
    snapshot: (folders: string[]) => ({ ready: true, revision: 1, roots: folders }),
    checkoutSnapshot: () => [],
    dispose() {},
  }));
  const provider = new PanelProvider(
    workspace.home,
    { fsPath: workspace.root },
    undefined,
    undefined,
    workspace.derivedCacheFile,
    workspace.codexOpeningsFile,
    undefined,
    { appendLine() {}, dispose() {} },
  ) as Record<string, any>;
  const worker = new ProgressiveWorker(
    workerSource,
    () => false,
    (file: string) => provider.repeatedCoverage(file, 'worker'),
    undefined,
    (sample: unknown) => provider.performanceCounters.recordDiscoveryTransport?.(sample),
  );
  const noGit = { run: async () => null };
  Object.assign(provider, {
    progressiveWorker: worker,
    commitRepositories: new CommitRepositories(noGit, () => {}),
    repositoryCommits: new RepositoryCommits(noGit, () => {}),
    folders: () => workspace.folders,
    notePanelStart() {},
    allowThemeFiles() {},
    shell: () => '',
    releaseQueuedEditOffer() {},
    closeBrowserStagingForHost() {},
    watchDirectories() {},
    prepareMetadata: async () => true,
    prepareRailEnrichment: async () => ({ changed: false, progress: false, stale: [] }),
  });
  const started: Promise<unknown>[] = [];
  for (const method of ['refresh', 'continueDiscovery', 'pollCatalog', 'refineDispatchedSpend']) {
    const original = provider[method];
    provider[method] = (...args: unknown[]) => {
      const run = original.apply(provider, args);
      started.push(run);
      return run;
    };
  }
  let receive: (message: unknown) => unknown = () => assert.fail('the panel never attached');
  const disposable = { dispose() {} };
  provider.attach({
    active: () => true,
    visible: () => true,
    webview: {
      html: '',
      cspSource: '',
      options: {},
      asWebviewUri: (uri: unknown) => uri,
      postMessage: () => Promise.resolve(true),
      onDidReceiveMessage: (listener: typeof receive) => {
        receive = listener;
        return disposable;
      },
    },
    onDidChangeVisibility: () => disposable,
    onDidDispose: () => disposable,
  });
  // Waits for the host to go idle, then moves the clock a fixed distance, so every timer fires at one point of the script.
  const settle = async () => {
    const stepMs = 200;
    for (let advanced = 0, turns = 0; advanced < 10; turns++) {
      assert.ok(turns < 200_000, 'the host never went idle');
      await new Promise((resolve) => setImmediate(resolve));
      if (started.length) {
        await Promise.all(started.splice(0));
        continue;
      }
      const state = worker.snapshot();
      if (state.pendingCount || state.active.length || provider.refreshController || provider.pendingRefresh) continue;
      if (provider.codexPriming || provider.pollInFlight) continue;
      vi.advanceTimersByTime(stepMs);
      // Discovery can take many passes, and each pass waits on one zero-length timer. Only quiet time counts.
      if (!provider.dispatchDiscoveryPending && !provider.dispatchSpendPending) advanced++;
    }
  };
  return { provider, worker, settle, receive: (message: unknown) => receive(message) };
}

test('each step of the session list script stays within its recorded counts', { timeout: FILE_CAP_MS }, async () => {
  const { normalizeFsPath, POLL_BACKSTOP_WALK_MS, BUDGET_CLOCK } = modules;
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(BUDGET_CLOCK);
  const intervals: Array<() => void> = [];
  const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
    intervals.push(callback);
    return 0;
  }) as typeof setInterval);
  const measured: Record<string, Counts> = {};
  let active = activate();
  let before: Counts = {};
  const step = async (name: string, act: () => void | Promise<void>) => {
    await act();
    await active.settle();
    const after = counts(active.provider.performanceCounters);
    measured[name] = difference(after, before);
    before = after;
  };
  const watcherEvent = (file: string) => {
    active.provider.pendingWatch.noteFileEvent(path.dirname(file), path.basename(file), 'change', normalizeFsPath);
    active.provider.runPendingWatch({ cause: 'quiet', firstAt: 0, lastAt: 0, firedAt: 0 });
  };
  try {
    await step('cold start', () => void active.receive({ type: 'ready' }));
    assert.equal(active.provider.writeDerivedCache(), true, 'the cold start saved no derived cache');
    active.provider.dispose();
    active.worker.stop();
    intervals.length = 0;
    active = activate();
    before = {};
    await step('warm start', () => void active.receive({ type: 'ready' }));
    await step('completion', () => {
      workspace.completeRunningRollout(Date.now());
      watcherEvent(workspace.runningRollout.file);
    });
    await step('child watcher event', () => {
      const child = workspace.children[7];
      workspace.growChild(child, Date.now());
      watcherEvent(child.file);
    });
    await step(
      'selection switch',
      () => void active.receive({ type: 'showSession', session: workspace.parents[50].sessionId }),
    );
    const poll = intervals.find((callback) => callback.toString().includes('pollCatalog'));
    assert.ok(poll, 'polling never started');
    await step('poll and backstop walk', async () => {
      vi.setSystemTime(Date.now() + 5_000);
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
