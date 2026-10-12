// Browser checks for session-list headings, hints, popovers, and labels.
// Shared measurement helpers live in `../test/layout.ts`.

import { test } from 'vitest';
import assert from 'node:assert';
import { browserOrNone, pauseClock, SETTLED } from '../test/browser.ts';
import type { Page } from 'playwright-core';
import { CARD_ACTIONS, RAIL_MIN_WIDTH, RAIL_WIDTH_DEFAULT, RAIL_WIDTH_MIN } from './turnview.ts';
import { labelEditorRows } from './turnlabels.ts';
import { RAIL_FILTER_NAME_LIMIT } from './domain/rail-filters.ts';
import { ACTIVE_WINDOW_MS, type RailStatus } from './view/rail.ts';
import { MAX_RAIL_FILTER_NAME, NOW, SIX_QUESTION_ASK, pageHtml, renderPayload, themed } from './panelfixture.ts';
import {
  rovingSelector,
  railRows,
  layoutAt,
  answerSixQuestions,
  STRIP_ROWS,
  markedLayout,
  MetaLine,
  META_LINES,
  EDITOR_LABELS,
  SessionLabelLine,
} from '../test/layout.ts';

// Open the session-list filter through its search control.

async function openRailBox(page: Page): Promise<void> {
  await page.locator('[data-control="railsearch"]').click();
  await page.evaluate(SETTLED);
}

test('the rail taking room from the session re-fits the strip', { timeout: 60_000 }, async (t) => {
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
    // Use a panel width where the session list is visible and widening it reduces the question strip space.

    const laid = await layoutAt(page, 780, [], [], [], [], [SIX_QUESTION_ASK]);
    assert.ok(laid.rail, 'the rail is not drawn at 780px, so there is no sash to drag');
    await answerSixQuestions(page);
    const before = (await page.evaluate(STRIP_ROWS)) as { marked: boolean; rows: number };
    assert.deepEqual(
      before,
      { marked: false, rows: 2 },
      `the strip already gave up its values before the rail took any room, so this measures nothing`,
    );
    // Drag the divider to exercise layout notification and question-strip fitting. Setting the element width alone bypasses that notification.

    const sash = (await page.evaluate(`(() => {
      const box = document.getElementById('railsash').getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`)) as { x: number; y: number };
    await page.mouse.move(sash.x, sash.y);
    await page.mouse.down();
    await page.mouse.move(sash.x + (480 - RAIL_WIDTH_DEFAULT), sash.y);
    await page.mouse.up();
    const after = (await page.evaluate(STRIP_ROWS)) as { marked: boolean; rows: number };
    assert.equal(after.marked, true, `the widened rail left the strip ${after.rows} rows and it kept every value`);
    assert.ok(after.rows <= 2, `the strip takes ${after.rows} rows with its values dropped, and it is allowed two`);
    assert.deepEqual(failures, [], 'the panel threw while the rail took room from the session');
    await page.close();
  } finally {
    await browser.close();
  }
});

test('a rail bucket heading rests under the rail box and never over it', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.clock.setFixedTime(NOW);
    const failures: string[] = [];
    page.on('pageerror', (e) => failures.push(String(e)));
    await page.setContent(pageHtml());

    // Use enough pinned sessions to scroll within the Pinned section before the next heading reaches the filter bar.

    const pinned = ['s2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'];
    const wide = await layoutAt(page, 1350, [], [], [], [], [], pinned);
    assert.deepEqual(failures, [], 'the panel threw while drawing');
    assert.ok(wide.rail, 'the rail is not drawn at 1350px, so this measures nothing');

    const rest = await railRows(page);
    assert.ok(
      rest.heads.length >= 2,
      `the rail drew ${rest.heads.length} bucket headings, so there is nothing for a second one to push off the line`,
    );
    assert.equal(rest.heads[0].name, 'Pinned', 'the pinned bucket is not first, so this measures another bucket');
    for (const head of rest.heads) {
      assert.ok(
        head.top >= rest.boxBottom - 1,
        `${head.name} starts at ${Math.round(head.top)} with the rail box ending at ${Math.round(rest.boxBottom)}, ` +
          'so the heading is drawn over the filter and the project cost',
      );
    }

    // Scroll halfway through the Pinned section to check its sticky heading independently of the next heading.

    const half = Math.round((rest.heads[0].offset + rest.heads[1].offset) / 2);
    const mid = await railRows(page, half);
    // Sticky section headings must stay below the filter bar and Project cost.

    for (const head of mid.heads) {
      assert.ok(
        head.top >= mid.boxBottom - 1,
        `${head.name} is drawn at ${Math.round(head.top)} with the rail box ending at ${Math.round(mid.boxBottom)}, ` +
          'so the heading rides over the filter and the project cost',
      );
    }
    assert.ok(
      Math.abs(mid.heads[0].top - mid.boxBottom) <= 1,
      `Pinned is drawn at ${Math.round(mid.heads[0].top)} with the rail box ending at ${Math.round(mid.boxBottom)}, ` +
        'so it scrolled away with its cards instead of holding the line',
    );
    assert.ok(
      mid.heads[1].top > mid.boxBottom + 1,
      `${mid.heads[1].name} has already reached the line at this scroll, so nothing here says Pinned held it`,
    );

    // Scroll until the next heading overlaps Pinned. Their edges must align so the covered heading leaves no visible strip.

    const past = await railRows(page, rest.heads[1].offset + 40);
    assert.ok(
      Math.abs(past.heads[1].top - past.boxBottom) <= 1,
      `${past.heads[1].name} is drawn at ${Math.round(past.heads[1].top)} with the rail box ending at ` +
        `${Math.round(past.boxBottom)}, so only the first bucket holds the line`,
    );
    assert.ok(
      Math.abs(past.heads[0].top - past.heads[1].top) <= 1 &&
        Math.abs(past.heads[0].bottom - past.heads[1].bottom) <= 1,
      `Pinned is drawn from ${Math.round(past.heads[0].top)} to ${Math.round(past.heads[0].bottom)} under ` +
        `${past.heads[1].name} at ${Math.round(past.heads[1].top)} to ${Math.round(past.heads[1].bottom)}, ` +
        'so a strip of the heading it replaced shows around it',
    );

    // At minimum session-list width, use a heading long enough to truncate. Every sticky heading must retain the same height.

    await layoutAt(page, 1350, ['s13', 's14'], [], ['s10', 's11', 's12'], [], [], pinned);
    await page.evaluate(`document.getElementById('rail').style.flexBasis = '${RAIL_WIDTH_MIN}px'`);
    const tight = await railRows(page);
    assert.ok(
      tight.heads.length >= 3,
      `the rail drew ${tight.heads.length} bucket headings at ${RAIL_WIDTH_MIN}px, so this measures nothing`,
    );
    assert.ok(
      tight.heads.some((h) => h.cut > 0),
      `no heading is wider than the ${RAIL_WIDTH_MIN}px column holds, so nothing here is tight: ` +
        `the rail drew ${JSON.stringify(tight.heads.map((h) => h.name))}`,
    );
    const heights = tight.heads.map((h) => Math.round(h.bottom - h.top));
    assert.equal(
      new Set(heights).size,
      1,
      `the headings are drawn ${JSON.stringify(heights)} tall at ${RAIL_WIDTH_MIN}px, so the taller one shows ` +
        `around the heading that covers it: ${JSON.stringify(tight.heads.map((h) => h.name))}`,
    );

    assert.deepEqual(failures, [], 'the panel threw while drawing');
  } finally {
    await browser.close();
  }
});

test('the new-session menu stays reachable at wide and narrow widths', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  const shortcut = process.platform === 'darwin' ? 'Command+N' : 'Ctrl+N';
  const primaryName = `New session with the current setup (${shortcut})`;
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (e) => failures.push(String(e)));
    await page.setContent(pageHtml());

    await layoutAt(page, 1350);
    await openRailBox(page);
    await page.click('#rail .railnewmenu');
    await page.evaluate(SETTLED);
    const wide = (await page.evaluate(`(() => {
      const pop = document.getElementById('launcher');
      const rail = document.getElementById('rail');
      const anchor = rail.querySelector('.railnewmenu');
      const primary = rail.querySelector('.railnew');
      const split = rail.querySelector('.railnewsplit').getBoundingClientRect();
      const filter = rail.querySelector('.railfilter').getBoundingClientRect();
      const box = pop.getBoundingClientRect();
      return {
        hidden: pop.hidden, role: pop.getAttribute('role'), rows: pop.querySelectorAll('.launchlist .launchrow').length,
        left: box.left, right: box.right, top: box.top, bottom: box.bottom,
        anchorExpanded: anchor.getAttribute('aria-expanded'), anchorName: anchor.getAttribute('aria-label'),
        primaryTitle: primary.title, primaryHint: primary.dataset.hint,
        primaryHintDetail: primary.dataset.hintDetail,
        splitHeight: split.height, filterHeight: filter.height,
      };
    })()`)) as {
      hidden: boolean;
      role: string;
      rows: number;
      left: number;
      right: number;
      top: number;
      bottom: number;
      anchorExpanded: string;
      anchorName: string;
      primaryTitle: string;
      primaryHint: string;
      primaryHintDetail: string;
      splitHeight: number;
      filterHeight: number;
    };
    assert.equal(wide.hidden, false);
    assert.equal(wide.role, 'dialog');
    assert.equal(wide.rows, 1, 'the setup list does not hold the recent choice');
    assert.equal(wide.anchorExpanded, 'true');
    assert.ok(wide.anchorName.includes('Choose a setup'));
    assert.equal(wide.primaryTitle, '', 'the wide New control still carries a native title');
    assert.equal(wide.primaryHint, primaryName);
    assert.equal(wide.primaryHintDetail, 'Claude · Opus 5 · high · Auto');
    assert.ok(
      wide.splitHeight <= wide.filterHeight + 1,
      'the wide New split control is taller than the rail filter beside it',
    );
    assert.ok(
      wide.left >= 0 && wide.right <= 1350 && wide.top >= 0 && wide.bottom <= 900,
      'the wide setup menu leaves the viewport',
    );
    await page.keyboard.press('Tab');
    await page.keyboard.press('End');
    assert.equal(await page.evaluate(`document.activeElement.dataset.control`), 'launch:recent:0');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(`document.activeElement.className`), 'railnewmenu');

    await page.click('#rail .railnewmenu');
    await page.evaluate(SETTLED);
    await page.keyboard.press('Tab');
    await page.keyboard.press('End');
    assert.equal(await page.evaluate(`document.activeElement.dataset.control`), 'launch:recent:0');
    await page.evaluate(
      `document.getElementById('list').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`,
    );
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await page.evaluate(`({
      hidden: document.getElementById('launcher').hidden,
      focusIsBody: document.activeElement === document.body,
    })`),
      { hidden: true, focusIsBody: true },
      'clicking elsewhere leaves the setup chooser open or its control focused',
    );

    await page.click('#rail .railnewmenu');
    await page.evaluate(SETTLED);
    await page.setViewportSize({ width: 340, height: 900 });
    await page.waitForFunction(
      `document.getElementById('launcher').hidden && document.activeElement.className === 'compactnewmenu'`,
    );
    assert.deepEqual(
      await page.evaluate(`({
      hidden: document.getElementById('launcher').hidden,
      focus: document.activeElement.className,
    })`),
      { hidden: true, focus: 'compactnewmenu' },
      'crossing into the narrow layout does not return focus to its New menu button',
    );

    await page.click('.controls .compactnewmenu');
    await page.evaluate(SETTLED);
    await page.setViewportSize({ width: 1350, height: 900 });
    await page.waitForFunction(
      `document.getElementById('launcher').hidden && document.activeElement.className === 'railnewmenu'`,
    );
    assert.deepEqual(
      await page.evaluate(`({
      hidden: document.getElementById('launcher').hidden,
      focus: document.activeElement.className,
    })`),
      { hidden: true, focus: 'railnewmenu' },
      'crossing into the wide layout does not return focus to its New menu button',
    );

    await page.setViewportSize({ width: 340, height: 900 });
    await page.evaluate(`window.postMessage(${JSON.stringify(renderPayload())}, '*')`);
    await page.evaluate(SETTLED);
    await page.click('.controls .compactnewmenu');
    await page.evaluate(SETTLED);
    const narrow = (await page.evaluate(`(() => {
      const pop = document.getElementById('launcher');
      const rail = document.getElementById('rail');
      const box = pop.getBoundingClientRect();
      const create = pop.querySelector('[data-control="launch-create"]');
      const primary = document.querySelector('.controls .compactnew');
      const anchor = document.querySelector('.controls .compactnewmenu');
      const picker = document.querySelector('.controls select');
      const controls = document.querySelector('.controls').getBoundingClientRect();
      const pickerBox = picker && picker.getBoundingClientRect();
      const primaryBox = primary.getBoundingClientRect();
      return {
        railHidden: rail.hidden || getComputedStyle(rail).display === 'none',
        hidden: pop.hidden, role: pop.getAttribute('role'), fields: pop.querySelectorAll('[role="combobox"]').length,
        left: box.left, right: box.right, top: box.top, bottom: box.bottom,
        createName: create.getAttribute('aria-label'), scroll: pop.scrollWidth, client: pop.clientWidth,
        anchorExpanded: anchor.getAttribute('aria-expanded'), anchorName: anchor.getAttribute('aria-label'),
        primaryText: primary.textContent, primaryTitle: primary.title,
        primaryHint: primary.dataset.hint, primaryHintDetail: primary.dataset.hintDetail,
        primaryRight: primaryBox.right, pickerLeft: pickerBox && pickerBox.left,
        controlsLeft: controls.left, controlsRight: controls.right,
      };
    })()`)) as {
      railHidden: boolean;
      hidden: boolean;
      role: string;
      fields: number;
      left: number;
      right: number;
      top: number;
      bottom: number;
      createName: string;
      scroll: number;
      client: number;
      anchorExpanded: string;
      anchorName: string;
      primaryText: string;
      primaryTitle: string;
      primaryHint: string;
      primaryHintDetail: string;
      primaryRight: number;
      pickerLeft: number;
      controlsLeft: number;
      controlsRight: number;
    };
    assert.equal(narrow.railHidden, true);
    assert.equal(narrow.hidden, false);
    assert.equal(narrow.role, 'dialog');
    assert.equal(narrow.fields, 4, 'the launcher does not keep four setting fields');
    assert.equal(narrow.anchorExpanded, 'true');
    assert.ok(narrow.anchorName.includes('Choose a setup'));
    assert.equal(narrow.primaryText, 'New');
    assert.equal(narrow.primaryTitle, '', 'the compact New control still carries a native title');
    assert.equal(narrow.primaryHint, primaryName);
    assert.equal(narrow.primaryHintDetail, 'Claude · Opus 5 · high · Auto');
    assert.ok(
      narrow.primaryRight <= narrow.pickerLeft + 1,
      'the compact New control is not left of the narrowed session picker',
    );
    assert.ok(
      narrow.controlsLeft >= 0 && narrow.controlsRight <= 340,
      'the picker, compact New control, and Project cost leave the narrow control bar',
    );
    for (const fact of ['Agent:', 'Model:', 'Effort:', 'Permissions:']) {
      assert.ok(narrow.createName.includes(fact), `the custom Create name omits ${fact}`);
    }
    assert.ok(
      narrow.left >= 0 && narrow.right <= 340 && narrow.top >= 0 && narrow.bottom <= 900,
      'the narrow setup picker leaves the viewport',
    );
    assert.ok(narrow.scroll <= narrow.client + 1, 'the narrow setup picker scrolls sideways');

    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    const empty = renderPayload() as { sessions: unknown[]; rail: unknown[]; cards: unknown[]; showing: string };
    empty.sessions = [];
    empty.rail = [];
    empty.cards = [];
    empty.showing = '';
    await page.setViewportSize({ width: 340, height: 900 });
    await page.evaluate(`window.postMessage(${JSON.stringify(empty)}, '*')`);
    await page.evaluate(SETTLED);
    await page.click('.controls .compactnewmenu');
    await page.evaluate(SETTLED);
    await page.setViewportSize({ width: 1350, height: 900 });
    await page.waitForFunction(
      `document.getElementById('launcher').hidden && !document.getElementById('rail').hidden && document.activeElement.className === 'railnewmenu'`,
    );
    assert.deepEqual(
      await page.evaluate(`({
      hidden: document.getElementById('launcher').hidden,
      railHidden: document.getElementById('rail').hidden,
      focus: document.activeElement.className,
    })`),
      { hidden: true, railHidden: false, focus: 'railnewmenu' },
      'an empty wide rail does not take focus to its visible New menu button',
    );
    assert.deepEqual(failures, [], 'the panel threw while opening the setup menu');
  } finally {
    await browser.close();
  }
});

// Usage refreshes must preserve the open New session menu, its field element, and focus.

test('a repaint leaves the open setup form and its focus alone', { timeout: 60_000 }, async (t) => {
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
    const payload = renderPayload();
    const usage = JSON.stringify((payload as { usage: unknown }).usage);

    await page.click('#rail .railnewmenu');
    await page.evaluate(SETTLED);
    // Retain the field element itself. Its control name cannot detect replacement by an identically named field.

    const fieldControl = (await page.evaluate(`(() => {
      const field = document.querySelector('#launcher [data-control="launch-permissions"]');
      field.focus();
      window.__field = field;
      return field.dataset.control;
    })()`)) as string;

    await page.evaluate(`window.postMessage({ type: 'usage', usage: ${usage} }, '*')`);
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await page.evaluate(`({
      kept: window.__field.isConnected,
      focused: document.activeElement === window.__field,
    })`),
      { kept: true, focused: true },
      'a usage message rebuilds the open setup form and takes the reader off the field',
    );

    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await page.evaluate(`({
      kept: window.__field.isConnected,
      focused: document.activeElement === window.__field,
    })`),
      { kept: true, focused: true },
      'a render rebuilds the open setup form and takes the reader off the field',
    );

    // Changed setup rows must still update the open menu.

    assert.equal(
      await page.evaluate(`document.querySelectorAll('#launcher .launchlist .launchrow').length`),
      1,
      'the custom fields hide the setup rows',
    );
    const grown = JSON.parse(usage) as { launcher: { recent: { key: string }[] } };
    grown.launcher.recent = [
      ...grown.launcher.recent,
      ...grown.launcher.recent.map((row) => ({ ...row, key: `${row.key}:again` })),
    ];
    await page.evaluate(`window.postMessage({ type: 'usage', usage: ${JSON.stringify(grown)} }, '*')`);
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await page.evaluate(`({
      rows: document.querySelectorAll('#launcher .launchlist .launchrow').length,
      focus: document.activeElement.dataset.control,
    })`),
      { rows: 2, focus: fieldControl },
      'a setup menu that gained a row loses the row or the control the reader was standing on',
    );

    // Remove the inherited setup while its row holds focus. Focus must move to another menu control.

    await page.evaluate(`document.querySelector('#launcher [data-control="launch:current"]').focus()`);
    const orphaned = JSON.parse(usage) as { launcher: { inherited: unknown; primary: unknown } };
    orphaned.launcher.inherited = null;
    orphaned.launcher.primary = null;
    await page.evaluate(`window.postMessage({ type: 'usage', usage: ${JSON.stringify(orphaned)} }, '*')`);
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await page.evaluate(`({
      rows: document.querySelectorAll('#launcher .launchlist .launchrow').length,
      focus: document.activeElement.dataset.control,
    })`),
      { rows: 1, focus: 'launch:recent:0' },
      'a redraw that removes the row under the reader leaves the setup menu unreachable',
    );

    // Changing usage-bar age must preserve the open prompt-box picker and its focus.

    await page.keyboard.press('Escape');
    await page.evaluate(SETTLED);
    await page.click('.cpick');
    await page.evaluate(SETTLED);
    await page.evaluate(`(() => {
      const trigger = document.querySelector('[data-control="model"]');
      trigger.focus();
      window.__row = trigger;
    })()`);
    const moved = JSON.parse(usage) as { bar: { age: string } };
    moved.bar.age = `${moved.bar.age} and a moment`;
    await page.evaluate(`window.postMessage({ type: 'usage', usage: ${JSON.stringify(moved)} }, '*')`);
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await page.evaluate(`({
      kept: window.__row.isConnected,
      focused: document.activeElement === window.__row,
      hidden: document.getElementById('composer-model-list').hidden,
    })`),
      { kept: true, focused: true, hidden: false },
      'a figure moving elsewhere in the foot rebuilds the composer menu under the reader',
    );
    assert.deepEqual(failures, [], 'the panel threw while repainting the setup menu');
  } finally {
    await browser.close();
  }
});

test('new-session controls share the panel picker typography', { timeout: 60_000 }, async (t) => {
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

    const quietControl = (await page.evaluate(`(() => {
      const node = document.querySelector('.cpick');
      if (!node) return null;
      const style = getComputedStyle(node);
      return { family: style.fontFamily, size: style.fontSize };
    })()`)) as { family: string; size: string } | null;
    assert.ok(quietControl, 'the existing compact picker drew no control to compare the rail against');

    await page.click('.cpick');
    await page.evaluate(SETTLED);
    const picker = (await page.evaluate(`(() => {
      const node = document.querySelector('#composer-model-list .pickrow');
      if (!node) return null;
      const style = getComputedStyle(node);
      return { family: style.fontFamily, size: style.fontSize };
    })()`)) as { family: string; size: string } | null;
    assert.ok(picker, 'the existing picker drew no row to compare the launcher against');

    await page.click('#rail .railnewmenu');
    await page.evaluate(SETTLED);
    const defaultLauncher = (await page.evaluate(`(() => {
      const type = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const style = getComputedStyle(node);
        return { family: style.fontFamily, size: style.fontSize };
      };
      const heading = document.querySelector('#launcher .launchhead');
      const headingStyle = heading ? getComputedStyle(heading) : null;
      return {
        railNew: type('#rail .railnew'),
        railMenu: type('#rail .railnewmenu'),
        heading: type('#launcher .launchhead'),
        preset: type('#launcher .launchrow'),
        description: type('#launcher .launchdetail'),
        headingCase: headingStyle ? headingStyle.textTransform : null,
        headingSpacing: headingStyle ? headingStyle.letterSpacing : null,
        headingWeight: headingStyle ? headingStyle.fontWeight : null,
      };
    })()`)) as {
      railNew: typeof picker;
      railMenu: typeof picker;
      heading: typeof picker;
      preset: typeof picker;
      description: typeof picker;
      headingCase: string | null;
      headingSpacing: string | null;
      headingWeight: string | null;
    };
    assert.deepEqual(
      defaultLauncher.railNew,
      quietControl,
      'the rail New button typography differs from the existing compact picker controls',
    );
    assert.deepEqual(
      defaultLauncher.railMenu,
      quietControl,
      'the rail New menu typography differs from the existing compact picker controls',
    );
    for (const [part, type] of Object.entries(defaultLauncher).filter(([part]) =>
      ['heading', 'preset', 'description'].includes(part),
    )) {
      assert.deepEqual(type, picker, `the default launcher's ${part} typography differs from the existing picker`);
    }
    assert.equal(defaultLauncher.headingCase, 'none', 'the default launcher heading is no longer in ordinary casing');
    assert.equal(
      defaultLauncher.headingSpacing,
      'normal',
      'the default launcher heading no longer uses ordinary letter spacing',
    );
    assert.equal(
      defaultLauncher.headingWeight,
      '600',
      'the default launcher heading no longer keeps its established weight',
    );

    const customLauncher = (await page.evaluate(`(() => {
      const type = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const style = getComputedStyle(node);
        return { family: style.fontFamily, size: style.fontSize };
      };
      return {
        heading: type('#launcher .launchhead'),
        field: type('#launcher .launchfieldname'),
        select: type('#launcher .choice-trigger'),
        create: type('#launcher .launchcreate'),
      };
    })()`)) as Record<string, typeof picker>;
    for (const [part, type] of Object.entries(customLauncher)) {
      assert.deepEqual(type, picker, `the custom launcher's ${part} typography differs from the existing picker`);
    }
    assert.deepEqual(failures, [], 'the panel threw while measuring new-session typography');
  } finally {
    await browser.close();
  }
});

test('an unopened rail hint keeps its delay when the pointer crosses to a sibling', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(pageHtml());
    await layoutAt(page, 1350);
    await page.clock.pauseAt(Number(await page.evaluate('Date.now()')) + 1_000);
    const row = page.locator('#rail .railrow').first();
    await row.locator('.raillabelact').hover();
    await page.clock.fastForward(100);
    await row.locator('.railpin').hover();
    await page.clock.fastForward(60);
    assert.equal(
      await page.locator('#hintpop').evaluate((node) => 'hidden' in node && node.hidden),
      true,
      'crossing an unopened hint makes the sibling flash before its own delay',
    );
    await page.clock.fastForward(300);
    assert.equal(
      await page.locator('#hintpop .hinttitle').textContent(),
      'Pin (P)',
      'the delayed sibling hint never opens for the control under the pointer',
    );
  } finally {
    await browser.close();
  }
});

test('pressing an unfocused hinted control leaves its hint closed', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(pageHtml());
    await layoutAt(page, 1350);
    const pin = page.locator('#rail .railrow .railpin').first();
    await pin.click();
    assert.equal(
      await page.evaluate(`document.activeElement === document.querySelector('#rail .railrow .railpin')`),
      true,
      'the browser did not focus the pressed control, so the pointerdown-to-focus path was not exercised',
    );
    assert.equal(
      await page.locator('#hintpop').evaluate((node) => 'hidden' in node && node.hidden),
      true,
      'the focus caused by a pointer press reopens the hint that pointerdown closed',
    );
  } finally {
    await browser.close();
  }
});

test('a lost pointer release does not suppress a later keyboard hint', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(pageHtml());
    await layoutAt(page, 1350);
    const first = await page.evaluate(`(() => {
      const pin = document.querySelector('#rail .railrow .railpin');
      pin.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      pin.focus();
      return { focused: document.activeElement === pin, hidden: document.getElementById('hintpop').hidden };
    })()`);
    assert.deepEqual(
      first,
      { focused: true, hidden: true },
      'the synthetic press did not exercise pointerdown before the focus it causes',
    );
    await page.clock.fastForward(20);
    await page.evaluate(`(() => {
      const pin = document.querySelector('#rail .railrow .railpin');
      pin.blur();
      pin.focus();
    })()`);
    assert.equal(
      await page.locator('#hintpop').evaluate((node) => 'hidden' in node && node.hidden),
      false,
      'a missing pointerup leaves the next keyboard focus unable to open its hint',
    );
  } finally {
    await browser.close();
  }
});

test('Escape from a hint does not also close another panel float', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(pageHtml());
    await layoutAt(page, 1350);
    await page.locator('#list .statdetail').first().click();
    assert.equal(
      await page.locator('#chippop').evaluate((node) => 'hidden' in node && node.hidden),
      false,
      'the fixture opened no pinned chip float, so Escape has no second listener to reach',
    );
    await page.locator('#rail .railrow .railhide').first().hover();
    await page.clock.fastForward(350);
    assert.equal(
      await page.locator('#hintpop').evaluate((node) => 'hidden' in node && node.hidden),
      false,
      'the hint did not open over the pinned chip float',
    );
    // Check painting order where the control hint overlaps a pinned figure popover. Open state alone cannot identify the top layer.

    const floatStack = (await page.evaluate(`(() => {
      const stat = document.getElementById('chippop');
      const hint = document.getElementById('hintpop');
      const statStyle = stat.getAttribute('style');
      const hintStyle = hint.getAttribute('style');
      for (const pop of [stat, hint]) {
        pop.style.left = '20px';
        pop.style.top = '20px';
        pop.style.width = '200px';
      }
      hint.style.pointerEvents = 'auto';
      const stack = [...new Set(document.elementsFromPoint(25, 25)
        .map((node) => node.closest?.('.pop')?.id).filter(Boolean))];
      if (statStyle === null) stat.removeAttribute('style'); else stat.setAttribute('style', statStyle);
      if (hintStyle === null) hint.removeAttribute('style'); else hint.setAttribute('style', hintStyle);
      return stack;
    })()`)) as string[];
    assert.deepEqual(
      floatStack.slice(0, 2),
      ['hintpop', 'chippop'],
      'the pinned stat paints over the overlapping control hint',
    );
    // The hint must remain a body child for its stacking order to apply.
    assert.equal(
      await page.evaluate(`document.getElementById('hintpop').parentElement === document.body`),
      true,
      'the hint box left the body, where its layer ranks over every popover',
    );
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#hintpop').evaluate((node) => 'hidden' in node && node.hidden), true);
    assert.equal(
      await page.locator('#chippop').evaluate((node) => 'hidden' in node && node.hidden),
      false,
      'hint Escape reaches a later document listener and closes the pinned chip float too',
    );
  } finally {
    await browser.close();
  }
});

test('rail hints stay beside their controls without moving the row', { timeout: 60_000 }, async (t) => {
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
    const launcherMenu = page.locator('#rail .railnewmenu');
    await launcherMenu.hover();
    await page.clock.fastForward(350);
    const launcherHint = (await page.evaluate(`(() => {
      const pop = document.getElementById('hintpop');
      const anchor = document.querySelector('#rail .railnewmenu');
      const primary = document.querySelector('#rail .railnew');
      const p = pop.getBoundingClientRect();
      const a = anchor.getBoundingClientRect();
      const n = primary.getBoundingClientRect();
      const detail = pop.querySelector('.hintdetail');
      return {
        hidden: pop.hidden,
        title: pop.querySelector('.hinttitle')?.textContent,
        detailHidden: detail?.hidden,
        detail: detail?.textContent,
        describedBy: anchor.getAttribute('aria-describedby'),
        left: p.left, top: p.top, right: p.right, bottom: p.bottom,
        anchorLeft: a.left, anchorBottom: a.bottom,
        primaryIntersects: p.left < n.right && p.right > n.left && p.top < n.bottom && p.bottom > n.top,
      };
    })()`)) as {
      hidden: boolean;
      title: string;
      detailHidden: boolean;
      detail: string;
      describedBy: string | null;
      left: number;
      top: number;
      right: number;
      bottom: number;
      anchorLeft: number;
      anchorBottom: number;
      primaryIntersects: boolean;
    };
    assert.equal(launcherHint.hidden, false, 'hovering the wide setup caret opens no hint');
    assert.equal(launcherHint.title, 'Choose a setup for a new session');
    assert.equal(launcherHint.detailHidden, true, 'the setup caret hint leaves a blank detail line visible');
    assert.equal(launcherHint.detail, '');
    assert.equal(launcherHint.describedBy, null, 'the setup caret describes itself with its own accessible name');
    assert.ok(
      Math.abs(launcherHint.left - launcherHint.anchorLeft) <= 1,
      'the setup caret hint left edge does not follow the caret',
    );
    assert.ok(
      Math.abs(launcherHint.top - launcherHint.anchorBottom - 6) <= 1,
      'the setup caret hint does not stand six pixels below the caret',
    );
    assert.ok(
      launcherHint.left >= 0 && launcherHint.right <= 1350 && launcherHint.top >= 0 && launcherHint.bottom <= 900,
      'the setup caret hint leaves the viewport',
    );
    assert.equal(launcherHint.primaryIntersects, false, 'the setup caret hint covers the primary New button');
    await page.keyboard.press('Escape');
    assert.equal(
      await page.locator('#hintpop').evaluate((node) => 'hidden' in node && node.hidden),
      true,
      'Escape leaves the setup caret hint open',
    );

    const row = page.locator('#rail .railrow').first();
    const before = await row.boundingBox();
    await row.locator('.railhide').hover();
    await page.clock.fastForward(350);
    const archive = (await page.evaluate(`(() => {
      const pop = document.getElementById('hintpop');
      const row = document.querySelector('#rail .railrow');
      const anchor = row.querySelector('.railhide');
      const sibling = row.querySelector('.railpin');
      const p = pop.getBoundingClientRect();
      const a = anchor.getBoundingClientRect();
      const s = sibling.getBoundingClientRect();
      return {
        hidden: pop.hidden, title: pop.querySelector('.hinttitle')?.textContent,
        detail: pop.querySelector('.hintdetail')?.textContent,
        left: p.left, top: p.top, right: p.right, bottom: p.bottom,
        anchorLeft: a.left, anchorBottom: a.bottom,
        siblingIntersects: p.left < s.right && p.right > s.left && p.top < s.bottom && p.bottom > s.top,
      };
    })()`)) as {
      hidden: boolean;
      title: string;
      detail: string;
      left: number;
      top: number;
      right: number;
      bottom: number;
      anchorLeft: number;
      anchorBottom: number;
      siblingIntersects: boolean;
    };
    assert.equal(archive.hidden, false, 'hovering Archive past the delay opens no hint');
    assert.equal(archive.title, 'Archive (Delete)');
    assert.equal(archive.detail, 'Moves it to Archived. Nothing is deleted.');
    assert.ok(Math.abs(archive.left - archive.anchorLeft) <= 1, 'the hint left edge does not follow the control');
    assert.ok(
      Math.abs(archive.top - archive.anchorBottom - 6) <= 1,
      'the hint does not stand six pixels below the control',
    );
    assert.ok(
      archive.left >= 0 && archive.right <= 1350 && archive.top >= 0 && archive.bottom <= 900,
      'the wide hint leaves the viewport',
    );
    assert.equal(archive.siblingIntersects, false, 'the hint covers the sibling Pin control');
    assert.deepEqual(await row.boundingBox(), before, 'opening the hint moves or resizes its rail row');

    await row.locator('.railhide').focus();
    await page.keyboard.press('Tab');
    assert.equal(
      await page.evaluate(`document.activeElement.classList.contains('railpin')`),
      true,
      'the keyboard walk did not reach Pin',
    );
    assert.equal(
      await page.locator('#hintpop').evaluate((node) => 'hidden' in node && node.hidden),
      false,
      'keyboard focus waits for the pointer delay before opening Pin',
    );
    const focused = await page.evaluate(`document.activeElement.dataset.control`);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#hintpop').evaluate((node) => 'hidden' in node && node.hidden), true);
    assert.equal(
      await page.evaluate(`document.activeElement.dataset.control`),
      focused,
      'Escape closes the hint by moving focus away from its control',
    );

    await page.setViewportSize({ width: 340, height: 900 });
    await page.evaluate(SETTLED);
    await page.locator('.controls .compactnew').hover();
    await page.clock.fastForward(350);
    const narrow = await page.locator('#hintpop').boundingBox();
    assert.ok(
      narrow && narrow.x >= 0 && narrow.x + narrow.width <= 340 && narrow.y >= 0 && narrow.y + narrow.height <= 900,
      'the compact New hint leaves the narrow viewport',
    );

    await page.setViewportSize({ width: 1350, height: 900 });
    await page.evaluate(SETTLED);
    const lastPin = page.locator('#rail .railrow .railpin').last();
    await lastPin.evaluate((node) => node.scrollIntoView({ block: 'end' }));
    await page.evaluate(SETTLED);
    const lastPinHint = await lastPin.getAttribute('data-hint');
    await lastPin.hover();
    await page.clock.fastForward(350);
    await page.waitForFunction((hint) => {
      const pop = document.getElementById('hintpop');
      return pop instanceof HTMLElement && !pop.hidden && pop.querySelector('.hinttitle')?.textContent === hint;
    }, lastPinHint);
    const foot = (await page.evaluate(`(() => {
      const pop = document.getElementById('hintpop').getBoundingClientRect();
      const anchor = [...document.querySelectorAll('#rail .railrow .railpin')].at(-1).getBoundingClientRect();
      return { popBottom: pop.bottom, anchorTop: anchor.top };
    })()`)) as { popBottom: number; anchorTop: number };
    assert.ok(foot.popBottom <= foot.anchorTop - 5, 'the hint near the rail foot does not stand above its control');

    const nativeTitles = await page.evaluate(`[
      ...document.querySelectorAll('.raillabelact, .railpin, .railhide, .railnew, .compactnew')
    ].filter((node) => node.hasAttribute('title')).length`);
    assert.equal(nativeTitles, 0, 'a hinted control still carries a native browser title');
    assert.deepEqual(failures, [], 'the panel threw while opening and closing rail hints');
  } finally {
    await browser.close();
  }
});

test('the credit cap reflows inside the opened usage popover', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    for (const width of [300, 240]) {
      const page = await browser.newPage();
      const failures: string[] = [];
      page.on('pageerror', (e) => failures.push(String(e)));
      await page.setContent(pageHtml());
      await layoutAt(page, width);
      await page.click('#statusbar .sbrow');
      await page.evaluate(SETTLED);
      const measured = (await page.evaluate(`(() => {
        const pop = document.getElementById('usagepop');
        const lines = [...document.querySelectorAll('.sbline')];
        const cap = lines.find((line) => line.querySelector('.sblabel')?.textContent === 'credits');
        const resetLine = lines.find((line) => line.querySelector('.sbreset'));
        const detail = cap?.querySelector('.sbdetail');
        const label = cap?.querySelector('.sblabel');
        const reset = resetLine?.querySelector('.sbreset');
        const resetLabel = resetLine?.querySelector('.sblabel');
        if (!pop || !cap || !detail || !label || !resetLine || !reset || !resetLabel) return null;
        return {
          hidden: pop.hidden,
          popClient: pop.clientWidth,
          popScroll: pop.scrollWidth,
          lineClient: cap.clientWidth,
          lineScroll: cap.scrollWidth,
          detailRight: detail.getBoundingClientRect().right,
          lineRight: cap.getBoundingClientRect().right,
          detailTop: detail.getBoundingClientRect().top,
          labelTop: label.getBoundingClientRect().top,
          labelClient: label.clientWidth,
          labelScroll: label.scrollWidth,
          resetTop: reset.getBoundingClientRect().top,
          resetLabelTop: resetLabel.getBoundingClientRect().top,
        };
      })()`)) as {
        hidden: boolean;
        popClient: number;
        popScroll: number;
        lineClient: number;
        lineScroll: number;
        detailRight: number;
        lineRight: number;
        detailTop: number;
        labelTop: number;
        labelClient: number;
        labelScroll: number;
        resetTop: number;
        resetLabelTop: number;
      } | null;
      assert.ok(measured, `the opened popover at ${width}px has no credit-cap or reset line`);
      assert.equal(measured.hidden, false, `the usage popover stayed hidden at ${width}px`);
      assert.ok(
        measured.popScroll <= measured.popClient + 1,
        `the popover is ${measured.popScroll}px wide inside ${measured.popClient}px at ${width}px`,
      );
      assert.ok(
        measured.lineScroll <= measured.lineClient + 1,
        `the credit line is ${measured.lineScroll}px wide inside ${measured.lineClient}px at ${width}px`,
      );
      assert.ok(measured.detailRight <= measured.lineRight + 1, `the money detail ends outside its line at ${width}px`);
      assert.ok(
        measured.labelScroll <= measured.labelClient + 1,
        `credits is cut inside its ${measured.labelClient}px label column at ${width}px`,
      );
      if (width === 300) {
        assert.ok(
          Math.abs(measured.resetTop - measured.resetLabelTop) <= 1,
          'the ordinary reset wrapped at the popover normal width',
        );
      } else {
        assert.ok(
          measured.detailTop > measured.labelTop,
          'the narrow money detail did not reflow, so it can only fit by overflowing',
        );
      }
      assert.deepEqual(failures, [], `the panel threw while drawing the cap at ${width}px`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('a stat detail opens as a readable tooltip inside the viewport', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (e) => failures.push(String(e)));
    await page.setContent(themed(pageHtml()));
    for (const width of [340, 1350]) {
      await layoutAt(page, width);
      const payload = renderPayload() as { cards: { chips: Record<string, unknown>[] }[] };
      const entries = [
        {
          label: 'Main agent · sol',
          value: '$12',
          lines: [
            {
              text: 'Cached input reads: $50',
              cost: true,
              cacheHit: { percent: 94, warning: false, requestScale: [206, 488_000] },
            },
            { text: 'Uncached input: $2.64', cost: true },
            '120k written',
          ],
        },
        ...Array.from({ length: 8 }, (_, index) => ({
          label: `review_agent_${index + 1} · ${index % 2 ? 'terra' : 'sol'}`,
          value: `$${(index + 1).toFixed(2)}`,
          lines: [`${index + 2} tools`, `${index + 1}00k tokens`],
        })),
      ];
      const cost = payload.cards[0].chips.find((chip) => String(chip.label).startsWith('$'))!;
      cost.detail = 'Estimated total: $48.00\nMain agent: $12.00';
      cost.detailList = {
        heading: { label: 'Estimated total', value: '$48' },
        entries,
        footer: ['An estimate against list price.'],
      };
      payload.cards[0].chips.push({
        kind: 'plain',
        label: '8 agents',
        detail: 'Eight agents',
        detailList: { heading: { label: '8 subagents' }, entries: entries.slice(1) },
      });
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);
      const shown = (await page.evaluate(`(() => {
        const chip = document.querySelector('#list .turn .chips .has-detail');
        if (!chip) return { error: 'the card drew no chip with detail' };
        chip.dispatchEvent(new PointerEvent('pointerenter'));
        const pop = document.getElementById('chippop');
        const box = pop.getBoundingClientRect();
        const scaleLine = pop.querySelector('.chippopsubitem.chippopcost');
        const plainCostLine = pop.querySelectorAll('.chippopsubitem.chippopcost')[1];
        const scale = pop.querySelector('.chippopscale');
        return {
          hidden: pop.hidden,
          role: pop.getAttribute('role'),
          chipTag: chip.tagName,
          listTag: pop.querySelector('.chippoplist')?.tagName,
          items: pop.querySelectorAll('.chippopitem').length,
          values: pop.querySelectorAll('.chippopvalue').length,
          title: chip.getAttribute('title'),
          left: box.left, top: box.top, right: box.right, bottom: box.bottom,
          width: box.width, chipWidth: chip.getBoundingClientRect().width,
          viewportWidth: innerWidth, viewportHeight: innerHeight,
          position: getComputedStyle(pop).position,
          pointerEvents: getComputedStyle(pop).pointerEvents,
          fontSize: getComputedStyle(pop).fontSize,
          bodyFontSize: getComputedStyle(document.body).fontSize,
          foreground: scaleLine ? getComputedStyle(scaleLine).color : null,
          panelForeground: getComputedStyle(document.body).color,
          scaleTone: scale ? getComputedStyle(scale).color : null,
          scaleText: scaleLine?.textContent ?? null,
          scaleSuffix: scale?.textContent ?? null,
          nestedCostLists: pop.querySelectorAll('.chippopcost > .chippopsublist').length,
          plainCostText: plainCostLine?.textContent ?? null,
          plainCostTone: plainCostLine ? getComputedStyle(plainCostLine).color : null,
        };
      })()`)) as {
        error?: string;
        hidden: boolean;
        role: string | null;
        chipTag: string;
        listTag: string;
        items: number;
        values: number;
        title: string | null;
        fontSize: string;
        bodyFontSize: string;
        foreground: string | null;
        panelForeground: string;
        scaleTone: string | null;
        scaleText: string | null;
        scaleSuffix: string | null;
        nestedCostLists: number;
        plainCostText: string | null;
        plainCostTone: string | null;
        left: number;
        top: number;
        right: number;
        bottom: number;
        width: number;
        chipWidth: number;
        viewportWidth: number;
        viewportHeight: number;
        position: string;
        pointerEvents: string;
      };
      assert.equal(shown.error, undefined, shown.error);
      assert.equal(shown.hidden, false, `hovering a stat opens no tooltip at ${width}px`);
      assert.equal(shown.role, 'tooltip', `the stat detail has the wrong role at ${width}px`);
      assert.equal(shown.chipTag, 'BUTTON', `the stat detail cannot be reached by keyboard at ${width}px`);
      assert.equal(shown.listTag, 'UL', `the agent costs are not a semantic list at ${width}px`);
      assert.equal(shown.items, 9, `the cost breakdown dropped an agent at ${width}px`);
      assert.equal(shown.values, 10, `the cost values are not separated from their labels at ${width}px`);
      assert.equal(shown.title, null, `the native title bubble still competes with the tooltip at ${width}px`);
      assert.equal(shown.position, 'fixed', `the tooltip moves the page at ${width}px`);
      assert.equal(shown.pointerEvents, 'none', `the tooltip traps the pointer at ${width}px`);
      assert.equal(shown.fontSize, shown.bodyFontSize, `the tooltip text is smaller than the panel text at ${width}px`);
      assert.equal(shown.foreground, shown.panelForeground, `the cached-read dollar figure stays muted at ${width}px`);
      assert.ok(
        shown.scaleTone && shown.scaleTone !== shown.foreground,
        `the request count is ${shown.scaleTone} beside ${shown.foreground} at ${width}px`,
      );
      assert.equal(
        shown.scaleText,
        'Cached input reads: $50 (94% cached · 206 requests · 488k avg input)',
        `the visible cost and request facts drift at ${width}px`,
      );
      assert.equal(
        shown.scaleSuffix,
        ' (94% cached · 206 requests · 488k avg input)',
        `the muted cached-read detail drops a fact at ${width}px`,
      );
      assert.equal(shown.nestedCostLists, 0, `the compact cached-read line grows nested bullets at ${width}px`);
      assert.equal(shown.plainCostText, 'Uncached input: $2.64', `the unscaled cost row drops its text at ${width}px`);
      assert.equal(
        shown.plainCostTone,
        shown.panelForeground,
        `the unscaled cost row does not use the foreground tone at ${width}px`,
      );
      assert.ok(
        shown.width > shown.chipWidth,
        `the tooltip is no wider than its chip at ${width}px, so the breakdown stays cramped`,
      );
      assert.ok(shown.left >= 5 && shown.top >= 5, `the tooltip starts outside the viewport at ${width}px`);
      assert.ok(
        shown.right <= shown.viewportWidth - 5 && shown.bottom <= shown.viewportHeight - 5,
        `the tooltip ends outside the viewport at ${width}px`,
      );
      const costChip = page.locator('#list .turn .chips .has-detail').first();
      await costChip.focus();
      await page.keyboard.press('Enter');
      const pinned = (await page.evaluate(`(() => {
        const chip = document.querySelector('#list .turn .chips .has-detail');
        chip.dispatchEvent(new PointerEvent('pointerleave'));
        const pop = document.getElementById('chippop');
        const range = document.createRange();
        range.selectNodeContents(pop.querySelector('.chippopitem'));
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return {
          hidden: pop.hidden,
          pointerEvents: getComputedStyle(pop).pointerEvents,
          selected: selection.toString(),
          pressed: chip.getAttribute('aria-pressed'),
        };
      })()`)) as { hidden: boolean; pointerEvents: string; selected: string; pressed: string };
      assert.equal(pinned.hidden, false, `a pressed tooltip closes when the pointer leaves at ${width}px`);
      assert.equal(pinned.pointerEvents, 'auto', `a pressed tooltip still blocks text selection at ${width}px`);
      assert.match(pinned.selected, /Main agent/, `the pressed tooltip text cannot be selected at ${width}px`);
      assert.equal(pinned.pressed, 'true', `Enter did not pin the focused tooltip at ${width}px`);
      const agents = (await page.evaluate(`(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const costChip = document.querySelector('#list .turn .chips .has-detail');
        const chip = [...document.querySelectorAll('#list .turn .chips .has-detail')]
          .find((node) => node.textContent === '8 agents');
        chip.dispatchEvent(new PointerEvent('pointerenter'));
        const pop = document.getElementById('chippop');
        return {
          hidden: pop.hidden,
          heading: pop.querySelector('.chippophead')?.textContent,
          items: pop.querySelectorAll('.chippopitem').length,
          values: [...pop.querySelectorAll('.chippopvalue')].map((node) => node.textContent),
          oldDescription: costChip.getAttribute('aria-describedby'),
          oldPressed: costChip.getAttribute('aria-pressed'),
        };
      })()`)) as {
        hidden: boolean;
        heading: string;
        items: number;
        values: string[];
        oldDescription: string | null;
        oldPressed: string | null;
      };
      assert.equal(agents.hidden, false, `the agents chip opens no tooltip at ${width}px`);
      assert.equal(agents.oldDescription, null, `the cost chip points at the agents description at ${width}px`);
      assert.equal(agents.oldPressed, 'false', `Escape left the cost chip marked as pinned at ${width}px`);
      assert.equal(agents.heading, '8 subagents', `the agents list has no useful heading at ${width}px`);
      assert.equal(agents.items, 8, `the agents chip dropped an agent at ${width}px`);
      assert.deepEqual(
        agents.values,
        ['$1.00', '$2.00', '$3.00', '$4.00', '$5.00', '$6.00', '$7.00', '$8.00'],
        `the agents chip does not align one cost with every agent at ${width}px`,
      );
      await page.locator('#list .turn .chips .has-detail').filter({ hasText: '8 agents' }).click();
      payload.cards[0].chips = payload.cards[0].chips.filter((chip) => chip.label !== '8 agents');
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);
      assert.equal(
        await page.locator('#chippop').evaluate((node) => 'hidden' in node && node.hidden),
        true,
        `replacing a pinned chip leaves its stale tooltip open at ${width}px`,
      );
    }
    assert.deepEqual(failures, [], 'the panel threw while drawing a stat tooltip');
  } finally {
    await browser.close();
  }
});

test('a commented line wears its mark in the card own indent', { timeout: 60_000 }, async (t) => {
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

    // Check comment-mark indentation at sidebar and editor-tab widths.

    for (const width of [300, 1350]) {
      const at = await markedLayout(page, width);
      assert.deepEqual(failures, [], `the panel threw while drawing the marks at ${width}px`);
      assert.equal(
        at.marks.length,
        2,
        `at ${width}px the panel drew ${at.marks.length} marks for comments on two lines`,
      );
      for (const mark of at.marks) {
        assert.ok(
          mark.width > 0 && mark.height > 0,
          `at ${width}px a mark is drawn at no size, so nothing on the line says a comment is there`,
        );
        assert.equal(mark.visibility, 'visible', `at ${width}px a mark is drawn invisible`);
        // Keep each mark inside the card and left of the response text.

        assert.ok(
          mark.left >= at.card.left,
          `at ${width}px a mark starts at ${Math.round(mark.left)} with the card at ` +
            `${Math.round(at.card.left)}, so it hangs off the card left edge`,
        );
      }
      const [onSummary, onPrompt] = at.marks;
      assert.ok(
        onSummary.right <= at.para.left,
        `at ${width}px the mark ends at ${Math.round(onSummary.right)} and the line it marks starts at ` +
          `${Math.round(at.para.left)}, so the mark is drawn over the response`,
      );
      // Each mark must align with the line it annotates.

      assert.ok(
        Math.abs(onSummary.top - at.para.top) <= 4,
        `at ${width}px the mark sits at ${Math.round(onSummary.top)} and its line at ` +
          `${Math.round(at.para.top)}, so the mark is beside the wrong line`,
      );
      assert.ok(
        Math.abs(onPrompt.top - at.prompt.top) <= 4,
        `at ${width}px the mark on the prompt sits at ${Math.round(onPrompt.top)} and the prompt at ` +
          `${Math.round(at.prompt.top)}. The prompt is drawn clamped, and a mark inside that clamp is cut away`,
      );
      // Comment marks must leave the text position unchanged.

      assert.ok(
        Math.abs(at.para.left - at.prompt.left) <= 1,
        `at ${width}px the marked response starts at ${Math.round(at.para.left)} and the prompt at ` +
          `${Math.round(at.prompt.left)}, so a mark moves the line it is on`,
      );
      // The mark count must stay outside the annotated text used for quote matching.
      assert.ok(
        !at.paraText.includes('2'),
        'the mark wrote its count into the line, so the walk that placed it can no longer find the line',
      );

      // Marks extend left of the text without widening the panel.

      assert.ok(
        at.documentWidth <= at.viewportWidth + 1,
        `at ${width}px the panel scrolls sideways once a turn has comments on it: ` +
          `${at.documentWidth} wide in a ${at.viewportWidth} viewport`,
      );

      // Opening a mark must place its comment list inside the narrow panel.

      const opened = (await page.evaluate(`(() => {
        document.querySelector('.linemark').click();
        const float = document.querySelector('.markfloat');
        if (!float || float.hidden) return null;
        const r = float.getBoundingClientRect();
        return {
          rows: float.children.length,
          left: r.left, right: r.right, top: r.top, bottom: r.bottom,
          expanded: document.querySelector('.linemark').getAttribute('aria-expanded'),
        };
      })()`)) as { rows: number; left: number; right: number; top: number; bottom: number; expanded: string } | null;
      assert.ok(opened, `at ${width}px a press on a mark opens nothing, so the comments on that line cannot be read`);
      assert.equal(
        opened.rows,
        2,
        `at ${width}px the panel a mark opened drew ${opened.rows} of the 2 comments on the line`,
      );
      assert.equal(opened.expanded, 'true', `at ${width}px the mark does not say it is open`);
      assert.ok(
        opened.left >= 0 && opened.right <= width,
        `at ${width}px the panel a mark opened runs from ${Math.round(opened.left)} to ` +
          `${Math.round(opened.right)}, off the edge of a ${width}px panel`,
      );
      assert.ok(
        opened.top >= 0 && opened.bottom <= 900,
        `at ${width}px the panel a mark opened runs from ${Math.round(opened.top)} to ` +
          `${Math.round(opened.bottom)}, off the top or bottom of the panel`,
      );
    }
  } finally {
    await browser.close();
  }
});

test('archive sits left of the rightmost pin on a rail card', { timeout: 60_000 }, async (t) => {
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

    const CONTROLS = `(() => {
      const row = document.querySelector('.railrow');
      const archive = row && row.querySelector('.railhide');
      const pin = row && row.querySelector('.railpin');
      if (!row || !archive || !pin) return null;
      const box = (node) => {
        const r = node.getBoundingClientRect();
        return { left: r.left, right: r.right };
      };
      return { row: box(row), archive: box(archive), pin: box(pin) };
    })()`;
    type Controls = {
      row: { left: number; right: number };
      archive: { left: number; right: number };
      pin: { left: number; right: number };
    };

    for (const width of [1350, 820]) {
      await layoutAt(page, width);
      const controls = (await page.evaluate(CONTROLS)) as Controls | null;
      assert.deepEqual(failures, [], `the panel threw while drawing rail controls at ${width}px`);
      assert.ok(controls, `the rail drew no card with archive and pin controls at ${width}px`);
      assert.ok(
        controls.archive.right <= controls.pin.left,
        `archive runs from ${Math.round(controls.archive.left)} to ${Math.round(controls.archive.right)}px ` +
          `and pin starts at ${Math.round(controls.pin.left)}px at ${width}px`,
      );
      assert.ok(
        controls.pin.right <= controls.row.right,
        `pin ends at ${Math.round(controls.pin.right)}px outside a row ending at ${Math.round(controls.row.right)}px ` +
          `at ${width}px`,
      );
      assert.ok(controls.pin.right > controls.archive.right, `pin is not the rightmost control at ${width}px`);
    }
  } finally {
    await browser.close();
  }
});

// The session heading shows every label and allows wrapping. Its label editor must open beside the heading control.

test(
  'the session labels sit under the heading figures and open the editor against their own line',
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
      await layoutAt(page, 1350);

      const LINE = `(() => {
        const row = document.querySelector('#list .sessionrow');
        const line = row && row.querySelector('.sessionlabels');
        const lower = row && row.querySelector('.sessionlower');
        const button = line && line.querySelector('.sessionlabelact');
        if (!line || !lower || !button) return null;
        const rect = (node) => {
          const box = node.getBoundingClientRect();
          return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, height: box.height };
        };
        const chips = [...line.querySelectorAll('.sessionlabel')];
        const boxes = chips.map(rect);
        const box = rect(lower);
        const style = getComputedStyle(lower);
        const inside = {
          left: box.left + parseFloat(style.paddingLeft),
          right: box.right - parseFloat(style.paddingRight),
        };
        const stats = row.querySelector('.sessionstats');
        const card = document.querySelector('#list .turn');
        const held = [...row.children];
        const figuresAt = held.findIndex((node) => node.classList.contains('sessionstats'));
        const labelsAt = held.findIndex((node) => node.classList.contains('sessionlower'));
        return {
          chips: chips.map((chip) => chip.textContent),
          titles: chips.map((chip) => chip.getAttribute('title')),
          hints: chips.map((chip) => chip.getAttribute('data-hint')),
          said_chips: chips.map((chip) => chip.getAttribute('aria-label')),
          tags: chips.map((chip) => chip.tagName.toLowerCase()),
          figures: stats ? [...stats.querySelectorAll('.statchip')].map((chip) => chip.textContent) : [],
          figuresBeforeLabels: figuresAt !== -1 && labelsAt !== -1 && figuresAt < labelsAt,
          rows: [...new Set(boxes.map((chip) => Math.round(chip.top)))].length,
          outside: boxes.length
            ? Math.max(...boxes.map((chip) => Math.max(inside.left - chip.left, chip.right - inside.right)))
            : 0,
          underFigures: stats ? box.top - rect(stats).bottom : null,
          overCard: card ? box.bottom - rect(card).top : null,
          word: button.textContent,
          said: button.getAttribute('aria-label'),
          tag: button.tagName.toLowerCase(),
          pop: button.getAttribute('aria-controls'),
          haspopup: button.getAttribute('aria-haspopup'),
          buttonRight: rect(button).right,
          buttonBottom: rect(button).bottom,
          rowBottom: rect(row).bottom,
        };
      })()`;

      const wide = (await page.evaluate(LINE)) as SessionLabelLine | null;
      assert.ok(wide, 'the session heading draws no label line, so the main view offers no way into the editor');
      // The session heading shows all labels, including those folded on its session-list card.

      assert.deepEqual(
        wide.chips,
        ['composer', 'release 0.4', 'perf'],
        'the heading drew something other than every label the fixture filed the session under',
      );
      // While the session list is visible, heading labels are accessible filter buttons.

      assert.deepEqual(
        wide.tags,
        wide.chips.map(() => 'button'),
        'a label chip on the heading is not a real button, so it cannot be pressed without a mouse',
      );
      assert.deepEqual(
        wide.said_chips,
        wide.chips.map((name) => `${CARD_ACTIONS.railFilterTake} label ${name}`),
        'a label chip is announced as a bare word, so a reader cannot tell a control from an ornament',
      );
      assert.equal(wide.rows, 1, 'three short labels took more than one row at 1350px');
      assert.equal(
        wide.tag,
        'button',
        'the way into the editor is not a real button, so it cannot be reached without a mouse',
      );
      assert.equal(wide.word, CARD_ACTIONS.labelOpen);
      assert.equal(wide.said, CARD_ACTIONS.labelOpen + ': Embedded agent input');
      assert.equal(wide.pop, 'labelpop');
      assert.equal(wide.haspopup, 'dialog');
      assert.ok(
        wide.underFigures !== null && wide.underFigures >= -1,
        'the heading draws its labels above its figures at 1350px',
      );
      assert.equal(wide.figuresBeforeLabels, true, 'the built heading draws its label line above its figures');
      assert.ok(
        wide.overCard !== null && wide.overCard <= 1,
        'the label line runs ' + Math.round(wide.overCard ?? 0) + 'px into the first turn card at 1350px',
      );

      // Send changed labels through the session-list message. Include a long label to test wrapping.

      const posted = renderPayload() as {
        rail: { id: string }[];
        stats: unknown;
        labels: unknown;
        views: unknown;
        railFilters: unknown;
        hidden: unknown;
        pinnedTop: unknown;
      };
      const long = EDITOR_LABELS.s4[0];
      const moved = posted.rail.map((card) =>
        card.id === 's1' ? { ...card, labels: ['composer', 'release 0.4', 'perf', long] } : card,
      );
      await page.evaluate(
        `window.postMessage({ type: 'rail', rail: ${JSON.stringify(moved)}, stats: ${JSON.stringify(posted.stats)}, labels: ${JSON.stringify(posted.labels)}, views: ${JSON.stringify(posted.views)}, railFilters: ${JSON.stringify(posted.railFilters)}, hidden: ${JSON.stringify(posted.hidden)}, pinnedTop: ${JSON.stringify(posted.pinnedTop)} }, '*')`,
      );
      await page.evaluate(SETTLED);
      const written = (await page.evaluate(LINE)) as SessionLabelLine | null;
      assert.ok(written, 'the heading lost its label line when the rail message arrived');
      assert.deepEqual(
        written.chips,
        ['composer', 'release 0.4', 'perf', long],
        'a label written on the session on screen never reached the heading over it',
      );
      // Label buttons expose full names through panel hints and omit native tooltips.

      assert.deepEqual(
        written.hints,
        written.chips,
        'a label chip on the heading carries no hint, so a cut name cannot be read at all',
      );
      assert.deepEqual(
        written.titles,
        written.chips.map(() => null),
        'a label chip wears a native hover as well as the panel hint, so the reader is offered two',
      );

      // Press a label containing a space to test quoted label filtering.

      const filed = (await page.evaluate(`(() => {
        const chip = [...document.querySelectorAll('#list .sessionrow button.sessionlabel')]
          .find((node) => node.textContent === 'release 0.4');
        if (!chip) return { error: 'the heading drew no pressable chip for the label with a space' };
        chip.click();
        const box = document.querySelector('.railfilter');
        const cards = [...document.querySelectorAll('.railcard')];
        return {
          query: box ? box.value : null,
          focused: document.activeElement === box,
          offers: !document.getElementById('filterpop').hidden,
          shown: cards.map((card) => card.querySelector('.railname').textContent),
        };
      })()`)) as { error?: string; query: string | null; focused: boolean; offers: boolean; shown: string[] };
      assert.equal(filed.error, undefined, filed.error);
      assert.equal(
        filed.query,
        'label:"release 0.4"',
        'a press on a heading label chip wrote something other than the term that files that label',
      );
      // Filtering by a label must focus the filter field so the reader can edit or clear the query.

      assert.equal(
        filed.focused,
        true,
        'a press on a heading label chip left the focus off the box that holds what it wrote',
      );
      // A complete label-filter term must not open suggestions.
      assert.equal(filed.offers, false, 'the suggestion list opened over a term the press wrote whole');
      // Check the visible sessions as well as the filter text.

      assert.ok(
        filed.shown.length > 0 && filed.shown.length < posted.rail.length,
        `the press left ${filed.shown.length} of ${posted.rail.length} cards on screen, so the rail never read what it wrote`,
      );

      // Resize below the session-list breakpoint. Heading labels must become read-only text without adding keyboard stops.

      const CHIPS = `(() => {
        const chips = [...document.querySelectorAll('#list .sessionrow .sessionlabel')];
        const stops = [...document.querySelectorAll(${JSON.stringify(rovingSelector())})]
          .filter((node) => node.closest('#list') && !node.closest('[hidden]') && node.tabIndex === 0);
        return {
          tags: chips.map((chip) => chip.tagName.toLowerCase()),
          titles: chips.map((chip) => chip.getAttribute('title')),
          chipStops: chips.filter((chip) => chip.tabIndex === 0).length,
          stops: stops.length,
        };
      })()`;
      await page.setViewportSize({ width: RAIL_MIN_WIDTH - 60, height: 900 });
      await page.waitForFunction(`(() => {
        const chips = [...document.querySelectorAll('#list .sessionrow .sessionlabel')];
        return chips.length === ${written.chips.length} && chips.every((chip) => chip.tagName === 'SPAN');
      })()`);
      const shrunk = (await page.evaluate(CHIPS)) as {
        tags: string[];
        titles: (string | null)[];
        chipStops: number;
        stops: number;
      };
      assert.deepEqual(
        shrunk.tags,
        written.chips.map(() => 'span'),
        'the panel narrowed past the rail and the chips stayed controls, so a press files a list nobody can see',
      );
      assert.deepEqual(
        shrunk.titles,
        written.chips,
        'a chip drawn as a word carries no hover, so a cut name cannot be read at all',
      );
      // The timeline roving walk keeps exactly one Tab stop.
      assert.equal(
        shrunk.stops,
        1,
        `the narrowed page holds ${shrunk.stops} tab stops on the roving walk rather than one`,
      );

      // Widen the panel to restore label buttons without adding independent Tab stops.

      await page.setViewportSize({ width: 1350, height: 900 });
      await page.waitForFunction(`(() => {
        const chips = [...document.querySelectorAll('#list .sessionrow .sessionlabel')];
        return chips.length === ${written.chips.length} && chips.every((chip) => chip.tagName === 'BUTTON');
      })()`);
      const regrown = (await page.evaluate(CHIPS)) as {
        tags: string[];
        titles: (string | null)[];
        chipStops: number;
        stops: number;
      };
      assert.deepEqual(
        regrown.tags,
        written.chips.map(() => 'button'),
        'the rail came back and the chips stayed words, so the labels cannot be pressed again',
      );
      assert.equal(
        regrown.chipStops,
        0,
        `${regrown.chipStops} label chips hold a tab stop, so Tab stops once for every label`,
      );
      assert.equal(
        regrown.stops,
        1,
        `the widened page holds ${regrown.stops} tab stops on the roving walk rather than one`,
      );

      // Change the session cost through a session-list update. The figures must retain their position above the labels.

      const priced = JSON.parse(JSON.stringify(posted.stats)) as Record<string, { metric: string; label: string }[]>;
      const cost = priced.s1.find((chip) => chip.metric === 'cost');
      assert.ok(cost, 'the fixture gives the session on screen no cost, so no figure here can move');
      cost.label = '$9.99';
      // Include saved views and filter state so the protocol accepts the session-list update.

      await page.evaluate(
        `window.postMessage({ type: 'rail', rail: ${JSON.stringify(moved)}, stats: ${JSON.stringify(priced)}, labels: ${JSON.stringify(posted.labels)}, views: ${JSON.stringify(posted.views)}, railFilters: ${JSON.stringify(posted.railFilters)}, hidden: ${JSON.stringify(posted.hidden)}, pinnedTop: ${JSON.stringify(posted.pinnedTop)} }, '*')`,
      );
      await page.evaluate(SETTLED);
      const repriced = (await page.evaluate(LINE)) as SessionLabelLine | null;
      assert.ok(repriced, 'the heading lost its label line when its figures were rewritten');
      assert.ok(
        repriced.figures.includes('$9.99'),
        'the new figure never reached the heading, so nothing below measures the rewrite at all',
      );
      assert.notDeepEqual(
        repriced.figures,
        written.figures,
        'the figures say what they said before, so this measures the build and not the rewrite',
      );
      assert.equal(
        repriced.figuresBeforeLabels,
        true,
        'the rewritten figures were drawn under the label line, so the heading reordered itself',
      );
      assert.ok(
        repriced.underFigures !== null && repriced.underFigures >= -1,
        'the label line is drawn above the figures once they have been rewritten',
      );

      // At sidebar width, wrap the labels and keep each one inside its row.

      await page.setViewportSize({ width: 340, height: 900 });
      await page.evaluate(SETTLED);
      const narrow = (await page.evaluate(LINE)) as SessionLabelLine | null;
      assert.ok(narrow, 'the heading drew no label line at 340px');
      assert.deepEqual(
        narrow.chips,
        ['composer', 'release 0.4', 'perf', long],
        'the line dropped a label at 340px rather than wrapping it',
      );
      assert.ok(
        narrow.rows >= 2,
        'four labels and a press stayed on one row at 340px, so nothing here measured the wrap',
      );
      assert.ok(
        narrow.outside <= 1,
        'a chip hangs ' + Math.round(narrow.outside) + 'px outside the heading row at 340px',
      );
      assert.ok(
        narrow.overCard !== null && narrow.overCard <= 1,
        'the wrapped label line runs into the first turn card at 340px',
      );

      // The heading requests label-editor rows from the host before opening the editor.

      await page.setViewportSize({ width: 1350, height: 900 });
      await page.evaluate(SETTLED);
      await page.evaluate('window.__posted.length = 0');
      await page.locator('#list .sessionlabels .sessionlabelact').click();
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.evaluate('window.__posted.filter((m) => m.type === "labelEditor")'),
        [{ type: 'labelEditor', session: 's1' }],
        'the press on the heading asked for the rows of some other session, or asked for nothing',
      );
      const answer = {
        type: 'labelEditor',
        session: 's1',
        heading: CARD_ACTIONS.labelHeading + ' Embedded agent input',
        rows: labelEditorRows(EDITOR_LABELS, 's1'),
      };
      await page.evaluate(`window.postMessage(${JSON.stringify(answer)}, '*')`);
      await page.evaluate(SETTLED);

      const OPENED = `(() => {
        const pop = document.getElementById('labelpop');
        const button = document.querySelector('#list .sessionlabels .sessionlabelact');
        const row = document.querySelector('#list .sessionrow');
        const rail = document.getElementById('rail');
        if (!pop || pop.hidden || !button || !row) return null;
        const rect = (node) => {
          const box = node.getBoundingClientRect();
          return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
        };
        const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        const box = rect(pop);
        return {
          pop: box,
          overRow: overlaps(box, rect(row)),
          button: rect(button),
          railRight: rail ? rect(rail).right : null,
          underRow: box.top - rect(row).bottom,
          openHere: button.getAttribute('aria-expanded'),
          openOnRail: [...document.querySelectorAll('.raillabelact')]
            .filter((one) => one.getAttribute('aria-expanded') === 'true')
            .map((one) => one.dataset.session),
          offScreen: Math.max(0, -box.left, box.right - window.innerWidth, -box.top, box.bottom - window.innerHeight),
        };
      })()`;
      const opened = (await page.evaluate(OPENED)) as null | {
        pop: { left: number; right: number; top: number; bottom: number };
        button: { left: number; right: number; top: number; bottom: number };
        overRow: boolean;
        railRight: number | null;
        underRow: number;
        openHere: string | null;
        openOnRail: string[];
        offScreen: number;
      };
      assert.ok(opened, 'the press on the heading line opened no editor');
      assert.equal(
        opened.openHere,
        'true',
        'the press says nothing about the editor it opened, so a reader who cannot see it is told nothing',
      );
      // Count expanded label controls by DOM element. A session appearing in several saved views must still have only one expanded control.

      assert.deepEqual(
        opened.openOnRail,
        ['s1'],
        'the rail has no control claiming this editor, or more than one claims it',
      );
      // The label editor must clear the session-list column and overlap its heading anchor horizontally.

      assert.ok(
        opened.railRight !== null && opened.pop.left >= opened.railRight,
        'the popover covers the rail while it edits a session the rail is listing',
      );
      assert.ok(
        opened.railRight !== null && opened.pop.right > opened.railRight,
        'the popover ends inside the rail column, which is where it would land placed against a card',
      );
      assert.ok(
        opened.pop.left < opened.button.right && opened.pop.right > opened.button.left,
        `the popover runs from ${Math.round(opened.pop.left)} to ${Math.round(opened.pop.right)}px ` +
          `and shares nothing with the button it opened from, which runs from ` +
          `${Math.round(opened.button.left)} to ${Math.round(opened.button.right)}px`,
      );
      // The editor must sit below the complete session heading without covering it.

      assert.equal(opened.overRow, false, 'the popover covers the heading of the session it names');
      assert.ok(opened.underRow >= -1, 'the popover is drawn above the heading it belongs to');
      assert.equal(opened.offScreen, 0, 'the popover hangs ' + Math.round(opened.offScreen) + 'px off the panel');

      // Switch the shown session away and back without changing session data. The original session label control must retain its element.

      const again = renderPayload() as Record<string, unknown> & { sessions: { id: string }[] };
      const elsewhere = again.sessions.map((one) => one.id).find((id) => id !== 's1');
      assert.ok(elsewhere, 'the fixture draws one session, so nothing here can force a rebuild');
      await page.evaluate("document.querySelector('#list .sessionlabels .sessionlabelact')._beforeRepaint = true");
      await page.evaluate(`window.postMessage(${JSON.stringify({ ...again, showing: elsewhere })}, '*')`);
      await page.evaluate(SETTLED);
      await page.evaluate(`window.postMessage(${JSON.stringify(again)}, '*')`);
      await page.evaluate(SETTLED);
      assert.equal(
        await page.evaluate("!!document.querySelector('#list .sessionlabels .sessionlabelact')._beforeRepaint"),
        true,
        'the repaint replaced the label control instead of preserving its keyed session',
      );
      // Resize to update the popover position against its retained anchor.

      await page.setViewportSize({ width: 1360, height: 900 });
      await page.evaluate(SETTLED);
      const repainted = (await page.evaluate(OPENED)) as typeof opened;
      assert.ok(repainted, 'the repaint shut the editor');
      assert.ok(
        repainted.railRight !== null && repainted.pop.left >= repainted.railRight,
        'the repaint moved the popover into the rail column, away from the control the reader opened it from',
      );
      assert.ok(
        repainted.pop.left < repainted.button.right && repainted.pop.right > repainted.button.left,
        `after the repaint the popover runs from ${Math.round(repainted.pop.left)} to ` +
          `${Math.round(repainted.pop.right)}px and shares nothing with the button it opened from, ` +
          `which runs from ${Math.round(repainted.button.left)} to ${Math.round(repainted.button.right)}px`,
      );
      await page.setViewportSize({ width: 1350, height: 900 });
      await page.evaluate(SETTLED);

      // Escape closes the label editor and restores focus to the retained heading control.

      await page.keyboard.press('Escape');
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.evaluate(`(() => {
        const button = document.querySelector('#list .sessionlabels .sessionlabelact');
        return {
          shut: document.getElementById('labelpop').hidden,
          back: document.activeElement === button,
          said: button.getAttribute('aria-expanded'),
        };
      })()`),
        { shut: true, back: true, said: 'false' },
        'Escape left the editor open, or dropped the reader off the button that opened it',
      );

      assert.deepEqual(failures, [], 'the panel threw while drawing the heading label line');
    } finally {
      await browser.close();
    }
  },
);

test('a rail card meta line stays on one line at the narrowest the rail can be', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.clock.setFixedTime(NOW);
    const failures: string[] = [];
    page.on('pageerror', (e) => failures.push(String(e)));
    await page.setContent(pageHtml());
    await page.setViewportSize({ width: 1350, height: 900 });

    const payload = renderPayload() as { rail: Record<string, unknown>[] };
    assert.ok(payload.rail.length >= 3, 'the fixture built no rail, so this measures nothing');
    // Set presentation fields directly on the session-list payload to exercise metadata layout.

    payload.rail[0] = {
      ...payload.rail[0],
      pinnedTop: true,
      agentRun: true,
      agent: '',
      agentWord: CARD_ACTIONS.agentRun,
      status: 'failed',
      at: NOW - 330 * 24 * 3_600_000,
      cache: null,
      unsentWord: 'unsent',
      unsentName: 'unsent prompt and 2 unsent comments',
    };
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
    // Set the minimum session-list width through flex-basis, matching divider placement.
    await page.evaluate(`document.getElementById('rail').style.flexBasis = '${RAIL_WIDTH_MIN}px'`);
    await page.evaluate(SETTLED);

    const lines = (await page.evaluate(META_LINES)) as MetaLine[];
    assert.deepEqual(failures, [], 'the panel threw while drawing the rail');
    assert.ok(
      lines.length >= 3,
      `the rail drew ${lines.length} cards at ${RAIL_WIDTH_MIN}px, so this measures nothing`,
    );
    const worst = lines.find((l) => l.words.includes(CARD_ACTIONS.agentRun));
    assert.ok(worst, `no card says ${JSON.stringify(CARD_ACTIONS.agentRun)}, so the widest line was never drawn`);
    assert.equal(
      worst.words.length,
      3,
      `the widest card says ${JSON.stringify(worst.words)}, and not a word for the agent, ` +
        'a status and the unsent marker, so nothing measured here is tight',
    );

    for (const line of lines) {
      const said = JSON.stringify(line.words.join(' '));
      assert.deepEqual(
        line.rects,
        line.words.map(() => 1),
        `${said} broke across ${Math.max(...line.rects)} lines at ${RAIL_WIDTH_MIN}px`,
      );
      assert.ok(line.overflow <= 1, `${said} runs ${Math.round(line.overflow)}px past the card it sits on`);
    }

    // The longest metadata line must exceed the available width so the test detects wrapping.

    assert.ok(
      worst.clipped,
      `${JSON.stringify(worst.words.join(' '))} fits inside ${RAIL_WIDTH_MIN}px whole, ` +
        'so a wrapping line would pass this',
    );
  } finally {
    await browser.close();
  }
});

test(
  'a rail card name draws more of itself as the rail widens, on one line, without moving the meta line under it',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
      return;
    }
    try {
      const page = await browser.newPage();
      await page.clock.setFixedTime(NOW);
      const failures: string[] = [];
      page.on('pageerror', (e) => failures.push(String(e)));
      await page.setContent(pageHtml());
      await page.setViewportSize({ width: 1350, height: 900 });

      const payload = renderPayload() as { rail: Record<string, unknown>[] };
      assert.ok(payload.rail.length > 1, 'the fixture has no second card to measure a one-line reference height from');
      // Use a name long enough to overflow at both tested session-list widths.

      const long = Array.from({ length: 40 }, (_, n) => `word${n}`).join(' ');
      const id = payload.rail[0].id as string;
      const referenceId = payload.rail[1].id as string;
      // Keep label short and name long. Drawing the wrong field must fail the clipping and width checks.

      payload.rail[0] = { ...payload.rail[0], label: 'Short label', name: long };
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);

      const MEASURE = `(() => {
      const card = document.querySelector(${JSON.stringify(`[data-control="rail:${id}"]`)});
      const reference = document.querySelector(${JSON.stringify(`[data-control="rail:${referenceId}"]`)});
      if (!card || !reference) { return null; }
      const name = card.querySelector('.railname');
      const meta = card.querySelector('.railmeta');
      const cardBox = card.getBoundingClientRect();
      const nameBox = name.getBoundingClientRect();
      return {
        nameHeight: nameBox.height,
        clientWidth: name.clientWidth,
        scrollWidth: name.scrollWidth,
        cardWidth: cardBox.width,
        metaTop: meta ? meta.getBoundingClientRect().top - cardBox.top : null,
        referenceNameHeight: reference.querySelector('.railname').getBoundingClientRect().height,
      };
    })()`;
      type Measured = {
        nameHeight: number;
        clientWidth: number;
        scrollWidth: number;
        cardWidth: number;
        metaTop: number | null;
        referenceNameHeight: number;
      };

      await page.evaluate(`document.getElementById('rail').style.flexBasis = '${RAIL_WIDTH_MIN}px'`);
      await page.evaluate(SETTLED);
      const narrow = (await page.evaluate(MEASURE)) as Measured | null;
      assert.ok(narrow, `the rail drew no card for ${id} at ${RAIL_WIDTH_MIN}px`);

      await page.evaluate(`document.getElementById('rail').style.flexBasis = '480px'`);
      await page.evaluate(SETTLED);
      const wide = (await page.evaluate(MEASURE)) as Measured | null;
      assert.ok(wide, `the rail drew no card for ${id} at 480px`);

      assert.deepEqual(failures, [], 'the panel threw while drawing a long rail name');
      // Compare the name height with a short one-line reference at both widths.

      assert.ok(
        Math.abs(narrow.nameHeight - narrow.referenceNameHeight) <= 1,
        `the name drew ${narrow.nameHeight}px tall against a one-line reference of ${narrow.referenceNameHeight}px at ${RAIL_WIDTH_MIN}px`,
      );
      assert.ok(
        Math.abs(wide.nameHeight - wide.referenceNameHeight) <= 1,
        `the name drew ${wide.nameHeight}px tall against a one-line reference of ${wide.referenceNameHeight}px at 480px`,
      );
      // Check that the long name truncates at minimum width.

      const narrowGap = narrow.scrollWidth - narrow.clientWidth;
      const wideGap = wide.scrollWidth - wide.clientWidth;
      assert.ok(narrowGap > 0, `the name fit whole at ${RAIL_WIDTH_MIN}px, so widening it proves nothing here`);
      // Widening the session list must reveal more of the name.

      assert.ok(
        wideGap < narrowGap,
        `the name left ${Math.round(narrowGap)}px cut at ${RAIL_WIDTH_MIN}px and ${Math.round(wideGap)}px cut at 480px, ` +
          'so a wider rail drew no more of it',
      );
      assert.ok(
        wide.clientWidth > narrow.clientWidth,
        'the name column did not grow with the rail, so nothing here measures the claim',
      );
      // The name must use the available card width rather than stop at a fixed maximum.

      const wideMargin = wide.cardWidth - wide.clientWidth;
      assert.ok(
        wideMargin <= 50,
        `the name column left ${Math.round(wideMargin)}px of the ${Math.round(wide.cardWidth)}px card unused at 480px`,
      );
      // Widening the session list must preserve the metadata line position.
      assert.equal(narrow.metaTop, wide.metaTop, 'widening the rail moved the meta line under a card name');
    } finally {
      await browser.close();
    }
  },
);

test(
  'rail cost, turns and context stay on their own line across the supported rail widths',
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
      await layoutAt(page, 1350);

      for (const width of [RAIL_WIDTH_MIN, RAIL_WIDTH_DEFAULT, 480]) {
        await page.evaluate(`document.getElementById('rail').style.flexBasis = '${width}px'`);
        await page.evaluate(SETTLED);
        const measured = (await page.evaluate(`(() => {
        const rail = document.getElementById('rail');
        const list = document.getElementById('list');
        const card = document.querySelector('[data-control="rail:s1"]');
        const empty = document.querySelector('[data-control="rail:s3"] .railstats');
        if (!rail || !list || !card || !empty) return null;
        const meta = card.querySelector('.railmeta');
        const stats = card.querySelector('.railstats');
        const sessionStats = document.querySelector('#list .sessionstats');
        const turnStats = document.querySelector('#list .turn .chips');
        const railChip = stats && stats.querySelector('[data-metric="context"]');
        const sessionChip = sessionStats && sessionStats.querySelector('[data-metric="context"]');
        const turnChip = turnStats && turnStats.querySelector('.statchip');
        const sessionInteractive = sessionStats && sessionStats.querySelector('[data-metric="turns"]');
        const turnInteractive = turnStats && turnStats.querySelector('button.statchip');
        const rect = (node) => node.getBoundingClientRect();
        const chipShape = (node) => {
          const style = getComputedStyle(node);
          return {
            fontSize: style.fontSize,
            lineHeight: style.lineHeight,
            paddingTop: style.paddingTop,
            paddingRight: style.paddingRight,
            paddingBottom: style.paddingBottom,
            paddingLeft: style.paddingLeft,
            borderTopWidth: style.borderTopWidth,
            height: rect(node).height,
          };
        };
        const chipType = (node) => {
          const style = getComputedStyle(node);
          return {
            fontSize: style.fontSize,
            lineHeight: style.lineHeight,
            paddingTop: style.paddingTop,
            paddingRight: style.paddingRight,
            paddingBottom: style.paddingBottom,
            paddingLeft: style.paddingLeft,
            borderTopWidth: style.borderTopWidth,
          };
        };
        const lineTops = (row) => [...row.children]
          .filter((node) => !(node instanceof SVGElement) && node.textContent && !node.hidden && getComputedStyle(node).display !== 'none')
          .flatMap((node) => {
            const range = document.createRange();
            range.selectNodeContents(node);
            return [...range.getClientRects()].map((box) => Math.round(box.top));
          });
        const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        const actionBoxes = [...card.parentElement.querySelectorAll('.railact')].map(rect);
        const metaBox = rect(meta);
        const statBox = rect(stats);
        return {
          rail: rect(rail), list: rect(list), card: rect(card), meta: metaBox, stats: statBox,
          metaLines: [...new Set(lineTops(meta))].length,
          statLines: [...new Set(lineTops(stats))].length,
          metrics: [...stats.children].map((node) => [node.dataset.metric, node.textContent, node.tagName]),
          railChip: railChip ? chipShape(railChip) : null,
          sessionChip: sessionChip ? chipShape(sessionChip) : null,
          turnChip: turnChip ? chipShape(turnChip) : null,
          interactiveType: sessionInteractive && turnInteractive
            ? [chipType(sessionInteractive), chipType(turnInteractive)] : null,
          staticTags: [...stats.children].map((node) => node.tagName),
          interactiveTags: [sessionInteractive?.tagName || null, turnInteractive?.tagName || null],
          railGap: parseFloat(getComputedStyle(stats).columnGap),
          sessionGap: sessionStats ? parseFloat(getComputedStyle(sessionStats).columnGap) : null,
          turnGap: turnStats ? parseFloat(getComputedStyle(turnStats).columnGap) : null,
          overlap: actionBoxes.some((box) => overlaps(box, metaBox) || overlaps(box, statBox)),
          statOverflow: statBox.right - (rect(card).right - parseFloat(getComputedStyle(card).paddingRight)),
          empty: { hidden: empty.hidden, height: rect(empty).height, display: getComputedStyle(empty).display },
        };
      })()`)) as null | {
          rail: { right: number };
          list: { left: number };
          card: { right: number };
          meta: { height: number };
          stats: { height: number };
          metaLines: number;
          statLines: number;
          metrics: [string, string, string][];
          overlap: boolean;
          statOverflow: number;
          railChip: Record<string, string | number> | null;
          sessionChip: Record<string, string | number> | null;
          turnChip: Record<string, string | number> | null;
          interactiveType: Record<string, string>[] | null;
          staticTags: string[];
          interactiveTags: (string | null)[];
          railGap: number;
          sessionGap: number | null;
          turnGap: number | null;
          empty: { hidden: boolean; height: number; display: string };
        };
        assert.ok(measured, `the rail did not draw the stat fixtures at ${width}px`);
        assert.deepEqual(
          measured.metrics,
          [
            ['cost', '$1.87', 'SPAN'],
            ['turns', '8 turns', 'SPAN'],
            ['context', '59% ctx', 'SPAN'],
          ],
          `the rail changed the fixed cost, turns and context projection at ${width}px`,
        );
        assert.ok(
          measured.railChip && measured.sessionChip && measured.turnChip,
          `the rail, session, and turn context figures were not all drawn at ${width}px`,
        );
        assert.deepEqual(
          measured.railChip,
          measured.sessionChip,
          `the static rail context figure differs from the session figure at ${width}px`,
        );
        assert.deepEqual(
          measured.railChip,
          measured.turnChip,
          `the static rail context figure differs from the turn figure at ${width}px`,
        );
        assert.deepEqual(
          measured.staticTags,
          ['SPAN', 'SPAN', 'SPAN'],
          `a rail stat became a nested control at ${width}px`,
        );
        assert.deepEqual(
          measured.interactiveTags,
          ['BUTTON', 'BUTTON'],
          `a detail figure lost its interactive chip at ${width}px`,
        );
        assert.ok(measured.interactiveType, `the interactive figures were not both drawn at ${width}px`);
        assert.deepEqual(
          measured.interactiveType[0],
          measured.interactiveType[1],
          `an interactive stat chip differs between the session and turn rows at ${width}px`,
        );
        assert.equal(
          measured.railGap,
          measured.sessionGap,
          `the rail figure gap is tighter than the session figure gap at ${width}px`,
        );
        assert.equal(
          measured.railGap,
          measured.turnGap,
          `the rail figure gap is tighter than the turn figure gap at ${width}px`,
        );
        assert.equal(measured.metaLines, 1, `the metadata wrapped at ${width}px`);
        assert.equal(measured.statLines, 1, `the stat line wrapped at ${width}px`);
        assert.ok(
          measured.meta.height > 0 && measured.stats.height > 0,
          `one of the dedicated lines has no height at ${width}px`,
        );
        assert.equal(measured.overlap, false, `the row actions cover metadata or figures at ${width}px`);
        assert.ok(
          measured.statOverflow <= 1,
          `the figures run ${Math.round(measured.statOverflow)}px past the card at ${width}px`,
        );
        assert.ok(
          measured.list.left >= measured.rail.right - 1,
          `the timeline starts at ${measured.list.left}px before the rail ends at ${measured.rail.right}px`,
        );
        assert.deepEqual(
          measured.empty,
          { hidden: true, height: 0, display: 'none' },
          `a session with no figures keeps an empty third-line gap at ${width}px`,
        );
      }
      assert.deepEqual(failures, [], 'the panel threw while drawing rail figures');
    } finally {
      await browser.close();
    }
  },
);

test(
  'every View menu control sits inside the menu at the widest and the narrowest wide rail',
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
      await page.setContent(themed(pageHtml()));
      // Use enough labels to fold, an overflowing label name, and an overflowing saved-filter query.

      const payload = renderPayload() as { labels: unknown[] };
      payload.labels = [
        ...Array.from({ length: 16 }, (_, index) => ({
          name: `label-${index}`,
          count: 40 - index,
          countName: `carried by ${40 - index} sessions`,
        })),
        { name: 'x'.repeat(60), count: 1, countName: 'carried by one session' },
      ];
      // Test the smallest visible session list at the panel breakpoint and minimum column width.

      for (const [width, railWidth] of [
        [1350, RAIL_WIDTH_DEFAULT],
        [RAIL_MIN_WIDTH, RAIL_WIDTH_MIN],
      ] as const) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
        await page.evaluate(SETTLED);
        await page.evaluate(`document.getElementById('rail').style.flexBasis = '${railWidth}px'`);
        await page.evaluate(SETTLED);
        await page.locator('[data-control="railfilters"]').click();
        await page.locator('[data-control="railfilter-more-labels"]').click();
        await page.evaluate(SETTLED);
        const measured = (await page.evaluate(`(() => {
          const pop = document.getElementById('railfilterpop');
          const box = pop.getBoundingClientRect();
          const left = box.left + pop.clientLeft;
          const right = left + pop.clientWidth;
          const controls = [...pop.querySelectorAll('button, input')];
          return {
            count: controls.length,
            inView: box.left >= 0 && box.right <= innerWidth,
            outside: controls.filter((node) => {
              const at = node.getBoundingClientRect();
              return at.left < left - 0.5 || at.right > right + 0.5;
            }).map((node) => node.dataset.control || node.className),
          };
        })()`)) as { count: number; inView: boolean; outside: string[] };
        assert.ok(measured.count > 25, `the menu drew ${measured.count} controls at ${width}px`);
        assert.equal(measured.inView, true, `the View menu leaves the ${width}px panel`);
        assert.deepEqual(measured.outside, [], `menu controls run past the View menu at ${width}px`);
        await page.keyboard.press('Escape');
      }
      assert.deepEqual(failures, [], 'the panel threw while drawing the View menu');
    } finally {
      await browser.close();
    }
  },
);

test(
  'a maximum-length saved filter keeps the rail controls on one line at minimum width',
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
      const saved = {
        railFilter: 'label:"release 0.4"',
        railFilterId: 'f2',
        railSort: 'latest',
        railDefaultSort: 'latest',
        railWidth: RAIL_WIDTH_MIN,
      };
      await page.setContent(
        pageHtml().replace('const SAVED_STATE = {};', `const SAVED_STATE = ${JSON.stringify(saved)};`),
      );
      await layoutAt(page, 1350);
      await page.evaluate(`document.getElementById('rail').style.flexBasis = '${RAIL_WIDTH_MIN}px'`);
      await page.evaluate(SETTLED);
      await openRailBox(page);
      const measured = (await page.evaluate(`(() => {
        const rail = document.getElementById('rail');
        const controls = [...document.querySelectorAll('.railhead > .railfilterbox, .railhead > .railfiltertools')];
        const trigger = document.querySelector('[data-control="railfilters"]');
        const icon = trigger?.querySelector('.railfiltersicon');
        if (!rail || controls.length !== 2 || !trigger || !icon) return null;
        const railBox = rail.getBoundingClientRect();
        const boxes = controls.map((node) => node.getBoundingClientRect());
        const triggerBox = trigger.getBoundingClientRect();
        const iconBox = icon.getBoundingClientRect();
        return {
          railWidth: Math.round(railBox.width),
          activeName: trigger.getAttribute('aria-label'),
          rows: new Set(boxes.map((box) => Math.round(box.top))).size,
          outside: Math.max(0, ...boxes.map((box) => railBox.left - box.left),
            ...boxes.map((box) => box.right - railBox.right)),
          trigger: { top: triggerBox.top, height: triggerBox.height },
          icon: { top: iconBox.top, height: iconBox.height },
        };
      })()`)) as null | {
        railWidth: number;
        activeName: string;
        rows: number;
        outside: number;
        trigger: { top: number; height: number };
        icon: { top: number; height: number };
      };
      assert.ok(measured, 'the minimum-width rail drew no saved-filter controls');
      assert.equal(
        MAX_RAIL_FILTER_NAME.length,
        RAIL_FILTER_NAME_LIMIT,
        'the active filter does not reach the saved-filter name limit',
      );
      assert.equal(measured.railWidth, RAIL_WIDTH_MIN);
      assert.equal(measured.activeName, `View, ${MAX_RAIL_FILTER_NAME}, Latest update`);
      assert.equal(
        measured.rows,
        1,
        `the query field and the attached funnel use ${measured.rows} rows at ${RAIL_WIDTH_MIN}px`,
      );
      assert.ok(
        measured.outside <= 1,
        `a top control runs ${Math.round(measured.outside)}px outside the ${RAIL_WIDTH_MIN}px rail`,
      );
      const triggerCenter = measured.trigger.top + measured.trigger.height / 2;
      const iconCenter = measured.icon.top + measured.icon.height / 2;
      assert.ok(
        Math.abs(iconCenter - triggerCenter) <= 1,
        `the funnel icon center is ${iconCenter.toFixed(2)}px while its trigger center is ${triggerCenter.toFixed(2)}px`,
      );
      assert.deepEqual(failures, [], 'the panel threw while drawing the minimum-width filter controls');
    } finally {
      await browser.close();
    }
  },
);

test(
  'a cost query and its matching figure remain visible at the minimum rail width',
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
      await layoutAt(page, 1350);
      await page.evaluate(`document.getElementById('rail').style.flexBasis = '${RAIL_WIDTH_MIN}px'`);
      await openRailBox(page);
      await page.locator('.railfilter').fill('cost:>0.50');
      await page.evaluate(SETTLED);
      const measured = (await page.evaluate(`(() => {
        const input = document.querySelector('.railfilter');
        const card = document.querySelector('[data-control="rail:s1"]');
        const cost = card && card.querySelector('[data-metric="cost"]');
        if (!input || !card || !cost) return null;
        const cardBox = card.getBoundingClientRect();
        const costBox = cost.getBoundingClientRect();
        const costText = document.createRange();
        costText.selectNodeContents(cost);
        const costTextBox = costText.getBoundingClientRect();
        return {
          query: input.value,
          queryOverflow: input.scrollWidth - input.clientWidth,
          cost: cost.textContent,
          costTextOutside: Math.max(0, costBox.left - costTextBox.left, costTextBox.right - costBox.right),
          costOutside: Math.max(0, cardBox.left - costBox.left, costBox.right - cardBox.right),
          other: !!document.querySelector('[data-control="rail:s2"]'),
        };
      })()`)) as null | {
        query: string;
        queryOverflow: number;
        cost: string;
        costTextOutside: number;
        costOutside: number;
        other: boolean;
      };
      assert.ok(measured, 'the minimum-width rail drew no matching cost figure');
      assert.equal(measured.query, 'cost:>0.50');
      assert.ok(
        measured.queryOverflow <= 1,
        `the cost query runs ${Math.round(measured.queryOverflow)}px past its box at ${RAIL_WIDTH_MIN}px`,
      );
      assert.equal(measured.cost, '$1.87');
      assert.ok(
        measured.costTextOutside <= 1,
        `the cost figure clips ${Math.round(measured.costTextOutside)}px at ${RAIL_WIDTH_MIN}px`,
      );
      assert.ok(
        measured.costOutside <= 1,
        `the cost figure sits ${Math.round(measured.costOutside)}px outside its card at ${RAIL_WIDTH_MIN}px`,
      );
      assert.equal(measured.other, false, 'the threshold left the unpriced session on the rail');
      assert.deepEqual(failures, [], 'the panel threw while drawing the minimum-width cost query');
    } finally {
      await browser.close();
    }
  },
);

// Subagent and background-command states use the busy card edge and text tone. Their hints and accessible names identify the running work.

test(
  'a session waiting on its subagents or a background command wears the busy edge, the busy word and its hint',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
      return;
    }
    try {
      for (const kind of ['dark', 'light'] as const) {
        const page = await browser.newPage();
        await page.clock.setFixedTime(NOW);
        await page.setContent(themed(pageHtml(), kind));
        await layoutAt(page, 1350);
        const payload = renderPayload(
          [],
          [],
          [],
          [],
          [],
          [],
          new Map([
            ['s2', 'running'],
            ['s3', 'subagents'],
            ['s5', 'background'],
          ]),
          new Map(),
          [],
          new Map([['s3', 2]]),
          new Map([['s5', 1]]),
        );
        await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
        await page.evaluate(SETTLED);
        const tones = (await page.evaluate(`(() => {
        const card = document.querySelector('#rail .railcard[data-session="s3"]');
        const running = document.querySelector('#rail .railcard[data-session="s2"]');
        const word = card.querySelector('.railstatus');
        const probe = document.createElement('span');
        probe.style.color = 'var(--busy)';
        document.body.append(probe);
        const busy = getComputedStyle(probe).color;
        probe.remove();
        return {
          word: word.textContent, wordColor: getComputedStyle(word).color, busy,
          edge: getComputedStyle(card).borderLeftColor, edgeWidth: getComputedStyle(card).borderLeftWidth,
          runningEdgeWidth: getComputedStyle(running).borderLeftWidth,
          name: card.getAttribute('aria-label'),
          command: (() => {
            const waiting = document.querySelector('#rail .railcard[data-session="s5"]');
            const commandWord = waiting.querySelector('.railstatus');
            return {
              word: commandWord.textContent, wordColor: getComputedStyle(commandWord).color,
              edge: getComputedStyle(waiting).borderLeftColor, edgeWidth: getComputedStyle(waiting).borderLeftWidth,
              name: waiting.getAttribute('aria-label'),
              hint: waiting.getAttribute('data-hint'), detail: waiting.getAttribute('data-hint-detail'),
            };
          })(),
        };
      })()`)) as {
          word: string;
          wordColor: string;
          busy: string;
          edge: string;
          edgeWidth: string;
          runningEdgeWidth: string;
          name: string;
          command: {
            word: string;
            wordColor: string;
            edge: string;
            edgeWidth: string;
            name: string;
            hint: string;
            detail: string;
          };
        };
        assert.equal(
          tones.word,
          '2 subagents',
          `the ${kind} card says ${JSON.stringify(tones.word)} for two open subagents`,
        );
        assert.equal(tones.wordColor, tones.busy, `the ${kind} subagents word is not drawn in the busy tone`);
        assert.equal(tones.edge, tones.busy, `the ${kind} subagents card edge is not the busy tone`);
        assert.equal(
          tones.edgeWidth,
          tones.runningEdgeWidth,
          `the ${kind} subagents edge is not the running card's edge`,
        );
        assert.match(
          tones.name,
          /, Claude, 2 subagents still running, Last activity /,
          `the ${kind} card is named ${JSON.stringify(tones.name)}`,
        );
        const { command } = tones;
        assert.equal(
          command.word,
          '1 background command',
          `the ${kind} card says ${JSON.stringify(command.word)} for one background command`,
        );
        assert.equal(command.wordColor, tones.busy, `the ${kind} background word is not drawn in the busy tone`);
        assert.equal(command.edge, tones.busy, `the ${kind} background card edge is not the busy tone`);
        assert.equal(
          command.edgeWidth,
          tones.runningEdgeWidth,
          `the ${kind} background edge is not the running card's edge`,
        );
        assert.match(
          command.name,
          /, Claude, 1 background command still running, Last activity /,
          `the ${kind} card is named ${JSON.stringify(command.name)}`,
        );
        assert.deepEqual(
          [command.hint, command.detail],
          [
            '1 background command still running',
            'The agent is idle and will continue when it finishes. You can send a prompt now.',
          ],
        );

        await page.locator('#rail .railcard[data-session="s3"]').first().focus();
        await page.waitForFunction(`!document.getElementById('hintpop').hidden`);
        const hint = (await page.evaluate(`(() => {
        const pop = document.getElementById('hintpop');
        return { title: pop.querySelector('.hinttitle')?.textContent, detail: pop.querySelector('.hintdetail')?.textContent };
      })()`)) as { title: string; detail: string };
        assert.deepEqual(hint, {
          title: '2 subagents still running',
          detail: 'The main agent is idle and will continue when they finish. You can send a prompt now.',
        });
        await page.close();
      }
    } finally {
      await browser.close();
    }
  },
);

// Save only the Active quick filter so the Running count stays hidden.

const ONE_COUNT = JSON.stringify({ railQuickFilters: ['active'] });

test(
  'the rail head row keeps every count and both tools inside the rail at 480px and 220px',
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
      // Session s2 runs, but the saved quick-filter selection omits Running.
      await page.setContent(themed(pageHtml().replace('const SAVED_STATE = {};', `const SAVED_STATE = ${ONE_COUNT};`)));
      await page.setViewportSize({ width: 1350, height: 900 });
      // The Active button is the only configured quick-filter count.
      const statuses = new Map<string, RailStatus>([['s2', 'running']]);
      await page.evaluate(
        `window.postMessage(${JSON.stringify(renderPayload([], [], [], [], [], [], statuses))}, '*')`,
      );
      await page.evaluate(SETTLED);
      for (const width of [480, RAIL_WIDTH_DEFAULT]) {
        await page.evaluate(`document.getElementById('rail').style.flexBasis = '${width}px'`);
        await page.evaluate(SETTLED);
        const measured = (await page.evaluate(`(() => {
          const rail = document.getElementById('rail');
          const counts = [...document.querySelectorAll('.railcount')];
          const tools = [
            document.querySelector('.railfiltertools [data-control="railsearch"]'),
            document.querySelector('.railfiltertools [data-control="railfilters"]'),
          ];
          if (!rail || counts.length !== 1 || tools.some((node) => !node)) { return null; }
          const railBox = rail.getBoundingClientRect();
          const boxes = [...counts, ...tools].map((node) => node.getBoundingClientRect());
          const centers = boxes.map((box) => box.top + box.height / 2);
          return {
            railWidth: Math.round(railBox.width),
            spread: Math.max(...centers) - Math.min(...centers),
            lefts: boxes.map((box) => Math.round(box.left)),
            outside: Math.max(0, ...boxes.map((box) => railBox.left - box.left),
              ...boxes.map((box) => box.right - railBox.right)),
            // The counts' box takes the free space and the count hugs its start, so the space
            // between the count and the first tool is measured.
            funnelGap: Math.round(boxes[counts.length].left - boxes[counts.length - 1].right),
            names: counts.map((node) => node.getAttribute('aria-label')),
            boxes: document.querySelectorAll('.railfilter').length,
          };
        })()`)) as null | {
          railWidth: number;
          spread: number;
          lefts: number[];
          outside: number;
          funnelGap: number;
          names: (string | null)[];
          boxes: number;
        };
        assert.ok(measured, `the rail head row drew no count or no tools at ${width}px`);
        assert.equal(measured.railWidth, width);
        // Header controls must stay inside the session list at both tested widths.

        assert.ok(
          measured.outside <= 1,
          `a head-row control runs ${Math.round(measured.outside)}px outside the ${width}px rail`,
        );
        assert.equal(measured.boxes, 0, `the filter box took the row at ${width}px while it held no query`);
        assert.deepEqual(
          measured.names,
          ['Active, 2 sessions. Some active sessions have a cache that is expiring.'],
          `the count is named ${JSON.stringify(measured.names)} at ${width}px`,
        );
      }
      assert.deepEqual(failures, [], 'the panel threw while drawing the rail head row');
    } finally {
      await browser.close();
    }
  },
);

// Select Active over a query containing only s1. Its recency expires in 20 seconds, so a 25-second clock advance removes it.

async function pressActiveOverLeavingSession(
  page: Page,
): Promise<() => Promise<{ pressed: string | null; drawn: number }>> {
  const now = (await page.evaluate('Date.now()')) as number;
  await page.clock.setFixedTime(now);
  await page.setContent(themed(pageHtml()));
  const payload = renderPayload() as { rail: { id: string; at: number; cache: unknown }[] };
  const target = payload.rail.find((card) => card.id === 's1');
  assert.ok(target, 'the fixture dropped session s1, so this measures nothing');
  // Remove the warm cache so only recency controls Active membership.

  target.cache = null;
  target.at = now - (ACTIVE_WINDOW_MS - 20_000);
  await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
  await page.evaluate(SETTLED);
  await page.locator('[data-control="railsearch"]').click();
  await page.locator('[data-control="railfilter"]').fill('embedded');
  await page.locator('[data-control="railfilters"]').focus();
  await page.evaluate(SETTLED);
  await page.locator('[data-control="railcount:active"]').click();
  await page.evaluate(SETTLED);
  const read = async () => ({
    pressed: (await page.locator('[data-control="railcount:active"]').count())
      ? await page.locator('[data-control="railcount:active"]').getAttribute('aria-pressed')
      : null,
    drawn: await page.locator('.railcard[data-session="s1"]').count(),
  });
  const before = await read();
  assert.ok(before.drawn >= 1, 'the held query and lens do not draw the session under test');
  assert.equal(before.pressed, 'true');
  return read;
}

test(
  'the selected Active shortcut stays pressed when a tick drops its last session',
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
      const read = await pressActiveOverLeavingSession(page);
      // Pause before advancing so due timers run over an exact interval.

      await pauseClock(page);
      await page.clock.runFor(25_000);
      const after = await read();
      assert.equal(after.drawn, 0, 'the session did not leave the list on the tick that crossed the window');
      assert.equal(after.pressed, 'true', 'the selected zero-match shortcut disappeared');
      assert.deepEqual(failures, [], 'the panel threw while the Active session left the list');
    } finally {
      await browser.close();
    }
  },
);

test('ending naming refreshes held cache information at the current time', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (e) => failures.push(String(e)));
    const now = (await page.evaluate('Date.now()')) as number;
    await page.clock.setFixedTime(now);
    await page.setContent(themed(pageHtml()));
    const payload = renderPayload() as { rail: { id: string; at: number; cache: unknown }[] };
    const target = payload.rail.find((card) => card.id === 's1');
    assert.ok(target, 'the fixture dropped session s1, so this measures nothing');
    target.cache = { expiresAt: now + 20_000, nearlyGoneAt: now + 10_000 };
    target.at = now - (ACTIVE_WINDOW_MS - 20_000);
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
    // Use a query without time conditions so only the cache reading changes during naming.
    await page.locator('[data-control="railsearch"]').click();
    await page.locator('[data-control="railfilter"]').fill('embedded');
    await page.evaluate(SETTLED);
    const active = page.locator('[data-control="railcount:active"]');
    assert.ok((await active.getAttribute('aria-label'))?.includes(CARD_ACTIONS.railCountCacheWarm));
    await page.locator('[data-control="railviewsave"]').click();
    // Advance paused system time without firing timers. Ending naming must refresh cache information.

    const paused = await pauseClock(page);
    await page.clock.setSystemTime(paused + 25_000);
    await page.keyboard.press('Escape');
    assert.equal(await active.count(), 0, 'ending naming kept a zero-match shortcut');
    assert.deepEqual(failures, [], 'the panel threw while naming ended');
  } finally {
    await browser.close();
  }
});

test('a tick that empties Active removes its shortcut and focuses the funnel', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (e) => failures.push(String(e)));
    const now = (await page.evaluate('Date.now()')) as number;
    await page.clock.setFixedTime(now);
    await page.setContent(themed(pageHtml()));
    const payload = renderPayload() as { rail: { id: string; at: number; cache: unknown }[] };
    const target = payload.rail.find((card) => card.id === 's1');
    assert.ok(target, 'the fixture dropped session s1, so this measures nothing');
    target.cache = null;
    target.at = now - (ACTIVE_WINDOW_MS - 20_000);
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
    await page.locator('[data-control="railsearch"]').click();
    await page.locator('[data-control="railfilter"]').fill('embedded');
    await page.locator('[data-control="railfilters"]').focus();
    await page.evaluate(SETTLED);
    const active = page.locator('[data-control="railcount:active"]');
    assert.equal(await active.count(), 1);
    await active.focus();
    await pauseClock(page);
    await page.clock.runFor(25_000);
    assert.equal(await active.count(), 0, 'the zero-match Active shortcut stayed on the rail');
    const next = 'railfilters';
    assert.equal(
      await page.evaluate(`document.activeElement?.dataset.control ?? null`),
      next,
      'the tick left focus on a removed shortcut',
    );
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

test(
  'releasing a held text selection retains the selected zero-match Active shortcut',
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
      const read = await pressActiveOverLeavingSession(page);
      // A held session-list text selection defers both header and list repaint.

      await page.evaluate(`(() => {
        const range = document.createRange();
        range.selectNodeContents(document.querySelector('.railcard[data-session="s1"]'));
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      })()`);
      await pauseClock(page);
      await page.clock.runFor(25_000);
      // Wait for selectionchange to release the deferred update. The paused clock cannot advance an animation-frame wait.

      await page.evaluate('getSelection().removeAllRanges()');
      await page.waitForFunction(`document.querySelector('.railcard[data-session="s1"]') === null`);
      const after = await read();
      assert.equal(after.pressed, 'true', 'the selected zero-match shortcut disappeared after selection release');
      assert.deepEqual(failures, [], 'the panel threw while releasing the held selection');
    } finally {
      await browser.close();
    }
  },
);

test(
  'the rail head row funnel and magnifier take the session action hover chip and scale with the text',
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
      await layoutAt(page, 1350);
      for (const control of ['railsearch', 'railfilters']) {
        const button = page.locator(`.railfiltertools [data-control="${control}"]`);
        await button.hover();
        const style = await button.evaluate((node) => {
          const computed = getComputedStyle(node);
          return { color: computed.color, background: computed.backgroundColor, radius: computed.borderRadius };
        });
        assert.deepEqual(
          style,
          { color: 'rgb(204, 204, 204)', background: 'rgba(90, 93, 94, 0.31)', radius: '4px' },
          `the ${control} button wears ${JSON.stringify(style)} under the pointer, not the session action hover chip`,
        );
      }
      // Doubling header text size must scale both dimensions of each tool.
      const sized = async () =>
        await Promise.all(
          ['railsearch', 'railfilters'].map(
            async (control) => await page.locator(`.railfiltertools [data-control="${control}"]`).boundingBox(),
          ),
        );
      const before = await sized();
      const size = (await page.evaluate(
        `parseFloat(getComputedStyle(document.querySelector('.railfilterrow')).fontSize)`,
      )) as number;
      await page.evaluate(`document.querySelector('.railfilterrow').style.fontSize = '${size * 2}px'`);
      await page.evaluate(SETTLED);
      const after = await sized();
      for (const [index, control] of ['railsearch', 'railfilters'].entries()) {
        const was = before[index];
        const now = after[index];
        assert.ok(
          was && now && now.width / was.width > 1.8 && now.height / was.height > 1.8,
          `the ${control} button went from ${JSON.stringify(was)} to ${JSON.stringify(now)} under text twice the size, so one side did not scale`,
        );
      }
    } finally {
      await browser.close();
    }
  },
);
