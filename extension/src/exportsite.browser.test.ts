import { createServer, type Server } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserOrNone } from '../test/browser.ts';
import { tempDir } from './temproot';
import { ExportTransaction } from './exportwriter';
import { sessionSiteFixture } from './turnfixtures';
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
    await projectSessionSite(await sessionSiteFixture(writer), writer, exportBrowserAssets());
    directory = (await writer.publish(async () => {})).directory;
    server = createServer((request, response) => {
      const name = path.basename(new URL(request.url ?? '/', 'http://localhost').pathname);
      const file = path.join(directory, name || 'index.html');
      if (!fs.existsSync(file)) {
        response.writeHead(404).end();
        return;
      }
      response.setHeader(
        'Content-Type',
        name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html',
      );
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

  it('opens file and root or nested HTTP sites with local navigation and complete lazy text', async (t) => {
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
      await page.locator('article[data-key="root-21"] .head').waitFor();
      if (process.env.ARC_SITE_SHOTS && address.startsWith('file:')) {
        fs.mkdirSync(process.env.ARC_SITE_SHOTS, { recursive: true });
        for (const theme of ['dark', 'light'])
          for (const width of [1350, 390]) {
            await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption(theme);
            await page.setViewportSize({ width, height: 850 });
            await page.screenshot({ path: path.join(process.env.ARC_SITE_SHOTS, `${theme}-${width}.png`) });
          }
        await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption('dark');
        await page.setViewportSize({ width: 1350, height: 850 });
      }
      expect(await page.locator('article').count()).toBe(20);
      const initial = await page.evaluate(
        () =>
          (window as unknown as { __arcExportMetrics: { cards: number; previewBytes: number; retainedBytes: number } })
            .__arcExportMetrics,
      );
      expect(initial.cards).toBeLessThanOrEqual(EXPORT_LIMITS.initialCards);
      expect(initial.previewBytes).toBeLessThanOrEqual(EXPORT_LIMITS.initialTextBytes);
      const first = page.locator('article[data-key="root-21"]');
      await first.locator('.head').focus();
      await page.keyboard.press('Enter');
      await first.getByRole('button', { name: 'Read recorded text', exact: true }).click();
      await first.locator('[data-block="root-21-later-12"]').waitFor();
      const answer = first.locator('[data-block="root-21-answer"]');
      await answer.getByRole('button', { name: 'Read full text', exact: true }).click();
      await answer.locator('[data-full-text]').waitFor();
      await answer.getByRole('button', { name: 'Next text', exact: true }).click();
      await page.waitForFunction(() =>
        document.querySelector('[data-full-text="root-21-answer"]')?.textContent?.includes('final sentinel'),
      );
      expect(await answer.locator('a, img, iframe, script, [data-link], [data-image]').count()).toBe(0);
      expect(await page.evaluate(() => (window as unknown as { attacked?: boolean }).attacked)).toBeUndefined();
      expect(
        await page.evaluate(() => typeof (window as unknown as { acquireVsCodeApi?: unknown }).acquireVsCodeApi),
      ).toBe('undefined');
      expect(
        await page
          .locator('input[type="file"], textarea, [contenteditable], [data-control^="composer"], #layoutpop')
          .count(),
      ).toBe(0);
      await page.getByRole('button', { name: 'Older turns', exact: true }).click();
      await page.locator('article[data-key="root-0"]').waitFor();
      await page
        .getByRole('navigation', { name: 'Sessions', exact: true })
        .getByRole('link', { name: 'Linked session', exact: true })
        .click();
      await page.locator('article[data-key="child-0"]').waitFor();
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await page.locator('article[data-key="root-21"]').waitFor();
      await page.getByRole('button', { name: 'Forward', exact: true }).click();
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

  it('filters saved names and changes local layout while following contextual linked work', async (t) => {
    if (!browser) t.skip('Edge or Chrome is required');
    const page = await browser!.newPage();
    await page.goto(pathToFileURL(path.join(directory, 'index.html')).href);
    const first = page.locator('article[data-key="root-21"]');
    await first.locator('.head').waitFor();
    const filter = page.getByRole('searchbox', { name: 'Filter sessions', exact: true });
    await filter.fill('agent:codex title:Linked');
    await page.waitForFunction(() => document.querySelector('#export-sessions nav')?.children.length === 1);
    expect(await page.locator('#export-sessions nav').textContent()).toBe('Linked session');
    await filter.fill('');
    await first.locator('.head').click();
    await first
      .getByRole('navigation', { name: 'Linked work', exact: true })
      .getByRole('link', { name: 'Linked session', exact: true })
      .waitFor();
    expect(await first.getByText('Work is not included: missing.', { exact: true }).count()).toBe(1);
    if (process.env.ARC_SITE_SHOTS) {
      for (const theme of ['dark', 'light'])
        for (const width of [1350, 390]) {
          await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption(theme);
          await page.setViewportSize({ width, height: 850 });
          await page.screenshot({ path: path.join(process.env.ARC_SITE_SHOTS, `${theme}-${width}-linked.png`) });
        }
    }
    await page.getByRole('combobox', { name: 'Card layout', exact: true }).selectOption('one-column');
    await first.getByRole('navigation', { name: 'Linked work', exact: true }).waitFor();
    await page.getByRole('combobox', { name: 'Prompt position', exact: true }).selectOption('above');
    await first.locator('.export-prompt').waitFor();
    expect(
      await first.evaluate(
        (element) =>
          element.querySelector('.export-prompt')!.compareDocumentPosition(element.querySelector('.summary')!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBeTruthy();
    await page.getByRole('combobox', { name: 'Card layout', exact: true }).selectOption('compact');
    await first.getByText('Recorded figures and changes', { exact: true }).waitFor();
    await first
      .getByRole('navigation', { name: 'Linked work', exact: true })
      .getByRole('link', { name: 'Linked session', exact: true })
      .focus();
    await page.keyboard.press('Enter');
    await page.locator('h2').filter({ hasText: 'Linked session' }).waitFor();
    const parent = page
      .getByRole('navigation', { name: 'Parent session', exact: true })
      .getByRole('link', { name: 'Parent: Review export', exact: true });
    await parent.focus();
    await page.keyboard.press('Enter');
    await first.getByRole('navigation', { name: 'Linked work', exact: true }).waitFor();
    expect(await page.evaluate(() => location.hash)).toBe('#root/root-21');
    expect(
      await page.locator('input[type="file"], textarea, [contenteditable], [data-control^="composer"]').count(),
    ).toBe(0);
    await page.close();
  });
});
