// The development log the owner turns on to watch the panel work without attaching a
// profiler. It knows nothing about VS Code: a caller hands it a directory, an identity and a
// clock, and it appends one JSON object per line.
//
// One file per host process, never one shared file. Several windows and several editor
// instances run Arc at once, each with its own extension host, and appends from processes
// that do not coordinate interleave into something nobody can read back. Each host writes its
// own file and stamps every line with the same instance identity, so a reader merges the
// files by time or splits them by window.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StartupMilestone } from './performancediagnostics';

// The directory this module owns, under the Arc home directory.
export const DIAGNOSTICS_LOG_DIRECTORY = 'logs';

// How much one file holds before the writer stops, and how many files the directory keeps.
export const DIAGNOSTICS_LOG_MAXIMUM_BYTES = 8 * 1024 * 1024;
export const DIAGNOSTICS_LOG_KEPT_FILES = 20;

// Exactly what this module names its own files. The prune deletes a name that matches this
// and nothing else, so anything else sharing the directory stays where it is.
const LOG_FILE_NAME = /^arc-\d{8}-\d{6}-\d+\.jsonl$/;

export type DiagnosticsRecord = Record<string, unknown>;

export interface DiagnosticsLog {
  // Writes a line while the setting is on, and returns at once while it is off.
  log(event: string, record?: DiagnosticsRecord): void;
  // Writes a line whatever the setting says. A startup threshold breach uses this, because a
  // signal nobody enables reaches nobody.
  warn(event: string, record?: DiagnosticsRecord): void;
  // The file this log has written to, or null while it has written nothing.
  file(): string | null;
  // Whether `log` writes anything. A caller asks this before it builds a record, so an
  // operation the panel counts thousands of times pays nothing while the log is off.
  enabled(): boolean;
}

export interface DiagnosticsLogOptions {
  // What `arc.diagnostics.log` says.
  enabled: boolean;
  // The directory this log owns. It prunes and writes here, and nowhere else.
  directory: string;
  // The window a reader is looking at, carried on every line.
  workspace: string;
  pid: number;
  // When the extension host started, which stamps the file name and the identity.
  startedAt: number;
  // The clock every line reads. A caller passes one so a test can hold time still.
  now?: () => number;
  maximumBytes?: number;
  keptFiles?: number;
}

function twoDigits(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

// UTC, so the names of two files sort in the order they were written. A local stamp orders
// them wrongly for the hour a clock goes back, and the prune deletes by that order.
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

// Two windows of one editor instance get two process ids, and one process restarted gets two
// start times. The pair therefore names one host process run, which is what a reader merging
// files by time needs to tell the lines apart.
export function diagnosticsInstanceIdentity(startedAt: number, pid: number): string {
  return `${pid}-${startedAt.toString(36)}`;
}

// Keeps the newest files and deletes the rest. It reads one directory, matches the exact name
// this module writes, and unlinks. It never recurses, never follows a link, and never removes
// a directory.
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
      // A file another process holds open stays. The next start tries again.
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
    // The whole cost of a log nobody turned on. No string, no stat, no handle.
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
    // A record holding a circular reference or a BigInt has no JSON form, and the panel must
    // survive one. The whole body sits in here so that no failure of the log reaches the
    // operation being counted.
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
      // The line is lost and the panel carries on.
    }
  }

  private line(event: string, record?: DiagnosticsRecord): string {
    return `${JSON.stringify({
      at: new Date(this.now()).toISOString(),
      pid: this.options.pid,
      instance: this.instance,
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
      // A full disk or a directory somebody removed stops the log. The panel carries on.
      this.stopped = true;
      return false;
    }
  }
}

export function createDiagnosticsLog(options: DiagnosticsLogOptions): DiagnosticsLog {
  return new FileDiagnosticsLog(options);
}

// A log that writes nothing, whatever it is asked for. The panel holds this until something
// hands it a directory, so a test that builds a panel writes no file anywhere.
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

// How long each startup milestone takes before the owner hears about it. Only the milestone
// the reader feels carries a threshold: `firstCard` is the number that matched the owner's
// report of a panel that would not draw.
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

// The milestone that ends the first draw. Once the panel reports it, Arc has drawn
// everything it had, and a milestone that lands later measures the wait for work that did not
// exist yet.
const FIRST_DRAW_DONE: StartupMilestone = 'completeRender';

// Reports a milestone that took longer than its threshold, once per milestone. The host asks
// this on every milestone, and reports whatever comes back.
//
// A reader who opens an empty workspace sees the whole first draw finish in seconds, and
// gains a first card hours later when an agent runs. That first card is the reader's own
// wait, not a slow start, so the watch stops measuring once the first draw is done. A panel
// that is still drawing has reported no `completeRender`, and its late first card is the case
// this threshold exists for.
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
