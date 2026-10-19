import { test } from 'vitest';
import assert from 'node:assert';
import * as fs from 'node:fs';
import { tempDir } from '../../../extension/src/temproot.ts';
import * as path from 'node:path';
import { RENDERER_EXIT_DEADLINE_MS, invalidTheme, stopOwnedProcesses, waitForExit, spawnRenderer, listenWithoutReply } from './mockupscale-fixture.ts';
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
