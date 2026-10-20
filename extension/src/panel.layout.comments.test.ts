// Browser checks for comment marks, quote highlights, and editing.
// Shared measurement helpers live in `../test/layout.ts`.

import { test } from 'vitest';
import assert from 'node:assert';
import { browserOrNone, SETTLED } from '../test/browser.ts';
import { RAIL_MIN_WIDTH } from './turnview.ts';
import { renderRichMarkdown } from './richtext.ts';
import { composerView, pickMenu } from './composerview.ts';
import {
  COMPOSER,
  FIXTURE_CLOCK,
  LONG_TURN_INDEX,
  MCP_SERVERS,
  NOW,
  pageHtml,
  renderPayload,
  themed,
} from './panelfixture.ts';
import {
  layoutAt,
  setLogMessages,
  COMMENTABLE_RESPONSE,
  COMMENTABLE_ANSWER,
  COMMENT_SHAPES,
  commentLands,
  slashMenu,
  clearBox,
  OUTER,
  INNER,
  WIDE,
  MIDDLE,
  LATE,
  SECOND_LINE,
  ROW,
  TINTED_RESPONSE,
  flatWords,
  tintedCard,
  TINT,
  Tinted,
  SELECT_SECOND_LINE,
  BOX_OPEN,
  PICKER_ROW,
  Placed,
  PickerRow,
  OPEN_SERVERS,
  MENU_BOX,
  MenuBox,
} from '../test/layout.ts';

test(
  'disclosure selection handoff retains structure and heading comments survive closing and refresh',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no browser installed');
      return;
    }
    try {
      const page = await browser.newPage();
      await page.setContent(themed(pageHtml()));
      const payload = renderPayload() as { cards: Record<string, any>[]; comments: unknown[] };
      const card = payload.cards[0];
      payload.cards = [card];
      const source =
        '<details><summary>Agent measurements</summary>\n\n- First\n- Second\n\n```text\nexact code\n```\n\n| Agent | Result |\n| --- | --- |\n| Sol | Passed |\n</details>';
      card.summaryHtml = renderRichMarkdown(source);
      await page.evaluate((value) => window.postMessage(value, '*'), payload);
      await page.locator('.turn .head').click();
      await page.locator('.turn .summary summary').click();
      await page.evaluate(() => {
        const content = document.querySelector('.turn .summary')!;
        const range = document.createRange();
        range.selectNodeContents(content);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        content.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      });
      await page.evaluate(
        (key) => window.postMessage({ type: 'sendSelectedText', key, copyLabels: false }, '*'),
        card.key,
      );
      await page.waitForFunction(() => (window as any).__posted.some((m: any) => m.type === 'selectedTextHandoff'));
      const handed = await page.evaluate(
        () => (window as any).__posted.find((m: any) => m.type === 'selectedTextHandoff').text,
      );
      assert.match(handed, /<details>\n<summary>Agent measurements<\/summary>/);
      assert.match(handed, /- First\n- Second/);
      assert.match(handed, /```\nexact code\n```/);
      assert.match(handed, /\| Agent \| Result \|\n\| --- \| --- \|/);
      await page.evaluate(() => {
        const heading = document.querySelector('.turn .summary summary')!;
        const range = document.createRange();
        range.selectNodeContents(heading);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        heading.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      });
      await page.evaluate((key) => window.postMessage({ type: 'openComment', key }, '*'), card.key);
      await page.locator('.notearea').fill('Check the measurements.');
      await page.locator('.notesave').click();
      await page.waitForFunction(() => !!document.querySelector('.turn .summary summary .linemark'));
      const note = await page.evaluate(
        () => (window as any).__posted.filter((m: any) => m.type === 'note').at(-1).note.note,
      );
      assert.equal(note.quote, 'Agent measurements');
      assert.equal(typeof note.offset, 'number');
      await page.locator('.turn .summary summary').click();
      await page.waitForFunction(() => !document.querySelector<HTMLDetailsElement>('.turn .summary details')?.open);
      payload.comments = [note];
      card.summaryHtml = renderRichMarkdown(source.replace('Passed', 'Updated'));
      await page.evaluate((value) => window.postMessage(value, '*'), payload);
      await page.waitForFunction(() => !!document.querySelector('.turn .summary summary .linemark'));
      assert.equal(
        await page.locator('.turn .summary details').evaluate((node: HTMLDetailsElement) => node.open),
        false,
      );
      assert.equal(await page.locator('.turn .summary summary .cmark').textContent(), 'Agent measurements');
    } finally {
      await browser.close();
    }
  },
);

test(
  'the command menu opens over the box, stays on the panel, and completes what is highlighted',
  { timeout: 120_000 },
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
      await page.setContent(pageHtml());

      // Test sidebar width first, where the completion menu has less room.

      for (const width of [340, 1350]) {
        await layoutAt(page, width);
        await clearBox(page);

        const open = await slashMenu(page, ['/']);
        assert.deepEqual(failures, [], 'the panel threw while drawing the menu');
        assert.equal(open.hidden, false, `at ${width}px a slash opened no menu at all`);
        assert.equal(open.expanded, 'true', 'the box does not say a list has opened under it');
        assert.ok(open.rows.length > 0, 'the menu drew no rows');
        assert.equal(open.on, open.rows[0], 'nothing is highlighted, so Enter would complete nothing');
        assert.equal(open.active, 'slashrow0', 'the box points at no row, so nothing is read out as the list moves');

        // Keep the entire completion menu inside the panel.

        const menu = open.menu;
        assert.ok(menu, 'the menu is open and has no box');
        assert.ok(
          menu.top >= 0 && menu.bottom <= open.viewportHeight + 1,
          `at ${width}px the menu runs from ${Math.round(menu.top)} to ${Math.round(menu.bottom)} ` +
            `in a panel ${open.viewportHeight} tall, so part of it is off the panel`,
        );
        assert.ok(
          menu.left >= 0 && menu.right <= open.viewportWidth + 1,
          `at ${width}px the menu runs off a side edge`,
        );
        // Place the completion menu above the prompt text field without covering typed text.

        assert.ok(
          menu.bottom <= open.promptTop + 1,
          `at ${width}px the menu runs to ${Math.round(menu.bottom)} over a box starting at ` +
            `${Math.round(open.promptTop)}, so it covers what the reader is typing`,
        );
        assert.ok(
          open.documentWidth <= open.viewportWidth + 1,
          `at ${width}px the menu widened the page, so the panel scrolls sideways`,
        );
        // Each completion row fits its name and one description line.

        for (const height of open.rowHeights) {
          assert.ok(
            height < 64,
            `at ${width}px a row is ${Math.round(height)}px tall, so the sentence is not held to a line`,
          );
        }

        // An unchanged render must preserve the scroll position in a long completion menu.

        const beforeRefresh = (await page.evaluate(`(() => {
        const pop = document.getElementById('slashpop');
        pop.scrollTop = pop.scrollHeight;
        return pop.scrollTop;
      })()`)) as number;
        assert.ok(beforeRefresh > 0, 'the command menu does not scroll, so the refresh check measures nothing');
        await page.evaluate(`window.postMessage(${JSON.stringify(renderPayload())}, '*')`);
        await page.evaluate(SETTLED);
        const afterRefresh = (await page.evaluate(`document.getElementById('slashpop').scrollTop`)) as number;
        assert.equal(
          afterRefresh,
          beforeRefresh,
          `at ${width}px a background render moved the command menu back to its active first row`,
        );

        // An unrelated usage change preserves menu position. A changed command catalog reveals the active row.

        const updatedBar = renderPayload() as { usage: { bar: { name: string } } };
        updatedBar.usage.bar.name += ' updated';
        await page.evaluate(`window.postMessage(${JSON.stringify(updatedBar)}, '*')`);
        await page.evaluate(SETTLED);
        assert.equal(
          await page.evaluate(`document.getElementById('slashpop').scrollTop`),
          beforeRefresh,
          `at ${width}px an unrelated footer change moved the command menu`,
        );

        const updatedCommands = renderPayload() as { usage: { composer: { commands: unknown[] } } };
        updatedCommands.usage.composer.commands = updatedCommands.usage.composer.commands.slice(1);
        await page.evaluate(`window.postMessage(${JSON.stringify(updatedCommands)}, '*')`);
        await page.evaluate(SETTLED);
        const changedActiveVisible = await page.evaluate(`(() => {
        const pop = document.getElementById('slashpop');
        const on = pop.querySelector('.slashrow.on');
        const menu = pop.getBoundingClientRect();
        const active = on.getBoundingClientRect();
        return active.top >= menu.top && active.bottom <= menu.bottom;
      })()`);
        assert.equal(
          changedActiveVisible,
          true,
          `at ${width}px a changed command list left its new active row outside the menu`,
        );
        await page.evaluate(`window.postMessage(${JSON.stringify(renderPayload())}, '*')`);
        await page.evaluate(SETTLED);

        // Prefix matches precede commands that only contain the typed text.

        const typed = await slashMenu(page, ['c', 'o']);
        assert.equal(typed.value, '/co');
        // Prefix matches retain the catalog order.

        assert.deepEqual(typed.rows.slice(0, 3), ['/compact', '/commit', '/code-review']);

        // Arrow keys wrap the active row and update the field accessibility state.
        const down = await slashMenu(page, ['ArrowDown']);
        assert.equal(down.on, '/commit');
        assert.equal(down.active, 'slashrow1');
        const up = await slashMenu(page, ['ArrowUp', 'ArrowUp']);
        assert.equal(up.on, typed.rows[typed.rows.length - 1], 'the highlight does not wrap round the end');

        // Escape closes completion without changing typed text.
        const shut = await slashMenu(page, ['Escape']);
        assert.equal(shut.hidden, true, 'Escape left the menu standing');
        assert.equal(shut.value, '/co', 'Escape took the reader own words with it');
        assert.equal(shut.expanded, 'false');

        // Enter completes the active command and adds its ending space. A later Enter sends the prompt.

        await clearBox(page);
        const done = await slashMenu(page, ['/', 'c', 'o', 'ArrowDown', 'Enter']);
        assert.equal(done.value, '/commit ', 'Enter completed something other than the highlighted row');
        assert.equal(done.hidden, true, 'the completed name left the menu open, so the next Enter completes again');
        assert.ok(
          done.posted.some((m) => m.text === '/commit '),
          'the completion never reached the extension, so the draft it holds is still the half name',
        );
        assert.ok(
          !done.posted.some((m) => m.type === 'sendPrompt'),
          'the Enter that completed the name sent the prompt as well',
        );

        // Tab also completes the active command without sending the prompt.

        await clearBox(page);
        const tabbed = await slashMenu(page, ['/', 'c', 'o', 'ArrowDown', 'Tab']);
        assert.equal(tabbed.value, '/commit ', 'Tab did not take the highlighted row');
        assert.equal(tabbed.hidden, true, 'Tab completed the name and left the menu open');
        assert.ok(!tabbed.posted.some((m) => m.type === 'sendPrompt'), 'Tab sent the prompt as well');

        // A row press completes that command.
        await clearBox(page);
        const pressed = await slashMenu(page, ['/', 'c', 'o', 'ArrowDown', 'ArrowDown', 'Press']);
        assert.equal(pressed.value, '/code-review ', 'a press on a row completed something else');

        // The next Enter sends after the ending space closes completion.
        const sent = await slashMenu(page, ['Enter']);
        assert.ok(
          sent.posted.some((m) => m.type === 'sendPrompt'),
          'the completed command could not be sent, so the menu is standing over a name it will complete for ever',
        );

        // Sending a prompt clears completion dismissal so a slash in the next prompt can reopen the menu.

        await clearBox(page);
        const reopened = await slashMenu(page, ['/', 'c', 'o', 'Escape', 'Enter', '/']);
        assert.equal(
          reopened.hidden,
          false,
          'a menu shut before the prompt went out is still shut over the prompt after it',
        );

        // Complete a command inside a sentence while preserving surrounding text and caret position.

        await clearBox(page);
        const mid = await slashMenu(page, ['t', 'a', 'k', 'e', ' ', 'a', ' ', 'l', 'o', 'o', 'k', ' ', '/', 'c', 'o']);
        assert.equal(mid.value, 'take a look /co');
        assert.equal(mid.hidden, false, 'a slash in the middle of a sentence opened no menu');
        assert.deepEqual(mid.rows.slice(0, 2), ['/compact', '/commit']);
        const midDone = await slashMenu(page, ['Enter']);
        assert.equal(
          midDone.value,
          'take a look /compact ',
          'completing mid-sentence took the words in front of the command with it',
        );
        assert.equal(
          midDone.caret,
          'take a look /compact '.length,
          'the caret did not land after the name it just completed',
        );

        // Completion must preserve trailing words without doubling the existing space.

        await clearBox(page);
        const around = await slashMenu(page, ['a', ' ', 'b', 'Caret:1', ' ', '/', 'c', 'o', 'm', 'm']);
        assert.equal(around.value, 'a /comm b');
        assert.equal(around.hidden, false, 'the run under the caret offered nothing');
        const spliced = await slashMenu(page, ['Tab']);
        assert.equal(spliced.value, 'a /commit b', 'the words after the command were eaten, or a space was doubled');
        assert.equal(spliced.caret, 'a /commit '.length, 'the caret did not land inside the sentence');

        // Moving the caret back into a command reopens completion for the whole token.

        const back = await slashMenu(page, ['Caret:5']);
        assert.equal(back.hidden, false, 'the caret went back into a command and the menu stayed shut');
        assert.deepEqual(back.rows.slice(0, 1), ['/commit'], 'the run was cut at the caret rather than taken whole');

        // An unmatched command closes completion. A slash inside a word does not open command completion.

        await clearBox(page);
        const nothing = await slashMenu(page, ['/', 'z', 'z', 'z']);
        assert.equal(nothing.hidden, true, 'a query that matched nothing left an empty menu over the box');
        await clearBox(page);
        const path = await slashMenu(page, ['s', 'r', 'c', '/', 'c']);
        assert.equal(path.hidden, true, 'a slash inside a word opened the command menu');
        await clearBox(page);
      }
      assert.deepEqual(failures, [], 'the panel threw while the menu was driven');
    } finally {
      await browser.close();
    }
  },
);

test('a path completion list stays inside a narrow panel with a long name', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 340, height: 900 });
    await page.setContent(pageHtml());
    await page.evaluate(`window.postMessage(${JSON.stringify(renderPayload())}, '*')`);
    await page.evaluate(SETTLED);
    const prompt = page.locator('#prompt');
    await prompt.fill('~/Projects/wo');
    await page.waitForFunction(() =>
      (window as unknown as { __posted: { type: string }[] }).__posted.some(
        (message) => message.type === 'pathCompletion',
      ),
    );
    const request = (await page.evaluate(
      `window.__posted.filter((message) => message.type === 'pathCompletion').at(-1)`,
    )) as { session: string; request: number; token: string; caret: number };
    const name = 'work-'.repeat(40);
    const result = {
      type: 'pathCompletion',
      ...request,
      rows: [
        {
          name,
          directory: true,
          label: `${name}/`,
          accessibleName: `Directory ${name}/`,
          completion: `~/Projects/${name}/`,
        },
      ],
    };
    await page.evaluate(`window.postMessage(${JSON.stringify(result)}, '*')`);
    await page.evaluate(SETTLED);
    const measured = (await page.evaluate(`(() => {
      const menu = document.getElementById('slashpop');
      const box = menu.getBoundingClientRect();
      return {
        hidden: menu.hidden, left: box.left, right: box.right, top: box.top, bottom: box.bottom,
        viewportWidth: innerWidth, viewportHeight: innerHeight, documentWidth: document.documentElement.scrollWidth,
      };
    })()`)) as {
      hidden: boolean;
      left: number;
      right: number;
      top: number;
      bottom: number;
      viewportWidth: number;
      viewportHeight: number;
      documentWidth: number;
    };
    assert.equal(measured.hidden, false, 'the path result drew no completion list');
    assert.ok(
      measured.left >= 0 && measured.right <= measured.viewportWidth + 1,
      `the path list runs from ${Math.round(measured.left)} to ${Math.round(measured.right)} in a ${measured.viewportWidth}px panel`,
    );
    assert.ok(
      measured.top >= 0 && measured.bottom <= measured.viewportHeight + 1,
      `the path list runs from ${Math.round(measured.top)} to ${Math.round(measured.bottom)} in a ${measured.viewportHeight}px panel`,
    );
    assert.ok(
      measured.documentWidth <= measured.viewportWidth + 1,
      `the ${measured.documentWidth}px document scrolls sideways in a ${measured.viewportWidth}px panel`,
    );
  } finally {
    await browser.close();
  }
});

test('a comment lands on the line it was left on, in every part of a card', { timeout: 120_000 }, async (t) => {
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
    payload.cards[0].summaryHtml = COMMENTABLE_RESPONSE;
    // Later prompts share the prompt class with the opening prompt. The part identifier must distinguish them.

    payload.cards[0].laterPrompts = [
      {
        text: 'Also check the lexer while you are in there.',
        when: '1:05 PM',
        absolute: 'today at 1:05 PM',
        label: 'Asked while this was running',
      },
      {
        text: 'And leave the scanner tests alone please.',
        when: '1:12 PM',
        absolute: 'today at 1:12 PM',
        label: 'Asked while this was running',
      },
    ];
    // Earlier-answer comments use the newest-first answer index. The Activity log draws those answers.

    payload.cards[0].earlierAnswers = [
      {
        summary: 'the panel draws the html, not this',
        summaryHtml: COMMENTABLE_ANSWER,
        at: NOW - 600_000,
        absolute: 'earlier today',
      },
    ];
    payload.cards[0].saidMessages = [
      {
        id: 'answer:1:0',
        kind: 'answer',
        text: 'the panel draws the html, not this',
        summaryHtml: COMMENTABLE_ANSWER,
        at: NOW - 600_000,
        when: '2:31 PM',
        absolute: 'earlier today',
        answerIndex: 0,
      },
    ];
    setLogMessages(payload.cards[0]);
    payload.cards[0].saidName = 'Said while working, 1 message, 1 reply';
    payload.cards[0].saidMix = '1 message, 1 reply';
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.waitForFunction(() => document.querySelector('.turn .head') !== null);
    await page.evaluate(`document.querySelector('.turn .head').click()`);
    await page.waitForFunction(() => {
      const body = document.querySelector('.turn .body');
      return body !== null && !(body as HTMLElement).hidden;
    });
    // Open later prompts before selecting one for a comment.

    await page.evaluate(`document.querySelector('.turn [data-control^="asks:"]').click()`);
    await page.evaluate(SETTLED);

    for (const spec of COMMENT_SHAPES) {
      const landed = await commentLands(page, spec);
      assert.equal(
        landed,
        'onLine',
        `a comment left on ${spec.where} by a ${spec.mode} selection came back as ${landed}, ` +
          'so the panel says it is about no line the reader can see',
      );
    }
    assert.deepEqual(failures, [], 'the panel threw while a comment was being written');

    // The editor name and quote must remain accessible while visually hidden. Display none would remove them from the accessibility tree.

    const said = (await page.evaluate(`(async () => {
      // Opened here, because every box above was saved and shut behind it.
      const target = document.querySelector('.turn .summary p');
      const range = document.createRange();
      range.selectNodeContents(target);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      await ${SETTLED};
      document.querySelector('.quotebar').children[0].click();
      await ${SETTLED};
      const box = document.querySelector('.quoteslot .noteedit');
      if (!box) return { error: 'no box open to measure' };
      const seen = (sel) => {
        const node = box.querySelector(sel);
        if (!node) return 'missing';
        const style = getComputedStyle(node);
        return style.display === 'none' || style.visibility === 'hidden' ? 'gone' : 'read';
      };
      return { label: seen('.notelabel'), quote: seen('.notesaid') };
    })()`)) as { error?: string; label?: string; quote?: string };
    assert.equal(said.error, undefined, said.error || '');
    assert.equal(
      said.label,
      'read',
      'the box label is display none, so the text box is announced as edit text and names nothing',
    );
    assert.equal(
      said.quote,
      'read',
      'the line the comment is about is display none, so nothing tells a reader what it is on',
    );

    // After all comment updates, matched comments must remain on their lines rather than collect in the unmatched-comment row.

    const stranded = (await page.evaluate(`(() => {
      const off = document.querySelector('.offlinemark');
      return off ? off.textContent : '';
    })()`)) as string;
    assert.equal(
      stranded,
      '',
      `the card ends with "${stranded}" at the top of it, so comments the reader left on lines ` +
        'are drawn as being about nothing',
    );
  } finally {
    await browser.close();
  }
});

test('the bar waits for the reader to let go before it offers anything', { timeout: 60_000 }, async (t) => {
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
    payload.cards[0].summaryHtml = COMMENTABLE_RESPONSE;
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.waitForFunction(() => document.querySelector('.turn .head') !== null);
    await page.evaluate(`document.querySelector('.turn .head').click()`);
    await page.waitForFunction(() => {
      const body = document.querySelector('.turn .body');
      return body !== null && !(body as HTMLElement).hidden;
    });

    // Grow the selection while the pointer stays pressed. The selection action must wait until release.

    const seen = (await page.evaluate(`(async () => {
      const target = document.querySelector('.turn .summary p');
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      const range = document.createRange();
      range.selectNodeContents(target);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      await ${SETTLED};
      const during = document.querySelector('.quotefloat') && !document.querySelector('.quotefloat').hidden;
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      await ${SETTLED};
      const after = document.querySelector('.quotefloat') && !document.querySelector('.quotefloat').hidden;
      return { during: during, after: after };
    })()`)) as { during: boolean; after: boolean };

    assert.equal(
      seen.during,
      false,
      'the bar is drawn while the button is still down, so it moves under the pointer as the reader drags',
    );
    assert.equal(
      seen.after,
      true,
      'the bar never appears once the reader lets go, so a finished selection is offered nothing',
    );
    assert.deepEqual(failures, [], 'the panel threw while the selection was being made');
  } finally {
    await browser.close();
  }
});

test('a comment on a prompt the reader sent twice marks the one they were in', { timeout: 60_000 }, async (t) => {
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

    // Repeat the same prompt text in two parts. Quote matching alone cannot distinguish them, so the saved part must select the correct prompt.

    const SAID = 'Fix the scanner loop before anything else.';
    const payload = renderPayload() as { cards: Record<string, unknown>[] };
    payload.cards[0].prompt = SAID;
    payload.cards[0].summaryHtml = '<p>The tokenizer now walks a table.</p>';
    payload.cards[0].laterPrompts = [
      { text: SAID, when: '1:05 PM', absolute: 'today at 1:05 PM', label: 'Asked while this was running' },
    ];
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.waitForFunction(() => document.querySelector('.turn .head') !== null);
    await page.evaluate(`document.querySelector('.turn .head').click()`);
    await page.waitForFunction(() => {
      const body = document.querySelector('.turn .body');
      return body !== null && !(body as HTMLElement).hidden;
    });
    // Open later prompts before selecting the repeated ask.

    await page.evaluate(`document.querySelector('.turn [data-control^="asks:"]').click()`);
    await page.evaluate(SETTLED);

    const out = (await page.evaluate(`(async () => {
      const card = document.querySelector('.turn');
      const asked = card.querySelectorAll('.prompt');
      if (asked.length < 2) return { error: 'the card drew ' + asked.length + ' prompts, so nothing was repeated' };
      const target = asked[1];
      const range = document.createRange();
      range.selectNodeContents(target);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      await ${SETTLED};
      const word = document.querySelector('.quotebar').children[0];
      word.click();
      await ${SETTLED};
      const area = document.querySelector('.quoteslot .notearea');
      if (!area) return { error: 'pressing Comment opened no box' };
      area.value = 'this is the one I meant';
      document.querySelector('.quoteslot .notesave').click();
      await ${SETTLED};
      const again = card.querySelectorAll('.prompt');
      const marks = [];
      for (let i = 0; i < again.length; i++) {
        if (again[i].querySelector('.linemark')) marks.push(i);
      }
      const posted = window.__posted.filter((m) => m.type === 'note');
      const sent = posted.length ? posted[posted.length - 1].note : null;
      const note = sent && sent.note ? sent.note : sent;
      return { marks: marks, part: note ? String(note.part || '') : '' };
    })()`)) as { error?: string; marks?: number[]; part?: string };

    assert.equal(out.error, undefined, out.error || '');
    assert.deepEqual(
      out.marks,
      [1],
      `the mark landed on prompt block(s) ${JSON.stringify(out.marks)} when the reader commented on the second, ` +
        'so a repeated prompt takes the mark meant for the one below it',
    );
    assert.equal(
      out.part,
      'prompt:0',
      'the comment was filed under the wrong prompt, so it will move again on the next draw',
    );
    assert.deepEqual(failures, [], 'the panel threw while the comment was being written');
  } finally {
    await browser.close();
  }
});

// Saved comments must follow prompt placement and reveal folded later prompts containing their quotes.

test(
  'saved comments draw on their lines under the default layout and under Two columns',
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
      await page.setContent(pageHtml());
      await layoutAt(page, 1350);
      const ASKED = 'Fix the scanner loop before anything else.';
      const LATER = 'Also check the lexer while you are in there.';
      const ANSWER = 'The tokenizer now walks a table.';
      const payload = renderPayload() as { cards: Record<string, unknown>[] };
      const card = payload.cards[0];
      card.prompt = ASKED;
      card.summaryHtml = `<p>${ANSWER}</p>`;
      card.laterPrompts = [
        { text: LATER, when: '1:05 PM', absolute: 'today at 1:05 PM', label: 'Asked while this was running' },
      ];
      // Add file rows so Two columns draws a record column.
      card.files = payload.cards[LONG_TURN_INDEX].files;
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);
      await page.evaluate(`document.querySelector('.turn .head').click()`);
      await page.evaluate(SETTLED);
      const key = String(card.key);
      const session = key.split(':')[0];
      const note = (id: string, part: string, quote: string) => ({
        id,
        sessionId: session,
        turnKey: key,
        part,
        quote,
        note: id,
        headline: '',
        sessionTitle: '',
        turnAt: 1,
        at: 1,
      });
      const comments = [
        note('on-answer', 'summary', ANSWER),
        note('on-prompt', 'prompt', ASKED),
        note('on-ask', 'prompt:0', LATER),
      ];
      await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'notes', comments })}, '*')`);
      await page.evaluate(SETTLED);
      for (const [cardLayout, promptPosition] of [
        ['compact', 'above'],
        ['two-columns', 'above'],
        ['two-columns', 'below'],
      ]) {
        // Include saved comments in each layout render.
        Object.assign(payload, { timelineLayout: { cardLayout, promptPosition }, comments });
        await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
        await page.evaluate(SETTLED);
        const seen = await page
          .locator('.turn')
          .first()
          .evaluate((node) => ({
            prompts: Array.from(node.querySelectorAll('.prompt')).map((block) => [
              (block.textContent || '').trim().slice(0, 12),
              block.querySelectorAll('.linemark').length,
              (block as HTMLElement).offsetParent !== null,
            ]),
            answer: node.querySelectorAll('.summary p .linemark').length,
            offline: node.querySelectorAll('.offlinemark').length,
            columns: node.querySelector('.cardcolsgrid')
              ? getComputedStyle(node.querySelector('.cardcolsgrid') as Element).display
              : '',
          }));
        const where = `Card layout ${cardLayout}, Prompt position ${promptPosition}`;
        assert.deepEqual(
          seen.prompts,
          [
            [ASKED.slice(0, 12), 1, true],
            [LATER.slice(0, 12), 1, true],
          ],
          `the prompt comments did not draw on their visible lines under ${where}: ${JSON.stringify(seen)}`,
        );
        assert.equal(seen.answer, 1, `the response comment did not draw on its line under ${where}`);
        assert.equal(seen.offline, 0, `a comment fell to the top of the card under ${where}`);
        assert.equal(
          seen.columns,
          cardLayout === 'two-columns' ? 'grid' : '',
          `the card did not draw ${cardLayout} under ${where}`,
        );
      }
      assert.deepEqual(failures, [], 'the panel threw while drawing saved comments');
    } finally {
      await browser.close();
    }
  },
);

// With no opening prompt, the first later ask uses the prompt part. A summary comment on You asked follows the input that heading names.

test(
  'a saved comment on a first ask or on the You asked heading draws on a line under the default layout',
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
      await page.setContent(pageHtml());
      await layoutAt(page, 1350);
      const ASKED = 'Fix the scanner loop before anything else.';
      const LATER = 'Also check the lexer while you are in there.';
      const payload = renderPayload() as { cards: Record<string, unknown>[] };
      const card = payload.cards[0];
      card.summaryHtml = '<p>The tokenizer now walks a table.</p>';
      const key = String(card.key);
      const note = (id: string, part: string, quote: string) => ({
        id,
        sessionId: key.split(':')[0],
        turnKey: key,
        part,
        quote,
        note: id,
        headline: '',
        sessionTitle: '',
        turnAt: 1,
        at: 1,
      });
      const draw = async (layout: string, comments: unknown[]) => {
        Object.assign(payload, { timelineLayout: { cardLayout: 'compact', promptPosition: layout }, comments });
        await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'notes', comments })}, '*')`);
        await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
        await page.evaluate(SETTLED);
        if ((await page.locator('.turn').first().locator('.body').getAttribute('hidden')) !== null) {
          await page.locator('.turn .head').first().click();
          await page.evaluate(SETTLED);
        }
        return page
          .locator('.turn')
          .first()
          .evaluate((node) => ({
            marked: Array.from(node.querySelectorAll('.prompt, .sectionheading'))
              .filter((block) => block.querySelector('.linemark') && (block as HTMLElement).offsetParent !== null)
              .map((block) => {
                const copy = block.cloneNode(true) as Element;
                copy.querySelectorAll('.linemark').forEach((mark) => mark.remove());
                return (copy.textContent || '').trim().slice(0, 12);
              }),
            offline: node.querySelectorAll('.offlinemark').length,
          }));
      };

      card.prompt = '';
      card.laterPrompts = [
        { text: LATER, when: '1:05 PM', absolute: 'today at 1:05 PM', label: 'Asked while this was running' },
      ];
      const onAsk = await draw('above', [note('on-first-ask', 'prompt', LATER)]);
      assert.deepEqual(
        [onAsk.marked, onAsk.offline],
        [[LATER.slice(0, 12)], 0],
        `a comment on the first ask of a card with no first prompt did not draw on that ask: ${JSON.stringify(onAsk)}`,
      );

      // With no opening prompt, a saved You asked comment reveals the first later ask.

      const headingNoPrompt = await draw('above', [note('on-heading-no-prompt', 'summary', 'You asked')]);
      assert.deepEqual(
        [headingNoPrompt.marked, headingNoPrompt.offline],
        [[LATER.slice(0, 12)], 0],
        `a comment on the You asked heading of a card with no first prompt did not draw on its first ask: ${JSON.stringify(headingNoPrompt)}`,
      );

      card.prompt = ASKED;
      card.laterPrompts = [];
      const heading = [note('on-heading', 'summary', 'You asked')];
      const after = await draw('below', heading);
      assert.deepEqual(
        [after.marked, after.offline],
        [['You asked'], 0],
        `the comment on the drawn You asked heading did not draw on it after the response: ${JSON.stringify(after)}`,
      );
      const before = await draw('above', heading);
      assert.deepEqual(
        [before.marked, before.offline],
        [[ASKED.slice(0, 12)], 0],
        `a comment on the You asked heading did not draw on the prompt under the default layout: ${JSON.stringify(before)}`,
      );

      // Store a reply comment under summary. Its quote also occurs in You asked, so reply matching must precede heading fallback.

      const REPLY = '<p>The scanner loop is fixed as you asked.</p>';
      card.earlierAnswers = [
        {
          summary: 'the panel draws the html, not this',
          summaryHtml: REPLY,
          at: NOW - 600_000,
          absolute: 'earlier today',
        },
      ];
      card.saidMessages = [
        {
          id: 'answer:1:0',
          kind: 'answer',
          text: 'the panel draws the html, not this',
          summaryHtml: REPLY,
          at: NOW - 600_000,
          when: '2:31 PM',
          absolute: 'earlier today',
          answerIndex: 0,
        },
      ];
      setLogMessages(card);
      await draw('above', [note('on-reply', 'summary', 'asked')]);
      const reply = await page
        .locator('.turn')
        .first()
        .evaluate((node) => ({
          answer: node.querySelectorAll('.answer .linemark').length,
          prompt: node.querySelectorAll('.prompt .linemark').length,
          offline: node.querySelectorAll('.offlinemark').length,
        }));
      assert.deepEqual(
        reply,
        { answer: 1, prompt: 0, offline: 0 },
        `a reply comment on a word of the You asked heading did not draw on the reply: ${JSON.stringify(reply)}`,
      );
      assert.deepEqual(failures, [], 'the panel threw while drawing saved comments');
    } finally {
      await browser.close();
    }
  },
);

// The fixture makes an earlier report the response and retains two newer replies. Each saved comment must follow its original part.

test(
  'saved comments on replies draw on their lines after the response moves to an earlier reply',
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
      await page.setContent(themed(pageHtml()));
      await layoutAt(page, 1350);
      const OLDER = 'The implementer is running in its own worktree.';
      const REPORT = 'The candidate commit passed its gate.';
      const FIRST_NOTE = 'The recorder numbers came in late.';
      const SECOND_NOTE = 'Nothing else changed since the report.';
      const payload = renderPayload() as { cards: Record<string, unknown>[] };
      const card = payload.cards[0];
      card.summaryHtml = `<p>${REPORT}</p>`;
      const replies = [
        [SECOND_NOTE, 60_000],
        [FIRST_NOTE, 120_000],
        [OLDER, 600_000],
      ] as const;
      card.earlierAnswers = replies.map(([text, ago]) => ({
        summary: text,
        summaryHtml: `<p>${text}</p>`,
        at: NOW - ago,
        absolute: 'earlier today',
      }));
      card.saidMessages = replies
        .map(([text, ago], index) => ({
          id: `answer:${index}:0`,
          kind: 'answer',
          text,
          summaryHtml: `<p>${text}</p>`,
          at: NOW - ago,
          when: '2:31 PM',
          absolute: 'earlier today',
          answerIndex: index,
        }))
        .reverse();
      setLogMessages(card);
      const key = String(card.key);
      const note = (id: string, part: string, quote: string) => ({
        id,
        sessionId: key.split(':')[0],
        turnKey: key,
        part,
        quote,
        note: id,
        headline: '',
        sessionTitle: '',
        turnAt: 1,
        at: 1,
      });
      const comments = [
        note('on-report', 'answer:1', REPORT),
        note('on-first-note', 'answer:0', FIRST_NOTE),
        note('on-second-note', 'summary', SECOND_NOTE),
        note('on-older', 'answer:2', OLDER),
      ];
      Object.assign(payload, { comments });
      await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'notes', comments })}, '*')`);
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);
      if ((await page.locator('.turn').first().locator('.body').getAttribute('hidden')) !== null) {
        await page.locator('.turn .head').first().click();
        await page.evaluate(SETTLED);
      }
      const seen = await page
        .locator('.turn')
        .first()
        .evaluate((node) => ({
          response: Array.from(node.querySelectorAll('.summary .linemark')).filter((mark) => !mark.closest('.answer'))
            .length,
          replies: Array.from(node.querySelectorAll('.answer'))
            .map((row) => {
              const copy = row.cloneNode(true) as Element;
              copy.querySelectorAll('.linemark').forEach((mark) => mark.remove());
              return [(copy.querySelector('p')?.textContent || '').trim(), row.querySelectorAll('.linemark').length];
            })
            .sort(),
          offline: node.querySelectorAll('.offlinemark').length,
        }));
      assert.deepEqual(
        seen,
        {
          response: 1,
          replies: [
            [FIRST_NOTE, 1],
            [SECOND_NOTE, 1],
            [OLDER, 1],
          ].sort(),
          offline: 0,
        },
        `a saved reply comment did not draw on the text it was left on: ${JSON.stringify(seen)}`,
      );
      assert.deepEqual(failures, [], 'the panel threw while drawing saved comments');
    } finally {
      await browser.close();
    }
  },
);

// The opening-input heading contributes no response offset. Repeated response text must resolve identically with prompts above or below.

test(
  'a stored response offset names the same line whether the prompt sits before or after the response',
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
      await page.setContent(pageHtml());
      await layoutAt(page, 1350);
      const SAME = 'Same words.';
      const payload = renderPayload() as { cards: Record<string, unknown>[] };
      const card = payload.cards[0];
      card.prompt = 'Fix the scanner loop before anything else.';
      card.summaryHtml = `<p>${SAME}</p><p>${SAME}</p>`;
      const key = String(card.key);
      // Count the card heading and Response title before the repeated lines. Place the offset four characters before the second line. Counting You asked would select the first line.

      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);
      const heading = await page
        .locator('.turn .cardheading')
        .first()
        .evaluate((node) => (node.textContent || '').replace(/\s+/g, ' ').trim().length + 1);
      const second = heading + 'Response'.length + 1 + SAME.length + 1;
      const comments = [
        {
          id: 'second-line',
          sessionId: key.split(':')[0],
          turnKey: key,
          part: 'summary',
          quote: SAME,
          offset: second - 4,
          note: 'the second one',
          headline: '',
          sessionTitle: '',
          turnAt: 1,
          at: 1,
        },
      ];
      await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'notes', comments })}, '*')`);
      for (const promptPosition of ['below', 'above']) {
        Object.assign(payload, { timelineLayout: { cardLayout: 'compact', promptPosition }, comments });
        await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
        await page.evaluate(SETTLED);
        if ((await page.locator('.turn').first().locator('.body').getAttribute('hidden')) !== null) {
          await page.locator('.turn .head').first().click();
          await page.evaluate(SETTLED);
        }
        const marks = await page
          .locator('.turn')
          .first()
          .evaluate((node) =>
            Array.from(node.querySelectorAll('.summary p')).map((line) => line.querySelectorAll('.linemark').length),
          );
        assert.deepEqual(
          marks,
          [0, 1],
          `with the prompt ${promptPosition} the response the comment drew on another line, so the You asked heading shifted its offset: ${JSON.stringify(marks)}`,
        );
      }
      assert.deepEqual(failures, [], 'the panel threw while drawing the comment');
    } finally {
      await browser.close();
    }
  },
);

test('comment surfaces paint above a sticky session heading', { timeout: 60_000 }, async (t) => {
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
    await tintedCard(page, [INNER]);

    const seen = (await page.evaluate(`(async () => {
      const heading = document.querySelector('.sessionrow');
      const overlap = (surface) => {
        if (!heading || !surface || surface.hidden) return { error: 'a surface or heading is missing' };
        const h = heading.getBoundingClientRect();
        surface.style.left = (h.left + 10) + 'px';
        surface.style.top = (h.top + 2) + 'px';
        const f = surface.getBoundingClientRect();
        const left = Math.max(h.left, f.left);
        const right = Math.min(h.right, f.right);
        const top = Math.max(h.top, f.top);
        const bottom = Math.min(h.bottom, f.bottom);
        if (right - left < 4 || bottom - top < 4) return { error: 'the surface does not overlap the heading' };
        const above = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
        return {
          painted: !!above && (above === surface || surface.contains(above)),
          above: above ? above.className : '',
        };
      };

      const mark = document.querySelector('.linemark');
      if (!mark) return { error: 'the saved comment drew no mark' };
      mark.click();
      await ${SETTLED};
      const comments = overlap(document.querySelector('.markfloat'));
      mark.click();

      const target = document.querySelectorAll('.turn .summary p')[1];
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      await ${SETTLED};
      document.querySelector('.quotebar').children[0].click();
      await ${SETTLED};
      const editor = overlap(document.querySelector('.quotefloat'));
      return { comments, editor };
    })()`)) as {
      error?: string;
      comments?: { error?: string; painted?: boolean; above?: string };
      editor?: { error?: string; painted?: boolean; above?: string };
    };
    assert.equal(seen.error, undefined, seen.error || '');
    assert.equal(seen.comments?.error, undefined, seen.comments?.error || '');
    assert.equal(seen.editor?.error, undefined, seen.editor?.error || '');
    assert.equal(
      seen.comments?.painted,
      true,
      `the session heading paints over the saved-comment popup as ${JSON.stringify(seen.comments?.above)}`,
    );
    assert.equal(
      seen.editor?.painted,
      true,
      `the session heading paints over the comment editor as ${JSON.stringify(seen.editor?.above)}`,
    );
    assert.deepEqual(failures, [], 'the panel threw while comment surfaces overlapped its heading');
  } finally {
    await browser.close();
  }
});

test('a comment editor stays between the sticky heading and the fixed composer', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (e) => failures.push(String(e)));
    await page.setViewportSize({ width: 900, height: 400 });
    await page.setContent(pageHtml());
    await page.evaluate(`window.postMessage(${JSON.stringify(renderPayload())}, '*')`);
    await page.evaluate(SETTLED);

    const seen = (await page.evaluate(`(async () => {
      const card = document.querySelector('.turn');
      if (!card) return { error: 'the page drew no card to place under a sticky heading' };
      const lead = document.createElement('div');
      lead.style.height = '700px';
      card.parentElement.insertBefore(lead, card);
      if (card.querySelector('.body').hidden) card.querySelector('.head').click();
      await ${SETTLED};
      const target = card.querySelector('.summary p');
      const controls = document.querySelector('.controls');
      const composer = document.getElementById('composer');
      if (!target || !controls || !composer || composer.hidden) {
        return { error: 'the target, sticky controls or fixed composer is missing' };
      }

      const controlsBox = controls.getBoundingClientRect();
      window.scrollBy(0, target.getBoundingClientRect().top - controlsBox.bottom - 180);
      await ${SETTLED};
      const headings = [...document.querySelectorAll('.sessionrow')]
        .filter((node) => {
          const box = node.getBoundingClientRect();
          return box.top <= controls.getBoundingClientRect().bottom + 2
            && box.bottom > controls.getBoundingClientRect().bottom;
        });
      const heading = headings[headings.length - 1];
      if (!heading) return { error: 'no session heading is stuck under the controls' };

      const range = document.createRange();
      range.selectNodeContents(target);
      const anchor = range.getBoundingClientRect();
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      await ${SETTLED};
      const word = document.querySelector('.quotebar')?.children[0];
      if (!word) return { error: 'the selection offered no comment action' };
      word.click();
      await ${SETTLED};
      const editor = document.querySelector('.quotefloat.commenting');
      if (!editor || editor.hidden) return { error: 'pressing Comment opened no editor' };
      const box = (node) => {
        const at = node.getBoundingClientRect();
        return { top: at.top, bottom: at.bottom, height: at.height };
      };
      const actions = [...editor.querySelectorAll('button')].map(box).filter((at) => at.height > 0);
      const editorBox = box(editor);
      const originalComposer = box(composer);

      // Make the existing composer occupy enough of the short panel that the clear strip is
      // shorter than the editor. The editor must then scroll inside that strip rather than run
      // under the higher-layer composer and take its actions out of reach.
      const headingBox = box(heading);
      const footBottom = originalComposer.bottom;
      const wantedTop = headingBox.bottom + editorBox.height - 24;
      composer.style.height = Math.max(0, footBottom - wantedTop) + 'px';
      window.dispatchEvent(new Event('resize'));
      await ${SETTLED};
      const tightEditor = document.querySelector('.quotefloat.commenting');
      if (!tightEditor || tightEditor.hidden) return { error: 'the tighter panel opened no editor' };
      const tightEditorBox = box(tightEditor);
      const tightClientHeight = tightEditor.clientHeight;
      const tightScrollHeight = tightEditor.scrollHeight;
      tightEditor.scrollTop = tightEditor.scrollHeight;
      const tightActions = [...tightEditor.querySelectorAll('.noteacts button')].map(box).filter((at) => at.height > 0);
      tightEditor.querySelector('.noteclose').click();
      return {
        anchor: { top: anchor.top, bottom: anchor.bottom },
        heading: headingBox,
        composer: originalComposer,
        editor: editorBox,
        actions,
        tight: {
          heading: box(heading), composer: box(composer), editor: tightEditorBox, actions: tightActions,
          clientHeight: tightClientHeight, scrollHeight: tightScrollHeight,
          releasedMaxHeight: tightEditor.style.maxHeight,
        },
      };
    })()`)) as {
      error?: string;
      anchor?: { top: number; bottom: number };
      heading?: { top: number; bottom: number; height: number };
      composer?: { top: number; bottom: number; height: number };
      editor?: { top: number; bottom: number; height: number };
      actions?: Array<{ top: number; bottom: number; height: number }>;
      tight?: {
        heading: { top: number; bottom: number; height: number };
        composer: { top: number; bottom: number; height: number };
        editor: { top: number; bottom: number; height: number };
        actions: Array<{ top: number; bottom: number; height: number }>;
        clientHeight: number;
        scrollHeight: number;
        releasedMaxHeight: string;
      };
    };
    assert.equal(seen.error, undefined, seen.error || '');
    assert.ok(
      seen.anchor && seen.heading && seen.composer && seen.editor,
      'the placement measurement returned no complete geometry',
    );
    assert.ok(
      seen.anchor.top - seen.heading.bottom < seen.editor.height + 6,
      'the fixture leaves enough room above the selection, so it does not exercise the collision',
    );
    assert.ok(
      seen.composer.top - seen.anchor.bottom < seen.editor.height + 6,
      'the fixture leaves room below the selection, so it does not exercise the short-panel clamp',
    );
    assert.ok(
      seen.composer.top - seen.heading.bottom >= seen.editor.height - 1,
      'the unobscured reading area is shorter than the editor, so no placement can keep it visible',
    );
    assert.ok(
      seen.editor.top >= seen.heading.bottom - 1,
      `the editor begins at ${Math.round(seen.editor.top)} under a heading ending at ${Math.round(seen.heading.bottom)}`,
    );
    assert.ok(
      seen.editor.bottom <= seen.composer.top + 1,
      `the editor ends at ${Math.round(seen.editor.bottom)} under a composer beginning at ${Math.round(seen.composer.top)}`,
    );
    for (const action of seen.actions || []) {
      assert.ok(
        action.top >= seen.editor.top - 1 && action.bottom <= seen.editor.bottom + 1,
        `a comment action runs from ${Math.round(action.top)} to ${Math.round(action.bottom)} outside its editor`,
      );
    }
    assert.ok(seen.tight, 'the tighter placement returned no geometry');
    assert.ok(
      seen.tight.scrollHeight > seen.tight.clientHeight,
      'the tighter strip is not shorter than the editor, so it does not exercise the scrolling fallback',
    );
    assert.equal(
      seen.tight.releasedMaxHeight,
      '',
      'closing the comment editor leaves its height constraint on the selection offer host',
    );
    assert.ok(
      seen.tight.editor.top >= seen.tight.heading.bottom - 1,
      `the tight editor begins at ${Math.round(seen.tight.editor.top)} under a heading ending at ${Math.round(seen.tight.heading.bottom)}`,
    );
    assert.ok(
      seen.tight.editor.bottom <= seen.tight.composer.top + 1,
      `the tight editor ends at ${Math.round(seen.tight.editor.bottom)} under a composer beginning at ${Math.round(seen.tight.composer.top)}`,
    );
    for (const action of seen.tight.actions) {
      assert.ok(
        action.top >= seen.tight.editor.top - 1 && action.bottom <= seen.tight.editor.bottom + 1,
        `a scrolled comment action runs from ${Math.round(action.top)} to ${Math.round(action.bottom)} outside its editor`,
      );
    }
    assert.deepEqual(failures, [], 'the panel threw while placing the comment editor between its fixed chrome');
  } finally {
    await browser.close();
  }
});

test(
  'saved offsets and new comments select the correct repeated text without matching partial words',
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
      await page.setContent(pageHtml());

      {
        const repeated = 'repeat target words';
        const middle = 'middle';
        const payload = renderPayload() as { cards: Record<string, unknown>[] };
        payload.cards[0].summaryHtml = `<p>${repeated}</p><p>${middle}</p><p>${repeated}</p><p>catalogue</p>`;
        await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
        await page.evaluate(SETTLED);
        await page.evaluate(() => {
          if ((document.querySelector('.turn .body') as HTMLElement).hidden)
            (document.querySelector('.turn .head') as HTMLElement).click();
        });
        await page.evaluate(SETTLED);
        const card = await page
          .locator('.turn')
          .first()
          .evaluate((node) => ({
            key: (node as HTMLElement).dataset.key || '',
            session: ((node as HTMLElement).dataset.key || '').split(':')[0],
            // A saved offset counts the card heading ahead of the response.
            heading: (node.querySelector('.cardheading')?.textContent || '').replace(/\s+/g, ' ').trim().length + 1,
          }));
        const comments = [
          {
            id: 'repeated-offset',
            sessionId: card.session,
            turnKey: card.key,
            part: 'summary',
            quote: repeated,
            offset: card.heading + repeated.length + middle.length + 2,
            note: 'the second copy',
            headline: '',
            sessionTitle: '',
            turnAt: 1,
            at: 1,
          },
          {
            id: 'word-boundary',
            sessionId: card.session,
            turnKey: card.key,
            part: 'summary',
            quote: 'log',
            note: 'not part of catalogue',
            headline: '',
            sessionTitle: '',
            turnAt: 1,
            at: 2,
          },
        ];
        await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'notes', comments })}, '*')`);
        await page.evaluate(SETTLED);
        const seen = await page
          .locator('.turn')
          .first()
          .evaluate((node) => ({
            marks: Array.from(node.querySelectorAll('.summary p')).map(
              (line) => line.querySelectorAll('.linemark').length,
            ),
            tints: Array.from(node.querySelectorAll('.summary p')).map(
              (line) => line.querySelectorAll('.cmark').length,
            ),
            offline: node.querySelectorAll('.offlinemark').length,
          }));
        assert.deepEqual(seen.marks, [0, 0, 1, 0], 'the repeated quote marked the wrong copy');
        assert.deepEqual(seen.tints, [0, 0, 1, 0], 'the repeated quote tinted the wrong copy');
        assert.equal(seen.offline, 1, 'a partial word matched inside catalogue');
        assert.deepEqual(failures, [], 'the panel threw while resolving comment anchors');
      }

      await page.evaluate(() => window.postMessage({ type: 'notes', comments: [] }, '*'));
      await page.evaluate(SETTLED);
      await page.setViewportSize({ width: 900, height: 900 });

      // Saving and drawing count the same heading and body lines. Otherwise, an offset can select the wrong repeated quote.
      {
        const SAME = 'Same words.';
        const payload = renderPayload() as { cards: Record<string, unknown>[] };
        payload.cards[0].summaryHtml = `<p>${SAME}</p><p>${SAME}</p><p>${SAME}</p>`;
        await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
        await page.waitForFunction(() => document.querySelector('.turn .head') !== null);
        await page.evaluate(() => {
          if ((document.querySelector('.turn .body') as HTMLElement).hidden)
            (document.querySelector('.turn .head') as HTMLElement).click();
        });
        await page.waitForFunction(() => {
          const body = document.querySelector('.turn .body');
          return body !== null && !(body as HTMLElement).hidden;
        });
        await page.evaluate(SETTLED);

        const out = (await page.evaluate(`(async () => {
      const card = document.querySelector('.turn');
      const lines = card.querySelectorAll('.summary p');
      if (lines.length !== 3) return { error: 'the response drew ' + lines.length + ' lines' };
      const range = document.createRange();
      range.selectNodeContents(lines[1]);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      await ${SETTLED};
      document.querySelector('.quotebar').children[0].click();
      await ${SETTLED};
      const area = document.querySelector('.quoteslot .notearea');
      if (!area) return { error: 'pressing Comment opened no box' };
      area.value = 'the middle one';
      document.querySelector('.quoteslot .notesave').click();
      await ${SETTLED};
      const posted = window.__posted.filter((m) => m.type === 'note');
      const sent = posted.length ? posted[posted.length - 1].note : null;
      const note = sent && sent.note ? sent.note : sent;
      return {
        marks: Array.from(card.querySelectorAll('.summary p')).map((line) => line.querySelectorAll('.linemark').length),
        part: note ? String(note.part || '') : '',
        offline: card.querySelectorAll('.offlinemark').length,
      };
    })()`)) as { error?: string; marks?: number[]; part?: string; offline?: number };

        assert.equal(out.error, undefined, out.error || '');
        assert.equal(out.part, 'summary', 'the comment was not saved on the response');
        assert.deepEqual(
          [out.marks, out.offline],
          [[0, 1, 0], 0],
          `the comment saved on the second line drew on line(s) ${JSON.stringify(out.marks)}`,
        );
        assert.deepEqual(failures, [], 'the panel threw while the comment was being saved');
      }
    } finally {
      await browser.close();
    }
  },
);

test(
  'a comment tints the words it was left on, and a quote the line lost tints nothing',
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
      page.on('pageerror', (e) => failures.push(String(e)));
      await page.setViewportSize({ width: 900, height: 900 });
      await page.setContent(pageHtml());
      await tintedCard(page, [OUTER, ROW]);
      const at = (await page.evaluate(TINT)) as Tinted;
      assert.deepEqual(failures, [], 'the panel threw while drawing the tint');

      // Highlight only the quoted words. The mark opens the comment.

      const first = at.paras[0];
      assert.equal(
        first.spans.length,
        1,
        `the comment drew ${first.spans.length} tinted runs on the line it was left on`,
      );
      assert.equal(
        flatWords(first.spans[0].text),
        OUTER,
        'the tint covers words the comment was never left on, which is worse than covering none',
      );
      assert.equal(first.marks, 1, 'the line lost the bubble that opens the comment on it');
      // The computed highlight background must be visible.

      assert.notEqual(
        first.spans[0].background,
        'rgba(0, 0, 0, 0)',
        'the tint resolved to no colour, so the commented words are drawn like every other word',
      );
      // Use opaque highlights so overlaps retain one color. Accept both rgb and color serialization without an alpha component.

      assert.ok(
        !/^rgba\(|\//.test(first.spans[0].background),
        `the tint is ${first.spans[0].background}, which is a layer laid over the card rather than ` +
          'a colour, so overlapping comments would draw darker',
      );
      // The mark is the comment control. Highlighted text must keep its text cursor.

      assert.notEqual(
        first.spans[0].cursor,
        'pointer',
        'the tint takes the pointer, so it reads as a control the keyboard cannot reach',
      );

      // An uncommented line has no highlight.
      assert.deepEqual(at.paras[1].spans, [], 'a line nobody commented on is tinted anyway');

      // A quote missing from its matched line draws no highlight but retains its comment mark.

      assert.ok(at.cell, 'the fixture drew no table cell, so this measures nothing');
      assert.deepEqual(
        at.cell.spans,
        [],
        'a quote the line does not hold was painted anyway, which puts the tint on the wrong words',
      );
      assert.equal(
        at.cell.marks,
        1,
        'the comment lost its bubble as well as its tint, so nothing is left saying it exists',
      );
      assert.equal(at.offLine, 0, 'a comment that matched a line was drawn as being about no line');

      // Hovering a comment with no highlighted words must preserve highlights belonging to other comments.

      const blanked = (await page.evaluate(`(async () => {
      const card = document.querySelector('.turn');
      const mark = card.querySelector('.summary td .linemark');
      if (!mark) return { error: 'the comment whose words the line lost drew no bubble to open' };
      mark.click();
      await ${SETTLED};
      const rows = [...document.querySelectorAll('.markfloat .marknote')];
      if (rows.length !== 1) return { error: 'the float drew ' + rows.length + ' of the 1 comment on the cell' };
      rows[0].dispatchEvent(new MouseEvent('mouseenter'));
      return {
        spans: [...card.querySelectorAll('.summary p .cmark')].map((s) => ({
          lit: s.classList.contains('lit'),
          dulled: s.classList.contains('dulled'),
          background: getComputedStyle(s).backgroundColor,
        })),
      };
    })()`)) as { error?: string; spans?: { lit: boolean; dulled: boolean; background: string }[] };
      assert.equal(blanked.error, undefined, blanked.error || '');
      assert.equal(blanked.spans!.length, 1, 'the tinted run went missing between the two measurements');
      for (const span of blanked.spans!) {
        assert.equal(span.lit, false, 'a comment lit words on a line it was never left on');
        assert.equal(
          span.dulled,
          false,
          'the tint on another line was stepped back for a comment that lit nothing of its own',
        );
        // Compare computed backgrounds as well as highlight classes.

        assert.equal(
          span.background,
          first.spans[0].background,
          `the tinted run is ${span.background} with the float open where it was ` +
            `${first.spans[0].background} before, so the card lost its tint to a comment that ` +
            'painted none of it',
        );
      }
    } finally {
      await browser.close();
    }
  },
);

test('overlapping comments share one flat tint, and the float lights one of them', { timeout: 60_000 }, async (t) => {
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
    // Nest two quotes in the first paragraph. Cross quote boundaries among three comments in the second.

    const comments = await tintedCard(page, [OUTER, INNER, WIDE, MIDDLE, LATE]);
    const at = (await page.evaluate(TINT)) as Tinted;
    assert.deepEqual(failures, [], 'the panel threw while drawing the overlaps');

    // Shared words form one flat run naming every covering comment. Highlight runs must not nest.

    const nest = at.paras[0].spans;
    assert.equal(
      flatWords(nest.map((s) => s.text).join('')),
      OUTER,
      `the pair together tinted ${JSON.stringify(nest.map((s) => s.text))}`,
    );
    const shared = nest.filter((s) => s.notes.length === 2);
    assert.equal(shared.length, 1, 'the words two comments share are not one run naming both');
    assert.equal(
      flatWords(shared[0].text),
      INNER,
      'the shared run covers words only one of the two comments was left on',
    );
    assert.deepEqual(
      shared[0].notes.slice().sort(),
      ['n1', 'n2'],
      'the run two comments cover names one of them, so the float would light the wrong words',
    );
    for (const span of nest) {
      assert.equal(span.nested, false, 'a tinted run is drawn inside another, so the two colours stack');
    }
    // Shared and single-comment runs have the same resting background.

    const alone = nest.find((s) => s.notes.length === 1);
    assert.ok(alone, 'no run is covered by one comment alone, so there is nothing to compare against');
    assert.equal(
      shared[0].background,
      alone.background,
      `the shared run is ${shared[0].background} and a single-comment run ${alone.background}: ` +
        'an overlap draws darker, which makes the colour say how many comments are here',
    );

    // Three overlapping quotes form five runs with coverage counts of one, two, three, two, and one.

    const three = at.paras[1].spans;
    assert.equal(
      flatWords(three.map((s) => s.text).join('')),
      WIDE,
      `the three together tinted ${JSON.stringify(three.map((s) => s.text))}`,
    );
    assert.deepEqual(
      three.map((s) => s.notes.length),
      [1, 2, 3, 2, 1],
      `the three overlaps came out as ${JSON.stringify(three.map((s) => s.notes))}`,
    );
    for (const span of three) {
      assert.equal(span.nested, false, 'a tinted run is drawn inside another, so the three colours stack');
      assert.equal(
        span.background,
        three[0].background,
        `the run under ${span.notes.length} comments is ${span.background} and the run under 1 is ` +
          `${three[0].background}: the tint is not flat`,
      );
    }

    // Resending comments must replace existing highlights without nesting new runs inside them.

    await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'notes', comments })}, '*')`);
    await page.evaluate(SETTLED);
    const twice = (await page.evaluate(TINT)) as Tinted;
    assert.deepEqual(failures, [], 'the panel threw while drawing the tint a second time');
    for (const part of [0, 1]) {
      assert.deepEqual(
        twice.paras[part].spans.map((s) => ({ text: s.text, notes: s.notes, nested: s.nested })),
        at.paras[part].spans.map((s) => ({ text: s.text, notes: s.notes, nested: s.nested })),
        'a redraw left the tint from the sweep before it, so the runs pile up on each other',
      );
      for (const span of twice.paras[part].spans) {
        assert.equal(
          span.background,
          at.paras[part].spans[0].background,
          `a run is ${span.background} after a redraw where it was ${at.paras[part].spans[0].background}`,
        );
      }
    }

    // Hovering a comment highlights its words and dims the other comment highlights.

    const lit = (await page.evaluate(`(async () => {
      const card = document.querySelector('.turn');
      const marks = [...card.querySelectorAll('.summary p .linemark')];
      const mark = marks[marks.length - 1];
      if (!mark) return { error: 'the paragraph with three comments drew no mark to open' };
      mark.click();
      await ${SETTLED};
      const rows = [...document.querySelectorAll('.markfloat .marknote')];
      if (rows.length !== 3) return { error: 'the float drew ' + rows.length + ' of the 3 comments on the line' };
      const second = rows[1];
      const spans = [...card.querySelectorAll('.summary p:nth-of-type(2) .cmark')];
      second.dispatchEvent(new MouseEvent('mouseenter'));
      const read = (s) => ({
        notes: s.getAttribute('data-notes') || '',
        lit: s.classList.contains('lit'),
        dulled: s.classList.contains('dulled'),
        background: getComputedStyle(s).backgroundColor,
        outline: getComputedStyle(s).outlineStyle,
      });
      const on = { note: second.dataset.note, spans: spans.map(read) };
      second.dispatchEvent(new MouseEvent('mouseleave'));
      const after = spans.filter((s) => s.classList.contains('lit') || s.classList.contains('dulled')).length;
      return { on: on, after: after };
    })()`)) as {
      error?: string;
      on?: {
        note: string;
        spans: { notes: string; lit: boolean; dulled: boolean; background: string; outline: string }[];
      };
      after?: number;
    };
    assert.equal(lit.error, undefined, lit.error || '');
    const on = lit.on!;
    assert.equal(on.spans.length, 5, 'the paragraph lost its runs between the two measurements');
    for (const span of on.spans) {
      const mine = span.notes.split(' ').includes(on.note);
      assert.equal(
        span.lit,
        mine,
        `the run naming ${span.notes} came back ${span.lit ? 'lit' : 'unlit'} for the comment ${on.note}`,
      );
      assert.equal(
        span.dulled,
        !mine,
        `the run naming ${span.notes} was not stepped back while another comment was lit`,
      );
    }
    const ownWords = on.spans.filter((s) => s.lit);
    const rest = on.spans.filter((s) => !s.lit);
    assert.ok(
      ownWords.length > 0 && rest.length > 0,
      'pointing at one of three comments lit all of them or none, so it tells nothing apart',
    );
    for (const span of ownWords) {
      // Compare active words against the resting background. Comparing only with dimmed words would also pass without active styling.

      assert.notEqual(
        span.background,
        at.paras[1].spans[0].background,
        'the lit words are drawn in the resting tint, so the entry the reader is on marks nothing',
      );
      assert.notEqual(
        span.background,
        rest[0].background,
        'the lit words are the same colour as the rest, so nothing tells the comment apart',
      );
      assert.notEqual(
        span.outline,
        'none',
        'the lit words carry no outline, which is the other half of what marks them out',
      );
    }
    assert.equal(
      lit.after,
      0,
      'the tint is left lit once the pointer leaves the entry, so the card stays stuck on one comment',
    );

    // Closing the comment list while its row is hovered must clear active highlighting without waiting for pointer departure.

    const shut = (await page.evaluate(`(async () => {
      const card = document.querySelector('.turn');
      const marks = [...card.querySelectorAll('.summary p .linemark')];
      const mark = marks[marks.length - 1];
      // The float the block above pressed open, put away first, so this starts from a card with
      // nothing lit and nothing inside the float holding focus. Focus leaving an entry clears
      // the light down a path of its own, and it would answer for the shutting.
      document.dispatchEvent(new Event('scroll'));
      await ${SETTLED};
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      // Opened by the pointer this time, which is what leaves nothing in it focused.
      mark.dispatchEvent(new MouseEvent('mouseenter'));
      await ${SETTLED};
      const rows = [...document.querySelectorAll('.markfloat .marknote')];
      if (rows.length !== 3) return { error: 'the float drew ' + rows.length + ' of the 3 comments on the line' };
      rows[1].dispatchEvent(new MouseEvent('mouseenter'));
      const held = [...card.querySelectorAll('.cmark')]
        .filter((s) => s.classList.contains('lit') || s.classList.contains('dulled')).length;
      // The page scrolls under a float that is placed once and follows nothing, so it is shut
      // where it stands. The pointer has not moved, so the entry it is on fires no leave.
      document.dispatchEvent(new Event('scroll'));
      await ${SETTLED};
      return {
        held: held,
        open: !document.querySelector('.markfloat').hidden,
        left: [...card.querySelectorAll('.cmark')]
          .filter((s) => s.classList.contains('lit') || s.classList.contains('dulled')).length,
      };
    })()`)) as { error?: string; held?: number; open?: boolean; left?: number };
    assert.equal(shut.error, undefined, shut.error || '');
    assert.ok(
      (shut.held ?? 0) > 0,
      'nothing was lit when the float was shut, so this measured a card that had nothing to clear',
    );
    assert.equal(shut.open, false, 'the scroll left the float standing');
    assert.equal(
      shut.left,
      0,
      'the float shut with one comment lit and the rest of the tint stepped back, and no pointer ' +
        'leaves an entry that is no longer on the page',
    );
  } finally {
    await browser.close();
  }
});

test('a comment added to a shut card opens with its annotation immediately', { timeout: 60_000 }, async (t) => {
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
    await page.evaluate(`window.postMessage(${JSON.stringify(renderPayload())}, '*')`);
    await page.evaluate(SETTLED);

    const prepared = (await page.evaluate(`(() => {
      const card = document.querySelector('.turn');
      const body = card.querySelector('.body');
      const line = card.querySelector('.summary p');
      if (!body || !line) return { error: 'the rendered turn has no commentable body' };
      if (!body.hidden) return { error: 'the fixture turn started open, so the collapsed-card path was not exercised' };
      const target = line.firstChild;
      if (!target || !target.textContent) return { error: 'the commentable line has no text' };
      const range = document.createRange();
      range.setStart(target, 0);
      range.setEnd(target, target.textContent.length);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      return { key: card.dataset.key };
    })()`)) as { error?: string; key?: string };
    assert.equal(prepared.error, undefined, prepared.error || '');
    await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'openComment', key: prepared.key })}, '*')`);
    await page.locator('.notearea').fill('Review this line.');
    await page.locator('.notesave').click();
    await page.evaluate(SETTLED);
    const shown = (await page.evaluate(`(() => {
      const body = document.querySelector('.turn .body');
      return {
        open: !body.hidden,
        marks: body.querySelectorAll('.linemark').length,
      };
    })()`)) as { error?: string; open?: boolean; marks?: number };
    assert.equal(shown.error, undefined, shown.error || '');
    assert.equal(shown.open, true, 'the commented card stays shut until a later timeline refresh');
    assert.ok((shown.marks ?? 0) > 0, 'opening the commented card shows no mark beside the selected line');
    assert.deepEqual(failures, [], 'the panel threw while opening the commented card');
  } finally {
    await browser.close();
  }
});

test('the words a comment is being written about stay painted until the box shuts', { timeout: 60_000 }, async (t) => {
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
    await tintedCard(page, []);

    // Opening the comment editor moves focus away from the response. Keep the selected quote visibly highlighted until editing ends.

    const cancelled = (await page.evaluate(`(async () => {
      const card = document.querySelector('.turn');
      const target = card.querySelectorAll('.summary p')[1];
      const range = document.createRange();
      range.selectNodeContents(target);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      await ${SETTLED};
      const word = document.querySelector('.quotebar').children[0];
      if (!word || document.querySelector('.quotefloat').hidden) return { error: 'the bar offered no way to comment' };
      word.click();
      await ${SETTLED};
      if (!document.querySelector('.quoteslot .notearea')) return { error: 'pressing Comment opened no box' };
      const paint = [...card.querySelectorAll('.csel')];
      const open = {
        runs: paint.length,
        words: paint.map((s) => s.textContent).join(''),
        background: paint.length ? getComputedStyle(paint[0]).backgroundColor : '',
        said: !!document.querySelector('.quoteslot .notesaid'),
      };
      document.querySelector('.quoteslot .noteclose').click();
      await ${SETTLED};
      return { open: open, after: card.querySelectorAll('.csel').length };
    })()`)) as {
      error?: string;
      open?: { runs: number; words: string; background: string; said: boolean };
      after?: number;
    };
    assert.equal(cancelled.error, undefined, cancelled.error || '');
    const open = cancelled.open!;
    assert.ok(open.runs > 0, 'nothing is painted while the box is open, so the reader cannot see what they selected');
    assert.equal(
      flatWords(open.words),
      SECOND_LINE,
      `the box painted ${JSON.stringify(flatWords(open.words))} rather than the words the reader selected`,
    );
    assert.notEqual(
      open.background,
      'rgba(0, 0, 0, 0)',
      'the paint resolved to no colour, so the selection is drawn like every other word',
    );
    // Quote highlighting must preserve the editor accessible description.

    assert.equal(open.said, true, 'the box no longer says which line it is about');
    assert.equal(
      cancelled.after,
      0,
      'the paint is left on the response after Cancel, so the card keeps a selection nobody has',
    );

    // Saving also closes the editor and clears selection highlighting.

    const saved = (await page.evaluate(`(async () => {
      window.__posted.length = 0;
      const card = document.querySelector('.turn');
      const target = card.querySelectorAll('.summary p')[1];
      const range = document.createRange();
      range.selectNodeContents(target);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      await ${SETTLED};
      document.querySelector('.quotebar').children[0].click();
      await ${SETTLED};
      const area = document.querySelector('.quoteslot .notearea');
      if (!area) return { error: 'pressing Comment opened no box' };
      const form = area.closest('form');
      const label = document.querySelector('label[for="' + area.id + '"]');
      const semantics = {
        form: form?.tagName,
        name: form?.getAttribute('aria-label'),
        labelled: label?.textContent,
        buttonTypes: form
          ? [...form.querySelectorAll('button')].map((button) => button.getAttribute('type'))
          : [],
        handoffControls: form
          ? form.querySelectorAll('.notehandoff, .notehandoffmenu, [aria-haspopup="menu"]').length
          : 0,
      };
      area.value = 'a comment on the second line';
      document.querySelector('.quoteslot .notesave').click();
      await ${SETTLED};
      const mark = card.querySelector('.linemark');
      mark?.click();
      await ${SETTLED};
      const region = document.querySelector('.markfloat');
      const popup = { role: region?.getAttribute('role'), name: region?.getAttribute('aria-label') };
      mark?.click();
      return {
        left: card.querySelectorAll('.csel').length,
        tinted: card.querySelectorAll('.cmark').length,
        writes: window.__posted.filter((message) => message.type === 'note').length,
        semantics,
        popup,
      };
    })()`)) as {
      error?: string;
      left?: number;
      tinted?: number;
      writes?: number;
      semantics?: {
        form?: string;
        name?: string;
        labelled?: string;
        buttonTypes: Array<string | null>;
        handoffControls: number;
      };
      popup?: { role?: string; name?: string };
    };
    assert.equal(saved.error, undefined, saved.error || '');
    assert.equal(
      saved.left,
      0,
      'the paint is left on the response after Save, so the words stay drawn as still selected',
    );
    // The saved comment replaces selection highlighting with its own quote highlight.

    assert.ok((saved.tinted ?? 0) > 0, 'the comment just saved tints none of the words it was left on');
    assert.equal(saved.writes, 1, 'pressing Save posted the same comment more than once');
    assert.deepEqual(
      saved.semantics,
      {
        form: 'FORM',
        name: 'Your comment',
        labelled: 'Your comment',
        buttonTypes: ['button', 'submit'],
        handoffControls: 0,
      },
      'the comment editor lost its form, label, name, or explicit button types',
    );
    assert.deepEqual(saved.popup, { role: 'region', name: 'Comments' }, 'the comment popup is not a named region');

    // Delete through the comment control and inspect the local result before a host refresh.

    const deleted = (await page.evaluate(`(async () => {
      const card = document.querySelector('.turn');
      const mark = card.querySelector('.linemark');
      if (!mark) return { error: 'the saved comment drew no mark to open' };
      mark.click();
      await ${SETTLED};
      const away = document.querySelector('.markfloat [data-control^="notedel:"]');
      if (!away) return { error: 'the saved comment drew no Delete control' };
      away.click();
      await ${SETTLED};
      return {
        tinted: card.querySelectorAll('.cmark').length,
        marks: card.querySelectorAll('.linemark').length,
      };
    })()`)) as { error?: string; tinted?: number; marks?: number };
    assert.equal(deleted.error, undefined, deleted.error || '');
    assert.equal(deleted.tinted, 0, 'deleting the comment leaves its annotation on the words until a later repaint');
    assert.equal(deleted.marks, 0, 'deleting the comment leaves its mark on the line until a later repaint');
    assert.deepEqual(failures, [], 'the panel threw while the comment was being written');
  } finally {
    await browser.close();
  }
});

test(
  'the key opens the box on a selection, and is a letter wherever the reader is typing',
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
      page.on('pageerror', (e) => failures.push(String(e)));
      await page.setViewportSize({ width: 900, height: 900 });
      // Open the session-list filter field before testing text entry there.

      await page.setContent(pageHtml());
      await tintedCard(page, []);
      await page.locator('[data-control="railsearch"]').click();
      await page.evaluate('document.activeElement.blur()');
      await page.evaluate(SETTLED);

      // Open the comment editor through the keyboard shortcut without pressing the selection action.

      await page.evaluate(SELECT_SECOND_LINE);
      await page.evaluate(SETTLED);
      await page.keyboard.press('c');
      await page.evaluate(SETTLED);
      const byKey = (await page.evaluate(BOX_OPEN)) as { open: boolean; said: string };
      assert.equal(byKey.open, true, 'pressing the key over a selection opened no box');
      assert.equal(
        flatWords(byKey.said),
        SECOND_LINE,
        `the key opened the box on ${JSON.stringify(flatWords(byKey.said))} rather than on the words the reader had`,
      );

      // Press the shortcut badge inside the selection button. Preventing its mousedown default preserves the selection for the comment action.

      await page.evaluate(`document.querySelector('.quoteslot .noteclose').click()`);
      await page.evaluate(SETTLED);
      await page.evaluate(SELECT_SECOND_LINE);
      await page.evaluate(SETTLED);
      const byChip = (await page.evaluate(`(async () => {
      // The middle of a node's drawn letters. The canvas gives the font's own ascent and the
      // ink's, and the line box gives where the baseline fell, so the two together say where
      // the marks actually are rather than where their box is.
      const inkMiddle = (node) => {
        const el = node.nodeType === 3 ? node.parentNode : node;
        const cs = getComputedStyle(el);
        const cv = document.createElement('canvas').getContext('2d');
        cv.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
        const m = cv.measureText(node.textContent);
        const r = document.createRange();
        if (node.nodeType === 3) { r.selectNode(node); } else { r.selectNodeContents(node); }
        const box = r.getBoundingClientRect();
        const half = (box.height - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2;
        const baseline = box.top + half + m.fontBoundingBoxAscent;
        return ((baseline - m.actualBoundingBoxAscent) + (baseline + m.actualBoundingBoxDescent)) / 2;
      };
      const chip = document.querySelector('.quotebar .quotekey');
      if (!chip) return { error: 'the word on the bar carries no key for the reader to find' };
      const word = chip.closest('.quoteact');
      const style = getComputedStyle(chip);
      const drawn = {
        box: chip.getBoundingClientRect(),
        border: style.borderTopWidth,
        borderColour: style.borderTopColor,
        inside: chip.getBoundingClientRect().right <= word.getBoundingClientRect().right + 0.5,
        lines: word.getBoundingClientRect().height,
        // How far the middle of the key's letter sits from the middle of the word's letters.
        // Measured on the ink rather than on the boxes, because the boxes agree while the ink
        // does not: the word opens on a capital and runs to the baseline, the key is one
        // lowercase letter, and a pill aligned by the baseline hangs under the word by about
        // two pixels. Boxes alone report that as centred.
        offset: Math.abs(inkMiddle(chip) - inkMiddle(word.firstChild)),
      };
      const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      chip.dispatchEvent(down);
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await ${SETTLED};
      const box = document.querySelector('.quoteslot .noteedit');
      const said = box ? box.querySelector('.notesaid') : null;
      return { drawn: drawn, defaulted: down.defaultPrevented, open: !!box, said: said ? said.textContent : '' };
    })()`)) as {
        error?: string;
        defaulted?: boolean;
        open?: boolean;
        said?: string;
        drawn?: {
          box: { width: number; height: number };
          border: string;
          borderColour: string;
          inside: boolean;
          lines: number;
          offset: number;
        };
      };
      assert.equal(byChip.error, undefined, byChip.error || '');

      // The shortcut badge must have visible dimensions and a border separating it from the action text.

      const drawn = byChip.drawn!;
      assert.ok(drawn.box.width > 0 && drawn.box.height > 0, 'the chip is drawn at no size at all');
      assert.notEqual(
        drawn.border,
        '0px',
        'the chip has no border, so it reads as a letter stuck on the end of the word',
      );
      assert.notEqual(
        drawn.borderColour,
        'rgba(0, 0, 0, 0)',
        'the chip border resolved to no colour, so nothing marks the key off from the word',
      );
      assert.equal(drawn.inside, true, 'the chip is drawn past the edge of the word it belongs to');
      assert.ok(
        drawn.offset <= 1,
        `the key's letter sits ${drawn.offset.toFixed(1)}px off the middle of the word's letters, so the pill hangs under the word`,
      );
      // The shortcut badge must fit on the selection action line.
      assert.ok(
        drawn.lines < 40,
        `the word on the bar is ${drawn.lines}px tall, so the chip wrapped the bar onto a second line`,
      );
      assert.equal(
        byChip.defaulted,
        true,
        'a press on the chip is not defaulted, so it clears the selection the word is about to read',
      );
      assert.equal(byChip.open, true, 'pressing the chip rather than the word opened no box');
      assert.equal(
        flatWords(byChip.said || ''),
        SECOND_LINE,
        'pressing the chip opened the box on words other than the ones the reader had',
      );

      // Keep a response selection while dispatching the shortcut from editable fields. Also test keyboard text entry separately after clearing the response selection.

      await page.evaluate(`document.querySelector('.quoteslot .noteclose').click()`);
      await page.evaluate(SETTLED);
      const typing = (await page.evaluate(`(async () => {
      const boxes = {
        'the prompt box': document.getElementById('prompt'),
        'the rail filter': document.querySelector('.railfilter'),
      };
      const seen = {};
      for (const where of Object.keys(boxes)) {
        const at = boxes[where];
        if (!at) { seen[where] = 'not on the page'; continue; }
        at.focus();
        const card = document.querySelector('.turn');
        const range = document.createRange();
        range.selectNodeContents(card.querySelectorAll('.summary p')[1]);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        await ${SETTLED};
        if (getSelection().isCollapsed) { seen[where] = 'nothing was selected, so this measured nothing'; continue; }
        const press = new KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true });
        at.dispatchEvent(press);
        await ${SETTLED};
        seen[where] = (document.querySelector('.quoteslot .noteedit') ? 'a box opened' : '')
          + (press.defaultPrevented ? ' the letter was swallowed' : '');
        if (document.querySelector('.quoteslot .noteclose')) document.querySelector('.quoteslot .noteclose').click();
        await ${SETTLED};
      }
      return seen;
    })()`)) as Record<string, string>;
      for (const [where, what] of Object.entries(typing)) {
        assert.equal(what, '', `the key pressed in ${where} ${what.trim()}`);
      }

      // Clear the response selection, focus the prompt field, and type the shortcut letter as ordinary text.

      await page.evaluate(`(() => { getSelection().removeAllRanges(); })()`);
      await page.focus('#prompt');
      await page.keyboard.press('c');
      await page.evaluate(SETTLED);
      const typed = (await page.evaluate(`(() => ({
      value: document.getElementById('prompt').value,
      open: !!document.querySelector('.quoteslot .noteedit'),
    }))()`)) as { value: string; open: boolean };
      assert.equal(
        typed.value,
        'c',
        `the prompt box holds ${JSON.stringify(typed.value)} after the key, so the panel swallowed the letter`,
      );
      assert.equal(typed.open, false, 'the key opened a box over the words the reader was typing');
      assert.deepEqual(failures, [], 'the panel threw while the key was being pressed');
    } finally {
      await browser.close();
    }
  },
);

test(
  'a card whose turn writes on is left alone while a comment is being written about it',
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
      page.on('pageerror', (e) => failures.push(String(e)));
      await page.setViewportSize({ width: 900, height: 900 });
      await page.setContent(pageHtml());
      await tintedCard(page, []);

      // Mark the card after opening the editor so later updates reveal any replacement.

      await page.evaluate(SELECT_SECOND_LINE);
      await page.evaluate(SETTLED);
      await page.keyboard.press('c');
      await page.evaluate(SETTLED);
      const opened = (await page.evaluate(`(() => {
      const card = document.querySelector('.turn');
      card.dataset.stamp = 'the card the box opened on';
      return {
        open: !!document.querySelector('.quoteslot .noteedit'),
        painted: card.querySelectorAll('.csel').length,
        lines: card.querySelectorAll('.summary p').length,
      };
    })()`)) as { open: boolean; painted: number; lines: number };
      assert.equal(opened.open, true, 'the key opened no box, so nothing below measures anything');
      assert.ok(opened.painted > 0, 'the box painted nothing, so there is no paint for a rewrite to take');

      // Send new response content while the comment editor is open. The card update must wait.

      const moved = renderPayload() as { cards: Record<string, unknown>[] };
      moved.cards[0].summaryHtml = TINTED_RESPONSE + '<p>And a line written while the reader was typing.</p>';
      await page.evaluate(`window.postMessage(${JSON.stringify(moved)}, '*')`);
      await page.evaluate(SETTLED);
      await page.evaluate(SETTLED);
      const during = (await page.evaluate(`(() => {
      const card = document.querySelector('.turn');
      return {
        stamp: card.dataset.stamp || '',
        painted: card.querySelectorAll('.csel').length,
        open: !!document.querySelector('.quoteslot .noteedit'),
        lines: card.querySelectorAll('.summary p').length,
      };
    })()`)) as { stamp: string; painted: number; open: boolean; lines: number };
      assert.equal(during.open, true, 'the render took the box down with it');
      assert.equal(
        during.stamp,
        'the card the box opened on',
        'the card was built again under the open box, so the words the comment is about lost the ' +
          "paint that says they are still the reader's",
      );
      assert.equal(
        during.painted,
        opened.painted,
        `the paint came back as ${during.painted} runs where it was ${opened.painted}, so the reader ` +
          'is typing about words nothing on screen points at any more',
      );
      assert.equal(
        during.lines,
        opened.lines,
        'the card took the new line while the box stood over it, which is the rewrite this waits for',
      );

      // Closing the editor must release the deferred card update.

      await page.evaluate(`document.querySelector('.quoteslot .noteclose').click()`);
      await page.evaluate(SETTLED);
      await page.evaluate(SETTLED);
      const after = (await page.evaluate(`(() => {
      const card = document.querySelector('.turn');
      return {
        stamp: card.dataset.stamp || '',
        lines: card.querySelectorAll('.summary p').length,
        painted: card.querySelectorAll('.csel').length,
      };
    })()`)) as { stamp: string; lines: number; painted: number };
      assert.equal(
        after.stamp,
        'the card the box opened on',
        'the component replaced the list-owned wrapper after the box shut',
      );
      assert.equal(
        after.lines,
        opened.lines + 1,
        'the line the turn wrote while the box was open never reached the card',
      );
      assert.equal(after.painted, 0, 'the selection paint outlived the box that drew it');
      assert.deepEqual(failures, [], 'the panel threw while the card was held for the box');
    } finally {
      await browser.close();
    }
  },
);

test(
  'a cross-card selection defers structural replacement and applies the newest update',
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
      await page.setContent(pageHtml());
      const first = renderPayload() as { cards: Record<string, unknown>[] };
      const original = first.cards[0];
      const second = {
        ...original,
        key: `${original.key}:second`,
        headline: 'Second selected card',
        startedAt: Number(original.startedAt) + 1,
      };
      first.cards = [original, second];
      await page.evaluate(`window.postMessage(${JSON.stringify(first)}, '*')`);
      await page.evaluate(SETTLED);
      const selected = await page.evaluate(`(() => {
      const cards = document.querySelectorAll('.turn');
      const range = document.createRange();
      range.setStart(cards[0].querySelector('.headline').firstChild, 0);
      range.setEnd(cards[1].querySelector('.headline').firstChild,
        cards[1].querySelector('.headline').textContent.length);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return selection.toString();
    })()`);
      assert.ok(String(selected).includes('Second selected card'), 'the fixture did not select across both cards');

      const middle = { ...first, cards: [second, original] };
      const newest = { ...first, cards: [{ ...second, headline: 'Newest replacement' }] };
      await page.evaluate(`window.postMessage(${JSON.stringify(middle)}, '*')`);
      await page.evaluate(`window.postMessage(${JSON.stringify(newest)}, '*')`);
      await page.evaluate(SETTLED);
      assert.equal(
        await page.locator('.turn').count(),
        2,
        'a structural update replaced cards while the reader held a cross-card selection',
      );

      await page.evaluate(`(() => {
      getSelection().removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
    })()`);
      await page.evaluate(SETTLED);
      assert.equal(
        await page.locator('.turn').count(),
        1,
        'releasing the selection did not apply the pending structural update',
      );
      assert.equal(
        await page.locator('.turn .headline').textContent(),
        'Newest replacement',
        'selection release applied an older pending update',
      );
      assert.deepEqual(failures, [], 'the panel threw while it deferred a structural update');
    } finally {
      await browser.close();
    }
  },
);

test('read commands update one card or its whole session without duplicate saves', { timeout: 60_000 }, async (t) => {
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
    const payload = renderPayload() as { cards: Record<string, unknown>[]; rail: Record<string, unknown>[] };
    const first = payload.cards[0];
    const second = {
      ...first,
      key: `${first.key}:second`,
      headline: 'Second read-state card',
      startedAt: Number(first.startedAt) + 1,
    };
    payload.cards = [first, second];
    const session = String(first.sessionId);
    const rail = payload.rail.find((row) => row.id === session);
    if (rail) {
      rail.newestTurnAt = second.startedAt;
    }
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
    await page.evaluate('window.__posted.length = 0');

    const key = String(first.key);
    await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'setRead', key, read: true })}, '*')`);
    await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'setRead', key, read: true })}, '*')`);
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await page.locator('.turn').evaluateAll((cards) => cards.map((card) => card.classList.contains('is-read'))),
      [true, false],
      'a turn command changed more than the named card',
    );
    assert.equal(
      await page.evaluate(`window.__posted.filter((message) => message.type === 'saveState').length`),
      1,
      'setting one turn to its existing read state saved it twice',
    );

    await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'setSessionRead', session, read: true })}, '*')`);
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await page.locator('.turn').evaluateAll((cards) => cards.map((card) => card.classList.contains('is-read'))),
      [true, true],
      'marking the session left one of its cards unread',
    );

    await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'setSessionRead', session, read: false })}, '*')`);
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await page.locator('.turn').evaluateAll((cards) => cards.map((card) => card.classList.contains('is-read'))),
      [false, false],
      'marking the session unread left one of its cards read',
    );
    assert.deepEqual(failures, [], 'the panel threw while it applied read commands');
  } finally {
    await browser.close();
  }
});

test(
  'attachment chips stay inside the composer and keep their extension at narrow widths',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
      return;
    }
    const assets = [
      {
        id: 'image-one',
        name: 'pasted-14-32-05.png',
        mime: 'image/png',
        size: 200_000,
        digest: '0'.repeat(64),
        path: 'C:/staged/image-one',
      },
      {
        id: 'image-two',
        name: 'pasted-14-33-41.png',
        mime: 'image/png',
        size: 200_000,
        digest: '1'.repeat(64),
        path: 'C:/staged/image-two',
      },
      {
        id: 'document',
        name: `${'usage-reducer-design-notes-'.repeat(2)}final-reviewed.pdf`,
        mime: 'application/pdf',
        size: 3 * 1024 * 1024,
        digest: '2'.repeat(64),
        path: 'C:/staged/document',
      },
    ];
    try {
      const page = await browser.newPage();
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(String(error)));
      await page.setContent(pageHtml());
      for (const width of [1350, 340]) {
        await layoutAt(page, width, [], [], [], [], [], [], assets);
        const measured = (await page.evaluate(`(() => {
        const composer = document.getElementById('composer').getBoundingClientRect();
        const files = [...document.querySelectorAll('.cfile')].map((file) => {
          const box = file.getBoundingClientRect();
          const ext = file.querySelector('.cext');
          const extBox = ext ? ext.getBoundingClientRect() : null;
          return {
            left: box.left, right: box.right, width: box.width,
            extLeft: extBox?.left ?? 0, extRight: extBox?.right ?? 0, extWidth: extBox?.width ?? 0,
          };
        });
        return { composer, files };
      })()`)) as {
          composer: { left: number; right: number; width: number };
          files: { left: number; right: number; width: number; extLeft: number; extRight: number; extWidth: number }[];
        };
        assert.equal(
          measured.files.length,
          3,
          `the composer drew ${measured.files.length} attachment chips at ${width}px`,
        );
        assert.ok(measured.composer.width > 0, `the composer has no width at ${width}px`);
        for (const file of measured.files) {
          assert.ok(
            file.width > 0 && file.left >= measured.composer.left - 1 && file.right <= measured.composer.right + 1,
            `an attachment chip escapes the composer at ${width}px`,
          );
        }
        if (width === 340) {
          assert.ok(measured.files[2].extWidth > 0, 'the PDF extension is hidden at 340px');
          assert.ok(
            measured.files[2].extLeft >= measured.files[2].left &&
              measured.files[2].extRight <= measured.files[2].right,
            'the PDF extension is drawn outside its chip at 340px',
          );
        }
      }
      await layoutAt(page, 1350);
      const stagingToken = (await page.evaluate(`(() => {
      window.__attachmentReads = [];
      const file = (name) => ({ name, type: 'image/png', size: 1, arrayBuffer: () => new Promise((resolve) => window.__attachmentReads.push(resolve)) });
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { files: [file('first.png'), file('second.png')] } });
      document.getElementById('prompt').dispatchEvent(event);
      return window.__posted.at(-1).token;
    })()`)) as string;
      await page.evaluate(
        `window.postMessage(${JSON.stringify({ type: 'fileStaging', session: 'thread-one', token: stagingToken, pending: true })}, '*'); window.postMessage(${JSON.stringify({ type: 'fileStaging', session: 's1', token: stagingToken, pending: false })}, '*')`,
      );
      const adoptedUsage = (renderPayload() as { usage: { composer: { sessionId: string; targetName: string } } })
        .usage;
      adoptedUsage.composer.sessionId = 'thread-one';
      adoptedUsage.composer.targetName = 'Adopted session';
      await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'usage', usage: adoptedUsage })}, '*')`);
      assert.match(
        (await page.locator('.cfilepending').textContent()) ?? '',
        /^Attaching 2 files/,
        'session adoption loses the staged-file count before the real session finishes reading',
      );
      await page.evaluate(`window.__attachmentReads.splice(0).forEach((resolve) => resolve(new ArrayBuffer(1)))`);
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.evaluate(`window.__posted.at(-1).clipboard`),
        true,
        'a pasted browser file does not retain its clipboard origin after adoption',
      );
      await page.evaluate(
        `window.postMessage(${JSON.stringify({ type: 'fileStaging', session: 'thread-one', token: stagingToken, pending: false })}, '*')`,
      );
      await page.evaluate(SETTLED);
      assert.equal(
        await page.locator('.cfilepending').count(),
        0,
        'finishing a browser file read leaves its staging placeholder behind',
      );
      assert.deepEqual(failures, [], 'the panel threw while drawing attachment chips');
    } finally {
      await browser.close();
    }
  },
);

test(
  'the composer picker row carries the servers control without pushing anything off the panel',
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
      page.on('pageerror', (e) => failures.push(String(e)));
      await page.setContent(pageHtml());

      // Build expected server-control text from the prompt-box state. Include failed servers so the control exercises its caution label.

      const view = composerView({ ...COMPOSER, mcpServers: MCP_SERVERS }, NOW);
      assert.ok(view, 'the reducer drew no composer, so there is nothing to measure');
      const servers = view.picks.filter((p) => p.control === 'mcp');
      assert.equal(servers.length, 1, 'the composer drew no servers control, so this measures a three-control row');
      assert.equal(
        view.picks.length,
        4,
        `the picker row was handed ${view.picks.length} controls, and this guard is about the fourth`,
      );
      assert.equal(
        servers[0].caution,
        true,
        'no server in the fixture failed, so the control wears its short label and the widest case goes unmeasured',
      );

      // Check that the picker row fits at editor-tab, breakpoint, and sidebar widths.

      for (const width of [1350, RAIL_MIN_WIDTH - 60, 340]) {
        await layoutAt(page, width, [], [], [], MCP_SERVERS);
        const at = (await page.evaluate(PICKER_ROW)) as PickerRow;
        const where = `at ${width}px`;
        assert.deepEqual(failures, [], `the panel threw while drawing the picker row ${where}`);

        assert.equal(at.picks.length, 4, `the picker row drew ${at.picks.length} controls ${where}`);
        const drawn = at.picks.filter((p) => p.control === 'mcp')[0];
        assert.ok(drawn, `the servers control is not on the row ${where}`);
        assert.ok(
          drawn.label?.startsWith(servers[0].label),
          `the servers control reads "${drawn.label}" ${where}, and the decided label is "${servers[0].label}"`,
        );

        assert.ok(
          at.documentWidth <= at.viewportWidth + 1,
          `the panel scrolls sideways ${where} with the servers control on the row: ` +
            `${at.documentWidth} wide in a ${at.viewportWidth} viewport`,
        );

        // Each prompt-box control must have visible dimensions and stay inside the prompt box.

        const onRow: [string, Placed | null][] = [
          ...at.picks.map((p) => [`the ${p.control} control`, p] as [string, Placed]),
          ['the window figure', at.figure],
          ['the send', at.send],
          ['the box', at.prompt],
        ];
        for (const [what, node] of onRow) {
          assert.ok(node, `${what} is not drawn at all ${where}`);
          assert.ok(
            node.width > 0 && node.height > 0,
            `${what} is drawn ${Math.round(node.width)} by ${Math.round(node.height)} ${where}, so it is squeezed to nothing`,
          );
          assert.ok(
            node.left >= at.composer.left - 1 && node.right <= at.composer.right + 1,
            `${what} runs from ${Math.round(node.left)} to ${Math.round(node.right)} ${where}, ` +
              `outside the composer own ${Math.round(at.composer.left)} to ${Math.round(at.composer.right)}`,
          );
          assert.ok(
            node.right <= at.viewportWidth + 1 && node.left >= -1,
            `${what} runs from ${Math.round(node.left)} to ${Math.round(node.right)} ${where}, off the panel`,
          );
          assert.ok(
            node.bottom <= at.viewportHeight + 1 && node.top >= -1,
            `${what} runs from ${Math.round(node.top)} to ${Math.round(node.bottom)} ${where}, ` +
              'off the top or the bottom of the panel',
          );
        }

        // The picker row can wrap, but it must keep the prompt box inside the panel bottom edge.

        assert.ok(
          at.composer.bottom <= at.viewportHeight + 1,
          `the composer ends at ${Math.round(at.composer.bottom)} ${where} in a ${at.viewportHeight} viewport, ` +
            'so the row has pushed its own foot off the panel',
        );
        assert.ok(
          at.row.bottom <= at.composer.bottom + 1,
          `the picker row ends at ${Math.round(at.row.bottom)} ${where} and the composer at ` +
            `${Math.round(at.composer.bottom)}, so the row is drawn out of the box it belongs to`,
        );
        // The picker row must remain below the prompt text field.

        assert.ok(
          at.prompt && at.prompt.bottom <= at.row.top + 1,
          `the box ends at ${Math.round(at.prompt?.bottom ?? 0)} ${where} with the picker row starting at ` +
            `${Math.round(at.row.top)}, so one is drawn over the other`,
        );

        // Check overlap on both axes. Different control heights produce unequal top edges even when controls share a row.

        for (let i = 0; i < onRow.length; i++) {
          for (let j = i + 1; j < onRow.length; j++) {
            const [what, a] = onRow[i];
            const [other, b] = onRow[j];
            if (!a || !b) {
              continue;
            }
            const across = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const down = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            assert.ok(
              across <= 1 || down <= 1,
              `${what} and ${other} are drawn over each other ${where}, sharing ` +
                `${Math.round(across)} by ${Math.round(down)} pixels`,
            );
          }
        }
      }
      assert.deepEqual(failures, [], 'the panel threw while drawing the picker row');
    } finally {
      await browser.close();
    }
  },
);

test('the actionable context meter shares picker geometry and hover treatment', { timeout: 60_000 }, async (t) => {
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
    const scales = new Map<number, { rowGap: number; barWidth: number; barHeight: number; paddingLeft: number }>();
    for (const width of [1350, 547]) {
      for (const fontSize of [13, 18]) {
        await page.setViewportSize({ width, height: 900 });
        // Change the editor font-size variable to exercise context-meter scaling.
        await page.evaluate((size) => document.body.style.setProperty('--vscode-font-size', `${size}px`), fontSize);
        await page.evaluate(`window.postMessage(${JSON.stringify(renderPayload())}, '*')`);
        await page.evaluate(SETTLED);
        await page.locator('.cpicks .cpick').first().hover();
        const pickerHover = await page
          .locator('.cpicks .cpick')
          .first()
          .evaluate((node) => {
            const style = getComputedStyle(node);
            return {
              background: style.backgroundColor,
              borderColor: style.borderColor,
              borderStyle: style.borderStyle,
              borderWidth: style.borderWidth,
            };
          });
        await page.locator('button.cctx').hover();
        const measured = (await page.evaluate(`(() => {
          const row = document.querySelector('.cpicks');
          const picker = row.querySelector('.cpick');
          const context = row.querySelector('button.cctx');
          const bar = context.querySelector('.cctxbar');
          const rect = (node) => node.getBoundingClientRect();
          const pickAt = rect(picker);
          const contextAt = rect(context);
          const contextStyle = getComputedStyle(context);
          const rowStyle = getComputedStyle(row);
          const barAt = rect(bar);
          const peers = [...row.querySelectorAll('.cpick')]
            .map((node) => rect(node))
            .filter((at) => at.right <= contextAt.left + 0.5 && at.bottom > contextAt.top && at.top < contextAt.bottom);
          const previous = peers.sort((a, b) => b.right - a.right)[0] || null;
          return {
            pickerHeight: pickAt.height,
            contextHeight: contextAt.height,
            pickerCenter: (pickAt.top + pickAt.bottom) / 2,
            contextCenter: (contextAt.top + contextAt.bottom) / 2,
            gap: previous ? contextAt.left - previous.right : null,
            rowGap: parseFloat(rowStyle.columnGap),
            barWidth: barAt.width,
            barHeight: barAt.height,
            paddingLeft: parseFloat(contextStyle.paddingLeft),
            hover: {
              background: contextStyle.backgroundColor, borderColor: contextStyle.borderColor,
              borderStyle: contextStyle.borderStyle, borderWidth: contextStyle.borderWidth,
            },
          };
        })()`)) as {
          pickerHeight: number;
          contextHeight: number;
          pickerCenter: number;
          contextCenter: number;
          gap: number | null;
          rowGap: number;
          barWidth: number;
          barHeight: number;
          paddingLeft: number;
          hover: { background: string; borderColor: string; borderStyle: string; borderWidth: string };
        };
        const where = `at ${width}px and ${fontSize}px text`;
        assert.ok(
          Math.abs(measured.pickerHeight - measured.contextHeight) <= 0.5,
          `the ${measured.contextHeight}px context meter is not the ${measured.pickerHeight}px picker height ${where}`,
        );
        assert.ok(
          Math.abs(measured.pickerCenter - measured.contextCenter) <= 0.5,
          `the context meter does not share the picker center line ${where}`,
        );
        assert.ok(measured.gap !== null, `the context meter has no picker peer on its line ${where}`);
        assert.ok(
          measured.gap >= measured.rowGap - 0.5,
          `the context meter leaves ${measured.gap}px beside a ${measured.rowGap}px picker gap ${where}`,
        );
        assert.ok(
          measured.gap <= measured.rowGap + 0.5,
          `the context meter leaves ${measured.gap}px after the servers picker instead of the ${measured.rowGap}px row gap ${where}`,
        );
        assert.deepEqual(measured.hover, pickerHover, `the context meter hover differs from a picker ${where}`);
        if (width === 1350) {
          scales.set(fontSize, {
            rowGap: measured.rowGap,
            barWidth: measured.barWidth,
            barHeight: measured.barHeight,
            paddingLeft: measured.paddingLeft,
          });
        }
      }
    }
    const small = scales.get(13);
    const large = scales.get(18);
    assert.ok(small && large, 'the text-scale comparison did not measure both sizes');
    const ratio = 18 / 13;
    for (const [name, smallValue, largeValue] of [
      ['row gap', small.rowGap, large.rowGap],
      ['meter width', small.barWidth, large.barWidth],
      ['meter height', small.barHeight, large.barHeight],
      ['control padding', small.paddingLeft, large.paddingLeft],
    ] as const) {
      assert.ok(
        Math.abs(largeValue / smallValue - ratio) <= 0.08,
        `the ${name} scales by ${(largeValue / smallValue).toFixed(2)} instead of ${ratio.toFixed(2)}`,
      );
    }
    assert.deepEqual(failures, [], 'the panel threw while comparing the context meter with its picker peers');
  } finally {
    await browser.close();
  }
});

test('the servers menu opens inside the panel, with every row of it on screen', { timeout: 60_000 }, async (t) => {
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

    const menu = pickMenu('mcp', { ...COMPOSER, mcpServers: MCP_SERVERS });
    assert.ok(menu, 'the reducer built no servers menu, so there is nothing to open');
    assert.ok(
      menu.items.length >= 6,
      `the fixture builds a ${menu.items.length}-row menu, which fits anywhere and so measures no placement`,
    );
    const toggle = menu.items.find((item) => item.kind === 'toggle');
    const action = menu.items.find((item) => item.kind === 'action');
    assert.ok(toggle && action, 'the servers fixture has no switch and repair action to exercise');
    const modelMenu = pickMenu('model', { ...COMPOSER, mcpServers: MCP_SERVERS });
    assert.ok(modelMenu?.items.length, 'the fixture has no model choice to exercise');

    for (const width of [1350, 340]) {
      await layoutAt(page, width, [], [], [], MCP_SERVERS);
      assert.ok(await page.evaluate(OPEN_SERVERS), `the composer drew no servers control at ${width}px`);
      await page.evaluate(SETTLED);
      const at = (await page.evaluate(MENU_BOX)) as MenuBox;
      const where = `at ${width}px`;
      assert.deepEqual(failures, [], `the panel threw while opening the servers menu ${where}`);

      assert.equal(at.hidden, false, `the servers control was pressed ${where} and no menu opened`);
      assert.equal(
        at.rows.length,
        menu.items.length,
        `the menu drew ${at.rows.length} rows ${where} for the ${menu.items.length} it was given`,
      );
      await page.evaluate(`(() => {
        window.__heldPickPopover = document.getElementById('pickpop');
        window.__heldPickRow = document.querySelector('#pickpop .pickrow');
        window.__heldPickRow.focus();
      })()`);
      const unrelated = (renderPayload([], [], [], MCP_SERVERS) as { usage: { bar: unknown } }).usage;
      unrelated.bar = null;
      await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'usage', usage: unrelated })}, '*')`);
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.evaluate(`(() => {
        const pop = document.getElementById('pickpop');
        const row = pop.querySelector('.pickrow');
        return {
          hidden: pop.hidden,
          samePopover: pop === window.__heldPickPopover,
          sameRow: row === window.__heldPickRow,
          focused: document.activeElement === row,
        };
      })()`),
        { hidden: false, samePopover: true, sameRow: true, focused: true },
        `an unrelated usage message replaced or closed the focused servers menu ${where}`,
      );
      const toggleRow = page.locator(`[data-control="mcp:${toggle.value}"]`);
      assert.equal(
        await toggleRow.evaluate((row) => row.tagName),
        'BUTTON',
        `a server switch is not a button ${where}`,
      );
      assert.equal(
        await toggleRow.getAttribute('role'),
        'menuitemcheckbox',
        `a server switch is not announced as an independent checkbox ${where}`,
      );
      assert.equal(
        await toggleRow.getAttribute('aria-checked'),
        String(toggle.checked),
        `a server switch does not announce its current state ${where}`,
      );
      await toggleRow.click();
      await page.evaluate(SETTLED);
      assert.equal(
        await page.locator('#pickpop').isHidden(),
        false,
        `switching one server closed the servers menu ${where}`,
      );
      assert.equal(
        await page.evaluate(`document.activeElement && document.activeElement.dataset.control`),
        `mcp:${toggle.value}`,
        `switching one server lost its focused row ${where}`,
      );
      assert.deepEqual(
        await page.evaluate(`window.__posted.at(-1)`),
        {
          type: 'pick',
          control: menu.control,
          agent: menu.agent,
          session: menu.session ?? '',
          model: menu.model ?? '',
          value: toggle.value,
        },
        `a server switch posted the wrong choice ${where}`,
      );

      const actionRow = page.locator(`[data-control="mcp:${action.value}"]`);
      assert.equal(
        await actionRow.getAttribute('role'),
        'menuitem',
        `the server repair action is announced as a setting ${where}`,
      );
      assert.equal(
        await actionRow.getAttribute('aria-checked'),
        null,
        `the server repair action announces a checked state ${where}`,
      );
      await actionRow.click();
      await page.evaluate(SETTLED);
      assert.equal(
        await page.locator('#pickpop').isHidden(),
        true,
        `the completed server repair action left its menu open ${where}`,
      );
      assert.equal(
        await page.evaluate(`document.activeElement && document.activeElement.dataset.control`),
        'mcp',
        `the server repair action did not return focus to its control ${where}`,
      );

      await page.locator('[data-control="model"]').click();
      await page.evaluate(SETTLED);
      const modelItem = modelMenu.items[0];
      const modelRow = page.locator(`[data-control="model:${modelItem.value}"]`);
      assert.equal(
        await modelRow.getAttribute('role'),
        'option',
        `a model choice is not announced as one choice from a set ${where}`,
      );
      assert.equal(
        await modelRow.getAttribute('aria-selected'),
        String(modelItem.checked),
        `a model choice does not announce its current state ${where}`,
      );
      await modelRow.click();
      await page.evaluate(SETTLED);
      assert.equal(await page.locator('#pickpop').isHidden(), true, `choosing a model left its menu open ${where}`);
      assert.equal(
        await page.evaluate(`document.activeElement && document.activeElement.dataset.control`),
        'model',
        `choosing a model did not return focus to its control ${where}`,
      );
      // Require a menu taller than 200px so placement must account for available space.

      assert.ok(
        at.pop.height > 200,
        `the menu is only ${Math.round(at.pop.height)}px tall ${where}, so it fits anywhere and this measures nothing`,
      );

      // The full server menu must remain inside the panel.

      assert.ok(at.pop.top >= -1, `the menu starts at ${Math.round(at.pop.top)} ${where}, above the top of the panel`);
      assert.ok(
        at.pop.bottom <= at.viewportHeight + 1,
        `the menu ends at ${Math.round(at.pop.bottom)} ${where} in a ${at.viewportHeight} viewport, ` +
          'so its last rows are off the bottom of the panel',
      );
      assert.ok(
        at.pop.left >= -1 && at.pop.right <= at.viewportWidth + 1,
        `the menu runs from ${Math.round(at.pop.left)} to ${Math.round(at.pop.right)} ${where} ` +
          `in a ${at.viewportWidth} viewport, so it is off one edge`,
      );

      // The server menu must leave its anchor control uncovered.

      assert.ok(
        at.pop.bottom <= at.anchor.top + 1 || at.pop.top >= at.anchor.bottom - 1,
        `the menu runs from ${Math.round(at.pop.top)} to ${Math.round(at.pop.bottom)} ${where} and the control it ` +
          `opened from from ${Math.round(at.anchor.top)} to ${Math.round(at.anchor.bottom)}: one covers the other`,
      );

      // Every server row must have visible dimensions and fit inside the menu without scrolling.

      assert.ok(
        at.scrollHeight <= at.clientHeight + 1,
        `the menu holds ${at.scrollHeight}px of rows in ${at.clientHeight}px ${where}, so the reader has to scroll ` +
          'inside it to reach the servers at the end of the list',
      );
      for (const row of at.rows) {
        assert.ok(
          row.width > 0 && row.height > 0,
          `the ${row.control} row is drawn ${Math.round(row.width)} by ${Math.round(row.height)} ${where}`,
        );
        assert.ok(
          row.top >= at.pop.top - 1 && row.bottom <= at.pop.bottom + 1,
          `the ${row.control} row runs from ${Math.round(row.top)} to ${Math.round(row.bottom)} ${where}, ` +
            `outside the menu own ${Math.round(at.pop.top)} to ${Math.round(at.pop.bottom)}`,
        );
        assert.ok(
          row.left >= at.pop.left - 1 && row.right <= at.pop.right + 1,
          `the ${row.control} row runs from ${Math.round(row.left)} to ${Math.round(row.right)} ${where}, ` +
            'past the side of the menu that holds it',
        );
      }
    }

    const statusServers = MCP_SERVERS.map((server) => ({ ...server, mutable: false as const }));
    const statusState = { ...COMPOSER, agent: 'codex' as const, mcpServers: statusServers };
    const statusMenu = pickMenu('mcp', statusState);
    const statusView = composerView(statusState, FIXTURE_CLOCK);
    assert.ok(
      statusMenu && statusView && statusMenu.items.every((item) => item.kind === 'status'),
      'the Codex fixture has no read-only server rows to exercise',
    );
    const statusPayload = renderPayload([], [], [], MCP_SERVERS) as {
      usage: { composer: unknown; menus: Record<string, unknown> };
    };
    statusPayload.usage.composer = statusView;
    statusPayload.usage.menus.mcp = statusMenu;
    await page.evaluate(`window.postMessage(${JSON.stringify(statusPayload)}, '*')`);
    await page.evaluate(SETTLED);
    assert.ok(await page.evaluate(OPEN_SERVERS), 'the read-only server inventory drew no control');
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await page.evaluate(`(() => ({
      popRole: document.getElementById('pickpop').getAttribute('role'),
      rows: [...document.querySelectorAll('#pickpop .pickrow')].map((row) => ({
        tag: row.tagName, role: row.getAttribute('role'), checked: row.getAttribute('aria-checked'),
        control: row.dataset.control || null,
      })),
    }))()`),
      {
        popRole: 'list',
        rows: statusMenu.items.map(() => ({ tag: 'DIV', role: 'listitem', checked: null, control: null })),
      },
      'read-only server status rows claim controls or checked state',
    );
    assert.deepEqual(failures, [], 'the panel threw while the servers menu was open');
  } finally {
    await browser.close();
  }
});

// A commentary message provides a commentable Activity log row.

const NARRATION_MESSAGE =
  '<p>Reading the two wire files before touching the switch.</p>' + '<ul><li>the chunk drop is one case long</li></ul>';

test('a message that is not a reply takes a comment on its own line', { timeout: 120_000 }, async (t) => {
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
    payload.cards[0].summaryHtml = COMMENTABLE_RESPONSE;
    payload.cards[0].earlierAnswers = [
      {
        summary: 'the panel draws the html, not this',
        summaryHtml: COMMENTABLE_ANSWER,
        at: NOW - 600_000,
        absolute: 'earlier today',
      },
    ];
    payload.cards[0].saidMessages = [
      {
        id: 'commentary:1:0',
        kind: 'commentary',
        text: 'the panel draws the html, not this',
        summaryHtml: NARRATION_MESSAGE,
        at: NOW - 900_000,
        when: '2:20 PM',
        absolute: 'earlier today',
      },
      {
        id: 'answer:1:0',
        kind: 'answer',
        text: 'the panel draws the html, not this',
        summaryHtml: COMMENTABLE_ANSWER,
        at: NOW - 600_000,
        when: '2:31 PM',
        absolute: 'earlier today',
        answerIndex: 0,
      },
    ];
    setLogMessages(payload.cards[0]);
    payload.cards[0].saidName = 'Said while working, 2 messages, 1 reply';
    payload.cards[0].saidMix = '2 messages, 1 reply';
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.waitForFunction(() => document.querySelector('.turn .head') !== null);
    await page.evaluate(`document.querySelector('.turn .head').click()`);
    await page.waitForFunction(() => document.querySelector('.actrow.message:not(.answer) .saidtext p') !== null);

    const offered = (await page.evaluate(`(async () => {
      const target = document.querySelector('.actrow.message:not(.answer) .saidtext p');
      if (!target) return { error: 'the card drew no narration message' };
      const range = document.createRange();
      range.selectNodeContents(target);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      await ${SETTLED};
      const float = document.querySelector('.quotefloat');
      return { shown: !!float && !float.hidden };
    })()`)) as { error?: string; shown?: boolean };
    assert.equal(offered.error, undefined, offered.error || '');
    assert.equal(offered.shown, true, 'a selection inside a message that is not a reply offered no Comment action');

    // Use the shortcut to test its independent selection read.

    await page.keyboard.press('c');
    await page.evaluate(SETTLED);
    assert.equal(
      await page.evaluate(`!!document.querySelector('.quoteslot .notearea')`),
      true,
      'pressing c on a selection inside a message that is not a reply opened no editor',
    );

    const landed = (await page.evaluate(`(async () => {
      const area = document.querySelector('.quoteslot .notearea');
      if (!area) return { error: 'no box open to save' };
      area.value = 'a comment on the narration';
      document.querySelector('.quoteslot .notesave').click();
      await ${SETTLED};
      const marks = (node) => (node ? node.querySelectorAll('.linemark:not(.offlinemark)').length : -1);
      const off = document.querySelector('.offlinemark');
      return {
        narration: marks(document.querySelector('.actrow.message:not(.answer)')),
        response: marks(document.querySelector('.turn .summary')),
        reply: marks(document.querySelector('.actrow.message.answer')),
        stranded: off ? off.textContent : '',
      };
    })()`)) as { error?: string; narration?: number; response?: number; reply?: number; stranded?: string };
    assert.equal(landed.error, undefined, landed.error || '');
    assert.ok((landed.narration ?? 0) >= 1, 'the comment marks no line of the message it was left on');
    assert.equal(landed.response, 0, 'the comment left on a message landed on the final response instead');
    assert.equal(landed.reply, 0, 'the comment left on a message landed on the reply instead');
    assert.equal(
      landed.stranded,
      '',
      `the card ends with "${landed.stranded}" at the top of it, so the comment is about no line`,
    );
    // Change the message ordinal while retaining its kind and timestamp. The saved comment must stay on that message.

    const saved = (await page.evaluate(
      `window.__posted.filter((m) => m.type === 'note' && m.note && m.note.op === 'write').map((m) => m.note.note)`,
    )) as unknown[];
    assert.equal(saved.length, 1, 'the comment never reached the host, so it cannot come back');
    (payload.cards[0].saidMessages as Record<string, unknown>[])[0].id = 'commentary:1:3';
    setLogMessages(payload.cards[0]);
    (payload as Record<string, unknown>).comments = saved;
    await page.evaluate(`(() => {
      getSelection().removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
    })()`);
    await page.evaluate(SETTLED);
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
    const renumbered = (await page.evaluate(`(() => {
      const off = document.querySelector('.offlinemark');
      const row = document.querySelector('.actrow.message:not(.answer)');
      return {
        id: row ? row.dataset.message : 'no message row',
        rows: document.querySelectorAll('.actrow.message').length,
        narration: row ? row.querySelectorAll('.linemark:not(.offlinemark)').length : -1,
        stranded: off ? off.textContent : '',
      };
    })()`)) as { id?: string; rows?: number; narration?: number; stranded?: string };
    assert.equal(
      renumbered.id,
      'commentary:1:3',
      `the card drew ${renumbered.rows} message rows and the first is "${renumbered.id}"`,
    );
    assert.ok(
      (renumbered.narration ?? 0) >= 1,
      'a renumbered message id took the comment off the line the reader wrote it on',
    );
    assert.equal(
      renumbered.stranded,
      '',
      `a renumbered message id stranded the comment as "${renumbered.stranded}" at the top of the card`,
    );
    assert.deepEqual(failures, [], 'the panel threw while a comment was written on a message');
  } finally {
    await browser.close();
  }
});

test(
  'a comment mark on an Activity message sits beside the words and never over them',
  { timeout: 120_000 },
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
      await page.setContent(themed(pageHtml()));

      const payload = renderPayload() as { cards: Record<string, unknown>[]; comments?: unknown[] };
      const card = payload.cards[0];
      // A finished turn opens its Activity log on messages only.
      card.status = 'done';
      card.saidMessages = [
        {
          id: 'commentary:1:0',
          kind: 'commentary',
          text: 'The script exists, so the run reads it first.',
          summaryHtml: '<p>The script exists, so the run reads it first.</p>',
          at: NOW - 900_000,
          when: '2:20 PM',
          absolute: 'earlier today',
        },
      ];
      setLogMessages(card);
      // A run beside the message, so the two views draw different rows.
      (card.activity as Record<string, unknown>[]).unshift({
        kind: 'run',
        id: 'mark-run',
        status: 'done',
        count: 1,
        failed: 0,
        earlier: 0,
        line: '1 tool call',
        code: '',
        figure: '',
        since: null,
        title: '',
        label: '1 tool call',
        mix: '1 run',
        steps: [
          {
            kind: 'step',
            id: 'mark-step',
            status: 'done',
            line: 'Ran',
            code: 'npm test',
            figure: '',
            since: null,
            title: 'npm test',
            name: 'Ran npm test',
          },
        ],
      });
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.waitForFunction(() => document.querySelector('.turn .head') !== null);
      await page.evaluate(`(() => {
      const turn = document.querySelector('.turn');
      if (turn.querySelector('.body').hidden) turn.querySelector('.head').click();
    })()`);
      await page.waitForFunction(() => document.querySelector('.actrow.message .saidtext p') !== null);
      const key = (await page.evaluate(`document.querySelector('.turn').dataset.key`)) as string;
      const response = (await page.evaluate(`document.querySelector('.turn .summary p').textContent`)) as string;
      const note = (id: string, part: string, quote: string) => ({
        id,
        sessionId: key.split(':')[0],
        turnKey: key,
        part,
        quote,
        note: 'A comment.',
        headline: '',
        sessionTitle: '',
        turnAt: 1,
        at: Number(id),
      });
      // Add a response comment to compare the Activity log mark with the response mark column.

      payload.comments = [note('1', 'said:commentary:1:0', 'The script exists'), note('2', 'summary', response)];
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);

      const MEASURE = `(() => {
      const row = document.querySelector('.actrow.message');
      const mark = row && row.querySelector('.linemark:not(.offlinemark)');
      const line = row && row.querySelector('.saidtext p');
      if (!mark || !line) return { error: 'the message row drew no mark or no text' };
      // The words alone. The mark is a child of the line, so a range over the whole line
      // would count the mark's own box as text.
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      const words = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement.closest('.linemark') || !node.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        words.push(...Array.from(range.getClientRects()).filter((r) => r.width > 0));
      }
      const m = mark.getBoundingClientRect();
      const glyph = row.querySelector('.actglyph').getBoundingClientRect();
      const hit = (r) => m.left < r.right - 0.5 && m.right > r.left + 0.5 && m.top < r.bottom - 0.5 && m.bottom > r.top + 0.5;
      const shown = row.closest('.turn').querySelector('.actviewstate');
      const other = Array.from(row.closest('.turn').querySelectorAll('.summary .linemark')).find((one) => !one.closest('.actlist'));
      return {
        view: shown ? shown.textContent : '',
        mark: [m.left, m.right],
        text: words.length ? words[0].left : -1,
        overText: words.some(hit),
        overGlyph: hit(glyph),
        // The message block clips what it holds, so a mark outside its box is not drawn at all.
        inClip: m.left >= row.querySelector('.saidtext').getBoundingClientRect().left - 0.5,
        column: other ? other.getBoundingClientRect().left : null,
      };
    })()`;
      type Measured = {
        error?: string;
        view?: string;
        mark?: number[];
        text?: number;
        overText?: boolean;
        overGlyph?: boolean;
        inClip?: boolean;
        column?: number | null;
      };
      for (const view of ['Messages only', 'All activity']) {
        if (view === 'All activity') {
          await page.evaluate(`document.querySelector('.turn .actviewaction').click()`);
          await page.evaluate(SETTLED);
        }
        const measured = (await page.evaluate(MEASURE)) as Measured;
        assert.equal(measured.error, undefined, measured.error || '');
        assert.equal(measured.view, view, `the log shows "${measured.view}" where "${view}" was measured`);
        assert.equal(
          measured.overText,
          false,
          `in the "${measured.view}" view the mark runs from ${measured.mark} over words starting at ${measured.text}`,
        );
        assert.equal(
          measured.overGlyph,
          false,
          `in the "${measured.view}" view the mark covers the message bubble at the start of the row`,
        );
        assert.equal(
          measured.inClip,
          true,
          `in the "${measured.view}" view the mark hangs outside the message block, which clips it away`,
        );
        assert.ok(
          measured.column !== null && Math.abs((measured.mark?.[0] ?? 0) - (measured.column ?? 0)) < 1,
          `in the "${measured.view}" view the mark starts at ${measured.mark?.[0]}, not in the column at ${measured.column} where the response mark hangs`,
        );
      }
      assert.deepEqual(failures, [], 'the panel threw while a comment marked an Activity message');
    } finally {
      await browser.close();
    }
  },
);

// Add enough preceding content to scroll the card heading above the commented response.

const FILLER = Array.from(
  { length: 30 },
  (_, n) => `<p>Line ${n + 1} of the work that came before the response.</p>`,
).join('');

// Scroll the first mark into view, then count removed marks and prompt-box mutations.

const WATCH = `(() => {
  const mark = document.querySelector('.turn .linemark');
  document.scrollingElement.scrollTop += mark.getBoundingClientRect().top - 260;
  window.__posted.length = 0;
  window.__pulled = 0;
  new MutationObserver((records) => {
    for (const record of records) {
      for (const gone of record.removedNodes) {
        if (gone.classList && gone.classList.contains('linemark')) { window.__pulled += 1; }
      }
    }
  }).observe(document.getElementById('list'), { childList: true, subtree: true });
  window.__composer = [];
  new MutationObserver((records) => { window.__composer.push(...records); }).observe(document.getElementById('composer'), {
    childList: true, subtree: true, characterData: true, attributes: true, attributeOldValue: true, characterDataOldValue: true,
  });
})()`;

// Count prompt-box changes that alter values. Rewriting an unchanged attribute does not change presentation.

const COMPOSER_CHANGES = `(() => {
  const first = new Map();
  const changes = [];
  const name = (node) => (typeof node.className === 'string' && node.className) || node.nodeName;
  for (const record of window.__composer) {
    if (record.type === 'childList') { changes.push(name(record.target) + ' replaced its contents'); continue; }
    if (record.type === 'characterData') {
      if (record.oldValue !== record.target.data) { changes.push(name(record.target.parentNode) + ' text changed'); }
      continue;
    }
    const seen = first.get(record.target) || new Map();
    if (!seen.has(record.attributeName)) { seen.set(record.attributeName, record.oldValue); }
    first.set(record.target, seen);
  }
  for (const [target, seen] of first) {
    for (const [attribute, old] of seen) {
      const now = target.getAttribute(attribute);
      if (now !== old) { changes.push(name(target) + ' ' + attribute + ' went from ' + old + ' to ' + now); }
    }
  }
  window.__composer = [];
  return changes;
})()`;

interface Reading {
  scrollTop: number;
  marks: number;
  pulled: number;
  deleted: string[];
  written: Array<{ id: string; note: string }>;
  focus: string;
  focusControl: string;
  focusLine: string;
  focusOnScreen: boolean;
  listOpen: boolean;
  rows: string[];
  expanded: number;
  floatNearMark: boolean;
  card: string;
}

const READING = `(() => {
  const active = document.activeElement;
  const box = active.getBoundingClientRect();
  const float = document.querySelector('.markfloat');
  const composer = document.getElementById('composer').getBoundingClientRect();
  const expanded = [...document.querySelectorAll('.linemark[aria-expanded="true"]')];
  const near = (() => {
    if (!float || float.hidden || expanded.length !== 1) return false;
    const list = float.getBoundingClientRect();
    const mark = expanded[0].getBoundingClientRect();
    return Math.min(Math.abs(list.bottom - mark.top), Math.abs(list.top - mark.bottom)) < 12;
  })();
  const line = active.closest('p, td');
  return {
    scrollTop: document.scrollingElement.scrollTop,
    marks: document.querySelectorAll('.turn .linemark').length,
    pulled: window.__pulled,
    deleted: window.__posted.filter((m) => m.type === 'note' && m.note.op === 'delete').map((m) => m.note.id),
    written: window.__posted.filter((m) => m.type === 'note' && m.note.op === 'write')
      .map((m) => ({ id: m.note.note.id, note: m.note.note.note })),
    focus: active === document.body ? 'body' : active.className,
    focusControl: (active.dataset && active.dataset.control) || '',
    focusLine: line ? line.textContent : '',
    focusOnScreen: active !== document.body && active.isConnected && box.top >= 0 && box.bottom <= composer.top,
    listOpen: !!float && !float.hidden,
    rows: float && !float.hidden ? [...float.querySelectorAll('.notetext')].map((row) => row.textContent) : [],
    expanded: expanded.length,
    floatNearMark: near,
    card: document.querySelector('.turn .summary').textContent,
  };
})()`;

// Simulate comment, usage, and session-list replies in this order.

const hostAnswer = (comments: unknown[]): string => {
  const payload = renderPayload();
  const rail = {
    type: 'rail',
    rail: payload.rail,
    labels: payload.labels,
    views: payload.views,
    railFilters: payload.railFilters,
    stats: payload.stats,
  };
  return `(() => {
    window.postMessage(${JSON.stringify({ type: 'notes', comments })}, '*');
    window.postMessage(${JSON.stringify({ type: 'usage', usage: payload.usage })}, '*');
    window.postMessage(${JSON.stringify(rail)}, '*');
  })()`;
};

async function longCommentedPage(
  browser: NonNullable<Awaited<ReturnType<typeof browserOrNone>>>,
  quotes: string[],
  height = 520,
) {
  const page = await browser.newPage();
  const failures: string[] = [];
  page.on('pageerror', (e) => failures.push(String(e)));
  await page.setViewportSize({ width: 700, height });
  await page.setContent(themed(pageHtml()));
  const comments = await tintedCard(page, quotes, FILLER);
  await page.evaluate(WATCH);
  await page.evaluate(SETTLED);
  const start = (await page.evaluate(READING)) as Reading;
  assert.ok(
    start.scrollTop > 600,
    `the panel scrolled to ${start.scrollTop}, so the commented lines are not far down a long panel`,
  );
  return { page, failures, comments, start };
}

const LINE_MARKS = '.turn .summary p .linemark';

test(
  'deleting a comment takes the first press, keeps the reader place, and draws the card once',
  { timeout: 120_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
      return;
    }
    try {
      // Open the comment list by press, focus, and hover. Pressing a list control moves focus away from its mark.

      for (const opening of ['press', 'focus', 'hover'] as const) {
        const { page, failures, comments, start } = await longCommentedPage(browser, [OUTER, INNER, WIDE]);
        assert.equal(start.marks, 2, 'the card did not draw one mark for each of the two commented lines');
        const mark = page.locator(LINE_MARKS).first();
        if (opening === 'press') {
          await mark.click();
        } else if (opening === 'focus') {
          await mark.focus();
        } else {
          await mark.hover();
        }
        await page.evaluate(SETTLED);
        await page.locator('.markfloat [data-control="notedel:n1"]').click();
        await page.evaluate(SETTLED);
        await page.evaluate(hostAnswer(comments.slice(1)));
        await page.evaluate(SETTLED);
        const after = (await page.evaluate(READING)) as Reading;
        assert.deepEqual(
          after.deleted,
          ['n1'],
          `with the list opened by ${opening}, one press on Delete sent deletes for ${JSON.stringify(after.deleted)}`,
        );
        assert.equal(
          after.scrollTop,
          start.scrollTop,
          `with the list opened by ${opening}, the delete scrolled the panel from ${start.scrollTop} to ${after.scrollTop}`,
        );
        assert.equal(
          after.pulled,
          start.marks,
          `with the list opened by ${opening}, the delete and the three messages the extension sends back took ` +
            `${after.pulled} marks off a card that carried ${start.marks}. One redraw of the card takes ${start.marks}.`,
        );
        assert.deepEqual(
          await page.evaluate(COMPOSER_CHANGES),
          [],
          `with the list opened by ${opening}, the delete changed the composer`,
        );
        assert.equal(
          after.focus,
          'linemark',
          `after the delete the keyboard is on "${after.focus}", not on the line mark`,
        );
        assert.ok(
          after.focusLine.includes(INNER),
          'the keyboard went to a mark on another line, though a comment is still on the line of the deleted one',
        );
        assert.equal(after.focusOnScreen, true, 'the keyboard went to a control the reader cannot see');
        assert.equal(after.listOpen, false, 'the list opened again when the keyboard came back to the mark');

        if (opening === 'press') {
          // Delete the last comment on a line using the keyboard. Focus must move to the nearest remaining mark.

          await page.keyboard.press('Enter');
          await page.evaluate(SETTLED);
          assert.equal(
            (await page.evaluate<Reading>(READING)).focusControl,
            'noteedit:n2',
            'Enter on the mark did not put the keyboard on the first control of its list',
          );
          await page.keyboard.press('Tab');
          await page.keyboard.press('Enter');
          await page.evaluate(SETTLED);
          await page.evaluate(hostAnswer(comments.slice(2)));
          await page.evaluate(SETTLED);
          const last = (await page.evaluate(READING)) as Reading;
          assert.deepEqual(
            last.deleted,
            ['n1', 'n2'],
            `the keyboard delete sent deletes for ${JSON.stringify(last.deleted)}`,
          );
          assert.equal(
            last.scrollTop,
            start.scrollTop,
            `the keyboard delete scrolled the panel from ${start.scrollTop} to ${last.scrollTop}`,
          );
          assert.equal(
            last.pulled - after.pulled,
            after.marks,
            `the second delete took ${last.pulled - after.pulled} marks off a card that carried ${after.marks}`,
          );
          assert.equal(last.focus, 'linemark', `after the last delete on a line the keyboard is on "${last.focus}"`);
          assert.ok(last.focusLine.includes(WIDE), 'the keyboard did not go to the mark on the nearest commented line');
          assert.equal(last.focusOnScreen, true, 'the keyboard went to a control the reader cannot see');
          assert.deepEqual(await page.evaluate(COMPOSER_CHANGES), [], 'the keyboard delete changed the composer');
        }
        assert.deepEqual(failures, [], 'the panel threw while a comment was deleted');
        await page.close();
      }
    } finally {
      await browser.close();
    }
  },
);

test('saving, cancelling and adding a comment keep the reader place', { timeout: 120_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const { page, failures, comments, start } = await longCommentedPage(browser, [OUTER, WIDE]);

    await page.locator(LINE_MARKS).first().click();
    await page.locator('.markfloat [data-control="noteedit:n1"]').click();
    await page.locator('.markfloat .notearea').fill('an edited comment');
    await page.locator('.markfloat .notearea').press('Enter');
    await page.evaluate(SETTLED);
    await page.evaluate(hostAnswer([{ ...comments[0], note: 'an edited comment' }, comments[1]]));
    await page.evaluate(SETTLED);
    const saved = (await page.evaluate(READING)) as Reading;
    assert.deepEqual(saved.written, [{ id: 'n1', note: 'an edited comment' }], 'Save did not send the edited comment');
    assert.equal(
      saved.scrollTop,
      start.scrollTop,
      `Save scrolled the panel from ${start.scrollTop} to ${saved.scrollTop}`,
    );
    assert.equal(saved.focus, 'linemark', `after Save the keyboard is on "${saved.focus}", not on the line mark`);
    assert.ok(saved.focusLine.includes(OUTER), 'after Save the keyboard went to a mark on another line');
    assert.equal(saved.listOpen, false, 'the list stayed open after Save');
    assert.deepEqual(await page.evaluate(COMPOSER_CHANGES), [], 'Save changed the composer');

    await page.keyboard.press('Enter');
    await page.evaluate(SETTLED);
    assert.deepEqual(
      (await page.evaluate<Reading>(READING)).rows,
      ['an edited comment'],
      'the list the mark opens does not show the edited words',
    );
    await page.locator('.markfloat [data-control="noteedit:n1"]').click();
    await page.locator('.markfloat .notearea').press('Escape');
    await page.evaluate(SETTLED);
    const cancelled = (await page.evaluate(READING)) as Reading;
    assert.equal(
      cancelled.scrollTop,
      start.scrollTop,
      `Cancel scrolled the panel from ${start.scrollTop} to ${cancelled.scrollTop}`,
    );
    assert.equal(
      cancelled.focus,
      'linemark',
      `after Cancel the keyboard is on "${cancelled.focus}", not on the line mark`,
    );
    assert.equal(cancelled.listOpen, false, 'the list stayed open after Cancel');

    const selected = (await page.evaluate(`(() => {
      const line = [...document.querySelectorAll('.turn .summary p')].find((p) => p.textContent.includes('One question'));
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && !node.data.includes('One question')) node = walker.nextNode();
      if (!node) return 'the second line holds no text to select';
      const range = document.createRange();
      range.setStart(node, node.data.indexOf('One question'));
      range.setEnd(node, node.data.indexOf('One question') + 'One question'.length);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return '';
    })()`)) as string;
    assert.equal(selected, '', selected);
    await page.evaluate(SETTLED);
    await page.keyboard.press('c');
    await page.locator('.quoteslot .notearea').fill('a new comment');
    await page.locator('.quoteslot .notearea').press('Enter');
    await page.evaluate(SETTLED);
    const wrote = (await page.evaluate(READING)) as Reading;
    assert.deepEqual(
      wrote.written.map((note) => note.note),
      ['an edited comment', 'a new comment'],
      'the new comment was not sent',
    );
    assert.equal(
      wrote.scrollTop,
      start.scrollTop,
      `adding a comment scrolled the panel from ${start.scrollTop} to ${wrote.scrollTop}`,
    );
    assert.deepEqual(failures, [], 'the panel threw while a comment was edited or added');
  } finally {
    await browser.close();
  }
});

test(
  'a list the reader holds follows its card through a redraw and shuts when another session opens',
  { timeout: 120_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
      return;
    }
    try {
      const { page, failures, comments } = await longCommentedPage(browser, [OUTER, WIDE]);
      const drawn = (extra: string) => {
        const payload = renderPayload() as { cards: Record<string, unknown>[]; comments: unknown[] };
        payload.cards[0].summaryHtml = FILLER + TINTED_RESPONSE + extra;
        payload.comments = comments;
        return payload;
      };

      // Update response content while the pointer remains down on Delete.
      await page.locator(LINE_MARKS).first().click();
      await page.evaluate(SETTLED);
      await page.locator('.markfloat [data-control="notedel:n1"]').hover();
      await page.mouse.down();
      await page.evaluate(`window.postMessage(${JSON.stringify(drawn('<p>One more line the agent wrote.</p>'))}, '*')`);
      await page.evaluate(SETTLED);
      const pressed = (await page.evaluate(`(() => ({
      control: !!document.querySelector('.markfloat [data-control="notedel:n1"]'),
      grown: document.querySelector('.turn .summary').textContent.includes('One more line'),
    }))()`)) as { control: boolean; grown: boolean };
      assert.equal(pressed.control, true, 'a redraw took Delete away while the pointer was down on it');
      assert.equal(pressed.grown, false, 'the card was drawn again under a press inside its list');
      await page.mouse.up();
      await page.evaluate(SETTLED);
      const released = (await page.evaluate(READING)) as Reading;
      assert.deepEqual(released.deleted, ['n1'], 'the first press on Delete did not delete the comment');
      assert.ok(
        released.card.includes('One more line'),
        'the card did not draw the line the agent wrote once the press ended',
      );

      // An idle pinned list reopens on its replacement mark after a card update and retains its focused control.

      await page.locator(LINE_MARKS).first().click();
      await page.evaluate(SETTLED);
      assert.equal(
        (await page.evaluate<Reading>(READING)).focusControl,
        'noteedit:n2',
        'the press did not put the keyboard in the list',
      );
      await page.evaluate(
        `window.postMessage(${JSON.stringify(drawn('<p>One more line the agent wrote.</p><p>And a second one.</p>'))}, '*')`,
      );
      await page.evaluate(SETTLED);
      const followed = (await page.evaluate(READING)) as Reading;
      assert.ok(
        followed.card.includes('And a second one'),
        'an open list froze its card, so the agent output stopped drawing',
      );
      assert.equal(followed.listOpen, true, 'the redraw shut the list the reader pressed open');
      assert.equal(followed.expanded, 1, `${followed.expanded} marks on the page say their list is open`);
      assert.equal(followed.floatNearMark, true, 'the list is not drawn at the mark it belongs to');
      assert.equal(
        followed.focusControl,
        'noteedit:n2',
        `after the redraw the keyboard is on "${followed.focusControl}"`,
      );

      // Ending a native drag must release the held card update without requiring mouseup.
      await page.locator('.markfloat .notetext').first().hover();
      await page.mouse.down();
      await page.evaluate(`document.dispatchEvent(new DragEvent('dragend', { bubbles: true }))`);
      await page.evaluate(
        `window.postMessage(${JSON.stringify(drawn('<p>One more line the agent wrote.</p><p>And a second one.</p><p>And a dragged one.</p>'))}, '*')`,
      );
      await page.evaluate(SETTLED);
      const dragged = (await page.evaluate(READING)) as Reading;
      await page.mouse.up();
      await page.evaluate(SETTLED);
      assert.ok(
        dragged.card.includes('And a dragged one'),
        'a press that ended in a drag kept holding its card, so the agent output stopped drawing',
      );

      // Selecting another session closes the previous session comment list.
      const other = renderPayload() as {
        cards: Array<Record<string, unknown>>;
        showing: string;
        sessions: Array<Record<string, unknown>>;
      };
      other.cards = other.cards.map((card) => ({
        ...card,
        key: String(card.key).replace(/^s1:/, 's2:'),
        sessionId: 's2',
      }));
      other.sessions = other.sessions.map((session) => ({ ...session, shown: session.id === 's2' }));
      other.showing = 's2';
      // Hold a card update with selected text. Switching sessions must cancel that deferred update.

      await page.evaluate(`(() => {
      const line = [...document.querySelectorAll('.turn .summary p')].find((p) => p.textContent.includes('Line 29 of'));
      const range = document.createRange();
      range.setStart(line.firstChild, 0);
      range.setEnd(line.firstChild, 'Line 29'.length);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    })()`);
      await page.evaluate(SETTLED);
      await page.evaluate(
        `window.postMessage(${JSON.stringify(drawn('<p>One more line the agent wrote.</p><p>And a second one.</p><p>And a third.</p>'))}, '*')`,
      );
      await page.evaluate(SETTLED);
      const heldBack = (await page.evaluate(READING)) as Reading;
      assert.ok(
        !heldBack.card.includes('And a third'),
        'the selected words did not hold back the redraw of their card',
      );
      assert.equal(heldBack.listOpen, true, 'the list shut before the reader opened another session');
      await page.evaluate(`window.postMessage(${JSON.stringify(other)}, '*')`);
      await page.evaluate(SETTLED);
      await page.evaluate(hostAnswer(comments.slice(1)));
      await page.evaluate(SETTLED);
      const away = (await page.evaluate(`(() => {
      const float = document.querySelector('.markfloat');
      const active = document.activeElement;
      return {
        key: document.querySelector('.turn').dataset.key,
        open: !!float && !float.hidden,
        inList: !!float && float.contains(active),
        connected: active.isConnected,
      };
    })()`)) as { key: string; open: boolean; inList: boolean; connected: boolean };
      assert.ok(away.key.startsWith('s2:'), `the panel drew card ${away.key}, not the session the reader opened`);
      assert.equal(
        away.open,
        false,
        'the list of a card in the session the reader left stayed open over the new session',
      );
      assert.equal(away.inList, false, 'the keyboard stayed in a list whose card is gone');
      assert.equal(away.connected, true, 'the keyboard is on a control that is no longer on the page');
      assert.deepEqual(failures, [], 'the panel threw while a held list was redrawn');
    } finally {
      await browser.close();
    }
  },
);

test(
  'a sweep an edit held runs when the list shuts, and the keyboard and a second press find the new marks',
  { timeout: 120_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
      return;
    }
    try {
      // Use enough panel height to keep the table-row mark visible beside the open editor.
      const { page, failures, comments, start } = await longCommentedPage(browser, [OUTER, WIDE], 900);
      const withNote = (id: string, quote: string) => ({
        ...comments[0],
        id,
        quote,
        note: `a comment on ${quote}`,
        at: 9,
      });

      // Add a comment elsewhere while editing, then close the editor with Escape.
      await page.locator(LINE_MARKS).first().click();
      await page.locator('.markfloat [data-control="noteedit:n1"]').click();
      await page.evaluate(SETTLED);
      const table = withNote('n4', 'the loop is a table walk now');
      await page.evaluate(
        `window.postMessage(${JSON.stringify({ type: 'notes', comments: comments.concat(table) })}, '*')`,
      );
      await page.evaluate(SETTLED);
      const writing = (await page.evaluate(`(() => ({
      box: !!document.querySelector('.markfloat .notearea'),
      marks: document.querySelectorAll('.turn .linemark').length,
    }))()`)) as { box: boolean; marks: number };
      assert.equal(writing.box, true, 'the new comment took away the box the reader was writing in');
      assert.equal(
        writing.marks,
        2,
        `the card carries ${writing.marks} marks, so it was swept while the reader was writing in its list`,
      );
      await page.locator('.markfloat .notearea').press('Escape');
      await page.evaluate(SETTLED);
      const shut = (await page.evaluate(READING)) as Reading;
      assert.equal(
        shut.marks,
        3,
        `the card carries ${shut.marks} marks once the box shut, not the 3 its comments need`,
      );
      assert.equal(shut.focus, 'linemark', `after Escape the keyboard is on "${shut.focus}", not on the line mark`);
      assert.ok(shut.focusLine.includes(OUTER), 'after Escape the keyboard went to a mark on another line');
      assert.equal(shut.focusOnScreen, true, 'after Escape the keyboard is on a control the reader cannot see');
      assert.equal(shut.listOpen, false, 'Escape left the list open');
      assert.equal(
        shut.scrollTop,
        start.scrollTop,
        `Escape scrolled the panel from ${start.scrollTop} to ${shut.scrollTop}`,
      );

      // Press another line mark while the editor holds a deferred mark redraw.
      await page.locator(LINE_MARKS).first().click();
      await page.locator('.markfloat [data-control="noteedit:n1"]').click();
      await page.evaluate(SETTLED);
      const retry = withNote('n5', 'Moved the retry logic');
      await page.evaluate(
        `window.postMessage(${JSON.stringify({ type: 'notes', comments: comments.concat(table, retry) })}, '*')`,
      );
      await page.evaluate(SETTLED);
      await page.locator('.turn .summary td .linemark').click();
      await page.evaluate(SETTLED);
      const second = (await page.evaluate(READING)) as Reading;
      assert.equal(second.listOpen, true, 'the press on the second mark opened nothing');
      assert.deepEqual(second.rows, [table.note], `the list shows ${JSON.stringify(second.rows)}`);
      assert.equal(second.expanded, 1, `${second.expanded} marks on the page say their list is open`);
      assert.equal(second.floatNearMark, true, 'the list is not drawn at the mark that opened it');

      // Select card text during a held list press. The deferred mark redraw must wait until the selection ends.

      await page.locator('.markfloat .notetext').first().hover();
      await page.mouse.down();
      const late = withNote('n6', 'Line 29 of the work');
      await page.evaluate(
        `window.postMessage(${JSON.stringify({ type: 'notes', comments: comments.concat(table, retry, late) })}, '*')`,
      );
      await page.evaluate(SETTLED);
      const SELECTED = `(() => {
      const line = [...document.querySelectorAll('.turn .summary p')].find((p) => p.textContent.includes('Line 28 of'));
      const text = line.firstChild;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 'Line 28'.length);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    })()`;
      await page.evaluate(SELECTED);
      const marksBefore = (await page.evaluate<Reading>(READING)).marks;
      await page.mouse.up();
      await page.evaluate(SETTLED);
      const selecting = (await page.evaluate(`({
      text: getSelection().toString(),
      collapsed: getSelection().isCollapsed,
      marks: document.querySelectorAll('.turn .linemark').length,
    })`)) as { text: string; collapsed: boolean; marks: number };
      assert.equal(selecting.text, 'Line 28', `the selection reads "${selecting.text}" once the press ended`);
      assert.equal(selecting.marks, marksBefore, 'the held sweep ran under a live selection in its card');
      await page.evaluate(
        `(() => { getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); })()`,
      );
      await page.evaluate(SETTLED);
      assert.equal(
        (await page.evaluate<Reading>(READING)).marks,
        marksBefore + 1,
        'the held sweep did not run once the selection was gone',
      );

      // Move between marks while an open comment editor defers mark redraw. Closing the first list replaces the next mark.

      await page.evaluate(`document.dispatchEvent(new Event('scroll'))`);
      await page.evaluate(`(() => {
      const line = [...document.querySelectorAll('.turn .summary p')].find((p) => p.textContent.includes('Line 1 of'));
      const range = document.createRange();
      range.setStart(line.firstChild, 0);
      range.setEnd(line.firstChild, 'Line 1'.length);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    })()`);
      await page.evaluate(SETTLED);
      await page.keyboard.press('c');
      await page.evaluate(SETTLED);
      assert.equal(
        await page.evaluate(`!!document.querySelector('.quoteslot .notearea')`),
        true,
        'the key opened no comment box',
      );
      // Clear native selection after the editor preserves its quote highlight. Otherwise, the selection still defers mark redraw.

      await page.evaluate(
        `(() => { getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); })()`,
      );
      await page.evaluate(SETTLED);
      await page.locator(LINE_MARKS).first().hover();
      await page.evaluate(SETTLED);
      const wide = withNote('n7', 'Line 30 of the work');
      await page.evaluate(
        `window.postMessage(${JSON.stringify({ type: 'notes', comments: comments.concat(table, retry, late, wide) })}, '*')`,
      );
      await page.evaluate(SETTLED);
      // Read in the pointer-event task to detect incorrect list placement before a later pointer move repairs it.

      const hovered = (await page.evaluate(`(() => {
      document.querySelector('.turn .summary td .linemark').dispatchEvent(new MouseEvent('mouseenter'));
      return ${READING};
    })()`)) as Reading;
      assert.equal(hovered.listOpen, true, 'the pointer on the second mark opened nothing');
      assert.deepEqual(hovered.rows, [table.note], `the list shows ${JSON.stringify(hovered.rows)}`);
      assert.equal(hovered.expanded, 1, `${hovered.expanded} marks on the page say their list is open`);
      assert.equal(hovered.floatNearMark, true, 'the list is not drawn at the mark the pointer is on');
      assert.deepEqual(failures, [], 'the panel threw while a held sweep ran');
    } finally {
      await browser.close();
    }
  },
);

test('a comment whose words stream into a line already drawn moves onto that line', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(themed(pageHtml()));
    const quote = 'The retry now waits for the poll';
    const comments = await tintedCard(page, [quote]);
    const MARKS = `(() => ({
      offline: document.querySelectorAll('.turn .offlinemark').length,
      first: document.querySelector('.turn .summary p').querySelectorAll('.linemark').length,
    }))()`;
    const before = (await page.evaluate(MARKS)) as { offline: number; first: number };
    assert.equal(before.offline, 1, 'a comment whose words no line holds did not draw at the top of the card');
    // Update the first response line to include the saved quote.
    const payload = renderPayload() as { cards: Record<string, unknown>[]; comments: unknown[] };
    payload.cards[0].summaryHtml = TINTED_RESPONSE.replace('</p>', ` ${quote}.</p>`);
    payload.comments = comments;
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
    const after = (await page.evaluate(MARKS)) as { offline: number; first: number };
    assert.equal(after.offline, 0, 'the comment stayed at the top of the card after its words reached a line');
    assert.equal(after.first, 1, 'the line that now holds the quoted words carries no mark');
  } finally {
    await browser.close();
  }
});
