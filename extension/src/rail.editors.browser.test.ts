// Session list label and rename editors, with their surrounding context menus.
// Shared helpers live in `../test/rail.ts`.

import { test } from 'vitest';
import assert from 'node:assert';
import type { Page } from 'playwright-core';
import { browserOrNone, SETTLED } from '../test/browser.ts';
import { LIVE_PRESS } from './panelfixture.ts';
import { CARD_ACTIONS } from './turncard.ts';
import { RAIL_MIN_WIDTH } from './view/rail.ts';
import {
  type RailCard,
  type PanelPayload,
  payload,
  COMPOSER_VIEW,
  RELEASE_VIEW,
  inSection,
  railMessage,
  openPage,
  postToPage,
} from '../test/rail.ts';

interface LabelRow {
  name: string;
  count: number;
  countName: string;
  applied: boolean;
}

const LABEL_ROWS: LabelRow[] = [
  { name: 'performance', count: 2, countName: '2 sessions', applied: true },
  { name: 'personal', count: 1, countName: '1 session', applied: false },
  { name: 'worktree parallel sessions and the rails', count: 1, countName: '1 session', applied: false },
];

async function answerLabelEditor(page: Page, session: string, rows = LABEL_ROWS): Promise<void> {
  await page.evaluate(
    `window.postMessage(${JSON.stringify({
      type: 'labelEditor',
      session,
      heading: `Labels for ${session}`,
      rows,
    })}, '*')`,
  );
  await page.evaluate(SETTLED);
}

test('label replies stay with their request and preserve the editor input', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so the rail page was not measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await openPage(page);
    await page.locator('[data-control="raillabels:s2"]').click();
    await page.locator('[data-control="sessionlabels:s1"]').click();
    await page.evaluate(`window.postMessage({ type: 'labelEditor', session: 's2', heading: 'Wrong', rows: [] }, '*')`);
    await page.evaluate(SETTLED);
    assert.equal(await page.locator('#labelpop').isHidden(), true);
    const rows = [{ name: 'performance', count: 2, countName: '2 sessions', applied: true }];
    await page.evaluate(
      `window.postMessage(${JSON.stringify({ type: 'labelEditor', session: 's1', heading: 'Labels for s1', rows })}, '*')`,
    );
    await page.evaluate(SETTLED);
    await page.evaluate(`(() => {
      const input = document.querySelector('.labelfind');
      input.value = 'per';
      input.focus();
      input.setSelectionRange(2, 2);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
      window.__labelInput = input;
    })()`);
    const refreshed = [...rows, { name: 'personal', count: 1, countName: '1 session', applied: false }];
    await page.evaluate(
      `window.postMessage(${JSON.stringify({ type: 'labelEditor', session: 's1', heading: 'Labels for s1', rows: refreshed })}, '*')`,
    );
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await page.evaluate(`(() => {
      const input = document.querySelector('.labelfind');
      return { same: input === window.__labelInput, focused: document.activeElement === input,
        value: input.value, caret: input.selectionStart,
        expanded: document.querySelector('[data-control="sessionlabels:s1"]').getAttribute('aria-expanded') };
    })()`),
      { same: true, focused: true, value: 'per', caret: 2, expanded: 'true' },
    );
    assert.deepEqual(await page.locator('#labelpop .labelname').allTextContents(), ['performance', 'personal']);
  } finally {
    await browser.close();
  }
});

// Adoption replaces the provisional session id with its durable id. The new heading gains turn figures and changes height.

function draftAdoption(): { draft: PanelPayload; adopted: PanelPayload } {
  const durable = payload([], [LIVE_PRESS]);
  const draft = JSON.parse(JSON.stringify(durable).replaceAll('"s1"', '"draft:s1"')) as PanelPayload;
  draft.cards = (draft.cards as Array<{ sessionId: string }>).filter((card) => card.sessionId !== 'draft:s1');
  // A draft has run no turn, so its heading carries no figures.
  delete draft.stats['draft:s1'];
  const adopted = { ...durable, sessionAdoptions: [{ provisional: 'draft:s1', durable: 's1' }] } as PanelPayload;
  return { draft, adopted };
}

// Measure the label editor against its session heading's Labels button.

async function labelEditorPlace(page: Page, session: string): Promise<Record<string, unknown>> {
  return (await page.evaluate(`(() => {
    const button = document.querySelector('[data-control="sessionlabels:${session}"]');
    const at = button.getBoundingClientRect();
    const row = (button.closest('.sessionrow') || button).getBoundingClientRect();
    const pop = document.getElementById('labelpop');
    const box = pop.getBoundingClientRect();
    return { hidden: pop.hidden, under: Math.abs(box.top - (row.bottom + 4)) < 1,
      beside: box.left <= at.left && box.right >= at.right, expanded: button.getAttribute('aria-expanded') };
  })()`)) as Record<string, unknown>;
}

const PLACED = { hidden: false, under: true, beside: true, expanded: 'true' };

test(
  'the label editor opened on an empty draft heading stays under it when the draft takes its durable id',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so the rail page was not measured');
      return;
    }
    try {
      const page = await browser.newPage();
      const { draft, adopted } = draftAdoption();
      await openPage(page, draft);
      await page.locator('[data-control="sessionlabels:draft:s1"]').click();
      await answerLabelEditor(page, 'draft:s1');
      assert.deepEqual(await labelEditorPlace(page, 'draft:s1'), PLACED);
      await page.locator('.labelfind').pressSequentially('pers');
      await page.evaluate(`window.__labelInput = document.querySelector('.labelfind')`);

      for (const width of [600, 1000]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(SETTLED);
        assert.deepEqual(
          await page.evaluate(`(() => {
          const input = document.querySelector('.labelfind');
          return { same: input === window.__labelInput, focused: document.activeElement === input,
            value: input.value, caret: input.selectionStart,
            expanded: document.querySelector('[data-control="sessionlabels:draft:s1"]').getAttribute('aria-expanded') };
        })()`),
          { same: true, focused: true, value: 'pers', caret: 4, expanded: 'true' },
        );
      }

      // Check placement immediately after adoption.
      await postToPage(page, adopted);
      assert.deepEqual(await labelEditorPlace(page, 's1'), PLACED);
      assert.deepEqual(
        await page.evaluate(`(() => {
          const input = document.querySelector('.labelfind');
          return { same: input === window.__labelInput, focused: document.activeElement === input,
            value: input.value, caret: input.selectionStart };
        })()`),
        { same: true, focused: true, value: 'pers', caret: 4 },
      );

      // The host can still answer under the draft id after the page adopted it.
      await postToPage(page, {
        type: 'labelEditor',
        session: 'draft:s1',
        heading: 'Labels for the durable s1',
        rows: LABEL_ROWS,
      });
      assert.equal(await page.locator('#labelpop').getAttribute('aria-label'), 'Labels for the durable s1');

      await page.evaluate(`window.__posted = []`);
      await page.locator('#labelpop input[data-control="label:personal"]').click();
      assert.deepEqual(await page.evaluate(`window.__posted.filter((message) => message.type === 'setLabels')`), [
        { type: 'setLabels', session: 's1', names: ['performance', 'personal'] },
      ]);

      await page.evaluate(`window.__posted = []`);
      await page.locator('[data-control="sessionlabels:s1"]').click();
      assert.equal(await page.locator('#labelpop').isHidden(), true);
      assert.deepEqual(await page.evaluate(`window.__posted.filter((message) => message.type === 'labelEditor')`), []);
    } finally {
      await browser.close();
    }
  },
);

test(
  'New session with the same labels is offered from a labeled turn card, session heading, and rail card, and each arms its panel',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so the rail page was not measured');
      return;
    }
    try {
      const page = await browser.newPage();
      const initial = payload();
      await openPage(page, initial);
      const turn = (initial.cards as { kind: string; sessionId: string; key: string }[]).find(
        (card) => card.kind === 'turn' && card.sessionId === 's1',
      );
      assert.ok(turn, 'the fixture draws no turn card for s1');
      // The editor merges the context of the node under the pointer with its ancestors', the
      // nearest one winning, so each place is read the same way.
      const places = async () =>
        page.evaluate(`(() => {
        const merged = (node) => {
          const out = {};
          for (let at = node; at; at = at.parentElement) {
            const raw = at.dataset && at.dataset.vscodeContext;
            if (!raw) { continue; }
            for (const [name, value] of Object.entries(JSON.parse(raw))) { if (!(name in out)) { out[name] = value; } }
          }
          return out;
        };
        const card = document.querySelector('main#list .turn[data-key=${JSON.stringify(turn.key)}]');
        const nodes = {
          turnHead: card.querySelector('.head'),
          turnBody: card.querySelector('.body'),
          heading: document.querySelector('main#list .sessionrow[data-session="s1"]'),
          rail: document.querySelector('[data-control="rail:s1"]'),
        };
        return Object.fromEntries(Object.entries(nodes).map(([place, node]) => {
          window.__posted = [];
          node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
          const context = merged(node);
          return [place, {
            labeled: context.sessionLabeled === true, session: context.session, key: 'key' in context,
            armed: window.__posted.filter((message) => message.type === 'armSessionDetails').map((message) => message.session),
          }];
        }));
      })()`);
      const armed = { labeled: true, session: 's1', armed: ['s1'] };
      assert.deepEqual(
        await places(),
        {
          turnHead: { ...armed, key: true },
          turnBody: { ...armed, key: true },
          heading: { ...armed, key: false },
          rail: { ...armed, key: false },
        },
        'a place over a labeled session does not offer the entry, or does not arm the panel that drew its menu',
      );

      // Removing the last label clears every context, including retained turn cards.
      const unlabeled = initial.rail.map((card) => (card.id === 's1' ? { ...card, labels: [] } : card));
      await postToPage(page, railMessage(initial, unlabeled));
      const cleared = { labeled: false, session: 's1', armed: ['s1'] };
      assert.deepEqual(
        await places(),
        {
          turnHead: { ...cleared, key: true },
          turnBody: { ...cleared, key: true },
          heading: { ...cleared, key: false },
          rail: { ...cleared, key: false },
        },
        'a place kept offering the entry after its session lost its last label',
      );

      // The first label comes back, and the entry with it.
      await postToPage(page, railMessage(initial, initial.rail));
      assert.equal(
        Object.values((await places()) as Record<string, { labeled: boolean }>).every((place) => place.labeled),
        true,
        'a place did not offer the entry again after its session regained a label',
      );

      // Render and selection payloads update labels on retained turn cards.
      await postToPage(page, { ...initial, rail: unlabeled });
      const heldCard = async () => ((await places()) as Record<string, { labeled: boolean }>).turnBody.labeled;
      assert.equal(await heldCard(), false, 'a render that took the last label left the entry on a turn card');
      const full = initial as unknown as Record<string, unknown>;
      await postToPage(page, {
        type: 'selection',
        cards: full.cards,
        sessions: full.sessions,
        rail: initial.rail.filter((card) => card.id === 's1'),
        stats: initial.stats,
        replaces: ['s1'],
        showing: full.showing,
        olderHistory: full.olderHistory ?? null,
        diagnosis: full.diagnosis ?? null,
        usage: full.usage,
        startup: full.startup ?? null,
      });
      assert.equal(await heldCard(), true, 'a selection that brought a label back left the entry off a turn card');
    } finally {
      await browser.close();
    }
  },
);

test(
  'Show session details opens from a rail card for a session the timeline is not showing, and returns focus to the card',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so the rail page was not measured');
      return;
    }
    try {
      const page = await browser.newPage();
      // The fixture draws s1 in the timeline. s2 appears only in the session list and session rows.

      await openPage(page);
      await page.evaluate(`window.__posted = []`);
      await page.evaluate(`(() => {
      const card = document.querySelector('[data-control="rail:s2"]');
      card.focus();
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    })()`);
      assert.deepEqual(
        await page.evaluate(`window.__posted.filter((message) => message.type === 'armSessionDetails')`),
        [{ type: 'armSessionDetails', session: 's2' }],
        'a right-click on a rail card for a session the timeline is not showing did not arm the native menu',
      );

      // Reply to the panel that requested session details.

      await postToPage(page, { type: 'showSessionDetails', session: 's2' });
      const opened = (await page.evaluate(`(() => {
      const dialog = document.getElementById('sessiondetails');
      const values = [...dialog.querySelectorAll('.sessiondetailsvalue')].map((node) => node.textContent);
      return { hidden: dialog.hidden, sessionId: values[2], command: values[3] };
    })()`)) as { hidden: boolean; sessionId: string; command: string };
      // Session details builds the resume command from the row's agent key and id.

      assert.deepEqual(
        opened,
        { hidden: false, sessionId: 's2', command: 'codex resume s2' },
        'the dialog opened for a rail card the timeline is not showing without its resume command',
      );

      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(`document.getElementById('sessiondetails').hidden`), true);
      assert.equal(
        await page.evaluate(`document.activeElement?.dataset?.control`),
        'rail:s2',
        'closing the dialog did not return focus to the rail card that opened it',
      );
    } finally {
      await browser.close();
    }
  },
);

test(
  'Show session details opens from a rail card for the session the timeline is showing, and places against and returns focus to the card, not the heading',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so the rail page was not measured');
      return;
    }
    try {
      const page = await browser.newPage();
      // Both the heading and session list row identify s1. The dialog must distinguish their anchors.

      await openPage(page);
      await page.evaluate(`window.__posted = []`);
      await page.evaluate(`(() => {
      const card = document.querySelector('[data-control="rail:s1"]');
      card.focus();
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    })()`);
      assert.deepEqual(
        await page.evaluate(`window.__posted.filter((message) => message.type === 'armSessionDetails')`),
        [{ type: 'armSessionDetails', session: 's1' }],
        'a right-click on the rail card for the shown session did not arm the native menu',
      );

      await postToPage(page, { type: 'showSessionDetails', session: 's1' });
      // The dialog edge identifies the measured anchor after viewport width clamping.

      const placement = (await page.evaluate(`(() => {
      const dialog = document.getElementById('sessiondetails');
      const card = document.querySelector('[data-control="rail:s1"]');
      const heading = document.querySelector('[data-control="session:s1"]');
      const dialogBox = dialog.getBoundingClientRect();
      const cardBox = card.getBoundingClientRect();
      const headingBox = heading.getBoundingClientRect();
      return {
        hidden: dialog.hidden,
        cardGap: Math.abs(dialogBox.top - (cardBox.bottom + 6)),
        headingGap: Math.abs(dialogBox.top - (headingBox.bottom + 6)),
      };
    })()`)) as { hidden: boolean; cardGap: number; headingGap: number };
      assert.equal(placement.hidden, false, 'the dialog did not open for the rail card of the shown session');
      assert.ok(
        placement.cardGap <= 1 && placement.cardGap < placement.headingGap,
        'the dialog aligned to the session heading rather than to the rail card that opened it',
      );

      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(`document.getElementById('sessiondetails').hidden`), true);
      assert.equal(
        await page.evaluate(`document.activeElement?.dataset?.control`),
        'rail:s1',
        'closing the dialog returned focus to the session heading instead of the rail card that opened it',
      );
    } finally {
      await browser.close();
    }
  },
);

test('the Labels button on a rail row held through the adoption closes the editor', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so the rail page was not measured');
    return;
  }
  try {
    const page = await browser.newPage();
    // The reader is on s2 while the draft runs, so the adoption does not move the rail's
    // current row, and a selection in the rail holds back its redraw.
    const { draft, adopted } = draftAdoption();
    const onS2 = (from: PanelPayload): PanelPayload => ({
      ...from,
      cards: [],
      showing: 's2',
      sessions: from.sessions.map((row) => ({ ...row, shown: row.id === 's2' })),
      rail: from.rail.map((card) => ({ ...card, current: card.id === 's2' })),
    });
    await openPage(page, onS2(draft));
    const provisional = page.locator('.railrow [data-control="raillabels:draft:s1"]').first();
    await provisional.click();
    await answerLabelEditor(page, 'draft:s1');
    await page.evaluate(`(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('.railcard[data-session="s2"] .railname').firstChild);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    })()`);
    // The rail adopts the durable id with the render. The held row still names the draft id,
    // and its Labels button still toggles the editor it opened.
    await postToPage(page, onS2(adopted));
    assert.equal(await provisional.count(), 1);
    assert.equal(await page.locator('#labelpop').isHidden(), false);
    await page.evaluate(`window.__posted = []`);
    await provisional.press('Enter');
    await page.evaluate(SETTLED);
    assert.equal(await page.locator('#labelpop').isHidden(), true);
    assert.deepEqual(await page.evaluate(`window.__posted.filter((message) => message.type === 'labelEditor')`), []);
  } finally {
    await browser.close();
  }
});

test(
  'a label ask left unanswered across the adoption opens under the durable heading',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so the rail page was not measured');
      return;
    }
    try {
      const page = await browser.newPage();
      const { draft, adopted } = draftAdoption();
      await openPage(page, draft);
      await page.locator('[data-control="sessionlabels:draft:s1"]').click();
      await postToPage(page, adopted);
      // The host answers the ask under the id it went out under.
      await answerLabelEditor(page, 'draft:s1');
      assert.deepEqual(await labelEditorPlace(page, 's1'), PLACED);

      await page.evaluate(`window.__posted = []`);
      await page.locator('#labelpop input[data-control="label:personal"]').click();
      assert.deepEqual(await page.evaluate(`window.__posted.filter((message) => message.type === 'setLabels')`), [
        { type: 'setLabels', session: 's1', names: ['performance', 'personal'] },
      ]);
    } finally {
      await browser.close();
    }
  },
);

test('rail label dismissal reconciles and returns to the live trigger', { timeout: 60_000 }, async (t) => {
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
    // s1 matches two saved views. Return focus to the Labels button in the section that opened the editor.

    const opener = inSection(COMPOSER_VIEW, 'raillabels:s1');
    const trigger = page.locator(opener);
    await page.evaluate(`window.__railLabelTrigger = document.querySelector('${opener}')`);

    await trigger.click();
    await answerLabelEditor(page, 's1');
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#labelpop').isHidden(), false);
    await page.locator('.labelfind').press('Escape');
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await page.evaluate(`(() => {
      const current = document.querySelector('${opener}');
      return { hidden: document.getElementById('labelpop').hidden,
        same: current === window.__railLabelTrigger, focused: document.activeElement === current,
        expanded: current.getAttribute('aria-expanded') };
    })()`),
      { hidden: true, same: true, focused: true, expanded: 'false' },
    );

    await trigger.click();
    await answerLabelEditor(page, 's1');
    await trigger.click();
    assert.deepEqual(
      await page.evaluate(`(() => {
      const current = document.querySelector('${opener}');
      return { hidden: document.getElementById('labelpop').hidden,
        same: current === window.__railLabelTrigger, focused: document.activeElement === current,
        expanded: current.getAttribute('aria-expanded') };
    })()`),
      { hidden: true, same: true, focused: true, expanded: 'false' },
    );

    await trigger.click();
    await answerLabelEditor(page, 's1');
    await page.locator('.railfilter').click();
    assert.deepEqual(
      await page.evaluate(`(() => {
      const current = document.querySelector('${opener}');
      return { hidden: document.getElementById('labelpop').hidden,
        same: current === window.__railLabelTrigger,
        filterFocused: document.activeElement === document.querySelector('.railfilter'),
        expanded: current.getAttribute('aria-expanded') };
    })()`),
      { hidden: true, same: true, filterFocused: true, expanded: 'false' },
    );
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

test(
  'rail label editor applies and creates labels and walks controls without taking composition keys',
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
      // Open the label editor from s1's row in the Composer view.

      await page.locator(inSection(COMPOSER_VIEW, 'raillabels:s1')).click();
      await answerLabelEditor(page, 's1', [
        { name: 'component system', count: 1, countName: '1 session', applied: true },
        { name: 'component', count: 1, countName: '1 session', applied: false },
        { name: 'server', count: 1, countName: '1 session', applied: false },
      ]);
      const input = page.locator('.labelfind');
      await input.fill('sweep');
      await page.evaluate(`window.__posted = []`);
      const composing = await page.evaluate(`(() => {
        const input = document.querySelector('.labelfind');
        const results = [];
        for (const key of ['Escape', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', 'Tab']) {
          const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, isComposing: true });
          results.push(input.dispatchEvent(event));
        }
        const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        Object.defineProperty(event, 'keyCode', { value: 229 });
        results.push(input.dispatchEvent(event));
        return { results, open: !document.getElementById('labelpop').hidden,
          focused: document.activeElement === input, messages: window.__posted.length };
      })()`);
      assert.deepEqual(composing, {
        results: [true, true, true, true, true, true, true, true],
        open: true,
        focused: true,
        messages: 0,
      });

      await page.evaluate(`(() => {
        window.__composingLabel = document.querySelector('.labelfind');
        window.__composingLabel.setSelectionRange(1, 4);
        window.__composingLabel.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      })()`);
      for (const width of [600, 1000]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(SETTLED);
        await answerLabelEditor(page, 's1', [
          { name: 'component system', count: 2, countName: '2 sessions', applied: true },
          { name: 'sweep', count: 1, countName: '1 session', applied: false },
        ]);
        assert.deepEqual(
          await page.evaluate(`(() => {
          const input = document.querySelector('.labelfind');
          return { same: input === window.__composingLabel, value: input.value,
            start: input.selectionStart, end: input.selectionEnd, focused: document.activeElement === input,
            expanded: document.querySelector('[data-control="sessionlabels:s1"]').getAttribute('aria-expanded') };
        })()`),
          { same: true, value: 'sweep', start: 1, end: 4, focused: true, expanded: 'true' },
        );
      }
      await page.evaluate(
        `window.__composingLabel.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'sweep' }))`,
      );
      await answerLabelEditor(page, 's1', [
        { name: 'component system', count: 1, countName: '1 session', applied: true },
        { name: 'component', count: 1, countName: '1 session', applied: false },
        { name: 'server', count: 1, countName: '1 session', applied: false },
      ]);

      await input.fill('');
      await page.evaluate(`window.__posted = []`);
      const emptyTab = await page.evaluate(`(() => {
        const input = document.querySelector('.labelfind');
        return input.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Tab', bubbles: true, cancelable: true,
        }));
      })()`);
      assert.equal(emptyTab, true);
      assert.deepEqual(await page.evaluate(`window.__posted.filter((message) => message.type === 'setLabels')`), []);

      await input.fill('compo');
      await page.evaluate(`window.__posted = []`);
      const modifiedTabs = await page.evaluate(`(() => {
        const input = document.querySelector('.labelfind');
        const results = [
          { shiftKey: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true },
        ].map((modifiers) => input.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Tab', bubbles: true, cancelable: true, ...modifiers,
        })));
        return { results, value: input.value,
          messages: window.__posted.filter((message) => message.type === 'setLabels') };
      })()`);
      assert.deepEqual(modifiedTabs, { results: [true, true, true, true], value: 'compo', messages: [] });

      // The key hint sits on one row only. 'component system' is checked and comes first, so a hint on
      // the first shown row would name it instead of the unchecked row that Tab applies.
      const hinted = () =>
        page.evaluate(
          `[...document.querySelectorAll('#labelpop .labelrow:has(.labelkey) .labelname')].map((node) => node.textContent)`,
        );
      await input.fill('compo');
      assert.deepEqual(await hinted(), ['component']);
      await page.evaluate(`window.__posted = []`);
      await input.press('Tab');
      assert.deepEqual(await hinted(), []);
      assert.deepEqual(
        await page.evaluate(`(() => ({
        messages: window.__posted.filter((message) => message.type === 'setLabels'),
        value: document.querySelector('.labelfind').value,
        focused: document.activeElement === document.querySelector('.labelfind'),
      }))()`),
        {
          messages: [{ type: 'setLabels', session: 's1', names: ['component system', 'component'] }],
          value: '',
          focused: true,
        },
      );
      await input.fill('ser');
      assert.deepEqual(await hinted(), ['server']);
      await page.evaluate(`window.__posted = []`);
      await input.press('Tab');
      assert.deepEqual(
        await page.evaluate(`(() => ({
        messages: window.__posted.filter((message) => message.type === 'setLabels'),
        value: document.querySelector('.labelfind').value,
        focused: document.activeElement === document.querySelector('.labelfind'),
      }))()`),
        {
          messages: [{ type: 'setLabels', session: 's1', names: ['component system', 'component', 'server'] }],
          value: '',
          focused: true,
        },
      );
      // Every match is applied now, so no row carries the key and Tab keeps its native walk.
      await input.fill('compo');
      assert.deepEqual(await hinted(), []);
      // Pressing Enter on an exact unchecked name applies it locally, so the key leaves before the host replies.
      await answerLabelEditor(page, 's1', [
        { name: 'component system', count: 1, countName: '1 session', applied: true },
        { name: 'component', count: 1, countName: '1 session', applied: false },
      ]);
      await input.fill('component');
      assert.deepEqual(await hinted(), ['component']);
      await input.press('Enter');
      assert.deepEqual(await hinted(), []);
      // Checking a row by its checkbox moves the key to the next unchecked match before the host replies.
      await answerLabelEditor(page, 's1', [
        { name: 'alpha one', count: 1, countName: '1 session', applied: false },
        { name: 'alpha two', count: 1, countName: '1 session', applied: false },
      ]);
      await input.fill('alpha');
      assert.deepEqual(await hinted(), ['alpha one']);
      await page.locator('[data-control="label:alpha one"]').check();
      assert.deepEqual(await hinted(), ['alpha two']);
      // The key's row names the key in the box, and the box describes the key before anything is typed.
      assert.equal(
        await page.evaluate(`document.querySelector('[data-control="label:alpha two"]').getAttribute('aria-label')`),
        `alpha two, 1 session, ${CARD_ACTIONS.labelTabSaid}`,
      );
      assert.equal(
        await page.evaluate(`(() => {
          const input = document.querySelector('.labelfind');
          return document.getElementById(input.getAttribute('aria-describedby')).textContent;
        })()`),
        CARD_ACTIONS.labelTabWhy,
      );
      await input.fill('no match');
      await page.evaluate(`window.__posted = []`);
      await input.press('Tab');
      assert.deepEqual(
        await page.evaluate(`(() => ({
        messages: window.__posted.filter((message) => message.type === 'setLabels'),
        control: document.activeElement.dataset.control,
      }))()`),
        { messages: [], control: 'label-find-clear' },
      );
      await answerLabelEditor(page, 's1');
      await input.fill('sweep');

      await input.press('Enter');
      assert.deepEqual(await page.evaluate(`window.__posted.filter((message) => message.type === 'setLabels')`), [
        { type: 'setLabels', session: 's1', names: ['performance', 'sweep'] },
      ]);
      await input.fill('Personal');
      await page.evaluate(`window.__posted = []`);
      await input.press('Enter');
      assert.deepEqual(await page.evaluate(`window.__posted.filter((message) => message.type === 'setLabels')`), [
        { type: 'setLabels', session: 's1', names: ['performance', 'personal', 'sweep'] },
      ]);
      // The find box clears from its cross. The cross is a stop between the box and the create row.
      await input.fill('zzz-no-label');
      await input.press('ArrowDown');
      assert.equal(await page.evaluate(`document.activeElement.dataset.control`), 'label-find-clear');
      await page.keyboard.press('ArrowDown');
      assert.equal(await page.evaluate(`document.activeElement.dataset.control`), 'label-create');
      await page.locator('[data-control="label-find-clear"]').click();
      assert.equal(await input.inputValue(), '', 'the cross left text in the find box');
      assert.equal(await page.evaluate(`document.activeElement.dataset.control`), 'label-find');
      assert.equal(await page.locator('[data-control="label-create"]').count(), 0, 'the create row outlived the text');
      assert.equal(await page.locator('[data-control="label-find-clear"]').count(), 0);
      await input.fill('');
      await input.press('Home');
      assert.equal(await page.evaluate(`document.activeElement.dataset.control`), 'label-find');
      await input.press('End');
      assert.equal(await page.evaluate(`document.activeElement.dataset.control`), 'label-find');
      await input.press('ArrowDown');
      assert.equal(await page.evaluate(`document.activeElement.dataset.control`), 'label:performance');
      await page.keyboard.press('ArrowDown');
      assert.equal(await page.evaluate(`document.activeElement.dataset.control`), 'label:personal');
      await page.keyboard.press('End');
      assert.equal(
        await page.evaluate(`document.activeElement.dataset.control`),
        'label:worktree parallel sessions and the rails',
      );
      await page.keyboard.press('Home');
      assert.equal(await page.evaluate(`document.activeElement.dataset.control`), 'label-find');
      await page.keyboard.press('ArrowUp');
      assert.equal(await page.evaluate(`document.activeElement.dataset.control`), 'label-find');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('End');
      assert.equal(
        await page.evaluate(`document.activeElement.dataset.control`),
        'label:worktree parallel sessions and the rails',
      );
      await page.evaluate(`window.__posted = []`);
      await page.keyboard.press('Enter');
      assert.deepEqual(await page.evaluate(`window.__posted.filter((message) => message.type === 'setLabels')`), [
        {
          type: 'setLabels',
          session: 's1',
          names: ['performance', 'personal', 'worktree parallel sessions and the rails', 'sweep'],
        },
      ]);
      await page.evaluate(`window.__posted = []`);
      await page.keyboard.press('Space');
      assert.deepEqual(await page.evaluate(`window.__posted.filter((message) => message.type === 'setLabels')`), [
        { type: 'setLabels', session: 's1', names: ['performance', 'personal', 'sweep'] },
      ]);
      assert.deepEqual(failures, []);
    } finally {
      await browser.close();
    }
  },
);

test('a session two views match has one label editor, and a press moves it', { timeout: 60_000 }, async (t) => {
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

    // Count expanded controls as elements, since one session appears under two view sections.

    const reported = async () =>
      await page.evaluate(`(() => {
        const open = [...document.querySelectorAll('.raillabelact')]
          .filter((node) => node.getAttribute('aria-expanded') === 'true');
        return { open: open.length,
          rows: open.map((node) => node.closest('.railrow').dataset.railBucket),
          hidden: document.getElementById('labelpop').hidden };
      })()`);

    // The fixture files s1 under two saved views, so the session carries a labels control
    // under each of their sections.
    assert.deepEqual(
      await page.evaluate(`[...document.querySelectorAll('[data-control="raillabels:s1"]')]
          .map((node) => node.closest('.railrow').dataset.railBucket)`),
      [COMPOSER_VIEW, RELEASE_VIEW],
      'the fixture no longer draws one session under two views, so this guard ' + 'measures nothing',
    );
    assert.deepEqual(await reported(), { open: 0, rows: [], hidden: true });

    // The second copy's control opens the editor, and it is the only control that says so.
    await page.locator(inSection(RELEASE_VIEW, 'raillabels:s1')).click();
    await answerLabelEditor(page, 's1');
    assert.deepEqual(await reported(), { open: 1, rows: [RELEASE_VIEW], hidden: false });

    // The first copy's control then moves the editor to its own row. It is a different
    // control, so it does not shut an editor the reader is looking at somewhere else.
    await page.locator(inSection(COMPOSER_VIEW, 'raillabels:s1')).click();
    await answerLabelEditor(page, 's1');
    assert.deepEqual(await reported(), { open: 1, rows: [COMPOSER_VIEW], hidden: false });

    // And the control the editor came back to shuts it, because that is the press that
    // opened it.
    await page.locator(inSection(COMPOSER_VIEW, 'raillabels:s1')).click();
    await page.evaluate(SETTLED);
    assert.deepEqual(await reported(), { open: 0, rows: [], hidden: true });
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

// Open Rename session through the saved row's context menu and its host reply.

async function openSessionRename(page: Page, section: string, session: string, title: string): Promise<void> {
  await page.locator(inSection(section, `rail:${session}`)).click({ button: 'right' });
  await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'openSessionRename', session, title })}, '*')`);
  await page.evaluate(SETTLED);
}

test(
  'Rename session opens on a saved rail row, keeps the text on failure, and returns focus',
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
      const editor = async () =>
        (await page.evaluate(`(() => {
      const pop = document.getElementById('sessionrenamepop');
      const box = pop.querySelector('[data-control="session-rename-name"]');
      const save = pop.querySelector('[data-control="session-rename-save"]');
      const active = document.activeElement;
      return {
        hidden: pop.hidden, name: box ? box.value : null, readOnly: !!box?.readOnly,
        saveDisabled: !!save?.disabled, note: pop.querySelector('#sessionrenamenote')?.textContent ?? '',
        label: box ? box.labels[0]?.textContent ?? null : null,
        active: active?.dataset.control ?? null,
        activeSection: active?.closest('.railrow')?.dataset.railBucket ?? null,
      };
    })()`)) as {
          hidden: boolean;
          name: string | null;
          readOnly: boolean;
          saveDisabled: boolean;
          note: string;
          label: string | null;
          active: string | null;
          activeSection: string | null;
        };
      const renames = async () =>
        (await page.evaluate(`window.__posted.filter((message) => message.type === 'renameSession')`)) as unknown[];
      const closed = { hidden: true, name: null, readOnly: false, saveDisabled: false, note: '', label: null };

      // Saved row context enables Rename session. Provisional session context disables it.

      const draft = { ...initial.rail[0], id: 'draft:rename', persisted: false, label: 'New session', current: false };
      await page.evaluate(`window.postMessage(${JSON.stringify(railMessage(initial, [draft, ...initial.rail]))}, '*')`);
      await page.evaluate(SETTLED);
      const contextOf = async (control: string) =>
        JSON.parse(
          (await page.locator(`[data-control="${control}"]`).first().getAttribute('data-vscode-context')) ?? '{}',
        ) as { sessionPersisted?: boolean };
      assert.equal((await contextOf('rail:s1')).sessionPersisted, true);
      assert.equal((await contextOf('rail:draft:rename')).sessionPersisted, false);

      // A panel opens no rename editor without a matching context-menu request on a saved session.

      await page.evaluate(`window.postMessage({ type: 'openSessionRename', session: 's1', title: 'Full name' }, '*')`);
      await page.evaluate(SETTLED);
      assert.equal((await editor()).hidden, true, 'the editor opened with no right-click behind it');
      await page.locator('[data-control="rail:draft:rename"]').first().click({ button: 'right' });
      await page.evaluate(
        `window.postMessage({ type: 'openSessionRename', session: 'draft:rename', title: 'New session' }, '*')`,
      );
      await page.evaluate(SETTLED);
      assert.equal((await editor()).hidden, true, "a provisional session's row opened the rename editor");

      // The box starts from the full name the host sent, not the shorter card text, and it
      // takes focus with the name selected.
      const full = 'The complete session name that the rail card shortens';
      await openSessionRename(page, COMPOSER_VIEW, 's1', full);
      assert.deepEqual(await editor(), {
        hidden: false,
        name: full,
        readOnly: false,
        saveDisabled: false,
        note: '',
        label: CARD_ACTIONS.sessionRenameField,
        active: 'session-rename-name',
        activeSection: null,
      });
      // Cancel and Save sit at the right end of their row, as they do in the view editor and the
      // setup popover. The rename editor has no delete button to hold the left end.
      const saveGap = (await page.evaluate(`(() => {
      const row = document.querySelector('#sessionrenamepop .launchactions');
      const save = row.querySelector('[data-control="session-rename-save"]');
      return row.getBoundingClientRect().right - parseFloat(getComputedStyle(row).paddingRight)
        - save.getBoundingClientRect().right;
    })()`)) as number;
      assert.ok(Math.abs(saveGap) < 1, `Save sat ${saveGap}px left of the right end of its row`);

      // Escape cancels, sends nothing, and puts focus back on the row the reader right-clicked.
      await page.locator('[data-control="session-rename-name"]').press('Escape');
      await page.evaluate(SETTLED);
      assert.deepEqual(await editor(), { ...closed, active: 'rail:s1', activeSection: COMPOSER_VIEW });
      assert.deepEqual(await renames(), []);

      // Enter sends the typed name once, and the editor holds still until the host answers.
      await openSessionRename(page, COMPOSER_VIEW, 's1', full);
      await page.locator('[data-control="session-rename-name"]').fill('Refused name');
      await page.locator('[data-control="session-rename-name"]').press('Enter');
      await page.evaluate(SETTLED);
      const refused = await lastRequest(page);
      assert.deepEqual(await renames(), [
        { type: 'renameSession', session: 's1', request: refused, title: 'Refused name' },
      ]);
      assert.deepEqual(await editor(), {
        hidden: false,
        name: 'Refused name',
        readOnly: true,
        saveDisabled: true,
        note: CARD_ACTIONS.sessionRenamePending,
        label: CARD_ACTIONS.sessionRenameField,
        active: 'session-rename-name',
        activeSection: null,
      });
      assert.equal(
        await page.locator('[data-control="session-rename-name-clear"]').count(),
        0,
        'a rename waiting for its answer offered a cross',
      );
      await page.locator('[data-control="session-rename-name"]').press('Enter');
      await page.evaluate(SETTLED);
      assert.equal((await renames()).length, 1, 'a rename still waiting for its answer sent a second one');

      // A failure keeps the text and shows the reason inline.
      await page.evaluate(
        `window.postMessage(${JSON.stringify({ type: 'sessionRenameResult', session: 's1', request: refused, title: 'Refused name', error: 'Claude Code did not save the new session name.' })}, '*')`,
      );
      await page.evaluate(SETTLED);
      assert.deepEqual(await editor(), {
        hidden: false,
        name: 'Refused name',
        readOnly: false,
        saveDisabled: false,
        note: 'Claude Code did not save the new session name.',
        label: CARD_ACTIONS.sessionRenameField,
        active: 'session-rename-name',
        activeSection: null,
      });
      assert.equal(await page.locator('[data-control="session-rename-name"]').getAttribute('aria-invalid'), 'true');

      // Save sends the name again, and success closes the editor on the row it came from.
      await page.locator('[data-control="session-rename-name"]').fill('Saved name');
      await page.locator('[data-control="session-rename-save"]').click();
      await page.evaluate(
        `window.postMessage(${JSON.stringify({ type: 'sessionRenameResult', session: 's1', request: refused + 1, title: 'Saved name', error: '' })}, '*')`,
      );
      await page.evaluate(SETTLED);
      assert.deepEqual((await renames()).at(-1), {
        type: 'renameSession',
        session: 's1',
        request: refused + 1,
        title: 'Saved name',
      });
      assert.deepEqual(await editor(), { ...closed, active: 'rail:s1', activeSection: COMPOSER_VIEW });
      assert.deepEqual(failures, []);
    } finally {
      await browser.close();
    }
  },
);

// Read rename visibility, message, neighboring popovers, and focus.

const RENAME_STATE = `(() => {
  const pop = document.getElementById('sessionrenamepop');
  const active = document.activeElement;
  const shown = (id) => { const node = document.getElementById(id); return !!node && !node.hidden; };
  return {
    rename: !pop.hidden,
    note: pop.querySelector('#sessionrenamenote')?.textContent ?? '',
    labels: shown('labelpop'), filters: shown('railfilterpop'),
    focus: active === document.body || !active ? 'body' : pop.contains(active) ? 'rename'
      : active.id || active.dataset.control || active.tagName,
  };
})()`;

async function renameState(
  page: Page,
): Promise<{ rename: boolean; note: string; labels: boolean; filters: boolean; focus: string }> {
  return (await page.evaluate(RENAME_STATE)) as {
    rename: boolean;
    note: string;
    labels: boolean;
    filters: boolean;
    focus: string;
  };
}

async function submitRename(page: Page, title: string): Promise<void> {
  await openSessionRename(page, COMPOSER_VIEW, 's1', 'Full name');
  await page.locator('[data-control="session-rename-name"]').fill(title);
  await page.locator('[data-control="session-rename-name"]').press('Enter');
  await page.evaluate(SETTLED);
}

// The id the last rename this page sent carries.
async function lastRequest(page: Page): Promise<number> {
  return (await page.evaluate(
    `window.__posted.filter((message) => message.type === 'renameSession').at(-1)?.request`,
  )) as number;
}

test(
  'the rename editor never floats beside another popover and never waits for ever',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so the rail page was not measured');
      return;
    }
    try {
      const page = await browser.newPage();
      const initial = payload();
      await openPage(page, initial);
      const card = page.locator(inSection(COMPOSER_VIEW, 'rail:s1'));

      // The View menu opened while the editor is idle, then the label editor opened from the keyboard
      // while a rename waits for its answer. Each closes the rename editor.
      await openSessionRename(page, COMPOSER_VIEW, 's1', 'Full name');
      await page.locator('[data-control="railfilters"]').click();
      await page.evaluate(SETTLED);
      assert.deepEqual(await renameState(page), {
        rename: false,
        note: '',
        labels: false,
        filters: true,
        focus: 'railfilter-find',
      });
      await page.locator('[data-control="railfilters"]').click();
      await submitRename(page, 'Waiting name');
      const abandoned = await lastRequest(page);
      await card.focus();
      await card.press('l');
      await answerLabelEditor(page, 's1');
      const withLabels = await renameState(page);
      assert.deepEqual({ rename: withLabels.rename, labels: withLabels.labels }, { rename: false, labels: true });
      // The answer to the abandoned rename finds no editor and changes nothing.
      await postToPage(page, {
        type: 'sessionRenameResult',
        session: 's1',
        request: abandoned,
        title: 'Waiting name',
        error: 'Not saved.',
      });
      const late = await renameState(page);
      assert.deepEqual({ rename: late.rename, labels: late.labels }, { rename: false, labels: true });
      await card.press('l');
      await page.evaluate(SETTLED);

      // A sent rename cannot be taken back, so Cancel holds still while it waits. A rename whose
      // answer never comes still closes, from Escape and from a press outside.
      await submitRename(page, 'Lost answer');
      assert.equal(
        await page.locator('[data-control="session-rename-cancel"]').isDisabled(),
        true,
        'Cancel offered to take back a rename already sent',
      );
      await page.locator('[data-control="session-rename-name"]').press('Escape');
      await page.evaluate(SETTLED);
      assert.equal((await renameState(page)).rename, false, 'Escape left a waiting rename open');
      await submitRename(page, 'Lost answer');
      await page.mouse.click(900, 600);
      await page.evaluate(SETTLED);
      assert.equal((await renameState(page)).rename, false, 'a press outside left a waiting rename open');

      // Save disables itself while the rename waits. Pressed by pointer or by keyboard, it leaves
      // focus in the editor, so Escape still closes it.
      for (const press of ['click', 'keyboard'] as const) {
        await openSessionRename(page, COMPOSER_VIEW, 's1', 'Full name');
        await page.locator('[data-control="session-rename-name"]').fill('Lost answer');
        const save = page.locator('[data-control="session-rename-save"]');
        if (press === 'click') {
          await save.click();
        } else {
          await save.focus();
          await page.keyboard.press('Enter');
        }
        await page.evaluate(SETTLED);
        assert.equal((await renameState(page)).focus, 'rename', `Save by ${press} dropped focus out of the editor`);
        await page.keyboard.press('Escape');
        await page.evaluate(SETTLED);
        assert.equal(
          (await renameState(page)).rename,
          false,
          `Escape after Save by ${press} left a waiting rename open`,
        );
      }

      // A session that leaves the rail takes its editor with it, and focus leaves the box.
      await openSessionRename(page, COMPOSER_VIEW, 's1', 'Full name');
      await postToPage(
        page,
        railMessage(
          initial,
          initial.rail.filter((row) => row.id !== 's1'),
        ),
      );
      const gone = await renameState(page);
      assert.equal(gone.rename, false, 'the editor stayed open over a session the rail no longer has');
      assert.notEqual(gone.focus, 'rename');
    } finally {
      await browser.close();
    }
  },
);

test('a rename answer moves focus only while the reader is still in the editor', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so the rail page was not measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await openPage(page, payload());

    // Neither rename result moves focus back from the prompt box.
    await submitRename(page, 'Refused name');
    const refused = await lastRequest(page);
    await page.locator('#prompt').focus();
    await postToPage(page, {
      type: 'sessionRenameResult',
      session: 's1',
      request: refused,
      title: 'Refused name',
      error: 'Not saved.',
    });
    assert.deepEqual(await renameState(page), {
      rename: true,
      note: 'Not saved.',
      labels: false,
      filters: false,
      focus: 'prompt',
    });
    await page.locator('[data-control="session-rename-save"]').click();
    await page.locator('#prompt').focus();
    await postToPage(page, {
      type: 'sessionRenameResult',
      session: 's1',
      request: refused + 1,
      title: 'Refused name',
      error: '',
    });
    assert.deepEqual(await renameState(page), {
      rename: false,
      note: '',
      labels: false,
      filters: false,
      focus: 'prompt',
    });

    // Below the rail breakpoint the row the editor came from is hidden, so Escape sends focus
    // to the timeline rather than to a row nobody can see.
    await openSessionRename(page, COMPOSER_VIEW, 's1', 'Full name');
    await page.setViewportSize({ width: RAIL_MIN_WIDTH - 1, height: 900 });
    await page.evaluate(SETTLED);
    await page.locator('[data-control="session-rename-name"]').press('Escape');
    await page.evaluate(SETTLED);
    const narrow = await renameState(page);
    assert.equal(narrow.rename, false);
    assert.notEqual(narrow.focus, 'body', 'focus was lost to a hidden rail row');
    assert.equal(await page.evaluate(`!!document.activeElement.closest('nav, [hidden]')`), false);
  } finally {
    await browser.close();
  }
});

test('a rail row projected onto a provisional id offers no rename', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so the rail page was not measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const { draft, adopted } = draftAdoption();
    await openPage(page, draft);
    await postToPage(page, { ...railMessage(adopted, adopted.rail), sessionAdoptions: adopted.sessionAdoptions });
    const row = page.locator('.railrow [data-control="rail:draft:s1"]').first();
    assert.equal(await row.count(), 1, 'the rail did not project the durable row onto the provisional id');
    const context = JSON.parse((await row.getAttribute('data-vscode-context')) ?? '{}') as {
      sessionPersisted?: boolean;
    };
    assert.equal(context.sessionPersisted, false);
    await row.click({ button: 'right' });
    await postToPage(page, { type: 'openSessionRename', session: 'draft:s1', title: 'New session' });
    assert.equal((await renameState(page)).rename, false);
  } finally {
    await browser.close();
  }
});

test('a projected provisional row reports and changes its durable membership', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so the rail page was not measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const { draft, adopted } = draftAdoption();
    draft.sessions = draft.sessions.map((row) => ({ ...row, persisted: false }));
    draft.rail = draft.rail.map((row) => ({ ...row, persisted: false }));
    await openPage(page, draft);
    assert.equal((await headingContext(page, 'draft:s1')).sessionPersisted, false);
    const membershipRail = (hidden: string[], pinnedTop: string[]) => ({
      ...railMessage(adopted, adopted.rail),
      sessionAdoptions: adopted.sessionAdoptions,
      hidden,
      pinnedTop,
    });

    await postToPage(page, membershipRail(['s1'], []));
    assert.equal((await railRowContext(page, 'draft:s1')).sessionArchived, true);
    assert.equal((await headingContext(page, 'draft:s1')).webviewSection, 'arcSessionArchived');
    await page.evaluate(`window.__posted = []`);
    await postToPage(page, { type: 'setSessionArchived', session: 'draft:s1', archived: false });

    await postToPage(page, membershipRail([], ['s1']));
    assert.equal((await railRowContext(page, 'draft:s1')).sessionPinned, true);
    assert.equal((await headingContext(page, 'draft:s1')).sessionPinned, true);
    assert.equal((await headingContext(page, 'draft:s1')).sessionPersisted, false);
    await postToPage(page, { type: 'setSessionPinned', session: 'draft:s1', pinned: false });
    assert.deepEqual(await page.evaluate(`window.__posted.filter((message) => message.type === 'sessionMembership')`), [
      { type: 'sessionMembership', action: 'unarchive', session: 'draft:s1' },
      { type: 'sessionMembership', action: 'unpin', session: 'draft:s1' },
    ]);
    await postToPage(page, adopted);
    assert.equal((await headingContext(page, 's1')).sessionPersisted, true);
    await page.evaluate('window.__posted = []');
    await postToPage(page, { type: 'setSessionPinned', session: 's1', pinned: true });
    assert.equal((await headingContext(page, 's1')).sessionPinned, true);
    assert.deepEqual(await page.evaluate(`window.__posted.filter(message => message.type === 'sessionMembership')`), [
      { type: 'sessionMembership', action: 'pin', session: 's1' },
    ]);
  } finally {
    await browser.close();
  }
});

// Open the heading's Rename session action through a right-click or Session actions.

async function openHeadingRename(page: Page, control: string, session: string, title: string): Promise<void> {
  const node = page.locator(`main#list [data-control="${control}"]`);
  if (control.startsWith('sessionmenu:')) {
    await node.click();
  } else {
    await node.click({ button: 'right' });
  }
  await postToPage(page, { type: 'openSessionRename', session, title });
}

interface HeadingContext {
  webviewSection?: string;
  sessionPinned?: boolean;
  sessionPersisted?: boolean;
}

async function headingContext(page: Page, session: string): Promise<HeadingContext> {
  return JSON.parse(
    (await page.locator(`main#list .sessionrow[data-session="${session}"]`).getAttribute('data-vscode-context')) ??
      '{}',
  ) as HeadingContext;
}

test(
  'Rename session opens on a saved session heading, anchored to it, and a stale answer never reports',
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
      assert.equal(
        (await headingContext(page, 's1')).sessionPersisted,
        true,
        'the heading of a saved session does not offer Rename session',
      );
      const renames = async () =>
        (await page.evaluate(`window.__posted.filter((message) => message.type === 'renameSession')`)) as {
          request: number;
          title: string;
        }[];
      const box = page.locator('[data-control="session-rename-name"]');
      const focused = async () =>
        (await page.evaluate('document.activeElement?.dataset.control ?? null')) as string | null;

      // The editor opens under the heading the reader right-clicked, and Escape returns focus to
      // the disclosure the press landed on.
      const oldName = await page.locator('main#list [data-control="session:s1"] .name').innerText();
      await openHeadingRename(page, 'session:s1', 's1', 'Full name');
      assert.equal((await renameState(page)).rename, true, 'a right-click on a saved heading opened no editor');
      const gap = (await page.evaluate(`(() => {
      const pop = document.getElementById('sessionrenamepop').getBoundingClientRect();
      const at = document.querySelector('main#list [data-control="session:s1"]').getBoundingClientRect();
      return Math.min(Math.abs(pop.top - at.bottom), Math.abs(at.top - pop.bottom));
    })()`)) as number;
      assert.ok(gap <= 5, `the editor sat ${gap}px away from the heading it was opened from`);
      await box.press('Escape');
      await page.evaluate(SETTLED);
      assert.equal(await focused(), 'session:s1');

      // The Session actions button opens the same menu, and focus goes back to that button.
      await openHeadingRename(page, 'sessionmenu:s1', 's1', 'Full name');
      assert.equal((await renameState(page)).rename, true, 'the Session actions button opened no editor');
      await box.press('Escape');
      await page.evaluate(SETTLED);
      assert.equal(await focused(), 'sessionmenu:s1');

      // A rename the reader walked away from, then a newer one. The answer to the first, failed
      // or saved, is not the answer the editor waits on.
      await openHeadingRename(page, 'session:s1', 's1', 'Full name');
      await box.fill('Abandoned name');
      await box.press('Enter');
      await box.press('Escape');
      await openHeadingRename(page, 'session:s1', 's1', 'Full name');
      await box.fill('Heading name');
      await box.press('Enter');
      await page.evaluate(SETTLED);
      const [abandoned, newer] = await renames();
      assert.deepEqual([abandoned.title, newer.title], ['Abandoned name', 'Heading name']);
      assert.notEqual(abandoned.request, newer.request);
      const waiting = {
        rename: true,
        note: CARD_ACTIONS.sessionRenamePending,
        labels: false,
        filters: false,
        focus: 'rename',
      };
      await postToPage(page, {
        type: 'sessionRenameResult',
        session: 's1',
        request: abandoned.request,
        title: 'Abandoned name',
        error: 'Not saved.',
      });
      assert.deepEqual(await renameState(page), waiting, "the abandoned rename's failure reported as the newer save's");
      assert.equal(await box.inputValue(), 'Heading name');
      await postToPage(page, {
        type: 'sessionRenameResult',
        session: 's1',
        request: abandoned.request,
        title: 'Abandoned name',
        error: '',
      });
      assert.deepEqual(
        await renameState(page),
        waiting,
        "the abandoned rename's success closed the newer save's editor",
      );

      // The host redraws the saved name, and one render carries it to the heading and the card.
      await postToPage(
        page,
        JSON.parse(JSON.stringify(initial).replaceAll(JSON.stringify(oldName), JSON.stringify('Heading name'))),
      );
      assert.equal(await page.locator('main#list [data-control="session:s1"] .name').innerText(), 'Heading name');
      assert.match(await page.locator(inSection(COMPOSER_VIEW, 'rail:s1')).innerText(), /Heading name/);
      await postToPage(page, {
        type: 'sessionRenameResult',
        session: 's1',
        request: newer.request,
        title: 'Heading name',
        error: '',
      });
      assert.deepEqual(await renameState(page), {
        rename: false,
        note: '',
        labels: false,
        filters: false,
        focus: 'session:s1',
      });
      assert.deepEqual(failures, []);
    } finally {
      await browser.close();
    }
  },
);

test(
  'Rename session and Session details opened from the heading pin return focus to the disclosure, not the pin',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so the rail page was not measured');
      return;
    }
    try {
      const page = await browser.newPage();
      await openPage(page, payload());
      const pin = page.locator('main#list [data-control="sessionpin:s1"]');
      assert.equal(await pin.count(), 1, 'the heading draws no pin, so this measures nothing');
      const focused = async () =>
        (await page.evaluate('document.activeElement?.dataset.control ?? null')) as string | null;

      // A right-click on the pin opens the heading's menu. Rename session opens against the
      // disclosure, the way it does from the layout gear, and Escape returns focus there.
      await openHeadingRename(page, 'sessionpin:s1', 's1', 'Full name');
      assert.equal((await renameState(page)).rename, true, 'a right-click on the heading pin opened no editor');
      await page.locator('[data-control="session-rename-name"]').press('Escape');
      await page.evaluate(SETTLED);
      assert.equal(
        await focused(),
        'session:s1',
        'closing the rename editor opened from the pin left focus off the disclosure',
      );

      // Shift+F10 on the focused pin raises a contextmenu event on it. Session details places
      // itself against the heading row, and closing it returns focus to the disclosure.
      await pin.focus();
      await page.evaluate(`window.__posted = []`);
      await pin.dispatchEvent('contextmenu', { bubbles: true, cancelable: true });
      assert.deepEqual(
        await page.evaluate(`window.__posted.filter((message) => message.type === 'armSessionDetails')`),
        [{ type: 'armSessionDetails', session: 's1' }],
        'Shift+F10 on the heading pin did not arm the native menu',
      );
      await postToPage(page, { type: 'showSessionDetails', session: 's1' });
      assert.equal(
        await page.evaluate(`document.getElementById('sessiondetails').hidden`),
        false,
        'Session details did not open from the heading pin',
      );
      await page.keyboard.press('Escape');
      await page.evaluate(SETTLED);
      assert.equal(
        await focused(),
        'session:s1',
        'closing Session details opened from the pin left focus off the disclosure',
      );
    } finally {
      await browser.close();
    }
  },
);

test('the heading of a provisional new session offers no rename', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no installed Edge or Chrome, so the rail page was not measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const { draft } = draftAdoption();
    // The extension writes a provisional session's row as not saved.
    const unsaved = <T extends { id: string }>(rows: T[]) =>
      rows.map((row) => (row.id === 'draft:s1' ? { ...row, persisted: false } : row));
    const rows = draft as unknown as { sessions: { id: string }[]; rail: RailCard[] };
    rows.sessions = unsaved(rows.sessions);
    rows.rail = unsaved(rows.rail);
    await openPage(page, draft);
    assert.equal(
      await page.locator('main#list [data-control="session:draft:s1"]').count(),
      1,
      'the provisional session drew no heading, so this measures nothing',
    );
    assert.equal((await headingContext(page, 'draft:s1')).sessionPersisted, false);
    await openHeadingRename(page, 'session:draft:s1', 'draft:s1', 'New session');
    assert.equal((await renameState(page)).rename, false, "a provisional session's heading opened the rename editor");
  } finally {
    await browser.close();
  }
});

interface RailRowContext {
  webviewSection?: string;
  sessionPinned?: boolean;
  sessionArchived?: boolean;
}

async function railRowContext(page: Page, session: string): Promise<RailRowContext> {
  // Read the first matching row's context.

  return JSON.parse(
    (await page.locator(`[data-control="rail:${session}"]`).first().getAttribute('data-vscode-context')) ?? '{}',
  ) as RailRowContext;
}

test(
  'a saved heading still offers Rename session after a pin and an archive, and the rail card answers the same press',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so the rail page was not measured');
      return;
    }
    try {
      const page = await browser.newPage();
      await openPage(page, payload());
      assert.equal((await headingContext(page, 's1')).sessionPersisted, true);
      await postToPage(page, { type: 'setSessionPinned', session: 's1', pinned: true });
      const pinned = await headingContext(page, 's1');
      assert.deepEqual(
        [pinned.sessionPinned, pinned.sessionPersisted],
        [true, true],
        'a pin took Rename session off the heading',
      );
      // A pin reply updates session list context without requiring a new session list payload.

      assert.equal(
        (await railRowContext(page, 's1')).sessionPinned,
        true,
        'the rail card still offers to pin a session the heading already pinned',
      );
      await postToPage(page, { type: 'setSessionArchived', session: 's1', archived: true });
      const archived = await headingContext(page, 's1');
      assert.deepEqual(
        [archived.webviewSection, archived.sessionPersisted],
        ['arcSessionArchived', true],
        'an archive took Rename session off the heading',
      );
      assert.equal(
        (await railRowContext(page, 's1')).sessionArchived,
        true,
        'the rail card still offers to archive a session the heading already archived',
      );
    } finally {
      await browser.close();
    }
  },
);

test(
  'the rail card answers a later full render after an optimistic pin patch, not just the patch itself',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so the rail page was not measured');
      return;
    }
    try {
      const page = await browser.newPage();
      const initial = payload();
      await openPage(page, initial);
      assert.equal(
        (await railRowContext(page, 's1')).sessionPinned,
        false,
        'the fixture session already reads as pinned',
      );

      // The pin reply updates context directly before the full host render.

      await postToPage(page, { type: 'setSessionPinned', session: 's1', pinned: true });
      assert.equal(
        (await railRowContext(page, 's1')).sessionPinned,
        true,
        'the rail card did not answer the optimistic pin',
      );

      // The full host render restores its pinnedTop state after the optimistic pin update.

      await postToPage(page, initial);
      assert.equal(
        (await railRowContext(page, 's1')).sessionPinned,
        false,
        'the rail card kept answering an optimistic pin a later render never confirmed',
      );
    } finally {
      await browser.close();
    }
  },
);

test(
  'the session heading answers a later full render after an optimistic archive patch, not just the patch itself',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so the rail page was not measured');
      return;
    }
    try {
      const page = await browser.newPage();
      const initial = payload();
      await openPage(page, initial);
      assert.equal(
        (await headingContext(page, 's1')).webviewSection,
        'arcSessionLive',
        'the fixture session already reads as archived',
      );

      // The archive reply updates context directly before the full host render.

      await postToPage(page, { type: 'setSessionArchived', session: 's1', archived: true });
      assert.equal(
        (await headingContext(page, 's1')).webviewSection,
        'arcSessionArchived',
        'the heading did not answer the optimistic archive',
      );

      // The full host render restores its hidden state after the optimistic archive update.

      await postToPage(page, initial);
      for (const pinned of [true, false, true, false]) {
        await postToPage(page, { type: 'setSessionPinned', session: 's1', pinned });
        assert.equal((await headingContext(page, 's1')).sessionPinned, pinned);
        await postToPage(page, initial);
        assert.equal(
          (await headingContext(page, 's1')).sessionPinned,
          false,
          'heading retained stale remembered pin context',
        );
      }
      for (const archived of [true, false, true, false]) {
        await postToPage(page, { type: 'setSessionArchived', session: 's1', archived });
        assert.equal(
          (await headingContext(page, 's1')).webviewSection,
          archived ? 'arcSessionArchived' : 'arcSessionLive',
        );
        await postToPage(page, initial);
        assert.equal(
          (await headingContext(page, 's1')).webviewSection,
          'arcSessionLive',
          'heading retained stale remembered archive context',
        );
      }
      assert.equal(
        (await headingContext(page, 's1')).webviewSection,
        'arcSessionLive',
        'the heading kept answering an optimistic archive a later render never confirmed',
      );
    } finally {
      await browser.close();
    }
  },
);

test(
  'the session heading offers Mark as read or Mark as unread, and follows a read change made on a turn card',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so the rail page was not measured');
      return;
    }
    try {
      const page = await browser.newPage();
      const initial = payload();
      // Session-wide read commands require the newest-turn watermark, which the fixture row does not carry by default.

      const s1Cards = (
        initial as unknown as {
          cards: { sessionId: string; kind: string; key: string; startedAt: number; live?: boolean }[];
        }
      ).cards.filter((card) => card.sessionId === 's1' && card.kind === 'turn');
      const newest = s1Cards.reduce((a, b) => (a.startedAt > b.startedAt ? a : b));
      // Choose a completed turn. Live turns cannot receive an individual read mark.

      const oldestKey = s1Cards.filter((card) => !card.live).reduce((a, b) => (a.startedAt < b.startedAt ? a : b)).key;
      const railRow = initial.rail.find((row) => row.id === 's1') as { newestTurnAt: number } | undefined;
      if (railRow) {
        railRow.newestTurnAt = newest.startedAt;
      }
      await openPage(page, initial);
      const headingReadState = async () =>
        ((await headingContext(page, 's1')) as HeadingContext & { sessionRead?: 'read' | 'unread' }).sessionRead;
      // A fresh page starts with the session unread.

      assert.equal(await headingReadState(), 'unread', 'the heading of a freshly opened session already reads as read');

      await postToPage(page, { type: 'setSessionRead', session: 's1', read: true });
      assert.equal(
        await headingReadState(),
        'read',
        'the heading still offers Mark as read after the whole session was marked read',
      );

      // Marking one completed turn unread also marks its session unread.

      await postToPage(page, { type: 'setRead', key: oldestKey, read: false });
      assert.equal(
        await headingReadState(),
        'unread',
        'the heading did not follow a read change made on one of its own turn cards',
      );
    } finally {
      await browser.close();
    }
  },
);

test(
  'the session heading follows a new unread turn that arrives after a direct read patch',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so the rail page was not measured');
      return;
    }
    try {
      const page = await browser.newPage();
      const initial = payload();
      const cards = (
        initial as unknown as {
          cards: Array<
            Record<string, unknown> & {
              sessionId: string;
              kind: string;
              key: string;
              startedAt: number;
              live?: boolean;
            }
          >;
        }
      ).cards;
      const s1Cards = cards.filter((card) => card.sessionId === 's1' && card.kind === 'turn');
      const newest = s1Cards.reduce((a, b) => (a.startedAt > b.startedAt ? a : b));
      // Copy a completed turn, since live turns cannot receive an individual read mark.

      const oldest = s1Cards.filter((card) => !card.live).reduce((a, b) => (a.startedAt < b.startedAt ? a : b));
      const railRow = initial.rail.find((row) => row.id === 's1') as { newestTurnAt: number } | undefined;
      if (railRow) {
        railRow.newestTurnAt = newest.startedAt;
      }
      await openPage(page, initial);
      const headingReadState = async () =>
        ((await headingContext(page, 's1')) as HeadingContext & { sessionRead?: 'read' | 'unread' }).sessionRead;
      assert.equal(await headingReadState(), 'unread', 'the heading of a freshly opened session already reads as read');

      // Deliver the new turn in the same task as the read command, before the read-driven render settles.

      const arrived = {
        ...oldest,
        key: 'new-turn',
        promptId: 'new-turn',
        startedAt: newest.startedAt + 600_000,
        endedAt: newest.startedAt + 600_000 + 1_000,
      };
      const withNewTurn = { ...initial, cards: [...cards, arrived] };
      const railWithNewTurn = (withNewTurn.rail as Array<Record<string, unknown>>).map((row) =>
        row.id === 's1' ? { ...row, newestTurnAt: arrived.startedAt } : row,
      );
      await page.evaluate(`(() => {
      window.postMessage(${JSON.stringify({ type: 'setSessionRead', session: 's1', read: true })}, '*');
      window.postMessage(${JSON.stringify({ ...withNewTurn, rail: railWithNewTurn })}, '*');
    })()`);
      await page.evaluate(SETTLED);
      assert.equal(
        await headingReadState(),
        'unread',
        'the heading kept offering Mark as unread after a new turn arrived unread',
      );
    } finally {
      await browser.close();
    }
  },
);

test(
  'an answer to a rename an earlier page sent never reports as a save on a new page',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no installed Edge or Chrome, so the rail page was not measured');
      return;
    }
    try {
      // The editor recreates its page while a rename runs. The new page sends its own rename.
      const earlier = await browser.newPage();
      await openPage(earlier, payload());
      await submitRename(earlier, 'Earlier name');
      const lost = await lastRequest(earlier);
      await earlier.close();
      const page = await browser.newPage();
      await openPage(page, payload());
      await submitRename(page, 'Newer name');
      await postToPage(page, {
        type: 'sessionRenameResult',
        session: 's1',
        request: lost,
        title: 'Earlier name',
        error: '',
      });
      assert.deepEqual(
        await renameState(page),
        { rename: true, note: CARD_ACTIONS.sessionRenamePending, labels: false, filters: false, focus: 'rename' },
        'the answer an earlier page waited on reported as the new page save',
      );
    } finally {
      await browser.close();
    }
  },
);
