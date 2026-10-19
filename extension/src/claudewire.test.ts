import { test, vi } from 'vitest';
import assert from 'node:assert';
import { CONTEXT_FRAME_BYTES } from './contextframe';
import { ClaudeResponseClock, responseRateForTurn, savedResponseRates, retainResponseRate } from './outputrate';
import {
  ClaudeWire,
  claudePromptContent,
  spawnArgs,
  readUsage,
  readUsageResult,
  readModels,
  readAppliedDefaults,
  WireEvent,
  Ask,
  TurnOutcome,
  RateLimit,
  GUARDED_RECEIPT_MS,
} from './claudewire.ts';
import { GuardedAttempt } from './agentwire.ts';
import { createHash } from 'node:crypto';

// Protocol fixtures retain the fields consumed by the wire adapter, including the unified context window.

const SESSION = 'c0129cee-9323-4aea-a448-ec90642971ea';

test('Claude native evidence retains root envelopes, successful tool settlement and distinct manual compaction', async () => {
  const events: WireEvent[] = [];
  const writes: string[] = [];
  const wire = new ClaudeWire({
    send: (line) => writes.push(line),
    emit: (event) => events.push(event),
    sessionId: SESSION,
  });
  await wire.prompt('Save the handoff, then compact.');
  const tool = {
    type: 'tool_use',
    id: 'root-call',
    name: 'Bash',
    input: { command: 'arc compact request literal' },
    caller: { type: 'direct' },
  };
  const send = (payload: Record<string, unknown>) => wire.receive(JSON.stringify({ session_id: SESSION, ...payload }));
  for (const parent of ['child', undefined])
    send({ type: 'assistant', parent_tool_use_id: parent, message: { content: [tool] } });
  assert.equal(events.filter((e) => e.kind === 'native' && e.event.kind === 'toolStart').length, 0);
  send({
    type: 'assistant',
    parent_tool_use_id: null,
    uuid: 'envelope',
    request_id: 'native-request',
    message: { content: [tool] },
  });
  send({
    type: 'user',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_result', tool_use_id: 'root-call', is_error: false }] },
    tool_use_result: { interrupted: false },
  });
  const result = {
    type: 'result',
    uuid: 'root-result',
    result_index: 0,
    num_turns: 2,
    subtype: 'success',
    is_error: false,
    terminal_reason: 'completed',
  };
  send(result);
  const native = events.filter((e) => e.kind === 'native').map((e) => e.event);
  assert.deepEqual(
    native.map((e) => e.kind),
    ['submission', 'toolStart', 'toolEnd', 'rootEnd'],
  );
  assert.equal(native[1].evidence.request_id, 'native-request');
  assert.equal(native[1].generation, 1);
  assert.equal(native[2].kind === 'toolEnd' && native[2].success, true);
  assert.equal(native[3].evidence.uuid, 'root-result');
  assert.equal(native[3].turnId, null);
  let checks = 0;
  await wire.prompt('/compact', undefined, () => {
    assert.equal(writes.length, 1);
    checks++;
  });
  send({ type: 'system', subtype: 'status', status: 'compacting' });
  send({ type: 'system', subtype: 'status', status: null, compact_result: 'success' });
  send({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual' } });
  send({ ...result, local_command: 'compact', result_index: 1, num_turns: 0 });
  const compact = events.flatMap((e) => (e.kind === 'native' && e.event.kind === 'compact' ? [e.event] : []));
  assert.equal(checks, 1);
  assert.equal(compact.length, 4);
  assert.equal(
    compact.every((e) => e.generation === 2),
    true,
  );
  await assert.rejects(
    async () =>
      wire.prompt('/compact', undefined, () => {
        throw new Error('reader intervened');
      }),
    /reader intervened/,
  );
  assert.equal(writes.length, 2);
  wire.close('finished');
});

test('Claude response speed uses final actual output and commits only a stopped main response', () => {
  const events: WireEvent[] = [];
  let clock = 1000;
  const wire = new ClaudeWire({ send() {}, emit: (event) => events.push(event), sessionId: SESSION, now: () => clock });
  const send = (event: Record<string, unknown>, parent: string | null = null, session = SESSION) =>
    wire.receive(JSON.stringify({ type: 'stream_event', session_id: session, parent_tool_use_id: parent, event }));
  send({ type: 'message_start', message: { id: 'response', model: 'claude-opus-5' } });
  clock = 2000;
  send({
    type: 'message_delta',
    delta: { stop_reason: 'tool_use' },
    usage: { output_tokens: 84, output_tokens_details: { thinking_tokens: 40 } },
  });
  assert.equal(events.filter((event) => event.kind === 'responseRate').length, 0);
  clock = 9000;
  send({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 90 } });
  send({ type: 'message_start', message: { id: 'child', model: 'claude-opus-5' } }, 'child-tool');
  send({ type: 'message_stop' }, 'child-tool');
  send({ type: 'message_stop' });
  const rate = events.find((event) => event.kind === 'responseRate');
  assert.ok(rate?.kind === 'responseRate');
  assert.deepEqual(rate.rate, {
    sessionId: SESSION,
    responseId: 'response',
    model: 'claude-opus-5',
    output: 90,
    milliseconds: 1000,
  });
  send({ type: 'message_stop' });
  send({ type: 'message_start', message: { id: 'response', model: 'claude-opus-5' } });
  assert.equal(events.filter((event) => event.kind === 'responseRate').length, 1);
});

test('Claude response timing excludes invalid scopes, clocks, resets, and unfinished responses', async () => {
  for (const mutation of ['scope', 'session', 'missing', 'negative', 'interrupt', 'prompt', 'close']) {
    const events: WireEvent[] = [];
    let clock = 1000;
    const wire = new ClaudeWire({
      send() {},
      emit: (event) => events.push(event),
      sessionId: SESSION,
      now: () => clock,
    });
    const send = (event: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      wire.receive(
        JSON.stringify({ type: 'stream_event', session_id: SESSION, parent_tool_use_id: null, event, ...extra }),
      );
    send({ type: 'message_start', message: { id: mutation, model: 'claude-opus-5' } });
    clock = mutation === 'negative' ? 900 : 2000;
    if (mutation === 'scope') send({ type: 'content_block_delta' }, { parent_tool_use_id: undefined });
    if (mutation === 'session') send({ type: 'content_block_delta' }, { session_id: 'successor' });
    if (mutation === 'interrupt') void wire.interrupt().catch(() => {});
    if (mutation === 'prompt') await wire.prompt('new prompt');
    if (mutation === 'close') wire.close('closed');
    if (mutation === 'interrupt' || mutation === 'close')
      send({ type: 'message_start', message: { id: 'late-response', model: 'claude-opus-5' } });
    send({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: mutation === 'missing' ? {} : { output_tokens: 50 },
    });
    send({ type: 'message_stop' });
    assert.equal(events.filter((event) => event.kind === 'responseRate').length, 0, mutation);
    wire.close('finished');
  }
  const observer = new ClaudeResponseClock();
  assert.deepEqual(
    observer.observe({ session_id: SESSION, parent_tool_use_id: null, event: { type: 'message_stop' } }, 100),
    {},
  );
});

test('Claude response speed omits usage after an unreadable successor start', () => {
  const events: WireEvent[] = [];
  let clock = 1000;
  const wire = new ClaudeWire({ send() {}, emit: (event) => events.push(event), sessionId: SESSION, now: () => clock });
  const frame = (event: Record<string, unknown>) =>
    JSON.stringify({ type: 'stream_event', session_id: SESSION, parent_tool_use_id: null, event });
  wire.receive(frame({ type: 'message_start', message: { id: 'first', model: 'claude-opus-5' } }));
  wire.receive(frame({ type: 'message_start', message: { id: 'successor', model: 'claude-opus-5' } }).slice(0, -1));
  clock = 2000;
  wire.receive(frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 84 } }));
  wire.receive(frame({ type: 'message_stop' }));
  assert.equal(events.filter((event) => event.kind === 'responseRate').length, 0);
  wire.receive(frame({ type: 'message_start', message: { id: 'next', model: 'claude-opus-5' } }));
  clock = 3000;
  wire.receive(frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } }));
  wire.receive(frame({ type: 'message_stop' }));
  const rates = events.filter((event) => event.kind === 'responseRate');
  assert.equal(rates.length, 1);
  assert.equal(rates[0].rate.responseId, 'next');
});

test('saved Claude response speed joins exact session and main request identities with weighted times', () => {
  const first = { sessionId: SESSION, responseId: 'one', model: 'claude-opus-5', output: 84, milliseconds: 10000 };
  let rates = retainResponseRate([], first);
  rates = retainResponseRate(rates, first);
  rates = retainResponseRate(rates, { ...first, responseId: 'two', output: 168, milliseconds: 10000 });
  rates = retainResponseRate(rates, { ...first, sessionId: 'child', output: 999 });
  const turn = { sessionId: SESSION, model: first.model, responseIds: ['one', 'two'], interrupted: false };
  assert.deepEqual(responseRateForTurn(turn, savedResponseRates(JSON.parse(JSON.stringify(rates)))), {
    output: 252,
    milliseconds: 20000,
  });
  assert.equal(responseRateForTurn({ ...turn, responseIds: ['missing'] }, rates), undefined);
  assert.equal(responseRateForTurn({ ...turn, interrupted: true }, rates), undefined);
  assert.equal(responseRateForTurn({ ...turn, model: 'different' }, rates), undefined);
  assert.equal(
    savedResponseRates(Array.from({ length: 1000 }, (_, index) => ({ ...first, responseId: String(index) }))).length,
    512,
  );
  assert.deepEqual(
    savedResponseRates([
      { ...first, milliseconds: 0 },
      { ...first, output: -1 },
    ]),
    [],
  );
});

const INIT_LINE = JSON.stringify({
  type: 'system',
  subtype: 'init',
  cwd: 'C:\\probe-ws',
  session_id: SESSION,
  model: 'claude-haiku-4-5-20251001',
  permissionMode: 'default',
});

const INIT_RESPONSE = JSON.stringify({
  type: 'control_response',
  response: {
    subtype: 'success',
    request_id: 'arc_1',
    response: {
      commands: [
        { name: 'compact', description: 'Compact the conversation', argumentHint: '[instructions]' },
        { name: 'context', description: 'Show context use', argumentHint: '' },
      ],
    },
  },
});

const RATE_LINE = JSON.stringify({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed_warning',
    resetsAt: 1787929200,
    rateLimitType: 'seven_day',
    utilization: 0.91,
    overageResetsAt: 1790812800,
    isUsingOverage: false,
    surpassedThreshold: 0.75,
  },
  session_id: SESSION,
});

const UNIFIED_RATE_LINE = JSON.stringify({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed_warning',
    resetsAt: 1787929200,
    rateLimitType: 'five_hour',
    utilization: 0.63,
    unifiedWindows: {
      five_hour: { utilization: 0.63, resetsAt: 1787929200 },
      seven_day: { utilization: 0.41, resetsAt: 1788361200 },
      seven_day_overage_included: { utilization: 0.12, resetsAt: 1788361200 },
    },
  },
  session_id: SESSION,
});

const TOOL_USE_LINE = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_01HJEtR8ihqs1hm6P4Ne9SHK',
        name: 'Bash',
        input: { command: 'echo probe-permission-test', description: 'Run permission test echo command' },
      },
    ],
  },
  session_id: SESSION,
});

const TEXT_LINE = JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
  session_id: SESSION,
});

const PERMISSION_ASK = JSON.stringify({
  type: 'control_request',
  request_id: '19e88315-ef2e-49ad-a093-34f654a299f4',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'Bash',
    display_name: 'Bash',
    input: { command: 'echo probe-permission-test', description: 'Run permission test echo command' },
    description: 'Run permission test echo command',
    decision_reason_type: 'rule',
    tool_use_id: 'toolu_01HJEtR8ihqs1hm6P4Ne9SHK',
  },
});

const QUESTION_ASK = JSON.stringify({
  type: 'control_request',
  request_id: 'e923a63c-936d-4220-8fd3-ca1e295ab09e',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'AskUserQuestion',
    display_name: 'AskUserQuestion',
    input: {
      questions: [
        {
          question: 'Which colour do you prefer?',
          header: 'Colour',
          options: [
            { label: 'Red', description: 'A warm, energetic colour' },
            { label: 'Blue', description: 'A cool, calm colour' },
          ],
          multiSelect: false,
        },
      ],
    },
    tool_use_id: 'toolu_01M9rUYsgBbWhqxAFKnYFZqj',
    requires_user_interaction: true,
  },
});

const OK_RESULT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  terminal_reason: 'completed',
  num_turns: 2,
  total_cost_usd: 0.0346453,
  session_id: SESSION,
  result: 'Done.',
  permission_denials: [],
});

const DENIED_RESULT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  terminal_reason: 'completed',
  num_turns: 2,
  total_cost_usd: 0.0346453,
  session_id: SESSION,
  result: 'The command was declined.',
  permission_denials: [
    {
      tool_name: 'Bash',
      tool_use_id: 'toolu_01NWwxP2wg96D18XqVbsb3yd',
      tool_input: { command: 'echo probe-deny-test', description: 'Run the requested echo command' },
    },
  ],
});

const INTERRUPTED_RESULT = JSON.stringify({
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  terminal_reason: 'aborted_streaming',
  num_turns: 2,
  total_cost_usd: 0.000997,
  session_id: '3fc22fee-4f8a-420c-abf1-e9658f48dc2a',
  permission_denials: [],
});

function harness(deadlineMs?: number, sessionId?: string, readFile?: (filePath: string) => Promise<Uint8Array>) {
  const sent: string[] = [];
  const events: WireEvent[] = [];
  const wire = new ClaudeWire({
    send: (line) => sent.push(line),
    emit: (event) => events.push(event),
    deadlineMs,
    sessionId,
    readFile,
  });
  return { wire, sent, events, parsed: () => sent.map((l) => JSON.parse(l)) };
}

test('context-only reads select summary and have a separate five-second deadline', async () => {
  vi.useFakeTimers();
  try {
    const h = harness();
    const context = h.wire.contextUsage();
    const rejected = assert.rejects(context, /did not answer/);
    const usage = h.wire.usage();
    assert.deepEqual(h.parsed()[0].request, { subtype: 'get_context_usage', detail: 'summary' });
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    h.wire.receive(
      JSON.stringify({
        type: 'control_response',
        response: { subtype: 'success', request_id: 'arc_2', response: { ok: true } },
      }),
    );
    assert.deepEqual(await usage, { ok: true });
    h.wire.close('closed');
  } finally {
    vi.useRealTimers();
  }
});

test('oversized reordered and late context replies are refused before JSON parsing', async () => {
  const h = harness();
  const pending = h.wire.contextUsage();
  const rejected = assert.rejects(pending, /limit/);
  const frame = JSON.stringify({
    response: { response: { large: 'x'.repeat(CONTEXT_FRAME_BYTES) }, request_id: 'arc_1', subtype: 'success' },
    type: 'control_response',
  });
  const parse = vi.spyOn(JSON, 'parse');
  try {
    h.wire.receive(frame);
    assert.equal(parse.mock.calls.length, 0);
  } finally {
    parse.mockRestore();
  }
  await rejected;
  vi.useFakeTimers();
  try {
    const late = h.wire.contextUsage();
    const timeout = assert.rejects(late);
    await vi.advanceTimersByTimeAsync(5000);
    await timeout;
    const spy = vi.spyOn(JSON, 'parse');
    try {
      h.wire.receive(frame.replace('arc_1', 'arc_2'));
      assert.equal(spy.mock.calls.length, 0);
    } finally {
      spy.mockRestore();
    }
  } finally {
    vi.useRealTimers();
    h.wire.close('closed');
  }
});

test('undrained context identities cap demand and a drained reply frees its slot', async () => {
  const h = harness();
  const reads = Array.from({ length: 32 }, () => h.wire.contextUsage());
  const settled = Promise.allSettled(reads);
  await assert.rejects(h.wire.contextUsage(), /undrained/);
  assert.equal(h.sent.length, 32);
  h.wire.receive(
    JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'arc_1', response: {} } }),
  );
  const extra = h.wire.contextUsage();
  const end = assert.rejects(extra);
  assert.equal(h.sent.length, 33);
  h.wire.close('closed');
  await settled;
  await end;
});

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

test('spawnArgs carries the three arguments the CLI will not work without', () => {
  const args = spawnArgs({ cwd: 'C:\\ws' });
  assert.ok(args.includes('-p'), 'print mode is what makes the CLI read stdin as a stream');
  assert.ok(args.includes('--verbose'), 'stream-json output is refused without it');
  const promptTool = args.indexOf('--permission-prompt-tool');
  assert.notEqual(promptTool, -1, 'without this flag the CLI never asks and allows everything');
  assert.equal(args[promptTool + 1], 'stdio');
  assert.deepEqual(
    [args.indexOf('--input-format'), args.indexOf('--output-format')].map((i) => args[i + 1]),
    ['stream-json', 'stream-json'],
  );
  assert.equal(
    args.includes('--permission-mode'),
    false,
    'an unpicked Claude launch overrides the permission mode from Claude settings',
  );
});

test('spawnArgs adds resume, model and persistence only when asked', () => {
  const bare = spawnArgs({ cwd: 'C:\\ws' });
  assert.equal(bare.includes('--resume'), false);
  assert.equal(bare.includes('--no-session-persistence'), false);
  const full = spawnArgs({
    cwd: 'C:\\ws',
    model: 'haiku',
    resume: 'abc',
    permissionMode: 'plan',
    persistSession: false,
  });
  assert.equal(full[full.indexOf('--resume') + 1], 'abc');
  assert.equal(full[full.indexOf('--model') + 1], 'haiku');
  assert.equal(full[full.indexOf('--permission-mode') + 1], 'plan');
  assert.ok(full.includes('--no-session-persistence'));
});

test('the effort level the reader picked is a flag on the child, and no flag when they picked none', () => {
  // The control channel carries no request that changes an effort level, so start-up is the
  // only place a pick can land. A child started without the flag runs at the model's own
  // default, which is what an unmade pick means.
  assert.equal(spawnArgs({ cwd: 'C:ws' }).includes('--effort'), false);
  assert.equal(spawnArgs({ cwd: 'C:ws', effort: '' }).includes('--effort'), false);
  const args = spawnArgs({ cwd: 'C:ws', model: 'opus', effort: 'xhigh' });
  assert.equal(args[args.indexOf('--effort') + 1], 'xhigh');
  assert.equal(
    args[args.indexOf('--model') + 1],
    'opus',
    'the level is picked for a model, so the two have to reach the same child',
  );
});

test('initialize goes out before anything else and answers with the command list', async () => {
  const h = harness();
  const ready = h.wire.initialize();
  const first = h.parsed()[0];
  assert.equal(first.type, 'control_request');
  assert.equal(first.request.subtype, 'initialize');
  assert.deepEqual(first.request.supportedDialogKinds, []);
  h.wire.receive(INIT_RESPONSE);
  const commands = await ready;
  assert.deepEqual(
    commands.map((c) => c.name),
    ['compact', 'context'],
  );
  assert.equal(commands[0].kind, 'command');
  assert.equal(commands[0].argumentHint, '[instructions]');
  assert.deepEqual(h.events[0], { kind: 'ready', commands });
});

test('the session id is reported once, not on every message that names it', () => {
  const h = harness();
  h.wire.receive(INIT_LINE);
  h.wire.receive(RATE_LINE);
  h.wire.receive(TEXT_LINE);
  assert.deepEqual(
    h.events.filter((e) => e.kind === 'session'),
    [{ kind: 'session', sessionId: SESSION, previous: null }],
    'a child naming itself for the first time reports a session it was never in',
  );
  assert.equal(h.wire.sessionId(), SESSION);
});

test('the init message reports the effective permission mode separately from the launch override', () => {
  const h = harness();
  h.wire.receive(INIT_LINE);
  assert.deepEqual(
    h.events.filter((event) => event.kind === 'permissionMode'),
    [{ kind: 'permissionMode', sessionId: SESSION, mode: 'default' }],
  );
});

test('the init message reports the working-directory skill list, including a plugin-qualified name', () => {
  const h = harness();
  h.wire.receive(
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: SESSION,
      skills: ['sample-skill', 'sample-plugin:sample-skill'],
    }),
  );
  assert.deepEqual(
    h.events.filter((e) => e.kind === 'skills'),
    [{ kind: 'skills', skills: ['sample-skill', 'sample-plugin:sample-skill'] }],
  );
});

test('an init message with no skills key reports nothing, not an empty list', () => {
  const h = harness();
  h.wire.receive(INIT_LINE);
  assert.deepEqual(
    h.events.filter((e) => e.kind === 'skills'),
    [],
    'an init line that never named a skills array was read as a real answer of no skills',
  );
});

test('an init message with an explicit empty skill list reports it as a real answer', () => {
  const h = harness();
  h.wire.receive(
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: SESSION,
      skills: [],
    }),
  );
  assert.deepEqual(
    h.events.filter((e) => e.kind === 'skills'),
    [{ kind: 'skills', skills: [] }],
  );
});

test('the session state report reads idle, running and a turn waiting on a permission answer', () => {
  const h = harness();
  for (const state of ['running', 'requires_action', 'idle', 'unknown']) {
    h.wire.receive(JSON.stringify({ type: 'system', subtype: 'session_state_changed', state, session_id: SESSION }));
  }
  h.wire.receive(JSON.stringify({ type: 'system', subtype: 'session_state_changed', session_id: SESSION }));
  assert.deepEqual(
    h.events.filter((e) => e.kind === 'sessionState'),
    [
      { kind: 'sessionState', state: 'running' },
      { kind: 'sessionState', state: 'running' },
      { kind: 'sessionState', state: 'idle' },
    ],
    'a state the CLI reported was dropped, or a state it never names was guessed',
  );
});

test('a non-string skill entry is dropped rather than carried as a name', () => {
  const h = harness();
  h.wire.receive(
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: SESSION,
      skills: ['sample-skill', 42, null],
    }),
  );
  assert.deepEqual(
    h.events.filter((e) => e.kind === 'skills'),
    [{ kind: 'skills', skills: ['sample-skill'] }],
  );
});

test('a resumed session is named before the child has written a line', async () => {
  // A resumed session is identified from its launch seed before the child produces output.

  const h = harness(undefined, SESSION);
  const ready = h.wire.initialize();
  h.wire.receive(INIT_RESPONSE);
  await ready;
  assert.equal(h.wire.sessionId(), SESSION);
  assert.deepEqual(
    h.events.filter((e) => e.kind === 'session'),
    [],
    'the session was known all along, so there is nothing to announce',
  );
});

test('a child that names a different session replaces the one it was started for', () => {
  // An announced session ID replaces the launch seed when the child opens a different session.

  const h = harness(undefined, 'a7b1c0de-0000-4000-8000-000000000000');
  h.wire.receive(INIT_LINE);
  assert.equal(h.wire.sessionId(), SESSION);
  // Session events retain the previous ID before updating it, so the panel can transfer state across /clear.

  assert.deepEqual(
    h.events.filter((e) => e.kind === 'session'),
    [{ kind: 'session', sessionId: SESSION, previous: 'a7b1c0de-0000-4000-8000-000000000000' }],
  );
});

test('a permission ask is read, held, and allowed with the input it arrived with', () => {
  const h = harness();
  h.wire.receive(PERMISSION_ASK);
  const event = h.events.find((e) => e.kind === 'ask') as { kind: 'ask'; ask: Ask };
  assert.equal(event.ask.kind, 'permission');
  if (event.ask.kind !== 'permission') return;
  assert.equal(event.ask.toolName, 'Bash');
  assert.equal(event.ask.description, 'Run permission test echo command');
  assert.equal(h.wire.pendingAsks().length, 1);

  assert.equal(h.wire.answer(event.ask.id, { decision: 'allow' }), true);
  const reply = h.parsed()[0];
  assert.equal(reply.type, 'control_response');
  assert.equal(reply.response.subtype, 'success');
  assert.equal(reply.response.request_id, '19e88315-ef2e-49ad-a093-34f654a299f4');
  assert.equal(reply.response.response.behavior, 'allow');
  assert.deepEqual(reply.response.response.updatedInput, {
    command: 'echo probe-permission-test',
    description: 'Run permission test echo command',
  });
  assert.equal(h.wire.pendingAsks().length, 0);
});

test('a denial sends the reason, which is the text the model is shown', () => {
  const h = harness();
  h.wire.receive(PERMISSION_ASK);
  h.wire.answer('19e88315-ef2e-49ad-a093-34f654a299f4', { decision: 'deny', reason: 'not in this folder' });
  const reply = h.parsed()[0];
  assert.deepEqual(reply.response.response, { behavior: 'deny', message: 'not in this folder' });
});

test('AskUserQuestion arrives as a permission ask and is read as a question', () => {
  const h = harness();
  h.wire.receive(QUESTION_ASK);
  const event = h.events.find((e) => e.kind === 'ask') as { kind: 'ask'; ask: Ask };
  assert.equal(event.ask.kind, 'question');
  if (event.ask.kind !== 'question') return;
  assert.equal(event.ask.questions.length, 1);
  assert.equal(event.ask.questions[0].question, 'Which colour do you prefer?');
  assert.equal(event.ask.questions[0].header, 'Colour');
  assert.deepEqual(
    event.ask.questions[0].options.map((o) => o.label),
    ['Red', 'Blue'],
  );
  assert.equal(event.ask.questions[0].multiSelect, false);
  assert.equal(event.ask.questions[0].secret, false, 'Claude asks for no secret answer');
});

test('an answered question keeps the rest of the input and adds the answers map', () => {
  const h = harness();
  h.wire.receive(QUESTION_ASK);
  h.wire.answer('e923a63c-936d-4220-8fd3-ca1e295ab09e', {
    decision: 'answer',
    answers: { 'Which colour do you prefer?': { labels: ['Red'], written: '' } },
  });
  const reply = h.parsed()[0];
  assert.equal(reply.response.response.behavior, 'allow');
  const updated = reply.response.response.updatedInput;
  assert.deepEqual(updated.answers, { 'Which colour do you prefer?': 'Red' });
  assert.equal(updated.questions[0].question, 'Which colour do you prefer?', 'the questions ride back unchanged');
});

test('a question Claude asks is keyed by its own text, which is what it answers by', () => {
  const h = harness();
  h.wire.receive(QUESTION_ASK);
  const event = h.events.find((e) => e.kind === 'ask') as { kind: 'ask'; ask: Ask };
  assert.equal(event.ask.kind === 'question' && event.ask.questions[0].id, 'Which colour do you prefer?');
});

test('several picks on one question reach Claude as the one string its tool reads', () => {
  const h = harness();
  h.wire.receive(QUESTION_ASK);
  h.wire.answer('e923a63c-936d-4220-8fd3-ca1e295ab09e', {
    decision: 'answer',
    answers: { 'Which colour do you prefer?': { labels: ['Red', 'Blue'], written: '' } },
  });
  assert.equal(h.parsed()[0].response.response.updatedInput.answers['Which colour do you prefer?'], 'Red, Blue');
});

test('an answer the reader wrote themselves reaches Claude in that same string', () => {
  const h = harness();
  h.wire.receive(QUESTION_ASK);
  h.wire.answer('e923a63c-936d-4220-8fd3-ca1e295ab09e', {
    decision: 'answer',
    answers: { 'Which colour do you prefer?': { labels: [], written: 'sea green' } },
  });
  assert.equal(h.parsed()[0].response.response.updatedInput.answers['Which colour do you prefer?'], 'sea green');
});

test('a prompt sent after the child has gone is reported, not written into a dead pipe', () => {
  const h = harness();
  h.wire.close('the agent stopped');
  assert.throws(() => h.wire.prompt('hello'), /no longer running/);
  assert.deepEqual(h.sent, []);
});

test('answering an ask that is not pending is reported rather than written to the wire', () => {
  const h = harness();
  assert.equal(h.wire.answer('nobody', { decision: 'allow' }), false);
  assert.deepEqual(h.sent, []);
});

test('an interrupted turn is not reported as a failure', () => {
  const h = harness();
  h.wire.receive(INTERRUPTED_RESULT);
  // A Stop while a tool runs ends with aborted_tools.
  h.wire.receive(INTERRUPTED_RESULT.replace('aborted_streaming', 'aborted_tools'));
  const ends = h.events.filter((e) => e.kind === 'turnEnd') as { kind: 'turnEnd'; outcome: TurnOutcome }[];
  assert.deepEqual(
    ends.map((end) => end.outcome.status),
    ['interrupted', 'interrupted'],
  );
});

test('a turn that really failed is, and a plain turn carries its cost and text', () => {
  const h = harness();
  h.wire.receive(OK_RESULT);
  h.wire.receive(JSON.stringify({ type: 'result', is_error: true, terminal_reason: 'error', result: 'boom' }));
  const ends = h.events.filter((e) => e.kind === 'turnEnd') as { kind: 'turnEnd'; outcome: TurnOutcome }[];
  assert.equal(ends[0].outcome.status, 'ok');
  assert.equal(ends[0].outcome.text, 'Done.');
  assert.equal(ends[0].outcome.costUsd, 0.0346453);
  assert.equal(ends[1].outcome.status, 'error');
});

test('a turn reports the tools the reader refused', () => {
  const h = harness();
  h.wire.receive(DENIED_RESULT);
  const end = h.events.find((e) => e.kind === 'turnEnd') as { kind: 'turnEnd'; outcome: TurnOutcome };
  assert.deepEqual(end.outcome.deniedTools, ['Bash']);
});

test('assistant replies and tool activity are reported apart', () => {
  const h = harness();
  h.wire.receive(TEXT_LINE);
  h.wire.receive(TOOL_USE_LINE);
  assert.deepEqual(
    h.events.filter((e) => e.kind === 'text'),
    [{ kind: 'text', text: 'Done.' }],
  );
  const tool = h.events.find((e) => e.kind === 'activity');
  assert.ok(tool && tool.kind === 'activity');
  assert.deepEqual(tool.activity, {
    sourceId: 'toolu_01HJEtR8ihqs1hm6P4Ne9SHK',
    kind: 'tool',
    name: 'Bash',
    headline: 'Run permission test echo command',
    detail: 'echo probe-permission-test',
    status: 'running',
  });
});

test('text before a tool call is completed commentary with the message id', () => {
  const h = harness();
  h.wire.receive(
    JSON.stringify({
      type: 'assistant',
      session_id: SESSION,
      message: {
        id: 'msg_commentary_1',
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'I am checking the focused test now.' },
          {
            type: 'tool_use',
            id: 'toolu_bash_1',
            name: 'Bash',
            input: { command: 'npm test -- focused', description: 'Run the focused test' },
          },
        ],
      },
    }),
  );
  assert.deepEqual(
    h.events.filter((e) => e.kind === 'activity').map((e) => (e.kind === 'activity' ? e.activity : null)),
    [
      {
        sourceId: 'msg_commentary_1:text:0',
        kind: 'commentary',
        name: 'Update',
        headline: 'Worked',
        detail: 'I am checking the focused test now.',
        status: 'done',
      },
      {
        sourceId: 'toolu_bash_1',
        kind: 'tool',
        name: 'Bash',
        headline: 'Run the focused test',
        detail: 'npm test -- focused',
        status: 'running',
      },
    ],
  );
  assert.deepEqual(
    h.events.filter((e) => e.kind === 'text'),
    [],
  );
});

test('separate commentary records sharing one message id keep separate activity rows', () => {
  const h = harness();
  const line = (text: string) =>
    JSON.stringify({
      type: 'assistant',
      session_id: SESSION,
      message: {
        id: 'msg_split',
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [{ type: 'text', text }],
      },
    });
  h.wire.receive(line('Checking the parser.'));
  h.wire.receive(line('Running its focused test.'));
  assert.deepEqual(
    h.events
      .filter((event) => event.kind === 'activity')
      .map((event) => (event.kind === 'activity' ? [event.activity.sourceId, event.activity.detail] : null)),
    [
      ['msg_split:text:0', 'Checking the parser.'],
      ['msg_split:text:1', 'Running its focused test.'],
    ],
  );
});

test('split streamed text becomes commentary when the message continues into a tool call', () => {
  const h = harness();
  h.wire.receive(
    JSON.stringify({
      type: 'assistant',
      session_id: SESSION,
      message: {
        id: 'msg_streamed_tool',
        role: 'assistant',
        content: [{ type: 'text', text: 'Checking the captured protocol shape.' }],
      },
    }),
  );
  h.wire.receive(
    JSON.stringify({
      type: 'assistant',
      session_id: SESSION,
      message: {
        id: 'msg_streamed_tool',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool_streamed', name: 'Bash', input: { command: 'npm test' } }],
      },
    }),
  );
  h.wire.receive(
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    }),
  );
  assert.deepEqual(
    h.events.filter((event) => event.kind === 'text'),
    [],
  );
  assert.deepEqual(
    h.events
      .filter((event) => event.kind === 'activity')
      .map((event) =>
        event.kind === 'activity' ? [event.activity.sourceId, event.activity.kind, event.activity.detail] : null,
      ),
    [
      ['msg_streamed_tool:text:0', 'commentary', 'Checking the captured protocol shape.'],
      ['tool_streamed', 'tool', 'npm test'],
    ],
  );
});

test('live tools retain the useful Skill and subagent names', () => {
  const h = harness();
  h.wire.receive(
    JSON.stringify({
      type: 'assistant',
      session_id: SESSION,
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'skill-one', name: 'Skill', input: { skill: 'summarize' } },
          { type: 'tool_use', id: 'task-one', name: 'Task', input: { task_name: 'review_parser' } },
        ],
      },
    }),
  );
  assert.deepEqual(
    h.events
      .filter((event) => event.kind === 'activity')
      .map((event) => (event.kind === 'activity' ? event.activity.detail : null)),
    ['summarize', 'review_parser'],
  );
});

test('live tools use the shared subject rules and leave questions to their ask card', () => {
  const h = harness();
  h.wire.receive(
    JSON.stringify({
      type: 'assistant',
      session_id: SESSION,
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'search-one', name: 'WebSearch', input: { query: 'activity details' } },
          {
            type: 'tool_use',
            id: 'message-one',
            name: 'SendMessage',
            input: { recipient: 'reviewer', message: 'Review it' },
          },
          {
            type: 'tool_use',
            id: 'question-one',
            name: 'AskUserQuestion',
            input: { questions: [{ question: 'Which option?' }] },
          },
        ],
      },
    }),
  );
  assert.deepEqual(
    h.events
      .filter((event) => event.kind === 'activity')
      .map((event) => (event.kind === 'activity' ? [event.activity.name, event.activity.detail] : null)),
    [
      ['WebSearch', 'activity details'],
      ['SendMessage', 'reviewer'],
    ],
  );
});

test('the rate-limit share the CLI volunteers is passed on as it arrived', () => {
  const h = harness();
  h.wire.receive(RATE_LINE);
  const limit = h.events.find((e) => e.kind === 'rateLimit') as {
    kind: 'rateLimit';
    limit: RateLimit;
    creditResetsAtSeconds: number | null;
  };
  assert.deepEqual(limit.limit, {
    window: 'seven_day',
    utilization: 0.91,
    resetsAtSeconds: 1787929200,
    status: 'allowed_warning',
    // The event names a window and nothing else, so the clock comes from the name and the
    // limit covers every model.
    group: 'weekly',
    scope: '',
  });
  assert.equal(limit.creditResetsAtSeconds, 1790812800);
});

test('a rate-limit event carries the credit clock without a utilization', () => {
  const h = harness();
  h.wire.receive(
    JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { overageResetsAt: 1790812800 },
    }),
  );
  assert.deepEqual(h.events, [{ kind: 'rateLimit', limit: null, creditResetsAtSeconds: 1790812800 }]);
});

test('the unified window set supplies every live reset without duplicating the active window', () => {
  const h = harness();
  h.wire.receive(UNIFIED_RATE_LINE);
  const limits = h.events.flatMap((e) => (e.kind === 'rateLimit' && e.limit !== null ? [e.limit] : []));
  assert.deepEqual(limits, [
    {
      window: 'five_hour',
      utilization: 0.63,
      resetsAtSeconds: 1787929200,
      status: '',
      group: 'session',
      scope: '',
    },
    {
      window: 'seven_day',
      utilization: 0.41,
      resetsAtSeconds: 1788361200,
      status: '',
      group: 'weekly',
      scope: '',
    },
    {
      window: 'seven_day_overage_included',
      utilization: 0.12,
      resetsAtSeconds: 1788361200,
      status: '',
      group: 'weekly-overage',
      scope: '',
    },
  ]);
});

test('an empty unified window set falls back to the older single-window fields', () => {
  const h = harness();
  h.wire.receive(
    JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: {
        rateLimitType: 'five_hour',
        utilization: 0.2,
        resetsAt: 1787929200,
        status: 'allowed',
        unifiedWindows: { five_hour: null, seven_day: null },
      },
    }),
  );
  const limits = h.events.flatMap((e) => (e.kind === 'rateLimit' && e.limit !== null ? [e.limit] : []));
  assert.deepEqual(limits, [
    {
      window: 'five_hour',
      utilization: 0.2,
      resetsAtSeconds: 1787929200,
      status: 'allowed',
      group: 'session',
      scope: '',
    },
  ]);
});

test('a window the volunteered event names is put on the clock that name means', () => {
  const h = harness();
  h.wire.receive(
    JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { rateLimitType: 'five_hour', utilization: 0.2, resetsAt: 1787929200, status: 'allowed' },
    }),
  );
  h.wire.receive(
    JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { rateLimitType: 'moonlit_kestrel', utilization: 0.2, resetsAt: 1787929200, status: 'allowed' },
    }),
  );
  const groups = h.events.flatMap((e) => (e.kind === 'rateLimit' && e.limit !== null ? [e.limit.group] : []));
  // A window nobody named a clock for is left ungrouped rather than filed under one of the
  // two, which would sit it beside figures it does not share a period with.
  assert.deepEqual(groups, ['session', '']);
});

test('a prompt goes out as one user message line', async () => {
  const h = harness();
  await h.wire.prompt('hello');
  assert.equal(h.sent[0].endsWith('\n'), true, 'the framing belongs to the wire, not the caller');
  assert.deepEqual(h.parsed()[0], {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    origin: { kind: 'human' },
  });
});

// A rename_session success settles on the control channel without requiring a result event.

function renameAnswer(error?: string): string {
  return JSON.stringify({
    type: 'control_response',
    response: error
      ? { subtype: 'error', request_id: 'arc_1', error }
      : { subtype: 'success', request_id: 'arc_1', response: {} },
  });
}

test('a rename goes out as one rename_session control request, named for the host and the session', async () => {
  const h = harness(undefined, SESSION);
  const renamed = h.wire.renameSession(SESSION, 'Complete name');
  assert.deepEqual(
    h.parsed(),
    [
      {
        type: 'control_request',
        request_id: 'arc_1',
        request: { subtype: 'rename_session', title: 'Complete name', source: 'host', session_id: SESSION },
      },
    ],
    'the rename did not go out as the control request the CLI answers out of band',
  );
  h.wire.receive(renameAnswer());
  await renamed;
  assert.deepEqual(h.events, [], 'the rename reached the timeline');
});

test('a rename carries the session id the caller resolved, not the one the wire holds', async () => {
  const h = harness(undefined, SESSION);
  // The CLI compares this id against the session its process is in, which is the check that
  // catches a child that moved to another session after the caller resolved one.
  const renamed = h.wire.renameSession('9e0c0f1a-0000-4000-8000-000000000000', 'Complete name');
  assert.equal(
    (h.parsed()[0].request as { session_id?: string }).session_id,
    '9e0c0f1a-0000-4000-8000-000000000000',
    "the rename carried the wire's own session id, so the CLI compares it against itself",
  );
  h.wire.receive(
    JSON.stringify({
      type: 'control_response',
      response: { subtype: 'error', request_id: 'arc_1', error: 'session_id is not the current session' },
    }),
  );
  await assert.rejects(renamed, /not the current session/);
});

test('a control answer settles the request its id names, and a late one settles nothing', async () => {
  const h = harness(1, SESSION);
  const renamed = h.wire.renameSession(SESSION, 'Complete name');
  const sent = h.parsed()[0].request_id as string;
  // An answer that names another request leaves this one waiting for its own.
  h.wire.receive(
    JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: `${sent}9`, response: {} },
    }),
  );
  await assert.rejects(waitForDeadline(renamed), /did not answer/);
  // The CLI's own answer arrives after the deadline. The request it names is gone, so it
  // settles nothing and the wire keeps working.
  h.wire.receive(renameAnswer());
  await h.wire.prompt('next');
  assert.deepEqual(
    h.events.filter((event) => event.kind !== 'native'),
    [],
    'a control answer reached the timeline',
  );
});

test('an empty name sends nothing', async () => {
  const h = harness(undefined, SESSION);
  for (const title of ['', '   ', '\u200b\n']) {
    await assert.rejects(h.wire.renameSession(SESSION, title), /Enter a name/);
  }
  assert.deepEqual(h.sent, [], 'a name with nothing visible reached the agent');
});

test('a turn runs on through a waiting rename, and a prompt and an effort change still go out', async () => {
  const h = harness(undefined, SESSION);
  const renamed = h.wire.renameSession(SESSION, 'Complete name');
  h.wire.receive(
    JSON.stringify({
      type: 'assistant',
      session_id: SESSION,
      message: {
        model: 'claude-opus-4-1',
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'answered' }],
      },
    }),
  );
  h.wire.receive(
    JSON.stringify({
      type: 'stream_event',
      session_id: SESSION,
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'part' } },
    }),
  );
  h.wire.receive(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      terminal_reason: 'completed',
      result: 'done',
    }),
  );
  assert.deepEqual(
    h.events.map((event) => event.kind),
    ['text', 'delta', 'turnEnd'],
    'a waiting rename swallowed the turn the reader was watching',
  );
  await h.wire.prompt('next');
  await h.wire.effortCommand('low');
  h.wire.receive(renameAnswer());
  await renamed;
});

test('a refused rename leaves the wire open, and a closed child fails its rename', async () => {
  const h = harness(undefined, SESSION);
  const refused = h.wire.renameSession(SESSION, 'Complete name');
  h.wire.receive(renameAnswer('title must be non-empty'));
  await assert.rejects(refused, /title must be non-empty/);
  await h.wire.prompt('next');
  const closed = harness();
  const renaming = closed.wire.renameSession(SESSION, 'Complete name');
  closed.wire.close('child closed');
  await assert.rejects(renaming, /child closed/);
});

test('a rename with no answer within the deadline fails and leaves the session running', async () => {
  const h = harness(1, SESSION);
  await assert.rejects(waitForDeadline(h.wire.renameSession(SESSION, 'Complete name')), /did not answer/);
  h.wire.receive(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      terminal_reason: 'completed',
      result: 'done',
    }),
  );
  assert.deepEqual(
    h.events.map((event) => event.kind),
    ['turnEnd'],
    'a rename deadline took the turn with it',
  );
  await h.wire.prompt('next');
});

test('a request the wire could not send leaves no deadline timer behind', async () => {
  vi.useFakeTimers();
  try {
    const wire = new ClaudeWire({
      send: () => {
        throw new Error('the pipe closed');
      },
      emit: () => undefined,
      sessionId: SESSION,
    });
    await assert.rejects(wire.renameSession(SESSION, 'Complete name'), /the pipe closed/);
    // Nothing will answer a request that never left, so its clock has nothing to wait for.
    assert.equal(vi.getTimerCount(), 0, 'a request that never left kept its deadline timer running');
  } finally {
    vi.useRealTimers();
  }
});

test('a line the child wrote before it exited still arrives after the wire closed', () => {
  const h = harness(undefined, SESSION);
  h.wire.close('the agent exited');
  h.wire.receive(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      terminal_reason: 'completed',
      result: 'done',
    }),
  );
  assert.deepEqual(
    h.events.map((event) => event.kind),
    ['turnEnd'],
    'a final result read after exit was dropped',
  );
});

test('an effort change goes out as one command line, typed by a person', async () => {
  const h = harness();
  await h.wire.effortCommand('low');
  assert.equal(h.sent.length, 1, 'a level change costs the child one line and no control request');
  assert.deepEqual(h.parsed()[0], {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '/effort low' }] },
    origin: { kind: 'human' },
  });
  await assert.rejects(
    h.wire.effortCommand(''),
    /needs a level to set/,
    'a bare `/effort` costs a turn and asks the CLI for a level the reader already picked',
  );
  assert.equal(h.sent.length, 1);
  h.wire.close('done');
  await assert.rejects(
    h.wire.effortCommand('high'),
    /no longer running/,
    'a level change written into a dead pipe would leave the control showing a level nothing applied',
  );
});

test('a prompt with an attachment is marked as typed by a person too', async () => {
  const h = harness(undefined, undefined, async () => Buffer.from('hello'));
  await h.wire.prompt({
    text: 'inspect this',
    assets: [
      {
        id: 'id',
        name: 'notes.txt',
        mime: 'text/plain',
        size: 5,
        digest: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        path: 'C:\\staged\\notes.txt',
      },
    ],
  });
  const written = h.parsed().find((message) => message.type === 'user');
  assert.deepEqual(
    written?.origin,
    { kind: 'human' },
    'the transcript of a session sent an attachment prompt reads as a print-mode run',
  );
});

test('Stop cancels an attachment prompt whose file is still being prepared', async () => {
  let finishRead: ((bytes: Uint8Array) => void) | undefined;
  const reading = new Promise<Uint8Array>((resolve) => {
    finishRead = resolve;
  });
  const h = harness(undefined, undefined, () => reading);
  const prompt = h.wire.prompt({
    text: 'inspect this',
    assets: [
      {
        id: 'id',
        name: 'notes.txt',
        mime: 'text/plain',
        size: 5,
        digest: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        path: 'C:\\staged\\notes.txt',
      },
    ],
  });

  const stopping = h.wire.interrupt(true);
  const interrupt = h.parsed()[0];
  assert.deepEqual(interrupt.request, { subtype: 'interrupt', cancel_queued: true });
  h.wire.receive(
    JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: interrupt.request_id, response: {} },
    }),
  );
  await stopping;
  finishRead?.(Buffer.from('hello'));
  await assert.rejects(prompt, /stopped before it reached the agent/);
  assert.equal(
    h.parsed().some((message) => message.type === 'user'),
    false,
    'the attachment prompt was written after Stop returned',
  );
});

test('Claude prompt content frames supported files and rejects other binaries', async () => {
  const bytes = async () => Buffer.from('hello');
  const asset = (name: string, mime: string) => ({
    id: 'id',
    name,
    mime,
    size: 5,
    digest: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    path: `C:\\staged\\${name}`,
  });
  assert.deepEqual(
    await claudePromptContent(
      {
        text: 'inspect these',
        assets: [
          asset('photo.png', 'image/png'),
          asset('notes.md', 'text/markdown'),
          asset('paper.pdf', 'application/pdf'),
        ],
      },
      bytes,
    ),
    [
      { type: 'text', text: 'inspect these' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
      { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'hello' }, title: 'notes.md' },
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: 'aGVsbG8=' },
        title: 'paper.pdf',
      },
    ],
  );
  await assert.rejects(
    claudePromptContent({ text: '', assets: [asset('archive.zip', 'application/zip')] }, bytes),
    /not a supported Claude attachment/,
  );
  await assert.rejects(
    claudePromptContent({ text: '', assets: [asset('unknown-image.avif', 'image/avif')] }, bytes),
    /not a supported Claude attachment/,
    'the send-time framing must ask the same shared support rule as attachment staging',
  );
  await assert.rejects(
    claudePromptContent({ text: '', assets: [asset('notes.txt', 'text/plain')] }, async () => Buffer.from('other')),
    /does not match/,
    'the bytes Claude encodes must still match the staged digest',
  );
});

test('a control request the panel cannot answer is refused, not left hanging', () => {
  const h = harness();
  h.wire.receive(
    JSON.stringify({
      type: 'control_request',
      request_id: 'x1',
      request: { subtype: 'oauth_token_refresh' },
    }),
  );
  const reply = h.parsed()[0];
  assert.equal(reply.response.subtype, 'error');
  assert.equal(reply.response.request_id, 'x1');
});

test('a dialog the panel never declared is left alone, because answering one is an error', () => {
  const h = harness();
  h.wire.receive(
    JSON.stringify({
      type: 'control_request',
      request_id: 'x2',
      request: { subtype: 'request_user_dialog', dialog_kind: 'refusal_fallback_prompt', payload: {} },
    }),
  );
  assert.deepEqual(h.sent, []);
});

test('an unreadable line is reported and the next one is still read', () => {
  const h = harness();
  h.wire.receive('not json at all');
  h.wire.receive(TEXT_LINE);
  assert.equal(h.events[0].kind, 'error');
  assert.equal(h.events[1].kind, 'session');
  assert.equal(h.events[2].kind, 'text');
});

test('closing the wire settles everyone waiting instead of leaving them hung', async () => {
  const h = harness();
  const pending = h.wire.usage();
  h.wire.close('the agent stopped');
  await assert.rejects(pending, /the agent stopped/);
});

test('interrupt and usage go out on the control channel with their own ids', async () => {
  const h = harness();
  void h.wire.interrupt(true);
  void h.wire.usage();
  const [interrupt, usage] = h.parsed();
  assert.deepEqual(interrupt.request, { subtype: 'interrupt', cancel_queued: true });
  assert.deepEqual(usage.request, { subtype: 'get_usage' });
  assert.notEqual(interrupt.request_id, usage.request_id);
});

// The named-window usage response supplies whole-number utilization and ISO reset timestamps. It omits the explicit limits array.

const USAGE_ANSWER = {
  session: { total_cost_usd: 0.0908, total_api_duration_ms: 3745 },
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 24, resets_at: '2026-08-28T08:59:59.500Z' },
    seven_day: { utilization: 93, resets_at: '2026-09-01T09:00:00.000Z' },
  },
};

test('a usage answer that names its windows one by one still reaches the panel', () => {
  const reading = readUsage(USAGE_ANSWER, 1_700_000_000_000);
  assert.ok(reading);
  assert.equal(reading.plan, 'max');
  assert.equal(reading.complete, true);
  assert.equal(reading.readAt, 1_700_000_000_000);
  assert.deepEqual(reading.limits, [
    // Normalize utilization to a fraction and derive each clock group from its window name.

    { window: 'five_hour', utilization: 0.24, resetsAtSeconds: 1787907600, status: '', group: 'session', scope: '' },
    { window: 'seven_day', utilization: 0.93, resetsAtSeconds: 1788253200, status: '', group: 'weekly', scope: '' },
  ]);
});

test('the two sources of one figure agree once the wire has read them', () => {
  // Usage responses report 91 for 91 percent. Rate-limit events report the equivalent fraction, 0.91.

  const asked = readUsage(
    { subscription_type: 'max', rate_limits_available: true, rate_limits: { seven_day: { utilization: 91 } } },
    1,
  );
  const h = harness();
  h.wire.receive(RATE_LINE);
  const volunteered = h.events.find((e) => e.kind === 'rateLimit') as { kind: 'rateLimit'; limit: RateLimit };
  assert.equal(asked?.limits[0].utilization, volunteered.limit.utilization);
});

test('an explicit unavailable Claude answer differs from malformed and missing usage', () => {
  assert.equal(readUsageResult({ rate_limits_available: false }, 9), 'unavailable');
  for (const payload of [null, 'not an object', {}, { rate_limits_available: 'false' }]) {
    assert.equal(readUsageResult(payload, 9), null);
  }
  assert.deepEqual(readUsageResult(USAGE_ANSWER, 9), readUsage(USAGE_ANSWER, 9));
});

test('an account the CLI reports no limits for gets no row of noughts', () => {
  // Not the same thing as an account at zero, and a strip drawn from it would tell the
  // reader they have their whole allowance left.
  assert.equal(readUsage({ subscription_type: 'max', rate_limits_available: false, rate_limits: {} }, 1), null);
  assert.equal(readUsage({ subscription_type: 'max' }, 1), null);
  assert.equal(readUsage(null, 1), null);
  assert.equal(readUsage('not an object', 1), null);
});

const ENTERPRISE_USAGE_ANSWER = {
  subscription_type: 'enterprise',
  rate_limits_available: true,
  rate_limits: {
    five_hour: null,
    seven_day: null,
    seven_day_opus: null,
    nimbus_quill: { utilization: 0, resets_at: null },
    limits: [],
    extra_usage: {
      is_enabled: true,
      monthly_limit: 200000,
      used_credits: 187519,
      utilization: 93.7595,
      currency: 'USD',
      decimal_places: 2,
      disabled_reason: null,
      user_disabled: false,
      spend_limit_reached: false,
      credits_ever_enabled: true,
      daily: null,
      weekly: null,
    },
    spend: {
      used: { amount_minor: 187519, currency: 'USD', exponent: 2 },
      limit: { amount_minor: 200000, currency: 'USD', exponent: 2 },
      percent: 94,
      severity: 'critical',
      enabled: true,
      disabled_reason: null,
      cap: { money: null, credits: { amount_minor: 200000, exponent: 2 } },
      balance: null,
      auto_reload: null,
      can_purchase_credits: false,
      can_toggle: false,
    },
  },
};

test('an enterprise credit cap is a reading even when every rate window is empty', () => {
  const reading = readUsage(ENTERPRISE_USAGE_ANSWER, 1_700_000_000_000);
  assert.deepEqual(reading, {
    plan: 'enterprise',
    limits: [],
    complete: true,
    spend: {
      usedMinor: 187519,
      limitMinor: 200000,
      exponent: 2,
      currency: 'USD',
      utilization: 187519 / 200000,
    },
    creditResetsAtSeconds: null,
    readAt: 1_700_000_000_000,
  });
});

test('a credit cap switched off is not drawn', () => {
  const rate_limits = ENTERPRISE_USAGE_ANSWER.rate_limits;
  const reading = readUsage(
    {
      ...ENTERPRISE_USAGE_ANSWER,
      rate_limits: {
        ...rate_limits,
        spend: { ...rate_limits.spend, enabled: false },
      },
    },
    1,
  );
  assert.deepEqual(reading?.limits, []);
  assert.equal(reading?.spend, null);
});

test('a credit cap with a disabled reason is not drawn', () => {
  const rate_limits = ENTERPRISE_USAGE_ANSWER.rate_limits;
  const reading = readUsage(
    {
      ...ENTERPRISE_USAGE_ANSWER,
      rate_limits: {
        ...rate_limits,
        spend: { ...rate_limits.spend, disabled_reason: 'not available' },
      },
    },
    1,
  );
  assert.deepEqual(reading?.limits, []);
  assert.equal(reading?.spend, null);
});

test('a zero credit cap is not divided into a figure', () => {
  const rate_limits = ENTERPRISE_USAGE_ANSWER.rate_limits;
  const reading = readUsage(
    {
      ...ENTERPRISE_USAGE_ANSWER,
      rate_limits: {
        ...rate_limits,
        spend: {
          ...rate_limits.spend,
          limit: { ...rate_limits.spend.limit, amount_minor: 0 },
        },
      },
    },
    1,
  );
  assert.deepEqual(reading?.limits, []);
  assert.equal(reading?.spend, null);
});

test('rate windows and a credit cap are both kept when the account reports both', () => {
  const rate_limits = ENTERPRISE_USAGE_ANSWER.rate_limits;
  const reading = readUsage(
    {
      ...ENTERPRISE_USAGE_ANSWER,
      rate_limits: {
        ...rate_limits,
        five_hour: { utilization: 24, resets_at: '2026-08-28T08:59:59.500Z' },
      },
    },
    1,
  );
  assert.deepEqual(
    reading?.limits.map((limit) => limit.window),
    ['five_hour'],
  );
  assert.equal(reading?.spend?.usedMinor, 187519);
});

test('a window with an unreadable reset time keeps its figure and loses only the time', () => {
  // A reset the panel invented would say the limit rolls over at a moment nobody reported.
  const reading = readUsage(
    { rate_limits_available: true, rate_limits: { five_hour: { utilization: 24, resets_at: 'whenever' } } },
    1,
  );
  assert.equal(reading?.limits[0].utilization, 0.24);
  assert.equal(reading?.limits[0].resetsAtSeconds, null);
  // And a window with no share at all is dropped rather than drawn as empty.
  const empty = readUsage({ rate_limits_available: true, rate_limits: { five_hour: {} } }, 1);
  assert.deepEqual(empty?.limits, []);
  assert.equal(empty?.spend, null);
});

// This usage fixture combines named windows, an explicit limits array, model scope, and null unsupported windows.

const USAGE_ANSWER_WITH_LIMITS = {
  session: { total_cost_usd: 0.0908 },
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 24, resets_at: '2026-08-28T08:59:59.500Z' },
    seven_day: { utilization: 93, resets_at: '2026-09-01T09:00:00.000Z' },
    limits: [
      {
        kind: 'session',
        group: 'session',
        percent: 10,
        severity: 'normal',
        resets_at: '2026-08-29T00:00:00.2+00:00',
        scope: null,
        is_active: true,
      },
      {
        kind: 'weekly_all',
        group: 'weekly',
        percent: 7,
        severity: 'normal',
        resets_at: '2026-09-04T15:00:00.2+00:00',
        scope: null,
        is_active: false,
      },
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: 2,
        severity: 'normal',
        resets_at: '2026-09-04T15:00:00.2+00:00',
        scope: { model: { id: null, display_name: 'Fable' }, surface: null },
        is_active: false,
      },
    ],
    seven_day_opus: null,
    nimbus_quill: null,
    tangelo: null,
    iguana_necktie: null,
  },
};

test('a usage answer that lists its limits is read from the list, clock and model and all', () => {
  const reading = readUsage(USAGE_ANSWER_WITH_LIMITS, 1_700_000_000_000);
  assert.ok(reading);
  assert.equal(reading.plan, 'max');
  assert.deepEqual(reading.limits, [
    { window: 'session', utilization: 0.1, resetsAtSeconds: 1787961600, status: '', group: 'session', scope: '' },
    { window: 'weekly_all', utilization: 0.07, resetsAtSeconds: 1788534000, status: '', group: 'weekly', scope: '' },
    // Two weekly limits share a clock and differ by the model they cover, which is the only
    // thing that tells them apart on screen.
    {
      window: 'weekly_scoped',
      utilization: 0.02,
      resetsAtSeconds: 1788534000,
      status: '',
      group: 'weekly',
      scope: 'Fable',
    },
  ]);
});

test('a limit under a codename is not drawn, however much it looks like a real one', () => {
  // Only supported named windows or explicit list entries become limits. Other response keys must not add rows.

  const codenamed = {
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 24, resets_at: '2026-08-28T08:59:59.500Z' },
      limits: [
        {
          kind: 'session',
          group: 'session',
          percent: 10,
          resets_at: '2026-08-29T00:00:00.2+00:00',
          scope: null,
        },
      ],
      nimbus_quill: { utilization: 62, resets_at: '2026-09-01T09:00:00.000Z' },
      iguana_necktie: { utilization: 5, resets_at: '2026-09-01T09:00:00.000Z' },
    },
  };
  assert.deepEqual(
    readUsage(codenamed, 1)?.limits.map((l) => l.window),
    ['session'],
  );

  // And the fallback names the two windows it accepts rather than walking the object, so a
  // payload with no list of its own does not let a codename through either.
  const noList = {
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 24, resets_at: '2026-08-28T08:59:59.500Z' },
      seven_day: { utilization: 93, resets_at: '2026-09-01T09:00:00.000Z' },
      tangelo: { utilization: 62, resets_at: '2026-09-01T09:00:00.000Z' },
    },
  };
  assert.deepEqual(
    readUsage(noList, 1)?.limits.map((l) => l.window),
    ['five_hour', 'seven_day'],
  );
});

test('a listed limit with no share is dropped, and a list of nothing usable falls back', () => {
  const reading = readUsage(
    {
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 24 },
        limits: [
          { kind: 'session', group: 'session' },
          { group: 'weekly', percent: 7 },
        ],
      },
    },
    1,
  );
  // Neither entry can be drawn: one has no share and the other no name. The window the CLI
  // names is still there, which is a figure the reader can act on.
  assert.deepEqual(
    reading?.limits.map((l) => l.window),
    ['five_hour'],
  );
});

// A list_models fixture includes the default model and its resolved model ID.
const MODEL_ANSWER = {
  models: [
    {
      value: 'default',
      resolvedModel: 'claude-opus-5[1m]',
      displayName: 'Default (recommended)',
      description: 'Opus 5 with 1M context - Best for everyday, complex tasks',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      supportsAdaptiveThinking: true,
      supportsFastMode: true,
      supportsAutoMode: true,
    },
  ],
};

test('the model list arrives in the words the CLI uses for its own models', () => {
  const list = readModels(MODEL_ANSWER, 1_700_000_000_000);
  assert.ok(list);
  assert.equal(list.readAt, 1_700_000_000_000);
  assert.equal(list.models.length, 1);
  assert.equal(list.models[0].value, 'default');
  assert.equal(list.models[0].resolvedModel, 'claude-opus-5[1m]');
  assert.equal(list.models[0].label, 'Default (recommended)');
  assert.match(list.models[0].description, /1M context/);
});

test('an effort level Claude offers carries its name and no sentence of the panel making', () => {
  const list = readModels(MODEL_ANSWER, 1);
  assert.deepEqual(list?.models[0].efforts, [
    { value: 'low', label: 'low', description: '' },
    { value: 'medium', label: 'medium', description: '' },
    { value: 'high', label: 'high', description: '' },
    { value: 'xhigh', label: 'xhigh', description: '' },
    { value: 'max', label: 'max', description: '' },
  ]);
});

test('a model that takes no effort setting offers none, so the panel draws none', () => {
  const list = readModels(
    {
      models: [{ value: 'sonnet', resolvedModel: '  ', displayName: 'Sonnet', supportedEffortLevels: ['low', 'high'] }],
    },
    1,
  );
  assert.deepEqual(
    list?.models[0].efforts,
    [],
    'a model saying it takes no effort setting still lists levels, and sending one it ignores changes nothing',
  );
  assert.equal(
    'resolvedModel' in list!.models[0],
    false,
    'a missing exact identity was replaced with an empty pricing identity',
  );
});

test('a model with no value to send back is skipped, and a list of those is no list at all', () => {
  const list = readModels({ models: [{ displayName: 'Nameless' }, { value: 'haiku', displayName: 'Haiku' }] }, 1);
  assert.deepEqual(
    list?.models.map((m) => m.value),
    ['haiku'],
  );
  assert.equal(readModels({ models: [{ displayName: 'Nameless' }] }, 1), null);
  assert.equal(readModels({ models: [] }, 1), null);
  assert.equal(readModels(null, 1), null);
});

test('the model list is asked for on the control channel and answered from there', async () => {
  const h = harness();
  const listing = h.wire.listModels();
  assert.deepEqual(h.parsed()[0].request, { subtype: 'list_models' });
  h.wire.receive(
    JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: h.parsed()[0].request_id, response: MODEL_ANSWER },
    }),
  );
  assert.deepEqual(await listing, MODEL_ANSWER);
});

test('a CLI that will not list its models leaves the panel with no list, not an error', async () => {
  // An unavailable model list returns null without raising a turn failure.

  const h = harness();
  const listing = h.wire.listModels();
  h.wire.receive(
    JSON.stringify({
      type: 'control_response',
      response: { subtype: 'error', request_id: h.parsed()[0].request_id, error: 'unknown subtype' },
    }),
  );
  assert.equal(await listing, null);
});

test('a control request nobody answers gives up rather than waiting for ever', async () => {
  // Unanswered control requests expire so later reads can proceed.

  const h = harness(10);
  await assert.rejects(waitForDeadline(h.wire.usage()), /did not answer/);
  // And the wire is still usable: the request that timed out is gone, not left behind to
  // swallow the answer to the next one.
  const again = h.wire.usage();
  h.wire.receive(
    JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: h.parsed()[1].request_id, response: USAGE_ANSWER },
    }),
  );
  assert.deepEqual(await again, USAGE_ANSWER);
});

// The MCP status fixture includes connected, failed, and disabled servers. Failed and disabled entries omit unavailable server metadata and tools.

const MCP_ANSWER = {
  mcpServers: [
    {
      name: 'probeGood',
      status: 'connected',
      scope: 'dynamic',
      serverInfo: { name: 'probe-server', version: '0.0.1' },
      config: { type: 'stdio', command: 'node.exe', args: ['probe-server.js'] },
      tools: [{ name: 'probe_echo', annotations: {} }],
    },
    {
      name: 'probeBad',
      status: 'failed',
      scope: 'dynamic',
      error: 'Connection closed',
      config: { type: 'stdio', command: 'node.exe', args: ['missing-server.js'] },
    },
    { name: 'probeOff', status: 'disabled', scope: 'user' },
  ],
};

test('the MCP servers are asked for on the control channel and answered from there', async () => {
  const h = harness();
  const reading = h.wire.mcpStatus();
  assert.deepEqual(h.parsed()[0].request, { subtype: 'mcp_status' });
  h.wire.receive(
    JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: h.parsed()[0].request_id, response: MCP_ANSWER },
    }),
  );
  assert.deepEqual(
    await reading,
    [
      {
        name: 'probeGood',
        status: 'connected',
        error: '',
        tools: ['probe_echo'],
        scope: 'dynamic',
        title: 'probe-server',
      },
      { name: 'probeBad', status: 'failed', error: 'Connection closed', tools: [], scope: 'dynamic', title: '' },
      { name: 'probeOff', status: 'disabled', error: '', tools: [], scope: 'user', title: '' },
    ],
    'a server that will not start is the one the reader most needs drawn, and it is the one' +
      ' with the least in it: no name of its own, no tools, and a reason where they would be',
  );
});

test('a server with no name is skipped, and a state this panel has no word for is drawn as it arrived', async () => {
  const h = harness();
  const reading = h.wire.mcpStatus();
  h.wire.receive(
    JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: h.parsed()[0].request_id,
        response: { mcpServers: [{ status: 'connected' }, { name: 'probeAuth', status: 'needs-auth' }] },
      },
    }),
  );
  assert.deepEqual(
    await reading,
    [{ name: 'probeAuth', status: 'needs-auth', error: '', tools: [], scope: '', title: '' }],
    'a server with no name cannot be switched or reconnected, so a row for it would be a' +
      ' button that does nothing; a state nobody here has phrasing for is still a state',
  );
});

test('a CLI that will not report its MCP servers leaves the panel with no reading, not an error', async () => {
  // An unavailable MCP status response returns null without raising a turn failure.

  const h = harness();
  const reading = h.wire.mcpStatus();
  h.wire.receive(
    JSON.stringify({
      type: 'control_response',
      response: { subtype: 'error', request_id: h.parsed()[0].request_id, error: 'unknown subtype' },
    }),
  );
  assert.equal(await reading, null);
});

test('a switch names the server under serverName and says which state it is asking for', async () => {
  // mcp_toggle requests use serverName and an explicit enabled value. Both true and false must reach the CLI.

  const h = harness();
  const off = h.wire.mcpToggle('probeGood', false);
  assert.deepEqual(h.parsed()[0].request, { subtype: 'mcp_toggle', serverName: 'probeGood', enabled: false });
  // A successful toggle settles without a response payload.

  h.wire.receive(
    JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: h.parsed()[0].request_id },
    }),
  );
  await off;

  const on = h.wire.mcpToggle('probeGood', true);
  assert.deepEqual(h.parsed()[1].request, { subtype: 'mcp_toggle', serverName: 'probeGood', enabled: true });
  h.wire.receive(
    JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: h.parsed()[1].request_id },
    }),
  );
  await on;
});

test('a reconnect names the server the same way, and answers once the connection is up', async () => {
  const h = harness();
  const retry = h.wire.mcpReconnect('probeBad');
  assert.deepEqual(h.parsed()[0].request, { subtype: 'mcp_reconnect', serverName: 'probeBad' });
  h.wire.receive(
    JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: h.parsed()[0].request_id },
    }),
  );
  await retry;
});

test('a switch or a reconnect that failed says why, because the reader pressed it', async () => {
  // Toggle and reconnect failures reject with the reported error so the reader receives the action result.

  const h = harness();
  const switching = h.wire.mcpToggle('probeBad', true);
  h.wire.receive(
    JSON.stringify({
      type: 'control_response',
      response: { subtype: 'error', request_id: h.parsed()[0].request_id, error: 'Connection closed' },
    }),
  );
  await assert.rejects(switching, /Connection closed/);

  const retry = h.wire.mcpReconnect('probeBad');
  h.wire.receive(
    JSON.stringify({
      type: 'control_response',
      response: { subtype: 'error', request_id: h.parsed()[1].request_id, error: 'Connection closed' },
    }),
  );
  await assert.rejects(retry, /Connection closed/);
});

test('a model list nobody answers is no list, and a late answer changes nothing', async () => {
  const h = harness(10);
  assert.equal(await waitForDeadline(h.wire.listModels()), null, 'a silent child leaves the picker empty, not broken');
  // The answer arrives after the wait ended. It names a request the wire no longer holds,
  // so reading it settles nothing a second time and throws nothing.
  h.wire.receive(
    JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: h.parsed()[0].request_id, response: MODEL_ANSWER },
    }),
  );
});

// Partial-message fixtures preserve stream_event text and thinking delta envelopes.

const PARTIAL_TEXT = JSON.stringify({
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'one, two, three' } },
  session_id: '816e153f-f758-4518-b7d3-3e13cfaaec84',
  parent_tool_use_id: null,
});
const PARTIAL_THINKING = JSON.stringify({
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'The user is asking', estimated_tokens: null },
  },
  session_id: '816e153f-f758-4518-b7d3-3e13cfaaec84',
  parent_tool_use_id: null,
});

test('spawnArgs asks for the reply as it is written', () => {
  // The partial-message flag supplies reply chunks before the turn ends.

  assert.ok(
    spawnArgs({ cwd: 'C:ws' }).includes('--include-partial-messages'),
    'the child is started without the flag, so no reply reaches the panel until the turn ends',
  );
});

test('a streamed chunk of the reply is its own event, and thinking is not one', () => {
  const h = harness();
  h.wire.receive(PARTIAL_TEXT);
  assert.deepEqual(h.events, [
    { kind: 'session', sessionId: '816e153f-f758-4518-b7d3-3e13cfaaec84', previous: null },
    { kind: 'delta', text: 'one, two, three' },
  ]);

  // Thinking deltas must not enter the reply delta stream.

  const quiet = harness();
  quiet.wire.receive(PARTIAL_THINKING);
  assert.deepEqual(
    quiet.events.filter((e) => e.kind === 'delta'),
    [],
    'the reasoning is drawn on the card as though the model had said it to the reader',
  );
});

test('the flag adds a message type and duplicates none of the ones already read', () => {
  // Partial and completed messages emit separate delta and text events.

  const h = harness();
  h.wire.receive(PARTIAL_TEXT);
  h.wire.receive(
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'one, two, three' }] },
      session_id: '816e153f-f758-4518-b7d3-3e13cfaaec84',
    }),
  );
  assert.deepEqual(
    h.events.map((e) => e.kind),
    ['session', 'delta', 'text'],
    'a partial and a finished message are read as the same thing, so the reply is drawn twice',
  );

  // Message framing events must not emit reply text, including the stop reason event.

  const quiet = harness();
  for (const event of [
    { type: 'message_start' },
    { type: 'content_block_start', index: 1 },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } },
    { type: 'message_stop' },
  ]) {
    quiet.wire.receive(JSON.stringify({ type: 'stream_event', event }));
  }
  // And a chunk with nothing in it is nothing to draw, however it arrived.
  quiet.wire.receive(
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '' } },
    }),
  );
  assert.deepEqual(quiet.events, [], 'the framing of the stream is reported as though it were the reply');
});

test('Claude applied defaults preserve context identity and applied effort', () => {
  assert.deepEqual(
    readAppliedDefaults({
      effective: { model: 'opus[1m]', effortLevel: 'high' },
      applied: { model: 'claude-opus-5-5[1m]', effort: 'medium' },
    }),
    { status: 'ready', model: 'claude-opus-5-5[1m]', effort: 'medium', reason: '' },
  );
  assert.equal(readAppliedDefaults({ applied: { model: 'claude-sonnet-5-5', effort: null } }).effort, null);
  assert.equal(readAppliedDefaults({ effective: { model: 'opus', effortLevel: 'high' } }).status, 'unavailable');
});

test('Claude default metadata sends a control request without a prompt', async () => {
  const h = harness();
  const reading = h.wire.appliedDefaults();
  const request = h.parsed()[0];
  assert.equal(request.type, 'control_request');
  assert.deepEqual(request.request, { subtype: 'get_settings' });
  h.wire.receive(
    JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: request.request_id,
        response: { applied: { model: 'claude-opus-current', effort: 'medium' } },
      },
    }),
  );
  assert.equal((await reading).model, 'claude-opus-current');
  assert.equal(
    h.parsed().some((message) => message.type === 'user'),
    false,
  );
});

test('Claude guarded prompts settle only on the matching root replay, and replay frames stay out of display and session tracking', () => {
  vi.useFakeTimers();
  try {
    const sent: Record<string, any>[] = [];
    const events: WireEvent[] = [];
    const wire = new ClaudeWire({
      send: (line) => sent.push(JSON.parse(line)),
      emit: (e) => events.push(e),
      sessionId: SESSION,
    });
    const state = (value: string) =>
      wire.receive(
        JSON.stringify({ type: 'system', subtype: 'session_state_changed', state: value, session_id: SESSION }),
      );
    assert.equal(wire.idleEvidence(), false, 'an absent report is not idle');
    state('idle');
    assert.equal(wire.idleEvidence(), true);
    const text = 'Fix the review findings.\nLínea dos ✓';
    const attempt = new GuardedAttempt('6f1c2a1e-0000-4000-8000-000000000001');
    void wire.prompt({ text, assets: [] }, attempt);
    assert.equal(sent.at(-1)!.uuid, attempt.clientUuid);
    assert.deepEqual(sent.at(-1)!.origin, { kind: 'human' });
    assert.deepEqual(sent.at(-1)!.message.content, [{ type: 'text', text }]);
    assert.equal(wire.idleEvidence(), false);
    assert.throws(() => wire.prompt('second', new GuardedAttempt('other')), /unsettled/);
    const before = events.length;
    const replay = (changes: Record<string, unknown> = {}) =>
      wire.receive(
        JSON.stringify({
          type: 'user',
          isReplay: true,
          session_id: SESSION,
          parent_tool_use_id: null,
          uuid: attempt.clientUuid,
          message: { role: 'user', content: [{ type: 'text', text }] },
          ...changes,
        }),
      );
    for (const changes of [
      { uuid: 'historical-uuid' },
      { session_id: 'b1f0b8f2-0000-4000-8000-000000000009' },
      { parent_tool_use_id: 'toolu_nested' },
      { message: { role: 'user', content: [{ type: 'text', text: 'Fix the review findings.' }] } },
      {
        message: {
          role: 'user',
          content: [
            { type: 'text', text },
            { type: 'text', text: 'extra' },
          ],
        },
      },
      { type: 'assistant' },
    ])
      replay(changes);
    replay({ isReplay: false });
    assert.equal(attempt.settled, null);
    assert.equal(events.length, before, 'replay frames emit no display or session events');
    assert.equal(wire.sessionId(), SESSION);
    replay();
    assert.deepEqual(attempt.settled, { outcome: 'accepted', nativeTurnId: null, reason: '' });
    replay();
    assert.equal(events.length, before);

    const endings: [string, () => void][] = [
      ['idle', () => state('idle')],
      [
        'result',
        () => wire.receive(JSON.stringify({ type: 'result', subtype: 'success', session_id: SESSION, result: 'done' })),
      ],
      ['deadline', () => vi.advanceTimersByTime(GUARDED_RECEIPT_MS)],
    ];
    for (const [name, end] of endings) {
      const pending = new GuardedAttempt(`uuid-${name}`);
      void wire.prompt('next step', pending);
      if (name === 'deadline') vi.advanceTimersByTime(GUARDED_RECEIPT_MS - 1);
      assert.equal(pending.settled, null, name);
      end();
      assert.equal(pending.settled?.outcome, 'unknown', name);
    }
    const refused = new GuardedAttempt('uuid-assets');
    const sentBefore = sent.length;
    assert.throws(() =>
      wire.prompt(
        {
          text: 'with file',
          assets: [{ id: 'a', name: 'a.txt', mime: 'text/plain', size: 1, digest: 'd', path: 'p' }],
        },
        refused,
      ),
    );
    assert.equal(sent.length, sentBefore);
    assert.equal(refused.settled, null);
    const closing = new GuardedAttempt('uuid-close');
    void wire.prompt('last', closing);
    wire.close('the agent stopped');
    assert.deepEqual(closing.settled, { outcome: 'unknown', nativeTurnId: null, reason: 'the agent stopped' });
    assert.equal(spawnArgs({ cwd: 'C:\\ws' }).includes('--replay-user-messages'), false);
    assert.equal(spawnArgs({ cwd: 'C:\\ws', replayUserMessages: true }).includes('--replay-user-messages'), true);
  } finally {
    vi.useRealTimers();
  }
});

// Catches a guarded follow-up that reuses the previous native generation, so a deferred compaction its turn requests
// binds to the earlier turn instead.
test('a Claude guarded prompt starts its own native submission, and its root tool calls carry that generation', async () => {
  const events: WireEvent[] = [];
  const wire = new ClaudeWire({ send: () => undefined, emit: (event) => events.push(event), sessionId: SESSION });
  await wire.prompt('initial assignment');
  void wire.prompt('Apply the corrections, then compact.', new GuardedAttempt('uuid-follow-up'));
  wire.receive(
    JSON.stringify({
      session_id: SESSION,
      type: 'assistant',
      parent_tool_use_id: null,
      uuid: 'envelope',
      request_id: 'native-request',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'root-call',
            name: 'Bash',
            input: { command: 'arc compact request --self --after-turn' },
            caller: { type: 'direct' },
          },
        ],
      },
    }),
  );
  const native = events.flatMap((e) => (e.kind === 'native' ? [e.event] : []));
  assert.deepEqual(
    native.map((e) => [e.kind, e.generation]),
    [
      ['submission', 1],
      ['submission', 2],
      ['toolStart', 2],
    ],
  );
  assert.equal(native[1].kind === 'submission' && native[1].text, 'Apply the corrections, then compact.');
});

test('Claude idle evidence clears at every user frame, including a delayed attachment write and an effort command', async () => {
  const bytes = new TextEncoder().encode('x');
  let release!: (bytes: Uint8Array) => void;
  const h = harness(undefined, SESSION, () => new Promise<Uint8Array>((resolve) => (release = resolve)));
  const idle = () =>
    h.wire.receive(
      JSON.stringify({ type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: SESSION }),
    );
  idle();
  const digest = createHash('sha256').update(bytes).digest('hex');
  const asset = { id: 'a', name: 'a.txt', mime: 'text/plain', size: 1, digest, path: 'p' };
  const prompting = h.wire.prompt({ text: 'See the file.', assets: [asset] });
  idle();
  assert.equal(h.wire.idleEvidence(), true, 'the report arrived while the attachment was still loading');
  release(bytes);
  await prompting;
  assert.equal(h.parsed().at(-1).type, 'user');
  assert.equal(h.wire.idleEvidence(), false);
  idle();
  await h.wire.effortCommand('high');
  assert.equal(h.parsed().at(-1).message.content[0].text, '/effort high');
  assert.equal(h.wire.idleEvidence(), false);
});

// Catches a change in the envelopes that bind a turn Claude starts by itself: the launch, its task
// notice, and the origin that names the notice by run or the subagent by its launched agent id.
test('recorded task notices and hand-backs name the launch that the woken result names', async () => {
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const replay = (name: string) => {
    const h = harness();
    for (const line of readFileSync(path.join(__dirname, '../test/fixtures', name), 'utf8')
      .trim()
      .split('\n'))
      h.wire.receive(line);
    return h.events.flatMap((e) => (e.kind === 'native' ? [e.event] : []));
  };
  const peer = replay('claude-peer-handback-2.1.303.jsonl');
  const launched = peer.find((e) => e.kind === 'launch' && e.agentId !== null);
  assert.ok(launched?.kind === 'launch');
  assert.ok(peer.some((e) => e.kind === 'wake' && e.toolId === launched.toolId));
  const origins = peer.flatMap((e) =>
    e.kind === 'rootEnd' ? [e.evidence.origin as { kind?: string; from?: string }] : [],
  );
  assert.ok(origins.some((origin) => origin?.kind === 'peer' && origin.from === launched.agentId));
  const queued = replay('claude-back-to-back-notices-2.1.303.jsonl');
  const runs = queued.flatMap((e) => (e.kind === 'wake' ? [e.runId] : []));
  const named = queued.flatMap((e) =>
    e.kind === 'rootEnd' && e.evidence.origin ? [(e.evidence.origin as { runId?: string }).runId] : [],
  );
  assert.equal(named.length, 1);
  assert.ok(runs.includes(named[0]!));
});
