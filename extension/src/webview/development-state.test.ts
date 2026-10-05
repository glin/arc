import assert from 'node:assert';
import { test } from 'vitest';
import {
  createDevelopmentScrollRestorer,
  markDevelopmentReload,
  takeDevelopmentReload,
  type DevelopmentStorage,
} from './development-state.ts';

function scrollHarness(readyAt: number) {
  let frame = 0;
  let position = 0;
  let writes = 0;
  let callbacks: Array<() => void> = [];
  let restorer: ReturnType<typeof createDevelopmentScrollRestorer>;
  restorer = createDevelopmentScrollRestorer(420, {
    position: () => position,
    restore(top) {
      writes += 1;
      restorer.readerScrolled();
      if (frame >= readyAt) {
        position = top;
      }
    },
    frame(callback) {
      callbacks.push(callback);
    },
  });
  return {
    restorer,
    tick() {
      frame += 1;
      const pending = callbacks;
      callbacks = [];
      for (const callback of pending) {
        callback();
      }
    },
    setPosition(value: number) {
      position = value;
    },
    read: () => ({ frame, position, writes }),
  };
}

function memoryStorage(): DevelopmentStorage {
  const values = new Map<string, string>();
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

test('a development reload carries scroll once into the replacement lifetime', () => {
  const storage = memoryStorage();
  markDevelopmentReload(storage, 317.5);
  assert.deepEqual(takeDevelopmentReload(storage), { preferBrowserState: true, scrollTop: 317.5 });
  assert.deepEqual(takeDevelopmentReload(storage), { preferBrowserState: false, scrollTop: null });
});

test('a server-restart reload prefers browser state even when no scroll value survived', () => {
  const storage = memoryStorage();
  storage.setItem('arc.development.reload', 'true');
  assert.deepEqual(takeDevelopmentReload(storage), { preferBrowserState: true, scrollTop: null });
  assert.deepEqual(takeDevelopmentReload(storage), { preferBrowserState: false, scrollTop: null });
});

test('invalid saved scroll state is discarded without changing reload preference', () => {
  const storage = memoryStorage();
  storage.setItem('arc.development.reload', 'true');
  storage.setItem('arc.development.scroll', '{');
  assert.deepEqual(takeDevelopmentReload(storage), { preferBrowserState: true, scrollTop: null });
});

test('scroll restoration waits through a delayed initial render and layout beyond 120 frames', () => {
  const harness = scrollHarness(280);
  for (let frame = 0; frame < 150; frame += 1) {
    harness.tick();
  }
  assert.deepEqual(harness.read(), { frame: 150, position: 0, writes: 0 });

  harness.restorer.afterHostMessage({ type: 'render' });
  for (let frame = 0; frame < 180 && harness.read().position !== 420; frame += 1) {
    harness.tick();
  }
  assert.equal(harness.read().position, 420);
  assert.ok(harness.read().frame >= 280);
});

test('a reader scroll cancels a pending development scroll restoration', () => {
  const harness = scrollHarness(Number.POSITIVE_INFINITY);
  harness.restorer.afterHostMessage({ type: 'render' });
  harness.tick();
  harness.tick();
  assert.equal(harness.read().writes, 1);

  harness.setPosition(65);
  harness.restorer.readerScrolled();
  for (let frame = 0; frame < 20; frame += 1) {
    harness.tick();
  }
  assert.deepEqual(harness.read(), { frame: 22, position: 65, writes: 1 });
});
