import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import { claudeLaunch, codexLaunch, type Machine } from '../src/composerview.ts';
import { ClaudeWire, spawnArgs, readModels as claudeModels } from '../src/claudewire.ts';
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

async function check(agent: 'claude' | 'codex'): Promise<void> {
  const launch =
    agent === 'codex'
      ? codexLaunch(process.env.ARC_CODEX_PATH ?? '', machine)
      : claudeLaunch(process.env.ARC_CLAUDE_PATH ?? '', machine);
  if (launch.problem) throw new Error('Configured CLI is unavailable.');
  const child = spawn(
    launch.command,
    [
      ...launch.leadingArgs,
      ...(agent === 'codex' ? appServerArgs() : spawnArgs({ cwd: launchFolder, persistSession: false })),
    ],
    {
      cwd: launchFolder,
      env: { ...process.env, ...launch.env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    },
  );
  const options = { send: (line: string) => child.stdin.write(line), emit: () => {}, deadlineMs: 30_000 };
  const wire =
    agent === 'codex'
      ? new CodexWire({
          ...options,
          cwd: launchFolder,
          clientInfo: { name: 'arc-demo-catalog', title: 'Arc demo catalog', version: '0.1.0' },
        })
      : new ClaudeWire(options);
  child.once('error', () => wire.close('CLI is unavailable.'));
  child.once('exit', () => wire.close('CLI exited.'));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => wire.receive(line));
  try {
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
    wire.close('Catalog check finished.');
    lines.close();
    child.stdin.end();
    child.kill();
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
    } catch {
      console.error(`${agent}: current catalog evidence is unavailable. Snapshot freshness is unconfirmed.`);
      process.exitCode = 2;
    }
  }
}
if (require.main === module) void main();
