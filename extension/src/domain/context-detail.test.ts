import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { codexContextRecords } from '../turnfixtures';
import { estimateCodexContext } from '../codexcontext';
import {
  ContextDemand,
  normalizeContext,
  validContextDetail,
  contextShare,
  unavailableContext,
  type ContextIdentity,
} from './context-detail';

const identity: ContextIdentity = {
  session: 's1',
  provider: 'claude',
  model: 'host-alias',
  source: 'child',
  request: 1,
  generation: 1,
};
const native = () => ({
  totalTokens: 118000,
  rawMaxTokens: 200000,
  model: 'opaque-native-model',
  categories: [
    { name: 'Messages', kind: 'used', tokens: 104000 },
    { name: 'System tools', kind: 'used', tokens: 14000 },
    { name: 'Free space', kind: 'free', tokens: 72000 },
    { name: 'Reserve', kind: 'buffer', tokens: 10000 },
    { name: 'Deferred tools', kind: 'deferred', tokens: 900000 },
  ],
});

const messages = () => ({
  toolCallTokens: 15000,
  toolResultTokens: 50000,
  attachmentTokens: 4000,
  assistantMessageTokens: 20000,
  userMessageTokens: 10000,
  redirectedContextTokens: 4000,
  unattributedTokens: 1000,
});

test('native summary records zero message fields without inventing an absent Messages parent', () => {
  const raw = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../test/fixtures/claude-context-summary.json'), 'utf8'),
  );
  assert.equal(Object.values(raw.messageBreakdown).filter((value) => value === 0).length, 7);
  const detail = normalizeContext(raw, identity);
  assert.equal(detail.status, 'available');
  assert.equal(detail.messageBreakdown, undefined);
  assert.equal(validContextDetail(detail), true);
});

test('Messages detail partitions its parent, includes redirected tokens and keeps the occupied denominator', () => {
  const detail = normalizeContext(
    { ...native(), messageBreakdown: { ...messages(), toolCallsByType: Array(1000).fill({}) } },
    identity,
  );
  assert.equal(detail.used, 118000);
  assert.equal(
    detail.categories.reduce((sum, row) => sum + row.tokens, 0),
    118000,
  );
  assert.equal(detail.messageBreakdown?.length, 7);
  assert.equal(
    detail.messageBreakdown?.reduce((sum, row) => sum + row.tokens, 0),
    104000,
  );
  assert.equal(detail.messageBreakdown?.find((row) => row.key === 'redirectedContextTokens')?.tokens, 4000);
  assert.equal(validContextDetail(detail), true);
  assert.ok(JSON.stringify(detail).length < 2048);
  const zero = normalizeContext(
    { ...native(), messageBreakdown: { ...messages(), redirectedContextTokens: 0, unattributedTokens: 5000 } },
    identity,
  );
  assert.equal(zero.messageBreakdown?.find((row) => row.key === 'redirectedContextTokens')?.tokens, 0);
  assert.equal(validContextDetail(zero), true);
});

test('optional Messages failures leave honest categories available instead of hiding or inventing tokens', () => {
  for (const messageBreakdown of [
    undefined,
    null,
    [],
    {},
    { ...messages(), toolCallTokens: undefined },
    { ...messages(), toolCallTokens: -1 },
    { ...messages(), toolCallTokens: 1.1 },
    { ...messages(), toolCallTokens: '15000' },
    { ...messages(), toolCallTokens: Number.MAX_SAFE_INTEGER },
    { ...messages(), redirectedContextTokens: 0 },
    { ...messages(), unattributedTokens: 999 },
  ]) {
    const detail = normalizeContext({ ...native(), messageBreakdown }, identity);
    assert.equal(detail.status, 'available');
    assert.equal(detail.used, 118000);
    assert.equal(detail.messageBreakdown, undefined);
    assert.equal(validContextDetail(detail), true);
  }
  const detail = normalizeContext({ ...native(), messageBreakdown: messages() }, identity);
  for (const messageBreakdown of [
    [],
    Array(33).fill(detail.messageBreakdown![0]),
    detail.messageBreakdown!.slice(1),
    detail.messageBreakdown!.map((row) => ({ ...row, key: 'other' })),
    detail.messageBreakdown!.map((row) => ({ ...row, tokens: row.tokens + 1 })),
    detail.messageBreakdown!.map((row) => ({ ...row, name: 'x'.repeat(32769) })),
  ])
    assert.equal(validContextDetail({ ...detail, messageBreakdown }), false);
  assert.equal(validContextDetail({ ...detail, provider: 'codex' }), false);
});

test('Codex unavailable reasons stay bounded and recover from the same context demand', async () => {
  const codex = { ...identity, provider: 'codex' as const, model: 'gpt-6.1-sol' };
  const demand = new ContextDemand();
  for (const reason of ['pending-tools', 'awaiting-measurement']) {
    const raw = { kind: 'codex-context-unavailable', session: 's1', model: codex.model, reason };
    const detail = await demand.read(
      codex,
      'same',
      async () => raw,
      () => true,
    );
    assert.equal(detail.status, 'unavailable');
    assert.equal(detail.reason, reason);
    assert.equal(validContextDetail(detail), true);
    assert.equal(detail.used, null);
    assert.deepEqual(detail.categories, []);
    const recovered = await demand.read(
      codex,
      'same',
      async () => estimateCodexContext(codexContextRecords(), 's1'),
      () => true,
    );
    assert.equal(recovered.status, 'available');
    assert.equal(recovered.reason, undefined);
    demand.invalidate();
    for (const invalid of [
      { reason: 'unknown' },
      { reason: ['pending-tools'] },
      { session: 'foreign' },
      { model: 'different' },
    ])
      assert.equal(normalizeContext({ ...raw, ...invalid }, codex).reason, undefined);
  }
  for (const invalid of [
    { ...unavailableContext(codex), reason: 'unknown' },
    { ...unavailableContext(identity), reason: 'pending-tools' },
    { ...unavailableContext(codex, 'loading'), reason: 'pending-tools' },
    { ...normalizeContext(estimateCodexContext(codexContextRecords(), 's1'), codex), reason: 'pending-tools' },
  ])
    assert.equal(validContextDetail(invalid), false);
});

test('Codex retained-context estimates keep local provenance, unknown shares and independent native validation', () => {
  const codex = { ...identity, provider: 'codex' as const, model: 'gpt-6.1-sol' };
  const estimate = estimateCodexContext(codexContextRecords(), 's1')!;
  const detail = normalizeContext(estimate, codex, 123);
  assert.equal(detail.status, 'available');
  assert.equal(detail.measurement, 'local-estimate');
  assert.equal(detail.reserve, null);
  assert.equal(validContextDetail(detail), true);
  assert.equal(normalizeContext(estimate, identity).status, 'unavailable');
  assert.equal(normalizeContext(estimate, { ...codex, session: 'other' }).status, 'unavailable');
  assert.equal(normalizeContext(estimate, { ...codex, model: 'different' }).status, 'unavailable');
  assert.equal(normalizeContext({ ...estimate, used: 1 }, codex).status, 'mismatch');
  assert.equal(normalizeContext({ ...estimate, categories: [null] }, codex).status, 'unavailable');
});

test('native used categories reconcile independently of free, reserve, deferred and child details', () => {
  const raw = { ...native(), memoryFiles: [{ tokens: 5000 }], colors: ['red'] };
  const detail = normalizeContext(raw, identity, 123);
  assert.equal(detail.status, 'available');
  assert.equal(detail.model, 'opaque-native-model');
  assert.equal(detail.used, 118000);
  assert.equal(detail.capacity, 200000);
  assert.equal(detail.remaining, 72000);
  assert.equal(detail.reserve, 10000);
  assert.equal(detail.categories.length, 2);
  assert.equal(validContextDetail(detail), true);
  assert.equal('memoryFiles' in detail, false);
});

test('mismatched totals and recorded zero remain distinct from unavailable categories', () => {
  const raw = native();
  raw.totalTokens = 220000;
  assert.equal(normalizeContext(raw, identity).status, 'mismatch');
  raw.totalTokens = 1;
  assert.equal(normalizeContext(raw, identity).status, 'mismatch');
  assert.equal(normalizeContext({ ...native(), totalTokens: 0, categories: [] }, identity).status, 'available');
  assert.equal(normalizeContext({ ...native(), categories: undefined }, identity).status, 'unavailable');
  assert.equal(normalizeContext(native(), { ...identity, provider: 'codex' }).status, 'unavailable');
});

test('malformed rows, duplicate identities and input bounds refuse the whole allocation', () => {
  const row = native().categories[0];
  for (const categories of [
    [row, row],
    [{ ...row, name: 'x'.repeat(257) }],
    Array.from({ length: 33 }, (_, i) => ({ ...row, name: String(i) })),
    [{ ...row, tokens: -1 }],
    [{ ...row, tokens: 1.1 }],
    [{ ...row, kind: undefined }],
    [{ ...row, kind: ['used'] }],
    [{ ...row, kind: { toString: null } }],
    [{ ...row, tokens: Number.MAX_SAFE_INTEGER + 1 }],
  ]) {
    assert.equal(normalizeContext({ ...native(), categories }, identity).status, 'unavailable');
  }
  assert.equal(validContextDetail({ ...normalizeContext(native(), identity), source: 'x'.repeat(257) }), false);
  assert.equal(validContextDetail({ ...normalizeContext(native(), identity), used: 1 }), false);
});

test('tiny shares and unavailable totals retain their distinct values', () => {
  assert.equal(contextShare(1, 1_000_000), '<0.01%');
  assert.equal(contextShare(10, 0), 'Unavailable');
});

test('demand shares concurrent reads and refuses responses after invalidation or source replacement', async () => {
  const demand = new ContextDemand();
  let reads = 0;
  let release!: (raw: unknown) => void;
  const read = () => {
    reads++;
    return new Promise<unknown>((resolve) => {
      release = resolve;
    });
  };
  const first = demand.read(identity, 'same', read, () => true);
  assert.equal(
    demand.read(identity, 'same', read, () => true),
    first,
  );
  await Promise.resolve();
  assert.equal(reads, 1);
  demand.invalidate();
  release(native());
  assert.equal((await first).status, 'stale');
  const second = demand.read(identity, 'next', read, () => false);
  await Promise.resolve();
  release(native());
  assert.equal((await second).status, 'stale');
  const reopened = demand.read(
    identity,
    'next',
    async () => native(),
    () => true,
  );
  assert.equal((await reopened).status, 'available');
});

test('failed context demand settles unavailable and permits a fresh opening', async () => {
  const demand = new ContextDemand();
  for (const read of [
    () => Promise.reject(new Error('closed')),
    () => {
      throw new Error('closed');
    },
  ]) {
    assert.equal((await demand.read(identity, 'same', read, () => true)).status, 'unavailable');
    assert.equal(
      (
        await demand.read(
          identity,
          'same',
          async () => native(),
          () => true,
        )
      ).status,
      'available',
    );
    demand.invalidate();
  }
});
