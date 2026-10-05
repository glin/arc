import assert from 'node:assert';
import { test, type TestContext } from 'vitest';
import { browserOrNone, SETTLED } from '../../test/browser.ts';
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

// Advance the page's own clock, so the panel's repeating tick fires the way it does for a
// reader watching a turn run. Paused at the page's current instant first, so the advance is
// exact however long the setup took. No frame wait afterwards: a paused clock never runs an
// animation frame, and the tick writes its text synchronously.
//
// Reading the instant and pausing at it are two separate round trips, and the clock keeps
// running between them. A slow round trip lands the pause behind the instant it was told to
// stop at, and Playwright refuses to fast-forward a paused clock backward. Retrying the pair
// on that one error reads a fresh instant each time, so the retry costs no fixed wait and the
// advance stays exact. A bounded attempt count catches a round trip that keeps losing the race.
const MAX_PAUSE_ATTEMPTS = 5;

async function runFor(page: Page, ms: number): Promise<void> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < MAX_PAUSE_ATTEMPTS; attempt += 1) {
    try {
      await page.clock.pauseAt(await page.evaluate('Date.now()'));
      await page.clock.runFor(ms);
      return;
    } catch (error) {
      lastError = error as Error;
      if (!/Cannot fast-forward to the past/.test(lastError.message)) {
        throw lastError;
      }
    }
  }
  throw new Error(
    `pauseAt lost the race against the page clock ${MAX_PAUSE_ATTEMPTS} times in a row: ${lastError?.message}`,
  );
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

    // One second, which is a whole tick and no part of a minute. The figure the reader is
    // holding must not be rewritten for it.
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

    // The card's spoken name carries its age, and the age is not one of the fields the
    // content print compares. So the card is not drawn again and this is the only writer.
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
    // Both ages five minutes old, so a minute on the clock moves the wording of either.
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
