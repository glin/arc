// @module-tag subprocess
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { WindowChannel, type SessionRequest } from '../../extension/src/sessionrequests.ts';
import { COMPACT_CANCELLED, CompactHost, type CompactChild } from '../../extension/src/compactrequest.ts';
import type { NativeEvent } from '../../extension/src/agentwire.ts';
import * as sessionRequests from '../../extension/src/sessionrequests.ts';
import { runManagement } from '../src/manage.ts';
import { runCompact } from '../src/compact.ts';
import { runSessions } from '../src/sessions.ts';
import { collectRow, collectPage, collectTurns, smokeEnv } from './smoke-fixture.ts';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const compactWindow = 'b'.repeat(24);
const compactArgs = [
  'request',
  '--self',
  '--after-turn',
  '--request-id',
  compactWindow + ':aaaaaaaa-1111-2222-3333-444444444444',
  '--window',
  compactWindow,
  '--json',
];

test('compact readiness spaces four negative reads and preserves their reason without admission', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const times: number[] = [];
  const request = vi.spyOn(sessionRequests, 'requestWindow').mockImplementation(async (method) => {
    assert.equal(method, 'compact-ready');
    times.push(Date.now());
    return { ready: false, code: 'not-observed', reason: 'Not seen yet.' };
  });
  const pending = runCompact(compactArgs);
  await vi.advanceTimersByTimeAsync(499);
  assert.deepEqual(times, [0]);
  await vi.advanceTimersByTimeAsync(1);
  assert.deepEqual(times, [0, 500]);
  await vi.advanceTimersByTimeAsync(1000);
  const result = JSON.parse(await pending);
  assert.deepEqual(times, [0, 500, 1000, 1500]);
  assert.equal(request.mock.calls.length, 4);
  assert.deepEqual([result.state, result.reason], ['refused', 'Not seen yet.']);
});

test('compact readiness stops new reads after a delayed negative exchange exhausts the deadline', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let release!: () => void;
  const reply = new Promise<void>((resolve) => {
    release = resolve;
  });
  const request = vi.spyOn(sessionRequests, 'requestWindow').mockImplementation(async (method) => {
    assert.equal(method, 'compact-ready');
    await reply;
    return { ready: false, reason: 'Still waiting.' };
  });
  const pending = runCompact(compactArgs);
  await vi.advanceTimersByTimeAsync(1600);
  release();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(500);
  const result = JSON.parse(await pending);
  assert.equal(request.mock.calls.length, 1);
  assert.deepEqual([result.state, result.reason], ['refused', 'Still waiting.']);
});

test('compact readiness terminal reasons end polling without admission', async () => {
  vi.useFakeTimers();
  const request = vi.spyOn(sessionRequests, 'requestWindow');
  for (const code of ['reader-acted', 'request-used', 'withdrawn']) {
    request.mockResolvedValue({ ready: false, code, reason: `Reason for ${code}.` });
    const pending = runCompact(compactArgs);
    await vi.runAllTimersAsync();
    const result = JSON.parse(await pending);
    assert.deepEqual([result.state, result.reason], ['refused', `Reason for ${code}.`]);
    assert.deepEqual(
      request.mock.calls.map(([method]) => method),
      ['compact-ready'],
    );
    request.mockClear();
  }
});

test('compact readiness admits once when an unseen command becomes ready', async () => {
  vi.useFakeTimers();
  const request = vi
    .spyOn(sessionRequests, 'requestWindow')
    .mockResolvedValueOnce({ ready: false, code: 'not-observed' })
    .mockResolvedValueOnce({ ready: true })
    .mockResolvedValueOnce({ state: 'queued' });
  const pending = runCompact(compactArgs);
  await vi.advanceTimersByTimeAsync(500);
  assert.equal(JSON.parse(await pending).state, 'queued');
  assert.deepEqual(
    request.mock.calls.map(([method]) => method),
    ['compact-ready', 'compact-ready', 'compact-request'],
  );
});

test('compact readiness accepts a positive in-flight reply after the read-start deadline', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let release!: () => void;
  const reply = new Promise<void>((resolve) => {
    release = resolve;
  });
  const request = vi.spyOn(sessionRequests, 'requestWindow').mockImplementation(async (method) => {
    if (method === 'compact-ready') {
      await reply;
      return { ready: true };
    }
    return { state: 'queued' };
  });
  const pending = runCompact(compactArgs);
  await vi.advanceTimersByTimeAsync(2100);
  release();
  assert.equal(JSON.parse(await pending).state, 'queued');
  assert.deepEqual(
    request.mock.calls.map(([method]) => method),
    ['compact-ready', 'compact-request'],
  );
});

const cancelArgs = [
  'cancel',
  '--self',
  '--request-id',
  compactWindow + ':aaaaaaaa-1111-2222-3333-444444444444',
  '--window',
  compactWindow,
  '--json',
];

// Catches a cancel that gives up before the window sees its tool call, or that retries after a final answer.
test('compact cancel repeats only while the window has not seen the command and prints its answer', async () => {
  vi.useFakeTimers();
  const request = vi
    .spyOn(sessionRequests, 'requestWindow')
    .mockResolvedValueOnce({ state: 'refused', code: 'not-observed', reason: 'Not seen yet.' })
    .mockResolvedValueOnce({ state: 'cancelled', reason: 'Cancelled.' });
  const pending = runCompact(cancelArgs);
  await vi.advanceTimersByTimeAsync(500);
  assert.deepEqual(JSON.parse(await pending), { state: 'cancelled', reason: 'Cancelled.' });
  assert.deepEqual(
    request.mock.calls.map(([method, params]) => [method, params]),
    [
      ['compact-cancel', { requestId: cancelArgs[3], window: compactWindow, self: true }],
      ['compact-cancel', { requestId: cancelArgs[3], window: compactWindow, self: true }],
    ],
  );
  request.mockReset();
  request.mockResolvedValue({ state: 'refused', code: 'other-session', reason: 'Another session.' });
  const refused = runCompact(cancelArgs);
  await vi.runAllTimersAsync();
  assert.equal(JSON.parse(await refused).code, 'other-session');
  assert.equal(request.mock.calls.length, 1);
});

// Catches a routing or parse mismatch between the CLI cancel and the window's compaction host.
test('compact cancel crosses a real window channel and cancels the request in the compaction host', async () => {
  const fixture = await host();
  try {
    const window = fixture.channel.hostId;
    const requestId = `${window}:aaaaaaaa-1111-2222-3333-444444444444`;
    const state = { sessionId: 'self', busy: true, asks: [], ready: true, exited: false };
    const child: CompactChild = {
      key: 'child',
      agent: 'codex',
      state: () => state,
      compactionUnresolved: () => false,
      compact: async () => {},
    };
    const compaction = new CompactHost<CompactChild>(window, {
      find: () => child,
      withActivity: async () => undefined,
      readerWork: () => 'none',
    });
    fixture.channel.setCompactRequestHandler((request) => compaction.handle(request));
    const toolStart = (toolId: string, command: string) =>
      ({
        kind: 'toolStart',
        provider: 'codex',
        sessionId: 'self',
        turnId: 'root',
        generation: null,
        evidence: {},
        toolId,
        command,
        initiating: true,
        success: true,
      }) as NativeEvent;
    compaction.submitted(child, 7);
    compaction.native(
      child,
      toolStart(
        'request',
        `arc compact request --self --after-turn --request-id ${requestId} --window ${window} --json`,
      ),
      7,
    );
    const admitted = compaction.handle({
      method: 'compact-request',
      params: { requestId, window, self: true, afterTurn: true },
    });
    assert.equal((admitted as { state: string }).state, 'queued');
    compaction.native(
      child,
      toolStart('cancel', `arc compact cancel --self --request-id ${requestId} --window ${window} --json`),
      7,
    );
    const answer = JSON.parse(
      await runCompact(['cancel', '--self', '--request-id', requestId, '--window', window, '--json']),
    );
    assert.deepEqual([answer.requestId, answer.state, answer.reason], [requestId, 'cancelled', COMPACT_CANCELLED]);
  } finally {
    await fixture.close();
  }
});

async function host() {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-management-unit-'));
  const channel = new WindowChannel(home);
  const requests: SessionRequest[] = [];
  channel.setRequestHandler((request) => {
    requests.push(request);
    return request.method === 'start'
      ? {
          status: 'accepted',
          provider: request.params.setup?.kind === 'custom' ? request.params.setup.agent : 'claude',
          sessionId: 'accepted',
          metadata: {
            labels: { state: 'saved', values: request.params.labels ?? [] },
            pinned: { state: 'saved', value: request.params.pinned === true },
            name: { state: 'pending', requested: request.params.name },
          },
        }
      : { method: request.method, params: request.params };
  });
  channel.setDispatchHandler(() => null);
  channel.setGuardedSendHandler(async (request) => {
    requests.push(request);
    return {
      version: 1,
      status: 'accepted',
      requestId: request.id,
      payloadSha256: 'host',
      nativeTurnId: 'turn-1',
      reason: 'Received.',
    };
  });
  channel.setGuardedReadHandler(async (request) => {
    requests.push(request);
    return {
      version: 1,
      status: 'applied',
      requestId: request.id,
      sessionId: 'worker',
      requester: { provider: request.requesterProvider!, id: request.requester! },
      marked: [],
      reason: 'Saved.',
    };
  });
  channel.setCompactRequestHandler(async (request) => {
    requests.push(request);
    return { ready: true };
  });
  await channel.update({ folders: [home], scopeReady: true, panelReady: true, panelVisible: true });
  for (const [name, value] of Object.entries({
    ARC_HOME: home,
    ARC_WINDOW: channel.hostId,
    CLAUDE_CODE_SESSION_ID: 'coordinator',
    CODEX_THREAD_ID: '',
    TERM_PROGRAM: '',
    VSCODE_PID: '',
    VSCODE_IPC_HOOK_CLI: '',
  }))
    vi.stubEnv(name, value);
  const prompt = join(home, 'prompt.txt');
  writeFileSync(prompt, 'Review this project.');
  return {
    home,
    channel,
    requests,
    prompt,
    close: async () => {
      await channel.dispose();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test('start preserves classification and dispatch ownership for both providers', async () => {
  const fixture = await host();
  const { prompt, requests } = fixture;
  try {
    for (const provider of ['claude', 'codex']) {
      for (const [classification, agentRun] of [
        [[], false],
        [['--agent-run'], true],
        [['--agent-run=true'], true],
        [['--agent-run=false'], false],
      ] as const) {
        const args = [
          '--provider',
          provider,
          '--model',
          'runtime-model',
          '--effort',
          'runtime-effort',
          '--prompt-file',
          prompt,
          ...classification,
          '--name',
          'Review',
          '--label',
          'Initial',
          '--pinned',
        ];
        const output = await runManagement('start', args);
        assert.deepEqual(JSON.parse(output).metadata, {
          labels: { state: 'saved', values: ['Initial'] },
          pinned: { state: 'saved', value: true },
          name: { state: 'pending', requested: 'Review' },
        });
        assert.equal(output.includes('ARC_DISPATCH_SESSION='), false);
        assert.equal(requests.at(-1)!.params.agentRun, agentRun);
        assert.equal(requests.at(-1)!.params.prompt, 'Review this project.');
        const tagged = await runManagement('start', [...args, '--arc-dispatch']);
        const receipt = JSON.parse(tagged.trim().split('\n')[1].slice('ARC_DISPATCH_SESSION='.length));
        assert.equal(receipt.agent, provider);
        assert.equal(receipt.owned === true, !agentRun);
      }
    }
  } finally {
    await fixture.close();
  }
});

test('start returns a session link only for the invoking window with a usable name', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-start-link-'));
  const prompt = join(home, 'prompt.txt');
  writeFileSync(prompt, 'Review this project.');
  const invoking = 'a'.repeat(24);
  const other = 'c'.repeat(24);
  const accepted = (name: object | undefined, sessionId = 'saved-id', status = 'accepted') => ({
    status,
    provider: 'claude',
    sessionId,
    metadata: { name },
  });
  const saved = { state: 'saved', requested: 'Review' };
  const pending = { state: 'pending', requested: 'Review' };
  const link = '[Review](arc-session:saved-id)';
  const cases: Array<{
    title: string;
    reply: object;
    link: string | null | undefined;
    args?: string[];
    env?: string | null;
    name?: string | null;
  }> = [
    { title: 'ARC_WINDOW without --window', reply: accepted(saved), link },
    {
      title: '--window equal to ARC_WINDOW',
      reply: accepted(saved),
      args: ['--window', invoking],
      link,
    },
    {
      title: 'accepted-with-errors',
      reply: accepted(saved, 'saved-id', 'accepted-with-errors'),
      link,
    },
    { title: 'pending name', reply: accepted(pending), link },
    {
      title: '--window naming another window',
      reply: accepted(saved),
      args: ['--window', other],
      link: null,
    },
    {
      title: 'an empty --window',
      reply: accepted(saved),
      args: ['--window', ''],
      link: null,
    },
    {
      title: 'an empty ARC_WINDOW',
      reply: accepted(saved),
      env: '',
      link: null,
    },
    {
      title: 'no ARC_WINDOW',
      reply: accepted(saved),
      env: null,
      link: null,
    },
    {
      title: '--window with no ARC_WINDOW',
      reply: accepted(saved),
      env: null,
      args: ['--window', invoking],
      link: null,
    },
    { title: 'no --name', reply: accepted(undefined), name: null, link: null },
    {
      title: 'failed name',
      reply: accepted({ ...saved, state: 'failed' }),
      link: null,
    },
    {
      title: 'uncertain name',
      reply: accepted({ ...saved, state: 'uncertain' }),
      link: null,
    },
    {
      title: 'cancelled name',
      reply: accepted({ ...saved, state: 'cancelled' }),
      link: null,
    },
    {
      title: 'naming error',
      reply: accepted({ ...saved, error: 'The name was refused.' }),
      link: null,
    },
    {
      title: 'name with a line break',
      reply: accepted(saved),
      name: 'Two\nlines',
      link: null,
    },
    {
      title: 'name with a control character',
      reply: accepted(saved),
      name: 'Bell\u0007',
      link: null,
    },
    { title: 'empty name', reply: accepted(saved), name: '', link: null },
    { title: 'whitespace-only name', reply: accepted(pending), name: ' ', link: null },
    { title: 'zero-width-space name', reply: accepted(pending), name: '\u200b', link: null },
    {
      title: 'punctuation and Unicode',
      reply: accepted(saved),
      name: 'Plan **[draft](notes)** é 日本',
      link: String.raw`[Plan \*\*\[draft\]\(notes\)\*\* é 日本](arc-session:saved-id)`,
    },
    {
      title: 'an ID with a percent sign',
      reply: accepted(saved, 'literal%2f'),
      link: '[Review](arc-session:literal%252f)',
    },
    {
      title: 'an ID with !' + "'" + '()*',
      reply: accepted(saved, "a!b'c(d)e*f"),
      link: '[Review](arc-session:a%21b%27c%28d%29e%2Af)',
    },
    {
      title: 'an ID the parser rejects',
      reply: accepted(saved, 'bad/id'),
      link: null,
    },
    {
      title: 'a refused start',
      reply: { status: 'refused', reason: 'No.' },
      link: undefined,
    },
    {
      title: 'an unknown delivery',
      reply: { status: 'unknown', requestId: 'r', window: invoking },
      link: undefined,
    },
    {
      title: 'an accepted start without a session ID',
      reply: { status: 'accepted' },
      link: undefined,
    },
  ];
  try {
    for (const entry of cases) {
      vi.stubEnv('ARC_WINDOW', entry.env === null ? undefined : (entry.env ?? invoking));
      vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'coordinator');
      vi.stubEnv('CODEX_THREAD_ID', '');
      vi.spyOn(sessionRequests, 'requestWindow').mockResolvedValue(entry.reply);
      const name = entry.name === undefined ? 'Review' : entry.name;
      const args = [
        '--provider',
        'claude',
        '--prompt-file',
        prompt,
        ...(name === null ? [] : ['--name', name]),
        ...(entry.args ?? []),
      ];
      const output = await runManagement('start', args);
      const result = JSON.parse(output);
      assert.equal('link' in result, entry.link !== undefined, entry.title);
      if (entry.link !== undefined) assert.equal(result.link, entry.link, entry.title);
      assert.equal(output.includes('\n'), false, entry.title);
      const tagged = (await runManagement('start', [...args, '--arc-dispatch'])).trim().split('\n');
      const receiptAt = tagged.findIndex((line) => line.startsWith('ARC_DISPATCH_SESSION='));
      assert.equal(receiptAt, entry.link === undefined ? -1 : tagged.length - 1, entry.title);
      assert.equal(JSON.parse(tagged[0]).link, entry.link, entry.title);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('start refuses invalid classification and launch flags before the host receives a request', async () => {
  const fixture = await host();
  try {
    for (const flags of [
      ['--agent-run', '--agent-run'],
      ['--agent-run', '--agent-run=false'],
      ['--agent-run=true', '--agent-run'],
      ['--agent-run=true', '--agent-run=false'],
      ['--agent-run=yes'],
      ['--agent-run='],
      ['--agent-run=True'],
      ['--agent-run', 'false'],
      ['--untagged'],
      ['--read-only', '--permissions', 'danger-full-access'],
      ['--read-only', '--read-tool', 'mcp__server__read'],
      ['--read-tool', 'mcp__server__read'],
    ]) {
      await assert.rejects(runManagement('start', ['--provider', 'codex', '--prompt-file', fixture.prompt, ...flags]));
      assert.equal(fixture.requests.length, 0, flags.join(' '));
    }
    writeFileSync(fixture.prompt, '/clear');
    await assert.rejects(
      runManagement('start', ['--provider', 'codex', '--prompt-file', fixture.prompt]),
      /prompt-box command/,
    );
    assert.equal(fixture.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

test('send refuses invalid flags, identities and prompt content before the host receives a request', async () => {
  const fixture = await host();
  const observation = 'a'.repeat(40) + '.' + 'b'.repeat(43);
  const args = [
    'worker',
    '--prompt-file',
    fixture.prompt,
    '--observation',
    observation,
    '--request-id',
    `${fixture.channel.hostId}:one`,
  ];
  try {
    for (const [refused, identity, pattern] of [
      [args.map((arg) => (arg === observation ? '' : arg)), {}, /observation is invalid/],
      [args.slice(0, -2), {}, /Usage: arc send/],
      [args.map((arg) => (arg === observation ? 'stale' : arg)), {}, /observation is invalid/],
      [[...args, '--agent-run=false'], {}, /unavailable for send/],
      [args, { CODEX_THREAD_ID: 'codex-thread' }, /Both CLAUDE_CODE_SESSION_ID and CODEX_THREAD_ID/],
      [args, { CLAUDE_CODE_SESSION_ID: '' }, /Run send from/],
    ] as const) {
      vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'coordinator');
      vi.stubEnv('CODEX_THREAD_ID', '');
      for (const [name, value] of Object.entries(identity)) vi.stubEnv(name, value);
      await assert.rejects(runManagement('send', [...refused]), pattern);
      assert.equal(fixture.requests.length, 0);
    }
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'coordinator');
    for (const [content, pattern] of [
      ['/compact', /prompt-box command/],
      [' \n', /prompt-box command/],
      ['x'.repeat(48 * 1024 + 1), /exceeds 48 KiB/],
      ['"'.repeat(40_000), /channel limit/],
    ] as const) {
      writeFileSync(fixture.prompt, content);
      await assert.rejects(runManagement('send', args), pattern);
      assert.equal(fixture.requests.length, 0);
    }
  } finally {
    await fixture.close();
  }
});

test('read refuses invalid flags, observations and identities before the host receives a request', async () => {
  const fixture = await host();
  const observation = 'a'.repeat(40) + '.' + 'b'.repeat(43);
  const args = ['worker', '--observation', observation, '--request-id', `${fixture.channel.hostId}:read`, '--json'];
  try {
    for (const [invalid, identity, pattern] of [
      [args.slice(0, -3), {}, /Usage: arc read/],
      [args.map((arg) => (arg === observation ? 'bad' : arg)), {}, /read observation is invalid/],
      [[...args, '--force'], {}, /unavailable for read/],
      [args, { CODEX_THREAD_ID: 'other' }, /Run read from one/],
      [args, { CLAUDE_CODE_SESSION_ID: '' }, /Run read from one/],
    ] as const) {
      vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'reader');
      vi.stubEnv('CODEX_THREAD_ID', '');
      for (const [name, value] of Object.entries(identity)) vi.stubEnv(name, value);
      await assert.rejects(runManagement('read', [...invalid]), pattern);
      assert.equal(fixture.requests.length, 0);
    }
  } finally {
    await fixture.close();
  }
});

test('compact refuses invalid flags before the host receives a request', async () => {
  const fixture = await host();
  try {
    const args = [
      'request',
      '--self',
      '--after-turn',
      '--request-id',
      `${fixture.channel.hostId}:aaaaaaaa-1111-2222-3333-444444444444`,
      '--window',
      fixture.channel.hostId,
      '--json',
    ];
    for (const extra of ['--session', '--background', '--self']) {
      await assert.rejects(runCompact([...args, extra]), /Unknown or repeated argument/);
      assert.equal(fixture.requests.length, 0);
    }
    const cancel = ['cancel', ...args.filter((arg) => arg !== 'request' && arg !== '--after-turn')];
    await assert.rejects(runCompact([...cancel, '--after-turn']), /Unknown or repeated argument/);
    await assert.rejects(runCompact(cancel.filter((arg) => arg !== '--self')), /Cancel also requires --self/);
    assert.equal(fixture.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

test('session reads refuse invalid arguments, limits and cursors before the host receives a request', async () => {
  const fixture = await host();
  try {
    for (const [command, ...args] of [
      ['session', 'known', '--turns', '21'],
      ['session', 'known', '--turns', '0'],
      ['session', 'known', '--turns', '1.5'],
      ['sessions', '--turns', '1'],
      ['sessions', '--limit', '1', '--limit', '2'],
      ['sessions', '--cursor', 'a', '--cursor', 'b'],
      ['session', 'known', '--limit', '1'],
      ['session'],
    ] as const) {
      await assert.rejects(runSessions(command, [...args]));
      assert.equal(fixture.requests.length, 0);
    }
    for (const [args, message] of [
      [['--limit', '0'], /Limit must be between 1 and 128/],
      [['--limit', '129'], /Limit must be between 1 and 128/],
      [['--limit', '1.5'], /Limit must be between 1 and 128/],
      [['--limit'], /Limit must be between 1 and 128/],
      [['--cursor'], /Restart the listing without --cursor/],
      [['--cursor', 'abc='], /Restart the listing without --cursor/],
      [['--cursor', 'a'.repeat(513)], /Restart the listing without --cursor/],
    ] as const) {
      await assert.rejects(runSessions('sessions', [...args]), message);
      assert.equal(fixture.requests.length, 0);
    }
    const paged = JSON.parse(await runSessions('sessions', ['--limit', '5', '--cursor', 'Page-2_x', '--json']));
    assert.deepEqual(paged.params, { cursor: 'Page-2_x', limit: 5 });
  } finally {
    await fixture.close();
  }
});

test('filter routes queries and refuses invalid queries before the host receives a request', async () => {
  const fixture = await host();
  const query = 'session:claude:one OR session:codex:two';
  try {
    for (const [command, ...args] of [
      ['sessions', '--query', query],
      ['filter', query],
      ['filter', '--query', query],
    ] as const) {
      assert.equal(JSON.parse(await runSessions(command, [...args, '--json'])).params.query, query);
    }
    const before = fixture.requests.length;
    for (const [command, ...args] of [
      ['filter'],
      ['filter', ''],
      ['filter', '--clear', '--clear'],
      ['filter', query, '--clear'],
      ['filter', 'session:one OR'],
      ['filter', 'x'.repeat(201)],
      ['sessions', '--query'],
      ['sessions', '--query', query, '--query', query],
      ['sessions', '--query', 'find:needle'],
      ['filter', '--unknown'],
      ['filter', '--query'],
      ['filter', '--query', ''],
      ['filter', '--query', query, query],
      ['filter', '--query', query, '--clear'],
      ['filter', '--query', query, '--query', query],
    ] as const) {
      await assert.rejects(runSessions(command, [...args]));
      assert.equal(fixture.requests.length, before, [command, ...args].join(' '));
    }
  } finally {
    await fixture.close();
  }
});

test('human session reads preserve delivered text, identity, and uncertainty without exposing receipts', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-human-reads-'));
  const channel = new WindowChannel(home);
  const row = {
    ...collectRow('physical-source', 'complete-session-id'),
    path: '/private/transcript',
    name: 'Review\nforged row\u0085\u2028',
    setup: { model: null, effort: null, source: 'unavailable' },
    labels: [{ name: 'cli', source: 'reader' }],
    pinned: true,
    archived: true,
    runStatus: 'stopped',
    lastActivity: null,
    parent: null,
    agentRun: null,
    facts: 'unparsed',
  };
  let reply: unknown = collectPage(
    [row, { ...row, id: null, name: null, ambiguous: true, truncated: ['id', 'name'], facts: 'stale' }],
    {
      coverage: 'incomplete',
      freshness: 'stale',
      complete: false,
      next: 'Exact_cursor-2',
      notes: ['Discovery unfinished.'],
    },
  );
  channel.setRequestHandler(() => reply);
  const env = { ...smokeEnv, ARC_HOME: home, ARC_WINDOW: channel.hostId };
  const call = async (command: 'sessions' | 'session', json = false) => ({
    stdout: await runSessions(command, [
      ...(command === 'session' ? ['complete-session-id'] : []),
      ...(json ? ['--json'] : []),
    ]),
  });
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  try {
    await channel.update({ folders: [home], scopeReady: true, panelReady: true, panelVisible: true });
    const listing = (await call('sessions')).stdout;
    for (const fact of [
      'complete-session-id',
      'physical-source',
      'classification unknown',
      'ambiguous ID',
      'truncated: id, name',
      '(ID truncated)',
      'facts stale',
      'facts unparsed',
      'pinned',
      'archived',
      'labels: cli',
      'Discovery unfinished.',
      'Exact_cursor-2',
    ])
      assert.ok(listing.includes(fact), fact);
    assert.ok(listing.includes('Review\\nforged row'));
    assert.ok(!listing.includes('\nforged row'));
    assert.doesNotMatch(listing, /[\x7f-\x9f\u2028\u2029]/);
    assert.ok(!listing.includes('/private/transcript'));
    assert.deepEqual(JSON.parse((await call('sessions', true)).stdout), reply);
    reply = collectPage([], { coverage: 'unavailable', next: null, notes: ['Catalog unavailable.'] });
    assert.match((await call('sessions')).stdout, /Discovery remains unavailable/);
    const prompt = '  Привет 🐈\n\tretain whitespace  \n';
    const response = '\n回答\r\n  trailing spaces  ';
    reply = collectTurns('complete-session-id', {
      turns: [
        {
          promptId: 'turn-1',
          startedAt: 0,
          endedAt: 1,
          prompt,
          summary: response,
          model: 'model',
          effort: 'high',
          finished: false,
          interrupted: true,
          error: 'recorded failure',
        },
      ],
      observation: 'SECRET_SEND',
      readObservation: 'SECRET_READ',
      notes: ['Older turn excluded.'],
    });
    const detail = (await call('session')).stdout;
    for (const value of [
      prompt,
      response,
      'turn-1',
      'error',
      'model',
      'high',
      'Older turn excluded.',
      'partial',
      '--json',
    ])
      assert.ok(detail.includes(value), value);
    assert.ok(!detail.includes('SECRET_'));
    assert.deepEqual(JSON.parse((await call('session', true)).stdout), reply);
    for (const state of ['stale', 'unparsed']) {
      reply = collectTurns('complete-session-id', { state });
      assert.match((await call('session')).stdout, new RegExp(`History is ${state}`));
    }
    for (const command of ['sessions', 'session'] as const) {
      const valid = command === 'sessions' ? collectPage([row]) : collectTurns('complete-session-id');
      for (const malformed of [
        { ...valid, version: 99 },
        { ...valid, notes: null },
        command === 'sessions'
          ? { ...valid, sessions: [{ ...row, labels: [{}] }] }
          : { ...valid, turns: [{ prompt: null }] },
      ]) {
        reply = malformed;
        await assert.rejects(call(command), /cannot be displayed as text.*--json/);
        assert.deepEqual(JSON.parse((await call(command, true)).stdout), malformed);
      }
    }
  } finally {
    await channel.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

test('ordinary send and both explicit queue spellings retain their distinct delivery intent', async () => {
  const fixture = await host();
  try {
    const text = '  literal message\n\tend  \n';
    writeFileSync(fixture.prompt, text);
    for (const [index, mode] of [[], ['--queue'], ['-q']].entries()) {
      await runManagement('send', [
        'worker',
        '--prompt-file',
        fixture.prompt,
        '--request-id',
        `${fixture.channel.hostId}:send-${index}`,
        ...mode,
        '--json',
      ]);
      assert.deepEqual(fixture.requests[index].params, {
        sessionId: 'worker',
        prompt: text,
        ...(index === 0 ? { delivery: 'auto' } : {}),
      });
    }
    for (const flag of ['--queue', '-q'])
      await assert.rejects(
        runManagement('send', [
          'worker',
          '--prompt-file',
          fixture.prompt,
          '--request-id',
          `${fixture.channel.hostId}:conflict`,
          flag,
          '--observation',
          'a.' + 'b'.repeat(43),
        ]),
        /cannot combine/,
      );
  } finally {
    await fixture.close();
  }
});
