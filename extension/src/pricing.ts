import type { CacheLifetime, TurnUsage, UsageContextBand, UsageInferenceClass } from './transcript';

export { formatCost } from './view/cost.ts';

// Rates are dollars per million tokens. Cost consumers share these model and provider definitions.
// Claude records cache reads and writes separately. Codex records them within total input.
// Readers split those categories before pricing. Explicit cache-read and cache-write rates override the default multiples.
// Estimates exclude negotiated discounts and do not represent invoices.
// Promotional rows carry their current rates, end dates, and standard rates.
export interface Rate {
  input: number;
  output: number;
  cacheWrite30m?: number;
  cacheRead?: number;
}

// Documented lifetimes supply nominal timing, including a provider's typical retention estimate.
// They do not establish an individual cache entry's expiry deadline.
export type CachePolicy =
  | { kind: 'documented'; lifetime: CacheLifetime; sources: readonly [string, ...string[]] }
  | { kind: 'recorded' | 'unsupported' | 'unknown'; sources: readonly [string, ...string[]] };

const CLAUDE_CACHE_POLICY: CachePolicy = {
  kind: 'recorded',
  sources: [
    'https://platform.claude.com/docs/en/build-with-claude/prompt-caching',
    'https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html',
  ],
};

interface BedrockSupport {
  // A provider identity that excludes a direct alias accepted by the model row.
  model?: string;
  prefixes: RegExp;
  regionalMultiplier: number;
  window: number;
  cachePolicy: CachePolicy;
  effectiveDate: string | null;
  profileEffectiveDate?: string;
  // Omit this only when the published global rates equal the shared rates.
  rate?: Rate;
}

export interface ModelDefinition {
  // Claude Code keeps cache after effort changes only on these exact model identities.
  effortChangeKeepsCache?: true | RegExp;
  pattern: RegExp;
  rate: Rate;
  window: number;
  // Rates and cache policy are required for every supported model and provider route.
  cachePolicy: CachePolicy;
  effectiveDate?: string;
  providers?: readonly string[];
  providerRequired?: boolean;
  maxPricedContext?: number;
  longContext?: { threshold: number; inputMultiplier: number; outputMultiplier: number };
  // Published fast-mode rates apply across the context window, with cache and regional multipliers.
  // Each model supplies its own fast rate. Models without a published rate leave fast requests unpriced.
  fast?: Rate;
  // Only tiers published for this model have a multiplier. Others remain unpriced.
  serviceTierMultipliers?: Readonly<Record<string, number>>;
  bedrock?: BedrockSupport;
  promotion?: Promotion;
}

const BEDROCK_272K_ROUTES = {
  prefixes: /^(?:global|[a-z]{2})?$/,
  regionalMultiplier: 1.1,
  window: 272_000,
  cachePolicy: {
    kind: 'documented',
    lifetime: '30m',
    sources: ['https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html'],
  } as const,
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
  // Total request input, including cache reads and writes, selects the request-wide pricing band.
  requestTokens?: number | null;
  // Aggregated usage retains the band selected by each original request.
  contextBand?: UsageContextBand | null;
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

// Each model definition requires rates, a fallback window, and a sourced cache policy.
// Provider support carries its own policy, routing rules, and pricing differences.
// Patterns match an explicit family and generation. Unlisted models return no rate or fallback window.
// Claude generation boundaries reject longer generation numbers but accept dated snapshots and bracketed context suffixes.
// OpenAI patterns list supported snapshot identities explicitly because other suffixes can identify different products.
// Claude 5 definitions use a one-million-token fallback window. Supported Claude 4.5 definitions use 200,000 tokens.
// Claude Haiku 5.5 is the one Claude definition with a request band. Its whole request pays the long rate above 100,000 input tokens.
// Adding a definition requires published rates, window capacity, and cache policy for that model.
// Codex definitions supply advertised windows. Consumers use recorded request windows when available.
// Supported OpenAI models apply long-context multipliers to the whole request above 272,000 input tokens.
// Readers retain each request's pricing band before aggregation. Aggregate totals cannot recover those bands.
export const MODEL_DEFINITIONS: readonly ModelDefinition[] = [
  {
    effortChangeKeepsCache: /^claude-fable-5-1(?:-\d{8})?(?:\[[^\]]+\])?$/,
    pattern: /^claude-(fable|mythos)-5-1(?:-\d{8})?(?:\[[^\]]+\])?$/,
    rate: { input: 10, cacheRead: 0.25, output: 50 },
    cachePolicy: CLAUDE_CACHE_POLICY,
    window: 1_000_000,
  },
  {
    pattern: /^claude-(fable|mythos)-5(?:-\d{8})?(?:\[[^\]]+\])?$/,
    rate: { input: 10, output: 50 },
    cachePolicy: CLAUDE_CACHE_POLICY,
    window: 1_000_000,
  },
  // https://platform.claude.com/docs/en/about-claude/pricing#fast-mode-pricing
  // Fast rates require an omitted provider. A recorded regional Bedrock inference class adds the regional multiplier.
  {
    effortChangeKeepsCache: true,
    pattern: /^claude-opus-5-5(?:-\d{8})?(?:\[[^\]]+\])?$/,
    rate: { input: 4, cacheRead: 0.2, output: 20 },
    fast: { input: 8, cacheRead: 0.4, output: 40 },
    cachePolicy: CLAUDE_CACHE_POLICY,
    window: 1_000_000,
  },
  {
    pattern: /^claude-opus-(5|4-8)(?:-\d{8})?(?:\[[^\]]+\])?$/,
    rate: { input: 5, output: 25 },
    fast: { input: 10, output: 50 },
    cachePolicy: CLAUDE_CACHE_POLICY,
    window: 1_000_000,
  },
  // Opus 4.7 refuses a fast request, and Opus 4.6 runs it at standard speed and records that.
  {
    pattern: /^claude-opus-(4-7|4-6)(?:-\d{8})?(?:\[[^\]]+\])?$/,
    rate: { input: 5, output: 25 },
    cachePolicy: CLAUDE_CACHE_POLICY,
    window: 1_000_000,
  },
  {
    pattern: /^claude-opus-4-5(?:-\d{8})?(?:\[[^\]]+\])?$/,
    rate: { input: 5, output: 25 },
    cachePolicy: CLAUDE_CACHE_POLICY,
    window: 200_000,
  },
  // Sonnet definitions list supported generations explicitly. Unlisted Sonnet generations remain unpriced.
  {
    effortChangeKeepsCache: true,
    pattern: /^claude-sonnet-5-5(?:-\d{8})?(?:\[[^\]]+\])?$/,
    // The public rate has no history. For a Sonnet 5.5 request before effectiveDate, an estimate from this row prices cache reads at half the former $0.20 list rate.
    rate: { input: 2, cacheRead: 0.1, output: 10 },
    cachePolicy: CLAUDE_CACHE_POLICY,
    window: 1_000_000,
    effectiveDate: '2026-10-07',
  },
  {
    pattern: /^claude-sonnet-5(?:-\d{8})?(?:\[[^\]]+\])?$/,
    rate: { input: 2, output: 10 },
    cachePolicy: CLAUDE_CACHE_POLICY,
    window: 1_000_000,
    effectiveDate: '2026-08-10',
  },
  {
    pattern: /^claude-sonnet-4-6(?:-\d{8})?(?:\[[^\]]+\])?$/,
    rate: { input: 3, output: 15 },
    cachePolicy: CLAUDE_CACHE_POLICY,
    window: 1_000_000,
  },
  {
    pattern: /^claude-sonnet-4-5(?:-\d{8})?(?:\[[^\]]+\])?$/,
    rate: { input: 3, output: 15 },
    cachePolicy: CLAUDE_CACHE_POLICY,
    window: 200_000,
  },
  // https://platform.claude.com/docs/en/about-claude/pricing
  // A prompt over 100,000 tokens pays five times every rate. The threshold counts total request
  // input, cache reads and writes included, as the shared request band does for every banded model.
  {
    effortChangeKeepsCache: true,
    pattern: /^claude-haiku-5-5(?:-\d{8})?(?:\[[^\]]+\])?$/,
    rate: { input: 0.1, output: 0.5 },
    longContext: { threshold: 100_000, inputMultiplier: 5, outputMultiplier: 5 },
    cachePolicy: CLAUDE_CACHE_POLICY,
    window: 1_000_000,
    effectiveDate: '2026-10-07',
  },
  {
    pattern: /^claude-haiku-4-5(?:-\d{8})?(?:\[[^\]]+\])?$/,
    rate: { input: 1, output: 5 },
    cachePolicy: CLAUDE_CACHE_POLICY,
    window: 200_000,
  },
  // https://developers.openai.com/api/docs/models/gpt-6-astra
  {
    pattern: /^gpt-6-astra$/,
    rate: { input: 10, cacheWrite30m: 12.5, cacheRead: 1, output: 50 },
    window: 1_050_000,
    cachePolicy: {
      kind: 'documented',
      lifetime: '30m',
      sources: ['https://developers.openai.com/api/docs/guides/prompt-caching'],
    },
    providers: ['openai'],
    maxPricedContext: 272_000,
    longContext: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
    // https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-astra.html
    bedrock: {
      prefixes: /^(?:us|global)?$/,
      regionalMultiplier: 1.1,
      window: 1_050_000,
      cachePolicy: {
        kind: 'unknown',
        sources: ['https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-astra.html'],
      },
      effectiveDate: null,
    },
  },
  // https://developers.openai.com/api/docs/models/gpt-6.1-sol
  {
    pattern: /^gpt-6\.1-sol$/,
    rate: { input: 2, cacheWrite30m: 2.5, cacheRead: 0.1, output: 10 },
    window: 1_050_000,
    cachePolicy: {
      kind: 'documented',
      lifetime: '30m',
      sources: ['https://developers.openai.com/api/docs/guides/prompt-caching'],
    },
    providers: ['openai'],
    maxPricedContext: 272_000,
    longContext: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
    serviceTierMultipliers: { fast: 2, priority: 2, flex: 0.5, batch: 0.5 },
    // https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-1-sol.html
    // The model card specifies thirty minutes as the default and only supported cache lifetime.
    bedrock: {
      prefixes: /^(?:us|global)?$/,
      regionalMultiplier: 1.1,
      window: 1_000_000,
      cachePolicy: {
        kind: 'documented',
        lifetime: '30m',
        sources: ['https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-1-sol.html'],
      },
      effectiveDate: '2026-09-29',
    },
  },
  // https://developers.openai.com/api/docs/models/gpt-6-sol
  {
    pattern: /^gpt-6-sol$/,
    rate: { input: 2, cacheWrite30m: 2.5, cacheRead: 0.2, output: 10 },
    window: 1_050_000,
    cachePolicy: {
      kind: 'documented',
      lifetime: '30m',
      sources: ['https://developers.openai.com/api/docs/guides/prompt-caching'],
    },
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
    cachePolicy: {
      kind: 'documented',
      lifetime: '30m',
      sources: ['https://developers.openai.com/api/docs/guides/prompt-caching'],
    },
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
    // GPT-5.5 supports only 24h retention. Its typical thirty minutes supplies estimated timing.
    // Actual retention varies up to twenty-four hours. Thirty minutes is not a configured TTL or minimum.
    cachePolicy: {
      kind: 'documented',
      lifetime: '30m',
      sources: ['https://developers.openai.com/api/docs/guides/prompt-caching'],
    },
    providers: ['openai'],
    maxPricedContext: 272_000,
    longContext: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
  },
  {
    pattern: /^gpt-5\.4(?:-2026-03-05)?$/,
    rate: { input: 2.5, cacheRead: 0.25, output: 15 },
    window: 1_050_000,
    cachePolicy: {
      kind: 'documented',
      lifetime: '5m',
      sources: ['https://developers.openai.com/api/docs/guides/prompt-caching'],
    },
    providers: ['openai'],
    maxPricedContext: 272_000,
    longContext: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
  },
  // The promotion carries its inclusive end date and standard rates.
  {
    pattern: /^gpt-5\.6(?:-sol)?$/,
    promotion: {
      until: '2026-11-21',
      standard: { input: 5, cacheWrite30m: 6.25, cacheRead: 0.5, output: 30 },
      note:
        'OpenAI held gpt-5.6-sol at $4/$20 at least to this date, against a standard $5/$30. ' +
        'Check the published rate: either move the date out, or take the promotion off and use standard.',
    },
    rate: { input: 4, cacheWrite30m: 5, cacheRead: 0.4, output: 20 },
    window: 272_000,
    cachePolicy: {
      kind: 'documented',
      lifetime: '30m',
      sources: ['https://developers.openai.com/api/docs/guides/prompt-caching'],
    },
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
    cachePolicy: {
      kind: 'documented',
      lifetime: '30m',
      sources: ['https://developers.openai.com/api/docs/guides/prompt-caching'],
    },
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
    cachePolicy: {
      kind: 'documented',
      lifetime: '30m',
      sources: ['https://developers.openai.com/api/docs/guides/prompt-caching'],
    },
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

// Promotional rates carry an inclusive end date and their standard replacement rates.
// pricing.test.ts fails after the end date, requiring a rate or promotion update.
interface Promotion {
  until: string; // ISO date the promotional rate is held to, inclusive
  standard: Rate; // Rates to apply after the promotion ends.
  note: string; // Rate-source guidance for promotion updates.
}

export const PROMOTIONS = MODEL_DEFINITIONS.flatMap((row) =>
  row.promotion ? [{ pattern: row.pattern, promo: row.promotion }] : [],
);

const CODEX_AUTO_REVIEW_MODEL = 'codex-auto-review';
export const MODEL_RATE_ALIASES: Readonly<Record<string, string>> = {
  // https://help.openai.com/en/articles/20001415-chatgpt-rate-card-enterprise-token-based-pricing
  [CODEX_AUTO_REVIEW_MODEL]: 'gpt-5.4',
};

function modelForRate(model: string): string {
  return MODEL_RATE_ALIASES[model] ?? model;
}

export interface ModelPricingResolution {
  definition: ModelDefinition;
  provider: string | null;
  route: 'direct' | 'bedrock' | 'unspecified';
  inferenceClass: UsageInferenceClass;
  threshold: number | null;
  window: number;
  cacheLifetime: CacheLifetime | null;
  cachePolicy: CachePolicy;
  rate: Rate;
  regionalMultiplier: number;
  effectiveDate: string | null;
}

const BEDROCK_MODEL = /^(?:([^.]+)\.)?openai\.(.+)$/;

// https://code.claude.com/docs/en/prompt-caching#changing-effort-level
// Google Cloud, the apps gateway, HIPAA, and disabled experimental betas have no separate recorded signal.
// Those undetectable routes retain the direct-model policy here.
export function effortChangeKeepsCache(
  model: string | null,
  provider: string | null,
  inferenceClass: UsageInferenceClass = null,
  bedrock = false,
): boolean {
  if (!model || provider !== null || bedrock || inferenceClass === 'bedrock-regional') return false;
  const identity = modelForRate(model);
  const policy = MODEL_DEFINITIONS.find((row) => row.pattern.test(identity))?.effortChangeKeepsCache;
  return policy === true || (policy instanceof RegExp && policy.test(identity));
}

// Explicit provider and recorded inference evidence select a route.
export function resolveModelPricing(
  model: string | null,
  provider: string | null = null,
  inferenceClass: UsageInferenceClass = null,
): ModelPricingResolution | null {
  if (!model) {
    return null;
  }
  const pricedModel = modelForRate(model);
  const bedrock = provider === 'amazon-bedrock' ? BEDROCK_MODEL.exec(model) : null;
  const prefix = bedrock?.[1] ?? '';
  const row = MODEL_DEFINITIONS.find((candidate) => {
    if (provider === 'amazon-bedrock') {
      return !!(
        bedrock &&
        candidate.bedrock &&
        candidate.pattern.test(bedrock[2]) &&
        candidate.bedrock.prefixes.test(prefix) &&
        (candidate.bedrock.model === undefined || candidate.bedrock.model === bedrock[2])
      );
    }
    return (
      candidate.pattern.test(pricedModel) &&
      (candidate.providers
        ? provider === null
          ? !candidate.providerRequired
          : candidate.providers.includes(provider)
        : provider === null)
    );
  });
  if (!row) {
    return null;
  }
  const support = bedrock ? row.bedrock : undefined;
  const claudeBedrock = !row.providers && inferenceClass === 'bedrock-regional';
  const resolvedClass = support ? (prefix === 'global' ? 'global' : prefix ? 'geo' : 'in-region') : inferenceClass;
  const cachePolicy = support ? support.cachePolicy : row.cachePolicy;
  return {
    definition: row,
    provider,
    route: support || claudeBedrock ? 'bedrock' : provider === null ? 'unspecified' : 'direct',
    inferenceClass: resolvedClass,
    threshold: row.longContext?.threshold ?? null,
    window: support?.window ?? row.window,
    cacheLifetime: cachePolicy.kind === 'documented' ? cachePolicy.lifetime : null,
    cachePolicy,
    rate: support?.rate ?? row.rate,
    regionalMultiplier: support
      ? prefix === 'global'
        ? 1
        : support.regionalMultiplier
      : modernClaude(model) && (resolvedClass === 'in-region' || claudeBedrock)
        ? 1.1
        : 1,
    effectiveDate: support
      ? (prefix && support.profileEffectiveDate) || support.effectiveDate
      : (row.effectiveDate ?? null),
  };
}

function modernClaude(model: string | null): boolean {
  return model !== null && /^claude-(?:fable|mythos|opus|sonnet|haiku)-(?:5|4-[5678])\b/.test(model);
}

// Bedrock Claude IDs identify inference profiles, including bare anthropic IDs.
// Supported modern Claude models use a 1.1 multiplier outside the global profile.
const BEDROCK_CLAUDE_ID = /^(?:([^.]+)\.)?anthropic\.claude-/;

export function bedrockClaudeListMultiplier(modelId: string, model: string | null): number {
  const match = BEDROCK_CLAUDE_ID.exec(modelId);
  return match && match[1] !== 'global' && modernClaude(model) ? 1.1 : 1;
}

// Claude CLI records list-price cost under the list basis.
// Codex-launched Claude children with regional Bedrock pricing carry the multiplied cost under this basis.
export const BEDROCK_LIST_COST_BASIS = 'bedrock-list';

// Accept recorded list costs and costs that include the Bedrock multiplier.
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

function longContextRate(row: ModelDefinition, band: UsageContextBand | null, rate: Rate = row.rate): Rate {
  const tier = row.longContext;
  if (!tier || band !== 'long') {
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
  const threshold = resolveModelPricing(model, provider)?.threshold;
  return threshold !== null && threshold !== undefined ? (requestTokens > threshold ? 'long' : 'short') : null;
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
  contextBand: UsageContextBand | null = null,
): { rate: Rate; source: string; effectiveDate: string | null; cacheWritesFree?: boolean } | null {
  const fast = serviceTier === FAST_SPEED;
  const standard = usesStandardPublicRate(provider, serviceTier);
  const resolved = resolveModelPricing(model, provider, inferenceClass);
  if (!resolved) {
    return null;
  }
  const row = resolved.definition;
  // Request size or a retained band selects the tier. A legacy aggregate with neither uses capacity to reject unsupported pricing.
  if (
    requestTokens === null &&
    contextBand === null &&
    contextWindow !== null &&
    row.maxPricedContext &&
    contextWindow > row.maxPricedContext
  ) {
    return null;
  }
  const band = contextBand ?? contextBandForRequest(model, provider, requestTokens);
  if (provider === 'amazon-bedrock') {
    return standard
      ? {
          rate: multiplied(longContextRate(row, band, resolved.rate), resolved.regionalMultiplier),
          source: 'AWS Bedrock standard',
          effectiveDate: resolved.effectiveDate,
        }
      : null;
  }
  const tierMultiplier = row.serviceTierMultipliers?.[serviceTier ?? ''];
  if (!standard && !(fast && row.fast) && tierMultiplier === undefined) {
    return null;
  }
  const contextRate = fast && row.fast ? row.fast : longContextRate(row, band);
  // Modern Claude in-region and regional Bedrock requests receive one 1.1 multiplier, selected by their inference class.
  const tierRate = tierMultiplier === undefined ? contextRate : multiplied(contextRate, tierMultiplier);
  const rate = multiplied(tierRate, resolved.regionalMultiplier);
  return {
    rate,
    source:
      model === CODEX_AUTO_REVIEW_MODEL
        ? 'OpenAI Codex rate card'
        : model?.startsWith('claude-')
          ? 'Anthropic list price'
          : 'OpenAI list price',
    effectiveDate: resolved.effectiveDate,
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
  return resolveModelPricing(model, provider)?.window ?? null;
}

// Shared Claude cache-price multiples prevent differences between cost formulas.
const CACHE_WRITE_1H = 2;
const CACHE_WRITE_5M = 1.25;
const CACHE_READ = 0.1;

// Re-export recorded cache lifetimes for pricing consumers.
export type CacheTier = CacheLifetime;

// Nominal cache lifetimes. Reuse refreshes the lifetime, so consumers measure age from the latest request.
export const CACHE_LIFETIME_MS: Record<CacheTier, number> = {
  '5m': 5 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
};

// Forward estimates treat the cache as cold this far before nominal expiry to account for request-clock differences.
export const CONSERVATIVE_CACHE_BOUNDARY_MS = 90_000;

// Return the provider's documented cache lifetime for the model.
// GPT-5.6 and later use the published thirty-minute minimum. GPT-5.5 uses typical thirty-minute retention.
// GPT-5.4 uses the low end of its documented in-memory retention range.
// Claude definitions require recorded lifetimes and supply no documented fallback here.
export function cacheLifetimeFor(model: string | null, provider: string | null = null): CacheTier | null {
  return resolveModelPricing(model, provider)?.cacheLifetime ?? null;
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
  // Recorded inference class and service tier select regional multipliers and supported public rates.
  inferenceClass?: UsageInferenceClass;
  serviceTier?: string | null;
}

// Warm and cold starting-price estimates in dollars, with rates in dollars per million tokens.
export interface NextTurnFloor {
  warm: number;
  cold: number;
  warmRate: number;
  coldRate: number;
  inputRate: number;
  // The lifetime the cold figure is priced at, or null where the record named none.
  tier: CacheTier | null;
  // Whether the cold estimate charges cache writes rather than ordinary input.
  // A missing recorded lifetime does not exclude a provider's cache-write charge.
  coldIsWrite: boolean;
}

// Claude compaction estimates resend the previous main request's context plus an uncached summary instruction.
// Warm estimates retain the previous cache-read count and repeat cache writes at the five-minute tier.
// Cold estimates write the shared prefix and send the remaining context uncached.
// Stored summary text supplies an output estimate. The character ratio includes discarded analysis output.
export const CLAUDE_COMPACTION_INSTRUCTION_TOKENS = 2_000;
export const CLAUDE_COMPACTION_SUMMARY_CHARS_PER_TOKEN = 2.2;

// Estimate Claude compaction input. Warm requests with no cache split count the full previous input as a cache read.
function claudeCompactionInput(
  previous: Pick<CompactionPreviousRequest, 'tokens' | 'cacheRead' | 'cacheWrite'>,
  cold: boolean,
  prefixTokens: number | null,
  lifetime: CacheTier | null,
): Partial<TurnUsage> {
  if (cold) {
    const prefix = Math.min(previous.tokens, Math.max(0, prefixTokens ?? 0));
    return {
      ...writeCounts(lifetime ?? '1h', prefix),
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

// Price uncached context when the request records no lifetime.
// An explicit thirty-minute write rate selects that tier. Modern Claude otherwise uses the one-hour write fallback.
// Other models without a write rate charge ordinary input.
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

// Cache retention does not establish a separate write charge.
// Modern Claude supports five-minute and one-hour writes. Thirty-minute writes require an explicit rate.
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

// Estimate the next request's warm and cold input cost before new prompt text or output.
// Warm usage reads the established context and sends fresh output as ordinary input.
// Cold usage resends both through the recorded write tier or the provider's uncached fallback.
// quoteUsage applies request bands, regional multipliers, service tiers, and cache rates to both estimates.
// Invalid counts or unavailable rates return null.
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

export function requestInputTokens(usage: TurnUsage): number {
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

// Quotes retain their pricing source. Recorded charges take precedence over configured rates and public definitions.
export function quoteUsage(input: UsageQuoteInput): UsageQuote | null {
  const provider = input.provider ?? null;
  const requestBand = contextBandForRequest(input.model, provider, input.requestTokens ?? null);
  const contextBand = input.contextBand ?? requestBand;
  if (input.contextBand && requestBand && input.contextBand !== requestBand) {
    return null;
  }
  if (
    contextBand === 'long' &&
    !hasRequestContextPricing(input.model, provider) &&
    !input.override &&
    input.reportedCost == null
  ) {
    return null;
  }
  const metadata = {
    provider,
    serviceTier: input.serviceTier ?? null,
    inferenceClass:
      resolveModelPricing(input.model, provider, input.inferenceClass ?? null)?.inferenceClass ??
      input.inferenceClass ??
      null,
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
  // Overrides for fast requests must name the fast tier. Overrides without it leave fast usage unpriced.
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
        contextBand,
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
        contextBand,
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

// Estimate turn cost in dollars. Unsupported pricing or incomplete request bands return null.
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
        contextBand: band,
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

// Estimate recorded cache-read cost using the rates and request bands shared with estimateCost.
// Unsupported pricing or unavailable aggregate request bands return null.
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

// Round a positive starting-price estimate upward so the displayed amount covers the estimated cost.
// Values below ten dollars round to cents. Larger values round to whole dollars.
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

// Previous main-request input, cache split, timestamp, and lifetime for compaction estimates.
// A missing timestamp or lifetime leaves the estimate warm.
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
  // The cache read plus cache write of the first request, or null where none is known.
  firstRequestCachedTokens?: number | null;
  // The first request after compaction reads the prefix the compaction wrote.
  postCompactionCacheRead?: number | null;
  // The length of the stored summary text in characters, preamble included, or null where no
  // summary was paired with the record.
  summaryChars?: number | null;
}

function knownClock(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

// Compare request age with the full nominal cache lifetime. Missing clocks or lifetime return false.
// Retrospective compaction estimates exclude the conservative boundary used for forward estimates.
export function cacheLapsedBy(requestAt: number | null, lifetime: CacheTier | null, at: number): boolean {
  if (lifetime === null || !knownClock(requestAt) || !knownClock(at)) {
    return false;
  }
  return at - requestAt >= CACHE_LIFETIME_MS[lifetime];
}

// Warm estimates repeat prior cache reads and five-minute writes, with the instruction sent uncached.
// Cold estimates write the shared prefix and send the rest uncached.
// Read estimates price non-modern-Claude context as cached input.
export type CompactionEstimateBasis = 'warm' | 'cold' | 'read';

export interface CompactionEstimate {
  usage: TurnUsage;
  basis: CompactionEstimateBasis;
}

// Estimate compaction usage and its cache basis. Both recorded context sizes are required.
// Modern Claude uses previous request input when available, with recorded contextBefore as the fallback.
// Cache expiry is measured at request start, using the compaction duration when available.
// Output uses stored summary characters when positive, otherwise contextAfter.
// Other models price contextBefore as cache reads and contextAfter as output.
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
      ...claudeCompactionInput(
        previous ?? { tokens: contextBefore },
        cold,
        estimate.postCompactionCacheRead ?? estimate.firstRequestCachedTokens ?? null,
        previous?.lifetime ?? null,
      ),
      output: summaryChars > 0 ? Math.round(summaryChars / CLAUDE_COMPACTION_SUMMARY_CHARS_PER_TOKEN) : contextAfter,
    },
    basis: cold ? 'cold' : 'warm',
  };
}

// Price compactionEstimate usage with its request-wide context band and previous request's inference class and service tier.
// Missing required figures or unavailable pricing return null.
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

// Cached reads as a percentage of total input, including cache writes.
export function cacheHitPercent(usage: TurnUsage): number | null {
  const total = usage.input + usage.cacheWrite1h + usage.cacheWrite5m + (usage.cacheWrite30m ?? 0) + usage.cacheRead;
  if (total === 0) {
    return null;
  }
  return Math.round((usage.cacheRead / total) * 100);
}
