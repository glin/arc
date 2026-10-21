// Runs the root tests tagged subprocess. They start real processes, and process starts are slow on a loaded machine.
// The legacy lock and two counted slots admit three lanes across checkouts.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { acquireBrowserLock, forwardSignalToChildAndRelease } from '../extension/test/browserlock.mjs';
import { performance } from 'node:perf_hooks';
import { acquireBrowserSlot } from '../extension/test/browserchannels.mjs';
import { createTestObservation } from '../extension/test/observations.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const SUBPROCESS_LOCK_PATH = join(tmpdir(), 'arc-subprocess-tests.lock');
export const SUBPROCESS_SLOT_ROOT = join(tmpdir(), 'arc-subprocess-test-slots');
export const SUBPROCESS_LANE_COUNT = 3;
// Root test files run one at a time, as in vitest.config.mts. One file at a time keeps the lane from competing with itself for process starts.
export const SUBPROCESS_WORKERS = 1;
// editor-cli.test.js marks many cases concurrent. Vitest runs five of them at once by default, and each starts several processes.
export const SUBPROCESS_CONCURRENCY = 2;
// A session queued behind other lanes on a loaded machine can wait for hours.
export const SUBPROCESS_LOCK_DEADLINE_MS = 3 * 60 * 60_000;
// The smoke lane owns this file.
export const SMOKE_TEST_FILE = 'test/hooks-smoke.test.js';

export async function acquireSubprocessSlot({
  lockPath = SUBPROCESS_LOCK_PATH,
  slotRootPath = SUBPROCESS_SLOT_ROOT,
  cwd = process.cwd(),
  deadlineMs = SUBPROCESS_LOCK_DEADLINE_MS,
  monotonicNow = () => performance.now(),
  waitForPoll = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
  pollMs = 500,
  observation = null,
  now = Date.now,
  legacyOptions = {},
  slotOptions = {},
} = {}) {
  const startedAt = monotonicNow();
  const deadline = startedAt + deadlineMs;
  let announced = false;
  const seenHolders = new Map();
  let holders = [];
  let previousHolders = null;
  let lastNotice = -Infinity;
  const primitiveObservation = observation
    ? {
        begin() {},
        end() {},
        event(phase, event, detail) {
          if (phase !== 'queue') {
            observation.event(phase, event, detail);
            return;
          }
          const entries =
            event === 'holder'
              ? [{ lockPath: detail.lockPath, owner: detail.holder, mtimeMs: detail.mtimeMs }]
              : detail.holders.map(({ index, owner }) => ({ rootPath: detail.rootPath, index, owner }));
          for (const entry of entries) {
            const path = entry.lockPath ?? entry.rootPath + '/slot-' + entry.index;
            const key = JSON.stringify(entry.owner);
            const at = monotonicNow();
            const previous = seenHolders.get(path);
            const since = previous?.key === key ? previous.since : at;
            seenHolders.set(path, { key, since });
            holders.push({ ...entry, observedHolderMs: at - since });
          }
        },
      }
    : null;
  observation?.begin('queue', {
    lockPath,
    rootPath: slotRootPath,
    capacity: SUBPROCESS_LANE_COUNT,
    deadlineMs,
    queuePosition: null,
  });
  try {
    while (true) {
      holders = [];
      // Legacy checkouts use this place without entering the counted pool.
      // Never retire its path: a delayed stale rename can displace a live replacement.
      const legacy = await acquireBrowserLock({
        ...legacyOptions,
        lockPath,
        cwd,
        now,
        monotonicNow,
        observation: primitiveObservation,
        tryOnly: true,
      });
      const permit =
        legacy ??
        (await acquireBrowserSlot({
          ...slotOptions,
          rootPath: slotRootPath,
          slotCount: SUBPROCESS_LANE_COUNT - 1,
          now,
          monotonicNow,
          observation: primitiveObservation,
          tryOnly: true,
          conservativeRecovery: true,
        }));
      if (permit) {
        if (announced) console.log(`Subprocess test slot wait: ${Math.round(monotonicNow() - startedAt)} ms.`);
        observation?.end('queue', { lockPath, rootPath: slotRootPath, index: permit.index ?? null });
        return permit;
      }
      if (observation) {
        const at = monotonicNow();
        const signature = JSON.stringify(
          holders.map((holder) => [holder.lockPath, holder.rootPath, holder.index, holder.owner, holder.mtimeMs]),
        );
        if (signature !== previousHolders || at - lastNotice >= 30_000) {
          previousHolders = signature;
          lastNotice = at;
          observation.event('queue', 'holders', {
            lockPath,
            rootPath: slotRootPath,
            observedAt: new Date(now()).toISOString(),
            holders,
            queuePosition: null,
            holderDuration: 'before first observation unavailable',
          });
        }
      }
      if (!announced) {
        console.log(`Subprocess tests are waiting for one of ${SUBPROCESS_LANE_COUNT} places.`);
        announced = true;
      }
      const remaining = deadline - monotonicNow();
      if (remaining <= 0)
        throw new Error(`Timed out waiting for one of ${SUBPROCESS_LANE_COUNT} subprocess test places.`);
      await waitForPoll(Math.min(pollMs, remaining));
    }
  } catch (error) {
    observation?.end('queue', { lockPath, rootPath: slotRootPath, error: error.message });
    throw error;
  }
}

export function subprocessVitestArgs(testRoot = root, extraArgs = []) {
  return [
    join(testRoot, 'node_modules', 'vitest', 'vitest.mjs'),
    'run',
    '--tags-filter=subprocess',
    `--maxWorkers=${SUBPROCESS_WORKERS}`,
    `--maxConcurrency=${SUBPROCESS_CONCURRENCY}`,
    '--exclude',
    SMOKE_TEST_FILE,
    ...extraArgs,
  ];
}

export async function runSubprocessLane(
  extraArgs = [],
  { testRoot = root, spawn: spawnChild = spawn, acquireLock = acquireSubprocessSlot, observation = null } = {},
) {
  observation?.unavailable('build', 'Builds inside Vitest are not separate launcher intervals.');
  let status = null;
  let signal = null;
  let failure = null;
  let lock;
  try {
    lock = await acquireLock({
      lockPath: SUBPROCESS_LOCK_PATH,
      cwd: testRoot,
      deadlineMs: SUBPROCESS_LOCK_DEADLINE_MS,
      label: 'subprocess',
      observation,
    });
    try {
      observation?.begin('execution', { boundary: 'Vitest child lifetime, including collection and teardown' });
      const child = spawnChild(process.execPath, subprocessVitestArgs(testRoot, extraArgs), {
        cwd: testRoot,
        stdio: 'inherit',
        ...(observation ? { env: observation.childEnvironment() } : {}),
      });
      observation?.event('execution', 'child-start', { childPid: child.pid ?? null });
      const detachSignalForwarding = forwardSignalToChildAndRelease(child, lock, { observation });
      try {
        return await new Promise((resolveStatus) => {
          let settled = false;
          child.once('error', (error) => {
            if (settled) return;
            settled = true;
            failure = error.message;
            status = 1;
            observation?.end('execution', { exitCode: null, error: failure });
            console.error(`Could not start Vitest: ${error.message}`);
            resolveStatus(1);
          });
          child.once('close', (code, childSignal) => {
            if (settled) return;
            settled = true;
            status = code;
            signal = childSignal ?? null;
            observation?.end('execution', { exitCode: code, signal });
            resolveStatus(code ?? 1);
          });
        });
      } finally {
        detachSignalForwarding();
      }
    } finally {
      observation?.begin('cleanup');
      const released = lock.release();
      observation?.end('cleanup', { released, descendants: 'unobserved' });
    }
  } catch (error) {
    failure = error.message;
    throw error;
  } finally {
    if (!lock) {
      observation?.unavailable('execution', 'Capacity was not acquired.');
      observation?.unavailable('cleanup', 'No acquired lock or child.');
    }
    observation?.finish({
      exitCode: status,
      signal,
      outcome: failure ? 'failure' : signal ? 'cancelled' : status === 0 ? 'success' : 'failure',
      reason: failure,
    });
  }
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  runSubprocessLane(process.argv.slice(2), {
    observation: createTestObservation({
      lane: 'subprocess',
      cwd: root,
      workerCap: SUBPROCESS_WORKERS,
      capacity: SUBPROCESS_LANE_COUNT,
    }),
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
