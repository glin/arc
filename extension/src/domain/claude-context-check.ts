// Checks a Claude Code `get_context_usage` reply against the Messages breakdown that Context shows.
// The default suite runs it on the stored replies, and `npm run check:claude-context` runs it on a fresh one.

import {
  MESSAGE_FIELDS,
  normalizeContext,
  validContextDetail,
  type ContextDetail,
  type ContextIdentity,
} from './context-detail.ts';
import { compareVersion, parseVersion } from './version.ts';

export interface ClaudeContextFixture {
  claudeCode: string;
  reply: Record<string, unknown>;
}

export interface ClaudeContextCheck {
  failures: string[];
  detail: ContextDetail;
  // Attachment kinds that no stored reply carries. A new kind can repeat a category's text.
  newAttachmentKinds: string[];
  // `messageBreakdown` keys that the normalizer does not read. A new key can hold part of Messages.
  newMessageKeys: string[];
}

// The `messageBreakdown` lists that the normalizer reads beside the parts.
const MESSAGE_LISTS = ['toolCallsByType', 'attachmentsByType'];

const CHECK_IDENTITY: ContextIdentity = {
  session: 'claude-context-check',
  provider: 'claude',
  model: '',
  source: 'check',
  generation: 0,
  request: 0,
};

const FIXTURE = /^claude-context-usage-(.+)\.json$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function contextFixtureName(version: string): string {
  return `claude-context-usage-${version}.json`;
}

// Returns the stored reply file names ordered from the oldest Claude Code version to the newest.
export function contextFixtureNames(names: readonly string[]): string[] {
  return names
    .map((name) => ({ name, version: parseVersion(FIXTURE.exec(name)?.[1] ?? '') }))
    .filter((row) => row.version)
    .sort((a, b) => compareVersion(a.version!, b.version!))
    .map((row) => row.name);
}

export function attachmentKinds(reply: unknown): string[] {
  const kinds = record(record(reply)?.messageBreakdown)?.attachmentsByType;
  return Array.isArray(kinds)
    ? kinds.map((kind) => record(kind)?.name).filter((name): name is string => typeof name === 'string')
    : [];
}

export function checkClaudeContextReply(reply: unknown, knownKinds: ReadonlySet<string>): ClaudeContextCheck {
  const failures: string[] = [];
  const breakdown = record(record(reply)?.messageBreakdown);
  const missing = MESSAGE_FIELDS.filter(([key]) => !breakdown || !(key in breakdown)).map(([key]) => key);
  if (missing.length) failures.push(`The reply has no ${missing.join(', ')}.`);
  const detail = normalizeContext(reply, CHECK_IDENTITY);
  if (detail.status !== 'available') failures.push(`Context is ${detail.status}, not available.`);
  if (!detail.messageBreakdown) failures.push('Messages has no breakdown.');
  if (!validContextDetail(detail)) failures.push('The normalized detail fails validation.');
  return {
    failures,
    detail,
    newAttachmentKinds: attachmentKinds(reply).filter((kind) => !knownKinds.has(kind)),
    newMessageKeys: newMessageKeys(reply),
  };
}

function newMessageKeys(reply: unknown): string[] {
  const known = new Set<string>([...MESSAGE_FIELDS.map(([key]) => key), ...MESSAGE_LISTS]);
  return Object.keys(record(record(reply)?.messageBreakdown) ?? {}).filter((key) => !known.has(key));
}

// The reply that `--write-fixture` stores: the template's keys, plus every new `messageBreakdown` key.
export function contextFixtureReply(reply: unknown, template: unknown): Record<string, unknown> {
  const scrubbed = record(scrubContextReply(reply, template)) ?? {};
  const fields = record(record(reply)?.messageBreakdown);
  const added = newMessageKeys(reply).map((key) => [key, fields?.[key]]);
  if (!added.length) return scrubbed;
  return { ...scrubbed, messageBreakdown: { ...record(scrubbed.messageBreakdown), ...Object.fromEntries(added) } };
}

// Keeps only the keys that the template carries, at every depth. Array items take the keys of every template item.
export function scrubContextReply(value: unknown, template: unknown): unknown {
  if (Array.isArray(value)) {
    const items = Array.isArray(template) ? template : [];
    const keys = Object.assign({}, ...items.map((item) => record(item) ?? {}));
    return value.map((item) => (item && typeof item === 'object' ? scrubContextReply(item, keys) : item));
  }
  if (value && typeof value === 'object') {
    const keys = record(template) ?? {};
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => Object.hasOwn(keys, key))
        .map(([key, item]) => [key, scrubContextReply(item, keys[key])]),
    );
  }
  return value;
}

// The filesystem reads and removals that the project folder cleanup makes. `lstat` returns null for a missing path.
export interface FolderSystem {
  lstat(target: string): { isDirectory(): boolean } | null;
  readdir(target: string): string[];
  rmdir(target: string): void;
}

// Claude Code names a project folder after the sanitized working folder. Windows and macOS match names without case.
function sameProjectName(name: string, slug: string, platform: string): boolean {
  return platform === 'win32' || platform === 'darwin' ? name.toLowerCase() === slug.toLowerCase() : name === slug;
}

// The names in a real `projects` directory that match the project folder of `slug`. A linked `projects` folder has none.
export function projectFolderNames(system: FolderSystem, projects: string, slug: string, platform: string): string[] {
  if (!system.lstat(projects)?.isDirectory()) return [];
  return system.readdir(projects).filter((name) => sameProjectName(name, slug, platform));
}

// Removes each project folder of `slug` that is absent from `existing`, when it is a real directory that holds only
// empty real directories. Links are never followed. Returns the removed folders and the folders kept for their content.
export function removeCreatedProjectFolders(
  system: FolderSystem,
  projects: string,
  slug: string,
  platform: string,
  existing: readonly string[],
): { removed: string[]; kept: string[] } {
  const join = (parent: string, name: string) => `${parent}${platform === 'win32' ? '\\' : '/'}${name}`;
  const removed: string[] = [];
  const kept: string[] = [];
  for (const name of projectFolderNames(system, projects, slug, platform)) {
    if (existing.includes(name)) continue;
    const folder = join(projects, name);
    const entries = system.lstat(folder)?.isDirectory()
      ? system.readdir(folder).map((entry) => join(folder, entry))
      : [];
    const empty = (entry: string) => system.lstat(entry)?.isDirectory() && !system.readdir(entry).length;
    if (!system.lstat(folder)?.isDirectory() || !entries.every(empty)) {
      kept.push(folder);
      continue;
    }
    for (const entry of entries) system.rmdir(entry);
    system.rmdir(folder);
    removed.push(folder);
  }
  return { removed, kept };
}
