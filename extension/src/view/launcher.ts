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

// Each field and its value, as the accessible names of Create and the field pin read them.
// Empty when the catalog lacks a value.
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
