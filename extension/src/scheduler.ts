import * as path from 'node:path';

export interface SchedulerClock {
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(timer: unknown): void;
}

export interface ScheduledRun {
  cause: 'quiet' | 'maximum' | 'flush';
  firstAt: number;
  lastAt: number;
  firedAt: number;
}

const systemClock: SchedulerClock = {
  now: () => Date.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export class BoundedTrailingScheduler {
  private quietTimer: unknown | null = null;
  private maximumTimer: unknown | null = null;
  private firstAt: number | null = null;
  private lastAt: number | null = null;

  constructor(
    private readonly quietMs: number,
    private readonly maximumMs: number,
    private readonly run: (event: ScheduledRun) => void,
    private readonly clock: SchedulerClock = systemClock,
  ) {
    if (!(quietMs > 0) || !(maximumMs >= quietMs)) {
      throw new Error('A bounded scheduler needs a positive quiet period no longer than its maximum wait.');
    }
  }

  offer(): void {
    const now = this.clock.now();
    if (this.firstAt === null) {
      this.firstAt = now;
      this.maximumTimer = this.clock.setTimer(() => this.fire('maximum'), this.maximumMs);
    }
    this.lastAt = now;
    if (this.quietTimer !== null) {
      this.clock.clearTimer(this.quietTimer);
    }
    this.quietTimer = this.clock.setTimer(() => this.fire('quiet'), this.quietMs);
  }

  flush(): boolean {
    if (this.firstAt === null) {
      return false;
    }
    this.fire('flush');
    return true;
  }

  cancel(): void {
    this.clearTimers();
    this.firstAt = null;
    this.lastAt = null;
  }

  get pending(): boolean {
    return this.firstAt !== null;
  }

  pendingAge(now = this.clock.now()): number | null {
    return this.firstAt === null ? null : Math.max(0, now - this.firstAt);
  }

  private fire(cause: ScheduledRun['cause']): void {
    if (this.firstAt === null || this.lastAt === null) {
      return;
    }
    const event: ScheduledRun = {
      cause,
      firstAt: this.firstAt,
      lastAt: this.lastAt,
      firedAt: this.clock.now(),
    };
    this.clearTimers();
    this.firstAt = null;
    this.lastAt = null;
    this.run(event);
  }

  private clearTimers(): void {
    if (this.quietTimer !== null) {
      this.clock.clearTimer(this.quietTimer);
    }
    if (this.maximumTimer !== null) {
      this.clock.clearTimer(this.maximumTimer);
    }
    this.quietTimer = null;
    this.maximumTimer = null;
  }
}

export interface IntegritySource {
  file: string;
  warm: boolean;
}

// Periodic passes retain their position while targeted work arrives. All lanes share one batch.
export class IntegrityScheduler {
  private sources: readonly IntegritySource[] = [];
  private promoted = new Map<string, number>();
  private pending = new Set<string>();
  private passes: ({ files: string[]; offset: number; owed: boolean } | undefined)[] = [];
  private deadlines = [0, 0];
  private timer: unknown | null = null;
  private active = false;
  private generation = 0;
  private running = false;
  private lane = 0;

  constructor(
    private readonly check: (files: readonly string[], current: () => boolean) => Promise<void>,
    private readonly discover: () => void,
    private readonly clock: SchedulerClock = systemClock,
    private readonly batchSize = 16,
  ) {}

  update(sources: readonly IntegritySource[]): void {
    this.sources = sources;
  }

  warmFiles(): ReadonlySet<string> {
    return new Set(this.sources.filter((source) => this.warm(source)).map((source) => source.file));
  }

  promote(files: Iterable<string>): void {
    for (const file of files) {
      this.promoted.set(file, this.clock.now());
      this.pending.add(file);
    }
    if (this.timer !== null) this.clock.clearTimer(this.timer);
    this.timer = null;
    this.wake();
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.deadlines = [this.clock.now(), this.clock.now() + 15 * 60_000];
    this.wake();
  }

  pause(): void {
    this.active = false;
    this.generation++;
    if (this.timer !== null) this.clock.clearTimer(this.timer);
    this.timer = null;
    this.passes = [];
  }

  private warm(source: IntegritySource): boolean {
    return source.warm || this.clock.now() - (this.promoted.get(source.file) ?? -Infinity) < 7 * 86_400_000;
  }

  private wake(): void {
    if (!this.active || this.timer !== null || this.running) return;
    this.timer = this.clock.setTimer(() => {
      this.timer = null;
      void this.run();
    }, 0);
  }

  private async run(): Promise<void> {
    if (!this.active || this.running) return;
    this.running = true;
    const generation = this.generation;
    const current = () => this.active && generation === this.generation;
    try {
      for (let lane = 0; lane < 2; lane++) {
        if (this.clock.now() < this.deadlines[lane]) continue;
        this.deadlines[lane] = this.clock.now() + (lane === 0 ? 30_000 : 15 * 60_000);
        const pass = this.passes[lane];
        if (pass) pass.owed = true;
        else this.passes[lane] = this.pass(lane);
        if (lane === 1) this.discover();
      }
      let files: string[] = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        const lane = this.lane++ % 3;
        if (lane === 2) {
          for (const file of this.pending) {
            files.push(file);
            this.pending.delete(file);
            if (files.length === this.batchSize) break;
          }
        } else {
          const pass = this.passes[lane];
          if (!pass) continue;
          files = pass.files.slice(pass.offset, pass.offset + this.batchSize);
          pass.offset += files.length;
          if (pass.offset >= pass.files.length) {
            this.passes[lane] = undefined;
            if (pass.owed) this.passes[lane] = this.pass(lane);
          }
        }
        if (files.length) break;
      }
      if (files.length) await this.check(files, current);
    } finally {
      this.running = false;
      if (this.active) {
        const work = this.pending.size > 0 || this.passes.some(Boolean);
        this.timer = this.clock.setTimer(
          () => {
            this.timer = null;
            void this.run();
          },
          work ? 0 : Math.max(0, Math.min(...this.deadlines) - this.clock.now()),
        );
      }
    }
  }

  private pass(lane: number): { files: string[]; offset: number; owed: boolean } {
    return {
      files: this.sources.filter((source) => this.warm(source) === (lane === 0)).map((source) => source.file),
      offset: 0,
      owed: false,
    };
  }
}

export type WatcherWakeReason = 'transcript' | 'activity-fallback';

// Why a wake cannot name its files and walks the whole catalog instead.
// `missingFilename`: the watcher delivered an event without a filename.
// `createOrRename`: a file appeared, moved or disappeared.
// `requested`: the host asked for a walk.
// `activityFallbackNoFile`: a live session has no listed transcript.
// `noPaths`: the batch named no file.
// `unknownPath`: a named file is outside the held catalog.
export type WatcherBroadReason =
  | 'missingFilename'
  | 'createOrRename'
  | 'requested'
  | 'activityFallbackNoFile'
  | 'noPaths'
  | 'unknownPath';

export interface WatcherWakeBatch {
  eventCount: number;
  changedPaths: string[];
  broadRequired: boolean;
  broadReasons: WatcherBroadReason[];
  // A shown session gained live activity that no drawn card carries, so the wake draws even
  // when no file moved.
  drawRequired: boolean;
  reasons: WatcherWakeReason[];
}

// The listed transcripts of the named sessions, or null when a session has no listed transcript.
export function listedFilesFor(
  sessions: readonly string[],
  catalog: readonly { sessionId: string; file: string }[],
): string[] | null {
  const files: string[] = [];
  for (const session of new Set(sessions)) {
    const listed = catalog.filter((row) => row.sessionId === session);
    if (!listed.length) {
      return null;
    }
    files.push(...listed.map((row) => row.file));
  }
  return files;
}

export class PendingWatcherWake {
  private eventCount = 0;
  private readonly changedPaths = new Set<string>();
  private broadRequired = false;
  private readonly broadReasons = new Set<WatcherBroadReason>();
  private drawRequired = false;
  private readonly reasons = new Set<WatcherWakeReason>();

  noteFileEvent(
    directory: string,
    filename: unknown,
    kind: string,
    normalize: (file: string) => string = (file) => file,
  ): boolean {
    if (typeof filename === 'string' && !filename.endsWith('.jsonl')) {
      return false;
    }
    this.eventCount++;
    this.reasons.add('transcript');
    if (typeof filename !== 'string') {
      this.broadRequired = true;
      this.broadReasons.add('missingFilename');
      return true;
    }
    this.changedPaths.add(normalize(path.join(directory, filename)));
    if (kind !== 'change') {
      this.broadRequired = true;
      this.broadReasons.add('createOrRename');
    }
    return true;
  }

  requireBroad(reason: WatcherWakeReason): void {
    this.broadRequired = true;
    this.broadReasons.add('requested');
    this.reasons.add(reason);
  }

  // Live activity for sessions with no drawn card names their listed transcripts. Null files
  // mean a session has no listed transcript, which only the broad walk can find. Named files
  // have no count limit: each costs one stat, and the walk stats every listed file.
  noteActivityFallback(
    files: readonly string[] | null,
    draw: boolean,
    normalize: (file: string) => string = (file) => file,
  ): void {
    this.reasons.add('activity-fallback');
    if (draw) {
      this.drawRequired = true;
    }
    if (files === null) {
      this.broadRequired = true;
      this.broadReasons.add('activityFallbackNoFile');
      return;
    }
    for (const file of files) {
      this.changedPaths.add(normalize(file));
    }
  }

  snapshot(): WatcherWakeBatch {
    return {
      eventCount: this.eventCount,
      changedPaths: [...this.changedPaths].sort(),
      broadRequired: this.broadRequired,
      broadReasons: [...this.broadReasons].sort(),
      drawRequired: this.drawRequired,
      reasons: [...this.reasons].sort(),
    };
  }

  take(): WatcherWakeBatch {
    const batch = this.snapshot();
    this.eventCount = 0;
    this.changedPaths.clear();
    this.broadRequired = false;
    this.broadReasons.clear();
    this.drawRequired = false;
    this.reasons.clear();
    return batch;
  }

  clear(): void {
    this.take();
  }
}

// The decision names why it walks, so a counter can say which cause keeps the catalog walking.
export function watcherRefreshDecision(
  batch: WatcherWakeBatch,
  knownPath: (file: string) => boolean,
): { kind: 'broad' | 'targeted'; changedPaths: string[]; broadReasons: WatcherBroadReason[] } {
  if (batch.broadRequired) {
    const broadReasons = batch.broadReasons.length ? batch.broadReasons : ['requested' as const];
    return { kind: 'broad', changedPaths: [], broadReasons };
  }
  if (batch.changedPaths.length === 0) {
    return { kind: 'broad', changedPaths: [], broadReasons: ['noPaths'] };
  }
  if (batch.changedPaths.some((file) => !knownPath(file))) {
    return { kind: 'broad', changedPaths: [], broadReasons: ['unknownPath'] };
  }
  return { kind: 'targeted', changedPaths: batch.changedPaths, broadReasons: [] };
}

// How long a catalog refresh holds the triggers that wait behind it. After this, the next waiting
// trigger abandons the refresh in flight and runs, so a worker request that never answers cannot
// hold every later refresh. A walk that answers within this time is never abandoned.
export const CATALOG_REFRESH_DEADLINE_MS = 30_000;

export interface RefreshRequest {
  reason: string;
  force: boolean;
  reuseCatalog: boolean;
  metadataAfterRender: boolean;
  // Null or empty asks for the broad catalog walk unless the request reuses the held catalog.
  changedPaths: string[] | null;
}

// Folds a refresh request into the one that waits behind the refresh in flight. The result
// does everything that either request asked for. A request that reuses the held catalog asks
// for no walk. Two targeted requests revalidate the union of their files, and any broad
// request makes the result broad. A render before metadata stays only when both accept it.
export function mergeRefreshRequests(pending: RefreshRequest | null, next: RefreshRequest): RefreshRequest {
  const requests = pending ? [pending, next] : [next];
  const reuseCatalog = requests.every((request) => request.reuseCatalog);
  const walking = requests.filter((request) => !request.reuseCatalog);
  const changedPaths =
    !reuseCatalog && walking.every((request) => request.changedPaths?.length)
      ? [...new Set(walking.flatMap((request) => request.changedPaths ?? []))]
      : null;
  return {
    reason: pending && pending.reason !== next.reason ? 'coalesced' : next.reason,
    force: requests.some((request) => request.force),
    reuseCatalog,
    metadataAfterRender: requests.every((request) => request.metadataAfterRender),
    changedPaths,
  };
}
