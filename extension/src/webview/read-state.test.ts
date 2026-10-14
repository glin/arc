import { test } from 'vitest';
import assert from 'node:assert';
import { createReadState, type ReadCard } from './read-state.ts';
import { READ_LIMIT } from '../domain/read.ts';
import { parseReadSynchronization, parseReaderOperation } from './protocol.ts';

test('host read synchronization rejects older revisions without saving agent membership as reader marks', () => {
  let saves = 0;
  const turn = { ...card('s:10'), promptId: 'p10' };
  const state = createReadState({
    initial: {},
    open: new Set(),
    cards: () => [turn],
    newestTurnAt: () => 10,
    save: () => {
      saves++;
    },
    refreshSelection: () => {},
  });
  const update = { revision: 2, read: [], readTo: {}, since: 0, agentRead: [['s:10', 'p10']] as [string, string][] };
  assert.equal(state.synchronize(parseReadSynchronization(update)!), true);
  assert.equal(state.isRead(turn), true);
  assert.equal(state.isRead({ ...turn, promptId: 'different' }), false);
  assert.equal(state.synchronize({ ...update, revision: 1, agentRead: [] }), false);
  assert.equal(state.isRead(turn), true);
  assert.equal(state.synchronize({ ...update, revision: 3, agentRead: [] }), true);
  assert.equal(state.isRead(turn), false);
  assert.equal(saves, 0);
  assert.equal(state.snapshot().read.size, 0);
  assert.equal(parseReadSynchronization({ ...update, revision: NaN }), null);
  assert.equal(parseReadSynchronization({ ...update, agentRead: ['s:10'] }), null);
  assert.equal(parseReaderOperation({ id: 'unsafe', observedRevision: 0, action: 'acknowledge', records: [] }), null);
});

function card(key: string, sessionId = 's', startedAt = 10): ReadCard {
  return { key, sessionId, startedAt, kind: 'turn' };
}

test('automatic card marks wait for acceptance and stop after subscriber repaint', () => {
  const turn = { ...card('s:10'), promptId: 'prompt' };
  const operations: any[] = [];
  const state = createReadState({
    initial: {},
    open: new Set([turn.key]),
    cards: () => [turn],
    newestTurnAt: () => 10,
    save() {},
    refreshSelection() {},
    operate: (operation) => {
      operations.push(operation);
      state.admit(operation.id, true);
    },
  });
  state.synchronize({ revision: 0, read: [], readTo: {}, since: 0, agentRead: [] });
  state.subscribe(() => {
    state.mark(turn.key);
  });
  assert.equal(state.mark(turn.key), true);
  assert.equal(state.mark(turn.key), false);
  assert.equal(state.markMany([turn.key, turn.key]), false);
  state.synchronize({ revision: 1, read: [turn.key], readTo: {}, since: 0, agentRead: [] });
  assert.equal(operations.length, 1);
  state.set(turn.key, false);
  state.mark(turn.key);
  assert.equal(operations.length, 2);
  state.set(turn.key, true);
  assert.equal(operations.length, 3);
  assert.equal(operations[1].read, false);
  assert.equal(operations[2].read, true);
  state.synchronize({ revision: 2, read: [], readTo: {}, since: 0, agentRead: [] });
  state.setSession('s', true);
  const submitted = operations.length;
  assert.equal(state.mark(turn.key), false);
  assert.equal(operations.length, submitted);
  state.dispose();
});

test('session unread closes and saves disclosure before synchronized cards repaint', () => {
  const turns = [card('s:10'), card('s:20', 's', 20), card('other:10', 'other')];
  const open = new Set(turns.map((turn) => turn.key));
  const events: string[] = [];
  const state = createReadState({
    initial: {},
    open,
    cards: () => turns,
    newestTurnAt: () => 20,
    save: () => events.push('save'),
    refreshSelection: () => events.push('selection'),
    operate: (operation) => {
      assert.deepEqual([...open], ['other:10']);
      events.push('operation');
      state.admit(operation.id, true);
    },
  });
  state.synchronize({ revision: 1, read: [], readTo: { s: 20 }, since: 0, agentRead: [] });
  state.subscribe(() => {
    for (const turn of turns) if (open.has(turn.key)) state.mark(turn.key);
  });
  state.setSession('s', false);
  assert.deepEqual(events, ['selection', 'save', 'operation']);
  state.synchronize({ revision: 2, read: [], readTo: { s: 0, other: 10 }, since: 0, agentRead: [] });
  assert.equal(state.isRead(turns[0]), false);
  assert.equal(state.isRead(turns[1]), false);
  assert.equal(events.length, 3);
  state.dispose();
});

test('turn unread closes the expanded latest turn before host synchronization and automatic repaint', () => {
  const turns = [card('s:20', 's', 20), card('s:10'), card('other:10', 'other')];
  const open = new Set(turns.map((turn) => turn.key));
  const events: string[] = [];
  const operations: any[] = [];
  const state = createReadState({
    initial: {},
    open,
    cards: () => turns,
    newestTurnAt: () => 20,
    save: () => events.push('save'),
    refreshSelection: () => events.push('selection'),
    operate: (operation) => {
      events.push('operation');
      operations.push(operation);
      state.admit(operation.id, true);
    },
  });
  try {
    state.synchronize({ revision: 1, read: turns.map((turn) => turn.key), readTo: {}, since: 0, agentRead: [] });
    state.subscribe(() => {
      for (const turn of turns) if (open.has(turn.key)) state.mark(turn.key);
    });
    state.set(turns[0].key, false);
    assert.deepEqual([...open], ['s:10', 'other:10']);
    assert.deepEqual(events, ['selection', 'save', 'operation']);
    const unread = { revision: 2, read: ['s:10', 'other:10'], readTo: {}, since: 0, agentRead: [] };
    state.synchronize(unread);
    state.synchronize({ ...unread, revision: 3 });
    assert.equal(state.isRead(turns[0]), false);
    assert.equal(operations.length, 1);
    assert.equal(operations[0].read, false);
    open.add(turns[0].key);
    assert.equal(state.mark(turns[0].key), true);
    assert.equal(operations.length, 2);
    assert.equal(operations[1].read, true);
  } finally {
    state.dispose();
  }
});

test('opening an agent acknowledged turn still establishes the reader mark', () => {
  const turn = { ...card('s:10'), promptId: 'prompt' };
  const operations: any[] = [];
  const state = createReadState({
    initial: {},
    open: new Set(),
    cards: () => [turn],
    newestTurnAt: () => 10,
    save() {},
    refreshSelection() {},
    operate: (operation) => {
      operations.push(operation);
      state.admit(operation.id, true);
    },
  });
  state.synchronize({ revision: 1, read: [], readTo: {}, since: 0, agentRead: [[turn.key, turn.promptId]] });
  assert.equal(state.isRead(turn), true);
  assert.equal(state.mark(turn.key), true);
  state.synchronize({ revision: 2, read: [turn.key], readTo: {}, since: 0, agentRead: [[turn.key, turn.promptId]] });
  assert.equal(state.mark(turn.key), false);
  assert.equal(operations.length, 1);
  state.dispose();
});

test('ordinary browser delivery bounds queued payloads and preserves the next sequence after overflow', () => {
  const cards = Array.from({ length: 257 }, (_, index) => card(`s:${index + 1}`, 's', index + 1));
  const sent: any[] = [];
  const owner = createReadState({
    initial: {},
    open: new Set(),
    cards: () => cards,
    newestTurnAt: () => 257,
    save() {},
    refreshSelection() {},
    operate: (event) => sent.push(event),
  });
  try {
    owner.synchronize({ revision: 0, read: [], readTo: {}, since: 0, agentRead: [] });
    for (const card of cards.slice(0, 256)) assert.equal(owner.mark(card.key), true);
    assert.equal(owner.mark(cards[256].key), false);
    assert.equal(sent.length, 1);
    for (let index = 0; index < 256; index++) owner.admit(sent[index].id, true);
    assert.equal(sent.length, 256);
    assert.equal(owner.mark(cards[256].key), true);
    assert.equal(sent[256].id, `${owner.pageId}:257`);
  } finally {
    owner.dispose();
  }
});

test('equal accepted revisions update source projection without changing reader state', () => {
  const turn = { ...card('s:10'), promptId: 'prompt' };
  const state = createReadState({
    initial: {},
    open: new Set(),
    cards: () => [turn],
    newestTurnAt: () => 10,
    save() {},
    refreshSelection() {},
  });
  const accepted = { revision: 1, read: [], readTo: {}, since: 0, agentRead: [] as [string, string][] };
  state.synchronize(accepted);
  assert.equal(state.synchronize({ ...accepted, agentRead: [[turn.key, turn.promptId]] }), true);
  assert.equal(state.isRead(turn), true);
  assert.equal(state.synchronize({ ...accepted, read: [turn.key] }), false);
});

test('bulk reads save and notify once without changing watermarks or neighbours', () => {
  let saves = 0;
  let notices = 0;
  const cards = [card('s:1'), card('s:2'), card('other:1', 'other')];
  const state = createReadState({
    initial: { read: ['other:1'], readTo: { other: 7 }, since: 3 },
    open: new Set(),
    cards: () => cards,
    newestTurnAt: () => 10,
    save: () => {
      saves += 1;
    },
    refreshSelection: () => {},
  });
  state.subscribe(() => {
    notices += 1;
  });
  assert.equal(state.markMany(['s:1', 's:2', 's:1']), true);
  assert.deepEqual([saves, notices], [1, 1]);
  assert.deepEqual([...state.snapshot().read], ['other:1', 's:2', 's:1']);
  assert.deepEqual([...state.snapshot().readTo], [['other', 7]]);
  assert.equal(state.snapshot().since, 3);
  assert.equal(state.isRead(cards[2]), true);
  assert.equal(state.markMany([]), false);
  assert.equal(state.markMany(['s:2', 's:1']), false);
  assert.deepEqual([saves, notices], [1, 1]);
  state.mark('s:3');
  assert.deepEqual([saves, notices], [2, 2]);
});

test('bulk reads retain the single-mark duplicate and read-limit ordering', () => {
  const make = () =>
    createReadState({
      initial: {},
      open: new Set(),
      cards: () => [],
      newestTurnAt: () => null,
      save: () => {},
      refreshSelection: () => {},
    });
  const single = make();
  const bulk = make();
  const keys = Array.from({ length: READ_LIMIT + 2 }, (_, index) => `s:${index}`);
  keys.push('s:1', 's:2', 's:1');
  for (const key of keys) {
    single.mark(key);
  }
  bulk.markMany(keys);
  assert.deepEqual([...bulk.snapshot().read], [...single.snapshot().read]);
  assert.equal(bulk.snapshot().read.size, READ_LIMIT);
});

test('read state saves and notifies once for each effective turn change', () => {
  const cards = [card('s:1')];
  const open = new Set(['s:1']);
  let saves = 0;
  let notices = 0;
  const state = createReadState({
    initial: {},
    open,
    cards: () => cards,
    newestTurnAt: () => 10,
    save: () => {
      saves += 1;
    },
    refreshSelection: () => {},
  });
  state.subscribe(() => {
    notices += 1;
  });

  assert.equal(state.mark('s:1'), true);
  assert.equal(state.mark('s:1'), false);
  assert.deepEqual([saves, notices], [1, 1]);

  state.toggle(cards[0]);
  assert.equal(state.isRead(cards[0]), false);
  assert.equal(open.has('s:1'), false);
  assert.deepEqual([saves, notices], [2, 2]);
});

test('session read state uses its newest timestamp and preserves neighbours', () => {
  const cards = [card('s:1', 's', 10), card('s:2', 's', 20), card('other:1', 'other', 30)];
  const state = createReadState({
    initial: {},
    open: new Set(cards.map((item) => item.key)),
    cards: () => cards,
    newestTurnAt: (session) => (session === 's' ? 20 : 30),
    save: () => {},
    refreshSelection: () => {},
  });

  state.setSession('s', true);
  assert.equal(state.isRead(cards[0]), true);
  assert.equal(state.isRead(cards[1]), true);
  assert.equal(state.isRead(cards[2]), false);

  state.toggle(cards[0]);
  assert.equal(state.isRead(cards[0]), false);
  assert.equal(state.isRead(cards[1]), true);

  state.setSession('s', false);
  assert.equal(state.isRead(cards[1]), false);
});
