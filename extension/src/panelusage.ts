// Panel usage metrics: daily counts of the panel controls, keys, commands, and committed queries
// the owner uses, for agents that tune the panel. They are internal. Arc records them only while
// the `panel-usage` folder exists in the Arc home folder, and nothing leaves the machine.
//
// Each window writes its own file, `<day>/<window id>.json`, so no file needs a lock.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PanelToHost } from './webview/protocol.ts';

export const PANEL_USAGE_DIRECTORY = 'panel-usage';
export const PANEL_USAGE_VERSION = 1;
// The host writes at most once in this interval, and on dispose.
export const USAGE_WRITE_MS = 60_000;
// A file keeps this many distinct queries. Further queries add to `other`.
export const USAGE_QUERY_LIMIT = 200;
// A file keeps this many distinct count keys. The host drops a new key past this limit, and existing keys keep counting.
export const USAGE_KEY_LIMIT = 500;
// Day folders more than this many local days old are deleted.
export const USAGE_RETENTION_DAYS = 90;

// Whether each message type counts as `msg:<type>` once the host accepts it. A type marked false is one the panel
// posts by itself. A timer, a redraw, a resize, a reply, or a keystroke posts it, or it precedes a reader action.
// The compiler refuses a message type this map omits.
const MESSAGE_COUNTED: Record<PanelToHost['type'], boolean> = {
  refresh: true,
  goBack: true,
  goForward: true,
  newSession: true,
  pinSetup: true,
  unpinSetup: true,
  refreshUsage: true,
  openControl: true,
  pick: true,
  answerAsk: true,
  dropUris: true,
  attachFiles: true,
  removeFile: true,
  sendPrompt: true,
  compact: true,
  dismissLive: true,
  restoreLive: true,
  stopTurn: true,
  dequeue: true,
  editQueued: true,
  copy: true,
  note: true,
  showReaderParent: true,
  showSession: true,
  labelEditor: true,
  setLabels: true,
  setViews: true,
  renameSession: true,
  setRailFilters: true,
  sessionMembership: true,
  setLayout: true,
  exportSession: true,
  openLink: true,
  openDirectory: true,
  openVisualization: true,
  openImage: true,
  openTurnDiff: true,
  openCommit: true,
  openFile: true,
  openSkill: true,
  health: false,
  panelUsageMetrics: false,
  saveState: false,
  ready: false,
  painted: false,
  rowsGap: false,
  initialize: false,
  developmentReload: false,
  perf: false,
  readerRead: false,
  sessionFilterApplied: false,
  contextDetail: false,
  requestDefaults: false,
  draft: false,
  pathCompletion: false,
  search: false,
  loadOlder: false,
  importPromptRecovery: false,
  acceptQueuedEdit: false,
  fileReadError: false,
  fileRejected: false,
  beginFileStaging: false,
  armSelectedText: false,
  selectedTextHandoff: false,
  armLinkMenu: false,
  armSessionDetails: false,
  armComposer: false,
};

export interface PanelUsageMetricsFile {
  v: typeof PANEL_USAGE_VERSION;
  counts: Record<string, number>;
  queries: Record<string, number>;
  other?: number;
}

export interface PanelUsageMetricsOptions {
  now?: () => number;
  windowId?: string;
}

const DAY_NAME = /^(\d{4})-(\d{2})-(\d{2})$/;

// The local calendar date of a time, as the day folder names it.
export function usageDayName(time: number): string {
  const date = new Date(time);
  const two = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

// Local midnight of a day folder name, or null when the name is not a real date.
function dayStart(name: string): number | null {
  const match = DAY_NAME.exec(name);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const date = new Date(year, month, day);
  return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day ? date.getTime() : null;
}

function nextMidnight(time: number): number {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

function ignoreExisting(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
}

// Opens the metrics when their folder exists. One stat, and no metrics when the folder is missing.
export function openPanelUsageMetrics(
  home: string,
  options: PanelUsageMetricsOptions = {},
): PanelUsageMetrics | undefined {
  const directory = path.join(home, PANEL_USAGE_DIRECTORY);
  try {
    if (!fs.statSync(directory).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  return new PanelUsageMetrics(directory, options);
}

export class PanelUsageMetrics {
  readonly windowId: string;
  private readonly now: () => number;
  private counts = new Map<string, number>();
  private queries = new Map<string, number>();
  private other = 0;
  private lastQuery: string | null = null;
  private day: string;
  private dayEndsAt: number;
  private dirty = false;
  private disposed = false;
  private lastWriteAt: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  // Serialized bodies waiting for a successful write, by day. A rollover can leave two.
  private readonly pending = new Map<string, string>();
  private writing: Promise<void> = Promise.resolve();
  // The flush that waits in the queue and has not started its write.
  private queuedFlush: Promise<void> | undefined;
  private temporaryFiles = 0;
  private listPublished = false;
  private nextExpiryAt = 0;

  constructor(
    readonly directory: string,
    options: PanelUsageMetricsOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.windowId = options.windowId ?? randomUUID();
    this.lastWriteAt = this.now();
    this.day = usageDayName(this.lastWriteAt);
    this.dayEndsAt = nextMidnight(this.lastWriteAt);
  }

  // Every Arc command and accepted panel message calls this, so it costs one map increment and never throws.
  count(key: string): void {
    try {
      if (this.disposed) return;
      this.rollDay(this.now());
      if (this.addCount(key, 1)) this.changed();
    } catch {
      /* Counting never interrupts the action it counts. */
    }
  }

  // Counts one accepted panel message by its type. The message's other fields never reach the file.
  // A label editor refresh follows a host change to the labels, so no reader action started it.
  // The first session list paint turns expiry on, so expiry never runs on the activation path.
  message(message: PanelToHost): void {
    if (message.type === 'painted' && message.stage === 'railReady') {
      this.listPublished = true;
      void this.expireDue();
      return;
    }
    if (message.type === 'labelEditor' && message.refresh) return;
    if (MESSAGE_COUNTED[message.type]) this.count(`msg:${message.type}`);
  }

  // Adds the counts one panel page posted and its committed queries in commit order. All tabs of a
  // window share one instance, so a query repeating the last one this window counted adds nothing.
  merge(counts: Readonly<Record<string, number>>, queries: readonly string[]): void {
    try {
      if (this.disposed) return;
      this.rollDay(this.now());
      let added = false;
      for (const [key, value] of Object.entries(counts)) {
        added = this.addCount(key, value) || added;
      }
      for (const query of queries) {
        if (query === this.lastQuery) continue;
        this.lastQuery = query;
        added = true;
        const held = this.queries.get(query);
        if (held !== undefined) this.queries.set(query, held + 1);
        else if (this.queries.size < USAGE_QUERY_LIMIT) this.queries.set(query, 1);
        else this.other += 1;
      }
      if (added) this.changed();
    } catch {
      /* Counting never interrupts the action it counts. */
    }
  }

  // The file the next write produces for the current day.
  snapshot(): PanelUsageMetricsFile {
    return {
      v: PANEL_USAGE_VERSION,
      counts: Object.fromEntries(this.counts),
      queries: Object.fromEntries(this.queries),
      ...(this.other ? { other: this.other } : {}),
    };
  }

  fileFor(day: string): string {
    return path.join(this.directory, day, `${this.windowId}.json`);
  }

  // Writes now when a count changed. Resolves after the write settles. A failed write keeps the counts,
  // and a timer tries again while the `panel-usage` folder exists. A write after the first session list
  // paint also runs the day's expiry.
  flush(): Promise<void> {
    this.clearTimer();
    this.capture();
    // A queued write reads the pending bodies when it starts, so it carries this capture too.
    if (this.queuedFlush) return this.queuedFlush;
    this.queuedFlush = this.writing
      .then(() => {
        this.queuedFlush = undefined;
        return this.writePending();
      })
      .then(() => this.retryPending())
      .then(() => this.expireAfterWrite());
    this.writing = this.queuedFlush;
    return this.writing;
  }

  // Deletes day folders more than the retention period old, once per local day. Runs off the activation path.
  expireDue(): Promise<void> {
    const now = this.now();
    if (this.disposed || now < this.nextExpiryAt) return Promise.resolve();
    this.nextExpiryAt = nextMidnight(now);
    return this.expire(now);
  }

  // Writes the remaining counts synchronously, because the extension host does not wait for an
  // asynchronous write at shutdown. Setting `disposed` hands publication to this method.
  dispose(): void {
    if (this.disposed) return;
    this.clearTimer();
    this.capture();
    this.disposed = true;
    for (const [day, body] of this.pending) {
      const file = this.fileFor(day);
      const temporary = this.temporaryFile(file);
      try {
        // A missing `panel-usage` folder fails this write, so a deleted folder stays deleted.
        try {
          fs.mkdirSync(path.dirname(file));
        } catch (error) {
          ignoreExisting(error);
        }
        fs.writeFileSync(temporary, body);
        fs.renameSync(temporary, file);
        this.pending.delete(day);
      } catch {
        /* A failed write shows the reader nothing. */
        try {
          fs.rmSync(temporary, { force: true });
        } catch {
          /* Disposal continues with the other days. */
        }
      }
    }
  }

  private temporaryFile(file: string): string {
    this.temporaryFiles += 1;
    return `${file}.${this.temporaryFiles}.tmp`;
  }

  private changed(): void {
    this.dirty = true;
    this.schedule();
  }

  // A new count, or a failed write, arms the same timer, so retries keep to the write interval.
  private schedule(): void {
    if (this.timer !== undefined) return;
    const wait = Math.max(0, this.lastWriteAt + USAGE_WRITE_MS - this.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, wait);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private addCount(key: string, value: number): boolean {
    const held = this.counts.get(key);
    if (held === undefined && this.counts.size >= USAGE_KEY_LIMIT) return false;
    this.counts.set(key, (held ?? 0) + value);
    return true;
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  // Across local midnight the old day's file receives the unwritten counts one last time, and the new day
  // starts from zero. Runs before a count lands, so the first count after an idle midnight joins the new day.
  private rollDay(now: number): void {
    if (now < this.dayEndsAt) return;
    this.dayEndsAt = nextMidnight(now);
    const today = usageDayName(now);
    if (today === this.day) return;
    if (this.dirty) {
      this.pending.set(this.day, JSON.stringify(this.snapshot()));
      this.dirty = false;
    }
    this.day = today;
    this.counts = new Map();
    this.queries = new Map();
    this.other = 0;
    this.lastQuery = null;
  }

  // Moves the changed counts into the pending writes.
  private capture(): void {
    const now = this.now();
    this.rollDay(now);
    if (this.dirty) {
      this.pending.set(this.day, JSON.stringify(this.snapshot()));
      this.dirty = false;
    }
    // A count that arrives while this write waits in the queue keeps to the write interval.
    if (this.pending.size > 0) this.lastWriteAt = now;
  }

  private async writePending(): Promise<void> {
    if (this.pending.size === 0) return;
    for (const [day, body] of [...this.pending]) {
      if (this.disposed) return;
      const file = this.fileFor(day);
      const temporary = this.temporaryFile(file);
      try {
        // A missing `panel-usage` folder fails this write, so a deleted folder stays deleted.
        await fs.promises.mkdir(path.dirname(file)).catch(ignoreExisting);
        await fs.promises.writeFile(temporary, body);
        // The rename is synchronous so that no asynchronous rename is still running when `dispose` publishes.
        if (this.disposed) {
          await fs.promises.rm(temporary, { force: true });
          return;
        }
        fs.renameSync(temporary, file);
        if (this.pending.get(day) === body) this.pending.delete(day);
      } catch {
        /* A failed write shows the reader nothing and keeps the body for the timer's next try. */
        await fs.promises.rm(temporary, { force: true }).catch(() => {});
      }
    }
    // Expiry can hold the queue past the write interval, so the interval runs from this attempt.
    this.lastWriteAt = this.now();
  }

  // Retries a failed write once the write interval passes. The timer stops at dispose and while the
  // `panel-usage` folder is missing, because deleting that folder stops recording. The next count tries again.
  private async retryPending(): Promise<void> {
    if (this.disposed || this.pending.size === 0 || (await this.folderMissing())) return;
    if (!this.disposed) this.schedule();
  }

  private async folderMissing(): Promise<boolean> {
    try {
      return !(await fs.promises.stat(this.directory)).isDirectory();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === 'ENOENT' || code === 'ENOTDIR';
    }
  }

  private expireAfterWrite(): Promise<void> | void {
    if (this.listPublished) return this.expireDue();
  }

  private async expire(now: number): Promise<void> {
    const today = dayStart(usageDayName(now))!;
    let names: string[];
    try {
      names = await fs.promises.readdir(this.directory);
    } catch {
      return;
    }
    for (const name of names) {
      const start = dayStart(name);
      if (start === null) continue;
      // Rounding absorbs a daylight saving hour between the two midnights.
      if (Math.round((today - start) / 86_400_000) <= USAGE_RETENTION_DAYS) continue;
      try {
        await fs.promises.rm(path.join(this.directory, name), {
          recursive: true,
          force: true,
        });
      } catch {
        /* Expiry tries again on a later day. */
      }
    }
  }
}
