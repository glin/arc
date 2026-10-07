import { formatConservativeCost, nextTurnFloor, type CacheTier } from '../../extension/src/pricing.ts';
import { formatDuration, formatTokens, shortModel } from '../../extension/src/turnformat.ts';

export type CacheState = 'warm' | 'expired' | 'cold' | 'not-observed' | 'unknown';

export interface StatusSnapshotV1 {
  schemaVersion: 1;
  source: 'claude-statusline';
  model: { id: string | null; displayName: string | null; effort: string | null };
  workspace: { name: string | null; currentDir: string | null };
  session: {
    id: string | null;
    name: string | null;
    estimatedCostDollars: number | null;
    durationMs: number | null;
  };
  context: {
    usedTokens: number | null;
    maxTokens: number | null;
    usedPercentage: number | null;
    remainingTokens: number | null;
  };
  cache: {
    state: CacheState;
    ttl: CacheTier | null;
    expiresAt: number | null;
    remainingSeconds: number | null;
    hitPercentage: number | null;
    recacheTokensIfCold: number | null;
  };
  nextTurn: {
    basis: 'context-only-list-price-floor';
    state: 'warm' | 'cold' | 'unpriced';
    startsAtDollars: number | null;
    warmDollars: number | null;
    coldDollars: number | null;
  };
  limits: {
    fiveHour: UsageWindow | null;
    sevenDay: UsageWindow | null;
  };
}

export interface UsageWindow {
  usedPercentage: number | null;
  resetsAt: number | null;
  remainingSeconds: number | null;
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
}

function number(value: unknown, minimum = 0): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum ? value : null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function percentage(value: unknown): number | null {
  const parsed = number(value);
  return parsed !== null && parsed <= 100 ? parsed : null;
}

function cacheTier(value: unknown): CacheTier | null {
  return value === '5m' || value === '30m' || value === '1h' ? value : null;
}

function workspaceName(workspace: JsonObject | null): string | null {
  const repo = object(workspace?.repo);
  const repoName = string(repo?.name);
  if (repoName) {
    return repoName;
  }
  const directory = string(workspace?.project_dir) ?? string(workspace?.current_dir);
  return directory?.split(/[\\/]/).filter(Boolean).at(-1) ?? null;
}

function usageWindow(value: unknown, nowSeconds: number): UsageWindow | null {
  const window = object(value);
  if (!window) {
    return null;
  }
  const resetsAt = number(window.resets_at);
  return {
    usedPercentage: percentage(window.used_percentage),
    resetsAt,
    remainingSeconds: resetsAt === null ? null : Math.max(0, Math.ceil(resetsAt - nowSeconds)),
  };
}

function cacheState(cache: JsonObject | null, nowSeconds: number): CacheState {
  if (!cache) {
    return 'unknown';
  }
  if (cache.caching_observed === false) {
    return 'not-observed';
  }
  const expiresAt = number(cache.expires_at);
  if (expiresAt !== null && expiresAt <= nowSeconds) {
    return 'expired';
  }
  if (cache.warm === true) {
    return 'warm';
  }
  if (cache.caching_observed === true && cache.warm === false) {
    return 'cold';
  }
  return 'unknown';
}

export function snapshotFromClaude(input: unknown, now = Date.now()): StatusSnapshotV1 {
  const root = object(input);
  if (!root) {
    throw new Error('Claude status input must be a JSON object.');
  }

  const model = object(root.model);
  const effort = object(root.effort);
  const context = object(root.context_window);
  const cache = object(root.prompt_cache);
  const workspace = object(root.workspace);
  const cost = object(root.cost);
  const limits = object(root.rate_limits);
  const nowSeconds = now / 1000;

  const usedTokens = number(context?.total_input_tokens);
  const latestOutputTokens = number(context?.total_output_tokens) ?? 0;
  const maxTokens = number(context?.context_window_size, 1);
  const usedPercentage = percentage(context?.used_percentage);
  const expiresAt = number(cache?.expires_at);
  const state = cacheState(cache, nowSeconds);
  const ttl = cacheTier(cache?.ttl);
  const hitRatio = number(cache?.hit_ratio);
  const recacheTokensIfCold = number(cache?.recache_tokens_if_cold, 1);
  const modelId = string(model?.id);

  const sharedFloorInput =
    usedTokens === null
      ? null
      : {
          contextTokens: usedTokens,
          model: modelId,
          provider: null,
          contextWindow: maxTokens,
          tier: ttl,
          // The latest answer was output on the recorded request. The next request sends it
          // back as fresh input, so it belongs in the known starting price.
          freshTokens: latestOutputTokens,
        };
  const contextFloor = sharedFloorInput ? nextTurnFloor(sharedFloorInput) : null;
  const coldFloor =
    sharedFloorInput && recacheTokensIfCold !== null
      ? nextTurnFloor({
          ...sharedFloorInput,
          contextTokens: recacheTokensIfCold,
          // The re-cache count can be part of the prompt. The whole next request selects the price band.
          requestTokens: sharedFloorInput.contextTokens + latestOutputTokens,
        })
      : contextFloor;
  const warmDollars = state === 'not-observed' ? null : (contextFloor?.warm ?? null);
  const coldDollars = state === 'not-observed' ? null : (coldFloor?.cold ?? null);
  const priced = warmDollars !== null && coldDollars !== null;
  const nextState = !priced ? 'unpriced' : state === 'warm' ? 'warm' : 'cold';
  const startsAtDollars = nextState === 'warm' ? warmDollars : nextState === 'cold' ? coldDollars : null;

  return {
    schemaVersion: 1,
    source: 'claude-statusline',
    model: {
      id: modelId,
      displayName: string(model?.display_name) ?? shortModel(modelId),
      effort: string(effort?.level),
    },
    workspace: {
      name: workspaceName(workspace),
      currentDir: string(workspace?.current_dir) ?? string(root.cwd),
    },
    session: {
      id: string(root.session_id),
      name: string(root.session_name),
      estimatedCostDollars: number(cost?.total_cost_usd),
      durationMs: number(cost?.total_duration_ms),
    },
    context: {
      usedTokens,
      maxTokens,
      usedPercentage,
      remainingTokens: usedTokens !== null && maxTokens !== null ? Math.max(0, maxTokens - usedTokens) : null,
    },
    cache: {
      state,
      ttl,
      expiresAt,
      remainingSeconds: state === 'warm' && expiresAt !== null ? Math.max(0, Math.ceil(expiresAt - nowSeconds)) : null,
      hitPercentage: cache?.caching_observed !== false && hitRatio !== null && hitRatio <= 1 ? hitRatio * 100 : null,
      recacheTokensIfCold,
    },
    nextTurn: {
      basis: 'context-only-list-price-floor',
      state: nextState,
      startsAtDollars,
      warmDollars,
      coldDollars,
    },
    limits: {
      fiveHour: usageWindow(limits?.five_hour, nowSeconds),
      sevenDay: usageWindow(limits?.seven_day, nowSeconds),
    },
  };
}

function formatPercentage(value: number | null): string {
  if (value === null) {
    return '--';
  }
  return Number.isInteger(value) ? `${value}%` : `${Number(value.toFixed(1))}%`;
}

function contextSegment(snapshot: StatusSnapshotV1): string {
  const used = snapshot.context.usedTokens === null ? '--' : formatTokens(snapshot.context.usedTokens);
  const max = snapshot.context.maxTokens === null ? '--' : formatTokens(snapshot.context.maxTokens);
  return `ctx ${formatPercentage(snapshot.context.usedPercentage)} of ${max} (${used})`;
}

function cacheSegment(snapshot: StatusSnapshotV1, detailed: boolean): string {
  const state = snapshot.cache.state === 'not-observed' ? 'not observed' : snapshot.cache.state;
  const expiry =
    snapshot.cache.remainingSeconds === null ? '' : ` ${formatDuration(snapshot.cache.remainingSeconds * 1000)}`;
  const hit =
    detailed && snapshot.cache.hitPercentage !== null ? `, ${formatPercentage(snapshot.cache.hitPercentage)} hit` : '';
  return `cache ${state}${expiry}${hit}`;
}

export function renderNextTurn(snapshot: StatusSnapshotV1): string {
  const next = snapshot.nextTurn;
  if (next.state === 'unpriced') {
    return 'next turn unknown';
  }
  return `next turn starts at ${formatConservativeCost(next.startsAtDollars)}`;
}

function formatMoney(value: number): string {
  if (value > 0 && value < 0.01) {
    return '<$0.01';
  }
  return `$${value.toFixed(2)}`;
}

function sessionSegment(snapshot: StatusSnapshotV1, detailed: boolean): string | null {
  const cost = snapshot.session.estimatedCostDollars;
  const duration = snapshot.session.durationMs;
  if (cost === null && duration === null) {
    return null;
  }
  const values = [
    cost === null ? null : formatMoney(cost),
    detailed && duration !== null ? formatDuration(duration) : null,
  ].filter((value): value is string => value !== null);
  return `session ${values.join(', ')}`;
}

function limitSegment(label: string, window: UsageWindow | null, detailed: boolean): string | null {
  if (!window || window.usedPercentage === null) {
    return null;
  }
  const reset =
    detailed && window.remainingSeconds !== null && window.remainingSeconds > 0
      ? `, resets ${formatDuration(window.remainingSeconds * 1000)}`
      : '';
  return `${label} ${formatPercentage(window.usedPercentage)}${reset}`;
}

function optionalLine(snapshot: StatusSnapshotV1, width: number): string | null {
  const detailed = [
    sessionSegment(snapshot, true),
    limitSegment('5h', snapshot.limits.fiveHour, true),
    limitSegment('7d', snapshot.limits.sevenDay, true),
  ].filter((value): value is string => value !== null);
  if (detailed.length === 0) {
    return null;
  }
  const detailedLine = detailed.join(' | ');
  if (detailedLine.length <= width) {
    return detailedLine;
  }
  const compact = [
    sessionSegment(snapshot, false),
    limitSegment('5h', snapshot.limits.fiveHour, false),
    limitSegment('7d', snapshot.limits.sevenDay, false),
  ].filter((value): value is string => value !== null);
  while (compact.length > 0 && compact.join(' | ').length > width) {
    compact.pop();
  }
  return compact.length > 0 ? compact.join(' | ') : null;
}

export function renderStatus(snapshot: StatusSnapshotV1, width = Number.POSITIVE_INFINITY): string {
  const model = [snapshot.model.displayName, snapshot.model.effort].filter(Boolean).join(' ');
  const workspace = snapshot.workspace.name;
  const required = [contextSegment(snapshot), cacheSegment(snapshot, true), renderNextTurn(snapshot)];
  let segments = [model || null, workspace, ...required].filter((value): value is string => value !== null);
  let line = segments.join(' | ');

  if (line.length > width) {
    segments = [model || null, contextSegment(snapshot), cacheSegment(snapshot, true), renderNextTurn(snapshot)].filter(
      (value): value is string => value !== null,
    );
    line = segments.join(' | ');
  }
  if (line.length > width) {
    segments = [contextSegment(snapshot), cacheSegment(snapshot, false), renderNextTurn(snapshot)];
    if (model) {
      segments.unshift(model);
    }
    line = segments.join(' | ');
  }
  if (line.length > width && model) {
    line = segments.slice(1).join(' | ');
  }
  const secondary = optionalLine(snapshot, width);
  return secondary ? `${line}\n${secondary}` : line;
}
