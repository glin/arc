import { test } from 'vitest';
import assert from 'node:assert';
import { type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import { tempDir } from '../../../extension/src/temproot.ts';
import * as path from 'node:path';
import { stopOwnedProcesses } from './mockupscale-fixture.ts';
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
