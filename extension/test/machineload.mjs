// Plain Node ESM lets extension/test.mjs and the root suite runner import this module.
// A test run admits each lane by its load class. Static lanes start at once, and unit lanes wait for their memory
// floor. A heavy lane takes its own machine lock, so one run of that lane uses the machine at a time, and then waits
// for its memory floor. Every Vitest lane runs at most four workers.
// The lane locks use the lock code of browserlock.mjs, including its stale-holder takeover and its three-run race.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, freemem, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { processExists } from './browserchannels.mjs';
import { acquireBrowserLock } from './browserlock.mjs';

// A top-level run and a lock holder add an entry to this chain for their children, so a lane that an admitted run
// starts does not wait again. Each entry is PID:token, and the holder keeps a marker file for the token while it runs.
// A run counts as nested when an entry names another live process with its marker file. A nested run skips memory
// waits, and it takes a heavy lane lock unless such a process owns it.
export const SUITE_HOLDER_ENV = 'ARC_TEST_SUITE_HOLDER';
export const DEADLINE_ENV = 'ARC_TEST_LOAD_DEADLINE_MINUTES';
export const MEMORY_FLOOR_ENV = 'ARC_TEST_MEMORY_FLOOR_GB';
export const DEFAULT_DEADLINE_MINUTES = 40;
export const LANE_LOCK_TIMEOUT_EXIT = 75;
export const MEMORY_TIMEOUT_EXIT = 76;
export const MAX_VITEST_WORKERS = 4;
const NOTICE_MS = 30_000;
const MEMORY_POLL_MS = 5_000;
const GIB = 1024 ** 3;

// Each floor is 1.5 times the lane's measured peak private working set at four workers, summed over its process tree.
// A unit floor is at least 1 GB, and a heavy floor is at least 2 GB. The performance plan records the measurements.
const STATIC = Object.freeze({ floorGb: 0, lock: false });
const unit = (floorGb) => Object.freeze({ floorGb, lock: false });
const heavy = (floorGb) => Object.freeze({ floorGb, lock: true });
export const LANE_LOADS = Object.freeze({
  format: STATIC,
  'lint-js': STATIC,
  'lint-css': STATIC,
  'webview-globals': STATIC,
  'extension-tsc': STATIC,
  'webview-tsc': STATIC,
  'cli-tsc': STATIC,
  'cli-build': STATIC,
  'root-units': unit(1),
  'extension-units': unit(3.6),
  'cli-units': unit(1.5),
  'root-subprocess': unit(1),
  'hook-smoke': unit(1),
  'cli-smoke': unit(2.8),
  browser: heavy(4),
  'panel-mockup': heavy(2),
  'extension-integration': heavy(5.2),
});
export const HEAVY_LANES = Object.freeze(Object.keys(LANE_LOADS).filter((lane) => LANE_LOADS[lane].lock));

// The browser lane keeps the lock name that extension/test/browserlock.mjs and the isolated editor use.
export const laneLockPath = (lane, directory = tmpdir()) => join(directory, `arc-${lane}-tests.lock`);

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

// floorGb is null unless MEMORY_FLOOR_ENV replaces every lane floor.
export function loadSettings(env = process.env) {
  const deadlineMinutes = setting(env, DEADLINE_ENV, DEFAULT_DEADLINE_MINUTES, false);
  const floorGb = setting(env, MEMORY_FLOOR_ENV, null, true);
  return { deadlineMs: deadlineMinutes * 60_000, floorGb };
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

const markerPath = (directory, pid, token) => join(directory ?? tmpdir(), 'arc-test-holders', `${pid}-${token}`);

function holderEntries(env) {
  return String(env[SUITE_HOLDER_ENV] ?? '')
    .split(' ')
    .map((entry) => /^(\d+):([\w-]+)$/.exec(entry))
    .filter(Boolean)
    .map(([, pid, token]) => ({ pid: Number(pid), token }));
}

// The live processes other than this one that SUITE_HOLDER_ENV names with a current marker file.
// A stale or copied value names a process that ended, or a token without a marker, so it admits nothing.
export function admittedHolders(env, { pid = process.pid, isProcessAlive = processExists, lockDirectory } = {}) {
  return holderEntries(env)
    .filter((entry) => entry.pid !== pid && isProcessAlive(entry.pid))
    .filter((entry) => existsSync(markerPath(lockDirectory, entry.pid, entry.token)))
    .map((entry) => entry.pid);
}

// Add this process to the holder chain for its children, and return the function that removes it.
// A process that the chain already names with a current marker keeps that entry.
export function markHolder(env, { pid = process.pid, lockDirectory, processEmitter = process } = {}) {
  if (holderEntries(env).some((entry) => entry.pid === pid && existsSync(markerPath(lockDirectory, pid, entry.token))))
    return () => {};
  const token = randomUUID();
  const marker = markerPath(lockDirectory, pid, token);
  mkdirSync(join(marker, '..'), { recursive: true });
  writeFileSync(marker, '');
  const removeMarker = () => rmSync(marker, { force: true });
  processEmitter.once('exit', removeMarker);
  const previous = env[SUITE_HOLDER_ENV];
  env[SUITE_HOLDER_ENV] = [previous, `${pid}:${token}`].filter(Boolean).join(' ');
  return () => {
    processEmitter.off('exit', removeMarker);
    removeMarker();
    if (previous === undefined) delete env[SUITE_HOLDER_ENV];
    else env[SUITE_HOLDER_ENV] = previous;
  };
}

// The lane locks that each process in this module holds, so a second request from that process counts as nested.
const heldLocks = new Set();

// Take a heavy lane's machine lock. The run is nested when this process holds the lock, or when an admitted holder
// in SUITE_HOLDER_ENV owns it. The holder's children inherit its entry in SUITE_HOLDER_ENV until release.
// A cancelled signal ends the wait and returns null.
export async function acquireLaneLock({
  lane,
  label = `The ${lane} lane`,
  env = process.env,
  command = process.argv.join(' '),
  deadlineMs = loadSettings(env).deadlineMs,
  lockDirectory,
  lockPath = laneLockPath(lane, lockDirectory),
  pid = process.pid,
  log = console.log,
  isProcessAlive = processExists,
  ...lockOptions
}) {
  const held = `${pid}|${lockPath}`;
  const owner = lockOwnerPid(lockPath);
  if (
    heldLocks.has(held) ||
    (owner !== null && admittedHolders(env, { pid, isProcessAlive, lockDirectory }).includes(owner))
  ) {
    lockOptions.observation?.unavailable('queue', 'The run that started this lane holds its lock.');
    return { nested: true, release: () => false };
  }
  let lastNotice = null;
  let lock;
  try {
    lock = await acquireBrowserLock({
      lockPath,
      pid,
      label: lane,
      heading: label,
      command,
      deadlineMs,
      isProcessAlive,
      onWaiting: ({ owner, held, ahead, waitedMs }) => {
        if (lastNotice !== null && waitedMs - lastNotice < NOTICE_MS) return;
        lastNotice = waitedMs;
        const blocker = held
          ? `for another run of this lane on this machine: ${describeHolder(owner)}`
          : 'for its turn on this machine';
        log(
          `${label} waits ${blocker}. ${ahead} ahead in the queue. Waited ${seconds(waitedMs)} s of ${minutes(deadlineMs)} min.`,
        );
      },
      ...lockOptions,
    });
  } catch (error) {
    if (error.code === 'ARC_LOCK_CANCELLED') return null;
    if (error.code !== 'ARC_LOCK_TIMEOUT') throw error;
    const cause = error.held
      ? `${label} did not start, because another run held its machine lock for ${minutes(deadlineMs)} min. The holder was ${describeHolder(error.owner)}.`
      : `${label} did not start, because earlier runs in its machine queue were still ahead after ${minutes(deadlineMs)} min.`;
    throw new MachineLoadTimeout(
      `${cause} ${error.ahead} ahead in the queue. ${DEADLINE_ENV} moves the limit.`,
      LANE_LOCK_TIMEOUT_EXIT,
    );
  }
  heldLocks.add(held);
  const unmark = markHolder(env, { pid, lockDirectory, processEmitter: lockOptions.processEmitter });
  return {
    nested: false,
    release() {
      unmark();
      heldLocks.delete(held);
      return lock.release();
    },
  };
}

// Give a multi-lane run an admission step for each lane, by the lane's load class.
// A static lane starts at once. A unit lane waits for its memory floor. A heavy lane takes its machine lock, then
// waits for the heavy floor. The admission returns a release that the run calls when the lane ends.
// A nested run skips every memory wait, because its holder admitted the lane that started it.
// options = false disables the guard for in-process tests.
export async function holdMachineLoad(run, options = {}) {
  if (options === false) return run(async () => () => {});
  const {
    env = process.env,
    log = console.log,
    pid = process.pid,
    isProcessAlive = processExists,
    readFree,
    monotonicNow,
    waitForPoll,
    memoryPollMs,
    lockDirectory,
    ...lockOptions
  } = options;
  const { deadlineMs, floorGb } = loadSettings(env);
  const nested = admittedHolders(env, { pid, isProcessAlive, lockDirectory }).length > 0;
  const held = new Set();
  // A top-level run marks its children, so a run that one of its lanes starts counts as nested.
  const unmark = nested
    ? () => {}
    : markHolder(env, { pid, lockDirectory, processEmitter: lockOptions.processEmitter });
  try {
    return await run(async (lane, label, signal) => {
      const load = lane.load ?? LANE_LOADS[lane.id];
      if (!load) throw Error(`The ${lane.id} lane has no load class in LANE_LOADS of extension/test/machineload.mjs.`);
      const lock = load.lock
        ? await acquireLaneLock({
            lane: lane.id,
            label,
            env,
            deadlineMs,
            pid,
            log,
            isProcessAlive,
            monotonicNow,
            waitForPoll,
            signal,
            lockDirectory,
            ...lockOptions,
          })
        : null;
      const release = () => {
        held.delete(release);
        lock?.release();
      };
      held.add(release);
      // The environment floor replaces each lane floor, and a static lane keeps none.
      const floor = load.floorGb ? (floorGb ?? load.floorGb) : 0;
      if (signal?.aborted || nested || !floor) return release;
      try {
        await waitForMemory({
          floorBytes: floor * GIB,
          deadlineMs,
          label,
          log,
          readFree,
          monotonicNow,
          waitForPoll,
          pollMs: memoryPollMs,
          signal,
        });
      } catch (error) {
        release();
        throw error;
      }
      return release;
    });
  } finally {
    for (const release of held) release();
    unmark();
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
