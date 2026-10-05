import { test } from 'vitest';
import assert from 'node:assert';
import type { Page } from 'playwright-core';
import { browserOrNone, SETTLED } from '../test/browser.ts';
import { NOW, pageHtml, renderPayload, themed } from './panelfixture.ts';
import { ROVING_SELECTOR } from './webview/navigation.ts';
import { READ_LIMIT } from './domain/read.ts';
import { createReadState, type ReadCard } from './webview/read-state.ts';
import { RAIL_MIN_WIDTH } from './view/rail.ts';

test(
  'production visibility preserves retained reading state through return and rapid hide',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no browser available');
      return;
    }
    try {
      const page = await browser.newPage();
      await page.setViewportSize({ width: 1100, height: 800 });
      await page.setContent(themed(browserStatePageHtml()));
      await page.evaluate(`window.postMessage(${JSON.stringify(renderPayload())}, '*')`);
      await page.evaluate(SETTLED);
      await page.locator('#prompt').fill('Retained draft');
      const before = await page.evaluate(() => {
        const card = document.querySelector('#list article.turn')!;
        const response =
          Array.from(card.querySelectorAll('p')).find(
            (node) => node.getBoundingClientRect().height > 0 && node.textContent?.trim(),
          ) ?? card;
        (card.querySelector('button') as HTMLElement).focus();
        document.getSelection()!.removeAllRanges();
        document.getSelection()!.setBaseAndExtent(response, response.childNodes.length, response, 0);
        document.scrollingElement!.scrollTop = 250;
        (window as any).__retainedReading = { card, response, focus: document.activeElement };
        return {
          selection: document.getSelection()!.toString(),
          scroll: document.scrollingElement!.scrollTop,
          session: card.getAttribute('data-session'),
          backward:
            document.getSelection()!.anchorNode === response &&
            document.getSelection()!.anchorOffset === response.childNodes.length,
        };
      });
      assert.ok(before.selection, 'the retained text selection is empty');
      await page.evaluate(`window.postMessage({type:'visibility',visible:false,revision:1}, '*')`);
      await page.waitForFunction(() => document.documentElement.style.opacity === '0');
      await page.evaluate(() => {
        const saved = (window as any).__retainedReading;
        (document.activeElement as HTMLElement).blur();
        const nativeFocus = saved.focus.focus.bind(saved.focus);
        // Native webview focus can clear selection while the retained nodes remain connected.
        saved.focus.focus = (options: FocusOptions) => {
          nativeFocus(options);
          document.getSelection()!.removeAllRanges();
        };
      });
      await page.evaluate(
        `window.postMessage({type:'visibility',visible:true,revision:2}, '*'); window.postMessage({type:'visibility',visible:false,revision:3}, '*'); window.postMessage({type:'visibility',visible:true,revision:4}, '*')`,
      );
      await page.waitForFunction(() => document.documentElement.style.opacity !== '0');
      const after = await page.evaluate(() => {
        const saved = (window as any).__retainedReading;
        return {
          selection: document.getSelection()!.toString(),
          scroll: document.scrollingElement!.scrollTop,
          session: saved.card.getAttribute('data-session'),
          nodes: saved.card === document.querySelector('#list article.turn') && saved.response.isConnected,
          focus: saved.focus === document.activeElement,
          draft: (document.querySelector('#prompt') as HTMLTextAreaElement).value,
          backward:
            document.getSelection()!.anchorNode === saved.response &&
            document.getSelection()!.anchorOffset === saved.response.childNodes.length,
        };
      });
      assert.deepEqual(
        { selection: after.selection, scroll: after.scroll, session: after.session, backward: after.backward },
        before,
      );
      assert.equal(after.nodes, true);
      assert.equal(after.focus, true);
      assert.equal(after.draft, 'Retained draft');
      await page.locator('#prompt').focus();
      await page.locator('#prompt').click();
      await page.evaluate(() => {
        const input = document.querySelector('#prompt') as HTMLTextAreaElement;
        input.focus();
        input.setSelectionRange(1, 7, 'backward');
        const nativeFocus = input.focus.bind(input);
        input.focus = (options?: FocusOptions) => {
          nativeFocus(options);
          input.setSelectionRange(input.value.length, input.value.length);
        };
        window.postMessage({ type: 'visibility', visible: false, revision: 5 }, '*');
      });
      await page.waitForFunction(() => document.documentElement.style.opacity === '0');
      await page.evaluate(() => {
        (document.activeElement as HTMLElement).blur();
        window.postMessage({ type: 'visibility', visible: true, revision: 6 }, '*');
      });
      await page.waitForFunction(() => document.documentElement.style.opacity !== '0');
      assert.deepEqual(
        await page.evaluate(() => {
          const input = document.querySelector('#prompt') as HTMLTextAreaElement;
          return [document.activeElement === input, input.selectionStart, input.selectionEnd, input.selectionDirection];
        }),
        [true, 1, 7, 'backward'],
      );
      await page.close();
    } finally {
      await browser.close();
    }
  },
);

for (const phase of ['before hide', 'pending release']) {
  test(`production visibility respects newer timeline activity ${phase}`, { timeout: 60_000 }, async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no browser available');
      return;
    }
    try {
      const page = await browser.newPage();
      await page.setViewportSize({ width: 1100, height: 800 });
      const html = browserStatePageHtml().replace(
        'window.__posted = [];',
        `window.__posted = [];
        window.__heldObservations = [];
        const NativeObserver = window.IntersectionObserver;
        window.IntersectionObserver = class extends NativeObserver {
          constructor(callback, options) {
            super((entries, observer) => {
              if (window.__holdRetainedObservation && entries.some(entry => entry.target.inert))
                window.__heldObservations.push(() => callback(entries, observer));
              else callback(entries, observer);
            }, options);
          }
        };`,
      );
      await page.setContent(themed(html));
      await page.evaluate(`window.postMessage(${JSON.stringify(renderPayload())}, '*')`);
      await page.evaluate(SETTLED);
      await page.locator('#list article.turn button[aria-expanded]').first().click();
      await page.evaluate(SETTLED);
      await page.locator('#prompt').fill('Current reader draft');
      await page.evaluate(() => {
        const card = document.querySelector('#list article.turn')!;
        const response = Array.from(card.querySelectorAll('p')).find(
          (node) =>
            node.getBoundingClientRect().height > 0 && node.textContent?.trim() && !node.querySelector('a,button'),
        )!;
        response.setAttribute('data-retained-reading', '');
        (window as any).__currentReading = { card, response };
      });
      if (phase === 'pending release') {
        await page.evaluate(`window.postMessage({type:'visibility',visible:false,revision:1}, '*')`);
        await page.waitForFunction(() => document.documentElement.style.opacity === '0');
        await page.evaluate(() => {
          (document.activeElement as HTMLElement).blur();
          (window as any).__holdRetainedObservation = true;
          window.postMessage({ type: 'visibility', visible: true, revision: 2 }, '*');
        });
        await page.waitForFunction(() => (window as any).__heldObservations.length > 0);
      }
      await page.locator('[data-retained-reading]').click();
      const before = await page.evaluate(() => {
        const { card, response } = (window as any).__currentReading;
        const selection = document.getSelection()!;
        selection.setBaseAndExtent(response, response.childNodes.length, response, 0);
        return {
          selected: selection.toString(),
          session: card.getAttribute('data-session'),
          anchor: selection.anchorOffset,
          end: selection.focusOffset,
        };
      });
      assert.ok(before.selected, 'the newer timeline selection is empty');
      if (phase === 'before hide') {
        await page.evaluate(`window.postMessage({type:'visibility',visible:false,revision:1}, '*')`);
        await page.waitForFunction(() => document.documentElement.style.opacity === '0');
        await page.evaluate(`window.postMessage({type:'visibility',visible:true,revision:2}, '*')`);
      } else {
        await page.evaluate(() => {
          (window as any).__holdRetainedObservation = false;
          for (const receive of (window as any).__heldObservations.splice(0)) receive();
        });
      }
      await page.waitForFunction(() => document.documentElement.style.opacity !== '0');
      const after = await page.evaluate(() => {
        const { card, response } = (window as any).__currentReading;
        const selection = document.getSelection()!;
        return {
          selected: selection.toString(),
          session: card.getAttribute('data-session'),
          anchor: selection.anchorOffset,
          end: selection.focusOffset,
          nodes: card === document.querySelector('#list article.turn') && response.isConnected,
          currentSelection: selection.anchorNode === response && selection.focusNode === response,
          staleFocus: document.activeElement === document.querySelector('#prompt'),
          draft: (document.querySelector('#prompt') as HTMLTextAreaElement).value,
        };
      });
      assert.equal(after.staleFocus, false, 'newer timeline activity restores old Prompt focus');
      assert.deepEqual(
        { selected: after.selected, session: after.session, anchor: after.anchor, end: after.end },
        before,
      );
      assert.equal(after.nodes, true);
      assert.equal(after.currentSelection, true);
      assert.equal(after.draft, 'Current reader draft');
      await page.close();
    } finally {
      await browser.close();
    }
  });
}

type Payload = Record<string, unknown> & {
  cards: Array<Record<string, unknown>>;
  sessions: Array<Record<string, unknown>>;
  rail: Array<Record<string, unknown>>;
  stats: Record<string, unknown>;
};

function browserStatePageHtml(restored: unknown = {}): string {
  return pageHtml()
    .replace('const SAVED_STATE = {};', 'const SAVED_STATE = undefined;')
    .replace('window.__posted = [];', `window.__posted = [];\n  window.__browserState = ${JSON.stringify(restored)};`)
    .replace('getState: () => ({}),', 'getState: () => window.__browserState,')
    .replace('setState: () => undefined,', 'setState: (state) => { window.__browserState = state; },');
}

function countedListenerPageHtml(bodyClass = 'vscode-dark'): string {
  return browserStatePageHtml()
    .replace('<body class="vscode-dark">', `<body class="${bodyClass}">`)
    .replace(
      'window.__posted = [];',
      `window.__posted = [];
  window.__listenerCounts = { document: {}, window: {} };
  const originalDocumentListener = document.addEventListener.bind(document);
  document.addEventListener = (type, listener, options) => {
    window.__listenerCounts.document[type] = (window.__listenerCounts.document[type] || 0) + 1;
    return originalDocumentListener(type, listener, options);
  };
  const originalWindowListener = window.addEventListener.bind(window);
  window.addEventListener = (type, listener, options) => {
    window.__listenerCounts.window[type] = (window.__listenerCounts.window[type] || 0) + 1;
    return originalWindowListener(type, listener, options);
  };`,
    );
}

// The panel counts a full draw itself, through `onDraw`. A session-count-dependent loop can
// sit anywhere between a message and the one draw that should follow it.
// Reading the page's own DOM cannot tell a batched update from one row redrawn a thousand
// times the same way. Both leave the same rows on screen when they finish.
function drawCountedPageHtml(): string {
  return browserStatePageHtml()
    .replace(
      'window.__posted = [];',
      `window.__posted = [];
  window.__browserSaves = 0;
  window.__arcCardPrints = 0;
  window.__railTabWrites = 0;
  const tabIndexProperty = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'tabIndex');
  Object.defineProperty(HTMLElement.prototype, 'tabIndex', {
    ...tabIndexProperty,
    set(value) {
      if (this.matches('.railcard, .railact, .railfold, .railmore')) window.__railTabWrites++;
      tabIndexProperty.set.call(this, value);
    },
  });
  window.__arcDrawCounts = { timeline: 0, rail: 0 };
  window.__arcOnDraw = (renderer) => { window.__arcDrawCounts[renderer] += 1; };`,
    )
    .replace('window.__browserState = state;', 'window.__browserSaves += 1; window.__browserState = state;')
    .replace(/([A-Za-z_$][\w$]*)\.cardPrint\(([^)]*)\)/g, '(window.__arcCardPrints += 1, $&)');
}

async function drawCounts(page: Page): Promise<{ timeline: number; rail: number }> {
  return (await page.evaluate('window.__arcDrawCounts')) as { timeline: number; rail: number };
}

// A payload with `n` sessions, built by repeating the fixture's own first session and rail
// row rather than by calling `railSessions` again, so the shape a real render message
// carries never drifts from what `renderPayload` already produces elsewhere in this file.
function scaledPayload(n: number, turns?: number): Payload {
  const base = renderPayload() as Payload;
  const sessionTemplate = base.sessions[0];
  const railTemplate = base.rail[0];
  const sessions = Array.from({ length: n }, (_, i) => ({
    ...sessionTemplate,
    id: `bulk${i}`,
    label: `Bulk session ${i}`,
    fullLabel: `Bulk session ${i}`,
    at: NOW - i * 60_000,
    shown: i === 0,
  }));
  const rail = Array.from({ length: n }, (_, i) => ({
    ...railTemplate,
    id: `bulk${i}`,
    label: `Bulk session ${i}`,
    fullLabel: `Bulk session ${i}`,
    at: NOW - i * 60_000,
    current: i === 0,
  }));
  // Every session carries figures on a real wire, and the rail takes each row's out of this
  // record while it draws, so every bulk session is keyed here too.
  const statsTemplate = base.stats[sessionTemplate.id as string] ?? [];
  const ordinary = base.cards.filter((card) => card.kind === 'turn' && !card.live);
  return {
    ...base,
    sessions,
    rail,
    showing: 'bulk0',
    cards:
      turns === undefined
        ? base.cards.map((card) => ({ ...card, sessionId: 'bulk0' }))
        : Array.from({ length: turns }, (_, index) => ({
            ...ordinary[index % ordinary.length],
            sessionId: 'bulk0',
            key: `bulk0:${NOW - index * 60_000}`,
            startedAt: NOW - index * 60_000,
          })),
    stats: Object.fromEntries(sessions.map((session) => [session.id, statsTemplate])),
  };
}

async function openScaledPage(page: Page, n: number, turns?: number): Promise<Payload> {
  await page.setContent(themed(drawCountedPageHtml()));
  const initial = scaledPayload(n, turns);
  await page.evaluate(`window.postMessage(${JSON.stringify(initial)}, '*')`);
  await page.evaluate(SETTLED);
  return initial;
}

test('Activity publishes only the changed card beside unchanged cards', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  try {
    for (const n of [100, 1000]) {
      const page = await browser.newPage();
      const payload = await openScaledPage(page, n, 24);
      let card = payload.cards.find((candidate) => (candidate.activity as unknown[])?.length)!;
      const neighbor = payload.cards[0];
      for (const one of [card, neighbor]) {
        const head = page.locator(`[data-control=${JSON.stringify(`card:${one.key}`)}]`);
        if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
      }
      const disclosure = page.locator(`[data-control=${JSON.stringify(`activity:${card.key}`)}]`);
      if ((await disclosure.getAttribute('aria-expanded')) !== 'true') await disclosure.click();
      await disclosure.focus();
      await page.evaluate(`(() => {
        const neighbor = document.querySelector('[data-key="${neighbor.key}"]');
        window.__activityNeighbor = { card: neighbor, body: neighbor.querySelector('.body'), response: neighbor.querySelector('.summary') };
        window.__activityFocus = document.activeElement;
      })()`);
      const counts = await drawCounts(page);
      const prints = (await page.evaluate('window.__arcCardPrints')) as number;
      const template = (card.activity as Array<Record<string, unknown>>).find((row) => row.kind === 'message')!;
      for (let index = 0; index < 3; index++) {
        card = {
          ...card,
          activity: [
            ...(card.activity as unknown[]),
            {
              ...template,
              id: `affected:${index}`,
              text: `Affected Activity ${index}`,
              summaryHtml: `<p>Affected Activity ${index}</p>`,
            },
          ],
        };
        await page.evaluate(
          `window.postMessage(${JSON.stringify({ type: 'activity', session: card.sessionId, card })}, '*')`,
        );
        await page.waitForFunction((text) => document.body.textContent.includes(text), `Affected Activity ${index}`);
        await page.evaluate(SETTLED);
        assert.deepEqual(await drawCounts(page), counts, 'Activity drew the complete timeline');
        assert.equal(
          await page.evaluate('window.__arcCardPrints'),
          prints + index + 1,
          'Activity fingerprinted unchanged cards',
        );
        assert.deepEqual(
          await page.evaluate(`(() => {
          const held = window.__activityNeighbor;
          const neighbor = document.querySelector('[data-key="${neighbor.key}"]');
          return { card: neighbor === held.card, body: neighbor.querySelector('.body') === held.body, response: neighbor.querySelector('.summary') === held.response, focus: document.activeElement === window.__activityFocus, expanded: document.activeElement.getAttribute('aria-expanded') };
        })()`),
          { card: true, body: true, response: true, focus: true, expanded: 'true' },
        );
      }
      await page.evaluate(`(() => {
        const response = document.querySelector('[data-key="${card.key}"] .summary p');
        const range = document.createRange(); range.selectNodeContents(response);
        getSelection().removeAllRanges(); getSelection().addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        window.__activitySelected = { text: getSelection().toString(), response };
      })()`);
      for (const headline of ['Deferred first.', 'Deferred newest.']) {
        card = { ...card, headline, summaryHtml: `<p>${headline}</p>` };
        await page.evaluate(
          `window.postMessage(${JSON.stringify({ type: 'activity', session: card.sessionId, card })}, '*')`,
        );
        await page.evaluate(SETTLED);
      }
      assert.equal(
        await page.evaluate(
          'getSelection().toString() === window.__activitySelected.text && window.__activitySelected.response.isConnected',
        ),
        true,
      );
      assert.equal(
        await page.locator(`[data-key=${JSON.stringify(card.key)}] .headline`).textContent(),
        payload.cards.find((candidate) => candidate.key === card.key)!.headline,
      );
      await page.evaluate(`getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange'))`);
      await page.waitForFunction(() => document.body.textContent.includes('Deferred newest.'));
      await page.evaluate(SETTLED);
      assert.equal(
        await page
          .locator(`[data-key=${JSON.stringify(card.key)}] .summary`)
          .first()
          .textContent(),
        'Deferred newest.',
      );
      assert.equal(
        await page
          .locator(`[data-key=${JSON.stringify(card.key)}]`)
          .textContent()
          .then((text) => text!.includes('Deferred first.')),
        false,
      );
      assert.deepEqual(await drawCounts(page), counts, 'Activity release drew the complete timeline');
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('responsive heading Labels leave the timeline and card fingerprints untouched', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  try {
    for (const n of [100, 1000]) {
      for (const turns of [12, 24]) {
        const page = await browser.newPage();
        await page.setViewportSize({ width: 1400, height: 900 });
        const initial = await openScaledPage(page, n, turns);
        initial.rail[0].labels = ['performance'];
        await page.evaluate(`window.postMessage(${JSON.stringify(initial)}, '*')`);
        await page.evaluate(SETTLED);
        const label = page.locator('.sessionrow[data-session="bulk0"] .sessionlabel');
        assert.equal(await label.evaluate((node) => node.tagName), 'BUTTON');
        await label.focus();
        await page.evaluate(`window.__resizeBodies = Array.from(document.querySelectorAll('.turn .body'));`);
        const counts = await drawCounts(page);
        const prints = await page.evaluate('window.__arcCardPrints');
        for (const width of [1400, 1300, 600, 580, 1400]) {
          if (width === 1400 && page.viewportSize()?.width === width) {
            await page.evaluate(`window.dispatchEvent(new Event('resize'))`);
          } else {
            await page.setViewportSize({ width, height: 850 });
          }
          await page.evaluate(SETTLED);
          assert.deepEqual(await drawCounts(page), counts, `resize at ${width} drew the timeline at ${n} sessions`);
          assert.equal(await page.evaluate('window.__arcCardPrints'), prints, 'resize traversed card fingerprints');
          assert.equal(await label.evaluate((node) => node.tagName), width < RAIL_MIN_WIDTH ? 'SPAN' : 'BUTTON');
          if (width < RAIL_MIN_WIDTH) {
            assert.equal(await page.evaluate(`document.activeElement?.dataset.control`), 'sessionlabels:bulk0');
          }
          assert.equal(
            await page.evaluate(`window.__resizeBodies.every((node, index) =>
            node === document.querySelectorAll('.turn .body')[index])`),
            true,
          );
        }
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});

test(
  'typing in heading Labels updates the popover without drawing the timeline or rail',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
      return;
    }
    try {
      for (const n of [100, 1000]) {
        const page = await browser.newPage();
        const failures: string[] = [];
        page.on('pageerror', (error) => failures.push(String(error)));
        await openScaledPage(page, n);
        const heading = page.locator('[data-control="sessionlabels:bulk0"]');
        assert.equal(await heading.getAttribute('aria-expanded'), 'false');
        await heading.click();
        assert.deepEqual(await page.evaluate(`window.__posted.filter((message) => message.type === 'labelEditor')`), [
          { type: 'labelEditor', session: 'bulk0' },
        ]);
        await page.evaluate(
          `window.postMessage(${JSON.stringify({
            type: 'labelEditor',
            session: 'bulk0',
            heading: 'Labels for Bulk session 0',
            rows: [
              { name: 'performance', count: 2, countName: '2 sessions', applied: false },
              { name: 'personal', count: 1, countName: '1 session', applied: false },
              { name: 'costs', count: 2, countName: '2 sessions', applied: true },
            ],
          })}, '*')`,
        );
        await page.evaluate(SETTLED);
        assert.equal(await heading.getAttribute('aria-expanded'), 'true');
        assert.equal(await page.locator('#labelpop').getAttribute('aria-label'), 'Labels for Bulk session 0');
        await page.evaluate(`window.__labelInput = document.querySelector('[data-control="label-find"]')`);
        const before = await drawCounts(page);
        const input = page.locator('[data-control="label-find"]');
        let typed = '';
        for (const char of 'perfx') {
          typed += char;
          await input.press(char);
          await page.evaluate(SETTLED);
          const matching = typed === 'perfx' ? [] : typed === 'perf' ? ['performance'] : ['performance', 'personal'];
          assert.deepEqual(await page.locator('#labelpop .labelname').allTextContents(), matching);
          assert.equal(await page.locator('#labelpop .labelcreate').count(), 1);
          assert.ok((await page.locator('#labelpop .labelcreate').textContent())?.includes(typed));
          assert.deepEqual(
            await drawCounts(page),
            before,
            `Labels input ${typed} drew outside its popover at ${n} sessions`,
          );
          assert.deepEqual(
            await page.evaluate(`(() => {
            const input = document.querySelector('[data-control="label-find"]');
            return { same: input === window.__labelInput, focused: document.activeElement === input,
              value: input.value, caret: input.selectionStart, end: input.selectionEnd };
          })()`),
            { same: true, focused: true, value: typed, caret: typed.length, end: typed.length },
          );
          assert.equal(await heading.getAttribute('aria-expanded'), 'true');
        }
        assert.deepEqual(await page.evaluate(`window.__posted.filter((message) => message.type === 'setLabels')`), []);
        await input.press('Enter');
        await page.evaluate(SETTLED);
        assert.deepEqual(await page.evaluate(`window.__posted.filter((message) => message.type === 'setLabels')`), [
          { type: 'setLabels', session: 'bulk0', names: ['costs', 'perfx'] },
        ]);
        await input.press('Escape');
        await page.evaluate(SETTLED);
        assert.equal(await page.locator('#labelpop').isHidden(), true);
        assert.equal(await heading.getAttribute('aria-expanded'), 'false');
        assert.equal(await heading.evaluate((node) => document.activeElement === node), true);
        assert.deepEqual(failures, []);
      }
    } finally {
      await browser.close();
    }
  },
);

// Each hot path that takes a host-supplied list must draw a constant number of times,
// whatever the list holds. A path that draws once per session passes at 100 sessions, where
// the extra draws are cheap enough to hide. It only fails once a real workspace's session
// count reaches it.
test('a render message draws the timeline once, at 100 sessions and at 1000', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    for (const n of [100, 1000]) {
      const page = await browser.newPage();
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(String(error)));
      const initial = await openScaledPage(page, n);
      const before = await drawCounts(page);
      const repost = { ...initial, sessions: initial.sessions.map((row) => ({ ...row })) };
      await page.evaluate(`window.postMessage(${JSON.stringify(repost)}, '*')`);
      await page.evaluate(SETTLED);
      const after = await drawCounts(page);
      const delta = after.timeline - before.timeline;
      assert.deepEqual(failures, []);
      assert.equal(delta, 1, `a render message drew the timeline ${delta} times at ${n} sessions`);
    }
  } finally {
    await browser.close();
  }
});

test('rail metadata and label editor updates leave turn cards untouched', { timeout: 120_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  try {
    for (const n of [100, 1000])
      for (const turns of [12, 24])
        for (const theme of ['dark', 'light'] as const) {
          const page = await browser.newPage();
          const failures: string[] = [];
          page.on('pageerror', (error) => failures.push(String(error)));
          await page.setContent(themed(drawCountedPageHtml(), theme));
          const initial = scaledPayload(n, turns);
          initial.olderHistory = {
            kind: 'load',
            label: 'Load older turns',
            name: 'Load more recorded turns',
            token: 'metadata-old',
            session: 'bulk0',
            auto: false,
          };
          await page.evaluate((message) => window.postMessage(message, '*'), initial);
          await page.evaluate(SETTLED);
          const message = {
            type: 'rail',
            rail: initial.rail,
            labels: initial.labels,
            views: initial.views,
            railFilters: initial.railFilters,
            stats: initial.stats,
            sessionAdoptions: [],
            hidden: initial.hidden,
            pinnedTop: initial.pinnedTop,
          };
          const post = async (next: unknown) => {
            await page.evaluate((value) => window.postMessage(value, '*'), next);
            await page.evaluate(SETTLED);
          };
          await page.locator('[data-control="olderHistory"]').focus();
          await page.evaluate(
            `window.__olderNode = document.querySelector('[data-control="olderHistory"]'); window.__firstCard = document.querySelector('article.turn');`,
          );
          const before = await drawCounts(page);
          const prints = (await page.evaluate('window.__arcCardPrints')) as number;
          assert.ok(prints > 0, 'the card fingerprint counter did not observe the initial render');
          await post(message);
          assert.deepEqual(
            await page.evaluate(
              `({same: window.__olderNode === document.querySelector('[data-control="olderHistory"]'), focused: document.activeElement === window.__olderNode})`,
            ),
            { same: true, focused: true },
          );
          await post({
            ...message,
            rail: initial.rail.map((row, i) =>
              i === 1 ? { ...row, label: 'Changed unrelated session', labels: ['unrelated'] } : row,
            ),
            stats: {
              ...initial.stats,
              bulk1: [{ kind: 'plain', metric: 'turns', label: '77 turns', detail: 'Changed unrelated detail' }],
            },
          });
          const selected = {
            ...message,
            rail: initial.rail.map((row, i) => (i === 0 ? { ...row, labels: ['metadata'] } : row)),
            stats: {
              ...initial.stats,
              bulk0: [
                {
                  kind: 'plain',
                  metric: 'cost',
                  label: '$9',
                  compactLabel: '$9',
                  name: 'Changed cost',
                  focusable: true,
                  detail: 'First selected cost detail',
                },
              ],
            },
          };
          await post(selected);
          assert.equal(await page.locator('.sessionrow[data-session="bulk0"] .sessionlabel').textContent(), 'metadata');
          const figure = page.locator('.sessionstats [data-metric="cost"]');
          await figure.evaluate((node: HTMLElement) => node.click());
          await page.evaluate(SETTLED);
          assert.match(await page.locator('#chippop').innerText(), /First selected cost detail/);
          await post({
            ...selected,
            stats: {
              ...selected.stats,
              bulk0: [
                { ...selected.stats.bulk0[0], detail: 'Updated selected cost detail', name: 'Updated cost name' },
              ],
            },
          });
          assert.match(await page.locator('#chippop').innerText(), /Updated selected cost detail/);
          assert.equal(await figure.getAttribute('aria-label'), 'Updated cost name');
          await figure.press('Escape');
          await page.evaluate(SETTLED);
          const heading = page.locator('[data-control="sessionlabels:bulk0"]');
          await heading.click();
          assert.equal(await heading.getAttribute('aria-expanded'), 'false');
          await post({ type: 'labelEditor', session: 'bulk1', heading: 'Wrong reply', rows: [] });
          assert.equal(await heading.getAttribute('aria-expanded'), 'false');
          const rows = [
            { name: 'metadata', count: 2, countName: '2 sessions', applied: true },
            { name: 'performance', count: 1, countName: '1 session', applied: false },
          ];
          await post({ type: 'labelEditor', session: 'bulk0', heading: 'Labels for Bulk session 0', rows });
          assert.equal(await heading.getAttribute('aria-expanded'), 'true');
          await page.evaluate(
            `(() => { const input=document.querySelector('.labelfind');window.__labelInput=input;input.value='perf';input.focus();input.setSelectionRange(1,3);input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));input.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true})); })()`,
          );
          await page.evaluate(SETTLED);
          await post({ type: 'labelsChanged', session: 'bulk1' });
          await post({
            type: 'labelEditor',
            session: 'bulk0',
            heading: 'Labels for Bulk session 0',
            rows: [rows[0], { ...rows[1], count: 4, countName: '4 sessions' }],
          });
          assert.match(await page.locator('#labelpop').innerText(), /4/);
          assert.deepEqual(
            await page.evaluate(
              `(() => {const input=document.querySelector('.labelfind');return {same:input===window.__labelInput,focused:document.activeElement===input,value:input.value,start:input.selectionStart,end:input.selectionEnd};})()`,
            ),
            { same: true, focused: true, value: 'perf', start: 1, end: 3 },
          );
          await page.evaluate(
            `document.querySelector('.labelfind').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))`,
          );
          await page.locator('.labelfind').press('Escape');
          await page.evaluate(SETTLED);
          assert.equal(await heading.getAttribute('aria-expanded'), 'false');
          assert.equal(await heading.evaluate((node) => document.activeElement === node), true);
          const after = await drawCounts(page);
          assert.equal(
            after.rail - before.rail,
            7,
            'rail replies and editor transitions changed their existing draw bound',
          );
          assert.equal(
            after.timeline - before.timeline,
            0,
            `metadata/editor updates drew the timeline at ${n} sessions and ${turns} turns in ${theme}`,
          );
          assert.equal(
            await page.evaluate('window.__arcCardPrints'),
            prints,
            'metadata/editor updates traversed card fingerprints',
          );
          assert.equal(await page.evaluate(`window.__firstCard === document.querySelector('article.turn')`), true);
          assert.deepEqual(failures, []);
          await page.close();
        }
  } finally {
    await browser.close();
  }
});

test(
  'a read change updates headings without drawing the timeline, at 100 sessions and at 1000',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
      return;
    }
    try {
      for (const n of [100, 1000]) {
        const page = await browser.newPage();
        const failures: string[] = [];
        page.on('pageerror', (error) => failures.push(String(error)));
        await openScaledPage(page, n);
        const before = await drawCounts(page);
        await page.evaluate('window.__railTabWrites = 0');
        await page.evaluate(
          `window.postMessage(${JSON.stringify({
            type: 'setSessionRead',
            session: 'bulk0',
            read: false,
          })}, '*')`,
        );
        await page.evaluate(SETTLED);
        const after = await drawCounts(page);
        assert.equal(
          await page.evaluate('window.__railTabWrites'),
          0,
          'a heading read change rewrote unrelated control tab stops',
        );
        const delta = after.timeline - before.timeline;
        assert.deepEqual(failures, []);
        assert.equal(delta, 0, `a read change drew the timeline ${delta} times at ${n} sessions`);
        assert.equal(
          await page
            .locator('.sessionrow[data-session="bulk0"]')
            .evaluate((node) => JSON.parse((node as HTMLElement).dataset.vscodeContext!).sessionRead),
          'unread',
        );
      }
    } finally {
      await browser.close();
    }
  },
);

test(
  'unread heading expansion stays local for 12 and 24 turns at 100 and 1000 sessions',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('Edge or Chrome is required');
      return;
    }
    try {
      for (const n of [100, 1000]) {
        for (const turns of [12, 24]) {
          const page = await browser.newPage();
          const failures: string[] = [];
          page.on('pageerror', (error) => failures.push(String(error)));
          const initial = await openScaledPage(page, n, turns);
          assert.equal(initial.cards.length, turns);
          await page.evaluate(`window.postMessage({ type: 'setSessionRead', session: 'bulk0', read: false }, '*')`);
          await page.evaluate(SETTLED);
          const heading = page.locator('.sessionrow[data-session="bulk0"]');
          const disclosure = heading.locator('button.session');
          await disclosure.focus();
          await page.evaluate(
            `window.__heldHeading = document.querySelector('.sessionrow[data-session="bulk0"] button.session'); window.__posted = []; window.__browserSaves = 0;`,
          );
          const before = await drawCounts(page);
          await disclosure.press('Enter');
          await page.waitForFunction(`document.querySelectorAll('.turn.has-body.is-open.is-read').length === ${turns}`);
          await page.evaluate(SETTLED);
          assert.deepEqual(await drawCounts(page), before);
          assert.equal(await disclosure.getAttribute('aria-expanded'), 'true');
          assert.equal(await page.evaluate(`document.activeElement === window.__heldHeading`), true);
          assert.equal(
            await heading.evaluate((node) => JSON.parse((node as HTMLElement).dataset.vscodeContext!).sessionRead),
            'read',
          );
          assert.equal(await page.evaluate('window.__browserSaves'), 1);
          assert.equal(
            await page.evaluate(`window.__posted.filter((message) => message.type === 'saveState').length`),
            1,
          );
          assert.deepEqual(
            await page.evaluate('window.__browserState.read'),
            initial.cards.map((card) => card.key),
          );
          assert.equal(await page.evaluate('window.__browserState.readTo.bulk0'), 0);
          await disclosure.press('Enter');
          await page.evaluate(SETTLED);
          assert.equal(await page.locator('.turn.is-open').count(), 0);
          assert.equal(await page.locator('.turn.is-read').count(), turns);
          assert.deepEqual(await drawCounts(page), before);
          await page.evaluate(
            `window.postMessage(${JSON.stringify({ type: 'rail', rail: initial.rail, labels: initial.labels, views: initial.views, railFilters: initial.railFilters, stats: initial.stats, hidden: initial.hidden, pinnedTop: initial.pinnedTop, sessionAdoptions: [] })}, '*')`,
          );
          await page.evaluate(SETTLED);
          assert.deepEqual(await drawCounts(page), { timeline: before.timeline, rail: before.rail + 1 });
          assert.equal(
            await heading.evaluate((node) => JSON.parse((node as HTMLElement).dataset.vscodeContext!).sessionRead),
            'read',
          );
          assert.deepEqual(failures, []);
          await page.close();
        }
      }
    } finally {
      await browser.close();
    }
  },
);

test(
  'local session membership updates headings without timeline draws or card fingerprints',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
      return;
    }
    try {
      for (const n of [100, 1000]) {
        for (const turns of [12, 24]) {
          const page = await browser.newPage();
          const failures: string[] = [];
          page.on('pageerror', (error) => failures.push(String(error)));
          await openScaledPage(page, n, turns);
          const heading = page.locator('.sessionrow[data-session="bulk0"]');
          await page.evaluate(`window.__membershipHeading = document.querySelector('.sessionrow[data-session="bulk0"]');
            window.__membershipBody = document.querySelector('.turn .body');`);
          for (const [type, field, value, action, pinned, archived] of [
            ['setSessionPinned', 'pinned', true, 'pin', true, false],
            ['setSessionPinned', 'pinned', false, 'unpin', false, false],
            ['setSessionPinned', 'pinned', true, 'pin', true, false],
            ['setSessionArchived', 'archived', true, 'archive', false, true],
            ['setSessionArchived', 'archived', false, 'unarchive', false, false],
          ] as const) {
            const before = await drawCounts(page);
            const prints = await page.evaluate('window.__arcCardPrints');
            const saves = await page.evaluate('window.__browserSaves');
            await page.evaluate('window.__posted.length = 0');
            const message = { type, session: 'bulk0', [field]: value };
            await page.evaluate((message) => window.postMessage(message, '*'), message);
            await page.evaluate(SETTLED);
            const context = await heading.evaluate((node) => JSON.parse((node as HTMLElement).dataset.vscodeContext!));
            assert.equal(context.sessionPinned, pinned);
            assert.equal(context.webviewSection, archived ? 'arcSessionArchived' : 'arcSessionLive');
            assert.equal(context.sessionPersisted, true);
            assert.equal(await heading.locator('[data-control="sessionpin:bulk0"]').count(), archived ? 0 : 1);
            if (!archived)
              assert.equal(
                await heading.locator('[data-control="sessionpin:bulk0"]').getAttribute('aria-pressed'),
                String(pinned),
              );
            assert.equal(
              await page.evaluate(
                `window.__membershipHeading === document.querySelector('.sessionrow[data-session="bulk0"]') && window.__membershipBody === document.querySelector('.turn .body')`,
              ),
              true,
            );
            assert.deepEqual(await drawCounts(page), { timeline: before.timeline, rail: before.rail + 1 });
            assert.equal(await page.evaluate('window.__arcCardPrints'), prints);
            assert.equal(await page.evaluate('window.__browserSaves'), saves);
            assert.deepEqual(
              await page.evaluate(
                `window.__posted.filter(m => m.type === 'sessionMembership' || m.type === 'saveState')`,
              ),
              [{ type: 'sessionMembership', action, session: 'bulk0' }],
            );
            await page.evaluate((message) => window.postMessage(message, '*'), message);
            await page.evaluate(SETTLED);
            assert.deepEqual(await drawCounts(page), { timeline: before.timeline, rail: before.rail + 1 });
            assert.equal(await page.evaluate(`window.__posted.filter(m => m.type === 'sessionMembership').length`), 1);
          }
          assert.deepEqual(failures, []);
          await page.close();
        }
      }
    } finally {
      await browser.close();
    }
  },
);

// A query keeps every matching group, with a bounded step in each section. The section draws a bounded step and offers the
// rest under a press, and the press walks the reader through every match by keyboard. A fold
// heading names only the rows on the page, and the last press moves the focus once, to the row
// it drew last.
test('a query over 1000 sessions draws 200 rows and offers the rest a step a press', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(String(error)));
    const initial = await openScaledPage(page, 1000);
    initial.views = [];
    await page.evaluate((payload) => window.postMessage(payload, '*'), initial);
    await page.evaluate(SETTLED);
    const postRail = (rail: Array<Record<string, unknown>>) =>
      page.evaluate(
        `window.postMessage(${JSON.stringify({
          type: 'rail',
          rail,
          labels: initial.labels,
          views: initial.views,
          railFilters: initial.railFilters,
          stats: initial.stats,
          sessionAdoptions: [],
          hidden: initial.hidden,
          pinnedTop: initial.pinnedTop,
        })}, '*')`,
      );
    const sectionRows = (bucket: string, rows: number) =>
      page.waitForFunction(
        `[...document.querySelectorAll('.railrow')].filter((node) => node.dataset.railBucket === ${JSON.stringify(bucket)}).length === ${rows}`,
      );
    // Under time grouping and an empty query, 1000 sessions a minute apart land in Today and
    // Yesterday, so one open heading holds more than 200 cards.
    const heading = () =>
      page.evaluate(`(() => {
        const head = [...document.querySelectorAll('button.railfold')].find(
          (node) =>
            node.getAttribute('aria-expanded') === 'true' &&
            Number(node.querySelector('.railbucketcount').textContent.replace(/\\D/g, '')) > 200,
        );
        if (!head) {
          return null;
        }
        const bucket = head.closest('[data-bucket]').dataset.bucket;
        return {
          bucket,
          count: Number(head.querySelector('.railbucketcount').textContent.replace(/\\D/g, '')),
          controls: [...(document.getElementById(head.getAttribute('aria-controls'))?.children ?? [])].map((row) => row.id),
          rows: [...document.querySelectorAll('.railrow')]
            .filter((node) => node.dataset.railBucket === bucket)
            .map((node) => node.id),
        };
      })()`) as Promise<{ bucket: string; count: number; controls: string[]; rows: string[] } | null>;
    const big = await heading();
    assert.ok(big, 'no open time heading holds more than 200 cards');
    assert.equal(big.controls.length, 200, 'the controlled group list must contain exactly its mounted rows');
    assert.deepEqual(big.controls, big.rows);
    // A poll draw that leaves the section fewer cards than it drew takes the focused press away,
    // and the focus goes to the section's fold heading. The section's sessions are one run of
    // minutes, so keeping its first 100 shrinks it and no other section.
    const first = Number(
      await page.evaluate(
        `document.querySelector('.railrow[data-rail-bucket="${big.bucket}"] .railcard').dataset.control.slice('rail:bulk'.length)`,
      ),
    );
    await page.locator(`.railmore[data-rail-bucket="${big.bucket}"]`).focus();
    await postRail(initial.rail.filter((_row, i) => i < first + 100 || i >= first + big.count));
    await sectionRows(big.bucket, 100);
    assert.deepEqual(
      await page.evaluate(
        `(() => ({ fold: document.activeElement.classList.contains('railfold'), bucket: document.activeElement.closest('[data-bucket]').dataset.bucket }))()`,
      ),
      { fold: true, bucket: big.bucket },
      'a press a poll draw removes sends the focus somewhere other than its fold heading',
    );
    await postRail(initial.rail);
    await sectionRows(big.bucket, 200);
    await page.locator(`.railmore[data-rail-bucket="${big.bucket}"]`).click();
    const raised = Math.min(big.count, 400);
    await sectionRows(big.bucket, raised);
    const after = await heading();
    assert.equal(after?.controls.length, raised);
    assert.deepEqual(after?.controls, after?.rows);
    await page.locator('[data-control="railsearch"]').click();
    await page.locator('[data-control="railfilters"]').click();
    await page.locator('[data-control="railgroupby:none"]').click();
    await page.locator('[data-control="railfilters"]').click();
    await page.locator('.railfilter').fill('bulk');
    const drawn = (rows: number) =>
      page.waitForFunction(
        `document.querySelectorAll('.railrow[data-rail-bucket="railgroup:all"]').length === ${rows}`,
      );
    const state = () =>
      page.evaluate(`(() => {
        const more = [...document.querySelectorAll('.railmore')];
        const active = document.activeElement;
        return {
          rows: document.querySelectorAll('.railrow').length,
          more: more.map((node) => node.textContent),
          names: more.map((node) => node.getAttribute('aria-label')),
          heading: document.querySelector('[data-bucket="railgroup:all"] .railbucketcount')?.textContent ?? null,
          focus: active?.dataset?.control ?? null,
        };
      })()`);
    await drawn(200);
    assert.deepEqual(await state(), {
      rows: 200,
      more: ['Show 200 more'],
      names: ['Show 200 more in Sessions'],
      heading: '· 1000',
      focus: 'railfilter',
    });
    await page.locator('.railmore').focus();
    await page.keyboard.press('Enter');
    await drawn(400);
    assert.deepEqual(
      await state(),
      {
        rows: 400,
        more: ['Show 200 more'],
        names: ['Show 200 more in Sessions'],
        heading: '· 1000',
        focus: 'railmore:railgroup:all',
      },
      'a press that leaves rows undrawn keeps the focus on the press',
    );
    assert.ok(
      await page.evaluate(`(() => {
        const more = document.querySelector('.railmore');
        const box = more.getBoundingClientRect();
        const rail = more.closest('nav').getBoundingClientRect();
        // The press rests on the rail's edge, where layout rounds to a fraction of a pixel.
        return box.top >= rail.top - 1 && box.bottom <= rail.bottom + 1;
      })()`),
      'the rows a press draws push the focused press out of the rail view',
    );
    for (const rows of [600, 800]) {
      await page.keyboard.press('Enter');
      await drawn(rows);
    }
    await page.evaluate(`(() => {
      window.__focused = [];
      document.addEventListener('focusin', (event) => window.__focused.push(event.target.dataset?.control ?? null));
    })()`);
    await page.keyboard.press('Enter');
    await drawn(1000);
    assert.deepEqual(
      await state(),
      { rows: 1000, more: [], names: [], heading: '· 1000', focus: 'rail:bulk999' },
      'the press that draws the last row moves the focus to that row',
    );
    assert.deepEqual(
      await page.evaluate('window.__focused'),
      ['rail:bulk999'],
      'the last press moves the focus through another control, such as the first row, on its way',
    );
    // A poll draw that removes the focused press returns focus to its group heading. A new query starts the section at its first step.
    await page.locator('.railfilter').fill('session');
    await drawn(200);
    await page.locator('.railmore').focus();
    await postRail(initial.rail.slice(0, 150));
    await drawn(150);
    assert.equal(
      ((await state()) as { focus: string | null }).focus,
      'railgroup:all',
      'a removed press returns focus to its group heading',
    );
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

test('New draws a provisional session before discovery sends its first render', { timeout: 60_000 }, async (t) => {
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
    const fixture = renderPayload() as Record<string, unknown> & {
      sessions: Array<Record<string, unknown>>;
      rail: Array<Record<string, unknown>>;
      usage: Record<string, unknown> & { composer: Record<string, unknown> };
    };
    const draftId = 'draft-before-discovery';
    const selection = {
      type: 'selection',
      cards: [],
      sessions: [
        {
          ...fixture.sessions[0],
          id: draftId,
          label: 'New Claude session',
          fullLabel: 'New Claude session',
          shown: true,
        },
      ],
      rail: [
        {
          ...fixture.rail[0],
          id: draftId,
          label: 'New Claude session',
          current: true,
        },
      ],
      stats: {},
      replaces: [draftId],
      showing: draftId,
      olderHistory: null,
      diagnosis: { message: 'Start this session with a prompt.' },
      usage: {
        ...fixture.usage,
        composer: {
          ...fixture.usage.composer,
          sessionId: draftId,
          targetName: 'New Claude session',
        },
      },
      startup: null,
    };

    await page.evaluate(`window.postMessage(${JSON.stringify(selection)}, '*')`);
    await page.evaluate(SETTLED);

    assert.equal(
      await page.locator('.empty').textContent(),
      'Start this session with a prompt.',
      'New waited for discovery before it drew the provisional session',
    );
    assert.equal(
      await page.locator(`.railcard.is-current[data-session="${draftId}"]`).count(),
      1,
      'New waited for discovery before it drew the provisional rail row',
    );
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

test('leaving an untouched draft removes its provisional row', { timeout: 60_000 }, async (t) => {
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
    const initial = renderPayload() as Record<string, unknown> & {
      cards: Array<Record<string, unknown>>;
      sessions: Array<Record<string, unknown>>;
      rail: Array<Record<string, unknown>>;
      stats: Record<string, unknown>;
      usage: Record<string, unknown> & { composer: Record<string, unknown> };
    };
    const draftId = 'draft-to-abandon';
    const targetId = 's2';
    const draftSession = {
      ...initial.sessions[0],
      id: draftId,
      label: 'New Claude session',
      fullLabel: 'New Claude session',
      shown: true,
    };
    const draftRail = {
      ...initial.rail[0],
      id: draftId,
      label: 'New Claude session',
      current: true,
    };
    const targetSession = { ...initial.sessions.find((row) => row.id === targetId), shown: false };
    const targetRail = { ...initial.rail.find((row) => row.id === targetId), current: false };
    await page.evaluate(
      `window.postMessage(${JSON.stringify({
        ...initial,
        cards: [],
        sessions: [draftSession, targetSession],
        rail: [draftRail, targetRail],
        stats: { [targetId]: initial.stats[targetId] },
        showing: draftId,
        diagnosis: null,
        usage: {
          ...initial.usage,
          composer: {
            ...initial.usage.composer,
            sessionId: draftId,
            targetName: 'New Claude session',
          },
        },
      })}, '*')`,
    );
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await page
        .locator('.railcard.is-current')
        .evaluateAll((rows) => [...new Set(rows.map((row) => row.getAttribute('data-session')))]),
      [draftId],
      'the fixture did not draw only the draft as current',
    );

    const selection = {
      type: 'selection',
      cards: initial.cards.map((card) => ({ ...card, sessionId: targetId, sessionTitle: 'Codex parity sweep' })),
      sessions: [{ ...targetSession, shown: true }],
      rail: [{ ...targetRail, current: true }],
      stats: { [targetId]: initial.stats[targetId] },
      replaces: [draftId, targetId],
      showing: targetId,
      olderHistory: null,
      diagnosis: null,
      usage: {
        ...initial.usage,
        composer: {
          ...initial.usage.composer,
          sessionId: targetId,
          targetName: 'Codex parity sweep',
        },
      },
      startup: null,
    };
    await page.evaluate(`window.postMessage(${JSON.stringify(selection)}, '*')`);
    await page.evaluate(SETTLED);

    assert.equal(
      await page.locator(`.railcard[data-session="${draftId}"]`).count(),
      0,
      'the abandoned draft kept its provisional rail row',
    );
    assert.deepEqual(
      await page
        .locator('.railcard.is-current')
        .evaluateAll((rows) => [...new Set(rows.map((row) => row.getAttribute('data-session')))]),
      [targetId],
      'leaving the draft left two sessions current',
    );
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

test('a selection message changes the shown session and keeps render-owned state', { timeout: 60_000 }, async (t) => {
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
    const initial = renderPayload(['s3']) as Record<string, unknown> & {
      cards: Array<Record<string, unknown>>;
      sessions: Array<Record<string, unknown>>;
      rail: Array<Record<string, unknown>>;
      stats: Record<string, unknown>;
      usage: Record<string, unknown> & { composer: Record<string, unknown> };
    };
    await page.evaluate(`window.postMessage(${JSON.stringify(initial)}, '*')`);
    await page.evaluate(SETTLED);

    const selection = {
      type: 'selection',
      cards: initial.cards.map((card: Record<string, unknown>) => ({
        ...card,
        sessionId: 's2',
        sessionTitle: 'Codex parity sweep',
      })),
      sessions: initial.sessions
        .filter((row: Record<string, unknown>) => row.id === 's1' || row.id === 's2')
        .map((row: Record<string, unknown>) => ({
          ...row,
          id: row.id,
          shown: row.id === 's2',
          ...(row.id === 's2' ? { parent: { id: 's1', label: 'Parent', relation: 'reader' } } : {}),
        })),
      rail: initial.rail
        .filter((row: Record<string, unknown>) => row.id === 's1' || row.id === 's2')
        .map((row: Record<string, unknown>) => ({ ...row, current: row.id === 's2' })),
      stats: { s1: initial.stats.s1, s2: initial.stats.s2 },
      replaces: ['s1', 's2'],
      showing: 's2',
      olderHistory: null,
      diagnosis: null,
      usage: {
        ...initial.usage,
        composer: {
          ...initial.usage.composer,
          sessionId: 's2',
          targetName: 'Codex parity sweep',
        },
      },
      startup: null,
    };
    await page.evaluate(`window.postMessage(${JSON.stringify(selection)}, '*')`);
    await page.evaluate(SETTLED);

    assert.equal(
      await page.locator('section.sessionsection[data-session="s2"]').count(),
      1,
      'the selection update did not draw the chosen session',
    );
    assert.equal(
      await page.locator('.railcard.is-current[data-session="s2"]').count(),
      1,
      'the selection update did not move the current rail card',
    );
    await page.locator('[data-bucket="railarchived"]').click();
    await page.evaluate(SETTLED);
    assert.equal(
      await page.locator('.railcard[data-session="s3"][data-archived="true"]').count(),
      1,
      'the selection update discarded the hidden set owned by the last render',
    );
    const parent = page.locator('section.sessionsection[data-session="s2"] button.sessionparent');
    await page.evaluate('window.__posted.length = 0');
    await parent.click();
    assert.deepEqual(await page.evaluate("window.__posted.filter((message) => message.type === 'showReaderParent')"), [
      { type: 'showReaderParent', session: 's1' },
    ]);
    await page.evaluate(
      `window.postMessage(${JSON.stringify({ ...selection, showing: 's1', sessions: selection.sessions.map((row) => ({ ...row, shown: row.id === 's1' })) })}, '*')`,
    );
    await page.evaluate(SETTLED);
    await page.evaluate(`window.postMessage(${JSON.stringify(selection)}, '*')`);
    await page.evaluate(SETTLED);
    await page.evaluate('window.__posted.length = 0');
    await page.locator('section.sessionsection[data-session="s2"] button.sessionparent').focus();
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate("window.__posted.filter((message) => message.type === 'showReaderParent')"), [
      { type: 'showReaderParent', session: 's1' },
    ]);
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

test('browser state survives page destruction and is written to both owners', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const first = await browser.newPage();
    const failures: string[] = [];
    first.on('pageerror', (error) => failures.push(String(error)));
    // The rail head rests on its count, so the magnifying glass opens the filter box, and
    // the query typed below is what the state under test carries.
    await first.setContent(browserStatePageHtml({ railFilterId: 'all' }));
    await first.evaluate(`window.postMessage(${JSON.stringify(renderPayload())}, '*')`);
    await first.evaluate(SETTLED);
    await first.locator('[data-control="railsearch"]').click();
    await first.evaluate(SETTLED);
    await first.locator('.railfilter').fill('agent:codex');
    await first.locator('[data-control^="card:"]').first().click();
    await first.evaluate(SETTLED);
    const written = (await first.evaluate(`(() => ({
      browser: window.__browserState,
      host: window.__posted.filter((message) => message.type === 'saveState').at(-1)?.state,
    }))()`)) as { browser: { railFilter: string; open: string[] }; host: unknown };
    assert.deepEqual(
      written.browser,
      written.host,
      'the browser state and host memento writers received different persisted state',
    );
    assert.equal(written.browser.railFilter, 'agent:codex');
    assert.equal(written.browser.open.length, 1, 'the page did not persist the turn opened before it was destroyed');
    await first.close();

    const restored = await browser.newPage();
    restored.on('pageerror', (error) => failures.push(String(error)));
    await restored.setContent(browserStatePageHtml(written.browser));
    await restored.evaluate(`window.postMessage(${JSON.stringify(renderPayload())}, '*')`);
    await restored.evaluate(SETTLED);
    // A restored query leaves the count on the rail head, and the magnifying glass shows it.
    await restored.locator('[data-control="railsearch"]').click();
    await restored.evaluate(SETTLED);
    assert.equal(await restored.locator('.railfilter').inputValue(), 'agent:codex');
    assert.equal(
      await restored.evaluate(`(() => {
      const control = [...document.querySelectorAll('[data-control^="card:"]')]
        .find((node) => node.dataset.control === 'card:' + window.__browserState.open[0]);
      return control?.getAttribute('aria-expanded');
    })()`),
      'true',
      'the recreated page did not restore its open turn',
    );
    await restored.close();

    const initial = scaledPayload(1, 2);
    const [newer, older] = initial.cards as unknown as ReadCard[];
    const open = new Set([older.key]);
    const read = createReadState({
      initial: { read: [older.key], readTo: { bulk0: 0 }, since: 0 },
      open,
      cards: () => [older, newer],
      newestTurnAt: () => newer.startedAt,
      save: () => undefined,
      refreshSelection: () => undefined,
    });
    for (let index = 0; index < READ_LIMIT - 1; index += 1) {
      read.mark(`bulk0:${older.startedAt - index - 1}`);
    }
    read.mark(newer.key);
    const snapshot = read.snapshot();
    assert.equal(snapshot.read.has(older.key), false, 'read-key eviction did not remove the saved open turn');
    assert.equal(snapshot.read.has(newer.key), true);
    assert.equal(open.has(older.key), true);
    const evicted = await browser.newPage();
    evicted.on('pageerror', (error) => failures.push(String(error)));
    await evicted.setContent(
      themed(
        browserStatePageHtml({
          open: [...open],
          read: [...snapshot.read],
          readTo: Object.fromEntries(snapshot.readTo),
          since: snapshot.since,
        }),
      ),
    );
    await evicted.evaluate(`window.postMessage(${JSON.stringify(initial)}, '*')`);
    await evicted.evaluate(SETTLED);
    assert.equal(await evicted.locator(`[data-control="card:${older.key}"]`).getAttribute('aria-expanded'), 'true');
    await evicted.waitForFunction('(key) => window.__browserState.read.includes(key)', older.key);
    await evicted.waitForFunction(`(() => {
      const heading = document.querySelector('.sessionrow[data-session="bulk0"]');
      return JSON.parse(heading?.getAttribute('data-vscode-context') ?? '{}').sessionRead === 'read';
    })()`);
    const ownCard = evicted.locator(`.turn[data-key="${older.key}"]`);
    assert.equal(await ownCard.evaluate((node) => node.classList.contains('is-read')), true);
    assert.equal((await ownCard.locator('.head').getAttribute('title'))?.toLowerCase().includes('unread'), false);
    assert.equal(
      await ownCard.evaluate((node) =>
        [node, ...Array.from(node.querySelectorAll('[data-vscode-context]'))].some((element) => {
          const section = JSON.parse(element.getAttribute('data-vscode-context') ?? '{}').webviewSection;
          return section === 'arcTurnUnreadSummary' || section === 'arcTurnUnread';
        }),
      ),
      false,
      'the restored open turn retained an unread context menu',
    );
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

test('redraws keep one global listener set', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(String(error)));
    await page.setContent(countedListenerPageHtml());
    const before = await page.evaluate('structuredClone(window.__listenerCounts)');
    for (let redraw = 0; redraw < 4; redraw += 1) {
      await page.evaluate(`window.postMessage(${JSON.stringify(renderPayload())}, '*')`);
    }
    await page.evaluate(SETTLED);
    const afterRedraws = (await page.evaluate('structuredClone(window.__listenerCounts)')) as {
      document: Record<string, number>;
      window: Record<string, number>;
    };
    assert.deepEqual(afterRedraws, before, 'a redraw registered another page-level listener');
    assert.equal(afterRedraws.window.message, 1, 'the bootstrap does not own exactly one host message listener');
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

test(
  'accepted host messages emit one timing sample after each twentieth message kind',
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
      await page.evaluate(`window.__posted = []`);
      for (let count = 0; count < 39; count += 1) {
        await page.evaluate(`window.postMessage({ type: 'projectSpend', projectSpend: null }, '*')`);
      }
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.evaluate(
          `window.__posted.filter((message) => message.type === 'perf').map((message) => message.kind)`,
        ),
        ['projectSpend'],
      );
      await page.evaluate(`window.postMessage({ type: 'projectSpend', projectSpend: null }, '*')`);
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.evaluate(
          `window.__posted.filter((message) => message.type === 'perf').map((message) => message.kind)`,
        ),
        ['projectSpend', 'projectSpend'],
      );
    } finally {
      await browser.close();
    }
  },
);

test('VS Code body modes keep the panel functional', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const modes = [
      'vscode-dark',
      'vscode-light',
      'vscode-high-contrast',
      'vscode-high-contrast-light',
      'vscode-dark vscode-using-screen-reader',
      'vscode-dark vscode-reduce-motion',
    ];
    for (const mode of modes) {
      const page = await browser.newPage();
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(String(error)));
      await page.setContent(countedListenerPageHtml(mode));
      await page.evaluate(`window.postMessage(${JSON.stringify(renderPayload())}, '*')`);
      await page.evaluate(SETTLED);
      const result = (await page.evaluate(`(() => {
        const control = [...document.querySelectorAll('#list [data-control]')]
          .find((node) => node.getClientRects().length);
        control?.focus();
        return {
          classes: document.body.className,
          cards: document.querySelectorAll('#list .turn').length,
          composer: !!document.getElementById('composer'),
          focusable: document.activeElement === control,
        };
      })()`)) as { classes: string; cards: number; composer: boolean; focusable: boolean };
      assert.equal(result.classes, mode, `${mode} was removed from the webview body`);
      assert.ok(result.cards > 0, `${mode} drew no turn cards`);
      assert.equal(result.composer, true, `${mode} drew no composer`);
      assert.equal(result.focusable, true, `${mode} left the timeline controls unreachable`);
      assert.deepEqual(failures, [], `${mode} raised a browser error`);
    }
  } finally {
    await browser.close();
  }
});

// A page that records every search for the controls in the roving walk, whether it is rooted
// at the page or at one subtree of it. A repaint reads the walk many times over.
function countedScanPageHtml(): string {
  return pageHtml().replace(
    'window.__posted = [];',
    `window.__posted = [];
  window.__pageScans = [];
  window.__subtreeScans = [];
  const wholePage = (root) => root === document || root === document.body || root === document.documentElement;
  for (const owner of [Document.prototype, Element.prototype]) {
    const search = owner.querySelectorAll;
    owner.querySelectorAll = function (selector) {
      if (typeof selector === 'string' && selector.includes(',')
        && selector.includes('.head:not(')) {
        if (wholePage(this)) { window.__pageScans.push(selector); }
        else { window.__subtreeScans.push(search.call(this, '*').length); }
      }
      return search.call(this, selector);
    };
  }`,
  );
}

// The fixture with one more turn on it, so a repaint draws a control the walk has never seen.
function grownPayload(): Record<string, unknown> {
  const payload = renderPayload();
  const cards = payload.cards as Array<Record<string, unknown>>;
  const grown = {
    ...cards[0],
    key: `${String(cards[0].key)}-again`,
    headline: 'A turn drawn after the walk had been read once.',
  };
  return { ...payload, cards: [grown, ...cards] };
}

test('a repaint reads the roving walk without searching the whole page for it', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(String(error)));
    await page.setContent(countedScanPageHtml());
    await page.evaluate(`window.postMessage(${JSON.stringify(renderPayload())}, '*')`);
    await page.evaluate(SETTLED);
    await page.evaluate('window.__pageScans = []; window.__subtreeScans = [];');
    for (let redraw = 0; redraw < 3; redraw += 1) {
      await page.evaluate(`window.postMessage(${JSON.stringify(grownPayload())}, '*')`);
    }
    await page.evaluate(SETTLED);
    // Every figure the page is asked for is read in one go, and the counts come first,
    // because a question the test asks is searched and counted the way a repaint would be.
    const measured = (await page.evaluate(`(() => ({
      scans: window.__pageScans.slice(0, 4),
      counted: window.__pageScans.length,
      subtrees: window.__subtreeScans.length,
      controls: document.getElementById('list').querySelectorAll(${JSON.stringify(ROVING_SELECTOR)}).length,
      stops: Array.from(document.getElementById('list').querySelectorAll(${JSON.stringify(ROVING_SELECTOR)}))
        .filter((node) => node.getAttribute('tabindex') === '0').length,
    }))()`)) as { scans: string[]; counted: number; subtrees: number; controls: number; stops: number };
    // What this holds: no read of the walk searches the whole page for it. What it does not
    // hold: the marking pass still runs the selector over each subtree the page adds, and a
    // repaint that replaces the timeline adds one subtree holding most of the page.
    assert.ok(
      measured.subtrees > 0,
      'no search for the roving walk was seen at all, so an empty whole-page count proves nothing',
    );
    assert.deepEqual(
      measured.scans,
      [],
      `${measured.counted} repaint searches ran over the whole page for the roving walk`,
    );
    assert.ok(measured.controls > 20, `the page holds ${measured.controls} roving controls`);
    assert.equal(
      measured.stops,
      1,
      `the repaints left ${measured.stops} roving tab stops, so the arrow keys have no one place to start`,
    );
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

test('a control drawn after the roving walk was read joins the walk', { timeout: 60_000 }, async (t) => {
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
    await page.evaluate(`window.postMessage(${JSON.stringify(renderPayload())}, '*')`);
    await page.evaluate(SETTLED);
    const grown = grownPayload();
    const drawnLast = `card:${String((grown.cards as Array<Record<string, unknown>>)[0].key)}`;
    await page.evaluate(`window.postMessage(${JSON.stringify(grown)}, '*')`);
    await page.evaluate(SETTLED);
    // A control the walk holds carries a tab stop of its own, set from the walk itself. A
    // control the walk missed carries none, and the arrow keys never reach it.
    const measured = (await page.evaluate(`(() => {
      const controls = Array.from(document.getElementById('list').querySelectorAll(${JSON.stringify(ROVING_SELECTOR)}));
      const head = document.querySelector(${JSON.stringify(`[data-control="${drawnLast}"]`)});
      return {
        total: controls.length,
        missed: controls.filter((node) => !node.hasAttribute('tabindex'))
          .map((node) => node.className).slice(0, 5),
        stops: controls.filter((node) => node.getAttribute('tabindex') === '0').length,
        drawn: !!head,
        drawnStop: head ? head.getAttribute('tabindex') : null,
      };
    })()`)) as { total: number; missed: string[]; stops: number; drawn: boolean; drawnStop: string | null };
    assert.ok(measured.drawn, 'the repaint drew no head for the added turn');
    assert.deepEqual(
      measured.missed,
      [],
      'a control on the page never reached the roving walk the repaint set its stops from',
    );
    assert.notEqual(measured.drawnStop, null, 'the added turn head never joined the roving walk');
    assert.equal(measured.stops, 1, `the page holds ${measured.stops} roving tab stops`);
    assert.ok(measured.total > 20, `the page holds ${measured.total} roving controls`);
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});
