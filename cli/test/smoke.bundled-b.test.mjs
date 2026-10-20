// @module-tag subprocess
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { WindowChannel } from '../../extension/src/sessionrequests.ts';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { cli, smokeEnv } from './smoke-fixture.ts';

test('bundled read validates bounded attribution and capability before retaining curation retries', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc read smoke '));
  const channel = new WindowChannel(home);
  const run = promisify(execFile);
  const requests = [];
  const observation = 'a'.repeat(40) + '.' + 'b'.repeat(43);
  try {
    await channel.update({ folders: [home], scopeReady: true, panelReady: true, panelVisible: true });
    const env = {
      ...process.env,
      ARC_HOME: home,
      ARC_WINDOW: channel.hostId,
      CLAUDE_CODE_SESSION_ID: 'reader',
      CODEX_THREAD_ID: '',
    };
    const args = [
      cli,
      'read',
      'worker',
      '--observation',
      observation,
      '--request-id',
      `${channel.hostId}:read`,
      '--json',
    ];
    await assert.rejects(run(process.execPath, args, { env }), /does not support marking sessions read/);
    channel.setGuardedReadHandler(async (request) => {
      requests.push(request);
      return {
        version: 1,
        status: request.params.dryRun ? 'dry-run' : 'applied',
        requestId: request.id,
        sessionId: 'worker',
        requester: { provider: request.requesterProvider, id: request.requester },
        marked: [],
        reason: 'saved',
      };
    });
    const applied = JSON.parse((await run(process.execPath, args, { env })).stdout);
    assert.equal(applied.status, 'applied');
    await run(process.execPath, args, { env });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].requesterProvider, 'claude');
    assert.deepEqual(requests[0].params, { sessionId: 'worker', observation, dryRun: false });
    await assert.rejects(run(process.execPath, [...args, '--dry-run'], { env }), /already names a different request/);
    assert.equal(requests.length, 1);
  } finally {
    await channel.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

test('bundled send reads Unicode multiline prompt files, requires observations and request IDs, and refuses ambiguity before sending', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc send smoke '));
  const channel = new WindowChannel(home);
  const run = promisify(execFile);
  const sends = [];
  channel.setGuardedSendHandler(async (request) => {
    sends.push(request);
    return {
      version: 1,
      status: 'accepted',
      requestId: request.id,
      payloadSha256: 'host',
      nativeTurnId: 'turn-1',
      reason: 'The session received the prompt.',
    };
  });
  try {
    await channel.update({ folders: [home], scopeReady: true, panelReady: true, panelVisible: true });
    const env = {
      ...smokeEnv,
      ARC_HOME: home,
      ARC_WINDOW: channel.hostId,
      CLAUDE_CODE_SESSION_ID: 'coordinator',
      CODEX_THREAD_ID: '',
    };
    const prompt = join(home, 'follow up.txt');
    const text = 'Línea uno ✓\nSecond line\r\n';
    writeFileSync(prompt, '\uFEFF' + text);
    const observation = 'a'.repeat(40) + '.' + 'b'.repeat(43);
    const id = `${channel.hostId}:one`;
    const args = [cli, 'send', 'worker', '--prompt-file', prompt, '--observation', observation, '--request-id', id];
    const reply = JSON.parse((await run(process.execPath, [...args, '--json'], { env, encoding: 'utf8' })).stdout);
    assert.equal(reply.status, 'accepted');
    assert.equal(reply.requestId, id);
    assert.equal(sends[0].params.prompt, text);
    assert.equal(sends[0].requester, 'coordinator');
    assert.equal(sends[0].requesterProvider, 'claude');
    const retried = await run(process.execPath, args, { env, encoding: 'utf8' });
    assert.match(retried.stdout, /received the prompt\. Request ID: /);
    assert.equal(sends.length, 1);
    await assert.rejects(run(process.execPath, [...args, '--agent-run=false'], { env }), /unavailable for send/);
    assert.equal(sends.length, 1);
  } finally {
    await channel.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

test('bundled filter commands retrieve selected identities and clear through an explicit launcher flag', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-filter-smoke-'));
  const channel = new WindowChannel(home);
  const run = promisify(execFile);
  const requests = [];
  channel.setRequestHandler((request) => {
    requests.push(request);
    return { method: request.method, params: request.params };
  });
  const env = { ...smokeEnv, ARC_HOME: home, ARC_WINDOW: channel.hostId };
  try {
    await channel.update({ folders: [], scopeReady: true, panelReady: false, panelVisible: false });
    const answer = JSON.parse((await run(process.execPath, [cli, 'filter', '--clear', '--json'], { env })).stdout);
    assert.equal(answer.params.query, '');
    if (process.platform === 'win32') {
      const command = `& '${process.execPath.replaceAll("'", "''")}' '${cli.replaceAll("'", "''")}' filter --clear --json`;
      const answer = JSON.parse((await run('powershell.exe', ['-NoProfile', '-Command', command], { env })).stdout);
      assert.deepEqual(answer.params, { query: '' });
    }
    const before = requests.length;
    await assert.rejects(run(process.execPath, [cli, 'filter', '--unknown'], { env }));
    assert.equal(requests.length, before);
  } finally {
    await channel.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

// This packaged check catches argument routing and unwanted dispatch receipts with one local channel.
test('bundled management commands carry reader-default classification, prompt files and curation without implicit receipts', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc management smoke '));
  const channel = new WindowChannel(home);
  const run = promisify(execFile);
  const requests = [];
  channel.setDispatchHandler(() => null);
  channel.setRequestHandler((request) => {
    requests.push(request);
    return request.method === 'start'
      ? { status: 'accepted', provider: request.params.setup.agent, sessionId: 'accepted' }
      : { status: 'applied' };
  });
  try {
    await channel.update({ folders: [home], scopeReady: true, panelReady: true, panelVisible: true });
    const env = { ...smokeEnv, CLAUDE_CODE_SESSION_ID: 'coordinator', ARC_HOME: home, ARC_WINDOW: channel.hostId };
    const prompt = join(home, 'initial prompt.txt');
    writeFileSync(prompt, 'Review this project.');
    for (const [provider, tagged] of [
      ['claude', false],
      ['codex', true],
    ]) {
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
        '--name',
        'Review',
        '--label',
        'Initial',
        '--pinned',
        ...(tagged ? ['--arc-dispatch'] : []),
      ];
      const output = await run(process.execPath, args, { env, encoding: 'utf8' });
      assert.equal(requests.at(-1).params.agentRun, false);
      assert.equal(requests.at(-1).params.prompt, 'Review this project.');
      if (tagged) {
        const receipt = JSON.parse(output.stdout.trim().split('\n')[1].slice('ARC_DISPATCH_SESSION='.length));
        assert.equal(receipt.agent, provider);
        assert.equal(receipt.owned, true);
      } else assert.equal(output.stdout.includes('ARC_DISPATCH_SESSION='), false);
    }
    await run(process.execPath, [cli, 'label', 'remove', 'accepted', '--label', 'Initial', '--dry-run'], { env });
    assert.equal(requests.at(-1).params.action, 'label-remove');
    assert.equal(requests.at(-1).params.dryRun, true);
    await run(process.execPath, [cli, 'archive', 'accepted', '--force'], { env });
    assert.equal(requests.at(-1).params.force, true);
    for (const cwd of [home, process.cwd()]) {
      await run(
        process.execPath,
        [cli, 'start', '--provider', 'codex', '--prompt-file', prompt, '--read-only', '--cwd', '.'],
        { env, cwd },
      );
      assert.equal(requests.at(-1).params.cwd, realpathSync(cwd));
      assert.equal(requests.at(-1).params.readOnly, true);
      assert.equal(requests.at(-1).params.agentRun, false);
    }
    await run(
      process.execPath,
      [
        cli,
        'start',
        '--provider',
        'claude',
        '--prompt-file',
        prompt,
        '--read-only',
        '--read-tool',
        'mcp__server__read',
        '--read-tool',
        'mcp__server__list',
      ],
      { env },
    );
    assert.deepEqual(requests.at(-1).params.readTools, ['mcp__server__read', 'mcp__server__list']);
    const before = requests.length;
    await assert.rejects(
      run(process.execPath, [cli, 'start', '--provider', 'codex', '--prompt-file', prompt, '--agent-run=yes'], {
        env,
      }),
      (error) => error.code === 1 && /--agent-run accepts only true or false/.test(error.stderr),
    );
    assert.equal(requests.length, before, 'invalid classification never reaches the host');
  } finally {
    await channel.dispose();
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);

test('bundled self compaction uses read-only readiness, one admission and observation without retries', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc compact smoke '));
  const channel = new WindowChannel(home);
  const run = promisify(execFile);
  const requests = [];
  let ready = true;
  let terminal = null;
  let loseReply = false;
  const readyTimes = [];
  channel.setCompactRequestHandler(async (request) => {
    requests.push(request);
    if (request.method === 'compact-ready') readyTimes.push(Date.now());
    if (request.method === 'compact-ready') return ready ? { ready } : (terminal ?? { ready });
    if (request.method === 'compact-request' && loseReply) {
      await channel.dispose();
      return {};
    }
    return { state: 'queued', requestId: request.params.requestId };
  });
  try {
    await channel.update({ folders: [home], scopeReady: true, panelReady: true, panelVisible: true });
    const env = { ...smokeEnv, ARC_HOME: home };
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
    const continuationFile = join(home, 'next turn.txt').replaceAll('\\', '/');
    const continuation = '  Continue "once".\r\nWrite café.\r\n';
    writeFileSync(continuationFile, continuation);
    const digest = createHash('sha256').update(continuation).digest('hex');
    const continuationArgs = [
      ...args.slice(0, 5),
      '--continuation-file',
      continuationFile,
      '--continuation-sha256',
      digest,
      ...args.slice(5),
    ];
    assert.equal(JSON.parse((await run(process.execPath, continuationArgs, { env })).stdout).state, 'queued');
    assert.deepEqual(requests.at(-1).params.continuation, { text: continuation, sha256: digest });
    const originalWindow = 'b'.repeat(24);
    await run(
      process.execPath,
      [
        cli,
        'compact',
        'status',
        '--request-id',
        originalWindow + ':aaaaaaaa-1111-2222-3333-444444444444',
        '--window',
        channel.hostId,
        '--json',
      ],
      { env },
    );
    assert.equal(requests.at(-1).params.requestId.startsWith(originalWindow), true);
    const beforeInvalid = requests.length;
    writeFileSync(continuationFile, 'changed');
    await assert.rejects(run(process.execPath, continuationArgs, { env }));
    assert.equal(requests.length, beforeInvalid);
    writeFileSync(continuationFile, Buffer.from([0xc3, 0x28]));
    await assert.rejects(run(process.execPath, continuationArgs, { env }));
    assert.equal(requests.length, beforeInvalid);
    const before = requests.length;
    await assert.rejects(run(process.execPath, [...args, '--session'], { env }));
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
    // A terminal readiness code ends polling at once and reports the window's reason.
    for (const code of [
      'no-reader-instruction',
      'reader-acted',
      'background',
      'already-used',
      'request-used',
      'withdrawn',
    ]) {
      terminal = { ready: false, code, reason: `Reason for ${code}.` };
      const readsBeforeCode = readyTimes.length;
      const coded = JSON.parse((await run(process.execPath, args, { env })).stdout);
      assert.deepEqual([coded.state, coded.reason], ['refused', `Reason for ${code}.`]);
      assert.equal(readyTimes.length - readsBeforeCode, 1, code);
    }
    terminal = { ready: false, code: 'not-observed', reason: 'Not seen yet.' };
    const readsBeforeUnseen = readyTimes.length;
    assert.equal(JSON.parse((await run(process.execPath, args, { env })).stdout).reason, 'Not seen yet.');
    assert.ok(readyTimes.length - readsBeforeUnseen >= 2, 'readiness keeps polling while the command is unseen');
    terminal = null;
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
}, 80_000);
