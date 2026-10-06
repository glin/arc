import { windowedChoice } from './model-catalog';
export type SetupAgent = 'claude' | 'codex';

export interface SetupValues {
  agent: SetupAgent | null;
  model: string;
  effort: string;
  permissionMode: string;
}

export interface CompleteSetupValues extends SetupValues {
  agent: SetupAgent;
}

export interface PinnedSetup extends CompleteSetupValues {
  id: string;
}

export const SETUP_ID_LIMIT = 64;
export const SETUP_VALUE_LIMIT = 200;
export const RECENT_SETUP_LIMIT = 10;
export const RECENT_SETUP_VISIBLE = 8;

const SETUP_AGENTS: readonly SetupAgent[] = ['claude', 'codex'];

export function sameValues(a: SetupValues, b: SetupValues): boolean {
  return a.agent === b.agent && a.model === b.model && a.effort === b.effort && a.permissionMode === b.permissionMode;
}

function setupValue(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length <= SETUP_VALUE_LIMIT ? raw : null;
}

export function normalizeSetupValues(raw: unknown): CompleteSetupValues | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const agent = SETUP_AGENTS.find((one) => one === row.agent);
  const model = setupValue(row.model);
  const effort = setupValue(row.effort);
  const permissionMode = setupValue(row.permissionMode);
  if (!agent || model === null || effort === null || permissionMode === null) {
    return null;
  }
  return { agent, model, effort, permissionMode };
}

export function normalizePinnedSetups(raw: unknown): PinnedSetup[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const ids = new Set<string>();
  const setups: PinnedSetup[] = [];
  for (const entry of raw) {
    const values = normalizeSetupValues(entry);
    if (!values) {
      continue;
    }
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!id || id.length > SETUP_ID_LIMIT || ids.has(id)) {
      continue;
    }
    ids.add(id);
    setups.push({ id, ...values });
  }
  return setups;
}

export function pinValues(list: readonly PinnedSetup[], values: CompleteSetupValues, newId: string): PinnedSetup[] {
  if (list.some((one) => sameValues(one, values))) {
    return [...list];
  }
  const id = newId.trim();
  if (!id || id.length > SETUP_ID_LIMIT || list.some((one) => one.id === id)) {
    return [...list];
  }
  return [...list, { id, ...values }];
}

export function unpinId(list: readonly PinnedSetup[], id: string): PinnedSetup[] {
  return list.filter((one) => one.id !== id);
}

export interface SetupCatalogAgent {
  value: string;
  modelsPending?: boolean;
  models: readonly { value: string; efforts: readonly { value: string }[] }[];
  permissions: readonly { value: string }[];
  supportedModels?: readonly { value: string; efforts: readonly { value: string }[] }[];
}

export type SetupValueName = 'agent' | 'model' | 'effort' | 'permission';

export function missingSetupValue(values: SetupValues, agents: readonly SetupCatalogAgent[]): SetupValueName | null {
  return missingSetupValues(values, agents)[0] ?? null;
}

export function missingSetupValues(values: SetupValues, agents: readonly SetupCatalogAgent[]): SetupValueName[] {
  const agent = agents.find((one) => one.value === values.agent);
  if (!agent) {
    return ['agent'];
  }
  const missing: SetupValueName[] = [];
  if (!agent.modelsPending) {
    const models = agent.supportedModels ?? agent.models;
    // A value can add a window to a listed value, as `opus[1m]` adds one to `opus`.
    const model = models.find((one) => one.value === values.model) ?? windowedChoice(models, values.model);
    if (!model) {
      missing.push('model');
    }
    if (!model?.efforts.some((one) => one.value === values.effort)) {
      missing.push('effort');
    }
  }
  if (!agent.permissions.some((one) => one.value === values.permissionMode)) missing.push('permission');
  return missing;
}

export function visibleRecents<T extends SetupValues>(
  recents: readonly T[],
  saved: readonly SetupValues[],
  current: SetupValues | null,
  agents: readonly SetupCatalogAgent[],
): T[] {
  const shown = current ? [...saved, current] : [...saved];
  return recents
    .slice(0, RECENT_SETUP_LIMIT)
    .filter((one) => missingSetupValue(one, agents) === null)
    .filter((one) => {
      if (shown.some((other) => sameValues(one, other))) return false;
      shown.push(one);
      return true;
    })
    .slice(0, RECENT_SETUP_VISIBLE);
}
