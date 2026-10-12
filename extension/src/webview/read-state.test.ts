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
