// Share browser channel order between the ESM lane runner and the CommonJS test fixture.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createTestObservation } from './observations.mjs';

// Edge and Chrome 152 and later on Windows call LogonUser with an invalid password on every launch.
// Each call counts as a failed sign-in for the Windows account. One browser lane run starts about
// twenty browsers, and a lockout policy of ten failures in ten minutes locks the account mid-run.
// https://issues.chromium.org/issues/541310282
// https://github.com/MicrosoftEdge/WebView2Feedback/issues/5722
// Playwright's bundled headless shell, the undefined channel, leaves out the browser layer that makes
// the call, so it comes first. Install it with `npx playwright-core install chromium-headless-shell`.
// Edge and Chrome stay as fallbacks with the feature that makes the call turned off.
// Restore the order Edge, Chrome, bundled and drop EDGE_SIGN_IN_WORKAROUND once a fixed Edge and Chrome ship.
export const BROWSER_CHANNELS = [undefined, 'msedge', 'chrome'];

// Playwright passes its own --disable-features list, and Chromium keeps only the last copy of a switch.
// The workaround therefore repeats Playwright's list, so its automation settings stay off too.
// scripts/extension-test-runner.test.js fails when a Playwright upgrade changes that list.
export const PLAYWRIGHT_DISABLED_FEATURES = [
  'AvoidUnnecessaryBeforeUnloadCheckSync',
  'BoundaryEventDispatchTracksNodeRemoval',
  'DestroyProfileOnBrowserClose',
  'DialMediaRouteProvider',
  'GlobalMediaControls',
  'HttpsUpgrades',
  'LensOverlay',
  'MediaRouter',
  'PaintHolding',
  'ThirdPartyStoragePartitioning',
  'BlockOriginHeaderModificationOnRedirect',
  'Translate',
  'AutoDeElevate',
  'OptimizationHints',
  'msForceBrowserSignIn',
  'msEdgeUpdateLaunchServicesPreferredVersion',
];
export const EDGE_SIGN_IN_WORKAROUND = `--disable-features=${[...PLAYWRIGHT_DISABLED_FEATURES, 'AutofillAiWalletPrivatePasses'].join(',')}`;
const BROWSER_LAUNCH_TIMEOUT_MS = 10_000;
export const BROWSER_SLOT_COUNT = 16;
// Use the machine temporary directory saved before Vitest redirects TEMP for its run.
export const BROWSER_SLOT_ROOT = join(process.env.ARC_TEST_MACHINE_TEMP || tmpdir(), 'arc-browser-test-slots');
const BROWSER_SLOT_OWNER = 'owner.json';
const BROWSER_SLOT_DEADLINE_MS = 30 * 60_000;
const BROWSER_SLOT_INCOMPLETE_GRACE_MS = 2_000;
const BROWSER_SLOT_POLL_MS = 500;

// browserlock.mjs imports this process-existence check.
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

function removeMatchingSlot(slotPath, token, action, afterValidation, beforeRemoval) {
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
  beforeRemoval?.();
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
  observation = null,
  tryOnly = false,
  conservativeRecovery = false,
  afterSlotCreated,
  beforeSlotRemoval,
} = {}) {
  observation?.begin('queue', { rootPath, deadlineMs, slotCount, queuePosition: null });
  try {
    mkdirSync(rootPath, { recursive: true });
    const waitStartedAt = monotonicNow();
    const deadline = waitStartedAt + deadlineMs;
    let reportedWait = false;
    const seenHolders = new Map();
    let lastNotice = -Infinity;
    let previousHolders = null;
    while (true) {
      const holders = [];
      for (let index = 1; index <= slotCount; index++) {
        const slotPath = join(rootPath, `slot-${index}`);
        try {
          mkdirSync(slotPath);
          try {
            afterSlotCreated?.(slotPath);
            publishOwner(slotPath, { pid, token });
          } catch (error) {
            rmSync(slotPath, { recursive: true, force: true });
            throw error;
          }
          if (reportedWait) {
            console.log(`Browser test slot wait: ${Math.round(monotonicNow() - waitStartedAt)} ms.`);
          }
          observation?.end('queue', { rootPath, index });
          const acquiredAt = observation ? monotonicNow() : null;
          observation?.event('resource', 'acquired', { rootPath, index, observedAt: new Date(now()).toISOString() });
          let released = false;
          return {
            index,
            release() {
              if (released) return false;
              released = true;
              const removed = removeMatchingSlot(slotPath, token, 'release');
              observation?.event('resource', 'release', {
                rootPath,
                index,
                released: removed,
                heldMs: monotonicNow() - acquiredAt,
                descendants: 'unobserved',
              });
              return removed;
            },
          };
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }

        const owner = readSlotOwner(slotPath);
        if (observation) {
          const at = monotonicNow();
          const key = owner ? `${owner.pid}:${owner.token}` : null;
          const previous = seenHolders.get(index);
          const since = previous?.key === key ? previous.since : at;
          seenHolders.set(index, { key, since });
          holders.push({ index, owner, observedHolderMs: at - since });
        }
        if (owner && !isProcessAlive(owner.pid)) {
          if (!conservativeRecovery) recoverAbandonedClaim(slotPath, owner.token, 'stale', now(), incompleteGraceMs);
          if (removeMatchingSlot(slotPath, owner.token, 'stale', undefined, beforeSlotRemoval)) {
            index--;
            continue;
          }
        } else if (!owner && !conservativeRecovery) {
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

      if (observation) {
        const at = monotonicNow();
        const signature = JSON.stringify(holders.map(({ index, owner }) => [index, owner]));
        if (signature !== previousHolders || at - lastNotice >= 30_000) {
          previousHolders = signature;
          lastNotice = at;
          const observedAt = new Date(now()).toISOString();
          observation.event('queue', 'holders', {
            rootPath,
            observedAt,
            holders,
            queuePosition: null,
            holderDuration: 'before first observation unavailable',
          });
          if (!tryOnly)
            console.log(
              `Browser slot holders observed at ${observedAt}: ${holders.map(({ index, owner, observedHolderMs }) => `${index}=PID ${owner?.pid ?? 'unavailable'} observed ${Math.round(observedHolderMs)} ms`).join(', ')}. Queue position unavailable.`,
            );
        }
      }

      if (tryOnly) {
        observation?.end('queue', { rootPath, acquired: false });
        return null;
      }
      if (!reportedWait) {
        console.log(`Browser launch waiting for one of ${slotCount} test slots.`);
        reportedWait = true;
      }
      const remaining = deadline - monotonicNow();
      if (remaining <= 0) throw new Error(`Timed out waiting for one of ${slotCount} browser test slots.`);
      await waitForPoll(Math.min(pollMs, remaining));
    }
  } catch (error) {
    observation?.end('queue', { rootPath, error: error.message });
    throw error;
  }
}

function releaseOnClose(browser, permit, observation) {
  const close = browser.close.bind(browser);
  let closed = false;
  Object.defineProperty(browser, 'close', {
    configurable: true,
    async value(...args) {
      if (closed) return;
      closed = true;
      observation?.begin('cleanup');
      let failure = null;
      let closeFailure;
      let closeFailed = false;
      try {
        await close(...args);
      } catch (error) {
        failure = error.message;
        closeFailure = error;
        closeFailed = true;
      }
      let released = false;
      try {
        released = permit.release();
      } catch (error) {
        failure = error.message;
        throw error;
      } finally {
        observation?.end('cleanup', { released, error: failure, descendants: 'unobserved' });
        observation?.finish({ outcome: failure ? 'failure' : 'success', reason: failure });
      }
      if (closeFailed) throw closeFailure;
    },
  });
  return browser;
}

// Try browser channels in order with the supplied launch arguments.
// Return null when playwright-core is unavailable or all launches fail.
export async function launchAnyBrowser({
  args = [],
  acquireSlot = acquireBrowserSlot,
  loadChromium = async () => (await import('playwright-core')).chromium,
  observationParent = null,
  observation = acquireSlot === acquireBrowserSlot && (observationParent || process.env.ARC_TEST_OBSERVATIONS_DIR)
    ? createTestObservation({
        lane: 'browser launch',
        capacity: BROWSER_SLOT_COUNT,
        ...(observationParent ? { env: observationParent.childEnvironment() } : {}),
        announce: () => {},
      })
    : null,
} = {}) {
  observation?.unavailable('build', 'Browser launch builds no test bundle.');
  observation?.unavailable('execution', 'Browser usage occurs outside the launch request.');
  let handedOff = false;
  let failure = null;
  let permit = null;
  try {
    let chromium;
    try {
      chromium = await loadChromium();
    } catch (error) {
      failure = error.message;
      observation?.unavailable('queue', 'Playwright is unavailable.');
      observation?.unavailable('cleanup', 'No browser or slot was acquired.');
      return null;
    }
    permit = await acquireSlot({ observation });
    observation?.begin('launch');
    for (const channel of BROWSER_CHANNELS) {
      const channelArgs = channel ? [...args, EDGE_SIGN_IN_WORKAROUND] : args;
      try {
        const browser = await chromium.launch({
          headless: true,
          timeout: BROWSER_LAUNCH_TIMEOUT_MS,
          ...(channelArgs.length ? { args: channelArgs } : {}),
          ...(channel ? { channel } : {}),
        });
        try {
          let browserVersion = null;
          try {
            browserVersion = browser.version?.() ?? null;
          } catch {
            // Version lookup supplies no launch or lifetime authority.
          }
          const wrapped = releaseOnClose(browser, permit, observation);
          observation?.end('launch', { browser: channel ?? 'bundled Chromium', browserVersion });
          handedOff = true;
          return { browser: wrapped, channel };
        } catch {
          await browser.close().catch(() => {});
        }
      } catch {
        // Try the next browser already available on this machine.
      }
    }
    observation?.end('launch', { available: false });
    observation?.begin('cleanup');
    const released = permit.release();
    observation?.end('cleanup', { released, descendants: 'unobserved' });
    return null;
  } catch (error) {
    failure = error.message;
    throw error;
  } finally {
    if (!handedOff) {
      if (!permit) observation?.unavailable('cleanup', 'No browser or slot was acquired.');
      observation?.finish({
        outcome: failure ? 'failure' : 'unavailable',
        reason: failure ?? 'No supported browser launched.',
      });
    }
  }
}
