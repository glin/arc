import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ChildProcess, spawn } from 'node:child_process';
import * as childProcess from 'node:child_process';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { afterEach, test, vi } from 'vitest';
import { parseRun, runStandalone, runSupervisor } from '../src/run.ts';
import {
  backgroundIdentity,
  bindBackgroundLaunch,
  backgroundCommand,
  runBackgroundManagement,
  StandaloneFrames,
  registryStep,
  observeProcess,
  terminalPlan,
  waitStandalone,
  waitStandaloneIdentity,
  readNativeReport,
  superviseStandalone,
  standaloneProcessIdentity,
  produceStandaloneOutput,
  standaloneEnvironment,
} from '../src/standalone.ts';
import { DispatchReceipts } from '../../extension/src/dispatchreceipts.ts';
import { findCommand } from '../src/commands.ts';
import { payloadSha256 } from '../../extension/src/sessionwrites.ts';
import { projectSlug } from '../../extension/src/transcript.ts';
import { build } from 'esbuild';

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, statSync: vi.fn<typeof original.statSync>(original.statSync) };
});
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:os')>();
  return { ...original, homedir: vi.fn<typeof original.homedir>(original.homedir) };
});
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execute = promisify(original.execFile);
  return {
    ...original,
    spawn: vi.fn<typeof original.spawn>(original.spawn),
    execFile: Object.assign(vi.fn<typeof original.execFile>(original.execFile), {
      [promisify.custom]: vi.fn<typeof execute>(execute),
    }),
  };
});

const session = 'aaaaaaaa-1111-2222-3333-444444444444';
const homes: string[] = [];
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-standalone-'));
  homes.push(home);
  const prompt = path.join(home, 'prompt.txt');
  fs.writeFileSync(prompt, 'Review this folder.');
  const args = [
    '--provider',
    'codex',
    '--cwd',
    home,
    '--model',
    'gpt-6.1-sol',
    '--effort',
    'high',
    '--prompt-file',
    prompt,
  ];
  return { home, prompt, args };
}
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});
function frames() {
  const frame = new StandaloneFrames('codex', null);
  frame.line(JSON.stringify({ type: 'thread.started', thread_id: session }));
  frame.line('{"type":"turn.started"}');
  frame.line('{"type":"item.completed","item":{"type":"agent_message","id":"item_1","text":"Report"}}');
  return frame;
}
function receiptsFixture() {
  const { home, args } = fixture();
  const options = parseRun(args).options;
  const receipts = new DispatchReceipts(home);
  const launch = receipts.reserve({
    origin: 'a'.repeat(24),
    requester: null,
    policy: null,
    completion: 'wait',
    promptSha256: payloadSha256('Review this folder.'),
    alias: null,
    transport: 'standalone',
    standalone: options,
  });
  receipts.input(launch.launchId, 'Review this folder.');
  return { receipts, launch, options };
}
function workerFixture(extra = '', deadlineMs = 10_000, delayedMarker = false, explicitLog = false) {
  const { receipts, options } = receiptsFixture();
  const script = path.join(options.cwd, 'fake-worker.cjs');
  const started = path.join(options.cwd, 'started');
  const release = path.join(options.cwd, 'release');
  const markerRelease = path.join(options.cwd, 'marker-release');
  if (!delayedMarker) fs.writeFileSync(markerRelease, 'ready');
  fs.writeFileSync(
    script,
    `const fs=require('node:fs');const path=require('node:path');
const marker=()=>{if(!fs.existsSync(${JSON.stringify(markerRelease)}))return;markerWatcher.close();if(!fs.existsSync(${JSON.stringify(started)}))fs.appendFileSync(${JSON.stringify(started)},String(process.pid)+'\\n');};
const markerWatcher=fs.watch(${JSON.stringify(options.cwd)},marker);marker();
process.stdin.resume();process.stdin.on('end',()=>{
const release=${JSON.stringify(release)};
const finish=()=>{if(!fs.existsSync(release))return;watcher?.close();${extra}
fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],'Report');
for(const row of [{type:'thread.started',thread_id:'${session}'},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',id:'item_1',text:'Report'}},{type:'turn.completed'}])console.log(JSON.stringify(row));
console.error('Final stderr');};
const watcher=fs.watch(path.dirname(release),finish);finish();});`,
  );
  const launch = receipts.reserve({
    origin: 'c'.repeat(24),
    requester: null,
    policy: null,
    completion: 'wait',
    promptSha256: payloadSha256('Review this folder.'),
    alias: null,
    transport: 'standalone',
    standalone: {
      ...options,
      command: process.execPath,
      args: [script],
      deadlineMs,
      ...(explicitLog ? { logAlias: path.join(options.cwd, 'worker-output.log') } : {}),
    },
  });
  receipts.input(launch.launchId, 'Review this folder.');
  return { receipts, launch, options, script, started, release, markerRelease };
}
test('standalone policy and literal argv preserve directories across platforms', () => {
  const { home, args } = fixture();
  const extra = path.join(home, 'extra $() ` quoted');
  fs.mkdirSync(extra);
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    const parsed = parseRun(
      [...args, '--read-only', '--add-dir', extra, '--add-dir', home],
      { CODEX_BIN: 'owned-codex' },
      platform,
    );
    assert.equal(parsed.options.command, 'owned-codex');
    assert.deepEqual(parsed.options.args.slice(0, 5), ['exec', '-C', home, '-s', 'read-only']);
    assert.deepEqual(parsed.options.args.slice(-4), ['--add-dir', extra, '--add-dir', home]);
    assert.equal(parsed.policy?.readOnly, true);
  }
  const claude = parseRun([...args.map((value, i) => (i === 1 ? 'claude' : value)), '--read-only']);
  assert.ok(claude.options.args.includes('-p'));
  assert.ok(claude.options.args.includes('--strict-mcp-config'));
});
test('standalone model selection preserves legacy aliases and configured provider boundaries', () => {
  const { home, args } = fixture();
  const env = { CODEX_BIN: 'owned-codex', CODEX_HOME: home };
  const aliases = {
    sol: 'gpt-6.1-sol',
    sol6: 'gpt-6-sol',
    terra: 'gpt-5.6-terra',
    luna: 'gpt-6-luna',
    luna6: 'gpt-6-luna',
    astra: 'gpt-6-astra',
  };
  const check = (input: string, expected: string) => {
    const parsed = parseRun(
      args.map((value, i) => (i === 5 ? input : value)),
      env,
    );
    assert.equal(parsed.options.model, expected);
    assert.equal(parsed.options.args[parsed.options.args.indexOf('-m') + 1], expected);
    assert.equal(
      parsed.options.args[parsed.options.args.indexOf('-c', parsed.options.args.indexOf('-m')) + 1],
      'model_reasoning_effort=high',
    );
  };
  for (const [alias, model] of Object.entries(aliases)) check(alias, model);
  for (const model of ['gpt-5.6-sol-2026-09-01', 'openai.gpt-6-astra', 'custom.model', 'constructor'])
    check(model, model);
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    '# model_provider = "amazon-bedrock"\nmodel_provider = "openai"\n[model_providers.custom]\nmodel_provider = "amazon-bedrock"\n',
  );
  check('sol', 'gpt-6.1-sol');
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    "model_provider = 'amazon-bedrock' # selected\n[profiles.other]\nmodel_provider = 'openai'\n",
  );
  for (const [alias, model] of Object.entries(aliases)) check(alias, `openai.${model}`);
  check('gpt-5.6-sol-2026-09-01', 'openai.gpt-5.6-sol-2026-09-01');
  check('openai.gpt-6-astra', 'openai.gpt-6-astra');
  check('custom.model', 'custom.model');
  fs.writeFileSync(path.join(home, 'config.toml'), '[profiles.other]\nmodel_provider = "amazon-bedrock"\n');
  check('sol', 'gpt-6.1-sol');
  const claudeArgs = args.map((value, i) => (i === 1 ? 'claude' : i === 5 ? 'haiku' : value));
  const claude = parseRun([...claudeArgs, '--read-only'], env);
  assert.equal(claude.options.model, 'claude-haiku-5-5');
  assert.equal(claude.options.args[claude.options.args.indexOf('--model') + 1], 'claude-haiku-5-5');
  assert.equal(claude.options.args[claude.options.args.indexOf('--permission-mode') + 1], 'auto');
});

test('relative launch selectors use the launch roots for admission and retained execution', () => {
  const { home, args } = fixture();
  const caller = fs.mkdtempSync(path.join(process.cwd(), '.arc-selector-'));
  homes.push(caller);
  const selector = path.relative(process.cwd(), caller);
  const selected = path.resolve(home, selector);
  fs.mkdirSync(selected, { recursive: true });
  for (const [callerProvider, launchProvider, expected] of [
    ['openai', 'amazon-bedrock', 'openai.gpt-6.1-sol'],
    ['amazon-bedrock', 'openai', 'gpt-6.1-sol'],
  ]) {
    fs.writeFileSync(path.join(caller, 'config.toml'), `model_provider = "${callerProvider}"`);
    fs.writeFileSync(path.join(selected, 'config.toml'), `model_provider = "${launchProvider}"`);
    const parsed = parseRun(args, { CODEX_BIN: process.execPath, CODEX_HOME: selector });
    assert.equal(parsed.options.model, expected);
    assert.equal(parsed.options.env!.CODEX_HOME, selected);
    assert.equal(standaloneEnvironment(parsed.options).CODEX_HOME, selected);
  }
  fs.writeFileSync(path.join(caller, '.claude.json'), JSON.stringify({ mcpServers: { owned: { command: 'caller' } } }));
  fs.writeFileSync(
    path.join(selected, '.claude.json'),
    JSON.stringify({ mcpServers: { owned: { command: 'launch' } } }),
  );
  const parsed = parseRun(
    [...args.map((value, i) => (i === 1 ? 'claude' : value)), '--read-only', '--read-tool', 'mcp__owned__read'],
    { CLAUDE_BIN: process.execPath, CLAUDE_CONFIG_DIR: selector },
  );
  assert.equal(parsed.options.env!.CLAUDE_CONFIG_DIR, selected);
  assert.equal(standaloneEnvironment(parsed.options).CLAUDE_CONFIG_DIR, selected);
  assert.deepEqual(JSON.parse(parsed.options.args[parsed.options.args.indexOf('--mcp-config') + 1]), {
    mcpServers: { owned: { command: 'launch' } },
  });
});

test('absent Claude selection preserves default configuration and original transcript roots', () => {
  const { home, args } = fixture();
  vi.mocked(os.homedir).mockReturnValue(home);
  const custom = path.join(home, 'custom');
  fs.mkdirSync(path.join(home, '.claude'));
  fs.mkdirSync(custom);
  const config = (command: string) => JSON.stringify({ mcpServers: { owned: { command } } });
  fs.writeFileSync(path.join(home, '.claude.json'), config('default'));
  fs.writeFileSync(path.join(home, '.claude', '.claude.json'), config('transcript-directory'));
  fs.writeFileSync(path.join(custom, '.claude.json'), config('custom'));
  const claudeArgs = [
    ...args.map((value, i) => (i === 1 ? 'claude' : value)),
    '--read-only',
    '--read-tool',
    'mcp__owned__read',
  ];
  for (const explicit of [false, true]) {
    const parsed = parseRun(claudeArgs, {
      CLAUDE_BIN: process.execPath,
      HOME: home,
      USERPROFILE: home,
      ...(explicit ? { CLAUDE_CONFIG_DIR: custom } : {}),
    });
    const original = explicit ? custom : path.join(home, '.claude');
    const later = standaloneEnvironment(parsed.options, {
      HOME: 'foreign-home',
      USERPROFILE: 'foreign-profile',
      CLAUDE_CONFIG_DIR: 'foreign-claude',
      ARC_PROJECTS_ROOT: 'foreign-projects',
    });
    assert.equal(later.CLAUDE_CONFIG_DIR, explicit ? custom : undefined);
    assert.equal(later.HOME, home);
    assert.equal(later.USERPROFILE, home);
    assert.equal(later.ARC_PROJECTS_ROOT, path.join(original, 'projects'));
    assert.deepEqual(JSON.parse(parsed.options.args[parsed.options.args.indexOf('--mcp-config') + 1]), {
      mcpServers: { owned: { command: explicit ? 'custom' : 'default' } },
    });
  }
});

test('oversized selected MCP settings refuse before launch reservation and provider execution', async () => {
  const { home, args } = fixture();
  const receipts = new DispatchReceipts(home);
  const report = path.join(home, 'report.md');
  const log = path.join(home, 'output.log');
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({
      mcpServers: { owned: { command: 'synthetic', args: ['x'.repeat(60 * 1024)] } },
    }),
  );
  await assert.rejects(
    runStandalone(
      [
        ...args.map((value, i) => (i === 1 ? 'claude' : value)),
        '--read-only',
        '--read-tool',
        'mcp__owned__read',
        '--report-file',
        report,
        '--log',
        log,
      ],
      'unused-entry',
      {
        env: { CLAUDE_BIN: process.execPath, CLAUDE_CONFIG_DIR: home },
        receipts,
      },
    ),
    /launch settings exceed the dispatch receipt allowance/,
  );
  assert.deepEqual(fs.readdirSync(receipts.root), []);
  assert.equal(fs.existsSync(report), false);
  assert.equal(fs.existsSync(log), false);
  assert.equal(vi.mocked(childProcess.spawn).mock.calls.length, 0);
});

test('complete serialized launch receipts enforce the byte boundary including selectors and escaping', () => {
  const { receipts, launch } = receiptsFixture();
  const limit = 48 * 1024;
  const input = {
    ...launch,
    alias: path.join(launch.standalone!.cwd, 'report.md'),
    standalone: {
      ...launch.standalone!,
      logAlias: path.join(launch.standalone!.cwd, 'output.log'),
      env: { ...launch.standalone!.env, HOME: 'quoted " home \\ newline\n' },
      args: [''],
    },
  };
  const measured = receipts.reserve(input);
  const base = Buffer.byteLength(JSON.stringify(measured));
  input.standalone.args = ['x'.repeat(limit - base)];
  const under = receipts.reserve(input);
  assert.equal(Buffer.byteLength(JSON.stringify(under)), limit);
  assert.deepEqual(receipts.launch(under.launchId), under);
  const before = fs.readdirSync(receipts.root).sort();
  input.standalone.args[0] += '\n';
  assert.throws(() => receipts.reserve(input), /launch settings exceed the dispatch receipt allowance/);
  assert.deepEqual(fs.readdirSync(receipts.root).sort(), before);
  assert.equal(fs.existsSync(input.alias), false);
  assert.equal(fs.existsSync(input.standalone.logAlias), false);
});

test.each(['claude', '/bin/sh'])(
  'large MCP observation retains %s identity and recovers original output',
  async (command) => {
    vi.useFakeTimers();
    const { home, args } = fixture();
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: { owned: { command: 'synthetic', args: ['x'.repeat(30 * 1024)] } },
      }),
    );
    const parsed = parseRun(
      [...args.map((value, i) => (i === 1 ? 'claude' : value)), '--read-only', '--read-tool', 'mcp__owned__read'],
      { CLAUDE_BIN: command, CLAUDE_CONFIG_DIR: home },
      'linux',
    );
    const receipts = new DispatchReceipts(home);
    const launch = receipts.reserve({
      origin: 'a'.repeat(24),
      requester: null,
      policy: parsed.policy,
      completion: 'manual',
      promptSha256: payloadSha256(parsed.prompt),
      alias: null,
      transport: 'standalone',
      standalone: { ...parsed.options, deadlineMs: 10 },
    });
    receipts.input(launch.launchId, parsed.prompt);
    const child = new ChildProcess();
    Object.assign(child, { stdin: new PassThrough(), pid: process.pid });
    vi.mocked(childProcess.spawn).mockReturnValue(child);
    const native = {
      command,
      startedAt: 'original-linux-lifetime',
      commandLine: [command, ...parsed.options.args].join('\0') + '\0',
    };
    const pending = superviseStandalone(receipts, launch.launchId, false, undefined, {
      now: Date.now,
      identity: async () => native,
      yield: async () => {},
    }).then(
      () => null,
      (error) => error,
    );
    await vi.advanceTimersByTimeAsync(10);
    assert.equal(await pending, null, 'admitted MCP output must publish a readable native observation');
    const observed = receipts.observation(launch.launchId)!;
    const original = command === 'claude' ? observed.worker : observed.launcher;
    assert.ok(original);
    assert.equal(observed.worker === null, command !== 'claude');
    assert.equal(original.pid, process.pid);
    assert.equal(original.command, command);
    assert.equal(original.startedAt, native.startedAt);
    assert.equal(original.argsSha256, payloadSha256(JSON.stringify(parsed.options.args)));
    assert.equal(original.commandLineSha256, payloadSha256(native.commandLine));
    assert.ok(Buffer.byteLength(JSON.stringify(observed)) <= 48 * 1024);
    assert.deepEqual(receipts.launch(launch.launchId).standalone!.args, parsed.options.args);
    await superviseStandalone(receipts, launch.launchId, true, undefined, {
      now: Date.now,
      identity: async () => ({ ...native, startedAt: 'different-lifetime' }),
      yield: async () => {},
    });
    assert.equal(receipts.latest(launch.launchId)!.availability, 'pending');
    assert.equal(receipts.observation(launch.launchId)!.monitor, 'unavailable');
    fs.writeFileSync(
      receipts.artifact(launch.launchId, 'stdout.log'),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        session_id: parsed.options.sessionHint,
        result: 'Original report',
        is_error: false,
      }) + '\n',
    );
    await superviseStandalone(receipts, launch.launchId, true, undefined, {
      now: Date.now,
      identity: async () => ({ ...native, commandLine: 'same lifetime changed command' }),
      yield: async () => {},
    });
    const event = receipts.latest(launch.launchId)!;
    assert.equal(event.availability, 'available');
    assert.equal((receipts.result(launch.launchId, event.eventId) as any).text, 'Original report');
    assert.deepEqual(receipts.observation(launch.launchId)![command === 'claude' ? 'worker' : 'launcher'], original);
    assert.equal(vi.mocked(childProcess.spawn).mock.calls.length, 1);
  },
);

test('unsupported process scalar refuses before reservation, aliases, and provider start', async () => {
  const { home, args } = fixture();
  const receipts = new DispatchReceipts(home);
  const report = path.join(home, 'report.md');
  const log = path.join(home, 'output.log');
  vi.mocked(childProcess.spawn).mockImplementation(() => {
    throw new Error('The unsupported launch reached supervisor start.');
  });
  await assert.rejects(
    runStandalone([...args, '--report-file', report, '--log', log], 'unused-entry', {
      env: { CODEX_BIN: 'x'.repeat(20 * 1024), CODEX_HOME: home },
      receipts,
    }),
    /launch identity or worker observation exceeds the dispatch status allowance/,
  );
  assert.deepEqual(fs.readdirSync(receipts.root), []);
  assert.equal(fs.existsSync(report), false);
  assert.equal(fs.existsSync(log), false);
  assert.equal(vi.mocked(childProcess.spawn).mock.calls.length, 0);
});

test('standalone configured Windows shims retain their own package beside unrelated global installs', () => {
  const { home, args } = fixture();
  const appData = 'C:\\Unrelated Global';
  const bin = 'D:\\MiXeD Tools\\安装';
  for (const provider of ['claude', 'codex'] as const) {
    const parts = provider === 'claude' ? '@anthropic-ai\\claude-code\\cli.js' : '@openai\\codex\\bin\\codex.js';
    const selected = `${bin}\\node_modules\\${parts}`;
    const global = `${appData}\\npm\\node_modules\\${parts}`;
    const files = new Set([selected, global]);
    vi.spyOn(fs, 'existsSync').mockImplementation((file) => files.has(String(file)));
    const env = { APPDATA: appData, CODEX_HOME: home, [`${provider.toUpperCase()}_BIN`]: `${bin}\\${provider}.CmD` };
    const input = args.map((value, i) => (i === 1 ? provider : value));
    const parsed = parseRun(input, env, 'win32');
    assert.equal(parsed.options.command, process.execPath);
    assert.equal(parsed.options.args[0], selected);
    files.delete(selected);
    assert.throws(() => parseRun(input, env, 'win32'), /batch shim/);
    vi.restoreAllMocks();
  }
});

test('standalone launch argv preserves platform executables and explicit permission and effort choices', () => {
  const { home, args } = fixture();
  const cases = [
    { platform: 'win32', command: 'D:\\MiXeD Tools\\代理 $()` &.EXE' },
    { platform: 'darwin', command: '/Applications/MiXeD Tools/代理 $()` &' },
    { platform: 'linux', command: '/opt/MiXeD Tools/代理 $()` &' },
  ] as const;
  for (const { platform, command } of cases) {
    for (const permission of ['workspace-write', 'danger-full-access']) {
      const parsed = parseRun(
        [...args.map((v, i) => (i === 7 ? 'xhigh' : v)), '--permissions', permission],
        { CODEX_BIN: command, CODEX_HOME: home },
        platform,
      );
      assert.equal(parsed.options.command, command);
      assert.deepEqual(parsed.options.args, [
        'exec',
        '-C',
        home,
        '-s',
        permission,
        '--json',
        '-c',
        'approval_policy="never"',
        '-c',
        'approvals_reviewer="user"',
        '-m',
        'gpt-6.1-sol',
        '-c',
        'model_reasoning_effort=xhigh',
      ]);
    }
    const readonly = parseRun([...args, '--read-only'], { CODEX_BIN: command, CODEX_HOME: home }, platform);
    assert.deepEqual(readonly.options.args.slice(0, 10), [
      'exec',
      '-C',
      home,
      '-s',
      'read-only',
      '--json',
      '-c',
      'approval_policy="never"',
      '-c',
      'approvals_reviewer="user"',
    ]);
    const claudeArgs = args.map((v, i) => (i === 1 ? 'claude' : i === 5 ? 'claude-opus-4-5-20251101' : v));
    for (const permission of ['auto', 'default', 'acceptEdits', 'dontAsk', 'bypassPermissions', 'plan']) {
      const parsed = parseRun([...claudeArgs, '--permissions', permission], { CLAUDE_BIN: command }, platform);
      assert.equal(parsed.options.command, command);
      assert.equal(parsed.options.args[parsed.options.args.indexOf('--permission-mode') + 1], permission);
      assert.equal(parsed.options.args[parsed.options.args.indexOf('--model') + 1], 'claude-opus-4-5-20251101');
    }
    const readonlyClaude = parseRun([...claudeArgs, '--read-only'], { CLAUDE_BIN: command }, platform);
    assert.equal(readonlyClaude.options.args[readonlyClaude.options.args.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.ok(readonlyClaude.options.args.includes('Bash(git -C * commit *)'));
    assert.ok(readonlyClaude.options.args.includes('Bash(git * --output*)'));
    assert.ok(readonlyClaude.options.args.includes('{"disableAllHooks":true}'));
    assert.equal(readonlyClaude.options.args[readonlyClaude.options.args.indexOf('--setting-sources') + 1], '');
  }
});

test('standalone configured Codex npm shims retain native package environment', () => {
  const { home, args } = fixture();
  const bin = 'D:\\MiXeD Tools\\npm';
  const root = `${bin}\\node_modules\\@openai\\codex`;
  const script = `${root}\\bin\\codex.js`;
  const binary = `${root}\\node_modules\\@openai\\codex-win32-${process.arch}\\vendor\\${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc\\bin\\codex.exe`;
  vi.spyOn(fs, 'existsSync').mockImplementation((file) => [script, binary].includes(String(file)));
  const parsed = parseRun(args, { CODEX_BIN: `${bin}\\codex.BaT`, CODEX_HOME: home }, 'win32');
  if (process.arch === 'arm64' || process.arch === 'x64') {
    assert.equal(parsed.options.command, binary);
    assert.equal(parsed.env.CODEX_MANAGED_PACKAGE_ROOT, root);
    assert.equal(parsed.env.CODEX_MANAGED_BY_NPM, '1');
    assert.equal(parsed.options.args[0], 'exec');
  } else {
    assert.equal(parsed.options.command, process.execPath);
    assert.equal(parsed.options.args[0], script);
  }
});

test('standalone Windows configured shell scripts use explicit Bash with literal argv', () => {
  const { home, args } = fixture();
  const script = path.join(home, 'MiXeD shell 代理 $()`');
  fs.writeFileSync(script, '#!/usr/bin/env bash\n');
  const parsed = parseRun(
    args,
    { CODEX_BIN: script, CODEX_HOME: home, DISPATCH_CLI_BASH: 'D:\\Git Tools\\bin\\bash.exe' },
    'win32',
  );
  assert.equal(parsed.options.command, 'D:\\Git Tools\\bin\\bash.exe');
  assert.equal(parsed.options.args[0], path.resolve(script).replaceAll('\\', '/'));
  assert.equal(parsed.options.args[1], 'exec');
  assert.equal(parseRun(args, { CODEX_BIN: script, CODEX_HOME: home }, 'linux').options.command, script);
  assert.equal(parseRun(args, { CODEX_BIN: script, CODEX_HOME: home }, 'darwin').options.command, script);
});

test('standalone delegated Claude cache defaults preserve caller overrides and reader defaults', () => {
  const { args } = fixture();
  const input = args.map((v, i) => (i === 1 ? 'claude' : v));
  for (const readOnly of [false, true]) {
    const selected = readOnly ? [...input, '--read-only'] : input;
    const inherited = {
      CLAUDE_BIN: 'owned-claude',
      CODEX_THREAD_ID: session,
      ARC_WINDOW: 'old-window',
      ARC_EDITOR_EXECUTABLE: 'old-editor',
    };
    const delegated = parseRun([...selected, '--agent-run'], inherited);
    assert.equal(delegated.env.CLAUDE_CODE_PROMPT_CACHE_TTL, '5m');
    assert.equal(delegated.env.CODEX_THREAD_ID, undefined);
    assert.equal(delegated.env.ARC_WINDOW, undefined);
    assert.equal(delegated.env.ARC_EDITOR_EXECUTABLE, undefined);
    assert.equal(parseRun(selected, inherited).env.CLAUDE_CODE_PROMPT_CACHE_TTL, undefined);
    assert.equal(parseRun([...selected, '--agent-run=false'], inherited).env.CLAUDE_CODE_PROMPT_CACHE_TTL, undefined);
    assert.equal(
      parseRun([...selected, '--agent-run'], { ...inherited, CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }).env
        .CLAUDE_CODE_PROMPT_CACHE_TTL,
      '1h',
    );
    assert.equal(
      parseRun([...selected, '--agent-run'], { ...inherited, claude_code_prompt_cache_ttl: '10m' }).env
        .claude_code_prompt_cache_ttl,
      '10m',
    );
  }
});

test('unsupported completion, widened policy, worktree flags and malformed UTF-8 refuse admission', () => {
  const { args, prompt } = fixture();
  for (const tail of [
    ['--completion', 'callback'],
    ['--notify-thread', session],
    ['--worktree'],
    ['--read-only', '--permissions', 'danger-full-access'],
    ['--agent-run', '--agent-run=false'],
  ])
    assert.throws(() => parseRun([...args, ...tail]));
  fs.writeFileSync(prompt, Buffer.from([0xc3, 0x28]));
  assert.throws(() => parseRun(args));
  fs.writeFileSync(prompt, '/compact');
  assert.throws(() => parseRun(args));
});
test('process exit never substitutes for final native evidence and reports must agree', () => {
  assert.equal(frames().finish(0, null, 'Report').outcome, 'unknown');
  const frame = frames();
  frame.line('{"type":"turn.completed"}');
  assert.equal(frame.finish(0, null, 'Report').outcome, 'succeeded');
  assert.equal(frame.finish(1, null, 'Report').outcome, 'unknown');
  assert.equal(frame.finish(0, null, 'Other').availability, 'unavailable');
  assert.equal(frame.finish(0, null, null).availability, 'unavailable');
  frame.line('{"type":"thread.started","thread_id":"bbbbbbbb-1111-2222-3333-444444444444"}');
  assert.equal(frame.finish(0, null).outcome, 'unknown');
});
test('Claude print requires the launched identity and preserves provider failure', () => {
  const final = { type: 'result', subtype: 'success', is_error: false, session_id: session, result: 'Final' };
  const frame = new StandaloneFrames('claude', session);
  frame.line(JSON.stringify(final));
  assert.equal(frame.finish(0, null).text, 'Final');
  const stale = new StandaloneFrames('claude', 'bbbbbbbb-1111-2222-3333-444444444444');
  stale.line(JSON.stringify(final));
  assert.equal(stale.finish(0, null).availability, 'pending');
  const failure = new StandaloneFrames('claude', session);
  failure.line(JSON.stringify({ ...final, subtype: 'error_during_execution', is_error: true }));
  assert.equal(failure.finish(1, null).outcome, 'failed');
});
test('registry disappearance, blocked grace, malformed snapshots and colliding IDs retain uncertainty', () => {
  const state = { started: 0, seen: false, blockedAt: null, errors: 0 };
  assert.equal(registryStep(state, '[]', session, 59_999).done, false);
  const working = JSON.stringify([{ id: session, state: 'working' }]);
  assert.equal(registryStep(state, working, session, 60_000).done, false);
  assert.equal(registryStep(state, '[]', session, 60_001).outcome, 'unknown');
  const blocked = JSON.stringify([{ id: session, state: 'blocked' }]);
  registryStep(state, blocked, session, 70_000);
  assert.equal(registryStep(state, blocked, session, 114_999).done, false);
  assert.equal(registryStep(state, blocked, session, 115_000).done, true);
  assert.equal(registryStep(state, null, session, 115_001).done, false);
  registryStep(state, 'not-json', session, 115_002);
  assert.equal(registryStep(state, '{}', session, 115_003).done, true);
  const structure = registryStep(state, JSON.stringify({ sessions: 'private-value', count: 5 }), session, 115_004);
  assert.match(structure.reason, /top-level object, keys "sessions":string, "count":number/);
  assert.equal(structure.reason.includes('private-value'), false);
  const malformedRow = registryStep(state, '[null]', session, 115_005);
  assert.match(malformedRow.reason, /top-level array, row 0: null/);
  const idless = registryStep(state, '[{"kind":"interactive"},{"id":7}]', session, 115_006);
  assert.equal(idless.outcome, 'unknown');
  assert.equal(idless.entry, undefined);
  assert.ok(structure.reason.length <= 352);
  assert.equal(
    registryStep(
      state,
      JSON.stringify([{ id: session }, { id: 'aaaaaaaa-9999-2222-3333-444444444444' }]),
      'aaaaaaaa',
      0,
    ).done,
    true,
  );
  assert.equal(backgroundIdentity(`backgrounded · ${session} · task`, 'task'), session);
  assert.equal(backgroundIdentity(`backgrounded · ${session} · task\nbackgrounded · ${session} · task`, 'task'), null);
});
test('finite observation timeout leaves the worker untouched', async () => {
  vi.useFakeTimers();
  const { options } = receiptsFixture();
  const child = new ChildProcess();
  const unref = vi.spyOn(child, 'unref').mockImplementation(() => {});
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  const work = observeProcess(
    child,
    { ...options, deadlineMs: 10 },
    () => {},
    0,
    0,
    () => [],
  );
  await vi.advanceTimersByTimeAsync(10);
  assert.equal((await work).timedOut, true);
  assert.equal(kill.mock.calls.length, 0);
  assert.equal(unref.mock.calls.length, 1);
});
test('receipt monitor claims stay exclusive and output aliases never provide authority', () => {
  const { receipts, launch } = receiptsFixture();
  const first = receipts.monitor(launch.launchId);
  assert.throws(() => receipts.monitor(launch.launchId));
  first.release();
  const next = receipts.monitor(launch.launchId);
  assert.notEqual(first.token, next.token);
  next.release();
  const report = receipts.publish(
    launch.launchId,
    { outcome: 'succeeded', availability: 'available', nativeEnding: { native: true }, askId: null },
    'Report',
  );
  assert.equal((receipts.result(launch.launchId, report.eventId) as { text: string }).text, 'Report');
  assert.equal(new DispatchReceipts(path.dirname(receipts.root)).launch(launch.launchId).transport, 'standalone');
});
test('wait deadlines use a controlled clock and never start a worker', async () => {
  vi.useFakeTimers();
  const { receipts, launch } = receiptsFixture();
  const waited = waitStandalone(receipts, launch.launchId, 25);
  await vi.advanceTimersByTimeAsync(25);
  assert.deepEqual(await waited, { launchId: launch.launchId, state: 'deadline' });
});
test('native report rejects missing, empty, oversized and invalid UTF-8 files', () => {
  const { home } = fixture();
  const file = path.join(home, 'native.md');
  assert.equal(readNativeReport(file), null);
  fs.writeFileSync(file, '');
  assert.equal(readNativeReport(file), null);
  fs.writeFileSync(file, Buffer.from([0xff]));
  assert.equal(readNativeReport(file), null);
  fs.writeFileSync(file, Buffer.alloc(8 * 1024 * 1024 + 1));
  assert.equal(readNativeReport(file), null);
  fs.writeFileSync(file, 'Native report');
  assert.equal(readNativeReport(file), 'Native report');
});
test('attended terminal selection preserves literal script paths on each platform', () => {
  const { home } = fixture();
  const file = (name: string) => path.join(home, name);
  const windows = terminalPlan(
    'node.exe',
    ['arc.cjs', 'id $()'],
    home,
    file('windows.sh'),
    'win32',
    { PATH: home, DISPATCH_CLI_BASH: 'bash.exe' },
    () => true,
  );
  assert.ok(windows.command.endsWith('wt.exe'));
  assert.equal(windows.args.at(-1), file('windows.sh').replaceAll('\\', '/'));
  assert.equal(terminalPlan('node', [], home, file('mac.sh'), 'darwin', {}).command, 'osascript');
  assert.equal(terminalPlan('node', [], home, file('tmux.sh'), 'linux', { TMUX: 'owned' }).command, 'tmux');
  assert.ok(
    terminalPlan('node', [], home, file('linux.sh'), 'linux', { PATH: '/usr/bin' }, () => true).command.endsWith(
      'x-terminal-emulator',
    ),
  );
});

test('attended refusals happen before receipt reservation or process launch', async () => {
  const { home, args } = fixture();
  const receipts = new DispatchReceipts(home);
  const reserve = vi.spyOn(receipts, 'reserve');
  vi.mocked(childProcess.spawn).mockImplementation(() => {
    const child = new ChildProcess();
    queueMicrotask(() => child.emit('error', new Error('unexpected launch')));
    return child;
  });
  const env = { CODEX_BIN: process.execPath, CLAUDE_BIN: process.execPath, PATH: '' };
  for (const platform of ['win32', 'linux'] as const) {
    await assert.rejects(
      runStandalone([...args, '--attach'], 'arc.cjs', { env, platform, receipts, exists: () => false }),
      /terminal|required/i,
    );
  }
  await assert.rejects(
    runStandalone([...args, '--attach', '--completion', 'wait'], 'arc.cjs', { env, receipts }),
    /wait is unsupported/,
  );
  await assert.rejects(
    runStandalone([...args.slice(0, 1), 'claude', ...args.slice(2), '--attach', '--read-only'], 'arc.cjs', {
      env,
      receipts,
    }),
    /unsupported with Claude --read-only/,
  );
  assert.equal(reserve.mock.calls.length, 0);
  assert.equal(vi.mocked(childProcess.spawn).mock.calls.length, 0);
  assert.equal(fs.existsSync(receipts.root), false);
});

test('attended public launches select both Git Bash layouts and literal platform terminal arguments', async () => {
  const cases = [
    {
      platform: 'win32',
      env: { PATH: String.raw`C:\Git\cmd;C:\Terminal` },
      files: [String.raw`C:\Git\cmd\git.exe`, String.raw`C:\Git\bin\bash.exe`, String.raw`C:\Terminal\wt.exe`],
      command: String.raw`C:\Terminal\wt.exe`,
      prefix: ['-d'],
    },
    {
      platform: 'win32',
      env: { PATH: String.raw`C:\Git\mingw64\bin;C:\Terminal` },
      files: [
        String.raw`C:\Git\mingw64\bin\git.exe`,
        String.raw`C:\Git\usr\bin\bash.exe`,
        String.raw`C:\Terminal\wt.exe`,
      ],
      command: String.raw`C:\Terminal\wt.exe`,
      prefix: ['-d'],
    },
    { platform: 'darwin', env: {}, files: [], command: 'osascript', prefix: ['-e'] },
    { platform: 'linux', env: { TMUX: 'owned' }, files: [], command: 'tmux', prefix: ['new-window'] },
    {
      platform: 'linux',
      env: { PATH: '/usr/bin' },
      files: ['/usr/bin/x-terminal-emulator'],
      command: '/usr/bin/x-terminal-emulator',
      prefix: ['-e', 'bash'],
    },
    {
      platform: 'linux',
      env: { PATH: '/usr/bin' },
      files: ['/usr/bin/gnome-terminal'],
      command: '/usr/bin/gnome-terminal',
      prefix: ['--', 'bash'],
    },
  ] as const;
  for (const item of cases) {
    const { home, args } = fixture();
    const receipts = new DispatchReceipts(home);
    const child = new ChildProcess();
    const unref = vi.spyOn(child, 'unref').mockImplementation(() => {});
    vi.mocked(childProcess.spawn).mockImplementationOnce(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    const entry = path.join(home, "Arc élève $() ' &.cjs");
    const result = JSON.parse(
      await runStandalone([...args, '--attach', '--agent-run'], entry, {
        env: { ...item.env, CODEX_BIN: process.execPath },
        platform: item.platform,
        receipts,
        exists: (file) => (item.files as readonly string[]).includes(String(file)),
      }),
    );
    const call = vi.mocked(childProcess.spawn).mock.calls.at(-1)!;
    assert.equal(call[0], item.command);
    assert.deepEqual((call[1] as string[]).slice(0, item.prefix.length), item.prefix);
    const launch = receipts.launch(result.launchId);
    assert.equal(launch.standalone?.agentRun, false);
    const script = fs.readFileSync(receipts.artifact(result.launchId, 'attend.sh'), 'utf8');
    assert.ok(script.includes('__standalone-supervise'));
    assert.ok(script.includes('--attended'));
    assert.ok(script.includes("Arc élève $() '\\'' &.cjs"));
    assert.equal(unref.mock.calls.length, 1);
  }
});

test('attended Codex uses interactive argv and its positional prompt through the public supervisor', async () => {
  for (const permission of ['read-only', 'workspace-write', 'danger-full-access']) {
    const { home, args, prompt } = fixture();
    const text = "Inspect élève $() ' & \\ paths.\nKeep newlines.";
    fs.writeFileSync(prompt, text);
    const parsed = parseRun(
      [
        ...args,
        '--attach',
        '--agent-run',
        ...(permission === 'read-only' ? ['--read-only'] : ['--permissions', permission]),
        '--add-dir',
        home,
      ],
      { CODEX_BIN: process.execPath },
    );
    assert.deepEqual(parsed.options.args, [
      '-C',
      home,
      '-m',
      'gpt-6.1-sol',
      '-c',
      'model_reasoning_effort=high',
      '-s',
      permission,
      '--add-dir',
      home,
    ]);
    const receipts = new DispatchReceipts(home);
    const launch = receipts.reserve({
      origin: 'c'.repeat(24),
      requester: null,
      policy: parsed.policy,
      completion: 'manual',
      promptSha256: payloadSha256(text),
      alias: null,
      transport: 'standalone',
      standalone: parsed.options,
    });
    receipts.input(launch.launchId, text);
    const child = new ChildProcess();
    vi.mocked(childProcess.spawn).mockImplementationOnce(() => {
      queueMicrotask(() => child.emit('close', 7, null));
      return child;
    });
    await runSupervisor(launch.launchId, true, receipts);
    const call = vi.mocked(childProcess.spawn).mock.calls.at(-1)!;
    assert.deepEqual(call[1], [...parsed.options.args, text]);
    assert.equal((call[2] as { stdio: string }).stdio, 'inherit');
    assert.equal(receipts.observation(launch.launchId)?.exitCode, 7);
    assert.equal(receipts.observation(launch.launchId)?.sessionId, null);
    assert.equal(receipts.latest(launch.launchId)?.outcome, 'unknown');
    assert.equal(receipts.latest(launch.launchId)?.report, null);
    await assert.rejects(runSupervisor(launch.launchId, true, receipts), /already started/);
  }
});

test('attended Codex refuses explicit output paths before reserving or launching', async () => {
  const { home, args } = fixture();
  const receipts = new DispatchReceipts(home);
  const reserved = vi.spyOn(receipts, 'reserve');
  for (const flag of ['--log', '--output', '--report-file']) {
    vi.mocked(childProcess.spawn).mockImplementationOnce(() => {
      throw new Error('Unexpected terminal launch');
    });
    await assert.rejects(
      runStandalone([...args, '--attach', flag, path.join(home, 'result')], 'arc.cjs', {
        receipts,
        platform: 'linux',
        env: { CODEX_BIN: process.execPath, TMUX: 'owned' },
      }),
      /Attended Codex cannot save logs or reports/,
    );
  }
  assert.equal(reserved.mock.calls.length, 0);
  assert.equal(vi.mocked(childProcess.spawn).mock.calls.length, 0);
});

test('existing terminal environments retain the selected receipt and provider roots on every platform', async () => {
  const { home, args } = fixture();
  const selected = path.join(home, "selected élève $() ' &");
  const receipts = new DispatchReceipts(path.relative(process.cwd(), selected));
  const env = {
    PATH: process.env.PATH,
    CODEX_BIN: process.execPath,
    CLAUDE_CONFIG_DIR: path.join(selected, 'claude'),
    CODEX_HOME: path.join(selected, 'codex'),
    ARC_PROJECTS_ROOT: path.join(selected, 'projects'),
    ARC_HOME: path.join(home, 'unused'),
    CODEX_THREAD_ID: session,
    ARC_WINDOW: 'foreign-window',
    OPENAI_API_KEY: 'private-token',
  };
  const plans = [
    { platform: 'win32', extra: { DISPATCH_CLI_BASH: 'C:/Git/bin/bash.exe' } },
    { platform: 'darwin', extra: {} },
    { platform: 'linux', extra: { TMUX: 'owned' } },
    { platform: 'linux', extra: {} },
    { platform: 'linux', extra: {}, gnome: true },
  ] as const;
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  for (const item of plans) {
    const child = new ChildProcess();
    vi.spyOn(child, 'unref').mockImplementation(() => {});
    vi.mocked(childProcess.spawn).mockImplementationOnce(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    const result = JSON.parse(
      await runStandalone([...args, '--attach'], process.execPath, {
        receipts,
        platform: item.platform,
        env: { ...env, ...(item.platform === 'win32' ? {} : { PATH: '/usr/bin' }), ...item.extra },
        exists: (file) => !('gnome' in item) || !String(file).endsWith('x-terminal-emulator'),
      }),
    );
    const launch = receipts.launch(result.launchId);
    assert.equal(JSON.stringify(launch).includes('private-token'), false);
    const original = receipts.artifact(result.launchId, 'attend.sh');
    const program = path.join(home, `context-${result.launchId}.cjs`);
    fs.writeFileSync(program, `console.log(JSON.stringify(process.env))`);
    const script = fs.readFileSync(original, 'utf8');
    // Execute the generated environment prelude under a different terminal server environment.
    const replay = path.join(home, `replay-${result.launchId}.sh`);
    fs.writeFileSync(
      replay,
      script.slice(0, script.lastIndexOf('\nexec ')) +
        `\nexec '${process.execPath.replaceAll('\\', '/')}' '${program.replaceAll('\\', '/')}'\n`,
    );
    const worker = spawn(bash, [replay.replaceAll('\\', '/')], {
      env: {
        ...process.env,
        ARC_HOME: path.join(home, 'wrong'),
        CODEX_HOME: path.join(home, 'wrong'),
        CLAUDE_CONFIG_DIR: path.join(home, 'wrong'),
        ARC_PROJECTS_ROOT: path.join(home, 'wrong'),
      },
    });
    let output = '';
    worker.stdout!.on('data', (bytes) => {
      output += bytes;
    });
    const [code] = await once(worker, 'close');
    assert.equal(code, 0);
    const actual = JSON.parse(output);
    assert.equal(actual.ARC_HOME, path.resolve(path.dirname(receipts.root)));
    assert.equal(actual.CLAUDE_CONFIG_DIR, env.CLAUDE_CONFIG_DIR);
    assert.equal(actual.CODEX_HOME, env.CODEX_HOME);
    assert.equal(actual.ARC_PROJECTS_ROOT, env.ARC_PROJECTS_ROOT);
    vi.stubEnv('CODEX_THREAD_ID', session);
    vi.stubEnv('ARC_WINDOW', 'server-window');
    vi.stubEnv('CODEX_HOME', path.join(home, 'server-codex'));
    const attended = new ChildProcess();
    vi.mocked(childProcess.spawn).mockImplementationOnce(() => {
      queueMicrotask(() => attended.emit('close', 0, null));
      return attended;
    });
    await runSupervisor(launch.launchId, true, receipts);
    const provider = vi.mocked(childProcess.spawn).mock.calls.at(-1)![2]!.env!;
    assert.equal(provider.CODEX_THREAD_ID, undefined);
    assert.equal(provider.ARC_WINDOW, undefined);
    assert.equal(provider.CODEX_HOME, env.CODEX_HOME);
    assert.equal(provider.ARC_HOME, path.resolve(path.dirname(receipts.root)));
  }
});

test('standalone defaults stay bound when later callers select different roots and launchers', () => {
  const { home, args } = fixture();
  const parsed = parseRun(args, { CODEX_BIN: process.execPath, PATH: 'original-path' });
  const original = parsed.options.env!;
  const later = standaloneEnvironment(parsed.options, {
    PATH: 'foreign-path',
    CLAUDE_CONFIG_DIR: 'foreign-claude',
    CODEX_HOME: 'foreign-codex',
    ARC_PROJECTS_ROOT: 'foreign-projects',
    ARC_CODEX_ROOT: 'foreign-sessions',
    CODEX_MANAGED_PACKAGE_ROOT: 'foreign-package',
    CLAUDE_CODE_SESSION_ID: session,
  });
  assert.equal(later.PATH, 'original-path');
  assert.equal(later.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(later.CODEX_HOME, path.join(os.homedir(), '.codex'));
  assert.equal(later.ARC_PROJECTS_ROOT, path.join(os.homedir(), '.claude', 'projects'));
  assert.equal(later.ARC_CODEX_ROOT, path.join(original.CODEX_HOME!, 'sessions'));
  assert.equal(later.CODEX_MANAGED_PACKAGE_ROOT, undefined);
  assert.equal(later.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(parsed.options.cwd, home);
});

test('a fake exec worker publishes a frozen report and exits its finite supervisor', async () => {
  const { receipts, options } = receiptsFixture();
  const script = path.join(options.cwd, 'fake-codex.cjs');
  fs.writeFileSync(
    script,
    `const fs=require('node:fs');process.stdin.resume();process.stdin.on('end',()=>{fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],'Report');for(const row of [{type:'thread.started',thread_id:'${session}'},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',id:'item_1',text:'Report'}},{type:'turn.completed'}])console.log(JSON.stringify(row));});`,
  );
  const launch = receipts.reserve({
    origin: 'b'.repeat(24),
    requester: null,
    policy: null,
    completion: 'wait',
    promptSha256: payloadSha256('Review this folder.'),
    alias: null,
    transport: 'standalone',
    standalone: { ...options, command: process.execPath, args: [script, 'exec'], deadlineMs: 10_000 },
  });
  receipts.input(launch.launchId, 'Review this folder.');
  await superviseStandalone(receipts, launch.launchId, false);
  const event = receipts.latest(launch.launchId)!;
  assert.equal(event.outcome, 'succeeded');
  assert.equal(event.report?.sha256, payloadSha256('Report'));
  assert.equal(receipts.observation(launch.launchId)?.exitCode, 0);
  assert.equal(receipts.observation(launch.launchId)?.monitor, 'finished');
  await superviseStandalone(receipts, launch.launchId, true);
  assert.equal(receipts.latest(launch.launchId)?.eventId, event.eventId);
  assert.throws(() => receipts.input(launch.launchId, 'Other'));
});

test('transient post-start publication retains one original worker, live logs and its final report', async () => {
  const { receipts, launch, script, started, release } = workerFixture('', 10_000, false, true);
  const originalScript = fs.readFileSync(script, 'utf8');
  fs.writeFileSync(
    script,
    originalScript.replace('process.stdin.resume();', "console.error('Still running');process.stdin.resume();"),
  );
  const save = receipts.observation.bind(receipts);
  let failed = false;
  let identity: unknown;
  let observingPublications = 0;
  let signalFailure!: () => void;
  const failedPublication = new Promise<void>((resolve) => {
    signalFailure = resolve;
  });
  vi.spyOn(receipts, 'observation').mockImplementation((id, value) => {
    if (value?.monitor === 'observing') observingPublications++;
    if (value && (value.worker || value.launcher) && !failed) {
      failed = true;
      identity = structuredClone(value.worker ?? value.launcher);
      signalFailure();
      throw Object.assign(new Error('Temporary observation replacement failure'), { code: 'EPERM' });
    }
    return save(id, value);
  });
  const supervised = superviseStandalone(receipts, launch.launchId, false);
  try {
    await Promise.race([
      failedPublication,
      supervised.then(() => {
        throw new Error('The worker ended without the staged publication failure.');
      }),
    ]);
    await vi.waitFor(() => assert.match(fs.readFileSync(launch.standalone!.logAlias!, 'utf8'), /Still running/));
    fs.writeFileSync(release, 'finish');
    await supervised;
    const observation = receipts.observation(launch.launchId)!;
    assert.deepEqual(observation.worker ?? observation.launcher, identity);
    assert.match((observation.worker ?? observation.launcher)!.startedAt, /\S/);
    assert.equal(observation.exitCode, 0);
    assert.equal(observation.monitor, 'finished');
    assert.equal(receipts.latest(launch.launchId)!.outcome, 'succeeded');
    assert.equal((receipts.result(launch.launchId, receipts.latest(launch.launchId)!.eventId) as any).text, 'Report');
    assert.match(fs.readFileSync(launch.standalone!.logAlias!, 'utf8'), /Final stderr/);
    assert.match(fs.readFileSync(started, 'utf8'), /^[0-9]+\n$/);
    assert.equal(vi.mocked(childProcess.spawn).mock.calls.filter((call) => call[1]?.[0] === script).length, 1);
    assert.ok(observingPublications >= 2);
  } finally {
    fs.writeFileSync(release, 'finish');
    await supervised;
  }
});

test('exhausted post-start publication preserves an unknown outcome without restarting the worker', async () => {
  vi.useFakeTimers();
  const { receipts, launch } = workerFixture('', 100);
  const child = new ChildProcess();
  Object.assign(child, { stdin: new PassThrough(), pid: 123 });
  vi.mocked(childProcess.spawn).mockReturnValue(child);
  const save = receipts.observation.bind(receipts);
  vi.spyOn(receipts, 'observation').mockImplementation((id, value) => {
    if (value?.launcher || value?.worker)
      throw Object.assign(new Error('Temporary observation replacement failure'), { code: 'EPERM' });
    return save(id, value);
  });
  const pending = superviseStandalone(receipts, launch.launchId, false, undefined, {
    now: Date.now,
    identity: async () => ({
      command: 'synthetic-worker',
      startedAt: 'original-creation',
      commandLine: 'synthetic-worker',
    }),
    yield: async () => {},
  });
  const rejected = assert.rejects(pending, /Temporary observation replacement failure/);
  await vi.advanceTimersByTimeAsync(100);
  await rejected;
  assert.equal(vi.mocked(childProcess.spawn).mock.calls.length, 1);
  assert.equal(receipts.latest(launch.launchId)!.outcome, 'unknown');
  assert.equal(receipts.latest(launch.launchId)!.availability, 'pending');
  assert.equal(receipts.observation(launch.launchId)!.exitCode, null);
});

test('monitor before queued start leaves the original worker launch available exactly once', async () => {
  const { receipts, launch, release, started } = workerFixture();
  await superviseStandalone(receipts, launch.launchId, true);
  assert.equal(receipts.observation(launch.launchId), null);
  assert.equal(receipts.latest(launch.launchId), null);
  fs.writeFileSync(release, 'finish');
  await superviseStandalone(receipts, launch.launchId, false);
  assert.equal(receipts.latest(launch.launchId)?.outcome, 'succeeded');
  await assert.rejects(superviseStandalone(receipts, launch.launchId, false), /already started/);
  assert.equal(fs.readFileSync(started, 'utf8').trim().split('\n').length, 1);
});

test('provider spawn error retains failed unavailable start without an invented worker exit', async () => {
  const { receipts, options } = receiptsFixture();
  const launch = receipts.reserve({
    origin: 'd'.repeat(24),
    requester: null,
    policy: null,
    completion: 'wait',
    promptSha256: payloadSha256('Review this folder.'),
    alias: null,
    transport: 'standalone',
    standalone: { ...options, command: path.join(options.cwd, 'absent-provider'), args: [] },
  });
  receipts.input(launch.launchId, 'Review this folder.');
  await superviseStandalone(receipts, launch.launchId, false);
  const observation = receipts.observation(launch.launchId)!;
  const event = receipts.latest(launch.launchId)!;
  assert.equal(observation.worker, null);
  assert.equal(observation.exitCode, null);
  assert.equal(observation.signal, null);
  assert.equal(observation.monitor, 'unavailable');
  assert.equal(event.outcome, 'failed');
  assert.equal(event.availability, 'unavailable');
  await superviseStandalone(receipts, launch.launchId, true);
  assert.equal(receipts.latest(launch.launchId)?.eventId, event.eventId);
  assert.equal(receipts.status(launch.launchId).events.at(-1)?.outcome, 'failed');
});

test('small frame and read budgets preserve a final report after many valid output frames', async () => {
  const { receipts, launch, release } = workerFixture(
    `for(let i=0;i<40;i++)console.log(JSON.stringify({type:'progress',text:'x'.repeat(80)}));`,
  );
  fs.writeFileSync(release, 'finish');
  await superviseStandalone(receipts, launch.launchId, false, { frameBytes: 256, readBytes: 17 });
  assert.ok(fs.statSync(receipts.artifact(launch.launchId, 'stdout.log')).size > 256);
  const event = receipts.latest(launch.launchId)!;
  assert.equal(event.outcome, 'succeeded');
  assert.equal((receipts.result(launch.launchId, event.eventId) as any).text, 'Report');
  await superviseStandalone(receipts, launch.launchId, true, { frameBytes: 256, readBytes: 17 });
  assert.equal(receipts.latest(launch.launchId)?.eventId, event.eventId);
});

test(
  'interrupted supervisor monitor observes late output from the same original worker under exclusive lease',
  { timeout: 30_000 },
  async () => {
    const { receipts, launch, options, release, started, script, markerRelease } = workerFixture('', 10_000, true);
    const runner = path.join(options.cwd, 'supervisor.mjs');
    fs.writeFileSync(
      runner,
      `import {DispatchReceipts} from ${JSON.stringify(new URL('../../extension/src/dispatchreceipts.ts', import.meta.url).href)};
import {superviseStandalone} from ${JSON.stringify(new URL('../src/standalone.ts', import.meta.url).href)};
await superviseStandalone(new DispatchReceipts(${JSON.stringify(options.cwd)}),${JSON.stringify(launch.launchId)},false);`,
    );
    const supervisor = spawn(process.execPath, ['--import', 'tsx', runner], {
      cwd: new URL('..', import.meta.url),
      stdio: 'ignore',
      windowsHide: true,
    });
    let original: NonNullable<ReturnType<DispatchReceipts['observation']>>['worker'] = null;
    try {
      await vi.waitFor(
        () => {
          const held = receipts.observation(launch.launchId);
          original = held?.worker ?? held?.launcher ?? null;
          assert.ok(original?.commandLineSha256);
        },
        { timeout: 10_000 },
      );
      const owned = original!;
      assert.equal(receipts.observation(launch.launchId)?.worker, null);
      const marker = vi.waitFor(() => assert.match(fs.readFileSync(started, 'utf8'), /^[0-9]+\n$/));
      fs.writeFileSync(markerRelease, 'ready');
      await marker;
      assert.equal(owned.pid, Number(fs.readFileSync(started, 'utf8').trim()));
      assert.ok((await standaloneProcessIdentity(owned.pid))?.commandLine.includes(script));
      const native = await standaloneProcessIdentity(owned.pid);
      assert.equal(owned.startedAt, native?.startedAt);
      assert.equal(owned.command, native?.command);
      assert.equal(owned.commandLineSha256, payloadSha256(native!.commandLine));
      const closed = once(supervisor, 'close');
      supervisor.kill();
      await closed;
      assert.equal(receipts.latest(launch.launchId), null);
      const retained = receipts.observation(launch.launchId)!;
      receipts.observation(launch.launchId, {
        ...retained,
        launcher: { ...owned, startedAt: 'different-lifetime' },
      });
      await superviseStandalone(receipts, launch.launchId, true, { frameBytes: 256, readBytes: 17 });
      assert.equal(receipts.observation(launch.launchId)?.monitor, 'unavailable');
      assert.equal(receipts.latest(launch.launchId), null);
      assert.equal((await standaloneProcessIdentity(owned.pid))?.startedAt, owned.startedAt);
      receipts.observation(launch.launchId, retained);
      const resumed = superviseStandalone(receipts, launch.launchId, true, { frameBytes: 256, readBytes: 17 });
      await vi.waitFor(() => assert.notEqual(receipts.observation(launch.launchId)?.supervisor.pid, supervisor.pid));
      await assert.rejects(superviseStandalone(receipts, launch.launchId, true), /Another process/);
      assert.equal(receipts.latest(launch.launchId), null);
      fs.writeFileSync(release, 'finish');
      await resumed;
      const event = receipts.latest(launch.launchId)!;
      assert.ok(
        event,
        JSON.stringify({
          observation: receipts.observation(launch.launchId),
          stdout: fs.readFileSync(receipts.artifact(launch.launchId, 'stdout.log'), 'utf8'),
          native: readNativeReport(receipts.artifact(launch.launchId, 'native.md')),
        }),
      );
      assert.equal(event.outcome, 'unknown');
      assert.equal(event.availability, 'available');
      assert.equal((receipts.result(launch.launchId, event.eventId) as any).text, 'Report');
      assert.deepEqual(receipts.observation(launch.launchId)?.launcher, owned);
      assert.equal(receipts.observation(launch.launchId)?.exitCode, null);
      assert.equal(fs.readFileSync(started, 'utf8').trim().split('\n').length, 1);
      assert.match(fs.readFileSync(receipts.artifact(launch.launchId, 'stderr.log'), 'utf8'), /Final stderr/);
      await superviseStandalone(receipts, launch.launchId, true, { frameBytes: 256, readBytes: 17 });
      assert.equal(receipts.latest(launch.launchId)?.eventId, event.eventId);
    } finally {
      fs.writeFileSync(markerRelease, 'ready');
      fs.writeFileSync(release, 'finish');
      if (supervisor.exitCode === null && supervisor.signalCode === null) {
        const closed = once(supervisor, 'close');
        supervisor.kill();
        await closed;
      }
      if (original)
        await vi.waitFor(async () => assert.equal(await standaloneProcessIdentity(original!.pid), null), {
          timeout: 10_000,
        });
    }
  },
);

test(
  'observation timeout preserves both output routes for later same-worker recovery',
  { timeout: 30_000 },
  async () => {
    const { receipts, launch, release, started, markerRelease } = workerFixture('', 10, true);
    let worker: NonNullable<ReturnType<DispatchReceipts['observation']>>['worker'] = null;
    try {
      await superviseStandalone(receipts, launch.launchId, false, undefined, {
        now: Date.now,
        yield: () => Promise.resolve(),
        identity: (pid) => standaloneProcessIdentity(pid),
      });
      const timed = receipts.observation(launch.launchId)!;
      worker = timed.worker ?? timed.launcher ?? null;
      assert.equal(timed.monitor, 'timed-out');
      assert.equal(timed.exitCode, null);
      assert.ok(worker?.commandLineSha256);
      const marker = vi.waitFor(() => assert.match(fs.readFileSync(started, 'utf8'), /^[0-9]+\n$/));
      fs.writeFileSync(markerRelease, 'ready');
      await marker;
      assert.equal(worker.pid, Number(fs.readFileSync(started, 'utf8').trim()));
      assert.equal((await standaloneProcessIdentity(worker.pid))?.startedAt, worker.startedAt);
      fs.writeFileSync(release, 'finish');
      await vi.waitFor(() => {
        assert.match(fs.readFileSync(receipts.artifact(launch.launchId, 'stdout.log'), 'utf8'), /turn.completed/);
        assert.match(fs.readFileSync(receipts.artifact(launch.launchId, 'stderr.log'), 'utf8'), /Final stderr/);
      });
      await superviseStandalone(
        receipts,
        launch.launchId,
        true,
        { frameBytes: 256, readBytes: 17 },
        { now: () => 0, identity: standaloneProcessIdentity, yield: () => Promise.resolve() },
      );
      const event = receipts.latest(launch.launchId)!;
      assert.equal(event.outcome, 'unknown');
      assert.equal((receipts.result(launch.launchId, event.eventId) as any).text, 'Report');
      assert.deepEqual(receipts.observation(launch.launchId)?.launcher, worker);
    } finally {
      fs.writeFileSync(markerRelease, 'ready');
      fs.writeFileSync(release, 'finish');
      if (worker)
        await vi.waitFor(async () => assert.equal(await standaloneProcessIdentity(worker!.pid), null), {
          timeout: 10_000,
        });
    }
  },
);

test('empty recovery overlaps the original start without occupying its monitor', async () => {
  const { receipts, launch, release, started } = workerFixture();
  fs.writeFileSync(release, 'finish');
  const status = receipts.status.bind(receipts);
  let original: Promise<unknown> | undefined;
  let overlap = false;
  vi.spyOn(receipts, 'status').mockImplementation((...args) => {
    if (!overlap) {
      overlap = true;
      original = superviseStandalone(receipts, launch.launchId, false);
      original.catch(() => {});
    }
    return status(...args);
  });
  await superviseStandalone(receipts, launch.launchId, true);
  assert.ok(overlap);
  await original;
  assert.equal(receipts.latest(launch.launchId)?.outcome, 'succeeded');
  assert.equal(fs.readFileSync(started, 'utf8').trim().split('\n').length, 1);
  await assert.rejects(superviseStandalone(receipts, launch.launchId, false), /already started/);
});

function recoveryFixture() {
  const { receipts, launch } = receiptsFixture();
  const launcher = {
    pid: process.pid,
    command: 'node',
    commandLine: 'node launcher',
    args: ['launcher'],
    argsSha256: payloadSha256(JSON.stringify(['launcher'])),
    commandLineSha256: payloadSha256('node launcher'),
    startedAt: 'original-lifetime',
  };
  receipts.observation(launch.launchId, {
    supervisor: { pid: process.pid, token: launch.launchId },
    worker: null,
    launcher,
    sessionId: null,
    exitCode: null,
    signal: null,
    monitor: 'timed-out',
  });
  fs.writeFileSync(receipts.artifact(launch.launchId, 'stdout.log'), '');
  return { receipts, launch, launcher };
}
function outputFrames() {
  return (
    [
      { type: 'thread.started', thread_id: session },
      { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'agent_message', id: 'item_1', text: 'Report' } },
      { type: 'turn.completed' },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n'
  );
}
test.each(['complete', 'deadline'] as const)(
  'resumed observation drains a stopped producer alias backlog through %s',
  async (ending) => {
    const { receipts, launch } = workerFixture('', 10, false, true);
    const id = launch.launchId;
    const stdout = Buffer.from(
      (JSON.stringify({ type: 'progress', text: 'x'.repeat(80) }) + '\n').repeat(2048) + outputFrames(),
    );
    const stderr = Buffer.alloc(4096, 255);
    fs.writeFileSync(receipts.artifact(id, 'stdout.log'), stdout);
    fs.writeFileSync(receipts.artifact(id, 'stderr.log'), stderr);
    fs.writeFileSync(receipts.artifact(id, 'native.md'), 'Report');
    receipts.observation(id, {
      supervisor: { pid: process.pid, token: id },
      worker: null,
      sessionId: null,
      exitCode: 0,
      signal: null,
      monitor: 'timed-out',
    });
    const owner = {
      pid: 2147483647,
      producerPid: 2147483646,
      state: 'unavailable',
      reason: 'The requested log is incomplete. Private output remains available.',
    };
    fs.writeFileSync(receipts.artifact(id, 'output-owner.json'), JSON.stringify(owner));
    const alias = launch.standalone!.logAlias!;
    const open = fs.openSync;
    let blocked = true;
    const failure = vi.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
      if (String(file) === alias && blocked) throw Object.assign(new Error('Alias unavailable'), { code: 'EPERM' });
      return Reflect.apply(open, fs, [file, ...args]);
    });
    const bounds = { frameBytes: 1024, readBytes: 64 * 1024, workBytes: 1024 * 1024 };
    let now = 0;
    try {
      await superviseStandalone(receipts, id, true, bounds, {
        now: () => now,
        identity: async () => null,
        yield: async () => {
          if (receipts.scan(id)) now += launch.standalone!.deadlineMs;
        },
      });
      assert.equal((receipts.scan(id) as any).offset, stdout.length);
      const position = JSON.parse(fs.readFileSync(receipts.artifact(id, 'capture.json'), 'utf8'));
      assert.equal(position.sources['stdout.log'].offset, stdout.length);
      assert.equal(position.sources['stderr.log'].offset, stderr.length);
      assert.equal(fs.statSync(alias).size, 0);
      const captured = fs.readFileSync(receipts.artifact(id, 'worker.log'));
      assert.ok(captured.length > 2 * bounds.readBytes);
      assert.equal(captured.length, stdout.length + stderr.length);
      const event = receipts.latest(id)!;
      blocked = false;
      now = 0;
      let yields = 0;
      const runtime = {
        now: () => now,
        identity: async () => null,
        yield: async () => {
          yields++;
          now += ending === 'deadline' ? launch.standalone!.deadlineMs : 1;
        },
      };
      const status = (await superviseStandalone(receipts, id, true, bounds, runtime)) as any;
      if (ending === 'deadline') {
        assert.equal(status.observation.monitor, 'timed-out');
        assert.equal(status.observation.reason, 'Observation timed out before all worker output was read.');
        assert.ok(fs.statSync(alias).size < captured.length);
        assert.ok(now <= launch.standalone!.deadlineMs);
        now = 0;
        await superviseStandalone(receipts, id, true, bounds, {
          ...runtime,
          yield: async () => {
            now++;
          },
        });
      } else assert.equal(status.observation.monitor, 'finished');
      assert.equal(fs.statSync(alias).size, captured.length);
      assert.ok(yields > 0);
      assert.deepEqual(fs.readFileSync(alias), captured);
      assert.deepEqual(Buffer.from([...captured].filter((byte) => byte !== 255)), stdout);
      assert.equal([...captured].filter((byte) => byte === 255).length, stderr.length);
      assert.deepEqual(fs.readFileSync(receipts.artifact(id, 'worker.log')), captured);
      assert.equal(receipts.latest(id)?.eventId, event.eventId);
      assert.equal((receipts.result(id, event.eventId) as any).text, 'Report');
      assert.equal(receipts.observation(id)?.monitor, 'finished');
      assert.equal(receipts.observation(id)?.worker, null);
      assert.deepEqual(JSON.parse(fs.readFileSync(receipts.artifact(id, 'output-owner.json'), 'utf8')), owner);
      assert.equal(vi.mocked(childProcess.spawn).mock.calls.length, 0);
    } finally {
      failure.mockRestore();
    }
  },
);
test('resumed observation retains timeout while stopped producer stderr exceeds its close allowance', async () => {
  const { receipts, launch } = workerFixture('', 20, false, true);
  const id = launch.launchId;
  const bounds = { frameBytes: 1024, readBytes: 64, workBytes: 512 };
  const stdout = Buffer.from(outputFrames());
  const stderr = Buffer.from(Array.from({ length: 3 * bounds.workBytes + 31 }, (_, index) => 128 + (index % 128)));
  assert.ok(stdout.length < bounds.workBytes);
  fs.writeFileSync(receipts.artifact(id, 'stdout.log'), stdout);
  fs.writeFileSync(receipts.artifact(id, 'stderr.log'), stderr);
  fs.writeFileSync(receipts.artifact(id, 'native.md'), 'Report');
  receipts.observation(id, {
    supervisor: { pid: process.pid, token: id },
    worker: null,
    sessionId: null,
    exitCode: 0,
    signal: null,
    monitor: 'timed-out',
  });
  const owner = { pid: 2147483647, producerPid: 2147483646, state: 'unavailable' };
  fs.writeFileSync(receipts.artifact(id, 'output-owner.json'), JSON.stringify(owner));
  const alias = launch.standalone!.logAlias!;
  let previousStderr = 0;
  let previous = Buffer.alloc(0);
  let eventId: string | undefined;
  for (let pass = 0; pass < Math.ceil(stderr.length / bounds.workBytes); pass++) {
    let now = 0;
    const status = (await superviseStandalone(receipts, id, true, bounds, {
      now: () => now,
      identity: async () => null,
      yield: async () => {
        now++;
      },
    })) as any;
    const position = JSON.parse(fs.readFileSync(receipts.artifact(id, 'capture.json'), 'utf8'));
    const captured = fs.readFileSync(receipts.artifact(id, 'worker.log'));
    const expectedStderr = Math.min(stderr.length, previousStderr + bounds.workBytes);
    assert.equal(position.sources['stdout.log'].offset, stdout.length);
    assert.equal(position.sources['stderr.log'].offset, expectedStderr);
    assert.equal(captured.length, stdout.length + expectedStderr);
    assert.deepEqual(captured.subarray(0, previous.length), previous);
    assert.deepEqual(Buffer.from([...captured].filter((byte) => byte < 128)), stdout);
    assert.deepEqual(Buffer.from([...captured].filter((byte) => byte >= 128)), stderr.subarray(0, expectedStderr));
    assert.deepEqual(fs.readFileSync(alias), captured);
    const event = receipts.latest(id)!;
    eventId ??= event.eventId;
    assert.equal(event.eventId, eventId);
    assert.equal(event.outcome, 'succeeded');
    assert.equal((receipts.result(id, event.eventId) as any).text, 'Report');
    if (expectedStderr < stderr.length) {
      assert.equal(status.observation.monitor, 'timed-out');
      assert.equal(status.observation.reason, 'Observation timed out before all worker output was read.');
      assert.equal(now, launch.standalone!.deadlineMs);
    } else assert.equal(status.observation.monitor, 'finished');
    assert.equal(status.observation.exitCode, 0);
    assert.equal(status.observation.worker, null);
    previousStderr = expectedStderr;
    previous = captured;
  }
  assert.equal(previousStderr, stderr.length);
  assert.deepEqual(JSON.parse(fs.readFileSync(receipts.artifact(id, 'output-owner.json'), 'utf8')), owner);
  assert.equal(vi.mocked(childProcess.spawn).mock.calls.length, 0);
});

test.each([
  ['turn.failed', 1, null, 'failed'],
  ['turn.completed', null, 'SIGTERM', 'interrupted'],
] as const)(
  'native report denial preserves the established %s %s %s outcome %s',
  async (type, exitCode, signal, outcome) => {
    const { receipts, launch } = recoveryFixture();
    const id = launch.launchId;
    fs.writeFileSync(receipts.artifact(id, 'stdout.log'), outputFrames().replace('turn.completed', type));
    const report = receipts.artifact(id, 'native.md');
    fs.writeFileSync(report, 'Report');
    receipts.observation(id, { ...receipts.observation(id)!, exitCode, signal });
    const runtime = { now: () => 0, identity: async () => null, yield: () => Promise.resolve() };
    await superviseStandalone(receipts, id, true, undefined, runtime);
    const event = receipts.latest(id)!;
    assert.equal(event.outcome, outcome);
    assert.equal(event.availability, 'available');
    const frozen = receipts.result(id, event.eventId);
    const open = fs.openSync;
    let denied = false;
    const failure = vi.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
      if (String(file) === report) {
        denied = true;
        throw Object.assign(new Error('Report unavailable'), { code: 'EACCES' });
      }
      return Reflect.apply(open, fs, [file, ...args]);
    });
    try {
      await superviseStandalone(receipts, id, true, undefined, runtime);
      assert.equal(denied, true);
      assert.deepEqual(receipts.latest(id), event);
      assert.deepEqual(receipts.result(id, event.eventId), frozen);
    } finally {
      failure.mockRestore();
    }
    await superviseStandalone(receipts, id, true, undefined, runtime);
    assert.equal(receipts.latest(id)?.eventId, event.eventId);
    assert.equal(receipts.status(id).events.length, 1);
    assert.equal(vi.mocked(childProcess.spawn).mock.calls.length, 0);
  },
);
test.each([
  ['turn.failed', 1, null, 'failed'],
  ['turn.completed', 0, null, 'succeeded'],
  ['turn.completed', null, 'SIGTERM', 'interrupted'],
] as const)(
  'reportless %s recovery publishes changed outcome %s %s %s once',
  async (type, exitCode, signal, outcome) => {
    const { receipts, launch } = workerFixture('', 3);
    const child = new ChildProcess();
    child.stdin = new PassThrough();
    vi.mocked(childProcess.spawn).mockReturnValue(child);
    let now = 0;
    const bounds = { frameBytes: 256, readBytes: 17, workBytes: 512 };
    const initial = superviseStandalone(receipts, launch.launchId, false, bounds, {
      now: () => now,
      identity: async () => null,
      yield: async () => {
        now += launch.standalone!.deadlineMs;
      },
    });
    const log = receipts.artifact(launch.launchId, 'stdout.log');
    fs.writeFileSync(
      log,
      [{ type: 'thread.started', thread_id: session }, { type: 'turn.started' }, { type }]
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n',
    );
    child.emit('close', exitCode, signal);
    await initial;
    assert.equal(receipts.observation(launch.launchId)?.monitor, 'timed-out');
    assert.equal(receipts.latest(launch.launchId)?.outcome, 'unknown');
    assert.equal(receipts.latest(launch.launchId)?.availability, 'pending');
    const runtime = { now: () => 0, identity: async () => null, yield: () => Promise.resolve() };
    await superviseStandalone(receipts, launch.launchId, true, bounds, runtime);
    const event = receipts.latest(launch.launchId)!;
    assert.equal(event.outcome, outcome);
    assert.equal(event.availability, 'unavailable');
    assert.equal(event.report, null);
    assert.deepEqual(event.nativeEnding, { type, sessionId: session, messageId: null });
    assert.equal(receipts.status(launch.launchId).events.length, 2);
    await superviseStandalone(receipts, launch.launchId, true, bounds, runtime);
    assert.equal(receipts.latest(launch.launchId)?.eventId, event.eventId);
    assert.equal(receipts.status(launch.launchId).events.length, 2);
    assert.equal(vi.mocked(childProcess.spawn).mock.calls.length, 1);
  },
);
test('recovery retries unavailable identity and keeps same-lifetime launcher provenance through command changes', async () => {
  const { receipts, launch, launcher } = recoveryFixture();
  let lookups = 0;
  await superviseStandalone(
    receipts,
    launch.launchId,
    true,
    { frameBytes: 256, readBytes: 17, workBytes: 1024 },
    {
      now: Date.now,
      yield: () => Promise.resolve(),
      identity: async () => {
        lookups++;
        if (lookups === 1) return null;
        if (lookups === 2)
          return { command: 'codex.exe', commandLine: 'codex native transition', startedAt: launcher.startedAt };
        fs.writeFileSync(receipts.artifact(launch.launchId, 'stdout.log'), outputFrames());
        fs.writeFileSync(receipts.artifact(launch.launchId, 'native.md'), 'Report');
        return { command: 'codex.exe', commandLine: 'codex renamed title', startedAt: launcher.startedAt };
      },
    },
  );
  assert.equal(lookups, 3);
  assert.equal(receipts.observation(launch.launchId)?.monitor, 'finished');
  assert.equal(receipts.observation(launch.launchId)?.worker, null);
  assert.deepEqual(receipts.observation(launch.launchId)?.launcher, launcher);
  const event = receipts.latest(launch.launchId)!;
  assert.equal(event.outcome, 'unknown');
  assert.equal((receipts.result(launch.launchId, event.eventId) as any).text, 'Report');
});

test('failed source pass retains its admitted checkpoint for original-output recovery', async () => {
  const { receipts, launch, launcher } = recoveryFixture();
  const file = receipts.artifact(launch.launchId, 'stdout.log');
  const output = outputFrames();
  const opening = output.indexOf('\n') + 1;
  const prefix = opening + 12;
  const bounds = { frameBytes: 256, readBytes: 17, workBytes: 512 };
  const deadline = receipts.launch(launch.launchId).standalone!.deadlineMs;
  let now = 0;
  const runtime = {
    now: () => now,
    identity: async () => ({ ...launcher, startedAt: 'different-lifetime' }),
    yield: () => Promise.resolve(),
  };
  fs.writeFileSync(file, output.slice(0, opening));
  await superviseStandalone(receipts, launch.launchId, true, bounds, runtime);
  const admitted = receipts.scan(launch.launchId);
  assert.equal((admitted as any).offset, opening);
  fs.appendFileSync(file, output.slice(opening, prefix));
  const stat = fs.statSync;
  let failures = 0;
  const failing = vi.spyOn(fs, 'statSync').mockImplementation((...args) => {
    if (args[0] === file) {
      failures++;
      now = deadline;
      throw new Error('Source stat unavailable');
    }
    return Reflect.apply(stat, fs, args);
  });
  await superviseStandalone(receipts, launch.launchId, true, bounds, runtime);
  failing.mockRestore();
  assert.equal(failures, 1);
  assert.equal(receipts.latest(launch.launchId), null);
  assert.equal(receipts.observation(launch.launchId)?.monitor, 'unavailable');
  const lease = receipts.monitor(launch.launchId);
  lease.release();
  const retained = receipts.scan(launch.launchId);
  fs.appendFileSync(file, output.slice(prefix));
  fs.writeFileSync(receipts.artifact(launch.launchId, 'native.md'), 'Report');
  now = 0;
  await superviseStandalone(receipts, launch.launchId, true, bounds, runtime);
  const event = receipts.latest(launch.launchId)!;
  assert.ok(event?.report);
  assert.equal((receipts.result(launch.launchId, event.eventId) as any).text, 'Report');
  assert.deepEqual(retained, admitted);
  assert.deepEqual(receipts.observation(launch.launchId)?.launcher, launcher);
  assert.equal(receipts.observation(launch.launchId)?.exitCode, null);
  assert.equal(fs.readFileSync(file, 'utf8'), output);
});

test('absent launcher retains a valid JSON prefix for continuing original output', async () => {
  const { receipts, launch, launcher } = recoveryFixture();
  const absent = { ...launcher, pid: 2147483647 };
  receipts.observation(launch.launchId, { ...receipts.observation(launch.launchId)!, launcher: absent });
  const spawn = vi.spyOn(childProcess, 'spawn');
  const kill = process.kill;
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === absent.pid) throw Object.assign(new Error('Launcher absent'), { code: 'ESRCH' });
    return kill(pid, signal);
  });
  const file = receipts.artifact(launch.launchId, 'stdout.log');
  const output = outputFrames();
  const prefix = output.indexOf('Report') + 2;
  fs.writeFileSync(file, output.slice(0, prefix));
  const bounds = { frameBytes: 256, readBytes: 17, workBytes: 512 };
  const runtime = { now: () => 0, identity: async () => null, yield: () => Promise.resolve() };
  await superviseStandalone(receipts, launch.launchId, true, bounds, runtime);
  assert.equal(receipts.latest(launch.launchId), null);
  const saved = receipts.scan(launch.launchId) as any;
  const lease = receipts.monitor(launch.launchId);
  lease.release();
  fs.appendFileSync(file, output.slice(prefix));
  fs.writeFileSync(receipts.artifact(launch.launchId, 'native.md'), 'Report');
  await superviseStandalone(receipts, launch.launchId, true, bounds, runtime);
  const event = receipts.latest(launch.launchId)!;
  assert.ok(event?.report);
  assert.equal((receipts.result(launch.launchId, event.eventId) as any).text, 'Report');
  assert.equal(event.outcome, 'unknown');
  assert.equal(saved.offset, prefix);
  assert.equal(saved.frames.invalid, false);
  assert.equal(
    Buffer.from(saved.pending.data, 'base64').toString(),
    output.slice(output.lastIndexOf('\n', prefix) + 1, prefix),
  );
  assert.equal(saved.pending.discarded, false);
  assert.deepEqual(receipts.observation(launch.launchId)?.launcher, absent);
  assert.equal(receipts.observation(launch.launchId)?.worker, null);
  assert.equal(receipts.observation(launch.launchId)?.exitCode, null);
  assert.equal(receipts.observation(launch.launchId)?.signal, null);
  assert.equal(fs.readFileSync(file, 'utf8'), output);
  assert.equal(spawn.mock.calls.length, 0);
});

test('supervisor timeout retains captured signal and output-read reason', async () => {
  const { receipts, launch } = workerFixture('', 3);
  const child = new ChildProcess();
  Object.assign(child, { stdin: new PassThrough() });
  vi.spyOn(childProcess, 'spawn').mockReturnValue(child);
  let now = 0;
  const supervised = superviseStandalone(
    receipts,
    launch.launchId,
    false,
    { frameBytes: 256, readBytes: 17, workBytes: 512 },
    {
      now: () => now,
      identity: standaloneProcessIdentity,
      yield: async () => {
        now++;
      },
    },
  );
  fs.writeFileSync(receipts.artifact(launch.launchId, 'stdout.log'), '{"type":"progress"}\n'.repeat(40));
  child.emit('close', null, 'SIGTERM');
  await supervised;
  const observation = receipts.observation(launch.launchId)!;
  assert.equal(observation.monitor, 'timed-out');
  assert.equal(observation.signal, 'SIGTERM');
  assert.equal(observation.exitCode, null);
  assert.equal(observation.reason, 'Observation timed out before all worker output was read.');
  assert.equal(receipts.latest(launch.launchId)?.availability, 'pending');
});

test('fresh close retains real exit and bounds output work before later complete recovery', async () => {
  const { receipts, launch, release } = workerFixture(
    `for(let i=0;i<40;i++)console.log(JSON.stringify({type:'progress',text:'x'.repeat(80)}));`,
    10_000,
    false,
    true,
  );
  fs.writeFileSync(release, 'finish');
  const bounds = { frameBytes: 256, readBytes: 17, workBytes: 512 };
  await superviseStandalone(receipts, launch.launchId, false, bounds);
  assert.equal(receipts.observation(launch.launchId)?.monitor, 'timed-out');
  assert.equal(receipts.observation(launch.launchId)?.exitCode, 0);
  assert.equal(
    receipts.observation(launch.launchId)?.reason,
    'Observation timed out before all worker output was read.',
  );
  const pending = receipts.latest(launch.launchId)!;
  assert.equal(pending.availability, 'pending');
  const worker = receipts.observation(launch.launchId)?.worker;
  const launcher = receipts.observation(launch.launchId)?.launcher;
  const spawns = vi.mocked(childProcess.spawn).mock.calls.length;
  const stdout = fs.readFileSync(receipts.artifact(launch.launchId, 'stdout.log'));
  const stderr = fs.readFileSync(receipts.artifact(launch.launchId, 'stderr.log'));
  const raw = receipts.artifact(launch.launchId, 'worker.log');
  const log = launch.standalone!.logAlias!;
  const capturePosition = () => {
    const capture = receipts.capture(launch.launchId);
    try {
      return { stdout: capture.cursor('stdout.log').offset, stderr: capture.cursor('stderr.log').offset };
    } finally {
      capture.close();
    }
  };
  let captured = capturePosition();
  let expected = fs.readFileSync(raw);
  assert.equal(captured.stderr, stderr.length);
  const diagnostic = expected.indexOf(stderr);
  assert.ok(diagnostic >= 0);
  assert.deepEqual(
    Buffer.concat([expected.subarray(0, diagnostic), expected.subarray(diagnostic + stderr.length)]),
    stdout.subarray(0, captured.stdout),
  );
  assert.deepEqual(fs.readFileSync(log), expected);
  let position = 0;
  for (let attempt = 0; attempt < 20 && receipts.latest(launch.launchId)?.availability !== 'available'; attempt++) {
    let now = 0;
    await superviseStandalone(receipts, launch.launchId, true, bounds, {
      now: () => now,
      identity: async () => null,
      yield: async () => {
        if (((receipts.scan(launch.launchId) as any)?.offset ?? 0) > position) now += launch.standalone!.deadlineMs;
      },
    });
    const saved = receipts.scan(launch.launchId) as any;
    assert.ok(saved.offset > position);
    assert.ok(saved.offset - position <= bounds.workBytes);
    position = saved.offset;
    const next = capturePosition();
    assert.ok(next.stdout >= captured.stdout && next.stderr >= captured.stderr);
    if (captured.stdout < stdout.length || captured.stderr < stderr.length)
      assert.ok(next.stdout > captured.stdout || next.stderr > captured.stderr);
    assert.ok(next.stdout - captured.stdout <= bounds.workBytes);
    assert.ok(next.stderr - captured.stderr <= bounds.workBytes);
    expected = Buffer.concat([
      expected,
      stdout.subarray(captured.stdout, next.stdout),
      stderr.subarray(captured.stderr, next.stderr),
    ]);
    assert.deepEqual(fs.readFileSync(raw), expected);
    assert.deepEqual(fs.readFileSync(log), expected);
    captured = next;
  }
  assert.deepEqual(captured, { stdout: stdout.length, stderr: stderr.length });
  assert.equal(expected.length, stdout.length + stderr.length);
  assert.deepEqual(receipts.observation(launch.launchId)?.worker, worker);
  assert.deepEqual(receipts.observation(launch.launchId)?.launcher, launcher);
  assert.equal(vi.mocked(childProcess.spawn).mock.calls.length, spawns);
  const event = receipts.latest(launch.launchId)!;
  assert.equal(event.outcome, 'succeeded');
  assert.equal((receipts.result(launch.launchId, event.eventId) as any).text, 'Report');
  const before = receipts.result(launch.launchId, event.eventId);
  fs.unlinkSync(receipts.artifact(launch.launchId, 'stdout.log'));
  await superviseStandalone(receipts, launch.launchId, true, bounds);
  assert.deepEqual(receipts.result(launch.launchId, event.eventId), before);
  assert.equal(receipts.latest(launch.launchId)?.eventId, event.eventId);
  assert.equal(receipts.observation(launch.launchId)?.monitor, 'unavailable');
});

test.each(['unavailable', 'absent'] as const)(
  'bounded %s-worker recovery yields at the deadline and resumes past an incomplete frame',
  async (lookup) => {
    const { receipts, launch, launcher } = recoveryFixture();
    if (lookup === 'absent')
      receipts.observation(launch.launchId, {
        ...receipts.observation(launch.launchId)!,
        launcher: { ...launcher, pid: 2147483647 },
      });
    const log = receipts.artifact(launch.launchId, 'stdout.log');
    fs.writeFileSync(
      log,
      Array.from({ length: 40 }, () => JSON.stringify({ type: 'progress', text: 'x'.repeat(180) }) + '\n').join('') +
        outputFrames(),
    );
    fs.writeFileSync(receipts.artifact(launch.launchId, 'native.md'), 'Report');
    const bounds = { frameBytes: 256, readBytes: 17, workBytes: 512 };
    let now = 0;
    const runtime = {
      now: () => now,
      identity: async () => null,
      yield: async () => {
        now += 8_640_000;
      },
    };
    await superviseStandalone(receipts, launch.launchId, true, bounds, runtime);
    assert.equal(receipts.observation(launch.launchId)?.monitor, 'timed-out');
    assert.equal(receipts.observation(launch.launchId)?.exitCode, null);
    assert.equal(receipts.latest(launch.launchId), null);
    let position = (receipts.scan(launch.launchId) as any).offset;
    assert.ok(position > 0 && position <= 170);
    for (let attempt = 0; attempt < 100 && !receipts.latest(launch.launchId)?.report; attempt++) {
      await superviseStandalone(receipts, launch.launchId, true, bounds, runtime);
      const saved = receipts.scan(launch.launchId) as any;
      assert.ok(saved.offset > position);
      assert.ok(saved.offset - position <= bounds.workBytes);
      position = saved.offset;
    }
    const event = receipts.latest(launch.launchId)!;
    assert.equal((receipts.result(launch.launchId, event.eventId) as any).text, 'Report');
    const claim = receipts.claim(launch.launchId, event.eventId, 'a'.repeat(24), 'fixture') as any;
    receipts.ack(launch.launchId, event.eventId, 'a'.repeat(24), 'fixture', claim.token, 'Read');
    const frozen = receipts.result(launch.launchId, event.eventId);
    await superviseStandalone(receipts, launch.launchId, true, bounds);
    assert.deepEqual(receipts.result(launch.launchId, event.eventId), frozen);
    assert.equal(receipts.latest(launch.launchId)?.eventId, event.eventId);
  },
);

test.each([null, 'SIGTERM'] as const)(
  'fresh close yields within its finite deadline while retaining captured ending %s',
  async (signal) => {
    const { options, home } = (() => {
      const { options } = receiptsFixture();
      return { options, home: options.cwd };
    })();
    const descriptor = fs.openSync(path.join(home, 'output.log'), 'w');
    let now = 0;
    let reads = 0;
    const child = new ChildProcess();
    try {
      const observed = observeProcess(
        child,
        { ...options, deadlineMs: 3 },
        () => {},
        descriptor,
        descriptor,
        function* () {
          for (let i = 0; i < 40; i++) {
            reads++;
            yield Buffer.from('{"type":"progress"}\n');
          }
        },
        { frameBytes: 256, readBytes: 64, workBytes: 512 },
        {
          now: () => now,
          identity: standaloneProcessIdentity,
          yield: async () => {
            now++;
          },
        },
      );
      child.emit('close', signal ? null : 0, signal);
      const ending = await observed;
      assert.equal(ending.timedOut, true);
      assert.equal(ending.exitCode, signal ? null : 0);
      assert.equal(ending.signal, signal);
      assert.ok(reads <= 4);
    } finally {
      fs.closeSync(descriptor);
    }
  },
);

test.each(['replacement', 'truncation', 'missing'] as const)(
  'saved output position rejects log %s without publishing cached final evidence',
  async (change) => {
    const { receipts, launch } = recoveryFixture();
    const file = receipts.artifact(launch.launchId, 'stdout.log');
    fs.writeFileSync(file, outputFrames());
    const bounds = { frameBytes: 256, readBytes: 17, workBytes: 512 };
    const runtime = {
      now: () => 0,
      identity: async () => ({ command: 'node', commandLine: 'node', startedAt: 'different-lifetime' }),
      yield: () => Promise.resolve(),
    };
    await superviseStandalone(receipts, launch.launchId, true, bounds, runtime);
    assert.equal((receipts.scan(launch.launchId) as any).offset, fs.statSync(file).size);
    const initial = receipts.latest(launch.launchId)!;
    assert.equal(initial.outcome, 'unknown');
    assert.equal(initial.availability, 'unavailable');
    assert.equal(initial.report, null);
    if (change === 'replacement') {
      fs.renameSync(file, file + '.original');
      fs.writeFileSync(file, outputFrames());
    } else if (change === 'truncation') fs.truncateSync(file, 0);
    else fs.unlinkSync(file);
    fs.writeFileSync(receipts.artifact(launch.launchId, 'native.md'), 'Report');
    await superviseStandalone(receipts, launch.launchId, true, bounds, runtime);
    assert.deepEqual(receipts.latest(launch.launchId), initial);
    assert.equal(receipts.observation(launch.launchId)?.monitor, 'unavailable');
    const lease = receipts.monitor(launch.launchId);
    lease.release();
  },
);

test('snapshot EOF growth continues within the same work allowance', async () => {
  const { receipts, launch, launcher } = recoveryFixture();
  const file = receipts.artifact(launch.launchId, 'stdout.log');
  const progress = '{"type":"progress"}\n';
  fs.writeFileSync(file, progress);
  let yields = 0;
  await superviseStandalone(
    receipts,
    launch.launchId,
    true,
    { frameBytes: 256, readBytes: 512, workBytes: 1024 },
    {
      now: () => 0,
      identity: async () => launcher,
      yield: async () => {
        yields++;
        if (yields === 1) fs.appendFileSync(file, progress);
        if (yields === 2) {
          fs.appendFileSync(file, outputFrames());
          fs.writeFileSync(receipts.artifact(launch.launchId, 'native.md'), 'Report');
        }
      },
    },
  );
  assert.equal(receipts.observation(launch.launchId)?.monitor, 'finished');
  assert.equal(yields, 3);
  assert.deepEqual(receipts.observation(launch.launchId)?.launcher, launcher);
  const event = receipts.latest(launch.launchId)!;
  assert.equal((receipts.result(launch.launchId, event.eventId) as any).text, 'Report');
});

test.each(['malformed', 'oversized'] as const)('bounded partial %s output never publishes a report', async (kind) => {
  const { receipts, launch, launcher } = recoveryFixture();
  receipts.observation(launch.launchId, {
    ...receipts.observation(launch.launchId)!,
    launcher: { ...launcher, pid: 2147483647 },
  });
  fs.writeFileSync(
    receipts.artifact(launch.launchId, 'stdout.log'),
    (kind === 'malformed' ? '{bad}\n' : 'x'.repeat(400) + '\n') + outputFrames(),
  );
  fs.writeFileSync(receipts.artifact(launch.launchId, 'native.md'), 'Report');
  let now = 0;
  const bounds = { frameBytes: 256, readBytes: 17, workBytes: 512 };
  const runtime = {
    now: () => now,
    identity: async () => null,
    yield: async () => {
      now += 8_640_000;
    },
  };
  const file = receipts.artifact(launch.launchId, 'stdout.log');
  for (
    let attempt = 0;
    attempt < 20 && (receipts.scan(launch.launchId) as any)?.offset !== fs.statSync(file).size;
    attempt++
  )
    await superviseStandalone(receipts, launch.launchId, true, bounds, runtime);
  assert.equal((receipts.scan(launch.launchId) as any).offset, fs.statSync(file).size);
  assert.equal(receipts.latest(launch.launchId), null);
  assert.ok(fs.readFileSync(file, 'utf8').endsWith(outputFrames()));
});

test.each([1, 999] as const)('checkpoint version %s remains compatible', async (version) => {
  const { receipts, launch } = recoveryFixture();
  fs.writeFileSync(receipts.artifact(launch.launchId, 'stdout.log'), outputFrames());
  fs.writeFileSync(receipts.artifact(launch.launchId, 'native.md'), 'Report');
  receipts.scan(launch.launchId, {
    version,
    offset: 0,
    identity: '',
    frames: new StandaloneFrames('codex', null).snapshot(),
  });
  await superviseStandalone(
    receipts,
    launch.launchId,
    true,
    { frameBytes: 256, readBytes: 17, workBytes: 1024 },
    {
      now: () => 0,
      identity: async () => ({ command: 'node', commandLine: 'node', startedAt: 'different' }),
      yield: () => Promise.resolve(),
    },
  );
  const event = receipts.latest(launch.launchId)!;
  assert.equal((receipts.result(launch.launchId, event.eventId) as any).text, 'Report');
});

test.each([null, 'SIGTERM'] as const)('exact-budget EOF retains captured ending %s', async (signal) => {
  const { receipts, launch } = recoveryFixture();
  const output = outputFrames();
  fs.writeFileSync(receipts.artifact(launch.launchId, 'stdout.log'), output);
  fs.writeFileSync(receipts.artifact(launch.launchId, 'native.md'), 'Report');
  receipts.observation(launch.launchId, {
    ...receipts.observation(launch.launchId)!,
    exitCode: signal ? null : 0,
    signal,
  });
  await superviseStandalone(receipts, launch.launchId, true, {
    frameBytes: 256,
    readBytes: 17,
    workBytes: Buffer.byteLength(output),
  });
  assert.equal(receipts.observation(launch.launchId)?.monitor, 'finished');
  assert.equal(receipts.observation(launch.launchId)?.reason, undefined);
  assert.equal(receipts.observation(launch.launchId)?.signal, signal);
  const event = receipts.latest(launch.launchId)!;
  assert.equal(event.outcome, signal ? 'interrupted' : 'succeeded');
});

test('fresh close at exact-budget EOF completes its original report', async () => {
  const { options } = receiptsFixture();
  const descriptor = fs.openSync(path.join(options.cwd, 'output.log'), 'w');
  const child = new ChildProcess();
  const output = Buffer.from(outputFrames());
  try {
    const observed = observeProcess(
      child,
      options,
      () => {},
      descriptor,
      descriptor,
      function* () {
        yield output;
        return true;
      },
      { frameBytes: 256, readBytes: output.length, workBytes: output.length },
      {
        now: () => 0,
        identity: standaloneProcessIdentity,
        yield: () => Promise.resolve(),
      },
    );
    child.emit('close', 0, null);
    const ending = await observed;
    assert.equal(ending.timedOut, undefined);
    assert.equal(ending.frames.finish(ending.exitCode, ending.signal, 'Report').text, 'Report');
  } finally {
    fs.closeSync(descriptor);
  }
});

function backgroundFixture(logged = false, env = process.env) {
  const { home, args } = fixture();
  const options = parseRun(
    [
      ...args.map((value, index) => (index === 1 ? 'claude' : value)),
      ...(logged ? ['--log', path.join(home, 'native.log')] : []),
    ],
    env,
  ).options;
  const script = path.join(home, 'native claude.cjs');
  const calls = path.join(home, 'calls.jsonl');
  fs.writeFileSync(
    script,
    `const fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({args,cwd:process.cwd()})+'\\n');if(args.includes('--bg')){process.stdin.resume();process.stdin.on('end',()=>console.log('backgrounded \u00b7 deadbeef \u00b7 ${options.name}'));}else if(args[0]==='agents')console.log(JSON.stringify([{id:'deadbeef',sessionId:'${session}',state:'stopped',pid:123}]));else if(args[0]==='logs')process.stdout.write(Buffer.from([110,97,116,105,118,101,0,255]));`,
  );
  const receipts = new DispatchReceipts(home);
  const launch = receipts.reserve({
    origin: 'd'.repeat(24),
    requester: null,
    policy: null,
    completion: 'manual',
    promptSha256: payloadSha256('Review this folder.'),
    alias: null,
    transport: 'standalone',
    standalone: { ...options, command: process.execPath, args: [script, ...options.args] },
  });
  receipts.input(launch.launchId, 'Review this folder.');
  return { receipts, launch, options, script, calls };
}

test('mixed native session lists retain the launch-bound job and completed report', async () => {
  const { home } = fixture();
  const { receipts, launch, options, script } = backgroundFixture(false, {
    ...process.env,
    ARC_PROJECTS_ROOT: path.join(home, 'projects'),
  });
  receipts.background(launch.launchId, 'deadbeef');
  receipts.observation(launch.launchId, {
    supervisor: { pid: process.pid, token: 'retained' },
    worker: null,
    sessionId: null,
    exitCode: null,
    signal: null,
    monitor: 'observing',
  });
  const source = path.join(options.env!.ARC_PROJECTS_ROOT!, projectSlug(options.cwd), `${session}.jsonl`);
  fs.mkdirSync(path.dirname(source), { recursive: true });
  const at = '2026-01-01T00:00:00Z';
  fs.writeFileSync(
    source,
    JSON.stringify({
      type: 'user',
      uuid: 'prompt',
      timestamp: at,
      message: { role: 'user', content: 'Review this folder.' },
    }) + '\n',
  );
  const registry = vi.mocked(promisify(childProcess.execFile));
  registry.mockImplementation((_command, args, settings) => {
    const call = registry.mock.calls.length;
    assert.ok(call <= 3, 'Registry invocation bound exceeded.');
    assert.deepEqual(args, [script, 'agents', '--json']);
    assert.equal(settings?.timeout, 20_000);
    assert.equal(settings?.maxBuffer, 4 * 1024 * 1024);
    if (call === 2)
      fs.appendFileSync(
        source,
        JSON.stringify({
          type: 'assistant',
          timestamp: at,
          message: {
            id: 'response',
            role: 'assistant',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'Completed report' }],
            usage: { input_tokens: 1, output_tokens: 2 },
          },
        }) + '\n',
      );
    const stdout = JSON.stringify([
      { pid: 456, cwd: options.cwd, kind: 'interactive', startedAt: at, status: 'busy' },
      { id: 'deadbeef', sessionId: session, state: call === 1 ? 'working' : 'done', pid: 123 },
    ]);
    return Object.assign(Promise.resolve({ stdout, stderr: '' }), { child: new ChildProcess() });
  });
  vi.useFakeTimers();
  const pending = superviseStandalone(receipts, launch.launchId, true, {
    frameBytes: 256,
    readBytes: 17,
    workBytes: 1024,
  });
  await vi.advanceTimersByTimeAsync(6_000);
  await pending;
  const observation = receipts.observation(launch.launchId)!;
  assert.equal(
    observation.sessionId === session,
    true,
    'Launch-bound job must remain observable beside interactive sessions.',
  );
  assert.equal(registry.mock.calls.length, 2);
  assert.equal(observation.monitor, 'finished');
  assert.equal(observation.worker, null);
  assert.equal(observation.exitCode, null);
  const event = receipts.latest(launch.launchId)!;
  assert.equal(event.outcome, 'succeeded');
  assert.equal(event.availability, 'available');
  assert.equal((receipts.result(launch.launchId, event.eventId) as { text: string }).text, 'Completed report');
});

test.each(['exit', 'timeout', 'parse', 'shape', 'spawn'] as const)(
  'background observation retains registry failure causes for %s',
  async (kind) => {
    const { receipts, launch, script } = backgroundFixture();
    receipts.background(launch.launchId, 'deadbeef');
    receipts.observation(launch.launchId, {
      supervisor: { pid: process.pid, token: 'retained' },
      worker: null,
      sessionId: null,
      exitCode: null,
      signal: null,
      monitor: 'observing',
    });
    const registry = vi.mocked(promisify(childProcess.execFile));
    registry.mockImplementation((_command, args, settings) => {
      assert.ok(registry.mock.calls.length <= 3, 'Registry invocation bound exceeded.');
      assert.deepEqual(args, [script, 'agents', '--json']);
      assert.equal(settings?.timeout, 20_000);
      assert.equal(settings?.maxBuffer, 4 * 1024 * 1024);
      const error = Object.assign(new Error('Native command failed'), {
        code: kind === 'exit' ? 7 : 'ENOENT',
        killed: kind === 'timeout',
        stderr: 'native diagnostic ' + 'x'.repeat(700),
      });
      const response =
        kind === 'parse' || kind === 'shape'
          ? Promise.resolve({ stdout: kind === 'parse' ? '{broken' : '{}', stderr: '' })
          : Promise.reject(error);
      return Object.assign(response, { child: new ChildProcess() });
    });
    vi.useFakeTimers();
    const pending = superviseStandalone(receipts, launch.launchId, true);
    await vi.advanceTimersByTimeAsync(6_000);
    await pending;
    const observation = receipts.observation(launch.launchId)!;
    const expected = {
      exit: 'exited with code 7',
      timeout: 'timed out',
      parse: 'invalid JSON',
      shape: 'invalid session list',
      spawn: 'could not start (ENOENT)',
    }[kind];
    assert.equal(observation.reason?.includes(expected), true, 'Registry failure cause must survive observation.');
    assert.ok(observation.reason!.length < 512);
    if (kind === 'exit' || kind === 'timeout' || kind === 'spawn')
      assert.equal(observation.reason!.includes('native diagnostic'), true);
    assert.equal(registry.mock.calls.length, 3);
    assert.equal(observation.monitor, 'unavailable');
    assert.equal(observation.worker, null);
    assert.equal(observation.sessionId, null);
    assert.equal(observation.exitCode, null);
    assert.equal(receipts.latest(launch.launchId)?.outcome, 'unknown');
    assert.equal(receipts.latest(launch.launchId)?.availability, 'pending');
  },
);

test('legacy background receipts refuse colliding native roots while saved reports remain readable', async () => {
  const { home } = fixture();
  const roots = [path.join(home, 'original'), path.join(home, 'later')];
  const { receipts, launch: template, options, script } = backgroundFixture(true, { CLAUDE_BIN: process.execPath });
  const calls = roots.map((root) => path.join(root, 'actions.jsonl'));
  for (const root of roots) {
    fs.mkdirSync(root);
    fs.writeFileSync(
      path.join(root, 'agents.json'),
      JSON.stringify([{ id: 'deadbeef', sessionId: session, state: 'stopped' }]),
    );
  }
  fs.writeFileSync(
    script,
    `const fs=require('node:fs');const path=require('node:path');const root=process.env.CLAUDE_CONFIG_DIR;fs.appendFileSync(path.join(root,'actions.jsonl'),JSON.stringify(process.argv.slice(2))+'\\n');console.log(fs.readFileSync(path.join(root,'agents.json'),'utf8'));`,
  );
  const legacy = () => {
    const launch = receipts.reserve({
      ...template,
      standalone: { ...template.standalone!, env: undefined },
    });
    receipts.input(launch.launchId, 'Review this folder.');
    receipts.background(launch.launchId, 'deadbeef');
    receipts.observation(launch.launchId, {
      supervisor: { pid: process.pid, token: 'legacy' },
      worker: null,
      sessionId: null,
      exitCode: null,
      signal: null,
      monitor: 'observing',
    });
    return launch;
  };
  const pending = legacy();
  const saved = legacy();
  const event = receipts.publish(
    saved.launchId,
    {
      outcome: 'succeeded',
      availability: 'available',
      nativeEnding: null,
      askId: null,
    },
    'Retained saved report',
  );
  const opened: string[] = [];
  const open = fs.openSync;
  vi.spyOn(fs, 'openSync').mockImplementation((file, ...rest) => {
    if (roots.some((root) => String(file).startsWith(root))) opened.push(String(file));
    return open(file, ...rest);
  });
  for (const root of roots) {
    vi.stubEnv('CLAUDE_CONFIG_DIR', root);
    vi.stubEnv('ARC_PROJECTS_ROOT', root);
    for (const action of ['logs', 'attach', 'stop'] as const) {
      await assert.rejects(
        runBackgroundManagement(action, [pending.launchId], receipts),
        /original Claude configuration is unavailable/,
      );
      await assert.rejects(
        runBackgroundManagement(action, [saved.launchId], receipts),
        /original Claude configuration is unavailable/,
      );
    }
    await assert.rejects(
      superviseStandalone(receipts, pending.launchId, true),
      /original Claude configuration is unavailable/,
    );
    await assert.rejects(
      produceStandaloneOutput(receipts, pending.launchId),
      /original Claude configuration is unavailable/,
    );
    await superviseStandalone(receipts, saved.launchId, true);
    assert.equal((receipts.result(saved.launchId, event.eventId) as any).text, 'Retained saved report');
    assert.equal(receipts.status(saved.launchId).events.length, 1);
  }
  assert.deepEqual(opened, []);
  assert.equal(
    calls.some((file) => fs.existsSync(file)),
    false,
  );
  assert.equal(vi.mocked(childProcess.spawn).mock.calls.length, 0);
  assert.equal(fs.existsSync(options.logAlias!), false);
});

test('background management and recovery retain the launch context across different callers', async () => {
  const { home } = fixture();
  const selected = {
    ...process.env,
    CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
    CODEX_HOME: path.join(home, 'codex'),
    ARC_PROJECTS_ROOT: path.join(home, 'projects'),
    CODEX_MANAGED_PACKAGE_ROOT: path.join(home, 'package'),
  };
  const { receipts, launch, options, script, calls } = backgroundFixture(true, selected);
  const keys = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'ARC_PROJECTS_ROOT', 'CODEX_MANAGED_PACKAGE_ROOT'];
  fs.writeFileSync(
    script,
    `const fs=require('node:fs');const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({args,env:Object.fromEntries(${JSON.stringify(keys)}.map(k=>[k,process.env[k]]))})+'\\n');
if(args.includes('--bg')){process.stdin.resume();process.stdin.on('end',()=>console.log('backgrounded · deadbeef · ${options.name}'));}
else if(args[0]==='agents')console.log(JSON.stringify([{id:'deadbeef',sessionId:'${session}',state:'stopped',pid:123}]));
else if(args[0]==='logs')console.log('Native output');`,
  );
  for (const key of keys) vi.stubEnv(key, path.join(home, 'foreign'));
  await superviseStandalone(receipts, launch.launchId, false);
  for (const action of ['logs', 'attach', 'stop'] as const)
    await runBackgroundManagement(action, [launch.launchId], receipts);
  await produceStandaloneOutput(receipts, launch.launchId);
  assert.match(fs.readFileSync(options.logAlias!, 'utf8'), /Native output/);
  const source = path.join(selected.ARC_PROJECTS_ROOT, projectSlug(options.cwd), `${session}.jsonl`);
  fs.mkdirSync(path.dirname(source), { recursive: true });
  const at = '2026-01-01T00:00:00Z';
  fs.writeFileSync(
    source,
    [
      { type: 'user', uuid: 'prompt', timestamp: at, message: { role: 'user', content: 'Review this folder.' } },
      {
        type: 'assistant',
        timestamp: at,
        message: {
          id: 'response',
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Original context report' }],
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  );
  await superviseStandalone(receipts, launch.launchId, true);
  const event = receipts.latest(launch.launchId)!;
  assert.equal(event.availability, 'available');
  assert.equal((receipts.result(launch.launchId, event.eventId) as { text: string }).text, 'Original context report');
  const nativeCalls = fs
    .readFileSync(calls, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    nativeCalls.map((call) => (call.args.includes('--bg') ? '--bg' : call.args[0])),
    ['--bg', 'agents', 'logs', 'logs', 'attach', 'stop', 'agents', 'logs', 'agents', 'logs'],
  );
  for (const call of nativeCalls) {
    assert.deepEqual(call.env, Object.fromEntries(keys.map((key) => [key, selected[key as keyof typeof selected]])));
    if (!call.args.includes('--bg') && call.args[0] !== 'agents') assert.equal(call.args[1], 'deadbeef');
  }
});

test('attended Claude opens only its bound launch and preserves results when terminal attach fails', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  for (const fails of [false, true]) {
    const { home } = fixture();
    for (const file of ['git.exe', 'wt.exe', 'bash.exe']) fs.writeFileSync(path.join(home, file), '');
    vi.stubEnv('PATH', home);
    vi.stubEnv('DISPATCH_CLI_BASH', path.join(home, 'bash.exe'));
    vi.stubEnv('TMUX', 'owned');
    const { receipts, launch, options, script, calls } = backgroundFixture();
    const terminal = new ChildProcess();
    vi.spyOn(terminal, 'unref').mockImplementation(() => {});
    const terminalCalls: string[][] = [];
    vi.mocked(childProcess.spawn).mockImplementation((command, args, spawnOptions) => {
      if (command === process.execPath) return actual.spawn(command, args as string[], spawnOptions);
      assert.equal(receipts.background(launch.launchId), 'deadbeef');
      terminalCalls.push(args as string[]);
      queueMicrotask(() =>
        fails ? terminal.emit('error', new Error('terminal unavailable')) : terminal.emit('spawn'),
      );
      return terminal;
    });
    await runSupervisor(launch.launchId, true, receipts, path.join(options.cwd, 'arc.cjs'));
    assert.equal(terminalCalls.length, 1);
    const attend = fs.readFileSync(receipts.artifact(launch.launchId, 'attend.sh'), 'utf8');
    assert.ok(attend.includes(`'dispatch' 'attach' '${launch.launchId}'`));
    assert.equal(receipts.background(launch.launchId), 'deadbeef');
    assert.equal(receipts.observation(launch.launchId)?.exitCode, null);
    assert.equal(receipts.observation(launch.launchId)?.worker, null);
    assert.equal(receipts.latest(launch.launchId)?.outcome, 'interrupted');
    const nativeCalls = fs
      .readFileSync(calls, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(nativeCalls.filter((call) => call.args.includes('--bg')).length, 1);
    assert.equal(nativeCalls[0].args[0], '--bg');
    assert.equal(script, path.join(options.cwd, 'native claude.cjs'));
    if (fails)
      assert.match(fs.readFileSync(receipts.artifact(launch.launchId, 'stderr.log'), 'utf8'), /terminal did not open/);
  }
});

test('an attended terminal spawn failure returns its reserved identity without a replacement', async () => {
  const { home, args } = fixture();
  const receipts = new DispatchReceipts(home);
  vi.mocked(childProcess.spawn).mockImplementationOnce(() => {
    const child = new ChildProcess();
    queueMicrotask(() => child.emit('error', new Error('terminal unavailable')));
    return child;
  });
  const result = JSON.parse(
    await runStandalone([...args, '--attach'], 'arc.cjs', {
      receipts,
      platform: 'linux',
      env: { CODEX_BIN: process.execPath, TMUX: 'owned' },
    }),
  );
  assert.equal(result.state, 'accepted-with-errors');
  assert.equal(receipts.launch(result.launchId).transport, 'standalone');
  assert.equal(receipts.latest(result.launchId)?.outcome, 'unknown');
  assert.equal(receipts.observation(result.launchId), null);
  assert.equal(vi.mocked(childProcess.spawn).mock.calls.length, 1);
});

test('successful background launch binds native management without treating a job ID or registry PID as a session', async () => {
  const { receipts, launch, script, options, calls } = backgroundFixture();
  await superviseStandalone(receipts, launch.launchId, false);
  assert.equal(receipts.background(launch.launchId), 'deadbeef');
  assert.equal(receipts.observation(launch.launchId)?.sessionId, session);
  assert.equal(receipts.standaloneSession(launch.launchId), session);
  assert.equal(receipts.observation(launch.launchId)?.worker, null);
  assert.equal(receipts.observation(launch.launchId)?.exitCode, null);
  for (const action of ['logs', 'attach', 'stop'] as const) {
    assert.equal(findCommand(['dispatch', action])?.action, `standalone-${action}`);
    assert.deepEqual(backgroundCommand(receipts, launch.launchId, action), {
      command: process.execPath,
      args: [script, action, 'deadbeef'],
      cwd: options.cwd,
    });
    const result = JSON.parse(await runBackgroundManagement(action, [launch.launchId], receipts));
    assert.equal(result.status, 'completed');
  }
  const nativeCalls = fs
    .readFileSync(calls, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    nativeCalls.slice(-3),
    ['logs', 'attach', 'stop'].map((action) => ({ args: [action, 'deadbeef'], cwd: options.cwd })),
  );
  assert.equal(receipts.observation(launch.launchId)?.exitCode, null);
  assert.throws(() => receipts.background(launch.launchId, 'badc0ffe'), /cannot change/);
  await assert.rejects(runBackgroundManagement('stop', ['deadbeef'], receipts));
  await assert.rejects(runBackgroundManagement('stop', [launch.launchId, 'badc0ffe'], receipts));
  assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 5);
});

test.each(['missing', 'ambiguous', 'nonzero', 'signal', 'deadline'] as const)(
  'background %s acknowledgment grants no management ownership',
  (kind) => {
    const { receipts, launch, options } = backgroundFixture();
    const output = `backgrounded \u00b7 deadbeef \u00b7 ${options.name}`;
    const backgroundId = bindBackgroundLaunch(receipts, launch.launchId, {
      exitCode: kind === 'nonzero' ? 1 : 0,
      signal: kind === 'signal' ? 'SIGTERM' : null,
      timedOut: kind === 'deadline',
      backgroundOutput: kind === 'missing' ? '' : kind === 'ambiguous' ? output + '\n' + output : output,
    });
    assert.equal(backgroundId, null);
    for (const action of ['logs', 'attach', 'stop', 'rm'] as const)
      assert.throws(() => backgroundCommand(receipts, launch.launchId, action), /identity is unavailable/);
    assert.equal(receipts.background(launch.launchId), null);
  },
);

test('background binding refuses foreign providers and replaced accepted identity', () => {
  const { receipts, launch } = receiptsFixture();
  assert.throws(() => receipts.background(launch.launchId, 'deadbeef'));
  const owned = backgroundFixture();
  owned.receipts.background(owned.launch.launchId, 'deadbeef');
  const file = path.join(owned.receipts.root, owned.launch.launchId, 'background.json');
  const bytes = fs.readFileSync(file);
  fs.renameSync(file, file + '.original');
  fs.writeFileSync(file, bytes);
  assert.throws(() => backgroundCommand(owned.receipts, owned.launch.launchId, 'stop'), /cannot change|replaced/);
});

test('record removal refuses before native execution and preserves supplied files and receipts', async () => {
  const { receipts, launch, options } = backgroundFixture();
  receipts.background(launch.launchId, 'deadbeef');
  assert.equal(findCommand(['dispatch', 'rm'])?.action, 'standalone-rm');
  const files = [path.join(options.cwd, 'original.jsonl'), path.join(options.cwd, '.git', 'refs', 'heads', 'supplied')];
  for (const file of files) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'retained');
  }
  const before = JSON.stringify(receipts.launch(launch.launchId));
  for (const args of [[launch.launchId], ['deadbeef'], [launch.launchId, '--force'], [launch.launchId, 'other']])
    await assert.rejects(runBackgroundManagement('rm', args, receipts));
  assert.throws(() => backgroundCommand(receipts, launch.launchId, 'rm'), /preservation is established/);
  assert.equal(vi.mocked(childProcess.spawn).mock.calls.length, 0);
  for (const file of files) assert.equal(fs.readFileSync(file, 'utf8'), 'retained');
  assert.equal(JSON.stringify(receipts.launch(launch.launchId)), before);
  assert.equal(receipts.background(launch.launchId), 'deadbeef');
});

test.each(['claude', 'codex'] as const)(
  'native %s launch receipts follow JSON and retain classification',
  async (provider) => {
    for (const classification of [
      [],
      ['--agent-run'],
      ['--agent-run=true'],
      ['--agent-run=false'],
      ['--attach', '--agent-run'],
    ]) {
      const { home, args } = fixture();
      const receipts = new DispatchReceipts(home);
      const reserved = vi.spyOn(receipts, 'reserve');
      const spoof = 'ARC_DISPATCH_SESSION={"agent":"codex","session_id":"bbbbbbbb-1111-2222-3333-444444444444"}';
      const child = new ChildProcess();
      vi.spyOn(child, 'unref').mockImplementation(() => {});
      vi.mocked(childProcess.spawn).mockImplementationOnce(() => {
        const launch = reserved.mock.results.at(-1)!.value;
        if (!(provider === 'codex' && classification.includes('--attach'))) {
          receipts.standaloneSession(launch.launchId, launch.standalone.sessionHint ?? session);
          receipts.publish(
            launch.launchId,
            { outcome: 'succeeded', availability: 'available', nativeEnding: null, askId: null },
            spoof,
          );
        }
        queueMicrotask(() => child.emit('spawn'));
        return child;
      });
      const result = await runStandalone(
        [...args.map((value, i) => (i === 1 ? provider : value)), '--arc-dispatch', ...classification],
        'arc.cjs',
        {
          receipts,
          platform: 'linux',
          env: { CODEX_BIN: process.execPath, CLAUDE_BIN: process.execPath, TMUX: 'owned' },
        },
      );
      const lines = result.split('\n');
      const launch = receipts.launch(JSON.parse(lines[0]).launchId);
      assert.equal(lines.length, provider === 'codex' && classification.includes('--attach') ? 1 : 2);
      if (lines.length === 2) {
        const marker = JSON.parse(lines[1].slice('ARC_DISPATCH_SESSION='.length));
        assert.equal(marker.agent, provider);
        assert.equal(marker.session_id, receipts.standaloneSession(launch.launchId));
        assert.equal(marker.name, launch.standalone!.name);
        assert.equal(marker.owned === true, !launch.standalone!.agentRun);
      }
      assert.equal(result.includes(spoof), false);
      assert.equal(vi.mocked(childProcess.spawn).mock.calls.length, 1);
      vi.mocked(childProcess.spawn).mockClear();
    }
  },
);

test.each([
  'valid',
  'missing',
  'preexisting',
  'wrong ID',
  'wrong cwd',
  'wrong prompt',
  'partial',
  'replaced',
  'unreadable',
  'redirected',
  'replaced after acceptance',
  'timeout unchanged',
  'timeout replacement',
  'timeout rewritten',
  'timeout unreadable',
  'timeout missing evidence',
  'timeout missing all evidence',
  'conflicting final',
  'malformed final',
  'duplicate final',
] as const)('Claude print startup admits only the original submitted turn with %s evidence', async (state) => {
  vi.useFakeTimers();
  const { home, args } = fixture();
  const parsed = parseRun([...args.map((arg, i) => (i === 1 ? 'claude' : arg)), '--read-only'], {
    CLAUDE_BIN: process.execPath,
    ARC_PROJECTS_ROOT: path.join(home, 'projects'),
  });
  const options = parsed.options;
  const file = path.join(options.env!.ARC_PROJECTS_ROOT!, projectSlug(home), `${options.sessionHint}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = JSON.stringify({
    type: 'user',
    uuid: 'native-user',
    sessionId: state === 'wrong ID' ? session : options.sessionHint,
    cwd: state === 'wrong cwd' ? os.tmpdir() : home,
    message: { role: 'user', content: state === 'wrong prompt' ? 'Another prompt.' : parsed.prompt },
  });
  if (state === 'preexisting') fs.writeFileSync(file, record + '\n');
  const receipts = new DispatchReceipts(home);
  const launch = receipts.reserve({
    origin: 'e'.repeat(24),
    requester: null,
    policy: parsed.policy,
    completion: 'manual',
    promptSha256: payloadSha256(parsed.prompt),
    alias: null,
    transport: 'standalone',
    standalone: options,
  });
  receipts.input(launch.launchId, parsed.prompt);
  const child = new ChildProcess();
  child.stdin = new PassThrough();
  let stdout = -1;
  vi.mocked(childProcess.spawn).mockImplementationOnce((_command, _args, settings) => {
    stdout = (settings.stdio as number[])[1];
    if (state !== 'missing' && state !== 'preexisting')
      fs.writeFileSync(file, record + (state === 'partial' || state === 'replaced' ? '' : '\n'));
    return child;
  });
  if (state === 'unreadable') {
    const original = vi.mocked(fs.statSync).getMockImplementation()!;
    vi.mocked(fs.statSync).mockImplementation(((target, ...rest) => {
      if (target === file) throw Object.assign(new Error('Native transcript unavailable'), { code: 'EACCES' });
      return original(target, ...rest);
    }) as typeof fs.statSync);
  }
  if (state === 'redirected') {
    const original = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation(((target, ...rest) => {
      const stat = original(target, ...rest);
      if (target !== file || !stat) return stat;
      const redirected = Object.create(stat);
      redirected.isSymbolicLink = () => true;
      return redirected;
    }) as typeof fs.lstatSync);
  }
  const supervised = superviseStandalone(receipts, launch.launchId, false, undefined, {
    now: Date.now,
    identity: async () => null,
    yield: async () => {},
  });
  try {
    await vi.advanceTimersByTimeAsync(100);
    const early =
      ['valid', 'replaced after acceptance', 'conflicting final', 'malformed final', 'duplicate final'].includes(
        state,
      ) || state.startsWith('timeout ');
    assert.equal(receipts.standaloneSession(launch.launchId), early ? options.sessionHint : null);
    assert.equal(receipts.latest(launch.launchId), null);
    assert.equal(fs.readFileSync(receipts.artifact(launch.launchId, 'stdout.log'), 'utf8'), '');
    const timedOut = state.startsWith('timeout ');
    if (timedOut) {
      await vi.advanceTimersByTimeAsync(options.deadlineMs);
      await supervised;
      assert.equal(receipts.observation(launch.launchId)?.monitor, 'timed-out');
      assert.equal(receipts.latest(launch.launchId)?.availability, 'pending');
    }
    if (state === 'partial') {
      fs.appendFileSync(file, '\n');
      await vi.advanceTimersByTimeAsync(100);
      assert.equal(receipts.standaloneSession(launch.launchId), options.sessionHint);
    }
    if (state === 'replaced' || state === 'replaced after acceptance' || state === 'timeout replacement') {
      fs.renameSync(file, file + '.original');
      fs.writeFileSync(file, record + '\n');
      await vi.advanceTimersByTimeAsync(100);
      if (state === 'replaced') assert.equal(receipts.standaloneSession(launch.launchId), null);
    }
    if (state === 'timeout rewritten') fs.writeFileSync(file, record.replace('native-user', 'changed-user') + '\n');
    const final =
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        session_id: state === 'conflicting final' ? session : options.sessionHint,
        result: 'Report',
        is_error: false,
      }) + '\n';
    const output = state === 'malformed final' ? 'malformed\n' : final + (state === 'duplicate final' ? final : '');
    if (timedOut) fs.appendFileSync(receipts.artifact(launch.launchId, 'stdout.log'), output);
    else fs.writeSync(stdout, output);
    child.emit('close', 0, null);
    await supervised;
    const unknown =
      timedOut ||
      ['replaced after acceptance', 'conflicting final', 'malformed final', 'duplicate final'].includes(state);
    assert.equal(receipts.latest(launch.launchId)?.outcome, unknown ? 'unknown' : 'succeeded');
    assert.equal(receipts.latest(launch.launchId)?.report === null, unknown);
    if (timedOut || state === 'replaced after acceptance') {
      const pending = receipts.latest(launch.launchId)!;
      const startupFile = path.join(receipts.root, launch.launchId, 'startup.json');
      const missing = state === 'timeout missing evidence' || state === 'timeout missing all evidence';
      const retained = [
        startupFile,
        ...(state === 'timeout missing all evidence'
          ? [
              path.join(receipts.root, `${launch.launchId}.startup.json`),
              path.join(receipts.root, `${launch.launchId}.startup.accepting.json`),
            ]
          : []),
      ].filter((target) => fs.existsSync(target));
      if (missing) for (const target of retained) fs.renameSync(target, target + '.held');
      const open = fs.openSync;
      const close = fs.closeSync;
      const read = fs.readSync;
      const nativeDescriptors = new Set<number>();
      const nativeReadSizes: number[] = [];
      let nativeYields = 0;
      const denied = vi.spyOn(fs, 'openSync').mockImplementation((target, ...rest) => {
        if (state === 'timeout unreadable' && String(target) === file)
          throw Object.assign(new Error('Native transcript unavailable'), { code: 'EACCES' });
        const fd = Reflect.apply(open, fs, [target, ...rest]);
        if (String(target) === file) nativeDescriptors.add(fd);
        return fd;
      });
      const closed = vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
        nativeDescriptors.delete(fd);
        return close(fd);
      });
      const reads = vi.spyOn(fs, 'readSync').mockImplementation((...args) => {
        const values: readonly unknown[] = args;
        if (nativeDescriptors.has(args[0])) nativeReadSizes.push(Number(values[3]));
        return Reflect.apply(read, fs, args);
      });
      const recover = () =>
        superviseStandalone(
          new DispatchReceipts(home),
          launch.launchId,
          true,
          { frameBytes: 1024, readBytes: 17, workBytes: 2048 },
          {
            now: () => 0,
            identity: async () => null,
            yield: async () => {
              if (nativeReadSizes.length) nativeYields++;
            },
          },
        );
      await recover();
      denied.mockRestore();
      closed.mockRestore();
      reads.mockRestore();
      if (state === 'timeout unchanged') {
        const recovered = receipts.latest(launch.launchId)!;
        assert.equal(recovered.outcome, 'unknown');
        assert.equal(recovered.availability, 'available');
        assert.equal((receipts.result(launch.launchId, recovered.eventId) as any).text, 'Report');
        assert.ok(nativeReadSizes.length > 1);
        assert.ok(nativeReadSizes.every((bytes) => bytes <= 17));
        assert.ok(nativeYields > 0);
      } else {
        assert.deepEqual(receipts.latest(launch.launchId), pending);
        assert.equal(pending.outcome, 'unknown');
        assert.equal(pending.availability, 'pending');
        assert.equal(pending.report, null);
        if (state === 'timeout unreadable' || missing) {
          if (missing) for (const target of retained) fs.renameSync(target + '.held', target);
          await recover();
          assert.equal(receipts.latest(launch.launchId)?.availability, 'available');
        } else {
          if (state === 'timeout rewritten') fs.writeFileSync(file, record + '\n');
          else {
            fs.unlinkSync(file);
            fs.renameSync(file + '.original', file);
          }
          await recover();
          assert.deepEqual(receipts.latest(launch.launchId), pending);
        }
      }
      const recovered = receipts.latest(launch.launchId)!;
      await recover();
      assert.equal(receipts.latest(launch.launchId)?.eventId, recovered.eventId);
    }
    assert.equal(vi.mocked(childProcess.spawn).mock.calls.length, 1);
  } finally {
    child.emit('close', 0, null);
    await supervised;
  }
});

test.each([
  'initial rewrite',
  'initial append',
  'recovered rewrite',
  'recovered final rewrite',
  'recovered append',
  'recovered final append',
  'recovered cumulative exhaustion',
  'recovered unqualified exhaustion',
  'recovered deadline exhaustion',
  'recovered final deadline exhaustion',
  'recovered zero progress',
  'all acceptance unavailable',
  'binding unavailable',
] as const)('Claude print continuity validates reports with %s', async (state) => {
  vi.useFakeTimers();
  const { home, args } = fixture();
  const parsed = parseRun([...args.map((arg, i) => (i === 1 ? 'claude' : arg)), '--read-only'], {
    CLAUDE_BIN: process.execPath,
    ARC_PROJECTS_ROOT: path.join(home, 'projects'),
  });
  const options = parsed.options;
  const file = path.join(options.env!.ARC_PROJECTS_ROOT!, projectSlug(home), `${options.sessionHint}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original =
    JSON.stringify({
      type: 'user',
      uuid: 'native-user',
      padding: ' '.repeat(256),
      sessionId: options.sessionHint,
      cwd: home,
      message: { role: 'user', content: parsed.prompt },
    }) + '\n';
  const receipts = new DispatchReceipts(home);
  const launch = receipts.reserve({
    origin: 'e'.repeat(24),
    requester: null,
    policy: parsed.policy,
    completion: 'manual',
    promptSha256: payloadSha256(parsed.prompt),
    alias: null,
    transport: 'standalone',
    standalone: options,
  });
  receipts.input(launch.launchId, parsed.prompt);
  const child = new ChildProcess();
  child.stdin = new PassThrough();
  let stdout = -1;
  vi.mocked(childProcess.spawn).mockImplementationOnce((_command, _args, settings) => {
    stdout = (settings.stdio as number[])[1];
    fs.writeFileSync(file, original);
    fs.utimesSync(file, 1_000_000_000, 1_000_000_000);
    return child;
  });
  const append = state.includes('append');
  const exhausted = state.includes('exhaustion');
  const bounds = {
    frameBytes: 2048,
    readBytes: state === 'recovered final append' ? 2048 : 128,
    workBytes: 4096,
  };
  let duringYield = () => {};
  let clock = Date.now();
  const runtime = { now: () => clock, identity: async () => null, yield: async () => duringYield() };
  const supervised = superviseStandalone(receipts, launch.launchId, false, bounds, runtime);
  await vi.waitFor(() => assert.equal(receipts.standaloneSession(launch.launchId), options.sessionHint));
  const initial = state.startsWith('initial');
  if (!initial) {
    await vi.advanceTimersByTimeAsync(options.deadlineMs);
    await supervised;
    assert.equal(receipts.latest(launch.launchId)?.availability, 'pending');
  }
  const pending = receipts.latest(launch.launchId);
  if (state.includes('cumulative') || state.includes('unqualified'))
    bounds.workBytes = Buffer.byteLength(original) * 2 + 31;
  const held =
    state === 'all acceptance unavailable'
      ? [
          path.join(receipts.root, launch.launchId, 'startup.json'),
          path.join(receipts.root, `${launch.launchId}.startup.json`),
          path.join(receipts.root, `${launch.launchId}.startup.accepting.json`),
          path.join(receipts.root, launch.launchId, 'accepted.json'),
        ]
      : state === 'binding unavailable'
        ? [path.join(receipts.root, launch.launchId, 'accepted.json')]
        : [];
  for (const target of held) fs.renameSync(target, target + '.held');
  const before = fs.statSync(file, { bigint: true });
  const nativeDescriptors = new Set<number>();
  const open = fs.openSync;
  const close = fs.closeSync;
  const read = fs.readSync;
  let nativeBytes = 0;
  const nativeReads: number[] = [];
  let yields = 0;
  let changes = 0;
  let expiredAtBytes: number | null = null;
  let lateReads = 0;
  let changed = false;
  const change = () => {
    if (changed && !exhausted) return;
    changed = true;
    changes++;
    if (append || exhausted) fs.appendFileSync(file, '\n');
    else {
      const fd = open(file, 'r+');
      fs.writeSync(fd, Buffer.from('x'), 0, 1, 0);
      close(fd);
    }
    fs.utimesSync(file, 1_000_000_000 + changes, 1_000_000_000 + changes);
    const after = fs.statSync(file, { bigint: true });
    assert.equal(after.ino, before.ino);
    assert.equal(after.size, before.size + (append || exhausted ? BigInt(changes) : 0n));
    assert.notEqual(after.mtimeNs, before.mtimeNs);
  };
  const opened = vi.spyOn(fs, 'openSync').mockImplementation((target, ...rest) => {
    const fd = Reflect.apply(open, fs, [target, ...rest]);
    if (String(target) === file) nativeDescriptors.add(fd);
    return fd;
  });
  const closed = vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
    const native = nativeDescriptors.delete(fd);
    close(fd);
    if (native && state === 'recovered final rewrite' && nativeBytes >= Buffer.byteLength(original)) change();
    if (native && state === 'recovered final append' && nativeBytes >= Buffer.byteLength(original)) change();
    if (
      native &&
      state === 'recovered final deadline exhaustion' &&
      nativeBytes >= Buffer.byteLength(original) &&
      expiredAtBytes === null
    ) {
      clock += options.deadlineMs;
      expiredAtBytes = nativeBytes;
    }
  });
  const reads = vi.spyOn(fs, 'readSync').mockImplementation((...values) => {
    const request: readonly unknown[] = values;
    const native = nativeDescriptors.has(values[0]);
    if (native) {
      if (expiredAtBytes !== null) lateReads++;
      nativeReads.push(Number(request[3]));
      if (state === 'recovered zero progress') return 0;
    }
    const count = Reflect.apply(read, fs, values);
    if (native) {
      nativeBytes += count;
      if (state === 'recovered unqualified exhaustion') change();
      if ((state.includes('cumulative') || state.includes('unqualified')) && nativeBytes > bounds.workBytes)
        clock += options.deadlineMs;
    }
    return count;
  });
  duringYield = () => {
    if (!nativeReads.length) return;
    yields++;
    if (state === 'recovered deadline exhaustion' && changes) {
      clock += options.deadlineMs;
      expiredAtBytes = nativeBytes;
    } else if (
      [
        'initial rewrite',
        'initial append',
        'recovered rewrite',
        'recovered append',
        'recovered cumulative exhaustion',
        'recovered deadline exhaustion',
      ].includes(state)
    )
      change();
  };
  let recoveries = 0;
  const recover = () => {
    recoveries++;
    return superviseStandalone(new DispatchReceipts(home), launch.launchId, true, bounds, runtime);
  };
  try {
    const output =
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        session_id: options.sessionHint,
        result: 'Report',
        is_error: false,
      }) + '\n';
    if (initial) fs.writeSync(stdout, output);
    else fs.appendFileSync(receipts.artifact(launch.launchId, 'stdout.log'), output);
    child.emit('close', 0, null);
    let recoveryError: unknown;
    if (initial) await supervised;
    else
      await recover().catch((error) => {
        recoveryError = error;
      });
    if (!held.length && !['recovered zero progress', 'recovered final deadline exhaustion'].includes(state))
      assert.equal(changed, true);
    const refused = receipts.latest(launch.launchId)!;
    assert.equal(recoveries, initial ? 0 : 1);
    assert.equal(vi.mocked(childProcess.spawn).mock.calls.length, 1);
    if (append) {
      assert.equal(refused.availability, 'available');
      assert.equal((receipts.result(launch.launchId, refused.eventId) as any).text, 'Report');
      assert.equal(receipts.startupRefused(launch.launchId), false);
      assert.ok(nativeBytes > Buffer.byteLength(original));
      assert.ok(yields > 0);
      return;
    }
    if (pending) assert.deepEqual(refused, pending);
    assert.equal(refused.availability, 'pending');
    assert.equal(refused.report, null);
    assert.equal(receipts.status(launch.launchId).reportSource, null);
    assert.ok(receipts.status(launch.launchId).events.every((event) => event.report === null));
    assert.equal((receipts.result(launch.launchId, refused.eventId) as any).text, null);
    assert.equal(recoveryError, undefined);
    if (exhausted || state === 'recovered zero progress') {
      assert.equal(receipts.startupRefused(launch.launchId), false);
      if (state.includes('cumulative') || state.includes('unqualified')) {
        assert.equal(nativeBytes, bounds.workBytes);
        assert.equal(
          nativeReads.reduce((sum, bytes) => sum + bytes, 0),
          bounds.workBytes,
        );
        assert.ok(changes > 1);
      } else if (state.includes('deadline')) {
        assert.equal(expiredAtBytes, nativeBytes);
        assert.equal(nativeBytes, state.includes('final') ? Buffer.byteLength(original) : 256);
        assert.equal(lateReads, 0);
      } else assert.equal(nativeReads.length, 1);
      return;
    }
    if (!held.length) assert.equal(receipts.startupRefused(launch.launchId), true);
    if (state === 'all acceptance unavailable') {
      for (const target of [
        path.join(receipts.root, `${launch.launchId}.accepted.json`),
        path.join(receipts.root, `${launch.launchId}.accepting.json`),
      ]) {
        fs.renameSync(target, target + '.held');
        try {
          assert.throws(() => receipts.startup(launch.launchId));
        } finally {
          fs.renameSync(target + '.held', target);
        }
      }
    }
    opened.mockRestore();
    closed.mockRestore();
    reads.mockRestore();
    duringYield = () => {};
    if (held.length) {
      for (const target of held) fs.renameSync(target + '.held', target);
      await recover();
      const recovered = receipts.latest(launch.launchId)!;
      assert.equal(recovered.availability, 'available');
      assert.equal((receipts.result(launch.launchId, recovered.eventId) as any).text, 'Report');
      await recover();
      assert.equal(receipts.latest(launch.launchId)?.eventId, recovered.eventId);
    } else {
      fs.writeFileSync(file, original);
      fs.utimesSync(file, 1_000_000_002, 1_000_000_002);
      await recover();
      assert.deepEqual(receipts.latest(launch.launchId), refused);
    }
    assert.equal(vi.mocked(childProcess.spawn).mock.calls.length, 1);
  } finally {
    child.emit('close', 0, null);
    await supervised;
  }
});

test('standalone manual wait observes retained events and controlled deadlines without starting a worker', async () => {
  vi.useFakeTimers();
  const { receipts, options } = receiptsFixture();
  const launch = receipts.reserve({
    origin: 'e'.repeat(24),
    requester: null,
    policy: null,
    completion: 'manual',
    promptSha256: payloadSha256('Review this folder.'),
    alias: null,
    transport: 'standalone',
    standalone: options,
  });
  const expired = waitStandalone(receipts, launch.launchId, 25);
  void expired.catch(() => {});
  await vi.advanceTimersByTimeAsync(25);
  assert.deepEqual(await expired, { launchId: launch.launchId, state: 'deadline' });
  const pending = waitStandalone(receipts, launch.launchId, 1000);
  const event = receipts.publish(
    launch.launchId,
    { outcome: 'succeeded', availability: 'available', nativeEnding: null, askId: null },
    'Original report',
  );
  await vi.advanceTimersByTimeAsync(100);
  assert.deepEqual(await pending, {
    launchId: launch.launchId,
    state: 'observed',
    eventId: event.eventId,
    outcome: 'succeeded',
    availability: 'available',
  });
  assert.equal(vi.mocked(childProcess.spawn).mock.calls.length, 0);
});

test('delayed native identity is admitted once without accepting report text or restarting a worker', async () => {
  vi.useFakeTimers();
  const { receipts, launch, options } = receiptsFixture();
  const fileOutput = receipts.artifact(launch.launchId, 'stdout.log');
  fs.writeFileSync(fileOutput, '');
  const descriptor = fs.openSync(fileOutput, 'a+');
  const child = new ChildProcess();
  const observed = observeProcess(
    child,
    options,
    (id) => {
      receipts.standaloneSession(launch.launchId, id);
    },
    descriptor,
    descriptor,
    function* (cursor) {
      const bytes = fs.readFileSync(fileOutput);
      yield bytes.subarray(cursor?.offset ?? 0);
      if (cursor) cursor.offset = bytes.length;
    },
    undefined,
    { now: Date.now, identity: standaloneProcessIdentity, yield: () => Promise.resolve() },
  );
  const pending = waitStandaloneIdentity(receipts, launch.launchId, 1000);
  await vi.advanceTimersByTimeAsync(100);
  assert.equal(receipts.standaloneSession(launch.launchId), null);
  fs.writeFileSync(
    receipts.artifact(launch.launchId, 'stdout.log'),
    JSON.stringify({ type: 'thread.started', thread_id: session }) + '\n',
  );
  await vi.advanceTimersByTimeAsync(100);
  assert.equal(await pending, session);
  child.emit('close', 0, null);
  await observed;
  fs.closeSync(descriptor);
  assert.equal(receipts.standaloneSession(launch.launchId), session);
  assert.throws(
    () => receipts.standaloneSession(launch.launchId, 'bbbbbbbb-1111-2222-3333-444444444444'),
    /cannot change/,
  );
  assert.equal(vi.mocked(childProcess.spawn).mock.calls.length, 0);
  const file = path.join(receipts.root, launch.launchId, 'accepted.json');
  const bytes = fs.readFileSync(file);
  fs.renameSync(file, file + '.original');
  fs.writeFileSync(file, bytes);
  assert.throws(() => receipts.standaloneSession(launch.launchId), /cannot change|replaced/);
});

test('replaced provider output supplies no native launch identity', async () => {
  const { receipts, launch } = receiptsFixture();
  const child = new ChildProcess();
  child.stdin = new PassThrough();
  vi.mocked(childProcess.spawn).mockImplementationOnce(() => {
    const file = receipts.artifact(launch.launchId, 'stdout.log');
    fs.renameSync(file, file + '.original');
    fs.writeFileSync(file, outputFrames());
    fs.writeFileSync(receipts.artifact(launch.launchId, 'native.md'), 'Report');
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  });
  await superviseStandalone(receipts, launch.launchId, false, undefined, {
    now: Date.now,
    identity: async () => null,
    yield: () => Promise.resolve(),
  });
  assert.equal(receipts.standaloneSession(launch.launchId), null);
  assert.equal(receipts.latest(launch.launchId)?.outcome, 'unknown');
});

test('missing, conflicting and worker-produced identities publish no native receipt', async () => {
  vi.useFakeTimers();
  for (const output of [
    '',
    'ARC_DISPATCH_SESSION={"agent":"codex","session_id":"' + session + '"}\n',
    JSON.stringify({ type: 'thread.started', thread_id: session }) +
      '\n' +
      JSON.stringify({ type: 'thread.started', thread_id: 'bbbbbbbb-1111-2222-3333-444444444444' }) +
      '\n',
  ]) {
    const { receipts, launch, options } = receiptsFixture();
    fs.writeFileSync(receipts.artifact(launch.launchId, 'stdout.log'), output);
    const descriptor = fs.openSync(receipts.artifact(launch.launchId, 'stderr.log'), 'a');
    const child = new ChildProcess();
    const observed = observeProcess(
      child,
      options,
      (id) => {
        receipts.standaloneSession(launch.launchId, id);
      },
      descriptor,
      descriptor,
      function* () {
        yield Buffer.from(output);
      },
      undefined,
      { now: Date.now, identity: standaloneProcessIdentity, yield: () => Promise.resolve() },
    );
    const pending = waitStandaloneIdentity(receipts, launch.launchId, 100);
    await vi.advanceTimersByTimeAsync(100);
    child.emit('close', 0, null);
    await observed;
    fs.closeSync(descriptor);
    assert.equal(await pending, null);
    assert.equal(receipts.standaloneSession(launch.launchId), null);
  }
  assert.equal(vi.mocked(childProcess.spawn).mock.calls.length, 0);
});

test.each([
  ['codex', 'valid'],
  ['claude', 'valid'],
  ['codex', 'missing'],
  ['codex', 'empty'],
  ['codex', 'oversized'],
  ['codex', 'malformed'],
] as const)('explicit %s log is live before completion with %s final evidence', async (provider, nativeState) => {
  const { home, args } = fixture();
  const log = path.join(home, 'output.log');
  const parsed = parseRun([
    ...args.map((value, index) => (index === 1 ? provider : value)),
    '--read-only',
    '--log',
    log,
  ]);
  const receipts = new DispatchReceipts(home);
  const launch = receipts.reserve({
    origin: 'e'.repeat(24),
    requester: null,
    policy: parsed.policy,
    completion: 'manual',
    promptSha256: payloadSha256(parsed.prompt),
    alias: parsed.alias,
    transport: 'standalone',
    standalone: parsed.options,
  });
  receipts.input(launch.launchId, parsed.prompt);
  const child = new ChildProcess();
  child.stdin = new PassThrough();
  let descriptors: number[] = [];
  vi.mocked(childProcess.spawn).mockImplementationOnce((_command, _args, settings) => {
    descriptors = settings.stdio as number[];
    return child;
  });
  const pending = superviseStandalone(
    receipts,
    launch.launchId,
    false,
    { frameBytes: 1024, readBytes: 1024 },
    { now: Date.now, identity: async () => null, yield: async () => {} },
  );
  const opening = Buffer.from(
    provider === 'codex' ? JSON.stringify({ type: 'thread.started', thread_id: session }) + '\n' : '',
  );
  const diagnostic = Buffer.from([100, 105, 97, 103, 0, 255, 10]);
  try {
    fs.writeSync(descriptors[1], opening);
    fs.writeSync(descriptors[2], diagnostic);
    await vi.waitFor(() => assert.deepEqual(fs.readFileSync(log), Buffer.concat([opening, diagnostic])));
    assert.equal(receipts.latest(launch.launchId), null);
    const ending = Buffer.from(
      provider === 'codex'
        ? [
            { type: 'turn.started' },
            { type: 'item.completed', item: { type: 'agent_message', id: 'i', text: 'Report' } },
            { type: 'turn.completed' },
          ]
            .map((value) => JSON.stringify(value))
            .join('\n') + '\n'
        : JSON.stringify({
            type: 'result',
            subtype: 'success',
            session_id: parsed.options.sessionHint,
            result: 'Report',
            is_error: false,
          }) + '\n',
    );
    fs.writeSync(descriptors[1], ending);
    if (provider === 'codex' && nativeState !== 'missing')
      fs.writeFileSync(
        receipts.artifact(launch.launchId, 'native.md'),
        nativeState === 'empty' ? '' : nativeState === 'oversized' ? Buffer.alloc(8 * 1024 * 1024 + 1) : 'Report',
      );
    if (nativeState === 'malformed') fs.writeSync(descriptors[1], Buffer.from('malformed source\n'));
    child.emit('close', 0, null);
    await pending;
    assert.deepEqual(
      fs.readFileSync(receipts.artifact(launch.launchId, 'stdout.log')),
      Buffer.concat([opening, ending, ...(nativeState === 'malformed' ? [Buffer.from('malformed source\n')] : [])]),
    );
    assert.deepEqual(fs.readFileSync(receipts.artifact(launch.launchId, 'stderr.log')), diagnostic);
    const event = receipts.latest(launch.launchId)!;
    if (nativeState !== 'valid') {
      assert.equal(event.availability, nativeState === 'malformed' ? 'pending' : 'unavailable');
      assert.equal(event.report, null);
      assert.equal(fs.existsSync(path.join(home, 'output.last.md')), false);
      return;
    }
    assert.equal((receipts.result(launch.launchId, event.eventId) as any).text, 'Report');
    if (provider === 'codex') assert.equal(fs.readFileSync(path.join(home, 'output.last.md'), 'utf8'), 'Report');
  } finally {
    if (receipts.observation(launch.launchId)?.monitor === 'observing') child.emit('close', 1, null);
    await pending;
  }
});

test('an existing print output owner refuses another native producer', async () => {
  const { receipts, launch } = workerFixture('', 10_000, false, true);
  fs.writeFileSync(receipts.artifact(launch.launchId, 'output-owner.json'), '{}');
  const spawn = vi.mocked(childProcess.spawn);
  const child = new ChildProcess();
  child.stdin = new PassThrough();
  spawn.mockReturnValue(child);
  await assert.rejects(produceStandaloneOutput(receipts, launch.launchId), { code: 'EEXIST' });
  assert.equal(spawn.mock.calls.length, 0);
});

test('print capture retries the final alias failure without new output before finishing', async () => {
  vi.spyOn(process, 'send').mockImplementation(() => true);
  vi.spyOn(process, 'disconnect').mockImplementation(() => {});
  const { receipts, launch } = workerFixture('', 10_000, false, true);
  const stdout = receipts.artifact(launch.launchId, 'stdout.log');
  const stderr = receipts.artifact(launch.launchId, 'stderr.log');
  fs.writeFileSync(stdout, 'prefix');
  fs.writeFileSync(stderr, '');
  const child = new ChildProcess();
  child.stdin = new PassThrough();
  vi.mocked(childProcess.spawn).mockReturnValue(child);
  const alias = launch.standalone!.logAlias!;
  const open = fs.openSync;
  let failed = false;
  let blocked = false;
  const failure = vi.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
    if (String(file) === alias && blocked) {
      failed = true;
      throw Object.assign(new Error('Alias unavailable'), { code: 'EPERM' });
    }
    return Reflect.apply(open, fs, [file, ...args]);
  });
  const owner = () => JSON.parse(fs.readFileSync(receipts.artifact(launch.launchId, 'output-owner.json'), 'utf8'));
  const pending = produceStandaloneOutput(receipts, launch.launchId);
  try {
    await vi.waitFor(() => assert.equal(fs.readFileSync(alias, 'utf8'), 'prefix'));
    blocked = true;
    fs.appendFileSync(stdout, ' final');
    child.emit('close', 0, null);
    await vi.waitFor(() => assert.equal(failed, true));
    assert.notEqual(owner().state, 'finished');
    assert.equal(fs.readFileSync(alias, 'utf8'), 'prefix');
    blocked = false;
    await pending;
    assert.equal(fs.readFileSync(alias, 'utf8'), 'prefix final');
    assert.equal(owner().state, 'finished');
  } finally {
    blocked = false;
    child.emit('close', 0, null);
    await pending;
    failure.mockRestore();
  }
});

test.each([false, true])(
  'print log continues after observation without recovery, stderr ending %s',
  async (stderrEnding) => {
    const finalSignalName = 'late-final';
    const stdoutPrefix = JSON.stringify({ type: 'progress', text: 'x'.repeat(280_000) }) + '\n';
    const terminal = outputFrames();
    const diagnostic = Buffer.alloc(270_000, 255);
    const extra = `fs.writeSync(1,${JSON.stringify(stdoutPrefix)});fs.writeSync(2,Buffer.alloc(${diagnostic.length},255));
const lateFinish=()=>{if(!fs.existsSync(path.join(process.cwd(),'${finalSignalName}')))return;lateWatcher.close();fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],'Report');fs.writeSync(${stderrEnding ? 2 : 1},${JSON.stringify(terminal)});};
const lateWatcher=fs.watch(process.cwd(),lateFinish);lateFinish();return;`;
    const { receipts, launch, options, started, release } = workerFixture(extra, 10_000, false, true);
    const entry = path.join(options.cwd, 'output-entry.cjs');
    await build({
      stdin: {
        contents: `import {produceStandaloneOutput} from './cli/src/standalone.ts';import {DispatchReceipts} from './extension/src/dispatchreceipts.ts';produceStandaloneOutput(new DispatchReceipts(),process.argv[3]).catch(e=>{console.error(e);process.exitCode=1});`,
        resolveDir: path.resolve('..'),
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: entry,
      logLevel: 'silent',
    });
    const owner = () => JSON.parse(fs.readFileSync(receipts.artifact(launch.launchId, 'output-owner.json'), 'utf8'));
    const alias = launch.standalone!.logAlias!;
    const bounds = { frameBytes: 512_000, readBytes: 17, workBytes: 512 };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = superviseStandalone(receipts, launch.launchId, false, bounds, undefined, undefined, false, entry);
    let secondCapture: ReturnType<DispatchReceipts['capture']> | undefined;
    try {
      await vi.waitFor(() => assert.ok(fs.existsSync(started)), { timeout: 5000 });
      await vi.advanceTimersByTimeAsync(10_000);
      await pending;
      assert.equal(receipts.observation(launch.launchId)?.monitor, 'timed-out');
      const nativePid = Number(fs.readFileSync(started, 'utf8').trim());
      assert.equal(owner().producerPid, nativePid);
      assert.notEqual(owner().pid, nativePid);
      const observed = receipts.observation(launch.launchId)!;
      assert.equal((observed.worker ?? observed.launcher)?.pid, nativePid);
      let frozen: ReturnType<DispatchReceipts['publish']> | undefined;
      await vi.waitFor(() => {
        frozen ??= receipts.publish(
          launch.launchId,
          { outcome: 'unknown', availability: 'available', nativeEnding: null, askId: null },
          'Frozen report',
        );
      });
      fs.writeFileSync(release, 'emit late output');
      await vi.waitFor(
        () => assert.ok(fs.statSync(receipts.artifact(launch.launchId, 'stdout.log')).size > bounds.workBytes),
        { timeout: 5000 },
      );
      await superviseStandalone(receipts, launch.launchId, true, bounds, {
        now: () => 0,
        identity: async () => null,
        yield: () => Promise.resolve(),
      });
      await vi.waitFor(
        () => assert.equal(fs.statSync(alias).size, Buffer.byteLength(stdoutPrefix) + diagnostic.length),
        { timeout: 5000 },
      );
      const second = receipts.reserve({ ...launch, origin: 'f'.repeat(24) });
      secondCapture = receipts.capture(second.launchId);
      secondCapture.write(Buffer.from('Second launch'));
      assert.equal(owner().state, 'capturing');
      fs.writeFileSync(path.join(options.cwd, finalSignalName), 'finish native child');
      await vi.waitFor(() => assert.equal(owner().state, 'finished'), { timeout: 5000 });
      const stdout = fs.readFileSync(receipts.artifact(launch.launchId, 'stdout.log'));
      const stderr = fs.readFileSync(receipts.artifact(launch.launchId, 'stderr.log'));
      assert.deepEqual(stdout, Buffer.from(stdoutPrefix + (stderrEnding ? '' : terminal)));
      assert.deepEqual(stderr, Buffer.concat([diagnostic, ...(stderrEnding ? [Buffer.from(terminal)] : [])]));
      const captured = fs.readFileSync(receipts.artifact(launch.launchId, 'worker.log'));
      assert.equal(captured.length, stdout.length + stderr.length);
      if (!stderrEnding) {
        assert.deepEqual(Buffer.from([...captured].filter((byte) => byte !== 255)), stdout);
        assert.equal([...captured].filter((byte) => byte === 255).length, diagnostic.length);
      }
      assert.equal(fs.readFileSync(alias, 'utf8'), 'Second launch');
      assert.equal((receipts.result(launch.launchId, frozen!.eventId) as any).text, 'Frozen report');
      await superviseStandalone(
        receipts,
        launch.launchId,
        true,
        { ...bounds, readBytes: 64 * 1024, workBytes: 1024 * 1024 },
        {
          now: () => 0,
          identity: async () => null,
          yield: () => Promise.resolve(),
        },
      );
      const event = receipts.latest(launch.launchId)!;
      if (stderrEnding) assert.notEqual(event.report?.sha256, payloadSha256('Report'));
      else {
        assert.equal(event.availability, 'available');
        assert.equal((receipts.result(launch.launchId, event.eventId) as any).text, 'Report');
      }
      assert.equal(fs.readFileSync(alias, 'utf8'), 'Second launch');
    } finally {
      fs.writeFileSync(release, 'release owned child');
      fs.writeFileSync(path.join(options.cwd, finalSignalName), 'finish owned child');
      await pending.catch(() => {});
      await vi.waitFor(() => assert.ok(['finished', 'unavailable'].includes(owner().state)), { timeout: 5000 });
      await vi.waitFor(() => assert.throws(() => process.kill(owner().pid, 0), { code: 'ESRCH' }), { timeout: 5000 });
      await vi.waitFor(() => assert.throws(() => process.kill(owner().producerPid, 0), { code: 'ESRCH' }), {
        timeout: 5000,
      });
      secondCapture?.close();
    }
  },
);

test('reused explicit log and report aliases keep each launch capture and frozen report separate', async () => {
  const { home, args } = fixture();
  const log = path.join(home, 'reused.log');
  const parsed = parseRun([...args, '--log', log]);
  assert.ok(parsed.alias);
  const receipts = new DispatchReceipts(home);
  const reserve = () =>
    receipts.reserve({
      origin: 'f'.repeat(24),
      requester: null,
      policy: null,
      completion: 'manual',
      promptSha256: payloadSha256(parsed.prompt),
      alias: parsed.alias,
      transport: 'standalone',
      standalone: parsed.options,
    });
  const first = reserve();
  const capture1 = receipts.capture(first.launchId);
  const second = reserve();
  const capture2 = receipts.capture(second.launchId);
  try {
    capture1.write(Buffer.from('First raw'));
    capture2.write(Buffer.from('Second raw'));
    const event1 = receipts.publish(
      first.launchId,
      { outcome: 'succeeded', availability: 'available', nativeEnding: null, askId: null },
      'First report',
    );
    const event2 = receipts.publish(
      second.launchId,
      { outcome: 'succeeded', availability: 'available', nativeEnding: null, askId: null },
      'Second report',
    );
    capture1.write(Buffer.from(' late'));
    assert.equal(fs.readFileSync(log, 'utf8'), 'Second raw');
    assert.equal(fs.readFileSync(receipts.artifact(first.launchId, 'worker.log'), 'utf8'), 'First raw late');
    assert.equal(fs.readFileSync(parsed.alias, 'utf8'), 'Second report');
    fs.writeFileSync(log, 'Caller changed alias');
    fs.writeFileSync(parsed.alias, 'Caller changed report');
    assert.equal((receipts.result(first.launchId, event1.eventId) as any).text, 'First report');
    assert.equal((receipts.result(second.launchId, event2.eventId) as any).text, 'Second report');
    assert.throws(() => receipts.reserve({ ...first, alias: log }), /separate paths/);
  } finally {
    capture1.close();
    capture2.close();
  }
  fs.writeFileSync(log, 'Second raw');
  receipts.input(first.launchId, parsed.prompt);
  const output = Buffer.from(outputFrames());
  fs.writeFileSync(receipts.artifact(first.launchId, 'stdout.log'), output);
  fs.writeFileSync(receipts.artifact(first.launchId, 'stderr.log'), 'Recovered stderr');
  fs.writeFileSync(receipts.artifact(first.launchId, 'native.md'), 'Report');
  receipts.observation(first.launchId, {
    supervisor: { pid: process.pid, token: '1'.repeat(36) },
    worker: null,
    sessionId: session,
    exitCode: 0,
    signal: null,
    monitor: 'timed-out',
  });
  const privateBefore = fs.readFileSync(receipts.artifact(first.launchId, 'worker.log'));
  const aliasBefore = fs.readFileSync(log);
  const secondBefore = fs.readFileSync(receipts.artifact(second.launchId, 'worker.log'));
  const spawns = vi.mocked(childProcess.spawn).mock.calls.length;
  let now = 0;
  await superviseStandalone(
    receipts,
    first.launchId,
    true,
    { frameBytes: 1024, readBytes: 17, workBytes: 64 },
    {
      now: () => now,
      identity: async () => null,
      yield: async () => {
        if (receipts.scan(first.launchId)) now += first.standalone!.deadlineMs;
      },
    },
  );
  assert.deepEqual(
    fs.readFileSync(receipts.artifact(first.launchId, 'worker.log')),
    Buffer.concat([privateBefore, output.subarray(0, 64), Buffer.from('Recovered stderr')]),
  );
  assert.deepEqual(fs.readFileSync(log), aliasBefore);
  assert.deepEqual(fs.readFileSync(receipts.artifact(second.launchId, 'worker.log')), secondBefore);
  assert.equal(vi.mocked(childProcess.spawn).mock.calls.length, spawns);
  fs.appendFileSync(receipts.artifact(second.launchId, 'worker.log'), 'Uncommitted suffix');
  fs.appendFileSync(log, 'Uncommitted suffix');
  const resumed = receipts.capture(second.launchId);
  resumed.close();
  assert.deepEqual(fs.readFileSync(receipts.artifact(second.launchId, 'worker.log')), secondBefore);
  assert.deepEqual(fs.readFileSync(log), aliasBefore);
});

test('background log continues after observation and recovers without taking a reused alias', async () => {
  const { receipts, launch, options, script, calls } = backgroundFixture(true);
  const registry = path.join(options.cwd, 'registry.json');
  const native = path.join(options.cwd, 'native-output');
  const registryEntry = { id: 'deadbeef', sessionId: session, state: 'working', pid: process.pid };
  fs.writeFileSync(registry, JSON.stringify([registryEntry]));
  const first = Buffer.concat([Buffer.from('Native prefix\n'), Buffer.alloc(270_000, 255)]);
  fs.writeFileSync(native, first);
  fs.writeFileSync(
    script,
    `const fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({args})+'\\n');if(args.includes('--bg')){process.stdin.resume();process.stdin.on('end',()=>console.log('backgrounded · deadbeef · ${options.name}'));}else if(args[0]==='agents')process.stdout.write(fs.readFileSync(${JSON.stringify(registry)}));else if(args[0]==='logs'){if(args[1]!=='deadbeef')process.exitCode=1;else fs.writeSync(1,fs.readFileSync(${JSON.stringify(native)}));}`,
  );
  const entry = path.join(options.cwd, 'output-entry.cjs');
  await build({
    stdin: {
      contents: `import {produceStandaloneOutput} from './cli/src/standalone.ts';import {DispatchReceipts} from './extension/src/dispatchreceipts.ts';produceStandaloneOutput(new DispatchReceipts(),process.argv[3]).catch(e=>{console.error(e);process.exitCode=1});`,
      resolveDir: path.resolve('..'),
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: entry,
    logLevel: 'silent',
  });
  const owner = () => JSON.parse(fs.readFileSync(receipts.artifact(launch.launchId, 'output-owner.json'), 'utf8'));
  const capturedNative = receipts.artifact(launch.launchId, 'native.log');
  const bounds = { frameBytes: 512_000, readBytes: 17, workBytes: 512 };
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let now = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const pending = superviseStandalone(receipts, launch.launchId, false, bounds, undefined, undefined, false, entry);
  const pids = new Set<number>();
  let secondCapture: ReturnType<DispatchReceipts['capture']> | undefined;
  try {
    await vi.waitFor(() => assert.ok(fs.readFileSync(options.logAlias!).equals(first)), { timeout: 5000 });
    pids.add(owner().pid);
    now = options.deadlineMs;
    await vi.advanceTimersByTimeAsync(options.deadlineMs);
    await pending;
    assert.equal(receipts.observation(launch.launchId)?.monitor, 'timed-out');
    assert.equal(receipts.observation(launch.launchId)?.exitCode, null);
    assert.equal(receipts.observation(launch.launchId)?.worker, null);
    assert.equal(owner().backgroundId, 'deadbeef');
    assert.equal(owner().state, 'capturing');
    const frozen = receipts.publish(
      launch.launchId,
      { outcome: 'unknown', availability: 'available', nativeEnding: null, askId: null },
      'Frozen response',
    );
    fs.writeFileSync(registry, '[]');
    const late = Buffer.concat([Buffer.from('Late bytes\n'), Buffer.alloc(280_000, 254)]);
    fs.appendFileSync(native, late);
    const combined = Buffer.concat([first, late]);
    await vi.waitFor(() => assert.ok(fs.readFileSync(options.logAlias!).equals(combined)), { timeout: 8000 });
    assert.equal(owner().state, 'capturing');
    await superviseStandalone(receipts, launch.launchId, true, bounds, undefined, undefined, false, entry);
    const spawned = vi.mocked(childProcess.spawn);
    const duplicateIndex = spawned.mock.calls.map((args) => args[1]?.[0] === entry).lastIndexOf(true);
    const duplicate = spawned.mock.results[duplicateIndex].value as ChildProcess;
    await vi.waitFor(() => assert.ok(duplicate.exitCode !== null || duplicate.signalCode !== null), { timeout: 5000 });
    assert.equal(owner().pid, [...pids][0]);
    const second = receipts.reserve({ ...launch, origin: 'e'.repeat(24) });
    secondCapture = receipts.capture(second.launchId);
    secondCapture.native(Buffer.from('Second launch'));
    assert.equal(fs.readFileSync(options.logAlias!, 'utf8'), 'Second launch');
    fs.renameSync(capturedNative, capturedNative + '.saved');
    fs.mkdirSync(capturedNative);
    fs.appendFileSync(native, 'Survives capture failure\n');
    await vi.waitFor(() => assert.equal(owner().state, 'unavailable'), { timeout: 8000 });
    await vi.waitFor(() => assert.throws(() => process.kill(owner().pid, 0), { code: 'ESRCH' }), { timeout: 5000 });
    assert.deepEqual(fs.readFileSync(native), Buffer.concat([combined, Buffer.from('Survives capture failure\n')]));
    fs.rmdirSync(capturedNative);
    fs.renameSync(capturedNative + '.saved', capturedNative);
    fs.writeFileSync(registry, JSON.stringify([{ ...registryEntry, state: 'stopped' }]));
    await superviseStandalone(receipts, launch.launchId, true, bounds, undefined, undefined, false, entry);
    await vi.waitFor(
      () => {
        assert.notEqual(owner().pid, [...pids][0]);
        pids.add(owner().pid);
        assert.equal(owner().state, 'finished');
      },
      { timeout: 8000 },
    );
    assert.deepEqual(fs.readFileSync(capturedNative), fs.readFileSync(native));
    assert.equal(fs.readFileSync(options.logAlias!, 'utf8'), 'Second launch');
    assert.equal((receipts.result(launch.launchId, frozen.eventId) as any).text, 'Frozen response');
    const position = JSON.parse(fs.readFileSync(receipts.artifact(launch.launchId, 'capture.json'), 'utf8'));
    assert.equal(position.sources['native-source.log'].offset, fs.statSync(native).size);
    const invoked = fs
      .readFileSync(calls, 'utf8')
      .trim()
      .split('\n')
      .map((row) => JSON.parse(row));
    assert.equal(invoked.filter((row) => row.args.includes('--bg')).length, 1);
    assert.ok(invoked.filter((row) => row.args[0] === 'logs').every((row) => row.args[1] === 'deadbeef'));
    assert.equal(receipts.latest(launch.launchId)?.eventId, frozen.eventId);
  } finally {
    fs.writeFileSync(registry, JSON.stringify([{ ...registryEntry, state: 'stopped' }]));
    if (fs.existsSync(capturedNative) && fs.statSync(capturedNative).isDirectory()) {
      fs.rmdirSync(capturedNative);
      fs.renameSync(capturedNative + '.saved', capturedNative);
    }
    now += options.deadlineMs;
    await vi.advanceTimersByTimeAsync(options.deadlineMs);
    await pending.catch(() => {});
    if (fs.existsSync(receipts.artifact(launch.launchId, 'output-owner.json'))) pids.add(owner().pid);
    for (const pid of pids)
      await vi.waitFor(() => assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }), { timeout: 8000 });
    for (const [index, args] of vi.mocked(childProcess.spawn).mock.calls.entries()) {
      if (args[1]?.[0] !== entry) continue;
      const child = vi.mocked(childProcess.spawn).mock.results[index].value as ChildProcess;
      await vi.waitFor(() => assert.ok(child.exitCode !== null || child.signalCode !== null), { timeout: 8000 });
    }
    secondCapture?.close();
  }
}, 35_000);

test.each(['done', 'missing'] as const)(
  'background log producer drains final bytes and handles %s without changing results',
  async (ending) => {
    const { receipts, launch, options, script } = backgroundFixture(true);
    const row = { id: 'deadbeef', sessionId: session, state: 'working' };
    let rows = [row];
    const stdout = Buffer.from('Launcher stdout\n');
    const stderr = Buffer.from([100, 105, 97, 103, 0, 255, 10]);
    fs.writeFileSync(receipts.artifact(launch.launchId, 'stdout.log'), stdout);
    fs.writeFileSync(receipts.artifact(launch.launchId, 'stderr.log'), stderr);
    receipts.background(launch.launchId, 'deadbeef');
    receipts.observation(launch.launchId, {
      supervisor: { pid: process.pid, token: 'retained' },
      worker: null,
      sessionId: session,
      exitCode: null,
      signal: null,
      monitor: 'timed-out',
    });
    const observation = receipts.observation(launch.launchId);
    const frozen = receipts.publish(
      launch.launchId,
      { outcome: 'unknown', availability: 'available', nativeEnding: null, askId: null },
      'Frozen response',
    );
    const first = Buffer.concat([Buffer.from('Native prefix\n'), Buffer.alloc(270_000, 255)]);
    const final = Buffer.concat([first, Buffer.from('Final bytes\n'), Buffer.alloc(280_000, 254)]);
    const snapshots: string[] = [];
    const logArgs: string[][] = [];
    const registry = vi.mocked(promisify(childProcess.execFile));
    registry.mockImplementation((_command, args) => {
      assert.ok(registry.mock.calls.length <= 6, 'Registry invocation bound exceeded.');
      assert.deepEqual(args, [script, 'agents', '--json']);
      const snapshot = JSON.stringify(rows);
      snapshots.push(snapshot);
      return Object.assign(Promise.resolve({ stdout: snapshot, stderr: '' }), { child: new ChildProcess() });
    });
    const owner = () => JSON.parse(fs.readFileSync(receipts.artifact(launch.launchId, 'output-owner.json'), 'utf8'));
    vi.mocked(childProcess.spawn).mockImplementation((_command, args, settings) => {
      assert.ok(vi.mocked(childProcess.spawn).mock.calls.length <= 6, 'Log invocation bound exceeded.');
      logArgs.push([...(args as string[])].slice(1));
      assert.equal(owner().state, 'capturing');
      fs.writeSync((settings!.stdio as number[])[1], snapshots.length === 1 ? first : final);
      const child = new ChildProcess();
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let finished = false;
    const pending = produceStandaloneOutput(receipts, launch.launchId).then(() => {
      finished = true;
    });
    try {
      await vi.waitFor(() => assert.equal(fs.readFileSync(options.logAlias!).equals(first), true));
      assert.equal(owner().state, 'capturing');
      rows = ending === 'done' ? [{ ...row, state: 'done' }] : [];
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => assert.equal(fs.readFileSync(options.logAlias!).equals(final), true));
      if (ending === 'done') {
        assert.equal(owner().state, 'finished', 'Capture must finish after the done snapshot and final drain.');
        await pending;
        assert.equal(snapshots.length, 2);
        assert.equal(JSON.parse(snapshots[1])[0].state, 'done');
      } else {
        assert.equal(owner().state, 'capturing', 'Missing registry rows must retain capture.');
        for (let iteration = 0; iteration < 2; iteration++) {
          await vi.advanceTimersByTimeAsync(2_000);
          await vi.waitFor(() => assert.equal(snapshots.length, iteration + 3));
          assert.equal(owner().state, 'capturing', 'Missing registry rows must retain capture.');
          assert.equal(finished, false);
        }
        assert.ok(snapshots.slice(1).every((snapshot) => snapshot === '[]'));
      }
      assert.ok(logArgs.every((args) => JSON.stringify(args) === JSON.stringify(['logs', 'deadbeef'])));
      assert.equal(fs.readFileSync(receipts.artifact(launch.launchId, 'native.log')).equals(final), true);
      assert.equal(fs.readFileSync(receipts.artifact(launch.launchId, 'native-source.log')).equals(final), true);
      assert.equal(
        fs.readFileSync(receipts.artifact(launch.launchId, 'worker.log')).equals(Buffer.concat([stdout, stderr])),
        true,
      );
      assert.equal(fs.readFileSync(receipts.artifact(launch.launchId, 'stdout.log')).equals(stdout), true);
      assert.equal(fs.readFileSync(receipts.artifact(launch.launchId, 'stderr.log')).equals(stderr), true);
      assert.deepEqual(receipts.observation(launch.launchId), observation);
      assert.equal(receipts.observation(launch.launchId)?.exitCode, null);
      assert.equal(receipts.latest(launch.launchId)?.eventId, frozen.eventId);
      assert.equal(receipts.latest(launch.launchId)?.outcome, 'unknown');
      assert.equal((receipts.result(launch.launchId, frozen.eventId) as any).text, 'Frozen response');
    } finally {
      rows = [{ ...row, state: 'stopped' }];
      for (let iteration = 0; iteration < 6; iteration++) {
        if (finished) break;
        await vi.advanceTimersByTimeAsync(2_000);
        await vi.waitFor(() => assert.ok(finished || snapshots.length > iteration));
      }
      assert.equal(finished, true, 'Producer cleanup exceeded six clock advances.');
      await pending;
    }
  },
);

test('explicit writable Claude log retains native bytes through the exact accepted background ID', async () => {
  const { receipts, launch, options, calls } = backgroundFixture(true);
  await superviseStandalone(receipts, launch.launchId, false);
  const native = Buffer.from([110, 97, 116, 105, 118, 101, 0, 255]);
  assert.deepEqual(fs.readFileSync(options.logAlias!), native);
  assert.deepEqual(fs.readFileSync(receipts.artifact(launch.launchId, 'native.log')), native);
  assert.match(fs.readFileSync(receipts.artifact(launch.launchId, 'stdout.log'), 'utf8'), /backgrounded/);
  const invoked = fs
    .readFileSync(calls, 'utf8')
    .trim()
    .split('\n')
    .map((row) => JSON.parse(row));
  assert.deepEqual(invoked.find((row) => row.args[0] === 'logs').args, ['logs', 'deadbeef']);
  assert.equal(receipts.observation(launch.launchId)?.exitCode, null);
  assert.equal(receipts.latest(launch.launchId)?.availability, 'pending');
});
