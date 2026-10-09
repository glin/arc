import { test, vi } from 'vitest';
import assert from 'node:assert';
import {
  CodexWire,
  SandboxMode,
  appServerArgs,
  readCodexMcpServers,
  readRateLimits,
  readModels,
  readAppliedDefaults,
  readDefaultConfiguration,
  turnOutcome,
} from './codexwire.ts';
import { WireEvent, Ask, RateLimit } from './agentwire.ts';

// App-server fixtures retain protocol fields, including request ID 0. A truthiness check must not discard that ID.

const THREAD = '01a04792-145f-7c01-9dd6-f3234c381e7e';
const TURN = '01a04792-152f-72f1-b738-f4b20621e59a';

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

function harness(deadlineMs?: number) {
  const sent: string[] = [];
  const events: WireEvent[] = [];
  const wire = new CodexWire({
    send: (line) => sent.push(line),
    emit: (event) => events.push(event),
    clientInfo: { name: 'arc', title: 'Arc', version: '0.1.0' },
    cwd: 'C:\\ws',
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
  assert.deepEqual(h.events.at(-1), {
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
  return h.events.some((e) => e.kind === 'askResolved' && e.id === ASYNC_QUESTION_ITEM.id);
}

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

test('Codex default metadata uses only configuration and catalog reads on the qualified server', async () => {
  for (const version of ['0.159.2', '0.160.0']) {
    const h = harness();
    const opening = h.wire.initialize();
    reply(h, { userAgent: `codex_cli_rs/${version} (Windows 10.0; x86_64)` });
    await opening;
    const reading = h.wire.appliedDefaults('C:/project', '');
    const requests = h.parsed().filter((message) => message.id > 1);
    assert.deepEqual(
      requests.map((message) => message.method),
      ['config/read', 'model/list', 'configRequirements/read'],
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
    assert.equal((await reading).effort, 'high');
    assert.equal(
      h.parsed().some((message) => message.method === 'thread/start' || message.method === 'turn/start'),
      false,
    );
  }
  for (const version of ['0.160.1', '0.160.0-dev', '0.160.00', '0.159.20']) {
    const other = harness();
    const opening = other.wire.initialize();
    reply(other, { userAgent: `codex_cli_rs/${version}` });
    await opening;
    assert.equal((await other.wire.appliedDefaults('C:/project', '')).status, 'unavailable');
    assert.equal(await other.wire.appliedDefaultsSnapshot('C:/project'), null);
    assert.deepEqual(
      other.parsed().filter((message) => message.id > 1),
      [],
    );
  }
  const unknown = harness();
  assert.equal((await unknown.wire.appliedDefaults('C:/project', '')).status, 'unavailable');
  assert.equal(await unknown.wire.appliedDefaultsSnapshot('C:/project'), null);
  assert.equal(unknown.parsed().length, 0);
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
