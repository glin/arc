import * as vscode from 'vscode';
import { SECTION, SettingKey, SettingType, settingDefault } from './settings';

// Reads extension settings with the defaults from `settings.ts`.
// The explicit defaults match the contributed defaults checked by `settings.test.ts`.
export function readSetting<K extends SettingKey>(key: K): SettingType<K> {
  return vscode.workspace.getConfiguration(SECTION).get<SettingType<K>>(key, settingDefault(key));
}

// Writes settings at user scope so they follow the reader across workspaces.
export function writeSetting<K extends SettingKey>(key: K, value: SettingType<K>): Thenable<void> {
  return vscode.workspace.getConfiguration(SECTION).update(key, value, vscode.ConfigurationTarget.Global);
}
