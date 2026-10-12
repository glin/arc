import { test, vi } from 'vitest';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { readCodexContext } from '../codexcontext.ts';
import { readCodexSession } from '../codex.ts';
import { revisionOf } from '../transcript.ts';
import { composerRuntimeBySession } from '../turncard.ts';
import { codexContextRecords } from '../turnfixtures.ts';
import { tempDir } from '../temproot.ts';
import * as vscode from 'vscode';
import type { Locator, Page } from 'playwright-core';
import { browserOrNone, SETTLED } from '../../test/browser.ts';
import { COMPOSER, LIVE_PRESS, pageHtml, renderPayload, statPopoverPayload, themed } from '../panelfixture.ts';
import { composerView, pickMenu, newSessionDraft, type ComposerState } from '../composerview.ts';
import type { SessionLauncherView } from '../view/launcher.ts';
import { SUBMITTED_PROMPT_CHARS } from './state.ts';
import { usageBar } from '../usageview.ts';

test(
  'usage progress replaces the refresh action with status, retains focus nearby, and announces one shared outcome',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no browser installed');
      return;
    }
    try {
      const page = await browser.newPage();
      await page.clock.install();
      await page.setContent(themed(pageHtml()));
      const payload = renderPayload();
      await post(page, payload);
      await page.locator('[data-control="usage"]').focus();
      await page.keyboard.press('Enter');
      const read = page.locator('[data-control="usage:read"]');
      for (const group of (payload.usage as { bar: NonNullable<ReturnType<typeof usageBar>> }).bar.groups) {
        assert.ok((await page.locator('#usagepop').ariaSnapshot()).includes(group.exact));
      }
      await page.keyboard.press('Tab');
      assert.equal(await read.evaluate((node) => node === document.activeElement), true);
      await page.evaluate(() => {
        const root = window as unknown as { usageAnnouncements: string[] };
        root.usageAnnouncements = [];
        const announcer = document.querySelector('#ask-announcer');
        if (!announcer) throw new Error('Missing shared announcer');
        new MutationObserver(() => {
          if (announcer.textContent) root.usageAnnouncements.push(announcer.textContent);
        }).observe(announcer, { childList: true });
      });
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate('window.__posted.filter(m => m.type === "refreshUsage").length'), 1);
      const refresh: import('../view/usage').UsageRefresh = {
        id: 1,
        agents: { claude: { phase: 'waiting', detail: '' }, codex: { phase: 'reading', detail: '' } },
      };
      const reading = Date.now();
      const readings = [
        {
          agent: 'claude',
          plan: 'max',
          windows: [
            {
              window: 'five_hour',
              group: 'session',
              scope: '',
              utilization: 0.1,
              status: '',
              resetsAtSeconds: null,
              readAt: reading,
            },
          ],
          spend: null,
          checkedAt: reading,
          creditResetsAtSeconds: null,
        },
      ];
      const send = () =>
        post(page, {
          type: 'usage',
          usage: { ...(payload.usage as object), bar: usageBar(readings, Date.now(), refresh) },
        });
      await send();
      const progress = page.locator('#usagepop [role="status"]');
      assert.equal(await read.count(), 0);
      assert.equal(await page.locator('#usagepop button').count(), 0);
      assert.equal(await progress.evaluate((node: HTMLElement) => node.tabIndex), -1);
      assert.equal(await progress.getAttribute('data-control'), null);
      assert.ok((await progress.getAttribute('aria-label'))!.includes((await progress.textContent())!));
      assert.match((await progress.getAttribute('aria-label'))!, /Claude.*Codex/);
      assert.equal(await page.evaluate('document.activeElement.id'), 'usagepop');
      await progress.click();
      await page.keyboard.press('Space');
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate('window.__posted.filter(m => m.type === "refreshUsage").length'), 1);
      refresh.agents.codex = { phase: 'success', detail: '' };
      await send();
      assert.equal(await read.count(), 0);
      assert.equal(await progress.count(), 1);
      assert.equal(await page.evaluate('window.usageAnnouncements.length'), 0);
      refresh.agents.claude = { phase: 'failed', detail: 'Usage reading timed out. Read again to retry.' };
      await send();
      await page.clock.runFor(0);
      await page.waitForFunction('window.usageAnnouncements.length === 1');
      assert.ok((await read.getAttribute('aria-label'))!.includes((await read.textContent())!));
      assert.equal(await progress.count(), 0);
      assert.equal(await read.evaluate((node) => node.tagName), 'BUTTON');
      assert.equal(await page.evaluate('document.activeElement.id'), 'usagepop');
      await send();
      assert.equal(await page.evaluate('window.usageAnnouncements.length'), 1);
      await page.mouse.move(0, 0);
      await page.keyboard.press('Tab');
      assert.equal(await read.evaluate((node) => node === document.activeElement), true);
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate('window.__posted.filter(m => m.type === "refreshUsage").length'), 2);
      refresh.id = 2;
      refresh.agents.claude = { phase: 'reading', detail: '' };
      await send();
      assert.equal(await page.evaluate('document.activeElement.id'), 'usagepop');
      await page.locator('#list').click({ position: { x: 2, y: 150 } });
      assert.equal(await page.evaluate('document.activeElement.tagName'), 'BODY');
      await page.locator('#usagepop').waitFor({ state: 'hidden' });
    } finally {
      await browser.close();
    }
  },
);

test(
  'a recreated usage renderer suppresses historical completion and announces a newly observed attempt once',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no browser installed');
      return;
    }
    try {
      const page = await browser.newPage();
      await page.clock.install();
      await page.setContent(themed(pageHtml()));
      const payload = renderPayload();
      const refresh: import('../view/usage').UsageRefresh = {
        id: 4,
        agents: { claude: { phase: 'failed', detail: '' }, codex: { phase: 'success', detail: '' } },
      };
      await page.evaluate(() => {
        const root = window as unknown as { usageAnnouncements: string[] };
        root.usageAnnouncements = [];
        const announcer = document.querySelector('#ask-announcer')!;
        new MutationObserver(() => {
          if (announcer.textContent) root.usageAnnouncements.push(announcer.textContent);
        }).observe(announcer, { childList: true });
      });
      (payload.usage as { bar: ReturnType<typeof usageBar> }).bar = usageBar([], Date.now(), refresh);
      await post(page, payload);
      await page.clock.runFor(0);
      assert.equal(await page.evaluate('window.usageAnnouncements.length'), 0);
      refresh.id = 5;
      refresh.agents.claude = { phase: 'reading', detail: '' };
      await post(page, {
        type: 'usage',
        usage: { ...(payload.usage as object), bar: usageBar([], Date.now(), refresh) },
      });
      refresh.agents.claude = { phase: 'success', detail: '' };
      const completed = {
        type: 'usage',
        usage: { ...(payload.usage as object), bar: usageBar([], Date.now(), refresh) },
      };
      await post(page, completed);
      await page.clock.runFor(0);
      await page.waitForFunction('window.usageAnnouncements.length === 1');
      await post(page, completed);
      assert.equal(await page.evaluate('window.usageAnnouncements.length'), 1);
    } finally {
      await browser.close();
    }
  },
);

async function post(page: Page, message: unknown): Promise<void> {
  await page.evaluate(`window.postMessage(${JSON.stringify(message)}, '*')`);
  await page.evaluate(SETTLED);
}

test(
  'a saved Codex session reaches the Context popover through the production source factory and host demand',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no browser installed');
      return;
    }
    try {
      vi.stubGlobal('PANEL_CSS', '');
      vi.stubGlobal('PANEL_JS', '');
      vi.stubGlobal('PANEL_DEV_SERVER_URL', null);
      const { PanelProvider } = await import('../panelhost.ts');
      const directory = tempDir('codex-context-browser');
      const file = path.join(directory, 'rollout.jsonl');
      const page = await browser.newPage();
      await page.setContent(themed(pageHtml()));
      const provider = Object.create(PanelProvider.prototype) as Record<string, any>;
      const host = {};
      const state = {
        agent: 'codex',
        context: null as { used: number; max: number } | null,
        settings: { selectedModel: 'gpt-6.1-sol', confirmedModel: 'gpt-6.1-sol' },
      };
      Object.assign(provider, {
        showing: 's1',
        hostSessions: new Map([[host, 's1']]),
        contextGenerations: new Map(),
        contextDemands: new WeakMap(),
        contextRequests: new WeakMap(),
        catalog: { sessions: [{ sessionId: 's1', agent: 'codex', file }] },
        stateFor: (session: string) => (session === 's1' ? state : null),
        sendToHost: (_host: unknown, message: unknown) => post(page, message),
        progressiveWorker: {
          run: async (request: any, generation: number, signal: AbortSignal) => {
            const revision = revisionOf(fs.statSync(file, { bigint: true }));
            return {
              generation,
              revision,
              value: {
                kind: 'codex-context',
                estimate: await readCodexContext(request.session.file, request.session.sessionId, revision, signal),
              },
            };
          },
        },
      });
      const source = fs.readFileSync(path.join(__dirname, '..', 'extension.ts'), 'utf8');
      const from = source.indexOf('panel.contextSource = ');
      const through = source.indexOf('panel.onSendPrompt = ', from);
      assert.ok(from >= 0 && through > from);
      runInNewContext(source.slice(from, through), {
        panel: provider,
        host: {
          find() {
            throw new Error('Inspecting saved context must not attach an agent');
          },
        },
      });
      for (const mode of ['ordinary', 'compacted-request', 'compacted-estimate']) {
        const records = codexContextRecords('s1', mode !== 'ordinary');
        if (mode === 'compacted-estimate')
          records.at(-1)!.payload.info.last_token_usage = { input_tokens: 0, output_tokens: 0, total_tokens: 10_100 };
        fs.writeFileSync(file, records.map((row) => JSON.stringify(row)).join('\n') + '\n');
        provider.invalidateContext('s1');
        const saved = readCodexSession(file, 's1');
        const runtime = composerRuntimeBySession(saved.turns, new Map(saved.compactions.map((row) => ['s1', row]))).get(
          's1',
        );
        assert.ok(runtime?.context, `${mode} lost the Context anchor`);
        state.context = { used: runtime.context.tokens, max: runtime.context.window! };
        const payload = renderPayload();
        (payload.usage as { composer: any }).composer = composerView({
          ...COMPOSER,
          agent: 'codex',
          context: state.context,
          contextGeneration: provider.contextGenerations.get('s1'),
        });
        await post(page, payload);
        await page.locator('#prompt').focus();
        await page.locator('.cctx').focus();
        const request = await page.evaluate<any>('window.__posted.filter(m => m.type === "contextDetail").at(-1)');
        await provider.requestContext(host, 's1', request.request, request.generation);
        const detail = page.locator('#composer-context-detail');
        assert.equal(
          await detail.locator('.context-categories li').count(),
          mode === 'ordinary' ? 4 : 5,
          'Codex categories fell into the unavailable branch',
        );
        const spoken = await detail.ariaSnapshot();
        for (const label of ['Messages', 'Instructions', 'Tool calls', 'Unattributed context'])
          assert.ok(spoken.includes(label), label);
        const notes = detail.locator('.context-measurement .context-notes');
        assert.equal(await detail.locator('details.context-measurement').count(), 1);
        assert.equal(await notes.isHidden(), true, 'measurement explanations start expanded');
        assert.ok(!spoken.includes('Local estimate'), 'collapsed explanations remain in the accessible tree');
        await page.keyboard.press('Tab');
        const summary = detail.locator('.context-measurement summary');
        assert.equal(await summary.evaluate((node) => node === document.activeElement), true);
        await page.keyboard.press('Enter');
        await notes.waitFor({ state: 'visible' });
        const expanded = await detail.ariaSnapshot();
        for (const label of ['Local estimate', 'text size in bytes by four'])
          assert.ok(expanded.includes(label), label);
        assert.equal(await page.evaluate('window.__posted.filter(m => m.type === "compact").length'), 0);
        await page.keyboard.press('Tab');
        assert.equal(
          await detail
            .getByRole('button', { name: 'Compact this session' })
            .evaluate((node) => node === document.activeElement),
          true,
        );
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Space');
        await notes.waitFor({ state: 'hidden' });
        assert.equal(await detail.locator('.context-categories li').count(), mode === 'ordinary' ? 4 : 5);
        assert.equal(await detail.locator('.context-remaining').isVisible(), true);
        await page.keyboard.press('Escape');
      }
      const activeRecords = codexContextRecords();
      const previous = structuredClone(activeRecords.at(-1)!);
      activeRecords.push({
        type: 'response_item',
        payload: { type: 'function_call', call_id: 'pending', name: 'read', arguments: '{}' },
      });
      const activePayload = renderPayload();
      const publish = async (invalidate = true) => {
        fs.writeFileSync(file, activeRecords.map((row) => JSON.stringify(row)).join('\n') + '\n');
        if (invalidate) provider.invalidateContext('s1');
        (activePayload.usage as { composer: any }).composer = composerView({
          ...COMPOSER,
          agent: 'codex',
          context: state.context,
          contextGeneration: provider.contextGenerations.get('s1'),
        });
        await post(page, activePayload);
      };
      await publish();
      await page.locator('#prompt').focus();
      await page.locator('.cctx').focus();
      const activeDetail = page.locator('#composer-context-detail');
      const compact = activeDetail.getByRole('button', { name: 'Compact this session' });
      await compact.focus();
      const answer = async () => {
        const request = await page.evaluate<any>('window.__posted.filter(m => m.type === "contextDetail").at(-1)');
        assert.equal(request.generation, provider.contextGenerations.get('s1'));
        await provider.requestContext(host, 's1', request.request, request.generation);
        assert.equal(await activeDetail.isVisible(), true, 'active same-session detail closed');
        assert.equal(
          await compact.evaluate((node) => node === document.activeElement),
          true,
          'active reply lost Compact focus',
        );
      };
      await answer();
      assert.equal(await activeDetail.locator('.context-categories li').count(), 0);
      activeRecords.push(
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'pending', output: 'result' } },
        previous,
      );
      await publish();
      await answer();
      assert.equal(await activeDetail.locator('.context-categories li').count(), 0);
      const next = structuredClone(previous);
      next.payload.info.last_token_usage.input_tokens += 50;
      activeRecords.push(next);
      state.context = { used: 10_050, max: 20_000 };
      await publish(false);
      await answer();
      await page.waitForFunction(
        () => document.querySelectorAll('#composer-context-detail .context-categories li').length === 4,
      );
      assert.equal(await compact.evaluate((node) => node === document.activeElement), true);
      await compact.click();
      assert.equal(await page.evaluate('window.__posted.filter(m => m.type === "compact").length'), 1);
    } finally {
      await browser.close();
    }
  },
);

test(
  'context inspection pins without compaction and keeps Compact reachable by pointer and keyboard',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no browser installed');
      return;
    }
    try {
      const page = await browser.newPage();
      await page.clock.install();
      await page.setContent(themed(pageHtml()));
      await post(page, renderPayload());
      const anchor = page.locator('.cctx');
      const detail = page.locator('#composer-context-detail');
      await anchor.hover();
      await page.waitForFunction(() => !document.querySelector<HTMLElement>('#composer-context-detail')?.hidden);
      await page.clock.fastForward(500);
      assert.equal(await page.locator('#hintpop').isHidden(), true, 'context hover opened a second popover');
      assert.equal(await anchor.getAttribute('title'), null, 'context hover retained a native tooltip');
      await detail.locator('button').hover();
      await page.evaluate(SETTLED);
      assert.equal(await detail.isVisible(), true);
      await detail.locator('button').focus();
      assert.equal(await detail.locator('button').evaluate((node) => node.matches(':hover')), true);
      await page.locator('#prompt').focus();
      assert.equal(await detail.isVisible(), true, 'focus departure hid the hovered Compact preview');
      await detail.locator('button').click();
      assert.equal(await page.evaluate('window.__posted.filter(m => m.type === "compact").length'), 1);
      await page.locator('#prompt').focus();
      await anchor.focus();
      assert.equal(await detail.isVisible(), true);
      assert.equal(await page.locator('#hintpop').isHidden(), true, 'context focus opened a second popover');
      await page.keyboard.press('Tab');
      assert.equal(await detail.locator('button').evaluate((node) => node === document.activeElement), true);
      await page.locator('#prompt').hover();
      await page.clock.fastForward(1000);
      assert.equal(await detail.isVisible(), true, 'pointer departure hid focused Compact');
      await page.keyboard.press('Shift+Tab');
      assert.equal(await anchor.evaluate((node) => node === document.activeElement), true);
      await page.keyboard.press('Tab');
      const request = await page.evaluate<{ request: number; generation: number }>(
        'window.__posted.filter(m => m.type === "contextDetail").at(-1)',
      );
      const measured = {
        session: 's1',
        ...request,
        provider: 'claude',
        model: 'opus',
        source: 'fixture',
        status: 'available',
        capturedAt: 1,
        measurement: 'provider-estimate',
        used: 100_000,
        capacity: 200_000,
        remaining: 66_868,
        reserve: 33_132,
        categories: [
          { key: 'Messages', name: 'Messages', tokens: 80_000, relationship: 'used' },
          { key: 'Tools', name: 'Tools', tokens: 10_000, relationship: 'used' },
          { key: 'Skills', name: 'Skills', tokens: 5_000, relationship: 'used' },
          { key: 'Memory', name: 'Memory', tokens: 3_000, relationship: 'used' },
          { key: 'System', name: 'System', tokens: 1_000, relationship: 'used' },
          { key: 'MCP', name: 'MCP', tokens: 1_000, relationship: 'used' },
        ],
      };
      await post(page, { type: 'contextDetail', detail: measured });
      assert.equal(await detail.locator('button').evaluate((node) => node === document.activeElement), true);
      const categories = detail.locator('.context-categories');
      assert.equal(await categories.getByRole('listitem').count(), 6);
      for (const [index, row] of measured.categories.entries()) {
        const spoken = await categories.getByRole('listitem').nth(index).ariaSnapshot();
        assert.ok(spoken.includes(row.name), 'category name is absent from its accessible row');
        assert.ok(
          spoken.includes(`${((row.tokens / measured.used) * 100).toFixed(1)}%`),
          'category percentage is absent from its accessible row',
        );
        assert.ok(spoken.includes('of used context'), 'category denominator is absent from its accessible row');
        assert.ok(
          spoken.includes(`${row.tokens.toLocaleString('en-US')} tokens`),
          'reported count is absent from its accessible row',
        );
        assert.equal(
          await categories.getByRole('listitem').nth(index).locator('.context-share').getAttribute('title'),
          `${row.tokens.toLocaleString('en-US')} tokens`,
        );
      }
      const header = await detail.locator('.chippophead').ariaSnapshot();
      for (const count of ['100,000', '200,000'])
        assert.ok(header.includes(count), 'reported used or capacity count is absent from the accessible header');
      assert.ok(
        (await detail.locator('.context-remaining').ariaSnapshot()).includes('66,868 tokens'),
        'native Remaining count is absent from accessible text',
      );
      assert.ok(
        (await detail.locator('.context-notes').last().ariaSnapshot()).includes('33,132 tokens'),
        'native reserve count is absent from accessible text',
      );
      assert.deepEqual(
        await categories
          .locator('.context-meter')
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-hidden'))),
        Array(6).fill('true'),
        'decorative meters are exposed to screen readers',
      );
      const statePayload = renderPayload();
      const stateContext = (statePayload.usage as { composer: { context: { generation: number } } }).composer.context;
      for (const state of ['mismatch', 'zero-mismatch', 'zero', 'missing-remaining', 'available']) {
        stateContext.generation++;
        await post(page, statePayload);
        const stateRequest = await page.evaluate<{ request: number; generation: number }>(
          'window.__posted.filter(m => m.type === "contextDetail").at(-1)',
        );
        const stateDetail = {
          ...measured,
          ...(state === 'mismatch' ? { status: 'mismatch', used: 110_000, remaining: 56_868 } : {}),
          ...(state === 'zero-mismatch' ? { status: 'mismatch', used: 0, remaining: 200_000, reserve: 0 } : {}),
          ...(state === 'zero' ? { used: 0, remaining: 200_000, reserve: 0, categories: [] } : {}),
          ...(state === 'missing-remaining' ? { remaining: null } : {}),
          ...stateRequest,
        };
        await post(page, { type: 'contextDetail', detail: stateDetail });
        if (state === 'mismatch') {
          assert.equal(await detail.locator('.context-meter').count(), 0, 'mismatched totals draw meters');
          const mismatch = await detail.locator('tbody tr').first().ariaSnapshot();
          for (const text of ['Messages', '72.7%', 'of used context', '80,000 tokens'])
            assert.ok(mismatch.includes(text), 'mismatch row omits its reported count or percentage semantics');
          assert.equal(await detail.locator('tbody tr td').first().getAttribute('title'), '80,000 tokens');
        } else if (state === 'zero-mismatch') {
          assert.equal(await detail.locator('.context-meter').count(), 0, 'zero used context draws meters');
          const mismatch = await detail.locator('tbody tr').first().ariaSnapshot();
          assert.ok(mismatch.includes('Unavailable'), 'zero total produces a category percentage');
          assert.ok(!mismatch.includes('of used context'), 'unavailable share announces a denominator');
          assert.ok(mismatch.includes('80,000 tokens'), 'zero-total mismatch loses its reported category count');
          assert.equal(await detail.locator('tbody tr td').first().getAttribute('title'), '80,000 tokens');
        } else if (state === 'zero') {
          assert.equal(await detail.locator('.context-meter').count(), 0);
          assert.ok((await detail.ariaSnapshot()).includes('No context used.'));
          assert.ok(
            (await detail.locator('.context-notes').ariaSnapshot()).includes('0 tokens reserved for compaction'),
            'recorded zero reserve disappears',
          );
        } else if (state === 'missing-remaining') {
          assert.equal(
            await detail.locator('.context-remaining .chippopvalue').textContent(),
            'Unavailable',
            'missing native Remaining becomes an inferred count',
          );
        }
      }
      stateContext.generation++;
      await post(page, statePayload);
      const priorRequest = await page.evaluate<{ request: number; generation: number }>(
        'window.__posted.filter(m => m.type === "contextDetail").at(-1)',
      );
      await post(page, {
        type: 'contextDetail',
        detail: {
          ...measured,
          ...priorRequest,
          provider: 'codex',
          measurement: 'local-estimate',
          basis: 'request',
          reserve: null,
        },
      });
      const measurement = detail.locator('.context-measurement');
      const summary = measurement.locator('summary');
      await summary.focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        () => document.querySelector<HTMLDetailsElement>('#composer-context-detail .context-measurement')?.open,
      );
      await detail.locator('.context-bound button').click({ trial: true, timeout: 5_000 });
      await summary.focus();
      const refreshed = statePayload;
      const composer = (refreshed.usage as { composer: { context: { used: number; generation: number } } }).composer;
      composer.context.used += 1;
      composer.context.generation += 1;
      await post(page, refreshed);
      assert.equal(await detail.isVisible(), true, 'same-session refresh closed detail');
      assert.equal(
        await detail.locator('button').evaluate((node) => node === document.activeElement),
        true,
        'same-session loading lost focus when the measurement summary disappeared',
      );
      const refreshRequest = await page.evaluate<{ request: number; generation: number }>(
        'window.__posted.filter(m => m.type === "contextDetail").at(-1)',
      );
      assert.equal(refreshRequest.generation, composer.context.generation);
      await post(page, {
        type: 'contextDetail',
        detail: {
          ...measured,
          ...refreshRequest,
          provider: 'codex',
          measurement: 'local-estimate',
          basis: 'request',
          reserve: null,
        },
      });
      assert.equal(
        await measurement.evaluate((node) => (node as HTMLDetailsElement).open),
        true,
        'same-session reply collapsed measurement details',
      );
      assert.equal(
        await detail.locator('.context-bound button').evaluate((node) => node === document.activeElement),
        true,
        'same-session reply lost the surviving Compact focus',
      );
      await summary.focus();
      await page.keyboard.press('Space');
      await page.waitForFunction(
        () => !document.querySelector<HTMLDetailsElement>('#composer-context-detail .context-measurement')?.open,
      );
      await detail.locator('.context-bound button').focus();
      composer.context.generation += 1;
      await post(page, refreshed);
      await page.evaluate(() => {
        const text = document.querySelector('#composer-context-detail > .context-notes .context-note')!;
        const range = document.createRange();
        range.selectNodeContents(text);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
      });
      const selected = await page.evaluate(() => getSelection()!.toString());
      composer.context.used += 1;
      composer.context.generation += 1;
      await post(page, refreshed);
      assert.equal(await detail.isVisible(), true, 'same-session refresh hid selected detail');
      assert.equal(
        await page.evaluate(() => getSelection()!.toString()),
        selected,
        'same-session refresh replaced selected text',
      );
      await page.evaluate(() => {
        getSelection()!.removeAllRanges();
        document.dispatchEvent(new Event('selectionchange'));
      });
      await page.keyboard.press('Escape');
      assert.equal(await detail.isHidden(), true);
      assert.equal(await anchor.evaluate((node) => node === document.activeElement), true);
      await page.keyboard.press('Tab');
      assert.equal(await detail.isHidden(), true);
      await anchor.hover();
      await detail.locator('button').hover();
      await page.locator('#prompt').click();
      assert.equal(await detail.isHidden(), true);
      for (const activate of [
        () => anchor.click(),
        () => page.keyboard.press('Enter'),
        () => page.keyboard.press('Space'),
      ]) {
        await anchor.focus();
        await activate();
        assert.equal(await detail.isVisible(), true);
        assert.equal(await anchor.getAttribute('aria-expanded'), 'true');
        await page.locator('#prompt').hover();
        await page.clock.fastForward(1000);
        assert.equal(await detail.isVisible(), true, 'inspection activation did not pin detail');
        assert.equal(await page.evaluate('window.__posted.filter(m => m.type === "compact").length'), 1);
        await page.keyboard.press('Escape');
        assert.equal(await detail.isHidden(), true);
      }
      await anchor.click();
      await anchor.click();
      assert.equal(await detail.isHidden(), true, 'expanded trigger did not dismiss detail');
      await anchor.click();
      await page.keyboard.press('Tab');
      assert.equal(await detail.locator('button').evaluate((node) => node === document.activeElement), true);
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-control')), 'usage');
      assert.equal(await detail.isVisible(), true, 'native Tab departure dismissed pinned detail');
      await page.locator('#prompt').focus();
      assert.equal(await detail.isVisible(), true, 'focus departure dismissed pinned detail');
      await page.locator('#prompt').click();
      assert.equal(await detail.isHidden(), true, 'outside press did not dismiss pinned detail');
      await anchor.focus();
      await page.keyboard.press('Tab');
      await page.locator('#prompt').hover();
      const replaced = renderPayload();
      replaced.showing = 'other';
      (replaced.usage as { composer: { sessionId: string } }).composer.sessionId = 'other';
      await post(page, { type: 'usage', usage: replaced.usage });
      assert.equal(await detail.isHidden(), true, 'session replacement left detail open');
      const readOnly = renderPayload();
      (readOnly.usage as { composer: { context: { compact: boolean } } }).composer.context.compact = false;
      await post(page, readOnly);
      await anchor.hover();
      await page.clock.fastForward(500);
      assert.equal(await detail.isVisible(), true);
      assert.equal(await page.locator('#hintpop').isHidden(), true, 'read-only context opened a second popover');
      assert.equal(await anchor.getAttribute('title'), null, 'read-only context retained a native tooltip');
      assert.ok(await anchor.getAttribute('aria-label'), 'read-only context has no accessible name');
      assert.equal(await detail.locator('button').count(), 0, 'read-only detail retains Compact');
    } finally {
      await browser.close();
    }
  },
);

test('collapsed prompt box suppresses completion and settings across redraws', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no browser installed');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(themed(pageHtml()));
    const payload = renderPayload();
    await post(page, payload);
    await page.locator('#prompt').fill('/');
    assert.equal(await page.locator('#slashpop').isVisible(), true);
    await post(page, { type: 'setComposerHidden', hidden: true });
    assert.equal(await page.locator('#slashpop').isHidden(), true, 'collapse left completion visible');
    assert.equal(await page.evaluate('document.activeElement?.id'), 'composer-restore');
    await post(page, payload);
    assert.equal(await page.locator('#slashpop').isHidden(), true, 'a payload reopened completion');
    await page.locator('#composer-restore').click();
    await page.locator('#prompt').fill('./wor');
    await page.clock.fastForward(500);
    const request = await page.evaluate<Record<string, unknown>>(
      'window.__posted.filter(m => m.type === "pathCompletion").at(-1)',
    );
    await page.locator('#composer-collapse').click();
    await post(page, {
      ...request,
      rows: [{ name: 'work', directory: false, label: 'work', accessibleName: 'File work', completion: './work' }],
    });
    assert.equal(await page.locator('#slashpop').isHidden(), true, 'a delayed path reply reopened completion');
    await post(page, { type: 'setComposerHidden', hidden: false });
    await page.locator('[data-control="model"]').click();
    assert.equal(await page.locator('.choicepop:visible').count(), 1);
    await post(page, { type: 'setComposerHidden', hidden: true });
    assert.equal(await page.locator('.choicepop:visible').count(), 0, 'collapse left a settings picker visible');
    assert.equal(await page.evaluate('document.activeElement?.id'), 'composer-restore');
    await post(page, { type: 'openPick', control: 'model' });
    await post(page, payload);
    assert.equal(
      await page.locator('.choicepop:visible').count(),
      0,
      'a hidden settings open or payload reopened its picker',
    );
    await post(page, { type: 'setComposerHidden', hidden: false });
    await post(page, { type: 'openPick', control: 'mcp' });
    assert.equal(await page.locator('#pickpop').isVisible(), true);
    await post(page, { type: 'setComposerHidden', hidden: true });
    await post(page, payload);
    await post(page, { type: 'openPick', control: 'mcp' });
    assert.equal(await page.locator('#pickpop').isHidden(), true, 'collapsed settings reopened Servers');
    await page.evaluate(`(async () => {
      const card = document.querySelector('[data-key]');
      if (card.querySelector('.body').hidden) {
        card.querySelector('.head').click();
        await ${SETTLED};
      }
      const range = document.createRange();
      range.selectNodeContents(card.querySelector('.summary p'));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      await ${SETTLED};
      document.querySelector('.quotebar button').click();
      await ${SETTLED};
    })()`);
    await page.locator('.quoteslot .notearea').fill('/');
    assert.equal(await page.locator('#slashpop').isVisible(), true, 'collapse suppressed visible comment completion');
    await post(page, payload);
    assert.equal(await page.locator('#slashpop').isVisible(), true, 'a payload suppressed visible comment completion');
    const restored = await browser.newPage();
    (payload.usage as { composer: { draft: string } }).composer.draft = '/';
    await restored.setContent(
      themed(
        pageHtml().replace(
          'const SAVED_STATE = {};',
          'const SAVED_STATE = { composerHidden: true, drafts: { s1: "/" } };',
        ),
      ),
    );
    await post(restored, payload);
    assert.equal(await restored.locator('#prompt').inputValue(), '/');
    assert.equal(await restored.locator('#slashpop').isHidden(), true, 'collapsed startup opened completion');
    await restored.close();
  } finally {
    await browser.close();
  }
});

test('collapsed prompt box reveals only accepted current draft actions', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no browser installed');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(themed(pageHtml()));
    await post(page, renderPayload());
    const prompt = page.locator('#prompt');
    await prompt.fill('local text');
    const revision = await page.evaluate<number>('window.__posted.filter(m => m.type === "draft").at(-1).revision');
    await page.locator('#composer-collapse').click();
    await post(page, { type: 'restoreDraft', session: 's1', text: 'background text', revision });
    assert.equal(
      await page.evaluate('document.activeElement?.id'),
      'composer-restore',
      'background restoration took focus',
    );
    assert.equal(await page.locator('#composer-restore').isVisible(), true);
    assert.equal(await prompt.inputValue(), 'background text');
    await post(page, { type: 'takeDraft', session: 's2', text: 'offscreen recovery' });
    assert.equal(await prompt.inputValue(), 'background text', 'offscreen recovery changed the selected target');
    assert.equal(await page.locator('#composer-restore').isVisible(), true);
    assert.equal(await page.evaluate('document.activeElement?.id'), 'composer-restore');
    await post(page, { type: 'takeQueuedDraft', session: 's2', text: 'offscreen queue', revision: 1, value: 'q2' });
    assert.equal(await prompt.inputValue(), 'background text');
    assert.equal(await page.locator('#composer-restore').isVisible(), true);
    await post(page, {
      type: 'takeQueuedDraft',
      session: 's1',
      text: 'stale queue',
      revision: revision - 1,
      value: 'q1',
    });
    assert.equal(await page.locator('#composer-restore').isVisible(), true);
    await post(page, { type: 'takeQueuedDraft', session: 's1', text: 'accepted queue', revision, value: 'q1' });
    assert.equal(await prompt.isVisible(), true, 'accepted queued edit did not reveal the prompt box');
    assert.equal(await page.evaluate('document.activeElement?.id'), 'prompt');
    await page.locator('#composer-collapse').focus();
    const currentRevision = await page.evaluate<number>(
      'window.__posted.filter(m => m.type === "acceptQueuedEdit" && m.accepted && m.session === "s1").at(-1).currentRevision',
    );
    await post(page, {
      type: 'restoreDraft',
      session: 's1',
      text: 'visible background text',
      revision: currentRevision,
    });
    assert.equal(await prompt.inputValue(), 'visible background text');
    assert.equal(
      await page.evaluate('document.activeElement?.id'),
      'composer-collapse',
      'visible background restoration took focus',
    );
    await page.locator('#composer-collapse').click();
    await post(page, { type: 'takeDraft', session: 's1', text: 'failed prompt' });
    assert.equal(await prompt.isVisible(), true, 'explicit recovery did not reveal the prompt box');
    assert.equal(await page.evaluate('document.activeElement?.id'), 'prompt');
  } finally {
    await browser.close();
  }
});

function usageWith(payload: Record<string, unknown>, composer: object | null): Record<string, unknown> {
  return { ...(payload.usage as Record<string, unknown>), composer };
}

async function moveTo(page: Page, locator: Locator, ratio = 0.5): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  assert.ok(box, 'the pointer target has no box');
  const point = { x: box.x + box.width * ratio, y: box.y + box.height / 2 };
  await page.mouse.move(point.x, point.y);
  return point;
}

test(
  'the launcher preselects each agent permission mode and keeps the agent default selectable',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
      return;
    }
    try {
      const page = await browser.newPage();
      await page.setContent(pageHtml());
      await post(page, renderPayload());
      await page.click('#rail .railnewmenu');

      const choose = async (field: string, value: string) => {
        await page.locator(`#launcher [data-control="launch-${field}"]`).click();
        await page.locator(`[data-control="launch-${field}:${value}"]`).click();
      };
      const agent = (value: string) => choose('agent', value);
      const model = page.locator('#launcher [data-control="launch-model"]');
      const checked = (field: string) =>
        page.locator(`#launcher [data-control="launch-${field}"]`).getAttribute('data-value');
      await agent('codex');
      assert.equal(await checked('permissions'), 'on-request');
      await agent('claude');
      assert.equal(await checked('permissions'), 'auto');
      await page.locator('[data-control="launch-permissions"]').click();
      assert.equal(
        await page.locator('[data-control="launch-permissions:"] .pickname').textContent(),
        'Claude default',
      );
      await page.keyboard.press('Escape');
      await agent('codex');
      assert.equal(await checked('permissions'), 'on-request');
      await page.locator('[data-control="launch-permissions"]').click();
      assert.equal(await page.locator('[data-control="launch-permissions:"] .pickname').textContent(), 'Codex default');
      await page.keyboard.press('Escape');
      const before = { model: await model.getAttribute('data-value'), effort: await checked('effort') };
      await choose('permissions', '');
      assert.equal(await checked('permissions'), '');
      assert.deepEqual({ model: await model.getAttribute('data-value'), effort: await checked('effort') }, before);

      await page.evaluate(`window.__posted = []`);
      await page.click('#launcher [data-control="launch-create"]');
      const request = (await page.evaluate(
        `window.__posted.find((message) => message.type === 'newSession').request`,
      )) as { permissionMode: string };
      assert.equal(request.permissionMode, '');
    } finally {
      await browser.close();
    }
  },
);

test('the launcher form keeps a remembered agent default permission', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    for (const agentName of ['claude', 'codex']) {
      const payload = renderPayload();
      const launcher = (payload.usage as { launcher: SessionLauncherView }).launcher;
      const row = [launcher.primary, ...launcher.recent].find((one) => one?.profile.agent === agentName);
      assert.ok(row, `the fixture has no ${agentName} setup`);
      launcher.primary = { ...row, profile: { ...row.profile, permissionMode: '' } };
      const page = await browser.newPage();
      await page.setContent(pageHtml());
      await post(page, payload);
      await page.click('#rail .railnewmenu');
      assert.equal(await page.locator('#launcher [data-control="launch-agent"]').getAttribute('data-value'), agentName);
      assert.equal(
        await page.locator('#launcher [data-control="launch-permissions"]').getAttribute('data-value'),
        '',
        `a remembered ${agentName} setup lost its agent default permission`,
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('Codex completes skills with dollar or slash while commands remain slash-only', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(pageHtml());
    const payload = renderPayload();
    const codex = composerView(
      {
        ...COMPOSER,
        agent: 'codex',
        commands: [
          { kind: 'command', name: 'compact', description: 'Compact the session', argumentHint: '' },
          { kind: 'skill', name: 'check-guide-docs', description: 'Audit instructions', argumentHint: '' },
        ],
      },
      Date.now(),
    );
    assert.ok(codex);
    await post(page, { type: 'usage', usage: usageWith(payload, codex) });
    const prompt = page.locator('#prompt');
    await prompt.fill('$');
    assert.deepEqual(await page.locator('.slashrow .slashname').allTextContents(), ['$check-guide-docs']);
    await prompt.fill('$che');
    await prompt.press('Enter');
    assert.equal(await prompt.inputValue(), '$check-guide-docs ');
    await prompt.press('x');
    await prompt.press('Control+z');
    assert.equal(await prompt.inputValue(), '$check-guide-docs ');
    await prompt.press('Control+z');
    assert.equal(await prompt.inputValue(), '$che');
    await prompt.press('Enter');
    await prompt.press('Enter');
    const sentDollar = (await page.evaluate(
      `window.__posted.filter((message) => message.type === 'sendPrompt').at(-1)`,
    )) as { text: string };
    assert.equal(sentDollar.text, '$check-guide-docs ');

    await prompt.fill('/che');
    assert.deepEqual(await page.locator('.slashrow .slashname').allTextContents(), ['/check-guide-docs']);
    await prompt.press('Enter');
    assert.equal(await prompt.inputValue(), '/check-guide-docs ');
    await prompt.press('Enter');
    const sentSlash = (await page.evaluate(
      `window.__posted.filter((message) => message.type === 'sendPrompt').at(-1)`,
    )) as { text: string };
    assert.equal(sentSlash.text, '/check-guide-docs ');

    for (const text of ['$HOME', '$100', '$missing']) {
      await prompt.fill(text);
      assert.equal(await page.locator('#slashpop').getAttribute('hidden'), '', `${text} opened a skill menu`);
    }
    await prompt.fill('$che');
    await prompt.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(0, 2));
    await page.evaluate(`document.dispatchEvent(new Event('selectionchange'))`);
    assert.equal(await page.locator('#slashpop').getAttribute('hidden'), '', 'a selected dollar token opened a menu');
  } finally {
    await browser.close();
  }
});

// Activity republishes the running prompt box.
// Updates must retain the Stop control, its focus, and its open hint.
test('a running usage update keeps the focused Stop control and its open hint', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(String(error)));
    await page.setContent(pageHtml());
    const payload = renderPayload();
    const composer = ((payload.usage as Record<string, unknown>).composer ?? {}) as Record<string, unknown>;
    const box = composer.box as Record<string, unknown>;
    const running = {
      ...composer,
      box: {
        ...box,
        actionLabel: 'Stop',
        actionName: 'Stop the turn Embedded agent input is running.',
        actionControl: 'stop',
        actionKind: 'stop',
        actionEnabled: true,
      },
    };
    await post(page, { type: 'usage', usage: usageWith(payload, running) });
    const stop = page.locator('[data-control="stop"]');
    await stop.hover();
    await page.clock.fastForward(350);
    await stop.focus();
    assert.equal(
      await page.locator('#hintpop').isHidden(),
      false,
      'the Stop hint did not open before the running update',
    );
    await page.evaluate(`(() => {
      window.__stopControl = document.querySelector('[data-control="stop"]');
      window.__stopIcon = window.__stopControl.querySelector('svg');
      window.__stopHint = document.getElementById('hintpop');
      window.__contextControl = document.querySelector('.cctx');
      window.__contextBar = window.__contextControl.querySelector('.cctxbar');
      window.__contextFill = window.__contextControl.querySelector('.cctxbar i');
      window.__contextPercent = window.__contextControl.querySelector('.cctxpct');
    })()`);

    const context = composer.context as Record<string, unknown>;
    const refreshed = {
      ...running,
      context: {
        ...context,
        percent: 61,
        fill: 61,
        level: 'filling',
        name: '61% of the context window is in use.',
      },
    };
    await post(page, { type: 'activity', session: 's1', card: (payload.cards as unknown[])[0] });
    await post(page, { type: 'usage', usage: usageWith(payload, refreshed) });

    const kept = (await page.evaluate(`(() => {
      const stop = document.querySelector('[data-control="stop"]');
      const context = document.querySelector('.cctx');
      const hint = document.getElementById('hintpop');
      return {
        stop: stop === window.__stopControl,
        icon: stop.querySelector('svg') === window.__stopIcon,
        focused: document.activeElement === stop,
        hint: hint === window.__stopHint,
        hintOpen: !hint.hidden,
        hintTitle: hint.querySelector('.hinttitle').textContent,
        context: context === window.__contextControl,
        contextBar: context.querySelector('.cctxbar') === window.__contextBar,
        contextFill: context.querySelector('.cctxbar i') === window.__contextFill,
        contextPercent: context.querySelector('.cctxpct') === window.__contextPercent,
        percent: context.querySelector('.cctxpct').textContent,
        fill: context.querySelector('.cctxbar i').style.width,
        level: context.classList.contains('ctx-filling'),
        contextName: context.getAttribute('aria-label'),
      };
    })()`)) as {
      stop: boolean;
      icon: boolean;
      focused: boolean;
      hint: boolean;
      hintOpen: boolean;
      hintTitle: string;
      context: boolean;
      contextBar: boolean;
      contextFill: boolean;
      contextPercent: boolean;
      percent: string;
      fill: string;
      level: boolean;
      contextName: string;
    };
    assert.deepEqual(failures, []);
    assert.deepEqual(
      { stop: kept.stop, icon: kept.icon, focused: kept.focused, hint: kept.hint, hintOpen: kept.hintOpen },
      { stop: true, icon: true, focused: true, hint: true, hintOpen: true },
      'the activity usage update replaced Stop or flashed its open hint',
    );
    assert.equal(kept.hintTitle, 'Stop');
    assert.deepEqual(
      {
        context: kept.context,
        bar: kept.contextBar,
        fillNode: kept.contextFill,
        percentNode: kept.contextPercent,
        percent: kept.percent,
        fill: kept.fill,
        level: kept.level,
      },
      {
        context: true,
        bar: true,
        fillNode: true,
        percentNode: true,
        percent: '61%',
        fill: '61%',
        level: true,
      },
      'the context update replaced its owner or left its mutable figure stale',
    );
    assert.equal(kept.contextName, refreshed.context.name);
  } finally {
    await browser.close();
  }
});

test('Escape stops only the selected running Claude or Codex session', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(pageHtml());
    const payload = renderPayload();
    const editableRunning = composerView({ ...COMPOSER, running: true }, Date.now());
    assert.ok(editableRunning);
    payload.usage = usageWith(payload, editableRunning);
    await post(page, payload);
    await openRailBox(page);
    const railFilter = page.locator('[data-control="railfilter"]');
    assert.equal(
      await railFilter.evaluate((node) => node.closest('#composer')),
      null,
      'the editable regression control is inside the Composer',
    );
    await railFilter.fill('agent:codex');
    await page.evaluate(SETTLED);
    assert.equal(await railFilter.inputValue(), 'agent:codex', 'the rail filter did not retain its query');
    assert.equal(await page.locator('#filterpop').isVisible(), false, 'the completed agent query offers completions');
    await page.evaluate(`window.__posted = []`);
    await railFilter.press('Escape');
    await page.evaluate(SETTLED);
    assert.equal(await railFilter.isVisible(), true, 'clearing Search hid the rail filter');
    assert.equal(await railFilter.inputValue(), '', 'Escape did not clear the rail query');
    assert.equal(await railFilter.evaluate((node) => node === document.activeElement), true);
    assert.equal(
      await page.evaluate(`window.__posted.some((message) => message.type === 'stopTurn')`),
      false,
      'Escape in the rail filter stopped the running session',
    );
    await railFilter.press('Escape');
    await page.evaluate(SETTLED);
    assert.equal(await railFilter.count(), 0, 'Escape did not close the empty rail filter');
    assert.equal(
      await page.evaluate(`window.__posted.some((message) => message.type === 'stopTurn')`),
      false,
      'closing the empty rail filter stopped the running session',
    );

    for (const agent of ['claude', 'codex'] as const) {
      const runningSession = `${agent}-running`;
      const idleSession = `${agent}-idle`;
      const running = composerView(
        {
          ...COMPOSER,
          agent,
          running: true,
          session: runningSession,
          sessionId: runningSession,
        },
        Date.now(),
      );
      assert.ok(running);
      await post(page, { type: 'usage', usage: usageWith(payload, running) });
      await page.locator('#prompt').fill('');
      await page.evaluate(`window.__posted = []`);

      await page.locator('#prompt').focus();
      await page.keyboard.press('Escape');
      await page.evaluate(SETTLED);
      const stops = (await page.evaluate(`window.__posted.filter((message) => message.type === 'stopTurn')`)) as Array<{
        session: string;
      }>;
      assert.deepEqual(
        stops,
        [{ type: 'stopTurn', session: runningSession }],
        `${agent} Escape did not take the visible Stop action for the selected session`,
      );

      await page.evaluate(`window.__posted = []`);
      await page.locator('#prompt').fill('Keep editing this draft.');
      await page.keyboard.press('Escape');
      await page.evaluate(SETTLED);
      assert.equal(
        await page.evaluate(`window.__posted.some((message) => message.type === 'stopTurn')`),
        false,
        `${agent} Escape stopped the turn while the Composer held draft text`,
      );

      const idle = composerView(
        {
          ...COMPOSER,
          agent,
          running: false,
          session: idleSession,
          sessionId: idleSession,
        },
        Date.now(),
      );
      assert.ok(idle);
      await post(page, { type: 'usage', usage: usageWith(payload, idle) });
      await page.evaluate(`window.__posted = []`);
      await page.locator('#prompt').fill('');
      await page.keyboard.press('Escape');
      await page.evaluate(SETTLED);
      assert.equal(
        await page.evaluate(`window.__posted.some((message) => message.type === 'stopTurn')`),
        false,
        `${agent} Escape stopped the selected inactive session`,
      );

      await post(page, { type: 'usage', usage: usageWith(payload, running) });
      await page.evaluate(`window.__posted = []`);
      await page.locator('#prompt').fill('');
      await page.keyboard.press('Escape');
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.evaluate(`window.__posted.filter((message) => message.type === 'stopTurn')`),
        [{ type: 'stopTurn', session: runningSession }],
        `${agent} Escape did not return to the selected running session`,
      );
    }
  } finally {
    await browser.close();
  }
});

test('Escape dismisses the model picker before stopping a running session', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(pageHtml());
    const payload = renderPayload();
    const running = composerView({ ...COMPOSER, running: true }, Date.now());
    assert.ok(running);
    await post(page, { type: 'usage', usage: usageWith(payload, running) });
    await page.locator('[data-control="model"]').click();
    await page.locator('#composer-model-list').waitFor({ state: 'visible' });
    await page.evaluate(`window.__posted = []`);

    await page.keyboard.press('Escape');
    await page.evaluate(SETTLED);

    assert.equal(await page.locator('#composer-model-list').isHidden(), true, 'Escape left the model picker open');
    assert.equal(
      await page.evaluate(`window.__posted.some((message) => message.type === 'stopTurn')`),
      false,
      'dismissing the model picker stopped the running session',
    );
  } finally {
    await browser.close();
  }
});

test('Escape dismisses stat detail before stopping a running session', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(pageHtml());
    const payload = statPopoverPayload();
    const running = composerView({ ...COMPOSER, running: true }, Date.now());
    assert.ok(running);
    payload.usage = usageWith(payload, running);
    await post(page, payload);
    const expiry = page.locator('[data-metric="cache-expiry"].statdetail').first();
    await expiry.click();
    assert.equal(await page.locator('#chippop').isVisible(), true, 'the cache-expiry detail did not open');
    await page.evaluate(`window.__posted = []`);

    await page.keyboard.press('Escape');
    await page.evaluate(SETTLED);

    assert.equal(await page.locator('#chippop').isHidden(), true, 'Escape left the cache-expiry detail open');
    assert.equal(
      await page.evaluate(`window.__posted.some((message) => message.type === 'stopTurn')`),
      false,
      'dismissing the cache-expiry detail stopped the running session',
    );
  } finally {
    await browser.close();
  }
});

test('composer controls keep hints while context inspection opens one detail', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(String(error)));
    await page.setContent(themed(pageHtml()));
    const payload = renderPayload();
    const composer = ((payload.usage as Record<string, unknown>).composer ?? {}) as Record<string, unknown>;
    await post(page, { type: 'usage', usage: usageWith(payload, composer) });

    const pressable = (await page.evaluate(`(() => {
      const chips = [...document.querySelectorAll('.cpick'), document.querySelector('.cctx')];
      return chips.map((node) => ({
        control: node.dataset.control ?? null,
        tag: node.tagName,
        title: node.getAttribute('title'),
        hint: node.dataset.hint ?? null,
        ariaLabel: node.getAttribute('aria-label'),
      }));
    })()`)) as Array<{
      control: string | null;
      tag: string;
      title: string | null;
      hint: string | null;
      ariaLabel: string | null;
    }>;

    assert.deepEqual(failures, []);
    assert.ok(pressable.length >= 4, 'the model, effort, ask mode and context chips were not all drawn');
    for (const chip of pressable) {
      assert.equal(chip.tag, 'BUTTON', `the ${chip.control ?? 'context'} chip is not a real button`);
      assert.equal(chip.title, null, `the ${chip.control ?? 'context'} chip button carries a native title`);
      if (chip.control === 'context') {
        assert.equal(chip.hint, '', 'the context anchor still opens a second hint');
        assert.ok(chip.ariaLabel, 'the context anchor has no accessible name');
        continue;
      }
      assert.ok(chip.hint, `the ${chip.control ?? 'context'} chip button has no panel hint`);
      assert.notEqual(
        chip.hint,
        chip.ariaLabel,
        `the ${chip.control ?? 'context'} chip hint repeats its own accessible name`,
      );
    }

    const context = page.locator('.cctx');
    await context.hover();
    await page.clock.fastForward(350);
    assert.equal(await page.locator('#hintpop').isHidden(), true, 'context hover opened a second hint');
    assert.equal(await page.locator('#composer-context-detail').isVisible(), true);

    const readOnlyState: ComposerState = {
      ...(COMPOSER as unknown as ComposerState),
      agent: 'gemini' as unknown as ComposerState['agent'],
    };
    const readOnlyView = composerView(readOnlyState, Date.now());
    assert.ok(readOnlyView, 'the read-only composer state drew no composer at all');
    await post(page, { type: 'usage', usage: usageWith(payload, readOnlyView) });
    const readOnly = (await page.evaluate(`(() => {
      const node = document.querySelector('.cctx');
      return { tag: node.tagName, title: node.getAttribute('title'), hint: node.dataset.hint ?? null, name: node.getAttribute('aria-label') };
    })()`)) as { tag: string; title: string | null; hint: string | null; name: string | null };
    assert.equal(readOnly.tag, 'BUTTON', 'context inspection has no native keyboard control');
    assert.equal(readOnly.title, null, 'the read-only context figure retained a native tooltip');
    assert.equal(readOnly.hint, '', 'the read-only context figure still opens a second hint');
    assert.ok(readOnly.name, 'the read-only context figure has no accessible name');
  } finally {
    await browser.close();
  }
});

// Background updates must retain the prompt box, prompt text field, and reserved child slots
// while the reader edits.
test(
  'background messages retain the Composer editing surface and later-owner slots',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
      return;
    }
    try {
      const page = await browser.newPage();
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(String(error)));
      await page.setViewportSize({ width: 340, height: 720 });
      await page.setContent(pageHtml());
      const payload = renderPayload();
      await post(page, payload);
      await page.evaluate(`(() => {
      const prompt = document.getElementById('prompt');
      prompt.value = 'alpha beta\\n' + Array.from({ length: 20 }, (_, at) => 'line ' + at).join('\\n');
      prompt.setSelectionRange(2, 8);
      prompt.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      prompt.setSelectionRange(2, 8);
      prompt.scrollTop = 18;
      window.__ui7g = {
        composer: document.getElementById('composer'),
        prompt,
        slots: [...document.querySelectorAll('[data-composer-slot]')],
        compact: document.querySelector('.controls select'),
        project: document.querySelector('.projectspendcompacthost'),
        scroll: prompt.scrollTop,
      };
    })()`);
      const initialScroll = (await page.evaluate(`window.__ui7g.scroll`)) as number;
      assert.ok(initialScroll > 0, 'the textarea did not scroll, so the preservation check measures nothing');
      const composer = ((payload.usage as Record<string, unknown>).composer ?? {}) as Record<string, unknown>;
      const messages = [
        { type: 'usage', usage: usageWith(payload, composer) },
        { type: 'activity', session: 's1', card: (payload.cards as unknown[])[0] },
        {
          type: 'rail',
          rail: payload.rail,
          headers: payload.headers,
          stats: payload.stats,
          labels: payload.labels,
          railFilters: payload.railFilters,
        },
        { type: 'projectSpend', projectSpend: payload.projectSpend },
        { ...payload, cards: [...(payload.cards as unknown[])] },
      ];
      for (const message of messages) {
        await post(page, message);
        assert.equal(
          await page.locator('#prompt').evaluate((node: HTMLTextAreaElement) => node.scrollTop),
          initialScroll,
          'an unrelated background message reset the textarea scroll position',
        );
      }
      await page.setViewportSize({ width: 1350, height: 720 });
      await page.evaluate(SETTLED);
      await page.setViewportSize({ width: 340, height: 720 });
      await page.evaluate(SETTLED);
      const held = (await page.evaluate(`(() => {
      const kept = window.__ui7g;
      const prompt = document.getElementById('prompt');
      const slots = [...document.querySelectorAll('[data-composer-slot]')];
      return {
        composer: kept.composer === document.getElementById('composer'),
        prompt: kept.prompt === prompt,
        slots: kept.slots.length === slots.length && kept.slots.every((slot, at) => slot === slots[at]),
        compact: kept.compact === document.querySelector('.controls select'),
        project: kept.project === document.querySelector('.projectspendcompacthost'),
        value: prompt.value,
        start: prompt.selectionStart,
        end: prompt.selectionEnd,
        scroll: prompt.scrollTop,
      };
    })()`)) as {
        composer: boolean;
        prompt: boolean;
        slots: boolean;
        compact: boolean;
        project: boolean;
        value: string;
        start: number;
        end: number;
        scroll: number;
      };
      assert.deepEqual(failures, []);
      assert.deepEqual(
        {
          composer: held.composer,
          prompt: held.prompt,
          slots: held.slots,
          compact: held.compact,
          project: held.project,
        },
        { composer: true, prompt: true, slots: true, compact: true, project: true },
      );
      assert.match(held.value, /^alpha beta/);
      assert.deepEqual([held.start, held.end], [2, 8]);
      await page.locator('#prompt').press('Control+z');
      assert.equal(await page.locator('#prompt').inputValue(), '');
      await page.locator('#prompt').press('Control+y');
      assert.match(await page.locator('#prompt').inputValue(), /^alpha beta/);

      await page.evaluate(`(() => {
      const event = new Event('dragenter', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'] } });
      document.getElementById('composer').dispatchEvent(event);
    })()`);
      assert.equal(await page.locator('#composer').evaluate((node) => node.classList.contains('dropping')), true);
      assert.equal(await page.locator('#prompt').getAttribute('placeholder'), 'Drop to attach');
      await post(page, { type: 'usage', usage: usageWith(payload, composer) });
      assert.equal(await page.locator('#prompt').getAttribute('placeholder'), 'Drop to attach');
      await page.evaluate(
        `document.getElementById('composer').dispatchEvent(new Event('dragleave', { bubbles: true }))`,
      );
      assert.equal(await page.locator('#composer').evaluate((node) => node.classList.contains('dropping')), false);
      assert.notEqual(await page.locator('#prompt').getAttribute('placeholder'), 'Drop to attach');

      await page.evaluate(`(() => {
      const prompt = document.getElementById('prompt');
      prompt.setSelectionRange(prompt.value.length, prompt.value.length);
      prompt.value += 'Î©';
      prompt.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'Î©' }));
      prompt.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'Î©', inputType: 'insertCompositionText', isComposing: true }));
    })()`);
      await post(page, { type: 'usage', usage: usageWith(payload, composer) });
      assert.match(await page.locator('#prompt').inputValue(), /Î©$/);
    } finally {
      await browser.close();
    }
  },
);

// Recognized skills keep their detail controls. Inspection must preserve the prompt text
// and selection in the prompt text field.
test('slash-form catalog skills stay inspectable inside the live textarea', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(pageHtml());
    const payload = renderPayload();
    const base = ((payload.usage as Record<string, unknown>).composer ?? {}) as Record<string, unknown>;
    await post(page, {
      type: 'usage',
      usage: usageWith(payload, {
        ...base,
        agent: 'codex',
        commands: [
          {
            kind: 'skill',
            command: 'land',
            prefix: '/',
            label: '/land',
            hint: '',
            description: 'Land one reviewed change',
            path: 'C:\\Users\\reader\\.agents\\skills\\land\\SKILL.md',
            name: '/land. Land one reviewed change',
            completion: '/land ',
          },
          {
            kind: 'command',
            command: 'compact',
            prefix: '/',
            label: '/compact',
            hint: '',
            description: 'Compact the session',
            name: '/compact. Compact the session',
            completion: '/compact ',
          },
        ],
      }),
    });
    const prompt = page.locator('#prompt');
    await prompt.fill('Use /land, not /compact or src/land/file.');
    await prompt.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(4, 9));
    const skill = page.locator('.cskilltoken');
    assert.equal(await skill.count(), 1);
    assert.equal(await skill.textContent(), '/land');
    assert.match((await skill.getAttribute('aria-label')) ?? '', /Skill \/land.*Land one reviewed.*SKILL\.md/);
    await moveTo(page, skill);
    assert.equal(await page.locator('#chippop').isVisible(), true);
    assert.match((await page.locator('#chippop').textContent()) ?? '', /\/land.*File.*SKILL\.md.*Land one reviewed/);
    assert.equal(await prompt.inputValue(), 'Use /land, not /compact or src/land/file.');
    assert.deepEqual(
      await prompt.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd]),
      [4, 9],
    );
    await prompt.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(9, 9));
    const click = await moveTo(page, skill);
    await page.mouse.click(click.x, click.y);
    await page.evaluate(SETTLED);
    assert.equal(await skill.getAttribute('aria-pressed'), 'true');
    await page.mouse.click(click.x, click.y);
    await page.evaluate(SETTLED);
    assert.equal(await skill.getAttribute('aria-pressed'), 'false');
    await page.mouse.click(click.x, click.y);
    await page.evaluate(SETTLED);
    assert.equal(await skill.getAttribute('aria-pressed'), 'true');
    assert.equal(
      await page.evaluate(`document.activeElement?.id`),
      'prompt',
      'the pointer press focused the visual skill mark instead of leaving focus in the textarea',
    );

    await prompt.fill('/land then /la');
    await moveTo(page, page.locator('.cskilltoken'));
    assert.equal(await page.locator('#chippop').isVisible(), true, 'the hover preview did not open');
    assert.equal(await page.locator('#slashpop').isVisible(), true, 'completion did not open with the preview');
    await prompt.press('Escape');
    assert.equal(
      await page.locator('#slashpop').isVisible(),
      false,
      'Escape closed the skill preview before completion',
    );
    assert.equal(
      await page.locator('#chippop').isVisible(),
      true,
      'closing completion also dismissed the skill preview',
    );

    await prompt.fill('Use /land, not /compact or src/land/file.');
    await prompt.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(9, 9));
    const repin = await moveTo(page, page.locator('.cskilltoken'));
    await page.mouse.click(repin.x, repin.y);
    const beforeEscapeType = await prompt.inputValue();
    await page.keyboard.press('Escape');
    assert.equal(
      await page.evaluate(`document.activeElement?.id`),
      'prompt',
      'Escape after a pointer-opened skill did not return to the textarea',
    );
    await page.keyboard.type('!');
    assert.notEqual(
      await prompt.inputValue(),
      beforeEscapeType,
      'typing after Escape did not edit the native textarea',
    );
    await prompt.press('Control+z');
    assert.equal(await prompt.inputValue(), beforeEscapeType);
    await skill.press('Enter');
    assert.equal(await skill.getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Escape');
    await skill.press('Space');
    assert.equal(await skill.getAttribute('aria-pressed'), 'true');
    await post(page, {
      type: 'usage',
      usage: usageWith(payload, {
        ...base,
        agent: 'codex',
        commands: [
          {
            kind: 'skill',
            command: 'land',
            prefix: '/',
            label: '/land',
            hint: '',
            description: 'Land one reviewed change',
            path: 'C:\\Users\\reader\\.agents\\skills\\land\\SKILL.md',
            name: '/land. Land one reviewed change',
            completion: '/land ',
          },
        ],
      }),
    });
    assert.equal(await page.locator('#chippop').isVisible(), true);
    assert.equal(await page.locator('.cskilltoken').getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(`document.activeElement?.classList.contains('cskilltoken')`), true);
    assert.notEqual(await skill.evaluate((node) => getComputedStyle(node).outlineStyle), 'none');
    await prompt.fill('plain');
    assert.equal(await skill.count(), 0);
    await prompt.press('Control+z');
    assert.equal(await prompt.inputValue(), 'Use /land, not /compact or src/land/file.');
    assert.equal(await skill.count(), 1);
    await prompt.press('Enter');
    assert.equal(await prompt.inputValue(), '');
    assert.equal(await skill.count(), 0);
  } finally {
    await browser.close();
  }
});

// Pathless Claude and Codex skills omit the file list and its margin.
test('a pathless skill popover shows no blank gap where its file line would be', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(pageHtml());
    const payload = renderPayload();
    const base = ((payload.usage as Record<string, unknown>).composer ?? {}) as Record<string, unknown>;
    await post(page, {
      type: 'usage',
      usage: usageWith(payload, {
        ...base,
        agent: 'claude',
        commands: [
          {
            kind: 'command',
            command: 'land',
            prefix: '/',
            label: '/land',
            hint: '',
            description: 'Land one reviewed change',
            name: '/land. Land one reviewed change',
            completion: '/land ',
          },
          {
            kind: 'skill',
            command: 'check-guide-docs',
            prefix: '/',
            label: '/check-guide-docs',
            hint: '',
            description: 'Audit instructions',
            name: '/check-guide-docs. Audit instructions',
            completion: '/check-guide-docs ',
          },
          {
            kind: 'skill',
            command: 'context',
            prefix: '/',
            label: '/context',
            hint: '',
            description: 'Show context usage',
            path: 'C:\\Users\\reader\\.claude\\skills\\context\\SKILL.md',
            name: '/context. Show context usage',
            completion: '/context ',
          },
        ],
      }),
    });
    const prompt = page.locator('#prompt');
    await prompt.fill('Use /land then /check-guide-docs then /context.');
    // A skill with a path supplies the heading-to-file-list spacing for comparison.
    const pathed = page.locator('.cskilltoken', { hasText: '/context' });
    await moveTo(page, pathed);
    const pathedPop = page.locator('#chippop');
    assert.equal(await pathedPop.isVisible(), true, '/context did not open a popover');
    const referenceGap = await pathedPop.evaluate((node) => {
      const head = node.querySelector('.chippophead')!.getBoundingClientRect();
      const list = node.querySelector('.chippoplist')!.getBoundingClientRect();
      return list.top - head.bottom;
    });
    for (const label of ['/land', '/check-guide-docs']) {
      const skill = page.locator('.cskilltoken', { hasText: label });
      await moveTo(page, skill);
      const pop = page.locator('#chippop');
      assert.equal(await pop.isVisible(), true, `${label} did not open a popover`);
      assert.equal(
        await pop.locator('.chippoplist').count(),
        0,
        `${label}'s pathless popover still drew an empty file list`,
      );
      const measured = await pop.evaluate((node) => {
        const head = node.querySelector('.chippophead')!.getBoundingClientRect();
        const foot = node.querySelector('.chippopfoot')!;
        const footBox = foot.getBoundingClientRect();
        return {
          gap: footBox.top - head.bottom,
          borderTop: parseFloat(getComputedStyle(foot).borderTopWidth),
          rules: Array.from(node.children).filter((child) => {
            const style = getComputedStyle(child);
            return parseFloat(style.borderTopWidth) > 0 || parseFloat(style.borderBottomWidth) > 0;
          }).length,
        };
      });
      assert.ok(
        measured.gap <= referenceGap + 2,
        `${label}'s pathless popover left a ${measured.gap}px gap, wider than the ${referenceGap}px ordinary spacing a path popover leaves before its file row`,
      );
      assert.equal(measured.borderTop, 0, `${label}'s pathless popover drew a second rule under its description`);
      assert.equal(measured.rules, 1, `${label}'s pathless popover drew more than the heading's one rule`);
    }
  } finally {
    await browser.close();
  }
});

// A skill mark and its popover show the path supplied by the host.
test(
  'a Claude skill mark with a found path names it in its accessible name and popover',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
      return;
    }
    try {
      const page = await browser.newPage();
      await page.setContent(pageHtml());
      const payload = renderPayload();
      const base = ((payload.usage as Record<string, unknown>).composer ?? {}) as Record<string, unknown>;
      const skillPath = 'C:\\repo\\.claude\\skills\\land\\SKILL.md';
      await post(page, {
        type: 'usage',
        usage: usageWith(payload, {
          ...base,
          agent: 'claude',
          commands: [
            {
              kind: 'skill',
              command: 'land',
              prefix: '/',
              label: '/land',
              hint: '',
              description: 'Land one reviewed change',
              path: skillPath,
              name: '/land. Land one reviewed change',
              completion: '/land ',
            },
          ],
        }),
      });
      const prompt = page.locator('#prompt');
      await prompt.fill('Use /land.');
      const skill = page.locator('.cskilltoken');
      assert.equal(
        await skill.getAttribute('aria-label'),
        `Skill /land. Land one reviewed change. File ${skillPath}`,
        "the Claude skill mark's accessible name did not carry its found path",
      );
      await moveTo(page, skill);
      const pop = page.locator('#chippop');
      assert.equal(await pop.isVisible(), true);
      const fileRow = pop.locator('.chippoplist .chippopitem');
      assert.equal(await fileRow.count(), 1, 'the popover for a Claude skill with a found path drew no file row');
      assert.equal(
        await fileRow.locator('.chippoplabel').innerText(),
        'File',
        'the popover for a Claude skill with a found path drew no File row',
      );
      assert.equal(
        await fileRow.locator('.chippopvalue').innerText(),
        skillPath,
        'the popover for a Claude skill with a found path did not show it',
      );
    } finally {
      await browser.close();
    }
  },
);

test('a skill press follows the shared click-away sequence', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    // Keep the session list picker above the prompt box so it cannot cover the skill token.
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.setContent(pageHtml());
    const payload = renderPayload();
    const base = ((payload.usage as Record<string, unknown>).composer ?? {}) as Record<string, unknown>;
    await post(page, {
      type: 'usage',
      usage: usageWith(payload, {
        ...base,
        agent: 'codex',
        commands: [
          {
            kind: 'skill',
            command: 'land',
            prefix: '/',
            label: '/land',
            hint: '',
            description: 'Land one reviewed change',
            name: '/land. Land one reviewed change',
            completion: '/land ',
          },
        ],
      }),
    });
    const prompt = page.locator('#prompt');
    await prompt.fill('/land then /land');
    const skills = page.locator('.cskilltoken');
    assert.equal(await skills.count(), 2);

    await page.locator('[data-control="railfilters"]').click();
    assert.equal(await page.locator('#railfilterpop').isVisible(), true, 'the representative rail picker did not open');
    let point = await moveTo(page, skills.first());
    await page.mouse.click(point.x, point.y);
    await page.evaluate(SETTLED);
    assert.equal(
      await page.locator('#railfilterpop').isVisible(),
      false,
      'pressing a skill left an unrelated rail picker open',
    );
    assert.equal(await skills.first().getAttribute('aria-pressed'), 'true');

    point = await moveTo(page, skills.nth(1));
    await page.mouse.click(point.x, point.y);
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await skills.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-pressed'))),
      ['false', 'true'],
      'switching repeated skills left both detail anchors pressed',
    );
  } finally {
    await browser.close();
  }
});

test(
  'a pinned repeated skill follows the edited token or closes when identity is lost',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
      return;
    }
    try {
      const page = await browser.newPage();
      await page.setContent(pageHtml());
      const payload = renderPayload();
      const base = ((payload.usage as Record<string, unknown>).composer ?? {}) as Record<string, unknown>;
      await post(page, {
        type: 'usage',
        usage: usageWith(payload, {
          ...base,
          agent: 'codex',
          commands: [
            {
              kind: 'skill',
              command: 'land',
              prefix: '/',
              label: '/land',
              hint: '',
              description: 'Land one reviewed change',
              name: '/land. Land one reviewed change',
              completion: '/land ',
            },
          ],
        }),
      });
      const prompt = page.locator('#prompt');
      await prompt.fill('Use /land here');
      const skill = page.locator('.cskilltoken');
      const point = await moveTo(page, skill);
      await page.mouse.click(point.x, point.y);
      assert.equal(await skill.getAttribute('aria-pressed'), 'true');
      assert.equal(
        await prompt.evaluate((node) => node.classList.contains('is-over-skill')),
        true,
        'the pointer was not over the mark before the edit',
      );

      await prompt.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(0, 0));
      await page.keyboard.type('Prefix long enough to move the mark. ');
      assert.equal(
        await skill.getAttribute('aria-pressed'),
        'true',
        'editing before the skill discarded its pinned identity',
      );
      assert.equal(
        await page.locator('#chippop').isVisible(),
        true,
        'editing before the skill closed its pinned detail',
      );
      assert.equal(
        await prompt.evaluate((node) => node.classList.contains('is-over-skill')),
        false,
        'the textarea kept a pointer cursor after the mark moved away',
      );

      await prompt.fill('/land first, then /land later');
      await page.keyboard.press('Escape');
      const repeated = page.locator('.cskilltoken');
      let pinnedPoint = await moveTo(page, repeated.first());
      await page.mouse.click(pinnedPoint.x, pinnedPoint.y);
      await prompt.evaluate((node: HTMLTextAreaElement) => {
        const pasted = '/land pasted, ';
        node.focus();
        node.setSelectionRange(0, 0);
        node.dispatchEvent(
          new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertFromPaste',
            data: pasted,
          }),
        );
        node.setRangeText(pasted, 0, 0, 'end');
        node.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            inputType: 'insertFromPaste',
            data: pasted,
          }),
        );
      });
      assert.deepEqual(
        await repeated.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-pressed'))),
        ['false', 'true', 'false'],
        'pasting a repeated skill before the first token moved its pin to the pasted token',
      );
      await prompt.press('Control+z');
      assert.deepEqual(
        await repeated.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-pressed'))),
        ['true', 'false'],
        'undo moved the pin away from the original first token',
      );
      await prompt.press('Control+y');
      assert.deepEqual(
        await repeated.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-pressed'))),
        ['false', 'true', 'false'],
        'redo moved the pin to the pasted token',
      );
      await prompt.press('Control+z');

      await page.keyboard.press('Escape');
      pinnedPoint = await moveTo(page, repeated.nth(1));
      await page.mouse.click(pinnedPoint.x, pinnedPoint.y);
      await prompt.evaluate((node: HTMLTextAreaElement) => {
        const pasted = '/land pasted, ';
        node.focus();
        node.setSelectionRange(0, 0);
        node.dispatchEvent(
          new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertFromPaste',
            data: pasted,
          }),
        );
        node.setRangeText(pasted, 0, 0, 'end');
        node.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            inputType: 'insertFromPaste',
            data: pasted,
          }),
        );
      });
      assert.deepEqual(
        await repeated.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-pressed'))),
        ['false', 'false', 'true'],
        'pasting before repeated skills moved a later pin to another token',
      );
      await prompt.press('Control+z');
      assert.deepEqual(
        await repeated.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-pressed'))),
        ['false', 'true'],
        'undo moved the pin away from the original later token',
      );

      await prompt.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(18, 23));
      await page.keyboard.press('Backspace');
      assert.equal(await page.locator('#chippop').isVisible(), false, 'deleting the pinned token left its detail open');
      assert.deepEqual(await repeated.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-pressed'))), [
        'false',
      ]);
      await prompt.press('Control+z');
      assert.deepEqual(
        await repeated.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-pressed'))),
        ['false', 'false'],
        'undo reopened a pin after its token was deleted',
      );

      pinnedPoint = await moveTo(page, repeated.first());
      await page.mouse.click(pinnedPoint.x, pinnedPoint.y);
      await prompt.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(0, 0));
      await prompt.press('ArrowUp');
      assert.equal(await page.locator('#chippop').isVisible(), false, 'prompt history kept a stale skill pin');
      assert.equal(await repeated.count(), 0, 'prompt history kept marks from the replaced prompt');

      await prompt.fill('/land first, then /land later');
      pinnedPoint = await moveTo(page, repeated.first());
      await page.mouse.click(pinnedPoint.x, pinnedPoint.y);
      await page.mouse.move(0, 0);
      await prompt.evaluate((node: HTMLTextAreaElement) => {
        node.value = '/land later, then /land first';
        node.setSelectionRange(node.value.length, node.value.length);
        node.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            inputType: 'insertReplacementText',
            data: null,
          }),
        );
      });
      assert.equal(
        await page.locator('#chippop').isVisible(),
        false,
        'an ambiguous replacement moved an open detail to another repeated token',
      );
      assert.deepEqual(
        await repeated.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-pressed'))),
        ['false', 'false'],
        'an ambiguous replacement transferred the pin to another token',
      );
    } finally {
      await browser.close();
    }
  },
);

test('skill highlights require a complete slash token', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(pageHtml());
    const payload = renderPayload();
    const base = ((payload.usage as Record<string, unknown>).composer ?? {}) as Record<string, unknown>;
    await post(page, {
      type: 'usage',
      usage: usageWith(payload, {
        ...base,
        agent: 'codex',
        commands: [
          {
            kind: 'skill',
            command: 'land',
            prefix: '/',
            label: '/land',
            hint: '',
            description: 'Land one reviewed change',
            name: '/land. Land one reviewed change',
            completion: '/land ',
          },
        ],
      }),
    });
    const prompt = page.locator('#prompt');
    for (const text of ['/land.ts', '/land/more', '/landing', '/land,then']) {
      await prompt.fill(text);
      assert.equal(await page.locator('.cskilltoken').count(), 0, `${text} highlighted part of a larger token`);
    }
    await prompt.fill('/lan');
    assert.equal(await page.locator('.cskilltoken').count(), 0);
    assert.equal(
      await page.locator('#slashpop').getAttribute('hidden'),
      null,
      'an adjacent partial token did not keep command completion available',
    );
    await prompt.fill('Use /land plan.md, then /land, and finish with /land.)');
    assert.deepEqual(await page.locator('.cskilltoken').allTextContents(), ['/land', '/land', '/land']);
    assert.equal(
      await page.locator('#slashpop').getAttribute('hidden'),
      '',
      'an argument after whitespace reopened command completion',
    );
  } finally {
    await browser.close();
  }
});

test('pointer selection can start inside a skill highlight in either direction', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(pageHtml());
    const payload = renderPayload();
    const base = ((payload.usage as Record<string, unknown>).composer ?? {}) as Record<string, unknown>;
    await post(page, {
      type: 'usage',
      usage: usageWith(payload, {
        ...base,
        agent: 'codex',
        commands: [
          {
            kind: 'skill',
            command: 'land',
            prefix: '/',
            label: '/land',
            hint: '',
            description: 'Land one reviewed change',
            name: '/land. Land one reviewed change',
            completion: '/land ',
          },
        ],
      }),
    });
    const prompt = page.locator('#prompt');
    await prompt.fill('before /land after');
    const skill = page.locator('.cskilltoken');
    const box = await skill.boundingBox();
    assert.ok(box, 'the skill highlight has no pointer target');
    const y = box.y + box.height / 2;
    const drags: Array<[number, number, boolean]> = [
      [box.x + box.width / 2, box.x + box.width + 35, false],
      [box.x + box.width / 2, box.x - 35, false],
      [box.x - 35, box.x + box.width + 35, true],
      [box.x + box.width + 35, box.x - 35, true],
    ];
    for (const [startX, endX, crossesSkill] of drags) {
      await prompt.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(0, 0));
      await page.mouse.move(startX, y);
      await page.mouse.down();
      await page.mouse.move(endX, y, { steps: 8 });
      await page.mouse.up();
      const selection = await prompt.evaluate((node: HTMLTextAreaElement) => ({
        start: node.selectionStart,
        end: node.selectionEnd,
        text: node.value.slice(node.selectionStart, node.selectionEnd),
      }));
      assert.ok(
        selection.end > selection.start,
        `the ${endX > startX ? 'forward' : 'backward'} drag left the selection collapsed`,
      );
      assert.ok(selection.start < 12 && selection.end > 7, 'the drag did not select any of the highlighted skill');
      if (crossesSkill) {
        assert.ok(
          selection.start <= 7 && selection.end >= 12,
          'the drag across the highlight did not select the complete skill',
        );
      }
      assert.equal(await skill.getAttribute('aria-pressed'), 'false', 'the selection drag pinned the detail popover');
    }

    await prompt.evaluate(
      (node: HTMLTextAreaElement, point) => {
        node.dispatchEvent(
          new PointerEvent('pointerdown', {
            pointerId: 41,
            clientX: point.x,
            clientY: point.y,
            bubbles: true,
            detail: 1,
          }),
        );
        node.setSelectionRange(7, 8);
        node.dispatchEvent(
          new PointerEvent('pointerup', {
            pointerId: 41,
            clientX: point.x + 2,
            clientY: point.y,
            bubbles: true,
            detail: 1,
          }),
        );
        node.dispatchEvent(
          new MouseEvent('click', {
            clientX: point.x + 2,
            clientY: point.y,
            bubbles: true,
            detail: 1,
          }),
        );
      },
      { x: box.x + box.width / 2, y },
    );
    assert.equal(await skill.getAttribute('aria-pressed'), 'false', 'a short selection drag pinned the detail popover');

    await prompt.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(0, 0));
    await page.keyboard.down('Shift');
    await page.mouse.click(box.x + box.width / 2, y);
    await page.keyboard.up('Shift');
    assert.ok(
      await prompt.evaluate((node: HTMLTextAreaElement) => node.selectionEnd > node.selectionStart),
      'Shift-click did not extend the native textarea selection',
    );
    assert.equal(await skill.getAttribute('aria-pressed'), 'false', 'Shift-click pinned the detail popover');

    await page.clock.fastForward(500);
    await prompt.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(0, 0));
    await page.mouse.dblclick(box.x + box.width / 2, y);
    await page.evaluate(SETTLED);
    assert.ok(
      await prompt.evaluate((node: HTMLTextAreaElement) => node.selectionEnd > node.selectionStart),
      'double-click did not select native textarea text',
    );
    assert.equal(
      await skill.getAttribute('aria-pressed'),
      'false',
      'double-click selection left the detail popover pinned',
    );
  } finally {
    await browser.close();
  }
});

test('Tab skips skill controls outside the textarea viewport', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 340, height: 720 });
    await page.setContent(pageHtml());
    const payload = renderPayload();
    const base = ((payload.usage as Record<string, unknown>).composer ?? {}) as Record<string, unknown>;
    await post(page, {
      type: 'usage',
      usage: usageWith(payload, {
        ...base,
        agent: 'codex',
        commands: [
          {
            kind: 'skill',
            command: 'land',
            prefix: '/',
            label: '/land',
            hint: '',
            description: 'Land one reviewed change',
            name: '/land. Land one reviewed change',
            completion: '/land ',
          },
        ],
      }),
    });
    const prompt = page.locator('#prompt');
    await prompt.fill(
      ['/land starts here', ...Array.from({ length: 24 }, (_, at) => `line ${at}`), '/land stays visible'].join('\n'),
    );
    const before = await prompt.evaluate((node: HTMLTextAreaElement) => {
      node.scrollTop = node.scrollHeight;
      node.dispatchEvent(new Event('scroll'));
      const layer = document.querySelector('.cskilllayer') as HTMLElement;
      const skills = [...layer.querySelectorAll<HTMLElement>('.cskilltoken')];
      return { prompt: node.scrollTop, layer: layer.scrollTop, stops: skills.map((skill) => skill.tabIndex) };
    });
    assert.ok(before.prompt > 0, 'the textarea did not scroll, so the keyboard check measures nothing');
    assert.equal(before.layer, before.prompt);
    assert.deepEqual(before.stops, [-1, 0]);

    await prompt.focus();
    await page.keyboard.press('Tab');
    assert.deepEqual(
      await page.evaluate(`(() => {
      const prompt = document.getElementById('prompt');
      const layer = document.querySelector('.cskilllayer');
      const skills = [...layer.querySelectorAll('.cskilltoken')];
      return {
        focused: skills.indexOf(document.activeElement),
        prompt: prompt.scrollTop,
        layer: layer.scrollTop,
      };
    })()`),
      { focused: 1, prompt: before.prompt, layer: before.prompt },
    );
  } finally {
    await browser.close();
  }
});

test('the wheel scrolls the textarea through a visible skill control', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 340, height: 720 });
    await page.setContent(pageHtml());
    const payload = renderPayload();
    const base = ((payload.usage as Record<string, unknown>).composer ?? {}) as Record<string, unknown>;
    await post(page, {
      type: 'usage',
      usage: usageWith(payload, {
        ...base,
        agent: 'codex',
        commands: [
          {
            kind: 'skill',
            command: 'land',
            prefix: '/',
            label: '/land',
            hint: '',
            description: 'Land one reviewed change',
            name: '/land. Land one reviewed change',
            completion: '/land ',
          },
        ],
      }),
    });
    const prompt = page.locator('#prompt');
    await prompt.fill(
      ['/land starts here', ...Array.from({ length: 24 }, (_, at) => `line ${at}`), '/land ends here'].join('\n'),
    );
    await page.evaluate(`document.body.style.minHeight = '2000px'`);
    await page.evaluate(`window.__composerWheels = []; document.addEventListener('wheel', (event) => {
      window.__composerWheels.push({
        prevented: event.defaultPrevented,
        target: event.target.id,
        ctrlKey: event.ctrlKey,
        deltaY: event.deltaY,
      });
    })`);
    const wheel = async (deltaY: number) => {
      const count = await page.evaluate<number>('window.__composerWheels.length');
      await page.mouse.wheel(0, deltaY);
      await page.waitForFunction(`window.__composerWheels.length > ${count}`);
    };
    await prompt.evaluate((node: HTMLTextAreaElement) => {
      node.setSelectionRange(0, 5);
      node.scrollTop = 0;
      node.dispatchEvent(new Event('scroll'));
    });
    await page.waitForFunction(`document.getElementById('prompt').scrollTop === 0
      && document.querySelector('.cskilllayer').scrollTop === 0`);
    await moveTo(page, page.locator('.cskilltoken').first());
    const beforeSkillWheel = await prompt.evaluate((node: HTMLTextAreaElement) => node.scrollTop);
    await wheel(7);
    await page.waitForFunction(`document.getElementById('prompt').scrollTop > ${beforeSkillWheel}
      && document.querySelector('.cskilllayer').scrollTop === document.getElementById('prompt').scrollTop`);
    const scroll = (await page.evaluate(`(() => ({
      prompt: document.getElementById('prompt').scrollTop,
      layer: document.querySelector('.cskilllayer').scrollTop,
    }))()`)) as { prompt: number; layer: number };
    assert.ok(scroll.prompt > beforeSkillWheel, 'wheel input over the skill did not scroll the textarea');
    assert.equal(scroll.layer, scroll.prompt);
    assert.deepEqual(
      await prompt.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd]),
      [0, 5],
      'wheel input over highlighted text changed its selection',
    );
    assert.deepEqual(
      await page.evaluate(`({
      prevented: window.__composerWheels.at(-1).prevented,
      ctrlKey: window.__composerWheels.at(-1).ctrlKey,
      deltaY: window.__composerWheels.at(-1).deltaY,
    })`),
      { prevented: false, ctrlKey: false, deltaY: 7 },
      'textarea wheel scrolling replaced the browser default',
    );

    await prompt.evaluate((node: HTMLTextAreaElement) => {
      node.scrollTop = node.scrollHeight;
      node.dispatchEvent(new Event('scroll'));
    });
    await moveTo(page, prompt, 0.9);
    const pageBefore = (await page.evaluate(`window.scrollY`)) as number;
    await wheel(120);
    await wheel(120);
    await page.waitForFunction((before) => window.scrollY > before, pageBefore);
    await page.evaluate(SETTLED);
    const pageAfter = (await page.evaluate(`window.scrollY`)) as number;
    assert.ok(pageAfter > pageBefore, 'wheel input at the textarea boundary did not continue through the page');
    assert.equal(
      await page.evaluate(`window.__composerWheels.at(-1).prevented`),
      false,
      'boundary wheel propagation replaced the browser default',
    );
    assert.equal(
      await page.evaluate(`window.__composerWheels.at(-1).target`),
      'prompt',
      'boundary wheel input bypassed the textarea event path',
    );

    await prompt.fill(Array.from({ length: 26 }, (_, at) => `plain line ${at}`).join('\n'));
    await prompt.evaluate((node: HTMLTextAreaElement) => {
      node.scrollTop = 0;
    });
    await moveTo(page, prompt);
    await wheel(7);
    assert.equal(
      await page.evaluate(`window.__composerWheels.at(-1).prevented`),
      false,
      'a prompt without skills replaced native wheel scrolling',
    );
    assert.equal(
      await page.evaluate(`window.__composerWheels.at(-1).target`),
      'prompt',
      'plain-text wheel input bypassed the textarea event path',
    );

    await prompt.evaluate((node: HTMLTextAreaElement) => {
      node.scrollTop = node.scrollHeight;
    });
    await page.evaluate(`window.scrollTo(0, 0)`);
    await moveTo(page, page.locator('.cinput'), 0.98);
    await wheel(40);
    await wheel(40);
    await page.waitForFunction(`window.scrollY > 0`);
    await page.evaluate(SETTLED);
    const scrolledY = (await page.evaluate(`window.scrollY`)) as number;
    assert.ok(scrolledY > 0, 'wheel input on the Composer surface did not scroll its parent page');

    await prompt.fill(
      ['/land starts here', ...Array.from({ length: 24 }, (_, at) => `line ${at}`), '/land ends here'].join('\n'),
    );
    await prompt.evaluate((node: HTMLTextAreaElement) => {
      node.scrollTop = 20;
    });
    await moveTo(page, page.locator('.cskilltoken').first());
    const beforeModified = await prompt.evaluate((node: HTMLTextAreaElement) => node.scrollTop);
    await page.keyboard.down('Control');
    await wheel(120);
    await page.keyboard.up('Control');
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await page.evaluate(`({
      prevented: window.__composerWheels.at(-1).prevented,
      ctrlKey: window.__composerWheels.at(-1).ctrlKey,
      deltaY: window.__composerWheels.at(-1).deltaY,
    })`),
      { prevented: false, ctrlKey: true, deltaY: 120 },
      'Ctrl-wheel lost its browser meaning over highlighted text',
    );
    assert.equal(
      await prompt.evaluate((node: HTMLTextAreaElement) => node.scrollTop),
      beforeModified,
      'Ctrl-wheel scrolled the Composer text instead of retaining its browser meaning',
    );
  } finally {
    await browser.close();
  }
});

test(
  'a pinned skill detail follows textarea scrolling and waits while its mark is clipped',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
      return;
    }
    try {
      const page = await browser.newPage();
      await page.setViewportSize({ width: 340, height: 720 });
      await page.setContent(pageHtml());
      const payload = renderPayload();
      const base = ((payload.usage as Record<string, unknown>).composer ?? {}) as Record<string, unknown>;
      await post(page, {
        type: 'usage',
        usage: usageWith(payload, {
          ...base,
          agent: 'codex',
          commands: [
            {
              kind: 'skill',
              command: 'land',
              prefix: '/',
              label: '/land',
              hint: '',
              description: 'Land one reviewed change',
              name: '/land. Land one reviewed change',
              completion: '/land ',
            },
          ],
        }),
      });
      const prompt = page.locator('#prompt');
      await prompt.fill(['/land starts here', ...Array.from({ length: 24 }, (_, at) => `line ${at}`)].join('\n'));
      const skill = page.locator('.cskilltoken');
      await prompt.evaluate((node: HTMLTextAreaElement) => {
        node.scrollTop = 0;
        node.dispatchEvent(new Event('scroll'));
      });
      const point = await moveTo(page, skill);
      await page.mouse.click(point.x, point.y);
      await page.evaluate(SETTLED);
      assert.equal(await skill.getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#chippop').isVisible(), true);

      await prompt.evaluate((node: HTMLTextAreaElement) => {
        node.scrollTop = node.scrollHeight;
        node.dispatchEvent(new Event('scroll'));
      });
      assert.equal(await page.locator('#chippop').isVisible(), false, 'a clipped skill left its body popover behind');
      assert.equal(
        await skill.getAttribute('aria-pressed'),
        'true',
        'scrolling away discarded the pinned skill identity',
      );

      await page.keyboard.press('Escape');
      assert.equal(
        await skill.getAttribute('aria-pressed'),
        'false',
        'Escape did not close a pinned detail while its mark was clipped',
      );
      assert.equal(
        await page.evaluate(`document.activeElement?.id`),
        'prompt',
        'Escape from a clipped pointer-opened skill did not return to the textarea',
      );

      await prompt.evaluate((node: HTMLTextAreaElement) => {
        node.scrollTop = 0;
        node.dispatchEvent(new Event('scroll'));
      });
      assert.equal(
        await page.locator('#chippop').isVisible(),
        true,
        'a returned mark under the stationary pointer did not restore its hover preview',
      );
      assert.equal(
        await skill.getAttribute('aria-pressed'),
        'false',
        'a returned hover preview restored the closed pin',
      );
      const returned = await moveTo(page, skill);
      await page.mouse.click(returned.x, returned.y);
      assert.equal(await page.locator('#chippop').isVisible(), true, 'the returned skill did not open again');
      assert.equal(await skill.getAttribute('aria-pressed'), 'true');
      const placement = (await page.evaluate(`(() => {
      const skill = document.querySelector('.cskilltoken').getBoundingClientRect();
      const pop = document.getElementById('chippop').getBoundingClientRect();
      return { gap: Math.min(Math.abs(pop.top - skill.bottom), Math.abs(skill.top - pop.bottom)) };
    })()`)) as { gap: number };
      assert.ok(placement.gap <= 8, `the returned popover is ${placement.gap}px from its skill`);
    } finally {
      await browser.close();
    }
  },
);

test('a hovered skill detail returns when its mark scrolls back into view', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 340, height: 720 });
    await page.setContent(pageHtml());
    const payload = renderPayload();
    const base = ((payload.usage as Record<string, unknown>).composer ?? {}) as Record<string, unknown>;
    await post(page, {
      type: 'usage',
      usage: usageWith(payload, {
        ...base,
        agent: 'codex',
        commands: [
          {
            kind: 'skill',
            command: 'land',
            prefix: '/',
            label: '/land',
            hint: '',
            description: 'Land one reviewed change',
            name: '/land. Land one reviewed change',
            completion: '/land ',
          },
        ],
      }),
    });
    const prompt = page.locator('#prompt');
    await prompt.fill(['/land starts here', ...Array.from({ length: 24 }, (_, at) => `line ${at}`)].join('\n'));
    const skill = page.locator('.cskilltoken');
    await prompt.evaluate((node: HTMLTextAreaElement) => {
      node.scrollTop = 0;
      node.dispatchEvent(new Event('scroll'));
    });
    await moveTo(page, skill);
    assert.equal(await page.locator('#chippop').isVisible(), true);
    assert.equal(await skill.getAttribute('aria-pressed'), 'false');

    await prompt.evaluate((node: HTMLTextAreaElement) => {
      node.scrollTop = node.scrollHeight;
      node.dispatchEvent(new Event('scroll'));
    });
    assert.equal(await page.locator('#chippop').isVisible(), false, 'a clipped hovered skill left its detail behind');

    await prompt.evaluate((node: HTMLTextAreaElement) => {
      node.scrollTop = 0;
      node.dispatchEvent(new Event('scroll'));
    });
    assert.equal(
      await page.locator('#chippop').isVisible(),
      true,
      'the hovered detail did not return until the pointer left and entered again',
    );
    assert.equal(await skill.getAttribute('aria-pressed'), 'false');
  } finally {
    await browser.close();
  }
});

test('layout changes refresh the skill under a stationary pointer', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 340, height: 720 });
    await page.setContent(pageHtml());
    const payload = renderPayload();
    const base = ((payload.usage as Record<string, unknown>).composer ?? {}) as Record<string, unknown>;
    await post(page, {
      type: 'usage',
      usage: usageWith(payload, {
        ...base,
        agent: 'codex',
        commands: [
          {
            kind: 'skill',
            command: 'land',
            prefix: '/',
            label: '/land',
            hint: '',
            description: 'Land the change',
            name: '/land. Land the change',
            completion: '/land ',
          },
          {
            kind: 'skill',
            command: 'audit',
            prefix: '/',
            label: '/audit',
            hint: '',
            description: 'Audit the repository',
            name: '/audit. Audit the repository',
            completion: '/audit ',
          },
        ],
      }),
    });
    const prompt = page.locator('#prompt');
    await prompt.fill(
      [
        '/land first',
        ...Array.from({ length: 8 }, (_, at) => `line ${at}`),
        '/audit last',
        ...Array.from({ length: 10 }, (_, at) => `tail ${at}`),
      ].join('\n'),
    );
    const land = page.locator('[data-skill="land"]');
    await prompt.evaluate((node: HTMLTextAreaElement) => {
      node.scrollTop = 0;
      node.dispatchEvent(new Event('scroll'));
    });
    const point = await moveTo(page, land);
    assert.equal(await land.evaluate((node) => node.classList.contains('is-hovered')), true);

    await prompt.evaluate((node: HTMLTextAreaElement, y: number) => {
      const audit = document.querySelector('[data-skill="audit"]') as HTMLElement;
      const rect = audit.getBoundingClientRect();
      node.scrollTop += rect.top + rect.height / 2 - y;
      node.dispatchEvent(new Event('scroll'));
    }, point.y);
    assert.equal(
      await page.locator('[data-skill="audit"]').evaluate((node) => node.classList.contains('is-hovered')),
      true,
      'scrolling a different mark under the pointer kept the old hover target',
    );
    assert.match((await page.locator('#chippop').textContent()) ?? '', /Audit the repository/);

    await page.evaluate(`window.dispatchEvent(new Event('resize'))`);
    assert.equal(
      await prompt.evaluate((node) => node.classList.contains('is-over-skill')),
      true,
      'window layout dropped the stationary pointer target',
    );
    await prompt.evaluate((node: HTMLTextAreaElement) => {
      node.scrollTop = node.scrollHeight;
      node.dispatchEvent(new Event('scroll'));
    });
    assert.equal(
      await prompt.evaluate((node) => node.classList.contains('is-over-skill')),
      false,
      'scrolling every mark away kept the pointer cursor',
    );
  } finally {
    await browser.close();
  }
});

test('the skill layer wraps inside the textarea scrollbar', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 340, height: 720 });
    await page.setContent(pageHtml());
    const payload = renderPayload();
    const base = ((payload.usage as Record<string, unknown>).composer ?? {}) as Record<string, unknown>;
    await post(page, {
      type: 'usage',
      usage: usageWith(payload, {
        ...base,
        agent: 'codex',
        commands: [
          {
            kind: 'skill',
            command: 'land',
            prefix: '/',
            label: '/land',
            hint: '',
            description: 'Land one reviewed change',
            name: '/land. Land one reviewed change',
            completion: '/land ',
          },
        ],
      }),
    });
    const prompt = page.locator('#prompt');
    await prompt.evaluate((node: HTMLTextAreaElement) => {
      node.style.scrollbarGutter = 'stable';
    });
    await prompt.fill(
      `${Array.from({ length: 18 }, (_, at) => `wrapped words fill the textarea before /land on row ${at}`).join(
        '\n',
      )}\n`,
    );
    const sizes = (await page.evaluate(`(() => {
      const prompt = document.getElementById('prompt');
      const layer = document.querySelector('.cskilllayer');
      return {
        promptWidth: prompt.clientWidth,
        layerWidth: layer.clientWidth,
        promptScroll: prompt.scrollHeight,
        layerScroll: layer.scrollHeight,
        hasScrollbar: prompt.scrollHeight > prompt.clientHeight,
      };
    })()`)) as {
      promptWidth: number;
      layerWidth: number;
      promptScroll: number;
      layerScroll: number;
      hasScrollbar: boolean;
    };
    assert.equal(sizes.hasScrollbar, true, 'the textarea has no scrollbar, so this measures nothing');
    assert.equal(
      sizes.layerWidth,
      sizes.promptWidth,
      `the skill layer is ${sizes.layerWidth}px wide over a ${sizes.promptWidth}px textarea viewport`,
    );
    assert.ok(
      Math.abs(sizes.layerScroll - sizes.promptScroll) <= 1,
      `wrapped text is ${sizes.layerScroll}px tall in the skill layer and ${sizes.promptScroll}px in the textarea`,
    );
    assert.equal(sizes.layerScroll, sizes.promptScroll, 'a final empty textarea line is missing from the skill layer');
  } finally {
    await browser.close();
  }
});

test('long skill controls wrap on the same fragments as plain textarea text', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 340, height: 720 });
    await page.setContent(pageHtml());
    const payload = renderPayload();
    const base = ((payload.usage as Record<string, unknown>).composer ?? {}) as Record<string, unknown>;
    for (const command of [
      'extraordinarylongskillnamethatmustwrapacrosstwoormoretextarealines',
      'long-hyphenated-skill-name-that-must-wrap-across-two-or-more-textarea-lines',
    ]) {
      const label = `/${command}`;
      await post(page, {
        type: 'usage',
        usage: usageWith(payload, {
          ...base,
          agent: 'codex',
          commands: [
            {
              kind: 'skill',
              command,
              prefix: '/',
              label,
              hint: '',
              description: 'Measure wrapped token fragments',
              name: `${label}. Measure wrapped token fragments`,
              completion: `${label} `,
            },
          ],
        }),
      });
      await page.locator('#prompt').fill(`Words before ${label} words after.`);
      const fragments = (await page.evaluate(`(() => {
        const layer = document.querySelector('.cskilllayer');
        const skill = layer.querySelector('.cskilltoken');
        const mirror = layer.cloneNode(true);
        mirror.setAttribute('aria-hidden', 'true');
        mirror.style.visibility = 'hidden';
        const plain = document.createElement('span');
        plain.className = 'plain-skill-measure';
        plain.textContent = skill.textContent;
        mirror.querySelector('.cskilltoken').replaceWith(plain);
        layer.parentElement.append(mirror);
        const relative = (node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          const origin = layer.getBoundingClientRect();
          return [...range.getClientRects()].map((rect) => ({
            left: Math.round((rect.left - origin.left) * 10) / 10,
            top: Math.round((rect.top - origin.top) * 10) / 10,
            right: Math.round((rect.right - origin.left) * 10) / 10,
            bottom: Math.round((rect.bottom - origin.top) * 10) / 10,
          }));
        };
        const result = { control: relative(skill), plain: relative(plain) };
        mirror.remove();
        return result;
      })()`)) as {
        control: Array<{ left: number; top: number; right: number; bottom: number }>;
        plain: Array<{ left: number; top: number; right: number; bottom: number }>;
      };
      assert.ok(fragments.plain.length > 1, `${label} did not wrap, so this measures nothing`);
      assert.deepEqual(
        fragments.control,
        fragments.plain,
        `${label} control fragments do not follow the textarea text`,
      );
    }
  } finally {
    await browser.close();
  }
});

test('a rail resize refreshes clipped skill Tab stops', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 780, height: 720 });
    await page.setContent(pageHtml());
    const payload = renderPayload();
    const base = ((payload.usage as Record<string, unknown>).composer ?? {}) as Record<string, unknown>;
    await post(page, {
      type: 'usage',
      usage: usageWith(payload, {
        ...base,
        agent: 'codex',
        commands: [
          {
            kind: 'skill',
            command: 'land',
            prefix: '/',
            label: '/land',
            hint: '',
            description: 'Land one reviewed change',
            name: '/land. Land one reviewed change',
            completion: '/land ',
          },
        ],
      }),
    });
    const prompt = page.locator('#prompt');
    await prompt.fill(`${'words before the skill '.repeat(90)}/land\n${'later line\n'.repeat(12)}`);
    const before = (await page.evaluate(`(() => {
      const prompt = document.getElementById('prompt');
      const layer = document.querySelector('.cskilllayer');
      const skill = layer.querySelector('.cskilltoken');
      const viewport = layer.getBoundingClientRect();
      const rect = skill.getBoundingClientRect();
      prompt.scrollTop += rect.bottom - viewport.bottom + 2;
      prompt.dispatchEvent(new Event('scroll'));
      return { tabIndex: skill.tabIndex, scrollTop: prompt.scrollTop };
    })()`)) as { tabIndex: number; scrollTop: number };
    assert.equal(before.tabIndex, 0, 'the skill is not reachable before the rail resize');
    assert.ok(before.scrollTop > 0, 'the textarea did not scroll, so this measures nothing');
    const skill = page.locator('.cskilltoken');
    await skill.focus();
    await skill.press('Enter');
    assert.equal(await skill.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#chippop').isVisible(), true);

    const sash = (await page.evaluate(`(() => {
      const box = document.getElementById('railsash').getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`)) as { x: number; y: number };
    await page.locator('#railsash').evaluate((node: HTMLElement, point) => {
      node.setPointerCapture = () => undefined;
      node.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerId: 51,
          clientX: point.x,
          clientY: point.y,
          bubbles: false,
          cancelable: true,
        }),
      );
      node.dispatchEvent(
        new PointerEvent('pointermove', {
          pointerId: 51,
          clientX: point.x + 120,
          clientY: point.y,
          bubbles: false,
        }),
      );
      node.dispatchEvent(
        new PointerEvent('pointerup', {
          pointerId: 51,
          clientX: point.x + 120,
          clientY: point.y,
          bubbles: false,
        }),
      );
    }, sash);
    const after = (await page.evaluate(`(() => {
      const layer = document.querySelector('.cskilllayer');
      const skill = layer.querySelector('.cskilltoken');
      const viewport = layer.getBoundingClientRect();
      const visible = [...skill.getClientRects()].some((rect) => (
        rect.bottom > viewport.top && rect.top < viewport.bottom
        && rect.right > viewport.left && rect.left < viewport.right
      ));
      return { visible, tabIndex: skill.tabIndex };
    })()`)) as { visible: boolean; tabIndex: number };
    assert.equal(after.visible, false, 'the rail resize did not clip the skill, so this measures nothing');
    assert.equal(after.tabIndex, -1, 'the clipped skill remains in the Tab order after the rail resize');
    assert.equal(await page.locator('#chippop').isVisible(), false, 'the clipped skill left its body popover behind');
    assert.equal(
      await skill.getAttribute('aria-pressed'),
      'true',
      'the rail resize discarded the pinned skill identity',
    );
  } finally {
    await browser.close();
  }
});

test('composer height changes refresh visible skill Tab stops', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 720, height: 720 });
    await page.setContent(pageHtml());
    const payload = renderPayload();
    const base = ((payload.usage as Record<string, unknown>).composer ?? {}) as Record<string, unknown>;
    await post(page, {
      type: 'usage',
      usage: usageWith(payload, {
        ...base,
        agent: 'codex',
        commands: [
          {
            kind: 'skill',
            command: 'land',
            prefix: '/',
            label: '/land',
            hint: '',
            description: 'Land one reviewed change',
            name: '/land. Land one reviewed change',
            completion: '/land ',
          },
        ],
      }),
    });
    const prompt = page.locator('#prompt');
    const sash = page.locator('#footsash');
    const skillState = async () =>
      (await page.evaluate(`(() => {
      const layer = document.querySelector('.cskilllayer');
      const viewport = layer.getBoundingClientRect();
      return [...layer.querySelectorAll('.cskilltoken')].map((skill) => ({
        tabIndex: skill.tabIndex,
        visible: [...skill.getClientRects()].some((rect) => (
          rect.bottom > viewport.top && rect.top < viewport.bottom
          && rect.right > viewport.left && rect.left < viewport.right
        )),
      }));
    })()`)) as Array<{ tabIndex: number; visible: boolean }>;
    await prompt.fill(`/land\n${'ordinary line\n'.repeat(18)}/land`);
    const before = await skillState();
    assert.deepEqual(
      before,
      [
        { tabIndex: -1, visible: false },
        { tabIndex: 0, visible: true },
      ],
      'the fixture did not begin with one reachable and one clipped skill',
    );

    await sash.press('End');
    const raised = await skillState();
    assert.deepEqual(
      raised,
      [
        { tabIndex: 0, visible: true },
        { tabIndex: 0, visible: true },
      ],
      'raising the Composer left the newly visible skill outside the Tab order',
    );

    await sash.press('Home');
    const lowered = await skillState();
    assert.deepEqual(
      lowered,
      [
        { tabIndex: 0, visible: true },
        { tabIndex: -1, visible: false },
      ],
      'lowering the Composer left the clipped skill in the Tab order',
    );
  } finally {
    await browser.close();
  }
});

test(
  'a Codex MCP skill and a Codex command entry both stay plain outside the skill catalog',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
      return;
    }
    try {
      const page = await browser.newPage();
      await page.setContent(pageHtml());
      const payload = renderPayload();
      const codex = composerView(
        {
          ...COMPOSER,
          agent: 'codex',
          commands: [
            { kind: 'skill', name: 'land', description: 'Land one reviewed change', argumentHint: '' },
            { kind: 'skill', name: 'mcp', description: 'Inspect MCP definitions', argumentHint: '' },
            { kind: 'command', name: 'context', description: 'Show context use', argumentHint: '' },
          ],
        },
        Date.now(),
      );
      assert.ok(codex);
      await post(page, {
        type: 'usage',
        usage: usageWith(payload, codex),
      });
      await page.locator('#prompt').fill('Use /land, then /mcp, then /context.');
      const skills = page.locator('.cskilltoken');
      assert.equal(await skills.count(), 1);
      assert.equal(await skills.textContent(), '/land');
      assert.match((await skills.getAttribute('aria-label')) ?? '', /^Skill \/land/);
      assert.equal(await page.locator('[data-skill="mcp"]').count(), 0);
      assert.equal(
        await page.locator('[data-skill="context"]').count(),
        0,
        'a Codex command entry outside the skill catalog stayed plain',
      );
    } finally {
      await browser.close();
    }
  },
);

test(
  'Claude commands are inspectable like Codex skills, except native commands and panel controls',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
      return;
    }
    try {
      const page = await browser.newPage();
      await page.setContent(pageHtml());
      const payload = renderPayload();
      const claude = composerView(
        {
          ...COMPOSER,
          agent: 'claude',
          commands: [
            {
              kind: 'command',
              name: 'land',
              description: 'Land one reviewed change (user)',
              argumentHint: '',
            },
            { kind: 'command', name: 'context', description: 'Show context use', argumentHint: '' },
            { kind: 'command', name: 'compact', description: 'Free up context', argumentHint: '<instructions>' },
            { kind: 'command', name: 'model', description: 'Set the Claude model', argumentHint: '<model>' },
            { kind: 'command', name: 'mcp', description: 'View MCP server status', argumentHint: '' },
          ],
        },
        Date.now(),
      );
      assert.ok(claude);
      await post(page, { type: 'usage', usage: usageWith(payload, claude) });
      const prompt = page.locator('#prompt');
      await prompt.fill('Use /land, then /context, /compact, /model, or /mcp.');
      const skills = page.locator('.cskilltoken');
      assert.deepEqual(
        await skills.allTextContents(),
        ['/land', '/context'],
        'with no skill list ever reported for this working directory, every Claude command outside the ' +
          'native-command and panel-control exclusions got the skill mark, including a built-in ' +
          'that is not a real skill',
      );
      assert.equal(await page.locator('[data-skill="compact"]').count(), 0);
      assert.equal(await page.locator('[data-skill="model"]').count(), 0);
      assert.equal(await page.locator('[data-skill="mcp"]').count(), 0);

      const skill = skills.first();
      await moveTo(page, skill);
      assert.equal(await page.locator('#chippop').isVisible(), true, 'the Claude command got no hover preview');
      assert.match((await page.locator('#chippop').textContent()) ?? '', /\/land.*Land one reviewed/);
      assert.doesNotMatch(
        (await page.locator('#chippop').textContent()) ?? '',
        /File/,
        'a Claude command has no definition path and must not show one',
      );

      const point = await moveTo(page, skill);
      await page.mouse.click(point.x, point.y);
      await page.evaluate(SETTLED);
      assert.equal(await skill.getAttribute('aria-pressed'), 'true', 'a Claude command did not open a pinned popover');
      assert.doesNotMatch(
        (await page.locator('#chippop').textContent()) ?? '',
        /File|SKILL\.md/,
        'the pinned Claude popover must not show a path',
      );
      assert.doesNotMatch(
        (await skill.getAttribute('aria-label')) ?? '',
        /File|SKILL\.md/,
        'the Claude mark accessible name must carry no file part',
      );

      await prompt.fill('/la');
      await prompt.press('Enter');
      assert.equal(await prompt.inputValue(), '/land ');
      assert.deepEqual(
        await page.locator('.cskilltoken').allTextContents(),
        ['/land'],
        'a Claude command inserted through the completion menu did not get the skill mark',
      );

      // The working-directory skill list limits highlights to its names.
      // Updating the list must preserve prompt text, caret, and focus.
      await prompt.fill('Use /land, then /context, /compact, /model, or /mcp.');
      await prompt.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(3, 3));
      const withList = composerView(
        {
          ...COMPOSER,
          agent: 'claude',
          claudeSkills: ['land', 'compact', 'model', 'mcp'],
          commands: [
            {
              kind: 'command',
              name: 'land',
              description: 'Land one reviewed change (user)',
              argumentHint: '',
            },
            { kind: 'command', name: 'context', description: 'Show context use', argumentHint: '' },
            { kind: 'command', name: 'compact', description: 'Free up context', argumentHint: '<instructions>' },
            { kind: 'command', name: 'model', description: 'Set the Claude model', argumentHint: '<model>' },
            { kind: 'command', name: 'mcp', description: 'View MCP server status', argumentHint: '' },
          ],
        },
        Date.now(),
      );
      assert.ok(withList);
      await post(page, { type: 'usage', usage: usageWith(payload, withList) });
      assert.deepEqual(
        await page.locator('.cskilltoken').allTextContents(),
        ['/land'],
        'a reported skill list narrowed the highlight to the one name it carries',
      );
      assert.equal(
        await page.locator('[data-skill="context"]').count(),
        0,
        'a Claude command outside a reported skill list lost its highlight once the list arrived',
      );
      // Native commands and panel controls stay unmarked even when the skill list includes them.
      assert.equal(
        await page.locator('[data-skill="compact"]').count(),
        0,
        'a skill list naming compact drew the highlight compact never gets',
      );
      assert.equal(
        await page.locator('[data-skill="model"]').count(),
        0,
        'a skill list naming model drew the highlight model never gets',
      );
      assert.equal(
        await page.locator('[data-skill="mcp"]').count(),
        0,
        'a skill list naming mcp drew the highlight a panel control never gets',
      );
      assert.equal(
        await prompt.inputValue(),
        'Use /land, then /context, /compact, /model, or /mcp.',
        'the redraw did not change the typed text',
      );
      assert.equal(
        await prompt.evaluate((el) => (el as HTMLTextAreaElement).selectionStart),
        3,
        'the redraw did not move the caret',
      );
      assert.equal(
        await page.evaluate('document.activeElement?.id'),
        'prompt',
        'the redraw did not move focus off the Composer text field',
      );
    } finally {
      await browser.close();
    }
  },
);

test(
  'catalog refresh returns focus to the Composer only when its focused skill disappears',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
      return;
    }
    try {
      const page = await browser.newPage();
      await page.setContent(pageHtml());
      const payload = renderPayload();
      const base = ((payload.usage as Record<string, unknown>).composer ?? {}) as Record<string, unknown>;
      const skill = {
        kind: 'skill',
        command: 'land',
        prefix: '/',
        label: '/land',
        hint: '',
        description: 'Land one reviewed change',
        name: '/land. Land one reviewed change',
        completion: '/land ',
      };
      await post(page, {
        type: 'usage',
        usage: usageWith(payload, { ...base, agent: 'codex', commands: [skill] }),
      });
      const prompt = page.locator('#prompt');
      await prompt.fill('Use /land.');
      await page.locator('.cskilltoken').focus();
      await post(page, {
        type: 'usage',
        usage: usageWith(payload, { ...base, agent: 'codex', commands: [{ ...skill }] }),
      });
      assert.equal(
        await page.evaluate(`document.activeElement?.classList.contains('cskilltoken')`),
        true,
        'an equivalent catalog entry replaced the focused skill mark',
      );

      await post(page, {
        type: 'usage',
        usage: usageWith(payload, { ...base, agent: 'codex', commands: [] }),
      });
      assert.equal(
        await page.evaluate(`document.activeElement && document.activeElement.id`),
        'prompt',
        'removing the focused skill mark left focus on the document body',
      );
    } finally {
      await browser.close();
    }
  },
);

// VS Code replays webview focus after a click activates its window.
// The prompt text field must retain the click's selection within the activation window.
test('one click into the Composer survives the host window activation', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(themed(pageHtml()));
    await post(page, renderPayload());
    const prompt = page.locator('#prompt');
    await prompt.fill('first click stays here');
    const time = await page.evaluate(() => Date.now());
    await page.clock.setFixedTime(time);
    await page.clock.pauseAt(time);
    await page.clock.setSystemTime(time);
    await prompt.click();
    await prompt.evaluate((node: HTMLTextAreaElement) => {
      node.setSelectionRange(6, 11);
      window.dispatchEvent(new Event('blur'));
      document.body.tabIndex = -1;
      document.body.focus();
    });
    await page.clock.fastForward(20);
    assert.deepEqual(
      await page.evaluate(`({
      focus: document.activeElement && document.activeElement.id,
      start: document.getElementById('prompt').selectionStart,
      end: document.getElementById('prompt').selectionEnd,
    })`),
      { focus: 'prompt', start: 6, end: 11 },
    );
    await prompt.click();
    await page.clock.fastForward(151);
    await prompt.evaluate((node: HTMLTextAreaElement) => {
      node.setSelectionRange(6, 11);
      window.dispatchEvent(new Event('blur'));
      document.body.focus();
    });
    await page.clock.fastForward(20);
    assert.deepEqual(
      await page.evaluate(`({
      focus: document.activeElement && document.activeElement.id,
      start: document.getElementById('prompt').selectionStart,
      end: document.getElementById('prompt').selectionEnd,
    })`),
      { focus: '', start: 6, end: 11 },
      'an expired activation window pulled focus back into the Composer',
    );
  } finally {
    await browser.close();
  }
});

// Draft restoration must preserve newer local text in each session.
// Focus requests wait until their target session is visible.
test('draft revisions and session changes preserve the newest local text', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(pageHtml());
    const payload = renderPayload();
    await post(page, payload);
    const first = ((payload.usage as Record<string, unknown>).composer ?? {}) as Record<string, unknown>;
    await page.locator('#prompt').fill('send this');
    await page.locator('#prompt').press('Enter');
    const sent = (await page.evaluate(`window.__posted.filter((message) => message.type === 'sendPrompt').at(-1)`)) as {
      revision: number;
    };
    await page.locator('#prompt').fill('newer local text');
    await post(page, {
      type: 'restoreDraft',
      session: 's1',
      text: 'stale refused text',
      revision: sent.revision,
    });
    assert.equal(await page.locator('#prompt').inputValue(), 'newer local text');

    const second = { ...first, sessionId: 's2', draft: 'target draft', targetName: 'Codex parity sweep' };
    await page.locator('[data-control="session:s1"]').focus();
    await post(page, { type: 'focusComposer', session: 's2' });
    assert.notEqual(await page.evaluate(`document.activeElement && document.activeElement.id`), 'prompt');
    await post(page, { type: 'usage', usage: usageWith(payload, second) });
    assert.equal(await page.locator('#prompt').inputValue(), 'target draft');
    assert.equal(await page.evaluate(`document.activeElement && document.activeElement.id`), 'prompt');
    await page.locator('#prompt').fill('target local text');

    await post(page, { type: 'usage', usage: usageWith(payload, { ...first, draft: 'stale source text' }) });
    assert.equal(await page.locator('#prompt').inputValue(), 'newer local text');
    await post(page, { type: 'usage', usage: usageWith(payload, { ...second, draft: 'stale target text' }) });
    assert.equal(await page.locator('#prompt').inputValue(), 'target local text');

    const other = await browser.newPage();
    await other.setContent(pageHtml());
    const empty = renderPayload();
    await post(other, empty);
    const before = (await other.evaluate(`window.__posted.length`)) as number;
    const otherFirst = ((empty.usage as Record<string, unknown>).composer ?? {}) as Record<string, unknown>;
    await post(other, {
      type: 'usage',
      usage: usageWith(empty, { ...otherFirst, sessionId: 's2', draft: '' }),
    });
    const writes = (await other.evaluate(
      `window.__posted.slice(${before}).filter((message) => message.type === 'draft')`,
    )) as unknown[];
    assert.deepEqual(writes, [], 'an untouched second Panel view overwrote another view draft');
  } finally {
    await browser.close();
  }
});

test('adoption preserves a newer durable draft after normal navigation', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(pageHtml());
    const provisional = JSON.parse(
      JSON.stringify(renderPayload([], [LIVE_PRESS])).replaceAll(JSON.stringify('s1'), JSON.stringify('draft:s1')),
    ) as Record<string, unknown> & {
      sessions: Array<Record<string, unknown>>;
    };
    provisional.sessions = provisional.sessions.map((row) => ({
      ...row,
      shown: row.id === 'draft:s1',
    }));
    provisional.sessionAdoptions = [];
    await post(page, provisional);
    const prompt = page.locator('#prompt');
    await prompt.fill('provisional draft text');
    await prompt.type(' with several edits');

    const durable = renderPayload() as Record<string, unknown> & {
      sessions: Array<Record<string, unknown>>;
      usage: Record<string, unknown>;
    };
    durable.showing = 's2';
    durable.sessions = durable.sessions.map((row) => ({ ...row, shown: row.id === 's2' }));
    durable.usage = usageWith(
      durable,
      composerView(
        {
          ...COMPOSER,
          session: 's2',
          sessionId: 's2',
          draft: 'host destination draft',
        },
        Date.now(),
      ),
    );
    durable.sessionAdoptions = [];
    await post(page, durable);
    await prompt.fill('destination draft stays');

    await post(page, provisional);

    await prompt.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(0, 11));
    await page.evaluate(SETTLED);
    await prompt.evaluate((node: HTMLTextAreaElement) => {
      node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    await page.locator('#composer-collapse').focus();
    assert.equal(await page.locator('.cselectionlayer .cselected').textContent(), 'provisional');

    durable.sessionAdoptions = [{ provisional: 'draft:s1', durable: 's2' }];
    await post(page, durable);
    assert.equal(await prompt.inputValue(), 'destination draft stays');
    assert.equal(await page.locator('.cselectionlayer .cselected').count(), 0, 'the old draft stayed highlighted');
    await prompt.press('Control+z');
    assert.notEqual(
      await prompt.inputValue(),
      'destination draft stays',
      'navigation replaced the destination undo history with the provisional draft history',
    );
    await prompt.press('Control+Shift+z');
    assert.equal(await prompt.inputValue(), 'destination draft stays');
  } finally {
    await browser.close();
  }
});

test('a delayed refusal follows first-prompt adoption without replacing newer text', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(pageHtml());
    const provisionalId = 'draft:s1';
    const durableId = 'thread-one';
    const provisional = JSON.parse(
      JSON.stringify(renderPayload([], [LIVE_PRESS])).replaceAll(JSON.stringify('s1'), JSON.stringify(provisionalId)),
    ) as Record<string, unknown>;
    provisional.sessionAdoptions = [];
    await post(page, provisional);
    const prompt = page.locator('#prompt');
    await prompt.fill('restore this prompt');
    await prompt.press('Enter');
    const sent = (await page.evaluate(`window.__posted.filter((message) => message.type === 'sendPrompt').at(-1)`)) as {
      revision: number;
    };

    const durable = JSON.parse(
      JSON.stringify(renderPayload([], [LIVE_PRESS])).replaceAll(JSON.stringify('s1'), JSON.stringify(durableId)),
    ) as Record<string, unknown>;
    durable.sessionAdoptions = [{ provisional: provisionalId, durable: durableId }];
    await post(page, durable);
    await post(page, {
      type: 'restoreDraft',
      session: provisionalId,
      text: 'restore this prompt',
      revision: sent.revision,
    });
    assert.equal(await prompt.inputValue(), 'restore this prompt');

    await prompt.fill('newer durable edit');
    await post(page, {
      type: 'restoreDraft',
      session: provisionalId,
      text: 'stale refusal',
      revision: sent.revision,
    });
    assert.equal(await prompt.inputValue(), 'newer durable edit');
  } finally {
    await browser.close();
  }
});

test(
  'a delayed queued edit follows first-prompt adoption through the next usage update',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
      return;
    }
    try {
      const page = await browser.newPage();
      await page.setContent(pageHtml());
      const provisionalId = 'draft:s1';
      const durableId = 'thread-one';
      const provisional = JSON.parse(
        JSON.stringify(renderPayload([], [LIVE_PRESS])).replaceAll(JSON.stringify('s1'), JSON.stringify(provisionalId)),
      ) as Record<string, unknown>;
      provisional.sessionAdoptions = [];
      const waiting = {
        id: 'waiting',
        label: 'Queued prompt',
        text: 'queued text to send',
        long: false,
        openName: '',
        shutName: '',
        control: 'queued:waiting',
        dropName: '',
        dropControl: '',
        dropLabel: 'Drop',
        editName: 'Edit queued prompt',
        editControl: 'queue:waiting:edit',
        editLabel: 'Edit',
        copyText: 'queued text to send',
        copyName: '',
        copyControl: '',
        copyLabel: 'Copy',
        at: 1,
        relative: 'now',
        absolute: 'now',
        agent: 'Claude',
        headName: '',
        status: 'Waiting to send',
        reason: '',
        files: [],
      };
      (provisional as any).usage.composer.queue = [waiting];
      await post(page, provisional);
      await page.locator('[data-control="queue:waiting:edit"]').click();
      const request = (await page.evaluate(
        `window.__posted.filter((message) => message.type === 'editQueued').at(-1)`,
      )) as { revision: number };

      const durable = JSON.parse(
        JSON.stringify(renderPayload([], [LIVE_PRESS])).replaceAll(JSON.stringify('s1'), JSON.stringify(durableId)),
      ) as Record<string, unknown>;
      durable.sessionAdoptions = [{ provisional: provisionalId, durable: durableId }];
      await post(page, durable);
      await post(page, {
        type: 'takeQueuedDraft',
        session: provisionalId,
        text: waiting.text,
        revision: request.revision,
        value: waiting.id,
      });
      assert.equal(await page.locator('#prompt').inputValue(), 'queued text to send');
      assert.deepEqual(
        await page.evaluate(`window.__posted.filter((message) => message.type === 'acceptQueuedEdit').at(-1)`),
        {
          type: 'acceptQueuedEdit',
          value: waiting.id,
          session: durableId,
          revision: request.revision,
          currentRevision: request.revision + 1,
          accepted: true,
        },
        'the browser acknowledged the adopted edit under its provisional session',
      );

      await post(page, { type: 'usage', usage: durable.usage });
      const prompt = page.locator('#prompt');
      assert.equal(
        await prompt.inputValue(),
        'queued text to send',
        'durable usage restored the draft that preceded the delayed queued edit',
      );
      await prompt.press('Enter');
      const sent = (await page.evaluate(
        `window.__posted.filter((message) => message.type === 'sendPrompt').at(-1)`,
      )) as { session: string; text: string };
      assert.deepEqual(
        { session: sent.session, text: sent.text },
        {
          session: durableId,
          text: 'queued text to send',
        },
      );
    } finally {
      await browser.close();
    }
  },
);

test('a refused queued edit restores only the draft that the offer replaced', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no browser installed');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(themed(pageHtml()));
    const payload = renderPayload();
    const waiting = {
      id: 'q1',
      label: 'Queued prompt',
      text: 'waiting prompt',
      long: false,
      openName: '',
      shutName: '',
      control: 'queued:q1',
      dropName: '',
      dropControl: '',
      dropLabel: 'Drop',
      editName: 'Edit queued prompt',
      editControl: 'queue:q1:edit',
      editLabel: 'Edit',
      copyText: 'waiting prompt',
      copyName: '',
      copyControl: '',
      copyLabel: 'Copy',
      at: 1,
      relative: 'now',
      absolute: 'now',
      agent: 'Claude',
      headName: '',
      status: 'Waiting to send',
      reason: '',
      files: [],
    };
    (payload as any).usage.composer.queue = [waiting];
    await post(page, payload);
    await page.locator('#prompt').fill('draft before edit');
    await page.locator('[data-control="queue:q1:edit"]').click();
    const revision = (await page.evaluate(
      `window.__posted.filter((message) => message.type === 'editQueued').at(-1).revision`,
    )) as number;
    await post(page, {
      type: 'takeQueuedDraft',
      session: 's1',
      text: 'waiting prompt',
      revision,
      value: 'q1',
    });
    const accepted = (await page.evaluate(
      `window.__posted.filter((message) => message.type === 'acceptQueuedEdit').at(-1)`,
    )) as { currentRevision: number };
    await post(page, {
      type: 'restoreDraft',
      session: 's1',
      text: 'draft before edit',
      revision: accepted.currentRevision,
    });
    assert.equal(await page.locator('#prompt').inputValue(), 'draft before edit');

    await page.locator('#prompt').fill('newer reader text');
    await post(page, {
      type: 'restoreDraft',
      session: 's1',
      text: 'stale draft',
      revision: accepted.currentRevision,
    });
    assert.equal(
      await page.locator('#prompt').inputValue(),
      'newer reader text',
      'the rollback replaced text typed after the queued edit offer',
    );
  } finally {
    await browser.close();
  }
});

test('delayed first-prompt replies follow adoption after navigation', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    for (const reply of ['takeDraft', 'restoreDraft'] as const) {
      const page = await browser.newPage();
      await page.setContent(pageHtml());
      const provisionalId = 'draft:s1';
      const durableId = 'thread-one';
      const provisional = JSON.parse(
        JSON.stringify(renderPayload([], [LIVE_PRESS])).replaceAll(JSON.stringify('s1'), JSON.stringify(provisionalId)),
      ) as Record<string, unknown> & {
        sessions: Array<Record<string, unknown>>;
      };
      provisional.sessionAdoptions = [];
      await post(page, provisional);
      const prompt = page.locator('#prompt');
      await prompt.fill('first prompt');
      await prompt.press('Enter');
      const sent = (await page.evaluate(
        `window.__posted.filter((message) => message.type === 'sendPrompt').at(-1)`,
      )) as { revision: number };

      const other = renderPayload() as Record<string, unknown> & {
        sessions: Array<Record<string, unknown>>;
        usage: Record<string, unknown>;
      };
      other.showing = 's2';
      other.sessions = other.sessions.map((row) => ({ ...row, shown: row.id === 's2' }));
      other.usage = usageWith(
        other,
        composerView(
          {
            ...COMPOSER,
            session: 's2',
            sessionId: 's2',
            draft: 'other session draft',
          },
          Date.now(),
        ),
      );
      other.sessionAdoptions = [];
      await post(page, other);
      await prompt.fill('other session local text');

      const durable = JSON.parse(
        JSON.stringify(renderPayload([], [LIVE_PRESS])).replaceAll(JSON.stringify('s1'), JSON.stringify(durableId)),
      ) as Record<string, unknown> & {
        sessions: Array<Record<string, unknown>>;
        usage: Record<string, unknown>;
      };
      durable.showing = 's2';
      durable.sessions = durable.sessions.map((row) => ({ ...row, shown: row.id === 's2' }));
      durable.usage = other.usage;
      durable.sessionAdoptions = [{ provisional: provisionalId, durable: durableId }];
      await post(page, durable);
      assert.equal(
        await prompt.inputValue(),
        'other session local text',
        'background adoption replaced the selected session draft',
      );
      if (reply === 'takeDraft') {
        await post(page, { type: reply, session: provisionalId, text: 'queued text survives' });
      } else {
        await post(page, {
          type: reply,
          session: provisionalId,
          text: 'restored text survives',
          revision: sent.revision,
        });
      }

      const expected = reply === 'takeDraft' ? 'queued text survives' : 'restored text survives';
      const durableComposer = composerView(
        {
          ...COMPOSER,
          session: durableId,
          sessionId: durableId,
          draft: '',
        },
        Date.now(),
      )!;
      await post(page, { type: 'usage', usage: usageWith(durable, durableComposer) });
      const selected = { ...durable, showing: durableId, usage: usageWith(durable, durableComposer) };
      selected.sessions = selected.sessions.map((row) => ({ ...row, shown: row.id === durableId }));
      await post(page, selected);
      assert.equal(
        await prompt.inputValue(),
        expected,
        `${reply} text was replaced by the durable session's cached draft`,
      );
      await prompt.press('Enter');
      const resent = (await page.evaluate(
        `window.__posted.filter((message) => message.type === 'sendPrompt').at(-1)`,
      )) as { session: string; text: string };
      assert.deepEqual({ session: resent.session, text: resent.text }, { session: durableId, text: expected });
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

// Completion, undo, redo, queued restoration, and send end prompt recall.
// Shift+Enter inserts a line break into the text submitted by Enter.
test('history, undo, redo, queued restore, and send act on the live textarea', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(pageHtml());
    const payload = renderPayload();
    await post(page, payload);
    const prompt = page.locator('#prompt');
    await prompt.fill('/');
    assert.equal(await page.evaluate(`document.activeElement && document.activeElement.id`), 'prompt');
    assert.equal(await page.locator('#slashpop').getAttribute('hidden'), null);
    assert.equal(await prompt.getAttribute('aria-activedescendant'), 'slashrow0');
    await prompt.press('ArrowDown');
    assert.equal(await prompt.getAttribute('aria-activedescendant'), 'slashrow1');
    await page.locator('#slashpop').evaluate((node: HTMLElement) => {
      node.scrollTop = 9;
    });
    await page.evaluate(`window.__slashActive = document.querySelector('.slashrow.on')`);
    const composer = ((payload.usage as Record<string, unknown>).composer ?? {}) as Record<string, unknown>;
    await post(page, { type: 'usage', usage: usageWith(payload, composer) });
    assert.equal(await page.locator('#slashpop').evaluate((node: HTMLElement) => node.scrollTop), 9);
    assert.equal(await prompt.getAttribute('aria-activedescendant'), 'slashrow1');
    assert.equal(await page.evaluate(`window.__slashActive === document.querySelector('.slashrow.on')`), true);
    await prompt.press('Escape');
    assert.equal(await page.locator('#slashpop').getAttribute('hidden'), '');
    await post(page, { type: 'usage', usage: usageWith(payload, composer) });
    assert.equal(await page.locator('#slashpop').getAttribute('hidden'), '');
    await prompt.fill('plain');
    await prompt.fill('/co');
    await prompt.press('Enter');
    assert.notEqual(await prompt.inputValue(), '/co');
    assert.equal(await page.evaluate(`document.activeElement && document.activeElement.id`), 'prompt');

    await prompt.fill('/co');
    await prompt.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(0, 0));
    await prompt.press('ArrowUp');
    assert.equal(await prompt.inputValue(), 'Explain the snapshot store');
    assert.equal(
      await prompt.evaluate((node: HTMLTextAreaElement) => node.selectionStart),
      'Explain the snapshot store'.length,
    );
    await page.clock.fastForward(150);
    assert.equal(
      (await page.locator('#walk-announcer').textContent()) ?? '',
      'Earlier prompt 1 of 2. Explain the snapshot store',
    );
    const recalled = (await page.evaluate(`window.__posted.filter((message) => message.type === 'draft').at(-1)`)) as {
      text: string;
      keep: string;
    };
    assert.equal(recalled.keep, '/co');

    await prompt.press('ArrowUp');
    assert.equal(await prompt.inputValue(), 'Rename the note type to comment');
    await prompt.press('ArrowUp');
    assert.equal(await prompt.inputValue(), 'Rename the note type to comment');
    await prompt.press('ArrowDown');
    await prompt.press('ArrowDown');
    assert.equal(await prompt.inputValue(), '/co');
    assert.equal(await prompt.evaluate((node: HTMLTextAreaElement) => node.selectionStart), 0);

    await prompt.press('Escape');
    assert.equal(await page.locator('#slashpop').getAttribute('hidden'), '');
    await prompt.press('ArrowUp');
    await prompt.press('ArrowDown');
    assert.equal(await prompt.inputValue(), '/co');
    assert.equal(
      await page.locator('#slashpop').getAttribute('hidden'),
      '',
      'a command menu dismissed during a history walk reopened on the next step',
    );

    await page.evaluate(`(() => {
      const prompt = document.getElementById('prompt');
      prompt.setSelectionRange(0, 0);
      prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true, isComposing: true }));
    })()`);
    assert.equal(await prompt.inputValue(), '/co');

    await prompt.fill('first');
    await page.clock.fastForward(520);
    await prompt.fill('first second');
    await prompt.press('Control+z');
    assert.equal(await prompt.inputValue(), 'first');
    await prompt.press('Control+y');
    assert.equal(await prompt.inputValue(), 'first second');

    await prompt.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(0, 0));
    await prompt.press('ArrowUp');
    await prompt.press('Control+z');
    const undoneWalk = await prompt.inputValue();
    await prompt.press('ArrowUp');
    assert.equal(await prompt.inputValue(), undoneWalk, 'Up continued a stale walk after undo');
    await prompt.press('Control+y');
    const redoneWalk = await prompt.inputValue();
    await prompt.press('ArrowUp');
    assert.equal(await prompt.inputValue(), redoneWalk, 'Up continued a stale walk after redo');

    await prompt.fill('one\ntwo\nthree');
    await prompt.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(6, 6));
    await prompt.evaluate(`document.getElementById('prompt').dispatchEvent(new KeyboardEvent('keydown', {
      key: 'c', ctrlKey: true, bubbles: true, cancelable: true
    }))`);
    assert.deepEqual(
      await prompt.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd]),
      [4, 8],
    );
    await prompt.evaluate(`document.getElementById('prompt').dispatchEvent(new Event('copy', { bubbles: true }))`);
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await prompt.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd]),
      [6, 6],
    );

    await prompt.fill('completion stash');
    await prompt.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(0, 0));
    await prompt.press('ArrowUp');
    await prompt.evaluate((node: HTMLTextAreaElement) => {
      node.value = '/co';
      node.setSelectionRange(0, 0);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await prompt.press('Enter');
    const completedWalk = await prompt.inputValue();
    assert.match(completedWalk, /^\/(?:compact|commit) /, 'Enter did not complete the active command');
    await prompt.press('ArrowDown');
    assert.equal(await prompt.inputValue(), completedWalk, 'Down continued a stale walk after command completion');

    await prompt.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(0, 0));
    await prompt.press('ArrowUp');
    await post(page, { type: 'takeDraft', session: 's1', text: 'queued words' });
    assert.equal(await prompt.inputValue(), 'queued words');
    await prompt.press('ArrowDown');
    assert.equal(await prompt.inputValue(), 'queued words');

    await prompt.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(0, 0));
    await prompt.press('ArrowUp');
    await prompt.press('Enter');
    assert.equal(await prompt.inputValue(), '');
    await prompt.press('ArrowDown');
    assert.equal(await prompt.inputValue(), '', 'Down restored a stale walk after send');

    await prompt.fill('queued words');
    await prompt.press('Shift+Enter');
    assert.match(await prompt.inputValue(), /\n/);
    await prompt.press('Enter');
    assert.equal(await prompt.inputValue(), '');
    const sent = (await page.evaluate(`window.__posted.filter((message) => message.type === 'sendPrompt').at(-1)`)) as {
      text: string;
      session: string;
    };
    assert.equal(sent.session, 's1');
    assert.match(sent.text, /^queued words\n/);

    await prompt.fill('source draft');
    await prompt.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(0, 0));
    await prompt.press('ArrowUp');
    await post(page, {
      type: 'usage',
      usage: usageWith(payload, { ...composer, sessionId: 's2', draft: 'target draft' }),
    });
    assert.equal(await prompt.inputValue(), 'target draft');
    await prompt.press('ArrowDown');
    assert.equal(await prompt.inputValue(), 'target draft', 'Down restored the source session walk after a switch');
  } finally {
    await browser.close();
  }
});

test('a prompt-history walk suppresses local path completion', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(pageHtml());
    const payload = renderPayload();
    const composer = ((payload.usage as Record<string, unknown>).composer ?? {}) as Record<string, unknown>;
    await post(page, {
      type: 'usage',
      usage: usageWith(payload, { ...composer, history: ['./history/one', './history/two'] }),
    });
    const prompt = page.locator('#prompt');
    await prompt.fill('./stashed/');
    await page.clock.fastForward(500);
    const request = (await page.evaluate(
      `window.__posted.filter((message) => message.type === 'pathCompletion').at(-1)`,
    )) as { session: string; request: number; token: string; caret: number };
    await post(page, {
      type: 'pathCompletion',
      ...request,
      rows: [
        {
          name: 'child',
          directory: true,
          label: 'child/',
          accessibleName: 'Directory child/',
          completion: './stashed/child/',
        },
      ],
    });
    assert.equal(await prompt.getAttribute('aria-activedescendant'), 'slashrow0');
    await prompt.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(0, 0));
    await page.evaluate(`document.dispatchEvent(new Event('selectionchange'))`);
    await prompt.press('ArrowUp');
    assert.equal(await prompt.inputValue(), './history/one');
    await prompt.press('ArrowUp');
    assert.equal(await prompt.inputValue(), './history/two');
    await prompt.press('ArrowDown');
    assert.equal(await prompt.inputValue(), './history/one');
    await page.clock.fastForward(300);
    assert.equal(await page.locator('#slashpop').getAttribute('hidden'), '', 'a history walk left path rows open');
    assert.equal(
      await page.evaluate(`window.__posted.filter((message) => message.type === 'pathCompletion').length`),
      1,
      'a history walk requested a local path',
    );
    await prompt.press('ArrowDown');
    assert.equal(await prompt.inputValue(), './stashed/');
    await prompt.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(node.value.length, node.value.length));
    await page.evaluate(`document.dispatchEvent(new Event('selectionchange'))`);
    await page.clock.fastForward(300);
    assert.equal(
      await page.evaluate(`window.__posted.filter((message) => message.type === 'pathCompletion').length`),
      2,
      'returning to the draft kept path completion disabled',
    );
  } finally {
    await browser.close();
  }
});

test('a path completion is one undo step after typed input', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(pageHtml());
    await post(page, renderPayload());
    const prompt = page.locator('#prompt');
    await prompt.pressSequentially('./wor');
    await page.clock.fastForward(250);
    const request = (await page.evaluate(
      `window.__posted.filter((message) => message.type === 'pathCompletion').at(-1)`,
    )) as { session: string; request: number; token: string; caret: number };
    await post(page, {
      type: 'pathCompletion',
      ...request,
      rows: [
        {
          name: 'work',
          directory: false,
          label: 'work',
          accessibleName: 'File work',
          completion: './work',
        },
      ],
    });
    await prompt.press('Tab');
    assert.equal(await prompt.inputValue(), './work');
    await prompt.press('s');
    assert.equal(await prompt.inputValue(), './works');
    await prompt.press('Control+z');
    assert.equal(await prompt.inputValue(), './work');
    await prompt.press('Control+z');
    assert.equal(await prompt.inputValue(), './wor');
  } finally {
    await browser.close();
  }
});

test(
  'path completion accepts a matching local path without taking focus from the Composer',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
      return;
    }
    try {
      const page = await browser.newPage();
      await page.setContent(pageHtml());
      const payload = renderPayload();
      await post(page, payload);
      const prompt = page.locator('#prompt');
      await prompt.fill('~/Projects/wo');
      await page.clock.fastForward(500);
      const request = (await page.evaluate(
        `window.__posted.filter((message) => message.type === 'pathCompletion').at(-1)`,
      )) as { session: string; request: number; token: string; caret: number };
      assert.deepEqual({ session: request.session, token: request.token }, { session: 's1', token: '~/Projects/wo' });
      const row = {
        name: 'work',
        directory: true,
        label: 'work/',
        accessibleName: 'Directory work/',
        completion: '~/Projects/work/',
      };
      await post(page, { type: 'pathCompletion', ...request, rows: [row] });
      assert.equal(await prompt.getAttribute('aria-activedescendant'), 'slashrow0');
      assert.equal(await page.locator('#slashpop').getAttribute('aria-label'), 'Completions available for Claude');
      assert.equal(await page.locator('.slashrow').getAttribute('aria-label'), 'Directory work/');
      const requestsBeforeRefocus = await page.evaluate(
        `window.__posted.filter((message) => message.type === 'pathCompletion').length`,
      );
      await prompt.focus();
      await page.evaluate(`document.dispatchEvent(new Event('selectionchange'))`);
      await page.clock.fastForward(200);
      assert.equal(
        await prompt.getAttribute('aria-activedescendant'),
        'slashrow0',
        'an unchanged selection cleared the path rows',
      );
      assert.equal(
        await page.evaluate(`window.__posted.filter((message) => message.type === 'pathCompletion').length`),
        requestsBeforeRefocus,
        'an unchanged selection made a duplicate path request',
      );

      await prompt.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(0, 2));
      await page.evaluate(`document.dispatchEvent(new Event('selectionchange'))`);
      assert.equal(await page.locator('#slashpop').getAttribute('hidden'), '', 'a selected range left path rows open');
      await prompt.press('Tab');
      assert.equal(await prompt.inputValue(), '~/Projects/wo', 'Tab replaced a selected range with a path');
      await prompt.focus();
      await prompt.evaluate((node: HTMLTextAreaElement) =>
        node.setSelectionRange(node.value.length, node.value.length),
      );
      await page.evaluate(`document.dispatchEvent(new Event('selectionchange'))`);
      await page.clock.fastForward(500);
      const current = (await page.evaluate(
        `window.__posted.filter((message) => message.type === 'pathCompletion').at(-1)`,
      )) as { session: string; request: number; token: string; caret: number };
      assert.notEqual(current.request, request.request, 'moving the caret kept the old request identity');
      await post(page, { type: 'pathCompletion', ...request, rows: [row] });
      assert.equal(
        await page.locator('#slashpop').getAttribute('hidden'),
        '',
        'a stale reply reopened completion after the caret moved',
      );
      await post(page, { type: 'pathCompletion', ...current, rows: [row] });
      await prompt.press('Tab');
      assert.equal(await prompt.inputValue(), '~/Projects/work/');
      assert.equal(await page.evaluate(`document.activeElement && document.activeElement.id`), 'prompt');
      const draft = (await page.evaluate(`window.__posted.filter((message) => message.type === 'draft').at(-1)`)) as {
        text: string;
      };
      assert.equal(draft.text, '~/Projects/work/');
      await prompt.press('Control+z');
      assert.equal(await prompt.inputValue(), '~/Projects/wo');

      await prompt.fill('./with');
      await page.clock.fastForward(500);
      const spaced = (await page.evaluate(
        `window.__posted.filter((message) => message.type === 'pathCompletion').at(-1)`,
      )) as { session: string; request: number; token: string; caret: number };
      await post(page, {
        type: 'pathCompletion',
        ...spaced,
        rows: [
          {
            name: 'space',
            directory: true,
            label: 'space/',
            accessibleName: 'Directory space/',
            completion: './with space/',
          },
        ],
      });
      await prompt.press('Tab');
      assert.equal(await prompt.inputValue(), '"./with space/"');
      assert.equal(
        await prompt.evaluate((node: HTMLTextAreaElement) => node.selectionStart),
        '"./with space/"'.length - 1,
        'the caret is not inside the closing delimiter',
      );
      await page.clock.fastForward(500);
      const child = (await page.evaluate(
        `window.__posted.filter((message) => message.type === 'pathCompletion').at(-1)`,
      )) as { session: string; request: number; token: string; caret: number };
      assert.equal(child.token, './with space/', 'the quoted directory did not request its child');
      await post(page, {
        type: 'pathCompletion',
        ...child,
        rows: [
          {
            name: 'child',
            directory: true,
            label: 'child/',
            accessibleName: 'Directory child/',
            completion: './with space/child/',
          },
        ],
      });
      await prompt.press('Tab');
      assert.equal(await prompt.inputValue(), '"./with space/child/"');

      await prompt.fill('"./with space/wo"');
      await page.clock.fastForward(500);
      const quoted = (await page.evaluate(
        `window.__posted.filter((message) => message.type === 'pathCompletion').at(-1)`,
      )) as { session: string; request: number; token: string; caret: number };
      await post(page, {
        type: 'pathCompletion',
        ...quoted,
        rows: [
          {
            name: 'work',
            directory: true,
            label: 'work/',
            accessibleName: 'Directory work/',
            completion: './with space/work/',
          },
        ],
      });
      await prompt.press('Tab');
      assert.equal(await prompt.inputValue(), '"./with space/work/"', 'path completion replaced a quote delimiter');

      await prompt.fill('"./with space/fi"');
      await page.clock.fastForward(500);
      const quotedFile = (await page.evaluate(
        `window.__posted.filter((message) => message.type === 'pathCompletion').at(-1)`,
      )) as { session: string; request: number; token: string; caret: number };
      await post(page, {
        type: 'pathCompletion',
        ...quotedFile,
        rows: [
          {
            name: 'file',
            directory: false,
            label: 'file',
            accessibleName: 'File file',
            completion: './with space/file',
          },
        ],
      });
      await prompt.press('Tab');
      assert.equal(await prompt.inputValue(), '"./with space/file"');
      assert.equal(
        await prompt.evaluate((node: HTMLTextAreaElement) => node.selectionStart),
        '"./with space/file"'.length,
        'a quoted file left the caret inside its closing delimiter',
      );

      await prompt.fill('~/Projects/wo');
      await page.clock.fastForward(500);
      const fresh = (await page.evaluate(
        `window.__posted.filter((message) => message.type === 'pathCompletion').at(-1)`,
      )) as { session: string; request: number; token: string; caret: number };
      await post(page, {
        type: 'pathCompletion',
        ...fresh,
        rows: [row, { ...row, name: 'worker', label: 'worker/', completion: '~/Projects/worker/' }],
      });
      await prompt.press('ArrowDown');
      await prompt.press('Escape');
      await prompt.press('Tab');
      assert.equal(await prompt.inputValue(), '~/Projects/wo', 'Escape did not leave Tab for focus traversal');
      await post(page, { type: 'pathCompletion', ...request, rows: [row] });
      assert.equal(await page.locator('#slashpop').getAttribute('hidden'), '', 'a stale reply reopened completion');
    } finally {
      await browser.close();
    }
  },
);

// Open the session list filter box before sending keys to it.
async function openRailBox(page: Page): Promise<void> {
  await page.locator('[data-control="railsearch"]').click();
  await page.evaluate(SETTLED);
}

// The send chord submits comments while focus remains on a turn card.
const CHORD = `/^Mac/.test(navigator.platform) ? 'Meta+Enter' : 'Control+Enter'`;

async function writeComment(page: Page, key: string, words: string, saveKey: string): Promise<void> {
  await page.evaluate(`(async () => {
    const card = document.querySelector('[data-key=${JSON.stringify(key)}]');
    if (card.querySelector('.body').hidden) {
      card.querySelector('.head').click();
      await ${SETTLED};
    }
    const target = card.querySelector('.summary p');
    const range = document.createRange();
    range.selectNodeContents(target);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    await ${SETTLED};
    document.querySelector('.quotebar button').click();
    await ${SETTLED};
  })()`);
  const area = page.locator('.quoteslot .notearea');
  await area.fill(words);
  await area.press(saveKey);
  await page.evaluate(SETTLED);
}

function sentPrompts(page: Page): Promise<{ text: string; session: string }[]> {
  return page.evaluate(`window.__posted.filter((message) => message.type === 'sendPrompt')`) as Promise<
    { text: string; session: string }[]
  >;
}

test(
  'the send chord sends a comment-only prompt from the card the comment came from',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
      return;
    }
    try {
      const page = await browser.newPage();
      await page.setContent(pageHtml());
      const payload = renderPayload();
      await post(page, payload);
      const chord = (await page.evaluate(CHORD)) as string;
      const key = (payload.cards as { key: string }[])[0].key;
      await writeComment(page, key, 'Answer this one first.', 'Enter');

      // The host supplies the saved comment before the page-level send handler runs.
      const noted = composerView(
        {
          ...COMPOSER,
          comments: [
            {
              id: 'note-1',
              sessionId: 's1',
              turnKey: key,
              part: 'summary',
              quote: 'A quoted line.',
              note: 'Answer this one first.',
              headline: '',
              sessionTitle: '',
              turnAt: 1,
              at: 2,
            },
          ],
        },
        Date.now(),
      );
      assert.ok(noted);
      await post(page, { type: 'usage', usage: usageWith(payload, noted) });
      assert.notEqual(
        await page.evaluate(`document.activeElement && document.activeElement.id`),
        'prompt',
        'the saved comment left focus in the box, so the chord proves nothing',
      );

      await page.keyboard.press(chord);
      await page.evaluate(SETTLED);
      const sent = await sentPrompts(page);
      assert.equal(sent.length, 1, 'the chord did not send from outside the box');
      assert.deepEqual({ text: sent[0].text, session: sent[0].session }, { text: '', session: 's1' });
    } finally {
      await browser.close();
    }
  },
);

test('the send chord inside a comment editor saves the comment and sends nothing', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(pageHtml());
    const payload = renderPayload();
    await post(page, payload);
    const chord = (await page.evaluate(CHORD)) as string;
    const key = (payload.cards as { key: string }[])[0].key;
    await writeComment(page, key, 'Keep this comment and send nothing.', chord);

    const written = (await page.evaluate(`window.__posted.filter((message) => message.type === 'note').at(-1)`)) as {
      note: { op: string; note: { note: string } };
    };
    assert.equal(written.note.op, 'write', 'the chord did not save the comment');
    assert.equal(written.note.note.note, 'Keep this comment and send nothing.');
    assert.equal((await sentPrompts(page)).length, 0, 'the chord sent the prompt while a comment was open');
    assert.equal(await page.locator('.noteedit').count(), 0, 'the comment editor stayed open');

    // Save and Close are buttons, so an editable-target check does not block their send chord.
    // The open comment editor must block sending.
    await writeComment(page, key, 'Leave this one unsaved.', chord);
    await page.evaluate(`(async () => {
      const card = document.querySelector('[data-key=${JSON.stringify(key)}]');
      const target = card.querySelector('.summary p');
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      await ${SETTLED};
      document.querySelector('.quotebar button').click();
      await ${SETTLED};
    })()`);
    await page.locator('.quoteslot .notearea').fill('Half of a comment.');
    await page.locator('.quoteslot .notesave').focus();
    await page.keyboard.press(chord);
    await page.evaluate(SETTLED);
    assert.equal(
      (await sentPrompts(page)).length,
      0,
      'the chord sent from the comment editor Save button, leaving the comment behind',
    );
    assert.equal(await page.locator('.noteedit').count(), 1, 'the open comment editor was closed');
  } finally {
    await browser.close();
  }
});

test('the send chord sends the first comment of a session before the host answers', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(pageHtml());
    const payload = renderPayload();
    await post(page, payload);
    const chord = (await page.evaluate(CHORD)) as string;
    const key = (payload.cards as { key: string }[])[0].key;
    await writeComment(page, key, 'Send this before the host replies.', 'Enter');

    // The host has not supplied the saved comment.
    // Sending an empty prompt must use the local comments.
    assert.equal(
      await page.evaluate(`document.querySelector('.cchips .cchip') !== null`),
      false,
      'the host already described the comment, so the race is not being measured',
    );
    await page.keyboard.press(chord);
    await page.evaluate(SETTLED);
    assert.equal((await sentPrompts(page)).length, 1, 'the chord was refused before the host caught up');
  } finally {
    await browser.close();
  }
});

test('the send chord in a rail filter field leaves the composer alone', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(pageHtml());
    const payload = renderPayload();
    await post(page, payload);
    await openRailBox(page);
    const chord = (await page.evaluate(CHORD)) as string;
    const key = (payload.cards as { key: string }[])[0].key;
    await writeComment(page, key, 'A comment the rail must not send.', 'Enter');

    const filter = page.locator('.railfilter');
    await filter.focus();
    await filter.press(chord);
    await page.evaluate(SETTLED);
    assert.equal((await sentPrompts(page)).length, 0, 'a typed rail filter sent the composer');
  } finally {
    await browser.close();
  }
});

test('the send chord inside the composer text field sends what the box holds', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(pageHtml());
    await post(page, renderPayload());
    const chord = (await page.evaluate(CHORD)) as string;
    const prompt = page.locator('#prompt');
    await prompt.fill('Send this from the box.');
    await prompt.press(chord);
    await page.evaluate(SETTLED);

    // The page-level listener skips the prompt text field, whose own handler sends the chord.
    const sent = await sentPrompts(page);
    assert.equal(sent.length, 1, 'the chord did nothing inside the box');
    assert.equal(sent[0].text, 'Send this from the box.');
    assert.equal(await prompt.inputValue(), '', 'the sent box kept its words');

    // Plain Enter and the chord differ while the completion menu is open. Enter takes the
    // highlighted row. The chord sends the text as typed.
    await prompt.fill('/comp');
    assert.ok((await page.locator('.slashrow').count()) > 0, 'the completion menu did not open');
    await prompt.press(chord);
    await page.evaluate(SETTLED);
    const after = await sentPrompts(page);
    assert.equal(after.length, 2, 'the chord was taken by the completion menu');
    assert.equal(after[1].text, '/comp', 'the chord completed the row instead of sending the typed text');
  } finally {
    await browser.close();
  }
});

test(
  'the send chord leaves a focused summary link alone when there is nothing to send',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
      return;
    }
    try {
      const page = await browser.newPage();
      await page.setContent(pageHtml());
      const payload = renderPayload();
      for (const card of payload.cards as Record<string, unknown>[]) {
        card.summaryHtml = '<p>See <a href="#" data-link="src/store.ts">the store</a> for this.</p>';
      }
      await post(page, payload);
      const chord = (await page.evaluate(CHORD)) as string;
      const key = (payload.cards as { key: string; sessionId: string }[]).find((c) => c.sessionId === 's1')!.key;
      await page.evaluate(`(async () => {
      const card = document.querySelector('[data-key=${JSON.stringify(key)}]');
      if (card.querySelector('.body').hidden) {
        card.querySelector('.head').click();
        await ${SETTLED};
      }
    })()`);
      const link = page.locator(`[data-key=${JSON.stringify(key)}] a[data-link]`).first();
      assert.equal(await link.count(), 1, 'the fixture drew no summary link');

      // Chromium activates a focused link on the send chord.
      // With nothing to send, the chord must retain that link action.
      await page.evaluate(`window.__posted = []`);
      await link.focus();
      await link.press(chord);
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.evaluate(`window.__posted.map((m) => m.type)`),
        ['openLink'],
        'a refused send ate the link the reader was standing on',
      );

      // With prompt text to send, the chord sends it without opening the focused link.
      await page.locator('#prompt').fill('a prompt worth sending');
      await page.evaluate(SETTLED);
      await page.evaluate(`window.__posted = []`);
      await link.focus();
      await link.press(chord);
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.evaluate(
          `window.__posted.filter((m) => m.type === 'openLink' || m.type === 'sendPrompt').map((m) => m.type)`,
        ),
        ['sendPrompt'],
        'the chord opened the link as well as sending',
      );
    } finally {
      await browser.close();
    }
  },
);

test('the composer sash resizes, saves, restores, and keeps long text visible', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 720, height: 900 });
    await page.setContent(pageHtml());
    await post(page, renderPayload());
    const sash = page.locator('#footsash');
    const before = (await page.evaluate(`(() => ({
      prompt: document.getElementById('prompt').getBoundingClientRect().height,
      foot: Number.parseFloat(document.body.style.getPropertyValue('--foot-height')),
    }))()`)) as { prompt: number; foot: number };
    const handle = await sash.boundingBox();
    assert.ok(handle, 'the Composer sash has no box to drag');
    await page.evaluate(`window.__posted = []`);
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2, handle.y - 58);
    await page.mouse.up();
    await page.evaluate(SETTLED);
    const raised = (await page.evaluate(`(() => ({
      prompt: document.getElementById('prompt').getBoundingClientRect().height,
      foot: Number.parseFloat(document.body.style.getPropertyValue('--foot-height')),
      saved: window.__posted.filter((message) => message.type === 'saveState').at(-1)?.state?.promptFloor,
    }))()`)) as { prompt: number; foot: number; saved: number };
    assert.ok(raised.prompt > before.prompt + 40, 'the drag did not raise the prompt box');
    assert.ok(
      Math.abs(raised.prompt - before.prompt - (raised.foot - before.foot)) <= 2,
      'the reserved foot height did not follow the prompt box',
    );
    assert.ok(raised.saved > 3.6, 'pointerup did not save the raised floor');

    await sash.press('Home');
    const prompt = page.locator('#prompt');
    await prompt.fill(Array.from({ length: 24 }, (_, at) => `line ${at}`).join('\n'));
    const textHeight = await prompt.evaluate((node) => node.getBoundingClientRect().height);
    await sash.press('End');
    await sash.press('Home');
    await page.evaluate(SETTLED);
    const lowered = await prompt.evaluate((node) => node.getBoundingClientRect().height);
    assert.ok(Math.abs(lowered - textHeight) <= 2, 'dragging down made the box shorter than its text');

    const restored = await browser.newPage();
    await restored.setViewportSize({ width: 720, height: 900 });
    const html = pageHtml().replace('const SAVED_STATE = {};', 'const SAVED_STATE = { promptFloor: 12 };');
    await restored.setContent(html);
    await post(restored, renderPayload());
    const restoredFloor = await restored.locator('#prompt').evaluate((node) => {
      const style = getComputedStyle(node);
      return Number.parseFloat(style.minHeight) / Number.parseFloat(style.fontSize);
    });
    assert.ok(Math.abs(restoredFloor - 12) <= 0.1, 'the saved floor was not drawn on page creation');
    await restored.close();
  } finally {
    await browser.close();
  }
});

test('the Composer context action hides and restores an unsent draft', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 720, height: 900 });
    await page.setContent(recoveryPage({}));
    await post(page, renderPayload());
    const prompt = page.locator('#prompt');
    const contextAt = async (selector: string) =>
      (await page.locator(selector).evaluate((node) => {
        const context: Record<string, unknown> = {};
        for (let at: HTMLElement | null = node as HTMLElement; at; at = at.parentElement) {
          const raw = at.dataset.vscodeContext;
          if (raw) Object.assign(context, JSON.parse(raw));
        }
        return context;
      })) as { webviewSection?: string; preventDefaultContextMenuItems?: boolean };
    await page.evaluate(`window.__posted = []`);
    await prompt.evaluate((node) =>
      node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
    );
    assert.deepEqual(
      await contextAt('#prompt'),
      { webviewSection: 'arcComposer' },
      'the Composer text field suppresses native text actions',
    );
    assert.deepEqual(
      await page.evaluate(`window.__posted.filter((message) => message.type === 'armComposer')`),
      [{ type: 'armComposer' }],
      'a Composer right-click does not arm its Hide action',
    );
    await prompt.fill('keep this draft');
    await post(page, { type: 'setComposerHidden', hidden: true });
    await post(page, renderPayload());
    const hidden = (await page.evaluate(`(() => ({
      composer: document.getElementById('composer')?.classList.contains('composer-hidden'),
      prompt: document.getElementById('prompt')?.checkVisibility(),
      sash: document.getElementById('footsash')?.checkVisibility(),
      name: document.getElementById('footsash')?.getAttribute('aria-label'),
      context: document.getElementById('footsash')?.dataset.vscodeContext,
      saved: window.__posted.filter((message) => message.type === 'saveState').at(-1)?.state?.composerHidden,
    }))()`)) as { composer: boolean; prompt: boolean; sash: boolean; context: string; saved: boolean };
    assert.deepEqual(
      hidden,
      {
        composer: true,
        prompt: false,
        sash: true,
        name: 'Prompt box height. Prompt box collapsed.',
        context: JSON.stringify({ webviewSection: 'arcComposerHidden', preventDefaultContextMenuItems: true }),
        saved: true,
      },
      'hiding the Composer removed its draft or its only restoration target',
    );
    await page.evaluate(`window.__posted = []`);
    await post(page, { type: 'forgetState', since: 0 });
    const reset = (await page.evaluate(`(() => ({
      composer: document.getElementById('composer')?.classList.contains('composer-hidden'),
      prompt: document.getElementById('prompt')?.checkVisibility(),
      sash: document.getElementById('footsash')?.checkVisibility(),
      context: document.getElementById('footsash')?.dataset.vscodeContext,
      saved: window.__saved.composerHidden,
    }))()`)) as { composer: boolean; prompt: boolean; sash: boolean; context: string; saved: boolean };
    assert.deepEqual(
      reset,
      {
        composer: false,
        prompt: true,
        sash: true,
        context: JSON.stringify({ webviewSection: 'arcComposer' }),
        saved: false,
      },
      'resetting panel state left the Composer hidden or saved its stale hidden state',
    );
    assert.equal(
      await page.evaluate(`window.__posted.filter((message) => message.type === 'saveState').length`),
      0,
      'reset echoed cleared preferences to the host',
    );
    await post(page, { type: 'setComposerHidden', hidden: false });
    assert.equal(await prompt.inputValue(), 'keep this draft', 'restoring the Composer lost the unsent draft');
    assert.equal(
      await page.evaluate(
        `window.__posted.filter((message) => message.type === 'saveState').at(-1)?.state?.composerHidden`,
      ),
      false,
      'restoring the Composer left its saved visibility hidden',
    );
    await page.close();
  } finally {
    await browser.close();
  }
});

test(
  'the Composer native menu takes the current line without selecting a paste target',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
      return;
    }
    try {
      const page = await browser.newPage();
      await page.setContent(pageHtml());
      await post(page, renderPayload());
      const prompt = page.locator('#prompt');
      await prompt.fill('first\nsecond\nthird');
      const selected = await prompt.evaluate((node: HTMLTextAreaElement) => {
        node.setSelectionRange(8, 8);
        node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        const selected = node.value.slice(node.selectionStart, node.selectionEnd);
        node.dispatchEvent(new Event('copy'));
        return selected;
      });
      await page.waitForFunction(() => {
        const prompt = document.querySelector<HTMLTextAreaElement>('#prompt');
        return prompt?.selectionStart === 8 && prompt.selectionEnd === 8;
      });
      assert.equal(selected, 'second\n', 'the native Copy action does not take the current line');
      const pasted = await prompt.evaluate((node: HTMLTextAreaElement) => {
        node.setSelectionRange(8, 8);
        node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        node.dispatchEvent(new Event('paste'));
        return { start: node.selectionStart, end: node.selectionEnd };
      });
      assert.deepEqual(pasted, { start: 8, end: 8 }, 'the native Paste action replaces the current line');
      const keyboardCut = await prompt.evaluate((node: HTMLTextAreaElement) => {
        node.setSelectionRange(8, 8);
        node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        node.setSelectionRange(0, 5);
        node.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', ctrlKey: true, bubbles: true }));
        node.dispatchEvent(new Event('cut'));
        return { start: node.selectionStart, end: node.selectionEnd };
      });
      assert.deepEqual(
        keyboardCut,
        { start: 0, end: 5 },
        'a keyboard Cut after dismissing the native menu takes the current selection',
      );
      const menuCut = await prompt.evaluate((node: HTMLTextAreaElement) => {
        node.value = 'first\nsecond\nthird';
        node.setSelectionRange(15, 15);
        node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        node.dispatchEvent(new Event('cut'));
        node.setRangeText('', node.selectionStart, node.selectionEnd, 'end');
        return node.value;
      });
      assert.equal(menuCut, 'first\nsecond', 'the native Cut action leaves an orphaned final-line break');
      await page.close();
    } finally {
      await browser.close();
    }
  },
);

test('right-clicking selected Composer text keeps its visible selection', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(themed(pageHtml()));
    await post(page, renderPayload());
    const prompt = page.locator('#prompt');
    await prompt.fill('before selected after');
    const point = await prompt.evaluate((node: HTMLTextAreaElement) => {
      const style = getComputedStyle(node);
      const canvas = document.createElement('canvas');
      const measure = canvas.getContext('2d')!;
      measure.font = style.font;
      const rect = node.getBoundingClientRect();
      const left = rect.left + Number.parseFloat(style.paddingLeft);
      return {
        startX: left + measure.measureText('before ').width,
        endX: left + measure.measureText('before selected').width,
        x: left + measure.measureText('before sele').width,
        y: rect.top + Number.parseFloat(style.paddingTop) + Number.parseFloat(style.lineHeight) / 2,
      };
    });
    await page.mouse.move(point.startX, point.y);
    await page.mouse.down();
    await page.mouse.move(point.endX, point.y, { steps: 5 });
    await page.mouse.up();
    assert.deepEqual(
      await prompt.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd]),
      [7, 15],
      'the pointer drag did not select the intended text',
    );
    await page.mouse.click(point.x, point.y, { button: 'right' });
    assert.deepEqual(
      await prompt.evaluate((node: HTMLTextAreaElement) => ({
        start: node.selectionStart,
        end: node.selectionEnd,
        text: node.value.slice(node.selectionStart, node.selectionEnd),
        focused: document.activeElement === node,
      })),
      { start: 7, end: 15, text: 'selected', focused: true },
      'right-clicking inside selected text removed its highlight',
    );
    await page.locator('#composer-collapse').focus();
    assert.equal(
      await page.locator('.cselectionlayer .cselected').count(),
      1,
      'the menu focus removed the selection highlight',
    );
    assert.equal(await page.locator('.cselectionlayer .cselected').textContent(), 'selected');
    const selected = page.locator('.cselectionlayer .cselected');
    const painted = await selected.screenshot();
    await selected.evaluate((node: HTMLElement) => {
      node.style.background = 'transparent';
    });
    const unpainted = await selected.screenshot();
    assert.notDeepEqual(painted, unpainted, 'the selection layer did not paint a visible highlight');
    await prompt.click();
    assert.equal(await page.locator('.cselectionlayer .cselected').count(), 0, 'a later press kept the menu highlight');

    await prompt.fill('Copy this whole prompt');
    await prompt.press('ControlOrMeta+A');
    await page.mouse.click(point.x, point.y, { button: 'right' });
    assert.deepEqual(
      await prompt.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd]),
      [0, 'Copy this whole prompt'.length],
      'right-clicking after Select All changed the selected text',
    );
    await prompt.evaluate(() => {
      window.dispatchEvent(new Event('blur'));
      document.body.tabIndex = -1;
      document.body.focus();
    });
    await page.clock.fastForward(20);
    assert.equal(
      await page.evaluate(`document.activeElement === document.body`),
      true,
      'opening the native menu pulled focus back into the Composer',
    );
    assert.equal(
      await page.locator('.cselectionlayer .cselected').textContent(),
      'Copy this whole prompt',
      'the menu focus removed the Select All highlight',
    );
  } finally {
    await browser.close();
  }
});

test(
  'opening the Composer menu after a primary press leaves menu focus outside the prompt',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
      return;
    }
    try {
      const page = await browser.newPage();
      await page.setContent(themed(pageHtml()));
      await post(page, renderPayload());
      const prompt = page.locator('#prompt');
      await prompt.fill('Copy this whole prompt');
      for (const route of ['Control-click', 'Shift+F10 after a primary press'] as const) {
        await prompt.focus();
        await prompt.press('ControlOrMeta+A');
        await prompt.evaluate((node, route) => {
          node.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: route === 'Control-click' }),
          );
          if (route !== 'Control-click') {
            node.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
          }
          node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
          window.dispatchEvent(new Event('blur'));
          document.body.tabIndex = -1;
          document.body.focus();
        }, route);
        await page.clock.fastForward(20);
        assert.equal(
          await page.evaluate(`document.activeElement === document.body`),
          true,
          `${route} pulled focus out of the native menu`,
        );
        assert.equal(
          await page.locator('.cselectionlayer .cselected').textContent(),
          'Copy this whole prompt',
          `${route} lost the visible Select All highlight`,
        );
        assert.deepEqual(
          await prompt.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd]),
          [0, 'Copy this whole prompt'.length],
          `${route} changed the selected text`,
        );
      }
    } finally {
      await browser.close();
    }
  },
);

test('dismissing the Composer menu leaves later text selections intact', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(pageHtml());
    await post(page, renderPayload());
    const prompt = page.locator('#prompt');
    for (const selection of [
      { start: 6, end: 13, expected: 'first\nnewthird' },
      { start: 0, end: 5, expected: 'new\nsecond\nthird' },
    ]) {
      await prompt.fill('first\nsecond\nthird');
      const result = await prompt.evaluate((node: HTMLTextAreaElement, selected) => {
        node.setSelectionRange(8, 8);
        node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        node.setSelectionRange(selected.start, selected.end);
        node.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true }));
        node.dispatchEvent(new Event('paste', { bubbles: true }));
        node.setRangeText('new', node.selectionStart, node.selectionEnd, 'end');
        return node.value;
      }, selection);
      assert.equal(result, selection.expected, 'Paste changed text outside the later selection');
    }
    await prompt.fill('first\nsecond\nthird');
    const pointerPaste = await prompt.evaluate((node: HTMLTextAreaElement) => {
      node.setSelectionRange(8, 8);
      node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      node.setSelectionRange(6, 13);
      node.dispatchEvent(new Event('paste', { bubbles: true }));
      node.setRangeText('new', node.selectionStart, node.selectionEnd, 'end');
      return node.value;
    });
    assert.equal(pointerPaste, 'first\nnewthird', 'a pointer selection kept the old menu caret');
    await prompt.fill('first\nsecond\nthird');
    const cut = await prompt.evaluate((node: HTMLTextAreaElement) => {
      node.setSelectionRange(15, 15);
      node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      node.setSelectionRange(13, 18);
      node.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', ctrlKey: true, bubbles: true }));
      node.dispatchEvent(new Event('cut', { bubbles: true }));
      node.setRangeText('', node.selectionStart, node.selectionEnd, 'end');
      return node.value;
    });
    assert.equal(cut, 'first\nsecond\n', 'Cut removed the newline before the selected final line');
    for (const action of ['paste', 'cut'] as const) {
      await prompt.fill('first\nsecond\nthird');
      const result = await prompt.evaluate((node: HTMLTextAreaElement, action) => {
        node.setSelectionRange(15, 15);
        node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        if (action === 'cut') {
          node.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', ctrlKey: true, bubbles: true }));
        }
        node.dispatchEvent(new Event(action, { bubbles: true }));
        node.setRangeText(action === 'paste' ? 'new' : '', node.selectionStart, node.selectionEnd, 'end');
        return node.value;
      }, action);
      assert.equal(
        result,
        action === 'paste' ? 'first\nsecond\nthnewird' : 'first\nsecond',
        `Escape left a menu selection that changed the next ${action}`,
      );
    }
    await prompt.fill('first\nsecond\nthird');
    const typed = await prompt.evaluate((node: HTMLTextAreaElement) => {
      node.setSelectionRange(15, 15);
      node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      node.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: 'X' }));
      node.setRangeText('X', node.selectionStart, node.selectionEnd, 'end');
      return node.value;
    });
    assert.equal(typed, 'first\nsecond\nthXird', 'typing replaced the line selected by the dismissed menu');
    for (const action of ['paste', 'cut'] as const) {
      await prompt.fill('first\nsecond\nthird');
      const result = await prompt.evaluate((node: HTMLTextAreaElement, action) => {
        node.setSelectionRange(15, 15);
        node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        node.dispatchEvent(new Event('blur'));
        node.dispatchEvent(new Event(action, { bubbles: true }));
        if (action === 'paste') {
          node.setRangeText('new', node.selectionStart, node.selectionEnd, 'end');
        } else if (node.selectionStart !== node.selectionEnd) {
          node.setRangeText('', node.selectionStart, node.selectionEnd, 'end');
        }
        return node.value;
      }, action);
      assert.equal(
        result,
        action === 'paste' ? 'first\nsecond\nthnewird' : 'first\nsecond\nthird',
        `a later Edit-menu ${action} used the dismissed menu selection`,
      );
    }
    await prompt.fill('first\nsecond\nthird');
    const sameLinePaste = await prompt.evaluate((node: HTMLTextAreaElement) => {
      node.setSelectionRange(8, 8);
      node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      node.setSelectionRange(6, 13);
      node.dispatchEvent(new Event('paste', { bubbles: true }));
      node.setRangeText('new', node.selectionStart, node.selectionEnd, 'end');
      return node.value;
    });
    assert.equal(sameLinePaste, 'first\nnewthird', 'a new selection of the same line lost its Paste target');
    await page.close();
  } finally {
    await browser.close();
  }
});

test('the Composer collapse button saves visibility and the divider cannot hide it', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 720, height: 900 });
    await page.setContent(pageHtml().replace('const SAVED_STATE = {};', 'const SAVED_STATE = { promptFloor: 12 };'));
    await post(page, renderPayload());
    const collapse = page.locator('#composer-collapse');
    await assert.doesNotReject(collapse.focus(), 'the Composer has no keyboard-reachable collapse button');
    assert.equal(await collapse.getAttribute('aria-label'), 'Collapse prompt box');
    await page.evaluate('window.__posted = []');
    await collapse.press('Enter');
    const restore = page.locator('#composer-restore');
    assert.equal(await restore.isVisible(), true, 'collapsing did not leave a visible restore control');
    assert.equal(await restore.getAttribute('aria-label'), 'Restore prompt box');
    assert.equal(await restore.getAttribute('data-hint'), 'Restore prompt box');
    assert.equal(await restore.getAttribute('title'), null, 'the restore icon uses a native browser title');
    assert.equal(await restore.textContent(), '\u25B4', 'the restore control is not an upward icon');
    const collapsedBox = await page.locator('#composer').boundingBox();
    const restoreBox = await restore.boundingBox();
    assert.ok(collapsedBox && restoreBox, 'the collapsed Composer or restore icon has no box');
    assert.ok(
      restoreBox.x > collapsedBox.x + collapsedBox.width / 2,
      'the restore icon is not on the right side of the collapsed Composer bar',
    );
    assert.equal(
      await page.locator('#composer').evaluate((node) => node.classList.contains('composer-hidden')),
      true,
      'the collapse button did not hide the Composer',
    );
    assert.equal(
      await page.evaluate(
        `window.__posted.filter((message) => message.type === 'saveState').at(-1)?.state?.composerHidden`,
      ),
      true,
      'the collapse button did not save the hidden Composer',
    );
    await restore.press('Enter');
    assert.equal(
      await page.locator('#composer').evaluate((node) => node.classList.contains('composer-hidden')),
      false,
      'the restore control did not show the Composer',
    );
    const sash = page.locator('#footsash');
    await sash.press('End');
    const handle = await sash.boundingBox();
    assert.ok(handle, 'the raised Composer divider has no box to drag');
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2, 898);
    await page.mouse.up();
    await page.evaluate(SETTLED);
    assert.equal(
      await page.locator('#composer').evaluate((node) => node.classList.contains('composer-hidden')),
      false,
      'dragging the divider down hid the Composer instead of stopping at its minimum',
    );
    await sash.press('Home');
    const minimumHeight = await page.locator('#prompt').evaluate((node) => node.getBoundingClientRect().height);
    const touchHandle = await sash.boundingBox();
    assert.ok(touchHandle, 'the Composer divider has no box for touch resizing');
    const touch = await page.context().newCDPSession(page);
    const point = { x: touchHandle.x + touchHandle.width / 2, y: touchHandle.y + touchHandle.height / 2 };
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] });
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: point.x, y: point.y - 64, id: 1 }],
    });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.evaluate(SETTLED);
    assert.ok(
      (await page.locator('#prompt').evaluate((node) => node.getBoundingClientRect().height)) > minimumHeight,
      'touch resizing did not raise the Composer from its minimum',
    );
    assert.equal(
      await page.locator('#composer').evaluate((node) => node.classList.contains('composer-hidden')),
      false,
      'touch resizing hid the Composer instead of keeping it visible',
    );
    const restored = await browser.newPage();
    await restored.setViewportSize({ width: 720, height: 900 });
    await restored.setContent(
      pageHtml().replace('const SAVED_STATE = {};', 'const SAVED_STATE = { composerHidden: true, promptFloor: 12 };'),
    );
    await post(restored, renderPayload());
    assert.equal(
      await restored.locator('#composer-restore').isVisible(),
      true,
      'a restored tab lost the saved Composer visibility state',
    );
    await restored.close();
  } finally {
    await browser.close();
  }
});

test('the hidden Composer sash keeps its saved height until restore', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 720, height: 900 });
    await page.setContent(pageHtml().replace('const SAVED_STATE = {};', 'const SAVED_STATE = { promptFloor: 12 };'));
    await post(page, renderPayload());
    const prompt = page.locator('#prompt');
    const expandedHeight = await prompt.evaluate((node) => node.getBoundingClientRect().height);
    await page.locator('#composer-collapse').click();
    assert.equal(
      await page.locator('#composer').evaluate((node) => node.classList.contains('composer-hidden')),
      true,
      'the collapse control did not hide the Composer before divider input',
    );
    const sash = page.locator('#footsash');
    await page.evaluate('window.__posted = []');
    await sash.press('ArrowUp');
    await sash.evaluate(async (node) => {
      node.setPointerCapture = () => {};
      const pointer = (type: string, clientY: number) =>
        node.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            button: 0,
            clientY,
            isPrimary: true,
            pointerId: 1,
          }),
        );
      pointer('pointerdown', 100);
      pointer('pointermove', 0);
      pointer('pointerup', 0);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    await page.evaluate(SETTLED);
    assert.equal(
      await page.evaluate(
        `window.__posted.filter((message) => message.type === 'saveState' && 'promptFloor' in message.state).length`,
      ),
      0,
      'the hidden Composer divider changed the saved prompt height',
    );
    await page.locator('#composer-restore').press('Enter');
    const restoredHeight = await prompt.evaluate((node) => node.getBoundingClientRect().height);
    assert.ok(
      Math.abs(restoredHeight - expandedHeight) <= 2,
      'restoring the Composer did not return its height before collapse',
    );
  } finally {
    await browser.close();
  }
});

test('collapsing the Composer cancels an active divider drag', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 720, height: 900 });
    await page.setContent(pageHtml().replace('const SAVED_STATE = {};', 'const SAVED_STATE = { promptFloor: 12 };'));
    await post(page, renderPayload());
    const prompt = page.locator('#prompt');
    const sash = page.locator('#footsash');
    const before = await prompt.evaluate((node) => ({
      height: node.getBoundingClientRect().height,
      floor: node.style.getPropertyValue('--prompt-floor'),
    }));
    await page.evaluate('window.__posted = []');
    await sash.evaluate((node) => {
      node.setPointerCapture = () => {};
      node.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          clientY: 400,
          isPrimary: true,
          pointerId: 1,
          pointerType: 'mouse',
        }),
      );
    });
    await page.locator('#composer-collapse').press('Enter');
    const savesAfterCollapse = (await page.evaluate(
      `window.__posted.filter((message) => message.type === 'saveState').length`,
    )) as number;
    await sash.evaluate(async (node) => {
      for (const type of ['pointermove', 'pointerup']) {
        node.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            button: 0,
            clientY: 160,
            isPrimary: true,
            pointerId: 1,
            pointerType: 'mouse',
          }),
        );
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    await page.evaluate(SETTLED);
    assert.equal(
      await page.evaluate(`window.__posted.filter((message) => message.type === 'saveState').length`),
      savesAfterCollapse,
      'a later drag event saved a Composer height after collapse',
    );
    await page.locator('#composer-restore').press('Enter');
    const restored = await prompt.evaluate((node) => ({
      height: node.getBoundingClientRect().height,
      floor: node.style.getPropertyValue('--prompt-floor'),
    }));
    assert.deepEqual(restored, before, 'restoring the Composer changed its height after a cancelled drag');
  } finally {
    await browser.close();
  }
});

test('a saved hidden Composer stays absent without a Composer view', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 720, height: 900 });
    await page.setContent(
      pageHtml().replace('const SAVED_STATE = {};', 'const SAVED_STATE = { composerHidden: true };'),
    );
    const payload = renderPayload();
    await post(page, { type: 'usage', usage: usageWith(payload, null) });
    const composer = page.locator('#composer');
    assert.equal(await composer.getAttribute('hidden'), '', 'a missing Composer view did not hide the Composer');
    assert.equal(await composer.isVisible(), false, 'a saved hidden Composer remained visible without a Composer view');
  } finally {
    await browser.close();
  }
});

test(
  'the composer sash coalesces pointer moves, uses the release position, and saves once',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
      return;
    }
    try {
      const page = await browser.newPage();
      await page.setViewportSize({ width: 720, height: 900 });
      const html = pageHtml().replace('const SAVED_STATE = {};', 'const SAVED_STATE = { promptFloor: 4.5 };');
      await page.setContent(html);
      await post(page, renderPayload());
      const sash = page.locator('#footsash');
      const handle = await sash.boundingBox();
      assert.ok(handle, 'the Composer sash has no box for frame coalescing');
      await page.evaluate(`window.__posted = []`);
      const result = await sash.evaluate(
        async (node, startY) => {
          const prompt = document.getElementById('prompt')!;
          const posted = (
            window as unknown as Window & {
              __posted: Array<{ type: string; state?: { promptFloor?: number } }>;
            }
          ).__posted;
          const originalRequestAnimationFrame = window.requestAnimationFrame;
          const frames: Array<(time: number) => void> = [];
          let executions = 0;
          window.requestAnimationFrame = (callback) => {
            frames.push((time) => {
              executions++;
              callback(time);
            });
            return frames.length;
          };
          node.setPointerCapture = () => {};
          const height = () => prompt.getBoundingClientRect().height;
          const point = (type: string, clientY: number) => {
            node.dispatchEvent(
              new PointerEvent(type, {
                bubbles: true,
                button: 0,
                clientY,
                isPrimary: true,
                pointerId: 1,
                pointerType: 'mouse',
              }),
            );
          };
          const before = height();
          const initialFloor = Number.parseFloat(prompt.style.getPropertyValue('--prompt-floor'));
          const fontSize = Number.parseFloat(getComputedStyle(prompt).fontSize);
          point('pointerdown', startY);
          point('pointermove', startY - 20);
          point('pointermove', startY - 80);
          point('pointermove', startY - 60);
          const queuedBeforeRelease = frames.length;
          const beforeFrame = height();
          point('pointerup', startY - 80);
          const queuedAfterRelease = frames.length;
          const callback = frames.shift();
          if (!callback) {
            throw new Error('the Composer sash did not schedule a resize frame');
          }
          callback(0);
          // Wait for the microtask that sends the saved state to the host.
          await new Promise<void>((resolve) => {
            queueMicrotask(resolve);
          });
          const saves = posted.filter((message) => message.type === 'saveState');
          const saved = saves.at(-1)?.state?.promptFloor;
          const afterFrame = height();
          window.requestAnimationFrame = originalRequestAnimationFrame;
          return {
            before,
            beforeFrame,
            afterFrame,
            queuedBeforeRelease,
            queuedAfterRelease,
            executions,
            saveCount: saves.length,
            saved,
            expected: initialFloor + 80 / fontSize,
          };
        },
        handle.y + handle.height / 2,
      );
      assert.equal(
        result.beforeFrame,
        result.before,
        'a raw pointermove resized the Composer before the animation frame',
      );
      assert.equal(result.queuedBeforeRelease, 1, 'the pointer move burst scheduled more than one animation frame');
      assert.equal(result.queuedAfterRelease, 1, 'pointer release scheduled a second animation frame');
      assert.equal(result.executions, 1, 'the coalesced resize frame did not execute exactly once');
      assert.equal(result.afterFrame > result.before, true, 'the queued animation frame did not resize the Composer');
      assert.equal(result.saveCount, 1, 'pointer release did not save exactly once');
      assert.ok(
        typeof result.saved === 'number' && Math.abs(result.saved - result.expected) <= 0.01,
        `pointer release saved ${result.saved}, expected ${result.expected}`,
      );
    } finally {
      await browser.close();
    }
  },
);

test(
  'a cancelled composer sash drag applies its latest move once and releases pointer ownership',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
      return;
    }
    try {
      const page = await browser.newPage();
      await page.setViewportSize({ width: 720, height: 900 });
      const html = pageHtml().replace('const SAVED_STATE = {};', 'const SAVED_STATE = { promptFloor: 4.5 };');
      await page.setContent(html);
      await post(page, renderPayload());
      const sash = page.locator('#footsash');
      const handle = await sash.boundingBox();
      assert.ok(handle, 'the Composer sash has no box for pointer cancellation');
      await page.evaluate(`window.__posted = []`);
      const result = await sash.evaluate(
        async (node, startY) => {
          const prompt = document.getElementById('prompt')!;
          const posted = (
            window as unknown as Window & {
              __posted: Array<{ type: string; state?: { promptFloor?: number } }>;
            }
          ).__posted;
          const originalRequestAnimationFrame = window.requestAnimationFrame;
          const frames: Array<(time: number) => void> = [];
          let executions = 0;
          window.requestAnimationFrame = (callback) => {
            frames.push((time) => {
              executions++;
              callback(time);
            });
            return frames.length;
          };
          node.setPointerCapture = () => {};
          const height = () => prompt.getBoundingClientRect().height;
          const point = (type: string, pointerId: number, clientY: number) => {
            node.dispatchEvent(
              new PointerEvent(type, {
                bubbles: true,
                button: 0,
                clientY,
                isPrimary: true,
                pointerId,
                pointerType: 'mouse',
              }),
            );
          };
          const before = height();
          const initialFloor = Number.parseFloat(prompt.style.getPropertyValue('--prompt-floor'));
          const fontSize = Number.parseFloat(getComputedStyle(prompt).fontSize);
          point('pointerdown', 1, startY);
          point('pointermove', 1, startY - 80);
          point('pointermove', 1, startY - 120);
          point('pointercancel', 1, startY - 20);
          const queuedAfterCancel = frames.length;
          const beforeFrame = height();
          const callback = frames.shift();
          if (!callback) {
            throw new Error('pointer cancellation did not keep the queued resize frame');
          }
          callback(0);
          // Wait for the microtask that sends the saved state to the host.
          await new Promise<void>((resolve) => {
            queueMicrotask(resolve);
          });
          const saves = posted.filter((message) => message.type === 'saveState');
          const saved = saves.at(-1)?.state?.promptFloor;
          const afterFrame = height();
          point('pointerdown', 2, startY);
          point('pointermove', 2, startY - 40);
          const secondPointerQueued = frames.length;
          window.requestAnimationFrame = originalRequestAnimationFrame;
          return {
            before,
            beforeFrame,
            afterFrame,
            queuedAfterCancel,
            executions,
            saveCount: saves.length,
            saved,
            expected: initialFloor + 120 / fontSize,
            secondPointerQueued,
          };
        },
        handle.y + handle.height / 2,
      );
      assert.equal(
        result.queuedAfterCancel,
        1,
        'pointer cancellation dropped the queued move or scheduled another frame',
      );
      assert.equal(
        result.beforeFrame,
        result.before,
        'a queued pointer move resized the Composer before cancellation frame execution',
      );
      assert.equal(result.executions, 1, 'pointer cancellation applied the queued move more than once');
      assert.equal(
        result.afterFrame > result.before,
        true,
        'the cancellation frame did not apply the latest pointer move',
      );
      assert.equal(result.saveCount, 1, 'pointer cancellation did not save exactly once');
      assert.ok(
        typeof result.saved === 'number' && Math.abs(result.saved - result.expected) <= 0.01,
        `pointer cancellation saved ${result.saved}, expected ${result.expected}`,
      );
      assert.equal(
        result.secondPointerQueued,
        1,
        'pointer cancellation did not release pointer ownership after the frame',
      );
    } finally {
      await browser.close();
    }
  },
);

test('a touch drag raises the composer through its complete distance', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 720, height: 900 });
    await page.setContent(pageHtml());
    await post(page, renderPayload());
    const sash = page.locator('#footsash');
    const handle = await sash.boundingBox();
    assert.ok(handle, 'the Composer sash has no box for a touch drag');
    const before = await page.locator('#prompt').evaluate((node) => node.getBoundingClientRect().height);
    const start = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
    const client = await page.context().newCDPSession(page);
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ ...start, id: 1 }],
    });
    for (let distance = 20; distance <= 220; distance += 20) {
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: start.x, y: start.y - distance, id: 1 }],
      });
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.evaluate(SETTLED);
    const after = await page.locator('#prompt').evaluate((node) => node.getBoundingClientRect().height);
    const saved = (await page.evaluate(
      `window.__posted.filter((message) => message.type === 'saveState').at(-1)?.state?.promptFloor`,
    )) as number;
    assert.equal(
      await sash.evaluate((node) => getComputedStyle(node).touchAction),
      'none',
      'the Composer sash lets a touch drag become page scrolling',
    );
    assert.ok(after > before + 190, `the 220px touch drag raised the Composer by only ${after - before}px`);
    assert.ok(saved > 3.6, 'the complete touch drag did not save its Composer height');
  } finally {
    await browser.close();
  }
});

test('a second touch cannot move or end the active composer resize', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 720, height: 900 });
    await page.setContent(pageHtml());
    await post(page, renderPayload());
    const sash = page.locator('#footsash');
    const handle = await sash.boundingBox();
    assert.ok(handle, 'the Composer sash has no box for concurrent touch input');
    const before = await page.locator('#prompt').evaluate((node) => node.getBoundingClientRect().height);
    await page.evaluate(`window.__posted = []`);
    const result = await sash.evaluate(
      async (node, startY) => {
        node.setPointerCapture = () => {};
        const touch = (type: string, pointerId: number, clientY: number, isPrimary: boolean) => {
          node.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              button: 0,
              clientY,
              isPrimary,
              pointerId,
              pointerType: 'touch',
            }),
          );
        };
        touch('pointerdown', 1, startY, true);
        touch('pointerdown', 2, startY, false);
        touch('pointermove', 2, startY - 240, false);
        const afterSecondMove = document.getElementById('prompt')!.getBoundingClientRect().height;
        touch('pointerup', 2, startY - 240, false);
        touch('pointermove', 1, startY - 160, true);
        touch('pointerup', 1, startY - 160, true);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        return {
          afterSecondMove,
          height: document.getElementById('prompt')!.getBoundingClientRect().height,
        };
      },
      handle.y + handle.height / 2,
    );
    await page.evaluate(SETTLED);
    const saves = (await page.evaluate(
      `window.__posted.filter((message) => message.type === 'saveState').length`,
    )) as number;
    assert.ok(Math.abs(result.afterSecondMove - before) <= 1, 'moving a second touch resized the Composer');
    assert.ok(
      result.height > before + 130,
      `ending a second touch stopped the active resize after only ${result.height - before}px`,
    );
    assert.equal(saves, 1, 'the second touch started another resize');
  } finally {
    await browser.close();
  }
});

test('the composer sash ignores right-button drags', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 720, height: 900 });
    await page.setContent(pageHtml());
    await post(page, renderPayload());
    const sash = page.locator('#footsash');
    const handle = await sash.boundingBox();
    assert.ok(handle, 'the Composer sash has no box for right-button input');
    const before = await page.locator('#prompt').evaluate((node) => node.getBoundingClientRect().height);
    await page.evaluate(`window.__posted = []`);
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(handle.x + handle.width / 2, handle.y - 100);
    await page.mouse.up({ button: 'right' });
    await page.evaluate(SETTLED);
    const result = (await page.evaluate(`(() => ({
      height: document.getElementById('prompt').getBoundingClientRect().height,
      saves: window.__posted.filter((message) => message.type === 'saveState').length,
    }))()`)) as { height: number; saves: number };
    assert.ok(Math.abs(result.height - before) <= 1, 'a right-button drag resized the Composer');
    assert.equal(result.saves, 0, 'a right-button drag saved a Composer height');
  } finally {
    await browser.close();
  }
});

test('forgetting state restores and saves the default composer floor', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 720, height: 900 });
    await page.setContent(recoveryPage({}));
    await post(page, renderPayload());
    const sash = page.locator('#footsash');
    const prompt = page.locator('#prompt');
    const starting = await prompt.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        height: node.getBoundingClientRect().height,
        floor: Number.parseFloat(style.minHeight) / Number.parseFloat(style.fontSize),
      };
    });
    for (let line = 0; line < 7; line++) {
      await sash.press('ArrowUp');
    }
    const raised = await prompt.evaluate((node) => node.getBoundingClientRect().height);
    assert.ok(raised > starting.height + 40, 'the fixture did not raise the Composer floor');

    await page.evaluate(`window.__posted = []`);
    await post(page, { type: 'forgetState', since: 17 });
    const forgottenHeight = await prompt.evaluate((node) => node.getBoundingClientRect().height);
    const savedFloor = (await page.evaluate(`window.__saved.promptFloor`)) as number;
    assert.ok(
      Math.abs(forgottenHeight - starting.height) <= 2,
      'forgetting state left the raised Composer floor visible',
    );
    assert.ok(Math.abs(savedFloor - starting.floor) <= 0.1, 'forgetting state saved the raised Composer floor again');
    assert.equal(
      await page.evaluate(`window.__posted.filter((message) => message.type === 'saveState').length`),
      0,
      'reset echoed cleared preferences to the host',
    );
  } finally {
    await browser.close();
  }
});

test('automatic text growth updates the composer separator value', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 720, height: 900 });
    await page.setContent(pageHtml());
    await post(page, renderPayload());
    const sash = page.locator('#footsash');
    const prompt = page.locator('#prompt');
    await sash.press('Home');
    const before = Number(await sash.getAttribute('aria-valuenow'));
    await prompt.fill(Array.from({ length: 8 }, (_, at) => `line ${at}`).join('\n'));
    await page.evaluate(SETTLED);
    const automatic = await prompt.evaluate((node) => {
      const style = getComputedStyle(node);
      const content =
        node.getBoundingClientRect().height -
        Number.parseFloat(style.paddingTop) -
        Number.parseFloat(style.paddingBottom);
      return Math.ceil(content / Number.parseFloat(style.lineHeight) - 1e-9);
    });
    assert.ok(automatic > before, 'the fixture did not grow the prompt beyond its starting height');
    assert.equal(
      Number(await sash.getAttribute('aria-valuenow')),
      automatic,
      'automatic text growth left the separator value at its earlier height',
    );
  } finally {
    await browser.close();
  }
});

test('lowering long text restores automatic prompt sizing after it clears', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 720, height: 900 });
    await page.setContent(pageHtml());
    await post(page, renderPayload());
    const sash = page.locator('#footsash');
    const prompt = page.locator('#prompt');
    const startingHeight = await prompt.evaluate((node) => node.getBoundingClientRect().height);
    const longText = Array.from({ length: 24 }, (_, at) => `line ${at}`).join('\n');

    await prompt.fill(longText);
    await sash.press('Home');
    await prompt.fill('');
    await page.evaluate(SETTLED);
    const afterHome = await prompt.evaluate((node) => node.getBoundingClientRect().height);
    assert.ok(
      Math.abs(afterHome - startingHeight) <= 2,
      'clearing long text after Home kept the automatic text height as the saved floor',
    );

    await prompt.fill(longText);
    await sash.press('End');
    await sash.press('Home');
    await prompt.fill('');
    await page.evaluate(SETTLED);
    const afterDrag = await prompt.evaluate((node) => node.getBoundingClientRect().height);
    assert.ok(
      Math.abs(afterDrag - startingHeight) <= 2,
      'clearing long text after a downward drag kept the automatic text height as the saved floor',
    );
  } finally {
    await browser.close();
  }
});

test('the composer separator reports exact visible lines for every resize key', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 720, height: 900 });
    await page.setContent(pageHtml());
    await post(page, renderPayload());
    const sash = page.locator('#footsash');
    const value = async () =>
      await sash.evaluate((node) => ({
        minimum: Number(node.getAttribute('aria-valuemin')),
        maximum: Number(node.getAttribute('aria-valuemax')),
        now: Number(node.getAttribute('aria-valuenow')),
        text: node.getAttribute('aria-valuetext'),
      }));

    await sash.press('Home');
    assert.deepEqual(await value(), { minimum: 3, maximum: 32, now: 3, text: '3 lines' });
    await sash.press('ArrowUp');
    assert.equal((await value()).now, 4, 'ArrowUp did not add exactly one visible line');
    await sash.press('ArrowDown');
    assert.equal((await value()).now, 3, 'ArrowDown did not remove exactly one visible line');
    await sash.press('End');
    const ended = await value();
    assert.deepEqual(ended, {
      minimum: 3,
      maximum: ended.maximum,
      now: ended.maximum,
      text: `${ended.maximum} lines`,
    });
  } finally {
    await browser.close();
  }
});

test('a larger editor font keeps a ten-line prompt below the session heading', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 720, height: 500 });
    await page.setContent(themed(pageHtml()));
    await post(page, renderPayload());
    const prompt = page.locator('#prompt');
    // Increase the editor font size to check the live height update.
    await page.evaluate(`document.body.style.setProperty('--vscode-font-size', '22px')`);
    await prompt.fill(Array.from({ length: 10 }, (_, at) => `line ${at}`).join('\n'));
    await page.evaluate(SETTLED);
    const measured = (await page.evaluate(`(() => {
      const heading = document.querySelector('#list .sessionsection:not([hidden]) > .sessionrow');
      const composer = document.getElementById('composer');
      const prompt = document.getElementById('prompt');
      const sash = document.getElementById('footsash');
      const style = getComputedStyle(prompt);
      const visibleLines = Math.ceil((prompt.getBoundingClientRect().height
        - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom))
        / Number.parseFloat(style.lineHeight) - 1e-9);
      return {
        headingBottom: heading.getBoundingClientRect().bottom,
        composerTop: composer.getBoundingClientRect().top,
        visibleLines,
        minimum: Number(sash.getAttribute('aria-valuemin')),
        maximum: Number(sash.getAttribute('aria-valuemax')),
        now: Number(sash.getAttribute('aria-valuenow')),
        text: sash.getAttribute('aria-valuetext'),
      };
    })()`)) as {
      headingBottom: number;
      composerTop: number;
      visibleLines: number;
      minimum: number;
      maximum: number;
      now: number;
      text: string;
    };
    assert.ok(
      measured.composerTop >= measured.headingBottom - 1,
      'the larger editor font let the Composer cover the session heading',
    );
    assert.ok(measured.visibleLines < 10, 'the fixture did not require a viewport ceiling');
    assert.deepEqual(
      { minimum: measured.minimum, maximum: measured.maximum, now: measured.now, text: measured.text },
      {
        minimum: 3,
        maximum: measured.visibleLines,
        now: measured.visibleLines,
        text: `${measured.visibleLines} lines`,
      },
      'the Composer separator did not report the visible line range after the font change',
    );
  } finally {
    await browser.close();
  }
});

test('a session heading that grows after End lowers the composer ceiling', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 720, height: 600 });
    await page.setContent(pageHtml());
    const payload = renderPayload();
    const cards = payload.cards as Array<Record<string, unknown>>;
    const copiedCards = (sessionId: string, prefix: string) =>
      cards.slice(0, 4).map((card, index) => ({
        ...card,
        sessionId,
        key: `${prefix}-${index}`,
      }));
    await post(page, {
      ...payload,
      cards: [...cards, ...copiedCards('s2', 'scroll-middle'), ...copiedCards('s3', 'scroll-tail')],
    });
    await page.locator('#footsash').press('End');
    const before = await page
      .locator('#list .sessionsection[data-session="s1"] > .sessionrow')
      .evaluate((node) => node.getBoundingClientRect().height);
    const moreStats = Array.from({ length: 10 }, (_, index) => ({
      metric: `late-${index}`,
      kind: 'plain',
      label: `late session figure ${index + 1}`,
      detail: '',
    }));
    await post(page, {
      type: 'rail',
      rail: payload.rail,
      labels: payload.labels,
      views: payload.views,
      railFilters: payload.railFilters,
      hidden: payload.hidden,
      pinnedTop: payload.pinnedTop,
      stats: {
        ...(payload.stats as object),
        s1: moreStats,
        s2: [
          ...moreStats,
          ...moreStats.slice(0, 5).map((stat, index) => ({
            ...stat,
            metric: `active-${index}`,
            label: `active session figure ${index + 1}`,
          })),
        ],
      },
    });
    const measured = (await page.evaluate(`(() => {
      const heading = document.querySelector('#list .sessionsection[data-session="s1"] > .sessionrow');
      const composer = document.getElementById('composer');
      return {
        headingHeight: heading.getBoundingClientRect().height,
        headingBottom: heading.getBoundingClientRect().bottom,
        composerTop: composer.getBoundingClientRect().top,
      };
    })()`)) as { headingHeight: number; headingBottom: number; composerTop: number };
    assert.ok(measured.headingHeight > before + 20, 'the later figures did not grow the session heading');
    assert.ok(
      measured.composerTop >= measured.headingBottom - 1,
      'the Composer kept its earlier ceiling and covered the grown session heading',
    );

    await page.evaluate(`(() => {
      const heading = document.querySelector('.sessionsection[data-session="s2"] > .sessionrow');
      window.scrollTo(0, heading.offsetTop + 2);
    })()`);
    await page.waitForFunction(`(() => {
      const heading = document.querySelector('.sessionsection[data-session="s2"] > .sessionrow');
      const composer = document.getElementById('composer');
      if (!heading || !composer) return false;
      const box = heading.getBoundingClientRect();
      return window.scrollY > 0 && box.top <= 2 && composer.getBoundingClientRect().top >= box.bottom - 1;
    })()`);
    const scrolled = (await page.evaluate(`(() => {
      const heading = document.querySelector('.sessionsection[data-session="s2"] > .sessionrow');
      const composer = document.getElementById('composer');
      return {
        scrollY: window.scrollY,
        headingTop: heading.getBoundingClientRect().top,
        headingBottom: heading.getBoundingClientRect().bottom,
        composerTop: composer.getBoundingClientRect().top,
      };
    })()`)) as { scrollY: number; headingTop: number; headingBottom: number; composerTop: number };
    assert.ok(
      scrolled.scrollY > 0 && scrolled.headingTop <= 2,
      'the second session heading did not become active during scrolling',
    );
    assert.ok(
      scrolled.composerTop >= scrolled.headingBottom - 1,
      'the Composer kept the first heading ceiling after a taller heading became active',
    );
  } finally {
    await browser.close();
  }
});

test('Servers menu keyboard controls retain actions through host updates', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no browser');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(themed(pageHtml()));
    const payload = renderPayload();
    const view = composerView(COMPOSER);
    assert.ok(view);
    view.picks = [
      ...view.picks.filter((pick) => pick.control !== 'mcp'),
      {
        control: 'mcp',
        label: 'Servers',
        name: 'Servers',
        detail: '',
        disabled: false,
        caution: false,
      },
    ];
    const menu = {
      control: 'mcp',
      agent: 'claude',
      session: view.sessionId,
      head: 'Servers',
      items: [
        { kind: 'status', value: 'pending', label: 'Connecting', name: 'Connecting' },
        { kind: 'action', value: 'refresh', label: 'Refresh', name: 'Refresh servers' },
        { kind: 'toggle', value: 'alpha', label: 'Alpha', name: 'Alpha enabled', checked: true },
        { kind: 'action', value: 'beta', label: 'Beta', name: 'Beta reconnect' },
      ],
    };
    const usage = { ...(payload.usage as object), composer: view, menus: { mcp: menu } };
    await post(page, { ...payload, usage });
    await page.evaluate(
      'window.__escaped = 0; document.addEventListener("keydown", e => { if(e.key === "Escape") window.__escaped++; });',
    );
    const trigger = page.locator('[data-control="mcp"]');
    const focused = () => page.evaluate('document.activeElement?.dataset.control ?? null');
    await trigger.focus();
    await trigger.press('ArrowDown');
    assert.equal(await focused(), 'mcp:refresh');
    assert.equal(await page.locator('#pickpop').getAttribute('role'), 'menu');
    assert.equal(await page.locator('[data-control="mcp:alpha"]').getAttribute('role'), 'menuitemcheckbox');
    assert.equal(await page.locator('#pickpop button[tabindex="0"]').count(), 1);
    await page.keyboard.press('ArrowDown');
    assert.equal(await focused(), 'mcp:alpha');
    await page.keyboard.press('Space');
    assert.equal(await page.locator('#pickpop').isVisible(), true);
    assert.equal(await focused(), 'mcp:alpha');
    menu.items[2].checked = false;
    await post(page, { type: 'usage', usage });
    assert.equal(await focused(), 'mcp:alpha');
    assert.equal(await page.locator('[data-control="mcp:alpha"]').getAttribute('aria-checked'), 'false');
    await page.keyboard.press('End');
    assert.equal(await focused(), 'mcp:beta');
    await page.keyboard.press('Home');
    assert.equal(await focused(), 'mcp:refresh');
    await page.keyboard.press('b');
    assert.equal(await focused(), 'mcp:beta');
    await page.keyboard.press('Escape');
    assert.equal(await focused(), 'mcp');
    assert.equal(await page.evaluate('window.__escaped'), 0);
    await trigger.press('ArrowUp');
    assert.equal(await focused(), 'mcp:beta');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.locator('#pickpop').isHidden(), true);
    assert.notEqual(await focused(), 'mcp');
    await trigger.press('ArrowDown');
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('#pickpop').isHidden(), true);
    assert.notEqual(await focused(), 'mcp');
    await trigger.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.equal(await focused(), 'mcp');
    assert.equal(await page.locator('#pickpop').isHidden(), true);
    assert.deepEqual(await page.evaluate('window.__posted.filter(m => m.type === "pick").map(m => m.value)'), [
      'alpha',
      'refresh',
    ]);
    await page.evaluate('Date.now = () => 1000000');
    menu.items = [menu.items[0], menu.items[3], menu.items[2], menu.items[1]];
    await post(page, { type: 'usage', usage });
    const reopened = [];
    for (const close of ['action', 'pointer', 'host']) {
      await trigger.press('ArrowDown');
      await page.keyboard.press('r');
      assert.equal(await focused(), 'mcp:refresh');
      if (close === 'action') {
        await page.keyboard.press('Enter');
        await page.evaluate(SETTLED);
        await page.waitForFunction(() => document.activeElement?.getAttribute('data-control') === 'mcp');
      } else {
        await page.mouse.click(10, 10);
      }
      assert.equal(await page.locator('#pickpop').isHidden(), true);
      if (close === 'host') await post(page, { type: 'openPick', control: 'mcp' });
      else await trigger.press('ArrowDown');
      await page.keyboard.press('a');
      reopened.push({ close, focused: await focused() });
      await page.keyboard.press('Escape');
    }
    assert.deepEqual(
      reopened,
      ['action', 'pointer', 'host'].map((close) => ({ close, focused: 'mcp:alpha' })),
    );
    menu.items[3].label = 'Lumen';
    await post(page, { type: 'usage', usage });
    await trigger.press('ArrowDown');
    await page.keyboard.press('a');
    await page.keyboard.press('Space');
    await post(page, { type: 'usage', usage });
    await page.keyboard.press('Home');
    await page.keyboard.press('l');
    assert.equal(await focused(), 'mcp:alpha');
    await post(page, { type: 'openPick', control: 'mcp' });
    await page.keyboard.press('p');
    assert.equal(await focused(), 'mcp:alpha');
    await page.keyboard.press('Escape');
    menu.items[3].label = 'Refresh';
    menu.items = [menu.items[0], menu.items[3], menu.items[2], menu.items[1]];
    const ready = [...menu.items];
    menu.items = menu.items.slice(0, 1);
    await post(page, { type: 'usage', usage });
    await trigger.press('ArrowDown');
    assert.equal(await page.evaluate('document.activeElement?.id'), 'pickpop');
    menu.items = ready;
    await post(page, { type: 'usage', usage });
    assert.equal(await focused(), 'mcp:refresh');
    menu.items = ready.filter((item) => item.value !== 'refresh');
    await post(page, { type: 'usage', usage });
    assert.equal(await focused(), 'mcp:alpha');
    view.picks.find((pick) => pick.control === 'mcp')!.disabled = true;
    await post(page, { type: 'usage', usage });
    assert.equal(await page.locator('#pickpop').isHidden(), true);
    assert.equal(await page.evaluate('document.activeElement?.id'), 'prompt');
  } finally {
    await browser.close();
  }
});

test('Composer choices keep DOM focus and commit only when accepted', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no browser');
    return;
  }
  try {
    for (const agent of ['claude', 'codex'] as const) {
      const page = await browser.newPage();
      await page.setContent(themed(pageHtml(), 'dark'));
      const models = Array.from({ length: 24 }, (_, index) => ({
        value: `model-${index}`,
        label: `Model ${index}`,
        description: `Choice ${index}`,
        efforts: [
          { value: 'low', label: 'low', description: 'Less reasoning' },
          { value: 'high', label: 'high', description: 'More reasoning' },
        ],
      }));
      const state = {
        ...COMPOSER,
        agent,
        models,
        settings: { ...COMPOSER.settings, selectedModel: 'model-0', selectedEffort: 'high' },
      };
      const payload = renderPayload();
      payload.usage = {
        ...(payload.usage as object),
        composer: composerView(state),
        menus: Object.fromEntries(['model', 'effort', 'askmode'].map((control) => [control, pickMenu(control, state)])),
      };
      await post(page, payload);
      const model = page.locator('[data-control="model"]');
      await model.focus();
      await model.press('ArrowDown');
      await model.press('PageDown');
      assert.equal(await model.evaluate((node) => node === document.activeElement), true);
      const active = await model.getAttribute('aria-activedescendant');
      assert.ok(active);
      assert.equal(await page.locator(`[id="${active}"]`).getAttribute('role'), 'option');
      assert.equal(await page.locator(`[id="${active}"]`).getAttribute('aria-selected'), 'false');
      assert.deepEqual(
        await page
          .locator('#composer-model-list [role="option"]')
          .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).tabIndex)),
        models.map(() => -1),
      );
      assert.equal(await page.evaluate('window.__posted.filter((message) => message.type === "pick").length'), 0);
      await model.press('Escape');
      assert.equal(await model.getAttribute('aria-activedescendant'), null);
      assert.equal(await model.evaluate((node) => node === document.activeElement), true);
      await model.press('z');
      await model.press('Tab');
      assert.equal(await page.evaluate('window.__posted.filter((message) => message.type === "pick").length'), 0);
      await model.focus();
      await model.press('ArrowDown');
      await page.locator('#composer-model-list [role="option"]').last().hover();
      await page.locator('#prompt').click();
      assert.equal(await page.evaluate('window.__posted.filter((message) => message.type === "pick").length'), 0);
      await model.focus();
      await model.press('Space');
      await model.press('End');
      const last = page.locator('#composer-model-list [role="option"]').last();
      assert.equal(
        await last.evaluate((node) => {
          const row = node.getBoundingClientRect();
          const box = node.parentElement!.getBoundingClientRect();
          return row.bottom <= box.bottom + 1;
        }),
        true,
      );
      await model.press('Tab');
      assert.equal(
        await page.locator('[data-control="effort"]').evaluate((node) => node === document.activeElement),
        true,
      );
      assert.deepEqual(
        await page.evaluate(
          'window.__posted.filter((message) => message.type === "pick").map((message) => message.value)',
        ),
        ['model-23'],
      );
      const effort = page.locator('[data-control="effort"]');
      const delayed = {
        ...state,
        models: models.map((item, index) => (index === 23 ? { ...item, efforts: [] } : item)),
        settings: { ...state.settings, selectedModel: 'model-23', selectedEffort: '' },
      };
      await post(page, {
        type: 'usage',
        usage: {
          ...(payload.usage as object),
          composer: composerView(delayed),
          menus: Object.fromEntries(
            ['model', 'effort', 'askmode'].map((control) => [control, pickMenu(control, delayed)]),
          ),
        },
      });
      await page.waitForFunction(() => document.activeElement?.getAttribute('data-control') === 'askmode');
      assert.equal(await effort.isDisabled(), true);
      await post(page, { type: 'usage', usage: payload.usage });
      await effort.focus();
      await effort.press('Home');
      await effort.press('Shift+Tab');
      assert.equal(await model.evaluate((node) => node === document.activeElement), true);
      assert.deepEqual(
        await page.evaluate(
          'window.__posted.filter((message) => message.type === "pick").map((message) => message.value)',
        ),
        ['model-23', 'low'],
      );
      await model.press('ArrowDown');
      await model.press('m');
      await model.press('m');
      assert.notEqual(await model.getAttribute('aria-activedescendant'), 'composer-model-option-model-0');
      await model.press('Escape');
      await model.press('ArrowDown');
      const usage = payload.usage as { composer: { sessionId: string }; menus: Record<string, { session: string }> };
      usage.composer.sessionId = 'another-session';
      for (const menu of Object.values(usage.menus)) menu.session = 'another-session';
      await post(page, { type: 'usage', usage });
      assert.equal(await page.locator('#composer-model-list').isHidden(), true);
      assert.equal(await model.getAttribute('aria-activedescendant'), null);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

function recoveryPage(browserState: unknown, hostState: unknown = {}, failWrite = false): string {
  return themed(
    pageHtml()
      .replace(
        'const SAVED_STATE = {};',
        `const SAVED_STATE = ${JSON.stringify(hostState)}; window.__saved = ${JSON.stringify(browserState)};`,
      )
      .replace('getState: () => ({}),', 'getState: () => window.__saved,')
      .replace(
        'setState: () => undefined,',
        failWrite
          ? "setState: (state) => { if (state.submittedPrompts?.length) throw new Error('storage full'); window.__saved = state; },"
          : 'setState: (state) => { window.__saved = state; },',
      ),
  );
}

test('prompt recall stays in its session across submissions, switches, and reloads', { timeout: 60000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no browser');
    return;
  }
  try {
    for (const agent of ['claude', 'codex'] as const) {
      const page = await browser.newPage();
      await page.setContent(recoveryPage({}));
      const view = (sessionId: string) =>
        composerView({ ...COMPOSER, agent, sessionId, history: [], draft: '', onScreen: '' });
      const select = (session: string) =>
        post(page, { type: 'usage', usage: usageWith(renderPayload(), view(session)) });
      const prompt = page.locator('#prompt');
      await select('session-a');
      await prompt.fill('prompt from session a');
      await prompt.press('Enter');
      await page.waitForFunction(() => (window as any).__saved.submittedPrompts?.length === 1);
      await select('session-b');
      await prompt.fill('prompt from session b');
      await prompt.press('Enter');
      await page.waitForFunction(() => (window as any).__saved.submittedPrompts?.length === 2);
      await prompt.fill('draft for session b');
      await prompt.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(0, 0));
      await prompt.press('ArrowUp');
      assert.equal(await prompt.inputValue(), 'prompt from session b');
      await prompt.press('ArrowUp');
      assert.equal(await prompt.inputValue(), 'prompt from session b');
      await prompt.press('ArrowDown');
      assert.equal(await prompt.inputValue(), 'draft for session b');
      await prompt.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(0, 0));
      await prompt.press('ArrowUp');
      await select('session-a');
      await prompt.press('ArrowUp');
      assert.equal(await prompt.inputValue(), 'prompt from session a');
      await prompt.press('ArrowDown');
      assert.equal(await prompt.inputValue(), '');
      await select('session-b');
      assert.equal(await prompt.inputValue(), 'draft for session b');
      const saved = await page.evaluate(() => (window as any).__saved);
      const fresh = await browser.newPage();
      await fresh.setContent(recoveryPage(saved, { submittedPrompts: [] }));
      await post(fresh, { type: 'usage', usage: usageWith(renderPayload(), view('session-a')) });
      const restored = fresh.locator('#prompt');
      await restored.focus();
      await restored.press('ArrowUp');
      assert.equal(await restored.inputValue(), 'prompt from session a');
      await restored.press('ArrowUp');
      assert.equal(await restored.inputValue(), 'prompt from session a');
      await post(fresh, { type: 'usage', usage: usageWith(renderPayload(), view('session-c')) });
      await restored.press('ArrowUp');
      assert.equal(await restored.inputValue(), '');
      assert.equal(
        await fresh.evaluate(() => (window as any).__posted.filter((m: any) => m.type === 'sendPrompt').length),
        0,
      );
      await post(fresh, {
        type: 'promptRecovery',
        submittedPrompts: [
          { id: 'adopted', order: 3, source: 'draft:s1', revision: 1, text: 'first adopted prompt' },
          {
            id: 'routed',
            order: 4,
            source: 'session-c',
            owner: 'session-d',
            ownerRevision: 1,
            revision: 1,
            text: 'routed prompt',
          },
          { id: 'foreign', order: 5, source: 'session-z', revision: 1, text: 'foreign prompt' },
        ],
      });
      const adopted = renderPayload();
      adopted.showing = 'session-e';
      adopted.usage = usageWith(adopted, view('session-e'));
      adopted.sessionAdoptions = [{ provisional: 'draft:s1', durable: 'session-e' }];
      await post(fresh, adopted);
      await restored.press('ArrowUp');
      assert.equal(await restored.inputValue(), 'first adopted prompt');
      await restored.press('ArrowUp');
      assert.equal(await restored.inputValue(), 'first adopted prompt');
      await post(fresh, { type: 'usage', usage: usageWith(renderPayload(), view('session-c')) });
      await restored.press('ArrowUp');
      assert.equal(await restored.inputValue(), '');
      await post(fresh, { type: 'usage', usage: usageWith(renderPayload(), view('session-d')) });
      await restored.press('ArrowUp');
      assert.equal(await restored.inputValue(), 'routed prompt');
      const destinationSaved = await fresh.evaluate(() => (window as any).__saved);
      await fresh.setContent(recoveryPage(destinationSaved, { submittedPrompts: [] }));
      await post(fresh, { type: 'usage', usage: usageWith(renderPayload(), view('session-d')) });
      await restored.focus();
      await restored.press('ArrowUp');
      assert.equal(await restored.inputValue(), 'routed prompt');
      await fresh.close();
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test.for(['ArrowUp', 'ArrowDown'])(
  'prompt recall follows ownership updates during an active walk (%s)',
  { timeout: 60000 },
  async (removedDirection, t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no browser');
      return;
    }
    try {
      for (const agent of ['claude', 'codex'] as const) {
        const page = await browser.newPage();
        const attempts = [
          { id: 'older', order: 1, source: 'session-a', revision: 1, text: 'older prompt' },
          { id: 'newer', order: 2, source: 'session-a', revision: 2, text: 'newer prompt' },
        ];
        await page.setContent(recoveryPage({ submittedPrompts: attempts }));
        const view = composerView({ ...COMPOSER, agent, sessionId: 'session-a', history: [], draft: '', onScreen: '' });
        await post(page, { type: 'usage', usage: usageWith(renderPayload(), view) });
        const prompt = page.locator('#prompt');
        await prompt.fill('original unsent draft');
        await prompt.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(0, 0));
        await prompt.press('ArrowUp');
        assert.equal(await prompt.inputValue(), 'newer prompt');
        await post(page, {
          type: 'promptRecovery',
          submittedPrompts: [{ ...attempts[0], owner: 'session-b', ownerRevision: 1 }],
        });
        await prompt.press('ArrowUp');
        assert.equal(await prompt.inputValue(), 'newer prompt', "active recall offered another session's older prompt");
        await prompt.press('ArrowDown');
        assert.equal(await prompt.inputValue(), 'original unsent draft');
        await prompt.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(0, 0));
        await prompt.press('ArrowUp');
        await post(page, {
          type: 'promptRecovery',
          submittedPrompts: [{ ...attempts[1], owner: 'session-b', ownerRevision: 1 }],
        });
        await prompt.press(removedDirection);
        assert.equal(await prompt.inputValue(), 'original unsent draft', 'recall retained a moved displayed prompt');
        await prompt.press('ArrowDown');
        assert.equal(await prompt.inputValue(), 'original unsent draft');
        assert.equal(
          await page.evaluate(() => (window as any).__posted.filter((m: any) => m.type === 'sendPrompt').length),
          0,
        );
        await page.close();
      }
    } finally {
      await browser.close();
    }
  },
);

test.for([false, true])(
  'reconstructed recovery recalls maximum exact text through a fresh provider (failed storage %s)',
  { timeout: 60000 },
  async (failed, t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no browser');
      return;
    }
    vi.stubGlobal('PANEL_CSS', '');
    vi.stubGlobal('PANEL_JS', '');
    vi.stubGlobal('PANEL_DEV_SERVER_URL', null);
    const { PanelProvider } = await import('../panelhost.ts');
    const listener = vi
      .spyOn(PanelProvider.prototype as unknown as { wireEditorListeners(): void }, 'wireEditorListeners')
      .mockImplementation(() => {});
    const notice = (vscode.window as any).showInformationMessage;
    (vscode.window as any).showInformationMessage = () => Promise.resolve();
    const attempts = Array.from({ length: 5 }, (_, index) => ({
      id: `maximum-${index}`,
      order: index + 1,
      source: COMPOSER.sessionId,
      revision: 1,
      text: ` ${index}\n` + 'x'.repeat(19_994) + '\n  ',
    }));
    let stored: unknown = { submittedPrompts: failed ? [] : attempts };
    const memento = {
      get: () => structuredClone(stored),
      update: async (_key: string, value: unknown) => {
        if (failed) throw new Error('full');
        stored = structuredClone(value);
      },
    } as unknown as vscode.Memento;
    const owner = new PanelProvider('', {} as vscode.Uri, memento);
    const provider = owner as unknown as Record<string, any>;
    const pages: Page[] = [];
    const panels: any[] = [];
    try {
      for (const index of [0, 1]) {
        const page = await browser.newPage();
        pages.push(page);
        const panel: any = {
          options: { retainContextWhenHidden: true, enableFindWidget: true },
          disposed: false,
          revealed: false,
          dispose() {
            this.disposed = true;
          },
          reveal() {
            this.revealed = true;
          },
          onDidDispose: () => ({ dispose() {} }),
          onDidChangeViewState: () => ({ dispose() {} }),
        };
        panel.webview = { postMessage: (message: unknown) => post(page, message) };
        panels.push(panel);
        const host = { webview: panel.webview };
        await page.exposeFunction('__host', (message: any) =>
          message.type === 'importPromptRecovery' ? provider.onMessage(message, host) : undefined,
        );
        const initial = failed ? (index ? attempts.slice(1) : attempts.slice(0, 1)) : attempts;
        const html = recoveryPage({ submittedPrompts: initial }, failed ? {} : stored).replace(
          'postMessage: (m) => window.__posted.push(m),',
          'postMessage: (m) => { window.__posted.push(m); window.__host(m); },',
        );
        await page.route('https://arc-recovery.test/**', (route) =>
          route.fulfill({ contentType: 'text/html', body: html }),
        );
        await page.goto('https://arc-recovery.test/');
      }
      const previousHost = { webview: panels[0].webview };
      Object.assign(provider, {
        editorPanel: panels[0],
        hosts: [previousHost],
        readyHosts: new Set(),
        attach: (host: unknown) => provider.hosts.push(host),
        post: async (message: unknown) => {
          await Promise.all(pages.map((page) => post(page, message)));
        },
        sendToHost: (host: any, message: unknown) => host.webview.postMessage(message),
      });
      await provider.revivePanel(panels[1], { submittedPrompts: failed ? attempts.slice(1) : attempts });
      await vi.waitFor(() => assert.equal(failed ? panels[1].revealed : panels[0].disposed, true));
      assert.equal(panels[1].disposed, false);
      assert.deepEqual(provider.newDrafts, {});
      for (const page of failed ? pages : [pages[1]]) {
        await post(page, {
          type: 'usage',
          usage: usageWith(renderPayload(), composerView({ ...COMPOSER, history: [], draft: '', onScreen: '' })),
        });
        const prompt = page.locator('#prompt');
        await prompt.focus();
        for (const attempt of [...attempts].reverse()) {
          await prompt.press('ArrowUp');
          assert.equal(await prompt.inputValue(), attempt.text);
        }
        for (let index = 0; index < attempts.length; index++) await prompt.press('ArrowDown');
        assert.equal(await prompt.inputValue(), '');
        assert.equal(
          await page.evaluate(
            () => (window as any).__posted.filter((message: any) => message.type === 'sendPrompt').length,
          ),
          0,
        );
      }
      if (!failed) assert.deepEqual((stored as any).submittedPrompts, attempts);
    } finally {
      owner.dispose();
      listener.mockRestore();
      (vscode.window as any).showInformationMessage = notice;
      await browser.close();
    }
  },
);

test(
  'dropped-host Enter preserves a provisional first prompt across empty host state and a fresh browser lifetime',
  { timeout: 60000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no browser');
      return;
    }
    try {
      for (const agent of ['claude', 'codex'] as const) {
        const page = await browser.newPage();
        const profile = { agent, model: '', effort: '', permissionMode: '', source: 'custom' as const };
        const draft = newSessionDraft(`draft:recovery-${agent}`, '/project', null, 1000, profile);
        const composer = composerView(
          {
            ...COMPOSER,
            agent,
            sessionId: draft.draftId,
            profile: draft.profile,
            history: [],
            draft: '',
            onScreen: '',
          },
          Date.now(),
        );
        await page.setContent(recoveryPage({}));
        await post(page, { type: 'usage', usage: usageWith(renderPayload(), composer) });
        const text = '  first prompt\n' + 'x'.repeat(97_199) + '\n  ';
        const prompt = page.locator('#prompt');
        await prompt.fill(text);
        await prompt.press('Enter');
        await page.waitForFunction(() =>
          (window as any).__posted.some((message: any) => message.type === 'sendPrompt'),
        );
        assert.equal(await prompt.inputValue(), '');
        await prompt.press('ArrowUp');
        assert.equal(await prompt.inputValue(), text);
        const saved = await page.evaluate(() => (window as any).__saved);
        assert.equal(saved.submittedPrompts[0].text, text);
        assert.equal(saved.submittedPrompts[0].source, draft.draftId);
        const fresh = await browser.newPage();
        await fresh.setContent(recoveryPage(saved, { submittedPrompts: [] }));
        await post(fresh, { type: 'usage', usage: usageWith(renderPayload(), null) });
        assert.equal(await fresh.evaluate(() => (window as any).__saved.submittedPrompts[0].text), text);
        assert.equal(
          await fresh.evaluate(
            () => (window as any).__posted.filter((message: any) => message.type === 'sendPrompt').length,
          ),
          0,
        );
        await post(fresh, {
          type: 'usage',
          usage: usageWith(
            renderPayload(),
            composerView(
              {
                ...COMPOSER,
                agent,
                sessionId: draft.draftId,
                profile: draft.profile,
                history: [],
                draft: '',
                onScreen: '',
              },
              Date.now(),
            ),
          ),
        });
        const freshPrompt = fresh.locator('#prompt');
        await freshPrompt.fill('draft to retain');
        await freshPrompt.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(0, 0));
        await freshPrompt.press('ArrowUp');
        assert.equal(await freshPrompt.inputValue(), text);
        await freshPrompt.press('ArrowDown');
        assert.equal(await freshPrompt.inputValue(), 'draft to retain');
        await freshPrompt.press('ArrowUp');
        assert.equal(await freshPrompt.inputValue(), text);
        await fresh.locator('#prompt').press('Enter');
        const messages = await fresh.evaluate(() =>
          (window as any).__posted.filter((message: any) => message.type === 'sendPrompt'),
        );
        assert.equal(messages.length, 1);
        assert.equal(messages[0].session, draft.draftId);
        assert.equal(messages[0].text, text);
        await page.close();
        await fresh.close();
      }
    } finally {
      await browser.close();
    }
  },
);

test(
  'failed browser recovery persistence and oversized Enter retain visible text without posting',
  { timeout: 60000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no browser');
      return;
    }
    try {
      for (const failed of [true, false]) {
        const page = await browser.newPage();
        await page.setContent(recoveryPage({}, {}, failed));
        await post(page, {
          type: 'usage',
          usage: usageWith(renderPayload(), composerView({ ...COMPOSER, draft: '', onScreen: '' }, Date.now())),
        });
        const text = failed ? 'keep this exact prompt\n  ' : 'x'.repeat(SUBMITTED_PROMPT_CHARS + 1);
        await page.locator('#prompt').fill(text);
        await page.locator('#prompt').press('Enter');
        assert.equal(await page.locator('.cnotice').isVisible(), true);
        assert.ok((await page.locator('.cnotice').textContent())!.length > 0);
        assert.equal(await page.locator('#prompt').inputValue(), text);
        assert.equal(
          await page.evaluate(
            () => (window as any).__posted.filter((message: any) => message.type === 'sendPrompt').length,
          ),
          0,
        );
        await page.locator('#prompt').fill('edited prompt');
        assert.equal(await page.locator('.cnotice').count(), 0);
        await page.close();
      }
    } finally {
      await browser.close();
    }
  },
);
