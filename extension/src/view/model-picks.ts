import { windowedChoice, type ModelChoice } from '../domain/model-catalog';
import { modelWindowOf, namesDeploymentOf, sameModelIdentity, WINDOW_SUFFIX } from '../domain/model-identity';
export type { ModelChoice } from '../domain/model-catalog';
export { windowedChoice } from '../domain/model-catalog';

export interface AppliedDefaults {
  status: 'loading' | 'ready' | 'unavailable';
  model: string | null;
  effort: string | null;
  effortStatus?: 'unavailable';
  reason: string;
}

export interface DefaultContext {
  revision?: number;
  base?: AppliedDefaults;
  models?: Readonly<Record<string, AppliedDefaults>>;
}

export const LOADING_DEFAULTS: AppliedDefaults = { status: 'loading', model: null, effort: null, reason: '' };
export function unavailableDefaults(reason: string): AppliedDefaults {
  return { status: 'unavailable', model: null, effort: null, reason };
}

export function modelIdentity(model: ModelChoice): string {
  return model.resolvedModel || model.value;
}

// Resolve a recorded or applied model id to one explicit catalog row. Empty and default rows name no concrete model.
// A row with a resolved model matches on model identity, so a Bedrock prefix or a snapshot date still finds it.
// A known window prefers the row with the same window, then accepts a row with that identity in any window.
// An unknown window accepts a row in any window only when one model answers, so a catalog that lists both windows stays unresolved.
// Several rows with one identity resolve to the first shown, which is the row modelPicks holds and the launcher lists.
// Several rows with different identities resolve only to the row whose value is the recorded id.
// Without an identity match, a `claude-` alias matches on identity before a short alias matches as a substring.
// The alias pass reads every explicit row, so a resolved model with a deployment suffix still answers to its alias.
export function recordedChoice(
  models: readonly ModelChoice[],
  recorded: string | null,
  windowKnown: boolean,
): ModelChoice | null {
  if (!recorded) {
    return null;
  }
  const id = recorded.trim().toLowerCase();
  const window = modelWindowOf(id);
  const windowOf = (m: ModelChoice) => modelWindowOf(m.resolvedModel || m.value);
  const explicit = models.filter((m) => m.value !== '' && m.value.toLowerCase() !== 'default');
  const one = (found: readonly ModelChoice[]): ModelChoice | null | undefined => {
    if (found.length <= 1) return found[0];
    const identity = modelIdentity(found[0]).toLowerCase();
    if (found.every((m) => modelIdentity(m).toLowerCase() === identity))
      return found.find((m) => !m.hidden) ?? found[0];
    return found.find((m) => m.value.toLowerCase() === id) ?? null;
  };
  const identified = explicit.filter((m) => m.resolvedModel && sameModelIdentity(m.resolvedModel, id));
  const sameWindow = windowKnown ? one(identified.filter((m) => windowOf(m) === window)) : undefined;
  if (sameWindow !== undefined) {
    return sameWindow;
  }
  const exact = one(explicit.filter((m) => m.value.toLowerCase() === id));
  if (exact !== undefined) {
    return exact;
  }
  const anyWindow = one(identified);
  if (anyWindow !== undefined) {
    return anyWindow;
  }
  // A row with a resolved model answers to a short alias only when that model adds a deployment suffix to the id.
  const bare = id.replace(WINDOW_SUFFIX, '');
  const aliased = explicit.map((m) => [m, m.value.toLowerCase().replace(WINDOW_SUFFIX, '').trim()] as const);
  const full = aliased.filter(([, alias]) => alias.startsWith('claude-') && sameModelIdentity(alias, bare));
  const short = aliased.filter(
    ([m, alias]) =>
      alias !== '' &&
      !alias.startsWith('claude-') &&
      bare.includes(alias) &&
      (!m.resolvedModel || namesDeploymentOf(m.resolvedModel, bare)),
  );
  const named = (full.length ? full : short).map(([m]) => m);
  const windowed = windowKnown ? named.filter((m) => windowOf(m) === window) : [];
  return one(windowed.length ? windowed : named) ?? null;
}

// Project the applied default onto a catalog row without changing any saved or wire value.
// The projection uses the recorded-model resolver, so a model reads the same label before and after its first turn.
export function defaultIdentity(models: readonly ModelChoice[], context: DefaultContext = {}): string | null {
  const applied = context.base?.status === 'ready' ? context.base.model : null;
  if (!applied || models.some((item) => modelIdentity(item) === applied)) return applied;
  const row = recordedChoice(models, applied, true);
  return row ? modelIdentity(row) : applied;
}

function exactChoice(models: readonly ModelChoice[], identity: string | null): ModelChoice | null {
  return (
    models.find((item) => item.value === identity) ?? models.find((item) => modelIdentity(item) === identity) ?? null
  );
}
export function resolvedChoice(
  models: readonly ModelChoice[],
  value: string,
  context: DefaultContext = {},
): ModelChoice | null {
  return exactChoice(models, value || defaultIdentity(models, context)) ?? windowedChoice(models, value);
}

export interface ModelPick extends ModelChoice {
  readingLabel: string;
  identity: string;
  aliases: string[];
  configuredDefault: boolean;
}
export function modelPicks(models: readonly ModelChoice[], context: DefaultContext = {}, live = false): ModelPick[] {
  const rows = new Map<string, ModelPick>();
  const defaultModel = defaultIdentity(models, context);
  for (const item of models) {
    const identity = modelIdentity(item);
    const held = rows.get(identity);
    if (held) {
      held.aliases.push(item.value);
      if (held.value === 'default' && item.value !== 'default') {
        Object.assign(held, item, {
          readingLabel: item.label,
          label: `${item.label}${identity === defaultModel ? ' (default)' : ''}`,
        });
      }
      continue;
    }
    if (item.hidden || (item.value === 'default' && !item.resolvedModel)) continue;
    const label = item.value === 'default' ? identity : item.label;
    rows.set(identity, {
      ...item,
      identity,
      aliases: [item.value],
      readingLabel: label,
      configuredDefault: identity === defaultModel,
      label: `${label}${identity === defaultModel ? ' (default)' : ''}`,
    });
  }
  if (defaultModel && !rows.has(defaultModel) && !live) {
    const known = models.find((item) => modelIdentity(item) === defaultModel);
    rows.set(defaultModel, {
      value: defaultModel,
      resolvedModel: defaultModel,
      identity: defaultModel,
      aliases: known ? [known.value] : [],
      readingLabel: known?.label ?? defaultModel,
      label: `${known?.label ?? defaultModel} (default)`,
      description: known?.description ?? '',
      efforts: known?.efforts ?? [],
      configuredDefault: true,
    });
  }
  return [...rows.values()];
}

export function selectedModelPick(
  models: readonly ModelChoice[],
  value: string,
  context: DefaultContext = {},
  live = false,
): ModelPick | null {
  const choice = resolvedChoice(models, value, context);
  const identity = choice ? modelIdentity(choice) : value || defaultIdentity(models, context);
  return (
    modelPicks(models, context, live).find((item) => item.identity === identity || item.aliases.includes(value)) ?? null
  );
}

export function defaultsForModel(
  models: readonly ModelChoice[],
  model: string,
  context: DefaultContext = {},
): AppliedDefaults | undefined {
  if (!model) return context.base;
  // Per-model defaults resolve exactly, so a value with an added window reads no other row's default.
  const choice = exactChoice(models, model);
  const identity = choice ? modelIdentity(choice) : model;
  return (
    context.models?.[model] ??
    context.models?.[identity] ??
    (context.base?.model === identity ? context.base : undefined)
  );
}

export function effortPicks(models: readonly ModelChoice[], model: string, context: DefaultContext = {}) {
  const chosen = resolvedChoice(models, model, context) ?? selectedModelPick(models, model, context);
  const defaults = defaultsForModel(models, model, context);
  return (chosen?.efforts ?? []).map((item) => ({
    ...item,
    readingLabel: item.label,
    configuredDefault: defaults?.status === 'ready' && defaults.effort === item.value,
    label: `${item.label}${defaults?.status === 'ready' && defaults.effort === item.value ? ' (default)' : ''}`,
  }));
}

export function modelLabel(models: readonly ModelChoice[], model: string, context: DefaultContext = {}): string {
  return (
    selectedModelPick(models, model, context)?.readingLabel ??
    (model || (context.base?.status === 'loading' ? 'Loading model' : 'Model not reported'))
  );
}
export function effortLabel(
  models: readonly ModelChoice[],
  model: string,
  effort: string,
  context: DefaultContext = {},
): string {
  const defaults = defaultsForModel(models, model, context);
  const value = effort || (defaults?.status === 'ready' ? defaults.effort : null);
  return (
    effortPicks(models, model, context).find((item) => item.value === value)?.readingLabel ??
    (effort ||
      (value
        ? value
        : defaults?.status === 'ready' && !defaults.effortStatus && defaults.effort === null
          ? 'No effort setting'
          : defaults?.status === 'loading'
            ? 'Loading effort'
            : 'Effort not reported'))
  );
}

export function modelAfterPick(
  models: readonly ModelChoice[],
  model: string,
  effort: string,
  value: string,
  context: DefaultContext = {},
) {
  const row = modelPicks(models, context).find((item) => item.value === value);
  if (!row) return null;
  if (selectedModelPick(models, model, context)?.identity === row.identity) return { model, effort };
  if (row.configuredDefault) return { model: '', effort: '' };
  return { model: row.value, effort: row.efforts.some((item) => item.value === effort) ? effort : '' };
}
export function effortAfterPick(
  models: readonly ModelChoice[],
  model: string,
  effort: string,
  value: string,
  context: DefaultContext = {},
) {
  const row = effortPicks(models, model, context).find((item) => item.value === value);
  if (!row) return null;
  const current = effort || defaultsForModel(models, model, context)?.effort;
  return current === row.value ? effort : row.configuredDefault ? '' : row.value;
}
