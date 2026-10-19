// Session list row identity, order, grouping, menus, keyboard controls, and resizing.
// Shared helpers live in `../test/rail.ts`.

import { test } from 'vitest';
import assert from 'node:assert';
import { browserOrNone, SETTLED } from '../test/browser.ts';
import { FIXTURE_CLOCK, NOW, pageHtml, themed } from './panelfixture.ts';
import { ALL_RAIL_FILTER_ID } from './domain/rail-filters.ts';
import { RAIL_MIN_WIDTH, RAIL_ROW_STEP, subagentsHintDetail } from './view/rail.ts';
import { formatRelativeShort } from './view/time.ts';
import { newSessionKeyshortcut } from './view/launcher.ts';
import {
  type RailCard,
  payload,
  COMPOSER_VIEW,
  RELEASE_VIEW,
  inSection,
  railMessage,
  openPage,
  postToPage,
} from '../test/rail.ts';

test(
  'native Tab enters every session list control and leaves through its separator',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed browser');
      return;
    }
    try {
      for (const density of ['comfortable', 'compact']) {
        const page = await browser.newPage();
        await openPage(page, payload(), FIXTURE_CLOCK, { railFilter: '', railDensity: density });
        const expected = await page
          .locator('#rail button, #rail input')
          .evaluateAll((nodes) =>
            nodes
              .filter((node) => node.getClientRects().length && !(node as HTMLButtonElement).disabled)
              .map((node) => (node as HTMLElement).dataset.control),
          );
        assert.ok(expected.some((control) => control?.startsWith('rail:')));
        const visited = [];
        for (const control of expected) {
          await page.keyboard.press('Tab');
          const actual = await page.evaluate(() => (document.activeElement as HTMLElement).dataset.control);
          visited.push(actual);
          assert.equal(actual, control, `native Tab skipped ${control} in ${density} rows`);
        }
        assert.deepEqual(visited, expected);
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement?.id), 'railsash');
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => !!document.activeElement?.closest('#list')), true);
        assert.equal(
          await page.evaluate(
            () =>
              (window as unknown as { __posted: { type: string }[] }).__posted.filter(
                (message) => message.type === 'showSession',
              ).length,
          ),
          0,
        );
        await page.close();
      }
    } finally {
      await browser.close();
    }
  },
);

for (const start of ['.railact', '.railviewmenu']) {
  test(
    `session list arrows from ${start === '.railact' ? 'sibling actions' : 'saved-view menus'} stay local without selection`,
    { timeout: 60_000 },
    async (t) => {
      const browser = await browserOrNone();
      if (!browser) {
        t.skip('no installed browser');
        return;
      }
      try {
        const page = await browser.newPage();
        await openPage(page, payload(), FIXTURE_CLOCK, { railFilter: '' });
        const controls = await page
          .locator('#rail .railcard, #rail .railfold, #rail .railmore')
          .evaluateAll((nodes) =>
            nodes.filter((node) => !node.closest('[hidden]')).map((node) => (node as HTMLElement).dataset.control),
          );
        const sources = page.locator(`#rail ${start}`);
        for (const source of [sources.first(), sources.last()]) {
          const primary = await source.evaluate(
            (node) => node.closest('.railrow, h2')?.querySelector<HTMLElement>('.railcard, .railfold')?.dataset.control,
          );
          const index = controls.indexOf(primary);
          assert.ok(index >= 0);
          for (const [key, expected] of [
            ['ArrowDown', controls[Math.min(index + 1, controls.length - 1)]],
            ['ArrowUp', controls[Math.max(index - 1, 0)]],
            ['Home', controls[0]],
            ['End', controls.at(-1)],
          ] as const) {
            await source.focus();
            await page.keyboard.press(key);
            assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.control), expected);
          }
        }
        await page.keyboard.press('ArrowDown');
        assert.equal(
          await page.evaluate(() => (document.activeElement as HTMLElement).dataset.control),
          controls.at(-1),
        );
        await page.keyboard.press('Home');
        await page.keyboard.press('ArrowUp');
        assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.control), controls[0]);
        assert.equal(
          await page.evaluate(
            () =>
              (window as unknown as { __posted: { type: string }[] }).__posted.filter(
                (message) => message.type === 'showSession',
              ).length,
          ),
          0,
        );
      } finally {
        await browser.close();
      }
    },
  );
}

test('Sessions headings label mounted native lists and current session occurrences', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed browser');
    return;
  }
  try {
    const page = await browser.newPage();
    await openPage(page, payload(), FIXTURE_CLOCK, { railFilter: '' });
    const structure = await page.evaluate(() => {
      const nav = document.getElementById('rail')!;
      return {
        heading: nav.querySelector('h1')?.textContent,
        lists: Array.from(nav.querySelectorAll('ul')).map((list) => ({
          labelled: document.getElementById(list.getAttribute('aria-labelledby')!)?.tagName,
          rows: list.children.length,
          items: Array.from(list.children).every((row) => row.tagName === 'LI' && row.querySelector('.railcard')),
        })),
        controls: Array.from(nav.querySelectorAll('.railfold[aria-controls]')).map((button) => {
          const list = document.getElementById(button.getAttribute('aria-controls')!);
          return list?.tagName === 'UL' && list.getAttribute('aria-labelledby') === button.closest('h2')?.id;
        }),
        current: Array.from(nav.querySelectorAll('.railcard[aria-current="true"]')).map(
          (button) => (button as HTMLElement).dataset.session,
        ),
        selected: nav.querySelectorAll('[aria-selected]').length,
      };
    });
    assert.equal(structure.heading, 'Sessions');
    assert.ok(structure.lists.length > 0);
    assert.ok(structure.lists.every((list) => list.labelled === 'H2' && list.rows > 0 && list.items));
    assert.ok(structure.controls.length > 0 && structure.controls.every(Boolean));
    assert.ok(structure.current.length > 0 && structure.current.every((id) => id === 's1'));
    assert.equal(structure.selected, 0);
    await page.locator('[data-control="railsearch"]').click();
    await page.locator('.railfilter').fill('no-session-with-this-name');
    await page.evaluate(SETTLED);
    assert.equal(await page.locator('#rail h2').last().locator('button').count(), 0);
    assert.equal(await page.locator('#rail ul').count(), 0);
  } finally {
    await browser.close();
  }
});

test('large session lists return to Search without traversing session rows', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed browser');
    return;
  }
  try {
    for (const density of ['comfortable', 'compact']) {
      for (const count of [100, RAIL_ROW_STEP + 50]) {
        const initial = payload();
        initial.views = [];
        initial.rail = Array.from({ length: count }, (_, index) => ({
          ...initial.rail[0],
          id: `large-${index}`,
          label: `Unique_session_${String(index).padStart(4, '0')}`,
          name: `Unique_session_${String(index).padStart(4, '0')}`,
          labels: [],
          pinnedTop: false,
          current: index === count - 1,
        }));
        const page = await browser.newPage();
        await openPage(page, initial, FIXTURE_CLOCK, { railFilter: '', railGroupBy: 'none', railDensity: density });
        assert.equal(await page.locator('#rail .railcard').count(), count);
        const headerCount = await page
          .locator('.railtop button, .railtop input')
          .evaluateAll(
            (nodes) =>
              nodes.filter((node) => node.getClientRects().length && !(node as HTMLButtonElement).disabled).length,
          );
        for (let step = 0; step <= headerCount; step++) await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('railfold')), true);
        await page.keyboard.press('End');
        assert.equal(
          await page.evaluate(() => (document.activeElement as HTMLElement).dataset.control),
          `rail:large-${count - 1}`,
        );
        for (let action = 0; action < 3; action++) await page.keyboard.press('Tab');
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement?.id), 'railsash');
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => !!document.activeElement?.closest('#list')), true);
        await page.keyboard.press('Shift+Tab');
        assert.equal(await page.evaluate(() => document.activeElement?.id), 'railsash');
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Home');
        assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('railfold')), true);
        let returned = false;
        for (let step = 0; step < headerCount; step++) {
          await page.keyboard.press('Shift+Tab');
          assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.railrow')), false);
          if (await page.evaluate(() => (document.activeElement as HTMLElement).dataset.control === 'railsearch')) {
            returned = true;
            break;
          }
        }
        assert.ok(returned, `Search was unreachable within the ${headerCount} header controls`);
        await page.keyboard.press('Enter');
        for (const target of [0, count - 1]) {
          await page.locator('.railfilter').fill(`Unique_session_${String(target).padStart(4, '0')}`);
          await page.evaluate(SETTLED);
          assert.equal(await page.locator('#rail .railcard').count(), 1);
          // Filling retains input focus. Native Tab crosses only the mounted header controls.
          let reached = false;
          for (let step = 0; step <= headerCount + 2; step++) {
            await page.keyboard.press('Tab');
            if (await page.evaluate(() => document.activeElement?.classList.contains('railcard'))) {
              reached = true;
              break;
            }
          }
          assert.ok(reached);
          assert.equal(
            await page.evaluate(() => (document.activeElement as HTMLElement).dataset.control),
            `rail:large-${target}`,
          );
          const shownBefore = await page.evaluate(
            () =>
              (window as unknown as { __posted: { type: string }[] }).__posted.filter(
                (message) => message.type === 'showSession',
              ).length,
          );
          await page.keyboard.press('ArrowDown');
          assert.equal(
            await page.evaluate(
              () =>
                (window as unknown as { __posted: { type: string }[] }).__posted.filter(
                  (message) => message.type === 'showSession',
                ).length,
            ),
            shownBefore,
          );
          await page.keyboard.press('Enter');
          assert.equal(
            await page.evaluate(
              () =>
                (window as unknown as { __posted: { type: string }[] }).__posted.filter(
                  (message) => message.type === 'showSession',
                ).length,
            ),
            shownBefore + 1,
          );
        }
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});

test(
  'the separator keys save changed bounds and retain preferred width across viewport changes',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed browser');
      return;
    }
    try {
      const page = await browser.newPage();
      await openPage(page, payload(), FIXTURE_CLOCK, { railFilter: '', railWidth: 1500 });
      const sash = page.getByRole('separator', { name: 'Session list width' });
      const maximum = Number(await sash.getAttribute('aria-valuemax'));
      assert.equal(Number(await sash.getAttribute('aria-valuenow')), maximum);
      await page.setViewportSize({ width: 1800, height: 900 });
      await page.waitForFunction(() => document.getElementById('railsash')?.getAttribute('aria-valuenow') === '1500');
      await sash.focus();
      await page.keyboard.press('ArrowLeft');
      assert.equal(await sash.getAttribute('aria-valuenow'), '1490');
      await page.keyboard.press('Home');
      assert.equal(await sash.getAttribute('aria-valuenow'), '160');
      const saved = () =>
        page.evaluate(() =>
          (window as unknown as { __posted: { type: string; state?: { railWidth: number } }[] }).__posted
            .filter((message) => message.type === 'saveState')
            .map((message) => message.state?.railWidth),
        );
      const before = await saved();
      await page.keyboard.press('ArrowLeft');
      assert.deepEqual(await saved(), before, 'a bounded key saved an unchanged width');
      await page.keyboard.press('End');
      const end = Number(await sash.getAttribute('aria-valuemax'));
      assert.equal(Number(await sash.getAttribute('aria-valuenow')), end);
      assert.equal((await saved()).at(-1), end);
      await page.keyboard.press('Shift+ArrowLeft');
      assert.equal(Number(await sash.getAttribute('aria-valuenow')), end);
      await page.setViewportSize({ width: 600, height: 900 });
      await page.waitForFunction(() => document.getElementById('rail')?.hidden === true);
      assert.equal(
        await page.evaluate(
          () => document.activeElement?.id === 'railsash' || !!document.activeElement?.closest('#rail'),
        ),
        false,
      );
    } finally {
      await browser.close();
    }
  },
);

test('running rail cards show a minute duration with the recorded clock hover', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so the rail page was not measured');
    return;
  }
  try {
    const started = FIXTURE_CLOCK - 31 * 60_000;
    const initial = payload([], [], [], [], [], [], new Map([['s2', 'running']]), new Map([['s2', started]]));
    const card = initial.rail.find((candidate) => candidate.id === 's2') as RailCard & {
      absolute: string;
      runningSinceWhen: string;
    };
    const page = await browser.newPage();
    await openPage(page, initial, FIXTURE_CLOCK);
    const row = page.locator('[data-control="rail:s2"]');
    assert.equal(await row.locator('.railstatus').innerText(), 'running 31m');
    assert.match((await row.getAttribute('aria-label')) ?? '', /running for 31m/);
    assert.equal(
      await row.locator('.railfor').getAttribute('title'),
      `Started ${card.runningSinceWhen}\nLast activity ${card.absolute}`,
    );
  } finally {
    await browser.close();
  }
});

test(
  'rail rows keep identity through insertion and ordering, and focus follows a row to its new section',
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
      const initial = payload();
      await openPage(page, initial);
      // s1 starts in Composer and s2 in Release 0.4. Reordering moves s2 ahead of s1 in the saved view.

      await page.evaluate(`(() => {
      window.__railS1 = document.querySelector('${inSection(COMPOSER_VIEW, 'rail:s1')}');
      window.__railS2 = document.querySelector('${inSection(RELEASE_VIEW, 'rail:s2')}');
    })()`);

      // The inserted session carries no label, so it lands in a time bucket. Spread from
      // s1 it would inherit s1's labels, and both saved views would draw a card for it.
      const inserted = {
        ...initial.rail[0],
        id: 'inserted',
        label: 'Inserted session',
        at: NOW - 30_000,
        current: false,
        name: 'Inserted session',
        pinnedTop: false,
        labels: [],
      };
      const reordered = [inserted, initial.rail[1], initial.rail[0], ...initial.rail.slice(2)];
      await page.evaluate(`window.postMessage(${JSON.stringify(railMessage(initial, reordered))}, '*')`);
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.evaluate(`({
      s1: document.querySelector('${inSection(COMPOSER_VIEW, 'rail:s1')}') === window.__railS1,
      s2: document.querySelector('${inSection(RELEASE_VIEW, 'rail:s2')}') === window.__railS2,
      inserted: !!document.querySelector('[data-control="rail:inserted"]'),
    })`),
        { s1: true, s2: true, inserted: true },
      );

      // Pinning adds a copy under Pinned. A row keys by its session and its section, so the view
      // keeps the element it drew and the Pinned copy is an element of its own.
      const transferred = reordered.map((card) => (card.id === 's2' ? { ...card, pinnedTop: true } : card));
      await page.evaluate(`window.postMessage(${JSON.stringify(railMessage(initial, transferred))}, '*')`);
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.evaluate(`({
      same:
        document.querySelector('${inSection(RELEASE_VIEW, 'rail:s2')}') === window.__railS2 &&
        document.querySelector('${inSection('railpinned', 'rail:s2')}') !== window.__railS2,
      cards: document.querySelectorAll('[data-control="rail:s2"]').length,
      buckets: [...document.querySelectorAll('[data-control="rail:s2"]')]
        .map((card) => card.closest('.railrow').dataset.railBucket),
      direct: document.querySelector('${inSection('railpinned', 'rail:s2')}').closest('.railrow').parentElement
        .matches('ul.railgrouplist'),
    })`),
        { same: true, cards: 2, buckets: ['railpinned', RELEASE_VIEW], direct: true },
      );

      // A focused row that moves to another section is a new element, and the focus goes with
      // its session to the row the new section draws.
      await page.locator('[data-control="rail:inserted"]').focus();
      const labelled = transferred.map((card) => (card.id === 'inserted' ? { ...card, labels: ['composer'] } : card));
      await page.evaluate(`window.postMessage(${JSON.stringify(railMessage(initial, labelled))}, '*')`);
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.evaluate(`({
      control: document.activeElement?.dataset?.control,
      section: document.activeElement?.closest('.railrow')?.dataset.railBucket,
    })`),
        { control: 'rail:inserted', section: COMPOSER_VIEW },
        'the focus left the session that moved section',
      );
      assert.deepEqual(failures, []);
      const grouped = payload();
      grouped.views = [];
      grouped.rail = ['a', 'c', 'b'].flatMap((label, group) =>
        Array.from({ length: 8 }, (_, index) => ({
          ...grouped.rail[0],
          id: `${label}-${index}`,
          label: `${label} session ${index}`,
          name: `${label} session ${index}`,
          labels: [label],
          pinnedTop: false,
          current: false,
          at: FIXTURE_CLOCK - (group + 1) * 60_000 - index,
        })),
      );
      const groupPage = await browser.newPage();
      await openPage(groupPage, grouped, FIXTURE_CLOCK, { railFilter: '', railGroupBy: 'label' });
      await groupPage.setViewportSize({ width: 1350, height: 320 });
      await groupPage.locator('[data-control="railpin:b-0"]').focus();
      const beforeGroup = await groupPage.evaluate(() => {
        const active = document.activeElement as HTMLElement;
        (window as unknown as { __groupFocus: HTMLElement }).__groupFocus = active;
        const rail = document.getElementById('rail')!;
        rail.scrollTop = Math.min(180, rail.scrollHeight - rail.clientHeight);
        return {
          scroll: rail.scrollTop,
          order: Array.from(rail.querySelectorAll('h2 .railbucketname')).map((node) => node.textContent),
        };
      });
      assert.ok(beforeGroup.scroll > 0);
      assert.deepEqual(beforeGroup.order, ['a', 'c', 'b']);
      const updated = grouped.rail.map((card) => (card.id === 'b-0' ? { ...card, at: FIXTURE_CLOCK - 90_000 } : card));
      await postToPage(groupPage, railMessage(grouped, updated));
      assert.deepEqual(
        await groupPage.evaluate(() => {
          const held = (window as unknown as { __groupFocus: HTMLElement }).__groupFocus;
          const rail = document.getElementById('rail')!;
          return {
            connected: held.isConnected,
            focused: document.activeElement === held,
            control: (document.activeElement as HTMLElement).dataset.control,
            scroll: rail.scrollTop,
            order: Array.from(rail.querySelectorAll('h2 .railbucketname')).map((node) => node.textContent),
            selected: (window as unknown as { __posted: { type: string }[] }).__posted.filter(
              (message) => message.type === 'showSession',
            ).length,
          };
        }),
        {
          connected: true,
          focused: true,
          control: 'railpin:b-0',
          scroll: beforeGroup.scroll,
          order: ['a', 'b', 'c'],
          selected: 0,
        },
      );
      await groupPage.close();
    } finally {
      await browser.close();
    }
  },
);

test('the compact picker keeps every session in the rail default cost order', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so the compact picker was not measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(String(error)));
    const initial = payload();
    initial.rail.forEach((card, index) => {
      card.costDollars = index;
      card.costAtLeast = false;
    });
    const expected = initial.rail
      .slice()
      .reverse()
      .map((card) => card.id);
    await openPage(page, initial);
    await page.locator('[data-control="railfilters"]').click();
    await page.locator('[data-control="railfilter-order:cost-desc"]').click();
    await page.setViewportSize({ width: RAIL_MIN_WIDTH - 1, height: 900 });
    await page.evaluate(SETTLED);
    const picker = await page.evaluate(`(() => [...document.querySelector('[data-control="picker"]').options]
      .map((option) => option.value))()`);
    assert.deepEqual(picker, expected, 'the compact picker did not keep all sessions in the persisted cost order');
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

test(
  'the View menu stays open on each pressed control and folds its labels again when it closes',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so the View menu was not measured');
      return;
    }
    try {
      const page = await browser.newPage();
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(String(error)));
      const initial = payload();
      const labels = [
        ...(initial.labels as { name: string; count: number; countName: string }[]),
        ...Array.from({ length: 13 }, (_, index) => ({
          name: `spare-${index}`,
          count: 1,
          countName: 'carried by one session',
        })),
      ];
      initial.labels = labels;
      await openPage(page, initial, undefined, { railFilter: '' });
      const active = async () => await page.evaluate(`document.activeElement?.dataset?.control ?? null`);
      const menu = async () =>
        await page.evaluate(`(() => {
        const pop = document.getElementById('railfilterpop');
        const more = pop.querySelector('[data-control="railfilter-more-labels"]');
        return {
          open: !pop.hidden,
          chips: pop.querySelectorAll('[data-control^="railfilterlabel:"]').length,
          more: more ? { text: more.textContent, expanded: more.getAttribute('aria-expanded') } : null,
        };
      })()`);
      const folded = { open: true, chips: 12, more: { text: `${labels.length - 12} more`, expanded: 'false' } };

      await page.locator('[data-control="railfilters"]').click();
      assert.deepEqual(
        await page.evaluate(`(() => ({
          head: document.querySelector('#railfilterpop .launchhead').textContent,
          sections: [...document.querySelectorAll('#railfilterpop .railfiltersectionname')].map((node) => node.textContent),
          gone: document.querySelectorAll('#railfilterpop select, [data-control^="railfilterstatus:"], [data-control="railfilterpick:needs-you"], [data-control="railfilter-open"]').length,
          detail: document.querySelector('[data-control="railfilterpick:f1"] .launchdetail')?.textContent ?? null,
        }))()`),
        {
          head: 'View',
          sections: ['Filter', 'Quick filters', 'Group by', 'Sort by', 'Rows', 'Show', 'Labels', 'Saved filters'],
          gone: 0,
          detail: 'is:unread label:costs',
        },
      );
      assert.deepEqual(await menu(), folded, 'the menu did not fold its labels after twelve');

      await page.locator('[data-control="railfilter-more-labels"]').click();
      assert.deepEqual(await menu(), {
        open: true,
        chips: labels.length,
        more: { text: 'Fewer labels', expanded: 'true' },
      });
      assert.equal(await active(), 'railfilter-more-labels');

      for (const control of [
        'railgroupby:label',
        'railfilter-order:cost-desc',
        'raildensity:compact',
        'railshow:archived',
        'railfilterlabel:composer',
      ]) {
        await page.locator(`[data-control="${control}"]`).click();
        await page.evaluate(SETTLED);
        assert.equal(((await menu()) as { open: boolean }).open, true, `a press on ${control} closed the View menu`);
        assert.equal(await active(), control, `a press on ${control} moved focus off it`);
      }
      assert.deepEqual(
        await page.evaluate(`(() => ({
          chip: document.querySelector('[data-control="railfilterlabel:composer"]').getAttribute('aria-pressed'),
          sort: document.querySelector('[data-control="railfilter-order:cost-desc"]').getAttribute('aria-checked'),
          archived: document.querySelector('[data-control="railshow:archived"]').checked,
          group: document.querySelector('[data-control="railgroupby:label"]').getAttribute('aria-checked'),
          rows: document.querySelector('[data-control="raildensity:compact"]').getAttribute('aria-checked'),
        }))()`),
        { chip: 'true', sort: 'true', archived: false, group: 'true', rows: 'true' },
      );

      // A typed find shows every label it matches, past the fold, with no fold chip.
      await page.locator('[data-control="railfilter-find"]').fill('spare');
      assert.deepEqual(await menu(), { open: true, chips: 13, more: null });

      await page.keyboard.press('Escape');
      assert.equal(await active(), 'railfilters');
      await page.locator('[data-control="railfilters"]').click();
      assert.deepEqual(await menu(), folded, 'the fold did not reset when the menu closed');
      await page.keyboard.press('Escape');

      // A workspace with no labels shows the note and no Match line. One whose every label the
      // query negates draws no chip group, and keeps Match, which governs the negation too.
      const labelSection = async (labelsGiven: unknown[], railFilter: string) => {
        const other = await browser.newPage();
        other.on('pageerror', (error) => failures.push(String(error)));
        const given = payload();
        given.labels = labelsGiven;
        await openPage(other, given, undefined, { railFilter, railFilterId: ALL_RAIL_FILTER_ID });
        await other.locator('[data-control="railfilters"]').click();
        const seen = await other.evaluate(`(() => ({
          sections: [...document.querySelectorAll('#railfilterpop .railfiltersectionname')].map((node) => node.textContent),
          empty: document.querySelector('#railfilterpop .labelempty')?.textContent ?? null,
          groups: document.querySelectorAll('#railfilterpop .railfilterlabels').length,
        }))()`);
        await other.close();
        return seen;
      };
      assert.deepEqual(
        await labelSection([], ''),
        {
          sections: ['Filter', 'Quick filters', 'Group by', 'Sort by', 'Rows', 'Show', 'Labels', 'Saved filters'],
          empty: "No labels yet. Add one from a session's Labels line.",
          groups: 0,
        },
        'a workspace with no labels drew chips or a Match line',
      );
      assert.deepEqual(
        await labelSection([{ name: 'solo', count: 1, countName: 'carried by one session' }], '-label:solo'),
        {
          sections: ['Filter', 'Quick filters', 'Group by', 'Sort by', 'Rows', 'Show', 'Labels', 'Saved filters'],
          empty: null,
          groups: 0,
        },
        'a query negating every label drew an empty chip group or lost the Match line',
      );
      assert.deepEqual(failures, []);
    } finally {
      await browser.close();
    }
  },
);

test('the View menu owns rail order and closes on an outside press', { timeout: 60_000 }, async (t) => {
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
    const trigger = page.locator('[data-control="railfilters"]');
    await trigger.click();
    assert.equal(await page.locator('[data-control="railsort"]').count(), 0);
    const checked = () =>
      page.evaluate(`[...document.querySelectorAll('#railfilterpop [data-control^="railfilter-order:"]')]
      .filter((node) => node.getAttribute('aria-checked') === 'true').map((node) => node.dataset.control)`);
    assert.deepEqual(await checked(), ['railfilter-order:latest']);
    await page.locator('[data-control="railfilter-order:cost-desc"]').press('Enter');
    assert.deepEqual(await checked(), ['railfilter-order:cost-desc']);
    assert.equal(await trigger.getAttribute('aria-label'), 'View, All sessions, Cost, highest first');
    await page.locator('[data-control="railfilter-order:needs-you"]').click();
    assert.equal(await trigger.getAttribute('aria-label'), 'View, All sessions, Needs you first');
    // A press on nothing that takes focus closes the menu and hands focus back to the funnel.
    // The first point on a coarse grid that holds no control and sits outside the menu.
    const blank = (await page.evaluate(`(() => {
      const pop = document.getElementById('railfilterpop');
      for (let y = 20; y < innerHeight; y += 20) {
        for (let x = 20; x < innerWidth; x += 20) {
          const hit = document.elementFromPoint(x, y);
          if (!hit || pop.contains(hit)) { continue; }
          if (!hit.closest('button, input, select, textarea, a[href], [tabindex], [contenteditable]')) { return { x, y }; }
        }
      }
      return null;
    })()`)) as { x: number; y: number } | null;
    assert.ok(blank, 'the page drew no point outside a control');
    await page.mouse.click(blank.x, blank.y);
    assert.equal(await page.locator('#railfilterpop').isHidden(), true);
    assert.equal(
      await page.evaluate(`document.activeElement?.dataset?.control ?? null`),
      'railfilters',
      'a press on nothing focusable left focus off the funnel',
    );
    // The pointer rests on the blank point, so the funnel's hint stays hidden.
    assert.equal(
      await page.evaluate(`document.getElementById('hintpop').hidden`),
      true,
      'the funnel showed its hint under a pointer that rests elsewhere',
    );
    // A press on a control closes the menu and leaves focus on that control.
    await trigger.click();
    await page.locator('.railnew').click();
    assert.equal(await page.locator('#railfilterpop').isHidden(), true);
    assert.equal(
      await page.evaluate(`document.activeElement?.classList.contains('railnew') ?? false`),
      true,
      'the funnel took focus from the control the reader pressed',
    );
    await page.evaluate(`window.postMessage({ type: 'forgetState', since: 17 }, '*')`);
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await page.evaluate(`(() => {
      const trigger = document.querySelector('[data-control="railfilters"]');
      return { label: trigger.getAttribute('aria-label'), expanded: trigger.getAttribute('aria-expanded'), menu: !!document.getElementById('railsortmenu') };
    })()`),
      {
        label: 'View, All sessions, Latest update',
        expanded: 'false',
        menu: false,
      },
    );
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

// The bolt tooltip and the card name each word the cache lifetime. The name carries the words the tooltip shows in parentheses.
function assertTitleWordsInName(face: { title: string | null; name: string }): void {
  const words = /\(([^)]+)\)$/.exec(face.title ?? '')?.[1];
  assert.ok(words, 'the bolt tooltip names the cache lifetime');
  assert.ok(face.name.includes(words), 'the card name carries the cache lifetime the tooltip shows');
}

test('rail cache bolts show both faces and leave when the lifetime ends', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so the rail page was not measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(String(error)));
    await openPage(page, payload(), FIXTURE_CLOCK);
    const faces = (await page.evaluate(`(() => ['s1', 's2'].map((id) => {
      const card = document.querySelector('[data-control="rail:' + id + '"]');
      const mark = card.querySelector('.railcache');
      const style = mark ? getComputedStyle(mark) : null;
      return {
        state: mark ? mark.dataset.cacheState : null,
        title: mark ? mark.querySelector('title')?.textContent ?? null : null,
        fill: style ? style.fill : null,
        stroke: style ? style.stroke : null,
        name: card.getAttribute('aria-label'),
      };
    }))()`)) as Array<{
      state: string | null;
      title: string | null;
      fill: string | null;
      stroke: string | null;
      name: string;
    }>;
    assert.equal(faces[0].state, 'warm', 'the ordinary warm bolt is absent');
    assert.equal(faces[0].fill, 'none', 'the ordinary warm bolt is filled');
    assert.ok(faces[0].stroke && faces[0].stroke !== 'none', 'the ordinary warm bolt has no stroke');
    assertTitleWordsInName(faces[0]);
    assert.equal(faces[1].state, 'nearly-gone', 'the final-quarter bolt keeps the warm face');
    assert.notEqual(faces[1].fill, 'none', 'the final-quarter bolt stays hollow');
    assertTitleWordsInName(faces[1]);

    await page.evaluate(`(() => {
      window.__railCacheTitle = document.querySelector('[data-control="rail:s1"] .railcache title');
    })()`);
    const titleOf = (id: string) =>
      page.evaluate<string | null>(
        `document.querySelector('[data-control="rail:${id}"] .railcache title')?.textContent ?? null`,
      );
    const warmTitle = faces[0].title;
    await page.clock.setFixedTime(FIXTURE_CLOCK + 60_000);
    await page.waitForFunction(
      `(() => { const text = document.querySelector('[data-control="rail:s1"] .railcache title')?.textContent; return !!text && text !== ${JSON.stringify(warmTitle)}; })()`,
      undefined,
      { timeout: 5_000 },
    );
    assert.equal(
      await page.evaluate(
        `document.querySelector('[data-control="rail:s1"] .railcache title') === window.__railCacheTitle`,
      ),
      true,
      'a cache tooltip minute change remounts the rail row instead of updating its mounted title',
    );

    const nearlyGoneTitle = await titleOf('s2');
    await page.clock.setFixedTime(FIXTURE_CLOCK + 9 * 60_000);
    await page.waitForFunction(
      `(() => { const text = document.querySelector('[data-control="rail:s2"] .railcache title')?.textContent; return !!text && text !== ${JSON.stringify(nearlyGoneTitle)}; })()`,
      undefined,
      { timeout: 5_000 },
    );

    const literal = payload().rail.map((card) =>
      card.id === 's1'
        ? {
            ...card,
            cache: null,
            name: 'stale host name',
            nameBeforeAge: 'cache warm, just now, Claude',
            nameAfterAge: 'labelled cache nearly gone, just now',
          }
        : card,
    );
    await page.evaluate(`window.postMessage(${JSON.stringify(railMessage(payload(), literal))}, '*')`);
    await page.evaluate(SETTLED);
    assert.equal(
      await page.evaluate(`document.querySelector('[data-control="rail:s1"]').getAttribute('aria-label')`),
      // railCardName starts with name once, followed by nameBeforeAge clauses.

      `stale host name, cache warm, just now, Claude, just now, labelled cache nearly gone, just now, Last activity ${literal[0].absolute}`,
      'cache-like title and label words disappear when the browser rewrites a card name by pattern',
    );

    await page.clock.setFixedTime(FIXTURE_CLOCK + 11 * 60_000);
    await page.waitForFunction(`!document.querySelector('[data-control="rail:s2"] .railcache')`, undefined, {
      timeout: 5_000,
    });
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

test('folded rows are omitted and removed focus follows its bucket context', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so the rail page was not measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const initial = payload(['s3']);
    await openPage(page, initial, FIXTURE_CLOCK);
    // The page's own clock decides which bucket a row falls under. It must start pinned to
    // the fixture, or the buckets below drift with the hour the suite happens to run at.
    const pageNow = (await page.evaluate('Date.now()')) as number;
    assert.ok(Math.abs(pageNow - FIXTURE_CLOCK) < 1000, 'the page clock is not pinned to the fixture clock');
    // The Archived heading uses its section fold id, railarchived.

    assert.deepEqual(
      await page.evaluate(`(() => {
      const archived = document.querySelector('[data-bucket="railarchived"]');
      return { expanded: archived.getAttribute('aria-expanded'), controls: archived.getAttribute('aria-controls'),
        row: !!document.querySelector('[data-control="rail:s3"]') };
    })()`),
      { expanded: 'false', controls: null, row: false },
    );

    await page.evaluate(`(() => {
      const nav = document.getElementById('rail');
      const query = nav.querySelectorAll.bind(nav);
      window.__railTickCalls = 0;
      nav.querySelectorAll = (selectors) => {
        if (selectors === '[data-control]') { window.__railTickCalls += 1; }
        return query(selectors);
      };
      window.__railWhen = document.querySelector('[data-control="rail:s1"] .railwhen').textContent;
    })()`);
    // The clock moves far enough to reword an age, which is a tick that reached the rows.
    await page.clock.setFixedTime(FIXTURE_CLOCK + 10 * 60_000);
    await page.waitForFunction(
      `document.querySelector('[data-control="rail:s1"] .railwhen').textContent !== window.__railWhen`,
      undefined,
      { timeout: 5_000 },
    );
    assert.equal(
      await page.evaluate('window.__railTickCalls'),
      0,
      'the ticker reads every control in the rail once for every mounted row',
    );
    assert.equal(
      await page.locator('[data-control="rail:s3"]').count(),
      0,
      'the ticker mounts a folded cache row while checking its clock',
    );

    await page.locator('[data-bucket="railarchived"]').click();
    const controls = await page.locator('[data-bucket="railarchived"]').getAttribute('aria-controls');
    assert.ok(controls);
    for (const id of controls.split(' ')) {
      assert.equal(await page.locator(`#${id}`).count(), 1, `the disclosure names missing row ${id}`);
    }
    await page.evaluate(`(() => {
      document.querySelector('[data-control="rail:s3"]').focus();
      document.querySelector('[data-bucket="railarchived"]').click();
    })()`);
    assert.equal(await page.evaluate(`document.activeElement.dataset.bucket`), 'railarchived');

    // Removing the focused s2 row returns focus to its saved view heading.

    await page.locator('[data-control="rail:s2"]').focus();
    const removed = initial.rail.filter((card) => card.id !== 's2');
    await page.evaluate(`window.postMessage(${JSON.stringify(railMessage(initial, removed))}, '*')`);
    await page.evaluate(SETTLED);
    assert.equal(await page.evaluate(`document.activeElement.closest('[data-bucket]').dataset.bucket`), RELEASE_VIEW);
  } finally {
    await browser.close();
  }
});

test('selection deferral draws only the latest accepted rail state on release', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so the rail page was not measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const initial = payload();
    await openPage(page, initial);
    const original = initial.rail.find((card) => card.id === 's1')?.label;
    // The card the reader is selecting text in, named by its section. s1 is drawn under both
    // saved views it matches, and the selection is made in one of those two cards.
    const selected = inSection(COMPOSER_VIEW, 'rail:s1');
    await page.evaluate(`(() => {
      const text = document.querySelector('${selected} .railname').firstChild;
      const range = document.createRange();
      range.selectNodeContents(text);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      window.__selectedRailRow = document.querySelector('${selected}');
    })()`);
    const first = initial.rail.map((card) => (card.id === 's1' ? { ...card, label: 'First accepted' } : card));
    const second = initial.rail.map((card) => (card.id === 's1' ? { ...card, label: 'Latest accepted' } : card));
    await page.evaluate(`window.postMessage(${JSON.stringify(railMessage(initial, first))}, '*')`);
    await page.evaluate(`window.postMessage(${JSON.stringify(railMessage(initial, second))}, '*')`);
    await page.evaluate(SETTLED);
    assert.equal(await page.locator(`${selected} .railname`).textContent(), original);
    await page.evaluate(
      `(() => { getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); })()`,
    );
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await page.evaluate(`({
      text: document.querySelector('${selected} .railname').textContent,
      same: document.querySelector('${selected}') === window.__selectedRailRow,
    })`),
      { text: 'Latest accepted', same: true },
    );
  } finally {
    await browser.close();
  }
});

test('pin responses scroll once while background rail updates retain scroll', { timeout: 60_000 }, async (t) => {
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
    await openPage(page, initial);
    await page.setViewportSize({ width: 1350, height: 320 });
    await page.evaluate(SETTLED);
    const scroll = await page.locator('#rail').evaluate((node) => {
      node.scrollTop = Math.min(240, node.scrollHeight - node.clientHeight);
      return node.scrollTop;
    });
    assert.ok(scroll > 0);
    await page.evaluate(`(() => {
      const rail = document.querySelector('#rail');
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
      window.__railScrollWrites = [];
      Object.defineProperty(rail, 'scrollTop', {
        configurable: true,
        get() { return descriptor.get.call(this); },
        set(value) { window.__railScrollWrites.push(value); descriptor.set.call(this, value); },
      });
    })()`);
    const changed = initial.rail.map((card) => (card.id === 's2' ? { ...card, label: 'Background update' } : card));
    await page.evaluate(`window.postMessage(${JSON.stringify(railMessage(initial, changed))}, '*')`);
    await page.evaluate(SETTLED);
    assert.equal(await page.locator('#rail').evaluate((node) => node.scrollTop), scroll);
    assert.deepEqual(
      await page.evaluate(`window.__railScrollWrites`),
      [],
      'an ordinary Rail draw assigned the preserved scroll offset',
    );

    await page.locator('[data-control="railpin:s20"]').click();
    assert.ok(
      await page.evaluate(`window.__posted.some((message) => message.type === 'sessionMembership'
      && message.action === 'pin' && message.session === 's20')`),
    );
    const pinned = changed.map((card) => (card.id === 's20' ? { ...card, pinnedTop: true } : card));
    await page.evaluate(`window.postMessage(${JSON.stringify(railMessage(initial, pinned))}, '*')`);
    await page.evaluate(SETTLED);
    assert.equal(await page.locator('#rail').evaluate((node) => node.scrollTop), 0);
    assert.deepEqual(
      await page.evaluate(`window.__railScrollWrites`),
      [0],
      'a pin-to-top Rail draw did not synchronously assign zero',
    );

    const afterPin = await page.locator('#rail').evaluate((node) => {
      node.scrollTop = Math.min(180, node.scrollHeight - node.clientHeight);
      return node.scrollTop;
    });
    assert.ok(afterPin > 0);
    await page.evaluate(`window.__railScrollWrites = []`);
    const later = pinned.map((card) => (card.id === 's3' ? { ...card, label: 'Later update' } : card));
    await page.evaluate(`window.postMessage(${JSON.stringify(railMessage(initial, later))}, '*')`);
    await page.evaluate(SETTLED);
    assert.equal(await page.locator('#rail').evaluate((node) => node.scrollTop), afterPin);
    assert.deepEqual(
      await page.evaluate(`window.__railScrollWrites`),
      [],
      'a later ordinary Rail draw assigned the preserved scroll offset',
    );
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

test('rail archive hotkeys follow the host platform', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so the rail page was not measured');
    return;
  }
  try {
    const cases = [
      { platform: 'MacIntel', key: 'Backspace', ignored: '' },
      { platform: 'MacIntel', key: 'Delete', ignored: '' },
      { platform: 'Win32', key: 'Delete', ignored: 'Backspace' },
      { platform: 'Linux x86_64', key: 'Delete', ignored: 'Backspace' },
    ];
    for (const current of cases) {
      const page = await browser.newPage();
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(String(error)));
      await page.evaluate(`Object.defineProperty(navigator, 'platform', {
        configurable: true, value: ${JSON.stringify(current.platform)}
      })`);
      await openPage(page);
      assert.equal(await page.evaluate(`navigator.platform`), current.platform);
      // Press the platform shortcut on s1's row in the Composer view.

      const card = page.locator(inSection(COMPOSER_VIEW, 'rail:s1'));
      await card.focus();
      await page.evaluate(`window.__posted = []`);
      if (current.ignored) {
        await card.press(current.ignored);
        assert.equal(
          await page.evaluate(`window.__posted.some((message) => message.type === 'sessionMembership')`),
          false,
        );
      }
      await card.press(current.key);
      assert.deepEqual(
        await page.evaluate(`window.__posted.filter((message) => message.type === 'sessionMembership')`),
        [{ type: 'sessionMembership', action: 'archive', session: 's1' }],
      );
      assert.deepEqual(failures, []);
    }
  } finally {
    await browser.close();
  }
});

test('sash, responsive focus and the shared roving stop stay coordinated', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so the rail page was not measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await openPage(page);
    const sash = await page.locator('#railsash').boundingBox();
    const before = await page.locator('#rail').evaluate((node) => node.getBoundingClientRect().width);
    assert.ok(sash);
    await page.mouse.move(sash.x + sash.width / 2, sash.y + 20);
    await page.mouse.down();
    await page.mouse.move(sash.x + sash.width / 2 + 70, sash.y + 20);
    await page.mouse.up();
    const after = await page.locator('#rail').evaluate((node) => node.getBoundingClientRect().width);
    assert.ok(after > before, `the rail stayed at ${before}px after the sash drag`);
    assert.ok(
      await page.evaluate(`window.__posted.some((message) => message.type === 'saveState'
      && message.state.railWidth > ${before})`),
    );

    await page.locator('.railfilter').focus();
    await page.setViewportSize({ width: 600, height: 900 });
    // The rail answers the width media query's change event, which can land after the next frames.
    await page.waitForFunction(`document.getElementById('rail').hidden`);
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await page.evaluate(`(() => ({
      hidden: document.getElementById('rail').hidden,
      focusInRail: document.getElementById('rail').contains(document.activeElement),
      compact: !document.querySelector('.controls').closest('[hidden]'),
      stops: [...document.querySelectorAll('.session, .sessionlabelact, .head:not(.livehead):not(.statichead), .statdetail, .result, .cliveoff, .cwaitingact, .railcard, .railact, .railfold')]
        .filter((node) => node.tabIndex === 0 && !node.closest('[hidden]')).length,
    }))()`),
      { hidden: true, focusInRail: false, compact: true, stops: 1 },
    );
  } finally {
    await browser.close();
  }
});

test('the current-session highlight follows the reader past a held selection', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so the rail page was not measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const initial = payload();
    await openPage(page, initial);
    const current = `(() => [...new Set([...document.querySelectorAll('.is-current')]
      .map((node) => {
        const holder = node.dataset.control ? node : node.closest('[data-control]') || node.querySelector('[data-control]');
        return holder ? holder.dataset.control : node.className;
      }))].sort())()`;
    assert.deepEqual(
      await page.evaluate(current),
      ['rail:s1'],
      'the rail does not mark the session the fixture is showing',
    );

    const selected = inSection(COMPOSER_VIEW, 'rail:s1');
    await page.evaluate(`(() => {
      const text = document.querySelector('${selected} .railname').firstChild;
      const range = document.createRange();
      range.selectNodeContents(text);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    })()`);
    const moved = initial.rail.map((card) => ({ ...card, current: card.id === 's2' }));
    await page.evaluate(`window.postMessage(${JSON.stringify(railMessage(initial, moved))}, '*')`);
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await page.evaluate(current),
      ['rail:s2'],
      'the highlight stayed on the session the reader left while their selection was alive',
    );
  } finally {
    await browser.close();
  }
});

test('a session change nobody asked for keeps the rows under a live drag', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so the rail page was not measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const initial = payload();
    await openPage(page, initial);
    const current = `(() => [...new Set([...document.querySelectorAll('.is-current')]
      .map((node) => {
        const holder = node.dataset.control ? node : node.closest('[data-control]') || node.querySelector('[data-control]');
        return holder ? holder.dataset.control : node.className;
      }))].sort())()`;
    assert.deepEqual(
      await page.evaluate(current),
      ['rail:s1'],
      'the rail does not mark the session the fixture is showing',
    );

    // Selection defers session list replacement during a session change from the prompt box, a reveal command, or another host window.

    const selected = inSection(COMPOSER_VIEW, 'rail:s1');
    await page.evaluate(`(() => {
      const name = document.querySelector('${selected} .railname');
      name.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      const range = document.createRange();
      range.selectNodeContents(name.firstChild);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    })()`);
    const moved = initial.rail.map((card) => ({ ...card, current: card.id === 's2' }));
    await page.evaluate(`window.postMessage(${JSON.stringify(railMessage(initial, moved))}, '*')`);
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await page.evaluate(current),
      ['rail:s1'],
      'the rail redrew the rows the reader was dragging across',
    );

    await page.evaluate(`(() => {
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      getSelection().removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
    })()`);
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await page.evaluate(current),
      ['rail:s2'],
      'the highlight stayed behind after the drag ended and the selection went',
    );
  } finally {
    await browser.close();
  }
});

// Show settings remove whole groups and update header figures to match the visible session list.

test('the Show rows take a bucket out of the rail and out of every figure', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so the Show rows were not measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(String(error)));
    const running = new Map([
      ['s1', 'running'],
      ['s2', 'running'],
      ['s4', 'running'],
    ] as const);
    const shown = payload(['s1'], [], ['s4'], [], [], [], running);
    await openPage(page, shown, undefined, { railFilter: '' });
    const buckets = async () =>
      (await page.evaluate(
        `[...document.querySelectorAll('#rail .railfold')].map((head) => head.closest('[data-bucket]').dataset.bucket)`,
      )) as string[];
    // The Running count never counts an archived session or an agent run, so it reads s2 alone
    // whichever buckets the Show rows draw.
    const runningName = async () => await page.locator('[data-control="railcount:running"]').getAttribute('aria-label');
    const ticks = async () =>
      (await page.evaluate(`['archived', 'runs'].map((bucket) =>
          document.querySelector('[data-control="railshow:' + bucket + '"]').checked)`)) as boolean[];

    assert.equal(
      await runningName(),
      'Running, 1 session',
      'the Running count holds more than s2, though s1 is archived and s4 is an agent run',
    );
    assert.ok((await buckets()).includes('railarchived'), 'the fixture drew no Archived bucket');
    assert.ok((await buckets()).includes('railruns'), 'the fixture drew no Run by agents bucket');

    await page.locator('[data-control="railfilters"]').click();
    await page.evaluate(SETTLED);
    assert.deepEqual(await ticks(), [true, true], 'the Show rows do not start on');

    await page.locator('[data-control="railshow:archived"]').click();
    await page.evaluate(SETTLED);
    assert.ok(!(await buckets()).includes('railarchived'), 'the Archived bucket stayed after its row went off');
    assert.equal(
      await runningName(),
      'Running, 1 session',
      'the Running count moved with the Archived bucket, which it never counts',
    );

    await page.locator('[data-control="railshow:runs"]').click();
    await page.evaluate(SETTLED);
    assert.ok(!(await buckets()).includes('railruns'), 'the Run by agents bucket stayed after its row went off');
    assert.equal(
      await runningName(),
      'Running, 1 session',
      'the Running count moved with the Run by agents bucket, which it never counts',
    );
    assert.deepEqual(await ticks(), [false, false], 'the Show rows do not report what they did');

    await page.locator('[data-control="railshow:archived"]').click();
    await page.evaluate(SETTLED);
    assert.ok((await buckets()).includes('railarchived'), 'the Archived bucket did not come back');
    assert.equal(
      await runningName(),
      'Running, 1 session',
      'the Running count moved when the Archived bucket came back',
    );

    // The choice is rail state, so a panel that loaded with the bucket off opens with it off.
    const restored = await browser.newPage();
    restored.on('pageerror', (error) => failures.push(String(error)));
    await openPage(restored, shown, undefined, { railFilter: '', railShowRuns: false });
    const restoredBuckets = (await restored.evaluate(
      `[...document.querySelectorAll('#rail .railfold')].map((head) => head.closest('[data-bucket]').dataset.bucket)`,
    )) as string[];
    assert.ok(!restoredBuckets.includes('railruns'), 'a panel loaded with Run by agents off drew the bucket anyway');
    assert.equal(
      await restored.locator('[data-control="railcount:running"]').getAttribute('aria-label'),
      'Running, 1 session',
      'a panel loaded with Run by agents off lost s2 from the Running count',
    );

    // Forget State restores both Show settings and their groups.

    await page.evaluate(`window.postMessage({ type: 'forgetState', since: 0 }, '*')`);
    await page.evaluate(SETTLED);
    await page.locator('[data-control="railfilters"]').click();
    await page.evaluate(SETTLED);
    assert.deepEqual(await ticks(), [true, true], 'the forgotten panel kept a Show row off');
    assert.ok(
      (await buckets()).includes('railruns'),
      'the Run by agents bucket stayed away from a panel that had forgotten everything',
    );

    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

// Quick filters choices persist. Forget State restores defaults. Legacy choices without Running enable it during normalization.

test(
  'a restored panel keeps its unticked head lenses and Forget State ticks them again',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so the head lens choice was not measured');
      return;
    }
    try {
      const page = await browser.newPage();
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(String(error)));
      await openPage(page, payload(), FIXTURE_CLOCK, { railFilter: '', railQuickFilters: [] });
      assert.equal(await page.locator('.railcount').count(), 0, 'a panel loaded with no lens ticked drew a count');
      await page.evaluate(`window.postMessage({ type: 'forgetState', since: 0 }, '*')`);
      await page.evaluate(SETTLED);
      assert.equal(
        await page.locator('[data-control="railcount:active"]').count(),
        1,
        'the forgotten panel kept the Active count off the head',
      );
      await page.locator('[data-control="railfilters"]').click();
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.evaluate(
          `[...document.querySelectorAll('[data-control^="railheadlens:"]')].map((box) => box.checked)`,
        ),
        [true, true, false, true],
        'the forgotten panel did not return to Running, Active and Needs input',
      );
      const legacy = await browser.newPage();
      legacy.on('pageerror', (error) => failures.push(String(error)));
      await openPage(legacy, payload([], [], [], [], [], [], new Map([['s2', 'running']])), FIXTURE_CLOCK, {
        railFilter: '',
        railHeadLenses: [],
      });
      assert.deepEqual(
        await legacy.evaluate(`[...document.querySelectorAll('.railcount')].map((node) => node.dataset.control)`),
        ['railcount:running'],
        'a panel stored with no lens ticked before the Running lens lost its running figure',
      );
      assert.deepEqual(failures, []);
    } finally {
      await browser.close();
    }
  },
);

// Group by persists the grouping choice and removes redundant agent labels beneath agent headings.

test('a Group by press regroups the rail and a restored panel opens grouped', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so the Group by row was not measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(String(error)));
    const shown = payload(['s1'], [], ['s4']);
    await openPage(page, shown, undefined, { railFilter: '' });
    const buckets = async (on = page) =>
      (await on.evaluate(
        `[...document.querySelectorAll('#rail .railfold')].map((head) => head.closest('[data-bucket]').dataset.bucket)`,
      )) as string[];
    const agentWords = async () =>
      (await page.evaluate(
        `[...document.querySelectorAll('#rail .railrow[data-rail-bucket^="railgroup:agent:"] .railagent')].length`,
      )) as number;

    await page.locator('[data-control="railfilters"]').click();
    await page.evaluate(SETTLED);
    assert.equal(await page.locator('[data-control="railgroupby:time"]').getAttribute('aria-checked'), 'true');
    await page.locator('[data-control="railgroupby:agent"]').click();
    await page.evaluate(SETTLED);
    assert.equal(await page.locator('[data-control="railgroupby:agent"]').getAttribute('aria-checked'), 'true');
    const agentHeads = (await buckets()).filter((id) => id.startsWith('railgroup:agent:'));
    assert.ok(agentHeads.length > 0, 'a press on Agent drew no agent heading');
    assert.ok(!(await buckets()).includes('railtoday'), 'a press on Agent kept the time buckets');
    assert.ok((await page.locator('#rail .railrow[data-rail-bucket^="railgroup:agent:"]').count()) > 0);
    assert.equal(await agentWords(), 0, 'a row under an agent heading still says the agent');

    const restored = await browser.newPage();
    restored.on('pageerror', (error) => failures.push(String(error)));
    await openPage(restored, shown, undefined, { railFilter: '', railGroupBy: 'agent' });
    assert.deepEqual(
      (await buckets(restored)).filter((id) => id.startsWith('railgroup:agent:')),
      agentHeads,
      'a panel loaded grouped by agent drew another grouping',
    );
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

// The Rows value changes the layout through `data-density` and the age through the renderer,
// and the accessible name stays the same string, so a screen reader hears no difference.
test(
  'a Rows press draws compact rows with the short age, and a restored panel opens compact',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so the Rows row was not measured');
      return;
    }
    try {
      const page = await browser.newPage();
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(String(error)));
      const shown = payload(
        ['s1'],
        [],
        ['s4'],
        [],
        [],
        [],
        new Map([
          ['s6', 'failed'],
          ['s7', 'subagents'],
        ]),
        new Map(),
        [],
        new Map([['s7', 2]]),
      );
      // The lower-bound cost fixture has a warning and a detailed explanation. Its hover omits the explanation.

      const partialDetail = 'Some usage could not be priced in 2 of 41 turns, so the estimated total may be low.';
      shown.stats = {
        ...shown.stats,
        s2: [
          {
            metric: 'cost',
            compactLabel: '$12.40+',
            kind: 'plain',
            label: '$12.40+',
            detail: partialDetail,
            partialDetail,
            warnings: [{ scope: 'main' }],
          },
          ...(shown.stats.s2 as unknown[]),
        ],
      };
      await openPage(page, shown, FIXTURE_CLOCK, { railFilter: '' });
      type Drawn = {
        density: string;
        names: string[];
        ages: { session: string; at: number; text: string }[];
        saved: unknown;
        // The computed display of each drawn figure line, label line and agent word.
        dropped: Record<string, string[]>;
        hint: string | null;
      };
      const read = async (on = page): Promise<Drawn> =>
        (await on.evaluate(`(() => ({
        density: document.getElementById('rail').dataset.density,
        names: [...document.querySelectorAll('#rail .railcard')].map((card) => card.getAttribute('aria-label')),
        ages: [...document.querySelectorAll('#rail .railwhen:not([hidden])')].map((node) => ({
          session: node.closest('.railcard').dataset.session,
          at: Number(node.dataset.at),
          text: node.textContent,
        })),
        saved: window.__posted.filter((message) => message.type === 'saveState').at(-1)?.state?.railDensity,
        dropped: Object.fromEntries(['.railstats', '.raillabels', '.railagent'].map((part) => [
          part,
          [...document.querySelectorAll('#rail .railcard ' + part + ':not([hidden])')].map((node) => getComputedStyle(node).display),
        ])),
        hint: document.querySelector('[data-control="rail:s2"]').getAttribute('data-hint'),
      }))()`)) as Drawn;
      const checked = async (value: string, on = page) =>
        on.locator(`[data-control="raildensity:${value}"]`).getAttribute('aria-checked');
      const described = async (session: string) =>
        (await page.evaluate(`(() => {
          const card = document.querySelector('[data-control="rail:${session}"]');
          card.focus();
          const name = card.getAttribute('aria-label') || '';
          const detail = card.getAttribute('data-hint-detail') || '';
          const ids = (card.getAttribute('aria-describedby') || '').split(' ').filter(Boolean);
          return {
            name,
            detail,
            ids,
            described: ids.length ? ids.map((id) => document.getElementById(id)?.textContent || '').join(' ') : null,
          };
        })()`)) as { name: string; detail: string; ids: string[]; described: string | null };

      const comfortable = await read();
      assert.equal(comfortable.density, 'comfortable');
      // Full rows link the visible subagent-state detail when no words are hidden.

      const comfortableSubagents = await described('s7');
      assert.deepEqual(
        comfortableSubagents.ids,
        ['hintdetail'],
        'a comfortable subagents card did not link its visible detail',
      );
      assert.equal(comfortableSubagents.described, subagentsHintDetail(2));
      await page.evaluate('document.activeElement.blur()');
      for (const [part, displays] of Object.entries(comfortable.dropped)) {
        assert.ok(displays.length && !displays.includes('none'), `a comfortable row hid its ${part}`);
      }
      assert.equal(comfortable.hint, null, 'a comfortable card in no special state gained a hover');
      await page.locator('[data-control="railfilters"]').click();
      await page.evaluate(SETTLED);
      assert.equal(await checked('comfortable'), 'true');
      await page.locator('[data-control="raildensity:compact"]').click();
      await page.evaluate(SETTLED);
      assert.equal(await checked('compact'), 'true');
      assert.equal(await checked('comfortable'), 'false');
      const compact = await read();
      assert.equal(compact.density, 'compact', 'a press on Compact left the rail comfortable');
      assert.equal(compact.saved, 'compact', 'the next saved state did not carry the density');
      assert.deepEqual(compact.names, comfortable.names, 'a card changed its accessible name with the density');
      assert.ok(compact.ages.length > 0, 'no compact row drew an age');
      for (const age of compact.ages) {
        assert.equal(age.text, formatRelativeShort(age.at, FIXTURE_CLOCK), `${age.session} drew the long age`);
      }
      for (const [part, displays] of Object.entries(compact.dropped)) {
        assert.ok(displays.length && displays.every((display) => display === 'none'), `a compact row drew its ${part}`);
      }
      assert.ok(compact.hint, 'a compact card had no hover for the figures, labels and agent word it drops');

      // Compact rows link only descriptions absent from their accessible names. Plain rows have none. Subagent rows retain their state explanation.

      const plainCard = await described('s2');
      assert.equal(plainCard.described, null, 'a compact card with only dropped words kept a linked description');
      // Compact row hints show the row's figures and cost warning without the detailed cost explanation.

      const hoverCard = (await page.evaluate(`(() => {
        const pop = document.getElementById('hintpop');
        const card = document.querySelector('[data-control="rail:s2"]');
        const body = pop.querySelector('.hintbody');
        return {
          open: !pop.hidden && pop.classList.contains('hintcard'),
          name: body.querySelector('.hintname')?.textContent ?? null,
          drawn: card.querySelector('.railname').textContent,
          titleHidden: pop.querySelector('.hinttitle').hidden,
          figures: body.querySelectorAll('.railstats .railstatchip').length,
          rowFigures: card.querySelectorAll('.railstats .railstatchip').length,
          signed: !!body.querySelector('.railstats .railstatchip[data-metric="cost"] .statwarningsign'),
          // The Cost, Turns and Context table the figure line replaced.
          tableNodes: body.querySelectorAll('ul, li, .hintfigs, .chippopitemhead, .chippopvalue, .chippoplabel').length,
          text: body.textContent,
        };
      })()`)) as {
        open: boolean;
        name: string | null;
        drawn: string;
        titleHidden: boolean;
        figures: number;
        rowFigures: number;
        signed: boolean;
        tableNodes: number;
        text: string;
      };
      assert.ok(hoverCard.open, 'a focused compact card did not open its hover card');
      assert.equal(hoverCard.name, hoverCard.drawn);
      assert.ok(hoverCard.titleHidden, 'the plain title showed beside the hover card');
      assert.equal(hoverCard.rowFigures, 2, 'the fixture row did not carry its cost and context figures');
      assert.equal(hoverCard.figures, hoverCard.rowFigures, 'the hover card did not draw the row figure line');
      assert.ok(hoverCard.signed, 'the hover card cost lost its warning sign');
      assert.equal(hoverCard.tableNodes, 0, 'the hover card drew the figure table beside the figure line');
      assert.ok(!hoverCard.text.includes(partialDetail), hoverCard.text);

      const busyCard = await described('s7');
      assert.ok(busyCard.name.includes('Claude'), busyCard.name);
      assert.ok(busyCard.detail.includes('Claude'), busyCard.detail);
      assert.deepEqual(busyCard.ids, ['hintdescription'], 'a compact subagents card did not link the hidden node');
      assert.equal(busyCard.described, subagentsHintDetail(2), busyCard.described ?? '');
      assert.ok(!(busyCard.described ?? '').includes('Claude'), busyCard.described ?? '');

      // Moving the hint to another control moves its description link. The hidden detail node clears when the new control uses visible detail.

      await page.evaluate(`(() => {
        const from = document.querySelector('[data-control="rail:s7"]');
        const to = document.querySelector('[data-control="railfilters"]');
        from.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: to }));
        to.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, relatedTarget: from }));
      })()`);
      const movedHint = (await page.evaluate(`(() => {
        const trigger = document.querySelector('[data-control="railfilters"]');
        const ids = (trigger.getAttribute('aria-describedby') || '').split(' ').filter(Boolean);
        return { ids, hiddenText: document.getElementById('hintdescription').textContent };
      })()`)) as { ids: string[]; hiddenText: string };
      assert.deepEqual(movedHint.ids, ['hintdetail'], 'a control with only a visible detail linked the hidden node');
      assert.equal(
        movedHint.hiddenText,
        '',
        'the hidden description node kept the previous card state explanation after the hint moved',
      );

      // Closing the hint removes the description link entirely.
      await page.evaluate(`(() => {
        document.querySelector('[data-control="railfilters"]').dispatchEvent(
          new PointerEvent('pointerout', { bubbles: true }),
        );
      })()`);
      assert.equal(
        await page.evaluate(`document.querySelector('[data-control="railfilters"]').getAttribute('aria-describedby')`),
        null,
        'closing the hint left the description link in place',
      );
      await page.evaluate('document.activeElement.blur()');

      // A failed row keeps its word, and the word comes before the age.
      assert.ok(
        await page.evaluate(`(() => {
          const card = document.querySelector('[data-control="rail:s6"]');
          const status = card.querySelector('.railstatus');
          const when = card.querySelector('.railwhen:not([hidden])');
          return !!status.textContent.trim() && !!when?.textContent.trim() &&
            !!(status.compareDocumentPosition(when) & Node.DOCUMENT_POSITION_FOLLOWING);
        })()`),
        'the failed compact row lost its word or drew it after the age',
      );

      // A focused row control hides the metadata it is drawn over, the way a hover does.
      await page.keyboard.press('Shift');
      await page.locator('[data-control="railpin:s2"]').focus();
      assert.deepEqual(
        await page.evaluate(`(() => {
          const pin = document.querySelector('[data-control="railpin:s2"]');
          return [pin.matches(':focus-visible'), getComputedStyle(pin.closest('.railrow').querySelector('.railmeta')).visibility];
        })()`),
        [true, 'hidden'],
        'a focused row control left the compact metadata under it',
      );
      await page.evaluate('document.activeElement.blur()');

      // A tick across a step boundary rewrites the short age.
      const later = FIXTURE_CLOCK + 60 * 60_000;
      const moved = compact.ages.find((age) => formatRelativeShort(age.at, later) !== age.text);
      assert.ok(moved, 'no drawn age crosses a step within the hour');
      await page.clock.setFixedTime(later);
      await page.waitForFunction(
        `document.querySelector('[data-control="rail:${moved.session}"] .railwhen')?.textContent === ${JSON.stringify(formatRelativeShort(moved.at, later))}`,
        undefined,
        { timeout: 5_000 },
      );

      for (const [stored, expected] of [
        ['compact', 'compact'],
        ['nonsense', 'comfortable'],
      ]) {
        const restored = await browser.newPage();
        restored.on('pageerror', (error) => failures.push(String(error)));
        await openPage(restored, shown, FIXTURE_CLOCK, { railFilter: '', railDensity: stored });
        assert.equal((await read(restored)).density, expected, `a panel saved ${stored} drew ${expected} rows`);
        await restored.locator('[data-control="railfilters"]').click();
        await restored.evaluate(SETTLED);
        assert.equal(await checked(expected, restored), 'true');
      }

      // Forget State restores Full rows.
      await page.evaluate(`window.postMessage({ type: 'forgetState', since: 0 }, '*')`);
      await page.evaluate(SETTLED);
      assert.equal((await read()).density, 'comfortable', 'a forgotten panel kept compact rows');
      if (!(await page.locator('#railfilterpop').isVisible())) {
        await page.locator('[data-control="railfilters"]').click();
        await page.evaluate(SETTLED);
      }
      assert.equal(await checked('comfortable'), 'true');
      assert.deepEqual(failures, []);
    } finally {
      await browser.close();
    }
  },
);

// Header keyboard order reaches filters before the New split. The split retains the new-session shortcut.

test('the head tabs from the tools through the New split to the counts', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so the head tab order was not read');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(String(error)));
    await page.setViewportSize({ width: 1350, height: 900 });
    await page.setContent(
      themed(
        pageHtml().replace('const SAVED_STATE = {};', `const SAVED_STATE = ${JSON.stringify({ railFilter: '' })};`),
      ),
    );
    await postToPage(page, payload([], [], [], [], [], [], new Map([['s2', 'waiting']])));
    const firstCount = await page.locator('.railcount').first().getAttribute('data-control');
    await page.locator('[data-control="railsearch"]').focus();
    const reached: string[] = [];
    for (let step = 0; step < 4; step++) {
      await page.keyboard.press('Tab');
      reached.push(
        await page.evaluate(`(() => {
          const node = document.activeElement;
          return node.dataset.control || node.className;
        })()`),
      );
    }
    assert.deepEqual(
      reached,
      ['railfilters', 'railnew', 'railnewmenu', firstCount],
      'Tab from the search button does not walk the tools, the New split and then the counts',
    );
    const platform = (await page.evaluate('navigator.platform')) as string;
    assert.equal(
      await page.locator('.railnew').getAttribute('aria-keyshortcuts'),
      newSessionKeyshortcut(platform),
      'the New button no longer names the new-session shortcut',
    );
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Enter');
    assert.ok(
      await page.evaluate(`window.__posted.some((message) => message.type === 'newSession')`),
      'Enter on the New button in the head did not open a session',
    );
    assert.deepEqual(failures, [], 'the panel threw while walking the rail head');
  } finally {
    await browser.close();
  }
});

test('a count press keeps the order the reader chose in the View menu', { timeout: 60_000 }, async (t) => {
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
    const head = async () =>
      await page.evaluate(`(() => ({
        cards: [...new Set([...document.querySelectorAll('.railcard')].map((node) => node.dataset.session))],
        pressed: document.querySelector('[data-control="railcount:active"]').getAttribute('aria-pressed'),
        filter: document.querySelector('[data-control="railfilters"]').getAttribute('aria-label'),
      }))()`);
    // Sort changes under a typed query leave the default session list order unchanged.

    await page.locator('[data-control="railsearch"]').click();
    await page.evaluate(SETTLED);
    await page.locator('.railfilter').fill('is:running');
    await page.evaluate(SETTLED);
    await page.locator('[data-control="railfilters"]').click();
    await page.locator('[data-control="railfilter-order:cost-desc"]').click();
    await page.keyboard.press('Escape');
    // Emptying the text alone keeps the box on the row, so the cross closes it and gives
    // the row back to the count.
    await page.locator('.railfilter').fill('');
    await page.evaluate(SETTLED);
    await page.locator('.filterclear').click();
    await page.evaluate(SETTLED);
    await page.locator('[data-control="railcount:active"]').click();
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await head(),
      { cards: ['s1', 's2'], pressed: 'true', filter: 'View, Active, Cost, highest first' },
      'the Active press dropped the order the reader chose',
    );

    await page.locator('[data-control="railcount:active"]').click();
    await page.evaluate(SETTLED);
    assert.equal(
      ((await head()) as { filter: string }).filter,
      'View, Custom, Cost, highest first',
      'clearing the count dropped the order the reader chose',
    );
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

// Sections above 200 sessions reveal rows in pages. Show more and the final focused row must remain below the header.

test('Show more keeps its focus in view below the rail head', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so the rail page was not measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const base = payload();
    const sessions = base.sessions;
    const stats = base.stats;
    const current = 120;
    const bulk = (template: Record<string, unknown>, i: number) => ({
      ...template,
      id: `bulk${i}`,
      label: `Bulk session ${i}`,
      fullLabel: `Bulk session ${i}`,
      at: NOW - i * 1000,
    });
    const many = Array.from({ length: 401 }, (_, i) => i);
    const initial = {
      ...base,
      views: [],
      sessions: many.map((i) => ({ ...bulk(sessions[0], i), shown: i === current })),
      rail: many.map((i) => ({ ...bulk(base.rail[0], i), pinnedTop: false, current: i === current })),
      showing: `bulk${current}`,
      cards: (base.cards as Record<string, unknown>[]).map((card) => ({ ...card, sessionId: `bulk${current}` })),
      stats: Object.fromEntries(many.map((i) => [`bulk${i}`, stats[sessions[0].id as string] ?? []])),
    };
    await page.setViewportSize({ width: 1350, height: 900 });
    await page.setContent(themed(pageHtml()));
    await page.evaluate(`window.postMessage(${JSON.stringify(initial)}, '*')`);
    await page.evaluate(SETTLED);
    const bucket = (await page.evaluate(`(() => {
      const head = [...document.querySelectorAll('button.railfold[data-bucket]')].find(
        (node) =>
          node.getAttribute('aria-expanded') === 'true' &&
          (node.querySelector('.railbucketcount')?.textContent ?? '').replace(/[^0-9]/g, '') === '401',
      );
      return head ? head.dataset.bucket : null;
    })()`)) as string | null;
    assert.ok(bucket, 'no open section holds all 401 sessions');
    const drawn = (rows: number) =>
      page.waitForFunction(`document.querySelectorAll('.railrow[data-rail-bucket="${bucket}"]').length === ${rows}`);
    const target = () =>
      page.evaluate(`(() => {
        const active = document.activeElement;
        const box = active.getBoundingClientRect();
        const head = document.querySelector('.railtop').getBoundingClientRect();
        const cost = document.querySelector('.projectspendrailmount').getBoundingClientRect();
        const rail = document.getElementById('rail').getBoundingClientRect();
        return { focus: active.dataset.control ?? null, cost: cost.height > 0,
          clear: box.top >= head.bottom - 1 && box.bottom <= rail.bottom + 1 };
      })()`) as Promise<{ focus: string | null; cost: boolean; clear: boolean }>;
    await drawn(200);
    await page.locator(`.railmore[data-rail-bucket="${bucket}"]`).focus();
    await page.keyboard.press('Enter');
    await drawn(400);
    assert.deepEqual(
      await target(),
      { focus: `railmore:${bucket}`, cost: true, clear: true },
      'the press that leaves a row undrawn loses the focus or sits under the rail head',
    );
    await page.keyboard.press('Enter');
    await drawn(401);
    assert.equal(await page.locator('.railmore').count(), 0, 'the press that drew the last row stays');
    assert.deepEqual(
      await target(),
      { focus: 'rail:bulk400', cost: true, clear: true },
      'the last row the final press focuses sits under the rail head',
    );
  } finally {
    await browser.close();
  }
});
