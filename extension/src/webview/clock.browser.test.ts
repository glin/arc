import assert from 'node:assert';
import { test, type TestContext } from 'vitest';
import { browserOrNone, pauseClock, SETTLED } from '../../test/browser.ts';
import { FIXTURE_CLOCK, pageHtml, renderPayload } from '../panelfixture.ts';

type Page = import('playwright-core').Page;

interface Card extends Record<string, unknown> {
  key: string;
  sessionId: string;
  label: string;
}

interface Payload extends Record<string, unknown> {
  cards: Card[];
}

async function post(page: Page, payload: unknown): Promise<void> {
  await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
  await page.evaluate(SETTLED);
}

// Advance paused timers by an exact duration. The synchronous tick needs no animation-frame wait.
async function runFor(page: Page, ms: number): Promise<void> {
  await pauseClock(page);
  await page.clock.runFor(ms);
}

async function pageFor(t: TestContext): Promise<{ page: Page; close(): Promise<void> } | null> {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
  }
  const page = await browser.newPage();
  await page.setContent(pageHtml());
  return { page, close: () => browser.close() };
}

test('a tick rewords the visible age and leaves the reader on the control they held', async (t) => {
  const held = await pageFor(t);
  if (!held) return;
  const { page } = held;
  try {
    const payload = renderPayload() as Payload;
    await post(page, payload);
    const head = `[data-key=${JSON.stringify(payload.cards[2].key)}] .head`;
    await page.locator(head).focus();
    await page.evaluate(`window.__head = document.querySelector(${JSON.stringify(head)})`);
    const before = await page.locator(`${head} .when`).textContent();

    await runFor(page, 61_000);

    assert.notEqual(
      await page.locator(`${head} .when`).textContent(),
      before,
      'the age never moved, so this guard cannot tell a live tick from a stopped one',
    );
    assert.equal(
      await page.evaluate(`window.__head === document.querySelector(${JSON.stringify(head)})`),
      true,
      'the tick replaced the control the reader was standing on',
    );
    assert.equal(
      await page.evaluate(`document.activeElement === window.__head`),
      true,
      'the tick took the focus off the control the reader was standing on',
    );
  } finally {
    await held.close();
  }
});

test('a tick leaves a selection inside a figure whose wording has not moved', async (t) => {
  const held = await pageFor(t);
  if (!held) return;
  const { page } = held;
  try {
    const payload = renderPayload() as Payload;
    const running = payload.cards[0];
    running.live = true;
    running.duration = '5m';
    running.durationWord = 'Running for';
    running.startedAt = FIXTURE_CLOCK - 300_000;
    await post(page, payload);

    const value = `[data-key=${JSON.stringify(running.key)}] .durationvalue`;
    assert.equal(await page.locator(value).textContent(), '5m');
    const selected = (await page.evaluate(`(() => {
      const target = document.querySelector(${JSON.stringify(value)});
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      window.__figure = target.firstChild;
      return selection.toString();
    })()`)) as string;
    assert.equal(selected, '5m');

    // One second fires a tick without changing the minute figure's wording.
    await runFor(page, 1_000);

    assert.equal(
      await page.evaluate(`getSelection().toString()`),
      selected,
      'the tick dropped the selection the reader was holding inside the figure',
    );
    assert.equal(
      await page.evaluate(`window.__figure === document.querySelector(${JSON.stringify(value)}).firstChild`),
      true,
      'the tick replaced the text of a figure whose wording had not moved',
    );
  } finally {
    await held.close();
  }
});

test('a clock-only card change updates the accessible name in place', async (t) => {
  const held = await pageFor(t);
  if (!held) return;
  const { page } = held;
  try {
    const payload = renderPayload() as Payload;
    await post(page, payload);
    const card = payload.cards[1];
    const head = `[data-key=${JSON.stringify(card.key)}] .head`;
    const before = await page.locator(head).getAttribute('aria-label');
    assert.ok(before, 'the head carries no accessible name to begin with');
    await page.evaluate(`window.__head = document.querySelector(${JSON.stringify(head)})`);

    // Changing only the spoken name leaves the content fingerprint unchanged and avoids a redraw.
    await post(page, {
      type: 'activity',
      session: card.sessionId,
      card: { ...card, label: `${before} and a minute later` },
    });

    assert.equal(await page.locator(head).getAttribute('aria-label'), `${before} and a minute later`);
    assert.equal(
      await page.evaluate(`window.__head === document.querySelector(${JSON.stringify(head)})`),
      true,
      'the name update replaced the control that carries it',
    );
  } finally {
    await held.close();
  }
});

test('the clock writes nothing into a card that has left the page', async (t) => {
  const held = await pageFor(t);
  if (!held) return;
  const { page } = held;
  try {
    const payload = renderPayload() as Payload;
    // Set both ages to five minutes so advancing a minute changes both figures.
    const staying = payload.cards[1];
    const going = payload.cards[6];
    staying.endedAt = FIXTURE_CLOCK - 300_000;
    going.endedAt = FIXTURE_CLOCK - 300_000;
    await post(page, payload);
    const stays = `[data-key=${JSON.stringify(staying.key)}] .when`;
    const before = await page.locator(stays).textContent();
    const gone = (await page.evaluate(`(() => {
      window.__gone = document.querySelector(${JSON.stringify(`[data-key=${JSON.stringify(going.key)}] .when`)});
      return window.__gone.textContent;
    })()`)) as string;
    assert.equal(gone, before, 'the two ages did not start together');

    await post(page, { ...payload, cards: payload.cards.slice(0, 3) });
    assert.equal(await page.locator(`[data-key=${JSON.stringify(going.key)}]`).count(), 0);

    await runFor(page, 61_000);

    assert.notEqual(
      await page.locator(stays).textContent(),
      before,
      'the surviving age never moved, so this guard cannot tell a live tick from a stopped one',
    );
    assert.equal(await page.evaluate(`window.__gone.isConnected`), false);
    assert.equal(
      await page.evaluate(`window.__gone.textContent`),
      gone,
      'the clock kept a node the page had dropped and went on writing into it',
    );
  } finally {
    await held.close();
  }
});
