import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { tempDir } from './temproot';
import { DispatchReceipts, type DispatchEvent } from './dispatchreceipts';
import { HostedDispatch, type SavedDispatchResponse } from './dispatchhost';
import { payloadSha256 } from './sessionwrites';
import type { NativeEvent } from './agentwire';

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
});
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
  fs.writeFileSync(alias, 'Changed');
  const changed = receipts.refresh(launch.launchId)!;
  assert.notEqual(changed.eventId, first.eventId);
  assert.equal(receipts.status(launch.launchId).events.at(-1)!.consumption.disposition, undefined);
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
