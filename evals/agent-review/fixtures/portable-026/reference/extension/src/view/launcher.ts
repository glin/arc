import type { CompleteSetupValues, SetupValueName } from '../domain/session-setups';

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
}

export interface LauncherModel extends LauncherValue {
  efforts: LauncherValue[];
}

export interface LauncherAgent extends LauncherValue {
  models: LauncherModel[];
  permissions: LauncherValue[];
  // The permission value a setup with no remembered choice preselects.
  defaultPermission: string;
}

export interface SessionLauncherView {
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
  const model = agent?.models.find((one) => one.value === choice.model);
  const effort = model?.efforts.find((one) => one.value === choice.effort);
  const permission = agent?.permissions.find((one) => one.value === choice.permissionMode);
  if (!agent || !model || !effort || !permission) {
    return null;
  }
  return {
    kind: 'custom',
    agent: agent.value,
    model: model.value,
    effort: effort.value,
    permissionMode: permission.value,
  };
}

// Each field and its value, as the accessible names of Create and the field pin read them.
// Empty when the catalog lacks a value.
export function customValuesName(
  view: SessionLauncherView,
  request: Extract<LauncherRequest, { kind: 'custom' }>,
): string {
  const agent = view.agents.find((one) => one.value === request.agent);
  const model = agent?.models.find((one) => one.value === request.model);
  const effort = model?.efforts.find((one) => one.value === request.effort);
  const permission = agent?.permissions.find((one) => one.value === request.permissionMode);
  if (!agent || !model || !effort || !permission) {
    return '';
  }
  return (
    `${view.words.agentLabel}: ${agent.label}. ${view.words.modelLabel}: ${model.label}. ` +
    `${view.words.effortLabel}: ${effort.label}. ${view.words.permissionLabel}: ${permission.label}`
  );
}

export function customProfileName(
  view: SessionLauncherView,
  request: Extract<LauncherRequest, { kind: 'custom' }>,
): string {
  const values = customValuesName(view, request);
  return values ? `${view.words.createLabel}. ${values}` : view.words.createLabel;
}
