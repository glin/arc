import { test, vi } from 'vitest';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { CompactRequests, compactCommandPayload, type CompactBinding } from './compactrequest.ts';
import {
  CodexWire,
  SandboxMode,
  appServerArgs,
  readCodexMcpServers,
  readRateLimits,
  readModels,
  readAppliedDefaults,
  readDefaultConfiguration,
  codexDefaultsQualified,
  turnOutcome,
} from './codexwire.ts';
import { WireEvent, Ask, RateLimit, GuardedAttempt } from './agentwire.ts';
import { SessionNameUncertain } from './sessionrename.ts';
import * as path from 'node:path';

// App-server fixtures retain protocol fields, including request ID 0. A truthiness check must not discard that ID.

const THREAD = '01a04792-145f-7c01-9dd6-f3234c381e7e';
const TURN = '01a04792-152f-72f1-b738-f4b20621e59a';

// Dedicated in-memory servers exercise registration order, raw collisions, and withdrawal without model turns.
function sessionSkillServer() {
  const root = path.resolve('session-skill-release');
  const release = {
    contentId: 'a'.repeat(64),
    directory: root,
    claudePlugin: path.join(root, 'session-plugin'),
    codexRoot: path.join(root, 'skills'),
    claudeDefinition: path.join(root, 'session-plugin/skills/arc-sessions/SKILL.md'),
    codexDefinition: path.join(root, 'skills/arc-sessions/SKILL.md'),
  };
  const state = {
    registered: false,
    preexistingExact: false,
    collision: false,
    disabled: false,
    managed: false,
    nullSkills: false,
    withdrawFailure: false,
    invalidAck: false,
    unsupported: false,
    postCollision: false,
    lingeringExact: false,
    holdList: false,
    holdSteer: false,
    holdStart: false,
    failStart: false,
    refuseSteer: false,
    beforeReply: undefined as ((message: any) => void) | undefined,
  };
  const held: (() => void)[] = [];
  const sent: any[] = [];
  const events: WireEvent[] = [];
  const cwd = process.cwd();
  const definition = (file: string, enabled = true) => ({
    name: 'arc-sessions',
    path: file,
    enabled,
    scope: 'user',
    pluginId: null,
    description: 'Arc sessions',
  });
  const wire = new CodexWire({
    cwd,
    clientInfo: { name: 'arc', title: 'Arc', version: '0.1.0' },
    sessionSkills: { release, refresh: () => true },
    emit: (event) => events.push(event),
    send: (line) => {
      const message = JSON.parse(line);
      sent.push(message);
      if (state.failStart && message.method === 'turn/start') throw new Error('native input transport failed');
      if (message.id === undefined) return;
      const respond = () => {
        state.beforeReply?.(message);
        let result: unknown = {};
        let error: unknown;
        switch (message.method) {
          case 'skills/list':
            result = {
              data: [
                {
                  cwd,
                  errors: [],
                  skills: [
                    ...(state.registered || state.preexistingExact || state.lingeringExact
                      ? [definition(release.codexDefinition, !state.disabled)]
                      : []),
                    ...(state.collision || (state.postCollision && state.registered)
                      ? [definition(path.resolve('personal/SKILL.md'), false)]
                      : []),
                  ],
                },
              ],
            };
            break;
          case 'config/read':
            result = {
              config: state.disabled
                ? { skills: { config: [{ path: release.codexDefinition, enabled: false }] } }
                : state.nullSkills
                  ? { skills: null }
                  : {},
              origins: {},
              layers: [],
            };
            break;
          case 'configRequirements/read':
            result = { requirements: state.managed ? {} : null };
            break;
          case 'skills/extraRoots/set':
            if (state.unsupported) error = { code: -32601, message: 'unsupported' };
            else if (!message.params.extraRoots.length && state.withdrawFailure)
              error = { code: -32602, message: 'withdrawal refused' };
            else {
              state.registered = message.params.extraRoots.length > 0;
              result = state.invalidAck ? null : {};
            }
            break;
          case 'thread/start':
            result = { thread: { id: THREAD } };
            break;
          case 'turn/start':
            result = { turn: { id: TURN } };
            break;
          case 'turn/steer':
            if (state.refuseSteer) error = { code: -32600, message: 'expected turn is not active' };
            break;
        }
        wire.receive(JSON.stringify({ id: message.id, ...(error ? { error } : { result }) }));
      };
      queueMicrotask(() => {
        if (
          (state.holdList && message.method === 'skills/list') ||
          (state.holdSteer && message.method === 'turn/steer') ||
          (state.holdStart && message.method === 'turn/start')
        )
          held.push(respond);
        else respond();
      });
    },
  });
  return { wire, state, sent, events, release, held };
}

test.each([false, true])(
  'Codex registers its skill and offers completion with nullable skills %s',
  async (nullSkills) => {
    const h = sessionSkillServer();
    h.state.nullSkills = nullSkills;
    await h.wire.initialize();
    const commands = await h.wire.commands();
    await h.wire.startThread({ cwd: process.cwd() });
    await h.wire.prompt('$arc-sessions list sessions');
    const methods = h.sent.map((message) => message.method);
    assert.deepEqual(methods.slice(0, 10), [
      'initialize',
      'initialized',
      'skills/list',
      'config/read',
      'configRequirements/read',
      'skills/extraRoots/set',
      'skills/list',
      'config/read',
      'configRequirements/read',
      'thread/start',
    ]);
    assert.equal(commands.find((command) => command.name === 'arc-sessions')?.sessionSkillRelease, h.release.contentId);
    assert.deepEqual(h.sent.find((message) => message.method === 'skills/extraRoots/set').params, {
      extraRoots: [h.release.codexRoot],
    });
    const turns = h.sent.filter((message) => message.method === 'turn/start');
    assert.equal(turns.length, 1);
    assert.deepEqual(turns[0].params.input[1], {
      type: 'skill',
      name: 'arc-sessions',
      path: h.release.codexDefinition,
    });
    h.wire.close('closed');
  },
);

test('Codex preserves a pre-existing enabled link to its exact immutable definition without registering roots', async () => {
  const h = sessionSkillServer();
  h.state.preexistingExact = true;
  await h.wire.initialize();
  const commands = await h.wire.commands();
  await h.wire.startThread({ cwd: process.cwd() });
  await h.wire.prompt('$arc-sessions list sessions');
  assert.equal(commands.find((command) => command.name === 'arc-sessions')?.path, h.release.codexDefinition);
  assert.deepEqual(h.sent.find((message) => message.method === 'turn/start').params.input[1], {
    type: 'skill',
    name: 'arc-sessions',
    path: h.release.codexDefinition,
  });
  assert.equal(h.sent.filter((message) => message.method === 'skills/extraRoots/set').length, 0);
  assert.equal(
    commands.some((command) => command.sessionSkillRelease),
    false,
  );
  h.wire.close('closed');
});

test.each(['collision', 'disabled', 'managed', 'unsupported'] as const)(
  'Codex %s refuses optional delivery in its existing dedicated child',
  async (kind) => {
    const h = sessionSkillServer();
    h.state[kind] = true;
    await h.wire.initialize();
    const commands = await h.wire.commands();
    await h.wire.startThread({ cwd: process.cwd() });
    await h.wire.prompt('ordinary work');
    assert.equal(
      commands.some((command) => command.sessionSkillRelease),
      false,
    );
    assert.equal(h.state.registered, false);
    assert.equal(h.sent.filter((message) => message.method === 'turn/start').length, 1);
    if (kind !== 'unsupported')
      assert.equal(
        h.sent.some((message) => message.method === 'skills/extraRoots/set'),
        false,
      );
    h.wire.close('closed');
  },
);

test('Codex post-registration collisions withdraw its roots before opening a session', async () => {
  const h = sessionSkillServer();
  h.state.postCollision = true;
  h.state.beforeReply = (message) => {
    if (message.method === 'skills/extraRoots/set' && !message.params.extraRoots.length) h.state.lingeringExact = true;
  };
  await h.wire.initialize();
  const commands = await h.wire.commands();
  await h.wire.startThread({ cwd: process.cwd() });
  assert.equal(h.state.registered, false);
  assert.equal(
    commands.some((command) => command.sessionSkillRelease),
    false,
  );
  const replacements = h.sent.filter((message) => message.method === 'skills/extraRoots/set');
  assert.deepEqual(
    replacements.map((message) => message.params.extraRoots),
    [[h.release.codexRoot], []],
  );
  assert.ok(h.sent.indexOf(replacements[1]) < h.sent.findIndex((message) => message.method === 'thread/start'));
  assert.equal(
    commands.some((command) => command.path === h.release.codexDefinition),
    false,
  );
  const refreshed = await h.wire.commands();
  assert.equal(
    refreshed.some((command) => command.path === h.release.codexDefinition),
    false,
  );
  await h.wire.prompt('$arc-sessions list sessions');
  assert.equal(
    h.sent.find((message) => message.method === 'turn/start').params.input.some((input: any) => input.type === 'skill'),
    false,
  );
  h.wire.close('closed');
});

test.each([false, true])(
  'Codex refresh withdraws disabled roots and blocks delivery when withdrawal is uncertain: %s',
  async (uncertain) => {
    const h = sessionSkillServer();
    await h.wire.initialize();
    await h.wire.commands();
    await h.wire.startThread({ cwd: process.cwd() });
    await h.wire.prompt('first work');
    h.state.disabled = true;
    h.state.withdrawFailure = uncertain;
    h.wire.receive(JSON.stringify({ method: 'skills/changed', params: {} }));
    const second = h.wire.prompt('$arc-sessions later work');
    if (uncertain) await assert.rejects(second, /withdrawal/);
    else await second;
    if (uncertain) {
      await assert.rejects(h.wire.startThread({ cwd: process.cwd() }), /withdrawal/);
      await assert.rejects(h.wire.compact(), /withdrawal/);
      assert.equal(h.sent.filter((message) => message.method === 'thread/start').length, 1);
    }
    const turns = h.sent.filter((message) => message.method === 'turn/start');
    assert.equal(turns.length, uncertain ? 1 : 2);
    if (!uncertain)
      assert.equal(
        turns[1].params.input.some((entry: any) => entry.type === 'skill'),
        false,
      );
    assert.equal(
      h.events
        .filter((event) => event.kind === 'commands')
        .at(-1)
        ?.commands.some((command: any) => command.sessionSkillRelease),
      false,
    );
    h.wire.close('closed');
  },
);

test('Codex malformed registration acknowledgement prevents optional readiness and session creation', async () => {
  const h = sessionSkillServer();
  h.state.invalidAck = true;
  await h.wire.initialize();
  await assert.rejects(h.wire.commands(), /unreadable/);
  assert.equal(
    h.events.some((event) => event.kind === 'ready'),
    false,
  );
  assert.equal(
    h.sent.some((message) => message.method === 'thread/start' || message.method === 'turn/start'),
    false,
  );
  h.wire.close('closed');
});

const APPROVAL_REQUEST = JSON.stringify({
  id: 0,
  method: 'item/commandExecution/requestApproval',
  params: {
    threadId: THREAD,
    turnId: TURN,
    itemId: 'exec-dd508dd2-52c5-47eb-94da-41dd769fb04c',
    startedAtMs: 1787907190196,
    environmentId: 'local',
    command: '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command \'echo hello > probe.txt\'',
    cwd: 'C:\\ws',
  },
});

const AGENT_MESSAGE = JSON.stringify({
  method: 'item/completed',
  params: {
    item: { type: 'agentMessage', id: 'msg_1', text: 'Running the requested command.', phase: 'commentary' },
    threadId: THREAD,
    turnId: TURN,
  },
});

const COMMAND_STARTED = JSON.stringify({
  method: 'item/started',
  params: {
    item: {
      type: 'commandExecution',
      id: 'exec-1',
      command: '"powershell.exe" -Command \'echo codex-probe\'',
      cwd: 'C:\\ws',
      status: 'inProgress',
    },
    threadId: THREAD,
    turnId: TURN,
  },
});

const TURN_COMPLETED = JSON.stringify({
  method: 'turn/completed',
  params: {
    threadId: THREAD,
    turn: {
      id: TURN,
      status: 'completed',
      error: null,
      durationMs: 10727,
      items: [{ type: 'agentMessage', id: 'msg_2', text: 'done', phase: 'final_answer' }],
    },
  },
});

const RATE_LIMITS = JSON.stringify({
  method: 'account/rateLimits/updated',
  params: {
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1787924682 },
      secondary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1788470887 },
      planType: 'plus',
      rateLimitReachedType: null,
    },
  },
});

function harness(deadlineMs?: number, cwd = 'C:\\ws') {
  const sent: string[] = [];
  const events: WireEvent[] = [];
  const wire = new CodexWire({
    send: (line) => sent.push(line),
    emit: (event) => events.push(event),
    clientInfo: { name: 'arc', title: 'Arc', version: '0.1.0' },
    cwd,
    deadlineMs,
  });
  return { wire, sent, events, parsed: () => sent.map((l) => JSON.parse(l)) };
}

async function waitForDeadline<T>(pending: Promise<T>): Promise<T> {
  // Production deadlines do not keep the extension host alive. An isolated test process
  // needs its own referenced timer to stay alive long enough to observe the deadline.
  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    return await pending;
  } finally {
    clearTimeout(keepAlive);
  }
}

// Answers whatever request went out last, so a test can get past a handshake or a start.
function reply(h: ReturnType<typeof harness>, result: unknown): void {
  const outgoing = h.parsed().filter((m) => typeof m.id === 'number' && m.method);
  const last = outgoing[outgoing.length - 1];
  h.wire.receive(JSON.stringify({ id: last.id, result }));
}

test.each(['start', 'fork'])(
  'Codex %s reserves immediately before attempted creation and cleans refused pre-write timers',
  async (method) => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const order: string[] = [];
      const create = (before: () => void, attempted: () => void) =>
        method === 'start'
          ? h.wire.startThread({ cwd: 'C:/ws' }, '', before, attempted)
          : h.wire.forkThread(THREAD, { cwd: 'C:/ws' }, before, attempted);
      await assert.rejects(
        create(
          () => {
            throw new Error('reservation failed');
          },
          () => order.push('attempted'),
        ),
        /reservation failed/,
      );
      assert.deepEqual(h.sent, []);
      assert.deepEqual(order, []);
      assert.equal(vi.getTimerCount(), 0);
      await assert.rejects(
        create(
          () => h.wire.close('closed during reservation'),
          () => order.push('attempted'),
        ),
        /no longer running|closed during reservation/,
      );
      assert.deepEqual(h.sent, []);
      assert.deepEqual(order, []);
      assert.equal(vi.getTimerCount(), 0);
      const live = harness();
      const before = () => {
        assert.equal(live.sent.length, 0);
        order.push('reserved');
      };
      const attempted = () => {
        assert.equal(live.sent.length, 0);
        order.push('attempted');
      };
      const pending =
        method === 'start'
          ? live.wire.startThread({ cwd: 'C:/ws' }, '', before, attempted)
          : live.wire.forkThread(THREAD, { cwd: 'C:/ws' }, before, attempted);
      assert.deepEqual(order, ['reserved', 'attempted']);
      assert.equal(live.parsed()[0].method, `thread/${method}`);
      reply(live, { thread: { id: 'successor' } });
      assert.equal(await pending, 'successor');
      assert.equal(vi.getTimerCount(), 0);
    } finally {
      vi.useRealTimers();
    }
  },
);

test('Codex foreground shell evidence admits self-compaction only while the exact requesting command runs', async () => {
  const window = 'a'.repeat(24);
  const text = 'Continue the assigned work.';
  const sha256 = createHash('sha256').update(text).digest('hex');
  const payload = {
    requestId: `${window}:aaaaaaaa-1111-2222-3333-444444444444`,
    window,
    self: true as const,
    afterTurn: true as const,
    continuation: { text, sha256 },
  };
  const binding: CompactBinding = {
    activation: window,
    provider: 'codex',
    sessionId: THREAD,
    childGeneration: 1,
    turn: TURN,
    submissionId: 'reader',
    readerRevision: 1,
  };
  const command = `arc compact request --self --after-turn --continuation-file '${process.platform === 'win32' ? 'C:/temp/next.txt' : '/tmp/next.txt'}' --continuation-sha256 ${sha256} --request-id ${payload.requestId} --window ${window} --json`;
  for (const [source, processId, status, threadId, turnId, expected] of [
    ['agent', null, 'inProgress', THREAD, TURN, true],
    ['unifiedExecStartup', '123', 'inProgress', THREAD, TURN, true],
    ['agent', '123', 'inProgress', THREAD, TURN, false],
    ['agent', undefined, 'inProgress', THREAD, TURN, false],
    ['unifiedExecStartup', null, 'inProgress', THREAD, TURN, false],
    ['unifiedExecInteraction', '123', 'inProgress', THREAD, TURN, false],
    ['userShell', null, 'inProgress', THREAD, TURN, false],
    ['unknown', null, 'inProgress', THREAD, TURN, false],
    ['agent', null, 'completed', THREAD, TURN, false],
    ['agent', null, 'failed', THREAD, TURN, false],
    ['agent', null, 'inProgress', 'foreign', TURN, false],
    ['agent', null, 'inProgress', THREAD, 'foreign', false],
  ] as const) {
    const h = harness();
    const starting = h.wire.startThread({ cwd: 'C:/ws' });
    reply(h, { thread: { id: THREAD } });
    await starting;
    const book = new CompactRequests(window);
    const item = { type: 'commandExecution', id: 'command', command, source, processId, status };
    h.wire.receive(JSON.stringify({ method: 'item/started', params: { threadId, turnId, item } }));
    for (const event of h.events) if (event.kind === 'native') book.observe(binding, event.event);
    assert.equal(book.ready(payload), expected, JSON.stringify({ source, processId, status, threadId, turnId }));
    if (expected) {
      h.events.length = 0;
      h.wire.receive(
        JSON.stringify({
          method: 'item/completed',
          params: { threadId, turnId, item: { ...item, status: 'failed', exitCode: 1 } },
        }),
      );
      for (const event of h.events) if (event.kind === 'native') book.observe(binding, event.event);
      assert.equal(book.ready(payload), false);
    }
    h.wire.close('finished');
  }
});

test.each([false, true])(
  'Codex POSIX foreground commands reach self-compaction readiness with continuation=%s',
  async (continuation) => {
    const window = 'b'.repeat(24);
    const text = 'Continue the assigned work.';
    const sha256 = createHash('sha256').update(text).digest('hex');
    const payload = {
      requestId: `${window}:bbbbbbbb-1111-2222-3333-444444444444`,
      window,
      self: true as const,
      afterTurn: true as const,
    };
    const binding: CompactBinding = {
      activation: window,
      provider: 'codex',
      sessionId: THREAD,
      childGeneration: 1,
      turn: TURN,
      submissionId: 'reader',
      readerRevision: 1,
    };
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const expected = continuation ? { ...payload, continuation: { text, sha256 } } : payload;
      const literal = `arc compact request --self --after-turn${continuation ? ` --continuation-file '/tmp/arc notes (draft)/resume.txt' --continuation-sha256 ${sha256}` : ''} --request-id ${payload.requestId} --window ${window} --json`;
      const command = continuation ? `/bin/sh -c "${literal}"` : `/bin/sh -c '${literal}'`;
      const h = harness();
      try {
        const starting = h.wire.startThread({ cwd: '/tmp/work' });
        reply(h, { thread: { id: THREAD } });
        await starting;
        const book = new CompactRequests(window);
        h.wire.receive(
          JSON.stringify({
            method: 'item/started',
            params: {
              threadId: THREAD,
              turnId: TURN,
              item: {
                type: 'commandExecution',
                id: 'posix-command',
                command,
                source: 'unifiedExecStartup',
                processId: '35702',
                status: 'inProgress',
              },
            },
          }),
        );
        const native = h.events.flatMap((event) => (event.kind === 'native' ? [event.event] : []));
        assert.equal(native.length, 1);
        for (const event of native) book.observe(binding, event);
        assert.deepEqual(
          {
            initiating: native[0].kind === 'toolStart' && native[0].initiating,
            payload: compactCommandPayload(command),
            readiness: book.readiness(expected),
          },
          {
            initiating: true,
            payload: continuation ? { ...payload, continuation: { sha256 } } : payload,
            readiness: { ready: true },
          },
          command,
        );
      } finally {
        h.wire.close('finished');
      }
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  },
);

test('Codex native evidence requires exact thread fields and separates command exit, compaction acceptance and completion', async () => {
  const h = harness();
  const starting = h.wire.startThread({ cwd: 'C:\\ws' });
  reply(h, { thread: { id: THREAD } });
  await starting;
  const item = {
    type: 'commandExecution',
    id: 'command',
    command: 'arc compact request literal',
    processId: '123',
    source: 'unifiedExecStartup',
    status: 'inProgress',
  };
  const send = (method: string, params: Record<string, unknown>) => h.wire.receive(JSON.stringify({ method, params }));
  send('item/started', { turnId: TURN, item });
  send('item/started', { threadId: 'foreign', turnId: TURN, item });
  assert.equal(h.events.filter((e) => e.kind === 'native').length, 0);
  send('item/started', { threadId: THREAD, turnId: TURN, item });
  send('item/completed', { threadId: THREAD, turnId: TURN, item: { ...item, status: 'completed', exitCode: 0 } });
  send('turn/completed', { threadId: THREAD, turn: { id: TURN, status: 'completed' } });
  const native = h.events.filter((e) => e.kind === 'native').map((e) => e.event);
  assert.deepEqual(
    native.map((e) => e.kind),
    ['toolStart', 'toolEnd', 'rootEnd'],
  );
  assert.equal(native[0].evidence.threadId, THREAD);
  assert.equal(native[0].kind === 'toolStart' && native[0].initiating, true);
  assert.equal(native[1].kind === 'toolEnd' && native[1].success, true);
  let checks = 0;
  const pending = h.wire.compact(() => {
    checks++;
  });
  const compactTurn = 'compact-turn';
  send('turn/started', { threadId: THREAD, turn: { id: compactTurn } });
  send('item/started', {
    threadId: THREAD,
    turnId: compactTurn,
    item: { type: 'contextCompaction', id: 'compact-item' },
  });
  send('item/completed', {
    threadId: THREAD,
    turnId: compactTurn,
    item: { type: 'contextCompaction', id: 'compact-item' },
  });
  send('turn/completed', { threadId: THREAD, turn: { id: compactTurn, status: 'completed' } });
  reply(h, {});
  await pending;
  assert.equal(checks, 1);
  assert.deepEqual(
    h.events.flatMap((e) => (e.kind === 'native' && e.event.kind === 'compact' ? [e.event.stage] : [])),
    ['turnStart', 'itemStart', 'itemEnd', 'turnEnd', 'accepted'],
  );
  const before = h.sent.length;
  await assert.rejects(
    h.wire.compact(() => {
      throw new Error('reader intervened');
    }),
    /reader intervened/,
  );
  assert.equal(h.sent.length, before);
  h.wire.close('finished');
});

test('automatic compaction preserves the ordinary prompt root ending and its unknown compaction attribution', async () => {
  const h = harness();
  const starting = h.wire.startThread({ cwd: 'C:/ws' });
  reply(h, { thread: { id: THREAD } });
  await starting;
  const prompted = h.wire.prompt('hello');
  reply(h, { turn: { id: TURN } });
  await prompted;
  h.wire.receive(JSON.stringify({ method: 'turn/started', params: { threadId: THREAD, turn: { id: TURN } } }));
  h.wire.receive(
    JSON.stringify({
      method: 'item/started',
      params: { threadId: THREAD, turnId: TURN, item: { id: 'automatic', type: 'contextCompaction' } },
    }),
  );
  h.wire.receive(TURN_COMPLETED);
  const native = h.events.flatMap((event) => (event.kind === 'native' ? [event.event] : []));
  const roots = native.filter((event) => event.kind === 'rootEnd');
  assert.equal(roots.length, 1, 'automatic compaction must preserve successful reader-turn settlement');
  assert.equal(roots[0].kind === 'rootEnd' && roots[0].success, true);
  assert.deepEqual(
    native.filter((event) => event.kind === 'compact').map((event) => [event.stage, event.generation]),
    [
      ['itemStart', null],
      ['turnEnd', null],
    ],
  );
  assert.equal(h.wire.hasOpenTurns(), false);
  h.wire.close('finished');
});

async function completeLastTurn(h: ReturnType<typeof harness>, turnId: string): Promise<void> {
  const starts = h.parsed().filter((message) => message.method === 'turn/start');
  const start = starts[starts.length - 1];
  h.wire.receive(JSON.stringify({ id: start.id, result: { turn: { id: turnId, status: 'inProgress' } } }));
  await new Promise((resolve) => setImmediate(resolve));
  h.wire.receive(
    JSON.stringify({
      method: 'turn/completed',
      params: { threadId: THREAD, turn: { id: turnId, status: 'completed', items: [] } },
    }),
  );
}

test('the server runs as a subcommand, with no shell in the way', () => {
  assert.deepEqual(appServerArgs(), ['app-server']);
});

test('the handshake names this client and is followed by the notification that opens the rest', async () => {
  const h = harness();
  const initializing = h.wire.initialize();
  const first = h.parsed()[0];
  assert.equal(first.method, 'initialize');
  assert.equal(first.params.clientInfo.name, 'arc');
  assert.deepEqual(
    first.params.capabilities,
    { experimentalApi: true },
    'the recovery fork fields are rejected unless this client opts into experimental fields',
  );
  reply(h, { userAgent: 'arc/0.146.0', codexHome: 'C:\\Users\\g\\.codex' });
  await initializing;
  const second = h.parsed()[1];
  assert.equal(second.method, 'initialized');
  assert.equal(second.id, undefined, 'a notification carries no id, and one sent as a request is rejected');
});

test('an approval is a server request, told apart by carrying both an id and a method', () => {
  const h = harness();
  h.wire.receive(APPROVAL_REQUEST);
  const event = h.events.find((e) => e.kind === 'ask') as { kind: 'ask'; ask: Ask };
  assert.ok(event, 'routing on method alone would read this as a notification and never answer it');
  assert.equal(event.ask.kind, 'permission');
  if (event.ask.kind !== 'permission') return;
  assert.equal(event.ask.displayName, 'Shell');
  assert.match(String(event.ask.input.command), /echo hello > probe\.txt/);
  assert.equal(event.ask.id, 'exec-dd508dd2-52c5-47eb-94da-41dd769fb04c');
});

test('an approval on request id zero is answered, not dropped as a missing id', () => {
  const h = harness();
  h.wire.receive(APPROVAL_REQUEST);
  const event = h.events.find((e) => e.kind === 'ask') as { kind: 'ask'; ask: Ask };
  assert.equal(h.wire.answer(event.ask.id, { decision: 'allow' }), true);
  assert.deepEqual(h.parsed()[0], { id: 0, result: { decision: 'accept' } });
});

test('a refusal goes back as the decision the server understands', () => {
  const h = harness();
  h.wire.receive(APPROVAL_REQUEST);
  const event = h.events.find((e) => e.kind === 'ask') as { kind: 'ask'; ask: Ask };
  h.wire.answer(event.ask.id, { decision: 'deny', reason: 'not this one' });
  assert.equal(h.parsed()[0].result.decision, 'decline');
});

test('a server request the panel cannot answer is refused rather than left hanging', () => {
  const h = harness();
  h.wire.receive(JSON.stringify({ id: 7, method: 'account/login/complete', params: {} }));
  const reply = h.parsed()[0];
  assert.equal(reply.id, 7);
  assert.ok(reply.error, 'an unanswered server request stalls the turn for ever');
});

test('a response is told from a notification, and settles only its own caller', async () => {
  const h = harness();
  const listing = h.wire.listThreads(3);
  h.wire.receive(JSON.stringify({ method: 'thread/status/changed', params: { threadId: THREAD } }));
  reply(h, { data: [{ id: THREAD, preview: 'hello' }] });
  const threads = await listing;
  assert.deepEqual(
    threads.map((t) => t.id),
    [THREAD],
  );
});

test('an unpicked thread leaves Codex permission settings to its configuration on start and turn', async () => {
  const h = harness();
  const starting = h.wire.startThread({ cwd: 'C:\\ws' });
  const request = h.parsed()[0];
  assert.equal(request.method, 'thread/start');
  assert.equal(request.params.cwd, 'C:\\ws');
  for (const setting of ['approvalPolicy', 'approvalsReviewer', 'sandbox']) {
    assert.equal(setting in request.params, false, `thread/start sent ${setting} without a reader pick`);
  }
  reply(h, { thread: { id: THREAD, path: 'C:\\rollout.jsonl' } });
  assert.equal(await starting, THREAD);
  assert.equal(h.wire.threadId(), THREAD);
  assert.deepEqual(h.events[0], { kind: 'session', sessionId: THREAD, previous: null });

  const prompting = h.wire.prompt('use the configured permissions');
  const turn = h.parsed().at(-1);
  assert.equal(turn?.method, 'turn/start');
  for (const setting of ['approvalPolicy', 'approvalsReviewer', 'sandbox', 'sandboxPolicy']) {
    assert.equal(setting in turn!.params, false, `turn/start sent ${setting} without a reader pick`);
  }
  reply(h, { turn: { id: TURN } });
  await prompting;
});

test('a started thread reports the effective permission mode Codex resolved', async () => {
  const h = harness();
  const starting = h.wire.startThread({ cwd: 'C:\\ws' });
  reply(h, {
    thread: { id: THREAD, path: 'C:\\rollout.jsonl' },
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
    sandbox: { type: 'workspaceWrite', writableRoots: ['C:\\ws'] },
  });
  await starting;
  assert.deepEqual(h.events[0], {
    kind: 'session',
    sessionId: THREAD,
    previous: null,
    effectiveMode: {
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandbox: 'workspaceWrite',
    },
  });
});

test('a named thread is started before Codex receives its exact name', async () => {
  const h = harness();
  const starting = h.wire.startThread({ cwd: 'C:\\ws' }, 'review  "two"');
  assert.equal(h.parsed()[0].method, 'thread/start');
  reply(h, { thread: { id: THREAD, path: 'C:\\rollout.jsonl' } });
  await vi.waitFor(() => assert.equal(h.parsed().at(-1)?.method, 'thread/name/set'));
  assert.deepEqual(h.parsed().at(-1)?.params, { threadId: THREAD, name: 'review  "two"' });
  reply(h, {});
  assert.equal(await starting, THREAD);
});

test('a started thread reports a granular effective approval policy without losing the rest of the mode', async () => {
  const h = harness();
  const starting = h.wire.startThread({ cwd: 'C:\\ws' });
  const approvalPolicy = {
    granular: { mcp_elicitations: false, rules: true, sandbox_approval: true },
  };
  reply(h, {
    thread: { id: THREAD, path: 'C:\\rollout.jsonl' },
    approvalPolicy,
    approvalsReviewer: 'user',
    sandbox: { type: 'workspaceWrite', writableRoots: ['C:\\ws'] },
  });
  await starting;
  assert.deepEqual(h.events[0], {
    kind: 'session',
    sessionId: THREAD,
    previous: null,
    effectiveMode: { approvalPolicy, approvalsReviewer: 'user', sandbox: 'workspaceWrite' },
  });
});

test('a Codex rename sends exactly thread/name/set and starts no turn', async () => {
  const h = harness();
  const renamed = h.wire.renameThread(THREAD, 'Complete name');
  assert.deepEqual(h.parsed(), [
    { id: h.parsed()[0].id, method: 'thread/name/set', params: { threadId: THREAD, name: 'Complete name' } },
  ]);
  reply(h, {});
  await renamed;
  assert.deepEqual(h.events, []);
});

test('a Codex rename rejects with the server refusal', async () => {
  const h = harness();
  const renamed = h.wire.renameThread(THREAD, 'Complete name');
  h.wire.receive(JSON.stringify({ id: h.parsed()[0].id, error: { code: -32000, message: 'name rejected' } }));
  await assert.rejects(renamed, /name rejected/);
});

test.each(['deadline', 'lost child'])('a Codex rename retains uncertainty after %s', async (loss) => {
  vi.useFakeTimers();
  try {
    const h = harness(10);
    const result = h.wire.renameThread(THREAD, 'Complete name').catch((error) => error);
    if (loss === 'deadline') await vi.advanceTimersByTimeAsync(10);
    else h.wire.close('transport ended');
    assert.ok((await result) instanceof SessionNameUncertain);
    assert.equal(h.parsed().length, 1);
  } finally {
    vi.useRealTimers();
  }
});

test('compaction uses the app-server thread control and never starts a model turn', async () => {
  const h = harness();
  const starting = h.wire.startThread({ cwd: 'C:\\ws' });
  reply(h, { thread: { id: THREAD } });
  await starting;

  const compacting = h.wire.compact();
  const request = h.parsed().at(-1);
  assert.deepEqual(request, {
    id: 2,
    method: 'thread/compact/start',
    params: { threadId: THREAD },
  });
  assert.equal(
    h.parsed().some((message) => message.method === 'turn/start'),
    false,
    'literal /compact can reach the model and select a similarly named skill',
  );
  let settled = false;
  void compacting.then(() => {
    settled = true;
  });
  reply(h, {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'the acknowledgement was mistaken for completed compaction');
  assert.equal(h.wire.hasOpenTurns(), true);
  h.wire.receive(
    JSON.stringify({
      method: 'turn/started',
      params: { threadId: THREAD, turn: { id: TURN, status: 'inProgress', items: [] } },
    }),
  );
  assert.equal(h.wire.hasOpenTurns(), true);
  h.wire.receive(TURN_COMPLETED);
  await compacting;
  assert.equal(h.wire.hasOpenTurns(), false);
  assert.equal(h.events.filter((event) => event.kind === 'turnEnd').length, 1);
});

// Isolated late evidence keeps its request identity. Overlapping requests have no native turn discriminant.
test.each(['before turn', 'after turn'])(
  'manual compaction cannot take a deferred receipt turn when refusal arrives %s',
  async (order) => {
    vi.useFakeTimers();
    try {
      const h = harness(1_000);
      const starting = h.wire.startThread({ cwd: 'C:/ws' });
      reply(h, { thread: { id: THREAD } });
      await starting;
      const send = (method: string, params: Record<string, unknown>) =>
        h.wire.receive(JSON.stringify({ method, params: { threadId: THREAD, ...params } }));
      const starts = () =>
        h.events.flatMap((e) =>
          e.kind === 'native' && e.event.kind === 'compact' && e.event.stage === 'turnStart'
            ? [e.event.generation]
            : [],
        );
      const first = assert.rejects(
        h.wire.compact(() => {}),
        /did not answer/,
      );
      const firstRpc = h.parsed().at(-1).id;
      await vi.advanceTimersByTimeAsync(1_000);
      await first;
      const second = h.wire.compact();
      const secondRpc = h.parsed().at(-1).id;
      let succeeded = false;
      void second.then(
        () => {
          succeeded = true;
        },
        () => {},
      );
      const refuseFirst = () => h.wire.receive(JSON.stringify({ id: firstRpc, error: { message: 'first refused' } }));
      if (order === 'before turn') refuseFirst();
      send('turn/started', { turn: { id: 'arriving' } });
      send('turn/started', { turn: { id: 'arriving' } });
      send('turn/completed', { turn: { id: 'foreign', status: 'completed' }, threadId: 'other-thread' });
      send('turn/completed', { turn: { id: 'unrelated', status: 'completed' } });
      if (order === 'after turn') refuseFirst();
      send('turn/completed', { turn: { id: 'arriving', status: 'completed' } });
      assert.equal(succeeded, false, 'a terminal notification must not bypass its RPC response');
      if (order === 'before turn') {
        h.wire.receive(JSON.stringify({ id: secondRpc, result: {} }));
        await second;
        assert.deepEqual(starts(), [2]);
        assert.equal(h.wire.compactionUnresolved(), false);
      } else {
        const rejected = assert.rejects(second, /second refused/);
        h.wire.receive(JSON.stringify({ id: secondRpc, error: { message: 'second refused' } }));
        await rejected;
        assert.deepEqual(starts(), [], 'an ambiguous turn must have no generation');
        assert.equal(h.wire.compactionUnresolved(), false, 'exact refusals release retained ambiguity');
      }
      h.wire.close('finished');
    } finally {
      vi.useRealTimers();
    }
  },
);

test('an acknowledged running compaction retains busy state and Stop after the completion deadline', async () => {
  vi.useFakeTimers();
  try {
    const h = harness(1_000);
    const starting = h.wire.startThread({ cwd: 'C:/ws' });
    reply(h, { thread: { id: THREAD } });
    await starting;
    let settled = false;
    const compacting = h.wire.compact();
    void compacting.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    reply(h, {});
    h.wire.receive(JSON.stringify({ method: 'turn/started', params: { threadId: THREAD, turn: { id: TURN } } }));
    await vi.advanceTimersByTimeAsync(1_000);
    assert.equal(settled, false, 'a known native turn must outlive the caller deadline');
    assert.equal(h.wire.hasOpenTurns(), true, 'the reader must still see the compaction running');
    assert.equal(h.wire.idleEvidence(), false);
    await assert.rejects(h.wire.compact(), /turn running/);
    const stopping = h.wire.interrupt();
    assert.equal(h.parsed().at(-1).method, 'turn/interrupt');
    assert.deepEqual(h.parsed().at(-1).params, { threadId: THREAD, turnId: TURN });
    reply(h, {});
    await stopping;
    h.wire.receive(TURN_COMPLETED);
    await compacting;
    assert.equal(h.wire.hasOpenTurns(), false);
    h.wire.close('finished');
  } finally {
    vi.useRealTimers();
  }
});

test.each(['timeout', 'refusal'])(
  'a native compaction started before acknowledgement retains ownership after initial %s',
  async (ending) => {
    vi.useFakeTimers();
    try {
      const h = harness(1_000);
      const starting = h.wire.startThread({ cwd: 'C:/ws' });
      reply(h, { thread: { id: THREAD } });
      await starting;
      const compacting = assert.rejects(
        h.wire.compact(() => {}),
        ending === 'timeout' ? /did not answer/ : /not now/,
      );
      const rpc = h.parsed().at(-1).id;
      h.wire.receive(JSON.stringify({ method: 'turn/started', params: { threadId: THREAD, turn: { id: TURN } } }));
      if (ending === 'refusal') h.wire.receive(JSON.stringify({ id: rpc, error: { message: 'not now' } }));
      await vi.advanceTimersByTimeAsync(1_000);
      await compacting;
      assert.equal(h.wire.hasOpenTurns(), true, 'caller settlement must retain the running native turn');
      assert.equal(h.wire.compactionUnresolved(), true, 'native ownership must hold deferred delivery');
      assert.equal(h.wire.idleEvidence(), false);
      await assert.rejects(h.wire.compact(), /turn running/);
      const stopping = h.wire.interrupt();
      assert.equal(h.parsed().at(-1).method, 'turn/interrupt');
      assert.deepEqual(h.parsed().at(-1).params, { threadId: THREAD, turnId: TURN });
      reply(h, {});
      await stopping;
      h.wire.receive(TURN_COMPLETED);
      assert.equal(h.wire.hasOpenTurns(), false);
      assert.equal(h.wire.compactionUnresolved(), false);
      assert.equal(h.wire.idleEvidence(), true);
      h.wire.close('finished');
    } finally {
      vi.useRealTimers();
    }
  },
);

test.each(['timeout', 'refusal'])(
  'a native terminal before the asynchronous initial %s catch leaves no receipt',
  async (ending) => {
    vi.useFakeTimers();
    try {
      const h = harness(1_000);
      const starting = h.wire.startThread({ cwd: 'C:/ws' });
      reply(h, { thread: { id: THREAD } });
      await starting;
      const compacting = assert.rejects(h.wire.compact(), ending === 'timeout' ? /did not answer/ : /not now/);
      const rpc = h.parsed().at(-1).id;
      h.wire.receive(JSON.stringify({ method: 'turn/started', params: { threadId: THREAD, turn: { id: TURN } } }));
      if (ending === 'refusal') h.wire.receive(JSON.stringify({ id: rpc, error: { message: 'not now' } }));
      else vi.advanceTimersByTime(1_000);
      h.wire.receive(TURN_COMPLETED);
      await compacting;
      assert.equal(h.wire.hasOpenTurns(), false);
      assert.equal(h.wire.compactionUnresolved(), false, 'a settled turn must not acquire a new active receipt');
      assert.equal(h.wire.idleEvidence(), true);
      h.wire.close('finished');
    } finally {
      vi.useRealTimers();
    }
  },
);

test('an isolated late compaction retains its turn through a conflicting RPC refusal', async () => {
  vi.useFakeTimers();
  try {
    const h = harness(1_000);
    const starting = h.wire.startThread({ cwd: 'C:/ws' });
    reply(h, { thread: { id: THREAD } });
    await starting;
    const pending = assert.rejects(h.wire.compact(), /did not answer/);
    const rpc = h.parsed().at(-1).id;
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    h.wire.receive(JSON.stringify({ method: 'turn/started', params: { threadId: THREAD, turn: { id: TURN } } }));
    h.wire.receive(JSON.stringify({ id: rpc, error: { message: 'not now' } }));
    assert.equal(h.wire.compactionUnresolved(), true, 'a bound turn must still block deferred delivery');
    assert.equal(h.wire.hasOpenTurns(), true, 'a turn first named after timeout must become busy');
    const stopping = h.wire.interrupt();
    assert.deepEqual(h.parsed().at(-1).params, { threadId: THREAD, turnId: TURN });
    reply(h, {});
    await stopping;
    h.wire.receive(TURN_COMPLETED);
    assert.equal(h.wire.compactionUnresolved(), false);
    assert.equal(h.wire.hasOpenTurns(), false);
    assert.deepEqual(
      h.events.flatMap((event) =>
        event.kind === 'native' && event.event.kind === 'compact'
          ? [`${event.event.stage} ${event.event.generation}`]
          : [],
      ),
      ['turnStart 1', 'refused 1', 'turnEnd 1'],
    );
    h.wire.close('finished');
  } finally {
    vi.useRealTimers();
  }
});

test('an isolated timed-out compaction retains its own late turn and an acknowledged ambiguous compaction has a finite deadline', async () => {
  vi.useFakeTimers();
  try {
    const h = harness(1_000);
    const starting = h.wire.startThread({ cwd: 'C:/ws' });
    reply(h, { thread: { id: THREAD } });
    await starting;
    const send = (method: string, params: Record<string, unknown>) =>
      h.wire.receive(JSON.stringify({ method, params: { threadId: THREAD, ...params } }));
    const first = assert.rejects(h.wire.compact(), /did not answer/);
    await vi.advanceTimersByTimeAsync(1_000);
    await first;
    send('turn/started', { turn: { id: 'late' } });
    send('turn/completed', { turn: { id: 'late', status: 'completed' } });
    assert.equal(h.wire.compactionUnresolved(), false);
    assert.deepEqual(
      h.events.flatMap((e) =>
        e.kind === 'native' && e.event.kind === 'compact' ? [`${e.event.stage} ${e.event.generation}`] : [],
      ),
      ['turnStart 1', 'turnEnd 1'],
    );
    const old = assert.rejects(
      h.wire.compact(() => {}),
      /did not answer/,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await old;
    const manual = assert.rejects(h.wire.compact(), /did not finish/);
    reply(h, {});
    send('turn/started', { turn: { id: 'ambiguous' } });
    send('turn/completed', { turn: { id: 'ambiguous', status: 'completed' } });
    await vi.advanceTimersByTimeAsync(1_000);
    await manual;
    assert.equal(h.wire.hasOpenTurns(), false, 'unknown completion must release the pending caller');
    assert.equal(h.wire.compactionUnresolved(), true);
    assert.equal(h.wire.steerable(), false);
    h.wire.close('finished');
  } finally {
    vi.useRealTimers();
  }
});

test('an unattributed native compaction retains busy state and Stop after its caller deadline and exact refusals', async () => {
  vi.useFakeTimers();
  try {
    const h = harness(1_000);
    const starting = h.wire.startThread({ cwd: 'C:/ws' });
    reply(h, { thread: { id: THREAD } });
    await starting;
    const first = assert.rejects(
      h.wire.compact(() => {}),
      /did not answer/,
    );
    const firstRpc = h.parsed().at(-1).id;
    await vi.advanceTimersByTimeAsync(1_000);
    await first;
    const second = assert.rejects(h.wire.compact(), /did not finish/);
    const secondRpc = h.parsed().at(-1).id;
    reply(h, {});
    const send = (method: string, params: Record<string, unknown>) =>
      h.wire.receive(JSON.stringify({ method, params: { threadId: THREAD, ...params } }));
    send('turn/started', { turn: { id: TURN } });
    send('item/started', { turnId: TURN, item: { id: 'compact-item', type: 'contextCompaction' } });
    await vi.advanceTimersByTimeAsync(1_000);
    await second;
    for (const id of [firstRpc, secondRpc]) h.wire.receive(JSON.stringify({ id, error: { message: 'not now' } }));
    assert.equal(h.wire.hasOpenTurns(), true, 'finite caller settlement cannot end an observed native compaction');
    assert.equal(h.wire.compactionUnresolved(), true, 'unknown attribution must continue blocking deferred delivery');
    const stopping = h.wire.interrupt();
    assert.deepEqual(h.parsed().at(-1).params, { threadId: THREAD, turnId: TURN });
    reply(h, {});
    await stopping;
    send('turn/completed', { turn: { id: TURN, status: 'completed' } });
    assert.equal(h.wire.hasOpenTurns(), false);
    assert.equal(h.wire.compactionUnresolved(), false);
    const nativeTurnEvents = h.events.flatMap((event) =>
      event.kind === 'native' && event.event.kind === 'compact' && event.event.turnId === TURN ? [event.event] : [],
    );
    assert.deepEqual(
      nativeTurnEvents.map((event) => [event.stage, event.generation]),
      [
        ['itemStart', null],
        ['turnEnd', null],
      ],
    );
    const next = h.wire.compact(() => {});
    reply(h, {});
    send('turn/started', { turn: { id: 'next-turn' } });
    send('turn/completed', { turn: { id: 'next-turn', status: 'completed' } });
    await next;
    h.wire.close('finished');
  } finally {
    vi.useRealTimers();
  }
});

test.each(['turn then refusal', 'refusal then turn'])(
  'full compaction bound preserves deferred receipts and reader availability with %s',
  async (order) => {
    vi.useFakeTimers();
    try {
      const h = harness(1_000);
      const starting = h.wire.startThread({ cwd: 'C:/ws' });
      reply(h, { thread: { id: THREAD } });
      await starting;
      const send = (method: string, params: Record<string, unknown>) =>
        h.wire.receive(JSON.stringify({ method, params: { threadId: THREAD, ...params } }));
      const rpcs: number[] = [];
      for (let attempt = 0; attempt < 8; attempt++) {
        const pending = assert.rejects(h.wire.compact(attempt === 1 ? () => {} : undefined), /did not answer/);
        rpcs.push(h.parsed().at(-1).id);
        await vi.advanceTimersByTimeAsync(1_000);
        await pending;
      }
      const before = h.parsed().length;
      await assert.rejects(
        h.wire.compact(() => {}),
        /earlier compaction/,
      );
      assert.equal(h.parsed().length, before, 'a full bound must refuse deferred delivery before writing');
      const ninth = assert.rejects(h.wire.compact(), /did not answer/);
      const ninthRpc = h.parsed().at(-1).id;
      assert.equal(h.parsed().filter((m) => m.method === 'thread/compact/start').length, 9);
      const refuseDropped = () =>
        h.wire.receive(JSON.stringify({ id: rpcs[0], error: { message: 'dropped refused' } }));
      if (order === 'refusal then turn') refuseDropped();
      send('turn/started', { turn: { id: 'discarded-or-ninth' } });
      send('turn/completed', { turn: { id: 'discarded-or-ninth', status: 'completed' } });
      if (order === 'turn then refusal') refuseDropped();
      await vi.advanceTimersByTimeAsync(1_000);
      await ninth;
      const stages = h.events.flatMap((e) =>
        e.kind === 'native' && e.event.kind === 'compact' ? [`${e.event.stage} ${e.event.generation}`] : [],
      );
      assert.equal(
        stages.some((stage) => /^turn(Start|End) 9$/.test(stage)),
        false,
        'unknown turns must not settle the new reader request',
      );
      for (const id of [...rpcs, ninthRpc]) h.wire.receive(JSON.stringify({ id, error: { message: 'refused' } }));
      const refused = h.events.flatMap((e) =>
        e.kind === 'native' && e.event.kind === 'compact' && e.event.stage === 'refused' ? [e.event.generation] : [],
      );
      assert.deepEqual(refused, [2, 3, 4, 5, 6, 7, 8, 9], 'every retained receipt must settle exactly once');
      assert.equal(h.wire.compactionUnresolved(), true, 'exact refusals cannot repair lost identity');
      const later = assert.rejects(h.wire.compact(), /did not answer/);
      const laterRpc = h.parsed().at(-1).id;
      await vi.advanceTimersByTimeAsync(1_000);
      await later;
      send('turn/started', { turn: { id: 'later-anonymous' } });
      send('item/started', {
        turnId: 'later-anonymous',
        item: { id: 'later-compact-item', type: 'contextCompaction' },
      });
      send('turn/completed', { turn: { id: 'later-anonymous', status: 'completed' } });
      const laterEvents = h.events.flatMap((event) =>
        event.kind === 'native' && event.event.kind === 'compact' && event.event.turnId === 'later-anonymous'
          ? [[event.event.stage, event.event.generation]]
          : [],
      );
      assert.deepEqual(laterEvents, [
        ['itemStart', null],
        ['turnEnd', null],
      ]);
      h.wire.receive(JSON.stringify({ id: laterRpc, error: { message: 'later refused' } }));
      assert.equal(h.wire.compactionUnresolved(), true, 'a later anonymous turn cannot repair lost identity');
      const clearing = h.wire.startThread({ cwd: 'C:/ws' });
      reply(h, { thread: { id: 'next-thread' } });
      await clearing;
      assert.equal(h.wire.compactionUnresolved(), false);
      const fresh = h.wire.compact();
      reply(h, {});
      send('turn/started', { threadId: 'next-thread', turn: { id: 'fresh' } });
      send('turn/completed', { threadId: 'next-thread', turn: { id: 'fresh', status: 'completed' } });
      await fresh;
      h.wire.close('finished');
    } finally {
      vi.useRealTimers();
    }
  },
);

test('a native compaction reports its terminal failure', async () => {
  const h = harness();
  const starting = h.wire.startThread({ cwd: 'C:\\ws' });
  reply(h, { thread: { id: THREAD } });
  await starting;

  const compacting = h.wire.compact();
  reply(h, {});
  h.wire.receive(
    JSON.stringify({
      method: 'turn/started',
      params: { threadId: THREAD, turn: { id: TURN, status: 'inProgress', items: [] } },
    }),
  );
  h.wire.receive(
    JSON.stringify({
      method: 'turn/failed',
      params: { threadId: THREAD, turnId: TURN, error: { message: 'context could not be compacted' } },
    }),
  );
  await assert.rejects(compacting, /context could not be compacted/);
  assert.equal(h.wire.hasOpenTurns(), false);
  assert.deepEqual(h.events.filter((event) => event.kind !== 'native').at(-1), {
    kind: 'turnEnd',
    nativeTurnId: '01a04792-152f-72f1-b738-f4b20621e59a',
    outcome: { status: 'error', text: 'context could not be compacted', costUsd: null, turns: null, deniedTools: [] },
  });
});

// Compaction failures retain the server message across string, turn-error, and error-message envelopes.

test('a compaction carries the reason the server gave, in whichever field it arrives', async () => {
  const shapes = [
    {
      what: 'a plain string on the failure',
      message: {
        method: 'turn/failed',
        params: { threadId: THREAD, turnId: TURN, error: 'the security token has expired' },
      },
    },
    {
      what: 'an error on a turn that completed without completing',
      message: {
        method: 'turn/completed',
        params: {
          threadId: THREAD,
          turn: { id: TURN, status: 'failed', items: [], error: { message: 'the security token has expired' } },
        },
      },
    },
  ];
  for (const shape of shapes) {
    const h = harness();
    const starting = h.wire.startThread({ cwd: 'C:\\ws' });
    reply(h, { thread: { id: THREAD } });
    await starting;

    const compacting = h.wire.compact();
    reply(h, {});
    h.wire.receive(
      JSON.stringify({
        method: 'turn/started',
        params: { threadId: THREAD, turn: { id: TURN, status: 'inProgress', items: [] } },
      }),
    );
    h.wire.receive(JSON.stringify(shape.message));
    await assert.rejects(compacting, (error: Error) => {
      assert.equal(error.message, 'the security token has expired', shape.what);
      return true;
    });
  }
});

test('a compaction the server named no reason for rejects with nothing to say', async () => {
  const h = harness();
  const starting = h.wire.startThread({ cwd: 'C:\\ws' });
  reply(h, { thread: { id: THREAD } });
  await starting;

  const compacting = h.wire.compact();
  reply(h, {});
  h.wire.receive(
    JSON.stringify({
      method: 'turn/started',
      params: { threadId: THREAD, turn: { id: TURN, status: 'inProgress', items: [] } },
    }),
  );
  h.wire.receive(
    JSON.stringify({
      method: 'turn/failed',
      params: { threadId: THREAD, turnId: TURN },
    }),
  );
  // When the server supplies no compaction reason, reject with an empty message rather than inventing a cause.

  await assert.rejects(compacting, (error: Error) => {
    assert.equal(error.message, '');
    return true;
  });
});

test('a native compaction can be interrupted after its turn is named', async () => {
  const h = harness();
  const starting = h.wire.startThread({ cwd: 'C:\\ws' });
  reply(h, { thread: { id: THREAD } });
  await starting;

  const compacting = h.wire.compact();
  reply(h, {});
  const stopping = h.wire.interrupt();
  assert.equal(
    h.parsed().some((message) => message.method === 'turn/interrupt'),
    false,
  );
  h.wire.receive(
    JSON.stringify({
      method: 'turn/started',
      params: { threadId: THREAD, turn: { id: TURN, status: 'inProgress', items: [] } },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const interrupt = h.parsed().at(-1);
  assert.deepEqual(interrupt, {
    id: 3,
    method: 'turn/interrupt',
    params: { threadId: THREAD, turnId: TURN },
  });
  reply(h, {});
  await stopping;
  h.wire.receive(
    JSON.stringify({
      method: 'turn/completed',
      params: { threadId: THREAD, turn: { id: TURN, status: 'aborted', items: [] } },
    }),
  );
  await assert.rejects(compacting, /compaction was interrupted/);
  assert.equal(h.wire.hasOpenTurns(), false);
});

test('compaction without a session is refused before anything reaches the server', async () => {
  const h = harness();
  await assert.rejects(h.wire.compact(), /no Codex session has been started/);
  assert.deepEqual(h.parsed(), []);
});

test('a locked session can be continued as a new thread without starting its goal', async () => {
  const h = harness();
  const forking = h.wire.forkThread(THREAD, {
    cwd: 'C:\\ws',
    model: 'gpt-5.6-sol',
    approvalPolicy: 'never',
    approvalsReviewer: 'auto_review',
    sandbox: 'danger-full-access',
  });
  const request = h.parsed()[0];
  assert.equal(request.method, 'thread/fork');
  assert.deepEqual(request.params, {
    threadId: THREAD,
    cwd: 'C:\\ws',
    model: 'gpt-5.6-sol',
    approvalPolicy: 'never',
    approvalsReviewer: 'auto_review',
    sandbox: 'danger-full-access',
    deferGoalContinuation: true,
    excludeTurns: true,
  });
  const forked = '01a04792-ffff-7c01-9dd6-f3234c381e7e';
  reply(h, { thread: { id: forked } });
  assert.equal(await forking, forked);
  assert.equal(h.wire.threadId(), forked);
  assert.deepEqual(h.events[0], { kind: 'session', sessionId: forked, previous: null });
});

test('an unpicked fork or resume leaves Codex permission settings to its saved configuration', async () => {
  const h = harness();
  const withoutPick = async (pending: Promise<string>) => {
    const request = h.parsed().at(-1);
    assert.ok(request);
    for (const setting of ['approvalPolicy', 'approvalsReviewer', 'sandbox']) {
      assert.equal(setting in request.params, false, `${request.method} sent ${setting} without a reader pick`);
    }
    reply(h, { thread: { id: THREAD } });
    await pending;
  };
  await withoutPick(h.wire.forkThread(THREAD, { cwd: 'C:\\ws' }));
  await withoutPick(h.wire.resumeThread(THREAD));

  const resumed = h.wire.resumeThread(THREAD, {
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: 'danger-full-access',
  });
  assert.deepEqual(h.parsed().at(-1).params, {
    threadId: THREAD,
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: 'danger-full-access',
  });
  reply(h, { thread: { id: THREAD } });
  await resumed;
});

test('a prompt before a session exists says so rather than going nowhere', async () => {
  const h = harness();
  await assert.rejects(h.wire.prompt('hello'), /no Codex session/);
});

test('a prompt goes out as a turn on the thread that was started', async () => {
  const h = harness();
  const starting = h.wire.startThread({ cwd: 'C:\\ws' });
  reply(h, { thread: { id: THREAD } });
  await starting;
  void h.wire.prompt('hello');
  const turn = h.parsed()[1];
  assert.equal(turn.method, 'turn/start');
  assert.equal(turn.params.threadId, THREAD);
  assert.deepEqual(turn.params.input, [{ type: 'text', text: 'hello' }]);
});

test.each([
  ['C:\\ws', 'C:\\Users\\reader\\.agents\\skills\\recap\\SKILL.md'],
  ['/Users/reader/project', '/Users/reader/.agents/skills/recap/SKILL.md'],
  ['/home/reader/project', '/home/reader/.agents/skills/recap/SKILL.md'],
])('explicit Codex skills retain native text and assets for %s', async (cwd, path) => {
  const h = harness(undefined, cwd);
  const opening = h.wire.commands();
  reply(h, { data: [{ cwd, skills: [{ name: 'Tools:Recap', path, enabled: true }], errors: [] }] });
  await opening;
  const starting = h.wire.startThread({ cwd });
  reply(h, { thread: { id: THREAD } });
  await starting;
  const asset = {
    id: 'one',
    name: 'notes.txt',
    mime: 'text/plain',
    size: 5,
    digest: '0'.repeat(64),
    path: '/staged/one',
  };
  for (const prefix of ['/', '$']) {
    for (const text of [
      `${prefix}tools:recap`,
      ` \n${prefix}tools:recap does this work better? \n`,
      `${prefix}Tools:Recap `,
    ]) {
      const delivery = h.wire.prompt({ text, assets: [asset] });
      assert.deepEqual(h.parsed().at(-1).params.input, [
        { type: 'text', text },
        { type: 'skill', name: 'Tools:Recap', path },
        { type: 'mention', name: asset.name, path: asset.path },
      ]);
      reply(h, { turn: { id: TURN } });
      await delivery;
      h.wire.receive(TURN_COMPLETED);
    }
  }
  h.wire.close('test complete');
});

test('Codex attaches only an enabled unambiguous leading catalog skill in its directory', async () => {
  const h = harness();
  const opening = h.wire.commands();
  const skill = { name: 'recap', path: 'C:\\skills\\recap\\SKILL.md', enabled: true };
  reply(h, {
    data: [
      { cwd: 'C:\\elsewhere', skills: [{ ...skill, name: 'elsewhere' }] },
      {
        cwd: 'C:\\ws',
        skills: [
          skill,
          { ...skill, name: 'disabled', enabled: false },
          { ...skill, name: 'uncertain', enabled: undefined },
          { ...skill, name: 'missing', path: undefined },
          { ...skill, name: 'duplicate' },
          { ...skill, name: 'Duplicate', path: '/other/SKILL.md' },
          ...['compact', 'clear', 'new', 'rename'].map((name) => ({ ...skill, name })),
          { ...skill, name: 'bad/name' },
          { ...skill, name: 'bad`name' },
        ],
        errors: [],
      },
    ],
  });
  await opening;
  const starting = h.wire.startThread({ cwd: 'C:\\ws' });
  reply(h, { thread: { id: THREAD } });
  await starting;
  for (const text of [
    'explain /recap',
    'https://example/recap',
    '\\$recap',
    '\\ /recap',
    '"/recap"',
    '`/recap`',
    '```\n/recap\n```',
    '/rec',
    '/recap,',
    '$HOME',
    '/disabled',
    '/uncertain',
    '/missing',
    '/duplicate',
    '/elsewhere',
    '/bad/name',
    '/bad`name',
    '/unknown',
    '/',
    '$',
    '/compact',
    '/clear',
    '/new review',
    '/rename title',
  ]) {
    const delivery = h.wire.prompt(text);
    assert.deepEqual(h.parsed().at(-1).params.input, [{ type: 'text', text }], text);
    reply(h, { turn: { id: TURN } });
    await delivery;
    h.wire.receive(TURN_COMPLETED);
  }
  h.wire.close('test complete');
});

test('Codex waits for current skill discovery and never attaches stale display paths after failure or removal', async () => {
  const h = harness();
  const starting = h.wire.startThread({ cwd: 'C:\\ws' });
  reply(h, { thread: { id: THREAD } });
  await starting;
  const opening = h.wire.commands();
  const first = h.wire.prompt('/recap');
  assert.equal(h.parsed().filter((m) => m.method === 'turn/start').length, 0);
  reply(h, { data: [{ cwd: 'C:\\ws', skills: [{ name: 'recap', path: '/old/SKILL.md', enabled: true }] }] });
  await opening;
  await vi.waitFor(() => assert.equal(h.parsed().at(-1).method, 'turn/start'));
  assert.deepEqual(h.parsed().at(-1).params.input[1], { type: 'skill', name: 'recap', path: '/old/SKILL.md' });
  reply(h, { turn: { id: TURN } });
  await first;
  h.wire.receive(TURN_COMPLETED);
  for (const outcome of ['changed', 'failed', 'removed']) {
    h.wire.receive(JSON.stringify({ method: 'skills/changed', params: {} }));
    const before = h.parsed().filter((m) => m.method === 'turn/start').length;
    const delivery = h.wire.prompt('$recap');
    assert.equal(h.parsed().filter((m) => m.method === 'turn/start').length, before);
    if (outcome === 'changed') {
      h.wire.receive(JSON.stringify({ method: 'skills/changed', params: {} }));
      reply(h, {
        data: [{ cwd: 'C:\\ws', skills: [{ name: 'recap', path: '/intermediate/SKILL.md', enabled: true }] }],
      });
      await vi.waitFor(() => assert.equal(h.parsed().filter((m) => m.method === 'skills/list').length, 3));
      assert.equal(h.parsed().filter((m) => m.method === 'turn/start').length, before);
      reply(h, { data: [{ cwd: 'C:\\ws', skills: [{ name: 'recap', path: '/current/SKILL.md', enabled: true }] }] });
    } else if (outcome === 'failed') {
      h.wire.receive(JSON.stringify({ id: h.parsed().at(-1).id, error: { code: -1, message: 'discovery failed' } }));
    } else reply(h, { data: [{ cwd: 'C:\\ws', skills: [] }] });
    await vi.waitFor(() => assert.equal(h.parsed().at(-1).method, 'turn/start'));
    assert.deepEqual(h.parsed().at(-1).params.input, [
      { type: 'text', text: '$recap' },
      ...(outcome === 'changed' ? [{ type: 'skill', name: 'recap', path: '/current/SKILL.md' }] : []),
    ]);
    reply(h, { turn: { id: TURN } });
    await delivery;
    h.wire.receive(TURN_COMPLETED);
  }
  h.wire.close('test complete');
});

test('Stop cancels Codex input awaiting skill discovery before its native write', async () => {
  const h = harness();
  const starting = h.wire.startThread({ cwd: 'C:\\ws' });
  reply(h, { thread: { id: THREAD } });
  await starting;
  const discovery = h.wire.commands();
  const delivery = h.wire.prompt('/recap');
  let outcome: string | null = null;
  const settled = delivery.then(
    () => (outcome = 'accepted'),
    () => (outcome = 'stopped'),
  );
  await h.wire.interrupt();
  reply(h, { data: [] });
  await discovery;
  await vi.waitFor(() => assert.ok(outcome || h.parsed().some((m) => m.method === 'turn/start')));
  assert.equal(h.parsed().filter((m) => m.method === 'turn/start').length, 0);
  assert.equal(await settled, 'stopped');
  h.wire.close('test complete');
});

test('Codex discovery preserves skill then ordinary submission order without awaiting acceptance', async () => {
  const h = harness();
  const starting = h.wire.startThread({ cwd: 'C:\\ws' });
  reply(h, { thread: { id: THREAD } });
  await starting;
  const discovery = h.wire.commands();
  const first = h.wire.prompt('/recap first');
  const second = h.wire.prompt('second prompt');
  assert.equal(h.parsed().filter((m) => m.method === 'turn/start').length, 0);
  reply(h, { data: [] });
  await discovery;
  await vi.waitFor(() => assert.equal(h.parsed().filter((m) => m.method === 'turn/start').length, 2));
  const starts = h.parsed().filter((m) => m.method === 'turn/start');
  assert.deepEqual(
    starts.map((m) => m.params.input[0].text),
    ['/recap first', 'second prompt'],
  );
  for (const start of starts) h.wire.receive(JSON.stringify({ id: start.id, result: { turn: { id: TURN } } }));
  await Promise.all([first, second]);
  h.wire.close('test complete');
});

test('mid-turn prompts that share a turn id are stopped and completed as one turn', async () => {
  const h = harness();
  const starting = h.wire.startThread({ cwd: 'C:\\ws' });
  reply(h, { thread: { id: THREAD } });
  await starting;

  const prompting = h.wire.prompt('hello');
  const turn = h.parsed().find((message) => message.method === 'turn/start');
  h.wire.receive(JSON.stringify({ id: turn.id, result: { turn: { id: TURN, status: 'inProgress' } } }));
  await prompting;
  const queued = h.wire.prompt('again');
  const starts = h.parsed().filter((message) => message.method === 'turn/start');
  h.wire.receive(
    JSON.stringify({
      id: starts[1].id,
      result: { turn: { id: TURN, status: 'inProgress' } },
    }),
  );
  await queued;

  const stopping = h.wire.interrupt();
  const interrupt = h.parsed().find((message) => message.method === 'turn/interrupt');
  assert.deepEqual(interrupt.params, { threadId: THREAD, turnId: TURN });
  h.wire.receive(JSON.stringify({ id: interrupt.id, result: {} }));
  await stopping;

  h.wire.receive(TURN_COMPLETED);
  assert.equal(
    h.events.filter((event) => event.kind === 'turnEnd').length,
    1,
    'one server turn emitted an ending for each accepted prompt',
  );
  const interruptsBefore = h.parsed().filter((message) => message.method === 'turn/interrupt').length;
  await h.wire.interrupt();
  assert.equal(
    h.parsed().filter((message) => message.method === 'turn/interrupt').length,
    interruptsBefore,
    'Stop reused the id after its server turn completed',
  );
});

test('Stop keeps the oldest prompt when same-turn start responses arrive out of order', async () => {
  const h = harness();
  const starting = h.wire.startThread({ cwd: 'C:\\ws' });
  reply(h, { thread: { id: THREAD } });
  await starting;

  const first = h.wire.prompt('first');
  const second = h.wire.prompt('second');
  const starts = h.parsed().filter((message) => message.method === 'turn/start');
  const stopping = h.wire.interrupt();

  h.wire.receive(
    JSON.stringify({
      id: starts[1].id,
      result: { turn: { id: TURN, status: 'inProgress' } },
    }),
  );
  await second;
  h.wire.receive(
    JSON.stringify({
      id: starts[0].id,
      result: { turn: { id: TURN, status: 'inProgress' } },
    }),
  );
  await first;
  await new Promise((resolve) => setImmediate(resolve));

  const interrupt = h.parsed().find((message) => message.method === 'turn/interrupt');
  assert.deepEqual(interrupt?.params, { threadId: THREAD, turnId: TURN });
  h.wire.receive(JSON.stringify({ id: interrupt.id, result: {} }));
  await stopping;
});

test('Stop advances to an accepted turn when the oldest pending start is refused', async () => {
  const h = harness();
  const starting = h.wire.startThread({ cwd: 'C:\\ws' });
  reply(h, { thread: { id: THREAD } });
  await starting;

  const first = h.wire.prompt('first');
  const refused = assert.rejects(first, /first start was refused/);
  const second = h.wire.prompt('second');
  const starts = h.parsed().filter((message) => message.method === 'turn/start');
  h.wire.receive(
    JSON.stringify({
      id: starts[1].id,
      result: { turn: { id: TURN, status: 'inProgress' } },
    }),
  );
  await second;
  const stopping = h.wire.interrupt();
  h.wire.receive(
    JSON.stringify({
      id: starts[0].id,
      error: { code: -32600, message: 'first start was refused' },
    }),
  );
  await refused;
  await new Promise((resolve) => setImmediate(resolve));

  const interrupt = h.parsed().find((message) => message.method === 'turn/interrupt');
  assert.deepEqual(interrupt?.params, { threadId: THREAD, turnId: TURN });
  h.wire.receive(JSON.stringify({ id: interrupt.id, result: {} }));
  await stopping;
});

test('a duplicate completion cannot make a pending same-turn prompt end twice', async () => {
  const h = harness();
  const starting = h.wire.startThread({ cwd: 'C:\\ws' });
  reply(h, { thread: { id: THREAD } });
  await starting;

  const first = h.wire.prompt('first');
  const second = h.wire.prompt('second');
  const starts = h.parsed().filter((message) => message.method === 'turn/start');
  h.wire.receive(TURN_COMPLETED);
  h.wire.receive(
    JSON.stringify({
      id: starts[0].id,
      result: { turn: { id: TURN, status: 'completed' } },
    }),
  );
  await first;
  assert.equal(h.events.filter((event) => event.kind === 'turnEnd').length, 1);

  h.wire.receive(TURN_COMPLETED);
  h.wire.receive(
    JSON.stringify({
      id: starts[1].id,
      result: { turn: { id: TURN, status: 'completed' } },
    }),
  );
  await second;
  assert.equal(
    h.events.filter((event) => event.kind === 'turnEnd').length,
    1,
    'the repeated completion weakened the recorded ending',
  );
  assert.equal(h.wire.hasOpenTurns(), false);
});

test('a stop pressed while a turn is being accepted waits for its id', async () => {
  const h = harness();
  const starting = h.wire.startThread({ cwd: 'C:\\ws' });
  reply(h, { thread: { id: THREAD } });
  await starting;

  const prompting = h.wire.prompt('hello');
  const turn = h.parsed().find((message) => message.method === 'turn/start');
  const stopping = h.wire.interrupt();
  assert.equal(
    h.parsed().some((message) => message.method === 'turn/interrupt'),
    false,
    'stop sent an incomplete request before turn/start answered',
  );

  h.wire.receive(JSON.stringify({ id: turn.id, result: { turn: { id: TURN, status: 'inProgress' } } }));
  await prompting;
  await new Promise((resolve) => setImmediate(resolve));
  const interrupt = h.parsed().find((message) => message.method === 'turn/interrupt');
  assert.deepEqual(interrupt.params, { threadId: THREAD, turnId: TURN });
  h.wire.receive(JSON.stringify({ id: interrupt.id, result: {} }));
  await stopping;
});

test('turn endings clear only the active turn they name', async () => {
  const h = harness();
  const starting = h.wire.startThread({ cwd: 'C:\\ws' });
  reply(h, { thread: { id: THREAD } });
  await starting;

  const firstPrompt = h.wire.prompt('first');
  const firstStart = h.parsed().find((message) => message.method === 'turn/start');
  h.wire.receive(JSON.stringify({ id: firstStart.id, result: { turn: { id: TURN, status: 'inProgress' } } }));
  h.wire.receive(TURN_COMPLETED);
  await firstPrompt;
  assert.equal(h.events.filter((event) => event.kind === 'turnEnd').length, 1);
  const afterFirst = h.parsed().length;
  await h.wire.interrupt();
  assert.equal(
    h.parsed().length,
    afterFirst,
    'a turn that completed beside its start response remained available to stop',
  );

  const secondTurn = `${TURN}-second`;
  const secondPrompt = h.wire.prompt('second');
  const starts = h.parsed().filter((message) => message.method === 'turn/start');
  const secondStart = starts[starts.length - 1];
  h.wire.receive(JSON.stringify({ id: secondStart.id, result: { turn: { id: secondTurn, status: 'inProgress' } } }));
  await secondPrompt;
  h.wire.receive(TURN_COMPLETED);
  h.wire.receive(
    JSON.stringify({
      method: 'turn/failed',
      params: { threadId: THREAD, turnId: TURN, error: { message: 'late failure' } },
    }),
  );
  assert.equal(
    h.events.filter((event) => event.kind === 'turnEnd').length,
    1,
    'a stale ending was reported as the end of the active turn',
  );

  const stopping = h.wire.interrupt();
  const interrupts = h.parsed().filter((message) => message.method === 'turn/interrupt');
  const interrupt = interrupts[interrupts.length - 1];
  assert.deepEqual(
    interrupt.params,
    { threadId: THREAD, turnId: secondTurn },
    'a late ending for the older turn cleared or replaced the newer turn',
  );
  h.wire.receive(JSON.stringify({ id: interrupt.id, result: {} }));
  await stopping;

  h.wire.receive(
    JSON.stringify({
      method: 'turn/failed',
      params: { threadId: THREAD, turnId: secondTurn, error: { message: 'stopped' } },
    }),
  );
  assert.equal(h.events.filter((event) => event.kind === 'turnEnd').length, 2);
  const afterFailure = h.parsed().length;
  await h.wire.interrupt();
  assert.equal(h.parsed().length, afterFailure, 'a failed turn remained available to stop again');
});

test('a malformed turn start fails the prompt and never arms stop', async () => {
  const h = harness();
  const starting = h.wire.startThread({ cwd: 'C:\\ws' });
  reply(h, { thread: { id: THREAD } });
  await starting;

  const prompting = h.wire.prompt('hello');
  const turn = h.parsed().find((message) => message.method === 'turn/start');
  const stopping = h.wire.interrupt();
  h.wire.receive(JSON.stringify({ id: turn.id, result: { turn: { status: 'inProgress' } } }));
  await assert.rejects(prompting, /accepted a turn without naming it/);
  await assert.doesNotReject(stopping);
  await h.wire.interrupt();
  assert.equal(
    h.parsed().some((message) => message.method === 'turn/interrupt'),
    false,
  );
});

test('closing a pending turn start clears stop and settles both callers', async () => {
  const h = harness();
  const starting = h.wire.startThread({ cwd: 'C:\\ws' });
  reply(h, { thread: { id: THREAD } });
  await starting;

  const prompting = h.wire.prompt('hello');
  const stopping = h.wire.interrupt();
  h.wire.close('the agent stopped');
  await assert.rejects(prompting, /the agent stopped/);
  await assert.doesNotReject(stopping);
  await h.wire.interrupt();
  assert.equal(
    h.parsed().some((message) => message.method === 'turn/interrupt'),
    false,
  );
});

test('a thread with no active turn sends no stop request', async () => {
  const h = harness();
  const starting = h.wire.startThread({ cwd: 'C:\\ws' });
  reply(h, { thread: { id: THREAD } });
  await starting;
  const before = h.parsed().length;
  await h.wire.interrupt();
  assert.equal(h.parsed().length, before);
});

test('Codex prompts use local image and mention inputs without raw bytes', async () => {
  const h = harness();
  const starting = h.wire.startThread({ cwd: 'C:\\ws' });
  reply(h, { thread: { id: THREAD } });
  await starting;
  void h.wire.prompt({
    text: '',
    assets: [
      { id: 'one', name: 'photo.png', mime: 'image/png', size: 4, digest: '0'.repeat(64), path: 'C:\\staged\\one' },
      { id: 'two', name: 'notes.txt', mime: 'text/plain', size: 5, digest: '0'.repeat(64), path: 'C:\\staged\\two' },
    ],
  });
  const turn = h.parsed()[1];
  assert.deepEqual(turn.params.input, [
    { type: 'localImage', path: 'C:\\staged\\one' },
    { type: 'mention', name: 'notes.txt', path: 'C:\\staged\\two' },
  ]);
  assert.doesNotMatch(JSON.stringify(turn), /aGVsbG8|data/);
});

test("the agent's commentary and commands are reported as activity", () => {
  const h = harness();
  h.wire.receive(AGENT_MESSAGE);
  h.wire.receive(COMMAND_STARTED);
  assert.deepEqual(
    h.events.filter((e) => e.kind === 'activity').map((e) => (e.kind === 'activity' ? e.activity : null)),
    [
      {
        sourceId: 'msg_1',
        kind: 'commentary',
        name: 'Update',
        headline: 'Worked',
        detail: 'Running the requested command.',
        status: 'done',
      },
      {
        sourceId: 'exec-1',
        kind: 'tool',
        name: 'Shell',
        headline: 'Running',
        detail: '"powershell.exe" -Command \'echo codex-probe\'',
        status: 'running',
      },
    ],
  );
});

test('a completed turn carries the final answer, not the running commentary', () => {
  const h = harness();
  h.wire.receive(AGENT_MESSAGE);
  h.wire.receive(TURN_COMPLETED);
  const end = h.events.find((e) => e.kind === 'turnEnd') as {
    kind: 'turnEnd';
    outcome: { status: string; text: string };
  };
  assert.equal(end.outcome.status, 'ok');
  assert.equal(end.outcome.text, 'done');
});

test('a stopped turn is not reported as a failure, and a failed one is', () => {
  assert.equal(turnOutcome({ status: 'aborted', items: [] }).status, 'interrupted');
  assert.equal(turnOutcome({ status: 'failed', items: [] }).status, 'error');
  assert.equal(turnOutcome(null).status, 'error');
});

test('the rate-limit share is converted to the fraction the panel speaks in', () => {
  const h = harness();
  h.wire.receive(RATE_LIMITS);
  const limit = h.events.find((e) => e.kind === 'rateLimit') as { kind: 'rateLimit'; limit: RateLimit };
  assert.deepEqual(limit.limit, {
    window: 'five_hour',
    utilization: 0.03,
    resetsAtSeconds: 1787924682,
    status: '',
    // This account limit derives its clock group from its duration. Its empty scope covers all models.

    group: 'session',
    scope: '',
  });
});

test('Codex marks its native compact command and working-directory skills as distinct prompt entries', async () => {
  const h = harness();
  const commands = h.wire.commands();
  assert.deepEqual(h.parsed(), [
    {
      id: 1,
      method: 'skills/list',
      params: { cwds: ['C:\\ws'] },
    },
  ]);
  reply(h, {
    data: [
      {
        cwd: 'C:\\ws',
        skills: [
          {
            name: 'polish',
            description: 'Clean the writing',
            path: 'C:\\Users\\reader\\.codex\\skills\\polish\\SKILL.md',
          },
          { name: 'COMPACT', description: 'Duplicate native command' },
          { name: '', description: 'Cannot be selected' },
        ],
      },
    ],
  });
  assert.deepEqual(await commands, [
    { kind: 'command', name: 'compact', description: 'Compact the session', argumentHint: '' },
    { kind: 'command', name: 'clear', description: 'Start a new session', argumentHint: '' },
    { kind: 'command', name: 'new', description: 'Start and name a new session', argumentHint: '[name]' },
    { kind: 'command', name: 'rename', description: 'Rename the session', argumentHint: '<name>' },
    {
      kind: 'skill',
      name: 'polish',
      description: 'Clean the writing',
      argumentHint: '',
      path: 'C:\\Users\\reader\\.codex\\skills\\polish\\SKILL.md',
    },
  ]);
  assert.equal(h.events[0].kind, 'ready');
});

test('a Codex skill-change notification replaces the live command catalog', async () => {
  const h = harness();
  const opening = h.wire.commands();
  reply(h, {
    data: [{ cwd: 'C:\\ws', skills: [{ name: 'polish', description: 'Clean the writing' }] }],
  });
  await opening;

  h.wire.receive(JSON.stringify({ method: 'skills/changed', params: {} }));
  assert.deepEqual(h.parsed().at(-1), {
    id: 2,
    method: 'skills/list',
    params: { cwds: ['C:\\ws'], forceReload: true },
  });
  reply(h, {
    data: [{ cwd: 'C:\\ws', skills: [{ name: 'summarize', description: 'Summarize the text' }] }],
  });
  await vi.waitFor(() => assert.equal(h.events.at(-1)?.kind, 'commands'));

  assert.deepEqual(h.events.at(-1), {
    kind: 'commands',
    commands: [
      { kind: 'command', name: 'compact', description: 'Compact the session', argumentHint: '' },
      { kind: 'command', name: 'clear', description: 'Start a new session', argumentHint: '' },
      { kind: 'command', name: 'new', description: 'Start and name a new session', argumentHint: '[name]' },
      { kind: 'command', name: 'rename', description: 'Rename the session', argumentHint: '<name>' },
      { kind: 'skill', name: 'summarize', description: 'Summarize the text', argumentHint: '', path: undefined },
    ],
  });
});

test('a Codex skill change during opening waits for the initial command catalog', async () => {
  const h = harness();
  const opening = h.wire.commands();

  h.wire.receive(JSON.stringify({ method: 'skills/changed', params: {} }));
  assert.equal(h.parsed().filter((message) => message.method === 'skills/list').length, 1);

  h.wire.receive(
    JSON.stringify({
      id: 1,
      result: { data: [{ cwd: 'C:\\ws', skills: [{ name: 'stale', description: 'Opening version' }] }] },
    }),
  );
  await vi.waitFor(() => {
    assert.deepEqual(h.parsed().at(-1), {
      id: 2,
      method: 'skills/list',
      params: { cwds: ['C:\\ws'], forceReload: true },
    });
  });
  h.wire.receive(
    JSON.stringify({
      id: 2,
      result: { data: [{ cwd: 'C:\\ws', skills: [{ name: 'current', description: 'Current version' }] }] },
    }),
  );
  await opening;
  await vi.waitFor(() => assert.equal(h.events.at(-1)?.kind, 'commands'));

  assert.deepEqual(
    h.events.map((event) => event.kind),
    ['ready', 'commands'],
  );
  const update = h.events.at(-1);
  assert.deepEqual(update?.kind === 'commands' ? update.commands.map((command) => command.name) : [], [
    'compact',
    'clear',
    'new',
    'rename',
    'current',
  ]);
});

test('a failed Codex skill refresh keeps the last command catalog', async () => {
  const h = harness();
  const opening = h.wire.commands();
  reply(h, {
    data: [{ cwd: 'C:\\ws', skills: [{ name: 'polish', description: 'Clean the writing' }] }],
  });
  await opening;

  h.wire.receive(JSON.stringify({ method: 'skills/changed', params: {} }));
  h.wire.receive(JSON.stringify({ id: 2, error: { code: -32603, message: 'scan failed' } }));
  assert.deepEqual(
    h.events.map((event) => event.kind),
    ['ready'],
  );
  h.wire.receive(JSON.stringify({ method: 'skills/changed', params: {} }));
  await vi.waitFor(() => {
    assert.deepEqual(h.parsed().at(-1), {
      id: 3,
      method: 'skills/list',
      params: { cwds: ['C:\\ws'], forceReload: true },
    });
  });
});

test('Codex skill-change bursts coalesce into one trailing refresh', async () => {
  const h = harness();
  const opening = h.wire.commands();
  reply(h, { data: [{ cwd: 'C:\\ws', skills: [] }] });
  await opening;

  h.wire.receive(JSON.stringify({ method: 'skills/changed', params: {} }));
  h.wire.receive(JSON.stringify({ method: 'skills/changed', params: {} }));
  h.wire.receive(JSON.stringify({ method: 'skills/changed', params: {} }));
  assert.equal(h.parsed().filter((message) => message.method === 'skills/list').length, 2);

  reply(h, {
    data: [{ cwd: 'C:\\ws', skills: [{ name: 'first', description: 'First version' }] }],
  });
  await vi.waitFor(() => {
    assert.deepEqual(h.parsed().at(-1), {
      id: 3,
      method: 'skills/list',
      params: { cwds: ['C:\\ws'], forceReload: true },
    });
  });
  reply(h, {
    data: [{ cwd: 'C:\\ws', skills: [{ name: 'settled', description: 'Settled version' }] }],
  });
  await vi.waitFor(() => {
    assert.equal(h.events.filter((event) => event.kind === 'commands').length, 2);
  });

  assert.equal(h.parsed().filter((message) => message.method === 'skills/list').length, 3);
  const updates = h.events.filter((event) => event.kind === 'commands');
  assert.deepEqual(
    updates.map((event) => (event.kind === 'commands' ? event.commands.map((command) => command.name) : [])),
    [
      ['compact', 'clear', 'new', 'rename', 'first'],
      ['compact', 'clear', 'new', 'rename', 'settled'],
    ],
  );
});

test('closing the Codex wire cancels a pending skill refresh and ignores later changes', async () => {
  const h = harness();
  const opening = h.wire.commands();
  reply(h, { data: [{ cwd: 'C:\\ws', skills: [] }] });
  await opening;

  h.wire.receive(JSON.stringify({ method: 'skills/changed', params: {} }));
  h.wire.close('closed');
  h.wire.receive(JSON.stringify({ method: 'skills/changed', params: {} }));

  assert.equal(h.parsed().filter((message) => message.method === 'skills/list').length, 2);
  assert.deepEqual(
    h.events.map((event) => event.kind),
    ['ready'],
  );
});

test('a skill-list failure leaves native autocomplete available without closing the wire', async () => {
  const h = harness();
  const commands = h.wire.commands();
  h.wire.receive(
    JSON.stringify({
      id: 1,
      error: { code: -32601, message: 'Method not found' },
    }),
  );
  assert.deepEqual(
    (await commands).map((command) => command.name),
    ['compact', 'clear', 'new', 'rename'],
  );
  assert.equal(h.events[0].kind, 'ready');

  const limits = h.wire.rateLimits();
  assert.equal(h.parsed()[1].method, 'account/read');
  reply(h, { account: { type: 'chatgpt' } });
  await vi.waitFor(() => assert.equal(h.parsed()[2].method, 'account/rateLimits/read'));
  reply(h, { rateLimits: null });
  assert.deepEqual(await limits, { rateLimits: null });
});

test('a skill-list timeout leaves native autocomplete available', async () => {
  const h = harness(10);
  assert.deepEqual(
    (await waitForDeadline(h.wire.commands())).map((command) => command.name),
    ['compact', 'clear', 'new', 'rename'],
  );
  assert.equal(h.events[0].kind, 'ready');
});

test('Codex MCP inventory joins tool names to startup status and stays read-only', async () => {
  const h = harness();
  h.wire.receive(
    JSON.stringify({
      method: 'mcpServer/startupStatus/updated',
      params: { threadId: null, name: 'files', status: 'failed', error: 'Connection closed' },
    }),
  );
  const listing = h.wire.mcpStatus();
  assert.deepEqual(h.parsed()[0], {
    id: 1,
    method: 'mcpServerStatus/list',
    params: { detail: 'toolsAndAuthOnly' },
  });
  reply(h, {
    data: [
      {
        name: 'files',
        serverInfo: null,
        tools: { read_file: { name: 'read_file' }, write_file: { name: 'write_file' } },
        authStatus: 'unsupported',
      },
    ],
    nextCursor: null,
  });
  assert.deepEqual(await listing, [
    {
      name: 'files',
      status: 'failed',
      error: 'Connection closed',
      tools: ['read_file', 'write_file'],
      scope: '',
      title: '',
      mutable: false,
    },
  ]);
});

test('Codex MCP inventory follows pagination and uses ready when server info arrived', async () => {
  const h = harness();
  const listing = h.wire.mcpStatus();
  reply(h, {
    data: [{ name: 'one', serverInfo: { name: 'first' }, tools: {}, authStatus: 'unsupported' }],
    nextCursor: 'next-page',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.parsed()[1].params.cursor, 'next-page');
  reply(h, {
    data: [{ name: 'two', serverInfo: { title: 'Second' }, tools: {}, authStatus: 'oAuth' }],
    nextCursor: null,
  });
  const servers = await listing;
  assert.deepEqual(
    servers.map((server) => [server.name, server.status, server.title]),
    [
      ['one', 'ready', 'first'],
      ['two', 'ready', 'Second'],
    ],
  );
  assert.deepEqual(readCodexMcpServers([{ name: '', tools: {} }, { tools: {} }]), []);
});

test('an unreadable line is reported and the next one is still read', () => {
  const h = harness();
  h.wire.receive('}{ not json');
  h.wire.receive(AGENT_MESSAGE);
  assert.equal(h.events[0].kind, 'error');
  assert.equal(h.events[1].kind, 'activity');
});

test('closing settles everyone waiting instead of leaving them hung', async () => {
  const h = harness();
  const pending = h.wire.listThreads();
  h.wire.close('the agent stopped');
  await assert.rejects(pending, /the agent stopped/);
});

test('an error response reaches the caller as the failure it is', async () => {
  const h = harness();
  const pending = h.wire.listThreads();
  h.wire.receive(JSON.stringify({ id: 1, error: { code: -32602, message: 'bad params' } }));
  await assert.rejects(pending, /bad params/);
});

// The question fixture uses ToolRequestUserInputParams and ToolRequestUserInputResponse from the app-server protocol.

const USER_INPUT_REQUEST = JSON.stringify({
  id: 4,
  method: 'item/tool/requestUserInput',
  params: {
    threadId: THREAD,
    turnId: TURN,
    itemId: 'tool-9',
    autoResolutionMs: null,
    questions: [
      {
        id: 'q_colour',
        header: 'Colour',
        question: 'Which colour do you prefer?',
        isOther: false,
        isSecret: false,
        options: [
          { label: 'Red', description: 'A warm colour' },
          { label: 'Blue', description: 'A cool colour' },
        ],
      },
    ],
  },
});

test('a user-input request is a question, not a command the reader is asked to allow', () => {
  const h = harness();
  h.wire.receive(USER_INPUT_REQUEST);
  const event = h.events.find((e) => e.kind === 'ask') as { kind: 'ask'; ask: Ask };
  assert.equal(
    event.ask.kind,
    'question',
    'labelling this "Shell wants to run" would be a lie about what is being asked',
  );
  if (event.ask.kind !== 'question') return;
  assert.equal(event.ask.questions[0].question, 'Which colour do you prefer?');
  assert.equal(event.ask.questions[0].id, 'q_colour', 'the answer is keyed by this, not by the question text');
  assert.deepEqual(
    event.ask.questions[0].options.map((o) => o.label),
    ['Red', 'Blue'],
  );
  assert.equal(event.ask.questions[0].secret, false);
});

test('a question that asks for a secret says so, so the card can keep the answer off its tab', () => {
  const h = harness();
  h.wire.receive(
    JSON.stringify({
      id: 5,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: THREAD,
        turnId: TURN,
        itemId: 'tool-10',
        autoResolutionMs: null,
        questions: [
          {
            id: 'q_token',
            header: 'Token',
            question: 'Which token should the deploy use?',
            isOther: false,
            isSecret: true,
            options: [],
          },
        ],
      },
    }),
  );
  const event = h.events.find((e) => e.kind === 'ask') as { kind: 'ask'; ask: Ask };
  assert.equal(event.ask.kind === 'question' && event.ask.questions[0].secret, true);
});

test('an answer the reader wrote themselves goes back in the same list as the labels', () => {
  const h = harness();
  h.wire.receive(USER_INPUT_REQUEST);
  h.wire.answer('tool-9', {
    decision: 'answer',
    answers: { q_colour: { labels: [], written: 'sea green' } },
  });
  assert.deepEqual(h.parsed()[0].result, { answers: { q_colour: { answers: ['sea green'] } } });
});

test('a user-input request is answered with a map of answers, not with a verdict', () => {
  const h = harness();
  h.wire.receive(USER_INPUT_REQUEST);
  assert.equal(
    h.wire.answer('tool-9', {
      decision: 'answer',
      answers: { q_colour: { labels: ['Red'], written: '' } },
    }),
    true,
  );
  const reply = h.parsed()[0];
  assert.equal(reply.id, 4);
  assert.equal(reply.result.decision, undefined, 'a verdict is the wrong shape and the server would not read it');
  assert.deepEqual(reply.result, { answers: { q_colour: { answers: ['Red'] } } });
});

test('an approval still takes a verdict, so the two shapes do not get crossed', () => {
  const h = harness();
  h.wire.receive(APPROVAL_REQUEST);
  h.wire.receive(USER_INPUT_REQUEST);
  const asks = h.events.filter((e) => e.kind === 'ask') as { kind: 'ask'; ask: Ask }[];
  h.wire.answer(asks[0].ask.id, { decision: 'allow' });
  h.wire.answer(asks[1].ask.id, {
    decision: 'answer',
    answers: { q_colour: { labels: ['Blue'], written: '' } },
  });
  const [approval, question] = h.parsed();
  assert.deepEqual(approval.result, { decision: 'accept' });
  assert.deepEqual(question.result, { answers: { q_colour: { answers: ['Blue'] } } });
});

test('a permissions-profile approval is refused rather than answered with a verdict', () => {
  // Permission-profile approvals require a profile and scope. A command-approval verdict cannot answer that request.

  const h = harness();
  h.wire.receive(
    JSON.stringify({
      id: 5,
      method: 'item/permissions/requestApproval',
      params: { threadId: THREAD, turnId: TURN, itemId: 'perm-1', cwd: 'C:\\ws', permissions: {} },
    }),
  );
  assert.deepEqual(
    h.events.filter((e) => e.kind === 'ask'),
    [],
  );
  const reply = h.parsed()[0];
  assert.equal(reply.id, 5);
  assert.ok(reply.error, 'an unanswered server request stalls the turn, so it is refused rather than ignored');
});

test('both windows the server volunteers reach the panel, shorter first', () => {
  // Publish both limit windows so the usage bar can display each one.

  const h = harness();
  h.wire.receive(RATE_LIMITS);
  const limits = h.events.flatMap((e) => (e.kind === 'rateLimit' && e.limit !== null ? [e.limit] : []));
  assert.deepEqual(limits, [
    { window: 'five_hour', utilization: 0.03, resetsAtSeconds: 1787924682, status: '', group: 'session', scope: '' },
    { window: 'seven_day', utilization: 0.01, resetsAtSeconds: 1788470887, status: '', group: 'weekly', scope: '' },
  ]);
});

test('the rate-limit request answers in the same shape the notification does', () => {
  // One reader behind both, because a strip fed by the notification and refreshed by the
  // request would otherwise be folding two shapes into one row.
  const reading = readRateLimits(JSON.parse(RATE_LIMITS).params, 1_700_000_000_000);
  assert.ok(reading);
  assert.equal(reading.plan, 'plus');
  assert.equal(reading.complete, true);
  assert.equal(reading.spend, null);
  assert.equal(reading.readAt, 1_700_000_000_000);
  assert.deepEqual(reading.limits, [
    { window: 'five_hour', utilization: 0.03, resetsAtSeconds: 1787924682, status: '', group: 'session', scope: '' },
    { window: 'seven_day', utilization: 0.01, resetsAtSeconds: 1788470887, status: '', group: 'weekly', scope: '' },
  ]);
});

test('a window of an unfamiliar length keeps its own length rather than a wrong name', () => {
  const reading = readRateLimits(
    {
      rateLimits: { planType: 'pro', primary: { usedPercent: 12, windowDurationMins: 600, resetsAt: 1787924682 } },
    },
    1,
  );
  assert.equal(
    reading?.limits[0].window,
    '600_minute',
    'a ten-hour window called five_hour would put a wrong word on a real figure',
  );
  assert.equal(
    reading?.limits[0].group,
    '',
    'and a ten-hour window filed under the session clock would be drawn beside figures covering another period',
  );
});

test('a server that reports no window at all is reported as nothing', () => {
  assert.equal(readRateLimits({ rateLimits: { planType: 'plus' } }, 1), null);
  assert.equal(readRateLimits({}, 1), null);
  assert.equal(readRateLimits(null, 1), null);
});

test('the rate-limit request discovers the account before any thread', async () => {
  const h = harness();
  const pending = h.wire.rateLimits();
  assert.equal(h.parsed()[0].method, 'account/read');
  reply(h, { account: { type: 'chatgpt' } });
  await vi.waitFor(() => assert.equal(h.parsed()[1].method, 'account/rateLimits/read'));
  reply(h, { rateLimits: null });
  await pending;
});

test('an explicit rate-limit refresh renews managed authentication after eligibility discovery', async () => {
  const h = harness();
  const reading = h.wire.rateLimits(true);
  assert.deepEqual(h.parsed()[0], { id: 1, method: 'account/read', params: { refreshToken: false } });
  reply(h, { account: { type: 'chatgpt' } });
  await vi.waitFor(() => assert.equal(h.parsed().length, 2));
  assert.deepEqual(h.parsed()[1], { id: 2, method: 'account/read', params: { refreshToken: true } });
  reply(h, { account: { type: 'chatgpt' } });
  await vi.waitFor(() => assert.equal(h.parsed().length, 3));
  assert.equal(h.parsed()[2].method, 'account/rateLimits/read');
  reply(h, { rateLimits: null });
  assert.deepEqual(await reading, { rateLimits: null });
});

test('Bedrock account discovery excludes limits and explicit rediscovery restores supported usage', async () => {
  const h = harness();
  const first = h.wire.rateLimits(true);
  assert.deepEqual(h.parsed()[0].params, { refreshToken: false });
  reply(h, { account: { type: 'amazonBedrock' }, requiresOpenaiAuth: false });
  assert.deepEqual(await first, {});
  assert.deepEqual(
    h.parsed().map((m) => m.method),
    ['account/read'],
  );
  assert.equal(await h.wire.usageSupported(), false);
  const rediscovery = h.wire.usageSupported(true);
  reply(h, { account: { type: 'chatgpt' } });
  assert.equal(await rediscovery, true);
  const next = h.wire.rateLimits(true);
  await vi.waitFor(() => assert.equal(h.parsed().at(-1).params.refreshToken, true));
  reply(h, { account: { type: 'chatgpt' } });
  await vi.waitFor(() => assert.equal(h.parsed().at(-1).method, 'account/rateLimits/read'));
  reply(h, { rateLimits: null });
  assert.deepEqual(await next, { rateLimits: null });
  h.wire.close('finished');
});

test('unknown and signed-out Codex accounts retain retryable subscription errors', async () => {
  for (const account of [null, { type: 'apiKey' }, { type: 'unknown' }, { type: 'chatgpt' }]) {
    const h = harness();
    const first = h.wire.rateLimits();
    reply(h, { account, requiresOpenaiAuth: false });
    await vi.waitFor(() => assert.equal(h.parsed().at(-1).method, 'account/rateLimits/read'));
    h.wire.receive(
      JSON.stringify({ id: h.parsed().at(-1).id, error: { code: -32600, message: 'Account reading refused' } }),
    );
    await assert.rejects(first, /Account reading refused/);
    const retry = h.wire.rateLimits();
    await vi.waitFor(() => assert.equal(h.parsed().length, 3));
    reply(h, { rateLimits: null });
    await retry;
    h.wire.close('finished');
  }
});

test('failed Codex discovery remains retryable and never establishes Bedrock', async () => {
  const h = harness();
  const first = h.wire.rateLimits();
  h.wire.receive(JSON.stringify({ id: h.parsed().at(-1).id, error: { code: -32600, message: 'Discovery refused' } }));
  await assert.rejects(first, /Discovery refused/);
  const retry = h.wire.rateLimits();
  assert.equal(h.parsed().length, 2);
  reply(h, { account: null });
  await vi.waitFor(() => assert.equal(h.parsed().at(-1).method, 'account/rateLimits/read'));
  reply(h, { rateLimits: null });
  await retry;
  h.wire.close('finished');
});

test('how much Codex asks rides the next prompt, because that is the only place it can', async () => {
  const h = harness();
  const started = h.wire.startThread({ cwd: 'C:ws', approvalPolicy: 'untrusted' });
  reply(h, { thread: { id: THREAD } });
  await started;
  const sink = () => {
    /* Discard rejection when the wire closes the pending turn. */
  };
  h.wire.prompt('before').catch(sink);
  const before = h.parsed().filter((m) => m.method === 'turn/start');
  assert.equal(
    before[0].params.approvalPolicy,
    undefined,
    'a thread nobody has changed had its start-up policy overridden on every prompt anyway',
  );
  await completeLastTurn(h, 'turn-before');
  await h.wire.setApproval('never', 'danger-full-access', 'user');
  h.wire.prompt('after').catch(sink);
  const after = h.parsed().filter((m) => m.method === 'turn/start');
  assert.equal(after[1].params.approvalPolicy, 'never');
  h.wire.close('the test is over');
});

test('the sandbox travels with the approval, because one choice sets both', async () => {
  // The selected permission mode carries both the approval policy and sandbox on the turn.

  const h = harness();
  const started = h.wire.startThread({ cwd: 'C:ws' });
  reply(h, { thread: { id: THREAD } });
  await started;
  const sink = () => {
    /* Discard rejection when the wire closes the pending turn. */
  };
  await h.wire.setApproval('never', 'danger-full-access', 'user');
  h.wire.prompt('go').catch(sink);
  const turn = h.parsed().filter((m) => m.method === 'turn/start')[0];
  assert.deepEqual(turn.params.sandboxPolicy, { type: 'dangerFullAccess' });
  assert.equal(turn.params.approvalPolicy, 'never');
  await completeLastTurn(h, 'turn-full-access');

  await h.wire.setApproval('untrusted', 'read-only', 'user');
  h.wire.prompt('again').catch(sink);
  const second = h.parsed().filter((m) => m.method === 'turn/start')[1];
  assert.deepEqual(
    { approvalPolicy: second.params.approvalPolicy, sandboxPolicy: second.params.sandboxPolicy },
    { approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly' } },
  );
  h.wire.close('the test is over');
});

test('a turn names its sandbox the way turn/start reads it, not the way a thread does', async () => {
  // Send turn sandbox overrides as sandboxPolicy. Check every sandbox mode against its protocol object type.

  const h = harness();
  const started = h.wire.startThread({ cwd: 'C:ws' });
  reply(h, { thread: { id: THREAD } });
  await started;
  const sink = () => {
    /* Discard rejection when the wire closes the pending turn. */
  };
  const shapes: [SandboxMode, string][] = [
    ['read-only', 'readOnly'],
    ['workspace-write', 'workspaceWrite'],
    ['danger-full-access', 'dangerFullAccess'],
  ];
  for (const [mode, type] of shapes) {
    await h.wire.setApproval('never', mode, 'user');
    h.wire.prompt('go').catch(sink);
    const turns = h.parsed().filter((m) => m.method === 'turn/start');
    const turn = turns[turns.length - 1];
    assert.deepEqual(
      turn.params.sandboxPolicy,
      { type },
      `turn/start reads an object tagged by type, and ${mode} has to arrive as one`,
    );
    assert.equal(
      turn.params.sandbox,
      undefined,
      'the thread/start spelling on a turn is taken and silently dropped, sandbox unchanged',
    );
    await completeLastTurn(h, `turn-${type}`);
  }
  h.wire.close('the test is over');
});

test('a thread opens with every permission setting the reader left it on', async () => {
  const h = harness();
  // Inspect thread/start before a response arrives. Closing the wire settles the pending start.

  h.wire
    .startThread({
      cwd: 'C:\\ws',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'danger-full-access',
    })
    .catch(() => {
      /* the wire is closed below, which is what settles this */
    });
  const request = h.parsed()[0];
  assert.equal(request.params.approvalPolicy, 'never');
  assert.equal(request.params.approvalsReviewer, 'user');
  assert.equal(request.params.sandbox, 'danger-full-access');
  assert.equal(
    request.params.sandboxPolicy,
    undefined,
    'thread/start reads the mode by name, and knows nothing of the object turn/start takes',
  );
  h.wire.close('the test is over');
});

test('Approve for me routes eligible approval requests to the automatic reviewer', async () => {
  const h = harness();
  const started = h.wire.startThread({
    cwd: 'C:\\ws',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
    sandbox: 'workspace-write',
  });
  assert.equal(h.parsed()[0].params.approvalsReviewer, 'auto_review');
  reply(h, { thread: { id: THREAD } });
  await started;

  await h.wire.setApproval('on-request', 'workspace-write', 'auto_review');
  h.wire.prompt('go').catch(() => {
    /* the wire is closed after inspecting the request */
  });
  const turn = h.parsed().find((message) => message.method === 'turn/start');
  assert.equal(turn.params.approvalsReviewer, 'auto_review');
  h.wire.close('the test is over');
});

test('the model and the effort level the reader picked ride every turn', async () => {
  // Effort has nowhere else to go: `thread/start` settles a model and has no effort field
  // at all, so a level sent there reaches nothing.
  const h = harness();
  const started = h.wire.startThread({ cwd: 'C:ws', model: 'gpt-5', effort: 'high' });
  const opened = h.parsed()[0];
  assert.equal(opened.params.model, 'gpt-5');
  assert.equal(opened.params.effort, undefined);
  reply(h, { thread: { id: THREAD } });
  await started;

  const sink = () => {
    /* Discard rejection when the wire closes the pending turn. */
  };
  h.wire.prompt('unpicked').catch(sink);
  const bare = h.parsed().filter((m) => m.method === 'turn/start')[0];
  assert.deepEqual(
    { model: bare.params.model, effort: bare.params.effort },
    { model: undefined, effort: undefined },
    'a turn nobody changed would override the thread with whatever this wire was holding',
  );
  await completeLastTurn(h, 'turn-unpicked');

  await h.wire.setModel('gpt-5-codex');
  await h.wire.setEffort('xhigh');
  h.wire.prompt('picked').catch(sink);
  const turn = h.parsed().filter((m) => m.method === 'turn/start')[1];
  assert.deepEqual({ model: turn.params.model, effort: turn.params.effort }, { model: 'gpt-5-codex', effort: 'xhigh' });
  await completeLastTurn(h, 'turn-picked');

  // An unmade pick is an empty string on the way in, and no field on the way out.
  await h.wire.setModel('');
  await h.wire.setEffort('');
  h.wire.prompt('cleared').catch(sink);
  const cleared = h.parsed().filter((m) => m.method === 'turn/start')[2];
  assert.deepEqual(
    { model: cleared.params.model, effort: cleared.params.effort },
    { model: undefined, effort: undefined },
  );
  h.wire.close('the test is over');
});

// A complete response from a server that reports the account aggregate beside its
// per-limit inventory. The inventory repeats the aggregate and names a model bucket.
const RATE_LIMITS_BY_ID = JSON.stringify({
  params: {
    rateLimits: {
      limitId: 'codex',
      limitName: null,
      primary: { usedPercent: 31, windowDurationMins: 10080, resetsAt: 1789180346 },
      secondary: null,
      credits: { hasCredits: false, unlimited: false, balance: '0' },
      planType: 'pro',
      rateLimitReachedType: null,
    },
    rateLimitsByLimitId: {
      codex: {
        limitId: 'codex',
        limitName: null,
        primary: { usedPercent: 31, windowDurationMins: 10080, resetsAt: 1789180346 },
        secondary: null,
      },
      codex_bengalfox: {
        limitId: 'codex_bengalfox',
        limitName: 'GPT-5.3-Codex-Spark',
        primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1788691261 },
        secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1788843792 },
      },
    },
  },
});

test('a complete read uses the account aggregate and not the per-limit inventory', () => {
  const reading = readRateLimits(JSON.parse(RATE_LIMITS_BY_ID).params, 1_700_000_000_000);
  assert.ok(reading);
  assert.equal(reading.plan, 'pro');
  assert.deepEqual(reading.limits, [
    { window: 'seven_day', utilization: 0.31, resetsAtSeconds: 1789180346, status: '', group: 'weekly', scope: '' },
  ]);
});

test('an unnamed account update remains unscoped', () => {
  const h = harness();
  h.wire.receive(
    JSON.stringify({
      method: 'account/rateLimits/updated',
      params: JSON.parse(RATE_LIMITS_BY_ID).params,
    }),
  );
  const limits = h.events.flatMap((e) => (e.kind === 'rateLimit' && e.limit !== null ? [e.limit] : []));
  assert.deepEqual(
    limits.map((l) => [l.window, l.group, l.scope]),
    [['seven_day', 'weekly', '']],
  );
});

test('a named live update keeps the model identity on every window', () => {
  const h = harness();
  h.wire.receive(
    JSON.stringify({
      method: 'account/rateLimits/updated',
      params: { rateLimits: JSON.parse(RATE_LIMITS_BY_ID).params.rateLimitsByLimitId.codex_bengalfox },
    }),
  );
  const limits = h.events.flatMap((e) => (e.kind === 'rateLimit' && e.limit !== null ? [e.limit] : []));
  assert.deepEqual(
    limits.map((l) => [l.window, l.group, l.scope]),
    [
      ['five_hour', 'session', 'GPT-5.3-Codex-Spark'],
      ['seven_day', 'weekly', 'GPT-5.3-Codex-Spark'],
    ],
  );
});

test('a non-account update without a readable name cannot replace an account window', () => {
  const h = harness();
  h.wire.receive(
    JSON.stringify({
      method: 'account/rateLimits/updated',
      params: {
        rateLimits: {
          ...JSON.parse(RATE_LIMITS_BY_ID).params.rateLimitsByLimitId.codex_bengalfox,
          limitName: null,
        },
      },
    }),
  );
  assert.deepEqual(
    h.events.filter((event) => event.kind === 'rateLimit'),
    [],
  );
});

// The model/list fixture includes model labels and supported reasoning-effort descriptions.

const MODEL_ANSWER = {
  data: [
    {
      id: 'gpt-5.5-codex',
      displayName: 'gpt-5.5-codex',
      description: 'Latest Codex model for agentic coding',
      hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: 'Fastest, for simple work' },
        { reasoningEffort: 'medium', description: 'Balanced speed and depth' },
        { reasoningEffort: 'high', description: 'Slowest, for hard problems' },
      ],
    },
    {
      id: 'gpt-5-codex-internal',
      displayName: 'Internal',
      description: 'Not offered',
      hidden: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
    },
  ],
};

test('the model list arrives in the words the server uses for its own models', () => {
  const list = readModels(MODEL_ANSWER, 1_700_000_000_000);
  assert.ok(list);
  assert.equal(list.readAt, 1_700_000_000_000);
  assert.equal(list.models[0].value, 'gpt-5.5-codex');
  assert.equal(list.models[0].label, 'gpt-5.5-codex');
  assert.equal(list.models[0].description, 'Latest Codex model for agentic coding');
});

test('hidden models remain available to saved-value validation', () => {
  const list = readModels(MODEL_ANSWER, 1);
  assert.equal(list?.models.length, 2);
  assert.equal(list?.models[1].hidden, true);
});

test('an effort level Codex offers keeps the sentence Codex wrote for it', () => {
  const list = readModels(MODEL_ANSWER, 1);
  assert.deepEqual(list?.models[0].efforts, [
    { value: 'low', label: 'low', description: 'Fastest, for simple work' },
    { value: 'medium', label: 'medium', description: 'Balanced speed and depth' },
    { value: 'high', label: 'high', description: 'Slowest, for hard problems' },
  ]);
});

test('a model with no id to send back is skipped, and nothing usable is no list at all', () => {
  const list = readModels({ data: [{ displayName: 'Nameless' }, { id: 'gpt-5.5-codex' }] }, 1);
  assert.deepEqual(
    list?.models.map((m) => m.value),
    ['gpt-5.5-codex'],
  );
  assert.deepEqual(list?.models[0].efforts, [], 'a model that lists no effort takes none');
  assert.equal(readModels({ data: [] }, 1), null);
  assert.equal(readModels(null, 1), null);
});

test('the model list is asked for by its own method and answered from there', async () => {
  const h = harness();
  const listing = h.wire.models();
  assert.equal(h.parsed()[0].method, 'model/list');
  reply(h, MODEL_ANSWER);
  assert.deepEqual(await listing, MODEL_ANSWER);
});

test('the model list follows the server cursor so every offered model reaches the picker', async () => {
  const h = harness();
  const listing = h.wire.models();
  assert.deepEqual(h.parsed()[0].params, { limit: 100, includeHidden: true });
  reply(h, { data: [MODEL_ANSWER.data[0]], nextCursor: 'page-2' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(h.parsed()[1], {
    id: 2,
    method: 'model/list',
    params: { limit: 100, includeHidden: true, cursor: 'page-2' },
  });
  reply(h, { data: [MODEL_ANSWER.data[1]], nextCursor: null });
  assert.deepEqual(await listing, MODEL_ANSWER);
});

test('a server that will not list its models leaves the panel with no list, not an error', async () => {
  // An unavailable model list returns null without reporting a turn failure.

  const h = harness();
  const listing = h.wire.models();
  h.wire.receive(JSON.stringify({ id: h.parsed()[0].id, error: { code: -32601, message: 'unknown method' } }));
  assert.equal(await listing, null);
});

test('a request nobody answers gives up rather than waiting for ever', async () => {
  // An unanswered request expires so later reads can proceed.

  const h = harness(10);
  await assert.rejects(waitForDeadline(h.wire.rateLimits()), /did not answer/);
  // The wire is still usable. The request that timed out is gone rather than left behind to
  // swallow the answer to the next one.
  const again = h.wire.models();
  reply(h, MODEL_ANSWER);
  assert.deepEqual(await again, MODEL_ANSWER);
});

test('a model list nobody answers is no list, and a late answer changes nothing', async () => {
  // An unanswered model read leaves the picker empty without reporting a turn failure.

  const h = harness(10);
  assert.equal(await waitForDeadline(h.wire.models()), null);
  // The late answer names a request the wire no longer holds. Reading it throws nothing and
  // settles nothing a second time.
  reply(h, MODEL_ANSWER);
});

// Reply chunks carry delta text with thread, turn, and item IDs.

const REPLY_CHUNKS = ['Running', ' the', ' requested command.'].map((delta) =>
  JSON.stringify({
    method: 'item/agentMessage/delta',
    params: { threadId: THREAD, turnId: TURN, itemId: 'msg_1', delta },
    emittedAtMs: 1787907156791,
  }),
);

test('the reply reaches the panel a chunk at a time, in the shape Claude sends', () => {
  // Translate each reply chunk into a shared delta event.

  const h = harness();
  for (const chunk of REPLY_CHUNKS) h.wire.receive(chunk);
  assert.deepEqual(
    h.events,
    [
      { kind: 'delta', text: 'Running', nativeTurnId: '01a04792-152f-72f1-b738-f4b20621e59a' },
      { kind: 'delta', text: ' the', nativeTurnId: '01a04792-152f-72f1-b738-f4b20621e59a' },
      { kind: 'delta', text: ' requested command.', nativeTurnId: '01a04792-152f-72f1-b738-f4b20621e59a' },
    ],
    'the chunks arrive in a shape of their own, so the card would need a branch per agent',
  );

  // A message with no delta text emits no reply chunk.

  const quiet = harness();
  quiet.wire.receive(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: THREAD } }));
  assert.deepEqual(quiet.events, []);
});

test('the finished message is still its own event, so the chunks are not a second copy', () => {
  // The item is completed separately and carries the whole message. The two are separate
  // kinds because a panel that joined the chunks and then took the completed item would hold
  // the reply twice over.
  const h = harness();
  for (const chunk of REPLY_CHUNKS) h.wire.receive(chunk);
  h.wire.receive(AGENT_MESSAGE);
  assert.deepEqual(
    h.events.map((e) => e.kind),
    ['delta', 'delta', 'delta', 'activity'],
  );
  assert.deepEqual(
    h.events.filter((e) => e.kind === 'activity').map((e) => (e.kind === 'activity' ? e.activity.detail : '')),
    ['Running the requested command.'],
  );
});

test('commentary deltas update one activity item and the completion settles it', () => {
  const h = harness();
  h.wire.receive(
    JSON.stringify({
      method: 'item/started',
      params: {
        item: { type: 'agentMessage', id: 'msg_live', text: '', phase: 'commentary' },
      },
    }),
  );
  for (const delta of ['Checking ', 'the tests.']) {
    h.wire.receive(JSON.stringify({ method: 'item/agentMessage/delta', params: { itemId: 'msg_live', delta } }));
  }
  h.wire.receive(
    JSON.stringify({
      method: 'item/completed',
      params: {
        item: { type: 'agentMessage', id: 'msg_live', text: 'Checking the tests.', phase: 'commentary' },
      },
    }),
  );
  const activity = h.events
    .filter((e) => e.kind === 'activity')
    .map((e) => (e.kind === 'activity' ? e.activity : null));
  assert.deepEqual(
    activity.map((item) => [item?.sourceId, item?.detail, item?.status]),
    [
      ['msg_live', 'Checking ', 'running'],
      ['msg_live', 'Checking the tests.', 'running'],
      ['msg_live', 'Checking the tests.', 'done'],
    ],
  );
});

test('final answer items stay on the reply path', () => {
  const h = harness();
  h.wire.receive(
    JSON.stringify({
      method: 'item/started',
      params: {
        item: { type: 'agentMessage', id: 'msg_final', text: '', phase: 'final_answer' },
      },
    }),
  );
  h.wire.receive(JSON.stringify({ method: 'item/agentMessage/delta', params: { itemId: 'msg_final', delta: 'Done' } }));
  h.wire.receive(
    JSON.stringify({
      method: 'item/completed',
      params: {
        item: { type: 'agentMessage', id: 'msg_final', text: 'Done', phase: 'final_answer' },
      },
    }),
  );
  assert.deepEqual(h.events, [
    { kind: 'delta', text: 'Done' },
    { kind: 'text', text: 'Done', sourceId: 'msg_final' },
  ]);
});

// Both async tools set `phase: 'final_answer'`, which is why phase alone cannot tell a
// question from a reply.
const ASYNC_QUESTION_ITEM = {
  type: 'agentMessage',
  id: 'call_qIau4RpqbkftTMESJ9OA8Se7',
  text: 'The rail migration is landed and rebuilt. ...\n- Works after reload\n- I found an issue\n- I will check later',
  phase: 'final_answer',
  delivery: 'async',
  questions: [
    {
      title: 'The rail migration is landed and rebuilt. ...',
      options: ['Works after reload', 'I found an issue', 'I will check later'],
    },
  ],
};

test('an async question is asked, not read back as the turn reply', () => {
  const h = harness();
  h.wire.receive(JSON.stringify({ method: 'item/started', params: { item: ASYNC_QUESTION_ITEM } }));
  h.wire.receive(JSON.stringify({ method: 'item/completed', params: { item: ASYNC_QUESTION_ITEM } }));
  assert.equal(
    h.events.find((e) => e.kind === 'text'),
    undefined,
    "the reader must never read a question as the turn's answer",
  );
  const asks = h.events.filter((e) => e.kind === 'ask') as { kind: 'ask'; ask: Ask }[];
  assert.equal(asks.length, 1);
  assert.equal(asks[0].ask.kind, 'question');
  if (asks[0].ask.kind !== 'question') return;
  assert.equal(asks[0].ask.questions.length, 1);
  assert.deepEqual(
    asks[0].ask.questions[0].options.map((o) => o.label),
    ['Works after reload', 'I found an issue', 'I will check later'],
  );
  assert.equal(
    asks[0].ask.questions[0].id,
    JSON.stringify(['request_user_input_async', 'call_qIau4RpqbkftTMESJ9OA8Se7', 0]),
    'the reply envelope keys an answer by this exact id',
  );
  const activities = h.events
    .filter((e) => e.kind === 'activity')
    .map((e) => (e.kind === 'activity' ? e.activity : null));
  assert.deepEqual(activities, [
    {
      sourceId: 'call_qIau4RpqbkftTMESJ9OA8Se7',
      kind: 'commentary',
      name: 'Update',
      headline: 'Asked',
      detail:
        'The rail migration is landed and rebuilt. ...\n- Works after reload\n- I found an issue\n- I will check later',
      status: 'done',
    },
  ]);
});

test('a streamed async item finishes its Activity row as done once the question arrives', () => {
  const h = harness();
  const started = { ...ASYNC_QUESTION_ITEM, text: '' };
  h.wire.receive(JSON.stringify({ method: 'item/started', params: { item: started } }));
  h.wire.receive(
    JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { itemId: ASYNC_QUESTION_ITEM.id, delta: 'partial reply' },
    }),
  );
  h.wire.receive(JSON.stringify({ method: 'item/completed', params: { item: ASYNC_QUESTION_ITEM } }));
  assert.equal(
    h.events.find((e) => e.kind === 'delta'),
    undefined,
    'a streamed async delta must never reach the reply stream',
  );
  assert.equal(
    h.events.find((e) => e.kind === 'text'),
    undefined,
    'a streamed async delta must never reach the reply stream',
  );
  const activities = h.events
    .filter((e) => e.kind === 'activity')
    .map((e) => (e.kind === 'activity' ? e.activity : null));
  assert.equal(activities[0]?.status, 'running', 'the streamed delta opens the row as running');
  assert.equal(
    activities[activities.length - 1]?.status,
    'done',
    'the completed question finishes the same row rather than leaving it running',
  );
  assert.ok(
    activities.every((a) => a?.sourceId === ASYNC_QUESTION_ITEM.id),
    'the streamed row and its completion share the item id as sourceId',
  );
});

test('a second question in the same item is keyed by its own index', () => {
  const h = harness();
  const item = {
    type: 'agentMessage',
    id: 'call_two',
    text: '',
    phase: 'final_answer',
    delivery: 'async',
    questions: [
      { title: 'First question', options: ['a', 'b'] },
      { title: 'Second question', options: ['c', 'd'] },
    ],
  };
  h.wire.receive(JSON.stringify({ method: 'item/started', params: { item } }));
  h.wire.receive(JSON.stringify({ method: 'item/completed', params: { item } }));
  const asks = h.events.filter((e) => e.kind === 'ask') as { kind: 'ask'; ask: Ask }[];
  assert.equal(asks.length, 1);
  assert.equal(asks[0].ask.kind, 'question');
  if (asks[0].ask.kind !== 'question') throw new Error('unreachable');
  assert.equal(asks[0].ask.questions.length, 2);
  assert.equal(asks[0].ask.questions[1].id, JSON.stringify(['request_user_input_async', 'call_two', 1]));
});

test('an empty questions array builds no ask, and the item becomes one Activity row', () => {
  const h = harness();
  const item = {
    type: 'agentMessage',
    id: 'call_empty',
    text: 'Nothing to pick here.',
    phase: 'final_answer',
    delivery: 'async',
    questions: [],
  };
  h.wire.receive(JSON.stringify({ method: 'item/started', params: { item } }));
  h.wire.receive(JSON.stringify({ method: 'item/completed', params: { item } }));
  assert.equal(
    h.events.some((e) => e.kind === 'ask'),
    false,
  );
  const activities = h.events
    .filter((e) => e.kind === 'activity')
    .map((e) => (e.kind === 'activity' ? e.activity : null));
  assert.deepEqual(activities, [
    {
      sourceId: 'call_empty',
      kind: 'commentary',
      name: 'Update',
      headline: 'Said',
      detail: 'Nothing to pick here.',
      status: 'done',
    },
  ]);
});

test('a question with null options builds with no options rather than throwing', () => {
  const h = harness();
  const item = {
    type: 'agentMessage',
    id: 'call_noopts',
    text: '',
    phase: 'final_answer',
    delivery: 'async',
    questions: [{ title: 'Pick one', options: null }],
  };
  assert.doesNotThrow(() => {
    h.wire.receive(JSON.stringify({ method: 'item/started', params: { item } }));
    h.wire.receive(JSON.stringify({ method: 'item/completed', params: { item } }));
  });
  const asks = h.events.filter((e) => e.kind === 'ask') as { kind: 'ask'; ask: Ask }[];
  assert.equal(asks.length, 1);
  assert.equal(asks[0].ask.kind, 'question');
  if (asks[0].ask.kind !== 'question') throw new Error('unreachable');
  assert.deepEqual(asks[0].ask.questions[0].options, []);
});

// A running turn on THREAD that has asked the captured async question.
async function askAsyncQuestionInTurn(): Promise<ReturnType<typeof harness>> {
  const h = harness();
  const starting = h.wire.startThread({ cwd: 'C:\\ws' });
  reply(h, { thread: { id: THREAD } });
  await starting;
  const prompting = h.wire.prompt('check the rail');
  reply(h, { turn: { id: TURN, status: 'inProgress' } });
  await prompting;
  for (const method of ['item/started', 'item/completed']) {
    h.wire.receive(JSON.stringify({ method, params: { item: ASYNC_QUESTION_ITEM, threadId: THREAD, turnId: TURN } }));
  }
  return h;
}

const ASYNC_QUESTION_ID = JSON.stringify(['request_user_input_async', ASYNC_QUESTION_ITEM.id, 0]);

const PICKED_ANSWER = {
  decision: 'answer' as const,
  answers: { [ASYNC_QUESTION_ID]: { labels: ['Works after reload'], written: '' } },
};

// The envelope Codex clients read, spelled out here rather than built by the module under
// test, so a change to the module's output cannot pass by changing both sides.
const PICKED_ENVELOPE =
  '<send_user_message_question_reply>' +
  JSON.stringify([
    {
      questionItemId: ASYNC_QUESTION_ID,
      question: ASYNC_QUESTION_ITEM.questions[0].title,
      answer: 'Works after reload',
    },
  ]) +
  '</send_user_message_question_reply>';

function resolved(h: ReturnType<typeof harness>): boolean {
  return h.events.some((e) => e.kind === 'askResolved' && e.outcome !== 'failed' && e.id === ASYNC_QUESTION_ITEM.id);
}

test.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])(
  'async answers wait for pending skill admission and retain refused questions: uncertain=%s ended=%s',
  async (uncertain, ended) => {
    const h = sessionSkillServer();
    try {
      await h.wire.initialize();
      await h.wire.commands();
      await h.wire.startThread({ cwd: process.cwd() });
      await h.wire.prompt('ask a question');
      for (const method of ['item/started', 'item/completed'])
        h.wire.receive(
          JSON.stringify({ method, params: { item: ASYNC_QUESTION_ITEM, threadId: THREAD, turnId: TURN } }),
        );
      if (ended) h.wire.receive(TURN_COMPLETED);
      h.state.holdList = !uncertain;
      h.state.disabled = uncertain;
      h.state.withdrawFailure = uncertain;
      h.wire.receive(JSON.stringify({ method: 'skills/changed', params: {} }));
      if (uncertain) await assert.rejects(h.wire.prompt('must stay unsent'), /withdrawal/);
      const inputs = () => h.sent.filter((message) => ['turn/start', 'turn/steer'].includes(message.method));
      const before = inputs().length;
      assert.equal(h.wire.answer(ASYNC_QUESTION_ITEM.id, PICKED_ANSWER), true);
      if (!uncertain) {
        await vi.waitFor(() => assert.equal(h.held.length, 1));
        assert.equal(inputs().length, before, 'a pending refresh must send no answer input');
        h.state.holdList = false;
        h.held.shift()!();
      }
      if (uncertain) {
        await vi.waitFor(() =>
          assert.ok(h.events.some((event) => event.kind === 'askResolved' && event.outcome === 'failed')),
        );
        assert.equal(h.wire.outlivesTurn(ASYNC_QUESTION_ITEM.id), true);
        assert.equal(inputs().length, before, 'failed withdrawal must send no answer input');
        assert.equal(h.wire.answer(ASYNC_QUESTION_ITEM.id, PICKED_ANSWER), true);
        await vi.waitFor(() =>
          assert.equal(
            h.events.filter((event) => event.kind === 'askResolved' && event.outcome === 'failed').length,
            2,
          ),
        );
        assert.equal(inputs().length, before);
      } else {
        await vi.waitFor(() =>
          assert.ok(h.events.some((event) => event.kind === 'askResolved' && event.outcome === 'answered')),
        );
        assert.equal(inputs().length, before + 1);
        assert.equal(inputs().at(-1).method, ended ? 'turn/start' : 'turn/steer');
      }
    } finally {
      h.wire.close('finished');
    }
  },
);

test.each([
  ['admission', false],
  ['admission', true],
  ['steer', false],
  ['fallback', false],
] as const)('Stop cancels an async answer during %s with ended turn=%s', async (phase, ended) => {
  const h = sessionSkillServer();
  try {
    await h.wire.initialize();
    await h.wire.commands();
    await h.wire.startThread({ cwd: process.cwd() });
    await h.wire.prompt('ask a question');
    for (const method of ['item/started', 'item/completed'])
      h.wire.receive(JSON.stringify({ method, params: { item: ASYNC_QUESTION_ITEM, threadId: THREAD, turnId: TURN } }));
    if (ended) h.wire.receive(TURN_COMPLETED);
    h.state.refuseSteer = true;
    h.state.holdList = phase === 'admission';
    h.state.holdSteer = phase !== 'admission';
    if (phase === 'admission') h.wire.receive(JSON.stringify({ method: 'skills/changed', params: {} }));
    assert.equal(h.wire.answer(ASYNC_QUESTION_ITEM.id, PICKED_ANSWER), true);
    await vi.waitFor(() => assert.equal(h.held.length, 1));
    if (phase === 'fallback') {
      h.state.beforeReply = (message) => {
        if (message.method !== 'turn/steer') return;
        h.state.holdList = true;
        h.wire.receive(JSON.stringify({ method: 'skills/changed', params: {} }));
      };
      h.state.holdSteer = false;
      h.held.shift()!();
      await vi.waitFor(() => assert.equal(h.held.length, 1));
    }
    await h.wire.interrupt();
    h.wire.receive(TURN_COMPLETED);
    const inputs = () => h.sent.filter((message) => ['turn/start', 'turn/steer'].includes(message.method));
    const before = inputs().length;
    h.state.holdList = false;
    h.state.holdSteer = false;
    h.held.shift()!();
    await vi.waitFor(() => assert.ok(h.events.some((event) => event.kind === 'askResolved')));
    assert.equal(inputs().length, before, 'Stop must prevent native answer input after the held response');
    assert.ok(
      h.events.some((event) => event.kind === 'askResolved' && event.outcome === 'failed'),
      'the host must release answer delivery',
    );
    assert.equal(
      h.wire.outlivesTurn(ASYNC_QUESTION_ITEM.id),
      true,
      'an unsent answer must leave its question available',
    );
    assert.equal(h.events.filter((event) => event.kind === 'ask').length, 2);
    assert.equal(h.wire.hasOpenTurns(), false, 'a cancelled answer must release pending delivery');
  } finally {
    h.wire.close('finished');
  }
});

test.each(['admission timeout', 'accepted', 'native timeout', 'missing turn', 'transport failure'] as const)(
  'async answer fallback settles from native delivery evidence after %s',
  async (outcome) => {
    const h = sessionSkillServer();
    try {
      await h.wire.initialize();
      await h.wire.commands();
      await h.wire.startThread({ cwd: process.cwd() });
      await h.wire.prompt('ask a question');
      h.wire.receive(
        JSON.stringify({
          method: 'item/completed',
          params: { item: ASYNC_QUESTION_ITEM, threadId: THREAD, turnId: TURN },
        }),
      );
      h.state.refuseSteer = true;
      h.state.holdSteer = true;
      assert.equal(h.wire.answer(ASYNC_QUESTION_ITEM.id, PICKED_ANSWER), true);
      await vi.waitFor(() => assert.equal(h.held.length, 1));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      h.state.holdList = true;
      h.wire.receive(JSON.stringify({ method: 'skills/changed', params: {} }));
      h.state.holdSteer = false;
      h.held.shift()!();
      await vi.waitFor(() => assert.equal(h.held.length, 1));
      const inputs = () => h.sent.filter((message) => ['turn/start', 'turn/steer'].includes(message.method));
      assert.equal(inputs().length, 2, 'only the original prompt and refused steer have attempted input');
      if (outcome === 'admission timeout') {
        await vi.advanceTimersByTimeAsync(15_000);
      } else {
        h.state.holdStart = outcome === 'native timeout';
        h.state.failStart = outcome === 'transport failure';
        h.state.beforeReply = (message) => {
          if (outcome === 'missing turn' && message.method === 'turn/start')
            h.wire.receive(JSON.stringify({ id: message.id, result: {} }));
        };
        h.state.holdList = false;
        h.held.shift()!();
        if (outcome === 'native timeout') {
          await vi.waitFor(() => assert.equal(h.held.length, 1));
          await vi.advanceTimersByTimeAsync(60_000);
        }
      }
      await vi.waitFor(() => assert.ok(h.events.some((event) => event.kind === 'askResolved')));
      const expected = outcome === 'admission timeout' ? 'failed' : outcome === 'accepted' ? 'answered' : 'unknown';
      assert.deepEqual(
        h.events.filter((event) => event.kind === 'askResolved'),
        [{ kind: 'askResolved', id: ASYNC_QUESTION_ITEM.id, outcome: expected }],
      );
      assert.equal(inputs().length, outcome === 'admission timeout' ? 2 : 3, 'fallback input must not be retried');
      assert.equal(h.wire.outlivesTurn(ASYNC_QUESTION_ITEM.id), outcome === 'admission timeout');
      assert.equal(h.events.filter((event) => event.kind === 'ask').length, outcome === 'admission timeout' ? 2 : 1);
      assert.equal(h.wire.hasOpenTurns(), true, 'the original running turn retains its busy ownership');
      h.wire.receive(TURN_COMPLETED);
      assert.equal(h.wire.hasOpenTurns(), false, 'settled answer delivery must not retain busy state');
      if (outcome === 'admission timeout' || outcome === 'native timeout') {
        h.held.shift()!();
        await vi.waitFor(() => assert.equal(vi.getTimerCount(), 0));
        assert.equal(
          inputs().length,
          outcome === 'admission timeout' ? 2 : 3,
          'late discovery must not resend an answer',
        );
        assert.equal(h.events.filter((event) => event.kind === 'askResolved').length, 1);
      }
    } finally {
      h.wire.close('finished');
      vi.useRealTimers();
    }
  },
);

test.each(['opening', 'refresh'] as const)(
  'trailing skill notifications share the %s admission deadline',
  async (operation) => {
    const h = sessionSkillServer();
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      await h.wire.initialize();
      if (operation === 'refresh') {
        await h.wire.commands();
        await h.wire.startThread({ cwd: process.cwd() });
      }
      let requirements = 0;
      h.state.beforeReply = (message) => {
        now += 2_000;
        if (message.method === 'configRequirements/read' && ++requirements === 2)
          h.wire.receive(JSON.stringify({ method: 'skills/changed', params: {} }));
      };
      if (operation === 'opening') {
        await assert.rejects(h.wire.commands(), /loading its skills in time/);
        await assert.rejects(h.wire.startThread({ cwd: process.cwd() }), /loading its skills in time/);
        assert.equal(
          h.events.some((event) => event.kind === 'ready'),
          false,
        );
      } else {
        h.wire.receive(JSON.stringify({ method: 'skills/changed', params: {} }));
        await assert.rejects(h.wire.prompt('must stay unsent'), /loading its skills in time/);
      }
      assert.equal(
        h.sent.filter((message) => message.method === 'thread/start').length,
        operation === 'opening' ? 0 : 1,
      );
      assert.equal(
        h.sent.some((message) => ['turn/start', 'turn/steer'].includes(message.method)),
        false,
      );
      assert.ok(now >= 15_000);
    } finally {
      h.wire.close('finished');
      clock.mockRestore();
    }
  },
);

test('dismissing an async question sends Codex nothing and resolves the ask', async () => {
  const h = await askAsyncQuestionInTurn();
  const sentBefore = h.sent.length;
  assert.equal(h.wire.answer(ASYNC_QUESTION_ITEM.id, { decision: 'deny', reason: 'dismissed' }), true);
  assert.equal(h.sent.length, sentBefore, 'no request waits on a dismissal, so nothing goes to Codex');
  assert.equal(resolved(h), true);
  assert.equal(h.wire.outlivesTurn(ASYNC_QUESTION_ITEM.id), false, 'a dismissed question must not stay open');
});

test('an answer to a live async question goes into its running turn inside a reply envelope', async () => {
  const h = await askAsyncQuestionInTurn();
  assert.equal(h.wire.answer(ASYNC_QUESTION_ITEM.id, PICKED_ANSWER), true);
  const steers = h.parsed().filter((m) => m.method === 'turn/steer');
  assert.equal(steers.length, 1);
  assert.deepEqual(steers[0].params, {
    threadId: THREAD,
    input: [{ type: 'text', text: PICKED_ENVELOPE }],
    expectedTurnId: TURN,
  });
  assert.equal(h.parsed().filter((m) => m.method === 'turn/start').length, 1, 'the answer must not start a turn');
  reply(h, {});
  await vi.waitFor(() => assert.equal(resolved(h), true));
  assert.equal(h.wire.outlivesTurn(ASYNC_QUESTION_ITEM.id), false);
});

test('an answer to an async question whose turn has ended goes out as a new prompt', async () => {
  const h = await askAsyncQuestionInTurn();
  h.wire.receive(TURN_COMPLETED);
  assert.equal(h.wire.outlivesTurn(ASYNC_QUESTION_ITEM.id), true, 'the question stays open after its turn');
  h.wire.answer(ASYNC_QUESTION_ITEM.id, PICKED_ANSWER);
  assert.equal(
    h.parsed().some((m) => m.method === 'turn/steer'),
    false,
    'no turn is running to steer',
  );
  const start = h.parsed().at(-1);
  assert.equal(start.method, 'turn/start');
  assert.deepEqual(start.params.input, [{ type: 'text', text: PICKED_ENVELOPE }]);
  reply(h, { turn: { id: 'turn-2', status: 'inProgress' } });
  await vi.waitFor(() => assert.equal(resolved(h), true));
  assert.equal(h.wire.hasOpenTurns(), true);
});

test('a refused steer sends the async answer as a new prompt', async () => {
  const h = await askAsyncQuestionInTurn();
  h.wire.answer(ASYNC_QUESTION_ITEM.id, PICKED_ANSWER);
  const steer = h.parsed().at(-1);
  assert.equal(steer.method, 'turn/steer');
  h.wire.receive(JSON.stringify({ id: steer.id, error: { code: -32600, message: 'expected turn is not active' } }));
  await vi.waitFor(() => assert.equal(h.parsed().at(-1)?.method, 'turn/start'));
  assert.deepEqual(h.parsed().at(-1).params.input, [{ type: 'text', text: PICKED_ENVELOPE }]);
  assert.equal(resolved(h), false, 'the ask resolves once the prompt is accepted');
  reply(h, { turn: { id: 'turn-2', status: 'inProgress' } });
  await vi.waitFor(() => assert.equal(resolved(h), true));
  assert.equal(
    h.events.some((e) => e.kind === 'error'),
    false,
  );
});

test('a reply envelope from another client resolves the async question it answers', async () => {
  const h = await askAsyncQuestionInTurn();
  const userMessage = (text: string) =>
    JSON.stringify({
      method: 'item/completed',
      params: {
        item: { type: 'userMessage', id: `user-${text.length}`, content: [{ type: 'text', text }] },
        threadId: THREAD,
        turnId: TURN,
      },
    });
  h.wire.receive(userMessage(`Also: ${PICKED_ENVELOPE}`));
  assert.equal(resolved(h), false, 'text outside the envelope makes the message an ordinary prompt');
  const sentBefore = h.sent.length;
  h.wire.receive(userMessage(PICKED_ENVELOPE));
  assert.equal(resolved(h), true);
  assert.equal(h.wire.outlivesTurn(ASYNC_QUESTION_ITEM.id), false);
  assert.equal(h.sent.length, sentBefore, 'another client already answered, so nothing goes to Codex');
});

function refuseLast(h: ReturnType<typeof harness>, message: string): void {
  const last = h
    .parsed()
    .filter((m) => typeof m.id === 'number' && m.method)
    .at(-1);
  h.wire.receive(JSON.stringify({ id: last.id, error: { code: -32600, message } }));
}

function envelope(entries: { questionItemId: string; question: string; answer: string }[]): string {
  return '<send_user_message_question_reply>' + JSON.stringify(entries) + '</send_user_message_question_reply>';
}

function userMessage(text: string, id = `user-${text.length}`): string {
  return JSON.stringify({
    method: 'item/completed',
    params: {
      item: { type: 'userMessage', id, content: [{ type: 'text', text }] },
      threadId: THREAD,
      turnId: TURN,
    },
  });
}

test('a written answer, alone or after picked labels, reaches the running turn inside the envelope', async () => {
  const question = ASYNC_QUESTION_ITEM.questions[0].title;
  const h = await askAsyncQuestionInTurn();
  h.wire.answer(ASYNC_QUESTION_ITEM.id, {
    decision: 'answer',
    answers: {
      [ASYNC_QUESTION_ID]: {
        labels: ['Works after reload'],
        written: 'but the rail flickers',
      },
    },
  });
  assert.deepEqual(h.parsed().at(-1).params.input, [
    {
      type: 'text',
      text: envelope([
        {
          questionItemId: ASYNC_QUESTION_ID,
          question,
          answer: 'Works after reload, but the rail flickers',
        },
      ]),
    },
  ]);

  const written = await askAsyncQuestionInTurn();
  written.wire.answer(ASYNC_QUESTION_ITEM.id, {
    decision: 'answer',
    answers: { [ASYNC_QUESTION_ID]: { labels: [], written: 'not yet' } },
  });
  const steer = written.parsed().at(-1);
  assert.equal(steer.method, 'turn/steer');
  assert.deepEqual(steer.params.input, [
    {
      type: 'text',
      text: envelope([{ questionItemId: ASYNC_QUESTION_ID, question, answer: 'not yet' }]),
    },
  ]);
});

test('a reply envelope that answers some questions of an async ask keeps the rest open', async () => {
  const h = await askAsyncQuestionInTurn();
  const item = {
    ...ASYNC_QUESTION_ITEM,
    id: 'call-two',
    questions: [
      { title: 'Does the rail work?', options: ['Yes', 'No'] },
      { title: 'Should it ship?', options: ['Yes', 'No'] },
    ],
  };
  h.wire.receive(
    JSON.stringify({
      method: 'item/completed',
      params: { item, threadId: THREAD, turnId: TURN },
    }),
  );
  const first = JSON.stringify(['request_user_input_async', 'call-two', 0]);
  const second = JSON.stringify(['request_user_input_async', 'call-two', 1]);
  const closed = () => h.events.some((e) => e.kind === 'askResolved' && e.id === 'call-two');
  h.wire.receive(
    userMessage(
      envelope([
        {
          questionItemId: first,
          question: 'Does the rail work?',
          answer: 'Yes',
        },
      ]),
    ),
  );
  assert.equal(closed(), false, 'the second question is still unanswered');
  assert.equal(h.wire.outlivesTurn('call-two'), true);
  const narrowed = h.events.at(-1) as { kind: 'ask'; ask: Ask };
  assert.equal(narrowed.kind, 'ask');
  assert.deepEqual(narrowed.ask.kind === 'question' && narrowed.ask.questions.map((q) => q.id), [second]);
  h.wire.receive(
    userMessage(envelope([{ questionItemId: second, question: 'Should it ship?', answer: 'No' }]), 'user-second'),
  );
  assert.equal(closed(), true);
  assert.equal(h.wire.outlivesTurn('call-two'), false);
});

test('an answer after a failed turn goes out as a new prompt, not a steer', async () => {
  const h = await askAsyncQuestionInTurn();
  h.wire.receive(
    JSON.stringify({
      method: 'turn/failed',
      params: { threadId: THREAD, turnId: TURN, error: { message: 'boom' } },
    }),
  );
  h.wire.answer(ASYNC_QUESTION_ITEM.id, PICKED_ANSWER);
  assert.equal(
    h.parsed().some((m) => m.method === 'turn/steer'),
    false,
  );
  assert.equal(h.parsed().at(-1).method, 'turn/start');
});

test('a new thread closes the async questions of the old one, so no answer reaches the wrong thread', async () => {
  const h = await askAsyncQuestionInTurn();
  h.wire.receive(TURN_COMPLETED);
  const clearing = h.wire.startThread({ cwd: 'C:\\ws' });
  reply(h, { thread: { id: 'thread-new' } });
  await clearing;
  assert.equal(resolved(h), true, 'the question closes with its thread');
  const sentBefore = h.sent.length;
  assert.equal(h.wire.answer(ASYNC_QUESTION_ITEM.id, PICKED_ANSWER), false);
  assert.equal(h.sent.length, sentBefore, 'nothing goes to the new thread');
});

test('a refused steer does not prompt a thread the session moved to while the steer was out', async () => {
  const h = await askAsyncQuestionInTurn();
  h.wire.answer(ASYNC_QUESTION_ITEM.id, PICKED_ANSWER);
  const steer = h.parsed().at(-1);
  const clearing = h.wire.startThread({ cwd: 'C:\\ws' });
  reply(h, { thread: { id: 'thread-new' } });
  await clearing;
  h.wire.receive(
    JSON.stringify({
      id: steer.id,
      error: { code: -32600, message: 'expected turn is not active' },
    }),
  );
  await vi.waitFor(() => assert.equal(resolved(h), true));
  assert.equal(h.parsed().filter((m) => m.method === 'turn/start').length, 1, 'only the first prompt started a turn');
});

test('a refused steer whose prompt is refused too offers the question again and says why', async () => {
  const h = await askAsyncQuestionInTurn();
  h.wire.answer(ASYNC_QUESTION_ITEM.id, PICKED_ANSWER);
  refuseLast(h, 'expected turn is not active');
  await vi.waitFor(() => assert.equal(h.parsed().at(-1)?.method, 'turn/start'));
  const asksBefore = h.events.filter((e) => e.kind === 'ask').length;
  refuseLast(h, 'thread is busy');
  await vi.waitFor(() => assert.equal(h.events.filter((e) => e.kind === 'ask').length, asksBefore + 1));
  assert.equal(resolved(h), false);
  assert.match((h.events.find((e) => e.kind === 'error') as { message: string }).message, /thread is busy/);
  assert.equal(h.wire.outlivesTurn(ASYNC_QUESTION_ITEM.id), true, 'the reader can answer again');
  h.wire.answer(ASYNC_QUESTION_ITEM.id, PICKED_ANSWER);
  assert.equal(h.parsed().at(-1).method, 'turn/start');
});

test('a steer cut off by the wire closing is not resent and leaves the crash reason alone', async () => {
  const h = await askAsyncQuestionInTurn();
  h.wire.answer(ASYNC_QUESTION_ITEM.id, PICKED_ANSWER);
  const sentBefore = h.sent.length;
  h.wire.close('the agent stopped with code 3');
  // Every settled promise runs its handlers before the next macrotask.
  await new Promise((done) => setImmediate(done));
  assert.equal(h.sent.length, sentBefore);
  assert.equal(
    h.events.some((e) => e.kind === 'error'),
    false,
  );

  // The same holds when the wire closes while the fallback prompt waits to be accepted.
  const late = await askAsyncQuestionInTurn();
  late.wire.answer(ASYNC_QUESTION_ITEM.id, PICKED_ANSWER);
  refuseLast(late, 'expected turn is not active');
  await vi.waitFor(() => assert.equal(late.parsed().at(-1)?.method, 'turn/start'));
  const eventsBefore = late.events.length;
  late.wire.close('the agent stopped with code 3');
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(
    late.events.slice(eventsBefore).filter((e) => e.kind === 'error' || e.kind === 'ask'),
    [],
    'a closed wire neither reports the answer nor offers the question again',
  );
});

test('a steer with no response before the deadline is not sent again', async () => {
  const h = harness(10);
  const starting = h.wire.startThread({ cwd: 'C:\\ws' });
  reply(h, { thread: { id: THREAD } });
  await starting;
  const prompting = h.wire.prompt('check the rail');
  reply(h, { turn: { id: TURN, status: 'inProgress' } });
  await prompting;
  h.wire.receive(
    JSON.stringify({
      method: 'item/completed',
      params: { item: ASYNC_QUESTION_ITEM, threadId: THREAD, turnId: TURN },
    }),
  );
  h.wire.answer(ASYNC_QUESTION_ITEM.id, PICKED_ANSWER);
  await waitForDeadline(vi.waitFor(() => assert.equal(resolved(h), true)));
  assert.equal(h.parsed().filter((m) => m.method === 'turn/steer').length, 1);
  assert.equal(h.parsed().filter((m) => m.method === 'turn/start').length, 1, 'only the first prompt');
  assert.equal(
    h.events.some((e) => e.kind === 'error'),
    true,
  );
});

test('an async message with no questions becomes one Activity row, not a reply', () => {
  const h = harness();
  const item = {
    type: 'agentMessage',
    id: 'call_notice',
    text: 'Heads up, the build is slow today.',
    phase: 'final_answer',
    delivery: 'async',
    questions: null,
  };
  h.wire.receive(JSON.stringify({ method: 'item/started', params: { item } }));
  h.wire.receive(JSON.stringify({ method: 'item/completed', params: { item } }));
  assert.equal(
    h.events.find((e) => e.kind === 'text'),
    undefined,
  );
  assert.deepEqual(
    h.events.filter((e) => e.kind === 'activity').map((e) => (e.kind === 'activity' ? e.activity : null)),
    [
      {
        sourceId: 'call_notice',
        kind: 'commentary',
        name: 'Update',
        headline: 'Said',
        detail: 'Heads up, the build is slow today.',
        status: 'done',
      },
    ],
  );
});

test('an async item whose questions all lack a title becomes one Activity row, not an ask', () => {
  const h = harness();
  const item = {
    type: 'agentMessage',
    id: 'call_untitled',
    text: 'Nothing worth asking.',
    phase: 'final_answer',
    delivery: 'async',
    questions: [{ title: '', options: ['a', 'b'] }, { options: ['c'] }],
  };
  h.wire.receive(JSON.stringify({ method: 'item/started', params: { item } }));
  h.wire.receive(JSON.stringify({ method: 'item/completed', params: { item } }));
  assert.equal(
    h.events.some((e) => e.kind === 'ask'),
    false,
  );
  assert.equal(
    h.events.find((e) => e.kind === 'text'),
    undefined,
  );
  assert.deepEqual(
    h.events.filter((e) => e.kind === 'activity').map((e) => (e.kind === 'activity' ? e.activity : null)),
    [
      {
        sourceId: 'call_untitled',
        kind: 'commentary',
        name: 'Update',
        headline: 'Said',
        detail: 'Nothing worth asking.',
        status: 'done',
      },
    ],
  );
});

test('a turn whose last final answer is an async question reports an empty outcome', () => {
  const outcome = turnOutcome({ status: 'completed', items: [ASYNC_QUESTION_ITEM] });
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.text, '');
});

test('a real final answer followed by an async question keeps the real answer as the outcome', () => {
  const realAnswer = {
    type: 'agentMessage',
    id: 'msg_real',
    text: 'Here is the real answer.',
    phase: 'final_answer',
  };
  const outcome = turnOutcome({ status: 'completed', items: [realAnswer, ASYNC_QUESTION_ITEM] });
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.text, 'Here is the real answer.');
});

test('reasoning exposes a clear summary and never raw reasoning', () => {
  const h = harness();
  h.wire.receive(
    JSON.stringify({
      method: 'item/started',
      params: {
        item: { type: 'reasoning', id: 'reason_1' },
      },
    }),
  );
  h.wire.receive(
    JSON.stringify({
      method: 'item/completed',
      params: {
        item: {
          type: 'reasoning',
          id: 'reason_1',
          summary: [{ text: 'Compared both paths.' }],
          rawContent: ['hidden'],
        },
      },
    }),
  );
  h.wire.receive(
    JSON.stringify({
      method: 'item/completed',
      params: {
        item: { type: 'reasoning', id: 'reason_2', encryptedContent: 'ciphertext' },
      },
    }),
  );
  const activity = h.events
    .filter((e) => e.kind === 'activity')
    .map((e) => (e.kind === 'activity' ? e.activity : null));
  assert.deepEqual(
    activity.map((item) => [item?.sourceId, item?.headline, item?.detail, item?.status]),
    [
      ['reason_1', 'Thinking', '', 'running'],
      ['reason_1', 'Reasoned', 'Compared both paths.', 'done'],
      ['reason_2', 'Thinking', '', 'done'],
    ],
  );
  assert.equal(JSON.stringify(activity).includes('hidden'), false);
  assert.equal(JSON.stringify(activity).includes('ciphertext'), false);
});

test('command, file, plan and collaboration completions update their start ids', () => {
  const h = harness();
  const items = [
    { type: 'commandExecution', id: 'exec_2', command: 'npm test' },
    { type: 'fileChange', id: 'edit_1', path: 'src/a.ts' },
    { type: 'plan', id: 'plan_1', text: 'Run focused tests' },
    { type: 'collabAgentToolCall', id: 'collab_wait', tool: 'wait', receiverThreadIds: ['thread_2'] },
    { type: 'collabAgentToolCall', id: 'collab_spawn', tool: 'spawn_agent', receiverThreadIds: ['thread_3'] },
    { type: 'collabAgentToolCall', id: 'collab_message', tool: 'send_message', receiverThreadIds: ['thread_4'] },
    { type: 'collabAgentToolCall', id: 'collab_other', tool: 'handoff', receiverThreadIds: ['thread_5'] },
  ];
  for (const item of items) h.wire.receive(JSON.stringify({ method: 'item/started', params: { item } }));
  for (const item of items)
    h.wire.receive(JSON.stringify({ method: 'item/completed', params: { item: { ...item, status: 'completed' } } }));
  const activity = h.events
    .filter((e) => e.kind === 'activity')
    .map((e) => (e.kind === 'activity' ? e.activity : null));
  for (const id of ['exec_2', 'edit_1', 'plan_1', 'collab_wait', 'collab_spawn', 'collab_message', 'collab_other']) {
    assert.deepEqual(
      activity.filter((item) => item?.sourceId === id).map((item) => item?.status),
      ['running', 'done'],
    );
  }
  assert.equal(activity.find((item) => item?.sourceId === 'exec_2')?.detail, 'npm test');
  assert.deepEqual(
    ['collab_wait', 'collab_spawn', 'collab_message', 'collab_other'].map((id) =>
      activity.filter((item) => item?.sourceId === id).map((item) => item?.headline),
    ),
    [
      ['Waiting for subagents', 'Waited for subagents'],
      ['Starting a subagent', 'Started a subagent'],
      ['Messaging a subagent', 'Messaged a subagent'],
      ['Coordinating subagents', 'Coordinated subagents'],
    ],
  );
});

test('a live file change reads its path from the captured changes map', () => {
  const h = harness();
  h.wire.receive(
    JSON.stringify({
      method: 'item/completed',
      params: {
        item: {
          type: 'fileChange',
          id: 'edit_changes',
          status: 'completed',
          changes: { 'src/from-map.ts': { type: 'update', unifiedDiff: '@@' } },
        },
      },
    }),
  );
  const activity = h.events.find((event) => event.kind === 'activity');
  assert.ok(activity && activity.kind === 'activity');
  assert.equal(activity.activity.detail, 'src/from-map.ts');
  assert.equal(activity.activity.status, 'done');
});

test('live file changes read every path from the app-server array shape', () => {
  const h = harness();
  h.wire.receive(
    JSON.stringify({
      method: 'item/started',
      params: {
        item: {
          type: 'fileChange',
          id: 'edit_array',
          status: 'inProgress',
          changes: [
            { path: 'src/a.ts', kind: 'update', diff: '@@' },
            { path: 'src/b.ts', kind: 'create', diff: '@@' },
          ],
        },
      },
    }),
  );
  const activity = h.events.find((event) => event.kind === 'activity');
  assert.ok(activity && activity.kind === 'activity');
  assert.equal(activity.activity.detail, 'src/a.ts\nsrc/b.ts');
});

test('a file approval joins to its file item whether detail arrives before or after the ask', () => {
  const fileItem = {
    type: 'fileChange',
    id: 'edit_approval',
    status: 'inProgress',
    changes: [
      { path: 'src/a.ts', kind: 'update', diff: '@@' },
      { path: 'src/b.ts', kind: 'create', diff: '@@' },
    ],
  };
  const request = (id: number) =>
    JSON.stringify({
      id,
      method: 'item/fileChange/requestApproval',
      params: { threadId: THREAD, turnId: TURN, itemId: fileItem.id, reason: 'Change the requested files' },
    });
  for (const order of ['item-first', 'ask-first']) {
    const h = harness();
    if (order === 'item-first') h.wire.receive(JSON.stringify({ method: 'item/started', params: { item: fileItem } }));
    h.wire.receive(request(41));
    if (order === 'ask-first') h.wire.receive(JSON.stringify({ method: 'item/started', params: { item: fileItem } }));
    const asks = h.events
      .filter((event) => event.kind === 'ask')
      .map((event) => (event.kind === 'ask' ? event.ask : null));
    const ask = asks.at(-1);
    assert.ok(ask && ask.kind === 'permission', order);
    if (!ask || ask.kind !== 'permission') continue;
    assert.deepEqual(ask.input, { paths: ['src/a.ts', 'src/b.ts'] }, order);
    assert.equal(h.wire.answer(fileItem.id, { decision: 'allow' }), true, order);
    assert.deepEqual(h.parsed().at(-1), { id: 41, result: { decision: 'accept' } }, order);
  }
});

test('a file approval is enriched by the app-server patch update', () => {
  const h = harness();
  h.wire.receive(
    JSON.stringify({
      id: 42,
      method: 'item/fileChange/requestApproval',
      params: { threadId: THREAD, turnId: TURN, itemId: 'edit_patch', reason: '' },
    }),
  );
  h.wire.receive(
    JSON.stringify({
      method: 'item/fileChange/patchUpdated',
      params: {
        threadId: THREAD,
        turnId: TURN,
        itemId: 'edit_patch',
        changes: [{ path: 'src/from-patch.ts', kind: 'update', diff: '@@' }],
      },
    }),
  );
  const asks = h.events
    .filter((event) => event.kind === 'ask')
    .map((event) => (event.kind === 'ask' ? event.ask : null));
  const ask = asks.at(-1);
  assert.ok(ask && ask.kind === 'permission');
  if (ask && ask.kind === 'permission') assert.deepEqual(ask.input, { paths: ['src/from-patch.ts'] });
});

test('Codex configuration overrides catalog suggestions and TUI-only policy defaults', () => {
  const catalog = {
    data: [
      {
        id: 'gpt-current',
        model: 'gpt-current',
        isDefault: true,
        defaultReasoningEffort: 'low',
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
      },
    ],
  };
  const config = { config: { model: 'gpt-current', model_reasoning_effort: 'high' } };
  const expected = { status: 'ready', model: 'gpt-current', effort: 'high', reason: '' };
  assert.deepEqual(readAppliedDefaults(config, catalog, { requirements: null }), expected);
  assert.deepEqual(
    readAppliedDefaults(config, catalog, {
      requirements: { models: { newThread: { model: 'another', modelReasoningEffort: 'low', serviceTier: 'fast' } } },
    }),
    expected,
  );
  assert.equal(readAppliedDefaults(config, catalog, {}).status, 'unavailable');
  assert.equal(readAppliedDefaults(config, catalog, { requirements: 'bad' }).status, 'unavailable');
  assert.equal(readAppliedDefaults(null, catalog, { requirements: null }).status, 'unavailable');
  assert.equal(readAppliedDefaults({ config: {} }, catalog, { requirements: null }).effort, 'low');
  const privateModel = readAppliedDefaults({ config: { model: 'private-model' } }, catalog, { requirements: null });
  assert.equal(privateModel.model, 'private-model');
  assert.equal(privateModel.status, 'ready');
  assert.equal(privateModel.effortStatus, 'unavailable');
});

test('Codex default metadata uses only configuration and catalog reads from the version floor up', async () => {
  const qualified = ['0.159.2', '0.160.0', '0.160.00', '0.160.1', '0.163.0', '0.164.0-alpha.3', '1.0.0'];
  for (const userAgent of [
    ...qualified.map((version) => `codex_cli_rs/${version} (Windows 10.0; x86_64)`),
    'arc/0.163.0 (Windows 10.0; x86_64) vscode/1.105.1 (arc; 1.2.3)',
  ]) {
    const h = harness();
    const opening = h.wire.initialize();
    reply(h, { userAgent });
    await opening;
    const reading = h.wire.appliedDefaults('C:/project', '');
    const requests = h.parsed().filter((message) => message.id > 1);
    assert.deepEqual(
      requests.map((message) => message.method),
      ['config/read', 'model/list', 'configRequirements/read'],
      userAgent,
    );
    assert.deepEqual(requests[0].params, { includeLayers: false, cwd: 'C:/project' });
    for (const request of requests) {
      const result =
        request.method === 'config/read'
          ? { config: { model: 'gpt-current', model_reasoning_effort: 'high' } }
          : request.method === 'model/list'
            ? {
                data: [
                  {
                    id: 'gpt-current',
                    model: 'gpt-current',
                    isDefault: true,
                    defaultReasoningEffort: 'low',
                    supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
                  },
                ],
              }
            : { requirements: null };
      h.wire.receive(JSON.stringify({ id: request.id, result }));
    }
    assert.equal((await reading).effort, 'high', userAgent);
    assert.equal(
      h.parsed().some((message) => message.method === 'thread/start' || message.method === 'turn/start'),
      false,
    );
  }
  for (const userAgent of [
    ...['0.159.1', '0.158.9', '0.159.2-alpha.1', '0.0.0', 'garbage'].map((version) => `codex_cli_rs/${version}`),
    'arc/0.158.9 (Windows 10.0; x86_64) vscode/1.105.1',
  ]) {
    const other = harness();
    const opening = other.wire.initialize();
    reply(other, { userAgent });
    await opening;
    const reading = other.wire.appliedDefaults('C:/project', '');
    const snapshot = other.wire.appliedDefaultsSnapshot('C:/project');
    assert.deepEqual(
      other.parsed().filter((message) => message.id > 1),
      [],
      userAgent,
    );
    assert.equal((await reading).status, 'unavailable', userAgent);
    assert.equal(await snapshot, null, userAgent);
  }
  const unknown = harness();
  assert.equal((await unknown.wire.appliedDefaults('C:/project', '')).status, 'unavailable');
  assert.equal(await unknown.wire.appliedDefaultsSnapshot('C:/project'), null);
  assert.equal(unknown.parsed().length, 0);
  const missing = harness();
  const opening = missing.wire.initialize();
  reply(missing, {});
  await opening;
  assert.equal(await missing.wire.appliedDefaultsSnapshot('C:/project'), null);
});

test('Codex refused version ranges leave defaults unavailable inside them', () => {
  const open = [{ first: '0.163.0' }];
  assert.equal(codexDefaultsQualified('codex_cli_rs/0.162.9', open), true);
  assert.equal(codexDefaultsQualified('codex_cli_rs/0.163.0', open), false);
  assert.equal(codexDefaultsQualified('codex_cli_rs/0.170.2 (Windows 10.0; x86_64)', open), false);
  const closed = [{ first: '0.161.0', last: '0.162.1' }];
  assert.equal(codexDefaultsQualified('codex_cli_rs/0.160.9', closed), true);
  assert.equal(codexDefaultsQualified('codex_cli_rs/0.161.0', closed), false);
  assert.equal(codexDefaultsQualified('codex_cli_rs/0.162.1', closed), false);
  assert.equal(codexDefaultsQualified('codex_cli_rs/0.162.2', closed), true);
  assert.equal(codexDefaultsQualified('codex_cli_rs/0.163.0'), true);
});

test('Codex refused version ranges that do not read refuse every qualified version', () => {
  assert.equal(codexDefaultsQualified('codex_cli_rs/0.163.0', [{ first: '0.163' }]), false);
  assert.equal(codexDefaultsQualified('codex_cli_rs/0.160.0', [{ first: '0.161.0', last: '0.162' }]), false);
  assert.equal(codexDefaultsQualified('arc/0.163.0', [{ first: '0.163.0', last: '0.162.1' }]), false);
  assert.equal(codexDefaultsQualified('arc/0.160.0', [{ first: '0.163.0', last: '0.162.1' }]), false);
  assert.equal(codexDefaultsQualified('arc/0.163.0', [{ first: '0.163.0', last: '0.163.0' }]), false);
  assert.equal(codexDefaultsQualified('arc/0.163.1', [{ first: '0.163.0', last: '0.163.0' }]), true);
});

test('Codex default snapshots retain only original model and effort configuration', async () => {
  assert.equal(readDefaultConfiguration({ config: { model: 3 } }), null);
  assert.equal(readDefaultConfiguration({ config: { model_reasoning_effort: {} } }), null);
  for (const config of [{ model: 'gpt-current' }, { model: null, model_reasoning_effort: null }]) {
    const h = harness();
    const opening = h.wire.initialize();
    reply(h, { userAgent: 'codex_cli_rs/0.160.0' });
    await opening;
    const reading = h.wire.appliedDefaultsSnapshot('C:/project');
    for (const request of h.parsed().filter((message) => message.id > 1)) {
      const result =
        request.method === 'config/read'
          ? { config: { ...config, api_key: 'private', cwd: 'private', mcp_servers: { private: {} } } }
          : request.method === 'model/list'
            ? {
                data: [
                  {
                    id: 'gpt-current',
                    model: 'gpt-current',
                    isDefault: true,
                    defaultReasoningEffort: 'low',
                    supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
                  },
                ],
              }
            : { requirements: { private: 'private' } };
      h.wire.receive(JSON.stringify({ id: request.id, result }));
    }
    const snapshot = await reading;
    assert.ok(snapshot);
    assert.deepEqual(snapshot.configuration, { config });
    assert.deepEqual(snapshot.policy, { requirements: {} });
    assert.equal(JSON.stringify(snapshot).includes('private'), false);
  }
});

// Catches a guarded follow-up written while a compaction request that got no answer can still start its late turn.
test('a Codex compaction with no answer withholds idle evidence and refuses a guarded prompt until its late turn ends', async () => {
  const h = harness(1_000);
  const starting = h.wire.startThread({ cwd: 'C:\\ws' });
  reply(h, { thread: { id: THREAD } });
  await starting;
  const first = h.wire.prompt('initial assignment');
  await completeLastTurn(h, 'turn-initial');
  await first;
  assert.equal(h.wire.idleEvidence(), true);
  vi.useFakeTimers();
  try {
    const unanswered = assert.rejects(h.wire.compact(), /did not answer/);
    await vi.advanceTimersByTimeAsync(1_000);
    await unanswered;
    assert.equal(h.wire.compactionUnresolved(), true);
    assert.equal(h.wire.idleEvidence(), false, 'an unanswered compaction is not idle');
    const written = h.parsed().length;
    const attempt = new GuardedAttempt('uuid-follow-up');
    await assert.rejects(h.wire.prompt('Follow up.', attempt), /not idle/);
    assert.equal(h.parsed().length, written, 'the guarded prompt reached the wire');
    const send = (method: string, params: Record<string, unknown>) =>
      h.wire.receive(JSON.stringify({ method, params }));
    send('turn/started', { threadId: THREAD, turn: { id: 'late' } });
    const live = new GuardedAttempt('uuid-live-compaction');
    await h.wire.steer('No compaction input.', live);
    assert.equal(live.settled?.outcome, 'refused');
    assert.equal(h.parsed().length, written);
    send('turn/completed', { threadId: THREAD, turn: { id: 'late', status: 'completed' } });
    assert.equal(h.wire.compactionUnresolved(), false);
    assert.equal(h.wire.idleEvidence(), true, 'the late turn ending restores idle evidence');
    h.wire.close('finished');
  } finally {
    vi.useRealTimers();
  }
});

test('Codex guarded live input requires exactly one root and accepts only its correlated steer receipt', async () => {
  vi.useFakeTimers();
  try {
    const h = harness(50);
    const starting = h.wire.startThread({ cwd: 'C:/ws' });
    reply(h, { thread: { id: THREAD, path: 'C:/rollout.jsonl' } });
    await starting;
    const idle = new GuardedAttempt('idle');
    const before = h.sent.length;
    await h.wire.steer('idle input', idle);
    assert.equal(idle.settled?.outcome, 'refused');
    assert.equal(h.sent.length, before);
    const notify = (method: string, id = TURN) =>
      h.wire.receive(JSON.stringify({ method, params: { threadId: THREAD, turn: { id, status: 'completed' } } }));
    notify('turn/started');
    for (const outcome of ['accepted', 'mismatch', 'rpc', 'deadline', 'close']) {
      const attempt = new GuardedAttempt(outcome);
      const pending = h.wire.steer('correction', attempt);
      const sent = h.parsed().at(-1)!;
      assert.equal(sent.method, 'turn/steer');
      assert.equal(sent.params.expectedTurnId, TURN);
      assert.deepEqual(sent.params.input, [{ type: 'text', text: 'correction' }]);
      if (outcome === 'accepted') reply(h, { turnId: TURN });
      if (outcome === 'mismatch') reply(h, { turnId: 'other' });
      if (outcome === 'rpc')
        h.wire.receive(
          JSON.stringify({ id: sent.id, error: { code: -32600, message: 'refused', data: { reason: 'unknown' } } }),
        );
      if (outcome === 'deadline') await vi.advanceTimersByTimeAsync(50);
      if (outcome === 'close') h.wire.close('closed');
      await pending;
      assert.equal(attempt.settled?.outcome, outcome === 'accepted' ? 'accepted' : 'unknown');
      assert.equal(h.parsed().filter((frame) => frame.method === 'turn/start').length, 0);
      if (outcome === 'deadline') {
        reply(h, { turnId: TURN });
        assert.equal(attempt.settled?.outcome, 'unknown');
      }
    }
    const roots = harness();
    const open = roots.wire.startThread({ cwd: 'C:/ws' });
    reply(roots, { thread: { id: THREAD } });
    await open;
    for (const id of ['one', 'two'])
      roots.wire.receive(JSON.stringify({ method: 'turn/started', params: { threadId: THREAD, turn: { id } } }));
    assert.equal(roots.wire.steerable(), false);
  } finally {
    vi.useRealTimers();
  }
});

test('Codex ordinary corrections resume after automatic compaction while retaining exact root-ending evidence', async () => {
  const h = harness();
  const starting = h.wire.startThread({ cwd: 'C:/ws' });
  reply(h, { thread: { id: THREAD } });
  await starting;
  const send = (method: string, params: Record<string, unknown>) =>
    h.wire.receive(JSON.stringify({ method, params: { threadId: THREAD, ...params } }));
  send('turn/started', { turn: { id: TURN } });
  assert.equal(h.wire.steerable(), true);
  const item = (method: string, id: string, turnId = TURN) =>
    send(method, { turnId, item: { id, type: 'contextCompaction' } });
  item('item/started', 'automatic');
  item('item/started', 'overlapping');
  const written = h.sent.length;
  const blocked = new GuardedAttempt('during-automatic');
  await h.wire.steer('Wait for compaction.', blocked);
  assert.equal(blocked.settled?.outcome, 'refused');
  assert.equal(h.sent.length, written);
  item('item/completed', 'automatic');
  item('item/completed', 'overlapping', 'other-root');
  assert.equal(h.wire.steerable(), false, "another root cannot complete this root's compaction");
  item('item/completed', 'overlapping');
  send('item/started', { turnId: TURN, item: { id: 'continued', type: 'agentMessage', text: 'Working.' } });
  const correction = new GuardedAttempt('after-automatic');
  const correcting = h.wire.steer('Correct the remaining work.', correction);
  assert.equal(h.parsed().at(-1)?.method, 'turn/steer');
  assert.equal(h.parsed().at(-1)?.params.expectedTurnId, TURN);
  reply(h, { turnId: TURN });
  await correcting;
  assert.equal(correction.settled?.outcome, 'accepted');
  send('turn/completed', { turn: { id: TURN, status: 'completed' } });
  assert.ok(
    h.events.some(
      (event) =>
        event.kind === 'native' &&
        event.event.kind === 'compact' &&
        event.event.stage === 'turnEnd' &&
        event.event.turnId === TURN,
    ),
  );
  assert.equal(h.wire.idleEvidence(), true);
  h.wire.close('finished');
});

test('Codex manual compaction retains exclusion between native item completion and root completion', async () => {
  const h = harness();
  const starting = h.wire.startThread({ cwd: 'C:/ws' });
  reply(h, { thread: { id: THREAD } });
  await starting;
  const compacting = h.wire.compact();
  const requestId = h.parsed().at(-1)!.id;
  const send = (method: string, params: Record<string, unknown>) =>
    h.wire.receive(JSON.stringify({ method, params: { threadId: THREAD, ...params } }));
  const refuse = async () => {
    assert.equal(h.wire.steerable(), false, 'manual compaction must keep ordinary input ineligible');
    const written = h.sent.length;
    const correction = new GuardedAttempt('manual-compaction');
    await h.wire.steer('Ordinary correction.', correction);
    assert.equal(correction.settled?.outcome, 'refused');
    assert.equal(h.sent.length, written);
  };
  await refuse();
  h.wire.receive(JSON.stringify({ id: requestId, result: {} }));
  send('turn/started', { turn: { id: TURN, items: [], status: 'inProgress', error: null } });
  await refuse();
  send('item/started', { turnId: TURN, item: { type: 'contextCompaction', id: 'compact-item' } });
  await refuse();
  send('item/completed', { turnId: TURN, item: { type: 'contextCompaction', id: 'compact-item' } });
  await refuse();
  send('turn/completed', { turn: { id: TURN, items: [], status: 'completed', error: null } });
  await compacting;
  assert.equal(h.wire.compactionUnresolved(), false);
  assert.equal(h.wire.idleEvidence(), true);
  h.wire.close('finished');
});

test('Codex guarded prompts accept only their own correlated turn and settle shared, failed, and silent starts as unknown', async () => {
  const h = harness(50);
  const starting = h.wire.startThread({ cwd: 'C:\\ws' });
  reply(h, { thread: { id: THREAD, path: 'C:\\rollout.jsonl' } });
  await starting;
  assert.equal(h.wire.idleEvidence(), false, 'an open thread with no ended turn is not idle evidence');
  const first = h.wire.prompt('initial assignment');
  await completeLastTurn(h, 'turn-initial');
  await first;
  assert.equal(h.wire.idleEvidence(), true);
  h.wire.receive(
    JSON.stringify({ method: 'turn/started', params: { threadId: 'child-thread', turn: { id: 'nested' } } }),
  );
  assert.equal(h.wire.idleEvidence(), true, 'a nested thread turn is not root activity');
  h.wire.receive(JSON.stringify({ method: 'turn/started', params: { threadId: THREAD, turn: { id: 'unsolicited' } } }));
  assert.equal(h.wire.idleEvidence(), false, 'an unsolicited root turn is running work');
  await assert.rejects(h.wire.prompt('blocked', new GuardedAttempt('u0')), /not idle/);
  h.wire.receive(
    JSON.stringify({
      method: 'turn/completed',
      params: { threadId: THREAD, turn: { id: 'unsolicited', status: 'completed', items: [] } },
    }),
  );
  assert.equal(h.wire.idleEvidence(), true);

  const accepted = new GuardedAttempt('u1');
  const prompting = h.wire.prompt('Apply the fixes.', accepted);
  h.wire.receive(
    JSON.stringify({ method: 'turn/started', params: { threadId: THREAD, turn: { id: 'turn-guarded' } } }),
  );
  assert.equal(accepted.settled, null, 'an uncorrelated notification grants no acceptance');
  reply(h, { turn: { id: 'turn-guarded', status: 'inProgress' } });
  assert.equal(await prompting, 'turn-guarded');
  assert.deepEqual(accepted.settled, { outcome: 'accepted', nativeTurnId: 'turn-guarded', reason: '' });
  h.wire.receive(
    JSON.stringify({
      method: 'turn/completed',
      params: { threadId: THREAD, turn: { id: 'turn-guarded', status: 'completed', items: [] } },
    }),
  );

  const shared = new GuardedAttempt('u2');
  const joining = h.wire.prompt('Joins old work.', shared);
  reply(h, { turn: { id: 'turn-initial', status: 'inProgress' } });
  await joining.catch(() => {});
  assert.deepEqual(
    [shared.settled?.outcome, shared.settled?.nativeTurnId, shared.settled?.sharedTurn],
    ['unknown', 'turn-initial', true],
  );
  h.wire.receive(
    JSON.stringify({
      method: 'turn/completed',
      params: { threadId: THREAD, turn: { id: 'turn-initial', status: 'completed', items: [] } },
    }),
  );

  for (const [name, answer] of [
    ['writer lock', () => refuseLast(h, 'thread already has an active writer')],
    ['unnamed turn', () => reply(h, { turn: {} })],
    ['deadline', () => {}],
  ] as const) {
    const attempt = new GuardedAttempt(name);
    const pending = h.wire.prompt('Uncertain.', attempt);
    answer();
    await waitForDeadline(pending.catch(() => {}));
    assert.equal(attempt.settled?.outcome, 'unknown', name);
  }
});
