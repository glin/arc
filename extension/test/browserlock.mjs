// Plain Node ESM with no vitest import, so extension/test.mjs can load it directly and the
// root test runner can load it too. One lock file in the system temporary directory bounds
// the whole machine to one browser-lane run at a time, across every worktree and checkout,
// because each run already spends its own --maxWorkers=4 worth of headless browsers.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { linkSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { processExists } from './browserchannels.mjs';

export const BROWSER_LOCK_PATH = join(tmpdir(), 'arc-browser-tests.lock');
const BROWSER_LOCK_POLL_MS = 2_000;
export const BROWSER_LOCK_DEADLINE_MS = 30 * 60_000;
export const BROWSER_LOCK_STALE_AFTER_MS = 3 * 60_000;
export const BROWSER_LOCK_HEARTBEAT_MS = 30_000;
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

// Reads the raw text once and parses it once, so a caller that later needs to compare content
// never reads the file a second time and risks seeing bytes a concurrent writer changed in
// between. An owner with a missing or non-positive pid parses to no owner, the same as text
// that is not valid JSON at all.
function readLock(lockPath) {
  let text;
  try {
    text = readFileSync(lockPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { text: null, mtimeMs: null, owner: null };
    throw error;
  }
  let mtimeMs = null;
  try {
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let owner = null;
  try {
    const parsed = JSON.parse(text);
    if (Number.isInteger(parsed.pid) && parsed.pid > 0) owner = parsed;
  } catch {
    // Not valid JSON. The publish path below never leaves a lock file in this state, so this
    // only covers a leftover from the hard-link fallback or a lock this scheme never wrote.
  }
  return { text, mtimeMs, owner };
}

// owner is null when the lock file is empty, corrupt, or holds no valid pid. The lock is then
// stale at once, but a rename can still fail with EPERM, EACCES, or EBUSY before the takeover
// completes, so the waiter reaches this with no owner to describe.
function describeHolder(owner) {
  if (!owner) return 'an unreadable lock record';
  const where = owner.cwd ? ` in ${owner.cwd}` : '';
  const since = owner.startedAt ? ` (started ${owner.startedAt})` : '';
  return `PID ${owner.pid}${where}${since}`;
}

// A dead or unparseable owner is stale at once. A live owner is stale only once this waiter's
// own polls have watched the lock file's mtime sit unchanged for the whole stale age, measured
// on the waiter's monotonic clock across consecutive polls, never by comparing the wall clock
// against the mtime directly. A wall-clock comparison reads a live lock as stale the moment the
// machine wakes from a sleep, because the wall clock jumps forward by the sleep length while
// the holder's heartbeat simply has not had a tick yet.
//
// The observation restarts whenever the mtime moves, because the heartbeat ticked, or whenever
// the gap between two consecutive polls is itself large enough to mean the machine suspended
// between them: more than five poll intervals. That keeps a suspend-and-wake from being
// mistaken for a long stretch of a stuck heartbeat.
function stepStaleObservation(observation, owner, mtimeMs, monotonicNow, isProcessAlive, staleAfterMs, pollMs) {
  if (!owner || !isProcessAlive(owner.pid)) return { stale: true, observation: null };
  if (mtimeMs === null) return { stale: true, observation: null };
  const at = monotonicNow();
  const suspended = observation !== null && at - observation.lastPollAt > pollMs * 5;
  const continued = observation !== null && !suspended && observation.mtimeMs === mtimeMs;
  const since = continued ? observation.since : at;
  return { stale: at - since >= staleAfterMs, observation: { mtimeMs, since, lastPollAt: at } };
}

// Publishes the lock file exclusively and atomically: the content is written to a private
// temporary file first, and only a filesystem link, which never replaces an existing path,
// makes it visible at lockPath. A reader can therefore never observe an empty or partially
// written lock file, unlike a plain create-then-write. Falls back to the old exclusive-create
// scheme on a filesystem with no hard-link support, which reopens that narrow window.
function publishLock(lockPath, text, pid) {
  const temp = join(dirname(lockPath), `.arc-browser-tests.lock.tmp-${pid}-${randomUUID()}`);
  writeFileSync(temp, text, { flag: 'wx' });
  try {
    try {
      linkSync(temp, lockPath);
      return true;
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      if (error.code !== 'EPERM' && error.code !== 'ENOTSUP' && error.code !== 'EXDEV') throw error;
      try {
        writeFileSync(lockPath, text, { flag: 'wx' });
        return true;
      } catch (fallbackError) {
        if (fallbackError.code === 'EEXIST') return false;
        throw fallbackError;
      }
    }
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // Already gone, or the link above moved past it.
    }
  }
}

// Links the retired file back onto lockPath, which fails instead of replacing anything a third
// run has since published there. A plain rename back, the previous scheme, could silently
// overwrite that fresh lock, which is exactly the race this restore exists to avoid.
function restoreRetiredLock(retired, lockPath, { link = linkSync, write = writeFileSync } = {}) {
  try {
    link(retired, lockPath);
    unlinkSync(retired);
    return;
  } catch (error) {
    if (error.code === 'EEXIST') {
      try {
        unlinkSync(retired);
      } catch {
        // Another cleanup already removed it.
      }
      return;
    }
    if (error.code === 'EPERM' || error.code === 'ENOTSUP' || error.code === 'EXDEV') {
      // The same filesystem constraint that sends publishLock to its exclusive-create fallback
      // applies here too. A plain rename back would replace a lock a third run has since
      // published at lockPath while that run is still using it; an exclusive create fails
      // instead, the same outcome the EEXIST branch above reaches on a filesystem with hard
      // links.
      let text;
      try {
        text = readFileSync(retired, 'utf8');
      } catch {
        return; // The retired file is already gone. Nothing left to restore.
      }
      try {
        write(lockPath, text, { flag: 'wx' });
      } catch (writeError) {
        if (writeError.code !== 'EEXIST') throw writeError;
      }
      try {
        unlinkSync(retired);
      } catch {
        // Another cleanup already removed it.
      }
      return;
    }
    throw error;
  }
}

// Renames the lock aside so it stops answering to its own name, the same move that makes a
// concurrent create possible. A rename off one path is atomic, so of two racers that both read
// the same stale content, at most one lands here before the path is gone for the other, whose
// rename then fails with ENOENT and takes over nothing.
//
// The remaining risk is a racer whose rename lands after the winner has already published a
// fresh lock in the freed spot: its rename would move that fresh lock aside instead of the
// stale one it meant to take. Comparing the file it actually took against the text it read
// before acting catches the common two-racer case, because the two differ whenever a writer
// landed in between, and this restores the file it took.
//
// A third racer publishing between that comparison and the restore can still make the restore
// find its own path already occupied, in which case it gives up and leaves whatever record is
// already there. That is a rare three-way race during stale-lock takeover, and it is the one
// case in which this scheme's one-lane guarantee does not hold: a live holder's lock can end up
// removed with a stranger's record standing in its place. Closing that window needs an
// OS-level lock, which this scheme does not build.
// Returns why the takeover did or did not happen, so a caller can tell an ordinary race
// ('vanished', 'taken') from a rename that a lock this process should keep waiting on
// ('busy'), instead of collapsing every non-takeover into one falsy result.
function retireStaleLock(
  lockPath,
  expectedText,
  ownPid,
  { rename = renameSync, link = linkSync, write = writeFileSync } = {},
) {
  const retired = `${lockPath}.stale-${ownPid}-${randomUUID()}`;
  try {
    rename(lockPath, retired);
  } catch (error) {
    if (error.code === 'ENOENT') return 'vanished';
    if (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EBUSY') return 'busy';
    throw error;
  }
  let takenText = null;
  try {
    takenText = readFileSync(retired, 'utf8');
  } catch {
    // Nothing readable came along with the rename.
  }
  if (takenText !== expectedText) {
    restoreRetiredLock(retired, lockPath, { link, write });
    return 'taken';
  }
  try {
    unlinkSync(retired);
  } catch {
    // Another cleanup already removed it.
  }
  return 'retired';
}

function defaultScheduleHeartbeat(tick, milliseconds) {
  const timer = setInterval(() => tick(), milliseconds);
  timer.unref?.();
  return timer;
}

// Refreshes the lock file's mtime while this process holds it, so a waiter's staleness check
// tells a holder that is merely slow from one that is dead or hung. Checks ownership on every
// tick instead of assuming it, so a lock this process no longer holds is never touched. Takes
// the same clock the caller acquired the lock with, so a test can set the tick's time exactly
// instead of racing the filesystem's write-time precision against `Date.now`'s millisecond one.
function startHeartbeat(lockPath, pid, scheduleHeartbeat, heartbeatMs, now) {
  return scheduleHeartbeat(() => {
    try {
      if (readLock(lockPath).owner?.pid !== pid) return;
      const tickTime = new Date(now());
      utimesSync(lockPath, tickTime, tickTime);
    } catch {
      // The lock is gone or unreadable. The next tick, or a waiter's own poll, will sort it out.
    }
  }, heartbeatMs);
}

export async function acquireBrowserLock({
  lockPath = BROWSER_LOCK_PATH,
  pid = process.pid,
  cwd = process.cwd(),
  now = Date.now,
  monotonicNow = () => performance.now(),
  isProcessAlive = processExists,
  waitForPoll = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
  pollMs = BROWSER_LOCK_POLL_MS,
  deadlineMs = BROWSER_LOCK_DEADLINE_MS,
  staleAfterMs = BROWSER_LOCK_STALE_AFTER_MS,
  heartbeatMs = BROWSER_LOCK_HEARTBEAT_MS,
  scheduleHeartbeat = defaultScheduleHeartbeat,
  cancelHeartbeat = clearInterval,
  rename = renameSync,
} = {}) {
  let announced = false;
  let staleObservation = null;
  const waitStartedAt = monotonicNow();
  const deadline = waitStartedAt + deadlineMs;
  while (true) {
    // Built fresh on every attempt, so a lock this call ends up waiting on still carries the
    // start time of the attempt that actually acquired it, not the moment the wait began.
    const text = JSON.stringify({ pid, cwd, startedAt: new Date(now()).toISOString() });
    if (publishLock(lockPath, text, pid)) {
      if (announced) {
        console.log(`Browser tests resumed after ${Math.round(monotonicNow() - waitStartedAt)} ms waiting.`);
      }
      const heartbeat = startHeartbeat(lockPath, pid, scheduleHeartbeat, heartbeatMs, now);
      let released = false;
      return {
        release() {
          if (released) return false;
          released = true;
          cancelHeartbeat(heartbeat);
          let current;
          try {
            current = readLock(lockPath).owner;
          } catch (error) {
            console.error(`Could not release the browser test lock: ${error.message}`);
            return false;
          }
          if (!current || current.pid !== pid) return false;
          try {
            rmSync(lockPath, { force: true });
          } catch (error) {
            console.error(`Could not release the browser test lock: ${error.message}`);
            return false;
          }
          return true;
        },
      };
    }
    const { text: currentText, mtimeMs, owner: current } = readLock(lockPath);
    if (currentText === null) {
      staleObservation = null;
      continue; // The lock vanished between our publish attempt and our read.
    }
    const step = stepStaleObservation(
      staleObservation,
      current,
      mtimeMs,
      monotonicNow,
      isProcessAlive,
      staleAfterMs,
      pollMs,
    );
    staleObservation = step.observation;
    if (step.stale) {
      // A rename that fails because the lock vanished, or that wins or loses an ordinary race,
      // means this process's view of the lock is already out of date: retry at once with a
      // fresh read. A rename that fails because something else holds the file open (antivirus,
      // an indexer, or a dead-PID lock owned by another user in a sticky /tmp) leaves the lock
      // exactly as it was, so retrying at once would spin at full CPU until the deadline; fall
      // through to the poll below instead, the same as an ordinary live, non-stale holder.
      const reason = retireStaleLock(lockPath, currentText, pid, { rename });
      if (reason !== 'busy') {
        staleObservation = null;
        continue;
      }
    }
    if (!announced) {
      console.log(`Browser tests are waiting for another run to finish: held by ${describeHolder(current)}.`);
      announced = true;
    }
    const remaining = deadline - monotonicNow();
    if (remaining <= 0) {
      throw new Error(`Timed out waiting for the browser test lock held by ${describeHolder(current)}.`);
    }
    await waitForPoll(Math.min(pollMs, remaining));
  }
}

// Windows does not tear down a process tree on a plain kill: the vitest child would die but its
// headless browsers would not, which is exactly what the lock exists to bound. taskkill's /T
// walks the tree; POSIX signals already propagate to a foreground child's own children.
function killProcessTree(child, signal) {
  if (process.platform === 'win32' && child.pid) {
    const result = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    if (!result.error) return;
  }
  child.kill(signal);
}

// Ctrl+C on Windows delivers SIGINT to the child Vitest process directly, but the parent
// running test.mjs also receives it. Left alone it would exit immediately and free the lock
// while the child, and its headless browsers, are still shutting down. Forwarding the signal to
// the child, waiting for it to close, and only then releasing the lock keeps the machine-wide
// bound intact through a Ctrl+C the same way it holds through a normal run. A short hard
// fallback still frees the lock if the child never closes, so a hung shutdown cannot wedge the
// lock forever.
export function forwardSignalToChildAndRelease(
  child,
  lock,
  {
    processEmitter = process,
    killTree = killProcessTree,
    hardFallbackMs = 5_000,
    scheduleFallback = (fn, milliseconds) => {
      const timer = setTimeout(() => fn(), milliseconds);
      timer.unref?.();
      return timer;
    },
    cancelFallback = clearTimeout,
  } = {},
) {
  // process.on('SIGINT', listener) calls listener with no argument, so each signal needs its
  // own closure over its own name rather than reading it from the callback.
  let handled = false;
  const bound = Object.keys(SIGNAL_EXIT_CODES).map((signal) => {
    const handler = () => {
      if (handled) return;
      handled = true;
      const fallbackTimer = scheduleFallback(() => {
        lock.release();
        processEmitter.exit(SIGNAL_EXIT_CODES[signal]);
      }, hardFallbackMs);
      child.once('close', () => {
        cancelFallback(fallbackTimer);
        lock.release();
        processEmitter.exit(SIGNAL_EXIT_CODES[signal]);
      });
      killTree(child, signal);
    };
    return [signal, handler];
  });
  for (const [signal, handler] of bound) processEmitter.on(signal, handler);
  return function detach() {
    for (const [signal, handler] of bound) processEmitter.off(signal, handler);
  };
}

// Exported for tests only, so a takeover race can be proven directly against the filesystem
// instead of relying on two Node processes actually interleaving.
export const forTesting = { retireStaleLock, stepStaleObservation };
