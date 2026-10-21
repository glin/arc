import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import { claudeLaunch, codexLaunch, type Machine } from '../src/composerview.ts';
import { ClaudeWire, spawnArgs, readModels as claudeModels } from '../src/claudewire.ts';
import { childEnv } from '../src/agenthost.ts';
import { CodexWire, appServerArgs, readModels as codexModels, type CodexDefaultsSnapshot } from '../src/codexwire.ts';
import type { DefaultContext } from '../src/view/model-picks.ts';
import { DEMO_DEFAULTS, DEMO_MODELS, codexDefaultContext } from './demo-catalog.ts';

const refresh = process.argv.includes('--refresh');
const cwdIndex = process.argv.indexOf('--cwd');
const cwdValue = cwdIndex < 0 ? process.cwd() : process.argv[cwdIndex + 1];
const launchFolder = path.resolve(cwdValue ?? process.cwd());
const machine: Machine = {
  homeDir: os.homedir(),
  appData: process.env.APPDATA ?? '',
  pathEnv: process.env.PATH ?? '',
  claudeExtensionDir: '',
  codexExtensionDir: '',
  platform: process.platform,
  arch: process.arch,
  node: process.execPath,
  exists: fs.existsSync,
  canExecute: (file) => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
};

export function defaultsSnapshot(context: DefaultContext, snapshot: CodexDefaultsSnapshot | null): unknown {
  return snapshot ? snapshot.configuration : { applied: { model: context.base!.model, effort: context.base!.effort } };
}

// Model and effort variables that Claude reads, or that a parent Claude session exports, in any family or custom entry.
// Most of them change the catalog labels, the supported efforts, or the applied defaults. The rest are removed so that a parent session cannot pass them to the check.
const CLAUDE_MODEL_ENV_PATTERN =
  /^(ANTHROPIC_((DEFAULT_([A-Z]+_)?|SMALL_FAST_|CUSTOM_)?MODEL(_OPTION)?(_NAME|_DESCRIPTION|_SUPPORTED_CAPABILITIES)?)|CLAUDE_CODE_(EFFORT_LEVEL|SUBAGENT_MODEL|MODEL_CAPABILITIES|MODEL_CATALOG_URL|ALWAYS_ENABLE_EFFORT)|CLAUDE_EFFORT)$/;

// The check reads Claude's defaults without the user settings file or any personal model or effort variable.
// Project and local settings of the launch folder still apply. Every case variant of a variable is removed, including on Windows.
export function claudeCheckLaunch(
  folder: string,
  inherited: Record<string, string | undefined>,
  launchEnv: Record<string, string>,
): { args: string[]; env: Record<string, string | undefined> } {
  const env = childEnv(inherited, launchEnv, 'claude', folder);
  for (const key of Object.keys(env)) if (CLAUDE_MODEL_ENV_PATTERN.test(key.toUpperCase())) delete env[key];
  return {
    args: [...spawnArgs({ cwd: folder, persistSession: false }), '--setting-sources', 'project,local'],
    env,
  };
}

// The check reads Codex's catalog and defaults from a private home that holds only the signed-in account.
// The user's config file, profiles, and model or effort choices never reach the snapshots.
// Every case variant of an inherited CODEX_HOME is replaced, including on Windows.
export function codexCheckLaunch(
  home: string,
  inherited: Record<string, string | undefined>,
  launchEnv: Record<string, string>,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...inherited,
    ...launchEnv,
  };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'CODEX_HOME') delete env[key];
  env.CODEX_HOME = home;
  return env;
}

export interface PreparedCodexHome {
  home: string;
  // The user's account file, and the bytes copied from it. Only the copied bytes are null when the user has no account file.
  source: string;
  copied: Buffer | null;
  finished: boolean;
}

// Creates the private home and copies the account file only. The catalog depends on the signed-in account, and no other file of the user's Codex home is read.
export function prepareCodexHome(
  inherited: Record<string, string | undefined>,
  root: string = os.tmpdir(),
): PreparedCodexHome {
  const key = Object.keys(inherited).find((name) => name.toUpperCase() === 'CODEX_HOME');
  const source = path.join((key && inherited[key]) || path.join(os.homedir(), '.codex'), 'auth.json');
  const home = fs.mkdtempSync(path.join(root, 'arc-codex-home-'));
  const prepared: PreparedCodexHome = {
    home,
    source,
    copied: null,
    finished: false,
  };
  try {
    prepared.copied = fs.readFileSync(source);
    fs.writeFileSync(path.join(home, 'auth.json'), prepared.copied, {
      mode: 0o600,
    });
  } catch (error) {
    prepared.copied = null;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      fs.rmSync(home, { recursive: true, force: true });
      throw error;
    }
  }
  return prepared;
}

// Codex can rotate its refresh token inside the private copy. The refreshed file replaces the user's file only when the user's file still holds the bytes that were copied.
// A user's file that changed meanwhile came from the user's own refresh, so the private copy is discarded.
export function shouldWriteAccountBack(
  copied: Buffer | null,
  current: Buffer | null,
  original: Buffer | null,
): boolean {
  return copied !== null && current !== null && original !== null && !current.equals(copied) && original.equals(copied);
}

function readIfPresent(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

// Saves a refreshed account file and removes the private home. Each failure is returned as a message, so that cleanup never replaces the check result.
// A caller that stops Codex without waiting for it to exit passes saveAccount false, because the private file can be partly written.
export function finishCodexHome(prepared: PreparedCodexHome, saveAccount: boolean = true): string[] {
  if (prepared.finished) return [];
  prepared.finished = true;
  const problems: string[] = [];
  const current = readIfPresent(path.join(prepared.home, 'auth.json'));
  if (saveAccount && current && shouldWriteAccountBack(prepared.copied, current, readIfPresent(prepared.source))) {
    try {
      fs.writeFileSync(prepared.source, current);
    } catch {
      problems.push(
        `codex: could not save the refreshed Codex account file to ${prepared.source}. Sign in to Codex again if it asks.`,
      );
    }
  }
  try {
    fs.rmSync(prepared.home, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  } catch {
    problems.push(
      `codex: could not remove the temporary Codex home ${prepared.home}. It holds a copy of the Codex account file, so remove it by hand.`,
    );
  }
  return problems;
}

async function check(agent: 'claude' | 'codex'): Promise<void> {
  const launch =
    agent === 'codex'
      ? codexLaunch(process.env.ARC_CODEX_PATH ?? '', machine)
      : claudeLaunch(process.env.ARC_CLAUDE_PATH ?? '', machine);
  if (launch.problem) throw new Error('Configured CLI is unavailable.');
  const claude = agent === 'claude' ? claudeCheckLaunch(launchFolder, process.env, launch.env) : null;
  let prepared: PreparedCodexHome | null = null;
  let child: ChildProcessByStdio<Writable, Readable, null> | null = null;
  let wire: CodexWire | ClaudeWire | null = null;
  let lines: ReturnType<typeof createInterface> | null = null;
  let exited: Promise<void> = Promise.resolve();
  const interrupted = (signal: NodeJS.Signals): void => {
    child?.kill();
    if (prepared) for (const problem of finishCodexHome(prepared, false)) console.error(problem);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  if (agent === 'codex') {
    process.once('SIGINT', interrupted);
    process.once('SIGTERM', interrupted);
  }
  try {
    if (agent === 'codex') {
      prepared = prepareCodexHome(process.env);
      if (!prepared.copied)
        console.error(
          `codex: the Codex account file was not found at ${prepared.source}. The check runs signed out, so the catalog can lack account models.`,
        );
    }
    child = spawn(launch.command, [...launch.leadingArgs, ...(claude ? claude.args : appServerArgs())], {
      cwd: launchFolder,
      env: claude ? claude.env : codexCheckLaunch(prepared!.home, process.env, launch.env),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const spawned = child;
    exited = new Promise<void>((resolve) => {
      spawned.once('exit', () => resolve());
      spawned.once('error', () => resolve());
    });
    const options = {
      send: (line: string) => spawned.stdin.write(line),
      emit: () => {},
      deadlineMs: 30_000,
    };
    const connection =
      agent === 'codex'
        ? new CodexWire({
            ...options,
            cwd: launchFolder,
            clientInfo: {
              name: 'arc-demo-catalog',
              title: 'Arc demo catalog',
              version: '0.1.0',
            },
          })
        : new ClaudeWire(options);
    wire = connection;
    spawned.once('error', () => connection.close('CLI is unavailable.'));
    spawned.once('exit', () => connection.close('CLI exited.'));
    const reader = createInterface({ input: spawned.stdout });
    lines = reader;
    reader.on('line', (line) => connection.receive(line));
    await wire.initialize();
    const snapshot = wire instanceof CodexWire ? await wire.appliedDefaultsSnapshot(launchFolder) : null;
    const raw = wire instanceof CodexWire ? snapshot?.catalog : await wire.listModels();
    const context =
      wire instanceof CodexWire
        ? codexDefaultContext(snapshot?.configuration, raw, snapshot?.policy)
        : { base: await wire.appliedDefaults() };
    const decoded = agent === 'codex' ? codexModels(raw, 0) : claudeModels(raw, 0);
    if (!decoded || context.base?.status !== 'ready')
      throw new Error('CLI did not report models and applied defaults.');
    if (refresh) {
      const directory = path.join(__dirname, 'demo-catalog');
      const projected = defaultsSnapshot(context, snapshot);
      fs.writeFileSync(path.join(directory, `${agent}-models.json`), JSON.stringify(raw, null, 2) + '\n');
      fs.writeFileSync(path.join(directory, `${agent}-defaults.json`), JSON.stringify(projected, null, 2) + '\n');
      if (snapshot)
        fs.writeFileSync(
          path.join(directory, 'codex-requirements.json'),
          JSON.stringify(snapshot.policy, null, 2) + '\n',
        );
      console.log(`${agent}: refreshed prompt-free catalog and applied defaults.`);
    } else if (
      !isDeepStrictEqual(decoded.models, DEMO_MODELS[agent]) ||
      !isDeepStrictEqual(context, DEMO_DEFAULTS[agent])
    ) {
      console.error(
        `${agent}: snapshot is stale. Run scripts/demo-catalog-check.ts --refresh from extension, then review the changes.`,
      );
      process.exitCode = Math.max(Number(process.exitCode ?? 0), 1);
    } else console.log(`${agent}: snapshot matches the installed CLI.`);
  } finally {
    wire?.close('Catalog check finished.');
    lines?.close();
    child?.stdin.end();
    child?.kill();
    if (prepared) {
      await exited;
      for (const problem of finishCodexHome(prepared)) console.error(problem);
    }
    if (agent === 'codex') {
      process.off('SIGINT', interrupted);
      process.off('SIGTERM', interrupted);
    }
  }
}

async function main(): Promise<void> {
  if (cwdIndex >= 0 && (!cwdValue || cwdValue.startsWith('--'))) {
    console.error('--cwd requires a launch folder.');
    process.exitCode = 2;
    return;
  }
  for (const agent of ['codex', 'claude'] as const) {
    try {
      await check(agent);
    } catch (error) {
      console.error(`${agent}: current catalog evidence is unavailable. Snapshot freshness is unconfirmed.`);
      console.error(`${agent}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    }
  }
}
if (require.main === module) void main();
