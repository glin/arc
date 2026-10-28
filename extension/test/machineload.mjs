// Plain Node ESM lets extension/test.mjs and the root suite runner import this module.
// A multi-lane test run holds the machine suite lock, so one such run uses the machine at a time.
// Before each lane it waits for free physical memory, and every Vitest lane runs at most four workers.
// The suite lock reuses the browser lane lock, including its stale-holder takeover and its three-run race.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableParallelism, freemem, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { processExists } from './browserchannels.mjs';
import { acquireBrowserLock } from './browserlock.mjs';

export const SUITE_LOCK_PATH = join(tmpdir(), 'arc-test-suite.lock');
// A holder sets this to its PID for its children, so a nested run inside a held suite does not wait on its parent.
// A nested run qualifies only when that PID is another live process that owns the lock file it would take.
export const SUITE_HOLDER_ENV = 'ARC_TEST_SUITE_HOLDER';
export const DEADLINE_ENV = 'ARC_TEST_LOAD_DEADLINE_MINUTES';
export const MEMORY_FLOOR_ENV = 'ARC_TEST_MEMORY_FLOOR_GB';
export const DEFAULT_DEADLINE_MINUTES = 40;
export const DEFAULT_MEMORY_FLOOR_GB = 6;
export const SUITE_LOCK_TIMEOUT_EXIT = 75;
export const MEMORY_TIMEOUT_EXIT = 76;
export const MAX_VITEST_WORKERS = 4;
const NOTICE_MS = 30_000;
const MEMORY_POLL_MS = 5_000;
const GIB = 1024 ** 3;

export class MachineLoadTimeout extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

function setting(env, name, fallback, allowZero) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0))
    throw Error(`${name} must be a number above ${allowZero ? 'or equal to ' : ''}0. It is "${raw}".`);
  return value;
}

export function loadSettings(env = process.env) {
  const deadlineMinutes = setting(env, DEADLINE_ENV, DEFAULT_DEADLINE_MINUTES, false);
  const floorGb = setting(env, MEMORY_FLOOR_ENV, DEFAULT_MEMORY_FLOOR_GB, true);
  return { deadlineMs: deadlineMinutes * 60_000, floorBytes: floorGb * GIB };
}

// Windows reports available physical memory, which includes the standby list.
// Linux reports MemAvailable. macOS counts free, inactive, and speculative pages, because its free count alone excludes reclaimable cache.
export function freeMemoryBytes({
  platform = process.platform,
  readText = (file) => readFileSync(file, 'utf8'),
  run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
  osFree = freemem,
} = {}) {
  try {
    if (platform === 'linux') {
      const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(readText('/proc/meminfo'));
      if (available) return Number(available[1]) * 1024;
    } else if (platform === 'darwin') {
      const text = run('vm_stat', []);
      const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
      const pages = ['free', 'inactive', 'speculative'].map((name) =>
        Number(new RegExp(`^Pages ${name}:\\s+(\\d+)\\.`, 'm').exec(text)?.[1]),
      );
      if (pageSize > 0 && pages.every(Number.isInteger)) return pageSize * pages.reduce((sum, count) => sum + count, 0);
    }
  } catch {
    // An unreadable platform source falls back to the Node figure.
  }
  return osFree();
}

const gigabytes = (bytes) => (bytes / GIB).toFixed(1);
const minutes = (milliseconds) => Math.round(milliseconds / 60_000);
const seconds = (milliseconds) => Math.round(milliseconds / 1000);
const sleep = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

// Wait while free physical memory is under the floor. A floor of zero disables the wait.
export async function waitForMemory({
  floorBytes,
  deadlineMs,
  label,
  readFree = freeMemoryBytes,
  log = console.log,
  monotonicNow = () => performance.now(),
  waitForPoll = sleep,
  pollMs = MEMORY_POLL_MS,
  signal = null,
}) {
  if (!floorBytes) return;
  const startedAt = monotonicNow();
  let lastNotice = null;
  while (true) {
    // A cancelled suite stops waiting. Its caller marks the remaining lanes cancelled.
    if (signal?.aborted) return;
    const free = readFree();
    const waited = monotonicNow() - startedAt;
    if (free >= floorBytes) {
      if (lastNotice !== null) log(`Free memory is ${gigabytes(free)} GB. ${label} starts after ${seconds(waited)} s.`);
      return;
    }
    if (waited >= deadlineMs)
      throw new MachineLoadTimeout(
        `${label} did not start, because free memory stayed under the ${gigabytes(floorBytes)} GB floor for ${minutes(deadlineMs)} min. Free memory is ${gigabytes(free)} GB. ${MEMORY_FLOOR_ENV} moves the floor.`,
        MEMORY_TIMEOUT_EXIT,
      );
    if (lastNotice === null || waited - lastNotice >= NOTICE_MS) {
      lastNotice = waited;
      log(
        `${label} waits for free memory: ${gigabytes(free)} GB free, floor ${gigabytes(floorBytes)} GB. Waited ${seconds(waited)} s of ${minutes(deadlineMs)} min.`,
      );
    }
    await waitForPoll(Math.min(pollMs, deadlineMs - waited));
  }
}

function lockOwnerPid(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8')).pid ?? null;
  } catch {
    return null;
  }
}

function describeHolder(owner) {
  if (!owner) return 'an unreadable lock record';
  const started = owner.startedAt ? `started ${owner.startedAt}` : 'start time unknown';
  const command = owner.command ? `, running ${owner.command}` : '';
  return `PID ${owner.pid}, ${started}${command}`;
}

// Take the machine suite lock, or return a nested holder when a live ancestor already holds it.
// The holder's children inherit SUITE_HOLDER_ENV until release.
export async function acquireSuiteLock({
  env = process.env,
  command = process.argv.join(' '),
  deadlineMs,
  lockPath = SUITE_LOCK_PATH,
  pid = process.pid,
  log = console.log,
  isProcessAlive = processExists,
  ...lockOptions
}) {
  const ancestor = Number(env[SUITE_HOLDER_ENV]);
  if (
    Number.isInteger(ancestor) &&
    ancestor > 0 &&
    ancestor !== pid &&
    lockOwnerPid(lockPath) === ancestor &&
    isProcessAlive(ancestor)
  )
    return { nested: true, release: () => false };
  let lastNotice = null;
  let lock;
  try {
    lock = await acquireBrowserLock({
      lockPath,
      pid,
      label: 'suite',
      heading: 'The test suite',
      command,
      deadlineMs,
      isProcessAlive,
      onWaiting: ({ owner, waitedMs }) => {
        if (lastNotice !== null && waitedMs - lastNotice < NOTICE_MS) return;
        lastNotice = waitedMs;
        log(
          `The test suite waits for another run on this machine: ${describeHolder(owner)}. Waited ${seconds(waitedMs)} s of ${minutes(deadlineMs)} min.`,
        );
      },
      ...lockOptions,
    });
  } catch (error) {
    if (error.code !== 'ARC_LOCK_TIMEOUT') throw error;
    throw new MachineLoadTimeout(
      `Another test run held the machine suite lock for ${minutes(deadlineMs)} min, so this run did not start. The holder was ${describeHolder(error.owner)}. ${DEADLINE_ENV} moves the limit.`,
      SUITE_LOCK_TIMEOUT_EXIT,
    );
  }
  const previous = env[SUITE_HOLDER_ENV];
  env[SUITE_HOLDER_ENV] = String(pid);
  return {
    nested: false,
    release() {
      if (previous === undefined) delete env[SUITE_HOLDER_ENV];
      else env[SUITE_HOLDER_ENV] = previous;
      return lock.release();
    },
  };
}

// Hold the suite lock around a multi-lane run and give it a per-lane memory wait.
// A nested run skips both, because its ancestor admitted the lane that started it.
// options = false disables the guard for in-process tests.
export async function holdMachineLoad(run, options = {}) {
  if (options === false) return run(async () => {});
  const {
    env = process.env,
    log = console.log,
    readFree,
    monotonicNow,
    waitForPoll,
    memoryPollMs,
    ...lockOptions
  } = options;
  const { deadlineMs, floorBytes } = loadSettings(env);
  const lock = await acquireSuiteLock({ env, log, deadlineMs, monotonicNow, waitForPoll, ...lockOptions });
  try {
    return await run(async (label, signal) => {
      if (lock.nested) return;
      await waitForMemory({
        floorBytes,
        deadlineMs,
        label,
        log,
        readFree,
        monotonicNow,
        waitForPoll,
        pollMs: memoryPollMs,
        signal,
      });
    });
  } finally {
    lock.release();
  }
}

// Vitest reads a percentage against the available parallelism and any other value as a JavaScript number.
// The cap applies to the resolved count.
function cappedWorkers(value, cores) {
  const text = String(value).trim();
  const percent = /^(\d+(?:\.\d+)?)%$/.exec(text);
  const count = percent
    ? Math.max(1, Math.min(cores, Math.round((Number(percent[1]) / 100) * cores)))
    : text && Number.isFinite(Number(text))
      ? Number(text)
      : null;
  if (count === null || count <= MAX_VITEST_WORKERS) return null;
  return String(MAX_VITEST_WORKERS);
}

const WORKER_FLAG = /^(--maxWorkers|--max-workers)(?:=(.*))?$/;

export const hasWorkerFlag = (args) => args.some((arg) => WORKER_FLAG.test(arg));

// Rewrite any Vitest worker flag above the cap and report each rewrite.
export function clampWorkerArgs(args, { log = console.log, cores = availableParallelism() } = {}) {
  const result = [];
  for (let index = 0; index < args.length; index++) {
    const match = WORKER_FLAG.exec(args[index]);
    if (!match) {
      result.push(args[index]);
      continue;
    }
    const [, flag, inline] = match;
    const separate = inline === undefined && index + 1 < args.length && !args[index + 1].startsWith('-');
    const value = inline ?? (separate ? args[++index] : undefined);
    const capped = value === undefined ? null : cappedWorkers(value, cores);
    if (capped)
      log(
        `Vitest runs ${capped} workers instead of ${flag} ${value}. A lane on this machine runs at most ${MAX_VITEST_WORKERS}.`,
      );
    if (separate) result.push(flag, capped ?? value);
    else result.push(value === undefined ? args[index] : `${flag}=${capped ?? value}`);
  }
  return result;
}

// Vitest gives VITEST_MAX_WORKERS precedence over its configuration and command line.
// Return the environment unchanged when the value is absent or within the cap.
export function clampWorkerEnvironment(env, { log = console.log } = {}) {
  const value = env.VITEST_MAX_WORKERS;
  if (!value || !(Number.parseInt(value) > MAX_VITEST_WORKERS)) return env;
  log(
    `Vitest runs ${MAX_VITEST_WORKERS} workers instead of VITEST_MAX_WORKERS=${value}. A lane on this machine runs at most ${MAX_VITEST_WORKERS}.`,
  );
  return { ...env, VITEST_MAX_WORKERS: String(MAX_VITEST_WORKERS) };
}
