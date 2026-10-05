import { test } from 'vitest';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from 'playwright-core';
import { browserOrNone, SETTLED } from '../test/browser.ts';
import {
  PROJECT_SPEND_INDEXING_HOLD_MS as INDEXING_HOLD_MS,
  PROJECT_SPEND_INDEXING_SHOW_MS as INDEXING_SHOW_MS,
} from './view/projectspend.ts';
import { RAIL_MIN_WIDTH, RAIL_WIDTH_DEFAULT, RAIL_WIDTH_MIN } from './turnview.ts';
import { PROJECT_SPEND_SHORT_LABEL } from './webview/projectspend.ts';
import { formatProjectCost, prepareProjectSpendView, projectSpendWindows } from './projectspend.ts';
import type { ProjectUsageBucket } from './projectspend.ts';
import {
  NOW,
  PROJECT_SPEND,
  PROJECT_SPEND_INDEXING_WORD,
  PROJECT_SPEND_UNDATED_RATES,
  pageHtml,
  renderPayload,
  themed,
} from './panelfixture.ts';

const source = fs.readFileSync(path.join(__dirname, 'webview', 'panel.ts'), 'utf8');
const DOWN_CARET = (() => {
  const found = /const TWIST = \{ open: '([^']+)'/.exec(source);
  assert.ok(found, 'the panel no longer declares TWIST, so nothing here knows which caret a face should wear');
  return JSON.parse(`"${found[1]}"`) as string;
})();

interface SpendLayout {
  rail: { left: number; right: number } | null;
}

async function layoutAt(page: Page, width: number): Promise<SpendLayout> {
  await page.setViewportSize({ width, height: 900 });
  await page.evaluate(`window.postMessage(${JSON.stringify(renderPayload())}, '*')`);
  await page.evaluate(SETTLED);
  return (await page.evaluate(`(() => {
    const rail = document.getElementById('rail');
    if (!rail || rail.hidden) return { rail: null };
    const box = rail.getBoundingClientRect();
    return { rail: { left: box.left, right: box.right } };
  })()`)) as SpendLayout;
}

function projectSpendBucket(reportedCost: number | null): ProjectUsageBucket {
  return {
    localDate: projectSpendWindows(NOW)[0].start,
    agent: 'claude',
    provider: 'anthropic',
    model: 'claude-5',
    contextWindow: null,
    contextBand: null,
    billingClass: 'metered',
    inferenceClass: null,
    serviceTier: null,
    reportedCost,
    requests: 1,
    usage: { input: 1, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 1, thinking: 0 },
  };
}

function lowerBoundProjectSpend() {
  return prepareProjectSpendView(
    [
      {
        file: 'one.jsonl',
        workspace: '/w',
        size: 1,
        mtimeMs: 1,
        offset: 1,
        trailing: '',
        indexedAt: NOW,
        buckets: [projectSpendBucket(4.82), projectSpendBucket(null)],
      },
    ],
    () => null,
    { now: NOW },
  );
}
// The session picker retains at least this width beside Project cost and New.

const PICKER_FLOOR = 72;

// Share the unsupported-usage explanation between its two checks.

const NO_PRICE_NOTE = 'Some Claude usage has no rate. The totals leave it out.';

// The subscription caveat stays inside Pricing details.

const RATE_CAVEAT = 'These amounts price the usage at API rates. A subscription plan charges differently.';

// Every Claude cost is unknown in this fixture. Unknown values also exercise the table's widest text.

const NOTHING_PRICED = {
  ...PROJECT_SPEND,
  windows: PROJECT_SPEND.windows.map((window) => ({
    ...window,
    dollars: null,
    display: 'Cost unknown',
    status: 'unknown',
    partial: true,
    pricedRequests: 0,
    unpricedRequests: 2_709,
  })),
  categories: PROJECT_SPEND.categories.map((category) =>
    category.id === 'claude'
      ? {
          ...category,
          windows: category.windows.map((window) => ({
            ...window,
            dollars: null,
            display: 'Cost unknown',
            status: 'unknown',
            partial: true,
            pricedRequests: 0,
            unpricedRequests: 2_709,
          })),
        }
      : category,
  ),
};

test('project cost uses one popover without moving the rail or list', { timeout: 60_000 }, async (t) => {
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

    const wide = await layoutAt(page, 1350);
    assert.ok(wide.rail, 'the wide panel drew no rail, so it cannot hold project cost');
    const rail = (await page.evaluate(`(() => {
      const host = document.querySelector('.projectspendrailhost');
      const button = host && host.querySelector('button');
      if (!host || !button) return null;
      const h = host.getBoundingClientRect();
      const b = button.getBoundingClientRect();
      return { tag: button.tagName, expanded: button.getAttribute('aria-expanded'), controls: button.getAttribute('aria-controls'),
        name: button.getAttribute('aria-label'), text: button.textContent, left: h.left, right: h.right, buttonRight: b.right,
        label: button.querySelector('.projectspendname').textContent,
        when: (button.querySelector('.projectspendwhen') || {}).textContent || null,
        twist: button.querySelector('.projectspendtwist').textContent };
    })()`)) as {
      tag: string;
      expanded: string | null;
      controls: string | null;
      name: string;
      text: string;
      left: number;
      right: number;
      buttonRight: number;
      label: string;
      when: string | null;
      twist: string;
    } | null;
    assert.ok(rail, 'the rail has no Project cost disclosure');
    assert.equal(rail.tag, 'BUTTON', 'Project cost is not a real button in the rail');
    assert.equal(rail.expanded, 'false', 'the rail detail starts open');
    assert.equal(rail.controls, 'projectspendpop', 'the rail trigger does not name the shared popover');
    assert.match(
      rail.name,
      /Project cost.*Today.*\$4\.82.*Show cost details/,
      'the rail name loses the value or action',
    );
    // The figure leads and the period follows it, so the label is one phrase that never breaks.
    assert.equal(rail.label, 'Project cost', 'the rail face no longer names what the figure is');
    assert.match(
      rail.text,
      /Project cost\$4\.82 today/,
      'the collapsed rail face does not show the supplied today value',
    );
    assert.equal(rail.when, 'today', 'the rail face does not say which period the figure covers');
    // The Project cost face uses the prompt box picker caret in both states.

    assert.equal(rail.twist, DOWN_CARET, 'the collapsed Project cost face wears the rail fold twist');
    assert.ok(
      rail.left >= wide.rail.left - 1 && rail.right <= wide.rail.right + 1 && rail.buttonRight <= wide.rail.right + 1,
      'the collapsed Project cost row exceeds the rail width',
    );
    const beforeOpen = (await page.evaluate(`(() => {
      const rail = document.getElementById('rail').getBoundingClientRect();
      const list = document.getElementById('list').getBoundingClientRect();
      return { rail: [rail.top, rail.height], list: [list.top, list.height] };
    })()`)) as { rail: number[]; list: number[] };
    await page.locator('.projectspendrailhost .projectspendbutton').click();
    const opened = (await page.evaluate(`(() => {
      const pop = document.getElementById('projectspendpop');
      const r = pop.getBoundingClientRect();
      const rail = document.getElementById('rail').getBoundingClientRect();
      const list = document.getElementById('list').getBoundingClientRect();
      // A missing element answers in words rather than throwing, so a box that lost a part
      // fails on the measurement below and says which part it lost.
      const sized = function (selector) {
        const node = document.querySelector(selector);
        return node ? getComputedStyle(node).fontSize : 'no ' + selector;
      };
      return { hidden: pop.hidden, role: pop.getAttribute('role'), focused: pop.contains(document.activeElement), text: pop.textContent,
        fonts: [sized('#list'), sized('#projectspendpop .projectspendgrid td'),
          sized('#projectspendpop .projectspendrate'), sized('#projectspendpop .projectspendpricing summary'),
          sized('#projectspendpop .projectspendmeta')],
        visibleText: pop.innerText, left: r.left, right: r.right,
        width: document.documentElement.scrollWidth, viewport: innerWidth, rail: [rail.top, rail.height], list: [list.top, list.height] };
    })()`)) as {
      hidden: boolean;
      role: string | null;
      focused: boolean;
      text: string;
      visibleText: string;
      fonts: string[];
      left: number;
      right: number;
      width: number;
      viewport: number;
      rail: number[];
      list: number[];
    };
    assert.equal(opened.hidden, false, 'pressing Project cost did not open its detail');
    assert.equal(opened.role, 'dialog', 'Project cost is not a dialog popover');
    assert.equal(opened.focused, true, 'opening Project cost leaves keyboard focus outside its dialog');
    // Compare table, notes, disclosure, and metadata text sizes with the session list outside the dialog.

    assert.deepEqual(
      opened.fonts,
      Array.from({ length: 5 }, () => opened.fonts[0]),
      `the panel draws its list, and the box its table, notes, disclosure and meta row, ` +
        `at ${opened.fonts.join(', ')}`,
    );
    // Open the disclosure through its DOM property to preserve focus. Measure rate items while they are visible.

    const drawn = (await page.evaluate(`(() => {
      const pricing = document.querySelector('#projectspendpop .projectspendpricing');
      pricing.open = true;
      const items = [...pricing.querySelectorAll('.projectspendratelist li')];
      const read = { items: items.map(function (item) { return item.innerText; }),
        boxes: items.filter(function (item) { return item.getClientRects().length > 0; }).length,
        font: items.length ? getComputedStyle(items[0]).fontSize : 'no rate lines' };
      pricing.open = false;
      return read;
    })()`)) as { items: string[]; boxes: number; font: string };
    assert.deepEqual(
      drawn.items,
      [
        'Provider-reported, where recorded',
        'Workspace contract, effective Aug 1, 2026',
        'Anthropic list price, effective Aug 1, 2026',
      ],
      `Pricing details draws its rates as ${JSON.stringify(drawn.items)}`,
    );
    assert.equal(
      drawn.boxes,
      drawn.items.length,
      `${drawn.items.length - drawn.boxes} rate lines carry no box, so nothing on screen draws them`,
    );
    assert.equal(
      drawn.font,
      opened.fonts[0],
      `the rate lines are drawn at ${drawn.font} with the panel at ${opened.fonts[0]}`,
    );
    assert.deepEqual(opened.rail, beforeOpen.rail, 'opening Project cost changes the rail geometry');
    assert.deepEqual(opened.list, beforeOpen.list, 'opening Project cost changes the list geometry');
    for (const text of [
      'Today',
      '7 days',
      '30 days',
      'Claude',
      'Codex',
      'Total',
      'Records since Aug 3',
      'Dotted figures are lower bounds.',
      RATE_CAVEAT,
      'Rates used, in the order the panel applies them:',
      'Provider-reported, where recorded',
      'Workspace contract, effective Aug 1, 2026',
      'Anthropic list price, effective Aug 1, 2026',
    ]) {
      assert.ok(opened.text.includes(text), `the opened rail detail lost supplied text: ${text}`);
    }
    // `pricing.ts` names a public rate Anthropic list price, and a line takes that name whole.
    // Words added to it read as "Anthropic list price list price" on the reader's screen.
    assert.equal(
      opened.text.includes('list price list price'),
      false,
      'a rate line says list price twice for a rate the pricing has already named',
    );
    assert.equal(
      opened.text.includes('spend'),
      false,
      'a row still carries the payload word spend under a title that already says cost',
    );
    // The rate-order explanation appears once.
    assert.equal(
      opened.text.includes('Provider-reported cost, effective'),
      false,
      'Pricing details still lists a line for each rate the pricing answered with',
    );
    assert.equal(opened.text.includes('Index complete'), false, 'the normal completion state is still shown');
    assert.equal(opened.text.includes('sources remaining'), false, 'per-source queue progress is still shown');
    assert.equal(
      opened.text.includes('Cloud and API spend'),
      false,
      'the primary rows still use billing-category wording',
    );
    assert.equal(
      opened.text.includes('Codex API equivalent'),
      false,
      'Codex still uses list-price terminology in its primary label',
    );
    assert.equal(
      opened.text.includes('requests not priced'),
      false,
      'the popover still headlines a technical request count',
    );
    assert.equal(
      opened.text.includes('Codex / OpenAI'),
      false,
      'the primary UI still qualifies Codex with its provider',
    );
    assert.equal(
      opened.visibleText.includes('A subscription plan charges differently'),
      false,
      'the closed Pricing details disclosure leaves its caveat in the primary view',
    );
    assert.equal(opened.text.includes('+'), false, 'a partial amount still uses a plus suffix');
    assert.ok(
      opened.left >= -1 && opened.right <= opened.viewport + 1,
      'the opened Project cost popover exceeds the viewport',
    );
    assert.ok(opened.width <= opened.viewport + 1, 'opening Project cost makes the wide panel scroll sideways');
    const wideAge = (await page.evaluate(`(() => {
      const updated = document.querySelector('#projectspendpop .projectspendupdated');
      return { text: updated.textContent, title: updated.title, name: updated.getAttribute('aria-label') };
    })()`)) as { text: string; title: string; name: string | null };
    assert.match(
      wideAge.text,
      /^Updated (?:now|\d+(?:m|h|d|w|mo|y) ago)$/,
      'the opened Project cost age is not relative',
    );
    assert.ok(
      wideAge.title && wideAge.name?.includes(wideAge.title),
      'the opened Project cost age lacks its full timestamp',
    );

    // Keep the undated rate beside a dated rate so the closing wording cannot apply one date to both.

    const undatedSpend = { ...PROJECT_SPEND, rateSources: PROJECT_SPEND_UNDATED_RATES };
    await page.evaluate(
      `window.postMessage(${JSON.stringify({ type: 'projectSpend', projectSpend: undatedSpend })}, '*')`,
    );
    await page.evaluate(SETTLED);
    const undated = (await page.locator('#projectspendpop').textContent()) ?? '';
    for (const line of [
      'Provider-reported, where recorded',
      'Workspace contract, effective Aug 1, 2026',
      'OpenAI list price',
    ]) {
      assert.ok(undated.includes(line), `the popover reads "${undated}", so it lost the rate line "${line}"`);
    }
    assert.equal(
      undated.includes('OpenAI list price, effective'),
      false,
      'an estimate that arrived without a date is given the date of the estimate beside it',
    );
    assert.equal(
      undated.includes('took effect on'),
      false,
      'a closing sentence dates an estimated rate that arrived without a date',
    );
    // A single rate source uses a sentence rather than an ordered list.

    const lone = PROJECT_SPEND.rateSources.filter((source) => source.provenance === 'public');
    assert.equal(lone.length, 1, 'the fixture carries no single public rate, so this measures nothing');
    const oneRate = { ...PROJECT_SPEND, rateSources: lone };
    await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'projectSpend', projectSpend: oneRate })}, '*')`);
    await page.evaluate(SETTLED);
    const single = (await page.evaluate(`(() => ({
      text: document.getElementById('projectspendpop').textContent,
      items: document.querySelectorAll('#projectspendpop .projectspendratelist li').length,
    }))()`)) as { text: string; items: number };
    assert.ok(
      single.text.includes('Rate: Anthropic list price, effective Aug 1, 2026.'),
      `the popover reads "${single.text}", so one rate is not named in the singular`,
    );
    assert.equal(single.items, 0, 'a workspace priced from one rate is given a list of one');

    await page.evaluate(
      `window.postMessage(${JSON.stringify({ type: 'projectSpend', projectSpend: PROJECT_SPEND })}, '*')`,
    );
    await page.evaluate(SETTLED);

    await page.locator('.projectspendperiod').nth(1).click();
    const period = (await page.evaluate(`(() => ({
      pressed: [...document.querySelectorAll('.projectspendperiod')].map((button) => button.getAttribute('aria-pressed')),
      text: document.getElementById('projectspendpop').textContent,
      visible: document.getElementById('projectspendpop').innerText,
      rows: [...document.querySelectorAll('#projectspendpop .projectspendgrid tbody tr')].map(function (row) {
        const cell = row.querySelectorAll('.projectspendcell')[1];
        return { name: row.querySelector('th').textContent, text: cell.textContent, label: cell.getAttribute('aria-label') };
      }),
      face: document.querySelector('.projectspendrailhost .projectspendbutton').textContent,
      name: document.querySelector('.projectspendrailhost .projectspendbutton').getAttribute('aria-label'),
    }))()`)) as {
      pressed: string[];
      text: string;
      visible: string;
      rows: { name: string; text: string; label: string | null }[];
      face: string;
      name: string;
    };
    assert.deepEqual(period.pressed, ['false', 'true', 'false'], 'the selected Project cost period is not exposed');
    // Each lower-bound cell retains At least in its accessible name and uses a dotted underline.

    assert.deepEqual(
      period.rows,
      [
        { name: 'Claude', text: '$18.04', label: 'At least $18.04' },
        { name: 'Codex', text: '$0.20', label: null },
        { name: 'Total', text: '$18.24', label: 'At least $18.24' },
      ],
      'the 7-day column lost an agent, a total, or the floor wording behind a lower bound',
    );
    assert.match(
      period.face,
      /At least \$18\.24 · 7d/,
      'the collapsed Project cost face stays on Today after selecting 7 days',
    );
    assert.match(
      period.name,
      /Project cost.*7 days.*At least \$18\.24/,
      'the collapsed Project cost name loses the selected 7-day value',
    );
    assert.ok(
      period.text.includes(NO_PRICE_NOTE),
      `the popover reads "${period.text}", so it does not explain the partial Claude amount`,
    );
    assert.equal(
      period.visible.includes(NO_PRICE_NOTE),
      false,
      'unpriced usage is explained in the primary view rather than inside Pricing details',
    );
    assert.doesNotMatch(
      period.text,
      /request(?:s)? not priced|Claude \/|Codex \/ OpenAI/,
      'the selected period exposes request counts or provider plumbing',
    );

    await page.locator('.projectspendperiod').nth(2).click();
    const thirtyDayFace = (await page.evaluate(`(() => {
      const button = document.querySelector('.projectspendrailhost .projectspendbutton');
      return { text: button.textContent, name: button.getAttribute('aria-label') };
    })()`)) as { text: string; name: string };
    assert.match(
      thirtyDayFace.text,
      /At least \$52\.10 · 30d/,
      'the collapsed Project cost face stays on 7 days after selecting 30 days',
    );
    assert.match(
      thirtyDayFace.name,
      /Project cost.*30 days.*At least \$52/,
      'the collapsed Project cost name loses the selected 30-day value',
    );
    await page.locator('.projectspendperiod').nth(1).click();

    await page.evaluate(
      `window.postMessage(${JSON.stringify({ type: 'projectSpend', projectSpend: NOTHING_PRICED })}, '*')`,
    );
    await page.evaluate(SETTLED);
    const unknown = (await page.evaluate(`(() => {
      const rows = [...document.querySelectorAll('#projectspendpop .projectspendgrid tbody tr')];
      const claude = rows.find(function (row) { return row.querySelector('th').textContent === 'Claude'; });
      return { cells: [...claude.querySelectorAll('.projectspendcell')].map(function (cell) {
          return { text: cell.textContent, name: cell.getAttribute('aria-label'), title: cell.title };
        }),
        text: document.getElementById('projectspendpop').textContent,
        visible: document.getElementById('projectspendpop').innerText };
    })()`)) as { cells: { text: string; name: string | null; title: string }[]; text: string; visible: string };
    // Cells show Unknown and expose Cost unknown in their accessible names and tooltips.

    assert.deepEqual(
      unknown.cells,
      Array.from({ length: 3 }, () => ({ text: 'Unknown', name: 'Cost unknown', title: 'Cost unknown' })),
      'unsupported Claude usage does not mark every Claude period unknown in a word the column can hold',
    );
    assert.doesNotMatch(
      unknown.text,
      /2,709|Claude \/ Anthropic/,
      'unsupported Claude usage exposes raw counts or provider names',
    );
    // Unsupported usage stays unexplained in the primary view and receives an explanation inside Pricing details.

    assert.ok(
      unknown.text.includes(NO_PRICE_NOTE),
      `the popover reads "${unknown.text}", so a payload it can price nothing in explains ` +
        'nothing, even inside Pricing details',
    );
    assert.equal(
      unknown.visible.includes(NO_PRICE_NOTE),
      false,
      'the note about unpriced usage is drawn in the primary view rather than inside Pricing details',
    );
    // Opening Pricing details must reveal the unsupported-usage explanation.

    const behind = (await page.evaluate(`(() => {
      const pricing = document.querySelector('#projectspendpop .projectspendpricing');
      pricing.open = true;
      const said = document.getElementById('projectspendpop').innerText;
      pricing.open = false;
      return said;
    })()`)) as string;
    assert.ok(
      behind.includes(NO_PRICE_NOTE),
      `the opened Pricing details reads "${behind}", so the reason for an unknown figure ` + 'is drawn nowhere at all',
    );
    assert.doesNotMatch(
      unknown.text,
      /Dotted figures are lower bounds/,
      'a payload with no lower bound still says what a dotted figure means',
    );

    const focusUpdate = { ...PROJECT_SPEND, lastIndexedAt: NOW - 60_000 };
    await page.evaluate(
      `window.postMessage(${JSON.stringify({ type: 'projectSpend', projectSpend: focusUpdate })}, '*')`,
    );
    await page.evaluate(SETTLED);
    assert.equal(
      await page.evaluate(`document.activeElement && document.activeElement.dataset.control`),
      'projectspend:period:sevenDays',
      'a Project cost update drops focus from the selected period',
    );

    // An unchanged payload must retain the focused period control's DOM identity.

    await page.evaluate(`(() => {
      window.__period = document.querySelector('#projectspendpop [data-control="projectspend:period:sevenDays"]');
    })()`);
    await page.evaluate(
      `window.postMessage(${JSON.stringify({ type: 'projectSpend', projectSpend: focusUpdate })}, '*')`,
    );
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await page.evaluate(`({
      kept: window.__period.isConnected,
      focused: document.activeElement === window.__period,
    })`),
      { kept: true, focused: true },
      'an index report that moved nothing still rebuilds the Project cost popover under the reader',
    );

    const updatedSpend = { ...PROJECT_SPEND, earliestRecord: '2026-08-04' };
    await page.evaluate(`(() => {
      const target = document.querySelector('#projectspendpop .projectspendpoptitle');
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      window.postMessage(${JSON.stringify({ type: 'projectSpend', projectSpend: updatedSpend })}, '*');
    })()`);
    await page.evaluate(SETTLED);
    const held = (await page.evaluate(`(() => ({
      selection: getSelection().toString(),
      text: document.getElementById('projectspendpop').textContent,
    }))()`)) as { selection: string; text: string };
    assert.equal(held.selection, 'Project cost', 'an index update clears selected Project cost text');
    assert.equal(
      held.text.includes('Records since Aug 4'),
      false,
      'an index update replaces Project cost while the reader is selecting it',
    );
    await page.evaluate(
      `(() => { getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); })()`,
    );
    await page.evaluate(SETTLED);
    const released = await page.locator('#projectspendpop').textContent();
    assert.equal(
      released?.includes('Records since Aug 4'),
      true,
      'the newest Project cost value is not drawn after the selection is released',
    );

    await page.keyboard.press('Escape');
    const closed = await page.evaluate(`(() => {
      const button = document.querySelector('.projectspendrailhost .projectspendbutton');
      const pop = document.getElementById('projectspendpop');
      return { expanded: button.getAttribute('aria-expanded'), hidden: pop.hidden,
        focused: document.activeElement === button };
    })()`);
    assert.deepEqual(
      closed,
      { expanded: 'false', hidden: true, focused: true },
      'Escape does not close Project cost and return focus',
    );

    // A later payload must preserve focus on the face after the dialog closes.

    await page.evaluate(
      `window.postMessage(${JSON.stringify({ type: 'projectSpend', projectSpend: updatedSpend })}, '*')`,
    );
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await page.evaluate(`(() => {
      const button = document.querySelector('.projectspendrailhost .projectspendbutton');
      return { expanded: button.getAttribute('aria-expanded'), focused: document.activeElement === button };
    })()`),
      { expanded: 'false', focused: true },
      'a message that changed nothing takes the focus the close returned to the Project cost face',
    );

    // aria-expanded and the accessible name must agree while selection defers the face repaint.

    const FACE_OPEN = `(() => {
      const button = document.querySelector('.projectspendrailhost .projectspendbutton');
      const name = button.getAttribute('aria-label') || '';
      return { expanded: button.getAttribute('aria-expanded'),
        named: /Hide cost details$/.test(name) ? 'true' : /Show cost details$/.test(name) ? 'false' : name,
        text: button.textContent };
    })()`;
    interface FaceOpen {
      expanded: string | null;
      named: string;
      text: string;
    }
    const movedFace = {
      ...updatedSpend,
      windows: [
        updatedSpend.windows[0],
        { ...updatedSpend.windows[1], display: 'At least $19.99' },
        ...updatedSpend.windows.slice(2),
      ],
    };
    await page.locator('.projectspendrailhost .projectspendbutton').click();
    await page.evaluate(SETTLED);
    const openedFace = (await page.evaluate(FACE_OPEN)) as FaceOpen;
    assert.deepEqual(
      { expanded: openedFace.expanded, named: openedFace.named },
      { expanded: 'true', named: 'true' },
      'the open Project cost face says it is open in one attribute and shut in the other',
    );
    await page.evaluate(`(() => {
      const target = document.querySelector('#projectspendpop .projectspendpoptitle');
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      window.postMessage(${JSON.stringify({ type: 'projectSpend', projectSpend: movedFace })}, '*');
    })()`);
    await page.evaluate(SETTLED);
    const heldOpen = (await page.evaluate(FACE_OPEN)) as FaceOpen;
    assert.match(
      heldOpen.text,
      /At least \$18\.24/,
      `the face reads "${heldOpen.text}" while the reader holds a selection, so nothing here measures a held repaint`,
    );
    await page.keyboard.press('Escape');
    const heldShut = (await page.evaluate(FACE_OPEN)) as FaceOpen;
    assert.deepEqual(
      { expanded: heldShut.expanded, named: heldShut.named },
      { expanded: 'false', named: 'false' },
      'a Project cost face whose repaint a selection holds back answers the open state two ways at once',
    );

    // Clearing selection applies the deferred face payload.

    await page.evaluate(
      `(() => { getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); })()`,
    );
    await page.evaluate(SETTLED);
    const releasedFace = (await page.evaluate(FACE_OPEN)) as FaceOpen;
    assert.match(
      releasedFace.text,
      /At least \$19\.99/,
      `the face reads "${releasedFace.text}" after the selection was released, so the held repaint never landed`,
    );
    assert.deepEqual(
      { expanded: releasedFace.expanded, named: releasedFace.named },
      { expanded: 'false', named: 'false' },
      'the released Project cost repaint leaves the face saying the box is open',
    );
    // Restore the figures used by the following layout checks.
    await page.evaluate(
      `window.postMessage(${JSON.stringify({ type: 'projectSpend', projectSpend: updatedSpend })}, '*')`,
    );
    await page.evaluate(SETTLED);

    await page.locator('.projectspendrailhost .projectspendbutton').click();
    await page.mouse.click(1300, 800);
    assert.equal(
      await page.locator('#projectspendpop').evaluate((node) => node.getAttribute('hidden') !== null),
      true,
      'clicking away does not close Project cost',
    );

    await page.locator('.projectspendrailhost .projectspendbutton').click();
    // Preserve the table's DOM identity across the responsive boundary so active text selection survives.

    await page.evaluate(`document.querySelector('#projectspendpop .projectspendgrid').__mark = 'box'`);
    await page.setViewportSize({ width: RAIL_MIN_WIDTH - 60, height: 900 });
    await page.evaluate(SETTLED);
    const crossed = (await page.evaluate(`(() => {
      const pop = document.getElementById('projectspendpop');
      const rect = pop.getBoundingClientRect();
      const grid = pop.querySelector('.projectspendgrid');
      return { hidden: pop.hidden, focused: pop.contains(document.activeElement), left: rect.left, right: rect.right,
        viewport: innerWidth, mark: (grid || {}).__mark || null };
    })()`)) as {
      hidden: boolean;
      focused: boolean;
      left: number;
      right: number;
      viewport: number;
      mark: string | null;
    };
    assert.deepEqual(
      { hidden: crossed.hidden, focused: crossed.focused },
      { hidden: false, focused: true },
      'crossing the rail breakpoint closes Project cost or drops dialog focus',
    );
    assert.equal(
      crossed.mark,
      'box',
      'crossing the rail breakpoint tears the open Project cost table down and builds it again',
    );
    assert.ok(
      crossed.left >= -1 && crossed.right <= crossed.viewport + 1,
      'crossing the rail breakpoint leaves Project cost anchored off screen',
    );
    await page.keyboard.press('Escape');
    assert.equal(
      await page.evaluate(
        `document.activeElement === document.querySelector('.projectspendcompacthost .projectspendbutton')`,
      ),
      true,
      'Escape after crossing the rail breakpoint focuses the hidden trigger',
    );

    for (const width of [RAIL_MIN_WIDTH - 60, 340]) {
      await layoutAt(page, width);
      const compact = (await page.evaluate(`(() => {
        const rail = document.getElementById('rail');
        const host = document.querySelector('.projectspendcompacthost');
        const button = host && host.querySelector('button');
        const newControl = document.querySelector('.controls .compactnewsplit');
        if (!host || !button) return null;
        const value = button.querySelector('.projectspendamount');
        const picker = document.querySelector('.controls select');
        return { railHidden: rail.hidden, tag: button.tagName, expanded: button.getAttribute('aria-expanded'),
          name: button.getAttribute('aria-label'), text: button.textContent, newControl: !!newControl,
          valueFits: value.scrollWidth <= value.clientWidth + 1,
          picker: picker ? picker.getBoundingClientRect().width : 0,
          width: document.documentElement.scrollWidth, viewport: innerWidth };
      })()`)) as {
        railHidden: boolean;
        tag: string;
        expanded: string | null;
        name: string;
        text: string;
        newControl: boolean;
        valueFits: boolean;
        picker: number;
        width: number;
        viewport: number;
      } | null;
      assert.ok(compact, `the ${width}px panel has no compact Project cost button`);
      assert.equal(compact.railHidden, true, `the ${width}px panel still uses the rail host`);
      assert.equal(compact.tag, 'BUTTON', `Project cost is not a button at ${width}px`);
      assert.match(
        compact.name,
        /Project cost.*7 days.*At least \$18\.24/,
        `the compact button loses its selected-period value at ${width}px`,
      );
      assert.match(
        compact.text,
        /At least \$18\.24 · 7d/,
        `the compact button stays on today's value or drops the period at ${width}px`,
      );
      assert.equal(compact.valueFits, true, `the selected Project cost amount is clipped at ${width}px`);
      assert.equal(compact.newControl, true, `the ${width}px panel has no compact New control beside Project cost`);
      // The session picker retains enough width to identify the selected session.

      assert.ok(
        compact.picker >= PICKER_FLOOR,
        `the session picker is ${Math.round(compact.picker)}px wide beside Project cost at ${width}px, ` +
          `so it is under the ${PICKER_FLOOR}px this panel holds it to`,
      );
      assert.ok(compact.width <= compact.viewport + 1, `the compact button overflows at ${width}px`);
      await page.evaluate(`window.postMessage({ type: 'focusProjectSpend' }, '*')`);
      await page.evaluate(SETTLED);
      const detail = (await page.evaluate(`(() => {
        const button = document.querySelector('.projectspendcompacthost .projectspendbutton');
        const pop = document.getElementById('projectspendpop');
        const r = pop.getBoundingClientRect();
        return { expanded: button.getAttribute('aria-expanded'), focused: pop.contains(document.activeElement), hidden: pop.hidden,
          left: r.left, right: r.right, width: document.documentElement.scrollWidth, viewport: innerWidth };
      })()`)) as {
        expanded: string | null;
        focused: boolean;
        hidden: boolean;
        left: number;
        right: number;
        width: number;
        viewport: number;
      };
      assert.equal(detail.expanded, 'true', `focusProjectSpend did not open Project cost at ${width}px`);
      assert.equal(detail.focused, true, `focusProjectSpend did not focus the compact dialog at ${width}px`);
      assert.equal(detail.hidden, false, `focusProjectSpend leaves the compact detail hidden at ${width}px`);
      assert.ok(
        detail.left >= -1 && detail.right <= detail.viewport + 1 && detail.width <= detail.viewport + 1,
        `the compact Project cost detail overflows at ${width}px`,
      );
      const age = (await page.evaluate(`(() => {
        const updated = document.querySelector('#projectspendpop .projectspendupdated');
        return { text: updated.textContent, title: updated.title, name: updated.getAttribute('aria-label') };
      })()`)) as { text: string; title: string; name: string | null };
      assert.match(
        age.text,
        /^Updated (?:now|\d+(?:m|h|d|w|mo|y) ago)$/,
        `the compact Project cost age is not relative at ${width}px`,
      );
      assert.ok(
        age.title && age.name?.includes(age.title),
        `the compact Project cost age lacks its full timestamp at ${width}px`,
      );
    }

    for (const count of [0, 1]) {
      const narrow = renderPayload() as { sessions: unknown[]; rail: unknown[]; cards: unknown[]; showing: string };
      narrow.sessions = narrow.sessions.slice(0, count);
      narrow.rail = narrow.rail.slice(0, count);
      narrow.cards = [];
      narrow.showing = count ? 's1' : '';
      await page.setViewportSize({ width: 340, height: 900 });
      await page.evaluate(`window.postMessage(${JSON.stringify(narrow)}, '*')`);
      await page.evaluate(SETTLED);
      const shown = (await page.evaluate(`(() => {
        const controls = document.querySelector('.controls');
        const button = document.querySelector('.projectspendcompacthost .projectspendbutton');
        const newControl = document.querySelector('.controls .compactnewsplit');
        return { controls: !!controls, button: !!button, picker: !!document.querySelector('.controls select'), newControl: !!newControl,
          width: document.documentElement.scrollWidth, viewport: innerWidth };
      })()`)) as {
        controls: boolean;
        button: boolean;
        picker: boolean;
        newControl: boolean;
        width: number;
        viewport: number;
      };
      assert.deepEqual(
        { controls: shown.controls, button: shown.button, picker: shown.picker, newControl: shown.newControl },
        { controls: true, button: true, picker: false, newControl: true },
        `Project cost depends on the absent session picker with ${count} sessions`,
      );
      assert.ok(shown.width <= shown.viewport + 1, `Project cost alone overflows the ${count}-session narrow panel`);
    }

    await page.keyboard.press('Escape');
    const calculating = { ...PROJECT_SPEND, calculating: true };
    await page.evaluate(
      `window.postMessage(${JSON.stringify({ type: 'projectSpend', projectSpend: calculating })}, '*')`,
    );
    await page.evaluate(SETTLED);
    const coldFace = await page.locator('.projectspendcompacthost .projectspendbutton').textContent();
    assert.match(coldFace ?? '', /Calculating…/, 'a cold index presents zero as a calculated cost');
    assert.equal(coldFace?.includes('$0.00'), false, 'a cold index invents a zero-dollar value');
    // A first count covers as much as the index has reached, which is not a period at all.
    assert.equal(
      await page.locator('.projectspendcompacthost .projectspendwhen').count(),
      0,
      'a cold index claims its running figure covers the selected period',
    );
    // The eye is told no period, so a reader who cannot see the face must not be told one.
    assert.equal(
      await page.locator('.projectspendcompacthost .projectspendbutton').getAttribute('aria-label'),
      'Project cost, Calculating…, Show cost details',
      'the cold-index face is named for a period it does not draw',
    );
    await page.evaluate(`window.postMessage({ type: 'focusProjectSpend' }, '*')`);
    await page.evaluate(SETTLED);
    const coldDetail = await page.locator('#projectspendpop').textContent();
    assert.match(
      coldDetail ?? '',
      /Calculating from local records…/,
      'a cold index does not label the detail as calculating',
    );
    assert.equal(coldDetail?.includes('$0.00'), false, 'the cold-index detail invents a zero-dollar value');

    const missing = renderPayload();
    delete missing.projectSpend;
    await page.evaluate(`window.postMessage(${JSON.stringify(missing)}, '*')`);
    await page.evaluate(SETTLED);
    assert.equal(
      await page.locator('.projectspendbutton').count(),
      0,
      'a payload without projectSpend invents a project-cost value',
    );
    assert.equal(
      await page.locator('.controls .compactnewsplit').count(),
      1,
      'removing Project cost also removes the narrow New control',
    );

    // An unchanged empty payload must leave the existing empty host contents intact.

    await page.evaluate(`(() => {
      const host = document.querySelector('.projectspendrailhost');
      const mark = document.createElement('span');
      mark.id = 'spendhostmark';
      host.appendChild(mark);
    })()`);
    await page.evaluate(`window.postMessage(${JSON.stringify(missing)}, '*')`);
    await page.evaluate(SETTLED);
    assert.equal(
      await page.locator('#spendhostmark').count(),
      1,
      'a workspace with no Project cost value has its host emptied again on every message it receives',
    );
    assert.deepEqual(failures, [], 'the panel threw while drawing Project cost');
  } finally {
    await browser.close();
  }
});

// Check the unknown-cost table at wide, narrow, and minimum panel widths.

const NARROW_BOX_WIDTHS = [480, 340, 320];

test('a project cost the panel can price nothing in still fits the narrow box', { timeout: 60_000 }, async (t) => {
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
    await layoutAt(page, NARROW_BOX_WIDTHS[0]);
    await page.evaluate(
      `window.postMessage(${JSON.stringify({ type: 'projectSpend', projectSpend: NOTHING_PRICED })}, '*')`,
    );
    await page.evaluate(SETTLED);
    await page.evaluate(`window.postMessage({ type: 'focusProjectSpend' }, '*')`);
    await page.evaluate(SETTLED);

    for (const width of NARROW_BOX_WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(SETTLED);
      const fit = (await page.evaluate(`(() => {
        const pop = document.getElementById('projectspendpop');
        const grid = pop.querySelector('.projectspendgrid');
        const p = pop.getBoundingClientRect();
        const g = grid.getBoundingClientRect();
        return { hidden: pop.hidden, sideways: Math.round(pop.scrollWidth - pop.clientWidth),
          past: Math.round(g.right - p.right) };
      })()`)) as { hidden: boolean; sideways: number; past: number };
      assert.equal(fit.hidden, false, `the box shut itself at ${width}px, so nothing here was measured`);
      // The table must fit without horizontal scrolling.
      assert.ok(fit.sideways <= 0, `the ${width}px box scrolls ${fit.sideways}px sideways with every window unknown`);
      assert.ok(fit.past <= 1, `the table is drawn ${fit.past}px past the right edge of its own box at ${width}px`);
    }

    // The short cell text retains the full accessible name and tooltip.

    const cell = (await page.evaluate(`(() => {
      const cell = document.querySelector('#projectspendpop .projectspendcell');
      if (!cell) return null;
      return { text: cell.textContent, name: cell.getAttribute('aria-label'), title: cell.title };
    })()`)) as { text: string; name: string | null; title: string } | null;
    assert.deepEqual(
      cell,
      { text: 'Unknown', name: 'Cost unknown', title: 'Cost unknown' },
      'a cost the panel holds no price for spells itself out in the column rather than in its name',
    );
    assert.deepEqual(failures, [], 'the panel threw while drawing a project cost it could price nothing in');
  } finally {
    await browser.close();
  }
});

// Count text rectangles with a Range. A flex item's own rectangle does not reveal wrapped text lines.

const LINES = `const lines = function (node) {
    const range = document.createRange();
    range.selectNodeContents(node);
    return range.getClientRects().length;
  };`;
const RAILFACE = `(() => {
  const rail = document.getElementById('rail');
  const button = document.querySelector('.projectspendrailhost .projectspendbutton');
  const name = button.querySelector('.projectspendname');
  const amount = button.querySelector('.projectspendamount');
  const twist = button.querySelector('.projectspendtwist');
  const box = function (node) {
    const r = node.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  };
  ${LINES}
  return {
    railRight: rail.getBoundingClientRect().right,
    name: box(name), amount: box(amount), twist: box(twist), button: box(button),
    label: name.textContent, value: amount.textContent,
    nameLines: lines(name),
    overflow: button.scrollWidth - button.clientWidth,
  };
})()`;

// Compare the line counter with text that wraps, rather than the flex element's single rectangle.

const LINECOUNTER = `(() => {
  const note = document.querySelector('#projectspendpop .projectspendpricing[open] .projectspendrate');
  ${LINES}
  return { text: note.textContent, lines: lines(note), boxes: note.getClientRects().length };
})()`;

interface RailFace {
  railRight: number;
  name: { top: number; bottom: number; left: number; right: number };
  amount: { top: number; bottom: number; left: number; right: number };
  twist: { top: number; bottom: number; left: number; right: number };
  button: { top: number; bottom: number; left: number; right: number };
  label: string;
  value: string;
  nameLines: number;
  overflow: number;
}

test(
  'a narrow rail gives the Project cost value its own line and never breaks the label',
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
      const faceAt = async (width: number): Promise<RailFace> => {
        await page.evaluate(`document.getElementById('rail').style.flexBasis = '${width}px'`);
        await page.evaluate(SETTLED);
        return (await page.evaluate(RAILFACE)) as RailFace;
      };

      await layoutAt(page, 1350);
      // Use the longest supplied period value to exercise wrapping.

      await page.locator('.projectspendrailhost .projectspendbutton').click();
      await page.locator('.projectspendperiod').nth(2).click();
      // Open Pricing details so the counter can measure its wrapped caveat.

      await page.locator('#projectspendpop [data-control="projectspend:pricing"]').click();
      await page.evaluate(SETTLED);
      const counter = (await page.evaluate(LINECOUNTER)) as { text: string; lines: number; boxes: number };
      assert.ok(
        counter.lines > 1,
        `the counter reads ${counter.lines} lines for "${counter.text}", which the box wrapped, so it counts something else`,
      );
      assert.equal(
        counter.boxes,
        1,
        `those wrapped words are drawn as ${counter.boxes} element boxes, so counting boxes would catch a wrap after all`,
      );
      await page.keyboard.press('Escape');
      await page.evaluate(SETTLED);

      const tight = await faceAt(RAIL_WIDTH_MIN);
      assert.equal(tight.label, 'Project cost', `the ${RAIL_WIDTH_MIN}px rail drew the label as "${tight.label}"`);
      assert.equal(
        tight.nameLines,
        1,
        `Project cost is drawn over ${tight.nameLines} lines at ${RAIL_WIDTH_MIN}px, so the label broke rather than the face`,
      );
      assert.ok(
        tight.amount.top >= tight.name.bottom - 1,
        `the value is drawn from ${Math.round(tight.amount.top)} with the label ending at ${Math.round(tight.name.bottom)} ` +
          `at ${RAIL_WIDTH_MIN}px, so the two still share a line they cannot both fit on`,
      );
      assert.ok(
        tight.amount.right <= tight.railRight + 1,
        `the value ends at ${Math.round(tight.amount.right)} with the ${RAIL_WIDTH_MIN}px rail ending at ` +
          `${Math.round(tight.railRight)}, so the figure is drawn past the column`,
      );
      assert.ok(
        tight.twist.top >= tight.name.top - 2 &&
          tight.twist.top < tight.name.bottom &&
          tight.twist.left >= tight.name.right,
        `the caret is drawn at ${Math.round(tight.twist.top)}, ${Math.round(tight.twist.left)} with the label from ` +
          `${Math.round(tight.name.top)} to ${Math.round(tight.name.bottom)} ending at ${Math.round(tight.name.right)}, ` +
          'so it left the label line or sits over the words',
      );
      assert.ok(
        tight.overflow <= 1 && tight.button.right <= tight.railRight + 1,
        `the face overflows the ${RAIL_WIDTH_MIN}px rail by ${Math.round(tight.overflow)}px`,
      );

      // With sufficient width, the value shares the label's line.

      const roomy = await faceAt(480);
      assert.equal(
        roomy.value,
        tight.value,
        'the value changed with the width, so the two measurements are not of the same face',
      );
      assert.ok(
        Math.abs(roomy.amount.top - roomy.name.top) <= 1,
        `the value is drawn at ${Math.round(roomy.amount.top)} with the label at ${Math.round(roomy.name.top)} on a ` +
          '480px rail, so it takes a line of its own where there is room for both',
      );

      // Restore the default period by keyboard without moving the prompt box.

      await page.locator('.projectspendrailhost .projectspendbutton').focus();
      await page.keyboard.press('Enter');
      await page.locator('.projectspendperiod').nth(0).click();
      await page.keyboard.press('Escape');
      const opening = await faceAt(RAIL_WIDTH_DEFAULT);
      assert.match(opening.value, /\$4\.82 today/, 'the face did not return to the period the panel opens on');
      assert.ok(
        Math.abs(opening.amount.top - opening.name.top) <= 1,
        `the opening value is drawn at ${Math.round(opening.amount.top)} with the label at ` +
          `${Math.round(opening.name.top)} on a ${RAIL_WIDTH_DEFAULT}px rail, so the panel opens on a two-line face`,
      );

      assert.deepEqual(failures, [], 'the panel threw while drawing the narrow Project cost face');
    } finally {
      await browser.close();
    }
  },
);

test('the compact Project cost face gives up a word before it gives up the figure', { timeout: 60_000 }, async (t) => {
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
    assert.ok(
      PROJECT_SPEND_SHORT_LABEL < RAIL_MIN_WIDTH,
      `the short label starts at ${PROJECT_SPEND_SHORT_LABEL}px and the rail leaves at ${RAIL_MIN_WIDTH}px, ` +
        'so no width measured here has a compact face at all',
    );
    // Check both sides of the short-label boundary and the named wide and narrow widths.

    const widths: [number, string][] = [
      [640, 'Project cost'],
      [PROJECT_SPEND_SHORT_LABEL, 'Project cost'],
      [PROJECT_SPEND_SHORT_LABEL - 1, 'Cost'],
      [340, 'Cost'],
    ];
    for (const [width, label] of widths) {
      await layoutAt(page, width);
      const face = (await page.evaluate(`(() => {
        const button = document.querySelector('.projectspendcompacthost .projectspendbutton');
        if (!button) return null;
        return { label: button.querySelector('.projectspendname').textContent,
          name: button.getAttribute('aria-label'),
          overflow: document.documentElement.scrollWidth - innerWidth };
      })()`)) as { label: string; name: string; overflow: number } | null;
      assert.ok(face, `the ${width}px panel drew no compact Project cost face`);
      assert.equal(face.label, label, `the compact face reads "${face.label}" at ${width}px`);
      // The accessible name retains Project cost when the visible label shortens.

      assert.match(
        face.name,
        /^Project cost, /,
        `the compact face is called "${face.name}" at ${width}px, so a reader who cannot see it loses the subject`,
      );
      assert.ok(face.overflow <= 1, `the compact face overflows the ${width}px panel by ${face.overflow}px`);
    }
    assert.deepEqual(failures, [], 'the panel threw while drawing the compact Project cost face');
  } finally {
    await browser.close();
  }
});

// Measure text and pseudo-elements to identify line-opening separators and the metadata row's reserved height.

const METALINES = `(() => {
  const meta = document.querySelector('#projectspendpop .projectspendmeta');
  if (!meta) return null;
  const style = getComputedStyle(meta);
  const edge = meta.getBoundingClientRect().left
    + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
  const pieces = [];
  const walker = document.createTreeWalker(meta, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent;
    for (let i = 0; i < text.length; i++) {
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const rect = range.getBoundingClientRect();
      if (!rect.width && !rect.height) continue;
      pieces.push({ text: text[i], top: rect.top, left: rect.left });
    }
  }
  for (const part of meta.querySelectorAll('*')) {
    const before = getComputedStyle(part, '::before').content;
    if (before === 'none' || before === 'normal') continue;
    const rect = part.getClientRects()[0];
    if (!rect) continue;
    pieces.push({ text: before, top: rect.top, left: rect.left });
  }
  return {
    opens: pieces.filter(function (piece) { return piece.left <= edge + 1; })
      .sort(function (a, b) { return a.top - b.top; })
      .map(function (piece) { return piece.text; }),
    separator: pieces.some(function (piece) { return piece.text.indexOf('\\u00B7') >= 0; }),
    height: meta.getBoundingClientRect().height,
  };
})()`;
interface MetaLines {
  opens: string[];
  separator: boolean;
  height: number;
}

// The indexing word and update age share one slot with a minimum width.

const SLOT = `(() => {
  const node = document.querySelector('#projectspendpop .projectspendupdated, #projectspendpop .projectspendupdating');
  if (!node) return { text: '', width: 0 };
  return { text: node.textContent, width: Math.round(node.getBoundingClientRect().width) };
})()`;
interface Slot {
  text: string;
  width: number;
}

// Use several larger font sizes to exercise metadata wrapping across different installed fonts.

const META_WRAP_SIZES = [24, 32, 44, 60];

test('the indexing word waits for a run worth reading and then holds the box still', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (e) => failures.push(String(e)));
    await page.setContent(
      pageHtml().replace(
        'window.__posted = [];',
        `window.__posted = [];
        window.__projectSpendPlacedFont = null;
        const NativeResizeObserver = window.ResizeObserver;
        window.ResizeObserver = class extends NativeResizeObserver {
          constructor(callback) {
            super((entries, observer) => {
              callback(entries, observer);
              const pop = document.getElementById('projectspendpop');
              if (pop && entries.some(({ target }) => target.id === 'projectspendpop' || target.classList.contains('projectspendhost'))) {
                window.__projectSpendPlacedFont = getComputedStyle(pop).fontSize;
              }
            });
          }
        };`,
      ),
    );
    await layoutAt(page, 1350);
    await page.locator('.projectspendrailhost .projectspendbutton').click();
    await page.evaluate(SETTLED);

    // Read the indexing word and the dialog height. An empty text node counts as no word.

    const READ = `(() => {
      const pop = document.getElementById('projectspendpop');
      const word = pop.querySelector('.projectspendupdating');
      return { word: word && word.textContent ? word.textContent : null,
        height: Math.round(pop.getBoundingClientRect().height) };
    })()`;
    interface Meta {
      word: string | null;
      height: number;
    }
    const post = async (
      indexing: boolean,
      indexingStatus: string | null = PROJECT_SPEND_INDEXING_WORD,
      moved: Record<string, unknown> = {},
    ): Promise<void> => {
      const spend = { ...PROJECT_SPEND, indexing, indexingStatus, ...moved };
      await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'projectSpend', projectSpend: spend })}, '*')`);
      await page.evaluate(SETTLED);
    };

    // Clear the indexing hold and confirm no word remains before measuring a new run.

    const settle = async (): Promise<void> => {
      await post(false, null);
      await page.clock.fastForward(INDEXING_HOLD_MS + 300);
      await page.evaluate(SETTLED);
      const left = (await page.evaluate(READ)) as Meta;
      assert.equal(
        left.word,
        null,
        `the popover still says "${left.word}" ${INDEXING_HOLD_MS + 300}ms after the index stopped, ` +
          'so the run under test starts against a word already on screen',
      );
    };

    // Start the run from a cleared indexing state.

    await settle();
    await post(true);
    const started = (await page.evaluate(READ)) as Meta;
    assert.equal(
      started.word,
      null,
      `the popover says "${started.word}" the moment the index starts, so the line blinks with a flag that ` +
        'turns over many times a minute',
    );

    // No message wakes the panel here. The word arrives on the panel's own timer or not at all.
    await page.clock.fastForward(INDEXING_SHOW_MS + 300);
    await page.evaluate(SETTLED);
    const running = (await page.evaluate(READ)) as Meta;
    const wordSlot = (await page.evaluate(SLOT)) as Slot;
    assert.equal(
      running.word,
      PROJECT_SPEND_INDEXING_WORD,
      `the popover says "${running.word}" after ${INDEXING_SHOW_MS + 300}ms of indexing, so a run long enough to ` +
        'be worth reading is never reported',
    );

    // The metadata separator must not start a line. At the default font, coverage and the indexing word share one line.

    const meta = (await page.evaluate(METALINES)) as MetaLines;
    assert.equal(
      meta.separator,
      true,
      'the meta line draws no separator at all, so nothing below measures where one lands',
    );
    assert.equal(
      meta.opens.length,
      1,
      `the meta row opens ${meta.opens.length} lines at the page font with the word up, so the word and the ` +
        'coverage do not share one line',
    );

    // Compare wrapping at the same font sizes with and without the indexing word.

    interface Row {
      lines: number;
      opens: string[];
      height: number;
    }
    const rowsAtEachFont = async (): Promise<Record<number, Row>> => {
      const read: Record<number, Row> = {};
      for (const size of META_WRAP_SIZES) {
        await page.evaluate(`window.__projectSpendPlacedFont = null; document.body.style.fontSize = '${size}px'`);
        await page.waitForFunction(
          `window.__projectSpendPlacedFont === getComputedStyle(document.getElementById('projectspendpop')).fontSize`,
        );
        await page.evaluate(SETTLED);
        const row = (await page.evaluate(METALINES)) as MetaLines;
        read[size] = {
          lines: row.opens.length,
          opens: row.opens,
          height: ((await page.evaluate(READ)) as Meta).height,
        };
      }
      await page.evaluate(`window.__projectSpendPlacedFont = null; document.body.style.fontSize = ''`);
      await page.waitForFunction(
        `window.__projectSpendPlacedFont === getComputedStyle(document.getElementById('projectspendpop')).fontSize`,
      );
      await page.evaluate(SETTLED);
      return read;
    };
    const wordUp = await rowsAtEachFont();

    // The indexing word outlasts a drained queue to prevent flicker between transcript writes.

    await post(false, null);
    const drained = (await page.evaluate(READ)) as Meta;
    assert.equal(
      drained.word,
      PROJECT_SPEND_INDEXING_WORD,
      `the popover says "${drained.word}" the moment the queue drains, so the word leaves and returns on every file`,
    );

    await page.clock.fastForward(INDEXING_HOLD_MS + 300);
    await page.evaluate(SETTLED);
    const quiet = (await page.evaluate(READ)) as Meta;
    assert.equal(
      quiet.word,
      null,
      `the popover still says "${quiet.word}" ${INDEXING_HOLD_MS + 300}ms after the index stopped`,
    );

    // Indexing state changes must preserve dialog height.

    const heights = [started.height, running.height, drained.height, quiet.height];
    assert.equal(
      new Set(heights).size,
      1,
      `the popover is drawn ${JSON.stringify(heights)} tall as the indexing word joins and leaves the line, ` +
        'so it moves under the reader',
    );

    // The update age and indexing word must use the same number of lines at each tested font size.

    const wordGone = await rowsAtEachFont();
    for (const size of META_WRAP_SIZES) {
      assert.equal(
        wordUp[size].lines,
        wordGone[size].lines,
        `the meta row takes ${wordUp[size].lines} lines with the indexing word and ${wordGone[size].lines} without ` +
          `it at a ${size}px editor font, so the box grows as the index starts`,
      );
      assert.equal(
        wordUp[size].height,
        wordGone[size].height,
        `the popover is drawn ${wordUp[size].height}px tall with the indexing word and ${wordGone[size].height}px ` +
          `without it at a ${size}px editor font, so it moves under the reader`,
      );
      for (const opening of wordUp[size].opens.concat(wordGone[size].opens)) {
        assert.doesNotMatch(
          opening,
          /·/,
          `a line of the meta row opens with ${JSON.stringify(opening)} at a ${size}px editor font, ` +
            'which divides nothing in front of it',
        );
      }
    }
    // At least one tested font size must wrap the metadata row.

    assert.ok(
      META_WRAP_SIZES.some((size) => wordGone[size].lines > 1),
      `the meta row never wrapped at ${META_WRAP_SIZES.join('px, ')}px, so nothing above measures a wrapped line`,
    );

    // The indexing word follows the host payload.

    const sent = 'Reading Codex records…';
    await post(true, sent);
    await page.clock.fastForward(INDEXING_SHOW_MS + 300);
    await page.evaluate(SETTLED);
    const second = (await page.evaluate(READ)) as Meta;
    assert.equal(second.word, sent, `the popover says "${second.word}" while the extension is sending "${sent}"`);
    // Retain the host's last indexing wording while the hold remains active after indexing ends.

    await post(false, '', { earliestRecord: '2026-08-04' });
    const held = (await page.evaluate(READ)) as Meta;
    assert.equal(held.word, sent, `the popover holds "${held.word}" after a run the extension last worded "${sent}"`);

    // The longest tested update age must fit the slot shared with the indexing word.

    await post(false, null, { lastIndexedAt: NOW - 350 * 24 * 60 * 60 * 1000 });
    await page.clock.fastForward(INDEXING_HOLD_MS + 300);
    await page.evaluate(SETTLED);
    const oldest = (await page.evaluate(SLOT)) as Slot;
    assert.match(
      oldest.text,
      /^Updated \d+(?:w|mo|y) ago$/,
      `the row says ${JSON.stringify(oldest.text)} for an index run of nearly a year ago, ` +
        'so nothing here measures a long age against the slot',
    );
    assert.equal(
      oldest.width,
      wordSlot.width,
      `the row gives the update age ${oldest.width}px and the indexing word ${wordSlot.width}px, so the row is ` +
        'wider in one state than the other and wraps in one and not the other',
    );

    assert.deepEqual(failures, [], 'the panel threw while the index flag turned over');
  } finally {
    await browser.close();
  }
});

// Marks identify surviving face, table, and age elements even when replacement would reproduce their attributes.

const MARK_SURFACES = `(() => {
  document.querySelector('.projectspendrailhost .projectspendbutton').__mark = 'face';
  document.querySelector('#projectspendpop .projectspendgrid').__mark = 'box';
  document.querySelector('#projectspendpop [data-project-spend-at]').__mark = 'age';
})()`;
const MARKS = `(() => ({
  face: (document.querySelector('.projectspendrailhost .projectspendbutton') || {}).__mark || null,
  box: (document.querySelector('#projectspendpop .projectspendgrid') || {}).__mark || null,
  age: (document.querySelector('#projectspendpop [data-project-spend-at]') || {}).__mark || null,
}))()`;

// The age timestamp, tooltip, and accessible name must follow the newest payload.

const AGE = `(() => {
  const node = document.querySelector('#projectspendpop [data-project-spend-at]');
  if (!node) return null;
  return { at: node.dataset.projectSpendAt, text: node.textContent,
    title: node.title, name: node.getAttribute('aria-label') };
})()`;
interface Age {
  at: string;
  text: string;
  title: string;
  name: string | null;
}

test('a Project cost message that moved nothing leaves both surfaces standing', { timeout: 60_000 }, async (t) => {
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
    // Disable indexing so its timer cannot alter the dialog between payload checks.

    const still = { ...PROJECT_SPEND, indexing: false };
    const post = async (spend: unknown): Promise<void> => {
      await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'projectSpend', projectSpend: spend })}, '*')`);
      await page.evaluate(SETTLED);
    };
    await post(still);
    await page.locator('.projectspendrailhost .projectspendbutton').click();
    await page.evaluate(SETTLED);
    // Confirm no indexing hold remains before checking element identity.

    assert.equal(
      await page.evaluate(`!document.querySelector('#projectspendpop .projectspendupdating')`),
      true,
      'the indexing word is up, so the hold behind it rebuilds the box during the measurement',
    );
    await page.evaluate(MARK_SURFACES);

    // Post identical figures to check element identity.
    await post(still);
    assert.deepEqual(
      await page.evaluate(MARKS),
      { face: 'face', box: 'box', age: 'age' },
      'a Project cost message carrying nothing new rebuilds the face under the reader or the row they are reading',
    );

    // A changed index timestamp updates the age tooltip and accessible name without replacing the table.

    const before = (await page.evaluate(AGE)) as Age;
    const indexedAt = NOW - 30_000;
    await post({ ...still, lastIndexedAt: indexedAt });
    const after = (await page.evaluate(AGE)) as Age;
    const full = (await page.evaluate(`new Date(${indexedAt}).toLocaleString()`)) as string;
    assert.deepEqual(
      await page.evaluate(MARKS),
      { face: 'face', box: 'box', age: 'age' },
      'a newer index time rebuilt the box, so nothing here measures the pass that skips one',
    );
    assert.notEqual(
      before.at,
      String(indexedAt),
      'the box already carried this index time, so nothing here measures a moment that moved',
    );
    assert.equal(after.at, String(indexedAt), 'a newer index time never reaches the age the box already carries');
    assert.equal(after.title, full, `the age reads "${after.title}" on hover for an index that ran at ${full}`);
    assert.ok(
      after.name?.includes(full),
      `the age is called "${after.name}" to a reader who cannot see it, for an index that ran at ${full}`,
    );
    assert.match(
      after.text,
      /^Updated (?:now|\d+(?:m|h|d|w|mo|y) ago)$/,
      `the age reads "${after.text}" after an index time arrived on a box that was not rebuilt`,
    );

    // A changed cost updates the text while retaining keyed elements.

    await post({ ...still, windows: [{ ...still.windows[0], display: '$5.00' }, ...still.windows.slice(1)] });
    assert.deepEqual(
      await page.evaluate(MARKS),
      { face: 'face', box: 'box', age: 'age' },
      'a changed Project cost figure replaces a surviving face, table, or age node',
    );
    assert.match(
      (await page.locator('.projectspendrailhost .projectspendbutton').textContent()) ?? '',
      /\$5\.00/,
      'the surviving Project cost face did not receive the changed figure',
    );
    assert.deepEqual(failures, [], 'the panel threw while the same Project cost value arrived twice');
  } finally {
    await browser.close();
  }
});

// Measure the table on a themed page so the selected-column tint resolves to a color.

const SPENDGRID = `(() => {
  const pop = document.getElementById('projectspendpop');
  const grid = pop.querySelector('.projectspendgrid');
  return {
    label: grid.getAttribute('aria-label'),
    heads: [...grid.querySelectorAll('thead th')].map(function (head) {
      const button = head.querySelector('button');
      return { scope: head.getAttribute('scope'), tag: button ? button.tagName : null,
        text: button ? button.textContent : head.textContent,
        control: button ? button.dataset.control : null,
        pressed: button ? button.getAttribute('aria-pressed') : null };
    }),
    rows: [...grid.querySelectorAll('tbody tr')].map(function (row) {
      const head = row.querySelector('th');
      return { name: head.textContent, scope: head.getAttribute('scope'),
        total: row.classList.contains('projectspendtotal'),
        cells: [...row.querySelectorAll('.projectspendcell')].map(function (cell) {
          const style = getComputedStyle(cell);
          return { text: cell.textContent, selected: cell.classList.contains('selected'),
            lower: cell.classList.contains('lower'), name: cell.getAttribute('aria-label'), title: cell.title,
            tinted: style.backgroundColor !== 'rgba(0, 0, 0, 0)',
            rule: style.textDecorationLine + ' ' + style.textDecorationStyle };
        }) };
    }),
    notes: [...pop.querySelectorAll(':scope > .projectspendrate')].map(function (note) { return note.textContent; }),
  };
})()`;

interface SpendCell {
  text: string;
  selected: boolean;
  lower: boolean;
  name: string | null;
  title: string;
  tinted: boolean;
  rule: string;
}
interface SpendGrid {
  label: string;
  heads: { scope: string | null; tag: string | null; text: string; control: string | null; pressed: string | null }[];
  rows: { name: string; scope: string | null; total: boolean; cells: SpendCell[] }[];
  notes: string[];
}

test('the Project cost popover reads as one table of agents against periods', { timeout: 60_000 }, async (t) => {
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
    await layoutAt(page, 1350);
    const lowerBound = lowerBoundProjectSpend();
    assert.equal(
      lowerBound.windows[0]?.status,
      'atLeast',
      'the prepared Project cost value is exact, so nothing here measures lower-bound wording',
    );
    await page.evaluate(
      `window.postMessage(${JSON.stringify({
        type: 'projectSpend',
        projectSpend: lowerBound,
      })}, '*')`,
    );
    await page.locator('.projectspendrailhost .projectspendbutton').click();
    assert.deepEqual(
      await page.evaluate(`(() => {
      const cell = document.querySelector('.projectspendtotal .projectspendcell');
      return { text: cell.textContent, name: cell.getAttribute('aria-label'), title: cell.title };
    })()`),
      {
        text: formatProjectCost(4.82),
        name: lowerBound.windows[0]?.display,
        title: lowerBound.windows[0]?.display,
      },
      'the cost cell does not draw the host-prepared lower bound with its visible prefix removed',
    );
    await page.keyboard.press('Escape');
    await page.evaluate(
      `window.postMessage(${JSON.stringify({ type: 'projectSpend', projectSpend: PROJECT_SPEND })}, '*')`,
    );
    await page.evaluate(SETTLED);
    await page.locator('.projectspendrailhost .projectspendbutton').click();
    // Select the middle period to distinguish selection from a fixed-column tint.

    await page.locator('.projectspendperiod').nth(1).click();
    await page.evaluate(SETTLED);
    const grid = (await page.evaluate(SPENDGRID)) as SpendGrid;

    assert.equal(grid.label, 'Project cost by agent and period', 'the table has no name a screen reader can announce');
    // Period headings use buttons and expose their selection through aria-pressed.

    assert.deepEqual(
      grid.heads,
      [
        { scope: null, tag: null, text: '', control: null, pressed: null },
        { scope: 'col', tag: 'BUTTON', text: 'Today', control: 'projectspend:period:today', pressed: 'false' },
        { scope: 'col', tag: 'BUTTON', text: '7 days', control: 'projectspend:period:sevenDays', pressed: 'true' },
        { scope: 'col', tag: 'BUTTON', text: '30 days', control: 'projectspend:period:thirtyDays', pressed: 'false' },
      ],
      'the period controls are no longer the headings of the columns they choose between',
    );

    assert.deepEqual(
      grid.rows.map((row) => [row.name, row.scope, row.total]),
      [
        ['Claude', 'row', false],
        ['Codex', 'row', false],
        ['Total', 'row', true],
      ],
      'the table lost an agent, its total, or the row heading a screen reader reads a cell against',
    );

    // Only the selected column receives a tint across all rows.

    const chosen = grid.heads.findIndex((head) => head.pressed === 'true') - 1;
    for (const row of grid.rows) {
      const tinted = row.cells.map((cell) => cell.selected);
      assert.deepEqual(
        tinted,
        [chosen === 0, chosen === 1, chosen === 2],
        `the ${row.name} row marks ${JSON.stringify(tinted)} with column ${chosen} pressed`,
      );
      for (const [at, cell] of row.cells.entries()) {
        assert.equal(
          cell.tinted,
          at === chosen,
          `the ${row.name} cell in column ${at} draws ${cell.tinted ? 'a tint' : 'no tint'} with column ${chosen} ` +
            'pressed, so the class the panel puts on it paints the wrong cells or none',
        );
      }
    }

    // The collapsed face shows the selected period's total.

    const face = await page.locator('.projectspendrailhost .projectspendamount').textContent();
    const total = grid.rows[2].cells[chosen];
    assert.ok(
      (face ?? '').startsWith(total.name ?? total.text),
      `the face reads "${face}" with the pressed total reading "${total.name ?? total.text}"`,
    );

    // Lower-bound cells omit At least visually and retain it in accessible names and tooltips.

    assert.equal(total.lower, true, 'the 7-day total is drawn as an exact figure, so this measures no lower bound');
    assert.equal(total.text, '$18.24', `the lower-bound cell reads "${total.text}", so the column repeats the words`);
    assert.equal(total.name, 'At least $18.24', 'the lower-bound cell drops its floor wording from its name');
    assert.equal(
      total.title,
      'At least $18.24',
      'the lower-bound cell has no tooltip saying what the dotted rule means',
    );
    const exact = grid.rows[1].cells[chosen];
    assert.deepEqual(
      { lower: exact.lower, name: exact.name, text: exact.text },
      { lower: false, name: null, text: '$0.20' },
      'an exact figure is drawn as a lower bound',
    );
    // The computed dotted underline identifies lower-bound cells.

    assert.equal(
      total.rule,
      'underline dotted',
      `the lower-bound cell is painted "${total.rule}", so nothing a reader can see says it is a floor`,
    );
    assert.equal(
      exact.rule,
      'none solid',
      `the exact cell is painted "${exact.rule}", so an exact figure reads as a lower bound too`,
    );

    assert.deepEqual(
      grid.notes,
      ['Dotted figures are lower bounds.'],
      'the line under the table no longer says what a dotted figure means, or it carries more than that',
    );

    // The compact face opens the same table from the control bar.

    await page.keyboard.press('Escape');
    await layoutAt(page, 340);
    await page.evaluate(`window.postMessage({ type: 'focusProjectSpend' }, '*')`);
    await page.evaluate(SETTLED);
    const compact = (await page.evaluate(SPENDGRID)) as SpendGrid;
    assert.equal(
      await page.evaluate(`!!document.querySelector('.projectspendcompacthost .projectspendbutton')`),
      true,
      'the compact face is not on screen, so this measures the same anchoring twice',
    );
    assert.deepEqual(
      compact.notes,
      grid.notes,
      `the compact popover says "${compact.notes.join(' ')}" where the rail popover says "${grid.notes.join(' ')}"`,
    );
    assert.deepEqual(failures, [], 'the panel threw while drawing the Project cost table');
  } finally {
    await browser.close();
  }
});

test(
  'changed Project cost data keeps focused controls and the open pricing disclosure',
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
      await page.locator('.projectspendrailhost .projectspendbutton').click();
      await page.locator('[data-control="projectspend:period:sevenDays"]').click();
      await page.locator('[data-control="projectspend:pricing"]').click();
      await page.locator('[data-control="projectspend:period:sevenDays"]').focus();
      await page.evaluate(`(() => {
      window.__spendNodes = {
        face: document.querySelector('.projectspendrailhost .projectspendbutton'),
        period: document.querySelector('[data-control="projectspend:period:sevenDays"]'),
        pricing: document.querySelector('.projectspendpricing'),
        summary: document.querySelector('[data-control="projectspend:pricing"]'),
        grid: document.querySelector('.projectspendgrid'),
        cell: document.querySelector('.projectspendtotal .projectspendcell:nth-child(3)'),
      };
    })()`);
      const changed = {
        ...PROJECT_SPEND,
        windows: PROJECT_SPEND.windows.map((window) =>
          window.id === 'sevenDays' ? { ...window, display: 'At least $19.75' } : window,
        ),
        categories: PROJECT_SPEND.categories.map((category) => ({
          ...category,
          windows: category.windows.map((window) =>
            window.id === 'sevenDays' && category.id === 'claude' ? { ...window, display: 'At least $19.55' } : window,
          ),
        })),
        earliestRecord: '2026-08-04',
      };
      await page.evaluate(
        `window.postMessage(${JSON.stringify({ type: 'projectSpend', projectSpend: changed })}, '*')`,
      );
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.evaluate(`(() => {
      const held = window.__spendNodes;
      return {
        face: document.querySelector('.projectspendrailhost .projectspendbutton') === held.face,
        period: document.querySelector('[data-control="projectspend:period:sevenDays"]') === held.period,
        pricing: document.querySelector('.projectspendpricing') === held.pricing,
        summary: document.querySelector('[data-control="projectspend:pricing"]') === held.summary,
        grid: document.querySelector('.projectspendgrid') === held.grid,
        cell: document.querySelector('.projectspendtotal .projectspendcell:nth-child(3)') === held.cell,
        focused: document.activeElement === held.period,
        open: held.pricing.open,
        value: held.cell.textContent,
      };
    })()`),
        {
          face: true,
          period: true,
          pricing: true,
          summary: true,
          grid: true,
          cell: true,
          focused: true,
          open: true,
          value: '$19.75',
        },
        'changed Project cost data replaces a keyed control or closes Pricing details',
      );

      await page.keyboard.press('Escape');
      await page.locator('.projectspendrailhost .projectspendbutton').click();
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.evaluate(`({
      same: document.querySelector('.projectspendpricing') === window.__spendNodes.pricing,
      open: window.__spendNodes.pricing.open,
    })`),
        { same: true, open: true },
        'closing Project cost unmounts its children or forgets the open Pricing details state',
      );
      await page.locator('[data-control="projectspend:pricing"]').focus();
      await page.evaluate(
        `window.postMessage(${JSON.stringify({
          type: 'projectSpend',
          projectSpend: { ...changed, lastIndexedAt: NOW - 20_000 },
        })}, '*')`,
      );
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.evaluate(`({
      same: document.querySelector('[data-control="projectspend:pricing"]') === window.__spendNodes.summary,
      focused: document.activeElement === window.__spendNodes.summary,
      open: window.__spendNodes.pricing.open,
    })`),
        { same: true, focused: true, open: true },
        'a background update steals focus from the surviving pricing summary',
      );
      await page.locator('.railnew').focus();
      await page.evaluate(
        `window.postMessage(${JSON.stringify({
          type: 'projectSpend',
          projectSpend: { ...changed, earliestRecord: '2026-08-03' },
        })}, '*')`,
      );
      await page.evaluate(SETTLED);
      assert.equal(
        await page.evaluate(`document.activeElement === document.querySelector('.railnew')`),
        true,
        'an ordinary Project cost update steals focus from an unrelated control',
      );
      assert.deepEqual(failures, [], 'the panel threw while reconciling changed Project cost data');
    } finally {
      await browser.close();
    }
  },
);

test(
  'Project cost applies only the newest held payload and focuses a surviving fallback',
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
      await page.locator('.projectspendrailhost .projectspendbutton').click();
      const full = renderPayload();
      const middle = { ...PROJECT_SPEND, earliestRecord: '2026-08-05' };
      await page.evaluate(`(() => {
      const title = document.querySelector('.projectspendpoptitle');
      const range = document.createRange();
      range.selectNodeContents(title);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      window.postMessage(${JSON.stringify({
        type: 'projectSpend',
        projectSpend: { ...PROJECT_SPEND, earliestRecord: '2026-08-04' },
      })}, '*');
      window.postMessage(${JSON.stringify({ ...full, projectSpend: middle })}, '*');
      window.postMessage(${JSON.stringify({
        type: 'projectSpend',
        projectSpend: { ...PROJECT_SPEND, earliestRecord: '2026-08-06' },
      })}, '*');
    })()`);
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.evaluate(`({
      selection: getSelection().toString(),
      fourth: document.getElementById('projectspendpop').textContent.includes('Records since Aug 4'),
      fifth: document.getElementById('projectspendpop').textContent.includes('Records since Aug 5'),
      sixth: document.getElementById('projectspendpop').textContent.includes('Records since Aug 6'),
    })`),
        { selection: 'Project cost', fourth: false, fifth: false, sixth: false },
        'a held selection was cleared or an intermediate Project cost payload was rendered',
      );
      await page.evaluate(`getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange'))`);
      await page.evaluate(SETTLED);
      assert.equal(
        ((await page.locator('#projectspendpop').textContent()) ?? '').includes('Records since Aug 6'),
        true,
        'selection release did not apply the newest accepted Project cost payload',
      );

      await page.locator('[data-control="projectspend:period:sevenDays"]').focus();
      await page.evaluate(`window.__removedPeriod = document.activeElement`);
      const onePeriod = {
        ...PROJECT_SPEND,
        windows: PROJECT_SPEND.windows.slice(0, 1),
        categories: PROJECT_SPEND.categories.map((category) => ({
          ...category,
          windows: category.windows.slice(0, 1),
        })),
      };
      await page.evaluate(
        `window.postMessage(${JSON.stringify({ type: 'projectSpend', projectSpend: onePeriod })}, '*')`,
      );
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.evaluate(`({
      removed: !window.__removedPeriod.isConnected,
      focused: document.activeElement && document.activeElement.dataset.control,
    })`),
        { removed: true, focused: 'projectspend:period:today' },
        'removing the focused period does not move focus to the surviving selected period',
      );

      await page.evaluate(`window.__removedPeriod = document.activeElement`);
      await page.evaluate(
        `window.postMessage(${JSON.stringify({
          type: 'projectSpend',
          projectSpend: { ...onePeriod, calculating: true },
        })}, '*')`,
      );
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.evaluate(`({
      removed: !window.__removedPeriod.isConnected,
      focused: document.activeElement && document.activeElement.dataset.control,
    })`),
        { removed: true, focused: 'projectspend:dialog' },
        'a calculating transition leaves focus on a removed period control',
      );

      await page.evaluate(
        `window.postMessage(${JSON.stringify({ type: 'projectSpend', projectSpend: PROJECT_SPEND })}, '*')`,
      );
      await page.evaluate(SETTLED);
      await page.locator('[data-control="projectspend:pricing"]').focus();
      await page.evaluate(`window.__removedPricing = document.activeElement`);
      const noPricing = {
        ...PROJECT_SPEND,
        rateSources: [],
        categories: PROJECT_SPEND.categories.map((category) => ({
          ...category,
          windows: category.windows.map((window) => ({ ...window, unpricedRequests: 0 })),
        })),
      };
      await page.evaluate(
        `window.postMessage(${JSON.stringify({ type: 'projectSpend', projectSpend: noPricing })}, '*')`,
      );
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.evaluate(`({
      removed: !window.__removedPricing.isConnected,
      focused: document.activeElement && document.activeElement.dataset.control,
    })`),
        { removed: true, focused: 'projectspend:period:today' },
        'removing Pricing details does not move focus to the selected period',
      );

      await page.keyboard.press('Escape');
      await page.locator('.projectspendrailhost .projectspendbutton').focus();
      const absent = renderPayload();
      delete absent.projectSpend;
      await page.evaluate(`window.postMessage(${JSON.stringify(absent)}, '*')`);
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.evaluate(`({
      spend: document.querySelectorAll('.projectspendbutton').length,
      fallback: document.activeElement === document.querySelector('.railnew'),
    })`),
        { spend: 0, fallback: true },
        'removing all Project cost data leaves focus in the absent subject',
      );
      assert.deepEqual(failures, [], 'the panel threw while applying held or removed Project cost data');
    } finally {
      await browser.close();
    }
  },
);

test(
  'responsive Project cost keeps its compact parent identity and open dialog anchor',
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
      await layoutAt(page, 340);
      await page.evaluate(
        `window.__compactSpend = document.querySelector('.projectspendcompacthost .projectspendbutton')`,
      );
      const one = renderPayload() as { sessions: unknown[] };
      one.sessions = one.sessions.slice(0, 1);
      await page.evaluate(`window.postMessage(${JSON.stringify(one)}, '*')`);
      await page.evaluate(SETTLED);
      const many = renderPayload();
      await page.evaluate(`window.postMessage(${JSON.stringify(many)}, '*')`);
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.evaluate(`({
      same: document.querySelector('.projectspendcompacthost .projectspendbutton') === window.__compactSpend,
      connected: window.__compactSpend.isConnected,
      picker: !!document.querySelector('.controls select[data-control="picker"]'),
    })`),
        { same: true, connected: true, picker: true },
        'inserting or removing the compact picker replaces the Project cost face',
      );

      await page.locator('.projectspendcompacthost .projectspendbutton').click();
      await page.evaluate(`(() => {
      window.__responsiveSpend = {
        dialog: document.getElementById('projectspendpop'),
        grid: document.querySelector('#projectspendpop .projectspendgrid'),
        period: document.querySelector('#projectspendpop [data-control="projectspend:period:today"]'),
      };
    })()`);
      await page.setViewportSize({ width: 1350, height: 900 });
      await page.evaluate(SETTLED);
      await page.setViewportSize({ width: 340, height: 900 });
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.evaluate(`(() => {
      const held = window.__responsiveSpend;
      const box = held.dialog.getBoundingClientRect();
      const anchor = document.querySelector('.projectspendcompacthost .projectspendbutton').getBoundingClientRect();
      return {
        dialog: document.getElementById('projectspendpop') === held.dialog,
        grid: document.querySelector('#projectspendpop .projectspendgrid') === held.grid,
        period: document.querySelector('#projectspendpop [data-control="projectspend:period:today"]') === held.period,
        focused: document.activeElement === held.period,
        open: !held.dialog.hidden,
        anchored: box.top >= anchor.bottom - 1 && box.left >= -1 && box.right <= innerWidth + 1,
      };
    })()`),
        { dialog: true, grid: true, period: true, focused: true, open: true, anchored: true },
        'width changes replace the open Project cost dialog or leave it anchored to the hidden face',
      );
      assert.deepEqual(failures, [], 'the panel threw while the compact controls or width changed');
    } finally {
      await browser.close();
    }
  },
);

// A short editor leaves little room below Project cost at the end of the rail head.
// The box uses the viewport when that room cannot fit a control. Narrowing to the compact
// face with the box open must drop the height limit the rail placement set.
test('the rail Project cost box keeps its controls reachable in a short panel', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (e) => failures.push(String(e)));
    await page.setContent(
      themed(pageHtml().replace('const SAVED_STATE = {};', 'const SAVED_STATE = { railQuickFilters: [] };')),
    );
    await layoutAt(page, 1350);
    await page.setViewportSize({ width: 1350, height: 160 });
    await page.evaluate(SETTLED);
    const placed = (host: string) =>
      page.evaluate(`(() => {
        const pop = document.getElementById('projectspendpop');
        const box = pop.getBoundingClientRect();
        const anchor = document.querySelector('${host} .projectspendbutton').getBoundingClientRect();
        const compact = document.querySelector('.projectspendcompacthost .projectspendbutton');
        const reach = pop.querySelector('[data-control="projectspend:pricing"]');
        const last = reach.getBoundingClientRect();
        return { hidden: pop.hidden, limit: pop.style.maxHeight, anchorShown: anchor.height > 0,
          compactShown: !!compact && compact.getClientRects().length > 0,
          inside: box.top >= -1 && box.bottom <= innerHeight + 1, below: box.top >= anchor.bottom - 1,
          reachable: last.top >= Math.max(0, box.top) - 1 && last.bottom <= Math.min(innerHeight, box.bottom) + 1,
          focused: document.activeElement === reach,
          unobstructed: reach.contains(document.elementFromPoint(last.x + last.width / 2, last.y + last.height / 2)) };
      })()`) as Promise<{
        hidden: boolean;
        limit: string;
        anchorShown: boolean;
        compactShown: boolean;
        inside: boolean;
        below: boolean;
        reachable: boolean;
        focused: boolean;
        unobstructed: boolean;
      }>;

    await page.locator('.projectspendrailhost .projectspendbutton').click();
    await page.evaluate(SETTLED);
    const pricing = page.locator('[data-control="projectspend:pricing"]');
    for (
      let press = 0;
      press < 12 && !(await pricing.evaluate((node) => node === document.activeElement));
      press += 1
    ) {
      await page.keyboard.press('Tab');
    }
    assert.equal(
      await pricing.evaluate((node) => node === document.activeElement),
      true,
      'Tab did not reach Pricing details',
    );
    await page.keyboard.press('Enter');
    await page.waitForFunction(`document.querySelector('.projectspendpricing').open`);
    await page.evaluate(SETTLED);
    assert.equal(
      await page.evaluate(`(() => {
      const pop = document.getElementById('projectspendpop');
      const anchor = document.querySelector('.projectspendrailhost .projectspendbutton').getBoundingClientRect();
      return pop.scrollHeight > innerHeight - anchor.bottom - 12;
    })()`),
      true,
      'expanded Pricing details no longer exceeds the room below the rail face',
    );
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await page.evaluate(SETTLED);
    const { limit, ...railPlace } = await placed('.projectspendrailhost');
    assert.deepEqual(
      railPlace,
      {
        hidden: false,
        anchorShown: true,
        compactShown: false,
        inside: true,
        below: true,
        reachable: true,
        focused: true,
        unobstructed: true,
      },
      'the short rail box leaves the room below its face or strands a control',
    );
    assert.ok(limit, 'the short rail box carries no height limit, so the compact check below measures nothing');
    await page.keyboard.press('Enter');
    await page.waitForFunction(`!document.querySelector('.projectspendpricing').open`);
    await page.locator('.projectspendperiod').nth(1).click();
    assert.deepEqual(
      await page.evaluate(
        `[...document.querySelectorAll('.projectspendperiod')].map((b) => b.getAttribute('aria-pressed'))`,
      ),
      ['false', 'true', 'false'],
      'a period press in the short rail box does not select its period',
    );

    await pricing.focus();
    await page.setViewportSize({ width: 1350, height: 100 });
    await page.evaluate(SETTLED);
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await page.evaluate(SETTLED);
    const { limit: shortLimit, ...shortPlace } = await placed('.projectspendrailhost');
    assert.deepEqual(
      shortPlace,
      {
        hidden: false,
        anchorShown: true,
        compactShown: false,
        inside: true,
        below: false,
        reachable: true,
        focused: true,
        unobstructed: true,
      },
      'Project cost strands a control when the space below its face cannot hold one',
    );
    assert.ok(shortLimit, 'the very short rail box carries no height limit');

    await page.setViewportSize({ width: RAIL_MIN_WIDTH - 60, height: 420 });
    const settles = (condition: string) =>
      page.waitForFunction(condition, undefined, { timeout: 5_000 }).then(
        () => true,
        () => false,
      );
    assert.ok(
      await settles(`(() => { const pop = document.getElementById('projectspendpop');
        return !pop.hidden && pop.style.maxHeight !== ${JSON.stringify(limit)}; })()`),
      `the compact box keeps the rail's ${limit} height limit, or it closed`,
    );
    for (
      let press = 0;
      press < 12 && !(await pricing.evaluate((node) => node === document.activeElement));
      press += 1
    ) {
      await page.keyboard.press('Tab');
    }
    const compact = await placed('.projectspendcompacthost');
    assert.equal(compact.limit, '', 'compact placement retained a rail height constraint');
    assert.deepEqual(
      {
        hidden: compact.hidden,
        anchorShown: compact.anchorShown,
        inside: compact.inside,
        reachable: compact.reachable,
        focused: compact.focused,
        unobstructed: compact.unobstructed,
      },
      { hidden: false, anchorShown: true, inside: true, reachable: true, focused: true, unobstructed: true },
      'the compact box at 420px leaves the viewport or strands a control',
    );
    await page.keyboard.press('Escape');
    assert.ok(
      await settles(`document.getElementById('projectspendpop').hidden &&
        document.activeElement === document.querySelector('.projectspendcompacthost .projectspendbutton')`),
      'Escape leaves the short compact box open or drops the focus',
    );
    assert.deepEqual(failures, [], 'the panel threw while placing the short Project cost box');
  } finally {
    await browser.close();
  }
});

test('Project cost leaves focus with the reader when its popover is dismissed', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine');
    return;
  }
  try {
    for (const width of [1350, 420]) {
      const page = await browser.newPage();
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(String(error)));
      await page.setContent(themed(pageHtml()));
      await layoutAt(page, width);
      const face = page.locator(
        `${width > 1000 ? '.projectspendrailhost' : '.projectspendcompacthost'} .projectspendbutton`,
      );
      const pop = page.locator('#projectspendpop');
      const selected = page.locator('[data-control="projectspend:period:today"]');
      const destination = page.locator('#prompt');
      await face.focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(`document.activeElement?.dataset.control === 'projectspend:period:today'`);
      assert.equal(await pop.getAttribute('aria-label'), 'Project cost');
      await page.keyboard.press('Tab');
      await page.waitForFunction(`document.activeElement?.dataset.control === 'projectspend:period:sevenDays'`);
      assert.equal(
        await pop.evaluate((node) => (node as HTMLElement).hidden),
        false,
        'internal focus closes Project cost',
      );
      await page.evaluate(
        `document.activeElement.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }))`,
      );
      await page.evaluate(SETTLED);
      assert.equal(
        await pop.evaluate((node) => (node as HTMLElement).hidden),
        false,
        'window focus loss closes Project cost',
      );
      await destination.focus();
      await page.waitForFunction(`document.getElementById('projectspendpop').hidden`);
      assert.equal(
        await destination.evaluate((node) => node === document.activeElement),
        true,
        'focus departure takes focus from its destination',
      );
      assert.equal(await face.getAttribute('aria-expanded'), 'false');

      await face.click();
      await page.waitForFunction(`!document.getElementById('projectspendpop').hidden`);
      await face.focus();
      await page.evaluate(SETTLED);
      assert.equal(
        await pop.evaluate((node) => (node as HTMLElement).hidden),
        false,
        'focus returning to the trigger closes Project cost',
      );
      await page.keyboard.press('Enter');
      await page.waitForFunction(`document.getElementById('projectspendpop').hidden`);
      assert.equal(
        await face.evaluate((node) => node === document.activeElement),
        true,
        'trigger dismissal loses focus',
      );

      await face.click();
      await selected.focus();
      await page.keyboard.press('Escape');
      await page.waitForFunction(`document.getElementById('projectspendpop').hidden`);
      assert.equal(await face.evaluate((node) => node === document.activeElement), true, 'Escape loses trigger focus');
      await face.click();
      await destination.click();
      await page.waitForFunction(`document.getElementById('projectspendpop').hidden`);
      assert.equal(
        await destination.evaluate((node) => node === document.activeElement),
        true,
        'outside press takes focus from its destination',
      );

      await face.click();
      await page.locator('[data-control="projectspend:pricing"]').focus();
      await page.keyboard.press('Tab');
      await page.waitForFunction(`document.getElementById('projectspendpop').hidden`);
      assert.equal(
        await face.evaluate((node) => node === document.activeElement),
        false,
        'Tab dismissal returns focus to the trigger',
      );
      await face.click();
      await selected.focus();
      await page.keyboard.press('Shift+Tab');
      await page.waitForFunction(`document.getElementById('projectspendpop').hidden`);
      assert.equal(
        await selected.evaluate((node) => node === document.activeElement),
        false,
        'Shift+Tab traps focus in Project cost',
      );

      await page.evaluate(
        (payload) => window.postMessage({ type: 'projectSpend', projectSpend: payload }, '*'),
        NOTHING_PRICED,
      );
      await page.evaluate(SETTLED);
      await face.click();
      await destination.focus();
      await page.waitForFunction(`document.getElementById('projectspendpop').hidden`);
      assert.equal(
        await destination.evaluate((node) => node === document.activeElement),
        true,
        'unknown cost steals focus after departure',
      );

      for (const spend of [
        { ...PROJECT_SPEND, calculating: true },
        { ...PROJECT_SPEND, calculating: false, windows: [], categories: [], rateSources: [] },
        { ...PROJECT_SPEND, calculating: false, windows: [], categories: [] },
      ]) {
        await page.evaluate(
          (payload) => window.postMessage({ type: 'projectSpend', projectSpend: payload }, '*'),
          spend,
        );
        await page.evaluate(SETTLED);
        await page.evaluate(`window.postMessage({ type: 'focusProjectSpend' }, '*')`);
        await page.waitForFunction(`document.getElementById('projectspendpop').contains(document.activeElement)`);
        const expected =
          spend.rateSources.length && !spend.calculating ? 'projectspend:pricing' : 'projectspend:dialog';
        assert.equal(
          await page.evaluate(`document.activeElement?.dataset.control`),
          expected,
          'Project cost has no usable opening focus without periods',
        );
        if (!spend.windows.length) {
          await page.keyboard.press('Escape');
          await page.waitForFunction(`document.getElementById('projectspendpop').hidden`);
          const fallback = page.locator(width > 1000 ? '.railnew' : '.compactnew');
          assert.equal(
            await fallback.evaluate((node) => node === document.activeElement),
            true,
            'Escape without a Project cost trigger loses the surrounding control focus',
          );
          await page.evaluate(`window.postMessage({ type: 'focusProjectSpend' }, '*')`);
          await page.waitForFunction(`document.getElementById('projectspendpop').contains(document.activeElement)`);
        }
        await page.keyboard.press('Tab');
        await page.waitForFunction(`document.getElementById('projectspendpop').hidden`);
        assert.equal(
          await pop.evaluate((node) => node.contains(document.activeElement)),
          false,
          'control-free Project cost traps Tab',
        );
      }
      await page.evaluate(
        (payload) => window.postMessage({ type: 'projectSpend', projectSpend: payload }, '*'),
        PROJECT_SPEND,
      );
      await page.evaluate(SETTLED);
      await face.click();
      const absent = renderPayload();
      delete absent.projectSpend;
      await page.evaluate((payload) => window.postMessage(payload, '*'), absent);
      await page.waitForFunction(`document.getElementById('projectspendpop').hidden`);
      assert.equal(
        await page.evaluate(`document.activeElement !== document.body && !document.activeElement.closest('[hidden]')`),
        true,
        'disappearing Project cost leaves focus on body or hidden detail',
      );
      assert.deepEqual(failures, [], 'Project cost dismissal threw in the panel');
      await page.close();
    }
  } finally {
    await browser.close();
  }
});
