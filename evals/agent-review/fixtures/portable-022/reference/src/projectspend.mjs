import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomically } from "./atomicfile.mjs";
import { RETAINED_CACHE_EXPIRY_RETURNS, RETAINED_COMPACTIONS, withRetainedRequestEvents } from "./parserstate.mjs";
import {
  cacheLapsedBy,
  cacheLifetimeFor,
  contextBandForRequest,
  hasRequestContextPricing,
  quoteUsage,
  BEDROCK_LIST_COST_BASIS
} from "./pricing.mjs";
import { parseSpendLedger, projectUsageKey } from "./projectspendstate.mjs";
import { normalizeFsPath } from "./transcript.mjs";
class SessionFiguresCache {
  files = null;
  sources = null;
  generation = -1;
  // Each dispatched source a held session consulted `pending` for, its record, and the answer.
  watched = /* @__PURE__ */ new Map();
  groups = /* @__PURE__ */ new Map();
  held = /* @__PURE__ */ new Map();
  value;
  read(files, sources, calculate, assemble, pending = () => true) {
    const heldFiles = this.files;
    if (heldFiles && !this.pendingMoved(pending) && sources === this.sources && spendFileNormalizationGeneration === this.generation && files.length === heldFiles.length && files.every((record, at) => record === heldFiles[at])) {
      return this.value;
    }
    if (sources !== this.sources) {
      this.groups = sessionSourceGroups(sources);
    }
    const records = new Map(files.map((record) => [spendRecordKey(record), record]));
    const next = /* @__PURE__ */ new Map();
    const watched = /* @__PURE__ */ new Map();
    let moved = heldFiles === null;
    for (const [sessionId, group] of this.groups) {
      const keys = group.sources.map(
        (source, at) => records.has(group.lexical[at]) ? group.lexical[at] : normalizeSpendFile(source.file)
      );
      const found = keys.map((key) => records.get(key));
      let waiting = null;
      for (let at = 0; at < keys.length; at++) {
        if (group.sources[at].dispatchedFrom !== void 0 && spendRecordAwaitsLedger(found[at])) {
          const answer = pending(keys[at], found[at]);
          (waiting ??= /* @__PURE__ */ new Map()).set(keys[at], answer);
          watched.set(keys[at], { record: found[at], answer });
        }
      }
      const previous = this.held.get(sessionId);
      if (previous && sameSessionSources(previous.sources, group.sources) && found.every((record, at) => record === previous.records[at]) && sameWaiting(previous.waiting, waiting)) {
        next.set(sessionId, previous);
        continue;
      }
      moved = true;
      const own = [...new Set(found.filter((record) => record !== void 0))];
      const held = waiting;
      next.set(sessionId, {
        sources: group.sources,
        records: found,
        waiting: held,
        value: calculate(sessionId, own, group.sources, (file, record) => held?.get(file) ?? pending(file, record))
      });
    }
    moved ||= next.size !== this.held.size;
    this.held = next;
    this.watched = watched;
    this.files = files.slice();
    this.sources = sources;
    this.generation = spendFileNormalizationGeneration;
    if (moved) {
      this.value = assemble(
        new Map(
          [...next].flatMap(
            ([sessionId, entry]) => entry.value === void 0 ? [] : [[sessionId, entry.value]]
          )
        )
      );
    }
    return this.value;
  }
  // The answers the last read took. A read replaces the map and never edits it, so a caller can
  // hold it as the answers one drawing used.
  answers() {
    return this.watched;
  }
  // Whether `pending` now answers differently for a source in `since`, by default the answers
  // the last read took. The next read then moves a figure that no file change moved.
  pendingMoved(pending, since = this.watched) {
    for (const [file, { record, answer }] of since) {
      if (pending(file, record) !== answer) {
        return true;
      }
    }
    return false;
  }
}
function sameWaiting(held, next) {
  return (held?.size ?? 0) === (next?.size ?? 0) && [...next ?? []].every(([file, answer]) => held?.get(file) === answer);
}
function spendRecordWhole(record) {
  return !!record && record.complete !== false && !record.trailingBytes && !record.trailing && Array.isArray(record.lifetimeBuckets);
}
function spendRecordWriting(record) {
  return !!record && record.missingAt === void 0 && record.complete !== false && Array.isArray(record.lifetimeBuckets) && !!(record.trailing || record.trailingBytes);
}
function spendRecordRunning(record) {
  const outcome = record?.outcome;
  return spendRecordWhole(record) && record.missingAt === void 0 && !!outcome && !outcome.finished && !outcome.interrupted && !outcome.error && outcome.processEndedAt === void 0;
}
function spendRecordAwaitsLedger(record) {
  return !spendRecordWhole(record) || spendRecordRunning(record);
}
function spendSourceHeld(record, queued, cutoff) {
  return queued || (spendRecordWriting(record) || spendRecordRunning(record)) && (cutoff === null || record.mtimeMs >= cutoff);
}
const spendRecordKeys = /* @__PURE__ */ new WeakMap();
function spendRecordKey(record) {
  let key = spendRecordKeys.get(record);
  if (key === void 0) {
    key = normalizeWorkspace(record.file);
    spendRecordKeys.set(record, key);
  }
  return key;
}
function sessionSourceGroups(sources) {
  const groups = /* @__PURE__ */ new Map();
  for (const source of sources) {
    const group = groups.get(source.sessionId) ?? { sources: [], lexical: [] };
    group.sources.push(source);
    group.lexical.push(normalizeWorkspace(source.file));
    groups.set(source.sessionId, group);
  }
  return groups;
}
function sameSessionSources(held, next) {
  return held === next || held.length === next.length && held.every(
    (source, at) => source.sessionId === next[at].sessionId && source.file === next[at].file && source.primary === next[at].primary && source.dispatchedFrom === next[at].dispatchedFrom
  );
}
const PROJECT_SPEND_INTEGRITY_MILLISECONDS = 3e4;
const PROJECT_SPEND_SAVE_MS = 500;
const PROJECT_SPEND_SAVE_MAX_MS = 5e3;
const PROJECT_SPEND_SAVE_RETRY_MS = 2e3;
const PROJECT_SPEND_SAVE_RETRIES = 5;
function projectSpendSaveRetryDelay(retries) {
  return retries < PROJECT_SPEND_SAVE_RETRIES ? PROJECT_SPEND_SAVE_RETRY_MS * 2 ** retries : null;
}
const PROJECT_SPEND_PARSER_GENERATION = 24;
function projectSpendSourceOfferDue(listingMoved, now, lastOfferAt) {
  return listingMoved || now - lastOfferAt >= PROJECT_SPEND_INTEGRITY_MILLISECONDS;
}
const DAY_MILLISECONDS = 864e5;
function projectSpendHistoryCutoff(historyDays, now) {
  if (!Number.isFinite(historyDays) || historyDays < 1) {
    return null;
  }
  return now - Math.floor(historyDays) * DAY_MILLISECONDS;
}
function projectSpendOfferDecision(previous, revision, cutoff) {
  if (revision && cutoff !== null && revision.mtimeMs < cutoff) {
    return "skip";
  }
  if (!previous) {
    return "queue";
  }
  if (!revision) {
    return revision === null && previous.missingAt !== void 0 ? "current" : "queue";
  }
  const changed = revision.size !== previous.size || revision.mtimeMs !== previous.mtimeMs || previous.missingAt !== void 0 || previous.complete === false || !spendRecordHasLifetimeFacts(previous);
  return changed ? "queue" : "current";
}
function spendRecordChangesRail(previous, current) {
  return current.complete === true || previous?.complete === true;
}
function readyCount(value) {
  return value === null || Number.isSafeInteger(value) && (value ?? -1) >= 0;
}
function readyTimestamp(value) {
  return value === null || Number.isFinite(value);
}
function readyClosedChild(value) {
  return typeof value === "string" && value.length > 0 || typeof value === "object" && value !== null && typeof value.id === "string" && value.id.length > 0 && Number.isFinite(value.closedAt);
}
function readyOutcome(value) {
  return value === null || typeof value === "object" && value !== void 0 && typeof value.finished === "boolean" && typeof value.error === "boolean" && typeof value.interrupted === "boolean" && Number.isFinite(value.endedAt) && (!Object.prototype.hasOwnProperty.call(value, "processEndedAt") || Number.isFinite(value.processEndedAt)) && (!Object.prototype.hasOwnProperty.call(value, "openChildren") || Array.isArray(value.openChildren) && value.openChildren.every((id) => typeof id === "string" && id.length > 0)) && (!Object.prototype.hasOwnProperty.call(value, "closedChildren") || Array.isArray(value.closedChildren) && value.closedChildren.every(readyClosedChild));
}
function spendRecordHasLifetimeFacts(record) {
  return Array.isArray(record.lifetimeBuckets) && Object.prototype.hasOwnProperty.call(record, "turnCount") && Object.prototype.hasOwnProperty.call(record, "compactionCount") && Object.prototype.hasOwnProperty.call(record, "firstTurnAt") && Object.prototype.hasOwnProperty.call(record, "lastTurnAt") && Object.prototype.hasOwnProperty.call(record, "newestTurnStartedAt") && Object.prototype.hasOwnProperty.call(record, "outcome") && Object.prototype.hasOwnProperty.call(record, "cacheExpiry") && readyCount(record.turnCount) && readyCount(record.compactionCount) && readyTimestamp(record.firstTurnAt) && readyTimestamp(record.lastTurnAt) && readyTimestamp(record.newestTurnStartedAt) && readyOutcome(record.outcome) && record.parserGeneration === PROJECT_SPEND_PARSER_GENERATION;
}
function validEffectiveDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value;
}
function matchingOverride(bucket, entry) {
  return entry.model === bucket.model && (entry.provider === void 0 || entry.provider === bucket.provider) && (entry.inferenceClass === void 0 || entry.inferenceClass === bucket.inferenceClass) && (entry.serviceTier === void 0 || entry.serviceTier === bucket.serviceTier);
}
function modelPricingOverrideFor(bucket, overrides) {
  return overrides.filter(
    (entry) => matchingOverride(bucket, entry) && validEffectiveDate(entry.effectiveDate) && entry.effectiveDate <= bucket.localDate
  ).sort(
    (left, right) => right.effectiveDate.localeCompare(left.effectiveDate) || left.source.localeCompare(right.source) || JSON.stringify(left).localeCompare(JSON.stringify(right))
  )[0] ?? null;
}
function recordedCostSource(basis) {
  if (basis === "list") {
    return "Claude CLI recorded list price";
  }
  if (basis === BEDROCK_LIST_COST_BASIS) {
    return "Claude CLI recorded list price, times 1.1 for Amazon Bedrock";
  }
  return null;
}
function publicProjectSpendPrice(bucket, overrides = []) {
  const recordedSource = recordedCostSource(bucket.reportedCostBasis);
  if (bucket.reportedCost !== null && recordedSource) {
    return {
      dollars: bucket.reportedCost,
      source: recordedSource,
      effectiveDate: null,
      estimated: true,
      provenance: "public"
    };
  }
  const summedTokens = bucket.usage.input + bucket.usage.cacheWrite1h + bucket.usage.cacheWrite5m + (bucket.usage.cacheWrite30m ?? 0) + bucket.usage.cacheRead;
  const configured = modelPricingOverrideFor(bucket, overrides);
  if (hasRequestContextPricing(bucket.model, bucket.provider) && bucket.contextBand == null && bucket.requests > 1 && contextBandForRequest(bucket.model, bucket.provider, summedTokens) !== "short" && bucket.reportedCost === null && configured === null) {
    return null;
  }
  const requestTokens = bucket.contextBand === "long" ? 272001 : bucket.contextBand === "short" ? 0 : summedTokens;
  const quote = quoteUsage({
    usage: bucket.usage,
    model: bucket.model,
    provider: bucket.provider,
    contextWindow: bucket.contextWindow,
    requestTokens,
    inferenceClass: bucket.inferenceClass,
    serviceTier: bucket.serviceTier,
    reportedCost: bucket.reportedCost,
    override: configured ? {
      rate: {
        input: configured.input,
        output: configured.output,
        ...configured.cacheWrite30m === void 0 ? {} : { cacheWrite30m: configured.cacheWrite30m },
        ...configured.cacheRead === void 0 ? {} : { cacheRead: configured.cacheRead }
      },
      source: configured.source,
      effectiveDate: configured.effectiveDate,
      ...configured.serviceTier === void 0 ? {} : { serviceTier: configured.serviceTier }
    } : null
  });
  return quote ? {
    dollars: quote.cost,
    source: quote.reported ? "Provider-reported cost" : quote.source,
    effectiveDate: quote.effectiveDate,
    estimated: !quote.reported,
    provenance: quote.reported ? "reported" : configured ? "configured" : "public"
  } : null;
}
function emptyUsage() {
  return { input: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWrite30m: 0, cacheRead: 0, output: 0, thinking: 0 };
}
function normalizeWorkspace(workspace) {
  const unified = path.resolve(workspace).replace(/\\/g, "/");
  return process.platform === "win32" ? unified.toLowerCase() : unified;
}
const canonicalPaths = /* @__PURE__ */ new Map();
let spendFileNormalizationGeneration = 0;
function canonicalPath(file) {
  const cached = canonicalPaths.get(file);
  if (cached !== void 0) {
    return cached;
  }
  let resolved = path.resolve(file);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
  }
  const normalized = normalizeWorkspace(resolved);
  canonicalPaths.set(file, normalized);
  return normalized;
}
function normalizeSpendFile(file) {
  return canonicalPath(file);
}
function invalidateSpendFileNormalization(file) {
  if (canonicalPaths.delete(file)) {
    spendFileNormalizationGeneration++;
  }
}
function localDate(at) {
  const date = typeof at === "number" ? new Date(at) : at;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
function localMidnight(at = Date.now()) {
  const date = new Date(typeof at === "number" ? at : at.getTime());
  date.setHours(0, 0, 0, 0);
  return date;
}
function projectSpendWindows(at = Date.now()) {
  const midnight = localMidnight(at);
  const start = (daysBefore) => {
    const date = new Date(midnight);
    date.setDate(date.getDate() - daysBefore);
    return localDate(date);
  };
  return [
    { id: "today", label: "Today", start: start(0) },
    { id: "sevenDays", label: "7 days", start: start(6) },
    { id: "thirtyDays", label: "30 days", start: start(29) }
  ];
}
function addUsage(into, add) {
  into.requests = (into.requests ?? 0) + (add.requests ?? 0);
  into.input += add.input;
  into.cacheWrite1h += add.cacheWrite1h;
  into.cacheWrite5m += add.cacheWrite5m;
  into.cacheWrite30m = (into.cacheWrite30m ?? 0) + (add.cacheWrite30m ?? 0);
  into.cacheRead += add.cacheRead;
  into.output += add.output;
  into.thinking += add.thinking;
}
function requestInputTokens(usage) {
  return usage.input + usage.cacheWrite1h + usage.cacheWrite5m + (usage.cacheWrite30m ?? 0) + usage.cacheRead;
}
function bucketIsEmpty(bucket) {
  return bucket.requests === 0 && bucket.usage.input === 0 && bucket.usage.cacheWrite1h === 0 && bucket.usage.cacheWrite5m === 0 && (bucket.usage.cacheWrite30m ?? 0) === 0 && bucket.usage.cacheRead === 0 && bucket.usage.output === 0 && bucket.usage.thinking === 0 && (bucket.unclassifiedCacheWrite ?? 0) === 0 && (bucket.reportedCost === null || bucket.reportedCost === 0);
}
function aggregateUsageEvents(events, existing = []) {
  const byKey = new Map(
    existing.map((bucket) => [projectUsageKey(bucket, bucket.localDate), { ...bucket, usage: { ...bucket.usage } }])
  );
  for (const event of events) {
    const date = localDate(event.timestamp);
    const contextBand = event.contextBand ?? contextBandForRequest(event.model, event.provider, requestInputTokens(event.usage));
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
        ...event.requestCountExact === false ? { requestCountExact: false } : {},
        reportedCost: event.reportedCost === null ? null : 0,
        usage: emptyUsage(),
        requests: 0
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
  return [...byKey.values()].sort(
    (a, b) => projectUsageKey(a, a.localDate).localeCompare(projectUsageKey(b, b.localDate))
  );
}
function emptyCacheExpiryFacts() {
  return {
    counts: { "5m": 0, "30m": 0, "1h": 0 },
    returns: [],
    truncated: false,
    longestGapMs: null,
    excluded: 0,
    unavailable: 0
  };
}
function emptyCacheExpiryLedger() {
  return {
    facts: emptyCacheExpiryFacts(),
    compactions: [],
    carry: null,
    newestReturnKey: null,
    newestCompactionKey: null
  };
}
function positiveClock(value) {
  return Number.isFinite(value) && value > 0;
}
function recordsColdInput(usage) {
  return usage.input > 0 || usage.cacheWrite1h > 0 || usage.cacheWrite5m > 0 || (usage.cacheWrite30m ?? 0) > 0;
}
function requestCacheLifetime(recorded, model, provider) {
  return recorded ?? cacheLifetimeFor(model, provider);
}
function classifyCacheExpiry(previous, next, nextUsage) {
  if (previous.visibleTurnId === null || next.visibleTurnId === null) {
    return { kind: "unavailable" };
  }
  if (previous.visibleTurnId === next.visibleTurnId) {
    return { kind: "none" };
  }
  if (!positiveClock(previous.timestamp) || !positiveClock(next.timestamp) || next.timestamp < previous.timestamp) {
    return { kind: "unavailable" };
  }
  if (previous.incomplete || next.incomplete) {
    return { kind: "unavailable" };
  }
  const lifetime = previous.lifetime;
  if (lifetime === null) {
    return { kind: "unavailable" };
  }
  if (!cacheLapsedBy(previous.timestamp, lifetime, next.timestamp)) {
    return { kind: "none" };
  }
  if (previous.compactionsBefore !== next.compactionsBefore || previous.model !== next.model || previous.provider !== next.provider || previous.serviceTier !== next.serviceTier || previous.inferenceClass !== next.inferenceClass) {
    return { kind: "excluded" };
  }
  if (previous.effort != null && next.effort != null && previous.effort !== next.effort) {
    return { kind: "excluded" };
  }
  if (previous.toolListVersion != null && next.toolListVersion != null && previous.toolListVersion !== next.toolListVersion) {
    return { kind: "excluded" };
  }
  if (!recordsColdInput(nextUsage)) {
    return { kind: "none" };
  }
  return { kind: "return", lifetime, gapMs: next.timestamp - previous.timestamp };
}
function requestBucket(event) {
  const date = localDate(event.timestamp);
  const contextBand = event.contextBand ?? contextBandForRequest(event.model, event.provider, requestInputTokens(event.usage));
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
    ...event.requestCountExact === false ? { requestCountExact: false } : {},
    reportedCost: event.reportedCost,
    usage: { ...event.usage, requests: 1 },
    requests: 1
  };
}
function carryFor(event) {
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
    incomplete: event.incomplete === true
  };
}
function primaryOrderedRequest(event) {
  return !event.compactionEstimate && !event.linkedSessionId && !event.linkedInvocationId && (event.usage.requests ?? 1) > 0;
}
class CacheExpiryScan {
  facts;
  compactions;
  carry;
  newestReturnKey;
  newestCompactionKey;
  constructor(previous) {
    const restored = previous ?? emptyCacheExpiryLedger();
    this.facts = {
      counts: { ...restored.facts.counts },
      returns: restored.facts.returns.map((item) => ({
        ...item,
        request: { ...item.request, usage: { ...item.request.usage } }
      })),
      truncated: restored.facts.truncated,
      longestGapMs: restored.facts.longestGapMs,
      excluded: restored.facts.excluded,
      unavailable: restored.facts.unavailable
    };
    this.compactions = restored.compactions.map((item) => ({ ...item }));
    this.carry = restored.carry ? { ...restored.carry } : null;
    this.newestReturnKey = restored.newestReturnKey;
    this.newestCompactionKey = restored.newestCompactionKey;
  }
  push(event) {
    if (!primaryOrderedRequest(event)) {
      return;
    }
    if (this.carry && event.requestKey !== null && event.requestKey === this.carry.requestKey) {
      this.revise(event);
      return;
    }
    const next = carryFor(event);
    if (this.carry && positiveClock(this.carry.timestamp) && positiveClock(next.timestamp) && next.timestamp < this.carry.timestamp) {
      this.facts.unavailable++;
      return;
    }
    this.recordCompactions(next, event);
    if (this.carry) {
      this.judge(this.carry, next, event);
    }
    this.carry = next;
  }
  revise(event) {
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
  recordCompactions(next, event) {
    const before = this.carry?.compactionsBefore ?? 0;
    const added = next.compactionsBefore - before;
    if (added <= 0) {
      const open = this.compactions[this.compactions.length - 1];
      if (open && open.ordinal === next.compactionsBefore) {
        open.requestsAfter++;
      }
      return;
    }
    for (let step = 1; step <= added; step++) {
      const fact = this.openCompaction(
        before + step,
        step === 1 && !this.carry?.incomplete ? this.carry?.inputTokens ?? null : null
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
  openCompaction(ordinal, contextBefore) {
    const held = this.compactions.find((item) => item.ordinal === ordinal);
    if (held) {
      return held;
    }
    const fact = {
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
      requestContextWindow: null
    };
    this.compactions.push(fact);
    this.compactions.sort((left, right) => left.ordinal - right.ordinal);
    return fact;
  }
  trimCompactions() {
    while (this.compactions.length > RETAINED_COMPACTIONS) {
      this.compactions.shift();
    }
  }
  judge(previous, next, event) {
    const verdict = classifyCacheExpiry(previous, next, event.usage);
    if (verdict.kind === "unavailable") {
      this.facts.unavailable++;
      return;
    }
    if (verdict.kind === "excluded") {
      this.facts.excluded++;
      return;
    }
    if (verdict.kind === "none") {
      return;
    }
    this.facts.counts[verdict.lifetime]++;
    this.facts.longestGapMs = this.facts.longestGapMs === null ? verdict.gapMs : Math.max(this.facts.longestGapMs, verdict.gapMs);
    this.facts.returns.push({
      lifetime: verdict.lifetime,
      gapMs: verdict.gapMs,
      request: requestBucket(event)
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
  ledger(recorded) {
    const reached = this.carry?.compactionsBefore ?? 0;
    for (const item of recorded) {
      if (item.ordinal <= reached) {
        continue;
      }
      this.openCompaction(
        item.ordinal,
        item.ordinal === reached + 1 && !this.carry?.incomplete ? this.carry?.inputTokens ?? null : null
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
          requestContextWindow: held?.requestContextWindow ?? null
        };
      }),
      carry: this.carry,
      newestReturnKey: this.newestReturnKey,
      newestCompactionKey: this.newestCompactionKey
    };
  }
}
function cacheExpiryInputUsage(request) {
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
      thinking: 0
    }
  };
}
function cacheExpiryInputCost(facts, pricer) {
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
    return partial || facts.returns.length > 0 ? { dollars: null, status: "unknown" } : { dollars: 0, status: "exact" };
  }
  return { dollars, status: partial ? "atLeast" : "exact" };
}
function sameBuckets(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
const DEFAULT_SCAN_BYTES = 1024 * 1024;
const DEFAULT_SCAN_MILLISECONDS = 15;
function readIncremental(file, offset, scanOffset, pending, size, reducer, buckets, lifetimeBuckets, cacheExpiry, budget) {
  const fd = fs.openSync(file, "r");
  try {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const maxBytes = budget.maxBytes ?? DEFAULT_SCAN_BYTES;
    const clock = budget.now ?? Date.now;
    const deadline = clock() + (budget.maxMilliseconds ?? DEFAULT_SCAN_MILLISECONDS);
    const byKey = new Map(
      buckets.map((bucket) => [projectUsageKey(bucket, bucket.localDate), { ...bucket, usage: { ...bucket.usage } }])
    );
    const lifetimeByKey = new Map(
      lifetimeBuckets.map((bucket) => [
        projectUsageKey(bucket, bucket.localDate),
        { ...bucket, usage: { ...bucket.usage } }
      ])
    );
    const addTo = (target, event) => {
      const date = localDate(event.timestamp);
      const contextBand = event.contextBand ?? contextBandForRequest(event.model, event.provider, requestInputTokens(event.usage));
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
          ...event.requestCountExact === false ? { requestCountExact: false } : {},
          ...event.compactionEstimate ? { compactionEstimate: true } : {},
          reportedCost: event.reportedCost === null ? null : 0,
          usage: emptyUsage(),
          requests: 0
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
    const ordered = reducer.recentCompactions ? new CacheExpiryScan(cacheExpiry ?? void 0) : null;
    const add = (event) => {
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
        if (bytes[cursor] !== 10) {
          continue;
        }
        let line = bytes.subarray(lineStart, cursor);
        if (line.length && line[line.length - 1] === 13) {
          line = line.subarray(0, line.length - 1);
        }
        for (const event of reducer.pushLine(line.toString("utf8"))) {
          add(event);
        }
        lineStart = cursor + 1;
        completedOffset = position - (bytes.length - lineStart);
      }
      held = Buffer.from(bytes.subarray(lineStart));
    }
    const complete = position >= size;
    return {
      offset: completedOffset,
      trailing: held,
      scanOffset: position,
      complete,
      buckets: [...byKey.values()].sort(
        (left, right) => projectUsageKey(left, left.localDate).localeCompare(projectUsageKey(right, right.localDate))
      ),
      lifetimeBuckets: [...lifetimeByKey.values()].sort(
        (left, right) => projectUsageKey(left, left.localDate).localeCompare(projectUsageKey(right, right.localDate))
      ),
      turnCount: reducer.turnCount?.() ?? null,
      compactionCount: reducer.compactionCount?.() ?? null,
      firstTurnAt: reducer.firstTurnAt?.() ?? null,
      lastTurnAt: reducer.lastTurnAt?.() ?? null,
      cacheExpiry: ordered ? ordered.ledger(reducer.recentCompactions()) : null
    };
  } finally {
    fs.closeSync(fd);
  }
}
function indexSpendFile(previous, file, workspace, makeReducer, nowOrBudget = Date.now(), budget = {}) {
  const now = typeof nowOrBudget === "number" ? nowOrBudget : Date.now();
  const scanBudget = typeof nowOrBudget === "number" ? budget : nowOrBudget;
  const normalizedFile = canonicalPath(file);
  const normalizedWorkspace = normalizeWorkspace(workspace);
  const emptyReducer = makeReducer(void 0);
  const parserKind = emptyReducer.parserKind;
  let stat;
  try {
    stat = fs.statSync(file);
    if (!stat.isFile()) {
      throw new Error("not a file");
    }
  } catch {
    invalidateSpendFileNormalization(file);
    const record2 = previous && previous.file === normalizedFile ? { ...previous, missingAt: previous.missingAt ?? now } : {
      file: normalizedFile,
      workspace: normalizedWorkspace,
      size: 0,
      mtimeMs: 0,
      offset: 0,
      trailing: "",
      buckets: [],
      indexedAt: now,
      missingAt: now,
      ...parserKind === void 0 ? {} : { parserKind }
    };
    const stateChanged2 = !previous || previous.missingAt === void 0;
    return {
      record: record2,
      totalsChanged: false,
      stateChanged: stateChanged2,
      changed: stateChanged2,
      rebuilt: false,
      found: false,
      complete: true
    };
  }
  const reusable = previous && previous.file === normalizedFile && previous.workspace === normalizedWorkspace && (parserKind === void 0 || previous.parserKind === parserKind);
  const lifetimeReady = reusable && spendRecordHasLifetimeFacts(previous);
  const unchanged = lifetimeReady && previous.complete !== false && previous.missingAt === void 0 && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs;
  if (unchanged) {
    return {
      record: previous,
      totalsChanged: false,
      stateChanged: false,
      changed: false,
      rebuilt: false,
      found: true,
      complete: true
    };
  }
  const resuming = reusable && previous.complete === false && previous.missingAt === void 0 && stat.size >= previous.size && (stat.size > previous.size || stat.mtimeMs === previous.mtimeMs);
  const rebuilt = !reusable || !lifetimeReady || previous.missingAt !== void 0 || stat.size < previous.size || !resuming && stat.size === previous.size;
  const base = rebuilt ? void 0 : previous;
  const reducer = base ? makeReducer(base.parserState) : emptyReducer;
  const resume = base?.complete === false;
  const scanned = readIncremental(
    file,
    base?.offset ?? 0,
    resume ? base?.scanOffset ?? base?.offset ?? 0 : base?.offset ?? 0,
    resume && base?.pendingBytes ? Buffer.from(base.pendingBytes, "base64") : Buffer.alloc(0),
    stat.size,
    reducer,
    base?.buckets ?? [],
    base?.lifetimeBuckets ?? [],
    base?.cacheExpiry,
    scanBudget
  );
  const buckets = scanned.buckets;
  const record = {
    file: normalizedFile,
    workspace: normalizedWorkspace,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    offset: scanned.offset,
    trailing: scanned.trailing.toString("utf8"),
    trailingBytes: scanned.trailing.toString("base64"),
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
    ...parserKind === void 0 ? {} : { parserKind },
    indexedAt: now,
    parserState: reducer.snapshot(),
    complete: scanned.complete,
    ...scanned.complete ? {} : { scanOffset: scanned.scanOffset, pendingBytes: scanned.trailing.toString("base64") }
  };
  const totalsChanged = !reusable || !sameBuckets(previous.buckets, buckets) || !sameBuckets(previous.lifetimeBuckets ?? [], scanned.lifetimeBuckets) || previous.turnCount !== scanned.turnCount || previous.compactionCount !== scanned.compactionCount || previous.firstTurnAt !== scanned.firstTurnAt || previous.lastTurnAt !== scanned.lastTurnAt || previous.newestTurnStartedAt !== record.newestTurnStartedAt || JSON.stringify(previous.outcome ?? null) !== JSON.stringify(record.outcome) || JSON.stringify(previous.cacheExpiry ?? null) !== JSON.stringify(record.cacheExpiry);
  const stateChanged = totalsChanged || previous.size !== record.size || previous.mtimeMs !== record.mtimeMs || previous.offset !== record.offset || previous.trailingBytes !== record.trailingBytes || previous.complete !== record.complete || previous.scanOffset !== record.scanOffset || previous.pendingBytes !== record.pendingBytes || previous.parserGeneration !== record.parserGeneration || previous.parserKind !== record.parserKind;
  return {
    record,
    totalsChanged,
    stateChanged,
    changed: stateChanged,
    rebuilt,
    found: true,
    complete: scanned.complete
  };
}
function pruneSpendFilesWithResult(files, now = Date.now()) {
  const cutoff = projectSpendWindows(now)[2].start;
  let pruned = false;
  const retained = files.map((record) => {
    const buckets = record.buckets.filter((bucket) => bucket.localDate >= cutoff);
    if (buckets.length === record.buckets.length) {
      return record;
    }
    pruned = true;
    return { ...record, buckets };
  }).filter((record) => {
    const keep = !record.missingAt || record.buckets.length > 0;
    if (!keep) {
      pruned = true;
    }
    return keep;
  });
  return { files: retained, pruned };
}
function pruneSpendFiles(files, now = Date.now()) {
  return pruneSpendFilesWithResult(files, now).files;
}
function ledgerFile(storageDirectory, workspace) {
  const partition = crypto.createHash("sha256").update(normalizeWorkspace(workspace)).digest("hex");
  return path.join(storageDirectory, `${partition}.json`);
}
function projectSpendWorkspace(folders, multiRootPrefix) {
  if (folders.length <= 1) {
    return folders[0] ?? "";
  }
  const normalized = folders.map((folder) => normalizeFsPath(path.resolve(folder))).sort();
  return path.join(
    path.parse(folders[0]).root,
    `${multiRootPrefix}${crypto.createHash("sha256").update(normalized.join("\n")).digest("hex")}`
  );
}
function usableSpendRecord(record) {
  const candidate = record;
  return !!candidate && typeof candidate.file === "string" && Array.isArray(candidate.buckets);
}
function loadSpendLedger(storageDirectory, workspace) {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerFile(storageDirectory, workspace), "utf8"));
    const ledger = parseSpendLedger(
      parsed,
      normalizeWorkspace(workspace),
      PROJECT_SPEND_PARSER_GENERATION,
      normalizeWorkspace
    );
    if (!ledger) {
      throw new Error("invalid ledger");
    }
    return ledger;
  } catch {
    return {
      workspace: normalizeWorkspace(workspace),
      parserGeneration: PROJECT_SPEND_PARSER_GENERATION,
      files: [],
      completeFiles: []
    };
  }
}
function saveSpendLedger(storageDirectory, workspace, files, completeFiles = files.filter((record) => record.complete !== false)) {
  const checkpoint = (record) => {
    const state = withRetainedRequestEvents(record.parserState);
    const normalizedFile = normalizeSpendFile(record.file);
    const bounded = state === record.parserState && normalizedFile === record.file ? record : { ...record, file: normalizedFile, parserState: state };
    if (bounded.complete !== false) {
      return bounded;
    }
    const { pendingBytes: _pendingBytes, trailingBytes: _trailingBytes, ...rest } = bounded;
    return { ...rest, scanOffset: bounded.offset, trailing: "" };
  };
  const present = Array.from(files).filter(usableSpendRecord);
  const shown = Array.from(completeFiles).filter(usableSpendRecord);
  const saved = present.map(checkpoint);
  const texts = saved.map((record) => JSON.stringify(record));
  const sameRecord = /* @__PURE__ */ new Map();
  const samePath = /* @__PURE__ */ new Map();
  present.forEach((record, at) => {
    if (!sameRecord.has(record)) {
      sameRecord.set(record, at);
    }
    const normalizedFile = normalizeSpendFile(record.file);
    if (!samePath.has(normalizedFile)) {
      samePath.set(normalizedFile, at);
    }
  });
  const display = shown.map((record) => {
    const shared = sameRecord.get(record);
    if (shared !== void 0) {
      return String(shared);
    }
    const found = samePath.get(normalizeSpendFile(record.file));
    const text = JSON.stringify(checkpoint(record));
    return found !== void 0 && texts[found] === text ? String(found) : text;
  });
  writeFileAtomically(
    ledgerFile(storageDirectory, workspace),
    `{"workspace":${JSON.stringify(normalizeWorkspace(workspace))},"parserGeneration":${PROJECT_SPEND_PARSER_GENERATION},"files":[${texts.join(",")}],"displayFiles":[${display.join(",")}]}`
  );
}
function formatProjectCost(dollars) {
  if (dollars === null) {
    return "Cost unknown";
  }
  if (dollars < 0.01 && dollars > 0) {
    return "<$0.01";
  }
  if (dollars < 10) {
    return `$${dollars.toFixed(2)}`;
  }
  return `$${Math.round(dollars).toLocaleString("en-US")}`;
}
function accumulator() {
  return { dollars: 0, priced: 0, unpriced: 0, seen: 0, partial: false, sources: /* @__PURE__ */ new Map() };
}
function priceBucket(bucket, pricer) {
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
        provenance: "public"
      };
    }
    return {
      dollars: bucket.reportedCost,
      source: "Provider-reported cost",
      effectiveDate: null,
      estimated: false,
      provenance: "reported"
    };
  }
  return pricer(bucket);
}
function directClaudeSources(files) {
  const linked = new Set(
    files.flatMap((file) => file.buckets.flatMap((bucket) => bucket.linkedSessionId ? [bucket.linkedSessionId] : []))
  );
  const usableSessions = /* @__PURE__ */ new Set();
  const ignoredFiles = /* @__PURE__ */ new Set();
  for (const file of files) {
    const name = path.basename(file.file).replace(/\.jsonl$/i, "");
    if (!linked.has(name)) {
      continue;
    }
    const complete = file.complete !== false && !file.trailing && !file.trailingBytes;
    const usable = complete && file.buckets.some((bucket) => !bucket.linkedSessionId && !bucket.incomplete && bucket.requests > 0);
    if (usable) {
      usableSessions.add(name);
    } else {
      ignoredFiles.add(file.file);
    }
  }
  return { usableSessions, ignoredFiles };
}
function addBucket(total, bucket, price) {
  total.seen += bucket.requests;
  if (!price) {
    total.unpriced += bucket.requests;
    total.partial = true;
    return;
  }
  total.dollars += price.dollars;
  total.priced += bucket.requests;
  total.sources.set(`${price.source}\0${price.effectiveDate ?? ""}\0${price.provenance}`, {
    effectiveDate: price.effectiveDate,
    provenance: price.provenance
  });
}
function displayWindow(total, incomplete, window, truncated = false) {
  const unpriced = total.partial || incomplete;
  const partial = unpriced || truncated;
  const hasKnownActivity = total.seen > 0 || total.unpriced > 0 || incomplete;
  const dollars = total.priced && (!unpriced || total.dollars > 0) ? total.dollars : hasKnownActivity ? null : 0;
  const status = dollars === null ? "unknown" : partial ? "atLeast" : "exact";
  return {
    ...window,
    dollars,
    display: status === "unknown" ? "Cost unknown" : status === "atLeast" ? `At least ${formatProjectCost(dollars)}` : formatProjectCost(dollars),
    status,
    partial,
    pricedRequests: total.priced,
    unpricedRequests: total.unpriced
  };
}
function spendAgent(agent) {
  const normalized = agent.toLowerCase();
  return normalized === "claude" || normalized === "codex" ? normalized : null;
}
function prepareProjectSpendView(files, pricer, options = {}) {
  const now = options.now ?? Date.now();
  const windows = projectSpendWindows(now);
  const cutoff = options.historyCutoff ?? null;
  const truncated = new Map(
    windows.map((window) => [window.id, cutoff !== null && (/* @__PURE__ */ new Date(`${window.start}T00:00:00`)).getTime() < cutoff])
  );
  const totals = new Map(windows.map((window) => [window.id, accumulator()]));
  const agentTotals = new Map(
    ["claude", "codex"].map((agent) => [agent, new Map(windows.map((window) => [window.id, accumulator()]))])
  );
  const evidencedAgents = /* @__PURE__ */ new Set();
  const rateSources = /* @__PURE__ */ new Map();
  const contributingDates = [];
  const directClaude = directClaudeSources(files);
  const hasTrailing = files.some((file) => file.complete !== false && Boolean(file.trailingBytes || file.trailing));
  let lastIndexedAt = null;
  for (const file of files) {
    lastIndexedAt = lastIndexedAt === null ? file.indexedAt : Math.max(lastIndexedAt, file.indexedAt);
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
        addBucket(totals.get(window.id), bucket, price);
        if (agent) {
          addBucket(agentTotals.get(agent).get(window.id), bucket, price);
        }
      }
      if (price && bucket.localDate >= windows[2].start) {
        rateSources.set(`${price.source}\0${price.effectiveDate ?? ""}\0${price.provenance}`, {
          effectiveDate: price.effectiveDate,
          provenance: price.provenance
        });
      }
    }
  }
  const viewWindows = windows.map(
    (window) => displayWindow(totals.get(window.id), hasTrailing, window, truncated.get(window.id))
  );
  const earliestRecord = contributingDates.sort()[0] ?? null;
  return {
    name: options.name ?? "Project cost",
    windows: viewWindows,
    categories: ["claude", "codex"].filter((agent) => evidencedAgents.has(agent)).map((agent) => ({
      id: agent,
      label: `${agent === "claude" ? "Claude" : "Codex"} spend`,
      windows: windows.map(
        (window) => displayWindow(agentTotals.get(agent).get(window.id), hasTrailing, window, truncated.get(window.id))
      )
    })),
    earliestRecord,
    lastIndexedAt,
    rateSources: [...rateSources.entries()].map(([key, metadata]) => ({
      source: key.split("\0")[0],
      effectiveDate: metadata.effectiveDate,
      provenance: metadata.provenance
    })),
    indexing: Boolean(options.indexing)
  };
}
function uniqueFiles(files) {
  const seen = /* @__PURE__ */ new Set();
  return files.filter((file) => {
    const key = canonicalPath(file);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
function descendantPositions(items, idOf, parentOf) {
  const hanging = /* @__PURE__ */ new Map();
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
  const below = /* @__PURE__ */ new Map();
  for (const [id, item] of new Map(items.map((item2) => [idOf(item2), item2]))) {
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
  const answers = /* @__PURE__ */ new Map();
  return (ancestor) => {
    const held = answers.get(ancestor);
    if (held) {
      return held;
    }
    const reached = /* @__PURE__ */ new Set([ancestor]);
    const queue = [ancestor];
    const positions = [];
    for (let index = 0; index < queue.length; index++) {
      positions.push(...hanging.get(queue[index]) ?? []);
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
function readSubagentFiles(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map((entry) => path.join(directory, entry.name));
  } catch {
    return null;
  }
}
const uncachedSubagentDirectories = {
  files: (directory) => readSubagentFiles(directory) ?? []
};
function subagentDirectoryOf(parent) {
  return path.join(path.dirname(parent.file), parent.sessionId, "subagents");
}
const SUBAGENT_DIRECTORY_SETTLE_MS = 2e3;
class SubagentDirectoryCache {
  constructor(read = readSubagentFiles, now = Date.now) {
    this.read = read;
    this.now = now;
  }
  entries = /* @__PURE__ */ new Map();
  listed = /* @__PURE__ */ new Set();
  // Forgets every directory that no call to `files` named since the last sweep, so a directory
  // that left the scope is not held for the life of the cache.
  sweep() {
    for (const directory of [...this.entries.keys()]) {
      if (!this.listed.has(directory)) {
        this.entries.delete(directory);
      }
    }
    this.listed.clear();
  }
  files(directory) {
    this.listed.add(directory);
    let stat;
    try {
      stat = fs.statSync(directory, { throwIfNoEntry: false });
    } catch {
      stat = void 0;
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
    if (files && this.now() - stat.mtimeMs >= SUBAGENT_DIRECTORY_SETTLE_MS) {
      this.entries.set(directory, { mtimeMs: stat.mtimeMs, files });
    } else {
      this.entries.delete(directory);
    }
    return files ?? [];
  }
}
function discoverClaudeSessionSpendSources(parents, directories = uncachedSubagentDirectories) {
  const sources = [];
  const seen = /* @__PURE__ */ new Set();
  const add = (source) => {
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
    (parent) => parent.parentSessionId
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
function spendRecordAgent(record) {
  if (record.parserKind) {
    return record.parserKind;
  }
  const buckets = record.lifetimeBuckets ?? record.buckets;
  return buckets.some((bucket) => bucket.agent.toLowerCase() === "codex") ? "codex" : "claude";
}
function spendFileIsClaudeChild(file) {
  return path.basename(path.dirname(file)).toLowerCase() === "subagents";
}
function discoverClaudeSpendSources(parents) {
  return uniqueFiles(discoverClaudeSessionSpendSources(parents).map((source) => source.file));
}
function discoverCodexSpendSources(visible, children) {
  return uniqueFiles([...visible.map((source) => source.file), ...children.map((source) => source.file)]);
}
function discoverCodexSessionSpendSources(sessions, children) {
  const descendants = descendantPositions(
    children,
    (child) => child.threadId,
    (child) => child.parentThreadId
  );
  const out = [];
  for (const session of sessions) {
    out.push({ sessionId: session.sessionId, file: session.file, primary: true });
    for (const position of descendants(session.sessionId)) {
      out.push({ sessionId: session.sessionId, file: children[position].file, primary: false });
    }
  }
  return out;
}
function withDispatchedSpendSources(sources, parents, delegators = /* @__PURE__ */ new Map()) {
  if (!parents.size) {
    return [...sources];
  }
  const above = (session) => parents.get(session) ?? delegators.get(session);
  const linked = /* @__PURE__ */ new Set();
  for (const child of parents.keys()) {
    for (let at = child; at !== void 0 && !linked.has(at); at = above(at)) {
      linked.add(at);
    }
  }
  const own = /* @__PURE__ */ new Map();
  const seen = /* @__PURE__ */ new Set();
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
    const reached = /* @__PURE__ */ new Set([child]);
    for (let parent = above(child); parent !== void 0 && !reached.has(parent); parent = above(parent)) {
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
class SessionSpendSourceIndex {
  constructor(discover = {
    claude: discoverClaudeSessionSpendSources,
    codex: discoverCodexSessionSpendSources
  }) {
    this.discover = discover;
  }
  key = null;
  print = "";
  held = [];
  changes = 0;
  get revision() {
    return this.changes;
  }
  get sources() {
    return this.held;
  }
  update(claude, claudeChildren, codex, codexChildren, directories = uncachedSubagentDirectories, dispatchParents = /* @__PURE__ */ new Map()) {
    const listings = /* @__PURE__ */ new Map();
    const listingOf = (directory) => {
      const held = listings.get(directory) ?? directories.files(directory);
      listings.set(directory, held);
      return held;
    };
    const lines = [
      ...claude.map((source) => `c\0${source.sessionId}\0${source.file}\0${source.primary === false ? "d" : "m"}`),
      ...claudeChildren.map(
        (child) => `k\0${child.sessionId}\0${child.parentSessionId ?? ""}\0${child.file}\0${listingOf(subagentDirectoryOf(child)).join("\0")}`
      ),
      ...codex.map((session) => `s\0${session.sessionId}\0${session.file}`),
      ...codexChildren.map((child) => `x\0${child.threadId}\0${child.parentThreadId ?? ""}\0${child.file}`),
      ...[...dispatchParents].map(([child, parent]) => `d\0${child}\0${parent}`)
    ];
    const key = lines.sort().join("\n");
    if (key === this.key) {
      return this.held;
    }
    this.key = key;
    this.held = withDispatchedSpendSources(
      [
        ...claude,
        ...this.discover.claude(claudeChildren, { files: listingOf }),
        ...this.discover.codex(codex, codexChildren)
      ],
      dispatchParents,
      new Map(
        claudeChildren.flatMap((child) => child.parentSessionId ? [[child.sessionId, child.parentSessionId]] : [])
      )
    );
    const print = this.held.map(
      (source) => `${source.sessionId}\0${source.file}\0${source.primary === false ? "delegated" : "main"}\0${source.dispatchedFrom ?? ""}`
    ).join("\n");
    if (print !== this.print) {
      this.print = print;
      this.changes++;
    }
    return this.held;
  }
}
function spendSourceKey(file, records) {
  const lexical = normalizeWorkspace(file);
  return records.has(lexical) ? lexical : normalizeSpendFile(file);
}
function sessionSpendPartsBySession(files, sources, awaiting, pending = () => true) {
  const records = new Map(files.map((record) => [normalizeWorkspace(record.file), record]));
  const bySession = /* @__PURE__ */ new Map();
  for (const source of sources) {
    const groups = bySession.get(source.sessionId) ?? /* @__PURE__ */ new Map();
    const group = source.dispatchedFrom ?? "";
    const held = groups.get(group) ?? /* @__PURE__ */ new Map();
    const file = spendSourceKey(source.file, records);
    held.set(file, (held.get(file) ?? false) || source.primary !== false);
    groups.set(group, held);
    bySession.set(source.sessionId, groups);
  }
  const whole = ({ record }) => spendRecordWhole(record);
  const waits = ({ file, record }) => spendRecordAwaitsLedger(record) && pending(file, record);
  const out = {};
  for (const [sessionId, groups] of bySession) {
    const found = [];
    let ready = true;
    let short = false;
    for (const [group, held] of groups) {
      const files2 = [...held].map(([file, primary]) => ({ file, record: records.get(file), primary }));
      if (!group) {
        if (files2.every(whole)) {
          found.push(...files2);
        } else {
          ready = false;
        }
      } else if (files2.some(waits)) {
        short = true;
      } else {
        found.push(...files2.filter((file) => file.record));
      }
    }
    if (!ready) {
      continue;
    }
    if (short) {
      awaiting?.add(sessionId);
    }
    out[sessionId] = found.flatMap(
      ({ record, primary }) => (record?.lifetimeBuckets ?? []).map((bucket) => {
        const role = primary && !bucket.linkedSessionId && !bucket.linkedInvocationId ? "main" : "delegated";
        return {
          bucket,
          role,
          ...role === "delegated" ? {
            scopeId: bucket.linkedInvocationId ? `invocation:${bucket.linkedInvocationId}` : bucket.linkedSessionId ? `session:${bucket.linkedSessionId}` : `source:${normalizeWorkspace(record.file)}`
          } : {}
        };
      })
    );
  }
  return out;
}
function sessionSpendBySession(files, sources) {
  return Object.fromEntries(
    Object.entries(sessionSpendPartsBySession(files, sources)).map(([sessionId, parts]) => [
      sessionId,
      parts.map((part) => part.bucket)
    ])
  );
}
function sessionTurnStatsBySession(files, sources) {
  const records = new Map(files.map((record) => [normalizeWorkspace(record.file), record]));
  const primaryBySession = /* @__PURE__ */ new Map();
  for (const source of sources) {
    if (source.primary !== true) {
      continue;
    }
    const held = primaryBySession.get(source.sessionId) ?? /* @__PURE__ */ new Set();
    held.add(spendSourceKey(source.file, records));
    primaryBySession.set(source.sessionId, held);
  }
  const out = {};
  for (const [sessionId, primaryFiles] of primaryBySession) {
    if (primaryFiles.size !== 1) {
      continue;
    }
    const record = records.get([...primaryFiles][0]);
    if (!record || record.complete === false || Boolean(record.trailingBytes || record.trailing) || !Number.isSafeInteger(record.turnCount) || (record.turnCount ?? -1) < 0) {
      continue;
    }
    out[sessionId] = {
      turnCount: record.turnCount,
      compactionCount: Number.isSafeInteger(record.compactionCount) && record.compactionCount >= 0 ? record.compactionCount : null,
      firstTurnAt: typeof record.firstTurnAt === "number" ? record.firstTurnAt : null,
      lastTurnAt: typeof record.lastTurnAt === "number" ? record.lastTurnAt : null
    };
  }
  return out;
}
function sessionCacheFactsBySession(files, sources) {
  const records = new Map(files.map((record) => [normalizeWorkspace(record.file), record]));
  const primaryBySession = /* @__PURE__ */ new Map();
  for (const source of sources) {
    if (source.primary !== true) {
      continue;
    }
    const held = primaryBySession.get(source.sessionId) ?? /* @__PURE__ */ new Set();
    held.add(spendSourceKey(source.file, records));
    primaryBySession.set(source.sessionId, held);
  }
  const out = {};
  for (const [sessionId, primaryFiles] of primaryBySession) {
    if (primaryFiles.size !== 1) {
      continue;
    }
    const record = records.get([...primaryFiles][0]);
    if (!record || record.complete === false || Boolean(record.trailingBytes || record.trailing) || !record.cacheExpiry) {
      continue;
    }
    out[sessionId] = {
      expiry: record.cacheExpiry.facts,
      compactions: record.cacheExpiry.compactions
    };
  }
  return out;
}
function sessionRailFactsBySession(files, sources) {
  const records = new Map(Object.values(files).map((record) => [normalizeWorkspace(record.file), record]));
  const primaryBySession = /* @__PURE__ */ new Map();
  for (const source of sources) {
    if (source.primary !== true) {
      continue;
    }
    const held = primaryBySession.get(source.sessionId) ?? /* @__PURE__ */ new Set();
    held.add(spendSourceKey(source.file, records));
    primaryBySession.set(source.sessionId, held);
  }
  const out = {};
  for (const [sessionId, primaryFiles] of primaryBySession) {
    if (primaryFiles.size !== 1) {
      continue;
    }
    const record = records.get([...primaryFiles][0]);
    if (!record || record.complete === false || Boolean(record.trailingBytes || record.trailing) || !readyTimestamp(record.newestTurnStartedAt) || !readyOutcome(record.outcome)) {
      continue;
    }
    out[sessionId] = {
      newestTurnStartedAt: record.newestTurnStartedAt ?? null,
      outcome: record.outcome ? { ...record.outcome } : null
    };
  }
  return out;
}
function projectSpendDisplayFiles(indexing, resumable, complete) {
  return indexing ? complete : resumable;
}
function sessionLifetimeDisplayFiles(indexing, resumable, complete) {
  if (!indexing) {
    return resumable;
  }
  const fallback = new Map(complete.map((record) => [record.file, record]));
  return resumable.map((record) => record.complete === false ? fallback.get(record.file) ?? record : record);
}
export {
  CacheExpiryScan,
  PROJECT_SPEND_INTEGRITY_MILLISECONDS,
  PROJECT_SPEND_PARSER_GENERATION,
  PROJECT_SPEND_SAVE_MAX_MS,
  PROJECT_SPEND_SAVE_MS,
  PROJECT_SPEND_SAVE_RETRIES,
  PROJECT_SPEND_SAVE_RETRY_MS,
  SUBAGENT_DIRECTORY_SETTLE_MS,
  SessionFiguresCache,
  SessionSpendSourceIndex,
  SubagentDirectoryCache,
  aggregateUsageEvents,
  cacheExpiryInputCost,
  cacheExpiryInputUsage,
  classifyCacheExpiry,
  discoverClaudeSessionSpendSources,
  discoverClaudeSpendSources,
  discoverCodexSessionSpendSources,
  discoverCodexSpendSources,
  emptyCacheExpiryFacts,
  emptyCacheExpiryLedger,
  emptyUsage,
  formatProjectCost,
  indexSpendFile,
  invalidateSpendFileNormalization,
  loadSpendLedger,
  localMidnight,
  modelPricingOverrideFor,
  normalizeSpendFile,
  normalizeWorkspace,
  prepareProjectSpendView,
  projectSpendDisplayFiles,
  projectSpendHistoryCutoff,
  projectSpendOfferDecision,
  projectSpendSaveRetryDelay,
  projectSpendSourceOfferDue,
  projectSpendWindows,
  projectSpendWorkspace,
  pruneSpendFiles,
  pruneSpendFilesWithResult,
  publicProjectSpendPrice,
  requestCacheLifetime,
  saveSpendLedger,
  sessionCacheFactsBySession,
  sessionLifetimeDisplayFiles,
  sessionRailFactsBySession,
  sessionSpendBySession,
  sessionSpendPartsBySession,
  sessionTurnStatsBySession,
  spendFileIsClaudeChild,
  spendRecordAgent,
  spendRecordChangesRail,
  spendRecordHasLifetimeFacts,
  spendSourceHeld,
  withDispatchedSpendSources
};
