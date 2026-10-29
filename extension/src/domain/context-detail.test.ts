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
import {
  attachmentKinds,
  checkClaudeContextReply,
  contextFixtureNames,
  contextFixtureReply,
  projectFolderNames,
  removeCreatedProjectFolders,
  scrubContextReply,
  type ClaudeContextFixture,
  type FolderSystem,
} from './claude-context-check';

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
    { ...messages(), unattributedTokens: 1001 },
    { ...messages(), attachmentsByType: null },
    { ...messages(), attachmentsByType: [{ name: 'file', tokens: 3999 }] },
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

const fixtures = path.join(__dirname, '../../test/fixtures');
const usage = (name: string): ClaudeContextFixture => JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));

test('Claude Code 2.1.310 Messages drops attachments that repeat a category and leaves the rest unattributed', () => {
  const { claudeCode, reply } = usage('claude-context-usage-2.1.310.json');
  assert.equal(claudeCode, '2.1.310');
  const detail = normalizeContext(reply, identity);
  assert.equal(detail.status, 'available');
  assert.deepEqual(Object.fromEntries(detail.messageBreakdown?.map((row) => [row.key, row.tokens]) ?? []), {
    toolCallTokens: 49,
    toolResultTokens: 26,
    attachmentTokens: 3259,
    assistantMessageTokens: 283,
    userMessageTokens: 25,
    redirectedContextTokens: 0,
    unattributedTokens: 6187,
  });
  assert.equal(
    detail.messageBreakdown?.reduce((sum, row) => sum + row.tokens, 0),
    detail.categories.find((row) => row.key === 'Messages')?.tokens,
  );
  assert.equal(validContextDetail(detail), true);
  const categories = reply.categories as { name: string; tokens: number }[];
  const fields = reply.messageBreakdown as Record<string, unknown>;
  const kinds = fields.attachmentsByType as { name: string; tokens: number }[];
  const memory = categories.find((row) => row.name === 'Memory files')!.tokens;
  const withMessages = (tokens: number, listed = categories) => ({
    ...reply,
    totalTokens: (reply.totalTokens as number) - 9829 + tokens,
    categories: listed.map((row) => (row.name === 'Messages' ? { ...row, tokens } : row)),
  });
  const withKinds = (attachmentsByType: unknown) => ({ ...reply, messageBreakdown: { ...fields, attachmentsByType } });
  const filler = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ name: `filler_${index}`, tokens: 0 }));
  const parts = (changed: unknown) =>
    Object.fromEntries(normalizeContext(changed, identity).messageBreakdown?.map((row) => [row.key, row.tokens]) ?? []);
  // Raw parts that already sum to Messages keep Claude's figures.
  const exact = parts(withMessages(41823));
  assert.deepEqual([exact.attachmentTokens, exact.unattributedTokens], [41440, 0]);
  // A reply without Memory files keeps the CLAUDE.md text in Attachments.
  const unlisted = parts({
    ...withMessages(
      9829 + memory,
      categories.filter((row) => row.name !== 'Memory files'),
    ),
    totalTokens: reply.totalTokens,
  });
  assert.equal(unlisted.attachmentTokens, 3259 + 6762);
  assert.equal(parts(withKinds([...kinds, ...filler(64 - kinds.length)])).attachmentTokens, 3259);
  for (const changed of [
    withMessages(350),
    withKinds(kinds.slice(1)),
    withKinds([...kinds, kinds[0]]),
    withKinds([...kinds, { name: kinds[0].name, tokens: 0 }]),
    withKinds([...kinds, ...filler(65 - kinds.length)]),
    { ...reply, messageBreakdown: Object.fromEntries(Object.keys(messages()).map((key) => [key, 0])) },
  ]) {
    const refused = normalizeContext(changed, identity);
    assert.equal(refused.status, 'available');
    assert.equal(refused.messageBreakdown, undefined);
  }
});

test('stored Claude context replies pass the release check that a fresh reply runs', () => {
  const names = contextFixtureNames(fs.readdirSync(fixtures));
  assert.ok(names.includes('claude-context-usage-2.1.310.json'));
  const stored = names.map(usage);
  const known = new Set(stored.flatMap(({ reply }) => attachmentKinds(reply)));
  for (const { claudeCode, reply } of stored) {
    const check = checkClaudeContextReply(reply, known);
    assert.deepEqual(
      [claudeCode, check.failures, check.newAttachmentKinds, check.newMessageKeys],
      [claudeCode, [], [], []],
    );
    assert.deepEqual(scrubContextReply({ ...reply, path: 'C:/private' }, reply), reply);
  }
  const fresh = { ...stored[0].reply, messageBreakdown: { attachmentsByType: [{ name: 'new_kind', tokens: 1 }] } };
  const check = checkClaudeContextReply(fresh, known);
  assert.equal(check.failures.length, 2);
  assert.deepEqual(check.newAttachmentKinds, ['new_kind']);
  const template = stored[0].reply;
  const fields = template.messageBreakdown as Record<string, unknown>;
  const added = { ...template, path: 'C:/private', messageBreakdown: { ...fields, skillTokens: 12 } };
  assert.deepEqual(checkClaudeContextReply(added, known).newMessageKeys, ['skillTokens']);
  assert.deepEqual(contextFixtureReply(added, template), { ...template, messageBreakdown: added.messageBreakdown });
});

test('the release check removes only an empty project folder that its capture created', () => {
  // A simulated filesystem with each platform's case rule. Every reached path must be a fixture path.
  const simulate = (platform: string, tree: Record<string, 'dir' | 'link'>) => {
    const fold = (target: string) => (platform === 'linux' ? target : target.toLowerCase());
    const separator = platform === 'win32' ? '\\' : '/';
    const nodes = new Map(Object.entries(tree).map(([target, kind]) => [fold(target), { target, kind }]));
    const unmapped: string[] = [];
    const parent = (target: string) => target.slice(0, target.lastIndexOf(separator));
    const children = (target: string) =>
      [...nodes.values()]
        .filter((node) => fold(parent(node.target)) === fold(target))
        .map((node) => node.target.slice(node.target.lastIndexOf(separator) + 1));
    const directory = (target: string) => nodes.get(fold(target))?.kind === 'dir';
    const folders: FolderSystem = {
      lstat: (target) => {
        const node = nodes.get(fold(target));
        if (!node) unmapped.push(target);
        return node ? { isDirectory: () => node.kind === 'dir' } : null;
      },
      readdir: (target) => {
        if (!directory(target)) throw new Error(`Read outside a fixture directory: ${target}`);
        return children(target);
      },
      rmdir: (target) => {
        if (!directory(target) || children(target).length)
          throw new Error(`Removed a full or absent folder: ${target}`);
        nodes.delete(fold(target));
      },
    };
    return { folders, unmapped, remaining: () => [...nodes.values()].map((node) => node.target).sort() };
  };
  const platforms = {
    win32: { root: 'C:\\Users\\Ann\\.claude\\projects', slug: 'C--Tmp-Arc-X', variant: 'c--tmp-arc-x' },
    darwin: { root: '/Users/Ann/.claude/projects', slug: '-Tmp-Arc-X', variant: '-tmp-arc-x' },
    linux: { root: '/home/Ann/.claude/projects', slug: '-Tmp-Arc-X', variant: '-tmp-arc-x' },
  };
  // The folder names each platform removes, and the folder names it keeps for their content.
  const expected: Record<keyof typeof platforms, Record<string, [string[], string[]]>> = {
    win32: {
      exact: [['C--Tmp-Arc-X'], []],
      mixedCase: [['c--tmp-arc-x'], []],
      existing: [[], []],
      linkedChild: [[], ['C--Tmp-Arc-X']],
      linkedProjects: [[], []],
    },
    darwin: {
      exact: [['-Tmp-Arc-X'], []],
      mixedCase: [['-tmp-arc-x'], []],
      existing: [[], []],
      linkedChild: [[], ['-Tmp-Arc-X']],
      linkedProjects: [[], []],
    },
    linux: {
      exact: [['-Tmp-Arc-X'], []],
      mixedCase: [[], []],
      existing: [[], []],
      linkedChild: [[], ['-Tmp-Arc-X']],
      linkedProjects: [[], []],
    },
  };
  for (const [platform, { root, slug, variant }] of Object.entries(platforms)) {
    const separator = platform === 'win32' ? '\\' : '/';
    const at = (...names: string[]) => [root, ...names].join(separator);
    const scenes: Record<string, { tree: Record<string, 'dir' | 'link'>; before: boolean }> = {
      exact: { tree: { [root]: 'dir', [at(slug)]: 'dir', [at(slug, 'memory')]: 'dir' }, before: false },
      mixedCase: { tree: { [root]: 'dir', [at(variant)]: 'dir', [at(variant, 'memory')]: 'dir' }, before: false },
      existing: { tree: { [root]: 'dir', [at(slug)]: 'dir', [at(slug, 'memory')]: 'dir' }, before: true },
      linkedChild: { tree: { [root]: 'dir', [at(slug)]: 'dir', [at(slug, 'memory')]: 'link' }, before: false },
      linkedProjects: { tree: { [root]: 'link' }, before: false },
    };
    for (const [scene, { tree, before }] of Object.entries(scenes)) {
      const { folders, unmapped, remaining } = simulate(platform, tree);
      const existing = before ? projectFolderNames(folders, root, slug, platform) : [];
      const result = removeCreatedProjectFolders(folders, root, slug, platform, existing);
      const [removed, kept] = expected[platform as keyof typeof platforms][scene];
      const label = `${platform} ${scene}`;
      assert.deepEqual(result, { removed: removed.map((name) => at(name)), kept: kept.map((name) => at(name)) }, label);
      const gone = new Set(removed.flatMap((name) => [at(name), at(name, 'memory')]));
      assert.deepEqual(
        remaining(),
        Object.keys(tree)
          .filter((target) => !gone.has(target))
          .sort(),
        label,
      );
      assert.deepEqual(unmapped, [], label);
    }
  }
});

test('Claude no-source reason belongs only to unavailable Claude detail', () => {
  const detail = { ...unavailableContext(identity), reason: 'claude-no-live-session' };
  assert.equal(validContextDetail(detail), true);
  assert.equal(validContextDetail({ ...detail, provider: 'codex' }), false);
  for (const status of ['loading', 'available', 'mismatch', 'stale'])
    assert.equal(validContextDetail({ ...detail, status }), false);
  for (const reason of ['unknown', '', null, ['claude-no-live-session']])
    assert.equal(validContextDetail({ ...detail, reason }), false);
  const codex = { ...identity, provider: 'codex' as const };
  assert.equal(
    normalizeContext(
      { kind: 'codex-context-unavailable', session: 's1', model: identity.model, reason: detail.reason },
      codex,
    ).reason,
    undefined,
  );
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
