// @module-tag subprocess
// extension/src/packaging.test.ts
import { beforeAll, test, vi } from 'vitest';
import assert from 'node:assert';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import nativeFs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tempDir } from './temproot.ts';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { buildSync, transformSync } from 'esbuild';
import { inflateRawSync } from 'node:zlib';
import * as vm from 'node:vm';
import ts from 'typescript';
import { browserBundle, exportBrowserAssets } from './panelbundle.ts';
import { BundledTools, readToolPackage } from './bundledtools.ts';
import { TerminalTools, terminalToolPath, type ToolAdmission } from './toolpath.ts';
import { childEnv } from './agenthost.ts';
import { acquireToolLock, waitForToolLock } from './toolownership.ts';
import { declarationSource } from '../test/source-contract.ts';

import { extensionRoot, embeddedHostIdentity } from '../test/packaging.ts';

function builtVersion(): string {
  const identity = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'dist/build-identity.json'), 'utf8'));
  return `${identity.version} (${identity.sourceCommit?.slice(0, 12) ?? 'unknown'}${identity.dirty ? '-dirty' : ''})`;
}

beforeAll(() => {
  const build = spawnSync(process.execPath, ['esbuild.mjs'], {
    cwd: extensionRoot,
    encoding: 'utf8',
  });
  assert.ifError(build.error);
  assert.equal(build.status, 0, `extension build failed:\n${build.stderr}`);
  assert.ok(
    fs.statSync(path.join(extensionRoot, 'dist', 'extension.js')).size < 10_000_000,
    'the extension bundle exceeds the packaging size budget',
  );
});

test('build identity covers host, browser, worker, and version inputs', () => {
  const sourceInputs = (entry: string) =>
    Object.keys(
      buildSync({
        absWorkingDir: extensionRoot,
        entryPoints: [entry],
        bundle: true,
        platform: 'node',
        write: false,
        metafile: true,
        external: ['vscode'],
        define: {
          PANEL_CSS: '""',
          PANEL_JS: '""',
          PANEL_DEV_SERVER_URL: 'null',
          PROGRESSIVE_WORKER_BROTLI: '""',
          EXTENSION_VERSION: '"fixture"',
        },
      }).metafile.inputs,
    );
  const inputs = [
    ...new Set(
      [
        ...sourceInputs('src/extension.ts'),
        ...sourceInputs('src/progressiveworker-entry.ts'),
        ...sourceInputs('../cli/src/main.ts'),
        ...sourceInputs('src/bundledsetup.ts'),
        ...browserBundle().inputs,
        ...exportBrowserAssets().inputs,
        'src/webview/panel.css',
        'package.json',
        'esbuild.mjs',
        'src/panelbundle.ts',
        'resources/windowpipe.exe',
        'resources/windowpipe.json',
        '../scripts/windowpipe-build.mjs',
        '../scripts/source-identity.mjs',
        'scripts/bundled-tools.mjs',
        '../LICENSE',
        '../plugins/arc-hooks/LICENSE',
        ...fs
          .readdirSync(path.join(extensionRoot, '../cli/skills/arc-sessions'), { recursive: true })
          .map(String)
          .filter((file) => fs.statSync(path.join(extensionRoot, '../cli/skills/arc-sessions', file)).isFile())
          .map((file) => '../cli/skills/arc-sessions/' + file),
        ...Object.keys(readToolPackage(path.join(extensionRoot, 'dist')).payload.files)
          .filter((file) => file.startsWith('plugin/') && file !== 'plugin/LICENSE')
          .map((file) => '../plugins/arc-hooks/' + file.slice(7)),
      ].map((file) => path.relative(extensionRoot, path.resolve(extensionRoot, file)).split(path.sep).join('/')),
    ),
  ].sort();
  const expected = createHash('sha256')
    .update(
      inputs
        .map((file) => {
          const hash = createHash('sha256')
            .update(fs.readFileSync(path.join(extensionRoot, file)))
            .digest('hex');
          return `${file}:${hash}`;
        })
        .join('\n'),
    )
    .digest('hex');
  const identity = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'dist/build-identity.json'), 'utf8'));
  assert.equal(identity.inputsSha256, expected);
  for (const [field, file] of [
    ['exportViewerScriptSha256', 'export-viewer.js'],
    ['exportViewerStylesheetSha256', 'export-viewer.css'],
  ]) {
    assert.equal(
      identity[field],
      createHash('sha256')
        .update(fs.readFileSync(path.join(extensionRoot, 'dist', file)))
        .digest('hex'),
    );
  }
  const embedded = embeddedHostIdentity(path.join(extensionRoot, 'dist/extension.js'));
  assert.equal(embedded.sourceCommit, identity.sourceCommit);
  assert.equal(embedded.dirty, identity.dirty);
  assert.ok(typeof embedded.builtAt === 'number' && embedded.builtAt > 0);
  assert.equal(embedded.unavailable, undefined);
  assert.equal(identity.version, JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8')).version);
  for (const [field, args] of [
    ['sourceCommit', ['rev-parse', 'HEAD']],
    ['dirty', ['status', '--porcelain']],
  ] as const) {
    const result = spawnSync('git', [...args], { cwd: extensionRoot, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(identity[field], field === 'dirty' ? result.stdout.trim() !== '' : result.stdout.trim());
  }
});

test('the canonical session skill ships as regular exact files with independent build identity', () => {
  const source = path.join(extensionRoot, '../cli/skills/arc-sessions');
  const dist = path.join(extensionRoot, 'dist');
  const payload = readToolPackage(dist).payload;
  const expected = fs
    .readdirSync(source, { recursive: true })
    .map(String)
    .filter((file) => fs.lstatSync(path.join(source, file)).isFile())
    .map((file) => file.split(path.sep).join('/'))
    .sort();
  assert.ok(expected.includes('SKILL.md'));
  assert.ok(expected.includes('compaction.md'), 'the reference files ship beside SKILL.md');
  assert.deepEqual(
    Object.keys(payload.files)
      .filter((file) => file.startsWith('skills/'))
      .sort(),
    expected.map((file) => 'skills/arc-sessions/' + file),
  );
  for (const relative of expected) {
    const file = path.join(dist, 'tools/skills/arc-sessions', relative);
    assert.equal(fs.lstatSync(file).isFile(), true);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
    const bytes = fs.readFileSync(path.join(source, relative));
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal(
      payload.files['skills/arc-sessions/' + relative].sha256,
      createHash('sha256').update(bytes).digest('hex'),
    );
  }
});

test('the extension package contains exactly the intended files', () => {
  const vsce = path.join(extensionRoot, 'node_modules', '@vscode', 'vsce', 'vsce');
  const result = spawnSync(process.execPath, [vsce, 'ls', '--no-dependencies'], {
    cwd: extensionRoot,
    encoding: 'utf8',
  });

  assert.ifError(result.error);
  assert.equal(result.status, 0, `vsce ls failed:\n${result.stderr}`);
  const packaged = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
  assert.deepEqual(
    packaged,
    [
      'LICENSE',
      'dist/build-identity.json',
      'dist/extension.js',
      'dist/cli.cjs',
      'dist/setup.cjs',
      'dist/export-viewer.js',
      'dist/export-viewer.css',
      'dist/windowpipe.exe',
      'dist/bin/arc',
      'dist/bin/arc.cmd',
      ...Object.keys(readToolPackage(path.join(extensionRoot, 'dist')).payload.files).map(
        (file) => 'dist/tools/' + file,
      ),
      'package.json',
    ].sort(),
    'the VSIX candidate list changed; review the new file and update this allowlist only when it belongs',
  );
});

const launcherShells =
  process.platform === 'win32'
    ? [
        { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c'] },
        {
          command: path.join(
            process.env.SystemRoot ?? 'C:/Windows',
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe',
          ),
          args: ['-NoProfile', '-EncodedCommand'],
        },
        {
          command:
            process.env.GIT_BASH_PATH ??
            path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git', 'bin', 'bash.exe'),
          args: ['--noprofile', '--norc', '-c'],
        },
      ]
    : [
        { command: '/bin/sh', args: ['-c'] },
        { command: 'bash', args: ['--noprofile', '--norc', '-c'] },
      ];

test.each(launcherShells)(
  'bare arc launchers preserve arguments, stdin, exit status, and window targeting with spaced paths ($command)',
  async (selectedShell) => {
    const root = tempDir('arc-launchers-');
    const tools = new BundledTools(
      readToolPackage(path.join(extensionRoot, 'dist')),
      path.join(root, 'software with spaces'),
    );
    const installed = tools.stage();
    const bin = path.join(installed, 'launchers');
    const editor = path.join(root, 'editor with spaces', process.platform === 'win32' ? 'Code.exe' : 'editor');
    fs.mkdirSync(path.dirname(editor));
    fs.copyFileSync(process.execPath, editor);
    fs.chmodSync(editor, 0o755);
    const bundle = path.join(installed, 'cli/arc.cjs');
    const transcript = path.join(root, 'session with spaces.jsonl');
    fs.writeFileSync(
      transcript,
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-09-26T00:00:01Z',
        message: {
          id: 'request-1',
          model: 'claude-opus-5',
          role: 'assistant',
          content: [],
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      }) + '\n',
    );
    const env = childEnv(
      process.env,
      { ELECTRON_RUN_AS_NODE: '0', ARC_HOME: path.join(root, 'empty home') },
      undefined,
      undefined,
      {
        directory: bin,
        editorExecutable: editor,
        windowId: 'this-window',
      },
    );
    env.ELECTRON_RUN_AS_NODE = '0';
    const shells = [selectedShell];
    const values = new Map<string, { type: 'append' | 'replace'; value: string }>();
    const collection = {
      persistent: true,
      description: undefined as unknown,
      clear: () => values.clear(),
      append: (key: string, value: string) => values.set(key, { type: 'append', value }),
      replace: (key: string, value: string) => values.set(key, { type: 'replace', value }),
    };
    const activation = declarationSource(fs.readFileSync(path.join(__dirname, 'extension.ts'), 'utf8'), 'activate');
    const start = activation.indexOf('const privateTools');
    const end = activation.indexOf('const spawner');
    assert.ok(start >= 0 && end > start);
    const compiled = ts.transpileModule(activation.slice(start, end), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const subscriptions: TerminalTools[] = [];
    const scope = {
      TerminalTools,
      context: {
        environmentVariableCollection: collection,
        subscriptions,
        extensionPath: extensionRoot,
        extensionMode: 1,
      },
      vscode: { workspace: { isTrusted: true, workspaceFolders: [] }, ExtensionMode: { Development: 2 } },
      toolRoot: () => path.join(root, 'software with spaces'),
      prepareEditorCommands: async () => bin,
      path,
      os: { hostname: () => 'fixture-host' },
      process: { execPath: editor },
    };
    await vm.runInNewContext('(async () => {' + compiled + '})()', scope);
    try {
      await vi.waitFor(() => assert.equal(values.size, 2, 'activation did not publish terminal commands'));
      for (const casing of process.platform === 'win32' ? ['PATH', 'Path', 'path'] : ['PATH']) {
        const terminalEnv: NodeJS.ProcessEnv = {};
        for (const [key, value] of Object.entries(process.env)) {
          if (!/^(PATH|ARC_|ELECTRON_RUN_AS_NODE)$/i.test(key) && !key.startsWith('ARC_')) terminalEnv[key] = value;
        }
        terminalEnv[casing] =
          process.platform === 'win32'
            ? path.dirname(process.env.ComSpec ?? 'C:/Windows/System32/cmd.exe')
            : '/usr/bin:/bin';
        for (const [key, mutation] of values) {
          const actual =
            process.platform === 'win32'
              ? (Object.keys(terminalEnv).find((name) => name.toLowerCase() === key.toLowerCase()) ?? key)
              : key;
          terminalEnv[actual] =
            mutation.type === 'append' ? (terminalEnv[actual] ?? '') + mutation.value : mutation.value;
        }
        assert.equal(terminalEnv.ARC_WINDOW, undefined);
        assert.equal(terminalEnv.ELECTRON_RUN_AS_NODE, undefined);
        for (const shell of shells) {
          const command = 'arc --version';
          const script = shell.args.includes('-EncodedCommand')
            ? Buffer.from(command, 'utf16le').toString('base64')
            : command;
          const result = spawnSync(shell.command, [...shell.args, script], {
            cwd: root,
            env: terminalEnv,
            encoding: 'utf8',
            windowsVerbatimArguments: shell.args.includes('/c'),
          });
          assert.ifError(result.error);
          assert.equal(result.status, 0, `${shell.command} (${casing}): ${result.stderr}`);
          assert.equal(result.stdout.trim(), builtVersion());
        }
      }
    } finally {
      subscriptions.forEach((owner) => owner.dispose());
    }
    for (const shell of shells) {
      const run = (command: string, input?: string) => {
        const script = shell.args.includes('-EncodedCommand')
          ? Buffer.from(command, 'utf16le').toString('base64')
          : command;
        const result = spawnSync(shell.command, [...shell.args, script], {
          cwd: root,
          env,
          input,
          encoding: 'utf8',
          windowsVerbatimArguments: shell.args.includes('/c'),
        });
        assert.ifError(result.error);
        return result;
      };
      const version = run('arc --version');
      assert.equal(version.status, 0, `${shell.command}: ${version.stderr}`);
      assert.equal(version.stdout.trim(), builtVersion());
      const windows = run('arc windows --json');
      assert.equal(windows.status, 0, windows.stderr);
      assert.deepEqual(JSON.parse(windows.stdout), { version: 1, windows: [], complete: true });
      const status = run('arc statusline --json', '{}');
      assert.equal(status.status, 0, status.stderr);
      assert.equal(JSON.parse(status.stdout).schemaVersion, 1);
      const cost = run(`arc cost "${transcript.replaceAll('\\', '/')}" --source-only --by-model --json`);
      assert.equal(cost.status, 0, cost.stderr);
      const report = JSON.parse(cost.stdout);
      assert.equal(report.schemaVersion, 2);
      assert.equal(report.parent.requests, 1);
      assert.equal(report.parent.modelCosts[0].model, 'claude-opus-5');
      assert.match(report.buildCommit, /^[0-9a-f]{40}$/);
      const failure = run('arc "unknown command"');
      assert.equal(failure.status, 1, failure.stderr);
      assert.match(failure.stderr, /Unknown command: unknown command/);
    }
    fs.writeFileSync(
      bundle,
      'console.log(JSON.stringify({node:process.env.ELECTRON_RUN_AS_NODE,window:process.env.ARC_WINDOW,args:process.argv.slice(2)}));',
    );
    for (const shell of shells) {
      const command = 'arc "argument with spaces"';
      const script = shell.args.includes('-EncodedCommand')
        ? Buffer.from(command, 'utf16le').toString('base64')
        : command;
      const result = spawnSync(shell.command, [...shell.args, script], {
        cwd: root,
        env,
        encoding: 'utf8',
        windowsVerbatimArguments: shell.args.includes('/c'),
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { node: '1', window: 'this-window', args: ['argument with spaces'] });
    }
  },
);

test.skipIf(process.platform !== 'win32')(
  'long private Windows launchers preserve terminal commands and matching path arguments',
  async ({ signal }) => {
    const root = tempDir('arc-long-terminal-');
    const software = path.join(root, 'long software '.repeat(8).trim(), 'long software '.repeat(8).trim());
    const tools = new BundledTools(readToolPackage(path.join(extensionRoot, 'dist')), software);
    const installed = tools.stage();
    const bin = path.join(installed, 'launchers');
    const launcher = path.join(bin, 'arc.cmd');
    assert.ok(launcher.length > 260);
    const editor = path.join(root, 'editor with spaces', 'Code.exe');
    fs.mkdirSync(path.dirname(editor));
    fs.copyFileSync(process.execPath, editor);
    const values = new Map<string, string>();
    const owner = new TerminalTools(
      {
        persistent: true,
        description: undefined,
        clear: () => values.clear(),
        append: (key, value) => values.set(key, value),
        replace: (key, value) => values.set(key, value),
      },
      () => ({ root: software, identity: 'fixture' }),
      async () => bin,
      editor,
    );
    try {
      await owner.refresh();
      const commands = owner.current('this-window');
      const delivered = fs.statSync(commands.directory, { bigint: true });
      const admitted = fs.statSync(bin, { bigint: true });
      assert.equal(delivered.dev, admitted.dev);
      assert.equal(delivered.ino, admitted.ino);
      const env = childEnv(process.env, { ARC_HOME: path.join(root, 'empty home') }, undefined, undefined, commands);
      const terminalEnv = { ...env };
      delete terminalEnv.ARC_WINDOW;
      const powershell = path.join(
        process.env.SystemRoot ?? 'C:/Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      );
      const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
      const argumentsToCheck = [
        launcher,
        commands.directory + '\\arc.cmd',
        'argument with spaces',
        '--arc-launcher-arguments',
      ];
      const invocations = [
        "'{}' | arc statusline --json",
        "'{invalid' | arc statusline --json",
        'arc help',
        ...argumentsToCheck.flatMap((first) => [
          `arc ${quote(first)}`,
          `& $env:ComSpec /d /c arc ${quote('"' + first + '"')}`,
        ]),
        '& $env:ComSpec /d /c "arc windows --json"',
      ];
      // One shell runs every invocation. Each command keeps its own output and exit status.
      const script = `
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
${invocations
  .map(
    (command) => `
[pscustomobject]@{command=${quote(command)};state='running'} | ConvertTo-Json -Compress
$captured = & { ${command} } 2>&1
$status = $LASTEXITCODE
$output = ($captured | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] } | ForEach-Object { $_.ToString() }) -join "\n"
$errors = ($captured | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } | ForEach-Object { $_.ToString() }) -join "\n"
[pscustomobject]@{command=${quote(command)};status=$status;stdout=$output;stderr=$errors} | ConvertTo-Json -Compress
`,
  )
  .join('')}
`;
      const batch = await promisify(execFile)(
        powershell,
        ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        {
          cwd: root,
          env: terminalEnv,
          encoding: 'utf8',
          timeout: 25_000,
          signal,
        },
      ).catch((error: Error & { stdout?: string; stderr?: string }) => {
        assert.fail(`${error.message}\nstdout:\n${error.stdout ?? ''}\nstderr:\n${error.stderr ?? ''}`);
      });
      const results = batch.stdout
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as { status?: number; stdout: string; stderr: string })
        .filter((result) => result.status !== undefined);
      assert.equal(results.length, invocations.length);
      const [status, invalid, help] = results;
      assert.equal(status.status, 0, status.stderr);
      assert.equal(JSON.parse(status.stdout).schemaVersion, 1);
      assert.equal(invalid.status, 1, invalid.stderr);
      assert.match(invalid.stderr, /Claude status input is not valid JSON/);
      assert.equal(help.status, 0, help.stderr);
      assert.match(help.stdout, /statusline/);
      const cliPath = path.join(extensionRoot, 'dist/cli.cjs');
      const cliSource = fs.readFileSync(cliPath, 'utf8');
      for (const [index, first] of argumentsToCheck.entries()) {
        for (const result of results.slice(3 + index * 2, 5 + index * 2)) {
          assert.equal(result.status, 1, result.stderr);
          assert.ok(result.stderr.includes(`Unknown command: ${first}`), result.stderr);
        }
        // The standalone bundle receives the same argument without a launcher.
        let stderr = '';
        const cliProcess = {
          ...process,
          argv: [process.execPath, cliPath, first],
          env,
          exitCode: 0,
          stderr: {
            write: (text: string) => {
              stderr += text;
            },
          },
          stdout: { write: () => {} },
        };
        const module = { exports: {} };
        await vm.runInNewContext(cliSource, {
          module,
          exports: module.exports,
          require: createRequire(cliPath),
          __dirname: path.dirname(cliPath),
          __filename: cliPath,
          process: cliProcess,
          Buffer,
          URL,
          TextDecoder,
          setTimeout,
          clearTimeout,
        });
        assert.equal(cliProcess.exitCode, 1, stderr);
        assert.ok(stderr.includes(`Unknown command: ${first}`), stderr);
      }
      const child = results.at(-1)!;
      assert.equal(child.status, 0, child.stderr);
      assert.deepEqual(JSON.parse(child.stdout), { version: 1, windows: [], complete: true });
      assert.equal(values.get('Path'), ';' + commands.directory);
    } finally {
      owner.dispose();
    }
  },
);

test('packaging patches the requested archive for overrides, equals options, and target defaults', () => {
  const outputDir = tempDir('arc-output-options-');
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));
  const targetName = `${manifest.name}-linux-x64-${manifest.version}.vsix`;
  const defaultArchive = path.join(extensionRoot, targetName);
  const previous = fs.existsSync(defaultArchive) ? fs.readFileSync(defaultArchive) : null;
  const stale = path.join(outputDir, 'stale.vsix');
  const seeded = spawnSync(
    process.execPath,
    ['scripts/package.mjs', '--no-dependencies', '--allow-missing-repository', '-o', stale],
    { cwd: extensionRoot, encoding: 'utf8' },
  );
  assert.ifError(seeded.error);
  assert.equal(seeded.status, 0, seeded.stderr);
  const checked = spawnSync(process.execPath, ['scripts/check-vsix.mjs', stale], {
    cwd: extensionRoot,
    encoding: 'utf8',
  });
  assert.ifError(checked.error);
  assert.equal(checked.status, 0, `VSIX inspection failed:\n${checked.stderr}`);
  assert.doesNotMatch(
    seeded.stdout,
    /^The file extension\/dist\/extension\.js is large \([^)]+\)$/m,
    "the package command printed VSCE's single-bundle size notice",
  );
  const staleBytes = fs.readFileSync(stale);
  fs.utimesSync(stale, new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'));
  const staleModified = fs.statSync(stale).mtimeMs;
  const cases = [
    { args: ['-o', stale, '-o', path.join(outputDir, 'final.vsix')], archive: path.join(outputDir, 'final.vsix') },
    {
      args: ['-o', stale, `--out=${path.join(outputDir, 'equals.vsix')}`],
      archive: path.join(outputDir, 'equals.vsix'),
    },
    { args: ['--target=linux-x64'], archive: defaultArchive },
    { args: ['--target', 'linux-x64', '--out', outputDir], archive: path.join(outputDir, targetName) },
  ];
  try {
    for (const [index, item] of cases.entries()) {
      const result = spawnSync(
        process.execPath,
        ['scripts/package.mjs', '--no-dependencies', '--allow-missing-repository', ...item.args],
        { cwd: extensionRoot, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: index === 1 ? 'true' : '' } },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      const checked = spawnSync(process.execPath, ['scripts/check-vsix.mjs', item.archive], {
        cwd: extensionRoot,
        encoding: 'utf8',
      });
      assert.ifError(checked.error);
      assert.equal(checked.status, 0, checked.stderr);
      assert.deepEqual(fs.readFileSync(stale), staleBytes);
      assert.equal(fs.statSync(stale).mtimeMs, staleModified, 'packaging rewrote the stale archive');
    }
  } finally {
    if (previous) fs.writeFileSync(defaultArchive, previous);
    else if (fs.existsSync(defaultArchive)) fs.unlinkSync(defaultArchive);
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('installed absolute commands run offline after their extension payload disappears and ignore caller software roots', async () => {
  const root = tempDir('arc-durable-commands-');
  const dist = path.join(root, 'extension payload');
  fs.cpSync(path.join(extensionRoot, 'dist'), dist, { recursive: true });
  const tools = new BundledTools(readToolPackage(dist), path.join(root, 'software with spaces & marks'));
  const signal = new AbortController().signal;
  const absolute = await tools.installCommands(process.execPath, signal);
  assert.deepEqual(fs.readdirSync(path.dirname(absolute)).sort(), ['.arc-commands.json', 'arc', 'arc.cmd', 'run.cjs']);
  fs.renameSync(dist, dist + '.unavailable');
  const env = {
    ...process.env,
    ARC_HOME: path.join(root, 'data only'),
    CLAUDE_CONFIG_DIR: path.join(root, 'no claude'),
    PATH: '',
    ARC_WINDOW: 'originating-window',
    ELECTRON_RUN_AS_NODE: undefined,
  };
  const shells =
    process.platform === 'win32'
      ? [
          {
            command: process.env.ComSpec ?? 'C:/Windows/System32/cmd.exe',
            args: ['/d', '/s', '/c'],
            quote: (value: string) => '"' + value + '"',
          },
          {
            command: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
            args: ['-NoProfile', '-EncodedCommand'],
            quote: (value: string) => "& '" + value.replaceAll("'", "''") + "'",
          },
        ]
      : [{ command: '/bin/sh', args: ['-c'], quote: (value: string) => "'" + value.replaceAll("'", "'\\''") + "'" }];
  for (const shell of shells) {
    const run = (args: string, input = '', command = absolute) => {
      const line = shell.quote(command) + ' ' + args;
      const script = shell.args.includes('-EncodedCommand')
        ? Buffer.from(line, 'utf16le').toString('base64')
        : shell.args.includes('/s')
          ? '"' + line + '"'
          : line;
      return spawnSync(shell.command, [...shell.args, script], {
        cwd: root,
        env,
        input,
        encoding: 'utf8',
        windowsVerbatimArguments: shell.args.includes('/c'),
      });
    };
    const version = run('--version');
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), builtVersion());
    const status = run('statusline --json', '{}');
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).schemaVersion, 1);
    const invalid = run('--invalid-option');
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /invalid|unknown|Unknown|unrecognized/i);
  }
  assert.equal(fs.existsSync(path.join(env.CLAUDE_CONFIG_DIR, 'plugins')), false);
});

test('damaged bundled bytes and unfamiliar installed files preserve the previous command selection', async () => {
  const root = tempDir('arc-damaged-payload-');
  const dist = path.join(root, 'extension');
  fs.cpSync(path.join(extensionRoot, 'dist'), dist, { recursive: true });
  const tools = new BundledTools(readToolPackage(dist), path.join(root, 'software'));
  const signal = new AbortController().signal;
  await tools.installCommands(process.execPath, signal);
  const active = fs.readFileSync(path.join(tools.tools, 'active.json'));
  const identityPath = path.join(dist, 'build-identity.json');
  const identityBytes = fs.readFileSync(identityPath);
  const identity = JSON.parse(identityBytes.toString('utf8'));
  identity.tools.contentId = '0'.repeat(64);
  fs.writeFileSync(identityPath, JSON.stringify(identity));
  assert.throws(() => readToolPackage(dist), /identity is damaged/);
  fs.writeFileSync(identityPath, identityBytes);
  fs.appendFileSync(path.join(dist, 'tools/cli/arc.cjs'), '\n// damaged fixture\n');
  assert.throws(() => readToolPackage(dist), /damaged/);
  await assert.rejects(tools.installCommands(process.execPath, signal), /damaged/);
  assert.deepEqual(fs.readFileSync(path.join(tools.tools, 'active.json')), active);
  fs.writeFileSync(path.join(tools.root, 'bin', 'unfamiliar'), 'keep');
  const fresh = new BundledTools(readToolPackage(path.join(extensionRoot, 'dist')), tools.root);
  await assert.rejects(fresh.installCommands(process.execPath, signal), /unfamiliar/);
  assert.equal(fs.readFileSync(path.join(tools.root, 'bin', 'unfamiliar'), 'utf8'), 'keep');
  assert.deepEqual(fs.readFileSync(path.join(tools.tools, 'active.json')), active);
  for (const platform of ['win32', 'darwin', 'linux'] as const)
    assert.doesNotThrow(() => readToolPackage(path.join(extensionRoot, 'dist'), platform));
  assert.throws(() => readToolPackage(path.join(extensionRoot, 'dist'), 'freebsd'), /support/);
});

test('simultaneous first-window preparation publishes ownership before another window reads it', async () => {
  const root = tempDir('arc-first-windows-');
  const tools = new BundledTools(readToolPackage(path.join(extensionRoot, 'dist')), path.join(root, 'software'));
  const other = new BundledTools(tools.bundle, tools.root);
  const signal = new AbortController().signal;
  let second: Promise<string> | undefined;
  let failure: unknown;
  let started = false;
  const collide = () => {
    if (!started) {
      started = true;
      second = other.preparePrivateCommands(signal).catch((error) => {
        failure = error;
        return '';
      });
    }
  };
  const mkdir = fs.mkdirSync;
  const rename = fs.renameSync;
  const mkdirSpy = vi.spyOn(nativeFs, 'mkdirSync').mockImplementation(((
    folder: fs.PathLike,
    options: fs.MakeDirectoryOptions,
  ) => {
    const result = mkdir(folder, options);
    if (folder === tools.tools) collide();
    return result;
  }) as typeof fs.mkdirSync);
  const renameSpy = vi.spyOn(nativeFs, 'renameSync').mockImplementation((from, to) => {
    if (to === tools.tools) collide();
    return rename(from, to);
  });
  syncBuiltinESMExports();
  let first: Promise<string>;
  try {
    first = tools.preparePrivateCommands(signal);
  } finally {
    mkdirSpy.mockRestore();
    renameSpy.mockRestore();
    syncBuiltinESMExports();
  }
  assert.ok(second);
  const [one, two] = await Promise.all([first, second]);
  assert.ifError(failure);
  assert.equal(one, two);
  assert.deepEqual(fs.readdirSync(tools.root), ['tools']);
  assert.equal(fs.existsSync(path.join(tools.tools, '.install.lock')), false);
});

test.skipIf(process.platform !== 'win32')(
  'private commands publish beneath a long canonical software root',
  async () => {
    const parent = tempDir('arc-long-private-');
    let root = parent;
    while (root.length < 355) root = path.join(root, 'software-root-' + 'x'.repeat(Math.min(70, 355 - root.length)));
    fs.mkdirSync(root, { recursive: true });
    const tools = new BundledTools(readToolPackage(path.join(extensionRoot, 'dist')), root);
    assert.ok(tools.root.length >= 355);
    assert.equal(tools.root.startsWith('\\\\?\\'), false);
    const launchers = await tools.preparePrivateCommands(new AbortController().signal);
    const release = path.dirname(launchers);
    assert.equal(launchers, path.join(tools.tools, 'releases', tools.bundle.payload.contentId, 'launchers'));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tools.tools, 'ownership.json'), 'utf8')), {
      schemaVersion: 1,
      root: tools.root,
    });
    assert.deepEqual(
      fs.readFileSync(path.join(release, 'release.json')),
      Buffer.from(JSON.stringify(tools.bundle.payload)),
    );
    for (const name of Object.keys(tools.bundle.payload.files))
      assert.deepEqual(
        fs.readFileSync(path.join(release, name)),
        fs.readFileSync(path.join(tools.bundle.directory, name)),
      );
    assert.deepEqual(fs.readdirSync(tools.root), ['tools']);
    assert.equal(fs.existsSync(path.join(tools.tools, '.install.lock')), false);
    assert.equal(fs.existsSync(path.join(tools.tools, 'active.json')), false);
    assert.equal(await tools.preparePrivateCommands(new AbortController().signal), launchers);
  },
);

test.each(['empty', 'unfamiliar', 'redirected'] as const)(
  'failed first-window publication preserves only unfamiliar staging contents: %s',
  async (contents) => {
    const root = tempDir('arc-failed-claim-');
    const tools = new BundledTools(readToolPackage(path.join(extensionRoot, 'dist')), path.join(root, 'software'));
    const target = path.join(root, 'target');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep'), 'external');
    let staged = '';
    const renameSpy = vi.spyOn(nativeFs, 'renameSync').mockImplementation((from, to) => {
      assert.equal(to, tools.tools);
      staged = String(from);
      if (contents === 'unfamiliar') fs.writeFileSync(path.join(staged, 'keep'), 'unfamiliar');
      if (contents === 'redirected') {
        fs.unlinkSync(path.join(staged, 'ownership.json'));
        fs.rmdirSync(staged);
        fs.symlinkSync(target, staged, process.platform === 'win32' ? 'junction' : 'dir');
      }
      throw new Error('publication failed');
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(tools.preparePrivateCommands(new AbortController().signal), /publication failed/);
      assert.equal(fs.existsSync(staged), contents !== 'empty');
      if (contents === 'unfamiliar') assert.equal(fs.readFileSync(path.join(staged, 'keep'), 'utf8'), 'unfamiliar');
      assert.equal(fs.readFileSync(path.join(target, 'keep'), 'utf8'), 'external');
    } finally {
      renameSpy.mockRestore();
      syncBuiltinESMExports();
      if (contents === 'redirected' && fs.existsSync(staged)) fs.unlinkSync(staged);
    }
  },
);

test('a second window prepares its private CLI after another setup releases ownership', async () => {
  const root = tempDir('arc-window-contention-');
  const tools = new BundledTools(readToolPackage(path.join(extensionRoot, 'dist')), path.join(root, 'software'));
  let release!: () => void;
  const held = tools.owned(
    async () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    new AbortController().signal,
  );
  const lock = path.join(tools.tools, '.install.lock');
  const bytes = fs.readFileSync(lock);
  const values = new Map<string, string>();
  let requested = false;
  let signal!: AbortSignal;
  const owner = new TerminalTools(
    {
      persistent: true,
      description: undefined,
      clear: () => values.clear(),
      append: (key, value) => values.set(key, value),
      replace: (key, value) => values.set(key, value),
    },
    () => ({ root: tools.root, identity: 'second-window' }),
    (admission, wantedSignal) => {
      requested = true;
      signal = wantedSignal;
      return new BundledTools(tools.bundle, admission.root).preparePrivateCommands(wantedSignal);
    },
    process.execPath,
  );
  const refreshed = owner.refresh();
  await vi.waitFor(() => assert.equal(requested, true));
  try {
    assert.throws(() => owner.current('second-window'), /preparing/);
    assert.equal(signal.aborted, false);
    assert.deepEqual(fs.readFileSync(lock), bytes);
  } finally {
    release();
    await held;
    await refreshed;
  }
  const environment = owner.current('second-window');
  assert.equal(environment.directory, path.join(tools.tools, 'releases', tools.bundle.payload.contentId, 'launchers'));
  assert.equal(environment.windowId, 'second-window');
  assert.equal(values.has('ARC_WINDOW'), false);
  assert.equal(fs.existsSync(lock), false);
  owner.dispose();
});

test('a published private release remains available under retained software ownership', async () => {
  const root = tempDir('arc-ready-retained-');
  const tools = new BundledTools(readToolPackage(path.join(extensionRoot, 'dist')), root);
  const signal = new AbortController().signal;
  await tools.installCommands(process.execPath, signal);
  const active = fs.readFileSync(path.join(tools.tools, 'active.json'));
  const lock = acquireToolLock(path.join(tools.tools, '.install.lock'));
  const bytes = fs.readFileSync(lock.file);
  const values = new Map<string, string>();
  const owner = new TerminalTools(
    {
      persistent: true,
      description: undefined,
      clear: () => values.clear(),
      append: (key, value) => values.set(key, value),
      replace: (key, value) => values.set(key, value),
    },
    () => ({ root: tools.root, identity: 'ready-retained' }),
    (_admission, wantedSignal) => tools.preparePrivateCommands(wantedSignal),
    process.execPath,
  );
  const stage = vi.spyOn(tools, 'stage');
  const open = vi.spyOn(nativeFs, 'openSync');
  const mkdir = vi.spyOn(nativeFs, 'mkdirSync');
  syncBuiltinESMExports();
  vi.useFakeTimers();
  try {
    const refreshed = owner.refresh();
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(
      owner.current('retained-window').directory,
      path.join(tools.tools, 'releases', tools.bundle.payload.contentId, 'launchers'),
    );
    await refreshed;
    assert.equal(stage.mock.calls.length, 0);
    assert.equal(mkdir.mock.calls.length, 0);
    assert.equal(
      open.mock.calls.some(([file, flags]) => file === lock.file && flags === 'wx'),
      false,
    );
    assert.deepEqual(fs.readFileSync(lock.file), bytes);
    assert.deepEqual(fs.readFileSync(path.join(tools.tools, 'active.json')), active);
    assert.equal(values.has('ARC_WINDOW'), false);
  } finally {
    owner.dispose();
    stage.mockRestore();
    open.mockRestore();
    mkdir.mockRestore();
    syncBuiltinESMExports();
    vi.useRealTimers();
    lock.release();
  }
});

test.each(['absent', 'different'] as const)(
  'retained software ownership ends private preparation without a matching release: %s',
  async (release) => {
    const root = tempDir('arc-unready-retained-');
    const tools = new BundledTools(readToolPackage(path.join(extensionRoot, 'dist')), root);
    await tools.owned(async () => {
      if (release === 'different') {
        const published = tools.stage();
        fs.renameSync(published, published + '-other');
      }
    }, new AbortController().signal);
    const lock = acquireToolLock(path.join(tools.tools, '.install.lock'));
    const bytes = fs.readFileSync(lock.file);
    const values = new Map<string, string>();
    const owner = new TerminalTools(
      {
        persistent: true,
        description: undefined,
        clear: () => values.clear(),
        append: (key, value) => values.set(key, value),
        replace: (key, value) => values.set(key, value),
      },
      () => ({ root: tools.root, identity: 'unready-retained' }),
      (_admission, wantedSignal) => tools.preparePrivateCommands(wantedSignal),
      process.execPath,
    );
    vi.useFakeTimers();
    try {
      const refreshed = owner.refresh();
      await vi.advanceTimersByTimeAsync(0);
      assert.throws(() => owner.current('waiting'), /preparing/);
      await vi.advanceTimersByTimeAsync(30_000);
      assert.throws(
        () => owner.current('failed'),
        (error: Error) => error.message.includes(lock.file) && error.message.includes('remains owned'),
      );
      await refreshed;
      assert.equal(values.size, 0);
      assert.deepEqual(fs.readFileSync(lock.file), bytes);
      assert.equal(fs.existsSync(path.join(tools.tools, 'releases', tools.bundle.payload.contentId)), false);
    } finally {
      owner.dispose();
      vi.useRealTimers();
      lock.release();
    }
  },
);

test.each(['silent', 'unavailable', 'error'] as const)(
  'private preparation checks readiness without filesystem notifications: %s',
  async (watching) => {
    const root = tempDir('arc-readiness-poll-');
    const tools = new BundledTools(readToolPackage(path.join(extensionRoot, 'dist')), root);
    await tools.owned(async () => undefined, new AbortController().signal);
    const lock = acquireToolLock(path.join(tools.tools, '.install.lock'));
    const bytes = fs.readFileSync(lock.file);
    const watcher = {
      close: vi.fn<() => void>(),
      on: (_event: string, callback: () => void) => {
        if (watching === 'error') callback();
        return watcher;
      },
    };
    const watch = vi.spyOn(nativeFs, 'watch').mockImplementation((() => {
      if (watching === 'unavailable') throw new Error('notifications unavailable');
      return watcher;
    }) as unknown as typeof fs.watch);
    syncBuiltinESMExports();
    vi.useFakeTimers();
    const controller = new AbortController();
    try {
      let selected: string | undefined;
      const waiting = tools.preparePrivateCommands(controller.signal).then((directory) => {
        selected = directory;
      });
      const release = tools.stage();
      await vi.advanceTimersByTimeAsync(250);
      assert.equal(selected, path.join(release, 'launchers'));
      await waiting;
      assert.deepEqual(fs.readFileSync(lock.file), bytes);
      lock.release();
      const next = acquireToolLock(lock.file);
      const acquired = waitForToolLock(lock.file, controller.signal);
      next.release();
      let settled = false;
      void acquired.then((owned) => {
        settled = true;
        owned.release();
      });
      await vi.advanceTimersByTimeAsync(250);
      assert.equal(settled, true);
      await acquired;
    } finally {
      controller.abort();
      watch.mockRestore();
      syncBuiltinESMExports();
      vi.useRealTimers();
      lock.release();
    }
  },
);

test.each(['ownership', 'manifest', 'bytes', 'redirected'] as const)(
  'retained ownership never admits an invalid private release: %s',
  async (defect) => {
    const root = tempDir('arc-invalid-ready-');
    const tools = new BundledTools(readToolPackage(path.join(extensionRoot, 'dist')), path.join(root, 'software'));
    const signal = new AbortController().signal;
    const directory = await tools.preparePrivateCommands(signal);
    const lock = acquireToolLock(path.join(tools.tools, '.install.lock'));
    const bytes = fs.readFileSync(lock.file);
    const release = path.dirname(directory);
    let link: string | undefined;
    if (defect === 'ownership') fs.writeFileSync(path.join(tools.tools, 'ownership.json'), '{}');
    if (defect === 'manifest') fs.writeFileSync(path.join(release, 'release.json'), '{}');
    if (defect === 'bytes') fs.appendFileSync(path.join(release, 'cli/arc.cjs'), 'damaged');
    if (defect === 'redirected') {
      const moved = release + '-kept';
      fs.renameSync(release, moved);
      fs.symlinkSync(moved, release, process.platform === 'win32' ? 'junction' : 'dir');
      link = release;
    }
    try {
      await assert.rejects(tools.preparePrivateCommands(signal), /unfamiliar|damaged|redirected/);
      assert.deepEqual(fs.readFileSync(lock.file), bytes);
    } finally {
      if (link) fs.unlinkSync(link);
      lock.release();
    }
  },
);

test.each(['canceled', 'admission', 'disposed'] as const)(
  'private contention preserves retained ownership after %s',
  async (ending) => {
    const root = tempDir('arc-canceled-contention-');
    const tools = new BundledTools(readToolPackage(path.join(extensionRoot, 'dist')), root);
    await tools.owned(async () => undefined, new AbortController().signal);
    const lock = acquireToolLock(path.join(tools.tools, '.install.lock'));
    const bytes = fs.readFileSync(lock.file);
    const values = new Map<string, string>();
    let admission: ToolAdmission | null = { root: tools.root, identity: 'original' };
    let signal: AbortSignal | undefined;
    const owner = new TerminalTools(
      {
        persistent: true,
        description: undefined,
        clear: () => values.clear(),
        append: (key, value) => values.set(key, value),
        replace: (key, value) => values.set(key, value),
      },
      () => admission,
      (_admission, wantedSignal) => {
        signal = wantedSignal;
        return tools.preparePrivateCommands(wantedSignal);
      },
      process.execPath,
    );
    vi.useFakeTimers();
    try {
      const refreshed = owner.refresh();
      await vi.advanceTimersByTimeAsync(0);
      assert.equal(signal?.aborted, false);
      if (ending === 'disposed') owner.dispose();
      else {
        admission = null;
        if (ending === 'canceled') await owner.refresh();
        else assert.throws(() => owner.current('changed'), /unavailable/);
      }
      if (ending === 'admission') tools.stage();
      await vi.advanceTimersByTimeAsync(250);
      await refreshed;
      assert.equal(values.size, 0);
      assert.throws(() => owner.current('ended'), /unavailable/);
      assert.deepEqual(fs.readFileSync(lock.file), bytes);
    } finally {
      owner.dispose();
      vi.useRealTimers();
      lock.release();
    }
  },
);

test('private CLI releases retain shared selection and select matching bytes before earlier npm commands for children', async () => {
  const root = tempDir('arc-private-commands-');
  const tools = new BundledTools(readToolPackage(path.join(extensionRoot, 'dist')), path.join(root, 'software'));
  const signal = new AbortController().signal;
  await tools.installCommands(process.execPath, signal);
  const active = fs.readFileSync(path.join(tools.tools, 'active.json'));
  const directory = await tools.preparePrivateCommands(signal);
  assert.equal(directory, path.join(tools.tools, 'releases', tools.bundle.payload.contentId, 'launchers'));
  assert.deepEqual(fs.readFileSync(path.join(tools.tools, 'active.json')), active);
  const npm = path.join(root, 'npm');
  fs.mkdirSync(npm);
  fs.writeFileSync(path.join(npm, 'arc.cmd'), '@echo off\r\necho npm-old\r\n');
  fs.writeFileSync(path.join(npm, 'arc'), '#!/bin/sh\necho npm-old\n', { mode: 0o755 });
  const inherited = {
    ...process.env,
    PATH: npm,
    ARC_HOME: path.join(root, 'data'),
    ARC_EDITOR_EXECUTABLE: process.execPath,
  };
  for (const key of Object.keys(inherited))
    if (key !== 'PATH' && key.toUpperCase() === 'PATH') delete inherited[key as keyof typeof inherited];
  const run = (env: NodeJS.ProcessEnv) =>
    spawnSync(
      process.platform === 'win32' ? (process.env.ComSpec ?? 'C:/Windows/System32/cmd.exe') : '/bin/sh',
      process.platform === 'win32' ? ['/d', '/c', 'arc --version'] : ['-c', 'arc --version'],
      { cwd: root, env, encoding: 'utf8' },
    );
  const ordinary = run({ ...inherited, PATH: npm + terminalToolPath(directory)!.value });
  assert.equal(ordinary.status, 0, ordinary.stderr);
  assert.equal(ordinary.stdout.trim(), 'npm-old');
  const child = run(
    childEnv(inherited, {}, undefined, root, { directory, editorExecutable: process.execPath, windowId: 'own-window' }),
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), builtVersion());
  assert.equal(fs.existsSync(inherited.ARC_HOME), false);
});

test('copied bundled hooks capture baselines and publish Stop after the extension payload disappears', async () => {
  const root = tempDir('arc-installed-hooks-');
  const dist = path.join(root, 'extension');
  fs.cpSync(path.join(extensionRoot, 'dist'), dist, { recursive: true });
  const tools = new BundledTools(readToolPackage(dist), path.join(root, 'software'));
  const release = await tools.owned(async () => tools.stage(), new AbortController().signal);
  fs.renameSync(dist, dist + '.unavailable');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  const file = path.join(cwd, 'changed.txt');
  fs.writeFileSync(file, 'original bytes\n');
  const env = {
    ...process.env,
    ARC_HOME: path.join(root, 'data'),
    ARC_IGNORE_ROOTS: path.join(root, 'excluded'),
    PATH: '',
    ELECTRON_RUN_AS_NODE: undefined,
  };
  const session = 'installed-hook-fixture';
  const hook = (name: string) =>
    spawnSync(process.execPath, [path.join(release, 'plugin/scripts', name)], {
      cwd,
      env,
      input: JSON.stringify({ session_id: session, cwd, tool_input: { file_path: file } }),
      encoding: 'utf8',
    });
  const before = hook('pretooluse-snapshot.cjs');
  assert.equal(before.status, 0, before.stderr);
  const snapshots = path.join(env.ARC_HOME, 'snapshots', session);
  const baselines = fs.readdirSync(path.join(snapshots, 'baseline'));
  assert.equal(baselines.length, 1);
  assert.equal(fs.readFileSync(path.join(snapshots, 'baseline', baselines[0]), 'utf8'), 'original bytes\n');
  fs.writeFileSync(file, 'changed bytes\n');
  const stopped = hook('stop-manifest.cjs');
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(fs.existsSync(path.join(snapshots, 'trigger')), true);
});
test('packaged tool modes pass Unix payload admission from archive attributes', () => {
  const root = tempDir('arc-vsix-modes-');
  const archive = path.join(root, 'arc.vsix');
  const packaged = spawnSync(process.execPath, ['scripts/package.mjs', '--no-dependencies', '--out', archive], {
    cwd: extensionRoot,
    encoding: 'utf8',
  });
  assert.equal(packaged.status, 0, packaged.stderr);
  const identity = readToolPackage(path.join(extensionRoot, 'dist')).payload;
  const bytes = fs.readFileSync(archive);
  const extracted = path.join(root, 'tools');
  const modes = new Map<string, number>();
  let end = bytes.length - 22;
  while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0);
  for (let at = bytes.readUInt32LE(end + 16); at < end;) {
    assert.equal(bytes.readUInt32LE(at), 0x02014b50);
    const length = bytes.readUInt16LE(at + 28);
    const name = bytes.toString('utf8', at + 46, at + 46 + length);
    if (name.startsWith('extension/dist/tools/')) {
      const relative = name.slice('extension/dist/tools/'.length);
      assert.ok(identity.files[relative]);
      assert.equal(bytes[at + 5], 3);
      const file = path.join(extracted, relative);
      const local = bytes.readUInt32LE(at + 42);
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      const compressed = bytes.subarray(start, start + bytes.readUInt32LE(at + 20));
      const content = bytes.readUInt16LE(at + 10) === 0 ? compressed : inflateRawSync(compressed);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      modes.set(file, bytes.readUInt32LE(at + 38) >>> 16);
    }
    at += 46 + length + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  const source = fs.readFileSync(path.join(extensionRoot, 'src/bundledtools.ts'), 'utf8');
  const functionSource = source
    .slice(source.indexOf('export function validateToolFiles'), source.indexOf('export function readToolPackage'))
    .replace('export function', 'function');
  const compiled = transformSync(functionSource + '\nmodule.exports = validateToolFiles;', { loader: 'ts' }).code;
  for (const platform of ['linux', 'darwin']) {
    const module = { exports: undefined as unknown as typeof import('./bundledtools').validateToolFiles };
    vm.runInNewContext(compiled, {
      module,
      fs: { ...fs, statSync: (file: string) => ({ mode: modes.get(file) }) },
      path,
      filesIn: (folder: string) => {
        assert.equal(folder, extracted);
        return [...modes.keys()].map((file) => path.relative(extracted, file).split(path.sep).join('/')).sort();
      },
      digest: (content: Buffer) => createHash('sha256').update(content).digest('hex'),
      process: { platform },
    });
    module.exports(extracted, identity.files);
  }
  const inspected = spawnSync(process.execPath, ['scripts/check-vsix.mjs', archive], {
    cwd: extensionRoot,
    encoding: 'utf8',
  });
  assert.equal(inspected.status, 0, inspected.stderr);
  const damaged = Buffer.from(bytes);
  for (let at = damaged.readUInt32LE(end + 16); at < end;) {
    const length = damaged.readUInt16LE(at + 28);
    if (damaged.toString('utf8', at + 46, at + 46 + length) === 'extension/dist/tools/LICENSE')
      damaged.writeUInt32LE((0o100666 << 16) >>> 0, at + 38);
    at += 46 + length + damaged.readUInt16LE(at + 30) + damaged.readUInt16LE(at + 32);
  }
  const corruptArchive = path.join(root, 'wrong-mode.vsix');
  fs.writeFileSync(corruptArchive, damaged);
  const rejected = spawnSync(process.execPath, ['scripts/check-vsix.mjs', corruptArchive], {
    cwd: extensionRoot,
    encoding: 'utf8',
  });
  assert.notEqual(rejected.status, 0, 'VSIX inspection accepted unsupported tool permissions');
}, 30_000);
