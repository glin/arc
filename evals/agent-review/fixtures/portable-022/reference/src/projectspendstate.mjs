import { CODEX_USAGE_ASSOCIATION_LIMIT } from "./codex.mjs";
import { RETAINED_CACHE_EXPIRY_RETURNS, RETAINED_COMPACTIONS, RETAINED_REQUESTS } from "./parserstate.mjs";
const CLAUDE_STATE_KEYS = {
  seenRequestKeys: true,
  closedTurns: true,
  openTurn: true,
  openTurnAnswered: true,
  compactionCount: true,
  recentCompactions: true,
  pendingCompactionTrigger: true,
  pendingCompactionSize: true,
  unsizedCompaction: true,
  lastRequest: true,
  firstRequestCacheRead: true,
  toolListNames: true,
  toolListVersion: true,
  visibleTurns: true,
  firstTurnAt: true,
  currentTurnStartedAt: true,
  currentTurnEndedAt: true,
  currentTurnOutcome: true,
  requestEvents: true,
  modelProfile: true
};
const CODEX_STATE_KEYS = {
  provider: true,
  openingTimestamp: true,
  openingSessionId: true,
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
  firstTurnAt: true,
  lastTurnAt: true,
  currentTurnStartedAt: true,
  currentTurnEndedAt: true,
  currentTurnOutcome: true,
  lastTurnStartedAt: true,
  lastTurnOutcome: true
};
function record(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function nonEmptyText(value) {
  return typeof value === "string" && value.length > 0;
}
function nullableText(value) {
  return value === null || typeof value === "string";
}
function nonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function timestamp(value) {
  return nonNegative(value) && !Number.isNaN(new Date(value).getTime());
}
function turnOutcome(value) {
  return record(value) && typeof value.finished === "boolean" && typeof value.error === "boolean" && typeof value.interrupted === "boolean" && timestamp(value.endedAt) && (!Object.prototype.hasOwnProperty.call(value, "processEndedAt") || timestamp(value.processEndedAt)) && (!Object.prototype.hasOwnProperty.call(value, "openChildren") || Array.isArray(value.openChildren) && value.openChildren.every(nonEmptyText));
}
function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value;
}
function validBase64(value) {
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}
function usageCounts(value) {
  if (!record(value)) {
    return false;
  }
  return ["input", "cacheWrite1h", "cacheWrite5m", "cacheRead", "output", "thinking"].every(
    (key) => nonNegativeInteger(value[key])
  ) && (value.requests === void 0 || nonNegativeInteger(value.requests)) && (value.cacheWrite30m === void 0 || nonNegativeInteger(value.cacheWrite30m));
}
function turnUsage(value) {
  const bands = record(value) ? value.byContextBand : void 0;
  if (!usageCounts(value)) {
    return false;
  }
  if (bands === void 0) {
    return true;
  }
  if (!record(bands)) {
    return false;
  }
  return ["short", "long"].every((band) => bands[band] === void 0 || usageCounts(bands[band]));
}
function transcriptUsageEvent(value, expectedAgent) {
  if (!record(value)) {
    return false;
  }
  return timestamp(value.timestamp) && value.agent === expectedAgent && nullableText(value.provider) && nullableText(value.model) && (value.contextWindow === null || nonNegativeInteger(value.contextWindow)) && (value.contextBand === null || value.contextBand === "short" || value.contextBand === "long") && (value.billingClass === "metered" || value.billingClass === "subscription" || value.billingClass === "unknown") && (value.inferenceClass === null || value.inferenceClass === "in-region" || value.inferenceClass === "geo" || value.inferenceClass === "global" || value.inferenceClass === "bedrock-regional") && nullableText(value.serviceTier) && (value.reportedCost === null || nonNegative(value.reportedCost)) && (value.reportedCostBasis === void 0 || nullableText(value.reportedCostBasis)) && (value.linkedSessionId === void 0 || nullableText(value.linkedSessionId)) && (value.linkedInvocationId === void 0 || nullableText(value.linkedInvocationId)) && (value.unclassifiedCacheWrite === void 0 || nonNegativeInteger(value.unclassifiedCacheWrite)) && (value.incomplete === void 0 || typeof value.incomplete === "boolean") && (value.requestCountExact === void 0 || value.requestCountExact === false) && (value.visibleTurnId === void 0 || nullableText(value.visibleTurnId)) && (value.cacheLifetime === void 0 || value.cacheLifetime === null || value.cacheLifetime === "5m" || value.cacheLifetime === "30m" || value.cacheLifetime === "1h") && (value.compactionsBefore === void 0 || nonNegativeInteger(value.compactionsBefore)) && turnUsage(value.usage) && nonEmptyText(value.requestKey);
}
function dictionary(value, entry) {
  return record(value) && Object.entries(value).every(([key, item]) => nonEmptyText(key) && entry(item, key));
}
function onlyKeys(value, keys) {
  return Object.keys(value).every((key) => keys[key]);
}
function trueDictionary(value) {
  return dictionary(value, (item) => item === true);
}
function compactionSize(value) {
  return value === void 0 || value === null || record(value) && nonNegative(value.before) && nonNegative(value.after) && nonNegative(value.at) && nonNegative(value.durationMs);
}
function unsizedCompaction(value) {
  return value === void 0 || value === null || record(value) && nonNegativeInteger(value.ordinal) && nonNegative(value.at) && value.previous !== void 0 && lastClaudeRequest(value.previous) && (value.summaryChars === void 0 || nonNegative(value.summaryChars));
}
function lastClaudeRequest(value) {
  return value === void 0 || value === null || record(value) && nonNegative(value.tokens) && (value.cacheRead === void 0 || nonNegative(value.cacheRead)) && (value.cacheWrite === void 0 || nonNegative(value.cacheWrite)) && (value.at === null || timestamp(value.at)) && (value.lifetime === null || value.lifetime === "5m" || value.lifetime === "30m" || value.lifetime === "1h") && nullableText(value.model) && (value.inferenceClass === null || value.inferenceClass === "in-region" || value.inferenceClass === "geo" || value.inferenceClass === "global" || value.inferenceClass === "bedrock-regional") && nullableText(value.serviceTier);
}
function claudeState(value) {
  if (!record(value) || !onlyKeys(value, CLAUDE_STATE_KEYS) || !Array.isArray(value.seenRequestKeys) || !value.seenRequestKeys.every(nonEmptyText) || new Set(value.seenRequestKeys).size !== value.seenRequestKeys.length || !(value.pendingCompactionTrigger === void 0 || nullableText(value.pendingCompactionTrigger)) || !compactionSize(value.pendingCompactionSize) || !unsizedCompaction(value.unsizedCompaction) || !lastClaudeRequest(value.lastRequest) || !(value.firstRequestCacheRead === void 0 || value.firstRequestCacheRead === null || nonNegative(value.firstRequestCacheRead)) || !(value.toolListNames === void 0 || Array.isArray(value.toolListNames) && value.toolListNames.every(nonEmptyText)) || !(value.toolListVersion === void 0 || nonNegativeInteger(value.toolListVersion)) || !(value.modelProfile === void 0 || nullableText(value.modelProfile)) || !nonNegativeInteger(value.closedTurns) || typeof value.openTurn !== "boolean" || typeof value.openTurnAnswered !== "boolean" || !nonNegativeInteger(value.compactionCount) || !reducerCompactions(value.recentCompactions, value.compactionCount) || !nonNegativeInteger(value.visibleTurns) || !(value.firstTurnAt === null || timestamp(value.firstTurnAt)) || !(value.currentTurnStartedAt === null || timestamp(value.currentTurnStartedAt)) || !(value.currentTurnEndedAt === null || timestamp(value.currentTurnEndedAt)) || !(value.currentTurnOutcome === null || turnOutcome(value.currentTurnOutcome))) {
    return false;
  }
  if (value.requestEvents === void 0) {
    return true;
  }
  if (!record(value.requestEvents) || Object.keys(value.requestEvents).length > RETAINED_REQUESTS) {
    return false;
  }
  const seen = new Set(value.seenRequestKeys);
  return dictionary(
    value.requestEvents,
    (item, key) => transcriptUsageEvent(item, "claude") && item.requestKey === key && seen.has(key)
  );
}
function nullableTextDictionary(value) {
  return dictionary(value, nullableText);
}
function nullableCountDictionary(value) {
  return dictionary(value, (item) => item === null || nonNegativeInteger(item));
}
function boundedIdentityList(value) {
  return Array.isArray(value) && value.length <= CODEX_USAGE_ASSOCIATION_LIMIT && value.every(nonEmptyText) && new Set(value).size === value.length;
}
function sameIdentities(value, identities) {
  const keys = Object.keys(value);
  return keys.length === identities.length && keys.every((key) => identities.includes(key));
}
function codexState(value) {
  if (!record(value) || !onlyKeys(value, CODEX_STATE_KEYS) || !nullableText(value.provider) || !nullableText(value.reasoningEffort) || !(value.openingTimestamp === null || timestamp(value.openingTimestamp)) || !nullableText(value.openingSessionId) || !nullableText(value.agentPath) || typeof value.foreignSessionMeta !== "boolean" || !nullableText(value.currentTurnId) || typeof value.currentTurnCopied !== "boolean" || !boundedIdentityList(value.recentTurnIds) || !trueDictionary(value.seenTurnIds) || !dictionary(
    value.seenTurnOffsets,
    (item, key) => nonNegativeInteger(item) && value.seenTurnIds[key] === true
  ) || !Array.isArray(value.legacyReplayLinks) || value.legacyReplayLinks.length > CODEX_USAGE_ASSOCIATION_LIMIT || !value.legacyReplayLinks.every(
    (item) => record(item) && nonEmptyText(item.id) && nonNegativeInteger(item.evidenceOffset) && nonNegativeInteger(item.replayOffset)
  ) || typeof value.replayResetRequired !== "boolean" || !trueDictionary(value.copiedTurnIds) || !trueDictionary(value.datedCopiedTurnIds) || !trueDictionary(value.countedTurnIds) || !nullableTextDictionary(value.turnModels) || !nullableTextDictionary(value.turnEfforts) || !nullableCountDictionary(value.turnWindows) || !nullableText(value.planType) || typeof value.planKnown !== "boolean" || !nullableText(value.serviceTier) || !nonNegativeInteger(value.requestNumber) || !(value.lastUsageSnapshot === null || record(value.lastUsageSnapshot) && nonEmptyText(value.lastUsageSnapshot.turnId) && Array.isArray(value.lastUsageSnapshot.last) && value.lastUsageSnapshot.last.length === 6 && value.lastUsageSnapshot.last.every(nonNegativeInteger) && Array.isArray(value.lastUsageSnapshot.total) && value.lastUsageSnapshot.total.length === 6 && value.lastUsageSnapshot.total.every(nonNegativeInteger)) || !dictionary(
    value.pendingRequests,
    (items) => Array.isArray(items) && items.every((item) => transcriptUsageEvent(item, "codex"))
  ) || !boundedIdentityList(value.pendingRequestKeys) || !dictionary(
    value.pendingRequestSources,
    (item) => record(item) && nonNegativeInteger(item.start) && nonNegativeInteger(item.end) && item.end >= item.start
  ) || !boundedIdentityList(value.recentClaudeInvocationIds) || !trueDictionary(value.seenClaudeInvocations) || !boundedIdentityList(value.recentClaudeCommandIds) || !trueDictionary(value.seenClaudeCommands) || !boundedIdentityList(value.pendingClaudeResultIds) || !dictionary(value.pendingClaudeResults, (item) => transcriptUsageEvent(item, "claude")) || !nonNegativeInteger(value.closedTurns) || typeof value.currentTurnDidSomething !== "boolean" || typeof value.currentTurnCompleted !== "boolean" || !nonNegativeInteger(value.compactionCount) || !reducerCompactions(value.recentCompactions, value.compactionCount) || !dictionary(
    value.compactionTurnOrdinals,
    (ordinals) => Array.isArray(ordinals) && ordinals.every(nonNegativeInteger)
  ) || !pendingCompactionBilling(value.pendingCompactionBilling, value.compactionCount, value.recentCompactions) || !(value.firstTurnAt === null || timestamp(value.firstTurnAt)) || !(value.lastTurnAt === null || timestamp(value.lastTurnAt)) || !(value.currentTurnStartedAt === null || timestamp(value.currentTurnStartedAt)) || !(value.currentTurnEndedAt === null || timestamp(value.currentTurnEndedAt)) || !(value.currentTurnOutcome === null || turnOutcome(value.currentTurnOutcome)) || !(value.lastTurnStartedAt === null || timestamp(value.lastTurnStartedAt)) || !(value.lastTurnOutcome === null || turnOutcome(value.lastTurnOutcome))) {
    return false;
  }
  if (!sameIdentities(value.seenTurnIds, value.recentTurnIds) || !sameIdentities(value.seenClaudeInvocations, value.recentClaudeInvocationIds) || !sameIdentities(value.seenClaudeCommands, value.recentClaudeCommandIds) || !sameIdentities(value.pendingClaudeResults, value.pendingClaudeResultIds)) {
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
    value.pendingRequests
  ]) {
    if (Object.keys(association).some((key) => !recentTurnIds.has(key))) {
      return false;
    }
  }
  if (value.legacyReplayLinks.some((link) => !recentTurnIds.has(link.id))) {
    return false;
  }
  for (const key of Object.keys(value.datedCopiedTurnIds)) {
    if (value.copiedTurnIds[key] !== true) {
      return false;
    }
  }
  const currentTurnId = value.currentTurnId;
  if (currentTurnId !== null && value.seenTurnIds[currentTurnId] !== true) {
    return false;
  }
  const currentTurnIsCopied = currentTurnId !== null && value.copiedTurnIds[currentTurnId] === true;
  if (value.currentTurnCopied !== currentTurnIsCopied) {
    return false;
  }
  const pendingKeys = /* @__PURE__ */ new Set();
  for (const items of Object.values(value.pendingRequests)) {
    for (const item of items) {
      if (item.model !== null || pendingKeys.has(item.requestKey)) {
        return false;
      }
      pendingKeys.add(item.requestKey);
    }
  }
  if (pendingKeys.size !== value.pendingRequestKeys.length || value.pendingRequestKeys.some((key) => !pendingKeys.has(key))) {
    return false;
  }
  return Object.keys(value.pendingRequestSources).every((key) => pendingKeys.has(key));
}
function parserState(value, parserKind) {
  return parserKind === "claude" ? claudeState(value) : codexState(value);
}
function projectUsageKey(value, date) {
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
    value.reportedCost === null ? "estimated" : "reported",
    value.reportedCostBasis ?? null,
    value.linkedSessionId ?? null,
    value.linkedInvocationId ?? null,
    value.incomplete === true,
    value.requestCountExact === false,
    value.compactionEstimate === true
  ]);
}
function bucket(value) {
  if (!record(value) || !validDate(value.localDate) || !nonEmptyText(value.agent) || !nullableText(value.provider) || !nullableText(value.model) || !(value.contextWindow === null || nonNegativeInteger(value.contextWindow)) || !(value.contextBand === null || value.contextBand === "short" || value.contextBand === "long") || !(value.billingClass === "metered" || value.billingClass === "subscription" || value.billingClass === "unknown") || !(value.inferenceClass === null || value.inferenceClass === "in-region" || value.inferenceClass === "geo" || value.inferenceClass === "global" || value.inferenceClass === "bedrock-regional") || !nullableText(value.serviceTier) || !(value.reportedCost === null || nonNegative(value.reportedCost)) || value.reportedCostBasis !== void 0 && !nullableText(value.reportedCostBasis) || value.linkedSessionId !== void 0 && !nullableText(value.linkedSessionId) || value.linkedInvocationId !== void 0 && !nullableText(value.linkedInvocationId) || value.unclassifiedCacheWrite !== void 0 && !nonNegativeInteger(value.unclassifiedCacheWrite) || value.incomplete !== void 0 && typeof value.incomplete !== "boolean" || value.requestCountExact !== void 0 && value.requestCountExact !== false || value.compactionEstimate !== void 0 && value.compactionEstimate !== true || !usageCounts(value.usage) || !nonNegativeInteger(value.requests)) {
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
    ...value.reportedCostBasis === void 0 ? {} : { reportedCostBasis: value.reportedCostBasis },
    ...value.linkedSessionId === void 0 ? {} : { linkedSessionId: value.linkedSessionId },
    ...value.linkedInvocationId === void 0 ? {} : { linkedInvocationId: value.linkedInvocationId },
    ...value.unclassifiedCacheWrite === void 0 ? {} : { unclassifiedCacheWrite: value.unclassifiedCacheWrite },
    ...value.incomplete === void 0 ? {} : { incomplete: value.incomplete },
    ...value.requestCountExact === false ? { requestCountExact: false } : {},
    ...value.compactionEstimate === true ? { compactionEstimate: true } : {},
    usage: {
      requests: value.usage.requests,
      input: value.usage.input,
      cacheWrite1h: value.usage.cacheWrite1h,
      cacheWrite5m: value.usage.cacheWrite5m,
      cacheWrite30m: value.usage.cacheWrite30m,
      cacheRead: value.usage.cacheRead,
      output: value.usage.output,
      thinking: value.usage.thinking
    },
    requests: value.requests
  };
}
function reducerCompactions(value, compactionCount) {
  if (!Array.isArray(value) || value.length > RETAINED_COMPACTIONS) {
    return false;
  }
  if (!value.every(
    (item) => record(item) && nonNegativeInteger(item.ordinal) && item.ordinal >= 1 && (item.at === null || timestamp(item.at)) && nullableText(item.trigger) && (item.requestUsage === null || turnUsage(item.requestUsage)) && nullableText(item.requestModel) && nullableText(item.requestProvider) && nullableText(item.requestServiceTier) && (item.requestContextWindow === null || nonNegativeInteger(item.requestContextWindow))
  )) {
    return false;
  }
  const ordinals = value.map((item) => item.ordinal);
  if (ordinals.some((ordinal, at) => at > 0 && ordinal !== ordinals[at - 1] + 1)) {
    return false;
  }
  if (!nonNegativeInteger(compactionCount)) {
    return true;
  }
  return value.length === Math.min(compactionCount, RETAINED_COMPACTIONS) && (value.length === 0 || ordinals[ordinals.length - 1] === compactionCount);
}
function pendingCompactionBilling(value, compactionCount, compactions) {
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
  return record(held) && held.requestUsage !== null;
}
function cacheTier(value) {
  return value === "5m" || value === "30m" || value === "1h";
}
function cacheExpiryCarry(value) {
  if (!record(value) || !nullableText(value.requestKey) || !nonNegative(value.timestamp) || !nullableText(value.visibleTurnId) || !(value.lifetime === null || cacheTier(value.lifetime)) || !nullableText(value.model) || !nullableText(value.provider) || !nullableText(value.serviceTier) || !(value.effort === void 0 || nullableText(value.effort)) || !(value.toolListVersion === void 0 || value.toolListVersion === null || nonNegativeInteger(value.toolListVersion)) || !(value.inferenceClass === null || value.inferenceClass === "in-region" || value.inferenceClass === "geo" || value.inferenceClass === "global" || value.inferenceClass === "bedrock-regional") || !nonNegativeInteger(value.compactionsBefore) || !nonNegativeInteger(value.inputTokens) || typeof value.incomplete !== "boolean") {
    return null;
  }
  return {
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
    incomplete: value.incomplete
  };
}
function cacheExpiryReturn(value) {
  if (!record(value) || !cacheTier(value.lifetime) || !nonNegativeInteger(value.gapMs)) {
    return null;
  }
  const request = bucket(value.request);
  return request ? { lifetime: value.lifetime, gapMs: value.gapMs, request } : null;
}
function compactionFact(value) {
  if (!record(value) || !nonNegativeInteger(value.ordinal) || value.ordinal < 1 || !(value.at === null || timestamp(value.at)) || !nullableText(value.trigger) || !(value.contextBefore === null || nonNegativeInteger(value.contextBefore)) || !(value.contextAfter === null || nonNegativeInteger(value.contextAfter)) || !nonNegativeInteger(value.requestsAfter) || !(value.requestUsage === null || turnUsage(value.requestUsage)) || !nullableText(value.requestModel) || !nullableText(value.requestProvider) || !nullableText(value.requestServiceTier) || !(value.requestContextWindow === null || nonNegativeInteger(value.requestContextWindow)) || // A compaction no request followed keeps no later request and no context after it.
  value.firstRequestAfter === null && (value.requestsAfter !== 0 || value.contextAfter !== null)) {
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
    requestContextWindow: value.requestContextWindow
  };
}
function cacheExpiryFacts(value) {
  if (!record(value) || !record(value.counts) || !["5m", "30m", "1h"].every(
    (tier) => nonNegativeInteger(value.counts[tier])
  ) || Object.keys(value.counts).length !== 3 || !Array.isArray(value.returns) || value.returns.length > RETAINED_CACHE_EXPIRY_RETURNS || typeof value.truncated !== "boolean" || !(value.longestGapMs === null || nonNegativeInteger(value.longestGapMs)) || !nonNegativeInteger(value.excluded) || !nonNegativeInteger(value.unavailable)) {
    return null;
  }
  const counts = value.counts;
  const returns = value.returns.map(cacheExpiryReturn);
  if (!returns.every((item) => item !== null)) {
    return null;
  }
  const counted = counts["5m"] + counts["30m"] + counts["1h"];
  if (returns.length > counted || !value.truncated && returns.length !== counted) {
    return null;
  }
  return {
    counts: { "5m": counts["5m"], "30m": counts["30m"], "1h": counts["1h"] },
    returns,
    truncated: value.truncated,
    longestGapMs: value.longestGapMs,
    excluded: value.excluded,
    unavailable: value.unavailable
  };
}
function cacheExpiryLedger(value) {
  if (!record(value) || !Array.isArray(value.compactions) || value.compactions.length > RETAINED_COMPACTIONS || !nullableText(value.newestReturnKey) || !nullableText(value.newestCompactionKey)) {
    return null;
  }
  const facts = cacheExpiryFacts(value.facts);
  if (!facts) {
    return null;
  }
  const compactions = value.compactions.map(compactionFact);
  if (!compactions.every((item) => item !== null)) {
    return null;
  }
  const carry = value.carry === null ? null : cacheExpiryCarry(value.carry);
  if (value.carry !== null && !carry) {
    return null;
  }
  return {
    facts,
    compactions,
    carry,
    newestReturnKey: value.newestReturnKey,
    newestCompactionKey: value.newestCompactionKey
  };
}
function buckets(value) {
  if (!Array.isArray(value)) {
    return null;
  }
  const parsed = value.map(bucket);
  if (!parsed.every((item) => item !== null)) {
    return null;
  }
  const keys = parsed.map((item) => projectUsageKey(item, item.localDate));
  return new Set(keys).size === keys.length ? parsed : null;
}
function spendRecord(value, workspace, currentParserGeneration, normalizeFile) {
  if (!record(value) || !nonEmptyText(value.file) || value.workspace !== workspace || !nonNegativeInteger(value.size) || !timestamp(value.mtimeMs) || !nonNegativeInteger(value.offset) || value.offset > value.size || typeof value.trailing !== "string" || !timestamp(value.indexedAt) || value.turnCount !== void 0 && value.turnCount !== null && !nonNegativeInteger(value.turnCount) || value.compactionCount !== void 0 && value.compactionCount !== null && !nonNegativeInteger(value.compactionCount) || value.firstTurnAt !== void 0 && value.firstTurnAt !== null && !timestamp(value.firstTurnAt) || value.lastTurnAt !== void 0 && value.lastTurnAt !== null && !timestamp(value.lastTurnAt) || value.newestTurnStartedAt !== void 0 && value.newestTurnStartedAt !== null && !timestamp(value.newestTurnStartedAt) || value.outcome !== void 0 && value.outcome !== null && !turnOutcome(value.outcome) || // The two timestamps stand for one span, so a record naming only one of them is broken.
  (value.firstTurnAt === void 0 || value.firstTurnAt === null) !== (value.lastTurnAt === void 0 || value.lastTurnAt === null) || // A last turn earlier than the first turn is not a span that ever happened.
  timestamp(value.firstTurnAt) && timestamp(value.lastTurnAt) && value.lastTurnAt < value.firstTurnAt || value.parserGeneration !== void 0 && !nonNegativeInteger(value.parserGeneration) || value.complete !== void 0 && typeof value.complete !== "boolean" || value.scanOffset !== void 0 && !nonNegativeInteger(value.scanOffset) || value.missingAt !== void 0 && !timestamp(value.missingAt) || value.trailingBytes !== void 0 && !validBase64(value.trailingBytes) || value.pendingBytes !== void 0 && !validBase64(value.pendingBytes) || value.parserKind !== void 0 && value.parserKind !== "claude" && value.parserKind !== "codex") {
    return null;
  }
  const currentBuckets = buckets(value.buckets);
  const lifetimeBuckets = value.lifetimeBuckets === void 0 ? void 0 : buckets(value.lifetimeBuckets);
  if (!currentBuckets || lifetimeBuckets === null) {
    return null;
  }
  const expiry = value.cacheExpiry === void 0 || value.cacheExpiry === null ? value.cacheExpiry : cacheExpiryLedger(value.cacheExpiry);
  if (expiry === null && value.cacheExpiry !== null && value.cacheExpiry !== void 0) {
    return null;
  }
  if (value.complete === false) {
    const scanOffset = value.scanOffset ?? value.offset;
    if (scanOffset < value.offset || scanOffset > value.size) {
      return null;
    }
    if (value.pendingBytes === void 0 && scanOffset !== value.offset) {
      return null;
    }
    if (value.pendingBytes !== void 0 && Buffer.from(value.pendingBytes, "base64").length !== scanOffset - value.offset) {
      return null;
    }
    if (value.pendingBytes !== void 0 && value.trailingBytes !== void 0 && value.pendingBytes !== value.trailingBytes) {
      return null;
    }
  } else {
    if (value.scanOffset !== void 0 || value.pendingBytes !== void 0) {
      return null;
    }
    const trailingLength = value.trailingBytes === void 0 ? Buffer.byteLength(value.trailing, "utf8") : Buffer.from(value.trailingBytes, "base64").length;
    if (trailingLength !== value.size - value.offset) {
      return null;
    }
  }
  const currentParser = value.parserGeneration === currentParserGeneration;
  const parserKind = value.parserKind;
  if (currentParser && parserKind !== void 0 && value.missingAt === void 0 && !parserState(value.parserState, parserKind)) {
    return null;
  }
  if (currentParser && parserKind !== void 0 && value.parserState !== void 0 && !parserState(value.parserState, parserKind)) {
    return null;
  }
  const persistedParserGeneration = currentParser && parserKind === void 0 ? 0 : value.parserGeneration;
  return {
    file: normalizeFile(value.file),
    workspace: value.workspace,
    size: value.size,
    mtimeMs: value.mtimeMs,
    offset: value.offset,
    trailing: value.trailing,
    ...value.trailingBytes === void 0 ? {} : { trailingBytes: value.trailingBytes },
    buckets: currentBuckets,
    ...lifetimeBuckets === void 0 ? {} : { lifetimeBuckets },
    ...value.turnCount === void 0 ? {} : { turnCount: value.turnCount },
    ...value.compactionCount === void 0 ? {} : { compactionCount: value.compactionCount },
    ...value.firstTurnAt === void 0 ? {} : { firstTurnAt: value.firstTurnAt },
    ...value.lastTurnAt === void 0 ? {} : { lastTurnAt: value.lastTurnAt },
    ...value.newestTurnStartedAt === void 0 ? {} : { newestTurnStartedAt: value.newestTurnStartedAt },
    ...value.outcome === void 0 ? {} : { outcome: value.outcome },
    ...expiry === void 0 ? {} : { cacheExpiry: expiry },
    ...persistedParserGeneration === void 0 ? {} : { parserGeneration: persistedParserGeneration },
    ...parserKind === void 0 ? {} : { parserKind },
    indexedAt: value.indexedAt,
    ...currentParser && parserKind !== void 0 && value.parserState !== void 0 ? { parserState: value.parserState } : {},
    ...value.complete === void 0 ? {} : { complete: value.complete },
    ...value.scanOffset === void 0 ? {} : { scanOffset: value.scanOffset },
    ...value.pendingBytes === void 0 ? {} : { pendingBytes: value.pendingBytes },
    ...value.missingAt === void 0 ? {} : { missingAt: value.missingAt }
  };
}
function parseSpendLedger(value, workspace, currentParserGeneration, normalizeFile) {
  if (!record(value) || value.workspace !== workspace || !Array.isArray(value.files)) {
    return null;
  }
  const parserGeneration = value.parserGeneration === void 0 ? 0 : value.parserGeneration;
  if (!nonNegativeInteger(parserGeneration)) {
    return null;
  }
  const parsedByIndex = value.files.map((item) => spendRecord(item, workspace, currentParserGeneration, normalizeFile));
  const files = [];
  const fileNames = /* @__PURE__ */ new Set();
  for (let index = 0; index < parsedByIndex.length; index++) {
    const item = parsedByIndex[index];
    if (!item || fileNames.has(item.file)) {
      return null;
    }
    fileNames.add(item.file);
    files.push(item);
  }
  const completeFiles = [];
  const completeNames = /* @__PURE__ */ new Set();
  const addComplete = (item) => {
    if (!item || completeNames.has(item.file)) {
      return false;
    }
    completeNames.add(item.file);
    completeFiles.push(item);
    return true;
  };
  if (value.displayFiles !== void 0) {
    if (!Array.isArray(value.displayFiles)) {
      return null;
    }
    for (const entry of value.displayFiles) {
      if (typeof entry === "number") {
        if (!nonNegativeInteger(entry) || entry >= parsedByIndex.length || !addComplete(parsedByIndex[entry])) {
          return null;
        }
      } else if (!addComplete(spendRecord(entry, workspace, currentParserGeneration, normalizeFile))) {
        return null;
      }
    }
  } else if (value.completeFiles !== void 0) {
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
export {
  parseSpendLedger,
  projectUsageKey
};
