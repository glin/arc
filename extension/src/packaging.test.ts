// extension/src/packaging.test.ts
import { beforeAll, test, vi } from 'vitest';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tempDir } from './temproot.ts';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { buildSync } from 'esbuild';
import { browserBundle } from './panelbundle.ts';
import { callSources, declarationSource, sourceDoesNotMatch, sourceMatch } from '../test/source-contract.ts';

const extensionRoot = path.join(__dirname, '..');

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
        ...browserBundle().inputs,
        'src/webview/panel.css',
        'package.json',
        'esbuild.mjs',
        'src/panelbundle.ts',
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

test('extracted source builds without Git and never inherits an enclosing repository identity', () => {
  const root = tempDir('arc-archive-build-');
  const archive = path.join(root, 'source.tar');
  const sourceRoot = path.join(root, 'source');
  fs.mkdirSync(sourceRoot);
  const archived = spawnSync('git', ['archive', '--format=tar', '-o', archive, 'HEAD', 'extension'], {
    cwd: path.dirname(extensionRoot),
    encoding: 'utf8',
  });
  assert.equal(archived.status, 0, archived.stderr);
  const extracted = spawnSync('tar', ['-xf', archive, '-C', sourceRoot], { encoding: 'utf8' });
  assert.equal(extracted.status, 0, extracted.stderr);
  const source = path.join(sourceRoot, 'extension');
  fs.copyFileSync(path.join(extensionRoot, 'esbuild.mjs'), path.join(source, 'esbuild.mjs'));
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
});

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
    ['LICENSE', 'dist/build-identity.json', 'dist/extension.js', 'package.json'].sort(),
    'the VSIX candidate list changed; review the new file and update this allowlist only when it belongs',
  );
});

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
    /panel\.setRunning\(/,
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
