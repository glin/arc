import assert from 'node:assert';
import { test } from 'vitest';
import { queueLiveKey } from './queue-live.ts';

test('a live key scopes a live kind to its session', () => {
  assert.equal(queueLiveKey('session-a', 'prompt'), queueLiveKey('session-a', 'prompt'));
  assert.notEqual(queueLiveKey('session-a', 'prompt'), queueLiveKey('session-b', 'prompt'));
  assert.notEqual(queueLiveKey('session-a', 'prompt'), queueLiveKey('session-a', 'compact'));
});
