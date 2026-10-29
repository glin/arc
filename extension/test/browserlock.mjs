// Plain Node ESM lets extension/test.mjs and the root test runner import this module.
// A shared temporary lock limits the machine to one browser lane across checkouts.
// Each lane launches up to four workers. Stale-lock takeover has a three-run race described below.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
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

// Read and parse the content once so later comparisons use the same bytes.
// Invalid JSON or a missing or non-positive PID produces no owner.
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
    // Invalid JSON leaves no owner. Exclusive-create fallback can expose incomplete content.
  }
  return { text, mtimeMs, owner };
}

// Empty, corrupt, or invalid-PID content has no owner.
// A stale-lock rename can fail while another process holds the file open.
function describeHolder(owner) {
  if (!owner) return 'an unreadable lock record';
  const where = owner.cwd ? ` in ${owner.cwd}` : '';
  const since = owner.startedAt ? ` (started ${owner.startedAt})` : '';
  const running = owner.command ? ` running ${owner.command}` : '';
  return `PID ${owner.pid}${where}${since}${running}`;
}

// Missing or dead owners and missing mtimes are stale immediately.
// For live owners, consecutive polls must observe an unchanged mtime for the full stale age.
// Measure that age with the waiter's monotonic clock. Wall-clock jumps after sleep can exceed it before the next heartbeat.
// Restart the observation when mtime changes or the poll gap exceeds five intervals.
function stepStaleObservation(observation, owner, mtimeMs, monotonicNow, isProcessAlive, staleAfterMs, pollMs) {
  if (!owner || !isProcessAlive(owner.pid)) return { stale: true, observation: null };
  if (mtimeMs === null) return { stale: true, observation: null };
  const at = monotonicNow();
  const suspended = observation !== null && at - observation.lastPollAt > pollMs * 5;
  const continued = observation !== null && !suspended && observation.mtimeMs === mtimeMs;
  const since = continued ? observation.since : at;
  return { stale: at - since >= staleAfterMs, observation: { mtimeMs, since, lastPollAt: at } };
}

// Publish fully written content with a hard link that never replaces an existing path.
// Without hard-link support, exclusive creation can expose empty or partially written content.
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
      // Ignore temporary-file cleanup errors.
    }
  }
}

// Restore the retired file with a hard link that never replaces another run's lock.
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
      // Without hard-link support, exclusive creation also preserves an existing lock.
      // A rename would overwrite it.
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

// Rename the stale lock aside before publishing a replacement.
// Concurrent renames of that path leave one winner and one ENOENT result.
// A delayed rename can take a replacement lock. Compare its content with the earlier read and restore mismatches.
// A third run can publish before restoration. Its lock then remains, but the displaced holder loses its lock.
// This three-run race can allow multiple lanes. Preventing it requires an OS-level lock.
// Return 'vanished' or 'taken' for races and 'busy' for a file that must wait before another attempt.
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

// Each waiter keeps a ticket in a directory beside the lock until it acquires the lock or stops waiting.
// A waiter takes a free lock only when no living ticket is older than its own, so waiters run in arrival order.
function queueDirectory(lockPath) {
  return `${lockPath}.queue`;
}

// Order by start time, then PID, then file name, so tickets written in the same millisecond still order.
function ticketPrecedes(a, b) {
  if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt;
  if (a.pid !== b.pid) return a.pid < b.pid;
  return a.name < b.name;
}

// Write or refresh a ticket. The mtime follows the injected clock, like the lock heartbeat.
// Another waiter can remove a ticket it judged stale, so a missing ticket is written again.
function refreshTicket(ticket, now) {
  const at = new Date(now());
  try {
    utimesSync(ticket.path, at, at);
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') return;
  }
  try {
    mkdirSync(dirname(ticket.path), { recursive: true });
    writeFileSync(ticket.path, ticket.text);
    utimesSync(ticket.path, at, at);
  } catch {
    // A failed write leaves this waiter out of the queue until the next poll retries.
  }
}

// Count the living tickets ahead of own, or every living ticket before this waiter has one.
// A ticket whose process ended is removed. A ticket unrefreshed for the stale age is also removed,
// because a later process can reuse its PID. A partly written ticket is skipped until it parses.
function ticketsAhead(lockPath, own, { isProcessAlive, now, staleAfterMs }) {
  const directory = queueDirectory(lockPath);
  let names;
  try {
    names = readdirSync(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  let ahead = 0;
  for (const name of names) {
    if (!name.endsWith('.json') || name === own?.name) continue;
    const path = join(directory, name);
    let text;
    let mtimeMs;
    try {
      text = readFileSync(path, 'utf8');
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue; // The ticket left the queue during the read.
    }
    let ticket = null;
    try {
      const parsed = JSON.parse(text);
      if (Number.isInteger(parsed.pid) && parsed.pid > 0 && Number.isFinite(parsed.startedAt)) ticket = parsed;
    } catch {
      // Unparsed content counts as written in part.
    }
    const stale = now() - mtimeMs >= staleAfterMs;
    if (stale || (ticket && !isProcessAlive(ticket.pid))) {
      try {
        rmSync(path, { force: true });
      } catch {
        // Windows refuses removal while another waiter reads the ticket. A later poll retries.
      }
      continue;
    }
    if (ticket && (!own || ticketPrecedes({ ...ticket, name }, own))) ahead++;
  }
  return ahead;
}

function defaultScheduleHeartbeat(tick, milliseconds) {
  const timer = setInterval(() => tick(), milliseconds);
  timer.unref?.();
  return timer;
}

// Refresh mtime only while this PID owns the lock.
// The injected clock lets tests set heartbeat timestamps without depending on filesystem timestamp precision.
function startHeartbeat(lockPath, pid, scheduleHeartbeat, heartbeatMs, now) {
  return scheduleHeartbeat(() => {
    try {
      if (readLock(lockPath).owner?.pid !== pid) return;
      const tickTime = new Date(now());
      utimesSync(lockPath, tickTime, tickTime);
    } catch {
      // Ignore heartbeat read and timestamp errors. Later ticks retry.
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
  label = 'browser',
  staleAfterMs = BROWSER_LOCK_STALE_AFTER_MS,
  heartbeatMs = BROWSER_LOCK_HEARTBEAT_MS,
  scheduleHeartbeat = defaultScheduleHeartbeat,
  cancelHeartbeat = clearInterval,
  rename = renameSync,
  observation = null,
  tryOnly = false,
  heading = `${label[0].toUpperCase()}${label.slice(1)} tests`,
  command = null,
  onWaiting = null,
  processEmitter = process,
} = {}) {
  const lockName = `${label} test lock`;
  let announced = false;
  let staleObservation = null;
  const waitStartedAt = monotonicNow();
  const deadline = waitStartedAt + deadlineMs;
  const arrivedAt = now();
  observation?.begin('queue', { lockPath, deadlineMs, queuePosition: null });
  let holder = null;
  let lastHolderNotice = -Infinity;
  const observeHolder = (owner, text, mtimeMs, ahead) => {
    if (!observation) return;
    const at = monotonicNow();
    const changed = holder?.text !== text;
    if (changed) holder = { text, since: at };
    if (!changed && at - lastHolderNotice < 30_000) return;
    lastHolderNotice = at;
    const detail = {
      lockPath,
      observedAt: new Date(now()).toISOString(),
      holder: owner,
      mtimeMs,
      observedHolderMs: at - holder.since,
      holderDuration: 'before first observation unavailable',
      queuePosition: ahead,
    };
    observation.event('queue', 'holder', detail);
    if (!tryOnly)
      console.log(
        `${heading} holder observed at ${detail.observedAt}: ${describeHolder(owner)}. Observed for ${Math.round(detail.observedHolderMs)} ms. ${ahead} ahead in the queue.`,
      );
  };
  // The first wait writes the ticket. Until the wait ends, an exit or a signal removes it.
  // A signal with no other listener ends the process, as it does without this handler.
  let ticket = null;
  let leaveSignals = () => {};
  const leaveQueue = () => {
    if (!ticket) return;
    try {
      rmSync(ticket.path, { force: true });
    } catch {
      // The next waiter removes the ticket once this process ends.
    }
  };
  const joinQueue = () => {
    const name = `${pid}-${randomUUID()}.json`;
    ticket = {
      name,
      pid,
      startedAt: arrivedAt,
      path: join(queueDirectory(lockPath), name),
      text: JSON.stringify({ pid, startedAt: arrivedAt, cwd, ...(command ? { command } : {}) }),
    };
    refreshTicket(ticket, now);
    const handlers = Object.keys(SIGNAL_EXIT_CODES).map((signal) => {
      const handler = () => {
        leaveQueue();
        if (processEmitter.listenerCount(signal) === 1) processEmitter.exit(SIGNAL_EXIT_CODES[signal]);
      };
      processEmitter.on(signal, handler);
      return [signal, handler];
    });
    processEmitter.on('exit', leaveQueue);
    leaveSignals = () => {
      for (const [signal, handler] of handlers) processEmitter.off(signal, handler);
      processEmitter.off('exit', leaveQueue);
    };
  };
  try {
    while (true) {
      const ahead = ticketsAhead(lockPath, ticket, { isProcessAlive, now, staleAfterMs });
      // Refresh startedAt for each attempt so the acquired lock records acquisition time.
      const text = JSON.stringify({
        pid,
        cwd,
        startedAt: new Date(now()).toISOString(),
        ...(command ? { command } : {}),
      });
      if (ahead === 0 && publishLock(lockPath, text, pid)) {
        observation?.end('queue', { lockPath });
        const acquiredAt = observation ? monotonicNow() : null;
        observation?.event('resource', 'acquired', { lockPath, observedAt: new Date(now()).toISOString() });
        if (announced) {
          console.log(`${heading} resumed after ${Math.round(monotonicNow() - waitStartedAt)} ms waiting.`);
        }
        const heartbeat = startHeartbeat(lockPath, pid, scheduleHeartbeat, heartbeatMs, now);
        let released = false;
        return {
          release() {
            if (released) return false;
            released = true;
            cancelHeartbeat(heartbeat);
            const result = (releasedLock, reason = null) => {
              observation?.event('resource', 'release', {
                lockPath,
                released: releasedLock,
                reason,
                heldMs: monotonicNow() - acquiredAt,
                descendants: 'unobserved',
              });
              return releasedLock;
            };
            let current;
            try {
              current = readLock(lockPath).owner;
            } catch (error) {
              console.error(`Could not release the ${lockName}: ${error.message}`);
              return result(false, error.message);
            }
            if (!current || current.pid !== pid) return result(false, 'Current holder differs or is unavailable.');
            try {
              rmSync(lockPath, { force: true });
            } catch (error) {
              console.error(`Could not release the ${lockName}: ${error.message}`);
              return result(false, error.message);
            }
            return result(true);
          },
        };
      }
      const { text: currentText, mtimeMs, owner: current } = readLock(lockPath);
      if (tryOnly) {
        observeHolder(current, currentText, mtimeMs, ahead);
        observation?.end('queue', { lockPath, acquired: false });
        return null;
      }
      // A free lock with earlier tickets waits for them. The oldest living ticket takes it on its next poll.
      const held = currentText !== null;
      if (!held) {
        staleObservation = null;
        if (ahead === 0) continue; // The lock vanished between our publish attempt and our read.
      } else {
        observeHolder(current, currentText, mtimeMs, ahead);
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
          // Retry immediately after a race because the lock content has changed.
          // EPERM, EACCES, and EBUSY leave the path in place. Poll instead of spinning until the deadline.
          const reason = retireStaleLock(lockPath, currentText, pid, { rename });
          if (reason !== 'busy') {
            staleObservation = null;
            continue;
          }
        }
      }
      if (ticket) refreshTicket(ticket, now);
      else joinQueue();
      const blocker = held ? `held by ${describeHolder(current)}` : 'while it is free';
      if (onWaiting) onWaiting({ owner: current, held, ahead, waitedMs: monotonicNow() - waitStartedAt });
      else if (!announced)
        console.log(`${heading} are waiting for another run to finish: ${blocker}. ${ahead} ahead in the queue.`);
      announced = true;
      const remaining = deadline - monotonicNow();
      if (remaining <= 0) {
        const timeout = new Error(`Timed out waiting for the ${lockName} ${blocker}. ${ahead} ahead in the queue.`);
        timeout.code = 'ARC_LOCK_TIMEOUT';
        timeout.owner = current;
        timeout.held = held;
        timeout.ahead = ahead;
        throw timeout;
      }
      await waitForPoll(Math.min(pollMs, remaining));
    }
  } catch (error) {
    observation?.end('queue', { lockPath, error: error.message });
    throw error;
  } finally {
    leaveSignals();
    leaveQueue();
  }
}

// Windows taskkill /T terminates the child process tree, including headless browsers.
// If taskkill cannot launch, or on other platforms, send the signal to the child process.
function killProcessTree(
  child,
  signal,
  {
    platform = process.platform,
    killGroup = process.kill,
    killWindowsTree = (pid) => {
      const result = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F']);
      return !result.error && result.status === 0;
    },
  } = {},
) {
  if (platform === 'win32' && child.pid) {
    if (killWindowsTree(child.pid)) return;
  }
  if (child.arcProcessGroup && child.pid) {
    try {
      killGroup(-child.pid, signal);
      return;
    } catch {
      /* The process group has already closed or is unavailable. */
    }
  }
  child.kill(signal);
}

// Both parent and child receive Ctrl+C on Windows.
// Forward the signal and retain any lock until the child closes.
// Escalate before the outer collector's deadline and await child closure before release.
export function forwardSignalToChildAndRelease(
  child,
  lock = null,
  {
    processEmitter = process,
    killTree = killProcessTree,
    hardFallbackMs = 1_000,
    scheduleFallback = (fn, milliseconds) => {
      const timer = setTimeout(() => fn(), milliseconds);
      timer.unref?.();
      return timer;
    },
    cancelFallback = clearTimeout,
    observation = null,
  } = {},
) {
  // Signal listeners receive no signal argument. Capture each signal name in its handler.
  let handled = false;
  let groupRetired = false;
  const retireGroup = () => {
    if (child.arcProcessGroup && child.pid && !groupRetired) {
      groupRetired = true;
      killTree(child, 'SIGKILL');
    }
  };
  child.once('close', retireGroup);
  const bound = Object.keys(SIGNAL_EXIT_CODES).map((signal) => {
    const handler = () => {
      if (handled) return;
      handled = true;
      observation?.event('run', 'cancellation', { signal });
      const fallbackTimer = scheduleFallback(() => {
        observation?.event('cleanup', 'shutdown-fallback', { signal, childClosed: false });
        groupRetired = true;
        killTree(child, 'SIGKILL');
      }, hardFallbackMs);
      child.once('close', () => {
        cancelFallback(fallbackTimer);
        retireGroup();
        lock?.release();
        processEmitter.exit(SIGNAL_EXIT_CODES[signal]);
      });
      killTree(child, signal);
    };
    return [signal, handler];
  });
  for (const [signal, handler] of bound) processEmitter.on(signal, handler);
  return function detach() {
    child.removeListener('close', retireGroup);
    for (const [signal, handler] of bound) processEmitter.off(signal, handler);
  };
}

// Expose takeover and stale-age helpers for deterministic tests.
export const forTesting = { retireStaleLock, stepStaleObservation, killProcessTree };
