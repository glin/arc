import { test } from 'vitest';
import assert from 'node:assert';
import { readMovedOnlyFor } from './read.ts';
import {
  normalizeAgentRead,
  projectAgentRead,
  OrderedReadOperations,
  HostReadPersistence,
  ReadPersistenceUnknownError,
  preserveHostRead,
  READ_LIMIT,
  type AgentReadRecord,
  type AgentReadSource,
} from './read.ts';

const acknowledgment: AgentReadRecord = {
  provider: 'codex',
  sessionId: 'session',
  source: 'path-identity',
  scope: 'scope',
  sourceRevision: 'revision',
  promptId: 'prompt',
  startedAt: 10,
};
const sourceFacts = (record: AgentReadRecord): AgentReadSource => ({
  ...record,
  identitiesComplete: true,
  turns: [{ promptId: record.promptId, startedAt: record.startedAt, finished: true }],
});

test('agent acknowledgments retain full identities and reject replacement or colliding work after restoration', () => {
  const restored = normalizeAgentRead(JSON.parse(JSON.stringify([acknowledgment, { sessionId: 'incomplete' }])));
  assert.deepEqual(restored, [acknowledgment]);
  assert.equal(projectAgentRead(restored, sourceFacts).get('session:10'), 'prompt');
  for (const difference of [
    { sourceRevision: 'appended' },
    { source: 'replacement' },
    { scope: 'other' },
    { provider: 'claude' as const },
    { identitiesComplete: false },
  ])
    assert.equal(projectAgentRead(restored, (record) => ({ ...sourceFacts(record), ...difference })).size, 0);
  assert.equal(projectAgentRead(restored, () => null).size, 0);
  assert.equal(
    projectAgentRead(restored, (record) => ({
      ...sourceFacts(record),
      turns: [...sourceFacts(record).turns, { promptId: record.promptId, startedAt: 20, finished: true }],
    })).size,
    0,
  );
  assert.equal(
    projectAgentRead(restored, (record) => ({
      ...sourceFacts(record),
      turns: [{ promptId: 'different', startedAt: 10, finished: true }],
    })).size,
    0,
  );
  assert.equal(
    projectAgentRead(restored, (record) => ({
      ...sourceFacts(record),
      turns: [...sourceFacts(record).turns, { promptId: 'collision', startedAt: 10, finished: false }],
    })).size,
    0,
  );
  const overflow = normalizeAgentRead(
    Array.from({ length: READ_LIMIT + 2 }, (_, index) => ({
      ...acknowledgment,
      promptId: `prompt-${index}`,
      startedAt: index + 1,
    })),
  );
  assert.equal(overflow.length, READ_LIMIT);
  assert.equal(overflow[0].startedAt, 3);
});

test('ordered read removals survive stale operations and settled persistence failure', async () => {
  const initial = { revision: 0, read: [], readTo: {}, since: 0, agentRead: [] };
  const store = new OrderedReadOperations(initial);
  const published: number[] = [];
  let release!: () => void;
  const suspended = new Promise<void>((resolve) => {
    release = resolve;
  });
  const publish = (state: { revision: number }) => {
    published.push(state.revision);
  };
  const first = store.run(
    { id: 'ack', observedRevision: 0, action: 'acknowledge', records: [acknowledgment] },
    sourceFacts,
    async () => suspended,
    publish,
  );
  const remove = { id: 'remove', observedRevision: 0, action: 'turn' as const, target: acknowledgment, read: false };
  const second = store.run(remove, sourceFacts, async () => {}, publish);
  await Promise.resolve();
  assert.deepEqual(published, []);
  assert.equal(store.snapshot().revision, 0);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(published, [1, 2]);
  assert.deepEqual(store.snapshot().agentRead, []);
  await store.run(
    { id: 'again', observedRevision: 0, action: 'acknowledge', records: [acknowledgment] },
    sourceFacts,
    async () => {},
    publish,
  );
  await store.run(
    remove,
    sourceFacts,
    async () => {
      assert.fail('retried removal persisted again');
    },
    publish,
  );
  assert.equal(store.snapshot().agentRead.length, 1);
  await assert.rejects(
    store.run(
      { id: 'fail', observedRevision: 0, action: 'reset', since: 0 },
      sourceFacts,
      async () => {
        throw new Error('storage failed');
      },
      publish,
    ),
    /storage failed/,
  );
  assert.equal(store.snapshot().revision, 3);
  const other = { ...acknowledgment, sessionId: 'other' };
  await Promise.all(
    [acknowledgment, other].map((target, index) =>
      store.run(
        { id: `independent-${index}`, observedRevision: 0, action: 'turn', target, read: true },
        sourceFacts,
        async () => {},
        publish,
      ),
    ),
  );
  assert.deepEqual(store.snapshot().read, ['session:10', 'other:10']);
  await store.run(
    { id: 'obsolete', observedRevision: 0, action: 'turn', target: acknowledgment, read: false },
    () => null,
    async () => {
      assert.fail('obsolete identity persisted');
    },
    publish,
  );
  assert.equal(store.snapshot().read.length, 2);
  const preserved = preserveHostRead(
    { ...store.snapshot(), readRevision: 5, filter: 'old' },
    { ...initial, agentRead: [acknowledgment], readRevision: 0, filter: 'new' },
  );
  assert.equal(preserved.filter, 'new');
  assert.equal(preserved.readRevision, 5);
  assert.deepEqual(preserved.read, store.snapshot().read);
});

test('session unread, source invalidation, and reset remove only their acknowledged work', async () => {
  const other = { ...acknowledgment, sessionId: 'other', startedAt: 20 };
  const store = new OrderedReadOperations({
    revision: 0,
    read: ['session:10', 'other:20'],
    readTo: { session: 10, other: 20 },
    since: 0,
    agentRead: [acknowledgment, other],
  });
  const published: number[] = [];
  const persist = async () => {};
  const publish = (state: { revision: number }) => {
    published.push(state.revision);
  };
  await store.run(
    { id: 'session-unread', observedRevision: 0, action: 'session', target: acknowledgment, newestAt: 10, read: false },
    sourceFacts,
    persist,
    publish,
  );
  assert.deepEqual(store.snapshot().agentRead, [other]);
  assert.deepEqual(store.snapshot().read, ['other:20']);
  assert.deepEqual(store.snapshot().readTo, { session: 0, other: 20 });
  await store.run(
    { id: 'invalidate', observedRevision: 0, action: 'invalidate' },
    (record) => ({ ...sourceFacts(record), sourceRevision: 'changed' }),
    persist,
    publish,
  );
  assert.deepEqual(store.snapshot().agentRead, []);
  assert.deepEqual(store.snapshot().read, ['other:20']);
  await store.run(
    { id: 'restore-acknowledgment', observedRevision: 0, action: 'acknowledge', records: [other] },
    sourceFacts,
    persist,
    publish,
  );
  await store.run({ id: 'reset', observedRevision: 0, action: 'reset', since: 42 }, sourceFacts, persist, publish);
  assert.deepEqual(store.snapshot(), { revision: 4, read: [], readTo: {}, since: 42, agentRead: [] });
  assert.deepEqual(published, [1, 2, 3, 4]);
});

const before = { read: ['a:1', 'b:2'], readTo: { a: 1, b: 2 } };

test('manual reader actions retain unfinished and incomplete-window admission', async () => {
  const owner = new OrderedReadOperations({ revision: 0, read: [], readTo: {}, since: 0, agentRead: [] });
  const unfinished = (record: AgentReadRecord) => ({
    ...sourceFacts(record),
    turns: [{ promptId: record.promptId, startedAt: record.startedAt, finished: false }],
  });
  assert.deepEqual(
    await owner.run(
      { id: 'unfinished', action: 'turn', observedRevision: 0, target: acknowledgment, read: true },
      unfinished,
      async () => {},
      () => {},
    ),
    { revision: 1 },
  );
  assert.equal(
    await owner.run(
      { id: 'agent-unfinished', action: 'acknowledge', observedRevision: 0, records: [acknowledgment] },
      unfinished,
      async () => {},
      () => {},
    ),
    null,
  );
  await owner.run(
    {
      id: 'partial-session',
      action: 'session',
      observedRevision: 0,
      target: { sessionId: 'partial', startedAt: 12 },
      read: true,
      newestAt: 20,
    },
    () => null,
    async () => {},
    () => {},
    (operation) => operation.target.sessionId === 'partial',
  );
  assert.deepEqual(owner.snapshot().read, ['session:10']);
  assert.deepEqual(owner.snapshot().readTo, { partial: 20 });
  assert.equal(owner.snapshot().revision, 2);
});

test('targeted stale reader removal preserves colliding acknowledgment and reset retries preserve later work', async () => {
  const collision = { ...acknowledgment, source: 'other-source' };
  const owner = new OrderedReadOperations({ revision: 0, read: [], readTo: {}, since: 0, agentRead: [] });
  const persist = async () => {};
  const publish = () => {};
  await owner.run(
    { id: 'ack', action: 'acknowledge', observedRevision: 0, records: [acknowledgment, collision] },
    sourceFacts,
    persist,
    publish,
  );
  await owner.run(
    { id: 'remove', action: 'turn', observedRevision: 0, target: acknowledgment, read: false },
    sourceFacts,
    persist,
    publish,
  );
  assert.deepEqual(owner.snapshot().agentRead, [collision]);
  const reset = { id: 'reset-once', action: 'reset' as const, observedRevision: 0, since: 42 };
  await owner.run(reset, sourceFacts, persist, publish);
  await owner.run(
    { id: 'later-ack', action: 'acknowledge', observedRevision: 0, records: [acknowledgment] },
    sourceFacts,
    persist,
    publish,
  );
  assert.deepEqual(await owner.run(reset, sourceFacts, persist, publish), { revision: 3 });
  assert.deepEqual(owner.snapshot().agentRead, [acknowledgment]);
  assert.equal(owner.snapshot().revision, 4);
});

test('read retry bindings separate namespaces freeze payloads and never evict accepted IDs', async () => {
  const bounded = new OrderedReadOperations({ revision: 0, read: [], readTo: {}, since: 0, agentRead: [] }, 1);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const suspended = bounded.serialize(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
        entered();
      }),
  );
  await started;
  const excess = bounded.serialize(async () => {});
  release();
  await assert.rejects(excess, /save limit/);
  await suspended;
  const owner = new OrderedReadOperations({ revision: 0, read: [], readTo: {}, since: 0, agentRead: [] }, 2);
  const operation = {
    id: 'same',
    namespace: 'browser' as const,
    action: 'reset' as const,
    observedRevision: 0,
    since: 1,
  };
  const browser = owner.run(
    operation,
    sourceFacts,
    async () => {},
    () => {},
  );
  operation.since = 99;
  await browser;
  assert.equal(owner.snapshot().since, 1);
  await owner.run(
    { ...operation, since: 2, namespace: 'cli' },
    sourceFacts,
    async () => {},
    () => {},
  );
  await assert.rejects(
    owner.run(
      operation,
      sourceFacts,
      async () => {},
      () => {},
    ),
    /different action/,
  );
  await assert.rejects(
    owner.run(
      { ...operation, id: 'overflow' },
      sourceFacts,
      async () => {},
      () => {},
    ),
    /limit/,
  );
  assert.deepEqual(
    await owner.run(
      { ...operation, since: 1 },
      sourceFacts,
      async () => assert.fail('retry wrote'),
      () => {},
    ),
    { revision: 1 },
  );
  assert.equal(owner.snapshot().since, 2);
});

test('source invalidation preserves unknown mappings until current facts prove removal', async () => {
  const other = { ...acknowledgment, sessionId: 'other' };
  const owner = new OrderedReadOperations({
    revision: 0,
    read: [],
    readTo: {},
    since: 0,
    agentRead: [acknowledgment, other],
  });
  await owner.run(
    { id: 'uncertain', action: 'invalidate', observedRevision: 0 },
    (record) =>
      record.sessionId === 'other' ? { ...sourceFacts(record), identitiesComplete: false, turns: [] } : null,
    async () => {},
    () => {},
  );
  assert.deepEqual(owner.snapshot().agentRead, [acknowledgment, other]);
  await owner.run(
    { id: 'changed', action: 'invalidate', observedRevision: 0 },
    (record) =>
      record.sessionId === 'other'
        ? { ...sourceFacts(record), sourceRevision: 'changed', identitiesComplete: false }
        : null,
    async () => {},
    () => {},
  );
  assert.deepEqual(owner.snapshot().agentRead, [acknowledgment]);
});

test('host persistence suspends preference writes and publishes only settled latest read state', async () => {
  const initial = {
    read: [] as string[],
    readTo: {},
    since: 0,
    agentRead: [] as AgentReadRecord[],
    readRevision: 0,
    filter: 'old',
  };
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const suspended = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writes: (typeof initial)[] = [];
  const publications: (typeof initial)[] = [];
  const owner = new HostReadPersistence(
    initial,
    async (state) => {
      writes.push(structuredClone(state));
      if (writes.length === 1) {
        entered();
        await suspended;
      }
    },
    (state) => {
      publications.push(state);
    },
  );
  const first = owner.read(
    { id: 'ack', action: 'acknowledge', observedRevision: 0, records: [acknowledgment] },
    sourceFacts,
  );
  const remove = owner.read(
    { id: 'unread', action: 'turn', observedRevision: 0, target: acknowledgment, read: false },
    sourceFacts,
  );
  const preferences = owner.savePreferences({
    ...initial,
    filter: 'new',
    agentRead: [acknowledgment],
    readRevision: 0,
  });
  await started;
  assert.equal(writes.length, 1);
  assert.deepEqual(publications, []);
  assert.deepEqual(owner.snapshot(), initial);
  release();
  await Promise.all([first, remove, preferences]);
  assert.deepEqual(
    writes.map((state) => state.readRevision),
    [1, 2, 2],
  );
  assert.deepEqual(writes[2].agentRead, []);
  assert.deepEqual(
    publications.map((state) => state.readRevision),
    [1, 2, 2],
  );
  assert.equal(owner.snapshot().filter, 'new');
  assert.deepEqual(owner.snapshot().agentRead, []);
});

test('host persistence failure restores accepted state and unknown settlement blocks later writes', async () => {
  const initial = { read: [], readTo: {}, since: 0, agentRead: [acknowledgment], readRevision: 4, filter: 'old' };
  let writes = 0;
  const published: number[] = [];
  const owner = new HostReadPersistence(
    initial,
    async (state) => {
      writes++;
      if (writes === 1) {
        state.agentRead.length = 0;
        return { status: 'failed' };
      }
      if (writes === 3) {
        state.agentRead.length = 0;
        return { status: 'unknown' };
      }
      return { status: 'saved' };
    },
    (state) => {
      published.push(state.readRevision);
    },
  );
  await assert.rejects(
    owner.read({ id: 'failed', action: 'reset', observedRevision: 4, since: 1 }, sourceFacts),
    /could not be saved/,
  );
  assert.deepEqual(owner.snapshot(), initial);
  await owner.savePreferences({ ...initial, filter: 'accepted' });
  assert.deepEqual(owner.snapshot().agentRead, [acknowledgment]);
  const accepted = owner.snapshot();
  await assert.rejects(
    owner.read({ id: 'unknown', action: 'reset', observedRevision: 4, since: 2 }, sourceFacts),
    ReadPersistenceUnknownError,
  );
  assert.deepEqual(owner.snapshot(), accepted);
  await assert.rejects(owner.savePreferences({ ...initial, filter: 'later' }), ReadPersistenceUnknownError);
  assert.equal(writes, 3);
  assert.deepEqual(published, [4]);
});

test('host publication settlement blocks later storage and retains accepted state after publication failure', async () => {
  const initial = { read: [], readTo: {}, since: 0, agentRead: [] as AgentReadRecord[], readRevision: 0 };
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writes = 0;
  let publications = 0;
  const owner = new HostReadPersistence(
    initial,
    async () => {
      writes++;
    },
    async () => {
      publications++;
      if (publications === 1) {
        entered();
        await held;
        throw new Error('publication failed');
      }
    },
  );
  const first = owner.read(
    { id: 'ack', action: 'acknowledge', observedRevision: 0, records: [acknowledgment] },
    sourceFacts,
  );
  const failed = assert.rejects(first, /could not be published/);
  const later = owner.read(
    { id: 'remove', action: 'turn', observedRevision: 0, target: acknowledgment, read: false },
    sourceFacts,
  );
  await started;
  assert.equal(writes, 1);
  assert.equal(owner.snapshot().readRevision, 1);
  release();
  await failed;
  await later;
  assert.equal(writes, 2);
  assert.equal(owner.snapshot().readRevision, 2);
  assert.deepEqual(owner.snapshot().agentRead, []);
});

test('a save that moves one session alone is told from one that moves the rest', () => {
  assert.equal(
    readMovedOnlyFor('a', before, {
      read: ['a:1', 'a:3', 'b:2'],
      readTo: { a: 3, b: 2 },
    }),
    true,
  );
  assert.equal(
    readMovedOnlyFor('a', before, {
      read: ['a:1', 'b:2', 'b:4'],
      readTo: { a: 1, b: 4 },
    }),
    false,
    'a turn read on another card rides out on the card the reader opened',
  );
  assert.equal(
    readMovedOnlyFor('a', before, { read: ['a:1', 'b:2'], readTo: { a: 1 } }),
    false,
    'another card losing its watermark reads as the opened card moving alone',
  );
  assert.equal(
    readMovedOnlyFor('a', before, { read: ['b:2'], readTo: { b: 2 } }),
    true,
    'the opened card giving up its own keys counts as a change elsewhere',
  );
  assert.equal(readMovedOnlyFor(null, before, before), false, 'a save with no card open claims to have moved one');
});

test('an empty read list is a state like any other', () => {
  const none = { read: [], readTo: {} };
  assert.equal(readMovedOnlyFor('a', none, { read: ['a:1'], readTo: { a: 1 } }), true);
  assert.equal(readMovedOnlyFor('a', none, { read: ['b:1'], readTo: { b: 1 } }), false);
  assert.equal(
    readMovedOnlyFor('a', before, none),
    false,
    'every other card losing its read keys passes as one card moving',
  );
});

test('a session id that carries a colon keeps its own read keys', () => {
  const nested = { read: ['a:b:1', 'a:9'], readTo: { 'a:b': 1, a: 9 } };
  assert.equal(
    readMovedOnlyFor('a:b', nested, {
      read: ['a:b:1', 'a:b:3', 'a:9'],
      readTo: { 'a:b': 3, a: 9 },
    }),
    true,
  );
  assert.equal(
    readMovedOnlyFor('a:b', nested, {
      read: ['a:b:1', 'a:9', 'a:11'],
      readTo: { 'a:b': 1, a: 11 },
    }),
    false,
    'the session whose id is a prefix of another loses its own moves to it',
  );
});
