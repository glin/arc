import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
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
import { findCommand, renderCommandHelp, renderOverviewHelp } from '../src/commands.ts';
import { fileURLToPath } from 'node:url';
import { DispatchReceipts } from '../../extension/src/dispatchreceipts.ts';
import { payloadSha256 } from '../../extension/src/sessionwrites.ts';
import * as fs from 'node:fs';
import { skillFiles, fixture, packageJson, input, cli, expectedVersion, smokeEnv } from './smoke-fixture.ts';

const bundledVersion = expectedVersion();

test('the bundled CLI reports its package version and source revision', () => {
  const output = execFileSync(process.execPath, [cli, '--version'], { env: smokeEnv, encoding: 'utf8' });
  assert.match(
    output.trim(),
    new RegExp(`^${packageJson.version.replaceAll('.', '[.]')} [(][a-f0-9]{12}(-dirty)?[)]$`),
  );
});

test('bundled help renders before stdin, discovery, network, or file changes', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-help-smoke-'));
  const preload = join(home, 'no-io.cjs');
  const run = promisify(execFile);
  writeFileSync(
    preload,
    `
const fs = require('node:fs');
const net = require('node:net');
const read = fs.readFileSync;
const deny = () => { throw new Error('Help performed I/O.'); };
fs.readFileSync = (file, ...args) => file === ${JSON.stringify(cli)} ? read(file, ...args) : deny();
fs.readFile = deny;
fs.promises.readFile = deny;
fs.promises.opendir = deny;
for (const name of ['readdirSync', 'statSync', 'lstatSync', 'mkdirSync', 'writeFileSync', 'renameSync', 'unlinkSync', 'rmSync']) fs[name] = deny;
for (const name of ['readdir', 'stat', 'lstat', 'mkdir', 'writeFile', 'rename', 'unlink', 'rm']) {
  fs[name] = deny;
  fs.promises[name] = deny;
}
net.connect = deny;
net.createConnection = deny;
net.Socket.prototype.connect = deny;
process.stdin.setEncoding = deny;
process.stdin[Symbol.asyncIterator] = deny;
`,
  );
  try {
    const options = {
      env: { ...smokeEnv, ARC_HOME: home, ARC_WINDOW: 'unavailable' },
      encoding: 'utf8',
      timeout: 10_000,
    };
    const command = findCommand(['dispatch', 'rm', '--help']);
    const result = await run(process.execPath, ['--require', preload, cli, 'dispatch', 'rm', '--help'], options);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, renderCommandHelp(command) + '\n');
    for (const args of [[], ['help'], ['--help']]) {
      assert.equal(
        (await run(process.execPath, ['--require', preload, cli, ...args], options)).stdout,
        renderOverviewHelp() + '\n',
      );
    }
    assert.equal(
      (await run(process.execPath, ['--require', preload, cli, 'start', '--help', '--version'], options)).stdout.trim(),
      bundledVersion,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the bundled CLI emits a compact text status line', () => {
  const output = execFileSync(process.execPath, [cli, 'statusline', '--width', '70'], {
    env: smokeEnv,
    input,
    encoding: 'utf8',
  });
  const [primary, secondary] = output.trimEnd().split('\n');
  assert.match(primary, /^ctx 8% of 200k \(16k\) \| cache warm .* \| next turn starts at \$0\.02$/);
  assert.equal(secondary, 'session $0.12, 45s | 5h 23.5% | 7d 41.2%');
});

test('the bundled CLI emits only the next-turn segment for another status line', () => {
  const output = execFileSync(process.execPath, [cli, 'statusline', '--next-turn'], {
    env: smokeEnv,
    input,
    encoding: 'utf8',
  });
  assert.equal(output, 'next turn starts at $0.02\n');
});

test('the bundled CLI rejects malformed JSON without writing status output', () => {
  const result = spawnSync(process.execPath, [cli, 'statusline'], {
    env: smokeEnv,
    input: '{',
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'arc: Claude status input is not valid JSON.\n');
});

test('the bundled cost command reads isolated roots and reports failures on stderr', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'arc-cost-smoke-'));
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
    ...smokeEnv,
    CLAUDE_CONFIG_DIR: root,
    CODEX_HOME: root,
    ARC_PROJECTS_ROOT: projects,
    ARC_CODEX_ROOT: codex,
  };
  try {
    const result = spawnSync(process.execPath, [cli, 'cost', 'session-1', '--json'], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.schemaVersion, 2);
    assert.match(report.buildCommit, /^[0-9a-f]{40}$/);
    assert.ok(bundledVersion.includes(report.buildCommit.slice(0, 12)));
    assert.equal(report.source.file, file);
    assert.equal(report.parent.requests, 1);
    assert.equal('modelCosts' in report.parent, false);
    const human = spawnSync(
      process.execPath,
      [cli, 'cost', 'session-1', '--by-model', '--by-tool-kind', '--until-text', 'absent'],
      { env, encoding: 'utf8' },
    );
    assert.equal(human.status, 0, human.stderr);
    for (const detail of ['Parent', 'Combined', '$0.0002', 'By model:', 'By tool kind', 'Matched: false'])
      assert.ok(human.stdout.includes(detail), detail);
    const native = readFileSync(file, 'utf8');
    const stream = [
      { type: 'system', subtype: 'init', session_id: 'stream', tools: [] },
      { ...JSON.parse(native), parent_tool_use_id: null },
      { type: 'result', subtype: 'success', total_cost_usd: 1 },
    ];
    writeFileSync(file, stream.map((record) => JSON.stringify(record)).join('\n'));
    const unsupported = spawnSync(process.execPath, [cli, 'cost', file, '--source-only'], { env, encoding: 'utf8' });
    assert.equal(unsupported.status, 1);
    assert.equal(unsupported.stdout, '');
    assert.match(unsupported.stderr, /Claude stream logs are unsupported/);
    assert.equal(unsupported.stderr.includes(file), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the packed package installs only arc globally and runs locally offline', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'arc-installed-smoke-'));
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  const consumer = join(root, 'consumer');
  const prefix = join(root, 'global');
  const packable = join(root, 'package');
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, 'Run packaging smoke tests through npm.');
  mkdirSync(consumer);
  mkdirSync(join(packable, 'dist'), { recursive: true });
  mkdirSync(join(packable, 'skills/arc-sessions'), { recursive: true });
  const skillPaths = skillFiles(join(packageRoot, 'skills/arc-sessions')).map((file) => 'skills/arc-sessions/' + file);
  for (const file of ['package.json', 'README.md', 'LICENSE', 'dist/arc.cjs', ...skillPaths]) {
    copyFileSync(join(packageRoot, file), join(packable, file));
  }
  writeFileSync(join(packable, 'dist/obsolete.cjs'), 'obsolete bundle');
  writeFileSync(join(packable, 'dist/arc.cjs.map'), 'source map');
  writeFileSync(join(root, 'user.npmrc'), '');
  writeFileSync(join(root, 'global.npmrc'), '');
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'arc-smoke-consumer', private: true }));
  const env = {
    ...Object.fromEntries(Object.entries(smokeEnv).filter(([key]) => !key.toLowerCase().startsWith('npm_config_'))),
    npm_config_userconfig: join(root, 'user.npmrc'),
    npm_config_globalconfig: join(root, 'global.npmrc'),
    npm_config_cache: join(root, 'cache'),
    npm_config_prefix: prefix,
    npm_config_registry: 'http://127.0.0.1:9',
    npm_config_offline: 'true',
    npm_config_ignore_scripts: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    CLAUDE_CONFIG_DIR: root,
    CODEX_HOME: root,
    ARC_PROJECTS_ROOT: join(root, 'projects'),
    ARC_CODEX_ROOT: join(root, 'sessions'),
    HOME: join(root, 'native home'),
    USERPROFILE: join(root, 'native home'),
  };
  const nativeRoots = [join(env.HOME, '.claude/skills'), join(env.HOME, '.agents/skills')];
  for (const folder of nativeRoots) {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'preserve'), 'native instructions');
  }
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
      'dist/arc.cjs',
      'package.json',
      ...skillPaths,
    ]);
    npm(['install', '--global', '--prefix', prefix, tarball]);
    const installedRoot = join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', '@glin/arc');
    const manifest = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8'));
    for (const file of skillPaths)
      assert.equal(readFileSync(join(installedRoot, file), 'utf8'), readFileSync(join(packageRoot, file), 'utf8'));
    assert.equal(manifest.name, '@glin/arc');
    assert.deepEqual(manifest.bin, { arc: 'dist/arc.cjs' });
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
    writeFileSync(
      transcript,
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-09-26T00:00:01Z',
        message: {
          id: 'installed-request',
          model: 'claude-opus-5',
          role: 'assistant',
          content: [],
          usage: { input_tokens: 1000, output_tokens: 100 },
        },
      }) + '\n',
    );
    const costArgs = ['cost', transcript, '--source-only', '--by-model', '--json'];
    const expectedCost = JSON.parse(execFileSync(process.execPath, [cli, ...costArgs], options));
    const installedInput = JSON.stringify({
      ...fixture,
      prompt_cache: { ...fixture.prompt_cache, expires_at: 1 },
    });
    const expectedStatus = JSON.parse(
      execFileSync(process.execPath, [cli, 'statusline', '--json'], { ...options, input: installedInput }),
    );
    const expectedHelp = execFileSync(process.execPath, [cli, '--help'], options);
    for (const command of ['arc']) {
      assert.equal(installed(prefix, command, ['--version']).trim(), bundledVersion);
      assert.equal(installed(prefix, command, ['--help']), expectedHelp);
      assert.deepEqual(
        JSON.parse(installed(prefix, command, ['statusline', '--json'], installedInput)),
        expectedStatus,
      );
      assert.deepEqual(JSON.parse(installed(prefix, command, costArgs)), expectedCost);
    }

    npm(['install', tarball]);
    for (const folder of nativeRoots) {
      assert.deepEqual(fs.readdirSync(folder), ['preserve']);
      assert.equal(readFileSync(join(folder, 'preserve'), 'utf8'), 'native instructions');
    }
    assert.equal(npm(['exec', '--offline', '--no', '--', 'arc', '--version']).trim(), bundledVersion);
    assert.deepEqual(JSON.parse(npm(['exec', '--offline', '--no', '--', 'arc', ...costArgs])), expectedCost);
    for (const invoke of [
      (args) => installed(prefix, 'arc', args),
      (args) => npm(['exec', '--offline', '--no', '--', 'arc', ...args]),
    ]) {
      for (const [action, status] of [
        ['install', 'installed'],
        ['update', 'unchanged'],
        ['remove', 'removed'],
      ]) {
        const receipt = JSON.parse(invoke(['skills', action, '--agent', 'codex']));
        assert.deepEqual(
          receipt.results.map((result) => result.status),
          [status],
        );
        const definition = join(env.HOME, '.agents/skills/arc-sessions/SKILL.md');
        if (action !== 'remove')
          assert.deepEqual(readFileSync(definition), readFileSync(join(packageRoot, 'skills/arc-sessions/SKILL.md')));
        else assert.equal(fs.existsSync(definition), false);
      }
    }
    console.log(`Installed package commands executed on ${process.platform} with Node ${process.version}.`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test('bundled dispatch commands preserve exact event claims and readable private reports without a host', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-dispatch-smoke-'));
  const receipts = new DispatchReceipts(home);
  const origin = 'a'.repeat(24);
  const launch = receipts.reserve({
    origin,
    requester: null,
    policy: null,
    promptSha256: payloadSha256('review'),
    completion: 'wait',
    alias: null,
  });
  const event = receipts.publish(
    launch.launchId,
    { outcome: 'succeeded', availability: 'available', nativeEnding: null, askId: null },
    'Saved report',
  );
  const outcome = join(home, 'outcome.md');
  writeFileSync(outcome, 'Accepted');
  const run = promisify(execFile);
  const env = { ...smokeEnv, ARC_HOME: home };
  const call = async (action, extra = []) =>
    JSON.parse(
      (
        await run(process.execPath, [cli, 'dispatch', action, launch.launchId, ...extra, '--json'], {
          env,
          encoding: 'utf8',
        })
      ).stdout,
    );
  try {
    assert.equal((await call('result', ['--event', event.eventId])).text, 'Saved report');
    assert.equal((await call('status')).events[0].eventId, event.eventId);
    const claim = await call('claim', ['--event', event.eventId, '--origin', origin, '--owner', 'consumer']);
    const recovered = await call('claim', ['--event', event.eventId, '--origin', origin, '--owner', 'consumer']);
    assert.equal(recovered.token, claim.token);
    const ackArgs = [
      '--event',
      event.eventId,
      '--origin',
      origin,
      '--owner',
      'consumer',
      '--token',
      claim.token,
      '--outcome-file',
      outcome,
    ];
    assert.equal((await call('ack', ackArgs)).status, 'consumed');
    assert.equal((await call('ack', ackArgs)).disposition, 'Accepted');
    writeFileSync(outcome, 'Rejected');
    await assert.rejects(call('ack', ackArgs), /different saved disposition/);
    assert.equal((await call('refresh')).events.length, 1);
    assert.equal((await call('recover', ['--event', event.eventId])).delivery, 'unavailable');
    assert.equal((await call('monitor')).state, 'unavailable');
    assert.equal((await call('wait', ['--deadline-ms', '1'])).state, 'uncertain');
    await assert.rejects(call('result', ['--event', '../unsafe']));
    await assert.rejects(call('status', ['--owner', 'unexpected']));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
