const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { runChecks } = require('./typecheck-parallel.js');

// Tests that start real processes run in the test:subprocess lane.
const SUBPROCESS = { tags: ['subprocess'] };

// A check that exits with the given code and prints a line naming itself, so a test can tell
// which fake check actually ran from the captured output.
function fakeCheck(label, exitCode) {
  return {
    label,
    args: ['-e', `console.log('${label} ran'); process.exitCode = ${exitCode};`],
    cwd: __dirname,
  };
}

test('a failing check fails the run and names itself', SUBPROCESS, async () => {
  const lines = [];
  const errorLines = [];
  const failed = await runChecks([fakeCheck('ok check', 0), fakeCheck('broken check', 1)], {
    log: (line) => lines.push(line),
    logError: (line) => errorLines.push(line),
  });

  assert.deepEqual(failed, ['broken check']);
  assert.ok(lines.some((line) => line.includes('ok check ran')));
  assert.ok(lines.some((line) => line.includes('broken check ran')));
  assert.ok(errorLines.some((line) => line.includes('broken check')));
});

test('every check runs even when an earlier one fails', SUBPROCESS, async () => {
  const lines = [];
  const failed = await runChecks([fakeCheck('first', 1), fakeCheck('second', 0), fakeCheck('third', 1)], {
    log: (line) => lines.push(line),
    logError: () => {},
  });

  assert.deepEqual(failed, ['first', 'third']);
  assert.ok(lines.some((line) => line.includes('second ran')));
});

test('a check that never starts counts as failed', async () => {
  const errorLines = [];
  const failed = await runChecks([fakeCheck('exploded check', 0)], {
    spawnFn: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')));
      return child;
    },
    log: () => {},
    logError: (line) => errorLines.push(line),
  });

  assert.deepEqual(failed, ['exploded check']);
  assert.ok(errorLines.some((line) => line.includes('exploded check')));
});

test('parallel checks keep output grouped until every check finishes', async () => {
  const children = [];
  const lines = [];
  const errors = [];
  const pending = runChecks([fakeCheck('first', 0), fakeCheck('second', 1)], {
    spawnFn: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      children.push(child);
      return child;
    },
    log: (line) => lines.push(line),
    logError: (line) => errors.push(line),
    write: () => assert.fail('Parallel stdout escaped its group'),
    writeError: () => assert.fail('Parallel stderr escaped its group'),
  });
  assert.equal(children.length, 2);
  children[1].stderr.emit('data', Buffer.from('second stderr\n'));
  children[1].emit('close', 1);
  await Promise.resolve();
  assert.deepEqual(lines, []);
  children[0].stdout.emit('data', Buffer.from('first stdout\n'));
  children[0].emit('close', 0);
  assert.deepEqual(await pending, ['second']);
  assert.deepEqual(lines, ['--- first (passed) ---', 'first stdout', '--- second (failed) ---', 'second stderr']);
  assert.deepEqual(errors, ['\nChecks failed: second']);
});

test('a run with no failing checks reports none', SUBPROCESS, async () => {
  const failed = await runChecks([fakeCheck('a', 0), fakeCheck('b', 0)], {
    log: () => {},
    logError: () => {},
  });

  assert.deepEqual(failed, []);
});
