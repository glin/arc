import { formatCost } from "./view/cost.mjs";
const FAST_SPEED = "fast";
const MODELS = [
  {
    pattern: /^claude-(fable|mythos)-5-1(?:-\d{8})?(?:\[[^\]]+\])?$/,
    rate: { input: 10, cacheRead: 0.25, output: 50 },
    window: 1e6
  },
  {
    pattern: /^claude-(fable|mythos)-5(?:-\d{8})?(?:\[[^\]]+\])?$/,
    rate: { input: 10, output: 50 },
    window: 1e6
  },
  // https://platform.claude.com/docs/en/about-claude/pricing#fast-mode-pricing
  // Fast mode is sold on the first-party Claude API. A Claude row matches only a turn that
  // names no provider. A Bedrock Claude request names none either, so a fast one pays these
  // rates with the regional Bedrock charge on top.
  {
    pattern: /^claude-opus-5-5(?:-\d{8})?(?:\[[^\]]+\])?$/,
    rate: { input: 4, cacheRead: 0.2, output: 20 },
    fast: { input: 8, cacheRead: 0.4, output: 40 },
    window: 1e6
  },
  {
    pattern: /^claude-opus-(5|4-8)(?:-\d{8})?(?:\[[^\]]+\])?$/,
    rate: { input: 5, output: 25 },
    fast: { input: 10, output: 50 },
    window: 1e6
  },
  // Opus 4.7 refuses a fast request, and Opus 4.6 runs it at standard speed and records that.
  {
    pattern: /^claude-opus-(4-7|4-6)(?:-\d{8})?(?:\[[^\]]+\])?$/,
    rate: { input: 5, output: 25 },
    window: 1e6
  },
  { pattern: /^claude-opus-4-5(?:-\d{8})?(?:\[[^\]]+\])?$/, rate: { input: 5, output: 25 }, window: 2e5 },
  // Sonnet 5 is priced apart from Sonnet 4.6 because their standing rates differ.
  {
    pattern: /^claude-sonnet-5(?:-\d{8})?(?:\[[^\]]+\])?$/,
    rate: { input: 2, output: 10 },
    window: 1e6,
    effectiveDate: "2026-08-10"
  },
  { pattern: /^claude-sonnet-4-6(?:-\d{8})?(?:\[[^\]]+\])?$/, rate: { input: 3, output: 15 }, window: 1e6 },
  { pattern: /^claude-sonnet-4-5(?:-\d{8})?(?:\[[^\]]+\])?$/, rate: { input: 3, output: 15 }, window: 2e5 },
  { pattern: /^claude-haiku-4-5(?:-\d{8})?(?:\[[^\]]+\])?$/, rate: { input: 1, output: 5 }, window: 2e5 },
  // https://developers.openai.com/api/docs/models/gpt-6-astra
  {
    pattern: /^gpt-6-astra$/,
    rate: { input: 10, cacheWrite30m: 12.5, cacheRead: 1, output: 50 },
    window: 105e4,
    cacheLifetime: "30m",
    providers: ["openai"],
    maxPricedContext: 272e3,
    longContext: { threshold: 272e3, inputMultiplier: 2, outputMultiplier: 1.5 }
  },
  // https://developers.openai.com/api/docs/models/gpt-6-sol
  {
    pattern: /^gpt-6-sol$/,
    rate: { input: 2, cacheWrite30m: 2.5, cacheRead: 0.2, output: 10 },
    window: 105e4,
    cacheLifetime: "30m",
    providers: ["openai"],
    maxPricedContext: 272e3,
    longContext: { threshold: 272e3, inputMultiplier: 2, outputMultiplier: 1.5 }
  },
  // https://developers.openai.com/api/docs/models/gpt-6-luna
  {
    pattern: /^gpt-6-luna$/,
    rate: { input: 0.1, cacheWrite30m: 0.125, cacheRead: 0.01, output: 0.5 },
    window: 105e4,
    cacheLifetime: "30m",
    providers: ["openai"],
    maxPricedContext: 272e3,
    longContext: { threshold: 272e3, inputMultiplier: 2, outputMultiplier: 1.5 }
  },
  {
    pattern: /^gpt-5\.5(?:-2026-04-23)?$/,
    rate: { input: 5, cacheRead: 0.5, output: 30 },
    window: 105e4,
    cacheLifetime: "5m",
    providers: ["openai"],
    maxPricedContext: 272e3,
    longContext: { threshold: 272e3, inputMultiplier: 2, outputMultiplier: 1.5 }
  },
  {
    pattern: /^gpt-5\.4(?:-2026-03-05)?$/,
    rate: { input: 2.5, cacheRead: 0.25, output: 15 },
    window: 105e4,
    cacheLifetime: "5m",
    providers: ["openai"],
    maxPricedContext: 272e3,
    longContext: { threshold: 272e3, inputMultiplier: 2, outputMultiplier: 1.5 }
  },
  // Promotional; see PROMOTIONS below for the date and the standard rate.
  {
    pattern: /^gpt-5\.6(?:-sol)?$/,
    rate: { input: 4, cacheWrite30m: 5, cacheRead: 0.4, output: 20 },
    window: 272e3,
    cacheLifetime: "30m",
    providers: ["openai"],
    maxPricedContext: 272e3,
    longContext: { threshold: 272e3, inputMultiplier: 2, outputMultiplier: 1.5 }
  },
  {
    pattern: /^gpt-5\.6-terra$/,
    rate: { input: 2, cacheWrite30m: 2.5, cacheRead: 0.2, output: 12 },
    window: 272e3,
    cacheLifetime: "30m",
    providers: ["openai"],
    maxPricedContext: 272e3,
    longContext: { threshold: 272e3, inputMultiplier: 2, outputMultiplier: 1.5 }
  },
  {
    pattern: /^gpt-5\.6-luna$/,
    rate: { input: 0.2, cacheWrite30m: 0.25, cacheRead: 0.02, output: 1.2 },
    window: 272e3,
    cacheLifetime: "30m",
    providers: ["openai"],
    maxPricedContext: 272e3,
    longContext: { threshold: 272e3, inputMultiplier: 2, outputMultiplier: 1.5 }
  }
];
const PROMOTIONS = [
  {
    pattern: /^gpt-5\.6(?:-sol)?$/,
    promo: {
      until: "2026-11-21",
      standard: { input: 5, cacheWrite30m: 6.25, cacheRead: 0.5, output: 30 },
      note: "OpenAI held gpt-5.6-sol at $4/$20 at least to this date, against a standard $5/$30. Check the published rate: either move the date out, or take the promotion off and use standard."
    }
  }
];
const CODEX_AUTO_REVIEW_MODEL = "codex-auto-review";
const MODEL_RATE_ALIASES = {
  // https://help.openai.com/en/articles/20001415-chatgpt-rate-card-enterprise-token-based-pricing
  [CODEX_AUTO_REVIEW_MODEL]: "gpt-5.4"
};
function modelForRate(model) {
  return MODEL_RATE_ALIASES[model] ?? model;
}
function rowFor(model, provider = null, contextWindow = null) {
  if (!model) {
    return null;
  }
  const pricedModel = modelForRate(model);
  return MODELS.find((row) => {
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
  }) ?? null;
}
const BEDROCK_PREFIX_EFFECTIVE_DATE = "2026-08-20";
const BEDROCK_BASE_EFFECTIVE_DATES = {
  "5.6-sol": "2026-08-21",
  "5.6-terra": "2026-07-30",
  "5.6-luna": "2026-07-30",
  "6-sol": "2026-09-22",
  "6-luna": "2026-09-22"
};
const BEDROCK_MODEL = /^(?:(global|[a-z]{2})\.)?openai\.gpt-(5\.6-(?:sol|terra|luna)|6-(?:sol|luna))$/;
const BEDROCK_RATES = {
  "5.6-sol": {
    short: { input: 4.4, cacheWrite30m: 5.5, cacheRead: 0.44, output: 22 },
    long: { input: 8.8, cacheWrite30m: 11, cacheRead: 0.88, output: 33 },
    globalShort: { input: 4, cacheWrite30m: 5, cacheRead: 0.4, output: 20 },
    globalLong: { input: 8, cacheWrite30m: 10, cacheRead: 0.8, output: 30 }
  },
  "5.6-terra": {
    short: { input: 2.2, cacheWrite30m: 2.75, cacheRead: 0.22, output: 13.2 },
    long: { input: 4.4, cacheWrite30m: 5.5, cacheRead: 0.44, output: 19.8 },
    globalShort: { input: 2, cacheWrite30m: 2.5, cacheRead: 0.2, output: 12 },
    globalLong: { input: 4, cacheWrite30m: 5, cacheRead: 0.4, output: 18 }
  },
  "5.6-luna": {
    short: { input: 0.22, cacheWrite30m: 0.275, cacheRead: 0.022, output: 1.32 },
    long: { input: 0.44, cacheWrite30m: 0.55, cacheRead: 0.044, output: 1.98 },
    globalShort: { input: 0.2, cacheWrite30m: 0.25, cacheRead: 0.02, output: 1.2 },
    globalLong: { input: 0.4, cacheWrite30m: 0.5, cacheRead: 0.04, output: 1.8 }
  },
  // https://aws.amazon.com/about-aws/whats-new/2026/09/openai-gpt-6-sol-luna-on-amazon-bedrock/
  // https://developers.openai.com/api/docs/pricing
  "6-sol": {
    short: { input: 2.2, cacheWrite30m: 2.75, cacheRead: 0.22, output: 11 },
    long: { input: 4.4, cacheWrite30m: 5.5, cacheRead: 0.44, output: 16.5 },
    globalShort: { input: 2, cacheWrite30m: 2.5, cacheRead: 0.2, output: 10 },
    globalLong: { input: 4, cacheWrite30m: 5, cacheRead: 0.4, output: 15 }
  },
  "6-luna": {
    short: { input: 0.11, cacheWrite30m: 0.1375, cacheRead: 0.011, output: 0.55 },
    long: { input: 0.22, cacheWrite30m: 0.275, cacheRead: 0.022, output: 0.825 },
    globalShort: { input: 0.1, cacheWrite30m: 0.125, cacheRead: 0.01, output: 0.5 },
    globalLong: { input: 0.2, cacheWrite30m: 0.25, cacheRead: 0.02, output: 0.75 }
  }
};
function bedrockRateFor(model, provider, contextWindow, requestTokens) {
  if (provider !== "amazon-bedrock" || !model) {
    return null;
  }
  const match = BEDROCK_MODEL.exec(model);
  if (!match) {
    return null;
  }
  if (requestTokens === null && contextWindow !== null && contextWindow > 272e3) {
    return null;
  }
  const long = requestTokens !== null && requestTokens > 272e3;
  const geo = match[1] === "global" ? "global" : "regional";
  const rates = BEDROCK_RATES[match[2]];
  return geo === "global" ? long ? rates.globalLong : rates.globalShort : long ? rates.long : rates.short;
}
function bedrockEffectiveDate(model) {
  const match = model ? BEDROCK_MODEL.exec(model) : null;
  if (!match) {
    return BEDROCK_PREFIX_EFFECTIVE_DATE;
  }
  if (match[2].startsWith("6-")) {
    return BEDROCK_BASE_EFFECTIVE_DATES[match[2]];
  }
  return match[1] ? BEDROCK_PREFIX_EFFECTIVE_DATE : BEDROCK_BASE_EFFECTIVE_DATES[match[2]];
}
function modernClaude(model) {
  return model !== null && /^claude-(?:fable|mythos|opus|sonnet|haiku)-(?:5|4-[5678])\b/.test(model);
}
const BEDROCK_CLAUDE_ID = /^(?:([^.]+)\.)?anthropic\.claude-/;
function bedrockClaudeListMultiplier(modelId, model) {
  const match = BEDROCK_CLAUDE_ID.exec(modelId);
  return match && match[1] !== "global" && modernClaude(model) ? 1.1 : 1;
}
const BEDROCK_LIST_COST_BASIS = "bedrock-list";
function recordedCostBasis(basis) {
  return basis === "list" || basis === BEDROCK_LIST_COST_BASIS;
}
function multiplied(rate, multiplier) {
  const scale = (value) => Number((value * multiplier).toPrecision(15));
  return {
    input: scale(rate.input),
    output: scale(rate.output),
    ...rate.cacheWrite30m === void 0 ? {} : { cacheWrite30m: scale(rate.cacheWrite30m) },
    ...rate.cacheRead === void 0 ? {} : { cacheRead: scale(rate.cacheRead) }
  };
}
function longContextRate(row, requestTokens) {
  const tier = row.longContext;
  if (!tier || requestTokens === null || requestTokens <= tier.threshold) {
    return row.rate;
  }
  const scaleInput = (value) => Number((value * tier.inputMultiplier).toPrecision(15));
  return {
    input: scaleInput(row.rate.input),
    output: Number((row.rate.output * tier.outputMultiplier).toPrecision(15)),
    ...row.rate.cacheWrite30m === void 0 ? {} : { cacheWrite30m: scaleInput(row.rate.cacheWrite30m) },
    ...row.rate.cacheRead === void 0 ? {} : { cacheRead: scaleInput(row.rate.cacheRead) }
  };
}
function contextBandForRequest(model, provider, requestTokens) {
  if (requestTokens === null) {
    return null;
  }
  if (provider === "amazon-bedrock" && model && BEDROCK_MODEL.test(model)) {
    return requestTokens > 272e3 ? "long" : "short";
  }
  const row = rowFor(model, provider, null);
  return row?.longContext ? requestTokens > row.longContext.threshold ? "long" : "short" : null;
}
function hasRequestContextPricing(model, provider) {
  return contextBandForRequest(model, provider, 0) !== null;
}
function publicRateFor(model, provider, contextWindow, requestTokens, inferenceClass, serviceTier) {
  const fast = serviceTier === FAST_SPEED;
  if (!fast && !usesStandardPublicRate(provider, serviceTier)) {
    return null;
  }
  const bedrock = fast ? null : bedrockRateFor(model, provider, contextWindow, requestTokens);
  if (bedrock) {
    return { rate: bedrock, source: "AWS Bedrock standard", effectiveDate: bedrockEffectiveDate(model) };
  }
  const row = rowFor(model, provider, requestTokens === null ? contextWindow : null);
  if (!row || fast && !row.fast) {
    return null;
  }
  const contextRate = fast && row.fast ? row.fast : longContextRate(row, requestTokens);
  const regional = inferenceClass === "in-region" || inferenceClass === "bedrock-regional";
  const rate = regional && modernClaude(model) ? multiplied(contextRate, 1.1) : contextRate;
  return {
    rate,
    source: model === CODEX_AUTO_REVIEW_MODEL ? "OpenAI Codex rate card" : model?.startsWith("claude-") ? "Anthropic list price" : "OpenAI list price",
    effectiveDate: row.effectiveDate ?? null,
    ...model === CODEX_AUTO_REVIEW_MODEL ? { cacheWritesFree: true } : {}
  };
}
function usesStandardPublicRate(provider, serviceTier) {
  return serviceTier === null || serviceTier === "standard" || // https://docs.aws.amazon.com/bedrock/latest/userguide/service-tiers-inference.html
  (provider === "openai" || provider === "amazon-bedrock") && serviceTier === "default";
}
function rateFor(model, provider = null, contextWindow = null) {
  return publicRateFor(model, provider, contextWindow, null, null, null)?.rate ?? null;
}
function contextWindowFor(model, provider = null) {
  if (bedrockRateFor(model, provider, null, null)) {
    return 272e3;
  }
  return rowFor(model, provider)?.window ?? null;
}
const CACHE_WRITE_1H = 2;
const CACHE_WRITE_5M = 1.25;
const CACHE_READ = 0.1;
const CACHE_LIFETIME_MS = {
  "5m": 5 * 6e4,
  "30m": 30 * 6e4,
  "1h": 60 * 6e4
};
const CONSERVATIVE_CACHE_BOUNDARY_MS = 9e4;
function cacheLifetimeFor(model, provider = null) {
  const row = rowFor(model, provider);
  if (row) {
    return row.cacheLifetime ?? null;
  }
  return bedrockRateFor(model, provider, null, null) ? "30m" : null;
}
const CLAUDE_COMPACTION_INSTRUCTION_TOKENS = 2e3;
const CLAUDE_COMPACTION_SUMMARY_CHARS_PER_TOKEN = 2.2;
function claudeCompactionInput(previous, cold, firstRequestCacheRead) {
  if (cold) {
    const prefix = firstRequestCacheRead ?? 0;
    return {
      cacheRead: prefix,
      input: Math.max(0, previous.tokens + CLAUDE_COMPACTION_INSTRUCTION_TOKENS - prefix)
    };
  }
  const split = previous.cacheRead !== void 0 || previous.cacheWrite !== void 0;
  return {
    cacheRead: split ? previous.cacheRead ?? 0 : previous.tokens,
    cacheWrite5m: split ? previous.cacheWrite ?? 0 : 0,
    input: CLAUDE_COMPACTION_INSTRUCTION_TOKENS
  };
}
const NO_USAGE = {
  requests: 1,
  input: 0,
  cacheWrite1h: 0,
  cacheWrite5m: 0,
  cacheWrite30m: 0,
  cacheRead: 0,
  output: 0,
  thinking: 0
};
function writeCounts(tier, tokens) {
  if (tier === "1h") {
    return { cacheWrite1h: tokens };
  }
  if (tier === "5m") {
    return { cacheWrite5m: tokens };
  }
  return { cacheWrite30m: tokens };
}
function uncachedCounts(model, provider, tokens) {
  const rate = rateFor(model, provider);
  if (rate?.cacheWrite30m !== void 0) {
    return { counts: { cacheWrite30m: tokens }, isWrite: true };
  }
  if (modernClaude(model)) {
    return { counts: { cacheWrite1h: tokens }, isWrite: true };
  }
  return { counts: { input: tokens }, isWrite: false };
}
function coldCounts(input, tokens) {
  if ((input.tier === "1h" || input.tier === "5m") && modernClaude(input.model)) {
    return { counts: writeCounts(input.tier, tokens), isWrite: true };
  }
  if (input.tier === "30m" && rateFor(input.model, input.provider ?? null)?.cacheWrite30m !== void 0) {
    return { counts: writeCounts(input.tier, tokens), isWrite: true };
  }
  return uncachedCounts(input.model, input.provider ?? null, tokens);
}
function perMillionRate(dollars, tokens) {
  return Number((dollars / tokens * 1e6).toFixed(12));
}
function nextTurnFloor(input) {
  const cachedTokens = input.contextTokens;
  const freshTokens = input.freshTokens ?? 0;
  const tokens = cachedTokens + freshTokens;
  const requestTokens = input.requestTokens ?? tokens;
  if (!Number.isFinite(cachedTokens) || cachedTokens <= 0 || !Number.isFinite(freshTokens) || freshTokens < 0 || !Number.isFinite(requestTokens) || requestTokens <= 0) {
    return null;
  }
  const shared = {
    model: input.model,
    provider: input.provider ?? null,
    contextWindow: input.contextWindow ?? null,
    requestTokens,
    inferenceClass: input.inferenceClass ?? null,
    serviceTier: input.serviceTier ?? null
  };
  const warm = quoteUsage({
    ...shared,
    usage: { ...NO_USAGE, cacheRead: cachedTokens, input: freshTokens }
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
    coldIsWrite: written.isWrite
  };
}
function requestInputTokens(usage) {
  return usage.input + usage.cacheWrite1h + usage.cacheWrite5m + (usage.cacheWrite30m ?? 0) + usage.cacheRead;
}
function costAtRate(usage, rate, cacheWritesFree = false) {
  if (!cacheWritesFree && (usage.cacheWrite30m ?? 0) > 0 && rate.cacheWrite30m === void 0) {
    return null;
  }
  const perToken = rate.input / 1e6;
  return usage.input * perToken + (cacheWritesFree ? 0 : usage.cacheWrite1h * perToken * CACHE_WRITE_1H) + (cacheWritesFree ? 0 : usage.cacheWrite5m * perToken * CACHE_WRITE_5M) + (cacheWritesFree ? 0 : (usage.cacheWrite30m ?? 0) * ((rate.cacheWrite30m ?? 0) / 1e6)) + usage.cacheRead * ((rate.cacheRead ?? rate.input * CACHE_READ) / 1e6) + usage.output * (rate.output / 1e6);
}
function quoteUsage(input) {
  const provider = input.provider ?? null;
  const contextBand = contextBandForRequest(input.model, provider, input.requestTokens ?? null);
  const metadata = {
    provider,
    serviceTier: input.serviceTier ?? null,
    inferenceClass: input.inferenceClass ?? null,
    contextBand
  };
  if (input.reportedCost !== null && input.reportedCost !== void 0) {
    return {
      cost: input.reportedCost,
      rate: null,
      source: "reported",
      effectiveDate: null,
      reported: true,
      ...metadata
    };
  }
  if (input.override && input.serviceTier === FAST_SPEED && input.override.serviceTier !== FAST_SPEED) {
    return null;
  }
  const publicPrice = input.override ? publicRateFor(
    input.model,
    input.provider ?? null,
    input.contextWindow ?? null,
    input.requestTokens ?? null,
    input.inferenceClass ?? null,
    null
  ) : null;
  const publicWriteRate = publicPrice?.rate.cacheWrite30m;
  const configuredRate = input.override && input.override.rate.cacheWrite30m === void 0 && publicWriteRate !== void 0 ? {
    ...input.override.rate,
    cacheWrite30m: input.override.rate.input * (publicWriteRate / publicPrice.rate.input)
  } : input.override?.rate;
  const priced = input.override ? { rate: configuredRate, source: input.override.source, effectiveDate: input.override.effectiveDate } : publicRateFor(
    input.model,
    input.provider ?? null,
    input.contextWindow ?? null,
    input.requestTokens ?? null,
    input.inferenceClass ?? null,
    input.serviceTier ?? null
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
    ...metadata
  };
}
function estimateCost(usage, model, provider = null, contextWindow = null, requestTokens = null, priceContext = {}) {
  if (usage.byContextBand) {
    let cost = 0;
    const combined = {
      requests: 0,
      input: 0,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      cacheWrite30m: 0,
      cacheRead: 0,
      output: 0,
      thinking: 0
    };
    for (const band of ["short", "long"]) {
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
        requestTokens: band === "long" ? 272001 : 272e3,
        ...priceContext
      });
      if (!quoted) {
        return null;
      }
      cost += quoted.cost;
    }
    if ((combined.requests ?? 0) !== (usage.requests ?? 0) || combined.input !== usage.input || combined.cacheWrite1h !== usage.cacheWrite1h || combined.cacheWrite5m !== usage.cacheWrite5m || (combined.cacheWrite30m ?? 0) !== (usage.cacheWrite30m ?? 0) || combined.cacheRead !== usage.cacheRead || combined.output !== usage.output || combined.thinking !== usage.thinking) {
      return null;
    }
    return cost;
  }
  if (requestTokens === null && hasRequestContextPricing(model, provider) && requestInputTokens(usage) + usage.output > 0) {
    const aggregateInput = requestInputTokens(usage);
    if ((usage.requests ?? 0) !== 1 && contextBandForRequest(model, provider, aggregateInput) !== "short") {
      return null;
    }
    requestTokens = aggregateInput;
  }
  return quoteUsage({ usage, model, provider, contextWindow, requestTokens, ...priceContext })?.cost ?? null;
}
function estimateCacheReadCost(usage, model, provider = null, contextWindow = null) {
  const requestTokens = requestInputTokens(usage);
  if (!usage.byContextBand && (usage.requests ?? 0) !== 1 && hasRequestContextPricing(model, provider) && contextBandForRequest(model, provider, requestTokens) !== "short") {
    return null;
  }
  const part = {
    requests: usage.requests ?? 0,
    input: 0,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheWrite30m: 0,
    cacheRead: usage.cacheRead,
    output: 0,
    thinking: 0
  };
  if (usage.byContextBand) {
    part.byContextBand = {};
    for (const band of ["short", "long"]) {
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
        thinking: 0
      };
    }
    return estimateCost(part, model, provider, contextWindow);
  }
  return estimateCost(part, model, provider, contextWindow, requestTokens);
}
function formatConservativeCost(dollars) {
  if (dollars == null || dollars <= 0) {
    return null;
  }
  if (dollars < 0.01) {
    return "$0.01";
  }
  if (dollars < 10) {
    return `$${(Math.ceil(dollars * 100) / 100).toFixed(2)}`;
  }
  return `$${Math.ceil(dollars)}`;
}
function knownClock(value) {
  return value !== null && Number.isFinite(value) && value > 0;
}
function cacheLapsedBy(requestAt, lifetime, at) {
  if (lifetime === null || !knownClock(requestAt) || !knownClock(at)) {
    return false;
  }
  return at - requestAt >= CACHE_LIFETIME_MS[lifetime];
}
function compactionEstimate(estimate) {
  const { contextBefore, contextAfter } = estimate;
  if (!contextBefore || !contextAfter) {
    return null;
  }
  if (!modernClaude(estimate.model)) {
    return { usage: { ...NO_USAGE, cacheRead: contextBefore, output: contextAfter }, basis: "read" };
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
      output: summaryChars > 0 ? Math.round(summaryChars / CLAUDE_COMPACTION_SUMMARY_CHARS_PER_TOKEN) : contextAfter
    },
    basis: cold ? "cold" : "warm"
  };
}
function estimateCompactionCost(estimate) {
  const usage = compactionEstimate(estimate)?.usage;
  if (!usage) {
    return null;
  }
  const previous = estimate.previousRequest;
  return estimateCost(usage, estimate.model, null, null, requestInputTokens(usage), {
    inferenceClass: previous?.inferenceClass ?? null,
    serviceTier: previous?.serviceTier ?? null
  });
}
function cacheHitPercent(usage) {
  const total = usage.input + usage.cacheWrite1h + usage.cacheWrite5m + (usage.cacheWrite30m ?? 0) + usage.cacheRead;
  if (total === 0) {
    return null;
  }
  return Math.round(usage.cacheRead / total * 100);
}
export {
  BEDROCK_LIST_COST_BASIS,
  CACHE_LIFETIME_MS,
  CLAUDE_COMPACTION_INSTRUCTION_TOKENS,
  CLAUDE_COMPACTION_SUMMARY_CHARS_PER_TOKEN,
  CONSERVATIVE_CACHE_BOUNDARY_MS,
  PROMOTIONS,
  bedrockClaudeListMultiplier,
  cacheHitPercent,
  cacheLapsedBy,
  cacheLifetimeFor,
  compactionEstimate,
  contextBandForRequest,
  contextWindowFor,
  estimateCacheReadCost,
  estimateCompactionCost,
  estimateCost,
  formatConservativeCost,
  formatCost,
  hasRequestContextPricing,
  nextTurnFloor,
  quoteUsage,
  rateFor,
  recordedCostBasis,
  usesStandardPublicRate
};
