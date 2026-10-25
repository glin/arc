// @module-tag subprocess
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { runInNewContext } = require('node:vm');

let driver;
let run;
let checkout;
beforeAll(async () => {
  driver = await import('./test-installer.mjs');
});
afterEach(() => {
  if (run && fs.existsSync(run.root)) driver.cleanupSandbox(run, { list: () => [] });
  run = undefined;
  if (checkout) fs.rmSync(checkout, { recursive: true });
  checkout = undefined;
});

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

// The production entry point must request hooks whenever its operation checks plugin installation.
test.each(['install', 'sequence'])(
  'production %s rehearsal selects hooks and keeps explicit skip independent',
  async (operation) => {
    const source = fs.readFileSync(path.join(__dirname, 'test-installer.mjs'), 'utf8');
    const body = source
      .slice(source.indexOf('function parse(args)'), source.indexOf('if (process.argv[1]'))
      .replace('export async function main', 'async function main');
    const calls = [];
    const environment = {
      createSandbox: () => ({ root: '/owned-fixture' }),
      save: () => {},
      preflight: async () => {},
      wrapper: () => {},
      stageSource: () => {},
      install: async (_run, source, options, extra) => {
        calls.push({ source, options, extra });
      },
      console: { log: () => {} },
      repository: '/source',
      process: { pid: 1 },
    };
    const main = runInNewContext('(() => { ' + body + '\nreturn main; })()', environment);
    const args = [
      operation,
      operation === 'install' ? '--source' : '--first',
      'local',
      '--checkout',
      '/source',
      '--editor',
      '/editor',
      '--repo',
      'owner/repo',
      '--ref',
      'revision',
    ];
    await main(args);
    assert.deepEqual(
      calls.map((call) => call.source),
      operation === 'install' ? ['local'] : ['local', 'remote', 'local'],
    );
    assert.ok(calls.every((call) => JSON.stringify(call.extra) === JSON.stringify(['--hooks'])));
    calls.length = 0;
    await main([...args, '--no-hooks', '--marketplace-url', 'https://example.invalid/catalog.json']);
    assert.ok(calls.every((call) => JSON.stringify(call.extra) === JSON.stringify(['--no-hooks'])));
  },
);

// This child catches deletion beneath a live session without editor startup, installation, or a model call.
test.each([false, true])(
  'printed checkout launcher preserves external Claude and detached child %s until terminal exit',
  async (detached) => {
    run = driver.createSandbox(os.tmpdir());
    checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-external-claude-'));
    const plugin = path.join(checkout, 'plugins', 'arc-hooks');
    fs.mkdirSync(plugin, { recursive: true });
    const helper = path.join(checkout, 'claude.cjs');
    fs.writeFileSync(
      helper,
      `
const fs = require('node:fs'), path = require('node:path');
if (process.argv[2] === 'descendant') {
  const release = path.join(process.env.HOME, 'release');
  const watch = fs.watch(process.env.HOME, () => { if (fs.existsSync(release) || !fs.existsSync(process.env.HOME)) watch.close(); });
  fs.writeFileSync(path.join(process.env.HOME, 'descendant-ready'), String(process.pid));
  return;
}
if (process.argv[2] !== '--plugin-dir') { console.log('[]'); process.exit(0); }
if (${detached}) {
  require('node:child_process').spawn(process.execPath, [__filename, 'descendant'], {detached:true, stdio:'ignore'}).unref();
}
const release = path.join(process.env.HOME, ${detached ? "'parent-release'" : "'release'"});
const watch = fs.watch(process.env.HOME, () => { if (fs.existsSync(release) || !fs.existsSync(process.env.HOME)) watch.close(); });
fs.writeFileSync(path.join(process.env.HOME, 'ready'), JSON.stringify({pid:process.pid, plugin:process.argv[3]}));
`,
    );
    fs.writeFileSync(
      path.join(run.root, 'bin', 'claude'),
      `#!/usr/bin/env bash\nexec ${quote(process.execPath.replaceAll('\\', '/'))} ${quote(helper.replaceAll('\\', '/'))} "$@"\n`,
      { mode: 0o700 },
    );
    const command = await driver.checkoutPlugin(run, checkout);
    const child = spawn(driver.bashExecutable(), ['-c', command], { cwd: checkout, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = '';
    child.stderr.on('data', (bytes) => {
      errors += bytes;
    });
    const exited = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    const home = path.join(run.root, 'home');
    const ready = path.join(home, 'ready');
    try {
      await vi.waitFor(() => assert.ok(fs.existsSync(ready), errors), { timeout: 20000 });
      const active = JSON.parse(fs.readFileSync(ready));
      assert.equal(fs.realpathSync(active.plugin), fs.realpathSync(plugin));
      const processTools = await import('./isolated-editor.mjs');
      const external = processTools.listProcesses({ pids: [active.pid] });
      assert.equal(external.length, 1);
      assert.equal(external[0].commandLine.includes(run.root), false);
      assert.equal(external[0].commandLine.includes(run.root.replaceAll('\\', '/')), false);
      // Omit shell wrappers to exercise the Unix exec boundary on every native platform.
      assert.throws(() => driver.cleanupSandbox(run, { list: () => external }), /terminal receipt/);
      assert.ok(fs.existsSync(home));
      if (detached) {
        const descendantFile = path.join(home, 'descendant-ready');
        await vi.waitFor(
          () => {
            assert.ok(fs.existsSync(descendantFile));
            const pid = Number(fs.readFileSync(descendantFile, 'utf8'));
            const receipts = fs
              .readdirSync(path.join(run.root, 'evidence'))
              .filter((name) => /^checkout-launch-.*\.json$/.test(name));
            assert.ok(
              receipts.some((name) =>
                JSON.parse(fs.readFileSync(path.join(run.root, 'evidence', name))).processes.some(
                  (entry) => entry.pid === pid,
                ),
              ),
            );
          },
          { timeout: 20000 },
        );
        fs.writeFileSync(path.join(home, 'parent-release'), 'exit');
        await vi.waitFor(() => assert.equal(processTools.listProcesses({ pids: [active.pid] }).length, 0), {
          timeout: 20000,
        });
        assert.throws(() => driver.cleanupSandbox(run, { list: () => [] }), /terminal receipt/);
      }
      fs.writeFileSync(path.join(home, 'release'), 'exit');
      assert.equal(await exited, 0, errors);
      const receipts = fs
        .readdirSync(path.join(run.root, 'evidence'))
        .filter((name) => name.startsWith('checkout-launch-') && name.endsWith('.json'));
      assert.equal(receipts.length, 1);
      assert.equal(JSON.parse(fs.readFileSync(path.join(run.root, 'evidence', receipts[0]))).terminal, true);
      driver.cleanupSandbox(run);
      assert.ok(fs.existsSync(helper));
    } finally {
      if (fs.existsSync(home)) {
        fs.writeFileSync(path.join(home, 'parent-release'), 'exit');
        fs.writeFileSync(path.join(home, 'release'), 'exit');
      }
      await exited;
    }
  },
);

function fixture(mode) {
  run = driver.createSandbox(os.tmpdir());
  const helper = path.join(run.root, 'evidence', 'fixture.cjs');
  fs.writeFileSync(
    helper,
    `
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const root = ${JSON.stringify(run.root)};
const write = (file, value) => {fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, JSON.stringify(value));};
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const stateFile = path.join(root, 'home', '.claude', 'fixture.json');
const state = fs.existsSync(stateFile) ? read(stateFile) : {enabled:true};
const mode = ${JSON.stringify(mode) ?? 'undefined'};
const args = process.argv.slice(2);
const location = path.join(root, 'arc', 'selected');
if (args[0] === '--plugin-dir') {
  console.log(JSON.stringify({cwd:process.cwd(), home:process.env.HOME, claude:process.env.CLAUDE_CONFIG_DIR,
    arc:process.env.ARC_HOME, codex:process.env.CODEX_HOME, plugin:args[1], text:fs.readFileSync(path.join(args[1], 'live.txt'), 'utf8')}));
} else if (args[0] === 'install') {
  if (args.includes('--no-hooks')) { if (args.includes('--hooks') || args.includes('--marketplace-url')) process.exit(12); process.exit(0); }
  if (args.includes('--json') && !args.includes('--hooks')) process.exit(13);
  if (state.market) {console.log('uses this checkout'); process.exit(1);}
  state.market = path.join(root, 'arc', 'marketplace'); state.installed=true; state.enabled=true;
  delete state.readFromFolder;
  fs.mkdirSync(state.market, {recursive:true}); fs.mkdirSync(location, {recursive:true});
  fs.writeFileSync(path.join(location, 'live.txt'), 'managed');
  const files = {'plugin/live.txt':{sha256:hash('managed'), mode:420}};
  write(path.join(root, 'arc', 'registration.json'), {complete:true, scope:'user', source:state.market, contentId:'current', observedPath:fs.realpathSync(location)});
  write(path.join(root, 'arc', 'tools', 'releases', 'current', 'release.json'), {files});
  const ext = path.join(root, 'extensions', 'glin.arc', 'dist');
  write(path.join(ext, '..', 'package.json'), {publisher:'glin', name:'arc'});
  fs.mkdirSync(ext, {recursive:true}); fs.writeFileSync(path.join(ext, 'extension.js'), 'extension');
  write(path.join(ext, 'build-identity.json'), {extensionSha256:hash('extension'), tools:{contentId:'current', files}});
  write(stateFile, state);
  require(args[1]).removeLegacyHooks(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'));
} else if (args[1] === 'marketplace') {
  if (args[2] === 'add') state.market=args[3];
  if (args[2] === 'remove') delete state.market;
  if (args[2] === 'list') console.log(JSON.stringify(state.market ? [{name:'arc', source:{source:'directory', path:state.market}}] : []));
  else write(stateFile, state);
} else {
  if (args[1] === 'install') {
    state.installed=true; state.location=path.join(root, 'home', '.claude', 'fixture-cache');
    fs.cpSync(path.join(state.market, 'plugins', 'arc-hooks'), state.location, {recursive:true});
    state.readFromFolder=path.join(state.market, 'plugins', 'arc-hooks');
  }
  if (args[1] === 'uninstall') state.installed=false;
  if (args[1] === 'enable') state.enabled=true;
  if (args[1] === 'disable') state.enabled=false;
  if (args[1] === 'list') {
    if (mode && state.readFromFolder && !state.mutated) {
      const alias=path.join(root, 'source-link'), source=path.join(root, 'source');
      const unlink = file => process.platform === 'win32' ? fs.rmdirSync(file) : fs.unlinkSync(file);
      if (mode === 'unknown') {
        const unknown=path.join(root, 'evidence', 'unknown-alias');
        fs.symlinkSync(source, unknown, process.platform === 'win32' ? 'junction' : 'dir');
        state.readFromFolder=path.join(unknown, 'plugins', 'arc-hooks');
      } else if (mode === 'retargeted') {
        unlink(alias); fs.symlinkSync(path.join(root, 'bin'), alias, process.platform === 'win32' ? 'junction' : 'dir');
      } else if (mode === 'descendant') {
        const plugin=path.join(source, 'plugins', 'arc-hooks'), target=path.join(root, 'evidence', 'redirect-plugin');
        fs.renameSync(plugin, target); fs.symlinkSync(target, plugin, process.platform === 'win32' ? 'junction' : 'dir');
      }
      state.mutated=true; write(stateFile, state);
    }
    console.log(JSON.stringify(state.installed ? [{id:'arc-hooks@arc', scope:'user', enabled:state.enabled, readFromFolder:state.readFromFolder, installPath:state.market.endsWith('marketplace') ? location : state.location}] : []));
  }
  else write(stateFile, state);
}
`,
  );
  fs.writeFileSync(
    path.join(run.root, 'bin', 'claude'),
    `#!/usr/bin/env bash\nexec node ${quote(helper.replaceAll('\\', '/'))} "$@"\n`,
    { mode: 0o700 },
  );
  return helper;
}

// Launcher execution catches cwd escapes and Windows PATH conversion with one harmless child per session.
test('printed checkout launcher keeps private state and loads later live edits from a foreign cwd', async () => {
  fixture();
  checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-live-checkout-'));
  const plugin = path.join(checkout, 'plugins', 'arc-hooks');
  fs.mkdirSync(plugin, { recursive: true });
  const live = path.join(plugin, 'live.txt');
  fs.writeFileSync(live, 'first');
  for (const args of [
    ['init'],
    ['add', '.'],
    [
      '-c',
      'user.name=Arc Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'core.hooksPath=',
      'commit',
      '-m',
      'fixture',
    ],
  ]) {
    const result = spawnSync('git', ['-C', checkout, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const command = await driver.checkoutPlugin(run, checkout);
  const launch = () => {
    const result = spawnSync(driver.bashExecutable(), ['-c', command], { cwd: checkout, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const first = launch();
  assert.equal(fs.realpathSync(first.cwd), fs.realpathSync(path.join(run.root, 'workspace')));
  for (const name of ['home', 'claude', 'arc', 'codex']) assert.ok(driver.inside(run.root, first[name]));
  assert.equal(first.text, 'first');
  fs.writeFileSync(live, 'second');
  assert.equal(launch().text, 'second');
  assert.equal(fs.realpathSync(first.plugin), fs.realpathSync(plugin));
  assert.equal(run.sources.length, 0);
  assert.equal(run.steps[0].cwd, path.join(run.root, 'workspace'));
  driver.cleanupSandbox(run, { list: () => [] });
  assert.equal(fs.readFileSync(live, 'utf8'), 'second');
});

test('checkout preparation refuses an installed Arc plugin in the private workspace', async () => {
  fixture();
  writeJson(path.join(run.root, 'home', '.claude', 'fixture.json'), {
    installed: true,
    enabled: true,
    market: 'marketplace',
  });
  await assert.rejects(driver.checkoutPlugin(run, path.resolve(__dirname, '..')), /duplicate an installed/);
  assert.equal(run.steps[0].cwd, path.join(run.root, 'workspace'));
});

// Installed identity checks catch self-consistent mismatched releases and missing editor artifacts without editor startup.
test.each(['content', 'files', 'absent', 'foreign'])(
  'installed plugin checks reject %s extension identity',
  async (change) => {
    const helper = fixture();
    await driver.execute(run, process.execPath, [helper, 'install', path.resolve(__dirname, 'register-hooks.js')]);
    await driver.checkPlugin(run);
    const file = path.join(run.root, 'extensions', 'glin.arc', 'dist', 'build-identity.json');
    const identity = JSON.parse(fs.readFileSync(file));
    if (change === 'content') identity.tools.contentId = 'another-release';
    if (change === 'files') identity.tools.files['plugin/live.txt'].sha256 = digest('another-plugin');
    if (change === 'foreign')
      writeJson(path.join(path.dirname(file), '..', 'package.json'), { publisher: 'other', name: 'arc' });
    if (change === 'absent') fs.unlinkSync(file);
    else writeJson(file, identity);
    await assert.rejects(driver.checkPlugin(run), /different payloads|Expected one installed Arc extension/);
  },
);

test('hosted plugin identity remains independent of the installed extension payload', async () => {
  const helper = fixture();
  await driver.execute(run, process.execPath, [helper, 'install', path.resolve(__dirname, 'register-hooks.js')]);
  run.hosted = true;
  const file = path.join(run.root, 'extensions', 'glin.arc', 'dist', 'build-identity.json');
  const identity = JSON.parse(fs.readFileSync(file));
  identity.tools.contentId = 'independent-hosted-release';
  writeJson(file, identity);
  const selected = await driver.checkPlugin(run);
  assert.equal(selected.extensions[0].identity.tools.contentId, 'independent-hosted-release');
  assert.equal(selected.files['live.txt'], digest('managed'));
});

// The complete rehearsal catches alias fixture errors while retaining production exact-path cleanup ownership.
test.each([false, true, 'unknown', 'retargeted', 'descendant'])(
  'legacy operation removes physical hooks and preserves other hooks via alias %s',
  async (alias) => {
    const helper = fixture(typeof alias === 'string' ? alias : undefined);
    checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-legacy-checkout-'));
    fs.mkdirSync(path.join(checkout, 'plugins', 'arc-hooks'), { recursive: true });
    fs.writeFileSync(path.join(checkout, 'plugins', 'arc-hooks', 'live.txt'), 'baseline');
    fs.mkdirSync(path.join(checkout, 'scripts'));
    fs.copyFileSync(path.join(__dirname, 'register-hooks.js'), path.join(checkout, 'scripts', 'register-hooks.js'));
    fs.writeFileSync(
      path.join(checkout, 'install.sh'),
      `#!/usr/bin/env bash\nexec node ${quote(helper.replaceAll('\\', '/'))} install "$(dirname "$0")/scripts/register-hooks.js" "$@"\n`,
    );
    const git = (...args) => {
      const result = spawnSync('git', ['-C', checkout, ...args], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git('init');
    git('add', '.');
    git(
      '-c',
      'user.name=Arc Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'core.hooksPath=',
      'commit',
      '-m',
      'fixture',
    );
    const baseline = git('rev-parse', 'HEAD');
    run.editor = { wrapper: path.join(run.root, 'bin', 'unused-editor') };
    if (typeof alias === 'string') {
      try {
        await assert.rejects(
          driver.legacyUpgrade(run, { baseline, checkout, 'via-link': true }),
          /Redirected path|Unfamiliar directory alias/,
        );
      } finally {
        if (alias === 'retargeted') {
          const link = path.join(run.root, 'source-link');
          if (process.platform === 'win32') fs.rmdirSync(link);
          else fs.unlinkSync(link);
          fs.symlinkSync(path.join(run.root, 'source'), link, process.platform === 'win32' ? 'junction' : 'dir');
        }
      }
      return;
    }
    await driver.legacyUpgrade(run, { baseline, checkout, 'via-link': alias });
    assert.equal(run.steps.filter((step) => step.operation === 'legacy-restoration').length, 2);
    const hooks = JSON.parse(fs.readFileSync(path.join(run.root, 'home', '.claude', 'settings.json'))).hooks.Stop;
    const commands = hooks.flatMap((entry) => entry.hooks.map((hook) => hook.command));
    assert.ok(commands.includes('echo unrelated-sentinel'));
    assert.equal(
      commands.some((command) => command.includes('/source/hooks/stop-manifest.cjs')),
      false,
    );
    assert.equal(
      commands.some((command) => command.includes('/source-link/hooks/stop-manifest.cjs')),
      alias,
    );
    assert.equal(run.plugin.finalEnabled, false);
    driver.cleanupSandbox(run, { list: () => [] });
    assert.equal(fs.readFileSync(path.join(checkout, 'plugins', 'arc-hooks', 'live.txt'), 'utf8'), 'baseline');
  },
  120000,
);

// These direct checks cover the writable boundary without starting editors or installing dependencies.
test.each(['win32', 'darwin', 'linux'])('sandbox environment isolates actual home selectors on %s', (platform) => {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const root = platform === 'win32' ? 'C:\\Scratch\\Mixed Case' : '/tmp/Mixed Case';
  const discovery = platform === 'win32' ? 'C:\\Tools;D:\\Other Tools' : '/tools:/opt/tools';
  const env = driver.privateEnvironment(
    root,
    {
      PATH: discovery,
      HOME: '/daily',
      UserProfile: '/daily',
      NODE_OPTIONS: '--require bad',
      node_path: '/injection',
      VSCODE_IPC_HOOK_CLI: 'daily',
      CODEX_HOME: '/daily',
      ARC_WINDOW: 'daily',
      CLAUDE_CONFIG_DIR: '/daily',
      XDG_CONFIG_HOME: '/daily',
      OPENAI_API_KEY: 'secret',
      GH_TOKEN: 'secret',
      BASH_ENV: '/daily',
    },
    platform,
  );
  assert.equal(env.PATH, api.join(root, 'bin') + (platform === 'win32' ? ';' : ':') + discovery);
  assert.equal(env.HOME, api.join(root, 'home'));
  assert.equal(env.USERPROFILE, env.HOME);
  assert.equal(env.CLAUDE_CONFIG_DIR, api.join(env.HOME, '.claude'));
  assert.equal(env.CODEX_HOME, api.join(env.HOME, '.codex'));
  for (const name of [
    'ARC_HOME',
    'APPDATA',
    'LOCALAPPDATA',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'XDG_CACHE_HOME',
    'TMP',
    'TEMP',
    'TMPDIR',
  ])
    assert.ok(driver.inside(root, env[name], api), name);
  for (const name of [
    'UserProfile',
    'NODE_OPTIONS',
    'node_path',
    'VSCODE_IPC_HOOK_CLI',
    'ARC_WINDOW',
    'OPENAI_API_KEY',
    'GH_TOKEN',
    'BASH_ENV',
  ])
    assert.equal(env[name], undefined, name);
  assert.equal(driver.inside(root, api.join(root + '-foreign', 'file'), api), false);
  assert.equal(driver.inside(root, api.join(root, '..', 'file'), api), false);
  assert.equal(driver.inside(root, api.join(root, 'home'), api), true);
});

test('cleanup requires a known manifest and terminal children before removing owned files', () => {
  run = driver.createSandbox(os.tmpdir());
  const file = path.join(run.root, 'home', 'sentinel');
  fs.writeFileSync(file, 'owned');
  assert.equal(driver.readSandbox(run.root).id, run.id);
  assert.equal(driver.readSandbox(run.root.replaceAll('\\', '/')).id, run.id);
  assert.throws(
    () =>
      driver.cleanupSandbox(run, {
        list: () => [{ pid: 2147483647, parentPid: 0, commandLine: path.join(run.root, 'source', 'build.mjs') }],
      }),
    /still has running processes/,
  );
  run.processes.push({ pid: 1, terminal: false });
  writeJson(path.join(run.root, 'installer-run.json'), run);
  assert.throws(() => driver.cleanupSandbox(run, { list: () => [] }), /terminal receipt/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'owned');
  run.processes = [];
  writeJson(path.join(run.root, 'installer-run.json'), run);
  const manifest = path.join(run.root, 'installer-run.json');
  const bytes = fs.readFileSync(manifest);
  fs.writeFileSync(manifest, JSON.stringify({ ...run, kind: 'foreign' }));
  assert.throws(() => driver.readSandbox(run.root), /Unknown/);
  fs.writeFileSync(manifest, bytes);
});

test.each(['win32', 'darwin', 'linux'])(
  'checkout receipts preserve unsettled launches and detached descendants on %s',
  async (platform) => {
    run = driver.createSandbox(os.tmpdir());
    const tools = await import('./isolated-editor.mjs');
    const api = platform === 'win32' ? path.win32 : path.posix;
    const executable = platform === 'win32' ? 'D:\\Tools\\claude.exe' : '/opt/tools/claude';
    const plugin =
      platform === 'win32' ? 'D:\\Live Checkout\\plugins\\arc-hooks' : '/opt/Live Checkout/plugins/arc-hooks';
    const parent = {
      pid: 2147483600,
      parentPid: 0,
      created: '2026-10-21T12:00:00.000Z',
      commandLine: `${executable} --plugin-dir "${plugin}"`,
    };
    const descendant = {
      pid: 2147483601,
      parentPid: parent.pid,
      created: '2026-10-21T12:00:01.000Z',
      commandLine: `${executable} worker`,
    };
    assert.ok(!driver.inside(api.dirname(plugin), executable, api));
    const receipt = { terminal: false, processes: [] };
    tools.rememberProcesses(receipt, [parent]);
    tools.rememberProcesses(
      receipt,
      tools.ownedProcesses([parent, descendant], api.join(plugin, 'unused-profile'), {
        known: receipt.processes,
        platform,
      }),
    );
    const file = path.join(run.root, 'evidence', 'checkout-launch-fixture.json');
    writeJson(file, receipt);
    assert.throws(() => driver.cleanupSandbox(run, { platform, list: () => [] }), /terminal receipt/);
    receipt.terminal = true;
    writeJson(file, receipt);
    assert.throws(
      () => driver.cleanupSandbox(run, { platform, list: () => [{ ...descendant, parentPid: 0 }] }),
      /still has running processes/,
    );
    const reused = { ...descendant, parentPid: 0, created: '2026-10-21T12:00:02.000Z' };
    driver.cleanupSandbox(run, { platform, list: () => [reused] });
  },
);

test('cleanup refuses redirected descendants and preserves their external target', () => {
  run = driver.createSandbox(os.tmpdir());
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-installer-foreign-'));
  const sentinel = path.join(target, 'sentinel');
  fs.writeFileSync(sentinel, 'foreign');
  const link = path.join(run.root, 'home', 'redirect');
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    assert.throws(() => driver.cleanupSandbox(run, { list: () => [] }), /leaves the sandbox/);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'foreign');
  } finally {
    if (process.platform === 'win32') fs.rmdirSync(link);
    else fs.unlinkSync(link);
    fs.unlinkSync(sentinel);
    fs.rmdirSync(target);
  }
});
