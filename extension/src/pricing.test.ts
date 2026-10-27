// Model pricing and cache costs.
import { test, vi } from 'vitest';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  rateFor,
  effortChangeKeepsCache,
  estimateCost,
  estimateCacheReadCost,
  estimateCompactionCost,
  compactionEstimate,
  CLAUDE_COMPACTION_INSTRUCTION_TOKENS,
  CLAUDE_COMPACTION_SUMMARY_CHARS_PER_TOKEN,
  formatConservativeCost,
  formatCost,
  cacheHitPercent,
  contextWindowFor,
  nextTurnFloor,
  CACHE_LIFETIME_MS,
  CONSERVATIVE_CACHE_BOUNDARY_MS,
  cacheLifetimeFor,
  PROMOTIONS,
  quoteUsage,
  contextBandForRequest,
  bedrockClaudeListMultiplier,
  resolveModelPricing,
  MODEL_DEFINITIONS,
  MODEL_RATE_ALIASES,
  type ModelDefinition,
} from './pricing.ts';

import { TurnUsage } from './transcript.ts';
import { COMPACTION_SAMPLES, previousContextOf, type CompactionCalibrationRow } from './turnfixtures.ts';

// Keep expected model ids independent of the price table so missing rows fail the test.

const MODEL_IDS = [
  'claude-fable-5-1',
  'claude-mythos-5-1',
  'claude-fable-5',
  'claude-mythos-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-sonnet-5-5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-haiku-5-5',
  'claude-haiku-4-5',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.6',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-6-astra',
  'gpt-6.1-sol',
  'gpt-6.1-terra',
  'gpt-6-sol',
  'gpt-6-luna',
];

const usage = (over: Partial<TurnUsage> = {}): TurnUsage => ({
  requests: 0,
  input: 0,
  cacheWrite1h: 0,
  cacheWrite5m: 0,
  cacheWrite30m: 0,
  cacheRead: 0,
  output: 0,
  thinking: 0,
  ...over,
});

// Expected provider policies cover model aliases and suffixes.
const RECORDED_POLICY = {
  kind: 'recorded',
  sources: [
    'https://platform.claude.com/docs/en/build-with-claude/prompt-caching',
    'https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html',
  ],
} as const;
const directPolicy = (lifetime: '5m' | '30m') => ({
  kind: 'documented' as const,
  lifetime,
  sources: ['https://developers.openai.com/api/docs/guides/prompt-caching'] as const,
});
const bedrockPolicy = {
  kind: 'documented',
  lifetime: '30m',
  sources: ['https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html'],
} as const;
const claudeSupport = (
  pattern: RegExp,
  models: string[],
  rate: ModelDefinition['rate'],
  window: number,
  fast?: ModelDefinition['rate'],
  effectiveDate?: string,
) => ({
  models,
  definition: {
    pattern,
    rate,
    window,
    cachePolicy: RECORDED_POLICY,
    ...(models.includes('claude-fable-5-1')
      ? { effortChangeKeepsCache: /^claude-fable-5-1(?:-\d{8})?(?:\[[^\]]+\])?$/ }
      : models.some((model) => ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].includes(model))
        ? { effortChangeKeepsCache: true as const }
        : {}),
    ...(fast ? { fast } : {}),
    ...(effectiveDate ? { effectiveDate } : {}),
  },
});
const openaiSupport = (
  pattern: RegExp,
  models: string[],
  rate: ModelDefinition['rate'],
  window: number,
  lifetime: '5m' | '30m',
  bedrock?: ModelDefinition['bedrock'],
  tiers?: Record<string, number>,
) => ({
  models,
  definition: {
    pattern,
    rate,
    window,
    cachePolicy: directPolicy(lifetime),
    providers: ['openai'],
    maxPricedContext: 272_000,
    longContext: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
    ...(bedrock ? { bedrock } : {}),
    ...(tiers ? { serviceTierMultipliers: tiers } : {}),
  },
});
const bedrockSupport = (effectiveDate: string, profileEffectiveDate?: string, model?: string) => ({
  prefixes: /^(?:global|[a-z]{2})?$/,
  regionalMultiplier: 1.1,
  window: 272_000,
  cachePolicy: bedrockPolicy,
  effectiveDate,
  ...(profileEffectiveDate ? { profileEffectiveDate } : {}),
  ...(model ? { model } : {}),
});
const SUPPORT_MATRIX: { models: string[]; definition: ModelDefinition }[] = [
  claudeSupport(
    /^claude-(fable|mythos)-5-1(?:-\d{8})?(?:\[[^\]]+\])?$/,
    ['claude-fable-5-1', 'claude-mythos-5-1'],
    { input: 10, cacheRead: 0.25, output: 50 },
    1_000_000,
  ),
  claudeSupport(
    /^claude-(fable|mythos)-5(?:-\d{8})?(?:\[[^\]]+\])?$/,
    ['claude-fable-5', 'claude-mythos-5'],
    { input: 10, output: 50 },
    1_000_000,
  ),
  claudeSupport(
    /^claude-opus-5-5(?:-\d{8})?(?:\[[^\]]+\])?$/,
    ['claude-opus-5-5'],
    { input: 4, cacheRead: 0.2, output: 20 },
    1_000_000,
    { input: 8, cacheRead: 0.4, output: 40 },
  ),
  claudeSupport(
    /^claude-opus-(5|4-8)(?:-\d{8})?(?:\[[^\]]+\])?$/,
    ['claude-opus-5', 'claude-opus-4-8'],
    { input: 5, output: 25 },
    1_000_000,
    { input: 10, output: 50 },
  ),
  claudeSupport(
    /^claude-opus-(4-7|4-6)(?:-\d{8})?(?:\[[^\]]+\])?$/,
    ['claude-opus-4-7', 'claude-opus-4-6'],
    { input: 5, output: 25 },
    1_000_000,
  ),
  claudeSupport(/^claude-opus-4-5(?:-\d{8})?(?:\[[^\]]+\])?$/, ['claude-opus-4-5'], { input: 5, output: 25 }, 200_000),
  claudeSupport(
    /^claude-sonnet-5-5(?:-\d{8})?(?:\[[^\]]+\])?$/,
    ['claude-sonnet-5-5'],
    { input: 2, cacheRead: 0.1, output: 10 },
    1_000_000,
    undefined,
    '2026-10-07',
  ),
  claudeSupport(
    /^claude-sonnet-5(?:-\d{8})?(?:\[[^\]]+\])?$/,
    ['claude-sonnet-5'],
    { input: 2, output: 10 },
    1_000_000,
    undefined,
    '2026-08-10',
  ),
  claudeSupport(
    /^claude-sonnet-4-6(?:-\d{8})?(?:\[[^\]]+\])?$/,
    ['claude-sonnet-4-6'],
    { input: 3, output: 15 },
    1_000_000,
  ),
  claudeSupport(
    /^claude-sonnet-4-5(?:-\d{8})?(?:\[[^\]]+\])?$/,
    ['claude-sonnet-4-5'],
    { input: 3, output: 15 },
    200_000,
  ),
  {
    models: ['claude-haiku-5-5'],
    definition: {
      effortChangeKeepsCache: true,
      ...claudeSupport(
        /^claude-haiku-5-5(?:-\d{8})?(?:\[[^\]]+\])?$/,
        [],
        { input: 0.1, output: 0.5 },
        1_000_000,
        undefined,
        '2026-10-07',
      ).definition,
      longContext: { threshold: 100_000, inputMultiplier: 5, outputMultiplier: 5 },
    },
  },
  claudeSupport(/^claude-haiku-4-5(?:-\d{8})?(?:\[[^\]]+\])?$/, ['claude-haiku-4-5'], { input: 1, output: 5 }, 200_000),
  openaiSupport(
    /^gpt-6-astra$/,
    ['gpt-6-astra'],
    { input: 10, cacheWrite30m: 12.5, cacheRead: 1, output: 50 },
    1_050_000,
    '30m',
    {
      prefixes: /^(?:us|global)?$/,
      regionalMultiplier: 1.1,
      window: 1_050_000,
      cachePolicy: {
        kind: 'unknown',
        sources: ['https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-astra.html'],
      },
      effectiveDate: null,
    },
  ),
  openaiSupport(
    /^gpt-6\.1-sol$/,
    ['gpt-6.1-sol'],
    { input: 2, cacheWrite30m: 2.5, cacheRead: 0.1, output: 10 },
    1_050_000,
    '30m',
    {
      prefixes: /^(?:us|global)?$/,
      regionalMultiplier: 1.1,
      window: 1_000_000,
      effectiveDate: '2026-09-29',
      cachePolicy: {
        kind: 'documented',
        lifetime: '30m',
        sources: ['https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-1-sol.html'],
      },
    },
    { fast: 2, priority: 2, flex: 0.5, batch: 0.5 },
  ),
  openaiSupport(
    /^gpt-6\.1-terra$/,
    ['gpt-6.1-terra'],
    { input: 1, cacheWrite30m: 1.25, cacheRead: 0.05, output: 5 },
    1_050_000,
    '30m',
    undefined,
    { fast: 2, priority: 2, flex: 0.5, batch: 0.5 },
  ),
  openaiSupport(
    /^gpt-6-sol$/,
    ['gpt-6-sol'],
    { input: 2, cacheWrite30m: 2.5, cacheRead: 0.2, output: 10 },
    1_050_000,
    '30m',
    bedrockSupport('2026-09-22'),
  ),
  openaiSupport(
    /^gpt-6-luna$/,
    ['gpt-6-luna'],
    { input: 0.1, cacheWrite30m: 0.125, cacheRead: 0.01, output: 0.5 },
    1_050_000,
    '30m',
    bedrockSupport('2026-09-22'),
  ),
  openaiSupport(
    /^gpt-5\.5(?:-2026-04-23)?$/,
    ['gpt-5.5', 'gpt-5.5-2026-04-23'],
    { input: 5, cacheRead: 0.5, output: 30 },
    1_050_000,
    '30m',
  ),
  openaiSupport(
    /^gpt-5\.4(?:-2026-03-05)?$/,
    ['gpt-5.4', 'gpt-5.4-2026-03-05'],
    { input: 2.5, cacheRead: 0.25, output: 15 },
    1_050_000,
    '5m',
  ),
  openaiSupport(
    /^gpt-5\.6(?:-sol)?$/,
    ['gpt-5.6', 'gpt-5.6-sol'],
    { input: 4, cacheWrite30m: 5, cacheRead: 0.4, output: 20 },
    272_000,
    '30m',
    bedrockSupport('2026-08-21', '2026-08-20', 'gpt-5.6-sol'),
  ),
  openaiSupport(
    /^gpt-5\.6-terra$/,
    ['gpt-5.6-terra'],
    { input: 2, cacheWrite30m: 2.5, cacheRead: 0.2, output: 12 },
    272_000,
    '30m',
    bedrockSupport('2026-07-30', '2026-08-20'),
  ),
  openaiSupport(
    /^gpt-5\.6-luna$/,
    ['gpt-5.6-luna'],
    { input: 0.2, cacheWrite30m: 0.25, cacheRead: 0.02, output: 1.2 },
    272_000,
    '30m',
    bedrockSupport('2026-07-30', '2026-08-20'),
  ),
];

test('every supported pricing route has independently reviewed complete pricing and cache policy', () => {
  const actual = MODEL_DEFINITIONS.map(({ promotion: _promotion, ...definition }) => definition);
  assert.deepEqual(
    actual,
    SUPPORT_MATRIX.map((entry) => entry.definition),
  );
  assert.deepEqual(MODEL_RATE_ALIASES, { 'codex-auto-review': 'gpt-5.4' });
  const prefixes = [
    '',
    'global',
    ...Array.from({ length: 26 * 26 }, (_, n) => String.fromCharCode(97 + Math.floor(n / 26), 97 + (n % 26))),
  ];
  for (const { models, definition } of SUPPORT_MATRIX) {
    for (const model of models) {
      for (const provider of definition.providers ? [null, 'openai'] : [null]) {
        const resolved = resolveModelPricing(model, provider);
        assert.ok(resolved, model);
        assert.deepEqual(resolved.rate, definition.rate, model);
        assert.deepEqual(resolved.cachePolicy, definition.cachePolicy, model);
        assert.equal(resolved.window, definition.window, model);
        if (!definition.providers) {
          for (const inferenceClass of [null, 'global', 'in-region', 'bedrock-regional'] as const) {
            const route = resolveModelPricing(model, provider, inferenceClass);
            assert.deepEqual(route?.cachePolicy, RECORDED_POLICY, model);
            const multiplier = inferenceClass === 'in-region' || inferenceClass === 'bedrock-regional' ? 1.1 : 1;
            for (const serviceTier of ['standard', 'fast']) {
              const quote = quoteUsage({ model, provider, inferenceClass, serviceTier, usage: usage({ input: 1000 }) });
              const rate = serviceTier === 'fast' ? definition.fast : definition.rate;
              if (!rate) {
                assert.equal(quote, null, model);
                continue;
              }
              assert.ok(quote, model);
              assert.ok(Math.abs(quote.cost - (rate.input * multiplier) / 1000) < 1e-12, model);
            }
          }
        }
      }
      for (const prefix of prefixes) {
        const id = `${prefix ? prefix + '.' : ''}openai.${model}`;
        const expected = definition.bedrock;
        const supported = expected && expected.prefixes.test(prefix) && (!expected.model || expected.model === model);
        const resolved = resolveModelPricing(id, 'amazon-bedrock');
        if (!supported) {
          assert.equal(resolved, null, id);
          continue;
        }
        assert.ok(resolved, id);
        assert.deepEqual(resolved.cachePolicy, expected.cachePolicy, id);
        assert.equal(resolved.window, expected.window, id);
        assert.equal(resolved.regionalMultiplier, prefix === 'global' ? 1 : 1.1, id);
      }
    }
  }
});

test('a rate is found by family and generation together', () => {
  assert.deepEqual(rateFor('claude-opus-5-5'), { input: 4, cacheRead: 0.2, output: 20 });
  assert.deepEqual(rateFor('claude-opus-5'), { input: 5, output: 25 });
  assert.deepEqual(rateFor('claude-sonnet-5-5'), { input: 2, cacheRead: 0.1, output: 10 });
  assert.deepEqual(rateFor('claude-sonnet-5'), { input: 2, output: 10 });
  assert.deepEqual(rateFor('claude-haiku-4-5'), { input: 1, output: 5 });
  assert.deepEqual(rateFor('claude-fable-5'), { input: 10, output: 50 });
  assert.deepEqual(rateFor('claude-mythos-5'), { input: 10, output: 50 });
  assert.deepEqual(rateFor('claude-fable-5-1'), { input: 10, cacheRead: 0.25, output: 50 });
  assert.deepEqual(rateFor('claude-mythos-5-1'), { input: 10, cacheRead: 0.25, output: 50 });
});

test('a dated snapshot and the long-context variant are billed as their generation', () => {
  assert.deepEqual(rateFor('claude-opus-5[1m]'), { input: 5, output: 25 });
  assert.deepEqual(rateFor('claude-opus-5-5[1m]'), { input: 4, cacheRead: 0.2, output: 20 });
  assert.deepEqual(rateFor('claude-opus-5-5-20260922'), { input: 4, cacheRead: 0.2, output: 20 });
  assert.deepEqual(rateFor('claude-haiku-4-5-20251001'), { input: 1, output: 5 });
  assert.deepEqual(rateFor('gpt-5.5-2026-04-23'), { input: 5, cacheRead: 0.5, output: 30 });
  assert.deepEqual(rateFor('gpt-5.4-2026-03-05'), { input: 2.5, cacheRead: 0.25, output: 15 });
  assert.equal(rateFor('gpt-5.6-sol-2026-08-01'), null);
  assert.equal(rateFor('gpt-5.5-2026-08-01'), null);
  assert.equal(rateFor('gpt-5.4-2026-08-01'), null);
});

test('a model the table has never heard of has no rate, rather than its sibling one', () => {
  // Unsupported generations must not inherit a sibling rate.

  assert.equal(rateFor('claude-opus-4-1-20250805'), null);
  assert.equal(rateFor('claude-sonnet-3-7'), null);
  assert.equal(rateFor('claude-opus-4-88'), null);
  assert.equal(rateFor('claude-haiku-4-55'), null);
  assert.equal(rateFor('claude-sonnet-4-4'), null);
  assert.equal(rateFor('claude-fable-5-2'), null);
  assert.equal(rateFor('claude-opus-5-1'), null);
  assert.equal(rateFor('claude-sonnet-5-1'), null);
  assert.equal(rateFor('claude-sonnet-5-6'), null);
  assert.equal(rateFor('claude-haiku-4-5-1'), null);
  assert.equal(rateFor('gpt-5'), null);
  assert.equal(rateFor(null), null);
});

test('the Codex generations in use are priced, and unverified siblings are not', () => {
  // Keep expected rates explicit so table changes require corresponding fixture changes.

  assert.deepEqual(rateFor('gpt-5.6-sol'), { input: 4, cacheWrite30m: 5, cacheRead: 0.4, output: 20 });
  assert.deepEqual(rateFor('gpt-5.6'), { input: 4, cacheWrite30m: 5, cacheRead: 0.4, output: 20 });
  assert.deepEqual(rateFor('gpt-5.6-terra'), { input: 2, cacheWrite30m: 2.5, cacheRead: 0.2, output: 12 });
  assert.deepEqual(rateFor('gpt-5.6-luna'), { input: 0.2, cacheWrite30m: 0.25, cacheRead: 0.02, output: 1.2 });
  assert.deepEqual(rateFor('gpt-5.5'), { input: 5, cacheRead: 0.5, output: 30 });
  assert.deepEqual(rateFor('gpt-5.4'), { input: 2.5, cacheRead: 0.25, output: 15 });
  assert.equal(contextWindowFor('gpt-5.6-sol'), 272_000);
  assert.equal(contextWindowFor('gpt-5.5'), 1_050_000);
  assert.equal(contextWindowFor('gpt-5.4'), 1_050_000);
  assert.equal(rateFor('gpt-5.3-codex'), null);
  assert.equal(rateFor('gpt-5.5-codex'), null);
  assert.equal(rateFor('gpt-5-sol'), null);
  // Only documented aliases match, so a longer product name is not billed as a shorter one.
  assert.equal(rateFor('gpt-5.6-solar'), null);
  assert.equal(rateFor('gpt-5.6-sol-codex'), null);
  assert.equal(rateFor('gpt-5.66-sol'), null);
});

test('Codex Auto Review shares GPT-5.4 token rates only on the OpenAI route', () => {
  const gpt54 = rateFor('gpt-5.4', 'openai');
  assert.deepEqual(rateFor('codex-auto-review'), gpt54);
  assert.deepEqual(rateFor('codex-auto-review', 'openai'), gpt54);
  assert.equal(contextWindowFor('codex-auto-review'), contextWindowFor('gpt-5.4', 'openai'));
  assert.equal(rateFor('codex-auto-review', 'private-gateway'), null);
  assert.equal(rateFor('codex-auto-review', 'amazon-bedrock'), null);

  const short = usage({ requests: 1, input: 100_000, cacheWrite30m: 20_000, cacheRead: 100_000, output: 10_000 });
  const long = usage({ requests: 1, input: 150_000, cacheWrite30m: 20_000, cacheRead: 150_000, output: 10_000 });
  const close = (actual: number | undefined, expected: number) => {
    assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
  };
  close(
    quoteUsage({ usage: short, model: 'codex-auto-review', provider: 'openai', requestTokens: 220_000 })?.cost,
    0.425,
  );
  close(
    quoteUsage({ usage: long, model: 'codex-auto-review', provider: 'openai', requestTokens: 320_000 })?.cost,
    1.05,
  );
  assert.equal(
    quoteUsage({ usage: short, model: 'codex-auto-review', provider: 'openai', requestTokens: 220_000 })?.source,
    'OpenAI Codex rate card',
  );
});

test('GPT-6 Astra uses its published rate and context window only for its exact OpenAI ID', () => {
  const rate = { input: 10, cacheWrite30m: 12.5, cacheRead: 1, output: 50 };
  assert.deepEqual(rateFor('gpt-6-astra'), rate);
  assert.deepEqual(rateFor('gpt-6-astra', 'openai'), rate);
  assert.equal(contextWindowFor('gpt-6-astra', 'openai'), 1_050_000);
  assert.equal(rateFor('gpt-6-astra', 'openai', 1_050_000), null);
  for (const model of ['gpt-6', 'gpt-6-astra-codex', 'gpt-6-astra-2026-09-04', 'gpt-6-astral', 'gpt-6-astra[1m]']) {
    assert.equal(rateFor(model), null, model);
  }
  for (const provider of ['amazon-bedrock', 'unknown-provider']) {
    assert.equal(rateFor('gpt-6-astra', provider), null, provider);
  }
});

test('GPT-6.1 Sol prices its exact OpenAI ID in both request bands', () => {
  const model = 'gpt-6.1-sol';
  const rate = { input: 2, cacheWrite30m: 2.5, cacheRead: 0.1, output: 10 };
  const tokens = usage({ requests: 1, input: 100_000, cacheWrite30m: 20_000, cacheRead: 100_000, output: 10_000 });
  assert.deepEqual(rateFor(model, 'openai'), rate);
  assert.equal(contextWindowFor(model, 'openai'), 1_050_000);
  assert.equal(cacheLifetimeFor(model, 'openai'), '30m');
  assert.equal(rateFor(model, 'openai', 1_050_000), null);
  assert.equal(rateFor(model, 'amazon-bedrock'), null);
  assert.equal(rateFor('gpt-6.1-sol-codex', 'openai'), null);
  assert.equal(rateFor('gpt-6.11-sol', 'openai'), null);
  assert.equal(quoteUsage({ usage: tokens, model, provider: 'openai', requestTokens: 230_000 })?.cost, 0.36);
  assert.deepEqual(quoteUsage({ usage: tokens, model, provider: 'openai', requestTokens: 272_001 })?.rate, {
    input: 4,
    cacheWrite30m: 5,
    cacheRead: 0.2,
    output: 15,
  });
  assert.equal(quoteUsage({ usage: tokens, model, provider: 'openai', requestTokens: 272_001 })?.cost, 0.67);
  assert.deepEqual(rateFor('gpt-6-sol', 'openai'), { input: 2, cacheWrite30m: 2.5, cacheRead: 0.2, output: 10 });
  assert.equal(
    quoteUsage({ usage: tokens, model, provider: 'openai', requestTokens: 230_000, serviceTier: 'default' })?.cost,
    0.36,
  );
  for (const [serviceTier, multiplier] of [
    ['fast', 2],
    ['priority', 2],
    ['flex', 0.5],
    ['batch', 0.5],
  ] as const) {
    assert.equal(
      quoteUsage({ usage: tokens, model, provider: 'openai', requestTokens: 230_000, serviceTier })?.cost,
      0.36 * multiplier,
    );
    assert.equal(
      quoteUsage({ usage: tokens, model, provider: 'openai', requestTokens: 272_001, serviceTier })?.cost,
      0.67 * multiplier,
    );
  }
  assert.equal(quoteUsage({ usage: tokens, model, provider: 'openai', serviceTier: 'unknown-tier' }), null);
});

test('GPT-6.1 Terra prices only its exact direct identity across request bands and tiers', () => {
  const model = 'gpt-6.1-terra';
  const tokens = usage({ requests: 1, input: 100_000, cacheWrite30m: 20_000, cacheRead: 100_000, output: 10_000 });
  assert.equal(contextWindowFor(model, 'openai'), 1_050_000);
  assert.equal(cacheLifetimeFor(model, 'openai'), '30m');
  assert.equal(effortChangeKeepsCache(model, 'openai'), false);
  assert.equal(rateFor(model, 'openai', 1_050_000), null);
  for (const requestTokens of [220_000, 272_000, 272_001]) {
    const expected = requestTokens > 272_000 ? 0.335 : 0.18;
    assert.equal(contextBandForRequest(model, 'openai', requestTokens), requestTokens > 272_000 ? 'long' : 'short');
    for (const [serviceTier, multiplier] of [
      [null, 1],
      ['default', 1],
      ['fast', 2],
      ['priority', 2],
      ['flex', 0.5],
      ['batch', 0.5],
    ] as const) {
      const quote = quoteUsage({ usage: tokens, model, provider: 'openai', requestTokens, serviceTier });
      assert.ok(quote && Math.abs(quote.cost - expected * multiplier) < 1e-12);
    }
  }
  assert.equal(quoteUsage({ usage: tokens, model, provider: 'openai', serviceTier: 'unknown-tier' }), null);
  for (const provider of ['amazon-bedrock', 'unknown-provider']) {
    assert.equal(quoteUsage({ usage: tokens, model, provider }), null);
    assert.equal(contextWindowFor(model, provider), null);
  }
  for (const id of [
    'gpt-6.11-terra',
    'gpt-6.1-terra-codex',
    'gpt-6.1-terra-2026-10-27',
    'gpt-6.1-terra[1m]',
    'openai.gpt-6.1-terra',
    'us.openai.gpt-6.1-terra',
    'global.openai.gpt-6.1-terra',
  ]) {
    assert.equal(rateFor(id), null, id);
    assert.equal(rateFor(id, 'amazon-bedrock'), null, id);
  }
});

test('Bedrock GPT-6.1 Sol prices supported routes with its documented cache lifetime and provider-specific tiers', () => {
  const provider = 'amazon-bedrock';
  const short = usage({ requests: 1, input: 100_000, cacheWrite30m: 20_000, cacheRead: 100_000, output: 10_000 });
  const long = usage({ requests: 1, input: 150_000, cacheWrite30m: 20_000, cacheRead: 150_000, output: 10_000 });
  for (const [model, shortRate, longRate, shortCost, longCost] of [
    [
      'openai.gpt-6.1-sol',
      { input: 2.2, cacheWrite30m: 2.75, cacheRead: 0.11, output: 11 },
      { input: 4.4, cacheWrite30m: 5.5, cacheRead: 0.22, output: 16.5 },
      0.396,
      0.968,
    ],
    [
      'us.openai.gpt-6.1-sol',
      { input: 2.2, cacheWrite30m: 2.75, cacheRead: 0.11, output: 11 },
      { input: 4.4, cacheWrite30m: 5.5, cacheRead: 0.22, output: 16.5 },
      0.396,
      0.968,
    ],
    [
      'global.openai.gpt-6.1-sol',
      { input: 2, cacheWrite30m: 2.5, cacheRead: 0.1, output: 10 },
      { input: 4, cacheWrite30m: 5, cacheRead: 0.2, output: 15 },
      0.36,
      0.88,
    ],
  ] as const) {
    assert.deepEqual(rateFor(model, provider), shortRate);
    assert.equal(contextWindowFor(model, provider), 1_000_000);
    assert.equal(cacheLifetimeFor(model, provider), '30m');
    assert.equal(contextBandForRequest(model, provider, 272_000), 'short');
    assert.equal(contextBandForRequest(model, provider, 272_001), 'long');
    assert.equal(rateFor(model, provider, 1_000_000), null);
    assert.equal(rateFor(model, 'openai'), null);
    assert.equal(rateFor(model), null);
    for (const serviceTier of [null, 'standard', 'default']) {
      for (const [tokens, counts, rate, cost, band] of [
        [220_000, short, shortRate, shortCost, 'short'],
        [320_000, long, longRate, longCost, 'long'],
      ] as const) {
        const quote = quoteUsage({ usage: counts, model, provider, requestTokens: tokens, serviceTier });
        assert.deepEqual(quote?.rate, rate);
        assert.equal(quote?.contextBand, band);
        assert.equal(quote?.effectiveDate, '2026-09-29');
        assert.equal(quote?.source, 'AWS Bedrock standard');
        assert.ok(quote && Math.abs(quote.cost - cost) < 1e-12);
      }
    }
    for (const serviceTier of ['fast', 'priority', 'flex', 'batch', 'unknown-tier']) {
      assert.equal(quoteUsage({ usage: short, model, provider, requestTokens: 220_000, serviceTier }), null);
    }
    const mixed = usage({
      requests: 2,
      input: 250_000,
      cacheWrite30m: 40_000,
      cacheRead: 250_000,
      output: 20_000,
      byContextBand: { short, long },
    });
    assert.ok(Math.abs(estimateCost(mixed, model, provider)! - shortCost - longCost) < 1e-12);
    const { byContextBand: _bands, ...unbanded } = mixed;
    assert.equal(estimateCost(unbanded, model, provider), null);
  }
  for (const model of [
    'gpt-6.1-sol',
    'eu.openai.gpt-6.1-sol',
    'ap.openai.gpt-6.1-sol',
    'xx.openai.gpt-6.1-sol',
    'US.openai.gpt-6.1-sol',
    'openai.gpt-6.1-sol-extra',
    'openai.gpt-6.11-sol',
    'openai.gpt-6.2-sol',
    'openai.gpt-5.6',
  ]) {
    assert.equal(rateFor(model, provider), null, model);
    assert.equal(contextWindowFor(model, provider), null, model);
    assert.equal(cacheLifetimeFor(model, provider), null, model);
    assert.equal(contextBandForRequest(model, provider, 100_000), null, model);
  }
});

test('GPT-6 Sol and Luna use their published rates and context windows only for their exact OpenAI IDs', () => {
  const models = [
    ['gpt-6-sol', { input: 2, cacheWrite30m: 2.5, cacheRead: 0.2, output: 10 }],
    ['gpt-6-luna', { input: 0.1, cacheWrite30m: 0.125, cacheRead: 0.01, output: 0.5 }],
  ] as const;
  for (const [model, rate] of models) {
    assert.deepEqual(rateFor(model), rate);
    assert.deepEqual(rateFor(model, 'openai'), rate);
    assert.equal(contextWindowFor(model, 'openai'), 1_050_000);
    assert.equal(rateFor(model, 'amazon-bedrock'), null);
    assert.equal(rateFor(`${model}-2026-09-22`), null);
    assert.equal(rateFor(`${model}-codex`), null);
  }
});

test('Bedrock GPT-6 Sol and Luna price regional and global requests in both context bands', () => {
  const models = [
    ['sol', { input: 2, cacheWrite30m: 2.5, cacheRead: 0.2, output: 10 }],
    ['luna', { input: 0.1, cacheWrite30m: 0.125, cacheRead: 0.01, output: 0.5 }],
  ] as const;
  const scaled = (value: number, factor: number) => Number((value * factor).toPrecision(15));
  for (const [family, base] of models) {
    const model = `openai.gpt-6-${family}`;
    assert.equal(rateFor(model), null);
    assert.equal(rateFor(`gpt-6-${family}`, 'amazon-bedrock'), null);
    assert.equal(contextWindowFor(model, 'amazon-bedrock'), 272_000);
    assert.equal(cacheLifetimeFor(model, 'amazon-bedrock'), '30m');
    for (const [id, tokens, multiplier] of [
      [model, 272_000, 1.1],
      [`us.${model}`, 272_001, 1.1],
      [`global.${model}`, 272_000, 1],
      [`global.${model}`, 272_001, 1],
    ] as const) {
      const long = tokens > 272_000;
      const quote = quoteUsage({ usage: usage(), model: id, provider: 'amazon-bedrock', requestTokens: tokens });
      assert.deepEqual(quote?.rate, {
        input: scaled(base.input, multiplier * (long ? 2 : 1)),
        cacheWrite30m: scaled(base.cacheWrite30m, multiplier * (long ? 2 : 1)),
        cacheRead: scaled(base.cacheRead, multiplier * (long ? 2 : 1)),
        output: scaled(base.output, multiplier * (long ? 1.5 : 1)),
      });
      assert.equal(quote?.contextBand, long ? 'long' : 'short');
      assert.equal(quote?.effectiveDate, '2026-09-22');
    }
    assert.equal(rateFor(`${model}-extra`, 'amazon-bedrock'), null);
  }
});

test('GPT-6 Astra prices cache writes and reads across request bands', () => {
  const short = usage({ requests: 1, input: 100_000, cacheWrite30m: 20_000, cacheRead: 100_000, output: 10_000 });
  const long = usage({ requests: 1, input: 100_000, cacheWrite30m: 100_000, cacheRead: 100_000, output: 10_000 });
  const mixed = usage({
    requests: 2,
    input: 200_000,
    cacheWrite30m: 120_000,
    cacheRead: 200_000,
    output: 20_000,
    byContextBand: { short, long },
  });
  const close = (actual: number | null, expected: number) => {
    assert.ok(actual !== null && Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
  };
  close(estimateCost(short, 'gpt-6-astra', 'openai', 1_050_000), 1.85);
  close(estimateCost(long, 'gpt-6-astra', 'openai', 1_050_000), 5.45);
  close(estimateCost(mixed, 'gpt-6-astra', 'openai', 1_050_000), 7.3);
  close(estimateCacheReadCost(mixed, 'gpt-6-astra', 'openai', 1_050_000), 0.3);
  const { byContextBand: _byContextBand, ...legacy } = mixed;
  assert.equal(estimateCost(legacy, 'gpt-6-astra', 'openai', 1_050_000), null);
});

test('GPT-6 Astra keeps nonstandard service tiers unpriced without a recorded amount', () => {
  const input = {
    usage: usage({ requests: 1, input: 100_000 }),
    model: 'gpt-6-astra',
    provider: 'openai',
    requestTokens: 100_000,
  };
  assert.equal(quoteUsage({ ...input, serviceTier: 'default' })?.cost, 1);
  for (const serviceTier of ['fast', 'priority', 'flex', 'batch', 'unknown-tier']) {
    assert.equal(quoteUsage({ ...input, serviceTier }), null, serviceTier);
    assert.equal(quoteUsage({ ...input, serviceTier, reportedCost: 0.75 })?.cost, 0.75, serviceTier);
  }
});

test('a Bedrock model uses its provider rate and never the direct OpenAI row', () => {
  assert.deepEqual(rateFor('openai.gpt-5.6-sol', 'amazon-bedrock'), {
    input: 4.4,
    cacheWrite30m: 5.5,
    cacheRead: 0.44,
    output: 22.0,
  });
  assert.equal(contextWindowFor('openai.gpt-5.6-sol', 'amazon-bedrock'), 272_000);
  assert.equal(rateFor('openai.gpt-5.6-sol'), null);
  assert.equal(rateFor('openai.gpt-5.6-sol-long-context', 'amazon-bedrock'), null);
  assert.equal(rateFor('gpt-5.6-sol', 'amazon-bedrock'), null);
  assert.equal(rateFor('gpt-5.6-sol', 'unknown-provider'), null);
  assert.deepEqual(rateFor('gpt-5.6-sol', 'openai'), {
    input: 4,
    cacheWrite30m: 5,
    cacheRead: 0.4,
    output: 20,
  });
});

test('a Bedrock turn prices its input, 30-minute write, read, and output tiers', () => {
  const cost = estimateCost(
    usage({
      requests: 1,
      input: 10_000,
      cacheWrite30m: 10_000,
      cacheRead: 10_000,
      output: 10_000,
    }),
    'openai.gpt-5.6-sol',
    'amazon-bedrock',
  );
  assert.ok(cost !== null && Math.abs(cost - 0.3234) < 1e-12);
  assert.equal(
    estimateCost(
      usage({ requests: 2, input: 1_000_000, output: 1_000_000 }),
      'openai.gpt-5.6-sol',
      'amazon-bedrock',
      258_400,
    ),
    null,
  );
});

test('a direct GPT-5.6 turn prices cache writes as well as reads', () => {
  const cost = estimateCost(
    usage({
      requests: 1,
      input: 1_000_000,
      cacheWrite30m: 1_000_000,
      cacheRead: 1_000_000,
      output: 1_000_000,
    }),
    'gpt-5.6-sol',
  );
  assert.equal(cost, 8 + 10 + 0.8 + 30);
  assert.equal(
    estimateCost(usage({ requests: 1, cacheWrite30m: 100_000 }), 'gpt-5.5', 'openai'),
    null,
    'an unpriced cache-write category must not be silently dropped from the estimate',
  );
});

test('each cache tier is billed at its own multiple of the input rate', () => {
  // One million tokens per category costs $5 input, $10 one-hour writes, $6.25 five-minute writes, $0.50 reads, and $25 output.
  const cost = estimateCost(
    usage({
      input: 1_000_000,
      cacheWrite1h: 1_000_000,
      cacheWrite5m: 1_000_000,
      cacheRead: 1_000_000,
      output: 1_000_000,
    }),
    'claude-opus-5',
  );
  assert.equal(cost, 5 + 10 + 6.25 + 0.5 + 25);
});

test('Fable and Mythos 5.1 use their quarter-price cache read', () => {
  assert.equal(estimateCacheReadCost(usage({ cacheRead: 1_000_000 }), 'claude-fable-5-1'), 0.25);
  assert.equal(estimateCacheReadCost(usage({ cacheRead: 1_000_000 }), 'claude-mythos-5-1'), 0.25);
  assert.equal(estimateCacheReadCost(usage({ cacheRead: 1_000_000 }), 'claude-fable-5'), 1);
});

// Opus 5.5 has a 0.05x cache-read rate. Its write rates use the shared input multipliers.

test('Opus 5.5 reads at its published twentieth and writes at the shared multiples', () => {
  assert.equal(estimateCacheReadCost(usage({ cacheRead: 1_000_000 }), 'claude-opus-5-5'), 0.2);
  assert.equal(estimateCost(usage({ cacheWrite5m: 1_000_000 }), 'claude-opus-5-5'), 5);
  assert.equal(estimateCost(usage({ cacheWrite1h: 1_000_000 }), 'claude-opus-5-5'), 8);
  assert.equal(estimateCacheReadCost(usage({ cacheRead: 1_000_000 }), 'claude-opus-5'), 0.5);
});

test('direct OpenAI request quotes change the whole rate above 272K', () => {
  const expected = [
    [
      'gpt-6-astra',
      { input: 10, cacheWrite30m: 12.5, cacheRead: 1, output: 50 },
      { input: 20, cacheWrite30m: 25, cacheRead: 2, output: 75 },
    ],
    [
      'gpt-6-sol',
      { input: 2, cacheWrite30m: 2.5, cacheRead: 0.2, output: 10 },
      { input: 4, cacheWrite30m: 5, cacheRead: 0.4, output: 15 },
    ],
    [
      'gpt-6-luna',
      { input: 0.1, cacheWrite30m: 0.125, cacheRead: 0.01, output: 0.5 },
      { input: 0.2, cacheWrite30m: 0.25, cacheRead: 0.02, output: 0.75 },
    ],
    ['gpt-5.5', { input: 5, cacheRead: 0.5, output: 30 }, { input: 10, cacheRead: 1, output: 45 }],
    ['gpt-5.4', { input: 2.5, cacheRead: 0.25, output: 15 }, { input: 5, cacheRead: 0.5, output: 22.5 }],
    [
      'gpt-5.6-sol',
      { input: 4, cacheWrite30m: 5, cacheRead: 0.4, output: 20 },
      { input: 8, cacheWrite30m: 10, cacheRead: 0.8, output: 30 },
    ],
    [
      'gpt-5.6-terra',
      { input: 2, cacheWrite30m: 2.5, cacheRead: 0.2, output: 12 },
      { input: 4, cacheWrite30m: 5, cacheRead: 0.4, output: 18 },
    ],
    [
      'gpt-5.6-luna',
      { input: 0.2, cacheWrite30m: 0.25, cacheRead: 0.02, output: 1.2 },
      { input: 0.4, cacheWrite30m: 0.5, cacheRead: 0.04, output: 1.8 },
    ],
  ] as const;
  for (const [model, short, long] of expected) {
    const atBoundary = quoteUsage({ usage: usage(), model, provider: 'openai', requestTokens: 272_000 });
    const overBoundary = quoteUsage({ usage: usage(), model, provider: 'openai', requestTokens: 272_001 });
    assert.deepEqual(atBoundary?.rate, short, model);
    assert.equal(atBoundary?.contextBand, 'short', model);
    assert.deepEqual(overBoundary?.rate, long, model);
    assert.equal(overBoundary?.contextBand, 'long', model);
  }
});

test('retained bands price a synthetic model with a different request threshold', () => {
  const definition: ModelDefinition = {
    pattern: /^synthetic-model$/,
    cachePolicy: { kind: 'unknown', sources: ['https://example.com/synthetic-model'] },
    rate: { input: 2, output: 10 },
    providers: ['openai'],
    window: 1_000_000,
    longContext: { threshold: 500_000, inputMultiplier: 2, outputMultiplier: 1.5 },
  };
  const definitions = [definition, ...MODEL_DEFINITIONS];
  const lookup = vi.spyOn(MODEL_DEFINITIONS, 'find').mockImplementation((predicate) => definitions.find(predicate));
  try {
    const short = usage({ requests: 1, input: 300_000 });
    const long = usage({ requests: 1, input: 600_000 });
    assert.equal(contextBandForRequest('synthetic-model', 'openai', 500_000), 'short');
    assert.equal(contextBandForRequest('synthetic-model', 'openai', 500_001), 'long');
    assert.equal(
      estimateCost(usage({ requests: 2, input: 900_000, byContextBand: { short, long } }), 'synthetic-model', 'openai'),
      3,
    );
    assert.equal(
      quoteUsage({ usage: long, model: 'synthetic-model', provider: 'openai', contextBand: 'long' })?.cost,
      2.4,
    );
    assert.equal(
      quoteUsage({
        usage: short,
        model: 'synthetic-model',
        provider: 'openai',
        contextBand: 'long',
        requestTokens: 300_000,
      }),
      null,
    );
    assert.equal(quoteUsage({ usage: long, model: 'unknown-model', contextBand: 'long' }), null);
  } finally {
    lookup.mockRestore();
  }
});

test('shared resolution requires explicit provider or recorded Claude Bedrock evidence', () => {
  assert.equal(resolveModelPricing('claude-opus-5-5')?.route, 'unspecified');
  const claude = resolveModelPricing('claude-opus-5-5', null, 'bedrock-regional');
  assert.equal(claude?.route, 'bedrock');
  assert.equal(claude?.provider, null);
  assert.equal(claude?.regionalMultiplier, 1.1);
  assert.equal(claude?.cacheLifetime, null);
  for (const provider of ['amazon-bedrock', 'openai', 'router', 'unknown']) {
    assert.equal(resolveModelPricing('claude-opus-5-5', provider), null);
    assert.equal(resolveModelPricing('openai.gpt-6.1-sol', provider === 'amazon-bedrock' ? null : provider), null);
  }
  assert.equal(resolveModelPricing('eu.openai.gpt-6.1-sol', 'amazon-bedrock'), null);
  assert.equal(resolveModelPricing('gpt-6.1-sol', 'amazon-bedrock'), null);
  for (const model of ['openai.gpt-6.1-sol', 'us.openai.gpt-6.1-sol', 'global.openai.gpt-6.1-sol']) {
    const resolved = resolveModelPricing(model, 'amazon-bedrock');
    assert.equal(resolved?.route, 'bedrock');
    assert.equal(resolved?.threshold, 272_000);
    assert.equal(resolved?.window, 1_000_000);
    assert.equal(resolved?.cacheLifetime, '30m');
    assert.equal(
      resolved?.inferenceClass,
      model.startsWith('global.') ? 'global' : model.startsWith('us.') ? 'geo' : 'in-region',
    );
  }
});

test('a turn keeps request bands when several requests are priced together', () => {
  const short = usage({ requests: 2, input: 300_000 });
  const twoShortRequests = usage({
    requests: 2,
    input: 300_000,
    byContextBand: { short },
  });
  assert.ok(Math.abs(estimateCost(twoShortRequests, 'gpt-5.5', 'openai', 1_050_000)! - 1.5) < 1e-12);

  const mixed = usage({
    requests: 2,
    input: 400_000,
    output: 30_000,
    byContextBand: {
      short: usage({ requests: 1, input: 100_000, output: 10_000 }),
      long: usage({ requests: 1, input: 300_000, output: 20_000 }),
    },
  });
  assert.ok(Math.abs(estimateCost(mixed, 'gpt-5.5', 'openai', 1_050_000)! - 4.7) < 1e-12);
  assert.equal(
    estimateCost(
      usage({
        requests: 1,
        input: 10,
        byContextBand: { short: usage({ requests: 1, input: 9 }) },
      }),
      'gpt-5.5',
      'openai',
      258_400,
    ),
    null,
    'band totals that do not reconcile must not produce a partial estimate',
  );
  assert.equal(
    estimateCost(usage({ requests: 2, input: 300_000 }), 'gpt-5.5', 'openai', 258_400),
    null,
    'a legacy aggregate with no request bands must not be priced from its turn total',
  );
  assert.equal(
    estimateCost(usage({ requests: 2, input: 100_000 }), 'gpt-5.5', 'openai', 258_400),
    0.5,
    'an aggregate below the threshold can only contain short requests',
  );
  assert.ok(
    Math.abs(estimateCost(usage({ requests: 1, input: 300_000 }), 'gpt-5.5', 'openai', 258_400)! - 3) < 1e-12,
    'one unbanded request still carries enough input volume to select its rate',
  );
});

test('what a turn paid to re-read the session is the cache tier of its own cost', () => {
  // Two million Opus 5 cached input tokens cost one dollar at $0.50 per million.

  assert.equal(estimateCacheReadCost(usage({ cacheRead: 2_000_000 }), 'claude-opus-5'), 1);
  assert.equal(estimateCacheReadCost(usage({ requests: 1, cacheRead: 100_000 }), 'gpt-5.6-sol'), 0.04);
  const mixed = usage({
    requests: 2,
    cacheRead: 400_000,
    byContextBand: {
      short: usage({ requests: 1, cacheRead: 100_000 }),
      long: usage({ requests: 1, cacheRead: 300_000 }),
    },
  });
  assert.ok(Math.abs(estimateCacheReadCost(mixed, 'gpt-5.5', 'openai', 1_050_000)! - 0.35) < 1e-12);
  assert.equal(
    estimateCacheReadCost(
      usage({
        requests: 2,
        input: 200_000,
        cacheRead: 200_000,
      }),
      'gpt-5.5',
      'openai',
      1_050_000,
    ),
    null,
    'a cache-read slice must not invent a short rate for an ambiguous legacy aggregate',
  );
  // Nothing read back, nothing paid for reading it back.
  assert.equal(estimateCacheReadCost(usage({ input: 1_000_000, output: 1_000_000 }), 'claude-opus-5'), 0);
  // Unsupported models have no cache-read estimate.

  assert.equal(estimateCacheReadCost(usage({ cacheRead: 2_000_000 }), 'claude-opus-4-1'), null);
  assert.equal(estimateCacheReadCost(usage({ cacheRead: 2_000_000 }), null), null);
  // Cache-only usage must have the same cost through both estimators.

  for (const model of ['claude-opus-5', 'claude-haiku-4-5', 'gpt-5.6-terra']) {
    const only = usage({ cacheRead: 3_500_000 });
    assert.equal(
      estimateCacheReadCost(only, model),
      estimateCost(only, model),
      `${model} charges a lone cache read differently through the two functions`,
    );
  }
});

test('cost is null for a model with no rate, and zero for a turn that spent nothing', () => {
  assert.equal(estimateCost(usage({ output: 1000 }), 'claude-opus-4-1'), null);
  assert.equal(estimateCost(usage(), 'claude-opus-5'), 0);
});

test('a cost reads as money at the scale it lands on', () => {
  assert.equal(formatCost(null), null);
  assert.equal(formatCost(0), null);
  assert.equal(formatCost(0.004), '<$0.01');
  assert.equal(formatCost(0.01), '$0.01');
  assert.equal(formatCost(7.049), '$7.05');
  assert.equal(formatCost(9.999), '$10.00');
  assert.equal(formatCost(10), '$10');
  assert.equal(formatCost(123.4), '$123');
});

test('the cache hit rate is the read share of everything read', () => {
  assert.equal(cacheHitPercent(usage()), null, 'nothing read, nothing to report');
  assert.equal(cacheHitPercent(usage({ output: 5000 })), null, 'output is not input');
  assert.equal(cacheHitPercent(usage({ cacheRead: 900, input: 100 })), 90);
  assert.equal(cacheHitPercent(usage({ cacheWrite1h: 1000 })), 0, 'a first run reads nothing back');
  assert.equal(cacheHitPercent(usage({ cacheWrite30m: 1000 })), 0, 'a Bedrock cache fill reads nothing back');
});

test('the context window is found by family and generation together', () => {
  assert.equal(contextWindowFor('claude-fable-5'), 1_000_000);
  assert.equal(contextWindowFor('claude-mythos-5'), 1_000_000);
  assert.equal(contextWindowFor('claude-opus-5-5'), 1_000_000);
  assert.equal(contextWindowFor('claude-opus-5'), 1_000_000);
  assert.equal(contextWindowFor('claude-opus-4-8'), 1_000_000);
  assert.equal(contextWindowFor('claude-opus-4-7'), 1_000_000);
  assert.equal(contextWindowFor('claude-opus-4-6'), 1_000_000);
  assert.equal(contextWindowFor('claude-opus-4-5'), 200_000);
  assert.equal(contextWindowFor('claude-sonnet-5-5'), 1_000_000);
  assert.equal(contextWindowFor('claude-sonnet-5'), 1_000_000);
  assert.equal(contextWindowFor('claude-sonnet-4-6'), 1_000_000);
  assert.equal(contextWindowFor('claude-sonnet-4-5'), 200_000);
  assert.equal(contextWindowFor('claude-fable-5-1'), 1_000_000);
  // Haiku remains at the smaller window alongside the supported Claude 4.5 models.
  assert.equal(contextWindowFor('claude-haiku-4-5'), 200_000);
});

test("a dated snapshot and a bracketed suffix carry their generation's window", () => {
  assert.equal(contextWindowFor('claude-opus-5[1m]'), 1_000_000);
  assert.equal(contextWindowFor('claude-haiku-4-5-20251001'), 200_000);
});

test('a model the window table has never heard of has no window, rather than its sibling one', () => {
  // Unsupported generations must not inherit a sibling context window.

  assert.equal(contextWindowFor('claude-opus-4-1-20250805'), null);
  assert.equal(contextWindowFor('claude-sonnet-3-7'), null);
  assert.equal(contextWindowFor('claude-opus-4-88'), null);
  // Reject the near-match Haiku id instead of assigning the supported generation's 200k window.

  assert.equal(contextWindowFor('claude-haiku-4-55'), null);
  assert.equal(contextWindowFor('claude-sonnet-4-4'), null);
  assert.equal(contextWindowFor('gpt-5'), null);
  assert.equal(contextWindowFor(null), null);
});

const COMPACTED_AT = Date.UTC(2026, 8, 20, 10, 0, 30);

// The estimate's inputs for one measured compaction, as a reader of its transcript finds them.
function sampleEstimate(row: CompactionCalibrationRow) {
  return {
    model: row.model,
    at: COMPACTED_AT,
    contextBefore: previousContextOf(row),
    contextAfter: row.postTokens ?? 1,
    previousRequest: {
      tokens: previousContextOf(row),
      cacheRead: row.previousRead,
      cacheWrite: row.previousWrite,
      at: COMPACTED_AT - row.idleMinutes * 60_000,
      lifetime: row.lifetime,
    },
    firstRequestCachedTokens: row.firstRead,
    summaryChars: row.summaryChars,
  };
}

for (const row of COMPACTION_SAMPLES.filter((sample) => sample.firstRead === null)) {
  test(`the compaction ${row.name} is estimated within 20% of its real cost`, () => {
    const input = sampleEstimate(row);
    assert.equal(compactionEstimate(input)?.basis, row.firstRead === null ? 'warm' : 'cold', row.name);
    const estimate = estimateCompactionCost(input);
    assert.ok(estimate !== null, row.name);
    const error = estimate / row.realCost - 1;
    assert.ok(
      Math.abs(error) <= 0.2,
      `${row.name}: ${estimate.toFixed(4)} against ${row.realCost} is ${(error * 100).toFixed(1)}% off`,
    );
  });
}

test('a warm compaction reads back what the request before it read and writes what it wrote', () => {
  const row = COMPACTION_SAMPLES.find((item) => item.name === 'fb1756cf warm after a cache miss')!;
  const usage = compactionEstimate(sampleEstimate(row))!.usage;
  assert.deepEqual(
    [usage.cacheRead, usage.cacheWrite5m, usage.cacheWrite1h, usage.input, usage.output],
    [
      10_086,
      126_961,
      0,
      CLAUDE_COMPACTION_INSTRUCTION_TOKENS,
      Math.round(10_634 / CLAUDE_COMPACTION_SUMMARY_CHARS_PER_TOKEN),
    ],
  );
});

test('a cold compaction writes the shared prefix and sends the remaining context uncached', () => {
  const row = COMPACTION_SAMPLES.find((item) => item.name === '386c0253 cold')!;
  const usage = compactionEstimate(sampleEstimate(row))!.usage;
  assert.deepEqual(
    [usage.cacheRead, usage.cacheWrite5m, usage.cacheWrite1h, usage.input],
    [0, 0, 10_086, previousContextOf(row) + CLAUDE_COMPACTION_INSTRUCTION_TOKENS - 10_086],
  );
  const unknown = compactionEstimate({ ...sampleEstimate(row), firstRequestCachedTokens: null })!.usage;
  assert.deepEqual(
    [unknown.cacheRead, unknown.input],
    [0, previousContextOf(row) + CLAUDE_COMPACTION_INSTRUCTION_TOKENS],
    'with no first request known, the whole input is uncached',
  );
});

test('a cold compaction sends no negative uncached input when the first request read more than the context', () => {
  const row = COMPACTION_SAMPLES.find((item) => item.name === '386c0253 cold')!;
  const usage = compactionEstimate({ ...sampleEstimate(row), firstRequestCachedTokens: 400_000 })!.usage;
  assert.equal(usage.input, CLAUDE_COMPACTION_INSTRUCTION_TOKENS);
  assert.equal(usage.cacheWrite1h, previousContextOf(row));
  const cost = estimateCompactionCost({ ...sampleEstimate(row), firstRequestCachedTokens: 400_000 });
  const output = estimateCost({ ...usage, cacheRead: 0 }, row.model);
  assert.ok(cost !== null && output !== null && cost >= output, `${cost} is at least the output ${output}`);
});

test('a compaction estimate prices the stored summary text as output, and the recorded summary size without one', () => {
  const row = COMPACTION_SAMPLES[0];
  assert.equal(
    compactionEstimate(sampleEstimate(row))!.usage.output,
    Math.round(row.summaryChars / CLAUDE_COMPACTION_SUMMARY_CHARS_PER_TOKEN),
  );
  assert.equal(compactionEstimate({ ...sampleEstimate(row), summaryChars: null })!.usage.output, row.postTokens);
});

test('a compaction with no earlier request is sized from the recorded context before it', () => {
  const unknown = estimateCompactionCost({
    model: 'claude-sonnet-5',
    at: COMPACTED_AT,
    contextBefore: 178_822,
    contextAfter: 3_090,
  });
  const known = estimateCompactionCost({
    model: 'claude-sonnet-5',
    at: COMPACTED_AT,
    contextBefore: 40_000,
    contextAfter: 3_090,
    previousRequest: { tokens: 178_822, at: null, lifetime: null },
  });
  assert.ok(unknown !== null);
  assert.equal(unknown, known, 'an unknown clock or lifetime reads the request back warm');
});

test('a compaction estimate needs both recorded figures and a priced model', () => {
  const at = COMPACTED_AT;
  assert.ok(
    Math.abs(estimateCompactionCost({ model: 'gpt-5.5', at, contextBefore: 400_000, contextAfter: 10_000 })! - 0.85) <
      1e-12,
    'a long compaction uses the long rate for both the cached read and output',
  );
  assert.equal(
    estimateCompactionCost({ model: 'claude-opus-4-1', at, contextBefore: 629_292, contextAfter: 14_172 }),
    null,
  );
  assert.equal(
    estimateCompactionCost({ model: 'claude-opus-5', at, contextBefore: 0, contextAfter: 0 }),
    null,
    'nothing read means nothing ran',
  );
  // A compaction estimate requires both the input and summary token counts.

  assert.equal(
    estimateCompactionCost({ model: 'claude-opus-5', at, contextBefore: 629_292, contextAfter: 0 }),
    null,
    'half the figures is not a cost',
  );
});

test('a warm quote keeps the newest answer out of the cache its request bought', () => {
  const floor = nextTurnFloor({
    contextTokens: 620_000,
    freshTokens: 100_000,
    model: 'claude-opus-5',
    tier: '1h',
  });
  assert.equal(floor?.warm, 0.81);
  assert.equal(floor?.cold, 7.2);
});

test('a fast session quotes its next turn at the fast rate', () => {
  // Opus 5 at fast speed: $10 input, $1 cached read and $20 one-hour write per million tokens.
  const input = { contextTokens: 100_000, model: 'claude-opus-5', tier: '1h' as const, serviceTier: 'fast' };
  const close = (actual: number | undefined, expected: number) => {
    assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
  };
  const floor = nextTurnFloor(input);
  close(floor?.warm, 0.1);
  close(floor?.cold, 2);
  assert.equal(nextTurnFloor({ ...input, model: 'claude-opus-4-7' }), null, 'Opus 4.7 has no fast rate');
});

test('a retention lifetime without a write price keeps ordinary cold input', () => {
  const input = {
    contextTokens: 100_000,
    model: 'gpt-5.5',
    provider: 'openai',
    contextWindow: 1_050_000,
    tier: '5m' as const,
    inferenceClass: null,
    serviceTier: null,
  };
  const floor = nextTurnFloor(input);
  assert.equal(floor?.cold, 0.5);
  assert.equal(floor?.coldRate, 5);
  assert.equal(floor?.coldIsWrite, false);
});

test('a promotional rate is checked again once the date it was held to has passed', () => {
  // Expired promotions require a rate review. Each promotion names its standard rate and review source.

  const today = new Date().toISOString().slice(0, 10);
  const over = PROMOTIONS.filter((p) => p.promo.until < today);
  assert.deepEqual(
    over.map((p) => String(p.pattern)),
    [],
    'a promotional rate is past the date it was held to:\n' +
      over
        .map(
          (p) =>
            `  ${p.pattern} was held to ${p.promo.until}, standard ` +
            `$${p.promo.standard.input}/$${p.promo.standard.output}. ${p.promo.note}`,
        )
        .join('\n'),
  );
});

test('every promotion names a row that exists, and every rate it names is real', () => {
  // A promotion must match a supported model row.

  for (const { pattern, promo } of PROMOTIONS) {
    const named = MODEL_IDS.filter((id) => pattern.test(id));
    assert.ok(named.length > 0, `${pattern} is promotional but prices no model this table knows`);
    for (const id of named) {
      assert.ok(rateFor(id), `${pattern} is promotional but ${id} has no rate at all`);
    }
    assert.ok(promo.standard.input > 0 && promo.standard.output > 0, `${pattern} has no standard rate to go back to`);
    assert.match(promo.until, /^\d{4}-\d{2}-\d{2}$/, `${pattern} has no date it is held to`);
    // A promotional row must differ from its stated standard rate.

    for (const id of named) {
      assert.notDeepEqual(
        rateFor(id),
        promo.standard,
        `${pattern} says ${id} is promotional, but its row already charges the standard rate`,
      );
    }
  }
});

test('Sonnet 5 and Sonnet 4.6 are priced apart, because their published rates differ', () => {
  // Sonnet 5 and Sonnet 4.6 have distinct expected rates.

  assert.deepEqual(rateFor('claude-sonnet-5'), { input: 2, output: 10 });
  assert.deepEqual(rateFor('claude-sonnet-4-6'), { input: 3, output: 15 });
  assert.notDeepEqual(rateFor('claude-sonnet-5'), rateFor('claude-sonnet-4-6'));
  // A dated snapshot of either still takes its own generation's rate.
  assert.deepEqual(rateFor('claude-sonnet-5-20260101'), { input: 2, output: 10 });
});

test('Sonnet 5.5 reads cache at $0.10 through a dated snapshot and a context suffix', () => {
  assert.deepEqual(rateFor('claude-sonnet-5-5-20260901'), { input: 2, cacheRead: 0.1, output: 10 });
  assert.deepEqual(rateFor('claude-sonnet-5-5[1m]'), { input: 2, cacheRead: 0.1, output: 10 });
  assert.equal(quoteUsage({ usage: usage(), model: 'claude-sonnet-5-5' })?.effectiveDate, '2026-10-07');
  const reads = usage({ requests: 1, cacheRead: 1_000_000 });
  assert.equal(quoteUsage({ usage: reads, model: 'claude-sonnet-5-5' })?.cost, 0.1);
  // A recorded charge keeps the amount billed, at the earlier rate or any other.
  const recorded = quoteUsage({ usage: reads, model: 'claude-sonnet-5-5', reportedCost: 0.2 });
  assert.deepEqual([recorded?.cost, recorded?.source], [0.2, 'reported']);
});

test('Sonnet 5 is no longer a dated promotion', () => {
  assert.equal(
    PROMOTIONS.some(({ pattern }) => pattern.test('claude-sonnet-5')),
    false,
  );
  assert.deepEqual(rateFor('claude-sonnet-5'), { input: 2, output: 10 });
  assert.equal(quoteUsage({ usage: usage(), model: 'claude-sonnet-5' })?.effectiveDate, '2026-08-10');
});

test('an in-region Claude request carries the in-region multiplier and a global one does not', () => {
  const inRegion = quoteUsage({
    usage: usage({ input: 1_000_000, output: 1_000_000 }),
    model: 'claude-sonnet-4-6',
    inferenceClass: 'in-region',
  });
  assert.deepEqual(inRegion?.rate, { input: 3.3, output: 16.5 });
  assert.equal(inRegion?.cost, 19.8);
  assert.equal(
    quoteUsage({
      usage: usage({ input: 1_000_000, output: 1_000_000 }),
      model: 'claude-sonnet-4-6',
      inferenceClass: 'global',
    })?.cost,
    18,
  );
  assert.equal(
    quoteUsage({ usage: usage({ input: 1_000_000, output: 1_000_000 }), model: 'claude-sonnet-4-6' })?.cost,
    18,
  );
  assert.deepEqual(
    quoteUsage({
      usage: usage({ input: 1_000_000, output: 1_000_000 }),
      model: 'claude-haiku-4-5',
      inferenceClass: 'in-region',
    })?.rate,
    { input: 1.1, output: 5.5 },
  );
  // The multiplier reaches a published cache read as well as the input and output rates.
  assert.deepEqual(
    quoteUsage({
      usage: usage({ input: 1_000_000, output: 1_000_000 }),
      model: 'claude-opus-5-5',
      inferenceClass: 'in-region',
    })?.rate,
    { input: 4.4, output: 22, cacheRead: 0.22 },
  );
});

test('provider-specific standard service tiers use standard public rates', () => {
  const claude = { usage: usage({ input: 1_000_000 }), model: 'claude-sonnet-5' };
  assert.equal(quoteUsage({ ...claude, serviceTier: 'standard' })?.cost, 2);
  assert.equal(quoteUsage({ ...claude, serviceTier: 'priority' }), null);
  assert.equal(quoteUsage({ ...claude, serviceTier: 'fast' }), null);
  assert.equal(quoteUsage({ ...claude, serviceTier: 'unrecognized-tier' }), null);

  const codex = { usage: usage({ input: 1_000_000 }), model: 'gpt-5.6-sol', provider: 'openai' };
  assert.equal(quoteUsage({ ...codex, serviceTier: 'default' })?.cost, 4);
  assert.equal(quoteUsage({ ...codex, serviceTier: 'priority' }), null);
  assert.equal(quoteUsage({ ...codex, serviceTier: 'flex' }), null);
  assert.equal(quoteUsage({ ...codex, serviceTier: 'unrecognized-tier' }), null);

  const bedrock = {
    usage: usage({ input: 1_000_000 }),
    model: 'openai.gpt-5.6-sol',
    provider: 'amazon-bedrock',
    requestTokens: 1,
  };
  assert.equal(quoteUsage({ ...bedrock, serviceTier: 'default' })?.cost, 4.4);
  for (const serviceTier of ['unknown', 'priority', 'fast', 'flex', 'unrecognized-tier']) {
    assert.equal(quoteUsage({ ...bedrock, serviceTier }), null, serviceTier);
  }
});

// One million tokens in every Claude category, so each quote below is the sum of the rates.
const EVERY_CLAUDE_CATEGORY = usage({
  input: 1_000_000,
  cacheWrite5m: 1_000_000,
  cacheWrite1h: 1_000_000,
  cacheRead: 1_000_000,
  output: 1_000_000,
});

// Fast cache prices use the model's fast input rate, including the explicit Opus 5.5 cache-read rate.

test('every model that sells fast mode quotes its fast rate, cache reads and writes included', () => {
  const opus55 = { input: 8, cacheRead: 0.4, output: 40 };
  const opus5 = { input: 10, output: 50 };
  for (const [model, standard, fast, rate] of [
    ['claude-opus-5-5', 4 + 5 + 8 + 0.2 + 20, 8 + 10 + 16 + 0.4 + 40, opus55],
    ['claude-opus-5-5-20260922[1m]', 4 + 5 + 8 + 0.2 + 20, 8 + 10 + 16 + 0.4 + 40, opus55],
    ['claude-opus-5', 5 + 6.25 + 10 + 0.5 + 25, 10 + 12.5 + 20 + 1 + 50, opus5],
    ['claude-opus-4-8', 5 + 6.25 + 10 + 0.5 + 25, 10 + 12.5 + 20 + 1 + 50, opus5],
  ] as const) {
    const input = { usage: EVERY_CLAUDE_CATEGORY, model };
    assert.ok(Math.abs(quoteUsage({ ...input, serviceTier: 'standard' })!.cost - standard) < 1e-9, model);
    const quote = quoteUsage({ ...input, serviceTier: 'fast' });
    assert.deepEqual(quote?.rate, rate, model);
    assert.ok(Math.abs(quote!.cost - fast) < 1e-9, model);
  }
});

// Fast pricing holds across the whole context window.
test('a fast quote holds at any request size', () => {
  const quote = quoteUsage({
    usage: usage({ input: 1_000_000 }),
    model: 'claude-opus-5',
    serviceTier: 'fast',
    requestTokens: 900_000,
  });
  assert.equal(quote?.cost, 10);
});

test('a fast turn on a model with no published fast rate quotes no cost', () => {
  for (const model of [
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-opus-4-5',
    'claude-fable-5-1',
    'claude-sonnet-5-5',
    'claude-sonnet-5',
    'claude-haiku-5-5',
    'claude-haiku-4-5',
  ]) {
    const input = { usage: usage({ input: 1_000_000 }), model };
    assert.notEqual(quoteUsage({ ...input, serviceTier: 'standard' }), null, model);
    assert.equal(quoteUsage({ ...input, serviceTier: 'fast' }), null, model);
  }
});

test('a speed that is neither standard nor fast quotes no cost', () => {
  const input = { usage: usage({ input: 1_000_000 }), model: 'claude-opus-5-5' };
  assert.equal(quoteUsage({ ...input, serviceTier: 'turbo' }), null);
});

// A named provider prevents the direct Claude fast-rate estimate.

test('a fast Claude turn on a named provider quotes no cost', () => {
  for (const provider of ['amazon-bedrock', 'google-vertex', 'anthropic']) {
    assert.equal(
      quoteUsage({ usage: usage({ input: 1_000_000 }), model: 'claude-opus-5-5', provider, serviceTier: 'fast' }),
      null,
      provider,
    );
  }
});

// The pricing page stacks the in-region multiplier on top of fast mode pricing.
test('an in-region request carries the in-region multiplier on top of the fast rate', () => {
  const quote = quoteUsage({
    usage: usage({ input: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 }),
    model: 'claude-opus-5-5',
    serviceTier: 'fast',
    inferenceClass: 'in-region',
  });
  assert.deepEqual(quote?.rate, { input: 8.8, cacheRead: 0.44, output: 44 });
  assert.ok(Math.abs(quote!.cost - (8.8 + 0.44 + 44)) < 1e-9);
});

test('a configured rate refuses a fast turn unless it names the fast tier', () => {
  const input = { usage: usage({ input: 1_000_000 }), model: 'claude-opus-5-5' };
  const override = { rate: { input: 3, output: 15 }, source: 'workspace agreement', effectiveDate: '2026-08-31' };
  assert.equal(quoteUsage({ ...input, override })?.cost, 3);
  assert.equal(quoteUsage({ ...input, serviceTier: 'standard', override })?.cost, 3);
  assert.equal(quoteUsage({ ...input, serviceTier: 'fast', override }), null);
  assert.equal(quoteUsage({ ...input, serviceTier: 'fast', override: { ...override, serviceTier: 'fast' } })?.cost, 3);
});

test('a recorded cost outranks a fast-mode price, because it is what the session actually paid', () => {
  const input = { usage: usage({ input: 1_000_000 }), model: 'claude-opus-5-5' };
  const quote = quoteUsage({ ...input, serviceTier: 'fast', reportedCost: 7.5 });
  assert.equal(quote?.cost, 7.5);
  assert.equal(quote?.source, 'reported');
});

test('aggregate estimates retain inference class and service tier quote rules', () => {
  const tokens = usage({ requests: 1, input: 1_000_000 });
  assert.equal(
    estimateCost(tokens, 'claude-sonnet-4-6', null, 1_000_000, null, {
      inferenceClass: 'in-region',
      serviceTier: 'standard',
    }),
    3.3,
  );
  assert.equal(
    estimateCost(tokens, 'claude-sonnet-4-6', null, 1_000_000, null, {
      inferenceClass: 'in-region',
      serviceTier: 'priority',
    }),
    null,
  );
});

test('Bedrock request quotes distinguish regional, geographic, and global short and long bands', () => {
  const expected = {
    sol: [
      [4.4, 5.5, 0.44, 22],
      [8.8, 11, 0.88, 33],
      [4, 5, 0.4, 20],
      [8, 10, 0.8, 30],
    ],
    terra: [
      [2.2, 2.75, 0.22, 13.2],
      [4.4, 5.5, 0.44, 19.8],
      [2, 2.5, 0.2, 12],
      [4, 5, 0.4, 18],
    ],
    luna: [
      [0.22, 0.275, 0.022, 1.32],
      [0.44, 0.55, 0.044, 1.98],
      [0.2, 0.25, 0.02, 1.2],
      [0.4, 0.5, 0.04, 1.8],
    ],
  } as const;
  for (const [family, rates] of Object.entries(expected)) {
    for (const [model, tokens, index] of [
      [`openai.gpt-5.6-${family}`, 272_000, 0],
      [`openai.gpt-5.6-${family}`, 272_001, 1],
      [`global.openai.gpt-5.6-${family}`, 272_000, 2],
      [`global.openai.gpt-5.6-${family}`, 272_001, 3],
      [`us.openai.gpt-5.6-${family}`, 272_000, 0],
    ] as const) {
      const [input, cacheWrite30m, cacheRead, output] = rates[index];
      assert.deepEqual(quoteUsage({ usage: usage(), model, provider: 'amazon-bedrock', requestTokens: tokens })?.rate, {
        input,
        cacheWrite30m,
        cacheRead,
        output,
      });
    }
  }
  assert.equal(
    quoteUsage({ usage: usage(), model: 'openai.gpt-5.6-sol', provider: 'amazon-bedrock', requestTokens: 1 })
      ?.effectiveDate,
    '2026-08-21',
  );
  assert.equal(
    quoteUsage({ usage: usage(), model: 'openai.gpt-5.6-terra', provider: 'amazon-bedrock', requestTokens: 1 })
      ?.effectiveDate,
    '2026-07-30',
  );
  assert.equal(
    quoteUsage({ usage: usage(), model: 'us.openai.gpt-5.6-sol', provider: 'amazon-bedrock', requestTokens: 1 })
      ?.effectiveDate,
    '2026-08-20',
  );
  assert.equal(
    quoteUsage({ usage: usage(), model: 'openai.gpt-5.6-sol', provider: 'amazon-bedrock', contextWindow: 1_000_000 }),
    null,
  );
});

test('reported cost and configured rates retain their own provenance', () => {
  assert.deepEqual(quoteUsage({ usage: usage({ input: 1_000_000 }), model: 'claude-sonnet-5', reportedCost: 0.37 }), {
    cost: 0.37,
    rate: null,
    source: 'reported',
    effectiveDate: null,
    reported: true,
    provider: null,
    serviceTier: null,
    inferenceClass: null,
    contextBand: null,
  });
  assert.deepEqual(
    quoteUsage({
      usage: usage({ input: 1_000_000 }),
      model: 'claude-sonnet-5',
      override: {
        rate: { input: 7, output: 9 },
        source: 'workspace agreement',
        effectiveDate: '2026-08-31',
      },
    }),
    {
      cost: 7,
      rate: { input: 7, output: 9 },
      source: 'workspace agreement',
      effectiveDate: '2026-08-31',
      reported: false,
      provider: null,
      serviceTier: null,
      inferenceClass: null,
      contextBand: null,
    },
  );
});

// The cost figures guide states cache multiples by provider and model.

test('the cost figures guide states the provider-specific cache multiples the pricer charges', () => {
  const guide = readFileSync(path.join(__dirname, '..', '..', 'docs', 'cost-figures.md'), 'utf8');
  const cellsFor = (model: string): string[] => {
    const row = guide.split('\n').find((line) => line.startsWith(`| [${model}]`));
    assert.ok(row, `the ${model} row must exist`);
    return row
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
  };
  const multiplesIn = (cell: string): number[] => {
    const values = [...cell.matchAll(/([0-9.]+)x/g)].map((match) => Number(match[1]));
    assert.ok(values.length > 0, `the cache cell must contain a multiplier: ${cell}`);
    return values;
  };
  const ratio = (model: string, category: Partial<TurnUsage>): number => {
    const base = quoteUsage({ model, usage: usage({ input: 1_000_000 }), reportedCost: null });
    const priced = quoteUsage({ model, usage: usage(category), reportedCost: null });
    assert.ok(base && priced, `${model} must price`);
    return priced.cost / base.cost;
  };

  // Each Claude row names its models as "Claude Opus 5.5", which is the identity claude-opus-5-5.
  for (const label of ['Claude Sonnet 5 and Claude Opus 5', 'Claude Opus 5.5 and Claude Sonnet 5.5']) {
    const cells = cellsFor(label);
    for (const name of label.split(' and ')) {
      const model = name.toLowerCase().replace(/[ .]/g, '-');
      assert.deepEqual(multiplesIn(cells[1]), [ratio(model, { cacheRead: 1_000_000 })], model);
      assert.deepEqual(
        multiplesIn(cells[2]),
        [ratio(model, { cacheWrite5m: 1_000_000 }), ratio(model, { cacheWrite1h: 1_000_000 })],
        model,
      );
    }
  }

  const fable = cellsFor('Claude Fable 5.1');
  assert.deepEqual(multiplesIn(fable[1]), [ratio('claude-fable-5-1', { cacheRead: 1_000_000 })]);
  assert.deepEqual(multiplesIn(fable[2]), [
    ratio('claude-fable-5-1', { cacheWrite5m: 1_000_000 }),
    ratio('claude-fable-5-1', { cacheWrite1h: 1_000_000 }),
  ]);

  const openai = cellsFor('Other priced direct OpenAI GPT-5.6 and GPT-6 models');
  assert.deepEqual(multiplesIn(openai[1]), [ratio('gpt-5.6-sol', { cacheRead: 1_000_000 })]);
  assert.deepEqual(multiplesIn(openai[2]), [ratio('gpt-5.6-sol', { cacheWrite30m: 1_000_000 })]);

  const terra61 = cellsFor('OpenAI GPT-6.1 Terra');
  assert.deepEqual(multiplesIn(terra61[1]), [ratio('gpt-6.1-terra', { cacheRead: 1_000_000 })]);
  assert.deepEqual(multiplesIn(terra61[2]), [ratio('gpt-6.1-terra', { cacheWrite30m: 1_000_000 })]);

  const sol61 = cellsFor('OpenAI GPT-6.1 Sol');
  assert.deepEqual(multiplesIn(sol61[1]), [ratio('gpt-6.1-sol', { cacheRead: 1_000_000 })]);
  assert.deepEqual(multiplesIn(sol61[2]), [ratio('gpt-6.1-sol', { cacheWrite30m: 1_000_000 })]);
});

// The next-turn starting price includes the existing context before any new prompt text.

test('the floor prices the whole context at the rate the next request pays', () => {
  const floor = nextTurnFloor({ contextTokens: 620_000, model: 'claude-opus-5', tier: '1h' });
  assert.ok(floor, 'opus-5 is in the table, so this figure is not optional');
  // 620,000 read back at a tenth of $5.00 a million is $0.31, and written again at twice it
  // is $6.20.
  assert.equal(formatCost(floor.warm), '$0.31');
  assert.equal(formatCost(floor.cold), '$6.20');
  assert.equal(floor.warmRate, 0.5);
  assert.equal(floor.coldRate, 10);
  assert.equal(floor.inputRate, 5);
  assert.equal(floor.tier, '1h');
});

test('the floor charges the cold bound at the tier the record names', () => {
  const short = nextTurnFloor({ contextTokens: 620_000, model: 'claude-opus-5', tier: '5m' });
  // The five-minute tier is 1.25 times input, not twice it, so the same context costs less
  // to write again and the warm bound does not move.
  assert.equal(short?.coldRate, 6.25);
  assert.equal(short?.warmRate, 0.5);
  assert.equal(short?.tier, '5m');
});

test('a record naming no lifetime is priced the way its own provider charges the context again', () => {
  // Claude falls back to the one-hour write price when the record names no lifetime.

  const claude = nextTurnFloor({ contextTokens: 620_000, model: 'claude-opus-5', tier: null });
  assert.equal(claude?.coldRate, 10);
  assert.equal(claude?.tier, null, 'an assumed lifetime is reported as one the record named');
  // An explicit cache-write price supplies the cold bound.

  const astra = nextTurnFloor({ contextTokens: 100_000, model: 'gpt-6-astra', provider: 'openai', tier: null });
  assert.equal(astra?.coldRate, 12.5);
  assert.equal(astra?.warmRate, 1);
  // A model without a cache-write price uses ordinary input pricing for the cold bound.

  const plain = nextTurnFloor({ contextTokens: 100_000, model: 'gpt-5.5', provider: 'openai', tier: null });
  assert.equal(plain?.coldRate, plain?.inputRate, 'a provider selling no cache write is charged a cache write');
  assert.equal(plain?.tier, null);
});

test('the floor follows the long-context band the request itself falls in', () => {
  // 620,000 tokens is past the 272,000 threshold, so both cache rates double with input.
  const long = nextTurnFloor({ contextTokens: 620_000, model: 'gpt-6-astra', provider: 'openai', tier: '30m' });
  assert.equal(long?.warmRate, 2);
  assert.equal(long?.coldRate, 25);
  assert.equal(long?.inputRate, 20);
});

test('the floor is absent rather than wrong where it cannot be worked out', () => {
  assert.equal(nextTurnFloor({ contextTokens: 620_000, model: 'a-model-nobody-priced' }), null);
  assert.equal(nextTurnFloor({ contextTokens: 0, model: 'claude-opus-5', tier: '1h' }), null);
  assert.equal(nextTurnFloor({ contextTokens: -1, model: 'claude-opus-5', tier: '1h' }), null);
  assert.equal(nextTurnFloor({ contextTokens: 620_000, model: null, tier: '1h' }), null);
});

test('the cold multiple is the cache tier the estimator already charges', () => {
  const tokens = 1_000_000;
  const floor = nextTurnFloor({ contextTokens: tokens, model: 'claude-opus-5', tier: '1h' });
  // The next-turn bounds must match the ordinary cache-write and cache-read estimates.

  assert.equal(floor?.cold, estimateCost(usage({ cacheWrite1h: tokens }), 'claude-opus-5'));
  assert.equal(floor?.warm, estimateCost(usage({ cacheRead: tokens }), 'claude-opus-5'));
});

test('every cache tier carries the lifetime the provider sells', () => {
  assert.deepEqual(CACHE_LIFETIME_MS, { '5m': 300_000, '30m': 1_800_000, '1h': 3_600_000 });
  assert.equal(CONSERVATIVE_CACHE_BOUNDARY_MS, 90_000);
});

// Each model row carries its own cache lifetime. A missing lifetime remains unknown.

test('a price row carries its own cache lifetime, and a row without one says nothing', () => {
  // These model rows use a thirty-minute cache lifetime.
  assert.equal(cacheLifetimeFor('gpt-6-astra', 'openai'), '30m');
  assert.equal(cacheLifetimeFor('gpt-6-sol', 'openai'), '30m');
  assert.equal(cacheLifetimeFor('gpt-6-luna', 'openai'), '30m');
  assert.equal(cacheLifetimeFor('gpt-5.6-sol', 'openai'), '30m');
  assert.equal(cacheLifetimeFor('gpt-5.6-terra', 'openai'), '30m');
  assert.equal(cacheLifetimeFor('gpt-5.6-luna', 'openai'), '30m');
  assert.equal(cacheLifetimeFor('gpt-5.5', 'openai'), '30m');
  assert.equal(cacheLifetimeFor('gpt-5.5-2026-04-23', 'openai'), '30m');
  assert.equal(cacheLifetimeFor('gpt-5.4', 'openai'), '5m');
  // Claude records the lifetime it bought on the request itself, so no Claude row answers here.
  assert.equal(cacheLifetimeFor('claude-opus-5'), null);
  assert.equal(cacheLifetimeFor('a-model-nobody-priced'), null);
  // The supported Bedrock GPT-5.6 row uses a thirty-minute cache lifetime.

  assert.equal(cacheLifetimeFor('global.openai.gpt-5.6-sol', 'amazon-bedrock'), '30m');
});

test('a next-turn price rounds up to the displayed cent', () => {
  assert.equal(formatConservativeCost(0.001), '$0.01');
  assert.equal(formatConservativeCost(0.301), '$0.31');
  assert.equal(formatConservativeCost(10.01), '$11');
});

// The Bedrock regional inference class multiplies Claude rates by 1.1.
test('a regional Bedrock Claude request pays 1.1 times list, at standard and fast speed', () => {
  const tokens = usage({ input: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 });
  const bedrock = quoteUsage({ usage: tokens, model: 'claude-opus-5-5', inferenceClass: 'bedrock-regional' });
  assert.deepEqual(bedrock?.rate, { input: 4.4, output: 22, cacheRead: 0.22 });
  assert.equal(quoteUsage({ usage: tokens, model: 'claude-opus-5-5' })?.cost, 24.2);
  const fast = quoteUsage({
    usage: tokens,
    model: 'claude-opus-5-5',
    serviceTier: 'fast',
    inferenceClass: 'bedrock-regional',
  });
  assert.deepEqual(fast?.rate, { input: 8.8, cacheRead: 0.44, output: 44 });
});

test('a regional Bedrock Sonnet 5.5 request pays 1.1 times list', () => {
  const tokens = usage({ input: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 });
  const bedrock = quoteUsage({ usage: tokens, model: 'claude-sonnet-5-5', inferenceClass: 'bedrock-regional' });
  assert.deepEqual(bedrock?.rate, { input: 2.2, cacheRead: 0.11, output: 11 });
  assert.equal(bedrock?.cost, 13.31);
  assert.equal(quoteUsage({ usage: tokens, model: 'claude-sonnet-5-5' })?.cost, 12.1);
});

// The published Haiku 5.5 rates per million tokens, for prompts up to 100,000 tokens and over it.
const HAIKU_55_CELLS: Array<[Partial<TurnUsage>, number, number]> = [
  [{ input: 1_000_000 }, 0.1, 0.5],
  [{ cacheWrite5m: 1_000_000 }, 0.125, 0.625],
  [{ cacheWrite1h: 1_000_000 }, 0.2, 1],
  [{ cacheRead: 1_000_000 }, 0.01, 0.05],
  [{ output: 1_000_000 }, 0.5, 2.5],
];
const near = (actual: number | null | undefined, expected: number, label: string) =>
  assert.ok(actual != null && Math.abs(actual - expected) < 1e-12, `${label}: ${actual} is not ${expected}`);

test('Haiku 5.5 prices a request over 100,000 input tokens at five times every rate', () => {
  const model = 'claude-haiku-5-5';
  for (const [category, short, long] of HAIKU_55_CELLS) {
    const label = Object.keys(category)[0];
    near(quoteUsage({ usage: usage(category), model, contextBand: 'short' })?.cost, short, `short ${label}`);
    near(quoteUsage({ usage: usage(category), model, contextBand: 'long' })?.cost, long, `long ${label}`);
  }
  assert.equal(contextBandForRequest(model, null, 100_000), 'short');
  assert.equal(contextBandForRequest(model, null, 100_001), 'long');
  assert.equal(contextBandForRequest('claude-haiku-5-5-20261007[1m]', null, 100_001), 'long');
  // The cache read alone carries this request over 100,000 tokens, so its new input pays the long rate too.
  const request = usage({ requests: 1, input: 1_000, cacheRead: 99_001 });
  near(estimateCost(request, model), (1_000 * 0.5 + 99_001 * 0.05) / 1_000_000, 'cache-read request');
  near(
    estimateCost({ ...request, cacheRead: 99_000 }, model),
    (1_000 * 0.1 + 99_000 * 0.01) / 1_000_000,
    'short request',
  );
});

test('a regional Bedrock Haiku 5.5 request pays 1.1 times list in both prompt bands', () => {
  const tokens = usage({ input: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 });
  for (const [band, list] of [
    ['short', 0.1 + 0.01 + 0.5],
    ['long', 0.5 + 0.05 + 2.5],
  ] as const) {
    const input = { usage: tokens, model: 'claude-haiku-5-5', contextBand: band };
    assert.equal(quoteUsage(input)?.cost.toFixed(9), list.toFixed(9), `${band} list`);
    const regional = quoteUsage({ ...input, inferenceClass: 'bedrock-regional' });
    assert.equal(regional?.cost.toFixed(9), (list * 1.1).toFixed(9), `${band} regional`);
  }
});

test('the next-turn floor and the compaction estimate carry the regional Bedrock charge', () => {
  const floor = { contextTokens: 620_000, model: 'claude-opus-5-5', tier: '1h' as const };
  const list = nextTurnFloor(floor)!;
  const bedrock = nextTurnFloor({ ...floor, inferenceClass: 'bedrock-regional' })!;
  assert.ok(Math.abs(bedrock.warm - list.warm * 1.1) < 1e-9);
  assert.ok(Math.abs(bedrock.cold - list.cold * 1.1) < 1e-9);
  const previous = { tokens: 180_000, at: 0, lifetime: '1h' as const };
  const compaction = { model: 'claude-opus-5-5', at: 60_000, contextBefore: 180_000, contextAfter: 3_000 };
  const listCompaction = estimateCompactionCost({ ...compaction, previousRequest: previous })!;
  const bedrockCompaction = estimateCompactionCost({
    ...compaction,
    previousRequest: { ...previous, inferenceClass: 'bedrock-regional' },
  })!;
  assert.ok(listCompaction > 0);
  assert.ok(Math.abs(bedrockCompaction - listCompaction * 1.1) < 1e-9);
});

test('a Bedrock model id pays 1.1 times list on every profile but global.', () => {
  const cases: Array<[string, string | null, number]> = [
    ['us.anthropic.claude-opus-5-5[1m]', 'claude-opus-5-5', 1.1],
    ['apac.anthropic.claude-opus-5-5', 'claude-opus-5-5', 1.1],
    ['us-gov.anthropic.claude-opus-5-5', 'claude-opus-5-5', 1.1],
    ['anthropic.claude-opus-5-5', 'claude-opus-5-5', 1.1],
    ['global.anthropic.claude-opus-5-5', 'claude-opus-5-5', 1],
    ['claude-opus-5-5', 'claude-opus-5-5', 1],
  ];
  for (const [modelId, model, multiplier] of cases) {
    assert.equal(bedrockClaudeListMultiplier(modelId, model), multiplier, modelId);
  }
});

test('explicit unknown and unsupported policies never invent a provider lifetime', () => {
  for (const kind of ['unknown', 'unsupported', 'recorded'] as const) {
    const definition: ModelDefinition = {
      pattern: /^policy-model$/,
      rate: { input: 2, output: 10 },
      window: 100_000,
      cachePolicy: { kind, sources: ['https://example.com/policy-model'] },
    };
    const lookup = vi.spyOn(MODEL_DEFINITIONS, 'find').mockImplementation((predicate) => [definition].find(predicate));
    try {
      assert.equal(cacheLifetimeFor('policy-model'), null);
    } finally {
      lookup.mockRestore();
    }
  }
  for (const model of ['gpt-6.1-luna', 'openai.gpt-6.1-luna', 'us.openai.gpt-6.1-luna', 'global.openai.gpt-6.1-luna']) {
    for (const provider of [null, 'openai', 'amazon-bedrock']) {
      assert.equal(resolveModelPricing(model, provider), null);
      assert.equal(cacheLifetimeFor(model, provider), null);
    }
  }
});

test('Bedrock Astra prices exact routes and request thresholds without inventing cache expiry or effective dates', () => {
  for (const [model, multiplier] of [
    ['openai.gpt-6-astra', 1.1],
    ['us.openai.gpt-6-astra', 1.1],
    ['global.openai.gpt-6-astra', 1],
  ] as const) {
    const resolved = resolveModelPricing(model, 'amazon-bedrock');
    assert.equal(resolved?.window, 1_050_000);
    assert.equal(resolved?.cachePolicy.kind, 'unknown');
    assert.equal(resolved?.cacheLifetime, null);
    assert.equal(resolved?.effectiveDate, null);
    assert.equal(cacheLifetimeFor(model, 'amazon-bedrock'), null);
    for (const [tokens, inputRate, outputRate] of [
      [272_000, 10, 50],
      [272_001, 20, 75],
    ]) {
      for (const serviceTier of [null, 'default', 'standard']) {
        const quote = quoteUsage({
          model,
          provider: 'amazon-bedrock',
          serviceTier,
          requestTokens: tokens,
          usage: usage({ input: 1000, cacheWrite30m: 2000, cacheRead: 3000, output: 4000 }),
        });
        assert.deepEqual(quote?.rate, {
          input: inputRate * multiplier,
          cacheWrite30m: Number((inputRate * 1.25 * multiplier).toPrecision(15)),
          cacheRead: Number((inputRate * 0.1 * multiplier).toPrecision(15)),
          output: Number((outputRate * multiplier).toPrecision(15)),
        });
        assert.equal(quote?.effectiveDate, null);
      }
    }
    for (const serviceTier of ['fast', 'priority', 'flex', 'batch', 'reserved', 'unknown'])
      assert.equal(
        quoteUsage({
          model,
          provider: 'amazon-bedrock',
          serviceTier,
          requestTokens: 1000,
          usage: usage({ input: 1000 }),
        }),
        null,
      );
  }
  for (const model of [
    'gpt-6-astra',
    'eu.openai.gpt-6-astra',
    'ap.openai.gpt-6-astra',
    'US.openai.gpt-6-astra',
    'openai.gpt-6-astra-extra',
    'openai.gpt-6-astra[1m]',
    'openai.gpt-6-astral',
  ])
    assert.equal(resolveModelPricing(model, 'amazon-bedrock'), null, model);
  for (const provider of [null, 'openai', 'router', 'unknown'])
    assert.equal(resolveModelPricing('openai.gpt-6-astra', provider), null);
});

test('effort cache policy distinguishes exact Claude models and detectable Bedrock routes', () => {
  for (const model of ['opus-5-5', 'sonnet-5-5', 'haiku-5-5', 'fable-5-1', 'mythos-5-1', 'opus-5']) {
    const keeps = ['opus-5-5', 'sonnet-5-5', 'haiku-5-5', 'fable-5-1'].includes(model);
    for (const suffix of ['', '-20261001', '[1m]', '-20261001[1m]']) {
      const identity = 'claude-' + model + suffix;
      assert.equal(effortChangeKeepsCache(identity, null), keeps, identity);
      assert.equal(effortChangeKeepsCache(identity, null, 'bedrock-regional'), false);
      assert.equal(effortChangeKeepsCache(identity, null, null, true), false);
      if (model === 'fable-5-1' || model === 'mythos-5-1')
        assert.deepEqual(rateFor(identity), { input: 10, cacheRead: 0.25, output: 50 });
    }
  }
  assert.equal(effortChangeKeepsCache('gpt-5.6', null), false);
  assert.equal(effortChangeKeepsCache('claude-opus-5-5', 'amazon-bedrock'), false);
});

test('a cold Claude compaction writes the measured shared prefix without reading the expired cache', () => {
  for (const lifetime of ['5m', '30m', '1h'] as const) {
    const input = {
      model: 'claude-haiku-5-5',
      at: COMPACTED_AT,
      contextBefore: 180604,
      contextAfter: 1561,
      firstRequestCachedTokens: 18000,
      postCompactionCacheRead: 18825,
      previousRequest: {
        tokens: 180604,
        cacheRead: 160000,
        cacheWrite: 20604,
        at: COMPACTED_AT - 2 * 60 * 60_000,
        lifetime,
      },
    };
    const estimated = compactionEstimate(input)!;
    assert.equal(estimated.basis, 'cold');
    assert.equal(estimated.usage.cacheRead, 0);
    assert.equal(estimated.usage.input, 163779);
    assert.equal(
      estimated.usage.cacheWrite1h + estimated.usage.cacheWrite5m + (estimated.usage.cacheWrite30m ?? 0),
      18825,
    );
    const fallback = compactionEstimate({ ...input, postCompactionCacheRead: null })!.usage;
    assert.equal(fallback.cacheWrite1h + fallback.cacheWrite5m + (fallback.cacheWrite30m ?? 0), 18000);
  }
});
