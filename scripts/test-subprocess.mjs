// Runs the root tests tagged subprocess. They start real processes, and process starts are slow on a loaded machine.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { forwardSignalToChildAndRelease } from '../extension/test/browserlock.mjs';
import { clampWorkerArgs, clampWorkerEnvironment } from '../extension/test/machineload.mjs';
import { createTestObservation } from '../extension/test/observations.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Root test files run one at a time, as in vitest.config.mts. One file at a time keeps the lane from competing with itself for process starts.
export const SUBPROCESS_WORKERS = 1;
// editor-cli.test.js marks many cases concurrent. Vitest runs five of them at once by default, and each starts several processes.
export const SUBPROCESS_CONCURRENCY = 2;
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
  { testRoot = root, spawn: spawnChild = spawn, observation = null } = {},
) {
  observation?.unavailable('queue', 'Subprocess launches have no shared admission queue.');
  observation?.unavailable('build', 'Builds inside Vitest are not separate launcher intervals.');
  let status = null;
  let signal = null;
  let failure = null;
  let detachSignalForwarding;
  try {
    observation?.begin('execution', { boundary: 'Vitest child lifetime, including collection and teardown' });
    const inherited = observation ? observation.childEnvironment() : process.env;
    const env = clampWorkerEnvironment(inherited);
    const child = spawnChild(process.execPath, clampWorkerArgs(subprocessVitestArgs(testRoot, extraArgs)), {
      cwd: testRoot,
      stdio: 'inherit',
      ...(env === process.env ? {} : { env }),
    });
    observation?.event('execution', 'child-start', { childPid: child.pid ?? null });
    detachSignalForwarding = forwardSignalToChildAndRelease(child, null, { observation });
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
  } catch (error) {
    failure = error.message;
    observation?.end('execution', { exitCode: null, error: failure });
    throw error;
  } finally {
    if (detachSignalForwarding) {
      observation?.begin('cleanup', { boundary: 'Signal listener removal' });
      detachSignalForwarding();
      observation?.end('cleanup', { descendants: 'unobserved' });
    } else {
      observation?.unavailable('cleanup', 'No signal listeners were attached.');
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
    observation: createTestObservation({ lane: 'subprocess', cwd: root, workerCap: SUBPROCESS_WORKERS }),
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
