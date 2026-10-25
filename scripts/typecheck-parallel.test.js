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

test('cancellation escalates owned children and removes its timer after close', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const signals = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === 'SIGKILL') child.emit('close', null, signal);
  };
  try {
    const pending = runChecks([fakeCheck('cancelled', 0)], {
      spawnFn: () => child,
      signal: controller.signal,
      log: () => {},
      logError: () => {},
    });
    controller.abort();
    assert.deepEqual(signals, ['SIGTERM']);
    await vi.advanceTimersByTimeAsync(5000);
    assert.deepEqual(await pending, ['cancelled']);
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    vi.useRealTimers();
  }
});

test('cancellation terminates owned process trees on Windows, macOS, and Linux', async () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const controller = new AbortController();
    const calls = [];
    const child = new EventEmitter();
    child.pid = 77;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const pending = runChecks([fakeCheck('owned tree', 0)], {
      platform,
      signal: controller.signal,
      log: () => {},
      logError: () => {},
      spawnFn: (_command, _args, options) => {
        assert.equal(options.detached, platform !== 'win32');
        return child;
      },
      killWindowsTree: (pid) => {
        calls.push(['windows', pid]);
        child.emit('close', null, 'SIGTERM');
        return true;
      },
      killGroup: (pid, signal) => {
        calls.push(['group', pid, signal]);
        child.emit('close', null, signal);
      },
    });
    controller.abort();
    assert.deepEqual(await pending, ['owned tree']);
    assert.deepEqual(
      calls,
      platform === 'win32'
        ? [['windows', 77]]
        : [
            ['group', -77, 'SIGTERM'],
            ['group', -77, 'SIGKILL'],
          ],
    );
  }
});

test('child cancellation retires Unix descendants before inherited output pipes close', async () => {
  for (const platform of ['darwin', 'linux']) {
    for (const [code, signal] of [
      [null, 'SIGTERM'],
      [130, null],
    ]) {
      const calls = [];
      const child = new EventEmitter();
      child.pid = 77;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      let settled = false;
      let result;
      const pending = runChecks([fakeCheck('cancelled', 0)], {
        platform,
        spawnFn: () => child,
        log: () => {},
        logError: () => {},
        killGroup: (pid, sent) => calls.push([pid, sent]),
        onResult: (value) => {
          result = value;
          settled = true;
        },
      });
      child.emit('exit', code, signal);
      assert.deepEqual(calls, [[-77, 'SIGKILL']]);
      await Promise.resolve();
      assert.equal(settled, false);
      child.stdout.emit('data', Buffer.from('retained descendant output'));
      child.emit('close', code, signal);
      assert.deepEqual(await pending, ['cancelled']);
      assert.equal(result.output, 'retained descendant output');
      assert.deepEqual(calls, [[-77, 'SIGKILL']]);
    }
  }
});
