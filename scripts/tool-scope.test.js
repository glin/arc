const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repositoryRoot = path.join(__dirname, '..');

function toolBin(name) {
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

test('root formatting and lint commands exclude private run source and configurations', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-ship-log-scope-'));
  const scripts = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')).scripts;
  const savedRoots = [
    path.join(root, '.claude', 'ship-logs', 'run', 'implementation', 'before-format'),
    path.join(root, '.claude', 'plans', 'task', 'runs', 'run', 'implementation', 'before-format'),
  ];
  const savedSources = savedRoots.map((savedRoot) => path.join(savedRoot, 'extension', 'src', 'transcript.ts'));
  const maintainedSource = path.join(root, 'plugins', 'arc-hooks', 'scripts', 'stop-manifest.cjs');
  const brokenSource = 'const value={answer:42}; debugger; console.log(value);\n';
  try {
    fs.mkdirSync(path.dirname(maintainedSource), { recursive: true });
    for (const name of ['.oxfmtrc.json', '.oxlintrc.jsonc']) {
      fs.copyFileSync(path.join(repositoryRoot, name), path.join(root, name));
      for (const savedRoot of savedRoots) {
        fs.mkdirSync(path.join(savedRoot, 'extension', 'src'), { recursive: true });
        fs.copyFileSync(path.join(repositoryRoot, name), path.join(savedRoot, name));
      }
    }
    fs.copyFileSync(path.join(repositoryRoot, '.gitignore'), path.join(root, '.gitignore'));
    for (const savedSource of savedSources) fs.writeFileSync(savedSource, brokenSource);
    fs.writeFileSync(maintainedSource, 'console.log(42);\n');

    for (const script of ['format:check', 'lint', 'format']) {
      const [tool, ...args] = scripts[script].split(' ');
      const result = runTool(tool, args, root);
      assert.equal(result.status, 0, `${script} scanned saved source:\n${result.stdout}${result.stderr}`);
      for (const savedSource of savedSources) {
        assert.equal(fs.readFileSync(savedSource, 'utf8'), brokenSource, `${script} rewrote saved evidence`);
      }
    }

    fs.writeFileSync(maintainedSource, brokenSource);
    for (const script of ['format:check', 'lint']) {
      const [tool, ...args] = scripts[script].split(' ');
      const result = runTool(tool, args, root);
      assert.notEqual(result.status, 0, `${script} skipped maintained source`);
      assert.ok((result.stdout + result.stderr).includes('stop-manifest.cjs'));
    }
  } finally {
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
