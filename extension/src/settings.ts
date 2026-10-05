// Extension settings and their defaults.

import { ARC_IDENTITY } from './identity';
import { DEFAULT_TIMELINE_LAYOUT } from './view/timeline-layout';

export const SECTION = ARC_IDENTITY.settingsSection;

// These defaults must match the contributions in `package.json`.
// Different values make the settings editor and panel disagree.
// `settings.test.ts` checks that the values match.
const SETTINGS = {
  maxSessions: 3,
  // Enables the panel diagnostics log. Logging is off by default.
  // The host reads this setting when it creates the log.
  // Reload the window to apply a change.
  'diagnostics.log': false,
  agentIdleMinutes: 60,
  // How much memory, in MiB, keeps recently viewed sessions ready.
  sessionCacheMiB: 16,
  // How many days back Project cost reads transcripts. 0 reads all history.
  'projectCost.historyDays': 0,
  // The Claude Code executable path. Empty uses the `claude` command on PATH.
  claudePath: '',
  codexPath: '',
  // Where an open turn card draws its files, subagents and commits, and where its prompt sits.
  // `view/timeline-layout.ts` defines the values.
  // `settings.test.ts` checks the contributed enums against those values.
  'timeline.cardLayout': DEFAULT_TIMELINE_LAYOUT.cardLayout as string,
  'timeline.promptPosition': DEFAULT_TIMELINE_LAYOUT.promptPosition as string,
};

// Restricts setting keys to this table so mistyped keys fail typechecking.
// Unrecognized configuration keys otherwise return their defaults without an error.
export type SettingKey = keyof typeof SETTINGS;
export type SettingType<K extends SettingKey> = (typeof SETTINGS)[K];

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

// Returns the full key used in the reader's settings file.
export function settingName(key: SettingKey): string {
  return `${SECTION}.${key}`;
}

// Returns the setting's default value.
export function settingDefault<K extends SettingKey>(key: K): SettingType<K> {
  return SETTINGS[key];
}
