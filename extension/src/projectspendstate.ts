import { CODEX_USAGE_ASSOCIATION_LIMIT, type CodexUsageReducerState } from './codex';
import {
  costStateIdentity,
  validClaudeCostCapture,
  validClaudeCostProgress,
  validCostStateDependencies,
  validCostStateAllocations,
  validCostStateMaterialization,
  type ClaudeCostSupplement,
} from './claudecoststate';
import { validClaudeRepeatedState } from './clauderepeated';
import type {
  CacheExpiryCarry,
  CacheExpiryFacts,
  CacheExpiryLedger,
  CacheExpiryCarryCompaction,
  CacheExpiryReturn,
  CompactionFact,
  ProjectUsageBucket,
  SpendFileIndex,
  SpendLedger,
  UsageCounts,
} from './projectspend';
import type { ReducerCompaction } from './transcript';
import {
  RETAINED_CACHE_EXPIRY_RETURNS,
  RETAINED_COMPACTION_PARENTS,
  RETAINED_COMPACTIONS,
  RETAINED_REQUESTS,
} from './parserstate';
import type {
  ClaudePreviousTurn,
  ClaudeUsageReducerState,
  TurnOutcome,
  TurnUsage,
  UsageEvent as TranscriptUsageEvent,
  UsageOrigin,
} from './transcript';

type PersistedClaudeUsageReducerState = Omit<ClaudeUsageReducerState, 'seenRequests' | 'closedChildIndex'>;

const CLAUDE_STATE_KEYS = {
  costState: true,
  seenRequestKeys: true,
  closedTurns: true,
  openTurn: true,
  openTurnAnswered: true,
  compactionCount: true,
  recentCompactions: true,
  pendingCompactionTrigger: true,
  pendingCompactionSize: true,
  unsizedCompaction: true,
  compactionParents: true,
  pendingCompaction: true,
  lastRequest: true,
  firstRequestCachedTokens: true,
  pendingCompactionEstimate: true,
  toolListNames: true,
  toolListVersion: true,
  visibleTurns: true,
  firstTurnAt: true,
  currentTurnStartedAt: true,
  currentTurnEndedAt: true,
  currentTurnCommand: true,
  currentTurnCompact: true,
  currentTurnPrevious: true,
  currentTurnWithdrawn: true,
  currentTurnQueued: true,
  currentTurnQueuedBefore: true,
  currentTurnToolEnded: true,
  currentTurnOutcome: true,
  requestEvents: true,
  modelProfile: true,
} satisfies Record<keyof PersistedClaudeUsageReducerState, true>;

const CODEX_STATE_KEYS = {
  nativeCacheChild: true,
  provider: true,
  openingTimestamp: true,
  openingSessionId: true,
  nativeSpawnedAt: true,
  pendingOwnership: true,
  currentTurnRepeated: true,
  agentPath: true,
  foreignSessionMeta: true,
  currentTurnId: true,
  currentTurnCopied: true,
  recentTurnIds: true,
  seenTurnIds: true,
  seenTurnOffsets: true,
  legacyReplayLinks: true,
  replayResetRequired: true,
  copiedTurnIds: true,
  datedCopiedTurnIds: true,
  countedTurnIds: true,
  turnModels: true,
  turnEfforts: true,
  turnWindows: true,
  planType: true,
  planKnown: true,
  serviceTier: true,
  reasoningEffort: true,
  requestNumber: true,
  lastUsageSnapshot: true,
  pendingRequests: true,
  pendingRequestKeys: true,
  pendingRequestSources: true,
  recentClaudeInvocationIds: true,
  seenClaudeInvocations: true,
  recentClaudeCommandIds: true,
  seenClaudeCommands: true,
  pendingClaudeResultIds: true,
  pendingClaudeResults: true,
  closedTurns: true,
  currentTurnDidSomething: true,
  currentTurnCompleted: true,
  compactionCount: true,
  recentCompactions: true,
  compactionTurnOrdinals: true,
  pendingCompactionBilling: true,
  recentResponseUsage: true,
  recentRequestEvents: true,
  compactionResponseIds: true,
  firstTurnAt: true,
  lastTurnAt: true,
  currentTurnStartedAt: true,
  currentTurnEndedAt: true,
  currentTurnOutcome: true,
  lastTurnStartedAt: true,
  lastTurnOutcome: true,
} satisfies Record<keyof CodexUsageReducerState, true>;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function nullableText(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function nonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function timestamp(value: unknown): value is number {
  return nonNegative(value) && !Number.isNaN(new Date(value).getTime());
}

function turnOutcome(value: unknown): value is TurnOutcome {
  return (
    record(value) &&
    typeof value.finished === 'boolean' &&
    typeof value.error === 'boolean' &&
    typeof value.interrupted === 'boolean' &&
    timestamp(value.endedAt) &&
    (!Object.prototype.hasOwnProperty.call(value, 'processEndedAt') || timestamp(value.processEndedAt)) &&
    (!Object.prototype.hasOwnProperty.call(value, 'openChildren') ||
      (Array.isArray(value.openChildren) && value.openChildren.every(nonEmptyText)))
  );
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value;
}

function validBase64(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return false;
  }
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function usageCounts(value: unknown): value is UsageCounts {
  if (!record(value)) {
    return false;
  }
  return (
    ['input', 'cacheWrite1h', 'cacheWrite5m', 'cacheRead', 'output', 'thinking'].every((key) =>
      nonNegativeInteger(value[key]),
    ) &&
    (value.requests === undefined || nonNegativeInteger(value.requests)) &&
    (value.cacheWrite30m === undefined || nonNegativeInteger(value.cacheWrite30m))
  );
}

function turnUsage(value: unknown): value is TurnUsage {
  const bands = record(value) ? value.byContextBand : undefined;
  if (!usageCounts(value)) {
    return false;
  }
  if (bands === undefined) {
    return true;
  }
  if (!record(bands)) {
    return false;
  }
  return ['short', 'long'].every((band) => bands[band] === undefined || usageCounts(bands[band]));
}

function transcriptUsageEvent(value: unknown, expectedAgent: 'claude' | 'codex'): value is TranscriptUsageEvent {
  if (!record(value)) {
    return false;
  }
  return (
    timestamp(value.timestamp) &&
    value.agent === expectedAgent &&
    nullableText(value.provider) &&
    nullableText(value.model) &&
    (value.contextWindow === null || nonNegativeInteger(value.contextWindow)) &&
    (value.contextTokens === undefined || nonNegativeInteger(value.contextTokens)) &&
    (value.firstPassUsage === undefined || usageCounts(value.firstPassUsage)) &&
    (value.firstPassContextBand === undefined ||
      value.firstPassContextBand === null ||
      value.firstPassContextBand === 'short' ||
      value.firstPassContextBand === 'long') &&
    (value.finalPassOutputTokens === undefined || nonNegativeInteger(value.finalPassOutputTokens)) &&
    (value.finalPassCacheRead === undefined || nonNegativeInteger(value.finalPassCacheRead)) &&
    (value.contextBand === null || value.contextBand === 'short' || value.contextBand === 'long') &&
    (value.billingClass === 'metered' || value.billingClass === 'subscription' || value.billingClass === 'unknown') &&
    (value.inferenceClass === null ||
      value.inferenceClass === 'in-region' ||
      value.inferenceClass === 'geo' ||
      value.inferenceClass === 'global' ||
      value.inferenceClass === 'bedrock-regional') &&
    nullableText(value.serviceTier) &&
    (value.reportedCost === null || nonNegative(value.reportedCost)) &&
    (value.reportedCostBasis === undefined || nullableText(value.reportedCostBasis)) &&
    (value.linkedSessionId === undefined || nullableText(value.linkedSessionId)) &&
    (value.linkedInvocationId === undefined || nullableText(value.linkedInvocationId)) &&
    (value.unclassifiedCacheWrite === undefined || nonNegativeInteger(value.unclassifiedCacheWrite)) &&
    (value.incomplete === undefined || typeof value.incomplete === 'boolean') &&
    (value.requestCountExact === undefined || value.requestCountExact === false) &&
    (value.visibleTurnId === undefined || nullableText(value.visibleTurnId)) &&
    (value.cacheLifetime === undefined ||
      value.cacheLifetime === null ||
      value.cacheLifetime === '5m' ||
      value.cacheLifetime === '30m' ||
      value.cacheLifetime === '1h') &&
    (value.compactionsBefore === undefined || nonNegativeInteger(value.compactionsBefore)) &&
    (value.usageOrigin === undefined || value.usageOrigin === 'claude-advisor') &&
    turnUsage(value.usage) &&
    nonEmptyText(value.requestKey)
  );
}

function dictionary(value: unknown, entry: (item: unknown, key: string) => boolean): boolean {
  return record(value) && Object.entries(value).every(([key, item]) => nonEmptyText(key) && entry(item, key));
}

function onlyKeys(value: Record<string, unknown>, keys: Readonly<Record<string, true>>): boolean {
  return Object.keys(value).every((key) => keys[key]);
}

function trueDictionary(value: unknown): value is Record<string, true> {
  return dictionary(value, (item) => item === true);
}

function compactionSize(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (record(value) &&
      nonNegative(value.before) &&
      nonNegative(value.after) &&
      nonNegative(value.at) &&
      nonNegative(value.durationMs))
  );
}

function unsizedCompaction(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (record(value) &&
      nonNegativeInteger(value.ordinal) &&
      nonNegative(value.at) &&
      value.previous !== undefined &&
      lastClaudeRequest(value.previous) &&
      (value.summaryChars === undefined || nonNegative(value.summaryChars)))
  );
}

// Saved Claude record ids are at most `limit` nonempty strings.
function claudeRecordIds(value: unknown, limit: number): boolean {
  return value === undefined || (Array.isArray(value) && value.length <= limit && value.every(nonEmptyText));
}

// A pending compaction names the newest counted compaction, or none while only its boundary is read.
function pendingCompaction(value: unknown, compactionCount: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (record(value) &&
      Array.isArray(value.parents) &&
      claudeRecordIds(value.parents, RETAINED_COMPACTION_PARENTS) &&
      (value.ordinal === null ||
        (nonNegativeInteger(value.ordinal) && value.ordinal >= 1 && value.ordinal === compactionCount)) &&
      typeof value.boundary === 'boolean' &&
      (value.evicted === null || reducerCompactions([value.evicted], undefined)))
  );
}

function lastClaudeRequest(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (record(value) &&
      nonNegative(value.tokens) &&
      (value.cacheRead === undefined || nonNegative(value.cacheRead)) &&
      (value.cacheWrite === undefined || nonNegative(value.cacheWrite)) &&
      (value.at === null || timestamp(value.at)) &&
      (value.lifetime === null || value.lifetime === '5m' || value.lifetime === '30m' || value.lifetime === '1h') &&
      nullableText(value.model) &&
      (value.inferenceClass === null ||
        value.inferenceClass === 'in-region' ||
        value.inferenceClass === 'geo' ||
        value.inferenceClass === 'global' ||
        value.inferenceClass === 'bedrock-regional') &&
      nullableText(value.serviceTier))
  );
}

function previousTurn(value: unknown): value is ClaudePreviousTurn {
  return (
    record(value) &&
    typeof value.open === 'boolean' &&
    typeof value.answered === 'boolean' &&
    (value.startedAt === null || timestamp(value.startedAt)) &&
    (value.endedAt === null || timestamp(value.endedAt)) &&
    (value.firstTurnAt === null || timestamp(value.firstTurnAt)) &&
    (value.outcome === null || turnOutcome(value.outcome)) &&
    (value.compact === undefined || typeof value.compact === 'boolean') &&
    (value.localStopAt === undefined || timestamp(value.localStopAt))
  );
}

function claudeState(value: unknown, retain = RETAINED_REQUESTS): value is ClaudeUsageReducerState {
  if (
    !record(value) ||
    !onlyKeys(value, CLAUDE_STATE_KEYS) ||
    !(value.costState === undefined || validClaudeCostCapture(value.costState)) ||
    !Array.isArray(value.seenRequestKeys) ||
    !value.seenRequestKeys.every(nonEmptyText) ||
    new Set(value.seenRequestKeys).size !== value.seenRequestKeys.length ||
    !(value.pendingCompactionTrigger === undefined || nullableText(value.pendingCompactionTrigger)) ||
    !compactionSize(value.pendingCompactionSize) ||
    !unsizedCompaction(value.unsizedCompaction) ||
    !claudeRecordIds(value.compactionParents, RETAINED_COMPACTION_PARENTS) ||
    !pendingCompaction(value.pendingCompaction, value.compactionCount) ||
    !lastClaudeRequest(value.lastRequest) ||
    !(
      value.pendingCompactionEstimate === undefined ||
      value.pendingCompactionEstimate === null ||
      (record(value.pendingCompactionEstimate) &&
        transcriptUsageEvent(value.pendingCompactionEstimate.event, 'claude') &&
        record(value.pendingCompactionEstimate.input) &&
        nullableText(value.pendingCompactionEstimate.input.model) &&
        timestamp(value.pendingCompactionEstimate.input.at) &&
        nonNegative(value.pendingCompactionEstimate.input.contextBefore) &&
        nonNegative(value.pendingCompactionEstimate.input.contextAfter) &&
        lastClaudeRequest(value.pendingCompactionEstimate.input.previousRequest))
    ) ||
    !(
      value.firstRequestCachedTokens === undefined ||
      value.firstRequestCachedTokens === null ||
      nonNegative(value.firstRequestCachedTokens)
    ) ||
    !(
      value.toolListNames === undefined ||
      (Array.isArray(value.toolListNames) && value.toolListNames.every(nonEmptyText))
    ) ||
    !(value.toolListVersion === undefined || nonNegativeInteger(value.toolListVersion)) ||
    !(value.modelProfile === undefined || nullableText(value.modelProfile)) ||
    !nonNegativeInteger(value.closedTurns) ||
    typeof value.openTurn !== 'boolean' ||
    typeof value.openTurnAnswered !== 'boolean' ||
    !nonNegativeInteger(value.compactionCount) ||
    !reducerCompactions(value.recentCompactions, value.compactionCount) ||
    !nonNegativeInteger(value.visibleTurns) ||
    !(value.firstTurnAt === null || timestamp(value.firstTurnAt)) ||
    !(value.currentTurnStartedAt === null || timestamp(value.currentTurnStartedAt)) ||
    !(value.currentTurnEndedAt === null || timestamp(value.currentTurnEndedAt)) ||
    !(value.currentTurnCommand === undefined || nullableText(value.currentTurnCommand)) ||
    !(value.currentTurnCompact === undefined || typeof value.currentTurnCompact === 'boolean') ||
    !(
      value.currentTurnPrevious === undefined ||
      value.currentTurnPrevious === null ||
      previousTurn(value.currentTurnPrevious)
    ) ||
    !(
      value.currentTurnWithdrawn === undefined ||
      value.currentTurnWithdrawn === null ||
      previousTurn(value.currentTurnWithdrawn)
    ) ||
    !(value.currentTurnQueued === undefined || typeof value.currentTurnQueued === 'boolean') ||
    !(
      value.currentTurnQueuedBefore === undefined ||
      value.currentTurnQueuedBefore === null ||
      (record(value.currentTurnQueuedBefore) &&
        timestamp(value.currentTurnQueuedBefore.startedAt) &&
        timestamp(value.currentTurnQueuedBefore.endedAt))
    ) ||
    !(value.currentTurnToolEnded === undefined || typeof value.currentTurnToolEnded === 'boolean') ||
    !(value.currentTurnOutcome === null || turnOutcome(value.currentTurnOutcome))
  ) {
    return false;
  }
  if (value.requestEvents === undefined) {
    return true;
  }
  if (!record(value.requestEvents) || Object.keys(value.requestEvents).length > retain) {
    return false;
  }
  const seen = new Set(value.seenRequestKeys);
  return dictionary(
    value.requestEvents,
    (item, key) => transcriptUsageEvent(item, 'claude') && item.requestKey === key && seen.has(key),
  );
}

function nullableTextDictionary(value: unknown): value is Record<string, string | null> {
  return dictionary(value, nullableText);
}

function nullableCountDictionary(value: unknown): value is Record<string, number | null> {
  return dictionary(value, (item) => item === null || nonNegativeInteger(item));
}

function boundedIdentityList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= CODEX_USAGE_ASSOCIATION_LIMIT &&
    value.every(nonEmptyText) &&
    new Set(value).size === value.length
  );
}

function sameIdentities(value: Record<string, unknown>, identities: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === identities.length && keys.every((key) => identities.includes(key));
}

function codexState(value: unknown): value is CodexUsageReducerState {
  if (
    !record(value) ||
    !onlyKeys(value, CODEX_STATE_KEYS) ||
    !nullableText(value.provider) ||
    !nullableText(value.reasoningEffort) ||
    !(value.openingTimestamp === null || timestamp(value.openingTimestamp)) ||
    !nullableText(value.openingSessionId) ||
    !(value.nativeSpawnedAt === null || timestamp(value.nativeSpawnedAt)) ||
    !(value.nativeCacheChild === undefined || typeof value.nativeCacheChild === 'boolean') ||
    !trueDictionary(value.pendingOwnership) ||
    typeof value.currentTurnRepeated !== 'boolean' ||
    !nullableText(value.agentPath) ||
    typeof value.foreignSessionMeta !== 'boolean' ||
    !nullableText(value.currentTurnId) ||
    typeof value.currentTurnCopied !== 'boolean' ||
    !boundedIdentityList(value.recentTurnIds) ||
    !trueDictionary(value.seenTurnIds) ||
    !dictionary(
      value.seenTurnOffsets,
      (item, key) => nonNegativeInteger(item) && (value.seenTurnIds as Record<string, unknown>)[key] === true,
    ) ||
    !Array.isArray(value.legacyReplayLinks) ||
    value.legacyReplayLinks.length > CODEX_USAGE_ASSOCIATION_LIMIT ||
    !value.legacyReplayLinks.every(
      (item) =>
        record(item) &&
        nonEmptyText(item.id) &&
        nonNegativeInteger(item.evidenceOffset) &&
        nonNegativeInteger(item.replayOffset),
    ) ||
    typeof value.replayResetRequired !== 'boolean' ||
    !trueDictionary(value.copiedTurnIds) ||
    !trueDictionary(value.datedCopiedTurnIds) ||
    !trueDictionary(value.countedTurnIds) ||
    !nullableTextDictionary(value.turnModels) ||
    !nullableTextDictionary(value.turnEfforts) ||
    !nullableCountDictionary(value.turnWindows) ||
    !nullableText(value.planType) ||
    typeof value.planKnown !== 'boolean' ||
    !nullableText(value.serviceTier) ||
    !nonNegativeInteger(value.requestNumber) ||
    !(
      value.lastUsageSnapshot === null ||
      (record(value.lastUsageSnapshot) &&
        nonEmptyText(value.lastUsageSnapshot.turnId) &&
        Array.isArray(value.lastUsageSnapshot.last) &&
        value.lastUsageSnapshot.last.length === 6 &&
        value.lastUsageSnapshot.last.every(nonNegativeInteger) &&
        Array.isArray(value.lastUsageSnapshot.total) &&
        value.lastUsageSnapshot.total.length === 6 &&
        value.lastUsageSnapshot.total.every(nonNegativeInteger))
    ) ||
    !dictionary(
      value.pendingRequests,
      (items) =>
        Array.isArray(items) &&
        items.every((item) => transcriptUsageEvent(item, 'codex') || transcriptUsageEvent(item, 'claude')),
    ) ||
    !boundedIdentityList(value.pendingRequestKeys) ||
    !dictionary(
      value.pendingRequestSources,
      (item) =>
        record(item) && nonNegativeInteger(item.start) && nonNegativeInteger(item.end) && item.end >= item.start,
    ) ||
    !boundedIdentityList(value.recentClaudeInvocationIds) ||
    !trueDictionary(value.seenClaudeInvocations) ||
    !boundedIdentityList(value.recentClaudeCommandIds) ||
    !trueDictionary(value.seenClaudeCommands) ||
    !boundedIdentityList(value.pendingClaudeResultIds) ||
    !dictionary(value.pendingClaudeResults, (item) => transcriptUsageEvent(item, 'claude')) ||
    !Array.isArray(value.recentResponseUsage) ||
    value.recentResponseUsage.length > CODEX_USAGE_ASSOCIATION_LIMIT ||
    !value.recentResponseUsage.every(
      (item) =>
        record(item) &&
        nonEmptyText(item.responseId) &&
        typeof item.turnId === 'string' &&
        turnUsage(item.usage) &&
        (item.matched === undefined || item.matched === true) &&
        (item.explicitSnapshot === undefined || item.explicitSnapshot === true) &&
        (item.suppressedSnapshot === undefined || transcriptUsageEvent(item.suppressedSnapshot, 'codex')),
    ) ||
    !Array.isArray(value.recentRequestEvents) ||
    value.recentRequestEvents.length > CODEX_USAGE_ASSOCIATION_LIMIT ||
    !value.recentRequestEvents.every(
      (item) => transcriptUsageEvent(item, 'codex') || transcriptUsageEvent(item, 'claude'),
    ) ||
    !boundedIdentityList(value.compactionResponseIds) ||
    !nonNegativeInteger(value.closedTurns) ||
    typeof value.currentTurnDidSomething !== 'boolean' ||
    typeof value.currentTurnCompleted !== 'boolean' ||
    !nonNegativeInteger(value.compactionCount) ||
    !reducerCompactions(value.recentCompactions, value.compactionCount) ||
    !dictionary(
      value.compactionTurnOrdinals,
      (ordinals) => Array.isArray(ordinals) && ordinals.every(nonNegativeInteger),
    ) ||
    !pendingCompactionBilling(value.pendingCompactionBilling, value.compactionCount, value.recentCompactions) ||
    !(value.firstTurnAt === null || timestamp(value.firstTurnAt)) ||
    !(value.lastTurnAt === null || timestamp(value.lastTurnAt)) ||
    !(value.currentTurnStartedAt === null || timestamp(value.currentTurnStartedAt)) ||
    !(value.currentTurnEndedAt === null || timestamp(value.currentTurnEndedAt)) ||
    !(value.currentTurnOutcome === null || turnOutcome(value.currentTurnOutcome)) ||
    !(value.lastTurnStartedAt === null || timestamp(value.lastTurnStartedAt)) ||
    !(value.lastTurnOutcome === null || turnOutcome(value.lastTurnOutcome))
  ) {
    return false;
  }
  if (
    !sameIdentities(value.seenTurnIds, value.recentTurnIds) ||
    !sameIdentities(value.seenClaudeInvocations, value.recentClaudeInvocationIds) ||
    !sameIdentities(value.seenClaudeCommands, value.recentClaudeCommandIds) ||
    !sameIdentities(value.pendingClaudeResults as Record<string, unknown>, value.pendingClaudeResultIds)
  ) {
    return false;
  }
  const recentTurnIds = new Set(value.recentTurnIds);
  for (const association of [
    value.seenTurnOffsets,
    value.copiedTurnIds,
    value.datedCopiedTurnIds,
    value.countedTurnIds,
    value.turnModels,
    value.turnEfforts,
    value.turnWindows,
    value.pendingOwnership,
    value.pendingRequests,
  ] as Array<Record<string, unknown>>) {
    if (Object.keys(association).some((key) => !recentTurnIds.has(key))) {
      return false;
    }
  }
  if (value.legacyReplayLinks.some((link) => !recentTurnIds.has(link.id))) {
    return false;
  }
  for (const key of Object.keys(value.datedCopiedTurnIds)) {
    if ((value.copiedTurnIds as Record<string, unknown>)[key] !== true) {
      return false;
    }
  }
  for (const key of Object.keys(value.pendingOwnership)) {
    if ((value.copiedTurnIds as Record<string, unknown>)[key] !== true) return false;
  }
  const currentTurnId = value.currentTurnId;
  if (currentTurnId !== null && (value.seenTurnIds as Record<string, unknown>)[currentTurnId] !== true) {
    return false;
  }
  const currentTurnIsCopied =
    currentTurnId !== null && (value.copiedTurnIds as Record<string, unknown>)[currentTurnId] === true;
  if (value.currentTurnCopied !== currentTurnIsCopied) {
    return false;
  }
  const pendingKeys = new Set<string>();
  for (const [turnId, items] of Object.entries(value.pendingRequests as Record<string, unknown>)) {
    for (const item of items as TranscriptUsageEvent[]) {
      const eventTurnId =
        item.agent === 'codex'
          ? (item.visibleTurnId?.replace(/^codex-turn:/, '') ?? /^codex:([^:]+):/.exec(item.requestKey)?.[1])
          : item.visibleTurnId?.replace(/^codex-turn:/, '');
      if (
        eventTurnId !== turnId ||
        (item.model !== null && !(value.pendingOwnership as Record<string, unknown>)[turnId]) ||
        pendingKeys.has(item.requestKey)
      ) {
        return false;
      }
      pendingKeys.add(item.requestKey);
    }
  }
  if (
    pendingKeys.size !== value.pendingRequestKeys.length ||
    value.pendingRequestKeys.some((key) => !pendingKeys.has(key))
  ) {
    return false;
  }
  return Object.keys(value.pendingRequestSources as Record<string, unknown>).every((key) => pendingKeys.has(key));
}

function parserState(
  value: unknown,
  parserKind: 'claude' | 'codex',
): value is ClaudeUsageReducerState | CodexUsageReducerState {
  return parserKind === 'claude' ? claudeState(value) : codexState(value);
}

interface UsageIdentity {
  usageOrigin?: UsageOrigin;
  agent: string;
  provider: string | null;
  model: string | null;
  contextWindow: number | null;
  contextBand?: 'short' | 'long' | null;
  billingClass: 'metered' | 'subscription' | 'unknown';
  inferenceClass: 'in-region' | 'geo' | 'global' | 'bedrock-regional' | null;
  serviceTier: string | null;
  reportedCost: number | null;
  reportedCostBasis?: string | null;
  linkedSessionId?: string | null;
  linkedInvocationId?: string | null;
  incomplete?: boolean;
  requestCountExact?: false;
  compactionEstimate?: true;
  compactionUsage?: true;
}

export function projectUsageKey(value: UsageIdentity, date: string): string {
  return JSON.stringify([
    date,
    value.agent,
    value.provider,
    value.model,
    value.contextWindow,
    value.contextBand ?? null,
    value.billingClass,
    value.inferenceClass,
    value.serviceTier,
    value.reportedCost === null ? 'estimated' : 'reported',
    value.reportedCostBasis ?? null,
    value.linkedSessionId ?? null,
    value.linkedInvocationId ?? null,
    value.incomplete === true,
    value.requestCountExact === false,
    value.compactionEstimate === true,
    Boolean(value.compactionUsage),
    value.usageOrigin ?? null,
  ]);
}

function bucket(value: unknown): ProjectUsageBucket | null {
  if (
    !record(value) ||
    !validDate(value.localDate) ||
    !nonEmptyText(value.agent) ||
    !nullableText(value.provider) ||
    !nullableText(value.model) ||
    !(value.contextWindow === null || nonNegativeInteger(value.contextWindow)) ||
    !(value.contextBand === null || value.contextBand === 'short' || value.contextBand === 'long') ||
    !(value.billingClass === 'metered' || value.billingClass === 'subscription' || value.billingClass === 'unknown') ||
    !(
      value.inferenceClass === null ||
      value.inferenceClass === 'in-region' ||
      value.inferenceClass === 'geo' ||
      value.inferenceClass === 'global' ||
      value.inferenceClass === 'bedrock-regional'
    ) ||
    !nullableText(value.serviceTier) ||
    !(value.reportedCost === null || nonNegative(value.reportedCost)) ||
    (value.reportedCostBasis !== undefined && !nullableText(value.reportedCostBasis)) ||
    (value.linkedSessionId !== undefined && !nullableText(value.linkedSessionId)) ||
    (value.linkedInvocationId !== undefined && !nullableText(value.linkedInvocationId)) ||
    (value.unclassifiedCacheWrite !== undefined && !nonNegativeInteger(value.unclassifiedCacheWrite)) ||
    (value.incomplete !== undefined && typeof value.incomplete !== 'boolean') ||
    (value.requestCountExact !== undefined && value.requestCountExact !== false) ||
    (value.compactionEstimate !== undefined && value.compactionEstimate !== true) ||
    (value.compactionUsage !== undefined && !value.compactionUsage) ||
    (value.usageOrigin !== undefined &&
      value.usageOrigin !== 'claude-cost-state' &&
      value.usageOrigin !== 'claude-advisor') ||
    (value.usageOrigin === 'claude-cost-state' &&
      (value.requests !== 0 ||
        value.requestCountExact !== false ||
        !record(value.usage) ||
        value.usage.requests !== 0 ||
        value.compactionEstimate !== undefined)) ||
    !turnUsage(value.usage) ||
    !nonNegativeInteger(value.requests)
  ) {
    return null;
  }
  return {
    localDate: value.localDate,
    agent: value.agent,
    provider: value.provider,
    model: value.model,
    contextWindow: value.contextWindow,
    contextBand: value.contextBand,
    billingClass: value.billingClass,
    inferenceClass: value.inferenceClass,
    serviceTier: value.serviceTier,
    reportedCost: value.reportedCost,
    ...(value.reportedCostBasis === undefined ? {} : { reportedCostBasis: value.reportedCostBasis }),
    ...(value.linkedSessionId === undefined ? {} : { linkedSessionId: value.linkedSessionId }),
    ...(value.linkedInvocationId === undefined ? {} : { linkedInvocationId: value.linkedInvocationId }),
    ...(value.unclassifiedCacheWrite === undefined ? {} : { unclassifiedCacheWrite: value.unclassifiedCacheWrite }),
    ...(value.incomplete === undefined ? {} : { incomplete: value.incomplete }),
    ...(value.requestCountExact === false ? { requestCountExact: false as const } : {}),
    ...(value.compactionEstimate === true ? { compactionEstimate: true as const } : {}),
    ...(value.compactionUsage ? { compactionUsage: true as const } : {}),
    ...(value.usageOrigin === 'claude-cost-state' || value.usageOrigin === 'claude-advisor'
      ? { usageOrigin: value.usageOrigin }
      : {}),
    usage: {
      requests: value.usage.requests,
      ...(value.usage.byContextBand === undefined ? {} : { byContextBand: structuredClone(value.usage.byContextBand) }),
      input: value.usage.input,
      cacheWrite1h: value.usage.cacheWrite1h,
      cacheWrite5m: value.usage.cacheWrite5m,
      cacheWrite30m: value.usage.cacheWrite30m,
      cacheRead: value.usage.cacheRead,
      output: value.usage.output,
      thinking: value.usage.thinking,
    },
    requests: value.requests,
  };
}

// Reducers retain the newest `RETAINED_COMPACTIONS` entries in ordinal order.
// The final ordinal must match the total compaction count.
// Reject shorter lists because resumed scans would lose compaction evidence.
function reducerCompactions(value: unknown, compactionCount: unknown): value is ReducerCompaction[] {
  if (!Array.isArray(value) || value.length > RETAINED_COMPACTIONS) {
    return false;
  }
  if (
    !value.every(
      (item) =>
        record(item) &&
        nonNegativeInteger(item.ordinal) &&
        item.ordinal >= 1 &&
        (item.at === null || timestamp(item.at)) &&
        nullableText(item.trigger) &&
        (item.requestUsage === null || turnUsage(item.requestUsage)) &&
        nullableText(item.requestModel) &&
        nullableText(item.requestProvider) &&
        nullableText(item.requestServiceTier) &&
        (item.requestContextWindow === null || nonNegativeInteger(item.requestContextWindow)),
    )
  ) {
    return false;
  }
  const ordinals = value.map((item) => (item as ReducerCompaction).ordinal);
  if (ordinals.some((ordinal, at) => at > 0 && ordinal !== ordinals[at - 1] + 1)) {
    return false;
  }
  if (!nonNegativeInteger(compactionCount)) {
    return true;
  }
  return (
    value.length === Math.min(compactionCount, RETAINED_COMPACTIONS) &&
    (value.length === 0 || ordinals[ordinals.length - 1] === compactionCount)
  );
}

// A pending billing marker must identify the newest compaction with its own request usage.
// Later compactions replace the marker. Closing a turn clears it.
// A marker for another compaction would assign the next settings record's identity
// to the wrong request.
function pendingCompactionBilling(value: unknown, compactionCount: unknown, compactions: unknown): boolean {
  if (value === null) {
    return true;
  }
  if (!nonNegativeInteger(value) || value < 1 || value !== compactionCount) {
    return false;
  }
  if (!Array.isArray(compactions)) {
    return false;
  }
  const held = compactions.find((item) => record(item) && item.ordinal === value);
  return record(held) && (held.requestUsage !== null || nonEmptyText(held.responseId));
}

function cacheTier(value: unknown): value is '5m' | '30m' | '1h' {
  return value === '5m' || value === '30m' || value === '1h';
}

function cacheExpiryCarry(value: unknown): CacheExpiryCarry | null {
  if (
    !record(value) ||
    !nullableText(value.requestKey) ||
    !nonNegative(value.timestamp) ||
    !nullableText(value.visibleTurnId) ||
    !(value.lifetime === null || cacheTier(value.lifetime)) ||
    !nullableText(value.model) ||
    !nullableText(value.provider) ||
    !nullableText(value.serviceTier) ||
    !(value.effort === undefined || nullableText(value.effort)) ||
    !(
      value.toolListVersion === undefined ||
      value.toolListVersion === null ||
      nonNegativeInteger(value.toolListVersion)
    ) ||
    !(
      value.inferenceClass === null ||
      value.inferenceClass === 'in-region' ||
      value.inferenceClass === 'geo' ||
      value.inferenceClass === 'global' ||
      value.inferenceClass === 'bedrock-regional'
    ) ||
    !nonNegativeInteger(value.compactionsBefore) ||
    !nonNegativeInteger(value.inputTokens) ||
    typeof value.incomplete !== 'boolean'
  ) {
    return null;
  }
  const compaction =
    value.compaction === undefined ? undefined : cacheExpiryCarryCompaction(value.compaction, value.compactionsBefore);
  if (compaction === null) {
    return null;
  }
  return {
    ...(compaction ? { compaction } : {}),
    requestKey: value.requestKey,
    timestamp: value.timestamp,
    visibleTurnId: value.visibleTurnId,
    lifetime: value.lifetime,
    model: value.model,
    provider: value.provider,
    serviceTier: value.serviceTier,
    effort: value.effort ?? null,
    toolListVersion: value.toolListVersion ?? null,
    inferenceClass: value.inferenceClass,
    compactionsBefore: value.compactionsBefore,
    inputTokens: value.inputTokens,
    incomplete: value.incomplete,
  };
}

// A compaction the carry measures from comes after the request it keeps.
function cacheExpiryCarryCompaction(value: unknown, requestCompactions: number): CacheExpiryCarryCompaction | null {
  if (
    !record(value) ||
    !nonNegativeInteger(value.ordinal) ||
    value.ordinal <= requestCompactions ||
    !(value.at === null || timestamp(value.at)) ||
    !(value.prefixTokens === null || nonNegativeInteger(value.prefixTokens))
  ) {
    return null;
  }
  return { ordinal: value.ordinal, at: value.at, prefixTokens: value.prefixTokens };
}

function cacheExpiryReturn(value: unknown): CacheExpiryReturn | null {
  if (
    !record(value) ||
    !(value.timestamp === undefined || value.timestamp === null || timestamp(value.timestamp)) ||
    !cacheTier(value.lifetime) ||
    !nonNegativeInteger(value.gapMs) ||
    !(value.visibleTurnId === undefined || value.visibleTurnId === null || nonEmptyText(value.visibleTurnId)) ||
    !(value.requestKey === undefined || value.requestKey === null || nonEmptyText(value.requestKey)) ||
    !(value.firstPassUsage === undefined || usageCounts(value.firstPassUsage)) ||
    !(
      value.firstPassContextBand === undefined ||
      value.firstPassContextBand === null ||
      value.firstPassContextBand === 'short' ||
      value.firstPassContextBand === 'long'
    ) ||
    !(
      value.previousInputSide === undefined ||
      value.previousInputSide === null ||
      nonNegativeInteger(value.previousInputSide)
    )
  ) {
    return null;
  }
  const request = bucket(value.request);
  return request
    ? {
        lifetime: value.lifetime,
        timestamp: value.timestamp ?? null,
        gapMs: value.gapMs,
        request,
        visibleTurnId: value.visibleTurnId ?? null,
        requestKey: value.requestKey ?? null,
        previousInputSide: value.previousInputSide ?? null,
        ...(value.firstPassUsage === undefined
          ? {}
          : {
              firstPassUsage: { ...value.firstPassUsage },
              firstPassContextBand: value.firstPassContextBand,
            }),
      }
    : null;
}

function compactionFact(value: unknown): CompactionFact | null {
  if (
    !record(value) ||
    !nonNegativeInteger(value.ordinal) ||
    value.ordinal < 1 ||
    !(value.at === null || timestamp(value.at)) ||
    !nullableText(value.trigger) ||
    !(value.contextBefore === null || nonNegativeInteger(value.contextBefore)) ||
    !(value.contextAfter === null || nonNegativeInteger(value.contextAfter)) ||
    !nonNegativeInteger(value.requestsAfter) ||
    !(value.requestUsage === null || turnUsage(value.requestUsage)) ||
    !nullableText(value.requestModel) ||
    !nullableText(value.requestProvider) ||
    !nullableText(value.requestServiceTier) ||
    !(value.requestContextWindow === null || nonNegativeInteger(value.requestContextWindow)) ||
    // Without a following request, a compaction retains no later request count or context.
    (value.firstRequestAfter === null && (value.requestsAfter !== 0 || value.contextAfter !== null))
  ) {
    return null;
  }
  const first = value.firstRequestAfter === null ? null : bucket(value.firstRequestAfter);
  if (value.firstRequestAfter !== null && !first) {
    return null;
  }
  return {
    ordinal: value.ordinal,
    at: value.at,
    trigger: value.trigger,
    contextBefore: value.contextBefore,
    contextAfter: value.contextAfter,
    requestsAfter: value.requestsAfter,
    firstRequestAfter: first,
    requestUsage: value.requestUsage,
    requestModel: value.requestModel,
    requestProvider: value.requestProvider,
    requestServiceTier: value.requestServiceTier,
    requestContextWindow: value.requestContextWindow,
  };
}

function cacheExpiryFacts(value: unknown): CacheExpiryFacts | null {
  if (
    !record(value) ||
    !record(value.counts) ||
    !(['5m', '30m', '1h'] as const).every((tier) =>
      nonNegativeInteger((value.counts as Record<string, unknown>)[tier]),
    ) ||
    Object.keys(value.counts).length !== 3 ||
    !Array.isArray(value.returns) ||
    value.returns.length > RETAINED_CACHE_EXPIRY_RETURNS ||
    typeof value.truncated !== 'boolean' ||
    !(value.longestGapMs === null || nonNegativeInteger(value.longestGapMs)) ||
    !nonNegativeInteger(value.excluded) ||
    !nonNegativeInteger(value.unavailable)
  ) {
    return null;
  }
  const counts = value.counts as Record<'5m' | '30m' | '1h', number>;
  const returns = value.returns.map(cacheExpiryReturn);
  if (!returns.every((item): item is CacheExpiryReturn => item !== null)) {
    return null;
  }
  // Counts cover the complete scan. Returns retain its bounded tail.
  // A tail cannot exceed the count. An untruncated tail must equal it.
  const counted = counts['5m'] + counts['30m'] + counts['1h'];
  if (returns.length > counted || (!value.truncated && returns.length !== counted)) {
    return null;
  }
  return {
    counts: { '5m': counts['5m'], '30m': counts['30m'], '1h': counts['1h'] },
    returns,
    truncated: value.truncated,
    longestGapMs: value.longestGapMs,
    excluded: value.excluded,
    unavailable: value.unavailable,
  };
}

function cacheExpiryLedger(value: unknown): CacheExpiryLedger | null {
  if (
    !record(value) ||
    !Array.isArray(value.compactions) ||
    value.compactions.length > RETAINED_COMPACTIONS ||
    !nullableText(value.newestReturnKey) ||
    !nullableText(value.newestCompactionKey)
  ) {
    return null;
  }
  const facts = cacheExpiryFacts(value.facts);
  if (!facts) {
    return null;
  }
  const compactions = value.compactions.map(compactionFact);
  if (!compactions.every((item): item is CompactionFact => item !== null)) {
    return null;
  }
  const carry = value.carry === null ? null : cacheExpiryCarry(value.carry);
  if (value.carry !== null && !carry) {
    return null;
  }
  const displaced = value.displacedCompactions;
  if (displaced !== undefined && (!Array.isArray(displaced) || displaced.length > RETAINED_COMPACTIONS)) {
    return null;
  }
  const displacedCompactions = displaced?.map(compactionFact);
  if (displacedCompactions && !displacedCompactions.every((item): item is CompactionFact => item !== null)) {
    return null;
  }
  return {
    ...(displacedCompactions ? { displacedCompactions } : {}),
    facts,
    compactions,
    carry,
    newestReturnKey: value.newestReturnKey,
    newestCompactionKey: value.newestCompactionKey,
  };
}

function buckets(value: unknown): ProjectUsageBucket[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const parsed = value.map(bucket);
  if (!parsed.every((item): item is ProjectUsageBucket => item !== null)) {
    return null;
  }
  const keys = parsed.map((item) => projectUsageKey(item, item.localDate));
  return new Set(keys).size === keys.length ? parsed : null;
}

function spendRecord(
  value: unknown,
  workspace: string,
  currentParserGeneration: number,
  normalizeFile: (file: string) => string,
): SpendFileIndex | null {
  if (
    !record(value) ||
    !nonEmptyText(value.file) ||
    value.workspace !== workspace ||
    !nonNegativeInteger(value.size) ||
    !timestamp(value.mtimeMs) ||
    !nonNegativeInteger(value.offset) ||
    value.offset > value.size ||
    typeof value.trailing !== 'string' ||
    !timestamp(value.indexedAt) ||
    (value.turnCount !== undefined && value.turnCount !== null && !nonNegativeInteger(value.turnCount)) ||
    (value.compactionCount !== undefined &&
      value.compactionCount !== null &&
      !nonNegativeInteger(value.compactionCount)) ||
    (value.firstTurnAt !== undefined && value.firstTurnAt !== null && !timestamp(value.firstTurnAt)) ||
    (value.lastTurnAt !== undefined && value.lastTurnAt !== null && !timestamp(value.lastTurnAt)) ||
    (value.newestTurnStartedAt !== undefined &&
      value.newestTurnStartedAt !== null &&
      !timestamp(value.newestTurnStartedAt)) ||
    (value.outcome !== undefined && value.outcome !== null && !turnOutcome(value.outcome)) ||
    // A turn span requires both timestamps or neither.
    (value.firstTurnAt === undefined || value.firstTurnAt === null) !==
      (value.lastTurnAt === undefined || value.lastTurnAt === null) ||
    // The last turn timestamp cannot precede the first.
    (timestamp(value.firstTurnAt) && timestamp(value.lastTurnAt) && value.lastTurnAt < value.firstTurnAt) ||
    (value.parserGeneration !== undefined && !nonNegativeInteger(value.parserGeneration)) ||
    (value.complete !== undefined && typeof value.complete !== 'boolean') ||
    (value.scanOffset !== undefined && !nonNegativeInteger(value.scanOffset)) ||
    (value.missingAt !== undefined && !timestamp(value.missingAt)) ||
    (value.trailingBytes !== undefined && !validBase64(value.trailingBytes)) ||
    (value.pendingBytes !== undefined && !validBase64(value.pendingBytes)) ||
    (value.parserKind !== undefined && value.parserKind !== 'claude' && value.parserKind !== 'codex') ||
    (value.claudeRepeated !== undefined &&
      (value.parserKind !== 'claude' ||
        !validClaudeRepeatedState(value.claudeRepeated) ||
        value.claudeRepeated.through > value.offset))
  ) {
    return null;
  }
  const currentBuckets = buckets(value.buckets);
  const lifetimeBuckets = value.lifetimeBuckets === undefined ? undefined : buckets(value.lifetimeBuckets);
  if (!currentBuckets || lifetimeBuckets === null) {
    return null;
  }
  if (
    value.costStateProgress !== undefined &&
    (!validClaudeCostProgress(value.costStateProgress) ||
      !validBase64(value.costStateProgress.pending) ||
      Buffer.from(value.costStateProgress.pending, 'base64').length > value.costStateProgress.offset ||
      (value.costStateProgress.child < value.costStateProgress.dependencies.length &&
        value.costStateProgress.offset > value.costStateProgress.dependencies[value.costStateProgress.child].size) ||
      (value.costStateProgress.reducer !== undefined &&
        !claudeState(value.costStateProgress.reducer, Number.POSITIVE_INFINITY)))
  )
    return null;
  let parsedCostSupplement: ClaudeCostSupplement | undefined;
  if (value.costStateSupplement !== undefined) {
    const supplement = value.costStateSupplement;
    if (
      !record(supplement) ||
      !validCostStateAllocations(supplement.lifetimeAllocations) ||
      !validCostStateAllocations(supplement.datedAllocations)
    )
      return null;
    if (
      !record(supplement) ||
      !validCostStateDependencies(supplement.dependencies) ||
      supplement.identity !== costStateIdentity(supplement.dependencies) ||
      !Array.isArray(supplement.snapshots) ||
      supplement.snapshots.length > 256 ||
      !supplement.snapshots.every(nonEmptyText) ||
      !buckets(supplement.lifetime) ||
      !buckets(supplement.dated) ||
      !(supplement.lifetime as ProjectUsageBucket[]).every((item) => item.usageOrigin === 'claude-cost-state') ||
      !(supplement.dated as ProjectUsageBucket[]).every((item) => item.usageOrigin === 'claude-cost-state')
    )
      return null;
    parsedCostSupplement = {
      identity: costStateIdentity(supplement.dependencies),
      dependencies: supplement.dependencies,
      snapshots: supplement.snapshots,
      lifetime: buckets(supplement.lifetime)!,
      dated: buckets(supplement.dated)!,
      lifetimeAllocations: supplement.lifetimeAllocations,
      datedAllocations: supplement.datedAllocations,
    };
    if (!validCostStateMaterialization(parsedCostSupplement)) return null;
  }
  const expiry =
    value.cacheExpiry === undefined || value.cacheExpiry === null
      ? value.cacheExpiry
      : cacheExpiryLedger(value.cacheExpiry);
  if (expiry === null && value.cacheExpiry !== null && value.cacheExpiry !== undefined) {
    return null;
  }
  if (value.complete === false) {
    const scanOffset = value.scanOffset ?? value.offset;
    if (scanOffset < value.offset || scanOffset > value.size) {
      return null;
    }
    if (value.pendingBytes === undefined && scanOffset !== value.offset) {
      return null;
    }
    if (
      value.pendingBytes !== undefined &&
      Buffer.from(value.pendingBytes, 'base64').length !== scanOffset - value.offset
    ) {
      return null;
    }
    if (
      value.pendingBytes !== undefined &&
      value.trailingBytes !== undefined &&
      value.pendingBytes !== value.trailingBytes
    ) {
      return null;
    }
  } else {
    if (value.scanOffset !== undefined || value.pendingBytes !== undefined) {
      return null;
    }
    const trailingLength =
      value.trailingBytes === undefined
        ? Buffer.byteLength(value.trailing, 'utf8')
        : Buffer.from(value.trailingBytes, 'base64').length;
    if (trailingLength !== value.size - value.offset) {
      return null;
    }
  }
  const currentParser = value.parserGeneration === currentParserGeneration;
  const parserKind = value.parserKind;
  if (
    currentParser &&
    parserKind !== undefined &&
    value.missingAt === undefined &&
    !parserState(value.parserState, parserKind)
  ) {
    return null;
  }
  if (
    currentParser &&
    parserKind !== undefined &&
    value.parserState !== undefined &&
    !parserState(value.parserState, parserKind)
  ) {
    return null;
  }
  const persistedParserGeneration = currentParser && parserKind === undefined ? 0 : value.parserGeneration;
  return {
    file: normalizeFile(value.file),
    workspace: value.workspace,
    size: value.size,
    mtimeMs: value.mtimeMs,
    offset: value.offset,
    trailing: value.trailing,
    ...(value.trailingBytes === undefined ? {} : { trailingBytes: value.trailingBytes }),
    buckets: currentBuckets,
    ...(value.costStateProgress === undefined ? {} : { costStateProgress: value.costStateProgress }),
    ...(parsedCostSupplement === undefined ? {} : { costStateSupplement: parsedCostSupplement }),
    ...(lifetimeBuckets === undefined ? {} : { lifetimeBuckets }),
    ...(value.turnCount === undefined ? {} : { turnCount: value.turnCount }),
    ...(value.compactionCount === undefined ? {} : { compactionCount: value.compactionCount }),
    ...(value.firstTurnAt === undefined ? {} : { firstTurnAt: value.firstTurnAt }),
    ...(value.lastTurnAt === undefined ? {} : { lastTurnAt: value.lastTurnAt }),
    ...(value.newestTurnStartedAt === undefined ? {} : { newestTurnStartedAt: value.newestTurnStartedAt }),
    ...(value.outcome === undefined ? {} : { outcome: value.outcome }),
    ...(expiry === undefined ? {} : { cacheExpiry: expiry }),
    ...(typeof value.cacheExpiryChildPolicy === 'boolean'
      ? { cacheExpiryChildPolicy: value.cacheExpiryChildPolicy }
      : {}),
    ...(persistedParserGeneration === undefined ? {} : { parserGeneration: persistedParserGeneration }),
    ...(parserKind === undefined ? {} : { parserKind }),
    indexedAt: value.indexedAt,
    ...(currentParser && parserKind !== undefined && value.parserState !== undefined
      ? { parserState: value.parserState }
      : {}),
    ...(currentParser && value.claudeRepeated !== undefined ? { claudeRepeated: value.claudeRepeated } : {}),
    ...(value.complete === undefined ? {} : { complete: value.complete }),
    ...(value.scanOffset === undefined ? {} : { scanOffset: value.scanOffset }),
    ...(value.pendingBytes === undefined ? {} : { pendingBytes: value.pendingBytes }),
    ...(value.missingAt === undefined ? {} : { missingAt: value.missingAt }),
  };
}

export function parseSpendLedger(
  value: unknown,
  workspace: string,
  currentParserGeneration: number,
  normalizeFile: (file: string) => string,
): SpendLedger | null {
  if (!record(value) || value.workspace !== workspace || !Array.isArray(value.files)) {
    return null;
  }
  const parserGeneration = value.parserGeneration === undefined ? 0 : value.parserGeneration;
  if (!nonNegativeInteger(parserGeneration)) {
    return null;
  }
  const parsedByIndex = value.files.map((item) => spendRecord(item, workspace, currentParserGeneration, normalizeFile));
  const files: SpendFileIndex[] = [];
  const fileNames = new Set<string>();
  for (let index = 0; index < parsedByIndex.length; index++) {
    const item = parsedByIndex[index];
    if (!item || fileNames.has(item.file)) {
      return null;
    }
    fileNames.add(item.file);
    files.push(item);
  }
  const completeFiles: SpendFileIndex[] = [];
  const completeNames = new Set<string>();
  const addComplete = (item: SpendFileIndex | null): boolean => {
    if (!item || completeNames.has(item.file)) {
      return false;
    }
    completeNames.add(item.file);
    completeFiles.push(item);
    return true;
  };
  if (value.displayFiles !== undefined) {
    if (!Array.isArray(value.displayFiles)) {
      return null;
    }
    for (const entry of value.displayFiles) {
      if (typeof entry === 'number') {
        if (!nonNegativeInteger(entry) || entry >= parsedByIndex.length || !addComplete(parsedByIndex[entry])) {
          return null;
        }
      } else if (!addComplete(spendRecord(entry, workspace, currentParserGeneration, normalizeFile))) {
        return null;
      }
    }
  } else if (value.completeFiles !== undefined) {
    if (!Array.isArray(value.completeFiles)) {
      return null;
    }
    for (const entry of value.completeFiles) {
      const item = spendRecord(entry, workspace, currentParserGeneration, normalizeFile);
      if (item && !completeNames.has(item.file)) {
        addComplete(item);
      }
    }
  } else {
    for (const item of files) {
      if (item.complete !== false) {
        addComplete(item);
      }
    }
  }
  return { workspace, parserGeneration, files, completeFiles };
}
