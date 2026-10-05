import { test } from 'vitest';
import assert from 'node:assert';
import { readMovedOnlyFor } from './read.ts';

const before = { read: ['a:1', 'b:2'], readTo: { a: 1, b: 2 } };

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
