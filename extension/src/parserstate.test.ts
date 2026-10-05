import { test } from 'vitest';
import assert from 'node:assert';
import {
  RETAINED_REQUESTS,
  cloneParserState,
  retainedRequestEvents,
  withRetainedRequestEvents,
} from './parserstate.ts';

const keys = (count: number) => Array.from({ length: count }, (unused, at) => `claude:m${at}`);
const events = (names: readonly string[]) => Object.fromEntries(names.map((name) => [name, { output: name }]));

test('the retained window keeps the newest request keys and drops the rest', () => {
  const queue = keys(20);
  const kept = retainedRequestEvents(queue, events(queue));
  assert.deepEqual(Object.keys(kept), queue.slice(-RETAINED_REQUESTS));
});

test('a window already inside the limit is returned as it stands', () => {
  const queue = keys(RETAINED_REQUESTS);
  const held = events(queue);
  assert.equal(retainedRequestEvents(queue, held), held);
});

test('a chosen limit bounds the window instead of the shared one', () => {
  const queue = keys(20);
  assert.deepEqual(Object.keys(retainedRequestEvents(queue, events(queue), 3)), queue.slice(-3));
});

test('an empty queue names nothing to keep, so the window is left alone', () => {
  const held = events(keys(20));
  assert.equal(
    retainedRequestEvents([], held),
    held,
    'dropping every event would turn the next revision into a second request',
  );
});

test('a state without a window is returned unchanged', () => {
  const plain = { seenRequestKeys: keys(20), closedTurns: 2 };
  assert.equal(withRetainedRequestEvents(plain), plain);
  assert.equal(withRetainedRequestEvents(undefined), undefined);
  assert.equal(withRetainedRequestEvents('state'), 'state');
  const listed = { seenRequestKeys: keys(20), requestEvents: [1, 2] };
  assert.equal(withRetainedRequestEvents(listed), listed);
});

test('trimming a saved state bounds its window and leaves its queue alone', () => {
  const queue = keys(20);
  const state = { seenRequestKeys: queue, closedTurns: 2, requestEvents: events(queue) };
  const trimmed = withRetainedRequestEvents(state);

  assert.deepEqual(Object.keys(trimmed.requestEvents), queue.slice(-RETAINED_REQUESTS));
  assert.deepEqual(trimmed.seenRequestKeys, queue, 'the queue of counted requests is not the window');
  assert.equal(trimmed.closedTurns, 2);
  assert.equal(Object.keys(state.requestEvents).length, 20, 'the state handed over is not edited');
});

test('a cloned parser state answers size and membership on every set it holds', () => {
  // A Claude session state holds the commits it has seen as a set, and a nested usage state
  // holds the requests it has counted. A copy that is not a set throws on the first read.
  const state = { committed: new Set(['abc123']), usageState: { seenRequests: new Set(['claude:msg_1']) } };
  const copy = cloneParserState(state);

  assert.equal(copy.committed.size, 1);
  assert.equal(copy.committed.has('abc123'), true);
  assert.equal(copy.usageState.seenRequests.has('claude:msg_1'), true);
  copy.committed.add('def456');
  copy.usageState.seenRequests.add('claude:msg_2');
  assert.equal(state.committed.size, 1, 'the state handed over is not edited');
  assert.equal(state.usageState.seenRequests.size, 1, 'the state handed over is not edited');
});
