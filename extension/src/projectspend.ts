import { meterRead } from './readmeter';
import { combineCacheExpirySummaries, combineCacheExpiryAmounts } from './cacheexpirysummary';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ClaudeRepeatedDetector,
  claudeRepeatedLookups,
  emptyClaudeRepeatedState,
  forgetClaudeRepeatedLookups,
  claudeFileRevision,
  publishClaudeRepeatedLedger,
  publishClaudeRepeatedMap,
  type ClaudeRepeatedState,
} from './clauderepeated';
import {
  matchingCostSupplement,
  costStateDependency,
  costStateIdentity,
  type ClaudeCostProgress,
  type ClaudeCostSupplement,
} from './claudecoststate';
import { writeFileStreamAtomically } from './atomicfile';
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
import type {
  CacheLifetime,
  CompactionSignal,
  ReducerCompaction,
  TurnOutcome,
  TurnUsage,
  UsageInferenceClass,
  UsageOrigin,
} from './transcript';
import { normalizeFsPath } from './transcript';
import { ExportLimitError } from './exportlimits';
import { addUsage as addPricedUsage } from './agentspend';

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

// Usage events carry request facts from transcript reducers into the spend index.
export interface UsageEvent {
  timestamp: number;
  agent: string;
  provider: string | null;
  model: string | null;
  contextWindow: number | null;
  // Retained context from the final executor pass, separate from summed billing usage.
  contextTokens?: number;
  firstPassUsage?: UsageCounts;
  firstPassContextBand?: 'short' | 'long' | null;
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
  // Request-order facts do not select daily or lifetime buckets.
  // The visible user turn identifies the prompt under which this request ran.
  // Null prevents main-source adjacency comparisons. Native children use their request clocks.
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
  compactionUsage?: true;
  // The compaction that an estimated request stands for, in request order. The ordered pass
  // measures the next return from it.
  compactionSignal?: CompactionSignal;
  // A Claude advisor consultation. It counts in cost and requests and stays out of cache adjacency.
  usageOrigin?: 'claude-advisor';
  usage: TurnUsage;
  requestKey: string | null;
  responseId?: string;
}

export interface ProjectUsageBucket {
  usageOrigin?: UsageOrigin;
  localDate: string;
  agent: string;
  provider: string | null;
  model: string | null;
  contextWindow: number | null;
  contextBand: 'short' | 'long' | null;
  billingClass: 'metered' | 'subscription' | 'unknown';
  inferenceClass: 'in-region' | 'geo' | 'global' | 'bedrock-regional' | null;
  serviceTier: string | null;
  // Sum of provider-reported costs for this bucket. Null means no reported amount.
  reportedCost: number | null;
  reportedCostBasis?: string | null;
  linkedSessionId?: string | null;
  linkedInvocationId?: string | null;
  unclassifiedCacheWrite?: number;
  incomplete?: boolean;
  requestCountExact?: false;
  // These buckets estimate compaction requests without recorded request usage.
  compactionEstimate?: true;
  compactionUsage?: true;
  usage: TurnUsage;
  requests: number;
}

export interface SpendFileIndex {
  costStateSupplement?: ClaudeCostSupplement;
  costStateProgress?: ClaudeCostProgress;
  file: string;
  workspace: string;
  size: number;
  mtimeMs: number;
  // Byte position at the start of the unprocessed line, if there is one.
  offset: number;
  // Readable trailing text supplies the fallback when trailingBytes is absent.
  // trailingBytes stores the exact bytes behind this decoded text.
  // An incomplete record has empty trailing text and keeps its unfinished line in pendingBytes alone.
  trailing: string;
  trailingBytes?: string;
  buckets: ProjectUsageBucket[];
  // Lifetime buckets retain scanned usage for session figures.
  // Session figures read these buckets without reparsing the selected timeline.
  // Missing or invalid lifetime facts require a source rebuild.
  lifetimeBuckets?: ProjectUsageBucket[];
  // Visible turn count for the bytes scanned, including an unfinished scan.
  // Null means the reducer supplies no turn count.
  // An absent field requires a source rebuild.
  turnCount?: number | null;
  // Compaction count, first turn start, and latest turn timestamp for the bytes scanned.
  // The latest timestamp uses the turn start until Claude answers or Codex completes it.
  // Null means the reducer supplies no value. An absent field requires a source rebuild.
  compactionCount?: number | null;
  firstTurnAt?: number | null;
  lastTurnAt?: number | null;
  newestTurnStartedAt?: number | null;
  outcome?: TurnOutcome | null;
  // Cache-expiry and compaction facts derived in request order.
  // Null means the reducer supplies no compaction-history method.
  // An absent field requires a source rebuild.
  cacheExpiry?: CacheExpiryLedger | null;
  cacheExpiryChildPolicy?: boolean;
  // Parser generation that produced this source's buckets and state.
  // A mismatch requires a rebuild even when size and modification time match.
  parserGeneration?: number;
  parserKind?: 'claude' | 'codex';
  indexedAt: number;
  parserState?: unknown;
  // The Claude repeated-record detector and the byte ranges of repeated records it found. Readers skip those ranges.
  claudeRepeated?: ClaudeRepeatedState;
  // False means the scan stopped before the target size.
  // size and mtimeMs identify the target revision. scanOffset resumes within it.
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
  // Last complete records supply display figures while partial rescans advance in files.
  // Filtering files by complete loses the previous complete record during a rescan.
  completeFiles: SpendFileIndex[];
}

// Cache session figures by their source lists, record identities, and pending ownership.
// Source changes recalculate only sessions that reference them, including dispatched sources.
// Records retain their identity until the ledger replaces them.
// calculate must depend only on its arguments and pending.
// assemble runs only when a session's figures change.
// Pending answers are watched only for dispatched sources that await the ledger.
// Matching records, sources, and normalization generation reuse the cached value without resolving paths.
// Invalidating a cached path advances the generation and forces source resolution.
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

  // The pending answers used by the last read.
  // Each read replaces the map, so callers can retain the answers for one drawing.
  answers(): SpendPendingAnswers {
    return this.watched;
  }

  // Whether a dispatched source's pending answer changed since the supplied read.
  // This change invalidates figures even when no file changed.
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

function spendRecordUsagePending(record: SpendFileIndex | undefined): boolean {
  const state = record?.parserState as
    | { pendingOwnership?: Record<string, true>; pendingRequests?: Record<string, UsageEvent[]> }
    | undefined;
  return (
    record?.parserKind === 'codex' &&
    (Object.keys(state?.pendingOwnership ?? {}).length > 0 ||
      Object.values(state?.pendingRequests ?? {}).some((events) => events.length > 0))
  );
}

// A whole source has no unfinished line or unresolved usage.
function spendRecordWhole(record: SpendFileIndex | undefined): record is SpendFileIndex {
  return (
    !!record &&
    record.complete !== false &&
    !record.trailingBytes &&
    !record.trailing &&
    !spendRecordUsagePending(record) &&
    Array.isArray(record.lifetimeBuckets)
  );
}

// A present file scanned to its end with an unfinished final line.
function spendRecordWriting(record: SpendFileIndex | undefined): record is SpendFileIndex {
  return (
    !!record &&
    record.missingAt === undefined &&
    record.complete !== false &&
    Array.isArray(record.lifetimeBuckets) &&
    !!(record.trailing || record.trailingBytes)
  );
}

// A present, fully scanned file whose newest turn remains open.
// A final reply, interruption, error, or recorded process end closes the turn.
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

// A queued dispatched source remains held.
// An unfinished line or open turn holds a present source while its last write meets the history cutoff.
// Other sources release their hold, including absent files and sources outside the history limit.
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
          source.dispatchedFrom === next[at].dispatchedFrom &&
          source.dispatchedVia === next[at].dispatchedVia &&
          source.dispatchedPrimary === next[at].dispatchedPrimary,
      ))
  );
}

export const PROJECT_SPEND_INTEGRITY_MILLISECONDS = 30_000;
// The ledger save waits for this much quiet after a change, and never longer than the maximum
// after the first unsaved change. The quiet wait equals the maximum, so an ordinary save comes
// `PROJECT_SPEND_SAVE_MAX_MS` after the first unsaved change and at most one save starts in that time.
export const PROJECT_SPEND_SAVE_MAX_MS = 30_000;
export const PROJECT_SPEND_SAVE_MS = PROJECT_SPEND_SAVE_MAX_MS;
// An unfinished scan that holds more than this many bytes of one line continues before other
// sources, and stops when that line ends.
export const PROJECT_SPEND_HELD_LINE_BYTES = 64 * 1024;

export function spendRecordHoldsLongLine(record: SpendFileIndex): boolean {
  return (
    record.complete === false &&
    // The decoded length comes from the base64 length and its padding, without decoding.
    Buffer.byteLength(record.pendingBytes ?? '', 'base64') > PROJECT_SPEND_HELD_LINE_BYTES
  );
}

// An incomplete record without its held bytes reads its unfinished line again from its offset.
export function releaseSpendHeldLine(record: SpendFileIndex): SpendFileIndex {
  if (record.complete !== false) {
    return record;
  }
  const { pendingBytes: _pendingBytes, trailingBytes: _trailingBytes, ...rest } = record;
  return { ...rest, scanOffset: record.offset, trailing: '' };
}
// A failed ledger save tries again after this wait, and each later wait doubles. After
// `PROJECT_SPEND_SAVE_RETRIES` tries the save stays owed until the next ledger change or flush.
export const PROJECT_SPEND_SAVE_RETRY_MS = 2_000;
export const PROJECT_SPEND_SAVE_RETRIES = 5;

// The wait before the next try of a failed ledger save, or null once every try is spent.
export function projectSpendSaveRetryDelay(retries: number): number | null {
  return retries < PROJECT_SPEND_SAVE_RETRIES ? PROJECT_SPEND_SAVE_RETRY_MS * 2 ** retries : null;
}
// Saved source records require a rebuild when their parser generation differs.
// Increase this when a stored field changes the conclusions consumers draw from it.
export const PROJECT_SPEND_PARSER_GENERATION = 61;

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

// Skip files last modified before the cutoff and retain their saved records.
// An undefined revision means no file facts were read. Null means the file is absent.
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
  nativeChildRequests?(): boolean;
  acceptsLine?(line: string): boolean;
  parserKind?: 'claude' | 'codex';
  pushLine(line: string, end?: number): readonly UsageEvent[];
  snapshot(): State;
  turnCount?(): number | null;
  compactionCount?(): number | null;
  recentCompactions?(): readonly ReducerCompaction[];
  // Compactions recorded by the lines pushed since the last call, oldest first. A reducer whose
  // compactions arrive on its usage events instead leaves this out.
  takeCompactionSignals?(): readonly CompactionSignal[];
  firstTurnAt?(): number | null;
  lastTurnAt?(): number | null;
  newestTurnStartedAt?(): number | null;
  newestTurnOutcome?(): TurnOutcome | null;
}

export type UsageReducerFactory<State = unknown> = (state: State | undefined) => UsageLineReducer<State>;

export interface IndexSpendFileResult {
  record: SpendFileIndex;
  // Whether usage buckets or derived lifetime facts changed.
  // Callers that persist parser progress also need stateChanged.
  totalsChanged: boolean;
  stateChanged: boolean;
  changed: boolean;
  rebuilt: boolean;
  found: boolean;
  // Whether every byte in the observed file revision has been scanned. A false result must
  // be queued again with the returned record, even when its totals did not change.
  complete: boolean;
  // True when the bytes behind the saved offset changed or went away during the slice. The
  // returned record drops its repeated-record detector, so the next slice rebuilds the file.
  invalidated?: boolean;
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
  inferenceClass?: Exclude<UsageInferenceClass, null>;
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
    !bucket.usage.byContextBand &&
    bucket.requests > 1 &&
    contextBandForRequest(bucket.model, bucket.provider, summedTokens) !== 'short' &&
    bucket.reportedCost === null &&
    configured === null
  ) {
    return null;
  }
  const quote = quoteUsage({
    usage: bucket.usage,
    model: bucket.model,
    provider: bucket.provider,
    contextWindow: bucket.contextWindow,
    requestTokens: bucket.contextBand == null && !bucket.usage.byContextBand ? summedTokens : null,
    contextBand: bucket.contextBand,
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
// Invalidate figure caches when dropping a resolved path allows it to name another file.
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

// Band slices carry token volume. The final pass's band owns the response's one request.
function usageBandEvents(event: UsageEvent): UsageEvent[] {
  const bands = event.usage.byContextBand;
  if (!bands || event.reportedCost !== null) return [event];
  return (['short', 'long'] as const).flatMap((contextBand) => {
    const usage = bands[contextBand];
    return usage ? [{ ...event, contextBand, usage: { ...usage } }] : [];
  });
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
    existing.map((bucket) => [
      projectUsageKey(bucket, bucket.localDate),
      { ...bucket, usage: bucket.usage.byContextBand ? structuredClone(bucket.usage) : { ...bucket.usage } },
    ]),
  );
  for (const event of events.flatMap(usageBandEvents)) {
    const date = localDate(event.timestamp);
    const contextBand = event.usage.byContextBand
      ? (event.contextBand ?? null)
      : (event.contextBand ?? contextBandForRequest(event.model, event.provider, requestInputTokens(event.usage)));
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
        ...(event.usageOrigin ? { usageOrigin: event.usageOrigin } : {}),
        reportedCost: event.reportedCost === null ? null : 0,
        usage: emptyUsage(),
        requests: 0,
      };
      byKey.set(key, bucket);
    }
    addPricedUsage(bucket.usage, event.usage);
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
// Daily and lifetime buckets combine requests and discard their adjacency.
// Derive these facts while the reducer still emits requests in source order.
// The figures report input cost after a preceding request's cache expired, and the part of it
// that a warm cache would have read instead. Fresh prompt text and unrecorded cache-key changes
// also affect the input cost. Cost added leaves out the new text.

// One qualifying return, kept in the shape the cost resolver already quotes.
export interface CacheExpiryReturn {
  timestamp?: number | null;
  // The lifetime that had run out on the previous request.
  lifetime: CacheTier;
  // The request-to-request gap that crossed it, in milliseconds.
  gapMs: number;
  // The return request itself, as one priceable row. Its cache read is `request.usage.cacheRead`.
  request: ProjectUsageBucket;
  // The visible turn the return request opened, or null where a saved return does not name it.
  visibleTurnId: string | null;
  // The return request's key, which a Claude card matches against its turn's response ids, or
  // null where a saved return does not name it.
  requestKey: string | null;
  // The reusable context from the previous request's final executor pass.
  // A return measured from a compaction holds its cached prefix instead.
  // Null where no record establishes that size, or
  // where a saved return does not name it, which leaves its cost added unavailable.
  previousInputSide: number | null;
  firstPassUsage?: UsageCounts;
  firstPassContextBand?: 'short' | 'long' | null;
}

export interface CacheExpiryFacts {
  childSources?: NativeChildCacheFacts[];
  incompleteSources?: number;
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
  // Expired-cache pairs excluded for changed compaction count, model, provider, service tier, inference region, effort, or tool-list version.
  // Unknown effort or tool-list version does not establish a change.
  excluded: number;
  // Pairs with unknown lifetime, invalid clocks, incomplete requests, or main requests with no visible turn.
  // Delayed requests older than the current carry also count here.
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
  // Final-pass context, or aggregate input when the event supplies no separate measurement.
  inputTokens: number;
  incomplete: boolean;
  // The newest compaction after this request, when one came before the next request. The next
  // comparison measures from it instead of from the request.
  compaction?: CacheExpiryCarryCompaction;
}

export interface CacheExpiryCarryCompaction {
  // The compaction's ordinal, which stands in for the request's compaction count.
  ordinal: number;
  // The compaction's own time, or null where its record names no usable time.
  at: number | null;
  // The cached prefix the compaction left, in tokens, which stands in for the request's input
  // side as the reusable size. Null where no record establishes it.
  prefixTokens: number | null;
}

export interface CacheExpiryLedger {
  facts: CacheExpiryFacts;
  compactions: CompactionFact[];
  carry: CacheExpiryCarry | null;
  // The request key of the newest recorded return and of the newest recorded compaction, so
  // a revision arriving in a later slice reaches the row it replaces.
  newestReturnKey: string | null;
  newestCompactionKey: string | null;
  // Facts for compactions a request reached, which trailing facts pushed out of `compactions`.
  // A restored scan holds them again, because a later slice can revoke the trailing compaction.
  displacedCompactions?: CompactionFact[];
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

// Classify adjacent primary requests using the preceding request's cache lifetime.
export function classifyCacheExpiry(
  previous: CacheExpiryCarry,
  next: CacheExpiryCarry,
  nextUsage: UsageCounts,
  nativeChild = false,
): CacheExpiryVerdict {
  if (!nativeChild && (previous.visibleTurnId === null || next.visibleTurnId === null)) {
    return { kind: 'unavailable' };
  }
  const from = previous.compaction;
  const fromTime = from ? (from.at ?? 0) : previous.timestamp;
  const fromCompactions = from ? from.ordinal : previous.compactionsBefore;
  // Requests under the same visible prompt do not qualify as a return after cache expiry.
  if (!nativeChild && previous.visibleTurnId === next.visibleTurnId) {
    return { kind: 'none' };
  }
  if (!positiveClock(fromTime) || !positiveClock(next.timestamp) || next.timestamp < fromTime) {
    return { kind: 'unavailable' };
  }
  // A compaction recorded after the request but dated before it is a backwards clock.
  if (from && positiveClock(previous.timestamp) && fromTime < previous.timestamp) {
    return { kind: 'unavailable' };
  }
  // The compaction replaced the request's context, so only its own record decides completeness.
  if ((!from && previous.incomplete) || next.incomplete) {
    return { kind: 'unavailable' };
  }
  const lifetime = previous.lifetime;
  if (lifetime === null) {
    return { kind: 'unavailable' };
  }
  if (!cacheLapsedBy(fromTime, lifetime, next.timestamp)) {
    return { kind: 'none' };
  }
  if (
    fromCompactions !== next.compactionsBefore ||
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
  return { kind: 'return', lifetime, gapMs: next.timestamp - fromTime };
}

function requestBucket(event: UsageEvent): ProjectUsageBucket {
  const date = localDate(event.timestamp);
  const contextBand = event.usage.byContextBand
    ? (event.contextBand ?? null)
    : (event.contextBand ?? contextBandForRequest(event.model, event.provider, requestInputTokens(event.usage)));
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
    usage: { ...structuredClone(event.usage), requests: 1 },
    requests: 1,
  };
}

function carryFor(event: UsageEvent): CacheExpiryCarry {
  return {
    requestKey: event.requestKey,
    timestamp: event.timestamp,
    visibleTurnId: event.visibleTurnId ?? null,
    lifetime:
      event.agent.toLowerCase() === 'claude' && event.cacheLifetime !== undefined
        ? event.cacheLifetime
        : requestCacheLifetime(event.cacheLifetime, event.model, event.provider),
    model: event.model,
    provider: event.provider,
    serviceTier: event.serviceTier,
    inferenceClass: event.inferenceClass,
    effort: event.effort ?? null,
    toolListVersion: event.toolListVersion ?? null,
    compactionsBefore: event.compactionsBefore ?? 0,
    inputTokens: event.contextTokens ?? requestInputTokens(event.usage),
    incomplete: event.incomplete === true,
  };
}

// Whether this event is one primary-session request the order pass can compare. Delegated
// work is excluded by its link, and a removal or a replacement by its negative request count.
// Advisor consultations do not establish executor cache-expiry neighbors.
function primaryOrderedRequest(event: UsageEvent): boolean {
  return (
    !event.compactionEstimate &&
    !event.compactionUsage &&
    !event.usageOrigin &&
    !event.linkedSessionId &&
    !event.linkedInvocationId &&
    (event.usage.requests ?? 1) > 0
  );
}

function emptyCompactionFact(ordinal: number, contextBefore: number | null): CompactionFact {
  return {
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
}

// The newest facts for compactions that the carried request reached, oldest first.
function reachedCompactions(facts: readonly CompactionFact[], carry: CacheExpiryCarry | null): CompactionFact[] {
  const reached = carry?.compactionsBefore ?? 0;
  return facts
    .filter((item) => item.ordinal <= reached)
    .sort((left, right) => left.ordinal - right.ordinal)
    .slice(-RETAINED_COMPACTIONS);
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

  constructor(
    previous?: CacheExpiryLedger,
    private readonly nativeChild: () => boolean = () => false,
  ) {
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
    this.carry = restored.carry
      ? {
          ...restored.carry,
          ...(restored.carry.compaction ? { compaction: { ...restored.carry.compaction } } : {}),
        }
      : null;
    // The scan holds only facts for compactions a request reached. A saved ledger also lists
    // trailing compactions, which `ledger()` rebuilds from the carry, because a later slice can
    // revoke the compaction behind one.
    this.compactions = reachedCompactions(
      [...(restored.displacedCompactions ?? []), ...restored.compactions],
      this.carry,
    ).map((item) => ({ ...item }));
    this.newestReturnKey = restored.newestReturnKey;
    this.newestCompactionKey = restored.newestCompactionKey;
  }

  push(event: UsageEvent): void {
    if (event.compactionSignal) {
      this.signal(event.compactionSignal);
    }
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
    // A delayed request can arrive after newer requests when its model becomes known.
    // Keep the newest request as the carry so later gaps use the correct predecessor.
    if (
      this.carry &&
      positiveClock(this.carry.timestamp) &&
      positiveClock(next.timestamp) &&
      next.timestamp < this.carry.timestamp
    ) {
      this.facts.unavailable++;
      return;
    }
    this.revokeCompactions(next.compactionsBefore);
    this.recordCompactions(next, event);
    if (this.carry) {
      this.judge(this.carry, next, event);
    }
    this.carry = next;
  }

  // A compaction after the newest request moves the point the next comparison measures from.
  // The carry keeps the request, and the compaction supplies the time, the compaction count, and
  // the reusable size the comparison uses. A compaction with no usable time leaves the next pair
  // unavailable. The compaction re-reads the old context itself, so a cold pass is the
  // compaction's cost, and the request after it is measured from the compaction alone.
  // A reducer signals each compaction once, so a signal is a new compaction even where its ordinal
  // does not pass the carry's compaction. A revoked compaction gives its ordinal back, and the
  // compaction after it reuses that ordinal and replaces it. Only a compaction the carried request
  // already counts is behind the carry.
  signal(signal: CompactionSignal): void {
    const carry = this.carry;
    if (!carry || signal.ordinal <= carry.compactionsBefore) {
      return;
    }
    carry.compaction = { ordinal: signal.ordinal, at: signal.at, prefixTokens: signal.prefixTokens };
  }

  // The reducer's compaction count after a line. A record that revokes a compaction lowers the
  // count before any request shows it, so the carry drops the compaction at once. A compaction
  // the reducer cannot estimate, counted after the revocation, then leaves the next pair
  // excluded instead of measured from the revoked compaction.
  compactionCount(count: number): void {
    this.revokeCompactions(count);
  }

  // A compaction count below the carry's compaction means a later record revoked it. Revoking
  // every compaction since the newest request measures from that request again. A partial
  // revocation leaves the compaction to measure from unknown, so the pair is unavailable.
  private revokeCompactions(count: number): void {
    const carry = this.carry;
    if (!carry?.compaction || count >= carry.compaction.ordinal) {
      return;
    }
    if (count <= carry.compactionsBefore) {
      delete carry.compaction;
      return;
    }
    carry.compaction = { ordinal: count, at: null, prefixTokens: null };
  }

  private revise(event: UsageEvent): void {
    const revised = carryFor(event);
    // A child rewrites a response under its first key after a later compaction, and the rewrite
    // carries the newer compaction count. The request still ran before that compaction, so the
    // revision keeps the count it had, and the next request opens the compaction fact.
    if (this.carry && revised.compactionsBefore > this.carry.compactionsBefore) {
      revised.compactionsBefore = this.carry.compactionsBefore;
    }
    // A revision of the request keeps measuring from a compaction that followed it.
    if (this.carry?.compaction && this.carry.compaction.ordinal > revised.compactionsBefore) {
      revised.compaction = { ...this.carry.compaction };
    }
    this.carry = revised;
    const newestReturn = this.facts.returns[this.facts.returns.length - 1];
    if (newestReturn && this.newestReturnKey === event.requestKey) {
      newestReturn.timestamp = positiveClock(event.timestamp) ? event.timestamp : null;
      newestReturn.request = requestBucket(event);
      newestReturn.firstPassUsage = event.firstPassUsage;
      newestReturn.firstPassContextBand = event.firstPassContextBand;
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
    if (added < 0) {
      // A revoked compaction leaves no fact, as a restored scan holds none for it.
      this.compactions.splice(0, this.compactions.length, ...reachedCompactions(this.compactions, next));
    }
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
    const fact = emptyCompactionFact(ordinal, contextBefore);
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
    const verdict = classifyCacheExpiry(previous, next, event.firstPassUsage ?? event.usage, this.nativeChild());
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
      timestamp: positiveClock(event.timestamp) ? event.timestamp : null,
      lifetime: verdict.lifetime,
      gapMs: verdict.gapMs,
      request: requestBucket(event),
      visibleTurnId: next.visibleTurnId!,
      requestKey: event.requestKey,
      previousInputSide: previous.compaction ? previous.compaction.prefixTokens : previous.inputTokens,
      ...(event.firstPassUsage
        ? { firstPassUsage: { ...event.firstPassUsage }, firstPassContextBand: event.firstPassContextBand }
        : {}),
    });
    this.newestReturnKey = event.requestKey;
    while (this.facts.returns.length > RETAINED_CACHE_EXPIRY_RETURNS) {
      this.facts.returns.shift();
      this.facts.truncated = true;
    }
  }

  // Match recent compaction records to their derived facts by ordinal.
  // Missing clocks remain null and cannot shift another compaction's timestamp.
  // List facts for trailing compactions that no later request reached, without holding them.
  // These facts retain their time and preceding context, with zero later requests.
  // Reached facts that the trailing facts push out of the list are saved apart.
  ledger(recorded: readonly ReducerCompaction[]): CacheExpiryLedger {
    const reached = this.carry?.compactionsBefore ?? 0;
    const held = reachedCompactions(this.compactions, this.carry);
    const trailing = recorded
      .filter((item) => item.ordinal > reached)
      .map((item) =>
        emptyCompactionFact(
          item.ordinal,
          item.ordinal === reached + 1 && !this.carry?.incomplete ? (this.carry?.inputTokens ?? null) : null,
        ),
      );
    const listed = [...held, ...trailing]
      .sort((left, right) => left.ordinal - right.ordinal)
      .slice(-RETAINED_COMPACTIONS);
    const displaced = held.slice(0, Math.max(0, held.length + trailing.length - RETAINED_COMPACTIONS));
    const byOrdinal = new Map(recorded.map((item) => [item.ordinal, item]));
    return {
      ...(displaced.length > 0 ? { displacedCompactions: displaced.map((item) => ({ ...item })) } : {}),
      facts: this.facts,
      compactions: listed.map((item) => {
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

export interface CacheExpiryCost {
  dollars: number | null;
  status: 'exact' | 'atLeast' | 'unknown';
}

export interface PricedCacheExpiryReturn {
  item: CacheExpiryReturn;
  cost: CacheExpiryCost;
}
const childExpiryPrices = new WeakMap<
  SpendFileIndex,
  Map<ProjectSpendPricer, { facts: CacheExpiryFacts; returns: PricedCacheExpiryReturn[] }>
>();

// Pricing depends on accepted record identity, its facts, and the pricing function's context.
export function pricedNativeCacheReturns(
  source: NativeChildCacheFacts,
  pricer: ProjectSpendPricer,
): readonly PricedCacheExpiryReturn[] {
  let prices = childExpiryPrices.get(source.revision);
  if (!prices) childExpiryPrices.set(source.revision, (prices = new Map()));
  let held = prices.get(pricer);
  if (!held || held.facts !== source.facts) {
    held = {
      facts: source.facts,
      returns: source.facts.returns.map((item) => ({
        item,
        cost: cacheExpiryExtraCost({ ...emptyCacheExpiryFacts(), returns: [item] }, pricer),
      })),
    };
    prices.set(pricer, held);
  }
  return held.returns;
}

// The tokens a return paid to resend context a warm cache could have held, at the rates they
// paid, and the same tokens as a cache read. The reusable size is the previous input side less
// what the return still read. The resent part comes from the 1-hour, 30-minute, and 5-minute
// writes in that order, then uncached input. Tokens above the reusable size are new text.
export function cacheExpiryRebuiltUsage(
  previousInputSide: number,
  usage: UsageCounts,
): { paid: UsageCounts; asRead: UsageCounts } {
  let remaining = Math.max(0, previousInputSide - usage.cacheRead);
  const take = (tokens: number) => {
    const taken = Math.min(tokens, remaining);
    remaining -= taken;
    return taken;
  };
  const cacheWrite1h = take(usage.cacheWrite1h);
  const cacheWrite30m = take(usage.cacheWrite30m ?? 0);
  const cacheWrite5m = take(usage.cacheWrite5m);
  const input = take(usage.input);
  const none = { requests: 1, input: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWrite30m: 0, cacheRead: 0, output: 0 };
  return {
    paid: { ...none, input, cacheWrite1h, cacheWrite5m, cacheWrite30m, thinking: 0 },
    asRead: { ...none, cacheRead: cacheWrite1h + cacheWrite30m + cacheWrite5m + input, thinking: 0 },
  };
}

// Price what recorded cache-expiry returns paid beyond a cache read of the same tokens.
// Truncated facts, incomplete requests, reported whole-request costs, missing prices, and a return
// with no known reusable size make the result a lower bound. A return measured from a compaction
// with no recorded prefix has no reusable size. The result is unknown when no return is priced,
// unless the complete return list is empty.
export function cacheExpiryExtraCost(facts: CacheExpiryFacts, pricer: ProjectSpendPricer): CacheExpiryCost {
  if (facts.childSources?.length || facts.incompleteSources) {
    const parts = [
      cacheExpiryExtraCost({ ...facts, childSources: undefined, incompleteSources: undefined }, pricer),
      ...(facts.childSources ?? []).map((source): CacheExpiryCost => {
        const returns = pricedNativeCacheReturns(source, pricer);
        const known = returns.filter((item) => item.cost.dollars !== null);
        const partial = source.facts.truncated || returns.some((item) => item.cost.status !== 'exact');
        return {
          dollars: known.length
            ? known.reduce((sum, item) => sum + item.cost.dollars!, 0)
            : returns.length || partial
              ? null
              : 0,
          status: partial ? (known.length ? 'atLeast' : 'unknown') : 'exact',
        };
      }),
    ];
    const scopes = [facts, ...(facts.childSources ?? []).map((source) => source.facts)];
    const eligible = parts.filter((part, at) => scopes[at].returns.length > 0 || part.status !== 'exact');
    if (facts.incompleteSources) eligible.push({ dollars: null, status: 'unknown' });
    const combined = combineCacheExpiryAmounts(
      eligible.map((part) => ({ dollars: part.dollars, partial: part.status !== 'exact' })),
    );
    return {
      dollars: combined.dollars,
      status: combined.partial ? (combined.dollars === null ? 'unknown' : 'atLeast') : 'exact',
    };
  }
  let dollars = 0;
  let priced = 0;
  let partial = facts.truncated;
  for (const item of facts.returns) {
    if (item.request.incomplete || item.request.reportedCost !== null || item.previousInputSide === null) {
      partial = true;
      continue;
    }
    const { paid, asRead } = cacheExpiryRebuiltUsage(item.previousInputSide, item.firstPassUsage ?? item.request.usage);
    const request = {
      ...item.request,
      contextBand: item.firstPassUsage ? (item.firstPassContextBand ?? null) : item.request.contextBand,
    };
    const paidPrice = pricer({ ...request, usage: paid });
    const readPrice = pricer({ ...request, usage: asRead });
    if (!paidPrice || !readPrice) {
      partial = true;
      continue;
    }
    dollars += Math.max(0, paidPrice.dollars - readPrice.dollars);
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
  exportRecordBytes?: number;
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
  // The repeated-record detector after this slice, for a Claude source.
  claudeRepeated: ClaudeRepeatedState | null;
  // True when a repeated-record lookup could not read the bytes before the restored offset.
  repeatedRevisionLost: boolean;
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
  // The saved repeated-record detector for a Claude source, or null for a source without one.
  restoredRepeated: ClaudeRepeatedState | null = null,
): IncrementalRead {
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, budget.maxBytes ?? 64 * 1024));
    const maxBytes = budget.maxBytes ?? DEFAULT_SCAN_BYTES;
    const clock = budget.now ?? Date.now;
    const deadline = clock() + (budget.maxMilliseconds ?? DEFAULT_SCAN_MILLISECONDS);
    // A lookup reads through this descriptor, so it reads the revision this slice reads. Lookups of
    // earlier slices carry over while the file keeps its identity.
    const opened = restoredRepeated === null ? null : fs.fstatSync(fd);
    const repeated =
      restoredRepeated === null || opened === null
        ? null
        : new ClaudeRepeatedDetector(
            restoredRepeated,
            (buffer, at, length) => meterRead(file, fs.readSync(fd, buffer, 0, length, at), at),
            claudeRepeatedLookups(file, claudeFileRevision(opened), restoredRepeated.through),
            () => clock() >= deadline,
          );
    let repeatedRevisionLost = false;
    // A lookup that runs out of budget stops the slice before its line. The end of a long held line
    // stops the slice after that line.
    let stoppedBetweenLines = false;
    let classified = false;
    const byKey = new Map(
      buckets.map((bucket) => [
        projectUsageKey(bucket, bucket.localDate),
        { ...bucket, usage: bucket.usage.byContextBand ? structuredClone(bucket.usage) : { ...bucket.usage } },
      ]),
    );
    const lifetimeByKey = new Map(
      lifetimeBuckets.map((bucket) => [
        projectUsageKey(bucket, bucket.localDate),
        { ...bucket, usage: bucket.usage.byContextBand ? structuredClone(bucket.usage) : { ...bucket.usage } },
      ]),
    );
    const addSliceTo = (target: Map<string, ProjectUsageBucket>, event: UsageEvent) => {
      const date = localDate(event.timestamp);
      const contextBand = event.usage.byContextBand
        ? (event.contextBand ?? null)
        : (event.contextBand ?? contextBandForRequest(event.model, event.provider, requestInputTokens(event.usage)));
      const keyed = { ...event, contextBand };
      const key = projectUsageKey(keyed, date);
      let bucket = target.get(key);
      if (!bucket && Object.values(event.usage).some((value) => typeof value === 'number' && value < 0)) {
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
          ...(event.compactionUsage ? { compactionUsage: true as const } : {}),
          ...(event.usageOrigin ? { usageOrigin: event.usageOrigin } : {}),
          reportedCost: event.reportedCost === null ? null : 0,
          usage: emptyUsage(),
          requests: 0,
        };
        target.set(key, bucket);
      }
      addPricedUsage(bucket.usage, event.usage);
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
    const addTo = (target: Map<string, ProjectUsageBucket>, event: UsageEvent) => {
      for (const slice of usageBandEvents(event)) addSliceTo(target, slice);
    };
    // Track request order before bucket aggregation removes adjacency.
    const ordered = reducer.recentCompactions
      ? new CacheExpiryScan(cacheExpiry ?? undefined, () => reducer.nativeChildRequests?.() === true)
      : null;
    // Lifetime buckets include estimated compactions. Dated buckets contain recorded requests.
    const add = (event: UsageEvent) => {
      ordered?.push(event);
      if (!event.compactionEstimate) {
        addTo(byKey, event);
      }
      addTo(lifetimeByKey, event);
    };
    // A compaction that emits no usage event reaches the ordered pass after its line's events,
    // and so does a revocation, which lowers the reducer's compaction count.
    const signal = () => {
      for (const item of reducer.takeCompactionSignals?.() ?? []) {
        ordered?.signal(item);
      }
      const count = reducer.compactionCount?.();
      if (typeof count === 'number') {
        ordered?.compactionCount(count);
      }
    };
    let position = scanOffset;
    // The bytes of an unfinished line, kept as separate pieces so that each byte is copied once
    // when the line ends or the slice stops. None of these bytes is a newline.
    let heldParts: Buffer[] = pending.length ? [pending] : [];
    let heldLength = pending.length;
    // A slice that resumes a long held line stops where that line ends, so the record holds no long
    // tail and its file leaves the front of the index queue.
    const stopAfterHeldLine = pending.length > PROJECT_SPEND_HELD_LINE_BYTES;
    let completedOffset = offset;
    let readBytes = 0;
    // A slice reads its first chunk even past the deadline, so every slice makes progress.
    while (position < size && readBytes < maxBytes && (readBytes === 0 || clock() < deadline)) {
      const allowed = Math.min(chunk.length, size - position, maxBytes - readBytes);
      const read = meterRead(file, fs.readSync(fd, chunk, 0, allowed, position), position);
      if (read <= 0) {
        break;
      }
      position += read;
      readBytes += read;
      if (budget.exportRecordBytes !== undefined) {
        let recordBytes = heldLength;
        for (let at = 0; at < read; at++) {
          if (chunk[at] === 10) recordBytes = 0;
          else if (++recordBytes > budget.exportRecordBytes) {
            throw new ExportLimitError('record', budget.exportRecordBytes);
          }
        }
      }
      // A lost revision leaves the held bytes as they were before this chunk.
      const partsBefore = heldParts;
      const lengthBefore = heldLength;
      let lineStart = 0;
      for (let cursor = 0; cursor < read; cursor++) {
        if (chunk[cursor] !== 0x0a) {
          continue;
        }
        // The line's text is decoded before the next read reuses the chunk.
        let line = heldLength
          ? Buffer.concat([...heldParts, chunk.subarray(0, cursor)], heldLength + cursor)
          : chunk.subarray(lineStart, cursor);
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
        const text = line.toString('utf8');
        const end = position - (read - cursor - 1);
        // The first line of a slice always gets a lookup budget, even past the deadline, so every
        // slice makes progress. A later line stops the slice when its lookup finds either budget spent.
        const allowance = classified ? maxBytes - readBytes : Math.max(1, maxBytes - readBytes);
        const repeat = repeated ? repeated.repeatedAt(text, completedOffset, end, allowance, !classified) : false;
        if (repeat === null) {
          repeatedRevisionLost = true;
          break;
        }
        // Lookups share the slice's byte and time budgets.
        readBytes += repeated?.takeConfirmingBytes() ?? 0;
        if (repeat === 'pending') {
          stoppedBetweenLines = true;
          break;
        }
        classified = true;
        if (!repeat) {
          for (const event of reducer.pushLine(text, end)) {
            add(event);
          }
          signal();
        }
        heldParts = [];
        heldLength = 0;
        lineStart = cursor + 1;
        completedOffset = position - (read - lineStart);
        if (stopAfterHeldLine) {
          stoppedBetweenLines = true;
          break;
        }
      }
      if (repeatedRevisionLost) {
        heldParts = partsBefore;
        heldLength = lengthBefore;
        break;
      }
      if (stoppedBetweenLines) {
        // The next slice reads again from the first unclassified line.
        position = completedOffset;
        heldParts = [];
        heldLength = 0;
        break;
      }
      if (lineStart < read) {
        heldParts.push(Buffer.from(chunk.subarray(lineStart, read)));
        heldLength += read - lineStart;
      }
    }
    let held = heldParts.length === 1 ? heldParts[0] : Buffer.concat(heldParts, heldLength);
    const complete = !repeatedRevisionLost && position >= size;
    if (complete && budget.exportRecordBytes !== undefined && held.length) {
      const text = held.toString('utf8');
      const repeat = repeated ? repeated.repeatedAt(text, completedOffset, position, maxBytes, true) : false;
      if (repeat === null || repeat === 'pending') throw new Error('The session changed during export.');
      if (!repeat) {
        for (const event of reducer.pushLine(text, position)) add(event);
        signal();
      }
      completedOffset = position;
      held = Buffer.alloc(0);
    }
    if (complete && completedOffset > 0 && held.length > 0 && held.every((byte) => byte === 0)) {
      completedOffset = position;
      held = Buffer.alloc(0);
    }
    const repeatedState = repeated ? repeated.snapshot() : null;
    // Windowed readers in this process extend the published map instead of reading the file again.
    if (repeatedState && opened && !repeatedRevisionLost) {
      publishClaudeRepeatedMap(file, fd, repeatedState);
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
      claudeRepeated: repeatedState,
      repeatedRevisionLost,
    };
  } finally {
    fs.closeSync(fd);
  }
}

// Index one file revision within the byte and time budgets.
// The saved reducer state covers complete lines before offset. Resume unfinished lines after their remaining bytes arrive.
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
        ? // A source that returns is read again from its start, so the record lets its held bytes go.
          { ...releaseSpendHeldLine(previous), missingAt: previous.missingAt ?? now }
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
  const policyChanged =
    parserKind === 'claude' && previous?.cacheExpiryChildPolicy !== (emptyReducer.nativeChildRequests?.() === true);
  const unchanged =
    lifetimeReady &&
    previous.complete !== false &&
    previous.missingAt === undefined &&
    (parserKind !== 'claude' || previous.cacheExpiryChildPolicy === (emptyReducer.nativeChildRequests?.() === true)) &&
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
    policyChanged ||
    previous.missingAt !== undefined ||
    stat.size < previous.size ||
    (!resuming && stat.size === previous.size);
  // A Claude source resumes only with the repeated-record detector that classified the bytes before its offset.
  const repeatedStateLost =
    parserKind === 'claude' &&
    !!previous &&
    (!previous.claudeRepeated || previous.claudeRepeated.through > previous.offset);
  const base = rebuilt || repeatedStateLost ? undefined : previous;
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
    parserKind === 'claude' ? (base?.claudeRepeated ?? emptyClaudeRepeatedState()) : null,
  );
  if (scanned.repeatedRevisionLost) {
    forgetClaudeRepeatedLookups(file);
  }
  if (scanned.repeatedRevisionLost && previous) {
    // The bytes behind the saved offset changed or went away. The next slice rebuilds the file.
    const kept = releaseSpendHeldLine({ ...previous, complete: false });
    delete kept.claudeRepeated;
    return {
      record: kept,
      totalsChanged: false,
      stateChanged: true,
      changed: true,
      rebuilt: false,
      found: true,
      complete: false,
      invalidated: true,
    };
  }
  const buckets = scanned.buckets;
  const record: SpendFileIndex = {
    file: normalizedFile,
    workspace: normalizedWorkspace,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    offset: scanned.offset,
    // An unfinished scan keeps its held bytes once, in pendingBytes. Every reader of trailing
    // treats an incomplete record as unfinished first.
    trailing: scanned.complete ? scanned.trailing.toString('utf8') : '',
    ...(scanned.complete ? { trailingBytes: scanned.trailing.toString('base64') } : {}),
    buckets,
    lifetimeBuckets: scanned.lifetimeBuckets,
    turnCount: scanned.turnCount,
    compactionCount: scanned.compactionCount,
    firstTurnAt: scanned.firstTurnAt,
    lastTurnAt: scanned.lastTurnAt,
    newestTurnStartedAt: reducer.newestTurnStartedAt?.() ?? null,
    outcome: reducer.newestTurnOutcome?.() ?? null,
    cacheExpiry: scanned.cacheExpiry,
    cacheExpiryChildPolicy: reducer.nativeChildRequests?.() === true,
    parserGeneration: PROJECT_SPEND_PARSER_GENERATION,
    ...(parserKind === undefined ? {} : { parserKind }),
    indexedAt: now,
    parserState: reducer.snapshot(),
    ...(scanned.claudeRepeated ? { claudeRepeated: scanned.claudeRepeated } : {}),
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
    rebuilt: rebuilt || repeatedStateLost,
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

// Use the single folder as the project spend workspace path.
// A multi-root window uses the first folder's filesystem root and a digest of all normalized, sorted folder paths.
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

// Advance completed scans past trailing NUL padding.
// Padding contains no JSONL record and must follow at least one complete line.
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
    // Readers in this process start from the saved maps, also of files the index does not read again.
    publishClaudeRepeatedLedger(ledger.files);
    publishClaudeRepeatedLedger(ledger.completeFiles);
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
    return releaseSpendHeldLine(bounded);
  };
  // Array.from exposes sparse entries so filtering drops holes and unusable records before serialization.
  const present = Array.from(files).filter(usableSpendRecord);
  const shown = Array.from(completeFiles).filter(usableSpendRecord);
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
  // A checkpoint copies these fields unchanged, so records that differ in one of them serialize differently.
  const sameScalars = (left: SpendFileIndex, right: SpendFileIndex) =>
    (['size', 'mtimeMs', 'offset', 'complete', 'indexedAt'] as const).every(
      (key) => left[key] === right[key] || Object.is(left[key], right[key]),
    );
  // The save streams one record text at a time, because the whole ledger can exceed 100 MB.
  writeFileStreamAtomically(ledgerFile(storageDirectory, workspace), (write) => {
    write(
      `{"workspace":${JSON.stringify(normalizeWorkspace(workspace))}` +
        `,"parserGeneration":${PROJECT_SPEND_PARSER_GENERATION}` +
        `,"files":[`,
    );
    present.forEach((record, at) => write((at ? ',' : '') + JSON.stringify(checkpoint(record))));
    write('],"displayFiles":[');
    // Store display records as indexes when they match files by identity or by normalized path and serialized content.
    // Write differing records in full.
    shown.forEach((record, at) => {
      const separator = at ? ',' : '';
      const shared = sameRecord.get(record);
      if (shared !== undefined) {
        write(separator + String(shared));
        return;
      }
      const found = samePath.get(normalizeSpendFile(record.file));
      const text = JSON.stringify(checkpoint(record));
      const same =
        found !== undefined &&
        sameScalars(present[found], record) &&
        JSON.stringify(checkpoint(present[found])) === text;
      write(separator + (same ? String(found) : text));
    });
    write(']}');
  });
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
  activity: boolean;
  pricedActivity: boolean;
  dollars: number;
  priced: number;
  unpriced: number;
  seen: number;
  partial: boolean;
  sources: Map<string, { effectiveDate: string | null; provenance: ProjectSpendProvenance }>;
}
function accumulator(): Accumulator {
  return {
    activity: false,
    pricedActivity: false,
    dollars: 0,
    priced: 0,
    unpriced: 0,
    seen: 0,
    partial: false,
    sources: new Map(),
  };
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
  total.activity = true;
  if (bucket.requestCountExact === false && bucket.agent.toLowerCase() === 'codex') total.partial = true;
  total.seen += bucket.requests;
  if (!price) {
    total.unpriced += bucket.requests;
    total.partial = true;
    return;
  }
  total.dollars += price.dollars;
  total.pricedActivity = true;
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
  // A truncated window marks a known amount as a lower bound.
  const partial = unpriced || truncated;
  const hasKnownActivity = total.activity || incomplete;
  const dollars =
    total.pricedActivity && (!unpriced || total.dollars > 0) ? total.dollars : hasKnownActivity ? null : 0;
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
  const records = new Map(files.map((file) => [file.file, file]));
  const directClaude = directClaudeSources(files);
  const incomplete = new Map(windows.map((window) => [window.id, { total: false, claude: false, codex: false }]));
  let lastIndexedAt: number | null = null;
  for (const file of files) {
    lastIndexedAt = lastIndexedAt === null ? file.indexedAt : Math.max(lastIndexedAt, file.indexedAt);
    const unresolvedOwnership = spendRecordUsagePending(file);
    if (unresolvedOwnership) evidencedAgents.add('codex');
    if (file.complete !== false && (file.trailingBytes || file.trailing || unresolvedOwnership)) {
      const modified = localDate(file.mtimeMs);
      for (const window of windows) {
        if (modified < window.start) {
          continue;
        }
        const affected = incomplete.get(window.id)!;
        affected.total = true;
        if (!unresolvedOwnership) affected.claude = true;
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
    for (const bucket of [
      ...file.buckets,
      ...(matchingCostSupplement(file.costStateSupplement, records) ? file.costStateSupplement.dated : []),
    ]) {
      if (bucket.linkedSessionId && directClaude.usableSessions.has(bucket.linkedSessionId)) {
        continue;
      }
      const agent = spendAgent(bucket.agent);
      if (agent) evidencedAgents.add(agent);
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
  const earliestRecord = contributingDates.reduce<string | null>(
    (earliest, date) => (earliest === null || date < earliest ? date : earliest),
    null,
  );
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
  nativeParentFile?: string;
  sessionId: string;
  file: string;
  primary?: boolean;
  // Dispatched session whose own source was propagated to an ancestor.
  // The receiving session does not need to be its direct dispatcher.
  dispatchedFrom?: string;
  // Dispatched session id used to group this source at a receiving ancestor.
  // A dispatch edge updates this id. A native subagent edge keeps it.
  // Nested dispatched sources share the first dispatched session below that ancestor.
  // The id never names a native subagent on the chain.
  dispatchedVia?: string;
  // Marks the dispatched session's primary transcript among its propagated sources.
  // Only sources marked primary, or with primary omitted, receive this flag.
  dispatchedPrimary?: true;
}

export interface SessionSpendPart {
  bucket: ProjectUsageBucket;
  role: 'main' | 'delegated';
  scopeId?: string;
}

export interface SessionSpendCoverage {
  main: boolean;
  delegated: boolean;
  delegatedScopeIds: Set<string>;
}

export function claudeCostStateDependencies(
  owner: SessionSpendSource,
  sources: readonly SessionSpendSource[],
  files: readonly SpendFileIndex[],
): SpendFileIndex[] | null {
  const records = new Map(files.map((file) => [file.file, file]));
  const root = normalizeSpendFile(owner.file);
  const children = new Map<string, Set<string>>();
  for (const source of sources) {
    if (source.dispatchedFrom || source.dispatchedVia) continue;
    const child = normalizeSpendFile(source.file);
    const parent = source.nativeParentFile
      ? normalizeSpendFile(source.nativeParentFile)
      : owner.primary !== false && source.sessionId === owner.sessionId && child !== root
        ? root
        : null;
    if (!parent || child === parent) continue;
    const siblings = children.get(parent) ?? new Set<string>();
    siblings.add(child);
    children.set(parent, siblings);
  }
  const keys = [root];
  const seen = new Set(keys);
  for (let at = 0; at < keys.length; at++) {
    for (const child of children.get(keys[at]) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      keys.push(child);
    }
  }
  const dependencies = keys.map((key) => records.get(key));
  if (
    dependencies.some(
      (file) =>
        !file ||
        file.complete === false ||
        file.missingAt ||
        file.trailing ||
        file.trailingBytes ||
        file.parserGeneration !== PROJECT_SPEND_PARSER_GENERATION,
    )
  )
    return null;
  return dependencies as SpendFileIndex[];
}

export function invalidateClaudeCostSupplements(
  files: readonly SpendFileIndex[],
  sources: readonly SessionSpendSource[],
): SpendFileIndex[] {
  return files.map((record) => {
    if (!record.costStateSupplement && !record.costStateProgress) return record;
    const owner = sources.find(
      (source) => !source.dispatchedFrom && !source.dispatchedVia && normalizeSpendFile(source.file) === record.file,
    );
    const dependencies = owner && claudeCostStateDependencies(owner, sources, files);
    const identity = dependencies ? costStateIdentity(dependencies.map(costStateDependency)) : null;
    if (identity === (record.costStateSupplement?.identity ?? record.costStateProgress?.identity)) return record;
    const { costStateSupplement: _supplement, costStateProgress: _progress, ...baseline } = record;
    return baseline;
  });
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

// Return descendant item positions in input order.
// The last item for each id supplies its parent link. Visit each id once to stop cycles.
// Cache each ancestor's result after traversing its reachable descendants.
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

// Return null when the subagent directory cannot be read.
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

// Wait for directory modification times to settle before caching listings.
// A coarse filesystem clock assigns one timestamp to changes within the same clock tick.
export const SUBAGENT_DIRECTORY_SETTLE_MS = 2_000;

export class SubagentDirectoryCache implements SubagentDirectoryReader {
  private readonly entries = new Map<string, { mtimeMs: number; files: readonly string[] }>();
  private readonly listed = new Set<string>();

  constructor(
    private readonly read: (directory: string) => readonly string[] | null = readSubagentFiles,
    private readonly now: () => number = Date.now,
  ) {}

  // Discard cached directories that files has not visited since the previous sweep.
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
    // Do not cache failed reads. Restored access does not require a directory timestamp change.
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
  ancestors: readonly SpendSessionFile[] = [],
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
  const parentFiles = new Map([...ancestors, ...parents].map((parent) => [parent.sessionId, parent.file]));
  for (const parent of parents) {
    const nativeParentFile = parent.parentSessionId ? parentFiles.get(parent.parentSessionId) : undefined;
    add({
      sessionId: parent.sessionId,
      file: parent.file,
      primary: true,
      ...(nativeParentFile ? { nativeParentFile } : {}),
    });
    for (const file of directories.files(subagentDirectoryOf(parent))) {
      add({ sessionId: parent.sessionId, file, primary: false, nativeParentFile: parent.file });
    }
    for (const position of descendants(parent.sessionId)) {
      const descendant = parents[position];
      const nativeParentFile = descendant.parentSessionId ? parentFiles.get(descendant.parentSessionId) : undefined;
      add({
        sessionId: parent.sessionId,
        file: descendant.file,
        primary: false,
        ...(nativeParentFile ? { nativeParentFile } : {}),
      });
    }
  }
  return sources;
}

// Use the persisted parser kind when available.
// Otherwise, infer Codex from any Codex lifetime bucket, falling back to windowed buckets for older records.
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

// Add each dispatched session's sources to its ancestors as delegated work.
// Keep the child's sources and deduplicate ancestor sources by file.
// parents supplies dispatch edges. delegators supplies native subagent edges without adding the subagent's own sources.
// Only resolve paths for sessions on a dispatch chain.
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
    let via = child;
    for (
      let below = child, parent = above(child);
      parent !== undefined && !reached.has(parent);
      below = parent, parent = above(parent)
    ) {
      reached.add(parent);
      // A dispatch edge moves the key up to the session it crossed. A subagent edge keeps it.
      if (parents.has(below)) {
        via = below;
      }
      for (const source of own.get(child) ?? []) {
        const key = `${parent}\0${canonicalPath(source.file)}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        out.push({
          sessionId: parent,
          file: source.file,
          primary: false,
          dispatchedFrom: child,
          dispatchedVia: via,
          ...(source.primary !== false ? { dispatchedPrimary: true as const } : {}),
        });
      }
    }
  }
  return out;
}

export interface SessionSpendDiscovery {
  claude: typeof discoverClaudeSessionSpendSources;
  codex: typeof discoverCodexSessionSpendSources;
}

// Caches spend sources by sorted session, parent, and child-listing facts.
// Input order does not affect the key. revision changes only when the resulting sources change.
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
      ...claude.map(
        (source) =>
          `c\0${source.sessionId}\0${source.file}\0${source.primary === false ? 'd' : 'm'}\0${source.nativeParentFile ?? ''}`,
      ),
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
    const native = [
      ...claude,
      ...this.discover.claude(
        claudeChildren,
        { files: listingOf },
        claude.filter((source) => source.primary !== false),
      ),
    ];
    const parents = new Map(
      native
        .filter((source) => source.nativeParentFile)
        .map((source) => [normalizeSpendFile(source.file), normalizeSpendFile(source.nativeParentFile!)]),
    );
    const owners = new Map(
      native
        .filter((source) => source.primary !== false)
        .map((source) => [normalizeSpendFile(source.file), source.sessionId]),
    );
    const joined = new Map(native.map((source) => [`${source.sessionId}\0${normalizeSpendFile(source.file)}`, source]));
    for (const source of native) {
      const visited = new Set([normalizeSpendFile(source.file)]);
      let parent = parents.get(normalizeSpendFile(source.file));
      while (parent && !visited.has(parent)) {
        visited.add(parent);
        const sessionId = owners.get(parent);
        const key = `${sessionId}\0${normalizeSpendFile(source.file)}`;
        if (sessionId && !joined.has(key)) joined.set(key, { ...source, sessionId, primary: false });
        parent = parents.get(parent);
      }
    }
    this.held = withDispatchedSpendSources(
      [...joined.values(), ...this.discover.codex(codex, codexChildren)],
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
          `${source.sessionId}\0${source.file}\0${source.primary === false ? 'delegated' : 'main'}\0${source.dispatchedFrom ?? ''}\0${source.dispatchedVia ?? ''}\0${source.dispatchedPrimary ? 'own' : ''}\0${source.nativeParentFile ?? ''}`,
      )
      .join('\n');
    if (print !== this.print) {
      this.print = print;
      this.changes++;
    }
    return this.held;
  }
}

// Reuse normalized record keys without resolving filesystem links.
// Resolve aliases and sources absent from the record map through normalizeSpendFile.
function spendSourceKey<T>(file: string, records: ReadonlyMap<string, T>): string {
  const lexical = normalizeWorkspace(file);
  return records.has(lexical) ? lexical : normalizeSpendFile(file);
}

// Session figures include complete lifetime buckets from their own sources.
// Dispatched groups join when every waiting source clears the ledger's pending check.
// An unread source, unfinished line, unresolved ownership, or open turn holds its group while pending.
// Missing or history-limited sources join with their available records.
// Incomplete buckets contribute no usage, even after pending clears.
// awaiting receives the session id when its main or delegated usage is incomplete.
// The output flags distinguish main usage from delegated usage.
// Dispatched readiness never blocks the session's own sources.
export function sessionSpendPartsBySession(
  files: readonly SpendFileIndex[],
  sources: readonly SessionSpendSource[],
  awaiting?: Set<string>,
  pending: SpendSourcePending = () => true,
  coverageBySession?: Map<string, SessionSpendCoverage>,
): Record<string, SessionSpendPart[]> {
  const records = new Map(files.map((record) => [normalizeWorkspace(record.file), record]));
  const costRecords = new Map(files.map((record) => [record.file, record]));
  const whole = ({ record }: { record: SpendFileIndex | undefined }) => spendRecordWhole(record);
  const out: Record<string, SessionSpendPart[]> = {};
  for (const [sessionId, groups] of groupedSpendSources(sources, records, (source) => source.sessionId)) {
    const found: GroupedSpendFile[] = [];
    const coverage: SessionSpendCoverage = { main: false, delegated: false, delegatedScopeIds: new Set() };
    const missing = (file: GroupedSpendFile) => {
      if (file.primary) {
        coverage.main = true;
      } else {
        coverage.delegated = true;
        coverage.delegatedScopeIds.add(`source:${file.file}`);
      }
    };
    for (const [group, files] of groups) {
      if (!group) {
        found.push(...files);
        for (const file of files) {
          if (!whole(file)) missing(file);
        }
        continue;
      }
      const joined = readyDispatchedFiles(files, pending);
      if (joined) {
        found.push(...joined);
      } else {
        coverage.delegated = true;
      }
    }
    // Exclude incomplete buckets from lifetime parts and mark their coverage incomplete.
    // Their counters do not establish a lower bound.
    for (const file of found) {
      for (const part of spendPartsOf([file])) {
        if (!part.bucket.incomplete) continue;
        if (part.role === 'main') coverage.main = true;
        else {
          coverage.delegated = true;
          if (part.scopeId) coverage.delegatedScopeIds.add(part.scopeId);
        }
      }
    }
    if (coverage.main || coverage.delegated) {
      awaiting?.add(sessionId);
    }
    coverageBySession?.set(sessionId, coverage);
    const supplements = found.flatMap(({ record, primary }) =>
      matchingCostSupplement(record?.costStateSupplement, costRecords)
        ? record.costStateSupplement.lifetime.map((bucket) => ({
            bucket,
            role: primary ? ('main' as const) : ('delegated' as const),
            ...(!primary ? { scopeId: `source:${normalizeWorkspace(record.file)}` } : {}),
          }))
        : [],
    );
    out[sessionId] = [...spendPartsOf(found).filter((part) => !part.bucket.incomplete), ...supplements];
  }
  return out;
}

// Lifetime usage a dispatched session contributes to an ancestor.
// parts groups ready usage by dispatchedFrom. short marks a group still awaiting ledger work.
// own identifies the dispatchedVia session's primary source when its group is ready.
export interface DispatchedSpendContribution {
  parts: Record<string, SessionSpendPart[]>;
  short: boolean;
  own?: { file: string; record: SpendFileIndex | undefined; parts: SessionSpendPart[] };
}

// Group contributions by receiving session and dispatchedVia.
// Use readyDispatchedFiles for the same admission decision as sessionSpendPartsBySession.
export function dispatchedSpendPartsBySession(
  files: readonly SpendFileIndex[],
  sources: readonly SessionSpendSource[],
  pending: SpendSourcePending = () => true,
): Record<string, Record<string, DispatchedSpendContribution>> {
  const records = new Map(files.map((record) => [normalizeWorkspace(record.file), record]));
  const out: Record<string, Record<string, DispatchedSpendContribution>> = {};
  const via = sources.filter((source) => source.dispatchedVia !== undefined);
  const owners = new Map<string, { sessionId: string; via: string }>();
  const primaries = new Set<string>();
  for (const source of via) {
    owners.set(`${source.sessionId}\0${source.dispatchedVia}`, {
      sessionId: source.sessionId,
      via: source.dispatchedVia!,
    });
    if (source.dispatchedPrimary && source.dispatchedFrom === source.dispatchedVia) {
      primaries.add(`${source.sessionId}\0${source.dispatchedVia}\0${spendSourceKey(source.file, records)}`);
    }
  }
  for (const [key, groups] of groupedSpendSources(
    via,
    records,
    (source) => `${source.sessionId}\0${source.dispatchedVia}`,
  )) {
    const owner = owners.get(key)!;
    const contribution: DispatchedSpendContribution = { parts: {}, short: false };
    for (const [group, files] of groups) {
      const joined = readyDispatchedFiles(files, pending);
      if (!joined) {
        contribution.short = true;
        continue;
      }
      const own = group === owner.via ? files.find((file) => primaries.has(`${key}\0${file.file}`)) : undefined;
      const ownParts = own ? spendPartsOf([own]) : [];
      contribution.parts[group] = [...ownParts, ...spendPartsOf(joined.filter((file) => file !== own))];
      if (own) {
        contribution.own = { file: own.file, record: own.record, parts: ownParts };
      }
    }
    (out[owner.sessionId] ??= {})[owner.via] = contribution;
  }
  return out;
}

interface GroupedSpendFile {
  file: string;
  record: SpendFileIndex | undefined;
  primary: boolean;
}

// Group sources by keyOf, then dispatchedFrom, using an empty key for the session's own sources.
// Resolve each file's record key and combine its primary flags.
function groupedSpendSources(
  sources: readonly SessionSpendSource[],
  records: ReadonlyMap<string, SpendFileIndex>,
  keyOf: (source: SessionSpendSource) => string,
): Map<string, Map<string, GroupedSpendFile[]>> {
  const byKey = new Map<string, Map<string, Map<string, boolean>>>();
  for (const source of sources) {
    const key = keyOf(source);
    const groups = byKey.get(key) ?? new Map<string, Map<string, boolean>>();
    const group = source.dispatchedFrom ?? '';
    const held = groups.get(group) ?? new Map<string, boolean>();
    const file = spendSourceKey(source.file, records);
    held.set(file, (held.get(file) ?? false) || source.primary !== false);
    groups.set(group, held);
    byKey.set(key, groups);
  }
  return new Map(
    [...byKey].map(([key, groups]) => [
      key,
      new Map(
        [...groups].map(([group, held]) => [
          group,
          [...held].map(([file, primary]) => ({ file, record: records.get(file), primary })),
        ]),
      ),
    ]),
  );
}

// Return recorded files when no source awaits pending ledger work.
// Return null while any source waits, including unfinished lines, unresolved ownership, or an open turn.
// Sources without records wait only while pending includes them.
function readyDispatchedFiles(
  files: readonly GroupedSpendFile[],
  pending: SpendSourcePending,
): GroupedSpendFile[] | null {
  return files.some(({ file, record }) => spendRecordAwaitsLedger(record) && pending(file, record))
    ? null
    : files.filter((file) => file.record);
}

function spendPartsOf(found: readonly GroupedSpendFile[]): SessionSpendPart[] {
  return found.flatMap(({ record, primary }) =>
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

// Lifetime turn counts, compaction counts, and first-start to last-end timestamps from one primary source.
// Publish only complete sources with no unfinished line and a nonnegative safe-integer turn count.
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

// Cache-expiry facts include distinct native children. Compactions remain primary-source facts.
// Missing or ambiguous primary evidence withholds both projections.
export interface SessionCacheFacts {
  expiry: CacheExpiryFacts;
  compactions: CompactionFact[];
}

export interface NativeChildCacheFacts {
  source: string;
  childId?: string;
  revision: SpendFileIndex;
  facts: CacheExpiryFacts;
  endedAt: number | null;
  outcome: TurnOutcome | null;
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
      record.missingAt !== undefined ||
      record.parserGeneration !== PROJECT_SPEND_PARSER_GENERATION ||
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
    const childSources: NativeChildCacheFacts[] = [];
    const seen = new Set(primaryFiles);
    let incompleteSources = 0;
    for (const source of sources) {
      if (source.sessionId !== sessionId || source.primary !== false || source.dispatchedFrom !== undefined) continue;
      const key = spendSourceKey(source.file, records);
      if (seen.has(key)) continue;
      seen.add(key);
      const child = records.get(key);
      if (
        !child ||
        child.missingAt !== undefined ||
        child.complete === false ||
        child.trailingBytes ||
        child.trailing ||
        child.parserGeneration !== PROJECT_SPEND_PARSER_GENERATION ||
        !child.cacheExpiry
      ) {
        incompleteSources++;
        continue;
      }
      childSources.push({
        source: key,
        childId:
          child.parserKind === 'codex'
            ? (child.parserState as { openingSessionId?: string } | undefined)?.openingSessionId
            : path
                .basename(key)
                .replace(/^agent-/, '')
                .replace(/\.jsonl$/, ''),
        revision: child,
        facts: child.cacheExpiry.facts,
        endedAt: Math.max(child.lastTurnAt ?? 0, child.cacheExpiry.carry?.timestamp ?? 0) || null,
        outcome: child.outcome ?? null,
      });
    }
    const main = record.cacheExpiry.facts;
    const combined = combineCacheExpirySummaries(
      [main, ...childSources.map((child) => child.facts)].map((facts) => ({
        ...facts,
        longestGap: facts.longestGapMs,
      })),
    );
    out[sessionId].expiry = {
      ...main,
      counts: combined.counts,
      longestGapMs: combined.longestGap,
      excluded: combined.excluded,
      unavailable: combined.unavailable,
      childSources,
      incompleteSources,
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
