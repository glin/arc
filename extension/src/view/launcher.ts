import type { ModelChoice } from '../domain/model-catalog';
import { effortLabel, modelLabel, type DefaultContext } from './model-picks';
import { missingSetupValue, type CompleteSetupValues, type SetupValueName } from '../domain/session-setups';

export const UNREADY_LAUNCHER_WORDS = {
  primaryLabel: 'New',
  primaryName: 'New session',
  menuName: 'Choose a setup for a new session',
};

export interface SessionProfile {
  agent: 'claude' | 'codex';
  model: string;
  effort: string;
  permissionMode: string;
  source: 'inherited' | 'recent' | 'custom';
}

export interface LauncherProfileRow {
  key: string;
  label: string;
  detail: string;
  name: string;
  profile: SessionProfile;
}

export interface LauncherPinnedRow extends LauncherProfileRow {
  id: string;
  available: boolean;
  missingValue: SetupValueName | null;
}

export interface LauncherValue {
  value: string;
  label: string;
  detail: string;
  name: string;
  configuredDefault?: boolean;
}

export interface LauncherModel extends LauncherValue {
  identity?: string;
  aliases?: string[];
  efforts: LauncherValue[];
}

export interface LauncherAgent extends LauncherValue {
  modelsPending?: boolean;
  models: LauncherModel[];
  catalog?: ModelChoice[] | readonly ModelChoice[];
  defaults?: DefaultContext;
  supportedModels?: readonly { value: string; efforts: readonly { value: string }[] }[];
  permissions: LauncherValue[];
  // The permission value a setup with no remembered choice preselects.
  defaultPermission: string;
}

export interface SessionLauncherView {
  owner?: string;
  primary: LauncherProfileRow | null;
  inherited: LauncherProfileRow | null;
  pinned: LauncherPinnedRow[];
  recent: LauncherProfileRow[];
  agents: LauncherAgent[];
  words: {
    railLabel: string;
    primaryLabel: string;
    primaryName: string;
    primaryDetail: string;
    menuName: string;
    menuHeading: string;
    pinnedHeading: string;
    pinnedEmpty: string;
    recentHeading: string;
    // The pin button's accessible name is this, then the row's name.
    pinName: string;
    pinHint: string;
    pinDetail: string;
    unpinHint: string;
    unpinDetail: string;
    // The Edit button's accessible name is this, then the row's name.
    editName: string;
    editHint: string;
    editDetail: string;
    // What an unavailable pinned row says, by the value the catalog no longer offers. The
    // custom fields say the same before each held value the catalog no longer offers.
    missingReasons: Record<SetupValueName, string>;
    customHeading: string;
    agentLabel: string;
    modelLabel: string;
    effortLabel: string;
    permissionLabel: string;
    createLabel: string;
  };
}

export interface SetupListing {
  version: 1;
  project: string;
  primary?: string;
  setups: {
    key: string;
    provider: SessionProfile['agent'];
    model?: string;
    effort?: string;
    permissions?: string;
    missingValue?: SetupValueName;
  }[];
  agents: {
    provider: string;
    modelsPending?: true;
    models: { value: string; efforts: string[] }[];
    permissions: string[];
  }[];
}

export function setupListing(view: SessionLauncherView, project: string): SetupListing {
  const keys = new Set<string>();
  const setups: SetupListing['setups'] = [];
  for (const row of [view.inherited, view.primary, ...view.pinned, ...view.recent]) {
    if (!row || keys.has(row.key)) continue;
    keys.add(row.key);
    const { agent, model, effort, permissionMode } = row.profile;
    const missingValue = missingSetupValue(row.profile, view.agents);
    setups.push({
      key: row.key,
      provider: agent,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(permissionMode ? { permissions: permissionMode } : {}),
      ...(missingValue ? { missingValue } : {}),
    });
  }
  return {
    version: 1,
    project,
    ...(view.primary ? { primary: view.primary.key } : {}),
    setups,
    agents: view.agents.map((agent) => {
      const values = new Set<string>();
      const models: SetupListing['agents'][number]['models'] = [];
      for (const model of agent.supportedModels ?? agent.models) {
        if (values.has(model.value)) continue;
        values.add(model.value);
        models.push({ value: model.value, efforts: [...new Set(model.efforts.map((effort) => effort.value))] });
      }
      return {
        provider: agent.value,
        ...(agent.modelsPending ? { modelsPending: true } : {}),
        models,
        permissions: agent.permissions.map((permission) => permission.value),
      };
    }),
  };
}

export type LauncherRequest =
  | { kind: 'row'; key: string }
  | { kind: 'custom'; agent: string; model: string; effort: string; permissionMode: string };

export type PinSetupRequest =
  | { kind: 'row'; key: string; values: CompleteSetupValues }
  | Extract<LauncherRequest, { kind: 'custom' }>;

export interface LauncherChoice {
  agent: string;
  model: string;
  effort: string;
  permissionMode: string;
}

export function newSessionShortcut(platform: string): string {
  return /^Mac/.test(platform || '') ? 'Command+N' : 'Ctrl+N';
}

export function newSessionKeyshortcut(platform: string): string {
  return /^Mac/.test(platform || '') ? 'Meta+N' : 'Control+N';
}

export function newSessionName(name: string, platform: string): string {
  return `${name} (${newSessionShortcut(platform)})`;
}

export function launcherCustomRequest(
  view: SessionLauncherView,
  choice: LauncherChoice,
): Extract<LauncherRequest, { kind: 'custom' }> | null {
  const agent = view.agents.find((one) => one.value === choice.agent);
  if (!agent || missingSetupValue({ ...choice, agent: agent.value as SessionProfile['agent'] }, view.agents)) {
    return null;
  }
  return {
    kind: 'custom',
    agent: agent.value,
    model: choice.model,
    effort: choice.effort,
    permissionMode: choice.permissionMode,
  };
}

// Name each setup field and value for Create and the field pin.
// Return empty text when the agent or permission is missing. Use fallback labels for missing model and effort values.
export function customValuesName(
  view: SessionLauncherView,
  request: Extract<LauncherRequest, { kind: 'custom' }>,
): string {
  const agent = view.agents.find((one) => one.value === request.agent);
  const model = agent?.catalog
    ? modelLabel(agent.catalog, request.model, agent.defaults)
    : agent?.models.find((one) => one.value === request.model)?.label;
  const effort = agent?.catalog
    ? effortLabel(agent.catalog, request.model, request.effort, agent.defaults)
    : agent?.models.find((one) => one.value === request.model)?.efforts.find((one) => one.value === request.effort)
        ?.label;
  const permission = agent?.permissions.find((one) => one.value === request.permissionMode);
  if (!agent || !permission) return '';

  return (
    `${view.words.agentLabel}: ${agent.label}. ${view.words.modelLabel}: ${model ?? 'Model not reported'}. ` +
    `${view.words.effortLabel}: ${effort ?? 'Effort not reported'}. ${view.words.permissionLabel}: ${permission.label}`
  );
}

export function customProfileName(
  view: SessionLauncherView,
  request: Extract<LauncherRequest, { kind: 'custom' }>,
): string {
  const values = customValuesName(view, request);
  return values ? `${view.words.createLabel}. ${values}` : view.words.createLabel;
}
