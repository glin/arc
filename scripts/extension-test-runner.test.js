const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

let runner;
let browserChannels;
let browserLock;
beforeAll(async () => {
  [runner, browserChannels, browserLock] = await Promise.all([
    import('../extension/test.mjs'),
    import('../extension/test/browserchannels.mjs'),
    import('../extension/test/browserlock.mjs'),
  ]);
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-test-runner-'));
  for (const file of [
    'src/store.test.ts',
    'src/panel.layout.test.ts',
    'src/panel.layout.rail.test.ts',
    'src/chrome.browser.test.ts',
    'src/webview/integration.browser.test.ts',
    'src/webview/panel.test.ts',
  ]) {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '');
  }
  return root;
}

function slotFixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'arc-browser-slots-test-'));
}

function readSlotOwner(root, index) {
  return JSON.parse(fs.readFileSync(path.join(root, `slot-${index}`, 'owner.json'), 'utf8'));
}

test('sixteen browser slots run at once and a seventeenth waits for one to close', async () => {
  assert.equal(browserChannels.BROWSER_SLOT_COUNT, 16);
  const root = slotFixture();
  const alive = new Set(Array.from({ length: 17 }, (_, index) => 101 + index));
  const permits = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (message) => logs.push(message);
  let clock = 10_000;
  let monotonicClock = 100;
  let seventeenth;
  try {
    for (let index = 1; index <= 16; index++) {
      permits.push(
        await browserChannels.acquireBrowserSlot({
          rootPath: root,
          pid: 100 + index,
          token: `owner-${index}`,
          now: () => clock,
          isProcessAlive: (pid) => alive.has(pid),
        }),
      );
    }
    seventeenth = await browserChannels.acquireBrowserSlot({
      rootPath: root,
      pid: 117,
      token: 'seventeenth',
      now: () => clock,
      monotonicNow: () => monotonicClock,
      isProcessAlive: (pid) => alive.has(pid),
      waitForPoll: async (milliseconds) => {
        assert.deepEqual(
          Array.from({ length: 16 }, (_, index) => readSlotOwner(root, index + 1).pid),
          Array.from({ length: 16 }, (_, index) => 101 + index),
        );
        assert.equal(permits[1].release(), true);
        alive.delete(102);
        clock -= 60_000;
        monotonicClock += milliseconds;
      },
    });
    assert.equal(seventeenth.index, 2);
    assert.deepEqual(readSlotOwner(root, 2), { pid: 117, token: 'seventeenth' });
    assert.deepEqual(logs, ['Browser launch waiting for one of 16 test slots.', 'Browser test slot wait: 500 ms.']);
  } finally {
    console.log = originalLog;
    seventeenth?.release();
    for (const permit of permits) permit.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a browser slot recovers a dead owner', async () => {
  const root = slotFixture();
  const slot = path.join(root, 'slot-1');
  fs.mkdirSync(slot);
  fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ pid: 303, token: 'dead' }));
  let permit;
  try {
    permit = await browserChannels.acquireBrowserSlot({
      rootPath: root,
      slotCount: 1,
      pid: 404,
      token: 'replacement',
      isProcessAlive: () => false,
    });
    assert.deepEqual(readSlotOwner(root, 1), { pid: 404, token: 'replacement' });
  } finally {
    permit?.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a browser slot recovers an abandoned stale-owner claim', async () => {
  const root = slotFixture();
  const slot = path.join(root, 'slot-1');
  fs.mkdirSync(slot);
  fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ pid: 313, token: 'dead' }));
  const claim = path.join(slot, '.claim-stale-dead');
  fs.mkdirSync(claim);
  let clock = fs.statSync(claim).mtimeMs;
  let polls = 0;
  let permit;
  try {
    permit = await browserChannels.acquireBrowserSlot({
      rootPath: root,
      slotCount: 1,
      pid: 414,
      token: 'replacement',
      now: () => clock,
      deadlineMs: 20,
      incompleteGraceMs: 5,
      pollMs: 5,
      isProcessAlive: () => false,
      waitForPoll: async (milliseconds) => {
        polls++;
        clock += milliseconds;
      },
    });
    assert.equal(polls, 1);
    assert.deepEqual(readSlotOwner(root, 1), { pid: 414, token: 'replacement' });
  } finally {
    permit?.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a browser slot gives an incomplete owner record a grace period', async () => {
  const root = slotFixture();
  const slot = path.join(root, 'slot-1');
  fs.mkdirSync(slot);
  let clock = fs.statSync(slot).mtimeMs;
  let polls = 0;
  let permit;
  try {
    permit = await browserChannels.acquireBrowserSlot({
      rootPath: root,
      slotCount: 1,
      pid: 707,
      token: 'after-grace',
      now: () => clock,
      incompleteGraceMs: 2_000,
      pollMs: 500,
      waitForPoll: async (milliseconds) => {
        polls++;
        clock += milliseconds;
      },
    });
    assert.equal(polls, 4);
    assert.deepEqual(readSlotOwner(root, 1), { pid: 707, token: 'after-grace' });
  } finally {
    permit?.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a stale browser-slot reclaimer cannot delete its replacement', async () => {
  const root = slotFixture();
  const slot = path.join(root, 'slot-1');
  fs.mkdirSync(slot);
  fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ pid: 818, token: 'old' }));
  try {
    const removed = browserChannels.removeBrowserSlotIfOwned(slot, 'old', () => {
      fs.rmSync(slot, { recursive: true, force: true });
      fs.mkdirSync(slot);
      fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ pid: 919, token: 'replacement' }));
    });
    assert.equal(removed, false);
    assert.deepEqual(readSlotOwner(root, 1), { pid: 919, token: 'replacement' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a launched browser releases its slot when it closes', async () => {
  let releases = 0;
  let closes = 0;
  const browser = {
    async close() {
      closes++;
    },
  };
  const result = await browserChannels.launchAnyBrowser({
    acquireSlot: async () => ({
      release: () => {
        releases++;
        return true;
      },
    }),
    loadChromium: async () => ({ launch: async () => browser }),
  });
  assert.equal(result.channel, 'msedge');
  assert.equal(releases, 0);
  await result.browser.close();
  await result.browser.close();
  assert.deepEqual({ closes, releases }, { closes: 1, releases: 1 });
});

test('failed browser channels release their slot', async () => {
  let releases = 0;
  let launches = 0;
  const result = await browserChannels.launchAnyBrowser({
    acquireSlot: async () => ({
      release: () => {
        releases++;
        return true;
      },
    }),
    loadChromium: async () => ({
      launch: async () => {
        launches++;
        throw new Error('unavailable');
      },
    }),
  });
  assert.equal(result, null);
  assert.deepEqual({ launches, releases }, { launches: 3, releases: 1 });
});

test('stalled browser channels reach an available fallback before the mockup test deadline', async () => {
  vi.useFakeTimers();
  let releases = 0;
  const channels = [];
  const browser = { close: async () => {} };
  try {
    const launched = browserChannels.launchAnyBrowser({
      acquireSlot: async () => ({
        release: () => {
          releases++;
          return true;
        },
      }),
      loadChromium: async () => ({
        launch: ({ channel, timeout = 180_000 }) => {
          channels.push(channel);
          if (!channel) return Promise.resolve(browser);
          return new Promise((_, reject) => {
            setTimeout(() => reject(new Error('browser did not start')), timeout);
          });
        },
      }),
    });
    let result;
    void launched.then((value) => {
      result = value;
    });
    await vi.advanceTimersByTimeAsync(30_000);
    assert.ok(result, 'stalled preferred channels prevented the available browser from launching');
    assert.deepEqual(channels, ['msedge', 'chrome', undefined]);
    assert.equal(result.browser, browser);
    assert.equal(releases, 0);
    await result.browser.close();
    assert.equal(releases, 1);
  } finally {
    vi.useRealTimers();
  }
});

function lockFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-browser-lock-test-'));
  return path.join(dir, 'arc-browser-tests.lock');
}

function readLockOwner(lockPath) {
  return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
}

test('a free browser lock is taken by the first run and released', async () => {
  const lockPath = lockFixture();
  try {
    const lock = await browserLock.acquireBrowserLock({
      lockPath,
      pid: 501,
      cwd: '/repo/worktree-a',
      now: () => 1_700_000_000_000,
    });
    assert.deepEqual(readLockOwner(lockPath), {
      pid: 501,
      cwd: '/repo/worktree-a',
      startedAt: new Date(1_700_000_000_000).toISOString(),
    });
    assert.equal(lock.release(), true);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(path.dirname(lockPath), { recursive: true, force: true });
  }
});

test('a browser lock waits for a live holder and proceeds once it releases', async () => {
  const lockPath = lockFixture();
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 601, cwd: '/repo/worktree-a', startedAt: 'earlier' }));
  const logs = [];
  const original = console.log;
  console.log = (message) => logs.push(message);
  try {
    let polls = 0;
    const lock = await browserLock.acquireBrowserLock({
      lockPath,
      pid: 602,
      cwd: '/repo/worktree-b',
      isProcessAlive: (pid) => pid === 601,
      waitForPoll: async () => {
        polls++;
        fs.rmSync(lockPath, { force: true });
      },
    });
    assert.equal(polls, 1);
    assert.equal(
      logs[0],
      'Browser tests are waiting for another run to finish: held by PID 601 in /repo/worktree-a (started earlier).',
    );
    assert.match(logs[1], /^Browser tests resumed after \d+ ms waiting\.$/);
    assert.equal(logs.length, 2);
    assert.equal(readLockOwner(lockPath).pid, 602);
    lock.release();
  } finally {
    console.log = original;
    fs.rmSync(path.dirname(lockPath), { recursive: true, force: true });
  }
});

test('a browser lock takes over a lock left by a dead process', async () => {
  const lockPath = lockFixture();
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 703, cwd: '/repo/worktree-a', startedAt: 'earlier' }));
  try {
    let polled = false;
    const lock = await browserLock.acquireBrowserLock({
      lockPath,
      pid: 704,
      isProcessAlive: () => false,
      waitForPoll: async () => {
        polled = true;
      },
    });
    assert.equal(polled, false);
    assert.equal(readLockOwner(lockPath).pid, 704);
    lock.release();
  } finally {
    fs.rmSync(path.dirname(lockPath), { recursive: true, force: true });
  }
});

test('a browser lock takes over an empty or corrupt lock file immediately', async () => {
  const lockPath = lockFixture();
  fs.writeFileSync(lockPath, '');
  try {
    let polled = false;
    const lock = await browserLock.acquireBrowserLock({
      lockPath,
      pid: 808,
      waitForPoll: async () => {
        polled = true;
      },
    });
    assert.equal(polled, false);
    assert.equal(readLockOwner(lockPath).pid, 808);
    lock.release();
  } finally {
    fs.rmSync(path.dirname(lockPath), { recursive: true, force: true });
  }
});

test('the owner record carries the time the lock was actually acquired, not when the wait began', async () => {
  const lockPath = lockFixture();
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 1101, cwd: '/repo/worktree-a', startedAt: 'earlier' }));
  const clockTicks = [1_000, 5_000];
  let tick = 0;
  try {
    const lock = await browserLock.acquireBrowserLock({
      lockPath,
      pid: 1102,
      now: () => clockTicks[tick],
      isProcessAlive: (pid) => pid === 1101,
      waitForPoll: async () => {
        tick++;
        fs.rmSync(lockPath, { force: true });
      },
    });
    assert.equal(readLockOwner(lockPath).startedAt, new Date(5_000).toISOString());
    lock.release();
  } finally {
    fs.rmSync(path.dirname(lockPath), { recursive: true, force: true });
  }
});

test('a lock heartbeat refreshes the file mtime only while this process still owns it', async () => {
  const lockPath = lockFixture();
  let tick;
  // The heartbeat's clock is injected, so the test sets the exact time each tick writes instead
  // of racing NTFS's sub-millisecond write-time precision against `Date.now`'s millisecond one.
  let clock = new Date('2024-01-01T00:00:00.000Z').getTime();
  try {
    const lock = await browserLock.acquireBrowserLock({
      lockPath,
      pid: 1201,
      now: () => clock,
      scheduleHeartbeat: (fn) => {
        tick = fn;
        return 'timer';
      },
      cancelHeartbeat: () => {},
    });
    const old = new Date('2020-01-01T00:00:00.000Z');
    fs.utimesSync(lockPath, old, old);

    clock = new Date('2024-06-01T00:00:00.000Z').getTime();
    tick();
    assert.equal(fs.statSync(lockPath).mtimeMs, clock);
    assert.ok(fs.statSync(lockPath).mtimeMs > old.getTime());

    // Once another owner holds the path, a heartbeat tick from the old owner must not touch it.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 1202, cwd: '/repo/worktree-b', startedAt: 'now' }));
    const untouched = fs.statSync(lockPath).mtimeMs;
    clock = new Date('2024-12-01T00:00:00.000Z').getTime();
    tick();
    assert.equal(fs.statSync(lockPath).mtimeMs, untouched);
    lock.release();
  } finally {
    fs.rmSync(path.dirname(lockPath), { recursive: true, force: true });
  }
});

test('a stale rename that keeps failing polls toward the deadline instead of spinning', async () => {
  const lockPath = lockFixture();
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 1801, cwd: '/repo/worktree-a', startedAt: 'earlier' }));
  let clock = 0;
  let polls = 0;
  try {
    await assert.rejects(
      browserLock.acquireBrowserLock({
        lockPath,
        pid: 1802,
        deadlineMs: 1_000,
        isProcessAlive: () => false,
        monotonicNow: () => clock,
        rename: () => {
          const error = new Error('resource busy or locked');
          error.code = 'EBUSY';
          throw error;
        },
        waitForPoll: async (milliseconds) => {
          polls++;
          clock += milliseconds;
        },
      }),
      /Timed out waiting for the browser test lock/,
    );
    // The failing rename never removes the lock, so a fix that retries at once instead of
    // polling would spin without ever calling waitForPoll and without ever reaching the
    // deadline check above.
    assert.ok(polls > 0);
  } finally {
    fs.rmSync(path.dirname(lockPath), { recursive: true, force: true });
  }
});

test('an empty lock file with a rename that keeps failing polls toward the deadline instead of throwing', async () => {
  const lockPath = lockFixture();
  fs.writeFileSync(lockPath, '');
  let clock = 0;
  let polls = 0;
  const logs = [];
  const originalLog = console.log;
  console.log = (message) => logs.push(message);
  try {
    await assert.rejects(
      browserLock.acquireBrowserLock({
        lockPath,
        pid: 1803,
        deadlineMs: 1_000,
        isProcessAlive: () => false,
        monotonicNow: () => clock,
        rename: () => {
          const error = new Error('resource busy or locked');
          error.code = 'EBUSY';
          throw error;
        },
        waitForPoll: async (milliseconds) => {
          polls++;
          clock += milliseconds;
        },
      }),
      /Timed out waiting for the browser test lock held by an unreadable lock record/,
    );
    assert.ok(polls > 0);
    assert.deepEqual(logs, ['Browser tests are waiting for another run to finish: held by an unreadable lock record.']);
  } finally {
    console.log = originalLog;
    fs.rmSync(path.dirname(lockPath), { recursive: true, force: true });
  }
});

test('a live-held lock is taken over only once this waiter has watched it sit unchanged for the whole stale age', async () => {
  const lockPath = lockFixture();
  // The mtime is already old by wall-clock time before this waiter ever looks at it. That alone
  // must not cause an immediate takeover: only this waiter's own sustained observation counts.
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 1301, cwd: '/repo/worktree-a', startedAt: 'earlier' }));
  const oldMtime = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(lockPath, oldMtime, oldMtime);
  let clock = 0;
  let polls = 0;
  try {
    const lock = await browserLock.acquireBrowserLock({
      lockPath,
      pid: 1302,
      staleAfterMs: 6_000,
      pollMs: 2_000,
      isProcessAlive: (pid) => pid === 1301,
      monotonicNow: () => clock,
      waitForPoll: async (milliseconds) => {
        polls++;
        clock += milliseconds;
      },
    });
    // The file's mtime never moves in this trace, so three full poll intervals on the waiter's
    // own monotonic clock (0 -> 2000 -> 4000 -> 6000) are what reach the stale age, not the
    // file's wall-clock age from before the waiter started watching.
    assert.equal(polls, 3);
    assert.equal(readLockOwner(lockPath).pid, 1302);
    lock.release();
  } finally {
    fs.rmSync(path.dirname(lockPath), { recursive: true, force: true });
  }
});

test('the stale observation step marks a live lock stale only after its mtime sits unchanged for the whole stale age', () => {
  const staleAfterMs = 6_000;
  const pollMs = 2_000;
  let observation = null;
  let clock = 0;
  const step = (mtime) => {
    const result = browserLock.forTesting.stepStaleObservation(
      observation,
      { pid: 1 },
      mtime,
      () => clock,
      () => true,
      staleAfterMs,
      pollMs,
    );
    observation = result.observation;
    return result.stale;
  };
  assert.equal(step(100), false); // just started watching
  clock = 2_000;
  assert.equal(step(100), false);
  clock = 4_000;
  assert.equal(step(100), false);
  clock = 6_000;
  assert.equal(step(100), true); // unchanged for the whole stale age now
});

test('a poll gap of more than five poll intervals restarts the stale observation instead of counting toward it', () => {
  const staleAfterMs = 6_000;
  const pollMs = 2_000;
  let observation = null;
  let clock = 0;
  const step = (mtime) => {
    const result = browserLock.forTesting.stepStaleObservation(
      observation,
      { pid: 1 },
      mtime,
      () => clock,
      () => true,
      staleAfterMs,
      pollMs,
    );
    observation = result.observation;
    return result.stale;
  };
  assert.equal(step(100), false);
  clock = 2_000;
  assert.equal(step(100), false); // 2000ms unchanged so far
  clock = 22_000; // a 20s gap between polls, more than five 2s poll intervals: the machine slept
  assert.equal(step(100), false); // the gap restarts the window instead of reading 22000ms as stale
  clock = 24_000;
  assert.equal(step(100), false); // only 2000ms into the restarted window
  clock = 28_000;
  assert.equal(step(100), true); // 6000ms unchanged since the restart
});

test('the mtime moving restarts the stale observation, the same as a heartbeat tick', () => {
  const staleAfterMs = 6_000;
  const pollMs = 2_000;
  let observation = null;
  let clock = 0;
  const step = (mtime) => {
    const result = browserLock.forTesting.stepStaleObservation(
      observation,
      { pid: 1 },
      mtime,
      () => clock,
      () => true,
      staleAfterMs,
      pollMs,
    );
    observation = result.observation;
    return result.stale;
  };
  assert.equal(step(100), false);
  clock = 4_000;
  assert.equal(step(100), false); // 4000ms unchanged, short of the 6000ms stale age
  clock = 5_000;
  assert.equal(step(200), false); // the mtime moved: a heartbeat tick, so the window restarts
  clock = 10_000;
  assert.equal(step(200), false); // only 5000ms unchanged since the restart
  clock = 11_000;
  assert.equal(step(200), true); // 6000ms unchanged since the restart
});

test('a dead or unparseable owner is stale at once, without any observation', () => {
  assert.equal(
    browserLock.forTesting.stepStaleObservation(
      null,
      null,
      100,
      () => 0,
      () => true,
      6_000,
      2_000,
    ).stale,
    true,
  );
  assert.equal(
    browserLock.forTesting.stepStaleObservation(
      null,
      { pid: 1 },
      100,
      () => 0,
      () => false,
      6_000,
      2_000,
    ).stale,
    true,
  );
});

test('a lock held by a live process within the stale age is not taken over', async () => {
  const lockPath = lockFixture();
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 1401, cwd: '/repo/worktree-a', startedAt: 'earlier' }));
  try {
    let polls = 0;
    const lock = await browserLock.acquireBrowserLock({
      lockPath,
      pid: 1402,
      staleAfterMs: 3 * 60_000,
      isProcessAlive: (pid) => pid === 1401,
      waitForPoll: async () => {
        polls++;
        fs.rmSync(lockPath, { force: true });
      },
    });
    assert.equal(polls, 1);
    lock.release();
  } finally {
    fs.rmSync(path.dirname(lockPath), { recursive: true, force: true });
  }
});

test('a browser lock wait times out on a deadline instead of waiting forever', async () => {
  const lockPath = lockFixture();
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 1501, cwd: '/repo/worktree-a', startedAt: 'earlier' }));
  let clock = 0;
  try {
    await assert.rejects(
      browserLock.acquireBrowserLock({
        lockPath,
        pid: 1502,
        deadlineMs: 1_000,
        isProcessAlive: () => true,
        monotonicNow: () => clock,
        waitForPoll: async (milliseconds) => {
          clock += milliseconds;
        },
      }),
      /Timed out waiting for the browser test lock/,
    );
  } finally {
    fs.rmSync(path.dirname(lockPath), { recursive: true, force: true });
  }
});

test('release never throws, even when the lock file cannot be read', async () => {
  const lockPath = lockFixture();
  try {
    const lock = await browserLock.acquireBrowserLock({ lockPath, pid: 1601 });
    fs.rmSync(lockPath, { force: true });
    fs.mkdirSync(lockPath); // A directory in the lock's place makes a read throw a non-ENOENT error.
    assert.doesNotThrow(() => lock.release());
    assert.equal(lock.release(), false);
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
    fs.rmSync(path.dirname(lockPath), { recursive: true, force: true });
  }
});

test('a retire that cannot rename the lock reports not-retired instead of throwing', () => {
  const lockPath = lockFixture();
  const staleText = JSON.stringify({ pid: 1701, cwd: '/repo/worktree-a', startedAt: 'earlier' });
  fs.writeFileSync(lockPath, staleText);
  const rename = () => {
    const error = new Error('resource busy or locked');
    error.code = 'EBUSY';
    throw error;
  };
  try {
    assert.equal(browserLock.forTesting.retireStaleLock(lockPath, staleText, 1702, { rename }), 'busy');
    assert.equal(fs.existsSync(lockPath), true);
  } finally {
    fs.rmSync(path.dirname(lockPath), { recursive: true, force: true });
  }
});

test('forwarding a signal kills the child, releases the lock only after it closes, and exits 128+signo', async () => {
  const { EventEmitter } = require('node:events');
  const processEmitter = new EventEmitter();
  const child = new EventEmitter();
  const killed = [];
  const released = [];
  const exitCodes = [];
  child.kill = () => killed.push('kill');
  const lock = { release: () => released.push('release') };
  const baseline = processEmitter.listenerCount('SIGINT');
  processEmitter.exit = (code) => exitCodes.push(code);
  const detach = browserLock.forwardSignalToChildAndRelease(child, lock, {
    processEmitter,
    killTree: (target, signal) => killed.push(signal),
  });
  processEmitter.emit('SIGINT');
  assert.deepEqual(killed, ['SIGINT']);
  assert.deepEqual(released, []);
  child.emit('close');
  assert.deepEqual(released, ['release']);
  assert.deepEqual(exitCodes, [130]);
  detach();
  assert.equal(processEmitter.listenerCount('SIGINT'), baseline);
});

test('the browser lane acquires the lock before detecting a browser, and releases it on the skip path', async () => {
  const root = fixture();
  const order = [];
  try {
    const status = await runner.runBrowserLane([], {
      testRoot: root,
      detectBrowser: async () => {
        order.push('detected');
        return null;
      },
      acquireLock: async () => {
        order.push('acquired');
        return {
          release: () => {
            order.push('released');
            return true;
          },
        };
      },
      spawn: () => {
        throw new Error('must not spawn when no browser is found');
      },
    });
    assert.equal(status, 0);
    assert.deepEqual(order, ['acquired', 'detected', 'released']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a non-zero vitest status still releases the lock and keeps the status', async () => {
  const root = fixture();
  const released = [];
  try {
    const status = await runner.runBrowserLane([], {
      testRoot: root,
      detectBrowser: async () => 'msedge',
      acquireLock: async () => ({
        release: () => {
          released.push('released');
          return true;
        },
      }),
      spawn: () => ({ status: 7 }),
    });
    assert.equal(status, 7);
    assert.deepEqual(released, ['released']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a spawn error still releases the lock and reports a failing status', async () => {
  const root = fixture();
  const released = [];
  try {
    const status = await runner.runBrowserLane([], {
      testRoot: root,
      detectBrowser: async () => 'msedge',
      acquireLock: async () => ({
        release: () => {
          released.push('released');
          return true;
        },
      }),
      spawn: () => ({ error: new Error('spawn EPERM') }),
    });
    assert.equal(status, 1);
    assert.deepEqual(released, ['released']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('two concurrent takeovers of the same stale lock yield exactly one holder', () => {
  const lockPath = lockFixture();
  const staleText = JSON.stringify({ pid: 909, cwd: '/repo/worktree-a', startedAt: 'earlier' });
  fs.writeFileSync(lockPath, staleText);
  try {
    // The first racer reads the stale content and wins the rename: it discards what it read
    // and the path is free.
    assert.equal(browserLock.forTesting.retireStaleLock(lockPath, staleText, 910), 'retired');
    assert.equal(fs.existsSync(lockPath), false);

    // It recreates the lock with its own record, the way acquireBrowserLock does next.
    const freshText = JSON.stringify({ pid: 910, cwd: '/repo/worktree-b', startedAt: 'now' });
    fs.writeFileSync(lockPath, freshText, { flag: 'wx' });

    // The second racer still holds the stale content it read before the first racer acted, and
    // only now gets to its own rename. It must not discard the fresh lock.
    assert.equal(browserLock.forTesting.retireStaleLock(lockPath, staleText, 911), 'taken');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), freshText);
  } finally {
    fs.rmSync(path.dirname(lockPath), { recursive: true, force: true });
  }
});

test('an EPERM restore falls back to an exclusive create instead of a rename that could overwrite a fresh lock', () => {
  const lockPath = lockFixture();
  const staleText = JSON.stringify({ pid: 909, cwd: '/repo/worktree-a', startedAt: 'earlier' });
  const takenByMistake = JSON.stringify({ pid: 910, cwd: '/repo/worktree-b', startedAt: 'now' });
  const thirdRunText = JSON.stringify({ pid: 911, cwd: '/repo/worktree-c', startedAt: 'now' });
  fs.writeFileSync(lockPath, takenByMistake); // A racer's rename lands after this replaced the stale content it meant to take.
  // Simulates a third run publishing its own lock at lockPath in the window between this
  // racer's rename and its restore attempt, then fails the link the way a filesystem without
  // hard-link support does.
  const linkThrowsEPERM = () => {
    fs.writeFileSync(lockPath, thirdRunText, { flag: 'wx' });
    const error = new Error('operation not permitted');
    error.code = 'EPERM';
    throw error;
  };
  try {
    assert.equal(browserLock.forTesting.retireStaleLock(lockPath, staleText, 912, { link: linkThrowsEPERM }), 'taken');
    // The third run's lock, published during the restore attempt, must survive: an exclusive
    // create fails against it instead of a rename silently replacing it.
    assert.equal(fs.readFileSync(lockPath, 'utf8'), thirdRunText);
  } finally {
    fs.rmSync(path.dirname(lockPath), { recursive: true, force: true });
  }
});

test('an EPERM restore fallback puts a mis-retired lock back when nothing else has claimed the path', () => {
  const lockPath = lockFixture();
  const staleText = JSON.stringify({ pid: 920, cwd: '/repo/worktree-a', startedAt: 'earlier' });
  const freshText = JSON.stringify({ pid: 921, cwd: '/repo/worktree-b', startedAt: 'now' });
  // The rename below captures freshText instead of staleText, the same as a racer whose rename
  // lands just after a fresh lock replaced the stale one it meant to take.
  fs.writeFileSync(lockPath, freshText);
  const linkThrowsEPERM = () => {
    const error = new Error('operation not permitted');
    error.code = 'EPERM';
    throw error;
  };
  try {
    assert.equal(browserLock.forTesting.retireStaleLock(lockPath, staleText, 922, { link: linkThrowsEPERM }), 'taken');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), freshText);
  } finally {
    fs.rmSync(path.dirname(lockPath), { recursive: true, force: true });
  }
});

test('release removes only a lock this process still owns', async () => {
  const lockPath = lockFixture();
  try {
    const lock = await browserLock.acquireBrowserLock({ lockPath, pid: 1010 });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 1011, cwd: '/repo/worktree-c', startedAt: 'later' }));
    assert.equal(lock.release(), false);
    assert.equal(readLockOwner(lockPath).pid, 1011);
  } finally {
    fs.rmSync(path.dirname(lockPath), { recursive: true, force: true });
  }
});

test('the browser lane acquires and releases the machine-wide lock around the spawn', async () => {
  const root = fixture();
  const acquired = [];
  try {
    const status = await runner.runBrowserLane([], {
      testRoot: root,
      detectBrowser: async () => 'msedge',
      spawn: () => {
        acquired.push('spawned');
        return { status: 0 };
      },
      acquireLock: async (options) => {
        acquired.push('acquired');
        assert.equal(options.cwd, root);
        return {
          release() {
            acquired.push('released');
            return true;
          },
        };
      },
    });
    assert.equal(status, 0);
    assert.deepEqual(acquired, ['acquired', 'spawned', 'released']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('discovers nested browser tests and keeps the lanes disjoint', () => {
  const root = fixture();
  try {
    const files = runner.discoverTestFiles(path.join(root, 'src'), root);
    assert.deepEqual(files, [
      'src/chrome.browser.test.ts',
      'src/panel.layout.rail.test.ts',
      'src/panel.layout.test.ts',
      'src/store.test.ts',
      'src/webview/integration.browser.test.ts',
      'src/webview/panel.test.ts',
    ]);
    const node = runner.selectTestFiles(files, 'node');
    const browser = runner.selectTestFiles(files, 'browser');
    const full = runner.selectTestFiles(files, 'full');
    assert.deepEqual(browser, [
      'src/chrome.browser.test.ts',
      'src/panel.layout.rail.test.ts',
      'src/panel.layout.test.ts',
      'src/webview/integration.browser.test.ts',
    ]);
    assert.deepEqual(node, ['src/store.test.ts', 'src/webview/panel.test.ts']);
    assert.deepEqual([...node, ...browser].sort(), full);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects an invalid mode without starting Node', () => {
  const root = fixture();
  const errors = [];
  const original = console.error;
  console.error = (message) => errors.push(message);
  try {
    assert.equal(
      runner.runTestMode('slow', [], {
        testRoot: root,
        spawn: () => {
          throw new Error('must not run');
        },
      }),
      1,
    );
    assert.deepEqual(errors, ['Unknown test mode "slow". Expected full, node, or browser.']);
  } finally {
    console.error = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the command-line entry point rejects an invalid mode', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'extension', 'test.mjs'), 'slow'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown test mode "slow"\. Expected full, node, or browser\./);
});

test('forwards Vitest flags with the node lane worker cap and returns the child status', () => {
  const root = fixture();
  let command;
  let args;
  let options;
  try {
    assert.equal(
      runner.runTestMode('node', ['--testNamePattern', 'saved state'], {
        testRoot: root,
        spawn: (receivedCommand, receivedArgs, receivedOptions) => {
          command = receivedCommand;
          args = receivedArgs;
          options = receivedOptions;
          return { status: 23 };
        },
      }),
      23,
    );
    assert.equal(command, process.execPath);
    assert.deepEqual(args, [
      path.join(root, 'node_modules', 'vitest', 'vitest.mjs'),
      'run',
      '--fileParallelism',
      '--maxWorkers=8',
      'src/store.test.ts',
      'src/webview/panel.test.ts',
      '--testNamePattern',
      'saved state',
    ]);
    assert.deepEqual(options, { cwd: root, stdio: 'inherit' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the standalone and full browser invocations use four workers', async () => {
  const root = fixture();
  const args = [];
  const acquireLock = async () => ({ release: () => true });
  try {
    const standaloneStatus = await runner.runBrowserLane([], {
      testRoot: root,
      detectBrowser: async () => 'msedge',
      acquireLock,
      spawn: (_command, receivedArgs) => {
        args.push(receivedArgs);
        return { status: 0 };
      },
    });
    assert.equal(standaloneStatus, 0);
    const status = await runner.runFull(['--testNamePattern', 'saved state'], {
      testRoot: root,
      detectBrowser: async () => 'msedge',
      acquireLock,
      spawn: (_command, receivedArgs) => {
        args.push(receivedArgs);
        return { status: 0 };
      },
    });
    assert.equal(status, 0);
    assert.equal(args.length, 3);
    assert.deepEqual(args[0].slice(2, 4), ['--fileParallelism', '--maxWorkers=4']);
    assert.deepEqual(args[1].slice(2, 4), ['--fileParallelism', '--maxWorkers=8']);
    assert.deepEqual(args[2].slice(2, 4), ['--fileParallelism', '--maxWorkers=4']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a named file narrows the node lane instead of running every node test', () => {
  const root = fixture();
  let args;
  try {
    assert.equal(
      runner.runTestMode('node', ['src/store.test.ts'], {
        testRoot: root,
        spawn: (_command, receivedArgs) => {
          args = receivedArgs;
          return { status: 0 };
        },
      }),
      0,
    );
    const testFileArgs = args.filter((arg) => arg.endsWith('.test.ts'));
    assert.deepEqual(testFileArgs, ['src/store.test.ts']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a named file narrows the browser lane instead of running every browser test', async () => {
  const root = fixture();
  let args;
  try {
    const status = await runner.runBrowserLane(['src/chrome.browser.test.ts'], {
      testRoot: root,
      detectBrowser: async () => 'msedge',
      acquireLock: async () => ({ release: () => true }),
      spawn: (_command, receivedArgs) => {
        args = receivedArgs;
        return { status: 0 };
      },
    });
    assert.equal(status, 0);
    const testFileArgs = args.filter((arg) => arg.endsWith('.test.ts'));
    assert.deepEqual(testFileArgs, ['src/chrome.browser.test.ts']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a file that does not belong to the lane fails clearly instead of running the whole lane', () => {
  const root = fixture();
  const errors = [];
  const original = console.error;
  console.error = (message) => errors.push(message);
  try {
    assert.equal(
      runner.runTestMode('node', ['src/chrome.browser.test.ts'], {
        testRoot: root,
        spawn: () => {
          throw new Error('must not run');
        },
      }),
      1,
    );
    assert.deepEqual(errors, [
      '"src/chrome.browser.test.ts" is not a node lane test file. Run without file arguments to run the whole lane.',
    ]);
  } finally {
    console.error = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a file argument after a boolean flag still narrows the lane instead of running in full', async () => {
  const root = fixture();
  let args;
  try {
    const status = await runner.runBrowserLane(['--update', 'src/chrome.browser.test.ts'], {
      testRoot: root,
      detectBrowser: async () => 'msedge',
      acquireLock: async () => ({ release: () => true }),
      spawn: (_command, receivedArgs) => {
        args = receivedArgs;
        return { status: 0 };
      },
    });
    assert.equal(status, 0);
    const testFileArgs = args.filter((arg) => arg.endsWith('.test.ts'));
    assert.deepEqual(testFileArgs, ['src/chrome.browser.test.ts']);
    // --update takes an optional value, so Vitest's own CLI parser reads a following
    // positional as that value unless nothing follows the flag. Placing the file first keeps
    // it out of --update's reach the same way it stays out of ours.
    assert.ok(args.indexOf('src/chrome.browser.test.ts') < args.indexOf('--update'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('full mode gives each lane only its own named file instead of failing the other lane', async () => {
  const root = fixture();
  const calls = [];
  try {
    const status = await runner.runFull(['src/panel.layout.test.ts'], {
      testRoot: root,
      detectBrowser: async () => 'msedge',
      acquireLock: async () => ({ release: () => true }),
      spawn: (_command, receivedArgs) => {
        calls.push(receivedArgs);
        return { status: 0 };
      },
    });
    assert.equal(status, 0);
    assert.equal(calls.length, 1);
    const testFileArgs = calls[0].filter((arg) => arg.endsWith('.test.ts'));
    assert.deepEqual(testFileArgs, ['src/panel.layout.test.ts']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('full mode fails with a clear error naming a file that matches no test in either lane', async () => {
  const root = fixture();
  const errors = [];
  const original = console.error;
  console.error = (message) => errors.push(message);
  try {
    const status = await runner.runFull(['src/missing.test.ts'], {
      testRoot: root,
      detectBrowser: async () => 'msedge',
      spawn: () => {
        throw new Error('must not run');
      },
    });
    assert.equal(status, 1);
    assert.deepEqual(errors, ['No test file matches "src/missing.test.ts".']);
  } finally {
    console.error = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the browser lane is skipped when no browser is available', async () => {
  const root = fixture();
  const logs = [];
  const original = console.log;
  console.log = (message) => logs.push(message);
  try {
    const status = await runner.runFull([], {
      testRoot: root,
      detectBrowser: async () => null,
      acquireLock: async () => ({ release: () => true }),
      spawn: (_command, receivedArgs) => {
        if (receivedArgs.includes('--maxWorkers=4')) {
          throw new Error('must not run the browser lane');
        }
        return { status: 0 };
      },
    });
    assert.equal(status, 0);
    assert.ok(logs.includes('Browser lane skipped: no browser found.'));
  } finally {
    console.log = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a known value flag keeps its following positional token out of file selection', () => {
  const root = fixture();
  try {
    for (const [flag, value] of [
      ['--testNamePattern', 'foo.test.ts'],
      ['--dir', 'src'],
    ]) {
      let args;
      assert.equal(
        runner.runTestMode('node', [flag, value], {
          testRoot: root,
          spawn: (_command, receivedArgs) => {
            args = receivedArgs;
            return { status: 0 };
          },
        }),
        0,
      );
      assert.deepEqual(args.slice(-2), [flag, value]);
      assert.deepEqual(
        args.filter((arg) => arg.endsWith('.test.ts') && arg !== value),
        ['src/store.test.ts', 'src/webview/panel.test.ts'],
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Reads Vitest's own CLI option table out of its installed source, as plain text, so a Vitest
// upgrade that adds or drops a required-value flag turns this test red instead of drifting
// silently away from extension/test.mjs's hand-kept VALUE_FLAGS list. Parses only enough of the
// object literal to split it into top-level entries and read each entry's own `argument`,
// `shorthand`, and `alias` fields, skipping past nested `subcommands` blocks and skipping over
// string and template-literal contents so a brace or colon inside a description never confuses
// the split.
function sliceBalancedBraces(source, openIndex, chunkPath) {
  if (source[openIndex] !== '{') {
    throw new Error(`expected "{" at offset ${openIndex} of ${chunkPath}`);
  }
  let depth = 0;
  let inString = null;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(openIndex + 1, i);
    }
  }
  throw new Error(`the "{" at offset ${openIndex} of ${chunkPath} never closes`);
}

function splitTopLevelEntries(body, chunkPath) {
  const entries = [];
  let i = 0;
  const n = body.length;
  while (i < n) {
    while (i < n && /[\s,]/.test(body[i])) i++;
    if (i >= n) break;
    const keyMatch = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(body.slice(i));
    if (!keyMatch) {
      throw new Error(`could not read a key at offset ${i} of cliOptionsConfig in ${chunkPath}`);
    }
    const key = keyMatch[0];
    i += key.length;
    while (i < n && /\s/.test(body[i])) i++;
    if (body[i] !== ':') {
      throw new Error(`expected ":" after key "${key}" of cliOptionsConfig in ${chunkPath}`);
    }
    i++;
    while (i < n && /\s/.test(body[i])) i++;
    if (body.startsWith('null', i) && !/[A-Za-z0-9_$]/.test(body[i + 4] ?? '')) {
      entries.push([key, null]);
      i += 4;
      continue;
    }
    if (body[i] === '{') {
      const start = i;
      let depth = 0;
      let inString = null;
      for (; i < n; i++) {
        const ch = body[i];
        if (inString) {
          if (ch === '\\') {
            i++;
            continue;
          }
          if (ch === inString) inString = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
          inString = ch;
          continue;
        }
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
      }
      if (depth !== 0) {
        throw new Error(`the object for key "${key}" of cliOptionsConfig in ${chunkPath} never closes`);
      }
      entries.push([key, body.slice(start, i)]);
      continue;
    }
    throw new Error(`key "${key}" of cliOptionsConfig in ${chunkPath} has an unexpected value shape`);
  }
  return entries;
}

function extractRequiredValueFlags(source, chunkPath) {
  const marker = 'const cliOptionsConfig = {';
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`could not find "${marker}" in ${chunkPath}`);
  }
  const body = sliceBalancedBraces(source, markerIndex + marker.length - 1, chunkPath);
  const entries = splitTopLevelEntries(body, chunkPath);
  const flags = new Set();
  for (const [key, value] of entries) {
    if (value === null) continue;
    const ownFields = value.includes('subcommands:') ? value.slice(0, value.indexOf('subcommands:')) : value;
    const argumentMatch = /argument:\s*"([^"]*)"/.exec(ownFields);
    if (!argumentMatch || !/^<.*>$/.test(argumentMatch[1])) continue;
    flags.add(`--${key}`);
    const shorthandMatch = /shorthand:\s*"([^"]*)"/.exec(ownFields);
    if (shorthandMatch) flags.add(`-${shorthandMatch[1]}`);
    const aliasMatch = /alias:\s*"([^"]*)"/.exec(ownFields);
    if (aliasMatch) flags.add(`--${aliasMatch[1]}`);
  }
  if (flags.size < 10) {
    throw new Error(
      `parsed only ${flags.size} required-value flags out of ${chunkPath}; its cliOptionsConfig shape may have changed`,
    );
  }
  return flags;
}

function findVitestCacChunk() {
  const searched = [];
  const candidateDirs = [];
  try {
    const vitestPkg = require.resolve('vitest/package.json', { paths: [path.join(__dirname, '..', 'extension')] });
    candidateDirs.push(path.join(path.dirname(vitestPkg), 'dist', 'chunks'));
  } catch {
    // Falls through to the fixed extension/node_modules layout below.
  }
  candidateDirs.push(path.join(__dirname, '..', 'extension', 'node_modules', 'vitest', 'dist', 'chunks'));
  for (const dir of candidateDirs) {
    searched.push(dir);
    if (!fs.existsSync(dir)) continue;
    const match = fs.readdirSync(dir).find((name) => /^cac.*\.js$/.test(name));
    if (match) return path.join(dir, match);
  }
  throw new Error(`could not find a Vitest "cac*.js" chunk. Looked in: ${searched.join(', ')}`);
}

test('VALUE_FLAGS matches every required-value flag in the installed Vitest CLI table', () => {
  const chunkPath = findVitestCacChunk();
  const source = fs.readFileSync(chunkPath, 'utf8');
  const installed = extractRequiredValueFlags(source, chunkPath);
  const missing = [...installed].filter((flag) => !runner.VALUE_FLAGS.has(flag)).sort();
  const extra = [...runner.VALUE_FLAGS].filter((flag) => !installed.has(flag)).sort();
  assert.deepEqual(
    { missing, extra },
    { missing: [], extra: [] },
    `VALUE_FLAGS in extension/test.mjs drifted from ${chunkPath}. Missing: ${JSON.stringify(missing)}. Extra: ${JSON.stringify(extra)}.`,
  );
});
