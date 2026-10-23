import { test, vi } from 'vitest';
import assert from 'node:assert';
import { type ChildProcess, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tempDir } from '../../../extension/src/temproot.ts';
import * as path from 'node:path';
import { stopOwnedProcesses } from './mockupscale-fixture.ts';
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: vi.fn(),
}));
test('the renderer test cleanup targets every recorded process', () => {
  const dir = tempDir('panel-mockup-owned-processes-');
  const ownershipFile = path.join(dir, 'owned-pids.txt');
  fs.writeFileSync(ownershipFile, '101\n202\n');
  const stopped: number[][] = [];
  try {
    stopOwnedProcesses({ pid: 303 } as ChildProcess, ownershipFile, (pids) => stopped.push(pids));
    assert.deepEqual(stopped, [[303, 202, 101]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test.each(['win32', 'darwin', 'linux'])('the renderer test cleanup preserves every owned target on %s', (platform) => {
  const dir = tempDir('panel-mockup-platform-cleanup-');
  const ownershipFile = path.join(dir, 'owned-pids.txt');
  fs.writeFileSync(ownershipFile, '101\n202\n101\n303\n');
  const child = { pid: 303 } as ChildProcess;
  const stopped: number[][] = [];
  const kill = vi.fn((pid: number) => {
    if (Math.abs(pid) === 202) throw new Error('process unavailable');
    return true;
  });
  vi.mocked(spawnSync).mockReset();
  vi.stubGlobal('process', { ...process, platform, kill });
  try {
    stopOwnedProcesses(child, ownershipFile, (pids) => stopped.push(pids));
    assert.deepEqual(stopped, [[303, 202, 101]]);
    stopOwnedProcesses(child, ownershipFile);
    if (platform === 'win32') {
      assert.deepEqual(vi.mocked(spawnSync).mock.calls, [
        ['taskkill', ['/pid', '303', '/pid', '202', '/pid', '101', '/t', '/f'], { windowsHide: true }],
      ]);
      assert.equal(kill.mock.calls.length, 0);
      fs.writeFileSync(ownershipFile, '');
      stopOwnedProcesses({} as ChildProcess, ownershipFile);
      assert.equal(vi.mocked(spawnSync).mock.calls.length, 1);
    } else {
      assert.deepEqual(kill.mock.calls, [[-303, 'SIGKILL'], [-202, 'SIGKILL'], [202, 'SIGKILL'], [-101, 'SIGKILL']]);
      assert.equal(vi.mocked(spawnSync).mock.calls.length, 0);
    }
  } finally {
    vi.unstubAllGlobals();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
