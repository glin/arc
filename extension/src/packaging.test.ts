// extension/src/packaging.test.ts
import { beforeAll, test, vi } from 'vitest';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import nativeFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tempDir } from './temproot.ts';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { buildSync, transformSync } from 'esbuild';
import { inflateRawSync } from 'node:zlib';
import * as vm from 'node:vm';
import ts from 'typescript';
import { browserBundle, exportBrowserAssets } from './panelbundle.ts';
import { BundledTools, readToolPackage, prepareEditorCommands } from './bundledtools.ts';
import { TerminalTools, terminalToolPath, type ToolAdmission } from './toolpath.ts';
import { childEnv } from './agenthost.ts';
import { acquireToolLock, waitForToolLock } from './toolownership.ts';
import { callSources, declarationSource, sourceDoesNotMatch, sourceMatch } from '../test/source-contract.ts';

const extensionRoot = path.join(__dirname, '..');

function overlayStaticSources(source: string): void {
  fs.copyFileSync(
    path.join(extensionRoot, 'scripts/bundled-tools.mjs'),
    path.join(source, 'scripts/bundled-tools.mjs'),
  );
  fs.copyFileSync(path.join(extensionRoot, '../LICENSE'), path.join(source, '../LICENSE'));
  fs.cpSync(path.join(extensionRoot, '../plugins'), path.join(source, '../plugins'), { recursive: true });
  fs.cpSync(path.join(extensionRoot, '../cli/skills'), path.join(source, '../cli/skills'), { recursive: true });
  for (const file of [
    'extension.ts',
    'bundledsetup.ts',
    'bundledtools.ts',
    'toolownership.ts',
    'toolpath.ts',
    'claudeplugin.ts',
    'panelbundle.ts',
    'sessionexport.ts',
    'exportdata.ts',
    'transcript.ts',
    'richtext.ts',
    'codex.ts',
    'domain/export-model.ts',
    'readmeter.ts',
    'webview/card.ts',
    'webview/export-host.ts',
    'webview/export-model.ts',
    'webview/navigation.ts',
    'webview/static-menu.ts',
    'webview/static-page.css',
    'webview/static-shell.css',
    'webview/static-menu.css',
    'view/static-shell.ts',
    'view/static-page.ts',
    'view/static-themes.ts',
    'view/export-facts.ts',
    'domain/places.ts',
    'domain/export-limits.ts',
  ]) {
    fs.mkdirSync(path.dirname(path.join(source, 'src', file)), { recursive: true });
    fs.copyFileSync(path.join(extensionRoot, 'src', file), path.join(source, 'src', file));
  }
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

function embeddedHostIdentity(file: string): Record<string, unknown> {
  const bundle = fs.readFileSync(file, 'utf8');
  // Read the literal consumed by the shipping provider, independently of the sidecar.
  for (const match of bundle.matchAll(/JSON\.parse\(((?:"(?:[^"\\]|\\.)*")|(?:'(?:[^'\\]|\\.)*'))\)/g)) {
    const source = ts.createSourceFile('identity.js', `const identity = ${match[1]};`, ts.ScriptTarget.Latest);
    const declaration = (source.statements[0] as ts.VariableStatement).declarationList.declarations[0];
    if (!declaration.initializer || !ts.isStringLiteral(declaration.initializer)) continue;
    const literal = declaration.initializer.text;
    try {
      const identity = JSON.parse(literal);
      if ('sourceCommit' in identity && 'builtAt' in identity) return identity;
    } catch {
      /* Other bundle literals are unrelated to host identity. */
    }
  }
  return assert.fail('shipping host has no embedded build identity');
}

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

test('native bridge correspondence accepts both checkout line endings and rejects source drift', () => {
  const root = tempDir('arc-native-identity-');
  const source = path.join(root, 'extension/src/windowpipe-source.ts');
  const resources = path.join(root, 'extension/resources');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.mkdirSync(resources, { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(
    path.join(extensionRoot, '../scripts/windowpipe-build.mjs'),
    path.join(root, 'scripts/windowpipe-build.mjs'),
  );
  fs.cpSync(path.join(extensionRoot, 'resources'), resources, { recursive: true });
  const canonical = fs
    .readFileSync(path.join(extensionRoot, 'src/windowpipe-source.ts'), 'utf8')
    .replace(/\r\n/g, '\n');
  const script = "import {copyWindowsPipe} from './scripts/windowpipe-build.mjs'; copyWindowsPipe('./dist');";
  const copy = () =>
    spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8' });
  for (const ending of ['\n', '\r\n']) {
    fs.writeFileSync(source, canonical.replace(/\n/g, ending));
    const result = copy();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      fs.readFileSync(path.join(root, 'dist/windowpipe.exe')),
      fs.readFileSync(path.join(resources, 'windowpipe.exe')),
    );
  }
  fs.appendFileSync(source, '\n// Different native source\n');
  const drift = copy();
  assert.notEqual(drift.status, 0);
  assert.match(drift.stderr, /does not match its source/);
});

test('extracted source builds without Git and never inherits an enclosing repository identity', () => {
  const root = tempDir('arc-archive-build-');
  const archive = path.join(root, 'source.tar');
  const sourceRoot = path.join(root, 'source');
  fs.mkdirSync(sourceRoot);
  const archived = spawnSync('git', ['archive', '--format=tar', '-o', archive, 'HEAD', 'extension', 'cli'], {
    cwd: path.dirname(extensionRoot),
    encoding: 'utf8',
  });
  assert.equal(archived.status, 0, archived.stderr);
  const extracted = spawnSync('tar', ['-xf', path.basename(archive), '-C', path.relative(root, sourceRoot)], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(extracted.status, 0, extracted.stderr);
  const source = path.join(sourceRoot, 'extension');
  fs.copyFileSync(path.join(extensionRoot, 'esbuild.mjs'), path.join(source, 'esbuild.mjs'));
  overlayStaticSources(source);
  fs.mkdirSync(path.join(sourceRoot, 'scripts'), { recursive: true });
  fs.copyFileSync(
    path.join(extensionRoot, '../scripts/windowpipe-build.mjs'),
    path.join(sourceRoot, 'scripts/windowpipe-build.mjs'),
  );
  fs.cpSync(path.join(extensionRoot, 'resources'), path.join(source, 'resources'), { recursive: true });
  fs.copyFileSync(path.join(extensionRoot, 'src/windowpipe-source.ts'), path.join(source, 'src/windowpipe-source.ts'));
  fs.symlinkSync(
    path.join(extensionRoot, 'node_modules'),
    path.join(source, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const expected = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'dist/build-identity.json'), 'utf8'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  let archiveInputHash: string | undefined;
  for (const enclosingRepository of [false, true]) {
    if (enclosingRepository) {
      for (const args of [
        ['init'],
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '--allow-empty',
          '-m',
          'fixture',
        ],
      ]) {
        const git = spawnSync('git', args, { cwd: root, encoding: 'utf8', env });
        assert.equal(git.status, 0, git.stderr);
      }
    }
    const buildEnv = enclosingRepository ? env : { ...env, PATH: '' };
    if (!enclosingRepository) assert.ok(spawnSync('git', ['--version'], { env: buildEnv }).error);
    const built = spawnSync(process.execPath, ['esbuild.mjs'], { cwd: source, encoding: 'utf8', env: buildEnv });
    assert.equal(built.status, 0, `extracted production build failed:\n${built.stderr}`);
    const identity = JSON.parse(fs.readFileSync(path.join(source, 'dist/build-identity.json'), 'utf8'));
    assert.equal(identity.sourceCommit, null);
    assert.equal(identity.dirty, null);
    assert.equal(identity.version, expected.version);
    assert.match(identity.inputsSha256, /^[a-f0-9]{64}$/);
    if (archiveInputHash === undefined) archiveInputHash = identity.inputsSha256;
    else assert.equal(identity.inputsSha256, archiveInputHash);
    assert.equal(
      identity.extensionSha256,
      createHash('sha256')
        .update(fs.readFileSync(path.join(source, 'dist/extension.js')))
        .digest('hex'),
    );
  }
}, 90_000);

test('watch startup invalidates identity from a preceding production build', async () => {
  const identity = path.join(extensionRoot, 'dist', 'build-identity.json');
  assert.ok(fs.existsSync(identity));
  const watcher = spawn(process.execPath, ['esbuild.mjs', '--watch'], { cwd: extensionRoot, stdio: 'ignore' });
  try {
    await vi.waitFor(() => assert.equal(fs.existsSync(identity), false), { timeout: 15_000 });
  } finally {
    const exited =
      watcher.exitCode !== null
        ? Promise.resolve()
        : new Promise<void>((resolve) => watcher.once('exit', () => resolve()));
    watcher.kill();
    await exited;
    const restored = spawnSync(process.execPath, ['esbuild.mjs'], { cwd: extensionRoot, encoding: 'utf8' });
    assert.equal(restored.status, 0, restored.stderr);
  }
}, 30_000);

test('CLI watching survives panel rebuilds and ends when the build closes', async () => {
  const root = tempDir('arc-cli-watch-');
  const archive = path.join(root, 'source.tar');
  const sourceRoot = path.join(root, 'source');
  fs.mkdirSync(sourceRoot);
  const archived = spawnSync('git', ['archive', '--format=tar', '-o', archive, 'HEAD', 'extension', 'cli'], {
    cwd: path.dirname(extensionRoot),
    encoding: 'utf8',
  });
  assert.equal(archived.status, 0, archived.stderr);
  const extracted = spawnSync('tar', ['-xf', path.basename(archive), '-C', path.relative(root, sourceRoot)], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(extracted.status, 0, extracted.stderr);
  const source = path.join(sourceRoot, 'extension');
  fs.copyFileSync(path.join(extensionRoot, 'esbuild.mjs'), path.join(source, 'esbuild.mjs'));
  overlayStaticSources(source);
  fs.mkdirSync(path.join(sourceRoot, 'scripts'), { recursive: true });
  fs.copyFileSync(
    path.join(extensionRoot, '../scripts/windowpipe-build.mjs'),
    path.join(sourceRoot, 'scripts/windowpipe-build.mjs'),
  );
  fs.cpSync(path.join(extensionRoot, 'resources'), path.join(source, 'resources'), { recursive: true });
  fs.copyFileSync(path.join(extensionRoot, 'src/windowpipe-source.ts'), path.join(source, 'src/windowpipe-source.ts'));
  fs.symlinkSync(
    path.join(extensionRoot, 'node_modules'),
    path.join(source, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const script =
    "import { buildExtension } from './esbuild.mjs'; const close = await buildExtension({watch:true}); console.log('watch ready'); process.stdin.once('data', async () => { await close(); process.stdin.destroy(); });";
  for (const file of [
    'panelhost.ts',
    'turncard.ts',
    'launchpolicy.ts',
    'repositoryscope.ts',
    'sessionfilter.ts',
    'domain/session-query.ts',
    'diagnosticslog.ts',
    'transcript.ts',
    'exportlimits.ts',
    'identity.ts',
    'domain/identity.ts',
    'domain/session-link.ts',
    'domain/file-citation.ts',
  ]) {
    fs.copyFileSync(path.join(extensionRoot, 'src', file), path.join(source, 'src', file));
  }
  const watcher = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: source,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  watcher.stdout.on('data', (chunk) => {
    output += chunk;
  });
  watcher.stderr.on('data', (chunk) => {
    output += chunk;
  });
  try {
    await vi.waitFor(() => assert.match(output, /watch ready/), { timeout: 15_000 });
    assert.throws(() => readToolPackage(path.join(source, 'dist')), /ENOENT/);
    const directory = await prepareEditorCommands(
      path.join(source, 'dist'),
      path.join(root, 'software'),
      new AbortController().signal,
      true,
    );
    assert.equal(directory, path.join(source, 'dist/bin'));
    const developmentEnv = childEnv(process.env, {}, undefined, root, {
      directory,
      editorExecutable: process.execPath,
      windowId: 'development-window',
    });
    const launch = () =>
      spawnSync(
        process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh',
        process.platform === 'win32' ? ['/d', '/c', 'arc --version'] : ['-c', 'arc --version'],
        { env: developmentEnv, encoding: 'utf8' },
      );
    const version = launch();
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).version);
    await assert.rejects(
      prepareEditorCommands(
        path.join(source, 'dist'),
        path.join(root, 'software'),
        new AbortController().signal,
        false,
      ),
      /ENOENT/,
    );
    const hostBundle = path.join(source, 'dist/extension.js');
    await vi.waitFor(() => assert.equal(embeddedHostIdentity(hostBundle).unavailable, 'watch'), { timeout: 15_000 });
    for (const marker of ['host health watch one', 'host health watch two']) {
      fs.appendFileSync(path.join(source, 'src/diagnosticslog.ts'), `\nconsole.log('${marker}');\n`);
      await vi.waitFor(() => assert.ok(fs.readFileSync(hostBundle, 'utf8').includes(marker)), { timeout: 15_000 });
      assert.deepEqual(embeddedHostIdentity(hostBundle), {
        sourceCommit: null,
        dirty: null,
        builtAt: 0,
        unavailable: 'watch',
      });
    }
    fs.appendFileSync(path.join(source, 'src/webview/panel.css'), '\n/* watch fixture */\n');
    await vi.waitFor(() => assert.match(output, /rebuilt: the panel source changed/), { timeout: 15_000 });
    fs.appendFileSync(path.join(sourceRoot, 'cli/src/main.ts'), "\nconsole.log('cli watch fixture');\n");
    await vi.waitFor(
      () => assert.ok(fs.readFileSync(path.join(source, 'dist/cli.cjs'), 'utf8').includes('cli watch fixture')),
      { timeout: 15_000 },
    );
    assert.match(launch().stdout, /cli watch fixture/);
    watcher.stdin.end('close');
    await vi.waitFor(() => assert.equal(watcher.exitCode, 0), { timeout: 15_000 });
  } finally {
    if (watcher.exitCode === null) {
      const exited = new Promise<void>((resolve) => watcher.once('exit', () => resolve()));
      watcher.kill();
      await exited;
    }
  }
}, 60_000);

// A single-star ignore pattern does not cross directory separators. Excluded file types need recursive patterns.

test('a file type the package leaves out is left out at every depth, not only at its top', () => {
  const file = path.join(__dirname, '..', '.vscodeignore');
  const patterns = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const topOnly = patterns.filter((p) => /^\*\.[^/]+$/.test(p));
  assert.deepEqual(
    topOnly,
    [],
    `.vscodeignore leaves ${topOnly.join(', ')} out of the package's top level only, so one written ` +
      'into a folder under it ships. Write them the way `**/*.map` is written.',
  );
});

test('CPU profiles stay out of extension packages', () => {
  const file = path.join(__dirname, '..', '.vscodeignore');
  const patterns = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim());
  assert.ok(
    patterns.includes('**/*.cpuprofile*'),
    'a CPU profile captured in the extension directory would be included in the package',
  );
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

test('bare arc launchers preserve arguments, stdin, exit status, and window targeting with spaced paths', async () => {
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
  const shells =
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
        assert.equal(
          result.stdout.trim(),
          JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8')).version,
        );
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
    assert.equal(
      version.stdout.trim(),
      JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8')).version,
    );
    const windows = run('arc windows --json');
    assert.equal(windows.status, 0, windows.stderr);
    assert.deepEqual(JSON.parse(windows.stdout), { version: 1, windows: [], complete: true });
    const status = run('arc statusline --json', '{}');
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).schemaVersion, 1);
    const cost = run(`arc cost "${transcript.replaceAll('\\', '/')}" --source-only --by-model`);
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
});

test.skipIf(process.platform !== 'win32')(
  'long private Windows launchers preserve terminal commands and matching path arguments',
  async () => {
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
      const run = (command: string, input?: string) =>
        spawnSync(powershell, ['-NoProfile', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
          cwd: root,
          env: terminalEnv,
          input,
          encoding: 'utf8',
          timeout: 15_000,
        });
      const status = run('arc statusline --json', '{}');
      assert.equal(status.status, 0, status.stderr);
      assert.equal(JSON.parse(status.stdout).schemaVersion, 1);
      const invalid = run('arc statusline --json', '{invalid');
      assert.equal(invalid.status, 1, invalid.stderr);
      assert.match(invalid.stderr, /Claude status input is not valid JSON/);
      const help = run('arc help');
      assert.equal(help.status, 0, help.stderr);
      assert.match(help.stdout, /statusline/);
      for (const first of [
        launcher,
        commands.directory + '\\arc.cmd',
        'argument with spaces',
        '--arc-launcher-arguments',
      ]) {
        const escaped = first.replaceAll("'", "''");
        for (const command of [`arc '${escaped}'`, `& $env:ComSpec /d /c arc '"${first}"'`]) {
          const result = run(command);
          assert.equal(result.status, 1, result.stderr);
          assert.ok(result.stderr.includes(`Unknown command: ${first}`), result.stderr);
        }
        const standalone = spawnSync(process.execPath, [path.join(extensionRoot, 'dist/cli.cjs'), first], {
          cwd: root,
          env,
          encoding: 'utf8',
          timeout: 15_000,
        });
        assert.equal(standalone.status, 1, standalone.stderr);
        assert.ok(standalone.stderr.includes(`Unknown command: ${first}`), standalone.stderr);
      }
      const child = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'arc windows --json'], {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 15_000,
      });
      assert.equal(child.status, 0, child.stderr);
      assert.deepEqual(JSON.parse(child.stdout), { version: 1, windows: [], complete: true });
      assert.equal(values.get('Path'), ';' + commands.directory);
    } finally {
      owner.dispose();
    }
  },
);

test('the package command leaves out its single-bundle size notice', () => {
  const outputDir = tempDir('arc-package-');
  const output = path.join(outputDir, 'arc.vsix');
  try {
    const result = spawnSync(
      process.execPath,
      ['scripts/package.mjs', '--no-dependencies', '--allow-missing-repository', '-o', output],
      { cwd: extensionRoot, encoding: 'utf8' },
    );

    assert.ifError(result.error);
    assert.equal(result.status, 0, `extension package failed:\n${result.stderr}`);
    assert.ok(fs.existsSync(output), 'the package command did not create its VSIX');
    const checked = spawnSync(process.execPath, ['scripts/check-vsix.mjs', output], {
      cwd: extensionRoot,
      encoding: 'utf8',
    });
    assert.ifError(checked.error);
    assert.equal(checked.status, 0, `VSIX inspection failed:\n${checked.stderr}`);
    assert.doesNotMatch(
      result.stdout,
      /^The file extension\/dist\/extension\.js is large \([^)]+\)$/m,
      "the package command printed VSCE's single-bundle size notice",
    );
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

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

test('the package command writes the Arc VSIX', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.match(manifest.scripts.package, /-o arc\.vsix$/, 'the package command does not write arc.vsix');
  const installer = fs.readFileSync(path.join(__dirname, '..', '..', 'install.sh'), 'utf8');
  assert.match(installer, /VSIX="\$ARC_INSTALL_TEMP\/arc\.vsix"/, 'the installer does not select a temporary VSIX');
  assert.match(
    installer,
    /node scripts\/package\.mjs [^\n]*-o "\$VSIX"/,
    'the installer does not package its selected VSIX',
  );
});

test('primary Arc commands use Arc labels', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
    contributes: { commands: Array<{ command: string; title: string }> };
  };
  const titles = new Map(manifest.contributes.commands.map((command) => [command.command, command.title]));
  assert.equal(titles.get('arc.openInEditor'), 'Open Arc in Editor');
  assert.equal(titles.get('arc.openBeside'), 'Open Arc to the Side');
});

test('the extension requires the Agent Codicon and remains installable in supported Positron', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(
    manifest.engines?.vscode,
    '^1.106.0',
    `the Agent Codicon requires VS Code 1.106.0, not ${manifest.engines?.vscode ?? 'an unknown version'}`,
  );
});

// Product identifiers use Arc across code and public text. Build retired-name patterns from separate words to exclude their own definitions.

const RETIRED_WORDS = ['agent', 'diff', 'review'];
const RETIRED = [
  new RegExp(RETIRED_WORDS.join(''), 'i'), // one word, the way an identifier carries it
  new RegExp(RETIRED_WORDS.join('_'), 'i'), // underscored, the way an environment variable does
  new RegExp(RETIRED_WORDS.join(' '), 'i'), // three words, the way the reader read it
];

const FOLDER = RETIRED_WORDS.join('-');

const PRODUCT_OMITTED_SEGMENTS = new Set([
  '.claude',
  '.git',
  'node_modules',
  'dist',
  'out',
  '.vscode-test',
  'coverage',
  'shots',
]);
const PRODUCT_OMITTED_SUFFIX =
  /\.(?:7z|bin|cpuprofile(?:\.txt)?|gif|gz|har|heapsnapshot|ico|jpe?g|map|pdf|png|trace|ttf|vsix|webp|woff2?|zip)$/i;
const PRODUCT_OMITTED_CAPTURE = /(?:^|[\\/])arc-performance-[^\\/]+\.json$/i;

interface ProductFiles {
  names: string[];
  text: string[];
}

function gitLines(root: string, args: string[]): string[] {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'buffer' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr.toString('utf8')}`);
  return result.stdout.toString('utf8').split('\0').filter(Boolean);
}

function registeredWorktrees(root: string): string[] {
  const result = spawnSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `git worktree list failed: ${result.stderr}`);
  return nestedWorktrees(
    root,
    result.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length)),
  );
}

function nestedWorktrees(root: string, worktrees: string[]): string[] {
  const resolvedRoot = path.resolve(root);
  return worktrees
    .map((worktree) => path.resolve(worktree))
    .filter((worktree) => !samePath(worktree, resolvedRoot) && isInside(worktree, resolvedRoot));
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isInside(file: string, directory: string): boolean {
  const relative = path.relative(directory, file);
  return !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function isProductPath(root: string, file: string, worktrees: string[]): boolean {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  const parts = relative.split(path.sep);
  if (parts.some((part) => PRODUCT_OMITTED_SEGMENTS.has(part) || part.startsWith('.tmp-'))) return false;
  if (PRODUCT_OMITTED_SUFFIX.test(file) || PRODUCT_OMITTED_CAPTURE.test(file)) return false;
  return !worktrees.some((worktree) => isInside(file, worktree));
}

function productFiles(root: string, relativePaths: string[], worktrees: string[] = []): ProductFiles {
  const files: ProductFiles = { names: [], text: [] };
  for (const relative of relativePaths) {
    const file = path.resolve(root, relative);
    if (!isProductPath(root, file, worktrees) || !fs.existsSync(file)) continue;
    files.names.push(file);
    if (!fs.lstatSync(file).isSymbolicLink()) files.text.push(file);
  }
  return files;
}

function repositoryProductFiles(root: string): ProductFiles {
  const relativePaths = [
    ...gitLines(root, ['ls-files', '-z']),
    ...gitLines(root, ['ls-files', '--others', '--exclude-standard', '-z']),
  ];
  return productFiles(root, [...new Set(relativePaths)], registeredWorktrees(root));
}

function vsixNames(root: string, worktrees: string[] = registeredWorktrees(root), directory = root): string[] {
  const names: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      if (entry.name.toLowerCase().endsWith('.vsix')) names.push(file);
      continue;
    }
    if (entry.isDirectory()) {
      if (
        PRODUCT_OMITTED_SEGMENTS.has(entry.name) ||
        entry.name.startsWith('.tmp-') ||
        worktrees.some((worktree) => file === worktree)
      )
        continue;
      names.push(...vsixNames(root, worktrees, file));
    } else if (entry.name.toLowerCase().endsWith('.vsix')) {
      names.push(file);
    }
  }
  return names;
}

test('the product-text list includes tracked and nonignored untracked text', () => {
  const root = tempDir('product-files-');
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.md\n');
  fs.writeFileSync(path.join(root, 'tracked.md'), 'tracked');
  fs.writeFileSync(path.join(root, 'untracked.md'), 'untracked');
  fs.writeFileSync(path.join(root, 'ignored.md'), 'ignored');
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'note.md'), 'private');
  fs.writeFileSync(path.join(root, 'capture.cpuprofile'), 'capture');
  fs.writeFileSync(path.join(root, 'capture.cpuprofile.txt'), 'capture');
  fs.writeFileSync(path.join(root, 'arc-performance-2026.json'), '{}');
  fs.writeFileSync(path.join(root, 'product.json'), '{}');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'text');
  for (const args of [
    ['init'],
    [
      'add',
      '.gitignore',
      'tracked.md',
      '.claude/note.md',
      'capture.cpuprofile',
      'capture.cpuprofile.txt',
      'arc-performance-2026.json',
      'product.json',
      'notes.txt',
    ],
  ]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }

  const files = repositoryProductFiles(root);
  const names = files.names.map((file) => path.basename(file)).sort();
  assert.deepEqual(names, ['.gitignore', 'notes.txt', 'product.json', 'tracked.md', 'untracked.md']);
  assert.deepEqual(files.text.map((file) => path.basename(file)).sort(), names);
});

test('the product-text list preserves a symbolic-link name without reading through it', () => {
  const root = tempDir('product-link-');
  fs.mkdirSync(path.join(root, 'target'));
  fs.writeFileSync(path.join(root, 'target', 'inside.md'), 'text');
  fs.symlinkSync(path.join(root, 'target'), path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');

  const files = productFiles(root, ['link']);
  assert.deepEqual(
    files.names.map((file) => path.basename(file)),
    ['link'],
  );
  assert.deepEqual(files.text, []);
});

test('the product-text list excludes registered worktree paths', () => {
  const root = tempDir('product-worktree-');
  const worktree = path.join(root, 'worktree');
  fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(root, 'product.md'), 'product');
  fs.writeFileSync(path.join(worktree, 'other.md'), 'other');

  const files = productFiles(root, ['product.md', 'worktree', 'worktree/other.md'], [worktree]);
  assert.deepEqual(
    files.text.map((file) => path.basename(file)),
    ['product.md'],
  );
});

test.runIf(process.platform === 'win32')(
  'the worktree list keeps the current root when Git changes its path casing',
  () => {
    const root = tempDir('product-worktree-case-');
    fs.writeFileSync(path.join(root, 'product.md'), 'product');

    const files = productFiles(root, ['product.md'], nestedWorktrees(root, [root.toUpperCase()]));
    assert.deepEqual(
      files.text.map((file) => path.basename(file)),
      ['product.md'],
    );
  },
);

// Public text excludes the legacy product name. Build the pattern from separate words to exclude its own definition.

const LEGACY_WORDS = ['agent', 'timeline'];
const LEGACY_NAME = new RegExp(LEGACY_WORDS.join('[ _-]?'), 'gi');

test('the earlier product name appears nowhere', () => {
  const root = path.join(__dirname, '..', '..');
  const files = repositoryProductFiles(root).text;
  assert.ok(files.length > 40, `only ${files.length} files were read, so this guard measured almost nothing`);
  assert.ok(
    files.some((f) => f.includes(`plugins${path.sep}arc-hooks${path.sep}scripts${path.sep}lib.js`)),
    'the walk never reached the hooks',
  );

  const offenders: string[] = [];
  for (const file of files) {
    const relative = path.relative(root, file).replaceAll(path.sep, '/');
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        for (const match of line.matchAll(LEGACY_NAME)) {
          offenders.push(`${relative}:${i + 1} ${match[0]}`);
        }
      });
  }
  assert.deepEqual(offenders, [], `${offenders.join(', ')} uses the earlier product name. Say Arc.`);
});

function staleVsixNames(root: string, worktrees?: string[]): string[] {
  return vsixNames(root, worktrees).filter((file) => {
    const name = path.basename(file);
    return RETIRED.some((shape) => shape.test(name)) || name.includes(FOLDER);
  });
}

test('the VSIX-name scan catches ignored retired packages without reading them', () => {
  const root = tempDir('stale-vsix-');
  const stale = path.join(root, 'agent-diff-review.VSIX');
  fs.writeFileSync(path.join(root, '.gitignore'), '*.vsix\n');
  fs.writeFileSync(stale, Buffer.from([0, 255, 0]));

  assert.deepEqual(staleVsixNames(root, []), [stale]);
});

test('no build packaged under the retired name is left in the tree', () => {
  const root = path.join(__dirname, '..', '..');
  const named = staleVsixNames(root).map((file) => path.relative(root, file));
  assert.deepEqual(
    named,
    [],
    `${named.join(', ')} is named for the extension's retired name. A build under that name installs ` +
      'without complaint and leaves the reader on whatever panel it was packaged from. Delete it and ' +
      'package again.',
  );
});

test('stopping work stays scoped to the session whose Stop control was pressed', () => {
  const manifest = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8');
  const activation = fs.readFileSync(path.join(__dirname, 'extension.ts'), 'utf8');

  assert.doesNotMatch(
    manifest,
    /interruptAgent/,
    'the command palette still offers a workspace-wide stop beside the session Stop control',
  );
  sourceDoesNotMatch(
    activation,
    /Agent working|interruptAgent/,
    'the status bar still turns one ambiguous press into stops for every running session',
  );
  sourceMatch(
    activation,
    /busyInSession\(host\.states\(\), agent, sessionId\)/,
    'the session Stop control no longer selects work by agent and session',
  );
});

test('a session becoming busy immediately moves its Timeline card past Sending', () => {
  const activation = fs.readFileSync(path.join(__dirname, 'extension.ts'), 'utf8');
  // The whole handler, however many lines it runs to.
  const stateHandler = declarationSource(activation, 'onStateChange');

  sourceMatch(
    stateHandler,
    /publishHostedSessions\(\)/,
    'busy changes are not published until Codex emits another event, so the card stays on Sending',
  );
});

test('forgetting panel state also clears persisted usage and its reset timer', () => {
  const activation = fs.readFileSync(path.join(__dirname, 'extension.ts'), 'utf8');
  const [body] = callSources(activation, 'reg', 'arc.resetPanelState');

  assert.ok(body !== undefined, 'the forget command is not registered');
  sourceMatch(body, /usage\.clear\(\)/, 'remembered usage survives the forget command');
  sourceMatch(body, /usageResetTimer\.dispose\(\)/, 'the old reset timer survives the forget command');
  sourceMatch(body, /panel\.setUsage\(\[\]\)/, 'the visible usage bar survives the forget command');
  sourceMatch(
    body,
    /workspaceState\.update\(USAGE_KEY, undefined\)/,
    'a reload restores usage that the reader asked the panel to forget',
  );
  sourceMatch(body, /await usageWrites\.drain\(\)/, 'shutdown can race the queued write that clears remembered usage');
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
    assert.equal(
      version.stdout.trim(),
      JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8')).version,
    );
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

test.each(['win32', 'darwin', 'linux'] as const)(
  'private terminal publication follows admission and disposal on %s',
  async (platform) => {
    const values = new Map<string, string>();
    const collection = {
      persistent: true,
      description: undefined as unknown,
      clear: () => values.clear(),
      append: (key: string, value: string) => values.set(key, value),
      replace: (key: string, value: string) => values.set(key, value),
    };
    values.set('ARC_WINDOW', 'persisted-window');
    let admission: ToolAdmission | null = { root: 'software', identity: 'trusted-local-project' };
    let failure = false;
    let admissionFailure = false;
    const bin = platform === 'win32' ? 'C:/Arc Tools/release/launchers' : '/home/user/arc;tools/release/launchers';
    const owner = new TerminalTools(
      collection,
      () => {
        if (admissionFailure) throw new Error('Redirected ancestor: /fixture/redirected-root');
        return admission;
      },
      async () => {
        if (failure) throw new Error('storage unavailable');
        return bin;
      },
      '/editor',
      platform,
    );
    assert.equal(collection.persistent, false);
    assert.equal(values.size, 0);
    await owner.refresh();
    const entry = terminalToolPath(bin, platform)!;
    assert.deepEqual(
      [...values],
      [
        [entry.variable, entry.value],
        ['ARC_EDITOR_EXECUTABLE', '/editor'],
      ],
    );
    assert.equal(owner.current('actual-window').windowId, 'actual-window');
    assert.equal(owner.current(null).directory, bin);
    admission = null;
    assert.throws(() => owner.current('actual-window'), /unavailable/);
    assert.equal(values.size, 0);
    await owner.refresh();
    assert.equal(values.size, 0);
    admission = { root: 'software', identity: 'new-workspace' };
    failure = true;
    await owner.refresh();
    assert.equal(values.size, 0);
    assert.throws(
      () => owner.current('failed-window'),
      (error: Error) => {
        assert.match(error.message, /storage unavailable/);
        assert.match(error.message, /reload the window/i);
        return true;
      },
    );
    failure = false;
    await owner.refresh();
    assert.equal(values.size, 2);
    admissionFailure = true;
    assert.throws(
      () => owner.current('rejected-window'),
      (error: Error) => {
        assert.ok(error.message.includes('/fixture/redirected-root'));
        return true;
      },
    );
    assert.equal(values.size, 0);
    await owner.refresh();
    assert.throws(() => owner.current(null), /redirected-root/);
    assert.equal(values.size, 0);
    owner.dispose();
    assert.equal(values.size, 0);
    await owner.refresh();
    assert.equal(values.size, 0);
    assert.throws(() => owner.current(null), /unavailable/);
    assert.equal(terminalToolPath(platform === 'win32' ? 'C:/bad;entry' : '/bad:entry', platform), undefined);
  },
);

test('obsolete private preparation never publishes after admission changes or disposal', async () => {
  const values = new Map<string, string>();
  const collection = {
    persistent: true,
    description: undefined as unknown,
    clear: () => values.clear(),
    append: (key: string, value: string) => values.set(key, value),
    replace: (key: string, value: string) => values.set(key, value),
  };
  let admission: ToolAdmission | null = { root: 'one', identity: 'local' };
  let complete!: (directory: string) => void;
  let signal!: AbortSignal;
  const owner = new TerminalTools(
    collection,
    () => admission,
    async (_admission, wantedSignal) => {
      signal = wantedSignal;
      return new Promise<string>((resolve) => {
        complete = resolve;
      });
    },
    '/editor',
    'linux',
  );
  const first = owner.refresh();
  await vi.waitFor(() => assert.ok(complete));
  assert.throws(() => owner.current('waiting-window'), /preparing/);
  assert.equal(signal.aborted, false);
  admission = null;
  await owner.refresh();
  assert.equal(signal.aborted, true);
  complete('/obsolete');
  await first;
  assert.equal(values.size, 0);
  admission = { root: 'two', identity: 'local' };
  const second = owner.refresh();
  await vi.waitFor(() => assert.equal(signal.aborted, false));
  owner.dispose();
  complete('/disposed');
  await second;
  assert.equal(values.size, 0);
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

test('private ownership waits preserve retained locks until canceled', async () => {
  const root = tempDir('arc-retained-lock-');
  const file = path.join(root, '.install.lock');
  const lock = acquireToolLock(file);
  const bytes = fs.readFileSync(file);
  vi.useFakeTimers();
  try {
    const controller = new AbortController();
    let settled = false;
    const waiting = waitForToolLock(file, controller.signal);
    const canceled = assert.rejects(waiting, /canceled/).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(15_000);
    assert.equal(settled, false);
    assert.deepEqual(fs.readFileSync(file), bytes);
    controller.abort();
    await canceled;
    assert.deepEqual(fs.readFileSync(file), bytes);
  } finally {
    vi.useRealTimers();
    lock.release();
  }
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

test('the extension removes global setup and refreshes private tools with workspace admission', () => {
  const source = fs.readFileSync(path.join(extensionRoot, 'src/extension.ts'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));
  assert.doesNotMatch(
    source,
    /arc\.setupCommands|appendWindowsUserPath|installCommands|environmentVariableCollection\.append/,
  );
  assert.ok(
    !manifest.contributes.commands.some((command: { command: string }) => command.command === 'arc.setupCommands'),
  );
  assert.ok(
    !manifest.contributes.menus.commandPalette.some(
      (command: { command: string }) => command.command === 'arc.setupCommands',
    ),
  );
  assert.equal(
    manifest.contributes.commands.find((command: { command: string }) => command.command === 'arc.setupClaudeSnapshots')
      .title,
    'Set up Claude hooks',
  );
  sourceMatch(source, /if \(!vscode\.workspace\.isTrusted\) return null/);
  sourceMatch(source, /let privatePreparation = privateTools\.refresh\(\)/);
  sourceMatch(source, /context\.extensionMode === vscode\.ExtensionMode\.Development/);
  sourceMatch(
    source,
    /const refreshSnapshots = \(\) => \{\s*const preparation = \(privatePreparation = privateTools\.refresh\(\)\)/,
  );
  sourceMatch(source, /onDidGrantWorkspaceTrust\(refreshSnapshots\)/);
  sourceMatch(source, /onDidChangeWorkspaceFolders\(refreshSnapshots\)/);
});

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
  assert.equal(
    child.stdout.trim(),
    JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8')).version,
  );
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
  const packaged = spawnSync(process.execPath, ['scripts/package.mjs', '--out', archive], {
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
