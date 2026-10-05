import type { CacheLifetime, TurnUsage, UsageContextBand, UsageInferenceClass } from './transcript';

export { formatCost } from './view/cost.ts';

// Published prices in dollars per million tokens. API rows use each provider's published
// API rates. Product-specific aliases use the named product rate card. The shared cache tiers
// are multiples of base input. A provider row can carry an explicit cache price.
//
// One formula prices every provider. OpenAI cached-read rates vary by model. GPT-5.6
// cache writes and Bedrock GPT-5.6 prompt-cache writes have explicit provider rates. What
// differs is what a count means, and levelling that is the reader's job, not this table's.
//
// The result is an estimate against the rate a turn was actually billed at, and it ignores
// any negotiated discount, so treat it as the shape of a turn's cost rather than an invoice.
//
// Where a rate is promotional, the row carries the promotional figure and says so, with the
// standard rate and the date recorded in PROMOTIONS below. The alternative reads better and
// is wrong for as long as the promotion lasts: gpt-5.6-sol runs most Codex turns and is
// discounted into November, so pricing it at standard would overstate nearly every Codex
// card by half.
export interface Rate {
  input: number;
  output: number;
  cacheWrite30m?: number;
  cacheRead?: number;
}

interface BedrockSupport {
  // A provider identity that excludes a direct alias accepted by the model row.
  model?: string;
  prefixes: RegExp;
  regionalMultiplier: number;
  window: number;
  cacheLifetime?: CacheLifetime;
  effectiveDate: string;
  profileEffectiveDate?: string;
  // Omit this only when the published global rates equal the shared rates.
  rate?: Rate;
}

interface ModelRow {
  pattern: RegExp;
  rate: Rate;
  window: number;
  // How long this model's provider keeps a prompt cache alive, where the provider documents
  // it. It belongs beside the rate because it is the other half of the same fact: the rate
  // says what a read costs and this says how long a read is still on offer. A row that names
  // none leaves the panel with both bounds and no state, which is the honest answer.
  cacheLifetime?: CacheLifetime;
  effectiveDate?: string;
  providers?: readonly string[];
  providerRequired?: boolean;
  maxPricedContext?: number;
  longContext?: { threshold: number; inputMultiplier: number; outputMultiplier: number };
  // The published fast-mode rate, on a row whose model sells fast mode. It holds across the
  // whole context window, and the cache multiples and the regional multiplier apply on top of
  // it. The ratio to the standard rate is written out rather than derived, because each model
  // publishes its own. A row without one leaves a fast request unpriced.
  fast?: Rate;
  // Only tiers published for this model have a multiplier. Others remain unpriced.
  serviceTierMultipliers?: Readonly<Record<string, number>>;
  bedrock?: BedrockSupport;
}

const BEDROCK_272K_ROUTES = {
  prefixes: /^(?:global|[a-z]{2})?$/,
  regionalMultiplier: 1.1,
  window: 272_000,
  cacheLifetime: '30m' as const,
};

// The speed Claude records on a fast-mode request. The transcript reader carries a speed that
// is not standard in the service-tier field.
const FAST_SPEED = 'fast';

export interface RateOverride {
  rate: Rate;
  source: string;
  effectiveDate: string;
  // The service tier the configured entry names, when it names one. A configured rate that
  // names no tier prices the standard speed only.
  serviceTier?: string;
}

export interface UsageQuoteInput {
  usage: TurnUsage;
  model: string | null;
  provider?: string | null;
  contextWindow?: number | null;
  // Actual request input, including cache reads and writes. This is the only safe answer
  // for a request-wide long-context tier.
  requestTokens?: number | null;
  inferenceClass?: UsageInferenceClass;
  serviceTier?: string | null;
  reportedCost?: number | null;
  override?: RateOverride | null;
}

export interface UsageQuote {
  cost: number;
  rate: Rate | null;
  source: string;
  effectiveDate: string | null;
  reported: boolean;
  provider: string | null;
  serviceTier: string | null;
  inferenceClass: UsageQuoteInput['inferenceClass'];
  contextBand: 'short' | 'long' | null;
}

export type UsagePriceContext = Pick<UsageQuoteInput, 'inferenceClass' | 'serviceTier'>;

// One row per generation, carrying both facts the panel needs about it. They share a row
// because they share a lookup: held apart, a generation could be added to one table and
// forgotten in the other, and since a missing row is exactly how both tables say "not
// known", the omission would read as deliberate and show up only as a figure quietly
// absent from a card.
//
// Matched by family *and* generation. A family-only pattern quietly hands a model it has
// never heard of its newest sibling's rate, and older generations have cost several times
// what the current one does. An unknown model is better shown with no cost and no window
// than with confident wrong ones, so anything not listed here returns null.
//
// The dash before a Claude generation is part of the pattern and the word boundary after
// it stops `4-8` matching `4-88` and `4-5` matching `4-55`. Claude's dated snapshots and
// bracketed context suffixes still match that generation. OpenAI snapshots are listed
// exactly, because an unlisted product suffix can carry a different rate.
//
// 1M is the standard context window for the whole Claude 5 family, not a variant anything
// opts into: no setting selects it, and a transcript's `message.model` is the resolved base
// id either way. Haiku 4.5 and the supported Claude 4.5 generations remain at 200K.
//
// The list covers the generations in use. A generation missing from it is missing on
// purpose, and a turn run on one shows no cost rather than a wrong one. Adding a row means
// looking up that generation's list rate *and* its window first: neither is guessable from
// a neighbouring row, because both have changed between generations of one family.
//
// The window on a Codex row is the advertised one, and it is the weaker of two answers. A
// Codex turn records the window it actually ran against, which is smaller than the
// advertised figure and moves with the plan the session was on, so the recorded value is
// what a card reads and this is what is left when there is none to read.
//
// 272K is where the supported OpenAI long-context tier begins: a prompt past it is billed at
// twice the input rate and one and a half times the output rate, for the whole request. The
// request band is retained before several requests are summed, because a turn total cannot
// distinguish one long request from two short ones.
const MODELS: ModelRow[] = [
  {
    pattern: /^claude-(fable|mythos)-5-1(?:-\d{8})?(?:\[[^\]]+\])?$/,
    rate: { input: 10, cacheRead: 0.25, output: 50 },
    window: 1_000_000,
  },
  {
    pattern: /^claude-(fable|mythos)-5(?:-\d{8})?(?:\[[^\]]+\])?$/,
    rate: { input: 10, output: 50 },
    window: 1_000_000,
  },
  // https://platform.claude.com/docs/en/about-claude/pricing#fast-mode-pricing
  // Fast mode is sold on the first-party Claude API. A Claude row matches only a turn that
  // names no provider. A Bedrock Claude request names none either, so a fast one pays these
  // rates with the regional Bedrock charge on top.
  {
    pattern: /^claude-opus-5-5(?:-\d{8})?(?:\[[^\]]+\])?$/,
    rate: { input: 4, cacheRead: 0.2, output: 20 },
    fast: { input: 8, cacheRead: 0.4, output: 40 },
    window: 1_000_000,
  },
  {
    pattern: /^claude-opus-(5|4-8)(?:-\d{8})?(?:\[[^\]]+\])?$/,
    rate: { input: 5, output: 25 },
    fast: { input: 10, output: 50 },
    window: 1_000_000,
  },
  // Opus 4.7 refuses a fast request, and Opus 4.6 runs it at standard speed and records that.
  {
    pattern: /^claude-opus-(4-7|4-6)(?:-\d{8})?(?:\[[^\]]+\])?$/,
    rate: { input: 5, output: 25 },
    window: 1_000_000,
  },
  { pattern: /^claude-opus-4-5(?:-\d{8})?(?:\[[^\]]+\])?$/, rate: { input: 5, output: 25 }, window: 200_000 },
  // Sonnet 5 and Sonnet 5.5 are priced apart from Sonnet 4.6 because their standing rates differ.
  // Sonnet 5.5 has an exact row, so an unpublished later Sonnet stays unpriced.
  { pattern: /^claude-sonnet-5-5(?:-\d{8})?(?:\[[^\]]+\])?$/, rate: { input: 2, output: 10 }, window: 1_000_000 },
  {
    pattern: /^claude-sonnet-5(?:-\d{8})?(?:\[[^\]]+\])?$/,
    rate: { input: 2, output: 10 },
    window: 1_000_000,
    effectiveDate: '2026-08-10',
  },
  { pattern: /^claude-sonnet-4-6(?:-\d{8})?(?:\[[^\]]+\])?$/, rate: { input: 3, output: 15 }, window: 1_000_000 },
  { pattern: /^claude-sonnet-4-5(?:-\d{8})?(?:\[[^\]]+\])?$/, rate: { input: 3, output: 15 }, window: 200_000 },
  { pattern: /^claude-haiku-4-5(?:-\d{8})?(?:\[[^\]]+\])?$/, rate: { input: 1, output: 5 }, window: 200_000 },
  // https://developers.openai.com/api/docs/models/gpt-6-astra
  {
    pattern: /^gpt-6-astra$/,
    rate: { input: 10, cacheWrite30m: 12.5, cacheRead: 1, output: 50 },
    window: 1_050_000,
    cacheLifetime: '30m',
    providers: ['openai'],
    maxPricedContext: 272_000,
    longContext: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
  },
  // https://developers.openai.com/api/docs/models/gpt-6.1-sol
  {
    pattern: /^gpt-6\.1-sol$/,
    rate: { input: 2, cacheWrite30m: 2.5, cacheRead: 0.1, output: 10 },
    window: 1_050_000,
    cacheLifetime: '30m',
    providers: ['openai'],
    maxPricedContext: 272_000,
    longContext: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
    serviceTierMultipliers: { fast: 2, priority: 2, flex: 0.5, batch: 0.5 },
    // https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-1-sol.html
    // Cache prices apply to recorded tokens. Explicit prompt caching is unsupported.
    // No fallback lifetime is documented.
    bedrock: {
      prefixes: /^(?:us|global)?$/,
      regionalMultiplier: 1.1,
      window: 1_000_000,
      effectiveDate: '2026-09-29',
    },
  },
  // https://developers.openai.com/api/docs/models/gpt-6-sol
  {
    pattern: /^gpt-6-sol$/,
    rate: { input: 2, cacheWrite30m: 2.5, cacheRead: 0.2, output: 10 },
    window: 1_050_000,
    cacheLifetime: '30m',
    providers: ['openai'],
    maxPricedContext: 272_000,
    longContext: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
    // https://aws.amazon.com/about-aws/whats-new/2026/09/openai-gpt-6-sol-luna-on-amazon-bedrock/
    bedrock: { ...BEDROCK_272K_ROUTES, effectiveDate: '2026-09-22' },
  },
  // https://developers.openai.com/api/docs/models/gpt-6-luna
  {
    pattern: /^gpt-6-luna$/,
    rate: { input: 0.1, cacheWrite30m: 0.125, cacheRead: 0.01, output: 0.5 },
    window: 1_050_000,
    cacheLifetime: '30m',
    providers: ['openai'],
    maxPricedContext: 272_000,
    longContext: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
    // https://aws.amazon.com/about-aws/whats-new/2026/09/openai-gpt-6-sol-luna-on-amazon-bedrock/
    bedrock: { ...BEDROCK_272K_ROUTES, effectiveDate: '2026-09-22' },
  },
  {
    pattern: /^gpt-5\.5(?:-2026-04-23)?$/,
    rate: { input: 5, cacheRead: 0.5, output: 30 },
    window: 1_050_000,
    cacheLifetime: '5m',
    providers: ['openai'],
    maxPricedContext: 272_000,
    longContext: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
  },
  {
    pattern: /^gpt-5\.4(?:-2026-03-05)?$/,
    rate: { input: 2.5, cacheRead: 0.25, output: 15 },
    window: 1_050_000,
    cacheLifetime: '5m',
    providers: ['openai'],
    maxPricedContext: 272_000,
    longContext: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
  },
  // Promotional; see PROMOTIONS below for the date and the standard rate.
  {
    pattern: /^gpt-5\.6(?:-sol)?$/,
    rate: { input: 4, cacheWrite30m: 5, cacheRead: 0.4, output: 20 },
    window: 272_000,
    cacheLifetime: '30m',
    providers: ['openai'],
    maxPricedContext: 272_000,
    longContext: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
    bedrock: {
      ...BEDROCK_272K_ROUTES,
      model: 'gpt-5.6-sol',
      effectiveDate: '2026-08-21',
      profileEffectiveDate: '2026-08-20',
    },
  },
  {
    pattern: /^gpt-5\.6-terra$/,
    rate: { input: 2, cacheWrite30m: 2.5, cacheRead: 0.2, output: 12 },
    window: 272_000,
    cacheLifetime: '30m',
    providers: ['openai'],
    maxPricedContext: 272_000,
    longContext: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
    bedrock: {
      ...BEDROCK_272K_ROUTES,
      effectiveDate: '2026-07-30',
      profileEffectiveDate: '2026-08-20',
    },
  },
  {
    pattern: /^gpt-5\.6-luna$/,
    rate: { input: 0.2, cacheWrite30m: 0.25, cacheRead: 0.02, output: 1.2 },
    window: 272_000,
    cacheLifetime: '30m',
    providers: ['openai'],
    maxPricedContext: 272_000,
    longContext: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
    bedrock: {
      ...BEDROCK_272K_ROUTES,
      effectiveDate: '2026-07-30',
      profileEffectiveDate: '2026-08-20',
    },
  },
];

// A rate that is only right until a date, and the rate it goes back to.
//
// A promotional rate is a rate with an expiry, and the expiry is the part that gets forgotten:
// the row keeps charging the discount months after it ended and nothing says so, because a
// wrong price looks exactly like a right one. So the end date and the standard rate are written
// down beside the promotion, and `pricing.test.ts` fails once the date has passed. A red test
// is the only thing that reliably arrives three months later.
interface Promotion {
  until: string; // ISO date the promotional rate is held to, inclusive
  standard: Rate; // what it goes back to, so the fix is the row itself rather than research
  note: string; // what to check when the test goes red
}

// Every row whose rate is promotional, by the pattern of the row it belongs to. Held apart from
// MODELS so a row carries a rate and nothing else, and so this list is the one place to look
// for "what is about to be wrong".
export const PROMOTIONS: { pattern: RegExp; promo: Promotion }[] = [
  {
    pattern: /^gpt-5\.6(?:-sol)?$/,
    promo: {
      until: '2026-11-21',
      standard: { input: 5, cacheWrite30m: 6.25, cacheRead: 0.5, output: 30 },
      note:
        'OpenAI held gpt-5.6-sol at $4/$20 at least to this date, against a standard $5/$30. ' +
        'Check the published rate: either move the date out, or take the promotion off and use standard.',
    },
  },
];

const CODEX_AUTO_REVIEW_MODEL = 'codex-auto-review';
const MODEL_RATE_ALIASES: Readonly<Record<string, string>> = {
  // https://help.openai.com/en/articles/20001415-chatgpt-rate-card-enterprise-token-based-pricing
  [CODEX_AUTO_REVIEW_MODEL]: 'gpt-5.4',
};

function modelForRate(model: string): string {
  return MODEL_RATE_ALIASES[model] ?? model;
}

function rowFor(
  model: string | null,
  provider: string | null = null,
  contextWindow: number | null = null,
): ModelRow | null {
  if (!model) {
    return null;
  }
  const pricedModel = modelForRate(model);
  return (
    MODELS.find((row) => {
      if (!row.pattern.test(pricedModel)) {
        return false;
      }
      if (contextWindow !== null && row.maxPricedContext && contextWindow > row.maxPricedContext) {
        return false;
      }
      if (!row.providers) {
        return provider === null;
      }
      if (provider === null) {
        return !row.providerRequired;
      }
      return row.providers.includes(provider);
    }) ?? null
  );
}

const BEDROCK_MODEL = /^(?:([^.]+)\.)?openai\.(.+)$/;

function bedrockRowFor(
  model: string | null,
  provider: string | null,
): { row: ModelRow; support: BedrockSupport; prefix: string } | null {
  if (provider !== 'amazon-bedrock' || !model) {
    return null;
  }
  const match = BEDROCK_MODEL.exec(model);
  if (!match) {
    return null;
  }
  const prefix = match[1] ?? '';
  const row = MODELS.find(
    (candidate) =>
      candidate.bedrock &&
      candidate.pattern.test(match[2]) &&
      candidate.bedrock.prefixes.test(prefix) &&
      (candidate.bedrock.model === undefined || candidate.bedrock.model === match[2]),
  );
  return row?.bedrock ? { row, support: row.bedrock, prefix } : null;
}

function bedrockRateFor(
  model: string | null,
  provider: string | null,
  contextWindow: number | null,
  requestTokens: number | null,
): Rate | null {
  const resolved = bedrockRowFor(model, provider);
  if (!resolved) {
    return null;
  }
  const { row, support, prefix } = resolved;
  // Capacity does not establish the request band for a legacy aggregate.
  if (
    requestTokens === null &&
    contextWindow !== null &&
    row.maxPricedContext &&
    contextWindow > row.maxPricedContext
  ) {
    return null;
  }
  const rate = longContextRate(row, requestTokens, support.rate ?? row.rate);
  return prefix === 'global' ? rate : multiplied(rate, support.regionalMultiplier);
}

function bedrockEffectiveDate(model: string | null): string | null {
  const resolved = bedrockRowFor(model, 'amazon-bedrock');
  return resolved ? (resolved.prefix && resolved.support.profileEffectiveDate) || resolved.support.effectiveDate : null;
}

function modernClaude(model: string | null): boolean {
  return model !== null && /^claude-(?:fable|mythos|opus|sonnet|haiku)-(?:5|4-[5678])\b/.test(model);
}

// A Claude model id on Amazon Bedrock names its inference profile, as in
// `us.anthropic.claude-opus-5-5[1m]`. Bedrock bills every profile except `global.` at 1.1 times
// list, and a bare `anthropic.` id as well. A first-party id takes list.
const BEDROCK_CLAUDE_ID = /^(?:([^.]+)\.)?anthropic\.claude-/;

export function bedrockClaudeListMultiplier(modelId: string, model: string | null): number {
  const match = BEDROCK_CLAUDE_ID.exec(modelId);
  return match && match[1] !== 'global' && modernClaude(model) ? 1.1 : 1;
}

// Claude CLI records a Claude cost at list price, under the `list` basis. A Codex-launched Claude
// child on a Bedrock profile other than `global.` carries that cost times 1.1, under this basis.
export const BEDROCK_LIST_COST_BASIS = 'bedrock-list';

// True when a recorded cost is the price to show, as recorded or with the Bedrock charge.
export function recordedCostBasis(basis: string | null | undefined): boolean {
  return basis === 'list' || basis === BEDROCK_LIST_COST_BASIS;
}

function multiplied(rate: Rate, multiplier: number): Rate {
  const scale = (value: number) => Number((value * multiplier).toPrecision(15));
  return {
    input: scale(rate.input),
    output: scale(rate.output),
    ...(rate.cacheWrite30m === undefined ? {} : { cacheWrite30m: scale(rate.cacheWrite30m) }),
    ...(rate.cacheRead === undefined ? {} : { cacheRead: scale(rate.cacheRead) }),
  };
}

function longContextRate(row: ModelRow, requestTokens: number | null, rate: Rate = row.rate): Rate {
  const tier = row.longContext;
  if (!tier || requestTokens === null || requestTokens <= tier.threshold) {
    return rate;
  }
  const scaleInput = (value: number) => Number((value * tier.inputMultiplier).toPrecision(15));
  return {
    input: scaleInput(rate.input),
    output: Number((rate.output * tier.outputMultiplier).toPrecision(15)),
    ...(rate.cacheWrite30m === undefined ? {} : { cacheWrite30m: scaleInput(rate.cacheWrite30m) }),
    ...(rate.cacheRead === undefined ? {} : { cacheRead: scaleInput(rate.cacheRead) }),
  };
}

export function contextBandForRequest(
  model: string | null,
  provider: string | null,
  requestTokens: number | null,
): UsageContextBand | null {
  if (requestTokens === null) {
    return null;
  }
  const row = bedrockRowFor(model, provider)?.row ?? rowFor(model, provider, null);
  return row?.longContext ? (requestTokens > row.longContext.threshold ? 'long' : 'short') : null;
}

export function hasRequestContextPricing(model: string | null, provider: string | null): boolean {
  return contextBandForRequest(model, provider, 0) !== null;
}

function publicRateFor(
  model: string | null,
  provider: string | null,
  contextWindow: number | null,
  requestTokens: number | null,
  inferenceClass: UsageQuoteInput['inferenceClass'],
  serviceTier: string | null,
): { rate: Rate; source: string; effectiveDate: string | null; cacheWritesFree?: boolean } | null {
  const fast = serviceTier === FAST_SPEED;
  const standard = usesStandardPublicRate(provider, serviceTier);
  const bedrock = standard ? bedrockRateFor(model, provider, contextWindow, requestTokens) : null;
  if (bedrock) {
    return { rate: bedrock, source: 'AWS Bedrock standard', effectiveDate: bedrockEffectiveDate(model) };
  }
  // A known request size selects the tier itself. Capacity is only a guard for legacy
  // aggregates that lost the request boundary.
  const row = rowFor(model, provider, requestTokens === null ? contextWindow : null);
  if (!row) {
    return null;
  }
  const tierMultiplier = row.serviceTierMultipliers?.[serviceTier ?? ''];
  if (!standard && !(fast && row.fast) && tierMultiplier === undefined) {
    return null;
  }
  const contextRate = fast && row.fast ? row.fast : longContextRate(row, requestTokens);
  // Anthropic charges 1.1 times list for a request served in-region, and Amazon Bedrock charges the
  // same for a request on any inference profile except `global.`. A request carries one class,
  // so it never pays both.
  const regional = inferenceClass === 'in-region' || inferenceClass === 'bedrock-regional';
  const tierRate = tierMultiplier === undefined ? contextRate : multiplied(contextRate, tierMultiplier);
  const rate = regional && modernClaude(model) ? multiplied(tierRate, 1.1) : tierRate;
  return {
    rate,
    source:
      model === CODEX_AUTO_REVIEW_MODEL
        ? 'OpenAI Codex rate card'
        : model?.startsWith('claude-')
          ? 'Anthropic list price'
          : 'OpenAI list price',
    effectiveDate: row.effectiveDate ?? null,
    ...(model === CODEX_AUTO_REVIEW_MODEL ? { cacheWritesFree: true } : {}),
  };
}

export function usesStandardPublicRate(provider: string | null, serviceTier: string | null): boolean {
  return (
    serviceTier === null ||
    serviceTier === 'standard' ||
    // https://docs.aws.amazon.com/bedrock/latest/userguide/service-tiers-inference.html
    ((provider === 'openai' || provider === 'amazon-bedrock') && serviceTier === 'default')
  );
}

export function rateFor(
  model: string | null,
  provider: string | null = null,
  contextWindow: number | null = null,
): Rate | null {
  return publicRateFor(model, provider, contextWindow, null, null, null)?.rate ?? null;
}

export function contextWindowFor(model: string | null, provider: string | null = null): number | null {
  const bedrock = bedrockRowFor(model, provider);
  if (bedrock) {
    return bedrock.support.window;
  }
  return rowFor(model, provider)?.window ?? null;
}

// The three cache tiers, as multiples of the base input rate. Named, because more than one
// formula charges the same tier: two copies of 0.1 are two answers, and the copy nobody
// looks at is the one that keeps the old number after a rate moves.
const CACHE_WRITE_1H = 2;
const CACHE_WRITE_5M = 1.25;
const CACHE_READ = 0.1;

// The lifetimes the records name, which is where the vocabulary is set. Re-exported so a
// caller pricing one does not have to reach past this module for the word.
export type CacheTier = CacheLifetime;

// How long each one lasts. The provider starts the lifetime again on every request that uses
// the cache, so the clock this is measured against is the age of the last request and never
// the age of the write.
export const CACHE_LIFETIME_MS: Record<CacheTier, number> = {
  '5m': 5 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
};

// Transcript request clocks can trail the request that warmed a cache. Every consumer calls
// the cache cold this far before its nominal lifetime ends.
export const CONSERVATIVE_CACHE_BOUNDARY_MS = 90_000;

// How long this model keeps a prompt cache, where its provider documents a figure.
//
// OpenAI publishes thirty minutes as a minimum for GPT-5.6 and later. Earlier
// generations use a different control with a shorter documented retention range. Their rows
// carry its conservative low end, so the panel calls the cache cold before it can expire.
//
// Claude records the lifetime it bought on the request itself, so no Claude row carries one
// here. A caller reads the record first and reaches this only where the record is silent.
export function cacheLifetimeFor(model: string | null, provider: string | null = null): CacheTier | null {
  const row = rowFor(model, provider);
  if (row) {
    return row.cacheLifetime ?? null;
  }
  return bedrockRowFor(model, provider)?.support.cacheLifetime ?? null;
}

export interface NextTurnFloorInput {
  // The input side of the request that established the current context level.
  contextTokens: number;
  // The answer written after that request. It is not part of the cache that request bought.
  freshTokens?: number;
  // The full input side that selects the request's pricing band. Defaults to the priced tokens.
  requestTokens?: number;
  model: string | null;
  provider?: string | null;
  contextWindow?: number | null;
  // The lifetime the request recorded, or null when it recorded none.
  tier?: CacheTier | null;
  // What that request was billed under. Both are read here for the same reason every other
  // quote reads them: an in-region or regional Bedrock request is charged 10% more, and a tier
  // this table has no public rate for gets no figure at all rather than the standard one.
  inferenceClass?: UsageInferenceClass;
  serviceTier?: string | null;
}

// The two prices a turn can start at, and the rates behind them. Every figure is dollars,
// and every rate is dollars per million tokens, so a caller can print the rate beside the
// price without dividing anything itself.
export interface NextTurnFloor {
  warm: number;
  cold: number;
  warmRate: number;
  coldRate: number;
  inputRate: number;
  // The lifetime the cold figure is priced at, or null where the record named none.
  tier: CacheTier | null;
  // Whether the cold figure is a cache write or an ordinary uncached send. A record naming no
  // lifetime still buys a write on a provider that sells one, so the two questions have
  // different answers and anything wording the figure needs this one.
  coldIsWrite: boolean;
}

// A Claude compaction request sends the context of the last main request again, followed by
// the instruction to summarise it, and the instruction is ordinary input.
//
// While the cache that request bought still holds, the compaction request reads back exactly what
// that request read, and writes about as much as that request wrote again at the five-minute
// lifetime. Once the cache has lapsed, the request marks nothing for caching: it reads back only
// the system prompt and tool list that open every request of the transcript, which is what the
// transcript's first request read, and sends the rest of the context as uncached input.
//
// The output is the summary the request wrote, and the stored summary text measures it. The
// request also writes an analysis that is dropped before the summary is stored, so each output
// token stands for fewer characters of stored text than ordinary prose.
export const CLAUDE_COMPACTION_INSTRUCTION_TOKENS = 2_000;
export const CLAUDE_COMPACTION_SUMMARY_CHARS_PER_TOKEN = 2.2;

// The counts one Claude compaction request buys for its input. A request whose cache split is
// unknown is read back whole while warm.
function claudeCompactionInput(
  previous: Pick<CompactionPreviousRequest, 'tokens' | 'cacheRead' | 'cacheWrite'>,
  cold: boolean,
  firstRequestCacheRead: number | null,
): Partial<TurnUsage> {
  if (cold) {
    const prefix = firstRequestCacheRead ?? 0;
    return {
      cacheRead: prefix,
      input: Math.max(0, previous.tokens + CLAUDE_COMPACTION_INSTRUCTION_TOKENS - prefix),
    };
  }
  const split = previous.cacheRead !== undefined || previous.cacheWrite !== undefined;
  return {
    cacheRead: split ? (previous.cacheRead ?? 0) : previous.tokens,
    cacheWrite5m: split ? (previous.cacheWrite ?? 0) : 0,
    input: CLAUDE_COMPACTION_INSTRUCTION_TOKENS,
  };
}

const NO_USAGE: TurnUsage = {
  requests: 1,
  input: 0,
  cacheWrite1h: 0,
  cacheWrite5m: 0,
  cacheWrite30m: 0,
  cacheRead: 0,
  output: 0,
  thinking: 0,
};

function writeCounts(tier: CacheTier, tokens: number): Partial<TurnUsage> {
  if (tier === '1h') {
    return { cacheWrite1h: tokens };
  }
  if (tier === '5m') {
    return { cacheWrite5m: tokens };
  }
  return { cacheWrite30m: tokens };
}

// The counts that price sending the whole context again when the record named no lifetime.
//
// A provider that sells no cache-write product charges ordinary input for it, which is every
// OpenAI row in this table without an explicit write price. Claude charges a write premium
// whatever the record says, and its unnamed writes are charged at the hour, which is the same
// fallback `claudeUsage` applies. Absence of a 30-minute price is not evidence of an hour, so
// the two cases are answered apart rather than by one default.
function uncachedCounts(
  model: string | null,
  provider: string | null,
  tokens: number,
): {
  counts: Partial<TurnUsage>;
  isWrite: boolean;
} {
  const rate = rateFor(model, provider);
  if (rate?.cacheWrite30m !== undefined) {
    return { counts: { cacheWrite30m: tokens }, isWrite: true };
  }
  if (modernClaude(model)) {
    return { counts: { cacheWrite1h: tokens }, isWrite: true };
  }
  return { counts: { input: tokens }, isWrite: false };
}

// A retention lifetime says how long a read discount can remain available. It does not say
// that the provider charges a separate write product. Claude sells five-minute and one-hour
// writes, while a 30-minute write exists only where the selected rate names one.
function coldCounts(
  input: NextTurnFloorInput,
  tokens: number,
): {
  counts: Partial<TurnUsage>;
  isWrite: boolean;
} {
  if ((input.tier === '1h' || input.tier === '5m') && modernClaude(input.model)) {
    return { counts: writeCounts(input.tier, tokens), isWrite: true };
  }
  if (input.tier === '30m' && rateFor(input.model, input.provider ?? null)?.cacheWrite30m !== undefined) {
    return { counts: writeCounts(input.tier, tokens), isWrite: true };
  }
  return uncachedCounts(input.model, input.provider ?? null, tokens);
}

function perMillionRate(dollars: number, tokens: number): number {
  return Number(((dollars / tokens) * 1_000_000).toFixed(12));
}

// What the next turn costs before the reader types anything.
//
// Every turn re-presents the whole session, so the context already on the record has a
// price fixed before the prompt exists. Read back from a warm cache it is charged at the read
// rate; written again after the lifetime passed it is charged at the write rate for the tier
// that was bought. Those are the two bounds, and the caller decides from the clock which one
// to show.
//
// Priced through `quoteUsage` rather than by multiplying a rate here, so the long-context
// band, the regional multiplier and the provider's own cache price all reach this figure the
// way they reach every other one. Null when the model carries no row, which is the panel
// showing nothing rather than showing an unknown.
export function nextTurnFloor(input: NextTurnFloorInput): NextTurnFloor | null {
  const cachedTokens = input.contextTokens;
  const freshTokens = input.freshTokens ?? 0;
  const tokens = cachedTokens + freshTokens;
  const requestTokens = input.requestTokens ?? tokens;
  if (
    !Number.isFinite(cachedTokens) ||
    cachedTokens <= 0 ||
    !Number.isFinite(freshTokens) ||
    freshTokens < 0 ||
    !Number.isFinite(requestTokens) ||
    requestTokens <= 0
  ) {
    return null;
  }
  const shared = {
    model: input.model,
    provider: input.provider ?? null,
    contextWindow: input.contextWindow ?? null,
    requestTokens,
    inferenceClass: input.inferenceClass ?? null,
    serviceTier: input.serviceTier ?? null,
  };
  const warm = quoteUsage({
    ...shared,
    usage: { ...NO_USAGE, cacheRead: cachedTokens, input: freshTokens },
  });
  if (!warm?.rate) {
    return null;
  }
  const written = coldCounts(input, tokens);
  const cold = quoteUsage({ ...shared, usage: { ...NO_USAGE, ...written.counts } });
  if (!cold?.rate) {
    return null;
  }
  return {
    warm: warm.cost,
    cold: cold.cost,
    warmRate: perMillionRate(warm.cost, tokens),
    coldRate: perMillionRate(cold.cost, tokens),
    inputRate: warm.rate.input,
    tier: input.tier ?? null,
    coldIsWrite: written.isWrite,
  };
}

function requestInputTokens(usage: TurnUsage): number {
  return usage.input + usage.cacheWrite1h + usage.cacheWrite5m + (usage.cacheWrite30m ?? 0) + usage.cacheRead;
}

function costAtRate(usage: TurnUsage, rate: Rate, cacheWritesFree = false): number | null {
  if (!cacheWritesFree && (usage.cacheWrite30m ?? 0) > 0 && rate.cacheWrite30m === undefined) {
    return null;
  }
  const perToken = rate.input / 1_000_000;
  return (
    usage.input * perToken +
    (cacheWritesFree ? 0 : usage.cacheWrite1h * perToken * CACHE_WRITE_1H) +
    (cacheWritesFree ? 0 : usage.cacheWrite5m * perToken * CACHE_WRITE_5M) +
    (cacheWritesFree ? 0 : (usage.cacheWrite30m ?? 0) * ((rate.cacheWrite30m ?? 0) / 1_000_000)) +
    usage.cacheRead * ((rate.cacheRead ?? rate.input * CACHE_READ) / 1_000_000) +
    usage.output * (rate.output / 1_000_000)
  );
}

// Quotes retain where a figure came from. A recorded charge is already the answer for that
// request; configured rates otherwise take precedence over public rows.
export function quoteUsage(input: UsageQuoteInput): UsageQuote | null {
  const provider = input.provider ?? null;
  const contextBand = contextBandForRequest(input.model, provider, input.requestTokens ?? null);
  const metadata = {
    provider,
    serviceTier: input.serviceTier ?? null,
    inferenceClass: input.inferenceClass ?? null,
    contextBand,
  };
  if (input.reportedCost !== null && input.reportedCost !== undefined) {
    return {
      cost: input.reportedCost,
      rate: null,
      source: 'reported',
      effectiveDate: null,
      reported: true,
      ...metadata,
    };
  }
  // A configured rate prices the speed the user priced. One that names no tier says nothing
  // about fast mode, and charging a fast turn at it would undercount the turn by half.
  if (input.override && input.serviceTier === FAST_SPEED && input.override.serviceTier !== FAST_SPEED) {
    return null;
  }
  const publicPrice = input.override
    ? publicRateFor(
        input.model,
        input.provider ?? null,
        input.contextWindow ?? null,
        input.requestTokens ?? null,
        input.inferenceClass ?? null,
        null,
      )
    : null;
  const publicWriteRate = publicPrice?.rate.cacheWrite30m;
  const configuredRate =
    input.override && input.override.rate.cacheWrite30m === undefined && publicWriteRate !== undefined
      ? {
          ...input.override.rate,
          cacheWrite30m: input.override.rate.input * (publicWriteRate / publicPrice!.rate.input),
        }
      : input.override?.rate;
  const priced = input.override
    ? { rate: configuredRate!, source: input.override.source, effectiveDate: input.override.effectiveDate }
    : publicRateFor(
        input.model,
        input.provider ?? null,
        input.contextWindow ?? null,
        input.requestTokens ?? null,
        input.inferenceClass ?? null,
        input.serviceTier ?? null,
      );
  if (!priced) {
    return null;
  }
  const cost = costAtRate(input.usage, priced.rate, priced.cacheWritesFree ?? false);
  if (cost === null) {
    return null;
  }
  return {
    cost,
    rate: priced.rate,
    source: priced.source,
    effectiveDate: priced.effectiveDate,
    reported: false,
    ...metadata,
  };
}

// What the turn cost, in dollars, or null when the model is unknown to the table.
export function estimateCost(
  usage: TurnUsage,
  model: string | null,
  provider: string | null = null,
  contextWindow: number | null = null,
  requestTokens: number | null = null,
  priceContext: UsagePriceContext = {},
): number | null {
  if (usage.byContextBand) {
    let cost = 0;
    const combined: TurnUsage = {
      requests: 0,
      input: 0,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      cacheWrite30m: 0,
      cacheRead: 0,
      output: 0,
      thinking: 0,
    };
    for (const band of ['short', 'long'] as const) {
      const part = usage.byContextBand[band];
      if (!part) {
        continue;
      }
      combined.requests = (combined.requests ?? 0) + (part.requests ?? 0);
      combined.input += part.input;
      combined.cacheWrite1h += part.cacheWrite1h;
      combined.cacheWrite5m += part.cacheWrite5m;
      combined.cacheWrite30m = (combined.cacheWrite30m ?? 0) + (part.cacheWrite30m ?? 0);
      combined.cacheRead += part.cacheRead;
      combined.output += part.output;
      combined.thinking += part.thinking;
      const quoted = quoteUsage({
        usage: part,
        model,
        provider,
        contextWindow,
        requestTokens: band === 'long' ? 272_001 : 272_000,
        ...priceContext,
      });
      if (!quoted) {
        return null;
      }
      cost += quoted.cost;
    }
    if (
      (combined.requests ?? 0) !== (usage.requests ?? 0) ||
      combined.input !== usage.input ||
      combined.cacheWrite1h !== usage.cacheWrite1h ||
      combined.cacheWrite5m !== usage.cacheWrite5m ||
      (combined.cacheWrite30m ?? 0) !== (usage.cacheWrite30m ?? 0) ||
      combined.cacheRead !== usage.cacheRead ||
      combined.output !== usage.output ||
      combined.thinking !== usage.thinking
    ) {
      return null;
    }
    return cost;
  }
  if (
    requestTokens === null &&
    hasRequestContextPricing(model, provider) &&
    requestInputTokens(usage) + usage.output > 0
  ) {
    const aggregateInput = requestInputTokens(usage);
    if ((usage.requests ?? 0) !== 1 && contextBandForRequest(model, provider, aggregateInput) !== 'short') {
      return null;
    }
    requestTokens = aggregateInput;
  }
  return quoteUsage({ usage, model, provider, contextWindow, requestTokens, ...priceContext })?.cost ?? null;
}

// What the turn paid to re-read the session, in dollars, or null when the model is
// unknown to the table. It is the cache-read tier of `estimateCost` on its own, out of the
// same rate and the same multiplier, so the two cannot charge one turn differently.
//
// A fact about the turn that has already run, never a rate for the ones to come: the panel
// makes no projections, and the reader draws whatever inference they want from it.
export function estimateCacheReadCost(
  usage: TurnUsage,
  model: string | null,
  provider: string | null = null,
  contextWindow: number | null = null,
): number | null {
  const requestTokens = requestInputTokens(usage);
  if (
    !usage.byContextBand &&
    (usage.requests ?? 0) !== 1 &&
    hasRequestContextPricing(model, provider) &&
    contextBandForRequest(model, provider, requestTokens) !== 'short'
  ) {
    return null;
  }
  const part: TurnUsage = {
    requests: usage.requests ?? 0,
    input: 0,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheWrite30m: 0,
    cacheRead: usage.cacheRead,
    output: 0,
    thinking: 0,
  };
  if (usage.byContextBand) {
    part.byContextBand = {};
    for (const band of ['short', 'long'] as const) {
      const source = usage.byContextBand[band];
      if (!source) {
        continue;
      }
      part.byContextBand[band] = {
        requests: source.requests ?? 0,
        input: 0,
        cacheWrite1h: 0,
        cacheWrite5m: 0,
        cacheWrite30m: 0,
        cacheRead: source.cacheRead,
        output: 0,
        thinking: 0,
      };
    }
    return estimateCost(part, model, provider, contextWindow);
  }
  return estimateCost(part, model, provider, contextWindow, requestTokens);
}

// A starting price is a promise about the next request. Round it up so displayed cents never
// understate the list-price charge that produced them.
//
// It stays here while `formatCost` sits in `view/cost.ts`, because only a host caller words a
// starting price, and the rail's own section headings are what needed the other one in the
// browser. Moving this one too would put a rule in `view/` that nothing there reads.
export function formatConservativeCost(dollars: number | null): string | null {
  if (dollars == null || dollars <= 0) {
    return null;
  }
  if (dollars < 0.01) {
    return '$0.01';
  }
  if (dollars < 10) {
    return `$${(Math.ceil(dollars * 100) / 100).toFixed(2)}`;
  }
  return `$${Math.ceil(dollars)}`;
}

// The last main request before a compaction: the input side it sent, what of that it read from
// and wrote to the cache, when it ran, and the cache lifetime it bought. A null clock or lifetime
// leaves the compaction warm.
export interface CompactionPreviousRequest {
  tokens: number;
  cacheRead?: number;
  cacheWrite?: number;
  at: number | null;
  lifetime: CacheTier | null;
  inferenceClass?: UsageInferenceClass;
  serviceTier?: string | null;
}

export interface CompactionEstimateInput {
  model: string | null;
  // When the compaction record was written, which is after the request finished.
  at: number;
  // How long the compaction request ran, or 0 where the record names no duration.
  durationMs?: number;
  // The context the compaction record says it summarised, and the summary it wrote.
  contextBefore: number;
  contextAfter: number;
  previousRequest?: CompactionPreviousRequest | null;
  // The cache read of the first request in the same transcript, or null where none is known.
  firstRequestCacheRead?: number | null;
  // The length of the stored summary text in characters, preamble included, or null where no
  // summary was paired with the record.
  summaryChars?: number | null;
}

function knownClock(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

// Whether the cache a request bought had lapsed by a later moment. The lifetime runs from the
// request, as it does for every other cache answer here. A missing clock or lifetime answers
// no, because an unknown moment is not evidence of a lapse.
//
// The full nominal lifetime, never `CONSERVATIVE_CACHE_BOUNDARY_MS`. That shorter bound keeps a
// forward estimate safe against an imperfect clock. Applied backwards it would report an expiry
// the provider never had.
export function cacheLapsedBy(requestAt: number | null, lifetime: CacheTier | null, at: number): boolean {
  if (lifetime === null || !knownClock(requestAt) || !knownClock(at)) {
    return false;
  }
  return at - requestAt >= CACHE_LIFETIME_MS[lifetime];
}

// How a compaction estimate priced its input. `warm` reads back what the previous request read,
// writes what it wrote again at five minutes, and sends the instruction uncached. `cold` reads back
// the prefix the transcript's first request read and sends the rest uncached. `read` prices the
// recorded context as one cache read, for a model outside the Claude request shape.
export type CompactionEstimateBasis = 'warm' | 'cold' | 'read';

export interface CompactionEstimate {
  usage: TurnUsage;
  basis: CompactionEstimateBasis;
}

// The usage one compaction request is estimated to have bought, and how it was priced, or null
// when a figure is missing.
//
// A Claude compaction writes no usage of its own. Its input is the context of the last main
// request before it, which the recorded context before the compaction does not measure after a
// resume, so that request sizes the input and the recorded figure stands in only when no earlier
// request is known. The request is warm unless the cache that request bought had lapsed by the
// time the compaction request started, which is its duration before the record. The output is
// the stored summary text, or the summary size the record names where no summary text is known.
//
// Both recorded figures are required. An older transcript records no size for the summary it
// wrote, and pricing only the read there would put a confident number on the card that is short
// by the whole output side of the call. Any other model, an older Claude model included, is
// priced as a cache read of the recorded context plus the summary.
export function compactionEstimate(estimate: CompactionEstimateInput): CompactionEstimate | null {
  const { contextBefore, contextAfter } = estimate;
  if (!contextBefore || !contextAfter) {
    return null;
  }
  if (!modernClaude(estimate.model)) {
    return { usage: { ...NO_USAGE, cacheRead: contextBefore, output: contextAfter }, basis: 'read' };
  }
  const previous = estimate.previousRequest?.tokens ? estimate.previousRequest : null;
  const duration = estimate.durationMs ?? 0;
  const started = knownClock(estimate.at) && duration > 0 ? estimate.at - duration : estimate.at;
  const cold = previous ? cacheLapsedBy(previous.at, previous.lifetime, started) : false;
  const summaryChars = estimate.summaryChars ?? 0;
  return {
    usage: {
      ...NO_USAGE,
      ...claudeCompactionInput(previous ?? { tokens: contextBefore }, cold, estimate.firstRequestCacheRead ?? null),
      output: summaryChars > 0 ? Math.round(summaryChars / CLAUDE_COMPACTION_SUMMARY_CHARS_PER_TOKEN) : contextAfter,
    },
    basis: cold ? 'cold' : 'warm',
  };
}

// What a compaction cost, priced from `compactionEstimate`. The input size also selects
// the provider's short or long price for the whole call. Returns null when the model or a
// recorded figure is unknown.
export function estimateCompactionCost(estimate: CompactionEstimateInput): number | null {
  const usage = compactionEstimate(estimate)?.usage;
  if (!usage) {
    return null;
  }
  const previous = estimate.previousRequest;
  return estimateCost(usage, estimate.model, null, null, requestInputTokens(usage), {
    inferenceClass: previous?.inferenceClass ?? null,
    serviceTier: previous?.serviceTier ?? null,
  });
}

// The share of input tokens that came from the cache. This is the number that says
// whether a long session is being re-read cheaply or paid for in full.
export function cacheHitPercent(usage: TurnUsage): number | null {
  const total = usage.input + usage.cacheWrite1h + usage.cacheWrite5m + (usage.cacheWrite30m ?? 0) + usage.cacheRead;
  if (total === 0) {
    return null;
  }
  return Math.round((usage.cacheRead / total) * 100);
}
