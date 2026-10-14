import { revisionOf, supportedFileIdentity, type SessionFile } from './transcript';
import {
  guardedSourceRevision,
  guardedSourceIdentity,
  AgentReadSources,
  AGENT_SOURCE_LIMITS,
  sessionSourceAdmitted,
} from './sessionreads';
import { activeWriterFailure } from './composerview';
import { GuardedAttempt } from './agentwire.ts';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import filesystem from 'node:fs';
import * as net from 'node:net';
import * as crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import type { Duplex } from 'node:stream';
import { WindowsPipeServer } from './windowpipe.ts';
import { WINDOW_PIPE_SOURCE } from './windowpipe-source.ts';
import network from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import * as path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { tempDir } from './temproot.ts';
import {
  boundedSessionRead,
  encodeSessionCursor,
  readSessionCursor,
  sessionAttention,
  sessionReadStatus,
  sessionListingPage,
  sessionPageSources,
  sessionScopeDigest,
  sessionSourceKey,
  SESSION_PAGE_LIMITS,
  SESSION_READ_LIMITS,
  type SessionListingRow,
  type SessionPage,
  type SessionPageRequest,
} from './sessionreads.ts';
import { openReadWindow, closeReadWindow } from './readmeter.ts';
import { requestWindow, requesterIdentity } from './sessionrequests.ts';
import {
  GUARDED_SEND_REASONS,
  SessionReadObservations,
  runSessionRead,
  GuardedSends,
  SessionWriteRequests,
  archiveRefusal,
  guardedChannelSend,
  guardedDeliveryPort,
  guardedRefusal,
  guardedFactsWithCompaction,
  guardedPanelPorts,
  guardedStartContext,
  interveneOnReaderInput,
  recordGuardedStart,
  runGuardedSend,
  type GuardedOwner,
  type GuardedSendRequest,
  type GuardedTargetFacts,
} from './sessionwrites.ts';
import {
  OrderedReadOperations,
  projectAgentRead,
  currentAgentRead,
  type AgentReadRecord,
  type AgentReadSource,
} from './domain/read.ts';

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

test('read receipts contain only completed turns retained after the bounded response budget', () => {
  const directory = tempDir('read-receipt-budget-');
  const file = path.join(directory, 'session.jsonl');
  const records: unknown[] = [];
  for (let index = 1; index <= 3; index++) {
    const timestamp = `2026-10-08T12:00:0${index}Z`;
    records.push({
      type: 'user',
      promptId: `prompt-${index}`,
      sessionId: 'known',
      cwd: directory,
      timestamp,
      message: { role: 'user', content: index === 3 ? 'unfinished' : 'p'.repeat(22000) },
    });
    if (index < 3)
      records.push({
        type: 'assistant',
        timestamp,
        message: {
          id: `reply-${index}`,
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [{ type: 'text', text: 'answer' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
  }
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const stat = revisionOf(fs.statSync(file, { bigint: true }));
  const source = { agent: 'claude' as const, sessionId: 'known', file, size: stat.size, mtimeMs: stat.mtimeMs };
  let delivered: AgentReadRecord[] = [];
  const read = () =>
    boundedSessionRead(
      source,
      3,
      () => 'scope',
      'reader',
      [directory],
      undefined,
      (facts) => {
        delivered = facts.records;
        return 'signed';
      },
    );
  const result = read();
  assert.equal(result.turns.length, 2);
  assert.equal(
    delivered.length,
    1,
    JSON.stringify(result.turns.map(({ promptId, finished, endedAt }) => ({ promptId, finished, endedAt }))),
  );
  assert.equal(delivered[0].promptId, result.turns[1].promptId);
  assert.equal(result.turns[0].finished, false);
  assert.equal(delivered[0].sourceRevision, guardedSourceRevision(file));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= SESSION_READ_LIMITS.outputBytes);
  const overflow = boundedSessionRead(
    source,
    3,
    () => 'scope',
    'reader',
    [directory],
    undefined,
    () => 'x'.repeat(13000),
  );
  assert.equal('readObservation' in overflow, false);
});
import {
  CompactHost,
  CompactRequests,
  compactCommandPayload,
  COMPACT_LIMITS,
  type CompactBinding,
  type CompactChild,
} from './compactrequest';
import type { NativeEvent } from './agentwire';
import { CodexWire } from './codexwire.ts';
import { arcCliSpawner, childEnv } from './agenthost.ts';
import { DispatchReceipts } from './dispatchreceipts';
import { HostedDispatch } from './dispatchhost';
import {
  discoverWindows,
  hostAddress,
  validHostAddress,
  parseSessionRequest,
  pingWindow,
  SESSION_REQUEST_LIMITS,
  WINDOW_DISCOVERY_LIMITS,
  WindowChannel,
  type HostRegistration,
  type WindowInfo,
  type WindowState,
} from './sessionrequests.ts';

// These Node guards catch access, resource exhaustion, wrong-window discovery, and lifecycle leaks without browser startup.
const state: WindowState = { folders: [], scopeReady: true, panelReady: false, panelVisible: false };
const channels: WindowChannel[] = [];

const compactWindow = 'a'.repeat(24);
const compactPayload = {
  requestId: compactWindow + ':aaaaaaaa-1111-2222-3333-444444444444',
  window: compactWindow,
  self: true as const,
  afterTurn: true as const,
};
const compactBinding: CompactBinding = {
  activation: compactWindow,
  provider: 'codex',
  sessionId: 'self',
  childGeneration: 1,
  turn: 'root',
  submissionId: 'reader',
  readerRevision: 1,
};
const compactLiteral = `arc compact request --self --after-turn --request-id ${compactPayload.requestId} --window ${compactWindow} --json`;
function compactEvent(kind: 'toolStart' | 'toolEnd' | 'rootEnd', extra: Record<string, unknown> = {}): NativeEvent {
  return {
    provider: 'codex',
    sessionId: 'self',
    turnId: 'root',
    generation: null,
    evidence: {},
    kind,
    toolId: 'call',
    command: compactLiteral,
    foreground: true,
    success: true,
    ...extra,
  };
}

test('self compaction joins one live literal root call and acknowledges before the tool and exact turn finish', async () => {
  let clock = 0;
  const book = new CompactRequests(compactWindow, () => clock);
  assert.throws(() => book.admit(compactPayload, () => true), /live requesting tool/);
  book.observe(compactBinding, compactEvent('toolStart', { sessionId: 'foreign' }));
  assert.equal(book.ready(compactPayload), false);
  book.observe(compactBinding, compactEvent('toolStart', { foreground: false }));
  assert.equal(book.ready(compactPayload), false);
  book.observe(compactBinding, compactEvent('toolStart'));
  assert.equal(book.ready(compactPayload), true);
  const ack = book.admit(compactPayload, () => true);
  assert.equal(ack.state, 'queued');
  assert.deepEqual(
    book.admit({ ...compactPayload }, () => false),
    ack,
  );
  assert.throws(
    () => book.admit({ ...compactPayload, afterTurn: false } as unknown as typeof compactPayload, () => true),
    /different arguments/,
  );
  let writes = 0;
  let attempts = 0;
  const delivery = {
    eligible: () => true,
    submit: async (_binding: Readonly<CompactBinding>, check: () => void) => {
      attempts++;
      // A provider adapter reaches its write boundary after its own bookkeeping await.
      await Promise.resolve();
      check();
      writes++;
    },
  };
  await book.deliver(compactPayload.requestId, delivery);
  assert.equal(writes, 0);
  book.observe(compactBinding, compactEvent('toolEnd'));
  await book.deliver(compactPayload.requestId, delivery);
  assert.equal(writes, 0);
  book.observe(compactBinding, compactEvent('rootEnd', { turnId: 'another' }), true);
  await book.deliver(compactPayload.requestId, delivery);
  assert.equal(writes, 0);
  book.observe(compactBinding, compactEvent('rootEnd'), true);
  await Promise.all([
    book.deliver(compactPayload.requestId, delivery),
    book.deliver(compactPayload.requestId, delivery),
  ]);
  assert.equal(attempts, 1, 'a concurrent delivery must not reach the provider');
  assert.equal(writes, 1);
  assert.equal(book.status(compactPayload.requestId)?.state, 'uncertain');
  assert.deepEqual(
    book.admit(compactPayload, () => false),
    book.status(compactPayload.requestId),
  );
  book.nativeOutcome(compactPayload.requestId, { ...compactBinding, childGeneration: 2 }, 'completed');
  assert.equal(book.status(compactPayload.requestId)?.state, 'uncertain');
  book.nativeOutcome(compactPayload.requestId, compactBinding, 'completed');
  assert.equal(book.status(compactPayload.requestId)?.state, 'completed');
  book.nativeOutcome(compactPayload.requestId, compactBinding, 'failed');
  assert.equal(book.status(compactPayload.requestId)?.state, 'uncertain');
  clock = COMPACT_LIMITS.retentionMs * 2;
  assert.ok(book.status(compactPayload.requestId));
});

test('self compaction cancels synchronously across the adapter wait and the final provider write check', async () => {
  for (const reason of [
    'reader send',
    'steering',
    'queue',
    'Stop',
    'clear',
    'answer',
    'model',
    'effort',
    'permission',
    'replacement',
    'exit',
    'scope',
    'shutdown',
    'deadline',
  ]) {
    let clock = 0;
    const book = new CompactRequests(compactWindow, () => clock);
    book.observe(compactBinding, compactEvent('toolStart'));
    book.admit(compactPayload, () => true);
    book.observe(compactBinding, compactEvent('toolEnd'));
    book.observe(compactBinding, compactEvent('rootEnd'), true);
    let reach!: () => void;
    let writes = 0;
    const pending = book.deliver(compactPayload.requestId, {
      eligible: () => true,
      submit: async (_binding, check) => {
        // A provider adapter reaches its write boundary after its own bookkeeping await.
        await new Promise<void>((resolve) => {
          reach = resolve;
        });
        check();
        writes++;
      },
    });
    if (reason === 'shutdown') book.dispose();
    else if (reason === 'deadline') clock = COMPACT_LIMITS.admissionMs;
    else book.invalidate((b) => b.sessionId === 'self', reason);
    reach();
    await pending;
    assert.equal(writes, 0, reason);
    assert.equal(book.status(compactPayload.requestId)?.state, 'cancelled', reason);
    if (reason === 'deadline') assert.match(book.status(compactPayload.requestId)!.reason, /expired/);
  }
});

test('self compaction rejects failed tools, lost final responses, replay, full retention and expired assignments', async () => {
  for (const failure of ['tool', 'turn', 'final']) {
    const book = new CompactRequests(compactWindow);
    book.observe(compactBinding, compactEvent('toolStart'));
    book.admit(compactPayload, () => true);
    book.observe(compactBinding, compactEvent('toolEnd', { success: failure !== 'tool' }));
    book.observe(compactBinding, compactEvent('rootEnd', { success: failure !== 'turn' }), failure !== 'final');
    let writes = 0;
    await book.deliver(compactPayload.requestId, {
      eligible: () => true,
      submit: async () => {
        writes++;
      },
    });
    assert.equal(writes, 0, failure);
    assert.equal(book.status(compactPayload.requestId)?.state, 'failed');
  }
  let clock = 0;
  const book = new CompactRequests(compactWindow, () => clock, 1);
  book.observe(compactBinding, compactEvent('toolStart'));
  book.admit(compactPayload, () => true);
  clock = COMPACT_LIMITS.admissionMs;
  assert.equal(book.status(compactPayload.requestId)?.state, 'cancelled');
  assert.throws(
    () =>
      book.admit({ ...compactPayload, requestId: compactWindow + ':bbbbbbbb-1111-2222-3333-444444444444' }, () => true),
    /unavailable/,
  );
  clock += COMPACT_LIMITS.retentionMs;
  assert.equal(book.status(compactPayload.requestId), null);
  book.observe(compactBinding, compactEvent('toolStart'));
  assert.throws(() => book.admit(compactPayload, () => true), /already used/);
});

test('self compaction admits only exact literal POSIX or Windows foreground commands', () => {
  assert.deepEqual(compactCommandPayload(compactLiteral), compactPayload);
  assert.deepEqual(
    compactCommandPayload(
      '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "' + compactLiteral + '"',
    ),
    compactPayload,
  );
  for (const literal of [
    compactLiteral + ' &',
    compactLiteral + ' > result',
    'echo x; ' + compactLiteral,
    compactLiteral.replace(compactWindow, '$ARC_WINDOW'),
    compactLiteral.replace('--self', '--session foreign'),
    compactLiteral.replace('--json', '--json --json'),
  ])
    assert.equal(compactCommandPayload(literal), null, literal);
});

// Catches a refused Windows Codex request. The Codex app-server reports these exact command strings for a bare
// literal with no single quote: the path keeps doubled backslashes, the script sits in single quotes, and
// `-NoProfile` sometimes precedes `-Command`.
test('self compaction admits the PowerShell wrappers Codex reports and nothing composed around them', () => {
  const executable = String.raw`"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"`;
  for (const command of [
    `${executable} -Command '${compactLiteral}'`,
    `${executable} -NoProfile -Command '${compactLiteral}'`,
    `${executable} -Command "${compactLiteral}"`,
    `powershell.exe -Command '${compactLiteral}'`,
    `"pwsh.exe" -NoProfile -Command '${compactLiteral}'`,
    String.raw`"C:\Program Files (x86)\PowerShell\7\pwsh.exe" -Command '` + compactLiteral + "'",
  ])
    assert.deepEqual(compactCommandPayload(command), compactPayload, command);
  for (const command of [
    `${executable} -Command '${compactLiteral}"`,
    `${executable} -Command '${compactLiteral}; echo x'`,
    `${executable} -Command '${compactLiteral}' -NoExit`,
    `${executable} -ExecutionPolicy Bypass -Command '${compactLiteral}'`,
    `${executable} -NoProfile -NoProfile -Command '${compactLiteral}'`,
    `${executable} -NoLogo -Command '${compactLiteral}'`,
    `${executable} -Command '$(${compactLiteral})'`,
    `${executable} -Command '${compactLiteral.replace(compactWindow, '$env:ARC_WINDOW')}'`,
    String.raw`C:\\Windows\\powershell.exe -Command '` + compactLiteral + "'",
    `"cmd.exe" -Command '${compactLiteral}'`,
    `${executable}  -Command '${compactLiteral}'`,
    String.raw`"C:\$(Write-Output injected)\powershell.exe" -Command '` + compactLiteral + "'",
    '"C:\\a`b\\powershell.exe" -Command \'' + compactLiteral + "'",
    String.raw`"C:\a;b\powershell.exe" -Command '` + compactLiteral + "'",
  ])
    assert.equal(compactCommandPayload(command), null, command);
});

test('self compaction completion joins native command evidence without confusing acceptance with completion', async () => {
  for (const provider of ['claude', 'codex'] as const) {
    const observedStates: (string | undefined)[] = [];
    const binding = { ...compactBinding, provider, turn: provider === 'claude' ? '1' : 'root' };
    const book = new CompactRequests(compactWindow);
    const base = {
      provider,
      sessionId: 'self',
      turnId: provider === 'codex' ? 'root' : null,
      generation: provider === 'claude' ? 1 : null,
      evidence: {},
    };
    book.observe(binding, { ...base, kind: 'toolStart', command: compactLiteral, toolId: 'call', foreground: true });
    book.admit(compactPayload, () => true);
    book.observe(binding, { ...base, kind: 'toolEnd', toolId: 'call', success: true });
    book.observe(binding, { ...base, kind: 'rootEnd', success: true }, true);
    const compact = (
      stage: 'accepted' | 'status' | 'boundary' | 'turnStart' | 'itemStart' | 'itemEnd' | 'turnEnd',
      evidence = {},
    ) =>
      book.observeSubmitted(
        {
          ...base,
          kind: 'compact',
          turnId: provider === 'codex' ? 'compact' : null,
          generation: 2,
          stage,
          evidence,
        },
        binding.childGeneration,
      );
    let writes = 0;
    await book.deliver(compactPayload.requestId, {
      eligible: () => true,
      submit: async (_binding, check) => {
        check();
        writes++;
        book.observeSubmitted(
          { ...base, kind: 'submission', text: '/compact', generation: 2 },
          binding.childGeneration,
        );
        if (provider === 'claude') compact('status', { status: 'compacting' });
        else compact('turnStart');
        observedStates.push(book.status(compactPayload.requestId)?.state);
        if (provider === 'claude') {
          compact('status', { compact_result: 'success' });
          compact('boundary', { compact_metadata: { trigger: 'auto' } });
          compact('turnEnd', { subtype: 'success', is_error: false, local_command: 'compact' });
          observedStates.push(book.status(compactPayload.requestId)?.state);
          compact('boundary', { compact_metadata: { trigger: 'manual' } });
        } else {
          compact('itemStart', { item: { id: 'compact-item' } });
          compact('itemEnd', { item: { id: 'wrong-item' } });
          compact('turnEnd', { turn: { status: 'completed' } });
          observedStates.push(book.status(compactPayload.requestId)?.state);
          compact('itemEnd', { item: { id: 'compact-item' } });
          compact('accepted');
        }
      },
    });
    assert.equal(writes, 1);
    assert.deepEqual(observedStates, ['started', 'started']);
    assert.equal(book.status(compactPayload.requestId)?.state, 'completed');
  }
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
  assert.match(archiveRefusal({ ...row, attention: 'unread' }, false)!, /--force/);
  assert.equal(archiveRefusal({ ...row, attention: 'unread' }, true), null);
  const active = [
    ...(['running', 'waiting'] as const).map((runStatus) => ({ runStatus })),
    ...(['running', 'input'] as const).map((attention) => ({ attention })),
  ];
  for (const live of active) {
    assert.match(archiveRefusal({ ...row, ...live }, false)!, /running or needs input\. Use --force/);
    for (const facts of ['current', 'stale', 'unparsed'] as const)
      for (const attention of ['idle', 'unread', 'unknown'] as const)
        assert.equal(archiveRefusal({ ...row, attention, ...live, facts }, true), null, JSON.stringify(live));
  }
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
      'The session state is unavailable. Show Arc and retry.',
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
            /^Arc cannot tell whether background work in the session ended, and archive can end it\./,
            label,
          );
          assert.doesNotMatch(reason ?? '', /--force/, label);
        }
});

test('the authenticated window channel retains write acceptance across a disconnected caller and rejects conflicting retries', async () => {
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
});
const sockets: Duplex[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(channels.splice(0).map((channel) => channel.dispose()));
});

async function fixture(
  limits = { ...SESSION_REQUEST_LIMITS } as {
    lineBytes: number;
    lineDeadlineMs: number;
    connections: number;
    inFlight: number;
  },
  handler?: ConstructorParameters<typeof WindowChannel>[2],
) {
  const home = tempDir('window-channel-');
  const channel = new WindowChannel(home, limits, handler);
  channels.push(channel);
  await channel.update(state);
  const file = path.join(home, 'hosts', `${channel.hostId}.json`);
  const entry = JSON.parse(fs.readFileSync(file, 'utf8')) as HostRegistration;
  return { home, channel, file, entry };
}

function request(entry: HostRegistration, changes = {}) {
  return { id: 'request-1', version: 1, token: entry.token, method: 'ping', requester: null, params: {}, ...changes };
}

async function connect(address: string): Promise<net.Socket> {
  const socket = net.createConnection(address);
  sockets.push(socket);
  socket.on('error', () => {});
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return socket;
}

function closed(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => socket.once('close', () => resolve()));
}

function reply(socket: net.Socket): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let text = '';
    socket.on('data', (chunk) => {
      text += chunk.toString();
      if (text.includes('\n')) resolve(JSON.parse(text.split('\n')[0]));
    });
    socket.once('close', () => reject(new Error('Channel closed before its reply.')));
  });
}

test('addresses use Windows pipes and bounded macOS and Linux socket paths', () => {
  const id = 'a'.repeat(24);
  assert.equal(hostAddress('/Arc/Home', id, 'win32'), `\\\\.\\pipe\\arc-${id}`);
  for (const platform of ['darwin', 'linux'] as const) {
    const home = '/Arc/MixedCase/Home';
    assert.equal(hostAddress(home, id, platform), path.posix.join(home, 'hosts', `${id}.sock`));
    const longHome = path.posix.join(home, 'MixedCase'.repeat(20));
    const address = hostAddress(longHome, id, platform, '/tmp');
    assert.equal(Buffer.byteLength(address) < 104, true);
    assert.notEqual(address, hostAddress(longHome + 'other', id, platform, '/tmp'));
    const macRoot = '/var/folders/ab/abcdefghijklmnopqrstuvwxyz012345/T';
    const published = hostAddress(longHome, id, platform, macRoot);
    assert.equal(Buffer.byteLength(published) < 104, true);
    assert.equal(validHostAddress(longHome, id, published, platform), true);
    assert.equal(validHostAddress(longHome, id, published.replace('/var/', '/var\0/'), platform), false);
    assert.notEqual(published, hostAddress(longHome, id, platform, '/var/tmp'));
    assert.equal(validHostAddress(longHome, id, published.replace('a-', 'other-'), platform), false);
    assert.equal(validHostAddress(longHome, id, published.replace(id, 'b'.repeat(24)), platform), false);
    assert.equal(validHostAddress(longHome, id, published, 'win32'), false);
    const oversizedRoot = '/TemporaryMixedCase'.repeat(20);
    assert.equal(hostAddress(longHome, id, platform, oversizedRoot).startsWith('/tmp/'), true);
  }
  assert.throws(() => hostAddress('/home', '../other', 'linux'));
});

test('request schema rejects unsupported versions, methods, identifiers, and parameters', () => {
  const valid = request({ token: 'b'.repeat(64) } as HostRegistration);
  assert.deepEqual(parseSessionRequest(valid), valid);
  for (const invalid of [
    null,
    [],
    {},
    { ...valid, id: '' },
    { ...valid, id: 1 },
    { ...valid, id: 'a'.repeat(129) },
    { ...valid, version: 2 },
    { ...valid, token: 'no' },
    { ...valid, method: 'start' },
    { ...valid, params: null },
    { ...valid, params: { value: 1 } },
    { ...valid, requester: [] },
    { ...valid, requester: '' },
    { ...valid, extra: true },
    { ...valid, method: 'sessions', replyBytes: 1000 },
    { ...valid, method: 'sessions', params: { replyBytes: 1000 } },
    { ...valid, method: 'sessions', params: { sessionId: 'known' } },
    { ...valid, method: 'sessions', params: { limit: 0 } },
    { ...valid, method: 'sessions', params: { limit: 129 } },
    { ...valid, method: 'sessions', params: { limit: 1.5 } },
    { ...valid, method: 'sessions', params: { limit: '5' } },
    { ...valid, method: 'sessions', params: { cursor: '' } },
    { ...valid, method: 'sessions', params: { cursor: 'a'.repeat(513) } },
    { ...valid, method: 'sessions', params: { cursor: 'abc=' } },
    { ...valid, method: 'sessions', params: { cursor: 7 } },
  ]) {
    assert.equal(parseSessionRequest(invalid), null);
  }
  for (const params of [{ cursor: 'A-_z'.repeat(128), limit: 128 }, { limit: 1 }, { cursor: 'c' }]) {
    const paged = { ...valid, method: 'sessions', params };
    assert.deepEqual(parseSessionRequest(paged), paged);
  }
});

test('session requests reject paths, extra parameters, and invalid turn counts before dispatch', async () => {
  const { home, channel, entry } = await fixture();
  const valid = request(entry, { method: 'session', params: { sessionId: 'known', turns: 2 } });
  assert.deepEqual(parseSessionRequest(valid), valid);
  for (const params of [
    { sessionId: 'known', turns: 0 },
    { sessionId: 'known', turns: 21 },
    { sessionId: 'known', turns: 1.5 },
    { sessionId: 'known', turns: 1, file: '/other' },
  ])
    assert.equal(parseSessionRequest({ ...valid, params }), null);
  channel.setRequestHandler((value) => {
    if (value.params.sessionId !== 'known') throw new Error('Unknown session.');
    return { session: value.params.sessionId, turns: value.params.turns, requester: value.requester };
  });
  const result = await requestWindow('session', valid.params, channel.hostId, home);
  assert.equal((result as any).session, 'known');
  await assert.rejects(
    requestWindow('session', { sessionId: '/other/file', turns: 1 }, channel.hostId, home),
    /Unknown session/,
  );
  const second = new WindowChannel(home);
  channels.push(second);
  await second.update(state);
  await assert.rejects(requestWindow('sessions', {}, '', home), /Select one Arc window/);
});

test.each(['sessions', 'session', 'setups', 'compact-ready', 'compact-status'] as const)(
  'a busy ready window answers %s reads after the discovery deadline',
  async (method) => {
    const { home, channel } = await fixture();
    await channel.update({ ...state, panelReady: true, panelVisible: true });
    let answer!: (value: unknown) => void;
    const handler = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    channel.setRequestHandler(handler);
    channel.setCompactRequestHandler(handler);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const params =
      method === 'session'
        ? { sessionId: 'known', turns: 1 }
        : method === 'compact-status'
          ? { requestId: channel.hostId + ':aaaaaaaa-1111-2222-3333-444444444444' }
          : method === 'compact-ready'
            ? {
                ...compactPayload,
                window: channel.hostId,
                requestId: channel.hostId + ':aaaaaaaa-1111-2222-3333-444444444444',
              }
            : {};
    const result = requestWindow(method, params, channel.hostId, home);
    const completed = result.then(
      (value) => ({ value }),
      (error: Error) => ({ error: error.message }),
    );
    await vi.waitFor(() => assert.equal(typeof answer, 'function'));
    await vi.advanceTimersByTimeAsync(2_100);
    answer({ sessionId: 'known', turns: [{ responseSummary: 'Still available.' }] });
    assert.deepEqual(await completed, {
      value: { sessionId: 'known', turns: [{ responseSummary: 'Still available.' }] },
    });
  },
);

test.each(['sessions', 'session'] as const)(
  'a silent ready window bounds %s reads and names the timeout',
  async (method) => {
    const { home, channel, file } = await fixture();
    await channel.update({ ...state, panelReady: true, panelVisible: true });
    let admitted = false;
    channel.setRequestHandler(() => {
      admitted = true;
      return new Promise(() => {});
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const result = requestWindow(
      method,
      method === 'session' ? { sessionId: 'known', turns: 1 } : {},
      channel.hostId,
      home,
    );
    const rejection = assert.rejects(result, /The selected Arc window did not answer in time\./);
    await vi.waitFor(() => assert.equal(admitted, true));
    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
    assert.equal(fs.existsSync(file), true);
  },
);

test.runIf(process.platform === 'win32')(
  'a vanished Windows pipe remains unavailable when a session read expires before connecting',
  async () => {
    const { home, entry } = await fixture();
    const hostId = crypto.randomBytes(12).toString('hex');
    const address = hostAddress(home, hostId);
    const file = path.join(home, 'hosts', `${hostId}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...entry, hostId, address }));
    const connect = WindowsPipeServer.connect;
    let socket: Duplex | undefined;
    let connected = false;
    vi.spyOn(WindowsPipeServer, 'connect').mockImplementation(async (...args) => {
      socket = await connect(...args);
      socket.on('connect', () => {
        connected = true;
      });
      return socket;
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const result = requestWindow('session', { sessionId: 'known', turns: 1 }, hostId, home);
    const completed = result.then(
      (value) => ({ value }),
      (error: Error) => ({ error: error.message }),
    );
    await vi.waitFor(() => assert.ok(socket));
    await vi.advanceTimersByTimeAsync(5_000);
    assert.deepEqual(await completed, { error: 'The selected Arc window is unavailable.' });
    assert.equal(connected, false);
    assert.equal(fs.existsSync(file), true);
  },
);

test('a disconnected or unreadable window remains unavailable for session reads', async () => {
  const { home, channel, file } = await fixture();
  let admitted = false;
  channel.setRequestHandler(() => {
    admitted = true;
    return new Promise(() => {});
  });
  const result = requestWindow('session', { sessionId: 'known', turns: 1 }, channel.hostId, home);
  const rejection = assert.rejects(result, /The selected Arc window is unavailable\./);
  await vi.waitFor(() => assert.equal(admitted, true));
  await channel.dispose();
  await rejection;
  fs.writeFileSync(file, '{}');
  await assert.rejects(requestWindow('sessions', {}, channel.hostId, home), /The selected Arc window is unavailable\./);
});

test('bounded session reads preserve native provider turns and reject stale scope and source revisions', () => {
  const directory = tempDir('session-read-');
  for (const agent of ['claude', 'codex'] as const) {
    const file = path.join(directory, `${agent}.jsonl`);
    const head =
      agent === 'claude'
        ? {
            type: 'user',
            promptId: 'first',
            sessionId: 'known',
            cwd: directory,
            timestamp: '2026-10-08T12:00:00Z',
            message: { role: 'user', content: 'first prompt' },
          }
        : {
            type: 'session_meta',
            timestamp: '2026-10-08T12:00:00Z',
            payload: { id: 'known', cwd: directory, source: 'cli' },
          };
    const records: unknown[] = [head, { type: 'ignored', text: 'x'.repeat(SESSION_READ_LIMITS.bytes * 2) }];
    for (let n = 1; n <= 3; n++) {
      const timestamp = `2026-10-08T12:00:0${n}Z`;
      if (agent === 'claude')
        records.push(
          {
            type: 'user',
            promptId: `prompt-${n}`,
            sessionId: 'known',
            cwd: directory,
            timestamp,
            message: { role: 'user', content: `prompt ${n}` },
          },
          {
            type: 'assistant',
            timestamp,
            message: {
              id: `reply-${n}`,
              role: 'assistant',
              model: 'claude-opus-5-5',
              content: [{ type: 'text', text: `answer ${n}` }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
        );
      else
        records.push(
          { type: 'event_msg', timestamp, payload: { type: 'task_started', turn_id: `turn-${n}` } },
          { type: 'turn_context', timestamp, payload: { turn_id: `turn-${n}`, model: 'gpt-6.1-sol', effort: 'high' } },
          { type: 'event_msg', timestamp, payload: { type: 'user_message', message: `prompt ${n}` } },
          {
            type: 'event_msg',
            timestamp,
            payload: { type: 'task_complete', turn_id: `turn-${n}`, last_agent_message: `answer ${n}` },
          },
        );
    }
    fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    const stat = revisionOf(fs.statSync(file, { bigint: true }));
    const source = { agent, file, sessionId: 'known', size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
    const window = openReadWindow();
    const result = boundedSessionRead(source, 2, () => 'scope', 'local-agent', [directory]);
    const tally = closeReadWindow(window);
    assert.ok(tally.bytes <= 512 * 1024, `${agent} read ${tally.bytes} bytes`);
    assert.equal(result.state, 'current');
    assert.equal(result.partial, true);
    assert.equal(result.turns.length, 2);
    assert.equal(result.turns[0].prompt, 'prompt 3');
    assert.equal(result.turns[0].summary, 'answer 3');
    assert.equal(result.requester, 'local-agent');
    assert.equal('observation' in result, false);
    const sourceFacts = new AgentReadSources().resolve(source, () => 'scope', [directory])!;
    assert.equal(sourceFacts.identitiesComplete, true);
    let completed = 0;
    const partial = boundedSessionRead(
      source,
      2,
      () => 'scope',
      'local-agent',
      [directory],
      undefined,
      (facts) => {
        completed = facts.records.length;
        for (const record of facts.records) assert.equal(currentAgentRead(record, sourceFacts), true);
        return 'signed';
      },
    );
    assert.equal(partial.partial, true);
    assert.equal(completed, 2);
    assert.equal('readObservation' in partial, true);
    const observed = boundedSessionRead(
      source,
      2,
      () => 'scope',
      'local-agent',
      [directory],
      (facts) => JSON.stringify(facts),
    ) as { observation?: string; turns: { promptId: string }[] };
    assert.deepEqual(JSON.parse(observed.observation!), {
      scope: 'scope',
      sourceRevision: guardedSourceRevision(file),
      latestTurn: observed.turns[0].promptId,
    });
    assert.equal(
      'observation' in
        boundedSessionRead(
          source,
          2,
          () => 'scope',
          null,
          [directory],
          () => null,
        ),
      false,
    );
    assert.equal(
      boundedSessionRead({ ...source, dev: '999999999999999999999' }, 2, () => 'scope', null, [directory]).state,
      'stale',
    );
    assert.equal(boundedSessionRead(source, 2, () => 'scope', null, [path.join(directory, 'other')]).state, 'stale');
    let calls = 0;
    const stale = boundedSessionRead(source, 2, () => (++calls === 1 ? 'before' : 'after'), null, [directory]);
    assert.equal(stale.state, 'stale');
    assert.deepEqual(stale.turns, []);
    calls = 0;
    const changed = boundedSessionRead(
      source,
      2,
      () => {
        if (++calls === 2) fs.appendFileSync(file, '\n');
        return 'scope';
      },
      null,
      [directory],
    );
    assert.equal(changed.state, 'stale');
    assert.deepEqual(changed.turns, []);
  }
  // A latest turn too large for the response leaves the reply without that turn, so it carries no observation.
  const file = path.join(directory, 'oversized.jsonl');
  const prompt = (content: string, timestamp: string) => ({
    type: 'user',
    sessionId: 'known',
    cwd: directory,
    timestamp,
    message: { role: 'user', content },
  });
  const reply = (n: number, timestamp: string) => ({
    type: 'assistant',
    timestamp,
    message: {
      id: `reply-${n}`,
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text: `answer ${n}` }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  const records = [
    prompt('small prompt', '2026-10-08T12:00:01Z'),
    reply(1, '2026-10-08T12:00:01Z'),
    prompt('y'.repeat(SESSION_READ_LIMITS.outputBytes), '2026-10-08T12:00:02Z'),
    reply(2, '2026-10-08T12:00:02Z'),
  ];
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const stat = revisionOf(fs.statSync(file, { bigint: true }));
  const source = {
    agent: 'claude' as const,
    file,
    sessionId: 'known',
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ino: stat.ino,
  };
  const oversized = boundedSessionRead(
    source,
    2,
    () => 'scope',
    'local-agent',
    [directory],
    () => 'signed',
  );
  assert.equal(oversized.state, 'current');
  assert.deepEqual(oversized.turns, []);
  assert.equal('observation' in oversized, false);
});

test('session replies with valid large window metadata refuse excess envelope bytes without losing the channel', async () => {
  const data = { content: 'x'.repeat(48 * 1024 - 1000) };
  const { home, channel } = await fixture();
  channel.setRequestHandler(() => data);
  const folders = Array.from({ length: 12 }, (_, n) => `C:/project-${n}/${'folder'.repeat(280)}`);
  await channel.update({ ...state, folders });
  for (const method of ['sessions', 'session'] as const) {
    await assert.rejects(
      requestWindow(method, method === 'session' ? { sessionId: 'known', turns: 1 } : {}, channel.hostId, home),
      /session response exceeds.*channel limit/,
    );
  }
  let replyBytes = 0;
  let extra = 0;
  channel.setRequestHandler((request) => {
    replyBytes = request.replyBytes ?? -1;
    return { fill: 'x'.repeat(replyBytes - Buffer.byteLength('{"fill":""}') + extra) };
  });
  const filled = await requestWindow('sessions', {}, channel.hostId, home);
  assert.ok(replyBytes > 0 && replyBytes < SESSION_READ_LIMITS.outputBytes);
  assert.equal(pageBytes(filled), replyBytes);
  extra = 1;
  await assert.rejects(requestWindow('sessions', {}, channel.hostId, home), /channel limit/);
  channel.setRequestHandler((request) => {
    void channel.update({ ...state, folders: [...folders, 'C:/added-during-the-read'] });
    return { fill: 'x'.repeat(request.replyBytes! - Buffer.byteLength('{"fill":""}')) };
  });
  assert.ok(pageBytes(await requestWindow('sessions', {}, channel.hostId, home)) > 0);
  await channel.update({ ...state, folders });
  channel.setRequestHandler((request) => ({ replyBytes: request.replyBytes ?? null }));
  assert.deepEqual(await requestWindow('session', { sessionId: 'known', turns: 1 }, channel.hostId, home), {
    replyBytes: null,
  });
  const files = Array.from({ length: 300 }, (_, n) => pageFile(n));
  channel.setRequestHandler((request) => listPage(files, null, { replyBytes: request.replyBytes, row: variedName }));
  const page = (await requestWindow('sessions', {}, channel.hostId, home)) as SessionPage;
  assert.ok(page.next && page.sessions.length > 0 && pageBytes(page) <= replyBytes);
  channel.setRequestHandler(() => ({ complete: false, notes: ['Bounded listing.'] }));
  assert.deepEqual(await requestWindow('sessions', {}, channel.hostId, home), {
    complete: false,
    notes: ['Bounded listing.'],
  });
});

test('session attention stays unknown for hidden panels and unavailable facts', () => {
  assert.equal(sessionAttention(false, 'waiting', true), 'unknown');
  assert.equal(sessionAttention(true, 'waiting', false), 'input');
  for (const status of ['running', 'subagents', 'background'] as const)
    assert.equal(sessionAttention(true, status, false), 'running');
  assert.equal(sessionAttention(true, 'done', true), 'unread');
  assert.equal(sessionAttention(true, 'done', false), 'idle');
  assert.equal(sessionAttention(true, undefined, null), 'unknown');
});

const pageSecret = crypto.randomBytes(32);
const pageScope = sessionScopeDigest('mixed-case scope');
let pageProjections = 0;
type PageOptions = Partial<SessionPageRequest<SessionFile>> & {
  row?: (session: SessionFile) => Partial<SessionListingRow>;
  current?: (session: SessionFile) => boolean;
};

function pageFile(n: number, changes: Partial<SessionFile> = {}): SessionFile {
  return {
    agent: n % 2 ? 'codex' : 'claude',
    file: `C:/Users/Mixed/Sessions/${n}.jsonl`,
    sessionId: `session-${n}`,
    mtimeMs: 1,
    size: 10,
    dev: '7',
    ino: String(1000 + n),
    ...changes,
  };
}

function listPage(files: SessionFile[], cursor: string | null, options: PageOptions = {}): SessionPage {
  const { row, current, ...request } = options;
  const check = cursor === null ? null : readSessionCursor(cursor, pageSecret, pageScope);
  if (check && check.status !== 'valid') throw new Error(`Cursor ${check.status}.`);
  return sessionListingPage({
    sources: sessionPageSources(files),
    cursor: check?.status === 'valid' ? check.body : null,
    limit: 128,
    catalog: 'complete',
    fresh: true,
    scope: pageScope,
    secret: pageSecret,
    requester: null,
    project: ({ session }) => {
      pageProjections++;
      return {
        row: {
          id: session.sessionId,
          provider: session.agent,
          name: `Session ${session.sessionId}`,
          setup: { model: 'model', effort: 'high', source: 'recorded' },
          labels: [],
          pinned: false,
          archived: false,
          runStatus: 'done',
          attention: 'idle',
          lastActivity: 1,
          parent: null,
          agentRun: false,
          facts: 'current',
          ...row?.(session),
        },
        current: current?.(session) ?? true,
      };
    },
    ...request,
  });
}

function traverse(files: (page: number) => SessionFile[], options: (page: number) => PageOptions = () => ({})) {
  const pages: SessionPage[] = [];
  let cursor: string | null = null;
  do {
    const page = listPage(files(pages.length), cursor, options(pages.length));
    pages.push(page);
    cursor = page.next;
  } while (cursor && pages.length < 2000);
  assert.equal(cursor, null);
  return pages;
}

const pageBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
// Row sizes vary, so pages end at different distances from their budget.
const variedName = (session: SessionFile) => ({
  name: 'n'.repeat(400 + ((Number(session.sessionId.slice('session-'.length)) * 7919) % 600)),
});

// Agents must read every scoped session when the catalog exceeds one page of rows or of bytes.
test('session pages reach every source exactly once above the row and byte limits in measured pages', () => {
  const files = Array.from({ length: 300 }, (_, n) => pageFile(n));
  const keys = sessionPageSources(files).map((entry) => entry.source);
  for (const replyBytes of [undefined, 6000]) {
    pageProjections = 0;
    const pages = traverse(
      () => files,
      () => ({ replyBytes, row: variedName }),
    );
    const served = pages.flatMap((page) => page.sessions.map((row) => row.source));
    assert.deepEqual(served, keys);
    assert.ok(pages.reduce((sum, page) => sum + pageBytes(page), 0) > 4 * SESSION_READ_LIMITS.outputBytes);
    assert.ok(pages.length > 300 / SESSION_PAGE_LIMITS.rows + 1);
    assert.ok(pageProjections <= files.length + pages.length);
    for (const [index, page] of pages.entries()) {
      assert.ok(pageBytes(page) <= Math.min(SESSION_READ_LIMITS.outputBytes, replyBytes ?? Infinity));
      assert.ok(page.sessions.length > 0);
      assert.equal(page.complete, index === pages.length - 1);
      assert.equal(page.coverage, 'complete');
      assert.equal(page.freshness, 'current');
    }
  }
  const noted = traverse(
    () => files,
    () => ({
      replyBytes: 6000,
      fresh: false,
      row: (session) => ({ ...variedName(session), facts: 'stale', attention: 'unknown' }),
    }),
  );
  assert.deepEqual(
    noted.flatMap((page) => page.sessions.map((row) => row.source)),
    keys,
  );
  for (const page of noted) assert.ok(page.notes.length === 3 && pageBytes(page) <= 6000);
  const rows = traverse(
    () => files,
    () => ({ limit: 7 }),
  );
  assert.ok(rows.every((page) => page.sessions.length <= 7));
  assert.equal(rows.length, Math.ceil(300 / 7));
});

// A forged or stale cursor must refuse instead of serving a wrong or empty page, and every cursor stays short.
test('session cursors refuse forgery, modification, truncation, other secrets, and foreign bodies, and report scope changes separately', () => {
  const files = Array.from({ length: 3 }, (_, n) => pageFile(n, { sessionId: `${'L'.repeat(100_000)}${n}` }));
  const first = listPage(files, null, { limit: 1 });
  const cursor = first.next!;
  assert.ok(cursor.length <= 512);
  assert.equal(readSessionCursor(cursor, pageSecret, pageScope).status, 'valid');
  const bytes = Buffer.from(cursor, 'base64url');
  const flipped = (index: number) => {
    const copy = Buffer.from(bytes);
    copy[index] ^= 1;
    return copy.toString('base64url');
  };
  const body = JSON.parse(bytes.subarray(32).toString('utf8'));
  const signed = (value: unknown) => {
    const text = Buffer.from(JSON.stringify(value));
    return Buffer.concat([crypto.createHmac('sha256', pageSecret).update(text).digest(), text]).toString('base64url');
  };
  assert.equal(readSessionCursor(signed(body), pageSecret, pageScope).status, 'valid');
  for (const refused of [
    crypto.randomBytes(200).toString('base64url'),
    flipped(0),
    flipped(bytes.length - 3),
    cursor.slice(0, -4),
    cursor.slice(0, 40),
    `${cursor}A`,
    `${cursor}=`,
    'A'.repeat(513),
    '',
    signed({ ...body, extra: true }),
    signed({ ...body, coverage: 'true' }),
    signed({ ...body, version: 2 }),
    signed({ ...body, last: 'short' }),
    signed([body]),
    Buffer.concat([crypto.createHmac('sha256', pageSecret).update('{').digest(), Buffer.from('{')]).toString(
      'base64url',
    ),
    12,
    null,
  ])
    assert.equal(readSessionCursor(refused, pageSecret, pageScope).status, 'refused');
  assert.equal(readSessionCursor(cursor, crypto.randomBytes(32), pageScope).status, 'refused');
  assert.equal(readSessionCursor(cursor, pageSecret, sessionScopeDigest('other scope')).status, 'scope');
  assert.equal(readSessionCursor(cursor, crypto.randomBytes(32), sessionScopeDigest('other scope')).status, 'refused');
  for (const coverage of [true, false])
    for (const fresh of [true, false])
      assert.ok(encodeSessionCursor({ ...body, coverage, fresh }, pageSecret).length <= 512);
});

// Oversized recorded values must not hide a session or push the reply past its budget.
test('session pages cap oversized fields, reduce a row to its identity, and refuse when no row or empty page fits', () => {
  const huge = 'x'.repeat(20_000);
  const file = pageFile(1, { sessionId: 'I'.repeat(5000), file: `C:/Users/Mixed/${'P'.repeat(5000)}.jsonl` });
  const capped = listPage([file], null, {
    row: () => ({
      name: '\u{1F600}'.repeat(3000),
      setup: { model: huge, effort: huge, source: 'recorded' },
      labels: Array.from({ length: 300 }, (_, n) => ({ name: `label-${n}`, source: 'reader' as const })),
      parent: { id: huge, relation: 'reader' },
    }),
  });
  const [row] = capped.sessions;
  assert.deepEqual(row.truncated, ['id', 'path', 'name', 'setup.model', 'setup.effort', 'labels', 'parent.id']);
  assert.deepEqual([row.id, row.path, row.setup.model, row.setup.effort, row.labels], [null, null, null, null, null]);
  assert.deepEqual(row.parent, { id: null, relation: 'reader' });
  assert.ok(row.name!.length > 2000 && pageBytes(row.name) <= SESSION_PAGE_LIMITS.fieldBytes);
  assert.equal(row.name, '\u{1F600}'.repeat(row.name!.length / 2));
  assert.equal(row.source, sessionSourceKey(file.agent, file.sessionId, file.file));
  assert.ok(capped.notes.some((note) => note.includes('truncated')));
  const edge = 'n'.repeat(SESSION_PAGE_LIMITS.fieldBytes - 2);
  const kept = listPage([pageFile(2)], null, {
    row: () => ({ name: edge, setup: { model: edge, effort: null, source: 'recorded' } }),
  });
  assert.deepEqual([kept.sessions[0].name, kept.sessions[0].setup.model, kept.sessions[0].truncated], [edge, edge, []]);
  const tight = traverse(
    () => [pageFile(3), pageFile(4)],
    () => ({ replyBytes: 1500, row: () => ({ name: 'n'.repeat(4000) }) }),
  );
  assert.equal(tight.length, 2);
  for (const page of tight) {
    assert.ok(pageBytes(page) <= 1500);
    assert.equal(page.sessions.length, 1);
    const [minimal] = page.sessions;
    assert.deepEqual(
      [minimal.id, minimal.path, minimal.name, minimal.setup.model, minimal.labels],
      [null, null, null, null, null],
    );
    assert.deepEqual(minimal.truncated, ['id', 'path', 'name', 'setup.model', 'setup.effort', 'labels']);
    assert.deepEqual([minimal.runStatus, minimal.facts, minimal.ambiguous], ['done', 'current', false]);
  }
  assert.throws(() => listPage([pageFile(3)], null, { replyBytes: 300 }), /window metadata/);
  const pair = sessionPageSources([pageFile(5), pageFile(6)]).map((entry) => entry.session);
  const exhausted = listPage(pair, null, { limit: 1 }).next;
  for (const [files, cursor, catalog] of [
    [[], null, 'complete'],
    [[], null, 'unavailable'],
    [pair.slice(0, 1), exhausted, 'complete'],
  ] as const) {
    const empty = listPage([...files], cursor, { catalog });
    assert.deepEqual([empty.sessions, empty.next], [[], null]);
    const bytes = pageBytes(empty);
    assert.deepEqual(listPage([...files], cursor, { catalog, replyBytes: bytes }), empty);
    assert.throws(() => listPage([...files], cursor, { catalog, replyBytes: bytes - 1 }), /window metadata/);
  }
});

// Agents must tell apart transcripts that share a session ID, and notes must not echo that ID.
test('session pages mark every source of a shared session ID, including an oversized one, without naming it in notes', () => {
  const longId = 'S'.repeat(9000);
  const files = [
    pageFile(1, { sessionId: 'shared-id' }),
    pageFile(2, { sessionId: 'shared-id' }),
    pageFile(3, { sessionId: longId }),
    pageFile(4, { sessionId: longId }),
    pageFile(5),
  ];
  const pages = traverse(
    () => files,
    () => ({ limit: 1 }),
  );
  const rows = pages.flatMap((page) => page.sessions);
  assert.deepEqual(
    rows.map((row) => row.source),
    sessionPageSources(files).map((entry) => entry.source),
  );
  assert.deepEqual(
    rows
      .filter((row) => row.ambiguous)
      .map((row) => sessionSourceKey(row.provider, row.id ?? longId, row.path!))
      .sort(),
    files
      .slice(0, 4)
      .map((file) => sessionSourceKey(file.agent, file.sessionId, file.file))
      .sort(),
  );
  for (const page of pages) {
    const notes = page.notes.join(' ');
    assert.ok(!notes.includes('shared-id') && !notes.includes('SSS'));
    assert.equal(notes.includes('more than one transcript'), page.sessions[0].ambiguous);
  }
});

// A traversal must report incomplete coverage whenever a source before the cursor could have been missed.
test('session page coverage survives appends and later additions but clears on earlier changes, missing identity, and incomplete discovery', () => {
  const sorted = sessionPageSources(Array.from({ length: 6 }, (_, n) => pageFile(n))).map((entry) => entry.session);
  const key = (file: SessionFile) => sessionSourceKey(file.agent, file.sessionId, file.file);
  const extras = Array.from({ length: 200 }, (_, n) => pageFile(100 + n));
  const after = extras.find((file) => key(file) > key(sorted.at(-1)!))!;
  const before = extras.find((file) => key(file) < key(sorted[0]))!;
  const run = (change: (page: number) => SessionFile[], options: (page: number) => PageOptions = () => ({})) =>
    traverse(change, (page) => ({ limit: 2, ...options(page) }));
  const grown = run((page) => sorted.map((file) => ({ ...file, size: file.size + page * 100, mtimeMs: page + 1 })));
  assert.deepEqual([grown.at(-1)!.coverage, grown.at(-1)!.complete], ['complete', true]);
  for (const dev of [0, '0']) {
    const zero = run(() => [{ ...sorted[0], dev }, ...sorted.slice(1)]);
    assert.deepEqual([zero.at(-1)!.coverage, zero.at(-1)!.complete], ['complete', true]);
  }
  const added = run((page) => (page ? [...sorted, after] : sorted));
  assert.deepEqual(
    added.flatMap((page) => page.sessions.map((row) => row.source)),
    sessionPageSources([...sorted, after]).map((entry) => entry.source),
  );
  assert.deepEqual([added.at(-1)!.coverage, added.at(-1)!.complete], ['complete', true]);
  for (const change of [
    (page: number) => (page === 1 ? [before, ...sorted] : sorted),
    (page: number) => (page ? sorted.slice(1) : sorted),
    (page: number) => (page ? [{ ...sorted[0], dev: '8' }, ...sorted.slice(1)] : sorted),
    () => [{ ...sorted[0], dev: undefined }, ...sorted.slice(1)],
    () => [{ ...sorted[0], ino: 2 ** 60 }, ...sorted.slice(1)],
    () => [{ ...sorted[0], ino: 0 }, ...sorted.slice(1)],
    () => [{ ...sorted[0], ino: '0' }, ...sorted.slice(1)],
  ]) {
    const pages = run(change);
    assert.deepEqual(
      pages.slice(1).map((page) => [page.coverage, page.complete]),
      pages.slice(1).map(() => ['incomplete', false]),
    );
    assert.ok(pages.at(-1)!.notes.some((note) => note.includes('incomplete')));
  }
  const discovery = run(
    () => sorted,
    (page) => ({ catalog: page === 1 ? 'incomplete' : 'complete' }),
  );
  assert.deepEqual(
    discovery.map((page) => page.coverage),
    ['complete', 'incomplete', 'incomplete'],
  );
  for (const [options, freshness] of [
    [(page: number): PageOptions => ({ fresh: page !== 0 }), ['stale', 'stale', 'stale']],
    [
      (page: number): PageOptions => ({ current: (file) => page !== 1 || file !== sorted[2] }),
      ['current', 'stale', 'stale'],
    ],
  ] as const) {
    const pages = run(() => sorted, options);
    assert.deepEqual(
      pages.map((page) => page.freshness),
      freshness,
    );
    assert.deepEqual([pages.at(-1)!.coverage, pages.at(-1)!.complete], ['complete', false]);
  }
  assert.throws(() => listPage(sorted, grown[0].next, { catalog: 'unavailable' }), /catalog is unavailable/);
  const empty = listPage([], null, { catalog: 'unavailable' });
  assert.deepEqual([empty.sessions, empty.next, empty.coverage, empty.complete], [[], null, 'unavailable', false]);
});

test('ARC_HOME selects the registry and independent same-folder hosts retain distinct identities', async () => {
  const home = tempDir('window-home-');
  vi.stubEnv('ARC_HOME', home);
  try {
    const first = new WindowChannel();
    const second = new WindowChannel();
    channels.push(first, second);
    assert.equal(fs.existsSync(path.join(home, 'hosts')), false);
    await Promise.all([
      first.update({ ...state, scopeReady: false, folders: ['C:/MixedCase/Project'] }),
      second.update({ ...state, folders: ['C:/MixedCase/Project'] }),
    ]);
    const { windows: found, complete } = await discoverWindows();
    assert.equal(complete, true);
    assert.equal(found.length, 2);
    assert.notEqual(first.hostId, second.hostId);
    assert.equal(found.find((window) => window.hostId === first.hostId)?.scopeReady, false);
    assert.equal(JSON.stringify(found).includes('token'), false);
    assert.equal(JSON.stringify(found).includes('address'), false);
  } finally {
    vi.unstubAllEnvs();
  }
});

test('folderless hosts publish readiness and visibility changes and disappear on disposal', async () => {
  const { home, channel, file, entry } = await fixture();
  assert.deepEqual((await discoverWindows(home)).windows[0].folders, []);
  await channel.update({ folders: ['/MixedCase/Project'], scopeReady: false, panelReady: true, panelVisible: false });
  const hidden = (await discoverWindows(home)).windows[0];
  assert.deepEqual(hidden.folders, ['/MixedCase/Project']);
  assert.equal(hidden.scopeReady, false);
  assert.equal(hidden.panelReady, true);
  assert.equal(hidden.panelVisible, false);
  await channel.update({ ...state, panelReady: true, panelVisible: true });
  assert.equal((await pingWindow(entry))?.panelVisible, true);
  const socket = await connect(entry.address);
  const ended = closed(socket);
  await channel.dispose();
  await ended;
  assert.equal(fs.existsSync(file), false);
  assert.equal(await pingWindow(entry), null);
  assert.deepEqual(await discoverWindows(home), { windows: [], complete: true });
  if (process.platform !== 'win32') assert.equal(fs.existsSync(entry.address), false);
});

test.skipIf(process.platform === 'win32')(
  'POSIX registry and long-path fallback directories and files are private',
  async () => {
    const home = path.join(tempDir('long-window-home-'), 'LongMixedCase'.repeat(15));
    const channel = new WindowChannel(home);
    channels.push(channel);
    await channel.update(state);
    const file = path.join(home, 'hosts', `${channel.hostId}.json`);
    const entry = JSON.parse(fs.readFileSync(file, 'utf8')) as HostRegistration;
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(entry.address)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(entry.address).mode & 0o777, 0o600);
    await channel.dispose();
    assert.equal(fs.existsSync(path.dirname(entry.address)), false);
  },
);

test('ping refuses the wrong token without calling the handler or changing window state', async () => {
  const handler = vi.fn<(info: WindowInfo) => WindowInfo>((info) => info);
  const { entry, file } = await fixture(undefined, handler);
  const before = fs.readFileSync(file);
  const socket = await connect(entry.address);
  const received = reply(socket);
  socket.write(JSON.stringify(request(entry, { token: '0'.repeat(64) })) + '\n');
  assert.deepEqual(await received, { id: 'request-1', error: 'Access denied.' });
  assert.equal(handler.mock.calls.length, 0);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal((await pingWindow(entry))?.hostId, entry.hostId);
});

test('invalid JSON and schema receive errors', async () => {
  const { entry } = await fixture();
  for (const text of ['not JSON', JSON.stringify(request(entry, { version: 2 }))]) {
    const socket = await connect(entry.address);
    const received = reply(socket);
    socket.write(text + '\n');
    assert.deepEqual(await received, { id: null, error: 'Invalid request.' });
    socket.destroy();
  }
});

test('oversized complete and fragmented UTF-8 lines close before parsing', async () => {
  const handler = vi.fn<(info: WindowInfo) => WindowInfo>((info) => info);
  const { entry } = await fixture({ ...SESSION_REQUEST_LIMITS, lineBytes: 256 }, handler);
  const complete = JSON.stringify(request(entry, { id: 'a'.repeat(128) })) + '\n';
  const fragmented = JSON.stringify(request(entry, { requester: 'é'.repeat(128) })) + '\n';
  for (const chunks of [[complete], [fragmented.slice(0, 180), fragmented.slice(180)]]) {
    assert.equal(Buffer.byteLength(chunks.join('')) > 256, true);
    const socket = await connect(entry.address);
    const ended = closed(socket);
    for (const chunk of chunks) socket.write(chunk);
    await ended;
  }
  assert.equal(handler.mock.calls.length, 0);
});

test.each([0, 50])(
  'an unfinished line keeps its original deadline after acceptance delayed by %i ms',
  async (acceptDelay) => {
    const prototype = process.platform === 'win32' ? WindowsPipeServer.prototype : net.Server.prototype;
    const emit = prototype.emit;
    let accepted!: (connection: { socket: Duplex; accept: () => void }) => void;
    const connection = new Promise<{ socket: Duplex; accept: () => void }>((resolve) => {
      accepted = resolve;
    });
    const emission = vi.spyOn(prototype, 'emit').mockImplementation(function (
      this: net.Server | WindowsPipeServer,
      event: string | symbol,
      ...args: any[]
    ) {
      if (event !== 'connection') return emit.call(this, event, ...args);
      accepted({ socket: args[0], accept: () => emit.call(this, event, ...args) });
      return true;
    });
    try {
      const { entry } = await fixture({ ...SESSION_REQUEST_LIMITS, lineDeadlineMs: 100 });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const socket = await connect(entry.address);
      const ended = closed(socket);
      const server = await connection;
      assert.equal(vi.getTimerCount(), 0);
      await vi.advanceTimersByTimeAsync(acceptDelay);
      server.accept();
      assert.equal(vi.getTimerCount(), 1);
      const first = new Promise<Buffer>((resolve) => server.socket.once('data', resolve));
      socket.write('{');
      assert.equal((await first).toString(), '{');
      await vi.advanceTimersByTimeAsync(99);
      assert.equal(server.socket.destroyed, false);
      assert.equal(socket.destroyed, false);
      const second = new Promise<Buffer>((resolve) => server.socket.once('data', resolve));
      socket.write('"');
      assert.equal((await second).toString(), '"');
      await vi.advanceTimersByTimeAsync(1);
      assert.equal(server.socket.destroyed, true);
      await ended;
    } finally {
      emission.mockRestore();
    }
  },
);

test('open connection bounds refuse excess clients and release closed clients', async () => {
  const { entry } = await fixture({ ...SESSION_REQUEST_LIMITS, connections: 1 });
  const first = await connect(entry.address);
  const second = await connect(entry.address);
  const outcome = new Promise<string>((resolve) => {
    second.once('data', () => resolve('reply'));
    second.once('close', () => resolve('closed'));
  });
  second.write(JSON.stringify(request(entry)) + '\n');
  assert.equal(await outcome, 'closed');
  assert.equal(first.destroyed, false);
  const firstClosed = closed(first);
  first.destroy();
  await firstClosed;
  await vi.waitFor(async () => assert.equal((await pingWindow(entry))?.hostId, entry.hostId));
});

test('in-flight bounds span connections until pending handlers settle', async () => {
  let complete!: (info: WindowInfo) => void;
  const handler = vi.fn<() => Promise<WindowInfo>>(
    () =>
      new Promise<WindowInfo>((resolve) => {
        complete = resolve;
      }),
  );
  const { entry } = await fixture({ ...SESSION_REQUEST_LIMITS, inFlight: 1 }, handler);
  const first = await connect(entry.address);
  first.write(JSON.stringify(request(entry)) + '\n');
  await vi.waitFor(() => assert.equal(handler.mock.calls.length, 1));
  const second = await connect(entry.address);
  const rejected = closed(second);
  second.write(JSON.stringify(request(entry)) + '\n');
  await rejected;
  assert.equal(handler.mock.calls.length, 1);
  const received = reply(first);
  complete({ ...state, hostId: entry.hostId, pid: process.pid, version: 1 });
  assert.equal((await received).result.hostId, entry.hostId);
});

test('discovery rejects the wrong ping identity and retains uncertain ownership and arbitrary addresses', async () => {
  const { home, file, entry } = await fixture(undefined, (info) => ({ ...info, hostId: 'f'.repeat(24) }));
  assert.deepEqual(await discoverWindows(home), { windows: [], complete: false });
  assert.equal(fs.existsSync(file), true);
  const arbitrary = path.join(home, 'retain.txt');
  fs.writeFileSync(arbitrary, 'keep');
  fs.writeFileSync(file, JSON.stringify({ ...entry, address: arbitrary }));
  assert.deepEqual(await discoverWindows(home), { windows: [], complete: true });
  assert.equal(fs.readFileSync(arbitrary, 'utf8'), 'keep');
  assert.equal(fs.existsSync(file), true);
});

// These guards catch forged liveness and credential disclosure before transcript reads become available.
test('discovery rejects a forged reply process identity from an otherwise authenticated window', async () => {
  const { home, file, entry } = await fixture(undefined, (info) => ({ ...info, pid: info.pid + 1 }));
  assert.equal(await pingWindow(entry), null);
  assert.deepEqual(await discoverWindows(home), { windows: [], complete: false });
  assert.equal(fs.existsSync(file), true);
});

test('an endpoint without server knowledge receives no token or requester', async () => {
  const { entry } = await fixture();
  const otherId = 'd'.repeat(24);
  const address = hostAddress(tempDir('window-forged-'), otherId);
  if (process.platform !== 'win32') fs.mkdirSync(path.dirname(address), { recursive: true });
  const inputs: string[] = [];
  const accepted = (socket: Duplex) => {
    sockets.push(socket);
    socket.on('data', (bytes) => {
      inputs.push(bytes.toString());
      socket.end(JSON.stringify({ proof: '0'.repeat(64) }) + '\n');
    });
  };
  const server = process.platform === 'win32' ? new WindowsPipeServer() : net.createServer(accepted);
  if (server instanceof WindowsPipeServer) {
    server.on('connection', accepted);
    await server.listen(address);
  } else await new Promise<void>((resolve) => server.listen(address, resolve));
  try {
    assert.equal(await pingWindow({ ...entry, hostId: otherId, address }), null);
    assert.equal(inputs.join('').includes(entry.token), false);
    assert.equal(inputs.join('').includes('requester'), false);
    assert.equal(inputs.length, 1);
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server instanceof WindowsPipeServer) server.close();
    else await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test.skipIf(process.platform !== 'win32')('Windows rejects a forged endpoint before any bytes reach it', async () => {
  const { entry } = await fixture();
  const hostId = 'c'.repeat(24);
  const address = hostAddress('', hostId);
  const inputs: Buffer[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on('data', (bytes) => {
      inputs.push(bytes);
      socket.end('{"proof":"' + '0'.repeat(64) + '"}\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(address, resolve));
  try {
    assert.equal(await pingWindow({ ...entry, hostId, address }), null);
    assert.equal(inputs.length, 0);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test.skipIf(process.platform !== 'win32')('eight simultaneous clients reach one Windows listener', async () => {
  const { entry, file } = await fixture();
  for (let batch = 0; batch < 5; batch++) {
    const replies = await Promise.all(Array.from({ length: 8 }, () => pingWindow(entry, 1_000, file)));
    assert.deepEqual(
      replies.map((info) => info?.hostId),
      Array(8).fill(entry.hostId),
    );
  }
});

function nativeFixture(source: string) {
  const directory = tempDir('window-native-');
  const input = path.join(directory, 'bridge.cs');
  const output = path.join(directory, 'bridge.exe');
  fs.writeFileSync(input, source);
  const built = spawnSync(
    path.join(process.env.SystemRoot ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    ['/nologo', '/target:exe', `/out:${output}`, input],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(built.status, 0, built.stdout + built.stderr);
  const child = spawn(output, [], { stdio: 'pipe', windowsHide: true });
  let text = '';
  child.stdout.on('data', (bytes) => {
    text += bytes.toString();
  });
  child.stderr.on('data', (bytes) => {
    text += bytes.toString();
  });
  return {
    child,
    send: (line: string) => child.stdin.write(line + '\n'),
    wait: async (pattern: RegExp) => {
      await vi.waitFor(() => assert.match(text, pattern), { timeout: 5_000 });
      return text.match(pattern)!;
    },
    close: async () => {
      child.stdin.end();
      await vi.waitFor(() => assert.equal(child.exitCode, 0), { timeout: 5_000 });
    },
  };
}

const gatedNativeSource = () =>
  WINDOW_PIPE_SOURCE.replace(/\r\n/g, '\n')
    .replace(
      'class ArcPipe {',
      'class ArcPipe { static readonly ManualResetEvent acceptGate = new ManualResetEvent(false);',
    )
    .replace('Output("listen:" + id); first = false;', 'Output("listen:" + id); acceptGate.WaitOne(); first = false;')
    .replace('if(parts[0] == "listen")', 'if(parts[0] == "resume") acceptGate.Set(); else if(parts[0] == "listen")');

test.skipIf(process.platform !== 'win32')(
  'Windows busy opens honor deadline and cancellation before availability returns',
  async () => {
    const source = gatedNativeSource().replace(
      'if(error != 231 && error != 2)',
      'Output("busy:" + id); if(error != 231 && error != 2)',
    );
    const native = nativeFixture(source);
    const address = hostAddress('', crypto.randomBytes(12).toString('hex'));
    const encoded = Buffer.from(address).toString('base64');
    try {
      native.send(`listen:1:${encoded}`);
      await native.wait(/listen:1/);
      const occupied = await connect(address);
      native.send(`connect:2:${encoded}:${process.pid}:${native.child.pid!}::10000`);
      await native.wait(/busy:2/);
      native.send('close:2');
      await native.wait(/close:2/);
      native.send(`connect:3:${encoded}:${process.pid}:${native.child.pid!}::50`);
      await native.wait(/busy:3/);
      assert.equal((await native.wait(/close:3/))[0], 'close:3');
      occupied.destroy();
      native.send('resume:0');
    } finally {
      await native.close();
    }
  },
);

test.skipIf(process.platform !== 'win32')(
  'Windows listening survives a disconnect before native acceptance',
  async () => {
    const native = nativeFixture(gatedNativeSource());
    const address = hostAddress('', crypto.randomBytes(12).toString('hex'));
    try {
      native.send(`listen:1:${Buffer.from(address).toString('base64')}`);
      await native.wait(/listen:1/);
      const early = await connect(address);
      const ended = closed(early);
      early.destroy();
      await ended;
      native.send('resume:0');
      const next = await WindowsPipeServer.connect(address, process.pid, native.child.pid!);
      sockets.push(next);
      await new Promise<void>((resolve, reject) => {
        next.once('connect', resolve);
        next.once('close', () => reject(new Error('Listener closed after the early disconnect.')));
      });
      assert.equal((await native.wait(/accept:1:/))[0], 'accept:1:');
      next.destroy();
    } finally {
      await native.close();
    }
  },
);

test.skipIf(process.platform !== 'win32')(
  'Windows close retains the native handle until pending I/O completes',
  async () => {
    const source = WINDOW_PIPE_SOURCE.replace(/\r\n/g, '\n')
      .replace(
        'class ArcPipe {',
        'class ArcPipe { static readonly ManualResetEvent completionGate = new ManualResetEvent(false); [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetFileType(IntPtr handle);',
      )
      .replace(
        'if(bytes == null && error == 535) return true;',
        'if(bytes == null && error == 535) return true; if(bytes != null && error == 997) { Output("pending:0"); completionGate.WaitOne(); }',
      )
      .replace(
        'if(stream != null) stream.Close(); if(listener != null)',
        'if(stream != null) { stream.Close(); Output("retained:" + GetFileType(stream.handle.DangerousGetHandle())); completionGate.Set(); } if(listener != null)',
      );
    const native = nativeFixture(source);
    const address = hostAddress('', crypto.randomBytes(12).toString('hex'));
    try {
      native.send(`listen:1:${Buffer.from(address).toString('base64')}`);
      await native.wait(/listen:1/);
      const socket = await connect(address);
      const accepted = await native.wait(/accept:1:(\d+)/);
      await native.wait(/pending:0/);
      native.send(`close:${accepted[1]}`);
      assert.equal((await native.wait(/retained:3/))[0], 'retained:3');
      await native.wait(new RegExp(`close:${accepted[1]}`));
      socket.destroy();
    } finally {
      await native.close();
    }
  },
);

test.skipIf(process.platform !== 'win32')(
  'Windows excludes the machine-name UNC pipe route on each instance',
  async () => {
    const { entry } = await fixture();
    const unc = entry.address.replace('\\\\.\\pipe\\', `\\\\${process.env.COMPUTERNAME}\\pipe\\`);
    for (let index = 0; index < 2; index++) {
      assert.equal((await pingWindow(entry))?.hostId, entry.hostId);
      const socket = net.createConnection(unc);
      sockets.push(socket);
      const result = await new Promise<string>((resolve) => {
        socket.once('connect', () => {
          socket.destroy();
          resolve('connected');
        });
        socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'));
      });
      assert.notEqual(result, 'connected');
    }
  },
);

test('ping deadlines reject silent hosts and preserve a replaced registry during stale cleanup', async () => {
  const { home, file, entry } = await fixture(undefined, () => new Promise(() => {}));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const pending = discoverWindows(home);
  await vi.waitFor(() => assert.equal(vi.getTimerCount() >= 2, true));
  const replacement = JSON.stringify({ ...entry, token: 'c'.repeat(64) });
  fs.writeFileSync(file, replacement);
  await vi.advanceTimersByTimeAsync(1_000);
  assert.deepEqual(await pending, { windows: [], complete: false });
  assert.equal(fs.readFileSync(file, 'utf8'), replacement);
});

test('a saturated live listener remains discoverable after admission recovers', async () => {
  const { home, file, entry, channel } = await fixture({ ...SESSION_REQUEST_LIMITS, connections: 1 });
  const occupied = await connect(entry.address);
  const unavailable = await discoverWindows(home);
  assert.equal(fs.existsSync(file), true);
  assert.deepEqual(unavailable, { windows: [], complete: false });
  if (process.platform !== 'win32') assert.equal(fs.lstatSync(entry.address).isSocket(), true);
  occupied.destroy();
  await vi.waitFor(async () => assert.equal((await discoverWindows(home)).windows[0]?.hostId, entry.hostId));
  fs.unlinkSync(file);
  await channel.update(state);
  assert.equal((await discoverWindows(home)).windows[0]?.hostId, entry.hostId);
});

test('a ping timeout retains a silent live host until it responds again', async () => {
  const handler = vi.fn<(info: WindowInfo) => WindowInfo | Promise<WindowInfo>>(() => new Promise(() => {}));
  const { home, file, entry } = await fixture(undefined, handler);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const pending = discoverWindows(home);
  await vi.waitFor(() => assert.equal(handler.mock.calls.length, 1));
  await vi.advanceTimersByTimeAsync(1_000);
  const unavailable = await pending;
  assert.equal(fs.existsSync(file), true);
  assert.deepEqual(unavailable, { windows: [], complete: false });
  vi.useRealTimers();
  handler.mockImplementation((info) => info);
  assert.equal((await discoverWindows(home)).windows[0]?.hostId, entry.hostId);
});

test('invalid registry prefixes do not consume the live-host allowance', async () => {
  const { home, entry } = await fixture();
  for (let index = 0; index < 256; index++) {
    fs.writeFileSync(path.join(home, 'hosts', `${index.toString(16).padStart(24, '0')}.json`), '{}');
  }
  const result = await discoverWindows(home);
  assert.deepEqual(
    result.windows.map((window) => window.hostId),
    [entry.hostId],
  );
  assert.equal(result.complete, true);
});

test('directory coverage is explicitly incomplete at a bounded iteration limit', async () => {
  const home = tempDir('window-population-');
  const directory = path.join(home, 'hosts');
  fs.mkdirSync(directory);
  for (let index = 0; index <= WINDOW_DISCOVERY_LIMITS.directoryEntries; index++) {
    fs.writeFileSync(path.join(directory, `unrelated-${index}`), '');
  }
  const original = fs.promises.opendir;
  const enumerate = vi.spyOn(filesystem, 'readdirSync').mockImplementation(() => {
    throw new Error('Unbounded registry enumeration');
  });
  syncBuiltinESMExports();
  let reads = () => 0;
  let closes = () => 0;
  const opened = vi.spyOn(fs.promises, 'opendir').mockImplementation(async (...args) => {
    const handle = await original(...args);
    const read = vi.spyOn(handle, 'read');
    const close = vi.spyOn(handle, 'close');
    reads = () => read.mock.calls.length;
    closes = () => close.mock.calls.length;
    return handle;
  });
  try {
    assert.deepEqual(await discoverWindows(home), { windows: [], complete: false });
    assert.equal(reads(), WINDOW_DISCOVERY_LIMITS.directoryEntries + 1);
    assert.equal(closes(), 1);
    assert.equal(enumerate.mock.calls.length, 0);
  } finally {
    opened.mockRestore();
    enumerate.mockRestore();
    syncBuiltinESMExports();
  }
});

test('a host population beyond the ping allowance returns an explicitly partial list', async () => {
  const home = tempDir('window-host-limit-');
  const population = Array.from({ length: WINDOW_DISCOVERY_LIMITS.hosts + 1 }, () => new WindowChannel(home));
  channels.push(...population);
  await Promise.all(population.map((channel) => channel.update(state)));
  const result = await discoverWindows(home);
  assert.equal(result.complete, false);
  assert.equal(result.windows.length, WINDOW_DISCOVERY_LIMITS.hosts);
});

test('publication never enumerates the shared registry to remove atomic temporaries', async () => {
  const { channel } = await fixture();
  const enumerate = vi.spyOn(filesystem, 'readdirSync').mockImplementation(() => {
    throw new Error('Shared registry enumeration');
  });
  syncBuiltinESMExports();
  try {
    await channel.update({ ...state, panelReady: true });
    assert.equal(enumerate.mock.calls.length, 0);
  } finally {
    enumerate.mockRestore();
    syncBuiltinESMExports();
  }
});

test('connection creation failure retains live ownership and closes the registry directory', async () => {
  const { home, file } = await fixture();
  const original = fs.promises.opendir;
  let closeCalls = () => 0;
  const opened = vi.spyOn(fs.promises, 'opendir').mockImplementation(async (...args) => {
    const directory = await original(...args);
    const close = vi.spyOn(directory, 'close');
    closeCalls = () => close.mock.calls.length;
    return directory;
  });
  const connection =
    process.platform === 'win32'
      ? vi.spyOn(WindowsPipeServer, 'connect').mockImplementation(async () => {
          throw Object.assign(new Error('Connection unavailable'), { code: 'EMFILE' });
        })
      : vi.spyOn(network, 'createConnection').mockImplementation(() => {
          throw Object.assign(new Error('Connection unavailable'), { code: 'EMFILE' });
        });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await discoverWindows(home), { windows: [], complete: false });
    assert.equal(fs.existsSync(file), true);
    assert.equal(closeCalls(), 1);
  } finally {
    connection.mockRestore();
    opened.mockRestore();
    syncBuiltinESMExports();
  }
});

test('only confirmed process death removes unchanged registry bytes and never a foreign socket', async () => {
  const { home, file, entry, channel } = await fixture();
  await channel.dispose();
  const dead = JSON.stringify({ ...entry, pid: 424242 });
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('Stopped'), { code: 'ESRCH' });
  });
  try {
    fs.writeFileSync(file, dead);
    assert.deepEqual(await discoverWindows(home), { windows: [], complete: true });
    assert.equal(fs.existsSync(file), false);
    fs.writeFileSync(file, dead);
    kill.mockImplementation(() => {
      throw Object.assign(new Error('Denied'), { code: 'EPERM' });
    });
    assert.deepEqual(await discoverWindows(home), { windows: [], complete: false });
    assert.equal(fs.readFileSync(file, 'utf8'), dead);
    const replacement = JSON.stringify({ ...entry, pid: 424242, token: 'c'.repeat(64) });
    kill.mockImplementation(() => {
      fs.writeFileSync(file, replacement);
      throw Object.assign(new Error('Stopped'), { code: 'ESRCH' });
    });
    assert.deepEqual(await discoverWindows(home), { windows: [], complete: false });
    assert.equal(fs.readFileSync(file, 'utf8'), replacement);
  } finally {
    kill.mockRestore();
  }
});

test('POSIX discovery preserves socket ownership after a registered process dies', async () => {
  const { home, file, entry, channel } = await fixture();
  await channel.dispose();
  const address = hostAddress(home, entry.hostId, 'linux', '/Host/Temporary');
  fs.writeFileSync(file, JSON.stringify({ ...entry, pid: 424242, address }));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const lstat = filesystem.lstatSync;
  const inspection = vi.spyOn(filesystem, 'lstatSync').mockImplementation((target: fs.PathLike) => {
    assert.notEqual(target, address, 'Discovery cannot establish socket ownership from a stopped PID.');
    return lstat(target);
  });
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('Stopped'), { code: 'ESRCH' });
  });
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await discoverWindows(home), { windows: [], complete: true });
    assert.equal(fs.existsSync(file), false);
    assert.equal(
      inspection.mock.calls.some(([target]) => target === address),
      false,
    );
  } finally {
    Object.defineProperty(process, 'platform', platform);
    inspection.mockRestore();
    kill.mockRestore();
    syncBuiltinESMExports();
  }
});

test('discovery uses the published fallback from a different temporary environment', async () => {
  const { home, file, entry } = await fixture();
  const longHome = path.join(home, 'MixedCase'.repeat(20));
  fs.mkdirSync(path.join(longHome, 'hosts'), { recursive: true });
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const createConnection = net.createConnection;
  const published = hostAddress(longHome, entry.hostId, 'linux', '/Host/TemporaryMixedCase');
  assert.equal(published.startsWith('/Host/TemporaryMixedCase/'), true);
  fs.writeFileSync(
    path.join(longHome, 'hosts', `${entry.hostId}.json`),
    JSON.stringify({ ...entry, address: published }),
  );
  const connections = vi.spyOn(network, 'createConnection').mockImplementation((address: string) => {
    assert.equal(address, published);
    return createConnection(entry.address);
  });
  syncBuiltinESMExports();
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  try {
    vi.stubEnv('TMPDIR', '/Client/OtherTemporary');
    assert.equal((await discoverWindows(longHome)).windows[0]?.hostId, entry.hostId);
    assert.equal(connections.mock.calls.length, 1);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    connections.mockRestore();
    syncBuiltinESMExports();
    vi.unstubAllEnvs();
    fs.writeFileSync(file, JSON.stringify(entry));
  }
});

test('ping identifies Claude and Codex requesters and leaves an absent requester unknown', async () => {
  const requests: any[] = [];
  const { entry } = await fixture();
  const otherId = 'e'.repeat(24);
  const address = hostAddress(tempDir('window-requester-'), otherId);
  if (process.platform !== 'win32') fs.mkdirSync(path.dirname(address), { recursive: true });
  const accepted = (socket: Duplex) => {
    sockets.push(socket);
    socket.on('error', () => {});
    socket.on('data', (bytes) => {
      const input = JSON.parse(bytes.toString());
      if (input.challenge) {
        socket.write(
          JSON.stringify({
            proof: crypto.createHmac('sha256', Buffer.from(entry.token, 'hex')).update(input.challenge).digest('hex'),
          }) + '\n',
        );
        return;
      }
      requests.push(input);
      socket.end(
        JSON.stringify({
          id: input.id,
          result: { ...state, hostId: otherId, pid: process.pid, version: 1, token: entry.token, address },
        }) + '\n',
      );
    });
  };
  const server = process.platform === 'win32' ? new WindowsPipeServer() : net.createServer(accepted);
  if (server instanceof WindowsPipeServer) {
    server.on('connection', accepted);
    await server.listen(address);
  } else await new Promise<void>((resolve) => server.listen(address, resolve));
  try {
    const cases: [string, string, string | null][] = [
      ['claude-session', 'codex-session', 'claude-session'],
      ['', 'codex-session', 'codex-session'],
      ['', '', null],
    ];
    for (const [claude, codex, expected] of cases) {
      vi.stubEnv('CLAUDE_CODE_SESSION_ID', claude);
      vi.stubEnv('CODEX_THREAD_ID', codex);
      const result = await pingWindow({ ...entry, hostId: otherId, address });
      assert.equal(result?.hostId, otherId);
      assert.equal('token' in result, false);
      assert.equal('address' in result, false);
      assert.equal(requests.at(-1).requester, expected);
    }
  } finally {
    vi.unstubAllEnvs();
    for (const socket of sockets) socket.destroy();
    if (server instanceof WindowsPipeServer) server.close();
    else await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('disposal during listener startup removes the listener without publishing a registry', async () => {
  const home = tempDir('window-start-close-');
  const channel = new WindowChannel(home);
  channels.push(channel);
  const start = channel.update(state);
  await channel.dispose();
  await start;
  assert.deepEqual(await discoverWindows(home), { windows: [], complete: true });
  assert.equal(fs.existsSync(hostAddress(home, channel.hostId)), false);
});

test('constructor failure leaves an activation spawner without a foreign window target', () => {
  let channel: WindowChannel | null = null;
  const create = vi.spyOn(network, 'createServer').mockImplementation(() => {
    throw new Error('Listener unavailable');
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => {
      channel = new WindowChannel(tempDir('window-constructor-failed-'));
    }, /Listener unavailable/);
    const spawner = arcCliSpawner(
      () => ({ directory: 'Arc bin', editorExecutable: '/editor', windowId: channel?.windowId ?? null }),
      (_command, _args, cwd, wanted, agent, cli) => {
        assert.equal(childEnv({ ARC_WINDOW: 'foreign-window' }, wanted, agent, cwd, cli).ARC_WINDOW, undefined);
        return {} as never;
      },
    );
    spawner('unused', [], '.', {});
  } finally {
    create.mockRestore();
    syncBuiltinESMExports();
  }
});

test('activation spawners clear their window target after asynchronous startup and later channel failures', async () => {
  for (const failure of ['directory', 'listener-start', 'publish-start', 'listener-later', 'publish-later']) {
    const home = tempDir('window-failed-target-');
    const original = network.createServer;
    let server: net.Server | null = null;
    const create = vi
      .spyOn(network, 'createServer')
      .mockImplementation((...args: Parameters<typeof network.createServer>) => {
        server = original(...args);
        return server;
      });
    syncBuiltinESMExports();
    let channel: WindowChannel;
    try {
      channel = new WindowChannel(home);
      channels.push(channel);
    } finally {
      create.mockRestore();
      syncBuiltinESMExports();
    }
    const targets: (string | undefined)[] = [];
    const spawner = arcCliSpawner(
      () => ({ directory: 'Arc bin', editorExecutable: '/editor', windowId: channel.windowId }),
      (_command, _args, cwd, wanted, agent, cli) => {
        targets.push(childEnv({ ARC_WINDOW: 'foreign-window' }, wanted, agent, cwd, cli).ARC_WINDOW);
        return {} as never;
      },
    );
    spawner('unused', [], '.', {});
    const oversized = { ...state, folders: ['x'.repeat(100_000)] };
    if (failure === 'directory') {
      fs.writeFileSync(path.join(home, 'hosts'), 'not a directory');
      await assert.rejects(channel.update(state));
    } else if (failure === 'listener-start') {
      const listen =
        process.platform === 'win32'
          ? vi.spyOn(WindowsPipeServer.prototype, 'listen').mockRejectedValue(new Error('Listener unavailable'))
          : vi.spyOn(server!, 'listen').mockImplementation(() => {
              queueMicrotask(() => server!.emit('error', new Error('Listener unavailable')));
              return server!;
            });
      try {
        await assert.rejects(channel.update(state), /Listener unavailable/);
      } finally {
        listen.mockRestore();
      }
    } else if (failure === 'publish-start') {
      await assert.rejects(channel.update(oversized), /too large/);
    } else {
      await channel.update(state);
      if (failure === 'publish-later') await assert.rejects(channel.update(oversized), /too large/);
      else server!.emit('error', new Error('Listener unavailable'));
    }
    spawner('unused', [], '.', {});
    assert.deepEqual(targets, [channel.hostId, undefined], failure);
    await channel.dispose();
  }
});

test('exact decimal source identity distinguishes adjacent Windows inodes and keeps conservative fallback', () => {
  const snapshot = fs.statSync(__filename, { bigint: true });
  const before = revisionOf(
    Object.assign(Object.create(snapshot), { dev: 0n, ino: 56576470320201115n, size: 100n, mtimeNs: 1234567890n }),
  );
  const after = revisionOf(
    Object.assign(Object.create(snapshot), { dev: 0n, ino: 56576470320201114n, size: 150n, mtimeNs: 1234567890n }),
  );
  const source = { agent: 'claude' as const, file: 'source', sessionId: 's', ...before };
  assert.equal(before.dev, '0');
  assert.equal(before.ino, '56576470320201115');
  assert.equal(before.mtimeMs, 1234.56789);
  assert.notEqual(before.ino, after.ino, 'adjacent inodes collapsed');
  assert.equal(supportedFileIdentity(before), true);
  assert.equal(sessionSourceAdmitted(source, { ...before, size: 150 }), true);
  assert.equal(sessionSourceAdmitted(source, after), false, 'a larger replacement acquired source ownership');
  assert.equal(sessionSourceAdmitted({ ...source, dev: undefined, ino: undefined }, { ...before, size: 150 }), false);
  assert.equal(sessionSourceAdmitted({ ...source, dev: undefined, ino: undefined }, before), true);
  assert.equal(sessionSourceAdmitted({ ...source, dev: undefined, ino: 0 }, { ...before, ino: 0 }), true);
  for (const ino of ['01', 'NaN', '-1', '1.5']) {
    assert.equal(sessionSourceAdmitted({ ...source, ino }, { ...before, ino }), false);
  }
  for (const change of [
    { size: -1 },
    { size: 0.5 },
    { size: Number.MAX_SAFE_INTEGER + 1 },
    { mtimeMs: NaN },
    { mtimeMs: Infinity },
  ]) {
    assert.equal(sessionSourceAdmitted(source, { ...before, ...change }), false);
  }
});

// A retained child whose state each case changes between host observations.
function compactHostFixture(agent: 'claude' | 'codex' = 'codex') {
  const state = { sessionId: 'self' as string | null, busy: true, asks: [] as unknown[], ready: true, exited: false };
  const fixture = {
    clock: 0,
    calls: 0,
    writes: 0,
    // The last native submission generation. The requesting turn of the Claude cases is generation 1.
    compactions: 1,
    work: 'none' as 'none' | 'pending' | 'absent' | 'unknown',
    beforeWrite: () => {},
    state,
    child: null as unknown as CompactChild,
    current: null as CompactChild | null,
    host: null as unknown as CompactHost<CompactChild>,
  };
  // Like the adapters, the child reports its compaction submission right after the write callback.
  const makeChild = (key: string): CompactChild => {
    const child: CompactChild = {
      key,
      agent,
      state: () => state,
      compactionUnresolved: () => false,
      compact: async (check) => {
        fixture.calls++;
        state.busy = true;
        fixture.beforeWrite();
        check();
        fixture.writes++;
        const submission = {
          kind: 'submission',
          text: '/compact',
          generation: ++fixture.compactions,
        } as const;
        fixture.host.native(
          child,
          {
            provider: agent,
            sessionId: 'self',
            turnId: null,
            evidence: {},
            ...submission,
          },
          undefined,
        );
      },
    };
    return child;
  };
  fixture.child = makeChild('child');
  fixture.current = fixture.child;
  fixture.host = new CompactHost<CompactChild>(
    compactWindow,
    {
      find: (provider, sessionId) =>
        provider === agent && fixture.current?.state().sessionId === sessionId ? fixture.current : null,
      withActivity: async (child, work) => {
        if (child !== fixture.current || child.state().exited) return null;
        await work(child);
        return undefined;
      },
      readerWork: () => fixture.work,
    },
    () => fixture.clock,
  );
  return { fixture, makeChild };
}

// Admits a request from a live root tool call in reader turn 7, then settles the tool.
function admittedCompaction(fixture: ReturnType<typeof compactHostFixture>['fixture']) {
  const { host, child } = fixture;
  host.submitted(child, 7);
  host.native(child, compactEvent('toolStart'), 7);
  assert.deepEqual(host.handle({ method: 'compact-ready', params: compactPayload }), { ready: true });
  const ack = host.handle({ method: 'compact-request', params: compactPayload }) as { state: string };
  assert.equal(ack.state, 'queued');
  host.native(child, compactEvent('toolEnd'), 7);
}

const compactState = (host: CompactHost<CompactChild>) =>
  (host.handle({ method: 'compact-status', params: { requestId: compactPayload.requestId } }) as { state: string })
    .state;

test('host compaction runs once after the exact turn succeeds and its final response is saved', async () => {
  const { fixture } = compactHostFixture();
  const { host, child, state } = fixture;
  admittedCompaction(fixture);
  host.native(child, compactEvent('rootEnd'), 7);
  state.busy = false;
  await host.drain('self');
  assert.equal(fixture.writes, 0, 'a root success without a saved final response must wait');
  host.replyRetained(child, 7);
  state.busy = true;
  await host.drain('self');
  assert.equal(fixture.writes, 0, 'a busy child must not receive compaction');
  assert.equal(compactState(host), 'queued');
  state.busy = false;
  await Promise.all([host.drain('self'), host.drain('self')]);
  await host.drain('self');
  assert.equal(fixture.calls, 1, 'one assignment issues one provider command');
  assert.equal(fixture.writes, 1);
  assert.equal(compactState(host), 'uncertain');
  const stages = [
    ['turnStart', {}],
    ['itemStart', { item: { id: 'item' } }],
    ['itemEnd', { item: { id: 'item' } }],
    ['turnEnd', { turn: { status: 'completed' } }],
  ] as const;
  for (const [stage, evidence] of stages)
    host.native(
      child,
      { provider: 'codex', sessionId: 'self', turnId: 'compact', generation: 2, evidence, kind: 'compact', stage },
      undefined,
    );
  assert.equal(compactState(host), 'completed');
});

test('host compaction fails when no final response follows the requesting tool or the turn fails', async () => {
  for (const ending of ['reply before tool', 'failed turn'] as const) {
    const { fixture } = compactHostFixture();
    const { host, child, state } = fixture;
    host.submitted(child, 7);
    host.native(child, compactEvent('toolStart'), 7);
    host.handle({ method: 'compact-request', params: compactPayload });
    if (ending === 'reply before tool') host.replyRetained(child, 7);
    host.native(child, compactEvent('toolEnd'), 7);
    host.native(child, compactEvent('rootEnd', { success: ending !== 'failed turn' }), 7);
    if (ending === 'failed turn') host.replyRetained(child, 7);
    host.turnEnded(child);
    state.busy = false;
    await host.drain('self');
    assert.equal(fixture.writes, 0, ending);
    assert.equal(compactState(host), 'failed', ending);
  }
});

test('host compaction cancels unsubmitted work on reader action, child change, scope loss and disposal', async () => {
  for (const change of [
    'reader',
    'answer',
    'replacement',
    'exit',
    'scope',
    'scope restored',
    'disposal',
    'write boundary',
  ] as const) {
    const { fixture, makeChild } = compactHostFixture();
    const { host, child, state } = fixture;
    admittedCompaction(fixture);
    host.replyRetained(child, 7);
    host.native(child, compactEvent('rootEnd'), 7);
    state.busy = false;
    if (change === 'reader') host.readerAction('self');
    if (change === 'answer') host.readerAction('self', true);
    // The rows refresh after a scope change shows the session gone, and a later change returns it before the next drain.
    if (change === 'scope restored') {
      host.scopeChanged();
      fixture.work = 'absent';
      host.sessionsRefreshed();
      fixture.work = 'none';
      host.scopeChanged();
      host.sessionsRefreshed();
    }
    if (change === 'replacement') fixture.current = makeChild('child');
    if (change === 'exit') {
      state.exited = true;
      host.childGone('child');
    }
    if (change === 'scope') fixture.work = 'absent';
    if (change === 'disposal') host.dispose();
    if (change === 'write boundary') fixture.beforeWrite = () => host.readerAction('self');
    await host.drain('self');
    assert.equal(fixture.writes, 0, change);
    assert.equal(compactState(host), 'cancelled', change);
  }
  const { fixture } = compactHostFixture();
  fixture.host.submitted(fixture.child, 7);
  fixture.host.native(fixture.child, compactEvent('toolStart'), 7);
  fixture.host.readerAction('self');
  const refused = fixture.host.handle({ method: 'compact-request', params: compactPayload }) as { state: string };
  assert.equal(refused.state, 'refused');
});

// Catches a worktree change or a failed Git read cancelling a request whose session never left the window's scope.
test('host compaction waits through a scope change that keeps its session and delivers after the rows refresh', async () => {
  const { fixture } = compactHostFixture();
  const { host, child, state } = fixture;
  admittedCompaction(fixture);
  host.replyRetained(child, 7);
  host.native(child, compactEvent('rootEnd'), 7);
  state.busy = false;
  host.scopeChanged();
  await host.drain('self');
  assert.equal(fixture.writes, 0, 'delivery waits until the rows show the new scope');
  assert.equal(compactState(host), 'queued');
  host.sessionsRefreshed();
  await vi.waitFor(() => assert.equal(fixture.writes, 1));
  assert.equal(compactState(host), 'uncertain');
});

test('a ready scope cancels deferred compaction before hidden session rows refresh', async () => {
  const { fixture } = compactHostFixture();
  const { host, child, state } = fixture;
  admittedCompaction(fixture);
  host.replyRetained(child, 7);
  host.native(child, compactEvent('rootEnd'), 7);
  state.busy = false;
  host.scopeChanged();
  assert.equal(compactState(host), 'queued', 'loading scope is not evidence of removal');
  host.scopeChanged(new Set(['self']));
  assert.equal(compactState(host), 'cancelled');
  host.scopeChanged(new Set());
  host.sessionsRefreshed();
  await host.drain('self');
  assert.equal(fixture.writes, 0, 'a returning scope revived the cancelled assignment');
});

// Catches admission while reader input waits: B runs while C waits, and B's agent asks to compact.
// The refusal leaves no record, so nothing can compact after C.
test('host compaction refuses a request while reader input waits in the queue', () => {
  const { fixture } = compactHostFixture();
  const { host, child } = fixture;
  fixture.work = 'pending';
  host.submitted(child, 7);
  host.native(child, compactEvent('toolStart'), 7);
  const refused = host.handle({ method: 'compact-request', params: compactPayload }) as { state: string };
  assert.equal(refused.state, 'refused');
  assert.equal(compactState(host), 'unavailable');
});

// Catches an approval of the requesting command refusing its own request.
test('host compaction keeps a request the reader approved inside its turn', () => {
  const { fixture } = compactHostFixture();
  const { host, child } = fixture;
  host.submitted(child, 7);
  host.native(child, compactEvent('toolStart'), 7);
  host.readerAction('self', true);
  const ack = host.handle({ method: 'compact-request', params: compactPayload }) as { state: string };
  assert.equal(ack.state, 'queued');
});

// Catches a stuck record blocking later turns, and a replacement child completing the old child's request.
test('host compaction outcomes that never arrive block only their own turn and child', async () => {
  const { fixture, makeChild } = compactHostFixture();
  const { host, child, state } = fixture;
  admittedCompaction(fixture);
  host.replyRetained(child, 7);
  host.native(child, compactEvent('rootEnd'), 7);
  state.busy = false;
  await host.drain('self');
  assert.equal(compactState(host), 'uncertain');
  const second = { ...compactPayload, requestId: compactWindow + ':bbbbbbbb-1111-2222-3333-444444444444' };
  const literal = compactLiteral.replace(compactPayload.requestId, second.requestId);
  state.exited = true;
  host.childGone('child');
  const next = makeChild('next');
  fixture.current = next;
  state.exited = false;
  state.busy = true;
  host.submitted(next, 9);
  host.native(next, compactEvent('toolStart', { turnId: 'later', toolId: 'later', command: literal }), 9);
  const ack = host.handle({ method: 'compact-request', params: second }) as { state: string };
  assert.equal(ack.state, 'queued');
  const stages = [
    ['turnStart', {}],
    ['itemStart', { item: { id: 'item' } }],
    ['itemEnd', { item: { id: 'item' } }],
    ['turnEnd', { turn: { status: 'completed' } }],
  ] as const;
  for (const [stage, evidence] of stages)
    host.native(
      next,
      { provider: 'codex', sessionId: 'self', turnId: 'compact', generation: 2, evidence, kind: 'compact', stage },
      undefined,
    );
  assert.equal(compactState(host), 'uncertain');
});

// Catches an error answer from the provider being reported as an unknown outcome.
test('host compaction reports a refused provider request as failed', async () => {
  const { fixture } = compactHostFixture();
  const { host, child, state } = fixture;
  admittedCompaction(fixture);
  host.replyRetained(child, 7);
  host.native(child, compactEvent('rootEnd'), 7);
  state.busy = false;
  await host.drain('self');
  host.native(
    child,
    {
      provider: 'codex',
      sessionId: 'self',
      turnId: null,
      generation: 2,
      evidence: {},
      kind: 'compact',
      stage: 'refused',
    },
    undefined,
  );
  assert.equal(compactState(host), 'failed');
});

// Catches a Claude request that never binds to its prompt generation or never completes from the manual compact result.
test('host compaction binds a Claude request to its prompt generation and completes on the manual compact result', async () => {
  const { fixture } = compactHostFixture('claude');
  const { host, child, state } = fixture;
  const claude = (event: Record<string, unknown>) =>
    ({ provider: 'claude', sessionId: 'self', turnId: null, generation: 1, evidence: {}, ...event }) as NativeEvent;
  host.submitted(child, 7);
  host.native(child, claude({ kind: 'toolStart', toolId: 'call', command: compactLiteral, foreground: true }), 7);
  const ack = host.handle({ method: 'compact-request', params: compactPayload }) as { state: string };
  assert.equal(ack.state, 'queued');
  host.native(child, claude({ kind: 'toolEnd', toolId: 'call', success: true }), 7);
  host.replyRetained(child, 7);
  host.native(child, claude({ kind: 'rootEnd', success: true }), 7);
  state.busy = false;
  await host.drain('self');
  assert.equal(fixture.writes, 1);
  const compact = (stage: string, evidence: Record<string, unknown>) =>
    host.native(child, claude({ kind: 'compact', stage, generation: 2, evidence }), undefined);
  compact('status', { status: 'compacting' });
  assert.equal(compactState(host), 'started');
  compact('status', { compact_result: 'success' });
  compact('boundary', { compact_metadata: { trigger: 'manual' } });
  compact('turnEnd', { subtype: 'success', is_error: false, local_command: 'compact' });
  assert.equal(compactState(host), 'completed');
});

// Catches compaction evidence that completes or reopens another request on the same child, and a timed-out
// request whose late turn no longer completes it after a later request ran.
test('host compaction evidence reaches only the request whose submission it names', async () => {
  const { fixture } = compactHostFixture();
  const { host, child, state } = fixture;
  const ids = ['aaaaaaaa', 'bbbbbbbb', 'cccccccc'].map(
    (head) => `${compactWindow}:${head}-1111-2222-3333-444444444444`,
  );
  const status = (requestId: string) =>
    (
      host.handle({ method: 'compact-status', params: { requestId } }) as {
        state: string;
      }
    ).state;
  const compact = (generation: number, stage: string, evidence: Record<string, unknown> = {}) =>
    host.native(
      child,
      {
        provider: 'codex',
        sessionId: 'self',
        turnId: `compact-${generation}`,
        generation,
        evidence,
        kind: 'compact',
        stage,
      } as NativeEvent,
      undefined,
    );
  const succeed = (generation: number) => {
    compact(generation, 'turnStart');
    compact(generation, 'itemStart', { item: { id: `item-${generation}` } });
    compact(generation, 'itemEnd', { item: { id: `item-${generation}` } });
    compact(generation, 'turnEnd', { turn: { status: 'completed' } });
  };
  // Each request runs in its own reader turn and is delivered once that turn ends.
  const request = async (requestId: string, turn: number) => {
    const turnId = `root-${turn}`;
    state.busy = true;
    host.submitted(child, turn);
    const command = compactLiteral.replace(compactPayload.requestId, requestId);
    host.native(child, compactEvent('toolStart', { turnId, toolId: turnId, command }), turn);
    const ack = host.handle({
      method: 'compact-request',
      params: { ...compactPayload, requestId },
    });
    assert.equal((ack as { state: string }).state, 'queued');
    host.native(child, compactEvent('toolEnd', { turnId, toolId: turnId }), turn);
    host.replyRetained(child, turn);
    host.native(child, compactEvent('rootEnd', { turnId }), turn);
    state.busy = false;
    await host.drain('self');
  };
  // Request A has no native evidence yet. The child holds no unanswered compaction, so B still runs.
  await request(ids[0], 7);
  await request(ids[1], 8);
  succeed(3);
  assert.equal(status(ids[1]), 'completed');
  assert.equal(status(ids[0]), 'uncertain', "B's evidence completed A");
  await request(ids[2], 9);
  compact(4, 'refused');
  assert.equal(status(ids[2]), 'failed');
  assert.equal(status(ids[1]), 'completed', "C's refusal reopened B");
  succeed(2);
  assert.equal(status(ids[0]), 'completed');
  assert.equal(fixture.writes, 3);
});

// Catches the late turn of an unanswered compaction completing a newer request of the same child.
test.each(['turn', 'refusal', 'bound refusal', 'early timeout', 'early refusal'])(
  'host compaction waits for an unanswered receipt until its late %s',
  async (ending) => {
    vi.useFakeTimers();
    try {
      const { fixture } = compactHostFixture();
      const { host, state } = fixture;
      const sent: { id?: number; method?: string }[] = [];
      const starts = () => sent.filter((message) => message.method === 'thread/compact/start').length;
      const wire = new CodexWire({
        send: (line) => sent.push(JSON.parse(line)),
        emit: (event) => {
          if (event.kind === 'native') host.native(child, event.event, undefined);
        },
        clientInfo: { name: 'arc', title: 'Arc', version: '0.1.0' },
        cwd: 'C:\\ws',
        deadlineMs: 1_000,
      });
      const child: CompactChild = {
        key: 'wire',
        agent: 'codex',
        state: () => state,
        compactionUnresolved: () => wire.compactionUnresolved(),
        compact: (beforeWrite) => wire.compact(beforeWrite),
      };
      fixture.current = child;
      const opening = wire.startThread({ cwd: 'C:\\ws' });
      wire.receive(JSON.stringify({ id: sent.at(-1)!.id, result: { thread: { id: 'self' } } }));
      await opening;
      const ids = ['aaaaaaaa', 'bbbbbbbb'].map((head) => `${compactWindow}:${head}-1111-2222-3333-444444444444`);
      const status = (requestId: string) =>
        (host.handle({ method: 'compact-status', params: { requestId } }) as { state: string }).state;
      // Each request runs in its own reader turn and drains once that turn ends.
      const request = (requestId: string, turn: number) => {
        const turnId = `root-${turn}`;
        state.busy = true;
        host.submitted(child, turn);
        const command = compactLiteral.replace(compactPayload.requestId, requestId);
        host.native(child, compactEvent('toolStart', { turnId, toolId: turnId, command }), turn);
        host.handle({ method: 'compact-request', params: { ...compactPayload, requestId } });
        host.native(child, compactEvent('toolEnd', { turnId, toolId: turnId }), turn);
        host.replyRetained(child, turn);
        host.native(child, compactEvent('rootEnd', { turnId }), turn);
        state.busy = false;
        void host.drain('self');
      };
      const runTurn = (id: string) => {
        const item = { type: 'contextCompaction', id: `${id}-item` };
        const send = (method: string, params: Record<string, unknown>) =>
          wire.receive(JSON.stringify({ method, params: { threadId: 'self', ...params } }));
        send('turn/started', { turn: { id } });
        send('item/started', { turnId: id, item });
        send('item/completed', { turnId: id, item });
        send('turn/completed', { turn: { id, status: 'completed' } });
      };
      // Request A gets no answer before the deadline. Request B waits for A's late turn.
      request(ids[0], 7);
      const firstRpc = sent.at(-1)!.id;
      if (ending.startsWith('early')) {
        wire.receive(JSON.stringify({ method: 'turn/started', params: { threadId: 'self', turn: { id: 'late' } } }));
        if (ending === 'early refusal') wire.receive(JSON.stringify({ id: firstRpc, error: { message: 'not now' } }));
      }
      await vi.advanceTimersByTimeAsync(1_000);
      assert.equal(status(ids[0]), ending === 'early timeout' ? 'started' : 'uncertain');
      if (ending.startsWith('early')) {
        assert.equal(wire.hasOpenTurns(), true, 'the native turn must stay busy after its initial RPC settles');
        assert.equal(wire.compactionUnresolved(), true);
      }
      request(ids[1], 8);
      await vi.advanceTimersByTimeAsync(1_000);
      assert.equal(starts(), 1, 'B was submitted while A had no answer');
      assert.equal(status(ids[1]), 'queued');
      if (ending === 'bound refusal') {
        wire.receive(JSON.stringify({ method: 'turn/started', params: { threadId: 'self', turn: { id: 'late' } } }));
        wire.receive(JSON.stringify({ id: firstRpc, error: { message: 'not now' } }));
        await vi.advanceTimersByTimeAsync(0);
        assert.equal(starts(), 1, "B reached the provider before A's bound native turn ended");
        assert.equal(status(ids[1]), 'queued');
        assert.equal(status(ids[0]), 'uncertain', 'contradictory native evidence must stay unknown');
      }
      if (ending !== 'refusal') runTurn('late');
      else wire.receive(JSON.stringify({ id: firstRpc, error: { message: 'not now' } }));
      assert.equal(status(ids[1]), 'queued', "A's late turn reached B");
      assert.equal(
        status(ids[0]),
        ending === 'turn' || ending === 'early timeout' ? 'completed' : ending === 'refusal' ? 'failed' : 'uncertain',
      );
      assert.equal(wire.hasOpenTurns(), false);
      assert.equal(wire.compactionUnresolved(), false, 'terminal evidence must clear the delivery barrier');
      // Resolving A's receipt drains B without another host event.
      await vi.advanceTimersByTimeAsync(0);
      assert.equal(starts(), 2);
      wire.receive(JSON.stringify({ id: sent.at(-1)!.id, result: {} }));
      runTurn('second');
      await vi.advanceTimersByTimeAsync(0);
      assert.equal(status(ids[1]), 'completed');
      await host.drain('self');
      assert.equal(starts(), 2, 'B must drain exactly once');
      wire.close('finished');
    } finally {
      vi.useRealTimers();
    }
  },
);

// Catches a busy child or a new ask at the write boundary cancelling work that only had to wait, and expiry reported as a change.
test('self compaction keeps waiting while the session is briefly not ready and reports expiry', async () => {
  let clock = 0;
  const book = new CompactRequests(compactWindow, () => clock);
  book.observe(compactBinding, compactEvent('toolStart'));
  book.admit(compactPayload, () => true);
  book.observe(compactBinding, compactEvent('toolEnd'));
  book.observe(compactBinding, compactEvent('rootEnd'), true);
  let ready = false;
  let writes = 0;
  const delivery = {
    eligible: () => ready,
    submit: async (_binding: Readonly<CompactBinding>, check: () => void) => {
      ready = false;
      check();
      writes++;
    },
  };
  await book.deliver(compactPayload.requestId, delivery);
  assert.equal(book.status(compactPayload.requestId)?.state, 'queued');
  ready = true;
  await book.deliver(compactPayload.requestId, delivery);
  assert.equal(book.status(compactPayload.requestId)?.state, 'queued');
  clock = COMPACT_LIMITS.admissionMs;
  ready = true;
  await book.deliver(compactPayload.requestId, delivery);
  assert.equal(writes, 0);
  assert.equal(book.status(compactPayload.requestId)?.state, 'cancelled');
  assert.match(book.status(compactPayload.requestId)!.reason, /expired/);
});

// Catches a frozen acknowledgement for a finished record, a copied payload in another call, and a request ID reused after its record expired.
test('self compaction returns the current record for a retried request ID and refuses it for another call or after expiry', () => {
  let clock = 0;
  const book = new CompactRequests(compactWindow, () => clock);
  book.observe(compactBinding, compactEvent('toolStart'));
  book.admit(compactPayload, () => true);
  const other = { ...compactPayload, requestId: compactWindow + ':bbbbbbbb-1111-2222-3333-444444444444' };
  book.observe(
    compactBinding,
    compactEvent('toolStart', {
      toolId: 'other',
      command: compactLiteral.replace(compactPayload.requestId, other.requestId),
    }),
  );
  assert.throws(() => book.admit(other, () => true), /already has a pending/);
  book.invalidate(() => true, 'The reader acted.');
  assert.equal(book.admit(compactPayload, () => true).state, 'cancelled');
  book.observe(compactBinding, compactEvent('toolStart', { toolId: 'copy' }));
  assert.throws(() => book.admit(compactPayload, () => true), /already used/);
  assert.equal(book.ready(compactPayload), false);
  clock += COMPACT_LIMITS.retentionMs;
  assert.equal(book.status(compactPayload.requestId), null);
  const later = { ...compactBinding, turn: 'later', submissionId: 'later' };
  book.observe(later, compactEvent('toolStart', { toolId: 'later', turnId: 'later' }));
  assert.throws(() => book.admit(compactPayload, () => true), /already used/);
});

// These guards catch guarded sends that reach a child they must not reach, with fake children and no provider startup.
class GuardChild {
  readonly key = 'worker-key';
  agent = 'claude';
  idle: string | null = null;
  turnEnds = 0;
  attempts: string[] = [];
  guardedTurnEnds() {
    return this.turnEnds;
  }
  // The local submission number the child assigns to its next prompt.
  submission = 7;
  guardedPrompt(text: string, clientUuid: string, onSubmitted?: (turnId: number) => void) {
    this.attempts.push(text);
    onSubmitted?.(this.submission);
    return new GuardedAttempt(clientUuid);
  }
  sessionId = 'worker';
  exited = false;
  lastError: string | null = null;
  state() {
    return { sessionId: this.sessionId, exited: this.exited, lastError: this.lastError };
  }
  guardedIdle() {
    return this.idle;
  }
}

function guardFixture() {
  const child = new GuardChild();
  const policy = new GuardedSends<GuardChild>('window', (owner) => port.live(owner));
  const coordinator = { provider: 'claude' as const, id: 'coordinator' };
  policy.recordStart({
    requester: coordinator,
    activation: 'window',
    worker: 'worker',
    child,
  });
  const facts: GuardedTargetFacts = {
    current: true,
    archived: false,
    scope: 'scope',
    sourceRevision: 'revision-1',
    latestTurn: 'turn-1',
    queued: 0,
    pendingSubmissions: 0,
    pendingControls: 0,
    background: false,
    writerConflict: false,
  };
  policy.facts = () => facts;
  const writes: GuardedAttempt[] = [];
  const port = {
    alive: true,
    retained: child as GuardChild | null,
    leased: true,
    live: (_owner: GuardedOwner<GuardChild>) => (port.alive ? port.retained : null),
    withLease: async <T>(_child: GuardChild, work: () => Promise<T>) => (port.leased ? work() : null),
    write: (_child: GuardChild, _text: string) => {
      const attempt = new GuardedAttempt(`uuid-${writes.length}`);
      attempt.markWritten();
      writes.push(attempt);
      return attempt;
    },
  };
  let serial = 0;
  const send = (changes: Partial<GuardedSendRequest> = {}) =>
    runGuardedSend(
      policy,
      {
        requestId: `window:${++serial}`,
        activation: 'window',
        sessionId: 'worker',
        prompt: 'Apply the accepted corrections.',
        observation: policy.observe('worker', coordinator, facts) ?? '',
        requester: coordinator,
        ...changes,
      },
      port,
    );
  return { policy, child, coordinator, facts, writes, port, send };
}

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

test('the window channel retains guarded sends by requester, provider, target, observation and exact text, and refuses without an owner record', async () => {
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
});

test('cold source facts validate restored completed identities and invalidate exact source changes', () => {
  const directory = tempDir('agent-source-facts-');
  const file = path.join(directory, 'session.jsonl');
  const timestamp = '2026-10-08T12:00:01Z';
  const records = [
    {
      type: 'user',
      promptId: 'p1',
      sessionId: 'known',
      cwd: directory,
      timestamp,
      message: { role: 'user', content: 'prompt' },
    },
    {
      type: 'assistant',
      timestamp,
      message: {
        id: 'answer',
        role: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
        stop_reason: 'end_turn',
      },
    },
  ];
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const source = () => ({
    agent: 'claude' as const,
    file,
    sessionId: 'known',
    ...revisionOf(fs.statSync(file, { bigint: true })),
  });
  const cache = new AgentReadSources();
  const facts = cache.resolve(source(), () => 'scope', [directory])!;
  assert.equal(facts.identitiesComplete, true);
  assert.equal(facts.historyComplete, true);
  assert.equal(facts.source, guardedSourceIdentity(source()));
  const record = {
    provider: facts.provider,
    sessionId: facts.sessionId,
    source: facts.source,
    scope: facts.scope,
    sourceRevision: facts.sourceRevision,
    promptId: 'p1',
    startedAt: Date.parse(timestamp),
  };
  const restored = JSON.parse(JSON.stringify([record])) as AgentReadRecord[];
  assert.equal(
    projectAgentRead(restored, (one) =>
      new AgentReadSources().resolve(source(), () => 'scope', [directory], one.sourceRevision),
    ).size,
    1,
  );
  assert.equal(
    cache.resolve(source(), () => 'scope', [directory]),
    facts,
  );
  const snapshot = fs.statSync(file, { bigint: true });
  const stamp = vi.spyOn(filesystem, 'statSync').mockReturnValue({ ...snapshot, ctimeNs: snapshot.ctimeNs + 1n });
  syncBuiltinESMExports();
  try {
    assert.equal(
      cache.resolve(source(), () => 'scope', [directory], record.sourceRevision),
      null,
    );
    assert.notEqual(guardedSourceRevision(file), record.sourceRevision);
  } finally {
    stamp.mockRestore();
    syncBuiltinESMExports();
  }
  fs.appendFileSync(file, '\n');
  assert.equal(
    projectAgentRead(restored, (one) => cache.resolve(source(), () => 'scope', [directory], one.sourceRevision)).size,
    0,
  );
  const appended = cache.resolve(source(), () => 'scope', [directory])!;
  assert.notEqual(appended.sourceRevision, record.sourceRevision);
  assert.equal(cache.resolve(source(), () => 'other', [directory])!.scope, 'other');
  fs.writeFileSync(file, '{}\n');
  assert.equal(
    projectAgentRead(restored, (one) => cache.resolve(source(), () => 'scope', [directory], one.sourceRevision)).size,
    0,
  );
  fs.renameSync(file, `${file}.old`);
  fs.writeFileSync(file, records.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  assert.notEqual(guardedSourceIdentity(source()), record.source);
  assert.equal(
    projectAgentRead(restored, (one) => cache.resolve(source(), () => 'scope', [directory], one.sourceRevision)).size,
    0,
  );
  assert.equal(
    cache.resolve(source(), () => null, [directory]),
    null,
  );
  assert.equal(
    cache.resolve(source(), () => 'scope', [path.join(directory, 'elsewhere')]),
    null,
  );
  fs.rmSync(file);
  assert.equal(
    cache.resolve({ agent: 'claude', file, sessionId: 'known', size: 0, mtimeMs: 0 }, () => 'scope', [directory]),
    null,
  );
});

test('source facts bound bytes and identity coverage without certifying omitted identities', () => {
  const directory = tempDir('agent-source-bounds-');
  const file = path.join(directory, 'session.jsonl');
  const source = () => ({
    agent: 'claude' as const,
    file,
    sessionId: 'known',
    ...revisionOf(fs.statSync(file, { bigint: true })),
  });
  const records = Array.from({ length: AGENT_SOURCE_LIMITS.identities + 1 }, (_, index) => [
    {
      type: 'user',
      promptId: `p${index}`,
      sessionId: 'known',
      cwd: directory,
      timestamp: new Date(1000000 + index * 1000).toISOString(),
      message: { role: 'user', content: 'prompt' },
    },
    {
      type: 'assistant',
      timestamp: new Date(1000000 + index * 1000).toISOString(),
      message: {
        id: `a${index}`,
        role: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
        stop_reason: 'end_turn',
      },
    },
  ]).flat();
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const cache = new AgentReadSources();
  const facts = cache.resolve(source(), () => 'scope', [directory])!;
  assert.equal(facts.identitiesComplete, false);
  assert.equal(facts.historyComplete, false);
  assert.equal(facts.turns.length, AGENT_SOURCE_LIMITS.identities);
  const last = facts.turns.at(-1)!;
  assert.equal(currentAgentRead({ ...facts, ...last }, facts), false);
  const firstBytes = source().size;
  const other = path.join(directory, 'other.jsonl');
  fs.writeFileSync(other, JSON.stringify(records[0]) + '\n');
  cache.resolve(
    { agent: 'claude', file: other, sessionId: 'known', ...revisionOf(fs.statSync(other, { bigint: true })) },
    () => 'scope',
    [directory],
  );
  const evictedWindow = openReadWindow();
  cache.resolve(source(), () => 'scope', [directory]);
  assert.ok(closeReadWindow(evictedWindow).bytes > firstBytes);
  fs.writeFileSync(file, JSON.stringify(records[0]) + '\n' + ' '.repeat(AGENT_SOURCE_LIMITS.bytes));
  const window = openReadWindow();
  const large = cache.resolve(source(), () => 'scope', [directory])!;
  const tally = closeReadWindow(window);
  assert.ok(tally.bytes <= AGENT_SOURCE_LIMITS.bytes);
  assert.equal(large.identitiesComplete, false);
  assert.deepEqual(large.turns, []);
  cache.clear();
  for (let index = 0; index <= AGENT_SOURCE_LIMITS.sources; index++) {
    const next = path.join(directory, `source-${index}.jsonl`);
    fs.writeFileSync(next, JSON.stringify(records[0]) + '\n');
    cache.resolve(
      { agent: 'claude', file: next, sessionId: 'known', ...revisionOf(fs.statSync(next, { bigint: true })) },
      () => 'scope',
      [directory],
    );
  }
  const oldest = path.join(directory, 'source-0.jsonl');
  const evictedSources = openReadWindow();
  cache.resolve(
    { agent: 'claude', file: oldest, sessionId: 'known', ...revisionOf(fs.statSync(oldest, { bigint: true })) },
    () => 'scope',
    [directory],
  );
  assert.equal(closeReadWindow(evictedSources).bytes, 2 * fs.statSync(oldest).size);
});

test('guarded source revisions refuse growth that ordinary admission accepts, replacement, and unreadable sources', () => {
  const file = path.join(tempDir('guarded-source-'), 'session.jsonl');
  fs.writeFileSync(file, '{}\n');
  const observed = guardedSourceRevision(file)!;
  assert.equal(guardedSourceRevision(file), observed);
  const before = revisionOf(fs.statSync(file, { bigint: true }));
  fs.appendFileSync(file, '{"type":"summary"}\n');
  const after = revisionOf(fs.statSync(file, { bigint: true }));
  if (supportedFileIdentity(before) && supportedFileIdentity(after))
    assert.equal(
      sessionSourceAdmitted(
        {
          agent: 'claude',
          file,
          sessionId: 's',
          size: before.size,
          mtimeMs: before.mtimeMs,
          dev: before.dev,
          ino: before.ino,
        },
        after,
      ),
      true,
    );
  const grown = guardedSourceRevision(file);
  assert.notEqual(grown, observed);
  fs.writeFileSync(file, '{"a":1}\n');
  assert.notEqual(guardedSourceRevision(file), observed);
  assert.notEqual(guardedSourceRevision(file), grown);
  fs.rmSync(file);
  assert.equal(guardedSourceRevision(file), null);
});

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

function guardedRequest(observation: string, requester: { provider: 'claude'; id: string }): GuardedSendRequest {
  return {
    requestId: 'window:check',
    activation: 'window',
    sessionId: 'worker',
    prompt: 'Next.',
    observation,
    requester,
  };
}

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

// Catches a guarded write that skips the submission registration ordinary delivery performs. A deferred compaction
// that the follow-up turn requests then has no owning submission and is refused.
test('a deferred compaction requested from a guarded follow-up turn binds to that turn on both providers', () => {
  for (const agent of ['claude', 'codex'] as const) {
    const { fixture } = compactHostFixture(agent);
    const { host, child } = fixture;
    const writer = new GuardChild();
    const policy = new GuardedSends<GuardChild>('window', () => writer);
    const delivery = guardedDeliveryPort(
      policy,
      { find: () => writer, withActivity: async (_key, work) => work(writer) },
      () => false,
      () => 'uuid-follow-up',
      (_writer, turnId) => host.submitted(child, turnId),
    );
    delivery.write(writer, 'Apply the corrections, then compact.');
    const generation = agent === 'claude' ? 1 : null;
    host.native(child, compactEvent('toolStart', { provider: agent, generation }), writer.submission);
    const ack = host.handle({ method: 'compact-request', params: compactPayload }) as { state: string };
    assert.equal(ack.state, 'queued', agent);
  }
});

// Catches a follow-up admitted while a deferred self-compaction waits for the worker. The follow-up would run on the
// context the session asked to shrink, and the compaction would follow the wrong turn.
test('a guarded follow-up refuses as busy while a deferred self-compaction waits for the worker', async () => {
  const { fixture } = compactHostFixture();
  const { host, child, state } = fixture;
  state.sessionId = 'worker';
  host.submitted(child, 7);
  host.native(child, compactEvent('toolStart', { sessionId: 'worker' }), 7);
  assert.equal(
    (host.handle({ method: 'compact-request', params: compactPayload }) as { state: string }).state,
    'queued',
  );
  const { policy, facts, writes, send } = guardFixture();
  policy.facts = guardedFactsWithCompaction(
    () => facts,
    (sessionId) => host.requests.waitingSessions().includes(sessionId),
  );
  assert.equal((await send()).reason, GUARDED_SEND_REASONS.busy);
  assert.equal(writes.length, 0);
  host.requests.invalidate(() => true, 'The reader acted.');
  const admitted = send();
  await vi.waitFor(() => assert.equal(writes.length, 1));
  writes[0].settle({ outcome: 'accepted', nativeTurnId: 'turn-2', reason: '' });
  assert.equal((await admitted).status, 'accepted');
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

test('guarded exhaustion retains same-ID refusals and leaves the independent start and curation allowance usable', async () => {
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
});

test('session reads and guarded starts carry the requester provider only to a window that lists it', async () => {
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
});

test('filter wire requests admit only bounded query payloads and the listing subset', () => {
  const base = { id: 'filter-one', version: 1, token: 'a'.repeat(64), requester: null };
  for (const request of [
    { ...base, method: 'filter', params: { query: '' } },
    { ...base, method: 'filter', params: { query: 'session:one OR session:codex:two' } },
    { ...base, method: 'sessions', params: { query: 'session:one', limit: 3 } },
  ])
    assert.deepEqual(parseSessionRequest(request), request);
  for (const request of [
    { ...base, method: 'filter', params: {} },
    { ...base, method: 'filter', params: { query: '', extra: true } },
    { ...base, method: 'filter', params: { query: 'session:one OR' } },
    { ...base, method: 'filter', params: { query: 'x'.repeat(201) } },
    { ...base, method: 'sessions', params: { query: 'is:unread' } },
    { ...base, method: 'sessions', params: { query: 'find:needle' } },
    { ...base, method: 'filter', params: { query: '' }, filterContext: {} },
  ])
    assert.equal(parseSessionRequest(request), null);
});

test('filter channel exchanges wait beyond the read deadline and carry connection cancellation', async () => {
  const home = tempDir('filter-channel-');
  const channel = new WindowChannel(home);
  channels.push(channel);
  let admitted: any;
  let finish!: () => void;
  channel.setRequestHandler((request) => {
    admitted = request;
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  await channel.update({ folders: [], scopeReady: true, panelReady: false, panelVisible: false });
  vi.useFakeTimers();
  try {
    const result = requestWindow('filter', { query: 'session:one' }, channel.hostId, home);
    await vi.waitFor(() => assert.equal(admitted?.method, 'filter'));
    assert.equal(admitted.filterContext.signal.aborted, false);
    assert.ok(admitted.filterContext.deadline > Date.now() + 25_000);
    await vi.advanceTimersByTimeAsync(2_000);
    assert.equal(admitted.filterContext.signal.aborted, false);
    finish();
    await result;
  } finally {
    vi.useRealTimers();
  }
});

test('a disconnected filter transport reports an unknown outcome and cancels host admission', async () => {
  const home = tempDir('filter-disconnect-');
  const channel = new WindowChannel(home);
  channels.push(channel);
  let admitted: any;
  let finish!: () => void;
  channel.setRequestHandler((request) => {
    admitted = request;
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  await channel.update({ folders: [], scopeReady: true, panelReady: true, panelVisible: true });
  const result = requestWindow('filter', { query: 'session:one' }, channel.hostId, home);
  await vi.waitFor(() => assert.ok(admitted));
  await channel.dispose();
  assert.equal(((await result) as any).status, 'unknown');
  await vi.waitFor(() => assert.equal(admitted.filterContext.signal.aborted, true));
  finish();
});

test('older hosts refuse shorthand before either query route connects and retain exact requests', async () => {
  const home = tempDir('shorthand-negotiation-');
  const channel = new WindowChannel(home);
  const seen: any[] = [];
  channel.setRequestHandler((request) => {
    seen.push(request);
    return {};
  });
  await channel.update({ folders: [], scopeReady: true, panelReady: false, panelVisible: false });
  const registration = path.join(home, 'hosts', `${channel.hostId}.json`);
  const old = JSON.parse(fs.readFileSync(registration, 'utf8'));
  old.capabilities = ['sessionQuery'];
  fs.writeFileSync(registration, JSON.stringify(old));
  try {
    for (const method of ['filter', 'sessions'] as const) {
      for (const query of [
        'id:01a12cef id:01a12a6b',
        '-id:claude:abcdefgh',
        'id:codex:abcdefgh',
        'session:claude:abcdefgh',
        '-session:codex:abcdefgh',
      ])
        await assert.rejects(requestWindow(method, { query }, channel.hostId, home), /must reload/);
      assert.equal(seen.length, method === 'filter' ? 0 : 5);
      for (const query of [
        'session:one',
        'session:one session:two',
        'session:one OR session:two',
        'session:ef5a03c3-f255-41b6-b57c-c15af453ac8a',
        '"id:abcdefgh"',
      ])
        await requestWindow(method, { query }, channel.hostId, home);
    }
    await requestWindow('filter', { query: '' }, channel.hostId, home);
    await requestWindow('sessions', {}, channel.hostId, home);
    assert.equal(seen.length, 12);
  } finally {
    await channel.dispose();
  }
});

test('accepted no-turn commands retain positive status until qualified process closure', () => {
  const commands = [{ id: 'command', startedAt: 100 }];
  const status = (running: boolean, waiting: boolean, exited?: number, unchanged = true) =>
    sessionReadStatus('session', null, running, waiting, undefined, exited, { unchanged, mtimeMs: 150 }, commands);
  assert.equal(status(false, false), 'background');
  assert.equal(status(true, false), 'running');
  assert.equal(status(false, true), 'waiting');
  assert.equal(status(false, false, 200), 'stopped');
  assert.equal(status(false, false, 200, false), 'background');
  assert.equal(status(false, false, 99), 'background');
  assert.equal(status(false, false, 149), 'background');
});

test('deferred compaction retains unknown membership and cancels only proven absence', async () => {
  for (const agent of ['claude', 'codex'] as const) {
    const { fixture } = compactHostFixture(agent);
    const { host, child, state } = fixture;
    const event = (kind: 'toolStart' | 'toolEnd' | 'rootEnd') =>
      compactEvent(kind, { provider: agent, ...(agent === 'claude' ? { turnId: null, generation: 1 } : {}) });
    host.submitted(child, 7);
    host.native(child, event('toolStart'), 7);
    assert.equal(
      (host.handle({ method: 'compact-request', params: compactPayload }) as { state: string }).state,
      'queued',
    );
    host.native(child, event('toolEnd'), 7);
    host.replyRetained(child, 7);
    host.native(child, event('rootEnd'), 7);
    state.busy = false;
    fixture.work = 'unknown';
    host.sessionsRefreshed();
    await host.drain('self');
    assert.equal(fixture.writes, 0, agent);
    assert.equal(compactState(host), 'queued', agent);
    fixture.work = 'absent';
    host.sessionsRefreshed();
    await host.drain('self');
    assert.equal(fixture.writes, 0, agent);
    assert.equal(compactState(host), 'cancelled', agent);
  }
});
test('dispatch channel schema, capability admission, bounds and explicit refusals remain distinct', async () => {
  const { channel, home, entry } = await fixture();
  const launchId = 'aaaaaaaa-1111-2222-3333-444444444444';
  const params = { dispatchAction: 'wait' as const, launchId, deadlineMs: 1 };
  const valid = request(entry, { method: 'dispatch', params });
  assert.deepEqual(parseSessionRequest(valid), valid);
  const status = { dispatchAction: 'status', launchId, cursor: `${launchId}:1`, limit: 128 };
  assert.deepEqual(parseSessionRequest({ ...valid, params: status })?.params, status);
  for (const changed of [
    { ...status, launchId: '(' },
    { ...status, launchId: null },
    { ...status, cursor: 'bbbbbbbb-1111-2222-3333-444444444444:1' },
    { ...status, cursor: `${launchId}:12345678901234567` },
  ]) {
    assert.doesNotThrow(() => assert.equal(parseSessionRequest({ ...valid, params: changed }), null));
  }
  for (const changed of [
    { ...params, deadlineMs: 0 },
    { ...params, deadlineMs: 110001 },
    { ...params, launchId: '../unsafe' },
    { ...params, eventId: launchId },
    { ...params, dispatchAction: 'callback' },
  ])
    assert.equal(parseSessionRequest({ ...valid, params: changed }), null);
  await assert.rejects(requestWindow('dispatch', params, channel.hostId, home), /must reload/);
  const start = {
    setup: { kind: 'custom' as const, agent: 'codex', model: '', effort: '', permissionMode: '' },
    prompt: 'review',
    agentRun: false,
    dispatch: true,
    completion: 'manual' as const,
  };
  const writes = vi.fn<() => { status: string }>(() => ({ status: 'accepted' }));
  channel.setRequestHandler(writes);
  await assert.rejects(requestWindow('start', start, channel.hostId, home), /must reload/);
  assert.equal(writes.mock.calls.length, 0);
  const receipts = new DispatchReceipts(home);
  const host = new HostedDispatch(receipts, () => null);
  const launch = receipts.reserve({
    origin: 'b'.repeat(24),
    requester: null,
    policy: null,
    promptSha256: 'a'.repeat(64),
    completion: 'wait',
    alias: null,
  });
  channel.setDispatchHandler((request) => host.request(channel.hostId, request.params, request.filterContext!.signal));
  await channel.update(state);
  await assert.rejects(
    requestWindow('dispatch', { ...params, launchId: launch.launchId }, channel.hostId, home),
    /another Arc activation/,
  );
  channel.setDispatchHandler(() => ({ text: 'x'.repeat(SESSION_REQUEST_LIMITS.lineBytes + 1) }));
  await assert.rejects(
    requestWindow('dispatch', { dispatchAction: 'status', launchId }, channel.hostId, home),
    /allowance/,
  );
  const manual = receipts.reserve({ ...launch, origin: channel.hostId, completion: 'manual' });
  channel.setDispatchHandler((request) => host.request(channel.hostId, request.params, request.filterContext!.signal));
  await assert.rejects(
    requestWindow('dispatch', { ...params, launchId: manual.launchId }, channel.hostId, home),
    /did not select waited/,
  );
  const waited = receipts.reserve({ ...launch, origin: channel.hostId });
  vi.useFakeTimers();
  let admitted = false;
  channel.setDispatchHandler((request) => {
    admitted = true;
    return host.request(channel.hostId, request.params, request.filterContext!.signal);
  });
  const pending = requestWindow(
    'dispatch',
    { ...params, launchId: waited.launchId, deadlineMs: 100 },
    channel.hostId,
    home,
  );
  await vi.waitFor(() => assert.equal(admitted, true));
  await vi.advanceTimersByTimeAsync(100);
  assert.equal(((await pending) as any).state, 'deadline');
  vi.useRealTimers();
});

test('dispatch wait disconnect cancels the channel subscription and retains its launch identity', async () => {
  const { channel, home } = await fixture();
  const receipts = new DispatchReceipts(home);
  const host = new HostedDispatch(receipts, () => null);
  const launch = receipts.reserve({
    origin: channel.hostId,
    requester: null,
    policy: null,
    promptSha256: 'a'.repeat(64),
    completion: 'wait',
    alias: null,
  });
  let admitted: any;
  channel.setDispatchHandler((request) => {
    admitted = request;
    return host.request(channel.hostId, request.params, request.filterContext!.signal);
  });
  await channel.update(state);
  const launchId = launch.launchId;
  const pending = requestWindow(
    'dispatch',
    { dispatchAction: 'wait', launchId, deadlineMs: 1000 },
    channel.hostId,
    home,
  );
  await vi.waitFor(() => assert.ok(admitted));
  await channel.dispose();
  const result = (await pending) as any;
  assert.equal(result.state, 'uncertain');
  assert.equal(result.launchId, launchId);
  await vi.waitFor(() => assert.equal(admitted.filterContext.signal.aborted, true));
  assert.equal(receipts.launch(launchId).launchId, launchId);
});
