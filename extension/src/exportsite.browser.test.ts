import { createServer, type Server } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserOrNone } from '../test/browser.ts';
import { tempDir } from './temproot';
import { ExportTransaction } from './exportwriter';
import { exportedSiteData, sessionSiteFixture } from './turnfixtures';
import { projectSessionSite } from './exportsite';
import { exportBrowserAssets } from './panelbundle';
import { EXPORT_LIMITS } from './exportlimits';

describe('portable saved-session site', () => {
  let browser: Awaited<ReturnType<typeof browserOrNone>>;
  let directory: string;
  let server: Server;
  let base: string;
  beforeAll(async () => {
    browser = await browserOrNone();
    if (!browser) return;
    const writer = await ExportTransaction.create(tempDir('arc-site-browser-'));
    const model = await sessionSiteFixture(writer);
    const page = await writer.readSpool<import('./exportdata').ExportPage>(model.sessions[0].pages[0]);
    page.turns[0].finished = true;
    model.sessions[0].pages[0] = await writer.spool(page);
    await projectSessionSite(model, writer, exportBrowserAssets());
    directory = (await writer.publish(async () => {})).directory;
    server = createServer((request, response) => {
      const name = path.basename(new URL(request.url ?? '/', 'http://localhost').pathname);
      const file = path.join(directory, name || 'index.html');
      if (!fs.existsSync(file)) {
        response.writeHead(404).end();
        return;
      }
      response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : 'text/html');
      response.end(fs.readFileSync(file));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('The test server has no address.');
    base = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    await browser?.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('opens file and root or nested HTTP sites with complete inert text and retained older turns', async (t) => {
    if (!browser) t.skip('Edge or Chrome is required');
    for (const address of [
      pathToFileURL(path.join(directory, 'index.html')).href,
      `${base}/index.html`,
      `${base}/nested/site/index.html`,
    ]) {
      const page = await browser!.newPage();
      const outside: string[] = [];
      const errors: string[] = [];
      page.on('request', (request) => {
        if (!request.url().startsWith('file:') && !request.url().startsWith(base)) outside.push(request.url());
      });
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(address);
      const first = page.locator('article[data-key="root-21"]');
      await first.locator('.head').waitFor();
      expect(await page.locator('article').count()).toBe(20);
      await first.locator('.head').click();
      await page.waitForFunction(() =>
        document.querySelector('article[data-key="root-21"] .summary')?.textContent?.includes('final sentinel'),
      );
      const messageOnly = page.locator('article[data-key="root-20"]');
      await messageOnly.locator('.head').click();
      await messageOnly.locator('.actviewstate').waitFor();
      expect(await messageOnly.locator('.actviewaction').count()).toBe(0);
      expect(await first.locator('.actlist .ask').count()).toBe(0);
      expect(await first.locator('.actviewaction').count()).toBe(1);
      await first.locator('.actviewaction').click();
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll('article[data-key="root-21"] .actlist .ask'))
          .at(-1)
          ?.textContent?.includes('Later prompt 12'),
      );
      expect(await first.locator('.actlist .ask').count()).toBe(13);
      expect(await first.locator('.actlist .run, .actlist .step, .actlist .reasoning').count()).toBe(0);
      await first.locator('.actviewaction').click();
      await page.waitForFunction(
        () => document.querySelectorAll('article[data-key="root-21"] .actlist .ask').length === 0,
      );
      const asks = first.locator('[data-control="asks:root-21"]');
      if (await asks.count()) await asks.click();
      await page.waitForFunction(() =>
        document.querySelector('article[data-key="root-21"]')?.textContent?.includes('Later prompt 12'),
      );
      expect(
        await first.locator('.summary a, .summary img, .summary iframe, .summary script, .summary [data-link]').count(),
      ).toBe(0);
      expect(await page.evaluate(() => (window as unknown as { attacked?: boolean }).attacked)).toBeUndefined();
      expect(
        await page
          .locator('#composer:visible, .sessionlabelact:visible, .railact:visible, .railnewsplit:visible')
          .count(),
      ).toBe(0);
      await page.getByRole('button', { name: 'Older turns', exact: true }).click();
      await page.locator('article[data-key="root-0"]').waitFor();
      expect(await page.locator('article').count()).toBe(22);
      expect(await first.count()).toBe(1);
      await page.locator('#rail button.railcard').filter({ hasText: 'Linked session' }).click();
      await page.locator('article[data-key="child-0"]').waitFor();
      const retained = await page.evaluate(
        () => (window as unknown as { __arcExportMetrics: { retainedBytes: number } }).__arcExportMetrics.retainedBytes,
      );
      expect(retained).toBeLessThanOrEqual(EXPORT_LIMITS.retainedBytes);
      expect(outside).toEqual([]);
      expect(errors).toEqual([]);
      await page.close();
    }
  });

  it('uses the production relationship navigation and local layout without mutation controls', async (t) => {
    if (!browser) t.skip('Edge or Chrome is required');
    const page = await browser!.newPage();
    await page.goto(pathToFileURL(path.join(directory, 'index.html')).href);
    const first = page.locator('article[data-key="root-21"]');
    await first.locator('.head').waitFor();
    await first.locator('.head').click();
    await first.locator('[data-control^="session:"]').filter({ hasText: 'Linked session' }).click();
    await page.locator('article[data-key="child-0"]').waitFor();
    await page.locator('.sessionparent').click();
    await first.waitFor();
    await page.locator('.sessionlayout').click();
    expect(await page.locator('[data-control="exportSession"]').count()).toBe(0);
    const one = page.locator('[data-control="layout:cardLayout:one-column"]');
    await one.click();
    await page.waitForFunction(() =>
      document.querySelector('[role="radio"][aria-checked="true"]')?.textContent?.includes('One column'),
    );
    await page.keyboard.press('Escape');
    await page.locator('[data-control="railsearch"]').click();
    const filter = page.locator('[data-control="railfilter"]');
    await filter.fill('agent:codex title:Linked');
    await page.waitForFunction(() => document.querySelectorAll('#rail button.railcard').length === 1);
    await filter.fill('');
    await page.evaluate(() => {
      const text = document.querySelector('article .summary');
      if (!text) throw new Error('The response is unavailable.');
      const range = document.createRange();
      range.selectNodeContents(text);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(await page.locator('.quotefloat:visible, .noteedit:visible').count()).toBe(0);
    expect(await page.locator('[data-control^="diff:"]').count()).toBe(0);
    await page.close();
  });

  it('restores real browser visits and page ranges with platform shortcuts and editable exclusions', async (t) => {
    if (!browser) t.skip('Edge or Chrome is required');
    for (const platform of ['Win32', 'MacIntel', 'Linux x86_64']) {
      const page = await browser!.newPage();
      await page.addInitScript(
        (platform) => Object.defineProperty(navigator, 'platform', { value: platform }),
        platform,
      );
      await page.goto(pathToFileURL(path.join(directory, 'index.html')).href);
      const newest = page.locator('article[data-key="root-21"]');
      const oldest = page.locator('article[data-key="root-0"]');
      const child = page.locator('article[data-key="child-0"]');
      await newest.waitFor();
      const initialLength = await page.evaluate(() => history.length);
      await page.getByRole('button', { name: 'Older turns', exact: true }).click();
      await oldest.waitFor();
      await page.locator('#rail button.railcard').filter({ hasText: 'Linked session' }).click();
      await child.waitFor();
      await page.goBack();
      await oldest.waitFor();
      expect(await newest.count()).toBe(1);
      await page.goBack();
      await newest.waitFor();
      expect(await oldest.count()).toBe(0);
      await page.goForward();
      await oldest.waitFor();
      await page.goForward();
      await child.waitFor();
      expect(await page.evaluate(() => history.length)).toBe(initialLength + 2);
      const back = platform === 'Win32' ? 'Alt+ArrowLeft' : platform === 'MacIntel' ? 'Control+-' : 'Control+Alt+-';
      const forward = platform === 'Win32' ? 'Alt+ArrowRight' : 'Control+Shift+-';
      await page.locator('[data-control="railsearch"]').click();
      const input = page.locator('[data-control="railfilter"]');
      await input.focus();
      const before = await page.evaluate(() => JSON.stringify(history.state));
      await page.keyboard.press(back);
      await page.keyboard.press(forward);
      expect(await page.evaluate(() => JSON.stringify(history.state))).toBe(before);
      await child.locator('.head').focus();
      await page.keyboard.press(back);
      await oldest.waitFor();
      await page.keyboard.press(forward);
      await child.waitFor();
      await page.goBack();
      await oldest.waitFor();
      await page.locator('#rail button.railcard').filter({ hasText: 'Review export' }).click();
      await newest.waitFor();
      expect(await oldest.count()).toBe(0);
      expect(await page.evaluate(() => history.state.arcExport.session)).toBe('root');
      expect(await page.evaluate(() => history.length)).toBe(initialLength + 2);
      await page.close();
    }
  });

  it('returns native and dispatched child headings to their older launching turn', async (t) => {
    if (!browser) t.skip('Edge or Chrome is required');
    for (const kind of ['subagent', 'dispatched'] as const) {
      const writer = await ExportTransaction.create(tempDir('arc-site-parent-'));
      const model = await sessionSiteFixture(writer);
      model.relationships[0] = { ...model.relationships[0], kind, turn: 'root-0' };
      const spool = await writer.readSpool<import('./exportdata').ExportPage>(model.sessions[0].pages.at(-1)!);
      spool.turns[0].relationships = ['reader-link'];
      model.sessions[0].pages[model.sessions[0].pages.length - 1] = await writer.spool(spool);
      await projectSessionSite(model, writer, exportBrowserAssets());
      const captured = await writer.publish(async () => {});
      const page = await browser!.newPage();
      await page.goto(pathToFileURL(captured.index).href);
      await page.locator('article[data-key="root-21"]').waitFor();
      await page.getByRole('button', { name: 'Older turns', exact: true }).click();
      const launch = page.locator('article[data-key="root-0"]');
      await launch.locator('.head').click();
      await launch.locator('[data-control^="session:"]').filter({ hasText: 'Linked session' }).click();
      await page.locator('article[data-key="child-0"]').waitFor();
      await page.locator('.sessionparent').click();
      await launch.waitFor();
      expect(await page.locator('article[data-key="root-21"]').count()).toBe(0);
      await page.close();
    }
  });

  it('rolls a bounded decoded page over and restores it through native history', async (t) => {
    if (!browser) t.skip('Edge or Chrome is required');
    const writer = await ExportTransaction.create(tempDir('arc-site-rollover-'));
    const model = await sessionSiteFixture(writer);
    model.sessions = [model.sessions[0]];
    // The viewer drops the newer page only when both pages together exceed the retained byte limit.
    // A card holds its answer text about five times, so each page lands just above half of the limit.
    for (const index of [0, 1]) {
      const spool = await writer.readSpool<import('./exportdata').ExportPage>(model.sessions[0].pages[index]);
      spool.turns[0].blocks.find((block) => block.kind === 'answer')!.text =
        'x'.repeat(3.5 * 1024 * 1024) + ` complete ${index}`;
      model.sessions[0].pages[index] = await writer.spool(spool);
    }
    model.sessions[0].pages = model.sessions[0].pages.slice(0, 2);
    await projectSessionSite(model, writer, exportBrowserAssets());
    const captured = await writer.publish(async () => {});
    const pageBytes = exportedSiteData(captured.directory).manifest.sessions[0].pages.map((value) => value.bytes);
    expect(pageBytes).toHaveLength(2);
    expect(pageBytes[0] + pageBytes[1]).toBeGreaterThan(EXPORT_LIMITS.retainedBytes);
    const page = await browser!.newPage();
    await page.goto(pathToFileURL(captured.index).href);
    const newer = page.locator('article[data-key="root-21"]');
    const older = page.locator('article[data-key="root-20"]');
    await newer.waitFor();
    await page.getByRole('button', { name: 'Older turns', exact: true }).click();
    await older.waitFor();
    expect(await newer.count()).toBe(0);
    expect(
      await page.evaluate(
        () => (window as unknown as { __arcExportMetrics: { retainedBytes: number } }).__arcExportMetrics.retainedBytes,
      ),
    ).toBeLessThanOrEqual(EXPORT_LIMITS.retainedBytes);
    await page.goBack();
    await newer.waitFor();
    expect(await older.count()).toBe(0);
    await page.goForward();
    await older.waitFor();
    expect(await newer.count()).toBe(0);
    await page.close();
  }, 90_000);
});
