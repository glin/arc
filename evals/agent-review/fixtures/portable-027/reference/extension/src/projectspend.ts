import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomically } from './atomicfile';
import {
  BACKGROUND_SCAN_BYTES,
  BACKGROUND_SCAN_MILLISECONDS,
  RETAINED_CACHE_EXPIRY_RETURNS,
  RETAINED_COMPACTIONS,
  withRetainedRequestEvents,
} from './parserstate';
import {
  cacheLapsedBy,
  type CacheTier,
  cacheLifetimeFor,
  contextBandForRequest,
  hasRequestContextPricing,
  quoteUsage,
  BEDROCK_LIST_COST_BASIS,
} from './pricing';
import { parseSpendLedger, projectUsageKey } from './projectspendstate';
import type { CacheLifetime, ReducerCompaction, TurnOutcome, TurnUsage } from './transcript';
import { normalizeFsPath } from './transcript';

export interface UsageCounts {
  requests?: number;
  input: number;
  cacheWrite1h: number;
  cacheWrite5m: number;
  cacheWrite30m?: number;
  cacheRead: number;
  output: number;
  thinking: number;
}

// This deliberately mirrors the transcript boundary structurally. The index can therefore
// be introduced before the Claude and Codex readers export their reducers.
export interface UsageEvent {
  timestamp: number;
  agent: string;
  provider: string | null;
  model: string | null;
  contextWindow: number | null;
  // A rate band applies to one request. It must not be inferred from the sum of a daily
  // bucket after several requests have been combined.
  contextBand?: 'short' | 'long' | null;
  billingClass: 'metered' | 'subscription' | 'unknown';
  inferenceClass: 'in-region' | 'geo' | 'global' | 'bedrock-regional' | null;
  serviceTier: string | null;
  effort?: string | null;
  toolListVersion?: number | null;
  reportedCost: number | null;
  reportedCostBasis?: string | null;
  linkedSessionId?: string | null;
  linkedInvocationId?: string | null;
  unclassifiedCacheWrite?: number;
  incomplete?: boolean;
  requestCountExact?: false;
  // Adjacency facts, read in exact request order before a daily or lifetime bucket removes
  // that order. None of them selects a bucket, so none of them can split one.
  //
  // The visible user turn this request ran under. Two requests with different values ran
  // under different visible prompts. Null where the reducer establishes no visible turn,
  // which keeps the request out of every adjacency answer rather than guessing one.
  visibleTurnId?: string | null;
  // The cache lifetime this request's own write bought, where the record names one. Null
  // where the record is silent, and the model's documented lifetime answers instead.
  cacheLifetime?: CacheLifetime | null;
  // How many compactions this source had recorded before this request ran. A change across
  // two adjacent requests means a compaction sat between them.
  compactionsBefore?: number;
  // An estimated compaction request rather than a recorded one. It reaches the lifetime buckets
  // only, and never the ordered request pass.
  compactionEstimate?: true;
  usage: UsageCounts;
  requestKey: string | null;
}

export interface ProjectUsageBucket {
  localDate: string;
  agent: string;
  provider: string | null;
  model: string | null;
  contextWindow: number | null;
  contextBand: 'short' | 'long' | null;
  billingClass: 'metered' | 'subscription' | 'unknown';
  inferenceClass: 'in-region' | 'geo' | 'global' | 'bedrock-regional' | null;
  serviceTier: string | null;
  // A null value means this bucket must be priced. A number is the sum reported by the
  // provider for these requests, and must never be recomputed from a public rate.
  reportedCost: number | null;
  reportedCostBasis?: string | null;
  linkedSessionId?: string | null;
  linkedInvocationId?: string | null;
  unclassifiedCacheWrite?: number;
  incomplete?: boolean;
  requestCountExact?: false;
  // The requests in this bucket are compaction estimates. Claude Code records no usage for a
  // compaction, so every figure priced from this bucket is an estimate of the usage as well.
  compactionEstimate?: true;
  usage: UsageCounts;
  requests: number;
}

export interface SpendFileIndex {
  file: string;
  workspace: string;
  size: number;
  mtimeMs: number;
  // Byte position at the start of the unprocessed line, if there is one.
  offset: number;
  // Kept serializable for diagnostics and old ledgers. trailingBytes is authoritative so
  // an unfinished UTF-8 character is not decoded before its remaining bytes arrive.
  trailing: string;
  trailingBytes?: string;
  buckets: ProjectUsageBucket[];
  // Whole-file usage stays beside the rolling project-window buckets. Rail costs use it
  // so selecting a session cannot replace a tail subtotal with a larger number.
  // A missing or invalid value is derived again by the bounded background index.
  lifetimeBuckets?: ProjectUsageBucket[];
  // Drawable turns in this one transcript. A number is available only after the reducer
  // scanned the complete file revision. Null means this source's reducer has no turn model;
  // undefined identifies a ledger written before turn counting was added and rebuilds once.
  turnCount?: number | null;
  // How many compaction events this transcript holds, and the span from the first turn's
  // start to the last turn's end (its own start while that turn is still open). Same null and
  // undefined rules as turnCount: null means no turn model, undefined predates these fields.
  compactionCount?: number | null;
  firstTurnAt?: number | null;
  lastTurnAt?: number | null;
  newestTurnStartedAt?: number | null;
  outcome?: TurnOutcome | null;
  // Cache-expiry returns and compaction facts, derived while this source's requests were
  // still in order. Null means this source's reducer emits no ordered request identity;
  // undefined identifies a ledger written before the derivation and rebuilds once.
  cacheExpiry?: CacheExpiryLedger | null;
  // Reader behavior that produced this source's buckets and parser state. A mismatch
  // rebuilds the source even when its size and modification time are unchanged.
  parserGeneration?: number;
  parserKind?: 'claude' | 'codex';
  indexedAt: number;
  parserState?: unknown;
  // A false value means a byte or time budget stopped before the current revision was read.
  // size and mtimeMs still name that target revision, while scanOffset resumes inside it.
  complete?: boolean;
  scanOffset?: number;
  pendingBytes?: string;
  missingAt?: number;
}

export interface SpendLedger {
  workspace: string;
  parserGeneration: number;
  // Resumable scan progress. A file part-way through a rescan appears here as its partial
  // record, so the next slice knows where to carry on.
  files: SpendFileIndex[];
  // The display ledger the rail reads. This is not `files` filtered on `complete`. A file
  // part-way through a rescan appears here as its last whole record, so the reader keeps a
  // whole answer instead of a half-scanned one while the rescan runs. Rebuilding it by
  // filtering `files` loses that record. `projectspend.test.ts` fixes the contract.
  completeFiles: SpendFileIndex[];
}

// Figures for each session, drawn from the records its own sources name. A session's figures
// are held against its source list and the record each source resolves to, so a transcript that
// grows moves only the sessions that read it. A session reads every source listed under its id,
// including a dispatched session's files listed under the session that dispatched it. The ledger
// replaces a record that changes and never edits one in place, so the same record object reads
// the same figures. `calculate` receives one session's records and sources, and must read
// nothing else that can change except `pending`. `assemble` runs only when some session's
// figures moved. `pending` says whether the ledger still holds a file, given its record, as
// `spendSourceHeld` answers it. Only a session with a dispatched source that
// `spendRecordAwaitsLedger` names consults it. Only such a session is figured again when its
// answer moves.
// The same record list, the same source list and the same normalization generation return the
// held value without resolving any path. An invalidated path advances the generation, because
// it can resolve to another record, so the next read resolves every source again.
export class SessionFiguresCache<T, R> {
  private files: readonly SpendFileIndex[] | null = null;
  private sources: readonly SessionSpendSource[] | null = null;
  private generation = -1;
  // Each dispatched source a held session consulted `pending` for, its record, and the answer.
  private watched: SpendPendingAnswers = new Map();
  private groups = new Map<string, SessionSourceGroup>();
  private held = new Map<string, HeldSessionFigures<T>>();
  private value!: R;

  read(
    files: readonly SpendFileIndex[],
    sources: readonly SessionSpendSource[],
    calculate: (
      sessionId: string,
      files: readonly SpendFileIndex[],
      sources: readonly SessionSpendSource[],
      pending: SpendSourcePending,
    ) => T | undefined,
    assemble: (figures: ReadonlyMap<string, T>) => R,
    pending: SpendSourcePending = () => true,
  ): R {
    const heldFiles = this.files;
    if (
      heldFiles &&
      !this.pendingMoved(pending) &&
      sources === this.sources &&
      spendFileNormalizationGeneration === this.generation &&
      files.length === heldFiles.length &&
      files.every((record, at) => record === heldFiles[at])
    ) {
      return this.value;
    }
    if (sources !== this.sources) {
      this.groups = sessionSourceGroups(sources);
    }
    const records = new Map(files.map((record) => [spendRecordKey(record), record]));
    const next = new Map<string, HeldSessionFigures<T>>();
    const watched = new Map<string, { record: SpendFileIndex | undefined; answer: boolean }>();
    let moved = heldFiles === null;
    for (const [sessionId, group] of this.groups) {
      const keys = group.sources.map((source, at) =>
        records.has(group.lexical[at]) ? group.lexical[at] : normalizeSpendFile(source.file),
      );
      const found = keys.map((key) => records.get(key));
      let waiting: Map<string, boolean> | null = null;
      for (let at = 0; at < keys.length; at++) {
        if (group.sources[at].dispatchedFrom !== undefined && spendRecordAwaitsLedger(found[at])) {
          const answer = pending(keys[at], found[at]);
          (waiting ??= new Map()).set(keys[at], answer);
          watched.set(keys[at], { record: found[at], answer });
        }
      }
      const previous = this.held.get(sessionId);
      if (
        previous &&
        sameSessionSources(previous.sources, group.sources) &&
        found.every((record, at) => record === previous.records[at]) &&
        sameWaiting(previous.waiting, waiting)
      ) {
        next.set(sessionId, previous);
        continue;
      }
      moved = true;
      const own = [...new Set(found.filter((record): record is SpendFileIndex => record !== undefined))];
      const held: ReadonlyMap<string, boolean> | null = waiting;
      next.set(sessionId, {
        sources: group.sources,
        records: found,
        waiting: held,
        value: calculate(sessionId, own, group.sources, (file, record) => held?.get(file) ?? pending(file, record)),
      });
    }
    moved ||= next.size !== this.held.size;
    this.held = next;
    this.watched = watched;
    // The list is copied, because the ledger edits its own array in place.
    this.files = files.slice();
    this.sources = sources;
    this.generation = spendFileNormalizationGeneration;
    if (moved) {
      this.value = assemble(
        new Map(
          [...next].flatMap(([sessionId, entry]) =>
            entry.value === undefined ? [] : [[sessionId, entry.value] as const],
          ),
        ),
      );
    }
    return this.value;
  }

  // The answers the last read took. A read replaces the map and never edits it, so a caller can
  // hold it as the answers one drawing used.
  answers(): SpendPendingAnswers {
    return this.watched;
  }

  // Whether `pending` now answers differently for a source in `since`, by default the answers
  // the last read took. The next read then moves a figure that no file change moved.
  pendingMoved(pending: SpendSourcePending, since: SpendPendingAnswers = this.watched): boolean {
    for (const [file, { record, answer }] of since) {
      if (pending(file, record) !== answer) {
        return true;
      }
    }
    return false;
  }
}

function sameWaiting(held: ReadonlyMap<string, boolean> | null, next: ReadonlyMap<string, boolean> | null): boolean {
  return (
    (held?.size ?? 0) === (next?.size ?? 0) && [...(next ?? [])].every(([file, answer]) => held?.get(file) === answer)
  );
}

// A file the ledger read whole: it read every line, and no line is still being written.
function spendRecordWhole(record: SpendFileIndex | undefined): record is SpendFileIndex {
  return (
    !!record &&
    record.complete !== false &&
    !record.trailingBytes &&
    !record.trailing &&
    Array.isArray(record.lifetimeBuckets)
  );
}

// A file the ledger read to its end while the file is still there, whose last line is not
// finished yet. The session that writes it is still running, or it stopped mid-line.
function spendRecordWriting(record: SpendFileIndex | undefined): record is SpendFileIndex {
  return (
    !!record &&
    record.missingAt === undefined &&
    record.complete !== false &&
    Array.isArray(record.lifetimeBuckets) &&
    !!(record.trailing || record.trailingBytes)
  );
}

// A file the ledger read whole while the file is still there, whose newest turn has not ended.
// The session that writes it is still inside that turn, between two writes. A turn ends with a
// final reply, an interruption, an error, or a recorded process end.
function spendRecordRunning(record: SpendFileIndex | undefined): record is SpendFileIndex {
  const outcome = record?.outcome;
  return (
    spendRecordWhole(record) &&
    record.missingAt === undefined &&
    !!outcome &&
    !outcome.finished &&
    !outcome.interrupted &&
    !outcome.error &&
    outcome.processEndedAt === undefined
  );
}

// A dispatched source whose hold on its parent depends on the ledger: the ledger has not read
// it whole, its last line is unfinished, or the session that writes it is still inside a turn.
function spendRecordAwaitsLedger(record: SpendFileIndex | undefined): boolean {
  return !spendRecordWhole(record) || spendRecordRunning(record);
}

export type SpendSourcePending = (file: string, record: SpendFileIndex | undefined) => boolean;

// The `pending` answer a figures read took for each dispatched source it watched, with the record
// it asked about.
export type SpendPendingAnswers = ReadonlyMap<string, { record: SpendFileIndex | undefined; answer: boolean }>;

// Whether the ledger still holds a dispatched source, given its record, whether the ledger
// queues it, and the history limit. A queued source is held. A source whose last line is
// unfinished, or whose session is still inside a turn, is held while its last write falls
// inside the history limit. Nothing else is held, because the history limit skipped it or its
// file is gone. Nothing reads a source past the history limit again, so an unfinished last line
// there stays unfinished.
export function spendSourceHeld(record: SpendFileIndex | undefined, queued: boolean, cutoff: number | null): boolean {
  return (
    queued ||
    ((spendRecordWriting(record) || spendRecordRunning(record)) && (cutoff === null || record.mtimeMs >= cutoff))
  );
}

interface SessionSourceGroup {
  sources: SessionSpendSource[];
  // Each source's path in the form a record is keyed by, when the record uses the same spelling.
  lexical: string[];
}

interface HeldSessionFigures<T> {
  sources: readonly SessionSpendSource[];
  records: readonly (SpendFileIndex | undefined)[];
  // The `pending` answer for each unread dispatched source the figures read, or null for none.
  waiting: ReadonlyMap<string, boolean> | null;
  value: T | undefined;
}

// A record's file in the form sources are matched against. The file of a record never changes,
// so the form is held for as long as the record is.
const spendRecordKeys = new WeakMap<SpendFileIndex, string>();
function spendRecordKey(record: SpendFileIndex): string {
  let key = spendRecordKeys.get(record);
  if (key === undefined) {
    key = normalizeWorkspace(record.file);
    spendRecordKeys.set(record, key);
  }
  return key;
}

function sessionSourceGroups(sources: readonly SessionSpendSource[]): Map<string, SessionSourceGroup> {
  const groups = new Map<string, SessionSourceGroup>();
  for (const source of sources) {
    const group = groups.get(source.sessionId) ?? { sources: [], lexical: [] };
    group.sources.push(source);
    group.lexical.push(normalizeWorkspace(source.file));
    groups.set(source.sessionId, group);
  }
  return groups;
}

function sameSessionSources(held: readonly SessionSpendSource[], next: readonly SessionSpendSource[]): boolean {
  return (
    held === next ||
    (held.length === next.length &&
      held.every(
        (source, at) =>
          source.sessionId === next[at].sessionId &&
          source.file === next[at].file &&
          source.primary === next[at].primary &&
          source.dispatchedFrom === next[at].dispatchedFrom,
      ))
  );
}

export const PROJECT_SPEND_INTEGRITY_MILLISECONDS = 30_000;
// The ledger save waits for this much quiet after a change, and never longer than the maximum
// after the first unsaved change.
export const PROJECT_SPEND_SAVE_MS = 500;
export const PROJECT_SPEND_SAVE_MAX_MS = 5_000;
// A failed ledger save tries again after this wait, and each later wait doubles. After
// `PROJECT_SPEND_SAVE_RETRIES` tries the save stays owed until the next ledger change or flush.
export const PROJECT_SPEND_SAVE_RETRY_MS = 2_000;
export const PROJECT_SPEND_SAVE_RETRIES = 5;

// The wait before the next try of a failed ledger save, or null once every try is spent.
export function projectSpendSaveRetryDelay(retries: number): number | null {
  return retries < PROJECT_SPEND_SAVE_RETRIES ? PROJECT_SPEND_SAVE_RETRY_MS * 2 ** retries : null;
}
// The generation of a stored spend record. A record from another generation is read again, so
// raise this whenever a stored field changes what a reader of the record may conclude from it.
export const PROJECT_SPEND_PARSER_GENERATION = 28;

export function projectSpendSourceOfferDue(listingMoved: boolean, now: number, lastOfferAt: number): boolean {
  return listingMoved || now - lastOfferAt >= PROJECT_SPEND_INTEGRITY_MILLISECONDS;
}

const DAY_MILLISECONDS = 86_400_000;

// The oldest file modification time Project cost indexing reads. Null reads all history.
export function projectSpendHistoryCutoff(historyDays: number, now: number): number | null {
  if (!Number.isFinite(historyDays) || historyDays < 1) {
    return null;
  }
  return now - Math.floor(historyDays) * DAY_MILLISECONDS;
}

export interface SpendSourceRevision {
  size: number;
  mtimeMs: number;
}

// What one offer does with a source. A file that last changed before the cutoff holds no
// request after it, so indexing skips it and leaves its saved record as it is. `revision`
// is undefined when the offer read no file facts, and null when the file is gone.
export function projectSpendOfferDecision(
  previous: SpendFileIndex | undefined,
  revision: SpendSourceRevision | null | undefined,
  cutoff: number | null,
): 'skip' | 'current' | 'queue' {
  if (revision && cutoff !== null && revision.mtimeMs < cutoff) {
    return 'skip';
  }
  if (!previous) {
    return 'queue';
  }
  if (!revision) {
    return revision === null && previous.missingAt !== undefined ? 'current' : 'queue';
  }
  const changed =
    revision.size !== previous.size ||
    revision.mtimeMs !== previous.mtimeMs ||
    previous.missingAt !== undefined ||
    previous.complete === false ||
    !spendRecordHasLifetimeFacts(previous);
  return changed ? 'queue' : 'current';
}

export interface UsageLineReducer<State = unknown> {
  parserKind?: 'claude' | 'codex';
  pushLine(line: string): readonly UsageEvent[];
  snapshot(): State;
  turnCount?(): number | null;
  compactionCount?(): number | null;
  recentCompactions?(): readonly ReducerCompaction[];
  firstTurnAt?(): number | null;
  lastTurnAt?(): number | null;
  newestTurnStartedAt?(): number | null;
  newestTurnOutcome?(): TurnOutcome | null;
}

export type UsageReducerFactory<State = unknown> = (state: State | undefined) => UsageLineReducer<State>;

export interface IndexSpendFileResult {
  record: SpendFileIndex;
  // True only when the raw totals changed. State can move forward on an unfinished line
  // without changing a displayed total, so callers that persist the ledger need stateChanged.
  totalsChanged: boolean;
  stateChanged: boolean;
  changed: boolean;
  rebuilt: boolean;
  found: boolean;
  // Whether every byte in the observed file revision has been scanned. A false result must
  // be queued again with the returned record, even when its totals did not change.
  complete: boolean;
}

export function spendRecordChangesRail(previous: SpendFileIndex | undefined, current: SpendFileIndex): boolean {
  return current.complete === true || previous?.complete === true;
}

function readyCount(value: number | null | undefined): boolean {
  return value === null || (Number.isSafeInteger(value) && (value ?? -1) >= 0);
}

function readyTimestamp(value: number | null | undefined): boolean {
  return value === null || Number.isFinite(value);
}

function readyClosedChild(value: unknown): boolean {
  return (
    (typeof value === 'string' && value.length > 0) ||
    (typeof value === 'object' &&
      value !== null &&
      typeof (value as { id?: unknown }).id === 'string' &&
      (value as { id: string }).id.length > 0 &&
      Number.isFinite((value as { closedAt?: unknown }).closedAt))
  );
}

function readyOutcome(value: TurnOutcome | null | undefined): boolean {
  return (
    value === null ||
    (typeof value === 'object' &&
      value !== undefined &&
      typeof value.finished === 'boolean' &&
      typeof value.error === 'boolean' &&
      typeof value.interrupted === 'boolean' &&
      Number.isFinite(value.endedAt) &&
      (!Object.prototype.hasOwnProperty.call(value, 'processEndedAt') || Number.isFinite(value.processEndedAt)) &&
      (!Object.prototype.hasOwnProperty.call(value, 'openChildren') ||
        (Array.isArray(value.openChildren) &&
          value.openChildren.every((id) => typeof id === 'string' && id.length > 0))) &&
      (!Object.prototype.hasOwnProperty.call(value, 'closedChildren') ||
        (Array.isArray(value.closedChildren) && value.closedChildren.every(readyClosedChild))))
  );
}

export function spendRecordHasLifetimeFacts(record: SpendFileIndex): boolean {
  return (
    Array.isArray(record.lifetimeBuckets) &&
    Object.prototype.hasOwnProperty.call(record, 'turnCount') &&
    Object.prototype.hasOwnProperty.call(record, 'compactionCount') &&
    Object.prototype.hasOwnProperty.call(record, 'firstTurnAt') &&
    Object.prototype.hasOwnProperty.call(record, 'lastTurnAt') &&
    Object.prototype.hasOwnProperty.call(record, 'newestTurnStartedAt') &&
    Object.prototype.hasOwnProperty.call(record, 'outcome') &&
    Object.prototype.hasOwnProperty.call(record, 'cacheExpiry') &&
    readyCount(record.turnCount) &&
    readyCount(record.compactionCount) &&
    readyTimestamp(record.firstTurnAt) &&
    readyTimestamp(record.lastTurnAt) &&
    readyTimestamp(record.newestTurnStartedAt) &&
    readyOutcome(record.outcome) &&
    record.parserGeneration === PROJECT_SPEND_PARSER_GENERATION
  );
}

export interface ProjectSpendWindow {
  id: 'today' | 'sevenDays' | 'thirtyDays';
  label: string;
  dollars: number | null;
  display: string;
  status: 'exact' | 'atLeast' | 'unknown';
  partial: boolean;
  pricedRequests: number;
  unpricedRequests: number;
}

export interface ProjectSpendCategory {
  id: 'claude' | 'codex';
  label: string;
  windows: ProjectSpendWindow[];
}

export interface ProjectSpendView {
  name: string;
  windows: ProjectSpendWindow[];
  categories: ProjectSpendCategory[];
  earliestRecord: string | null;
  lastIndexedAt: number | null;
  rateSources: { source: string; effectiveDate: string | null; provenance: ProjectSpendProvenance }[];
  indexing: boolean;
}

export type ProjectSpendProvenance = 'reported' | 'configured' | 'public';

export interface ProjectSpendPrice {
  dollars: number;
  source: string;
  effectiveDate: string | null;
  estimated: boolean;
  provenance: ProjectSpendProvenance;
}

export type ProjectSpendPricer = (bucket: ProjectUsageBucket) => ProjectSpendPrice | null;

export interface ModelPricingSetting {
  model: string;
  provider?: string;
  inferenceClass?: 'in-region' | 'geo' | 'global';
  serviceTier?: string;
  input: number;
  output: number;
  cacheWrite30m?: number;
  cacheRead?: number;
  source: string;
  effectiveDate: string;
}

function validEffectiveDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value;
}

function matchingOverride(bucket: ProjectUsageBucket, entry: ModelPricingSetting): boolean {
  return (
    entry.model === bucket.model &&
    (entry.provider === undefined || entry.provider === bucket.provider) &&
    (entry.inferenceClass === undefined || entry.inferenceClass === bucket.inferenceClass) &&
    (entry.serviceTier === undefined || entry.serviceTier === bucket.serviceTier)
  );
}

// Select by the bucket's local record date rather than today's date. The final comparison
// resolves same-day configuration conflicts consistently even if settings reorder entries.
export function modelPricingOverrideFor(
  bucket: ProjectUsageBucket,
  overrides: readonly ModelPricingSetting[],
): ModelPricingSetting | null {
  return (
    overrides
      .filter(
        (entry) =>
          matchingOverride(bucket, entry) &&
          validEffectiveDate(entry.effectiveDate) &&
          entry.effectiveDate <= bucket.localDate,
      )
      .sort(
        (left, right) =>
          right.effectiveDate.localeCompare(left.effectiveDate) ||
          left.source.localeCompare(right.source) ||
          JSON.stringify(left).localeCompare(JSON.stringify(right)),
      )[0] ?? null
  );
}

// Names where a recorded cost came from, or null for a basis that is not a recorded price.
function recordedCostSource(basis: string | null | undefined): string | null {
  if (basis === 'list') {
    return 'Claude CLI recorded list price';
  }
  if (basis === BEDROCK_LIST_COST_BASIS) {
    return 'Claude CLI recorded list price, times 1.1 for Amazon Bedrock';
  }
  return null;
}

export function publicProjectSpendPrice(
  bucket: ProjectUsageBucket,
  overrides: readonly ModelPricingSetting[] = [],
): ProjectSpendPrice | null {
  const recordedSource = recordedCostSource(bucket.reportedCostBasis);
  if (bucket.reportedCost !== null && recordedSource) {
    return {
      dollars: bucket.reportedCost,
      source: recordedSource,
      effectiveDate: null,
      estimated: true,
      provenance: 'public',
    };
  }
  const summedTokens =
    bucket.usage.input +
    bucket.usage.cacheWrite1h +
    bucket.usage.cacheWrite5m +
    (bucket.usage.cacheWrite30m ?? 0) +
    bucket.usage.cacheRead;
  const configured = modelPricingOverrideFor(bucket, overrides);
  if (
    hasRequestContextPricing(bucket.model, bucket.provider) &&
    bucket.contextBand == null &&
    bucket.requests > 1 &&
    contextBandForRequest(bucket.model, bucket.provider, summedTokens) !== 'short' &&
    bucket.reportedCost === null &&
    configured === null
  ) {
    return null;
  }
  const requestTokens = bucket.contextBand === 'long' ? 272_001 : bucket.contextBand === 'short' ? 0 : summedTokens;
  const quote = quoteUsage({
    usage: bucket.usage,
    model: bucket.model,
    provider: bucket.provider,
    contextWindow: bucket.contextWindow,
    requestTokens,
    inferenceClass: bucket.inferenceClass,
    serviceTier: bucket.serviceTier,
    reportedCost: bucket.reportedCost,
    override: configured
      ? {
          rate: {
            input: configured.input,
            output: configured.output,
            ...(configured.cacheWrite30m === undefined ? {} : { cacheWrite30m: configured.cacheWrite30m }),
            ...(configured.cacheRead === undefined ? {} : { cacheRead: configured.cacheRead }),
          },
          source: configured.source,
          effectiveDate: configured.effectiveDate,
          ...(configured.serviceTier === undefined ? {} : { serviceTier: configured.serviceTier }),
        }
      : null,
  });
  return quote
    ? {
        dollars: quote.cost,
        source: quote.reported ? 'Provider-reported cost' : quote.source,
        effectiveDate: quote.effectiveDate,
        estimated: !quote.reported,
        provenance: quote.reported ? 'reported' : configured ? 'configured' : 'public',
      }
    : null;
}

export function emptyUsage(): UsageCounts {
  return { input: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWrite30m: 0, cacheRead: 0, output: 0, thinking: 0 };
}

export function normalizeWorkspace(workspace: string): string {
  const unified = path.resolve(workspace).replace(/\\/g, '/');
  return process.platform === 'win32' ? unified.toLowerCase() : unified;
}

const canonicalPaths = new Map<string, string>();
// Advances whenever a held canonical path is dropped, because the next resolution of that path
// can name another file.
let spendFileNormalizationGeneration = 0;

function canonicalPath(file: string): string {
  const cached = canonicalPaths.get(file);
  if (cached !== undefined) {
    return cached;
  }
  let resolved = path.resolve(file);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    /* a disappeared source still has an identity */
  }
  const normalized = normalizeWorkspace(resolved);
  canonicalPaths.set(file, normalized);
  return normalized;
}

export function normalizeSpendFile(file: string): string {
  return canonicalPath(file);
}

export function invalidateSpendFileNormalization(file: string): void {
  if (canonicalPaths.delete(file)) {
    spendFileNormalizationGeneration++;
  }
}

function localDate(at: number | Date): string {
  const date = typeof at === 'number' ? new Date(at) : at;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function localMidnight(at: number | Date = Date.now()): Date {
  const date = new Date(typeof at === 'number' ? at : at.getTime());
  date.setHours(0, 0, 0, 0);
  return date;
}

export function projectSpendWindows(
  at: number | Date = Date.now(),
): { id: ProjectSpendWindow['id']; label: string; start: string }[] {
  const midnight = localMidnight(at);
  const start = (daysBefore: number) => {
    const date = new Date(midnight);
    date.setDate(date.getDate() - daysBefore);
    return localDate(date);
  };
  return [
    { id: 'today', label: 'Today', start: start(0) },
    { id: 'sevenDays', label: '7 days', start: start(6) },
    { id: 'thirtyDays', label: '30 days', start: start(29) },
  ];
}

function addUsage(into: UsageCounts, add: UsageCounts): void {
  into.requests = (into.requests ?? 0) + (add.requests ?? 0);
  into.input += add.input;
  into.cacheWrite1h += add.cacheWrite1h;
  into.cacheWrite5m += add.cacheWrite5m;
  into.cacheWrite30m = (into.cacheWrite30m ?? 0) + (add.cacheWrite30m ?? 0);
  into.cacheRead += add.cacheRead;
  into.output += add.output;
  into.thinking += add.thinking;
}

function requestInputTokens(usage: UsageCounts): number {
  return usage.input + usage.cacheWrite1h + usage.cacheWrite5m + (usage.cacheWrite30m ?? 0) + usage.cacheRead;
}

function bucketIsEmpty(bucket: ProjectUsageBucket): boolean {
  return (
    bucket.requests === 0 &&
    bucket.usage.input === 0 &&
    bucket.usage.cacheWrite1h === 0 &&
    bucket.usage.cacheWrite5m === 0 &&
    (bucket.usage.cacheWrite30m ?? 0) === 0 &&
    bucket.usage.cacheRead === 0 &&
    bucket.usage.output === 0 &&
    bucket.usage.thinking === 0 &&
    (bucket.unclassifiedCacheWrite ?? 0) === 0 &&
    (bucket.reportedCost === null || bucket.reportedCost === 0)
  );
}

export function aggregateUsageEvents(
  events: readonly UsageEvent[],
  existing: ProjectUsageBucket[] = [],
): ProjectUsageBucket[] {
  const byKey = new Map(
    existing.map((bucket) => [projectUsageKey(bucket, bucket.localDate), { ...bucket, usage: { ...bucket.usage } }]),
  );
  for (const event of events) {
    const date = localDate(event.timestamp);
    const contextBand =
      event.contextBand ?? contextBandForRequest(event.model, event.provider, requestInputTokens(event.usage));
    const keyed = { ...event, contextBand };
    const key = projectUsageKey(keyed, date);
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = {
        localDate: date,
        agent: event.agent,
        provider: event.provider,
        model: event.model,
        contextWindow: event.contextWindow,
        contextBand,
        billingClass: event.billingClass,
        inferenceClass: event.inferenceClass,
        serviceTier: event.serviceTier,
        reportedCostBasis: event.reportedCostBasis ?? null,
        linkedSessionId: event.linkedSessionId ?? null,
        linkedInvocationId: event.linkedInvocationId ?? null,
        incomplete: event.incomplete === true,
        ...(event.requestCountExact === false ? { requestCountExact: false as const } : {}),
        reportedCost: event.reportedCost === null ? null : 0,
        usage: emptyUsage(),
        requests: 0,
      };
      byKey.set(key, bucket);
    }
    addUsage(bucket.usage, event.usage);
    bucket.unclassifiedCacheWrite = (bucket.unclassifiedCacheWrite ?? 0) + (event.unclassifiedCacheWrite ?? 0);
    if (!bucket.unclassifiedCacheWrite) {
      delete bucket.unclassifiedCacheWrite;
    }
    bucket.requests += event.usage.requests ?? 1;
    if (event.reportedCost !== null) {
      bucket.reportedCost = (bucket.reportedCost ?? 0) + event.reportedCost;
    }
    if (bucketIsEmpty(bucket)) {
      byKey.delete(key);
    }
  }
  return [...byKey.values()].sort((a, b) =>
    projectUsageKey(a, a.localDate).localeCompare(projectUsageKey(b, b.localDate)),
  );
}

// # Cache expiry and compaction, derived in exact request order
//
// A daily or lifetime bucket answers what a day cost. It cannot answer what happened between
// two requests, because it has already merged them. These types are filled during the scan,
// while the reducer still emits one event per request in the order the source recorded them.
//
// Nothing here claims that waiting caused cost. It reports the input a request paid for after
// its predecessor's cache had certainly expired. Fresh prompt text and cache-key changes the
// record does not carry both move that figure, so the claim stops at what was observed.

// One qualifying return, kept in the shape the cost resolver already quotes.
export interface CacheExpiryReturn {
  // The lifetime that had run out on the previous request.
  lifetime: CacheTier;
  // The request-to-request gap that crossed it, in milliseconds.
  gapMs: number;
  // The return request itself, as one priceable row.
  request: ProjectUsageBucket;
}

export interface CacheExpiryFacts {
  // Exact qualifying returns, split by the lifetime that ran out. These counts stay exact
  // however many returns the source held.
  counts: Record<CacheTier, number>;
  // The newest of those returns in full, bounded by `RETAINED_CACHE_EXPIRY_RETURNS`.
  returns: CacheExpiryReturn[];
  // True once a return has been dropped from `returns`. A dollar figure built from the list
  // is then a lower bound, while the counts above remain the whole answer.
  truncated: boolean;
  // The longest qualifying gap, in milliseconds.
  longestGapMs: number | null;
  // Adjacent requests that crossed a lifetime with a compaction, a model change, a provider
  // change, a service-tier change, or an inference-geo change between them. The record cannot
  // separate an idle gap from those, so they are counted here and never added to `counts`.
  excluded: number;
  // Adjacent requests the record cannot answer at all: an unknown lifetime, a missing or
  // out-of-order clock, an incomplete request, or a request under no visible turn.
  unavailable: number;
}

export interface CompactionFact {
  // Which compaction this is in the source, counting from one.
  ordinal: number;
  // The recorded compaction time, while the reducer's newest-compaction window still holds
  // it. An older compaction in a long source keeps its other facts and reports no time.
  at: number | null;
  trigger: string | null;
  // The input-side tokens the last request before this compaction sent, and the tokens the
  // first request after it sent. A usage record establishes no other context size.
  contextBefore: number | null;
  contextAfter: number | null;
  // Primary requests after this compaction, until the next compaction or the source's end.
  requestsAfter: number;
  // That first request after the compaction, as one priceable row. A compaction that ends a
  // session keeps none, and reports zero later requests rather than no fact at all.
  firstRequestAfter: ProjectUsageBucket | null;
  // The compaction request's own usage, where the source records it, with the identity that
  // billed it. A compacted record carries the usage without that identity, and the settings
  // record after it names the identity, so an unanswered field stays null rather than taking
  // the value of a request that is not this one.
  requestUsage: TurnUsage | null;
  requestModel: string | null;
  requestProvider: string | null;
  requestServiceTier: string | null;
  requestContextWindow: number | null;
}

// The newest primary request, reduced to what the next comparison needs. Saved with the
// ledger so an incremental slice compares across the seam instead of starting again.
export interface CacheExpiryCarry {
  requestKey: string | null;
  timestamp: number;
  visibleTurnId: string | null;
  lifetime: CacheTier | null;
  model: string | null;
  provider: string | null;
  serviceTier: string | null;
  effort?: string | null;
  toolListVersion?: number | null;
  inferenceClass: 'in-region' | 'geo' | 'global' | 'bedrock-regional' | null;
  compactionsBefore: number;
  inputTokens: number;
  incomplete: boolean;
}

export interface CacheExpiryLedger {
  facts: CacheExpiryFacts;
  compactions: CompactionFact[];
  carry: CacheExpiryCarry | null;
  // The request key of the newest recorded return and of the newest recorded compaction, so
  // a revision arriving in a later slice reaches the row it replaces.
  newestReturnKey: string | null;
  newestCompactionKey: string | null;
}

export function emptyCacheExpiryFacts(): CacheExpiryFacts {
  return {
    counts: { '5m': 0, '30m': 0, '1h': 0 },
    returns: [],
    truncated: false,
    longestGapMs: null,
    excluded: 0,
    unavailable: 0,
  };
}

export function emptyCacheExpiryLedger(): CacheExpiryLedger {
  return {
    facts: emptyCacheExpiryFacts(),
    compactions: [],
    carry: null,
    newestReturnKey: null,
    newestCompactionKey: null,
  };
}

export type CacheExpiryVerdict =
  | { kind: 'return'; lifetime: CacheTier; gapMs: number }
  | { kind: 'excluded' }
  | { kind: 'unavailable' }
  | { kind: 'none' };

function positiveClock(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function recordsColdInput(usage: UsageCounts): boolean {
  return usage.input > 0 || usage.cacheWrite1h > 0 || usage.cacheWrite5m > 0 || (usage.cacheWrite30m ?? 0) > 0;
}

// The lifetime a request bought: the one its own record names, or the one its model's price
// row documents where the record is silent. This is the order the rail cache mark uses.
export function requestCacheLifetime(
  recorded: CacheLifetime | null | undefined,
  model: string | null,
  provider: string | null,
): CacheTier | null {
  return recorded ?? cacheLifetimeFor(model, provider);
}

// Classify one adjacent pair of primary requests. Pure, so each gate below is testable on its
// own, and so the nominal lifetime stays the only clock this comparison ever uses.
export function classifyCacheExpiry(
  previous: CacheExpiryCarry,
  next: CacheExpiryCarry,
  nextUsage: UsageCounts,
): CacheExpiryVerdict {
  if (previous.visibleTurnId === null || next.visibleTurnId === null) {
    return { kind: 'unavailable' };
  }
  // A long tool run inside one visible turn is not a reader who walked away. The next request
  // there follows the same prompt, so no new prompt ever paid for a cold cache.
  if (previous.visibleTurnId === next.visibleTurnId) {
    return { kind: 'none' };
  }
  if (!positiveClock(previous.timestamp) || !positiveClock(next.timestamp) || next.timestamp < previous.timestamp) {
    return { kind: 'unavailable' };
  }
  if (previous.incomplete || next.incomplete) {
    return { kind: 'unavailable' };
  }
  const lifetime = previous.lifetime;
  if (lifetime === null) {
    return { kind: 'unavailable' };
  }
  if (!cacheLapsedBy(previous.timestamp, lifetime, next.timestamp)) {
    return { kind: 'none' };
  }
  if (
    previous.compactionsBefore !== next.compactionsBefore ||
    previous.model !== next.model ||
    previous.provider !== next.provider ||
    previous.serviceTier !== next.serviceTier ||
    previous.inferenceClass !== next.inferenceClass
  ) {
    return { kind: 'excluded' };
  }
  if (previous.effort != null && next.effort != null && previous.effort !== next.effort) {
    return { kind: 'excluded' };
  }
  if (
    previous.toolListVersion != null &&
    next.toolListVersion != null &&
    previous.toolListVersion !== next.toolListVersion
  ) {
    return { kind: 'excluded' };
  }
  if (!recordsColdInput(nextUsage)) {
    return { kind: 'none' };
  }
  return { kind: 'return', lifetime, gapMs: next.timestamp - previous.timestamp };
}

function requestBucket(event: UsageEvent): ProjectUsageBucket {
  const date = localDate(event.timestamp);
  const contextBand =
    event.contextBand ?? contextBandForRequest(event.model, event.provider, requestInputTokens(event.usage));
  return {
    localDate: date,
    agent: event.agent,
    provider: event.provider,
    model: event.model,
    contextWindow: event.contextWindow,
    contextBand,
    billingClass: event.billingClass,
    inferenceClass: event.inferenceClass,
    serviceTier: event.serviceTier,
    reportedCostBasis: event.reportedCostBasis ?? null,
    linkedSessionId: event.linkedSessionId ?? null,
    linkedInvocationId: event.linkedInvocationId ?? null,
    incomplete: event.incomplete === true,
    ...(event.requestCountExact === false ? { requestCountExact: false as const } : {}),
    reportedCost: event.reportedCost,
    usage: { ...event.usage, requests: 1 },
    requests: 1,
  };
}

function carryFor(event: UsageEvent): CacheExpiryCarry {
  return {
    requestKey: event.requestKey,
    timestamp: event.timestamp,
    visibleTurnId: event.visibleTurnId ?? null,
    lifetime: requestCacheLifetime(event.cacheLifetime, event.model, event.provider),
    model: event.model,
    provider: event.provider,
    serviceTier: event.serviceTier,
    inferenceClass: event.inferenceClass,
    effort: event.effort ?? null,
    toolListVersion: event.toolListVersion ?? null,
    compactionsBefore: event.compactionsBefore ?? 0,
    inputTokens: requestInputTokens(event.usage),
    incomplete: event.incomplete === true,
  };
}

// Whether this event is one primary-session request the order pass can compare. Delegated
// work is excluded by its link, and a removal or a replacement by its negative request count.
function primaryOrderedRequest(event: UsageEvent): boolean {
  return (
    !event.compactionEstimate && !event.linkedSessionId && !event.linkedInvocationId && (event.usage.requests ?? 1) > 0
  );
}

// Folds the ordered request stream into the derived ledger. One instance covers one source
// file, and it resumes from a saved ledger, so an incremental slice gives the same answer as
// one whole scan of the same bytes.
export class CacheExpiryScan {
  private readonly facts: CacheExpiryFacts;
  private readonly compactions: CompactionFact[];
  private carry: CacheExpiryCarry | null;
  private newestReturnKey: string | null;
  private newestCompactionKey: string | null;

  constructor(previous?: CacheExpiryLedger) {
    const restored = previous ?? emptyCacheExpiryLedger();
    this.facts = {
      counts: { ...restored.facts.counts },
      returns: restored.facts.returns.map((item) => ({
        ...item,
        request: { ...item.request, usage: { ...item.request.usage } },
      })),
      truncated: restored.facts.truncated,
      longestGapMs: restored.facts.longestGapMs,
      excluded: restored.facts.excluded,
      unavailable: restored.facts.unavailable,
    };
    this.compactions = restored.compactions.map((item) => ({ ...item }));
    this.carry = restored.carry ? { ...restored.carry } : null;
    this.newestReturnKey = restored.newestReturnKey;
    this.newestCompactionKey = restored.newestCompactionKey;
  }

  push(event: UsageEvent): void {
    if (!primaryOrderedRequest(event)) {
      return;
    }
    // A child transcript rewrites one response as it grows, and its reducer pairs a removal
    // with a replacement under the same key. The replacement is that same request with larger
    // counts, so it revises what is already recorded instead of opening a new comparison.
    if (this.carry && event.requestKey !== null && event.requestKey === this.carry.requestKey) {
      this.revise(event);
      return;
    }
    const next = carryFor(event);
    // Codex holds a request whose model is not yet named, and releases it when a later record
    // names one. That release can arrive after requests which ran after it, and its own clock
    // says so. Such a pair cannot be judged, and the newest request has to stay the one the
    // next comparison measures from. Taking the released request as the carry would measure a
    // later request's gap from the wrong predecessor and report an expiry that never happened.
    if (
      this.carry &&
      positiveClock(this.carry.timestamp) &&
      positiveClock(next.timestamp) &&
      next.timestamp < this.carry.timestamp
    ) {
      this.facts.unavailable++;
      return;
    }
    this.recordCompactions(next, event);
    if (this.carry) {
      this.judge(this.carry, next, event);
    }
    this.carry = next;
  }

  private revise(event: UsageEvent): void {
    const revised = carryFor(event);
    this.carry = revised;
    const newestReturn = this.facts.returns[this.facts.returns.length - 1];
    if (newestReturn && this.newestReturnKey === event.requestKey) {
      newestReturn.request = requestBucket(event);
    }
    const newestCompaction = this.compactions[this.compactions.length - 1];
    if (newestCompaction && this.newestCompactionKey === event.requestKey) {
      newestCompaction.firstRequestAfter = requestBucket(event);
      newestCompaction.contextAfter = revised.incomplete ? null : revised.inputTokens;
    }
  }

  private recordCompactions(next: CacheExpiryCarry, event: UsageEvent): void {
    const before = this.carry?.compactionsBefore ?? 0;
    const added = next.compactionsBefore - before;
    if (added <= 0) {
      const open = this.compactions[this.compactions.length - 1];
      if (open && open.ordinal === next.compactionsBefore) {
        open.requestsAfter++;
      }
      return;
    }
    // Several compactions can sit in one gap. The first of them is the one the earlier
    // request's context preceded, and the last is the one this request's context follows.
    // An ordinal a trailing compaction already opened is completed rather than repeated.
    for (let step = 1; step <= added; step++) {
      const fact = this.openCompaction(
        before + step,
        step === 1 && !this.carry?.incomplete ? (this.carry?.inputTokens ?? null) : null,
      );
      if (step !== added) {
        continue;
      }
      fact.contextAfter = next.incomplete ? null : next.inputTokens;
      fact.requestsAfter++;
      fact.firstRequestAfter = requestBucket(event);
    }
    this.newestCompactionKey = event.requestKey;
    this.trimCompactions();
  }

  private openCompaction(ordinal: number, contextBefore: number | null): CompactionFact {
    const held = this.compactions.find((item) => item.ordinal === ordinal);
    if (held) {
      return held;
    }
    const fact: CompactionFact = {
      ordinal,
      at: null,
      trigger: null,
      contextBefore,
      contextAfter: null,
      requestsAfter: 0,
      firstRequestAfter: null,
      requestUsage: null,
      requestModel: null,
      requestProvider: null,
      requestServiceTier: null,
      requestContextWindow: null,
    };
    this.compactions.push(fact);
    this.compactions.sort((left, right) => left.ordinal - right.ordinal);
    return fact;
  }

  private trimCompactions(): void {
    while (this.compactions.length > RETAINED_COMPACTIONS) {
      this.compactions.shift();
    }
  }

  private judge(previous: CacheExpiryCarry, next: CacheExpiryCarry, event: UsageEvent): void {
    const verdict = classifyCacheExpiry(previous, next, event.usage);
    if (verdict.kind === 'unavailable') {
      this.facts.unavailable++;
      return;
    }
    if (verdict.kind === 'excluded') {
      this.facts.excluded++;
      return;
    }
    if (verdict.kind === 'none') {
      return;
    }
    this.facts.counts[verdict.lifetime]++;
    this.facts.longestGapMs =
      this.facts.longestGapMs === null ? verdict.gapMs : Math.max(this.facts.longestGapMs, verdict.gapMs);
    this.facts.returns.push({
      lifetime: verdict.lifetime,
      gapMs: verdict.gapMs,
      request: requestBucket(event),
    });
    this.newestReturnKey = event.requestKey;
    while (this.facts.returns.length > RETAINED_CACHE_EXPIRY_RETURNS) {
      this.facts.returns.shift();
      this.facts.truncated = true;
    }
  }

  // The ledger for this source. `recorded` is the reducer's newest-compaction window, each
  // entry naming its own ordinal, so the window needs no separate total to be read against.
  // A compaction whose record carried no usable clock takes an entry with a null time, and
  // therefore cannot shift another compaction's time onto itself.
  //
  // A fact is normally opened by the first request after its compaction. A compaction that
  // ends a session has no such request, so this opens one for every recorded compaction the
  // requests did not reach. The reader still gets its time, the context before it, and a
  // later-request count of zero, rather than no evidence that it happened.
  ledger(recorded: readonly ReducerCompaction[]): CacheExpiryLedger {
    const reached = this.carry?.compactionsBefore ?? 0;
    for (const item of recorded) {
      if (item.ordinal <= reached) {
        continue;
      }
      this.openCompaction(
        item.ordinal,
        item.ordinal === reached + 1 && !this.carry?.incomplete ? (this.carry?.inputTokens ?? null) : null,
      );
    }
    this.trimCompactions();
    const byOrdinal = new Map(recorded.map((item) => [item.ordinal, item]));
    return {
      facts: this.facts,
      compactions: this.compactions.map((item) => {
        const held = byOrdinal.get(item.ordinal);
        return {
          ...item,
          at: held?.at ?? null,
          trigger: held?.trigger ?? null,
          requestUsage: held?.requestUsage ?? null,
          requestModel: held?.requestModel ?? null,
          requestProvider: held?.requestProvider ?? null,
          requestServiceTier: held?.requestServiceTier ?? null,
          requestContextWindow: held?.requestContextWindow ?? null,
        };
      }),
      carry: this.carry,
      newestReturnKey: this.newestReturnKey,
      newestCompactionKey: this.newestCompactionKey,
    };
  }
}

// The input a cache-expiry return paid for again: ordinary uncached input and the cache write
// it had to make a second time. A cache it still read was never lost, so its cost is not part
// of this figure, and an answer is not input.
export function cacheExpiryInputUsage(request: ProjectUsageBucket): ProjectUsageBucket {
  return {
    ...request,
    usage: {
      requests: 1,
      input: request.usage.input,
      cacheWrite1h: request.usage.cacheWrite1h,
      cacheWrite5m: request.usage.cacheWrite5m,
      cacheWrite30m: request.usage.cacheWrite30m ?? 0,
      cacheRead: 0,
      output: 0,
      thinking: 0,
    },
  };
}

export interface CacheExpiryInputCost {
  dollars: number | null;
  status: 'exact' | 'atLeast' | 'unknown';
}

// What the qualifying returns spent on input after expiry.
//
// A row the provider priced as a whole cannot be split into its input side, so it leaves the
// figure a lower bound rather than being estimated at a list rate it was not billed at. A
// truncated list does the same.
export function cacheExpiryInputCost(facts: CacheExpiryFacts, pricer: ProjectSpendPricer): CacheExpiryInputCost {
  let dollars = 0;
  let priced = 0;
  let partial = facts.truncated;
  for (const item of facts.returns) {
    if (item.request.incomplete || item.request.reportedCost !== null) {
      partial = true;
      continue;
    }
    const price = pricer(cacheExpiryInputUsage(item.request));
    if (!price) {
      partial = true;
      continue;
    }
    dollars += price.dollars;
    priced++;
  }
  if (priced === 0) {
    return partial || facts.returns.length > 0 ? { dollars: null, status: 'unknown' } : { dollars: 0, status: 'exact' };
  }
  return { dollars, status: partial ? 'atLeast' : 'exact' };
}

function sameBuckets(left: readonly ProjectUsageBucket[], right: readonly ProjectUsageBucket[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export interface SpendIndexBudget {
  maxBytes?: number;
  maxMilliseconds?: number;
  now?: () => number;
}

const DEFAULT_SCAN_BYTES = BACKGROUND_SCAN_BYTES;
const DEFAULT_SCAN_MILLISECONDS = BACKGROUND_SCAN_MILLISECONDS;

interface IncrementalRead {
  offset: number;
  trailing: Buffer;
  scanOffset: number;
  complete: boolean;
  buckets: ProjectUsageBucket[];
  lifetimeBuckets: ProjectUsageBucket[];
  turnCount: number | null;
  compactionCount: number | null;
  firstTurnAt: number | null;
  lastTurnAt: number | null;
  cacheExpiry: CacheExpiryLedger | null;
}

function readIncremental(
  file: string,
  offset: number,
  scanOffset: number,
  pending: Buffer,
  size: number,
  reducer: UsageLineReducer,
  buckets: ProjectUsageBucket[],
  lifetimeBuckets: ProjectUsageBucket[],
  cacheExpiry: CacheExpiryLedger | null | undefined,
  budget: SpendIndexBudget,
): IncrementalRead {
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const maxBytes = budget.maxBytes ?? DEFAULT_SCAN_BYTES;
    const clock = budget.now ?? Date.now;
    const deadline = clock() + (budget.maxMilliseconds ?? DEFAULT_SCAN_MILLISECONDS);
    const byKey = new Map(
      buckets.map((bucket) => [projectUsageKey(bucket, bucket.localDate), { ...bucket, usage: { ...bucket.usage } }]),
    );
    const lifetimeByKey = new Map(
      lifetimeBuckets.map((bucket) => [
        projectUsageKey(bucket, bucket.localDate),
        { ...bucket, usage: { ...bucket.usage } },
      ]),
    );
    const addTo = (target: Map<string, ProjectUsageBucket>, event: UsageEvent) => {
      const date = localDate(event.timestamp);
      const contextBand =
        event.contextBand ?? contextBandForRequest(event.model, event.provider, requestInputTokens(event.usage));
      const keyed = { ...event, contextBand };
      const key = projectUsageKey(keyed, date);
      let bucket = target.get(key);
      if (!bucket && (event.usage.requests ?? 1) < 0) {
        return;
      }
      if (!bucket) {
        bucket = {
          localDate: date,
          agent: event.agent,
          provider: event.provider,
          model: event.model,
          contextWindow: event.contextWindow,
          contextBand,
          billingClass: event.billingClass,
          inferenceClass: event.inferenceClass,
          serviceTier: event.serviceTier,
          reportedCostBasis: event.reportedCostBasis ?? null,
          linkedSessionId: event.linkedSessionId ?? null,
          linkedInvocationId: event.linkedInvocationId ?? null,
          incomplete: event.incomplete === true,
          ...(event.requestCountExact === false ? { requestCountExact: false as const } : {}),
          ...(event.compactionEstimate ? { compactionEstimate: true as const } : {}),
          reportedCost: event.reportedCost === null ? null : 0,
          usage: emptyUsage(),
          requests: 0,
        };
        target.set(key, bucket);
      }
      addUsage(bucket.usage, event.usage);
      bucket.unclassifiedCacheWrite = (bucket.unclassifiedCacheWrite ?? 0) + (event.unclassifiedCacheWrite ?? 0);
      if (!bucket.unclassifiedCacheWrite) {
        delete bucket.unclassifiedCacheWrite;
      }
      bucket.requests += event.usage.requests ?? 1;
      if (event.reportedCost !== null) {
        bucket.reportedCost = (bucket.reportedCost ?? 0) + event.reportedCost;
      }
      if (bucketIsEmpty(bucket)) {
        target.delete(key);
      }
    };
    // The ordered pass runs before either bucket takes the event, because a bucket has
    // already merged the adjacency this reads.
    const ordered = reducer.recentCompactions ? new CacheExpiryScan(cacheExpiry ?? undefined) : null;
    // A compaction estimate counts toward the session's lifetime total, which says it holds an
    // estimate. The project windows report recorded usage only.
    const add = (event: UsageEvent) => {
      ordered?.push(event);
      if (!event.compactionEstimate) {
        addTo(byKey, event);
      }
      addTo(lifetimeByKey, event);
    };
    let position = scanOffset;
    let held = pending;
    let completedOffset = offset;
    let readBytes = 0;
    while (position < size && readBytes < maxBytes && clock() < deadline) {
      const allowed = Math.min(chunk.length, size - position, maxBytes - readBytes);
      const read = fs.readSync(fd, chunk, 0, allowed, position);
      if (read <= 0) {
        break;
      }
      position += read;
      readBytes += read;
      const bytes = held.length ? Buffer.concat([held, chunk.subarray(0, read)]) : Buffer.from(chunk.subarray(0, read));
      let lineStart = 0;
      for (let cursor = 0; cursor < bytes.length; cursor++) {
        if (bytes[cursor] !== 0x0a) {
          continue;
        }
        let line = bytes.subarray(lineStart, cursor);
        if (line.length && line[line.length - 1] === 0x0d) {
          line = line.subarray(0, line.length - 1);
        }
        if (completedOffset > 0) {
          let firstContent = 0;
          while (line[firstContent] === 0) {
            firstContent++;
          }
          line = line.subarray(firstContent);
        }
        for (const event of reducer.pushLine(line.toString('utf8'))) {
          add(event);
        }
        lineStart = cursor + 1;
        completedOffset = position - (bytes.length - lineStart);
      }
      held = Buffer.from(bytes.subarray(lineStart));
    }
    const complete = position >= size;
    if (complete && completedOffset > 0 && held.length > 0 && held.every((byte) => byte === 0)) {
      completedOffset = position;
      held = Buffer.alloc(0);
    }
    return {
      offset: completedOffset,
      trailing: held,
      scanOffset: position,
      complete,
      buckets: [...byKey.values()].sort((left, right) =>
        projectUsageKey(left, left.localDate).localeCompare(projectUsageKey(right, right.localDate)),
      ),
      lifetimeBuckets: [...lifetimeByKey.values()].sort((left, right) =>
        projectUsageKey(left, left.localDate).localeCompare(projectUsageKey(right, right.localDate)),
      ),
      turnCount: reducer.turnCount?.() ?? null,
      compactionCount: reducer.compactionCount?.() ?? null,
      firstTurnAt: reducer.firstTurnAt?.() ?? null,
      lastTurnAt: reducer.lastTurnAt?.() ?? null,
      cacheExpiry: ordered ? ordered.ledger(reducer.recentCompactions!()) : null,
    };
  } finally {
    fs.closeSync(fd);
  }
}

// Index one file revision. A reducer snapshot always describes exactly the complete lines
// before offset, so an unfinished line can safely be read again after it is completed.
export function indexSpendFile<State>(
  previous: SpendFileIndex | undefined,
  file: string,
  workspace: string,
  makeReducer: UsageReducerFactory<State>,
  nowOrBudget: number | SpendIndexBudget = Date.now(),
  budget: SpendIndexBudget = {},
): IndexSpendFileResult {
  const now = typeof nowOrBudget === 'number' ? nowOrBudget : Date.now();
  const scanBudget = typeof nowOrBudget === 'number' ? budget : nowOrBudget;
  const normalizedFile = canonicalPath(file);
  const normalizedWorkspace = normalizeWorkspace(workspace);
  const emptyReducer = makeReducer(undefined);
  const parserKind = emptyReducer.parserKind;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
    if (!stat.isFile()) {
      throw new Error('not a file');
    }
  } catch {
    invalidateSpendFileNormalization(file);
    const record =
      previous && previous.file === normalizedFile
        ? { ...previous, missingAt: previous.missingAt ?? now }
        : {
            file: normalizedFile,
            workspace: normalizedWorkspace,
            size: 0,
            mtimeMs: 0,
            offset: 0,
            trailing: '',
            buckets: [],
            indexedAt: now,
            missingAt: now,
            ...(parserKind === undefined ? {} : { parserKind }),
          };
    const stateChanged = !previous || previous.missingAt === undefined;
    return {
      record,
      totalsChanged: false,
      stateChanged,
      changed: stateChanged,
      rebuilt: false,
      found: false,
      complete: true,
    };
  }
  const reusable =
    previous &&
    previous.file === normalizedFile &&
    previous.workspace === normalizedWorkspace &&
    (parserKind === undefined || previous.parserKind === parserKind);
  const lifetimeReady = reusable && spendRecordHasLifetimeFacts(previous);
  const unchanged =
    lifetimeReady &&
    previous.complete !== false &&
    previous.missingAt === undefined &&
    previous.size === stat.size &&
    previous.mtimeMs === stat.mtimeMs;
  if (unchanged) {
    return {
      record: previous,
      totalsChanged: false,
      stateChanged: false,
      changed: false,
      rebuilt: false,
      found: true,
      complete: true,
    };
  }
  const resuming =
    reusable &&
    previous.complete === false &&
    previous.missingAt === undefined &&
    stat.size >= previous.size &&
    (stat.size > previous.size || stat.mtimeMs === previous.mtimeMs);
  const rebuilt =
    !reusable ||
    !lifetimeReady ||
    previous.missingAt !== undefined ||
    stat.size < previous.size ||
    (!resuming && stat.size === previous.size);
  const base = rebuilt ? undefined : previous;
  const reducer = base ? makeReducer(base.parserState as State | undefined) : emptyReducer;
  const resume = base?.complete === false;
  const scanned = readIncremental(
    file,
    base?.offset ?? 0,
    resume ? (base?.scanOffset ?? base?.offset ?? 0) : (base?.offset ?? 0),
    resume && base?.pendingBytes ? Buffer.from(base.pendingBytes, 'base64') : Buffer.alloc(0),
    stat.size,
    reducer,
    base?.buckets ?? [],
    base?.lifetimeBuckets ?? [],
    base?.cacheExpiry,
    scanBudget,
  );
  const buckets = scanned.buckets;
  const record: SpendFileIndex = {
    file: normalizedFile,
    workspace: normalizedWorkspace,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    offset: scanned.offset,
    trailing: scanned.trailing.toString('utf8'),
    trailingBytes: scanned.trailing.toString('base64'),
    buckets,
    lifetimeBuckets: scanned.lifetimeBuckets,
    turnCount: scanned.turnCount,
    compactionCount: scanned.compactionCount,
    firstTurnAt: scanned.firstTurnAt,
    lastTurnAt: scanned.lastTurnAt,
    newestTurnStartedAt: reducer.newestTurnStartedAt?.() ?? null,
    outcome: reducer.newestTurnOutcome?.() ?? null,
    cacheExpiry: scanned.cacheExpiry,
    parserGeneration: PROJECT_SPEND_PARSER_GENERATION,
    ...(parserKind === undefined ? {} : { parserKind }),
    indexedAt: now,
    parserState: reducer.snapshot(),
    complete: scanned.complete,
    ...(scanned.complete ? {} : { scanOffset: scanned.scanOffset, pendingBytes: scanned.trailing.toString('base64') }),
  };
  const totalsChanged =
    !reusable ||
    !sameBuckets(previous.buckets, buckets) ||
    !sameBuckets(previous.lifetimeBuckets ?? [], scanned.lifetimeBuckets) ||
    previous.turnCount !== scanned.turnCount ||
    previous.compactionCount !== scanned.compactionCount ||
    previous.firstTurnAt !== scanned.firstTurnAt ||
    previous.lastTurnAt !== scanned.lastTurnAt ||
    previous.newestTurnStartedAt !== record.newestTurnStartedAt ||
    JSON.stringify(previous.outcome ?? null) !== JSON.stringify(record.outcome) ||
    JSON.stringify(previous.cacheExpiry ?? null) !== JSON.stringify(record.cacheExpiry);
  const stateChanged =
    totalsChanged ||
    previous.size !== record.size ||
    previous.mtimeMs !== record.mtimeMs ||
    previous.offset !== record.offset ||
    previous.trailingBytes !== record.trailingBytes ||
    previous.complete !== record.complete ||
    previous.scanOffset !== record.scanOffset ||
    previous.pendingBytes !== record.pendingBytes ||
    previous.parserGeneration !== record.parserGeneration ||
    previous.parserKind !== record.parserKind;
  return {
    record,
    totalsChanged,
    stateChanged,
    changed: stateChanged,
    rebuilt,
    found: true,
    complete: scanned.complete,
  };
}

export interface PruneSpendFilesResult {
  files: SpendFileIndex[];
  pruned: boolean;
}

export function pruneSpendFilesWithResult(files: readonly SpendFileIndex[], now = Date.now()): PruneSpendFilesResult {
  const cutoff = projectSpendWindows(now)[2].start;
  let pruned = false;
  const retained = files
    .map((record) => {
      const buckets = record.buckets.filter((bucket) => bucket.localDate >= cutoff);
      if (buckets.length === record.buckets.length) {
        return record;
      }
      pruned = true;
      return { ...record, buckets };
    })
    .filter((record) => {
      const keep = !record.missingAt || record.buckets.length > 0;
      if (!keep) {
        pruned = true;
      }
      return keep;
    });
  return { files: retained, pruned };
}

export function pruneSpendFiles(files: readonly SpendFileIndex[], now = Date.now()): SpendFileIndex[] {
  return pruneSpendFilesWithResult(files, now).files;
}

function ledgerFile(storageDirectory: string, workspace: string): string {
  const partition = crypto.createHash('sha256').update(normalizeWorkspace(workspace)).digest('hex');
  return path.join(storageDirectory, `${partition}.json`);
}

// The workspace path that names a project spend ledger. A single-folder window uses its folder.
// A multi-root window uses a path under the first folder's root, named by the prefix and a digest
// of every folder.
export function projectSpendWorkspace(folders: readonly string[], multiRootPrefix: string): string {
  if (folders.length <= 1) {
    return folders[0] ?? '';
  }
  const normalized = folders.map((folder) => normalizeFsPath(path.resolve(folder))).sort();
  return path.join(
    path.parse(folders[0]).root,
    `${multiRootPrefix}${crypto.createHash('sha256').update(normalized.join('\n')).digest('hex')}`,
  );
}

function usableSpendRecord(record: unknown): record is SpendFileIndex {
  const candidate = record as SpendFileIndex | null;
  return !!candidate && typeof candidate.file === 'string' && Array.isArray(candidate.buckets);
}

// A completed scan's offset follows its last newline. NULs after that newline
// contain no JSONL record, including in ledgers saved by an older reader.
function consumeSpendPadding(record: SpendFileIndex): SpendFileIndex {
  if (record.complete === false || record.offset === 0 || record.size <= record.offset) {
    return record;
  }
  const trailing =
    record.trailingBytes === undefined
      ? Buffer.from(record.trailing, 'utf8')
      : Buffer.from(record.trailingBytes, 'base64');
  if (
    trailing.length !== record.size - record.offset ||
    !trailing.every((byte) => byte === 0) ||
    record.trailing.length !== trailing.length ||
    /[^\0]/u.test(record.trailing)
  ) {
    return record;
  }
  return { ...record, offset: record.size, trailing: '', trailingBytes: '' };
}

export function loadSpendLedger(storageDirectory: string, workspace: string): SpendLedger {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(ledgerFile(storageDirectory, workspace), 'utf8'));
    const ledger = parseSpendLedger(
      parsed,
      normalizeWorkspace(workspace),
      PROJECT_SPEND_PARSER_GENERATION,
      normalizeWorkspace,
    );
    if (!ledger) {
      throw new Error('invalid ledger');
    }
    return {
      ...ledger,
      files: ledger.files.map(consumeSpendPadding),
      completeFiles: ledger.completeFiles.map(consumeSpendPadding),
    };
  } catch {
    return {
      workspace: normalizeWorkspace(workspace),
      parserGeneration: PROJECT_SPEND_PARSER_GENERATION,
      files: [],
      completeFiles: [],
    };
  }
}

export function saveSpendLedger(
  storageDirectory: string,
  workspace: string,
  files: readonly SpendFileIndex[],
  completeFiles: readonly SpendFileIndex[] = files.filter((record) => record.complete !== false),
): void {
  const checkpoint = (record: SpendFileIndex): SpendFileIndex => {
    const state = withRetainedRequestEvents(record.parserState);
    const normalizedFile = normalizeSpendFile(record.file);
    const bounded =
      state === record.parserState && normalizedFile === record.file
        ? record
        : { ...record, file: normalizedFile, parserState: state };
    if (bounded.complete !== false) {
      return bounded;
    }
    const { pendingBytes: _pendingBytes, trailingBytes: _trailingBytes, ...rest } = bounded;
    return { ...rest, scanOffset: bounded.offset, trailing: '' };
  };
  // Each written array must hold one entry for each record and nothing else. `Array.from`
  // visits a gap in the caller's array, which `map` would skip and leave as a gap in the
  // text as well. An unusable entry is dropped, as the load drops one.
  const present = Array.from(files).filter(usableSpendRecord);
  const shown = Array.from(completeFiles).filter(usableSpendRecord);
  const saved = present.map(checkpoint);
  const texts = saved.map((record) => JSON.stringify(record));
  const sameRecord = new Map<SpendFileIndex, number>();
  const samePath = new Map<string, number>();
  present.forEach((record, at) => {
    if (!sameRecord.has(record)) {
      sameRecord.set(record, at);
    }
    const normalizedFile = normalizeSpendFile(record.file);
    if (!samePath.has(normalizedFile)) {
      samePath.set(normalizedFile, at);
    }
  });
  // The display ledger repeats a record of `files` for every file that is not part-way
  // through a rescan, which is nearly all of them. An index stands for the repeat, and a
  // record is written out in full only where the two arrays differ.
  const display = shown.map((record) => {
    const shared = sameRecord.get(record);
    if (shared !== undefined) {
      return String(shared);
    }
    const found = samePath.get(normalizeSpendFile(record.file));
    const text = JSON.stringify(checkpoint(record));
    return found !== undefined && texts[found] === text ? String(found) : text;
  });
  writeFileAtomically(
    ledgerFile(storageDirectory, workspace),
    `{"workspace":${JSON.stringify(normalizeWorkspace(workspace))}` +
      `,"parserGeneration":${PROJECT_SPEND_PARSER_GENERATION}` +
      `,"files":[${texts.join(',')}]` +
      `,"displayFiles":[${display.join(',')}]}`,
  );
}

export function formatProjectCost(dollars: number | null): string {
  if (dollars === null) {
    return 'Cost unknown';
  }
  if (dollars < 0.01 && dollars > 0) {
    return '<$0.01';
  }
  if (dollars < 10) {
    return `$${dollars.toFixed(2)}`;
  }
  return `$${Math.round(dollars).toLocaleString('en-US')}`;
}

interface Accumulator {
  dollars: number;
  priced: number;
  unpriced: number;
  seen: number;
  partial: boolean;
  sources: Map<string, { effectiveDate: string | null; provenance: ProjectSpendProvenance }>;
}
function accumulator(): Accumulator {
  return { dollars: 0, priced: 0, unpriced: 0, seen: 0, partial: false, sources: new Map() };
}

function priceBucket(bucket: ProjectUsageBucket, pricer: ProjectSpendPricer): ProjectSpendPrice | null {
  if (bucket.incomplete) {
    return null;
  }
  if (bucket.reportedCost !== null) {
    const recordedSource = recordedCostSource(bucket.reportedCostBasis);
    if (recordedSource) {
      return {
        dollars: bucket.reportedCost,
        source: recordedSource,
        effectiveDate: null,
        estimated: true,
        provenance: 'public',
      };
    }
    return {
      dollars: bucket.reportedCost,
      source: 'Provider-reported cost',
      effectiveDate: null,
      estimated: false,
      provenance: 'reported',
    };
  }
  return pricer(bucket);
}

function directClaudeSources(files: readonly SpendFileIndex[]): {
  usableSessions: Set<string>;
  ignoredFiles: Set<string>;
} {
  const linked = new Set(
    files.flatMap((file) => file.buckets.flatMap((bucket) => (bucket.linkedSessionId ? [bucket.linkedSessionId] : []))),
  );
  const usableSessions = new Set<string>();
  const ignoredFiles = new Set<string>();
  for (const file of files) {
    const name = path.basename(file.file).replace(/\.jsonl$/i, '');
    if (!linked.has(name)) {
      continue;
    }
    const complete = file.complete !== false && !file.trailing && !file.trailingBytes;
    const usable =
      complete && file.buckets.some((bucket) => !bucket.linkedSessionId && !bucket.incomplete && bucket.requests > 0);
    if (usable) {
      usableSessions.add(name);
    } else {
      ignoredFiles.add(file.file);
    }
  }
  return { usableSessions, ignoredFiles };
}

function addBucket(total: Accumulator, bucket: ProjectUsageBucket, price: ProjectSpendPrice | null): void {
  total.seen += bucket.requests;
  if (!price) {
    total.unpriced += bucket.requests;
    total.partial = true;
    return;
  }
  total.dollars += price.dollars;
  total.priced += bucket.requests;
  total.sources.set(`${price.source}\u0000${price.effectiveDate ?? ''}\u0000${price.provenance}`, {
    effectiveDate: price.effectiveDate,
    provenance: price.provenance,
  });
}

function displayWindow(
  total: Accumulator,
  incomplete: boolean,
  window: Pick<ProjectSpendWindow, 'id' | 'label'>,
  truncated = false,
): ProjectSpendWindow {
  const unpriced = total.partial || incomplete;
  // A window that starts before the history limit counts every indexed request it holds, so
  // its known amount is a lower bound rather than an unknown.
  const partial = unpriced || truncated;
  const hasKnownActivity = total.seen > 0 || total.unpriced > 0 || incomplete;
  const dollars = total.priced && (!unpriced || total.dollars > 0) ? total.dollars : hasKnownActivity ? null : 0;
  const status = dollars === null ? ('unknown' as const) : partial ? ('atLeast' as const) : ('exact' as const);
  return {
    ...window,
    dollars,
    display:
      status === 'unknown'
        ? 'Cost unknown'
        : status === 'atLeast'
          ? `At least ${formatProjectCost(dollars)}`
          : formatProjectCost(dollars),
    status,
    partial,
    pricedRequests: total.priced,
    unpricedRequests: total.unpriced,
  };
}

function spendAgent(agent: string): 'claude' | 'codex' | null {
  const normalized = agent.toLowerCase();
  return normalized === 'claude' || normalized === 'codex' ? normalized : null;
}

export function prepareProjectSpendView(
  files: readonly SpendFileIndex[],
  pricer: ProjectSpendPricer,
  options: { now?: number; name?: string; indexing?: boolean; historyCutoff?: number | null } = {},
): ProjectSpendView {
  const now = options.now ?? Date.now();
  const windows = projectSpendWindows(now);
  const cutoff = options.historyCutoff ?? null;
  const truncated = new Map(
    windows.map((window) => [window.id, cutoff !== null && new Date(`${window.start}T00:00:00`).getTime() < cutoff]),
  );
  const totals = new Map(windows.map((window) => [window.id, accumulator()]));
  const agentTotals = new Map(
    ['claude', 'codex'].map((agent) => [agent, new Map(windows.map((window) => [window.id, accumulator()]))]),
  );
  const evidencedAgents = new Set<'claude' | 'codex'>();
  const rateSources = new Map<string, { effectiveDate: string | null; provenance: ProjectSpendProvenance }>();
  const contributingDates: string[] = [];
  const directClaude = directClaudeSources(files);
  const incomplete = new Map(windows.map((window) => [window.id, { total: false, claude: false, codex: false }]));
  let lastIndexedAt: number | null = null;
  for (const file of files) {
    lastIndexedAt = lastIndexedAt === null ? file.indexedAt : Math.max(lastIndexedAt, file.indexedAt);
    if (file.complete !== false && (file.trailingBytes || file.trailing)) {
      const modified = localDate(file.mtimeMs);
      for (const window of windows) {
        if (modified < window.start) {
          continue;
        }
        const affected = incomplete.get(window.id)!;
        affected.total = true;
        affected.claude = true;
        if (file.parserKind !== 'claude') {
          affected.codex = true;
        }
      }
    }
    for (const bucket of file.lifetimeBuckets ?? file.buckets) {
      const agent = spendAgent(bucket.agent);
      if (agent) {
        evidencedAgents.add(agent);
      }
    }
    if (directClaude.ignoredFiles.has(file.file)) {
      continue;
    }
    for (const bucket of file.buckets) {
      if (bucket.linkedSessionId && directClaude.usableSessions.has(bucket.linkedSessionId)) {
        continue;
      }
      const agent = spendAgent(bucket.agent);
      if (bucket.localDate > windows[0].start) {
        continue;
      }
      if (bucket.localDate >= windows[2].start) {
        contributingDates.push(bucket.localDate);
      }
      const price = priceBucket(bucket, pricer);
      for (const window of windows) {
        if (bucket.localDate < window.start) {
          continue;
        }
        addBucket(totals.get(window.id)!, bucket, price);
        if (agent) {
          addBucket(agentTotals.get(agent)!.get(window.id)!, bucket, price);
        }
      }
      if (price && bucket.localDate >= windows[2].start) {
        rateSources.set(`${price.source}\u0000${price.effectiveDate ?? ''}\u0000${price.provenance}`, {
          effectiveDate: price.effectiveDate,
          provenance: price.provenance,
        });
      }
    }
  }
  const viewWindows = windows.map((window) =>
    displayWindow(totals.get(window.id)!, incomplete.get(window.id)!.total, window, truncated.get(window.id)),
  );
  const earliestRecord = contributingDates.sort()[0] ?? null;
  return {
    name: options.name ?? 'Project cost',
    windows: viewWindows,
    categories: (['claude', 'codex'] as const)
      .filter((agent) => evidencedAgents.has(agent))
      .map((agent) => ({
        id: agent,
        label: `${agent === 'claude' ? 'Claude' : 'Codex'} spend`,
        windows: windows.map((window) =>
          displayWindow(
            agentTotals.get(agent)!.get(window.id)!,
            incomplete.get(window.id)![agent],
            window,
            truncated.get(window.id),
          ),
        ),
      })),
    earliestRecord,
    lastIndexedAt,
    rateSources: [...rateSources.entries()].map(([key, metadata]) => ({
      source: key.split('\u0000')[0],
      effectiveDate: metadata.effectiveDate,
      provenance: metadata.provenance,
    })),
    indexing: Boolean(options.indexing),
  };
}

export interface SpendSessionFile {
  file: string;
  sessionId: string;
  parentSessionId?: string;
}
export interface SpendSubagentFile {
  file: string;
}
export interface SpendChildFile extends SpendSubagentFile {
  threadId: string;
  parentThreadId: string | null;
}
export interface SessionSpendSource {
  sessionId: string;
  file: string;
  primary?: boolean;
  // The dispatched session whose own source this is, on a source added to the session that
  // dispatched it.
  dispatchedFrom?: string;
}

export interface SessionSpendPart {
  bucket: ProjectUsageBucket;
  role: 'main' | 'delegated';
  scopeId?: string;
}

function uniqueFiles(files: readonly string[]): string[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = canonicalPath(file);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

// The positions of the items below each ancestor, in item order. An item hangs from its parent
// id. The last item with an id decides the parent of that id. A chain ends at an empty parent,
// at an id no item holds, or at the first id it reaches twice.
//
// The answer walks the tree downward from the ancestor, so its cost follows the size of the
// answer and not the number of items times the depth of every chain.
function descendantPositions<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  parentOf: (item: T) => string | null | undefined,
): (ancestor: string) => readonly number[] {
  const hanging = new Map<string, number[]>();
  items.forEach((item, position) => {
    const parent = parentOf(item);
    if (!parent) {
      return;
    }
    const siblings = hanging.get(parent);
    if (siblings) {
      siblings.push(position);
    } else {
      hanging.set(parent, [position]);
    }
  });
  const below = new Map<string, string[]>();
  for (const [id, item] of new Map(items.map((item) => [idOf(item), item]))) {
    const parent = parentOf(item);
    if (!parent) {
      continue;
    }
    const siblings = below.get(parent);
    if (siblings) {
      siblings.push(id);
    } else {
      below.set(parent, [id]);
    }
  }
  const answers = new Map<string, readonly number[]>();
  return (ancestor) => {
    const held = answers.get(ancestor);
    if (held) {
      return held;
    }
    const reached = new Set([ancestor]);
    const queue = [ancestor];
    const positions: number[] = [];
    for (let index = 0; index < queue.length; index++) {
      positions.push(...(hanging.get(queue[index]) ?? []));
      for (const id of below.get(queue[index]) ?? []) {
        if (!reached.has(id)) {
          reached.add(id);
          queue.push(id);
        }
      }
    }
    positions.sort((a, b) => a - b);
    answers.set(ancestor, positions);
    return positions;
  };
}

export interface SubagentDirectoryReader {
  files(directory: string): readonly string[];
}

// Null when the directory cannot be read. Child sources can disappear between discovery passes,
// and read access can be denied for a while.
function readSubagentFiles(directory: string): string[] | null {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => path.join(directory, entry.name));
  } catch {
    return null;
  }
}

const uncachedSubagentDirectories: SubagentDirectoryReader = {
  files: (directory) => readSubagentFiles(directory) ?? [],
};

function subagentDirectoryOf(parent: SpendSessionFile): string {
  return path.join(path.dirname(parent.file), parent.sessionId, 'subagents');
}

// A directory listing changes the directory modification time, so an unchanged time means an
// unchanged list of subagent transcripts. A time younger than the settle window is read again
// on the next pass, because a file system with a coarse clock can add a file inside the same
// tick as the listing.
export const SUBAGENT_DIRECTORY_SETTLE_MS = 2_000;

export class SubagentDirectoryCache implements SubagentDirectoryReader {
  private readonly entries = new Map<string, { mtimeMs: number; files: readonly string[] }>();
  private readonly listed = new Set<string>();

  constructor(
    private readonly read: (directory: string) => readonly string[] | null = readSubagentFiles,
    private readonly now: () => number = Date.now,
  ) {}

  // Forgets every directory that no call to `files` named since the last sweep, so a directory
  // that left the scope is not held for the life of the cache.
  sweep(): void {
    for (const directory of [...this.entries.keys()]) {
      if (!this.listed.has(directory)) {
        this.entries.delete(directory);
      }
    }
    this.listed.clear();
  }

  files(directory: string): readonly string[] {
    this.listed.add(directory);
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(directory, { throwIfNoEntry: false });
    } catch {
      stat = undefined;
    }
    if (!stat?.isDirectory()) {
      this.entries.delete(directory);
      return [];
    }
    const held = this.entries.get(directory);
    if (held && held.mtimeMs === stat.mtimeMs) {
      return held.files;
    }
    const files = this.read(directory);
    // A failed read is not held. Read access can return without moving the directory time.
    if (files && this.now() - stat.mtimeMs >= SUBAGENT_DIRECTORY_SETTLE_MS) {
      this.entries.set(directory, { mtimeMs: stat.mtimeMs, files });
    } else {
      this.entries.delete(directory);
    }
    return files ?? [];
  }
}

export function discoverClaudeSessionSpendSources(
  parents: readonly SpendSessionFile[],
  directories: SubagentDirectoryReader = uncachedSubagentDirectories,
): SessionSpendSource[] {
  const sources: SessionSpendSource[] = [];
  const seen = new Set<string>();
  const add = (source: SessionSpendSource) => {
    const key = `${source.sessionId}\0${canonicalPath(source.file)}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    sources.push(source);
  };
  const descendants = descendantPositions(
    parents,
    (parent) => parent.sessionId,
    (parent) => parent.parentSessionId,
  );
  for (const parent of parents) {
    add({ sessionId: parent.sessionId, file: parent.file, primary: true });
    for (const file of directories.files(subagentDirectoryOf(parent))) {
      add({ sessionId: parent.sessionId, file, primary: false });
    }
    for (const position of descendants(parent.sessionId)) {
      add({ sessionId: parent.sessionId, file: parents[position].file, primary: false });
    }
  }
  return sources;
}

// A Claude subagent transcript is the one Claude spend source that must be read as a child.
// The directory holding it says so. A record re-offered from the saved ledger carries no role
// of its own. A child read as a parent counts none of its records, because every one is a
// sidechain. The file is then saved complete and empty, and never read again.
//
// Windows lowercases a saved path and the other platforms keep its case, so this compares the
// name in one case. The ledger also resolves a path through its links, so a linked subagents
// directory reads as a parent. A Codex record reaches this too, and its reducer takes no role.
// The reader that produced a saved record. A Claude transcript never counts a Codex request,
// and a Codex rollout that ran an embedded Claude invocation counts both, so one Codex bucket
// anywhere in the record names the file. The lifetime list is read rather than the windowed
// one, because a windowed list can lose its Codex days and change the answer for a record
// nothing has touched.
export function spendRecordAgent(record: SpendFileIndex): 'claude' | 'codex' {
  if (record.parserKind) {
    return record.parserKind;
  }
  const buckets = record.lifetimeBuckets ?? record.buckets;
  return buckets.some((bucket) => bucket.agent.toLowerCase() === 'codex') ? 'codex' : 'claude';
}

export function spendFileIsClaudeChild(file: string): boolean {
  return path.basename(path.dirname(file)).toLowerCase() === 'subagents';
}

export function discoverClaudeSpendSources(parents: readonly SpendSessionFile[]): string[] {
  return uniqueFiles(discoverClaudeSessionSpendSources(parents).map((source) => source.file));
}

export function discoverCodexSpendSources(
  visible: readonly SpendSubagentFile[],
  children: readonly SpendSubagentFile[],
): string[] {
  return uniqueFiles([...visible.map((source) => source.file), ...children.map((source) => source.file)]);
}

export function discoverCodexSessionSpendSources(
  sessions: readonly SpendSessionFile[],
  children: readonly SpendChildFile[],
): SessionSpendSource[] {
  const descendants = descendantPositions(
    children,
    (child) => child.threadId,
    (child) => child.parentThreadId,
  );
  const out: SessionSpendSource[] = [];
  for (const session of sessions) {
    out.push({ sessionId: session.sessionId, file: session.file, primary: true });
    for (const position of descendants(session.sessionId)) {
      out.push({ sessionId: session.sessionId, file: children[position].file, primary: false });
    }
  }
  return out;
}

// The sources again, with every source of a dispatched session added to the session that
// dispatched it as delegated work, and to each session above that one in turn. `parents`
// maps a dispatched session id to its dispatcher's. `delegators` maps a native subagent id to
// the session that started it, so a session a subagent dispatched reaches the subagent's own
// parent too. A subagent's own transcript already counts there, so that edge adds nothing
// else. The child keeps its own sources, so its heading still counts them, and a file a
// session already holds is not added twice. Project spend reads its own source list, so this
// changes no project total. Only the sessions on a dispatched session's chain have their
// paths resolved, because resolving a path can read the filesystem.
export function withDispatchedSpendSources(
  sources: readonly SessionSpendSource[],
  parents: ReadonlyMap<string, string>,
  delegators: ReadonlyMap<string, string> = new Map(),
): SessionSpendSource[] {
  if (!parents.size) {
    return [...sources];
  }
  const above = (session: string) => parents.get(session) ?? delegators.get(session);
  const linked = new Set<string>();
  for (const child of parents.keys()) {
    for (let at: string | undefined = child; at !== undefined && !linked.has(at); at = above(at)) {
      linked.add(at);
    }
  }
  const own = new Map<string, SessionSpendSource[]>();
  const seen = new Set<string>();
  for (const source of sources) {
    if (!linked.has(source.sessionId)) {
      continue;
    }
    const held = own.get(source.sessionId);
    if (held) {
      held.push(source);
    } else {
      own.set(source.sessionId, [source]);
    }
    seen.add(`${source.sessionId}\0${canonicalPath(source.file)}`);
  }
  const out = [...sources];
  for (const child of parents.keys()) {
    const reached = new Set([child]);
    for (let parent = above(child); parent !== undefined && !reached.has(parent); parent = above(parent)) {
      reached.add(parent);
      for (const source of own.get(child) ?? []) {
        const key = `${parent}\0${canonicalPath(source.file)}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        out.push({ sessionId: parent, file: source.file, primary: false, dispatchedFrom: child });
      }
    }
  }
  return out;
}

export interface SessionSpendDiscovery {
  claude: typeof discoverClaudeSessionSpendSources;
  codex: typeof discoverCodexSessionSpendSources;
}

// The spend sources of every listed session, built again only when a listed file, a Claude
// source, a parent link, or the subagent listing of a Claude child changed. The comparison
// ignores input order, because a walk lists sessions by file time and a later pass lists them
// by recorded activity. `revision` moves only when the sources themselves changed, so a walk
// that finds the same files does not offer every source again.
export class SessionSpendSourceIndex {
  private key: string | null = null;
  private print = '';
  private held: readonly SessionSpendSource[] = [];
  private changes = 0;

  constructor(
    private readonly discover: SessionSpendDiscovery = {
      claude: discoverClaudeSessionSpendSources,
      codex: discoverCodexSessionSpendSources,
    },
  ) {}

  get revision(): number {
    return this.changes;
  }
  get sources(): readonly SessionSpendSource[] {
    return this.held;
  }

  update(
    claude: readonly SessionSpendSource[],
    claudeChildren: readonly SpendSessionFile[],
    codex: readonly SpendSessionFile[],
    codexChildren: readonly SpendChildFile[],
    directories: SubagentDirectoryReader = uncachedSubagentDirectories,
    // Each dispatched session and the session that dispatched it, as child id to parent id.
    dispatchParents: ReadonlyMap<string, string> = new Map(),
  ): readonly SessionSpendSource[] {
    const listings = new Map<string, readonly string[]>();
    const listingOf = (directory: string) => {
      const held = listings.get(directory) ?? directories.files(directory);
      listings.set(directory, held);
      return held;
    };
    const lines = [
      ...claude.map((source) => `c\0${source.sessionId}\0${source.file}\0${source.primary === false ? 'd' : 'm'}`),
      ...claudeChildren.map(
        (child) =>
          `k\0${child.sessionId}\0${child.parentSessionId ?? ''}\0${child.file}\0${listingOf(subagentDirectoryOf(child)).join('\0')}`,
      ),
      ...codex.map((session) => `s\0${session.sessionId}\0${session.file}`),
      ...codexChildren.map((child) => `x\0${child.threadId}\0${child.parentThreadId ?? ''}\0${child.file}`),
      ...[...dispatchParents].map(([child, parent]) => `d\0${child}\0${parent}`),
    ];
    const key = lines.sort().join('\n');
    if (key === this.key) {
      return this.held;
    }
    this.key = key;
    this.held = withDispatchedSpendSources(
      [
        ...claude,
        ...this.discover.claude(claudeChildren, { files: listingOf }),
        ...this.discover.codex(codex, codexChildren),
      ],
      dispatchParents,
      new Map([
        ...claudeChildren.flatMap((child) =>
          child.parentSessionId ? [[child.sessionId, child.parentSessionId] as const] : [],
        ),
        ...codexChildren.flatMap((child) =>
          child.parentThreadId ? [[child.threadId, child.parentThreadId] as const] : [],
        ),
      ]),
    );
    const print = this.held
      .map(
        (source) =>
          `${source.sessionId}\0${source.file}\0${source.primary === false ? 'delegated' : 'main'}\0${source.dispatchedFrom ?? ''}`,
      )
      .join('\n');
    if (print !== this.print) {
      this.print = print;
      this.changes++;
    }
    return this.held;
  }
}

// Persisted record paths are canonical by contract. Most live sources therefore match
// lexically and need no filesystem read. Only an alias or a new source needs realpath.
function spendSourceKey<T>(file: string, records: ReadonlyMap<string, T>): string {
  const lexical = normalizeWorkspace(file);
  return records.has(lexical) ? lexical : normalizeSpendFile(file);
}

// A session's figure waits until every one of its own sources is whole, subagents included.
// A dispatched session has a figure of its own and can run long after the session that
// dispatched it stopped. Its sources therefore join the parent's figure once they are all
// whole, and they never hold back the parent's own figure. Until then `awaiting` receives the
// parent's id, because its figure is a lower bound. A dispatched source the ledger has not read
// whole, whose last line is unfinished, or whose session is still inside a turn, waits only
// while `pending` says the ledger still holds it. Otherwise the history limit skipped it or its
// file is gone. It then adds the usage its record holds, if any, and marks nothing.
export function sessionSpendPartsBySession(
  files: readonly SpendFileIndex[],
  sources: readonly SessionSpendSource[],
  awaiting?: Set<string>,
  pending: SpendSourcePending = () => true,
): Record<string, SessionSpendPart[]> {
  const records = new Map(files.map((record) => [normalizeWorkspace(record.file), record]));
  // Session id, then the dispatched session a group of files came from ('' for the session's
  // own), then each file and whether it is primary.
  const bySession = new Map<string, Map<string, Map<string, boolean>>>();
  for (const source of sources) {
    const groups = bySession.get(source.sessionId) ?? new Map<string, Map<string, boolean>>();
    const group = source.dispatchedFrom ?? '';
    const held = groups.get(group) ?? new Map<string, boolean>();
    const file = spendSourceKey(source.file, records);
    held.set(file, (held.get(file) ?? false) || source.primary !== false);
    groups.set(group, held);
    bySession.set(source.sessionId, groups);
  }
  const whole = ({ record }: { record: SpendFileIndex | undefined }) => spendRecordWhole(record);
  // A dispatched file that holds its group back: one the ledger still holds that it has not read
  // whole, whose last line is unfinished, or whose session is still inside a turn.
  const waits = ({ file, record }: { file: string; record: SpendFileIndex | undefined }) =>
    spendRecordAwaitsLedger(record) && pending(file, record);
  const out: Record<string, SessionSpendPart[]> = {};
  for (const [sessionId, groups] of bySession) {
    const found: { record: SpendFileIndex | undefined; primary: boolean }[] = [];
    let ready = true;
    let short = false;
    for (const [group, held] of groups) {
      const files = [...held].map(([file, primary]) => ({ file, record: records.get(file), primary }));
      if (!group) {
        if (files.every(whole)) {
          found.push(...files);
        } else {
          ready = false;
        }
      } else if (files.some(waits)) {
        short = true;
      } else {
        found.push(...files.filter((file) => file.record));
      }
    }
    if (!ready) {
      continue;
    }
    if (short) {
      awaiting?.add(sessionId);
    }
    out[sessionId] = found.flatMap(({ record, primary }) =>
      (record?.lifetimeBuckets ?? []).map((bucket) => {
        const role = primary && !bucket.linkedSessionId && !bucket.linkedInvocationId ? 'main' : 'delegated';
        return {
          bucket,
          role,
          ...(role === 'delegated'
            ? {
                scopeId: bucket.linkedInvocationId
                  ? `invocation:${bucket.linkedInvocationId}`
                  : bucket.linkedSessionId
                    ? `session:${bucket.linkedSessionId}`
                    : `source:${normalizeWorkspace(record!.file)}`,
              }
            : {}),
        };
      }),
    );
  }
  return out;
}

export function sessionSpendBySession(
  files: readonly SpendFileIndex[],
  sources: readonly SessionSpendSource[],
): Record<string, ProjectUsageBucket[]> {
  return Object.fromEntries(
    Object.entries(sessionSpendPartsBySession(files, sources)).map(([sessionId, parts]) => [
      sessionId,
      parts.map((part) => part.bucket),
    ]),
  );
}

// The lifetime turn figures a session heading and its rail card share: how many turns
// the primary transcript drew, how many compactions it held, and the span from the first
// turn's start to the last turn's end. Read only from a complete, fully-scanned primary
// source, so a rescan never overwrites a whole answer with a partial one.
export interface SessionTurnStats {
  turnCount: number;
  compactionCount: number | null;
  firstTurnAt: number | null;
  lastTurnAt: number | null;
}

export function sessionTurnStatsBySession(
  files: readonly SpendFileIndex[],
  sources: readonly SessionSpendSource[],
): Record<string, SessionTurnStats> {
  const records = new Map(files.map((record) => [normalizeWorkspace(record.file), record]));
  const primaryBySession = new Map<string, Set<string>>();
  for (const source of sources) {
    if (source.primary !== true) {
      continue;
    }
    const held = primaryBySession.get(source.sessionId) ?? new Set<string>();
    held.add(spendSourceKey(source.file, records));
    primaryBySession.set(source.sessionId, held);
  }
  const out: Record<string, SessionTurnStats> = {};
  for (const [sessionId, primaryFiles] of primaryBySession) {
    if (primaryFiles.size !== 1) {
      continue;
    }
    const record = records.get([...primaryFiles][0]);
    if (
      !record ||
      record.complete === false ||
      Boolean(record.trailingBytes || record.trailing) ||
      !Number.isSafeInteger(record.turnCount) ||
      (record.turnCount ?? -1) < 0
    ) {
      continue;
    }
    out[sessionId] = {
      turnCount: record.turnCount as number,
      compactionCount:
        Number.isSafeInteger(record.compactionCount) && (record.compactionCount as number) >= 0
          ? (record.compactionCount as number)
          : null,
      firstTurnAt: typeof record.firstTurnAt === 'number' ? record.firstTurnAt : null,
      lastTurnAt: typeof record.lastTurnAt === 'number' ? record.lastTurnAt : null,
    };
  }
  return out;
}

// The cache-expiry and compaction evidence for one session, read under exactly the rule
// `sessionTurnStatsBySession` uses: one complete, fully scanned primary source and nothing
// else. A session whose source cannot answer is absent rather than reported as zero.
export interface SessionCacheFacts {
  expiry: CacheExpiryFacts;
  compactions: CompactionFact[];
}

export function sessionCacheFactsBySession(
  files: readonly SpendFileIndex[],
  sources: readonly SessionSpendSource[],
): Record<string, SessionCacheFacts> {
  const records = new Map(files.map((record) => [normalizeWorkspace(record.file), record]));
  const primaryBySession = new Map<string, Set<string>>();
  for (const source of sources) {
    if (source.primary !== true) {
      continue;
    }
    const held = primaryBySession.get(source.sessionId) ?? new Set<string>();
    held.add(spendSourceKey(source.file, records));
    primaryBySession.set(source.sessionId, held);
  }
  const out: Record<string, SessionCacheFacts> = {};
  for (const [sessionId, primaryFiles] of primaryBySession) {
    if (primaryFiles.size !== 1) {
      continue;
    }
    const record = records.get([...primaryFiles][0]);
    if (
      !record ||
      record.complete === false ||
      Boolean(record.trailingBytes || record.trailing) ||
      !record.cacheExpiry
    ) {
      continue;
    }
    out[sessionId] = {
      expiry: record.cacheExpiry.facts,
      compactions: record.cacheExpiry.compactions,
    };
  }
  return out;
}

export interface SessionRailFacts {
  newestTurnStartedAt: number | null;
  outcome: TurnOutcome | null;
}

export function sessionRailFactsBySession(
  files: Record<string, SpendFileIndex>,
  sources: readonly SessionSpendSource[],
): Record<string, SessionRailFacts> {
  const records = new Map(Object.values(files).map((record) => [normalizeWorkspace(record.file), record]));
  const primaryBySession = new Map<string, Set<string>>();
  for (const source of sources) {
    if (source.primary !== true) {
      continue;
    }
    const held = primaryBySession.get(source.sessionId) ?? new Set<string>();
    held.add(spendSourceKey(source.file, records));
    primaryBySession.set(source.sessionId, held);
  }
  const out: Record<string, SessionRailFacts> = {};
  for (const [sessionId, primaryFiles] of primaryBySession) {
    if (primaryFiles.size !== 1) {
      continue;
    }
    const record = records.get([...primaryFiles][0]);
    if (
      !record ||
      record.complete === false ||
      Boolean(record.trailingBytes || record.trailing) ||
      !readyTimestamp(record.newestTurnStartedAt) ||
      !readyOutcome(record.outcome)
    ) {
      continue;
    }
    out[sessionId] = {
      newestTurnStartedAt: record.newestTurnStartedAt ?? null,
      outcome: record.outcome ? { ...record.outcome } : null,
    };
  }
  return out;
}

export function projectSpendDisplayFiles(
  indexing: boolean,
  resumable: readonly SpendFileIndex[],
  complete: readonly SpendFileIndex[],
): readonly SpendFileIndex[] {
  return indexing ? complete : resumable;
}

export function sessionLifetimeDisplayFiles(
  indexing: boolean,
  resumable: readonly SpendFileIndex[],
  complete: readonly SpendFileIndex[],
): readonly SpendFileIndex[] {
  if (!indexing) {
    return resumable;
  }
  const fallback = new Map(complete.map((record) => [record.file, record]));
  return resumable.map((record) => (record.complete === false ? (fallback.get(record.file) ?? record) : record));
}
