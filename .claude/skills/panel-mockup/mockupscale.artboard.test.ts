import { test } from 'vitest';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tempDir } from '../../../extension/src/temproot.ts';
import * as path from 'node:path';
import { root, skill } from './mockupscale-fixture.ts';
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
