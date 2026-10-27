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
// `unspecified`: the batch required a walk without naming a cause.
export type WatcherBroadReason =
  | 'missingFilename'
  | 'createOrRename'
  | 'requested'
  | 'activityFallbackNoFile'
  | 'noPaths'
  | 'unknownPath'
  | 'unspecified';

export interface WatcherWakeBatch {
  eventCount: number;
  changedPaths: string[];
  // Paths whose event reported a file that appeared, moved or disappeared.
  createdPaths: string[];
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
  private readonly createdPaths = new Set<string>();
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
    const file = normalize(path.join(directory, filename));
    this.changedPaths.add(file);
    if (kind !== 'change') {
      this.createdPaths.add(file);
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
      createdPaths: [...this.createdPaths].sort(),
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
    this.createdPaths.clear();
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

// The catalog files of the Claude sessions whose session directory holds `file`. A session directory sits beside its
// transcript and is named for the session. Child transcripts sit in its `subagents` directory. Null means no listed
// session owns the path. `normalize` applies the platform's path rules, and the result keeps the listed file names.
export function sessionDirectoryOwners(
  catalog: readonly { agent: string; file: string; sessionId: string; childTranscript?: boolean }[],
  normalize: (file: string) => string,
): (file: string) => string[] | null {
  let owners: Map<string, string[]> | null = null;
  const parent = (file: string) => file.slice(0, Math.max(0, file.lastIndexOf('/')));
  return (file) => {
    if (!owners) {
      owners = new Map();
      for (const row of catalog) {
        if (row.agent !== 'claude' || row.childTranscript === true) continue;
        const directory = `${parent(normalize(row.file))}/${normalize(row.sessionId)}`;
        owners.set(directory, [...(owners.get(directory) ?? []), row.file]);
      }
    }
    const directory = parent(normalize(file));
    const name = directory.slice(directory.lastIndexOf('/') + 1);
    return (
      owners.get(directory) ?? (name.toLowerCase() === 'subagents' ? owners.get(parent(directory)) : undefined) ?? null
    );
  };
}

// The decision names why it walks, so a counter can say which cause keeps the catalog walking. A path outside the held
// catalog that a listed session's directory holds, such as a new child transcript, revalidates that session's files
// instead. The refresh that follows still sends child discovery, which lists a child that its parent records.
// `ownedPaths` counts those paths.
// A created or moved path that no listed session owns walks, and so does a listed path that moved, because a walk is
// the read that finds additions, removals and replacements.
export function watcherRefreshDecision(
  batch: WatcherWakeBatch,
  knownPath: (file: string) => boolean,
  ownersOf: (file: string) => string[] | null = () => null,
): { kind: 'broad' | 'targeted'; changedPaths: string[]; broadReasons: WatcherBroadReason[]; ownedPaths: number } {
  const created = new Set(batch.createdPaths);
  const owned = new Map<string, string[] | null>();
  const ownerFiles = (file: string) => {
    if (!owned.has(file)) owned.set(file, knownPath(file) ? null : ownersOf(file));
    return owned.get(file)!;
  };
  if (batch.broadRequired) {
    const broadReasons = [
      ...new Set([
        ...batch.broadReasons,
        ...(batch.createdPaths.some((file) => !ownerFiles(file)) ? ['createOrRename' as const] : []),
      ]),
    ].sort();
    return {
      kind: 'broad',
      changedPaths: [],
      broadReasons: broadReasons.length ? broadReasons : ['unspecified'],
      ownedPaths: 0,
    };
  }
  if (batch.changedPaths.length === 0) {
    return { kind: 'broad', changedPaths: [], broadReasons: ['noPaths'], ownedPaths: 0 };
  }
  const broadReasons = new Set<WatcherBroadReason>();
  const changedPaths = new Set<string>();
  let ownedPaths = 0;
  for (const file of batch.changedPaths) {
    const owners = ownerFiles(file);
    if (owners) {
      ownedPaths++;
      for (const owner of owners) changedPaths.add(owner);
    } else if (created.has(file)) {
      broadReasons.add('createOrRename');
    } else if (knownPath(file)) {
      changedPaths.add(file);
    } else {
      broadReasons.add('unknownPath');
    }
  }
  if (broadReasons.size) {
    return { kind: 'broad', changedPaths: [], broadReasons: [...broadReasons].sort(), ownedPaths: 0 };
  }
  return { kind: 'targeted', changedPaths: [...changedPaths].sort(), broadReasons: [], ownedPaths };
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
// for no walk, and the files it names stay named. Targeted requests revalidate the union of
// their files, and a broad request that names no file makes the result broad. A render before
// metadata stays only when both accept it.
export function mergeRefreshRequests(pending: RefreshRequest | null, next: RefreshRequest): RefreshRequest {
  const requests = pending ? [pending, next] : [next];
  const reuseCatalog = requests.every((request) => request.reuseCatalog);
  const walking = requests.filter((request) => !request.reuseCatalog);
  const named = [...new Set(requests.flatMap((request) => request.changedPaths ?? []))];
  const changedPaths =
    named.length && (reuseCatalog || walking.every((request) => request.changedPaths?.length)) ? named : null;
  return {
    reason: pending && pending.reason !== next.reason ? 'coalesced' : next.reason,
    force: requests.some((request) => request.force),
    reuseCatalog,
    metadataAfterRender: requests.every((request) => request.metadataAfterRender),
    changedPaths,
  };
}

// Live child events that change no fact a file records. Their refresh names no file and only draws.
const DRAW_ONLY_CHILD_EVENTS = new Set(['ready', 'skills', 'permissionMode', 'rateLimit', 'remoteControl', 'error']);

// True when a live child event records into its session's transcript, so its refresh revalidates the session's files.
export function childEventNamesFiles(kind: string): boolean {
  return !DRAW_ONLY_CHILD_EVENTS.has(kind);
}

// How long the poll waits since the last catalog walk before it walks with no moved directory. The walk finds growth in
// a directory that no watcher covers, and a new file in a directory that the stat list misses.
export const POLL_BACKSTOP_WALK_MS = 60_000;

// The most directories one poll stats. Past it, the poll stats the session directories in rotation.
export const POLL_DIRECTORY_STAT_LIMIT = 500;

// The directories the last walk enumerated. A new entry in a `listing` directory, such as a project, rollout date or
// source root, needs a walk. A new entry in a `children` directory, a session's `subagents` directory, needs child
// discovery for the session that owns it.
export interface PollDirectories {
  listing: readonly string[];
  children: readonly string[];
}

export type PollDecision =
  | { kind: 'walk'; cause: 'noListing' | 'directory' | 'backstop' }
  | { kind: 'children'; directories: string[] }
  | { kind: 'reuse' };

// Decides whether a poll walks the catalog. A new entry moves its directory's modification time on Windows, macOS and
// Linux, so each poll stats the enumerated directories and walks only when one moved, or when the backstop is due.
// Appends to a listed file move no directory: watchers report them, and the backstop walk finds the rest.
export class PollDirectoryGate {
  private readonly seen = new Map<string, string | null>();
  private cursor = 0;
  stats = 0;

  constructor(
    private readonly statOf: (directory: string) => Promise<string | null>,
    private readonly limit = POLL_DIRECTORY_STAT_LIMIT,
  ) {}

  // `directories` is null before the first walk. `sinceWalkMs` is the time since the last catalog walk. A directory's
  // first stat holds its time and moves nothing, because the backstop finds a change made before that stat.
  async decide(directories: PollDirectories | null, sinceWalkMs: number | null): Promise<PollDecision> {
    if (!directories || sinceWalkMs === null) return { kind: 'walk', cause: 'noListing' };
    const children = directories.children;
    // Session directories keep a share of each poll even when the listing directories fill the limit.
    const room = Math.max(this.limit - directories.listing.length, Math.floor(this.limit / 10));
    let rotated: readonly string[] = children;
    if (children.length > room) {
      const start = this.cursor % children.length;
      rotated = [...children.slice(start), ...children.slice(0, start)].slice(0, room);
      this.cursor = (start + rotated.length) % children.length;
    }
    const checked = [...directories.listing, ...rotated];
    this.stats = checked.length;
    const prints = await Promise.all(checked.map((directory) => this.statOf(directory).catch(() => null)));
    const moved = checked.filter((directory, index) => {
      const held = this.seen.get(directory);
      this.seen.set(directory, prints[index]);
      return held !== undefined && held !== prints[index];
    });
    const listing = new Set(directories.listing);
    if (moved.some((directory) => listing.has(directory))) return { kind: 'walk', cause: 'directory' };
    if (sinceWalkMs >= POLL_BACKSTOP_WALK_MS) return { kind: 'walk', cause: 'backstop' };
    if (moved.length) return { kind: 'children', directories: moved };
    return { kind: 'reuse' };
  }

  // Polling stopped, so the held times no longer follow every change.
  clear(): void {
    this.seen.clear();
    this.cursor = 0;
  }
}
