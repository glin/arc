// Browser layout checks for the session heading and next-turn starting price.
// Shared measurement helpers live in `../test/layout.ts`.

import { test } from 'vitest';
import assert from 'node:assert';
import { browserOrNone, pauseClock, SETTLED } from '../test/browser.ts';
import { CARD_ACTIONS } from './turnview.ts';
import { formatCacheSpan } from './view/time.ts';
import { composerView, pickMenu } from './composerview.ts';
import { CONSERVATIVE_CACHE_BOUNDARY_MS } from './pricing.ts';
import {
  DRAFT_COMPOSER,
  FIXTURE_CLOCK,
  nextTurnPayload,
  pageHtml,
  renderPayload,
  statPopoverPayload,
  themed,
} from './panelfixture.ts';
import {
  layoutAt,
  axName,
  Measured,
  PICKER_ROW,
  Placed,
  PickerRow,
  draftLayoutAt,
  OPEN_AGENT,
  AGENT_MENU,
  NEXT_TURN,
} from '../test/layout.ts';

test('a draft draws its tag over four enabled pickers and no window figure', { timeout: 60_000 }, async (t) => {
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

    // Use the prompt box state builder for the expected tag and controls.

    const view = composerView(DRAFT_COMPOSER, FIXTURE_CLOCK);
    assert.ok(view, 'the reducer drew no composer for the draft, so there is nothing to measure');
    const tag = view.draftTag;
    assert.ok(tag, 'the reducer built no tag for the draft, so this measures nothing');
    // The draft fixture carries source-session context. The draft must omit that figure.

    assert.ok(DRAFT_COMPOSER.context, 'the draft fixture carries no window figure, so the guard below proves nothing');

    for (const width of [1350, 340]) {
      await draftLayoutAt(page, width);
      const at = (await page.evaluate(PICKER_ROW)) as PickerRow;
      const where = `at ${width}px`;
      assert.deepEqual(failures, [], `the panel threw while drawing the draft composer ${where}`);

      // The draft tag shows one word and exposes the setup in its tooltip.

      assert.ok(at.tag, `the draft tag is not on the page ${where}`);
      assert.deepEqual(
        at.tagWords,
        [tag.word],
        `the tag reads ${JSON.stringify(at.tagWords)} ${where} for the ` +
          `${JSON.stringify([tag.word])} the reducer wrote`,
      );
      assert.equal(
        at.tagDetail,
        tag.detail,
        `the tag hover reads "${at.tagDetail}" ${where} and the reducer wrote "${tag.detail}"`,
      );
      assert.ok(at.prompt, `the box is not drawn ${where}`);
      assert.ok(
        at.tag.bottom <= at.prompt.top + 1,
        `the tag ends at ${Math.round(at.tag.bottom)} ${where} with the box starting at ` +
          `${Math.round(at.prompt.top)}, so one is drawn over the other`,
      );

      // A draft exposes four enabled setup controls in this order.

      assert.deepEqual(
        at.picks.map((p) => p.control),
        ['agent', 'model', 'effort', 'askmode'],
        `the draft row drew ${JSON.stringify(at.picks.map((p) => p.control))} ${where}`,
      );
      assert.deepEqual(
        at.picks.filter((p) => p.disabled).map((p) => p.control),
        [],
        `the draft row drew an unpressable control ${where}`,
      );

      // The draft has no context window of its own.

      assert.equal(
        at.figure,
        null,
        `the draft drew a window figure ${where}, and the setup it copied is what filled that window`,
      );

      // Check the prompt box and its controls at editor-tab and sidebar widths.

      assert.ok(
        at.documentWidth <= at.viewportWidth + 1,
        `the panel scrolls sideways ${where} with the draft composer on it: ` +
          `${at.documentWidth} wide in a ${at.viewportWidth} viewport`,
      );
      const inside: [string, Placed | null][] = [
        ['the tag', at.tag],
        ['the tag chip', at.tagChip],
        ['the picker row', at.row],
        ['the box', at.prompt],
        ['the send', at.send],
        ...at.picks.map((p) => [`the ${p.control} control`, p] as [string, Placed]),
      ];
      for (const [what, node] of inside) {
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
          node.top >= at.composer.top - 1 && node.bottom <= at.composer.bottom + 1,
          `${what} runs from ${Math.round(node.top)} to ${Math.round(node.bottom)} ${where}, ` +
            'outside the composer that holds it',
        );
      }
      assert.ok(
        at.composer.bottom <= at.viewportHeight + 1,
        `the composer ends at ${Math.round(at.composer.bottom)} ${where} in a ${at.viewportHeight} viewport, ` +
          'so the draft has pushed its own foot off the panel',
      );
    }

    // The agent picker is available only on drafts.

    const agents = pickMenu('agent', DRAFT_COMPOSER);
    assert.ok(agents, 'the reducer built no agent menu for the draft, so there is nothing to open');
    assert.equal(
      agents.items.length,
      2,
      `the agent menu offers ${agents.items.length} rows, and this guard is about the reader having a choice`,
    );
    await draftLayoutAt(page, 1350);
    assert.ok(await page.evaluate(OPEN_AGENT), 'the draft composer drew no agent control');
    await page.evaluate(SETTLED);
    const menu = (await page.evaluate(AGENT_MENU)) as { hidden: boolean; rows: string[] };
    assert.equal(menu.hidden, false, 'the agent control was pressed and no menu opened');
    assert.deepEqual(
      menu.rows,
      agents.items.map((item) => `agent:${item.value}`),
      `the agent menu drew ${JSON.stringify(menu.rows)} for the rows the reducer built`,
    );
    assert.deepEqual(failures, [], 'the panel threw while the draft agent menu was open');
  } finally {
    await browser.close();
  }
});

test(
  'a press on the session heading opens every turn, and never leaves the heading over nothing',
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
      const fullTitle = 'A complete session name that belongs in the session-heading hint';
      const payload = renderPayload() as { sessions: Array<Record<string, unknown>> };
      payload.sessions[0].fullLabel = fullTitle;

      // Measure visible turn bodies as well as their open state. A zero-height body remains unreadable.

      const READING = `(() => {
      const head = document.querySelector('#list .session');
      const group = document.querySelector('#list .group');
      const bodies = [...group.querySelectorAll(':scope > .turn > .body, :scope > .compaction > .body')];
      return {
        twist: head.querySelector('.twist').textContent,
        hint: head.dataset.hint,
        hintDetail: head.dataset.hintDetail,
        nativeTitle: head.getAttribute('title'),
        label: head.getAttribute('aria-label'),
        expanded: head.getAttribute('aria-expanded'),
        controls: head.getAttribute('aria-controls'),
        groupId: group.id,
        headHeight: head.getBoundingClientRect().height,
        groupHeight: group.getBoundingClientRect().height,
        cards: group.querySelectorAll(':scope > .turn, :scope > .compaction').length,
        turns: group.querySelectorAll(':scope > .turn').length,
        bodies: bodies.length,
        shown: bodies.filter((b) => b.getBoundingClientRect().height > 0).length,
        read: group.querySelectorAll(':scope > .turn.is-read, :scope > .compaction.is-read').length,
        markable: group.querySelectorAll(':scope > .turn:not(.running)').length,
        statMetrics: [...document.querySelectorAll('#list .sessionstats .statchip')]
          .map((node) => node.dataset.metric),
        turnsChipText: document.querySelector('#list .sessionstats [data-metric="turns"]')?.textContent ?? null,
      };
    })()`;
      const pressHeading = `(() => { document.querySelector('#list .session').click(); })()`;
      interface Reading {
        twist: string;
        hint: string;
        hintDetail: string;
        nativeTitle: string | null;
        label: string;
        expanded: string | null;
        controls: string | null;
        groupId: string;
        headHeight: number;
        groupHeight: number;
        cards: number;
        turns: number;
        bodies: number;
        shown: number;
        read: number;
        markable: number;
        statMetrics: string[];
        turnsChipText: string | null;
      }

      for (const width of [1350, 340]) {
        await layoutAt(page, width);
        await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
        await page.evaluate(SETTLED);
        const shut = (await page.evaluate(READING)) as Reading;
        assert.ok(shut.cards > 1, `the session drew ${shut.cards} cards at ${width}px, so this measures nothing`);
        assert.equal(
          shut.turnsChipText,
          '8 turns',
          `the turns chip shows "${shut.turnsChipText}" instead of the whole session's count at ${width}px`,
        );
        assert.deepEqual(
          shut.statMetrics.slice(0, 2),
          ['cost', 'turns'],
          `the session heading does not match the rail's cost-then-turns order at ${width}px: ${JSON.stringify(shut.statMetrics)}`,
        );
        assert.ok(
          !/\d+\s+turns?\b/i.test(shut.label),
          `the heading name still says a turn count at ${width}px: "${shut.label}"`,
        );
        assert.equal(shut.shown, 0, `a turn is drawn open before anything was pressed at ${width}px`);
        if (width === 1350) {
          assert.equal(shut.read, 0, `a turn is marked read before anything was opened at ${width}px`);
        }
        assert.equal(
          shut.nativeTitle,
          null,
          `the session heading press still carries a native browser title at ${width}px`,
        );
        assert.equal(
          shut.hint,
          fullTitle,
          `the heading hint offers "${shut.hint}" instead of the full session title at ${width}px while every turn under it is shut`,
        );
        assert.ok(
          shut.hintDetail.endsWith(CARD_ACTIONS.expandAllTurns),
          `the heading hint second line offers "${shut.hintDetail}" at ${width}px while every turn under it is shut`,
        );
        await page.locator('#list .session').hover();
        await page.clock.fastForward(350);
        assert.equal(
          await page.locator('#hintpop .hinttitle').textContent(),
          fullTitle,
          `hovering the session heading does not show its full title first at ${width}px`,
        );
        assert.ok(
          ((await page.locator('#hintpop .hintdetail').textContent()) ?? '').endsWith(CARD_ACTIONS.expandAllTurns),
          `hovering the session heading does not show its action second at ${width}px while every turn is shut`,
        );
        // The heading exposes the turn group and its expansion state to screen readers.

        assert.ok(shut.groupId, `the group of turns has no id at ${width}px, so nothing can name it`);
        assert.equal(
          shut.controls,
          shut.groupId,
          `the heading names "${shut.controls}" at ${width}px rather than the turns under it`,
        );
        assert.equal(
          shut.expanded,
          'false',
          `the heading says aria-expanded="${shut.expanded}" at ${width}px while every turn under it is collapsed`,
        );

        await page.evaluate(pressHeading);
        await page.evaluate(SETTLED);
        const open = (await page.evaluate(READING)) as Reading;
        assert.deepEqual(failures, [], 'the panel threw while opening every turn');
        // Opening all turns must make every body visible and increase the group height.

        assert.equal(open.shown, open.bodies, `the press opened ${open.shown} of ${open.bodies} turns at ${width}px`);
        assert.equal(
          open.read,
          open.markable,
          `the group press marked ${open.read} of ${open.markable} eligible cards read at ${width}px`,
        );
        assert.ok(
          open.groupHeight > shut.groupHeight,
          `the turns opened and the session is still ${Math.round(open.groupHeight)}px tall at ${width}px`,
        );
        // The heading and cards remain visible after expansion.

        assert.ok(open.headHeight > 0, `the heading has no height of its own at ${width}px`);
        assert.equal(open.cards, shut.cards, `the press took cards off the list at ${width}px`);
        assert.equal(
          open.hint,
          fullTitle,
          `the heading hint loses the full session title at ${width}px while every turn under it is open`,
        );
        assert.ok(
          open.hintDetail.endsWith(CARD_ACTIONS.collapseAllTurns),
          `the heading hint second line offers "${open.hintDetail}" at ${width}px while every turn under it is open`,
        );
        assert.equal(
          await page.locator('#hintpop').isHidden(),
          false,
          `the open session heading closes its already-open hint at ${width}px`,
        );
        assert.equal(
          await page.locator('#hintpop .hinttitle').textContent(),
          fullTitle,
          `the already-open hint loses the full title at ${width}px after opening every turn`,
        );
        assert.ok(
          ((await page.locator('#hintpop .hintdetail').textContent()) ?? '').endsWith(CARD_ACTIONS.collapseAllTurns),
          `the already-open hint does not update its action at ${width}px after opening every turn`,
        );
        await page.locator('#list .session').hover();
        await page.clock.fastForward(350);
        assert.equal(
          await page.locator('#hintpop .hinttitle').textContent(),
          fullTitle,
          `hovering the open session heading does not show its full title first at ${width}px`,
        );
        assert.ok(
          ((await page.locator('#hintpop .hintdetail').textContent()) ?? '').endsWith(CARD_ACTIONS.collapseAllTurns),
          `hovering the open session heading does not show its action second at ${width}px`,
        );
        assert.equal(
          open.expanded,
          'true',
          `the heading says aria-expanded="${open.expanded}" at ${width}px while every turn under it is expanded`,
        );
        assert.notEqual(open.twist, shut.twist, `the twist is drawn the same way open and shut at ${width}px`);
        assert.ok(
          open.label.endsWith(CARD_ACTIONS.collapseAllTurns),
          `the heading is announced as "${open.label}" at ${width}px, which does not say what the next press does`,
        );

        // Collapsing all turns keeps the heading and cards in the session.

        await page.evaluate(pressHeading);
        await page.evaluate(SETTLED);
        const again = (await page.evaluate(READING)) as Reading;
        assert.deepEqual(failures, [], 'the panel threw while shutting every turn');
        assert.equal(again.shown, 0, `${again.shown} turns are still drawn open after the second press at ${width}px`);
        assert.equal(again.cards, shut.cards, `the second press took the session off the list at ${width}px`);
        assert.ok(
          again.groupHeight > 0,
          `the second press folded the session away at ${width}px, leaving the heading over nothing`,
        );
        assert.ok(
          again.hintDetail.endsWith(CARD_ACTIONS.expandAllTurns),
          `the heading hint second line offers "${again.hintDetail}" at ${width}px after shutting every turn under it`,
        );

        // Opening one turn independently must leave the heading action set to expand all turns.

        await page.evaluate(`document.querySelector('#list .turn .head').click()`);
        await page.evaluate(SETTLED);
        const one = (await page.evaluate(READING)) as Reading;
        assert.equal(one.shown, 1, `opening one turn by its own head row drew ${one.shown} of them at ${width}px`);
        assert.equal(
          one.twist,
          again.twist,
          `one turn of ${one.bodies} is open at ${width}px and the twist already points the way it does when all of them are`,
        );
        assert.ok(
          one.hintDetail.endsWith(CARD_ACTIONS.expandAllTurns),
          `the heading hint second line offers "${one.hintDetail}" at ${width}px while one turn of many is open`,
        );
        assert.equal(
          one.expanded,
          'false',
          `one turn of ${one.bodies} is expanded at ${width}px and the heading already says aria-expanded="${one.expanded}"`,
        );
        await page.evaluate(`document.querySelector('#list .turn .head').click()`);
        await page.evaluate(SETTLED);
      }
      assert.deepEqual(failures, [], 'the panel threw while the heading was being pressed');
    } finally {
      await browser.close();
    }
  },
);

test(
  "the layout gear clears a narrow panel's right edge, past a title cut short and a pin and menu button drawn whole",
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
      const payload = renderPayload() as { cards: Record<string, unknown>[] };
      payload.cards[0].sessionTitle =
        'A session title long enough that a narrow panel has to cut it before the pin and the menu button';
      await page.setViewportSize({ width: 340, height: 900 });
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);
      const found = (await page.evaluate(`(() => {
      const pin = document.querySelector('#list .sessionpin');
      const menu = document.querySelector('#list .sessionmenu:not(.sessionpin):not(.sessionlayout)');
      const age = document.querySelector('#list .sessionlayout');
      const name = document.querySelector('#list .session .name');
      const pinBox = pin.getBoundingClientRect();
      const menuBox = menu.getBoundingClientRect();
      const ageBox = age.getBoundingClientRect();
      // A button the row squeezed is narrower than the same button drawn on its own. Its
      // \`flex: none\` and its own content width each hold it whole, so this goes red when both
      // give way, or when a rule scoped to the heading row narrows it.
      const whole = (node, box) => {
        const alone = node.cloneNode(true);
        alone.style.position = 'absolute';
        document.body.append(alone);
        const width = alone.getBoundingClientRect().width;
        alone.remove();
        return box.width >= width - 0.5;
      };
      return {
        ageRight: ageBox.right,
        ageLeft: ageBox.left,
        nameRight: name.getBoundingClientRect().right,
        pinLeft: pinBox.left,
        pinRight: pinBox.right,
        pinWhole: whole(pin, pinBox),
        menuLeft: menuBox.left,
        menuRight: menuBox.right,
        menuWhole: whole(menu, menuBox),
        viewportWidth: document.documentElement.clientWidth,
        clipped: name.scrollWidth > name.clientWidth,
      };
    })()`)) as {
        ageRight: number;
        ageLeft: number;
        nameRight: number;
        pinLeft: number;
        pinRight: number;
        pinWhole: boolean;
        menuLeft: number;
        menuRight: number;
        menuWhole: boolean;
        viewportWidth: number;
        clipped: boolean;
      };
      // The fixture omits editor scrollbar and container padding. The 10px threshold detects missing heading clearance.

      const clearance = found.viewportWidth - found.ageRight;
      assert.ok(
        clearance >= 10,
        `the layout gear clears only ${Math.round(clearance)}px of the right edge, ` +
          `short of the padding that is meant to hold the row clear of the editor's overlay scrollbar`,
      );
      assert.ok(
        found.clipped,
        'the long title fits in full at 340px, so this measures nothing about the cut it is meant to prove',
      );
      assert.ok(found.pinWhole, 'the row squeezed the pin at 340px instead of cutting the title');
      assert.ok(found.menuWhole, 'the row squeezed the menu button at 340px instead of cutting the title');
      assert.ok(
        found.nameRight <= found.pinLeft,
        `the cut title's right edge (${Math.round(found.nameRight)}px) runs under the pin (${Math.round(found.pinLeft)}px)`,
      );
      assert.ok(
        found.pinRight <= found.menuLeft,
        `the pin's right edge (${Math.round(found.pinRight)}px) reaches past the menu button's left edge (${Math.round(found.menuLeft)}px)`,
      );
      assert.ok(
        found.menuRight <= found.viewportWidth,
        `the menu button's right edge sits at ${Math.round(found.menuRight)}px, past the ${found.viewportWidth}px viewport`,
      );
      assert.ok(
        found.menuRight <= found.ageLeft,
        `the menu button's right edge (${Math.round(found.menuRight)}px) reaches past the layout gear's left edge ` +
          `(${Math.round(found.ageLeft)}px), so the two overlap`,
      );
    } finally {
      await browser.close();
    }
  },
);

test('the menu dots sit on the ink of the words beside them', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(pageHtml());
    await layoutAt(page, 1350);
    // Measure glyph ink because line boxes include space below the text baseline.

    const ink = (await page.evaluate(`(() => {
      const inkMid = (node) => {
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        const canvas = document.createElement('canvas').getContext('2d');
        canvas.font = style.fontWeight + ' ' + style.fontSize + ' ' + style.fontFamily;
        const m = canvas.measureText((node.textContent || '').trim() || 'Xy');
        const baseline = box.top
          + (box.height - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2
          + m.fontBoundingBoxAscent;
        return ((baseline - m.actualBoundingBoxAscent) + (baseline + m.actualBoundingBoxDescent)) / 2;
      };
      const dot = document.querySelector('#list .sessionmenu svg circle').getBoundingClientRect();
      return {
        dots: dot.top + dot.height / 2,
        name: inkMid(document.querySelector('#list .session .name')),
        gear: (() => {
          const box = document.querySelector('#list .sessionlayout svg').getBoundingClientRect();
          return box.top + box.height / 2;
        })(),
      };
    })()`)) as { dots: number; name: number; gear: number };
    // Compare the dots with both the gear and title ink within 0.75px.

    assert.ok(
      Math.abs(ink.dots - ink.gear) <= 0.75,
      `the dots sit at ${ink.dots}px and the layout gear's center at ${ink.gear}px`,
    );
    assert.ok(
      Math.abs(ink.dots - ink.name) <= 0.75,
      `the dots sit at ${ink.dots}px and the title's ink at ${ink.name}px`,
    );
  } finally {
    await browser.close();
  }
});

test(
  "the heading's buttons sit beside the title rather than at the panel's right edge",
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
      await layoutAt(page, 1350);
      const found = (await page.evaluate(`(() => {
      const name = document.querySelector('#list .session .name');
      const pin = document.querySelector('#list .sessionpin');
      const menu = document.querySelector('#list .sessionmenu:not(.sessionpin):not(.sessionlayout)');
      const nameBox = name.getBoundingClientRect();
      const pinBox = pin.getBoundingClientRect();
      const menuBox = menu.getBoundingClientRect();
      return {
        gap: pinBox.left - nameBox.right,
        pinToMenu: menuBox.left - pinBox.right,
        menuRight: menuBox.right,
        viewportWidth: document.documentElement.clientWidth,
      };
    })()`)) as { gap: number; pinToMenu: number; menuRight: number; viewportWidth: number };
      // In this fixture, a stretched title button leaves more than 20px between its text and the pin.

      assert.ok(
        found.gap <= 20,
        `the title's text sits ${Math.round(found.gap)}px short of the pin, ` +
          `too far for the two to read as one group`,
      );
      assert.ok(
        Math.abs(found.pinToMenu) <= 1,
        `the menu button sits ${Math.round(found.pinToMenu)}px from the pin rather than beside it`,
      );
      // The menu button must clear the viewport edge by at least 300px in this fixture.

      const clearance = found.viewportWidth - found.menuRight;
      assert.ok(
        clearance >= 300,
        `the menu button clears only ${Math.round(clearance)}px of the panel's right edge, ` +
          `which reads as sitting at the edge rather than beside the title`,
      );
    } finally {
      await browser.close();
    }
  },
);

test('a press on the heading row past the title leaves the session as it was', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(pageHtml());
    await layoutAt(page, 1350);
    const before = (await page.evaluate(
      `document.querySelector('#list .session').getAttribute('aria-expanded')`,
    )) as string;
    // Click halfway between the title text and layout gear. A stretched title button captures this empty-row press.

    const point = (await page.evaluate(`(() => {
      const heading = document.querySelector('#list .sessionheading');
      const name = document.querySelector('#list .session .name');
      const gear = document.querySelector('#list .sessionlayout');
      const nameBox = name.getBoundingClientRect();
      const headingBox = heading.getBoundingClientRect();
      const x = (nameBox.right + gear.getBoundingClientRect().left) / 2;
      const y = headingBox.top + headingBox.height / 2;
      const hit = document.elementFromPoint(x, y)?.closest('button');
      return { x, y, hit: hit && !hit.classList.contains('session') ? hit.dataset.control : null };
    })()`)) as { x: number; y: number; hit: string | null };
    assert.equal(point.hit, null, `the press lands on "${point.hit}", so it measures nothing about the bare row`);
    await page.mouse.click(point.x, point.y);
    await page.evaluate(SETTLED);
    const afterOutside = (await page.evaluate(
      `document.querySelector('#list .session').getAttribute('aria-expanded')`,
    )) as string;
    assert.equal(
      afterOutside,
      before,
      `a press on the heading row past the title's own text changed aria-expanded from "${before}" to "${afterOutside}", ` +
        'so the row toggled the session outside its title',
    );
    // Also press the title to distinguish a working toggle from a row that ignores every press.

    await page.evaluate(`document.querySelector('#list .session').click()`);
    await page.evaluate(SETTLED);
    const afterTitle = (await page.evaluate(
      `document.querySelector('#list .session').getAttribute('aria-expanded')`,
    )) as string;
    assert.notEqual(
      afterTitle,
      before,
      `pressing the title left aria-expanded at "${before}", so this guard cannot tell a working toggle from a dead row`,
    );
  } finally {
    await browser.close();
  }
});

test(
  "the heading carries the last activity's full local time without drawing an age",
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
      await layoutAt(page, 1350);
      const found = (await page.evaluate(`(() => {
      const heading = document.querySelector('#list .sessionheading');
      return {
        fullTime: heading.querySelector('.sr-only')?.textContent ?? null,
        detail: heading.querySelector('.session')?.dataset.hintDetail ?? '',
        ticking: heading.querySelectorAll('[data-at]').length,
      };
    })()`)) as { fullTime: string | null; detail: string; ticking: number };
      assert.ok(found.fullTime, 'the heading carries no hidden full local time for its last activity');
      // The heading hint exposes the full local time to pointer users.
      assert.ok(
        found.detail.startsWith(`${CARD_ACTIONS.lastActive} ${found.fullTime}. `),
        `the heading hint's second line is "${found.detail}", which drops the full local time "${found.fullTime}"`,
      );
      const name = await axName(page, '#list .sessionheading');
      assert.ok(
        name && name.includes(found.fullTime),
        `the heading's accessible name is "${name}", which drops the full local time "${found.fullTime}"`,
      );
      // The session list and newest card show relative age. The session heading omits it.

      assert.equal(found.ticking, 0, 'the heading still draws an age the ticker rewrites');
    } finally {
      await browser.close();
    }
  },
);

test(
  "the heading's keyboard walk runs title, pin, menu button, gear, in the order they are drawn",
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
      await layoutAt(page, 1350);
      await page.evaluate(`document.querySelector('#list .session').focus()`);
      const walk: (string | null)[] = [];
      for (let step = 0; step < 3; step += 1) {
        await page.keyboard.press('ArrowDown');
        walk.push(
          await page.evaluate<string | null>(`document.activeElement && document.activeElement.dataset.control`),
        );
      }
      assert.deepEqual(
        walk,
        ['sessionpin:s1', 'sessionmenu:s1', 'sessionlayout:s1'],
        'the arrow keys walk the heading in an order the reader does not see',
      );
    } finally {
      await browser.close();
    }
  },
);

test('the next-turn line keeps one height through every state it can wear', { timeout: 90_000 }, async (t) => {
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
    for (const width of [1350, 420, 340]) {
      await page.setViewportSize({ width, height: 900 });
      const seen: Record<string, Measured> = {};
      for (const state of ['warm', 'cold'] as const) {
        await page.evaluate(`window.postMessage(${JSON.stringify(nextTurnPayload(state))}, '*')`);
        await page.evaluate(SETTLED);
        const measured = (await page.evaluate(NEXT_TURN)) as Measured | null;
        assert.ok(measured, `the line above the box is not drawn in the ${state} state at ${width}px`);
        const inset = (await page.evaluate(`(() => {
          const face = [...document.querySelectorAll('.cnextturnface')]
            .find((node) => getComputedStyle(node).visibility !== 'hidden');
          const prompt = document.getElementById('prompt');
          if (!face || !prompt) return null;
          const style = getComputedStyle(prompt);
          return {
            line: face.getBoundingClientRect().left,
            promptText: prompt.getBoundingClientRect().left
              + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
          };
        })()`)) as { line: number; promptText: number } | null;
        assert.ok(inset, `the ${state} line or Composer text field is not drawn at ${width}px`);
        assert.ok(
          Math.abs(inset.line - inset.promptText) <= 1,
          `the ${state} line starts at ${inset.line}px, not the Composer text inset at ${inset.promptText}px at ${width}px`,
        );
        seen[state] = measured;
        assert.equal(measured.state, state, `the ${state} payload draws the ${measured.state} face at ${width}px`);
        assert.equal(measured.shownFaces, 1, `${measured.shownFaces} faces are visible at once at ${width}px`);
        assert.equal(measured.aboveBox, true, `the line runs over the box in the ${state} state at ${width}px`);
        assert.equal(measured.insideComposer, true, `the line runs outside the composer at ${width}px`);
        assert.equal(measured.borderless, true, 'a hairline still parts the line from the box');
        assert.ok(measured.gap >= 10, `only ${measured.gap}px parts the line from the box at ${width}px`);
        // Only the price opens details. The surrounding line remains selectable text.

        assert.equal(measured.lineIsButton, false, 'the whole line is a control, so it reads as a second Send');
        assert.equal(measured.pressable, true, `the price is not a real button at ${width}px`);
        assert.ok(measured.priceGap > 0, `the price runs into the words before it at ${width}px`);
        assert.equal(measured.statusGap, 0, `the comma separates from the price at ${width}px`);
        assert.equal(measured.priceTabbable, true, `the price cannot be reached by keyboard at ${width}px`);
        assert.ok(measured.priceTabIndex >= 0, `the price is out of the tab walk at ${width}px`);
        assert.equal(measured.lineTitle, null, 'the line carries a native tooltip');
        assert.equal(measured.priceTitle, null, 'the pressable figure carries a native tooltip');
        assert.equal(
          measured.wordsHidden,
          true,
          'the words beside the price are read out as well as the price name, so the sentence is heard twice',
        );
        assert.equal(measured.clipped, false, `the ${state} figure is cut at ${width}px`);
        assert.notEqual(measured.ellipsis, 'ellipsis', 'the figure may be ellipsized');
        assert.equal(measured.tabular, 'tabular-nums', 'the figure is not drawn in tabular figures');
        assert.ok(measured.rows <= 1, `the ${state} face wraps to ${measured.rows} rows at ${width}px`);
        assert.match(
          measured.name ?? '',
          /^Next turn starts at \$\d/,
          `the price name does not open on the figure at ${width}px`,
        );
        // The accessible name must announce that price details can be opened.

        assert.match(measured.name ?? '', /Details\.$/, 'the accessible name drops the disclosure word');
      }
      assert.match(
        seen.warm.text,
        /^Next turn starts at \$[\d.]+, cached for another \d+[mhdwy]$/,
        `the warm line reads "${seen.warm.text}" at ${width}px`,
      );
      assert.match(
        seen.cold.text,
        /^Next turn starts at \$[\d.]+, uncached$/,
        `the cold line reads "${seen.cold.text}" at ${width}px`,
      );
      assert.equal(seen.warm.statusTitle, 'opus-5 cache lifetime: 1 hour', 'the cached status names no model lifetime');
      assert.equal(
        seen.cold.statusTitle,
        'opus-5 cache lifetime: 1 hour',
        'the uncached status names no model lifetime',
      );
      assert.match(seen.warm.name ?? '', /cached for another/, 'the warm name does not carry its state');
      assert.match(seen.cold.name ?? '', /uncached/, 'the cold name does not carry its state');
      // Cache expiry must preserve the line height and prompt text field position.

      assert.equal(
        seen.warm.height,
        seen.cold.height,
        `the line is ${seen.warm.height}px warm and ${seen.cold.height}px cold at ${width}px`,
      );
      assert.equal(
        seen.warm.promptTop,
        seen.cold.promptTop,
        `the box moves ${Math.abs(seen.warm.promptTop - seen.cold.promptTop)}px when the cache goes at ${width}px`,
      );
    }
    // A missing cache lifetime selects the cold price.
    await page.evaluate(`window.postMessage(${JSON.stringify(nextTurnPayload('no-tier'))}, '*')`);
    await page.evaluate(SETTLED);
    const bare = (await page.evaluate(NEXT_TURN)) as Measured | null;
    assert.equal(bare?.state, 'cold', 'a record with no lifetime quotes the cold price');
    assert.equal(bare?.shownFaces, 1);
    assert.match(bare?.text ?? '', /, uncached$/);
    assert.deepEqual(failures, [], 'the panel threw while drawing the line above the box');
  } finally {
    await browser.close();
  }
});

test('pressing the next-turn price opens its working inside the panel', { timeout: 90_000 }, async (t) => {
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
    for (const { width, height, detailLines, statusBarTop } of [
      { width: 1350, height: 900, detailLines: null, statusBarTop: null },
      { width: 340, height: 900, detailLines: null, statusBarTop: null },
      {
        width: 340,
        height: 900,
        statusBarTop: 180,
        detailLines: Array(12).fill('The alternate cache estimate remains available.'),
      },
    ]) {
      await page.setViewportSize({ width, height });
      const payload = nextTurnPayload('cold') as {
        usage: { composer: { nextTurn: { cold: { entries: Array<{ lines?: string[] }> } } } };
      };
      if (detailLines) {
        payload.usage.composer.nextTurn.cold.entries[0].lines = detailLines;
      }
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);
      await page.evaluate((top) => {
        const bar = document.getElementById('statusbar');
        if (!bar) {
          return;
        }
        if (top === null) {
          bar.style.removeProperty('top');
          bar.style.removeProperty('bottom');
        } else {
          bar.style.top = `${top}px`;
          bar.style.bottom = 'auto';
        }
      }, statusBarTop);
      await page.locator('.cnextturnface:not(.is-off) .cnextturnprice').click();
      await page.evaluate(SETTLED);
      const pop = (await page.evaluate(`(() => {
        const node = document.getElementById('chippop');
        const control = document.querySelector('.cnextturnface:not(.is-off) .cnextturnprice');
        const bar = document.getElementById('statusbar');
        const box = node.getBoundingClientRect();
        const firstHead = node.querySelector('.chippopitemhead');
        return {
          hidden: node.hidden,
          pinned: node.classList.contains('pinned'),
          pressed: control.getAttribute('aria-pressed'),
          // Ids inside the popover count as the popover, since a figure with notes names its breakdown parts.
          describes: [...new Set((control.getAttribute('aria-describedby') || '').split(' ').filter(Boolean)
            .map((id) => document.getElementById(id)?.closest('#chippop') && !document.getElementById(id)?.closest('.chippopnotes') ? 'chippop' : id))].join(' ') || null,
          text: node.textContent,
          heading: node.querySelector('.chippophead') ? node.querySelector('.chippophead').textContent : null,
          statusTitle: node.querySelector('.chippopmuted [title]')?.getAttribute('title')
            ?? node.querySelector('.chippopmuted')?.getAttribute('title')
            ?? null,
          labels: [...node.querySelectorAll('.chippoplabel')].map((one) => one.textContent),
          lines: [...node.querySelectorAll('.chippopsubitem')].map((one) => one.textContent),
          notes: [...node.querySelectorAll('.chippopnotes li')].map((one) => one.textContent),
          stacked: node.classList.contains('chippop-stacked'),
          itemHeadJustify: firstHead ? getComputedStyle(firstHead).justifyContent : null,
          scrollable: node.scrollHeight > node.clientHeight,
          inside: box.left >= -1 && box.right <= window.innerWidth + 1
            && box.top >= -1 && box.bottom <= bar.getBoundingClientRect().top + 1,
        };
      })()`)) as {
        hidden: boolean;
        pinned: boolean;
        pressed: string | null;
        describes: string | null;
        text: string;
        heading: string | null;
        statusTitle: string | null;
        labels: string[];
        lines: string[];
        notes: string[];
        stacked: boolean;
        itemHeadJustify: string | null;
        scrollable: boolean;
        inside: boolean;
      };
      assert.deepEqual(failures, [], `the panel threw while opening the working at ${width}px`);
      assert.equal(pop.hidden, false, `the press opened nothing at ${width}px`);
      assert.equal(pop.pinned, true, `the press did not pin the working at ${width}px`);
      assert.equal(pop.pressed, 'true', `the price does not report itself pressed at ${width}px`);
      assert.equal(pop.describes, 'chippop', `the working is not tied to the price at ${width}px`);
      assert.match(
        pop.heading ?? '',
        /^Next turn starts at \$[\d.]+, uncached$/,
        `the working does not repeat the visible cold status at ${width}px`,
      );
      assert.equal(
        pop.statusTitle,
        'opus-5 cache lifetime: 1 hour',
        `the working's cold status names no model lifetime at ${width}px`,
      );
      assert.deepEqual(
        pop.labels.slice(1),
        ['Cost if cache were warm'],
        `the working does not keep the alternate cache estimate at ${width}px`,
      );
      assert.equal(pop.stacked, true, `the next-turn working keeps its values in a second column at ${width}px`);
      assert.equal(pop.itemHeadJustify, 'flex-start', `the next-turn labels and values are pushed apart at ${width}px`);
      assert.deepEqual(pop.lines, detailLines ?? [], `the next-turn working retains a removed detail at ${width}px`);
      assert.equal(pop.notes.length, 1, `the working drops its estimate note at ${width}px`);
      assert.doesNotMatch(
        pop.text,
        /Cache lifetime|\/M tokens|floor|estimated cost to compact|assumes a summary/i,
        `the working retains removed detail at ${width}px`,
      );
      assert.equal(pop.inside, true, `the working is drawn off the panel or behind the bar at ${width}px`);
      assert.equal(
        pop.scrollable,
        statusBarTop !== null,
        `the constrained next-turn working does not keep its detail inside the panel at ${width}px`,
      );
      await page.keyboard.press('Escape');
      await page.evaluate(SETTLED);
    }
  } finally {
    await browser.close();
  }
});

test('a constrained next-turn working does not cap a later card detail', { timeout: 90_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(pageHtml());
    await page.setViewportSize({ width: 340, height: 900 });
    const nextTurn = nextTurnPayload('cold') as {
      usage: { composer: { nextTurn: { cold: { entries: Array<{ lines?: string[] }> } } } };
    };
    nextTurn.usage.composer.nextTurn.cold.entries[0].lines = Array(12).fill(
      'The alternate cache estimate remains available.',
    );
    await page.evaluate(`window.postMessage(${JSON.stringify(nextTurn)}, '*')`);
    await page.evaluate(SETTLED);
    await page.evaluate(`(() => {
      const bar = document.getElementById('statusbar');
      bar.style.top = '180px';
      bar.style.bottom = 'auto';
    })()`);
    await page.locator('.cnextturnface:not(.is-off) .cnextturnprice').click();
    await page.evaluate(SETTLED);
    const bounded = await page.locator('#chippop').evaluate((node) => node.style.maxHeight);
    assert.notEqual(bounded, '', 'the next-turn working did not apply its panel-height bound');
    await page.keyboard.press('Escape');
    await page.evaluate(SETTLED);
    await page.evaluate(`(() => {
      const bar = document.getElementById('statusbar');
      bar.style.removeProperty('top');
      bar.style.removeProperty('bottom');
    })()`);
    await page.setViewportSize({ width: 1350, height: 900 });
    const payload = renderPayload() as { cards: { chips: Record<string, unknown>[] }[] };
    payload.cards[0].chips.push({
      kind: 'plain',
      label: '5 agents',
      detail: 'Five agents',
      detailList: {
        heading: { label: '5 subagents' },
        entries: Array.from({ length: 5 }, (_, index) => ({
          label: `review_agent_${index + 1}`,
          value: `$${index + 1}`,
          lines: [`${index + 1}00k tokens`],
        })),
      },
    });
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
    await page.locator('#list .turn .chips .has-detail').filter({ hasText: '5 agents' }).click();
    await page.evaluate(SETTLED);
    const ordinary = await page.locator('#chippop').evaluate((node) => ({
      inlineCap: node.style.maxHeight,
      scrollable: node.scrollHeight > node.clientHeight,
      rows: node.querySelectorAll('.chippopitem').length,
    }));
    assert.equal(ordinary.rows, 5, 'the ordinary card detail did not draw its agent rows');
    assert.equal(ordinary.inlineCap, '', 'the card detail retained the next-turn height cap');
    assert.equal(ordinary.scrollable, false, 'the card detail scrolls despite fitting at its ordinary height');
  } finally {
    await browser.close();
  }
});

test('a rebuild hands the price back to the reader who was holding it', { timeout: 90_000 }, async (t) => {
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
    await page.setViewportSize({ width: 1350, height: 900 });
    // Use the cold face to check that focus restoration selects the visible price when hidden faces precede it.

    await page.evaluate(`window.postMessage(${JSON.stringify(nextTurnPayload('cold'))}, '*')`);
    await page.evaluate(SETTLED);
    await page.evaluate(`document.querySelector('.cnextturnface:not(.is-off) .cnextturnprice').focus()`);
    const before = (await page.evaluate(`(() => {
      const active = document.activeElement;
      return { onPrice: active.classList.contains('cnextturnprice'), state: active.closest('.cnextturnface').dataset.state };
    })()`)) as { onPrice: boolean; state: string };
    assert.deepEqual(before, { onPrice: true, state: 'cold' }, 'the reader is not holding the visible price');
    // Changing context rebuilds the prompt box without changing the next-turn line.

    const moved = JSON.parse(JSON.stringify(nextTurnPayload('cold'))) as Record<string, unknown>;
    const composer = (moved.usage as { composer: { context: { percent: number; said: string } } }).composer;
    composer.context.percent = 61;
    composer.context.said = '61% of the context window used';
    await page.evaluate(`window.postMessage(${JSON.stringify(moved)}, '*')`);
    await page.evaluate(SETTLED);
    const after = (await page.evaluate(`(() => {
      const active = document.activeElement;
      const face = active.closest ? active.closest('.cnextturnface') : null;
      return {
        onPrice: !!active && active.classList.contains('cnextturnprice'),
        state: face ? face.dataset.state : null,
        hidden: !!face && face.classList.contains('is-off'),
        tag: active ? active.tagName : null,
        rebuilt: document.querySelector('.cctxpct') ? document.querySelector('.cctxpct').textContent : null,
      };
    })()`)) as { onPrice: boolean; state: string | null; hidden: boolean; tag: string | null; rebuilt: string | null };
    assert.equal(after.rebuilt, '61%', 'the foot did not rebuild, so the restore was never asked to run');
    assert.equal(after.onPrice, true, `the rebuild dropped the reader on ${after.tag} instead of the price`);
    assert.equal(after.state, 'cold', `the rebuild handed the reader the ${after.state} price`);
    assert.equal(after.hidden, false, 'the reader was handed a price on a face nobody can see');
    assert.deepEqual(failures, [], 'the panel threw while the foot rebuilt');
  } finally {
    await browser.close();
  }
});

test('the next-turn line crosses its own boundaries with no press and no repaint', { timeout: 90_000 }, async (t) => {
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
    await page.setViewportSize({ width: 1350, height: 900 });
    const read = `(() => {
      const node = document.querySelector('.cnextturn');
      const price = node.querySelector('.cnextturnface:not(.is-off) .cnextturnprice');
      return {
        state: node.dataset.state, name: price.getAttribute('aria-label'), sent: window.__posted.length,
      };
    })()`;
    // The conservative boundary is the single point where the line changes from warm to cold.
    const endsIn = 2_000;
    const coldAt = Number(await page.evaluate('Date.now()')) + endsIn;
    await page.evaluate(
      `window.postMessage(${JSON.stringify(nextTurnPayload('warm', coldAt - 3_600_000 + CONSERVATIVE_CACHE_BOUNDARY_MS))}, '*')`,
    );
    await page.evaluate(SETTLED);
    const before = (await page.evaluate(read)) as { state: string; name: string; sent: number };
    assert.equal(before.state, 'warm', 'the line does not open on the warm face the clock says');
    await pauseClock(page);
    await page.clock.runFor(3_000);
    await page.waitForFunction(`document.querySelector('.cnextturn').dataset.state !== 'warm'`, undefined, {
      timeout: 15_000,
    });
    const after = (await page.evaluate(read)) as { state: string; name: string; sent: number };
    assert.equal(after.state, 'cold', `the line crossed into ${after.state}`);
    assert.notEqual(after.name, before.name, 'the accessible name kept the state that has gone');
    assert.equal(after.sent, before.sent, 'the line asked the extension for the new words');
    assert.deepEqual(failures, [], 'the panel threw while the line crossed its boundaries');
  } finally {
    await browser.close();
  }
});

test(
  'the next-turn line says cached for under two minutes inside the warm conservative boundary',
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
      await page.setContent(pageHtml());
      await page.setViewportSize({ width: 1350, height: 900 });
      const read = `(() => document.querySelector('.cnextturnface:not(.is-off)').textContent)()`;
      const now = Number(await page.evaluate('Date.now()'));
      const warmLastRequest = now - 3_600_000 + CONSERVATIVE_CACHE_BOUNDARY_MS + 105_000;
      await page.evaluate(`window.postMessage(${JSON.stringify(nextTurnPayload('warm', warmLastRequest))}, '*')`);
      await page.evaluate(SETTLED);
      const warm = (await page.evaluate(read)) as string;
      assert.match(warm, /, cached for under 2m$/, `the warm line reports a stale duration: ${warm}`);
      assert.doesNotMatch(warm, /expiring|about now/, `the warm line adds a third cache state: ${warm}`);
      assert.deepEqual(failures, [], 'the panel threw while it described the conservative boundary');
    } finally {
      await browser.close();
    }
  },
);

test('the next-turn line enters cached-for-under-two-minutes wording on its ticker', { timeout: 90_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (e) => failures.push(String(e)));
    const now = FIXTURE_CLOCK;
    await page.clock.setFixedTime(now);
    await page.setContent(pageHtml());
    await page.setViewportSize({ width: 1350, height: 900 });
    const coldAt = now + 130_000;
    await page.evaluate(
      `window.postMessage(${JSON.stringify(nextTurnPayload('warm', coldAt - 3_600_000 + CONSERVATIVE_CACHE_BOUNDARY_MS))}, '*')`,
    );
    await page.evaluate(SETTLED);
    const read = `(() => {
      const face = document.querySelector('.cnextturnface:not(.is-off)');
      const visible = face.querySelectorAll('.cnextturnwords')[1];
      const span = face.querySelector('.cnextturnspan');
      const price = face.querySelector('.cnextturnprice');
      const pop = document.getElementById('chippop');
      return {
        text: visible.textContent,
        span: span ? span.textContent : null,
        heading: pop.querySelector('.chippophead')?.textContent ?? null,
        pinned: pop.classList.contains('pinned'),
        pressed: price.getAttribute('aria-pressed'),
        focused: document.activeElement === price,
      };
    })()`;
    await page.locator('.cnextturnface:not(.is-off) .cnextturnprice').click();
    await page.evaluate(`document.querySelector('.cnextturnface:not(.is-off) .cnextturnprice').focus()`);
    const before = (await page.evaluate(read)) as {
      text: string;
      span: string | null;
      heading: string | null;
      pinned: boolean;
      pressed: string | null;
      focused: boolean;
    };
    assert.match(
      before.heading ?? '',
      /^Next turn starts at \$[\d.]+, cached for another \d+m$/,
      `the open working does not begin with the line status: ${before.heading}`,
    );
    assert.equal(before.pinned, true, 'the open working is not pinned before the ticker moves');
    assert.equal(before.focused, true, 'the reader is not holding the price before the ticker moves');
    await page.clock.setFixedTime(coldAt - 110_000);
    await page.clock.runFor(1_000);
    await page.waitForFunction(
      `document.querySelector('.cnextturnface:not(.is-off) .cnextturnspan').textContent === '2m'`,
    );
    const nearWarm = (await page.evaluate(read)) as {
      text: string;
      span: string | null;
      heading: string | null;
      pinned: boolean;
      pressed: string | null;
      focused: boolean;
    };
    assert.equal(nearWarm.text, ', cached for under 2m', 'the warm line does not enter near wording');
    assert.equal(nearWarm.span, '2m', 'the warm line does not keep the near figure');
    assert.match(
      nearWarm.heading ?? '',
      /^Next turn starts at \$[\d.]+, cached for under 2m$/,
      `the pinned working kept its prior status: ${nearWarm.heading}`,
    );
    assert.equal(nearWarm.pinned, true, 'the ticker unpinned the open working');
    assert.equal(nearWarm.pressed, 'true', 'the ticker cleared the open price state');
    assert.equal(nearWarm.focused, true, 'the ticker moved focus away from the open price');
    assert.deepEqual(failures, [], 'the panel threw while the ticker crossed near wording');
  } finally {
    await browser.close();
  }
});

test(
  'the line counts what is left of the lifetime, off the same ticker as every age',
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
      await page.setContent(pageHtml());
      await page.setViewportSize({ width: 1350, height: 900 });
      // Read the page clock because it runs from the fixture instant.
      const pageNow = Number(await page.evaluate('Date.now()'));
      // Place the remaining lifetime halfway through a displayed minute to allow rendering time. Send the payload once.

      const lastRequest = pageNow - 15 * 60_000;
      await page.evaluate(`window.postMessage(${JSON.stringify(nextTurnPayload('warm', lastRequest))}, '*')`);
      await page.evaluate(SETTLED);
      const read = `(() => {
      const face = document.querySelector('.cnextturnface:not(.is-off)');
      const span = face ? face.querySelector('.cnextturnspan') : null;
      return span ? { text: span.textContent, title: span.getAttribute('title') } : null;
    })()`;
      const shown = (await page.evaluate(read)) as { text: string; title: string } | null;
      assert.ok(shown, 'the warm line carries no figure the ticker can reach');
      assert.equal(
        shown.text,
        formatCacheSpan(lastRequest + 3_600_000 - CONSERVATIVE_CACHE_BOUNDARY_MS - pageNow),
        'the remaining figure is not the boundary less the browser clock',
      );
      assert.equal(shown.text, '43m');
      assert.equal(shown.title, 'opus-5 cache lifetime: 1 hour');
      // Set the remaining lifetime two seconds past a minute boundary. After rendering, the ticker must update it without another payload.

      const nearly =
        Number(await page.evaluate('Date.now()')) - 3_600_000 + CONSERVATIVE_CACHE_BOUNDARY_MS + 30 * 60_000 + 2_000;
      await page.evaluate(`window.postMessage(${JSON.stringify(nextTurnPayload('warm', nearly))}, '*')`);
      await page.evaluate(SETTLED);
      const before = (await page.evaluate(read)) as { text: string; title: string };
      assert.equal(before.text, '30m', `the figure opened on ${before.text} rather than the minute it is in`);
      await pauseClock(page);
      await page.clock.runFor(3_000);
      await page.waitForFunction(
        `document.querySelector('.cnextturnface:not(.is-off) .cnextturnspan').textContent !== '30m'`,
        undefined,
        { timeout: 15_000 },
      );
      const after = (await page.evaluate(read)) as { text: string; title: string };
      assert.equal(after.text, '29m', 'the figure moved to something other than the next minute down');
      assert.deepEqual(failures, [], 'the panel threw while the figure counted down');
    } finally {
      await browser.close();
    }
  },
);

test('the session heading hint falls back to the name the rail draws', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(pageHtml());
    // Give the session list a stored name without a full label. The heading hint must use that name.

    const payload = renderPayload();
    const rows = payload.sessions as Array<Record<string, unknown>>;
    const stored = 'The name the rail draws for this session';
    rows[0].label = stored;
    delete rows[0].fullLabel;
    await page.setViewportSize({ width: 1350, height: 900 });
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
    const heading = page.locator('#list .session').first();
    assert.equal(
      await heading.getAttribute('data-hint'),
      stored,
      'the session heading hint reads the card title instead of the name the rail draws',
    );
    assert.match(
      (await heading.getAttribute('aria-label')) ?? '',
      new RegExp(stored),
      'the session heading accessible name reads the card title instead of the name the rail draws',
    );
    // A dialog with no heading takes the Files figure's spoken name, not its drawn text.
    await page.evaluate(`window.postMessage(${JSON.stringify(statPopoverPayload())}, '*')`);
    await page.evaluate(SETTLED);
    const files = page.locator('#list .sessionstats .statchip[data-metric="files"]');
    await files.click();
    await page.locator('#chippop[role="dialog"]').waitFor();
    const spoken = ((await files.locator('.saidonly').textContent()) ?? '').trim();
    assert.ok(spoken, 'the Files figure has no spoken name, so this measures nothing');
    assert.equal(
      await page.getByRole('dialog', { name: spoken, exact: true }).count(),
      1,
      `the Files dialog is not named "${spoken}"`,
    );
  } finally {
    await browser.close();
  }
});

test(
  "the heading pin and the menu dots match the rail pin's size, and the layout gear does not move",
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
      return;
    }
    try {
      const page = await browser.newPage();
      // Use the editor theme font size. The bare browser font size changes the glyph measurements.

      await page.setContent(themed(pageHtml()));
      await layoutAt(page, 1350);
      const found = (await page.evaluate(`(() => {
      const railGlyph = document.querySelector('.railact.railpin svg').getBoundingClientRect();
      const pinGlyph = document.querySelector('#list .sessionpin svg').getBoundingClientRect();
      const menuGlyph = document
        .querySelector('#list .sessionmenu:not(.sessionpin):not(.sessionlayout) svg')
        .getBoundingClientRect();
      const gearGlyph = document.querySelector('#list svg.sessionlayouticon').getBoundingClientRect();
      return {
        rail: { width: railGlyph.width, height: railGlyph.height },
        pin: { width: pinGlyph.width, height: pinGlyph.height },
        menu: { width: menuGlyph.width, height: menuGlyph.height },
        gear: { width: gearGlyph.width, height: gearGlyph.height },
      };
    })()`)) as {
        rail: { width: number; height: number };
        pin: { width: number; height: number };
        menu: { width: number; height: number };
        gear: { width: number; height: number };
      };
      // Allow 0.5px for the difference between pixel-sized session-list glyphs and em-sized heading glyphs.

      const tolerance = 0.5;
      for (const [name, glyph] of [
        ['pin', found.pin],
        ['dots', found.menu],
      ] as const) {
        assert.ok(
          Math.abs(glyph.width - found.rail.width) <= tolerance,
          `the heading ${name} draws ${glyph.width.toFixed(2)}px wide, ` +
            `off the rail pin's ${found.rail.width.toFixed(2)}px by more than a pixel`,
        );
        assert.ok(
          Math.abs(glyph.height - found.rail.height) <= tolerance,
          `the heading ${name} draws ${glyph.height.toFixed(2)}px tall, ` +
            `off the rail pin's ${found.rail.height.toFixed(2)}px by more than a pixel`,
        );
      }
      // The layout gear measures 14.296875px by 19.125px in this fixture. Pin and menu sizing must leave those dimensions unchanged.

      const gearTolerance = 0.1;
      assert.ok(
        Math.abs(found.gear.width - 14.296875) <= gearTolerance,
        `the layout gear draws ${found.gear.width.toFixed(2)}px wide, away from its usual 14.30px`,
      );
      assert.ok(
        Math.abs(found.gear.height - 19.125) <= gearTolerance,
        `the layout gear draws ${found.gear.height.toFixed(2)}px tall, away from its usual 19.13px`,
      );
    } finally {
      await browser.close();
    }
  },
);

test(
  "a dispatched session's figures end with the session that started it, drawn as a peer of the cost figure",
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
      const payload = renderPayload();
      const row = (payload.sessions as Array<Record<string, unknown>>).find((candidate) => candidate.id === 's1')!;
      const draw = async (label: string, width: number) => {
        row.parent = { id: 's2', label, relation: 'dispatched' };
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
        await page.evaluate(SETTLED);
        return page.evaluate(`(() => {
        const stats = document.querySelector('section.sessionsection[data-session="s1"] .sessionstats');
        const chip = stats.querySelector('button.sessionparent');
        const cost = stats.querySelector('[data-metric="cost"]');
        const look = (node) => {
          const style = getComputedStyle(node);
          return { height: node.getBoundingClientRect().height, padding: style.padding, radius: style.borderRadius, fontSize: style.fontSize };
        };
        return chip && {
          last: stats.lastElementChild === chip,
          text: chip.textContent,
          hint: chip.dataset.hint,
          detail: chip.dataset.hintDetail,
          name: chip.getAttribute('aria-label'),
          chip: look(chip),
          cost: look(cost),
          cut: chip.scrollWidth > chip.clientWidth && getComputedStyle(chip).textOverflow === 'ellipsis',
          inside: chip.getBoundingClientRect().right <= stats.getBoundingClientRect().right + 0.5,
        };
      })()`) as Promise<null | (Record<string, unknown> & { chip: unknown; cost: unknown })>;
      };

      const wide = await draw('Plan the dispatch', 1350);
      assert.ok(wide, 'a dispatched session draws nothing that names the session that started it');
      assert.equal(wide.last, true, 'the session that started this one is not the last item of the figures row');
      assert.equal(wide.text, 'from Plan the dispatch');
      assert.equal(wide.hint, 'Dispatched from Plan the dispatch');
      assert.equal(wide.detail, 'Opens the session that started this one');
      assert.equal(wide.name, 'Dispatched from Plan the dispatch, opens that session');
      assert.deepEqual(wide.chip, wide.cost, 'the press is not drawn as a peer of the cost figure beside it');

      const long = 'A parent session whose name runs far past what a narrower panel can hold on one line of it';
      assert.equal(long.length, 90);
      const narrow = await draw(long, 340);
      assert.ok(narrow, 'a narrow panel dropped the session that started this one');
      assert.deepEqual(narrow.chip, narrow.cost, 'a long name broke the press onto more than one line');
      assert.equal(narrow.cut, true, 'a long name is not cut short with an ellipsis');
      assert.equal(narrow.inside, true, 'a long name runs past the figures row');
    } finally {
      await browser.close();
    }
  },
);
