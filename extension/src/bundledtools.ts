import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ARC_IDENTITY } from './identity';
import type { SessionSkillRelease } from './sessionskills';
import { writeFileAtomically } from './atomicfile';
import {
  acquireToolLock,
  admitToolPath,
  canonicalToolPath,
  retainedToolOwnership,
  waitForToolLock,
} from './toolownership';

export interface ToolPayload {
  schemaVersion: number;
  contentId: string;
  nodeMinimum: number;
  platforms: string[];
  plugin: { name: string; version: string };
  files: Record<string, { sha256: string; mode: number }>;
}
export interface ToolPackage {
  directory: string;
  payload: ToolPayload;
}
export interface ToolRegistration {
  home: string;
  source: string;
  contentId: string;
  scope: 'user';
  observedPath?: string;
  operation: string;
  complete: boolean;
  previousContentId?: string;
}
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

function filesIn(folder: string, prefix = ''): string[] {
  return fs
    .readdirSync(folder, { withFileTypes: true })
    .flatMap((entry) => {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) return filesIn(path.join(folder, entry.name), relative + '/');
      if (!entry.isFile()) throw new Error(`Arc setup cannot copy the redirected file ${relative}.`);
      return [relative];
    })
    .sort();
}

export function validateToolFiles(folder: string, files: ToolPayload['files'], excluded: string[] = []): void {
  const names = Object.keys(files).sort();
  if (JSON.stringify(filesIn(folder).filter((file) => !excluded.includes(file))) !== JSON.stringify(names))
    throw new Error('The bundled Arc files differ from their package identity. Reinstall the extension.');
  for (const name of names) {
    const metadata = files[name];
    if (
      !name ||
      path.isAbsolute(name) ||
      name.split(/[\\/]/).some((part) => !part || part === '.' || part === '..') ||
      !/^[a-f0-9]{64}$/.test(metadata.sha256) ||
      ![0o644, 0o755].includes(metadata.mode)
    )
      throw new Error('The bundled Arc package identity is unreadable. Reinstall the extension.');
    if (digest(fs.readFileSync(path.join(folder, name))) !== metadata.sha256)
      throw new Error(`The bundled Arc file ${name} is damaged. Reinstall the extension.`);
    if (process.platform !== 'win32' && (fs.statSync(path.join(folder, name)).mode & 0o777) !== metadata.mode)
      throw new Error(`The bundled Arc file ${name} has unsupported permissions. Reinstall the extension.`);
  }
}

export function readToolPackage(dist: string, platform = process.platform): ToolPackage {
  const identity = JSON.parse(fs.readFileSync(path.join(dist, 'build-identity.json'), 'utf8'));
  const payload = identity.tools as ToolPayload;
  if (
    !payload ||
    payload.schemaVersion !== 1 ||
    payload.nodeMinimum !== 18 ||
    payload.plugin?.name !== 'arc-hooks' ||
    !Array.isArray(payload.platforms) ||
    !payload.platforms.includes(platform) ||
    !payload.files ||
    typeof payload.files !== 'object'
  )
    throw new Error('This Arc package does not support native setup on this host.');
  const { contentId, ...content } = payload;
  if (contentId !== digest(JSON.stringify(content))) throw new Error('The bundled Arc package identity is damaged.');
  const directory = path.join(dist, 'tools');
  validateToolFiles(directory, payload.files);
  for (const required of [
    `cli/${ARC_IDENTITY.cliExecutable}.cjs`,
    'cli/windowpipe.exe',
    'plugin/.claude-plugin/plugin.json',
    'plugin/hooks/hooks.json',
    'LICENSE',
    'plugin/LICENSE',
    'skills/arc-sessions/SKILL.md',
    `launchers/${ARC_IDENTITY.commandPrefix}`,
    `launchers/${ARC_IDENTITY.commandPrefix}.cmd`,
  ])
    if (!(required in payload.files)) throw new Error(`The bundled Arc package lacks ${required}.`);
  return { directory, payload };
}

// A release's recorded identity covers both native copies and every referenced resource.
export function sessionSkillRelease(directory: string): SessionSkillRelease {
  const release = canonicalToolPath(directory);
  const payload = jsonFile(path.join(release, 'release.json')) as ToolPayload & { extensionVersion?: string };
  const { contentId, ...content } = payload;
  if (!/^[a-f0-9]{64}$/.test(contentId) || contentId !== digest(JSON.stringify(content)))
    throw new Error('The Arc session tools have an unreadable identity.');
  validateToolFiles(release, payload.files, ['release.json']);
  const prefix = 'skills/arc-sessions/';
  const copies = Object.keys(payload.files)
    .filter((file) => file.startsWith(prefix))
    .sort();
  if (!copies.includes(prefix + 'SKILL.md')) throw new Error('The Arc session skill is missing.');
  const pluginFiles = Object.keys(payload.files)
    .filter((file) => file.startsWith('session-plugin/'))
    .sort();
  const manifestFile = 'session-plugin/.claude-plugin/plugin.json';
  if (
    JSON.stringify(pluginFiles) !==
    JSON.stringify([manifestFile, ...copies.map((file) => 'session-plugin/' + file)].sort())
  )
    throw new Error('The Arc session plugin contains unsupported files.');
  const manifest = JSON.parse(fs.readFileSync(path.join(release, manifestFile), 'utf8'));
  if (
    !payload.extensionVersion ||
    JSON.stringify(manifest) !== JSON.stringify({ name: 'arc-session-tools', version: payload.extensionVersion })
  )
    throw new Error('The Arc session plugin has an unreadable identity.');
  for (const file of copies)
    if (payload.files[file].sha256 !== payload.files['session-plugin/' + file].sha256)
      throw new Error('The Arc session skill copies differ.');
  const definition = fs.readFileSync(path.join(release, prefix, 'SKILL.md'), 'utf8');
  for (const [, reference] of definition.matchAll(/\]\(([\w-]+\.md)(?:#[^)]*)?\)/g))
    if (!copies.includes(prefix + reference)) throw new Error('The Arc session skill has a missing reference.');
  return Object.freeze({
    contentId,
    directory: release,
    claudePlugin: path.join(release, 'session-plugin'),
    codexRoot: path.join(release, 'skills'),
    claudeDefinition: path.join(release, 'session-plugin/skills/arc-sessions/SKILL.md'),
    codexDefinition: path.join(release, 'skills/arc-sessions/SKILL.md'),
  });
}

export async function prepareEditorCommands(
  dist: string,
  root: string,
  signal: AbortSignal,
  development: boolean,
): Promise<string> {
  if (signal.aborted) throw new Error('Arc setup was canceled.');
  if (!development) return new BundledTools(readToolPackage(dist), root).preparePrivateCommands(signal);
  try {
    const bundle = readToolPackage(dist);
    return await new BundledTools(bundle, root).preparePrivateCommands(signal);
  } catch {
    // Watch builds remove their identity and retain their development launchers.
  }
  const directory = path.join(dist, 'bin');
  admitToolPath(directory);
  for (const file of ['bin/arc', 'bin/arc.cmd', 'cli.cjs', 'windowpipe.exe']) {
    const stat = fs.lstatSync(path.join(dist, file));
    if (!stat.isFile()) throw new Error('Arc development commands are unavailable. Rebuild the extension.');
  }
  return directory;
}

export function toolRoot(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return admitToolPath(env[`${ARC_IDENTITY.environmentPrefix}HOME`] || path.join(home, ARC_IDENTITY.homeDirectory));
}

function jsonFile(file: string): unknown {
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`Arc setup cannot use the redirected file ${file}.`);
  if (fs.statSync(file).size > 128 * 1024) throw new Error(`Arc setup cannot read ${file}.`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function save(file: string, value: unknown): void {
  admitToolPath(path.dirname(file));
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink())
    throw new Error(`Arc setup cannot replace the redirected file ${file}.`);
  writeFileAtomically(file, JSON.stringify(value) + '\n', fs.renameSync, 0o600);
}

export class BundledTools {
  readonly root: string;
  readonly tools: string;
  constructor(
    readonly bundle: ToolPackage,
    root: string,
  ) {
    this.root = admitToolPath(root);
    this.tools = path.join(this.root, 'tools');
  }

  private claim(): void {
    admitToolPath(this.tools);
    if (!fs.existsSync(this.tools)) {
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
      const staging = path.join(
        this.root,
        path.basename(fs.mkdtempSync(path.toNamespacedPath(path.join(this.root, '.arc-tools-')))),
      );
      const created = fs.lstatSync(staging);
      const ownership = JSON.stringify({ schemaVersion: 1, root: this.root });
      try {
        fs.chmodSync(staging, 0o700);
        fs.writeFileSync(path.join(staging, 'ownership.json'), ownership, { flag: 'wx', mode: 0o600 });
        try {
          fs.renameSync(staging, this.tools);
        } catch (error) {
          if (!fs.existsSync(this.tools)) throw error;
        }
      } finally {
        try {
          admitToolPath(staging);
          const remaining = fs.lstatSync(staging);
          if (remaining.dev === created.dev && remaining.ino === created.ino) {
            const names = fs.readdirSync(staging);
            const stagedMarker = path.join(staging, 'ownership.json');
            if (
              names.length === 1 &&
              names[0] === 'ownership.json' &&
              fs.lstatSync(stagedMarker).isFile() &&
              fs.readFileSync(stagedMarker, 'utf8') === ownership
            ) {
              fs.unlinkSync(stagedMarker);
              fs.rmdirSync(staging);
            } else if (!names.length) fs.rmdirSync(staging);
          }
        } catch {
          // Unfamiliar or replaced staging contents remain for manual inspection.
        }
      }
    }
    this.checkOwnership();
  }

  private checkOwnership(): void {
    const marker = path.join(this.tools, 'ownership.json');
    if (
      !fs.existsSync(marker) ||
      JSON.stringify(jsonFile(marker)) !== JSON.stringify({ schemaVersion: 1, root: this.root })
    )
      throw new Error(`Arc setup cannot replace unfamiliar files in ${this.tools}.`);
  }

  async owned<T>(operation: (token: string) => Promise<T>, signal: AbortSignal, wait = false): Promise<T> {
    if (signal.aborted) throw new Error('Arc setup was canceled.');
    this.claim();
    const file = path.join(this.tools, '.install.lock');
    const lock = wait ? await waitForToolLock(file, signal) : acquireToolLock(file);
    let retain = false;
    try {
      this.claim();
      validateToolFiles(this.bundle.directory, this.bundle.payload.files);
      if (signal.aborted) throw new Error('Arc setup was canceled.');
      return await operation(lock.token);
    } catch (error) {
      retain = retainedToolOwnership(error);
      throw error;
    } finally {
      if (!retain) lock.release();
    }
  }

  stage(): string {
    const existing = this.existingRelease();
    if (existing) return existing;
    const releases = path.join(this.tools, 'releases');
    admitToolPath(releases);
    fs.mkdirSync(releases, { recursive: true });
    const release = path.join(releases, this.bundle.payload.contentId);
    if (!fs.existsSync(release)) {
      const staging = path.join(releases, `.staging-${randomUUID()}`);
      fs.mkdirSync(staging, { mode: 0o700 });
      for (const [file, metadata] of Object.entries(this.bundle.payload.files)) {
        const target = path.join(staging, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(this.bundle.directory, file), target, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(target, metadata.mode);
      }
      validateToolFiles(staging, this.bundle.payload.files);
      fs.writeFileSync(path.join(staging, 'release.json'), JSON.stringify(this.bundle.payload), {
        flag: 'wx',
        mode: 0o644,
      });
      fs.renameSync(staging, release);
    }
    return this.existingRelease()!;
  }

  private existingRelease(): string | undefined {
    const release = path.join(this.tools, 'releases', this.bundle.payload.contentId);
    admitToolPath(release);
    if (!fs.existsSync(release)) return undefined;
    if (JSON.stringify(jsonFile(path.join(release, 'release.json'))) !== JSON.stringify(this.bundle.payload))
      throw new Error(
        'The installed Arc release has an unfamiliar identity. Preserve its files and reinstall explicitly.',
      );
    validateToolFiles(release, this.bundle.payload.files, ['release.json']);
    return release;
  }

  configuration(home: string): { folder: string; source: string; plugin: string; registration: string } {
    const config = admitToolPath(home);
    const folder = path.join(this.tools, 'claude', digest(config));
    const source = path.join(folder, 'marketplace');
    admitToolPath(source);
    return {
      folder,
      source,
      plugin: path.join(source, 'releases', this.bundle.payload.contentId, 'plugin'),
      registration: path.join(folder, 'registration.json'),
    };
  }

  registration(home: string): ToolRegistration | undefined {
    const location = this.configuration(home);
    if (!fs.existsSync(location.registration)) return undefined;
    const data = jsonFile(location.registration) as ToolRegistration;
    if (
      data.home !== canonicalToolPath(home) ||
      data.source !== location.source ||
      data.scope !== 'user' ||
      typeof data.contentId !== 'string'
    )
      throw new Error(
        'Arc snapshot installation ownership is unreadable. Preserve this configuration and resolve it manually.',
      );
    return data;
  }

  publish(home: string, token: string): void {
    const release = this.stage();
    const location = this.configuration(home);
    const previous = this.registration(home);
    const claim = path.join(this.tools, `configuration-${digest(canonicalToolPath(home))}.json`);
    const ownership = { home: canonicalToolPath(home), source: location.source, root: this.root };
    if (!previous) {
      if (
        fs.existsSync(location.folder) &&
        (!fs.existsSync(claim) ||
          JSON.stringify(jsonFile(claim)) !== JSON.stringify(ownership) ||
          filesIn(location.folder).length)
      )
        throw new Error(`Arc setup cannot replace unfamiliar files in ${location.folder}.`);
      save(claim, ownership);
    }
    admitToolPath(location.plugin);
    admitToolPath(path.join(location.source, '.claude-plugin'));
    save(location.registration, {
      home: canonicalToolPath(home),
      source: location.source,
      scope: 'user',
      contentId: this.bundle.payload.contentId,
      operation: token,
      complete: false,
      observedPath: previous?.observedPath,
      previousContentId: previous?.complete ? previous.contentId : previous?.previousContentId,
    });
    if (!fs.existsSync(location.plugin)) {
      const parent = path.dirname(location.plugin);
      fs.mkdirSync(path.dirname(parent), { recursive: true });
      const staging = path.join(path.dirname(parent), `.staging-${randomUUID()}`);
      fs.mkdirSync(staging);
      fs.cpSync(path.join(release, 'plugin'), path.join(staging, 'plugin'), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      validateToolFiles(path.join(staging, 'plugin'), this.pluginFiles());
      fs.renameSync(staging, parent);
    }
    validateToolFiles(location.plugin, this.pluginFiles());
    save(path.join(location.source, '.claude-plugin', 'marketplace.json'), {
      name: ARC_IDENTITY.commandPrefix,
      owner: { name: 'glin' },
      plugins: [{ name: 'arc-hooks', source: `./releases/${this.bundle.payload.contentId}/plugin` }],
    });
  }

  pluginFiles(): ToolPayload['files'] {
    return Object.fromEntries(
      Object.entries(this.bundle.payload.files)
        .filter(([file]) => file.startsWith('plugin/'))
        .map(([file, data]) => [file.slice(7), data]),
    );
  }

  matchesPlugin(folder: string): boolean {
    try {
      validateToolFiles(folder, this.pluginFiles());
      return true;
    } catch {
      return false;
    }
  }

  complete(home: string, observedPath: string, token: string): void {
    if (canonicalToolPath(observedPath) !== this.configuration(home).plugin || !this.matchesPlugin(observedPath))
      throw new Error('Claude selected different snapshot files. Arc snapshot setup remains incomplete.');
    const location = this.configuration(home);
    save(location.registration, {
      home: canonicalToolPath(home),
      source: location.source,
      scope: 'user',
      contentId: this.bundle.payload.contentId,
      operation: token,
      complete: true,
      observedPath: canonicalToolPath(observedPath),
    });
  }

  rollback(home: string, token: string): void {
    const registration = this.registration(home);
    if (registration?.operation !== token || !registration.previousContentId) return;
    const location = this.configuration(home);
    save(path.join(location.source, '.claude-plugin', 'marketplace.json'), {
      name: ARC_IDENTITY.commandPrefix,
      owner: { name: 'glin' },
      plugins: [{ name: 'arc-hooks', source: `./releases/${registration.previousContentId}/plugin` }],
    });
  }

  async preparePrivateCommands(signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new Error('Arc setup was canceled.');
    validateToolFiles(this.bundle.directory, this.bundle.payload.files);
    const ready = () => {
      admitToolPath(this.tools);
      if (fs.existsSync(this.tools)) this.checkOwnership();
      const release = this.existingRelease();
      return release && path.join(release, 'launchers');
    };
    const existing = ready();
    if (existing) return existing;
    this.claim();
    const selection = await waitForToolLock(path.join(this.tools, '.install.lock'), signal, ready);
    if (typeof selection === 'string') return selection;
    let retain = false;
    try {
      this.claim();
      validateToolFiles(this.bundle.directory, this.bundle.payload.files);
      if (signal.aborted) throw new Error('Arc setup was canceled.');
      return path.join(this.stage(), 'launchers');
    } catch (error) {
      retain = retainedToolOwnership(error);
      throw error;
    } finally {
      if (!retain) selection.release();
    }
  }

  async installCommands(runtime: string, signal: AbortSignal): Promise<string> {
    const node = probeToolRuntime(runtime);
    return this.owned(async () => {
      this.stage();
      const bin = path.join(this.root, 'bin');
      admitToolPath(bin);
      const marker = path.join(bin, '.arc-commands.json');
      const journal = path.join(this.tools, 'command-operation.json');
      this.recoverCommands(journal, bin);
      if (fs.existsSync(bin) && (!fs.existsSync(marker) || (jsonFile(marker) as { root?: string }).root !== this.root))
        throw new Error(`Arc setup cannot replace unfamiliar commands in ${bin}.`);
      if (
        fs.existsSync(bin) &&
        filesIn(bin).some(
          (name) =>
            ![
              ARC_IDENTITY.commandPrefix,
              `${ARC_IDENTITY.commandPrefix}.cmd`,
              'run.cjs',
              '.arc-commands.json',
            ].includes(name),
        )
      )
        throw new Error(`Arc setup found unfamiliar commands in ${bin}. Preserve them before retrying.`);
      if (fs.existsSync(marker)) {
        const owned = jsonFile(marker) as { files?: Record<string, string> };
        if (
          !owned.files ||
          filesIn(bin).some(
            (file) =>
              file !== '.arc-commands.json' && owned.files?.[file] !== digest(fs.readFileSync(path.join(bin, file))),
          )
        )
          throw new Error(`Arc setup found changed or unfamiliar commands in ${bin}. Preserve them before retrying.`);
      }
      const runner = `const fs=require('node:fs'),path=require('node:path');try{const root=path.resolve(__dirname,'..');const active=JSON.parse(fs.readFileSync(path.join(root,'tools','active.json'),'utf8'));if(!/^[a-f0-9]{64}$/.test(active.contentId))throw Error('Arc command selection is unreadable.');require(path.join(root,'tools','releases',active.contentId,'cli',${JSON.stringify(ARC_IDENTITY.cliExecutable + '.cjs')}));}catch(e){console.error('Arc command unavailable. Rerun the source command installer. '+e.message);process.exitCode=1;}\n`;
      const quoted = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      if (/[\r\n"]/u.test(node) || /[\r\n"]/u.test(bin) || (process.platform === 'win32' && /%/u.test(node + bin)))
        throw new Error(
          'Arc command setup cannot quote this runtime or installation path. Choose a path without percent signs, quotes or line breaks.',
        );
      const sh = `#!/bin/sh\nif [ ! -x ${quoted(node)} ]; then echo 'Arc needs its Node.js runtime. Rerun the source command installer.' >&2; exit 1; fi\nexec ${quoted(node)} ${quoted(path.join(bin, 'run.cjs'))} "$@"\n`;
      const cmd = `@echo off\r\nsetlocal DisableDelayedExpansion\r\nif not exist "${node}" (echo Arc needs its Node.js runtime. Rerun the source command installer. 1>&2 & exit /b 1)\r\n"${node}" "${path.join(bin, 'run.cjs')}" %*\r\nexit /b %errorlevel%\r\n`;
      const next = Object.fromEntries(
        [ARC_IDENTITY.cliExecutable].flatMap((name) => [
          [name, sh],
          [`${name}.cmd`, cmd],
        ]),
      );
      next['run.cjs'] = runner;
      next['.arc-commands.json'] =
        JSON.stringify({
          root: this.root,
          files: Object.fromEntries(Object.entries(next).map(([name, bytes]) => [name, digest(bytes)])),
        }) + '\n';
      const previous = Object.fromEntries(
        Object.keys(next).map((name) => [
          name,
          fs.existsSync(path.join(bin, name)) ? fs.readFileSync(path.join(bin, name), 'utf8') : null,
        ]),
      );
      const active = path.join(this.tools, 'active.json');
      const selection = {
        previous: fs.existsSync(active) ? fs.readFileSync(active, 'utf8') : null,
        next: JSON.stringify({ contentId: this.bundle.payload.contentId, runtime: node }) + '\n',
      };
      save(journal, { root: this.root, previous, next, selection });
      try {
        for (const [name, bytes] of Object.entries(next)) {
          const mode = name === ARC_IDENTITY.cliExecutable ? 0o755 : 0o644;
          writeFileAtomically(path.join(bin, name), bytes, fs.renameSync, mode);
          fs.chmodSync(path.join(bin, name), mode);
        }
        save(path.join(this.tools, 'active.json'), { contentId: this.bundle.payload.contentId, runtime: node });
        fs.unlinkSync(journal);
      } catch (error) {
        // Retained operation bytes permit recovery after storage becomes writable again.
        try {
          this.recoverCommands(journal, bin);
        } catch {
          /* Keep the operation for explicit retry. */
        }
        throw error;
      }
      return path.join(
        bin,
        process.platform === 'win32' ? `${ARC_IDENTITY.commandPrefix}.cmd` : ARC_IDENTITY.commandPrefix,
      );
    }, signal);
  }

  private recoverCommands(journal: string, bin: string): void {
    if (!fs.existsSync(journal)) return;
    const operation = jsonFile(journal) as {
      root: string;
      previous: Record<string, string | null>;
      next: Record<string, string>;
      selection: { previous: string | null; next: string };
    };
    const names = [
      ARC_IDENTITY.commandPrefix,
      `${ARC_IDENTITY.commandPrefix}.cmd`,
      'run.cjs',
      '.arc-commands.json',
    ].sort();
    if (
      operation.root !== this.root ||
      !operation.previous ||
      !operation.next ||
      !operation.selection ||
      JSON.stringify(Object.keys(operation.previous).sort()) !== JSON.stringify(names) ||
      JSON.stringify(Object.keys(operation.next).sort()) !== JSON.stringify(names)
    )
      throw new Error('Arc command setup ownership is unreadable. Preserve the installation before retrying.');
    admitToolPath(bin);
    const active = path.join(this.tools, 'active.json');
    admitToolPath(path.dirname(active));
    if (
      typeof operation.selection.next !== 'string' ||
      (operation.selection.previous !== null && typeof operation.selection.previous !== 'string') ||
      (fs.existsSync(active) &&
        ![operation.selection.previous, operation.selection.next].includes(fs.readFileSync(active, 'utf8')))
    )
      throw new Error('Arc command selection changed during setup. Preserve the installation before retrying.');
    if (fs.existsSync(bin) && filesIn(bin).some((name) => !names.includes(name)))
      throw new Error(`Arc setup found unfamiliar commands in ${bin}. Preserve them before retrying.`);
    for (const name of names) {
      const file = path.join(bin, name);
      if (
        typeof operation.next[name] !== 'string' ||
        (operation.previous[name] !== null && typeof operation.previous[name] !== 'string')
      )
        throw new Error('Arc command setup ownership is unreadable. Preserve the installation before retrying.');
      if (fs.existsSync(file)) {
        const bytes = fs.readFileSync(file, 'utf8');
        if (bytes !== operation.previous[name] && bytes !== operation.next[name])
          throw new Error(`Arc setup found changed or unfamiliar commands in ${bin}. Preserve them before retrying.`);
      }
    }
    for (const name of names) {
      const file = path.join(bin, name);
      const bytes = operation.previous[name];
      if (bytes === null) {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } else {
        const mode = name === ARC_IDENTITY.cliExecutable ? 0o755 : 0o644;
        writeFileAtomically(file, bytes, fs.renameSync, mode);
        fs.chmodSync(file, mode);
      }
    }
    if (operation.selection.previous === null) {
      if (fs.existsSync(active)) fs.unlinkSync(active);
    } else writeFileAtomically(active, operation.selection.previous, fs.renameSync, 0o600);
    // An empty directory retains no command selection and needs no ownership marker.
    if (fs.existsSync(bin) && !filesIn(bin).length) fs.rmdirSync(bin);
    fs.unlinkSync(journal);
  }
}

export function probeToolRuntime(runtime: string): string {
  if (!path.isAbsolute(runtime) || !fs.existsSync(runtime) || !fs.statSync(runtime).isFile())
    throw new Error('Arc setup needs an absolute Node.js executable.');
  const output = execFileSync(runtime, ['--version'], {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 4096,
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined, NODE_PATH: undefined },
  });
  const match = /^v(\d+)\.\d+\.\d+\s*$/.exec(output);
  if (!match || Number(match[1]) < 18)
    throw new Error('Arc setup needs Node.js 18 or later. Install Node.js, restart the editor, then retry.');
  return fs.realpathSync.native(runtime);
}

export function resolveToolRuntime(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  platform = process.platform,
): string {
  const delimiter = platform === 'win32' ? ';' : ':';
  const executable = platform === 'win32' ? 'node.exe' : 'node';
  const names =
    platform === 'win32'
      ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((extension) => 'node' + extension.toLowerCase())
      : [executable];
  if (platform === 'win32' && names.some((name) => fs.existsSync(path.join(cwd, name))))
    throw new Error(
      'Arc snapshot setup cannot use Node.js from this project. Use an external Node.js runtime first on PATH.',
    );
  for (const entry of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    const folder = entry.replace(/^"|"$/g, '');
    const searchFolder = path.resolve(cwd, folder);
    const first = names.find((name) => {
      try {
        const candidate = path.join(searchFolder, name);
        fs.accessSync(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
    if (!first) continue;
    const candidate = path.join(searchFolder, first);
    if (!path.isAbsolute(folder))
      throw new Error(
        'Arc snapshot setup cannot use Node.js from a relative PATH folder. Use an external Node.js runtime first on PATH.',
      );
    if (first !== executable)
      throw new Error(
        'Arc snapshot setup needs the external Node.js executable first on PATH. Preserve other Node commands before retrying.',
      );
    const relative = path.relative(canonicalToolPath(cwd), canonicalToolPath(folder));
    if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)))
      throw new Error(
        'Arc snapshot setup cannot use Node.js from this project. Use an external Node.js runtime first on PATH.',
      );
    if (fs.existsSync(candidate)) {
      const resolved = canonicalToolPath(candidate);
      const inside = path.relative(canonicalToolPath(cwd), resolved);
      if (inside === '' || (inside !== '..' && !inside.startsWith('..' + path.sep) && !path.isAbsolute(inside)))
        throw new Error(
          'Arc snapshot setup cannot use Node.js from this project. Use an external Node.js runtime first on PATH.',
        );
      return probeToolRuntime(candidate);
    }
  }
  throw new Error('Arc setup needs Node.js 18 or later on PATH. Install Node.js, restart the editor, then retry.');
}
