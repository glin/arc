import { test, vi } from 'vitest';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tempDir } from './temproot.ts';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { readToolPackage, prepareEditorCommands } from './bundledtools.ts';
import { TerminalTools, terminalToolPath, type ToolAdmission } from './toolpath.ts';
import { childEnv } from './agenthost.ts';
import { acquireToolLock, waitForToolLock } from './toolownership.ts';
import { callSources, sourceDoesNotMatch, sourceMatch } from '../test/source-contract.ts';

import { extensionRoot, embeddedHostIdentity, extractedExtension } from '../test/packaging.ts';

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

test.each([false, true])(
  'extracted source builds without Git and never inherits an enclosing repository identity (enclosing repository: %s)',
  (enclosingRepository) => {
    const { root, sourceRoot, source } = extractedExtension('arc-archive-build-');
    const expected = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key) && key !== 'ARC_SOURCE_COMMIT'),
    );
    const archiveCommit = 'a'.repeat(40);
    {
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
      for (const explicit of [enclosingRepository]) {
        const identityEnv = explicit ? { ...buildEnv, ARC_SOURCE_COMMIT: archiveCommit } : buildEnv;
        const built = spawnSync(process.execPath, ['esbuild.mjs'], { cwd: source, encoding: 'utf8', env: identityEnv });
        assert.equal(built.status, 0, `extracted production build failed:\n${built.stderr}`);
        const identity = JSON.parse(fs.readFileSync(path.join(source, 'dist/build-identity.json'), 'utf8'));
        assert.equal(identity.sourceCommit, explicit ? archiveCommit : null);
        const cliRoot = path.join(sourceRoot, 'cli');
        if (!fs.existsSync(path.join(cliRoot, 'node_modules')))
          fs.symlinkSync(
            path.join(extensionRoot, 'node_modules'),
            path.join(cliRoot, 'node_modules'),
            process.platform === 'win32' ? 'junction' : 'dir',
          );
        const standaloneBuild = spawnSync(process.execPath, [path.join(cliRoot, 'build.mjs')], {
          cwd: root,
          encoding: 'utf8',
          env: identityEnv,
        });
        assert.equal(standaloneBuild.status, 0, standaloneBuild.stderr);
        const standalone = spawnSync(process.execPath, [path.join(cliRoot, 'dist/arc.cjs'), '--version'], {
          cwd: root,
          encoding: 'utf8',
          env: { ...identityEnv, PATH: '' },
        });
        assert.equal(standalone.status, 0, standalone.stderr);
        assert.equal(
          standalone.stdout.trim(),
          `${expected.version} (${explicit ? archiveCommit.slice(0, 12) : 'unknown'})`,
        );
        const cli = spawnSync(process.execPath, [path.join(source, 'dist/cli.cjs'), '--version'], {
          encoding: 'utf8',
          env: { ...identityEnv, PATH: '' },
        });
        assert.equal(cli.status, 0, cli.stderr);
        assert.equal(cli.stdout.trim(), `${expected.version} (${explicit ? archiveCommit.slice(0, 12) : 'unknown'})`);
        assert.equal(embeddedHostIdentity(path.join(source, 'dist/extension.js')).sourceCommit, identity.sourceCommit);
        assert.equal(identity.tools.sourceCommit, identity.sourceCommit);
        assert.equal(identity.dirty, null);
        assert.equal(identity.version, expected.version);
        assert.match(identity.inputsSha256, /^[a-f0-9]{64}$/);
        assert.equal(
          identity.extensionSha256,
          createHash('sha256')
            .update(fs.readFileSync(path.join(source, 'dist/extension.js')))
            .digest('hex'),
        );
      }
    }

    if (!enclosingRepository) return;
    const git = (args: string[]) => {
      const result = spawnSync('git', args, { cwd: sourceRoot, encoding: 'utf8', env });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git(['init']);
    fs.writeFileSync(path.join(sourceRoot, '.git/info/exclude'), '*\n');
    git(['add', '-f', 'cli/src/main.ts']);
    git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'source fixture',
    ]);
    const fixtureCommit = git(['rev-parse', 'HEAD']);
    for (const dirty of [false, true]) {
      if (dirty) fs.appendFileSync(path.join(sourceRoot, 'cli/src/main.ts'), '\n// Changed source fixture\n');
      for (const [script, cwd, bundle] of [
        ['esbuild.mjs', source, path.join(source, 'dist/cli.cjs')],
        [path.join(sourceRoot, 'cli/build.mjs'), root, path.join(sourceRoot, 'cli/dist/arc.cjs')],
      ]) {
        const built = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8', env });
        assert.equal(built.status, 0, built.stderr);
        const version = spawnSync(process.execPath, [bundle, '--version'], {
          cwd: root,
          encoding: 'utf8',
          env: { ...env, PATH: '' },
        });
        assert.equal(version.status, 0, version.stderr);
        assert.equal(
          version.stdout.trim(),
          `${expected.version} (${fixtureCommit.slice(0, 12)}${dirty ? '-dirty' : ''})`,
        );
      }
    }
  },
  90_000,
);

test('watch startup invalidates identity from a preceding production build', async () => {
  const { source } = extractedExtension('arc-watch-startup-');
  const identity = path.join(source, 'dist', 'build-identity.json');
  fs.mkdirSync(path.dirname(identity), { recursive: true });
  fs.writeFileSync(identity, JSON.stringify({ version: '1.0.0', sourceCommit: 'a'.repeat(40), dirty: false }));
  assert.ok(fs.existsSync(identity));
  const watcher = spawn(process.execPath, ['esbuild.mjs', '--watch'], { cwd: source, stdio: 'ignore' });
  try {
    await vi.waitFor(() => assert.equal(fs.existsSync(identity), false), { timeout: 15_000 });
  } finally {
    const exited =
      watcher.exitCode !== null
        ? Promise.resolve()
        : new Promise<void>((resolve) => watcher.once('exit', () => resolve()));
    watcher.kill();
    await exited;
  }
}, 30_000);

test('CLI watching survives panel rebuilds and ends when the build closes', async () => {
  const { root, sourceRoot, source } = extractedExtension('arc-cli-watch-');
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
      'watch fixture',
    ],
  ]) {
    const git = spawnSync('git', args, { cwd: sourceRoot, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);
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
    assert.equal(
      version.stdout.trim(),
      `${JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).version} (unknown)`,
    );
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
    const committed = spawnSync(
      'git',
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
        'next watch revision',
      ],
      { cwd: sourceRoot, encoding: 'utf8' },
    );
    assert.equal(committed.status, 0, committed.stderr);
    fs.appendFileSync(path.join(sourceRoot, 'cli/src/main.ts'), "\nconsole.log('cli watch fixture');\n");
    await vi.waitFor(
      () => assert.ok(fs.readFileSync(path.join(source, 'dist/cli.cjs'), 'utf8').includes('cli watch fixture')),
      { timeout: 15_000 },
    );
    assert.match(launch().stdout, /cli watch fixture/);
    assert.ok(launch().stdout.includes('(unknown)'));
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

test('the session skill stays within its per-invocation size budget and links only to files it ships', () => {
  const source = path.join(extensionRoot, '../cli/skills/arc-sessions');
  const definition = fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8');
  // Every invocation pays for SKILL.md in context, so the file the agent reads first stays small and detail lives in reference files.
  assert.ok(Buffer.byteLength(definition) <= 7_000, 'SKILL.md is over its 7,000 byte limit');
  const linked = [...definition.matchAll(/\]\(([\w-]+\.md)(?:#[^)]*)?\)/g)].map((match) => match[1]);
  assert.ok(linked.length > 0);
  for (const file of linked) assert.equal(fs.lstatSync(path.join(source, file)).isFile(), true, file);
});

test.each([false, true])(
  'rebuilding bundled tools leaves no scratch folders and preserves link targets (redirected output: %s)',
  async (redirected) => {
    const root = tempDir('arc-tool-rebuild-');
    const dist = path.join(root, 'extension/dist');
    const destination = path.join(dist, 'tools');
    const retained = path.join(root, 'retained');
    fs.mkdirSync(dist, { recursive: true });
    fs.mkdirSync(retained);
    fs.writeFileSync(path.join(dist, 'cli.cjs'), 'first CLI');
    fs.writeFileSync(path.join(dist, 'windowpipe.exe'), 'pipe');
    const { bundledTools } = await import(pathToFileURL(path.join(extensionRoot, 'scripts/bundled-tools.mjs')).href);
    bundledTools(dist, path.dirname(extensionRoot), {});
    if (redirected) {
      fs.rmSync(destination, { recursive: true });
      fs.symlinkSync(retained, destination, process.platform === 'win32' ? 'junction' : 'dir');
    }
    fs.writeFileSync(path.join(destination, 'obsolete'), 'old output');
    fs.writeFileSync(path.join(dist, 'cli.cjs'), 'second CLI');
    bundledTools(dist, path.dirname(extensionRoot), {});
    assert.equal(fs.readFileSync(path.join(destination, 'cli/arc.cjs'), 'utf8'), 'second CLI');
    assert.equal(fs.existsSync(path.join(destination, 'obsolete')), false);
    assert.equal(fs.lstatSync(destination).isSymbolicLink(), false);
    assert.deepEqual(fs.readdirSync(path.dirname(dist)), ['dist']);
    assert.deepEqual(fs.readdirSync(retained), redirected ? ['obsolete'] : []);
    fs.rmSync(path.join(dist, 'windowpipe.exe'));
    assert.throws(() => bundledTools(dist, path.dirname(extensionRoot), {}), /ENOENT/);
    assert.deepEqual(fs.readdirSync(path.dirname(dist)), ['dist']);
    assert.deepEqual(fs.readdirSync(retained), redirected ? ['obsolete'] : []);
  },
);

test('the bundler refuses a session skill that lacks a file its SKILL.md links', async () => {
  const root = tempDir('arc-skill-links-');
  const sourceRoot = path.join(root, 'source');
  const dist = path.join(root, 'extension/dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'cli.cjs'), '');
  fs.writeFileSync(path.join(dist, 'windowpipe.exe'), '');
  fs.mkdirSync(sourceRoot);
  fs.copyFileSync(path.join(extensionRoot, '../LICENSE'), path.join(sourceRoot, 'LICENSE'));
  fs.cpSync(path.join(extensionRoot, '../plugins'), path.join(sourceRoot, 'plugins'), { recursive: true });
  fs.cpSync(path.join(extensionRoot, '../cli/skills'), path.join(sourceRoot, 'cli/skills'), { recursive: true });
  const { bundledTools } = await import(pathToFileURL(path.join(extensionRoot, 'scripts/bundled-tools.mjs')).href);
  assert.ok(bundledTools(dist, sourceRoot, {}).identity.files['skills/arc-sessions/compaction.md']);
  const linkedFile = path.join(sourceRoot, 'cli/skills/arc-sessions/compaction.md');
  fs.rmSync(linkedFile);
  assert.throws(() => bundledTools(dist, sourceRoot, {}), /lacks compaction\.md/);
  fs.mkdirSync(linkedFile);
  assert.throws(() => bundledTools(dist, sourceRoot, {}), /lacks compaction\.md/);
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
