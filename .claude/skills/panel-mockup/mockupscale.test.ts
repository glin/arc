import { test } from 'vitest';
import assert from 'node:assert';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import { tempDir } from '../../../extension/src/temproot.ts';
import * as path from 'node:path';

const root = path.join(__dirname, '..', '..', '..');
const skill = path.join(root, '.claude', 'skills', 'panel-mockup');
const RENDERER_EXIT_DEADLINE_MS = 45_000;

const chain =
  '<div class="railtop"><div class="railfilterbox">' + '<input class="railfilter" value="is:unread"></div></div>';
const proof = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="panel-snapshot.css">
  <link rel="stylesheet" href="mock.css">
</head>
<body class="vscode-dark">
  <section class="board">
    <div class="mockrow" id="wrapped">
      <div class="frame"><div class="railmock">${chain}</div></div>
    </div>
  </section>
  <div id="bare">${chain}</div>
</body>
</html>`;

const invalidTheme = `<!doctype html>
<html style="--mock-themes: &quot;dark&quot;">
<body><section data-shot="one">one</section></body>
</html>`;

function stopPidTree(pid: number) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }
}

function readOwnedPids(file: string) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger);
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function waitForOwnedProcessesToExit(ownershipFile: string, deadlineMs: number) {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + deadlineMs;
    const poll = setInterval(() => {
      const alive = readOwnedPids(ownershipFile).filter(processExists);
      if (alive.length === 0) {
        clearInterval(poll);
        resolve();
      } else if (Date.now() >= deadline) {
        clearInterval(poll);
        reject(new Error(`renderer left owned processes running: ${alive.join(', ')}`));
      }
    }, 25);
  });
}

function waitForFirstLine(file: string, deadlineMs: number) {
  return new Promise<string>((resolve, reject) => {
    const deadline = Date.now() + deadlineMs;
    const poll = setInterval(() => {
      const value = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split(/\s+/)[0] : '';
      if (value) {
        clearInterval(poll);
        resolve(value);
      } else if (Date.now() >= deadline) {
        clearInterval(poll);
        reject(new Error(`renderer did not publish browser ownership within ${deadlineMs} ms`));
      }
    }, 25);
  });
}

function stopOwnedProcesses(child: ChildProcess, ownershipFile: string, stop = stopPidTree) {
  const pids = new Set(readOwnedPids(ownershipFile));
  if (child.pid) pids.add(child.pid);
  for (const pid of [...pids].reverse()) stop(pid);
}

function waitForExit(child: ChildProcess, deadlineMs: number, ownershipFile: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    const deadline = Date.now() + deadlineMs;
    const poll = setInterval(() => {
      if (Date.now() < deadline) return;
      clearInterval(poll);
      stopOwnedProcesses(child, ownershipFile);
      reject(new Error(`render-boards.cjs did not exit within ${deadlineMs} ms`));
    }, 50);
    child.once('error', (error) => {
      clearInterval(poll);
      reject(error);
    });
    child.once('exit', (code) => {
      clearInterval(poll);
      resolve({ code, stdout, stderr });
    });
  });
}

test("the mockup artboard row draws its frames at the panel's own size", { timeout: 60_000 }, async (t) => {
  let stage = 'stylesheet snapshot';
  let failureStage: string | undefined;
  t.onTestFailed(() => console.error(`Mockup scale check stopped during ${failureStage ?? stage}.`));
  const { launchAnyBrowser } = await import('../../../extension/test/browserchannels.mjs');
  let available: Awaited<ReturnType<typeof launchAnyBrowser>> = null;
  const dir = tempDir('panel-mockup-scale-');
  try {
    stage = 'stylesheet snapshot';
    const written = spawnSync(process.execPath, ['--import', 'tsx', path.join(skill, 'snapshot-css.ts'), dir], {
      cwd: path.join(root, 'extension'),
      encoding: 'utf8',
    });
    assert.equal(
      written.status,
      0,
      `snapshot-css.ts could not write the stylesheet: ${written.stderr || written.stdout}`,
    );
    fs.writeFileSync(path.join(dir, 'proof.html'), proof);

    stage = 'browser launch';
    available = await launchAnyBrowser();
    if (!available) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
      return;
    }
    stage = 'browser context creation';
    const context = await available.browser.newContext();
    stage = 'browser page creation';
    const page = await context.newPage();
    stage = 'page navigation';
    await page.goto(`file:///${path.join(dir, 'proof.html').replace(/\\/g, '/')}`);
    stage = 'style measurement';
    const measured = (await page.evaluate(`(() => {
      const at = (selector) => getComputedStyle(document.querySelector(selector));
      return {
        display: at('#wrapped').display,
        body: at('body').fontSize,
        row: at('#wrapped').fontSize,
        wrapped: at('#wrapped .railfilter').fontSize,
        bare: at('#bare .railfilter').fontSize,
      };
    })()`)) as { display: string; body: string; row: string; wrapped: string; bare: string };

    assert.equal(measured.display, 'flex', 'mock.css no longer lays the artboard row out');
    assert.equal(
      measured.row,
      measured.body,
      `the artboard row draws at ${measured.row} where the page draws at ${measured.body}`,
    );
    assert.equal(
      measured.wrapped,
      measured.bare,
      `a rail field inside an artboard draws at ${measured.wrapped} and one outside it at ${measured.bare}`,
    );
  } catch (error) {
    failureStage = stage;
    throw error;
  } finally {
    stage = 'browser close';
    try {
      await available?.browser.close();
    } finally {
      stage = 'temporary file removal';
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function spawnRenderer(html: string, output: string, ownershipFile: string, env = {}) {
  return spawn(process.execPath, [path.join(skill, 'render-boards.cjs'), html, output], {
    cwd: root,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ARC_RENDER_OWNED_PIDS_FILE: ownershipFile, ...env },
  });
}

async function listenWithoutReply() {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test(
  'the renderer exits after bounded partial launch, connection, and validation failures',
  { timeout: 60_000 },
  async (t) => {
    const { launchAnyBrowser } = await import('../../../extension/test/browserchannels.mjs');
    const available = await launchAnyBrowser();
    if (!available) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so no renderer process was started');
      return;
    }
    await available.browser.close();

    const endpoint = await listenWithoutReply();
    const dir = tempDir('panel-mockup-invalid-theme-');
    const html = path.join(dir, 'invalid-theme.html');
    const output = path.join(dir, 'output');
    const ownershipFile = path.join(dir, 'owned-pids.txt');
    fs.writeFileSync(html, invalidTheme);
    const child = spawnRenderer(html, output, ownershipFile, {
      ARC_RENDER_TEST_SEQUENCE: 'partial-connect-normal',
      ARC_RENDER_TEST_CHANNEL: available.channel ?? 'bundled',
      ARC_RENDER_TEST_WS_ENDPOINT: `ws://127.0.0.1:${endpoint.port}/`,
      ARC_RENDER_CONNECT_TIMEOUT_MS: '200',
    });
    try {
      const result = await waitForExit(child, RENDERER_EXIT_DEADLINE_MS, ownershipFile);
      assert.notEqual(result.code, 0, `the invalid page unexpectedly rendered: ${result.stdout}`);
      assert.match(result.stderr, /did not switch to dark/);
    } finally {
      stopOwnedProcesses(child, ownershipFile);
      await endpoint.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  'a browser-owner launch timeout stops the owner and its detached descendants before renderer fallback',
  { timeout: 40_000 },
  async () => {
    const dir = tempDir('panel-mockup-launch-timeout-');
    const html = path.join(dir, 'unused.html');
    const output = path.join(dir, 'output');
    const ownershipFile = path.join(dir, 'owned-pids.txt');
    const tokenFile = path.join(dir, 'browser-tokens.txt');
    fs.writeFileSync(html, invalidTheme);
    const child = spawnRenderer(html, output, ownershipFile, {
      ARC_RENDER_TEST_BLOCK_OWNER: '1',
      ARC_RENDER_OWNER_REPORT_TIMEOUT_MS: '1000',
      ARC_RENDER_BROWSER_TOKEN_FILE: tokenFile,
    });
    try {
      const token = await waitForFirstLine(tokenFile, 2_000);
      const detachedBrowser = spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1_000)', '--', `--arc-render-owner=${token}`],
        { detached: true, stdio: 'ignore' },
      );
      assert.ok(detachedBrowser.pid);
      fs.appendFileSync(ownershipFile, `${detachedBrowser.pid}\n`);
      detachedBrowser.unref();
      const result = await waitForExit(child, 30_000, ownershipFile);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /no Edge, Chrome or bundled Chromium/);
      await waitForOwnedProcessesToExit(ownershipFile, 2_000);
    } finally {
      stopOwnedProcesses(child, ownershipFile);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('the renderer test cleanup targets every recorded process', () => {
  const dir = tempDir('panel-mockup-owned-processes-');
  const ownershipFile = path.join(dir, 'owned-pids.txt');
  fs.writeFileSync(ownershipFile, '101\n202\n');
  const stopped: number[] = [];
  try {
    stopOwnedProcesses({ pid: 303 } as ChildProcess, ownershipFile, (pid) => stopped.push(pid));
    assert.deepEqual(stopped, [303, 202, 101]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
