import { createServer, type Server } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserOrNone } from '../test/browser.ts';
import { tempDir } from './temproot.ts';

describe('read-only web demo', () => {
  let browser: Awaited<ReturnType<typeof browserOrNone>>;
  let directory: string;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    browser = await browserOrNone();
    if (!browser) return;
    directory = tempDir('arc-web-demo-');
    const build = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/web-demo.ts', directory], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
    });
    if (build.status !== 0) throw new Error(build.stderr || build.stdout);
    server = createServer((request, response) => {
      const name = path.basename(new URL(request.url ?? '/', 'http://localhost').pathname);
      const file = path.join(directory, name === 'arc-vscode' || !name ? 'index.html' : name);
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
    let address = server.address();
    while (
      address &&
      typeof address !== 'string' &&
      [6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080].includes(address.port)
    ) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      address = server.address();
    }
    if (!address || typeof address === 'string') throw new Error('Demo server has no port');
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await browser?.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // The demo starts on the default Quick filters, which leave Unread off the head. These cases
  // tick it through View, as a reader would, before they read the Unread count.
  const showUnread = async (page: Awaited<ReturnType<NonNullable<typeof browser>['newPage']>>) => {
    await page.locator('[data-control="railfilters"]').click();
    await page.locator('[data-control="railheadlens:unread"]').check();
    await page.keyboard.press('Escape');
  };

  it('moves back and forward through selected sessions and parent links without changing saved labels or read marks', async (t) => {
    if (!browser) t.skip('Edge or Chrome is required');
    for (const width of [1280, 390]) {
      const page = await browser!.newPage();
      page.setDefaultTimeout(5_000);
      await page.setViewportSize({ width, height: 850 });
      await page.goto(`${base}/`);
      const picker = page.locator('[data-control="picker"]');
      await page.locator('[data-control="session:arc-read-state"]').waitFor();
      const unchanged = async (messages: unknown[]) => {
        expect(
          await page.evaluate((messages) => {
            const api = (
              window as unknown as { acquireVsCodeApi(): { postMessage(message: unknown): void } }
            ).acquireVsCodeApi();
            let replies = 0;
            const count = () => replies++;
            window.addEventListener('message', count);
            for (const message of messages) api.postMessage(message);
            window.removeEventListener('message', count);
            return replies;
          }, messages),
        ).toBe(0);
      };
      const choose = async (session: string) => {
        if (width === 1280) await page.locator(`[data-control="rail:${session}"]`).first().click();
        else await picker.selectOption(session);
        await page.locator(`[data-control="session:${session}"]`).waitFor();
      };
      const move = async (button: number, session: string) => {
        await page.dispatchEvent('#list', 'mousedown', { button });
        await page.dispatchEvent('#list', 'mouseup', { button });
        await page.locator(`[data-control="session:${session}"]`).waitFor();
        expect(await picker.inputValue()).toBe(session);
      };
      await unchanged([
        { type: 'goBack' },
        { type: 'goForward' },
        { type: 'showSession', session: 'arc-read-state' },
        { type: 'showSession', session: 'unknown-session' },
      ]);
      await choose('arc-demo-continuation');
      await page.locator('[data-control="sessionlabels:arc-demo-continuation"]').click();
      await page.locator('#labelpop [data-control="label-find"]').fill('navigation');
      await page.locator('#labelpop input[data-control="label:navigation"]').check();
      await page
        .locator('.sessionlabels .sessionlabel')
        .filter({ hasText: /^navigation$/ })
        .waitFor();
      await page.keyboard.press('Escape');
      const readKeys = await page.evaluate(() => {
        const state = (window as unknown as { acquireVsCodeApi(): { getState(): { read: string[] } } })
          .acquireVsCodeApi()
          .getState();
        return state.read.filter((key) => key.startsWith('arc-demo-continuation:'));
      });
      expect(readKeys.length).toBeGreaterThan(0);
      await page.locator('[data-control="sessionparent:arc-demo-dispatch"]').click();
      await page.locator('[data-control="session:arc-demo-dispatch"]').waitFor();
      await move(3, 'arc-demo-continuation');
      await page
        .locator('.sessionlabels .sessionlabel')
        .filter({ hasText: /^navigation$/ })
        .waitFor();
      await move(4, 'arc-demo-dispatch');
      await move(3, 'arc-demo-continuation');
      await unchanged([
        { type: 'showSession', session: 'arc-demo-continuation' },
        { type: 'showReaderParent', session: 'unknown-parent' },
      ]);
      await move(4, 'arc-demo-dispatch');
      await move(3, 'arc-demo-continuation');
      await choose('delegated-cost');
      await unchanged([{ type: 'goForward' }]);
      await move(3, 'arc-demo-continuation');
      await page
        .locator('.sessionlabels .sessionlabel')
        .filter({ hasText: /^navigation$/ })
        .waitFor();
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { acquireVsCodeApi(): { getState(): { read: string[] } } })
              .acquireVsCodeApi()
              .getState().read,
        ),
      ).toEqual(expect.arrayContaining(readKeys));
      await move(3, 'arc-read-state');
      await unchanged([{ type: 'goBack' }]);
      await page.close();
    }
  });

  it('follows platform Back and Forward shortcuts and preserves editable keyboard actions', async (t) => {
    if (!browser) t.skip('Edge or Chrome is required');
    for (const [platform, back, forward] of [
      ['Win32', 'Alt+ArrowLeft', 'Alt+ArrowRight'],
      ['MacIntel', 'Control+-', 'Control+Shift+-'],
      ['Linux x86_64', 'Control+Alt+-', 'Control+Shift+-'],
    ]) {
      const page = await browser!.newPage();
      page.setDefaultTimeout(5_000);
      await page.addInitScript(
        (platform) => Object.defineProperty(navigator, 'platform', { value: platform }),
        platform,
      );
      await page.setViewportSize({ width: 390, height: 850 });
      await page.goto(`${base}/`);
      const picker = page.locator('[data-control="picker"]');
      await picker.selectOption('delegated-cost');
      await page.locator('[data-control="session:delegated-cost"]').waitFor();
      await page.locator('#prompt').fill('Keep this draft');
      await page.locator('#prompt').press(back);
      expect(await picker.inputValue()).toBe('delegated-cost');
      expect(await page.locator('#prompt').inputValue()).toBe('Keep this draft');
      await page.locator('#list .session').first().focus();
      await page.keyboard.press(back);
      await page.locator('[data-control="session:arc-read-state"]').waitFor();
      await page.locator('#list .session').first().focus();
      await page.keyboard.press(forward);
      await page.locator('[data-control="session:delegated-cost"]').waitFor();
      expect(await picker.inputValue()).toBe('delegated-cost');
      await page.close();
    }
  });

  it('keeps decorative chrome outside keyboard navigation and panel overlays reachable', async (t) => {
    if (!browser) t.skip('Edge or Chrome is required');
    for (const width of [1280, 390]) {
      for (const theme of ['dark', 'light']) {
        const page = await browser!.newPage();
        page.setDefaultTimeout(5_000);
        await page.setViewportSize({ width, height: 850 });
        await page.goto(`${base}/`);
        await page.locator('#demo-theme').selectOption(theme);
        await page.locator('#composer .cctx').waitFor();
        expect(await page.locator('.demo-shell').getAttribute('aria-hidden')).toBe('true');
        expect(
          await page
            .locator('.demo-shell button, .demo-shell a, .demo-shell input, .demo-shell select, .demo-shell [tabindex]')
            .count(),
        ).toBe(0);
        expect(await page.locator('.shell-activity').isVisible()).toBe(width === 1280);
        expect(await page.locator('.shell-titlebar').isVisible()).toBe(width === 1280);
        await page.locator('#demo-theme').focus();
        await page.keyboard.press('Tab');
        expect(await page.evaluate(() => !document.activeElement?.closest('.demo-shell'))).toBe(true);
        // Read actual boundaries rather than prescribed shell dimensions.
        const bounds = () =>
          page.evaluate(() => {
            const list = document.querySelector('#list')!.getBoundingClientRect();
            const composer = document.querySelector('#composer')!.getBoundingClientRect();
            const status = document.querySelector('#statusbar')!.getBoundingClientRect();
            const tabs = document.querySelector('.shell-tabs')!.getBoundingClientRect();
            const heading = document.querySelector('#list .sessionrow')!.getBoundingClientRect();
            const rail = document.querySelector('#rail')!.getBoundingClientRect();
            const panelLeft = getComputedStyle(document.body).paddingLeft;
            return {
              composerAligned: Math.abs(composer.left - list.left) < 1,
              statusAligned: Math.abs(status.left - parseFloat(panelLeft)) < 1,
              headingBelowTabs: heading.top >= tabs.bottom,
              railBelowTabs: rail.top >= tabs.bottom,
            };
          });
        await expect.poll(bounds).toMatchObject({
          composerAligned: true,
          statusAligned: true,
          headingBelowTabs: true,
          ...(width === 1280 ? { railBelowTabs: true } : {}),
        });
        await page.locator('#composer .cctx').focus();
        await page.locator('#composer-context-detail').waitFor({ state: 'visible' });
        const reachable = (selector: string) =>
          page.locator(selector).evaluate((element) => {
            const box = element.getBoundingClientRect();
            return (
              box.top >= 0 &&
              box.left >= 0 &&
              box.bottom <= innerHeight &&
              box.right <= innerWidth &&
              element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))
            );
          });
        expect(await reachable('#composer-context-detail')).toBe(true);
        await page.keyboard.press('Escape');
        await page.locator('.sbrow').click();
        await page.locator('#usagepop').waitFor({ state: 'visible' });
        expect(await reachable('#usagepop')).toBe(true);
        await page.keyboard.press('Escape');
        await page.locator('#list .sessionrow .session').first().focus();
        await page.keyboard.press('Shift+F10');
        await page.locator('.demo-menu').waitFor();
        expect(await reachable('.demo-menu')).toBe(true);
        await page.keyboard.press('Escape');
        await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
        await expect.poll(bounds).toMatchObject({ composerAligned: true, statusAligned: true, headingBelowTabs: true });
        if (process.env.ARC_DEMO_SHOTS) {
          await page.evaluate(() => scrollTo(0, 0));
          await page.waitForFunction(() => scrollY === 0);
          fs.mkdirSync(process.env.ARC_DEMO_SHOTS, { recursive: true });
          await page.screenshot({ path: path.join(process.env.ARC_DEMO_SHOTS, `shell-${theme}-${width}.png`) });
        }
        await page.evaluate(() => scrollTo(0, 0));
        await page.waitForFunction(() => scrollY === 0);
        const sash = page.locator('#footsash');
        const prompt = page.locator('#prompt');
        await prompt.fill('Opening prompt line\nSecond prompt line\nThird prompt line');
        const expandedPrompt = () =>
          page.evaluate(() => {
            const tabs = document.querySelector('.shell-tabs')!.getBoundingClientRect();
            const sash = document.querySelector('#footsash')!.getBoundingClientRect();
            const prompt = document.querySelector<HTMLTextAreaElement>('#prompt')!;
            const field = prompt.getBoundingClientRect();
            const style = getComputedStyle(prompt);
            const openingTop = field.top + parseFloat(style.paddingTop);
            const openingBottom = openingTop + parseFloat(style.lineHeight);
            return {
              separatorBelowFrame: sash.top >= tabs.bottom,
              openingBelowFrame: openingTop >= tabs.bottom,
              openingVisible: prompt.scrollTop === 0 && openingBottom <= field.bottom,
            };
          });
        for (const method of ['keyboard', 'drag']) {
          await sash.press('Home');
          if (method === 'keyboard') await sash.press('End');
          else {
            const box = (await sash.boundingBox())!;
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.down();
            await page.mouse.move(box.x + box.width / 2, 0);
            await page.mouse.up();
          }
          await page.waitForFunction(() => {
            const sash = document.querySelector('#footsash')!;
            return sash.getAttribute('aria-valuenow') === sash.getAttribute('aria-valuemax');
          });
          expect(Number(await sash.getAttribute('aria-valuenow'))).toBeGreaterThan(
            Number(await sash.getAttribute('aria-valuemin')),
          );
          if (process.env.ARC_DEMO_SHOTS)
            await page.screenshot({
              path: path.join(process.env.ARC_DEMO_SHOTS, `maximum-${method}-${theme}-${width}.png`),
            });
          await expect.poll(expandedPrompt).toEqual({
            separatorBelowFrame: true,
            openingBelowFrame: true,
            openingVisible: true,
          });
          expect(await reachable('#footsash')).toBe(true);
        }
        await page.close();
      }
    }
  }, 60_000);

  it('resolves context detail, exposes three turns and opens the default cross-provider dispatch', async (t) => {
    if (!browser) t.skip('Edge or Chrome is required');
    for (const width of [1280, 390]) {
      for (const theme of ['dark', 'light']) {
        const page = await browser!.newPage();
        page.setDefaultTimeout(5_000);
        await page.setViewportSize({ width, height: 850 });
        await page.goto(`${base}/`);
        await page.locator('#demo-theme').selectOption(theme);
        await page.locator('#list .turn').first().waitFor();
        expect(await page.locator('#list .turn').count()).toBe(3);
        expect(await page.locator('#list .turn').first().textContent()).toContain('Claude');
        await page.locator('.sessionstats [data-metric="cache-expiry"]').click();
        await page.locator('#chippop').waitFor({ state: 'visible' });
        await page.keyboard.press('Escape');
        for (const session of ['arc-read-state', 'delegated-cost']) {
          if (width === 1280) await page.locator(`[data-control="rail:${session}"]`).first().click();
          else await page.locator('[data-control="picker"]').selectOption(session);
          await page.locator('.cctx').focus();
          const detail = page.locator('#composer-context-detail');
          await expect.poll(() => detail.locator('.context-categories li').count(), { timeout: 5_000 }).toBe(4);
          expect(await detail.textContent()).not.toContain('Loading');
          if (process.env.ARC_DEMO_SHOTS) {
            fs.mkdirSync(process.env.ARC_DEMO_SHOTS, { recursive: true });
            await page.screenshot({
              path: path.join(process.env.ARC_DEMO_SHOTS, `context-${session}-${theme}-${width}.png`),
              fullPage: true,
            });
          }
          await page.keyboard.press('Escape');
        }
        if (width === 1280) await page.locator('[data-control="rail:arc-read-state"]').first().click();
        else await page.locator('[data-control="picker"]').selectOption('arc-read-state');
        const child = page.locator('#list .cardrecord [data-control$=":arc-demo-sketch"]');
        await child.waitFor();
        if (process.env.ARC_DEMO_SHOTS)
          await page.screenshot({
            path: path.join(process.env.ARC_DEMO_SHOTS, `default-${theme}-${width}.png`),
            fullPage: true,
          });
        await child.click();
        await page.locator('[data-control="session:arc-demo-sketch"]').waitFor();
        expect(await page.locator('#list .turn').first().textContent()).toContain('Codex');
        await page.locator('[data-control="sessionparent:arc-read-state"]').click();
        await page.locator('[data-control="session:arc-read-state"]').waitFor();
        expect(await page.locator('#list .turn').count()).toBe(3);
        await page.close();
      }
    }
  }, 60_000);

  it('explores the real rail, Activity, a cost detail, and themes at a project path', async (t) => {
    if (!browser) t.skip('Edge or Chrome is required');
    const page = await browser!.newPage();
    await page.setViewportSize({ width: 1280, height: 850 });
    await page.goto(`${base}/arc-vscode/`);
    await page.locator('[data-control="rail:arc-read-state"]').first().waitFor();
    const failedRun = page.locator('.activitysec button.actrow.run[data-control$=":run:17"]');
    await failedRun.waitFor();
    expect(await failedRun.getAttribute('aria-expanded')).toBe('true');
    if (process.env.ARC_DEMO_SHOTS) {
      fs.mkdirSync(process.env.ARC_DEMO_SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.ARC_DEMO_SHOTS, 'desktop.png'), fullPage: true });
    }
    await page.locator('.activitysec .saidtext').getByText('The view-switching test shows an unread result').waitFor();
    await page.locator('.activitysec [data-control^="activity-skills:"]').waitFor();
    expect(await page.locator('[data-bucket="railgroup:view:review"]').count()).toBe(1);
    await page.locator('.activitysec .actcode').getByText('read-state test failed after switching views').waitFor();
    await page.locator('.activitysec .actcode').getByText('read-state test passed').waitFor();
    await page.locator('[data-control="railpin:delegated-cost"]').first().click();
    await page.locator('[data-control="railpin:delegated-cost"]').first().click();
    await page.locator('[data-control="railpin:delegated-cost"].is-pinned').first().waitFor();
    expect(await page.locator('[data-control="rail:delegated-cost"]').first().getAttribute('aria-label')).toContain(
      'pinned',
    );
    await page.locator('[data-control="rail:delegated-cost"]').first().click();
    await page.waitForFunction(() => document.querySelectorAll('#list .turn').length === 4);
    expect(await page.locator('[data-control="railpin:delegated-cost"].is-pinned').count()).toBeGreaterThan(0);
    await page.locator('[data-control="railpin:delegated-cost"]').first().click();
    expect(await page.locator('[data-control="rail:delegated-cost"]').first().getAttribute('aria-label')).not.toContain(
      'pinned',
    );
    const heading = page.locator('#list .turn h3.cardheading button.head').first();
    if ((await heading.getAttribute('aria-expanded')) === 'false') await heading.click();
    await page.locator('#list .turn .recordfiles').first().waitFor({ state: 'visible' });
    await page.locator('#list .turn [data-metric="cost"]').first().click();
    await page.locator('#chippop').waitFor({ state: 'visible' });
    await page.locator('[data-control="railsearch"]').click();
    await page.locator('.railfilter').fill('agent:claude');
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('#rail .railcard')).every((row) => row.textContent?.includes('Claude')),
    );
    expect(await page.locator('#rail .railcard').count()).toBeGreaterThan(0);
    expect(await page.locator('[data-control="rail:arc-read-state"]').count()).toBeGreaterThan(0);
    expect(await page.locator('[data-control="rail:arc-codex-read-state"]').count()).toBe(0);
    await page.locator('[data-control="railclear"]').click();
    await page.locator('[data-control="railcount:running"]').click();
    expect(await page.locator('[data-control="railcount:running"]').getAttribute('aria-pressed')).toBe('true');
    await page.locator('[data-control="railcount:running"]').click();
    await showUnread(page);
    await page.locator('[data-control="railcount:unread"]').click();
    expect(await page.locator('[data-control="railcount:unread"]').getAttribute('aria-pressed')).toBe('true');
    await page.locator('[data-control="railcount:unread"]').click();
    await page.locator('#demo-theme').selectOption('dark');
    expect(await page.locator('html').getAttribute('data-theme')).toBe('dark');
    await page.locator('#demo-theme').selectOption('light');
    expect(await page.locator('body').getAttribute('class')).toBe('vscode-light');
    await page.locator('#demo-theme').selectOption('onedark');
    expect(await page.locator('html').getAttribute('data-theme')).toBe('onedark');
  }, 60_000);

  it('keeps narrow cost detail reachable', async (t) => {
    if (!browser) t.skip('Edge or Chrome is required');
    const page = await browser!.newPage();
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(`${base}/`);
    await page.locator('[data-control="picker"]').waitFor();
    expect(await page.locator('#list > .controls').isVisible()).toBe(true);
    const heading = page.locator('#list .turn h3.cardheading button.head').first();
    if ((await heading.getAttribute('aria-expanded')) === 'false') await heading.click();
    await page.locator('#list .turn .summary').first().waitFor({ state: 'visible' });
    await page.locator('#list .turn [data-metric="cost"]').first().click();
    await page.locator('#chippop.pinned').waitFor({ state: 'visible' });
    const detail = await page.evaluate(() => {
      const pop = document.querySelector<HTMLElement>('#chippop')!;
      const heading = pop.querySelector<HTMLElement>('.chippophead')!;
      const rect = pop.getBoundingClientRect();
      const headRect = heading.getBoundingClientRect();
      const top = document.elementFromPoint(headRect.left + headRect.width / 2, headRect.top + headRect.height / 2);
      return { top: rect.top, bottom: rect.bottom, reachable: pop.contains(top) };
    });
    expect(detail.top).toBeGreaterThanOrEqual(0);
    expect(detail.bottom).toBeLessThanOrEqual(800);
    expect(detail.reachable).toBe(true);
    if (process.env.ARC_DEMO_SHOTS) {
      await page.screenshot({ path: path.join(process.env.ARC_DEMO_SHOTS, 'narrow-cost.png'), fullPage: true });
    }
  });

  it('comments on selected response text and retains turn ownership through navigation, edits, and deletion', async (t) => {
    if (!browser) t.skip('Edge or Chrome is required');
    for (const width of [1280, 390]) {
      for (const theme of ['dark', 'light']) {
        const page = await browser!.newPage();
        page.setDefaultTimeout(5_000);
        await page.setViewportSize({ width, height: 850 });
        await page.goto(`${base}/arc-vscode/`);
        await page.locator('#demo-theme').selectOption(theme);
        const summary = page.locator('#list .turn .summary').first();
        await summary.waitFor({ state: 'visible' });
        await summary.scrollIntoViewIfNeeded();
        const selected = await summary.evaluate((response) => {
          const range = document.createRange();
          range.selectNodeContents(response.querySelector('p')!);
          const selection = window.getSelection()!;
          selection.removeAllRanges();
          selection.addRange(range);
          document.dispatchEvent(new Event('selectionchange'));
          return { quote: selection.toString().trim(), key: response.closest<HTMLElement>('.turn')!.dataset.key };
        });
        if (width === 1280) {
          const endpoints = await summary.evaluate((response) => {
            const text = response.querySelector('p')!.firstChild!;
            const range = document.createRange();
            range.setStart(text, 0);
            range.setEnd(text, 1);
            const start = range.getBoundingClientRect();
            range.setStart(text, 24);
            range.setEnd(text, 25);
            const end = range.getBoundingClientRect();
            return {
              start: { x: start.left + 1, y: start.top + start.height / 2 },
              end: { x: end.right - 1, y: end.top + end.height / 2 },
            };
          });
          await page.mouse.move(endpoints.start.x, endpoints.start.y);
          await page.mouse.down();
          await page.mouse.move(endpoints.end.x, endpoints.end.y, { steps: 8 });
          await page.mouse.up();
          selected.quote = await page.evaluate(() => window.getSelection()!.toString().trim());
        }
        expect(selected.quote.length).toBeGreaterThan(0);
        if (process.env.ARC_DEMO_SHOTS) {
          fs.mkdirSync(process.env.ARC_DEMO_SHOTS, { recursive: true });
          await page.screenshot({ path: path.join(process.env.ARC_DEMO_SHOTS, `selection-${theme}-${width}.png`) });
        }
        await page.locator('.quotefloat').waitFor({ state: 'visible' });
        if (width === 1280) await page.locator('.quoteact').click();
        else await page.keyboard.press('c');
        const area = page.locator('.notearea');
        await area.waitFor({ state: 'visible' });
        expect(await area.evaluate((element) => element === document.activeElement)).toBe(true);
        await area.fill('Please check this response');
        if (process.env.ARC_DEMO_SHOTS)
          await page.screenshot({ path: path.join(process.env.ARC_DEMO_SHOTS, `editor-${theme}-${width}.png`) });
        if (width === 1280) await page.locator('.notesave').click();
        else await area.press('Enter');
        const comments = () =>
          page.evaluate(
            () =>
              (
                window as unknown as {
                  acquireVsCodeApi(): {
                    getState(): {
                      comments: { id: string; sessionId: string; turnKey: string; quote: string; note: string }[];
                    };
                  };
                }
              )
                .acquireVsCodeApi()
                .getState().comments,
          );
        await expect.poll(comments).toContainEqual(
          expect.objectContaining({
            sessionId: 'arc-read-state',
            turnKey: selected.key,
            quote: selected.quote,
            note: 'Please check this response',
          }),
        );
        const comment = (await comments()).find((entry) => entry.note === 'Please check this response')!;
        const mark = page.locator(`[data-control="linemark:${comment.id}"]`).first();
        await mark.waitFor();
        if (process.env.ARC_DEMO_SHOTS)
          await page.screenshot({ path: path.join(process.env.ARC_DEMO_SHOTS, `saved-${theme}-${width}.png`) });
        const navigate = async (session: string) => {
          if (width === 1280) await page.locator(`[data-control="rail:${session}"]`).first().click();
          else await page.locator('[data-control="picker"]').selectOption(session);
          await page.locator(`[data-control="session:${session}"]`).waitFor();
        };
        await navigate('delegated-cost');
        expect(await page.locator(`[data-control="linemark:${comment.id}"]`).count()).toBe(0);
        await page.dispatchEvent('#list', 'mousedown', { button: 3 });
        await page.dispatchEvent('#list', 'mouseup', { button: 3 });
        await mark.waitFor();
        await page.dispatchEvent('#list', 'mousedown', { button: 4 });
        await page.dispatchEvent('#list', 'mouseup', { button: 4 });
        await page.locator('[data-control="session:delegated-cost"]').waitFor();
        expect(await page.locator(`[data-control="linemark:${comment.id}"]`).count()).toBe(0);
        await page.dispatchEvent('#list', 'mousedown', { button: 3 });
        await page.dispatchEvent('#list', 'mouseup', { button: 3 });
        await mark.waitFor();
        await mark.focus();
        await mark.press('Enter');
        await page.locator(`[data-control="noteedit:${comment.id}"]`).press('Enter');
        await area.fill('Please check both providers');
        await area.press('Enter');
        await expect
          .poll(comments)
          .toContainEqual(expect.objectContaining({ id: comment.id, note: 'Please check both providers' }));
        await navigate('delegated-cost');
        await navigate('arc-read-state');
        await mark.press('Enter');
        await page.locator(`[data-control="notedel:${comment.id}"]`).press('Enter');
        await expect.poll(comments).not.toContainEqual(expect.objectContaining({ id: comment.id }));
        await navigate('delegated-cost');
        await navigate('arc-read-state');
        expect(await page.locator(`[data-control="linemark:${comment.id}"]`).count()).toBe(0);
        const heading = page.locator('#list .turn h3.cardheading button.head').first();
        await heading.focus();
        await heading.press('Shift+F10');
        await page.locator('.demo-menu').getByRole('menuitem', { name: 'Add a comment' }).press('Enter');
        await area.waitFor({ state: 'visible' });
        await area.press('Escape');
        expect(await page.locator('.noteedit').count()).toBe(0);
        expect(
          (await comments()).filter((entry) => entry.sessionId === 'arc-read-state').map((entry) => entry.id),
        ).toEqual(['demo-response-comment', 'demo-activity-comment']);
        await page.close();
      }
    }
  }, 60_000);

  describe.each(['Win32', 'MacIntel', 'Linux x86_64'])('host actions on %s', (platform) => {
    it('blocks host actions, forged render messages, and file bytes', async (t) => {
      if (!browser) t.skip('Edge or Chrome is required');
      const page = await browser!.newPage();
      page.setDefaultTimeout(5_000);
      await page.addInitScript(
        (platform) => Object.defineProperty(navigator, 'platform', { value: platform }),
        platform,
      );
      await page.setViewportSize({ width: 390, height: 800 });
      const requests: string[] = [];
      const warnings: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'warning') warnings.push(message.text());
      });
      page.on('request', (request) => requests.push(request.url()));
      await page.goto(`${base}/`);
      await page.locator('[data-control="picker"]').waitFor();
      await page.locator('.activitysec button.actrow.run[data-control$=":run:17"][aria-expanded="true"]').waitFor();
      if (process.env.ARC_DEMO_SHOTS) {
        fs.mkdirSync(process.env.ARC_DEMO_SHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.ARC_DEMO_SHOTS, 'narrow.png'), fullPage: true });
      }
      const result = await page.evaluate(() => {
        let reads = 0;
        const file = new File(['private'], 'private.txt', { type: 'text/plain' });
        file.arrayBuffer = async () => {
          reads++;
          return new ArrayBuffer(0);
        };
        const transfer = new DataTransfer();
        transfer.items.add(file);
        document
          .querySelector('#composer')!
          .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
        document
          .querySelector('#prompt')!
          .dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
        const text = new DataTransfer();
        text.setData('text/plain', 'Claude');
        const textPaste = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: text });
        document.querySelector('[data-control="picker"]')!.dispatchEvent(textPaste);
        for (const type of ['sendPrompt', 'answerAsk', 'stopTurn', 'openFile', 'openLink', 'newSession', 'unknown']) {
          (window as unknown as { acquireVsCodeApi(): { postMessage(message: unknown): void } })
            .acquireVsCodeApi()
            .postMessage({ type, session: 'arc-read-state', text: 'private' });
        }
        window.postMessage({ type: 'render', cards: [], sessions: [], rail: [] }, '*');
        return { reads, textPasteBlocked: textPaste.defaultPrevented };
      });
      expect(result).toEqual({ reads: 0, textPasteBlocked: false });
      await page.locator('[data-control="picker"]').selectOption('arc-cache-run');
      await page.waitForFunction(() => document.querySelector('#list .turn')?.textContent?.includes('little reuse'));
      expect(requests.every((url) => url.startsWith(base + '/'))).toBe(true);
      expect(requests.length).toBe(7);
      expect(warnings).toEqual([]);
      expect(await page.locator('#composer').isVisible()).toBe(true);
      expect(await page.locator('.compactnewsplit').isVisible()).toBe(true);
      const prompt = page.locator('#prompt');
      const draft = 'Explore a local draft';
      const chord = platform === 'MacIntel' ? 'Meta+Enter' : 'Control+Enter';
      const undo = platform === 'MacIntel' ? 'Meta+z' : 'Control+z';
      const recovery = () =>
        page.evaluate(
          () =>
            (window as unknown as { acquireVsCodeApi(): { getState(): { submittedPrompts?: unknown[] } } })
              .acquireVsCodeApi()
              .getState().submittedPrompts ?? [],
        );
      const before = await recovery();
      await prompt.fill(draft);
      for (const gesture of ['Enter', chord, 'Send', 'Elsewhere']) {
        if (gesture === 'Send') await page.locator('#composer .csend').dispatchEvent('click');
        else if (gesture === 'Elsewhere') {
          await page.locator('.compactnew').focus();
          await page.keyboard.press(chord);
        } else await prompt.press(gesture);
        expect(await prompt.inputValue()).toBe(draft);
        expect(await recovery()).toEqual(before);
      }
      for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
        for (const sendChord of [false, true]) {
          const defaultPrevented = await prompt.evaluate(
            (box, { composition, sendChord, platform }) => {
              const event = new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
                cancelable: true,
                ctrlKey: sendChord && platform !== 'MacIntel',
                metaKey: sendChord && platform === 'MacIntel',
                ...composition,
              });
              box.dispatchEvent(event);
              return event.defaultPrevented;
            },
            { composition, sendChord, platform },
          );
          expect({ text: await prompt.inputValue(), recovery: await recovery(), defaultPrevented }).toEqual({
            text: draft,
            recovery: before,
            defaultPrevented: false,
          });
        }
      }
      await prompt.focus();
      await prompt.evaluate((box: HTMLTextAreaElement) => box.setSelectionRange(0, 0));
      await prompt.press('ArrowUp');
      expect(await prompt.inputValue()).toBe(draft);
      await prompt.press('End');
      await prompt.press('Shift+Enter');
      expect(await prompt.inputValue()).toBe(draft + '\n');
      await prompt.press(undo);
      expect(await prompt.inputValue()).toBe(draft);
      await prompt.fill('/');
      await prompt.press(chord);
      expect(await prompt.inputValue()).toBe('/');
      expect(await recovery()).toEqual(before);
      await expect.poll(() => prompt.getAttribute('aria-expanded')).toBe('true');
      for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
        const defaultPrevented = await prompt.evaluate((box, composition) => {
          const event = new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
            ...composition,
          });
          box.dispatchEvent(event);
          return event.defaultPrevented;
        }, composition);
        expect({ text: await prompt.inputValue(), recovery: await recovery(), defaultPrevented }).toEqual({
          text: '/',
          recovery: before,
          defaultPrevented: false,
        });
      }
      await prompt.press('Enter');
      const completed = await prompt.inputValue();
      expect(completed.startsWith('/')).toBe(true);
      expect(completed).not.toBe('/');
      expect(await recovery()).toEqual(before);
      await prompt.fill(draft);
      await page.locator('[data-control="picker"]').selectOption('arc-read-state');
      await page.locator('[data-control="picker"]').selectOption('arc-cache-run');
      expect(await prompt.inputValue()).toBe(draft);
      await page.locator('.compactnew').click();
      expect(await page.locator('#demo-notice').count()).toBe(0);
      await page.locator('.compactnewmenu').click();
      await page.locator('#launcher').waitFor({ state: 'visible' });
      await page.locator('[data-control="launch-agent"]').click();
      await page.locator('[data-control="launch-agent:claude"]').click();
      await page.locator('[data-control="launch-create"]').click();
      expect(await page.locator('#demo-notice').count()).toBe(0);
      expect(await page.locator('#composer').isVisible()).toBe(true);
      expect(await page.locator('[data-control="picker"]').inputValue()).toBe('arc-cache-run');
      expect(requests.length).toBe(7);
      expect(warnings).toEqual([]);
    });
  });

  it('keeps rail filters, saved views, and archived state while changing sessions', async (t) => {
    if (!browser) t.skip('Edge or Chrome is required');
    const page = await browser!.newPage();
    page.setDefaultTimeout(5_000);
    await page.setViewportSize({ width: 1280, height: 850 });
    await page.goto(`${base}/`);
    await page.locator('[data-control="railfilters"]').click();
    await page.locator('[data-control="raillens:running"]').click();
    expect(await page.locator('[data-control="rail:arc-cache-run"]').count()).toBeGreaterThan(0);
    await page.locator('[data-control="raillens:all"]').click();
    await page.keyboard.press('Escape');
    await page.locator('[data-control="railsearch"]').click();
    await page.locator('.railfilter').fill('label:review');
    await page.waitForFunction(() => document.querySelector('.railfilter')?.getAttribute('aria-invalid') !== 'true');
    await page.locator('[data-control="railviewsave"]').click();
    await page.locator('.railfilter').fill('Review work');
    await page.locator('.railfilter').press('Enter');
    await page.locator('[data-control="rail:arc-demo-review"]').first().click();
    expect(await page.locator('.railfilter').inputValue()).toBe('label:review');
    await page.locator('[data-control="railclear"]').click();
    expect(await page.locator('.railbucket').filter({ hasText: 'Review work' }).count()).toBeGreaterThan(0);
    await page.locator('[data-control="railhide:arc-cache-run"]').first().click();
    await page.waitForFunction(() =>
      (window as unknown as { acquireVsCodeApi(): { getState(): { hidden: string[] } } })
        .acquireVsCodeApi()
        .getState()
        .hidden.includes('arc-cache-run'),
    );
    await page.locator('[data-control="rail:arc-read-state"]').first().click();
    expect(await page.locator('[data-bucket="railgroup:view:review"]').count()).toBe(1);
    expect(
      await page.evaluate(() =>
        (window as unknown as { acquireVsCodeApi(): { getState(): { hidden: string[] } } })
          .acquireVsCodeApi()
          .getState()
          .hidden.includes('arc-cache-run'),
      ),
    ).toBe(true);
    await page.setViewportSize({ width: 390, height: 800 });
    await page.locator('[data-control="picker"]').selectOption('arc-demo-review');
    await page.locator('.timeline-footer .hidden-note').getByRole('button', { name: 'Unarchive' }).click();
    await page.waitForFunction(
      () =>
        !(window as unknown as { acquireVsCodeApi(): { getState(): { hidden: string[] } } })
          .acquireVsCodeApi()
          .getState()
          .hidden.includes('arc-cache-run'),
    );
    await page.setViewportSize({ width: 1280, height: 850 });
    await page.locator('[data-control="rail:arc-cache-run"]').first().waitFor();
  });

  it('edits labels in the page from the session heading and a rail row', async (t) => {
    if (!browser) t.skip('Edge or Chrome is required');
    const page = await browser!.newPage();
    page.setDefaultTimeout(5_000);
    await page.setViewportSize({ width: 1280, height: 850 });
    const requests: string[] = [];
    const ignored: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    page.on('console', (message) => {
      if (message.text().includes('ignored a panel action')) ignored.push(message.text());
    });
    await page.goto(`${base}/`);
    const headingLabels = page.locator('.sessionlabels .sessionlabel');
    await headingLabels.first().waitFor();
    const loaded = requests.length;
    const railName = (id: string) => page.locator(`[data-control="rail:${id}"]`).first().getAttribute('aria-label');

    await page.locator('[data-control="sessionlabels:arc-read-state"]').click();
    await page.locator('#labelpop [data-control="label-find"]').fill('triage');
    await page.locator('#labelpop [data-control="label-create"]').click();
    await page.locator('.sessionlabels .sessionlabel[data-label="triage"]').waitFor();
    expect(await headingLabels.allTextContents()).toEqual(['review', 'navigation', 'triage']);
    await page.waitForFunction(() =>
      document.querySelector('[data-control="rail:arc-read-state"]')?.getAttribute('aria-label')?.includes('triage'),
    );
    await page.keyboard.press('Escape');
    await page.locator('#labelpop').waitFor({ state: 'hidden' });

    await page.locator('[data-control="rail:arc-demo-review"]').first().hover();
    await page.locator('[data-control="raillabels:arc-demo-review"]').first().click();
    const review = page.locator('#labelpop input[data-control="label:review"]');
    expect(await review.isChecked()).toBe(true);
    await review.click();
    await page.waitForFunction(
      () =>
        !document
          .querySelector('[data-control="rail:arc-demo-review"]')
          ?.getAttribute('aria-label')
          ?.includes('review'),
    );
    await page.keyboard.press('Escape');
    await page.locator('[data-control="railruns"]').click();

    await page.locator('[data-control="rail:arc-demo-review"]').first().click();
    await page.waitForFunction(() => document.querySelector('[data-control="sessionlabels:arc-demo-review"]'));
    expect(await headingLabels.count()).toBe(0);
    await page.locator('[data-control="rail:arc-read-state"]').first().click();
    await page.locator('[data-control="sessionlabels:arc-read-state"]').waitFor();
    expect(await headingLabels.allTextContents()).toEqual(['review', 'navigation', 'triage']);
    expect(await railName('arc-read-state')).toContain('triage');
    expect(await railName('arc-demo-review')).not.toContain('review');
    expect(ignored).toEqual([]);
    expect(requests.length).toBe(loaded);
    expect(requests.every((url) => url.startsWith(base + '/'))).toBe(true);
  });

  it('clears a read session from the unread filter and rail name across session switches', async (t) => {
    if (!browser) t.skip('Edge or Chrome is required');
    const page = await browser!.newPage();
    page.setDefaultTimeout(5_000);
    await page.setViewportSize({ width: 1280, height: 850 });
    await page.goto(`${base}/`);
    const cache = page.locator('[data-control="rail:arc-demo-continuation"]').first();
    await cache.waitFor();
    expect(await cache.getAttribute('aria-label')).toContain('1 new');
    await showUnread(page);
    expect(await page.locator('[data-control="railcount:unread"]').count()).toBe(1);
    await cache.click();
    const heading = page.locator('#list .turn h3.cardheading button.head').first();
    await heading.waitFor();
    expect(await heading.getAttribute('aria-expanded')).toBe('true');
    await page.waitForFunction(
      () =>
        !document
          .querySelector('[data-control="rail:arc-demo-continuation"]')
          ?.getAttribute('aria-label')
          ?.includes('1 new'),
    );
    await page.locator('[data-control="rail:arc-read-state"]').first().click();
    expect(
      await page.locator('[data-control="rail:arc-demo-continuation"]').first().getAttribute('aria-label'),
    ).not.toContain('1 new');
    expect(await page.locator('[data-control="railcount:unread"]').count()).toBe(0);
  });

  it('keeps the session unread state in step with its response read marks', async (t) => {
    if (!browser) t.skip('Edge or Chrome is required');
    const page = await browser!.newPage();
    page.setDefaultTimeout(5_000);
    await page.setViewportSize({ width: 1280, height: 850 });
    await page.goto(`${base}/`);
    const cache = page.locator('[data-control="rail:arc-demo-continuation"]').first();
    const cacheUnread = async () => (await cache.getAttribute('aria-label'))?.includes('1 new');
    const unreadFilter = page.locator('[data-control="railcount:unread"]');
    const menu = page.locator('.demo-menu');
    await cache.waitFor();
    await showUnread(page);
    await cache.click();
    const heading = page.locator('#list .turn h3.cardheading button.head').first();
    await heading.waitFor();
    await expect.poll(cacheUnread).toBe(false);
    await expect.poll(() => heading.getAttribute('title')).not.toContain('unread');
    expect(await unreadFilter.count()).toBe(0);
    await heading.click({ button: 'right' });
    await menu.getByRole('menuitem', { name: 'Mark as unread' }).click();
    await expect.poll(cacheUnread).toBe(true);
    expect(await unreadFilter.count()).toBe(1);
    await heading.click({ button: 'right' });
    await menu.getByRole('menuitem', { name: 'Mark as read' }).click();
    await expect.poll(cacheUnread).toBe(false);
    expect(await unreadFilter.count()).toBe(0);
    await cache.click({ button: 'right' });
    await menu.getByRole('menuitem', { name: 'Mark as unread' }).click();
    await expect.poll(cacheUnread).toBe(true);
  });

  it('opens a subagent session parent from the selected session heading', async (t) => {
    if (!browser) t.skip('Edge or Chrome is required');
    const pages = [];
    for (const width of [1280, 390]) {
      const page = await browser!.newPage();
      await page.setViewportSize({ width, height: 850 });
      await page.goto(`${base}/`);
      const picker = page.locator('[data-control="picker"]');
      await picker.waitFor({ state: 'attached' });
      expect(await page.locator('[data-control="sessionparent:arc-read-state"]').count()).toBe(0);
      if (width === 1280) {
        await page.locator('[data-control="railruns"]').click();
        await page.locator('[data-control="rail:arc-sol-read-state"]').first().click();
      } else await picker.selectOption('arc-sol-read-state');
      await page.locator('[data-control="session:arc-sol-read-state"]').waitFor();
      pages.push(page);
    }
    for (const page of pages) {
      const parent = page.locator('[data-control="sessionparent:arc-read-state"]');
      expect(await parent.count()).toBe(1);
      expect(await parent.getAttribute('aria-label')).toContain('Keep unread results visible');
      await parent.click();
      await page.waitForFunction(
        () => document.querySelector<HTMLSelectElement>('[data-control="picker"]')?.value === 'arc-read-state',
      );
      expect(await parent.count()).toBe(0);
      await page.close();
    }
  }, 60_000);

  it('opens the session and response menus, copies a response, and keeps Send in the page', async (t) => {
    if (!browser) t.skip('Edge or Chrome is required');
    const page = await browser!.newPage();
    page.setDefaultTimeout(5_000);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width: 1280, height: 850 });
    const requests: string[] = [];
    const ignored: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    page.on('console', (message) => {
      if (message.text().includes('ignored a panel action')) ignored.push(message.text());
    });
    await page.goto(`${base}/`);
    await page.locator('#list .sessionrow .session').first().waitFor();
    const loaded = requests.length;
    const menu = page.locator('.demo-menu');
    // The Windows clipboard stores line breaks as CRLF.
    const clipboard = () => page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, '\n'));

    await page.locator('#list .sessionrow .session').first().click({ button: 'right' });
    expect(await menu.getByRole('menuitem').allTextContents()).toContain('Edit labels…');
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached' });
    // Shift+F10 on a focused heading opens the menu with its first entry focused. The arrows move
    // through the entries, and Escape closes the menu and returns focus to the heading.
    const focused = () => page.evaluate(() => document.activeElement?.textContent ?? '');
    await page.locator('#list .sessionrow .session').first().focus();
    await page.keyboard.press('Shift+F10');
    await menu.waitFor();
    const titles = await menu.getByRole('menuitem').allTextContents();
    expect(await focused()).toBe(titles[0]);
    await page.keyboard.press('ArrowDown');
    expect(await focused()).toBe(titles[1]);
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached' });
    expect(await page.evaluate(() => document.activeElement?.matches('#list .sessionrow .session'))).toBe(true);
    await page.locator('[data-control="sessionmenu:arc-read-state"]').click();
    await menu.getByRole('menuitem', { name: 'Copy session ID' }).click();
    await expect.poll(clipboard).toBe('arc-read-state');
    await page.locator('[data-control="sessionmenu:arc-read-state"]').click();
    await menu.getByRole('menuitem', { name: 'Show session details' }).click();
    const details = page.locator('#sessiondetails');
    await details.waitFor();
    await details.getByRole('button', { name: 'Copy command' }).click();
    const command = await details.locator('dd').nth(3).locator('.sessiondetailsvalue').textContent();
    expect(command).toContain('arc-read-state');
    await expect.poll(clipboard).toBe(command);
    await details.getByRole('button', { name: 'Copy ID' }).click();
    await expect.poll(clipboard).toBe('arc-read-state');
    await page.keyboard.press('Escape');
    await details.waitFor({ state: 'hidden' });

    const heading = page.locator('#list .turn h3.cardheading button.head').first();
    if ((await heading.getAttribute('aria-expanded')) === 'false') await heading.click();
    const response = page.locator('#list .turn .summary p').first();
    await response.click({ button: 'right' });
    await menu.getByRole('menuitem', { name: 'Copy the summary' }).click();
    const summary = await page.evaluate(
      () =>
        (window as unknown as { __ARC_DEMO_SAMPLES__: { payloads: Record<string, { cards: { summary?: string }[] }> } })
          .__ARC_DEMO_SAMPLES__.payloads['arc-read-state'].cards[0].summary,
    );
    expect(summary).toContain('Finished sessions stay unread');
    await expect.poll(clipboard).toBe(summary);

    await response.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await response.click({ button: 'right' });
    await menu.getByRole('menuitem', { name: 'Send to a new session with the same labels' }).click();
    expect(await page.locator('#demo-notice').count()).toBe(0);
    expect(await page.locator('#list .sessionrow').count()).toBe(1);
    expect(ignored).toEqual([]);
    expect(requests.length).toBe(loaded);
  });

  it('edits a view through its three-dot menu and keeps the edit across sessions', async (t) => {
    if (!browser) t.skip('Edge or Chrome is required');
    const page = await browser!.newPage();
    page.setDefaultTimeout(5_000);
    await page.setViewportSize({ width: 1280, height: 850 });
    await page.goto(`${base}/`);
    await page.locator('[data-control="viewmenu:review"]').click();
    await page.locator('.demo-menu').getByRole('menuitem', { name: 'Edit view', exact: false }).click();
    await page.locator('[data-control="view-name"]').fill('Navigation work');
    await page.locator('[data-control="view-order"]').selectOption('cost-desc');
    await page.locator('[data-control="view-save"]').click();
    await page.locator('[data-control="rail:arc-demo-review"]').first().click();
    await page.locator('[data-control="viewmenu:review"]').click();
    await page.locator('.demo-menu').getByRole('menuitem', { name: 'Edit view', exact: false }).click();
    expect(await page.locator('[data-control="view-name"]').inputValue()).toBe('Navigation work');
    expect(await page.locator('[data-control="view-order"]').inputValue()).toBe('cost-desc');
    await page.close();
  });

  it('opens the test maker and exposes Next turn while keeping prompt actions silent', async (t) => {
    if (!browser) t.skip('Edge or Chrome is required');
    for (const width of [1280, 390]) {
      const page = await browser!.newPage();
      page.setDefaultTimeout(5_000);
      await page.setViewportSize({ width, height: 850 });
      const requests: string[] = [];
      page.on('request', (request) => requests.push(request.url()));
      await page.goto(`${base}/`);
      await page.locator('.commitmakerlink[data-control$=":arc-luna-read-state-tests"]').click();
      await page.locator('[data-control="session:arc-luna-read-state-tests"]').waitFor();
      await page.locator('[data-control="sessionparent:arc-read-state"]').click();
      const picker = page.locator('[data-control="picker"]');
      if (width === 1280) await page.locator('[data-control="rail:arc-demo-continuation"]').first().click();
      else await picker.selectOption('arc-demo-continuation');
      const next = page.locator('.cnextturnface:not(.is-off) .cnextturnprice');
      await next.click();
      await page.locator('#chippop.pinned').waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
      const loaded = requests.length;
      await page.locator('#prompt').fill('Keep this as a local draft');
      await page.locator('#prompt').press('Control+Enter');
      expect(await picker.inputValue()).toBe('arc-demo-continuation');
      expect(await page.locator('#demo-notice').count()).toBe(0);
      expect(requests.length).toBe(loaded);
      await page.close();
    }
  });

  it('navigates dispatched and reader-started sessions at desktop and narrow widths, including Compact and archived parents', async (t) => {
    if (!browser) t.skip('Edge or Chrome is required');
    for (const width of [1280, 390]) {
      const page = await browser!.newPage();
      page.setDefaultTimeout(5_000);
      await page.setViewportSize({ width, height: 850 });
      await page.goto(`${base}/`);
      const picker = page.locator('[data-control="picker"]');
      await picker.waitFor({ state: 'attached' });
      if (width === 1280) {
        await page.locator('[data-control="railarchived"]').click();
        await page.locator('[data-control="rail:arc-demo-dispatch"]').first().click();
      } else await picker.selectOption('arc-demo-dispatch');
      const heading = page.locator('#list .turn h3.cardheading button.head').first();
      if ((await heading.getAttribute('aria-expanded')) === 'false') await heading.click();
      const child = page.locator('#list .cardrecord [data-control$=":arc-demo-review"]');
      await child.waitFor();
      if (process.env.ARC_DEMO_SHOTS) {
        fs.mkdirSync(process.env.ARC_DEMO_SHOTS, { recursive: true });
        await page.screenshot({
          path: path.join(process.env.ARC_DEMO_SHOTS, `dispatch-parent-${width}.png`),
          fullPage: true,
        });
      }
      await child.click();
      await page.locator('[data-control="session:arc-demo-review"]').waitFor();
      const reviewHeading = page.locator('#list .turn h3.cardheading button.head').first();
      if ((await reviewHeading.getAttribute('aria-expanded')) === 'false') await reviewHeading.click();
      if (process.env.ARC_DEMO_SHOTS) {
        await page.screenshot({
          path: path.join(process.env.ARC_DEMO_SHOTS, `dispatch-review-${width}.png`),
          fullPage: true,
        });
      }
      const parent = page.locator('[data-control="sessionparent:arc-demo-dispatch"]');
      expect(await parent.getAttribute('aria-label')).toContain('Review the web demo');
      await parent.click();
      await page.locator('[data-control="session:arc-demo-dispatch"]').waitFor();
      await page.locator('[data-control="sessionlayout:arc-demo-dispatch"]').click();
      await page.locator('[data-control="layout:cardLayout:compact"]').click();
      await page.keyboard.press('Escape');
      await page.locator('#list .turn [data-metric="dispatched"]').click();
      await page.locator('#chippop [data-control$=":arc-demo-review"]').click();
      await page.locator('[data-control="session:arc-demo-review"]').waitFor();
      await parent.click();
      await page.locator('[data-control="session:arc-demo-dispatch"]').waitFor();
      await page.locator('[data-control="sessionmenu:arc-demo-dispatch"]').click();
      const archiveAction = page.locator('.demo-menu').getByRole('menuitem', { name: 'Archive', exact: true });
      if (await archiveAction.count()) await archiveAction.click();
      else await page.keyboard.press('Escape');
      if (width === 1280) await page.locator('[data-control="rail:arc-demo-continuation"]').first().click();
      else await picker.selectOption('arc-demo-continuation');
      await page.locator('[data-control="session:arc-demo-continuation"]').waitFor();
      const continuationHeading = page.locator('#list .turn h3.cardheading button.head').first();
      if ((await continuationHeading.getAttribute('aria-expanded')) === 'false') await continuationHeading.click();
      if (process.env.ARC_DEMO_SHOTS) {
        await page.screenshot({
          path: path.join(process.env.ARC_DEMO_SHOTS, `reader-continuation-${width}.png`),
          fullPage: true,
        });
      }
      expect(await parent.getAttribute('aria-label')).toContain('Review the web demo');
      await parent.click();
      await page.locator('[data-control="session:arc-demo-dispatch"]').waitFor();
      await page.locator('[data-control="sessionmenu:arc-demo-dispatch"]').click();
      expect(await page.locator('.demo-menu').getByRole('menuitem', { name: 'Unarchive', exact: true }).count()).toBe(
        1,
      );
      await page.keyboard.press('Escape');
      await page.close();
    }
  }, 60_000);

  it('keeps matching initial labels independent and rejects unknown parents and usage refresh without requests', async (t) => {
    if (!browser) t.skip('Edge or Chrome is required');
    const page = await browser!.newPage();
    page.setDefaultTimeout(5_000);
    await page.setViewportSize({ width: 1280, height: 850 });
    const requests: string[] = [];
    const ignored: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    page.on('console', (message) => {
      if (message.text().includes('ignored a panel action')) ignored.push(message.text());
    });
    await page.goto(`${base}/`);
    const picker = page.locator('[data-control="picker"]');
    await picker.waitFor({ state: 'attached' });
    const loaded = requests.length;
    await page.locator('[data-control="rail:arc-demo-continuation"]').first().click();
    await page.locator('[data-control="sessionlabels:arc-demo-continuation"]').click();
    await page.locator('#labelpop [data-control="label-find"]').fill('follow-up');
    await page.locator('#labelpop [data-control="label-create"]').click();
    await page.locator('.sessionlabels .sessionlabel[data-label="follow-up"]').waitFor();
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const api = (
        window as unknown as { acquireVsCodeApi(): { postMessage(message: unknown): void } }
      ).acquireVsCodeApi();
      api.postMessage({ type: 'showReaderParent', session: 'unknown-parent' });
      api.postMessage({ type: 'showSession', session: 'unknown-parent' });
    });
    expect(await picker.inputValue()).toBe('arc-demo-continuation');
    await page.locator('[data-control="sessionparent:arc-demo-dispatch"]').click();
    await page.locator('[data-control="session:arc-demo-dispatch"]').waitFor();
    expect(await page.locator('.sessionlabels .sessionlabel').allTextContents()).toEqual(['demo']);
    await page.locator('[data-control="usage"]').click();
    await page.locator('[data-control="usage:read"]').click();
    expect(await page.locator('#demo-notice').count()).toBe(0);
    expect(ignored).toEqual([]);
    expect(requests.length).toBe(loaded);
    expect(requests.every((url) => url.startsWith(base + '/'))).toBe(true);
    await page.close();
  });
});
