import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { canonicalToolPath } from './toolownership';
import { sessionHookEnvironment, sessionSkillRelease } from './bundledtools';

export interface SessionSkillRelease {
  readonly contentId: string;
  readonly directory: string;
  readonly claudePlugin: string;
  readonly claudeHooksPlugin?: string;
  readonly codexRoot: string;
  readonly claudeDefinition: string;
  readonly codexDefinition: string;
}

export interface SessionSkillSelection {
  current(): SessionSkillRelease | undefined;
  admitted?(): boolean;
  // Receives each refusal that withholds part of Arc's session tools from a child.
  // A Claude child sends at most one record at launch and one while running. A Codex child sends each distinct
  // reason and failed check once until Arc admits its skill again.
  withheld?(record: SessionComponentsWithheld): void;
}

export type SessionComponent = 'skill' | 'hooks';

// `launch` records the check before Arc starts the child. `running` records a later check by the running child.
// `error` is Arc's own text. Provider replies supply only `method` and `code`, never their message.
export interface SessionComponentsWithheld {
  provider: 'claude' | 'codex';
  stage: 'launch' | 'running';
  withheld: Partial<Record<SessionComponent, string>>;
  error?: string;
  // The settings or plugin catalog check that refused.
  check?: string;
  // The provider request that failed, and its JSON-RPC error code.
  method?: string;
  code?: number | string;
  cwd?: string;
}

export const SESSION_COMPONENTS_WITHHELD = 'sessionComponentsWithheld';

// Writes withheld session tools to the diagnostics log even when detailed logging is off.
// The write runs after the current launch step, in the order the records arrive.
export function sessionComponentsDiagnostics(
  log: { warn(event: string, record: Record<string, unknown>): void },
  defer: (write: () => void) => void = (write) => void setImmediate(write),
): (record: SessionComponentsWithheld) => void {
  const pending: SessionComponentsWithheld[] = [];
  return (record) => {
    pending.push(record);
    if (pending.length > 1) return;
    defer(() => {
      for (const next of pending.splice(0))
        try {
          log.warn(SESSION_COMPONENTS_WITHHELD, { ...next });
        } catch {
          // A failed diagnostics write drops its line.
        }
    });
  };
}

// Drops components without a reason and fields without a value. A failed diagnostics write never changes the launch.
export function reportWithheld(
  sink: ((record: SessionComponentsWithheld) => void) | undefined,
  record: Omit<SessionComponentsWithheld, 'withheld'> & {
    withheld: Partial<Record<SessionComponent, string | false | undefined>>;
  },
): void {
  const withheld: Partial<Record<SessionComponent, string>> = {};
  for (const component of ['skill', 'hooks'] as const) {
    const reason = record.withheld[component];
    if (reason) withheld[component] = reason;
  }
  if (!sink || !Object.keys(withheld).length) return;
  const fields = Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && value !== ''));
  try {
    sink({ ...(fields as Omit<SessionComponentsWithheld, 'withheld'>), withheld });
  } catch {
    // Diagnostics never interrupt a launch.
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function retainedSessionSkill(release: SessionSkillRelease, selection: SessionSkillSelection): boolean {
  try {
    return (
      (selection.admitted?.() ?? !!selection.current()) &&
      JSON.stringify(sessionSkillRelease(release.directory)) === JSON.stringify(release)
    );
  } catch {
    return false;
  }
}

export interface ClaudeSkillInputs {
  cwd: string;
  home: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  release: SessionSkillRelease;
  platform?: NodeJS.Platform;
  // `limit` is the largest file in bytes that the read returns. A larger file throws.
  read?(file: string, limit?: number): string | undefined;
  list?(directory: string): string[];
  canonical?(file: string): string;
}

export function skillObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// A missing entry, or a path that runs through a regular file, reads as absent.
const absent = new Set(['ENOENT', 'ENOTDIR']);

export function readSessionSkillInput(file: string, limit = 128 * 1024): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    if (!fs.fstatSync(fd).isFile()) throw new Error(`A session skill input is not a file: ${file}`);
    const buffer = Buffer.alloc(limit + 1);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (count === buffer.length) throw new Error(`A session skill input exceeds its read limit: ${file}`);
    return buffer.subarray(0, count).toString('utf8');
  } catch (error) {
    if (absent.has((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// A path that runs through a regular file is canonical below the file's canonical path, like a missing path.
// On Linux and macOS the platform reports such a path as ENOTDIR, which `canonicalToolPath` does not walk past.
export function canonicalSessionSkillInput(file: string, platform = process.platform): string {
  try {
    return canonicalToolPath(file, platform);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error;
    const parent = path.dirname(path.resolve(file));
    if (parent === path.resolve(file)) throw error;
    const joined = path.join(canonicalSessionSkillInput(parent, platform), path.basename(file));
    return platform === 'win32' ? joined.toLowerCase() : joined;
  }
}

export function listSessionSkillInput(directory: string): string[] {
  try {
    const names = fs.readdirSync(directory);
    if (names.length > 256) throw new Error(`A session skill input exceeds its directory limit: ${directory}`);
    return names;
  } catch (error) {
    if (absent.has((error as NodeJS.ErrnoException).code ?? '')) return [];
    throw error;
  }
}

const redirectedEnvironment = new Set([
  'PATH',
  'PATHEXT',
  'NODE_OPTIONS',
  'NODE_PATH',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_PLUGIN_CACHE_DIR',
  'CLAUDE_CODE_PLUGIN_DIRS',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_PARENT_MANAGED_SETTINGS',
]);

// Native effective settings supply precedence. Raw personal tiers retain explicit refusals.
export function claudeSkillSettings(
  value: unknown,
  component: 'skill' | 'hooks' = 'skill',
  platform = process.platform,
): boolean {
  return claudeSkillSettingsRefusal(value, component, platform) === undefined;
}

// Names the first settings check that refuses the component, or returns nothing when every check admits it.
export function claudeSkillSettingsRefusal(
  value: unknown,
  component: 'skill' | 'hooks' = 'skill',
  platform = process.platform,
): string | undefined {
  if (!skillObject(value)) return 'malformed-settings';
  if (value.disableSideloadFlags !== undefined && value.disableSideloadFlags !== false) return 'sideload-restriction';
  for (const key of ['strictKnownMarketplaces', 'pluginTrustMessage', 'enabledPluginsFromClaudeAi'])
    if (value[key] !== undefined) return 'marketplace-restriction';
  if (value.extraKnownMarketplaces !== undefined) {
    if (!skillObject(value.extraKnownMarketplaces)) return 'malformed-marketplace';
    for (const marketplace of Object.values(value.extraKnownMarketplaces))
      if (
        !skillObject(marketplace) ||
        !skillObject(marketplace.source) ||
        !['github', 'git', 'url', 'directory'].includes(String(marketplace.source.source))
      )
        return 'malformed-marketplace';
  }
  if (
    value.env !== undefined &&
    (!skillObject(value.env) || Object.keys(value.env).some((key) => redirectedEnvironment.has(key.toUpperCase())))
  )
    return 'redirected-environment';
  if (value.enabledPlugins !== undefined) {
    if (!skillObject(value.enabledPlugins)) return 'malformed-plugin-entry';
    for (const [id, enabled] of Object.entries(value.enabledPlugins)) {
      if (typeof enabled !== 'boolean') return 'malformed-plugin-entry';
      if (id.split('@')[0] === (component === 'skill' ? 'arc-session-tools' : 'arc-hooks')) return 'arc-plugin-entry';
    }
  }
  if (component === 'hooks') {
    if (
      value.env !== undefined &&
      (!skillObject(value.env) ||
        Object.values(value.env).some((entry) => typeof entry !== 'string') ||
        !sessionHookEnvironment(value.env as NodeJS.ProcessEnv, platform))
    )
      return 'unsupported-hook-environment';
    for (const key of ['disableAllHooks', 'allowManagedHooksOnly'])
      if (value[key] !== undefined && value[key] !== false) return 'hooks-disabled';
    if (value.hooks !== undefined && !claudeHookDeclarations(value.hooks)) return 'conflicting-hook-declaration';
  }
  return undefined;
}

export function claudeNativeSkillSettings(
  value: unknown,
  component: 'skill' | 'hooks' = 'skill',
  platform = process.platform,
): boolean {
  return claudeNativeSkillSettingsRefusal(value, component, platform) === undefined;
}

// Names the refusing check with the settings layer that failed it, such as `userSettings:hooks-disabled`.
export function claudeNativeSkillSettingsRefusal(
  value: unknown,
  component: 'skill' | 'hooks' = 'skill',
  platform = process.platform,
): string | undefined {
  if (!skillObject(value) || !Array.isArray(value.sources) || !skillObject(value.applied)) return 'malformed-settings';
  const effective = claudeSkillSettingsRefusal(value.effective, component, platform);
  if (effective) return `effective:${effective}`;
  for (const source of value.sources) {
    if (
      !skillObject(source) ||
      !['userSettings', 'projectSettings', 'localSettings', 'flagSettings'].includes(String(source.source))
    )
      return 'unsupported-settings-layer';
    const refusal = claudeSkillSettingsRefusal(source.settings, component, platform);
    if (refusal) return `${String(source.source)}:${refusal}`;
  }
  return undefined;
}

// One existing capture command suppresses the complete automatic pair, including shell aliases.
function claudeHookDeclarations(value: unknown): boolean {
  if (!skillObject(value)) return false;
  for (const groups of Object.values(value)) {
    if (!Array.isArray(groups)) return false;
    for (const group of groups) {
      if (
        !skillObject(group) ||
        !Array.isArray(group.hooks) ||
        (group.matcher !== undefined && typeof group.matcher !== 'string')
      )
        return false;
      for (const hook of group.hooks) {
        if (!skillObject(hook) || !['command', 'prompt', 'agent'].includes(String(hook.type))) return false;
        if (hook.type === 'command') {
          if (
            typeof hook.command !== 'string' ||
            !hook.command.trim() ||
            (hook.args !== undefined && (!Array.isArray(hook.args) || hook.args.some((arg) => typeof arg !== 'string')))
          )
            return false;
          if (
            /pretooluse-snapshot|stop-manifest|session-start/i.test(
              [hook.command, ...((hook.args as string[]) ?? [])].join(' '),
            )
          )
            return false;
        } else if (typeof hook.prompt !== 'string') return false;
      }
    }
  }
  return true;
}

export interface ClaudeSessionComponents {
  skill: boolean;
  hooks: boolean;
  reasons: { skill: string; hooks: string; configuration: 'admitted' | 'uncertain' };
  // The failed check behind an `uncertain-configuration` result.
  error?: string;
  // The check behind each component's reason, from the refusal that set that reason: a settings check as
  // `<source>:<check>`, or a plugin catalog check as `<catalog file>:<plugin id>`. A refusal without a check has none.
  checks?: Partial<Record<SessionComponent, string>>;
}

// A plugin's entry in its marketplace catalog. `file` names the catalog, or the marketplace list when Arc cannot
// locate the catalog. `entry` is absent when the catalog is unreadable or does not list the plugin exactly once.
interface CatalogEntry {
  file: string;
  entry?: Record<string, unknown>;
}

export function claudeSkillHome(env: NodeJS.ProcessEnv, cwd: string): string {
  return path.resolve(cwd, env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
}

// These reads accept matching manual links. Installation write admission remains stricter.
export function admitClaudeSessionSkill(input: ClaudeSkillInputs): boolean {
  return admitClaudeSessionComponents(input).skill;
}

export function admitClaudeSessionComponents(input: ClaudeSkillInputs, hooks = true): ClaudeSessionComponents {
  const result: ClaudeSessionComponents = {
    skill: true,
    hooks,
    reasons: { skill: 'eligible', hooks: 'eligible', configuration: 'admitted' },
  };
  const refused: ClaudeSessionComponents = {
    skill: false,
    hooks: false,
    reasons: { skill: 'uncertain-configuration', hooks: 'uncertain-configuration', configuration: 'uncertain' },
  };
  const refuse = (component: 'skill' | 'hooks', reason: string, check?: string) => {
    result[component] = false;
    result.reasons[component] = reason;
    if (check) result.checks = { ...result.checks, [component]: check };
    else delete result.checks?.[component];
  };
  // Every uncertain result carries the check that failed, so the diagnostics log can name it.
  const uncertain = (detail: string): never => {
    throw new Error(detail);
  };
  try {
    if (input.args.length > 256 || Buffer.byteLength(input.args.join('\0')) > 128 * 1024)
      return uncertain('The Claude launch arguments exceed their size limit.');
    const platform = input.platform ?? process.platform;
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const canonical = input.canonical ?? ((file: string) => canonicalSessionSkillInput(file, platform));
    let bytes = 0;
    let catalogBytes = 0;
    let reads = 0;
    // Marketplace catalogs have their own budget. The official Claude catalog lists 315 plugins in about 190 KB, so one
    // catalog may hold 1 MiB and all catalogs together 4 MiB. Catalog bytes leave the budget of the other inputs intact.
    const text = (file: string, catalog = false) => {
      if (++reads > 512) throw new Error(`Session skill inputs exceed their read limit at ${file}.`);
      const limit = catalog ? 1024 * 1024 : 128 * 1024;
      const value = (input.read ?? readSessionSkillInput)(file, limit);
      if (value !== undefined) {
        const size = Buffer.byteLength(value);
        if (catalog) catalogBytes += size;
        else bytes += size;
        if (catalog ? size > limit || catalogBytes > 4 * 1024 * 1024 : size > limit || bytes > 2 * 1024 * 1024)
          throw new Error(`Session skill inputs exceed their byte limit at ${file}.`);
      }
      return value;
    };
    // The parser's message can quote settings content, so the record names only the source.
    const parsed = (value: string, source: string): unknown => {
      try {
        return JSON.parse(value);
      } catch {
        return uncertain(`${source} is not readable JSON.`);
      }
    };
    const json = (file: string): unknown => {
      const value = text(file);
      return value === undefined ? undefined : parsed(value, file);
    };
    const names = (directory: string) => {
      const entries = (input.list ?? listSessionSkillInput)(directory);
      if (entries.length > 256) throw new Error(`Session skill inputs exceed their directory limit at ${directory}.`);
      return entries;
    };
    // The children of a folder whose names equal `name` in any letter case, on every platform.
    const named = (directory: string, name: string) =>
      names(directory)
        .filter((child) => child.toLowerCase() === name)
        .map((child) => paths.join(directory, child));
    // Arc reads each marketplace catalog at most once per check. The parser's message can quote catalog content, so a
    // failure names only the file.
    const catalogs = new Map<string, unknown[] | Error>();
    const catalogPlugins = (file: string): unknown[] => {
      let plugins = catalogs.get(file);
      if (!plugins) {
        try {
          const value = text(file, true);
          const catalog: unknown = value === undefined ? undefined : JSON.parse(value);
          plugins =
            skillObject(catalog) && Array.isArray(catalog.plugins)
              ? catalog.plugins
              : new Error(`${file} has no readable plugin list.`);
        } catch {
          plugins = new Error(`${file} has no readable plugin list.`);
        }
        catalogs.set(file, plugins);
      }
      if (plugins instanceof Error) throw plugins;
      return plugins;
    };
    const contains = (root: string, file: string) => {
      const relative = paths.relative(canonical(root), canonical(file));
      return (
        relative === '' || (!relative.startsWith('..' + paths.sep) && relative !== '..' && !paths.isAbsolute(relative))
      );
    };
    for (const [key, value] of Object.entries(input.env))
      if (value && key.toUpperCase().startsWith('CLAUDE_') && /PLUGIN|MANAGED|BARE|ISOLAT|SAFE/.test(key.toUpperCase()))
        return uncertain(`The environment variable ${key} changes how Claude loads plugins or settings.`);
    const settings: { source: string; value: unknown }[] = [];
    for (let index = 0; index < input.args.length; index++) {
      const argument = input.args[index];
      const [flag, inline] = argument.split(/=(.*)/s);
      if (flag === '--disable-slash-commands') refuse('skill', 'slash-commands-disabled');
      if (/^--(?:plugin|bare|safe|isolat|setting-sources|settings-sources|managed|config)/.test(flag))
        return uncertain(`The launch argument ${flag} changes how Claude loads plugins or settings.`);
      if (flag === '--settings') {
        const value = inline ?? input.args[++index];
        if (!value) return uncertain('The --settings launch argument has no value.');
        const inlineSettings = value.trim().startsWith('{');
        const source = inlineSettings ? '--settings' : paths.resolve(input.cwd, value);
        const supplied = inlineSettings ? parsed(value, 'The --settings launch argument') : json(source);
        if (supplied === undefined) return uncertain(`The --settings file ${source} is missing.`);
        settings.push({ source, value: supplied });
      }
    }
    const managed =
      platform === 'win32'
        ? 'C:/Program Files/ClaudeCode'
        : platform === 'darwin'
          ? '/Library/Application Support/ClaudeCode'
          : '/etc/claude-code';
    for (const file of ['managed-settings.json', 'managed-mcp.json'])
      if (text(paths.join(managed, file)) !== undefined)
        return uncertain(`Managed settings exist at ${paths.join(managed, file)}.`);
    if (names(managed).some((name) => (platform === 'win32' ? name.toLowerCase() : name) === 'managed-settings.d'))
      return uncertain(`Managed settings exist at ${paths.join(managed, 'managed-settings.d')}.`);
    const folders = new Set<string>([input.home]);
    const addProjects = (start: string) => {
      for (let folder = start; ; folder = paths.dirname(folder)) {
        folders.add(paths.join(folder, '.claude'));
        if (paths.dirname(folder) === folder) break;
      }
    };
    addProjects(input.cwd);
    for (let folder = input.cwd; ; folder = paths.dirname(folder)) {
      const gitPath = paths.join(folder, '.git');
      const git =
        !input.read && fs.statSync(gitPath, { throwIfNoEntry: false })?.isDirectory() ? undefined : text(gitPath);
      if (git !== undefined) {
        const match = /^gitdir: (.+)\s*$/.exec(git);
        if (!match) return uncertain(`${gitPath} does not name a Git directory.`);
        const directory = paths.resolve(folder, match[1].trim());
        const common = text(paths.join(directory, 'commondir'));
        if (common !== undefined) addProjects(paths.dirname(paths.resolve(directory, common.trim())));
      }
      if (paths.dirname(folder) === folder) break;
    }
    const definition = (file: string, check?: string) => {
      canonical(file);
      if (text(file) !== undefined) refuse('skill', 'native-definition', check);
    };
    const hookFile = (root: string, file: string) => {
      if (paths.isAbsolute(file)) throw new Error('A plugin hook path is outside its directory.');
      const target = paths.resolve(root, file);
      if (!contains(root, target)) throw new Error('A plugin hook path is outside its directory.');
      const value = json(target);
      if (value === undefined || !skillObject(value) || !claudeHookDeclarations(value.hooks))
        throw new Error('A plugin hook declaration is unreadable.');
    };
    // Throws when the default hook file is outside the plugin. The caller withholds the hooks.
    const defaultHooks = (root: string, check?: string) => {
      if (!contains(root, paths.join(root, 'hooks', 'hooks.json')))
        throw new Error('A plugin hook path is outside its directory.');
      const value = json(paths.join(root, 'hooks', 'hooks.json'));
      if (value !== undefined && (!skillObject(value) || !claudeHookDeclarations(value.hooks)))
        refuse('hooks', 'conflicting-or-unreadable-declaration', check);
    };
    // Claude reads the catalog entry as the manifest of a plugin without `.claude-plugin/plugin.json`. The registry
    // name is the plugin name, and entry component paths resolve against the plugin root. Each refusal names the
    // catalog file and the plugin.
    const catalogPlugin = (root: string, id: string, catalog: CatalogEntry) => {
      const check = `${catalog.file}:${id}`;
      const entry = catalog.entry;
      if (!entry) {
        refuse('skill', 'unreadable-plugin-catalog', check);
        if (hooks) refuse('hooks', 'unreadable-plugin-catalog', check);
        return;
      }
      const name = id.split('@')[0];
      if (name === 'arc-session-tools') refuse('skill', 'native-plugin', check);
      if (name === 'arc-hooks') refuse('hooks', 'native-plugin', check);
      // Arc lists each folder it checks, so a skill or command name matches in any letter case on every platform.
      const skillFolder = (folder: string) => {
        for (const skill of named(folder, 'arc-sessions')) definition(paths.join(skill, 'SKILL.md'), check);
      };
      const commandFolder = (folder: string) => {
        for (const command of named(folder, 'arc-sessions.md')) definition(command, check);
      };
      skillFolder(paths.join(root, 'skills'));
      commandFolder(paths.join(root, 'commands'));
      const inside = (value: unknown) => {
        if (typeof value !== 'string' || !value || paths.isAbsolute(value)) return undefined;
        const target = paths.resolve(root, value);
        return contains(root, target) ? target : undefined;
      };
      const each = (value: unknown) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
      // A skills path holds `<name>/SKILL.md` folders or is one skill folder. Its folder name is the skill name.
      for (const value of each(entry.skills)) {
        const folder = inside(value);
        if (!folder) refuse('skill', 'unclassified-component-path', check);
        else {
          skillFolder(folder);
          if (paths.basename(folder).toLowerCase() === 'arc-sessions')
            definition(paths.join(folder, 'SKILL.md'), check);
        }
      }
      // A commands object maps command names to definitions. A commands path names a Markdown file or a folder of them.
      if (skillObject(entry.commands)) {
        if (Object.keys(entry.commands).some((command) => command.toLowerCase() === 'arc-sessions'))
          refuse('skill', 'native-definition', check);
      } else
        for (const value of each(entry.commands)) {
          const target = inside(value);
          if (!target) refuse('skill', 'unclassified-component-path', check);
          else if (!/\.md$/i.test(target)) commandFolder(target);
          else if (paths.basename(target).toLowerCase() === 'arc-sessions.md') definition(target, check);
        }
      if (!hooks) return;
      try {
        defaultHooks(root, check);
      } catch {
        refuse('hooks', 'conflicting-or-unreadable-declaration', check);
      }
      // Claude runs entry hooks only as an inline event map with no `hooks` wrapper. It reports a hook file path or an
      // array as an error.
      if (entry.hooks !== undefined && !claudeHookDeclarations(entry.hooks))
        refuse('hooks', 'conflicting-or-unreadable-declaration', check);
    };
    const manifest = (root: string, id?: string, catalog?: () => CatalogEntry) => {
      const file = paths.join(root, '.claude-plugin', 'plugin.json');
      const value = json(file);
      if (value === undefined && id && catalog) return catalogPlugin(root, id, catalog());
      const name = id?.split('@')[0];
      if (!skillObject(value) || typeof value.name !== 'string' || !value.name)
        throw new Error(`A plugin identity is unreadable: ${file}`);
      if (value.name === 'arc-session-tools') refuse('skill', 'native-plugin');
      if (value.name === 'arc-hooks') refuse('hooks', 'native-plugin');
      if (name && value.name !== name)
        throw new Error(`A plugin identity does not match its registration ${name}: ${file}`);
      definition(paths.join(root, 'skills', 'arc-sessions', 'SKILL.md'));
      definition(paths.join(root, 'commands', 'arc-sessions.md'));
      if (value.skills !== undefined || value.commands !== undefined) refuse('skill', 'unclassified-component-path');
      if (!hooks) return;
      try {
        defaultHooks(root);
        if (value.hooks !== undefined) {
          if (typeof value.hooks === 'string') hookFile(root, value.hooks);
          else if (Array.isArray(value.hooks)) {
            if (!value.hooks.length) refuse('hooks', 'conflicting-or-unreadable-declaration');
            for (const file of value.hooks) {
              if (typeof file !== 'string') throw new Error('A plugin hook path is unreadable.');
              hookFile(root, file);
            }
          } else if (!skillObject(value.hooks) || !claudeHookDeclarations(value.hooks.hooks ?? value.hooks))
            refuse('hooks', 'conflicting-or-unreadable-declaration');
        }
      } catch {
        refuse('hooks', 'conflicting-or-unreadable-declaration');
      }
    };
    const settingsFile = (file: string) => settings.push({ source: file, value: json(file) });
    for (const folder of folders) {
      settingsFile(paths.join(folder, 'settings.json'));
      if (folder !== input.home) settingsFile(paths.join(folder, 'settings.local.json'));
      definition(paths.join(folder, 'skills', 'arc-sessions', 'SKILL.md'));
      definition(paths.join(folder, 'commands', 'arc-sessions.md'));
      for (const name of names(paths.join(folder, 'skills'))) {
        const root = paths.join(folder, 'skills', name);
        if (json(paths.join(root, '.claude-plugin', 'plugin.json')) !== undefined) manifest(root);
      }
    }
    for (const { source, value } of settings) {
      if (value === undefined) continue;
      if (!skillObject(value)) return uncertain(`The settings in ${source} are not an object.`);
      const skillRefusal = claudeSkillSettingsRefusal(value);
      if (skillRefusal) refuse('skill', 'settings-refusal', `${source}:${skillRefusal}`);
      const hooksRefusal = hooks ? claudeSkillSettingsRefusal(value, 'hooks', platform) : undefined;
      if (hooksRefusal) refuse('hooks', 'settings-refusal', `${source}:${hooksRefusal}`);
    }
    const cloudFile = paths.join(input.home, 'plugins', 'known_marketplaces_claudeai.json');
    const cloud = json(cloudFile);
    if (cloud !== undefined && (!skillObject(cloud) || Object.keys(cloud).length))
      return uncertain(`${cloudFile} lists Claude marketplaces Arc cannot check.`);
    const knownFile = paths.join(input.home, 'plugins', 'known_marketplaces.json');
    const known = json(knownFile);
    if (known !== undefined && !skillObject(known)) return uncertain(`${knownFile} is not an object.`);
    const registryFile = paths.join(input.home, 'plugins', 'installed_plugins.json');
    const registry = json(registryFile);
    if (registry === undefined) return result;
    if (!skillObject(registry) || registry.version !== 2 || !skillObject(registry.plugins))
      return uncertain(`${registryFile} is not a version 2 plugin registry.`);
    for (const [id, installs] of Object.entries(registry.plugins)) {
      const installation = `The installation of plugin ${id} in ${registryFile}`;
      if (!Array.isArray(installs) || !installs.length || id.split('@').length !== 2)
        return uncertain(`${installation} is unreadable.`);
      const scopes = new Set<string>();
      for (const entry of installs) {
        if (
          !skillObject(entry) ||
          typeof entry.scope !== 'string' ||
          !['user', 'project', 'local'].includes(entry.scope) ||
          typeof entry.version !== 'string' ||
          typeof entry.installPath !== 'string' ||
          !paths.isAbsolute(entry.installPath)
        )
          return uncertain(`${installation} is unreadable.`);
        const scopeKey = JSON.stringify([entry.scope, entry.projectPath]);
        if (scopes.has(scopeKey)) return uncertain(`${installation} repeats a scope.`);
        scopes.add(scopeKey);
        if (entry.scope !== 'user') {
          if (typeof entry.projectPath !== 'string' || !paths.isAbsolute(entry.projectPath))
            return uncertain(`${installation} has an unreadable project path.`);
          if (!contains(entry.projectPath, input.cwd)) continue;
        }
        const marketplace = skillObject(known) ? known[id.split('@')[1]] : undefined;
        if (!skillObject(marketplace) || !skillObject(marketplace.source))
          return uncertain(`The marketplace of plugin ${id} is missing from ${knownFile}.`);
        const source = marketplace.source;
        const name = id.split('@')[0];
        let root = entry.installPath;
        // A cloned marketplace keeps its catalog at its install location, at the source's `path` when one is set.
        let pluginCatalog = (): CatalogEntry => {
          const location = marketplace.installLocation;
          const relative = source.path ?? paths.join('.claude-plugin', 'marketplace.json');
          if (typeof location !== 'string' || !paths.isAbsolute(location) || typeof relative !== 'string')
            return { file: knownFile };
          const file = paths.resolve(location, relative);
          if (!contains(location, file)) return { file: knownFile };
          let plugins: unknown[];
          try {
            plugins = catalogPlugins(file);
          } catch {
            return { file };
          }
          const matches = plugins.filter((plugin) => skillObject(plugin) && plugin.name === name);
          return { file, entry: matches.length === 1 && skillObject(matches[0]) ? matches[0] : undefined };
        };
        if (source.source === 'directory') {
          if (typeof source.path !== 'string' || !paths.isAbsolute(source.path))
            return uncertain(`The marketplace of plugin ${id} has an unreadable directory.`);
          const catalogFile = paths.join(source.path, '.claude-plugin', 'marketplace.json');
          // Arc finds the plugin root through this catalog, so a catalog failure leaves every plugin from it uncertain.
          const matches = catalogPlugins(catalogFile).filter(
            (plugin) => skillObject(plugin) && plugin.name === id.split('@')[0],
          );
          if (
            matches.length !== 1 ||
            !skillObject(matches[0]) ||
            typeof matches[0].source !== 'string' ||
            paths.isAbsolute(matches[0].source)
          )
            return uncertain(`${catalogFile} does not list plugin ${id} once with a relative source.`);
          root = paths.resolve(source.path, matches[0].source);
          if (!contains(source.path, root))
            return uncertain(`The source of plugin ${id} is outside its marketplace directory.`);
          const listed = matches[0];
          pluginCatalog = () => ({ file: catalogFile, entry: listed });
        } else if (source.source === 'git') {
          if (typeof source.url !== 'string' || !source.url)
            return uncertain(`The marketplace of plugin ${id} has no Git URL.`);
        } else if (source.source === 'github') {
          if (typeof source.repo !== 'string' || !source.repo)
            return uncertain(`The marketplace of plugin ${id} has no GitHub repository.`);
        } else return uncertain(`The marketplace of plugin ${id} has an unsupported source type.`);
        manifest(root, id, pluginCatalog);
      }
    }
    return result;
  } catch (error) {
    refused.error = errorText(error);
    return refused;
  }
}

export interface NativeSkill {
  name: string;
  path: string;
  scope: string;
  enabled: boolean;
  pluginId?: string | null;
  description: string;
}

export function codexRawSkills(value: unknown, cwd: string, platform = process.platform): NativeSkill[] {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (!skillObject(value) || !Array.isArray(value.data)) throw new Error('Codex returned an unreadable skill list.');
  const groups = value.data.filter((group) => skillObject(group) && group.cwd === cwd);
  if (groups.length !== 1) throw new Error('Codex returned no unique skill list for this folder.');
  const group = groups[0];
  if (!Array.isArray(group.errors) || group.errors.length || !Array.isArray(group.skills))
    throw new Error('Codex could not read its skill list.');
  for (const skill of group.skills)
    if (
      !skillObject(skill) ||
      typeof skill.name !== 'string' ||
      !skill.name ||
      typeof skill.path !== 'string' ||
      !paths.isAbsolute(skill.path) ||
      !['user', 'repo', 'system', 'admin'].includes(String(skill.scope)) ||
      typeof skill.enabled !== 'boolean' ||
      typeof skill.description !== 'string' ||
      (skill.pluginId !== undefined && skill.pluginId !== null && typeof skill.pluginId !== 'string')
    )
      throw new Error('Codex returned an incomplete skill definition.');
  return group.skills as NativeSkill[];
}

// Configured disabled definitions remain authoritative even outside the active discovery roots.
export function codexSkillConfiguration(
  value: unknown,
  requirements: unknown,
  release: SessionSkillRelease,
  input: { platform?: NodeJS.Platform; canonical?(file: string): string } = {},
): boolean {
  return codexSkillConfigurationRefusal(value, requirements, release, input) === undefined;
}

// Names the first configuration check that refuses the skill, or returns nothing when every check admits it.
export function codexSkillConfigurationRefusal(
  value: unknown,
  requirements: unknown,
  release: SessionSkillRelease,
  input: { platform?: NodeJS.Platform; canonical?(file: string): string } = {},
): string | undefined {
  class Refusal extends Error {
    constructor(readonly check: string) {
      super(check);
    }
  }
  try {
    const platform = input.platform ?? process.platform;
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const canonicalPath = input.canonical ?? ((file: string) => canonicalSessionSkillInput(file, platform));
    if (!skillObject(requirements)) return 'malformed-requirements';
    if (requirements.requirements !== null) return 'managed-requirements';
    if (
      !skillObject(value) ||
      !skillObject(value.config) ||
      !skillObject(value.origins) ||
      !Array.isArray(value.layers)
    )
      return 'malformed-configuration';
    const configured = (config: Record<string, unknown>) => {
      if (config.skills === undefined || config.skills === null) return [];
      if (!skillObject(config.skills) || !Array.isArray(config.skills.config))
        throw new Refusal('malformed-skill-entry');
      const entries = config.skills.config;
      const unique = new Set<string>();
      for (const entry of entries)
        if (
          !skillObject(entry) ||
          typeof entry.path !== 'string' ||
          !paths.isAbsolute(entry.path) ||
          typeof entry.enabled !== 'boolean'
        )
          throw new Refusal('malformed-skill-entry');
        else {
          const canonical = canonicalPath(entry.path);
          if (unique.has(canonical)) throw new Refusal('ambiguous-skill-entry');
          unique.add(canonical);
        }
      return entries as { path: string; enabled: boolean }[];
    };
    for (const layer of value.layers) {
      if (
        !skillObject(layer) ||
        !skillObject(layer.name) ||
        typeof layer.version !== 'string' ||
        !skillObject(layer.config)
      )
        return 'malformed-layer';
      if (layer.disabledReason) return 'disabled-layer';
      const type = layer.name.type;
      if (!['packagedDefaults', 'system', 'user', 'project', 'sessionFlags'].includes(String(type)))
        return 'unsupported-layer';
      if (type === 'system' && Object.keys(layer.config).length) return 'managed-layer';
      configured(layer.config);
    }
    const entries = configured(value.config);
    for (const origin of Object.values(value.origins))
      if (
        !skillObject(origin) ||
        !skillObject(origin.name) ||
        typeof origin.version !== 'string' ||
        !['packagedDefaults', 'system', 'user', 'project', 'sessionFlags'].includes(String(origin.name.type))
      )
        return 'unsupported-origin';
    const unique = new Set<string>();
    for (const entry of entries) {
      const canonical = canonicalPath(entry.path);
      if (unique.has(canonical)) return 'ambiguous-skill-entry';
      unique.add(canonical);
      if (entry.enabled) continue;
      if (canonical === canonicalPath(release.codexDefinition)) return 'disabled-skill';
      const definition = readSessionSkillInput(canonical);
      const header = definition && /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(definition)?.[1];
      const names = header ? [...header.matchAll(/^name:[ \t]*([a-zA-Z0-9][a-zA-Z0-9_-]*)[ \t]*\r?$/gm)] : [];
      if (names.length === 1 && names[0][1].toLowerCase() !== 'arc-sessions') continue;
      // A disabled path from a retained release must suppress later automatic releases too.
      const ancestor = path.resolve(path.dirname(canonical), '../..');
      const retained = sessionSkillRelease(ancestor);
      if (canonical === canonicalToolPath(retained.codexDefinition)) return 'disabled-skill';
      return 'disabled-skill';
    }
    return undefined;
  } catch (error) {
    return error instanceof Refusal ? error.check : 'unreadable-skill-entry';
  }
}
