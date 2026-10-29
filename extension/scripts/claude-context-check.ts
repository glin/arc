// Captures one `get_context_usage` reply from the installed Claude Code and runs the stored-reply check on it.
// One capture runs a short Haiku turn. The default test suites never run this script.
// Exit code 1 means the check failed on the reply. Exit code 2 means the capture or the script failed.

import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { childEnv } from '../src/agenthost.ts';
import { claudeConfigHome } from '../src/agentpaths.ts';
import { claudeLaunch, type Launch, type Machine } from '../src/composerview.ts';
import {
  attachmentKinds,
  checkClaudeContextReply,
  contextFixtureName,
  contextFixtureNames,
  contextFixtureReply,
  projectFolderNames,
  removeCreatedProjectFolders,
  type ClaudeContextFixture,
  type FolderSystem,
} from '../src/domain/claude-context-check.ts';
import { parseVersion } from '../src/domain/version.ts';
import { projectSlug } from '../src/transcript.ts';

const FIXTURES = path.join(__dirname, '..', 'test', 'fixtures');
const DEADLINE_MS = 180_000;
const EXIT_GRACE_MS = 10_000;
const PROMPT = 'Use the Read tool to read note.txt, then reply with its first word only.';

function parseArgs(args: string[]): { claude: string; write: boolean } {
  let claude = '';
  let write = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--write-fixture') write = true;
    else if (args[index] === '--claude' && args[index + 1]) claude = args[++index];
    else throw new Error(`Invalid argument: ${args[index]}`);
  }
  return { claude, write };
}

// The same machine description that the source-build installer gives `claudeLaunch`.
function hostMachine(): Machine {
  return {
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
}

const hostFolders: FolderSystem = {
  lstat: (target) => {
    try {
      return fs.lstatSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  },
  readdir: (target) => fs.readdirSync(target),
  rmdir: (target) => fs.rmdirSync(target),
};

function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Sends one user turn, waits for its result, then sends the control request that `ClaudeWire.contextUsage` sends.
async function capture(launch: Launch, cwd: string): Promise<unknown> {
  const args = [
    ...launch.leadingArgs,
    '-p',
    '--verbose',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--model',
    'haiku',
    '--no-session-persistence',
    '--allowedTools',
    'Read',
  ];
  const env = childEnv(process.env, launch.env, 'claude', cwd);
  const child = spawn(launch.command, args, { cwd, env, stdio: ['pipe', 'pipe', 'inherit'] });
  const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
  const exited = new Promise((resolve) => {
    child.once('exit', resolve);
    child.once('error', resolve);
  });
  let timer: NodeJS.Timeout | undefined;
  const reply = new Promise<unknown>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Claude Code sent no context reply before the deadline.')), DEADLINE_MS);
    let buffer = '';
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`Claude Code exited with code ${code} before its context reply.`)));
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        let event: { type?: unknown; response?: Record<string, unknown> };
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event?.type === 'result')
          send({
            type: 'control_request',
            request_id: 'context',
            request: { subtype: 'get_context_usage', detail: 'summary' },
          });
        const response = event?.type === 'control_response' ? event.response : undefined;
        if (response?.request_id === 'context') {
          if (response.subtype === 'success') resolve(response.response);
          else reject(new Error(`Claude Code refused the context request: ${String(response.error ?? 'no reason')}`));
        }
      }
    });
    send({ type: 'user', message: { role: 'user', content: PROMPT } });
  });
  try {
    return await reply;
  } finally {
    clearTimeout(timer);
    // Windows refuses to delete the working folder of a running process, so cleanup waits for the exit.
    child.stdin.end();
    if (!(await within(exited, EXIT_GRACE_MS))) {
      child.kill();
      if (!(await within(exited, EXIT_GRACE_MS))) console.error('Claude Code did not exit before cleanup.');
    }
  }
}

async function main(): Promise<void> {
  const { claude, write } = parseArgs(process.argv.slice(2));
  const launch = claudeLaunch(claude, hostMachine());
  if (launch.problem) throw new Error(launch.problem);
  const versionText = execFileSync(launch.command, [...launch.leadingArgs, '--version'], {
    encoding: 'utf8',
    env: childEnv(process.env, launch.env, 'claude'),
  });
  const version = /\d+\.\d+\.\d+\S*/.exec(versionText)?.[0] ?? '';
  if (!parseVersion(version)) throw new Error(`Claude Code reported no version: ${versionText}`);
  console.log(`Claude Code ${version}`);
  const names = contextFixtureNames(fs.readdirSync(FIXTURES));
  const stored = names.map(
    (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as ClaudeContextFixture,
  );
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arc-context-check-')));
  // Claude Code creates a project folder for the temporary cwd, even without session persistence.
  const projects = path.join(claudeConfigHome(), 'projects');
  const slug = projectSlug(cwd);
  const existing = projectFolderNames(hostFolders, projects, slug, process.platform);
  let reply: unknown;
  let failure: Error | undefined;
  try {
    fs.writeFileSync(path.join(cwd, 'note.txt'), 'Harbor lights mark the channel.\n');
    reply = await capture(launch, cwd);
  } catch (error) {
    failure = new Error(message(error));
  }
  const cleanup: string[] = [];
  try {
    fs.rmSync(cwd, { recursive: true, force: true });
  } catch (error) {
    cleanup.push(`Could not remove ${cwd}: ${message(error)}`);
  }
  try {
    const { kept } = removeCreatedProjectFolders(hostFolders, projects, slug, process.platform, existing);
    for (const folder of kept) cleanup.push(`Kept ${folder} because it holds files or links.`);
  } catch (error) {
    cleanup.push(`Could not remove the project folder for ${cwd}: ${message(error)}`);
  }
  for (const line of cleanup) console.error(line);
  if (failure) throw failure;
  const check = checkClaudeContextReply(reply, new Set(stored.flatMap((row) => attachmentKinds(row.reply))));
  const messages = check.detail.categories.find((row) => row.key === 'Messages')?.tokens;
  console.log(`Used ${check.detail.used}, Messages ${messages ?? 'absent'}`);
  for (const row of check.detail.messageBreakdown ?? []) console.log(`  ${row.name} ${row.tokens}`);
  for (const kind of check.newAttachmentKinds) console.log(`New attachment kind: ${kind}`);
  const fields = (reply as { messageBreakdown?: Record<string, unknown> } | undefined)?.messageBreakdown;
  for (const key of check.newMessageKeys) console.log(`New message key: ${key} ${JSON.stringify(fields?.[key])}`);
  for (const failed of check.failures) console.log(`Failed: ${failed}`);
  if (check.failures.length) {
    process.exitCode = 1;
    return;
  }
  console.log('Passed.');
  if (!write) return;
  const template = stored.at(-1)?.reply;
  if (!template) throw new Error('No stored reply supplies the keys to keep.');
  const file = path.join(FIXTURES, contextFixtureName(version));
  // A stored reply keeps the exact figures its tests assert, so a version keeps its first stored reply.
  if (fs.existsSync(file)) {
    console.log(`Kept ${file} because it already stores a reply from this version.`);
    return;
  }
  const fixture = { claudeCode: version, reply: contextFixtureReply(reply, template) };
  fs.writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`Wrote ${file}`);
}

main().catch((error: unknown) => {
  console.error(message(error));
  process.exitCode = 2;
});
