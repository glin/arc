import assert from 'node:assert/strict';
import { Session } from 'node:inspector/promises';
import { SourceMap } from 'node:module';
import { setFlagsFromString } from 'node:v8';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildSync } from 'esbuild';
import { afterAll, vi } from 'vitest';
import { tempDir } from '../src/temproot.ts';
import type { BudgetWorkspace } from '../src/budgetworkspace';

vi.stubGlobal('PANEL_CSS', '');
vi.stubGlobal('PANEL_JS', '');
vi.stubGlobal('PANEL_DEV_SERVER_URL', null);

// The budget table. A row limits one counter in one step of the script below.
const BUDGET_FILE = path.join(__dirname, '..', '..', 'scripts', 'test-budget.json');
const HOST_WORK_FILE = path.join(path.dirname(BUDGET_FILE), 'test-budget-host-work.json');
const budgetEnvironment = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8')).hostWorkEnvironment;
const coverageEnabled = (
  globalThis as typeof globalThis & {
    __vitest_worker__: { config: { coverage: { enabled: boolean } } };
  }
).__vitest_worker__.config.coverage.enabled;
const hostWorkSkip = coverageEnabled
  ? 'Host work counts require exclusive V8 coverage. Vitest coverage is enabled.'
  : process.platform !== budgetEnvironment.platform ||
      Number(process.versions.node.split('.')[0]) !== budgetEnvironment.nodeMajor
    ? `Host work rows require ${budgetEnvironment.platform} with Node ${budgetEnvironment.nodeMajor}. This run uses ${process.platform} with Node ${process.versions.node.split('.')[0]}.`
    : undefined;
const COUNTER_PREFIXES = [
  'openingsRead:',
  'discoveryRequest:',
  'walk:requested:',
  'renderPost:',
  'railPostRows:',
  'humanPromptStat:',
  'cachedLinks:',
  'watcher:grownMemberMiss:',
  'selection:',
];
// Bytes depend on the platform's path separators, so these counters can fall below budget without a change in the work.
const ONE_SIDED = new Set(['readBytes', 'dispatchSpendBytes']);
// Counts of host work with one exact name each.
const WORK_NAMES = new Set(['catalogWalk', 'watcher:grownMembers', 'pollDirectoryStats', 'childVersionStat']);

// Byte rows count paths and working directories in JSON, so a root of one serialized length keeps those bytes the same
// under any temporary directory.
const ROOT_BYTES = 160;
// Longer than the host's checkpoint interval, so the timer the host armed fires inside this wait.
const CHECKPOINT_WAIT_MS = 10 * 60 * 1000;

function serializedBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text)) - 2;
}

// Each padding character adds one byte, so the padding removes what a separator or a non-ASCII character adds.
function paddedRootPath(real: string, paths: Pick<path.PlatformPath, 'join'>): string {
  const start = paths.join(real, 'p');
  assert.ok(
    serializedBytes(start) <= ROOT_BYTES,
    `The temporary directory ${real} leaves no room to pad. Use a shorter TEMP.`,
  );
  return start + 'p'.repeat(ROOT_BYTES - serializedBytes(start));
}

function paddedRoot(base: string): string {
  const root = paddedRootPath(fs.realpathSync.native(base), path);
  fs.mkdirSync(root);
  return root;
}

// The worker's receipt walk stops at the temporary directory, and the fixture root is a real path. The worker takes the
// real spelling of that directory, so the walk stops at one level on every platform.
function workerTemporaryEnvironment(directory: string, real: (file: string) => string): Record<string, string> {
  const boundary = real(directory);
  return { TMPDIR: boundary, TMP: boundary, TEMP: boundary };
}

// The discovery charges of each step: reads, scans, and spend reads inside one root.
const DISCOVERY_NAMES = [
  'readBytes',
  'receiptScanOpensAfterCompletion',
  'receiptScanOpens',
  'receiptEntries',
  'receiptChecks',
  'parentChecks',
  'unsettledParentChanges',
  'dispatchSpendVisits',
  'dispatchSpendBytes',
  'dispatchSpendFiles',
  'dispatchSpendRereads',
  'dispatchSpendRootRestarts',
];

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
let workerSource: (home: string) => string;
const coverageSession = new Session();
let coverageStarted = false;

export async function initializeBudgetHost(coverage = false) {
  if (coverage && !hostWorkSkip) {
    // Interpreter execution keeps precise block counts independent of compiler tiers and feedback allocation.
    setFlagsFromString('--no-opt --no-maglev --no-sparkplug --no-lazy-feedback-allocation');
    // Coverage starts before product bytecode compiles, including when another case runs first.
    coverageStarted = true;
    coverageSession.connect();
    await coverageSession.post('Debugger.enable');
    await coverageSession.post('Profiler.enable');
    await coverageSession.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  }
  const root = paddedRoot(tempDir('count-budget-'));
  vi.stubEnv('ARC_HOME', path.join(root, 'arc'));
  vi.stubEnv('ARC_PROJECTS_ROOT', path.join(root, 'projects'));
  vi.stubEnv('ARC_CODEX_ROOT', path.join(root, 'sessions'));
  const [{ budgetWorkspace, BUDGET_CLOCK }, host, worker, commits, repository, transcript, scheduler] =
    await Promise.all([
      import('../src/budgetworkspace.ts'),
      import('../src/panelhost.ts'),
      import('../src/progressiveworker.ts'),
      import('../src/commitrepositories.ts'),
      import('../src/gitcommits.ts'),
      import('../src/transcript.ts'),
      import('../src/scheduler.ts'),
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
    entryPoints: [path.join(__dirname, '..', 'src', 'progressiveworker-entry.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    write: false,
  }).outputFiles[0].text;
  // A frozen worker clock keeps every pass inside its deadlines, so one pass reads the same files on every run. It holds the
  // start of the script, so the open spend band of a recently changed file applies as it does in a real host.
  const temporary = workerTemporaryEnvironment(os.tmpdir(), fs.realpathSync.native);
  workerSource = (home) =>
    `performance.now=()=>0;Date.now=()=>${BUDGET_CLOCK};process.env.ARC_HOME=${JSON.stringify(home)};Object.assign(process.env,${JSON.stringify(temporary)});${bundle}`;
}

afterAll(async () => {
  if (coverageStarted) {
    await coverageSession.post('Profiler.stopPreciseCoverage');
    coverageSession.disconnect();
  }
});

function counts(counters: { snapshot(): any }, posts: Counts): Counts {
  const snapshot = counters.snapshot();
  const row: Counts = { ...posts };
  for (const [name, count] of Object.entries<number>(snapshot.work))
    if (WORK_NAMES.has(name) || COUNTER_PREFIXES.some((prefix) => name.startsWith(prefix))) row[name] = count;
  for (const [name, entry] of Object.entries<{ count: number }>(snapshot.refreshes))
    if (name === 'catalog-enumeration') row[`refreshCount:${name}`] = entry.count;
  for (const name of DISCOVERY_NAMES) if (snapshot.discovery[name] !== undefined) row[name] = snapshot.discovery[name];
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
      `Step "${step}", counter ${counter}: not measured, recorded budget ${budget.budget}. The step or the counter was renamed or removed. If the change is intended, rename or delete the row in scripts/test-budget.json. If the change is not intended, find the cause.`,
    );
  }
  for (const [step, row] of Object.entries(measured)) {
    for (const [counter, count] of Object.entries(row)) {
      const budget = rows[`${step} | ${counter}`];
      if (!budget) {
        if (count !== 0)
          failures.push(
            `Step "${step}", counter ${counter}: measured ${count}, with no budget row. If the work is intended, add a row to scripts/test-budget.json with a reason. If the work is not intended, find the cause.`,
          );
        continue;
      }
      const high = count > budget.budget + budget.margin;
      const low = !ONE_SIDED.has(counter) && count < budget.budget - budget.margin;
      if (high || low)
        failures.push(
          `Step "${step}", counter ${counter}: measured ${count}, recorded budget ${budget.budget} with margin ${budget.margin}. The count ${high ? 'rose' : 'fell'}. The row says: ${budget.reason} If the change is intended, ${high ? 'raise' : 'lower'} the row in scripts/test-budget.json with a reason. If the change is not intended, find the cause.`,
        );
    }
  }
  return failures;
}

// Counts the panel messages that carry rows, so a post that sends more rows than the panel needs moves a row.
function countPost(posts: Counts, message: any): void {
  if (!['render', 'rail', 'selection'].includes(message?.type)) return;
  const add = (name: string, count: number) => (posts[name] = (posts[name] ?? 0) + count);
  add(`posted:${message.type}`, 1);
  if (message.rows) add(`posted:${message.type}:${message.rows.base === null ? 'snapshot' : 'delta'}`, 1);
  add(`posted:${message.type}:rows`, (message.sessions?.length ?? 0) + (message.rail?.length ?? 0));
}

// One activation of the panel host. The host, its worker and its counters are real. The test owns the clock, the panel and
// the watcher events.
function activate(options: { stubReadPasses: boolean; coverage?: boolean }) {
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
    workerSource(workspace.home),
    () => false,
    (file: string) => provider.repeatedCoverage(file, 'worker'),
    undefined,
    (sample: unknown) => provider.performanceCounters.recordDiscoveryTransport?.(sample),
  );
  if (options.coverage) {
    // Worker publications use one order, independent of filesystem receipt enumeration.
    const applyFacts = provider.applyDispatchFacts.bind(provider);
    provider.applyDispatchFacts = (facts: Array<{ sessionId: string }>) =>
      applyFacts([...facts].sort((a, b) => a.sessionId.localeCompare(b.sessionId)));
  }
  const posts: Counts = {};
  // Counts each request at the host's send, so a file the host asks the worker to read again moves a row.
  const send = worker.run.bind(worker);
  worker.run = (request: { kind: string }, ...rest: unknown[]) => {
    const name = `workerRequest:${request.kind}`;
    posts[name] = (posts[name] ?? 0) + 1;
    return send(request, ...rest);
  };
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
  });
  // A cold start reads every file once. Its metadata and enrichment passes are a fixed cost that the later steps guard.
  if (options.stubReadPasses)
    Object.assign(provider, {
      prepareMetadata: async () => true,
      prepareRailEnrichment: async () => ({ changed: false, progress: false, stale: [] }),
    });
  const started: Promise<unknown>[] = [];
  for (const method of [
    'refresh',
    'continueDiscovery',
    'pollCatalog',
    'refineDispatchedSpend',
    ...(options.coverage ? ['prepareMetadata', 'prepareRailEnrichment'] : []),
  ]) {
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
      postMessage: (message: unknown) => {
        countPost(posts, message);
        return Promise.resolve(true);
      },
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
    for (let advanced = 0; advanced < 10;) {
      await new Promise((resolve) => setImmediate(resolve));
      if (started.length) {
        await Promise.all(started.splice(0));
        continue;
      }
      const state = options.coverage ? { pendingCount: worker.pending.size, active: [] } : worker.snapshot();
      if (state.pendingCount || state.active.length || provider.refreshController || provider.pendingRefresh) continue;
      if (provider.codexPriming || provider.pollInFlight) continue;
      vi.advanceTimersByTime(stepMs);
      // Discovery can take many passes, and each pass waits on one zero-length timer. Only quiet time counts.
      if (!provider.dispatchDiscoveryPending && !provider.dispatchSpendPending) advanced++;
    }
  };
  return { provider, worker, posts, settle, started, receive: (message: unknown) => receive(message) };
}

// Replaces the workspace that `activate` serves and returns the one it replaced.
function replaceWorkspace(next: BudgetWorkspace): BudgetWorkspace {
  const previous = workspace;
  workspace = next;
  return previous;
}

interface HostCoverage {
  listed: number;
  events: Record<string, Map<string, number>>;
}

async function hostCoverage(
  extra: number,
  session: Session,
  locations: Map<string, Map<number, string>>,
): Promise<HostCoverage> {
  const { budgetWorkspace } = await import('../src/budgetworkspace.ts');
  const savedWorkspace = workspace;
  const savedEnvironment = new Map(
    ['ARC_HOME', 'ARC_PROJECTS_ROOT', 'ARC_CODEX_ROOT'].map((name) => [name, process.env[name]]),
  );
  const root = paddedRoot(tempDir('visit-budget-'));
  // Receipt names keep discovery publication order fixed across fixture roots.
  let serial = 0;
  const uuid = vi
    .spyOn(crypto, 'randomUUID')
    .mockImplementation(() => `00000004-0000-4000-8000-${(++serial).toString(16).padStart(12, '0')}`);
  try {
    workspace = budgetWorkspace(root);
  } finally {
    uuid.mockRestore();
  }
  const update = crypto.Hash.prototype.update;
  // Unique fixture IDs keep source keys distinct without the random temporary path changing their sort order.
  const hash = vi.spyOn(crypto.Hash.prototype, 'update').mockImplementation(function (
    this: crypto.Hash,
    ...args: Parameters<crypto.Hash['update']>
  ) {
    const data = args[0];
    if (typeof data === 'string' && /^(claude|codex)\0/.test(data)) args[0] = data.split('\0').slice(0, 2).join('\0');
    return Reflect.apply(update, this, args);
  });
  vi.stubEnv('ARC_HOME', workspace.home);
  vi.stubEnv('ARC_PROJECTS_ROOT', workspace.projects);
  vi.stubEnv('ARC_CODEX_ROOT', workspace.codexSessions);
  const source = workspace.parents[70];
  for (let index = 0; index < extra; index++) {
    const sessionId = `00000003-${index.toString(16).padStart(4, '0')}-4000-8000-000000000000`;
    const file = path.join(path.dirname(source.file), `${sessionId}.jsonl`);
    fs.writeFileSync(file, fs.readFileSync(source.file, 'utf8').replaceAll(source.sessionId, sessionId));
    fs.utimesSync(file, new Date(modules.BUDGET_CLOCK - 3_600_000), new Date(modules.BUDGET_CLOCK - 3_600_000));
    workspace.parents.push({ ...source, sessionId, file });
  }
  const settledDirectory = new Date(modules.BUDGET_CLOCK - 3_600_000);
  fs.utimesSync(path.dirname(source.file), settledDirectory, settledDirectory);
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(modules.BUDGET_CLOCK);
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation(vi.fn());
  const active = activate({ stubReadPasses: false, coverage: true });
  const events: HostCoverage['events'] = {};
  try {
    await active.receive({ type: 'ready' });
    await active.settle();
    await active.provider.pollCatalog();
    await active.settle();
    assert.equal(active.provider.dispatchFacts.size, workspace.dispatches.length);
    const measure = async (name: string, act: () => unknown) => {
      await session.post('Profiler.takePreciseCoverage');
      await act();
      await active.settle();
      const { result } = await session.post('Profiler.takePreciseCoverage');
      const functions = new Map<string, number>();
      for (const script of result) {
        const file = script.url.replaceAll('\\', '/');
        if (
          !file.includes('/extension/src/') ||
          file.endsWith('/budgetworkspace.ts') ||
          /\.test\.[cm]?[jt]s(?:$|\?)/.test(file)
        )
          continue;
        const raw = (await session.post('Debugger.getScriptSource', { scriptId: script.scriptId })).scriptSource;
        let names = locations.get(script.scriptId);
        if (!names || script.functions.some((fn) => !names!.has(fn.ranges[0].startOffset))) {
          names ??= new Map();
          const encodedMap = /sourceMappingURL=data:application\/json;base64,([^\s]+)/.exec(raw)?.[1];
          assert.ok(encodedMap, `No source map for ${file}`);
          const sourceMap = new SourceMap(JSON.parse(Buffer.from(encodedMap, 'base64').toString('utf8')));
          for (const fn of script.functions) {
            const offset = fn.ranges[0].startOffset;
            const prefix = raw.slice(0, offset);
            const line = prefix.split('\n').length - 1;
            const column = prefix.length - prefix.lastIndexOf('\n') - 1;
            const entry = sourceMap.findEntry(line, column);
            const position =
              'originalLine' in entry
                ? `${entry.originalLine + 1}:${entry.originalColumn + 1}`
                : `generated:${line + 1}:${column + 1}`;
            const location = `${file.split('/extension/src/')[1]}:${position}`;
            names.set(offset, `${location} ${fn.functionName || '<anonymous>'}`);
          }
          locations.set(script.scriptId, names);
        }
        for (const fn of script.functions) {
          const body = raw.slice(fn.ranges[0].startOffset, fn.ranges[0].endOffset);
          if (/^\(\) => \{ try \{ return [\w$]+ \} catch \{\} \}$/.test(body)) continue;
          const key = names.get(fn.ranges[0].startOffset)!;
          functions.set(key, (functions.get(key) ?? 0) + fn.ranges.reduce((sum, range) => sum + range.count, 0));
        }
      }
      events[name] = functions;
    };
    const walks = active.provider.performanceCounters.snapshot().work.catalogWalk;
    await measure('poll refresh', () => active.provider.pollCatalog());
    assert.equal(active.provider.performanceCounters.snapshot().work.catalogWalk, walks);
    await measure('selection', () => active.receive({ type: 'showSession', session: workspace.parents[50].sessionId }));
    await measure('one turn', () => {
      const source = workspace.parents[10];
      workspace.growSource(source, Date.now());
      active.provider.pendingWatch.noteFileEvent(
        path.dirname(source.file),
        path.basename(source.file),
        'change',
        modules.normalizeFsPath,
      );
      active.provider.runPendingWatch({ cause: 'quiet', firstAt: 0, lastAt: 0, firedAt: 0 });
    });
    await measure('discovery reply', async () => {
      active.provider.dispatchDiscoveryPending = true;
      await active.provider.continueDiscovery();
    });
    await measure('session list post', () => active.receive({ type: 'setRailFilters', railFilters: [] }));
    return { listed: active.provider.catalog.sessions.length, events };
  } finally {
    active.provider.writeDerivedCache = () => true;
    active.provider.dispose();
    active.worker.stop();
    clock.mockRestore();
    hash.mockRestore();
    interval.mockRestore();
    vi.useRealTimers();
    workspace = savedWorkspace;
    for (const [name, value] of savedEnvironment) vi.stubEnv(name, value);
  }
}

export {
  BUDGET_FILE,
  HOST_WORK_FILE,
  hostWorkSkip,
  coverageSession,
  hostCoverage,
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
};
export type { Counts, BudgetRow };
