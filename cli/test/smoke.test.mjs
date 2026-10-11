import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { WindowChannel } from '../../extension/src/sessionrequests.ts';
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

test('the bundled windows command reaches authenticated hosts and keeps secrets out of both output formats', async () => {
  const home = mkdtempSync(join(tmpdir(), 'arc-windows-smoke-'));
  const first = new WindowChannel(home);
  const second = new WindowChannel(home);
  const env = { ...process.env, ARC_HOME: home };
  const run = promisify(execFile);
  try {
    await first.update({
      folders: ['C:/Project With Spaces'],
      scopeReady: true,
      panelReady: true,
      panelVisible: false,
    });
    await second.update({ folders: [], scopeReady: false, panelReady: false, panelVisible: false });
    const json = await run(process.execPath, [cli, 'windows', '--json'], { env, encoding: 'utf8' });
    const report = JSON.parse(json.stdout);
    assert.equal(report.version, 1);
    assert.equal(report.complete, true);
    assert.equal(report.windows.length, 2);
    assert.equal(report.windows.find((window) => window.hostId === first.hostId).panelReady, true);
    assert.equal(report.windows.find((window) => window.hostId === second.hostId).scopeReady, false);
    assert.equal(json.stdout.includes('token'), false);
    assert.equal(json.stdout.includes('address'), false);
    const human = await run(process.execPath, [cli, 'windows'], { env, encoding: 'utf8' });
    assert.match(human.stdout, /scope ready  panel hidden  "C:\/Project With Spaces"/);
    assert.match(human.stdout, /scope loading  panel not ready  \(no folders\)/);
    for (const channel of [first, second]) {
      const registration = readFileSync(join(home, 'hosts', `${channel.hostId}.json`), 'utf8');
      assert.equal(human.stdout.includes(JSON.parse(registration).token), false);
    }
    await Promise.all([first.dispose(), second.dispose()]);
    const empty = await run(process.execPath, [cli, 'windows', '--json'], { env, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(empty.stdout), { version: 1, windows: [], complete: true });
    for (let index = 0; index <= 1024; index++) {
      writeFileSync(join(home, 'hosts', `unrelated-${index}`), '');
    }
    const incomplete = await run(process.execPath, [cli, 'windows', '--json'], { env, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(incomplete.stdout), { version: 1, windows: [], complete: false });
    const partial = await run(process.execPath, [cli, 'windows'], { env, encoding: 'utf8' });
    assert.match(partial.stdout, /discovery is incomplete/);
    assert.equal(partial.stdout.includes('No Arc windows are open.'), false);
    await assert.rejects(run(process.execPath, [cli, 'windows', '--unknown'], { env }), /Usage: arc windows/);
  } finally {
    await Promise.all([first.dispose(), second.dispose()]);
    rmSync(home, { recursive: true, force: true });
  }
});

test('the bundled CLI reports the package version', () => {
  const output = execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });
  assert.equal(output.trim(), packageJson.version);
});

test('bundled self compaction uses read-only readiness, one admission and observation without retries', async () => {
  const home = mkdtempSync(join(tmpdir(), 'arc compact smoke '));
  const channel = new WindowChannel(home);
  const run = promisify(execFile);
  const requests = [];
  let ready = true;
  let loseReply = false;
  const readyTimes = [];
  channel.setCompactRequestHandler(async (request) => {
    requests.push(request);
    if (request.method === 'compact-ready') readyTimes.push(Date.now());
    if (request.method === 'compact-ready') return { ready };
    if (request.method === 'compact-request' && loseReply) {
      await channel.dispose();
      return {};
    }
    return { state: 'queued', requestId: request.params.requestId };
  });
  try {
    await channel.update({ folders: [home], scopeReady: true, panelReady: true, panelVisible: true });
    const env = { ...process.env, ARC_HOME: home };
    const requestId = channel.hostId + ':aaaaaaaa-1111-2222-3333-444444444444';
    const args = [
      cli,
      'compact',
      'request',
      '--self',
      '--after-turn',
      '--request-id',
      requestId,
      '--window',
      channel.hostId,
      '--json',
    ];
    const output = await run(process.execPath, args, { env });
    assert.equal(JSON.parse(output.stdout).state, 'queued');
    assert.deepEqual(
      requests.map((r) => r.method),
      ['compact-ready', 'compact-request'],
    );
    assert.equal(requests[1].id, requestId);
    await run(
      process.execPath,
      [cli, 'compact', 'status', '--request-id', requestId, '--window', channel.hostId, '--json'],
      { env },
    );
    assert.equal(requests.at(-1).method, 'compact-status');
    const before = requests.length;
    for (const extra of ['--session', '--background', '--self'])
      await assert.rejects(run(process.execPath, [...args, extra], { env }));
    assert.equal(requests.length, before);
    ready = false;
    const readsBefore = readyTimes.length;
    const refused = JSON.parse((await run(process.execPath, args, { env })).stdout);
    assert.equal(refused.state, 'refused');
    // Back-to-back reads would end before a late native tool start reaches the window.
    const reads = readyTimes.slice(readsBefore);
    assert.ok(reads.length >= 2, 'readiness reads more than once');
    assert.ok(reads.at(-1) - reads[0] >= 450 * (reads.length - 1), 'readiness reads are spread across its deadline');
    assert.equal(
      requests.slice(before).every((r) => r.method === 'compact-ready'),
      true,
    );
    ready = true;
    loseReply = true;
    const writesBefore = requests.filter((r) => r.method === 'compact-request').length;
    const uncertain = JSON.parse((await run(process.execPath, args, { env })).stdout);
    assert.equal(uncertain.state, 'uncertain');
    assert.equal(uncertain.requestId, requestId);
    assert.equal(requests.filter((r) => r.method === 'compact-request').length, writesBefore + 1);
    // The lost reply closed the window, so status names the outcome instead of failing.
    const gone = await run(
      process.execPath,
      [cli, 'compact', 'status', '--request-id', requestId, '--window', channel.hostId, '--json'],
      { env },
    );
    assert.equal(JSON.parse(gone.stdout).state, 'unavailable');
    assert.equal(JSON.parse(gone.stdout).requestId, requestId);
  } finally {
    await channel.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

// This packaged check catches argument routing and unwanted dispatch receipts with one local channel.
test('bundled management commands carry explicit classification, prompt files and curation without implicit receipts', async () => {
  const home = mkdtempSync(join(tmpdir(), 'arc management smoke '));
  const channel = new WindowChannel(home);
  const run = promisify(execFile);
  const requests = [];
  channel.setRequestHandler((request) => {
    requests.push(request);
    return request.method === 'start'
      ? { status: 'accepted', provider: request.params.setup.agent, sessionId: 'accepted' }
      : { status: 'applied' };
  });
  try {
    await channel.update({ folders: [home], scopeReady: true, panelReady: true, panelVisible: true });
    const env = { ...process.env, ARC_HOME: home, ARC_WINDOW: channel.hostId };
    const prompt = join(home, 'initial prompt.txt');
    writeFileSync(prompt, 'Review this project.');
    for (const provider of ['claude', 'codex'])
      for (const classification of ['--agent-run', '--untagged']) {
        const args = [
          cli,
          'start',
          '--provider',
          provider,
          '--model',
          'runtime-model',
          '--effort',
          'runtime-effort',
          '--prompt-file',
          prompt,
          classification,
          '--name',
          'Review',
          '--label',
          'Initial',
          '--pinned',
        ];
        const output = await run(process.execPath, args, { env, encoding: 'utf8' });
        assert.equal(output.stdout.includes('ARC_DISPATCH_SESSION='), false);
        assert.equal(requests.at(-1).params.agentRun, classification === '--agent-run');
        assert.equal(requests.at(-1).params.prompt, 'Review this project.');
        const tagged = await run(process.execPath, [...args, '--arc-dispatch'], { env, encoding: 'utf8' });
        const receipt = JSON.parse(tagged.stdout.trim().split('\n')[1].slice('ARC_DISPATCH_SESSION='.length));
        assert.equal(receipt.agent, provider);
        assert.equal(receipt.owned === true, classification === '--untagged');
      }
    await run(process.execPath, [cli, 'label', 'remove', 'accepted', '--label', 'Initial', '--dry-run'], { env });
    assert.equal(requests.at(-1).params.action, 'label-remove');
    assert.equal(requests.at(-1).params.dryRun, true);
    await run(process.execPath, [cli, 'archive', 'accepted', '--force'], { env });
    assert.equal(requests.at(-1).params.force, true);
    const before = requests.length;
    writeFileSync(prompt, '/clear');
    await assert.rejects(
      run(process.execPath, [cli, 'start', '--provider', 'codex', '--prompt-file', prompt, '--untagged'], { env }),
      /prompt-box command/,
    );
    assert.equal(requests.length, before);
  } finally {
    await channel.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

test('bundled session commands select one window, reject unknown IDs, and bound turns before sending', async () => {
  const home = mkdtempSync(join(tmpdir(), 'arc-session-smoke-'));
  const channel = new WindowChannel(home);
  const second = new WindowChannel(home);
  const run = promisify(execFile);
  let requests = 0;
  channel.setRequestHandler((request) => {
    requests++;
    if (request.method === 'session' && request.params.sessionId !== 'known') throw new Error('Unknown session.');
    return { method: request.method, params: request.params, requester: request.requester };
  });
  const env = {
    ...process.env,
    ARC_HOME: home,
    ARC_WINDOW: channel.hostId,
    CODEX_THREAD_ID: 'requesting-agent',
    CLAUDE_CODE_SESSION_ID: '',
  };
  try {
    await channel.update({ folders: [], scopeReady: true, panelReady: false, panelVisible: false });
    await second.update({ folders: [], scopeReady: true, panelReady: false, panelVisible: false });
    const listing = await run(process.execPath, [cli, 'sessions'], { env, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(listing.stdout), { method: 'sessions', params: {}, requester: 'requesting-agent' });
    const paged = await run(process.execPath, [cli, 'sessions', '--limit', '5', '--cursor', 'Page-2_x', '--json'], {
      env,
      encoding: 'utf8',
    });
    assert.deepEqual(JSON.parse(paged.stdout).params, { cursor: 'Page-2_x', limit: 5 });
    const detail = await run(
      process.execPath,
      [cli, 'session', 'known', '--turns', '2', '--window', channel.hostId, '--json'],
      { env: { ...env, ARC_WINDOW: second.hostId }, encoding: 'utf8' },
    );
    assert.equal(JSON.parse(detail.stdout).params.turns, 2);
    await assert.rejects(run(process.execPath, [cli, 'session', 'unknown'], { env }), /Unknown session/);
    const before = requests;
    for (const args of [
      ['session', 'known', '--turns', '21'],
      ['session', 'known', '--turns', '0'],
      ['session', 'known', '--turns', '1.5'],
      ['sessions', '--turns', '1'],
      ['sessions', '--limit', '1', '--limit', '2'],
      ['sessions', '--cursor', 'a', '--cursor', 'b'],
      ['session', 'known', '--limit', '1'],
      ['session'],
    ]) {
      await assert.rejects(run(process.execPath, [cli, ...args], { env }));
    }
    // The window would also refuse these, so the message shows that the CLI refused them first.
    for (const [args, message] of [
      [['--limit', '0'], /Limit must be between 1 and 128/],
      [['--limit', '129'], /Limit must be between 1 and 128/],
      [['--limit', '1.5'], /Limit must be between 1 and 128/],
      [['--limit'], /Limit must be between 1 and 128/],
      [['--cursor'], /Restart the listing without --cursor/],
      [['--cursor', 'abc='], /Restart the listing without --cursor/],
      [['--cursor', 'a'.repeat(513)], /Restart the listing without --cursor/],
    ]) {
      await assert.rejects(run(process.execPath, [cli, 'sessions', ...args], { env }), message);
    }
    assert.equal(requests, before);
    await assert.rejects(
      run(process.execPath, [cli, 'sessions'], { env: { ...env, ARC_WINDOW: '' } }),
      /Select one Arc window/,
    );
  } finally {
    await Promise.all([channel.dispose(), second.dispose()]);
    rmSync(home, { recursive: true, force: true });
  }
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
    const native = readFileSync(file, 'utf8');
    const stream = [
      { type: 'system', subtype: 'init', session_id: 'stream', tools: [] },
      { ...JSON.parse(native), parent_tool_use_id: null },
      { type: 'result', subtype: 'success', total_cost_usd: 1 },
    ];
    for (const content of [
      JSON.stringify(stream),
      JSON.stringify(stream, null, 2),
      stream.map((record) => JSON.stringify(record)).join('\n'),
      '',
      'not JSON',
      '{"unrelated":true}',
    ]) {
      writeFileSync(file, content);
      const unsupported = spawnSync(process.execPath, [cli, 'cost', file, '--source-only'], { env, encoding: 'utf8' });
      assert.equal(unsupported.status, 1, content);
      assert.equal(unsupported.stdout, '');
      assert.match(unsupported.stderr, /Claude stream logs|No native transcript records/);
      assert.equal(unsupported.stderr.includes(file), true);
    }
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
  mkdirSync(join(packable, 'skills/arc-sessions'), { recursive: true });
  for (const file of ['package.json', 'README.md', 'LICENSE', 'dist/arc-status.cjs', 'skills/arc-sessions/SKILL.md']) {
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
      'skills/arc-sessions/SKILL.md',
    ]);
    npm(['install', '--global', '--prefix', prefix, tarball]);
    const installedRoot = join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', '@glin/arc');
    const manifest = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8'));
    assert.equal(
      readFileSync(join(installedRoot, 'skills/arc-sessions/SKILL.md'), 'utf8'),
      readFileSync(join(packageRoot, 'skills/arc-sessions/SKILL.md'), 'utf8'),
    );
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
