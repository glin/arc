// Session list queries, completion, cost filters, header counts, and lenses.
// Shared helpers live in `../test/rail.ts`.

import { test } from 'vitest';
import assert from 'node:assert';
import type { Page } from 'playwright-core';
import { browserOrNone, SETTLED } from '../test/browser.ts';
import { FIXTURE_CLOCK, pageHtml, themed } from './panelfixture.ts';
import { CARD_ACTIONS } from './turncard.ts';
import { ALL_RAIL_FILTER_ID, RAIL_FILTER_QUERY_LIMIT, RAIL_LENS_WORDS } from './domain/rail-filters.ts';
import type { SavedRailFilter } from './domain/rail-filters.ts';
import { IS_VALUES } from './domain/session-query.ts';
import {
  payload,
  COMPOSER_VIEW,
  RELEASE_VIEW,
  railMessage,
  openPage,
  postToPage,
  describedNote,
} from '../test/rail.ts';

interface FilterSnapshot {
  value: string;
  hidden: boolean;
  focused: boolean;
  active: string | null;
  names: string[];
  selected: string[];
  cards: string[];
}

test(
  'matching reader sessions and agent runs retain their groups and temporary folds',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed browser');
      return;
    }
    try {
      const page = await browser.newPage();
      const initial = payload();
      const reader = {
        ...initial.rail[0],
        id: 'reader',
        label: 'Shared work',
        pinnedTop: false,
        current: false,
        labels: [],
      };
      const run = { ...reader, id: 'run', agentRun: true, runByAgent: true };
      initial.rail = [reader, run];
      initial.views = [];
      const normal = { railtoday: false, railruns: false, railpinned: false };
      await openPage(page, initial, FIXTURE_CLOCK, { railFilterId: 'all', railFilter: 'Shared', railFolds: normal });
      assert.deepEqual(await page.locator('#rail .railbucketname').allTextContents(), ['Today', 'Run by agents']);
      assert.equal(await page.locator('.railcard').count(), 2);
      await page.locator('[data-control="railruns"]').press('Enter');
      assert.equal(await page.locator('[data-control="railruns"]').getAttribute('aria-expanded'), 'false');
      await postToPage(page, railMessage(initial, initial.rail));
      await page.clock.setFixedTime(FIXTURE_CLOCK + 60_000);
      await postToPage(page, railMessage(initial, initial.rail));
      assert.equal(await page.locator('[data-control="railruns"]').getAttribute('aria-expanded'), 'false');
      assert.deepEqual(
        await page.evaluate(`window.__posted.filter(m => m.type === 'saveState').at(-1).state.railFolds`),
        normal,
      );
      await page.locator('[data-control="railsearch"]').click();
      await page.locator('.railfilter').fill('title:Shared');
      await page.evaluate(SETTLED);
      assert.equal(await page.locator('[data-control="railruns"]').getAttribute('aria-expanded'), 'true');
      await page.locator('[data-control="railtoday"]').press('Enter');
      await page.locator('[data-control="railpin:run"]').click();
      assert.deepEqual(await page.evaluate(`window.__posted.filter(m => m.type === 'sessionMembership').at(-1)`), {
        type: 'sessionMembership',
        action: 'pin',
        session: 'run',
      });
      initial.pinnedTop = ['run'];
      await postToPage(page, railMessage(initial, [reader, { ...run, pinnedTop: true }]));
      assert.equal(await page.locator('[data-control="railpinned"]').getAttribute('aria-expanded'), 'true');
      assert.deepEqual(
        await page.evaluate(`window.__posted.filter(m => m.type === 'saveState').at(-1).state.railFolds`),
        normal,
      );
      await page.locator('.railfilter').fill('');
      await page.evaluate(SETTLED);
      for (const group of ['railtoday', 'railpinned']) {
        assert.equal(await page.locator(`[data-control="${group}"]`).getAttribute('aria-expanded'), 'false');
      }
      await page.locator('.railfilter').fill('no matching session');
      await page.evaluate(SETTLED);
      assert.equal(await page.locator('#rail .railbucket').count(), 0);
      assert.equal(await page.locator('#rail .railempty').count(), 1);
      await page.locator('.railfilter').fill('Shared');
      await page.evaluate(SETTLED);
      await page.locator('[data-control="railtoday"]').focus();
      await postToPage(page, railMessage(initial, [run]));
      assert.equal(await page.locator('[data-control="railtoday"]').count(), 0);
      assert.equal(await page.evaluate(`document.activeElement?.closest('#rail') !== null`), true);
    } finally {
      await browser.close();
    }
  },
);

test(
  'filtered saved views keep copies and discard temporary folds when their IDs are deleted',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed browser');
      return;
    }
    try {
      const page = await browser.newPage();
      const initial = payload();
      const reader = {
        ...initial.rail[0],
        id: 'reader',
        label: 'Shared work',
        labels: ['one', 'two'],
        current: false,
        pinnedTop: true,
      };
      const run = { ...reader, id: 'run', pinnedTop: false, agentRun: true, runByAgent: true, labels: [] };
      const archived = { ...reader, id: 'archived', pinnedTop: false, archived: true };
      initial.rail = [reader, run, archived];
      initial.views = [
        { id: 'v1', name: 'First', query: 'label:one', archived: true },
        { id: 'v2', name: 'Second', query: 'label:two', archived: false },
        { id: 'empty', name: 'Empty', query: 'missing', archived: false },
      ];
      const normal = { [COMPOSER_VIEW]: false, [RELEASE_VIEW]: false, railpinned: false, railarchived: false };
      await openPage(page, initial, FIXTURE_CLOCK, {
        railFilterId: 'all',
        railFilter: 'Shared',
        railFolds: normal,
        railGroupBy: 'label',
      });
      assert.deepEqual(await page.locator('#rail .railbucketname').allTextContents(), [
        'Pinned',
        'First',
        'Second',
        'Run by agents',
        'Archived',
      ]);
      assert.equal(await page.locator('[data-session="reader"].railcard').count(), 3);
      assert.equal(await page.locator('[data-session="archived"].railcard').count(), 2);
      await page.locator(`[data-control="${COMPOSER_VIEW}"]`).press('Enter');
      assert.equal(await page.locator(`[data-control="${COMPOSER_VIEW}"]`).getAttribute('aria-expanded'), 'false');
      const retained = initial.views;
      initial.views = retained.slice(1);
      await postToPage(page, railMessage(initial, initial.rail));
      initial.views = retained;
      await postToPage(page, railMessage(initial, initial.rail));
      assert.equal(await page.locator(`[data-control="${COMPOSER_VIEW}"]`).getAttribute('aria-expanded'), 'true');
      await page.locator('[data-control="railsearch"]').click();
      await page.locator('.railfilter').fill('');
      await page.evaluate(SETTLED);
      assert.equal(await page.locator(`[data-control="${RELEASE_VIEW}"]`).getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator('[data-control="railgroup:view:empty"]').count(), 1);
    } finally {
      await browser.close();
    }
  },
);

test('empty status filters stay selectable before matching sessions exist', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(String(error)));
    const initial = payload();
    initial.rail = [];
    await openPage(page, initial);
    await page.locator('[data-control="railfilters"]').click();
    assert.deepEqual(failures, []);
    for (const lens of ['running', 'active', 'unread', 'input']) {
      const button = page.locator(`[data-control="raillens:${lens}"]`);
      assert.equal(await button.isEnabled(), true, `${lens} cannot be selected without matches`);
      assert.equal(await button.locator('.railcountfig').count(), 0);
      await button.press('Enter');
      assert.equal(await button.getAttribute('aria-checked'), 'true');
      assert.equal(await page.locator(`[data-control="railcount:${lens}"]`).count(), lens === 'unread' ? 0 : 1);
    }
    await page.locator('[data-control="raillens:running"]').click();
    await page.locator('[data-control="railfilterlabel:composer"]').click();
    await page.locator('[data-control="railfilter-save-as"]').click();
    await page.locator('[data-control="railfilter-name"]').fill('Running composer');
    await page.locator('[data-control="railfilter-name-save"]').click();
    const filters = (await page.evaluate(
      `window.__posted.filter(message => message.type === 'setRailFilters').at(-1).railFilters`,
    )) as SavedRailFilter[];
    const saved = filters.at(-1)!;
    assert.equal(saved.query, `${RAIL_LENS_WORDS.running} label:composer`);
    const reloaded = await browser.newPage();
    initial.railFilters = filters;
    await openPage(reloaded, initial, undefined, { railFilterId: saved.id, railFilter: saved.query });
    assert.equal(await reloaded.locator('[data-control="railcount:running"] .railcountfig').textContent(), '0');
    const matching = { ...payload().rail[0], status: 'running', labels: ['composer'] };
    await postToPage(reloaded, railMessage(initial, [matching]));
    assert.equal(await reloaded.locator('.railcard').count(), 1);
    assert.equal(await reloaded.locator('[data-control="railcount:running"] .railcountfig').textContent(), '1');
    assert.equal(
      await reloaded.locator('[data-control="railcount:running"]').getAttribute('aria-label'),
      'Running, 1 session',
    );
    await reloaded.locator('[data-control="railfilters"]').click();
    await reloaded.locator('[data-control="railheadlens:running"]').click();
    assert.equal(
      await reloaded.locator('[data-control="railcount:running"]').count(),
      0,
      'a selected unchecked shortcut stayed visible',
    );
    assert.equal(await reloaded.locator('[data-control="raillens:running"]').getAttribute('aria-checked'), 'true');
  } finally {
    await browser.close();
  }
});

async function filterSnapshot(page: Page): Promise<FilterSnapshot> {
  return (await page.evaluate(`(() => {
    const input = document.querySelector('.railfilter');
    const pop = document.getElementById('filterpop');
    return {
      value: input.value,
      hidden: pop.hidden,
      focused: document.activeElement === input,
      active: input.getAttribute('aria-activedescendant'),
      names: [...pop.querySelectorAll('.filtername')].map((node) => node.textContent),
      selected: [...pop.querySelectorAll('.filterrow')].map((node) => node.getAttribute('aria-selected')),
      // The sessions the filter left, and not the cards. A session two saved views
      // both match draws a card under each of their sections, which is the rule, so a list of
      // cards would name the same session twice and say nothing about what the filter cut.
      cards: [...new Set([...document.querySelectorAll('.railcard')].map((node) => node.dataset.session))],
    };
  })()`)) as FilterSnapshot;
}

test('rail filter keeps its caret and composition while host messages arrive', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so the rail page was not measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const initial = payload();
    await openPage(page, initial);
    await page.evaluate(`(() => {
      const input = document.querySelector('.railfilter');
      input.focus();
      input.value = 'label:per';
      input.setSelectionRange(8, 8);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'r', inputType: 'insertText', isComposing: true }));
      window.__railFilter = input;
    })()`);
    const changed = initial.rail.map((card) => (card.id === 's2' ? { ...card, label: 'Changed elsewhere' } : card));
    await page.evaluate(`window.postMessage(${JSON.stringify(railMessage(initial, changed))}, '*')`);
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await page.evaluate(`(() => {
      const input = document.querySelector('.railfilter');
      return { same: input === window.__railFilter, focused: document.activeElement === input,
        value: input.value, start: input.selectionStart, end: input.selectionEnd };
    })()`),
      { same: true, focused: true, value: 'label:per', start: 8, end: 8 },
    );
  } finally {
    await browser.close();
  }
});

test('rail filter completes axes and quoted labels without taking composition keys', { timeout: 60_000 }, async (t) => {
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
    const box = page.locator('.railfilter');
    await box.focus();
    assert.equal((await filterSnapshot(page)).hidden, true);

    await box.pressSequentially('lab');
    await page.evaluate(SETTLED);
    assert.deepEqual((await filterSnapshot(page)).names, ['label:']);
    const composing = await page.evaluate(`(() => {
        const input = document.querySelector('.railfilter');
        const results = [];
        for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape']) {
          const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, isComposing: true });
          results.push(input.dispatchEvent(event));
        }
        const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        Object.defineProperty(event, 'keyCode', { value: 229 });
        results.push(input.dispatchEvent(event));
        return { results, value: input.value, active: input.getAttribute('aria-activedescendant') };
      })()`);
    assert.deepEqual(composing, {
      results: [true, true, true, true, true, true],
      value: 'lab',
      active: 'filterrow0',
    });

    await box.press('Enter');
    await page.evaluate(SETTLED);
    const axisTaken = await filterSnapshot(page);
    assert.deepEqual(
      {
        value: axisTaken.value,
        hidden: axisTaken.hidden,
        focused: axisTaken.focused,
        active: axisTaken.active,
        names: axisTaken.names,
        selected: axisTaken.selected,
      },
      {
        value: 'label:',
        hidden: false,
        focused: true,
        active: 'filterrow0',
        names: ['release 0.4', 'composer', 'perf', 'worktree parallel sessions and the rails'],
        selected: ['true', 'false', 'false', 'false'],
      },
    );

    await box.pressSequentially('re');
    await page.evaluate(SETTLED);
    assert.deepEqual((await filterSnapshot(page)).names, ['release 0.4', 'worktree parallel sessions and the rails']);
    await box.press('ArrowDown');
    assert.deepEqual((await filterSnapshot(page)).selected, ['false', 'true']);
    await box.press('ArrowUp');
    assert.deepEqual((await filterSnapshot(page)).selected, ['true', 'false']);
    await box.press('Tab');
    await page.evaluate(SETTLED);
    assert.deepEqual(await filterSnapshot(page), {
      value: 'label:"release 0.4"',
      hidden: true,
      focused: true,
      active: null,
      names: [],
      selected: [],
      cards: ['s1', 's2'],
    });

    await box.fill('');
    await box.pressSequentially('label:re');
    await page.evaluate(SETTLED);
    await box.press('Escape');
    const shut = await filterSnapshot(page);
    assert.deepEqual(
      {
        value: shut.value,
        hidden: shut.hidden,
        focused: shut.focused,
        active: shut.active,
        names: shut.names,
        selected: shut.selected,
      },
      {
        value: 'label:re',
        hidden: true,
        focused: true,
        active: null,
        names: [],
        selected: [],
      },
    );
    // With the offers shut, Escape clears the query before closing the empty box.
    await box.press('Escape');
    await page.evaluate(SETTLED);
    assert.equal(await box.inputValue(), '', 'Escape over shut offers kept the query');
    assert.equal(await box.isVisible(), true, 'Escape over shut offers hid the query');
    await box.press('Escape');
    await page.evaluate(SETTLED);
    assert.equal(await box.count(), 0, 'the Escape over shut offers left the box open');
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

test('the cost offer writes its axis and a valid threshold filters recorded spend', { timeout: 60_000 }, async (t) => {
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
    const box = page.locator('.railfilter');
    await box.focus();
    await box.pressSequentially('co');
    await page.evaluate(SETTLED);
    assert.deepEqual((await filterSnapshot(page)).names, ['cost:']);
    await box.press('Enter');
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await page.evaluate(`(() => {
        const input = document.querySelector('.railfilter');
        return { value: input.value, start: input.selectionStart, end: input.selectionEnd,
          offers: !document.getElementById('filterpop').hidden };
      })()`),
      { value: 'cost:', start: 5, end: 5, offers: false },
    );

    await box.fill('cost:>0.50');
    await page.evaluate(SETTLED);
    assert.deepEqual((await filterSnapshot(page)).cards, ['s1']);
    assert.deepEqual(
      [...new Set(await page.locator('.railcard .railname').allTextContents())],
      ['Embedded agent input'],
    );
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

test('an invalid cost query is visible and named by the filter box', { timeout: 60_000 }, async (t) => {
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
    const box = page.locator('.railfilter');
    await box.fill('cost:5.43');
    await page.evaluate(SETTLED);
    assert.deepEqual(await describedNote(page, '.railfilter'), {
      named: ['railcostnote'],
      answers: [1],
      roles: ['status'],
      said: ['cost:5.43 was not understood. Use cost:>5.43 or cost:<5.43.'],
      invalid: 'true',
    });
    assert.deepEqual((await filterSnapshot(page)).cards, []);
    assert.equal(await page.locator('[data-control="railviewsave"]').count(), 0);

    await box.fill('cost:>5.43');
    await page.evaluate(SETTLED);
    assert.deepEqual(await describedNote(page, '.railfilter'), {
      named: [],
      answers: [],
      roles: [],
      said: [],
      invalid: null,
    });
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

test(
  'an invalid cost query and an invalid cache-expiry query both draw and are both named',
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
      const box = page.locator('.railfilter');
      await box.fill('cost:5.43 cache-expiry:3');
      await page.evaluate(SETTLED);
      assert.deepEqual(await describedNote(page, '.railfilter'), {
        named: ['railcostnote', 'railcacheexpirynote'],
        answers: [1, 1],
        roles: ['status', 'status'],
        said: [
          'cost:5.43 was not understood. Use cost:>5.43 or cost:<5.43.',
          'cache-expiry:3 was not understood. Use cache-expiry:>0 or cache-expiry:<3.',
        ],
        invalid: 'true',
      });
      assert.deepEqual(failures, []);
    } finally {
      await browser.close();
    }
  },
);

test('rail filter details stack below its field and allow a status view', { timeout: 60_000 }, async (t) => {
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
    const box = page.locator('.railfilter');
    const geometry = async (selector: string): Promise<{ controlsBottom: number; detailTop: number }> =>
      (await page.evaluate(`(() => {
      const controls = document.querySelector('.railhead').getBoundingClientRect();
      const detail = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { controlsBottom: controls.bottom, detailTop: detail.top };
    })()`)) as { controlsBottom: number; detailTop: number };
    await box.fill('cost:5.43');
    await page.evaluate(SETTLED);
    const invalid = await geometry('#railcostnote');
    assert.ok(
      invalid.detailTop >= invalid.controlsBottom - 1,
      'the cost correction is beside the filter controls at the default rail width',
    );
    await box.fill('label:composer');
    await page.evaluate(SETTLED);
    const saved = await geometry('[data-control="railviewsave"]');
    assert.ok(
      saved.detailTop >= saved.controlsBottom - 1,
      'the saved-view action is beside the filter controls at the default rail width',
    );
    await box.fill('is:input');
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await page.evaluate(`(() => {
      const row = document.querySelector('[data-control="railviewsave"]');
      return { disabled: row.disabled, label: row.getAttribute('aria-label') };
    })()`),
      {
        disabled: false,
        label: CARD_ACTIONS.railViewSave,
      },
    );
    const status = await geometry('[data-control="railviewsave"]');
    assert.ok(
      status.detailTop >= status.controlsBottom - 1,
      'the status view action is beside the filter field at the default rail width',
    );
    await page.evaluate(`window.__posted = []`);
    await page.locator('[data-control="railviewsave"]').click();
    await box.fill('Needs input');
    await box.press('Enter');
    assert.equal(
      await page.evaluate(`window.__posted.filter((message) => message.type === 'setViews').at(-1)
      .views.at(-1).query`),
      'is:input',
    );
    await box.fill('is:');
    await page.evaluate(SETTLED);
    assert.equal(await page.locator('[data-control="railviewsave"]').count(), 0);
    await box.fill('is:unknown');
    await page.evaluate(SETTLED);
    assert.equal(await page.locator('#railcostnote').count(), 0);
    assert.equal(await page.locator('[data-control="railviewsave"]').count(), 0);
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

test('the query field holds its clear cross and the funnel, and completes statuses', { timeout: 60_000 }, async (t) => {
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
    const box = page.locator('.railfilter');
    await box.fill('is:');
    await page.evaluate(SETTLED);
    assert.deepEqual(await page.locator('.filtername').allTextContents(), [
      'is:input',
      'is:unread',
      'is:read',
      'is:running',
      'is:warm',
      'is:active',
      'is:needsyou',
      'is:archived',
      'is:agentrun',
    ]);
    // A word opening on the negation mark offers the same values under it, and the row is
    // read out as filtering them out rather than in.
    await box.fill('-is:arch');
    await page.evaluate(SETTLED);
    assert.deepEqual(await page.locator('.filtername').allTextContents(), ['-is:archived']);
    assert.deepEqual(
      await page.locator('.filterrow').first().getAttribute('aria-label'),
      `${CARD_ACTIONS.railFilterWithout} is: archived`,
    );
    await box.press('Enter');
    assert.equal(await box.inputValue(), '-is:archived');
    await box.fill('is:unrea');
    await page.evaluate(SETTLED);
    assert.deepEqual(await page.locator('.filtername').allTextContents(), ['is:unread']);
    await box.press('Enter');
    assert.equal(await box.inputValue(), 'is:unread');
    // Entering a complete status value must preserve it, even when it prefixes another status.

    for (const status of IS_VALUES) {
      await box.fill(`is:${status}`);
      await page.evaluate(SETTLED);
      await box.press('Enter');
      assert.equal(await box.inputValue(), `is:${status}`, `is:${status} was completed to another value`);
    }
    await box.fill('is:unread');
    await page.evaluate(SETTLED);
    assert.equal(await page.locator('.filterclear').count(), 1);
    assert.deepEqual(
      await page.evaluate(`(() => {
      const field = document.querySelector('.railfilter').getBoundingClientRect();
      const clear = document.querySelector('.filterclear').getBoundingClientRect();
      const trigger = document.querySelector('[data-control="railfilters"]').getBoundingClientRect();
      return { sameHeight: Math.abs(field.height - trigger.height) <= 1, sameTop: Math.abs(field.top - trigger.top) <= 1,
        clearSameHeight: Math.abs(field.height - clear.height) <= 1, clearSameTop: Math.abs(field.top - clear.top) <= 1,
        clearInside: clear.left >= field.left && clear.right <= field.right, triggerInside: trigger.left >= field.left && trigger.right <= field.right };
    })()`),
      {
        sameHeight: true,
        sameTop: true,
        clearSameHeight: true,
        clearSameTop: true,
        clearInside: true,
        triggerInside: true,
      },
    );
    await page.locator('[data-control="railfilters"]').click();
    await page.locator('#railfilterpop').click();
    assert.equal(await page.locator('#railfilterpop').isHidden(), false);
    await page.locator('.railnew').click();
    assert.equal(await page.locator('#railfilterpop').isHidden(), true);
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

test(
  'narrowing a query keeps the suggestion rows both lists offer and drops the rest',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so the suggestion rows were not measured');
      return;
    }
    try {
      const page = await browser.newPage();
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(String(error)));
      await openPage(page);
      const box = page.locator('.railfilter');
      await box.focus();
      await box.pressSequentially('label:');
      await page.evaluate(SETTLED);
      assert.deepEqual((await filterSnapshot(page)).names, [
        'release 0.4',
        'composer',
        'perf',
        'worktree parallel sessions and the rails',
      ]);
      // Retain the suggestion's DOM identity when narrowing changes its position.

      await page.evaluate(`(() => {
        window.__suggestion = [...document.querySelectorAll('.filterrow')]
          .find((row) => row.querySelector('.filtername').textContent
            === 'worktree parallel sessions and the rails');
      })()`);

      await box.pressSequentially('re');
      await page.evaluate(SETTLED);
      const narrowed = (await page.evaluate(`(() => {
        const rows = [...document.querySelectorAll('.filterrow')];
        return {
          names: rows.map((row) => row.querySelector('.filtername').textContent),
          said: rows.map((row) => row.getAttribute('aria-label')),
          kept: window.__suggestion === rows[1],
        };
      })()`)) as { names: string[]; said: string[]; kept: boolean };
      assert.deepEqual(narrowed.names, ['release 0.4', 'worktree parallel sessions and the rails']);
      assert.equal(narrowed.kept, true, 'a row both lists offer was rebuilt rather than kept');
      assert.match(
        narrowed.said[1] ?? '',
        new RegExp(`^${CARD_ACTIONS.railFilterTake} label worktree parallel sessions and the rails, `),
        'the kept row answers with a name the narrowing moved onto it',
      );
      assert.ok(
        !narrowed.said.some((name) => name?.includes('composer')),
        'a dropped suggestion left its name on a row the narrowing kept',
      );

      // And back again: the wider list returns whole, with the kept row still the same node.
      await box.press('Backspace');
      await box.press('Backspace');
      await page.evaluate(SETTLED);
      const widened = (await page.evaluate(`(() => {
        const rows = [...document.querySelectorAll('.filterrow')];
        return {
          names: rows.map((row) => row.querySelector('.filtername').textContent),
          kept: window.__suggestion === rows[3],
        };
      })()`)) as { names: string[]; kept: boolean };
      assert.deepEqual(widened.names, ['release 0.4', 'composer', 'perf', 'worktree parallel sessions and the rails']);
      assert.equal(widened.kept, true, 'widening the query rebuilt a row it had kept');
      assert.deepEqual(failures, []);
    } finally {
      await browser.close();
    }
  },
);

test(
  'the rail head keeps its counts beside Search and Escape clears before closing',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so the rail head row was not measured');
      return;
    }
    try {
      const page = await browser.newPage();
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(String(error)));
      // Open this fixture with an empty query and a closed filter box.

      await openPage(page, payload(), undefined, { railFilter: '' });
      const head = `(() => {
        const counts = document.querySelector('.railcounts');
        return {
          boxes: document.querySelectorAll('.railfilter').length,
          counts: counts && getComputedStyle(counts).display !== 'none' && !counts.inert ? 2 : 0,
          clear: document.querySelector('.filterclear')
            ? document.querySelector('.filterclear').getAttribute('aria-label') : null,
          focus: document.activeElement ? document.activeElement.dataset.control || null : null,
        };
      })()`;
      const openBox = async () => {
        await page.locator('[data-control="railsearch"]').click();
        await page.evaluate(SETTLED);
      };
      assert.deepEqual(
        await page.evaluate(head),
        { boxes: 0, counts: 2, clear: null, focus: null },
        'the resting head is not the count and the two tools',
      );
      // The search icon exposes its accessible name and hint.

      assert.deepEqual(
        await page.evaluate(`(() => {
          const button = document.querySelector('[data-control="railsearch"]');
          return {
            name: button.getAttribute('aria-label'),
            hint: button.dataset.hint,
            expanded: button.getAttribute('aria-expanded'),
          };
        })()`),
        { name: 'Filter sessions by text', hint: 'Filter by text', expanded: null },
        'the magnifying glass lost the words a reader who cannot see the icon reads',
      );

      // The magnifying glass focuses the box, and the counts stay available beside it.
      await openBox();
      assert.deepEqual(
        await page.evaluate(head),
        { boxes: 1, counts: 2, clear: 'Close the text filter', focus: 'railfilter' },
        'the magnifying glass did not open the box and put the caret in it',
      );
      await page.locator('.railfilter').press('Escape');
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.evaluate(head),
        { boxes: 0, counts: 2, clear: null, focus: 'railsearch' },
        'the closed box did not give the head and the focus back to the magnifying glass',
      );

      // A query written from the View menu leaves the count on the head. The magnifying glass
      // then shows it.
      await page.locator('[data-control="railfilters"]').click();
      await page.locator('[data-control="railfilterlabel:composer"]').click();
      await page.locator('[data-control="railfilters"]').click();
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.evaluate(head),
        { boxes: 0, counts: 2, clear: null, focus: 'railfilters' },
        'a query written from the View menu held the box open',
      );
      await openBox();
      assert.equal(await page.locator('.railfilter').inputValue(), 'label:composer');
      assert.equal(
        await page.evaluate(head).then((got) => (got as { clear: string }).clear),
        'Clear the filter and show every session',
      );

      // The reader deletes the query they typed. The box stays, and so does the cross.
      await page.locator('.railfilter').fill('');
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.evaluate(head),
        { boxes: 1, counts: 2, clear: 'Close the text filter', focus: 'railfilter' },
        'the emptied box lost its cross',
      );
      await page.locator('.filterclear').click();
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.evaluate(head),
        { boxes: 0, counts: 2, clear: null, focus: 'railsearch' },
        'the cross did not close the box and land focus on the magnifying glass',
      );

      // Escape dismisses the offers, clears the query, then closes the empty box.
      await openBox();
      await page.locator('.railfilter').fill('is:unread');
      await page.evaluate(SETTLED);
      await page.locator('.railfilter').press('Escape');
      await page.evaluate(SETTLED);
      assert.equal(await page.locator('.railfilter').inputValue(), 'is:unread', 'dismissing offers cleared the query');
      await page.locator('.railfilter').press('Escape');
      await page.evaluate(SETTLED);
      assert.equal(await page.locator('.railfilter').inputValue(), '', 'the first Escape left the query applied');
      await page.locator('.railfilter').press('Escape');
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.evaluate(head),
        { boxes: 0, counts: 2, clear: null, focus: 'railsearch' },
        'the Escape over a query left the box open or lost focus',
      );
      await openBox();
      assert.equal(await page.locator('.railfilter').inputValue(), '', 'the closed box restored a cleared query');
      // The cross clears the query as it closes the box.
      await page.locator('.filterclear').click();
      await page.evaluate(SETTLED);
      await openBox();
      assert.equal(await page.locator('.railfilter').inputValue(), '', 'the cross kept the query');

      // Forget State restores header counts and closes the filter box.

      await page.evaluate(`window.postMessage({ type: 'forgetState', since: 17 }, '*')`);
      await page.evaluate(SETTLED);
      const forgotten = (await page.evaluate(head)) as { boxes: number; counts: number; clear: string | null };
      assert.deepEqual(
        { boxes: forgotten.boxes, counts: forgotten.counts, clear: forgotten.clear },
        { boxes: 0, counts: 2, clear: null },
        'a forgotten rail kept an open box where the count belongs',
      );
      assert.deepEqual(failures, []);
    } finally {
      await browser.close();
    }
  },
);

test(
  'Escape keeps a quick filter query visible and clears Search before closing it',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so Search Escape was not measured');
      return;
    }
    try {
      for (const lens of ['running', 'active'] as const) {
        const page = await browser.newPage();
        const failures: string[] = [];
        page.on('pageerror', (error) => failures.push(String(error)));
        await openPage(
          page,
          payload(
            [],
            [],
            [],
            [],
            [],
            [],
            new Map([
              ['s1', 'running'],
              ['s3', 'running'],
            ]),
          ),
          FIXTURE_CLOCK,
        );
        const box = page.locator('.railfilter');
        await box.fill('label:composer');
        await page.evaluate(SETTLED);
        const quick = page.locator(`[data-control="railcount:${lens}"]`);
        await quick.click();
        await page.evaluate(SETTLED);
        const query = `${RAIL_LENS_WORDS[lens]} label:composer`;
        const shown = async () =>
          (await page.evaluate(
            `[...new Set([...document.querySelectorAll('.railcard')].map((node) => node.dataset.session))]`,
          )) as string[];
        assert.equal(await box.inputValue(), query, 'the quick filter replaced the label query');
        assert.deepEqual(await shown(), ['s1'], 'the label and quick filter did not narrow the list together');
        await quick.focus();
        assert.equal(await quick.evaluate((node) => node === document.activeElement), true);
        await page.keyboard.press('Escape');
        await page.evaluate(SETTLED);
        assert.equal(await box.isVisible(), true, 'Escape on a quick filter hid the applied query');
        assert.equal(await box.inputValue(), query, 'Escape on a quick filter changed its query');
        assert.deepEqual(await shown(), ['s1'], 'Escape on a quick filter changed its matching sessions');
        assert.equal(await quick.evaluate((node) => node === document.activeElement), true);

        await page.locator('[data-control="railfilters"]').click();
        await page.locator('[data-control="railfilter-find"]').press('Escape');
        await page.evaluate(SETTLED);
        assert.equal(await page.locator('#railfilterpop').isVisible(), false, 'Escape left the View menu open');
        assert.equal(await box.isVisible(), true, 'closing the View menu hid Search');
        assert.equal(await box.inputValue(), query, 'closing the View menu changed the Search query');

        await box.focus();
        assert.equal(await page.locator('#filterpop').isVisible(), true, 'the label query opened no completions');
        await box.press('Escape');
        await page.evaluate(SETTLED);
        assert.equal(await page.locator('#filterpop').isVisible(), false, 'Escape left Search completions open');
        assert.equal(await box.inputValue(), query, 'dismissing Search completions changed the query');
        await box.press('Escape');
        await page.evaluate(SETTLED);
        assert.equal(await box.isVisible(), true, 'the first Escape in Search hid its query');
        assert.equal(await box.inputValue(), '', 'the first Escape in Search did not clear its query');
        assert.equal(await box.evaluate((node) => node === document.activeElement), true);
        assert.ok((await shown()).includes('s3'), 'clearing Search left the quick filter applied');
        await box.press('Escape');
        await page.evaluate(SETTLED);
        assert.equal(await box.count(), 0, 'Escape left an empty Search input open');
        assert.equal(
          await page.locator('[data-control="railsearch"]').evaluate((node) => node === document.activeElement),
          true,
          'closing Search did not return focus to its toggle',
        );
        assert.deepEqual(failures, []);
      }
    } finally {
      await browser.close();
    }
  },
);

test(
  'a count press narrows the rail to its lens, keeps focus, and a second press restores every session',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so the count press was not measured');
      return;
    }
    try {
      const page = await browser.newPage();
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(String(error)));
      await openPage(
        page,
        payload(
          [],
          [],
          [],
          [],
          [],
          [],
          new Map([
            ['s2', 'waiting'],
            ['s3', 'running'],
          ]),
        ),
        FIXTURE_CLOCK,
        { railFilter: '' },
      );
      const cardsShown = async () =>
        (await page.evaluate(
          `[...document.querySelectorAll('.railcard')].map((node) => node.dataset.session)`,
        )) as string[];
      const focusedControl = async () =>
        await page.evaluate(`document.activeElement ? document.activeElement.dataset.control ?? null : null`);
      const before = (await cardsShown()).sort();
      assert.ok(
        before.includes('s1') && before.includes('s2') && before.includes('s3'),
        'the rail did not start on every session',
      );

      await page.locator('[data-control="railcount:active"]').click();
      await page.evaluate(SETTLED);
      assert.deepEqual(
        [...new Set(await cardsShown())].sort(),
        ['s1', 's2'],
        'Active kept a session the lens does not match',
      );
      assert.equal(await page.locator('[data-control="railcount:active"]').getAttribute('aria-pressed'), 'true');
      assert.equal(await focusedControl(), 'railcount:active', 'the press did not keep focus on the count');

      await page.locator('[data-control="railcount:active"]').click();
      await page.evaluate(SETTLED);
      assert.deepEqual((await cardsShown()).sort(), before, 'a second press did not restore every session');
      assert.equal(await page.locator('[data-control="railcount:active"]').getAttribute('aria-pressed'), 'false');
      // The clearing press draws the head again, and focus lands on the first count it draws,
      // which is Running while s3 runs.
      assert.equal(
        await focusedControl(),
        'railcount:running',
        'the clearing press did not land focus on the first count the head draws',
      );

      assert.deepEqual(failures, []);
    } finally {
      await browser.close();
    }
  },
);

// The Running lens includes running, subagent, and background sessions. Its selected shortcut stays available after work ends.

test('the Running count stays selected at zero and clears to restore sessions', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so the Running press was not measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(String(error)));
    await page.setViewportSize({ width: 1350, height: 900 });
    await page.clock.setFixedTime(FIXTURE_CLOCK);
    await page.setContent(
      themed(
        pageHtml().replace('const SAVED_STATE = {};', `const SAVED_STATE = ${JSON.stringify({ railFilter: '' })};`),
        'dark',
      ),
    );
    const working = new Map([
      ['s1', 'running'],
      ['s2', 'subagents'],
      ['s3', 'background'],
    ] as const);
    await postToPage(page, payload([], [], [], [], [], [], working));
    const cardsShown = async () =>
      [
        ...new Set<string>(
          await page.evaluate(`[...document.querySelectorAll('.railcard')].map((node) => node.dataset.session)`),
        ),
      ].sort();
    const running = page.locator('[data-control="railcount:running"]');
    assert.ok((await cardsShown()).length > 3, 'the fixture holds no session outside the three working ones');
    assert.equal(await running.getAttribute('aria-label'), 'Running, 3 sessions');
    assert.equal(await running.locator('.railcountfig').textContent(), '3');

    await running.click();
    await page.evaluate(SETTLED);
    assert.deepEqual(await cardsShown(), ['s1', 's2', 's3'], 'Running kept a session that is not working');
    assert.equal(await running.getAttribute('aria-pressed'), 'true');
    assert.equal(
      String(
        await page.evaluate(
          `window.__posted.filter((message) => message.type === 'saveState').at(-1)?.state?.railFilter ?? ''`,
        ),
      ).trim(),
      RAIL_LENS_WORDS.running,
      'the press did not write the Running words',
    );

    await postToPage(page, payload());
    assert.deepEqual(await cardsShown(), [], 'the lens kept a session that stopped running');
    assert.equal(await running.count(), 1, 'the selected Running filter disappeared when work ended');
    assert.equal(await running.locator('.railcountfig').textContent(), '0');
    assert.equal(await running.getAttribute('aria-label'), 'Running, 0 sessions');
    assert.equal(await running.getAttribute('aria-pressed'), 'true');
    assert.equal(await running.isEnabled(), true);
    assert.equal(await running.evaluate((node) => node === document.activeElement), true);
    const restored = await browser.newPage();
    const saved = await page.evaluate<Record<string, unknown>>(
      `window.__posted.filter(message => message.type === 'saveState').at(-1).state`,
    );
    await openPage(restored, payload(), FIXTURE_CLOCK, saved);
    assert.equal(await restored.locator('[data-control="railcount:running"] .railcountfig').textContent(), '0');
    assert.equal(await restored.locator('[data-control="railcount:running"]').getAttribute('aria-pressed'), 'true');
    await restored.close();
    await page.locator('[data-control="railfilters"]').click();
    assert.equal(await page.locator('[data-control="raillens:running"]').getAttribute('aria-checked'), 'true');
    await page.locator('[data-control="railfilters"]').press('Escape');
    await running.press('Enter');
    assert.ok((await cardsShown()).length > 3, 'clearing Running did not restore the other sessions');
    assert.equal(await running.count(), 0, 'an unselected zero-count Running button stayed visible');
    await postToPage(page, payload([], [], [], [], [], [], working));
    assert.equal(await running.locator('.railcountfig').textContent(), '3');
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

test(
  'View clears a selected zero-match filter while its rail shortcut stays visible',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so the clearing press was not measured');
      return;
    }
    try {
      const page = await browser.newPage();
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(String(error)));
      const initial = payload([], [], [], [], [], [], new Map());
      // s1 and s2 are Active at the fixture clock. Archiving both empties the lens.

      const archived = payload([], [], [], [], [], [], new Map());
      archived.rail = archived.rail.map((card) =>
        card.id === 's1' || card.id === 's2' ? { ...card, archived: true } : card,
      );
      await openPage(page, initial, FIXTURE_CLOCK, { railFilter: '' });
      const cardsShown = async () =>
        (await page.evaluate(
          `[...document.querySelectorAll('.railcard')].map((node) => node.dataset.session)`,
        )) as string[];
      const focus = async () =>
        await page.evaluate(`(() => ({
        control: document.activeElement ? document.activeElement.dataset.control ?? null : null,
        body: document.activeElement === document.body,
      }))()`);
      const before = (await cardsShown()).sort();

      const active = page.locator('[data-control="railcount:active"]');
      await active.click();
      await page.evaluate(SETTLED);
      assert.deepEqual([...new Set(await cardsShown())].sort(), ['s1', 's2'], 'Active kept a session outside the lens');

      // Both Active sessions are archived, so the lens the rail still holds now matches nothing.
      await page.evaluate(`window.postMessage(${JSON.stringify(railMessage(initial, archived.rail))}, '*')`);
      await page.evaluate(SETTLED);
      assert.deepEqual(await cardsShown(), [], 'an archived session stayed on the rail under the Active lens');
      assert.equal(await active.locator('.railcountfig').textContent(), '0');
      assert.deepEqual(await focus(), { control: 'railcount:active', body: false });
      await page.locator('[data-control="railfilters"]').click();
      assert.equal(await page.locator('[data-control="raillens:active"]').isEnabled(), true);
      assert.equal(await page.locator('[data-control="raillens:active"]').getAttribute('aria-checked'), 'true');
      await page.locator('[data-control="raillens:all"]').click();
      await page.evaluate(SETTLED);
      const after = new Set(await cardsShown());
      // Show archived defaults to true, so s1 and s2 must return along with every other session
      // the rail held before the lens narrowed it.
      assert.deepEqual(after, new Set(before), 'the clearing press did not restore every session');
      assert.deepEqual(
        await focus(),
        { control: 'raillens:all', body: false },
        'the clearing press dropped focus off the rail head row, onto the page body',
      );

      assert.deepEqual(failures, []);
    } finally {
      await browser.close();
    }
  },
);

test('the funnel fill and name follow the lens a count press writes', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so the funnel state was not measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(String(error)));
    await openPage(
      page,
      payload(
        [],
        [],
        [],
        [],
        [],
        [],
        new Map([
          ['s2', 'waiting'],
          ['s3', 'running'],
        ]),
      ),
      FIXTURE_CLOCK,
      { railFilter: '' },
    );
    const funnel = async () =>
      await page.evaluate(`(() => ({
        name: document.querySelector('[data-control="railfilters"]').getAttribute('aria-label'),
        filled: document.querySelector('.railfiltersicon').classList.contains('active'),
      }))()`);
    assert.deepEqual(
      await funnel(),
      { name: 'View, All sessions, Latest update', filled: false },
      'the funnel did not rest on All sessions',
    );

    await page.locator('[data-control="railcount:active"]').click();
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await funnel(),
      { name: 'View, Active, Latest update', filled: true },
      'Active did not fill the funnel with its own name',
    );

    await page.locator('[data-control="railcount:active"]').click();
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await funnel(),
      { name: 'View, All sessions, Latest update', filled: false },
      'clearing Active did not empty the funnel',
    );

    // A typed `is:running` query is ordinary text, not a lens, so it fills the funnel the
    // way any other typed query does.
    await page.locator('[data-control="railsearch"]').click();
    await page.evaluate(SETTLED);
    await page.locator('.railfilter').fill('is:running');
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await funnel(),
      { name: 'View, Custom, Latest update', filled: true },
      'a typed is:running query did not fill the funnel, worded Custom',
    );

    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

// s1 is recent. s2 has a live, nearly-gone cache. All other fixture sessions are outside the Active window.

test(
  'the Active count names what its press keeps and drops a session on the tick it leaves the window',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so the Active count was not measured');
      return;
    }
    try {
      const page = await browser.newPage();
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(String(error)));
      await openPage(page, payload(), FIXTURE_CLOCK, { railFilter: '' });
      const cardsShown = async () =>
        (await page.evaluate(
          `[...new Set([...document.querySelectorAll('.railcard')].map((node) => node.dataset.session))]`,
        )) as string[];
      const active = page.locator('[data-control="railcount:active"]');
      const expiring = 'Some active sessions have a cache that is expiring.';
      assert.equal(
        await active.getAttribute('aria-label'),
        `Active, 2 sessions. ${expiring}`,
        'the Active name disagrees with the sessions inside the recency window',
      );
      // The bolt and the name say one cache state, whichever the clock reaches.
      const agrees = `(() => {
        const node = document.querySelector('[data-control="railcount:active"]');
        const state = node.querySelector('.railcountcache')?.dataset.cacheState ?? null;
        const said = {
          'nearly-gone': ${JSON.stringify(expiring)},
          warm: 'Some active sessions have a warm cache.',
          none: 'No active session has a warm cache.',
        }[state ?? 'none'];
        return node.getAttribute('aria-label').endsWith(said) && node.dataset.hintDetail === said;
      })()`;
      assert.equal(
        await page.evaluate(
          `document.querySelector('[data-control="railcount:active"] .railcountcache')?.dataset.cacheState`,
        ),
        'nearly-gone',
        'the Active bolt does not say a cache is expiring',
      );
      assert.equal(await page.evaluate(agrees), true, 'the Active bolt and its name say different cache states');
      await active.focus();
      await page.waitForFunction(`!document.getElementById('hintpop').hidden`);
      assert.deepEqual(
        await page.evaluate(`(() => {
        const button = document.querySelector('[data-control="railcount:active"]');
        const detail = document.getElementById('hintdetail');
        return { visible: !detail.hidden && detail.getClientRects().length > 0,
          agrees: detail.textContent === button.dataset.hintDetail, described: button.getAttribute('aria-describedby') };
      })()`),
        { visible: true, agrees: true, described: null },
        'the focused Active hint hides its detail or repeats its spoken cache description',
      );

      await active.click();
      await page.evaluate(SETTLED);
      assert.deepEqual(
        (await cardsShown()).sort(),
        ['s1', 's2'],
        'the Active press kept a different set from its figure',
      );
      assert.equal(await active.getAttribute('aria-pressed'), 'true');

      // Advancing the clock removes s2 from the Active count and list while the filter box remains open.

      await page.locator('[data-control="railsearch"]').click();
      await page.evaluate(SETTLED);
      await page.clock.setFixedTime(FIXTURE_CLOCK + 20 * 60_000);
      await page.waitForFunction(
        `![...document.querySelectorAll('.railcard')].some(node => node.dataset.session === 's2')`,
        undefined,
        { timeout: 10_000 },
      );
      assert.deepEqual(await cardsShown(), ['s1'], 'the figure dropped a session the pressed lens still drew');
      assert.equal(await active.locator('.railcountfig').textContent(), '1');
      assert.equal(
        await active.getAttribute('aria-label'),
        'Active, 1 session. Some active sessions have a warm cache.',
      );
      assert.equal(await page.evaluate(agrees), true, 'the clock moved the Active bolt and its name apart');

      await active.click();
      await page.evaluate(SETTLED);
      assert.equal(
        await active.getAttribute('aria-pressed'),
        'false',
        'a second press on Active did not give the rail back every session',
      );
      assert.ok((await cardsShown()).length > 2, 'the clearing press did not restore every session');

      assert.deepEqual(failures, []);
    } finally {
      await browser.close();
    }
  },
);

// A selected lens reads the clock with every session section folded.
// The tick updates its shortcut and saved-view membership together.
test(
  'a pressed lens drops a session on the tick it leaves the window while the box holds the row',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so the lens tick was not measured');
      return;
    }
    try {
      const page = await browser.newPage();
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(String(error)));
      await openPage(page, payload(), FIXTURE_CLOCK, { railLens: 'active' });
      const state = async () =>
        await page.evaluate(`(() => ({
        box: document.querySelectorAll('.railfilter').length,
        counts: document.querySelectorAll('.railcount').length,
        cards: document.querySelectorAll('.railcard').length,
        views: ['${COMPOSER_VIEW}', '${RELEASE_VIEW}']
          .filter((bucket) => document.querySelector('[data-bucket="' + bucket + '"]')),
      }))()`);
      for (;;) {
        const open = page.locator('#rail .railfold[aria-expanded="true"]');
        if ((await open.count()) === 0) {
          break;
        }
        // By key, because the open box's suggestions lie over the list.
        await open.first().focus();
        await page.keyboard.press('Enter');
        await page.evaluate(SETTLED);
      }
      assert.deepEqual(
        await state(),
        { box: 1, counts: 1, cards: 0, views: [COMPOSER_VIEW, RELEASE_VIEW] },
        'the page did not open with the box open, every heading shut, and both saved views holding the lens',
      );

      const active = page.locator('[data-control="railcount:active"]');
      await active.focus();
      await page.clock.setFixedTime(FIXTURE_CLOCK + 61 * 60_000);
      await page.waitForFunction(
        `!document.querySelector('[data-bucket="${COMPOSER_VIEW}"]') && !document.querySelector('[data-bucket="${RELEASE_VIEW}"]')`,
        undefined,
        { timeout: 10_000 },
      );
      assert.deepEqual(await state(), { box: 1, counts: 1, cards: 0, views: [] });
      assert.equal(await active.locator('.railcountfig').textContent(), '0');
      assert.equal(await active.getAttribute('aria-label'), `Active, 0 sessions. ${CARD_ACTIONS.railCountCacheNone}`);
      assert.equal(await active.getAttribute('aria-pressed'), 'true');
      assert.equal(await active.isEnabled(), true);
      assert.equal(await active.evaluate((node) => node === document.activeElement), true);
      const renewed = payload()
        .rail.filter((card) => card.id === 's1' || card.id === 's2')
        .map((card) => ({ ...card, at: FIXTURE_CLOCK + 61 * 60_000 }));
      await postToPage(page, railMessage(payload(), renewed));
      assert.equal(await active.locator('.railcountfig').textContent(), '2');
      assert.equal(await active.evaluate((node) => node === document.activeElement), true);
      assert.deepEqual(failures, []);
    } finally {
      await browser.close();
    }
  },
);

// Lens presses update query words. Saved filters retain those words, and legacy stored lenses load through their compatibility mappings.

test(
  'a count press writes its words into the query, which the reader edits in the box, and a saved filter keeps them',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so the rail lens was not measured');
      return;
    }
    try {
      const failures: string[] = [];
      const base = payload(
        [],
        [],
        [],
        [],
        [],
        [],
        new Map([
          ['s2', 'waiting'],
          ['s3', 'running'],
        ]),
      );
      const stored = { id: 'f3', name: 'Mine', query: '', sort: 'latest', lens: 'needs-you' };
      const initial = { ...base, railFilters: [...base.railFilters, stored] };
      const page = await browser.newPage();
      page.on('pageerror', (error) => failures.push(String(error)));
      await openPage(page, initial, FIXTURE_CLOCK, { railFilter: '' });
      const shown = async (on: Page = page) =>
        (
          (await on.evaluate(
            `[...new Set([...document.querySelectorAll('.railcard')].map((node) => node.dataset.session))]`,
          )) as string[]
        ).sort();
      const pressed = async (on: Page = page) =>
        await on.evaluate(`(() => ({
        active: document.querySelector('[data-control="railcount:active"]')?.getAttribute('aria-pressed') ?? null,
        boxes: document.querySelectorAll('.railfilter').length,
      }))()`);
      const funnel = async () => await page.locator('[data-control="railfilters"]').getAttribute('aria-label');
      const openBox = async () => {
        if (!(await page.locator('.railfilter').count())) {
          await page.locator('[data-control="railsearch"]').click();
        }
        await page.locator('.railfilter').focus();
        await page.evaluate(SETTLED);
      };
      const leaveBox = async () => {
        await page.locator('[data-control="railfilters"]').focus();
        await page.evaluate(SETTLED);
      };
      const every = await shown();
      const active = page.locator('[data-control="railcount:active"]');
      const activeWords = 'is:active -is:archived -is:agentrun';

      await active.click();
      await page.evaluate(SETTLED);
      assert.deepEqual(
        [await shown(), await pressed()],
        [['s1', 's2'], { active: 'true', boxes: 0 }],
        'the Active press opened the box or kept a different set',
      );
      assert.equal(await funnel(), 'View, Active, Latest update');
      await openBox();
      assert.equal(
        await page.locator('.railfilter').inputValue(),
        activeWords,
        'the box did not show the words the press wrote',
      );
      await page.locator('.railfilter').press('End');
      await page.keyboard.type(' label:composer');
      await leaveBox();
      assert.deepEqual(
        [await shown(), await pressed()],
        [['s1'], { active: 'true', boxes: 1 }],
        'the rail kept a session only one of the lens and the typed word keeps, or the count lost its press',
      );
      assert.equal(await funnel(), 'View, Custom, Latest update');

      // Deleting one of the lens's words unpresses its count, and typing them by hand presses it.
      await openBox();
      await page.locator('.railfilter').fill('is:active -is:archived label:composer');
      await leaveBox();
      assert.equal(
        ((await pressed()) as { active: string }).active,
        'false',
        'the count stayed pressed without all of its words',
      );
      await openBox();
      await page.locator('.railfilter').fill('-is:agentrun label:composer is:active -is:archived');
      await leaveBox();
      assert.equal(((await pressed()) as { active: string }).active, 'true', 'the typed words did not press the count');

      // A second press removes the count's words and keeps the rest.
      await openBox();
      await page.locator('.railfilter').fill(`${activeWords} -label:zz`);
      await leaveBox();
      await active.click();
      await page.evaluate(SETTLED);
      await openBox();
      assert.equal(await page.locator('.railfilter').inputValue(), '-label:zz');
      await page.locator('[data-control="railclear"]').click();
      await page.evaluate(SETTLED);
      assert.deepEqual([await shown(), await pressed()], [every, { active: 'false', boxes: 0 }]);

      // A legacy Needs you saved filter loads its query with no count pressed.

      await page.locator('[data-control="railfilters"]').click();
      await page.locator('[data-control="railfilterpick:f3"]').click();
      await page.evaluate(SETTLED);
      assert.deepEqual(
        [await shown(), await pressed()],
        [every, { active: 'false', boxes: 0 }],
        'the saved filter did not load with no lens',
      );
      assert.equal(await funnel(), 'View, Mine, Latest update');

      // Editing the words makes the rail Custom. A Save as new name box opened then belongs to
      // the edited query, so a press on the selected row that puts the stored words back closes it.
      await page.keyboard.press('Escape');
      await active.click();
      await page.locator('[data-control="railfilters"]').click();
      await page.locator('[data-control="railfilter-save-as"]').click();
      assert.equal(await page.locator('[data-control="railfilter-name"]').count(), 1);
      await page.locator('[data-control="railfilterpick:f3"]').click();
      await page.evaluate(SETTLED);
      assert.equal(
        await page.locator('[data-control="railfilter-name"]').count(),
        0,
        'the name box stayed open after the press put the saved words back',
      );

      // Save as new stores the words and no lens field.
      await page.keyboard.press('Escape');
      await active.click();
      await page.locator('[data-control="railfilters"]').click();
      await page.evaluate(`window.__posted = []`);
      await page.locator('[data-control="railfilter-save-as"]').click();
      await page.locator('[data-control="railfilter-name"]').fill('Working set');
      await page.locator('[data-control="railfilter-name"]').press('Enter');
      assert.deepEqual(
        await page.evaluate(
          `window.__posted.filter((message) => message.type === 'setRailFilters').at(-1).railFilters.at(-1)`,
        ),
        { id: 'f4', name: 'Working set', query: activeWords, sort: 'latest' },
      );

      // Save changes stores the words the reader switched to.
      await page.keyboard.press('Escape');
      await page.locator('[data-control="railfilters"]').click();
      await page.locator('[data-control="railfilterpick:f3"]').click();
      await page.keyboard.press('Escape');
      await active.click();
      await page.locator('[data-control="railfilters"]').click();
      await page.evaluate(`window.__posted = []`);
      await page.locator('[data-control="railfilter-update"]').click();
      assert.deepEqual(
        await page.evaluate(`window.__posted.filter((message) => message.type === 'setRailFilters').at(-1).railFilters
          .find((filter) => filter.id === 'f3')`),
        { id: 'f3', name: 'Mine', query: activeWords, sort: 'latest' },
        'Save changes did not store the words the reader switched to',
      );
      await page.locator('[data-control="railfilterpick:all"]').click();
      await page.evaluate(SETTLED);
      assert.deepEqual(await pressed(), { active: 'false', boxes: 0 });
      await page.locator('[data-control="railfilterpick:f3"]').click();
      await page.evaluate(SETTLED);
      assert.deepEqual(
        [await shown(), await pressed()],
        [['s1', 's2'], { active: 'true', boxes: 0 }],
        'selecting the saved filter again did not restore the words Save changes stored',
      );

      // Legacy Needs you state retains its query without selecting a count. Legacy Warm and Active lens state select Active.

      for (const [state, lens, cards] of [
        [
          { railFilterId: 'needs-you', railFilter: 'is:input is:unread -is:archived -is:agentrun' },
          { active: 'false', boxes: 0 },
          [],
        ],
        [
          { railFilterId: ALL_RAIL_FILTER_ID, railFilter: 'is:warm -is:archived -is:agentrun' },
          { active: 'true', boxes: 0 },
          ['s1', 's2'],
        ],
        [
          { railFilterId: ALL_RAIL_FILTER_ID, railFilter: 'label:composer', railLens: 'active' },
          { active: 'true', boxes: 0 },
          ['s1'],
        ],
      ] as const) {
        const restored = await browser.newPage();
        restored.on('pageerror', (error) => failures.push(String(error)));
        await openPage(restored, initial, FIXTURE_CLOCK, state);
        assert.deepEqual([await shown(restored), await pressed(restored)], [cards, lens], JSON.stringify(state));
        await restored.close();
      }

      assert.deepEqual(failures, []);
    } finally {
      await browser.close();
    }
  },
);

// Unread and Needs input keep what they drew. A session read or answered under the lens stays
// through the next host payload, and a query change starts the kept set over, even one put back
// before the rail draws again. Pressing the selected filter button clears its lens.
// Focus then moves to Active, the first configured shortcut with matches.
test(
  'the Unread and Needs input lenses keep what they drew until the query changes',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so the keeping lenses were not measured');
      return;
    }
    try {
      const failures: string[] = [];
      for (const kind of ['unread', 'input'] as const) {
        const base = payload(
          [],
          [],
          [],
          [],
          [],
          [],
          new Map([
            ['s1', 'waiting'],
            ['s2', 'waiting'],
          ]),
        );
        const marked = (read: readonly string[]) =>
          base.rail.map((card) =>
            card.id === 's1' || card.id === 's2'
              ? { ...card, unread: !read.includes(card.id), status: read.includes(card.id) ? 'done' : 'waiting' }
              : card,
          );
        const initial = { ...base, rail: marked([]) };
        const page = await browser.newPage();
        page.on('pageerror', (error) => failures.push(String(error)));
        await openPage(page, initial, FIXTURE_CLOCK, {
          railFilter: RAIL_LENS_WORDS[kind],
          railFilterId: ALL_RAIL_FILTER_ID,
          railQuickFilters: ['active', 'unread', 'input'],
        });
        const shown = async () =>
          (
            (await page.evaluate(
              `[...new Set([...document.querySelectorAll('.railcard')].map((node) => node.dataset.session))]`,
            )) as string[]
          ).sort();
        const post = async (read: readonly string[]) => {
          await page.evaluate(`window.postMessage(${JSON.stringify(railMessage(initial, marked(read)))}, '*')`);
          await page.evaluate(SETTLED);
        };
        const drawn = await shown();
        assert.ok(drawn.includes('s1') && drawn.includes('s2'), `${kind} drew ${JSON.stringify(drawn)}`);
        await post(['s1']);
        assert.deepEqual(await shown(), drawn, `${kind} dropped a session read under it`);

        await page.locator(`[data-control="railcount:${kind}"]`).click();
        await page.evaluate(SETTLED);
        assert.equal(
          await page.evaluate(`document.activeElement?.dataset.control ?? null`),
          'railcount:active',
          `clearing the ${kind} lens left focus off the first configured filter button`,
        );

        // Setting the lens again starts the kept set over, so the read session is gone.
        await page.locator('[data-control="railsearch"]').click();
        await page.evaluate(SETTLED);
        await page.locator('.railfilter').fill(RAIL_LENS_WORDS[kind]);
        await page.evaluate(SETTLED);
        const again = drawn.filter((id) => id !== 's1');
        assert.deepEqual(await shown(), again, `${kind} set again kept a session read before`);
        await post(['s1', 's2']);
        assert.deepEqual(await shown(), again, `${kind} dropped a session read under it`);
        const selected = page.locator(`[data-control="railcount:${kind}"]`);
        assert.equal(await selected.locator('.railcountfig').textContent(), '0');
        assert.equal(
          await selected.getAttribute('aria-label'),
          `${kind === 'unread' ? 'Unread' : 'Needs input'}, 0 sessions`,
        );
        assert.equal(await selected.getAttribute('aria-pressed'), 'true');
        assert.equal(await selected.isEnabled(), true);
        // A query changed and put back within one frame still changed.
        await page.evaluate(`(() => {
        const input = document.querySelector('.railfilter');
        const was = input.value;
        input.value = was + ' x';
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'x', inputType: 'insertText' }));
        input.value = was;
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      })()`);
        await page.evaluate(SETTLED);
        assert.deepEqual(
          await shown(),
          again.filter((id) => id !== 's2'),
          `${kind} kept a session through a query change`,
        );
        await page.close();
      }
      assert.deepEqual(failures, []);
    } finally {
      await browser.close();
    }
  },
);

// A payload that leaves a focused count on the head keeps its element and its focus. One that
// takes the focused count to zero removes it and hands focus on by the press rule, and a later
// payload that lifts the figure draws the count again.
test(
  'a payload removes and returns a count at zero and moves focus off a removed count',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so the head counts under payloads were not measured');
      return;
    }
    try {
      const page = await browser.newPage();
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(String(error)));
      const initial = payload([], [], [], [], [], [], new Map([['s2', 'waiting']]));
      const answered = initial.rail.map((card) => (card.id === 's2' ? { ...card, status: 'done' } : card));
      await openPage(page, initial, FIXTURE_CLOCK, { railFilter: '' });
      const post = async (rail: typeof initial.rail) => {
        await page.evaluate(`window.postMessage(${JSON.stringify(railMessage(initial, rail))}, '*')`);
        await page.evaluate(SETTLED);
      };
      const head = async () =>
        (await page.evaluate(
          `[...document.querySelectorAll('.railcount')].map((node) => node.dataset.control)`,
        )) as string[];
      const focused = async () => await page.evaluate(`document.activeElement?.dataset.control ?? null`);

      assert.ok((await head()).includes('railcount:input'), 'the waiting session drew no Needs input count');
      await page.locator('[data-control="railcount:input"]').focus();
      await page.evaluate(`document.querySelector('[data-control="railcount:input"]').kept = true`);
      await post(initial.rail);
      assert.deepEqual(
        [await focused(), await page.evaluate(`document.querySelector('[data-control="railcount:input"]').kept`)],
        ['railcount:input', true],
        'a count that stayed on the head lost its element or its focus to a payload',
      );

      await post(answered);
      const left = await head();
      assert.ok(!left.includes('railcount:input'), 'the zero-match Needs input shortcut stayed on the rail');
      assert.equal(
        await focused(),
        'railcount:active',
        'the payload that removed the focused count left focus off the first count or the funnel',
      );

      await post(initial.rail);
      assert.ok((await head()).includes('railcount:input'), 'the Needs input count did not return with its figure');
      assert.deepEqual(failures, []);
    } finally {
      await browser.close();
    }
  },
);

// The selected count uses theme ground and focus-border variables without changing font weight.

test(
  'a pressed count wears the checked pill ground and the focus border in light, dark and One Dark Pro Darker',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so the pressed count was not measured');
      return;
    }
    try {
      for (const kind of ['dark', 'light', 'onedark'] as const) {
        const page = await browser.newPage();
        await page.setViewportSize({ width: 1350, height: 900 });
        await page.setContent(themed(pageHtml(), kind));
        await page.evaluate(`window.postMessage(${JSON.stringify(payload())}, '*')`);
        await page.evaluate(SETTLED);
        const active = page.locator('[data-control="railcount:active"]');
        await active.click();
        await page.evaluate(SETTLED);
        assert.equal(await active.getAttribute('aria-pressed'), 'true');
        const read = (await page.evaluate(`(() => {
          const span = document.createElement('span');
          span.style.cssText = 'background-color: var(--vscode-list-activeSelectionBackground);'
            + 'border-top-color: var(--vscode-focusBorder);';
          document.body.appendChild(span);
          const probe = getComputedStyle(span);
          const wanted = { background: probe.backgroundColor, border: probe.borderTopColor };
          span.remove();
          const drawn = getComputedStyle(document.querySelector('[data-control="railcount:active"]'));
          return {
            got: { background: drawn.backgroundColor, border: drawn.borderTopColor },
            weight: getComputedStyle(document.querySelector('[data-control="railcount:active"] .railcountname')).fontWeight,
            wanted,
          };
        })()`)) as { got: Record<string, string>; weight: string; wanted: Record<string, string> };
        assert.deepEqual(read.got, read.wanted, `${kind}: the pressed count disagrees with the pressed rule`);
        assert.equal(read.weight, '400', `${kind}: the pressed label weight is ${read.weight}, not 400`);
        await page.close();
      }
    } finally {
      await browser.close();
    }
  },
);

// `railShownCards` stamps the clock-derived Active fact before matching each query.
// The typed lens keeps active sessions at open. A clock tick drops sessions whose recency and cache windows have closed.
test(
  'a typed is:active lens drops a session on the tick it leaves the recency window',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so is:active was not measured');
      return;
    }
    try {
      const page = await browser.newPage();
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(String(error)));
      await openPage(page, payload(), FIXTURE_CLOCK, { railFilter: 'is:active', railFilterId: ALL_RAIL_FILTER_ID });
      const cardsShown = async () =>
        (await page.evaluate(
          `[...new Set([...document.querySelectorAll('.railcard')].map((node) => node.dataset.session))]`,
        )) as string[];
      // Only s1 and s2 are Active at the opening clock. After an hour, their recency and cache windows have expired.

      assert.deepEqual(await cardsShown(), ['s1', 's2'], 'is:active drew a different set of sessions at open');

      await page.clock.setFixedTime(FIXTURE_CLOCK + 61 * 60_000);
      await page.waitForFunction(
        `![...document.querySelectorAll('.railcard')].some((node) => node.dataset.session === 's1')`,
        undefined,
        { timeout: 10_000 },
      );
      assert.deepEqual(await cardsShown(), [], 'the is:active list kept a session an hour after its own window closed');
      assert.deepEqual(failures, []);
    } finally {
      await browser.close();
    }
  },
);

// A count press leaves the box closed, so nothing is offered under it, and the magnifying glass
// then shows the words the press wrote.
test('a count press leaves the box closed and the magnifying glass shows its words', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so the save offer was not measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(String(error)));
    await openPage(page, payload([], [], [], [], [], [], new Map([['s2', 'waiting']])), FIXTURE_CLOCK, {
      railFilter: '',
    });

    await page.locator('[data-control="railcount:active"]').click();
    await page.evaluate(SETTLED);
    assert.equal(await page.locator('.railfilter').count(), 0, 'the count press opened the box');
    assert.equal(
      await page.locator('[data-control="railviewsave"]').count(),
      0,
      'the head offered to save a query with no box open',
    );

    await page.locator('[data-control="railsearch"]').click();
    await page.evaluate(SETTLED);
    assert.equal(await page.locator('.railfilter').inputValue(), 'is:active -is:archived -is:agentrun');

    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

test(
  'a stored live query of is:running narrows the rail and the funnel reads Custom',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so the stored is:running query was not measured');
      return;
    }
    try {
      const page = await browser.newPage();
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(String(error)));
      // Stored panel state restores the query with the filter box closed.

      await openPage(
        page,
        payload(
          [],
          [],
          [],
          [],
          [],
          [],
          new Map([
            ['s2', 'waiting'],
            ['s3', 'running'],
          ]),
        ),
        FIXTURE_CLOCK,
        { railFilter: 'is:running', railFilterId: ALL_RAIL_FILTER_ID },
      );
      const cardsShown = async () =>
        (await page.evaluate(
          `[...new Set([...document.querySelectorAll('.railcard')].map((node) => node.dataset.session))]`,
        )) as string[];
      const funnel = async () =>
        await page.evaluate(`(() => ({
        name: document.querySelector('[data-control="railfilters"]').getAttribute('aria-label'),
        filled: document.querySelector('.railfiltersicon').classList.contains('active'),
      }))()`);
      assert.equal(await page.locator('.railfilter').count(), 0, 'the stored query held the box open');
      await page.locator('[data-control="railsearch"]').click();
      await page.evaluate(SETTLED);
      assert.equal(
        await page.locator('.railfilter').inputValue(),
        'is:running',
        'the box did not show the stored query',
      );
      assert.deepEqual(await cardsShown(), ['s3'], 'the stored is:running query kept a session that is not running');
      assert.deepEqual(
        await funnel(),
        { name: 'View, Custom, Latest update', filled: true },
        'a stored is:running query did not read Custom on the funnel',
      );
      assert.deepEqual(failures, []);
    } finally {
      await browser.close();
    }
  },
);

// A query at the box's typed limit, with a stored lens folded into it and then pressed, keeps
// the reader's last word through the load, a switch and a release.
test('a count press over a query at the typed limit cuts none of the reader words', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so the long pressed query was not measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(String(error)));
    const typed = `${'-label:zz '.repeat(19)}-label:bug`;
    assert.equal(typed.length, RAIL_FILTER_QUERY_LIMIT);
    await openPage(page, payload(), FIXTURE_CLOCK, {
      railFilterId: ALL_RAIL_FILTER_ID,
      railFilter: typed,
      railLens: 'needs-you',
    });
    await page.locator('[data-control="railsearch"]').click();
    await page.evaluate(SETTLED);
    assert.equal(
      await page.locator('.railfilter').inputValue(),
      typed,
      'the stored Needs you lens changed the stored query',
    );
    await page.locator('[data-control="railfilters"]').focus();
    await page.evaluate(SETTLED);
    await page.evaluate(`window.__posted = []`);
    const saved = async () =>
      (await page.evaluate(
        `window.__posted.filter((message) => message.type === 'saveState').at(-1)?.state?.railFilter`,
      )) as string;
    const active = page.locator('[data-control="railcount:active"]');
    await active.click();
    await page.evaluate(SETTLED);
    assert.equal(await saved(), `${RAIL_LENS_WORDS.active} ${typed}`, 'the switch to Active cut the query');
    assert.equal(await active.getAttribute('aria-pressed'), 'true');
    await active.click();
    await page.evaluate(SETTLED);
    assert.equal(await saved(), typed, 'the release of Active cut the query');
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

test(
  'reapplying an unchanged external unread query removes departed retained sessions',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed browser');
      return;
    }
    try {
      const page = await browser.newPage();
      const initial = payload();
      const seed = initial.rail[0];
      initial.rail = [
        { ...seed, id: 'one', label: 'First', current: true, unread: true },
        { ...seed, id: 'two', label: 'Second', current: false, unread: true },
        { ...seed, id: 'other', label: 'Unrelated', current: false, unread: false },
      ];
      initial.showing = 'one';
      initial.views = [];
      const query = 'is:unread -is:archived -is:agentrun';
      await openPage(page, initial, FIXTURE_CLOCK, {
        railFilter: query,
        railFilterId: 'all',
        railFolds: { railtoday: true },
        showing: 'one',
      });
      assert.deepEqual(await page.locator('.railcard .railname').allTextContents(), ['First', 'Second']);
      await postToPage(
        page,
        railMessage(
          initial,
          initial.rail.map((row) => ({ ...row, unread: row.id === 'two' })),
        ),
      );
      assert.deepEqual(await page.locator('.railcard .railname').allTextContents(), ['First', 'Second']);
      await postToPage(page, {
        type: 'applySessionFilter',
        request: 'same-unread',
        query,
        deadline: FIXTURE_CLOCK + 30_000,
      });
      await page.waitForFunction(
        "window.__posted.some(message => message.type === 'sessionFilterApplied' && message.request === 'same-unread')",
      );
      assert.deepEqual(await page.locator('.railcard .railname').allTextContents(), ['Second']);
      assert.equal(
        await page.evaluate("window.__posted.find(message => message.request === 'same-unread').state.showing"),
        'one',
      );
    } finally {
      await browser.close();
    }
  },
);

test(
  'external session filtering replaces retention, preserves selection, and acknowledges saved state',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed browser');
      return;
    }
    try {
      const page = await browser.newPage();
      const initial = payload();
      const seed = initial.rail[0];
      initial.rail = [
        { ...seed, id: 'one', agent: 'Claude', label: 'First', current: true, unread: true },
        { ...seed, id: 'two', agent: 'Codex', label: 'Second', current: false, unread: false },
        { ...seed, id: 'other', agent: 'Claude', label: 'Unrelated', current: false, unread: false },
      ];
      initial.showing = 'one';
      initial.views = [];
      const saved = {
        railFilter: 'is:unread -is:archived -is:agentrun',
        railFilterId: 'all',
        railFolds: { railtoday: true },
        showing: 'one',
      };
      await openPage(page, initial, FIXTURE_CLOCK, saved);
      await postToPage(
        page,
        railMessage(
          initial,
          initial.rail.map((row) => ({ ...row, unread: false })),
        ),
      );
      const query = 'session:claude:one OR session:codex:two';
      await postToPage(page, {
        type: 'applySessionFilter',
        request: 'external-one',
        query,
        deadline: FIXTURE_CLOCK + 30_000,
      });
      await page.waitForFunction(
        "window.__posted.some(message => message.type === 'sessionFilterApplied' && message.request === 'external-one')",
      );
      assert.deepEqual(await page.locator('.railcard .railname').allTextContents(), ['First', 'Second']);
      const ack = (await page.evaluate(
        "window.__posted.find(message => message.type === 'sessionFilterApplied' && message.request === 'external-one')",
      )) as any;
      assert.equal(ack.state.railFilter, query);
      assert.equal(ack.state.showing, 'one');
      await postToPage(page, {
        type: 'applySessionFilter',
        request: 'expired',
        query: 'session:other',
        deadline: FIXTURE_CLOCK - 1,
      });
      assert.equal(await page.evaluate("window.__posted.some(message => message.request === 'expired')"), false);
      await page.close();
      const restored = await browser.newPage();
      await openPage(restored, initial, FIXTURE_CLOCK, ack.state);
      assert.deepEqual(await restored.locator('.railcard .railname').allTextContents(), ['First', 'Second']);
      await postToPage(restored, {
        type: 'applySessionFilter',
        request: 'clear',
        query: '',
        deadline: FIXTURE_CLOCK + 30_000,
      });
      await restored.waitForFunction(
        "window.__posted.some(message => message.type === 'sessionFilterApplied' && message.request === 'clear')",
      );
      assert.equal(await restored.locator('.railcard').count(), 3);
    } finally {
      await browser.close();
    }
  },
);
