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
  addsCompressedRepairEvidence,
  addsCompressedRepairProof,
  readCompressedFirstRecord,
  sameCompressedRepair,
  sameCompressedRepairClaim,
  sameCompressedPlacement,
  sameStat,
  streamCompressedRollout,
  type CompressedOpeningEvidence,
  type CompressedPlacement,
  type CompressedRepair,
  type CompressedRepairEvidence,
  type CompressedRepairReceipt,
  type CompressedRepairSettlement,
  type CompressedStreamRead,
} from './compressedrollouts';
import {
  COMPRESSED_BATCH_BYTES,
  COMPRESSED_ENTRY_TITLE_BYTES,
  boundedCompressedEntry,
  compareCompressedEntries,
  reconcileCompressedEntries,
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
const BATCH_FILE_LIMIT = 16;
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

export interface CompressedBackfillBatch {
  placements?: CompressedPlacement[];
  retiredRepairs?: CompressedRepairReceipt[];
  repairEvidence?: CompressedRepairEvidence[];
  repairScope?: number;
  repairStores?: { facts: string; openings: string };
  entries: CompressedFactEntry[];
  memberships?: [string, number][];
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

type DeliveryPaths = { stat: ReturnType<typeof observeRolloutStat>; plain: boolean | undefined };
type PlacementState = {
  observed?: { placement: CompressedPlacement; machine?: CompressedFactEntry };
  posted?: CompressedPlacement;
  resumed?: boolean;
  disputed?: CompressedPlacement['revision'];
  pending?: boolean;
};

type PlannedOpening = {
  entry: CompressedFactEntry;
  stat: Job['stat'];
  membership?: number;
  machine?: CompressedFactEntry;
  verified?: Job;
};
type PersistenceWait = { resume?: () => void };

type AdoptedPlacement = { entry: CompressedEntrySeed; opening?: CodexSessionMeta | null; pending?: true };

// Priority keeps an event or an added name first through both opening placement and body scheduling.
type Job = {
  kind: 'opening' | 'body';
  file: string;
  stat: NonNullable<ReturnType<typeof readRolloutStat>>;
  generation: number;
  membership?: number;
  priority?: boolean;
  recheck?: boolean;
  opening?: CodexSessionMeta;
  machine?: CompressedFactEntry;
  verifiedOpening?: CompressedFactEntry;
  adoption?: AdoptedPlacement;
  repair?: CompressedRepair;
};

// One worker holds one backfill per workspace store. Each list of names replaces the set. A name that the list no longer
// holds leaves the queue, its running decode stops, and it publishes nothing.
export class CompressedBackfill {
  private names: ReadonlySet<string> = new Set();
  private memberships?: ReadonlyMap<string, number>;
  private readonly needsPhysical = new Set<string>();
  private readonly events = new Set<string>();
  private readonly waitingPlacements = new Set<string>();
  private readonly added = new Set<string>();
  private readonly repairs = new Map<string, CompressedRepair>();
  private readonly repairQueue = new Map<string, Job>();
  private activeJob?: Job;
  private persistence?: PersistenceWait;
  private endStep?: () => void;
  private readonly plannedOpenings = new Map<string, PlannedOpening>();
  private readonly deferredOpenings = new Map<string, PlannedOpening & { follow: number }>();
  private readonly openingMisses = new Map<string, CompressedRepairSettlement>();
  private readonly restoredRepairs = new Set<string>();
  private readonly seenRepairEvidence = new Map<string, CompressedRepairEvidence>();
  private readonly pendingRepairEvidence = new Map<string, CompressedRepairEvidence>();
  private readonly staleOpens = new Set<string>();
  private readonly results = new Map<string, CompressedEntrySeed>();
  private readonly retries = new Map<
    string,
    { stat: Job['stat']; attempts: number; at: number; job?: Job; cancel?: () => void }
  >();
  private readonly retryEntries = new Map<string, CompressedFactEntry>();
  private readonly adoptedPlacements = new Map<string, AdoptedPlacement>();
  private readonly machineOpenings = new Map<string, CompressedFactEntry>();
  private readonly checkedMachineOpenings = new Map<
    string,
    { machine: CompressedFactEntry; opening: CodexSessionMeta | null }
  >();
  private readonly openingsInput: CompressedStoreFollower;
  private readonly openingsAbort = new AbortController();
  private openingsPending = false;
  private openingsRead?: Promise<void>;
  private running = false;
  private dirty = false;
  private disposed = false;
  private inFolders: (cwd: string) => boolean;
  private rootsKey: string;
  private repairScope?: number;
  private generation = 0;
  private scopePending = false;
  private decoding: { file: string; controller: AbortController } | null = null;
  private readonly outbox = new Map<string, { entry: CompressedFactEntry; job: Job }>();
  private readonly sent = new Map<string, CompressedEntrySeed>();
  private readonly retiredRepairs = new Map<string, CompressedRepairReceipt>();
  private readonly placements = new Map<string, PlacementState>();
  private readonly flushReady = new Set<string>();
  private readonly flushParked = new Map<string, number>();
  private follow = 0;
  private flushDue = false;
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
    this.readFirst = options.readFirst ?? readCompressedFirstRecord;
    this.stream = options.stream ?? streamCompressedRollout;
    this.readStore = options.readStore ?? readCompressedStoreInSteps;
    this.openingsInput = CompressedStoreFollower.forOpenings(
      options.openings.directory,
      () => this.planYield(),
      (entry) => this.noteMachineOpening(entry),
    );
  }

  // Each list from the host is the complete set. A name that a later list adds goes first.
  setNames(
    list: readonly string[],
    memberships?: readonly number[],
    settlements?: readonly CompressedRepairSettlement[],
  ): void {
    const next = new Set(list);
    const lifetimes = memberships && new Map(list.map((file, index) => [file, memberships[index]]));
    const retained = (file: string) => next.has(file) && this.memberships?.get(file) === lifetimes?.get(file);
    const returned = new Set<string>();
    for (const file of next) {
      if (retained(file) && this.names.has(file)) continue;
      if (this.names.size) this.added.add(file);
      if (this.memberships && lifetimes) returned.add(file);
    }
    for (const jobs of [
      this.added,
      this.events,
      this.staleOpens,
      this.waitingPlacements,
      this.flushReady,
      this.restoredRepairs,
      this.needsPhysical,
    ])
      for (const name of jobs) if (!retained(name)) jobs.delete(name);
    for (const file of returned) {
      this.needsPhysical.add(file);
      this.added.add(file);
    }
    for (const file of this.flushParked.keys()) if (!retained(file)) this.flushParked.delete(file);
    for (const file of this.checkedMachineOpenings.keys())
      if (!retained(file)) this.checkedMachineOpenings.delete(file);
    for (const [file, repair] of this.repairs) if (!retained(file)) this.endRepair(repair, false);
    for (const held of [
      this.outbox,
      this.sent,
      this.results,
      this.adoptedPlacements,
      this.plannedOpenings,
      this.deferredOpenings,
      this.openingMisses,
      this.seenRepairEvidence,
      this.pendingRepairEvidence,
      this.retiredRepairs,
    ]) {
      for (const file of held.keys()) if (!retained(file)) held.delete(file);
    }
    for (const [file, retry] of this.retries) {
      if (retained(file)) continue;
      retry.cancel?.();
      this.retries.delete(file);
    }
    for (const [file, state] of this.placements) {
      if (retained(file)) continue;
      if (next.has(file) && state.posted) this.placements.set(file, { posted: state.posted, resumed: true });
      else this.placements.delete(file);
    }
    if (this.decoding && !retained(this.decoding.file)) this.decoding.controller.abort();
    this.names = next;
    this.memberships = lifetimes;
    if (settlements) this.restoreRepairSettlements(settlements);
    this.refreshMachineOpenings();
    this.dirty = true;
    void this.run();
  }

  // A listed revision can change without a change in the list. Queue only the accepted revisions.
  acceptRepairs(requested: readonly CompressedRepair[]): CompressedRepair[] {
    const accepted: CompressedRepair[] = [];
    for (const repair of requested.slice(0, COMPRESSED_REPAIR_LIMIT)) {
      const { file } = repair;
      if (repair.membership !== this.memberships?.get(file)) continue;
      const held = this.repairs.get(file);
      if (!held && this.repairs.size >= COMPRESSED_REPAIR_LIMIT) continue;
      const stat = this.observeStat(file);
      const plain = stat?.isFile ? this.plainPresent(file) : false;
      if (this.names.has(file) && (stat === undefined || plain === undefined)) continue;
      if (
        !this.names.has(file) ||
        (repair.cwd !== undefined && !this.inFolders(repair.cwd)) ||
        !stat?.isFile ||
        stat.size === 0 ||
        !sameStat(stat, repair) ||
        plain
      ) {
        if (held && sameCompressedRepairClaim(held, repair)) this.endRepair(held, true);
        else this.retireRepair(repair);
        if (stat?.isFile && !sameStat(stat, repair)) this.noteReplacement(file);
        continue;
      }
      accepted.push(repair);
      if (held && sameCompressedRepairClaim(held, repair)) continue;
      if (held) this.endRepair(held, false);
      this.retiredRepairs.delete(file);
      this.repairs.set(file, repair);
      const entry = this.factsOf(file, stat);
      const adoption = this.adoptedPlacement(file, entry, stat);
      const opening = this.placingOpening(file, entry, stat, adoption);
      const opened =
        !this.needsPhysical.has(file) &&
        opening &&
        this.repairOpeningMatches(repair, opening) &&
        codexRowAdmitted(opening, stat, this.inFolders);
      const job: Job = {
        file,
        adoption,
        stat,
        generation: this.generation,
        membership: this.memberships?.get(file),
        recheck: this.needsPhysical.has(file),
        kind: opened ? 'body' : 'opening',
        repair,
        opening: opened ? opening : undefined,
        machine: this.machineOpening(file, stat),
      };
      const miss = this.matchingOpeningMiss(job);
      if (miss) this.endRepair(repair, true, miss);
      else this.repairQueue.set(file, job);
      if (this.activeJob?.file === file && !this.jobCurrent(this.activeJob)) this.decoding?.controller.abort();
    }
    if (accepted.length) void this.run();
    return accepted;
  }

  private plainPresent(file: string): boolean | undefined {
    const plain = file.slice(0, -'.zst'.length);
    if (this.options.exists) return this.options.exists(plain);
    const stat = this.observeStat(plain);
    return stat === undefined ? undefined : stat !== null;
  }

  private listed(file: string, membership: number | undefined): boolean {
    return this.names.has(file) && this.memberships?.get(file) === membership;
  }

  private jobAllowed(job: Job): boolean {
    if (
      this.disposed ||
      this.scopePending ||
      job.generation !== this.generation ||
      !this.listed(job.file, job.membership)
    )
      return false;
    return !job.repair || this.repairs.get(job.file) === job.repair;
  }

  private leasePaths(file: string): DeliveryPaths {
    const stat = this.observeStat(file);
    return { stat, plain: stat?.isFile ? this.plainPresent(file) : false };
  }

  private jobRevision(job: Job, checked?: DeliveryPaths, openingWrite = false): boolean | undefined {
    const plain = checked ? checked.plain : this.plainPresent(job.file);
    if (
      !this.jobAllowed(job) ||
      (!openingWrite && plain) ||
      (job.opening && !codexRowAdmitted(job.opening, job.stat, this.inFolders))
    ) {
      if (job.repair) this.endRepair(job.repair, true);
      return false;
    }
    if (plain === undefined || this.machineWorkPending) return undefined;
    const stat = checked ? checked.stat : this.observeStat(job.file);
    if (stat === undefined) return undefined;
    if (stat?.isFile && stat.size > 0) {
      if (sameStat(job.stat, stat)) {
        if (openingWrite && plain) return undefined;
        const machine = this.machineOpening(job.file, stat);
        if (!this.sameMachinePlacement(job.machine, machine)) {
          if (job.verifiedOpening && this.sameMachinePlacement(job.verifiedOpening, machine)) job.machine = machine;
          else {
            this.requeue({ ...job, kind: 'opening', opening: undefined, verifiedOpening: undefined, machine });
            return false;
          }
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
          this.requeue({ ...job, kind: 'opening', opening: undefined, verifiedOpening: undefined, adoption });
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
    const owner = this.openingMeaning(repair.file, opening);
    return repair.sessionId === undefined || (owner?.sessionId === repair.sessionId && owner.cwd === repair.cwd);
  }

  private repairFactMatches(repair: CompressedRepair, entry: CompressedFactEntry): boolean {
    return (
      !this.needsPhysical.has(repair.file) &&
      !entry.spendNeedsRepair &&
      compressedEntryCurrent(entry, repair) &&
      (entry.hash === undefined || repair.openingHash === undefined || entry.hash === repair.openingHash) &&
      !this.machineOpeningConflicts(this.machineOpening(repair.file, repair), entry) &&
      (entry.unreadable ? entry.unreadableLaunch === this.options.launch : entry.decodedLength !== undefined) &&
      (entry.unreadable && !entry.opening
        ? repair.sessionId === undefined || entry.threadId === repair.sessionId
        : this.repairOpeningMatches(repair, entry.opening) &&
          !!entry.opening?.cwd &&
          this.inFolders(entry.opening.cwd) &&
          !isHiddenThread(entry.opening))
    );
  }

  private endRepair(repair: CompressedRepair, retired: boolean, miss?: CompressedRepairSettlement): void {
    const { file } = repair;
    if (this.repairs.get(file) !== repair) return;
    this.repairs.delete(file);
    this.repairQueue.delete(file);
    const retry = this.retries.get(file);
    if (retry?.job?.repair === repair) {
      retry.cancel?.();
      this.retries.delete(file);
    }
    if (retired) this.retireRepair(repair, miss);
  }

  private retireRepair(repair: CompressedRepair, miss?: CompressedRepairSettlement): void {
    this.retiredRepairs.set(repair.file, miss ? { ...miss, ...repair } : { ...repair, outcome: 'released' });
    this.armFlush();
  }

  private requeue(job: Job): void {
    if (!this.jobAllowed(job)) return;
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
          generation: this.generation,
          membership: this.memberships?.get(file),
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

  suspendScope(scope: number): void {
    if (this.repairScope === scope || this.scopePending) return;
    this.scopePending = true;
    this.generation++;
    this.decoding?.controller.abort();
    this.endTurn();
    this.wake?.();
  }

  // Install the host's retained placements before the list or store follow can plan work for the new scope.
  configureScope(
    roots: readonly string[] | undefined,
    scope?: number,
    retained?: readonly CompressedPlacement[],
  ): void {
    const key = roots ? JSON.stringify(roots) : this.rootsKey;
    const rescope =
      this.scopePending ||
      (scope !== undefined && this.repairScope !== undefined && scope !== this.repairScope) ||
      key !== this.rootsKey;
    if (!rescope && (scope === undefined || scope === this.repairScope)) return;
    if (scope !== undefined) this.repairScope = scope;
    if (roots && key !== this.rootsKey) {
      this.rootsKey = key;
      this.inFolders = this.options.inFolders(roots);
    }
    if (rescope) {
      if (!this.scopePending) this.generation++;
      this.decoding?.controller.abort();
      for (const retry of this.retries.values()) retry.cancel?.();
      this.retries.clear();
      this.openingMisses.clear();
      this.restoredRepairs.clear();
      this.plannedOpenings.clear();
      this.deferredOpenings.clear();
      this.clearRepairs();
      this.queue = [];
      this.outbox.clear();
      for (const [file, state] of this.placements) {
        if (state.pending) this.placements.set(file, {});
        else this.placements.delete(file);
      }
      this.dirty = true;
    }
    this.scopePending = false;
    for (const placement of retained ?? []) this.placements.set(placement.file, { posted: placement, resumed: true });
  }

  restoreRepairSettlements(settlements: readonly CompressedRepairSettlement[]): void {
    for (const settlement of settlements) {
      const { file } = settlement;
      if (!this.listed(file, settlement.membership) || this.restoredRepairs.has(file)) continue;
      this.restoredRepairs.add(file);
      if (
        !this.openingMisses.has(file) &&
        !this.repairs.has(file) &&
        !addsCompressedRepairEvidence(settlement.evidence, this.seenRepairEvidence.get(file))
      )
        this.openingMisses.set(file, settlement);
    }
  }

  setRepairScope(scope: number): void {
    this.configureScope(undefined, scope);
    if (this.dirty) void this.run();
  }

  // A store follow checks deferred deliveries without making quiet follows recheck settled files.
  setRoots(roots: readonly string[]): void {
    this.configureScope(roots);
    this.refreshMachineOpenings();
    const moved = this.failedRevisionMoved();
    for (const file of this.waitingPlacements) this.events.add(file);
    this.waitingPlacements.clear();
    this.follow++;
    this.armFlush();
    if (moved || this.dirty || this.events.size || this.openingsPending) void this.run();
  }

  private clearRepairs(): void {
    for (const repair of this.repairs.values()) this.endRepair(repair, false);
    this.retiredRepairs.clear();
    this.seenRepairEvidence.clear();
    this.pendingRepairEvidence.clear();
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
        if (retry.job?.repair && (!this.jobAllowed(retry.job) || this.plainPresent(file))) {
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
    return moved;
  }

  dispose(): void {
    this.disposed = true;
    this.openingMisses.clear();
    this.plannedOpenings.clear();
    this.deferredOpenings.clear();
    this.persistence?.resume?.();
    this.openingsAbort.abort();
    this.decoding?.controller.abort();
    this.wake?.();
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

  awaitingPlacement(entry: CompressedFactEntry): boolean {
    const { file, size, mtimeMs } = entry;
    if (this.placements.get(file)?.pending || this.needsPhysical.has(file)) return true;
    if (size === undefined || mtimeMs === undefined) return false;
    const revision = { size, mtimeMs, ...compressedEntryIdentity(entry) };
    return this.machineOpeningConflicts(this.machineOpening(file, revision), entry);
  }

  followed(entry: CompressedFactEntry): void {
    const queued = this.outbox.get(entry.file);
    const matched = !!queued && compressedEntrySame(queued.entry, entry);
    if (matched) this.outbox.delete(entry.file);
    this.noteSent(entry, matched);
    this.notePlacementObservation(entry);
    if (entry.adopted) this.noteReplacement(entry.file);
  }

  private noteSent(entry: CompressedFactEntry, fromOutbox: boolean, checked?: Job['stat']): void {
    if (fromOutbox) {
      const local = this.results.get(entry.file);
      this.sent.set(entry.file, local && compressedEntrySame(local, entry) ? local : compressedEntrySeed(entry));
    }
    const repair = this.repairs.get(entry.file);
    if (repair && this.repairFactMatches(repair, entry) && sameStat(repair, checked ?? this.statOf(entry.file)))
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
    if (this.machineWorkPending) await this.followMachineOpenings();
    if (this.flushDue) await this.deliverDueBatches();
    await this.waitIdle();
    slice.bytes = 0;
    slice.started = this.now();
  }

  // Lets one slice end while discovery requests wait, and resolves when it ended. A parked backfill starts the slice, and
  // a decode or machine traversal in progress ends its current slice. A waiting reader takes precedence.
  takeTurn(): Promise<void> | null {
    if (
      (!this.wake && !this.openingsRead && (!this.decoding || this.activeJob?.kind !== 'body')) ||
      this.turnEnded ||
      this.disposed ||
      this.scopePending ||
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

  // A wait for a store lease or a workspace store read ends the current turn. A machine store read ends it at a yield.
  private endTurn(): void {
    this.cancelTurnLimit?.();
    this.cancelTurnLimit = null;
    this.turnEnded?.();
    this.turnEnded = null;
  }

  // Every call follows a finished step of work, so it ends a turn that waited on that step.
  private async waitIdle(): Promise<void> {
    this.endTurn();
    while (this.options.busy() && !this.disposed && (!this.turnEnded || this.options.reading?.())) {
      if (this.options.reading?.()) this.endTurn();
      await this.pause();
    }
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
    if (this.running || this.disposed || this.scopePending) return;
    this.running = true;
    try {
      while (!this.disposed && !this.scopePending) {
        if (this.machineWorkPending) await this.followMachineOpenings();
        if (this.disposed || this.scopePending) return;
        if (this.openingsPending) continue;
        if (this.dirty) {
          await this.waitIdle();
          if (this.disposed || this.scopePending) return;
          try {
            await this.plan();
          } catch {
            this.replanLater();
            break;
          }
        }
        if (this.events.size || this.staleOpens.size) {
          await this.waitIdle();
          if (this.disposed || this.scopePending) return;
          await this.planEvents();
        }
        if (this.openingsPending) continue;
        if (this.flushDue) await this.deliverDueBatches();
        if (this.dirty || this.events.size || this.staleOpens.size || this.openingsPending) continue;
        this.armFlush();
        const persistence = this.persistence;
        if (persistence) {
          if (!persistence.resume) break;
          await this.waitIdle();
          if (this.disposed || this.scopePending) return;
          if (this.machineWorkPending || this.dirty || this.events.size || this.staleOpens.size || this.flushDue)
            continue;
          this.persistence = undefined;
          await this.runStep(persistence.resume);
          continue;
        }
        if (this.plannedOpenings.size) {
          await this.runStep(() => void this.writePlannedOpenings().then(this.finishStep, this.finishStep));
          continue;
        }
        if (!this.repairQueue.size && !this.queue.length) break;
        await this.waitIdle();
        if (this.disposed || this.scopePending) return;
        if (this.openingsPending) continue;
        const targeted = this.repairQueue.values().next().value;
        const job = targeted ?? this.queue.shift();
        if (!job) continue;
        if (targeted) this.repairQueue.delete(job.file);
        const current = this.jobRevision(job);
        if (!current) {
          if (current === undefined) this.waitForRevision(job);
          continue;
        }
        const stored = this.factsOf(job.file, job.stat);
        const observed =
          !job.recheck &&
          !this.needsPhysical.has(job.file) &&
          (!job.adoption || job.adoption.entry.hash === stored?.hash) &&
          (!stored || !this.machineOpeningConflicts(job.machine, stored)) &&
          this.canReuseResumedFacts(job.file, stored);
        if (job.repair && observed && (!job.adoption || job.kind === 'body') && this.replayRepair(job)) continue;
        if (
          !job.repair &&
          observed &&
          !job.recheck &&
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
        const miss = this.matchingOpeningMiss(job);
        if (miss) {
          if (job.repair) this.endRepair(job.repair, true, miss);
          continue;
        }
        if (job.repair && this.restoreRepairRetry(job)) continue;
        await this.runStep(() => void this.derive(job).then(this.finishStep, this.finishStep));
      }
    } finally {
      this.running = false;
      this.endTurn();
    }
    if ((this.dirty || this.events.size || this.staleOpens.size || this.openingsPending) && !this.disposed)
      void this.run();
  }

  private async derive(job: Job): Promise<void> {
    this.activeJob = job;
    try {
      if (job.kind === 'opening') await this.deriveOpening(job);
      else {
        this.added.delete(job.file);
        await this.deriveBody(job);
      }
    } catch {
      await this.retryLater(job).catch(() => undefined);
    } finally {
      this.activeJob = undefined;
    }
  }

  private runStep(start: () => void): Promise<void> {
    return new Promise((end) => {
      this.endStep = end;
      start();
    });
  }

  private readonly finishStep = (): void => {
    const end = this.endStep;
    this.endStep = undefined;
    end?.();
  };

  // A derivation resumes through the runner after a store operation. The runner can check machine input and deliver
  // batches during the wait. It starts no other derivation or store write.
  private waitForPersistence<T>(operation: () => Promise<T>): Promise<T> {
    this.endTurn();
    const pending: PersistenceWait = {};
    this.persistence = pending;
    return new Promise((resolve, reject) => {
      const ready = (resume: () => void) => {
        if (this.disposed) resume();
        else {
          pending.resume = resume;
          void this.run();
        }
      };
      void Promise.resolve()
        .then(operation)
        .then(
          (value) => ready(() => resolve(value)),
          (error: unknown) => ready(() => reject(error)),
        );
      this.finishStep();
    });
  }

  private openingEvidence(job: Pick<Job, 'file' | 'stat' | 'machine' | 'adoption'>): CompressedRepairEvidence {
    const { file, stat, machine, adoption } = job;
    const { size, mtimeMs, dev, ino } = stat;
    const owner = machine?.physicalOpening ? this.openingMeaning(file, machine.opening) : undefined;
    const adopted = adoption && !adoption.pending && this.openingMeaning(file, adoption.opening);
    const adoptedHash = adoption && !adoption.pending && compressedByteObservation(adoption.entry)?.hash;
    const entry = !machine && !adoption ? this.factsOf(file, stat) : undefined;
    const facts = entry && compressedEntryCurrent(entry, stat) && compressedByteObservation(entry);
    return {
      file,
      size,
      mtimeMs,
      dev,
      ino,
      ...(this.memberships?.has(file) && { membership: this.memberships.get(file) }),
      ...(machine?.physicalOpening && (machine.hash || owner) && { machine: { ...owner, hash: machine.hash } }),
      ...((adopted || adoptedHash) && { adoption: { ...adopted, hash: adoptedHash || undefined } }),
      ...(facts && { facts: { ...this.openingMeaning(file, entry.opening), hash: facts.hash } }),
    };
  }

  private noteRepairEvidence(evidence: CompressedRepairEvidence): void {
    const held = this.seenRepairEvidence.get(evidence.file);
    if (!addsCompressedRepairEvidence(held, evidence)) return;
    this.seenRepairEvidence.set(evidence.file, evidence);
    this.pendingRepairEvidence.set(evidence.file, evidence);
    this.armFlush();
  }

  private matchingOpeningMiss(job: Job): CompressedRepairSettlement | undefined {
    const held = this.openingMisses.get(job.file);
    if (!held) return undefined;
    if (job.verifiedOpening && this.deferredOpenings.get(job.file)?.entry === job.verifiedOpening) return undefined;
    const proof = job.repair ?? { file: job.file, ...job.stat, membership: job.membership };
    if (
      addsCompressedRepairProof(held, proof) ||
      addsCompressedRepairEvidence(held.evidence, this.openingEvidence(job))
    ) {
      this.openingMisses.delete(job.file);
      return undefined;
    }
    if (held.outcome === 'repair-mismatch' && !job.repair && job.kind === 'body') {
      const checked = this.checkedMachineOpenings.get(job.file);
      const opening =
        job.verifiedOpening?.opening ??
        (checked && this.sameMachinePlacement(checked.machine, job.machine) ? checked.opening : undefined) ??
        (job.machine?.physicalOpening ? job.machine.opening : undefined);
      if (
        held.successor &&
        this.sameOpening(held.successor, this.openingMeaning(job.file, opening)) &&
        this.sameOpening(held.successor, this.openingMeaning(job.file, job.opening))
      )
        return undefined;
    }
    return held;
  }

  private settleOpening(
    job: Job,
    outcome: CompressedRepairSettlement['outcome'],
    observedHash?: string,
    successor?: CodexSessionMeta | null,
  ): void {
    const { file, stat, repair, membership } = job;
    const { size, mtimeMs, dev, ino } = stat;
    const settlement: CompressedRepairSettlement = {
      ...(repair ?? { file, size, mtimeMs, dev, ino, ...(membership !== undefined && { membership }) }),
      outcome,
      evidence: this.openingEvidence(job),
      ...(successor && { successor: this.openingMeaning(file, successor) }),
      ...(observedHash && { observedHash }),
    };
    this.openingMisses.set(file, settlement);
    if (repair) this.endRepair(repair, true, settlement);
    this.retries.get(file)?.cancel?.();
    this.retries.delete(file);
    this.added.delete(file);
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
    this.flushReady.add(job.file);
    this.armFlush();
    return true;
  }

  private restoreRepairRetry(job: Job): boolean {
    const retryHeld = this.retries.get(job.file);
    if (retryHeld && sameStat(retryHeld.stat, job.stat)) return false;
    const entry = this.retryEntries.get(job.file);
    const saved = entry?.repairRetry;
    if (
      !entry ||
      !saved ||
      job.recheck ||
      this.needsPhysical.has(job.file) ||
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

  private get machineWorkPending(): boolean {
    return this.openingsPending || !!this.openingsRead;
  }

  private refreshMachineOpenings(): void {
    if (!this.names.size || this.disposed) return;
    this.openingsPending = true;
    // A decode also waits for I/O between slices. Follow there to stop a changed decode promptly.
    if (this.decoding && !this.wake) void this.followMachineOpenings();
  }

  private async followMachineOpenings(): Promise<void> {
    while (!this.disposed && this.machineWorkPending) {
      if (!this.openingsRead) {
        this.openingsRead = this.readMachineOpenings().finally(() => {
          this.openingsRead = undefined;
          this.endTurn();
          this.armFlush();
        });
      }
      await this.openingsRead;
    }
  }

  private async readMachineOpenings(): Promise<void> {
    await this.waitIdle();
    this.openingsPending = false;
    if (this.disposed || this.scopePending || !this.names.size) return;
    await this.openingsInput.follow(this.openingsAbort.signal).catch(() => undefined);
  }

  private writeRevision(job: Job): boolean | undefined {
    if (!this.machineWorkPending) return this.jobRevision(job);
    this.requeue(job);
    return false;
  }

  private noteMachineOpening(entry: CompressedFactEntry, checked?: Job): void {
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
      this.rememberOpening(entry);
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
    const active = this.activeJob;
    const verified =
      checked ??
      (active?.file === file && this.sameMachinePlacement(active.verifiedOpening, entry) ? active : undefined);
    if (
      verified &&
      verified.generation === this.generation &&
      this.listed(file, verified.membership) &&
      !this.scopePending &&
      sameStat(verified.stat, this.statOf(file))
    ) {
      const observed = this.placements.get(file)?.observed;
      if (observed && this.sameMachinePlacement(observed.machine, verified.machine)) observed.machine = entry;
      verified.machine = entry;
      verified.verifiedOpening = entry;
      return;
    }
    if (!held && this.dirty && !active && !this.queue.length && !this.repairQueue.size) return;
    this.events.add(file);
    const retry = this.retries.get(file);
    retry?.cancel?.();
    this.retries.delete(file);
    const repair = this.repairs.get(file);
    if (repair && retry?.job?.repair === repair)
      this.requeue({ ...retry.job, kind: 'opening', opening: undefined, verifiedOpening: undefined, machine: entry });
    if (this.decoding?.file === file) this.decoding.controller.abort();
  }

  private sameMachinePlacement(left?: CompressedFactEntry, right?: CompressedFactEntry): boolean {
    if (left === right) return true;
    if (!left || !right) return false;
    const a = compressedEntryIdentity(left);
    const b = compressedEntryIdentity(right);
    return (
      !!a === !!b &&
      (!a || (String(a.dev) === String(b?.dev) && String(a.ino) === String(b?.ino))) &&
      left.size === right.size &&
      left.mtimeMs === right.mtimeMs &&
      left.hash === right.hash &&
      (left.physicalOpening === true) === (right.physicalOpening === true) &&
      this.sameOpening(this.openingMeaning(left.file, left.opening), this.openingMeaning(right.file, right.opening))
    );
  }

  private machineOpening(
    file: string,
    stat: NonNullable<Parameters<typeof compressedEntryCurrent>[1]>,
  ): CompressedFactEntry | undefined {
    const entry = this.machineOpenings.get(file);
    return entry &&
      compressedEntryCurrent(entry, stat) &&
      (!supportedFileIdentity(stat) || !!compressedEntryIdentity(entry) || !entry.threadId)
      ? entry
      : undefined;
  }

  private openingMeaning(
    file: string,
    opening: CodexSessionMeta | null | undefined,
  ): CompressedOpeningEvidence | undefined {
    if (opening === null) return { nonOpening: true };
    if (!opening?.cwd) return undefined;
    return {
      sessionId: sessionKeyOf(file, opening) ?? undefined,
      cwd: opening.cwd,
      hidden: isHiddenThread(opening),
      agentRun: isAgentRun(opening),
    };
  }

  private sameOpening(
    left?: CompressedOpeningEvidence,
    right?: CompressedOpeningEvidence,
    allowUnknownId = false,
  ): boolean {
    return (
      left?.nonOpening === right?.nonOpening &&
      (left?.sessionId === right?.sessionId || (allowUnknownId && (!left?.sessionId || !right?.sessionId))) &&
      left?.cwd === right?.cwd &&
      left?.hidden === right?.hidden &&
      left?.agentRun === right?.agentRun
    );
  }

  private machineOpeningConflicts(machine: CompressedFactEntry | undefined, entry: CompressedEntrySeed): boolean {
    if (!machine) return false;
    if (machine.hash !== undefined && entry.hash !== undefined && machine.hash !== entry.hash) return true;
    if (!machine.physicalOpening) return false;
    const physical = this.openingMeaning(machine.file, machine.opening);
    const recorded = this.openingMeaning(entry.file, entry.opening);
    return !!physical && !!recorded && !this.sameOpening(physical, recorded, true);
  }

  private async plan(): Promise<void> {
    const generation = this.generation;
    this.dirty = false;
    const [events, adopted, unplaced, placed]: Job[][] = [[], [], [], []];
    let started = this.now();
    for (const file of this.names) {
      if (this.disposed) return;
      if (this.now() - started >= PLAN_SLICE_MS) {
        await this.planYield();
        if (this.disposed || generation !== this.generation) return;
        started = this.now();
      }
      try {
        this.planName(file, { events, adopted, unplaced, placed });
      } catch {
        this.replanLater();
      }
    }
    placed.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
    this.queue = [...events, ...adopted, ...unplaced, ...placed];
  }

  private async planEvents(): Promise<void> {
    const generation = this.generation;
    const affected = new Set([...this.events, ...this.staleOpens]);
    const events: Job[] = [];
    let started = this.now();
    for (const file of affected) {
      if (this.now() - started >= PLAN_SLICE_MS) {
        await this.planYield();
        started = this.now();
      }
      if (this.disposed || generation !== this.generation) return;
      try {
        this.planName(file, { events, adopted: events, unplaced: events, placed: events });
      } catch {
        this.replanLater();
      }
    }
    this.queue = [...events, ...this.queue.filter(({ file }) => !affected.has(file))];
  }

  private planName(
    file: string,
    { events, adopted, unplaced, placed }: { events: Job[]; adopted: Job[]; unplaced: Job[]; placed: Job[] },
  ): void {
    const event = this.events.delete(file) || this.waitingPlacements.has(file);
    const stale = this.staleOpens.delete(file);
    if (!this.names.has(file)) return;
    const deferred = this.deferredOpenings.get(file);
    if (deferred?.follow === this.follow) {
      this.waitingPlacements.add(file);
      return;
    }
    const stat = this.observeStat(file);
    if (stat === undefined) this.waitingPlacements.add(file);
    else this.waitingPlacements.delete(file);
    if (stat === undefined) return;
    const membership = this.memberships?.get(file);
    if (!stat?.isFile || stat.size === 0) {
      this.deferredOpenings.delete(file);
      return;
    }
    const plain = this.plainPresent(file);
    if (deferred && (!sameStat(stat, deferred.stat) || this.machineOpeningMatches(file, deferred.entry, stat)))
      this.deferredOpenings.delete(file);
    if (plain === undefined || (plain && this.deferredOpenings.has(file))) this.waitingPlacements.add(file);
    if (plain !== false) {
      const placement = this.placements.get(file);
      if (placement?.resumed) this.parkFlush(file);
      return;
    }
    const retry = this.retries.get(file);
    if (retry && sameStat(retry.stat, stat) && retry.at > this.now()) return;
    const entry = this.factsOf(file, stat);
    const adoption = this.adoptedPlacement(file, entry, stat);
    if (adoption?.pending) return;
    const machine = this.machineOpening(file, stat);
    if (
      entry?.spendNeedsRepair ||
      (adoption && entry?.decodedLength === undefined) ||
      this.repairs.has(file) ||
      this.openingMisses.has(file) ||
      this.placements.get(file)?.resumed
    )
      this.noteRepairEvidence(this.openingEvidence({ file, stat, machine, adoption }));
    const current =
      !this.needsPhysical.has(file) &&
      entry &&
      compressedEntryCurrent(entry, stat) &&
      (!adoption || adoption.entry.hash === entry.hash) &&
      !this.machineOpeningConflicts(machine, entry);
    const owed = this.deferredOpenings.get(file);
    const recheck =
      this.needsPhysical.has(file) ||
      (!!owed && (!current || !entry.opening || !this.sameMachinePlacement(owed.entry, compressedOpeningEntry(entry))));
    if (!recheck && owed) this.deferredOpenings.delete(file);
    const verifiedOpening =
      owed?.verified && this.sameMachinePlacement(owed.machine, machine) && adoption === owed.verified.adoption
        ? owed.entry
        : undefined;
    const opening = recheck ? undefined : this.placingOpening(file, entry, stat, adoption);
    this.notePlacement(file, stat, opening, entry, machine);
    if (
      !recheck &&
      current &&
      entry.decodedLength !== undefined &&
      !entry.unreadable &&
      this.canReuseResumedFacts(file, entry)
    ) {
      this.added.delete(file);
      this.repairOpening(file, entry, stat, machine);
      return;
    }
    if (
      !recheck &&
      current &&
      entry.unreadable &&
      entry.unreadableLaunch === this.options.launch &&
      this.canReuseResumedFacts(file, entry)
    ) {
      this.retries.set(file, {
        stat,
        attempts: BACKFILL_RETRY_DELAYS_MS.length,
        at: Infinity,
      });
      return;
    }
    const priority = event || stale || !!entry?.adoptionFailed || this.added.has(file);
    const scheduled = { file, stat, priority, adoption, machine, generation: this.generation, membership, recheck };
    if (opening === undefined) {
      const job: Job = { kind: 'opening', ...scheduled, verifiedOpening };
      if (owed || !this.matchingOpeningMiss(job)) (priority ? events : unplaced).push(job);
    } else if (opening && codexRowAdmitted(opening, stat, this.inFolders)) {
      const job: Job = { kind: 'body', ...scheduled, opening };
      if (!this.matchingOpeningMiss(job)) {
        if (priority) events.push(job);
        else if (entry?.adopted && current) adopted.push(job);
        else placed.push(job);
      }
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
    machine: CompressedFactEntry | undefined,
  ): void {
    if (entry.adopted || entry.unreadable || !entry.opening || this.machineOpeningMatches(file, entry, stat)) return;
    const opening = compressedOpeningEntry(entry);
    const pending = this.plannedOpenings.get(file);
    if (
      pending &&
      this.sameMachinePlacement(pending.entry, opening) &&
      this.sameMachinePlacement(pending.machine, machine)
    )
      return;
    this.plannedOpenings.set(file, { entry: opening, stat, machine, membership: this.memberships?.get(file) });
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
      if (checked && this.sameMachinePlacement(checked.machine, machine)) return checked.opening;
      if (
        machine.physicalOpening !== true ||
        (adoption && machine.hash !== adoption.entry.hash) ||
        (entry &&
          (!entry.adopted || machine.hash !== entry.hash) &&
          compressedEntryCurrent(entry, stat) &&
          this.machineOpeningConflicts(machine, entry))
      )
        return undefined;
      if (this.placements.get(file)?.resumed && (!machine.opening?.sessionId || !machine.opening.cwd)) return undefined;
      return machine.opening ?? null;
    }
    if (adoption?.opening !== undefined) return adoption.opening;
    const current = (candidate: CompressedEntrySeed) =>
      compressedEntryCurrent(candidate, stat) &&
      (!supportedFileIdentity(stat) ||
        !!compressedEntryIdentity(candidate) ||
        (!candidate.adopted && !candidate.threadId));
    if (!adoption && !this.placements.get(file)?.resumed && entry?.opening && !entry.unreadable && current(entry))
      return entry.opening;
    return undefined;
  }

  private machineOpeningMatches(file: string, entry: CompressedEntrySeed, stat: Job['stat']): boolean {
    const held = this.machineOpening(file, stat);
    return (
      held?.physicalOpening === true &&
      this.sameOpening(this.openingMeaning(file, held.opening), this.openingMeaning(file, entry.opening)) &&
      !this.machineOpeningConflicts(held, entry)
    );
  }

  private rememberOpening(entry: CompressedFactEntry, checked?: Job): void {
    const storeRecord = this.options.openings.recordOf?.(entry);
    const saved = storeRecord ? { ...entry, storeRecord, factsOrder: storeRecord.order } : entry;
    if (!saved.repairRetry) {
      this.noteMachineOpening(saved, checked);
      return;
    }
    const held = this.retryEntries.get(entry.file);
    if (!held || compareCompressedEntries(saved, held, null) > 0) this.retryEntries.set(entry.file, saved);
  }

  private deferOpening(opening: PlannedOpening): void {
    this.deferredOpenings.set(opening.entry.file, { ...opening, follow: this.follow });
    this.waitingPlacements.add(opening.entry.file);
  }

  private appendOpenings(
    entries: CompressedFactEntry[],
    eligible: (entry: CompressedFactEntry) => boolean,
  ): Promise<boolean[]> {
    return this.waitForPersistence(async () => {
      const holder = this.options.openings;
      const written = await holder.append(entries, eligible, this.openingsInput).catch(() => null);
      if (!written) {
        this.replanLater();
        return entries.map((entry) => !!holder.recordOf?.(entry));
      }
      return Promise.all(entries.map(async (entry, index) => written[index] || holder.durable([entry])));
    });
  }

  private async saveOpening(
    entry: CompressedFactEntry,
    job: Job,
    eligible: (paths: DeliveryPaths) => boolean | undefined,
    deliveryJob = job,
  ): Promise<void> {
    const { file } = entry;
    const pending = this.deferredOpenings.get(file);
    const check = () => {
      if (!this.jobAllowed(job)) return false;
      const current = eligible(this.leasePaths(file));
      if (current === undefined) {
        if (entry.repairRetry) this.waitingPlacements.add(file);
        else
          this.deferOpening({
            entry,
            stat: job.stat,
            membership: job.membership,
            machine: job.machine,
            verified: job.verifiedOpening === entry ? job : undefined,
          });
        return false;
      }
      if (this.deferredOpenings.get(file) === pending) this.deferredOpenings.delete(file);
      return current && (!!entry.repairRetry || !this.machineOpeningMatches(file, entry, job.stat));
    };
    const [written] = await this.appendOpenings([entry], check).catch(() => {
      this.replanLater();
      return [false];
    });
    if (written) this.rememberOpening(entry, deliveryJob);
  }

  private async writePlannedOpenings(): Promise<void> {
    const planned = new Map(this.plannedOpenings);
    const generation = this.generation;
    const eligible = (entry: CompressedFactEntry) => {
      const opening = planned.get(entry.file)!;
      if (
        this.disposed ||
        this.scopePending ||
        generation !== this.generation ||
        !this.listed(entry.file, opening.membership) ||
        this.plannedOpenings.get(entry.file) !== opening
      )
        return false;
      const { stat, plain } = this.leasePaths(entry.file);
      if (
        stat === undefined ||
        (stat?.isFile && stat.size && sameStat(stat, opening.stat) && (plain !== false || this.machineWorkPending))
      ) {
        this.deferOpening(opening);
        return false;
      }
      if (!stat?.isFile || !stat.size || !sameStat(stat, opening.stat)) return false;
      const facts = this.factsOf(entry.file, stat);
      return (
        !!facts?.opening &&
        !facts.adopted &&
        !facts.unreadable &&
        !this.needsPhysical.has(entry.file) &&
        !this.machineOpeningConflicts(this.machineOpening(entry.file, stat), facts) &&
        this.sameMachinePlacement(entry, compressedOpeningEntry(facts)) &&
        this.sameMachinePlacement(opening.machine, this.machineOpening(entry.file, stat))
      );
    };
    const entries = [...planned.values()].map(({ entry }) => entry);
    const written = await this.appendOpenings(entries, eligible).catch(() => {
      this.replanLater();
      return [];
    });
    entries.forEach((entry, index) => {
      if (written[index]) this.rememberOpening(entry);
      if (this.plannedOpenings.get(entry.file) === planned.get(entry.file)) this.plannedOpenings.delete(entry.file);
    });
  }

  private async deriveOpening(job: Job): Promise<void> {
    const started = this.now();
    if (job.verifiedOpening) {
      await this.publishOpening(job, job.verifiedOpening, started);
      return;
    }
    const report: { failed?: boolean; stale?: boolean; bounded?: boolean } = {};
    let first: string | null = null;
    const controller = new AbortController();
    this.decoding = { file: job.file, controller };
    try {
      first = await this.readFirst(job.file, COMPRESSED_ENTRY_TITLE_BYTES, report, job.stat, {
        signal: controller.signal,
      });
    } catch {
      report.failed = true;
    } finally {
      this.decoding = null;
    }
    if (this.machineWorkPending) await this.followMachineOpenings();
    const current = this.jobRevision(job);
    if (!current || report.stale || controller.signal.aborted) {
      if (current === undefined || current) this.waitForRevision(job);
      return;
    }
    if (report.failed || (first === null && !report.bounded)) {
      if (job.adoption) this.waitForRevision(job);
      else await this.retryLater(job);
      return;
    }
    if (job.adoption && first === '') {
      this.waitForRevision(job);
      return;
    }
    const opening = openingRecordOf(first);
    const facts = this.factsOf(job.file, job.stat);
    if (first === null || (opening && !opening.cwd)) {
      this.notePlacement(job.file, job.stat, undefined, facts, job.machine);
      this.settleOpening(job, report.bounded ? 'bounded' : 'unplaced-header');
      return;
    }
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
    job.verifiedOpening = entry;
    this.notePlacement(job.file, job.stat, opening, facts, job.machine, undefined, true);
    if (job.machine) this.checkedMachineOpenings.set(job.file, { machine: job.machine, opening });
    const owed = this.deferredOpenings.get(job.file);
    if (owed && owed.entry !== entry) this.deferredOpenings.delete(job.file);
    await this.publishOpening(job, entry, started);
  }

  private async publishOpening(job: Job, entry: CompressedFactEntry, started: number): Promise<void> {
    if (!this.machineOpeningMatches(job.file, entry, job.stat))
      await this.saveOpening(entry, job, (paths) => this.jobRevision(job, paths, true));
    await this.finishOpening(job, entry.opening ?? null, started);
  }

  private async finishOpening(job: Job, opening: CodexSessionMeta | null, started: number): Promise<void> {
    if (this.machineWorkPending) await this.followMachineOpenings();
    const afterWrite = this.jobRevision(job);
    if (!afterWrite) {
      if (afterWrite === undefined) this.waitForRevision(job);
      return;
    }
    if (job.adoption) job.adoption.opening = opening;
    this.unpostedMs += this.now() - started;
    if (!codexRowAdmitted(opening, job.stat, this.inFolders)) {
      this.settleOpening(job, 'ineligible');
      return;
    }
    const body: Job = { ...job, kind: 'body', opening: opening! };
    if (job.repair && !this.repairOpeningMatches(job.repair, opening)) {
      this.settleOpening(job, 'repair-mismatch', undefined, opening);
      delete body.repair;
    }
    if (body.repair) this.requeue(body);
    else if (job.priority) this.queue.unshift(body);
    else this.insertBody(body);
  }

  // Placement is independent of the workspace entry's title and spend.
  private notePlacement(
    file: string,
    stat: Job['stat'],
    meta: CodexSessionMeta | null | undefined,
    facts?: CompressedEntrySeed,
    machine?: CompressedFactEntry,
    hash?: string,
    readPhysicalOpening = false,
  ): void {
    const held = this.placements.get(file);
    const opening =
      meta?.sessionId && meta.cwd
        ? { sessionId: meta.sessionId, cwd: meta.cwd, hidden: isHiddenThread(meta) }
        : undefined;
    const scoped = opening && this.inFolders(opening.cwd);
    if (
      !held &&
      !(scoped && opening.hidden) &&
      !(facts && this.machineOpeningConflicts(machine, facts)) &&
      !(facts?.opening?.cwd && opening && !scoped)
    )
      return;
    if (!supportedFileIdentity(stat)) return;
    const { size, mtimeMs, dev, ino } = stat;
    const placement: CompressedPlacement = { file, revision: { size, mtimeMs, dev: dev!, ino: ino! }, opening };
    const observed = held?.observed;
    if (
      !hash &&
      opening &&
      observed?.placement.hash &&
      this.sameMachinePlacement(observed.machine, machine) &&
      sameCompressedPlacement({ ...observed.placement, hash: undefined }, placement)
    )
      hash = observed.placement.hash;
    const physical = machine?.physicalOpening && machine.opening;
    if (
      !hash &&
      opening &&
      physical &&
      opening.sessionId === physical.sessionId &&
      opening.cwd === physical.cwd &&
      opening.hidden === isHiddenThread(physical)
    )
      hash = machine?.hash;
    if (hash) placement.hash = hash;
    const state = held ?? {};
    this.placements.set(file, state);
    const posted = state.posted;
    const previousOpening = posted?.opening;
    const changedOpening =
      readPhysicalOpening &&
      opening &&
      previousOpening &&
      (opening.sessionId !== previousOpening.sessionId ||
        opening.cwd !== previousOpening.cwd ||
        opening.hidden !== previousOpening.hidden);
    const changedHash = posted?.hash && machine?.physicalOpening && machine.hash && machine.hash !== posted.hash;
    const retained = state.resumed || !!(posted?.hash && previousOpening);
    if (retained && (changedOpening || changedHash)) {
      state.resumed = true;
      state.disputed = placement.revision;
    }
    const visibleWithoutHash = scoped && !opening.hidden && !hash;
    const withdraw = retained && sameStat(stat, state.disputed ?? null) && (!opening || visibleWithoutHash);
    if (withdraw) placement.opening = undefined;
    state.observed = {
      placement: observed && sameCompressedPlacement(observed.placement, placement) ? observed.placement : placement,
      machine,
    };
    if (
      !withdraw &&
      ((retained && !opening && sameStat(stat, posted?.revision ?? null)) || (state.resumed && visibleWithoutHash))
    ) {
      state.pending = false;
      return;
    }
    if (state.posted && sameCompressedPlacement(state.posted, placement)) {
      state.pending = false;
      if (placement.hash || placement.opening?.hidden) {
        state.resumed = false;
        state.disputed = undefined;
      }
      if (!this.outbox.has(file)) this.flushParked.delete(file);
    } else if (!state.pending || !observed || !sameCompressedPlacement(observed.placement, placement)) {
      state.pending = true;
      this.flushReady.add(file);
    }
    this.armFlush();
  }

  private canReuseResumedFacts(file: string, facts: CompressedEntrySeed | undefined): boolean {
    const state = this.placements.get(file);
    return !state?.resumed || (!!facts?.hash && state.observed?.placement.hash === facts.hash);
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
    if (this.machineWorkPending) await this.followMachineOpenings();
    const current = this.jobRevision(job);
    if (current !== true || decoding.controller.signal.aborted) {
      if (current === undefined) this.waitForRevision(job);
      return;
    }
    if (read.kind === 'decoded' && read.complete) {
      const entry = compressedFactsFromDerivation(job.file, read, derivation);
      if (
        (job.repair || entry.opening || job.opening) &&
        !codexRowAdmitted(entry.opening ?? null, job.stat, this.inFolders)
      ) {
        this.notePlacement(
          job.file,
          job.stat,
          entry.opening,
          this.factsOf(job.file, job.stat),
          job.machine,
          entry.hash,
          true,
        );
        this.settleOpening(job, entry.opening && !entry.opening.cwd ? 'unplaced-body' : 'ineligible', entry.hash);
        return;
      }
      if (job.repair && !this.repairOpeningMatches(job.repair, entry.opening)) {
        this.notePlacement(job.file, job.stat, entry.opening, undefined, job.machine, entry.hash, true);
        if (job.machine && entry.opening)
          this.checkedMachineOpenings.set(job.file, { machine: job.machine, opening: entry.opening });
        this.settleOpening(job, 'repair-mismatch', entry.hash, entry.opening);
        job = { ...job, opening: entry.opening ?? undefined, repair: undefined };
      }
      if (!(await this.publish(entry, job)) && job.repair && this.jobCurrent(job)) await this.retryLater(job);
      return;
    }
    // The stream changed during the read, so the next plan reads it again from the new revision.
    if (read.kind === 'stale') {
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
      const held = job.verifiedOpening ?? this.machineOpening(job.file, job.stat);
      const hash =
        (held?.opening === opening ? held?.hash : undefined) ??
        (job.adoption?.opening === opening && job.adoption
          ? compressedByteObservation(job.adoption.entry)?.hash
          : undefined);
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
          source: {
            file: job.repair.file,
            size: job.repair.size,
            mtimeMs: job.repair.mtimeMs,
            dev: job.repair.dev,
            ino: job.repair.ino,
            sessionId: job.repair.sessionId,
            cwd: job.repair.cwd,
            openingHash: job.repair.openingHash,
          },
          attempts: retry.attempts,
          at: this.wallNow() + delay,
        },
      };
      await this.saveOpening(
        checkpoint,
        job,
        (paths) => this.retries.get(job.file) === retry && this.jobRevision(job, paths, true),
      );
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
    const read = await this.waitForPersistence(() =>
      this.readStore(this.options.facts.directory, this.statOf, this.yieldStep, () => {
        failed = true;
      }),
    );
    return failed ? null : read.entries;
  }

  // Each derivation is on disk before the next one starts. The result is true when the entry reached the disk.
  private async publish(next: CompressedFactEntry, job: Job, unreadableDonor?: CompressedEntrySeed): Promise<boolean> {
    this.endTurn();
    if (this.machineWorkPending) await this.followMachineOpenings();
    const facts = this.options.facts;
    if (facts.appendCarryingFacts) {
      const entry = await this.waitForPersistence(() =>
        facts.appendCarryingFacts!(next, () => this.writeRevision(job), this.options.follower),
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
      if (this.writeRevision(job) !== true) return false;
      if (!resolveDonor) return true;
      const current = this.factsOf(next.file, stat);
      return current === donor || (!!current && !!donor && compressedEntrySame(current, donor));
    };
    const entry = boundedCompressedEntry(withKeptUndercount(previous, next));
    const durable = await this.waitForPersistence(async () => {
      const [written] = await facts.append([entry], revisionHolds);
      return written || (await facts.durable([entry]));
    });
    // An entry that did not reach the disk plans its name again.
    if (!durable) {
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
    this.needsPhysical.delete(entry.file);
    this.results.set(entry.file, compressedEntrySeed(entry));
    if (!entry.unreadable && !job.repair) {
      this.retries.get(entry.file)?.cancel?.();
      this.retries.delete(entry.file);
    }
    this.outbox.set(entry.file, { entry, job });
    this.flushReady.add(entry.file);
    if (!entry.unreadable) this.notePlacement(entry.file, job.stat, entry.opening, undefined, job.machine, entry.hash);
    this.armFlush();
    // A held opening of this revision needs no second write.
    if (!entry.unreadable && entry.opening && !this.machineOpeningMatches(entry.file, entry, job.stat)) {
      const opening = compressedOpeningEntry(entry);
      const current = { ...job, repair: undefined };
      await this.saveOpening(
        opening,
        current,
        (paths) => {
          const eligible = this.jobRevision(current, paths, true);
          if (eligible !== true) return eligible;
          const facts = this.factsOf(entry.file, job.stat);
          return !!facts?.opening && this.sameMachinePlacement(opening, compressedOpeningEntry(facts));
        },
        job,
      );
    }
  }

  private armFlush(): void {
    if (this.cancelFlush || this.flushDue || !this.owesBatch() || this.disposed || this.scopePending) return;
    this.cancelFlush = this.schedule(Math.max(0, Math.ceil(this.lastFlush + BATCH_INTERVAL_MS - this.now())), () => {
      this.cancelFlush = null;
      this.flushDue = true;
      void this.run();
    });
  }

  private nextParkedFlush(): string | undefined {
    const first = this.flushParked.entries().next().value;
    return first && first[1] < this.follow ? first[0] : undefined;
  }

  private parkFlush(file: string): void {
    this.flushReady.delete(file);
    this.flushParked.delete(file);
    this.flushParked.set(file, this.follow);
  }

  private owesBatch(): boolean {
    return !!(
      this.flushReady.size ||
      this.nextParkedFlush() ||
      this.retiredRepairs.size ||
      this.pendingRepairEvidence.size
    );
  }

  private async deliverDueBatches(): Promise<void> {
    while (this.flushDue && this.owesBatch()) {
      if (
        this.disposed ||
        this.scopePending ||
        this.machineWorkPending ||
        this.dirty ||
        this.events.size ||
        this.staleOpens.size
      )
        return;
      await this.waitIdle();
      if (
        this.disposed ||
        this.scopePending ||
        this.machineWorkPending ||
        this.dirty ||
        this.events.size ||
        this.staleOpens.size
      )
        return;
      this.flush();
      if (this.flushDue && this.owesBatch()) await this.yieldStep();
    }
    if (!this.owesBatch()) this.flushDue = false;
  }

  // One slice checks at most two paths per file. A refused path or an owed notice with a plain twin waits for a follow.
  private flush(): void {
    const ready = this.flushReady.values();
    const later: string[] = [];
    const placements: CompressedPlacement[] = [];
    const entries: { entry: CompressedFactEntry; stat: Job['stat'] }[] = [];
    const retiredRepairs: CompressedRepairReceipt[] = [];
    const repairEvidence: CompressedRepairEvidence[] = [];
    const memberships = new Map<string, number>();
    const started = this.now();
    let bytes = 0;
    const fits = (
      record: CompressedPlacement | CompressedFactEntry | CompressedRepairReceipt | CompressedRepairEvidence,
    ) => {
      const membership = this.memberships?.get(record.file);
      const member = membership !== undefined && !memberships.has(record.file) ? [record.file, membership] : undefined;
      const length =
        Buffer.byteLength(JSON.stringify(record)) + (member ? Buffer.byteLength(JSON.stringify(member)) + 1 : 0);
      if (bytes && length + bytes > COMPRESSED_BATCH_BYTES) return false;
      if (member) memberships.set(record.file, membership!);
      bytes += length;
      return true;
    };
    for (let count = 0; count < BATCH_FILE_LIMIT && (!count || this.now() - started < PLAN_SLICE_MS); count++) {
      const file = ready.next().value ?? this.nextParkedFlush();
      if (file === undefined || bytes >= COMPRESSED_BATCH_BYTES) break;
      this.flushReady.delete(file);
      const parked = this.flushParked.delete(file);
      const state = this.placements.get(file);
      const placement = state?.pending ? state.observed?.placement : undefined;
      const held = this.outbox.get(file);
      const unplaced = state && !state.observed;
      if (!placement && !held && !(parked || unplaced)) continue;
      const stat = this.observeStat(file);
      const plain = stat?.isFile ? this.plainPresent(file) : false;
      if (stat === undefined || plain === undefined || (plain && (placement || unplaced))) {
        this.parkFlush(file);
        continue;
      }
      if (unplaced) {
        if (stat?.isFile && stat.size > 0) this.events.add(file);
        else this.placements.delete(file);
      }
      if (state && placement) {
        if (
          !stat?.isFile ||
          !sameStat(stat, placement.revision) ||
          !this.sameMachinePlacement(state.observed?.machine, this.machineOpening(file, stat))
        ) {
          state.pending = false;
          state.observed = undefined;
          if (stat?.isFile && stat.size > 0) this.events.add(file);
          else this.placements.delete(file);
          if (held) later.push(file);
          continue;
        }
        if (!fits(placement)) {
          later.push(file);
          break;
        }
        placements.push(placement);
      }
      if (!held) continue;
      const current = this.jobRevision(held.job, { stat, plain });
      if (current === undefined) {
        this.parkFlush(file);
        continue;
      }
      if (current && !fits(held.entry)) {
        later.push(file);
        break;
      }
      this.outbox.delete(file);
      if (current) entries.push({ entry: held.entry, stat: held.job.stat });
    }
    for (const file of later) this.flushReady.add(file);
    for (const evidence of this.pendingRepairEvidence.values()) {
      if (repairEvidence.length >= COMPRESSED_REPAIR_LIMIT || !fits(evidence)) break;
      repairEvidence.push(evidence);
      this.pendingRepairEvidence.delete(evidence.file);
    }
    for (const receipt of this.retiredRepairs.values()) {
      const latest = this.seenRepairEvidence.get(receipt.file);
      let current = receipt;
      if (
        receipt.outcome !== 'released' &&
        latest &&
        sameStat(latest, receipt) &&
        addsCompressedRepairEvidence(receipt.evidence, latest)
      ) {
        const { evidence: _evidence, ...repair } = receipt;
        current = { ...repair, outcome: 'released' };
      }
      if (retiredRepairs.length >= COMPRESSED_REPAIR_LIMIT || !fits(current)) break;
      retiredRepairs.push(current);
      this.retiredRepairs.delete(receipt.file);
    }
    if (!entries.length && !placements.length && !retiredRepairs.length && !repairEvidence.length) return;
    this.flushDue = false;
    this.lastFlush = this.now();
    const backfillMs = Math.round(this.unpostedMs);
    this.unpostedMs -= backfillMs;
    const generation = this.generation;
    this.options.post({
      entries: entries.map(({ entry }) => entry),
      ...(memberships.size && { memberships: [...memberships] }),
      backfillMs,
      ...(placements.length ? { placements, repairScope: this.repairScope } : {}),
      ...(retiredRepairs.length ? { retiredRepairs, repairScope: this.repairScope } : {}),
      ...(repairEvidence.length ? { repairEvidence, repairScope: this.repairScope } : {}),
      ...(retiredRepairs.length || repairEvidence.length
        ? { repairStores: { facts: this.options.facts.directory, openings: this.options.openings.directory } }
        : {}),
    });
    if (generation !== this.generation || this.disposed) return;
    for (const { entry, stat } of entries) this.noteSent(entry, true, stat);
    for (const placement of placements) {
      const state = this.placements.get(placement.file);
      if (state?.observed?.placement !== placement) continue;
      state.posted = placement;
      state.pending = false;
      if (placement.hash || placement.opening?.hidden) {
        state.resumed = false;
        state.disputed = undefined;
      }
    }
    this.armFlush();
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
