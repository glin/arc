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
  read?(file: string): string | undefined;
  list?(directory: string): string[];
  canonical?(file: string): string;
}

export function skillObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function read(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    if (!fs.fstatSync(fd).isFile()) throw new Error('A session skill input is not a file.');
    const buffer = Buffer.alloc(128 * 1024 + 1);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (count === buffer.length) throw new Error('A session skill input exceeds its read limit.');
    return buffer.subarray(0, count).toString('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function list(directory: string): string[] {
  try {
    const names = fs.readdirSync(directory);
    if (names.length > 256) throw new Error('A session skill input exceeds its directory limit.');
    return names;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
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
  if (!skillObject(value)) return false;
  if (value.disableSideloadFlags !== undefined && value.disableSideloadFlags !== false) return false;
  for (const key of [
    'strictKnownMarketplaces',
    'extraKnownMarketplaces',
    'pluginTrustMessage',
    'enabledPluginsFromClaudeAi',
  ])
    if (value[key] !== undefined) return false;
  if (
    value.env !== undefined &&
    (!skillObject(value.env) || Object.keys(value.env).some((key) => redirectedEnvironment.has(key.toUpperCase())))
  )
    return false;
  if (value.enabledPlugins !== undefined) {
    if (!skillObject(value.enabledPlugins)) return false;
    for (const [id, enabled] of Object.entries(value.enabledPlugins)) {
      if (typeof enabled !== 'boolean') return false;
      if (id.split('@')[0] === (component === 'skill' ? 'arc-session-tools' : 'arc-hooks')) return false;
    }
  }
  if (component === 'hooks') {
    if (
      value.env !== undefined &&
      (!skillObject(value.env) ||
        Object.values(value.env).some((entry) => typeof entry !== 'string') ||
        !sessionHookEnvironment(value.env as NodeJS.ProcessEnv, platform))
    )
      return false;
    for (const key of ['disableAllHooks', 'allowManagedHooksOnly'])
      if (value[key] !== undefined && value[key] !== false) return false;
    if (value.hooks !== undefined && !claudeHookDeclarations(value.hooks)) return false;
  }
  return true;
}

export function claudeNativeSkillSettings(
  value: unknown,
  component: 'skill' | 'hooks' = 'skill',
  platform = process.platform,
): boolean {
  return (
    skillObject(value) &&
    claudeSkillSettings(value.effective, component, platform) &&
    Array.isArray(value.sources) &&
    skillObject(value.applied) &&
    value.sources.every(
      (source) =>
        skillObject(source) &&
        ['userSettings', 'projectSettings', 'localSettings', 'flagSettings'].includes(String(source.source)) &&
        claudeSkillSettings(source.settings, component, platform),
    )
  );
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
  const refuse = (component: 'skill' | 'hooks', reason: string) => {
    result[component] = false;
    result.reasons[component] = reason;
  };
  try {
    if (input.args.length > 256 || Buffer.byteLength(input.args.join('\0')) > 128 * 1024) return refused;
    const platform = input.platform ?? process.platform;
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const canonical = input.canonical ?? ((file: string) => canonicalToolPath(file, platform));
    let bytes = 0;
    let reads = 0;
    const text = (file: string) => {
      if (++reads > 512) throw new Error('Session skill inputs exceed their read limit.');
      const value = (input.read ?? read)(file);
      if (value !== undefined) {
        bytes += Buffer.byteLength(value);
        if (Buffer.byteLength(value) > 128 * 1024 || bytes > 2 * 1024 * 1024)
          throw new Error('Session skill inputs exceed their byte limit.');
      }
      return value;
    };
    const json = (file: string): unknown => {
      const value = text(file);
      return value === undefined ? undefined : JSON.parse(value);
    };
    const names = (directory: string) => {
      const entries = (input.list ?? list)(directory);
      if (entries.length > 256) throw new Error('Session skill inputs exceed their directory limit.');
      return entries;
    };
    const contains = (root: string, file: string) => {
      const relative = paths.relative(canonical(root), canonical(file));
      return (
        relative === '' || (!relative.startsWith('..' + paths.sep) && relative !== '..' && !paths.isAbsolute(relative))
      );
    };
    for (const [key, value] of Object.entries(input.env))
      if (value && key.toUpperCase().startsWith('CLAUDE_') && /PLUGIN|MANAGED|BARE|ISOLAT|SAFE/.test(key.toUpperCase()))
        return refused;
    const settings: unknown[] = [];
    for (let index = 0; index < input.args.length; index++) {
      const argument = input.args[index];
      const [flag, inline] = argument.split(/=(.*)/s);
      if (flag === '--disable-slash-commands') refuse('skill', 'slash-commands-disabled');
      if (/^--(?:plugin|bare|safe|isolat|setting-sources|settings-sources|managed|config)/.test(flag)) return refused;
      if (flag === '--settings') {
        const value = inline ?? input.args[++index];
        if (!value) return refused;
        const supplied = value.trim().startsWith('{') ? JSON.parse(value) : json(paths.resolve(input.cwd, value));
        if (supplied === undefined) return refused;
        settings.push(supplied);
      }
    }
    const managed =
      platform === 'win32'
        ? 'C:/Program Files/ClaudeCode'
        : platform === 'darwin'
          ? '/Library/Application Support/ClaudeCode'
          : '/etc/claude-code';
    for (const file of ['managed-settings.json', 'managed-mcp.json'])
      if (text(paths.join(managed, file)) !== undefined) return refused;
    if (names(managed).some((name) => (platform === 'win32' ? name.toLowerCase() : name) === 'managed-settings.d'))
      return refused;
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
        if (!match) return refused;
        const directory = paths.resolve(folder, match[1].trim());
        const common = text(paths.join(directory, 'commondir'));
        if (common !== undefined) addProjects(paths.dirname(paths.resolve(directory, common.trim())));
      }
      if (paths.dirname(folder) === folder) break;
    }
    const definition = (file: string) => {
      canonical(file);
      if (text(file) !== undefined) refuse('skill', 'native-definition');
    };
    const hookFile = (root: string, file: string) => {
      if (paths.isAbsolute(file)) throw new Error('A plugin hook path is outside its directory.');
      const target = paths.resolve(root, file);
      if (!contains(root, target)) throw new Error('A plugin hook path is outside its directory.');
      const value = json(target);
      if (value === undefined || !skillObject(value) || !claudeHookDeclarations(value.hooks))
        throw new Error('A plugin hook declaration is unreadable.');
    };
    const manifest = (root: string, name?: string) => {
      const value = json(paths.join(root, '.claude-plugin', 'plugin.json'));
      if (!skillObject(value) || typeof value.name !== 'string' || !value.name)
        throw new Error('A plugin identity is unreadable.');
      if (value.name === 'arc-session-tools') refuse('skill', 'native-plugin');
      if (value.name === 'arc-hooks') refuse('hooks', 'native-plugin');
      if (name && value.name !== name) throw new Error('A plugin identity does not match its registration.');
      definition(paths.join(root, 'skills', 'arc-sessions', 'SKILL.md'));
      definition(paths.join(root, 'commands', 'arc-sessions.md'));
      if (value.skills !== undefined || value.commands !== undefined) refuse('skill', 'unclassified-component-path');
      if (!hooks) return;
      try {
        if (!contains(root, paths.join(root, 'hooks', 'hooks.json')))
          throw new Error('A plugin hook path is outside its directory.');
        const defaultHooks = json(paths.join(root, 'hooks', 'hooks.json'));
        if (defaultHooks !== undefined && (!skillObject(defaultHooks) || !claudeHookDeclarations(defaultHooks.hooks)))
          refuse('hooks', 'conflicting-or-unreadable-declaration');
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
    for (const folder of folders) {
      settings.push(json(paths.join(folder, 'settings.json')));
      if (folder !== input.home) settings.push(json(paths.join(folder, 'settings.local.json')));
      definition(paths.join(folder, 'skills', 'arc-sessions', 'SKILL.md'));
      definition(paths.join(folder, 'commands', 'arc-sessions.md'));
      for (const name of names(paths.join(folder, 'skills'))) {
        const root = paths.join(folder, 'skills', name);
        if (json(paths.join(root, '.claude-plugin', 'plugin.json')) !== undefined) manifest(root);
      }
    }
    for (const value of settings) {
      if (value === undefined) continue;
      if (!skillObject(value)) return refused;
      if (!claudeSkillSettings(value)) refuse('skill', 'settings-refusal');
      if (hooks && !claudeSkillSettings(value, 'hooks', platform)) refuse('hooks', 'settings-refusal');
    }
    const cloud = json(paths.join(input.home, 'plugins', 'known_marketplaces_claudeai.json'));
    if (cloud !== undefined && (!skillObject(cloud) || Object.keys(cloud).length)) return refused;
    const known = json(paths.join(input.home, 'plugins', 'known_marketplaces.json'));
    if (known !== undefined && !skillObject(known)) return refused;
    const registry = json(paths.join(input.home, 'plugins', 'installed_plugins.json'));
    if (registry === undefined) return result;
    if (!skillObject(registry) || registry.version !== 2 || !skillObject(registry.plugins)) return refused;
    for (const [id, installs] of Object.entries(registry.plugins)) {
      if (!Array.isArray(installs) || !installs.length || id.split('@').length !== 2) return refused;
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
          return refused;
        const scopeKey = JSON.stringify([entry.scope, entry.projectPath]);
        if (scopes.has(scopeKey)) return refused;
        scopes.add(scopeKey);
        if (entry.scope !== 'user') {
          if (typeof entry.projectPath !== 'string' || !paths.isAbsolute(entry.projectPath)) return refused;
          if (!contains(entry.projectPath, input.cwd)) continue;
        }
        const marketplace = skillObject(known) ? known[id.split('@')[1]] : undefined;
        if (!skillObject(marketplace) || !skillObject(marketplace.source)) return refused;
        const source = marketplace.source;
        let root = entry.installPath;
        if (source.source === 'directory') {
          if (typeof source.path !== 'string' || !paths.isAbsolute(source.path)) return refused;
          const catalog = json(paths.join(source.path, '.claude-plugin', 'marketplace.json'));
          if (!skillObject(catalog) || !Array.isArray(catalog.plugins)) return refused;
          const matches = catalog.plugins.filter((plugin) => skillObject(plugin) && plugin.name === id.split('@')[0]);
          if (
            matches.length !== 1 ||
            !skillObject(matches[0]) ||
            typeof matches[0].source !== 'string' ||
            paths.isAbsolute(matches[0].source)
          )
            return refused;
          root = paths.resolve(source.path, matches[0].source);
          if (!contains(source.path, root)) return refused;
        } else if (source.source === 'git') {
          if (typeof source.url !== 'string' || !source.url) return refused;
        } else if (source.source === 'github') {
          if (typeof source.repo !== 'string' || !source.repo) return refused;
        } else return refused;
        manifest(root, id.split('@')[0]);
      }
    }
    return result;
  } catch {
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
  try {
    const platform = input.platform ?? process.platform;
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const canonicalPath = input.canonical ?? ((file: string) => canonicalToolPath(file, platform));
    if (
      !skillObject(requirements) ||
      requirements.requirements !== null ||
      !skillObject(value) ||
      !skillObject(value.config) ||
      !skillObject(value.origins) ||
      !Array.isArray(value.layers)
    )
      return false;
    const configured = (config: Record<string, unknown>) => {
      if (config.skills === undefined) return [];
      if (!skillObject(config.skills) || !Array.isArray(config.skills.config))
        throw new Error('Unreadable skill configuration.');
      const entries = config.skills.config;
      const unique = new Set<string>();
      for (const entry of entries)
        if (
          !skillObject(entry) ||
          typeof entry.path !== 'string' ||
          !paths.isAbsolute(entry.path) ||
          typeof entry.enabled !== 'boolean'
        )
          throw new Error('Unreadable skill configuration.');
        else {
          const canonical = canonicalPath(entry.path);
          if (unique.has(canonical)) throw new Error('Ambiguous skill configuration.');
          unique.add(canonical);
        }
      return entries as { path: string; enabled: boolean }[];
    };
    for (const layer of value.layers) {
      if (
        !skillObject(layer) ||
        !skillObject(layer.name) ||
        typeof layer.version !== 'string' ||
        !skillObject(layer.config) ||
        layer.disabledReason
      )
        return false;
      const type = layer.name.type;
      if (!['packagedDefaults', 'system', 'user', 'project', 'sessionFlags'].includes(String(type))) return false;
      if (type === 'system' && Object.keys(layer.config).length) return false;
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
        return false;
    const unique = new Set<string>();
    for (const entry of entries) {
      const canonical = canonicalPath(entry.path);
      if (unique.has(canonical)) return false;
      unique.add(canonical);
      if (entry.enabled) continue;
      if (canonical === canonicalPath(release.codexDefinition)) return false;
      const definition = read(canonical);
      const header = definition && /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(definition)?.[1];
      const names = header ? [...header.matchAll(/^name:[ \t]*([a-zA-Z0-9][a-zA-Z0-9_-]*)[ \t]*\r?$/gm)] : [];
      if (names.length === 1 && names[0][1].toLowerCase() !== 'arc-sessions') continue;
      // A disabled path from a retained release must suppress later automatic releases too.
      const ancestor = path.resolve(path.dirname(canonical), '../..');
      const retained = sessionSkillRelease(ancestor);
      if (canonical === canonicalToolPath(retained.codexDefinition)) return false;
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
