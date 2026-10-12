import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { childEnv, unstartable } from './agenthost';
import type { Launch } from './composerview';
import { ARC_IDENTITY } from './identity';
import { BundledTools, resolveToolRuntime } from './bundledtools';
import { acquireToolLock, admitToolPath, canonicalToolPath, retainedToolOwnership } from './toolownership';

const PLUGIN = 'arc-hooks@arc';
export const PLUGIN_OUTPUT_BYTES = 64 * 1024;
export const PLUGIN_READ_MS = 15_000;
export const PLUGIN_WRITE_MS = 120_000;

export interface PluginTarget {
  key: string;
  dismissalKey: string;
  cwd: string;
  home: string;
  launch: Launch;
  env: NodeJS.ProcessEnv;
  runtime?: string;
}

export const canonicalPluginPath = canonicalToolPath;

export function pluginTarget(cwd: string, home: string, launch: Launch, host: string): PluginTarget {
  const folder = canonicalPluginPath(cwd);
  const config = canonicalPluginPath(home);
  const env = childEnv(process.env, launch.env);
  // Freeze the resolved configuration home even when its environment value was relative.
  env.CLAUDE_CONFIG_DIR = config;
  const identity = JSON.stringify([host, config, folder]);
  return {
    key: JSON.stringify([identity, launch.command, launch.leadingArgs, Object.entries(env).sort()]),
    dismissalKey: `${ARC_IDENTITY.commandPrefix}.claudeSnapshots.dismissed:${createHash('sha256').update(identity).digest('hex')}`,
    cwd: folder,
    home: config,
    launch: { ...launch, leadingArgs: [...launch.leadingArgs], env: { ...launch.env } },
    env,
  };
}

export interface PluginCommand {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
  mutation: boolean;
}
export interface PluginOutput {
  stdout: string;
  stderr: string;
}
export type PluginRunner = (command: PluginCommand, signal: AbortSignal) => Promise<PluginOutput>;
export type PluginSpawn = (command: PluginCommand) => ChildProcessWithoutNullStreams;

export class PluginProcessError extends Error {
  constructor(
    message: string,
    readonly retainOwnership = false,
  ) {
    super(message);
  }
}

const setupSpawn: PluginSpawn = (command) => {
  const refusal = unstartable(command.command, process.platform);
  if (refusal) throw new Error(refusal);
  return spawn(command.command, command.args, {
    cwd: command.cwd,
    env: command.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
};

// The session spawner rereads the host environment and exposes only default-signal termination.
// Setup uses its environment and launcher rules with a bounded, frozen command lifetime.
export function pluginRunner(start: PluginSpawn = setupSpawn): PluginRunner {
  return (command, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new PluginProcessError('Claude snapshot setup was canceled.'));
        return;
      }
      let child: ChildProcessWithoutNullStreams;
      try {
        child = start(command);
      } catch (error) {
        reject(error);
        return;
      }
      const chunks: Buffer[][] = [[], []];
      const bytes = [0, 0];
      let failure: string | null = null;
      let code: number | null = null;
      let exited = false;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        const stdout = Buffer.concat(chunks[0]).toString('utf8');
        const stderr = Buffer.concat(chunks[1]).toString('utf8');
        if (failure || code !== 0 || signal.aborted) {
          reject(
            new PluginProcessError(
              failure ?? (stderr.trim() || stdout.trim() || 'Claude snapshot setup failed.'),
              command.mutation && !!failure,
            ),
          );
        } else resolve({ stdout, stderr });
      };
      const settleFailure = () => {
        if (!exited || !failure) return;
        settle();
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      };
      const stop = (message: string) => {
        if (failure) return;
        failure = message;
        // A canceled mutation retains its lock. Direct-child termination does not establish descendant settlement.
        if (!exited) child.kill('SIGKILL');
        settleFailure();
      };
      const cancel = () => stop('Claude snapshot setup was canceled.');
      const timer = setTimeout(() => stop('Claude snapshot setup exceeded its time limit.'), command.timeout);
      signal.addEventListener('abort', cancel, { once: true });
      [child.stdout, child.stderr].forEach((stream, index) =>
        stream.on('data', (value: Buffer | string) => {
          if (failure) return;
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          bytes[index] += chunk.length;
          if (bytes[index] > PLUGIN_OUTPUT_BYTES) {
            stop('Claude snapshot setup returned too much output.');
            return;
          }
          chunks[index].push(chunk);
        }),
      );
      child.on('error', (error) => {
        failure ??= error.message;
        settleFailure();
      });
      child.on('exit', (exit) => {
        code = exit;
        exited = true;
        settleFailure();
      });
      child.on('close', settle);
      child.stdin.end();
      if (signal.aborted) cancel();
    });
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function json(text: string): unknown {
  return JSON.parse(text);
}

function readJson(file: string): unknown | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size > PLUGIN_OUTPUT_BYTES) throw new Error(`${file} is too large to read for Claude snapshot setup.`);
    const buffer = Buffer.alloc(PLUGIN_OUTPUT_BYTES + 1);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (count > PLUGIN_OUTPUT_BYTES) throw new Error(`${file} is too large to read for Claude snapshot setup.`);
    return json(buffer.subarray(0, count).toString('utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export interface PluginEntry {
  scope: string;
  path: string;
  version: string;
  enabled: boolean;
}
export type PluginState = {
  state: 'missing' | 'enabled' | 'disabled' | 'unknown';
  message: string;
  entries?: PluginEntry[];
};
const unknown = (message: string): PluginState => ({ state: 'unknown', message });

function applicable(entry: Record<string, unknown>, cwd: string): boolean {
  if (entry.scope === 'user' || entry.scope === 'managed') return true;
  if (entry.scope !== 'project' && entry.scope !== 'local')
    throw new Error('Claude returned an unsupported plugin scope.');
  if (typeof entry.projectPath !== 'string' || !path.isAbsolute(entry.projectPath))
    throw new Error('Claude returned no plugin project folder.');
  const project = canonicalPluginPath(entry.projectPath);
  const relative = path.relative(project, cwd);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

export function listedPlugin(value: unknown, cwd: string): PluginState {
  if (
    !Array.isArray(value) ||
    !value.every(
      (entry) =>
        object(entry) &&
        typeof entry.id === 'string' &&
        typeof entry.enabled === 'boolean' &&
        typeof entry.scope === 'string' &&
        typeof entry.version === 'string' &&
        (typeof entry.installPath === 'string' || typeof entry.readFromFolder === 'string'),
    )
  )
    return unknown('Claude returned an unreadable plugin list.');
  try {
    const entries = value.filter((entry) => entry.id === PLUGIN && applicable(entry, cwd));
    if (!entries.length)
      return { state: 'missing', message: 'The Claude snapshot plugin is not installed for this folder.' };
    const scopes = entries.map((entry) => entry.scope);
    if (new Set(scopes).size !== scopes.length || entries.some((entry) => entry.enabled !== entries[0].enabled))
      return unknown('Claude returned conflicting snapshot plugin installations.');
    if (entries.some((entry) => entry.errors !== undefined && (!Array.isArray(entry.errors) || entry.errors.length)))
      return unknown('Claude could not load the snapshot plugin.');
    if (entries.some((entry) => !fs.statSync(entry.readFromFolder || entry.installPath).isDirectory()))
      return unknown('The Claude snapshot plugin folder is unavailable.');
    return entries[0].enabled
      ? {
          state: 'enabled',
          message: 'The Claude snapshot plugin is installed and enabled for this folder.',
          entries: entries.map((entry) => ({
            scope: entry.scope,
            path: canonicalPluginPath(entry.readFromFolder || entry.installPath),
            version: entry.version,
            enabled: entry.enabled,
          })),
        }
      : {
          state: 'disabled',
          message: 'The Claude snapshot plugin is disabled for this folder. Enable arc-hooks@arc in Claude to use it.',
        };
  } catch (error) {
    return unknown(errorMessage(error));
  }
}

export type PluginReadJson = (file: string) => unknown | undefined;

function healthyRegistry(target: PluginTarget, read: PluginReadJson): boolean {
  const registry = read(path.join(target.home, 'plugins', 'installed_plugins.json'));
  if (registry === undefined) return true;
  if (!object(registry) || registry.version !== 2 || !object(registry.plugins)) return false;
  for (const [id, installs] of Object.entries(registry.plugins)) {
    if (
      !Array.isArray(installs) ||
      !installs.every(
        (entry) =>
          object(entry) &&
          typeof entry.scope === 'string' &&
          typeof entry.installPath === 'string' &&
          typeof entry.version === 'string',
      )
    )
      return false;
    for (const entry of installs) applicable(entry, target.cwd);
    if (id === PLUGIN && installs.some((entry) => applicable(entry, target.cwd))) return false;
  }
  return true;
}

function snapshotSettings(target: PluginTarget, read: PluginReadJson): boolean {
  if (Object.entries(target.env).some(([key, value]) => key.toUpperCase() === 'CLAUDE_CODE_PLUGIN_CACHE_DIR' && value))
    throw new Error('Claude uses a redirected plugins folder. Set up snapshots through Claude for this configuration.');
  const files = [path.join(target.home, 'settings.json')];
  for (let folder = target.cwd; ; folder = path.dirname(folder)) {
    files.push(path.join(folder, '.claude', 'settings.json'), path.join(folder, '.claude', 'settings.local.json'));
    if (path.dirname(folder) === folder) break;
  }
  let disabled = false;
  for (const file of new Set(files)) {
    const settings = read(file);
    if (settings === undefined) continue;
    if (!object(settings) || (settings.enabledPlugins !== undefined && !object(settings.enabledPlugins)))
      throw new Error('Claude snapshot settings are unreadable.');
    if (settings.env !== undefined) {
      if (!object(settings.env)) throw new Error('Claude snapshot settings are unreadable.');
      // Setup does not resolve settings-derived runtime or storage overrides.
      if (
        Object.keys(settings.env).some((key) =>
          [
            'PATH',
            'PATHEXT',
            'NODE_OPTIONS',
            'NODE_PATH',
            'CLAUDE_CONFIG_DIR',
            'CLAUDE_CODE_PLUGIN_CACHE_DIR',
          ].includes(key.toUpperCase()),
        )
      )
        throw new Error(
          'Claude settings change the snapshot runtime or plugins folder. Set up snapshots through Claude for this configuration.',
        );
    }
    if (object(settings.enabledPlugins) && PLUGIN in settings.enabledPlugins) {
      const enabled = settings.enabledPlugins[PLUGIN];
      if (typeof enabled !== 'boolean') throw new Error('Claude snapshot settings are unreadable.');
      if (!enabled) disabled = true;
    }
  }
  return disabled;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ClaudePluginSetup {
  constructor(
    private readonly run: PluginRunner = pluginRunner(),
    private readonly expectedDirectory?: string,
    private readonly read: PluginReadJson = readJson,
    private readonly tools?: BundledTools,
    private readonly resolveNode = resolveToolRuntime,
  ) {}

  private command(
    target: PluginTarget,
    args: string[],
    signal: AbortSignal,
    mutation = false,
    node = false,
  ): Promise<PluginOutput> {
    if (signal.aborted) return Promise.reject(new PluginProcessError('Claude snapshot setup was canceled.'));
    return this.run(
      {
        command: node ? (target.runtime ?? 'node') : target.launch.command,
        args: node ? args : [...target.launch.leadingArgs, ...args],
        cwd: target.cwd,
        env: node
          ? { ...target.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined, NODE_PATH: undefined }
          : target.env,
        timeout: mutation ? PLUGIN_WRITE_MS : PLUGIN_READ_MS,
        mutation,
      },
      signal,
    );
  }

  async detect(target: PluginTarget, signal: AbortSignal): Promise<PluginState> {
    try {
      const disabled = snapshotSettings(target, this.read);
      const result = await this.command(target, ['plugin', 'list', '--json'], signal);
      const state = listedPlugin(json(result.stdout), target.cwd);
      if (state.state !== 'missing') return state;
      if (!healthyRegistry(target, this.read))
        return unknown('Claude snapshot installation data is unreadable or disagrees with its plugin list.');
      if (disabled)
        return {
          state: 'disabled',
          message: 'The Claude snapshot plugin is disabled for this folder. Enable arc-hooks@arc in Claude to use it.',
        };
      return state;
    } catch (error) {
      return unknown(errorMessage(error));
    }
  }

  private async node(target: PluginTarget, signal: AbortSignal): Promise<void> {
    try {
      const output = await this.command(target, ['--version'], signal, false, true);
      if (!/^v(1[89]|[2-9]\d|[1-9]\d{2,})\.\d+\.\d+\s*$/.test(output.stdout))
        throw new Error('Unrecognized Node version.');
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error(
        "Claude snapshot setup needs Node.js in the editor's launch environment. Install Node.js, restart the editor, then run Arc: Set up Claude hooks.",
        { cause: error },
      );
    }
  }

  private async marketplace(target: PluginTarget, signal: AbortSignal): Promise<boolean> {
    const output = await this.command(target, ['plugin', 'marketplace', 'list', '--json'], signal);
    const entries = json(output.stdout);
    if (
      !Array.isArray(entries) ||
      !entries.every(
        (entry) =>
          object(entry) && typeof entry.name === 'string' && (typeof entry.source === 'string' || object(entry.source)),
      )
    )
      throw new Error('Claude returned an unreadable marketplace list.');
    const selected = entries.filter((entry) => entry.name === 'arc');
    if (!selected.length) return false;
    if (selected.length !== 1) throw new Error('Claude returned conflicting arc marketplaces.');
    const source = object(selected[0].source) ? selected[0].source : selected[0];
    const type = source.source;
    const owned =
      (!this.tools && type === 'github' && source.repo === 'glin/arc' && !source.ref) ||
      (!this.tools &&
        type === 'git' &&
        typeof source.url === 'string' &&
        /^https:\/\/github\.com\/glin\/arc(?:\.git)?\/?$/.test(source.url) &&
        !source.ref) ||
      ((this.tools !== undefined || this.expectedDirectory !== undefined) &&
        type === 'directory' &&
        typeof source.path === 'string' &&
        canonicalPluginPath(source.path) ===
          canonicalPluginPath(this.tools?.configuration(target.home).source ?? this.expectedDirectory!));
    if (!owned)
      throw new Error(
        'The arc marketplace uses another source. Preserve that setup and resolve its source in Claude before retrying. Use the local source supplied by this Arc setup.',
      );
    return true;
  }

  async install(target: PluginTarget, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new PluginProcessError('Claude snapshot setup was canceled.');
    snapshotSettings(target, this.read);
    if (this.tools) {
      const frozen = { ...target, runtime: this.resolveNode(target.env, target.cwd) };
      return this.tools.owned((token) => this.installOwned(frozen, signal, token), signal);
    }
    return this.installOwned(target, signal);
  }

  private async installOwned(target: PluginTarget, signal: AbortSignal, token = ''): Promise<string> {
    const lock = acquirePluginLock(target.home);
    let retain = false;
    try {
      const state = await this.detect(target, signal);
      if (signal.aborted) throw new PluginProcessError('Claude snapshot setup was canceled.');
      let updating = false;
      if (state.state === 'enabled') {
        if (!this.tools) return state.message;
        await this.marketplace(target, signal);
        const previous = this.tools.registration(target.home);
        const entries = state.entries ?? [];
        const recovering =
          previous &&
          !previous.complete &&
          previous.contentId === this.tools.bundle.payload.contentId &&
          typeof previous.operation === 'string' &&
          previous.operation.length > 0 &&
          entries.length === 1 &&
          entries[0].scope === 'user' &&
          canonicalPluginPath(entries[0].path) === this.tools.configuration(target.home).plugin &&
          this.tools.matchesPlugin(entries[0].path);
        if (
          !previous ||
          entries.length !== 1 ||
          entries[0].scope !== 'user' ||
          (!recovering && (!previous.observedPath || canonicalPluginPath(entries[0].path) !== previous.observedPath))
        )
          throw new Error(
            'The snapshot plugin belongs to another installation or scope. Preserve it and resolve its source in Claude.',
          );
        if (
          previous.complete &&
          previous.contentId === this.tools.bundle.payload.contentId &&
          this.tools.matchesPlugin(entries[0].path)
        )
          return state.message;
        updating = true;
      }
      if (state.state !== 'missing' && !updating) throw new Error(state.message);
      const version = await this.command(target, ['--version'], signal);
      const match = /^(\d+)\.(\d+)\.(\d+)(?:\s+\(Claude Code\))?\s*$/.exec(version.stdout.trim());
      if (!match || compareVersion(match.slice(1).map(Number), [2, 1, 268]) < 0)
        throw new Error('Claude snapshot setup needs Claude Code 2.1.268 or later. Upgrade Claude, then retry.');
      await this.node(target, signal);
      await this.marketplace(target, signal);
      this.tools?.publish(target.home, token);
      if (!(await this.marketplace(target, signal))) {
        await this.command(
          target,
          [
            'plugin',
            'marketplace',
            'add',
            this.tools?.configuration(target.home).source ?? this.expectedDirectory ?? 'glin/arc',
          ],
          signal,
          true,
        );
        if (!(await this.marketplace(target, signal))) throw new Error('Claude did not register the arc marketplace.');
      }
      if (this.tools) await this.command(target, ['plugin', 'marketplace', 'update', 'arc'], signal, true);
      const action = updating ? 'update' : 'install';
      const output = await this.command(target, ['plugin', action, PLUGIN, '--scope', 'user', '--json'], signal, true);
      const result = json(output.stdout.trim().split(/\r?\n/).at(-1) ?? '');
      if (
        !object(result) ||
        result.command !== action ||
        result.outcome !== 'ok' ||
        (result.pluginId !== undefined && result.pluginId !== PLUGIN) ||
        (result.scope !== undefined && result.scope !== 'user')
      )
        throw new Error(
          object(result) && typeof result.message === 'string'
            ? result.message
            : 'Claude did not confirm snapshot installation.',
        );
      const installed = await this.detect(target, signal);
      if (installed.state !== 'enabled') throw new Error(installed.message);
      if (this.tools) {
        const entries = installed.entries ?? [];
        if (entries.length !== 1 || entries[0].scope !== 'user')
          throw new Error('Claude selected a different snapshot scope. Arc setup remains incomplete.');
        if (!this.tools.matchesPlugin(entries[0].path))
          throw new Error('Claude selected different snapshot files. Arc snapshot setup remains incomplete.');
      }
      try {
        await this.node(target, signal);
      } catch (error) {
        throw new Error(`${installed.message} ${errorMessage(error)} Snapshot capture has not been checked.`, {
          cause: error,
        });
      }
      if (signal.aborted) throw new PluginProcessError('Claude snapshot setup was canceled.');
      if (this.tools) this.tools.complete(target.home, installed.entries![0].path, token);
      return `${installed.message} Start a fresh Claude session or restart its running session to load it. Snapshot capture has not been checked. Earlier file baselines stay unavailable.`;
    } catch (error) {
      retain = retainedToolOwnership(error);
      if (retain)
        throw new Error(
          `${errorMessage(error)} Setup ownership remains at ${lock.file}. Close related Claude processes before resolving it manually.`,
          { cause: error },
        );
      if (!retain) this.tools?.rollback(target.home, token);
      throw error;
    } finally {
      if (!retain) lock.release();
    }
  }
}

function compareVersion(left: number[], right: number[]): number {
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

export function acquirePluginLock(home: string): { file: string; release(): void } {
  return acquireToolLock(path.join(admitToolPath(home), '.arc-snapshot-setup.lock'));
}

export interface PluginOfferPorts {
  target(): PluginTarget | null;
  dismissed(key: string): boolean;
  dismiss(key: string): Promise<void>;
  offer(): Promise<string | undefined>;
  report(message: string, error: boolean): void;
}

export class ClaudePluginOffer {
  private disposed = false;
  private controller: AbortController | null = null;
  private pending: Promise<void> | null = null;
  private cached: string | null = null;
  private offered = false;
  constructor(
    private readonly ports: PluginOfferPorts,
    private readonly setup = new ClaudePluginSetup(),
  ) {}

  invalidate(): void {
    this.cached = null;
    this.controller?.abort();
  }
  dispose(): Promise<void> {
    this.disposed = true;
    this.invalidate();
    return this.pending ?? Promise.resolve();
  }

  check(explicit = false): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.pending) return this.pending.then(() => this.check(explicit));
    const target = this.ports.target();
    if (!target) {
      if (explicit)
        this.ports.report('Open a trusted project folder with Claude Code available to set up Claude snapshots.', true);
      return Promise.resolve();
    }
    if (!explicit && (this.cached === target.key || this.offered || this.ports.dismissed(target.dismissalKey)))
      return Promise.resolve();
    const controller = new AbortController();
    this.controller = controller;
    const current = () => !this.disposed && !controller.signal.aborted && this.ports.target()?.key === target.key;
    const pending = (async () => {
      const state = await this.setup.detect(target, controller.signal);
      if (!current()) return;
      this.cached = target.key;
      if (state.state !== 'missing' && !(explicit && state.state === 'enabled')) {
        if (explicit) this.ports.report(state.message, state.state !== 'enabled');
        return;
      }
      this.offered = true;
      const answer = await new Promise<string | undefined>((resolve, reject) => {
        const cancel = () => resolve(undefined);
        controller.signal.addEventListener('abort', cancel, { once: true });
        void this.ports
          .offer()
          .then((choice) => {
            if (choice === 'Install' && !current() && !this.disposed) {
              this.cached = null;
              this.offered = false;
              void this.check(true);
            }
            resolve(choice);
          }, reject)
          .finally(() => controller.signal.removeEventListener('abort', cancel));
        if (controller.signal.aborted) cancel();
      });
      if (!current()) {
        return;
      }
      if (answer === 'Not now') await this.ports.dismiss(target.dismissalKey);
      if (answer !== 'Install' || !current()) return;
      try {
        const message = await this.setup.install(target, controller.signal);
        this.cached = null;
        if (current()) this.ports.report(message, false);
      } catch (error) {
        this.cached = null;
        if (current()) this.ports.report(errorMessage(error), true);
      }
    })().catch((error) => {
      if (current()) this.ports.report(errorMessage(error), true);
    });
    this.pending = pending;
    void pending.finally(() => {
      if (this.pending === pending) {
        this.pending = null;
        this.controller = null;
      }
    });
    return pending;
  }
}
