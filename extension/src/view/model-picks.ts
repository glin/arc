import type { ModelChoice } from '../domain/model-catalog';
import { hasNativeClaudeOneMillionWindow, WINDOW_SUFFIX } from '../domain/model-identity';
export type { ModelChoice } from '../domain/model-catalog';

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

// Project the applied default onto a catalog row without changing any saved or wire value.
export function defaultIdentity(models: readonly ModelChoice[], context: DefaultContext = {}): string | null {
  const applied = context.base?.status === 'ready' ? context.base.model : null;
  if (!applied || models.some((item) => modelIdentity(item) === applied)) return applied;
  const bare = applied.replace(WINDOW_SUFFIX, '');
  return hasNativeClaudeOneMillionWindow(bare) && models.some((item) => modelIdentity(item) === bare) ? bare : applied;
}
export function resolvedChoice(
  models: readonly ModelChoice[],
  value: string,
  context: DefaultContext = {},
): ModelChoice | null {
  const identity = value || defaultIdentity(models, context);
  return (
    models.find((item) => item.value === identity) ?? models.find((item) => modelIdentity(item) === identity) ?? null
  );
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
  const choice = resolvedChoice(models, model, context);
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
