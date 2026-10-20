// Saved filters and views, their pickers, naming fields, editors, and session list sections.
// Shared helpers live in `../test/rail.ts`.

import { test } from 'vitest';
import assert from 'node:assert';
import type { Page } from 'playwright-core';
import { browserOrNone, SETTLED } from '../test/browser.ts';
import { FIXTURE_CLOCK, MAX_RAIL_FILTER_NAME } from './panelfixture.ts';
import { CARD_ACTIONS } from './turncard.ts';
import { VIEW_NOTES, type SavedView } from './domain/views.ts';
import { RAIL_FILTER_QUERY_LIMIT, type SavedRailFilter } from './domain/rail-filters.ts';
import { RAIL_WIDTH_MIN, VIEW_FOLD_PREFIX } from './view/rail.ts';
import { payload, COMPOSER_VIEW, railMessage, openPage, postToPage, describedNote } from '../test/rail.ts';

test(
  'saved rail filters apply live, stay custom until saved, and leave view filing intact',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so saved rail filters were not measured');
      return;
    }
    try {
      const page = await browser.newPage();
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(String(error)));
      await openPage(page);
      await page.locator('[data-control="railfilters"]').click();
      await page.locator('[data-control="railfilter-order:cost-desc"]').click();
      await page.locator('[data-control="railfilters"]').click();
      await page.locator(`[data-control="${COMPOSER_VIEW}"]`).click();
      assert.equal(await page.locator(`[data-control="${COMPOSER_VIEW}"]`).getAttribute('aria-expanded'), 'false');

      await page.evaluate(`window.__posted = []`);
      await page.locator('[data-control="railfilters"]').click();
      await page.locator('[data-control="railfilterpick:f2"]').click();
      assert.deepEqual(
        await page.evaluate(`(() => ({
        query: document.querySelector('.railfilter').value,
        filter: document.querySelector('[data-control="railfilters"]').getAttribute('aria-label'),
        cards: [...new Set([...document.querySelectorAll('.railcard')].map((node) => node.dataset.session))],
        views: document.querySelectorAll('[data-bucket^="railgroup:view:"]').length,
      }))()`),
        {
          query: 'label:"release 0.4"',
          filter: `View, ${MAX_RAIL_FILTER_NAME}, Latest update`,
          cards: ['s1', 's2'],
          views: 2,
        },
      );

      // A saved filter press leaves the View menu open on the row the reader pressed.
      assert.equal(await page.locator('#railfilterpop').isHidden(), false);
      assert.equal(await page.evaluate(`document.activeElement?.dataset?.control`), 'railfilterpick:f2');
      await page.locator('[data-control="railfilter-order:cost-asc"]').click();
      assert.deepEqual(
        await page.evaluate(`(() => ({
        filter: document.querySelector('[data-control="railfilters"]').getAttribute('aria-label'),
        filterWrites: window.__posted.filter((message) => message.type === 'setRailFilters'),
      }))()`),
        { filter: 'View, Custom, Cost, lowest first', filterWrites: [] },
      );
      await page.locator('[data-control="railfilters"]').click();
      await page.locator('[data-control="railfilters"]').click();
      await page.locator('[data-control="railfilterpick:f2"]').click();

      // A chip press writes its term and a second press takes it away again.
      await page.locator('[data-control="railfilterlabel:composer"]').click();
      assert.equal(await page.locator('.railfilter').inputValue(), 'label:"release 0.4" label:composer');
      await page.locator('[data-control="railfilterlabel:composer"]').click();
      assert.equal(await page.locator('.railfilter').inputValue(), 'label:"release 0.4"');
      await page.locator('[data-control="railfilterlabel:composer"]').click();
      assert.deepEqual(
        await page.evaluate(`(() => ({
        query: document.querySelector('.railfilter').value,
        filter: document.querySelector('[data-control="railfilters"]').getAttribute('aria-label'),
        cards: [...new Set([...document.querySelectorAll('.railcard')].map((node) => node.dataset.session))],
        filterWrites: window.__posted.filter((message) => message.type === 'setRailFilters'),
        viewWrites: window.__posted.filter((message) => message.type === 'setViews'),
      }))()`),
        {
          query: 'label:"release 0.4" label:composer',
          filter: 'View, Custom, Latest update',
          cards: ['s1'],
          filterWrites: [],
          viewWrites: [],
        },
      );

      await page.locator('[data-control="railfilter-update"]').click();
      const writes = (await page.evaluate(
        `window.__posted.filter((message) => message.type === 'setRailFilters')`,
      )) as Array<{ railFilters: SavedRailFilter[] }>;
      assert.equal(writes.length, 1);
      assert.deepEqual(writes[0].railFilters[1], {
        id: 'f2',
        name: MAX_RAIL_FILTER_NAME,
        query: 'label:"release 0.4" label:composer',
        sort: 'latest',
      });
      assert.equal(
        await page.locator('[data-control="railfilters"]').getAttribute('aria-label'),
        `View, ${MAX_RAIL_FILTER_NAME}, Latest update`,
      );

      await page.locator('[data-control="railfilterpick:all"]').click();
      assert.deepEqual(
        await page.evaluate(`(() => ({
        query: document.querySelector('.railfilter').value,
        folded: document.querySelector('[data-control="${COMPOSER_VIEW}"]').getAttribute('aria-expanded'),
        viewWrites: window.__posted.filter((message) => message.type === 'setViews'),
      }))()`),
        {
          query: '',
          folded: 'false',
          viewWrites: [],
        },
      );
      await page.keyboard.press('Escape');
      // Hide choices already negated by the query to prevent contradictory terms.

      await page.locator('.railfilter').fill('-is:input -label:composer');
      await page.evaluate(SETTLED);
      await page.locator('[data-control="railfilters"]').click();
      assert.deepEqual(
        await page.evaluate(`(() => ({
        statuses: document.querySelectorAll('[data-control^="railfilterstatus:"]').length,
        composer: document.querySelectorAll('[data-control="railfilterlabel:composer"]').length,
        release: document.querySelectorAll('[data-control="railfilterlabel:release 0.4"]').length,
      }))()`),
        { statuses: 0, composer: 0, release: 1 },
      );
      await page.keyboard.press('Escape');
      await page.locator('.railfilter').fill('');
      await page.evaluate(SETTLED);
      await page.evaluate(`window.__posted = []`);
      const prefix = 'title:no-match '.repeat(RAIL_FILTER_QUERY_LIMIT).slice(0, RAIL_FILTER_QUERY_LIMIT);
      await page.locator('.railfilter').fill(`${prefix} label:composer`);
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.evaluate(`(() => ({
        query: document.querySelector('.railfilter').value,
        cards: [...new Set([...document.querySelectorAll('.railcard')].map((node) => node.dataset.session))],
        saved: window.__posted.filter((message) => message.type === 'saveState').at(-1)?.state?.railFilter,
      }))()`),
        { query: prefix, cards: [], saved: prefix },
      );
      assert.deepEqual(failures, []);
    } finally {
      await browser.close();
    }
  },
);

test(
  'a host update removing the active saved rail filter restores the complete default lens',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so saved rail filter removal was not measured');
      return;
    }
    try {
      const page = await browser.newPage();
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(String(error)));
      const base = payload();
      await openPage(page, base);
      await page.locator('[data-control="railfilters"]').click();
      await page.locator('[data-control="railfilter-order:cost-asc"]').click();
      await page.locator('[data-control="railfilters"]').click();
      // The ordinary fold returns after the saved filter clears.
      await page.locator(`[data-control="${COMPOSER_VIEW}"]`).click();
      assert.equal(await page.locator(`[data-control="${COMPOSER_VIEW}"]`).getAttribute('aria-expanded'), 'false');
      await page.locator('[data-control="railfilters"]').click();
      await page.locator('[data-control="railfilterpick:f2"]').click();
      await page.locator('[data-control="railfilters"]').click();
      await page.evaluate(`window.__posted = []`);

      const withoutActive = {
        ...railMessage(base, base.rail),
        railFilters: base.railFilters.filter((filter) => (filter as SavedRailFilter).id !== 'f2'),
      };
      await page.evaluate(`window.postMessage(${JSON.stringify(withoutActive)}, '*')`);
      await page.evaluate(SETTLED);
      await page.locator('[data-control="railfilters"]').click();
      assert.deepEqual(
        await page.evaluate(`(() => {
        const posted = window.__posted;
        const saved = posted.filter((message) => message.type === 'saveState').at(-1)?.state;
        const all = document.querySelector('[data-control="railfilterpick:all"]');
        return {
          query: document.querySelector('.railfilter').value,
          filter: document.querySelector('[data-control="railfilters"]').getAttribute('aria-label'),
          all: { name: all.textContent.trim(), checked: all.getAttribute('aria-checked') },
          filterWrites: posted.filter((message) => message.type === 'setRailFilters').length,
          viewWrites: posted.filter((message) => message.type === 'setViews').length,
          folded: document.querySelector('[data-control="${COMPOSER_VIEW}"]').getAttribute('aria-expanded'),
          saved: {
            query: saved?.railFilter, filterId: saved?.railFilterId,
            sort: saved?.railSort, defaultSort: saved?.railDefaultSort,
            folds: saved?.railFolds,
          },
        };
      })()`),
        {
          query: '',
          filter: 'View, All sessions, Cost, lowest first',
          all: { name: 'All sessions', checked: 'true' },
          filterWrites: 0,
          viewWrites: 0,
          folded: 'false',
          saved: {
            query: '',
            filterId: 'all',
            sort: 'cost-asc',
            defaultSort: 'cost-asc',
            folds: { [COMPOSER_VIEW]: false },
          },
        },
      );
      assert.deepEqual(failures, []);
    } finally {
      await browser.close();
    }
  },
);

test(
  'saved rail filter creation, rename, deletion, and reload keep explicit workspace state',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so saved rail filter edits were not measured');
      return;
    }
    try {
      const page = await browser.newPage();
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(String(error)));
      await openPage(page);
      await page.locator('.railfilter').fill('agent:codex');
      await page.locator('[data-control="railfilters"]').click();
      await page.evaluate(`window.__posted = []`);
      await page.locator('[data-control="railfilter-save-as"]').click();
      for (const reserved of ['All sessions', 'active', 'NEEDS YOU', 'custom']) {
        await page.locator('[data-control="railfilter-name"]').fill(reserved);
        assert.deepEqual(
          await page.evaluate(`(() => ({
          invalid: document.querySelector('[data-control="railfilter-name"]').getAttribute('aria-invalid'),
          disabled: document.querySelector('[data-control="railfilter-name-save"]').disabled,
        }))()`),
          { invalid: 'true', disabled: true },
          reserved,
        );
      }
      await page.locator('[data-control="railfilter-name"]').fill('Composed filter');
      await page.evaluate(`(() => {
        const input = document.querySelector('[data-control="railfilter-name"]');
        input.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', bubbles: true, cancelable: true, isComposing: true,
        }));
      })()`);
      assert.equal(
        await page.evaluate(`window.__posted.filter((message) => message.type === 'setRailFilters').length`),
        0,
      );
      await page.locator('[data-control="railfilter-name"]').fill('Codex work');
      await page.locator('[data-control="railfilter-name"]').press('Enter');
      let writes = (await page.evaluate(
        `window.__posted.filter((message) => message.type === 'setRailFilters')`,
      )) as Array<{ railFilters: SavedRailFilter[] }>;
      assert.deepEqual(writes[0].railFilters.at(-1), {
        id: 'f3',
        name: 'Codex work',
        query: 'agent:codex',
        sort: 'latest',
      });
      assert.equal(
        await page.locator('[data-control="railfilters"]').getAttribute('aria-label'),
        'View, Codex work, Latest update',
      );

      await page.locator('[data-control="railfilter-rename"]').click();
      await page.locator('[data-control="railfilter-name"]').fill('Unread costs');
      assert.deepEqual(
        await page.evaluate(`(() => ({
        invalid: document.querySelector('[data-control="railfilter-name"]').getAttribute('aria-invalid'),
        disabled: document.querySelector('[data-control="railfilter-name-save"]').disabled,
      }))()`),
        { invalid: 'true', disabled: true },
      );
      await page.locator('[data-control="railfilter-name"]').fill('Codex sessions');
      await page.locator('[data-control="railfilter-name"]').press('Enter');
      writes = await page.evaluate(`window.__posted.filter((message) => message.type === 'setRailFilters')`);
      assert.equal(writes.at(-1)?.railFilters.at(-1)?.name, 'Codex sessions');

      await page.locator('[data-control="railfilter-delete"]').click();
      assert.equal(await page.locator('[data-control="railfilter-delete"]').textContent(), 'Delete it');
      await page.locator('[data-control="railfilter-delete"]').press('Escape');
      assert.equal(await page.locator('[data-control="railfilter-delete"]').textContent(), 'Delete');
      await page.locator('[data-control="railfilter-delete"]').click();
      await page.locator('[data-control="railfilter-delete"]').click();
      writes = await page.evaluate(`window.__posted.filter((message) => message.type === 'setRailFilters')`);
      assert.deepEqual(
        writes.at(-1)?.railFilters.map((filter: SavedRailFilter) => filter.id),
        ['f1', 'f2'],
      );
      assert.deepEqual(
        await page.evaluate(`(() => ({
        query: document.querySelector('.railfilter').value,
        filter: document.querySelector('[data-control="railfilters"]').getAttribute('aria-label'),
      }))()`),
        { query: '', filter: 'View, All sessions, Latest update' },
      );

      // An armed Delete and an open name box stay with their own filter. A press on another
      // row disarms Delete and shuts the name box, so one press there deletes or renames nothing.
      // A press on the row already selected keeps the box and the name typed in it.
      const actions = async () =>
        await page.evaluate(`(() => ({
        remove: document.querySelector('[data-control="railfilter-delete"]')?.textContent ?? null,
        naming: !!document.querySelector('[data-control="railfilter-name"]'),
      }))()`);
      if (await page.locator('#railfilterpop').isHidden()) {
        await page.locator('[data-control="railfilters"]').click();
      }
      await page.locator('[data-control="railfilterpick:f1"]').click();
      await page.locator('[data-control="railfilter-delete"]').click();
      assert.equal(((await actions()) as { remove: string }).remove, 'Delete it');
      await page.locator('[data-control="railfilterpick:f2"]').click();
      assert.deepEqual(await actions(), { remove: 'Delete', naming: false }, 'Delete stayed armed on another filter');
      await page.locator('[data-control="railfilter-rename"]').click();
      await page.locator('[data-control="railfilter-name"]').fill('Renamed');
      await page.locator('[data-control="railfilterpick:f2"]').click();
      assert.equal(
        await page.evaluate(`document.querySelector('[data-control="railfilter-name"]')?.value ?? null`),
        'Renamed',
        'a press on the selected filter dropped the name typed in its box',
      );
      await page.locator('[data-control="railfilterpick:f1"]').click();
      assert.deepEqual(
        await actions(),
        { remove: 'Delete', naming: false },
        'the name box stayed open on another filter',
      );

      const restored = await browser.newPage();
      restored.on('pageerror', (error) => failures.push(String(error)));
      await openPage(restored, payload(), undefined, {
        railFilter: 'label:"release 0.4"',
        railFilterId: 'f2',
        railSort: 'latest',
        railDefaultSort: 'cost-desc',
        railWidth: RAIL_WIDTH_MIN,
      });
      // A restored query leaves the count on the head, and the magnifying glass shows it.
      await restored.locator('[data-control="railsearch"]').click();
      await restored.evaluate(SETTLED);
      assert.deepEqual(
        await restored.evaluate(`(() => ({
        query: document.querySelector('.railfilter').value,
        filter: document.querySelector('[data-control="railfilters"]').getAttribute('aria-label'),
        width: document.getElementById('rail').getBoundingClientRect().width,
      }))()`),
        {
          query: 'label:"release 0.4"',
          filter: `View, ${MAX_RAIL_FILTER_NAME}, Latest update`,
          width: RAIL_WIDTH_MIN,
        },
      );
      await restored.close();
      assert.deepEqual(failures, []);
    } finally {
      await browser.close();
    }
  },
);

// The Quick filters boxes sit in the menu's arrow-key walk. A toggle by Space or by click keeps
// the menu open with focus on the box, changes which counts the head draws, and leaves the query
// and the selected saved filter as they were. The choice is saved, so a reloaded panel keeps it.
test(
  'a Quick filters box toggles by key and click and keeps the menu, query and filter',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so the Quick filters keys were not measured');
      return;
    }
    try {
      const page = await browser.newPage();
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(String(error)));
      const shown = payload([], [], [], [], [], [], new Map([['s2', 'waiting']]));
      await openPage(page, shown, FIXTURE_CLOCK, { railFilter: '' });
      const active = async () => await page.evaluate(`document.activeElement?.dataset?.control ?? null`);
      const saved = async () =>
        (await page.evaluate(
          `window.__posted.filter((message) => message.type === 'saveState').at(-1)?.state ?? null`,
        )) as Record<string, unknown> | null;
      const kept = async () => {
        const state = await saved();
        return { query: state?.railFilter, filterId: state?.railFilterId, lenses: state?.railQuickFilters };
      };
      const state = `(() => ({
      open: !document.getElementById('railfilterpop').hidden,
      boxes: [...document.querySelectorAll('[data-control^="railheadlens:"]')].map((box) => box.checked),
      head: [...document.querySelectorAll('.railcount')].map((node) => node.dataset.control),
      filter: document.querySelector('[data-control="railfilters"]').getAttribute('aria-label'),
      group: document.querySelector('[role="group"][aria-labelledby="railheadlensname"]')?.textContent ?? null,
    }))()`;
      await page.locator('[data-control="railfilters"]').click();
      await page.locator('[data-control="railfilterpick:f2"]').click();
      await page.evaluate(SETTLED);
      const filter = await page.locator('[data-control="railfilters"]').getAttribute('aria-label');
      assert.equal(filter, `View, ${MAX_RAIL_FILTER_NAME}, Latest update`, 'the saved filter was not selected');
      const before = (await page.evaluate(state)) as { head: string[] };
      assert.ok(before.head.includes('railcount:active'), `the head drew ${JSON.stringify(before.head)} and no Active`);
      await page.keyboard.press('Home');
      for (let step = 0; step < 12 && (await active()) !== 'railheadlens:active'; step++) {
        await page.keyboard.press('ArrowDown');
      }
      assert.equal(await active(), 'railheadlens:active', 'the arrow keys never reached the Quick filters boxes');
      await page.keyboard.press('Space');
      await page.evaluate(SETTLED);
      assert.equal(await active(), 'railheadlens:active', 'Space moved focus off the box');
      assert.deepEqual(await page.evaluate(state), {
        open: true,
        boxes: [true, false, false, true],
        head: before.head.filter((control) => control !== 'railcount:active'),
        filter,
        group: 'RunningActiveUnreadNeeds input',
      });
      assert.deepEqual(
        await kept(),
        { query: 'label:"release 0.4"', filterId: 'f2', lenses: ['running', 'input'] },
        'the toggle did not save the choice beside the query and the saved filter',
      );
      const restored = await browser.newPage();
      restored.on('pageerror', (error) => failures.push(String(error)));
      await openPage(restored, shown, FIXTURE_CLOCK, (await saved()) ?? {});
      assert.deepEqual(
        await restored.evaluate(`[...document.querySelectorAll('.railcount')].map((node) => node.dataset.control)`),
        before.head.filter((control) => control !== 'railcount:active'),
        'a reloaded panel drew the Active count its reader unticked',
      );
      await restored.close();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowUp');
      assert.equal(await active(), 'railheadlens:active', 'ArrowUp did not come back to the box');
      await page.locator('[data-control="railheadlens:active"]').click();
      await page.evaluate(SETTLED);
      assert.equal(await active(), 'railheadlens:active', 'a click moved focus off the box');
      assert.deepEqual(await page.evaluate(state), { ...before, open: true, boxes: [true, true, false, true] });
      assert.deepEqual(await kept(), {
        query: 'label:"release 0.4"',
        filterId: 'f2',
        lenses: ['running', 'active', 'input'],
      });
      await page.keyboard.press('End');
      assert.equal(await active(), 'railfilter-delete');
      await page.keyboard.press('Home');
      assert.equal(await active(), 'railfilter-find');
      assert.deepEqual(failures, []);
    } finally {
      await browser.close();
    }
  },
);

test('the saved rail filter picker searches and follows native keyboard focus', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so saved rail filter keys were not measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(String(error)));
    // Use a waiting session and an empty query so the header exposes an Active count with the filter box closed.

    const waiting = payload([], [], [], [], [], [], new Map([['s2', 'waiting']]));
    await openPage(page, waiting, undefined, { railFilter: '' });
    const active = async () => await page.evaluate(`document.activeElement?.dataset?.control ?? null`);
    await page.locator('[data-control="railfilters"]').focus();
    await page.keyboard.press('Enter');
    assert.equal(await active(), 'railfilter-find');
    await page.locator('[data-control="railfilter-find"]').fill('maximum-length');
    assert.deepEqual(
      await page.evaluate(`(() => ({
        presets: [...document.querySelectorAll('.railfilterchoice .launchname')].map((node) => node.textContent),
        labels: [...document.querySelectorAll('#railfilterpop [data-control^="railfilterlabel:"]')].length,
        inside: (() => { const box = document.getElementById('railfilterpop').getBoundingClientRect();
          return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight; })(),
      }))()`),
      {
        presets: ['All sessions', MAX_RAIL_FILTER_NAME],
        labels: 0,
        inside: true,
      },
    );
    // The cross stands in the walk between the box and the first row, and it empties the box.
    await page.locator('[data-control="railfilter-find"]').focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await active(), 'railfilter-find-clear');
    await page.keyboard.press('ArrowDown');
    assert.equal(await active(), 'raillens:all');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    assert.equal(await active(), 'railfilter-find');
    await page.locator('[data-control="railfilter-find-clear"]').click();
    assert.equal(await page.locator('[data-control="railfilter-find"]').inputValue(), '');
    assert.equal(await active(), 'railfilter-find');
    assert.equal(await page.locator('[data-control="railfilter-find-clear"]').count(), 0);
    await page.locator('[data-control="railfilter-find"]').fill('');
    await page.keyboard.press('Tab');
    assert.equal(await active(), 'raillens:all');
    await page.keyboard.press('End');
    assert.equal(await active(), 'railfilter-save-as');
    await page.keyboard.press('Home');
    assert.equal(await active(), 'railfilter-find');
    await page.keyboard.press('ArrowDown');
    assert.equal(await active(), 'raillens:all');
    // A status choice keeps focus when its matches disappear.
    await page.locator('[data-control="raillens:input"]').focus();
    assert.equal(await active(), 'raillens:input');
    await postToPage(page, payload([], [], [], [], [], [], new Map()));
    assert.deepEqual(
      await page.evaluate(`(() => ({
        disabled: document.querySelector('[data-control="raillens:input"]').disabled,
        active: document.activeElement?.dataset?.control ?? null,
      }))()`),
      { disabled: false, active: 'raillens:input' },
      'the empty status choice lost focus or became disabled',
    );
    await postToPage(page, waiting);
    // A Filter press sets its lens, names the rail for it, and keeps the menu open on the
    // pressed value. All takes the lens out again.
    const narrowed = `(() => ({
      open: !document.getElementById('railfilterpop').hidden,
      checked: [...document.querySelectorAll('[data-control^="raillens:"][aria-checked="true"]')].map((node) => node.dataset.control),
      filter: document.querySelector('[data-control="railfilters"]').getAttribute('aria-label'),
    }))()`;
    // The fixture holds no unread session, so Unread answers no press and Active stands in.
    await page.locator('[data-control="raillens:active"]').click();
    assert.equal(await active(), 'raillens:active');
    assert.deepEqual(await page.evaluate(narrowed), {
      open: true,
      checked: ['raillens:active'],
      filter: 'View, Active, Latest update',
    });
    await page.locator('[data-control="raillens:input"]').click();
    assert.equal(await active(), 'raillens:input');
    assert.deepEqual(await page.evaluate(narrowed), {
      open: true,
      checked: ['raillens:input'],
      filter: 'View, Needs input, Latest update',
    });
    await page.locator('[data-control="raillens:all"]').click();
    assert.equal(await active(), 'raillens:all');
    assert.deepEqual(await page.evaluate(narrowed), {
      open: true,
      checked: ['raillens:all'],
      filter: 'View, All sessions, Latest update',
    });
    await page.keyboard.press('Escape');
    assert.equal(await active(), 'railfilters');
    assert.equal(await page.locator('#railfilterpop').isHidden(), true);

    // Active writes through the row's own count, not the popover preset, so the row stays on
    // the count rather than opening the box under the query it wrote.
    await page.locator('[data-control="railcount:active"]').click();
    assert.deepEqual(
      await page.evaluate(`(() => ({
        pressed: document.querySelector('[data-control="railcount:active"]').getAttribute('aria-pressed'),
        filter: document.querySelector('[data-control="railfilters"]').getAttribute('aria-label'),
        boxes: document.querySelectorAll('.railfilter').length,
      }))()`),
      { pressed: 'true', filter: 'View, Active, Latest update', boxes: 0 },
    );
    await page.locator('[data-control="railfilters"]').click();
    await page.locator('[data-control="railfilterpick:f2"]').focus();
    await page.keyboard.press('Space');
    assert.equal(await page.locator('#railfilterpop').isHidden(), false);
    assert.equal(await active(), 'railfilterpick:f2');
    assert.equal(
      await page.locator('[data-control="railfilters"]').getAttribute('aria-label'),
      `View, ${MAX_RAIL_FILTER_NAME}, Latest update`,
    );
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#railfilterpop').isHidden(), true);
    assert.equal(await active(), 'railfilters');
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

test('a session two views match draws two rows that answer to different ids', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so the rail page was not measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(String(error)));
    await openPage(page);
    const drawn = (await page.evaluate(`(() => {
        const rows = [...document.querySelectorAll('#rail .railrow')];
        const ids = rows.map((row) => row.id);
        const controls = [...document.querySelectorAll('#rail .railfold[aria-controls]')]
          .flatMap((head) => head.getAttribute('aria-controls').split(' ').filter(Boolean));
        return {
          rows: rows.length,
          ids,
          repeated: ids.filter((id, at) => ids.indexOf(id) !== at),
          s1: rows.filter((row) => row.querySelector('.railcard').dataset.session === 's1').length,
          named: controls.map((id) => document.querySelectorAll('[id="' + id + '"]').length),
        };
      })()`)) as { rows: number; ids: string[]; repeated: string[]; s1: number; named: number[] };
    // The fixture files s1 under two saved views, so the rail draws it twice on purpose.
    assert.ok(
      drawn.s1 > 1,
      'the fixture no longer draws one session under two views, ' + 'so this guard measures nothing',
    );
    // Every row answers to an id of its own. A repeated id makes a fold heading's
    // `aria-controls` name two elements, and it cannot say which of them it means.
    assert.deepEqual(drawn.repeated, [], 'two rows answer to one element id');
    // And every id a heading names resolves to exactly one element.
    assert.deepEqual([...new Set(drawn.named)], [1], 'a fold heading names an element id that answers more than once');
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

// The empty saved view keeps its heading so the reader can edit or delete it.
const EMPTY_VIEW = 'railgroup:view:v3';

// Return the fixture views as complete SavedView records for message comparisons.

function savedViews(): SavedView[] {
  return payload().views as SavedView[];
}

async function viewMessages(page: Page): Promise<SavedView[][]> {
  return (await page.evaluate(`window.__posted
    .filter((message) => message.type === 'setViews')
    .map((message) => message.views)`)) as SavedView[][];
}

// Only a panel that received the matching heading right-click opens the view editor.

async function armViewHeading(page: Page, view: string): Promise<void> {
  await page.locator(`[data-bucket="${VIEW_FOLD_PREFIX}${view}"]`).click({ button: 'right' });
  await page.evaluate(SETTLED);
}

// Open the view editor through its heading context menu and host reply.

async function openViewEditor(page: Page, view: string, mode: 'rename' | 'delete'): Promise<void> {
  await armViewHeading(page, view);
  await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'openViewEditor', view, mode })}, '*')`);
  await page.evaluate(SETTLED);
}

// Type a query and press Save as view to open its name field.

async function startNaming(page: Page, query: string): Promise<void> {
  const box = page.locator('.railfilter');
  await box.focus();
  await box.fill(query);
  await page.evaluate(SETTLED);
  await page.locator('[data-control="railviewsave"]').click();
  await page.evaluate(SETTLED);
}

test(
  'a label view opens with its selected name for immediate saving or replacement',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed browser, so label view naming was not exercised');
      return;
    }
    try {
      const page = await browser.newPage();
      const base = payload();
      base.labels = [...base.labels, { name: 'Performance', count: 0, countName: 'carried by no sessions' }];
      await openPage(page, base);
      await page.locator('[data-control="railfilters"]').click();
      await page.locator('[data-control="railfilter-order:cost-desc"]').click();
      await page.locator('[data-control="railfilters"]').click();
      const query = 'label:PERFORMANCE is:running -label:release';
      await startNaming(page, query);
      const box = page.locator('.railfilter');
      assert.deepEqual(
        await box.evaluate((node) => {
          const input = node as HTMLInputElement;
          return {
            name: input.value,
            start: input.selectionStart,
            end: input.selectionEnd,
            focused: document.activeElement === input,
          };
        }),
        { name: 'Performance', start: 0, end: 11, focused: true },
      );
      await page.evaluate('window.__posted = []');
      await box.press('Enter');
      assert.deepEqual(await viewMessages(page), [
        [...savedViews(), { id: 'v4', name: 'Performance', query, sort: 'cost-desc', archived: false }],
      ]);

      await startNaming(page, 'label:COMPOSER');
      assert.equal(await box.inputValue(), 'composer');
      assert.equal((await describedNote(page, '.railfilter')).said.includes(VIEW_NOTES.taken), true);
      await page.evaluate('window.__posted = []');
      await box.press('Enter');
      assert.deepEqual(await viewMessages(page), []);
      await box.pressSequentially('Custom name');
      assert.equal(await box.inputValue(), 'Custom name');
      await box.press('Escape');
      assert.equal(await box.inputValue(), 'label:COMPOSER');
      assert.deepEqual(await viewMessages(page), []);
    } finally {
      await browser.close();
    }
  },
);

// Removing the selected saved filter resets the live query and sort. Naming holds its captured lens separately.
// The payload leaves the name, caret and captured lens alone. Saving preserves the captured query and sort.
// Filter buttons refuse presses throughout naming because a press edits the query.
test(
  'naming a view keeps its name, caret and filter through a payload that removes the selected filter',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so naming was not measured');
      return;
    }
    try {
      const page = await browser.newPage();
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(String(error)));
      const lens = {
        query: 'label:composer -label:unavailable',
        sort: 'cost-desc',
      };
      const base = payload();
      base.railFilters = base.railFilters.map((filter) =>
        (filter as SavedRailFilter).id === 'f2' ? { ...(filter as SavedRailFilter), ...lens } : filter,
      );
      await page.clock.install({ time: FIXTURE_CLOCK });
      await openPage(page, base);
      await page.locator('[data-control="railfilters"]').click();
      await page.locator('[data-control="railfilterpick:f2"]').click();
      await page.evaluate(SETTLED);
      const box = page.locator('.railfilter');
      if ((await box.count()) === 0) {
        await page.locator('[data-control="railsearch"]').click();
      }
      const held = await box.inputValue();
      await page.locator('[data-control="railviewsave"]').click();
      await page.evaluate(SETTLED);
      await box.pressSequentially('Held name');
      const nativeInput = await box.elementHandle();
      await box.evaluate((input) => (input as HTMLInputElement).setSelectionRange(2, 8));
      await page.evaluate(SETTLED);
      assert.equal(
        await page.evaluate(`[...document.querySelectorAll('.railcount')].every((node) => node.disabled)`),
        true,
        'a count answered presses while the reader named a view',
      );
      const withoutSelected = {
        ...railMessage(base, base.rail),
        railFilters: base.railFilters.filter((filter) => (filter as SavedRailFilter).id !== 'f2'),
      };
      await page.evaluate(`window.postMessage(${JSON.stringify(withoutSelected)}, '*')`);
      await page.clock.runFor(1_000);
      await page.evaluate(SETTLED);
      assert.equal(
        await nativeInput?.evaluate((input) => input === document.querySelector('.railfilter')),
        true,
        'the payload or tick replaced the native naming input',
      );
      assert.deepEqual(
        await page.evaluate(`(() => {
      const input = document.querySelector('.railfilter');
      return { value: input.value, start: input.selectionStart, end: input.selectionEnd, focused: document.activeElement === input,
        name: input.getAttribute('aria-label') };
    })()`),
        { value: 'Held name', start: 2, end: 8, focused: true, name: CARD_ACTIONS.railViewName },
        'the payload wrote over the name being typed or moved the caret',
      );
      await page.evaluate(`window.__posted = []`);
      await box.press('Enter');
      await page.evaluate(SETTLED);
      const saved = (await viewMessages(page)).at(-1)?.at(-1);
      assert.deepEqual(
        [saved?.name, saved?.query, saved?.sort],
        ['Held name', held, 'cost-desc'],
        'the view saved another name, query or sort',
      );
      await page.evaluate(
        `window.postMessage(${JSON.stringify({ ...withoutSelected, views: [...savedViews(), saved] })}, '*')`,
      );
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.evaluate(`[...new Set([...document.querySelectorAll(
          '.railrow[data-rail-bucket="railgroup:view:${saved?.id}"] [data-control^="rail:"]',
        )].map((node) => node.dataset.control).filter((control) => /^rail:s\\d+$/.test(control)))].sort()`),
        ['rail:s1'],
        'the saved view did not keep the session matching every named query term',
      );
      assert.deepEqual(failures, []);
    } finally {
      await browser.close();
    }
  },
);

test('the filter box offers no completion while it is taking a view name', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so the rail page was not measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(String(error)));
    const base = payload();
    base.rail = base.rail.map((card) =>
      card.id === 's2' ? { ...card, labels: ['composer'], costDollars: 999 } : card,
    );
    await openPage(page, base);
    const box = page.locator('.railfilter');
    await startNaming(page, 'label:composer');

    // Naming mode removes query-completion roles, attributes, and offers from the shared input.

    assert.deepEqual(
      await page.evaluate(`(() => {
      const input = document.querySelector('.railfilter');
      return { value: input.value, role: input.getAttribute('role'),
        autocomplete: input.getAttribute('aria-autocomplete'),
        controls: input.getAttribute('aria-controls'),
        open: input.getAttribute('aria-expanded') === 'true',
        name: input.getAttribute('aria-label'),
        focused: document.activeElement === input,
        cancel: document.querySelector('.filterclear').dataset.control };
    })()`),
      {
        value: 'composer',
        role: null,
        autocomplete: null,
        controls: null,
        open: false,
        name: CARD_ACTIONS.railViewName,
        focused: true,
        cancel: 'railviewnamecancel',
      },
    );

    // Typing lab must produce no query offers while the input takes a view name.

    await box.pressSequentially('lab');
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await page.evaluate(`(() => {
      const input = document.querySelector('.railfilter');
      const pop = document.getElementById('filterpop');
      return { value: input.value, hidden: pop.hidden, rows: pop.querySelectorAll('.filterrow').length,
        active: input.getAttribute('aria-activedescendant'),
        open: input.getAttribute('aria-expanded') === 'true' };
    })()`),
      { value: 'lab', hidden: true, rows: 0, active: null, open: false },
    );

    // Enter saves the typed view name without accepting a query suggestion.

    await page.evaluate(`window.__posted = []`);
    await box.press('Enter');
    await page.evaluate(SETTLED);
    assert.deepEqual(await viewMessages(page), [
      [...savedViews(), { id: 'v4', name: 'lab', query: 'label:composer', sort: 'latest', archived: false }],
    ]);
    // And the box is a filter box again, holding the query the view was made from.
    assert.deepEqual(
      await page.evaluate(`(() => {
      const input = document.querySelector('.railfilter');
      return { value: input.value, role: input.getAttribute('role'),
        name: input.getAttribute('aria-label') };
    })()`),
      {
        value: 'label:composer',
        role: 'combobox',
        name: CARD_ACTIONS.railFilter,
      },
    );
    await box.fill('');
    await page.evaluate(SETTLED);
    const sectionRows = async () =>
      await page
        .locator('.railrow[data-rail-bucket="railgroup:view:v4"] .railcard')
        .evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.session));
    assert.deepEqual(await sectionRows(), ['s1', 's2']);
    await page.locator('[data-control="railfilters"]').click();
    await page.locator('[data-control="railfilter-order:cost-desc"]').click();
    await page.locator('[data-control="railfilters"]').click();
    assert.deepEqual(await sectionRows(), ['s1', 's2'], 'the saved view inherited the later live cost order');
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

test('saving and drawing views follows the current filter', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so the rail page was not measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(String(error)));
    await openPage(page);

    {
      const box = page.locator('.railfilter');
      await box.focus();
      const read = async () =>
        (await page.evaluate(`(() => {
      const row = document.querySelector('[data-control="railviewsave"]');
      if (!row) { return { drawn: false }; }
      return { drawn: true, disabled: row.disabled, name: row.textContent };
    })()`)) as Record<string, unknown>;

      // Search-only words add no filtering term, so Save as view stays hidden.

      for (const query of ['find:needle', 'in:prompt', 'find:needle in:prompt']) {
        await box.fill(query);
        await page.evaluate(SETTLED);
        assert.deepEqual(
          await read(),
          { drawn: false },
          `the save row appeared for a query that narrows nothing: ${query}`,
        );
      }

      // Spaces alone are not a filter at all, so there is no row to refuse anything.
      await box.fill('   ');
      await page.evaluate(SETTLED);
      assert.deepEqual(await read(), { drawn: false });

      // One real term, and the row answers.
      await box.fill('label:composer');
      await page.evaluate(SETTLED);
      assert.deepEqual(await read(), { drawn: true, disabled: false, name: CARD_ACTIONS.railViewSave });

      // A live term saves the way a status term does.
      for (const query of ['cost:>0.50', 'cache-expiry:>5']) {
        await box.fill(query);
        await page.evaluate(SETTLED);
        assert.deepEqual(await read(), { drawn: true, disabled: false, name: CARD_ACTIONS.railViewSave }, query);
      }
      assert.deepEqual(failures, []);
    }

    {
      const box = page.locator('.railfilter');
      for (const query of ['matches-nothing', `${'in:prompt '.repeat(15)}matches-nothing`]) {
        await box.fill(query);
        await page.evaluate(SETTLED);

        assert.equal(await page.locator('[data-control="rail:s1"]').count(), 0);
        assert.equal(await page.locator(`[data-bucket^="${VIEW_FOLD_PREFIX}"]`).count(), 0);
        assert.equal(await page.locator('.railempty').textContent(), 'No session matches.');
        assert.equal(await page.locator('#rail .railbucket').count(), 0);
        assert.equal(await page.locator("section.sessionsection[data-session='s1']").count(), 1);
      }
      assert.deepEqual(failures, []);
    }

    {
      const box = page.locator('.railfilter');
      await box.fill('   ');
      await page.evaluate(SETTLED);
      assert.equal(
        await page.locator(`[data-control="${EMPTY_VIEW}"]`).getAttribute('aria-expanded'),
        'false',
        'a blank box opened the empty view',
      );
      assert.equal(await page.locator('.railsectionempty').count(), 0);
      // Search-only words do not narrow the session list.
      for (const query of ['find:needle', 'in:prompt']) {
        await box.fill(query);
        await page.evaluate(SETTLED);
        assert.deepEqual(
          await page.evaluate(`({
        views: document.querySelectorAll('#rail [data-bucket^="railgroup:view:"]').length,
        empty: document.querySelectorAll('#rail [data-control="${EMPTY_VIEW}"]').length,
      })`),
          { views: 3, empty: 1 },
          `the rail kept its sections for ${JSON.stringify(query)}`,
        );
      }
      assert.deepEqual(failures, []);
    }
  } finally {
    await browser.close();
  }
});

test('deleting a view leaves the focus inside the rail', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so the rail page was not measured');
    return;
  }
  try {
    // Deleting the anchor view returns focus to the session list instead of the disconnected heading.

    const landed = `(() => {
      const active = document.activeElement;
      return { pop: document.getElementById('viewpop').hidden,
        body: active === document.body, inRail: document.getElementById('rail').contains(active),
        fold: active ? active.classList.contains('railfold') : false,
        roving: active ? active.tabIndex : null };
    })()`;

    // The delete command arms the button itself, so the editor opens on the word the next press
    // acts out and one press carries it.
    const armed = await browser.newPage();
    const failures: string[] = [];
    armed.on('pageerror', (error) => failures.push(String(error)));
    await openPage(armed);
    await openViewEditor(armed, 'v1', 'delete');
    assert.deepEqual(
      await armed.evaluate(`(() => {
      const button = document.querySelector('[data-control="view-delete"]');
      return { focused: document.activeElement === button, word: button.textContent,
        name: button.getAttribute('aria-label') };
    })()`),
      {
        focused: true,
        word: CARD_ACTIONS.railViewDeleteConfirm,
        name: CARD_ACTIONS.railViewDeleteConfirm,
      },
    );
    await armed.locator('[data-control="view-delete"]').click();
    await armed.evaluate(SETTLED);
    assert.deepEqual(await armed.evaluate(landed), { pop: true, body: false, inRail: true, fold: true, roving: 0 });

    // The rename command opens the same editor unarmed, so the reader who reaches delete from
    // there presses it twice. The first press only changes the word.
    const twice = await browser.newPage();
    twice.on('pageerror', (error) => failures.push(String(error)));
    await openPage(twice);
    await openViewEditor(twice, 'v2', 'rename');
    await twice.evaluate(`window.__posted = []`);
    await twice.locator('[data-control="view-delete"]').click();
    await twice.evaluate(SETTLED);
    assert.deepEqual(
      await twice.evaluate(`(() => {
      const button = document.querySelector('[data-control="view-delete"]');
      return { pop: document.getElementById('viewpop').hidden, word: button.textContent,
        focused: document.activeElement === button,
        posted: window.__posted.filter((message) => message.type === 'setViews').length };
    })()`),
      {
        pop: false,
        word: CARD_ACTIONS.railViewDeleteConfirm,
        focused: true,
        posted: 0,
      },
    );
    await twice.locator('[data-control="view-delete"]').click();
    await twice.evaluate(SETTLED);
    assert.deepEqual(await twice.evaluate(landed), { pop: true, body: false, inRail: true, fold: true, roving: 0 });
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

test(
  'the view editor walks with the arrow keys and leaves Home and End to the caret',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so the rail page was not measured');
      return;
    }
    try {
      const page = await browser.newPage();
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(String(error)));
      await openPage(page);
      await openViewEditor(page, 'v1', 'rename');
      const at = async () => await page.evaluate(`document.activeElement.dataset.control`);
      assert.equal(await at(), 'view-name');

      // Arrow navigation stops at either end of the view editor controls.

      for (const control of ['view-name-clear', 'view-order']) {
        await page.keyboard.press('ArrowDown');
        assert.equal(await at(), control);
      }
      await page.locator('[data-control="view-delete"]').focus();
      for (const control of ['view-cancel', 'view-save', 'view-save']) {
        await page.keyboard.press('ArrowDown');
        assert.equal(await at(), control);
      }
      await page.locator('[data-control="view-delete"]').focus();
      for (const control of ['view-order']) {
        await page.keyboard.press('ArrowUp');
        assert.equal(await at(), control);
      }
      await page.locator('[data-control="view-name"]').focus();

      // Home and End from a button reach the two ends of the same walk.
      await page.locator('[data-control="view-delete"]').focus();
      await page.keyboard.press('End');
      assert.equal(await at(), 'view-save');
      await page.keyboard.press('Home');
      assert.equal(await at(), 'view-name');

      // Home and End move the caret within the Composer name field.

      await page.evaluate(`(() => {
        const input = document.querySelector('[data-control="view-name"]');
        input.focus();
        input.setSelectionRange(4, 4);
      })()`);
      const caret = async () =>
        await page.evaluate(`(() => {
        const input = document.querySelector('[data-control="view-name"]');
        return { control: document.activeElement.dataset.control, value: input.value,
          start: input.selectionStart, end: input.selectionEnd };
      })()`);
      await page.keyboard.press('Home');
      assert.deepEqual(await caret(), { control: 'view-name', value: 'Composer', start: 0, end: 0 });
      await page.keyboard.press('End');
      assert.deepEqual(await caret(), { control: 'view-name', value: 'Composer', start: 8, end: 8 });

      await page.locator('[data-control="view-order"]').focus();
      await page.keyboard.press('End');
      assert.deepEqual(
        await page.evaluate(`(() => {
        const select = document.querySelector('[data-control="view-order"]');
        return { active: document.activeElement.dataset.control, value: select.value };
      })()`),
        { active: 'view-order', value: 'needs-you' },
      );
      await page.keyboard.press('Home');
      await page.keyboard.press('ArrowDown');
      assert.deepEqual(
        await page.evaluate(`(() => {
        const select = document.querySelector('[data-control="view-order"]');
        return { active: document.activeElement.dataset.control, value: select.value };
      })()`),
        { active: 'view-order', value: 'latest' },
      );
      assert.deepEqual(failures, []);
    } finally {
      await browser.close();
    }
  },
);

test('saved view edits remove an inherited override and name both cost directions', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so the rail page was not measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(String(error)));
    const initial = payload();
    initial.views = (initial.views as SavedView[]).map((view) =>
      view.id === 'v1' ? { ...view, sort: 'cost-desc' } : view.id === 'v2' ? { ...view, sort: 'cost-asc' } : view,
    );
    await openPage(page, initial);
    const directions = [
      { id: 'v1', visible: null, accessible: 'Composer, 1 session, Cost, highest first' },
      { id: 'v2', visible: null, accessible: 'Release 0.4, 2 sessions, Cost, lowest first' },
    ];
    assert.deepEqual(
      await page.evaluate(`(() => ['v1', 'v2'].map((id) => {
      const head = document.querySelector('[data-control="${VIEW_FOLD_PREFIX}' + id + '"]');
      return { visible: head.querySelector('.railbucketsort')?.textContent ?? null,
        accessible: head.getAttribute('aria-label') };
    }))()`),
      directions.map(({ visible, accessible }) => ({ visible, accessible })),
    );
    for (const direction of directions) {
      const head = page.locator(`[data-control="${VIEW_FOLD_PREFIX}${direction.id}"]`);
      await head.focus();
      await page.clock.fastForward(350);
      assert.deepEqual(
        await page.evaluate(`(() => {
        const head = document.querySelector('[data-control="${VIEW_FOLD_PREFIX}${direction.id}"]');
        return { name: head.getAttribute('aria-label'), described: head.getAttribute('aria-describedby'), hidden: document.getElementById('hintpop').hidden };
      })()`),
        { name: direction.accessible, described: 'hintdetail', hidden: false },
      );
      await page.keyboard.press('Escape');
      assert.deepEqual(
        await page.evaluate(`(() => {
        const head = document.querySelector('[data-control="${VIEW_FOLD_PREFIX}${direction.id}"]');
        return { name: head.getAttribute('aria-label'), described: head.getAttribute('aria-describedby'), hidden: document.getElementById('hintpop').hidden };
      })()`),
        { name: direction.accessible, described: null, hidden: true },
      );
    }
    await openViewEditor(page, 'v1', 'rename');
    await page.locator('[data-control="view-order"]').selectOption('inherit');
    await page.evaluate(`window.__posted = []`);
    await page.locator('[data-control="view-save"]').click();
    assert.deepEqual(
      await page.evaluate(`window.__posted.filter((message) => message.type === 'setViews').map((message) =>
      message.views.find((view) => view.id === 'v1'))`),
      [
        {
          id: 'v1',
          name: 'Composer',
          query: 'label:composer',
          archived: false,
        },
      ],
    );
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

test('both name boxes point at the note that says what is wrong with the name', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so the rail page was not measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(String(error)));
    await openPage(page);

    // A status query opens the naming box without a suggested label name.
    await startNaming(page, 'is:running');
    const naming = await describedNote(page, '.railfilter');
    assert.deepEqual(
      { ...naming, said: naming.said.slice(0, 1) },
      {
        named: ['railviewnotes'],
        answers: [1],
        roles: ['status'],
        said: [VIEW_NOTES.unnamed],
        invalid: 'true',
      },
    );
    // The key that files the view is said in the same region, so the box names both.
    assert.ok(
      naming.said.includes(CARD_ACTIONS.railViewNameKey),
      'the naming box names no region carrying the key that files the view',
    );

    // A name another view already carries is the second thing wrong with it.
    await page.locator('.railfilter').fill('Release 0.4');
    await page.evaluate(SETTLED);
    const taken = await describedNote(page, '.railfilter');
    assert.deepEqual(
      { named: taken.named, answers: taken.answers, invalid: taken.invalid, said: taken.said.slice(0, 1) },
      {
        named: ['railviewnotes'],
        answers: [1],
        invalid: 'true',
        said: [VIEW_NOTES.taken],
      },
    );

    // A name nothing is wrong with leaves the region carrying the key alone.
    await page.locator('.railfilter').fill('Sweep');
    await page.evaluate(SETTLED);
    const clean = await describedNote(page, '.railfilter');
    assert.deepEqual(
      { ...clean },
      {
        named: ['railviewnotes'],
        answers: [1],
        roles: ['status'],
        said: [CARD_ACTIONS.railViewNameKey],
        invalid: null,
      },
    );

    // The editor's box answers the same two notes through a region of its own.
    const editor = await browser.newPage();
    editor.on('pageerror', (error) => failures.push(String(error)));
    await openPage(editor);
    await openViewEditor(editor, 'v1', 'rename');
    assert.deepEqual(await describedNote(editor, '[data-control="view-name"]'), {
      named: ['viewnotes'],
      answers: [1],
      roles: ['status'],
      said: [],
      invalid: null,
    });
    await editor.locator('[data-control="view-name"]').fill('');
    await editor.evaluate(SETTLED);
    assert.deepEqual(await describedNote(editor, '[data-control="view-name"]'), {
      named: ['viewnotes'],
      answers: [1],
      roles: ['status'],
      said: [VIEW_NOTES.unnamed],
      invalid: 'true',
    });
    await editor.locator('[data-control="view-name"]').fill('Release 0.4');
    await editor.evaluate(SETTLED);
    assert.deepEqual(await describedNote(editor, '[data-control="view-name"]'), {
      named: ['viewnotes'],
      answers: [1],
      roles: ['status'],
      said: [VIEW_NOTES.taken],
      invalid: 'true',
    });
    // And the button that would file it is refused while the note stands.
    assert.equal(await editor.evaluate(`document.querySelector('[data-control="view-save"]').disabled`), true);
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

test('saved-view headings retain identity, hints and valid list references', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so the rail page was not measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(String(error)));
    await openPage(page);

    {
      const heads = (await page.evaluate(`[...document.querySelectorAll('#rail .railfold')].map((head) => ({
        bucket: head.closest('[data-bucket]').dataset.bucket,
        name: head.getAttribute('aria-label'),
        expanded: head.getAttribute('aria-expanded'),
        cost: !!head.querySelector('.railbucketcost'),
        label: head.querySelector('.railbucketname').textContent,
        count: head.querySelector('.railbucketcount').textContent,
        sort: head.querySelector('.railbucketsort')?.textContent ?? null,
      }))`)) as {
        bucket: string;
        name: string;
        expanded: string;
        cost: boolean;
        label: string;
        count: string;
        sort: string | null;
      }[];
      const views = heads.filter((head) => head.bucket.startsWith(VIEW_FOLD_PREFIX));
      assert.equal(views.length, savedViews().length);
      for (const head of views) {
        assert.equal(head.cost, false);
        assert.match(head.name, /, \d+ session/);
        assert.equal(head.label.length > 0, true);
        assert.match(head.count, /^· \d+$/);
        assert.ok(head.expanded === 'true' || head.expanded === 'false');
      }
      assert.deepEqual(failures, []);
    }

    {
      // Saved view headings use a hint with their full name and count. Built-in headings omit repeated hints. Neither button has a native title.

      const heads = (await page.evaluate(`[...document.querySelectorAll('#rail .railfold')].map((head) => ({
      bucket: head.closest('[data-bucket]').dataset.bucket,
      hint: head.getAttribute('data-hint'),
      detail: head.getAttribute('data-hint-detail'),
      title: head.getAttribute('title'),
      shown: head.querySelector('.railbucketname').textContent,
      name: head.getAttribute('aria-label'),
    }))`)) as {
        bucket: string;
        hint: string | null;
        detail: string | null;
        title: string | null;
        shown: string;
        name: string;
      }[];
      const views = heads.filter((head) => head.bucket.startsWith(VIEW_FOLD_PREFIX));
      const clock = heads.filter((head) => !head.bucket.startsWith(VIEW_FOLD_PREFIX));
      assert.equal(views.length, savedViews().length, 'the rail no longer draws a heading for every saved view');
      assert.ok(
        clock.length > 0,
        'the rail draws no heading the panel named itself, so the half ' +
          'of this guard that asks for no hint over one measures nothing',
      );
      for (const head of views) {
        assert.deepEqual(
          { bucket: head.bucket, hint: head.hint, detail: head.detail, title: head.title },
          { bucket: head.bucket, hint: head.shown, detail: head.name, title: null },
        );
      }
      for (const head of clock) {
        assert.deepEqual(
          { bucket: head.bucket, hint: head.hint, detail: head.detail, title: head.title },
          { bucket: head.bucket, hint: null, detail: null, title: null },
        );
      }
      assert.deepEqual(failures, []);
    }

    {
      const heading = async () =>
        await page.evaluate(`(() => {
      const head = document.querySelector('[data-control="${EMPTY_VIEW}"]');
      return { there: !!head, has: head.hasAttribute('aria-controls'),
        controls: head.getAttribute('aria-controls'),
        expanded: head.getAttribute('aria-expanded'),
        rows: document.querySelectorAll('.railrow[data-rail-bucket="${EMPTY_VIEW}"]').length };
    })()`);

      // An empty view retains its heading and omits aria-controls because no rows are mounted.

      assert.deepEqual(await heading(), { there: true, has: false, controls: null, expanded: 'false', rows: 0 });
      await page.locator(`[data-control="${EMPTY_VIEW}"]`).click();
      await page.evaluate(SETTLED);
      assert.deepEqual(await heading(), { there: true, has: false, controls: null, expanded: 'true', rows: 0 });
      // Opened, it says why nothing is under it.
      assert.equal(await page.locator('.railsectionempty').first().textContent(), CARD_ACTIONS.railViewEmpty);

      // And no heading anywhere on the rail names an empty list.
      assert.deepEqual(
        await page.evaluate(`[...document.querySelectorAll('#rail .railfold')]
      .filter((head) => head.hasAttribute('aria-controls')
        && !head.getAttribute('aria-controls').trim())
      .map((head) => head.dataset.bucket)`),
        [],
      );
      assert.deepEqual(failures, []);
    }
  } finally {
    await browser.close();
  }
});

test('saving, renaming and deleting a view each post the whole list', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so the rail page was not measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(String(error)));
    await openPage(page);
    const fixture = savedViews();

    // Save posts the complete view list because the host replaces its stored list.

    await startNaming(page, 'label:perf');
    await page.locator('.railfilter').fill('Perf');
    await page.evaluate(SETTLED);
    await page.evaluate(`window.__posted = []`);
    await page.locator('.railfilter').press('Enter');
    await page.evaluate(SETTLED);
    const saved = [...fixture, { id: 'v4', name: 'Perf', query: 'label:perf', sort: 'latest', archived: false }];
    assert.deepEqual(await viewMessages(page), [saved]);
    // The matching view keeps its heading while the query remains active.
    assert.equal(await page.locator('[data-bucket="railgroup:view:v4"]').count(), 1);
    await page.locator('.railfilter').fill('');
    await page.evaluate(SETTLED);
    assert.equal(await page.locator('[data-bucket="railgroup:view:v4"]').count(), 1);

    // Renaming. The renamed view keeps its id, its query and its place in the order, and every
    // other view rides the message unchanged.
    await openViewEditor(page, 'v2', 'rename');
    await page.locator('[data-control="view-name"]').fill('Release 0.5');
    await page.evaluate(SETTLED);
    await page.evaluate(`window.__posted = []`);
    await page.locator('[data-control="view-save"]').click();
    await page.evaluate(SETTLED);
    const renamed = saved.map((view) => (view.id === 'v2' ? { ...view, name: 'Release 0.5' } : view));
    assert.deepEqual(await viewMessages(page), [renamed]);

    // Deleting. One view leaves and the rest arrive in the order they were saved in.
    await openViewEditor(page, 'v1', 'delete');
    await page.evaluate(`window.__posted = []`);
    await page.locator('[data-control="view-delete"]').click();
    await page.evaluate(SETTLED);
    assert.deepEqual(await viewMessages(page), [renamed.filter((view) => view.id !== 'v1')]);
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

test('the right-click on a view heading is what opens its editor', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so the rail page was not measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(String(error)));
    await openPage(page);
    const editor = async () =>
      await page.evaluate(`(() => {
      const pop = document.getElementById('viewpop');
      const box = pop.querySelector('[data-control="view-name"]');
      return { hidden: pop.hidden, name: box ? box.value : null };
    })()`);

    // A view editor command without the matching heading context-menu request opens nothing.

    await page.evaluate(`window.postMessage({ type: 'openViewEditor', view: 'v1', mode: 'rename' }, '*')`);
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await editor(),
      { hidden: true, name: null },
      'the editor opened on a command with no right-click behind it',
    );

    // A press on another view's heading is not a press on this one.
    await armViewHeading(page, 'v2');
    await page.evaluate(`window.postMessage({ type: 'openViewEditor', view: 'v1', mode: 'rename' }, '*')`);
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await editor(),
      { hidden: true, name: null },
      'a right-click on one view opened the editor over another',
    );

    // The pair that belongs together opens the editor over the view the reader pressed.
    await openViewEditor(page, 'v1', 'rename');
    assert.deepEqual(await editor(), { hidden: false, name: 'Composer' });
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

test(
  'view actions preserve folding, route by panel, and return to the opener after redraw',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so saved-view actions were not exercised');
      return;
    }
    try {
      const page = await browser.newPage();
      const other = await browser.newPage();
      const initial = payload();
      await openPage(page, initial);
      await openPage(other, initial);
      const disclosure = page.locator(`[data-control="${COMPOSER_VIEW}"]`);
      const dots = page.locator('[data-control="viewmenu:v1"]');
      const expanded = await disclosure.getAttribute('aria-expanded');
      assert.deepEqual(
        await dots.evaluate((node) => ({
          sibling: node.previousElementSibling?.classList.contains('railfold'),
          nested: !!node.closest('button button'),
          menu: node.getAttribute('aria-haspopup'),
          title: node.getAttribute('title'),
        })),
        { sibling: true, nested: false, menu: 'menu', title: null },
      );
      await disclosure.focus();
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate('document.activeElement.dataset.control'), 'viewmenu:v1');
      await page.evaluate(`window.__viewEvents = []; document.addEventListener('contextmenu', (event) => {
      const node = event.target.closest('.railviewmenu');
      if (node) { window.__viewEvents.push({ bubbles: event.bubbles, cancelable: event.cancelable,
        x: event.clientX, y: event.clientY, left: node.getBoundingClientRect().left,
        bottom: node.getBoundingClientRect().bottom }); }
    });`);
      for (const key of ['Enter', 'Space']) {
        await dots.press(key);
        const command = { type: 'openViewEditor', view: 'v1', mode: 'rename' };
        await postToPage(other, command);
        assert.equal(await other.locator('#viewpop').isHidden(), true);
        await postToPage(page, command);
        assert.equal(await page.locator('[data-control="view-name"]').inputValue(), 'Composer');
        assert.equal(await disclosure.getAttribute('aria-expanded'), expanded);
        await page.locator('[data-control="view-cancel"]').click();
        assert.equal(await page.evaluate('document.activeElement.dataset.control'), 'viewmenu:v1');
      }
      const events = (await page.evaluate('window.__viewEvents')) as Array<Record<string, number | boolean>>;
      assert.equal(events.length, 2);
      for (const event of events) {
        assert.equal(event.bubbles, true);
        assert.equal(event.cancelable, true);
        assert.ok(Math.abs(Number(event.x) - Number(event.left)) < 1);
        assert.ok(Math.abs(Number(event.y) - Number(event.bottom)) < 1);
      }
      await dots.click();
      await postToPage(page, { type: 'openViewEditor', view: 'v2', mode: 'rename' });
      assert.equal(await page.locator('#viewpop').isHidden(), true);
      await dots.click();
      await page.clock.fastForward(30_001);
      await postToPage(page, { type: 'openViewEditor', view: 'v1', mode: 'rename' });
      assert.equal(await page.locator('#viewpop').isHidden(), true);
      await dots.click();
      await postToPage(page, { type: 'openViewEditor', view: 'v1', mode: 'rename' });
      await page.locator('[data-control="view-name"]').fill('Typed name');
      await page.locator('[data-control="view-order"]').selectOption('cost-desc');
      await page.evaluate(`window.__viewInput = document.querySelector('[data-control="view-name"]');
      window.__oldDots = document.querySelector('[data-control="viewmenu:v1"]');
      window.__oldDots.replaceWith(window.__oldDots.cloneNode(true));`);
      await postToPage(
        page,
        railMessage(
          initial,
          initial.rail.map((card) => ({ ...card, label: `${card.label} updated` })),
        ),
      );
      assert.deepEqual(
        await page.evaluate(`({ sameInput: window.__viewInput === document.querySelector('[data-control="view-name"]'),
      name: window.__viewInput.value, order: document.querySelector('[data-control="view-order"]').value })`),
        { sameInput: true, name: 'Typed name', order: 'cost-desc' },
      );
      await page.locator('[data-control="view-save"]').click();
      assert.equal(await page.evaluate('document.activeElement.dataset.control'), 'viewmenu:v1');
      assert.equal((await viewMessages(page)).at(-1)?.find((view) => view.id === 'v1')?.sort, 'cost-desc');
      await dots.click({ button: 'right' });
      await postToPage(page, { type: 'openViewEditor', view: 'v1', mode: 'delete' });
      assert.equal(await page.evaluate('document.activeElement.dataset.control'), 'view-delete');
      await page.locator('[data-control="view-cancel"]').click();
      assert.equal(await page.evaluate('document.activeElement.dataset.control'), 'viewmenu:v1');
      await openViewEditor(page, 'v1', 'rename');
      await page.locator('[data-control="view-cancel"]').click();
      assert.equal(await page.evaluate('document.activeElement.dataset.control'), COMPOSER_VIEW);
      await dots.click();
      await postToPage(page, { type: 'openViewEditor', view: 'v1', mode: 'rename' });
      await postToPage(page, {
        ...railMessage(initial, initial.rail),
        views: initial.views.filter((view) => (view as SavedView).id !== 'v1'),
      });
      assert.equal(await page.locator('#viewpop').isHidden(), true);
      assert.equal(
        await page.evaluate('document.activeElement.isConnected && document.activeElement !== document.body'),
        true,
      );
    } finally {
      await browser.close();
    }
  },
);

test('a refresh removing saved-view Show more focuses that view disclosure', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so saved-view focus recovery was not exercised');
    return;
  }
  try {
    const page = await browser.newPage();
    const base = payload();
    const rail = Array.from({ length: 201 }, (_, i) => ({
      ...base.rail[0],
      id: `view-focus-${i}`,
      label: `View session ${i}`,
      pinnedTop: false,
      current: false,
    }));
    const unrelated = { ...base.rail[2], id: 'unrelated-pin', pinnedTop: true, current: false };
    const initial = { ...base, rail: [unrelated, ...rail] };
    await openPage(page, initial);
    const more = page.locator(`[data-control="railmore:${COMPOSER_VIEW}"]`);
    assert.equal(await more.count(), 1);
    await more.focus();
    await postToPage(page, railMessage(initial, [unrelated, ...rail.slice(0, 100)]));
    assert.equal(await more.count(), 0);
    assert.deepEqual(
      await page.evaluate(`({ control: document.activeElement.dataset.control,
      disclosure: document.activeElement.classList.contains('railfold') })`),
      { control: COMPOSER_VIEW, disclosure: true },
    );
  } finally {
    await browser.close();
  }
});

test('the editor walk steps over a Save the name has disabled', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so the rail page was not measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(String(error)));
    await openPage(page);
    await openViewEditor(page, 'v1', 'rename');
    // Empty the name to disable Save before checking keyboard navigation.

    const name = page.locator('[data-control="view-name"]');
    await name.focus();
    await name.fill('');
    await page.evaluate(SETTLED);
    const state = (await page.evaluate(`(() => {
      const save = document.querySelector('[data-control="view-save"]');
      return { disabled: !!save && save.disabled, focused: document.activeElement?.dataset.control ?? null };
    })()`)) as { disabled: boolean; focused: string | null };
    assert.deepEqual(
      state,
      { disabled: true, focused: 'view-name' },
      'an empty name leaves Save pressable, so this guard measures an enabled button',
    );
    // Leave the name field before checking Home and End navigation between controls.

    await page.keyboard.press('ArrowDown');
    await page.evaluate(SETTLED);
    assert.equal(
      await page.evaluate(`document.activeElement?.dataset.control ?? null`),
      'view-order',
      'the name box no longer reaches the native Order control',
    );
    await page.locator('[data-control="view-delete"]').focus();
    // End reaches the last enabled control, skipping disabled Save.

    await page.keyboard.press('End');
    await page.evaluate(SETTLED);
    assert.equal(
      await page.evaluate(`document.activeElement?.dataset.control ?? null`),
      'view-cancel',
      'the walk ended on a button the reader cannot press, or moved nowhere at all',
    );
    // The same from the other direction: the last stop walks back into the form.
    await page.keyboard.press('ArrowUp');
    await page.evaluate(SETTLED);
    assert.equal(
      await page.evaluate(`document.activeElement?.dataset.control ?? null`),
      'view-delete',
      'the walk back from the last pressable stop missed the button before it',
    );
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

// Saved views evaluate cache queries against the browser clock independently of the filter box text.

test(
  'a view saved from a typed is:warm query keeps its sessions with the box empty',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so the saved warm view was not measured');
      return;
    }
    try {
      const page = await browser.newPage();
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(String(error)));
      await openPage(page, payload(), FIXTURE_CLOCK, { railFilter: '' });
      // The fixture already holds three views, so the saved one takes the next id.
      const saved = async () =>
        (
          (await page.evaluate(
            `[...document.querySelectorAll('.railrow[data-rail-bucket="railgroup:view:v4"] .railcard')]
            .map((node) => node.dataset.session)`,
          )) as string[]
        ).sort();

      await page.locator('[data-control="railsearch"]').click();
      await page.evaluate(SETTLED);
      await page.locator('.railfilter').fill('is:warm -is:archived -is:agentrun');
      await page.evaluate(SETTLED);
      const typed = (
        (await page.evaluate(
          `[...new Set([...document.querySelectorAll('.railcard')].map((node) => node.dataset.session))]`,
        )) as string[]
      ).sort();
      assert.ok(typed.length > 0, 'the typed is:warm query kept no session, so nothing measures the saved view');
      await page.locator('[data-control="railviewsave"]').click();
      await page.evaluate(SETTLED);
      const box = page.locator('.railfilter');
      await box.fill('Warm ones');
      await box.press('Enter');
      await page.evaluate(SETTLED);
      // The saved view keeps the same filtered members.
      assert.deepEqual(await saved(), typed);

      await page.locator('.railfilter').fill('');
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await saved(),
        typed,
        'the saved is:warm view emptied itself once the box stopped asking about the cache',
      );

      assert.deepEqual(failures, []);
    } finally {
      await browser.close();
    }
  },
);
