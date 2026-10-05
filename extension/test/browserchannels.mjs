// Plain Node ESM with no vitest import, so extension/test.mjs can load it directly and
// extension/test/browser.ts can load it too. The browser lane and the browser test fixture
// try the same channels in the same order, so this is the one place that order lives.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const CHANNELS = ['msedge', 'chrome', undefined];
export const BROWSER_SLOT_COUNT = 16;
// A Vitest run moves TEMP to a directory of its own, so the slots read the machine temporary
// directory that extension/test/temp-run.ts recorded before the move.
export const BROWSER_SLOT_ROOT = join(process.env.ARC_TEST_MACHINE_TEMP || tmpdir(), 'arc-browser-test-slots');
const BROWSER_SLOT_OWNER = 'owner.json';
const BROWSER_SLOT_DEADLINE_MS = 30 * 60_000;
const BROWSER_SLOT_INCOMPLETE_GRACE_MS = 2_000;
const BROWSER_SLOT_POLL_MS = 500;

// Shared with extension/test/browserlock.mjs, which imports this instead of keeping its own copy.
export function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'EPERM') return true;
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function readSlotOwner(slotPath) {
  try {
    const owner = JSON.parse(readFileSync(join(slotPath, BROWSER_SLOT_OWNER), 'utf8'));
    if (!Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string' || !owner.token) return null;
    return owner;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

function slotMtime(slotPath) {
  try {
    return statSync(slotPath).mtimeMs;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function claimName(action, token) {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('Browser slot tokens must be file-name safe.');
  return `.claim-${action}-${token}`;
}

function removeClaim(claimPath) {
  try {
    rmSync(claimPath, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function removeMatchingSlot(slotPath, token, action, afterValidation) {
  const claimPath = join(slotPath, claimName(action, token));
  try {
    mkdirSync(claimPath);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EEXIST') return false;
    throw error;
  }
  const current = readSlotOwner(slotPath);
  if (!current || current.token !== token) {
    removeClaim(claimPath);
    return false;
  }
  afterValidation?.();
  const confirmed = readSlotOwner(slotPath);
  if (!existsSync(claimPath) || !confirmed || confirmed.token !== token) {
    removeClaim(claimPath);
    return false;
  }
  rmSync(slotPath, { recursive: true, force: true });
  return true;
}

function recoverAbandonedClaim(slotPath, token, action, now, graceMs) {
  const claimPath = join(slotPath, claimName(action, token));
  const firstMtime = slotMtime(claimPath);
  if (firstMtime === null || now - firstMtime < graceMs) return false;
  const current = readSlotOwner(slotPath);
  const secondMtime = slotMtime(claimPath);
  if (!current || current.token !== token || secondMtime !== firstMtime) return false;
  removeClaim(claimPath);
  return true;
}

export function removeBrowserSlotIfOwned(slotPath, token, afterValidation) {
  return removeMatchingSlot(slotPath, token, 'test', afterValidation);
}

function removeIncompleteSlot(slotPath, expectedMtime, token) {
  if (slotMtime(slotPath) !== expectedMtime) return false;
  const claimPath = join(slotPath, claimName('incomplete', token));
  try {
    mkdirSync(claimPath);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EEXIST') return false;
    throw error;
  }
  const current = readSlotOwner(slotPath);
  if (current) {
    removeClaim(claimPath);
    return false;
  }
  rmSync(slotPath, { recursive: true, force: true });
  return true;
}

function publishOwner(slotPath, owner) {
  const temporary = join(slotPath, `.owner-${owner.token}.tmp`);
  writeFileSync(temporary, JSON.stringify(owner), { flag: 'wx' });
  renameSync(temporary, join(slotPath, BROWSER_SLOT_OWNER));
}

const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

export async function acquireBrowserSlot({
  rootPath = BROWSER_SLOT_ROOT,
  slotCount = BROWSER_SLOT_COUNT,
  pid = process.pid,
  token = randomUUID(),
  now = Date.now,
  monotonicNow = () => performance.now(),
  waitForPoll = wait,
  isProcessAlive = processExists,
  deadlineMs = BROWSER_SLOT_DEADLINE_MS,
  incompleteGraceMs = BROWSER_SLOT_INCOMPLETE_GRACE_MS,
  pollMs = BROWSER_SLOT_POLL_MS,
} = {}) {
  mkdirSync(rootPath, { recursive: true });
  const waitStartedAt = monotonicNow();
  const deadline = waitStartedAt + deadlineMs;
  let reportedWait = false;
  while (true) {
    for (let index = 1; index <= slotCount; index++) {
      const slotPath = join(rootPath, `slot-${index}`);
      try {
        mkdirSync(slotPath);
        try {
          publishOwner(slotPath, { pid, token });
        } catch (error) {
          rmSync(slotPath, { recursive: true, force: true });
          throw error;
        }
        if (reportedWait) {
          console.log(`Browser test slot wait: ${Math.round(monotonicNow() - waitStartedAt)} ms.`);
        }
        let released = false;
        return {
          index,
          release() {
            if (released) return false;
            released = true;
            return removeMatchingSlot(slotPath, token, 'release');
          },
        };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }

      const owner = readSlotOwner(slotPath);
      if (owner && !isProcessAlive(owner.pid)) {
        recoverAbandonedClaim(slotPath, owner.token, 'stale', now(), incompleteGraceMs);
        if (removeMatchingSlot(slotPath, owner.token, 'stale')) {
          index--;
          continue;
        }
      } else if (!owner) {
        const firstMtime = slotMtime(slotPath);
        if (firstMtime !== null && now() - firstMtime >= incompleteGraceMs) {
          const secondOwner = readSlotOwner(slotPath);
          const secondMtime = slotMtime(slotPath);
          if (!secondOwner && secondMtime === firstMtime && removeIncompleteSlot(slotPath, firstMtime, token)) {
            index--;
          }
        }
      }
    }

    if (!reportedWait) {
      console.log(`Browser launch waiting for one of ${slotCount} test slots.`);
      reportedWait = true;
    }
    const remaining = deadline - monotonicNow();
    if (remaining <= 0) throw new Error(`Timed out waiting for one of ${slotCount} browser test slots.`);
    await waitForPoll(Math.min(pollMs, remaining));
  }
}

function releaseOnClose(browser, permit) {
  const close = browser.close.bind(browser);
  let closed = false;
  Object.defineProperty(browser, 'close', {
    configurable: true,
    async value(...args) {
      if (closed) return;
      closed = true;
      try {
        await close(...args);
      } finally {
        permit.release();
      }
    },
  });
  return browser;
}

// Tries chromium.launch with each channel in order and keeps the first that succeeds. `args` adds
// command-line switches to every launch.
// Returns null if playwright-core is not installed, or if every channel fails to launch.
export async function launchAnyBrowser({
  args = [],
  acquireSlot = acquireBrowserSlot,
  loadChromium = async () => (await import('playwright-core')).chromium,
} = {}) {
  let chromium;
  try {
    chromium = await loadChromium();
  } catch {
    return null;
  }
  const permit = await acquireSlot();
  for (const channel of CHANNELS) {
    try {
      const browser = await chromium.launch({
        headless: true,
        ...(args.length ? { args } : {}),
        ...(channel ? { channel } : {}),
      });
      try {
        return { browser: releaseOnClose(browser, permit), channel };
      } catch {
        await browser.close().catch(() => {});
      }
    } catch {
      // Try the next browser already available on this machine.
    }
  }
  permit.release();
  return null;
}
