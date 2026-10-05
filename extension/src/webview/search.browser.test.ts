import assert from 'node:assert';
import { test, type TestContext } from 'vitest';
import * as esbuild from 'esbuild';
import { browserOrNone, SETTLED } from '../../test/browser.ts';
import { renderPayload } from '../panelfixture.ts';
import { CARD_ACTIONS } from '../turncard.ts';

type Page = import('playwright-core').Page;

interface Hit {
  key: string;
  sessionId: string;
  sessionTitle: string;
  agent: string;
  when: string;
  where: 'prompt' | 'summary';
  snippet: string;
  ranges: [number, number][];
}

function hit(key: string, session: string, snippet = 'needle result'): Hit {
  return {
    key,
    sessionId: session,
    sessionTitle: `Session ${session}`,
    agent: 'Claude',
    when: 'now',
    where: 'summary',
    snippet,
    ranges: [[0, 6]],
  };
}

async function post(page: Page, payload: unknown): Promise<void> {
  await page.evaluate(
    `document.dispatchEvent(new CustomEvent('arc-test-host', { detail: ${JSON.stringify(payload)} }))`,
  );
  await page.evaluate(SETTLED);
}

// The query the panel actually asked for, read back off the posts. The owner turns a plain
// query into the grammar's own find term, so a test that spelled the term out would pass
// against a panel that asked for something else.
async function search(page: Page, query: string): Promise<string> {
  return (await page.evaluate(`(() => {
    document.dispatchEvent(new CustomEvent('arc-test-search', { detail: ${JSON.stringify(query)} }));
    return window.__posted.filter((message) => message.type === 'search').at(-1).text;
  })()`)) as string;
}

async function answer(page: Page, query: string, scope: string, hits: Hit[]): Promise<void> {
  await post(page, { type: 'results', query, scope, hits });
}

async function pageFor(t: TestContext): Promise<{ page: Page; close(): Promise<void> } | null> {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
  }
  const page = await browser.newPage();
  await page.setContent('<main id="list"><div class="controls"></div></main>');
  const entry = `
    import { cardPrint, createCardRenderer } from './card.ts';
    import { createCommentRenderer } from './comments.ts';
    import { markdownOf, nextId } from './dom.ts';
    import { createNavigation } from './navigation.ts';
    import { createQueueLiveRenderer } from './queue-live.ts';
    import { createReadState } from './read-state.ts';
    import { createSearchRenderer } from './search.ts';
    import { createStatDetailRenderer } from './stat-detail.ts';
    import { createTimelineRenderer } from './timeline-renderer.ts';
    import { CARD_GLYPHS } from '../view/card-presentation.ts';
    window.__posted = [];
    const list = document.getElementById('list');
    const retained = list.querySelector('.controls');
    const events = {
      document(type, listener, options) { document.addEventListener(type, listener, options); },
      window(type, listener, options) { window.addEventListener(type, listener, options); },
    };
    const navigation = createNavigation({
      document, window, list, events,
      observe(target, callback, init) {
        const watcher = new MutationObserver(callback);
        watcher.observe(target, init);
        return watcher;
      },
      sendToHost(message) { window.__posted.push(message); },
      toTopLabel: 'Back to top',
    });
    navigation.installRoving();
    let cards = [];
    let sessions = [];
    let composer = null;
    const open = new Set();
    let comments;
    const read = createReadState({
      initial: {}, open, cards: () => cards,
      newestTurnAt: () => null, save() {},
      refreshSelection() { comments?.refreshSelection(); },
    });
    comments = createCommentRenderer({
      document, list, read, open, initial: [], cross: '\u00d7', unreadWord: 'Unread', events,
      post(message) { window.__posted.push(message); }, save() {}, updateLatest() {}, markdownOf, nextId,
      attachSlash() {}, releaseSlash() {}, attachLineClipboard() {}, labeled: () => false,
    });
    const statDetails = createStatDetailRenderer({
      document, events, placeFloat() {}, selectionWithin(node) { return comments.selectionWithin(node); },
    });
    const cardOptions = {
      post(message) { window.__posted.push(message); }, read, comments, statDetails,
      layout: () => ({ cardLayout: 'compact', promptPosition: 'above' }),
    };
    const cardRenderer = createCardRenderer(cardOptions);
    const timeline = createTimelineRenderer({
      document, events, list, retained, cardRenderer, cardOptions, open, saveOpen() {},
      twist: { open: '\u25be', shut: '\u25b8' }, cardPrint, interactions: comments,
      beforeCardDraw(node) { comments.beforeCardDraw(node); }, rowContext: () => '{}',
      pinned: () => false, setPinned() {}, labels: () => [],
      labelOpen: () => false, filterable: () => false, filterByLabel() {}, toggleLabelEditor() {}, toggleLayoutDialog() {},
      syncDetails() {}, setRoving: navigation.setRoving, allControls: navigation.allControls,
      rovingControls: navigation.rovingControls, fallbackFocus: () => null,
    });
    list.append(timeline.element);
    const search = createSearchRenderer({
      document,
      sendToHost(message) { window.__posted.push(message); },
    });
    const queue = createQueueLiveRenderer({
      document, list, glyphs: CARD_GLYPHS, twist: { open: '\u25be', shut: '\u25b8' }, comments,
      replaceLive(session, live) {
        if (!composer || composer.sessionId !== session) return null;
        composer = { ...composer, live };
        return composer;
      },
      sendToHost(message) { window.__posted.push(message); }, beforeEdit() { return 0; },
      allControls: navigation.allControls, rovingControls: navigation.rovingControls,
      setRoving: navigation.setRoving,
    });
    const transient = () => composer && (composer.live.length || composer.queue.length)
      ? { id: composer.sessionId, title: composer.targetName } : null;
    const draw = () => {
      const held = transient();
      if (search.draw('s1')) {
        timeline.showForeign([search.element], [], held
          ? { cards: [], sessions: [], transient: held } : undefined);
      } else {
        timeline.update({ cards, sessions, transient: held });
      }
      queue.update(composer);
      navigation.refreshBackToTop();
      const controls = navigation.rovingControls();
      navigation.setRoving(controls.find((node) => node.tabIndex === 0) || controls[0], controls);
    };
    document.addEventListener('arc-test-search', (event) => {
      search.start(event.detail);
      draw();
    });
    document.addEventListener('arc-test-host', (event) => {
      const message = event.detail;
      if (message.type === 'results') {
        if (search.accept(message.query, message.scope, message.hits)) draw();
      } else if (message.type === 'forgetState') {
        search.reset();
        draw();
      } else if (message.type === 'render' && Array.isArray(message.cards)) {
        cards = message.cards;
        sessions = message.sessions;
        composer = message.usage?.composer || null;
        draw();
      } else if (message.type === 'activity') {
        const at = cards.findIndex((card) => card.key === message.card.key);
        if (at >= 0) cards[at] = message.card;
        timeline.updateCard(message.session, message.card);
      } else if (message.type === 'usage') {
        const before = transient()?.id;
        composer = message.usage?.composer || null;
        if (before !== transient()?.id) draw();
        else queue.update(composer);
      }
    });
  `;
  const bundle = esbuild.buildSync({
    stdin: { contents: entry, resolveDir: __dirname, sourcefile: 'search-browser-harness.ts' },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
  }).outputFiles[0].text;
  await page.addScriptTag({ content: bundle });
  await post(page, renderPayload());
  return { page, close: () => browser.close() };
}

test('a result row keeps its identity and its mark across an unrelated repaint', async (t) => {
  const held = await pageFor(t);
  if (!held) return;
  const { page } = held;
  try {
    const query = await search(page, 'needle');
    await answer(page, query, 'workspace', [hit('k1', 's1'), hit('k2', 's2')]);
    assert.equal(await page.locator('.timeline-foreign .result').count(), 2);
    assert.equal(
      await page.locator('.timeline-foreign .resultsnippet .hl').first().textContent(),
      'needle',
      'the mark does not come from the ranges the search sent',
    );
    assert.equal(await page.locator('.timeline-foreign .resultcount').textContent(), '2 turns');
    await page.evaluate(`window.__firstResult = document.querySelectorAll('.timeline-foreign .result')[1]`);

    // An ordinary render, which is what arrives every few seconds while a turn runs.
    await post(page, renderPayload());

    assert.equal(
      await page.evaluate(`window.__firstResult === document.querySelectorAll('.timeline-foreign .result')[1]`),
      true,
      'an unrelated repaint replaced a result row the reader was standing on',
    );
  } finally {
    await held.close();
  }
});

test('a second answer keeps the rows both queries found and drops the rest', async (t) => {
  const held = await pageFor(t);
  if (!held) return;
  const { page } = held;
  try {
    const first = await search(page, 'needle');
    await answer(page, first, 'workspace', [hit('k1', 's1'), hit('k2', 's2')]);
    await page.evaluate(`window.__shared = document.querySelector('[data-control="result:k2"]')`);

    const second = await search(page, 'thread');
    await answer(page, second, 'workspace', [hit('k2', 's2'), hit('k3', 's3')]);

    assert.deepEqual(
      await page.evaluate(
        `[...document.querySelectorAll('.timeline-foreign .result')].map((node) => node.dataset.control)`,
      ),
      ['result:k2', 'result:k3'],
    );
    assert.equal(
      await page.evaluate(`window.__shared === document.querySelector('[data-control="result:k2"]')`),
      true,
      'a row both answers found was rebuilt rather than kept',
    );
  } finally {
    await held.close();
  }
});

test('a reply that answers an older query is refused', async (t) => {
  const held = await pageFor(t);
  if (!held) return;
  const { page } = held;
  try {
    const first = await search(page, 'needle');
    await search(page, 'thread');
    await answer(page, first, 'workspace', [hit('k1', 's1')]);
    assert.equal(
      await page.locator('.timeline-foreign .result').count(),
      0,
      'a stale reply drew results for a query nobody wants',
    );
    assert.equal(
      await page.locator('.timeline-foreign .empty').textContent(),
      CARD_ACTIONS.searchWorkingScoped,
      'the busy line went with the stale reply',
    );
  } finally {
    await held.close();
  }
});

test('pressing a result shows that session and refuses the reply the press dismissed', async (t) => {
  const held = await pageFor(t);
  if (!held) return;
  const { page } = held;
  try {
    const query = await search(page, 'needle');
    await answer(page, query, 'workspace', [hit('k1', 's2')]);
    await page.evaluate(`window.__posted = []`);
    await page.locator('[data-control="result:k1"]').click();

    assert.deepEqual(await page.evaluate(`window.__posted.at(-1)`), { type: 'showSession', session: 's2' });
    // The render the press brings draws the session, not this same list again.
    await post(page, renderPayload());
    assert.equal(
      await page.locator('.timeline-foreign .result').count(),
      0,
      'the results stayed up, so the chosen session was never drawn',
    );
  } finally {
    await held.close();
  }
});

test('a press dismisses a search that is still running', async (t) => {
  const held = await pageFor(t);
  if (!held) return;
  const { page } = held;
  try {
    // The first answer's rows stay on screen while a second search runs, because a reader
    // refining a query must not be left looking at nothing.
    const first = await search(page, 'needle');
    await answer(page, first, 'workspace', [hit('k1', 's2')]);
    const second = await search(page, 'thread');
    assert.equal(
      await page.locator('.timeline-foreign .result').count(),
      1,
      'the earlier rows went the moment a second search started',
    );

    await page.locator('[data-control="result:k1"]').click();
    await post(page, renderPayload());
    assert.equal(await page.locator('.timeline-foreign .result').count(), 0);

    // The second search finishes after the press. It answers a query the reader has left.
    await answer(page, second, 'workspace', [hit('k9', 's3')]);
    assert.equal(
      await page.locator('.timeline-foreign .result').count(),
      0,
      'a search the press dismissed drew itself over the session the press chose',
    );
  } finally {
    await held.close();
  }
});

test('an empty answer is worded by the scope the search actually covered', async (t) => {
  const held = await pageFor(t);
  if (!held) return;
  const { page } = held;
  try {
    const query = await search(page, 'needle');
    // The session on screen is pinned, and the reply still decides the wording, because the
    // pin can move while the reply is in flight.
    await answer(page, query, 'sessionPart', []);
    assert.equal(
      await page.locator('.timeline-foreign .results .empty').textContent(),
      CARD_ACTIONS.searchEmptyByScope.sessionPart,
    );

    const again = await search(page, 'thread');
    await answer(page, again, 'nonsense', []);
    assert.equal(
      await page.locator('.timeline-foreign .results .empty').textContent(),
      CARD_ACTIONS.searchEmptyByScope.workspace,
      'a scope the panel cannot word claims one it did not cover',
    );
  } finally {
    await held.close();
  }
});

test('a count says which scope answered it', async (t) => {
  const held = await pageFor(t);
  if (!held) return;
  const { page } = held;
  try {
    const query = await search(page, 'needle');
    await answer(page, query, 'session', [hit('k1', 's1')]);
    assert.equal(
      await page.locator('.timeline-foreign .resultcount').textContent(),
      `1 turn ${CARD_ACTIONS.searchCountByScope.session}`,
    );
  } finally {
    await held.close();
  }
});

test('activity keeps search results queued behind selected timeline text', async (t) => {
  const held = await pageFor(t);
  if (!held) return;
  const { page } = held;
  try {
    const payload = renderPayload() as { cards: Record<string, unknown>[] };
    const selectedCard = payload.cards[0];
    const updatedCard = payload.cards[1];
    await page.locator(`[data-control=${JSON.stringify(`card:${selectedCard.key}`)}]`).click();
    const selected = await page.evaluate(`(() => {
      const target = document.querySelector('[data-key=${JSON.stringify(selectedCard.key)}] .summary');
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    })()`);
    const query = await search(page, 'needle');
    await answer(page, query, 'workspace', [hit(String(selectedCard.key), String(selectedCard.sessionId))]);
    await post(page, {
      type: 'activity',
      session: updatedCard.sessionId,
      card: { ...updatedCard, headline: 'Activity arrived while search waited.' },
    });
    assert.equal(await page.locator('.timeline-foreign .result').count(), 0);
    assert.equal(await page.evaluate(`getSelection().toString()`), selected);

    await page.evaluate(`(() => {
      getSelection().removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
    })()`);
    await page.evaluate(SETTLED);
    await page.locator('.timeline-foreign .result').waitFor();
    assert.equal(await page.locator('.timeline-foreign .resultsnippet').textContent(), 'needle result');
  } finally {
    await held.close();
  }
});

test('search keeps live work inside the same transient session mount', async (t) => {
  const held = await pageFor(t);
  if (!held) return;
  const { page } = held;
  try {
    const payload = renderPayload(
      [],
      [
        {
          sessionId: 'fresh-session',
          agent: 'claude',
          kind: 'prompt',
          text: 'Start fresh.',
          reply: '',
          at: Date.now(),
          midTurn: false,
          ran: false,
          started: false,
          failed: false,
          reason: '',
        },
      ],
    ) as { cards: Record<string, unknown>[]; usage: { composer: Record<string, unknown> } };
    const card = payload.cards[0];
    const composer = payload.usage.composer;
    composer.sessionId = card.sessionId;
    composer.targetName = card.sessionTitle;
    (composer.live as Array<Record<string, unknown>>)[0].sessionId = card.sessionId;
    await post(page, payload);
    await page.evaluate(`window.__transientMount = document.querySelector('.transientcards')`);
    const beforeName = await page.locator('.sessionsection .session .name').textContent();

    await search(page, 'needle');
    assert.equal(await page.evaluate(`window.__transientMount === document.querySelector('.transientcards')`), true);
    assert.equal(await page.locator('.sessionsection .transientcards > .clive').count(), 1);
    assert.equal(await page.locator('.sessionsection .session .name').textContent(), beforeName);
    assert.equal(await page.locator('.timeline-foreign .empty').count(), 1);
  } finally {
    await held.close();
  }
});

test('result rows share one roving tab stop and answer arrow keys', async (t) => {
  const held = await pageFor(t);
  if (!held) return;
  const { page } = held;
  try {
    const query = await search(page, 'needle');
    await answer(page, query, 'workspace', [hit('k1', 's1'), hit('k2', 's2'), hit('k3', 's3')]);
    const stops = `[...document.querySelectorAll('.timeline-foreign .result')].map((node) => node.tabIndex)`;
    await page.locator('[data-control="result:k1"]').focus();
    assert.deepEqual(await page.evaluate(stops), [0, -1, -1]);
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(`document.activeElement.dataset.control`), 'result:k2');
    assert.deepEqual(await page.evaluate(stops), [-1, 0, -1]);
  } finally {
    await held.close();
  }
});

test('back to top appears after one viewport and returns focus to the timeline', async (t) => {
  const held = await pageFor(t);
  if (!held) return;
  const { page } = held;
  try {
    await page.evaluate(`(() => {
      document.getElementById('list').style.minHeight = '2400px';
      document.scrollingElement.scrollTop = innerHeight + 40;
      document.dispatchEvent(new Event('scroll'));
    })()`);
    const button = page.locator('.totop');
    assert.equal(await button.isHidden(), false);
    await button.click();
    assert.equal(await page.evaluate(`document.scrollingElement.scrollTop`), 0);
    assert.equal(await page.evaluate(`document.getElementById('list').contains(document.activeElement)`), true);
    assert.equal(await button.isHidden(), true);
  } finally {
    await held.close();
  }
});

test('forgetting everything takes the results and the query with it', async (t) => {
  const held = await pageFor(t);
  if (!held) return;
  const { page } = held;
  try {
    const query = await search(page, 'needle');
    await answer(page, query, 'workspace', [hit('k1', 's1')]);
    assert.equal(await page.locator('.timeline-foreign .result').count(), 1);

    await post(page, { type: 'forgetState', since: 17 });
    assert.equal(await page.locator('.timeline-foreign .result').count(), 0);

    // The query went with them, so the reply it would have answered is refused.
    await answer(page, query, 'workspace', [hit('k1', 's1')]);
    assert.equal(
      await page.locator('.timeline-foreign .result').count(),
      0,
      'a reply for the forgotten query drew itself again',
    );
  } finally {
    await held.close();
  }
});
