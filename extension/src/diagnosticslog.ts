// Writes per-host JSON-line diagnostics from a directory, host identity, and clock.
// Each host writes its own file to avoid interleaved appends across editor windows and instances.
// Instance identity on each line supports sorting by time and grouping by host.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { StartupMilestone } from './performancediagnostics';

// The directory this module owns, under the Arc home directory.
export const DIAGNOSTICS_LOG_DIRECTORY = 'logs';

// Byte threshold for stopping ordinary log lines, and retained log file count.
export const DIAGNOSTICS_LOG_MAXIMUM_BYTES = 8 * 1024 * 1024;
export const DIAGNOSTICS_LOG_KEPT_FILES = 20;

// Matches owned log filenames. Pruning leaves other names untouched.
const LOG_FILE_NAME = /^arc-\d{8}-\d{6}-\d+\.jsonl$/;

export type DiagnosticsRecord = Record<string, unknown>;

export interface DiagnosticsLog {
  // Writes a line when detailed logging is enabled. Returns immediately when disabled.
  log(event: string, record?: DiagnosticsRecord): void;
  // Writes regardless of the detailed logging setting, including startup threshold warnings.
  warn(event: string, record?: DiagnosticsRecord): void;
  // Selected log file path, or null before the first successful directory setup.
  file(): string | null;
  // Reports whether detailed logging is enabled so callers can skip building records.
  enabled(): boolean;
}

export interface DiagnosticsLogOptions {
  // What `arc.diagnostics.log` says.
  enabled: boolean;
  // The directory this log owns. It prunes and writes here, and nowhere else.
  directory: string;
  // Workspace identifier included on every line.
  workspace: string;
  pid: number;
  // Host start time used in the filename and instance identity.
  startedAt: number;
  // Clock used for each line, injectable for tests.
  now?: () => number;
  maximumBytes?: number;
  keptFiles?: number;
  measurementRun?: string;
}

function twoDigits(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

// UTC timestamps keep filename sorting stable when local clocks move backward.
function stamp(at: number): string {
  const when = new Date(at);
  return (
    `${when.getUTCFullYear()}${twoDigits(when.getUTCMonth() + 1)}${twoDigits(when.getUTCDate())}` +
    `-${twoDigits(when.getUTCHours())}${twoDigits(when.getUTCMinutes())}${twoDigits(when.getUTCSeconds())}`
  );
}

export function diagnosticsLogFileName(startedAt: number, pid: number): string {
  return `arc-${stamp(startedAt)}-${pid}.jsonl`;
}

// Combines process id and start time to distinguish host runs across windows and restarts.
export function diagnosticsInstanceIdentity(startedAt: number, pid: number): string {
  return `${pid}-${startedAt.toString(36)}`;
}

// Keeps the newest matching regular files. Pruning neither recurses nor removes directories or symbolic links.
export function pruneDiagnosticsLogs(directory: string, keep: number): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const owned = entries
    .filter((entry) => entry.isFile() && LOG_FILE_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const removed: string[] = [];
  for (const name of owned.slice(0, Math.max(0, owned.length - keep))) {
    try {
      fs.unlinkSync(path.join(directory, name));
      removed.push(name);
    } catch {
      // Failed deletion leaves the file for a later prune attempt.
    }
  }
  return removed;
}

class FileDiagnosticsLog implements DiagnosticsLog {
  private readonly now: () => number;
  private readonly maximumBytes: number;
  private readonly instance: string;
  private target: string | null = null;
  private written = 0;
  private stopped = false;

  constructor(private readonly options: DiagnosticsLogOptions) {
    this.now = options.now ?? Date.now;
    this.maximumBytes = options.maximumBytes ?? DIAGNOSTICS_LOG_MAXIMUM_BYTES;
    this.instance = diagnosticsInstanceIdentity(options.startedAt, options.pid);
  }

  log(event: string, record?: DiagnosticsRecord): void {
    // Disabled logging skips serialization and filesystem operations.
    if (!this.options.enabled) {
      return;
    }
    this.write(event, record);
  }

  warn(event: string, record?: DiagnosticsRecord): void {
    this.write(event, record);
  }

  file(): string | null {
    return this.target;
  }

  enabled(): boolean {
    return this.options.enabled;
  }

  private write(event: string, record?: DiagnosticsRecord): void {
    if (this.stopped) {
      return;
    }
    // Logging failures must not interrupt the measured operation.
    // Circular references and BigInt values fail JSON serialization.
    try {
      const line = this.line(event, record);
      const bytes = Buffer.byteLength(line, 'utf8');
      if (!this.open()) {
        return;
      }
      if (this.written + bytes > this.maximumBytes) {
        this.stopped = true;
        this.append(this.line('logFull', { maximumBytes: this.maximumBytes, writtenBytes: this.written }));
        return;
      }
      if (this.append(line)) {
        this.written += bytes;
      }
    } catch {
      // Drops the failed line without interrupting the caller.
    }
  }

  private line(event: string, record?: DiagnosticsRecord): string {
    return `${JSON.stringify({
      at: new Date(this.now()).toISOString(),
      pid: this.options.pid,
      instance: this.instance,
      ...(this.options.measurementRun ? { measurementRun: this.options.measurementRun } : {}),
      workspace: this.options.workspace,
      event,
      ...record,
    })}\n`;
  }

  private open(): boolean {
    if (this.target) {
      return true;
    }
    const directory = this.options.directory;
    try {
      fs.mkdirSync(directory, { recursive: true });
    } catch {
      this.stopped = true;
      return false;
    }
    pruneDiagnosticsLogs(directory, this.options.keptFiles ?? DIAGNOSTICS_LOG_KEPT_FILES);
    this.target = path.join(directory, diagnosticsLogFileName(this.options.startedAt, this.options.pid));
    try {
      this.written = fs.statSync(this.target).size;
    } catch {
      this.written = 0;
    }
    return true;
  }

  private append(line: string): boolean {
    if (!this.target) {
      return false;
    }
    try {
      fs.appendFileSync(this.target, line, 'utf8');
      return true;
    } catch {
      // Append failure stops logging without interrupting the caller.
      this.stopped = true;
      return false;
    }
  }
}

export function createDiagnosticsLog(options: DiagnosticsLogOptions): DiagnosticsLog {
  return new FileDiagnosticsLog(options);
}

export async function readStartupArtifact(directory: string): Promise<unknown> {
  try {
    const [text, bundle] = await Promise.all([
      fs.promises.readFile(path.join(directory, 'build-identity.json'), 'utf8'),
      fs.promises.readFile(path.join(directory, 'extension.js')),
    ]);
    const identity = JSON.parse(text);
    if (!identity || identity.extensionSha256 !== createHash('sha256').update(bundle).digest('hex'))
      return { unavailable: true };
    return identity;
  } catch {
    return { unavailable: true };
  }
}

// Returns a no-op log until a caller supplies a diagnostics directory.
export function silentDiagnosticsLog(): DiagnosticsLog {
  return {
    log() {},
    warn() {},
    file() {
      return null;
    },
    enabled() {
      return false;
    },
  };
}

export const HOST_HEALTH_CADENCE_MS = 5000;
export const HOST_HEALTH_EVENT_BYTES = 64 * 1024;
export const HOST_HEALTH_KEPT_RUNS = 20;
export const HOST_HEALTH_EVENT_RATE = 8;
export const HOST_HEALTH_IN_FLIGHT = 32;
// Duration below which `observe` drops a returned operation.
export const HOST_HEALTH_SLOW_MS = 100;
const HEALTH_NAME = /^health-[a-f0-9-]{36}\.(json|json\.next|jsonl|previous\.jsonl)$/;
const HEALTH_PHASES = [
  'select',
  'new',
  'send',
  'retention',
  'serialize',
  'ledgerSave',
  'serializer',
  'shutdown',
  'refresh',
  'sessionIndex',
  'hostSave',
] as const;
export type HostHealthPhase = (typeof HEALTH_PHASES)[number];
const HEALTH_EVENTS = [
  'activated',
  'attached',
  'adopted',
  'disposed',
  'ready',
  'unready',
  'parseRejected',
  'ack',
  'postFailed',
  'begin',
  'settled',
  'clean',
] as const;
type HostHealthEvent = (typeof HEALTH_EVENTS)[number];
export type HostHealthOutcome = 'returned' | 'failed' | 'pending' | 'rejected';

export interface HostHealthOptions {
  directory: string;
  workspace: string;
  build: { sourceCommit: string | null; dirty: boolean | null; builtAt: number; unavailable?: 'watch' | 'missing' };
  bundle?: string;
  pid?: number;
  now?: () => number;
  wall?: () => number;
  counts?: () => {
    attached: number;
    ready: number;
    retainedTabs: number | null;
    panels: { id: number; ready: boolean; sent: number; ack: number }[];
  };
  pulse?: (sequence: number) => void;
  work?: () =>
    | {
        worker: ReturnType<import('./progressiveworker').ProgressiveWorker['snapshot']>;
        discovery: import('./progressiveworker').DiscoveryCharges & { continuations: number; publications: number };
        discoveryObservation?: {
          hostRequest: number;
          generation: number;
          sequence: number;
          ageSinceReceiptMs: number;
          charges: import('./progressiveworker').DiscoveryCharges;
        } | null;
        generation: number;
        discoveryPending: boolean;
        loadingFailed: boolean;
        checkpoint: { position: number; sequence: number; sources: number; completed: number } | null;
        hostSaves?: { pending: number; oldestAgeMs: number | null };
      }
    | undefined;
}

// Sparse evidence survives an extension-host exit independently of detailed logging.
// Only bounded content-free lifecycle and work observations reach disk.
export class HostHealth {
  readonly provider = randomUUID();
  readonly file: string;
  private readonly events: string;
  private readonly previous: string;
  private readonly now: () => number;
  private readonly wall: () => number;
  private readonly started: number;
  private readonly bundleStamp: string | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private journalFailed = false;
  private clean = false;
  private bytes = 0;
  private sequence = 0;
  private rateAt = 0;
  private emitted = 0;
  private suppressed = 0;
  private dropped = 0;
  private lastSample: number;
  private ioFailures = 0;
  private observationFailures = 0;
  private outcomeSnapshotAt = -Infinity;
  private readonly outcomes: {
    request: number;
    panel: number;
    phase: HostHealthPhase;
    outcome: HostHealthOutcome;
    durationMs: number;
  }[] = [];
  private readonly outcomeCounts: Partial<Record<HostHealthPhase, Partial<Record<HostHealthOutcome, number>>>> = {};
  private readonly active = new Map<number, { phase: HostHealthPhase; started: number; panel: number }>();
  private readonly samples: unknown[] = [];
  private readonly counters: Partial<Record<HostHealthEvent, number>> = {};

  constructor(private readonly options: HostHealthOptions) {
    this.now = options.now ?? (() => performance.now());
    this.wall = options.wall ?? Date.now;
    this.started = this.now();
    this.lastSample = this.started;
    this.rateAt = this.started;
    this.file = path.join(options.directory, `health-${this.provider}.json`);
    this.events = path.join(options.directory, `health-${this.provider}.jsonl`);
    this.previous = path.join(options.directory, `health-${this.provider}.previous.jsonl`);
    this.bundleStamp = this.diskStamp();
    try {
      fs.mkdirSync(options.directory, { recursive: true });
      const owned = fs
        .readdirSync(options.directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && HEALTH_NAME.test(entry.name));
      const runs = new Map<string, number>();
      for (const entry of owned) {
        const run = entry.name.slice(0, 43);
        try {
          runs.set(run, Math.max(runs.get(run) ?? 0, fs.statSync(path.join(options.directory, entry.name)).mtimeMs));
        } catch {
          // A peer activation can remove an enumerated file.
        }
      }
      const remove = new Set(
        [...runs]
          .sort((a, b) => b[1] - a[1])
          .slice(HOST_HEALTH_KEPT_RUNS - 1)
          .map(([name]) => name),
      );
      for (const entry of owned)
        if (remove.has(entry.name.slice(0, 43))) {
          try {
            fs.rmSync(path.join(options.directory, entry.name), { force: true });
          } catch {
            // Retention failure does not prevent this activation from recording.
          }
        }
    } catch {
      this.stopped = true;
    }
    this.event('activated');
    this.sample();
    this.timer = setInterval(() => {
      this.sample();
      try {
        this.options.pulse?.(++this.sequence);
      } catch {
        this.observationFailures++;
      }
    }, HOST_HEALTH_CADENCE_MS);
    this.timer.unref();
  }

  event(
    event: HostHealthEvent,
    panel = 0,
    phase?: HostHealthPhase,
    request = 0,
    outcome?: HostHealthOutcome,
    durationMs?: number,
  ): void {
    if (this.clean || !HEALTH_EVENTS.includes(event)) return;
    this.counters[event] = Math.min(Number.MAX_SAFE_INTEGER, (this.counters[event] ?? 0) + 1);
    const now = this.now();
    if (now - this.rateAt >= 1000) {
      this.rateAt = now;
      this.emitted = 0;
    }
    if (this.emitted >= HOST_HEALTH_EVENT_RATE) {
      this.suppressed++;
      return;
    }
    this.emitted++;
    if (this.stopped) return;
    try {
      const line =
        JSON.stringify({
          at: this.wall(),
          elapsedMs: now - this.started,
          event,
          panel: Number.isSafeInteger(panel) && panel >= 0 ? panel : 0,
          request: Number.isSafeInteger(request) && request >= 0 ? request : 0,
          durationMs:
            typeof durationMs === 'number' && Number.isFinite(durationMs) ? Math.max(0, durationMs) : undefined,
          phase: phase && HEALTH_PHASES.includes(phase) ? phase : undefined,
          outcome: outcome && ['returned', 'failed', 'pending', 'rejected'].includes(outcome) ? outcome : undefined,
        }) + '\n';
      const lineBytes = Buffer.byteLength(line);
      if (this.bytes + lineBytes > HOST_HEALTH_EVENT_BYTES) {
        try {
          this.bytes = fs.statSync(this.events).size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          this.bytes = 0;
        }
        if (this.bytes + lineBytes > HOST_HEALTH_EVENT_BYTES) {
          if (fs.existsSync(this.previous)) fs.unlinkSync(this.previous);
          try {
            fs.renameSync(this.events, this.previous);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          this.bytes = 0;
        }
      }
      fs.appendFileSync(this.events, line, 'utf8');
      this.bytes += lineBytes;
      this.journalFailed = false;
    } catch {
      this.ioFailures++;
      this.journalFailed = true;
    }
  }

  begin(phase: HostHealthPhase, panel = 0): number {
    if (this.clean || !HEALTH_PHASES.includes(phase)) return 0;
    if (this.active.size >= HOST_HEALTH_IN_FLIGHT) {
      this.dropped++;
      return 0;
    }
    const request = ++this.sequence;
    this.active.set(request, {
      phase,
      started: this.now(),
      panel: Number.isSafeInteger(panel) && panel >= 0 ? panel : 0,
    });
    this.event('begin', panel, phase, request);
    return request;
  }

  settle(request: number, outcome: HostHealthOutcome = 'returned'): void {
    const work = this.active.get(request);
    if (!work) return;
    this.active.delete(request);
    this.record(request, work.panel, work.phase, outcome, this.now() - work.started);
  }

  // Records an operation that finished without a `begin`. A returned operation shorter than HOST_HEALTH_SLOW_MS leaves no record.
  observe(phase: HostHealthPhase, elapsedMs: number, outcome: HostHealthOutcome = 'returned', panel = 0): void {
    if (this.clean || !HEALTH_PHASES.includes(phase)) return;
    if (outcome === 'returned' && !(elapsedMs >= HOST_HEALTH_SLOW_MS)) return;
    this.record(++this.sequence, Number.isSafeInteger(panel) && panel >= 0 ? panel : 0, phase, outcome, elapsedMs);
  }

  private record(
    request: number,
    panel: number,
    phase: HostHealthPhase,
    outcome: HostHealthOutcome,
    elapsedMs: number,
  ): void {
    const result = ['returned', 'failed', 'pending', 'rejected'].includes(outcome) ? outcome : 'failed';
    const durationMs = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
    this.outcomes.push({ request, panel, phase, outcome: result, durationMs });
    if (this.outcomes.length > 16) this.outcomes.shift();
    const counts = (this.outcomeCounts[phase] ??= {});
    counts[result] = Math.min(Number.MAX_SAFE_INTEGER, (counts[result] ?? 0) + 1);
    const suppressed = this.suppressed;
    this.event('settled', panel, phase, request, result, durationMs);
    if (this.suppressed !== suppressed && this.now() - this.outcomeSnapshotAt >= 1000) {
      this.outcomeSnapshotAt = this.now();
      this.sample('unknown', false);
    }
  }

  status(): { file: string; failed: boolean; provider: string } {
    return { file: this.file, failed: this.stopped || this.journalFailed, provider: this.provider };
  }

  sample(termination: 'unknown' | 'clean' = 'unknown', heartbeat = true): void {
    if (this.clean) return;
    try {
      const now = this.now();
      const memory = process.memoryUsage();
      this.samples.push({
        elapsedMs: now - this.started,
        lagMs: heartbeat ? Math.max(0, now - this.lastSample - HOST_HEALTH_CADENCE_MS) : null,
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        external: memory.external,
      });
      if (this.samples.length > 12) this.samples.shift();
      if (heartbeat) this.lastSample = now;
      let counts: ReturnType<NonNullable<HostHealthOptions['counts']>> | undefined;
      let work: ReturnType<NonNullable<HostHealthOptions['work']>> | undefined;
      try {
        counts = this.options.counts?.();
        work = this.options.work?.();
      } catch {
        this.observationFailures++;
      }
      const count = (value: unknown) =>
        typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000) : null;
      const build = this.options.build;
      const record = {
        version: 1,
        provider: this.provider,
        pid: this.options.pid ?? process.pid,
        workspace: createHash('sha256').update(this.options.workspace).digest('hex'),
        at: this.wall(),
        elapsedMs: now - this.started,
        termination,
        logging: this.journalFailed ? 'failed' : 'active',
        ioFailures: this.ioFailures,
        observationFailures: this.observationFailures,
        build: {
          sourceCommit:
            typeof build.sourceCommit === 'string' && /^[a-f0-9]{40}$/.test(build.sourceCommit)
              ? build.sourceCommit
              : null,
          dirty: typeof build.dirty === 'boolean' ? build.dirty : null,
          builtAt: build.builtAt > 0 && Number.isFinite(build.builtAt) ? build.builtAt : null,
          unavailable: build.unavailable === 'watch' || build.unavailable === 'missing' ? build.unavailable : undefined,
          diskChanged: this.bundleStamp === null ? null : this.diskStamp() !== this.bundleStamp,
        },
        panels: {
          attached: count(counts?.attached),
          ready: count(counts?.ready),
          retainedTabs: count(counts?.retainedTabs),
          observations: (counts?.panels ?? []).slice(0, 16).map((panel) => ({
            id: count(panel.id),
            ready: panel.ready,
            sent: count(panel.sent),
            ack: count(panel.ack),
          })),
        },
        counters: this.counters,
        work,
        outcomes: this.outcomes,
        outcomeCounts: this.outcomeCounts,
        suppressed: this.suppressed,
        dropped: this.dropped,
        active: [...this.active].map(([request, work]) => ({
          request,
          panel: work.panel,
          phase: work.phase,
          elapsedMs: now - work.started,
        })),
        samples: this.samples,
        memoryScopes: {
          rss: 'extension-host process including all extensions and worker threads',
          heap: 'extension-host thread',
          external: 'extension-host thread',
        },
      };
      const text = JSON.stringify(record);
      if (Buffer.byteLength(text) > 16 * 1024) {
        this.stopped = true;
        return;
      }
      this.publish(text);
      this.stopped = false;
    } catch {
      this.ioFailures++;
      this.stopped = true;
    }
  }

  dispose(): void {
    if (this.clean) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.event('clean');
    this.sample('clean');
    this.clean = true;
    this.active.clear();
  }

  private diskStamp(): string | null {
    if (!this.options.bundle) return null;
    try {
      const stat = fs.statSync(this.options.bundle);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return null;
    }
  }

  private publish(text: string): void {
    fs.mkdirSync(this.options.directory, { recursive: true });
    fs.writeFileSync(`${this.file}.next`, text, 'utf8');
    fs.renameSync(`${this.file}.next`, this.file);
  }
}

// Sparse startup history remains available with detailed logging disabled.
export class StartupHistory {
  private pending: string | null = null;
  private writing = false;
  private stopped = false;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private samples: ReturnType<typeof setInterval> | null = null;
  private sampleCount = 0;
  private maximumRss = 0;
  private readonly stages: Record<string, number> = {};
  private readonly started: number;
  private panelStarted: number | null = null;
  private selected = false;
  private background = false;
  // Time with no visible panel after the first panel opened. Discovery continuations and polling wait for a visible panel.
  private hiddenSince: number | null = null;
  private hiddenCount = 0;
  private hiddenMs = 0;

  constructor(
    private readonly directory: string,
    private readonly details: () => DiagnosticsRecord,
    private readonly now: () => number = () => performance.now(),
    activationAt = performance.now(),
  ) {
    this.started = activationAt;
    this.stage('activation', this.started);
  }

  visibility(visible: boolean, at = this.now()): void {
    if (this.background || this.panelStarted === null) return;
    if (!visible && this.hiddenSince === null) {
      this.hiddenSince = at;
      this.hiddenCount++;
    } else if (visible && this.hiddenSince !== null) {
      this.hiddenMs += at - this.hiddenSince;
      this.hiddenSince = null;
    }
  }

  stage(name: string, at = this.now()): void {
    if (this.background) return;
    this.stages[name] ??= at;
    if (name === 'panelOpened' && this.panelStarted === null) {
      this.panelStarted = at;
      this.sample();
      this.samples = setInterval(() => {
        this.sample();
        if (this.sampleCount >= 60 && this.samples) {
          clearInterval(this.samples);
          this.samples = null;
        }
      }, 1000);
      this.samples.unref();
      this.deadline = setTimeout(() => this.write('pending-deadline'), 30_000);
      this.deadline.unref();
      this.write('opened');
    }
    if (name === 'firstCard' && !this.selected) {
      this.selected = true;
      if (this.deadline) clearTimeout(this.deadline);
      this.deadline = null;
      this.write('selected-text');
    }
    if (name === 'completeRender' && !this.background) {
      this.background = true;
      if (this.deadline) clearTimeout(this.deadline);
      this.deadline = null;
      this.write('background-complete');
      this.stopSamples();
    }
  }

  dispose(): void {
    if (this.panelStarted !== null && !this.background) this.write('closed-pending');
    this.stopSamples();
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = null;
  }

  private stopSamples(): void {
    if (this.samples) clearInterval(this.samples);
    this.samples = null;
  }

  private sample(): void {
    this.sampleCount++;
    this.maximumRss = Math.max(this.maximumRss, process.memoryUsage().rss);
  }

  private write(outcome: string): void {
    if (this.stopped) return;
    this.sample();
    const at = this.now();
    try {
      this.pending =
        JSON.stringify({
          at: new Date().toISOString(),
          pid: process.pid,
          hostTimeOrigin: performance.timeOrigin,
          outcome,
          hostElapsedMs: at,
          activationElapsedMs: at - this.started,
          panelElapsedMs: this.panelStarted === null ? null : at - this.panelStarted,
          selectedTextElapsedMs:
            this.panelStarted === null || this.stages.firstCard === undefined
              ? null
              : this.stages.firstCard - this.panelStarted,
          stages: { ...this.stages },
          hidden: {
            count: this.hiddenCount,
            ms: this.hiddenMs + (this.hiddenSince === null ? 0 : at - this.hiddenSince),
          },
          memory: {
            scope: 'extension-host process including all extensions and worker threads',
            currentHeapScope: 'extension-host thread',
            samples: this.sampleCount,
            observedMaximumRssBytes: this.maximumRss,
            current: process.memoryUsage(),
            processLifetimeMaximumRssBytes: process.resourceUsage().maxRSS * 1024,
          },
          ...this.details(),
        }) + '\n';
    } catch {
      return;
    }
    if (!this.writing) void this.flush();
  }

  private async flush(): Promise<void> {
    this.writing = true;
    try {
      await fs.promises.mkdir(this.directory, { recursive: true });
      const names = (await fs.promises.readdir(this.directory)).filter((name) => LOG_FILE_NAME.test(name)).sort();
      await Promise.all(
        names
          .slice(0, Math.max(0, names.length - DIAGNOSTICS_LOG_KEPT_FILES))
          .map((name) => fs.promises.unlink(path.join(this.directory, name)).catch(() => undefined)),
      );
      const target = path.join(this.directory, diagnosticsLogFileName(Math.round(performance.timeOrigin), process.pid));
      while (this.pending !== null) {
        const line = this.pending;
        this.pending = null;
        await fs.promises.appendFile(target, line, 'utf8');
      }
    } catch {
      this.stopped = true;
      this.pending = null;
    } finally {
      this.writing = false;
    }
  }
}

// Startup milestone limits for warning messages. Only the first card has a threshold.
export const STARTUP_THRESHOLDS_MS: Partial<Record<StartupMilestone, number>> = {
  firstCard: 30_000,
};

const MILESTONE_WORDS: Record<StartupMilestone, string> = {
  shellReady: 'open its panel',
  catalogReady: 'list the sessions',
  railReady: 'draw the rail',
  firstCard: 'draw its first card',
  completeRender: 'finish its first draw',
};

export interface StartupThresholdBreach {
  milestone: StartupMilestone;
  elapsedMs: number;
  thresholdMs: number;
  // What the "Arc" output channel shows the reader.
  notice: string;
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1).replace(/\.0$/, '');
}

// Ends startup measurement when the panel reports its complete render.
const FIRST_DRAW_DONE: StartupMilestone = 'completeRender';

// Reports each startup threshold breach once before the first complete render.
// A card that arrives after an empty workspace finishes rendering does not count as slow startup.
export class StartupThresholdWatch {
  private readonly reported = new Set<StartupMilestone>();
  private firstDrawDone = false;

  check(milestone: StartupMilestone, elapsedMs: number): StartupThresholdBreach | null {
    const afterFirstDraw = this.firstDrawDone;
    if (milestone === FIRST_DRAW_DONE) {
      this.firstDrawDone = true;
    }
    if (afterFirstDraw) {
      return null;
    }
    const thresholdMs = STARTUP_THRESHOLDS_MS[milestone];
    if (thresholdMs === undefined || !Number.isFinite(elapsedMs) || elapsedMs <= thresholdMs) {
      return null;
    }
    if (this.reported.has(milestone)) {
      return null;
    }
    this.reported.add(milestone);
    return {
      milestone,
      elapsedMs,
      thresholdMs,
      notice:
        `Arc took ${seconds(elapsedMs)} seconds to ${MILESTONE_WORDS[milestone]}. ` +
        `The expected time is under ${seconds(thresholdMs)} seconds.`,
    };
  }
}
