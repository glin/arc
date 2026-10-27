import { revisionOf, supportedFileIdentity } from './transcript';
import ts from 'typescript';
import { runInNewContext } from 'node:vm';
import { declarationSource } from '../test/source-contract';
import { GuardedAttempt } from './agentwire.ts';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import filesystem from 'node:fs';
import * as crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import * as path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { tempDir } from './temproot.ts';
import {
  GUARDED_SEND_REASONS,
  GuardedSends,
  guardedDeliveryPort,
  guardedFactsWithCompaction,
} from './sessionwrites.ts';
import {
  CompactHost,
  promptAsReader,
  CompactRequests,
  compactCancelPayload,
  compactCarryLine,
  compactCommandPayload,
  COMPACT_LIMITS,
  readerCarry,
  readerPrompt,
  validContinuation,
  validContinuationPath,
  type CompactPersistence,
  type CompactReceipt,
  type CompactBinding,
  type CompactChild,
} from './compactrequest';
import { CompactStore } from './compactstore';
import type { NativeEvent } from './agentwire';
import { CodexWire } from './codexwire.ts';

import { GuardChild, guardFixture } from '../test/guarded-send';

import { compactWindow, compactPayload } from '../test/compact-request';

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

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
    initiating: true,
    success: true,
    ...extra,
  };
}

// A retained child whose state each case changes between host observations.
function compactHostFixture(agent: 'claude' | 'codex' = 'codex', persistence?: CompactPersistence) {
  const state = { sessionId: 'self' as string | null, busy: true, asks: [] as unknown[], ready: true, exited: false };
  const fixture = {
    clock: 0,
    calls: 0,
    writes: 0,
    continuationWrites: [] as string[],
    authority: 'source' as string | null,
    unresolved: false,
    idle: true,
    continuationWork: 'none' as 'none' | 'pending' | 'absent' | 'unknown',
    continuationBoundary: () => {},
    writeFailure: false,
    receiptOutcome: 'accepted' as 'accepted' | 'unknown',
    // The last native submission generation. The requesting turn of the Claude cases is generation 1.
    compactions: 1,
    work: 'none' as 'none' | 'pending' | 'absent' | 'unknown',
    beforeWrite: () => {},
    // Holds delivery at the activity lease while a case acts on the waiting request.
    lease: null as Promise<void> | null,
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
      compactionUnresolved: () => fixture.unresolved,
      guardedIdle: () => (fixture.idle && !state.busy ? null : 'busy'),
      guardedPrompt: (text, uuid, submitted, check) => {
        const attempt = new GuardedAttempt(uuid, check);
        submitted(8);
        state.busy = true;
        try {
          fixture.continuationBoundary();
          attempt.prepareWrite();
          if (fixture.writeFailure) throw new Error('write failed');
          fixture.continuationWrites.push(text);
          attempt.markWritten();
          attempt.settle({ outcome: fixture.receiptOutcome, nativeTurnId: 'continued', reason: '' });
        } catch (error) {
          attempt.settle({ outcome: 'unknown', nativeTurnId: null, reason: (error as Error).message });
        }
        return attempt;
      },
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
        if (fixture.lease) await fixture.lease;
        if (child !== fixture.current || child.state().exited) return null;
        await work(child);
        return undefined;
      },
      findToken: (token) => (token === 'c'.repeat(32) ? fixture.current : null),
      readerWork: () => fixture.work,
      continuationWork: () => fixture.continuationWork,
      authority: () => fixture.authority,
    },
    () => fixture.clock,
    persistence,
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

const continuationText = '  Continue the "quoted" task.\r\nWrite café once.\r\n';

const continuationPayload = {
  ...compactPayload,
  continuation: {
    text: continuationText,
    sha256: crypto.createHash('sha256').update(continuationText).digest('hex'),
  },
};

const continuationLiteral = (payload = continuationPayload) =>
  `arc compact request --self --after-turn --continuation-file '${process.platform === 'win32' ? 'C:/temp/next turn.txt' : '/tmp/next turn.txt'}' --continuation-sha256 ${payload.continuation.sha256} --request-id ${payload.requestId} --window ${payload.window} --json`;

function memoryCompactionStore() {
  const records = new Map<string, CompactReceipt>();
  const store: CompactPersistence = {
    reserve: async (receipt) => {
      records.set(receipt.observation.requestId, structuredClone(receipt));
    },
    save: async (receipt) => {
      records.set(receipt.observation.requestId, structuredClone(receipt));
    },
    read: (id) => structuredClone(records.get(id) ?? null),
    ended: () => false,
    release: () => {},
  };
  return { store, records };
}

async function admitContinuation(
  fixture: ReturnType<typeof compactHostFixture>['fixture'],
  payload = continuationPayload,
) {
  fixture.host.submitted(fixture.child, 7);
  fixture.host.native(
    fixture.child,
    compactEvent('toolStart', {
      command: continuationLiteral(payload),
      provider: fixture.child.agent,
      generation: fixture.child.agent === 'claude' ? 1 : null,
    }),
    7,
  );
  return (await fixture.host.handle({ method: 'compact-request', params: payload })) as { state: string };
}

async function finishRequest(fixture: ReturnType<typeof compactHostFixture>['fixture']) {
  const extra = { provider: fixture.child.agent, generation: fixture.child.agent === 'claude' ? 1 : null };
  fixture.host.native(fixture.child, compactEvent('toolEnd', extra), 7);
  fixture.host.native(fixture.child, compactEvent('rootEnd', extra), 7);
  fixture.state.busy = false;
  await fixture.host.drain('self');
}

function finishCompact(fixture: ReturnType<typeof compactHostFixture>['fixture'], generation = 2) {
  const stages: readonly [string, object][] =
    fixture.child.agent === 'claude'
      ? [
          ['status', { compact_result: 'success' }],
          ['boundary', { compact_metadata: { trigger: 'manual' } }],
          ['turnEnd', { subtype: 'success', is_error: false }],
        ]
      : [
          ['turnStart', {}],
          ['itemStart', { item: { id: 'item' } }],
          ['itemEnd', { item: { id: 'item' } }],
          ['turnEnd', { turn: { status: 'completed' } }],
        ];
  for (const [stage, evidence] of stages)
    fixture.host.native(
      fixture.child,
      {
        provider: fixture.child.agent,
        sessionId: 'self',
        turnId: 'compact',
        generation,
        evidence,
        kind: 'compact',
        stage,
      } as NativeEvent,
      undefined,
    );
}

const continuationState = (fixture: ReturnType<typeof compactHostFixture>['fixture']) =>
  fixture.host.handle({ method: 'compact-status', params: { requestId: continuationPayload.requestId } }) as {
    state: string;
    continuation?: { state: string; write: string; text: string };
  };

test('self compaction joins one live literal root call and acknowledges before the tool and exact turn finish', async () => {
  let clock = 0;
  const book = new CompactRequests(compactWindow, () => clock);
  // The refusal names the command form Arc can observe, without naming a provider tool.
  assert.throws(
    () => book.admit(compactPayload, () => true),
    /has not seen this command.*Run arc compact request as its own command, with no chain, pipe or substitution\.$/,
  );
  book.observe(compactBinding, compactEvent('toolStart', { sessionId: 'foreign' }));
  assert.equal(book.ready(compactPayload), false);
  book.observe(compactBinding, compactEvent('toolStart', { initiating: false }));
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
  book.observe(compactBinding, compactEvent('rootEnd', { turnId: 'another' }));
  await book.deliver(compactPayload.requestId, delivery);
  assert.equal(writes, 0);
  book.observe(compactBinding, compactEvent('rootEnd'));
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
  ]) {
    const book = new CompactRequests(compactWindow);
    book.observe(compactBinding, compactEvent('toolStart'));
    book.admit(compactPayload, () => true);
    book.observe(compactBinding, compactEvent('toolEnd'));
    book.observe(compactBinding, compactEvent('rootEnd'));
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
    else book.invalidate((b) => b.sessionId === 'self', reason);
    reach();
    await pending;
    assert.equal(writes, 0, reason);
    assert.equal(book.status(compactPayload.requestId)?.state, 'cancelled', reason);
  }
});

test('self compaction delivers after a failed tool or turn and rejects replay and concurrent capacity', async () => {
  for (const failure of ['tool', 'turn']) {
    const book = new CompactRequests(compactWindow);
    book.observe(compactBinding, compactEvent('toolStart'));
    book.admit(compactPayload, () => true);
    book.observe(compactBinding, compactEvent('toolEnd', { success: failure !== 'tool' }));
    book.observe(compactBinding, compactEvent('rootEnd', { success: failure !== 'turn' }));
    let writes = 0;
    await book.deliver(compactPayload.requestId, {
      eligible: () => true,
      submit: async (_binding, check) => {
        check();
        writes++;
      },
    });
    assert.equal(writes, 1, failure);
    assert.equal(book.status(compactPayload.requestId)?.state, 'uncertain');
  }
  let clock = 0;
  const book = new CompactRequests(compactWindow, () => clock, 1);
  book.observe(compactBinding, compactEvent('toolStart'));
  book.admit(compactPayload, () => true);
  clock = 91 * 60_000;
  assert.equal(book.status(compactPayload.requestId)?.state, 'queued');
  assert.throws(
    () =>
      book.admit({ ...compactPayload, requestId: compactWindow + ':bbbbbbbb-1111-2222-3333-444444444444' }, () => true),
    /unavailable/,
  );
  book.invalidate(() => true, 'The reader acted.');
  clock += COMPACT_LIMITS.retentionMs;
  assert.equal(book.status(compactPayload.requestId), null);
  book.observe(compactBinding, compactEvent('toolStart'));
  assert.throws(() => book.admit(compactPayload, () => true), /already used/);
});

test('self compaction admits only exact literal POSIX or Windows commands', () => {
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

test('self compaction admits one literal POSIX script and rejects shell composition at either layer', () => {
  const file = `${process.platform === 'win32' ? 'C:' : ''}/tmp/arc notes (draft)/resume.txt`;
  const sha256 = 'a'.repeat(64);
  const continuation = compactLiteral.replace(
    '--after-turn',
    `--after-turn --continuation-file '${file}' --continuation-sha256 ${sha256}`,
  );
  const quoted = `/bin/sh -c '${compactLiteral}'`;
  for (const command of [quoted, `/bin/sh -c "${compactLiteral}"`])
    assert.deepEqual(compactCommandPayload(command), compactPayload, command);
  assert.deepEqual(compactCommandPayload(`/bin/sh -c "${continuation}"`), {
    ...compactPayload,
    continuation: { sha256 },
  });
  for (const suffix of [
    '; true',
    ' && true',
    ' || true',
    ' &',
    ' | cat',
    ' > result',
    ' < input',
    ' 2> error',
    ' extra',
  ]) {
    assert.equal(compactCommandPayload(quoted + suffix), null, suffix);
    for (const quote of ["'", '"']) {
      const command = `/bin/sh -c ${quote}${compactLiteral}${suffix}${quote}`;
      assert.equal(compactCommandPayload(command), null, command);
    }
  }
  for (const command of [
    `/bin/sh -c ${compactLiteral}`,
    `/bin/sh -c '${compactLiteral}"`,
    `/bin/sh -c '${compactLiteral}`,
    `/bin/sh -c "${compactLiteral}'`,
    `/bin/sh -c '${compactLiteral}' ''`,
    `/bin/sh -c '${compactLiteral}' -x`,
    `/bin/sh -lc '${compactLiteral}'`,
    `/bin/sh -c -e '${compactLiteral}'`,
    `/bin/sh  -c '${compactLiteral}'`,
    `/bin/sh -c "$(echo ${compactLiteral})"`,
    '/bin/sh -c "`' + compactLiteral + '`"',
    `/bin/sh -c "${compactLiteral.replace(compactWindow, '$ARC_WINDOW')}"`,
    `/bin/sh -c "${compactLiteral.replace('--json', '--json --quiet')}"`,
    `/bin/sh -c '${continuation}'`,
    `/bin/sh -c "${continuation.replace(file, file + '$HOME')}"`,
    `/bin/sh -c "${continuation.replace(file, file + String.fromCharCode(92) + 'x')}"`,
    `/bin/sh -c "${quoted}"`,
    `powershell.exe -Command "${quoted}"`,
    `/bin/sh -c "powershell.exe -Command '${compactLiteral}'"`,
    `/bin/sh -c 'arc'" compact request"' --self --after-turn'`,
  ])
    assert.equal(compactCommandPayload(command), null, command);
  for (const shell of ['sh', '/bin/bash', '/bin/zsh', '/bin/fish', '/usr/bin/sh'])
    assert.equal(compactCommandPayload(`${shell} -c '${compactLiteral}'`), null, shell);
  for (const ending of ['\n', '\r', '\r\n', '\u2028', '\u2029'])
    for (const command of [
      compactLiteral,
      quoted,
      `/bin/sh -c "${continuation}"`,
      `powershell.exe -Command '${compactLiteral}'`,
    ]) {
      assert.equal(compactCommandPayload(command + ending), null, JSON.stringify(command + ending));
      assert.equal(compactCommandPayload(`/bin/sh -c '${compactLiteral}${ending}'`), null);
    }
});

// Codex reports doubled backslashes in the executable path and either outer quote form.
// `-NoProfile` optionally precedes `-Command`.
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
    book.observe(binding, { ...base, kind: 'toolStart', command: compactLiteral, toolId: 'call', initiating: true });
    book.admit(compactPayload, () => true);
    book.observe(binding, { ...base, kind: 'toolEnd', toolId: 'call', success: true });
    book.observe(binding, { ...base, kind: 'rootEnd', success: true });
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

test('continuation binds exact bytes and a platform absolute path to the observed initiating literal', () => {
  assert.equal(validContinuation(continuationText, continuationPayload.continuation.sha256), true);
  assert.equal(
    compactCommandPayload(continuationLiteral())?.continuation?.sha256,
    continuationPayload.continuation.sha256,
  );
  for (const text of [
    '',
    ' ',
    '/compact',
    '\uFEFFnext',
    'next\0',
    '\ud800',
    continuationText + 'changed',
    'x'.repeat(8193),
  ])
    assert.equal(
      validContinuation(text, continuationPayload.continuation.sha256),
      false,
      JSON.stringify(text.slice(0, 30)),
    );
  for (const platform of ['win32', 'linux', 'darwin'] as const) {
    assert.equal(validContinuationPath('C:/temp/next.txt', platform), platform === 'win32');
    assert.equal(validContinuationPath('/tmp/next.txt', platform), platform !== 'win32');
    for (const file of [
      'C:/../next.txt',
      '/tmp/../next.txt',
      '/tmp//next.txt',
      '/tmp/next.txt/',
      '/tmp/next$HOME',
      'C:\\temp\\next.txt',
      '/tmp/./next.txt',
    ])
      assert.equal(validContinuationPath(file, platform), false, file);
  }
});

test('both providers deliver one continuation per completed compaction after settled idle ownership', async () => {
  for (const agent of ['claude', 'codex'] as const) {
    const { store } = memoryCompactionStore();
    const { fixture } = compactHostFixture(agent, store);
    assert.equal((await admitContinuation(fixture)).state, 'queued');
    await finishRequest(fixture);
    assert.equal(fixture.writes, 1);
    assert.deepEqual(fixture.continuationWrites, []);
    finishCompact(fixture, 99);
    await fixture.host.drain('self');
    assert.deepEqual(fixture.continuationWrites, []);
    finishCompact(fixture);
    fixture.state.busy = false;
    fixture.unresolved = true;
    await fixture.host.drain('self');
    assert.deepEqual(fixture.continuationWrites, []);
    fixture.unresolved = false;
    fixture.idle = false;
    await fixture.host.drain('self');
    assert.deepEqual(fixture.continuationWrites, []);
    fixture.idle = true;
    await Promise.all([fixture.host.drain('self'), fixture.host.drain('self')]);
    await fixture.host.drain('self');
    assert.deepEqual(fixture.continuationWrites, [continuationText]);
    assert.equal(continuationState(fixture).state, 'completed');
    assert.equal(continuationState(fixture).continuation?.state, 'accepted');
    const again = { ...continuationPayload, requestId: compactWindow + ':bbbbbbbb-1111-2222-3333-444444444444' };
    fixture.host.native(
      fixture.child,
      compactEvent('toolStart', {
        command: continuationLiteral(again),
        toolId: 'second',
        provider: agent,
        generation: agent === 'claude' ? 3 : null,
      }),
      8,
    );
    assert.equal(
      ((await fixture.host.handle({ method: 'compact-request', params: again })) as { state: string }).state,
      'queued',
    );
    fixture.host.native(
      fixture.child,
      compactEvent('toolEnd', { toolId: 'second', provider: agent, generation: agent === 'claude' ? 3 : null }),
      8,
    );
    fixture.host.native(
      fixture.child,
      compactEvent('rootEnd', { provider: agent, generation: agent === 'claude' ? 3 : null }),
      8,
    );
    fixture.state.busy = false;
    await fixture.host.drain('self');
    finishCompact(fixture, 3);
    fixture.state.busy = false;
    await fixture.host.drain('self');
    assert.deepEqual(fixture.continuationWrites, [continuationText, continuationText]);
  }
});

test('continuation admission reserves once across async storage and cancels changed reader authority before native input', async () => {
  const { store, records } = memoryCompactionStore();
  let settle!: () => void;
  const reserve = store.reserve;
  let reservations = 0;
  store.reserve = async (receipt) => {
    reservations++;
    await new Promise<void>((resolve) => {
      settle = resolve;
    });
    await reserve(receipt);
  };
  const { fixture } = compactHostFixture('codex', store);
  const admission = admitContinuation(fixture);
  const duplicate = fixture.host.handle({ method: 'compact-request', params: continuationPayload });
  assert.equal(reservations, 1);
  fixture.host.readerAction('self');
  settle();
  assert.equal((await admission).state, 'cancelled');
  assert.equal(((await duplicate) as { state: string }).state, 'cancelled');
  await finishRequest(fixture);
  assert.equal(fixture.writes, 0);
  assert.equal(records.get(continuationPayload.requestId)?.observation.continuation?.state, 'cancelled');
});

test('continuation invalidations suppress input before preparation and at the final provider boundary', async () => {
  for (const change of [
    'reader',
    'answer',
    'pending',
    'question',
    'archive',
    'child',
    'write boundary',
    'write failure',
    'failed compaction',
    'late refusal',
    'save failure',
  ] as const) {
    const { store } = memoryCompactionStore();
    const { fixture, makeChild } = compactHostFixture('codex', store);
    await admitContinuation(fixture);
    await finishRequest(fixture);
    if (change === 'failed compaction')
      fixture.host.native(
        fixture.child,
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
    else finishCompact(fixture);
    if (change === 'late refusal')
      fixture.host.native(
        fixture.child,
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
    fixture.state.busy = false;
    if (change === 'reader') fixture.host.readerAction('self');
    if (change === 'answer') fixture.host.readerAction('self', true);
    if (change === 'pending') fixture.continuationWork = 'pending';
    if (change === 'question') fixture.state.asks = [{}];
    if (change === 'archive') {
      fixture.host.archived(new Set(['self']));
      fixture.host.archived(new Set());
    }
    if (change === 'child') fixture.current = makeChild('replacement');
    if (change === 'write boundary') fixture.continuationBoundary = () => fixture.host.readerAction('self');
    if (change === 'write failure') fixture.writeFailure = true;
    if (change === 'save failure')
      store.save = async () => {
        throw new Error('save failed');
      };
    await fixture.host.drain('self');
    await fixture.host.drain('self');
    assert.deepEqual(fixture.continuationWrites, [], change);
    if (change === 'write failure') assert.equal(continuationState(fixture).continuation?.state, 'uncertain');
    if (change === 'write boundary') assert.equal(continuationState(fixture).continuation?.write, 'not-written');
  }
});

// The same window still delivers to its live child. Another window's status read needs the same source.
test.each(['saved text'])('continuation replacement with colliding numeric inodes denies %s', async () => {
  const source = path.join(tempDir('continuation-source-'), 'session.jsonl');
  fs.writeFileSync(source, '{}');
  const snapshot = fs.lstatSync(source, { bigint: true });
  let inode = 56576470320201115n;
  const original = filesystem.lstatSync;
  const stat = vi.spyOn(filesystem, 'lstatSync').mockImplementation(((
    file: fs.PathLike,
    options?: { bigint?: boolean },
  ) => {
    if (String(file) !== source) return original(file, options as never);
    const value = Object.assign(Object.create(snapshot), { dev: 0n, ino: inode });
    return options?.bigint ? value : Object.assign(Object.create(value), { dev: 0, ino: Number(inode) });
  }) as typeof fs.lstatSync);
  syncBuiltinESMExports();
  try {
    const method = declarationSource(
      fs.readFileSync(path.join(__dirname, 'panelhost.ts'), 'utf8'),
      'continuationSource',
    );
    const compiled = ts.transpileModule(`class Source { ${method} }`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const Source = runInNewContext(`${compiled}; Source;`, { fs, fileRevisionOf: revisionOf, supportedFileIdentity });
    const host = new Source();
    Object.assign(host, {
      readScopeKey: () => 'scope',
      questionSource: () => source,
      stateFor: () => ({ agent: 'codex' }),
      hidden: new Set(),
      cwdForSession: () => path.dirname(source),
    });
    const identity = () => host.continuationSource('codex', 'self');
    const { store } = memoryCompactionStore();
    const { fixture } = compactHostFixture('codex', store);
    Object.defineProperty(fixture, 'authority', { get: identity });
    assert.equal((await admitContinuation(fixture)).state, 'queued');
    await finishRequest(fixture);
    finishCompact(fixture);
    fixture.state.busy = false;
    const before = identity();
    inode = 56576470320201114n;
    assert.equal(Number(inode), Number(56576470320201115n));
    assert.deepEqual(continuationState(fixture), {
      requestId: continuationPayload.requestId,
      state: 'unavailable',
    });
    assert.notEqual(identity(), before);
    inode = 0n;
    assert.equal(identity(), null);
  } finally {
    stat.mockRestore();
    syncBuiltinESMExports();
  }
});

test('continuation status after restart reads through current authority without writes or replay', async () => {
  const { store, records } = memoryCompactionStore();
  const { fixture } = compactHostFixture('codex', store);
  await admitContinuation(fixture);
  await finishRequest(fixture);
  const saved = structuredClone(records.get(continuationPayload.requestId)!);
  store.ended = () => true;
  store.save = async () => {
    throw new Error('status must not write');
  };
  const replacement = new CompactHost<CompactChild>(
    'b'.repeat(24),
    { find: () => null, withActivity: async () => null, readerWork: () => 'none', authority: () => 'source' },
    () => 0,
    store,
  );
  for (const attempted of [false, true]) {
    saved.observation.continuation!.state = attempted ? 'attempting' : 'waiting';
    records.set(continuationPayload.requestId, structuredClone(saved));
    const reply = replacement.handle({
      method: 'compact-status',
      params: { requestId: continuationPayload.requestId },
    }) as { continuation: { state: string }; servedByWindow: string };
    assert.equal(reply.continuation.state, attempted ? 'uncertain' : 'cancelled');
    assert.equal(reply.servedByWindow, 'b'.repeat(24));
    assert.deepEqual(records.get(continuationPayload.requestId), saved);
    await replacement.drain('self');
    assert.deepEqual(fixture.continuationWrites, []);
  }
  const foreign = new CompactHost<CompactChild>(
    'c'.repeat(24),
    { find: () => null, withActivity: async () => null, readerWork: () => 'none', authority: () => 'different' },
    () => 0,
    store,
  );
  assert.deepEqual(foreign.handle({ method: 'compact-status', params: { requestId: continuationPayload.requestId } }), {
    requestId: continuationPayload.requestId,
    state: 'unavailable',
  });
});

test('lost continuation receipt retains one possible write and never submits a replacement', async () => {
  const { store, records } = memoryCompactionStore();
  const { fixture } = compactHostFixture('codex', store);
  await admitContinuation(fixture);
  await finishRequest(fixture);
  finishCompact(fixture);
  fixture.state.busy = false;
  fixture.receiptOutcome = 'unknown';
  await fixture.host.drain('self');
  fixture.state.busy = false;
  await fixture.host.drain('self');
  assert.deepEqual(fixture.continuationWrites, [continuationText]);
  assert.equal(continuationState(fixture).continuation?.state, 'uncertain');
  assert.equal(records.get(continuationPayload.requestId)?.observation.continuation?.write, 'unknown');
});

test('unrelated reader work and a rows refresh do not save continuation receipts', async () => {
  const { store, records } = memoryCompactionStore();
  const { fixture } = compactHostFixture('codex', store);
  await admitContinuation(fixture);
  const save = vi.spyOn(store, 'save');
  fixture.host.readerAction('unrelated');
  fixture.host.sessionsRefreshed();
  await fixture.host.drain('self');
  assert.equal(save.mock.calls.length, 0);
  fixture.host.readerAction('self');
  assert.equal(save.mock.calls.length, 1);
  assert.equal(records.get(continuationPayload.requestId)?.observation.continuation?.state, 'cancelled');
  fixture.host.readerAction('self');
  fixture.host.sessionsRefreshed();
  await fixture.host.drain('self');
  assert.equal(save.mock.calls.length, 1);
});

test('continuation receipt updates bound lease reads across pending owners and recheck ownership each operation', async () => {
  const records = new Map<string, CompactReceipt>();
  const captured = memoryCompactionStore();
  await admitContinuation(compactHostFixture('codex', captured.store).fixture);
  const template = captured.records.get(continuationPayload.requestId)!;
  const root = tempDir('continuation-history-');
  const leases = path.join(root, 'leases');
  fs.mkdirSync(leases);
  const owners = Array.from({ length: 64 }, (_, index) => (index + 1).toString(16).padStart(24, '0'));
  owners.push(compactWindow);
  for (const [index, owner] of owners.entries())
    fs.writeFileSync(
      path.join(leases, index ? owners[index - 1] + '.next' : 'initial'),
      JSON.stringify({ activation: owner, pid: index === 64 ? process.pid : index + 1 }),
    );
  for (let index = 0; index < 24; index++) {
    const receipt = structuredClone(template);
    receipt.owner = index === 23 ? compactWindow : owners[61 + (index % 3)];
    receipt.binding.activation = receipt.owner;
    receipt.observation.requestId = receipt.owner + ':' + crypto.randomUUID();
    receipt.observation.continuation!.state = index < 12 ? 'accepted' : index % 2 ? 'attempting' : 'waiting';
    receipt.terminalAt = index < 12 ? 0 : null;
    const file = crypto.createHash('sha256').update(receipt.observation.requestId).digest('hex') + '.json';
    fs.writeFileSync(path.join(root, file), JSON.stringify(receipt));
    records.set(receipt.observation.requestId, receipt);
  }
  const own = [...records.values()].find((receipt) => receipt.owner === compactWindow)!;
  let processEnded = false;
  const store = new CompactStore(
    root,
    compactWindow,
    () => 0,
    () => processEnded,
  );
  const open = vi.spyOn(filesystem, 'openSync');
  syncBuiltinESMExports();
  const chainReads = () =>
    open.mock.calls.filter(
      ([file]) =>
        path.dirname(String(file)) === leases && /^(initial|[a-f0-9]{24}\.next)$/.test(path.basename(String(file))),
    ).length;
  try {
    await store.save(own);
    assert.ok(chainReads() <= owners.length * 2, `Lease reads: ${chainReads()}`);
    for (const receipt of records.values())
      assert.equal(
        store.read(receipt.observation.requestId)?.observation.continuation?.state,
        receipt.observation.continuation?.state,
      );
    open.mockClear();
    processEnded = true;
    await store.save(own);
    assert.ok(chainReads() <= owners.length * 2, `Lease reads: ${chainReads()}`);
    for (const receipt of records.values()) {
      if (receipt.owner === compactWindow) continue;
      const before = receipt.observation.continuation!.state;
      const after = store.read(receipt.observation.requestId)!.observation.continuation!;
      assert.equal(after.state, before === 'attempting' ? 'uncertain' : before === 'waiting' ? 'cancelled' : before);
      if (before === 'attempting') assert.equal(after.write, 'unknown');
    }
    open.mockClear();
    await store.save(own);
    assert.equal(chainReads(), owners.length);
  } finally {
    open.mockRestore();
    syncBuiltinESMExports();
  }
});

test('durable continuation lease rejects live or malformed owners and retains receipts without execution takeover', async () => {
  const root = tempDir('continuation-store-');
  const first = new CompactStore(
    root,
    compactWindow,
    () => 0,
    () => false,
  );
  const { store: captured, records } = memoryCompactionStore();
  const control = compactHostFixture('codex', captured).fixture;
  await admitContinuation(control);
  await first.reserve(records.get(continuationPayload.requestId)!);
  await first.save(records.get(continuationPayload.requestId)!);
  const receipt = first.read(continuationPayload.requestId)!;
  assert.equal(receipt.observation.continuation?.text, continuationText);
  const second = new CompactStore(
    root,
    'b'.repeat(24),
    () => 0,
    () => false,
  );
  const successor = structuredClone(receipt);
  successor.owner = 'b'.repeat(24);
  successor.binding.activation = successor.owner;
  successor.observation.requestId = successor.owner + ':aaaaaaaa-1111-2222-3333-444444444444';
  await assert.rejects(second.reserve(successor), /Another window/);
  assert.equal(second.ended(compactWindow), false);
  first.release();
  await vi.waitFor(() => assert.equal(second.ended(compactWindow), true));
  assert.equal(second.read(continuationPayload.requestId)?.observation.continuation?.state, 'waiting');
  await second.reserve(successor);
  assert.equal(second.read(continuationPayload.requestId)?.observation.continuation?.state, 'cancelled');
  const corrupt = tempDir('continuation-corrupt-');
  fs.mkdirSync(path.join(corrupt, 'leases'));
  fs.writeFileSync(path.join(corrupt, 'leases', 'initial'), '');
  const blocked = new CompactStore(corrupt, compactWindow);
  await assert.rejects(blocked.reserve(receipt));
  assert.equal(fs.readFileSync(path.join(corrupt, 'leases', 'initial'), 'utf8'), '');
});

test.each(['open', 'after read', 'unknown'] as const)(
  'continuation storage rejects physical replacement at %s',
  async (boundary) => {
    const { store, records } = memoryCompactionStore();
    const { fixture } = compactHostFixture('codex', store);
    await admitContinuation(fixture);
    const root = tempDir('continuation-identity-');
    const saved = new CompactStore(root, compactWindow, () => 0);
    await saved.reserve(records.get(continuationPayload.requestId)!);
    const file = path.join(
      root,
      crypto.createHash('sha256').update(continuationPayload.requestId).digest('hex') + '.json',
    );
    const snapshot = fs.lstatSync(file, { bigint: true });
    const nativeLstat = filesystem.lstatSync;
    const nativeFstat = filesystem.fstatSync;
    const value = (inode: bigint, options?: { bigint?: boolean }) =>
      Object.assign(Object.create(snapshot), {
        dev: options?.bigint ? 0n : 0,
        ino: options?.bigint ? inode : Number(inode),
      });
    let reads = 0;
    const stat = vi
      .spyOn(filesystem, 'lstatSync')
      .mockImplementation(((target: fs.PathLike, options?: { bigint?: boolean }) =>
        String(target) === file
          ? value(
              boundary === 'unknown'
                ? 0n
                : boundary === 'after read' && reads++ > 0
                  ? 56576470320201114n
                  : 56576470320201115n,
              options,
            )
          : nativeLstat(target, options as never)) as typeof fs.lstatSync);
    const opened = vi
      .spyOn(filesystem, 'fstatSync')
      .mockImplementation(((_fd: number, options?: { bigint?: boolean }) =>
        value(boundary === 'open' ? 56576470320201114n : 56576470320201115n, options)) as typeof fs.fstatSync);
    syncBuiltinESMExports();
    try {
      assert.equal(saved.read(continuationPayload.requestId), null, boundary);
    } finally {
      stat.mockRestore();
      opened.mockRestore();
      syncBuiltinESMExports();
    }
    assert.equal(filesystem.fstatSync, nativeFstat);
    assert.equal(saved.read(continuationPayload.requestId)?.observation.continuation?.text, continuationText);
  },
);

test('continuation storage opens replaced paths without blocking and refuses nonregular descriptors', () => {
  const method = declarationSource(fs.readFileSync(path.join(__dirname, 'compactstore.ts'), 'utf8'), 'readJson');
  const compiled = ts.transpileModule(`class Store { ${method} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const platform of ['win32', 'linux', 'darwin']) {
    let closed = false;
    const filesystem = {
      constants: { O_RDONLY: 0, O_NONBLOCK: 2048 },
      lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, dev: 0n, ino: 2n, uid: 1n, size: 1n }),
      openSync: (_file: string, flags: number) => {
        assert.equal(flags, platform === 'win32' ? 0 : 2048);
        return 123;
      },
      fstatSync: () => ({ isFile: () => false, dev: 0n, ino: 2n, uid: 1n, size: 1n }),
      closeSync: (fd: number) => {
        assert.equal(fd, 123);
        closed = true;
      },
    };
    const Store = runInNewContext(`${compiled}; Store;`, {
      fs: filesystem,
      path,
      process: { platform, getuid: () => 1 },
      admitToolPath: () => {},
      revisionOf,
      supportedFileIdentity,
    });
    assert.throws(() => new Store().readJson('receipt.json'), /storage changed/);
    assert.equal(closed, true);
  }
});

test('continuation ownership publishes a complete lease before any authoritative claim becomes visible', async () => {
  const { store, records } = memoryCompactionStore();
  await admitContinuation(compactHostFixture('codex', store).fixture);
  const receipt = records.get(continuationPayload.requestId)!;
  const root = tempDir('continuation-publication-');
  const original = filesystem.linkSync;
  const published: string[] = [];
  const link = vi.spyOn(filesystem, 'linkSync').mockImplementation((source, target) => {
    const value = JSON.parse(fs.readFileSync(source, 'utf8'));
    assert.equal(value.activation ?? value.owner, compactWindow);
    assert.equal(fs.existsSync(target), false);
    published.push(String(target));
    return original(source, target);
  });
  syncBuiltinESMExports();
  try {
    await new CompactStore(root, compactWindow).reserve(receipt);
    assert.equal(published.length, 2);
  } finally {
    link.mockRestore();
    syncBuiltinESMExports();
  }
  const failedRoot = tempDir('continuation-publication-failure-');
  const failure = vi.spyOn(filesystem, 'linkSync').mockImplementation(() => {
    throw new Error('publication failed');
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(new CompactStore(failedRoot, compactWindow).reserve(receipt));
    assert.equal(fs.existsSync(path.join(failedRoot, 'leases', 'initial')), false);
  } finally {
    failure.mockRestore();
    syncBuiltinESMExports();
  }
  await new CompactStore(failedRoot, compactWindow).reserve(receipt);
});

test('continuation storage evicts owned terminal receipts under capacity while preserving active receipts', async () => {
  const { store, records } = memoryCompactionStore();
  await admitContinuation(compactHostFixture('codex', store).fixture);
  const receipt = records.get(continuationPayload.requestId)!;
  const root = tempDir('continuation-capacity-');
  let now = 0;
  const saved = new CompactStore(root, compactWindow, () => now);
  await saved.reserve(receipt);
  for (let index = 1; index < COMPACT_LIMITS.records; index++) {
    const terminal = structuredClone(receipt);
    terminal.observation.requestId =
      compactWindow + ':' + index.toString(16).padStart(8, '0') + '-1111-2222-3333-444444444444';
    terminal.observation.continuation!.state = 'cancelled';
    terminal.terminalAt = 0;
    const file = crypto.createHash('sha256').update(terminal.observation.requestId).digest('hex') + '.json';
    fs.writeFileSync(path.join(root, file), JSON.stringify(terminal));
  }
  const next = structuredClone(receipt);
  next.observation.requestId = compactWindow + ':ffffffff-1111-2222-3333-444444444444';
  await saved.reserve(next);
  assert.ok(saved.read(receipt.observation.requestId));
  assert.equal(fs.readdirSync(root).filter((name) => name.endsWith('.json')).length, COMPACT_LIMITS.records);
  now = 91 * 60_000;
  assert.ok(saved.read(receipt.observation.requestId), 'active receipts do not expire by admission age');
  next.observation.requestId = compactWindow + ':dddddddd-1111-2222-3333-444444444444';
  next.admittedAt = now;
  await saved.reserve(next);
  assert.equal(fs.readdirSync(root).filter((name) => name.endsWith('.json')).length, 3);
  assert.equal(saved.read(next.observation.requestId)?.observation.continuation?.text, continuationText);
  const oversized = structuredClone(next);
  oversized.observation.requestId = compactWindow + ':eeeeeeee-1111-2222-3333-444444444444';
  oversized.binding.authority = 'x'.repeat(65536);
  await assert.rejects(saved.reserve(oversized), /too large/);
});

test('host compaction runs once after the exact turn ends and the child is idle', async () => {
  const { fixture } = compactHostFixture();
  const { host, child, state } = fixture;
  admittedCompaction(fixture);
  state.busy = false;
  await host.drain('self');
  assert.equal(fixture.writes, 0, 'compaction waits for the requesting turn to end');
  state.busy = true;
  host.native(child, compactEvent('rootEnd'), 7);
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

// Catches a request that a failed requesting tool or turn, or a final response Arc never saved, drops.
test('host compaction runs after a failed requesting tool or turn without a saved final response', async () => {
  for (const ending of ['failed tool', 'failed turn'] as const) {
    const { fixture } = compactHostFixture();
    const { host, child, state } = fixture;
    host.submitted(child, 7);
    host.native(child, compactEvent('toolStart'), 7);
    host.handle({ method: 'compact-request', params: compactPayload });
    host.native(child, compactEvent('toolEnd', { success: ending !== 'failed tool' }), 7);
    host.native(child, compactEvent('rootEnd', { success: ending !== 'failed turn' }), 7);
    state.busy = false;
    await host.drain('self');
    assert.equal(fixture.writes, 1, ending);
    assert.equal(compactState(host), 'uncertain', ending);
  }
});

test('host compaction cancels unsubmitted work on reader action, child change and disposal', async () => {
  for (const change of ['reader', 'answer', 'replacement', 'exit', 'disposal', 'write boundary'] as const) {
    const { fixture, makeChild } = compactHostFixture();
    const { host, child, state } = fixture;
    admittedCompaction(fixture);
    host.native(child, compactEvent('rootEnd'), 7);
    state.busy = false;
    if (change === 'reader') host.readerAction('self');
    if (change === 'answer') host.readerAction('self', true);
    if (change === 'replacement') fixture.current = makeChild('child');
    if (change === 'exit') {
      state.exited = true;
      host.childGone('child');
    }
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

// Catches a cancelled request that blames the wrong change.
test.each([
  ['replaced', 'The agent process was replaced before compaction started.'],
  ['exited', 'The agent process exited or moved to another session before compaction started.'],
  ['moved', 'The agent process exited or moved to another session before compaction started.'],
] as const)('host compaction names the change that cancelled a deferred request: %s', async (change, reason) => {
  const { fixture, makeChild } = compactHostFixture();
  const { host, child, state } = fixture;
  admittedCompaction(fixture);
  host.native(child, compactEvent('rootEnd'), 7);
  state.busy = false;
  if (change === 'replaced') fixture.current = makeChild('child');
  if (change === 'exited') state.exited = true;
  if (change === 'moved') state.sessionId = 'other';
  await host.drain('self');
  assert.equal(fixture.writes, 0);
  const status = host.handle({ method: 'compact-status', params: { requestId: compactPayload.requestId } }) as {
    state: string;
    reason: string;
  };
  assert.deepEqual([status.state, status.reason], ['cancelled', reason]);
});

const cancelParams = { requestId: compactPayload.requestId, window: compactWindow, self: true };
const cancelLiteral = (requestId = compactPayload.requestId) =>
  `arc compact cancel --self --request-id ${requestId} --window ${compactWindow} --json`;
const runCancel = (host: CompactHost<CompactChild>, params: object = cancelParams) => {
  const answer = host.handle({ method: 'compact-cancel', params }) as { state: string; code?: string; reason: string };
  return [answer.state, answer.code ?? '', answer.reason];
};

// Catches a cancel that another session can run, that an unseen command can run, or that leaves the request deliverable.
test('the requesting session cancels its own deferred request only while its cancel command runs', async () => {
  const { fixture, makeChild } = compactHostFixture();
  const { host, child, state } = fixture;
  admittedCompaction(fixture);
  const other: CompactChild = { ...makeChild('other'), state: () => ({ ...state, sessionId: 'other' }) };
  const unseen =
    'Arc has not seen this command run in a session yet. Nothing was cancelled. Run arc compact cancel as its own command, with no chain, pipe or substitution.';
  assert.deepEqual(runCancel(host), ['refused', 'not-observed', unseen]);
  host.native(other, compactEvent('toolStart', { sessionId: 'other', toolId: 'cancel', command: cancelLiteral() }), 9);
  fixture.current = other;
  assert.deepEqual(runCancel(host), [
    'refused',
    'other-session',
    'Another session made this compaction request. Nothing was cancelled.',
  ]);
  fixture.current = child;
  const unknownId = `${compactWindow}:bbbbbbbb-1111-2222-3333-444444444444`;
  host.native(child, compactEvent('toolStart', { toolId: 'unknown', command: cancelLiteral(unknownId) }), 7);
  assert.deepEqual(runCancel(host, { ...cancelParams, requestId: unknownId }), [
    'refused',
    'unknown',
    'This Arc window holds no compaction request with this ID. Nothing was cancelled.',
  ]);
  assert.equal(compactState(host), 'queued');
  host.native(child, compactEvent('toolStart', { toolId: 'cancel', command: cancelLiteral() }), 7);
  const cancelled = ['cancelled', '', 'The requesting agent cancelled this request before compaction started.'];
  assert.deepEqual(runCancel(host), cancelled);
  assert.deepEqual(runCancel(host), cancelled, 'a repeated cancel reports the same record');
  host.native(child, compactEvent('toolEnd', { toolId: 'cancel' }), 7);
  host.native(other, compactEvent('toolEnd', { sessionId: 'other', toolId: 'cancel' }), 9);
  assert.deepEqual(runCancel(host), ['refused', 'not-observed', unseen], 'settled calls cancel nothing more');
  host.native(child, compactEvent('rootEnd'), 7);
  state.busy = false;
  await host.drain('self');
  assert.equal(fixture.writes, 0);
  assert.equal(compactState(host), 'cancelled');
});

// Catches a cancel that reports success after Arc already sent the compaction to the agent.
test('a cancel command refuses a deferred request that Arc already sent', async () => {
  const { fixture } = compactHostFixture();
  const { host, child, state } = fixture;
  admittedCompaction(fixture);
  host.native(child, compactEvent('rootEnd'), 7);
  state.busy = false;
  await host.drain('self');
  assert.equal(fixture.writes, 1);
  host.native(child, compactEvent('toolStart', { turnId: 'next', toolId: 'cancel', command: cancelLiteral() }), 8);
  assert.deepEqual(runCancel(host), [
    'refused',
    'delivered',
    'Arc already sent this compaction to the agent. Nothing was cancelled.',
  ]);
  assert.equal(compactState(host), 'uncertain');
});

// Catches a cancel command that a subagent, a composed command or another window runs.
test('a cancel command counts only as the exact literal root call for this window', () => {
  const { fixture } = compactHostFixture();
  const { host, child } = fixture;
  admittedCompaction(fixture);
  for (const [toolId, extra] of [
    ['subagent', { initiating: false }],
    ['chain', { command: `cd /tmp && ${cancelLiteral()}` }],
    ['pipe', { command: `${cancelLiteral()} | cat` }],
    ['window', { command: cancelLiteral().replace(`--window ${compactWindow}`, `--window ${'c'.repeat(24)}`) }],
  ] as const) {
    host.native(child, compactEvent('toolStart', { toolId, command: cancelLiteral(), ...extra }), 7);
    assert.equal(runCancel(host)[1], 'not-observed', toolId);
  }
  host.native(child, compactEvent('toolStart', { toolId: 'wrapped', command: `/bin/sh -c '${cancelLiteral()}'` }), 7);
  assert.equal(runCancel(host)[0], 'cancelled');
});

// Catches a cancel command that the Codex Windows wrapper hides, or a composed command inside that wrapper.
test('a cancel command counts inside the PowerShell wrappers Codex reports and nothing composed around them', () => {
  const executable = String.raw`"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"`;
  for (const command of [
    `${executable} -Command '${cancelLiteral()}'`,
    `${executable} -NoProfile -Command '${cancelLiteral()}'`,
  ])
    assert.deepEqual(compactCancelPayload(command), cancelParams, command);
  for (const command of [
    `${executable} -Command '${cancelLiteral()}; echo x'`,
    `${executable} -Command '$(${cancelLiteral()})'`,
  ])
    assert.equal(compactCancelPayload(command), null, command);
});

// Catches a cancel that lands while delivery waits on the activity lease or at the provider write boundary and still writes.
test.each(['lease', 'write boundary'] as const)(
  'a cancel while delivery waits at the %s writes no compaction',
  async (wait) => {
    const { fixture } = compactHostFixture();
    const { host, child, state } = fixture;
    admittedCompaction(fixture);
    host.native(child, compactEvent('toolStart', { toolId: 'cancel', command: cancelLiteral() }), 7);
    host.native(child, compactEvent('rootEnd'), 7);
    state.busy = false;
    let release = () => {};
    if (wait === 'lease') fixture.lease = new Promise<void>((resolve) => (release = resolve));
    else fixture.beforeWrite = () => assert.equal(runCancel(host)[0], 'cancelled');
    const delivery = host.drain('self');
    if (wait === 'lease') assert.equal(runCancel(host)[0], 'cancelled');
    release();
    await delivery;
    assert.deepEqual([fixture.calls, fixture.writes], [wait === 'lease' ? 0 : 1, 0]);
    assert.equal(compactState(host), 'cancelled');
  },
);

// Catches a cancel that drops the request but leaves its saved continuation able to run.
test('a cancel of a request with a saved continuation cancels the continuation before any write', async () => {
  const { store } = memoryCompactionStore();
  const { fixture } = compactHostFixture('codex', store);
  const { host, child } = fixture;
  assert.equal((await admitContinuation(fixture)).state, 'queued');
  host.native(child, compactEvent('toolEnd'), 7);
  host.native(
    child,
    compactEvent('toolStart', { toolId: 'cancel', command: cancelLiteral(continuationPayload.requestId) }),
    7,
  );
  assert.equal(runCancel(host, { ...cancelParams, requestId: continuationPayload.requestId })[0], 'cancelled');
  const status = continuationState(fixture);
  assert.deepEqual(
    [status.state, status.continuation?.state, status.continuation?.write],
    ['cancelled', 'cancelled', 'not-written'],
  );
  assert.deepEqual(fixture.continuationWrites, []);
});

// Catches a cancel that works only inside the requesting turn.
test('a cancel command from a later turn of the requesting session cancels its request', async () => {
  const { fixture } = compactHostFixture();
  const { host, child, state } = fixture;
  admittedCompaction(fixture);
  host.native(child, compactEvent('rootEnd'), 7);
  host.submitted(child, 8);
  host.native(child, compactEvent('toolStart', { turnId: 'next', toolId: 'cancel', command: cancelLiteral() }), 8);
  assert.deepEqual(runCancel(host), [
    'cancelled',
    '',
    'The requesting agent cancelled this request before compaction started.',
  ]);
  state.busy = false;
  await host.drain('self');
  assert.equal(fixture.writes, 0);
});

// Catches a cancel observation that outlives the process or session that ran it and authorizes a later request.
test.each(['exit', 'move'] as const)('a cancel observation ends at child %s', (change) => {
  const { fixture, makeChild } = compactHostFixture();
  const { host, state } = fixture;
  host.native(fixture.child, compactEvent('toolStart', { toolId: 'cancel', command: cancelLiteral() }), 7);
  assert.equal(runCancel(host)[1], 'unknown');
  if (change === 'exit') {
    state.exited = true;
    host.childGone('child');
    state.exited = false;
    fixture.child = fixture.current = makeChild('child');
  } else host.sessionMoved('self');
  admittedCompaction(fixture);
  assert.deepEqual(runCancel(host)[1], 'not-observed');
  assert.equal(compactState(host), 'queued');
});

// Catches one stale request whose loss cancels another request of the same child and session.
test('a reader action cancels only the request it precedes and a later request of its session still runs', async () => {
  const { fixture } = compactHostFixture();
  const { host, child, state } = fixture;
  admittedCompaction(fixture);
  host.readerAction('self');
  const second = { ...compactPayload, requestId: `${compactWindow}:bbbbbbbb-1111-2222-3333-444444444444` };
  const secondLiteral = compactLiteral.replace(compactPayload.requestId, second.requestId);
  host.submitted(child, 8);
  host.native(child, compactEvent('toolStart', { turnId: 'second', toolId: 'second', command: secondLiteral }), 8);
  assert.equal((host.handle({ method: 'compact-request', params: second }) as { state: string }).state, 'queued');
  host.native(child, compactEvent('toolEnd', { turnId: 'second', toolId: 'second' }), 8);
  host.native(child, compactEvent('rootEnd'), 7);
  host.native(child, compactEvent('rootEnd', { turnId: 'second' }), 8);
  state.busy = false;
  await host.drain('self');
  const status = (requestId: string) =>
    host.handle({ method: 'compact-status', params: { requestId } }) as { state: string; reason: string };
  assert.deepEqual(
    [status(compactPayload.requestId).state, status(compactPayload.requestId).reason],
    ['cancelled', 'The reader acted in this session before compaction started.'],
  );
  assert.equal(status(second.requestId).state, 'uncertain');
  assert.equal(fixture.writes, 1);
});

// Catches the turn 9 loss: reader messages that join the running Claude turn advance its prompt generation,
// so the request must follow that generation and still run after the turn that answers them.
test('reader messages that join the running Claude turn carry the request and compaction runs after that turn', async () => {
  const { fixture } = compactHostFixture('claude');
  const { host, child, state } = fixture;
  Object.assign(child, { readerTurnOwner: () => 7 });
  const claude = { provider: 'claude', generation: 1 };
  host.submitted(child, 7);
  host.native(child, compactEvent('toolStart', claude), 7);
  assert.equal(
    (host.handle({ method: 'compact-request', params: compactPayload }) as { state: string }).state,
    'queued',
  );
  host.native(child, compactEvent('toolEnd', claude), 7);
  for (let message = 0; message < 5; message++) {
    const generation = 2 + message;
    host.readerAction('self', false, readerCarry('sendPrompt', 'Also check the mockup.'));
    assert.equal(
      readerPrompt(host, 'self', { text: 'Also check the mockup.' }).text,
      `Also check the mockup.\n\n${compactCarryLine(compactPayload.requestId)}`,
    );
    host.submitted(child, 20 + message);
    host.read(child, 20 + message);
    const work = { provider: 'claude', generation, toolId: `work-${message}`, command: 'npm test' };
    host.native(child, compactEvent('toolStart', work), 7);
    host.native(child, compactEvent('toolEnd', work), 7);
    assert.equal(compactState(host), 'queued');
  }
  fixture.compactions = 6;
  host.native(child, compactEvent('rootEnd', { provider: 'claude', generation: 6 }), 7);
  state.busy = false;
  await host.drain('self');
  assert.equal(fixture.writes, 1);
  const status = host.handle({ method: 'compact-status', params: { requestId: compactPayload.requestId } }) as {
    state: string;
    turn: string;
  };
  assert.deepEqual([status.state, status.turn], ['uncertain', '6']);
});

// Catches a reader message, sent or flushed from the queue after the requesting turn ended, that cancels the request
// or lets it run before the turn that answers the message.
test.each(['sent', 'queued'] as const)(
  'a %s reader message that starts a new turn carries the request and compaction runs after that turn',
  async (route) => {
    const { fixture } = compactHostFixture();
    const { host, child, state } = fixture;
    admittedCompaction(fixture);
    host.native(child, compactEvent('rootEnd'), 7);
    if (route === 'queued') {
      // The queued prompt holds delivery at turn end, then the queue flush delivers it.
      fixture.work = 'pending';
      state.busy = false;
      await host.drain('self');
      assert.equal(fixture.writes, 0);
      fixture.work = 'none';
    }
    host.readerAction('self', false, readerCarry('sendPrompt', 'Next, the tests.'));
    const prompt = { text: 'Next, the tests.', assets: [] };
    const delivered = readerPrompt(host, 'self', prompt);
    assert.equal(delivered.text.split(compactCarryLine(compactPayload.requestId)).length, 2);
    assert.deepEqual(prompt, { text: 'Next, the tests.', assets: [] }, 'the reader keeps the text they wrote');
    host.submitted(child, 8);
    // The reader branch of resolve() holds delivery until the new turn rebinds the request.
    await host.drain('self');
    assert.deepEqual([fixture.writes, compactState(host)], [0, 'queued']);
    state.busy = true;
    host.native(child, compactEvent('toolStart', { turnId: 'next', toolId: 'work', command: 'npm test' }), 8);
    assert.equal(readerPrompt(host, 'self', prompt), prompt, 'the line goes only with the message that carried it');
    host.native(child, compactEvent('toolEnd', { turnId: 'next', toolId: 'work', command: 'npm test' }), 8);
    host.native(child, compactEvent('rootEnd', { turnId: 'next' }), 8);
    state.busy = false;
    await host.drain('self');
    assert.equal(fixture.writes, 1);
    const status = host.handle({ method: 'compact-status', params: { requestId: compactPayload.requestId } }) as {
      turn: string;
      submissionId: string;
    };
    assert.deepEqual([status.turn, status.submissionId], ['next', '8']);
  },
);

// Catches a Stop, a setting pick, a slash command or an answer that carries a request instead of cancelling it.
test.each([
  ['stopTurn', undefined, false],
  ['pick', undefined, false],
  ['compact', undefined, false],
  ['sendPrompt', '/model sonnet', false],
  ['answerAsk', undefined, true],
] as const)('a reader %s cancels a deferred request', async (type, text, answer) => {
  const { fixture } = compactHostFixture();
  const { host, child, state } = fixture;
  admittedCompaction(fixture);
  host.readerAction('self', answer, readerCarry(type, text));
  host.native(child, compactEvent('rootEnd'), 7);
  state.busy = false;
  await host.drain('self');
  assert.deepEqual([fixture.writes, compactState(host)], [0, 'cancelled']);
  assert.equal(readerPrompt(host, 'self', { text: 'x' }).text, 'x');
});

test('a queue change keeps admitted compaction on its answered turn', async () => {
  const { fixture } = compactHostFixture();
  admittedCompaction(fixture);
  fixture.host.readerAction('self', false, readerCarry('dequeue'));
  await finishRequest(fixture);
  assert.equal(fixture.writes, 1);
});

test('a rejected reader prompt releases held compaction without another event', async () => {
  const { fixture } = compactHostFixture();
  admittedCompaction(fixture);
  fixture.host.readerAction('self', false, 'send');
  await finishRequest(fixture);
  assert.equal(fixture.writes, 0);
  await assert.rejects(
    promptAsReader(fixture.host, fixture.child, async () => {
      throw new Error('refused');
    }),
    /refused/,
  );
  await vi.waitFor(() => assert.equal(fixture.writes, 1));
});

// Catches a request that waits on or is cancelled by the panel's session rows while its live child holds the session.
test('host compaction delivers for a live child whose session row is absent from the window scope', async () => {
  const { fixture } = compactHostFixture();
  const { host, child, state } = fixture;
  admittedCompaction(fixture);
  fixture.work = 'absent';
  host.sessionsRefreshed();
  host.native(child, compactEvent('rootEnd'), 7);
  state.busy = false;
  await host.drain('self');
  assert.equal(fixture.writes, 1);
  assert.equal(compactState(host), 'uncertain');
});

// Catches a refusal while reader input waits: B runs while C waits, and B's agent asks to compact.
// The request is admitted and waits until the queued input leaves the queue.
test('host compaction admits a request while reader input waits in the queue and delivers after it clears', async () => {
  const { fixture } = compactHostFixture();
  const { host, child, state } = fixture;
  fixture.work = 'pending';
  host.submitted(child, 7);
  host.native(child, compactEvent('toolStart'), 7);
  const ack = host.handle({ method: 'compact-request', params: compactPayload }) as { state: string };
  assert.equal(ack.state, 'queued');
  host.native(child, compactEvent('toolEnd'), 7);
  host.native(child, compactEvent('rootEnd'), 7);
  state.busy = false;
  await host.drain('self');
  assert.equal(fixture.writes, 0, 'queued reader input runs first');
  fixture.work = 'none';
  await host.drain('self');
  assert.equal(fixture.writes, 1);
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

// Native root commands supply compaction intent after earlier reader activity without notification ancestry.
test.each(['claude', 'codex'] as const)(
  'native %s turns admit without reader ancestry after earlier reader activity',
  async (agent) => {
    const { fixture } = compactHostFixture(agent);
    const { host, child } = fixture;
    child.startedByAgent = () => true;
    host.readerAction('self');
    const extra = { provider: agent, generation: agent === 'claude' ? 1 : null };
    host.native(child, compactEvent('toolStart', extra), 9);
    assert.equal(
      (host.handle({ method: 'compact-request', params: compactPayload }) as { state: string }).state,
      'queued',
    );
    host.native(child, compactEvent('toolEnd', extra), 9);
    host.native(child, compactEvent('rootEnd', extra), 9);
    fixture.state.busy = false;
    await host.drain('self');
    assert.equal(fixture.writes, 1);
    finishCompact(fixture);
    assert.equal(compactState(host), 'completed');
  },
);

test('host compaction binds a Claude request to its prompt generation and completes on the manual compact result', async () => {
  const { fixture } = compactHostFixture('claude');
  const { host, child, state } = fixture;
  const claude = (event: Record<string, unknown>) =>
    ({ provider: 'claude', sessionId: 'self', turnId: null, generation: 1, evidence: {}, ...event }) as NativeEvent;
  host.submitted(child, 7);
  host.native(child, claude({ kind: 'toolStart', toolId: 'call', command: compactLiteral, initiating: true }), 7);
  const ack = host.handle({ method: 'compact-request', params: compactPayload }) as { state: string };
  assert.equal(ack.state, 'queued');
  host.native(child, claude({ kind: 'toolEnd', toolId: 'call', success: true }), 7);
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

test('self compaction waits beyond execution deadlines and delivers after readiness returns', async () => {
  let clock = 0;
  const book = new CompactRequests(compactWindow, () => clock);
  book.observe(compactBinding, compactEvent('toolStart'));
  book.admit(compactPayload, () => true);
  clock = 91 * 60_000;
  assert.equal(book.status(compactPayload.requestId)?.state, 'queued');
  book.observe(compactBinding, compactEvent('rootEnd'));
  book.observe(compactBinding, compactEvent('toolEnd'));
  let ready = false;
  let writes = 0;
  const delivery = {
    eligible: () => ready,
    submit: async (_binding: Readonly<CompactBinding>, check: () => void) => {
      check();
      writes++;
    },
  };
  await book.deliver(compactPayload.requestId, delivery);
  assert.equal(writes, 0);
  ready = true;
  await book.deliver(compactPayload.requestId, delivery);
  assert.equal(writes, 1);
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

test('deferred compaction delivers while session membership is unknown', async () => {
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
    host.native(child, event('rootEnd'), 7);
    state.busy = false;
    fixture.work = 'unknown';
    host.sessionsRefreshed();
    await host.drain('self');
    assert.equal(fixture.writes, 1, agent);
    assert.equal(compactState(host), 'uncertain', agent);
  }
});

test.each(['records', 'bytes'] as const)(
  'repeated compaction and continuation reclaim terminal %s capacity without renewing an assignment',
  async (budget) => {
    let clock = 0;
    const root = tempDir('compact-repeated-');
    const saved = new CompactStore(
      root,
      compactWindow,
      () => clock,
      () => false,
      process.pid,
      { records: budget === 'records' ? 2 : 20, bytes: budget === 'bytes' ? 3300 : 16 * 1024 * 1024 },
    );
    const book = new CompactRequests(compactWindow, () => clock, 2, saved);
    const binding = { ...compactBinding, assignmentId: 'same-task', authority: 'source', sourceIdentity: 'source' };
    const ids: string[] = [];
    for (let index = 0; index < 6; index++) {
      const payload = {
        ...continuationPayload,
        requestId: compactWindow + ':' + index.toString(16).padStart(8, '0') + '-1111-2222-3333-444444444444',
      };
      ids.push(payload.requestId);
      const current = { ...binding, turn: `turn-${index}` };
      const extra = { turnId: current.turn, toolId: `tool-${index}` };
      book.observe(current, compactEvent('toolStart', { ...extra, command: continuationLiteral(payload) }));
      assert.equal((await book.admitSaved(payload, () => true)).state, 'queued');
      if (index === 0) {
        clock = 91 * 60_000;
        assert.equal(saved.read(payload.requestId)?.observation.state, 'queued');
        assert.equal(book.status(payload.requestId)?.state, 'queued');
      }
      book.observe(current, compactEvent('toolEnd', extra));
      book.observe(current, compactEvent('rootEnd', extra));
      await book.deliver(payload.requestId, { eligible: () => true, submit: async (_binding, write) => write() });
      book.nativeOutcome(payload.requestId, current, 'completed');
      clock += 3 * 60_000;
      let writes = 0;
      await book.continue(payload.requestId, {
        eligible: () => true,
        submit: (text, beforeWrite) => {
          assert.equal(text, continuationText);
          const attempt = new GuardedAttempt('continue-' + index, beforeWrite);
          attempt.prepareWrite();
          attempt.markWritten();
          writes++;
          attempt.settle({ outcome: 'accepted', nativeTurnId: `continued-${index}`, reason: '' });
          return attempt;
        },
      });
      assert.equal(writes, 1);
      assert.equal(saved.read(payload.requestId)?.observation.continuation?.state, 'accepted');
      assert.equal(book.status(payload.requestId)?.continuation?.state, 'accepted');
    }
    assert.equal(book.status(ids[0]), null, 'terminal memory entries are reclaimed before retention expiry');
    assert.equal(saved.read(ids[0]), null, 'terminal durable entries are reclaimed before retention expiry');
    const replay = { ...continuationPayload, requestId: ids[0] };
    book.observe(binding, compactEvent('toolStart', { command: continuationLiteral(replay), toolId: 'replay' }));
    assert.throws(() => book.admit(replay, () => true), /already used/);
  },
);

test('active and possible-write continuation receipts resist capacity eviction', async () => {
  const { store, records } = memoryCompactionStore();
  await admitContinuation(compactHostFixture('codex', store).fixture);
  const active = records.get(continuationPayload.requestId)!;
  const saved = new CompactStore(
    tempDir('compact-protected-'),
    compactWindow,
    () => 0,
    () => false,
    process.pid,
    { records: 2, bytes: 65536 },
  );
  await saved.reserve(active);
  const uncertain = structuredClone(active);
  uncertain.observation.requestId = compactWindow + ':bbbbbbbb-1111-2222-3333-444444444444';
  uncertain.terminalAt = 0;
  uncertain.observation.continuation!.state = 'uncertain';
  uncertain.observation.continuation!.write = 'unknown';
  await saved.reserve(uncertain);
  const next = structuredClone(active);
  next.observation.requestId = compactWindow + ':cccccccc-1111-2222-3333-444444444444';
  await assert.rejects(saved.reserve(next), /full/);
  assert.equal(saved.read(active.observation.requestId)?.terminalAt, null);
  assert.equal(saved.read(uncertain.observation.requestId)?.observation.continuation?.write, 'unknown');
});

test('child exit retires unresolved compaction and its saved continuation without accepting late evidence', async () => {
  const { store, records } = memoryCompactionStore();
  const { fixture } = compactHostFixture('codex', store);
  await admitContinuation(fixture);
  await finishRequest(fixture);
  assert.equal(compactState(fixture.host), 'uncertain');
  fixture.host.childGone(fixture.child.key);
  await vi.waitFor(() => assert.notEqual(records.get(continuationPayload.requestId)!.terminalAt, null));
  assert.equal(continuationState(fixture).continuation?.state, 'cancelled');
  finishCompact(fixture);
  assert.equal(compactState(fixture.host), 'uncertain');
  assert.deepEqual(fixture.continuationWrites, []);
  const book = new CompactRequests(compactWindow, () => 0, 1);
  book.observe(compactBinding, compactEvent('toolStart'));
  book.admit(compactPayload, () => true);
  book.observe(compactBinding, compactEvent('toolEnd'));
  book.observe(compactBinding, compactEvent('rootEnd'));
  await book.deliver(compactPayload.requestId, { eligible: () => true, submit: async (_binding, write) => write() });
  book.invalidate(() => true, 'The child ended.', false, undefined, true);
  const fresh = { ...compactPayload, requestId: compactWindow + ':bbbbbbbb-1111-2222-3333-444444444444' };
  const replacement = { ...compactBinding, childGeneration: 2, turn: 'replacement' };
  book.observe(
    replacement,
    compactEvent('toolStart', {
      turnId: replacement.turn,
      command: compactLiteral.replace(compactPayload.requestId, fresh.requestId),
    }),
  );
  assert.equal(book.admit(fresh, () => true).state, 'queued');
});

test.each(['refused', 'cancelled'] as const)(
  'a %s compaction does not spend permission for a fresh native call',
  async (state) => {
    const book = new CompactRequests(compactWindow, () => 0, 1);
    const binding = { ...compactBinding, assignmentId: 'same-task' };
    book.observe(binding, compactEvent('toolStart'));
    book.admit(compactPayload, () => true);
    book.observe(binding, compactEvent('rootEnd'));
    if (state === 'refused')
      await book.deliver(compactPayload.requestId, {
        eligible: () => true,
        submit: async () => {
          throw new Error('The agent refused.');
        },
      });
    else book.invalidate(() => true, 'The reader acted.');
    assert.equal(book.status(compactPayload.requestId)?.state, state);
    const next = { ...compactPayload, requestId: compactWindow + ':bbbbbbbb-1111-2222-3333-444444444444' };
    const later = { ...binding, turn: 'later' };
    book.observe(
      later,
      compactEvent('toolStart', {
        turnId: later.turn,
        toolId: 'fresh',
        command: compactLiteral.replace(compactPayload.requestId, next.requestId),
      }),
    );
    assert.equal(book.admit(next, () => true).state, 'queued');
    assert.equal(book.ready(compactPayload), false);
  },
);

test('child exit preserves a possible continuation write as uncertain after its late acceptance', async () => {
  const { store } = memoryCompactionStore();
  const { fixture } = compactHostFixture('codex', store);
  await admitContinuation(fixture);
  await finishRequest(fixture);
  finishCompact(fixture);
  fixture.state.busy = false;
  let attempt: GuardedAttempt | undefined;
  fixture.child.guardedPrompt = (text, id, _submitted, beforeWrite) => {
    attempt = new GuardedAttempt(id, beforeWrite);
    attempt.prepareWrite();
    fixture.continuationWrites.push(text);
    attempt.markWritten();
    return attempt;
  };
  const draining = fixture.host.drain('self');
  await vi.waitFor(() => assert.ok(attempt));
  fixture.host.childGone(fixture.child.key);
  attempt!.settle({ outcome: 'accepted', nativeTurnId: 'late-continued', reason: '' });
  await draining;
  assert.equal(continuationState(fixture).state, 'completed');
  assert.equal(continuationState(fixture).continuation?.state, 'uncertain');
  assert.equal(continuationState(fixture).continuation?.write, 'unknown');
  assert.deepEqual(fixture.continuationWrites, [continuationText]);
});

test('active native turn bindings survive later requests in the same retained child', async () => {
  const { fixture } = compactHostFixture('codex');
  fixture.child.startedByAgent = () => true;
  for (let index = 0; index < 40; index++) {
    const request = {
      ...compactPayload,
      requestId: compactWindow + ':' + index.toString(16).padStart(8, '0') + '-1111-2222-3333-444444444444',
    };
    fixture.host.native(
      fixture.child,
      compactEvent('toolStart', {
        turnId: `turn-${index}`,
        toolId: `tool-${index}`,
        command: compactLiteral.replace(compactPayload.requestId, request.requestId),
      }),
      index,
    );
    assert.equal(
      (fixture.host.handle({ method: 'compact-request', params: request }) as { state: string }).state,
      'queued',
    );
  }
  fixture.host.native(fixture.child, compactEvent('toolEnd', { turnId: 'turn-0', toolId: 'tool-0' }), 0);
  fixture.host.native(fixture.child, compactEvent('rootEnd', { turnId: 'turn-0' }), 0);
  fixture.state.busy = false;
  await fixture.host.drain('self');
  assert.equal(fixture.writes, 1, 'later active requests cannot evict the oldest live turn binding');
});

const tokenPayload = { ...compactPayload, token: 'c'.repeat(32) };

// The owner's report: after a window reload, with the session listing stale, the session's own request was refused.
test('a token request after a window reload is queued and delivered while the listing is stale', async () => {
  const { fixture, makeChild } = compactHostFixture('claude');
  const { host, state } = fixture;
  fixture.work = 'unknown';
  fixture.authority = null;
  let refreshes = 0;
  const refreshed = host.sessionsRefreshed.bind(host);
  host.sessionsRefreshed = () => {
    refreshes++;
    refreshed();
  };
  host.submitted(fixture.child, 7);
  const second = makeChild('child');
  fixture.current = second;
  host.childGone('child');
  host.submitted(second, 8);
  const ack = (await host.handle({ method: 'compact-request', params: tokenPayload })) as {
    state: string;
    reason?: string;
  };
  assert.equal(ack.state, 'queued', ack.reason);
  host.native(
    second,
    {
      provider: 'claude',
      sessionId: 'self',
      turnId: null,
      generation: 1,
      evidence: {},
      kind: 'rootEnd',
      success: true,
    },
    8,
  );
  state.busy = false;
  await host.drain('self');
  assert.equal(fixture.writes, 1);
  assert.equal(compactState(host), 'uncertain');
  assert.equal(refreshes, 0);
});

// The owner's report: on a large catalog whose discovery never completes, an observed request was refused at admission.
test('an observed continuation request is admitted and delivered while discovery is incomplete', async () => {
  const { store } = memoryCompactionStore();
  const { fixture } = compactHostFixture('claude', store);
  const { host, child, state } = fixture;
  fixture.work = 'unknown';
  fixture.authority = null;
  let refreshes = 0;
  host.sessionsRefreshed = () => {
    refreshes++;
  };
  const ack = await admitContinuation(fixture);
  assert.equal(ack.state, 'queued', (ack as { reason?: string }).reason);
  const extra = { provider: 'claude', generation: 1 };
  host.native(child, compactEvent('toolEnd', extra), 7);
  host.native(child, compactEvent('rootEnd', extra), 7);
  state.busy = false;
  await host.drain('self');
  assert.equal(fixture.writes, 1);
  finishCompact(fixture);
  state.busy = false;
  await host.drain('self');
  assert.deepEqual(fixture.continuationWrites, [continuationText]);
  assert.equal(refreshes, 0);
});

// Catches a token request that its own later tool start turns into a second call, and a token that admits without a live child.
test('a token request takes its tool and turn from a later tool start and a token without a live child refuses', async () => {
  const { fixture } = compactHostFixture('claude');
  const { host, child, state } = fixture;
  const claude = { provider: 'claude', generation: 1 };
  host.submitted(child, 7);
  assert.equal((host.handle({ method: 'compact-request', params: tokenPayload }) as { state: string }).state, 'queued');
  host.native(child, compactEvent('toolStart', claude), 7);
  const status = host.handle({ method: 'compact-status', params: { requestId: compactPayload.requestId } }) as {
    state: string;
    toolId: string;
    turn: string;
  };
  assert.deepEqual([status.state, status.toolId, status.turn], ['queued', 'call', '1']);
  host.native(child, compactEvent('toolEnd', claude), 7);
  host.native(child, compactEvent('rootEnd', claude), 7);
  state.busy = false;
  await host.drain('self');
  assert.equal(fixture.writes, 1);
  const missing = { ...tokenPayload, requestId: compactWindow + ':bbbbbbbb-1111-2222-3333-444444444444' };
  fixture.current = null;
  assert.deepEqual(host.handle({ method: 'compact-request', params: missing }), {
    requestId: missing.requestId,
    state: 'refused',
    reason: 'Arc holds no live session for this token. No compaction was queued.',
  });
});
