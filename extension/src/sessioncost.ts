import fs from 'node:fs';
import path from 'node:path';
import { scanLines } from './agentspend';
import {
  codexRequestUsage,
  codexSessionsRoot,
  createCodexUsageLineReducer,
  readCodexSessionMeta,
  recordedDatePredatesOpening,
  rolloutFiles,
  scanCodexDispatchReferences,
} from './codex';
import { CACHE_LIFETIME_MS, PROMOTIONS, cacheLifetimeFor, quoteUsage, type CacheTier } from './pricing';
import { discoverClaudeSessionSpendSources, spendFileIsClaudeChild } from './projectspend';
import {
  createClaudeUsageLineReducer,
  listSessionFiles,
  normalizeFsPath,
  projectsRoot,
  readClaudeChildSessionReferences,
  resolveClaudeDispatchReferences,
  type UsageEvent,
} from './transcript';

export interface SessionRoots {
  projects?: string;
  codexSessions?: string;
}

export type SessionSourceKind =
  | 'claude'
  | 'claude-subagent'
  | 'claude-session'
  | 'codex'
  | 'codex-thread'
  | 'claude-print';

export interface SessionSource {
  kind: SessionSourceKind;
  file: string;
  sessionId: string;
  agent?: string;
  invocationId?: string;
  requests?: SessionRequest[];
  failedToolTimestamps?: number[];
}

export interface SessionRequest extends UsageEvent {
  toolCalls: number;
  evidenceOnly?: true;
  billingRecord?: true;
  legacySnapshot?: true;
  compactionMetadata?: true;
  billedCoverage?: true;
  toolOnly?: true;
  failedToolCalls?: number;
  toolKinds?: string[];
  ownText?: string;
  launchedAgentIds?: string[];
  agentToolCallIds?: string[];
  structuredAgentIds?: string[];
  recordedSpeed?: string | null;
  recordedReconciled?: true;
  coverageDefect?: {
    kind: 'recorded-gaps' | 'billed-with-unknown-coverage' | 'unknown-request-coverage';
    until: number;
  };
}

interface CacheExpiryReport {
  coverage: 'complete' | 'unknown-request-coverage';
  returns: number;
  inputCostAfterExpiryUsd: number | null;
  byLifetime: Record<CacheTier, number>;
  byBoundary: { afterAUserTurn: number; insideOneTurn: number; turnUnknown: number };
  longestGapSeconds: number | null;
  unavailableLifetime: number;
  excludedAmbiguous: number;
  largest: {
    timestamp: string;
    gapSeconds: number;
    lifetime: CacheTier;
    boundary: keyof CacheExpiryReport['byBoundary'];
    model: string | null;
    inputCostUsd: number | null;
  }[];
}

export interface SessionCostSummary {
  requests: number;
  pricedRequests: number;
  unpricedRequests: number;
  requestCountExact?: false;
  coverage?:
    | 'recorded-reconciled'
    | 'recorded-gaps'
    | 'billed-with-unknown-coverage'
    | 'legacy-snapshots'
    | 'unknown-request-coverage';
  snapshotEvidence?: { count: number; inputTokens: number; outputTokens: number; toolCalls: number };
  unattributedToolCalls?: number;
  costUsd?: number | null;
  pricedCostUsd?: number;
  estimatedCostUsd?: number;
  costPerRequest?: number | null;
  costPerRequestByFifth?: (number | null)[];
  contextMean?: number | null;
  contextMax?: number | null;
  contextFirst?: number | null;
  uncachedInputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  cacheReadShareOfCost?: number | null;
  toolCalls?: number | null;
  requestsWithTwoOrMoreTools?: number | null;
  models?: string[];
  unpricedModels?: string[];
  failedToolCalls?: number;
  failedToolCallRequests?: number;
  failedToolCallCostUsd?: number | null;
  fastModeUnpricedRequests?: number;
  cacheExpiry?: CacheExpiryReport;
  modelCosts?: ModelCostSummary[];
}

export type ModelCostSummary = Pick<
  SessionCostSummary,
  | 'requests'
  | 'pricedRequests'
  | 'unpricedRequests'
  | 'requestCountExact'
  | 'coverage'
  | 'costUsd'
  | 'pricedCostUsd'
  | 'estimatedCostUsd'
  | 'uncachedInputTokens'
  | 'cachedInputTokens'
  | 'cacheWriteInputTokens'
  | 'outputTokens'
  | 'reasoningOutputTokens'
> & { model: string | null };

export interface SessionCostReport {
  source: Pick<SessionSource, 'kind' | 'file' | 'sessionId'>;
  window?: { since: string | null; until: string | null };
  parent: SessionCostSummary;
  children: (Pick<SessionSource, 'kind' | 'file' | 'sessionId' | 'agent' | 'invocationId'> & SessionCostSummary)[];
  combined: SessionCostSummary;
  byToolKind?: ToolKindReport;
  untilText?: { pattern: string; matched: boolean; byToolKind: ToolKindReport; note?: string };
  parentWindow?: {
    agentIdStartRequest: string;
    until: string | null;
    requests: number;
    costUsd: number | null;
    contextAtStart: number | null;
    contextAtPeak: number | null;
    byToolKind?: ToolKindReport;
  };
  rateNote: string;
  cacheExpiryNote: string;
}

interface ToolKindReport {
  rows: { kind: string; requests: number; costUsd: number; shareOfCost: number | null }[];
  unpricedRequests: number;
  requestsNote: string;
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function roundHalfEven(value: number): number {
  const lower = Math.floor(value);
  return value - lower === 0.5 && lower % 2 === 0 ? lower : Math.round(value);
}

function untilTextMatcher(pattern: string): RegExp {
  const flags = new Set(['m']);
  let source = pattern;
  let prefix: RegExpExecArray | null;
  while ((prefix = /^\(\?([ims]+)\)/.exec(source))) {
    for (const flag of prefix[1]) flags.add(flag);
    source = source.slice(prefix[0].length);
  }
  let translated = '';
  let inClass = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '\\' && index + 1 < source.length) {
      const next = source[++index];
      if (next === 'A' || next === 'Z') {
        if (inClass) throw new Error(`Invalid --until-text pattern: \\${next} cannot appear in a character class.`);
        translated += next === 'A' ? '(?<![\\s\\S])' : '(?![\\s\\S])';
      } else translated += `\\${next}`;
      continue;
    }
    if (char === '[') inClass = true;
    if (char === ']') inClass = false;
    translated += char;
  }
  try {
    return new RegExp(translated, [...flags].join(''));
  } catch (error) {
    throw new Error(`Invalid --until-text pattern: unsupported regex construct or syntax (${String(error)})`, {
      cause: error,
    });
  }
}

function inputTokens(request: SessionRequest): number {
  const usage = request.usage;
  return (
    usage.input +
    usage.cacheRead +
    usage.cacheWrite5m +
    usage.cacheWrite1h +
    (usage.cacheWrite30m ?? 0) +
    (request.unclassifiedCacheWrite ?? 0)
  );
}

function requestQuote(request: SessionRequest) {
  return request.incomplete || ((request.unclassifiedCacheWrite ?? 0) > 0 && typeof request.reportedCost !== 'number')
    ? null
    : quoteUsage({
        usage: request.usage,
        model: request.model,
        provider: request.provider,
        contextWindow: request.contextWindow,
        requestTokens: inputTokens(request),
        inferenceClass: request.inferenceClass,
        serviceTier: request.serviceTier,
        reportedCost: request.reportedCost,
      });
}

function cacheExpiry(requests: readonly SessionRequest[]): CacheExpiryReport {
  const report: CacheExpiryReport = {
    coverage: 'complete',
    returns: 0,
    inputCostAfterExpiryUsd: 0,
    byLifetime: { '5m': 0, '30m': 0, '1h': 0 },
    byBoundary: { afterAUserTurn: 0, insideOneTurn: 0, turnUnknown: 0 },
    longestGapSeconds: null,
    unavailableLifetime: 0,
    excludedAmbiguous: 0,
    largest: [],
  };
  const rows = requests.filter((request) => !request.evidenceOnly);
  for (let index = 1; index < rows.length; index++) {
    const before = rows[index - 1];
    const after = rows[index];
    if (!(after.usage.input || after.usage.cacheWrite5m || after.usage.cacheWrite1h || after.usage.cacheWrite30m))
      continue;
    if (
      !before.timestamp ||
      !after.timestamp ||
      after.timestamp < before.timestamp ||
      before.incomplete ||
      after.incomplete
    ) {
      report.unavailableLifetime++;
      continue;
    }
    const tiers: CacheTier[] = [];
    if (before.usage.cacheWrite5m) tiers.push('5m');
    if (before.usage.cacheWrite30m) tiers.push('30m');
    if (before.usage.cacheWrite1h) tiers.push('1h');
    const lifetime =
      before.agent === 'codex' && before.usage.cacheWrite30m
        ? cacheLifetimeFor(before.model, before.provider)
        : tiers.length === 1
          ? tiers[0]
          : tiers.length > 1
            ? null
            : before.usage.cacheRead
              ? cacheLifetimeFor(before.model, before.provider)
              : null;
    if (!lifetime) {
      report.unavailableLifetime++;
      continue;
    }
    const gapMs = after.timestamp - before.timestamp;
    if (gapMs < CACHE_LIFETIME_MS[lifetime]) continue;
    if (before.model !== after.model || before.compactionsBefore !== after.compactionsBefore) {
      report.excludedAmbiguous++;
      continue;
    }
    const beforeTurn = before.visibleTurnId;
    const afterTurn = after.visibleTurnId;
    const boundary =
      beforeTurn == null || afterTurn == null
        ? 'turnUnknown'
        : beforeTurn === afterTurn
          ? 'insideOneTurn'
          : 'afterAUserTurn';
    const usage = { ...after.usage, requests: 1, cacheRead: 0, output: 0, thinking: 0 };
    const quote =
      after.reportedCost !== null || after.incomplete || (after.unclassifiedCacheWrite ?? 0) > 0
        ? null
        : quoteUsage({
            usage,
            model: after.model,
            provider: after.provider,
            contextWindow: after.contextWindow,
            requestTokens: inputTokens(after),
            inferenceClass: after.inferenceClass,
            serviceTier: after.serviceTier,
            reportedCost: null,
          });
    if (!quote) report.inputCostAfterExpiryUsd = null;
    else if (report.inputCostAfterExpiryUsd !== null) report.inputCostAfterExpiryUsd += quote.cost;
    report.returns++;
    report.byLifetime[lifetime]++;
    report.byBoundary[boundary]++;
    const gapSeconds = Math.round(gapMs / 1000);
    report.longestGapSeconds = Math.max(report.longestGapSeconds ?? 0, gapSeconds);
    report.largest.push({
      timestamp: new Date(after.timestamp).toISOString(),
      gapSeconds,
      lifetime,
      boundary,
      model: after.model,
      inputCostUsd: quote ? round(quote.cost, 4) : null,
    });
  }
  if (report.inputCostAfterExpiryUsd !== null)
    report.inputCostAfterExpiryUsd = round(report.inputCostAfterExpiryUsd, 4);
  report.largest.sort((a, b) => (b.inputCostUsd ?? -1) - (a.inputCostUsd ?? -1));
  report.largest = report.largest.slice(0, 5);
  return report;
}

function modelCosts(
  requests: readonly SessionRequest[],
  costs: ReturnType<typeof requestQuote>[],
  source: SessionCostSummary,
): ModelCostSummary[] {
  const rows = new Map<string | null, ModelCostSummary & { total: number; estimated: number; legacy: boolean }>();
  for (let index = 0; index < requests.length; index++) {
    const request = requests[index];
    const model = request.model || null;
    let row = rows.get(model);
    if (!row) {
      row = {
        model,
        requests: 0,
        pricedRequests: 0,
        unpricedRequests: 0,
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        total: 0,
        estimated: 0,
        legacy: false,
      };
      rows.set(model, row);
    }
    row.requests++;
    const quote = costs[index];
    if (quote) {
      row.pricedRequests++;
      row.total += quote.cost;
      if (request.legacySnapshot) row.estimated += quote.cost;
    } else row.unpricedRequests++;
    row.legacy ||= request.legacySnapshot === true;
    row.uncachedInputTokens! += request.usage.input;
    row.cachedInputTokens! += request.usage.cacheRead;
    row.cacheWriteInputTokens! +=
      request.usage.cacheWrite5m +
      request.usage.cacheWrite1h +
      (request.usage.cacheWrite30m ?? 0) +
      (request.unclassifiedCacheWrite ?? 0);
    row.outputTokens! += request.usage.output;
    row.reasoningOutputTokens! += request.usage.thinking;
  }
  return [...rows.values()]
    .sort((left, right) =>
      left.model === null
        ? right.model === null
          ? 0
          : -1
        : right.model === null
          ? 1
          : left.model < right.model
            ? -1
            : left.model > right.model
              ? 1
              : 0,
    )
    .map(({ total, estimated, legacy, ...row }) => ({
      ...row,
      ...(source.requestCountExact === false ? { requestCountExact: false as const } : {}),
      ...(source.coverage ? { coverage: source.coverage } : {}),
      costUsd:
        (!source.coverage || source.coverage === 'recorded-reconciled') && row.unpricedRequests === 0
          ? round(total, 4)
          : null,
      pricedCostUsd: round(total - estimated, 4),
      ...(legacy ? { estimatedCostUsd: round(estimated, 4) } : {}),
    }));
}

export function summarizeRequests(
  requests: readonly SessionRequest[],
  codexFailures?: number,
  byModel = false,
): SessionCostSummary {
  const evidence = requests.filter((request) => request.evidenceOnly);
  const snapshots = evidence.filter((request) => !request.toolOnly && !request.coverageDefect);
  const pricedRequests = requests.filter((request) => !request.evidenceOnly);
  const count = pricedRequests.length;
  const summary: SessionCostSummary = { requests: count, pricedRequests: 0, unpricedRequests: 0 };
  const failedRequests = pricedRequests.filter((request) => (request.failedToolCalls ?? 0) > 0);
  const failedToolCalls =
    (codexFailures ?? 0) + failedRequests.reduce((sum, request) => sum + (request.failedToolCalls ?? 0), 0);
  const expiry = cacheExpiry(requests);
  const diagnostics = {
    failedToolCalls,
    failedToolCallRequests: failedRequests.length,
    failedToolCallCostUsd: codexFailures ? null : (0 as number | null),
    fastModeUnpricedRequests: 0,
    cacheExpiry: expiry,
  };
  if (snapshots.length)
    summary.snapshotEvidence = {
      count: snapshots.length,
      inputTokens: snapshots.reduce((sum, request) => sum + inputTokens(request), 0),
      outputTokens: snapshots.reduce((sum, request) => sum + request.usage.output, 0),
      toolCalls: snapshots.reduce((sum, request) => sum + request.toolCalls, 0),
    };
  const toolOnly = evidence.reduce((sum, request) => sum + (request.toolOnly ? request.toolCalls : 0), 0);
  if (toolOnly) summary.unattributedToolCalls = toolOnly;
  const billedEvidence = evidence.some((request) => request.billedCoverage);
  const billed = pricedRequests.some((request) => request.billingRecord);
  const legacy = pricedRequests.some((request) => request.legacySnapshot);
  const coverage = requests.some((request) => request.coverageDefect?.kind === 'recorded-gaps')
    ? 'recorded-gaps'
    : requests.some((request) => request.coverageDefect?.kind === 'billed-with-unknown-coverage') ||
        pricedRequests.some((request) => request.billingRecord && !request.recordedReconciled) ||
        evidence.some((request) => request.billedCoverage && !request.recordedReconciled)
      ? 'billed-with-unknown-coverage'
      : legacy
        ? 'legacy-snapshots'
        : evidence.some((request) => !request.recordedReconciled)
          ? 'unknown-request-coverage'
          : billed || billedEvidence
            ? 'recorded-reconciled'
            : undefined;
  const uncertainCoverage = coverage !== undefined && coverage !== 'recorded-reconciled';
  if (!count) {
    if (byModel) summary.modelCosts = [];
    if (evidence.length) {
      diagnostics.cacheExpiry.coverage = 'unknown-request-coverage';
      diagnostics.cacheExpiry.inputCostAfterExpiryUsd = null;
    }
    Object.assign(summary, diagnostics);
    if (coverage) summary.coverage = coverage;
    if (uncertainCoverage) {
      summary.requestCountExact = false;
      summary.costUsd = null;
      summary.toolCalls = null;
      summary.requestsWithTwoOrMoreTools = null;
      summary.cacheReadShareOfCost = null;
    }
    return summary;
  }
  const toolEvidenceExact = !billed && !billedEvidence && !uncertainCoverage;
  if (
    !toolEvidenceExact ||
    pricedRequests.some((request) => request.requestCountExact === false || request.incomplete)
  ) {
    diagnostics.cacheExpiry.coverage = 'unknown-request-coverage';
    diagnostics.cacheExpiry.inputCostAfterExpiryUsd = null;
  }
  const requestCountExact =
    !uncertainCoverage && pricedRequests.every((request) => request.requestCountExact !== false);
  const contextExact = requestCountExact && pricedRequests.every((request) => !request.incomplete);
  const costs = pricedRequests.map(requestQuote);
  const priced = costs.filter((quote) => quote !== null);
  const total = priced.reduce((sum, quote) => sum + quote.cost, 0);
  const estimated = costs.reduce(
    (sum, quote, index) => sum + (pricedRequests[index].legacySnapshot ? (quote?.cost ?? 0) : 0),
    0,
  );
  const allPriced = priced.length === count;
  const contexts = pricedRequests.map(inputTokens);
  const fifths: (number | null)[] = [];
  for (let index = 0; index < Math.min(5, count); index++) {
    const start = Math.floor((index * count) / Math.min(5, count));
    const end = Math.floor(((index + 1) * count) / Math.min(5, count));
    const part = costs.slice(start, end);
    fifths.push(
      requestCountExact && part.every((quote) => quote !== null)
        ? round(part.reduce((sum, quote) => sum + quote.cost, 0) / part.length, 4)
        : null,
    );
  }
  const readCost = costs.reduce((sum, quote, index) => {
    if (!quote?.rate) return sum;
    const rate = quote.rate.cacheRead ?? quote.rate.input * 0.1;
    return sum + (pricedRequests[index].usage.cacheRead * rate) / 1_000_000;
  }, 0);
  const models = new Set<string>();
  const unpricedModels = new Set<string>();
  for (let index = 0; index < count; index++) {
    const model = pricedRequests[index].model;
    if (model) models.add(model);
    if (
      !costs[index] &&
      !quoteUsage({
        usage: pricedRequests[index].usage,
        model: model ?? null,
        provider: pricedRequests[index].provider,
        contextWindow: pricedRequests[index].contextWindow,
        requestTokens: inputTokens(pricedRequests[index]),
        inferenceClass: pricedRequests[index].inferenceClass,
        serviceTier: null,
      })
    )
      unpricedModels.add(model ?? 'unknown');
  }
  const failedCosts = failedRequests.map(requestQuote);
  diagnostics.failedToolCallCostUsd =
    !codexFailures && failedCosts.every((quote) => quote !== null)
      ? round(
          failedCosts.reduce((sum, quote) => sum + quote.cost, 0),
          4,
        )
      : null;
  diagnostics.fastModeUnpricedRequests = pricedRequests.filter(
    (request, index) => costs[index] === null && !!request.recordedSpeed && request.recordedSpeed !== 'standard',
  ).length;
  const result: SessionCostSummary = {
    requests: count,
    pricedRequests: priced.length,
    unpricedRequests: count - priced.length,
    ...(requestCountExact ? {} : { requestCountExact: false as const }),
    ...(coverage ? { coverage } : {}),
    ...(summary.snapshotEvidence ? { snapshotEvidence: summary.snapshotEvidence } : {}),
    ...(summary.unattributedToolCalls ? { unattributedToolCalls: summary.unattributedToolCalls } : {}),
    costUsd: allPriced && !uncertainCoverage ? round(total, 4) : null,
    pricedCostUsd: round(total - estimated, 4),
    ...(legacy ? { estimatedCostUsd: round(estimated, 4) } : {}),
    costPerRequest: allPriced && requestCountExact ? round(total / count, 4) : null,
    costPerRequestByFifth: fifths,
    contextMean: contextExact ? roundHalfEven(contexts.reduce((sum, value) => sum + value, 0) / count) : null,
    contextMax: contextExact ? contexts.reduce((max, value) => Math.max(max, value), 0) : null,
    contextFirst: contextExact ? contexts[0] : null,
    uncachedInputTokens: pricedRequests.reduce((sum, request) => sum + request.usage.input, 0),
    cachedInputTokens: pricedRequests.reduce((sum, request) => sum + request.usage.cacheRead, 0),
    cacheWriteInputTokens: pricedRequests.reduce(
      (sum, request) =>
        sum +
        request.usage.cacheWrite5m +
        request.usage.cacheWrite1h +
        (request.usage.cacheWrite30m ?? 0) +
        (request.unclassifiedCacheWrite ?? 0),
      0,
    ),
    outputTokens: pricedRequests.reduce((sum, request) => sum + request.usage.output, 0),
    reasoningOutputTokens: pricedRequests.reduce((sum, request) => sum + request.usage.thinking, 0),
    cacheReadShareOfCost:
      requestCountExact && allPriced && priced.every((quote) => quote.rate !== null) && total > 0
        ? round(readCost / total, 3)
        : null,
    toolCalls:
      requestCountExact && toolEvidenceExact
        ? pricedRequests.reduce((sum, request) => sum + request.toolCalls, 0)
        : null,
    requestsWithTwoOrMoreTools:
      requestCountExact && toolEvidenceExact ? pricedRequests.filter((request) => request.toolCalls >= 2).length : null,
    models: [...models].sort(),
    unpricedModels: [...unpricedModels].sort(),
    ...diagnostics,
  };
  if (byModel) result.modelCosts = modelCosts(pricedRequests, costs, result);
  return result;
}

function windowTime(value: string | number | undefined, name: string): number | null {
  if (value === undefined) return null;
  if (typeof value === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
    if (!match) throw new Error(`Invalid ${name} time: ${value}`);
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6] ?? 0);
    const offsetHour = Number(match[8] ?? 0);
    const offsetMinute = Number(match[9] ?? 0);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > days[month - 1] ||
      hour > 23 ||
      minute > 59 ||
      second > 59 ||
      offsetHour > 23 ||
      offsetMinute > 59
    ) {
      throw new Error(`Invalid ${name} time: ${value}`);
    }
  }
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${name} time: ${value}`);
  }
  return parsed;
}

export function sessionCostReport(
  file: string,
  options: {
    since?: string | number;
    until?: string | number;
    roots?: SessionRoots;
    byToolKind?: boolean;
    untilText?: string;
    windowAgent?: string;
    byModel?: boolean;
    sourceOnly?: boolean;
  } = {},
): SessionCostReport {
  const since = windowTime(options.since, 'since');
  const until = windowTime(options.until, 'until');
  if (since !== null && until !== null && until < since) throw new Error('Until must be at or after since');
  const sources = sessionSources(file, options.roots, options.sourceOnly);
  const inWindow = (request: SessionRequest) =>
    request.coverageDefect
      ? (since === null || request.coverageDefect.until > since) && (until === null || request.timestamp < until)
      : (since === null || request.timestamp >= since) && (until === null || request.timestamp < until);
  const allRequestsFor = (source: SessionSource) =>
    source.requests ?? readSessionRequests(source.file, source.kind, source.invocationId);
  const requestsFor = (source: SessionSource) => allRequestsFor(source).filter(inWindow);
  const failureCount = (source: SessionSource) =>
    source.failedToolTimestamps?.filter((at) => (since === null || at >= since) && (until === null || at < until))
      .length;
  const parent = sources[0];
  const allParentRequests = allRequestsFor(parent);
  const parentRequests = allParentRequests.filter(inWindow);
  const children = sources.slice(1).map((source) => ({ source, requests: requestsFor(source) }));
  const firstRequestTime = (requests: readonly SessionRequest[]) =>
    requests.reduce((first, request) => Math.min(first, request.timestamp), Infinity);
  const retained = children
    .filter(
      ({ source, requests }) =>
        (since === null && until === null) || requests.length > 0 || (failureCount(source) ?? 0) > 0,
    )
    .sort((left, right) => firstRequestTime(left.requests) - firstRequestTime(right.requests));
  const all = options.sourceOnly
    ? parentRequests
    : [...parentRequests, ...retained.flatMap(({ requests }) => requests)].sort(
        (left, right) => left.timestamp - right.timestamp,
      );
  const sol = PROMOTIONS.find(({ pattern }) => pattern.test('gpt-5.6-sol'))?.promo;
  const parentSummary = summarizeRequests(parentRequests, failureCount(parent), options.byModel);
  const childReports = retained.map(({ source, requests }) => ({
    kind: source.kind,
    file: source.file,
    sessionId: source.sessionId,
    ...(source.agent ? { agent: source.agent } : {}),
    ...(source.invocationId ? { invocationId: source.invocationId } : {}),
    ...summarizeRequests(requests, failureCount(source), options.byModel),
  }));
  const combinedFailureCount = [parent, ...retained.map(({ source }) => source)].map(failureCount);
  const combinedSummary = summarizeRequests(
    all,
    combinedFailureCount.some((count) => count !== undefined)
      ? combinedFailureCount.reduce<number>((sum, count) => sum + (count ?? 0), 0)
      : undefined,
  );
  const expiries = [parentSummary, ...childReports].map((summary) => summary.cacheExpiry!);
  combinedSummary.cacheExpiry = {
    coverage: expiries.every((item) => item.coverage === 'complete') ? 'complete' : 'unknown-request-coverage',
    returns: expiries.reduce((sum, item) => sum + item.returns, 0),
    inputCostAfterExpiryUsd: expiries.every((item) => item.inputCostAfterExpiryUsd !== null)
      ? round(
          expiries.reduce((sum, item) => sum + item.inputCostAfterExpiryUsd!, 0),
          4,
        )
      : null,
    byLifetime: { '5m': 0, '30m': 0, '1h': 0 },
    byBoundary: { afterAUserTurn: 0, insideOneTurn: 0, turnUnknown: 0 },
    longestGapSeconds: null,
    unavailableLifetime: expiries.reduce((sum, item) => sum + item.unavailableLifetime, 0),
    excludedAmbiguous: expiries.reduce((sum, item) => sum + item.excludedAmbiguous, 0),
    largest: [],
  };
  for (const expiry of expiries) {
    for (const lifetime of ['5m', '30m', '1h'] as const)
      combinedSummary.cacheExpiry.byLifetime[lifetime] += expiry.byLifetime[lifetime];
    for (const boundary of ['afterAUserTurn', 'insideOneTurn', 'turnUnknown'] as const)
      combinedSummary.cacheExpiry.byBoundary[boundary] += expiry.byBoundary[boundary];
    if (expiry.longestGapSeconds !== null)
      combinedSummary.cacheExpiry.longestGapSeconds = Math.max(
        combinedSummary.cacheExpiry.longestGapSeconds ?? 0,
        expiry.longestGapSeconds,
      );
    combinedSummary.cacheExpiry.largest.push(...expiry.largest);
  }
  combinedSummary.cacheExpiry.largest.sort((a, b) => (b.inputCostUsd ?? -1) - (a.inputCostUsd ?? -1));
  combinedSummary.cacheExpiry.largest = combinedSummary.cacheExpiry.largest.slice(0, 5);
  const byToolKind = options.byToolKind ? toolKindCosts(parentRequests) : undefined;
  let untilText: SessionCostReport['untilText'];
  if (options.untilText) {
    const matcher = untilTextMatcher(options.untilText);
    const cutoff = parentRequests.findIndex((request) => matcher.test(request.ownText ?? ''));
    untilText = {
      pattern: options.untilText,
      matched: cutoff >= 0,
      byToolKind: toolKindCosts(cutoff < 0 ? parentRequests : parentRequests.slice(0, cutoff)),
      ...(cutoff < 0 ? { note: 'No assistant text matched the pattern, so every request is counted.' } : {}),
    };
  }
  let parentWindow: SessionCostReport['parentWindow'];
  if (options.windowAgent) {
    const agentId = options.windowAgent.replace(/^agent-/, '').replace(/\.jsonl$/, '');
    let launch = allParentRequests.findIndex((request) => request.structuredAgentIds?.includes(agentId));
    if (launch < 0) {
      const meta = path.join(
        path.dirname(parent.file),
        path.basename(parent.file, '.jsonl'),
        'subagents',
        `agent-${agentId}.meta.json`,
      );
      try {
        const saved = JSON.parse(fs.readFileSync(meta, 'utf8')) as { toolUseId?: string };
        const owner = allParentRequests.findIndex(
          (request) => request.requestKey && request.agentToolCallIds?.includes(saved.toolUseId ?? ''),
        );
        launch = owner;
      } catch {
        /* The launch result remains the source when no metadata file exists. */
      }
    }
    if (launch < 0) launch = allParentRequests.findIndex((request) => request.launchedAgentIds?.includes(agentId));
    if (launch < 0) throw new Error(`No Agent launch found for agent id ${agentId} in ${parent.file}`);
    const rows = allParentRequests.slice(launch).filter((request) => until === null || request.timestamp <= until);
    const costs = rows.map(requestQuote);
    parentWindow = {
      agentIdStartRequest: allParentRequests[launch].requestKey.replace(/^claude:/, ''),
      until: until === null ? null : new Date(until).toISOString(),
      requests: rows.length,
      costUsd: costs.every((quote) => quote !== null)
        ? round(
            costs.reduce((sum, quote) => sum + quote.cost, 0),
            4,
          )
        : null,
      contextAtStart: rows.length ? inputTokens(rows[0]) : null,
      contextAtPeak: rows.length ? rows.reduce((peak, request) => Math.max(peak, inputTokens(request)), 0) : null,
      ...(options.byToolKind ? { byToolKind: toolKindCosts(rows) } : {}),
    };
  }
  return {
    source: { kind: parent.kind, file: parent.file, sessionId: parent.sessionId },
    ...(since !== null || until !== null
      ? {
          window: {
            since: since === null ? null : new Date(since).toISOString(),
            until: until === null ? null : new Date(until).toISOString(),
          },
        }
      : {}),
    parent: parentSummary,
    children: childReports,
    combined: combinedSummary,
    ...(byToolKind ? { byToolKind } : {}),
    ...(untilText ? { untilText } : {}),
    ...(parentWindow ? { parentWindow } : {}),
    rateNote: `List-price estimate, not a subscription charge.${sol ? ` GPT-5.6 Sol uses its promotional rate through ${sol.until}.` : ''}`,
    cacheExpiryNote:
      'Codex cache-write counters establish volume, not lifetime. The model and provider establish documented lifetime. Claude child prompts have no visible turn boundary. Unknown request coverage makes observed adjacency uncertain and leaves the expiry input total unpriced.',
  };
}

function projectStore(roots: SessionRoots): string {
  return roots.projects ?? projectsRoot();
}
function codexStore(roots: SessionRoots): string {
  return roots.codexSessions ?? codexSessionsRoot();
}

export function findSessionTranscript(target: string, roots: SessionRoots = {}, sourceOnly = false): string {
  const direct = path.resolve(target);
  if (fs.existsSync(direct)) {
    if (!fs.statSync(direct).isFile()) {
      throw new Error(`Transcript is not a file: ${direct}`);
    }
    return direct;
  }
  if (sourceOnly) throw new Error(`--source-only requires an existing transcript file path: ${target}`);
  const matches: string[] = [];
  try {
    for (const project of fs.readdirSync(projectStore(roots), { withFileTypes: true })) {
      if (project.isDirectory()) {
        const candidate = path.join(projectStore(roots), project.name, `${target}.jsonl`);
        if (fs.existsSync(candidate)) matches.push(candidate);
      }
    }
  } catch {
    // An absent store contributes no matches.
  }
  for (const file of rolloutFiles(codexStore(roots))) {
    if (path.basename(file).endsWith(`-${target}.jsonl`)) matches.push(file);
  }
  if (matches.length === 0) throw new Error(`No transcript found for ${target}`);
  if (matches.length > 1) throw new Error(`More than one transcript matched ${target}: ${matches.join(', ')}`);
  return matches[0];
}

function isCodex(file: string): boolean {
  return /^rollout-.*\.jsonl$/.test(path.basename(file)) || readCodexSessionMeta(file) !== null;
}

function claudeSourceId(file: string): string {
  return path.basename(file, '.jsonl').replace(/^agent-/, '');
}

function claudeToolIds(line: string): {
  key: string;
  tools: { id: string; name: string; input: unknown }[];
  text: string;
  speed: string | null;
  sidechain: boolean;
} | null {
  if (!line.includes('"assistant"')) return null;
  try {
    const record = JSON.parse(line) as {
      type?: string;
      uuid?: string;
      timestamp?: string;
      message?: {
        id?: string;
        model?: string;
        usage?: { speed?: string };
        content?: string | { type?: string; id?: string; name?: string; input?: unknown; text?: string }[];
      };
      isSidechain?: boolean;
    };
    if (record.type !== 'assistant' || record.message?.model === '<synthetic>') return null;
    const blocks = Array.isArray(record.message?.content) ? record.message.content : [];
    const tools = blocks
      .filter((item) => item.type === 'tool_use' && item.id)
      .map((item) => ({
        id: item.id as string,
        name: item.name ?? '',
        input: item.input,
      }));
    const at = Date.parse(record.timestamp ?? '');
    return {
      key: `claude:${record.message?.id || record.uuid || `${Number.isNaN(at) ? '' : at}:${record.message?.model ?? ''}`}`,
      tools,
      speed: record.message?.usage?.speed ?? null,
      sidechain: record.isSidechain === true,
      text:
        typeof record.message?.content === 'string'
          ? record.message.content
          : blocks.map((item) => item.text ?? '').join(''),
    };
  } catch {
    return null;
  }
}

const TOOL_KINDS = ['git', 'file read', 'search', 'test or build', 'subagent launch', 'other', 'no tool result'];

function shellWords(segment: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < segment.length; index++) {
    const character = segment[index];
    if (character === '\\' && quote !== "'" && index + 1 < segment.length && /[\\"'\s]/.test(segment[index + 1])) {
      word += segment[++index];
    } else if (character === quote) {
      quote = null;
    } else if ((character === '"' || character === "'") && quote === null) {
      quote = character;
    } else if (/\s/.test(character) && quote === null) {
      if (word) {
        words.push(word);
        word = '';
      }
    } else {
      word += character;
    }
  }
  if (word) words.push(word);
  return words;
}

function shellKind(command: string): string {
  const segments = command
    .replace(/(<<-?\s*['"]?(\w+)['"]?[^\n]*\n)[\s\S]*?^\s*\2\s*$/gm, '$1')
    .split(/&&|\|\||;|\r?\n/);
  for (const segment of segments) {
    const words = shellWords(segment.trim());
    if (!words.length || /^\$(?:env:)?[A-Za-z_]\w*\s*=/.test(segment.trim())) continue;
    let index = 0;
    while (index < words.length && /^[A-Za-z_]\w*=/.test(words[index])) index++;
    const program = words[index]
      ?.replaceAll('\\', '/')
      .split('/')
      .at(-1)
      ?.replace(/\.exe$/i, '')
      .toLowerCase();
    if (!program || program === 'cd' || program === 'set-location') continue;
    const args = words.slice(index + 1);
    if (program === 'git') return 'git';
    if (['cat', 'head', 'tail', 'less', 'type', 'get-content'].includes(program))
      return program === 'cat' && args.some((word) => word.startsWith('>')) ? 'other' : 'file read';
    if (['rg', 'grep', 'find', 'ls', 'select-string', 'get-childitem'].includes(program)) return 'search';
    if (['npm', 'npx', 'pnpm', 'yarn', 'pytest', 'vitest', 'tsc', 'make', 'cargo', 'dotnet'].includes(program))
      return 'test or build';
    if (program === 'sed') return args.includes('-n') ? 'file read' : 'other';
    if (program === 'python' || program === 'python3')
      return args[0] === '-m' && ['pytest', 'unittest'].includes(args[1]) ? 'test or build' : 'other';
    if (program === 'go') return args[0] === 'test' ? 'test or build' : 'other';
    if (program === 'node') return args.includes('--test') ? 'test or build' : 'other';
    return 'other';
  }
  return 'other';
}

function toolKind(name: string, input: unknown): string {
  if (name === 'Agent' || name === 'Task') return 'subagent launch';
  if (name === 'Read') return 'file read';
  if (name === 'Grep' || name === 'Glob') return 'search';
  if (name === 'Bash' || name === 'PowerShell')
    return shellKind(
      typeof input === 'object' && input !== null && 'command' in input && typeof input.command === 'string'
        ? input.command
        : '',
    );
  return 'other';
}

function stringLeaves(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(stringLeaves);
  return [];
}

function toolKindCosts(requests: readonly SessionRequest[]): ToolKindReport {
  const totals = new Map(TOOL_KINDS.map((kind) => [kind, { requests: 0, cost: 0 }]));
  let unpricedRequests = 0;
  for (const request of requests.filter((row) => !row.evidenceOnly)) {
    const kinds = request.toolKinds?.length ? request.toolKinds : ['no tool result'];
    for (const kind of new Set(kinds)) totals.get(kind)!.requests++;
    const quote = requestQuote(request);
    if (!quote) {
      unpricedRequests++;
      continue;
    }
    for (const kind of kinds) totals.get(kind)!.cost += quote.cost / kinds.length;
  }
  const total = [...totals.values()].reduce((sum, row) => sum + row.cost, 0);
  return {
    rows: TOOL_KINDS.flatMap((kind) => {
      const row = totals.get(kind)!;
      return row.requests || row.cost
        ? [
            {
              kind,
              requests: row.requests,
              costUsd: round(row.cost, 4),
              shareOfCost: total ? round(row.cost / total, 4) : null,
            },
          ]
        : [];
    }),
    unpricedRequests,
    requestsNote:
      'Requests counts a request once for every kind it touches, so counts across kinds can exceed the request total.',
  };
}

function codexToolCall(line: string): { id: string; timestamp: number } | null {
  if (!/"(?:custom_tool_call|function_call|web_search_call)"/.test(line)) return null;
  try {
    const record = JSON.parse(line) as {
      type?: string;
      timestamp?: string;
      payload?: { type?: string; call_id?: string; id?: string };
    };
    const kind = record.type === 'event_msg' || record.type === 'response_item' ? record.payload?.type : record.type;
    return kind === 'custom_tool_call' || kind === 'function_call' || kind === 'web_search_call'
      ? {
          id: record.payload?.call_id ?? record.payload?.id ?? line,
          timestamp: Date.parse(record.timestamp ?? '') || 0,
        }
      : null;
  } catch {
    return null;
  }
}

function codexSnapshotRecord(line: string): { kind: string; zeroUsage: boolean } | null {
  if (!/"(?:compacted|task_started|task_complete|turn_aborted|token_count)"/.test(line)) return null;
  try {
    const record = JSON.parse(line) as {
      type?: string;
      payload?: { type?: string; info?: { last_token_usage?: Record<string, unknown> } };
    };
    const kind = record.type === 'event_msg' ? record.payload?.type : record.type;
    if (kind !== 'token_count') return kind ? { kind, zeroUsage: false } : null;
    const usage = record.payload?.info?.last_token_usage;
    const zeroUsage =
      usage?.input_tokens === 0 &&
      usage.output_tokens === 0 &&
      usage.total_tokens === 0 &&
      ['cached_input_tokens', 'cache_write_input_tokens', 'reasoning_output_tokens'].every(
        (field) => usage[field] === undefined || usage[field] === 0,
      );
    return { kind, zeroUsage };
  } catch {
    return null;
  }
}

type CodexCostVector = readonly number[];
interface CodexBillEvidence {
  turnId: string;
  request: SessionRequest;
  order: number;
  segment: number;
  threadId: string | null;
  usage: CodexCostVector | null;
  thread: CodexCostVector | null;
  turn: CodexCostVector | null;
  observations: { order: number; segment: number; thread: CodexCostVector | null }[];
  conflicted?: true;
}
interface CodexCostSnapshot {
  turnId: string;
  timestamp: number;
  order: number;
  segment: number;
  total: CodexCostVector | null;
  last: CodexCostVector | null;
  matched?: true;
}

// Snapshot records omit a zero cache-write counter on some client versions.
function costVector(value: unknown): CodexCostVector | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  const vector = [
    fields.input_tokens,
    fields.cached_input_tokens,
    fields.cache_write_input_tokens ?? 0,
    fields.output_tokens,
    fields.reasoning_output_tokens,
    fields.total_tokens,
  ];
  if (!vector.every((item): item is number => typeof item === 'number' && Number.isFinite(item) && item >= 0))
    return null;
  return vector[0] >= vector[1] + vector[2] && vector[3] >= vector[4] && vector[5] === vector[0] + vector[3]
    ? vector
    : null;
}

function equalCostVector(left: CodexCostVector | null, right: CodexCostVector | null): boolean {
  return left !== null && right !== null && left.every((value, index) => value === right[index]);
}

function matchCostSnapshots(
  bills: readonly CodexBillEvidence[],
  snapshots: readonly CodexCostSnapshot[],
  openingId: string | null,
) {
  const queues = new Map<string, { rows: CodexCostSnapshot[]; next: number }>();
  const key = (segment: number, turnId: string, total: CodexCostVector, last: CodexCostVector) =>
    JSON.stringify([segment, turnId, total, last]);
  for (const snapshot of snapshots) {
    if (!snapshot.total || !snapshot.last) continue;
    const id = key(snapshot.segment, snapshot.turnId, snapshot.total, snapshot.last);
    const queue = queues.get(id) ?? { rows: [], next: 0 };
    queue.rows.push(snapshot);
    queues.set(id, queue);
  }
  const matches = new Map<CodexBillEvidence, CodexCostSnapshot>();
  for (const bill of bills) {
    if (
      !openingId ||
      bill.threadId !== openingId ||
      bill.conflicted ||
      bill.request.incomplete ||
      !bill.thread ||
      !bill.usage
    )
      continue;
    const exact = queues.get(key(bill.segment, bill.turnId, bill.thread, bill.usage));
    const zero = queues.get(
      key(
        bill.segment,
        bill.turnId,
        bill.thread,
        bill.usage.map(() => 0),
      ),
    );
    const queue =
      exact &&
      exact.next < exact.rows.length &&
      (!zero || zero.next >= zero.rows.length || exact.rows[exact.next].order < zero.rows[zero.next].order)
        ? exact
        : zero;
    if (queue && queue.next < queue.rows.length) matches.set(bill, queue.rows[queue.next++]);
  }
  return matches;
}

function classifyCostSegments(
  bills: readonly CodexBillEvidence[],
  snapshots: CodexCostSnapshot[],
  boundaries: { timestamp: number; segment: number; turnId: string | null; order: number }[],
  openingId: string | null,
) {
  const pending = new Map<string, { rows: CodexBillEvidence[]; next: number }>();
  const consumed = new Set<CodexBillEvidence>();
  const key = (segment: number, turnId: string, total: CodexCostVector, last: CodexCostVector) =>
    JSON.stringify([segment, turnId, total, last]);
  const predecessors = new Map<CodexBillEvidence, CodexBillEvidence>();
  const turnPredecessors = new Map<CodexBillEvidence, CodexBillEvidence>();
  const turnBills = new Map<string, CodexBillEvidence>();
  let prior: CodexBillEvidence | null = null;
  for (const bill of bills) {
    if (prior && prior.segment !== bill.segment) {
      prior = null;
      turnBills.clear();
    }
    if (
      openingId &&
      bill.threadId === openingId &&
      !bill.conflicted &&
      !bill.request.incomplete &&
      bill.thread &&
      bill.usage
    ) {
      for (const last of [bill.usage, bill.usage.map(() => 0)]) {
        const id = key(bill.segment, bill.turnId, bill.thread, last);
        const queue = pending.get(id) ?? { rows: [], next: 0 };
        queue.rows.push(bill);
        pending.set(id, queue);
      }
    }
    if (prior) predecessors.set(bill, prior);
    const priorTurn = turnBills.get(bill.turnId);
    if (priorTurn) turnPredecessors.set(bill, priorTurn);
    if (bill.threadId === openingId) {
      prior = bill;
      if (bill.turn) turnBills.set(bill.turnId, bill);
    }
  }
  const observations = bills.flatMap((bill) =>
    bill.threadId === openingId && !bill.conflicted
      ? bill.observations.map((observation) => ({ ...observation, bill }))
      : [],
  );
  const arrivals = [
    ...observations.map((observation) => ({ order: observation.order, observation })),
    ...snapshots.map((snapshot) => ({ order: snapshot.order, snapshot, originalSegment: snapshot.segment })),
    ...boundaries.map((boundary) => ({ order: boundary.order, boundary })),
    ...bills.map((bill) => ({ order: bill.order, bill })),
  ].sort((left, right) => left.order - right.order);
  let segment = 0;
  let segmentStart = 0;
  let frontier: CodexCostVector | null = null;
  let previous: CodexCostSnapshot | null = null;
  let progress = 0;
  let previousProgress = -1;
  const retained: CodexCostSnapshot[] = [];
  for (const arrival of arrivals) {
    if ('boundary' in arrival) {
      arrival.boundary.segment = ++segment;
      segmentStart = arrival.order;
      frontier = null;
      previous = null;
    } else if ('bill' in arrival) {
      arrival.bill.segment = segment;
    } else if ('observation' in arrival) {
      if (arrival.observation.thread) {
        const counter = arrival.observation.thread;
        const advanced: CodexCostVector = frontier
          ? counter.map((value, index) => Math.max(value, frontier![index]))
          : counter;
        if (!equalCostVector(frontier, advanced)) progress++;
        frontier = advanced;
      }
    } else {
      const snapshot = arrival.snapshot;
      const duplicate =
        previous &&
        previousProgress === progress &&
        previous.turnId === snapshot.turnId &&
        equalCostVector(previous.total, snapshot.total) &&
        equalCostVector(previous.last, snapshot.last);
      snapshot.segment = segment;
      if (duplicate) continue;
      const queue =
        snapshot.total && snapshot.last
          ? pending.get(key(arrival.originalSegment, snapshot.turnId, snapshot.total, snapshot.last))
          : undefined;
      if (queue) {
        while (
          queue.next < queue.rows.length &&
          (consumed.has(queue.rows[queue.next]) || queue.rows[queue.next].order <= segmentStart)
        )
          queue.next++;
      }
      const candidate = queue?.rows[queue.next];
      const predecessor = candidate ? predecessors.get(candidate) : undefined;
      const priorTurn = candidate ? turnPredecessors.get(candidate) : undefined;
      const threadBaseline = predecessor && predecessor.order > segmentStart ? predecessor.thread : null;
      const turnBaseline = priorTurn && priorTurn.order > segmentStart ? priorTurn.turn : null;
      const expectedThread = candidate?.usage?.map((value, index) => value + (threadBaseline?.[index] ?? 0)) ?? null;
      const expectedTurn = candidate?.usage?.map((value, index) => value + (turnBaseline?.[index] ?? 0)) ?? null;
      const delayedMatch =
        candidate &&
        (candidate.order >= snapshot.order || candidate.segment === segment) &&
        equalCostVector(candidate.thread, expectedThread) &&
        equalCostVector(candidate.turn, expectedTurn);
      if (delayedMatch) {
        consumed.add(candidate);
        queue.next++;
      }
      const reset =
        !delayedMatch &&
        snapshot.total &&
        [frontier, previous?.total].some(
          (counter) => counter && snapshot.total!.some((value, index) => value < counter[index]),
        );
      retained.push(snapshot);
      if (reset) {
        boundaries.push({
          timestamp: snapshot.timestamp,
          segment: ++segment,
          turnId: snapshot.turnId,
          order: snapshot.order,
        });
        segmentStart = snapshot.order;
        frontier = null;
        previous = null;
      } else {
        previous = snapshot;
        previousProgress = progress;
      }
    }
  }
  return retained;
}

function reconcileCodexCosts(
  bills: readonly CodexBillEvidence[],
  snapshots: readonly CodexCostSnapshot[],
  boundaries: readonly { timestamp: number; segment: number; turnId: string | null }[],
  openingId: string | null,
  openingTimestamp: number,
): SessionRequest[] {
  const defects: SessionRequest[] = [];
  const defectSegments: number[] = [];
  const source = bills[0]?.request;
  const defect = (
    kind: 'recorded-gaps' | 'billed-with-unknown-coverage',
    start: number,
    end: number,
    segment: number,
  ) => {
    defectSegments.push(segment);
    defects.push({
      ...(source ?? {
        agent: 'codex',
        provider: null,
        model: null,
        contextWindow: null,
        contextBand: null,
        billingClass: 'unknown',
        inferenceClass: null,
        serviceTier: null,
        reportedCost: null,
      }),
      timestamp: Math.min(start, end),
      usage: { requests: 0, input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, thinking: 0 },
      requestKey: `codex-coverage:${defects.length}`,
      toolCalls: 0,
      billingRecord: undefined,
      incomplete: undefined,
      recordedReconciled: undefined,
      evidenceOnly: true,
      billedCoverage: true,
      coverageDefect: { kind, until: Math.max(start, end) === Infinity ? Infinity : Math.max(start, end) + 1 },
    });
  };
  const matched = new Set<CodexCostSnapshot>();
  const matches = matchCostSnapshots(bills, snapshots, openingId);
  const trusted: CodexBillEvidence[] = [];
  const restarts: CodexBillEvidence[] = [];
  let previous: CodexBillEvidence | null = null;
  let baselineKnown = false;
  let currentSegment = 0;
  const turnTotals = new Map<string, CodexCostVector>();
  for (const bill of bills) {
    if (bill.segment !== currentSegment) {
      currentSegment = bill.segment;
      previous = null;
      baselineKnown = false;
      turnTotals.clear();
    }
    const snapshot = matches.get(bill);
    if (snapshot) {
      matched.add(snapshot);
      snapshot.matched = true;
    }
    const zeroBaseline = equalCostVector(bill.thread, bill.usage) && equalCostVector(bill.turn, bill.usage);
    if (
      !previous &&
      zeroBaseline &&
      snapshot &&
      bill.threadId === openingId &&
      !bill.conflicted &&
      !bill.request.incomplete
    )
      baselineKnown = true;
    const expectedThread = previous?.thread
      ? (bill.usage?.map((value, index) => value + previous!.thread![index]) ?? null)
      : bill.usage;
    const priorTurn = turnTotals.get(bill.turnId);
    const expectedTurn = priorTurn ? (bill.usage?.map((value, index) => value + priorTurn[index]) ?? null) : bill.usage;
    const progression = equalCostVector(bill.thread, expectedThread) && equalCostVector(bill.turn, expectedTurn);
    const ownership = !!openingId && bill.threadId === openingId;
    if (openingId && bill.threadId !== null && !ownership) {
      bill.request.evidenceOnly = true;
      bill.request.billedCoverage = true;
    }
    const anchor = [...trusted].reverse().find((item) => item.segment === bill.segment);
    const start = anchor
      ? anchor.request.timestamp < bill.request.timestamp
        ? anchor.request.timestamp + 1
        : anchor.request.timestamp
      : (boundaries.find((boundary) => boundary.segment === bill.segment)?.timestamp ?? openingTimestamp);
    const positiveJump =
      bill.thread &&
      expectedThread &&
      bill.thread.every((value, index) => value >= expectedThread[index]) &&
      bill.thread.some((value, index) => value > expectedThread[index]);
    if (!bill.conflicted && !bill.request.incomplete && ownership && snapshot && baselineKnown && progression) {
      bill.request.recordedReconciled = true;
      trusted.push(bill);
      if (!previous && zeroBaseline) restarts.push(bill);
    } else {
      const gap = positiveJump && ownership && baselineKnown && !bill.conflicted;
      defect(
        gap ? 'recorded-gaps' : 'billed-with-unknown-coverage',
        gap || !previous ? start : bill.request.timestamp,
        bill.request.timestamp,
        bill.segment,
      );
      if (!progression || !ownership || !bill.thread || bill.conflicted) {
        baselineKnown = false;
        defect('billed-with-unknown-coverage', bill.request.timestamp, Infinity, bill.segment);
      }
    }
    if (ownership) {
      if (bill.turn) turnTotals.set(bill.turnId, bill.turn);
      previous = bill;
    }
  }
  for (const boundary of boundaries) {
    const restart = trusted.find((bill) => bill.segment === boundary.segment);
    defect(
      'billed-with-unknown-coverage',
      boundary.timestamp,
      restart
        ? restart.request.timestamp > boundary.timestamp
          ? restart.request.timestamp - 1
          : restart.request.timestamp
        : Infinity,
      boundary.segment,
    );
  }
  // A delayed snapshot belongs to its matched bill, irrespective of report windows.
  for (const snapshot of snapshots) {
    if (matched.has(snapshot) || !snapshot.total) continue;
    const anchor = [...trusted]
      .reverse()
      .find((bill) => bill.order < snapshot.order && bill.segment === snapshot.segment);
    if (!anchor && !snapshot.total.some((value) => value > 0)) continue;
    const start = anchor
      ? anchor.request.timestamp < snapshot.timestamp
        ? anchor.request.timestamp + 1
        : anchor.request.timestamp
      : (boundaries.find((boundary) => boundary.segment === snapshot.segment)?.timestamp ?? openingTimestamp);
    const unresolved = bills.some(
      (bill) =>
        bill.segment === snapshot.segment &&
        bill.order > (anchor?.order ?? 0) &&
        bill.order <= snapshot.order &&
        !bill.request.recordedReconciled,
    );
    const reset = anchor?.thread && snapshot.total.some((value, index) => value < anchor.thread![index]);
    const cumulativeEvidence =
      anchor?.thread && !unresolved && !reset && snapshot.total.some((value, index) => value > anchor.thread![index]);
    defect(
      cumulativeEvidence ? 'recorded-gaps' : 'billed-with-unknown-coverage',
      reset || unresolved ? snapshot.timestamp : start,
      reset ? Infinity : snapshot.timestamp,
      snapshot.segment,
    );
  }
  for (const [index, request] of defects.entries()) {
    if (request.coverageDefect!.until !== Infinity) continue;
    const restart = restarts.find((bill) => bill.segment > defectSegments[index]);
    if (restart) {
      const start = request.timestamp;
      request.timestamp = Math.min(start, restart.request.timestamp);
      request.coverageDefect!.until = restart.request.timestamp > start ? restart.request.timestamp : start + 1;
    }
  }
  return defects;
}

// The reducers own request identity. This pass retains their final positive event and its first position.
export function readSessionRequests(
  file: string,
  role: SessionSourceKind = isCodex(file) ? 'codex' : 'claude',
  invocationId?: string,
  failedToolTimestamps?: number[],
): SessionRequest[] {
  const codex =
    role === 'codex' || role === 'codex-thread' || role === 'claude-print' || (role === 'claude' && isCodex(file));
  const reducer = codex
    ? createCodexUsageLineReducer()
    : createClaudeUsageLineReducer(undefined, {
        childTranscript: role === 'claude-subagent' || spendFileIsClaudeChild(file),
      });
  const ordered = new Map<string, SessionRequest | null>();
  const toolIds = new Map<string, Set<string>>();
  const toolOwner = new Map<string, string>();
  const toolDetails = new Map<string, { name: string; input: unknown }>();
  const seenResults = new Set<string>();
  const pendingResults: string[] = [];
  const requestEvidence = new Map<
    string,
    {
      toolKinds: string[];
      ownText: string;
      failedToolCalls: number;
      launchedAgentIds: string[];
      structuredAgentIds: string[];
      agentToolCallIds: string[];
      recordedSpeed: string | null;
    }
  >();
  const codexTools = new Map<string, Map<string, number>>();
  const compactionPlaceholders = new Set<string>();
  const billingRecords = new Map<string, CodexBillEvidence>();
  const costSnapshots: CodexCostSnapshot[] = [];
  const costBoundaries: { timestamp: number; segment: number; turnId: string | null; order: number }[] = [];
  let sourceOrder = 0;
  let costSegment = 0;
  const copiedTurns = new Set<string>();
  const seenTurns = new Set<string>();
  const replayedTurns = new Set<string>();
  const replayRequests = new Set<string>();
  const failureCandidates: { turnId: string | null; timestamp: number }[] = [];
  const turnModels = new Map<string, string>();
  const turnWindows = new Map<string, number>();
  let replayingTurn = false;
  let pendingCompactionResponseId: string | null = null;
  let afterCompaction = false;
  const consumeCodexTools = (event: UsageEvent, previous = 0): number => {
    if (!codex || event.linkedInvocationId) return previous;
    const turnId = /^codex:([^:]+):/.exec(event.requestKey)?.[1];
    const pending = turnId ? codexTools.get(turnId) : undefined;
    let toolCalls = previous;
    for (const [id, timestamp] of pending ?? []) {
      if (event.timestamp > 0 && timestamp > event.timestamp) continue;
      toolCalls++;
      pending?.delete(id);
    }
    return toolCalls;
  };
  const complete = scanLines(file, (line) => {
    if (!line) return;
    sourceOrder++;
    const pendingOwnershipBefore =
      codex && line.includes('token_usage_record')
        ? (reducer as ReturnType<typeof createCodexUsageLineReducer>).snapshot().pendingOwnership
        : null;
    const ownershipEvents = pendingOwnershipBefore ? reducer.pushLine(line) : null;
    const confirmedOwnership = new Set<string>();
    if (ownershipEvents) {
      const state = (reducer as ReturnType<typeof createCodexUsageLineReducer>).snapshot();
      for (const turnId of Object.keys(pendingOwnershipBefore!)) {
        if (!state.pendingOwnership[turnId]) {
          confirmedOwnership.add(turnId);
          copiedTurns.delete(turnId);
        }
      }
      replayingTurn = state.currentTurnCopied || replayedTurns.has(state.currentTurnId ?? '');
    }
    if (codex && line.includes('"item_completed"') && line.includes('"failed"')) {
      try {
        const raw = JSON.parse(line) as {
          type?: string;
          timestamp?: string;
          payload?: { type?: string; item?: { type?: string; status?: string } };
        };
        if (
          raw.type === 'event_msg' &&
          raw.payload?.type === 'item_completed' &&
          raw.payload.item?.status === 'failed' &&
          ['CommandExecution', 'FileChange', 'McpToolCall', 'CollabAgentToolCall'].includes(raw.payload.item.type ?? '')
        ) {
          const state = (reducer as ReturnType<typeof createCodexUsageLineReducer>).snapshot();
          if (!replayingTurn && !state.currentTurnCopied && !copiedTurns.has(state.currentTurnId ?? ''))
            failureCandidates.push({ turnId: state.currentTurnId, timestamp: Date.parse(raw.timestamp ?? '') || 0 });
        }
      } catch {
        /* A malformed completion cannot identify a failed tool. */
      }
    }
    if (!codex && line.includes('"user"') && line.includes('"tool_result"')) {
      try {
        const raw = JSON.parse(line) as {
          type?: string;
          toolUseResult?: { agentId?: string };
          message?: { content?: { type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }[] };
        };
        if (raw.type === 'user' && Array.isArray(raw.message?.content)) {
          for (const block of raw.message.content) {
            if (block.type !== 'tool_result' || !block.tool_use_id) continue;
            const id = block.tool_use_id;
            if (!seenResults.has(id)) {
              seenResults.add(id);
              pendingResults.push(id);
            }
            const owner = toolOwner.get(id);
            const evidence = owner ? requestEvidence.get(owner) : undefined;
            if (evidence && block.is_error) evidence.failedToolCalls++;
            if (evidence && ['Agent', 'Task'].includes(toolDetails.get(id)?.name ?? '')) {
              const text = stringLeaves(block.content).join('\n');
              if (raw.toolUseResult?.agentId) evidence.structuredAgentIds.push(raw.toolUseResult.agentId);
              for (const match of text.matchAll(/agentId:\s*([^\s]+)/g))
                evidence.launchedAgentIds.push(match[1].replace(/[.,;:()]+$/, ''));
            }
          }
        }
      } catch {
        /* A malformed result cannot identify its request. */
      }
    }
    if (codex && line.includes('token_usage_record')) {
      try {
        const raw = JSON.parse(line) as {
          type?: string;
          timestamp?: string;
          payload?: {
            response_id?: string;
            turn_id?: string;
            thread_id?: string;
            usage?: unknown;
            thread_token_usage?: unknown;
            turn_token_usage?: unknown;
          };
        };
        if (raw.type === 'token_usage_record' && raw.payload?.response_id) {
          const rawFields = raw.payload.usage;
          const fields: Record<string, unknown> =
            rawFields !== null && typeof rawFields === 'object' && !Array.isArray(rawFields)
              ? (rawFields as Record<string, unknown>)
              : {};
          const validCounter = (field: string) =>
            typeof fields[field] === 'number' && Number.isFinite(fields[field]) && fields[field] >= 0;
          const completeBill =
            [
              'input_tokens',
              'cached_input_tokens',
              'cache_write_input_tokens',
              'output_tokens',
              'reasoning_output_tokens',
            ].every(validCounter) &&
            Number(fields.input_tokens) >=
              Number(fields.cached_input_tokens) + Number(fields.cache_write_input_tokens) &&
            Number(fields.output_tokens) >= Number(fields.reasoning_output_tokens);
          const knownFields = Object.fromEntries(
            [
              'input_tokens',
              'cached_input_tokens',
              'cache_write_input_tokens',
              'output_tokens',
              'reasoning_output_tokens',
            ]
              .filter(validCounter)
              .map((field) => [field, fields[field]]),
          );
          const usage = codexRequestUsage(knownFields);
          const state = (reducer as ReturnType<typeof createCodexUsageLineReducer>).snapshot();
          const turnId = raw.payload.turn_id ?? state.currentTurnId;
          const previousBill = billingRecords.get(raw.payload.response_id);
          const previousThread = previousBill?.thread ?? null;
          const vector = costVector(raw.payload.usage);
          const threadVector = costVector(raw.payload.thread_token_usage);
          const turnVector = costVector(raw.payload.turn_token_usage);
          const acceptedScope =
            turnId && !copiedTurns.has(turnId) && !replayedTurns.has(turnId) && !state.foreignSessionMeta;
          if (previousBill && acceptedScope && !previousBill.conflicted) {
            if (completeBill && previousBill.request.incomplete && usage) {
              previousBill.request.usage = usage;
              previousBill.usage = vector ?? previousBill.usage;
              previousBill.thread = threadVector ?? previousBill.thread;
              previousBill.turn = turnVector ?? previousBill.turn;
              previousBill.threadId = raw.payload.thread_id ?? previousBill.threadId;
              delete previousBill.request.incomplete;
            } else if (
              completeBill &&
              !previousBill.request.incomplete &&
              (JSON.stringify(previousBill.request.usage) !== JSON.stringify(usage) ||
                previousBill.turnId !== turnId ||
                (previousBill.threadId !== null &&
                  raw.payload.thread_id !== undefined &&
                  raw.payload.thread_id !== previousBill.threadId) ||
                (previousBill.thread && threadVector && !equalCostVector(previousBill.thread, threadVector)) ||
                (previousBill.turn && turnVector && !equalCostVector(previousBill.turn, turnVector)))
            ) {
              previousBill.conflicted = true;
              previousBill.request.incomplete = true;
            }
            if (!previousBill.conflicted) {
              previousBill.usage ??= vector;
              previousBill.thread ??= threadVector;
              previousBill.turn ??= turnVector;
              previousBill.threadId ??= raw.payload.thread_id ?? null;
              if (threadVector && !equalCostVector(previousThread, threadVector))
                previousBill.observations.push({
                  order: sourceOrder,
                  segment: costSegment,
                  thread: threadVector,
                });
            }
          }
          if (
            !previousBill &&
            turnId &&
            !copiedTurns.has(turnId) &&
            (!replayedTurns.has(turnId) || confirmedOwnership.has(turnId)) &&
            !state.foreignSessionMeta
          ) {
            const model = turnModels.get(turnId) ?? state.turnModels[turnId] ?? null;
            const provider = state.provider;
            const billed: SessionRequest = {
              timestamp: Date.parse(raw.timestamp ?? '') || 0,
              agent: 'codex',
              provider,
              model,
              contextWindow: turnWindows.get(turnId) ?? state.turnWindows[turnId] ?? null,
              contextBand: null,
              billingClass:
                provider && provider !== 'openai'
                  ? 'metered'
                  : state.planType
                    ? 'subscription'
                    : state.planKnown
                      ? 'metered'
                      : 'unknown',
              inferenceClass: null,
              serviceTier: state.serviceTier,
              reportedCost: null,
              visibleTurnId: null,
              compactionsBefore: state.compactionCount,
              usage: usage ?? {
                requests: 1,
                input: 0,
                cacheRead: 0,
                cacheWrite5m: 0,
                cacheWrite1h: 0,
                cacheWrite30m: 0,
                output: 0,
                thinking: 0,
              },
              requestKey: `codex-billing:${raw.payload.response_id}`,
              toolCalls: 0,
              billingRecord: true,
              ...(completeBill ? {} : { incomplete: true }),
            };
            billed.toolCalls = consumeCodexTools({ ...billed, requestKey: `codex:${turnId}:billing` });
            billingRecords.set(raw.payload.response_id, {
              turnId,
              request: billed,
              order: sourceOrder,
              segment: costSegment,
              threadId: raw.payload.thread_id ?? null,
              usage: vector,
              thread: threadVector,
              turn: turnVector,
              observations: [{ order: sourceOrder, segment: costSegment, thread: threadVector }],
            });
          }
        }
      } catch {
        // A malformed record cannot establish a billed request.
      }
    }
    if (codex && line.includes('compacted')) {
      try {
        const raw = JSON.parse(line) as { type?: string; payload?: { compaction_response_id?: string } };
        if (raw.type === 'compacted') pendingCompactionResponseId = raw.payload?.compaction_response_id ?? null;
      } catch {
        // A malformed boundary cannot identify a compaction request.
      }
    }
    if (codex && pendingCompactionResponseId && line.includes('thread_settings_applied')) {
      try {
        const raw = JSON.parse(line) as {
          type?: string;
          payload?: {
            thread_settings?: { model?: string; model_id?: string; model_provider_id?: string; service_tier?: string };
          };
        };
        if (
          raw.type === 'event_msg' &&
          (raw.payload as { type?: string } | undefined)?.type === 'thread_settings_applied'
        ) {
          const billed = billingRecords.get(pendingCompactionResponseId);
          const settings = raw.payload?.thread_settings;
          if (billed) {
            billed.request.model = settings?.model ?? settings?.model_id ?? billed.request.model;
            billed.request.provider = settings?.model_provider_id ?? billed.request.provider;
            billed.request.serviceTier = settings?.service_tier ?? billed.request.serviceTier;
            billed.request.compactionMetadata = true;
          }
          pendingCompactionResponseId = null;
        }
      } catch {
        // A malformed settings record cannot resolve billing identity.
      }
    }
    const record = codex ? codexSnapshotRecord(line) : null;
    if (record?.kind === 'task_started' || record?.kind === 'task_complete' || record?.kind === 'turn_aborted') {
      pendingCompactionResponseId = null;
    }
    if (record?.kind === 'compacted') afterCompaction = true;
    const placeholder = afterCompaction && record?.kind === 'token_count' && record.zeroUsage;
    const pendingBefore = placeholder
      ? new Set((reducer as ReturnType<typeof createCodexUsageLineReducer>).pendingRequestKeys())
      : null;
    const claudeTools = codex ? null : claudeToolIds(line);
    if (claudeTools && !(claudeTools.sidechain && role !== 'claude-subagent' && !spendFileIsClaudeChild(file))) {
      const held = toolIds.get(claudeTools.key) ?? new Set<string>();
      const evidence = requestEvidence.get(claudeTools.key) ?? {
        toolKinds: pendingResults.map((id) => {
          const tool = toolDetails.get(id);
          return tool ? toolKind(tool.name, tool.input) : 'other';
        }),
        ownText: '',
        failedToolCalls: 0,
        launchedAgentIds: [],
        structuredAgentIds: [],
        agentToolCallIds: [],
        recordedSpeed: claudeTools.speed,
      };
      if (!requestEvidence.has(claudeTools.key)) pendingResults.length = 0;
      evidence.ownText += claudeTools.text;
      for (const tool of claudeTools.tools) {
        held.add(tool.id);
        if (tool.name === 'Agent' || tool.name === 'Task') evidence.agentToolCallIds.push(tool.id);
        toolOwner.set(tool.id, claudeTools.key);
        toolDetails.set(tool.id, { name: tool.name, input: tool.input });
        evidence.ownText += '\n' + stringLeaves(tool.input).join('\n');
      }
      requestEvidence.set(claudeTools.key, evidence);
      toolIds.set(claudeTools.key, held);
    }
    const codexTool = codex ? codexToolCall(line) : null;
    if (codexTool) {
      const turnId = (reducer as ReturnType<typeof createCodexUsageLineReducer>).currentToolTurnId();
      if (turnId && !replayingTurn && !replayedTurns.has(turnId) && !copiedTurns.has(turnId)) {
        const held = codexTools.get(turnId) ?? new Map<string, number>();
        held.set(codexTool.id, codexTool.timestamp);
        codexTools.set(turnId, held);
      }
    }
    const priorRequestNumber =
      codex && record?.kind === 'token_count'
        ? (reducer as ReturnType<typeof createCodexUsageLineReducer>).snapshot().requestNumber
        : null;
    if (codex && line.includes('turn_context')) {
      try {
        const raw = JSON.parse(line) as { type?: string; payload?: { turn_id?: string; current_date?: string } };
        const state = (reducer as ReturnType<typeof createCodexUsageLineReducer>).snapshot();
        if (
          raw.type === 'turn_context' &&
          raw.payload?.turn_id &&
          recordedDatePredatesOpening(raw.payload.current_date, state)
        ) {
          copiedTurns.add(raw.payload.turn_id);
        }
      } catch {
        // A malformed date cannot classify a copied turn.
      }
    }
    let replayedContextTurnId: string | null = null;
    if (codex && line.includes('turn_context')) {
      try {
        const raw = JSON.parse(line) as { type?: string; payload?: { turn_id?: string } };
        if (raw.type === 'turn_context' && raw.payload?.turn_id && replayedTurns.has(raw.payload.turn_id))
          replayedContextTurnId = raw.payload.turn_id;
      } catch {
        // A malformed context cannot identify a replayed turn.
      }
    }
    const events = (ownershipEvents ?? reducer.pushLine(line)).map((event) =>
      replayedContextTurnId && event.requestKey.startsWith(`codex:${replayedContextTurnId}:`)
        ? { ...event, model: null, contextBand: null, inferenceClass: null }
        : event,
    );
    if (codex && line.includes('session_meta')) {
      try {
        const state = (reducer as ReturnType<typeof createCodexUsageLineReducer>).snapshot();
        const raw = JSON.parse(line) as { type?: string; timestamp?: string; payload?: { timestamp?: string } };
        const metadataTimestamp = Date.parse(raw.payload?.timestamp ?? raw.timestamp ?? '') || 0;
        if (
          raw.type === 'session_meta' &&
          state.foreignSessionMeta &&
          metadataTimestamp >= (state.openingTimestamp ?? 0)
        ) {
          costSegment++;
          costBoundaries.push({
            timestamp: Date.parse(raw.timestamp ?? '') || 0,
            segment: costSegment,
            turnId: null,
            order: sourceOrder,
          });
        }
      } catch {
        // Incomplete metadata supplies no coverage boundary.
      }
    }
    if (codex && (record?.kind === 'token_count' || record?.kind === 'compacted')) {
      const state = (reducer as ReturnType<typeof createCodexUsageLineReducer>).snapshot();
      if (
        state.currentTurnId &&
        !state.foreignSessionMeta &&
        !state.currentTurnRepeated &&
        ((!state.currentTurnCopied && !replayingTurn) || state.pendingOwnership[state.currentTurnId])
      ) {
        const raw = JSON.parse(line) as {
          timestamp?: string;
          payload?: { info?: { total_token_usage?: unknown; last_token_usage?: unknown } };
        };
        const timestamp = Date.parse(raw.timestamp ?? '') || 0;
        if (record.kind === 'compacted') {
          costSegment++;
          costBoundaries.push({ timestamp, segment: costSegment, turnId: state.currentTurnId, order: sourceOrder });
        } else if (raw.payload?.info) {
          const total = costVector(raw.payload.info.total_token_usage);
          const last = costVector(raw.payload.info.last_token_usage);
          if (!placeholder || total?.some((value) => value > 0)) {
            costSnapshots.push({
              turnId: state.currentTurnId,
              timestamp,
              order: sourceOrder,
              segment: costSegment,
              total,
              last,
            });
          }
        }
      }
    }
    if (codex && (record?.kind === 'task_started' || line.includes('turn_context'))) {
      try {
        const raw = JSON.parse(line) as {
          payload?: { turn_id?: string; model?: string; model_context_window?: number };
        };
        const turnId = raw.payload?.turn_id;
        if (turnId && record?.kind === 'task_started') {
          const state = (reducer as ReturnType<typeof createCodexUsageLineReducer>).snapshot();
          const repeated = seenTurns.has(turnId);
          replayingTurn = repeated || state.currentTurnCopied;
          if (repeated) replayedTurns.add(turnId);
          if (!seenTurns.has(turnId) && state.currentTurnCopied) copiedTurns.add(turnId);
          seenTurns.add(turnId);
          if (!replayingTurn && typeof raw.payload?.model_context_window === 'number')
            turnWindows.set(turnId, raw.payload.model_context_window);
        } else if (turnId && line.includes('turn_context')) {
          const state = (reducer as ReturnType<typeof createCodexUsageLineReducer>).snapshot();
          if (state.datedCopiedTurnIds[turnId]) copiedTurns.add(turnId);
          if (raw.payload?.model && !replayedTurns.has(turnId)) turnModels.set(turnId, raw.payload.model);
        }
      } catch {
        // A malformed turn record cannot establish report identity.
      }
    }
    if (codex && record?.kind === 'token_count') {
      const state = (reducer as ReturnType<typeof createCodexUsageLineReducer>).snapshot();
      if (state.requestNumber !== priorRequestNumber) {
        const key = `codex:${state.currentTurnId}:${Date.parse((JSON.parse(line) as { timestamp?: string }).timestamp ?? '') || 0}:${state.requestNumber}`;
        if (replayingTurn && !(state.currentTurnId && state.pendingOwnership[state.currentTurnId]))
          replayRequests.add(key);
        const info = (
          JSON.parse(line) as {
            payload?: { info?: { last_token_usage?: Record<string, number>; model_context_window?: number } };
          }
        ).payload?.info;
        if (state.currentTurnId && !replayingTurn && typeof info?.model_context_window === 'number')
          turnWindows.set(state.currentTurnId, info.model_context_window);
      }
    }
    if (placeholder) {
      for (const key of (reducer as ReturnType<typeof createCodexUsageLineReducer>).pendingRequestKeys()) {
        if (!pendingBefore?.has(key)) compactionPlaceholders.add(key);
      }
      for (const event of events) {
        if (event.agent === 'codex' && !pendingBefore?.has(event.requestKey))
          compactionPlaceholders.add(event.requestKey);
      }
    }
    if (record?.kind === 'token_count' || record?.kind === 'task_started') afterCompaction = false;
    if (codex && line.includes('token_count')) {
      for (const key of (reducer as ReturnType<typeof createCodexUsageLineReducer>).pendingRequestKeys())
        if (!ordered.has(key)) ordered.set(key, null);
    }
    for (const event of events) {
      if (event.compactionEstimate || !event.requestKey) continue;
      if (replayRequests.has(event.requestKey)) continue;
      if ((event.usage.requests ?? 1) < 0) {
        ordered.set(event.requestKey, null);
        continue;
      }
      if (claudeTools?.key === event.requestKey) {
        const evidence = requestEvidence.get(event.requestKey);
        if (evidence) evidence.recordedSpeed = claudeTools.speed;
      }
      const previous = ordered.get(event.requestKey);
      ordered.set(event.requestKey, {
        ...event,
        toolCalls: consumeCodexTools(event, previous?.toolCalls ?? 0),
      });
    }
  });
  if (!complete) throw new Error(`Cannot read transcript: ${file}`);
  if (failedToolTimestamps)
    for (const { turnId, timestamp } of failureCandidates)
      if (!turnId || !copiedTurns.has(turnId)) failedToolTimestamps.push(timestamp);
  if (codex) {
    const state = (reducer as ReturnType<typeof createCodexUsageLineReducer>).snapshot();
    for (const id of Object.keys(state.pendingOwnership)) copiedTurns.delete(id);
    for (const request of ordered.values()) {
      const id = request?.incomplete ? /^codex:([^:]+):/.exec(request.requestKey)?.[1] : null;
      if (id && !state.datedCopiedTurnIds[id]) copiedTurns.delete(id);
    }
    for (const [id, billed] of billingRecords) {
      if (copiedTurns.has(billed.turnId)) {
        billingRecords.delete(id);
        continue;
      }
      if (!billed.request.compactionMetadata)
        billed.request.model = turnModels.get(billed.turnId) ?? billed.request.model;
      billed.request.contextWindow =
        turnWindows.get(billed.turnId) ?? state.turnWindows[billed.turnId] ?? billed.request.contextWindow;
    }
    for (const events of Object.values(state.pendingRequests)) {
      for (const event of events) {
        ordered.set(event.requestKey, { ...event, incomplete: true, toolCalls: consumeCodexTools(event) });
      }
    }
  }
  const requests = [...ordered.values()]
    .filter((request): request is SessionRequest => request !== null)
    .filter((request) => !compactionPlaceholders.has(request.requestKey))
    .filter((request) => !replayRequests.has(request.requestKey))
    .filter((request) => !codex || !copiedTurns.has(/^codex:([^:]+):/.exec(request.requestKey)?.[1] ?? ''))
    .map((request) => {
      const turnId = /^codex:([^:]+):/.exec(request.requestKey)?.[1];
      if (codex && turnId) {
        request.model ??= turnModels.get(turnId) ?? null;
        request.contextWindow ??= turnWindows.get(turnId) ?? null;
      }
      return request;
    })
    .filter(
      (request) =>
        !codex ||
        request.linkedInvocationId ||
        request.incomplete ||
        request.usage.input +
          request.usage.cacheRead +
          request.usage.cacheWrite5m +
          request.usage.cacheWrite1h +
          (request.usage.cacheWrite30m ?? 0) +
          request.usage.output +
          request.usage.thinking >
          0,
    )
    .filter(
      (request) =>
        invocationId === '*' ||
        (role === 'claude-print' ? request.linkedInvocationId === invocationId : !request.linkedInvocationId),
    )
    .map((request) => ({
      ...request,
      toolCalls: codex ? request.toolCalls : (toolIds.get(request.requestKey)?.size ?? 0),
      ...(!codex && requestEvidence.has(request.requestKey) ? requestEvidence.get(request.requestKey) : {}),
    }));
  if (!codex) return requests;
  const finalState = (reducer as ReturnType<typeof createCodexUsageLineReducer>).snapshot();
  const scopedBoundaries = costBoundaries.filter((boundary) => !boundary.turnId || !copiedTurns.has(boundary.turnId));
  const scopedSnapshots = classifyCostSegments(
    [...billingRecords.values()],
    costSnapshots.filter((snapshot) => !copiedTurns.has(snapshot.turnId)),
    scopedBoundaries,
    finalState.openingSessionId,
  );
  const defects = billingRecords.size
    ? reconcileCodexCosts(
        [...billingRecords.values()],
        scopedSnapshots,
        scopedBoundaries,
        finalState.openingSessionId,
        finalState.openingTimestamp ?? 0,
      )
    : reconcileCodexCosts(
        [],
        scopedSnapshots.filter((snapshot) => !snapshot.last || snapshot.last.every((value) => value === 0)),
        scopedBoundaries,
        finalState.openingSessionId,
        finalState.openingTimestamp ?? 0,
      ).map((request) => ({
        ...request,
        billedCoverage: undefined,
        coverageDefect: { ...request.coverageDefect!, kind: 'unknown-request-coverage' as const },
      }));
  const requestByTurn = new Map<string, SessionRequest>();
  for (const request of requests) {
    const turnId = /^codex:([^:]+):/.exec(request.requestKey)?.[1];
    if (turnId && !requestByTurn.has(turnId)) requestByTurn.set(turnId, request);
  }
  for (const { turnId, request } of billingRecords.values()) {
    if (!requestByTurn.has(turnId)) requestByTurn.set(turnId, request);
  }
  for (const [turnId, pending] of codexTools) {
    if (copiedTurns.has(turnId) || !pending.size) continue;
    const timestamp = [...pending.values()].reduce((latest, value) => Math.max(latest, value), 0);
    const source = requestByTurn.get(turnId);
    requests.push({
      ...(source ?? {
        agent: 'codex',
        provider: finalState.provider,
        model: turnModels.get(turnId) ?? finalState.turnModels[turnId] ?? null,
        contextWindow: turnWindows.get(turnId) ?? finalState.turnWindows[turnId] ?? null,
        contextBand: null,
        billingClass: 'unknown',
        inferenceClass: null,
        serviceTier: finalState.serviceTier,
        reportedCost: null,
      }),
      timestamp,
      usage: {
        requests: 0,
        input: 0,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        cacheWrite30m: 0,
        output: 0,
        thinking: 0,
      },
      requestKey: `codex:${turnId}:tool-only`,
      toolCalls: pending.size,
      evidenceOnly: true,
      toolOnly: true,
    });
  }
  if (!billingRecords.size)
    return [...requests, ...defects]
      .map((request) =>
        request.agent === 'codex' && !request.evidenceOnly ? { ...request, legacySnapshot: true as const } : request,
      )
      .sort((left, right) => left.timestamp - right.timestamp);
  return [
    ...requests.map((request) =>
      request.agent === 'codex'
        ? {
            ...request,
            evidenceOnly: true as const,
            billedCoverage: true as const,
            ...(request.toolOnly ||
            scopedSnapshots.some(
              (snapshot) =>
                snapshot.matched &&
                snapshot.timestamp === request.timestamp &&
                request.requestKey.startsWith(`codex:${snapshot.turnId}:`),
            )
              ? { recordedReconciled: true as const }
              : {}),
          }
        : request,
    ),
    ...[...billingRecords.values()].map(({ request }) => request),
    ...defects,
  ].sort((left, right) => left.timestamp - right.timestamp);
}

export function sessionSources(file: string, roots: SessionRoots = {}, sourceOnly = false): SessionSource[] {
  const absolute = path.resolve(file);
  let codexFiles: Array<
    import('./transcript').SessionFile & { meta: NonNullable<ReturnType<typeof readCodexSessionMeta>> }
  > | null = null;
  const nativeByParent = new Map<
    string,
    Array<import('./transcript').SessionFile & { meta: NonNullable<ReturnType<typeof readCodexSessionMeta>> }>
  >();
  const codexCatalog = () => {
    if (codexFiles) return codexFiles;
    codexFiles = rolloutFiles(codexStore(roots)).flatMap((file) => {
      const meta = readCodexSessionMeta(file);
      if (!meta?.sessionId) return [];
      const stat = fs.statSync(file);
      return [
        {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          file,
          sessionId: meta.sessionId,
          agent: 'codex' as const,
          activity: stat.mtimeMs,
          meta,
        },
      ];
    });
    for (const entry of codexFiles) {
      const parent = entry.meta.parentThreadId;
      if (!parent) continue;
      const direct = nativeByParent.get(parent) ?? [];
      direct.push(entry);
      nativeByParent.set(parent, direct);
    }
    return codexFiles;
  };
  let catalog: import('./transcript').SessionFile[] | null = null;
  const dispatchCatalog = (agent: 'claude' | 'codex') => {
    if (agent === 'codex') return codexCatalog();
    if (catalog) return catalog;
    let directories: string[] = [];
    try {
      directories = fs
        .readdirSync(projectStore(roots), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(projectStore(roots), entry.name));
    } catch {
      /* A supplied file can sit outside the configured stores. */
    }
    if (!isCodex(absolute)) {
      const local = spendFileIsClaudeChild(absolute)
        ? path.dirname(path.dirname(path.dirname(absolute)))
        : path.dirname(absolute);
      if (
        !directories.some(
          (directory) => normalizeFsPath(path.resolve(directory)) === normalizeFsPath(path.resolve(local)),
        )
      )
        directories.push(local);
    }
    catalog = directories.flatMap(listSessionFiles);
    return catalog;
  };
  const sources: SessionSource[] = [];
  const seen = new Set<string>();
  const add = (source: SessionSource) => {
    let canonical = source.file;
    try {
      canonical = fs.realpathSync(source.file);
    } catch {
      /* Missing sources carry no usage. */
    }
    const key = normalizeFsPath(canonical);
    if (seen.has(key)) return;
    seen.add(key);
    sources.push(source);
  };
  const codex = isCodex(absolute);
  const meta = codex ? readCodexSessionMeta(absolute) : null;
  if (codex && !meta?.sessionId) throw new Error(`No Codex session id in ${absolute}`);
  add({
    kind: codex ? 'codex' : spendFileIsClaudeChild(absolute) ? 'claude-subagent' : 'claude',
    file: absolute,
    sessionId: meta?.sessionId ?? claudeSourceId(absolute),
  });
  const codexRequests = (source: SessionSource) => {
    const failed: number[] = [];
    const requests = readSessionRequests(source.file, source.kind, '*', failed);
    source.failedToolTimestamps = failed;
    source.requests = requests.filter((request) => !request.linkedInvocationId);
    return requests;
  };
  if (sourceOnly) {
    if (codex) codexRequests(sources[0]);
    return sources;
  }
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index];
    if (source.kind === 'claude-print') continue;
    const isCodexSource = source.kind === 'codex' || source.kind === 'codex-thread';
    if (isCodexSource) {
      codexCatalog();
      for (const child of nativeByParent.get(source.sessionId) ?? []) {
        const childMeta = child.meta;
        add({
          kind: 'codex-thread',
          file: child.file,
          sessionId: childMeta?.sessionId ?? source.sessionId,
          ...(childMeta?.agentPath || childMeta?.subagentKind
            ? { agent: childMeta.agentPath ?? childMeta.subagentKind ?? undefined }
            : {}),
        });
      }
    } else {
      for (const child of discoverClaudeSessionSpendSources([{ file: source.file, sessionId: source.sessionId }])) {
        if (!child.primary) add({ kind: 'claude-subagent', file: child.file, sessionId: claudeSourceId(child.file) });
      }
    }
    const references = isCodexSource
      ? scanCodexDispatchReferences(source.file, source.sessionId).references
      : readClaudeChildSessionReferences({
          file: source.file,
          sessionId: source.sessionId,
          childTranscript: source.kind === 'claude-subagent',
        });
    for (const reference of resolveClaudeDispatchReferences(
      references,
      [...new Set(references.flatMap((reference) => (reference.kind === 'dispatch' ? [reference.agent] : [])))].flatMap(
        dispatchCatalog,
      ),
    )) {
      if (!reference.file || !fs.existsSync(reference.file)) continue;
      add({
        kind:
          reference.kind !== 'dispatch'
            ? 'claude-subagent'
            : reference.agent === 'codex'
              ? 'codex-thread'
              : 'claude-session',
        file: reference.file,
        sessionId: reference.sessionId,
      });
    }
    if (!isCodexSource) continue;
    const requests = codexRequests(source);
    const prints = new Map<string, SessionRequest[]>();
    for (const request of requests) {
      if (!request.linkedInvocationId) continue;
      const held = prints.get(request.linkedInvocationId) ?? [];
      held.push(request);
      prints.set(request.linkedInvocationId, held);
    }
    for (const [invocationId, linked] of prints)
      sources.push({
        kind: 'claude-print',
        file: source.file,
        sessionId: linked[0].linkedSessionId ?? source.sessionId,
        invocationId,
        requests: linked,
      });
  }
  return sources;
}
