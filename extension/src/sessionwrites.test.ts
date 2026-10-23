import { activeWriterFailure } from './composerview';
import { GuardedAttempt } from './agentwire.ts';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as crypto from 'node:crypto';
import { Duplex } from 'node:stream';
import { WindowsPipeServer } from './windowpipe.ts';
import * as path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { sessionAttention, type SessionListingRow } from './sessionreads.ts';
import { requestWindow, requesterIdentity } from './sessionrequests.ts';
import {
  ARCHIVE_COMPLETION_UNAVAILABLE,
  GUARDED_SEND_REASONS,
  SessionReadObservations,
  runSessionRead,
  SessionWriteRequests,
  archiveRefusal,
  guardedChannelSend,
  guardedDeliveryPort,
  guardedRefusal,
  guardedPanelPorts,
  guardedStartContext,
  interveneOnReaderInput,
  recordGuardedStart,
  runGuardedSend,
} from './sessionwrites.ts';
import { OrderedReadOperations, type AgentReadRecord, type AgentReadSource } from './domain/read.ts';
import { CodexWire } from './codexwire.ts';
import { parseSessionRequest, WindowChannel } from './sessionrequests.ts';

import { request, createWindowFixtures } from '../test/window-channel';

import { GuardChild, guardFixture, guardedRequest } from '../test/guarded-send';

const sockets: Duplex[] = [];

const channels: WindowChannel[] = [];

const { fixture } = createWindowFixtures(channels, sockets);

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(channels.splice(0).map((channel) => channel.dispose()));
});

test('read receipts refuse changed or foreign work and dry run preserves later admission', async () => {
  const record: AgentReadRecord = {
    provider: 'codex',
    sessionId: 'worker',
    source: 'source',
    scope: 'scope',
    sourceRevision: 'revision',
    promptId: 'prompt',
    startedAt: 10,
  };
  const facts = (): AgentReadSource => ({
    ...record,
    identitiesComplete: true,
    turns: [{ promptId: 'prompt', startedAt: 10, finished: true }],
  });
  const requester = { provider: 'claude' as const, id: 'reader' };
  const secret = Buffer.alloc(32, 7);
  const policy = new SessionReadObservations('activation', secret);
  const observation = policy.observe(requester, { records: [record], projection: 'bounded-projection' })!;
  assert.ok(observation);
  assert.deepEqual(policy.admit(observation, requester, 'worker', facts), [record]);
  for (const changed of [
    { sourceRevision: 'append' },
    { sourceRevision: 'truncated' },
    { source: 'replacement' },
    { scope: 'moved' },
    { provider: 'claude' as const },
    { identitiesComplete: false },
  ])
    assert.equal(
      policy.admit(observation, requester, 'worker', () => ({ ...facts(), ...changed })),
      null,
    );
  assert.equal(policy.admit(observation, { ...requester, id: 'foreign' }, 'worker', facts), null);
  assert.equal(policy.admit(observation, { ...requester, provider: 'codex' }, 'worker', facts), null);
  assert.equal(policy.admit(observation, requester, 'other', facts), null);
  assert.equal(new SessionReadObservations('other', secret).admit(observation, requester, 'worker', facts), null);
  assert.equal(policy.admit('x' + observation.slice(1), requester, 'worker', facts), null);
  assert.equal(
    policy.admit(observation, requester, 'worker', () => ({
      ...facts(),
      turns: [...facts().turns, { promptId: 'collision', startedAt: 10, finished: true }],
    })),
    null,
  );
  const operations = new OrderedReadOperations({ revision: 0, read: [], readTo: {}, since: 0, agentRead: [] });
  let writes = 0;
  const request = { requestId: 'dry', sessionId: 'worker', observation, requester, dryRun: true };
  const persist = async () => {
    writes++;
  };
  const dry = await runSessionRead(request, policy, operations, facts, persist, () => {});
  assert.equal(dry.status, 'dry-run');
  assert.equal(writes, 0);
  assert.equal(operations.snapshot().revision, 0);
  const applied = await runSessionRead(
    { ...request, requestId: 'apply', dryRun: false },
    policy,
    operations,
    facts,
    persist,
    () => {},
  );
  assert.equal(applied.status, 'applied');
  assert.equal(writes, 1);
  assert.deepEqual(operations.snapshot().read, []);
  assert.deepEqual(operations.snapshot().readTo, {});
  const refused = await runSessionRead(
    { ...request, requestId: 'fail', dryRun: false },
    policy,
    operations,
    facts,
    async () => {
      throw new Error('save failed');
    },
    () => {
      assert.fail('failed read published');
    },
  );
  assert.equal(refused.status, 'refused');
  assert.equal(operations.snapshot().revision, 1);
  let savedRevision = 0;
  const uncertain = await runSessionRead(
    { ...request, requestId: 'publication-failure', dryRun: false },
    policy,
    operations,
    facts,
    async (state) => {
      savedRevision = state.revision;
    },
    () => {
      throw new Error('publication failed');
    },
  );
  assert.equal(uncertain.status, 'unknown');
  assert.equal(savedRevision, 2);
  assert.equal(operations.snapshot().revision, 2);
  assert.deepEqual(operations.snapshot().agentRead, [record]);
});

test('read write retries retain settled outcomes after source changes and refuse conflicting payloads', async () => {
  const record: AgentReadRecord = {
    provider: 'codex',
    sessionId: 'worker',
    source: 'source',
    scope: 'scope',
    sourceRevision: 'revision',
    promptId: 'prompt',
    startedAt: 10,
  };
  const facts = (): AgentReadSource => ({
    ...record,
    identitiesComplete: true,
    turns: [{ promptId: 'prompt', startedAt: 10, finished: true }],
  });
  const policy = new SessionReadObservations('activation');
  const requester = { provider: 'claude' as const, id: 'reader' };
  const observation = policy.observe(requester, { records: [record], projection: 'bounded' })!;
  const owner = new OrderedReadOperations({ revision: 0, read: [], readTo: {}, since: 0, agentRead: [] });
  const request = { requestId: 'retained', sessionId: 'worker', observation, requester, dryRun: false };
  let writes = 0;
  const result = await runSessionRead(
    request,
    policy,
    owner,
    facts,
    async () => {
      writes++;
    },
    () => {},
  );
  assert.equal(result.status, 'applied');
  await owner.run(
    { id: 'reader-removal', action: 'reset', observedRevision: 0, since: 0 },
    facts,
    async () => {},
    () => {},
  );
  const retried = await runSessionRead(
    request,
    policy,
    owner,
    () => null,
    async () => assert.fail('retry persisted'),
    () => {},
  );
  assert.deepEqual(retried, result);
  assert.equal(writes, 1);
  assert.deepEqual(owner.snapshot().agentRead, []);
  const conflict = await runSessionRead(
    { ...request, dryRun: true },
    policy,
    owner,
    facts,
    async () => {},
    () => {},
  );
  assert.equal(conflict.status, 'refused');
});

test('read writes retain unknown storage settlement and prevent later applied outcomes', async () => {
  const record: AgentReadRecord = {
    provider: 'codex',
    sessionId: 'worker',
    source: 'source',
    scope: 'scope',
    sourceRevision: 'revision',
    promptId: 'prompt',
    startedAt: 10,
  };
  const facts = (): AgentReadSource => ({
    ...record,
    identitiesComplete: true,
    turns: [{ promptId: 'prompt', startedAt: 10, finished: true }],
  });
  const policy = new SessionReadObservations('activation');
  const requester = { provider: 'claude' as const, id: 'reader' };
  const observation = policy.observe(requester, { records: [record], projection: 'bounded' })!;
  const owner = new OrderedReadOperations({ revision: 0, read: [], readTo: {}, since: 0, agentRead: [] });
  const request = { requestId: 'unknown', sessionId: 'worker', observation, requester, dryRun: false };
  let writes = 0;
  const persist = async () => {
    writes++;
    return { status: 'unknown' as const };
  };
  const publish = () => assert.fail('unknown storage published');
  assert.equal((await runSessionRead(request, policy, owner, facts, persist, publish)).status, 'unknown');
  assert.equal((await runSessionRead(request, policy, owner, facts, persist, publish)).status, 'unknown');
  assert.equal(
    (await runSessionRead({ ...request, requestId: 'later' }, policy, owner, facts, persist, publish)).status,
    'unknown',
  );
  assert.equal(owner.snapshot().revision, 0);
  assert.equal(writes, 1);
});

// These cases catch duplicate acceptance and unsafe archive admission with no provider or browser startup.
test('session writes retain one acceptance across equal concurrent retries and refuse conflicts, capacity and old activations', async () => {
  const book = new SessionWriteRequests('window', 1);
  let finish!: (value: unknown) => void;
  let calls = 0;
  const apply = () => {
    calls++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const first = book.run('window:1', { prompt: 'work', setup: { model: 'a', effort: 'high' } }, apply);
  const second = book.run('window:1', { setup: { effort: 'high', model: 'a' }, prompt: 'work' }, apply);
  await vi.waitFor(() => assert.equal(calls, 1));
  await assert.rejects(book.run('window:1', { prompt: 'different' }, apply), /different request/);
  await assert.rejects(book.run('window:2', {}, apply), /limit/);
  await assert.rejects(new SessionWriteRequests('reloaded').run('window:1', {}, apply), /unknown/);
  finish({ sessionId: 'accepted' });
  assert.deepEqual(await first, await second);
  assert.deepEqual(await book.run('window:1', { prompt: 'work', setup: { model: 'a', effort: 'high' } }, apply), {
    sessionId: 'accepted',
  });
  assert.equal(calls, 1);
});

test('archive requires force for live work, completed unread work, and unavailable state', () => {
  const row = { facts: 'current', runStatus: 'done', attention: 'idle' } as SessionListingRow;
  assert.equal(archiveRefusal(row, false), null);
  assert.equal(archiveRefusal({ ...row, runStatus: 'none' }, false), null);
  assert.match(
    archiveRefusal({ ...row, attention: 'unread' }, false)!,
    /^The completed session is unread\. Use --force only when the reader asked to archive this session or its finished set\.$/,
  );
  assert.equal(archiveRefusal({ ...row, attention: 'unread' }, true), null);
  const active = [
    ...(['running', 'waiting'] as const).map((runStatus) => ({ runStatus })),
    ...(['running', 'input'] as const).map((attention) => ({ attention })),
  ];
  for (const live of active) {
    assert.match(
      archiveRefusal({ ...row, ...live }, false)!,
      /^The session is running or needs input\. Use --force only when the reader asked to archive this session\.$/,
    );
    for (const facts of ['current', 'stale', 'unparsed'] as const)
      for (const attention of ['idle', 'unread', 'unknown'] as const)
        assert.equal(archiveRefusal({ ...row, attention, ...live, facts }, true), null, JSON.stringify(live));
  }
  const HIDDEN_ATTENTION_REFUSAL =
    'The Arc panel is hidden, so Arc cannot see whether the session needs input. Show Arc and retry. Use --force only when the reader asked to archive this session or its finished set.';
  // An unavailable completion grants force for the single session only, after the reader confirms no subagent or long background command runs.
  assert.equal(
    ARCHIVE_COMPLETION_UNAVAILABLE,
    'Arc cannot tell whether the session finished. Ask the reader to show Arc, then list the session again. Use --force only when the reader asked to archive this session and confirmed it runs no subagent or long background command.',
  );
  assert.doesNotMatch(ARCHIVE_COMPLETION_UNAVAILABLE, /finished set/);
  const unavailable = [
    ...(['stale', 'unparsed'] as const).flatMap((facts) =>
      (['done', 'none', 'unknown'] as const).map((runStatus) => ({ facts, runStatus })),
    ),
    { attention: 'unknown' as const },
    { runStatus: 'unknown' as const },
    { runStatus: 'unknown' as const, attention: 'unread' as const },
    { runStatus: 'unknown' as const, attention: 'unknown' as const },
  ];
  for (const state of unavailable) {
    const label = JSON.stringify(state);
    assert.equal(
      archiveRefusal({ ...row, ...state }, false),
      Object.keys(state).join() === 'attention' ? HIDDEN_ATTENTION_REFUSAL : ARCHIVE_COMPLETION_UNAVAILABLE,
      label,
    );
    assert.equal(archiveRefusal({ ...row, ...state }, true), null, label);
  }
});

test('archive refuses background subagents and background commands with and without force, and never suggests force', () => {
  for (const runStatus of ['subagents', 'background'] as const)
    for (const visible of [true, false])
      for (const facts of ['current', 'stale', 'unparsed'] as const)
        for (const force of [false, true]) {
          const attention = sessionAttention(visible, runStatus, false);
          const reason = archiveRefusal({ facts, runStatus, attention } as SessionListingRow, force);
          const label = JSON.stringify({ runStatus, attention, facts, force });
          assert.match(
            reason ?? '',
            /^Arc cannot tell whether background work in the session ended, and archive can end it\. Once the reader confirms the work ended, archive the session from Arc's session list\.$/,
            label,
          );
          assert.doesNotMatch(reason ?? '', /--force/, label);
        }
});

test(
  'the authenticated window channel retains write acceptance across a disconnected caller and rejects conflicting retries',
  { tags: ['subprocess'] },
  async () => {
    const { channel, home, entry } = await fixture();
    let calls = 0;
    let release!: () => void;
    channel.setRequestHandler(async () => {
      calls++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { status: 'accepted', sessionId: 'only-launch' };
    });
    const params = {
      prompt: 'work',
      agentRun: false,
      setup: { kind: 'custom' as const, agent: 'codex', model: '', effort: '', permissionMode: '' },
    };
    const id = channel.hostId + ':one';
    // The binding includes the requester, so the retry runs with the same absent requester as the raw request.
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', '');
    vi.stubEnv('CODEX_THREAD_ID', '');
    const socket =
      process.platform === 'win32'
        ? await WindowsPipeServer.connect(
            entry.address,
            entry.pid,
            entry.transportPid!,
            path.join(home, 'hosts', `${channel.hostId}.json`),
          )
        : net.createConnection(entry.address);
    sockets.push(socket);
    socket.on('error', () => {});
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write(JSON.stringify(request(entry, { id, method: 'start', params })) + '\n');
    await vi.waitFor(() => assert.equal(calls, 1));
    socket.destroy();
    const retried = requestWindow('start', params, channel.hostId, home, id);
    release();
    assert.equal(((await retried) as { sessionId: string }).sessionId, 'only-launch');
    assert.equal(calls, 1);
    await assert.rejects(
      requestWindow('start', { ...params, prompt: 'other' }, channel.hostId, home, id),
      /different request/,
    );
  },
);

test('guarded sends refuse other coordinators, old activations, ambiguous requesters, and prompt-box commands with no write', async () => {
  const { policy, coordinator, facts, writes, send } = guardFixture();
  assert.equal(policy.observe('worker', { provider: 'codex', id: 'coordinator' }, facts), null);
  assert.equal(policy.observe('worker', { provider: 'claude', id: 'other' }, facts), null);
  for (const requester of [
    { provider: 'claude' as const, id: 'other' },
    { provider: 'codex' as const, id: 'coordinator' },
  ])
    assert.equal((await send({ requester })).reason, GUARDED_SEND_REASONS.unrelated);
  assert.equal((await send({ activation: 'reloaded' })).reason, GUARDED_SEND_REASONS.unrelated);
  assert.equal((await send({ sessionId: 'unrecorded' })).reason, GUARDED_SEND_REASONS.unrelated);
  assert.equal((await send({ requester: null })).reason, GUARDED_SEND_REASONS.requester);
  for (const prompt of ['', '  \n', '/compact', '  /clear now'])
    assert.equal((await send({ prompt })).reason, GUARDED_SEND_REASONS.prompt);
  assert.deepEqual(requesterIdentity({ CLAUDE_CODE_SESSION_ID: 'a', CODEX_THREAD_ID: 'b' }), {
    requester: 'a',
    provider: null,
    ambiguous: true,
  });
  assert.deepEqual(requesterIdentity({ CODEX_THREAD_ID: 'b' }), {
    requester: 'b',
    provider: 'codex',
    ambiguous: false,
  });
  assert.equal(
    policy.recordStart({
      requester: coordinator,
      activation: 'old',
      worker: 'w2',
      child: new GuardChild(),
    }),
    false,
  );
  assert.equal(writes.length, 0);
  const wire = { id: 'w:1', version: 1, token: 'b'.repeat(64), requester: 'coordinator', method: 'send' };
  const sendParams = { sessionId: 'worker', prompt: 'next', observation: 'a.' + 'b'.repeat(43) };
  assert.ok(parseSessionRequest({ ...wire, requesterProvider: 'claude', params: sendParams }));
  assert.ok(parseSessionRequest({ ...wire, params: sendParams }));
  for (const invalid of [
    { ...wire, requesterProvider: 'other', params: sendParams },
    { ...wire, requester: null, requesterProvider: 'codex', params: sendParams },
    { ...wire, method: 'curate', requesterProvider: 'claude', params: sendParams },
    { ...wire, params: { ...sendParams, observation: 'no-signature' } },
    { ...wire, params: { ...sendParams, path: '/tmp/prompt' } },
  ])
    assert.equal(parseSessionRequest(invalid), null);
});

test('guarded sends consume observations, bind source, scope, turn and assignment, and refuse unexplained changes before input', async () => {
  const { policy, child, coordinator, facts, writes, send } = guardFixture();
  const observation = policy.observe('worker', coordinator, facts)!;
  const first = send({ observation });
  await vi.waitFor(() => assert.equal(writes.length, 1));
  assert.equal((await send()).reason, GUARDED_SEND_REASONS.unsettled);
  writes[0].settle({ outcome: 'accepted', nativeTurnId: 'turn-2', reason: '' });
  const accepted = await first;
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.nativeTurnId, 'turn-2');
  assert.equal(
    accepted.payloadSha256,
    crypto.createHash('sha256').update('Apply the accepted corrections.').digest('hex'),
  );
  assert.equal((await send({ observation })).reason, GUARDED_SEND_REASONS.stale);
  const tampered = observation.slice(0, -2) + (observation.endsWith('AA') ? 'BB' : 'AA');
  assert.equal((await send({ observation: tampered })).reason, GUARDED_SEND_REASONS.stale);
  for (const [field, value, reason] of [
    ['sourceRevision', 'revision-grown', GUARDED_SEND_REASONS.changed],
    ['sourceRevision', 'revision-after-turn', GUARDED_SEND_REASONS.stale],
    ['latestTurn', 'turn-after-turn', GUARDED_SEND_REASONS.stale],
    ['latestTurn', 'turn-9', GUARDED_SEND_REASONS.changed],
    ['scope', 'other-scope', GUARDED_SEND_REASONS.changed],
    ['sourceRevision', null, GUARDED_SEND_REASONS.unavailable],
    ['current', false, GUARDED_SEND_REASONS.unavailable],
    ['archived', true, GUARDED_SEND_REASONS.unavailable],
    ['queued', 1, GUARDED_SEND_REASONS.busy],
    ['pendingSubmissions', 1, GUARDED_SEND_REASONS.busy],
    ['pendingControls', 1, GUARDED_SEND_REASONS.busy],
    ['background', true, GUARDED_SEND_REASONS.busy],
    ['background', null, GUARDED_SEND_REASONS.unavailable],
  ] as const) {
    const observed = policy.observe('worker', coordinator, facts)!;
    const saved = (facts as any)[field];
    (facts as any)[field] = value;
    // A tracked turn end explains the change, so the observation is stale rather than changed outside Arc.
    if (String(value).endsWith('after-turn')) child.turnEnds += 1;
    assert.equal((await send({ observation: observed })).reason, reason, `${field} ${value}`);
    (facts as any)[field] = saved;
  }
  // An observation from before an accepted delivery sees the delivery's growth as tracked work.
  const beforeDelivery = policy.observe('worker', coordinator, facts)!;
  const delivery = send();
  await vi.waitFor(() => assert.equal(writes.length, 2));
  writes[1].settle({ outcome: 'accepted', nativeTurnId: 'turn-3', reason: '' });
  assert.equal((await delivery).status, 'accepted');
  facts.sourceRevision = 'revision-after-delivery';
  assert.equal((await send({ observation: beforeDelivery })).reason, GUARDED_SEND_REASONS.stale);
  facts.sourceRevision = 'revision-1';
  for (const [idle, reason] of [
    ['busy', GUARDED_SEND_REASONS.busy],
    ['unconfirmed', GUARDED_SEND_REASONS.unavailable],
    ['unavailable', GUARDED_SEND_REASONS.ownership],
  ] as const) {
    child.idle = idle;
    assert.equal((await send()).reason, reason);
  }
  child.idle = null;
  const beforeClear = policy.observe('worker', coordinator, facts)!;
  child.sessionId = 'cleared-successor';
  assert.equal((await send({ observation: beforeClear })).reason, GUARDED_SEND_REASONS.ownership);
  child.sessionId = 'worker';
  assert.equal(writes.length, 2);
});

test('a guarded send read while an accepted follow-up still runs refuses as busy, not as changed outside Arc', async () => {
  const { policy, child, coordinator, facts, writes, send } = guardFixture();
  const delivery = send();
  await vi.waitFor(() => assert.equal(writes.length, 1));
  writes[0].settle({ outcome: 'accepted', nativeTurnId: 'turn-2', reason: '' });
  assert.equal((await delivery).status, 'accepted');
  // The coordinator reads the worker while the accepted turn runs, and that turn then grows the source.
  child.idle = 'busy';
  const running = policy.observe('worker', coordinator, facts)!;
  facts.sourceRevision = 'revision-running-growth';
  facts.latestTurn = 'turn-2';
  assert.equal((await send({ observation: running })).reason, GUARDED_SEND_REASONS.busy);
  child.idle = null;
  facts.pendingControls = 1;
  assert.equal((await send({ observation: running })).reason, GUARDED_SEND_REASONS.busy);
  facts.pendingControls = 0;
  // With idle evidence and no tracked turn end, the same growth stays unexplained.
  assert.equal((await send({ observation: running })).reason, GUARDED_SEND_REASONS.changed);
  assert.equal(writes.length, 1);
});

// A removed child can still report unexited while its disposal finishes.
test('guarded observations require the exact retained child and keep retirement before the lease unwritten', async () => {
  const { policy, child, coordinator, facts, writes, port, send } = guardFixture();
  const ports = guardedPanelPorts(policy);
  const request = {
    id: 'window:read',
    requester: 'coordinator',
    requesterProvider: 'claude' as const,
    params: { sessionId: 'worker' },
  };
  const live = ports.guardedObservation(request, facts)!;
  assert.equal(typeof live, 'string');
  assert.equal(policy.precheck(guardedRequest(live, coordinator)), null);
  port.retained = null;
  assert.equal(child.state().exited, false);
  assert.equal(ports.guardedObservation(request, facts), null, 'retirement signed a read before disposal finished');
  assert.equal((await send({ observation: live })).reason, GUARDED_SEND_REASONS.ownership);
  const replacement = new GuardChild();
  port.retained = replacement;
  assert.equal(ports.guardedObservation(request, facts), null, 'a same-ID replacement signed the original child read');
  assert.equal((await send({ observation: live })).reason, GUARDED_SEND_REASONS.ownership);
  port.retained = child;
  child.exited = true;
  assert.equal(ports.guardedObservation(request, facts), null);
  child.exited = false;
  child.sessionId = 'another-session';
  assert.equal(ports.guardedObservation(request, facts), null);
  child.sessionId = 'worker';
  const beforeLease = ports.guardedObservation(request, facts)!;
  assert.equal(typeof beforeLease, 'string');
  port.withLease = async () => {
    port.retained = null;
    return null;
  };
  assert.equal((await send({ observation: beforeLease })).reason, GUARDED_SEND_REASONS.ownership);
  assert.deepEqual(writes, []);
  assert.deepEqual(child.attempts, []);
  assert.deepEqual(replacement.attempts, []);
});

test('reader intervention, retirement, writer conflicts, and unknown or shared-turn outcomes block guarded sends without a resend', async () => {
  const { policy, coordinator, facts, writes, port, send } = guardFixture();
  for (const reader of ['worker', 'coordinator']) {
    const observation = policy.observe('worker', coordinator, facts)!;
    policy.intervene(reader);
    assert.equal((await send({ observation })).reason, GUARDED_SEND_REASONS.stale, reader);
  }
  policy.intervene('unrelated-session');
  const beforeRetirement = policy.observe('worker', coordinator, facts)!;
  port.alive = false;
  assert.equal((await send({ observation: beforeRetirement })).reason, GUARDED_SEND_REASONS.ownership);
  port.alive = true;
  port.leased = false;
  assert.equal((await send()).reason, GUARDED_SEND_REASONS.ownership);
  port.leased = true;
  assert.equal(writes.length, 0);
  const unknown = send();
  await vi.waitFor(() => assert.equal(writes.length, 1));
  writes[0].settle({ outcome: 'unknown', nativeTurnId: null, reason: 'the agent did not answer' });
  assert.equal((await unknown).status, 'unknown');
  const later = policy.observe('worker', coordinator, facts)!;
  assert.equal((await send({ observation: later, prompt: 'Different text.' })).reason, GUARDED_SEND_REASONS.blocked);
  policy.intervene('coordinator');
  assert.equal((await send()).reason, GUARDED_SEND_REASONS.blocked);
  policy.intervene('worker');
  const shared = send();
  await vi.waitFor(() => assert.equal(writes.length, 2));
  const pending = policy.observe('worker', coordinator, facts)!;
  writes[1].settle({ outcome: 'unknown', nativeTurnId: 'turn-1', reason: 'joined', sharedTurn: true });
  assert.deepEqual([(await shared).status, (await shared).nativeTurnId], ['unknown', 'turn-1']);
  assert.equal((await send({ observation: pending })).reason, GUARDED_SEND_REASONS.stale);
  policy.intervene('worker');
  facts.writerConflict = true;
  assert.equal((await send()).reason, GUARDED_SEND_REASONS.ownership);
  facts.writerConflict = false;
  assert.equal((await send()).reason, GUARDED_SEND_REASONS.ownership);
  assert.equal(writes.length, 2);
});

test(
  'the window channel retains guarded sends by requester, provider, target, observation and exact text, and refuses without an owner record',
  { tags: ['subprocess'] },
  async () => {
    const { channel, home } = await fixture();
    const observation = 'b'.repeat(40) + '.' + 'c'.repeat(43);
    const params = { sessionId: 'worker', prompt: 'Line one\nLínea dos ✓', observation };
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'coordinator');
    vi.stubEnv('CODEX_THREAD_ID', '');
    try {
      const refused = (await requestWindow('send', params, channel.hostId, home, channel.hostId + ':none')) as any;
      assert.equal(refused.status, 'refused');
      assert.equal(refused.reason, GUARDED_SEND_REASONS.unrelated);
      const seen: any[] = [];
      let release!: () => void;
      channel.setGuardedSendHandler(async (request) => {
        seen.push(request);
        await new Promise<void>((resolve) => (release = resolve));
        return {
          version: 1,
          status: 'accepted',
          requestId: request.id,
          payloadSha256: 'x',
          nativeTurnId: 't',
          reason: '',
        };
      });
      const id = channel.hostId + ':one';
      const first = requestWindow('send', params, channel.hostId, home, id);
      await vi.waitFor(() => assert.equal(seen.length, 1));
      assert.equal(seen[0].requesterProvider, 'claude');
      assert.equal(seen[0].params.prompt, params.prompt);
      const retry = requestWindow('send', params, channel.hostId, home, id);
      release();
      assert.deepEqual(await first, await retry);
      assert.equal(seen.length, 1);
      await assert.rejects(
        requestWindow('send', { ...params, prompt: 'Other text' }, channel.hostId, home, id),
        /different request/,
      );
      await assert.rejects(
        requestWindow('send', { ...params, observation: 'd' + observation.slice(1) }, channel.hostId, home, id),
        /different request/,
      );
      vi.stubEnv('CLAUDE_CODE_SESSION_ID', '');
      vi.stubEnv('CODEX_THREAD_ID', 'coordinator');
      await assert.rejects(requestWindow('send', params, channel.hostId, home, id), /different request/);
      await assert.rejects(
        requestWindow('send', { ...params, prompt: '"'.repeat(40_000) }, channel.hostId, home, channel.hostId + ':big'),
        /channel limit/,
      );
      assert.equal(seen.length, 1);
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

test('guarded sends keep an observation that a wire refusal before the write left unused, and compose full-sentence reasons', async () => {
  const { policy, coordinator, facts, writes, port, send } = guardFixture();
  const observation = policy.observe('worker', coordinator, facts)!;
  const write = port.write;
  const unwritten = (reason: string) => (_child: GuardChild, _text: string) => {
    const attempt = new GuardedAttempt('unwritten');
    attempt.settle({ outcome: 'unknown', nativeTurnId: null, reason });
    return attempt;
  };
  port.write = unwritten('another guarded prompt is still unsettled');
  const refused = await send({ observation });
  assert.deepEqual(
    [refused.status, refused.reason],
    ['refused', 'Another guarded prompt is still unsettled. No prompt was sent.'],
  );
  port.write = unwritten('the agent is no longer running, so the prompt was not sent');
  assert.equal((await send({ observation })).reason, 'The agent is no longer running, so the prompt was not sent.');
  port.write = write;
  const pending = send({ observation });
  await vi.waitFor(() => assert.equal(writes.length, 1));
  writes[0].settle({ outcome: 'unknown', nativeTurnId: null, reason: 'the agent did not answer' });
  const unknown = await pending;
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.reason, 'The agent did not answer. Delivery is unknown. Arc will not resend this prompt.');
});

// Catches a second place that clears the unknown-delivery block, such as a callback wrapper or the port for input
// the panel has not accepted yet. Only the accepted-input port clears it.
test('reader callbacks and unaccepted input make observations stale, and only accepted reader input clears an unknown block', async () => {
  const { policy, coordinator, facts, writes, send } = guardFixture();
  const unknown = send();
  await vi.waitFor(() => assert.equal(writes.length, 1));
  writes[0].settle({ outcome: 'unknown', nativeTurnId: null, reason: 'the agent did not answer' });
  assert.equal((await unknown).status, 'unknown');
  const panel = {
    onSendPrompt: async (..._args: unknown[]) => ({ delivered: true, reason: '', turnId: 4 }),
    onCompact: async (..._args: unknown[]) => ({ delivered: true, reason: '' }),
    onClear: async (..._args: unknown[]) => ({ delivered: false, reason: 'no' }),
    onStopTurn: (..._args: unknown[]) => undefined,
    onAnswerAsk: (..._args: unknown[]) => true,
  };
  interveneOnReaderInput(panel, policy);
  const ports = guardedPanelPorts(policy);
  const unaccepted: [string, () => unknown][] = [
    ['delivered prompt', () => panel.onSendPrompt('claude', 'worker', null, { text: 'x', assets: [] })],
    ['delivered compaction', () => panel.onCompact('claude', 'worker', null)],
    ['rejected clear', () => panel.onClear('claude', 'worker', null, 'name')],
    ['stop', () => panel.onStopTurn('claude', 'worker')],
    ['accepted answer', () => panel.onAnswerAsk('worker', 'ask', 'yes')],
    ['input the panel has not accepted yet', () => ports.onReaderInput('worker')],
  ];
  for (const [name, call] of unaccepted) {
    const before = policy.observe('worker', coordinator, facts)!;
    await call();
    assert.equal(policy.precheck(guardedRequest(before, coordinator)), GUARDED_SEND_REASONS.stale, name);
    const after = policy.observe('worker', coordinator, facts)!;
    assert.equal(policy.precheck(guardedRequest(after, coordinator)), GUARDED_SEND_REASONS.blocked, name);
  }
  assert.equal(panel.onAnswerAsk('worker', 'ask', 'yes'), true, 'the wrapper returns the callback result unchanged');
  ports.onReaderDirected('coordinator');
  assert.equal(
    policy.precheck(guardedRequest(policy.observe('worker', coordinator, facts)!, coordinator)),
    GUARDED_SEND_REASONS.blocked,
    'accepted input to the coordinator cleared its worker block',
  );
  const before = policy.observe('worker', coordinator, facts)!;
  ports.onReaderDirected('worker');
  assert.equal(policy.precheck(guardedRequest(before, coordinator)), GUARDED_SEND_REASONS.stale);
  assert.equal(policy.precheck(guardedRequest(policy.observe('worker', coordinator, facts)!, coordinator)), null);
  assert.equal(writes.length, 1);
});

test('guarded wiring intervenes on each directing reader callback, records only fresh starts, and delivers through the guarded prompt mode', async () => {
  const { policy, child, coordinator, facts } = guardFixture();
  const calls: unknown[][] = [];
  const callback =
    (name: string) =>
    (...args: unknown[]) =>
      calls.push([name, ...args]);
  const panel = {
    onSendPrompt: callback('send'),
    onCompact: callback('compact'),
    onClear: callback('clear'),
    onStopTurn: callback('stop'),
    onAnswerAsk: callback('answer'),
  };
  interveneOnReaderInput(panel, policy);
  const directing: [() => unknown, string][] = [
    [() => panel.onSendPrompt('claude', 'worker', null, { text: 'x', assets: [] }), 'onSendPrompt'],
    [() => panel.onCompact('claude', 'worker', null), 'onCompact'],
    [() => panel.onClear('claude', 'worker', null, 'name'), 'onClear'],
    [() => panel.onStopTurn('claude', 'worker'), 'onStopTurn'],
    [() => panel.onAnswerAsk('worker', 'ask', 'yes'), 'onAnswerAsk'],
  ];
  for (const [call, name] of directing) {
    const observation = policy.observe('worker', coordinator, facts)!;
    call();
    assert.equal(policy.precheck(guardedRequest(observation, coordinator)), GUARDED_SEND_REASONS.stale, name);
  }
  assert.equal(calls.length, directing.length);
  const kept = policy.observe('worker', coordinator, facts)!;
  panel.onSendPrompt('claude', 'worker', null, { text: 'x', assets: [] }, undefined, { requestId: 'window:g' });
  assert.equal(policy.precheck(guardedRequest(kept, coordinator)), null, 'guarded delivery is not reader input');

  const ports = guardedPanelPorts(policy);
  const read = { id: 'window:read', requester: 'coordinator', params: { sessionId: 'worker' } };
  assert.equal(ports.guardedObservation(read, facts), null, 'a read without the provider gets no observation');
  const signed = ports.guardedObservation({ ...read, requesterProvider: 'claude' }, facts)!;
  assert.equal(policy.precheck(guardedRequest(signed, coordinator)), null);
  ports.onReaderDirected('worker');
  assert.equal(policy.precheck(guardedRequest(signed, coordinator)), GUARDED_SEND_REASONS.stale);
  const installed = policy.facts;
  ports.installGuardedFacts(null);
  assert.equal(policy.facts, null);
  policy.facts = installed;

  const fresh = new GuardChild();
  fresh.sessionId = 'fresh';
  const start = guardedStartContext({
    id: 'window:start',
    requester: 'coordinator',
    requesterProvider: 'codex',
    params: {},
  });
  assert.deepEqual(start, { requestId: 'window:start', requester: { provider: 'codex', id: 'coordinator' } });
  const unattributed = guardedStartContext({ id: 'window:plain', requester: 'coordinator', params: {} });
  assert.equal(recordGuardedStart(policy, unattributed, fresh, fresh), false);
  assert.equal(
    recordGuardedStart(policy, start, fresh, new GuardChild()),
    false,
    'a replacement took the first prompt',
  );
  assert.equal(policy.owner('fresh'), null);
  assert.equal(recordGuardedStart(policy, start, fresh, fresh), true);
  assert.equal(policy.owner('fresh')?.child, fresh);

  let found: GuardChild | null = child;
  const delivery = guardedDeliveryPort(
    policy,
    {
      find: (_agent, _session) => found,
      withActivity: async (_key, work) => work(found!),
    },
    (error) => error === 'writer lock',
    () => 'uuid-1',
  );
  const owner = policy.owner('worker')!;
  assert.equal(delivery.live(owner), child);
  found = new GuardChild();
  found.lastError = 'writer lock';
  assert.equal(delivery.live(owner), null, 'a different live child is not the recorded writer');
  assert.equal(policy.precheck(guardedRequest(policy.observe('worker', coordinator, facts)!, coordinator)), null);
  assert.equal(await delivery.withLease(child, async () => 'leased'), null);
  found = child;
  assert.equal(await delivery.withLease(child, async () => 'leased'), 'leased');
  assert.equal(delivery.write(child, 'text').clientUuid, 'uuid-1');
  assert.deepEqual(child.attempts, ['text']);

  const sent: unknown[][] = [];
  const result = await guardedChannelSend(
    policy,
    {
      id: 'window:send',
      requester: 'coordinator',
      requesterProvider: 'claude',
      params: { sessionId: 'worker', prompt: 'Follow up.', observation: 'o.b' },
    },
    async (...args) => {
      sent.push(args);
      return {};
    },
  );
  assert.deepEqual(sent, [
    [
      'claude',
      'worker',
      null,
      { text: 'Follow up.', assets: [] },
      undefined,
      {
        requestId: 'window:send',
        activation: 'window',
        sessionId: 'worker',
        observation: 'o.b',
        requester: { provider: 'claude', id: 'coordinator' },
      },
    ],
  ]);
  assert.equal(result.status, 'refused');

  child.lastError = 'writer lock';
  delivery.live(owner);
  assert.equal(
    policy.precheck(guardedRequest(policy.observe('worker', coordinator, facts)!, coordinator)),
    GUARDED_SEND_REASONS.ownership,
  );
});

// Catches unbounded refused bindings and eviction that permits an old request ID to run again.
test('guarded admission exhaustion stops distinct refusals and retains the oldest equal and conflicting retries', async () => {
  const book = new SessionWriteRequests('window', 2);
  let applied = 0;
  const refuse = (id: string) => () => {
    applied += 1;
    return guardedRefusal(id, 'Next.', GUARDED_SEND_REASONS.busy);
  };
  for (const n of [0, 1]) await book.runGuarded(`window:${n}`, { prompt: `p${n}` }, refuse(`window:${n}`));
  for (const n of [2, 3])
    await assert.rejects(book.runGuarded(`window:${n}`, { prompt: `p${n}` }, refuse(`window:${n}`)), /limit/);
  await assert.rejects(book.runGuarded('window:2', { prompt: 'changed' }, refuse('window:2')), /limit/);
  const again = (await book.runGuarded('window:0', { prompt: 'p0' }, refuse('window:0'))) as { requestId: string };
  assert.equal(again.requestId, 'window:0');
  await assert.rejects(book.runGuarded('window:0', { prompt: 'changed' }, refuse('window:0')), /different request/);
  await assert.rejects(new SessionWriteRequests('reloaded').runGuarded('window:0', {}, refuse('window:0')), /unknown/);
  assert.equal(applied, 2, 'exhausted or retained request IDs invoked a handler');
});

// Catches asynchronous reservations that let concurrent requests exceed the lifetime allowance.
test('guarded admissions reserve capacity before concurrent handlers run and equal retries share the pending outcome', async () => {
  const book = new SessionWriteRequests('window', 2);
  const finish: (() => void)[] = [];
  let applied = 0;
  const refuse = (id: string) => () => {
    applied++;
    return new Promise<ReturnType<typeof guardedRefusal>>((resolve) => {
      finish.push(() => resolve(guardedRefusal(id, 'Next.', GUARDED_SEND_REASONS.busy)));
    });
  };
  const first = book.runGuarded('window:1', { prompt: 'Next.' }, refuse('window:1'));
  const equal = book.runGuarded('window:1', { prompt: 'Next.' }, refuse('window:1'));
  const second = book.runGuarded('window:2', { prompt: 'Next.' }, refuse('window:2'));
  await assert.rejects(book.runGuarded('window:3', {}, refuse('window:3')), /limit/);
  await assert.rejects(book.runGuarded('window:1', { prompt: 'Other.' }, refuse('window:1')), /different request/);
  assert.equal(applied, 2);
  assert.equal(finish.length, 2);
  for (const settle of finish) settle();
  assert.deepEqual(await first, await equal);
  await second;
  await assert.rejects(book.runGuarded('window:3', {}, refuse('window:3')), /limit/);
  assert.equal(applied, 2, 'settled refusals returned lifetime capacity');
});

// Catches accepted or unknown outcomes returning lifetime capacity or being delivered again at exhaustion.
test('accepted and unknown guarded admissions consume lifetime capacity and preserve duplicates without another delivery', async () => {
  const book = new SessionWriteRequests('window', 4, 3);
  let applied = 0;
  const outcomes = ['refused', 'accepted', 'unknown'] as const;
  const deliver = (status: (typeof outcomes)[number]) => () => {
    applied++;
    return { ...guardedRefusal(`window:${status}`, 'Next.', ''), status };
  };
  for (const status of outcomes) await book.runGuarded(`window:${status}`, { prompt: status }, deliver(status));
  await assert.rejects(book.runGuarded('window:overflow', {}, deliver('accepted')), /limit/);
  for (const status of outcomes) {
    const again = await book.runGuarded(`window:${status}`, { prompt: status }, deliver(status));
    assert.equal((again as { status: string }).status, status);
    await assert.rejects(
      book.runGuarded(`window:${status}`, { prompt: 'Other.' }, deliver(status)),
      /different request/,
    );
  }
  assert.equal(applied, 3);
});

// Catches starts and curation consuming the independent guarded lifetime allowance.
test('ordinary writes before a guarded send leave its lifetime allowance available', async () => {
  const book = new SessionWriteRequests('window', 4, 1);
  await book.run('window:start', { method: 'start' }, () => ({ status: 'accepted' }));
  await book.run('window:curate', { method: 'curate' }, () => ({ status: 'accepted' }));
  let applied = 0;
  const result = await book.runGuarded('window:send', { prompt: 'Next.' }, () => {
    applied++;
    return guardedRefusal('window:send', 'Next.', GUARDED_SEND_REASONS.busy);
  });
  assert.equal((result as { status: string }).status, 'refused');
  assert.equal(applied, 1);
});

// Catches loss of the production writer diagnostic or a conflict that clears with the transient child error.
test('the guarded delivery port recognizes Codex writer conflicts persistently and keeps attempted input unknown', async () => {
  const message = 'thread thread-7 already has an active writer';
  for (const race of ['before-input', 'receipt', 'retired', 'reader'] as const) {
    const attempted = race !== 'before-input';
    const { policy, child, coordinator, facts } = guardFixture();
    child.agent = 'codex';
    let found: GuardChild | null = child;
    const delivery = guardedDeliveryPort(
      policy,
      { find: () => found, withActivity: async (_key, work) => work(child) },
      activeWriterFailure,
      () => 'uuid-conflict',
    );
    const send = () =>
      runGuardedSend(policy, guardedRequest(policy.observe('worker', coordinator, facts)!, coordinator), delivery);
    if (attempted) {
      const sent: { id: number; method: string }[] = [];
      const wire = new CodexWire({
        send: (line) => sent.push(JSON.parse(line)),
        emit: () => {},
        clientInfo: { name: 'arc', title: 'Arc', version: '0.1.0' },
        cwd: 'C:\\ws',
      });
      const opening = wire.startThread({ cwd: 'C:\\ws' });
      wire.receive(JSON.stringify({ id: sent.at(-1)!.id, result: { thread: { id: 'worker' } } }));
      await opening;
      let providerFinished: Promise<void> | undefined;
      vi.spyOn(child, 'guardedPrompt').mockImplementation((text, uuid) => {
        child.attempts.push(text);
        const attempt = new GuardedAttempt(uuid);
        // AgentSession stores its transient error after the wire settles the receipt.
        providerFinished = wire.prompt(text, attempt).then(
          () => {},
          (error: Error) => {
            child.lastError = `the agent would not take the prompt: ${error.message}`;
          },
        );
        if (race === 'reader') {
          // This observer runs before the delivery port's observer and clears mutable child evidence.
          void attempt.receipt.then(() => {
            policy.intervene('worker');
            child.lastError = null;
          });
        }
        assert.equal(sent.at(-1)!.method, 'turn/start');
        wire.receive(JSON.stringify({ id: sent.at(-1)!.id, error: { code: -32000, message } }));
        if (race === 'retired') found = null;
        return attempt;
      });
      const result = await send();
      assert.equal(result.status, 'unknown', race);
      assert.equal(
        result.reason,
        `Thread thread-7 already has an active writer. ${GUARDED_SEND_REASONS.unknown}`,
        race,
      );
      await providerFinished;
      wire.close('finished');
      vi.spyOn(child, 'guardedPrompt').mockImplementation((text, uuid) => {
        child.attempts.push(text);
        const attempt = new GuardedAttempt(uuid);
        attempt.markWritten();
        attempt.settle({ outcome: 'accepted', nativeTurnId: 'unexpected-turn', reason: '' });
        return attempt;
      });
    } else {
      child.lastError = message;
      assert.equal((await send()).reason, GUARDED_SEND_REASONS.ownership);
    }
    child.lastError = null;
    policy.intervene('worker');
    found = child;
    const refused = await send();
    assert.equal(refused.status, 'refused');
    assert.equal(refused.reason, GUARDED_SEND_REASONS.ownership);
    assert.equal(
      child.attempts.length,
      attempted ? 1 : 0,
      `a persistent writer conflict allowed further input: ${race}`,
    );
  }
});

test(
  'guarded exhaustion retains same-ID refusals and leaves the independent start and curation allowance usable',
  { tags: ['subprocess'] },
  async () => {
    const { channel, home } = await fixture();
    (channel as any).writes = new SessionWriteRequests(channel.hostId, 2);
    let handled = 0;
    channel.setGuardedSendHandler(async (request) => {
      handled += 1;
      return {
        version: 1,
        status: 'refused',
        requestId: request.id,
        payloadSha256: 'x',
        nativeTurnId: null,
        reason: GUARDED_SEND_REASONS.busy,
      };
    });
    const starts: unknown[] = [];
    channel.setRequestHandler((request) => {
      starts.push(request);
      return { status: 'accepted' };
    });
    const params = { sessionId: 'worker', prompt: 'Next.', observation: 'b'.repeat(40) + '.' + 'c'.repeat(43) };
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'coordinator');
    vi.stubEnv('CODEX_THREAD_ID', '');
    try {
      for (const n of [1, 2])
        assert.equal(
          ((await requestWindow('send', params, channel.hostId, home, `${channel.hostId}:busy-${n}`)) as any).reason,
          GUARDED_SEND_REASONS.busy,
        );
      await assert.rejects(requestWindow('send', params, channel.hostId, home, `${channel.hostId}:busy-3`), /limit/);
      const again = (await requestWindow('send', params, channel.hostId, home, `${channel.hostId}:busy-1`)) as any;
      assert.equal(again.reason, GUARDED_SEND_REASONS.busy);
      assert.equal(handled, 2, 'a same-ID duplicate observes the retained refusal');
      await assert.rejects(
        requestWindow('send', { ...params, prompt: 'Other.' }, channel.hostId, home, `${channel.hostId}:busy-1`),
        /different request/,
      );
      const start = {
        setup: { kind: 'custom' as const, agent: 'claude', model: '', effort: '', permissionMode: '' },
        prompt: 'Start.',
        agentRun: true,
        pinned: false,
        labels: [] as string[],
      };
      assert.equal(
        ((await requestWindow('start', start, channel.hostId, home, `${channel.hostId}:start-1`)) as any).status,
        'accepted',
      );
      assert.equal(
        (
          (await requestWindow(
            'curate',
            { sessionId: 'worker', action: 'pin', dryRun: false, force: false },
            channel.hostId,
            home,
            `${channel.hostId}:curate-1`,
          )) as any
        ).status,
        'accepted',
      );
      assert.equal(starts.length, 2);
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

test(
  'session reads and guarded starts carry the requester provider only to a window that lists it',
  { tags: ['subprocess'] },
  async () => {
    const { channel, home } = await fixture();
    const seen: any[] = [];
    channel.setRequestHandler((request) => {
      seen.push(request);
      return request.method === 'start' ? { status: 'accepted' } : { state: 'current', turns: [] };
    });
    const start = {
      setup: { kind: 'custom' as const, agent: 'codex', model: '', effort: '', permissionMode: '' },
      prompt: 'Start.',
      agentRun: false,
      pinned: false,
      labels: [] as string[],
    };
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', '');
    vi.stubEnv('CODEX_THREAD_ID', 'coordinator');
    try {
      await requestWindow('session', { sessionId: 'worker', turns: 5 }, channel.hostId, home);
      await requestWindow('start', start, channel.hostId, home, `${channel.hostId}:plain`);
      await requestWindow('start', start, channel.hostId, home, `${channel.hostId}:guarded`, true);
      assert.deepEqual(
        seen.map((request) => [request.method, request.requester, request.requesterProvider]),
        [
          ['session', 'coordinator', 'codex'],
          ['start', 'coordinator', undefined],
          ['start', 'coordinator', 'codex'],
        ],
      );
      // A window that predates the field refuses it, so the CLI omits it there and refuses send before connecting.
      const registration = path.join(home, 'hosts', `${channel.hostId}.json`);
      const listed = JSON.parse(fs.readFileSync(registration, 'utf8'));
      assert.deepEqual(listed.capabilities, [
        'requesterProvider',
        'sessionQuery',
        'sessionQueryShorthandV1',
        'launchPolicy',
      ]);
      delete listed.capabilities;
      fs.writeFileSync(registration, JSON.stringify(listed));
      for (const extra of [{ readOnly: true }, { cwd: home }, { readOnly: true, readTools: ['mcp__server__read'] }]) {
        const before = seen.length;
        await assert.rejects(
          requestWindow('start', { ...start, ...extra }, channel.hostId, home),
          /does not support read-only starts/,
        );
        assert.equal(seen.length, before, 'unsupported launch permissions reached an older window');
      }
      await requestWindow('start', start, channel.hostId, home, `${channel.hostId}:old`, true);
      assert.equal('requesterProvider' in seen.at(-1), false);
      await assert.rejects(
        requestWindow(
          'send',
          { sessionId: 'worker', prompt: 'Next.', observation: 'b.' + 'c'.repeat(43) },
          channel.hostId,
          home,
          `${channel.hostId}:send`,
        ),
        /must reload/,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

test(
  'queue sends negotiate capability before transport and retain the observation-free shape',
  { tags: ['subprocess'] },
  async () => {
    const { channel, home, entry } = await fixture();
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'unrelated');
    vi.stubEnv('CODEX_THREAD_ID', '');
    const params = { sessionId: 'target', prompt: '  exact\nmessage  ' };
    const id = channel.hostId + ':queue';
    await assert.rejects(requestWindow('send', params, channel.hostId, home, id), /reload.*queue messages/);
    await assert.rejects(
      requestWindow('send', { ...params, delivery: 'auto' }, channel.hostId, home, id),
      /reload.*deliver messages/,
    );
    let calls = 0;
    channel.setGuardedSendHandler(async (request) => {
      calls++;
      return {
        version: 1,
        status: 'queued',
        requestId: request.id,
        payloadSha256: 'digest',
        nativeTurnId: null,
        queuedSubmissionId: 'entry',
        reason: '',
      };
    });
    const admitted: any = await requestWindow('send', params, channel.hostId, home, id);
    assert.equal(admitted.status, 'queued');
    assert.deepEqual(await requestWindow('send', params, channel.hostId, home, id), admitted);
    assert.equal(calls, 1);
    const auto: any = await requestWindow(
      'send',
      { ...params, delivery: 'auto' },
      channel.hostId,
      home,
      channel.hostId + ':auto',
    );
    assert.equal(auto.status, 'queued');
    await assert.rejects(
      requestWindow('send', params, channel.hostId, home, channel.hostId + ':auto'),
      /different request/,
    );
    const observation = 'a'.repeat(40) + '.' + 'b'.repeat(43);
    for (const invalid of [
      { ...params, delivery: 'queue' },
      { ...params, delivery: undefined },
      { ...params, delivery: 'auto', observation },
    ])
      assert.equal(
        parseSessionRequest({
          id: channel.hostId + ':bad',
          version: 1,
          token: entry.token,
          method: 'send',
          requester: 'unrelated',
          requesterProvider: 'claude',
          params: invalid,
        }),
        null,
      );
    await assert.rejects(
      requestWindow('send', { ...params, observation }, channel.hostId, home, id),
      /different request/,
    );
    for (const observation of ['', 'malformed', undefined])
      assert.equal(
        parseSessionRequest({
          id: channel.hostId + ':bad',
          version: 1,
          token: entry.token,
          method: 'send',
          requester: 'unrelated',
          requesterProvider: 'claude',
          params: { ...params, observation },
        }),
        null,
      );
  },
);
