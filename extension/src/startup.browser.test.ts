import { test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { CLAUDE_CHILD_REFERENCE_PARSER_VERSION } from './derivedcache';
import { normalizeFsPath } from './transcript';
import assert from 'node:assert/strict';
import { browserOrNone, SETTLED } from '../test/browser';
import { LIVE_PRESS, MAX_RAIL_FILTER_NAME, pageHtml, renderPayload, themed } from './panelfixture';
import { newestTurnLoading } from './turnview';

test('startup acknowledgements follow DOM application and a rendering opportunity for the current generation', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    const frames = `<script>window.__frames=[];
      window.requestAnimationFrame=(callback)=>{window.__frames.push(callback);return window.__frames.length;};
      window.__stepFrame=()=>{const callbacks=window.__frames.splice(0);for(const callback of callbacks)callback(performance.now());};</script>`;
    await page.setContent(pageHtml().replace('<head>', '<head>' + frames));
    assert.equal(await page.locator('[data-startup-status]').isVisible(), true);
    assert.equal(await page.evaluate('window.__posted.filter(m => m.type === "ready").length'), 0);
    await page.evaluate('window.__stepFrame()');
    assert.equal(await page.evaluate('window.__posted.filter(m => m.type === "ready").length'), 0);
    await page.evaluate('window.__stepFrame()');
    assert.equal(await page.evaluate('window.__posted.filter(m => m.type === "ready").length'), 1);
    const payload = renderPayload();
    await page.evaluate((value) => {
      window.dispatchEvent(
        new MessageEvent('message', { data: { ...value, cards: [], startup: { generation: 1, complete: false } } }),
      );
      window.dispatchEvent(
        new MessageEvent('message', { data: { ...value, startup: { generation: 2, complete: true } } }),
      );
    }, payload);
    assert.ok(await page.locator('article.turn').count());
    assert.equal(await page.evaluate('window.__posted.filter(m => m.type === "painted").length'), 0);
    await page.evaluate('window.__stepFrame()');
    assert.equal(await page.evaluate('window.__posted.filter(m => m.type === "painted").length'), 0);
    await page.evaluate('window.__stepFrame()');
    assert.deepEqual(await page.evaluate('window.__posted.filter(m => m.type === "painted")'), [
      { type: 'painted', generation: 2, stage: 'railReady', usableRows: true },
      { type: 'painted', generation: 2, stage: 'firstCard' },
      { type: 'painted', generation: 2, stage: 'completeRender' },
    ]);
    // A replacement within one generation still needs its own rendering opportunity.
    await page.evaluate((value) => {
      window.dispatchEvent(
        new MessageEvent('message', { data: { ...value, cards: [], startup: { generation: 3, complete: false } } }),
      );
      window.dispatchEvent(
        new MessageEvent('message', { data: { ...value, startup: { generation: 3, complete: true } } }),
      );
    }, payload);
    assert.ok(await page.locator('article.turn').count());
    assert.deepEqual(
      await page.evaluate('window.__posted.filter(m => m.type === "painted" && m.generation === 3)'),
      [],
    );
    await page.evaluate('window.__stepFrame()');
    assert.deepEqual(
      await page.evaluate('window.__posted.filter(m => m.type === "painted" && m.generation === 3)'),
      [],
    );
    await page.evaluate('window.__stepFrame()');
    assert.deepEqual(await page.evaluate('window.__posted.filter(m => m.type === "painted" && m.generation === 3)'), [
      { type: 'painted', generation: 3, stage: 'railReady', usableRows: true },
      { type: 'painted', generation: 3, stage: 'firstCard' },
      { type: 'painted', generation: 3, stage: 'completeRender' },
    ]);
  } finally {
    await browser.close();
  }
});

test('startup keeps the shell status through readiness, then replaces it with the selected loading state and first card', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    const saved = {
      railFilter: 'label:"release 0.4"',
      railFilterId: 'f2',
      railSort: 'latest',
      railDefaultSort: 'latest',
    };
    await page.setContent(
      pageHtml().replace('const SAVED_STATE = {};', `const SAVED_STATE = ${JSON.stringify(saved)};`),
    );
    await page.evaluate(SETTLED);
    const status = page.locator('[data-startup-status]');
    assert.equal(await status.isVisible(), true);
    assert.equal(await status.textContent(), 'Reading sessions…');
    assert.equal(await status.getAttribute('role'), 'status');
    assert.equal(await status.getAttribute('aria-live'), 'polite');
    assert.equal(await status.getAttribute('aria-atomic'), 'true');
    assert.equal(await status.getAttribute('tabindex'), null);
    assert.equal(await page.evaluate('window.__posted.filter(m => m.type === "ready").length'), 1);
    assert.equal(await page.evaluate('window.__posted.filter(m => m.type === "refresh").length'), 0);
    assert.equal(await page.locator('nav').first().isVisible(), true);
    // A restored query leaves the count on the rail head, and the magnifying glass opens the box.
    assert.equal(await page.locator('[data-control="railsearch"]').isVisible(), true);
    const payload = renderPayload();
    await page.evaluate((usage) => window.postMessage({ type: 'usage', usage }, '*'), payload.usage);
    await page.evaluate(SETTLED);
    assert.equal(await status.isVisible(), true, 'an early usage message removed the startup status');
    assert.equal(await page.locator('.railnew:visible').count(), 1);
    assert.equal(
      await page.locator('.compactnew:visible').count(),
      0,
      'wide startup showed the compact New control beside the rail control',
    );
    const loading = newestTurnLoading('Selected session', false).diagnosis;
    await page.evaluate((value) => window.postMessage(value, '*'), { ...payload, cards: [], diagnosis: loading });
    await page.evaluate(SETTLED);
    assert.equal(await status.count(), 0);
    assert.equal(await page.getByText(loading!.message, { exact: true }).isVisible(), true);
    const failed = 'Could not read this session. Select it to try again.';
    await page.evaluate((value) => window.postMessage(value, '*'), {
      ...payload,
      cards: [],
      diagnosis: { message: failed },
    });
    await page.evaluate(SETTLED);
    assert.equal(await page.getByText(failed, { exact: true }).isVisible(), true);
    const savedFilter = page.locator('[data-control="railfilters"]');
    assert.equal(await savedFilter.getAttribute('aria-label'), `View, ${MAX_RAIL_FILTER_NAME}, Latest update`);
    await page.evaluate((value) => window.postMessage(value, '*'), { ...payload, railFilters: [] });
    await page.evaluate(SETTLED);
    assert.equal(await savedFilter.getAttribute('aria-label'), 'View, All sessions, Latest update');
    await page.evaluate((value) => window.postMessage(value, '*'), payload);
    await page.evaluate(SETTLED);
    assert.ok(await page.locator('article.turn').count());
    assert.equal(await page.getByText(loading!.message, { exact: true }).count(), 0);
    assert.equal(await page.getByText(failed, { exact: true }).count(), 0);
  } finally {
    await browser.close();
  }
});

test('startup restores its status after pre-payload live work ends at wide and compact widths', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  try {
    for (const width of [1200, 520]) {
      const page = await browser.newPage();
      await page.setViewportSize({ width, height: 800 });
      await page.setContent(pageHtml());
      await page.evaluate(SETTLED);
      const livePayload = renderPayload([], [LIVE_PRESS]);
      await page.evaluate((usage) => window.postMessage({ type: 'usage', usage }, '*'), livePayload.usage);
      await page.evaluate(SETTLED);
      assert.equal(await page.locator('.clive').count(), 1, `live work did not replace the ${width}px startup status`);
      const idlePayload = renderPayload();
      await page.evaluate((usage) => window.postMessage({ type: 'usage', usage }, '*'), idlePayload.usage);
      await page.evaluate(SETTLED);
      assert.equal(
        await page.locator('[data-startup-status]').isVisible(),
        true,
        `the ${width}px panel did not restore Reading sessions after live work ended`,
      );
      assert.equal(await page.locator('article.turn').count(), 0);
      if (width >= 700) {
        assert.equal(await page.locator('.railnew:visible').count(), 1);
        assert.equal(await page.locator('.compactnew:visible').count(), 0);
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('startup progress ignores stale epochs and never replaces usable selected content', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    const saved = {
      railFilter: 'is:running -is:archived -is:agentrun',
      railFilterId: 'all',
      railQuickFilters: ['running', 'active'],
    };
    await page.setContent(
      themed(pageHtml().replace('const SAVED_STATE = {};', `const SAVED_STATE = ${JSON.stringify(saved)};`)),
    );
    await page.evaluate(SETTLED);
    const running = page.locator('[data-control="railcount:running"]');
    assert.equal(await running.isVisible(), true);
    assert.equal(await running.getAttribute('aria-pressed'), 'true');
    assert.equal(await running.locator('.railcountfig').count(), 0);
    await page.evaluate(() =>
      window.postMessage(
        {
          type: 'rail',
          rail: [],
          stats: {},
          labels: [],
          views: [],
          railFilters: [],
          sessionAdoptions: [],
          hidden: [],
          pinnedTop: [],
        },
        '*',
      ),
    );
    await page.evaluate(SETTLED);
    assert.equal(await running.isVisible(), true, 'a configuration reply hid the restored Running filter');
    assert.equal(await running.getAttribute('aria-pressed'), 'true');
    assert.equal(await running.locator('.railcountfig').count(), 0);
    const progress = { type: 'startupProgress', generation: 2, epoch: 'accepted', sequence: 3, completed: 1, known: 3 };
    await page.evaluate((value) => window.postMessage(value, '*'), progress);
    await page.waitForFunction(() =>
      document.querySelector('[data-startup-status]')?.textContent?.includes('known sources'),
    );
    const accepted = await page.locator('[data-startup-status]').textContent();
    for (const rejected of [
      { ...progress, sequence: 2, completed: 0 },
      { ...progress, epoch: 'obsolete', sequence: 4, completed: 0 },
      { ...progress, generation: 1, completed: 0 },
    ]) {
      await page.evaluate((value) => window.postMessage(value, '*'), rejected);
      await page.evaluate(SETTLED);
      assert.equal(await page.locator('[data-startup-status]').textContent(), accepted);
    }
    await page.evaluate((value) => window.postMessage(value, '*'), {
      ...renderPayload(),
      startup: { generation: 2, complete: false },
    });
    await page.evaluate(SETTLED);
    assert.equal(await page.locator('[data-startup-status]').count(), 0);
    const background = page.locator('nav [data-session-loading-status]');
    assert.equal(await background.isVisible(), true, 'usable selected content hid pending session-list work');
    assert.equal(await background.getAttribute('role'), 'status');
    assert.equal(await background.getAttribute('aria-live'), 'polite');
    assert.equal(await background.getAttribute('tabindex'), null);
    assert.equal(await running.count(), 0, 'an authoritative zero count retained the Running filter');
    const before = await page.locator('#list').textContent();
    await page.evaluate((value) => window.postMessage(value, '*'), { ...progress, sequence: 4, completed: 2 });
    await page.waitForFunction(() =>
      document.querySelector('[data-session-loading-status]')?.textContent?.includes('2 of 3'),
    );
    assert.equal(await page.locator('#list').textContent(), before);
    await page.evaluate((value) => window.postMessage(value, '*'), {
      ...renderPayload(),
      startup: { generation: 4, complete: true },
    });
    await page.evaluate(SETTLED);
    assert.equal(await background.isVisible(), false, 'completed session-list work retained loading status');
    for (const rejected of [
      { ...progress, generation: 3, sequence: 5 },
      { ...progress, generation: 3, sequence: 6, failed: true },
      { ...progress, generation: 4, sequence: 9 },
    ]) {
      await page.evaluate((value) => window.postMessage(value, '*'), rejected);
      await page.evaluate(SETTLED);
      assert.equal(await background.isVisible(), false, 'obsolete progress or failure resurrected status');
    }
    await page.evaluate((value) => window.postMessage(value, '*'), { ...progress, generation: 5, failed: true });
    await page.waitForFunction(() =>
      document.querySelector('[data-session-loading-status]')?.textContent?.includes('not read'),
    );
    assert.equal(
      await background.isVisible(),
      true,
      'background failure disappeared after selected content became usable',
    );
    assert.equal(await page.locator('#list').textContent(), before);
    await page.evaluate((value) => window.postMessage(value, '*'), { ...progress, generation: 6, complete: true });
    await page.waitForFunction(
      'window.__posted.some(message => message.type === "painted" && message.generation === 6 && message.stage === "completeRender")',
    );
    assert.equal(await background.isVisible(), false);
  } finally {
    await browser.close();
  }
});

test.for([
  { failed: false, pendingFirst: false },
  { failed: true, pendingFirst: false },
  { failed: false, pendingFirst: true },
  { failed: true, pendingFirst: true },
])('host checkpoint removal preserves browser terminal status: %j', async ({ failed, pendingFirst }, t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  try {
    vi.stubGlobal('PANEL_CSS', '');
    vi.stubGlobal('PANEL_JS', '');
    vi.stubGlobal('PANEL_DEV_SERVER_URL', null);
    const { PanelProvider } = await import('./panelhost.ts');
    const provider = Object.create(PanelProvider.prototype) as Record<string, any>;
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.setContent(themed(pageHtml()));
    await page.evaluate(
      (payload) => window.postMessage({ ...payload, startup: { generation: 7, complete: false } }, '*'),
      renderPayload(),
    );
    await page.waitForFunction(() => document.querySelectorAll('article.turn').length > 0);
    const before = await page.locator('#list').textContent();
    const session = { file: 'session.jsonl', sessionId: 'session', agent: 'claude', size: 1, mtimeMs: 1 };
    const checkpoint = {
      epoch: randomUUID(),
      parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
      parents: [session],
      catalog: [session],
      repositoryRoots: ['project'],
      completed: [normalizeFsPath(session.file)],
      sequence: 2,
      position: 1,
    };
    const messages: any[] = [];
    Object.assign(provider, {
      refreshGeneration: 7,
      authoritativeCatalog: [session],
      catalog: { sessions: [session] },
      repositoryScopeRoots: ['project'],
      claudeParents: [session],
      claudeChildren: [],
      claudeChildReferenceEntries: new Map(),
      claudeChildStatWrites: new Map(),
      dispatchDiscoveryPending: true,
      discoveryCheckpoint: pendingFirst ? undefined : checkpoint,
      derivedCacheCheckpointState: { markChanged() {} },
      metaFor: () => ({
        ...session,
        foldedLabel: 'session',
        stats: null,
        starts: { starts: [], whole: true },
        expandedStatsRead: true,
      }),
      post: async (message: unknown) => {
        messages.push(message);
        await page.evaluate((value) => window.postMessage(value, '*'), message);
      },
      hasHumanPrompt: () => true,
      activityFor: () => 1,
      updateSessionSpendSources() {},
      pruneDerivedTitles: () => false,
      progressiveWorker: {
        run: async (_request: unknown, generation: number) => ({
          generation,
          value: {
            kind: 'claude-children',
            checkpoint,
            complete: true,
            continuation: false,
            references: [],
            dispatchFacts: [],
            children: [],
            referenceEntries: [],
            roots: [session],
          },
        }),
      },
    });
    const signal = new AbortController().signal;
    if (pendingFirst) {
      provider.postSessionLoading([session], 7, signal);
      await page.waitForFunction(
        () => document.querySelector('[data-session-loading-status]')?.textContent === 'Reading sessions…',
      );
    }
    assert.equal(await provider.prepareClaudeChildren(7, signal), true);
    assert.equal(provider.discoveryCheckpoint, undefined, 'final worker acknowledgment retained its checkpoint');
    await page.waitForFunction(() =>
      document.querySelector('[data-session-loading-status]')?.textContent?.includes('1 of 1'),
    );
    if (failed) provider.failSessionLoading(7, signal);
    else provider.postSessionLoading([session], 7, signal);
    const background = page.locator('nav [data-session-loading-status]');
    if (failed) {
      await page.waitForFunction(() =>
        document.querySelector('[data-session-loading-status]')?.textContent?.includes('not read'),
      );
      assert.equal(await background.isVisible(), true);
    } else {
      await page.waitForFunction(
        'window.__posted.some(message => message.type === "painted" && message.generation === 7 && message.stage === "completeRender")',
      );
      assert.equal(await background.isVisible(), false, 'same-generation completion retained loading status');
    }
    assert.equal(await page.locator('#list').textContent(), before);
    assert.equal(new Set(messages.map((message) => message.epoch)).size, 1);
    assert.notEqual(messages.at(-1).epoch, checkpoint.epoch);
  } finally {
    vi.unstubAllGlobals();
    await browser.close();
  }
});
