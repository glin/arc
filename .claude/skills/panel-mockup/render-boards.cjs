// Renders every [data-shot] board of a mockup page to its own lossless WebP, plus the whole
// page, once in each of the editor's two theme kinds. The light files carry a -light suffix.
// node .claude/skills/panel-mockup/render-boards.cjs <mockup.html> <outDir>
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { fork, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..', '..', '..');
const { chromium } = require(path.join(root, 'extension', 'node_modules', 'playwright-core'));
// Share the test launcher's browser order and Edge sign-in workaround. BROWSER_CHANNELS in browserchannels.mjs explains both.
const { BROWSER_CHANNELS, EDGE_SIGN_IN_WORKAROUND } = require(
  path.join(root, 'extension', 'test', 'browserchannels.mjs'),
);
const COMMAND_TIMEOUT_MS = 60_000;
const BROWSER_CLOSE_TIMEOUT_MS = 10_000;
const BROWSER_LAUNCH_TIMEOUT_MS = Number(process.env.ARC_RENDER_LAUNCH_TIMEOUT_MS) || 30_000;
const BROWSER_OWNER_REPORT_TIMEOUT_MS =
  Number(process.env.ARC_RENDER_OWNER_REPORT_TIMEOUT_MS) || BROWSER_LAUNCH_TIMEOUT_MS + 5_000;
const BROWSER_CONNECT_TIMEOUT_MS = Number(process.env.ARC_RENDER_CONNECT_TIMEOUT_MS) || 10_000;
const BROWSER_OWNER_ARGUMENT = '--browser-owner';
const BROWSER_OWNERSHIP_ARGUMENT = '--arc-render-owner=';

function withDeadline(operation, milliseconds, message) {
  let timer;
  return Promise.race([
    operation,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

function recordOwnedPid(pid) {
  const file = process.env.ARC_RENDER_OWNED_PIDS_FILE;
  if (file && pid) fs.appendFileSync(file, `${pid}\n`);
}

async function runBrowserOwner(channelName) {
  let server = null;
  let closing = false;
  const finish = async () => {
    if (closing) return;
    closing = true;
    if (server) {
      try {
        await withDeadline(
          server.close(),
          BROWSER_CLOSE_TIMEOUT_MS,
          `browser server did not close within ${BROWSER_CLOSE_TIMEOUT_MS} ms`,
        );
      } catch {
        if (server.process().exitCode === null) await server.kill();
      }
    }
    process.send?.({ type: 'closed' });
    process.exit(0);
  };
  process.on('message', (message) => {
    if (message?.type === 'close') void finish();
  });
  process.on('disconnect', () => void finish());

  if (process.env.ARC_RENDER_TEST_BLOCK_OWNER === '1') {
    const ownershipArgument = `${BROWSER_OWNERSHIP_ARGUMENT}${process.env.ARC_RENDER_BROWSER_TOKEN}`;
    const launcher = spawnSync(
      process.execPath,
      [
        '-e',
        `
      const fs = require('node:fs');
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)', '--', process.env.ARC_RENDER_OWNERSHIP_ARGUMENT], { detached: true, stdio: 'ignore' });
      fs.appendFileSync(process.env.ARC_RENDER_OWNED_PIDS_FILE, child.pid + '\\n');
      child.unref();
    `,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, ARC_RENDER_OWNERSHIP_ARGUMENT: ownershipArgument },
      },
    );
    if (launcher.error || launcher.status !== 0) throw launcher.error || new Error(launcher.stderr);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }

  const launchDeadline = setTimeout(() => process.exit(1), BROWSER_LAUNCH_TIMEOUT_MS);
  try {
    const testHost = process.env.ARC_RENDER_TEST_HOST;
    server = await chromium.launchServer({
      headless: true,
      timeout: BROWSER_LAUNCH_TIMEOUT_MS,
      args: [
        `${BROWSER_OWNERSHIP_ARGUMENT}${process.env.ARC_RENDER_BROWSER_TOKEN}`,
        ...(channelName === 'bundled' ? [] : [EDGE_SIGN_IN_WORKAROUND]),
      ],
      ...(channelName === 'bundled' ? {} : { channel: channelName }),
      ...(testHost ? { host: testHost } : {}),
    });
    clearTimeout(launchDeadline);
    process.send?.({ type: 'ready', endpoint: server.wsEndpoint(), browserPid: server.process().pid });
  } catch (error) {
    clearTimeout(launchDeadline);
    process.send?.({ type: 'launch-error', message: error.message });
    process.exit(1);
  }
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit) => child.once('exit', resolveExit));
}

// Each Windows taskkill call takes seconds on a busy machine, so one call stops every tree.
function forceStopProcessTrees(pids) {
  const targets = [...new Set(pids.filter(Boolean))];
  if (!targets.length) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', [...targets.flatMap((pid) => ['/pid', String(pid)]), '/t', '/f'], { windowsHide: true });
    return;
  }
  for (const pid of targets) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }
}

// Stops every process tree whose command line carries the token, and the extra trees, then returns the token pids.
// On Windows one PowerShell call both queries and stops, because each process query takes seconds on a busy machine.
// Its own command line carries the token too, so the query skips its own process.
function stopOwnedBrowserProcesses(token, extraPids = []) {
  const argument = `${BROWSER_OWNERSHIP_ARGUMENT}${token}`;
  let result;
  if (process.platform === 'win32') {
    const extra = extraPids.filter(Number.isInteger).join(',');
    const script = [
      `$owned = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${argument}') } | ForEach-Object { $_.ProcessId })`,
      `$targets = @($owned) + @(${extra})`,
      `if ($targets.Count) { $arguments = foreach ($id in $targets) { '/pid'; [string]$id }; taskkill.exe @arguments /t /f 2>&1 | Out-Null }`,
      `$owned -join ','`,
    ].join('\n');
    result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`could not stop owned browser processes: ${commandFailure(result, 15_000)}`);
    }
    return result.stdout.trim().split(',').filter(Boolean).map(Number).filter(Number.isInteger);
  }
  result = spawnSync('ps', ['-A', '-o', 'pid=,args='], { encoding: 'utf8', timeout: 5_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`could not inspect owned browser processes: ${commandFailure(result, 5_000)}`);
  }
  const owned = result.stdout.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    return match?.[2].includes(argument) ? [Number(match[1])] : [];
  });
  forceStopProcessTrees([...owned, ...extraPids]);
  return owned;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function waitForProcessIdsToExit(pids, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  return new Promise((resolveExit, rejectExit) => {
    const check = () => {
      const alive = pids.filter(processExists);
      if (!alive.length) {
        resolveExit();
        return;
      }
      if (Date.now() >= deadline) {
        rejectExit(new Error(`owned browser processes could not be stopped: ${alive.join(', ')}`));
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}

async function stopBrowserOwner(child, token) {
  const ownerRunning = child.exitCode === null && child.signalCode === null;
  const owned = new Set(stopOwnedBrowserProcesses(token, ownerRunning ? [child.pid] : []));
  await withDeadline(waitForExit(child), 2_000, 'browser owner could not be stopped');
  // The second pass stops a process that launched during the first one.
  for (const pid of stopOwnedBrowserProcesses(token)) owned.add(pid);
  await waitForProcessIdsToExit([...owned], 5_000);
}

function launchBrowserOwner(channel, { launchHost, endpointOverride } = {}) {
  return new Promise((resolveOwner, rejectOwner) => {
    const browserToken = randomUUID();
    if (process.env.ARC_RENDER_BROWSER_TOKEN_FILE) {
      fs.appendFileSync(process.env.ARC_RENDER_BROWSER_TOKEN_FILE, `${browserToken}\n`);
    }
    const child = fork(__filename, [BROWSER_OWNER_ARGUMENT, channel ?? 'bundled'], {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: {
        ...process.env,
        ARC_RENDER_TEST_HOST: launchHost || '',
        ARC_RENDER_BROWSER_TOKEN: browserToken,
      },
    });
    recordOwnedPid(child.pid);
    let settled = false;
    const fail = async (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      try {
        await stopBrowserOwner(child, browserToken);
      } catch (stopError) {
        stopError.preventFallback = true;
        rejectOwner(stopError);
        return;
      }
      rejectOwner(error);
    };
    const deadline = setTimeout(
      () => void fail(new Error('browser owner did not report launch completion')),
      BROWSER_OWNER_REPORT_TIMEOUT_MS,
    );
    child.once('error', (error) => void fail(error));
    child.once('exit', (code) => void fail(new Error(`browser owner exited during launch with status ${code}`)));
    child.on('message', (message) => {
      if (message?.type === 'launch-error') {
        void fail(new Error(message.message));
        return;
      }
      if (message?.type !== 'ready' || settled) return;
      settled = true;
      clearTimeout(deadline);
      recordOwnedPid(message.browserPid);
      let cleaned = false;
      resolveOwner({
        endpoint: endpointOverride || message.endpoint,
        async cleanup() {
          if (cleaned) return;
          cleaned = true;
          if (child.connected) child.send({ type: 'close' });
          try {
            await withDeadline(waitForExit(child), BROWSER_CLOSE_TIMEOUT_MS + 2_000, 'browser owner did not exit');
          } catch (error) {
            forceStopProcessTrees([message.browserPid, child.pid]);
            await withDeadline(waitForExit(child), 2_000, 'browser owner could not be stopped').catch(() => {});
            throw error;
          }
        },
      });
    });
  });
}

function commandFailure(result, timeoutMs) {
  if (result.error?.code === 'ETIMEDOUT') return `timed out after ${timeoutMs} ms`;
  return result.error?.message || result.stderr || result.stdout || 'unknown error';
}

async function screenshotAsWebp(target, file, options = {}) {
  const temporary = `${file}.${process.pid}.png`;
  try {
    await target.screenshot({ ...options, path: temporary });
    const converted = spawnSync('magick', [temporary, '-define', 'webp:lossless=true', file], {
      encoding: 'utf8',
      timeout: COMMAND_TIMEOUT_MS,
    });
    if (converted.error || converted.status !== 0) {
      const detail = commandFailure(converted, COMMAND_TIMEOUT_MS);
      throw new Error(`ImageMagick could not write ${file}: ${detail.trim()}`);
    }
    const compared = spawnSync('magick', ['compare', '-metric', 'AE', temporary, file, 'null:'], {
      encoding: 'utf8',
      timeout: COMMAND_TIMEOUT_MS,
    });
    const difference = (compared.stderr || compared.stdout || '').trim();
    if (compared.error || compared.status !== 0 || !/^0(?:\s|$)/.test(difference)) {
      const detail = compared.error
        ? commandFailure(compared, COMMAND_TIMEOUT_MS)
        : difference || 'no comparison result';
      throw new Error(`lossless WebP verification failed for ${file}: ${detail.trim()}`);
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

async function render() {
  const [html, outDir] = process.argv.slice(2);
  if (!html || !outDir) {
    console.error('usage: render-boards.cjs <mockup.html> <outDir>');
    process.exitCode = 2;
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });
  let browser = null;
  let cleanupBrowser = null;
  const testSequence = process.env.ARC_RENDER_TEST_SEQUENCE === 'partial-connect-normal';
  const testChannel =
    process.env.ARC_RENDER_TEST_CHANNEL === 'bundled' ? undefined : process.env.ARC_RENDER_TEST_CHANNEL;
  const channels = testSequence ? [testChannel, testChannel, testChannel] : BROWSER_CHANNELS;
  for (const [attempt, channel] of channels.entries()) {
    let owner;
    try {
      owner = await launchBrowserOwner(channel, {
        launchHost: testSequence && attempt === 0 ? 'invalid host name' : undefined,
        endpointOverride: testSequence && attempt === 1 ? process.env.ARC_RENDER_TEST_WS_ENDPOINT : undefined,
      });
    } catch (error) {
      if (error.preventFallback) throw error;
      continue;
    }
    try {
      browser = await chromium.connect(owner.endpoint, { timeout: BROWSER_CONNECT_TIMEOUT_MS });
      cleanupBrowser = owner.cleanup;
      break;
    } catch {
      await owner.cleanup();
    }
  }
  if (!browser) {
    console.log('no Edge, Chrome or bundled Chromium on this machine, so nothing was rendered');
    return;
  }
  let workError = null;
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const address = 'file:///' + path.resolve(html).replace(/\\/g, '/');
    const stem = path.basename(html, path.extname(html));
    // The themes the page was generated with, read off the page rather than listed here.
    await page.goto(address);
    await page.waitForTimeout(300);
    const themes = await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue('--mock-themes')
        .replace(/^\s*"|"\s*$/g, '')
        .split('|')
        .filter(Boolean)
        .map((entry) => entry.split(':')[0]),
    );
    if (!themes.length) {
      throw new Error(`${html} names no theme. Generate its stylesheet with snapshot-css.ts.`);
    }
    for (const [index, theme] of themes.entries()) {
      const suffix = index === 0 ? '' : `-${theme}`;
      await page.goto(`${address}?theme=${theme}`);
      await page.waitForTimeout(300);
      // A page that does not link theme-switch.js reads the same in every theme, and the rest
      // of the set would be copies of the first that nobody could tell from real ones.
      const on = await page.evaluate((id) => document.documentElement.classList.contains(`theme-${id}`), theme);
      if (!on) {
        throw new Error(`${html} did not switch to ${theme}. Link theme-switch.js from the page.`);
      }
      // WebP holds at most 16383 pixels a side. A page taller than that at two times scale is
      // captured at one image pixel per CSS pixel instead of failing.
      const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      const pageScale = pageHeight * 2 > 16000 ? { scale: 'css' } : {};
      await screenshotAsWebp(page, path.join(outDir, `${stem}-page${suffix}.webp`), { fullPage: true, ...pageScale });
      for (const board of await page.locator('[data-shot]').all()) {
        const id = await board.getAttribute('data-shot');
        const file = path.join(outDir, `${stem}-${id}${suffix}.webp`);
        // A frame that never meets the viewport is never painted, so the viewport grows to hold
        // the whole board before the board is captured. A row of three frames stays whole.
        const box = await board.boundingBox();
        if (box) {
          await page.setViewportSize({
            width: Math.min(8000, Math.ceil(box.width) + 40),
            height: Math.min(8000, Math.ceil(box.height) + 40),
          });
          await board.scrollIntoViewIfNeeded();
          await page.waitForTimeout(200);
        }
        await screenshotAsWebp(board, file);
        await page.setViewportSize({ width: 1100, height: 900 });
        console.log(file);
      }
    }
    if (errors.length) console.log('page errors', errors);
  } catch (error) {
    workError = error;
  }
  try {
    await cleanupBrowser();
  } catch (cleanupError) {
    if (!workError) workError = cleanupError;
    else console.error(`Browser cleanup failed: ${cleanupError.message}`);
  }
  if (workError) throw workError;
}

if (process.argv[2] === BROWSER_OWNER_ARGUMENT) {
  void runBrowserOwner(process.argv[3]);
} else {
  void render().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
