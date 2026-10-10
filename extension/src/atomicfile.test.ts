import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tempDir } from './temproot.ts';
import * as path from 'node:path';
import { test, vi } from 'vitest';
import {
  STREAMED_WRITE_UNITS,
  temporaryIsStale,
  writeFileAtomically,
  writeFileStreamAtomically,
} from './atomicfile.ts';

const dir = () => tempDir('atomic-file-');

test('a temporary is stale only when its writer is gone', () => {
  const running = (pid: number) => pid === 4242;
  const name = 'abc.json';
  const old = 1_000_000;
  assert.equal(temporaryIsStale(`${name}.${process.pid}.1.tmp`, name, process.pid, old, running), true);
  assert.equal(
    temporaryIsStale(`${name}.4242.1.tmp`, name, process.pid, old, running),
    false,
    'another editor window is still writing that one',
  );
  assert.equal(temporaryIsStale(`${name}.4243.1.tmp`, name, process.pid, old, running), true);
  assert.equal(
    temporaryIsStale(`${name}.4243.999999.tmp`, name, process.pid, old, running),
    false,
    'a name younger than the grace period can belong to a writer that just started',
  );
  assert.equal(
    temporaryIsStale('other.json.4243.1.tmp', name, process.pid, old, running),
    false,
    'a temporary for another target belongs to another store',
  );
  assert.equal(temporaryIsStale(name, name, process.pid, old, running), false);
});

test('a write replaces the target and leaves nothing beside it', () => {
  const target = path.join(dir(), 'nested', 'store.json');
  writeFileAtomically(target, 'first');
  writeFileAtomically(target, 'second');
  assert.equal(fs.readFileSync(target, 'utf8'), 'second');
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['store.json']);
});

test('a write clears the temporaries an earlier write in this process left behind', () => {
  const folder = dir();
  const target = path.join(folder, 'store.json');
  for (const at of [1, 2, 3]) {
    fs.writeFileSync(`${target}.${process.pid}.${at}.tmp`, '');
  }
  const young = `store.json.4242.${Date.now()}.tmp`;
  fs.writeFileSync(path.join(folder, young), '');
  writeFileAtomically(target, 'text');
  assert.deepEqual(
    fs.readdirSync(folder).filter((entry) => entry.endsWith('.tmp')),
    [young],
    'a temporary younger than the grace period is left for the writer that may still hold it',
  );
});

test('a write that cannot finish keeps the old target and leaves no temporary', () => {
  const folder = dir();
  const target = path.join(folder, 'store.json');
  writeFileAtomically(target, 'first');
  let temporary = '';
  assert.throws(
    () =>
      writeFileAtomically(target, 'second', (from) => {
        temporary = from;
        throw new Error('replacement failed');
      }),
    /replacement failed/,
  );
  assert.equal(fs.readFileSync(target, 'utf8'), 'first');
  assert.equal(fs.existsSync(temporary), false);
  assert.deepEqual(fs.readdirSync(folder), ['store.json']);
});

// Runs a streamed write that must fail, checks the target, the folder, and the temporary's descriptor,
// and returns the failure.
function failedStreamedWrite(write: (target: string) => void): string {
  const folder = dir();
  const target = path.join(folder, 'store.json');
  writeFileAtomically(target, 'first');
  const opened = vi.spyOn(fs, 'openSync');
  const closed = vi.spyOn(fs, 'closeSync');
  let failure = '';
  try {
    try {
      write(target);
    } catch (error) {
      failure = String(error);
    }
    assert.notEqual(failure, '', 'the streamed write did not fail');
    const descriptor = opened.mock.results[0]?.value;
    assert.equal(typeof descriptor, 'number', 'the write opened no temporary');
    assert.ok(
      closed.mock.calls.some(([closing]) => closing === descriptor),
      'the failed write left the temporary open',
    );
  } finally {
    opened.mockRestore();
    closed.mockRestore();
  }
  assert.equal(fs.readFileSync(target, 'utf8'), 'first');
  assert.deepEqual(fs.readdirSync(folder), ['store.json']);
  return failure;
}

test('a streamed write that fails after writing part of the text keeps the old target', () => {
  const real = fs.writeSync;
  let writes = 0;
  const spy = vi.spyOn(fs, 'writeSync').mockImplementation((...args: Parameters<typeof fs.writeSync>) => {
    if (++writes > 1) throw new Error('disk full');
    return (real as (...values: unknown[]) => number)(...args);
  });
  try {
    const failure = failedStreamedWrite((target) =>
      writeFileStreamAtomically(target, (write) => {
        write('a'.repeat(STREAMED_WRITE_UNITS));
        write('b'.repeat(STREAMED_WRITE_UNITS));
      }),
    );
    assert.match(failure, /disk full/);
    assert.equal(writes, 2, 'the first batch never reached the temporary');
  } finally {
    spy.mockRestore();
  }
});

test('a streamed write whose producer throws keeps the old target', () => {
  const failure = failedStreamedWrite((target) =>
    writeFileStreamAtomically(target, (write) => {
      write('a'.repeat(STREAMED_WRITE_UNITS + 1));
      throw new Error('producer failed');
    }),
  );
  assert.match(failure, /producer failed/);
});

test('a streamed write whose replacement fails keeps the old target', () => {
  const failure = failedStreamedWrite((target) =>
    writeFileStreamAtomically(
      target,
      (write) => write('second'),
      () => {
        throw new Error('replacement failed');
      },
    ),
  );
  assert.match(failure, /replacement failed/);
});
