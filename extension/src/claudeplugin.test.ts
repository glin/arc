import { createHash } from 'node:crypto';
import { BundledTools, resolveToolRuntime, type ToolPackage } from './bundledtools';
import { acquireToolLock } from './toolownership';
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import fsBuiltin from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import childProcessBuiltin from 'node:child_process';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import * as vm from 'node:vm';
import { transformSync } from 'esbuild';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { tempDir } from './temproot';
import {
  ClaudePluginSetup,
  ClaudePluginOffer,
  acquirePluginLock,
  canonicalPluginPath,
  listedPlugin,
  pluginTarget,
  pluginRunner,
  PluginProcessError,
  PLUGIN_OUTPUT_BYTES,
  PLUGIN_READ_MS,
  PLUGIN_WRITE_MS,
  type PluginCommand,
  type PluginRunner,
  type PluginTarget,
  type PluginReadJson,
} from './claudeplugin';

function fixture() {
  const root = tempDir('claude-plugin-');
  const cwd = path.join(root, 'project');
  const home = path.join(root, 'config');
  const plugin = path.join(root, 'plugin');
  for (const folder of [cwd, home, plugin]) fs.mkdirSync(folder);
  const target = pluginTarget(
    cwd,
    home,
    { command: 'fixture-claude', leadingArgs: ['entry.js'], env: { FIXTURE: 'owned' }, problem: null },
    'fixture-host',
  );
  // Fixture reads expose only files under this fixture's root.
  for (const key of Object.keys(target.env))
    if (key.toUpperCase() === 'CLAUDE_CODE_PLUGIN_CACHE_DIR') delete target.env[key];
  const reads: string[] = [];
  const read: PluginReadJson = (file) => {
    const relative = path.relative(root, file);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return undefined;
    reads.push(file);
    try {
      const bytes = fs.readFileSync(file);
      if (bytes.length > PLUGIN_OUTPUT_BYTES) throw new Error('Fixture settings exceed the read budget.');
      return JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  };
  const entry = { id: 'arc-hooks@arc', scope: 'user', version: '1.0.0', enabled: true, installPath: plugin };
  let entries: unknown = [];
  let markets: unknown = [{ name: 'arc', source: 'github', repo: 'glin/arc' }];
  let version = '2.1.268 (Claude Code)';
  let node = 'v22.12.0';
  let nodeReads = 0;
  const commands: PluginCommand[] = [];
  let behavior: ((command: PluginCommand, signal: AbortSignal) => Promise<string | undefined>) | undefined;
  const run: PluginRunner = async (command, signal) => {
    commands.push(command);
    const custom = await behavior?.(command, signal);
    if (custom !== undefined) return { stdout: custom, stderr: '' };
    const args = command.args.slice(command.command === 'node' ? 0 : 1).join(' ');
    let stdout: string;
    if (command.command === 'node') {
      nodeReads++;
      stdout = node;
    } else if (args === '--version') stdout = version;
    else if (args === 'plugin list --json') stdout = JSON.stringify(entries);
    else if (args === 'plugin marketplace list --json') stdout = JSON.stringify(markets);
    else if (args.startsWith('plugin marketplace add ')) {
      markets = [{ name: 'arc', source: 'github', repo: 'glin/arc' }];
      stdout = 'Added';
    } else if (args === 'plugin install arc-hooks@arc --scope user --json') {
      entries = [entry];
      stdout =
        'progress\n' +
        JSON.stringify({ command: 'install', outcome: 'ok', pluginId: entry.id, scope: 'user', message: 'Installed' });
    } else throw new Error(`Unexpected fixture command ${args}`);
    return { stdout, stderr: '' };
  };
  const setup = new ClaudePluginSetup(run, undefined, read);
  const signal = new AbortController().signal;
  return {
    target,
    root,
    read,
    reads,
    entry,
    setup,
    commands,
    signal,
    run,
    entries: (value: unknown) => {
      entries = value;
    },
    markets: (value: unknown) => {
      markets = value;
    },
    version: (value: string) => {
      version = value;
    },
    node: (value: string) => {
      node = value;
    },
    nodeReads: () => nodeReads,
    behavior: (value: typeof behavior) => {
      behavior = value;
    },
    write: (file: string, value: unknown) => {
      const full = path.join(home, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, JSON.stringify(value));
    },
    mutations: () => commands.filter((command) => command.mutation),
  };
}

test('a frozen setup target carries its own launch, environment, host and configuration home', () => {
  const f = fixture();
  assert.equal(f.target.env.CLAUDE_CONFIG_DIR, canonicalPluginPath(f.target.home));
  assert.equal(f.target.env.FIXTURE, 'owned');
  const another = pluginTarget(f.target.cwd, f.target.home, f.target.launch, 'another-host');
  assert.notEqual(another.dismissalKey, f.target.dismissalKey);
  const nextFolder = pluginTarget(path.dirname(f.target.cwd), f.target.home, f.target.launch, 'fixture-host');
  assert.notEqual(nextFolder.dismissalKey, f.target.dismissalKey);
  assert.equal(canonicalPluginPath(f.target.home, 'win32'), fs.realpathSync.native(f.target.home).toLowerCase());
  assert.equal(canonicalPluginPath(f.target.home, 'linux'), fs.realpathSync.native(f.target.home));
  assert.equal(canonicalPluginPath(f.target.home, 'darwin'), fs.realpathSync.native(f.target.home));
});

test('plugin detection accepts absence only with healthy installation data', async () => {
  const f = fixture();
  assert.equal((await f.setup.detect(f.target, f.signal)).state, 'missing');
  f.write('plugins/installed_plugins.json', { version: 2, plugins: {} });
  assert.equal((await f.setup.detect(f.target, f.signal)).state, 'missing');
  f.write('plugins/installed_plugins.json', {
    version: 2,
    plugins: { 'arc-hooks@arc': [{ scope: 'user', version: '1', installPath: f.entry.installPath }] },
  });
  assert.equal((await f.setup.detect(f.target, f.signal)).state, 'unknown');
  assert.equal(f.mutations().length, 0);
});

test('missing-plugin fixtures never read real ancestor configuration', async () => {
  const f = fixture();
  const open = fs.openSync;
  const reads: string[] = [];
  const owned = (file: string) => {
    const relative = path.relative(f.root, file);
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  const spy = vi.spyOn(fsBuiltin, 'openSync').mockImplementation((file, flags, mode) => {
    const name = String(file);
    reads.push(name);
    assert.ok(owned(name), `Configuration read escaped the fixture: ${name}`);
    return open(file, flags, mode);
  });
  syncBuiltinESMExports();
  try {
    assert.equal((await f.setup.detect(f.target, f.signal)).state, 'missing');
    assert.ok(reads.length > 0);
    assert.ok(f.reads.every(owned));
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
});

test.each(['malformed', 'healthy'])(
  'redirected plugin storage refuses default-registry absence (%s)',
  async (state) => {
    const f = fixture();
    const redirected = path.join(f.root, 'redirected-plugins');
    fs.mkdirSync(redirected);
    fs.writeFileSync(
      path.join(redirected, 'installed_plugins.json'),
      state === 'malformed' ? '{' : JSON.stringify({ version: 2, plugins: {} }),
    );
    f.target.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = redirected;
    assert.equal((await f.setup.detect(f.target, f.signal)).state, 'unknown');
    await assert.rejects(f.setup.install(f.target, f.signal), /redirected/);
    assert.equal(fs.existsSync(path.join(f.target.home, '.arc-snapshot-setup.lock')), false);
    f.write('plugins/installed_plugins.json', { version: 2, plugins: {} });
    assert.equal((await f.setup.detect(f.target, f.signal)).state, 'unknown');
    const other = fixture();
    other.target.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = redirected;
    await assert.rejects(other.setup.install(other.target, other.signal), /redirected/);
    assert.equal(f.mutations().length + other.mutations().length, 0);
  },
);

test.each(['user', 'project', 'local'])(
  'settings-derived plugin storage prevents default-home ownership (%s)',
  async (scope) => {
    const f = fixture();
    const value = { env: { CLAUDE_CODE_PLUGIN_CACHE_DIR: path.join(f.root, 'redirected-plugins') } };
    if (scope === 'user') f.write('settings.json', value);
    else {
      fs.mkdirSync(path.join(f.target.cwd, '.claude'));
      fs.writeFileSync(
        path.join(f.target.cwd, '.claude', scope === 'local' ? 'settings.local.json' : 'settings.json'),
        JSON.stringify(value),
      );
    }
    assert.equal((await f.setup.detect(f.target, f.signal)).state, 'unknown');
    await assert.rejects(f.setup.install(f.target, f.signal), /settings change/);
    assert.equal(fs.existsSync(path.join(f.target.home, '.arc-snapshot-setup.lock')), false);
    assert.equal(f.mutations().length, 0);
  },
);

test.each([
  ['editor-node', 'without-node'],
  ['without-node', 'settings-node'],
])(
  'settings PATH differences refuse installation before the launch prerequisite check (%s, %s)',
  async (editorPath, hookPath) => {
    const f = fixture();
    f.target.env.PATH = editorPath;
    f.write('settings.json', { env: { PATH: hookPath } });
    f.behavior(async (command) => {
      if (command.command === 'node') {
        if (command.env.PATH === 'without-node') throw new Error('ENOENT');
        return 'v22.12.0';
      }
      return undefined;
    });
    assert.equal((await f.setup.detect(f.target, f.signal)).state, 'unknown');
    await assert.rejects(f.setup.install(f.target, f.signal), /settings change/);
    assert.equal(f.commands.filter((command) => command.command === 'node').length, 0);
    assert.equal(f.mutations().length, 0);
  },
);

test('a settings PATH change during installation preserves the plugin and refuses completion', async () => {
  const f = fixture();
  f.behavior(async (command) => {
    if (command.mutation) f.write('settings.json', { env: { PATH: 'without-node' } });
    return undefined;
  });
  await assert.rejects(f.setup.install(f.target, f.signal), /settings change/);
  f.write('settings.json', {});
  assert.equal((await f.setup.detect(f.target, f.signal)).state, 'enabled');
  assert.equal(f.mutations().length, 1);
});

test('extension setup targets the trusted new-session folder on the current host', () => {
  const source = fs.readFileSync(path.join(__dirname, 'extension.ts'), 'utf8');
  const begin =
    source.indexOf('snapshotOffer = new ClaudePluginOffer(') + 'snapshotOffer = new ClaudePluginOffer('.length;
  const end = source.indexOf('\n  snapshotSetup = snapshotOffer;', begin);
  const expression = source
    .slice(begin, end)
    .trim()
    .replace(/\);$/, '')
    .replace(/,\s*new ClaudePluginSetup[\s\S]*$/, '');
  const compiled = transformSync(`module.exports = (${expression})`, { loader: 'ts' }).code;
  const launched: string[] = [];
  const workspace = { isTrusted: false };
  const module = { exports: {} as { target(): unknown } };
  const context = {
    module,
    vscode: { workspace, env: { remoteName: undefined as string | undefined } },
    bundledTools: {},
    ClaudePluginSetup: function () {},
    process: { env: {} },
    MEASUREMENT_ENVIRONMENT: { blockAgents: 'BLOCK' },
    workspaceCwd: () => '/selected-new-session-folder',
    claudeLaunch: () => {
      launched.push('claude');
      return { problem: null };
    },
    readSetting: () => '',
    thisMachine: () => ({}),
    claudeConfigHome: () => '/host-config',
    pluginTarget: (...args: unknown[]) => args,
    os: { hostname: () => 'extension-host' },
  };
  vm.runInNewContext(compiled, context);
  assert.equal(module.exports.target(), null);
  assert.equal(launched.length, 0);
  workspace.isTrusted = true;
  assert.deepEqual(Array.from(module.exports.target() as unknown[]), [
    '/selected-new-session-folder',
    '/host-config',
    { problem: null },
    'local:extension-host',
  ]);
  context.vscode.env.remoteName = 'ssh-remote';
  assert.equal(module.exports.target(), null);
});

test.each(['{', JSON.stringify({ version: 1, plugins: {} }), ' '.repeat(PLUGIN_OUTPUT_BYTES + 1)])(
  'empty CLI lists preserve malformed or oversized registries',
  async (text) => {
    const f = fixture();
    fs.mkdirSync(path.join(f.target.home, 'plugins'));
    fs.writeFileSync(path.join(f.target.home, 'plugins', 'installed_plugins.json'), text);
    assert.equal((await f.setup.detect(f.target, f.signal)).state, 'unknown');
  },
);

test('an unreadable registry preserves unknown state', async () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.target.home, 'plugins', 'installed_plugins.json'), { recursive: true });
  assert.equal((await f.setup.detect(f.target, f.signal)).state, 'unknown');
});

test.each([false, true])('effective project enablement comes from the CLI result (%s)', async (enabled) => {
  const f = fixture();
  f.entries([{ ...f.entry, enabled, scope: 'project', projectPath: f.target.cwd }]);
  assert.equal((await f.setup.detect(f.target, f.signal)).state, enabled ? 'enabled' : 'disabled');
  f.markets([{ name: 'arc', source: 'directory', path: f.target.cwd }]);
  if (enabled) {
    await f.setup.install(f.target, f.signal);
    assert.equal(f.mutations().length, 0);
  } else {
    await assert.rejects(f.setup.install(f.target, f.signal), /disabled/);
    assert.equal(f.mutations().length, 0);
  }
});

test.each([
  (entry: Record<string, unknown>) => [entry, entry],
  (entry: Record<string, unknown>) => [
    entry,
    { ...entry, scope: 'local', projectPath: entry.installPath, enabled: false },
  ],
  (entry: Record<string, unknown>) => [{ ...entry, errors: ['load failure'] }],
  (entry: Record<string, unknown>) => [{ ...entry, enabled: 'yes' }],
  (entry: Record<string, unknown>) => [{ ...entry, scope: 'unexpected' }],
  (entry: Record<string, unknown>) => [{ ...entry, installPath: 'missing-folder' }],
])('ambiguous, invalid or broken installations never authorize installation', async (entries) => {
  const f = fixture();
  f.entries(entries({ ...f.entry, installPath: f.target.cwd }));
  // Give the local entry a project path that applies to the selected folder.
  const result = await f.setup.detect(f.target, f.signal);
  assert.equal(result.state, 'unknown');
  await assert.rejects(f.setup.install(f.target, f.signal));
  assert.equal(f.mutations().length, 0);
});

test("other projects do not become this folder's installation targets", async () => {
  const f = fixture();
  const other = path.join(path.dirname(f.target.cwd), 'other-project');
  fs.mkdirSync(other);
  f.entries([{ ...f.entry, scope: 'project', projectPath: other }]);
  assert.equal((await f.setup.detect(f.target, f.signal)).state, 'missing');
  f.entries([{ ...f.entry, scope: 'project' }]);
  assert.equal((await f.setup.detect(f.target, f.signal)).state, 'unknown');
});

test('deliberate disablement without installation is preserved', async () => {
  const f = fixture();
  f.write('settings.json', { enabledPlugins: { 'arc-hooks@arc': false } });
  assert.equal((await f.setup.detect(f.target, f.signal)).state, 'disabled');
  await assert.rejects(f.setup.install(f.target, f.signal), /disabled/);
  assert.equal(f.mutations().length, 0);
});

test('missing installation preserves ancestor disablement and user disablement beneath a local enablement', async () => {
  const f = fixture();
  const settings = path.join(path.dirname(f.target.cwd), '.claude');
  fs.mkdirSync(settings);
  fs.writeFileSync(
    path.join(settings, 'settings.json'),
    JSON.stringify({ enabledPlugins: { 'arc-hooks@arc': false } }),
  );
  assert.equal((await f.setup.detect(f.target, f.signal)).state, 'disabled');
  f.write('settings.json', { enabledPlugins: { 'arc-hooks@arc': false } });
  fs.mkdirSync(path.join(f.target.cwd, '.claude'));
  fs.writeFileSync(
    path.join(f.target.cwd, '.claude', 'settings.local.json'),
    JSON.stringify({ enabledPlugins: { 'arc-hooks@arc': true } }),
  );
  await assert.rejects(f.setup.install(f.target, f.signal), /disabled/);
  assert.equal(f.mutations().length, 0);
});

test('malformed settings prevent an automatic missing-plugin offer', async () => {
  const f = fixture();
  f.write('settings.json', { enabledPlugins: 'invalid' });
  assert.equal((await f.setup.detect(f.target, f.signal)).state, 'unknown');
});

test.each(['2.1.267 (Claude Code)', 'unknown', '2.0.999 (Claude Code)'])(
  'unsupported install JSON capability prevents all mutation (%s)',
  async (version) => {
    const f = fixture();
    f.version(version);
    f.markets([]);
    await assert.rejects(f.setup.install(f.target, f.signal), /2.1.268/);
    assert.equal(f.mutations().length, 0);
  },
);

test.each(['', 'node unavailable', 'v22.bad'])(
  'missing or unrecognized external Node prevents marketplace writes (%s)',
  async (version) => {
    const f = fixture();
    f.node(version);
    f.markets([]);
    await assert.rejects(f.setup.install(f.target, f.signal), /Node.js/);
    assert.equal(f.mutations().length, 0);
    assert.ok(f.commands.some((command) => command.command === 'node' && command.args.join(' ') === '--version'));
  },
);

test('a failing external Node executable blocks installation', async () => {
  const f = fixture();
  f.behavior(async (command) => {
    if (command.command === 'node') throw new Error('ENOENT');
    return undefined;
  });
  await assert.rejects(f.setup.install(f.target, f.signal), /Node.js/);
  assert.equal(f.mutations().length, 0);
});

test.each([
  { source: 'github', repo: 'someone/arc' },
  { source: 'git', url: 'https://github.com/glin/arc.git#other' },
  { source: 'url', url: 'https://github.com/glin/arc' },
  { source: 'directory', path: '.' },
])('another marketplace source stays unchanged (%s)', async (source) => {
  const f = fixture();
  f.markets([{ name: 'arc', ...source }]);
  await assert.rejects(f.setup.install(f.target, f.signal), /another source/);
  assert.equal(f.mutations().length, 0);
});

test.each([
  { source: 'github', repo: 'glin/arc' },
  { source: 'git', url: 'https://github.com/glin/arc.git' },
  { source: { source: 'github', repo: 'glin/arc' } },
])('the independently expected hosted source permits install (%s)', async (source) => {
  const f = fixture();
  Object.assign(f.target.env, {
    ELECTRON_RUN_AS_NODE: '1',
    NODE_OPTIONS: '--require editor-bootstrap.cjs',
    NODE_PATH: 'editor-modules',
  });
  const frozen = { ...f.target.env };
  f.markets([{ name: 'arc', ...source }]);
  assert.match(await f.setup.install(f.target, f.signal), /fresh Claude session/);
  assert.equal(f.mutations().length, 1);
  assert.equal(f.nodeReads(), 2);
  for (const command of f.commands) {
    assert.equal(command.cwd, f.target.cwd);
    assert.deepEqual(
      command.env,
      command.command === 'node'
        ? { ...frozen, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined, NODE_PATH: undefined }
        : frozen,
    );
    assert.equal(command.timeout, command.mutation ? PLUGIN_WRITE_MS : PLUGIN_READ_MS);
  }
  assert.deepEqual(f.target.env, frozen);
  await f.setup.install(f.target, f.signal);
  assert.equal(f.mutations().length, 1);
});

test('missing marketplace registration precedes installation and is checked again', async () => {
  const f = fixture();
  f.markets([]);
  await f.setup.install(f.target, f.signal);
  assert.deepEqual(
    f.mutations().map((command) => command.args.slice(1)),
    [
      ['plugin', 'marketplace', 'add', 'glin/arc'],
      ['plugin', 'install', 'arc-hooks@arc', '--scope', 'user', '--json'],
    ],
  );
});

test('fixture directory identity comes from an independent expected root', async () => {
  const f = fixture();
  f.markets([{ name: 'arc', source: 'directory', path: f.target.cwd }]);
  const setup = new ClaudePluginSetup(f.run, f.target.cwd, f.read);
  await setup.install(f.target, f.signal);
  const other = fixture();
  other.markets([{ name: 'arc', source: 'directory', path: f.target.cwd }]);
  await assert.rejects(
    new ClaudePluginSetup(other.run, other.target.cwd, other.read).install(other.target, other.signal),
    /another source/,
  );
  assert.equal(other.mutations().length, 0);
});

test('unpublished source output remains a retryable failure', async () => {
  const f = fixture();
  f.markets([]);
  f.behavior(async (command) => {
    if (command.mutation) throw new Error('Marketplace manifest not found at glin/arc');
    return undefined;
  });
  await assert.rejects(f.setup.install(f.target, f.signal), /manifest not found/);
  assert.equal(f.mutations().length, 1);
  assert.equal(fs.existsSync(path.join(f.target.home, '.arc-snapshot-setup.lock')), false);
});

test('lost external Node after installation preserves the plugin and refuses completion', async () => {
  const f = fixture();
  f.behavior(async (command) => {
    if (command.command === 'node' && f.nodeReads() > 0) throw new Error('ENOENT');
    return undefined;
  });
  await assert.rejects(f.setup.install(f.target, f.signal), /snapshot plugin is installed and enabled.*Node.js/);
  assert.equal((await f.setup.detect(f.target, f.signal)).state, 'enabled');
});

test('an install success message without effective enablement is not completion', async () => {
  const f = fixture();
  f.behavior(async (command) => (command.mutation ? JSON.stringify({ command: 'install', outcome: 'ok' }) : undefined));
  await assert.rejects(f.setup.install(f.target, f.signal), /not installed/);
});

test('exclusive configuration ownership refuses existing live, dead and malformed locks', () => {
  const f = fixture();
  const lock = acquirePluginLock(f.target.home);
  const owned = fs.readFileSync(lock.file, 'utf8');
  assert.equal(JSON.parse(owned).pid, process.pid);
  assert.ok(JSON.parse(owned).token);
  assert.throws(() => acquirePluginLock(f.target.home), /owns/);
  fs.writeFileSync(lock.file, JSON.stringify({ token: 'dead', pid: 2147483647 }));
  lock.release();
  assert.equal(fs.existsSync(lock.file), true);
  assert.throws(() => acquirePluginLock(f.target.home), /owns/);
  fs.writeFileSync(lock.file, '{');
  assert.throws(() => acquirePluginLock(f.target.home), /owns/);
});

test('concurrent windows cannot run two configuration mutations', async () => {
  const f = fixture();
  let finish: (() => void) | undefined;
  f.behavior(async (command) => {
    if (!command.mutation) return undefined;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return undefined;
  });
  const first = f.setup.install(f.target, f.signal);
  await vi.waitFor(() => assert.ok(finish));
  await assert.rejects(f.setup.install(f.target, f.signal), /owns/);
  finish!();
  await first;
  assert.equal(f.mutations().length, 1);
});

function offerFixture(f = fixture()) {
  let target: PluginTarget | null = f.target;
  let dismissed = false;
  let offers = 0;
  let answer: string | undefined = 'Not now';
  const reports: string[] = [];
  let respond: ((choice: string | undefined) => void) | undefined;
  const owner = new ClaudePluginOffer(
    {
      target: () => target,
      dismissed: () => dismissed,
      dismiss: async () => {
        dismissed = true;
      },
      offer: async () => {
        offers++;
        if (answer === 'pending')
          return new Promise((resolve) => {
            respond = resolve;
          });
        return answer;
      },
      report: (message) => {
        reports.push(message);
      },
    },
    f.setup,
  );
  return {
    f,
    owner,
    reports,
    offers: () => offers,
    answer: (value: string) => {
      answer = value;
    },
    target: (value: PluginTarget | null) => {
      target = value;
    },
    dismissed: () => dismissed,
    respond: (value: string) => respond?.(value),
  };
}

test('dismissal persists and explicit retry reopens the approved offer', async () => {
  const f = offerFixture();
  await f.owner.check();
  await f.owner.check();
  assert.equal(f.offers(), 1);
  assert.equal(f.dismissed(), true);
  f.answer('Install');
  await f.owner.check(true);
  assert.equal(f.offers(), 2);
  assert.equal(f.f.mutations().length, 1);
  assert.match(f.reports[0], /installed/);
});

test('saved dismissal survives a new activation without another offer', async () => {
  const f = fixture();
  const dismissed = new Set<string>();
  let offers = 0;
  const ports = {
    target: () => f.target,
    dismissed: (key: string) => dismissed.has(key),
    dismiss: async (key: string) => {
      dismissed.add(key);
    },
    offer: async () => {
      offers++;
      return 'Not now';
    },
    report: () => {},
  };
  await new ClaudePluginOffer(ports, f.setup).check();
  await new ClaudePluginOffer(ports, f.setup).check();
  assert.equal(offers, 1);
  assert.equal(f.commands.length, 1);
});

test('closing the notification does not repeat the offer in the same activation', async () => {
  const f = fixture();
  let offers = 0;
  const owner = new ClaudePluginOffer(
    {
      target: () => f.target,
      dismissed: () => false,
      dismiss: async () => {},
      offer: async () => {
        offers++;
        return undefined;
      },
      report: () => {},
    },
    f.setup,
  );
  await owner.check();
  owner.invalidate();
  await owner.check();
  assert.equal(offers, 1);
});

test('untrusted or unavailable targets run no CLI', async () => {
  const f = offerFixture();
  f.target(null);
  await f.owner.check();
  await f.owner.check(true);
  assert.equal(f.f.commands.length, 0);
  assert.equal(f.offers(), 0);
});

test('an installed or unknown plugin receives no automatic offer', async () => {
  const f = offerFixture();
  f.f.entries([f.f.entry]);
  await f.owner.check();
  assert.equal(f.offers(), 0);
  f.f.entries({ malformed: true });
  f.owner.invalidate();
  await f.owner.check();
  assert.equal(f.offers(), 0);
  await f.owner.check(true);
  assert.match(f.reports[0], /unreadable/);
});

test('stale notification clicks cannot install into the old folder', async () => {
  const f = offerFixture();
  f.answer('pending');
  const checking = f.owner.check();
  await vi.waitFor(() => assert.equal(f.offers(), 1));
  const next = fixture();
  f.target(next.target);
  f.owner.invalidate();
  await f.owner.check();
  f.respond('Install');
  await checking;
  assert.equal(f.f.mutations().length, 0);
  await vi.waitFor(() => assert.equal(f.offers(), 2));
  assert.equal(f.f.mutations().length, 0);
  f.respond('Install');
  await f.owner.check();
  assert.equal(f.f.mutations().length, 1);
  assert.equal(f.f.mutations()[0].cwd, next.target.cwd);
  assert.equal(f.f.mutations()[0].env.CLAUDE_CONFIG_DIR, next.target.home);
});

test('shutdown does not wait for an unanswered notification or accept its later click', async () => {
  const f = offerFixture();
  f.answer('pending');
  const checking = f.owner.check();
  await vi.waitFor(() => assert.equal(f.offers(), 1));
  await f.owner.dispose();
  await checking;
  f.respond('Install');
  assert.equal(f.f.mutations().length, 0);
});

test('coalesced detection caches one unchanged target', async () => {
  const f = offerFixture();
  f.f.entries([f.f.entry]);
  await Promise.all([f.owner.check(), f.owner.check(), f.owner.check()]);
  assert.equal(f.f.commands.length, 1);
});

class FakeChild extends EventEmitter {
  stdin = { end: vi.fn<() => void>(), destroy: vi.fn<() => void>() };
  stdout = Object.assign(new EventEmitter(), { destroy: vi.fn<() => void>() });
  stderr = Object.assign(new EventEmitter(), { destroy: vi.fn<() => void>() });
  kill = vi.fn<(signal: string) => void>();
  close(code = 0) {
    this.emit('exit', code);
    this.emit('close', code);
  }
}

test('ordinary local setup reaches installation through the production default construction', async () => {
  const f = fixture();
  f.markets([]);
  const open = fs.openSync;
  const reads: string[] = [];
  const filesystem = vi.spyOn(fsBuiltin, 'openSync').mockImplementation((file, flags, mode) => {
    const name = String(file);
    const relative = path.relative(f.root, name);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      assert.equal(flags, 'r');
      throw Object.assign(new Error('Fixture ancestor has no settings.'), { code: 'ENOENT' });
    }
    reads.push(name);
    return open(file, flags, mode);
  });
  const processes = vi.spyOn(childProcessBuiltin, 'spawn').mockImplementation((executable, args, options) => {
    const child = new FakeChild();
    child.stdin.end.mockImplementation(() => {
      void f
        .run(
          {
            command: executable,
            args: args as string[],
            cwd: options.cwd as string,
            env: options.env!,
            timeout: PLUGIN_READ_MS,
            mutation: (args as string[]).includes('install') || (args as string[]).includes('add'),
          },
          f.signal,
        )
        .then(
          ({ stdout, stderr }) => {
            child.stdout.emit('data', stdout);
            child.stderr.emit('data', stderr);
            child.close();
          },
          (error) => {
            child.stderr.emit('data', String(error));
            child.close(1);
          },
        );
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  });
  syncBuiltinESMExports();
  const reports: { message: string; error: boolean }[] = [];
  let offers = 0;
  const owner = new ClaudePluginOffer({
    target: () => f.target,
    dismissed: () => false,
    dismiss: async () => assert.fail('Installation must not dismiss the offer.'),
    offer: async () => {
      offers++;
      return 'Install';
    },
    report: (message, error) => reports.push({ message, error }),
  });
  try {
    await owner.check();
    assert.equal(offers, 1);
    assert.deepEqual(
      f.mutations().map((command) => command.args.slice(1)),
      [
        ['plugin', 'marketplace', 'add', 'glin/arc'],
        ['plugin', 'install', 'arc-hooks@arc', '--scope', 'user', '--json'],
      ],
    );
    assert.equal(f.nodeReads(), 2);
    assert.ok(reads.includes(path.join(f.target.home, 'plugins', 'installed_plugins.json')));
    assert.equal(fs.existsSync(path.join(f.target.home, '.arc-snapshot-setup.lock')), false);
    await owner.check(true);
    assert.equal(reports.length, 2);
    for (const report of reports) {
      assert.equal(report.error, false);
      assert.match(report.message, /snapshot plugin is installed and enabled/i);
      assert.doesNotMatch(
        report.message,
        /snapshots are (?:installed|ready|available)|hooks? (?:are )?(?:ready|running|working)|snapshot capture (?:is ready|has been checked)/i,
      );
    }
  } finally {
    await owner.dispose();
    processes.mockRestore();
    filesystem.mockRestore();
    syncBuiltinESMExports();
  }
});

function command(mutation = false): PluginCommand {
  return { command: 'fixture', args: [], cwd: '.', env: {}, timeout: PLUGIN_READ_MS, mutation };
}

test('bounded output counts UTF-8 bytes separately and waits for child close', async () => {
  const child = new FakeChild();
  const run = pluginRunner(() => child as unknown as ChildProcessWithoutNullStreams);
  const pending = run(command(true), new AbortController().signal);
  const outcome = assert.rejects(
    pending,
    (error: unknown) => error instanceof PluginProcessError && error.retainOwnership,
  );
  child.stdout.emit('data', 'é'.repeat(PLUGIN_OUTPUT_BYTES / 2 + 1));
  assert.equal(child.kill.mock.calls.length, 1);
  assert.equal(child.stdin.end.mock.calls.length, 1);
  child.close();
  await outcome;
});

test('both streams admit their own byte budget', async () => {
  const child = new FakeChild();
  const run = pluginRunner(() => child as unknown as ChildProcessWithoutNullStreams);
  const pending = run(command(), new AbortController().signal);
  child.stdout.emit('data', Buffer.alloc(PLUGIN_OUTPUT_BYTES, 'a'));
  child.stderr.emit('data', Buffer.alloc(PLUGIN_OUTPUT_BYTES, 'b'));
  child.close();
  const result = await pending;
  assert.equal(result.stdout.length, PLUGIN_OUTPUT_BYTES);
  assert.equal(result.stderr.length, PLUGIN_OUTPUT_BYTES);
});

test('timeouts retain mutation ownership and settle after exit with descendant-held pipes', async () => {
  vi.useFakeTimers();
  try {
    const child = new FakeChild();
    const run = pluginRunner(() => child as unknown as ChildProcessWithoutNullStreams);
    const pending = run(command(true), new AbortController().signal);
    const outcome = assert.rejects(pending, /time limit/);
    await vi.advanceTimersByTimeAsync(PLUGIN_READ_MS);
    assert.equal(child.kill.mock.calls.length, 1);
    child.emit('exit', null);
    await outcome;
    assert.equal(child.stdout.destroy.mock.calls.length, 1);
    assert.equal(child.stderr.destroy.mock.calls.length, 1);
  } finally {
    vi.useRealTimers();
  }
});

test('canceling a mutation settles on exit with descendant-held pipes and preserves its lock', async () => {
  const f = fixture();
  const controller = new AbortController();
  let child: FakeChild | undefined;
  const ownedRun = pluginRunner(() => {
    child = new FakeChild();
    return child as unknown as ChildProcessWithoutNullStreams;
  });
  f.behavior(async (command, signal) => {
    if (command.mutation) return (await ownedRun(command, signal)).stdout;
    return undefined;
  });
  const pending = f.setup.install(f.target, controller.signal);
  const rejected = assert.rejects(pending, /ownership remains/);
  await vi.waitFor(() => assert.ok(child));
  controller.abort();
  assert.equal(fs.existsSync(path.join(f.target.home, '.arc-snapshot-setup.lock')), true);
  assert.equal(child!.kill.mock.calls.length, 1);
  child!.emit('exit', null);
  await rejected;
  assert.equal(fs.existsSync(path.join(f.target.home, '.arc-snapshot-setup.lock')), true);
  assert.equal(f.mutations().length, 1);
});

test('canceling after direct-child exit closes descendant-held pipes without killing the exited child', async () => {
  const child = new FakeChild();
  const controller = new AbortController();
  const pending = pluginRunner(() => child as unknown as ChildProcessWithoutNullStreams)(
    command(true),
    controller.signal,
  );
  const rejected = assert.rejects(
    pending,
    (error: unknown) => error instanceof PluginProcessError && error.retainOwnership,
  );
  child.emit('exit', 0);
  controller.abort();
  await rejected;
  assert.equal(child.kill.mock.calls.length, 0);
  assert.equal(child.stdout.destroy.mock.calls.length, 1);
  assert.equal(child.stderr.destroy.mock.calls.length, 1);
});

test('disposal settles an interrupted installation after exit without waiting for descendant pipes', async () => {
  const f = offerFixture();
  f.answer('Install');
  let child: FakeChild | undefined;
  const run = pluginRunner(() => {
    child = new FakeChild();
    return child as unknown as ChildProcessWithoutNullStreams;
  });
  f.f.behavior(async (command, signal) => (command.mutation ? (await run(command, signal)).stdout : undefined));
  const checking = f.owner.check();
  await vi.waitFor(() => assert.ok(child));
  const disposed = f.owner.dispose();
  child!.emit('exit', null);
  await disposed;
  await checking;
  assert.equal(f.reports.length, 0);
  assert.equal(f.f.mutations().length, 1);
  assert.equal(fs.existsSync(path.join(f.f.target.home, '.arc-snapshot-setup.lock')), true);
  assert.equal(child!.stdout.destroy.mock.calls.length, 1);
  assert.equal(child!.stderr.destroy.mock.calls.length, 1);
});

test('missing Claude preserves unknown detection without mutation', async () => {
  const f = fixture();
  f.behavior(async () => {
    throw new Error('Claude executable unavailable');
  });
  assert.equal((await f.setup.detect(f.target, f.signal)).state, 'unknown');
  assert.equal(f.mutations().length, 0);
});

test('listed plugin load errors and unavailable folders prevent enabled state', () => {
  const f = fixture();
  assert.equal(listedPlugin([{ ...f.entry, errors: ['failure'] }], f.target.cwd).state, 'unknown');
  assert.equal(
    listedPlugin([{ ...f.entry, installPath: path.join(f.target.home, 'absent') }], f.target.cwd).state,
    'unknown',
  );
});

test('a file at the reported installation path does not establish an installed plugin', () => {
  const f = fixture();
  const file = path.join(f.target.home, 'not-a-plugin-directory');
  fs.writeFileSync(file, 'fixture');
  assert.equal(listedPlugin([{ ...f.entry, installPath: file }], f.target.cwd).state, 'unknown');
});

test('canceled setup creates no configuration home or lock', async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  const home = path.join(f.target.home, 'not-created');
  await assert.rejects(f.setup.install({ ...f.target, home }, controller.signal), /canceled/);
  assert.equal(fs.existsSync(home), false);
  assert.equal(f.commands.length, 0);
});

function bundledFixture(label = 'A', root?: string) {
  const f = fixture();
  const software = root ?? path.join(f.root, 'software');
  const directory = path.join(f.root, 'payload');
  const files: ToolPackage['payload']['files'] = {};
  const contents: Record<string, string> = {
    'cli/arc.cjs': 'console.log("CLI ' + label + '")',
    'cli/windowpipe.exe': 'fixture helper',
    'plugin/.claude-plugin/plugin.json': JSON.stringify({ name: 'arc-hooks', version: '0.1.0' }),
    'plugin/hooks/hooks.json': '{}',
    'plugin/scripts/capture.cjs': label,
    'plugin/LICENSE': 'MIT',
    LICENSE: 'MIT',
    'launchers/arc': '#!/bin/sh\n',
    'launchers/arc.cmd': '@echo off\r\n',
  };
  for (const [file, text] of Object.entries(contents)) {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
    const mode = file === 'launchers/arc' ? 0o755 : 0o644;
    fs.chmodSync(target, mode);
    files[file] = { sha256: createHash('sha256').update(text).digest('hex'), mode };
  }
  const payload = {
    schemaVersion: 1,
    nodeMinimum: 18,
    platforms: ['win32', 'linux', 'darwin'],
    plugin: { name: 'arc-hooks', version: '0.1.0' },
    files,
  };
  const bundle: ToolPackage = {
    directory,
    payload: { ...payload, contentId: createHash('sha256').update(JSON.stringify(payload)).digest('hex') },
  };
  const tools = new BundledTools(bundle, software);
  f.markets([]);
  let observed = '';
  let mutation: ((command: PluginCommand) => Promise<string | undefined>) | undefined;
  const commands: PluginCommand[] = [];
  const run: PluginRunner = async (command, signal) => {
    commands.push(command);
    if (command.mutation) {
      const custom = await mutation?.(command);
      if (custom !== undefined) return { stdout: custom, stderr: '' };
    }
    const args = command.args.slice(command.command === 'node' ? 0 : 1);
    if (args.slice(0, 3).join(' ') === 'plugin marketplace add') {
      f.markets([{ name: 'arc', source: 'directory', path: args[3] }]);
      return { stdout: 'Added', stderr: '' };
    }
    if (args.slice(0, 3).join(' ') === 'plugin marketplace update') return { stdout: 'Updated', stderr: '' };
    if (args[0] === 'plugin' && ['install', 'update'].includes(args[1])) {
      observed = tools.configuration(f.target.home).plugin;
      f.entries([{ ...f.entry, version: '0.1.0', installPath: observed }]);
      return {
        stdout: JSON.stringify({ command: args[1], outcome: 'ok', scope: 'user', pluginId: f.entry.id }),
        stderr: '',
      };
    }
    return f.run(command, signal);
  };
  return {
    f,
    tools,
    bundle,
    run,
    setup: new ClaudePluginSetup(run, undefined, f.read, tools, () => 'node'),
    observed: () => observed,
    mutations: () => commands.filter((command) => command.mutation),
    mutation: (value: typeof mutation) => {
      mutation = value;
    },
  };
}

test('bundled explicit setup installs offline and selects changed bytes with repeated versions through both callers', async () => {
  const a = bundledFixture();
  await a.setup.install(a.f.target, a.f.signal);
  const first = a.observed();
  assert.equal(a.tools.registration(a.f.target.home)?.complete, true);
  const b = bundledFixture('B', a.tools.root);
  const changed = new ClaudePluginSetup(a.run, undefined, a.f.read, b.tools, () => 'node');
  // The fixture's native update reads the newly published catalog before reporting its selected folder.
  a.mutation(async (command) => {
    if (!command.args.includes('update') || command.args.includes('marketplace')) return undefined;
    const plugin = b.tools.configuration(a.f.target.home).plugin;
    a.f.entries([{ ...a.f.entry, version: '0.1.0', installPath: plugin }]);
    return JSON.stringify({ command: 'update', outcome: 'ok', scope: 'user', pluginId: a.f.entry.id });
  });
  let offers = 0;
  const messages: string[] = [];
  const owner = new ClaudePluginOffer(
    {
      target: () => a.f.target,
      dismissed: () => false,
      dismiss: async () => {},
      offer: async () => {
        offers++;
        return 'Install';
      },
      report: (message, error) => {
        assert.equal(error, false, message);
        messages.push(message);
      },
    },
    changed,
  );
  await owner.check();
  assert.equal(offers, 0);
  await owner.check(true);
  assert.equal(offers, 1);
  assert.equal(b.tools.registration(a.f.target.home)?.contentId, b.bundle.payload.contentId);
  assert.equal(fs.readFileSync(path.join(first, 'scripts/capture.cjs'), 'utf8'), 'A');
  assert.equal(
    fs.readFileSync(path.join(b.tools.configuration(a.f.target.home).plugin, 'scripts/capture.cjs'), 'utf8'),
    'B',
  );
  a.mutation(undefined);
  await a.setup.install(a.f.target, a.f.signal);
  assert.equal(a.tools.registration(a.f.target.home)?.contentId, a.bundle.payload.contentId);
  const mutations = a.mutations().length;
  await a.setup.install(a.f.target, a.f.signal);
  assert.equal(a.mutations().length, mutations);
  await owner.dispose();
});

test('bundled configuration catalogs retain independent releases and never activate the shared CLI', async () => {
  const a = bundledFixture();
  const b = bundledFixture('B', a.tools.root);
  await a.setup.install(a.f.target, a.f.signal);
  await b.setup.install(b.f.target, b.f.signal);
  assert.notEqual(a.tools.configuration(a.f.target.home).source, b.tools.configuration(b.f.target.home).source);
  assert.equal(a.tools.registration(a.f.target.home)?.contentId, a.bundle.payload.contentId);
  assert.equal(b.tools.registration(b.f.target.home)?.contentId, b.bundle.payload.contentId);
  assert.equal(fs.existsSync(path.join(a.tools.tools, 'active.json')), false);
});

test('private CLI preparation retains older releases without selecting standalone commands', async () => {
  const a = bundledFixture();
  const b = bundledFixture('B', a.tools.root);
  const first = await a.tools.preparePrivateCommands(a.f.signal);
  const second = await b.tools.preparePrivateCommands(b.f.signal);
  assert.notEqual(first, second);
  assert.ok(fs.existsSync(path.join(path.dirname(first), 'release.json')));
  assert.ok(fs.existsSync(path.join(path.dirname(second), 'release.json')));
  assert.equal(fs.existsSync(path.join(a.tools.tools, 'active.json')), false);
  assert.equal(fs.existsSync(path.join(a.tools.root, 'bin')), false);
});

test('bundled wrapped unsettled mutations retain software and configuration locks and block command setup', async () => {
  const a = bundledFixture();
  a.mutation(async () => {
    throw new Error('Wrapped cancellation', { cause: new PluginProcessError('Unsettled descendants', true) });
  });
  await assert.rejects(a.setup.install(a.f.target, a.f.signal), /ownership remains/);
  assert.equal(fs.existsSync(path.join(a.tools.tools, '.install.lock')), true);
  assert.equal(fs.existsSync(path.join(a.f.target.home, '.arc-snapshot-setup.lock')), true);
  await assert.rejects(a.tools.installCommands(process.execPath, a.f.signal), /Another Arc setup/);
  assert.equal(a.tools.registration(a.f.target.home)?.complete, false);
});

test('bundled installed identity mismatch remains incomplete and preserves independent CLI selection', async () => {
  const a = bundledFixture();
  await a.tools.installCommands(process.execPath, a.f.signal);
  const active = fs.readFileSync(path.join(a.tools.tools, 'active.json'));
  a.mutation(async (command) => {
    if (!command.args.includes('install')) return undefined;
    a.f.entries([a.f.entry]);
    return JSON.stringify({ command: 'install', outcome: 'ok' });
  });
  await assert.rejects(a.setup.install(a.f.target, a.f.signal), /different snapshot files/);
  assert.deepEqual(fs.readFileSync(path.join(a.tools.tools, 'active.json')), active);
  assert.equal(a.tools.registration(a.f.target.home)?.complete, false);
  assert.equal(fs.existsSync(path.join(a.tools.tools, '.install.lock')), false);
});

test('bundled software ownership is acquired before configuration ownership across roots', async () => {
  const a = bundledFixture();
  const open = fs.openSync;
  const filesystem = vi.spyOn(fsBuiltin, 'openSync').mockImplementation((file, flags, mode) => {
    if (String(file) === path.join(a.f.target.home, '.arc-snapshot-setup.lock'))
      assert.equal(fs.existsSync(path.join(a.tools.tools, '.install.lock')), true);
    return open(file, flags, mode);
  });
  syncBuiltinESMExports();
  await a.setup.install(a.f.target, a.f.signal);
  filesystem.mockRestore();
  syncBuiltinESMExports();
  const before = a.f.commands.length;
  const held = acquireToolLock(path.join(a.f.target.home, '.arc-snapshot-setup.lock'));
  try {
    await assert.rejects(a.setup.install(a.f.target, a.f.signal), /Another Arc setup/);
    assert.equal(fs.existsSync(path.join(a.tools.tools, '.install.lock')), false);
    assert.equal(a.f.commands.length, before);
  } finally {
    held.release();
  }
  const foreign = bundledFixture('B');
  foreign.f.markets([{ name: 'arc', source: 'directory', path: a.tools.configuration(a.f.target.home).source }]);
  await assert.rejects(foreign.setup.install(foreign.f.target, foreign.f.signal), /another source/);
  assert.equal(foreign.f.mutations().length, 0);
});

test('bundled settled failed updates restore the prior catalog and keep the requested registration incomplete', async () => {
  const a = bundledFixture();
  await a.tools.installCommands(process.execPath, a.f.signal);
  await a.setup.install(a.f.target, a.f.signal);
  const b = bundledFixture('B', a.tools.root);
  const changed = new ClaudePluginSetup(a.run, undefined, a.f.read, b.tools, () => 'node');
  a.mutation(async () => {
    throw new Error('Native update failed after publication.');
  });
  await assert.rejects(changed.install(a.f.target, a.f.signal), /Native update failed/);
  const catalog = JSON.parse(
    fs.readFileSync(
      path.join(a.tools.configuration(a.f.target.home).source, '.claude-plugin/marketplace.json'),
      'utf8',
    ),
  );
  assert.equal(catalog.plugins[0].source, `./releases/${a.bundle.payload.contentId}/plugin`);
  assert.equal(b.tools.registration(a.f.target.home)?.contentId, b.bundle.payload.contentId);
  assert.equal(b.tools.registration(a.f.target.home)?.complete, false);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(a.tools.tools, 'active.json'), 'utf8')).contentId,
    a.bundle.payload.contentId,
  );
});

test('bundled enabled project and foreign user entries never change scope or payload', async () => {
  const a = bundledFixture();
  await a.setup.install(a.f.target, a.f.signal);
  const owned = a.observed();
  a.f.entries([
    { ...a.f.entry, installPath: owned },
    { ...a.f.entry, scope: 'project', projectPath: a.f.target.cwd },
  ]);
  await assert.rejects(a.setup.install(a.f.target, a.f.signal), /another installation or scope/);
  a.f.entries([{ ...a.f.entry, installPath: a.f.entry.installPath }]);
  await assert.rejects(a.setup.install(a.f.target, a.f.signal), /another installation or scope/);
  assert.equal(fs.readFileSync(path.join(owned, 'scripts/capture.cjs'), 'utf8'), 'A');
});
test.each(['.claude-plugin', 'releases'])(
  'bundled redirected catalog destination preserves foreign files (%s)',
  async (name) => {
    const a = bundledFixture();
    await a.setup.install(a.f.target, a.f.signal);
    const location = a.tools.configuration(a.f.target.home);
    const destination = path.join(location.source, name);
    const retained = destination + '.retained';
    fs.renameSync(destination, retained);
    const foreign = path.join(a.f.root, 'foreign');
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, 'marketplace.json'), 'foreign catalog');
    fs.symlinkSync(foreign, destination, process.platform === 'win32' ? 'junction' : 'dir');
    const b = bundledFixture('B', a.tools.root);
    await assert.rejects(
      b.tools.owned(async (token) => b.tools.publish(a.f.target.home, token), a.f.signal),
      /redirected/,
    );
    assert.deepEqual(fs.readdirSync(foreign), ['marketplace.json']);
    assert.equal(fs.readFileSync(path.join(foreign, 'marketplace.json'), 'utf8'), 'foreign catalog');
  },
);

test.each(['listing', 'node'])(
  'bundled retry recovers native selection after incomplete setup (%s)',
  async (failure) => {
    const a = bundledFixture();
    let selected = false;
    let failed = false;
    const run: PluginRunner = async (command, signal) => {
      const args = command.args.slice(command.command === 'node' ? 0 : 1).join(' ');
      if (
        selected &&
        !failed &&
        ((failure === 'listing' && args === 'plugin list --json') || (failure === 'node' && command.command === 'node'))
      ) {
        failed = true;
        throw new Error('Transient completion failure');
      }
      const result = await a.run(command, signal);
      if (args === 'plugin install arc-hooks@arc --scope user --json') selected = true;
      return result;
    };
    const setup = new ClaudePluginSetup(run, undefined, a.f.read, a.tools, () => 'node');
    await assert.rejects(setup.install(a.f.target, a.f.signal), /Transient completion failure|Node.js/);
    assert.equal(a.tools.registration(a.f.target.home)?.complete, false);
    await setup.install(a.f.target, a.f.signal);
    assert.equal(a.tools.registration(a.f.target.home)?.complete, true);
  },
);

test('bundled retry recovers changed native release after incomplete update', async () => {
  const a = bundledFixture();
  await a.setup.install(a.f.target, a.f.signal);
  const old = a.observed();
  const b = bundledFixture('B', a.tools.root);
  let selected = false;
  let failed = false;
  const run: PluginRunner = async (command, signal) => {
    const args = command.args.slice(command.command === 'node' ? 0 : 1).join(' ');
    if (args === 'plugin update arc-hooks@arc --scope user --json') {
      selected = true;
      a.f.entries([{ ...a.f.entry, installPath: b.tools.configuration(a.f.target.home).plugin }]);
      return { stdout: JSON.stringify({ command: 'update', outcome: 'ok', scope: 'user' }), stderr: '' };
    }
    if (selected && !failed && args === 'plugin list --json') {
      failed = true;
      throw new Error('Transient updated listing failure');
    }
    return a.run(command, signal);
  };
  const setup = new ClaudePluginSetup(run, undefined, a.f.read, b.tools, () => 'node');
  await assert.rejects(setup.install(a.f.target, a.f.signal), /Transient updated listing/);
  assert.equal(b.tools.registration(a.f.target.home)?.observedPath, old);
  await setup.install(a.f.target, a.f.signal);
  assert.equal(b.tools.registration(a.f.target.home)?.complete, true);
  assert.equal(b.tools.registration(a.f.target.home)?.observedPath, b.tools.configuration(a.f.target.home).plugin);
});

test.each(['registration', 'copy'])(
  'bundled first configuration publication remains retryable (%s)',
  async (failure) => {
    const a = bundledFixture();
    const rename = fs.renameSync;
    const copy = fs.cpSync;
    let failed = false;
    const spy =
      failure === 'registration'
        ? vi.spyOn(fsBuiltin, 'renameSync').mockImplementation((from, to) => {
            if (!failed && String(to).endsWith('registration.json')) {
              failed = true;
              throw new Error('Storage failure');
            }
            return rename(from, to);
          })
        : vi.spyOn(fsBuiltin, 'cpSync').mockImplementation((from, to, options) => {
            if (!failed && String(to).endsWith('plugin')) {
              failed = true;
              throw new Error('Storage failure');
            }
            return copy(from, to, options);
          });
    syncBuiltinESMExports();
    try {
      await assert.rejects(a.setup.install(a.f.target, a.f.signal), /Storage failure/);
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
    await a.setup.install(a.f.target, a.f.signal);
    assert.equal(a.tools.registration(a.f.target.home)?.complete, true);
  },
);

test.each([
  [false, false],
  [false, true],
  [true, false],
])(
  'bundled partial command writes preserve selection and permit retry (previous %s, directory locked %s)',
  async (previous, locked) => {
    const a = bundledFixture();
    if (previous) await a.tools.installCommands(process.execPath, a.f.signal);
    const active = path.join(a.tools.tools, 'active.json');
    const before = previous ? fs.readFileSync(active) : undefined;
    const bin = path.join(a.tools.root, 'bin');
    const oldLauncher = previous ? fs.readFileSync(path.join(bin, 'arc')) : undefined;
    const runtime = path.join(a.f.root, 'alternate-node' + (process.platform === 'win32' ? '.exe' : ''));
    fs.copyFileSync(process.execPath, runtime);
    fs.chmodSync(runtime, 0o755);
    const rename = fs.renameSync;
    const rmdir = fs.rmdirSync;
    let failed = false;
    let cleanupFailed = false;
    const spy = vi.spyOn(fsBuiltin, 'renameSync').mockImplementation((from, to) => {
      if (!failed && String(to) === path.join(bin, 'arc.cmd')) {
        failed = true;
        throw new Error('Storage failure');
      }
      return rename(from, to);
    });
    const cleanupSpy = vi.spyOn(fsBuiltin, 'rmdirSync').mockImplementation((directory, options) => {
      if (locked && !cleanupFailed && String(directory) === bin) {
        cleanupFailed = true;
        throw Object.assign(new Error('Directory is busy'), { code: 'EBUSY' });
      }
      return rmdir(directory, options);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(a.tools.installCommands(runtime, a.f.signal), /Storage failure/);
    } finally {
      spy.mockRestore();
      cleanupSpy.mockRestore();
      syncBuiltinESMExports();
    }
    if (locked) {
      assert.equal(cleanupFailed, true);
      assert.deepEqual(fs.readdirSync(bin), []);
    }
    if (previous) {
      assert.deepEqual(fs.readFileSync(active), before);
      assert.deepEqual(fs.readFileSync(path.join(bin, 'arc')), oldLauncher);
    } else assert.equal(fs.existsSync(active), false);
    await a.tools.installCommands(runtime, a.f.signal);
    assert.equal(fs.existsSync(path.join(a.tools.tools, 'command-operation.json')), false);
    assert.equal(JSON.parse(fs.readFileSync(active, 'utf8')).runtime, fs.realpathSync.native(runtime));
  },
);

test('snapshot runtime admission rejects colliding workspace Node without executing it', () => {
  const root = tempDir('arc-node-shadow-');
  const project = path.join(root, 'project');
  const workspaceBin = path.join(project, 'bin');
  const externalBin = path.join(root, 'external');
  fs.mkdirSync(workspaceBin, { recursive: true });
  fs.mkdirSync(externalBin);
  const executable = process.platform === 'win32' ? 'node.exe' : 'node';
  fs.writeFileSync(path.join(workspaceBin, executable), 'workspace executable must never run');
  fs.chmodSync(path.join(workspaceBin, executable), 0o755);
  fs.copyFileSync(process.execPath, path.join(externalBin, executable));
  fs.chmodSync(path.join(externalBin, executable), 0o755);
  const separator = process.platform === 'win32' ? ';' : ':';
  assert.equal(
    resolveToolRuntime({ PATH: externalBin }, project),
    fs.realpathSync.native(path.join(externalBin, executable)),
  );
  assert.throws(
    () => resolveToolRuntime({ PATH: workspaceBin + separator + externalBin }, project),
    /from this project/,
  );
});
test('bundled command retry retains operation evidence when rollback storage also fails', async () => {
  const a = bundledFixture();
  await a.tools.installCommands(process.execPath, a.f.signal);
  const bin = path.join(a.tools.root, 'bin');
  const runtime = path.join(a.f.root, 'alternate-node' + (process.platform === 'win32' ? '.exe' : ''));
  fs.copyFileSync(process.execPath, runtime);
  fs.chmodSync(runtime, 0o755);
  const active = fs.readFileSync(path.join(a.tools.tools, 'active.json'));
  const launcher = fs.readFileSync(path.join(bin, 'arc'));
  const rename = fs.renameSync;
  const spy = vi.spyOn(fsBuiltin, 'renameSync').mockImplementation((from, to) => {
    if (String(to) === path.join(bin, 'arc.cmd')) throw new Error('Persistent storage failure');
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(a.tools.installCommands(runtime, a.f.signal), /Persistent storage/);
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
  const journal = path.join(a.tools.tools, 'command-operation.json');
  assert.equal(fs.existsSync(journal), true);
  fs.writeFileSync(path.join(bin, 'arc.cmd'), 'foreign bytes');
  await assert.rejects(a.tools.installCommands(runtime, a.f.signal), /unfamiliar/);
  assert.equal(fs.readFileSync(path.join(bin, 'arc.cmd'), 'utf8'), 'foreign bytes');
  assert.deepEqual(fs.readFileSync(path.join(a.tools.tools, 'active.json')), active);
  const operation = JSON.parse(fs.readFileSync(journal, 'utf8'));
  fs.writeFileSync(path.join(bin, 'arc.cmd'), operation.previous['arc.cmd']);
  await a.tools.installCommands(process.execPath, a.f.signal);
  assert.equal(fs.existsSync(journal), false);
  assert.deepEqual(fs.readFileSync(path.join(bin, 'arc')), launcher);
});
test.each(['win32', 'linux', 'darwin'] as const)(
  'snapshot Node shadow refusal follows host executable resolution (%s)',
  (platform) => {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const project = platform === 'win32' ? 'C:\\project' : '/project';
    const workspaceBin = paths.join(project, 'bin');
    const externalBin = platform === 'win32' ? 'C:\\external' : '/external';
    const executable = platform === 'win32' ? 'node.exe' : 'node';
    const candidates = new Set([paths.join(workspaceBin, executable), paths.join(externalBin, executable)]);
    const probes: string[] = [];
    const source = fs.readFileSync(path.join(__dirname, 'bundledtools.ts'), 'utf8');
    const body = source
      .slice(source.indexOf('export function resolveToolRuntime'))
      .replace('export function', 'function');
    const compiled = transformSync(body + '\nmodule.exports = resolveToolRuntime;', { loader: 'ts' }).code;
    const module = { exports: undefined as unknown as typeof resolveToolRuntime };
    vm.runInNewContext(compiled, {
      module,
      path: paths,
      process: { platform, env: {}, cwd: () => project },
      fs: {
        constants: { F_OK: 0, X_OK: 1 },
        existsSync: (file: string) => candidates.has(file),
        accessSync: (file: string) => {
          if (!candidates.has(file)) throw new Error('Absent');
        },
        statSync: () => ({ isFile: () => true }),
      },
      canonicalToolPath: (file: string) => paths.normalize(file),
      probeToolRuntime: (file: string) => {
        probes.push(file);
        return file;
      },
    });
    assert.equal(module.exports({ PATH: externalBin }, project, platform), paths.join(externalBin, executable));
    const delimiter = platform === 'win32' ? ';' : ':';
    assert.throws(
      () => module.exports({ PATH: workspaceBin + delimiter + externalBin }, project, platform),
      /from this project/,
    );
    assert.deepEqual(probes, [paths.join(externalBin, executable)]);
    if (platform === 'win32') {
      candidates.add(paths.join(externalBin, 'node.cmd'));
      assert.throws(
        () => module.exports({ PATH: externalBin, PATHEXT: '.CMD;.EXE' }, project, platform),
        /executable first/,
      );
      candidates.add(paths.join(project, 'node.exe'));
      assert.throws(() => module.exports({ PATH: externalBin }, project, platform), /from this project/);
    }
  },
);
