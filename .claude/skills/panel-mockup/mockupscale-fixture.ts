import assert from 'node:assert';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
const root = path.join(__dirname, '..', '..', '..');
const skill = path.join(root, '.claude', 'skills', 'panel-mockup');
const RENDERER_EXIT_DEADLINE_MS = 45_000;

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

export { root, skill, RENDERER_EXIT_DEADLINE_MS, invalidTheme, stopOwnedProcesses, waitForOwnedProcessesToExit, waitForFirstLine, waitForExit, spawnRenderer, listenWithoutReply };
