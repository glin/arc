import * as vscode from 'vscode';
import { SECTION, SettingKey, SettingType, settingDefault } from './settings';

// The one place a setting is actually asked for. It is here rather than in the two files
// that read settings because it cannot be tested: `vscode` has no module to import outside
// the extension host, so a copy in each of those files would be the same untestable lines
// written twice, in the two files nothing checks.
//
// The default is passed in as well as contributed, because `get` hands back the contributed
// one and the panel would otherwise be reading a number the code never states.
// `settings.test.ts` holds the two copies against each other.
export function readSetting<K extends SettingKey>(key: K): SettingType<K> {
  return vscode.workspace.getConfiguration(SECTION).get<SettingType<K>>(key, settingDefault(key));
}

// The one place a setting is written. The user scope, so the value follows the reader into
// every workspace and appears in the Settings editor where the reader looks for it.
export function writeSetting<K extends SettingKey>(key: K, value: SettingType<K>): Thenable<void> {
  return vscode.workspace.getConfiguration(SECTION).update(key, value, vscode.ConfigurationTarget.Global);
}
