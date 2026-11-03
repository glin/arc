// Formats durations, local times, token counts, byte counts, and model names.
// `turnview.ts` re-exports these helpers for existing callers.

export {
  formatCompactRelative,
  formatDuration,
  formatRelative,
  RELATIVE_STEPS,
  RELATIVE_UNDER_A_MINUTE,
} from './view/time.ts';
export type { RelativeStep } from './view/time.ts';
export { formatTokens } from './view/tokens.ts';
import { modelWindowOf, normalizeModelIdentity } from './domain/model-identity.ts';
import type { ListedModel } from './domain/model-catalog.ts';
import { canonicalPriceTier } from './pricing';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatClock(at: number): string {
  const d = new Date(at);
  const h = d.getHours();
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

// The day, or null when the turn is from today and the clock alone is enough.
export function formatDay(at: number, now: number = Date.now()): string | null {
  const d = new Date(at);
  if (d.toDateString() === new Date(now).toDateString()) {
    return null;
  }
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

// Removes the Claude model prefix and trailing snapshot date.
export function shortModel(model: string | null): string | null {
  if (!model) {
    return null;
  }
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

export type { ModelTierIdentity } from './domain/model-identity';
import type { ModelTierIdentity } from './domain/model-identity';

export function speedName(provider: string | null | undefined, tier: string | null | undefined): string | null {
  const canonical = canonicalPriceTier(provider, tier);
  if (
    (provider == null && canonical === 'standard') ||
    ((provider === 'openai' || provider === 'amazon-bedrock') && canonical === 'default')
  )
    return 'Standard';
  if (provider === 'openai') {
    return (
      ({ priority: 'Fast', ultrafast: 'Ultrafast', flex: 'Flex', batch: 'Batch' } as Record<string, string>)[
        canonical ?? ''
      ] ?? null
    );
  }
  return provider == null && canonical === 'fast' ? 'Fast' : null;
}

// Only the displayed model's own requests establish its recorded speed.
export function recordedModelSpeed(
  model: string | null,
  parts: readonly ModelTierIdentity[] | undefined,
): string | null {
  if (!model || parts?.some((part) => !normalizeModelIdentity(part.model))) return null;
  const held =
    parts?.filter((part) => normalizeModelIdentity(part.model ?? '') === normalizeModelIdentity(model)) ?? [];
  if (!held.length) return null;
  const speeds = held.map((part) => speedName(part.provider, part.serviceTier));
  if (speeds.some((speed) => speed === null)) return null;
  const distinct = new Set(speeds);
  if (distinct.size > 1) return 'Mixed speeds';
  return speeds[0];
}

// Compact labels omit a known Standard setting while keeping it distinct in retained evidence.
export function modelSpeed(model: string | null, parts: readonly ModelTierIdentity[] | undefined): string | null {
  const speed = recordedModelSpeed(model, parts);
  return speed === 'Standard' ? null : speed;
}

export function modelTierKey(part: ModelTierIdentity): string {
  return JSON.stringify([part.model, part.provider ?? null, canonicalPriceTier(part.provider, part.serviceTier)]);
}

export function modelWithSpeed(part: ModelTierIdentity, labels?: ModelLabels, short = false): string {
  const model = short ? (shortModel(part.model) ?? 'model not recorded') : friendlyModel(part.model, labels);
  const speed = speedName(part.provider, part.serviceTier);
  return speed && speed !== 'Standard' ? `${model} · ${speed}` : model;
}

const MODEL_WORD = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

// Display names keyed by model ID without a context window suffix or a snapshot date, as
// `modelLabels` builds them.
export type ModelLabels = ReadonlyMap<string, string>;

// Display names from the model lists the CLIs publish, earlier lists first. Each entry names its
// `value` and its `resolvedModel`, and the first list that names a model wins. A `default` entry
// names a choice, not a model. An entry whose label repeats its ID has no display name. An entry
// whose value or resolved model carries a context window suffix can name the window in its label.
// None of the three names anything.
export function modelLabels(lists: readonly (readonly ListedModel[])[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const list of lists) {
    for (const entry of list) {
      const label = entry.label.trim();
      const ids = [entry.value, entry.resolvedModel].filter((id): id is string => !!id?.trim());
      if (
        !label ||
        entry.value.trim().toLowerCase() === 'default' ||
        ids.includes(label) ||
        ids.some((id) => modelWindowOf(id) !== '')
      ) {
        continue;
      }
      for (const id of ids) {
        const key = normalizeModelIdentity(id);
        if (key && !labels.has(key)) labels.set(key, label);
      }
    }
  }
  return labels;
}

// Whether two label maps hold the same names.
export function sameModelLabels(left: ModelLabels, right: ModelLabels): boolean {
  return left.size === right.size && [...left].every(([key, label]) => right.get(key) === label);
}

// A model's reading name. The display name a CLI's model list gives it comes first. Otherwise
// `claude-opus-5-5-20261001` reads `Opus 5.5`, `gpt-6.1-sol` reads `GPT-6.1 Sol` and
// `gpt-6-astra` reads `GPT-6 Astra`. Any other model reads its recorded ID, and a missing model
// reads `Model not recorded`.
export function friendlyModel(model: string | null | undefined, labels?: ModelLabels): string {
  if (!model) {
    return 'Model not recorded';
  }
  const listed = labels?.get(normalizeModelIdentity(model));
  if (listed) {
    return listed;
  }
  // A context suffix such as `[1m]` and a snapshot date name the same model.
  const bare = model
    .replace(/\[[^\]]*\]$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '');
  // Newer Claude IDs put the family first, as `claude-opus-5-5`. Older ones put it last, as `claude-3-5-haiku`.
  const named = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?$/.exec(bare);
  const versioned = /^claude-(\d+)(?:-(\d+))?-(opus|sonnet|haiku)$/.exec(bare);
  if (named || versioned) {
    const [family, major, minor] = named
      ? [named[1], named[2], named[3]]
      : [versioned![3], versioned![1], versioned![2]];
    return `${MODEL_WORD(family)} ${major}${minor ? `.${minor}` : ''}`;
  }
  const gpt = /^gpt-(\d+(?:\.\d+)?)((?:-[a-z]+)*)$/.exec(bare);
  if (gpt) {
    const words = gpt[2].split('-').filter(Boolean).map(MODEL_WORD);
    return [`GPT-${gpt[1]}`, ...words].join(' ');
  }
  return model;
}

// Formats binary megabytes with one decimal below 10 MB and whole numbers above it.
// Rounded values at or above 1024 MB use gigabytes, so 1023.6 MB displays as `1 GB`.
export function formatMegabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 10) {
    const whole = Math.round(mb);
    if (whole >= 1024) {
      return `${Number((whole / 1024).toFixed(1))} GB`;
    }
    return `${whole} MB`;
  }
  const tenths = Math.round(mb * 10) / 10;
  // Keep a positive byte count visible when rounding to tenths would produce zero.
  if (tenths === 0 && bytes > 0) {
    return `${Number(mb.toPrecision(1))} MB`;
  }
  return `${tenths} MB`;
}

// When a session was last active, for the picker. A clock alone reads as today, so
// anything older names its day, and anything from another year names that too.
export function formatWhen(at: number, now: number = Date.now()): string {
  const day = formatDay(at, now);
  if (!day) {
    return formatClock(at);
  }
  const year = new Date(at).getFullYear();
  const suffix = year === new Date(now).getFullYear() ? '' : ` ${year}`;
  return `${day}${suffix} ${formatClock(at)}`;
}
