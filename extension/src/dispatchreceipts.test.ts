import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { tempDir } from './temproot';
import { DispatchReceipts, outsideDispatchStorage, safeDispatchPath, type DispatchEvent } from './dispatchreceipts';
import { HostedDispatch, type SavedDispatchResponse } from './dispatchhost';
import { payloadSha256 } from './sessionwrites';
import type { NativeEvent } from './agentwire';
import { spawnSync } from 'node:child_process';
import { savedDispatchResponse, SESSION_READ_LIMITS } from './sessionreads';
import { revisionOf, type SessionFile } from './transcript';
import { ClaudeWire } from './claudewire';

const origin = 'a'.repeat(24);
const session = 'aaaaaaaa-1111-2222-3333-444444444444';
const turn = 'bbbbbbbb-1111-2222-3333-444444444444';
const ending: Extract<NativeEvent, { kind: 'rootEnd' }> = {
  kind: 'rootEnd',
  provider: 'codex',
  sessionId: session,
  turnId: turn,
  generation: null,
  evidence: {},
  success: true,
};
const homes: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.useRealTimers();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});
function fixture(completion: 'manual' | 'wait' = 'manual', alias: string | null = null) {
  const home = tempDir('arc-dispatch-');
  homes.push(home);
  const receipts = new DispatchReceipts(home);
  const launch = receipts.reserve({
    origin,
    requester: { provider: 'codex', id: session },
    policy: null,
    promptSha256: payloadSha256('review'),
    completion,
    alias,
  });
  return { home, receipts, launch };
}
function report(receipts: DispatchReceipts, id: string, text = 'Report'): DispatchEvent {
  return receipts.publish(
    id,
    { outcome: 'succeeded', availability: 'available', nativeEnding: ending, askId: null },
    text,
  );
}
test('private reports remain independent when output aliases collide', () => {
  const aliasHome = tempDir('arc-alias-');
  homes.push(aliasHome);
  const alias = path.join(aliasHome, 'report.md');
  const a = fixture('manual', alias);
  const b = fixture('manual', alias);
  const first = report(a.receipts, a.launch.launchId, 'First');
  const second = report(b.receipts, b.launch.launchId, 'Second');
  assert.notEqual(first.report!.path, second.report!.path);
  assert.equal((a.receipts.result(a.launch.launchId, first.eventId) as { text: string }).text, 'First');
  assert.equal(fs.readFileSync(alias, 'utf8'), 'Second');
  assert.equal(a.receipts.refresh(a.launch.launchId), null);
  assert.equal(a.receipts.status(a.launch.launchId).events.length, 1);
});
test('concurrent channel captures retain each source byte once across stale cursors', () => {
  const { receipts, launch, home } = fixture();
  const standalone = receipts.reserve({
    ...launch,
    transport: 'standalone',
    standalone: {
      provider: 'codex',
      command: 'codex',
      args: [],
      cwd: home,
      model: 'test',
      effort: 'high',
      name: 'test',
      agentRun: false,
      background: false,
      sessionHint: null,
      logAlias: path.join(home, 'live.log'),
      deadlineMs: 10_000,
    },
  });
  const a = receipts.capture(standalone.launchId);
  const b = receipts.capture(standalone.launchId);
  try {
    const first = { offset: 3, identity: 'source' };
    a.write(Buffer.from('abc'), 'stdout.log', first);
    b.write(Buffer.from('abcde'), 'stdout.log', { offset: 5, identity: 'source' });
    a.write(Buffer.from('abc'), 'stdout.log', first);
    assert.deepEqual(first, { offset: 5, identity: 'source' });
    const c = receipts.capture(standalone.launchId);
    c.close();
    a.write(Buffer.from('fg'), 'stdout.log', { offset: 7, identity: 'source' });
    b.write(Buffer.from('ERR'), 'stderr.log', { offset: 3, identity: 'stderr' });
    assert.deepEqual(a.cursor('stdout.log'), { offset: 7, identity: 'source' });
    assert.equal(fs.readFileSync(receipts.artifact(standalone.launchId, 'worker.log'), 'utf8'), 'abcdefgERR');
    assert.equal(fs.readFileSync(standalone.standalone!.logAlias!, 'utf8'), 'abcdefgERR');
  } finally {
    a.close();
    b.close();
  }
});

test('native capture reconciles overlapping snapshots and preserves a reused alias', () => {
  const { receipts, launch, home } = fixture();
  const standalone = receipts.reserve({
    ...launch,
    transport: 'standalone',
    standalone: {
      provider: 'claude',
      command: 'claude',
      args: ['--bg'],
      cwd: home,
      model: 'test',
      effort: 'high',
      name: 'test',
      agentRun: false,
      background: true,
      sessionHint: null,
      logAlias: path.join(home, 'live.log'),
      deadlineMs: 10_000,
    },
  });
  const a = receipts.capture(standalone.launchId);
  const b = receipts.capture(standalone.launchId);
  try {
    a.native(Buffer.from('abc'), { offset: 3, identity: 'native' });
    b.native(Buffer.from('abcde'), { offset: 5, identity: 'native' });
    const stale = { offset: 3, identity: 'native' };
    a.native(Buffer.from('abc'), stale);
    assert.deepEqual(stale, { offset: 5, identity: 'native' });
    a.native(Buffer.from('old snapshot'));
    assert.equal(fs.readFileSync(standalone.standalone!.logAlias!, 'utf8'), 'abcde');
    const second = receipts.reserve({ ...standalone, origin: 'b'.repeat(24) });
    const replacement = receipts.capture(second.launchId);
    try {
      replacement.native(Buffer.from('Second launch'));
      const resumed = receipts.capture(standalone.launchId);
      try {
        assert.deepEqual(resumed.cursor('native-source.log'), { offset: 5, identity: 'native' });
        resumed.native(Buffer.from('fg'), { offset: 7, identity: 'native' });
      } finally {
        resumed.close();
      }
      assert.equal(fs.readFileSync(receipts.artifact(standalone.launchId, 'native.log'), 'utf8'), 'abcdefg');
      assert.equal(fs.readFileSync(standalone.standalone!.logAlias!, 'utf8'), 'Second launch');
      assert.throws(() => b.native(Buffer.from('x'), { offset: 8, identity: 'replacement' }), /position changed/);
    } finally {
      replacement.close();
    }
  } finally {
    a.close();
    b.close();
  }
});

test.each(
  (['print', 'native'] as const).flatMap((kind) =>
    (['continue', 'resume', 'legacy resume', 'bounded replay', 'replaced', 'reused'] as const).map((recovery) => ({
      kind,
      recovery,
    })),
  ),
)('failed log alias writes recover complete $kind bytes on $recovery', ({ kind, recovery }) => {
  const { receipts, launch, home } = fixture();
  const native = kind === 'native';
  const alias = path.join(home, 'live.log');
  const aliasByteBudget = recovery === 'bounded replay' ? 17 : undefined;
  const standalone = receipts.reserve({
    ...launch,
    transport: 'standalone',
    standalone: {
      provider: native ? 'claude' : 'codex',
      command: native ? 'claude' : 'codex',
      args: native ? ['--bg'] : [],
      cwd: home,
      model: 'test',
      effort: 'high',
      name: 'test',
      agentRun: false,
      background: native,
      sessionHint: null,
      logAlias: alias,
      deadlineMs: 10_000,
    },
  });
  let capture = receipts.capture(standalone.launchId, aliasByteBudget);
  const name = native ? 'native-source.log' : 'stdout.log';
  let offset = 0;
  const append = (bytes: Buffer) => {
    offset += bytes.length;
    const cursor = { offset, identity: 'source' };
    if (native) capture.native(bytes, cursor);
    else capture.write(bytes, name, cursor);
  };
  const prefix = Buffer.from('prefix\n');
  const missing = Buffer.alloc(recovery === 'bounded replay' ? 39 : 2 * 64 * 1024 + 17, 255);
  const tail = Buffer.from('tail\n');
  const privateFile = receipts.artifact(standalone.launchId, native ? 'native.log' : 'worker.log');
  try {
    append(prefix);
    const open = fs.openSync;
    let failed = false;
    const failure = vi.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
      if (String(file) === alias && !failed) {
        failed = true;
        throw Object.assign(new Error('alias temporarily unavailable'), { code: 'EPERM' });
      }
      return (open as any)(file, ...args);
    });
    syncBuiltinESMExports();
    assert.doesNotThrow(() => append(missing));
    failure.mockRestore();
    syncBuiltinESMExports();
    assert.equal(failed, true);
    assert.equal(fs.readFileSync(alias).equals(prefix), true);
    const captured = Buffer.concat([prefix, missing]);
    assert.equal(fs.readFileSync(privateFile).equals(captured), true);
    assert.deepEqual(capture.cursor(name), { offset: captured.length, identity: 'source' });
    const event = report(receipts, standalone.launchId);
    assert.equal((receipts.result(standalone.launchId, event.eventId) as { text: string }).text, 'Report');

    let replacement: Buffer | undefined;
    if (recovery === 'replaced') {
      fs.renameSync(alias, alias + '.old');
      replacement = Buffer.from('Replacement');
      fs.writeFileSync(alias, replacement);
    } else if (recovery === 'reused') {
      const second = receipts.reserve({ ...standalone, origin: 'b'.repeat(24) });
      const other = receipts.capture(second.launchId);
      replacement = Buffer.from('Second launch');
      try {
        if (native) other.native(replacement);
        else other.write(replacement);
      } finally {
        other.close();
      }
    } else if (recovery === 'legacy resume') {
      const checkpoint = receipts.artifact(standalone.launchId, 'capture.json');
      const state = JSON.parse(fs.readFileSync(checkpoint, 'utf8'));
      delete state.aliasBytes;
      fs.writeFileSync(checkpoint, JSON.stringify(state));
    }

    if (recovery !== 'continue') {
      capture.close();
      capture = new DispatchReceipts(path.dirname(receipts.root)).capture(standalone.launchId, aliasByteBudget);
      if (recovery === 'bounded replay') {
        const delivered = prefix.length + aliasByteBudget!;
        assert.deepEqual(fs.readFileSync(alias), captured.subarray(0, delivered));
        const checkpoint = JSON.parse(fs.readFileSync(receipts.artifact(standalone.launchId, 'capture.json'), 'utf8'));
        assert.equal(checkpoint.aliasBytes, delivered);
        assert.ok(delivered < captured.length);
      }
      for (let pass = 0; pass < 8 && capture.flushAlias(); pass++) {
        /* Continue bounded delivery without new output. */
      }
      assert.ok(
        fs.readFileSync(alias).equals(replacement ?? captured),
        'resumed alias must contain every captured byte',
      );
    }
    append(tail);
    for (let pass = 0; pass < 8 && capture.flushAlias(); pass++) {
      /* Drain the remaining alias bytes. */
    }
    const complete = Buffer.concat([captured, tail]);
    assert.equal(fs.readFileSync(privateFile).equals(complete), true);
    assert.ok(
      fs.readFileSync(alias).equals(replacement ?? complete),
      'alias must contain every captured byte exactly once',
    );
  } finally {
    capture.close();
  }
});

test.each([false, true])(
  'idle alias flushes preserve lock history and repair changed files, background %s',
  (background) => {
    const { receipts, launch, home } = fixture();
    const alias = path.join(home, 'live.log');
    const standalone = receipts.reserve({
      ...launch,
      transport: 'standalone',
      standalone: {
        provider: background ? 'claude' : 'codex',
        command: background ? 'claude' : 'codex',
        args: [],
        cwd: home,
        model: 'test',
        effort: 'high',
        name: 'test',
        agentRun: false,
        background,
        sessionHint: null,
        logAlias: alias,
        deadlineMs: 10_000,
      },
    });
    const raw = receipts.artifact(standalone.launchId, 'worker.log');
    const directory = path.dirname(raw);
    const history = () =>
      fs
        .readdirSync(directory)
        .filter((name) => name.startsWith('capture-write'))
        .sort();
    const source = receipts.artifact(standalone.launchId, background ? 'native-source.log' : 'stdout.log');
    const a = receipts.capture(standalone.launchId, 2);
    const b = receipts.capture(standalone.launchId, 2);
    const append = (text: string) => {
      fs.appendFileSync(source, text);
      const stat = fs.statSync(source, { bigint: true });
      const cursor = { offset: Number(stat.size), identity: `${stat.dev}:${stat.ino}` };
      if (background) b.native(Buffer.from(text), cursor);
      else b.write(Buffer.from(text), 'stdout.log', cursor);
    };
    const drain = () => {
      for (let pass = 0; pass < 8 && a.flushAlias(); pass++) {
        /* Drain bounded alias writes. */
      }
    };
    try {
      append('abcdef');
      drain();
      assert.equal(fs.readFileSync(alias, 'utf8'), 'abcdef');
      const idle = history();
      for (let pass = 0; pass < 12; pass++) assert.equal(a.flushAlias(), false);
      assert.deepEqual(history(), idle);

      fs.appendFileSync(raw, 'uncommitted');
      fs.appendFileSync(alias, 'uncommitted');
      a.flushAlias();
      assert.equal(fs.statSync(raw).size, background ? 0 : 6);
      assert.equal(fs.readFileSync(alias, 'utf8'), 'abcdef');

      append('ghij');
      drain();
      assert.equal(fs.readFileSync(alias, 'utf8'), 'abcdefghij');
      const settled = history();
      for (let pass = 0; pass < 12; pass++) assert.equal(a.flushAlias(), false);
      assert.deepEqual(history(), settled);

      fs.renameSync(alias, alias + '.old');
      fs.writeFileSync(alias, 'Replacement');
      const replaced = history();
      a.flushAlias();
      assert.notDeepEqual(history(), replaced);
      assert.equal(fs.readFileSync(alias, 'utf8'), 'Replacement');
      assert.equal(
        fs.readFileSync(background ? receipts.artifact(standalone.launchId, 'native.log') : raw, 'utf8'),
        'abcdefghij',
      );
    } finally {
      a.close();
      b.close();
    }
  },
);

test('interrupted claims retain their token and acknowledgments retain exactly one disposition', () => {
  const { receipts, launch } = fixture();
  const event = report(receipts, launch.launchId);
  const claim = receipts.claim(launch.launchId, event.eventId, origin, 'owner') as { token: string };
  const reopened = new DispatchReceipts(path.dirname(receipts.root));
  const retry = reopened.claim(launch.launchId, event.eventId, origin, 'owner') as { token: string; status: string };
  assert.equal(retry.status, 'already-claimed');
  assert.equal(retry.token, claim.token);
  assert.throws(() => receipts.claim(launch.launchId, event.eventId, origin, 'foreign'));
  assert.throws(() => receipts.claim(launch.launchId, event.eventId, 'b'.repeat(24), 'owner'));
  const ack = receipts.ack(launch.launchId, event.eventId, origin, 'owner', claim.token, 'Accepted ✓');
  assert.deepEqual(receipts.ack(launch.launchId, event.eventId, origin, 'owner', claim.token, 'Accepted ✓'), ack);
  assert.equal(
    fs.readFileSync(path.join(receipts.root, launch.launchId, `${event.eventId}.disposition.md`), 'utf8'),
    'Accepted ✓',
  );
  assert.throws(() => receipts.ack(launch.launchId, event.eventId, origin, 'owner', claim.token, 'Rejected'));
});
test('changed report observations remain unread after an older event is consumed', () => {
  const aliasHome = tempDir('arc-refresh-');
  homes.push(aliasHome);
  const alias = path.join(aliasHome, 'report.md');
  const { receipts, launch } = fixture('manual', alias);
  const first = report(receipts, launch.launchId);
  const claim = receipts.claim(launch.launchId, first.eventId, origin, 'owner') as { token: string };
  receipts.ack(launch.launchId, first.eventId, origin, 'owner', claim.token, 'Accepted');
  fs.writeFileSync(receipts.status(launch.launchId).reportSource!, 'Changed');
  const changed = receipts.refresh(launch.launchId)!;
  assert.notEqual(changed.eventId, first.eventId);
  assert.equal(receipts.status(launch.launchId).events.at(-1)!.consumption.dispositionSha256, undefined);
  assert.throws(() => receipts.ack(launch.launchId, changed.eventId, origin, 'owner', claim.token, 'Accepted'));
  assert.equal((receipts.result(launch.launchId, first.eventId) as { text: string }).text, 'Report');
  assert.equal(receipts.refresh(launch.launchId), null);
});
test('report text and serialized text both respect reply allowances', () => {
  const { receipts, launch } = fixture();
  for (const text of ['x'.repeat(16_001), '\u0001'.repeat(16_000)]) {
    const event = report(receipts, launch.launchId, text);
    const result = receipts.result(launch.launchId, event.eventId) as { text: string | null };
    assert.equal(result.text, null);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 48 * 1024);
  }
});

test('retained reports reach the event limit without exceeding the internal state read allowance', () => {
  const { receipts, launch } = fixture();
  let last: DispatchEvent | null = null;
  for (let index = 0; index < 256; index++) last = report(receipts, launch.launchId);
  assert.equal(receipts.latest(launch.launchId)!.eventId, last!.eventId);
  assert.equal((receipts.result(launch.launchId, last!.eventId) as { text: string }).text, 'Report');
  fs.copyFileSync(
    path.join(receipts.root, launch.launchId, 'state.json'),
    path.join(receipts.root, launch.launchId, 'state.0.json'),
  );
  const next = report(receipts, launch.launchId, 'Final after capacity');
  assert.equal((receipts.result(launch.launchId, next.eventId) as { text: string }).text, 'Final after capacity');
});
test('authoritative receipt, report and accepted-turn replacements refuse', () => {
  const { receipts, launch } = fixture();
  const event = report(receipts, launch.launchId);
  const file = event.report!.path;
  fs.renameSync(file, `${file}.old`);
  fs.writeFileSync(file, 'Report');
  assert.throws(() => receipts.result(launch.launchId, event.eventId), /replaced/);
  const binding = { provider: 'codex' as const, sessionId: session, submissionId: 1, nativeTurnId: turn };
  receipts.bind(launch.launchId, binding);
  assert.throws(() => receipts.bind(launch.launchId, { ...binding, nativeTurnId: 'changed' }));
  const accepted = path.join(receipts.root, launch.launchId, 'accepted.json');
  fs.renameSync(accepted, `${accepted}.old`);
  fs.writeFileSync(accepted, JSON.stringify({ launchId: launch.launchId, ...binding }));
  assert.throws(() => receipts.bind(launch.launchId, binding));
  const receipt = path.join(receipts.root, launch.launchId, 'receipt.json');
  fs.renameSync(receipt, `${receipt}.old`);
  fs.writeFileSync(receipt, fs.readFileSync(`${receipt}.old`));
  assert.throws(() => receipts.launch(launch.launchId), /replaced/);
  assert.throws(() => receipts.launch('../unsafe'));
});
test('redirected receipt directories and private report aliases refuse', () => {
  const { receipts, launch, home } = fixture();
  const target = tempDir('arc-dispatch-target-');
  homes.push(target);
  const aliasDirectory = path.join(home, 'redirected');
  fs.symlinkSync(target, aliasDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    assert.throws(() => receipts.reserve({ ...launch, alias: path.join(aliasDirectory, 'report.md') }));
  } finally {
    fs.unlinkSync(aliasDirectory);
  }
  assert.throws(() => receipts.reserve({ ...launch, alias: path.join(receipts.root, 'alias.md') }));
  const directory = path.join(receipts.root, launch.launchId);
  fs.renameSync(directory, `${directory}.old`);
  fs.symlinkSync(`${directory}.old`, directory, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    assert.throws(() => receipts.launch(launch.launchId), /redirected|replaced/);
  } finally {
    fs.unlinkSync(directory);
  }
  assert.ok(fs.existsSync(home));
});
test('native successful completion waits for matching saved root evidence', () => {
  const { receipts, launch } = fixture();
  let saved: SavedDispatchResponse | null = null;
  const host = new HostedDispatch(receipts, () => saved);
  const child = { key: 'worker', agent: 'codex', state: () => ({ sessionId: session, exited: false }) };
  host.register(launch.launchId, child);
  host.submitted(launch.launchId, 1);
  host.observe(child, { kind: 'text', text: 'Final', sourceId: 'response', nativeTurnId: turn }, 1);
  host.observe(child, { kind: 'native', event: { ...ending, sessionId: 'cccccccc-1111-2222-3333-444444444444' } }, 1);
  assert.equal(receipts.status(launch.launchId).events.length, 0);
  host.observe(child, { kind: 'native', event: ending }, 2);
  assert.equal(receipts.status(launch.launchId).events.length, 0);
  host.observe(child, { kind: 'native', event: ending }, 1);
  assert.equal(receipts.status(launch.launchId).events.at(-1)!.availability, 'pending');
  saved = { text: 'Wrong', prompt: 'review', promptId: turn, responseIds: [], finished: true, failed: false };
  host.reconcileAll();
  assert.equal(receipts.status(launch.launchId).events.length, 1);
  saved.text = 'Final';
  host.reconcileAll();
  assert.equal(receipts.status(launch.launchId).events.at(-1)!.availability, 'available');
  host.observe(child, { kind: 'native', event: { ...ending, success: false } }, 1);
  assert.equal(receipts.status(launch.launchId).events.at(-1)!.outcome, 'succeeded');
});
test('native failure, input requests and unknown process exit remain distinct', () => {
  for (const mode of ['failed', 'needs-input', 'exit']) {
    const { receipts, launch } = fixture();
    const host = new HostedDispatch(receipts, () => ({
      text: 'Failure',
      prompt: 'review',
      promptId: turn,
      responseIds: [],
      finished: false,
      failed: true,
    }));
    const child = {
      key: mode,
      agent: 'codex',
      dispatchRootActive: () => true,
      state: () => ({ sessionId: session, exited: mode === 'exit' }),
    };
    host.register(launch.launchId, child);
    host.submitted(launch.launchId, 1);
    if (mode === 'failed') {
      host.observe(child, { kind: 'text', text: 'Failure', sourceId: 'response' }, 1);
      host.observe(child, { kind: 'native', event: { ...ending, success: false } }, 1);
      host.observe(
        child,
        { kind: 'turnEnd', outcome: { status: 'error', text: '', costUsd: null, turns: null, deniedTools: [] } },
        1,
      );
    } else if (mode === 'exit') host.exited(child);
    else
      host.observe(
        child,
        {
          kind: 'ask',
          ask: {
            kind: 'permission',
            id: 'ask',
            toolName: 'tool',
            displayName: 'Tool',
            description: '',
            toolUseId: '',
            input: {},
          },
        },
        undefined,
      );
    const event = receipts.status(launch.launchId).events.at(-1)!;
    assert.equal(event.outcome, mode === 'exit' ? 'unknown' : mode);
    if (mode !== 'failed') assert.equal(event.report, null);
  }
});
test('wait deadline and disconnection retain the exact worker and receipt', async () => {
  vi.useFakeTimers();
  const { receipts, launch } = fixture('wait');
  const host = new HostedDispatch(receipts, () => null);
  const child = { key: 'worker', agent: 'codex', state: () => ({ sessionId: session, exited: false }) };
  host.register(launch.launchId, child);
  const signal = new AbortController();
  const waited = host.wait(launch.launchId, 100, signal.signal);
  signal.abort();
  assert.deepEqual(await waited, {
    launchId: launch.launchId,
    state: 'uncertain',
    reason: 'The wait disconnected. Read dispatch status or recover this receipt.',
  });
  const deadline = host.wait(launch.launchId, 100, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(100);
  assert.equal(((await deadline) as { state: string }).state, 'deadline');
  assert.equal(receipts.launch(launch.launchId).launchId, launch.launchId);
  assert.throws(() => host.register(launch.launchId, child));
});
test('retained launches continue admission after 256 unconsumed receipts', () => {
  const { receipts, launch } = fixture();
  for (let index = 0; index < 256; index++) receipts.reserve(launch);
  assert.equal(receipts.launch(launch.launchId).launchId, launch.launchId);
  assert.equal(fs.readdirSync(receipts.root).filter((name) => !name.includes('.')).length, 257);
});

test('large dispositions never hide later event identities in bounded status pages', () => {
  const { receipts, launch } = fixture();
  const ids: string[] = [];
  for (let index = 0; index < 70; index++) {
    const event = report(receipts, launch.launchId, String(index));
    ids.push(event.eventId);
    const claim = receipts.claim(launch.launchId, event.eventId, origin, 'owner') as { token: string };
    receipts.ack(launch.launchId, event.eventId, origin, 'owner', claim.token, '\u0001'.repeat(6000));
  }
  const found: string[] = [];
  let cursor: string | undefined;
  do {
    const page = receipts.status(launch.launchId, cursor);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 48 * 1024);
    found.push(...page.events.map((event) => event.eventId));
    cursor = page.next ?? undefined;
  } while (cursor);
  assert.deepEqual(found, ids);
  assert.equal((receipts.result(launch.launchId, ids[0]) as any).consumption.disposition, '\u0001'.repeat(6000));
});

test.each(['hosted', 'standalone'] as const)(
  'exact-boundary %s launch keeps every status event readable',
  (transport) => {
    const { receipts, launch, home } = fixture();
    const input = {
      ...launch,
      transport,
      policy: { readOnly: true as const, readTools: [''] },
      ...(transport === 'standalone'
        ? {
            standalone: {
              provider: 'codex' as const,
              command: 'codex',
              args: [],
              cwd: home,
              model: 'sol',
              effort: 'high',
              name: '',
              agentRun: true,
              background: false,
              sessionHint: null,
              logAlias: null,
              deadlineMs: 1000,
            },
          }
        : {}),
    };
    const measured = receipts.reserve(input);
    input.policy.readTools[0] = 'x'.repeat(48 * 1024 - Buffer.byteLength(JSON.stringify(measured)));
    const large = receipts.reserve(input);
    assert.equal(Buffer.byteLength(JSON.stringify(large)), 48 * 1024);
    assert.deepEqual(receipts.launch(large.launchId), large);
    const empty = receipts.status(large.launchId);
    assert.ok(
      Buffer.byteLength(JSON.stringify(empty)) <= 44 * 1024,
      'an admitted launch needs a readable empty status',
    );
    if (transport === 'standalone')
      receipts.observation(large.launchId, {
        supervisor: { pid: process.pid, token: 'f'.repeat(64) },
        worker: {
          pid: process.pid,
          command: 'c'.repeat(10 * 1024),
          startedAt: 'native-lifetime',
          argsSha256: payloadSha256('args'),
          commandLineSha256: payloadSha256('native\0args\0'),
        },
        sessionId: session,
        exitCode: 0,
        signal: null,
        monitor: 'finished',
      });
    const ids: string[] = [];
    for (let index = 0; index < 4; index++) {
      const event = receipts.publish(
        large.launchId,
        {
          outcome: 'needs-input',
          availability: 'available',
          nativeEnding: ending,
          askId: 'a'.repeat(26 * 1024) + index,
        },
        'Original ' + index,
      );
      ids.push(event.eventId);
      const owner = 'o'.repeat(128);
      const claim = receipts.claim(large.launchId, event.eventId, origin, owner) as { token: string };
      receipts.ack(large.launchId, event.eventId, origin, owner, claim.token, 'Disposition ' + index);
    }
    const found: string[] = [];
    let cursor: string | undefined;
    do {
      const page = receipts.status(large.launchId, cursor, 128);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 44 * 1024);
      assert.ok(page.events.length > 0, 'the first accepted event must remain discoverable');
      assert.notEqual(page.next, cursor, 'a nonterminal status cursor must advance');
      assert.deepEqual(page.launch, {
        launchId: large.launchId,
        transport,
        origin,
        completion: large.completion,
      });
      if (transport === 'standalone') {
        assert.equal(page.observation!.sessionId, session);
        assert.equal(page.observation!.exitCode, 0);
        assert.equal(page.observation!.monitor, 'finished');
      }
      for (const event of page.events) {
        assert.equal(event.delivery, 'unavailable');
        assert.equal(event.consumption.dispositionSha256, payloadSha256('Disposition ' + ids.indexOf(event.eventId)));
      }
      assert.ok(page.reportSource);
      found.push(...page.events.map((event) => event.eventId));
      cursor = page.next ?? undefined;
      assert.ok(found.length <= ids.length);
    } while (cursor);
    assert.deepEqual(found, ids);
    assert.equal((receipts.result(large.launchId, ids[0]) as any).text, 'Original 0');
    assert.equal((receipts.result(large.launchId, ids[0]) as any).consumption.disposition, 'Disposition 0');
  },
);

test('first accepted event advances beside large readable launch and observation metadata', () => {
  const { receipts, launch, home } = fixture();
  const standalone = receipts.reserve({
    ...launch,
    transport: 'standalone',
    standalone: {
      provider: 'codex',
      command: 'codex',
      args: ['x'.repeat(14 * 1024)],
      cwd: home,
      model: 'sol',
      effort: 'high',
      name: '',
      agentRun: true,
      background: false,
      sessionHint: null,
      logAlias: null,
      deadlineMs: 1000,
    },
  });
  receipts.observation(standalone.launchId, {
    supervisor: { pid: process.pid, token: 'f'.repeat(64) },
    worker: {
      pid: process.pid,
      command: 'c'.repeat(10 * 1024),
      startedAt: 'native-lifetime',
      argsSha256: payloadSha256('args'),
      commandLineSha256: payloadSha256('native\0args\0'),
    },
    sessionId: session,
    exitCode: 0,
    signal: null,
    monitor: 'finished',
  });
  assert.ok(Buffer.byteLength(JSON.stringify(receipts.launch(standalone.launchId))) < 48 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(receipts.observation(standalone.launchId))) < 48 * 1024);
  const first = receipts.publish(
    standalone.launchId,
    {
      outcome: 'needs-input',
      availability: 'available',
      nativeEnding: ending,
      askId: 'a'.repeat(26 * 1024),
    },
    'First original',
  );
  const second = report(receipts, standalone.launchId, 'Second original');
  const page = receipts.status(standalone.launchId, undefined, 1);
  assert.deepEqual(
    page.events.map((event) => event.eventId),
    [first.eventId],
    'the first accepted event must remain discoverable',
  );
  assert.equal(page.next, `${standalone.launchId}:1`);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 44 * 1024);
  const next = receipts.status(standalone.launchId, page.next, 1);
  assert.deepEqual(
    next.events.map((event) => event.eventId),
    [second.eventId],
  );
  assert.equal(next.next, null);
  assert.equal((receipts.result(standalone.launchId, first.eventId) as any).text, 'First original');
});

test('unreadable observations leave the last readable observation intact', () => {
  const { receipts, launch, home } = fixture();
  const standalone = receipts.reserve({
    ...launch,
    transport: 'standalone',
    standalone: {
      provider: 'codex',
      command: 'codex',
      args: [],
      cwd: home,
      model: 'sol',
      effort: 'high',
      name: '',
      agentRun: true,
      background: false,
      sessionHint: null,
      logAlias: null,
      deadlineMs: 1000,
    },
  });
  const observation = {
    supervisor: { pid: process.pid, token: 'f'.repeat(64) },
    worker: null,
    sessionId: null,
    exitCode: null,
    signal: null,
    monitor: 'starting' as const,
  };
  receipts.observation(standalone.launchId, observation);
  assert.throws(() =>
    receipts.observation(standalone.launchId, {
      ...observation,
      reason: 'x'.repeat(48 * 1024),
    }),
  );
  assert.deepEqual(receipts.observation(standalone.launchId), observation);
});

test('dead write owners allow exact claim recovery while live owners remain protected', () => {
  const { receipts, launch } = fixture();
  const event = report(receipts, launch.launchId);
  const first = receipts.claim(launch.launchId, event.eventId, origin, 'owner') as { token: string };
  const lock = path.join(receipts.root, launch.launchId, 'write.lock');
  const child = spawnSync(process.execPath, [
    '-e',
    "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({pid:process.pid,token:process.argv[2],launchId:process.argv[3]}))",
    lock,
    turn,
    launch.launchId,
  ]);
  assert.equal(child.status, 0);
  assert.equal((receipts.claim(launch.launchId, event.eventId, origin, 'owner') as any).token, first.token);
  fs.writeFileSync(
    lock,
    JSON.stringify({ pid: process.pid, token: 'dddddddd-1111-2222-3333-444444444444', launchId: launch.launchId }),
  );
  assert.throws(() => receipts.claim(launch.launchId, event.eventId, origin, 'owner'), /holds/);
  fs.unlinkSync(lock);
});

test('two stale recoverers cannot remove the newly acquired live owner or change a retained claim', () => {
  const { receipts, launch } = fixture();
  const event = report(receipts, launch.launchId);
  const claim = receipts.claim(launch.launchId, event.eventId, origin, 'owner') as { token: string };
  const lock = path.join(receipts.root, launch.launchId, 'write.lock');
  const deadPid = 2147483647;
  const held = JSON.stringify({ pid: deadPid, token: turn, launchId: launch.launchId });
  fs.writeFileSync(lock, held);
  const successor = path.join(receipts.root, launch.launchId, `write.${turn}.next.lock`);
  const live = JSON.stringify({ pid: process.pid, token: session, launchId: launch.launchId });
  const link = fs.linkSync;
  const unlink = fs.unlinkSync;
  let interleaved = false;
  const recoverOther = () => {
    interleaved = true;
    // The other recoverer has already validated the same dead owner and now holds its successor.
    fs.writeFileSync(successor, live, { flag: 'wx' });
    fs.writeFileSync(lock, live);
  };
  vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
    if (String(to) === successor && !interleaved) recoverOther();
    return link(from, to);
  });
  vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
    // A stale recoverer reaches removal after its final ownership check.
    if (String(file) === lock && !interleaved) recoverOther();
    return unlink(file);
  });
  syncBuiltinESMExports();
  assert.throws(() => receipts.claim(launch.launchId, event.eventId, origin, 'owner'));
  assert.equal(interleaved, true);
  assert.equal(fs.readFileSync(lock, 'utf8'), live);
  assert.equal((receipts.result(launch.launchId, event.eventId) as any).consumption.owner, 'owner');
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  fs.writeFileSync(path.join(receipts.root, launch.launchId, `write.${session}.released`), live);
  assert.equal((receipts.claim(launch.launchId, event.eventId, origin, 'owner') as any).token, claim.token);
});

test.each([1, 40])(
  'death after reserving %s recovery successors remains recoverable and uncertain owners remain protected',
  (count) => {
    const { receipts, launch } = fixture();
    const event = report(receipts, launch.launchId);
    const claim = receipts.claim(launch.launchId, event.eventId, origin, 'owner') as { token: string };
    const directory = path.join(receipts.root, launch.launchId);
    const child = spawnSync(process.execPath, [
      '-e',
      "const fs=require('node:fs'),path=require('node:path'); let owner={pid:process.pid,token:process.argv[2],launchId:process.argv[4]}; fs.writeFileSync(path.join(process.argv[1],'write.lock'),JSON.stringify(owner)); for(let i=0;i<Number(process.argv[5]);i++){const next={...owner,token:String(i).padStart(8,'0')+'-1111-2222-3333-444444444444'}; fs.writeFileSync(path.join(process.argv[1],'write.'+owner.token+'.next.lock'),JSON.stringify(next)); owner=next;}",
      directory,
      turn,
      session,
      launch.launchId,
      String(count),
    ]);
    assert.equal(child.status, 0);
    if (count > 32) assert.throws(() => receipts.claim(launch.launchId, event.eventId, origin, 'owner'), /Try again/);
    assert.equal((receipts.claim(launch.launchId, event.eventId, origin, 'owner') as any).token, claim.token);
    // Use a valid distinct owner token with an inaccessible process.
    fs.writeFileSync(
      path.join(directory, 'write.lock'),
      JSON.stringify({ pid: 2147483646, token: 'dddddddd-1111-2222-3333-444444444444', launchId: launch.launchId }),
    );
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
    });
    assert.throws(() => receipts.claim(launch.launchId, event.eventId, origin, 'owner'), /holds/);
  },
);

test.each(['retry', 'conflict', 'replacement', 'redirect'] as const)(
  'accepted binding publication recovers only exact retained identity after witness failure: %s',
  (change) => {
    const { receipts, launch } = fixture();
    const binding = { provider: 'codex' as const, sessionId: session, submissionId: 1, nativeTurnId: turn };
    const accepted = path.join(receipts.root, launch.launchId, 'accepted.json');
    const witness = path.join(receipts.root, `${launch.launchId}.accepted.json`);
    const write = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
      if (String(file) === witness) throw new Error('witness storage unavailable');
      return (write as any)(file, ...args);
    });
    syncBuiltinESMExports();
    assert.throws(() => receipts.bind(launch.launchId, binding), /witness storage/);
    assert.ok(fs.existsSync(accepted));
    assert.equal(fs.existsSync(witness), false);
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    if (change === 'replacement' || change === 'redirect') {
      fs.renameSync(accepted, accepted + '.old');
      if (change === 'replacement') fs.copyFileSync(accepted + '.old', accepted);
      else fs.symlinkSync(path.dirname(accepted), accepted, process.platform === 'win32' ? 'junction' : 'dir');
    }
    if (change !== 'retry') {
      assert.throws(() =>
        receipts.bind(launch.launchId, change === 'conflict' ? { ...binding, nativeTurnId: 'foreign' } : binding),
      );
      if (change === 'redirect') fs.unlinkSync(accepted);
      return;
    }
    const reopened = new DispatchReceipts(path.dirname(receipts.root));
    assert.doesNotThrow(() => reopened.bind(launch.launchId, binding));
    assert.ok(fs.existsSync(witness));
    assert.doesNotThrow(() => reopened.bind(launch.launchId, binding));
  },
);

test('host reconciliation recovers a witness fault without another submission or worker', () => {
  const { receipts, launch } = fixture();
  const host = new HostedDispatch(receipts, () => ({
    text: 'Final',
    prompt: 'review',
    promptId: turn,
    responseIds: [],
    finished: true,
    failed: false,
  }));
  const child = { key: 'worker', agent: 'codex', state: () => ({ sessionId: session, exited: false }) };
  host.register(launch.launchId, child);
  host.submitted(launch.launchId, 1);
  const witness = path.join(receipts.root, `${launch.launchId}.accepted.json`);
  const write = fs.writeFileSync;
  vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
    if (String(file) === witness) throw new Error('witness storage unavailable');
    return (write as any)(file, ...args);
  });
  syncBuiltinESMExports();
  host.accepted(launch.launchId, turn);
  host.observe(child, { kind: 'text', text: 'Final', sourceId: 'response' }, 1);
  host.observe(child, { kind: 'native', event: ending }, 1);
  assert.ok(fs.existsSync(path.join(receipts.root, launch.launchId, 'accepted.json')));
  assert.equal(fs.existsSync(witness), false);
  assert.equal(receipts.latest(launch.launchId), null);
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  host.reconcileAll();
  assert.equal(receipts.latest(launch.launchId)!.availability, 'available');
  assert.equal((receipts.result(launch.launchId, receipts.latest(launch.launchId)!.eventId) as any).text, 'Final');
  host.reconcileAll();
  assert.equal(receipts.status(launch.launchId).events.length, 1);
});

test('receipt write errors preserve native observation and retry without repeating input', () => {
  const { receipts, launch } = fixture();
  const saved = {
    text: 'Final',
    prompt: 'review',
    promptId: 'turn-opaque',
    responseIds: [],
    finished: true,
    failed: false,
  };
  const host = new HostedDispatch(receipts, () => saved);
  const child = { key: 'worker', agent: 'codex', state: () => ({ sessionId: session, exited: false }) };
  host.register(launch.launchId, child);
  host.submitted(launch.launchId, 1);
  const bind = vi.spyOn(receipts, 'bind').mockImplementationOnce(() => {
    throw new Error('storage unavailable');
  });
  assert.doesNotThrow(() => host.accepted(launch.launchId, 'turn-opaque'));
  bind.mockRestore();
  host.observe(child, { kind: 'text', text: 'Final', sourceId: 'response' }, 1);
  const publish = vi.spyOn(receipts, 'publish').mockImplementationOnce(() => {
    throw new Error('storage unavailable');
  });
  assert.doesNotThrow(() => host.observe(child, { kind: 'native', event: { ...ending, turnId: 'turn-opaque' } }, 1));
  assert.equal(receipts.status(launch.launchId).events.length, 0);
  publish.mockRestore();
  host.reconcileAll();
  assert.equal(receipts.latest(launch.launchId)!.availability, 'available');
  assert.equal(receipts.latest(launch.launchId)!.outcome, 'succeeded');
});

test('interrupted native endings agree with interrupted saved evidence without becoming failed', () => {
  const { receipts, launch } = fixture();
  const host = new HostedDispatch(receipts, () => ({
    text: 'Partial',
    prompt: 'review',
    promptId: turn,
    responseIds: [],
    finished: true,
    failed: false,
    interrupted: true,
  }));
  const child = { key: 'worker', agent: 'codex', state: () => ({ sessionId: session, exited: false }) };
  host.register(launch.launchId, child);
  host.submitted(launch.launchId, 1);
  host.observe(child, { kind: 'text', text: 'Partial', sourceId: 'response' }, 1);
  host.observe(child, { kind: 'native', event: { ...ending, success: false } }, 1);
  assert.equal(receipts.latest(launch.launchId), null);
  host.observe(
    child,
    { kind: 'turnEnd', outcome: { status: 'interrupted', text: '', costUsd: null, turns: null, deniedTools: [] } },
    1,
  );
  assert.equal(receipts.latest(launch.launchId)!.outcome, 'interrupted');
  assert.equal(receipts.latest(launch.launchId)!.availability, 'available');
});

test('startup error observation and subsequent child exit publish one unknown event', () => {
  const { receipts, launch } = fixture();
  const host = new HostedDispatch(receipts, () => null);
  const child = { key: 'worker', agent: 'codex', state: () => ({ sessionId: session, exited: true }) };
  host.register(launch.launchId, child);
  host.unavailable(launch.launchId);
  host.exited(child);
  assert.equal(receipts.status(launch.launchId).events.length, 1);
});

test.each(['claude', 'codex'] as const)(
  'complete large %s evidence retains root identity and full final response',
  (agent) => {
    const { receipts, launch, home } = fixture();
    const file = path.join(home, 'session.jsonl');
    const at = '2026-01-01T00:00:00Z';
    const rows =
      agent === 'claude'
        ? [
            { type: 'user', uuid: 'prompt', timestamp: at, message: { role: 'user', content: 'review' } },
            { type: 'progress', padding: 'x'.repeat(600 * 1024) },
            {
              type: 'assistant',
              timestamp: at,
              message: {
                id: 'response',
                role: 'assistant',
                stop_reason: 'end_turn',
                content: [
                  { type: 'text', text: 'First' },
                  { type: 'text', text: ' ' },
                  { type: 'text', text: 'Second' },
                ],
                usage: { input_tokens: 1, output_tokens: 2 },
              },
            },
          ]
        : [
            { type: 'session_meta', payload: { id: session, cwd: home, source: 'vscode' } },
            { type: 'event_msg', timestamp: at, payload: { type: 'task_started', turn_id: 'root-turn' } },
            { type: 'event_msg', timestamp: at, payload: { type: 'user_message', message: 'review' } },
            { type: 'progress', padding: 'x'.repeat(600 * 1024) },
            {
              type: 'response_item',
              timestamp: at,
              payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'First\nSecond' }],
              },
            },
            {
              type: 'event_msg',
              timestamp: at,
              payload: { type: 'task_complete', turn_id: 'root-turn', last_agent_message: 'First\nSecond' },
            },
          ];
    fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    const source = {
      file,
      agent,
      sessionId: session,
      ...revisionOf(fs.statSync(file, { bigint: true })),
    } as SessionFile;
    let saved: SavedDispatchResponse | null = null;
    for (let attempts = 0; attempts < 100 && !saved; attempts++)
      saved = savedDispatchResponse(source, agent === 'claude' ? '1' : 'root-turn');
    assert.ok(saved);
    assert.equal(saved.text, agent === 'claude' ? 'First\n \nSecond' : 'First\nSecond');
    assert.equal(saved.prompt, 'review');
    assert.equal(saved.finished, true);
    if (agent === 'claude') assert.deepEqual(saved.responseIds, ['response']);
    const host = new HostedDispatch(receipts, () => saved);
    const child = { key: 'worker', agent, state: () => ({ sessionId: session, exited: false }) };
    host.register(launch.launchId, child);
    host.submitted(launch.launchId, 1);
    if (agent === 'claude') {
      const wire = new ClaudeWire({
        send: () => {},
        emit: (event) => host.observe(child, event, 1),
        sessionId: session,
      });
      wire.receive(JSON.stringify({ ...rows.at(-1), session_id: session }));
    } else host.observe(child, { kind: 'text', text: 'First\nSecond', sourceId: 'response' }, 1);
    host.observe(
      child,
      {
        kind: 'native',
        event:
          agent === 'claude'
            ? { ...ending, provider: 'claude', turnId: null, generation: 1 }
            : { ...ending, turnId: 'root-turn' },
      },
      1,
    );
    assert.equal(receipts.latest(launch.launchId)!.availability, 'available');
    assert.equal(fs.readFileSync(receipts.latest(launch.launchId)!.report!.path, 'utf8'), saved.text);
    assert.equal(savedDispatchResponse(source, agent === 'claude' ? '2' : 'foreign-turn'), null);
  },
);

test.each(
  (['claude', 'codex'] as const).flatMap((agent) => [
    { agent, escaping: 'backslash', character: 92, bytes: 4 * 1024 * 1024 + 1 },
    { agent, escaping: 'six-to-one', character: 1, bytes: 8 * 1024 * 1024 },
  ]),
)(
  'escaped $agent $escaping final response above four MiB survives bounded saved recovery',
  ({ agent, character, bytes }) => {
    const { receipts, launch, home } = fixture();
    const file = path.join(home, 'escaped.jsonl');
    const text = String.fromCharCode(character).repeat(bytes);
    const at = '2026-01-01T00:00:00Z';
    const rows =
      agent === 'claude'
        ? [
            { type: 'user', uuid: 'prompt', timestamp: at, message: { role: 'user', content: 'review' } },
            {
              type: 'assistant',
              timestamp: at,
              message: {
                id: 'response',
                role: 'assistant',
                stop_reason: 'end_turn',
                content: [{ type: 'text', text }],
                usage: { input_tokens: 1, output_tokens: 2 },
              },
            },
          ]
        : [
            { type: 'session_meta', payload: { id: session, cwd: home, source: 'vscode' } },
            { type: 'event_msg', timestamp: at, payload: { type: 'task_started', turn_id: turn } },
            { type: 'event_msg', timestamp: at, payload: { type: 'user_message', message: 'review' } },
            {
              type: 'response_item',
              timestamp: at,
              payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
            },
            {
              type: 'event_msg',
              timestamp: at,
              payload: { type: 'task_complete', turn_id: turn, last_agent_message: text },
            },
          ];
    const encoded = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
    fs.writeFileSync(file, encoded, 'utf8');
    const source = {
      file,
      agent,
      sessionId: session,
      ...revisionOf(fs.statSync(file, { bigint: true })),
    } as SessionFile;
    const native = agent === 'claude' ? '1' : turn;
    let saved: SavedDispatchResponse | null = null;
    const readCallBudget = Math.ceil(Buffer.byteLength(encoded) / SESSION_READ_LIMITS.bytes) + rows.length + 1;
    for (let attempts = 0; attempts < readCallBudget && !saved; attempts++)
      saved = savedDispatchResponse(source, native);
    assert.ok(saved);
    assert.equal(saved.text.length, text.length);
    assert.equal(saved.text, text);
    assert.equal(saved.finished, true);
    if (agent === 'claude') assert.deepEqual(saved.responseIds, ['response']);
    else assert.equal(saved.promptId, turn);
    const host = new HostedDispatch(receipts, () => saved);
    const child = { key: 'worker', agent, state: () => ({ sessionId: session, exited: false }) };
    host.register(launch.launchId, child);
    host.submitted(launch.launchId, 1);
    host.observe(child, { kind: 'text', text, sourceId: 'response' }, 1);
    host.observe(
      child,
      {
        kind: 'native',
        event: agent === 'claude' ? { ...ending, provider: 'claude', turnId: null, generation: 1 } : ending,
      },
      1,
    );
    const event = receipts.latest(launch.launchId)!;
    assert.equal(event.availability, 'available');
    assert.equal(event.report!.bytes, Buffer.byteLength(text));
    assert.equal(fs.readFileSync(event.report!.path, 'utf8'), text);
  },
);

test.each([
  ['win32', 'C:\\Private\\dispatch', 'D:\\Reports\\result.md', true],
  ['win32', 'C:\\Private\\dispatch', 'c:\\private\\dispatch\\result.md', false],
  ['darwin', '/private/var/Arc/dispatch', '/private/var/Arc/dispatch/result.md', false],
  ['darwin', '/private/var/Arc/dispatch', '/Users/Reader/Reports/result.md', true],
  ['linux', '/home/reader/.arc/dispatch', '/home/reader/.arc/dispatch/result.md', false],
  ['linux', '/home/reader/.arc/dispatch', '/home/reader/reports/result.md', true],
] as const)('report aliases retain independent %s admission for %s and %s', (platform, root, alias, expected) => {
  assert.equal(outsideDispatchStorage(root, alias, platform), expected);
});

test('physical private parents refuse case variants and replaced private sources refuse refresh', () => {
  const { receipts, launch } = fixture();
  const event = report(receipts, launch.launchId);
  const candidate = path.join(receipts.root.toUpperCase(), 'report.md');
  if (fs.existsSync(path.dirname(candidate)))
    assert.throws(() => receipts.reserve({ ...launch, alias: candidate }), /private dispatch/);
  const source = receipts.status(launch.launchId).reportSource!;
  fs.renameSync(source, source + '.old');
  fs.writeFileSync(source, 'Replaced');
  assert.throws(() => receipts.refresh(launch.launchId), /replaced/);
  assert.equal((receipts.result(launch.launchId, event.eventId) as any).text, 'Report');
});

test('trusted system temp roots resolve their physical parents without admitting private aliases', () => {
  const { receipts, launch, home } = fixture();
  const aliasHome = tempDir('arc-system-temp-');
  homes.push(aliasHome);
  const aliasDirectory = path.join(aliasHome, 'temp');
  fs.symlinkSync(home, aliasDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  const temporary = vi.spyOn(os, 'tmpdir').mockReturnValue(aliasDirectory);
  syncBuiltinESMExports();
  try {
    assert.doesNotThrow(() => receipts.reserve({ ...launch, alias: path.join(aliasDirectory, 'report.md') }));
    assert.throws(
      () => receipts.reserve({ ...launch, alias: path.join(aliasDirectory, 'dispatch', 'report.md') }),
      /private dispatch/,
    );
  } finally {
    temporary.mockRestore();
    syncBuiltinESMExports();
    fs.unlinkSync(aliasDirectory);
  }
});

test.each(['darwin', 'linux', 'win32'] as const)(
  'canonical /tmp admission retains independent %s expectations with configured temp elsewhere',
  (platform) => {
    const stat = fs.lstatSync;
    const realpath = fs.realpathSync.native;
    vi.spyOn(os, 'tmpdir').mockReturnValue(platform === 'win32' ? 'C:\\ConfiguredTemp' : '/configured/temp');
    vi.spyOn(fs, 'lstatSync').mockImplementation(((file: any, options: any) => {
      if (String(file) === '/tmp') return { isSymbolicLink: () => true };
      if (String(file).startsWith('/tmp/')) return { isSymbolicLink: () => String(file).includes('redirected') };
      if (String(file) === 'C:\\tmp') return { isSymbolicLink: () => true };
      if (String(file) === 'C:\\tmp\\reports') return { isSymbolicLink: () => false };
      return stat(file, options);
    }) as typeof fs.lstatSync);
    vi.spyOn(fs.realpathSync, 'native').mockImplementation((file) =>
      String(file) === '/tmp' ? '/private/tmp' : realpath(file),
    );
    syncBuiltinESMExports();
    if (platform === 'darwin') {
      assert.doesNotThrow(() => safeDispatchPath('/tmp/reports', platform));
      assert.throws(() => safeDispatchPath('/tmp/redirected', platform), /redirected/);
      vi.spyOn(fs.realpathSync, 'native').mockReturnValue('/mutable/elsewhere');
      assert.throws(() => safeDispatchPath('/tmp/reports', platform), /redirected/);
    } else
      assert.throws(
        () => safeDispatchPath(platform === 'win32' ? 'C:\\tmp\\reports' : '/tmp/reports', platform),
        /redirected/,
      );
  },
);
