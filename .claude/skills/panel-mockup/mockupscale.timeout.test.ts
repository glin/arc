import { test } from 'vitest';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { tempDir } from '../../../extension/src/temproot.ts';
import * as path from 'node:path';
import { invalidTheme, stopOwnedProcesses, waitForOwnedProcessesToExit, waitForFirstLine, waitForExit, spawnRenderer } from './mockupscale-fixture.ts';
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
