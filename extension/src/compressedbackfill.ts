// The backfill of compressed Codex rollouts. In the worker it decodes each `.jsonl.zst` that holds no current entry,
// derives the facts that a plain rollout's row reads, and publishes them to the stores and the host.
import * as path from 'node:path';
import {
  CODEX_TITLE_BYTES,
  codexOutcomeIn,
  codexRowAdmitted,
  codexSessionLineMayAffectRead,
  codexTitlePairOfLines,
  codexTurnStartsIn,
  createCodexSessionReducer,
  createCodexUsageLineReducer,
  isAgentRun,
  openingRecordOf,
  readRolloutStat,
  ROLLOUT_NAME,
  type CodexSessionMeta,
} from './codex';
import { readCompressedFirstRecord, streamCompressedRollout, type CompressedStreamRead } from './compressedrollouts';
import {
  COMPRESSED_BATCH_BYTES,
  COMPRESSED_ENTRY_TITLE_BYTES,
  boundedCompressedEntry,
  compressedEntryBatches,
  compressedEntryCurrent,
  compressedEntryVersions,
  compressedOpeningEntry,
  compressedPairKey,
  compressedTitleCurrent,
  readCompressedStoreInSteps,
  sessionKeyOf,
  withKeptUndercount,
  type CompressedEntrySeed,
  type CompressedFactEntry,
  type CompressedStoreHolder,
} from './compressedstore';
import type { DerivedTitleEntry } from './derivedcache';
import { ForwardRecoveryLimit, frameRecovery, type ForwardRecoveryControl } from './history';
import { createSpendLineScan } from './projectspend';
import {
  activityIn,
  sessionOutcomeOf,
  sessionStatFactsOf,
  TURN_START_BYTES,
  type FileRevision,
  type SessionRead,
} from './transcript';

// A slice decodes one file and ends after this much output or this much time.
export const BACKFILL_SLICE_BYTES = 4 * 1024 * 1024;
export const BACKFILL_SLICE_MS = 50;
const PLAN_SLICE_MS = 25;
// How often a held slice checks that no request waits. The longest wait of a discovery request is one slice.
const BUSY_CHECK_MS = 50;
// A decode that fails or ends inside a frame runs again after each of these delays, and then saves `unreadable`.
export const BACKFILL_RETRY_DELAYS_MS = [10_000, 60_000, 600_000] as const;
const BATCH_INTERVAL_MS = 1_000;
const ACTIVITY_TAIL_BYTES = 256 * 1024;
const RECORD_HEAD_BYTES = 512;
// Bounds of a forward recovery read, as the worker applies them to a metadata recovery.
const RECORD_LIMIT_BYTES = 16 * 1024 * 1024;
const REDUCE_ABOVE_BYTES = 1024 * 1024;
const RETAINED_LIMIT_BYTES = 64 * 1024 * 1024;

function drain(generator: Generator<void, unknown>): void {
  let step = generator.next();
  while (!step.done) step = generator.next();
}

// The facts of one decoded rollout. Every chunk goes to the session reducer and the spend scan once, so memory stays at
// the reducer's retained payload and two read windows, whatever the body's size.
export class RolloutDerivation {
  offset = 0;
  skippedRecords = 0;
  undercount = false;
  private opening: CodexSessionMeta | null | undefined;
  private reducer: ReturnType<typeof createCodexSessionReducer> | null = null;
  private spend: ReturnType<typeof createSpendLineScan> | null = null;
  private readonly head: string[] = [];
  private headBytes = 0;
  private tail: { text: string; bytes: number }[] = [];
  private tailBytes = 0;
  private tailCut = false;
  private lineEnd = 0;
  private skipping = false;
  private recordHead = Buffer.alloc(0);
  private readonly control: ForwardRecoveryControl;
  private readonly tee = {
    retainedBytes: () => this.reducer?.retainedBytes?.() ?? 0,
    retainedPayloadScan: () => this.retainedScan(),
    pushLine: (line: string | { text: string; start: number; end: number }) => this.reducer?.pushLine(line),
    snapshot: () => undefined,
    read: () => {
      throw new Error('The backfill reads a session through finish.');
    },
    finish: () => {
      throw new Error('The backfill reads a session through finish.');
    },
  };

  constructor(
    private readonly file: string,
    private readonly workspace: string,
    limits: { recordBytes?: number; reduceAbove?: number; retainedBytes?: number } = {},
  ) {
    this.control = {
      through: 0,
      readBytes: 0,
      retainedCharge: 0,
      retainedLimit: limits.retainedBytes ?? RETAINED_LIMIT_BYTES,
      recordLimit: limits.recordBytes ?? RECORD_LIMIT_BYTES,
      reduceAbove: limits.reduceAbove ?? REDUCE_ABOVE_BYTES,
      accepts: (text) => {
        this.observe(text);
        return codexSessionLineMayAffectRead(text);
      },
      fragments: [],
      fragmentBytes: 0,
    };
  }

  private *retainedScan(): Generator<void, number> {
    const reducer = this.reducer as {
      retainedPayloadScan?(): Generator<void, number>;
      retainedBytes?(): number;
    } | null;
    if (reducer?.retainedPayloadScan) return yield* reducer.retainedPayloadScan();
    return reducer?.retainedBytes?.() ?? 0;
  }

  // Every record the read keeps reaches this method once, so the opening, the title window, the tail and the spend scan
  // see the same records as a read of the plain rollout.
  private observe(text: string): void {
    if (this.opening === undefined) {
      this.opening = openingRecordOf(text);
      const sessionId = this.opening?.sessionId ?? ROLLOUT_NAME.exec(path.basename(this.plainFile()))?.[1] ?? '';
      this.reducer = createCodexSessionReducer(sessionId, { maxTurns: 40 }, this.opening);
      this.spend = createSpendLineScan(this.plainFile(), this.workspace, createCodexUsageLineReducer());
    }
    const bytes = Buffer.byteLength(text) + 1;
    if (this.headBytes < CODEX_TITLE_BYTES) {
      this.head.push(text);
      this.headBytes += bytes;
    }
    this.tail.push({ text, bytes });
    this.tailBytes += bytes;
    while (this.tailBytes > TURN_START_BYTES && this.tail.length > 1) {
      this.tailBytes -= this.tail.shift()!.bytes;
      this.tailCut = true;
    }
    this.spend!.pushLine(text, this.lineEnd);
  }

  private plainFile(): string {
    return this.file.replace(/\.zst$/, '');
  }

  push(chunk: Buffer): void {
    for (let at = 0; at < chunk.length;) {
      const newline = chunk.indexOf(0x0a, at);
      if (newline < 0) {
        this.segment(chunk.subarray(at), false);
        return;
      }
      this.segment(chunk.subarray(at, newline + 1), true);
      at = newline + 1;
    }
  }

  private segment(segment: Buffer, ended: boolean): void {
    const bytes = ended ? segment.subarray(0, segment.length - 1) : segment;
    if (this.recordHead.length < RECORD_HEAD_BYTES && bytes.length)
      this.recordHead = Buffer.concat([this.recordHead, bytes.subarray(0, RECORD_HEAD_BYTES - this.recordHead.length)]);
    if (!this.skipping) {
      this.lineEnd = this.offset + segment.length;
      this.frame(segment);
    }
    this.offset += segment.length;
    if (ended) {
      this.recordEnded();
    }
  }

  private recordEnded(): void {
    if (this.skipping) {
      this.skippedRecords++;
      if (this.recordHead.includes('"token_count"')) this.undercount = true;
      this.skipping = false;
    }
    this.recordHead = Buffer.alloc(0);
  }

  // A record that passes the recovery bounds is skipped, and the read goes on with the next record.
  private frame(bytes: Buffer): void {
    try {
      drain(frameRecovery(this.tee, bytes, this.offset, this.control));
    } catch (error) {
      if (!(error instanceof ForwardRecoveryLimit)) throw error;
      this.control.fragments = [];
      this.control.fragmentBytes = 0;
      this.control.oversized = null;
      this.skipping = true;
    }
  }

  // The session read and the windows, after the last chunk. A body without a line ending keeps its last record.
  finish(): {
    opening: CodexSessionMeta | null;
    read: SessionRead | null;
    titleLines: string[];
    tailLines: string[];
    tailBytes: number;
    tailWhole: boolean;
    spend: ReturnType<typeof createSpendLineScan> | null;
  } {
    if (this.control.fragmentBytes) {
      this.lineEnd = this.offset;
      this.frame(Buffer.from('\n'));
      this.recordEnded();
    } else if (this.skipping) this.recordEnded();
    return {
      opening: this.opening ?? null,
      read: this.reducer ? this.reducer.finish(this.offset) : null,
      titleLines: this.head,
      tailLines: this.tail.map((line) => line.text),
      tailBytes: this.tailBytes,
      tailWhole: !this.tailCut,
      spend: this.spend,
    };
  }
}

// The lines of the last `bytes` bytes of a tail, and how many bytes they take.
function linesWithin(lines: readonly string[], bytes: number): string[] {
  let held = 0;
  let at = lines.length;
  while (at > 0) {
    const next = Buffer.byteLength(lines[at - 1]) + 1;
    if (held + next > bytes) break;
    held += next;
    at--;
  }
  return lines.slice(at);
}

// The title entry that a plain rollout's metadata, recovery and turn start reads give.
function titleEntryOf(
  stat: FileRevision,
  opening: CodexSessionMeta | null,
  read: SessionRead | null,
  titleLines: readonly string[],
  tailLines: readonly string[],
  tailWhole: boolean,
): DerivedTitleEntry {
  const pair = codexTitlePairOfLines(titleLines);
  const label = pair.short ?? '';
  const agentPath = opening?.agentPath ?? null;
  const activityLines = linesWithin(tailLines, ACTIVITY_TAIL_BYTES);
  return {
    sourceIdentity: { dev: stat.dev, ino: stat.ino },
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    label,
    fullLabel: pair.full ?? '',
    activityMs: activityIn(activityLines),
    agentRun: opening ? isAgentRun(opening) : false,
    outcome: (read ? sessionOutcomeOf(read) : null) ?? codexOutcomeIn(activityLines, agentPath),
    stats: read ? sessionStatFactsOf(read) : null,
    expandedStatsRead: true,
    metadataWindow: { whole: true, windowBytes: ACTIVITY_TAIL_BYTES },
    starts: { starts: codexTurnStartsIn([...tailLines], agentPath), whole: tailWhole },
    foldedLabel: label.toLocaleLowerCase(),
  };
}

// An entry that an unreadable revision carries. A title of another generation stays as a carried name, because the
// new version stamps would show it as current.
function withoutOutdatedTitle(entry: CompressedFactEntry): CompressedFactEntry {
  if (!entry.title || compressedTitleCurrent(entry)) return entry;
  const { title, ...rest } = entry;
  return { ...rest, carriedName: rest.carriedName ?? { label: title.label, fullLabel: title.fullLabel } };
}

// The facts of one derivation, or null when the body held no record.
export function compressedFactsFromDerivation(
  file: string,
  read: Extract<CompressedStreamRead, { kind: 'decoded' }>,
  derivation: RolloutDerivation,
): CompressedFactEntry {
  const finished = derivation.finish();
  const stat = read.stat;
  const pairKey = compressedPairKey(file);
  return {
    file,
    pairKey,
    ...compressedEntryVersions(),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    hash: read.hash,
    threadId: sessionKeyOf(file, finished.opening),
    decodedLength: derivation.offset,
    skippedRecords: derivation.skippedRecords,
    undercount: derivation.undercount,
    complete: read.complete,
    title: titleEntryOf(
      stat,
      finished.opening,
      finished.read,
      finished.titleLines,
      finished.tailLines,
      finished.tailWhole,
    ),
    opening: finished.opening,
    ...(finished.spend
      ? {
          spend: finished.spend.finish({
            size: derivation.offset,
            mtimeMs: stat.mtimeMs,
            sourceIdentity: `${stat.dev}:${stat.ino}`,
          }),
        }
      : {}),
  };
}

export interface CompressedBackfillBatch {
  entries: CompressedFactEntry[];
  backfillMs: number;
}

export interface CompressedBackfillOptions {
  facts: CompressedStoreHolder;
  openings: CompressedStoreHolder;
  workspace: string;
  roots: readonly string[];
  launch: string;
  // True while a discovery, continuation or open request waits.
  busy: () => boolean;
  post: (batch: CompressedBackfillBatch) => void;
  // The entries of the facts store that the follower holds.
  known: () => ReadonlyMap<string, CompressedEntrySeed>;
  inFolders: (roots: readonly string[]) => (cwd: string) => boolean;
  now?: () => number;
  schedule?: (milliseconds: number, run: () => void) => () => void;
  yieldStep?: () => Promise<void>;
  wait?: (milliseconds: number) => Promise<void>;
  statOf?: typeof readRolloutStat;
  exists?: (file: string) => boolean;
  readFirst?: typeof readCompressedFirstRecord;
  stream?: typeof streamCompressedRollout;
  limits?: { recordBytes?: number; reduceAbove?: number; retainedBytes?: number };
}

type Job = { kind: 'opening' | 'body'; file: string; stat: NonNullable<ReturnType<typeof readRolloutStat>> };

// One worker holds one backfill per workspace store. Each list of names replaces the set, and a name that the list no
// longer holds leaves the queue when its current slice ends.
export class CompressedBackfill {
  private names: ReadonlySet<string> = new Set();
  private readonly events = new Set<string>();
  private readonly staleOpens = new Set<string>();
  private readonly results = new Map<string, CompressedFactEntry>();
  private readonly retries = new Map<string, { size: number; mtimeMs: number; attempts: number; at: number }>();
  private readonly openingEntries = new Map<string, CompressedFactEntry>();
  private openingsLoaded = false;
  private running = false;
  private dirty = false;
  private disposed = false;
  private inFolders: (cwd: string) => boolean;
  private rootsKey: string;
  private readonly stop = new AbortController();
  private readonly outbox: CompressedFactEntry[] = [];
  private cancelFlush: (() => void) | null = null;
  private cancelReplan: (() => void) | null = null;
  private lastFlush = -Infinity;
  private unpostedMs = 0;
  private readonly now: () => number;
  private readonly schedule: (milliseconds: number, run: () => void) => () => void;
  private readonly yieldStep: () => Promise<void>;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly statOf: typeof readRolloutStat;
  private readonly exists: (file: string) => boolean;
  private readonly readFirst: typeof readCompressedFirstRecord;
  private readonly stream: typeof streamCompressedRollout;

  constructor(private readonly options: CompressedBackfillOptions) {
    this.inFolders = options.inFolders(options.roots);
    this.rootsKey = JSON.stringify(options.roots);
    this.now = options.now ?? performance.now.bind(performance);
    this.schedule =
      options.schedule ??
      ((milliseconds, run) => {
        const timer = setTimeout(run, milliseconds);
        timer.unref();
        return () => clearTimeout(timer);
      });
    this.yieldStep = options.yieldStep ?? (() => new Promise((resolve) => setImmediate(resolve)));
    this.wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.statOf = options.statOf ?? readRolloutStat;
    this.exists = options.exists ?? ((file) => this.statOf(file) !== null);
    this.readFirst = options.readFirst ?? readCompressedFirstRecord;
    this.stream = options.stream ?? streamCompressedRollout;
  }

  // Each list from the host is the complete set. A name that a later list adds goes first.
  setNames(list: readonly string[]): void {
    const next = new Set(list);
    if (this.names.size) for (const name of next) if (!this.names.has(name)) this.events.add(name);
    this.names = next;
    this.dirty = true;
    void this.run();
  }

  // A failed adoption needs the twin's body, and no list of names follows it.
  noteAdoptionFailed(file: string): void {
    this.events.add(file);
    this.dirty = true;
    void this.run();
  }

  // A load repeats the roots every 10 seconds, so only a change of the roots plans again. Each repeat also checks the
  // files that failed, because a replaced file keeps its name.
  setRoots(roots: readonly string[]): void {
    const key = JSON.stringify(roots);
    if (key === this.rootsKey) {
      if (this.failedRevisionMoved()) {
        this.dirty = true;
        void this.run();
      }
      return;
    }
    this.rootsKey = key;
    this.inFolders = this.options.inFolders(roots);
    this.dirty = true;
    void this.run();
  }

  // An open read this rollout. A rollout whose stored entry is not current goes first.
  noteOpened(file: string): void {
    const stat = this.statOf(file);
    const entry = this.factsOf(file);
    if (!stat || (entry && compressedEntryCurrent(entry, stat) && entry.decodedLength !== undefined)) return;
    this.staleOpens.add(file);
    this.dirty = true;
    void this.run();
  }

  private failedRevisionMoved(): boolean {
    let moved = false;
    for (const [file, retry] of this.retries) {
      const stat = this.statOf(file);
      if (stat && stat.size === retry.size && stat.mtimeMs === retry.mtimeMs) continue;
      this.retries.delete(file);
      if (stat) this.events.add(file);
      moved = true;
    }
    return moved;
  }

  dispose(): void {
    this.disposed = true;
    this.stop.abort();
    this.cancelFlush?.();
    this.cancelFlush = null;
    this.cancelReplan?.();
    this.cancelReplan = null;
  }

  private factsOf(file: string): CompressedEntrySeed | undefined {
    return this.results.get(file) ?? this.options.known().get(file);
  }

  private async sliceEnd(slice: { bytes: number; started: number }): Promise<void> {
    this.unpostedMs += this.now() - slice.started;
    await this.yieldStep();
    await this.waitIdle();
    slice.bytes = 0;
    slice.started = this.now();
  }

  private async waitIdle(): Promise<void> {
    while (this.options.busy() && !this.disposed) await this.wait(BUSY_CHECK_MS);
  }

  private async run(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      while (!this.disposed) {
        if (this.dirty) {
          await this.waitIdle();
          if (this.disposed) return;
          try {
            await this.plan();
          } catch {
            this.replanLater();
            break;
          }
        }
        const job = this.queue.shift();
        if (!job) break;
        await this.waitIdle();
        if (this.disposed) return;
        // A name that a later list dropped, or that a plain rollout replaced, is no longer backfilled.
        if (!this.names.has(job.file) || this.exists(job.file.replace(/\.zst$/, ''))) continue;
        // Another window's backfill can decode a queued body while this one waits for the store lease.
        const stored = this.factsOf(job.file);
        if (
          stored &&
          compressedEntryCurrent(stored, job.stat) &&
          stored.decodedLength !== undefined &&
          !stored.unreadable
        )
          continue;
        try {
          if (job.kind === 'opening') await this.deriveOpening(job);
          else await this.deriveBody(job);
        } catch {
          // A throw on one file must not end the worker, or each new worker reaches the same file.
          await this.retryLater(job).catch(() => undefined);
        }
      }
    } finally {
      this.running = false;
    }
    if (this.dirty && !this.disposed) void this.run();
  }

  private queue: Job[] = [];

  // A plan step gives way to a waiting request, as a decode slice does.
  private async planYield(): Promise<void> {
    await this.yieldStep();
    await this.waitIdle();
  }

  private async plan(): Promise<void> {
    this.dirty = false;
    if (!this.openingsLoaded) {
      const openings = await readCompressedStoreInSteps(this.options.openings.directory, this.statOf, () =>
        this.planYield(),
      );
      for (const [file, entry] of openings.entries) this.openingEntries.set(file, entry);
      this.openingsLoaded = true;
    }
    const [events, adopted, unplaced, placed]: Job[][] = [[], [], [], []];
    const repairs: CompressedFactEntry[] = [];
    let started = this.now();
    for (const file of this.names) {
      if (this.disposed) return;
      if (this.now() - started >= PLAN_SLICE_MS) {
        await this.planYield();
        started = this.now();
      }
      try {
        this.planName(file, { events, adopted, unplaced, placed }, repairs);
      } catch {
        this.replanLater();
      }
    }
    placed.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
    this.queue = [...events, ...adopted, ...unplaced, ...placed];
    if (repairs.length) await this.appendOpenings(repairs);
  }

  private planName(
    file: string,
    { events, adopted, unplaced, placed }: { events: Job[]; adopted: Job[]; unplaced: Job[]; placed: Job[] },
    repairs: CompressedFactEntry[],
  ): void {
    const stat = this.statOf(file);
    if (!stat?.isFile || this.exists(file.replace(/\.zst$/, ''))) return;
    const retry = this.retries.get(file);
    if (retry && retry.size === stat.size && retry.mtimeMs === stat.mtimeMs && retry.at > this.now()) return;
    const entry = this.factsOf(file);
    const current = entry && compressedEntryCurrent(entry, stat);
    if (current && entry.decodedLength !== undefined && !entry.unreadable) {
      this.repairOpening(file, entry, stat, repairs);
      return;
    }
    if (current && entry.unreadable && entry.unreadableLaunch === this.options.launch) {
      this.retries.set(file, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        attempts: BACKFILL_RETRY_DELAYS_MS.length,
        at: Infinity,
      });
      return;
    }
    const job: Job = { kind: 'body', file, stat };
    if (this.events.delete(file) || entry?.adoptionFailed || this.staleOpens.delete(file)) {
      events.push(job);
      return;
    }
    if (entry?.adopted) {
      adopted.push(job);
      return;
    }
    const opening = this.placingOpening(file, entry, stat);
    if (opening === undefined) unplaced.push({ kind: 'opening', file, stat });
    else if (codexRowAdmitted(opening, stat, this.inFolders)) placed.push(job);
  }

  // A plan that could not read a name or the store runs again after the longest retry delay.
  private replanLater(): void {
    if (this.cancelReplan || this.disposed) return;
    const delay = BACKFILL_RETRY_DELAYS_MS[BACKFILL_RETRY_DELAYS_MS.length - 1];
    this.cancelReplan = this.schedule(delay, () => {
      this.cancelReplan = null;
      this.dirty = true;
      void this.run();
    });
  }

  // A stop can lose an opening write, so a current facts entry writes its opening again with no decode.
  private repairOpening(
    file: string,
    entry: CompressedEntrySeed,
    stat: { size: number; mtimeMs: number },
    repairs: CompressedFactEntry[],
  ): void {
    const held = this.openingEntries.get(file);
    if (!entry.opening || (held && compressedEntryCurrent(held, stat))) return;
    const opening = compressedOpeningEntry(entry);
    this.openingEntries.set(file, opening);
    repairs.push(opening);
  }

  private placingOpening(
    file: string,
    entry: CompressedEntrySeed | undefined,
    stat: { size: number; mtimeMs: number },
  ): CodexSessionMeta | null | undefined {
    if (entry?.opening !== undefined && entry.opening !== null) return entry.opening;
    const held = this.openingEntries.get(file);
    return held && compressedEntryCurrent(held, stat) ? (held.opening ?? null) : undefined;
  }

  private async appendOpenings(entries: CompressedFactEntry[]): Promise<void> {
    const written = await this.options.openings.append(entries);
    if (written.some((flushed) => !flushed)) await this.options.openings.durable(entries);
  }

  private async deriveOpening(job: Job): Promise<void> {
    const started = this.now();
    const report: { failed?: boolean } = {};
    let first: string | null = null;
    try {
      first = await this.readFirst(job.file, COMPRESSED_ENTRY_TITLE_BYTES, report);
    } catch {
      report.failed = true;
    }
    // A failed read is not a rollout without an opening, so it takes the retries and saves no current opening.
    if (report.failed) {
      await this.retryLater(job);
      return;
    }
    const opening = openingRecordOf(first);
    const entry: CompressedFactEntry = {
      file: job.file,
      pairKey: compressedPairKey(job.file),
      ...compressedEntryVersions(),
      size: job.stat.size,
      mtimeMs: job.stat.mtimeMs,
      threadId: sessionKeyOf(job.file, opening),
      opening,
    };
    this.openingEntries.set(job.file, entry);
    await this.appendOpenings([entry]);
    this.unpostedMs += this.now() - started;
    if (codexRowAdmitted(opening, job.stat, this.inFolders)) this.insertBody({ ...job, kind: 'body' });
  }

  // A body of a name that its opening placed joins the queue newest first, after the remaining openings.
  private insertBody(job: Job): void {
    let at = this.queue.length;
    while (at > 0) {
      const previous = this.queue[at - 1];
      if (previous.kind !== 'body' || previous.stat.mtimeMs >= job.stat.mtimeMs) break;
      at--;
    }
    this.queue.splice(at, 0, job);
  }

  private async deriveBody(job: Job): Promise<void> {
    const derivation = new RolloutDerivation(job.file, this.options.workspace, this.options.limits);
    const slice = { bytes: 0, started: this.now() };
    const read = await this.stream(
      job.file,
      async (chunk) => {
        derivation.push(chunk);
        slice.bytes += chunk.length;
        if (slice.bytes >= BACKFILL_SLICE_BYTES || this.now() - slice.started >= BACKFILL_SLICE_MS)
          await this.sliceEnd(slice);
      },
      { signal: this.stop.signal },
    );
    this.unpostedMs += this.now() - slice.started;
    if (this.disposed) return;
    if (read.kind === 'decoded' && read.complete) {
      await this.publish(compressedFactsFromDerivation(job.file, read, derivation));
      return;
    }
    // The stream changed during the read, so the next plan reads it again from the new revision.
    if (read.kind === 'stale') {
      this.dirty = true;
      return;
    }
    if (read.kind === 'decoded' || read.kind === 'failed') await this.retryLater(job);
  }

  // A zstd error or a cut twin runs again after each delay. Then the entry saves `unreadable`, and another launch tries it
  // once, because the stored mark holds the end of the count across launches. A new size or modification time restarts it.
  private async retryLater(job: Job): Promise<void> {
    const held = this.retries.get(job.file);
    const same = held && held.size === job.stat.size && held.mtimeMs === job.stat.mtimeMs;
    const stored = this.factsOf(job.file);
    const saved = stored?.unreadable && stored.size === job.stat.size && stored.mtimeMs === job.stat.mtimeMs;
    const attempts = same ? held.attempts : 0;
    if (saved || attempts >= BACKFILL_RETRY_DELAYS_MS.length) {
      this.retries.set(job.file, {
        size: job.stat.size,
        mtimeMs: job.stat.mtimeMs,
        attempts: BACKFILL_RETRY_DELAYS_MS.length,
        at: Infinity,
      });
      await this.publishUnreadable(job);
      return;
    }
    const delay = BACKFILL_RETRY_DELAYS_MS[attempts];
    const retry = { size: job.stat.size, mtimeMs: job.stat.mtimeMs, attempts: attempts + 1, at: this.now() + delay };
    this.retries.set(job.file, retry);
    // The timer can fire before `at` by the loop's cached time, so the firing itself marks the retry due.
    this.schedule(delay, () => {
      retry.at = -Infinity;
      this.dirty = true;
      void this.run();
    });
  }

  // An unreadable revision keeps the title, the spend record and the completeness that the store holds, so a failed decode
  // neither lowers a shown total nor blanks a row. A store that does not answer publishes nothing, and the entry stays.
  private async publishUnreadable(job: Job): Promise<void> {
    const previous = this.factsOf(job.file);
    const hasFacts = !!previous && !previous.nameOnly && !previous.adoptionFailed;
    const stored = hasFacts ? await this.storedEntry(job.file) : undefined;
    if (hasFacts && !stored) return;
    await this.publish({
      ...(stored ? withoutOutdatedTitle(stored) : { complete: false, nameOnly: true }),
      decodedLength: undefined,
      file: job.file,
      pairKey: previous?.pairKey || compressedPairKey(job.file),
      ...compressedEntryVersions(),
      size: job.stat.size,
      mtimeMs: job.stat.mtimeMs,
      unreadable: true,
      unreadableLaunch: this.options.launch,
    });
  }

  // The worker holds no title or spend for an entry it did not derive, so the whole entry comes from the store.
  private async storedEntry(file: string): Promise<CompressedFactEntry | undefined> {
    const held = this.results.get(file);
    if (held) return held;
    return (await readCompressedStoreInSteps(this.options.facts.directory, this.statOf, this.yieldStep)).entries.get(
      file,
    );
  }

  // Each derivation is on disk before the next one starts.
  private async publish(next: CompressedFactEntry): Promise<void> {
    let previous: CompressedFactEntry | undefined = this.results.get(next.file) ?? this.options.known().get(next.file);
    // Only a marked derivation needs the stored spend record, so the worker holds no spend for the other entries.
    if (next.undercount && !next.unreadable && !previous?.spend)
      previous =
        (await readCompressedStoreInSteps(this.options.facts.directory, this.statOf, this.yieldStep)).entries.get(
          next.file,
        ) ?? previous;
    const entry = boundedCompressedEntry(withKeptUndercount(previous, next));
    const [written] = await this.options.facts.append([entry]);
    if (!written && !(await this.options.facts.durable([entry]))) return;
    this.results.set(entry.file, entry);
    if (entry.opening) {
      const opening = compressedOpeningEntry(entry);
      this.openingEntries.set(entry.file, opening);
      await this.appendOpenings([opening]);
    }
    this.outbox.push(entry);
    this.armFlush();
  }

  private armFlush(): void {
    if (this.cancelFlush || !this.outbox.length || this.disposed) return;
    this.cancelFlush = this.schedule(Math.max(0, this.lastFlush + BATCH_INTERVAL_MS - this.now()), () => {
      this.cancelFlush = null;
      this.flush();
    });
  }

  // At most one batch per second, of 4 MiB or one larger record.
  private flush(): void {
    if (!this.outbox.length || this.disposed) return;
    if (this.cancelFlush || this.now() < this.lastFlush + BATCH_INTERVAL_MS) return this.armFlush();
    const [batch] = compressedEntryBatches(this.outbox, COMPRESSED_BATCH_BYTES);
    this.outbox.splice(0, batch.length);
    this.lastFlush = this.now();
    const backfillMs = Math.round(this.unpostedMs);
    this.unpostedMs -= backfillMs;
    this.options.post({ entries: batch, backfillMs });
    this.armFlush();
  }
}
