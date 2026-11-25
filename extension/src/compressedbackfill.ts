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
  isHiddenThread,
  openingRecordOf,
  observeRolloutStat,
  readRolloutStat,
  ROLLOUT_NAME,
  type CodexSessionMeta,
} from './codex';
import {
  COMPRESSED_REPAIR_LIMIT,
  readCompressedFirstRecord,
  sameCompressedRepair,
  sameStat,
  streamCompressedRollout,
  type CompressedRepair,
  type CompressedStreamRead,
} from './compressedrollouts';
import {
  COMPRESSED_BATCH_BYTES,
  COMPRESSED_ENTRY_TITLE_BYTES,
  boundedCompressedEntry,
  compareCompressedEntries,
  reconcileCompressedEntries,
  compressedEntryBatches,
  compressedEntryCurrent,
  compressedEntryConflicts,
  compressedEntryIdentity,
  compressedFactsSameOwner,
  compressedEntrySame,
  compressedEntrySeed,
  compressedEntryVersions,
  compressedOpeningEntry,
  compressedByteObservation,
  compareCompressedObservations,
  compressedPairKey,
  compressedSpendOrigin,
  compressedTitleCurrent,
  readCompressedRecord,
  readCompressedStoreInSteps,
  sessionKeyOf,
  withKeptUndercount,
  type CompressedEntrySeed,
  type CompressedFactEntry,
  CompressedStoreFollower,
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
  supportedFileIdentity,
} from './transcript';

// A slice decodes one file and ends after this much output or this much time.
export const BACKFILL_SLICE_BYTES = 4 * 1024 * 1024;
export const BACKFILL_SLICE_MS = 50;
const PLAN_SLICE_MS = 25;
// How often a held slice checks that no request waits. The longest wait of a discovery request is one slice.
const BUSY_CHECK_MS = 50;
// The longest time a discovery request waits for a slice, because a slow read can outlast the slice's own limits.
export const BACKFILL_TURN_LIMIT_MS = 100;
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
  const threadId = sessionKeyOf(file, finished.opening);
  const spend = finished.spend?.finish({
    size: derivation.offset,
    mtimeMs: stat.mtimeMs,
    sourceIdentity: `${stat.dev}:${stat.ino}`,
  });
  return {
    file,
    pairKey: compressedPairKey(file),
    ...compressedEntryVersions(),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    fileIdentity: { dev: stat.dev, ino: stat.ino },
    hash: read.hash,
    threadId,
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
    ...(spend ? { spend, spendOrigin: compressedSpendOrigin(threadId, spend, read.hash) } : {}),
  };
}

export interface HiddenCompressedOpening {
  file: string;
  sessionId: string;
  cwd: string;
  size: number;
  mtimeMs: number;
}

export interface CompressedBackfillBatch {
  hiddenOpenings?: HiddenCompressedOpening[];
  retiredRepairs?: CompressedRepair[];
  repairScope?: number;
  entries: CompressedFactEntry[];
  backfillMs: number;
}

export interface CompressedBackfillOptions {
  facts: Pick<CompressedStoreHolder, 'directory' | 'append' | 'durable'> &
    Partial<Pick<CompressedStoreHolder, 'appendCarryingFacts' | 'recordOf'>>;
  openings: CompressedStoreHolder;
  workspace: string;
  roots: readonly string[];
  launch: string;
  // True while a discovery, continuation or open request waits.
  busy: () => boolean;
  // True while a window or page read runs. A reader waits on that read, so no slice takes a turn ahead of it.
  reading?: () => boolean;
  post: (batch: CompressedBackfillBatch) => void;
  // The entries of the facts store that the follower holds.
  known: () => ReadonlyMap<string, CompressedEntrySeed>;
  readKnown?: (file: string) => CompressedFactEntry | undefined;
  follower?: CompressedStoreFollower;
  inFolders: (roots: readonly string[]) => (cwd: string) => boolean;
  now?: () => number;
  wallNow?: () => number;
  schedule?: (milliseconds: number, run: () => void) => () => void;
  yieldStep?: () => Promise<void>;
  wait?: (milliseconds: number) => Promise<void>;
  statOf?: typeof readRolloutStat;
  observeStat?: typeof observeRolloutStat;
  exists?: (file: string) => boolean;
  readFirst?: typeof readCompressedFirstRecord;
  stream?: typeof streamCompressedRollout;
  readStore?: typeof readCompressedStoreInSteps;
  limits?: { recordBytes?: number; reduceAbove?: number; retainedBytes?: number };
}

type AdoptedPlacement = { entry: CompressedEntrySeed; opening?: CodexSessionMeta | null; pending?: true };

// Priority keeps an event or an added name first through both opening placement and body scheduling.
type Job = {
  kind: 'opening' | 'body';
  file: string;
  stat: NonNullable<ReturnType<typeof readRolloutStat>>;
  priority?: boolean;
  opening?: CodexSessionMeta;
  machine?: CompressedFactEntry;
  adoption?: AdoptedPlacement;
  repair?: CompressedRepair;
};

// One worker holds one backfill per workspace store. Each list of names replaces the set. A name that the list no longer
// holds leaves the queue, its running decode stops, and it publishes nothing.
export class CompressedBackfill {
  private names: ReadonlySet<string> = new Set();
  private readonly events = new Set<string>();
  private readonly waitingPlacements = new Set<string>();
  private readonly added = new Set<string>();
  private readonly repairs = new Map<string, CompressedRepair>();
  private readonly repairQueue = new Map<string, Job>();
  private activeJob?: Job;
  private readonly staleOpens = new Set<string>();
  private readonly results = new Map<string, CompressedEntrySeed>();
  private readonly retries = new Map<
    string,
    { stat: Job['stat']; attempts: number; at: number; job?: Job; cancel?: () => void }
  >();
  private readonly openingEntries = new Map<string, CompressedFactEntry>();
  private readonly adoptedPlacements = new Map<string, AdoptedPlacement>();
  private readonly machineOpenings = new Map<string, CompressedFactEntry>();
  private readonly checkedMachineOpenings = new Map<
    string,
    { machine: CompressedFactEntry; opening: CodexSessionMeta | null }
  >();
  private readonly openingsInput: CompressedStoreFollower;
  private readonly openingsAbort = new AbortController();
  private openingsRead?: Promise<void>;
  private running = false;
  private dirty = false;
  private disposed = false;
  private inFolders: (cwd: string) => boolean;
  private rootsKey: string;
  private repairScope?: number;
  private decoding: { file: string; controller: AbortController } | null = null;
  private readonly outbox = new Map<string, { entry: CompressedFactEntry; job: Job }>();
  private readonly sent = new Map<string, CompressedEntrySeed>();
  private readonly retiredRepairs = new Map<string, CompressedRepair>();
  private readonly hiddenOpeningsSent = new Map<string, HiddenCompressedOpening>();
  private readonly hiddenOpeningsOwed = new Map<string, HiddenCompressedOpening>();
  private cancelFlush: (() => void) | null = null;
  private cancelReplan: (() => void) | null = null;
  private turnEnded: (() => void) | null = null;
  private cancelTurnLimit: (() => void) | null = null;
  private wake: (() => void) | null = null;
  private lastFlush = -Infinity;
  private unpostedMs = 0;
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private readonly schedule: (milliseconds: number, run: () => void) => () => void;
  private readonly yieldStep: () => Promise<void>;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly statOf: typeof readRolloutStat;
  private readonly observeStat: typeof observeRolloutStat;
  private readonly exists: (file: string) => boolean;
  private readonly readFirst: typeof readCompressedFirstRecord;
  private readonly stream: typeof streamCompressedRollout;
  private readonly readStore: typeof readCompressedStoreInSteps;

  constructor(private readonly options: CompressedBackfillOptions) {
    this.inFolders = options.inFolders(options.roots);
    this.rootsKey = JSON.stringify(options.roots);
    this.now = options.now ?? performance.now.bind(performance);
    this.wallNow = options.wallNow ?? Date.now;
    this.schedule =
      options.schedule ??
      ((milliseconds, run) => {
        const timer = setTimeout(run, milliseconds);
        timer.unref();
        return () => clearTimeout(timer);
      });
    this.yieldStep = options.yieldStep ?? (() => new Promise((resolve) => setImmediate(resolve)));
    this.wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.observeStat = options.observeStat ?? options.statOf ?? observeRolloutStat;
    this.statOf = options.statOf ?? ((file) => this.observeStat(file) ?? null);
    this.exists = options.exists ?? ((file) => this.statOf(file) !== null);
    this.readFirst = options.readFirst ?? readCompressedFirstRecord;
    this.stream = options.stream ?? streamCompressedRollout;
    this.readStore = options.readStore ?? readCompressedStoreInSteps;
    this.openingsInput = CompressedStoreFollower.forOpenings(options.openings.directory, this.yieldStep, (entry) =>
      this.noteMachineOpening(entry),
    );
  }

  // Each list from the host is the complete set. A name that a later list adds goes first.
  setNames(list: readonly string[]): void {
    const next = new Set(list);
    if (this.names.size) for (const name of next) if (!this.names.has(name)) this.added.add(name);
    for (const jobs of [this.added, this.events, this.staleOpens, this.waitingPlacements])
      for (const name of jobs) if (!next.has(name)) jobs.delete(name);
    this.names = next;
    for (const file of this.checkedMachineOpenings.keys())
      if (!next.has(file)) this.checkedMachineOpenings.delete(file);
    this.refreshMachineOpenings();
    for (const [file, repair] of this.repairs) if (!next.has(file)) this.endRepair(repair, true);
    for (const held of [this.outbox, this.sent, this.results, this.adoptedPlacements]) {
      for (const file of held.keys()) if (!next.has(file)) held.delete(file);
    }
    for (const [file, retry] of this.retries) {
      if (next.has(file)) continue;
      retry.cancel?.();
      this.retries.delete(file);
    }
    for (const name of this.hiddenOpeningsSent.keys()) {
      if (next.has(name)) continue;
      this.hiddenOpeningsSent.delete(name);
      this.hiddenOpeningsOwed.delete(name);
    }
    if (this.decoding && !next.has(this.decoding.file)) this.decoding.controller.abort();
    this.dirty = true;
    void this.run();
  }

  // A listed revision can change without a change in the list. Queue only the accepted revisions.
  acceptRepairs(requested: readonly CompressedRepair[]): CompressedRepair[] {
    const accepted: CompressedRepair[] = [];
    for (const repair of requested.slice(0, COMPRESSED_REPAIR_LIMIT)) {
      const { file } = repair;
      const held = this.repairs.get(file);
      if (!held && this.repairs.size >= COMPRESSED_REPAIR_LIMIT) continue;
      const stat = this.observeStat(file);
      if (stat === undefined && this.names.has(file)) continue;
      if (
        !this.names.has(file) ||
        (repair.cwd !== undefined && !this.inFolders(repair.cwd)) ||
        !stat?.isFile ||
        !sameStat(stat, repair) ||
        this.exists(file.replace(/\.zst$/, ''))
      ) {
        if (held && sameCompressedRepair(held, repair)) this.endRepair(held, true);
        else {
          this.retiredRepairs.set(file, repair);
          this.armFlush();
        }
        if (stat?.isFile && !sameStat(stat, repair)) this.noteReplacement(file);
        continue;
      }
      accepted.push(repair);
      if (held && sameCompressedRepair(held, repair)) continue;
      if (held) this.endRepair(held, false);
      this.retiredRepairs.delete(file);
      this.repairs.set(file, repair);
      const entry = this.factsOf(file, stat);
      const adoption = this.adoptedPlacement(file, entry, stat);
      const opening = this.placingOpening(file, entry, stat, adoption);
      const opened =
        opening && this.repairOpeningMatches(repair, opening) && codexRowAdmitted(opening, stat, this.inFolders);
      this.repairQueue.set(file, {
        file,
        adoption,
        stat,
        kind: opened ? 'body' : 'opening',
        repair,
        opening: opened ? opening : undefined,
        machine: this.machineOpening(file, stat),
      });
      if (this.activeJob?.file === file && !this.jobCurrent(this.activeJob)) this.decoding?.controller.abort();
    }
    if (accepted.length) void this.run();
    return accepted;
  }

  private jobAllowed(job: Job): boolean {
    if (this.disposed || !this.names.has(job.file) || this.exists(job.file.replace(/\.zst$/, ''))) return false;
    return !job.repair || this.repairs.get(job.file) === job.repair;
  }

  private jobRevision(job: Job): boolean | undefined {
    if (!this.jobAllowed(job) || (job.opening && !codexRowAdmitted(job.opening, job.stat, this.inFolders))) {
      if (job.repair) this.endRepair(job.repair, true);
      return false;
    }
    if (this.openingsRead) return undefined;
    const stat = this.observeStat(job.file);
    if (stat === undefined) return undefined;
    if (stat?.isFile && stat.size > 0) {
      if (sameStat(job.stat, stat)) {
        const machine = this.machineOpening(job.file, stat);
        if (job.machine !== machine) {
          this.requeue({ ...job, kind: 'opening', opening: undefined, machine });
          return false;
        }
        const followed = this.options.known().get(job.file);
        const local = this.results.get(job.file);
        const adoption =
          job.adoption || followed?.adopted || local?.adopted || this.adoptedPlacements.has(job.file)
            ? this.adoptedPlacement(job.file, this.factsOf(job.file, stat), stat)
            : undefined;
        if (adoption?.pending) return false;
        if (job.adoption === adoption) return true;
        if (job.repair) {
          this.requeue({ ...job, kind: 'opening', opening: undefined, adoption });
        } else this.noteReplacement(job.file);
        return false;
      }
      this.noteReplacement(job.file);
    }
    if (job.repair) this.endRepair(job.repair, true);
    return false;
  }

  private jobCurrent(job: Job): boolean {
    return this.jobRevision(job) === true;
  }

  private noteReplacement(file: string): void {
    if (!this.names.has(file)) return;
    this.events.add(file);
    void this.run();
  }

  private repairOpeningMatches(repair: CompressedRepair, opening: CodexSessionMeta | null | undefined): boolean {
    return repair.sessionId === undefined || (opening?.sessionId === repair.sessionId && opening.cwd === repair.cwd);
  }

  private repairFactMatches(repair: CompressedRepair, entry: CompressedFactEntry): boolean {
    return (
      !entry.spendNeedsRepair &&
      compressedEntryCurrent(entry, repair) &&
      (entry.unreadable ? entry.unreadableLaunch === this.options.launch : entry.decodedLength !== undefined) &&
      (entry.unreadable && !entry.opening
        ? repair.sessionId === undefined || entry.threadId === repair.sessionId
        : this.repairOpeningMatches(repair, entry.opening) &&
          !!entry.opening?.cwd &&
          this.inFolders(entry.opening.cwd) &&
          !isHiddenThread(entry.opening))
    );
  }

  private endRepair(repair: CompressedRepair, retired: boolean): void {
    const { file } = repair;
    if (this.repairs.get(file) !== repair) return;
    this.repairs.delete(file);
    this.repairQueue.delete(file);
    const retry = this.retries.get(file);
    if (retry?.job?.repair === repair) {
      retry.cancel?.();
      this.retries.delete(file);
    }
    if (retired) {
      this.retiredRepairs.set(file, repair);
      this.armFlush();
    }
  }

  private requeue(job: Job): void {
    if (!job.repair) {
      this.events.add(job.file);
    } else if (this.jobAllowed(job)) {
      this.repairQueue.set(job.file, job);
    }
  }

  // The twin still needs a body decode after adoption.
  noteAdoption(entry: CompressedFactEntry, pending = false): void {
    this.notePlacementObservation(entry, pending);
    if (!pending) this.noteReplacement(entry.file);
  }

  private notePlacementObservation(entry: CompressedFactEntry, pending = false): void {
    const { file } = entry;
    if (!this.names.has(file) || (!entry.adopted && !this.adoptedPlacements.has(file))) return;
    const held = this.adoptedPlacements.get(file);
    const stat = this.statOf(file);
    if (!stat || !compressedEntryCurrent(entry, stat)) return;
    const next = this.adoptedPlacement(file, entry, stat);
    if (!next || next.entry.hash !== entry.hash) return;
    if (next === held && (!held.pending || pending)) return;
    next.pending = pending ? true : undefined;
    const retry = this.retries.get(file);
    if (retry) {
      retry.cancel?.();
      this.retries.delete(file);
    }
    if (this.decoding?.file === file && next !== held) this.decoding.controller.abort();
    if (!pending) {
      const repair = this.repairs.get(file);
      if (repair && sameStat(repair, stat))
        this.requeue({
          kind: 'opening',
          file,
          stat,
          priority: true,
          adoption: next,
          repair,
          machine: this.machineOpening(file, stat),
        });
      this.noteReplacement(file);
    }
  }

  private adoptedPlacement(
    file: string,
    entry: CompressedEntrySeed | undefined,
    stat: Job['stat'],
  ): AdoptedPlacement | undefined {
    const matches = (candidate: CompressedEntrySeed) =>
      candidate.size === stat.size && candidate.mtimeMs === stat.mtimeMs && !compressedEntryConflicts(candidate, stat);
    let held = this.adoptedPlacements.get(file);
    if (held && !matches(held.entry)) {
      this.adoptedPlacements.delete(file);
      held = undefined;
    }
    if (!entry || (entry.adopted ? !matches(entry) : !held || !compressedEntryCurrent(entry, stat))) return held;
    if (held) {
      const before = compressedByteObservation(held.entry);
      const next = compressedByteObservation(entry);
      if (next && (!before || compareCompressedObservations(next, before) > 0)) {
        if (held.entry.hash === entry.hash) {
          held.entry = compressedEntrySeed(entry);
          return held;
        }
      } else return held;
    }
    const placement = { entry: compressedEntrySeed(entry) };
    this.adoptedPlacements.set(file, placement);
    return placement;
  }

  // A load repeats the roots every 10 seconds, so only a change of the roots plans again. Each repeat also checks the
  // files that failed, because a replaced file keeps its name.
  setRoots(roots: readonly string[]): void {
    this.refreshMachineOpenings();
    const key = JSON.stringify(roots);
    if (key === this.rootsKey) {
      const moved = this.failedRevisionMoved();
      for (const file of this.waitingPlacements) this.events.add(file);
      this.waitingPlacements.clear();
      if (moved || this.events.size) void this.run();
      return;
    }
    this.rootsKey = key;
    this.clearRepairs();
    this.inFolders = this.options.inFolders(roots);
    this.dirty = true;
    void this.run();
  }

  setRepairScope(scope: number): void {
    if (scope === this.repairScope) return;
    this.repairScope = scope;
    this.clearRepairs();
  }

  private clearRepairs(): void {
    for (const repair of this.repairs.values()) this.endRepair(repair, false);
    this.retiredRepairs.clear();
    if (this.activeJob?.repair) this.decoding?.controller.abort();
  }

  // An open read this rollout. A rollout whose stored entry is not current goes first.
  noteOpened(file: string): void {
    const stat = this.statOf(file);
    const entry = this.factsOf(file, stat);
    if (!stat || (entry && compressedEntryCurrent(entry, stat) && entry.decodedLength !== undefined)) return;
    this.staleOpens.add(file);
    void this.run();
  }

  private failedRevisionMoved(): boolean {
    let moved = false;
    for (const [file, retry] of this.retries) {
      const stat = this.observeStat(file);
      if (stat === undefined) continue;
      if (sameStat(stat, retry.stat)) {
        if (retry.job?.repair && !this.jobAllowed(retry.job)) {
          this.endRepair(retry.job.repair, true);
          continue;
        }
        if (!retry.cancel && retry.job && retry.at <= this.now()) {
          this.requeue(retry.job);
          moved = true;
        }
        continue;
      }
      if (retry.job?.repair) this.endRepair(retry.job.repair, true);
      else {
        retry.cancel?.();
        this.retries.delete(file);
      }
      if (stat?.isFile && stat.size > 0) this.events.add(file);
      moved = true;
    }
    if (this.outbox.size) this.armFlush();
    return moved;
  }

  dispose(): void {
    this.disposed = true;
    this.openingsAbort.abort();
    this.decoding?.controller.abort();
    this.endTurn();
    this.cancelFlush?.();
    this.cancelFlush = null;
    this.cancelReplan?.();
    this.cancelReplan = null;
    for (const retry of this.retries.values()) retry.cancel?.();
  }

  // Only a sent record can be excluded from a later follow.
  published(entry: CompressedFactEntry): boolean {
    const held = this.sent.get(entry.file);
    return !!held && compressedEntrySame(held, entry);
  }

  followed(entry: CompressedFactEntry): void {
    const queued = this.outbox.get(entry.file);
    const matched = !!queued && compressedEntrySame(queued.entry, entry);
    if (matched) this.outbox.delete(entry.file);
    this.noteSent(entry, matched);
    this.notePlacementObservation(entry);
    if (entry.adopted) this.noteReplacement(entry.file);
  }

  private noteSent(entry: CompressedFactEntry, fromOutbox: boolean): void {
    if (fromOutbox) {
      const local = this.results.get(entry.file);
      this.sent.set(entry.file, local && compressedEntrySame(local, entry) ? local : compressedEntrySeed(entry));
    }
    const repair = this.repairs.get(entry.file);
    if (repair && this.repairFactMatches(repair, entry) && sameStat(repair, this.statOf(entry.file)))
      this.endRepair(repair, false);
  }

  private factsOf(file: string, stat: Job['stat'] | null): CompressedEntrySeed | undefined {
    const local = this.results.get(file);
    const followed = this.options.known().get(file);
    if (!local || !followed) return local ?? followed;
    return (
      reconcileCompressedEntries(local, followed, stat) ??
      (compareCompressedEntries(followed, local, stat) > 0 ? followed : local)
    );
  }

  private async sliceEnd(slice: { bytes: number; started: number }): Promise<void> {
    this.unpostedMs += this.now() - slice.started;
    await this.yieldStep();
    await this.waitIdle();
    slice.bytes = 0;
    slice.started = this.now();
  }

  // Lets one slice end while discovery requests wait, and resolves when it ended. A parked backfill starts the slice, and
  // a decode in work ends the slice it holds. The result is null when a reader waits, or at any other step of the backfill.
  takeTurn(): Promise<void> | null {
    if (
      (!this.wake && (!this.decoding || this.activeJob?.kind !== 'body')) ||
      this.disposed ||
      this.options.reading?.()
    )
      return null;
    return new Promise((resolve) => {
      this.turnEnded = resolve;
      this.cancelTurnLimit = this.schedule(BACKFILL_TURN_LIMIT_MS, () => {
        this.cancelTurnLimit = null;
        this.endTurn();
      });
      this.wake?.();
    });
  }

  // A store write can wait on another window's lease. The backfill ends a held turn before each store write and each read
  // of the facts store, and it grants no turn during them. A read of the openings store in a plan is synchronous between
  // its yields, and its first yield ends a held turn.
  private endTurn(): void {
    this.cancelTurnLimit?.();
    this.cancelTurnLimit = null;
    this.turnEnded?.();
    this.turnEnded = null;
  }

  // Every call follows a finished step of work, so it ends a turn that waited on that step.
  private async waitIdle(): Promise<void> {
    this.endTurn();
    while (this.options.busy() && !this.disposed && !this.turnEnded) await this.pause();
  }

  // Lasts until the next busy check, or until a turn starts.
  private pause(): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        if (this.wake === wake) this.wake = null;
        resolve();
      };
      this.wake = wake;
      void this.wait(BUSY_CHECK_MS).then(wake);
    });
  }

  private async run(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      while (!this.disposed) {
        if (this.openingsRead) await this.openingsRead;
        if (this.disposed) return;
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
        if (this.events.size || this.staleOpens.size) {
          await this.waitIdle();
          if (this.disposed) return;
          await this.planEvents();
        }
        const targeted = this.repairQueue.values().next().value;
        const job = targeted ?? this.queue.shift();
        if (!job) break;
        if (targeted) this.repairQueue.delete(job.file);
        await this.waitIdle();
        if (this.disposed) return;
        const current = this.jobRevision(job);
        if (!current) {
          if (current === undefined) this.waitForRevision(job);
          continue;
        }
        const stored = this.factsOf(job.file, job.stat);
        const observed =
          (!job.adoption || job.adoption.entry.hash === stored?.hash) &&
          (!stored || !this.machineOpeningConflicts(job.machine, stored));
        if (job.repair && observed && (!job.adoption || job.kind === 'body') && this.replayRepair(job)) continue;
        if (
          !job.repair &&
          observed &&
          stored?.decodedLength !== undefined &&
          !stored.unreadable &&
          compressedEntryCurrent(stored, job.stat)
        ) {
          this.added.delete(job.file);
          continue;
        }
        const retry = this.retries.get(job.file);
        if (retry && sameStat(retry.stat, job.stat) && retry.at > this.now()) {
          if (job.repair) retry.job = job;
          continue;
        }
        if (job.repair && this.restoreRepairRetry(job)) continue;
        this.activeJob = job;
        try {
          if (job.kind === 'opening') await this.deriveOpening(job);
          else {
            this.added.delete(job.file);
            await this.deriveBody(job);
          }
        } catch {
          // A throw on one file must not end the worker, or each new worker reaches the same file.
          await this.retryLater(job).catch(() => undefined);
        } finally {
          this.activeJob = undefined;
        }
      }
    } finally {
      this.running = false;
      this.endTurn();
    }
    if ((this.dirty || this.events.size || this.staleOpens.size) && !this.disposed) void this.run();
  }

  private waitForRevision(job: Job): void {
    const retry = this.retries.get(job.file);
    if (retry && sameStat(retry.stat, job.stat)) {
      if (retry.cancel) return;
      if (retry.at <= this.now()) {
        retry.job = job;
        return;
      }
    }
    const waiting = { stat: job.stat, attempts: retry?.attempts ?? 0, at: 0, job };
    this.retries.set(job.file, waiting);
    this.retryAfter(job, waiting, BACKFILL_RETRY_DELAYS_MS[0]);
  }

  private replayRepair(job: Job): boolean {
    const repair = job.repair!;
    const queued = this.outbox.get(job.file);
    if (queued && this.repairFactMatches(repair, queued.entry)) return true;
    const known = this.factsOf(job.file, job.stat);
    if (!known || !this.repairFactMatches(repair, known)) return false;
    const full = this.readContributor(known);
    if (!full) {
      this.waitForRevision(job);
      return true;
    }
    if (!this.repairFactMatches(repair, full)) return false;
    this.outbox.set(job.file, { entry: full, job });
    this.armFlush();
    return true;
  }

  private restoreRepairRetry(job: Job): boolean {
    const retryHeld = this.retries.get(job.file);
    if (retryHeld && sameStat(retryHeld.stat, job.stat)) return false;
    const entry = this.openingEntries.get(job.file);
    const saved = entry?.repairRetry;
    if (
      !entry ||
      !saved ||
      (job.machine && (!entry.opening || this.machineOpeningConflicts(job.machine, entry))) ||
      saved.launch !== this.options.launch ||
      !sameCompressedRepair(saved.source, job.repair!) ||
      !Number.isInteger(saved.attempts) ||
      saved.attempts < 1 ||
      saved.attempts > BACKFILL_RETRY_DELAYS_MS.length ||
      !Number.isFinite(saved.at) ||
      !compressedEntryCurrent(entry, job.stat)
    )
      return false;
    const delay = Math.max(0, Math.min(saved.at - this.wallNow(), BACKFILL_RETRY_DELAYS_MS[saved.attempts - 1]));
    const retry = { stat: job.stat, attempts: saved.attempts, at: 0, job };
    this.retries.set(job.file, retry);
    if (!delay) return false;
    this.retryAfter(job, retry, delay);
    return true;
  }

  private queue: Job[] = [];

  // A plan step gives way to a waiting request, as a decode slice does.
  private async planYield(): Promise<void> {
    await this.yieldStep();
    await this.waitIdle();
  }

  private refreshMachineOpenings(): void {
    if (this.openingsRead || !this.names.size || this.disposed) return;
    this.openingsRead = this.openingsInput.follow(this.openingsAbort.signal).then(
      () => this.machineOpeningsRead(),
      () => this.machineOpeningsRead(),
    );
  }

  private machineOpeningsRead(): void {
    this.openingsRead = undefined;
    if (this.disposed) return;
    this.armFlush();
    if (this.events.size || this.repairQueue.size) void this.run();
  }

  private noteMachineOpening(entry: CompressedFactEntry): void {
    if (this.disposed) return;
    const { file } = entry;
    const versions = compressedEntryVersions();
    if (
      entry.factsVersion !== versions.factsVersion ||
      entry.codexMetaVersion !== versions.codexMetaVersion ||
      entry.metadataGeneration !== versions.metadataGeneration ||
      entry.spendGeneration !== versions.spendGeneration
    )
      return;
    if (entry.repairRetry) {
      const held = this.openingEntries.get(file);
      if (!held || compareCompressedEntries(entry, held, null) > 0) this.openingEntries.set(file, entry);
      return;
    }
    if (entry.opening === undefined) return;
    const held = this.machineOpenings.get(file);
    if (held && this.sameMachinePlacement(held, entry)) {
      if (compareCompressedEntries(entry, held, null) > 0) {
        held.storeRecord = entry.storeRecord;
        held.factsOrder = entry.factsOrder;
      }
      return;
    }
    if (held && compareCompressedEntries(entry, held, this.names.has(file) ? this.statOf(file) : null) <= 0) return;
    this.machineOpenings.set(file, entry);
    this.checkedMachineOpenings.delete(file);
    if (!this.names.has(file)) return;
    if (!held && this.dirty && !this.activeJob && !this.queue.length && !this.repairQueue.size) return;
    this.events.add(file);
    const retry = this.retries.get(file);
    retry?.cancel?.();
    this.retries.delete(file);
    this.hiddenOpeningsOwed.delete(file);
    const repair = this.repairs.get(file);
    if (repair && retry?.job?.repair === repair)
      this.requeue({ ...retry.job, kind: 'opening', opening: undefined, machine: entry });
    if (this.decoding?.file === file) this.decoding.controller.abort();
  }

  private sameMachinePlacement(left: CompressedFactEntry, right: CompressedFactEntry): boolean {
    const a = compressedEntryIdentity(left);
    const b = compressedEntryIdentity(right);
    return (
      !!a === !!b &&
      (!a || (String(a.dev) === String(b?.dev) && String(a.ino) === String(b?.ino))) &&
      left.size === right.size &&
      left.mtimeMs === right.mtimeMs &&
      left.hash === right.hash &&
      (left.physicalOpening === true) === (right.physicalOpening === true) &&
      left.threadId === right.threadId &&
      !this.machineOpeningConflicts(left, right)
    );
  }

  private machineOpening(file: string, stat: Job['stat']): CompressedFactEntry | undefined {
    const entry = this.machineOpenings.get(file);
    return entry &&
      compressedEntryCurrent(entry, stat) &&
      (!supportedFileIdentity(stat) || !!compressedEntryIdentity(entry) || !entry.threadId)
      ? entry
      : undefined;
  }

  private machineOpeningConflicts(machine: CompressedFactEntry | undefined, entry: CompressedEntrySeed): boolean {
    return (
      !!machine &&
      ((machine.hash !== undefined && entry.hash !== undefined && machine.hash !== entry.hash) ||
        (entry.opening !== undefined &&
          (machine.opening?.sessionId !== entry.opening?.sessionId ||
            machine.opening?.cwd !== entry.opening?.cwd ||
            !!(machine.opening && isHiddenThread(machine.opening)) !==
              !!(entry.opening && isHiddenThread(entry.opening)) ||
            !!(machine.opening && isAgentRun(machine.opening)) !== !!(entry.opening && isAgentRun(entry.opening)))))
    );
  }

  private async plan(): Promise<void> {
    this.dirty = false;
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

  private async planEvents(): Promise<void> {
    const affected = new Set([...this.events, ...this.staleOpens]);
    const events: Job[] = [];
    const openings: CompressedFactEntry[] = [];
    let started = this.now();
    for (const file of affected) {
      if (this.now() - started >= PLAN_SLICE_MS) {
        await this.planYield();
        started = this.now();
      }
      if (this.disposed) return;
      try {
        this.planName(file, { events, adopted: events, unplaced: events, placed: events }, openings);
      } catch {
        this.replanLater();
      }
    }
    this.queue = [...events, ...this.queue.filter(({ file }) => !affected.has(file))];
    if (openings.length) await this.appendOpenings(openings);
  }

  private planName(
    file: string,
    { events, adopted, unplaced, placed }: { events: Job[]; adopted: Job[]; unplaced: Job[]; placed: Job[] },
    repairs: CompressedFactEntry[],
  ): void {
    const event = this.events.delete(file) || this.waitingPlacements.has(file);
    const stale = this.staleOpens.delete(file);
    if (!this.names.has(file)) return;
    const stat = this.observeStat(file);
    if (stat === undefined) this.waitingPlacements.add(file);
    else this.waitingPlacements.delete(file);
    if (!stat?.isFile || stat.size === 0 || this.exists(file.replace(/\.zst$/, ''))) return;
    const retry = this.retries.get(file);
    if (retry && sameStat(retry.stat, stat) && retry.at > this.now()) return;
    const entry = this.factsOf(file, stat);
    const adoption = this.adoptedPlacement(file, entry, stat);
    if (adoption?.pending) return;
    const machine = this.machineOpening(file, stat);
    const current =
      entry &&
      compressedEntryCurrent(entry, stat) &&
      (!adoption || adoption.entry.hash === entry.hash) &&
      !this.machineOpeningConflicts(machine, entry);
    if (current && entry.decodedLength !== undefined && !entry.unreadable) {
      this.noteHiddenOpening(file, entry.opening, stat);
      this.added.delete(file);
      this.repairOpening(file, entry, stat, repairs);
      return;
    }
    if (current && entry.unreadable && entry.unreadableLaunch === this.options.launch) {
      this.retries.set(file, {
        stat,
        attempts: BACKFILL_RETRY_DELAYS_MS.length,
        at: Infinity,
      });
      return;
    }
    const priority = event || stale || !!entry?.adoptionFailed || this.added.has(file);
    const opening = this.placingOpening(file, entry, stat, adoption);
    this.noteHiddenOpening(file, opening, stat);
    if (opening === undefined) {
      (priority ? events : unplaced).push({ kind: 'opening', file, stat, priority, adoption, machine });
    } else if (opening && codexRowAdmitted(opening, stat, this.inFolders)) {
      const job: Job = { kind: 'body', file, stat, opening, priority, adoption, machine };
      if (priority) events.push(job);
      else if (entry?.adopted && current) adopted.push(job);
      else placed.push(job);
    } else this.added.delete(file);
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
    stat: Job['stat'],
    repairs: CompressedFactEntry[],
  ): void {
    const held = this.machineOpening(file, stat) ?? this.openingEntries.get(file);
    if (
      entry.adopted ||
      entry.unreadable ||
      !entry.opening ||
      (held?.physicalOpening === true && !held.repairRetry && compressedEntryCurrent(held, stat))
    )
      return;
    const opening = compressedOpeningEntry(entry);
    this.openingEntries.set(file, opening);
    repairs.push(opening);
  }

  private placingOpening(
    file: string,
    entry: CompressedEntrySeed | undefined,
    stat: Job['stat'],
    adoption = this.adoptedPlacement(file, entry, stat),
  ): CodexSessionMeta | null | undefined {
    const machine = this.machineOpening(file, stat);
    if (machine) {
      const checked = this.checkedMachineOpenings.get(file);
      if (checked?.machine === machine) return checked.opening;
      if (
        machine.physicalOpening !== true ||
        (adoption && machine.hash !== adoption.entry.hash) ||
        (entry &&
          (!entry.adopted || machine.hash !== entry.hash) &&
          compressedEntryCurrent(entry, stat) &&
          this.machineOpeningConflicts(machine, entry))
      )
        return undefined;
      return machine.opening ?? null;
    }
    if (adoption?.opening !== undefined) return adoption.opening;
    const current = (candidate: CompressedEntrySeed) =>
      compressedEntryCurrent(candidate, stat) &&
      (!supportedFileIdentity(stat) ||
        !!compressedEntryIdentity(candidate) ||
        (!candidate.adopted && !candidate.threadId));
    if (!adoption && entry?.opening && !entry.unreadable && current(entry)) return entry.opening;
    const held = this.openingEntries.get(file);
    return held?.physicalOpening === true &&
      !held.repairRetry &&
      current(held) &&
      (!adoption || held.hash === adoption.entry.hash)
      ? (held.opening ?? null)
      : undefined;
  }

  private machineOpeningMatches(file: string, entry: CompressedEntrySeed, stat: Job['stat']): boolean {
    const machine = this.machineOpening(file, stat);
    const local = this.openingEntries.get(file);
    const held =
      machine && this.checkedMachineOpenings.get(file)?.machine === machine && local?.physicalOpening === true
        ? local
        : (machine ?? local);
    return (
      held?.physicalOpening === true &&
      !held.repairRetry &&
      compressedEntryCurrent(held, stat) &&
      held.threadId === entry.threadId &&
      !this.machineOpeningConflicts(held, entry)
    );
  }

  private async appendOpenings(entries: CompressedFactEntry[], eligible?: () => boolean | undefined): Promise<void> {
    this.endTurn();
    const written = await this.options.openings.append(entries, eligible);
    if (written.some((flushed) => !flushed)) await this.options.openings.durable(entries);
  }

  private async deriveOpening(job: Job): Promise<void> {
    const started = this.now();
    const report: { failed?: boolean; stale?: boolean } = {};
    let first: string | null = null;
    const controller = job.adoption || job.machine ? new AbortController() : undefined;
    if (controller) this.decoding = { file: job.file, controller };
    try {
      first = await this.readFirst(
        job.file,
        COMPRESSED_ENTRY_TITLE_BYTES,
        report,
        job.stat,
        controller && { signal: controller.signal },
      );
    } catch {
      report.failed = true;
    } finally {
      if (controller) this.decoding = null;
    }
    if (this.openingsRead) await this.openingsRead;
    const current = this.jobRevision(job);
    if (!current || report.stale) {
      if (current === undefined || current) this.waitForRevision(job);
      return;
    }
    // A failed read can retry without recording an opening.
    if (job.adoption && !first) {
      this.waitForRevision(job);
      return;
    }
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
      ...(supportedFileIdentity(job.stat) ? { fileIdentity: { dev: job.stat.dev!, ino: job.stat.ino! } } : {}),
      threadId: sessionKeyOf(job.file, opening),
      opening,
      physicalOpening: true,
      hash: job.machine ? undefined : job.adoption?.entry.hash,
    };
    if (job.machine) this.checkedMachineOpenings.set(job.file, { machine: job.machine, opening });
    if (job.machine?.physicalOpening !== true || this.machineOpeningConflicts(job.machine, entry)) {
      this.openingEntries.set(job.file, entry);
      await this.appendOpenings([entry], () => this.jobRevision(job));
    }
    const afterWrite = this.jobRevision(job);
    if (!afterWrite) {
      if (afterWrite === undefined) this.waitForRevision(job);
      return;
    }
    if (job.adoption) job.adoption.opening = opening;
    this.noteHiddenOpening(job.file, opening, job.stat);
    this.unpostedMs += this.now() - started;
    if (!codexRowAdmitted(opening, job.stat, this.inFolders)) {
      if (job.repair) this.endRepair(job.repair, true);
      this.added.delete(job.file);
      return;
    }
    const body: Job = { ...job, kind: 'body', opening: opening! };
    if (job.repair && !this.repairOpeningMatches(job.repair, opening)) {
      this.endRepair(job.repair, true);
      delete body.repair;
    }
    if (body.repair) this.requeue(body);
    else if (job.priority) this.queue.unshift(body);
    else this.insertBody(body);
  }

  // A guardian needs no body read. The host checks its opening again only if an Antigravity row claims its ID.
  private noteHiddenOpening(
    file: string,
    opening: CodexSessionMeta | null | undefined,
    stat: { size: number; mtimeMs: number },
  ): void {
    if (!opening?.sessionId || !opening.cwd || !isHiddenThread(opening) || !this.inFolders(opening.cwd)) {
      this.hiddenOpeningsSent.delete(file);
      this.hiddenOpeningsOwed.delete(file);
      return;
    }
    const previous = this.hiddenOpeningsSent.get(file);
    if (
      previous?.sessionId === opening.sessionId &&
      previous.cwd === opening.cwd &&
      previous.size === stat.size &&
      previous.mtimeMs === stat.mtimeMs
    )
      return;
    const hiddenOpening = {
      file,
      sessionId: opening.sessionId,
      cwd: opening.cwd,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
    this.hiddenOpeningsSent.set(file, hiddenOpening);
    this.hiddenOpeningsOwed.set(file, hiddenOpening);
    this.armFlush();
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
    const decoding = { file: job.file, controller: new AbortController() };
    this.decoding = decoding;
    const read = await this.stream(
      job.file,
      async (chunk) => {
        derivation.push(chunk);
        slice.bytes += chunk.length;
        if (slice.bytes >= BACKFILL_SLICE_BYTES || this.now() - slice.started >= BACKFILL_SLICE_MS)
          await this.sliceEnd(slice);
      },
      { signal: decoding.controller.signal, expected: job.stat },
    ).finally(() => {
      this.decoding = null;
    });
    this.unpostedMs += this.now() - slice.started;
    if (this.openingsRead) await this.openingsRead;
    const current = this.jobRevision(job);
    if (current === false) return;
    if (read.kind === 'decoded' && read.complete) {
      const entry = compressedFactsFromDerivation(job.file, read, derivation);
      if ((job.repair || entry.opening) && !codexRowAdmitted(entry.opening ?? null, job.stat, this.inFolders)) {
        this.noteHiddenOpening(job.file, entry.opening, job.stat);
        if (job.repair) this.endRepair(job.repair, true);
        return;
      }
      if (job.repair && !this.repairOpeningMatches(job.repair, entry.opening)) {
        this.endRepair(job.repair, true);
        job = { ...job, repair: undefined };
      }
      if (!(await this.publish(entry, job)) && job.repair && this.jobCurrent(job)) await this.retryLater(job);
      return;
    }
    // The stream changed during the read, so the next plan reads it again from the new revision.
    if (read.kind === 'stale' || current === undefined) {
      this.waitForRevision(job);
      return;
    }
    if (read.kind !== 'cancelled') await this.retryLater(job);
  }

  // A zstd error, a cut twin, a file that does not open or a missing decoder runs again after each delay. A rollout that
  // left the disk ends at the next plan, which finds no file. After the last delay the entry saves `unreadable`, and
  // another launch tries it once, because the stored mark holds the end of the count across launches.
  // A new revision restarts the count.
  private async retryLater(job: Job): Promise<void> {
    const current = this.jobRevision(job);
    if (!current) {
      if (current === undefined) this.waitForRevision(job);
      return;
    }
    const held = this.retries.get(job.file);
    const same = held && sameStat(held.stat, job.stat);
    const stored = this.factsOf(job.file, job.stat);
    const saved = stored?.unreadable && compressedEntryCurrent(stored, job.stat);
    const attempts = same ? held.attempts : 0;
    if (saved || attempts >= BACKFILL_RETRY_DELAYS_MS.length) {
      const ended = {
        stat: job.stat,
        attempts: BACKFILL_RETRY_DELAYS_MS.length,
        at: Infinity,
        job,
      };
      this.retries.set(job.file, ended);
      // A mark that did not reach the disk waits for the last retry delay before a later plan reads the name again.
      if (!(await this.publishUnreadable(job)))
        this.retryAfter(job, ended, BACKFILL_RETRY_DELAYS_MS[BACKFILL_RETRY_DELAYS_MS.length - 1]);
      return;
    }
    const delay = BACKFILL_RETRY_DELAYS_MS[attempts];
    const retry = { stat: job.stat, attempts: attempts + 1, at: 0, job };
    this.retries.set(job.file, retry);
    if (job.repair) {
      const opening = job.opening;
      const held = this.openingEntries.get(job.file);
      const hash = job.adoption?.entry.hash ?? (held?.opening === opening ? held?.hash : undefined);
      const { dev, ino, size, mtimeMs } = job.stat;
      const checkpoint: CompressedFactEntry = {
        file: job.file,
        pairKey: compressedPairKey(job.file),
        ...compressedEntryVersions(),
        size,
        mtimeMs,
        ...(dev !== undefined && ino !== undefined ? { fileIdentity: { dev, ino } } : {}),
        threadId: sessionKeyOf(job.file, opening) ?? job.repair.sessionId,
        ...(opening && { opening, physicalOpening: true, hash }),
        repairRetry: {
          launch: this.options.launch,
          source: job.repair,
          attempts: retry.attempts,
          at: this.wallNow() + delay,
        },
      };
      this.openingEntries.set(job.file, checkpoint);
      await this.appendOpenings([checkpoint], () => this.jobRevision(job)).catch(() => undefined);
    }
    this.retryAfter(job, retry, delay);
  }

  private retryAfter(job: Job, retry: { at: number; job?: Job; cancel?: () => void }, delay: number): void {
    if (this.disposed || this.retries.get(job.file) !== retry) return;
    retry.cancel?.();
    retry.at = this.now() + delay;
    // The timer can fire before `at` by the loop's cached time, so the firing itself marks the retry due.
    retry.cancel = this.schedule(delay, () => {
      if (this.retries.get(job.file) !== retry) return;
      retry.cancel = undefined;
      retry.at = -Infinity;
      const current = this.jobRevision(job);
      if (current) this.requeue(retry.job ?? job);
      else if (current === false) this.retries.delete(job.file);
      void this.run();
    });
  }

  // An unreadable revision keeps the title, the spend record and the completeness that the store holds, so a failed decode
  // neither lowers a shown total nor blanks a row. A store that does not answer publishes nothing, the entry stays and a
  // later plan runs. The result is true when the mark reached the disk.
  private async publishUnreadable(job: Job): Promise<boolean> {
    const previous = this.factsOf(job.file, job.stat);
    const opening = this.placingOpening(job.file, previous, job.stat);
    const { size, mtimeMs, dev, ino } = job.stat;
    const failed: CompressedFactEntry = {
      file: job.file,
      pairKey: previous?.pairKey || compressedPairKey(job.file),
      ...compressedEntryVersions(),
      size,
      mtimeMs,
      ...(supportedFileIdentity(job.stat) ? { fileIdentity: { dev: dev!, ino: ino! } } : {}),
      threadId: opening?.sessionId ?? job.repair?.sessionId,
      opening,
      unreadable: true,
      unreadableLaunch: this.options.launch,
    };
    if (this.options.facts.appendCarryingFacts)
      return this.publish({ ...failed, complete: false, nameOnly: true }, job);
    const hasFacts = previous && !previous.nameOnly && !previous.adoptionFailed && !previous.spendNeedsRepair;
    const stored = hasFacts ? await this.storedEntry(previous) : undefined;
    if (hasFacts && !stored) return false;
    if (!stored || stored.spendNeedsRepair || !compressedFactsSameOwner(stored, failed))
      return this.publish({ ...failed, complete: false, nameOnly: true }, job, previous);
    const sameRevision = compressedEntryCurrent(stored, job.stat);
    return this.publish(
      {
        ...withoutOutdatedTitle(stored),
        ...failed,
        hash: sameRevision ? stored.hash : undefined,
        spendOrigin: stored.spend
          ? {
              ...(stored.spendOrigin ?? compressedSpendOrigin(stored.threadId, stored.spend, stored.hash)),
              retained: true,
            }
          : undefined,
        decodedLength: undefined,
      },
      job,
      previous,
    );
  }

  private readContributor(seed: CompressedEntrySeed): CompressedFactEntry | undefined {
    const { file, storeRecord } = seed;
    if (storeRecord) return readCompressedRecord(this.options.facts.directory, file, storeRecord);
    const entry = this.options.readKnown?.(file);
    return entry && compressedEntrySame(entry, seed) ? entry : undefined;
  }

  private async storedEntry(seed: CompressedEntrySeed): Promise<CompressedFactEntry | undefined> {
    const entry = this.readContributor(seed);
    if (entry || seed.storeRecord || this.options.readKnown) return entry;
    return (await this.readFacts())?.get(seed.file);
  }

  // The entries of the facts store, or null when a store file gave no answer, because a compaction can retire a file during the read.
  private async readFacts(): Promise<ReadonlyMap<string, CompressedFactEntry> | null> {
    this.endTurn();
    let failed = false;
    const read = await this.readStore(this.options.facts.directory, this.statOf, this.yieldStep, () => {
      failed = true;
    });
    return failed ? null : read.entries;
  }

  // Each derivation is on disk before the next one starts. The result is true when the entry reached the disk.
  private async publish(next: CompressedFactEntry, job: Job, unreadableDonor?: CompressedEntrySeed): Promise<boolean> {
    this.endTurn();
    if (this.openingsRead) await this.openingsRead;
    if (this.options.facts.appendCarryingFacts) {
      const entry = await this.options.facts.appendCarryingFacts(
        next,
        () => this.jobRevision(job),
        this.options.follower,
      );
      if (!entry) return false;
      const current = this.jobRevision(job);
      if (current === false) return false;
      await this.publishedEntry(entry, job);
      return true;
    }
    const { stat } = job;
    if (!this.jobCurrent(job)) {
      if (!job.repair) this.dirty = true;
      return false;
    }
    const marked = next.undercount && !next.unreadable;
    const resolveDonor = marked || next.unreadable;
    const donor = next.unreadable ? unreadableDonor : marked ? this.factsOf(next.file, stat) : undefined;
    let previous: CompressedFactEntry | undefined;
    if (
      marked &&
      donor &&
      !donor.spendNeedsRepair &&
      !donor.nameOnly &&
      !donor.adoptionFailed &&
      (compressedFactsSameOwner(donor, next) || (!donor.storeRecord && !this.options.readKnown))
    ) {
      previous = await this.storedEntry(donor);
      if (!previous && (donor.hasSpend || !donor.storeRecord || donor.spendOrigin)) {
        if (!job.repair) this.replanLater();
        return false;
      }
    }
    const revisionHolds = () => {
      if (!this.jobCurrent(job)) return false;
      if (!resolveDonor) return true;
      const current = this.factsOf(next.file, stat);
      return current === donor || (!!current && !!donor && compressedEntrySame(current, donor));
    };
    const entry = boundedCompressedEntry(withKeptUndercount(previous, next));
    const [written] = await this.options.facts.append([entry], revisionHolds);
    // An entry that did not reach the disk plans its name again.
    if (!written && !(await this.options.facts.durable([entry]))) {
      if (!job.repair) this.dirty = true;
      return false;
    }
    if (!revisionHolds()) {
      if (!job.repair) this.dirty = true;
      return false;
    }
    const record = this.options.facts.recordOf?.(entry);
    await this.publishedEntry(record ? { ...entry, storeRecord: record } : entry, job);
    return true;
  }

  private async publishedEntry(entry: CompressedFactEntry, job: Job): Promise<void> {
    this.results.set(entry.file, compressedEntrySeed(entry));
    if (!entry.unreadable && !job.repair) {
      this.retries.get(entry.file)?.cancel?.();
      this.retries.delete(entry.file);
    }
    this.outbox.set(entry.file, { entry, job });
    // A held opening of this revision needs no second write.
    if (!entry.unreadable && entry.opening && !this.machineOpeningMatches(entry.file, entry, job.stat)) {
      const opening = compressedOpeningEntry(entry);
      this.openingEntries.set(entry.file, opening);
      await this.appendOpenings([opening], () => this.jobRevision(job));
    }
    this.armFlush();
  }

  private armFlush(): void {
    if (this.cancelFlush || !this.owesBatch() || this.disposed) return;
    this.cancelFlush = this.schedule(Math.max(0, this.lastFlush + BATCH_INTERVAL_MS - this.now()), () => {
      this.cancelFlush = null;
      this.flush();
    });
  }

  private owesBatch(): boolean {
    return !!(this.outbox.size || this.hiddenOpeningsOwed.size || this.retiredRepairs.size);
  }

  // At most one batch per second, of 4 MiB or one larger record.
  private flush(): void {
    if (!this.owesBatch() || this.disposed || this.openingsRead) return;
    if (this.cancelFlush || this.now() < this.lastFlush + BATCH_INTERVAL_MS) return this.armFlush();
    const [batch] = compressedEntryBatches<CompressedFactEntry | HiddenCompressedOpening>(
      [...[...this.outbox.values()].map(({ entry }) => entry), ...this.hiddenOpeningsOwed.values()],
      COMPRESSED_BATCH_BYTES,
    );
    const entries: CompressedFactEntry[] = [];
    const hiddenOpenings: HiddenCompressedOpening[] = [];
    for (const entry of batch ?? []) {
      if (!('pairKey' in entry)) {
        this.hiddenOpeningsOwed.delete(entry.file);
        hiddenOpenings.push(entry);
        continue;
      }
      const held = this.outbox.get(entry.file)!;
      const current = this.jobRevision(held.job);
      if (current === undefined) continue;
      this.outbox.delete(entry.file);
      if (current) entries.push(entry);
    }
    const retiredRepairs = [...this.retiredRepairs.values()].slice(0, COMPRESSED_REPAIR_LIMIT);
    for (const repair of retiredRepairs) this.retiredRepairs.delete(repair.file);
    this.lastFlush = this.now();
    const backfillMs = Math.round(this.unpostedMs);
    this.unpostedMs -= backfillMs;
    this.options.post({
      entries,
      backfillMs,
      ...(hiddenOpenings.length ? { hiddenOpenings } : {}),
      ...(retiredRepairs.length ? { retiredRepairs, repairScope: this.repairScope } : {}),
    });
    for (const entry of entries) this.noteSent(entry, true);
    if (entries.length || hiddenOpenings.length || retiredRepairs.length) this.armFlush();
  }
}

// Runs discovery requests one at a time. A request that arrives during another waits, and a newer request replaces it.
// After the first complete discovery reply of the worker, a request waits for one backfill slice when the backfill is
// parked between slices or decodes a slice and no reader waits, so a chain of continuations leaves the backfill a share
// of the worker. A parked backfill starts the slice, and a decode in work ends the slice it holds. At any other step of
// the backfill, such as a plan or a store call, the request starts at once. Until that reply each request starts at
// once. A slice in work finishes beside a request that starts at once or that reaches the limit of its wait.
export class DiscoveryQueue<Message extends { id: number }> {
  private running = false;
  private waiting: Message | undefined;
  private completeReply = false;

  constructor(
    private readonly options: {
      execute: (message: Message) => Promise<unknown>;
      // Answers a request that will not run.
      drop: (message: Message) => void;
      backfills: () => Iterable<CompressedBackfill>;
    },
  ) {}

  get busy(): boolean {
    return this.running || !!this.waiting;
  }

  get hasWaiting(): boolean {
    return !!this.waiting;
  }

  // True after the first complete discovery reply of the worker. A backfill gets no turn from discovery before it.
  get repliedComplete(): boolean {
    return this.completeReply;
  }

  noteReply(value: { kind: string; complete?: boolean }): void {
    if (value.kind === 'claude-children' && value.complete) this.completeReply = true;
  }

  submit(message: Message): void {
    if (this.running) {
      if (this.waiting) this.options.drop(this.waiting);
      this.waiting = message;
      return;
    }
    const slice = this.slice();
    if (!slice) {
      this.run(message);
      return;
    }
    this.running = true;
    this.waiting = message;
    void slice.then(() => this.release());
  }

  cancel(id: number): void {
    if (this.waiting?.id !== id) return;
    this.options.drop(this.waiting);
    this.waiting = undefined;
  }

  private slice(): Promise<unknown> | null {
    if (!this.completeReply) return null;
    const turns = [...this.options.backfills()].flatMap((backfill) => backfill.takeTurn() ?? []);
    return turns.length ? Promise.all(turns) : null;
  }

  private run(message: Message): void {
    this.running = true;
    void this.options.execute(message).finally(() => {
      if (!this.waiting) {
        this.running = false;
        return;
      }
      void (this.slice() ?? Promise.resolve()).then(() => setImmediate(() => this.release()));
    });
  }

  private release(): void {
    const waiting = this.waiting;
    this.waiting = undefined;
    this.running = false;
    if (waiting) this.run(waiting);
  }
}
