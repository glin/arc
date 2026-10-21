import * as fs from 'node:fs';
import * as os from 'node:os';
import { BundledTools, readToolPackage, toolRoot, resolveToolRuntime } from './bundledtools';
import { ClaudePluginSetup, pluginTarget } from './claudeplugin';
import { claudeLaunch, type Machine } from './composerview';
import { claudeConfigHome } from './agentpaths';

// The source installer invokes the same durable staging used by the extension.
async function setup(): Promise<void> {
  const args = process.argv.slice(2);
  const checkout = args[0] === '--snapshots' && args.length === 3 && args[1] === '--checkout' ? args[2] : undefined;
  if ((!checkout && args.length !== 1) || !['--commands', '--snapshots'].includes(args[0]))
    throw new Error('Use --commands or --snapshots to select the Arc setup operation.');
  const tools = new BundledTools(readToolPackage(__dirname), toolRoot());
  const signal = new AbortController().signal;
  if (args[0] === '--commands') {
    console.log(await tools.installCommands(resolveToolRuntime(), signal));
    return;
  }
  const machine: Machine = {
    homeDir: os.homedir(),
    appData: process.env.APPDATA ?? '',
    pathEnv: process.env.PATH ?? process.env.Path ?? '',
    claudeExtensionDir: '',
    codexExtensionDir: '',
    platform: process.platform,
    arch: process.arch,
    node: process.execPath,
    exists: fs.existsSync,
    canExecute: (file) => {
      try {
        fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    },
  };
  const launch = claudeLaunch('', machine);
  if (launch.problem) throw new Error(launch.problem);
  const target = pluginTarget(process.cwd(), claudeConfigHome(), launch, os.hostname());
  target.checkout = checkout;
  console.log(await new ClaudePluginSetup(undefined, undefined, undefined, tools).install(target, signal));
}
void setup().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
