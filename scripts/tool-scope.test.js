const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repositoryRoot = path.join(__dirname, '..');

function toolBin(name) {
  if (name === 'npm') return process.env.npm_execpath;
  const packageFile = require.resolve(`${name}/package.json`);
  const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  return path.join(path.dirname(packageFile), manifest.bin[name]);
}

function runTool(name, args, cwd) {
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = [path.join(repositoryRoot, 'node_modules', '.bin'), env[pathKey]].filter(Boolean).join(path.delimiter);
  return spawnSync(process.execPath, [toolBin(name), ...args], { cwd, encoding: 'utf8', env });
}

function copyStylelintConfig(root) {
  fs.writeFileSync(
    path.join(root, '.stylelintrc.cjs'),
    `module.exports = { ...require(${JSON.stringify(path.join(repositoryRoot, '.stylelintrc.cjs'))}), extends: ${JSON.stringify(path.join(repositoryRoot, 'node_modules', 'stylelint-config-recommended', 'index.js'))} };\n`,
  );
  const formatted = runTool(
    'oxfmt',
    ['--config', path.join(repositoryRoot, '.oxfmtrc.mjs'), path.join(root, '.stylelintrc.cjs')],
    root,
  );
  assert.equal(formatted.status, 0, formatted.stderr);
}

function runScript(script, cwd) {
  return runTool('npm', ['run', script], cwd);
}

test('root formatting and lint commands exclude private run source and configurations', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-ship-log-scope-'));
  const savedRoots = [
    path.join(root, '.claude', 'ship-logs', 'run', 'implementation', 'before-format'),
    path.join(root, '.claude', 'plans', 'task', 'runs', 'run', 'implementation', 'before-format'),
  ];
  const savedSources = [
    ...savedRoots.map((savedRoot) => path.join(savedRoot, 'extension', 'src', 'transcript.ts')),
    path.join(root, 'diagnostic-export.js'),
    path.join(root, 'saved-session', 'extension', 'src', 'transcript.ts'),
  ];
  const maintainedSource = path.join(root, 'plugins', 'arc-hooks', 'scripts', 'stop-manifest.cjs');
  const brokenSource = 'const value={answer:42}; debugger; console.log(value);\n';
  try {
    fs.mkdirSync(path.dirname(maintainedSource), { recursive: true });
    fs.copyFileSync(path.join(repositoryRoot, 'package.json'), path.join(root, 'package.json'));
    for (const name of ['.oxfmtrc.mjs', '.oxlintrc.jsonc']) {
      fs.copyFileSync(path.join(repositoryRoot, name), path.join(root, name));
      for (const savedRoot of savedRoots) {
        fs.mkdirSync(path.join(savedRoot, 'extension', 'src'), { recursive: true });
        fs.copyFileSync(path.join(repositoryRoot, name), path.join(savedRoot, name));
      }
    }
    fs.copyFileSync(path.join(repositoryRoot, '.gitignore'), path.join(root, '.gitignore'));
    copyStylelintConfig(root);
    fs.mkdirSync(path.join(root, 'extension', 'src', 'webview'), { recursive: true });
    fs.writeFileSync(path.join(root, 'extension', 'src', 'webview', 'panel.css'), 'a {\n  color: red;\n}\n');
    for (const savedSource of savedSources) {
      fs.mkdirSync(path.dirname(savedSource), { recursive: true });
      fs.writeFileSync(savedSource, brokenSource);
    }
    fs.writeFileSync(maintainedSource, 'console.log(42);\n');

    const rootSource = path.join(root, 'vitest.config.mts');
    fs.writeFileSync(rootSource, brokenSource);
    for (const [name, args] of [
      ['oxfmt', ['--config', '.oxfmtrc.mjs', '--disable-nested-config', '--check']],
      ['oxlint', ['--disable-nested-config', '--deny-warnings']],
    ]) {
      const result = runTool(name, args, root);
      const output = result.stdout + result.stderr;
      assert.notEqual(result.status, 0, `${name} skipped maintained root source`);
      assert.match(output, /vitest\.config\.mts/);
      for (const savedSource of savedSources) assert.ok(!output.includes(path.basename(savedSource)), output);
    }
    fs.unlinkSync(rootSource);

    for (const script of ['format:check', 'lint', 'format']) {
      const result = runScript(script, root);
      assert.equal(result.status, 0, `${script} scanned saved source:\n${result.stdout}${result.stderr}`);
      for (const savedSource of savedSources) {
        assert.equal(fs.readFileSync(savedSource, 'utf8'), brokenSource, `${script} rewrote saved evidence`);
      }
    }

    fs.writeFileSync(maintainedSource, brokenSource);
    for (const script of ['format:check', 'lint']) {
      const result = runScript(script, root);
      assert.notEqual(result.status, 0, `${script} skipped maintained source`);
      assert.ok((result.stdout + result.stderr).includes('stop-manifest.cjs'));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CSS entrypoints reject malformed declarations, unknown properties and values within production scope', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-css-scope-'));
  const css = path.join(root, 'extension', 'src', 'webview', 'panel.css');
  const valid = 'a { color: var(--vscode-foreground, red); display: block; display: flex; }\n';
  try {
    fs.mkdirSync(path.dirname(css), { recursive: true });
    fs.copyFileSync(path.join(repositoryRoot, 'package.json'), path.join(root, 'package.json'));
    fs.copyFileSync(path.join(repositoryRoot, '.oxlintrc.jsonc'), path.join(root, '.oxlintrc.jsonc'));
    copyStylelintConfig(root);
    fs.writeFileSync(
      path.join(path.dirname(css), '.stylelintrc.cjs'),
      "module.exports = { rules: { 'property-no-unknown': null } };\n",
    );
    fs.writeFileSync(css, valid);
    const excluded = [
      '.claude/plans/task/runs/run/extension/src/webview/panel.css',
      '.claude/ship-logs/run/extension/src/webview/panel.css',
      '.claude/skills/panel-mockup/panel.css',
      'evals/agent-review/fixtures/panel.css',
      'extension/test/fixtures/panel.css',
      'extension/src/webview/nested/panel.css',
      'extension/dist/panel.css',
    ];
    for (const file of excluded) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), 'a { colro: red; }\n');
    }
    for (const script of ['lint:css', 'lint']) {
      const passed = runScript(script, root);
      assert.equal(passed.status, 0, `${script}:\n${passed.stdout}${passed.stderr}`);
      const inputs = ['a { color red; }\n', 'a { colro: red; }\n', 'a { display: invalid; }\n'];
      for (const broken of script === 'lint' ? inputs.slice(0, 1) : inputs) {
        fs.writeFileSync(css, broken);
        const failed = runScript(script, root);
        assert.notEqual(failed.status, 0, `${script} skipped invalid production CSS`);
        assert.match(failed.stdout + failed.stderr, /panel\.css/);
      }
      fs.writeFileSync(css, valid);
    }
    for (const file of excluded) assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), 'a { colro: red; }\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CSS token exceptions retain validation of neighboring declarations and media values', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-css-tokens-'));
  const css = path.join(root, 'extension', 'src', 'webview', 'panel.css');
  const valid = `a {
  flex: 0 0 __ARC_RAIL_WIDTH_DEFAULT__px;
  color: var(--vscode-foreground, var(--local, red));
  background: color-mix(in srgb, red 50%, transparent);
  clip: rect(0, 0, 0, 0);
}
@media (max-width: __ARC_RAIL_MIN_WIDTH_LESS_ONE__px) { a { display: none; } }
@container (width < 20em) { a { display: block; } }
`;
  try {
    fs.mkdirSync(path.dirname(css), { recursive: true });
    copyStylelintConfig(root);
    fs.writeFileSync(css, valid);
    const lint = () => runTool('stylelint', ['--config', '.stylelintrc.cjs', '--max-warnings', '0', css], root);
    const passed = lint();
    assert.equal(passed.status, 0, passed.stdout + passed.stderr);
    const cases = [
      [valid.replace('color: var', 'colro: var'), 'property-no-unknown'],
      [valid.replace('color: var', 'flex: invalid; color: var'), 'declaration-property-value-no-unknown'],
      [
        valid.replace('0 0 __ARC_RAIL_WIDTH_DEFAULT__px', 'invalid __ARC_RAIL_WIDTH_DEFAULT__px'),
        'declaration-property-value-no-unknown',
      ],
      [valid + '@media (max-width: invalid) { a { display: block; } }\n', 'media-feature-name-value-no-unknown'],
      [valid.replace('__ARC_RAIL_MIN_WIDTH_LESS_ONE__px', '__ARC_UNKNOWN__px'), 'media-feature-name-value-no-unknown'],
    ];
    for (const [broken, rule] of cases) {
      fs.writeFileSync(css, broken);
      const failed = lint();
      assert.notEqual(failed.status, 0, `token exception hid ${rule}`);
      assert.ok((failed.stdout + failed.stderr).includes(rule));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result;
}

function hookFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-css-hook-'));
  git(root, 'init', '--quiet');
  const hook = path.join(root, '.git', 'hooks', 'pre-commit');
  fs.copyFileSync(path.join(repositoryRoot, '.githooks', 'pre-commit'), hook);
  fs.chmodSync(hook, 0o755);
  copyStylelintConfig(root);
  const bins = path.join(root, 'node_modules', '.bin');
  fs.mkdirSync(bins, { recursive: true });
  for (const name of ['oxfmt', 'oxlint', 'stylelint']) {
    const source =
      name === 'stylelint'
        ? `#!/bin/sh\nexec '${process.execPath.replaceAll('\\', '/')}' '${toolBin(name).replaceAll('\\', '/')}' "$@"\n`
        : '#!/bin/sh\nexit 0\n';
    fs.writeFileSync(path.join(bins, name), source, { mode: 0o755 });
  }
  return {
    root,
    write(file, text) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    },
    run(cwd = root) {
      return spawnSync('git', ['-c', 'core.hooksPath=' + path.dirname(hook), 'hook', 'run', 'pre-commit'], {
        cwd,
        encoding: 'utf8',
      });
    },
  };
}

test('pre-commit checks staged CSS with literal paths and preserves partial staging and scope', () => {
  const fixture = hookFixture();
  const { root } = fixture;
  const css = 'extension/src/webview/panel [copy] space.css';
  try {
    fixture.write(css, 'a { colro: red; }\n');
    git(root, 'add', '--', css);
    const failed = fixture.run();
    assert.notEqual(failed.status, 0, 'pre-commit skipped staged CSS');
    assert.match(failed.stdout + failed.stderr, /property-no-unknown/);
    fixture.write(css, 'a { color: red; }\n');
    const partial = fixture.run();
    assert.equal(partial.status, 0, partial.stdout + partial.stderr);
    assert.match(partial.stderr, /partly staged/);
    assert.match(git(root, 'show', ':' + css).stdout, /colro/);
    git(root, 'add', '--', css);
    for (const file of [
      'evals/agent-review/fixtures/invalid.css',
      '.claude/plans/invalid.css',
      'extension/src/webview/nested/invalid.css',
    ]) {
      fixture.write(file, 'a { colro: red; }\n');
      git(root, 'add', '--', file);
    }
    const passed = fixture.run();
    assert.equal(passed.status, 0, passed.stdout + passed.stderr);
    fs.unlinkSync(path.join(root, 'node_modules', '.bin', 'stylelint'));
    const missing = fixture.run();
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /stylelint is not installed/);
    git(root, 'rm', '--cached', '--', css);
    const excludedOnly = fixture.run();
    assert.equal(excludedOnly.status, 0, excludedOnly.stdout + excludedOnly.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test('pre-commit skips staged symbolic links', (context) => {
  const fixture = hookFixture();
  const { root } = fixture;
  const css = 'extension/src/webview/linked.css';
  try {
    fixture.write('target.css', 'a { colro: red; }\n');
    fs.mkdirSync(path.dirname(path.join(root, css)), { recursive: true });
    try {
      fs.symlinkSync(path.join(root, 'target.css'), path.join(root, css), 'file');
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        context.skip('Creating symbolic links requires permission on this host.');
        return;
      }
      throw error;
    }
    git(root, 'add', '--', css);
    const result = fixture.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pre-commit resolves CSS tools from the main worktree when the checkout has none', () => {
  const fixture = hookFixture();
  const { root } = fixture;
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-css-checkout-'));
  try {
    fs.cpSync(
      path.join(repositoryRoot, 'node_modules', 'stylelint-config-recommended'),
      path.join(root, 'node_modules', 'stylelint-config-recommended'),
      { recursive: true },
    );
    git(root, 'config', 'core.worktree', checkout);
    fs.writeFileSync(path.join(checkout, '.git'), `gitdir: ${path.join(root, '.git').replaceAll('\\', '/')}\n`);
    fs.copyFileSync(path.join(repositoryRoot, '.stylelintrc.cjs'), path.join(checkout, '.stylelintrc.cjs'));
    fixture.write('.stylelintrc.cjs', "throw new Error('The checkout configuration must be used.');\n");
    assert.equal(fs.existsSync(path.join(checkout, 'node_modules')), false);
    const css = path.join(checkout, 'extension', 'src', 'webview', 'panel.css');
    fs.mkdirSync(path.dirname(css), { recursive: true });
    fs.writeFileSync(css, 'a { color: red; }\n');
    git(checkout, 'add', 'extension/src/webview/panel.css');
    const passed = fixture.run(checkout);
    assert.equal(passed.status, 0, passed.stdout + passed.stderr);
    fs.writeFileSync(css, 'a { colro: red; }\n');
    git(checkout, 'add', 'extension/src/webview/panel.css');
    const failed = fixture.run(checkout);
    assert.notEqual(failed.status, 0);
    assert.match(failed.stdout + failed.stderr, /property-no-unknown/);
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the maintained hook filenames are discovered by Oxfmt and Oxlint', () => {
  for (const name of ['pretooluse-snapshot.cjs', 'stop-manifest.cjs']) {
    assert.equal(fs.existsSync(path.join(repositoryRoot, 'plugins', 'arc-hooks', 'scripts', name)), true);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-tool-scope-'));
  try {
    fs.mkdirSync(path.join(root, 'plugins', 'arc-hooks', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, '.oxfmtrc.json'), '{}');
    fs.writeFileSync(path.join(root, '.oxlintrc.json'), JSON.stringify({ rules: { 'no-debugger': 'error' } }));
    const hooks = ['pretooluse-snapshot.cjs', 'stop-manifest.cjs'];
    for (const hook of hooks) {
      fs.writeFileSync(
        path.join(root, 'plugins', 'arc-hooks', 'scripts', hook),
        'const value={answer:42}; debugger;\n',
      );
    }

    const format = runTool('oxfmt', ['--check', '.'], root);
    assert.notEqual(format.status, 0, 'Oxfmt skipped a maintained .cjs hook path');
    for (const hook of hooks) {
      assert.ok((format.stdout + format.stderr).includes(hook));
    }

    const lint = runTool('oxlint', ['--deny-warnings', '.'], root);
    assert.notEqual(lint.status, 0, 'Oxlint skipped a maintained .cjs hook path');
    for (const hook of hooks) {
      assert.ok((lint.stdout + lint.stderr).includes(hook));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
