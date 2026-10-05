import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/warm.json', import.meta.url), 'utf8'));
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
fixture.prompt_cache.expires_at = Math.ceil(Date.now() / 1000) + 300;
const input = JSON.stringify(fixture);
const cli = fileURLToPath(new URL('../dist/arc-status.cjs', import.meta.url));

test('the bundled CLI reports the package version', () => {
  const output = execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });
  assert.equal(output.trim(), packageJson.version);
});

test('the bundled CLI reads Claude JSON and emits its versioned JSON contract', () => {
  const output = execFileSync(process.execPath, [cli, 'statusline', '--json'], {
    input,
    encoding: 'utf8',
  });
  const parsed = JSON.parse(output);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.context.maxTokens, 200_000);
  assert.equal(parsed.cache.state, 'warm');
  assert.equal(parsed.nextTurn.state, 'warm');
  assert.equal(parsed.workspace.name, 'arc');
  assert.equal(parsed.session.estimatedCostDollars, 0.1234);
  assert.equal(parsed.limits.fiveHour.usedPercentage, 23.5);
});

test('the bundled CLI emits a compact text status line', () => {
  const output = execFileSync(process.execPath, [cli, 'statusline', '--width', '70'], {
    input,
    encoding: 'utf8',
  });
  const [primary, secondary] = output.trimEnd().split('\n');
  assert.match(primary, /^ctx 8% of 200k \(16k\) \| cache warm .* \| next turn starts at \$0\.02$/);
  assert.equal(secondary, 'session $0.12, 45s | 5h 23.5% | 7d 41.2%');
});

test('the bundled CLI emits only the next-turn segment for another status line', () => {
  const output = execFileSync(process.execPath, [cli, 'statusline', '--next-turn'], {
    input,
    encoding: 'utf8',
  });
  assert.equal(output, 'next turn starts at $0.02\n');
});

test('the bundled CLI rejects malformed JSON without writing status output', () => {
  const result = spawnSync(process.execPath, [cli, 'statusline'], {
    input: '{',
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'arc-status: Claude status input is not valid JSON.\n');
});

test('the bundled cost command reads isolated roots and reports failures on stderr', () => {
  const root = mkdtempSync(join(tmpdir(), 'arc-cost-smoke-'));
  const projects = join(root, 'projects');
  const codex = join(root, 'sessions');
  const file = join(projects, 'sample', 'session-1.jsonl');
  mkdirSync(join(projects, 'sample'), { recursive: true });
  mkdirSync(codex, { recursive: true });
  writeFileSync(
    file,
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
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: root,
    CODEX_HOME: root,
    ARC_PROJECTS_ROOT: projects,
    ARC_CODEX_ROOT: codex,
  };
  try {
    const result = spawnSync(process.execPath, [cli, 'cost', 'session-1'], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.schemaVersion, 2);
    assert.match(report.buildCommit, /^[0-9a-f]{40}$/);
    assert.equal(report.source.file, file);
    assert.equal(report.parent.requests, 1);
    assert.equal('modelCosts' in report.parent, false);
    const detail = spawnSync(process.execPath, [cli, 'cost', file, '--source-only', '--by-model'], {
      env,
      encoding: 'utf8',
    });
    assert.equal(detail.status, 0, detail.stderr);
    const flagged = JSON.parse(detail.stdout);
    const { modelCosts, ...parent } = flagged.parent;
    assert.deepEqual(parent, report.parent);
    assert.deepEqual(flagged.children, []);
    assert.deepEqual(flagged.combined, parent);
    assert.equal(modelCosts[0].model, 'claude-opus-5');
    assert.equal(modelCosts[0].requests, 1);
    const rejected = spawnSync(process.execPath, [cli, 'cost', 'session-1', '--source-only'], {
      env,
      encoding: 'utf8',
    });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /requires an existing transcript file path/);
    const failure = spawnSync(process.execPath, [cli, 'cost', 'missing'], { env, encoding: 'utf8' });
    assert.equal(failure.status, 1);
    assert.equal(failure.stdout, '');
    assert.match(failure.stderr, /No transcript found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the packed package installs both commands globally, replaces the old package, and runs locally offline', () => {
  const root = mkdtempSync(join(tmpdir(), 'arc-installed-smoke-'));
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  const consumer = join(root, 'consumer');
  const prefix = join(root, 'global');
  const replacement = join(root, 'replacement');
  const oldPackage = join(root, 'old-package');
  const packable = join(root, 'package');
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, 'Run packaging smoke tests through npm.');
  mkdirSync(consumer);
  mkdirSync(join(packable, 'dist'), { recursive: true });
  for (const file of ['package.json', 'README.md', 'LICENSE', 'dist/arc-status.cjs']) {
    copyFileSync(join(packageRoot, file), join(packable, file));
  }
  writeFileSync(join(packable, 'dist/obsolete.cjs'), 'obsolete bundle');
  writeFileSync(join(packable, 'dist/arc-status.cjs.map'), 'source map');
  mkdirSync(join(oldPackage, 'dist'), { recursive: true });
  writeFileSync(join(root, 'user.npmrc'), '');
  writeFileSync(join(root, 'global.npmrc'), '');
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'arc-smoke-consumer', private: true }));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith('npm_config_'))),
    npm_config_userconfig: join(root, 'user.npmrc'),
    npm_config_globalconfig: join(root, 'global.npmrc'),
    npm_config_cache: join(root, 'cache'),
    npm_config_prefix: prefix,
    npm_config_registry: 'http://127.0.0.1:9',
    npm_config_offline: 'true',
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    CLAUDE_CONFIG_DIR: root,
    CODEX_HOME: root,
    ARC_PROJECTS_ROOT: join(root, 'projects'),
    ARC_CODEX_ROOT: join(root, 'sessions'),
  };
  const options = { cwd: consumer, env, encoding: 'utf8', timeout: 30_000 };
  function npm(args, cwd = consumer) {
    const result = spawnSync(process.execPath, [npmCli, ...args], { ...options, cwd });
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  }
  function installed(installPrefix, command, args, stdin) {
    const launcher = join(installPrefix, process.platform === 'win32' ? `${command}.cmd` : `bin/${command}`);
    if (process.platform === 'win32') {
      assert.ok(lstatSync(launcher).isFile());
    } else {
      assert.ok(lstatSync(launcher).isSymbolicLink());
      assert.ok(lstatSync(realpathSync(launcher)).mode & 0o111);
    }
    const result =
      process.platform === 'win32'
        ? spawnSync('cmd.exe', ['/d', '/s', '/c', `call "${launcher}" ${args.map((arg) => `"${arg}"`).join(' ')}`], {
            ...options,
            windowsVerbatimArguments: true,
            input: stdin,
          })
        : spawnSync(launcher, args, { ...options, input: stdin });
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.error ?? ''}\n${result.stderr}`);
    return result.stdout;
  }
  try {
    const [packed] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', root], packable));
    const tarball = join(root, packed.filename);
    assert.deepEqual(packed.files.map(({ path }) => path).sort(), [
      'LICENSE',
      'README.md',
      'dist/arc-status.cjs',
      'package.json',
    ]);
    npm(['install', '--global', '--prefix', prefix, tarball]);
    const installedRoot = join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', '@glin/arc');
    const manifest = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8'));
    assert.equal(manifest.name, '@glin/arc');
    assert.equal(manifest.license, 'MIT');
    assert.equal(manifest.private, undefined);
    assert.equal(manifest.publishConfig.access, 'public');
    assert.deepEqual(manifest.repository, {
      type: 'git',
      url: 'git+https://github.com/glin/arc.git',
      directory: 'cli',
    });
    assert.equal(manifest.homepage, 'https://github.com/glin/arc/tree/main/cli#readme');
    assert.equal(manifest.bugs.url, 'https://github.com/glin/arc/issues');
    assert.equal(
      readFileSync(join(installedRoot, 'README.md'), 'utf8'),
      readFileSync(join(packageRoot, 'README.md'), 'utf8'),
    );
    assert.deepEqual(
      readFileSync(join(installedRoot, 'LICENSE')),
      readFileSync(new URL('../../LICENSE', import.meta.url)),
    );
    const transcript = join(consumer, 'session.jsonl');
    copyFileSync(new URL('./fixtures/stream/five-requests-jsonl.jsonl', import.meta.url), transcript);
    const costArgs = ['cost', transcript, '--source-only', '--by-model'];
    const expectedCost = JSON.parse(execFileSync(process.execPath, [cli, ...costArgs], options));
    const installedInput = JSON.stringify({
      ...fixture,
      prompt_cache: { ...fixture.prompt_cache, expires_at: 1 },
    });
    const expectedStatus = JSON.parse(
      execFileSync(process.execPath, [cli, 'statusline', '--json'], { ...options, input: installedInput }),
    );
    const expectedHelp = execFileSync(process.execPath, [cli, '--help'], options);
    for (const command of ['arc', 'arc-status']) {
      assert.equal(installed(prefix, command, ['--version']).trim(), packageJson.version);
      assert.equal(installed(prefix, command, ['--help']), expectedHelp);
      assert.deepEqual(
        JSON.parse(installed(prefix, command, ['statusline', '--json'], installedInput)),
        expectedStatus,
      );
      assert.deepEqual(JSON.parse(installed(prefix, command, costArgs)), expectedCost);
    }

    writeFileSync(
      join(oldPackage, 'dist/arc-status.cjs'),
      '#!/usr/bin/env node\nconsole.log("old-package-fixture");\n',
    );
    writeFileSync(
      join(oldPackage, 'package.json'),
      JSON.stringify({
        name: 'arc-agent-status',
        version: '0.0.0',
        bin: { 'arc-status': 'dist/arc-status.cjs' },
      }),
    );
    const [oldPacked] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', root], oldPackage));
    npm(['install', '--global', '--prefix', replacement, join(root, oldPacked.filename)]);
    assert.equal(installed(replacement, 'arc-status', []).trim(), 'old-package-fixture');
    npm(['uninstall', '--global', '--prefix', replacement, 'arc-agent-status']);
    npm(['install', '--global', '--prefix', replacement, tarball]);
    for (const command of ['arc', 'arc-status']) {
      assert.equal(installed(replacement, command, ['--version']).trim(), packageJson.version);
    }

    npm(['install', tarball]);
    assert.equal(npm(['exec', '--offline', '--no', '--', 'arc', '--version']).trim(), packageJson.version);
    assert.deepEqual(JSON.parse(npm(['exec', '--offline', '--no', '--', 'arc', ...costArgs])), expectedCost);
    console.log(`Installed package commands executed on ${process.platform} with Node ${process.version}.`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
