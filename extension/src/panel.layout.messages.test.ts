// Browser layout checks for bounded Activity log messages.
// Shared measurement helpers live in `../test/layout.ts`.

import { test } from 'vitest';
import assert from 'node:assert';
import * as path from 'node:path';
import { browserOrNone, SETTLED } from '../test/browser.ts';
import { CARD_ACTIONS } from './turnview.ts';
import { imageFileFor, renderRichMarkdown } from './richtext.ts';
import { NOW, pageHtml, renderPayload } from './panelfixture.ts';
import { layoutAt, setLogMessages, BoundedBlock, SnappedBlock, Measured, TALL_PICTURE } from '../test/layout.ts';

// A resized message must offer access to clipped content and remove fully clipped controls from the tab order.

test('a bounded message follows its own size, and holds no tab stop under the cut', { timeout: 90_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (e) => failures.push(String(e)));
    await page.setViewportSize({ width: 1350, height: 900 });
    await page.setContent(pageHtml());
    const payload = renderPayload() as { cards: Record<string, unknown>[] };
    const line =
      'The parser now walks a table instead of a switch, which is one row per token ' +
      'and no code at all for a new one, and the table is generated from the grammar.';
    // The commentary fixture fits at editor-tab width and exceeds its six-line limit at sidebar width.

    const fits = `<p>Paragraph 1. ${line} ${line} ${line.slice(0, 40)}</p>`;
    // Place links above and below the cut. Overflow clipping alone leaves the hidden link focusable.

    const long = [
      '<p><a data-link="src/top.ts">the link above the cut</a></p>',
      ...Array.from({ length: 40 }, (_, n) => `<p>Paragraph ${n + 1}. ${line}</p>`),
      '<p><a data-link="src/bottom.ts">the link below the cut</a></p>',
    ].join('');
    payload.cards[0].saidMessages = [
      {
        id: 'commentary:1:0',
        kind: 'commentary',
        at: NOW - 3000,
        text: 'fits at first',
        when: '2:31 PM',
        absolute: '2:31 PM',
        summaryHtml: fits,
      },
      {
        id: 'commentary:2:0',
        kind: 'commentary',
        at: NOW - 2000,
        text: 'long at any width',
        when: '2:32 PM',
        absolute: '2:32 PM',
        summaryHtml: long,
      },
    ];
    setLogMessages(payload.cards[0]);
    payload.cards[0].saidName = 'Said while working, 2 messages';
    payload.cards[0].saidMix = '2 messages';
    // Keep one card because the measurement reads all message blocks on the page.

    payload.cards = [payload.cards[0]];
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
    await page.evaluate(`document.querySelector('#list .turn .head').click()`);
    await page.evaluate(SETTLED);

    const read = `(() => {
      const blocks = [...document.querySelectorAll('#list .turn .activitysec .said')];
      const of = (n) => {
        const block = blocks[n];
        const text = block.querySelector('.saidtext');
        const more = block.querySelector('button.more');
        const links = [...block.querySelectorAll('a[data-link]')];
        return {
          bounded: text.scrollHeight > text.clientHeight + 2,
          height: text.scrollHeight,
          // The cut itself, not the drawn height: an unbounded block reports the two the same.
          bound: parseFloat(getComputedStyle(text).maxHeight),
          moreHidden: more.hidden,
          moreWord: more.textContent,
          // The tab stop each link holds, in the order they are drawn.
          stops: links.map((a) => a.getAttribute('tabindex')),
          // Which of them the cut is actually below, measured the same way the panel does.
          under: links.map((a) => a.getBoundingClientRect().top >= text.getBoundingClientRect().bottom),
        };
      };
      return { count: blocks.length, fits: of(0), long: of(1) };
    })()`;

    const wide = (await page.evaluate(read)) as { count: number; fits: BoundedBlock; long: BoundedBlock };
    assert.deepEqual(failures, [], 'the panel threw while drawing the mid-turn messages');
    assert.equal(wide.count, 2, 'the card drew a different number of messages from the one it was given');
    assert.equal(
      wide.fits.bounded,
      false,
      `the short message is already clipped at the wide width (${wide.fits.height} into ${wide.fits.bound})`,
    );
    assert.equal(wide.fits.moreHidden, true, 'a message with nothing hidden offers to show the rest');
    // Keep a 40px margin from the bound to allow font differences.

    assert.ok(
      wide.fits.height < wide.fits.bound - 40,
      `the short message clears the bound by only ${wide.fits.bound - wide.fits.height}px when it is wide`,
    );
    assert.equal(wide.long.bounded, true, 'the long message is drawn at its full height');
    assert.equal(wide.long.moreHidden, false, 'the long message offers no way to read the rest of it');
    // Check that the cut separates the two links before checking their tab stops.
    assert.deepEqual(
      wide.long.under,
      [false, true],
      'the fixture no longer puts one link above the cut and one below it',
    );
    assert.deepEqual(
      wide.long.stops,
      [null, '-1'],
      'keyboard focus walks into controls under the cut that the reader cannot see',
    );

    // Resize without sending another card. Read inside ResizeObserver after the block measures and before painting. Two animation frames do not ensure observer delivery.

    await page.evaluate(`(() => {
      const text = document.querySelector('#list .turn .activitysec .said .saidtext');
      const watch = new ResizeObserver(() => {
        if (text.getBoundingClientRect().width >= 600) { return; }
        watch.disconnect();
        window.__narrow = ${read};
      });
      watch.observe(text);
    })()`);
    await page.setViewportSize({ width: 340, height: 900 });
    try {
      await page.waitForFunction('window.__narrow', undefined, { timeout: 10_000 });
    } catch (error) {
      if ((error as Error).name !== 'TimeoutError') {
        throw error;
      }
      assert.fail('the message never narrowed below 600px after the viewport shrank');
    }
    const narrow = (await page.evaluate('window.__narrow')) as {
      count: number;
      fits: BoundedBlock;
      long: BoundedBlock;
    };
    assert.deepEqual(failures, [], 'the panel threw while the viewport narrowed');
    assert.equal(
      narrow.fits.bounded,
      true,
      `the fixture no longer overflows at the narrow width (${narrow.fits.height} into ${narrow.fits.bound})`,
    );
    assert.equal(
      narrow.fits.moreHidden,
      false,
      'a message that stopped fitting is clipped with no way to reach the rest of it',
    );
    assert.ok(
      narrow.fits.height > narrow.fits.bound + 40,
      `the short message breaks the bound by only ${narrow.fits.height - narrow.fits.bound}px when it is narrow`,
    );

    // Opening the whole message restores its controls to the tab order.
    await page.evaluate(`document.querySelectorAll('#list .turn .activitysec .said button.more')[1].click()`);
    await page.evaluate(SETTLED);
    const opened = (await page.evaluate(read)) as { count: number; fits: BoundedBlock; long: BoundedBlock };
    assert.equal(opened.long.bounded, false, 'the whole message is still not readable after the press');
    assert.deepEqual(
      opened.long.stops,
      [null, null],
      'a control the reader has just been shown is still out of the tab order',
    );
    assert.deepEqual(failures, [], 'the panel threw while a bounded message was opened');
  } finally {
    await browser.close();
  }
});

// The cut must end at a whole line, table row, or image. Margins, padding, and borders prevent line-height arithmetic from locating those boundaries.

test('a bounded message cuts at the bottom of a whole line, table row or picture', { timeout: 90_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (e) => failures.push(String(e)));
    // Use sidebar width so the message exceeds its bound.
    await page.setViewportSize({ width: 340, height: 900 });
    await page.setContent(pageHtml());
    const payload = renderPayload() as { cards: Record<string, unknown>[] };
    // Put a table and a code block after paragraphs to test row and line boundaries.

    const table = `<p>A table of what each pass found.</p><table><tbody>${Array.from(
      { length: 8 },
      (_, r) => `<tr><th>Row ${r + 1} of the table</th><td>${r * 7} found</td></tr>`,
    ).join('')}</tbody></table>`;
    const code = `<p>The call the parser makes now.</p><pre><code>${Array.from(
      { length: 12 },
      (_, r) => `const row${r + 1} = table.lookup(token${r + 1});`,
    ).join('\n')}</code></pre>`;
    // Wrap images in buttons, matching richtext rendering. The cut must include images inside controls.

    const shot = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='60'%3E%3C/svg%3E";
    const pictures = `<p>Three shots of what it draws.</p>${Array.from(
      { length: 3 },
      (_, n) =>
        `<button type="button" class="image-link" data-image="shot${n + 1}.png"` +
        ` aria-label="Open image: shot ${n + 1}"><img src="${shot}" alt="shot ${n + 1}"></button>`,
    ).join('')}`;
    // Place an image above the bound inside a row that extends below it. The cut must use the whole row.

    const inRow =
      `<p>What each pass found.</p><table><tbody>` +
      `<tr><th>First row</th><td>nothing</td></tr>` +
      `<tr><th style="vertical-align:top"><img src="${shot}" alt="a shot"></th><td>${
        'A cell of prose that wraps into line after line, which is what makes this row taller ' +
        'than the picture beside it and carries the row past the bound.'
      }</td></tr></tbody></table>`;
    payload.cards[0].saidMessages = [
      {
        id: 'commentary:1:0',
        kind: 'commentary',
        at: NOW - 4000,
        text: 'a table',
        when: '2:31 PM',
        absolute: '2:31 PM',
        summaryHtml: table,
      },
      {
        id: 'commentary:2:0',
        kind: 'commentary',
        at: NOW - 3000,
        text: 'a code block',
        when: '2:32 PM',
        absolute: '2:32 PM',
        summaryHtml: code,
      },
      {
        id: 'commentary:3:0',
        kind: 'commentary',
        at: NOW - 2000,
        text: 'three pictures',
        when: '2:33 PM',
        absolute: '2:33 PM',
        summaryHtml: pictures,
      },
      {
        id: 'commentary:4:0',
        kind: 'commentary',
        at: NOW - 1500,
        text: 'a picture in a row',
        when: '2:34 PM',
        absolute: '2:34 PM',
        summaryHtml: inRow,
      },
      {
        id: 'commentary:5:0',
        kind: 'commentary',
        at: NOW - 1000,
        text: 'one line',
        when: '2:35 PM',
        absolute: '2:35 PM',
        summaryHtml: '<p>One line of narration.</p>',
      },
    ];
    setLogMessages(payload.cards[0]);
    payload.cards[0].saidName = 'Said while working, 5 messages';
    payload.cards[0].saidMix = '5 messages';
    // Keep one card because the measurement reads all message blocks on the page.

    payload.cards = [payload.cards[0]];
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
    await page.evaluate(`document.querySelector('#list .turn .head').click()`);
    // Wait for images to load before measuring their dimensions.

    await page.evaluate(`Promise.all([...document.images].map((img) => img.complete
      || new Promise((done) => { img.onload = done; img.onerror = done; })))`);
    await page.evaluate(SETTLED);

    const read = `(() => [...document.querySelectorAll('#list .turn .activitysec .said')].map((block) => {
      const text = block.querySelector('.saidtext');
      const top = text.getBoundingClientRect().top;
      const from = (bottom) => Math.round((bottom - top) * 100) / 100;
      // Every unit the block holds, in the two shapes the walk knows: a whole table row, and a
      // line box of text taken off a range the way the panel takes it.
      const lines = [];
      for (const part of text.querySelectorAll('p, code')) {
        const range = document.createRange();
        range.selectNodeContents(part);
        for (const rect of range.getClientRects()) lines.push(from(rect.bottom));
      }
      return {
        cut: parseFloat(text.style.getPropertyValue('--saidcut')) || 0,
        // The bound before the snap, worked out the way the block works it out.
        bound: parseFloat(getComputedStyle(text).fontSize) * 9,
        height: text.scrollHeight,
        moreHidden: block.querySelector('button.more').hidden,
        rows: [...text.querySelectorAll('tr')].map((row) => from(row.getBoundingClientRect().bottom)),
        shots: [...text.querySelectorAll('img')].map((img) => from(img.getBoundingClientRect().bottom)),
        lines: lines,
      };
    }))()`;
    const seen = (await page.evaluate(read)) as SnappedBlock[];
    assert.deepEqual(failures, [], 'the panel threw while drawing the mid-turn messages');
    assert.equal(seen.length, 5, 'the card drew a different number of messages from the one it was given');
    const [rows, block, shots, inside, fits] = seen;
    const near = (value: number, of: number[]) => of.some((one) => Math.abs(one - value) <= 0.5);

    // The cut must match a row bottom while the original bound lies inside a row.

    assert.ok(
      rows.rows.length > 2 && rows.height > rows.bound,
      `the table message is ${rows.height}px into a ${rows.bound}px bound, so it is not cut at all`,
    );
    assert.ok(
      near(rows.cut, rows.rows),
      `the cut is ${rows.cut}px and the rows end at ${rows.rows.join(', ')}, so it runs through a row`,
    );
    assert.ok(
      !near(rows.bound, rows.rows),
      'the bare bound happens to land on a row bottom, so this fixture proves nothing about the snap',
    );
    assert.ok(rows.cut < rows.bound, 'the cut is below the bound it is meant to be moved up from');

    // The cut must match a code line bottom while the original bound lies inside a line.

    assert.ok(
      block.height > block.bound,
      `the code message is ${block.height}px into a ${block.bound}px bound, so it is not cut at all`,
    );
    assert.ok(
      near(block.cut, block.lines),
      `the cut is ${block.cut}px and the lines end at ${block.lines.join(', ')}, so it runs through a line`,
    );
    assert.ok(
      !near(block.bound, block.lines),
      'the bare bound happens to land on a line bottom, so this fixture proves nothing about the snap',
    );
    assert.ok(block.cut < block.bound, 'the cut is below the bound it is meant to be moved up from');

    // The cut must include whole images inside buttons rather than stop at the preceding paragraph.

    assert.equal(shots.shots.length, 3, 'the pictures did not reach the message, so this measures nothing');
    assert.ok(
      shots.height > shots.bound,
      `the picture message is ${shots.height}px into a ${shots.bound}px bound, so it is not cut at all`,
    );
    assert.ok(
      near(shots.cut, shots.shots),
      `the cut is ${shots.cut}px and the pictures end at ${shots.shots.join(', ')}. A walk that` +
        ` skipped what a button holds finds no picture at all and falls back to the paragraph` +
        ` over them, which ends at ${Math.max(...shots.lines)}px.`,
    );
    assert.ok(
      !near(shots.bound, shots.shots),
      'the bare bound happens to land on a picture bottom, so this fixture proves nothing about the snap',
    );

    // An image inside a table row uses the row boundary.

    assert.equal(inside.shots.length, 1, 'the picture did not reach the row, so this measures nothing');
    assert.equal(inside.rows.length, 2, 'the fixture no longer draws two rows');
    assert.ok(
      inside.shots[0] <= inside.bound && inside.rows[1] > inside.bound,
      `the picture ends at ${inside.shots[0]}px and its row at ${inside.rows[1]}px against a` +
        ` ${inside.bound}px bound. The fixture wants the bound between the two.`,
    );
    assert.ok(
      near(inside.cut, inside.rows),
      `the cut is ${inside.cut}px and the rows end at ${inside.rows.join(', ')}. A walk that takes` +
        ` a picture's own bottom stops at ${inside.shots[0]}px, part way down the row holding it.`,
    );

    // A message shorter than the bound must keep its full height and hide Show more.

    assert.ok(fits.height < fits.bound, `the short message is ${fits.height}px into a ${fits.bound}px bound`);
    assert.equal(fits.cut, 0, 'a message that fits was given a cut, so it is drawn shorter than it is');
    assert.equal(fits.moreHidden, true, 'a message with nothing hidden offers to show the rest');
  } finally {
    await browser.close();
  }
});

// A plain heading press toggles the Activity log. A Shift press toggles full-message disclosure and retains heading focus.

test('the section head opens the section, and a Shift press moves every message', { timeout: 90_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (e) => failures.push(String(e)));
    await page.setViewportSize({ width: 340, height: 900 });
    await page.setContent(pageHtml());
    const payload = renderPayload() as { cards: Record<string, unknown>[] };
    const long = Array.from({ length: 20 }, (_, n) => `<p>Line ${n + 1} of a message that keeps going.</p>`).join('');
    payload.cards[0].saidMessages = [0, 1, 2].map((n) => ({
      id: `commentary:${n}:0`,
      kind: 'commentary',
      at: NOW - (3 - n) * 1000,
      text: `message ${n + 1}`,
      when: '2:31 PM',
      absolute: '2:31 PM',
      summaryHtml: n === 2 ? '<p>One line.</p>' : long,
    }));
    setLogMessages(payload.cards[0]);
    payload.cards[0].saidName = 'Said while working, 3 messages';
    payload.cards[0].saidMix = '3 messages';
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
    await page.evaluate(`document.querySelector('#list .turn .head').click()`);
    await page.evaluate(SETTLED);

    const HEAD = `#list .turn .activitysec button.actword`;
    const read = `(() => {
      const head = document.querySelector('${HEAD}');
      const section = head.closest('.activitysec');
      return {
        shown: head.getAttribute('aria-expanded'),
        name: head.getAttribute('aria-label'),
        hint: head.dataset.hint || null,
        detail: head.dataset.hintDetail || null,
        // A native hover on a button is the defect the panel's own rules name.
        native: head.title || null,
        whole: section.querySelectorAll('.saidtext.is-full').length,
        cut: [...section.querySelectorAll('.said')]
          .filter((block) => block.querySelector('button.more').hidden === false).length,
        onHead: document.activeElement === head,
      };
    })()`;
    await page.evaluate(`document.querySelector('${HEAD}').focus()`);
    const start = (await page.evaluate(read)) as Record<string, unknown>;
    assert.deepEqual(failures, [], 'the panel threw while drawing the mid-turn messages');
    assert.equal(start.shown, 'true', 'the section is shut on a card the reader just opened');
    assert.equal(start.native, null, 'the section head writes a native hover');
    assert.equal(start.cut, 2, 'the fixture no longer cuts two messages, so this measures nothing');
    assert.equal(start.whole, 0, 'a message is open whole before the reader has pressed anything');
    // The hint and accessible name describe the heading actions in each disclosure state.

    assert.equal(start.hint, CARD_ACTIONS.saidCollapse, 'the head does not say what a plain press does');
    assert.equal(start.detail, CARD_ACTIONS.saidWholeDetail, 'the head does not say what a Shift press does');
    assert.ok(
      String(start.name).endsWith(`, ${CARD_ACTIONS.saidCollapse}`),
      `the head is announced as "${start.name}", which does not say what the next press does`,
    );

    // Shift with Enter must toggle all messages once, including when the browser synthesizes a click.

    await page.keyboard.press('Shift+Enter');
    await page.evaluate(SETTLED);
    const opened = (await page.evaluate(read)) as Record<string, unknown>;
    assert.deepEqual(failures, [], 'the panel threw while every message was opened whole');
    assert.equal(opened.whole, 3, 'Shift with Enter left a message cut, so the bulk press ran twice or not at all');
    // Bulk expansion includes short messages. Their Show less controls must remain hidden because their contents already fit.

    assert.equal(opened.cut, 2, 'a message that fits offers Show less after a bulk press, and hides under the reader');
    assert.equal(opened.onHead, true, 'the bulk press took focus off the head it was pressed on');
    assert.equal(opened.detail, CARD_ACTIONS.saidLessDetail, 'the head still offers to open what is already open');

    // Shift with Space must toggle once. The browser activates buttons when Space is released.

    await page.keyboard.press('Shift+Space');
    await page.evaluate(SETTLED);
    const shut = (await page.evaluate(read)) as Record<string, unknown>;
    assert.deepEqual(failures, [], 'the panel threw while every message was shut');
    assert.equal(shut.whole, 0, 'Shift with Space left a message whole, so the bulk press ran twice or not at all');
    // Bulk collapse must keep focus on the Activity log heading.

    assert.equal(shut.onHead, true, 'focus is somewhere else after a bulk collapse');
    assert.equal(shut.detail, CARD_ACTIONS.saidWholeDetail, 'the head still offers to shut what is already shut');

    // A plain press collapses the Activity log and keeps heading focus.
    await page.keyboard.press('Enter');
    await page.evaluate(SETTLED);
    const collapsed = (await page.evaluate(read)) as Record<string, unknown>;
    assert.deepEqual(failures, [], 'the panel threw while the section was shut');
    assert.equal(collapsed.shown, 'false', 'a plain press on the head opened every message instead of shutting it');
    assert.equal(collapsed.onHead, true, 'the plain press took focus off the head');
    assert.ok(
      String(collapsed.name).endsWith(`, ${CARD_ACTIONS.saidExpand}`),
      `the shut head is announced as "${collapsed.name}", which offers to shut what is already shut`,
    );
    assert.equal(
      collapsed.detail,
      CARD_ACTIONS.saidOpenWholeDetail,
      'the shut head does not offer to open the section with every message whole',
    );
  } finally {
    await browser.close();
  }
});

// Releasing a key after focus leaves the heading must clear keyboard-click suppression. Later mouse presses must still toggle the heading.

test('a key held past a focus change leaves the head answering the mouse', { timeout: 90_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (e) => failures.push(String(e)));
    await page.setViewportSize({ width: 360, height: 900 });
    await page.setContent(pageHtml());
    const payload = renderPayload() as { cards: Record<string, unknown>[] };
    const long = Array.from({ length: 20 }, (_, n) => `<p>Line ${n + 1} of a message that keeps going.</p>`).join('');
    payload.cards[0].saidMessages = [0, 1].map((n) => ({
      id: `commentary:${n}:0`,
      kind: 'commentary',
      at: NOW - (2 - n) * 1000,
      text: `message ${n + 1}`,
      when: '2:31 PM',
      absolute: '2:31 PM',
      summaryHtml: long,
    }));
    setLogMessages(payload.cards[0]);
    payload.cards[0].saidName = 'Said while working, 2 messages';
    payload.cards[0].saidMix = '2 messages';
    // Keep one card because the measurement reads all message blocks on the page.

    payload.cards = [payload.cards[0]];
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
    await page.evaluate(`document.querySelector('#list .turn .head').click()`);
    await page.evaluate(SETTLED);

    const HEAD = '#list .turn .activitysec button.actword';
    const shown = `document.querySelector('${HEAD}').getAttribute('aria-expanded')`;
    assert.equal(await page.evaluate(shown), 'true', 'the section is shut on a card the reader just opened');

    // Move focus to the card heading while Shift and Enter remain held, then release them there.

    await page.evaluate(`document.querySelector('${HEAD}').focus()`);
    await page.keyboard.down('Shift');
    await page.keyboard.down('Enter');
    await page.evaluate(`document.querySelector('#list .turn .head').focus()`);
    await page.keyboard.up('Enter');
    await page.keyboard.up('Shift');
    await page.evaluate(SETTLED);

    // A mouse press must still toggle the Activity log heading.
    await page.locator(HEAD).click();
    await page.evaluate(SETTLED);
    assert.deepEqual(failures, [], 'the panel threw while a held key moved focus off the head');
    assert.equal(
      await page.evaluate(shown),
      'false',
      'a key released off the head left it refusing the mouse, so the reader cannot shut the section',
    );
  } finally {
    await browser.close();
  }
});

// A block scrolled above the viewport has negative coordinates. Its cut must remain relative to its own top after reflow.

test('a bounded message scrolled above the window keeps its own bound', { timeout: 90_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (e) => failures.push(String(e)));
    await page.setViewportSize({ width: 360, height: 700 });
    await page.setContent(pageHtml());
    const payload = renderPayload() as { cards: Record<string, unknown>[] };
    const long = Array.from({ length: 30 }, (_, n) => `<p>Line ${n + 1} of a message that keeps going.</p>`).join('');
    payload.cards[0].saidMessages = [0, 1, 2, 3].map((n) => ({
      id: `commentary:${n}:0`,
      kind: 'commentary',
      at: NOW - (4 - n) * 1000,
      text: `message ${n + 1}`,
      when: '2:31 PM',
      absolute: '2:31 PM',
      summaryHtml: long,
    }));
    setLogMessages(payload.cards[0]);
    payload.cards[0].saidName = 'Said while working, 4 messages';
    payload.cards[0].saidMix = '4 messages';
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
    await page.evaluate(`document.querySelector('#list .turn .head').click()`);
    await page.evaluate(SETTLED);

    const read = `(() => {
      const text = document.querySelector('#list .turn .activitysec .said .saidtext');
      return {
        top: Math.round(text.getBoundingClientRect().top),
        cut: parseFloat(text.style.getPropertyValue('--saidcut')) || 0,
        bound: parseFloat(getComputedStyle(text).fontSize) * 9,
        drawn: text.clientHeight,
      };
    })()`;
    const first = (await page.evaluate(read)) as { top: number; cut: number; bound: number; drawn: number };
    assert.ok(first.cut > 0, 'the first message is not cut at all, so this measures nothing');

    // Scroll past the block, then resize to trigger measurement.
    await page.evaluate(`window.scrollTo(0, 900)`);
    await page.evaluate(SETTLED);
    await page.setViewportSize({ width: 330, height: 700 });
    await page.evaluate(SETTLED);
    const away = (await page.evaluate(read)) as { top: number; cut: number; bound: number; drawn: number };
    assert.deepEqual(failures, [], 'the panel threw while the reader scrolled past a bounded message');
    assert.ok(away.top < -100, `the message is ${away.top}px from the top of the window, so it never left it`);
    assert.ok(
      away.cut > 0 && away.cut <= away.bound + 1,
      `the cut is ${away.cut}px against a ${away.bound}px bound, so the block measured itself against the window`,
    );
    assert.ok(away.drawn <= away.bound + 1, `the message is drawn ${away.drawn}px tall inside a ${away.bound}px bound`);
  } finally {
    await browser.close();
  }
});

// Messages without timestamps draw no clock. Timestamp refresh must pair each remaining clock with its own message.

test('a mid-turn message with no time draws none, and the hovers stay paired', { timeout: 90_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (e) => failures.push(String(e)));
    await page.setViewportSize({ width: 900, height: 900 });
    await page.setContent(pageHtml());
    const payload = renderPayload() as { cards: Record<string, unknown>[] };
    // Place timestamp-free commentary and answer messages among timed messages. Include a dated time to expose incorrect clock pairing.

    const messages = [
      { kind: 'commentary', when: '2:31 PM', absolute: '2:31 PM' },
      { kind: 'commentary', when: '', absolute: '' },
      { kind: 'commentary', when: '2:33 PM', absolute: '2:33 PM' },
      { kind: 'commentary', when: '2:34 PM', absolute: 'Aug 22 2:34 PM' },
      { kind: 'answer', when: '', absolute: '' },
    ].map((one, n) => ({
      id: `${one.kind}:${n}:0`,
      at: n ? NOW - (5 - n) * 1000 : 0,
      text: `message ${n + 1}`,
      summaryHtml: `<p>Message ${n + 1}.</p>`,
      ...one,
      ...(one.kind === 'answer' ? { answerIndex: 0 } : {}),
    }));
    payload.cards[0].saidMessages = messages;
    setLogMessages(payload.cards[0]);
    payload.cards[0].saidName = 'Said while working, 5 messages, 1 reply';
    payload.cards[0].saidMix = '5 messages, 1 reply';
    // Keep one card because the measurement reads all message blocks on the page.

    payload.cards = [payload.cards[0]];
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
    await page.evaluate(`document.querySelector('#list .turn .head').click()`);
    await page.evaluate(SETTLED);
    // Resend unchanged cards to exercise in-place timestamp refresh.

    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);

    const seen = (await page.evaluate(`(() => {
      const blocks = [...document.querySelectorAll('#list .turn .activitysec .said')];
      return {
        blocks: blocks.length,
        metas: blocks.map((block) => {
          const meta = block.querySelector('.saidonly');
          return meta && meta.textContent.trim() || null;
        }),
        clocks: blocks.filter((block) => block.title && block.title !== 'Replied')
          .map((block) => ({ words: block.querySelector('.saidonly').textContent, hover: block.title })),
      };
    })()`)) as {
      blocks: number;
      metas: (string | null)[];
      clocks: { words: string; hover: string }[];
    };
    assert.deepEqual(failures, [], 'the panel threw while drawing a message with no time');
    assert.equal(seen.blocks, 5, 'the card drew a different number of messages from the one it was given');
    // Timestamp-free commentary draws no metadata. A timestamp-free answer keeps the Replied label.

    assert.deepEqual(
      seen.metas,
      ['2:31 PM', null, '2:33 PM', 'Aug 22 2:34 PM', 'Replied'],
      'a message with no time draws one anyway, or a line with nothing on it',
    );
    // Each of the three clock tooltips must retain its own message time.
    assert.deepEqual(
      seen.clocks.map((one) => one.words),
      ['2:31 PM', '2:33 PM', 'Aug 22 2:34 PM'],
    );
    assert.deepEqual(
      seen.clocks.map((one) => one.hover),
      ['2:31 PM', '2:33 PM', 'Aug 22 2:34 PM'],
      'a hover reveals the moment of another message, so the refresh paired the spans wrongly',
    );
  } finally {
    await browser.close();
  }
});

// Comment updates replace marks without resizing message text. New marks below the cut must remain outside the tab order.

test(
  'a comment mark inside a bounded message is drawn, and keeps out of the tab order',
  { timeout: 90_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
      return;
    }
    try {
      const page = await browser.newPage();
      const failures: string[] = [];
      page.on('pageerror', (e) => failures.push(String(e)));
      await page.setViewportSize({ width: 900, height: 900 });
      await page.setContent(pageHtml());
      const payload = renderPayload() as { cards: Record<string, unknown>[]; comments: unknown[] };
      const card = payload.cards[0] as { key: string; sessionId: string };
      // Use an earlier answer to test saved answer-index comments.
      const above = 'The line above the cut, which the reader can see.';
      const below = 'The line below the cut, which the reader cannot see.';
      const answer = [
        `<p>${above}</p>`,
        ...Array.from(
          { length: 40 },
          (_, n) => `<p>Paragraph ${n + 1} of an answer that runs on well past the bound.</p>`,
        ),
        `<p>${below}</p>`,
      ].join('');
      payload.cards[0].earlierAnswers = [
        {
          summary: 'the panel draws the html, not this',
          summaryHtml: answer,
          at: NOW - 600_000,
          absolute: 'earlier today',
        },
      ];
      payload.cards[0].saidMessages = [
        {
          id: 'answer:1:0',
          kind: 'answer',
          text: 'the panel draws the html, not this',
          summaryHtml: answer,
          at: NOW - 600_000,
          when: '2:31 PM',
          absolute: 'earlier today',
          answerIndex: 0,
        },
      ];
      setLogMessages(payload.cards[0]);
      payload.cards[0].saidName = 'Said while working, 1 message, 1 reply';
      payload.cards[0].saidMix = '1 message, 1 reply';
      const note = (id: string, quote: string) => ({
        id,
        sessionId: card.sessionId,
        turnKey: card.key,
        part: 'answer:0',
        quote,
        note: 'about ' + quote,
        headline: '',
        sessionTitle: '',
        turnAt: NOW - 600_000,
        at: NOW,
      });
      payload.comments = [note('n1', above), note('n2', below)];
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);
      await page.evaluate(`document.querySelector('#list .turn .head').click()`);
      await page.evaluate(SETTLED);

      const read = `(() => {
      const text = document.querySelector('#list .turn .activitysec .saidtext');
      if (!text) return null;
      const box = text.getBoundingClientRect();
      const cut = box.bottom;
      return {
        bounded: text.scrollHeight > text.clientHeight + 2,
        // Where the block clips, where its text starts, and where the panel ends.
        clip: box.left,
        wrapper: text.parentElement.getBoundingClientRect().left,
        firstLine: text.querySelector('p').getBoundingClientRect().left,
        panel: document.getElementById('list').getBoundingClientRect().left,
        // The bound itself, against what the stylesheet asks for.
        drawn: text.clientHeight,
        cap: parseFloat(getComputedStyle(text).maxHeight),
        marks: [...text.querySelectorAll('.linemark')].map((mark) => ({
          under: mark.getBoundingClientRect().top >= cut,
          left: mark.getBoundingClientRect().left,
          right: mark.getBoundingClientRect().right,
          stop: mark.getAttribute('tabindex'),
        })),
      };
    })()`;
      const seen = (await page.evaluate(read)) as null | Measured;
      assert.deepEqual(failures, [], 'the panel threw while drawing a commented message');
      assert.ok(seen, 'the open card drew no mid-turn message');
      assert.equal(seen.bounded, true, 'the fixture no longer clips, so this measures nothing');
      assert.equal(
        seen.marks.length,
        2,
        'the two comments left on the answer did not both reach it, so this measures nothing',
      );
      assert.deepEqual(
        seen.marks.map((m) => m.under),
        [false, true],
        'the fixture no longer puts one mark above the cut and one below it',
      );
      assert.deepEqual(
        seen.marks.map((m) => m.stop),
        [null, '-1'],
        'the tab key reaches a comment mark under the cut before it reaches the control that would show it',
      );

      // The clipped block reserves a left gutter so the visible comment mark remains inside both the block and panel.

      assert.ok(
        seen.marks[0].left >= seen.clip - 1,
        `the mark is drawn ${Math.round(seen.clip - seen.marks[0].left)}px outside the block that clips it`,
      );
      assert.ok(
        seen.marks[0].left >= seen.panel - 1,
        `the mark is drawn ${Math.round(seen.panel - seen.marks[0].left)}px off the left of the panel`,
      );
      // The mark must stay in its gutter without overlapping message text.

      assert.ok(seen.marks[0].right <= seen.wrapper + 1, 'the mark is drawn over the message it is about');
      // Gutter space must preserve the message text position.
      assert.ok(
        Math.abs(seen.firstLine - seen.wrapper) <= 1,
        `the message moved ${Math.round(seen.firstLine - seen.wrapper)}px sideways to make room for the mark`,
      );
      // Horizontal gutter space must preserve the vertical message bound.

      assert.ok(
        Math.abs(seen.drawn - seen.cap) <= 1,
        `the bound draws ${seen.drawn}px where the stylesheet asks for ${seen.cap}px`,
      );

      // Resend comments without changing the card. The replaced mark below the cut must remain outside the tab order.

      await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'notes', comments: payload.comments })}, '*')`);
      await page.evaluate(SETTLED);
      const rewritten = (await page.evaluate(read)) as Measured;
      assert.deepEqual(failures, [], 'the panel threw while the marks were written again');
      assert.equal(rewritten.marks.length, 2, 'a mark was lost when the notes were written again');
      assert.deepEqual(
        rewritten.marks.map((m) => m.under),
        [false, true],
      );
      assert.deepEqual(
        rewritten.marks.map((m) => m.stop),
        [null, '-1'],
        'a mark made again under the cut came back into the tab order',
      );

      // Opening the whole message restores the comment marks to the tab order.
      await page.evaluate(`document.querySelector('#list .turn .activitysec .said button.more').click()`);
      await page.evaluate(SETTLED);
      const opened = (await page.evaluate(read)) as Measured;
      assert.equal(opened.bounded, false, 'the whole message is still not readable after the press');
      assert.deepEqual(
        opened.marks.map((m) => m.stop),
        [null, null],
        'a mark the reader has just been shown is still out of the tab order',
      );
      assert.deepEqual(failures, [], 'the panel threw while the bounded message was opened');
    } finally {
      await browser.close();
    }
  },
);

test('the files and the lines are one pill, and its words are drawn off the screen', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (e) => failures.push(String(e)));
    await page.setContent(pageHtml());
    await layoutAt(page, 1350);

    // Measure the visible file figure and its visually hidden screen-reader text.

    const seen = (await page.evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('#list .turn .chips'));
      const row = rows.find((r) => r.querySelector('.add'));
      if (!row) return { error: 'no card drew the two line figures at all' };
      const pills = Array.from(row.children);
      const carrying = pills.filter((p) => p.querySelector('.add') || p.querySelector('.del'));
      const pill = carrying[0];
      const said = pill.querySelector('.saidonly');
      const box = pill.getBoundingClientRect();
      const saidBox = said ? said.getBoundingClientRect() : null;
      return {
        carrying: carrying.length,
        drawn: pill.children[0] ? pill.children[0].textContent : '',
        hidden: pill.children[0] ? pill.children[0].getAttribute('aria-hidden') : null,
        said: said ? said.textContent : null,
        height: box.height,
        saidWidth: saidBox ? saidBox.width : null,
        saidHeight: saidBox ? saidBox.height : null,
      };
    })()`)) as {
      error?: string;
      carrying: number;
      drawn: string;
      hidden: string | null;
      said: string | null;
      height: number;
      saidWidth: number | null;
      saidHeight: number | null;
    };

    assert.deepEqual(failures, [], 'the panel threw while drawing the row of figures');
    assert.equal(seen.error, undefined, seen.error);
    assert.equal(seen.carrying, 1, 'the file count and the lines are two pills again');
    assert.equal(
      seen.drawn,
      '2 files +85 \u221212',
      'the pill draws the wrong figures, or draws them without the count that leads them',
    );
    assert.equal(seen.hidden, 'true', 'the drawn figures are announced, on top of the words that already say them');
    assert.equal(
      seen.said,
      '2 files, 85 lines added, 12 removed',
      'the words a screen reader is handed are gone, or they no longer say the same figures',
    );
    assert.ok(
      seen.saidWidth !== null && seen.saidWidth <= 2 && seen.saidHeight !== null && seen.saidHeight <= 2,
      `the words meant for a screen reader are drawn ${seen.saidWidth}px by ${seen.saidHeight}px on screen`,
    );
    assert.ok(
      seen.height < 40,
      `the pill is ${Math.round(seen.height)}px tall, so the words inside it wrapped it onto a second line`,
    );
  } finally {
    await browser.close();
  }
});

test('a card keeps its full-size figures above the response, expanded or collapsed', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (e) => failures.push(String(e)));
    await page.setContent(pageHtml());

    // Measure figures above the collapsed summary and expanded body.

    const ROWS = `(() => {
      const card = document.querySelector('#list .turn:not(.clive)');
      const responseHeading = card.querySelector(':scope > .body > .sec:first-child > .sectionheading, :scope > .body > .promptlead + .sec > .sectionheading');
      const seen = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return r.height > 0 ? { top: r.top, bottom: r.bottom } : null;
      };
      return {
        chips: seen(card.querySelector(':scope > .chips')),
        chipSizes: [...card.querySelectorAll(':scope > .chips > .statchip')].map((chip) => {
          const style = getComputedStyle(chip);
          const box = chip.getBoundingClientRect();
          return {
            fontSize: style.fontSize,
            lineHeight: style.lineHeight,
            paddingTop: style.paddingTop,
            paddingRight: style.paddingRight,
            paddingBottom: style.paddingBottom,
            paddingLeft: style.paddingLeft,
            height: box.height,
          };
        }),
        headline: seen(card.querySelector(':scope > .headline')),
        body: seen(card.querySelector(':scope > .body')),
        responseHeading: responseHeading ? {
          tag: responseHeading.tagName.toLowerCase(),
          text: responseHeading.textContent,
          width: responseHeading.getBoundingClientRect().width,
          height: responseHeading.getBoundingClientRect().height,
        } : null,
      };
    })()`;
    const pressCard = `(() => { document.querySelector('#list .turn:not(.clive) .head').click(); })()`;
    interface Rows {
      chips: { top: number; bottom: number } | null;
      chipSizes: {
        fontSize: string;
        lineHeight: string;
        paddingTop: string;
        paddingRight: string;
        paddingBottom: string;
        paddingLeft: string;
        height: number;
      }[];
      headline: { top: number; bottom: number } | null;
      body: { top: number; bottom: number } | null;
      responseHeading: { tag: string; text: string; width: number; height: number } | null;
    }

    for (const width of [1350, 340]) {
      await layoutAt(page, width);
      const shut = (await page.evaluate(ROWS)) as Rows;
      assert.deepEqual(failures, [], 'the panel threw while drawing a collapsed card');
      assert.ok(shut.chips, `a collapsed card drew no figures at ${width}px, so this measures nothing`);
      assert.ok(
        shut.chipSizes.length > 0,
        `a collapsed card drew no stat chips at ${width}px, so this measures nothing`,
      );
      assert.ok(shut.headline, `a collapsed card drew no response line at ${width}px, so this measures nothing`);
      assert.ok(
        shut.chips.bottom <= shut.headline.top,
        `the figures end ${Math.round(shut.chips.bottom)}px down and the response begins ` +
          `${Math.round(shut.headline.top)}px down on a collapsed card at ${width}px`,
      );

      await page.evaluate(pressCard);
      await page.evaluate(SETTLED);
      const open = (await page.evaluate(ROWS)) as Rows;
      assert.deepEqual(failures, [], 'the panel threw while the card was opened');
      assert.ok(open.chips, `an expanded card drew no figures at ${width}px, so this measures nothing`);
      assert.deepEqual(open.chipSizes, shut.chipSizes, `opening a card changes its stat chip size at ${width}px`);
      assert.ok(open.body, `the card did not open at ${width}px, so this measures nothing`);
      assert.ok(
        open.chips.bottom <= open.body.top,
        `the figures end ${Math.round(open.chips.bottom)}px down and the response begins ` +
          `${Math.round(open.body.top)}px down on an expanded card at ${width}px`,
      );
      assert.deepEqual(
        open.responseHeading && {
          tag: open.responseHeading.tag,
          text: open.responseHeading.text,
        },
        { tag: 'h4', text: 'Response' },
        'the response lost the heading a screen reader uses to navigate the card',
      );
      assert.ok(
        open.responseHeading && open.responseHeading.width <= 2 && open.responseHeading.height <= 2,
        `the Response heading occupies ${open.responseHeading?.width}px by ${open.responseHeading?.height}px ` +
          `on screen at ${width}px`,
      );

      // Collapse the card before testing the next width.
      await page.evaluate(pressCard);
      await page.evaluate(SETTLED);
    }
    assert.deepEqual(failures, [], 'the panel threw while the card was opened and shut');
  } finally {
    await browser.close();
  }
});

test('a visualization reference draws a reachable action without widening the card', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  const visualization = path.resolve('fixtures', 'new-session-mockups.html');
  const marker = `\uE200visualize\uE202${JSON.stringify({ path: visualization })}\uE201`;
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(String(error)));
    await page.setContent(pageHtml());
    for (const width of [800, 340]) {
      await page.setViewportSize({ width, height: 900 });
      const payload = renderPayload() as { cards: Record<string, unknown>[] };
      payload.cards[0].summaryHtml = renderRichMarkdown(marker);
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);
      const button = page.locator('.summary button[data-visualization]').first();
      if (!(await button.isVisible())) {
        await page.locator('.turn').filter({ has: button }).locator('.head').click();
      }
      await button.waitFor({ state: 'visible' });
      assert.equal(await button.textContent(), 'Open interactive visualization: New session mockups');
      const bounds = await button.boundingBox();
      assert.ok(bounds, `the visualization action has no box at ${width}px`);
      assert.ok(
        bounds.x >= 0 && bounds.x + bounds.width <= width + 1,
        `the visualization action runs outside the ${width}px panel`,
      );
      await button.focus();
      assert.equal(
        await page.evaluate('document.activeElement?.dataset.visualization'),
        visualization,
        'the visualization action cannot be reached by keyboard',
      );
      await button.click();
      const posted = (await page.evaluate('window.__posted.at(-1)')) as { type?: string; path?: string };
      assert.deepEqual(posted, { type: 'openVisualization', path: visualization });
    }
    assert.deepEqual(failures, [], 'the panel threw while drawing or pressing the visualization action');
  } finally {
    await browser.close();
  }
});

test('a picture in a response is drawn inside the card and opens on a press', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  const folder = path.resolve('fixtures');
  const shot = path.join(folder, 'shot.png');
  const markdownShot = shot.replace(/\\/g, '/');
  // Use the production image-path check with a browser-loadable image instead of a webview resource URI.

  const drawImages = (target: string) => {
    const found = imageFileFor(target, [folder]);
    return found ? { src: TALL_PICTURE, path: found } : null;
  };
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(String(error)));
    await page.setContent(pageHtml());
    for (const width of [800, 340]) {
      await page.setViewportSize({ width, height: 900 });
      const payload = renderPayload() as { cards: Record<string, unknown>[] };
      payload.cards[0].summaryHtml = renderRichMarkdown(`![Closed prototype](${markdownShot})`, drawImages);
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);
      const button = page.locator('.summary button[data-image]').first();
      if (!(await button.isVisible())) {
        await page.locator('.turn').filter({ has: button }).locator('.head').click();
      }
      await button.waitFor({ state: 'visible' });
      // Use the first matching image for both the load check and geometry measurement.

      const PICTURE = '.summary button[data-image] img';
      const picture = page.locator(PICTURE).first();
      await picture.waitFor({ state: 'visible' });
      assert.equal(
        await page.evaluate(`document.querySelector('${PICTURE}').naturalHeight`),
        2000,
        `the picture never loaded at ${width}px, so nothing below was measured`,
      );

      const box = await picture.boundingBox();
      assert.ok(box, `the picture has no box at ${width}px`);
      assert.ok(
        box.height <= 420,
        `a 2000px picture is drawn ${Math.round(box.height)}px tall at ${width}px, ` +
          'so one screenshot pushes the rest of the card off the screen',
      );
      assert.ok(box.x >= 0 && box.x + box.width <= width + 1, `the picture runs outside the ${width}px panel`);
      assert.ok(
        Math.abs(box.width / box.height - 400 / 2000) < 0.02,
        `the picture is drawn ${Math.round(box.width)}x${Math.round(box.height)} at ${width}px, ` +
          'which is not the shape it was saved in',
      );

      await button.focus();
      assert.equal(
        await page.evaluate('document.activeElement?.dataset.image'),
        shot,
        'the picture cannot be reached by keyboard',
      );
      assert.equal(
        await button.getAttribute('aria-label'),
        'Open image: Closed prototype',
        'the picture does not say what its press does',
      );
      await button.click();
      const posted = (await page.evaluate('window.__posted.at(-1)')) as Record<string, unknown>;
      assert.deepEqual(posted, { type: 'openImage', path: shot, beside: false });
    }
    assert.deepEqual(failures, [], 'the panel threw while drawing or pressing the picture');
  } finally {
    await browser.close();
  }
});
