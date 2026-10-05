// Writes per-host JSON-line diagnostics from a directory, host identity, and clock.
// Each host writes its own file to avoid interleaved appends across editor windows and instances.
// Instance identity on each line supports sorting by time and grouping by host.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
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

  constructor(
    private readonly directory: string,
    private readonly details: () => DiagnosticsRecord,
    private readonly now: () => number = () => performance.now(),
    activationAt = performance.now(),
  ) {
    this.started = activationAt;
    this.stage('activation', this.started);
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
          memory: {
            scope: 'extension-host process including all extensions and worker threads',
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
