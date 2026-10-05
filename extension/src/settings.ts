// Every setting the extension reads, and the value it takes when nobody has set it.

import { ARC_IDENTITY } from './identity';
import { DEFAULT_TIMELINE_LAYOUT } from './view/timeline-layout';

export const SECTION = ARC_IDENTITY.settingsSection;

// The defaults live here rather than at each call site because `package.json` contributes
// them too, and the two have to agree: otherwise the settings editor shows one number and
// the panel uses another, with nothing to say which is the real one. `settings.test.ts`
// holds this table against what `package.json` actually contributes.
const SETTINGS = {
  maxSessions: 3,
  // Whether the panel writes a diagnostics log for the owner to read. A development aid,
  // off for every reader who never went looking for it. The host reads this once, when it
  // builds the log, so a change reaches the panel when the window reloads.
  'diagnostics.log': false,
  agentIdleMinutes: 60,
  // How much memory, in MiB, keeps recently viewed sessions ready.
  sessionCacheMiB: 16,
  // How many days back Project cost reads transcripts. 0 reads all history.
  'projectCost.historyDays': 0,
  // Where the Claude Code executable is. Empty means "whatever `claude` resolves to on
  // PATH", which is what the reader already types in a terminal.
  claudePath: '',
  codexPath: '',
  // Where an open turn card draws its files, subagents and commits, and where its prompt sits.
  // `view/timeline-layout.ts` names the values, and `settings.test.ts` holds the contributed
  // enums against that list.
  'timeline.cardLayout': DEFAULT_TIMELINE_LAYOUT.cardLayout as string,
  'timeline.promptPosition': DEFAULT_TIMELINE_LAYOUT.promptPosition as string,
};

// A key nobody contributed reads its default for ever, in silence. Naming them all makes a
// mistyped key a compile error instead, which matters here: the typecheck is the only
// automated check that reads the two files these settings are read from.
export type SettingKey = keyof typeof SETTINGS;
export type SettingType<K extends SettingKey> = (typeof SETTINGS)[K];

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

// What the reader would type to find the setting in their own settings file, which is why
// a notice that names one asks for it here rather than spelling it out again.
export function settingName(key: SettingKey): string {
  return `${SECTION}.${key}`;
}

// What the setting is worth when nobody has set it.
export function settingDefault<K extends SettingKey>(key: K): SettingType<K> {
  return SETTINGS[key];
}
