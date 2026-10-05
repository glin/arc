import assert from 'node:assert/strict';
import { test } from 'vitest';
import { renderStatus, snapshotFromClaude } from '../src/status.ts';

const NOW = 1_738_428_900_000;

function payload() {
  return {
    model: { id: 'claude-opus-5', display_name: 'Opus' },
    effort: { level: 'high' },
    cwd: 'C:/Users/dev/Projects/work/sample-repo',
    session_id: 'session-123',
    session_name: 'Status line POC',
    workspace: {
      current_dir: 'C:/Users/dev/Projects/work/sample-repo',
      project_dir: 'C:/Users/dev/Projects/work/sample-repo',
      repo: { host: 'github.com', owner: 'example', name: 'arc' },
    },
    cost: { total_cost_usd: 0.1234, total_duration_ms: 45_000 },
    context_window: {
      total_input_tokens: 15_500,
      total_output_tokens: 1_200,
      context_window_size: 200_000,
      used_percentage: 8,
      remaining_percentage: 92,
    },
    prompt_cache: {
      warm: true,
      caching_observed: true,
      ttl: '1h',
      expires_at: 1_738_429_200,
      hit_ratio: 0.91,
      recache_tokens_if_cold: 45_000,
    },
    rate_limits: {
      five_hour: { used_percentage: 23.5, resets_at: 1_738_432_500 },
      seven_day: { used_percentage: 41.2, resets_at: 1_738_774_500 },
    },
  };
}

test('warm Claude input prints maximum context, percentage, cache expiry, and the warm next-turn floor', () => {
  const snapshot = snapshotFromClaude(payload(), NOW);
  assert.equal(
    renderStatus(snapshot),
    [
      'Opus high | arc | ctx 8% of 200k (16k) | cache warm 5m, 91% hit | next turn starts at $0.02',
      'session $0.12, 45s | 5h 23.5%, resets 1h 0m | 7d 41.2%, resets 96h 0m',
    ].join('\n'),
  );
  assert.deepEqual(snapshot, {
    schemaVersion: 1,
    source: 'claude-statusline',
    model: { id: 'claude-opus-5', displayName: 'Opus', effort: 'high' },
    workspace: {
      name: 'arc',
      currentDir: 'C:/Users/dev/Projects/work/sample-repo',
    },
    session: {
      id: 'session-123',
      name: 'Status line POC',
      estimatedCostDollars: 0.1234,
      durationMs: 45_000,
    },
    context: {
      usedTokens: 15_500,
      maxTokens: 200_000,
      usedPercentage: 8,
      remainingTokens: 184_500,
    },
    cache: {
      state: 'warm',
      ttl: '1h',
      expiresAt: 1_738_429_200,
      remainingSeconds: 300,
      hitPercentage: 91,
      recacheTokensIfCold: 45_000,
    },
    nextTurn: {
      basis: 'context-only-list-price-floor',
      state: 'warm',
      startsAtDollars: 0.01375,
      warmDollars: 0.01375,
      coldDollars: 0.462,
    },
    limits: {
      fiveHour: { usedPercentage: 23.5, resetsAt: 1_738_432_500, remainingSeconds: 3_600 },
      sevenDay: { usedPercentage: 41.2, resetsAt: 1_738_774_500, remainingSeconds: 345_600 },
    },
  });
});

test('the next-turn starting price includes the latest answer that becomes input', () => {
  const input = payload();
  input.context_window.total_input_tokens = 100_000;
  input.context_window.total_output_tokens = 20_000;
  input.prompt_cache.recache_tokens_if_cold = 100_000;
  const snapshot = snapshotFromClaude(input, NOW);
  assert.equal(snapshot.nextTurn.warmDollars, 0.15);
  assert.equal(snapshot.nextTurn.coldDollars?.toFixed(2), '1.20');
});

test('expired native cache state selects the cold recache floor', () => {
  const input = payload();
  input.prompt_cache.expires_at = 1_738_428_899;
  const snapshot = snapshotFromClaude(input, NOW);
  assert.equal(snapshot.cache.state, 'expired');
  assert.equal(snapshot.nextTurn.state, 'cold');
  assert.match(
    renderStatus(snapshot),
    /^Opus high \| arc \| ctx 8% of 200k \(16k\) \| cache expired, 91% hit \| next turn starts at \$0\.47\n/,
  );
});

test('native cold cache state selects the cold recache floor', () => {
  const input = payload();
  input.prompt_cache.warm = false;
  (input.prompt_cache as { expires_at: number | null }).expires_at = null;
  const snapshot = snapshotFromClaude(input, NOW);
  assert.equal(snapshot.cache.state, 'cold');
  assert.equal(snapshot.nextTurn.state, 'cold');
  assert.match(
    renderStatus(snapshot),
    /^Opus high \| arc \| ctx 8% of 200k \(16k\) \| cache cold, 91% hit \| next turn starts at \$0\.47\n/,
  );
});

test('missing prompt-cache evidence uses one conservative cold estimate', () => {
  const input = payload();
  const { prompt_cache: _promptCache, ...withoutCache } = input;
  const snapshot = snapshotFromClaude(withoutCache, NOW);
  assert.equal(snapshot.cache.state, 'unknown');
  assert.equal(snapshot.nextTurn.state, 'cold');
  assert.match(
    renderStatus(snapshot),
    /^Opus high \| arc \| ctx 8% of 200k \(16k\) \| cache unknown \| next turn starts at \$0\.17\n/,
  );
});

test('unobserved caching leaves the next turn unpriced without claiming expiry', () => {
  const input = payload();
  input.prompt_cache.caching_observed = false;
  input.prompt_cache.warm = false;
  const snapshot = snapshotFromClaude(input, NOW);
  assert.equal(snapshot.cache.state, 'not-observed');
  assert.equal(snapshot.nextTurn.state, 'unpriced');
  assert.equal(snapshot.nextTurn.startsAtDollars, null);
  assert.equal(snapshot.nextTurn.warmDollars, null);
  assert.equal(snapshot.nextTurn.coldDollars, null);
  assert.match(
    renderStatus(snapshot),
    /^Opus high \| arc \| ctx 8% of 200k \(16k\) \| cache not observed \| next turn unknown\n/,
  );
});

test('null early-session fields stay unknown instead of becoming zero', () => {
  const snapshot = snapshotFromClaude(
    {
      model: { id: 'claude-opus-5', display_name: 'Opus' },
      context_window: {
        total_input_tokens: 0,
        context_window_size: 200_000,
        used_percentage: null,
        current_usage: null,
      },
    },
    NOW,
  );
  assert.equal(renderStatus(snapshot), 'Opus | ctx -- of 200k (0) | cache unknown | next turn unknown');
  assert.equal(snapshot.nextTurn.startsAtDollars, null);
});

test('narrow output removes optional model and hit rate but retains required facts', () => {
  const line = renderStatus(snapshotFromClaude(payload(), NOW), 70);
  assert.equal(
    line,
    'ctx 8% of 200k (16k) | cache warm 5m | next turn starts at $0.02\nsession $0.12, 45s | 5h 23.5%, resets 1h 0m | 7d 41.2%, resets 96h 0m',
  );
});

test('a nonzero session estimate below one cent never reads as zero', () => {
  const input = payload();
  input.cost.total_cost_usd = 0.0049;
  const line = renderStatus(snapshotFromClaude(input, NOW), 70);
  assert.match(line, /\nsession <\$0\.01, 45s \|/);
});

test('non-object input fails validation', () => {
  assert.throws(() => snapshotFromClaude([], NOW), /must be a JSON object/);
});
