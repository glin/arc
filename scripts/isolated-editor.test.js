const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let editor;
const roots = [];

beforeAll(async () => {
  editor = await import(pathToFileURL(path.join(__dirname, 'isolated-editor.mjs')).href);
});

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function scratch() {
  const root = fs.mkdtempSync(
    path.join(
      fs.realpathSync(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir()),
      process.platform === 'darwin' ? 'ait-' : 'arc isolated editor test ',
    ),
  );
  roots.push(root);
  return root;
}

function cliFixture(relative = 'resources/app/out/cli.js') {
  const installation = path.join(scratch(), 'VS Code with spaces');
  const executable = path.join(installation, 'Code.exe');
  const cli = path.join(installation, relative);
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(executable, '');
  fs.writeFileSync(cli, 'process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));');
  return { installation, executable, cli };
}

function writeLauncher(installation, relative = 'resources/app/out/cli.js') {
  const launcher = path.join(installation, 'bin', 'code.cmd');
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(
    launcher,
    [
      '@echo off',
      'setlocal',
      'set VSCODE_DEV=',
      'set ELECTRON_RUN_AS_NODE=1',
      `"%~dp0..\\Code.exe" "%~dp0..\\${relative.replaceAll('/', '\\')}" %*`,
      'IF %ERRORLEVEL% NEQ 0 EXIT /b %ERRORLEVEL%',
      'endlocal',
    ].join('\r\n'),
  );
  return launcher;
}

// A clock whose sleep advances time at once, so deadline tests never wait.
// A wait that ignores its deadline fails here instead of spinning forever.
function fakeClock() {
  let now = 0;
  let sleeps = 0;
  return {
    now: () => now,
    sleep: async (milliseconds) => {
      if (++sleeps > 10_000) throw new Error('The wait ignored its deadline.');
      now += milliseconds;
    },
  };
}

const WINDOWS_ROOT = 'C:\\Scratch Dir\\arc-isolated-editor-1';
const WINDOWS_PROFILE = `${WINDOWS_ROOT}\\user-data`;

function windowsTable() {
  return [
    {
      pid: 100,
      parentPid: 4,
      created: '2026-10-12T04:00:00.000Z',
      commandLine: `"C:\\VS Code\\Code.exe" --user-data-dir "${WINDOWS_PROFILE}"`,
    },
    {
      pid: 101,
      parentPid: 100,
      created: '2026-10-12T04:00:01.000Z',
      commandLine:
        '"C:\\VS Code\\Code.exe" --type=renderer --user-data-dir="c:\\scratch dir\\arc-isolated-editor-1\\user-data"',
    },
    {
      pid: 102,
      parentPid: 4,
      created: '2026-10-12T04:00:01.000Z',
      commandLine:
        '"C:\\VS Code\\Code.exe" --type=utility --user-data-dir=C:/Scratch Dir/arc-isolated-editor-1/user-data',
    },
    { pid: 103, parentPid: 101, created: '2026-10-12T04:00:02.000Z', commandLine: 'conhost.exe 0x4' },
    {
      pid: 200,
      parentPid: 4,
      created: '2026-10-11T08:00:00.000Z',
      commandLine: '"C:\\VS Code\\Code.exe" --user-data-dir C:\\Users\\owner\\AppData\\Roaming\\Code',
    },
    {
      pid: 201,
      parentPid: 100,
      created: '2026-10-11T09:00:00.000Z',
      commandLine: 'older.exe from a reused parent PID',
    },
  ];
}

// Answers the Windows stop command from a table as the PowerShell script does: one target at a time,
// stopped only while its PID still has the recorded start time.
function fakePowerShell(table, stop) {
  return (_command, _args, options) => {
    const targets = JSON.parse(options.env[editor.STOP_TARGETS_VARIABLE]);
    const results = targets.map(({ pid, created }) => {
      const current = table().find((entry) => entry.pid === pid);
      if (!current) return { pid, outcome: 'gone', detail: null };
      if (!created) return { pid, outcome: 'unknown', detail: null };
      if (current.created !== created) return { pid, outcome: 'changed', detail: null };
      stop(pid);
      return { pid, outcome: 'stopped', detail: null };
    });
    return { status: 0, stdout: JSON.stringify(results) };
  };
}

describe('isolated editor environment', () => {
  test('removes editor, Arc, agent, Git, and Node option variables in any letter case', () => {
    const layout = editor.runLayout(path.join(scratch(), 'run'));
    const parent = {
      PATH: '/bin',
      ELECTRON_RUN_AS_NODE: '1',
      electron_run_as_node: '1',
      VSCODE_PID: '1',
      vscode_cwd: 'x',
      Arc_Home: 'owner',
      ARC_PROJECTS_ROOT: 'owner',
      CLAUDECODE: '1',
      claude_config_dir: 'owner',
      Node_Options: '--inspect',
      git_dir: 'x',
      GIT_INDEX_FILE: 'x',
      CODEX_HOME: 'owner',
    };
    const environment = editor.childEnvironment(parent, layout);
    assert.deepEqual(environment, {
      PATH: '/bin',
      ARC_HOME: layout.arcHome,
      ARC_PROJECTS_ROOT: layout.projects,
      ARC_CODEX_ROOT: layout.codexSessions,
      CLAUDE_CONFIG_DIR: layout.claudeConfig,
      CODEX_HOME: layout.codexHome,
      ARC_MEASURE_BLOCK_AGENTS: '1',
      ARC_MEASURE_STATE: layout.state,
    });
  });

  test('live data keeps the owner transcript roots and lets agents start only on request', () => {
    const layout = editor.runLayout(path.join(scratch(), 'run'));
    const environment = editor.childEnvironment(
      {
        PATH: '/bin',
        CLAUDE_CONFIG_DIR: 'owner config',
        ARC_PROJECTS_ROOT: 'owner projects',
        ARC_CODEX_ROOT: 'owner codex',
        CODEX_HOME: 'owner home',
        ELECTRON_RUN_AS_NODE: '1',
        ARC_MEASURE_BLOCK_AGENTS: '1',
      },
      layout,
      { liveData: true },
    );
    assert.deepEqual(environment, {
      PATH: '/bin',
      CODEX_HOME: 'owner home',
      ARC_HOME: layout.arcHome,
      CLAUDE_CONFIG_DIR: 'owner config',
      ARC_PROJECTS_ROOT: 'owner projects',
      ARC_CODEX_ROOT: 'owner codex',
    });
  });

  test('passes each path with spaces as one argument and turns off workspace trust', () => {
    const layout = editor.runLayout(path.join(scratch(), 'run with spaces'));
    const extensionPath = path.join(scratch(), 'my checkout', 'extension');
    const workspace = path.join(layout.root, 'work space');
    const args = editor.editorArguments(layout, { extensionPath, workspace });
    assert.equal(args[args.indexOf('--user-data-dir') + 1], layout.userData);
    assert.equal(args[args.indexOf('--extensions-dir') + 1], layout.extensions);
    assert.equal(args[args.indexOf('--extensionDevelopmentPath') + 1], extensionPath);
    assert.equal(args.at(-1), workspace);
    assert.ok(args.includes('--disable-workspace-trust'));
  });

  test('installed candidates use only the isolated profile and omit development mode', () => {
    const layout = editor.runLayout(path.join(scratch(), 'candidate run'));
    fs.mkdirSync(layout.root, { recursive: true });
    const vsix = path.join(layout.root, 'candidate with spaces.vsix');
    fs.writeFileSync(vsix, 'fixture-vsix');
    const fixture = cliFixture();
    const seen = [];
    const receipt = editor.installVsix(fixture.executable, layout, vsix, {
      platform: process.platform === 'win32' ? 'win32' : 'linux',
      timeoutMs: 1234,
      run: (command, args, options) => {
        seen.push({ command, args, options });
        return { status: 0, stdout: 'installed', stderr: '' };
      },
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].args[0], fixture.cli);
    assert.equal(seen[0].options.cwd, process.platform === 'win32' ? fixture.installation : layout.root);
    assert.equal(seen[0].args[seen[0].args.indexOf('--user-data-dir') + 1], layout.userData);
    assert.equal(seen[0].args[seen[0].args.indexOf('--extensions-dir') + 1], layout.extensions);
    assert.equal(seen[0].args[seen[0].args.indexOf('--install-extension') + 1], receipt.archive);
    assert.equal(seen[0].options.timeout, 1234);
    assert.equal(seen[0].options.env.ARC_HOME, layout.arcHome);
    assert.equal(seen[0].options.env.ARC_MEASURE_BLOCK_AGENTS, '1');
    assert.equal(seen[0].options.env.ELECTRON_RUN_AS_NODE, '1');
    assert.match(receipt.sha256, /^[0-9a-f]{64}$/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(layout.root, 'vsix-install.json'))).stdout, 'installed');
    const args = editor.editorArguments(layout, {
      extensionPath: '/checkout/extension',
      workspace: layout.workspace,
      vsix,
    });
    assert.equal(args.includes('--extensionDevelopmentPath'), false);
    assert.equal(args.includes('/checkout/extension'), false);
    assert.equal(args[args.indexOf('--extensions-dir') + 1], layout.extensions);
    assert.equal(editor.childEnvironment(process.env, layout).ELECTRON_RUN_AS_NODE, undefined);
    assert.throws(
      () =>
        editor.installVsix(fixture.executable, layout, vsix, {
          platform: process.platform === 'win32' ? 'win32' : 'linux',
          run: () => ({ status: 1, stderr: 'installation refused' }),
        }),
      /installation refused/,
    );
  });

  test('an explicit install directory wins over ARC_MEASURE_EDITOR', () => {
    const exists = (file) => file.includes('explicit') || file.includes('named');
    const found = editor.editorExecutable({
      editor: '/explicit',
      environment: { ARC_MEASURE_EDITOR: '/named' },
      platform: 'linux',
      exists,
    });
    assert.equal(found, path.join('/explicit', 'code'));
    assert.equal(
      editor.editorExecutable({ environment: { ARC_MEASURE_EDITOR: 'D:\\named' }, platform: 'win32', exists }),
      path.join('D:\\named', 'Code.exe'),
    );
    assert.throws(
      () => editor.editorExecutable({ environment: {}, platform: 'linux', exists: () => false }),
      /--editor <install directory> or set ARC_MEASURE_EDITOR/,
    );
  });
});

describe('installed editor CLI', () => {
  test('installs and retains the copied archive when the original changes around copying', async () => {
    const fixture = cliFixture();
    const session = editor.createRun({ scratch: scratch(), list: () => [] });
    const candidate = path.join(scratch(), 'changing.vsix');
    fs.writeFileSync(candidate, 'original archive');
    const copy = fs.copyFileSync;
    const replacement = Buffer.from('replacement archive');
    const expected = '63bbb57cb85520ddcf68e67c55b6af7c9b420d82ce195a756a83bc18d9381302';
    let copied;
    let installed;
    const interception = vi.spyOn(fs, 'copyFileSync').mockImplementation((source, destination, flags) => {
      assert.equal(source, candidate);
      assert.equal(flags, fs.constants.COPYFILE_EXCL);
      fs.writeFileSync(candidate, replacement);
      copy(source, destination, flags);
      copied = destination;
      fs.writeFileSync(candidate, 'original changed after copying');
    });
    let receipt;
    try {
      receipt = editor.installVsix(fixture.executable, session.layout, candidate, {
        platform: 'linux',
        run: (_executable, args) => {
          installed = args[args.indexOf('--install-extension') + 1];
          return { status: 0, stdout: 'installed' };
        },
      });
    } finally {
      interception.mockRestore();
    }
    assert.deepEqual(fs.readFileSync(copied), replacement);
    assert.equal(receipt.sha256, expected);
    assert.equal(installed, copied);
    assert.deepEqual(fs.readFileSync(installed), replacement);
    session.manifest.evidence = `${session.layout.root}-evidence`;
    roots.push(session.manifest.evidence);
    const report = await editor.cleanupRun(session.manifest, { list: () => [] });
    assert.equal(report.ok, true, report.errors.join('\n'));
    const archive = path.join(report.evidence.directory, path.relative(session.layout.root, copied));
    assert.deepEqual(fs.readFileSync(archive), replacement);
    const retained = JSON.parse(
      fs.readFileSync(path.join(report.evidence.directory, path.relative(session.layout.root, receipt.receipt))),
    );
    assert.equal(retained.sha256, expected);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(report.evidence.directory, 'vsix-install.json'))).sha256,
      expected,
    );
  });

  test('retains separate Arc and probe installation receipts and digests', () => {
    const fixture = cliFixture();
    const layout = editor.runLayout(scratch());
    const arc = path.join(layout.root, 'arc.vsix');
    const probe = path.join(layout.root, 'probe.vsix');
    fs.writeFileSync(arc, 'Arc archive');
    fs.writeFileSync(probe, 'probe archive');
    const run = (_executable, args, options) => {
      assert.equal(args[args.indexOf('--user-data-dir') + 1], layout.userData);
      assert.equal(args[args.indexOf('--extensions-dir') + 1], layout.extensions);
      assert.equal(options.env.ARC_MEASURE_BLOCK_AGENTS, '1');
      return { status: 0, stdout: args[args.indexOf('--install-extension') + 1] };
    };
    const arcInstall = editor.installVsix(fixture.executable, layout, arc, { run, platform: 'linux' });
    const arcReceipt = fs.readFileSync(path.join(layout.root, 'vsix-install.json'));
    const probeInstall = editor.installVsix(fixture.executable, layout, probe, {
      run,
      platform: 'linux',
      receipt: 'probe-vsix-install.json',
    });
    assert.notEqual(arcInstall.sha256, probeInstall.sha256);
    assert.deepEqual(fs.readFileSync(path.join(layout.root, 'vsix-install.json')), arcReceipt);
    assert.equal(JSON.parse(fs.readFileSync(path.join(layout.root, 'probe-vsix-install.json'))).candidate, probe);
  });

  test('executes the exact Windows launcher selection with spaces and ignores other update directories', () => {
    const relative = 'abcdef0123/resources/app/out/cli.js';
    const fixture = cliFixture(relative);
    writeLauncher(fixture.installation, relative);
    for (const other of ['resources/app/out/cli.js', 'fffffffffe/resources/app/out/cli.js']) {
      const cli = path.join(fixture.installation, other);
      fs.mkdirSync(path.dirname(cli), { recursive: true });
      fs.writeFileSync(cli, 'throw new Error("Wrong editor runtime");');
    }
    const selected = editor.editorCli(fixture.executable, 'win32');
    const result = spawnSync(process.execPath, [selected, 'argument with spaces'], {
      cwd: fixture.installation,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).args, ['argument with spaces']);
    assert.equal(selected, fixture.cli);
    assert.equal(JSON.parse(result.stdout).cwd, fixture.installation);
    fs.rmSync(path.join(fixture.installation, 'resources'), { recursive: true });
    const versionedOnly = spawnSync(process.execPath, [editor.editorCli(fixture.executable, 'win32')], {
      cwd: fixture.installation,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    assert.equal(versionedOnly.status, 0, versionedOnly.stderr);
  });

  test('resolves readable flat Windows, Linux and macOS CLI layouts', () => {
    const flat = cliFixture();
    assert.equal(editor.editorCli(flat.executable, 'win32'), flat.cli);
    writeLauncher(flat.installation);
    assert.equal(editor.editorCli(flat.executable, 'win32'), flat.cli);
    assert.equal(editor.editorCli(path.join(flat.installation, 'code'), 'linux'), flat.cli);
    const bundle = cliFixture('Contents/Resources/app/out/cli.js');
    assert.equal(editor.editorCli(path.join(bundle.installation, 'Contents/MacOS/Electron'), 'darwin'), bundle.cli);
    fs.rmSync(flat.cli);
    assert.throws(() => editor.editorCli(flat.executable, 'linux'), /ENOENT/);
  });

  test('refuses ambiguous, escaping and unsupported launchers even when a flat CLI exists', () => {
    const fixture = cliFixture();
    const launcher = writeLauncher(fixture.installation);
    const original = fs.readFileSync(launcher, 'utf8');
    for (const text of [
      original + '\r\n' + original.split('\r\n')[4],
      original.replace('resources\\app', '..\\resources\\app'),
      original.replace('Code.exe', 'Other.exe'),
      original.replace('resources\\app', 'unselected\\resources\\app'),
      original.replace('setlocal', 'call arbitrary.cmd'),
      'x'.repeat(8193),
    ]) {
      fs.writeFileSync(launcher, text);
      assert.throws(() => editor.editorCli(fixture.executable, 'win32'), /Unsupported|ambiguous/);
    }
  });

  test('keeps the run working directory on Linux and macOS', () => {
    const layout = editor.runLayout(path.join(scratch(), 'run'));
    for (const platform of ['linux', 'darwin']) {
      assert.equal(editor.editorLaunchCwd('/installed/editor', layout, platform), layout.root);
    }
  });

  test.skipIf(process.platform !== 'win32')(
    'installs from a long owned run directory through the selected Windows CLI',
    () => {
      const fixture = cliFixture('abcdef0123/resources/app/out/cli.js');
      writeLauncher(fixture.installation, 'abcdef0123/resources/app/out/cli.js');
      const layout = editor.runLayout(path.join(scratch(), ...Array(6).fill('owned run directory with spaces')));
      fs.mkdirSync(layout.root, { recursive: true });
      assert.ok(layout.root.length > 260);
      const vsix = path.join(layout.root, 'candidate with spaces.vsix');
      fs.writeFileSync(vsix, 'fixture');
      const receipt = editor.installVsix(fixture.executable, layout, vsix, {
        run: (command, args, options) => {
          assert.equal(command, fixture.executable);
          return spawnSync(process.execPath, args, options);
        },
        timeoutMs: 5000,
      });
      const output = JSON.parse(JSON.parse(fs.readFileSync(path.join(layout.root, 'vsix-install.json'))).stdout);
      assert.equal(output.cwd, fixture.installation);
      assert.equal(output.args[output.args.indexOf('--user-data-dir') + 1], layout.userData);
      assert.equal(output.args[output.args.indexOf('--extensions-dir') + 1], layout.extensions);
      assert.equal(output.args[output.args.indexOf('--install-extension') + 1], receipt.archive);
    },
  );

  test.skipIf(process.platform !== 'win32')(
    'refuses an overlong Windows installation directory before spawning',
    () => {
      const installation = path.join(scratch(), ...Array(8).fill('long installation directory'));
      fs.mkdirSync(installation, { recursive: true });
      assert.ok(installation.length > 260);
      assert.throws(
        () => editor.editorLaunchCwd(path.join(installation, 'Code.exe'), editor.runLayout(scratch())),
        /Unsupported VS Code installation directory/,
      );
      assert.throws(() => editor.editorLaunchCwd('relative/Code.exe', editor.runLayout(scratch())), /Unsupported/);
    },
  );
});

describe('disposable probe packaging and evidence', () => {
  test('discovers orphaned physical runs through the scratch alias used for creation', async () => {
    const parent = scratch();
    const target = scratch();
    const link = path.join(parent, 'scratch-alias');
    fs.symlinkSync(target, link, 'junction');
    try {
      const orphan = editor.createRun({ scratch: link, list: () => [] });
      orphan.manifest.driverPid = 4_000_002;
      editor.writeManifest(orphan.layout, orphan.manifest);
      const live = editor.createRun({ scratch: link, list: () => [] });
      const foreign = path.join(target, `${editor.RUN_PREFIX}foreign`);
      fs.mkdirSync(foreign);
      fs.writeFileSync(path.join(foreign, 'keep'), 'foreign bytes');
      fs.writeFileSync(path.join(foreign, 'run.json'), JSON.stringify({ ...orphan.manifest, root: foreign }));
      const malformed = path.join(target, `${editor.RUN_PREFIX}malformed`);
      fs.mkdirSync(malformed);
      fs.writeFileSync(path.join(malformed, 'run.json'), '{');
      const aliasRoot = path.join(link, path.basename(orphan.layout.root));
      assert.throws(() => editor.readManifest(aliasRoot), /does not describe/);
      const runs = editor.abandonedRuns(link, (pid) => pid === process.pid);
      assert.deepEqual(
        runs.map((run) => run.root),
        [orphan.layout.root],
      );
      assert.equal(runs[0].profile, orphan.layout.userData);
      assert.deepEqual(runs[0].processes, orphan.manifest.processes);
      const report = await editor.cleanupRun(runs[0], { list: () => [] });
      assert.equal(report.ok, true, report.errors.join('\n'));
      assert.equal(fs.existsSync(live.layout.root), true);
      assert.equal(fs.readFileSync(path.join(foreign, 'keep'), 'utf8'), 'foreign bytes');
      fs.unlinkSync(link);
      const replacement = scratch();
      fs.symlinkSync(replacement, link, 'junction');
      assert.deepEqual(
        editor.abandonedRuns(link, () => false),
        [],
      );
      assert.equal(fs.existsSync(live.layout.root), true);
      assert.deepEqual(
        editor.abandonedRuns(path.join(parent, 'missing'), () => false),
        [],
      );
    } finally {
      fs.unlinkSync(link);
    }
  });

  test('retains evidence and removes runs created beneath a linked scratch ancestor', async () => {
    const parent = scratch();
    const target = scratch();
    const link = path.join(parent, 'scratch-alias');
    const selected = path.join(link, 'selected scratch');
    const canary = path.join(target, 'foreign.txt');
    fs.writeFileSync(canary, 'foreign bytes');
    fs.symlinkSync(target, link, 'junction');
    try {
      const session = editor.createRun({ scratch: selected, list: () => [] });
      assert.deepEqual(editor.readManifest(session.layout.root), session.manifest);
      const evidence = (session.manifest.evidence = `${session.layout.root}-evidence`);
      const relative = path.join('user-data', 'logs', 'exthost.log');
      const log = path.join(session.layout.root, relative);
      fs.mkdirSync(path.dirname(log), { recursive: true });
      fs.writeFileSync(log, 'isolated log bytes');
      editor.writeManifest(session.layout, session.manifest);
      const report = await editor.cleanupRun(editor.readManifest(session.layout.root), { list: () => [] });
      assert.equal(report.ok, true, report.errors.join('\n'));
      assert.equal(report.removed, true);
      assert.equal(fs.existsSync(session.layout.root), false);
      assert.equal(path.dirname(session.layout.root), fs.realpathSync(selected));
      assert.equal(report.evidence.directory, evidence);
      assert.equal(fs.readFileSync(path.join(evidence, relative), 'utf8'), 'isolated log bytes');
      assert.equal(fs.readFileSync(canary, 'utf8'), 'foreign bytes');
      const manifest = JSON.parse(fs.readFileSync(path.join(evidence, 'run.json')));
      assert.equal(manifest.root, session.layout.root);
      assert.equal(manifest.profile, session.layout.userData);
      const restarted = editor.createRun({ scratch: selected, list: () => [] });
      const other = scratch();
      fs.unlinkSync(link);
      fs.symlinkSync(other, link, 'junction');
      const settled = await editor.cleanupRun(editor.readManifest(restarted.layout.root), { list: () => [] });
      assert.equal(settled.ok, true, settled.errors.join('\n'));
      assert.deepEqual(fs.readdirSync(other), []);
      assert.equal(fs.readFileSync(canary, 'utf8'), 'foreign bytes');
    } finally {
      fs.unlinkSync(link);
    }
  });

  test('rejects linked probe manifests and source ancestors without changing source bytes', async () => {
    for (const ancestor of [true, false]) {
      const owner = scratch();
      const manifest = path.join(owner, 'package.json');
      const bytes = Buffer.from(
        '{"name":"terminal-probe","publisher":"test","version":"0.1.0","engines":{"vscode":"^1.100.0"},"scripts":{"vscode:prepublish":"echo original"}}',
      );
      fs.writeFileSync(manifest, bytes);
      fs.writeFileSync(path.join(owner, 'extension.js'), 'original probe');
      let source = path.join(scratch(), 'probe');
      let link;
      if (ancestor) {
        const originalProbe = path.join(owner, 'probe');
        fs.mkdirSync(originalProbe);
        fs.copyFileSync(manifest, path.join(originalProbe, 'package.json'));
        fs.copyFileSync(path.join(owner, 'extension.js'), path.join(originalProbe, 'extension.js'));
        link = path.dirname(source);
        fs.symlinkSync(owner, path.join(link, 'redirect'), 'junction');
        link = path.join(link, 'redirect');
        source = path.join(link, 'probe');
      } else {
        fs.mkdirSync(source);
        link = path.join(source, 'package.json');
        try {
          fs.symlinkSync(manifest, link, 'file');
        } catch (error) {
          if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
          console.warn(
            'File symbolic-link fixture requires Windows symbolic-link permission. Directory-link coverage still runs.',
          );
          continue;
        }
        fs.writeFileSync(path.join(source, 'extension.js'), 'original probe');
      }
      const session = editor.createRun({ scratch: scratch(), list: () => [] });
      try {
        await assert.rejects(editor.packageProbe(path.resolve(__dirname, '..'), session.layout, source), /is a link/);
        assert.deepEqual(fs.readFileSync(manifest), bytes);
        assert.deepEqual(fs.readFileSync(path.join(source, 'package.json')), bytes);
        assert.equal(fs.readFileSync(path.join(owner, 'extension.js'), 'utf8'), 'original probe');
      } finally {
        fs.unlinkSync(link);
      }
    }
  });

  test('keeps run and foreign bytes when retained evidence destinations redirect, then retries safely', async () => {
    for (const kind of ['ancestor', 'file', 'index']) {
      const session = editor.createRun({ scratch: scratch(), list: () => [] });
      const evidence = (session.manifest.evidence = `${session.layout.root}-evidence`);
      roots.push(evidence);
      const relative = path.join('user-data', 'logs', 'window1', 'exthost.log');
      const log = path.join(session.layout.root, relative);
      fs.mkdirSync(path.dirname(log), { recursive: true });
      const bytes = Buffer.from('isolated log bytes');
      fs.writeFileSync(log, bytes);
      const foreign = scratch();
      const foreignFile = path.join(foreign, kind === 'ancestor' ? 'window1/exthost.log' : 'foreign.log');
      fs.mkdirSync(path.dirname(foreignFile), { recursive: true });
      const original = Buffer.from('foreign bytes');
      fs.writeFileSync(foreignFile, original);
      const link =
        kind === 'ancestor'
          ? path.join(evidence, 'user-data', 'logs')
          : kind === 'file'
            ? path.join(evidence, relative)
            : path.join(evidence, 'retained-files.json');
      fs.mkdirSync(path.dirname(link), { recursive: true });
      try {
        fs.symlinkSync(kind === 'ancestor' ? foreign : foreignFile, link, kind === 'ancestor' ? 'junction' : 'file');
      } catch (error) {
        if (process.platform !== 'win32' || error.code !== 'EPERM' || kind === 'ancestor') throw error;
        console.warn(
          'File symbolic-link fixture requires Windows symbolic-link permission. Directory-link coverage still runs.',
        );
        continue;
      }
      try {
        const report = await editor.cleanupRun(session.manifest, { list: () => [] });
        assert.equal(report.ok, false);
        assert.equal(report.removed, false);
        assert.match(report.errors.join('\n'), /is a link/);
        assert.deepEqual(fs.readFileSync(foreignFile), original);
        assert.deepEqual(fs.readFileSync(log), bytes);
      } finally {
        fs.unlinkSync(link);
      }
      const retry = await editor.cleanupRun(session.manifest, { list: () => [] });
      assert.equal(retry.ok, true, retry.errors.join('\n'));
      assert.deepEqual(fs.readFileSync(path.join(evidence, relative)), bytes);
      const retained = retry.evidence.files.find((entry) => entry.path === relative);
      assert.equal(retained.sha256, require('node:crypto').createHash('sha256').update(bytes).digest('hex'));
      assert.deepEqual(fs.readFileSync(foreignFile), original);
    }
  });

  test('packages probe bytes beneath the run without running source lifecycle scripts', async () => {
    const source = path.join(scratch(), 'probe source');
    fs.mkdirSync(source);
    const marker = path.join(source, 'lifecycle-ran');
    const manifest = {
      name: 'terminal-probe',
      publisher: 'test',
      version: '0.1.0',
      engines: { vscode: '^1.100.0' },
      main: './extension.js',
      activationEvents: ['*'],
      scripts: { 'vscode:prepublish': 'node lifecycle.js' },
    };
    const original = JSON.stringify(manifest);
    fs.writeFileSync(path.join(source, 'package.json'), original);
    fs.writeFileSync(
      path.join(source, 'lifecycle.js'),
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`,
    );
    fs.writeFileSync(path.join(source, 'extension.js'), 'exports.activate = () => {};');
    const session = editor.createRun({ scratch: scratch(), list: () => [] });
    const archive = await editor.packageProbe(path.resolve(__dirname, '..'), session.layout, source);
    assert.equal(path.dirname(archive), session.layout.root);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.readFileSync(path.join(source, 'package.json'), 'utf8'), original);
    const { createRequire } = await import('node:module');
    const extensionRequire = createRequire(path.resolve(__dirname, '../extension/package.json'));
    const yauzl = extensionRequire('yauzl');
    const entries = await new Promise((resolve, reject) => {
      const files = new Map();
      yauzl.open(archive, { lazyEntries: true }, (error, zip) => {
        if (error) return reject(error);
        zip.on('error', reject);
        zip.on('end', () => resolve(files));
        zip.on('entry', (entry) => {
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError) return reject(streamError);
            const chunks = [];
            stream.on('error', reject);
            stream.on('data', (chunk) => chunks.push(chunk));
            stream.on('end', () => {
              files.set(entry.fileName, Buffer.concat(chunks));
              zip.readEntry();
            });
          });
        });
        zip.readEntry();
      });
    });
    assert.equal(entries.get('extension/extension.js').toString(), 'exports.activate = () => {};');
    const packaged = JSON.parse(entries.get('extension/package.json'));
    assert.equal(packaged.name, manifest.name);
    assert.equal(packaged.publisher, manifest.publisher);
    assert.equal(packaged.scripts, undefined);
    const cleanup = await editor.closeIsolatedEditor(session, { list: () => [] });
    assert.equal(cleanup.ok, true);
  });

  test('retains registration, logs and process identities after success and process-settlement failure', async () => {
    for (const running of [false, true]) {
      const session = editor.createRun({ scratch: scratch(), list: () => [] });
      session.manifest.evidence = `${session.layout.root}-evidence`;
      session.manifest.processes = [
        { pid: 991, created: '2026-10-12T04:00:00.000Z', command: editor.commandDigest('fixture running') },
      ];
      editor.writeManifest(session.layout, session.manifest);
      const log = path.join(session.layout.userData, 'logs', 'window1', 'exthost.log');
      fs.mkdirSync(path.dirname(log), { recursive: true });
      fs.writeFileSync(log, 'isolated log');
      const profile = path.join(session.layout.extensions, 'extensions.json');
      fs.writeFileSync(
        profile,
        JSON.stringify([{ identifier: { id: 'glin.arc' } }, { identifier: { id: 'test.terminal-probe' } }]),
      );
      const report = await editor.cleanupRun(session.manifest, {
        platform: 'linux',
        list: () =>
          running
            ? [{ pid: 991, parentPid: 1, created: '2026-10-12T04:00:00.000Z', commandLine: 'fixture running' }]
            : [],
        stop: () => {},
        clock: fakeClock(),
        deadlineMs: 1000,
      });
      const evidence = report.evidence.directory;
      roots.push(evidence);
      assert.equal(report.ok, !running);
      assert.equal(fs.existsSync(session.layout.root), running);
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(evidence, 'run.json'))).processes[0],
        session.manifest.processes[0],
      );
      assert.equal(
        fs.readFileSync(path.join(evidence, path.relative(session.layout.root, log)), 'utf8'),
        'isolated log',
      );
      assert.deepEqual(
        fs.readFileSync(path.join(evidence, 'extensions', 'extensions.json')),
        fs.existsSync(profile)
          ? fs.readFileSync(profile)
          : Buffer.from(
              JSON.stringify([{ identifier: { id: 'glin.arc' } }, { identifier: { id: 'test.terminal-probe' } }]),
            ),
      );
    }
  });

  test('keeps the run and excludes logs reached through a directory link', async () => {
    const session = editor.createRun({ scratch: scratch(), list: () => [] });
    session.manifest.evidence = `${session.layout.root}-evidence`;
    const owner = scratch();
    fs.writeFileSync(path.join(owner, 'owner.log'), 'owner data');
    fs.symlinkSync(owner, path.join(session.layout.userData, 'logs'), 'junction');
    const report = await editor.cleanupRun(session.manifest, { list: () => [] });
    roots.push(session.manifest.evidence);
    assert.equal(report.ok, false);
    assert.equal(report.removed, false);
    assert.match(report.errors.join('\n'), /evidence path is a link/);
    assert.equal(fs.existsSync(path.join(session.manifest.evidence, 'user-data', 'logs', 'owner.log')), false);
    fs.unlinkSync(path.join(session.layout.userData, 'logs'));
    assert.equal(fs.readFileSync(path.join(owner, 'owner.log'), 'utf8'), 'owner data');
  });
});

describe('installed candidate launch', () => {
  test('launches the installed candidate with its disposable probe and refuses live data', async () => {
    const repository = path.join(scratch(), 'installed checkout');
    const extension = path.join(repository, 'extension');
    const playwright = path.join(extension, 'node_modules', 'playwright-core');
    fs.mkdirSync(playwright, { recursive: true });
    fs.writeFileSync(path.join(extension, 'package.json'), JSON.stringify({ name: 'arc', publisher: 'glin' }));
    fs.writeFileSync(
      path.join(playwright, 'index.js'),
      'module.exports = { _electron: { launch: (options) => globalThis.__installedCandidateLaunch(options) } };',
    );
    const installDirectory = path.join(repository, 'editor');
    const executable =
      process.platform === 'win32' ? 'Code.exe' : process.platform === 'darwin' ? 'Contents/MacOS/Electron' : 'code';
    fs.mkdirSync(path.dirname(path.join(installDirectory, executable)), { recursive: true });
    fs.writeFileSync(path.join(installDirectory, executable), '');
    const probeExtension = path.join(repository, 'probe');
    fs.mkdirSync(probeExtension);
    fs.writeFileSync(
      path.join(probeExtension, 'package.json'),
      JSON.stringify({ name: 'terminal-probe', publisher: 'test', version: '0.1.0', engines: { vscode: '^1.100.0' } }),
    );
    fs.writeFileSync(path.join(probeExtension, 'extension.js'), 'probe fixture');
    const session = {};
    let launch;
    let installed = 0;
    let profile;
    const admitted = () => JSON.parse(fs.readFileSync(profile, 'utf8')).map((entry) => entry.identifier.id);
    globalThis.__installedCandidateLaunch = async (options) => {
      launch = options;
      assert.deepEqual(admitted(), ['glin.arc', 'test.terminal-probe']);
      throw new Error('fixture launch stop');
    };
    const options = {
      repository,
      editor: installDirectory,
      scratch: scratch(),
      vsix: 'candidate.vsix',
      probeExtension,
      list: () => [],
      packageDisposableProbe: async (_repository, layout, probe) => {
        const archive = path.join(layout.root, 'probe.vsix');
        fs.writeFileSync(
          archive,
          JSON.stringify({
            manifest: JSON.parse(fs.readFileSync(path.join(probe, 'package.json'), 'utf8')),
            code: fs.readFileSync(path.join(probe, 'extension.js'), 'utf8'),
          }),
        );
        return archive;
      },
      install: (selectedEditor, layout, candidate, installOptions) => {
        assert.equal(selectedEditor, path.resolve(installDirectory, executable));
        installed++;
        profile = path.join(layout.extensions, 'extensions.json');
        const probe = installed === 2 ? JSON.parse(fs.readFileSync(candidate, 'utf8')) : null;
        const identity = probe ? 'test.terminal-probe' : 'glin.arc';
        const target = path.join(layout.extensions, `${identity}-0.1.0`);
        fs.mkdirSync(target);
        fs.writeFileSync(
          path.join(target, 'package.json'),
          JSON.stringify(probe?.manifest ?? { name: 'arc', publisher: 'glin' }),
        );
        if (probe) fs.writeFileSync(path.join(target, 'extension.js'), probe.code);
        const entries = fs.existsSync(profile) ? JSON.parse(fs.readFileSync(profile, 'utf8')) : [];
        entries.push({ identifier: { id: identity }, version: '0.1.0', location: { path: target } });
        fs.writeFileSync(profile, JSON.stringify(entries));
        fs.writeFileSync(path.join(layout.root, installOptions.receipt ?? 'vsix-install.json'), identity);
        return { candidate, sha256: probe ? 'probe-digest' : 'fixture-digest' };
      },
    };
    try {
      await assert.rejects(editor.launchIsolatedEditor({ ...options, liveData: true }, {}), /require isolated data/);
      assert.equal(installed, 0);
      await assert.rejects(editor.launchIsolatedEditor(options, session), /fixture launch stop/);
      assert.equal(installed, 2);
      assert.equal(launch.args.includes('--extensionDevelopmentPath'), false);
      assert.equal(launch.args[launch.args.indexOf('--extensions-dir') + 1], session.layout.extensions);
      assert.equal(launch.env.ELECTRON_RUN_AS_NODE, undefined);
      assert.equal(launch.env.ARC_MEASURE_BLOCK_AGENTS, '1');
      assert.equal(session.manifest.mode, 'installed');
      assert.equal(session.manifest.vsix.sha256, 'fixture-digest');
      assert.equal(session.manifest.probeVsix.sha256, 'probe-digest');
      assert.equal(session.manifest.probeVsix.id, 'test.terminal-probe');
      assert.equal(
        fs.readFileSync(path.join(session.manifest.probeExtension, 'extension.js'), 'utf8'),
        'probe fixture',
      );
      assert.ok(session.manifest.extensionPath.startsWith(session.layout.extensions + path.sep));
      assert.deepEqual(session.manifest.processes, []);
      const log = path.join(session.layout.userData, 'logs', 'launch', 'window1', 'exthost', 'exthost.log');
      fs.mkdirSync(path.dirname(log), { recursive: true });
      fs.writeFileSync(log, 'activation fixture');
      const report = await editor.closeIsolatedEditor(session, { list: () => [] });
      assert.equal(report.ok, true, report.errors.join('\n'));
      assert.equal(fs.existsSync(session.layout.root), false);
      const retained = report.evidence.directory;
      roots.push(retained);
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(retained, 'extensions', 'extensions.json'))).map(
          (entry) => entry.identifier.id,
        ),
        ['glin.arc', 'test.terminal-probe'],
      );
      assert.equal(
        fs.readFileSync(path.join(retained, path.relative(session.layout.root, log)), 'utf8'),
        'activation fixture',
      );
      assert.equal(fs.readFileSync(path.join(retained, 'vsix-install.json'), 'utf8'), 'glin.arc');
      assert.equal(fs.readFileSync(path.join(retained, 'probe-vsix-install.json'), 'utf8'), 'test.terminal-probe');
      assert.equal(JSON.parse(fs.readFileSync(path.join(retained, 'run.json'))).mode, 'installed');
    } finally {
      delete globalThis.__installedCandidateLaunch;
    }
  });
});

// A fake checkout whose playwright-core records the launch, so no editor starts.
function fakeCheckout() {
  const root = path.join(scratch(), 'check out');
  const extension = path.join(root, 'extension');
  const playwright = path.join(extension, 'node_modules', 'playwright-core');
  fs.mkdirSync(path.join(extension, 'dist'), { recursive: true });
  fs.mkdirSync(playwright, { recursive: true });
  fs.writeFileSync(path.join(extension, 'dist', 'extension.js'), '');
  fs.writeFileSync(path.join(extension, 'package.json'), JSON.stringify({ name: 'arc', publisher: 'glin' }));
  fs.writeFileSync(
    path.join(playwright, 'index.js'),
    'module.exports = { _electron: { launch: (options) => globalThis.__isolatedEditorLaunch(options) } };',
  );
  const install = path.join(root, 'editor');
  for (const file of ['Code.exe', 'code', path.join('Contents', 'MacOS', 'Electron')]) {
    fs.mkdirSync(path.dirname(path.join(install, file)), { recursive: true });
    fs.writeFileSync(path.join(install, file), '');
  }
  return { root, install };
}

describe('isolated editor launch', () => {
  test('selects a short physical macOS default and preserves the other platform defaults', () => {
    assert.equal(
      editor.defaultScratch({ platform: 'darwin', temporary: '/var/folders/long/path/T', uid: 501 }),
      path.join('/private/tmp', 'arc-ie-1f5'),
    );
    for (const platform of ['win32', 'linux']) {
      assert.equal(editor.defaultScratch({ platform, temporary: '/configured/temporary' }), '/configured/temporary');
    }
    assert.throws(() => editor.defaultScratch({ platform: 'darwin', uid: null }), /Cannot identify/);
  });

  test('refuses linked, foreign and accessible macOS default scratch directories', () => {
    const parent = scratch();
    const original = fs.lstatSync.bind(fs);
    const uid = original(parent).uid;
    const stat = original(parent);
    const listing = vi.spyOn(fs, 'lstatSync');
    for (const attributes of [
      { mode: 0o40755, uid },
      { mode: 0o40700, uid: uid + 1 },
      { mode: 0o40700, uid, isSymbolicLink: () => true },
      { mode: 0o100700, uid, isDirectory: () => false },
    ]) {
      listing.mockImplementation((location, ...args) =>
        location === parent ? Object.assign(Object.create(stat), attributes) : original(location, ...args),
      );
      assert.throws(() => editor.checkPrivateScratch(parent, uid), /Unsafe isolated editor scratch directory/);
    }
    listing.mockImplementation((location, ...args) =>
      location === parent ? Object.assign(Object.create(stat), { mode: 0o40700, uid }) : original(location, ...args),
    );
    assert.doesNotThrow(() => editor.checkPrivateScratch(parent, uid));
    const canonical = vi.spyOn(fs, 'realpathSync').mockReturnValue(path.join(parent, 'elsewhere'));
    assert.throws(() => editor.checkPrivateScratch(parent, uid), /linked ancestor/);
    canonical.mockRestore();
    listing.mockRestore();
  });

  test('checks the complete main socket filename in UTF-8 bytes at the macOS boundary', () => {
    const suffixBytes = Buffer.byteLength(path.join('p', '1.11-main.sock')) - 1;
    const fits = 'p'.repeat(103 - suffixBytes);
    assert.doesNotThrow(() => editor.checkProfileSocket(fits, 'darwin'));
    assert.throws(() => editor.checkProfileSocket(fits + 'p', 'darwin'), /104-byte socket path.*Omit --scratch/);
    const unicode = fits.slice(0, -1) + 'é';
    assert.equal(unicode.length, fits.length);
    assert.throws(() => editor.checkProfileSocket(unicode, 'darwin'), /104-byte socket path/);
    for (const platform of ['win32', 'linux'])
      assert.doesNotThrow(() => editor.checkProfileSocket('p'.repeat(300), platform));
  });

  test('keeps simulated macOS scratch paths physical and run identifiers short independently of host temp paths', () => {
    const selected = path.resolve('/scratch-alias');
    const parent = path.resolve('/', 'p'.repeat(35));
    const mkdir = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    const canonical = vi.spyOn(fs, 'realpathSync').mockImplementation((location) => {
      assert.equal(location, selected);
      return parent;
    });
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {});
    try {
      const session = editor.createRun({ scratch: selected, platform: 'darwin', list: () => [] });
      assert.equal(path.dirname(session.layout.root), parent);
      assert.match(path.basename(session.layout.root), /^arc-isolated-editor-[0-9a-f]{12}$/);
      assert.ok(Buffer.byteLength(path.join(session.layout.userData, '1.11-main.sock')) <= 103);
      assert.ok(
        mkdir.mock.calls.some(([location, options]) => location === session.layout.root && options.mode === 0o700),
      );
    } finally {
      rename.mockRestore();
      write.mockRestore();
      canonical.mockRestore();
      mkdir.mockRestore();
    }
  });

  test('refuses oversized explicit macOS scratch before making a run', () => {
    const parent = path.join(scratch(), 'é'.repeat(40));
    const session = {};
    assert.throws(
      () => editor.createRun({ scratch: parent, platform: 'darwin', list: () => [] }, session),
      /shorter physical directory/,
    );
    assert.deepEqual(fs.readdirSync(parent), []);
    assert.equal(session.manifest, undefined);
  });

  test.skipIf(process.platform !== 'darwin')(
    'creates a private default macOS run independently of system temporary aliases',
    async () => {
      const temporary = vi.spyOn(os, 'tmpdir').mockReturnValue('/var/folders/long/temporary/alias/T');
      const session = editor.createRun({ list: () => [] });
      roots.push(session.layout.root);
      assert.equal(path.dirname(session.layout.root), editor.defaultScratch());
      assert.doesNotThrow(() => editor.checkPrivateScratch(path.dirname(session.layout.root)));
      assert.ok(Buffer.byteLength(path.join(session.layout.userData, '1.11-main.sock')) <= 103);
      const report = await editor.cleanupRun(session.manifest, { list: () => [] });
      assert.equal(report.ok, true, report.errors.join('\n'));
      temporary.mockRestore();
    },
  );

  test('passes absent scratch through launch and restore', () => {
    const source = fs.readFileSync(path.join(__dirname, 'isolated-editor.mjs'), 'utf8');
    const launch = source.slice(
      source.indexOf('export async function launchIsolatedEditor('),
      source.indexOf('export function recordRunProcesses('),
    );
    assert.equal(/scratch\s*=/.test(launch), false);
    assert.match(launch, /createRun\(\{ scratch, workspace, liveData, list \}/);
    assert.match(
      source,
      /steps\.createRun\(\{ scratch: options\.scratch, workspace: options\.workspace, diagnostics: true \}/,
    );
  });

  test('discovers both macOS default cleanup layouts and preserves explicit scratch selection', async () => {
    const selected = editor.defaultScratch({ platform: 'darwin', uid: 501 });
    const original = fs.existsSync.bind(fs);
    vi.spyOn(fs, 'existsSync').mockImplementation((location) => (location === selected ? false : original(location)));
    const seen = [];
    const dependencies = {
      platform: 'darwin',
      uid: 501,
      discover: (parent) => {
        seen.push(parent);
        return [];
      },
      write: () => {},
    };
    assert.equal(await editor.cleanupCommand({}, dependencies), 0);
    assert.deepEqual(seen, [path.resolve(selected), path.resolve(os.tmpdir())]);
    seen.length = 0;
    const explicit = scratch();
    assert.equal(await editor.cleanupCommand({ scratch: explicit }, dependencies), 0);
    assert.deepEqual(seen, [path.resolve(explicit)]);
    for (const platform of ['win32', 'linux']) {
      seen.length = 0;
      assert.equal(await editor.cleanupCommand({}, { ...dependencies, platform }), 0);
      assert.deepEqual(seen, [path.resolve(os.tmpdir())]);
    }
  });

  test.skipIf(process.platform !== 'win32')('starts a native child with a long owned run directory', async () => {
    const checkout = fakeCheckout();
    const parent = path.join(scratch(), ...Array(6).fill('owned editor run directory'));
    const session = {};
    let result;
    globalThis.__isolatedEditorLaunch = async (options) => {
      assert.ok(session.layout.root.length > 260);
      assert.ok(fs.statSync(session.layout.root).isDirectory());
      result = spawnSync(process.execPath, ['-p', 'process.cwd()'], {
        ...options,
        encoding: 'utf8',
        windowsHide: true,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), checkout.install);
      throw new Error('fixture native child completed');
    };
    try {
      await assert.rejects(
        editor.launchIsolatedEditor(
          { repository: checkout.root, editor: checkout.install, scratch: parent, list: () => [] },
          session,
        ),
        /fixture native child completed/,
      );
      assert.equal(result.status, 0);
      assert.equal(session.manifest.profile, session.layout.userData);
      assert.ok(fs.existsSync(session.layout.manifest));
      assert.deepEqual(session.manifest.processes, []);
    } finally {
      delete globalThis.__isolatedEditorLaunch;
    }
  });

  test('writes the manifest before the editor starts and records the main process after', async () => {
    const checkout = fakeCheckout();
    const parent = path.join(scratch(), 'scratch parent');
    let atLaunch = null;
    let options = null;
    const page = { waitForSelector: async () => {} };
    // The main process passes the profile. Its helper passes none and is found through its parent.
    const list = () => [
      {
        pid: 4_000_001,
        parentPid: 4_000_000,
        created: '2026-10-12T04:00:00.000Z',
        commandLine: `Code.exe --user-data-dir "${options.args[1]}"`,
      },
      { pid: 4_000_002, parentPid: 4_000_001, created: '2026-10-12T04:00:01.000Z', commandLine: 'conhost.exe' },
    ];
    globalThis.__isolatedEditorLaunch = async (launchOptions) => {
      options = launchOptions;
      const [name] = fs.readdirSync(parent);
      atLaunch = JSON.parse(fs.readFileSync(path.join(parent, name, 'run.json'), 'utf8'));
      return {
        // The spawned process is a launcher, and the main process answers with its own PID.
        evaluate: async (callback) => (String(callback).includes('process.pid') ? 4_000_001 : 0),
        process: () => ({ pid: 4_000_000 }),
        firstWindow: async () => page,
        close: async () => {},
      };
    };
    const previous = process.env.ELECTRON_RUN_AS_NODE;
    process.env.ELECTRON_RUN_AS_NODE = '1';
    const session = {};
    try {
      await editor.launchIsolatedEditor(
        { repository: checkout.root, editor: checkout.install, scratch: parent, list },
        session,
      );
    } finally {
      if (previous === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
      else process.env.ELECTRON_RUN_AS_NODE = previous;
      delete globalThis.__isolatedEditorLaunch;
    }
    assert.ok(atLaunch, 'the editor started before the run manifest existed');
    assert.equal(atLaunch.mainPid, null);
    assert.equal(path.isAbsolute(atLaunch.root), true);
    assert.equal(path.dirname(atLaunch.root), path.resolve(parent));
    assert.match(path.basename(atLaunch.root), /^arc-isolated-editor-/);
    assert.equal(atLaunch.profile, path.join(atLaunch.root, 'user-data'));
    assert.equal(atLaunch.driverPid, process.pid);
    assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(options.cwd, process.platform === 'win32' ? checkout.install : session.layout.root);
    assert.equal(options.args[options.args.indexOf('--user-data-dir') + 1], atLaunch.profile);
    const recorded = editor.readManifest(session.layout.root);
    assert.equal(recorded.mainPid, 4_000_001);
    assert.equal(recorded.launcherPid, 4_000_000);
    assert.equal(recorded.mainCreated, '2026-10-12T04:00:00.000Z');
    assert.deepEqual(
      recorded.processes.map((identity) => identity.pid),
      [4_000_002, 4_000_001],
    );
    assert.equal(session.extensionId, 'glin.arc');
    session.list = () => [];
    const report = await editor.closeIsolatedEditor(session, { list: () => [] });
    assert.equal(report.ok, true, report.errors.join('\n'));
    assert.equal(fs.existsSync(session.layout.root), false);
  });
});

describe('isolated editor cleanup', () => {
  // A cleanup over a run directory that exists only in the process table records nothing on disk.
  const fakeRun = () => ({ root: WINDOWS_ROOT, profile: WINDOWS_PROFILE });
  const quiet = { record: () => {}, platform: 'win32', selfPid: 1 };

  test('owns processes that pass the profile to --user-data-dir in any quoting and slash form, and their descendants', () => {
    const owned = editor.ownedProcesses(windowsTable(), WINDOWS_PROFILE, { platform: 'win32', selfPid: 1 });
    assert.deepEqual(owned.map((entry) => entry.pid).sort(), [100, 101, 102, 103]);
    const quoted = {
      pid: 5,
      parentPid: 4,
      created: 'x',
      commandLine: `Code.exe "--user-data-dir=${WINDOWS_PROFILE}\\"`,
    };
    assert.equal(editor.ownedProcesses([quoted], WINDOWS_PROFILE, { platform: 'win32', selfPid: 1 }).length, 1);
  });

  test('does not own a process that names the profile as a file or names a longer path', () => {
    const table = [
      {
        pid: 300,
        parentPid: 4,
        created: '2026-10-12T04:00:00.000Z',
        commandLine: `"C:\\VS Code\\Code.exe" --user-data-dir C:\\Users\\owner\\Code "${WINDOWS_PROFILE}\\User\\settings.json"`,
      },
      { pid: 301, parentPid: 4, created: 'x', commandLine: `Code.exe --user-data-dir="${WINDOWS_PROFILE}2"` },
      {
        pid: 302,
        parentPid: 4,
        created: 'x',
        commandLine: `Code.exe --user-data-dir ${WINDOWS_PROFILE}-old --new-window`,
      },
      { pid: 303, parentPid: 4, created: 'x', commandLine: `Code.exe --extensions-dir=${WINDOWS_PROFILE}` },
      { pid: 304, parentPid: 300, created: '2026-10-12T04:00:01.000Z', commandLine: 'conhost.exe' },
    ];
    assert.deepEqual(editor.ownedProcesses(table, WINDOWS_PROFILE, { platform: 'win32', selfPid: 1 }), []);
    const unix = [
      { pid: 7, parentPid: 1, created: 'x', commandLine: '/usr/share/code/code /tmp/run/user-data/User/settings.json' },
      {
        pid: 8,
        parentPid: 1,
        created: 'x',
        commandLine: '/usr/share/code/code --user-data-dir /tmp/run/user-data-old',
      },
      { pid: 9, parentPid: 1, created: 'x', commandLine: '/usr/share/code/code --user-data-dir /TMP/run/user-data' },
      {
        pid: 10,
        parentPid: 1,
        created: 'x',
        commandLine: '/usr/share/code/code --user-data-dir=/tmp/run/user-data --x',
      },
    ];
    assert.deepEqual(
      editor.ownedProcesses(unix, '/tmp/run/user-data', { platform: 'linux', selfPid: 1 }).map((entry) => entry.pid),
      [10],
    );
  });

  test('a recorded identity matches a process only when its command line matches too', () => {
    const helper = { pid: 9, parentPid: 1, created: '2026-10-12T04:00:02.000Z', commandLine: '/usr/bin/helper --a' };
    const manifest = {};
    editor.rememberProcesses(manifest, [helper]);
    // Unix start times have one-second precision, so a process that reuses the PID in that second has the same start time.
    const reused = { ...helper, commandLine: '/usr/bin/other' };
    const options = { platform: 'linux', selfPid: 1, known: manifest.processes };
    assert.deepEqual(editor.ownedProcesses([reused], '/tmp/run/user-data', options), []);
    assert.deepEqual(editor.ownedProcesses([helper], '/tmp/run/user-data', options), [helper]);
  });

  test('stops descendants before ancestors and only run processes, including after unrelated processes appear', async () => {
    let table = windowsTable();
    const stopped = [];
    const removed = [];
    let present = true;
    const report = await editor.cleanupRun(fakeRun(), {
      ...quiet,
      list: () => table,
      run: fakePowerShell(
        () => table,
        (pid) => {
          stopped.push(pid);
          table = table.filter((entry) => entry.pid !== pid);
          // A new process reuses a stopped PID, and another starts beside it.
          if (pid === 101) {
            table.push({ pid: 101, parentPid: 4, created: '2026-10-12T05:00:00.000Z', commandLine: 'notepad.exe' });
            table.push({ pid: 300, parentPid: 4, created: '2026-10-12T05:00:00.000Z', commandLine: 'Code.exe' });
          }
        },
      ),
      remove: (root) => {
        removed.push(root);
        present = false;
      },
      exists: () => present,
      clock: fakeClock(),
    });
    assert.deepEqual([...stopped].sort(), [100, 101, 102, 103]);
    assert.ok(stopped.indexOf(103) < stopped.indexOf(101) && stopped.indexOf(101) < stopped.indexOf(100), `${stopped}`);
    assert.deepEqual(removed, [WINDOWS_ROOT]);
    assert.deepEqual(report.remaining, []);
    assert.equal(report.ok, true, report.errors.join('\n'));
    assert.deepEqual(table.map((entry) => entry.pid).sort(), [101, 200, 201, 300]);
  });

  // The renderer exits once its child stops, and notepad takes its PID before the same pass reaches it.
  function reuseOnStop(table, notepad) {
    const state = { table, stopped: [] };
    state.stop = (pid) => {
      state.stopped.push(pid);
      state.table = state.table.filter((entry) => entry.pid !== pid);
      if (pid === 103) state.table = state.table.map((entry) => (entry.pid === 101 ? notepad : entry));
    };
    return state;
  }
  const notepad = { pid: 101, parentPid: 4, created: '2026-10-12T05:00:00.000Z', commandLine: 'notepad.exe' };

  test('on Windows, leaves a process alone when its PID is reused while the same pass stops another', async () => {
    const state = reuseOnStop(windowsTable(), notepad);
    const report = await editor.cleanupRun(fakeRun(), {
      ...quiet,
      list: () => state.table,
      run: fakePowerShell(() => state.table, state.stop),
      remove: () => {},
      exists: () => false,
      clock: fakeClock(),
    });
    assert.equal(state.stopped.includes(101), false, `stopped ${state.stopped}`);
    assert.deepEqual([...report.stopped].sort(), [100, 102, 103]);
    assert.deepEqual(report.skipped, [101]);
    assert.ok(state.table.includes(notepad));
    assert.equal(report.ok, true, report.errors.join('\n'));
  });

  test('on other platforms, checks each process again just before its own stop', () => {
    const entries = editor.ownedProcesses(windowsTable(), WINDOWS_PROFILE, { platform: 'win32', selfPid: 1 });
    const state = reuseOnStop(windowsTable(), notepad);
    const report = editor.stopProcesses(entries, {
      platform: 'linux',
      list: ({ pids }) => state.table.filter((entry) => pids.includes(entry.pid)),
      stop: state.stop,
      clock: fakeClock(),
    });
    assert.equal(state.stopped.includes(101), false, `stopped ${state.stopped}`);
    assert.deepEqual([...report.stopped].sort(), [100, 102, 103]);
    assert.deepEqual(report.skipped, [101]);
    assert.ok(state.table.includes(notepad));
  });

  test.skipIf(process.platform !== 'win32')(
    'the Windows stop compares the start time through the process handle before it stops the process',
    async () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      const exited = new Promise((resolve) => child.once('exit', resolve));
      try {
        const [entry] = editor.listProcesses({ pids: [child.pid] });
        const changed = { ...entry, created: '2000-01-01T00:00:00.0000000Z' };
        assert.deepEqual(editor.stopProcesses([changed], { platform: 'win32' }), {
          stopped: [],
          skipped: [child.pid],
          errors: [],
        });
        assert.equal(editor.listProcesses({ pids: [child.pid] }).length, 1);
        assert.deepEqual(editor.stopProcesses([entry], { platform: 'win32' }), {
          stopped: [child.pid],
          skipped: [],
          errors: [],
        });
        await exited;
      } finally {
        child.kill();
      }
    },
    60_000,
  );

  test('records each run process and finds a helper from that record after its ancestors exit', async () => {
    const recorded = [];
    const first = await editor.cleanupRun(fakeRun(), {
      ...quiet,
      record: (manifest) => recorded.push(structuredClone(manifest.processes)),
      list: () => windowsTable(),
      run: fakePowerShell(windowsTable, () => {}),
      remove: () => {},
      exists: () => true,
      clock: fakeClock(),
      deadlineMs: 1_000,
    });
    assert.equal(first.ok, false);
    assert.deepEqual(recorded[0].map((identity) => identity.pid).sort(), [100, 101, 102, 103]);

    // After a crash only the helper remains. It passes no profile and its parent is gone.
    const helper = { pid: 103, parentPid: 101, created: '2026-10-12T04:00:02.000Z', commandLine: 'conhost.exe 0x4' };
    const stranger = { pid: 102, parentPid: 4, created: '2026-10-12T06:00:00.000Z', commandLine: 'notepad.exe' };
    let table = [helper, stranger];
    const stopped = [];
    const report = await editor.cleanupRun(
      { ...fakeRun(), processes: recorded[0] },
      {
        ...quiet,
        list: () => table,
        run: fakePowerShell(
          () => table,
          (pid) => {
            stopped.push(pid);
            table = table.filter((entry) => entry.pid !== pid);
          },
        ),
        remove: () => {},
        exists: () => false,
        clock: fakeClock(),
      },
    );
    assert.equal(report.ok, true, report.errors.join('\n'));
    assert.deepEqual(stopped, [103]);
    assert.deepEqual(table, [stranger]);
  });

  test('keeps the run directory while processes remain after the deadline', async () => {
    const removals = [];
    const report = await editor.cleanupRun(fakeRun(), {
      ...quiet,
      list: () => windowsTable(),
      run: fakePowerShell(windowsTable, () => {}),
      remove: (root) => removals.push(root),
      exists: () => true,
      clock: fakeClock(),
      deadlineMs: 5_000,
    });
    assert.equal(report.ok, false);
    assert.deepEqual(report.remaining.sort(), [100, 101, 102, 103]);
    assert.match(report.errors[0], /^Timed out after 5 s waiting for the run processes to exit\./);
    assert.deepEqual(removals, []);
    assert.equal(report.removed, false);
  });

  test('keeps the run directory when processes cannot be listed, and bounds each listing by the deadline', async () => {
    const removals = [];
    const timeouts = [];
    const report = await editor.cleanupRun(fakeRun(), {
      ...quiet,
      list: ({ timeoutMs }) => {
        timeouts.push(timeoutMs);
        throw new Error('Could not list processes within 5 s.');
      },
      remove: (root) => removals.push(root),
      exists: () => true,
      clock: fakeClock(),
      deadlineMs: 5_000,
    });
    assert.equal(report.ok, false);
    assert.deepEqual(removals, []);
    assert.match(report.errors[0], /Last error: Could not list processes within 5 s\./);
    assert.equal(timeouts[0], 5_000);
    assert.ok(
      timeouts.every((timeout) => timeout >= 0 && timeout <= 5_000),
      `${timeouts}`,
    );
  });

  test('a process listing stops at its timeout', () => {
    const seen = [];
    const run = (command, args, options) => {
      seen.push(options.timeout);
      return { error: Object.assign(new Error(`spawnSync ${command} ETIMEDOUT`), { code: 'ETIMEDOUT' }), status: null };
    };
    for (const platform of ['win32', 'linux']) {
      assert.throws(
        () => editor.listProcesses({ platform, run, timeoutMs: 1_500 }),
        /^Error: Could not list processes within 2 s\.$/,
      );
    }
    assert.deepEqual(seen, [1_500, 1_500]);
    assert.throws(() => editor.listProcesses({ platform: 'win32', run, timeoutMs: 0 }), /No time was left/);
    assert.deepEqual(
      editor.listProcesses({ platform: 'linux', pids: [42], run: () => ({ status: 1, stdout: '' }) }),
      [],
    );
  });

  test('cleans up an interrupted run from its manifest', async () => {
    const parent = path.join(scratch(), 'interrupted parent');
    const layout = editor.runLayout(path.join(parent, `${editor.RUN_PREFIX}abc`));
    fs.mkdirSync(layout.userData, { recursive: true });
    editor.writeManifest(layout, { root: layout.root, profile: layout.userData, driverPid: 4_000_002 });
    const live = editor.runLayout(path.join(parent, `${editor.RUN_PREFIX}live`));
    fs.mkdirSync(live.userData, { recursive: true });
    editor.writeManifest(live, { root: live.root, profile: live.userData, driverPid: process.pid });
    fs.mkdirSync(path.join(parent, `${editor.RUN_PREFIX}no-manifest`));

    const runs = editor.abandonedRuns(parent, (pid) => pid === process.pid);
    assert.deepEqual(
      runs.map((manifest) => manifest.root),
      [layout.root],
    );
    const owner = {
      pid: 77,
      parentPid: 1,
      created: '2026-10-12T04:00:00.000Z',
      commandLine: `Code.exe --user-data-dir ${layout.userData}`,
    };
    let table = [owner, { pid: 78, parentPid: 1, created: null, commandLine: 'Code.exe' }];
    const stop = (pid) => (table = table.filter((entry) => entry.pid !== pid));
    // The run uses this platform's stop, so both the Windows command and the per-process stop are fakes.
    const report = await editor.cleanupRun(editor.readManifest(layout.root), {
      list: ({ pids } = {}) => table.filter((entry) => !pids || pids.includes(entry.pid)),
      stop,
      run: fakePowerShell(() => table, stop),
      clock: fakeClock(),
    });
    assert.equal(report.ok, true, report.errors.join('\n'));
    assert.deepEqual(report.stopped, [77]);
    assert.deepEqual(
      table.map((entry) => entry.pid),
      [78],
    );
    assert.equal(fs.existsSync(layout.root), false);
    assert.equal(fs.existsSync(live.root), true);
  });

  test('refuses a manifest that names a directory other than its own run', () => {
    const parent = path.join(scratch(), 'foreign');
    const layout = editor.runLayout(path.join(parent, `${editor.RUN_PREFIX}x`));
    fs.mkdirSync(layout.root, { recursive: true });
    editor.writeManifest(layout, { root: parent, profile: path.join(parent, 'user-data'), driverPid: 1 });
    assert.throws(() => editor.readManifest(layout.manifest), /does not describe an isolated editor run/);
  });

  test('reads Windows and Unix process lists', () => {
    assert.deepEqual(
      editor.parseWindowsProcesses(
        '{"ProcessId":5,"ParentProcessId":1,"Created":"2026-10-12T04:00:00.0000000Z","CommandLine":null}',
      ),
      [{ pid: 5, parentPid: 1, created: '2026-10-12T04:00:00.0000000Z', commandLine: '' }],
    );
    const [row] = editor.parseUnixProcesses(
      '  42     1 Mon Oct 12 04:00:00 2026 /usr/share/code/code --user-data-dir /tmp/a b\n',
    );
    assert.equal(row.pid, 42);
    assert.equal(row.parentPid, 1);
    assert.equal(row.commandLine, '/usr/share/code/code --user-data-dir /tmp/a b');
    assert.equal(typeof row.created, 'string');
  });
});

describe('isolated editor driver', () => {
  function frame(url, parent = null, prompts = 0) {
    return { url: () => url, parentFrame: () => parent, locator: () => ({ count: async () => prompts }) };
  }

  function frames() {
    const workbench = frame('vscode-file://vscode-app/c:/VS%20Code/workbench.html');
    const other = frame('vscode-webview://aaa/index.html?id=1&extensionId=openai.chatgpt&platform=electron', workbench);
    const otherContent = frame('vscode-webview://aaa/fake.html?id=1', other, 1);
    const arc = frame('vscode-webview://bbb/index.html?id=2&extensionId=glin.arc&platform=electron', workbench);
    const arcContent = frame('vscode-webview://bbb/fake.html?id=2', arc, 1);
    return { list: [workbench, other, otherContent, arc, arcContent], arcContent };
  }

  test('selects the Arc content frame by extension id, not the first webview', async () => {
    const { list, arcContent } = frames();
    assert.deepEqual(editor.arcContentFrames(list, 'glin.arc'), [arcContent]);
    let calls = 0;
    const page = { frames: () => (++calls < 3 ? list.slice(0, 3) : list) };
    assert.equal(await editor.arcFrame(page, { extensionId: 'glin.arc', clock: fakeClock() }), arcContent);
  });

  test('names what it waited for when the Arc panel never appears', async () => {
    const { list } = frames();
    const page = { frames: () => list.slice(0, 3) };
    await assert.rejects(
      editor.arcFrame(page, { extensionId: 'glin.arc', deadlineMs: 2_000, clock: fakeClock() }),
      /^Error: Timed out after 2 s waiting for the glin\.arc panel frame that holds textarea#prompt\.$/,
    );
  });

  test('a wait reports the last error from its check', async () => {
    await assert.rejects(
      editor.waitFor(
        'the workbench',
        () => {
          throw new Error('Target closed');
        },
        { deadlineMs: 1_000, clock: fakeClock() },
      ),
      /Timed out after 1 s waiting for the workbench\. Last error: Target closed/,
    );
  });

  test('reads the command line', () => {
    assert.deepEqual(editor.parseArguments(['run', 'check.mjs', '--screenshot', 'a b.png', '--timeout', '60']), {
      command: 'run',
      target: 'check.mjs',
      screenshot: 'a b.png',
      timeoutSeconds: 60,
      liveData: false,
      allowFocus: false,
    });
    assert.equal(
      editor.parseArguments(['run', '--vsix', 'candidate.vsix', '--probe-extension', 'probe']).vsix,
      'candidate.vsix',
    );
    assert.equal(
      editor.parseArguments(['run', '--vsix', 'candidate.vsix', '--probe-extension', 'probe']).probeExtension,
      'probe',
    );
    assert.throws(() => editor.parseArguments(['drive']), /Choose a command/);
    assert.throws(() => editor.parseArguments(['run', '--timeout', '0']), /positive number/);
    assert.throws(() => editor.parseArguments(['run', '--focus']), /Unknown option: --focus/);
  });
});

describe('isolated editor commands', () => {
  // A launch that writes a real run directory and manifest, then hands over to the test.
  function fakeLaunch(parent, then) {
    return async (_options, session) => {
      const layout = editor.runLayout(path.join(parent, `${editor.RUN_PREFIX}open`));
      fs.mkdirSync(layout.userData, { recursive: true });
      const manifest = { root: layout.root, profile: layout.userData, driverPid: process.pid, processes: [] };
      editor.writeManifest(layout, manifest);
      Object.assign(session, { layout, manifest, list: () => [] });
      await then(session);
    };
  }

  function lastJson(lines) {
    return JSON.parse(lines.join('').trim().split('\n').at(-1));
  }

  test('open cleans up and fails when the workbench never attaches', async () => {
    const parent = path.join(scratch(), 'open failure');
    const lines = [];
    const code = await editor.openCommand(
      {},
      {
        launch: fakeLaunch(parent, async () => {
          throw new Error('Timed out after 90 s waiting for .monaco-workbench.');
        }),
        cleanupOptions: { list: () => [], clock: fakeClock() },
        write: (text) => lines.push(text),
      },
    );
    const outcome = lastJson(lines);
    assert.equal(code, 1);
    assert.equal(outcome.ok, false);
    assert.deepEqual(outcome.errors, ['Timed out after 90 s waiting for .monaco-workbench.']);
    assert.equal(outcome.cleanup.ok, true, outcome.cleanup.errors.join('\n'));
    assert.equal(fs.existsSync(outcome.run), false);
  });

  test('open fails when the editor does not close cleanly', async () => {
    const parent = path.join(scratch(), 'open close error');
    const lines = [];
    const code = await editor.openCommand(
      {},
      {
        launch: fakeLaunch(parent, async (session) => {
          session.app = {
            once: (_event, listener) => listener(),
            close: async () => {
              throw new Error('Target closed');
            },
          };
        }),
        cleanupOptions: { list: () => [], clock: fakeClock() },
        write: (text) => lines.push(text),
      },
    );
    const outcome = lastJson(lines);
    assert.equal(code, 1);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.cleanup.ok, false);
    assert.deepEqual(outcome.cleanup.errors, ['Target closed']);
    assert.equal(fs.existsSync(outcome.run), false);
  });

  test('run reports a failed process record, then closes the editor, cleans up and releases the lock', async () => {
    const parent = path.join(scratch(), 'run record error');
    const lines = [];
    let closed = false;
    let released = false;
    const code = await editor.runCommand(
      { timeoutSeconds: 30 },
      {
        launch: fakeLaunch(parent, async (session) => {
          session.app = { close: async () => (closed = true) };
          // The record write goes to a directory that does not exist, so it fails.
          session.layout = editor.runLayout(path.join(parent, 'missing', `${editor.RUN_PREFIX}gone`));
          throw new Error('Timed out after 30 s waiting for .monaco-workbench.');
        }),
        acquireLock: async () => ({ release: () => (released = true) }),
        cleanupOptions: { list: () => [], clock: fakeClock() },
        write: (text) => lines.push(text),
      },
    );
    const outcome = lastJson(lines);
    assert.equal(code, 1);
    assert.equal(released, true);
    assert.equal(closed, true);
    assert.match(outcome.cleanup.errors[0], /^Could not record the run processes: /);
    assert.equal(outcome.cleanup.removed, true);
    assert.equal(fs.existsSync(path.join(parent, `${editor.RUN_PREFIX}open`)), false);
  });

  test('cleanup of a run directory that is already gone reports no run', async () => {
    const lines = [];
    const missing = path.join(scratch(), `${editor.RUN_PREFIX}gone`);
    assert.equal(await editor.cleanupCommand({ target: missing }, { write: (text) => lines.push(text) }), 0);
    assert.deepEqual(lastJson(lines), []);
  });
});

describe('isolated editor restore check', () => {
  test('refuses installed restore options before creating a run or launching', async () => {
    for (const option of ['--vsix', '--probe-extension']) {
      const parent = scratch();
      await assert.rejects(
        editor.main(['restore', '--baseline', 'baseline', '--scratch', parent, option, 'candidate']),
        /restore takes no/,
      );
      assert.deepEqual(fs.readdirSync(parent), []);
    }
  });

  test('restarts an installed probe on the same profile and preserves prior installation receipts and archives', async () => {
    const checkout = fakeCheckout();
    const cli = cliFixture();
    const session = editor.createRun({ scratch: scratch(), list: () => [] });
    const arc = path.join(scratch(), 'arc.vsix');
    fs.writeFileSync(arc, 'first Arc archive');
    let source = path.join(scratch(), 'probe');
    fs.mkdirSync(source);
    const sourceBytes = Buffer.from(
      JSON.stringify({
        name: 'terminal-probe',
        publisher: 'test',
        version: '0.1.0',
        engines: { vscode: '^1.100.0' },
        main: './extension.js',
        activationEvents: ['*'],
      }),
    );
    fs.writeFileSync(path.join(source, 'package.json'), sourceBytes);
    fs.writeFileSync(path.join(source, 'extension.js'), 'exports.activate = () => {};');
    const install = (_executable, layout, candidate, options) =>
      editor.installVsix(cli.executable, layout, candidate, {
        ...options,
        platform: 'linux',
        run: () => {
          const probe = candidate !== arc;
          const identity = probe ? 'test.terminal-probe' : 'glin.arc';
          const target = path.join(layout.extensions, identity);
          fs.mkdirSync(target, { recursive: true });
          fs.writeFileSync(
            path.join(target, 'package.json'),
            probe ? sourceBytes : JSON.stringify({ name: 'arc', publisher: 'glin' }),
          );
          return { status: 0, stdout: identity };
        },
      });
    const options = {
      repository: checkout.root,
      editor: checkout.install,
      vsix: arc,
      probeExtension: source,
      install,
      allowFocus: true,
      packageDisposableProbe: (_repository, layout, probe) =>
        editor.packageProbe(path.resolve(__dirname, '..'), layout, probe),
    };
    const launches = [];
    globalThis.__isolatedEditorLaunch = async (options) => {
      launches.push(options);
      return {
        evaluate: async () => 5_000_001,
        process: () => ({ pid: 5_000_000 }),
        firstWindow: async () => ({ waitForSelector: async () => {} }),
        close: async () => {},
      };
    };
    try {
      await editor.startEditor(session, options);
      const first = structuredClone({ arc: session.manifest.vsix, probe: session.manifest.probeVsix });
      const prior = [first.arc, first.probe].map((entry) => ({
        ...entry,
        bytes: fs.readFileSync(entry.archive ?? entry.candidate),
        receiptBytes: fs.readFileSync(
          entry.receipt ??
            path.join(session.layout.root, entry === first.arc ? 'vsix-install.json' : 'probe-vsix-install.json'),
        ),
      }));
      await editor.stopEditor(session, { clock: fakeClock() });
      fs.writeFileSync(arc, 'second Arc archive');
      await editor.startEditor(session, options);
      assert.equal(launches.length, 2);
      assert.deepEqual(launches[1].args, launches[0].args);
      assert.notEqual(session.manifest.vsix.archive, first.arc.archive);
      assert.notEqual(session.manifest.probeVsix.candidate, first.probe.candidate);
      assert.notEqual(session.manifest.probeVsix.receipt, first.probe.receipt);
      assert.deepEqual(fs.readFileSync(path.join(source, 'package.json')), sourceBytes);
      for (const entry of prior) {
        assert.deepEqual(fs.readFileSync(entry.archive), entry.bytes);
        assert.deepEqual(fs.readFileSync(entry.receipt), entry.receiptBytes);
      }
      const report = await editor.closeIsolatedEditor(session, { list: () => [] });
      roots.push(report.evidence.directory);
      assert.equal(report.ok, true, report.errors.join('\n'));
      for (const entry of prior) {
        assert.deepEqual(
          fs.readFileSync(path.join(report.evidence.directory, path.relative(session.layout.root, entry.archive))),
          entry.bytes,
        );
        assert.deepEqual(
          fs.readFileSync(path.join(report.evidence.directory, path.relative(session.layout.root, entry.receipt))),
          entry.receiptBytes,
        );
      }
    } finally {
      delete globalThis.__isolatedEditorLaunch;
    }
  });

  const PROFILE_PROCESS = (profile) => ({
    pid: 5_000_001,
    parentPid: 5_000_000,
    created: '2026-10-12T04:00:00.000Z',
    commandLine: `Code.exe --user-data-dir "${profile}"`,
  });

  function fakeEditor(events, state) {
    return async (options) => {
      events.push({ launch: options });
      state.live = true;
      return {
        evaluate: async (callback) => (String(callback).includes('process.pid') ? 5_000_001 : 0),
        process: () => ({ pid: 5_000_000 }),
        firstWindow: async () => ({ waitForSelector: async () => {} }),
        close: async () => {
          events.push('close');
          state.live = false;
        },
      };
    };
  }

  function option(args, name) {
    return args[args.indexOf(name) + 1];
  }

  test('reads the restore command line', () => {
    assert.equal(editor.parseArguments(['restore', '--baseline-commit', 'abc123']).baselineCommit, 'abc123');
    assert.equal(editor.parseArguments(['restore', '--baseline', 'old checkout']).baseline, 'old checkout');
    assert.throws(() => editor.parseArguments(['restore']), /needs one of --baseline/);
    assert.throws(
      () => editor.parseArguments(['restore', '--baseline', 'a', '--baseline-commit', 'b']),
      /needs one of --baseline/,
    );
    assert.throws(() => editor.parseArguments(['restore', 'check.mjs', '--baseline', 'a']), /restore takes no script/);
    assert.throws(() => editor.parseArguments(['run', '--baseline', 'a']), /apply only to restore/);
    assert.throws(() => editor.parseArguments(['restore', '--baseline', 'a', '--live-data']), /takes no --live-data/);
  });

  test('an editor without openPanel gets no state file, so Arc opens no panel of its own and agents stay blocked', () => {
    const layout = editor.runLayout(path.join(scratch(), `${editor.RUN_PREFIX}env`));
    const opens = editor.childEnvironment({}, layout);
    const restores = editor.childEnvironment({}, layout, { openPanel: false });
    assert.equal(opens.ARC_MEASURE_STATE, layout.state);
    assert.equal(restores.ARC_MEASURE_STATE, undefined);
    assert.equal(restores.ARC_MEASURE_BLOCK_AGENTS, '1');
    assert.equal(restores.ARC_HOME, layout.arcHome);
  });

  test('two editors on one run share the profile, extensions, and workspace, and the first has exited before the second starts', async () => {
    const baseline = fakeCheckout();
    const candidate = fakeCheckout();
    const events = [];
    const state = { live: false };
    const session = {};
    editor.createRun({ scratch: path.join(scratch(), 'restore parent'), diagnostics: true }, session);
    session.list = () => (state.live ? [PROFILE_PROCESS(session.layout.userData)] : []);
    globalThis.__isolatedEditorLaunch = fakeEditor(events, state);
    try {
      await editor.startEditor(session, { repository: baseline.root, editor: baseline.install, openPanel: true });
      fs.writeFileSync(path.join(session.layout.userData, 'saved-by-first-editor'), 'tab');
      await editor.stopEditor(session, { clock: fakeClock() });
      await editor.startEditor(session, { repository: candidate.root, editor: candidate.install, openPanel: false });
    } finally {
      delete globalThis.__isolatedEditorLaunch;
    }
    assert.deepEqual(
      events.map((event) => (event === 'close' ? event : 'launch')),
      ['launch', 'close', 'launch'],
    );
    const [first, , second] = events.map((event) => event.launch);
    for (const name of ['--user-data-dir', '--extensions-dir']) {
      assert.equal(option(second.args, name), option(first.args, name));
    }
    assert.equal(second.args.at(-1), first.args.at(-1));
    assert.equal(option(first.args, '--extensionDevelopmentPath'), path.join(baseline.root, 'extension'));
    assert.equal(option(second.args, '--extensionDevelopmentPath'), path.join(candidate.root, 'extension'));
    assert.equal(first.env.ARC_MEASURE_STATE, session.layout.state);
    assert.equal(second.env.ARC_MEASURE_STATE, undefined);
    assert.equal(fs.existsSync(path.join(session.layout.userData, 'saved-by-first-editor')), true);
    const settings = JSON.parse(fs.readFileSync(path.join(session.layout.userData, 'User', 'settings.json'), 'utf8'));
    assert.equal(settings['arc.diagnostics.log'], true);
    assert.equal(editor.readManifest(session.layout.root).extensionPath, path.join(candidate.root, 'extension'));
    const report = await editor.closeIsolatedEditor(session, { list: () => [], clock: fakeClock() });
    assert.equal(report.ok, true, report.errors.join('\n'));
  });

  test('stopping an editor waits for its processes to exit and names the wait when they stay', async () => {
    const session = {};
    editor.createRun({ scratch: path.join(scratch(), 'stop parent') }, session);
    let polls = 0;
    session.app = { close: async () => {} };
    const list = () => (++polls < 3 ? [PROFILE_PROCESS(session.layout.userData)] : []);
    await editor.stopEditor(session, { list, clock: fakeClock() });
    assert.equal(polls, 3);
    assert.equal(session.app, null);
    session.app = { close: async () => {} };
    await assert.rejects(
      editor.stopEditor(session, { list: () => [PROFILE_PROCESS(session.layout.userData)], clock: fakeClock() }),
      /waiting for the editor processes to exit/,
    );
  });

  test('the check fails when the second editor logs only a panel it created itself', async () => {
    const session = { layout: {} };
    const read = () => [{ file: 'arc-2.jsonl', origin: 'created' }];
    await assert.rejects(
      editor.checkRestoredPanel(session, { read, clock: fakeClock() }),
      /restored panel tab was not adopted.*logged only origin created/,
    );
    await assert.rejects(
      editor.checkRestoredPanel(session, { read: () => [], clock: fakeClock() }),
      /logged no panelAdopted record/,
    );
  });

  function restoredPage(typed) {
    let value = '';
    const prompt = {
      count: async () => 1,
      isVisible: async () => true,
      fill: async (text) => (value = text),
      inputValue: async () => typed ?? value,
    };
    const url = (extension) => `vscode-webview://id/index.html?id=1&extensionId=${extension}&platform=electron`;
    const outer = { url: () => url('glin.arc'), parentFrame: () => null };
    const content = {
      url: () => 'vscode-webview://id/fake.html?id=1',
      parentFrame: () => outer,
      locator: () => prompt,
    };
    return { frames: () => [outer, content] };
  }

  test('the check passes on either restored origin and drives the restored panel', async () => {
    for (const origin of ['serializer', 'serializer-replaced']) {
      const session = { layout: {}, extensionId: 'glin.arc', page: restoredPage() };
      const read = (_layout, ignore) => {
        assert.deepEqual([...ignore], ['arc-1.jsonl']);
        return [
          { file: 'arc-2.jsonl', origin: 'created' },
          { file: 'arc-2.jsonl', origin },
        ];
      };
      const outcome = await editor.checkRestoredPanel(session, {
        ignore: new Set(['arc-1.jsonl']),
        read,
        clock: fakeClock(),
      });
      assert.deepEqual(outcome, { origin, log: 'arc-2.jsonl' });
    }
  });

  test('the check fails when the restored panel does not keep typed text', async () => {
    const session = { layout: {}, extensionId: 'glin.arc', page: restoredPage('') };
    await assert.rejects(
      editor.checkRestoredPanel(session, {
        read: () => [{ file: 'a.jsonl', origin: 'serializer' }],
        clock: fakeClock(),
      }),
      /did not keep the text typed/,
    );
  });

  test('reads panelAdopted origins only from logs that the first editor did not write', () => {
    const layout = editor.runLayout(path.join(scratch(), `${editor.RUN_PREFIX}logs`));
    const logs = path.join(layout.arcHome, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    const line = (event, origin) => `${JSON.stringify({ event, origin })}\n`;
    fs.writeFileSync(path.join(logs, 'arc-1.jsonl'), line('panelAdopted', 'created'));
    fs.writeFileSync(
      path.join(logs, 'arc-2.jsonl'),
      line('panelRevealed', 'created') + line('panelAdopted', 'serializer') + '{"event":"panelAdopted"',
    );
    fs.writeFileSync(path.join(logs, 'health-1.jsonl'), line('panelAdopted', 'created'));
    assert.deepEqual([...editor.logFiles(layout)].sort(), ['arc-1.jsonl', 'arc-2.jsonl']);
    assert.deepEqual(editor.panelAdoptions(layout, new Set(['arc-1.jsonl'])), [
      { file: 'arc-2.jsonl', origin: 'serializer' },
    ]);
  });

  test('exports a revision without the repository index or review fixtures, links the dependencies, and builds it', async () => {
    const repository = path.join(scratch(), 'source repo');
    const files = {
      'extension/package.json': '{"name":"arc","publisher":"glin"}',
      'extension/esbuild.mjs':
        "import fs from 'node:fs'; fs.mkdirSync('dist'); fs.writeFileSync('dist/extension.js', 'built');",
      'evals/fixture.txt': 'fixture',
    };
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(repository, name)), { recursive: true });
      fs.writeFileSync(path.join(repository, name), text);
    }
    fs.mkdirSync(path.join(repository, 'extension', 'node_modules'));
    fs.writeFileSync(path.join(repository, 'extension', 'node_modules', 'canary.txt'), 'kept');
    const git = (...args) => {
      const result = spawnSync('git', ['-C', repository, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git('init', '-q');
    git('add', 'extension/package.json', 'extension/esbuild.mjs', 'evals/fixture.txt');
    git('commit', '-q', '-m', 'one');
    const commit = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repository, 'extension', 'esbuild.mjs'), 'throw new Error("working tree edit");');
    const session = {};
    editor.createRun({ scratch: path.join(scratch(), 'export parent') }, session);
    const baseline = await editor.prepareBaseline(session, {
      repository,
      baselineCommit: 'HEAD',
    });
    const tree = path.join(session.layout.root, editor.BASELINE_DIRECTORY);
    assert.deepEqual(baseline, { repository: tree, label: commit });
    assert.equal(fs.readFileSync(path.join(tree, 'extension', 'dist', 'extension.js'), 'utf8'), 'built');
    assert.equal(fs.existsSync(path.join(tree, 'evals')), false);
    assert.equal(fs.readFileSync(path.join(tree, 'extension', 'node_modules', 'canary.txt'), 'utf8'), 'kept');
    assert.equal(git('status', '--porcelain', '--untracked-files=no'), 'M extension/esbuild.mjs');
    await editor.closeIsolatedEditor(session, { list: () => [], clock: fakeClock() });
    assert.equal(fs.readFileSync(path.join(repository, 'extension', 'node_modules', 'canary.txt'), 'utf8'), 'kept');
  });

  // Steps that record their order and leave the real run directory for the cleanup to remove.
  function fakeSteps(parent, calls, overrides = {}) {
    const candidate = fakeCheckout();
    const baselineRoot = fakeCheckout();
    return {
      candidate,
      baselineRoot,
      steps: {
        createRun: (options, session) => {
          calls.push(['createRun', options.diagnostics]);
          editor.createRun({ ...options, scratch: parent, list: () => [] }, session);
        },
        prepareBaseline: async (_session, options) => {
          calls.push(['prepareBaseline', options.baselineCommit, options.repository]);
          return { repository: baselineRoot.root, label: 'baseline-label' };
        },
        startEditor: async (session, options) => {
          calls.push(['startEditor', options.repository, options.openPanel]);
          session.app = { close: async () => calls.push(['close']) };
        },
        waitForPanel: async () => calls.push(['waitForPanel']),
        stopEditor: async (session) => {
          calls.push(['stopEditor']);
          session.app = null;
        },
        logFiles: () => new Set(['arc-1.jsonl']),
        checkRestoredPanel: async (_session, options) => {
          calls.push(['checkRestoredPanel', [...options.ignore]]);
          return { origin: 'serializer', log: 'arc-2.jsonl' };
        },
        ...overrides,
      },
    };
  }

  function lastJson(lines) {
    return JSON.parse(lines.join('').trim().split('\n').at(-1));
  }

  async function runRestore(parent, calls, overrides) {
    const lines = [];
    const fake = fakeSteps(parent, calls, overrides);
    const code = await editor.restoreCommand(
      { timeoutSeconds: 60, repository: fake.candidate.root, editor: fake.candidate.install, baselineCommit: 'abc' },
      {
        work: editor.restoreWork(fake.steps),
        acquireLock: async () => ({ release: () => calls.push(['release']) }),
        cleanupOptions: { list: () => [], clock: fakeClock() },
        write: (text) => lines.push(text),
      },
    );
    return { code, outcome: lastJson(lines), fake };
  }

  test('restore saves the tab with the baseline build, stops that editor, and checks the candidate build on the same run', async () => {
    const calls = [];
    const { code, outcome, fake } = await runRestore(path.join(scratch(), 'restore order'), calls);
    assert.equal(code, 0, JSON.stringify(outcome));
    assert.deepEqual(calls, [
      ['createRun', true],
      ['prepareBaseline', 'abc', path.resolve(fake.candidate.root)],
      ['startEditor', fake.baselineRoot.root, true],
      ['waitForPanel'],
      ['stopEditor'],
      ['startEditor', path.resolve(fake.candidate.root), false],
      ['checkRestoredPanel', ['arc-1.jsonl']],
      ['close'],
      ['release'],
    ]);
    assert.deepEqual(outcome.value, { baseline: 'baseline-label', origin: 'serializer', log: 'arc-2.jsonl' });
    assert.equal(fs.existsSync(outcome.run), false);
  });

  test('a failed check reports its message, closes the editor, removes the run, and releases the lock', async () => {
    const calls = [];
    const { code, outcome } = await runRestore(path.join(scratch(), 'restore failure'), calls, {
      checkRestoredPanel: async () => {
        throw new Error('The restored panel tab was not adopted.');
      },
    });
    assert.equal(code, 1);
    assert.deepEqual(outcome.errors, ['The restored panel tab was not adopted.']);
    assert.equal(outcome.cleanup.ok, true, outcome.cleanup.errors.join('\n'));
    assert.equal(fs.existsSync(outcome.run), false);
    assert.deepEqual(calls.slice(-2), [['close'], ['release']]);
  });

  test('a timeout while the first editor stops does not start the second editor', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const calls = [];
      const fake = fakeSteps(path.join(scratch(), 'restore timeout'), calls);
      let entered;
      const stopping = new Promise((resolve) => (entered = resolve));
      let release;
      const held = new Promise((resolve) => (release = resolve));
      fake.steps.stopEditor = async (session) => {
        calls.push(['stopEditor']);
        entered();
        await held;
        session.app = null;
      };
      const restore = editor.restoreWork(fake.steps);
      let abandoned;
      const lines = [];
      const running = editor.restoreCommand(
        { timeoutSeconds: 60, repository: fake.candidate.root, editor: fake.candidate.install, baselineCommit: 'abc' },
        {
          work: (context) => (abandoned = restore(context)),
          acquireLock: async () => ({ release: () => calls.push(['release']) }),
          cleanupOptions: { list: () => [], clock: fakeClock() },
          write: (text) => lines.push(text),
        },
      );
      await stopping;
      await vi.advanceTimersByTimeAsync(60_000);
      const code = await running;
      release();
      await assert.rejects(abandoned, /The run ended before this step started\./);
      assert.equal(code, 1);
      assert.match(lastJson(lines).errors[0], /^Timed out after 60 s waiting for the run to finish\./);
      assert.equal(calls.filter((call) => call[0] === 'startEditor').length, 1);
      assert.equal(fs.existsSync(lastJson(lines).run), false);
    } finally {
      vi.useRealTimers();
    }
  });

  test('an editor does not start once its run has ended', async () => {
    await assert.rejects(editor.startEditor({ cancelled: true }), /The run ended before this step started\./);
  });

  test('a run that ends during the baseline build stops the build and removes the run directory without following the linked dependencies', async () => {
    const dependencies = path.join(scratch(), 'dependencies');
    fs.mkdirSync(dependencies);
    fs.writeFileSync(path.join(dependencies, 'canary.txt'), 'kept');
    const calls = [];
    const { code, outcome } = await runRestore(path.join(scratch(), 'restore build'), calls, {
      prepareBaseline: async (session) => {
        const tree = path.join(session.layout.root, editor.BASELINE_DIRECTORY);
        fs.mkdirSync(path.join(tree, 'extension'), { recursive: true });
        for (const name of editor.BASELINE_LINKS) {
          fs.mkdirSync(path.dirname(path.join(tree, name)), { recursive: true });
          fs.symlinkSync(dependencies, path.join(tree, name), 'junction');
        }
        session.stopBuild = () => calls.push(['stopBuild']);
        throw new Error('The baseline build failed with exit code 1.');
      },
    });
    assert.equal(code, 1);
    assert.equal(calls.filter((call) => call[0] === 'stopBuild').length, 1);
    assert.equal(outcome.cleanup.ok, true, outcome.cleanup.errors.join('\n'));
    assert.equal(fs.existsSync(outcome.run), false);
    assert.equal(fs.readFileSync(path.join(dependencies, 'canary.txt'), 'utf8'), 'kept');
  });
});
