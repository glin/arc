// Runs the root tests tagged subprocess. They start real processes, and process starts are slow on a loaded machine.
// One shared lock in the system temp folder limits the machine to one such lane across checkouts.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireBrowserLock, forwardSignalToChildAndRelease } from '../extension/test/browserlock.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const SUBPROCESS_LOCK_PATH = join(tmpdir(), 'arc-subprocess-tests.lock');
// Root test files run one at a time, as in vitest.config.mts. One file at a time keeps the lane from competing with itself for process starts.
export const SUBPROCESS_WORKERS = 1;
// editor-cli.test.js marks many cases concurrent. Vitest runs five of them at once by default, and each starts several processes.
export const SUBPROCESS_CONCURRENCY = 2;
// A session queued behind other lanes on a loaded machine can wait for hours.
export const SUBPROCESS_LOCK_DEADLINE_MS = 3 * 60 * 60_000;
// The smoke lane owns this file.
export const SMOKE_TEST_FILE = 'test/hooks-smoke.test.js';

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
  { testRoot = root, spawn: spawnChild = spawn, acquireLock = acquireBrowserLock } = {},
) {
  const lock = await acquireLock({
    lockPath: SUBPROCESS_LOCK_PATH,
    cwd: testRoot,
    deadlineMs: SUBPROCESS_LOCK_DEADLINE_MS,
    label: 'subprocess',
  });
  try {
    const child = spawnChild(process.execPath, subprocessVitestArgs(testRoot, extraArgs), {
      cwd: testRoot,
      stdio: 'inherit',
    });
    const detachSignalForwarding = forwardSignalToChildAndRelease(child, lock);
    try {
      return await new Promise((resolveStatus) => {
        let settled = false;
        child.once('error', (error) => {
          if (settled) return;
          settled = true;
          console.error(`Could not start Vitest: ${error.message}`);
          resolveStatus(1);
        });
        child.once('close', (status) => {
          if (settled) return;
          settled = true;
          resolveStatus(status ?? 1);
        });
      });
    } finally {
      detachSignalForwarding();
    }
  } finally {
    lock.release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSubprocessLane(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
