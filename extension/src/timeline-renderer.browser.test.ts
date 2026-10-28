import { test } from 'vitest';
import assert from 'node:assert';
import type { Page } from 'playwright-core';
import { browserOrNone, SETTLED } from '../test/browser.ts';
import { CONSERVATIVE_CACHE_BOUNDARY_MS } from './pricing.ts';
import {
  sessionCompactionContextDetail,
  sessionTurnStats,
  toCard,
  withLiveActivity,
  withSessionContextDetail,
} from './turncard.ts';
import { createCodexSessionReducer } from './codex.ts';
import { renderRichMarkdown } from './richtext.ts';
import { MARKDOWN_LINK_RESPONSE, SESSION_LINK_RESPONSE, turn } from './turnfixtures.ts';

test('timeline copy retains selected text after prompt focus through native copy routing', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('A browser is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(themed(pageHtml()));
    const payload = renderPayload() as Payload;
    payload.cards = [payload.cards[0]];
    payload.cards[0].summaryHtml = '<p>Selected response text for copying.</p>';
    await post(page, payload);
    await page.locator('.turn .head').click();
    await page.evaluate(() => {
      let lastFocused: HTMLElement | null = null;
      document.addEventListener('focusin', () => {
        const active = document.activeElement;
        if (active instanceof HTMLElement && active !== document.body && active !== document.documentElement) {
          lastFocused = active;
        }
      });
      // VS Code restores its last focused control before delivering a native editing command.
      window.addEventListener('keydown', (event) => {
        if (event.key !== 'c' || !(event.ctrlKey || event.metaKey)) return;
        document.body.dataset.hostCopies = String(Number(document.body.dataset.hostCopies ?? 0) + 1);
        if (document.activeElement === document.body && lastFocused?.isConnected) {
          lastFocused.focus({ preventScroll: true });
        }
        document.execCommand('copy');
        event.preventDefault();
      });
      document.addEventListener('copy', (event) => {
        const active = document.activeElement;
        const text =
          active instanceof HTMLTextAreaElement
            ? active.value.slice(active.selectionStart, active.selectionEnd)
            : getSelection()?.toString();
        document.body.dataset.copied = text ?? '';
        event.preventDefault();
      });
    });
    for (const [platform, modifier] of [
      ['Win32', 'Control'],
      ['Linux x86_64', 'Control'],
      ['MacIntel', 'Meta'],
    ]) {
      await page.evaluate(
        (platform) => Object.defineProperty(navigator, 'platform', { configurable: true, value: platform }),
        platform,
      );
      await page.locator('#prompt').fill('Editable prompt text');
      await page.locator('#prompt').click();
      await page.locator('.turn .summary p').evaluate((node) => {
        (document.activeElement as HTMLElement).blur();
        const range = document.createRange();
        range.selectNodeContents(node);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(range);
        delete document.body.dataset.copied;
        delete document.body.dataset.hostCopies;
      });
      await page.keyboard.press(`${modifier}+c`);
      assert.equal(await page.locator('body').getAttribute('data-copied'), 'Selected response text for copying.');
      assert.equal(await page.evaluate(() => getSelection()?.toString()), 'Selected response text for copying.');
      assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
      assert.equal(await page.locator('body').getAttribute('data-host-copies'), null);
      await page.locator('#prompt').focus();
      await page.locator('#prompt').evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(0, 8));
      await page.keyboard.press(`${modifier}+c`);
      assert.equal(await page.locator('body').getAttribute('data-copied'), 'Editable');
    }
    const excluded = [
      { name: 'Windows Command', platform: 'Win32', metaKey: true },
      { name: 'Linux Command', platform: 'Linux x86_64', metaKey: true },
      { name: 'macOS Control', platform: 'MacIntel', ctrlKey: true },
      { name: 'both modifiers', ctrlKey: true, metaKey: true },
      { name: 'Shift', shiftKey: true },
      { name: 'Alt', altKey: true },
      { name: 'composition', isComposing: true },
      { name: 'composition key code', keyCode: 229 },
      { name: 'handled', handled: true },
      { name: 'empty', selection: 'empty' },
      { name: 'collapsed', selection: 'collapsed' },
      { name: 'textless', selection: 'textless' },
      { name: 'outside anchor', selection: 'outside-anchor' },
      { name: 'outside focus', selection: 'outside-focus' },
      { name: 'editable focus', editableFocus: true },
      { name: 'editable target', editableTarget: true },
    ];
    for (const row of excluded) {
      const result = await page.evaluate((row) => {
        Object.defineProperty(navigator, 'platform', { configurable: true, value: row.platform ?? 'Win32' });
        const prompt = document.querySelector<HTMLTextAreaElement>('#prompt')!;
        prompt.focus();
        if (!row.editableFocus) prompt.blur();
        const text = document.querySelector('.turn .summary p')!;
        const selection = getSelection()!;
        selection.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(text);
        if (row.selection === 'collapsed') range.collapse(true);
        if (row.selection === 'textless') {
          const empty = document.createElement('span');
          text.append(empty);
          range.selectNode(empty);
        }
        if (row.selection !== 'empty') selection.addRange(range);
        if (row.selection === 'outside-focus') selection.extend(document.querySelector('#rail')!, 0);
        if (row.selection === 'outside-anchor') {
          selection.setBaseAndExtent(document.querySelector('#rail')!, 0, text, 1);
        }
        delete document.body.dataset.hostCopies;
        let copies = 0;
        const original = document.execCommand;
        document.execCommand = () => {
          copies++;
          return true;
        };
        try {
          const event = new KeyboardEvent('keydown', {
            key: 'c',
            ctrlKey: !row.metaKey,
            bubbles: true,
            cancelable: true,
            ...row,
          });
          if (row.handled) event.preventDefault();
          (row.editableTarget ? prompt : text).dispatchEvent(event);
          return { copies, hostCopies: document.body.dataset.hostCopies };
        } finally {
          document.execCommand = original;
        }
      }, row);
      assert.deepEqual(result, { copies: 1, hostCopies: '1' }, row.name);
    }
    await page.evaluate(() => Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' }));
    await page.locator('.turn .summary p').evaluate((node) => {
      (document.activeElement as HTMLElement).blur();
      const range = document.createRange();
      range.selectNodeContents(node);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      delete document.body.dataset.hostCopies;
      const copy = document.execCommand.bind(document);
      let refused = false;
      document.execCommand = (...args) => {
        if (!refused) {
          refused = true;
          return false;
        }
        return copy(...args);
      };
    });
    await page.keyboard.press('Meta+c');
    assert.equal(await page.locator('body').getAttribute('data-host-copies'), '1');
    await page.locator('.turn .summary p').evaluate((node) => {
      (document.activeElement as HTMLElement).blur();
      const range = document.createRange();
      range.selectNodeContents(node);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      delete document.body.dataset.hostCopies;
      const copy = document.execCommand.bind(document);
      let failed = false;
      document.execCommand = (...args) => {
        if (!failed) {
          failed = true;
          throw new Error('Copy unavailable');
        }
        return copy(...args);
      };
    });
    await page.keyboard.press('Meta+c');
    assert.equal(await page.locator('body').getAttribute('data-host-copies'), '1');
  } finally {
    await browser.close();
  }
});

test('response citations retain literal destinations through mouse, keyboard and streamed card updates', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('A browser is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(themed(pageHtml()));
    const payload = renderPayload() as Payload;
    const card = payload.cards.find((card) => card.kind !== 'compaction')!;
    const file = process.platform === 'win32' ? 'C:/Downloads/file%20.csv#L10' : '/Downloads/file%20.csv#L10';
    const source = `:codex-file-citation{path='${file}' purpose=source}`;
    card.summaryHtml = renderRichMarkdown(source.slice(0, -1));
    payload.cards = [card];
    await post(page, payload);
    await page.locator(`[data-control=${JSON.stringify(`card:${card.key}`)}]`).click();
    assert.equal(await page.locator('a[data-link-kind="file-citation"]').count(), 0);
    await post(page, {
      type: 'activity',
      session: card.sessionId,
      card: { ...card, summaryHtml: renderRichMarkdown(source) },
    });
    const link = page.locator('a[data-link-kind="file-citation"]');
    const context = JSON.parse((await link.getAttribute('data-vscode-context')) || '{}');
    assert.deepEqual(context.destination, { kind: 'fileCitation', path: file });
    await page.evaluate('window.__posted.length=0');
    await link.click({ modifiers: ['Control'] });
    await link.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => (window as any).__posted.filter((message: any) => message.type === 'openLink').length === 2,
    );
    assert.deepEqual(await page.evaluate('window.__posted'), [
      { type: 'openLink', destination: { kind: 'fileCitation', path: file }, beside: true },
      { type: 'openLink', destination: { kind: 'fileCitation', path: file }, beside: false },
    ]);
    await post(page, payload);
    await post(page, {
      type: 'activity',
      session: card.sessionId,
      card: { ...card, summaryHtml: renderRichMarkdown(source) },
    });
    await page.evaluate('window.__posted.length=0');
    await link.click();
    assert.deepEqual(await page.evaluate('window.__posted'), [
      { type: 'openLink', destination: { kind: 'fileCitation', path: file }, beside: false },
    ]);
  } finally {
    await browser.close();
  }
});
import type { CompactionFact } from './projectspend.ts';
import { RAIL_FOLDS, RAIL_MIN_WIDTH, RAIL_WIDTH_MIN } from './view/rail.ts';
import { CARD_ACTIONS } from './view/card-words.ts';
import { ROVING_SELECTOR } from './webview/navigation.ts';
import {
  cacheWriteWarningPayload,
  waitWarningPayload,
  compactionSummaryPayload,
  LONG_TURN_INDEX,
  nextTurnPayload,
  NOW,
  pageHtml,
  renderPayload,
  statPopoverPayload,
  themed,
} from './panelfixture.ts';
import { HOVER_GRACE_MS } from './webview/stat-detail.ts';
import { contextAt, manifestMenu, menuGroups } from '../scripts/web-demo-menu.ts';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';

type Payload = ReturnType<typeof renderPayload> & {
  cards: Array<
    Record<string, unknown> & {
      key: string;
      sessionId: string;
      sessionTitle?: string | null;
      headline: string;
      startedAt?: number;
    }
  >;
  sessions: Array<Record<string, unknown> & { id: string }>;
  stats: Record<string, Array<Record<string, unknown> & { metric?: string; detail?: string }>>;
  rail: unknown[];
  labels: unknown;
  comments: unknown[];
  usage: {
    composer: null | {
      sessionId: string;
      targetName: string;
      live: Array<Record<string, unknown>>;
      queue: unknown[];
    };
  };
};

async function post(page: Page, payload: unknown): Promise<void> {
  await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
  await page.evaluate(SETTLED);
}

function twoSessionPayload(): Payload {
  const payload = renderPayload() as Payload;
  const first = payload.cards.slice(0, 4).map((card) => ({ ...card }));
  const second = {
    ...first[0],
    key: first[0].key.replace(/^s1:/, 's2:'),
    sessionId: 's2',
    sessionTitle: 'Codex parity sweep',
    headline: 'The second session keeps its own keyed parent.',
  };
  payload.cards = [...first, second];
  payload.sessions = payload.sessions.filter((session) => session.id === 's1' || session.id === 's2');
  payload.showing = null;
  return payload;
}

function bodylessCard(card: Payload['cards'][number], key: string): Payload['cards'][number] {
  return {
    ...card,
    key,
    errorText: '',
    summaryHtml: '',
    saidMessages: [],
    activity: [],
    files: [],
    agents: [],
    commits: [],
    prompt: '',
    laterPrompts: [],
  };
}

function interruptedActivityPayload() {
  const payload = renderPayload() as Payload;
  const peer = payload.cards[0];
  const reducer = createCodexSessionReducer(peer.sessionId);
  const records = [
    { type: 'session_meta', payload: { id: peer.sessionId } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'interrupted-body' } },
    { type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } },
  ];
  records.forEach((record, index) =>
    reducer.pushLine(JSON.stringify({ ...record, timestamp: new Date(NOW + index).toISOString() })),
  );
  const turn = reducer.read().turns[0];
  assert.equal(turn.interrupted, true);
  const original = { ...toCard(turn, true, NOW), summaryHtml: renderRichMarkdown(turn.summary) };
  assert.deepEqual(
    [
      original.errorText,
      original.summaryHtml,
      original.saidMessages,
      original.activity,
      original.prompt,
      original.delegation,
      original.laterPrompts,
    ],
    [null, '', [], [], '', '', []],
  );
  const active = withLiveActivity(turn, [
    {
      kind: 'tool',
      name: 'exec_command',
      sourceId: 'first-command',
      headline: 'Running',
      detail: 'echo first-body',
      status: 'running',
      at: NOW + 3,
    },
  ]);
  const changed = { ...toCard(active, true, NOW), summaryHtml: renderRichMarkdown(active.summary) };
  assert.ok(changed.activity.length);
  payload.cards = [original, peer];
  return { payload, original, changed, peer };
}

test('a failed activity run separates its failure from the tool mix', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const payload = renderPayload() as Payload;
    const card = payload.cards[0];
    card.status = 'running';
    card.activity = [
      {
        kind: 'run',
        id: 'run:1',
        count: 5,
        earlier: 5,
        failed: 1,
        line: '5 tool calls',
        figure: '1 failed',
        mix: '5 run',
        status: 'done',
        inFlight: false,
        steps: [],
        label: '5 tool calls, 1 failed, 5 run',
        hintDetail: '',
      },
    ];
    await post(page, payload);
    const turn = page.locator(`[data-key=${JSON.stringify(card.key)}]`);
    await turn.locator('button.head').click();
    const run = turn.locator('.actrow.run');
    assert.equal(await run.locator('.actverb').textContent(), '5 tool calls \u00b7 1 failed');
    assert.equal(await run.locator('.actmix').evaluate((node) => node.previousSibling?.textContent), ' \u00b7 ');
  } finally {
    await browser.close();
  }
});

test('the production page exposes the semantic Timeline hierarchy and accessible names', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const payload = twoSessionPayload();
    payload.cards.splice(2, 0, {
      ...payload.cards[0],
      key: 's1:compaction-boundary',
      kind: 'compaction',
      headline: 'Compacted session context',
      label: 'Compaction, 10 minutes ago',
    });
    payload.cards.splice(3, 0, bodylessCard(payload.cards[0], 's1:bodyless-turn'));
    await post(page, payload);

    assert.equal(await page.title(), 'Arc');
    await page.getByRole('heading', { level: 1, name: 'Arc' }).waitFor();
    await page.getByRole('main', { name: 'Timeline' }).waitFor();
    assert.equal(await page.locator('body > h1.sr-only').count(), 1);
    assert.equal(await page.locator('body > main#list[aria-label="Timeline"]').count(), 1);

    const sessions = page.locator('main#list section.sessionsection');
    assert.equal(await sessions.count(), 2);
    assert.equal(await sessions.count(), await page.locator('main#list button.session').count());
    for (const session of await sessions.all()) {
      const labelledBy = await session.getAttribute('aria-labelledby');
      assert.ok(labelledBy);
      // The session row names its session so context-menu updates can find it after pin or archive changes.

      const row = session.locator(':scope > .sessionrow');
      const named = await row.getAttribute('data-session');
      assert.ok(named, 'a session row names no session, so nothing finds it again');
      const rowContext = await row.getAttribute('data-vscode-context');
      assert.ok(rowContext, 'a session row carries no context, so a right-click over it offers nothing');
      assert.equal(
        JSON.parse(rowContext).session,
        named,
        'a session row names one session to the panel and another to the menu',
      );
      const heading = session.locator(':scope > .sessionrow > h2');
      assert.equal(await heading.count(), 1);
      assert.equal(await heading.getAttribute('id'), labelledBy);
      // The name button names the session and folds nothing, so it claims no turn list.
      const name = heading.locator(':scope > button.session:not([aria-expanded]):not([aria-controls])');
      assert.equal(await name.count(), 1);
      // The menu button sits beside the name button and opens the row's context menu.

      const menu = heading.locator(':scope > button.sessionmenu:not(.sessionlayout):not(.sessionpin)');
      assert.equal(await menu.count(), 1);
      assert.equal(await menu.getAttribute('aria-haspopup'), 'menu');
      const sessionTitle = await heading.locator('.session .name').textContent();
      const menuName = await menu.getAttribute('aria-label');
      assert.ok(sessionTitle, 'the session title is empty, so this measures nothing');
      assert.ok(
        menuName && menuName.endsWith(sessionTitle),
        `the menu button is named "${menuName}", which does not end with the session title "${sessionTitle}"`,
      );
    }

    assert.equal(
      await page.getByRole('article').count(),
      payload.cards.filter((card) => card.kind !== 'compaction').length,
    );
    assert.equal(
      await page.locator('article.turn > h3 > button.head').count(),
      await page.locator('article.turn button.head').count(),
    );
    assert.equal(await page.locator('article.turn > h3 > span.head.statichead').count(), 1);
    assert.equal(await page.locator('article.turn > h3 > div').count(), 0);
    const compaction = page.locator('section.compaction[aria-labelledby]');
    assert.equal(await compaction.count(), 1);
    assert.equal(await compaction.locator(':scope > h3 > button.head').count(), 1);

    const firstTurn = page.locator('article.turn.has-body').first();
    const firstHead = firstTurn.locator('button.head');
    const firstHeadline = firstTurn.locator('.headline');
    assert.equal(await firstHead.getAttribute('aria-expanded'), 'false');
    assert.equal(await firstHeadline.evaluate((node) => getComputedStyle(node).cursor), 'default');
    await firstHeadline.click();
    await page.evaluate(SETTLED);
    assert.equal(await firstHead.getAttribute('aria-expanded'), 'false');
    await firstHead.click();
    await page.evaluate(SETTLED);
    const sectionTitles = page.locator('article.turn .sec-title');
    assert.ok((await sectionTitles.count()) > 0);
    assert.equal(await sectionTitles.evaluateAll((nodes) => nodes.every((node) => node.closest('h4') !== null)), true);
    // Activity and You asked disclosures expose expanded state and controlled body IDs.

    assert.equal(
      await page
        .locator(
          'article.turn h4 > button[aria-expanded][aria-controls], ' +
            'article.turn h4 > .acthead > button.actword[aria-expanded][aria-controls]',
        )
        .count(),
      3,
    );
    assert.equal(await page.locator('button h1, button h2, button h3, button h4').count(), 0);
    assert.equal(
      await page.locator('[id]').evaluateAll((nodes) => {
        const ids = nodes.map((node) => node.id);
        return new Set(ids).size === ids.length;
      }),
      true,
    );
    assert.deepEqual(
      await page.locator('[aria-controls]').evaluateAll((nodes) =>
        nodes.flatMap((node) => {
          const ids = (node.getAttribute('aria-controls') || '').trim().split(/\s+/).filter(Boolean);
          const missing = ids.filter((id) => document.querySelectorAll(`[id="${CSS.escape(id)}"]`).length !== 1);
          return ids.length > 0 && missing.length === 0
            ? []
            : [{ control: node.getAttribute('data-control'), missing }];
        }),
      ),
      [],
    );
    assert.equal(
      await page.locator('main#list').evaluate((list) => {
        const controls = Array.from(
          list.querySelectorAll(
            '.session, .sessionlabelact, .head:not(.livehead):not(.statichead), .statdetail, .result, .cliveoff, .cwaitingact',
          ),
        ).filter((node) => !node.closest('[hidden]')) as HTMLElement[];
        return controls.filter((node) => node.tabIndex === 0).length;
      }),
      1,
    );

    // Shift on a turn head opens every shown card, the compaction among them.
    await page
      .locator('section.sessionsection[data-session="s1"] article.turn button.head')
      .first()
      .click({ modifiers: ['Shift'] });
    await page.evaluate(SETTLED);
    assert.equal(await compaction.locator('button.head').getAttribute('aria-expanded'), 'true');
    assert.equal(await compaction.locator('.body').isHidden(), false);
  } finally {
    await browser.close();
  }
});

test('compaction summaries stay closed until the reader opens their source Markdown', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const payload = compactionSummaryPayload() as Payload;
    await post(page, payload);

    const boundaries = page.locator('section.compaction');
    const manual = boundaries.nth(0);
    const automatic = boundaries.nth(1);
    const unreadable = boundaries.nth(2);
    for (const boundary of [manual, automatic]) {
      const head = boundary.locator(':scope > h3 > button.head');
      const controls = await head.getAttribute('aria-controls');
      assert.equal(await head.getAttribute('aria-expanded'), 'false');
      assert.ok(controls, 'a readable compaction has no controlled body');
      assert.equal(await page.locator(`[id=${JSON.stringify(controls)}]`).isHidden(), true);
    }
    assert.equal(await unreadable.locator(':scope > h3 > span.head.statichead').count(), 1);
    assert.equal(await unreadable.locator(':scope > h3 > [aria-expanded], :scope > h3 > [aria-controls]').count(), 0);

    const manualHead = manual.locator(':scope > h3 > button.head');
    await manualHead.click();
    await page.evaluate(SETTLED);
    assert.equal(await manualHead.getAttribute('aria-expanded'), 'true');
    assert.equal(await manual.locator('.body').isHidden(), false);
    assert.equal(await manual.getByRole('heading', { level: 4, name: 'What carried over' }).count(), 1);
    assert.equal(await manual.getByRole('heading', { level: 1, name: 'Delivery state' }).count(), 1);
    assert.equal(await manual.getByRole('link', { name: 'Read the turn card guide' }).count(), 1);
    assert.equal(await manual.locator('table').count(), 1);
    const commands = (await manual.locator('pre code').textContent()) ?? '';
    assert.match(commands, /npm --prefix extension run build/);
    assert.match(commands, /npm test/);
    assert.match(
      await manual.locator('.summary').innerText(),
      /The next reader must retain these constraints while reviewing the full Markdown summary\./,
    );

    await post(page, structuredClone(payload));
    assert.equal(await manualHead.getAttribute('aria-expanded'), 'true', 'a render refresh closed the reader choice');
    await manualHead.click();
    await page.evaluate(SETTLED);
    await post(page, structuredClone(payload));
    assert.equal(
      await manualHead.getAttribute('aria-expanded'),
      'false',
      'a render refresh reopened the reader choice',
    );

    await page.setViewportSize({ width: 340, height: 900 });
    await manualHead.click();
    await page.evaluate(SETTLED);
    const narrow = await manual.evaluate((card) => {
      const body = card.querySelector('.body') as HTMLElement;
      const box = card.getBoundingClientRect();
      const bodyBox = body.getBoundingClientRect();
      return {
        cardRight: box.right,
        bodyLeft: bodyBox.left,
        bodyRight: bodyBox.right,
        documentWidth: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
      };
    });
    assert.ok(narrow.cardRight <= narrow.viewport + 1, 'the narrow compaction boundary leaves the panel');
    assert.ok(
      narrow.bodyLeft >= -1 && narrow.bodyRight <= narrow.viewport + 1,
      'the narrow summary body is offset outside the panel',
    );
    assert.ok(narrow.documentWidth <= narrow.viewport + 1, 'the narrow summary widens the page outside its code block');
  } finally {
    await browser.close();
  }
});

test('named stat and label surfaces keep semantic text separators', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const payload = renderPayload() as Payload;
    payload.stats = structuredClone(payload.stats);
    // Session list figures come from stats keyed by session ID.

    const stats = [
      { kind: 'plain', metric: 'turns', label: '0 turns', compactLabel: '0 turns', detail: '' },
      { kind: 'plain', metric: 'context', label: 'next stat', compactLabel: 'next stat', detail: '' },
    ];
    payload.stats.s1 = stats;
    payload.cards[0].chips = stats;
    const rail = payload.rail as Array<Record<string, unknown>>;
    const row = rail.find((candidate) => candidate.id === 's1')!;
    row.labelChips = ['first label', 'second label'];
    row.labelsMore = null;
    await post(page, payload);

    const surfaces = await page.evaluate(`(() => {
      const directText = (selector) => {
        const node = document.querySelector(selector);
        return node ? [...node.childNodes].map((child) => child.textContent).join('') : null;
      };
      return {
        turnStats: directText('#list .turn .chips'),
        sessionStats: directText('#list .sessionstats'),
        railStats: directText('[data-control="rail:s1"] .railstats'),
        railLabels: directText('[data-control="rail:s1"] .raillabels'),
        sessionLabels: directText('#list .sessionlabels'),
      };
    })()`);
    assert.deepEqual(surfaces, {
      turnStats: '0 turns next stat',
      sessionStats: '0 turns next stat',
      railStats: '0 turns next stat',
      railLabels: 'first label second label',
      sessionLabels: 'composer release 0.4 perf Labels',
    });
  } finally {
    await browser.close();
  }
});

test('a files figure that is a known floor draws no partial word on the turn card or the session heading', async (t) => {
  // StatChip reads detail through a mounted ref in a layout effect.

  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const payload = renderPayload() as Payload;
    payload.stats = structuredClone(payload.stats);
    // The figure has no partial wording or detailList. The supplied filesFloor field must not add a visible partial mark.

    const floor = {
      kind: 'diff',
      metric: 'files',
      label: '2 files',
      name: '2 files, 4 lines added',
      added: 4,
      removed: 0,
      filesFloor: true,
      detail: '2 files: +4',
    };
    payload.stats.s1 = [floor];
    payload.cards[0].chips = [floor];
    const cardKey = payload.cards[0].key;
    await post(page, payload);

    // Read rendered partial marks rather than the fixture's supplied accessible name.

    const turnChip = `[data-key=${JSON.stringify(cardKey)}] .chips [data-metric="files"]`;
    const headingChip = 'section.sessionsection[data-session="s1"] .sessionstats [data-metric="files"]';
    const marks = (await page.evaluate(`(() => {
      const text = (selector) => {
        const node = document.querySelector(selector);
        return node ? node.textContent : null;
      };
      return {
        turnFigure: text(${JSON.stringify(turnChip)}),
        headingFigure: text(${JSON.stringify(headingChip)}),
        turnMark: text(${JSON.stringify(`${turnChip} .statpartial`)}),
        headingMark: text(${JSON.stringify(`${headingChip} .statpartial`)}),
      };
    })()`)) as {
      turnFigure: string | null;
      headingFigure: string | null;
      turnMark: string | null;
      headingMark: string | null;
    };
    // Both files figures must render before checking that their partial marks are absent.

    assert.ok(marks.turnFigure?.includes('2 files'), 'the turn card drew no files figure to check for the mark');
    assert.ok(
      marks.headingFigure?.includes('2 files'),
      'the session heading drew no files figure to check for the mark',
    );
    assert.deepEqual(
      [marks.turnMark, marks.headingMark],
      [null, null],
      'a floor figure drew the partial mark on the turn card or the session heading',
    );
  } finally {
    await browser.close();
  }
});

test('session heading labels filter the visible rail and keep the reader on a stable control', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.setContent(
      themed(
        pageHtml()
          .replace(
            'window.__posted = [];',
            'window.__posted = []; window.__timelineDraws = 0; window.__cardPrints = 0; window.__arcOnDraw = (owner) => { if (owner === "timeline") window.__timelineDraws++; };',
          )
          .replace(/([A-Za-z_$][\w$]*)\.cardPrint\(([^)]*)\)/g, '(window.__cardPrints++, $&)'),
      ),
    );
    const payload = twoSessionPayload();
    await post(page, payload);

    const line = page.locator('section.sessionsection[data-session="s1"] .sessionlabels');
    const chips = line.locator('button.sessionlabel');
    assert.deepEqual(await chips.allTextContents(), ['composer', 'release 0.4', 'perf']);
    assert.deepEqual(
      await chips.evaluateAll((nodes) =>
        nodes.map((node) => ({
          tabIndex: (node as HTMLElement).tabIndex,
          title: node.getAttribute('title'),
          hint: (node as HTMLElement).dataset.hint,
          detail: (node as HTMLElement).dataset.hintDetail,
          name: node.getAttribute('aria-label'),
        })),
      ),
      [
        {
          tabIndex: -1,
          title: null,
          hint: 'composer',
          detail: 'Show only the sessions with this label',
          name: 'Filter by label composer',
        },
        {
          tabIndex: -1,
          title: null,
          hint: 'release 0.4',
          detail: 'Show only the sessions with this label',
          name: 'Filter by label release 0.4',
        },
        {
          tabIndex: -1,
          title: null,
          hint: 'perf',
          detail: 'Show only the sessions with this label',
          name: 'Filter by label perf',
        },
      ],
    );

    const perf = chips.filter({ hasText: 'perf' });
    await perf.focus();
    await perf.evaluate((node) => {
      (window as Window & { __labelChip?: Element }).__labelChip = node;
    });
    const updated = structuredClone(payload);
    const s1 = (updated.rail as Array<{ id: string; labels?: string[] }>).find((row) => row.id === 's1')!;
    s1.labels = ['release 0.4', 'perf'];
    await post(page, {
      type: 'rail',
      rail: updated.rail,
      labels: updated.labels,
      views: updated.views,
      railFilters: updated.railFilters,
      stats: updated.stats,
      hidden: updated.hidden,
      pinnedTop: updated.pinnedTop,
    });
    assert.deepEqual(
      await page.evaluate(`(() => ({
      same: document.activeElement === window.__labelChip,
      text: document.activeElement?.textContent,
      tabIndex: document.activeElement?.tabIndex,
    }))()`),
      { same: true, text: 'perf', tabIndex: 0 },
    );

    s1.labels = ['release 0.4'];
    await post(page, {
      type: 'rail',
      rail: updated.rail,
      labels: updated.labels,
      views: updated.views,
      railFilters: updated.railFilters,
      stats: updated.stats,
      hidden: updated.hidden,
      pinnedTop: updated.pinnedTop,
    });
    assert.equal(await page.evaluate(`document.activeElement?.dataset.control`), 'sessionlabels:s1');

    await line.locator('button.sessionlabel').focus();
    await page.locator('#prompt').focus();
    const beforeRemoval = await page.evaluate('({ draws: window.__timelineDraws, prints: window.__cardPrints })');
    s1.labels = [];
    await post(page, {
      type: 'rail',
      rail: updated.rail,
      labels: updated.labels,
      views: updated.views,
      railFilters: updated.railFilters,
      stats: updated.stats,
      hidden: updated.hidden,
      pinnedTop: updated.pinnedTop,
    });
    assert.equal(await page.locator('#prompt').evaluate((node) => document.activeElement === node), true);
    assert.deepEqual(
      await page
        .locator('[data-roving][tabindex="0"]:not([hidden])')
        .evaluateAll((nodes) =>
          nodes.filter((node) => !node.closest('[hidden]')).map((node) => (node as HTMLElement).dataset.control),
        ),
      ['sessionlabels:s1'],
      'removing an unfocused label lost its heading keyboard stop',
    );
    assert.deepEqual(
      await page.evaluate('({ draws: window.__timelineDraws, prints: window.__cardPrints })'),
      beforeRemoval,
      'removing a heading label drew the timeline or traversed card fingerprints',
    );
    assert.equal(
      await page
        .locator('article.turn[data-session="s1"]')
        .first()
        .evaluate((node) => JSON.parse((node as HTMLElement).dataset.vscodeContext!).sessionLabeled),
      undefined,
    );
    s1.labels = ['release 0.4'];
    await post(page, {
      type: 'rail',
      rail: updated.rail,
      labels: updated.labels,
      views: updated.views,
      railFilters: updated.railFilters,
      stats: updated.stats,
      hidden: updated.hidden,
      pinnedTop: updated.pinnedTop,
    });
    assert.equal(
      await page
        .locator('article.turn[data-session="s1"]')
        .first()
        .evaluate((node) => JSON.parse((node as HTMLElement).dataset.vscodeContext!).sessionLabeled),
      true,
    );
    await line.locator('button.sessionlabel').focus();

    await page.setViewportSize({ width: 600, height: 700 });
    await page.waitForFunction(
      () => document.querySelector('section.sessionsection[data-session="s1"] .sessionlabel')?.tagName === 'SPAN',
    );
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await line.locator('.sessionlabel').evaluateAll((nodes) =>
        nodes.map((node) => ({
          tag: node.tagName,
          title: node.getAttribute('title'),
        })),
      ),
      [{ tag: 'SPAN', title: 'release 0.4' }],
    );
    assert.equal(await page.evaluate(`document.activeElement?.dataset.control`), 'sessionlabels:s1');

    await page.setViewportSize({ width: 1000, height: 700 });
    await page.evaluate(SETTLED);
    await line.locator('button.sessionlabel').focus();
    await page.locator('#prompt').focus();
    await page.setViewportSize({ width: 600, height: 700 });
    await page.waitForFunction(
      () => document.querySelector('section.sessionsection[data-session="s1"] .sessionlabel')?.tagName === 'SPAN',
    );
    await page.evaluate(SETTLED);
    assert.equal(await page.locator('#prompt').evaluate((node) => document.activeElement === node), true);
    assert.deepEqual(
      await page
        .locator('[data-roving][tabindex="0"]')
        .evaluateAll((nodes) =>
          nodes.filter((node) => !node.closest('[hidden]')).map((node) => (node as HTMLElement).dataset.control),
        ),
      ['sessionlabels:s1'],
      'a responsive label removed the background heading keyboard stop',
    );
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.evaluate(SETTLED);
    await line.locator('button.sessionlabel').click();
    assert.deepEqual(
      await page.locator('.railfilter').evaluate((node: HTMLInputElement) => ({
        value: node.value,
        focused: document.activeElement === node,
        caret: node.selectionStart,
      })),
      { value: 'label:"release 0.4"', focused: true, caret: 19 },
    );
  } finally {
    await browser.close();
  }
});

test('keyed sessions and cards survive insertions, reorder, selection, and disclosure state', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setViewportSize({ width: 700, height: 260 });
    await page.setContent(pageHtml());
    const payload = twoSessionPayload();
    await post(page, payload);
    const firstKey = payload.cards[0].key;
    const secondSessionKey = payload.cards[payload.cards.length - 1].key;
    await page.evaluate(`
      window.__identity = {
        session: document.querySelector('section.sessionsection[data-session="s1"]'),
        card: [...document.querySelectorAll('[data-key]')].find((node) => node.dataset.key === ${JSON.stringify(firstKey)}),
        control: [...document.querySelectorAll('[data-control]')].find((node) => node.dataset.control === ${JSON.stringify(`card:${firstKey}`)}),
      };
    `);
    await page.locator(`[data-control=${JSON.stringify(`card:${firstKey}`)}]`).focus();
    await page
      .locator(`[data-control=${JSON.stringify(`card:${firstKey}`)}]`)
      .evaluate((node: HTMLElement) => node.click());
    const selectedText = await page.evaluate(`(() => {
      const text = window.__identity.card.querySelector('.summary');
      const range = document.createRange();
      range.selectNodeContents(text);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    })()`);

    const inserted = {
      ...payload.cards[0],
      key: 's1:background-insert',
      headline: 'A background insertion arrives ahead of the selected card.',
    };
    const readingKey = payload.cards[3].key;
    await page.locator(`[data-key=${JSON.stringify(readingKey)}]`).scrollIntoViewIfNeeded();
    const readingTop = await page
      .locator(`[data-key=${JSON.stringify(readingKey)}]`)
      .evaluate((node) => node.getBoundingClientRect().top);
    const reordered = {
      ...payload,
      cards: [payload.cards[payload.cards.length - 1], inserted, ...payload.cards.slice(0, -1)],
    } as Payload;
    await post(page, reordered);

    const state = await page.evaluate<{
      sameSession: boolean;
      sameCard: boolean;
      sameControl: boolean;
      firstSession?: string;
      expanded: string | null;
      selection?: string;
      keys: string[];
      activeControl?: string;
      tabStops: string[];
    }>(`(() => {
      const held = window.__identity;
      return {
        sameSession: held.session === document.querySelector('section.sessionsection[data-session="s1"]'),
        sameCard: held.card === [...document.querySelectorAll('[data-key]')].find((node) => node.dataset.key === ${JSON.stringify(firstKey)}),
        sameControl: held.control === [...document.querySelectorAll('[data-control]')].find((node) => node.dataset.control === ${JSON.stringify(`card:${firstKey}`)}),
        firstSession: document.querySelector('section.sessionsection')?.dataset.session,
        expanded: held.control.getAttribute('aria-expanded'),
        selection: window.getSelection()?.toString(),
        keys: [...document.querySelectorAll('.turn:not(.clive), .compaction')].map((node) => node.dataset.key),
        activeControl: document.activeElement?.dataset.control,
        tabStops: [...document.querySelectorAll('main#list .session, main#list .sessionlabelact, main#list .head:not(.livehead):not(.statichead), main#list .statdetail')]
          .filter((node) => !node.closest('[hidden]') && node.tabIndex === 0)
          .map((node) => node.dataset.control),
      };
    })()`);
    assert.deepEqual(state, {
      sameSession: true,
      sameCard: true,
      sameControl: true,
      firstSession: 's2',
      expanded: 'true',
      selection: selectedText,
      keys: reordered.cards.map((card) => card.key),
      activeControl: `card:${firstKey}`,
      tabStops: [`card:${firstKey}`],
    });
    const afterReadingTop = await page
      .locator(`[data-key=${JSON.stringify(readingKey)}]`)
      .evaluate((node) => node.getBoundingClientRect().top);
    assert.ok(Math.abs(afterReadingTop - readingTop) < 1);
    assert.equal(state.keys[0], secondSessionKey);
  } finally {
    await browser.close();
  }
});

test('a selected range across cards waits for a reorder to release it', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const payload = renderPayload() as Payload;
    payload.cards = payload.cards.slice(0, 3);
    await post(page, payload);
    for (const card of payload.cards.slice(0, 2)) {
      await page.locator(`[data-control=${JSON.stringify(`card:${card.key}`)}]`).click();
    }
    const selected = await page.evaluate(`(() => {
      const cards = [...document.querySelectorAll('article.turn')];
      const start = cards[0].querySelector('.summary p').firstChild;
      const end = cards[1].querySelector('.summary p').firstChild;
      const range = document.createRange();
      range.setStart(start, 0);
      range.setEnd(end, end.textContent.length);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    })()`);
    const reordered = { ...payload, cards: [payload.cards[1], payload.cards[0], payload.cards[2]] } as Payload;
    await post(page, reordered);
    assert.equal(await page.evaluate(`getSelection().toString()`), selected);
    assert.deepEqual(
      await page.locator('article.turn').evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.key)),
      payload.cards.map((card) => card.key),
    );

    await page.evaluate(`(() => {
      getSelection().removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
    })()`);
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await page.locator('article.turn').evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.key)),
      reordered.cards.map((card) => card.key),
    );
  } finally {
    await browser.close();
  }
});

for (const gainsBody of [true, false]) {
  for (const held of [false, true]) {
    test(`the bulk turn press follows ${held ? 'deferred' : 'local'} Activity body ${gainsBody ? 'arrival' : 'removal'}`, async (t) => {
      const browser = await browserOrNone();
      if (!browser) {
        t.skip('Edge or Chrome is required');
        return;
      }
      const page = await browser.newPage();
      try {
        await page.setContent(themed(pageHtml()));
        const { payload, original, changed, peer } = interruptedActivityPayload();
        if (!gainsBody) payload.cards[0] = changed;
        await post(page, payload);
        const row = page.locator(`.sessionrow[data-session=${JSON.stringify(peer.sessionId)}]`);
        // Whether the session menu offers Expand every shown turn, which it does while some turn is shut.
        const offersExpand = async () =>
          (JSON.parse((await row.getAttribute('data-vscode-context')) ?? '{}') as { sessionTurnsShut?: boolean })
            .sessionTurnsShut === true;
        const newest = page.locator(`[data-key=${JSON.stringify(original.key)}]`);
        const older = page.locator(`[data-key=${JSON.stringify(peer.key)}]`);
        const shiftPress = () => older.locator('button.head').click({ modifiers: ['Shift'] });
        if (!gainsBody) await older.locator('button.head').click();
        assert.equal(await offersExpand(), true);
        if (held) {
          await newest.locator('.headline').evaluate((node) => {
            const range = document.createRange();
            range.selectNodeContents(node);
            getSelection()!.removeAllRanges();
            getSelection()!.addRange(range);
            document.dispatchEvent(new Event('selectionchange'));
          });
        }
        await post(page, { type: 'activity', session: original.sessionId, card: gainsBody ? changed : original });
        if (held) {
          assert.equal(await offersExpand(), true, 'held Activity changed the session menu before publication');
          await page.evaluate(() => {
            getSelection()!.removeAllRanges();
            document.dispatchEvent(new Event('selectionchange'));
          });
          await page.evaluate(SETTLED);
        }
        assert.equal(
          await offersExpand(),
          gainsBody,
          'published Activity left stale body availability in the session menu',
        );
        const line = gainsBody ? CARD_ACTIONS.expandShownDetail : CARD_ACTIONS.collapseShownDetail;
        assert.ok((await older.locator('button.head').getAttribute('data-hint-detail'))!.endsWith(line));
        if (gainsBody) {
          await shiftPress();
          assert.equal(
            await newest.locator('button.head').getAttribute('aria-expanded'),
            'true',
            'Shift on a turn head omitted the first Activity body',
          );
          assert.equal(await older.locator('button.head').getAttribute('aria-expanded'), 'true');
          assert.equal(await newest.locator('.body').isVisible(), true);
          assert.equal(await older.locator('.body').isVisible(), true);
          assert.equal(await offersExpand(), false);
          assert.ok(
            (await older.locator('button.head').getAttribute('data-hint-detail'))!.endsWith(
              CARD_ACTIONS.collapseShownDetail,
            ),
          );
        }
        await shiftPress();
        assert.equal(await older.locator('button.head').getAttribute('aria-expanded'), 'false');
        if (gainsBody) assert.equal(await newest.locator('button.head').getAttribute('aria-expanded'), 'false');
        assert.equal(await offersExpand(), true);
        assert.ok(
          (await older.locator('button.head').getAttribute('data-hint-detail'))!.endsWith(
            CARD_ACTIONS.expandShownDetail,
          ),
        );
      } finally {
        await browser.close();
      }
    });
  }
}

test('a full render removes locally published Activity when the original card returns', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(themed(pageHtml()));
    const payload = renderPayload() as Payload;
    payload.cards = [payload.cards[0]];
    const original = structuredClone(payload);
    const card = payload.cards[0];
    await post(page, payload);
    await page.locator(`[data-control=${JSON.stringify(`card:${card.key}`)}]`).click();
    await post(page, original);
    const changed = {
      ...card,
      headline: 'Locally published response.',
      summaryHtml: '<p>Locally published response.</p>',
    };
    await post(page, { type: 'activity', session: card.sessionId, card: changed });
    assert.equal(await page.locator('article.turn .summary').first().textContent(), 'Locally published response.');
    await post(page, original);
    assert.equal(
      await page.locator('article.turn .headline').textContent(),
      card.headline,
      'full render retained the local Activity headline',
    );
    assert.equal(
      await page.locator('article.turn .summary').first().innerHTML(),
      card.summaryHtml,
      'full render retained the local Activity response',
    );
  } finally {
    await browser.close();
  }
});

for (const hold of ['selection', 'comment press', 'comment edit']) {
  test(`a full render preserves locally published content during ${hold}`, async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('Edge or Chrome is required');
      return;
    }
    const page = await browser.newPage();
    try {
      await page.setContent(
        themed(pageHtml())
          .replace('window.__posted = [];', 'window.__posted = []; window.__localCardDraws = 0;')
          .replace(/([A-Za-z_$][\w$]*)\.beforeCardDraw\(([^)]*)\)/g, '(window.__localCardDraws++, $&)'),
      );
      const payload = renderPayload() as Payload;
      payload.cards = [payload.cards[0]];
      const card = payload.cards[0];
      payload.comments = [
        {
          id: 'local-comment',
          sessionId: card.sessionId,
          turnKey: card.key,
          part: 'summary',
          quote: 'Missing quoted words.',
          note: 'Keep this comment open.',
          headline: card.headline,
          sessionTitle: card.sessionTitle || '',
          turnAt: card.startedAt || 1,
          at: 2,
        },
      ];
      await post(page, payload);
      await page.locator(`[data-control=${JSON.stringify(`card:${card.key}`)}]`).click();
      const changed = {
        ...card,
        headline: 'Locally published response.',
        summaryHtml: '<p>Locally published response.</p>',
      };
      await post(page, { type: 'activity', session: card.sessionId, card: changed });
      const draws = await page.evaluate('window.__localCardDraws');
      await page.evaluate(`window.__localSummary = document.querySelector('article.turn .summary')`);
      if (hold === 'selection') {
        await page.evaluate(
          `(() => { const range = document.createRange(); range.selectNodeContents(window.__localSummary.querySelector('p')); getSelection().removeAllRanges(); getSelection().addRange(range); document.dispatchEvent(new Event('selectionchange')); })()`,
        );
      } else {
        await page.locator('.offlinemark').click();
        if (hold === 'comment edit') {
          await page.locator('.markfloat [data-control="noteedit:local-comment"]').click();
          await page.locator('.markfloat .notearea').fill('Unsaved comment words.');
        } else {
          await page.locator('.markfloat .noteact').first().dispatchEvent('mousedown', { button: 0, buttons: 1 });
        }
        await page.evaluate(
          `window.__localList = document.querySelector('.markfloat'); window.__localEditor = document.querySelector('.markfloat .notearea')`,
        );
      }
      await post(page, { ...payload, cards: [changed] });
      assert.equal(
        await page.evaluate('window.__localCardDraws'),
        draws,
        'same-content full render redrew held locally published content',
      );
      assert.equal(
        await page.evaluate(`document.querySelector('article.turn .summary') === window.__localSummary`),
        true,
        'same-content full render rewrote held locally published content',
      );
      if (hold === 'selection') {
        assert.equal(await page.evaluate('getSelection().toString()'), 'Locally published response.');
      } else {
        assert.equal(
          await page.locator('.markfloat').isVisible(),
          true,
          'same-content full render closed the held comment list',
        );
        if (hold === 'comment edit') {
          assert.equal(
            await page.evaluate(`document.querySelector('.markfloat .notearea') === window.__localEditor`),
            true,
          );
          assert.equal(await page.locator('.markfloat .notearea').inputValue(), 'Unsaved comment words.');
        }
      }
    } finally {
      await browser.close();
    }
  });
}

test('one Activity list updates two sessions while preserving focus and selected text', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(
      themed(
        pageHtml().replace(
          'window.__posted = [];',
          'window.__posted = []; window.__timelineDraws = 0; window.__arcOnDraw = (owner) => { if (owner === "timeline") window.__timelineDraws++; };',
        ),
      ),
    );
    const payload = twoSessionPayload();
    await post(page, payload);
    const first = payload.cards[0];
    const second = payload.cards.at(-1)!;
    const control = page.locator(`[data-control=${JSON.stringify(`card:${payload.cards[1].key}`)}]`);
    await control.click();
    const selected = await page.evaluate(`(() => {
      window.__batchFocus = document.activeElement;
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('[data-key="${payload.cards[1].key}"] .summary p'));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return getSelection().toString();
    })()`);
    const before = await page.evaluate<number>('window.__timelineDraws');
    const cards = [
      { ...first, headline: 'The first dispatched cost settled.' },
      { ...second, headline: 'The second dispatched cost settled.' },
    ];
    await post(page, { type: 'activity', cards });
    for (const card of cards) {
      assert.equal(await page.locator(`[data-key=${JSON.stringify(card.key)}] .headline`).textContent(), card.headline);
    }
    assert.equal(await page.evaluate('window.__timelineDraws'), before + 1);
    assert.equal(await page.evaluate('document.activeElement === window.__batchFocus'), true);
    assert.equal(await page.evaluate('getSelection().toString()'), selected);
  } finally {
    await browser.close();
  }
});

test('a settled Activity batch survives release of an older single-card update', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  try {
    for (const theme of ['dark', 'light'] as const) {
      const page = await browser.newPage();
      await page.setContent(themed(pageHtml(), theme));
      const payload = renderPayload() as Payload;
      const card = payload.cards[0];
      payload.cards = [card];
      await post(page, payload);
      await page.locator(`[data-control=${JSON.stringify(`card:${card.key}`)}]`).click();
      await page.evaluate(`(() => {
        const range = document.createRange();
        range.selectNodeContents(document.querySelector('article.turn .summary p'));
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
      })()`);
      const withCost = (label: string) => {
        const updated = structuredClone(card);
        const cost = (updated.chips as Array<Record<string, unknown>>).find((chip) => chip.metric === 'cost')!;
        cost.label = label;
        return updated;
      };
      await post(page, { type: 'activity', session: card.sessionId, card: withCost('$12.34+') });
      await page.evaluate(`(() => {
        window.__blockSelectionChange = (event) => event.stopImmediatePropagation();
        document.addEventListener('selectionchange', window.__blockSelectionChange, true);
        getSelection().removeAllRanges();
      })()`);
      await post(page, { type: 'activity', cards: [withCost('$56.78')] });
      const cost = page.locator('article.turn button.statchip[data-metric="cost"]');
      assert.equal(await cost.textContent(), '$56.78');
      await page.evaluate(`(() => {
        document.removeEventListener('selectionchange', window.__blockSelectionChange, true);
        document.dispatchEvent(new Event('selectionchange'));
      })()`);
      await page.waitForFunction(() => getSelection()?.isCollapsed);
      assert.equal(await cost.textContent(), '$56.78', `${theme}: release restored an older cost`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('Activity updates an unheld running card while another card waits for a full render', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(themed(pageHtml()));
    const payload = renderPayload() as Payload;
    payload.cards = [payload.cards[0]];
    const first = payload.cards[0];
    await post(page, payload);
    await page.locator(`[data-control=${JSON.stringify(`card:${first.key}`)}]`).click();
    const selected = await page.evaluate(
      `(() => { const range = document.createRange(); range.selectNodeContents(document.querySelector('article.turn .summary p')); getSelection().removeAllRanges(); getSelection().addRange(range); document.dispatchEvent(new Event('selectionchange')); return getSelection().toString(); })()`,
    );
    const second = { ...first, key: 's1:unheld-running', status: 'running', headline: 'New running card.' };
    const newest = { ...payload, cards: [{ ...first, headline: 'First card after release.' }, second] };
    await post(page, newest);
    const updated = { ...second, headline: 'Running Activity during another card hold.' };
    await post(page, { type: 'activity', session: second.sessionId, card: updated });
    assert.equal(
      await page.locator('[data-key="s1:unheld-running"] .headline').textContent(),
      updated.headline,
      'another card retry blocked running Activity',
    );
    assert.equal(await page.locator(`[data-key=${JSON.stringify(first.key)}] .headline`).textContent(), first.headline);
    assert.equal(await page.evaluate('getSelection().toString()'), selected);
    await page.evaluate(`getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange'))`);
    await page.evaluate(SETTLED);
    assert.equal(
      await page.locator(`[data-key=${JSON.stringify(first.key)}] .headline`).textContent(),
      newest.cards[0].headline,
    );
    assert.equal(await page.locator('[data-key="s1:unheld-running"] .headline').textContent(), updated.headline);
  } finally {
    await browser.close();
  }
});

for (const laterActivity of [false, true]) {
  test(`a deferred full render preserves Activity order ${laterActivity ? 'after' : 'before'} replacement`, async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('Edge or Chrome is required');
      return;
    }
    const page = await browser.newPage();
    try {
      await page.setContent(pageHtml());
      const payload = renderPayload() as Payload;
      payload.cards = payload.cards.slice(0, 3);
      await post(page, payload);
      for (const card of payload.cards.slice(0, 2)) {
        await page.locator(`[data-control=${JSON.stringify(`card:${card.key}`)}]`).click();
      }
      const selected = await page.evaluate(`(() => {
      const cards = [...document.querySelectorAll('article.turn')];
      const start = cards[0].querySelector('.summary p').firstChild;
      const end = cards[1].querySelector('.summary p').firstChild;
      const range = document.createRange();
      range.setStart(start, 0);
      range.setEnd(end, end.textContent.length);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return selection.toString();
    })()`);

      const queuedActivity = {
        ...payload.cards[1],
        headline: 'Queued activity headline.',
      };
      await post(page, {
        type: 'activity',
        session: queuedActivity.sessionId,
        card: queuedActivity,
      });
      const newest = {
        ...payload,
        cards: [payload.cards[0], { ...payload.cards[1], headline: 'Newest full-render headline.' }],
      } as Payload;
      await post(page, newest);
      if (laterActivity) {
        await post(page, {
          type: 'activity',
          session: queuedActivity.sessionId,
          card: { ...newest.cards[1], headline: 'Newest Activity headline.' },
        });
      }
      assert.deepEqual(
        await page
          .locator('article.turn')
          .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.key)),
        payload.cards.map((card) => card.key),
      );
      assert.equal(await page.evaluate(`getSelection().toString()`), selected);

      await page.evaluate(`(() => {
      getSelection().removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
    })()`);
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page
          .locator('article.turn')
          .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.key)),
        newest.cards.map((card) => card.key),
      );
      assert.equal(
        await page.locator(`[data-key=${JSON.stringify(payload.cards[1].key)}] .headline`).textContent(),
        laterActivity ? 'Newest Activity headline.' : 'Newest full-render headline.',
      );
    } finally {
      await browser.close();
    }
  });
}

test('a range from a session heading waits for its session to move', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const payload = twoSessionPayload();
    await post(page, payload);
    const first = payload.cards[0];
    await page.locator(`[data-control=${JSON.stringify(`card:${first.key}`)}]`).click();
    const selected = await page.evaluate(`(() => {
      const session = document.querySelector('section.sessionsection[data-session="s1"]');
      const start = session.querySelector('.session .name').firstChild;
      const end = session.querySelector('.summary p').firstChild;
      const range = document.createRange();
      range.setStart(start, 0);
      range.setEnd(end, end.textContent.length);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    })()`);
    const reordered = {
      ...payload,
      cards: [payload.cards[payload.cards.length - 1], ...payload.cards.slice(0, -1)],
    } as Payload;
    await post(page, reordered);
    assert.equal(await page.evaluate(`getSelection().toString()`), selected);
    assert.equal(await page.locator('section.sessionsection').first().getAttribute('data-session'), 's1');

    await page.evaluate(`(() => {
      getSelection().removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
    })()`);
    await page.evaluate(SETTLED);
    assert.equal(await page.locator('section.sessionsection').first().getAttribute('data-session'), 's2');
  } finally {
    await browser.close();
  }
});

test('a visible reading anchor and the active-item fallback survive list changes', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setViewportSize({ width: 700, height: 500 });
    await page.setContent(pageHtml());
    const payload = renderPayload() as Payload;
    payload.cards = payload.cards.slice(0, 12);
    await post(page, payload);
    const anchorKey = payload.cards[6].key;
    await page.locator(`[data-key=${JSON.stringify(anchorKey)}]`).scrollIntoViewIfNeeded();
    const beforeTop = await page
      .locator(`[data-key=${JSON.stringify(anchorKey)}]`)
      .evaluate((node) => node.getBoundingClientRect().top);
    const inserted = {
      ...payload.cards[0],
      key: 's1:reading-anchor-insert',
      headline: 'Inserted above the visible reading anchor.',
    };
    await post(page, { ...payload, cards: [inserted, ...payload.cards] });
    const afterTop = await page
      .locator(`[data-key=${JSON.stringify(anchorKey)}]`)
      .evaluate((node) => node.getBoundingClientRect().top);
    assert.ok(Math.abs(afterTop - beforeTop) < 1);

    const removed = payload.cards[4];
    const expected = payload.cards[5];
    const compaction = {
      ...removed,
      key: 's1:removal-compaction',
      kind: 'compaction',
      headline: 'A compaction between the removed turn and its next surviving turn.',
    };
    const removalCards = [...payload.cards.slice(0, 5), compaction, ...payload.cards.slice(5)];
    await post(page, { ...payload, cards: removalCards });
    await page.locator(`[data-control=${JSON.stringify(`card:${removed.key}`)}]`).focus();
    let surviving = removalCards.filter((card) => card.key !== removed.key);
    await post(page, { ...payload, cards: surviving });
    assert.deepEqual(
      await page.evaluate(`({
      control: document.activeElement?.dataset.control,
      tabIndex: document.activeElement?.tabIndex,
    })`),
      { control: `card:${expected.key}`, tabIndex: 0 },
    );

    const last = [...surviving].reverse().find((card) => card.kind !== 'compaction')!;
    const previous = surviving
      .slice(0, surviving.indexOf(last))
      .reverse()
      .find((card) => card.kind !== 'compaction')!;
    await page.locator(`[data-control=${JSON.stringify(`card:${last.key}`)}]`).focus();
    surviving = surviving.filter((card) => card.key !== last.key);
    await post(page, { ...payload, cards: surviving });
    assert.deepEqual(
      await page.evaluate(`({
      control: document.activeElement?.dataset.control,
      tabIndex: document.activeElement?.tabIndex,
    })`),
      { control: `card:${previous.key}`, tabIndex: 0 },
    );

    await page.locator(`[data-control=${JSON.stringify(`card:${previous.key}`)}]`).focus();
    await post(page, {
      ...payload,
      cards: [],
      sessions: [],
      stats: {},
      showing: null,
      usage: { ...payload.usage, composer: null },
    });
    assert.deepEqual(
      await page.evaluate(`(() => {
      const active = document.activeElement;
      const controls = [...document.querySelector('#list').querySelectorAll('.session, .sessionlabelact, .head:not(.livehead):not(.statichead), .statdetail, .result, .cliveoff, .cwaitingact')]
        .filter((node) => !node.closest('[hidden]'));
      return {
        connected: active?.isConnected,
        body: active === document.body,
        tabIndex: active?.tabIndex,
        tabStops: controls.filter((node) => node.tabIndex === 0).length,
      };
    })()`),
      { connected: true, body: false, tabIndex: 0, tabStops: 0 },
    );
  } finally {
    await browser.close();
  }
});

test('removing the last turn never hands focus to a compaction', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const payload = renderPayload() as Payload;
    const turn = payload.cards[0];
    const compaction = { ...turn, key: 's1:only-compaction', kind: 'compaction' };
    await post(page, { ...payload, cards: [turn, compaction] });
    await page.locator(`[data-control=${JSON.stringify(`card:${turn.key}`)}]`).focus();
    await post(page, { ...payload, cards: [compaction] });
    assert.equal(await page.evaluate(`document.activeElement?.closest('.compaction') !== null`), false);
  } finally {
    await browser.close();
  }
});

test('a bodyless survivor does not block focus from reaching the next disclosure', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const payload = renderPayload() as Payload;
    const removed = payload.cards[0];
    const bodyless = bodylessCard(payload.cards[1], 's1:bodyless-survivor');
    const expected = payload.cards[2];
    await post(page, { ...payload, cards: [removed, bodyless, expected] });
    await page.locator(`[data-control=${JSON.stringify(`card:${removed.key}`)}]`).focus();
    await post(page, { ...payload, cards: [bodyless, expected] });
    assert.equal(await page.evaluate(`document.activeElement?.dataset.control`), `card:${expected.key}`);
  } finally {
    await browser.close();
  }
});

test('an unchanged background render keeps focus on the older-history control', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const payload = renderPayload() as Payload;
    payload.olderHistory = {
      kind: 'load',
      label: 'Load older turns',
      name: 'Load older turns. 40 turns loaded now.',
      token: 'older-test',
      session: 's1',
      auto: false,
    };
    await post(page, payload);
    await page.locator('[data-control="olderHistory"]').focus();
    await page.evaluate(`window.__olderNode = document.querySelector('[data-control="olderHistory"]')`);
    await post(page, structuredClone(payload));
    assert.deepEqual(
      await page.evaluate(`({
      control: document.activeElement?.dataset.control,
      text: document.activeElement?.textContent,
    })`),
      { control: 'olderHistory', text: 'Load older turns' },
    );
    assert.equal(
      await page.evaluate(`window.__olderNode === document.querySelector('[data-control="olderHistory"]')`),
      true,
    );
    for (const width of [600, 1000]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(SETTLED);
      assert.equal(
        await page.evaluate(`window.__olderNode === document.querySelector('[data-control="olderHistory"]')`),
        true,
        'a visibility change replaced unchanged history controls',
      );
      assert.equal(await page.evaluate(`document.activeElement === window.__olderNode`), true);
    }
    const changed = structuredClone(payload);
    changed.olderHistory = {
      ...payload.olderHistory!,
      name: 'Load another session history',
      token: 'changed-token',
      session: 's2',
    };
    await post(page, changed);
    const older = page.locator('[data-control="olderHistory"]');
    assert.equal(await older.getAttribute('aria-label'), 'Load another session history');
    await older.click();
    assert.deepEqual(await page.evaluate(`window.__posted.filter(message => message.type === 'loadOlder')`), [
      { type: 'loadOlder', session: 's2', token: 'changed-token' },
    ]);
    await older.focus();
    await post(page, { ...changed, olderHistory: null });
    assert.equal(
      await page.evaluate(
        `document.activeElement.isConnected && document.activeElement !== document.body && !document.activeElement.closest('[hidden]')`,
      ),
      true,
    );
    await post(page, payload);
    await page.locator('[data-control="olderHistory"]').focus();
    const updated = structuredClone(payload.cards[0]);
    updated.headline = 'Activity refreshed this keyed card.';
    await post(page, { type: 'activity', session: updated.sessionId, card: updated });
    assert.deepEqual(
      await page.evaluate(`(() => ({
      focused: document.activeElement?.dataset.control,
      rovingStops: [...document.querySelector('#list').querySelectorAll('.session, .sessionlabelact, .head:not(.livehead):not(.statichead), .statdetail, .result, .cliveoff, .cwaitingact')]
        .filter((node) => !node.closest('[hidden]') && node.tabIndex === 0).length,
    }))()`),
      { focused: 'olderHistory', rovingStops: 1 },
    );
  } finally {
    await browser.close();
  }
});

test('a folded card draws inline markdown in its headline, and a plain update drops it', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const payload = renderPayload() as Payload;
    await post(page, payload);
    const key = payload.cards[0].key;
    const headline = page.locator(`[data-key=${JSON.stringify(key)}] .headline`);

    const withMarkup = {
      ...structuredClone(payload.cards[0]),
      headline: 'Ran npm test and all pass.',
      headlineHtml: 'Ran <code>npm test</code> and <strong>all</strong> pass.',
    };
    await post(page, { type: 'activity', session: withMarkup.sessionId, card: withMarkup });
    assert.equal(await headline.locator('code').count(), 1);
    assert.doesNotMatch((await headline.textContent()) ?? '', /`/);
    assert.equal((await headline.textContent())?.trim(), 'Ran npm test and all pass.');

    const plain = { ...withMarkup, headline: 'Ran npm test, no markup this time.', headlineHtml: undefined };
    await post(page, { type: 'activity', session: plain.sessionId, card: plain });
    assert.equal(await headline.locator('code').count(), 0);
    assert.equal((await headline.textContent())?.trim(), 'Ran npm test, no markup this time.');

    await post(page, { type: 'activity', session: withMarkup.sessionId, card: withMarkup });
    assert.equal(await headline.locator('code').count(), 1);
    assert.equal((await headline.textContent())?.trim(), 'Ran npm test and all pass.');
  } finally {
    await browser.close();
  }
});

test('the session menu entries open and close every shown turn and follow each read change', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const payload = renderPayload() as Payload;
    await post(page, payload);
    const session = page.locator('section.sessionsection').first();
    const id = (await session.getAttribute('data-session'))!;
    const row = session.locator('.sessionrow');
    const offers = async () => {
      const context = JSON.parse((await row.getAttribute('data-vscode-context')) ?? '{}') as Record<string, unknown>;
      return { expand: context.sessionTurnsShut === true, collapse: context.sessionTurnsOpen === true };
    };
    const lastHead = session.locator('article.turn button.head').last();
    assert.deepEqual(
      await offers(),
      { expand: true, collapse: false },
      'the menu offers a collapse with every turn shut',
    );

    // Expand every shown turn arrives from the native menu as a host message.
    await post(page, { type: 'setSessionTurnsOpen', session: id, open: true });
    await page.evaluate(SETTLED);
    const bodies = await session.locator('article.turn.has-body').count();
    assert.ok(bodies > 1, `the session drew ${bodies} turns with a body, so this measures nothing`);
    assert.equal(await session.locator('article.turn.has-body.is-open').count(), bodies, 'Expand left a turn shut');
    assert.equal(
      await session.locator('article.turn.has-body.is-open:not(.running)').count(),
      await session.locator('article.turn.has-body.is-open.is-read:not(.running)').count(),
      'Expand opened turns without marking them read',
    );
    assert.deepEqual(
      await offers(),
      { expand: false, collapse: true },
      'the menu still offers Expand with every turn open',
    );
    assert.ok((await lastHead.getAttribute('data-hint-detail'))!.endsWith(CARD_ACTIONS.collapseShownDetail));

    // Marking one open turn unread closes it, so the menu offers Expand again and the Shift line says so.
    const key = await session.locator('article.turn.is-open.is-read').first().getAttribute('data-key');
    assert.ok(key);
    await post(page, { type: 'setRead', key, read: false });
    await page.evaluate(SETTLED);
    assert.deepEqual(await offers(), { expand: true, collapse: true });
    assert.ok(
      (await lastHead.getAttribute('data-hint-detail'))!.endsWith(CARD_ACTIONS.expandShownDetail),
      'a turn head still offers to collapse every turn after one of them closed',
    );

    // Collapse every shown turn closes the rest.
    await post(page, { type: 'setSessionTurnsOpen', session: id, open: false });
    await page.evaluate(SETTLED);
    assert.equal(await session.locator('article.turn.is-open').count(), 0, 'Collapse left a turn open');
    assert.deepEqual(
      await offers(),
      { expand: true, collapse: false },
      'the menu offers Collapse with every turn shut',
    );
  } finally {
    await browser.close();
  }
});

// A session named by a long first prompt, with a path, slash commands and a closing parenthesis.
const LONG_NAME =
  'C:/Users/greg/Documents/arc/.claude/plans/2026/10/2026-10-24-arc-start-session-link/plan.md /review this plan again, ' +
  'get a sol high review too then /ship it if it makes sense. also see claude sesion 10d8aebf-803c-465d-b2ed-365386af7d7c ' +
  '/close-session and archive it if everyhthing there is done, you were taking over (urgent)';

test('starting worktree links stay passive in hints and activate exact pinned destinations through updates', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('A browser is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(themed(pageHtml()));
    const payload = renderPayload() as Payload;
    const path = 'C:/Trees/é space#L10';
    payload.sessions[0].fullLabel = 'Name '.repeat(820);
    payload.sessions[0].startWorktree = { name: 'é space#L10', path };
    await post(page, payload);
    const heading = page.locator('#list button.session').first();
    const pop = page.locator('#chippop');
    await heading.focus();
    await page.locator('#hintpop').waitFor({ state: 'visible' });
    assert.match((await page.locator('#hintpop .hintdetail').textContent())!, /Started in é space#L10/);
    assert.equal(await page.locator('#hintpop a').count(), 0);
    await page.keyboard.press('Enter');
    await pop.waitFor({ state: 'visible' });
    const link = pop.locator('a.sessionworktreelink');
    assert.equal(await pop.getAttribute('role'), 'dialog');
    assert.equal(await pop.locator('.sessionworktreedestination').textContent(), path);
    await page.keyboard.press('Tab');
    await page.waitForFunction(() => document.activeElement?.classList.contains('sessionworktreelink'));
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#chippop')!.scrollTop > 0);
    await page.evaluate('window.__posted.length = 0');
    await page.keyboard.press('Enter');
    await link.click();
    assert.deepEqual(await page.evaluate('window.__posted.filter(m => m.type === "openDirectory")'), [
      { type: 'openDirectory', path },
      { type: 'openDirectory', path },
    ]);
    payload.sessions[0].fullLabel = 'Renamed session';
    await post(page, payload);
    assert.equal(await link.evaluate((node) => node === document.activeElement), true);
    assert.equal(await pop.locator('.chippopname').textContent(), 'Renamed session');
    await page.evaluate(() => {
      const node = document.querySelector('.sessionworktreedestination')!;
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    assert.equal(await page.evaluate(() => getSelection()!.toString()), path);
    await page.evaluate(() => getSelection()!.removeAllRanges());
    await link.focus();
    delete payload.sessions[0].startWorktree;
    await post(page, payload);
    assert.equal(await pop.locator('.sessionworktree').count(), 0);
    assert.equal(await pop.evaluate((node) => node.contains(document.activeElement)), true);
    await page.keyboard.press('Escape');
    await pop.waitFor({ state: 'hidden' });
    assert.equal(await heading.evaluate((node) => node === document.activeElement), true);
    await post(page, payload);
    await heading.click();
    await pop.waitFor({ state: 'visible' });
    assert.equal(await pop.locator('.sessionworktree').count(), 0);
    await page.locator('#prompt').click();
    await pop.waitFor({ state: 'hidden' });
  } finally {
    await browser.close();
  }
});

test('a press on the session heading pins its whole name open, and the chip close rules shut it', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const payload = renderPayload() as Payload;
    payload.sessions[0].fullLabel = LONG_NAME;
    await post(page, payload);
    const heading = page.locator('#list button.session').first();
    const pop = page.locator('#chippop');
    const hint = page.locator('#hintpop');

    // Focus shows the name hint, drawn as prose: the parenthesis stays in the name and the path breaks at its slashes.
    await heading.focus();
    await page.waitForFunction(() => !document.querySelector<HTMLElement>('#hintpop')!.hidden);
    assert.equal(await hint.getAttribute('class').then((name) => /\bhintprose\b/.test(name ?? '')), true);
    assert.equal(await hint.locator('.hintkey').count(), 0, 'the hint drew "(urgent)" as a shortcut key');
    assert.ok(((await hint.locator('.hinttitle').textContent()) ?? '').endsWith('(urgent)'));
    assert.ok(
      (await hint.locator('.hinttitle wbr').count()) > 5,
      'the hint gave the path no break between its folders',
    );
    assert.equal(await pop.isHidden(), true, 'focus opened the figure popover on the heading');

    // Enter pins the whole name. The hint closes so it does not cover the pinned box.
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#chippop')?.classList.contains('pinned') === true);
    assert.equal(await pop.isHidden(), false);
    assert.ok(((await pop.textContent()) ?? '').includes(LONG_NAME), 'the pinned box does not hold the whole name');
    assert.ok(
      (await pop.locator('.chippopname wbr').count()) > 5,
      'the pinned name gave the path no break between its folders',
    );
    assert.equal(await heading.getAttribute('aria-pressed'), 'true');
    assert.equal(await hint.isHidden(), true, 'the name hint stays open over the pinned box');
    assert.equal(await page.locator('#list article.turn.is-open').count(), 0, 'the heading press opened turns');

    // Escape closes it and focus returns to the heading.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#chippop')!.hidden);
    assert.equal(await heading.getAttribute('aria-pressed'), 'false');
    assert.equal(await heading.evaluate((node) => node === document.activeElement), true, 'focus left the heading');

    // A second press closes it, and a press elsewhere closes it too.
    await heading.click();
    await page.waitForFunction(() => document.querySelector('#chippop')?.classList.contains('pinned') === true);
    await heading.click();
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#chippop')!.hidden);
    await heading.click();
    await page.waitForFunction(() => document.querySelector('#chippop')?.classList.contains('pinned') === true);
    await page.locator('#list article.turn .headline').first().click();
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#chippop')!.hidden);
    assert.equal(await heading.getAttribute('aria-pressed'), 'false');
  } finally {
    await browser.close();
  }
});

test('the keyboard reaches the end of a pinned 4,094-character name after the shared box drew Context detail', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const payload = renderPayload() as Payload;
    const name = LONG_NAME.repeat(Math.ceil(4094 / LONG_NAME.length)).slice(0, 4094);
    payload.sessions[0].fullLabel = name;
    await post(page, payload);
    const heading = page.locator('#list button.session').first();
    const pop = page.locator('#chippop');
    // The Context detail leaves the shared box focusable only by script, outside the Tab order.
    await pop.evaluate((node) => {
      node.tabIndex = -1;
    });
    // The prompt box follows the timeline in the panel, so the box at the end of the body is never the next Tab stop.
    await page.evaluate(() => {
      const after = document.createElement('button');
      after.textContent = 'After the timeline';
      document.querySelector('#list')!.after(after);
    });

    await heading.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#chippop')?.classList.contains('pinned') === true);
    assert.equal(await pop.locator('.chippopname').textContent(), name, 'the pinned box does not hold the whole name');
    assert.ok(
      await pop.evaluate((node) => node.scrollHeight > node.clientHeight),
      'the pinned name fits in the box, so this measures no scrolling',
    );

    // Tab enters the box. Down scrolls it a step, and End scrolls it to the end of the name.
    await page.keyboard.press('Tab');
    await page.waitForFunction(() => document.activeElement?.id === 'chippop');
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#chippop')!.scrollTop > 0);
    await page.keyboard.press('End');
    await page.waitForFunction(() => {
      const node = document.querySelector<HTMLElement>('#chippop')!;
      return node.scrollTop > 0 && node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
    });

    // Tab leaves the box for the next control, and the box closes.
    await page.keyboard.press('Tab');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#chippop')!.hidden);
    assert.equal(
      await page.evaluate(() => document.activeElement !== document.body),
      true,
      'Tab from the pinned name dropped focus',
    );
  } finally {
    await browser.close();
  }
});

test('Shift with Space or Enter on a turn head opens or closes every shown turn, whichever key lifts first', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    await post(page, renderPayload());
    const session = page.locator('section.sessionsection').first();
    const bodies = await session.locator('article.turn.has-body').count();
    assert.ok(bodies > 1, `the session drew ${bodies} turns with a body, so this measures nothing`);
    const open = () => session.locator('article.turn.has-body.is-open').count();
    const head = session.locator('article.turn.has-body button.head').last();
    await head.focus();

    await page.keyboard.down('Shift');
    await page.keyboard.press('Space');
    await page.keyboard.up('Shift');
    await page.waitForFunction(
      (count) => document.querySelectorAll('article.turn.has-body.is-open').length === count,
      bodies,
    );

    await page.keyboard.press('Shift+Enter');
    await page.waitForFunction(() => document.querySelectorAll('article.turn.has-body.is-open').length === 0);

    // Shift lifts before Space. The Space keyup still belongs to the Shift press and toggles no single turn.
    await page.keyboard.down('Shift');
    await page.keyboard.down('Space');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Space');
    await page.evaluate(SETTLED);
    assert.equal(await open(), bodies, 'the Space keyup after Shift lifted toggled the focused turn again');

    // A plain Space still toggles the focused turn alone.
    await page.keyboard.press('Space');
    await page.waitForFunction(
      (count) => document.querySelectorAll('article.turn.has-body.is-open').length === count - 1,
      bodies,
    );
    assert.equal(await head.getAttribute('aria-expanded'), 'false');
  } finally {
    await browser.close();
  }
});

test('a session with no last activity time gives its name hint and its pinned name no detail line', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const payload = renderPayload() as Payload;
    payload.sessions[0].fullLabel = 'Greeting and location inquiry';
    payload.sessions[0].when = '';
    await post(page, payload);
    const heading = page.locator('#list button.session').first();
    assert.equal(await heading.getAttribute('data-hint-detail'), null);
    await heading.focus();
    await page.waitForFunction(() => !document.querySelector<HTMLElement>('#hintpop')!.hidden);
    assert.equal(
      await page.locator('#hintpop .hintdetail').isHidden(),
      true,
      'the name hint drew an empty detail line',
    );
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#chippop')?.classList.contains('pinned') === true);
    assert.deepEqual(
      await page.locator('#chippop .chippopline').allTextContents(),
      ['Greeting and location inquiry'],
      'the pinned name drew a detail line with no time in it',
    );
  } finally {
    await browser.close();
  }
});

test('the session heading puts cost before turns and names how many turns are drawn', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const payload = renderPayload() as Payload;
    // The fixture counts eight turns while this render draws three.

    payload.cards = payload.cards.slice(0, 3);
    await post(page, payload);

    assert.equal(await page.locator('.sessionrow .session .count').count(), 0, 'the heading still draws a count span');
    const heading = page.locator('section.sessionsection .sessionrow h2 button.session').first();
    const label = await heading.getAttribute('aria-label');
    assert.ok(label);
    assert.doesNotMatch(label, /\d+\s+turns?\b/i, `the heading name still says a turn count: "${label}"`);

    const metrics = await page
      .locator('section.sessionsection .sessionstats .statchip')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-metric')));
    assert.deepEqual(
      metrics.slice(0, 2),
      ['cost', 'turns'],
      `the session heading does not match the rail's cost-then-turns order: ${JSON.stringify(metrics)}`,
    );

    const turnsChip = page.locator('section.sessionsection .sessionstats [data-metric="turns"]');
    await turnsChip.click();
    assert.deepEqual(await page.locator('#chippop .chippopline').allTextContents(), [
      '8 turns in the main session. Delegated work does not add to this count.',
      '3 turns shown.',
    ]);
    await turnsChip.click();

    await turnsChip.evaluate((node) => (node as HTMLElement).blur());
    const structured = sessionTurnStats({ turnCount: 8, compactionCount: 2, firstTurnAt: 0, lastTurnAt: 600_000 })[0];
    payload.stats = {
      ...payload.stats,
      s1: payload.stats.s1.map((chip) => (chip.metric === 'turns' ? { ...structured } : chip)),
    };
    await post(page, payload);
    await turnsChip.focus();
    assert.match(await page.locator('#chippop').innerText(), /Turns shown\W*3/);
    assert.match(await page.locator('#chippop').innerText(), /Compactions\W*2/);
    await turnsChip.press('Enter');
    assert.equal(await turnsChip.getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#chippop').isHidden(), true);
    assert.equal(await turnsChip.evaluate((node) => document.activeElement === node), true);

    // All eight counted turns are drawn.
    await turnsChip.evaluate((node) => (node as HTMLElement).blur());
    const wholePayload = renderPayload() as Payload;
    wholePayload.cards = wholePayload.cards.slice(0, 8);
    await post(page, wholePayload);
    await turnsChip.click();
    assert.deepEqual(await page.locator('#chippop .chippopline').allTextContents(), [
      '8 turns in the main session. Delegated work does not add to this count.',
    ]);
  } finally {
    await browser.close();
  }
});

test('latest compaction stays with context and uses turns only as its fallback', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    page.setDefaultTimeout(5_000);
    await page.setContent(pageHtml());
    const removed =
      /Compaction request cost|Context reduction|First request input cost|Later requests|Future savings|Break-even|pricing scenarios/;
    for (const width of [1350, 340]) {
      await page.setViewportSize({ width, height: 900 });
      const payload = statPopoverPayload() as unknown as Payload;
      await post(page, payload);
      const context = page.locator('section.sessionsection .sessionstats [data-metric="context"]');
      await context.click();
      const contextPop = page.locator('#chippop');
      assert.equal(await context.getAttribute('aria-describedby'), 'chippop');
      assert.deepEqual(await contextPop.locator('.chippoplabel').allTextContents(), ['Context', 'Latest compaction']);
      assert.deepEqual(await contextPop.locator('.chippopvalue').allTextContents(), ['118k', 'Manual']);
      assert.doesNotMatch(await contextPop.innerText(), removed);
      assert.equal(
        await contextPop.evaluate((node) => node.scrollWidth > node.clientWidth),
        false,
        `context detail overflows at ${width}px`,
      );
      await page.keyboard.press('Escape');

      const fact: CompactionFact = {
        ordinal: 2,
        at: null,
        trigger: 'auto',
        contextBefore: null,
        contextAfter: null,
        requestsAfter: 0,
        firstRequestAfter: null,
        requestUsage: null,
        requestModel: null,
        requestProvider: null,
        requestServiceTier: null,
        requestContextWindow: null,
      };
      const turns = sessionTurnStats({ turnCount: 22, compactionCount: 3, firstTurnAt: 1, lastTurnAt: 600_001 });
      const fallback = withSessionContextDetail(turns, sessionCompactionContextDetail([fact]));
      payload.stats.s1 = fallback as unknown as Payload['stats']['s1'];
      await post(page, payload);
      const turnsChip = page.locator('section.sessionsection .sessionstats [data-metric="turns"]');
      await turnsChip.click();
      const turnsText = await contextPop.innerText();
      const turnValues = await contextPop.locator('.chippopitem .chippopvalue').allInnerTexts();
      for (const value of ['22', '10m', '3']) assert.ok(turnValues.includes(value), `${value} in ${turnValues}`);
      assert.match(turnsText, /About these figures/);
      assert.match(turnsText, /Latest compaction\s+Automatic/);
      assert.doesNotMatch(turnsText, removed);
      assert.equal(
        await contextPop.evaluate((node) => node.scrollWidth > node.clientWidth),
        false,
        `turns fallback detail overflows at ${width}px`,
      );
      await page.keyboard.press('Escape');
    }
  } finally {
    await browser.close();
  }
});

test('removing every turn in a narrow Panel focuses the compact New control', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setViewportSize({ width: 300, height: 500 });
    await page.setContent(pageHtml());
    const payload = renderPayload() as Payload;
    const turn = payload.cards[0];
    await post(page, { ...payload, cards: [turn] });
    await page.locator(`[data-control=${JSON.stringify(`card:${turn.key}`)}]`).focus();
    await post(page, {
      ...payload,
      cards: [],
      sessions: [],
      stats: {},
      showing: null,
      usage: { ...payload.usage, composer: null },
    });
    assert.equal(await page.evaluate(`document.activeElement?.classList.contains('compactnew')`), true);
  } finally {
    await browser.close();
  }
});

test('a comment editor holds a replacement view that a session change draws at once', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(
      themed(pageHtml()).replace(
        'window.__posted = [];',
        `window.__posted = [];
      window.__olderObserved = null;
      window.IntersectionObserver = class {
        constructor(callback) { window.__olderNotify = callback; }
        observe(node) { window.__olderObserved = node; }
        disconnect() { window.__olderObserved = null; }
      };`,
      ),
    );
    const payload = renderPayload() as Payload;
    const originalTurns = sessionTurnStats({
      turnCount: 32,
      compactionCount: 2,
      firstTurnAt: null,
      lastTurnAt: null,
    })[0];
    payload.stats = { ...payload.stats, s1: [{ ...originalTurns }] };
    payload.olderHistory = {
      kind: 'load',
      label: 'Load older turns',
      auto: true,
      token: 'drawn-history',
      session: 's1',
    };
    await post(page, payload);
    const key = payload.cards[0].key;
    const empty = {
      ...payload,
      cards: [],
      showing: 's2',
      olderHistory: { kind: 'load', label: 'Load older turns', auto: true, token: 'pending-history', session: 's2' },
      stats: {},
      usage: { ...payload.usage, composer: null },
    } as Payload;
    const replacement = structuredClone(payload);
    replacement.cards = [
      {
        ...replacement.cards[1],
        key: 's2:replacement-turn',
        sessionId: 's2',
        sessionTitle: 'Replacement session',
        headline: 'A populated replacement session.',
      },
    ];
    replacement.sessions = replacement.sessions.filter((session) => session.id === 's2');
    replacement.showing = 's2';
    await page.locator(`[data-key=${JSON.stringify(key)}] .head`).click();
    await page.evaluate(SETTLED);
    const selected = await page.evaluate(`(() => {
      const card = document.querySelector('[data-key=${JSON.stringify(key)}]');
      const target = card.querySelector('.summary');
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    })()`);
    // Opening another session replaces the view and clears the outgoing selection.

    assert.ok(selected, 'nothing was selected, so the rule under test never engages');
    await post(page, replacement);
    assert.equal(await page.locator(`[data-key=${JSON.stringify(key)}]`).count(), 0);
    assert.equal(await page.evaluate(`getSelection().toString()`), '');
    const replacementTurns = sessionTurnStats({
      turnCount: 64,
      compactionCount: 4,
      firstTurnAt: null,
      lastTurnAt: null,
    });
    await post(page, {
      type: 'rail',
      rail: payload.rail,
      labels: payload.labels,
      views: payload.views,
      railFilters: payload.railFilters,
      stats: { s2: replacementTurns },
      hidden: payload.hidden,
      pinnedTop: payload.pinnedTop,
    });

    await page.evaluate(`(() => {
      const selection = getSelection();
      selection.removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
    })()`);
    await page.evaluate(SETTLED);
    await page.locator('[data-key="s2:replacement-turn"]').waitFor();
    assert.match(await page.locator('section.sessionsection[data-session="s2"] .sessionstats').innerText(), /64/);

    await post(page, payload);
    const opened = await page.evaluate(`(async () => {
      const card = document.querySelector('[data-key=${JSON.stringify(key)}]');
      if (card.querySelector('.body').hidden) {
        card.querySelector('.head').click();
        await ${SETTLED};
      }
      const target = card.querySelector('.summary p');
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      await ${SETTLED};
      document.querySelector('.quotebar button').click();
      await ${SETTLED};
      const area = document.querySelector('.quoteslot .notearea');
      area.value = 'Keep this comment draft.';
      area.dispatchEvent(new Event('input', { bubbles: true }));
      return !!document.querySelector('.noteedit');
    })()`);
    assert.equal(opened, true);
    await page.evaluate(`window.__drawnOlder = window.__olderObserved`);
    await post(page, empty);
    for (const width of [600, 1000, 600]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForFunction(
        (tag) => {
          const labels = Array.from(document.querySelectorAll('.sessionrow[data-session="s1"] .sessionlabel'));
          return labels.length === 3 && labels.every((node) => node.tagName === tag);
        },
        width < RAIL_MIN_WIDTH ? 'SPAN' : 'BUTTON',
      );
      await page.evaluate(SETTLED);
      assert.equal(await page.locator(`[data-key=${JSON.stringify(key)}]`).count(), 1);
      assert.equal(await page.locator('.quoteslot .notearea').inputValue(), 'Keep this comment draft.');
      assert.equal(await page.evaluate(`window.__olderObserved === window.__drawnOlder`), true);
      assert.deepEqual(
        await page
          .locator('.sessionrow[data-session="s1"] .sessionlabel')
          .evaluateAll((nodes) => nodes.map((node) => node.tagName)),
        Array(3).fill(width < RAIL_MIN_WIDTH ? 'SPAN' : 'BUTTON'),
      );
    }
    assert.equal(
      await page.evaluate(`window.__olderObserved === window.__drawnOlder`),
      true,
      'a held replacement moved prefetch onto its pending footer',
    );
    await page.evaluate(`window.__olderNotify([{isIntersecting:true}])`);
    assert.deepEqual(await page.evaluate(`window.__posted.filter(message => message.type === 'loadOlder')`), [
      { type: 'loadOlder', session: 's1', token: 'drawn-history' },
    ]);
    assert.equal(await page.locator(`[data-key=${JSON.stringify(key)}]`).count(), 1);
    assert.equal(await page.locator('.quoteslot .notearea').inputValue(), 'Keep this comment draft.');
    const updatedTurns = sessionTurnStats({
      turnCount: 64,
      compactionCount: 4,
      firstTurnAt: null,
      lastTurnAt: null,
    })[0];
    const { detailList: _detailList, ...plainTurns } = updatedTurns;
    await post(page, {
      type: 'rail',
      rail: payload.rail,
      labels: payload.labels,
      views: payload.views,
      railFilters: payload.railFilters,
      stats: { s1: [plainTurns] },
      hidden: payload.hidden,
      pinnedTop: payload.pinnedTop,
    });
    const retainedChip = page.locator('section.sessionsection[data-session="s1"] .sessionstats [data-metric="turns"]');
    await retainedChip.evaluate((node: HTMLElement) => node.click());
    assert.ok((await page.locator('#chippop .chippopitem').count()) > 0);
    const retainedValues = await page.locator('#chippop .chippopitem .chippopvalue').allInnerTexts();
    assert.ok(retainedValues.includes('32'), `32 in ${retainedValues}`);
    assert.equal(retainedValues.includes('64') || retainedValues.includes('4'), false, `${retainedValues}`);

    await page.locator('.quoteslot .notearea').press('Escape');
    await page.evaluate(SETTLED);

    assert.equal(await page.locator('section.sessionsection[data-session="s1"]').count(), 0);
    assert.equal(await page.locator('.timeline-foreign .empty').count(), 1);
    assert.equal(
      await page.evaluate(
        `window.__olderObserved === document.querySelector('[data-control="olderHistory"]') && window.__olderObserved !== window.__drawnOlder`,
      ),
      true,
    );
    await page.evaluate(`window.__olderNotify([{isIntersecting:true}])`);
    assert.deepEqual(await page.evaluate(`window.__posted.filter(message => message.type === 'loadOlder')`), [
      { type: 'loadOlder', session: 's1', token: 'drawn-history' },
      { type: 'loadOlder', session: 's2', token: 'pending-history' },
    ]);

    const noted = renderPayload() as Payload;
    const notedCard = noted.cards[0];
    noted.comments = [
      {
        id: 'existing-note',
        sessionId: notedCard.sessionId,
        turnKey: notedCard.key,
        part: 'summary',
        quote: 'Words no longer present.',
        note: 'Edit this existing comment.',
        headline: notedCard.headline,
        sessionTitle: notedCard.sessionTitle || '',
        turnAt: notedCard.startedAt || 1,
        at: 2,
      },
    ];
    await post(page, noted);
    const notedHead = page.locator(`[data-key=${JSON.stringify(notedCard.key)}] .head`);
    if ((await notedHead.getAttribute('aria-expanded')) !== 'true') {
      await notedHead.evaluate((node: HTMLElement) => node.click());
      await page.evaluate(SETTLED);
    }
    await page
      .locator(`[data-key=${JSON.stringify(notedCard.key)}] .offlinemark`)
      .evaluate((node: HTMLElement) => node.click());
    await page.locator('.markfloat .noteact').first().click();
    await page.locator('.markfloat .noteclose').focus();
    await post(page, {
      ...noted,
      cards: [],
      sessions: [],
      stats: {},
      comments: [],
      usage: { ...noted.usage, composer: null },
    });
    assert.equal(await page.locator(`[data-key=${JSON.stringify(notedCard.key)}]`).count(), 1);
    await page.locator('.markfloat .noteclose').press('Escape');
    await page.evaluate(SETTLED);
    assert.equal(await page.locator('.empty').count(), 1);
  } finally {
    await browser.close();
  }
});

test('session-stat updates preserve the pinned anchor and the single roving stop', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const payload = renderPayload() as Payload;
    const files = payload.stats.s1.find((stat) => stat.metric === 'files')!;
    files.detail = 'Before the update.';
    const context = payload.stats.s1.find((stat) => stat.metric === 'context')!;
    context.detail = 'Context before the update.';
    await post(page, payload);
    const selector = 'section.sessionsection[data-session="s1"] .sessionstats [data-metric="files"]';
    await page.locator(selector).focus();
    await page.locator(selector).click();
    await page.evaluate(`window.__statAnchor = document.querySelector(${JSON.stringify(selector)})`);

    const stats = structuredClone(payload.stats);
    const changed = stats.s1.find((stat) => stat.metric === 'files')!;
    changed.label = '8 files';
    changed.detail = 'After the update.';
    await post(page, {
      type: 'rail',
      rail: payload.rail,
      labels: payload.labels,
      views: payload.views,
      railFilters: payload.railFilters,
      stats,
      hidden: payload.hidden,
      pinnedTop: payload.pinnedTop,
    });

    assert.deepEqual(
      await page.evaluate(`(() => {
      const anchor = document.querySelector(${JSON.stringify(selector)});
      const controls = [...document.querySelector('#list').querySelectorAll('.session, .sessionlabelact, .head:not(.livehead):not(.statichead), .statdetail, .result, .cliveoff, .cwaitingact')]
        .filter((node) => !node.closest('[hidden]'));
      return {
        same: anchor === window.__statAnchor,
        active: document.activeElement === anchor,
        pinned: anchor.getAttribute('aria-pressed'),
        detail: document.querySelector('#chippop').textContent,
        tabStops: controls.filter((node) => node.tabIndex === 0).length,
      };
    })()`),
      {
        same: true,
        active: true,
        pinned: 'true',
        detail: 'After the update.',
        tabStops: 1,
      },
    );

    await page.locator('article.turn button.head').first().focus();
    const insertedStats = structuredClone(stats);
    insertedStats.s1.find((stat) => stat.metric === 'cost')!.detail = 'New cost detail.';
    const changedContext = insertedStats.s1.find((stat) => stat.metric === 'context')!;
    changedContext.level = 'gettingFull';
    changedContext.detail = 'Context after the update.';
    await post(page, {
      type: 'rail',
      rail: payload.rail,
      labels: payload.labels,
      views: payload.views,
      railFilters: payload.railFilters,
      stats: insertedStats,
      hidden: payload.hidden,
      pinnedTop: payload.pinnedTop,
    });
    assert.deepEqual(
      await page.evaluate(`(() => {
      const controls = [...document.querySelector('#list').querySelectorAll('.session, .sessionlabelact, .head:not(.livehead):not(.statichead), .statdetail, .result, .cliveoff, .cwaitingact')]
        .filter((node) => !node.closest('[hidden]'));
      return {
        active: document.activeElement?.dataset.control,
        contextRoving: document.querySelector('.sessionstats [data-metric="context"]')?.classList.contains('statdetail'),
        contextTabIndex: document.querySelector('.sessionstats [data-metric="context"]')?.tabIndex,
        costButtons: document.querySelectorAll('.sessionstats button[data-metric="cost"]').length,
        tabStops: controls.filter((node) => node.tabIndex === 0).length,
      };
    })()`),
      {
        active: `card:${payload.cards[0].key}`,
        contextRoving: true,
        contextTabIndex: -1,
        costButtons: 1,
        tabStops: 1,
      },
    );
  } finally {
    await browser.close();
  }
});

test('live work without a recorded turn stays inside its keyed session mount', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const payload = renderPayload(
      [],
      [
        {
          sessionId: 'fresh-session',
          agent: 'claude',
          kind: 'prompt',
          text: 'Start fresh.',
          reply: '',
          at: Date.now(),
          midTurn: false,
          ran: false,
          started: false,
          failed: false,
          reason: '',
        },
      ],
    ) as Payload;
    payload.cards = [];
    payload.sessions = [];
    payload.showing = 'fresh-session';
    payload.stats = {};
    payload.usage.composer!.sessionId = 'fresh-session';
    payload.usage.composer!.targetName = 'Fresh session';
    const live = payload.usage.composer!.live;
    payload.usage.composer!.live = [];
    await post(page, payload);

    await post(page, {
      type: 'usage',
      usage: { ...payload.usage, composer: { ...payload.usage.composer!, live } },
    });

    const session = page.locator('section.sessionsection[data-session="fresh-session"]');
    assert.equal(await session.count(), 1);
    assert.equal(await session.getByRole('heading', { level: 2, name: /Session/ }).count(), 1);
    assert.equal(await session.locator('.transientcards > .clive').count(), 1);
    assert.equal(await page.locator('main#list > .clive').count(), 0);
    await page.evaluate(
      `window.__transientSession = document.querySelector('section.sessionsection[data-session="fresh-session"]')`,
    );
    const answered = live.map((card) => ({ ...card, reply: 'The reply arrived.' }));
    await post(page, { type: 'live', session: 'fresh-session', live: answered });
    assert.equal(
      await page.evaluate(
        `window.__transientSession === document.querySelector('section.sessionsection[data-session="fresh-session"]')`,
      ),
      true,
    );
    assert.equal(await session.locator('.transientcards > .clive').count(), 1);
  } finally {
    await browser.close();
  }
});

test('a streamed response keeps selected text until the selection is released', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const reply = 'The agent wrote enough of this response for the reader to select it.';
    const payload = renderPayload(
      [],
      [
        {
          sessionId: 'fresh-session',
          agent: 'claude',
          kind: 'prompt',
          text: 'Start fresh.',
          reply,
          at: Date.now(),
          midTurn: false,
          ran: true,
          started: true,
          failed: false,
          reason: '',
        },
      ],
    ) as Payload;
    payload.cards = [];
    payload.sessions = [];
    payload.showing = 'fresh-session';
    payload.stats = {};
    payload.usage.composer!.sessionId = 'fresh-session';
    payload.usage.composer!.targetName = 'Fresh session';
    await post(page, payload);

    const selected = 'wrote enough of this response for the reader';
    await page.evaluate(`(() => {
      const target = document.querySelector('.clive .clivereplytext');
      const text = target.firstChild;
      const start = text.textContent.indexOf(${JSON.stringify(selected)});
      const range = document.createRange();
      range.setStart(text, start);
      range.setEnd(text, start + ${JSON.stringify(selected)}.length);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      window.__selectedLiveCard = target.closest('.clive');
    })()`);

    const later = payload.usage.composer!.live.map((card) => ({
      ...card,
      reply: `${reply} Another streamed fragment arrived.`,
    }));
    await post(page, { type: 'live', session: 'fresh-session', live: later });
    const newest = later.map((card) => ({
      ...card,
      reply: `${card.reply} The final streamed fragment arrived.`,
    }));
    await post(page, { type: 'live', session: 'fresh-session', live: newest });

    const usage = structuredClone(payload.usage);
    usage.composer!.live = newest.map((card) => ({ ...card, reason: 'Finishing the response.' }));
    await post(page, { type: 'usage', usage });
    assert.deepEqual(
      await page.evaluate(`(() => ({
      selected: getSelection().toString(),
      reply: document.querySelector('.clive .clivereplytext').textContent,
      sameCard: window.__selectedLiveCard === document.querySelector('.clive'),
      reason: document.querySelector('.clive .clivereason'),
    }))()`),
      { selected, reply, sameCard: true, reason: null },
    );

    await page.evaluate(`(() => {
      getSelection().removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
    })()`);
    await page.evaluate(SETTLED);
    assert.equal(await page.locator('.clive .clivereplytext').textContent(), newest[0].reply);
    assert.equal(await page.locator('.clive .clivereason').textContent(), 'Finishing the response.');
  } finally {
    await browser.close();
  }
});

test('a refresh preserves a backward response drag and its continuing anchor', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const payload = renderPayload() as Payload;
    await post(page, payload);
    await page.locator(`[data-control=${JSON.stringify(`card:${payload.cards[0].key}`)}]`).click();
    const points = (await page.evaluate(`(() => {
      const text = document.querySelector('article.turn .summary p').firstChild;
      const point = (offset) => {
        const range = document.createRange();
        range.setStart(text, offset);
        range.collapse(true);
        const box = range.getBoundingClientRect();
        return { x: box.left, y: box.top + box.height / 2 };
      };
      return { anchor: point(35), focus: point(10), farther: point(9) };
    })()`)) as { anchor: { x: number; y: number }; focus: { x: number; y: number }; farther: { x: number; y: number } };

    await page.mouse.move(points.anchor.x, points.anchor.y);
    await page.mouse.down();
    await page.mouse.move(points.focus.x, points.focus.y);
    assert.deepEqual(
      await page.evaluate(`(() => ({
      anchor: getSelection().anchorOffset,
      focus: getSelection().focusOffset,
      text: getSelection().toString(),
    }))()`),
      { anchor: 35, focus: 10, text: ' usage reducer in extensi' },
    );

    await post(page, structuredClone(payload));
    await page.mouse.move(points.farther.x, points.farther.y);
    await page.mouse.up();
    assert.deepEqual(
      await page.evaluate(`(() => ({
      anchor: getSelection().anchorOffset,
      focus: getSelection().focusOffset,
      text: getSelection().toString(),
    }))()`),
      { anchor: 35, focus: 9, text: 'e usage reducer in extensi' },
    );

    await page.evaluate(`(() => {
      const text = document.querySelector('article.turn .summary p').firstChild;
      const selection = getSelection();
      selection.setBaseAndExtent(text, 9, text, 35);
    })()`);
    await post(page, structuredClone(payload));
    assert.deepEqual(
      await page.evaluate(`(() => ({
      anchor: getSelection().anchorOffset,
      focus: getSelection().focusOffset,
      text: getSelection().toString(),
    }))()`),
      { anchor: 9, focus: 35, text: 'e usage reducer in extensi' },
    );
  } finally {
    await browser.close();
  }
});

test('live selection debt follows the selected card and defers its removal', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const promptReply = 'The prompt response is ready to select.';
    const compactReply = 'The compact response is ready to select.';
    const payload = renderPayload(
      [],
      [
        {
          sessionId: 'fresh-session',
          agent: 'claude',
          kind: 'prompt',
          text: 'Start fresh.',
          reply: promptReply,
          at: Date.now(),
          midTurn: false,
          ran: true,
          started: true,
          failed: false,
          reason: '',
        },
        {
          sessionId: 'fresh-session',
          agent: 'claude',
          kind: 'compact',
          text: 'Compact first.',
          reply: compactReply,
          at: Date.now() - 1,
          midTurn: false,
          ran: true,
          started: true,
          failed: false,
          reason: '',
        },
      ],
    ) as Payload;
    payload.cards = [];
    payload.sessions = [];
    payload.showing = 'fresh-session';
    payload.stats = {};
    payload.usage.composer!.sessionId = 'fresh-session';
    payload.usage.composer!.targetName = 'Fresh session';
    await post(page, payload);

    async function selectReply(kind: string): Promise<string> {
      return page.evaluate(`(() => {
        const text = document.querySelector('.clive[data-live=${JSON.stringify(kind)}] .clivereplytext').firstChild;
        const range = document.createRange();
        range.selectNodeContents(text);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        return selection.toString();
      })()`);
    }

    const promptSelection = await selectReply('prompt');
    const later = payload.usage.composer!.live.map((card) => ({
      ...card,
      reply: `${card.reply} A later fragment arrived.`,
    }));
    const replyOf = (cards: Array<Record<string, unknown>>, kind: string): unknown =>
      cards.find((card) => card.kind === kind)?.reply;
    await post(page, { type: 'live', session: 'fresh-session', live: later });
    assert.equal(await page.evaluate(`getSelection().toString()`), promptSelection);
    assert.equal(await page.locator('.clive[data-live="prompt"] .clivereplytext').textContent(), promptReply);
    assert.equal(
      await page.locator('.clive[data-live="compact"] .clivereplytext').textContent(),
      replyOf(later, 'compact'),
    );

    const compactSelection = await selectReply('compact');
    assert.equal(
      await page.locator('.clive[data-live="prompt"] .clivereplytext').textContent(),
      replyOf(later, 'prompt'),
    );
    const newest = later.map((card) => ({
      ...card,
      reply: `${card.reply} The newest fragment arrived.`,
    }));
    await post(page, { type: 'live', session: 'fresh-session', live: newest });
    assert.equal(await page.evaluate(`getSelection().toString()`), compactSelection);
    assert.equal(
      await page.locator('.clive[data-live="prompt"] .clivereplytext').textContent(),
      replyOf(newest, 'prompt'),
    );
    assert.equal(
      await page.locator('.clive[data-live="compact"] .clivereplytext').textContent(),
      replyOf(later, 'compact'),
    );

    const usage = structuredClone(payload.usage);
    usage.composer!.live = newest.filter((card) => (card as Record<string, unknown>).kind === 'prompt');
    await post(page, { type: 'usage', usage });
    assert.equal(await page.evaluate(`getSelection().toString()`), compactSelection);
    assert.equal(await page.locator('.clive[data-live="compact"]').count(), 1);

    await page.evaluate(`(() => {
      getSelection().removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
    })()`);
    await page.evaluate(SETTLED);
    assert.equal(await page.locator('.clive[data-live="compact"]').count(), 0);
    assert.equal(
      await page.locator('.clive[data-live="prompt"] .clivereplytext').textContent(),
      replyOf(newest, 'prompt'),
    );
  } finally {
    await browser.close();
  }
});

test('one release settles live and recorded updates under a spanning selection', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const reply = 'The live response starts this selected range.';
    const payload = renderPayload(
      [],
      [
        {
          sessionId: 's1',
          agent: 'claude',
          kind: 'prompt',
          text: 'Continue here.',
          reply,
          at: Date.now(),
          midTurn: false,
          ran: true,
          started: true,
          failed: false,
          reason: '',
        },
      ],
    ) as Payload;
    payload.cards = payload.cards.slice(0, 1);
    payload.sessions = payload.sessions.filter((session) => session.id === 's1');
    payload.usage.composer!.sessionId = 's1';
    payload.usage.composer!.targetName = 'Embedded agent input';
    await post(page, payload);
    await page.locator(`[data-control=${JSON.stringify(`card:${payload.cards[0].key}`)}]`).click();

    const selected = await page.evaluate(`(() => {
      const start = document.querySelector('.clive[data-live="prompt"] .clivereplytext').firstChild;
      const end = document.querySelector('article.turn .summary p').firstChild;
      const range = document.createRange();
      range.setStart(start, 0);
      range.setEnd(end, end.textContent.length);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    })()`);

    const changed = structuredClone(payload);
    changed.usage.composer!.live = changed.usage.composer!.live.map((card) => ({
      ...card,
      reply: `${reply} New live words arrived.`,
    }));
    changed.cards[0].summaryHtml = '<p>The recorded response changed after selection.</p>';
    await post(page, changed);
    assert.equal(await page.evaluate(`getSelection().toString()`), selected);
    assert.equal(await page.locator('.clive[data-live="prompt"] .clivereplytext').textContent(), reply);
    assert.notEqual(
      await page.locator('article.turn .summary').textContent(),
      'The recorded response changed after selection.',
    );

    await page.evaluate(`(() => {
      getSelection().removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
    })()`);
    await page.evaluate(SETTLED);
    assert.equal(
      await page.locator('.clive[data-live="prompt"] .clivereplytext').textContent(),
      changed.usage.composer!.live[0].reply,
    );
    assert.equal(
      await page.locator('article.turn .summary').textContent(),
      'The recorded response changed after selection.',
    );
  } finally {
    await browser.close();
  }
});

test('a full render defers removing a selected live response beside recorded work', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const reply = 'The live response remains selectable beside a recorded turn.';
    const payload = renderPayload(
      [],
      [
        {
          sessionId: 's1',
          agent: 'claude',
          kind: 'prompt',
          text: 'Continue here.',
          reply,
          at: Date.now(),
          midTurn: false,
          ran: true,
          started: true,
          failed: false,
          reason: '',
        },
      ],
    ) as Payload;
    payload.cards = payload.cards.slice(0, 1);
    payload.sessions = payload.sessions.filter((session) => session.id === 's1');
    payload.usage.composer!.sessionId = 's1';
    payload.usage.composer!.targetName = 'Embedded agent input';
    await post(page, payload);

    const selected = await page.evaluate(`(() => {
      const text = document.querySelector('.clive .clivereplytext').firstChild;
      const range = document.createRange();
      range.selectNodeContents(text);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    })()`);
    const settled = structuredClone(payload);
    settled.usage.composer = null;
    await post(page, settled);
    assert.equal(await page.evaluate(`getSelection().toString()`), selected);
    assert.equal(await page.locator('.clive').count(), 1);

    await page.evaluate(`(() => {
      getSelection().removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
    })()`);
    await page.evaluate(SETTLED);
    assert.equal(await page.locator('.clive').count(), 0);
    assert.equal(await page.locator('article.turn').count(), 1);
  } finally {
    await browser.close();
  }
});

test('usage can draw live work and its composer before the first render message', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const payload = renderPayload(
      [],
      [
        {
          sessionId: 'fresh-session',
          agent: 'claude',
          kind: 'prompt',
          text: 'Start fresh.',
          reply: '',
          at: Date.now(),
          midTurn: false,
          ran: false,
          started: false,
          failed: false,
          reason: '',
        },
      ],
    ) as Payload;
    payload.usage.composer!.sessionId = 'fresh-session';
    payload.usage.composer!.targetName = 'Fresh session';
    await post(page, { type: 'usage', usage: payload.usage });

    const session = page.locator('section.sessionsection[data-session="fresh-session"]');
    assert.equal(await session.count(), 1);
    assert.equal(await session.locator('.transientcards > .clive').count(), 1);
    assert.equal(await page.locator('#composer').count(), 1);

    const quiet = structuredClone(payload.usage);
    quiet.composer!.live = [];
    quiet.composer!.queue = [];
    await post(page, { type: 'usage', usage: quiet });
    assert.equal(await page.locator('section.sessionsection[data-session="fresh-session"]').count(), 0);
    assert.equal(await page.locator('.clive').count(), 0);
  } finally {
    await browser.close();
  }
});

test('usage before the first render defers removing a selected live response', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const reply = 'The usage-only response remains available while selected.';
    const payload = renderPayload(
      [],
      [
        {
          sessionId: 'fresh-session',
          agent: 'claude',
          kind: 'prompt',
          text: 'Start fresh.',
          reply,
          at: Date.now(),
          midTurn: false,
          ran: true,
          started: true,
          failed: false,
          reason: '',
        },
      ],
    ) as Payload;
    payload.usage.composer!.sessionId = 'fresh-session';
    payload.usage.composer!.targetName = 'Fresh session';
    await post(page, { type: 'usage', usage: payload.usage });

    const selected = await page.evaluate(`(() => {
      const text = document.querySelector('.clive .clivereplytext').firstChild;
      const range = document.createRange();
      range.selectNodeContents(text);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    })()`);
    await post(page, { type: 'usage', usage: { ...payload.usage, composer: null } });
    await post(page, { type: 'usage', usage: { ...payload.usage, composer: null } });
    assert.equal(await page.evaluate(`getSelection().toString()`), selected);
    assert.equal(await page.locator('.clive .clivereplytext').textContent(), reply);

    await page.evaluate(`(() => {
      getSelection().removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
    })()`);
    await page.evaluate(SETTLED);
    assert.equal(await page.locator('.clive').count(), 0);
    assert.equal(await page.locator('.empty').count(), 1);
  } finally {
    await browser.close();
  }
});

test('updated summary content owns one safe action path and one comment paint', async (t) => {
  // Updating mounted summary HTML must preserve one action handler and one annotation effect.

  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  const failures: string[] = [];
  page.on('pageerror', (e) => failures.push(String(e)));
  try {
    await page.setContent(themed(pageHtml()));
    const payload = renderPayload() as Payload;
    const card = payload.cards[0];
    card.summaryHtml = '<p>review target <a data-link="first.txt">first</a></p>';
    payload.cards = [card];
    await post(page, payload);
    await page.locator(`[data-control=${JSON.stringify(`card:${card.key}`)}]`).click();
    await page.evaluate(`(() => {
      const host = document.querySelector('[data-key=${JSON.stringify(card.key)}]');
      const target = host.querySelector('.summary p').firstChild;
      const range = document.createRange();
      range.setStart(target, 0);
      range.setEnd(target, 'review target'.length);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      host.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    })()`);
    await post(page, { type: 'openComment', key: card.key });
    await page.locator('.notearea').fill('Keep this line.');
    await page.locator('.notesave').click();
    await page.evaluate(`window.__posted.length = 0`);
    const updated = {
      ...card,
      summaryHtml:
        '<p>review target <a data-link="second.txt"><span>second</span></a></p>' +
        '<pre><code>const value = 2;</code></pre>' +
        '<button data-visualization="view.html"><span>visual</span></button>' +
        '<button data-image="shot.png"><span>image</span></button>' +
        '<button data-ignored="true">inert</button>',
    };
    await post(page, { type: 'activity', session: card.sessionId, card: updated });

    assert.equal(await page.locator(`[data-key=${JSON.stringify(card.key)}] .summary .cmark`).count(), 1);
    assert.equal(await page.locator(`[data-key=${JSON.stringify(card.key)}] .summary .linemark`).count(), 1);
    const linkContext = await page
      .locator(`[data-key=${JSON.stringify(card.key)}] a[data-link]`)
      .getAttribute('data-vscode-context');
    assert.deepEqual(JSON.parse(linkContext || '{}'), {
      webviewSection: 'arcLink',
      link: 'second.txt',
      session: card.sessionId,
      key: card.key,
      preventDefaultContextMenuItems: true,
    });
    await page.locator(`[data-key=${JSON.stringify(card.key)}] a[data-link]`).click();
    assert.deepEqual(await page.evaluate(`window.__posted`), [{ type: 'openLink', href: 'second.txt', beside: false }]);
    await page.evaluate(`window.__posted.length = 0`);
    await page.locator(`[data-key=${JSON.stringify(card.key)}] a[data-link] span`).click({ modifiers: ['Control'] });
    await page.locator(`[data-key=${JSON.stringify(card.key)}] button[data-visualization] span`).click();
    await page.locator(`[data-key=${JSON.stringify(card.key)}] button[data-image] span`).click();
    await page.locator(`[data-key=${JSON.stringify(card.key)}] button.copy`).click();
    await page.locator(`[data-key=${JSON.stringify(card.key)}] button[data-ignored]`).click();
    assert.deepEqual(await page.evaluate(`window.__posted`), [
      { type: 'openLink', href: 'second.txt', beside: true },
      { type: 'openVisualization', path: 'view.html' },
      { type: 'openImage', path: 'shot.png', beside: false },
      { type: 'copy', text: 'const value = 2;' },
    ]);
    assert.deepEqual(failures, [], 'the panel threw while replacing a summary link handler');
  } finally {
    await browser.close();
  }
});

test('unselected folded headline inherits its native turn menu and keeps descendant menus', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(themed(pageHtml()));
    const payload = renderPayload() as Payload;
    const source = payload.cards.find(
      (card) => card.kind !== 'compaction' && card.summaryHtml && Array.isArray(card.files) && card.files.length,
    )!;
    const card = {
      ...source,
      summaryHtml: '<p>No selection. <a href="#" data-link="plans/handoff.md">handoff</a></p>',
    };
    const bare = { ...bodylessCard(source, 's1:bare-compaction'), kind: 'compaction', summary: '' };
    const live = { ...source, key: 's1:parsed-live', live: true, status: 'running', summary: '' };
    await post(page, {
      ...payload,
      cards: [card, bare, live],
      timelineLayout: { cardLayout: 'one-column', promptPosition: 'above' },
      labels: [],
      rail: payload.rail.map((row: any) => ({ ...row, labels: [] })),
    });
    const entries = manifestMenu(JSON.parse(readFileSync(`${__dirname}/../package.json`, 'utf8')));
    const contextFor = async (selector: string) =>
      page.evaluate<Record<string, unknown>>(
        `(${contextAt.toString()})(document.querySelector(${JSON.stringify(selector)}))`,
      );
    const commandsFor = (context: Record<string, unknown>) =>
      menuGroups(entries, context)
        .flat()
        .map((entry) => entry.command);
    const selector = `[data-key=${JSON.stringify(card.key)}]`;
    await page.locator(`${selector} .headline`).dispatchEvent('contextmenu');
    const headline = await contextFor(`${selector} .headline`);
    assert.equal(headline.session, card.sessionId, 'the actual folded right-click target has no source session');
    assert.equal(headline.key, card.key);
    assert.equal(
      headline.preventDefaultContextMenuItems,
      undefined,
      'the ordinary card inherited the header default-item suppression',
    );
    assert.equal(commandsFor(headline).includes('arc.newSessionWithLabels'), true);
    assert.equal(commandsFor(headline).includes('arc.sendSelectedText'), false);
    assert.deepEqual(await page.evaluate(`window.__posted.filter((message) => message.type === 'armSessionDetails')`), [
      { type: 'armSessionDetails', session: card.sessionId },
    ]);
    for (const candidate of [bare, live]) {
      const context = await contextFor(`[data-key=${JSON.stringify(candidate.key)}] .headline`);
      assert.equal(context.session, candidate.sessionId);
      assert.equal(context.key, candidate.key);
      assert.equal(commandsFor(context).includes('arc.newSessionWithLabels'), true);
    }
    for (const route of ['[data-control="sessionmenu:s1"]', '[data-control="rail:s1"]']) {
      const opener = page.locator(route);
      await opener.focus();
      if (route.includes('sessionmenu:')) await opener.click();
      else await opener.press('Shift+F10');
      const context = await contextFor(route);
      assert.equal(context.session, 's1');
      assert.equal(commandsFor(context).includes('arc.newSessionWithLabels'), true);
    }
    const head = page.locator(`${selector} .head`);
    await head.focus();
    await head.press('Shift+F10');
    assert.equal(commandsFor(await contextFor(`${selector} .head`)).includes('arc.newSessionWithLabels'), true);
    if ((await head.getAttribute('aria-expanded')) === 'false') await head.click();
    const link = await contextFor(`${selector} a[data-link]`);
    assert.equal(link.webviewSection, 'arcLink');
    assert.equal(link.preventDefaultContextMenuItems, true);
    assert.equal(commandsFor(link).includes('arc.newSessionWithLabels'), false);
    assert.equal(commandsFor(link).includes('arc.sendResponseLink'), true);
    assert.ok(await page.locator(`${selector} [data-control^="file:"]`).count(), 'the fixture has no nested file menu');
    const file = await contextFor(`${selector} [data-control^="file:"]`);
    assert.equal(file.webviewSection, 'arcFile');
    assert.equal(file.preventDefaultContextMenuItems, true);
    assert.equal(commandsFor(file).includes('arc.newSessionWithLabels'), false);
    await post(page, {
      type: 'usage',
      usage: {
        ...payload.usage,
        composer: {
          ...payload.usage.composer!,
          queue: [
            {
              id: 'queued',
              label: 'Queued prompt',
              text: 'Queued prompt',
              long: false,
              openName: '',
              shutName: '',
              control: '',
              dropName: 'Remove',
              dropControl: 'remove:queued',
              editName: 'Edit',
              editControl: 'edit:queued',
              editLabel: 'Edit',
              copyLabel: 'Copy',
              dropLabel: 'Remove',
              copyName: 'Copy',
              copyControl: 'copy:queued',
              copyText: 'Queued prompt',
              files: [],
            },
          ],
        },
      },
    });
    assert.equal(await page.locator('.cwaiting').count(), 1);
    const transient = await contextFor('.cwaiting');
    assert.equal(transient.key, undefined, 'a queued card acquired a parsed turn identity');
    assert.equal(commandsFor(transient).includes('arc.newSessionWithLabels'), false);
  } finally {
    await browser.close();
  }
});

test('selected text owns native turn context and a one-shot handoff arm', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const payload = renderPayload() as Payload;
    const cards = payload.cards
      .filter((card) => card.kind !== 'compaction' && card.summaryHtml)
      .slice(0, 2)
      .map((card, index) =>
        index === 0
          ? {
              ...card,
              summaryHtml: '<p>repeat words, repeat words. <a href="#" data-link="plans/handoff.md">handoff</a></p>',
            }
          : card,
      );
    assert.equal(cards.length, 2, 'the fixture has fewer than two recorded response cards');
    await post(page, { ...payload, cards });
    for (const card of cards) {
      const body = page.locator(`[data-key=${JSON.stringify(card.key)}] > .body`);
      if ((await body.getAttribute('hidden')) !== null) {
        await page.locator(`[data-control=${JSON.stringify(`card:${card.key}`)}]`).click();
      }
    }

    const selectCard = async (key: string) =>
      page.evaluate(`(() => {
      const target = document.querySelector('[data-key=${JSON.stringify(key)}] .summary p');
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return selection.toString();
    })()`);
    const contexts = async (key: string) =>
      page.locator(`[data-key=${JSON.stringify(key)}]`).evaluate((host) => ({
        head: JSON.parse((host.querySelector('.head') as HTMLElement).dataset.vscodeContext || '{}'),
        body: JSON.parse((host.querySelector('.body') as HTMLElement).dataset.vscodeContext || '{}'),
      }));

    const firstText = await selectCard(cards[0].key);
    assert.ok(firstText, 'the first fixture response produced no selected text');
    assert.deepEqual((await contexts(cards[0].key)).head.arcSelection, true);
    assert.deepEqual((await contexts(cards[0].key)).body.arcSelection, true);
    assert.deepEqual(
      JSON.parse(
        (await page
          .locator(`[data-key=${JSON.stringify(cards[0].key)}] a[data-link]`)
          .getAttribute('data-vscode-context')) || '{}',
      ),
      {
        webviewSection: 'arcLink',
        link: 'plans/handoff.md',
        session: cards[0].sessionId,
        key: cards[0].key,
        preventDefaultContextMenuItems: true,
      },
      'a selected response link did not keep its local-link context',
    );
    await page.evaluate(`(() => {
      window.__posted.length = 0;
      document.querySelector('[data-key=${JSON.stringify(cards[0].key)}] a[data-link]')
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    })()`);
    assert.deepEqual(
      await page.evaluate(`window.__posted.filter((message) => message.type === 'armSelectedText')`),
      [{ type: 'armSelectedText', session: cards[0].sessionId, key: cards[0].key }],
      'a selected response link did not arm its selected-text handoff once',
    );

    await selectCard(cards[1].key);
    assert.equal(
      (await contexts(cards[0].key)).head.arcSelection,
      undefined,
      'moving the selection left the old turn context armed',
    );
    assert.equal(
      (await contexts(cards[0].key)).body.arcSelection,
      undefined,
      'moving the selection left the old turn body context armed',
    );
    assert.equal((await contexts(cards[1].key)).head.arcSelection, true);
    assert.equal((await contexts(cards[1].key)).body.arcSelection, true);

    await page.evaluate(`(() => {
      window.__posted.length = 0;
      document.querySelector('[data-key=${JSON.stringify(cards[1].key)}] .summary p')
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    })()`);
    assert.deepEqual(
      await page.evaluate(`window.__posted.filter((message) => message.type === 'armSelectedText')`),
      [
        {
          type: 'armSelectedText',
          session: cards[1].sessionId,
          key: cards[1].key,
        },
      ],
      'the selected range did not arm its native-menu host',
    );
    await post(page, { type: 'sendSelectedText', key: cards[1].key, copyLabels: true });
    await post(page, { type: 'sendSelectedText', key: cards[1].key, copyLabels: true });
    const sent = await page.evaluate(`window.__posted.filter((message) => message.type === 'selectedTextHandoff')`);
    assert.deepEqual(
      sent,
      [
        {
          type: 'selectedTextHandoff',
          session: cards[1].sessionId,
          key: cards[1].key,
          text: await selectCard(cards[1].key),
          copyLabels: true,
        },
      ],
      'the selected-text arm did not send exactly once with its source identity and label choice',
    );

    await page.evaluate(`(() => {
      window.__posted.length = 0;
      const selection = getSelection();
      selection.removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
    })()`);
    await page.evaluate(SETTLED);
    await page.evaluate(`(() => {
      document.querySelector('[data-key=${JSON.stringify(cards[1].key)}] .summary p')
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    })()`);
    assert.equal(
      (await contexts(cards[1].key)).head.arcSelection,
      undefined,
      'collapsing the selection left selected-text commands on the turn',
    );
    await post(page, { type: 'sendSelectedText', key: cards[1].key, copyLabels: false });
    // The right-click still names this panel for the session's own menu entries.
    assert.deepEqual(
      await page.evaluate(`window.__posted.filter((message) => message.type !== 'armSessionDetails')`),
      [],
      'a clicked line without selected text created a selected-text handoff',
    );
    await page.evaluate(`document.querySelector('[data-key=${JSON.stringify(cards[1].key)}] .summary p')
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`);
    await post(page, { type: 'openComment', key: cards[1].key });
    assert.equal(
      await page.locator('.noteedit').count(),
      1,
      'the clicked-line fallback no longer opens the comment box',
    );

    await page.locator('.noteclose').click();
    const selectRepeatedWord = async (offset: number) =>
      page.evaluate(`(() => {
      const target = document.querySelector('[data-key=${JSON.stringify(cards[0].key)}] .summary p').firstChild;
      const range = document.createRange();
      range.setStart(target, ${offset});
      range.setEnd(target, ${offset + 6});
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return selection.toString();
    })()`);
    assert.equal(await selectRepeatedWord(0), 'repeat');
    await page.evaluate(`document.querySelector('[data-key=${JSON.stringify(cards[0].key)}] .summary p')
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`);
    assert.equal(await selectRepeatedWord(14), 'repeat');
    await post(page, { type: 'sendSelectedText', key: cards[0].key, copyLabels: false });
    assert.deepEqual(
      await page.evaluate(`window.__posted.filter((message) => message.type === 'selectedTextHandoff')`),
      [],
      'moving an unchanged spelling inside the turn left the old handoff arm usable',
    );
  } finally {
    await browser.close();
  }
});

test('a compaction summary link keeps Copy Path context without handoff identity', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const payload = renderPayload() as Payload;
    const compaction = {
      ...payload.cards[0],
      key: 's1:compaction-link',
      kind: 'compaction',
      summaryHtml: '<p><a data-link="../plans/handoff.md#L42">handoff</a></p>',
    };
    await post(page, { ...payload, cards: [compaction] });
    await page.locator(`[data-control=${JSON.stringify(`card:${compaction.key}`)}]`).click();
    const context = await page.locator('a[data-link]').getAttribute('data-vscode-context');
    assert.deepEqual(JSON.parse(context || '{}'), {
      webviewSection: 'arcLink',
      link: '../plans/handoff.md#L42',
      preventDefaultContextMenuItems: true,
    });
  } finally {
    await browser.close();
  }
});

test('Markdown preview links activate by click and Enter while expanded code copies its literal source', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('A browser is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(themed(pageHtml()));
    const payload = renderPayload() as Payload;
    const card = {
      ...toCard(turn({ summary: MARKDOWN_LINK_RESPONSE }), false, NOW),
      summaryHtml: renderRichMarkdown(MARKDOWN_LINK_RESPONSE),
      key: 's1:markdown-preview',
    };
    await post(page, { ...payload, cards: [card] });
    const headline = page.locator('.headline');
    const link = headline.locator('a[data-link]');
    await link.waitFor();
    assert.equal(await link.textContent(), '60-second wait guidance');
    assert.equal(await headline.textContent(), card.headline);
    const head = page.locator(`[data-control=${JSON.stringify(`card:${card.key}`)}]`);
    await page.evaluate('window.__posted.length = 0');
    await link.click();
    await link.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => (window as any).__posted.length === 2);
    assert.deepEqual(await page.evaluate('window.__posted'), [
      { type: 'openLink', href: 'https://github.com/openai/codex/issues/31935', beside: false },
      { type: 'openLink', href: 'https://github.com/openai/codex/issues/31935', beside: false },
    ]);
    assert.equal(await head.getAttribute('aria-expanded'), 'false');
    await link.evaluate((node) => {
      (window as any).__oldPreview = node;
    });
    await post(page, { type: 'activity', session: card.sessionId, card: { ...card, headlineHtml: undefined } });
    await page.waitForFunction(() => !document.querySelector('.headline a'));
    await page.evaluate('window.__posted.length = 0; window.__oldPreview.click()');
    assert.deepEqual(await page.evaluate('window.__posted'), []);
    await head.click();
    const code = page.locator('.summary pre code.language-markdown');
    await code.waitFor();
    assert.equal((await code.textContent())?.trimEnd(), MARKDOWN_LINK_RESPONSE.split('\n')[1]);
    assert.equal(await page.locator('.summary a').count(), 0);
    await page.evaluate('window.__posted.length = 0');
    await page.locator('.summary button.copy').click();
    await page.waitForFunction(() => (window as any).__posted.some((message: any) => message.type === 'copy'));
    assert.deepEqual(await page.evaluate('window.__posted'), [
      { type: 'copy', text: MARKDOWN_LINK_RESPONSE.split('\n')[1] + '\n' },
    ]);
    const examples = [
      {
        summary: 'A ![&#169;](chart.png) [guide](https://example.com)',
        expected: 'A &#169; guide',
        href: 'https://example.com',
        label: 'guide',
      },
      {
        summary: '<https://example.com/a?x=1&copy;=2>',
        expected: 'https://example.com/a?x=1&copy;=2',
        href: 'https://example.com/a?x=1&copy;=2',
        label: 'https://example.com/a?x=1&copy;=2',
      },
      {
        summary: 'A &#169; [guide](https://example.com/a?x=1&y=2)',
        expected: 'A &#169; guide',
        href: 'https://example.com/a?x=1&y=2',
        label: 'guide',
      },
      {
        summary: 'A &copy; [guide &lt;](https://example.com/a?x=1&y=2)',
        expected: 'A &copy; guide &lt;',
        href: 'https://example.com/a?x=1&y=2',
        label: 'guide &lt;',
      },
      {
        summary: 'Read [guide](https://example.com/guide).  \nNext line.',
        expected: 'Read guide.',
        href: 'https://example.com/guide',
        label: 'guide',
      },
      {
        summary: '[**✅** Done](https://example.com)',
        expected: 'Done',
        href: 'https://example.com',
        label: 'Done',
      },
      {
        summary: '[✅](https://example.com) Done',
        expected: 'Done',
        href: 'https://example.com',
        label: 'Done',
      },
      {
        summary: '**[✅](https://example.com)** **Done**',
        expected: 'Done',
        href: 'https://example.com',
        label: 'Done',
      },
      {
        summary: '```markdown\n<https://example.com/a?x=1&y=2>\n```',
        expected: 'https://example.com/a?x=1&y=2',
        href: 'https://example.com/a?x=1&y=2',
      },
      {
        summary: '```markdown\n&lt; [guide](https://example.com) &gt;\n```',
        expected: '&lt; guide &gt;',
        href: 'https://example.com',
      },
      {
        summary: '```markdown\n[✅ Done](https://example.com)\n```',
        expected: 'Done',
        href: 'https://example.com',
      },
      {
        summary: 'See [wiki](https://en.wikipedia.org/wiki/Function_(mathematics)).',
        expected: 'See wiki.',
        href: 'https://en.wikipedia.org/wiki/Function_(mathematics)',
      },
      {
        summary: String.raw`\[guide](https://example.com) and https://example.org`,
        expected: '[guide](https://example.com) and https://example.org',
        href: 'https://example.org',
      },
      {
        summary: '```markdown\n&lt; example &gt; &amp;lt; &#39; &quot;\n```',
        expected: '&lt; example &gt; &amp;lt; &#39; &quot;',
        href: null,
      },
    ];
    for (const [index, example] of examples.entries()) {
      const edge = {
        ...toCard(turn({ summary: example.summary }), false, NOW),
        summaryHtml: renderRichMarkdown(example.summary),
        key: `s1:markdown-edge-${index}`,
      };
      await post(page, { ...payload, cards: [edge] });
      const edgeHead = page.locator(`[data-control=${JSON.stringify(`card:${edge.key}`)}]`);
      await edgeHead.waitFor();
      assert.equal(await page.locator('.headline').textContent(), example.expected);
      assert.equal(edge.headline, example.expected);
      assert.ok((await edgeHead.getAttribute('aria-label'))?.includes(example.expected));
      const edgeLink = page.locator('.headline a[data-link]');
      assert.equal(await edgeLink.count(), example.href ? 1 : 0);
      if (!example.href) continue;
      assert.equal(await edgeLink.getAttribute('data-link'), example.href);
      if (example.label) assert.equal(await page.getByRole('link', { name: example.label, exact: true }).count(), 1);
      await page.evaluate('window.__posted.length = 0');
      await edgeLink.click();
      await edgeLink.focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => (window as any).__posted.length === 2);
      assert.deepEqual(await page.evaluate('window.__posted'), [
        { type: 'openLink', href: example.href, beside: false },
        { type: 'openLink', href: example.href, beside: false },
      ]);
      assert.equal(await edgeHead.getAttribute('aria-expanded'), 'false');
    }
  } finally {
    await browser.close();
  }
});

test('named response session links activate inside Arc by click and Enter, including tables', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('A browser is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(themed(pageHtml()));
    const payload = renderPayload() as Payload;
    const id = '7390194c-8fea-4b6d-80be-e7e8c7684426';
    const preview = { ...toCard(turn({ summary: SESSION_LINK_RESPONSE }), false, NOW), key: 's1:collapsed-session' };
    await post(page, { ...payload, cards: [preview] });
    const headline = page.locator('.headline a[data-link]');
    const head = page.locator(`[data-control=${JSON.stringify(`card:${preview.key}`)}]`);
    const entries = manifestMenu(JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')));
    const mergedContext = await headline.evaluate((node) => {
      const ancestors = [];
      for (let at: Element | null = node; at; at = at.parentElement) {
        const raw = at.getAttribute('data-vscode-context');
        if (raw) ancestors.unshift(JSON.parse(raw));
      }
      return Object.assign({}, ...ancestors);
    });
    assert.deepEqual(menuGroups(entries, mergedContext).flat(), []);
    await headline.dispatchEvent('contextmenu');
    await page.evaluate('window.__posted.length = 0');
    await headline.click();
    await headline.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => (window as any).__posted.length === 2);
    assert.deepEqual(await page.evaluate('window.__posted'), [
      { type: 'showSession', session: '01a137a5-3d93-71d0-9492-965abeb0fa32', responseLink: true },
      { type: 'showSession', session: '01a137a5-3d93-71d0-9492-965abeb0fa32', responseLink: true },
    ]);
    assert.equal(await head.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('.turn.is-read').count(), 0);
    await headline.evaluate((node) => {
      (window as any).__oldHeadline = node;
    });
    await post(page, { type: 'activity', session: preview.sessionId, card: { ...preview, headlineHtml: undefined } });
    await page.evaluate('window.__posted.length = 0; window.__oldHeadline.click()');
    assert.deepEqual(
      await page.evaluate('window.__posted'),
      [],
      'the removed headline retained its navigation handler',
    );
    const updated = {
      ...preview,
      headlineHtml: preview.headlineHtml!.replace('01a137a5-3d93-71d0-9492-965abeb0fa32', id),
    };
    await post(page, { type: 'activity', session: preview.sessionId, card: updated });
    await headline.click();
    assert.deepEqual(await page.evaluate('window.__posted'), [
      { type: 'showSession', session: id, responseLink: true },
    ]);
    await post(page, {
      type: 'activity',
      session: preview.sessionId,
      card: { ...updated, headlineHtml: updated.headlineHtml.replace(id, 'bad/id') },
    });
    await page.evaluate('window.__posted.length = 0');
    await headline.click();
    assert.deepEqual(await page.evaluate('window.__posted'), []);
    await head.focus();
    await page.keyboard.press('Enter');
    assert.equal(await head.getAttribute('aria-expanded'), 'true');
    const card = {
      ...payload.cards[0],
      summaryHtml:
        renderRichMarkdown(
          `[**Claude cache controls**](arc-session:${id})\n\n| Session |\n| --- |\n| [Cache controls](ARC-SESSION:${id}) |`,
        ) +
        `<p><a href="#" data-link="  ArC-SeSsIoN:${id}">Scoped session</a> <a href="#" data-link="arc-session:%zz">Invalid session</a></p>`,
    };
    await post(page, { ...payload, cards: [card] });
    await page.locator(`[data-control=${JSON.stringify(`card:${card.key}`)}]`).click();
    for (const link of await page.locator('a[data-link]').all()) {
      const context = await link.evaluate((node) => {
        const ancestors = [];
        for (let at: Element | null = node; at; at = at.parentElement) {
          const raw = at.getAttribute('data-vscode-context');
          if (raw) ancestors.unshift(JSON.parse(raw));
        }
        return Object.assign({}, ...ancestors);
      });
      assert.deepEqual(
        menuGroups(entries, { ...context, ...JSON.parse((await link.getAttribute('data-vscode-context'))!) }).flat(),
        [],
      );
      assert.match((await link.getAttribute('aria-label'))!, /Open session:/);
    }
    await page.evaluate('window.__posted.length = 0');
    await page.locator('a[data-link] strong').click();
    await page.locator('table a[data-link]').focus();
    await page.keyboard.press('Enter');
    await page.locator('a[data-link]').filter({ hasText: 'Scoped session' }).click();
    await page.locator('a[data-link]').filter({ hasText: 'Invalid session' }).click();
    assert.deepEqual(await page.evaluate('window.__posted'), [
      { type: 'showSession', session: id, responseLink: true },
      { type: 'showSession', session: id, responseLink: true },
      { type: 'showSession', session: id, responseLink: true },
    ]);
  } finally {
    await browser.close();
  }
});

test('a rendered Markdown table link offers Copy Link for its destination', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const payload = renderPayload() as Payload;
    const card = {
      ...payload.cards[0],
      summaryHtml: renderRichMarkdown(
        '| Report | Destination |\n| --- | --- |\n| Weekly | [Open report](https://example.com/reports/weekly?view=full#results) |',
      ),
    };
    await post(page, { ...payload, cards: [card] });
    await page.locator(`[data-control=${JSON.stringify(`card:${card.key}`)}]`).click();
    const link = page.locator('table a[data-link]');
    await link.dispatchEvent('contextmenu');
    assert.deepEqual(JSON.parse((await link.getAttribute('data-vscode-context')) || '{}'), {
      webviewSection: 'arcTableLink',
      link: 'https://example.com/reports/weekly?view=full#results',
      arcCopyLink: true,
      preventDefaultContextMenuItems: true,
    });
  } finally {
    await browser.close();
  }
});

test('a non-file summary URI keeps Copy Path context without handoff identity', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const payload = renderPayload() as Payload;
    const card = {
      ...payload.cards[0],
      summaryHtml:
        '<p><a data-link="mailto:reader@example.com">mail</a> ' +
        '<a data-link="data:text/plain,hello">data</a> ' +
        '<a data-link="vscode:workbench.action.files.openFile">editor</a> ' +
        '<a data-link="x:foo">one-letter</a> ' +
        '<a data-link="  https://example.com">space-web</a> ' +
        '<a data-link="https://example.com">web</a> ' +
        '<a data-link="https:foo">opaque-https</a> ' +
        '<a data-link="http:/foo">path-http</a></p>',
    };
    await post(page, { ...payload, cards: [card] });
    await page.locator(`[data-control=${JSON.stringify(`card:${card.key}`)}]`).click();
    const contexts = await page
      .locator('a[data-link]')
      .evaluateAll((links) => links.map((link) => link.getAttribute('data-vscode-context')));
    assert.deepEqual(
      contexts.slice(0, 4).map((context) => JSON.parse(context || '{}')),
      [
        { webviewSection: 'arcLink', link: 'mailto:reader@example.com', preventDefaultContextMenuItems: true },
        { webviewSection: 'arcLink', link: 'data:text/plain,hello', preventDefaultContextMenuItems: true },
        {
          webviewSection: 'arcLink',
          link: 'vscode:workbench.action.files.openFile',
          preventDefaultContextMenuItems: true,
        },
        { webviewSection: 'arcLink', link: 'x:foo', preventDefaultContextMenuItems: true },
      ],
    );
    assert.deepEqual(contexts.slice(4), [null, null, null, null], 'an HTTP link gained a native local-link context');
  } finally {
    await browser.close();
  }
});

test('file, diff, and commit controls post one keyed action with editor modifiers', async (t) => {
  // Browser card actions retain their turn key and editor modifiers and post once.

  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setViewportSize({ width: 1350, height: 900 });
    await page.setContent(themed(pageHtml()));
    const payload = renderPayload() as Payload;
    // The turn that records files, subagents and commits at once, so all three chips are on it.
    const card = payload.cards[LONG_TURN_INDEX];
    const file = (card.files as Array<Record<string, unknown>>)[0];
    const commit = (card.commits as Array<Record<string, unknown>>)[0];
    payload.cards = [card];
    await post(page, payload);
    await page.evaluate(`window.__posted.length = 0`);

    // Each chip holds its own popover open, and the record is drawn inside it.
    const pop = page.locator('#chippop');
    const chip = (metric: string) =>
      page.locator(`[data-key=${JSON.stringify(card.key)}] .statchip[data-metric=${JSON.stringify(metric)}]`);
    await chip('files').click();
    const fileControl = pop.locator(`[data-control=${JSON.stringify(`file:${card.key}:${file.path}`)}]`);
    assert.equal(await fileControl.evaluate((node) => node.tagName), 'BUTTON');
    assert.equal(await fileControl.getAttribute('aria-label'), file.label);
    assert.equal(await fileControl.getAttribute('title'), file.shownPath);
    assert.match((await fileControl.locator('.nums').textContent()) || '', /\+\d+ −\d+/);
    await fileControl.click({ modifiers: ['Control'] });
    await pop.locator(`[data-control=${JSON.stringify(`diff:${card.key}`)}]`).click({ modifiers: ['Control'] });
    await page.keyboard.press('Escape');
    await pop.waitFor({ state: 'hidden' });
    await chip('commits').click();
    await pop.locator(`[data-control=${JSON.stringify(`commit:${card.key}:${commit.sha}`)}]`).click();
    assert.deepEqual(await page.evaluate(`window.__posted`), [
      { type: 'openFile', key: card.key, path: file.path, beside: true },
      { type: 'openTurnDiff', key: card.key, beside: true },
      { type: 'openCommit', key: card.key, sha: commit.sha, dir: commit.dir, beside: false },
    ]);
    const hashes = ['a123456' + '1'.repeat(33), 'b123456' + '2'.repeat(33)];
    const owners = ['C:/first', 'C:/second'];
    const pairs = hashes.map((objectSha, index) => ({
      ...commit,
      sha: objectSha.slice(0, 7),
      objectSha,
      dir: null,
      subject: 'Recorded ' + index,
      repository: { key: owners[index] + '/.git', root: owners[index], own: false },
    }));
    card.commits = pairs;
    await page.keyboard.press('Escape');
    await post(page, payload);
    await chip('commits').click();
    const shots = path.join(__dirname, '../shots');
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, 'separate-repository-commits-before.png') });
    card.commits = pairs.map((pair, index) => ({ ...pair, dir: owners[index] }));
    await page.keyboard.press('Escape');
    await post(page, payload);
    await chip('commits').click();
    await page.evaluate(`window.__posted.length = 0`);
    for (const [index, hash] of hashes.entries()) {
      const control = pop.locator(`[data-control=${JSON.stringify(`commit:${card.key}:${hash.slice(0, 7)}`)}]`);
      await control.click();
      await control.press('Enter');
      await control.press('Space');
      assert.deepEqual(
        await page.evaluate(`window.__posted.slice(-3)`),
        [0, 1, 2].map(() => ({ type: 'openCommit', key: card.key, sha: hash, dir: owners[index], beside: false })),
      );
    }
    await page.screenshot({ path: path.join(shots, 'separate-repository-commits-after.png') });
  } finally {
    await browser.close();
  }
});

test('a hover on the Files chip reaches a file row the pointer crosses to', async (t) => {
  // Hovering Files exposes file rows that the pointer can enter and open.

  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setViewportSize({ width: 1350, height: 900 });
    await page.setContent(pageHtml());
    const payload = renderPayload() as Payload;
    const card = payload.cards[LONG_TURN_INDEX];
    const file = (card.files as Array<Record<string, unknown>>)[0];
    payload.cards = [card];
    await post(page, payload);
    await page.locator(`[data-control=${JSON.stringify(`card:${card.key}`)}]`).click();
    await page.evaluate(`window.__posted.length = 0`);

    const pop = page.locator('#chippop');
    await page.locator(`[data-key=${JSON.stringify(card.key)}] .statchip[data-metric="files"]`).hover();
    await pop.waitFor({ state: 'visible' });
    // The hover popover exposes the same dialog controls as the pinned popover.

    assert.equal(await pop.getAttribute('role'), 'dialog');

    // The pointer crosses from the chip onto the row and presses it there.
    const row = pop.locator(`[data-control=${JSON.stringify(`file:${card.key}:${file.path}`)}]`);
    await row.hover();
    assert.equal(await pop.isHidden(), false, 'the popover shut as the pointer crossed into it');
    await row.click();
    assert.deepEqual(await page.evaluate(`window.__posted`), [
      { type: 'openFile', key: card.key, path: file.path, beside: false },
    ]);
  } finally {
    await browser.close();
  }
});

test('the pointer entering the Files popover cancels the close the chip armed', async (t) => {
  // Entering the popover cancels the close timer armed when the pointer leaves its chip.

  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setViewportSize({ width: 1350, height: 900 });
    await page.setContent(pageHtml());
    const payload = renderPayload() as Payload;
    const card = payload.cards[LONG_TURN_INDEX];
    payload.cards = [card];
    await post(page, payload);
    const chip = `[data-key=${JSON.stringify(card.key)}] .statchip[data-metric="files"]`;
    const pop = page.locator('#chippop');
    await page.locator(chip).hover();
    await pop.waitFor({ state: 'visible' });

    // Intercept the grace-period close timer and inspect its pending state without advancing wall time.

    await page.evaluate(`(() => {
      const realSet = window.setTimeout;
      const realClear = window.clearTimeout;
      let next = -1;
      window.__grace = {
        armed: [], cleared: [],
        restore() { window.setTimeout = realSet; window.clearTimeout = realClear; },
      };
      window.setTimeout = function (run, delay, ...rest) {
        if (delay !== ${HOVER_GRACE_MS}) { return realSet.call(window, run, delay, ...rest); }
        const id = next--;
        window.__grace.armed.push({ id, run });
        return id;
      };
      window.clearTimeout = function (id) {
        if (typeof id === 'number' && id < 0) { window.__grace.cleared.push(id); return undefined; }
        return realClear.call(window, id);
      };
    })()`);
    const state = () =>
      page.evaluate(`(() => ({
      armed: window.__grace.armed.length,
      cleared: window.__grace.cleared.length,
      shown: !document.getElementById('chippop').hidden,
    }))()`);

    await page.evaluate(
      `document.querySelector(${JSON.stringify(chip)}).dispatchEvent(new PointerEvent('pointerleave'))`,
    );
    assert.deepEqual(
      await state(),
      { armed: 1, cleared: 0, shown: true },
      'the pointer leaving the chip shut the popover outright, so nothing holds it open across the gap',
    );

    await page.evaluate(`document.getElementById('chippop').dispatchEvent(new PointerEvent('pointerenter'))`);
    assert.deepEqual(
      await state(),
      { armed: 1, cleared: 1, shown: true },
      'the pointer reached the popover and the close the chip armed still stands',
    );

    // Leaving the popover arms another close timer. Running its callback closes the popover.

    await page.evaluate(`document.getElementById('chippop').dispatchEvent(new PointerEvent('pointerleave'))`);
    assert.deepEqual(
      await state(),
      { armed: 2, cleared: 1, shown: true },
      'the pointer leaving the popover armed no close of its own',
    );
    await page.evaluate(`window.__grace.armed[1].run()`);
    assert.deepEqual(
      await state(),
      { armed: 2, cleared: 1, shown: false },
      'the armed close ran and left the popover open',
    );
  } finally {
    await page.evaluate(`window.__grace && window.__grace.restore()`);
    await browser.close();
  }
});

test('card stat detail keeps its anchor and removes listeners with its card', async (t) => {
  // Pinned detail retains its anchor across updates. Removing the card disables its detached controls.

  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const payload = renderPayload() as Payload;
    payload.cards = payload.cards.slice(0, 2);
    const first = payload.cards[0];
    const second = payload.cards[1];
    const detail = (first.chips as Array<Record<string, unknown>>).find((chip) => chip.detail)!;
    detail.detail = 'Pinned card detail.';
    detail.detailList = null;
    await post(page, payload);
    const selector = `[data-key=${JSON.stringify(first.key)}] button.statchip.has-detail`;
    await page.locator(selector).first().click();
    await page.evaluate(`window.__cardStat = document.querySelector(${JSON.stringify(selector)})`);

    const changed = { ...second, headline: 'An unrelated card changed.' };
    await post(page, { type: 'activity', session: second.sessionId, card: changed });
    assert.deepEqual(
      await page.evaluate(`(() => ({
      same: window.__cardStat === document.querySelector(${JSON.stringify(selector)}),
      pinned: window.__cardStat.getAttribute('aria-pressed'),
      detail: document.querySelector('#chippop').textContent,
    }))()`),
      { same: true, pinned: 'true', detail: 'Pinned card detail.' },
    );

    await page.evaluate(`(() => { document.body.tabIndex = -1; document.body.focus(); })()`);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(`document.activeElement === window.__cardStat`), true);
    assert.equal(await page.locator('#chippop').isHidden(), true);

    await page.locator(selector).first().click();
    await page.mouse.move(0, 0);
    await post(page, { ...payload, cards: [second] });
    assert.equal(await page.locator('#chippop').isHidden(), true);
    assert.equal(await page.evaluate(`window.__cardStat.isConnected`), false);
    assert.equal(await page.evaluate(`window.__cardStat.getAttribute('aria-pressed')`), 'false');
    assert.equal(await page.locator('[aria-describedby="chippop"]').count(), 0);
    assert.equal(
      await page.evaluate(`(() => {
      window.__cardStat.click();
      return document.querySelector('#chippop').hidden;
    })()`),
      true,
    );
  } finally {
    await browser.close();
  }
});

test('cost chip selection keeps the pinned detail through running activity', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const payload = renderPayload() as Payload;
    const card = payload.cards[0];
    const cost = (card.chips as Array<Record<string, unknown>>).find((chip) => String(chip.label).startsWith('$'))!;
    cost.label = '$0.10';
    cost.detail = 'Original cost detail.';
    cost.detailList = {
      entries: [{ label: 'Estimated total', value: '$0.10', lines: ['Original cost detail.'] }],
    };
    payload.cards = [card];
    await post(page, payload);
    const selector = `[data-key=${JSON.stringify(card.key)}] button.statchip.has-detail[data-metric="cost"]`;
    await page.locator(selector).click();
    const selected = await page.evaluate(`(() => {
      const text = document.querySelector('#chippop .chippopsubitem')?.firstChild;
      if (!text) { throw new Error('The cost detail has no selectable text.'); }
      const range = document.createRange();
      range.selectNodeContents(text);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      window.__costChipAnchor = document.querySelector(${JSON.stringify(selector)});
      window.__costChipText = text;
      document.dispatchEvent(new Event('selectionchange'));
      return selection.toString();
    })()`);
    assert.equal(selected, 'Original cost detail.');

    const equivalent = structuredClone(card) as Record<string, unknown>;
    equivalent.activity = [
      ...(card.activity as unknown[]),
      {
        sourceId: 'cost-chip-selection:equivalent',
        kind: 'step',
        status: 'running',
        code: '',
        figure: '',
        since: null,
        line: 'Cost chip selection activity.',
        title: 'Cost chip selection activity.',
      },
    ];
    const equivalentCost = (equivalent.chips as Array<Record<string, unknown>>).find((chip) =>
      String(chip.label).startsWith('$'),
    )!;
    equivalentCost.detailList = structuredClone(cost.detailList);
    await post(page, { type: 'activity', session: card.sessionId, card: equivalent });
    assert.deepEqual(
      await page.evaluate(`(() => ({
      activity: document.body.textContent.includes('Cost chip selection activity.'),
      selected: getSelection().toString(),
      selectedNode: getSelection().anchorNode === window.__costChipText,
      sameButton: document.querySelector(${JSON.stringify(selector)}) === window.__costChipAnchor,
      sameAnchor: document.querySelector('[aria-describedby="chippop"]') === window.__costChipAnchor,
    }))()`),
      {
        activity: true,
        selected: 'Original cost detail.',
        selectedNode: true,
        sameButton: true,
        sameAnchor: true,
      },
    );

    const changed = structuredClone(equivalent);
    const changedCost = (changed.chips as Array<Record<string, unknown>>).find((chip) =>
      String(chip.label).startsWith('$'),
    )!;
    changedCost.label = '$0.20';
    changedCost.detail = 'Newest cost detail.';
    changedCost.detailList = {
      entries: [{ label: 'Estimated total', value: '$0.20', lines: ['Newest cost detail.'] }],
    };
    await post(page, { type: 'activity', session: card.sessionId, card: changed });
    assert.deepEqual(
      await page.evaluate(`(() => ({
      selected: getSelection().toString(),
      selectedNode: getSelection().anchorNode === window.__costChipText,
      sameButton: document.querySelector(${JSON.stringify(selector)}) === window.__costChipAnchor,
      sameAnchor: document.querySelector('[aria-describedby="chippop"]') === window.__costChipAnchor,
      oldDetail: document.querySelector('#chippop').textContent.includes('Original cost detail.'),
      newDetail: document.querySelector('#chippop').textContent.includes('Newest cost detail.'),
    }))()`),
      {
        selected: 'Original cost detail.',
        selectedNode: true,
        sameButton: true,
        sameAnchor: true,
        oldDetail: true,
        newDetail: false,
      },
    );

    await page.evaluate(
      `(() => { getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); })()`,
    );
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await page.evaluate(`(() => ({
      oldDetail: document.querySelector('#chippop').textContent.includes('Original cost detail.'),
      newDetail: document.querySelector('#chippop').textContent.includes('Newest cost detail.'),
      sameButton: document.querySelector(${JSON.stringify(selector)}) === window.__costChipAnchor,
      sameAnchor: document.querySelector('[aria-describedby="chippop"]') === window.__costChipAnchor,
    }))()`),
      { oldDetail: false, newDetail: true, sameButton: true, sameAnchor: true },
    );
  } finally {
    await browser.close();
  }
});

// The notes fold under one closed disclosure. A pinned popover reaches it by keyboard and keeps its focus and open state through a redraw.
test('figure notes disclosure is reachable when pinned and keeps focus and open state through a redraw', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const payload = renderPayload() as Payload;
    const card = payload.cards[0];
    const costOf = (held: Record<string, unknown>) =>
      (held.chips as Array<Record<string, unknown>>).find((chip) => String(chip.label).startsWith('$'))!;
    const cost = costOf(card);
    cost.label = '$0.10';
    cost.detail = 'Original cost detail.';
    cost.detailList = {
      entries: [{ label: 'Estimated total', value: '$0.10' }],
      footer: ['Some usage could not be priced.'],
      notes: ['Standing note.'],
    };
    payload.cards = [card];
    await post(page, payload);
    const selector = `[data-key=${JSON.stringify(card.key)}] button.statchip.has-detail[data-metric="cost"]`;
    const state = () =>
      page.evaluate(`(() => {
        const pop = document.querySelector('#chippop');
        const figure = document.querySelector(${JSON.stringify(selector)});
        const described = (figure.getAttribute('aria-describedby') || '')
          .split(' ')
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ');
        return {
          role: pop.getAttribute('role'),
          pinned: pop.classList.contains('pinned'),
          described,
          open: pop.querySelector('.chippopnotes')?.open ?? null,
          onSummary: document.activeElement === pop.querySelector('.chippopnotes summary'),
          onFigure: document.activeElement === figure,
        };
      })()`) as Promise<Record<string, unknown>>;
    await page.locator(selector).focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !!document.querySelector('#chippop:not([hidden]) .chippopnotes'));
    const pinned = await state();
    assert.equal(pinned.role, 'dialog');
    assert.equal(await page.getByRole('dialog', { name: /\$0\.10/ }).count(), 1, 'the dialog takes its figure name');
    assert.equal(pinned.open, false, 'the notes start closed');
    assert.match(String(pinned.described), /\$0\.10[\s\S]*Some usage could not be priced\./);
    assert.doesNotMatch(String(pinned.described), /Standing note|About these figures/);

    // A control right after the figure takes a native Tab unless the popover claims it.
    await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).after(document.createElement('button'))`);
    await page.keyboard.press('Tab');
    await page.waitForFunction(() => document.activeElement?.matches('#chippop .chippopnotes summary') === true);
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => document.querySelector<HTMLDetailsElement>('#chippop .chippopnotes')?.open === true,
    );

    const changed = structuredClone(card) as Record<string, unknown>;
    changed.activity = [
      ...(card.activity as unknown[]),
      {
        sourceId: 'notes-disclosure:redraw',
        kind: 'step',
        status: 'running',
        code: '',
        figure: '',
        since: null,
        line: 'Notes disclosure activity.',
        title: 'Notes disclosure activity.',
      },
    ];
    const changedCost = costOf(changed);
    changedCost.label = '$0.20';
    changedCost.detailList = {
      ...(cost.detailList as object),
      entries: [{ label: 'Estimated total', value: '$0.20' }],
    };
    await post(page, { type: 'activity', session: card.sessionId, card: changed });
    await page.waitForFunction(() => document.querySelector('#chippop')?.textContent?.includes('$0.20') === true);
    const redrawn = await state();
    assert.equal(redrawn.onSummary, true, 'focus stays on the summary through the redraw');
    assert.equal(redrawn.open, true, 'the notes stay open through the redraw');

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#chippop')?.hasAttribute('hidden') === true);
    assert.equal((await state()).onFigure, true, 'Escape returns focus to the figure');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !!document.querySelector('#chippop:not([hidden]) .chippopnotes'));
    assert.equal((await state()).open, true, 'the panel keeps one open state for the notes');

    // A hover shows the closed summary. Pinning that hover drawing restores the open state.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#chippop')?.hasAttribute('hidden') === true);
    await page.locator(selector).hover();
    await page.waitForFunction(() => !!document.querySelector('#chippop:not([hidden]) .chippopnotes'));
    const hovered = await state();
    assert.equal(hovered.pinned, false, 'the hover pinned the popover, so this measures nothing');
    assert.equal(hovered.open, false, 'a hover opens the notes');
    await page.locator(selector).click();
    await page.waitForFunction(() => document.querySelector('#chippop')?.classList.contains('pinned') === true);
    assert.equal((await state()).open, true, 'pinning a hover drawing leaves the notes closed');
  } finally {
    await browser.close();
  }
});

test('cost chip selection drops deferred detail before an immediate newer redraw', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const payload = renderPayload() as Payload;
    const card = payload.cards[0];
    const cost = (card.chips as Array<Record<string, unknown>>).find((chip) => String(chip.label).startsWith('$'))!;
    cost.label = '$0.10';
    cost.detail = 'Original cost detail.';
    cost.detailList = { entries: [{ label: 'Estimated total', value: '$0.10', lines: ['Original cost detail.'] }] };
    payload.cards = [card];
    await post(page, payload);
    const selector = `[data-key=${JSON.stringify(card.key)}] button.statchip.has-detail[data-metric="cost"]`;
    await page.locator(selector).click();
    await page.evaluate(`(() => {
      const text = document.querySelector('#chippop .chippopsubitem')?.firstChild;
      if (!text) { throw new Error('The cost detail has no selectable text.'); }
      const range = document.createRange();
      range.selectNodeContents(text);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    })()`);

    const deferred = structuredClone(card) as Record<string, unknown>;
    const deferredCost = (deferred.chips as Array<Record<string, unknown>>).find((chip) =>
      String(chip.label).startsWith('$'),
    )!;
    deferredCost.label = '$0.20';
    deferredCost.detail = 'Deferred cost detail A.';
    deferredCost.detailList = {
      entries: [{ label: 'Estimated total', value: '$0.20', lines: ['Deferred cost detail A.'] }],
    };
    await post(page, { type: 'activity', session: card.sessionId, card: deferred });

    await page.evaluate(`(() => {
      window.__blockSelectionChange = (event) => event.stopImmediatePropagation();
      document.addEventListener('selectionchange', window.__blockSelectionChange, true);
      getSelection().removeAllRanges();
    })()`);
    const immediate = structuredClone(deferred);
    const immediateCost = (immediate.chips as Array<Record<string, unknown>>).find((chip) =>
      String(chip.label).startsWith('$'),
    )!;
    immediateCost.label = '$0.30';
    immediateCost.detail = 'Immediate cost detail B.';
    immediateCost.detailList = {
      entries: [{ label: 'Estimated total', value: '$0.30', lines: ['Immediate cost detail B.'] }],
    };
    await post(page, { type: 'activity', session: card.sessionId, card: immediate });
    assert.deepEqual(
      await page.evaluate(`(() => ({
      collapsed: getSelection().isCollapsed,
      deferred: document.querySelector('#chippop').textContent.includes('Deferred cost detail A.'),
      immediate: document.querySelector('#chippop').textContent.includes('Immediate cost detail B.'),
    }))()`),
      { collapsed: true, deferred: false, immediate: true },
    );

    await page.evaluate(`(() => {
      document.removeEventListener('selectionchange', window.__blockSelectionChange, true);
      document.dispatchEvent(new Event('selectionchange'));
    })()`);
    assert.deepEqual(
      await page.evaluate(`(() => ({
      deferred: document.querySelector('#chippop').textContent.includes('Deferred cost detail A.'),
      immediate: document.querySelector('#chippop').textContent.includes('Immediate cost detail B.'),
    }))()`),
      { deferred: false, immediate: true },
    );
  } finally {
    await browser.close();
  }
});

test('next-turn cost chip opens cold detail after a closed cache crosses its boundary', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const untilCold = 2_000;
    const coldAt = Number(await page.evaluate('Date.now()')) + untilCold;
    await post(page, nextTurnPayload('warm', coldAt - 3_600_000 + CONSERVATIVE_CACHE_BOUNDARY_MS));
    assert.equal(await page.locator('.cnextturn').getAttribute('data-state'), 'warm');
    await page.clock.fastForward(untilCold + 300);
    assert.equal(await page.locator('.cnextturn').getAttribute('data-state'), 'cold');
    await page.locator('.cnextturnface:not(.is-off) .cnextturnprice').click();
    const detail = (await page.locator('#chippop').textContent()) || '';
    assert.match(detail, /uncached/, `the closed cost chip retained warm detail: ${detail}`);
    assert.match(detail, /Cost if cache were warm/, `the cold cost chip kept the warm comparison: ${detail}`);
  } finally {
    await browser.close();
  }
});

test('a long activity update keeps the chosen disclosure and visible row', async (t) => {
  // A long Activity update retains disclosure state and the visible row.

  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setViewportSize({ width: 500, height: 350 });
    await page.setContent(pageHtml());
    const payload = renderPayload() as Payload;
    const card = payload.cards[0];
    const base = { kind: 'step', status: 'done', code: '', figure: '', since: null, title: '' };
    card.activity = Array.from({ length: 40 }, (_, index) => ({
      ...base,
      sourceId: `long:${index}`,
      line: `Activity row ${index}`,
      title: `Activity row ${index}`,
    }));
    payload.cards = [card];
    await post(page, payload);
    await page.locator(`[data-control=${JSON.stringify(`card:${card.key}`)}]`).click();
    await page.locator(`[data-control=${JSON.stringify(`activity:${card.key}`)}]`).click();
    await page.locator(`[data-control=${JSON.stringify(`activity:${card.key}`)}]`).click();
    const row = page.locator(`[data-key=${JSON.stringify(card.key)}] .actrow`).nth(25);
    await row.scrollIntoViewIfNeeded();
    await row.evaluate((node) => {
      (window as Window & { __activityRow?: Element }).__activityRow = node;
    });
    const top = await row.evaluate((node) => node.getBoundingClientRect().top);

    const updated = {
      ...card,
      activity: [...(card.activity as unknown[]), { ...base, sourceId: 'long:new', line: 'New final row' }],
    };
    await post(page, { type: 'activity', session: card.sessionId, card: updated });
    assert.deepEqual(
      await page.evaluate(`(() => {
      const row = document.querySelectorAll('[data-key=${JSON.stringify(card.key)}] .actrow')[25];
      return {
        same: row === window.__activityRow,
        top: row.getBoundingClientRect().top,
        expanded: document.querySelector('[data-control=${JSON.stringify(`activity:${card.key}`)}]').getAttribute('aria-expanded'),
      };
    })()`),
      { same: true, top, expanded: 'true' },
    );
  } finally {
    await browser.close();
  }
});

test("the session menu button presses the row's own context menu", async (t) => {
  // Pressing the focused menu button raises the session row's context-menu event.

  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const payload = renderPayload() as Payload;
    await post(page, payload);
    const sessionId = payload.cards[0].sessionId;

    await page.evaluate(`(() => {
      window.__contextMenuEvent = null;
      document.querySelector('.sessionrow[data-vscode-context]').addEventListener('contextmenu', (event) => {
        window.__contextMenuEvent = { x: event.clientX, y: event.clientY };
      });
    })()`);
    const button = page.locator(`[data-control=${JSON.stringify(`sessionmenu:${sessionId}`)}]`);
    await button.focus();
    await button.press('Enter');

    assert.notEqual(
      await page.evaluate('window.__contextMenuEvent'),
      null,
      'pressing the drawn menu button raised no contextmenu event on the row that carries data-vscode-context',
    );
  } finally {
    await browser.close();
  }
});

interface HeadingPin {
  pinned: boolean;
  pressed: string | null;
  name: string | null;
  hint: string | undefined;
  detail: string | undefined;
  title: string | null;
  blue: boolean;
}

// Read pin presence, pressed state, and notice colour using the page's theme variable.

async function headingPin(page: Page, session: string): Promise<HeadingPin | null> {
  return (await page.evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(`#list [data-control="sessionpin:${session}"]`)});
    if (!node) { return null; }
    const probe = document.createElement('span');
    probe.style.color = 'var(--notice)';
    document.body.append(probe);
    const notice = getComputedStyle(probe).color;
    probe.remove();
    return {
      pinned: node.classList.contains('is-pinned'),
      pressed: node.getAttribute('aria-pressed'),
      name: node.getAttribute('aria-label'),
      hint: node.dataset.hint,
      detail: node.dataset.hintDetail,
      title: node.getAttribute('title'),
      blue: getComputedStyle(node).color === notice,
    };
  })()`)) as HeadingPin | null;
}

function pinView(pinned: boolean, title: string): HeadingPin {
  return {
    pinned,
    pressed: String(pinned),
    name: `${CARD_ACTIONS.railPinHint}: ${title}`,
    hint: pinned ? CARD_ACTIONS.railUnpinHint : CARD_ACTIONS.railPinHint,
    detail: pinned ? CARD_ACTIONS.railUnpinDetail : CARD_ACTIONS.railPinDetail,
    title: null,
    blue: pinned,
  };
}

test('one press on the heading pin pins that session alone, and the rail files it under Pinned', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const payload = twoSessionPayload();
    await post(page, payload);
    const titles = new Map(
      await page
        .locator('#list .sessionrow')
        .evaluateAll((rows) =>
          rows.map(
            (row) =>
              [(row as HTMLElement).dataset.session ?? '', row.querySelector('.session .name')?.textContent ?? ''] as [
                string,
                string,
              ],
          ),
        ),
    );
    assert.deepEqual([...titles.keys()], ['s1', 's2'], 'the fixture no longer draws two headings');
    const view = (session: string, pinned: boolean) => pinView(pinned, titles.get(session) ?? '');
    assert.deepEqual(await headingPin(page, 's1'), view('s1', false));
    assert.deepEqual(await headingPin(page, 's2'), view('s2', false));

    await page.evaluate(`window.__posted.length = 0`);
    await page.locator('#list [data-control="sessionpin:s1"]').click();
    await page.evaluate(SETTLED);
    assert.deepEqual(await headingPin(page, 's1'), view('s1', true), 'a press on the heading pin left it unpinned');
    assert.deepEqual(
      await headingPin(page, 's2'),
      view('s2', false),
      'pinning one session turned another heading blue',
    );
    assert.ok(
      await page.evaluate(
        `window.__posted.some((m) => m.type === 'sessionMembership' && m.action === 'pin' && m.session === 's1')`,
      ),
      'the heading pin never asked the host to pin the session',
    );
    // The blue is the heading's only pinned mark, so the pointer over it keeps it.
    await page.locator('#list [data-control="sessionpin:s1"]').hover();
    assert.equal((await headingPin(page, 's1'))?.blue, true, 'the pinned mark went grey under the pointer');

    // The host answers the pin with a rail message that files the session under Pinned.
    const pinnedPayload = renderPayload([], [], [], [], [], ['s1']) as Payload & {
      views: unknown;
      railFilters: unknown;
    };
    await post(page, {
      type: 'rail',
      rail: pinnedPayload.rail,
      labels: pinnedPayload.labels,
      views: pinnedPayload.views,
      railFilters: pinnedPayload.railFilters,
      stats: payload.stats,
      hidden: [],
      pinnedTop: ['s1'],
    });
    assert.ok(
      (await page.locator(`.railrow[data-rail-bucket="${RAIL_FOLDS.top}"] [data-control="rail:s1"]`).count()) > 0,
      'the rail does not show the pinned session under Pinned',
    );
    assert.deepEqual(await headingPin(page, 's1'), view('s1', true), 'the host answer turned the heading pin grey');

    await page.locator('#list [data-control="sessionpin:s1"]').click();
    await page.evaluate(SETTLED);
    assert.deepEqual(await headingPin(page, 's1'), view('s1', false), 'a second press left the session pinned');
    assert.ok(
      await page.evaluate(
        `window.__posted.some((m) => m.type === 'sessionMembership' && m.action === 'unpin' && m.session === 's1')`,
      ),
      'the heading pin never asked the host to unpin the session',
    );
  } finally {
    await browser.close();
  }
});

test('the heading pin follows a pin made from the rail, its P key or the menu, and an archived session draws none', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(themed(pageHtml()));
    await post(page, renderPayload());
    await page.evaluate('window.__posted.length = 0');
    const pressed = async () => (await headingPin(page, 's1'))?.pressed;

    await page.locator('[data-control="rail:s1"]').first().hover();
    await page.locator('[data-control="railpin:s1"]').first().click();
    await page.evaluate(SETTLED);
    assert.equal(await pressed(), 'true', 'a pin from the rail left the heading pin grey');
    // The menu's Pin and Unpin rows reach the panel as this host message.
    await post(page, { type: 'setSessionPinned', session: 's1', pinned: false });
    assert.equal(await pressed(), 'false', 'an unpin from the menu left the heading pin blue');
    await page.locator('[data-control="rail:s1"]').first().focus();
    await page.keyboard.press('p');
    await page.evaluate(SETTLED);
    assert.equal(await pressed(), 'true', "the rail's P key left the heading pin grey");
    await post(page, { type: 'setSessionPinned', session: 's1', pinned: false });
    await post(page, { type: 'setSessionPinned', session: 's1', pinned: true });
    assert.equal(await pressed(), 'true', 'a pin from the menu left the heading pin grey');

    assert.deepEqual(
      await page.evaluate(
        `window.__posted.filter(message => message.type === 'sessionMembership' || message.type === 'saveState')`,
      ),
      [
        { type: 'sessionMembership', action: 'pin', session: 's1', openPinned: true },
        { type: 'sessionMembership', action: 'unpin', session: 's1' },
        { type: 'sessionMembership', action: 'pin', session: 's1', openPinned: true },
        { type: 'sessionMembership', action: 'unpin', session: 's1' },
        { type: 'sessionMembership', action: 'pin', session: 's1' },
      ],
    );
    const heading = page.locator('#list .sessionrow[data-session="s1"]');
    const pin = heading.locator('[data-control="sessionpin:s1"]');
    await pin.focus();
    assert.equal(await pin.evaluate((node) => node.tabIndex), 0);
    // Archiving removes the focused pin. Its heading keeps focus and one timeline stop.
    await post(page, { type: 'setSessionArchived', session: 's1', archived: true });
    assert.equal(await headingPin(page, 's1'), null, "an archived session's heading still draws a pin");
    assert.equal(
      await heading.evaluate((node) => node.contains(document.activeElement)),
      true,
      'archive lost actual heading focus',
    );
    assert.equal(await heading.evaluate(() => (document.activeElement as HTMLElement).tabIndex), 0);
    assert.equal(
      await page
        .locator('#list')
        .locator(ROVING_SELECTOR)
        .evaluateAll(
          (nodes) =>
            nodes.filter((node) => (node as HTMLElement).tabIndex === 0 && node.getClientRects().length > 0).length,
        ),
      1,
    );
    await post(page, { type: 'setSessionArchived', session: 's1', archived: false });
    assert.equal((await headingPin(page, 's1'))?.pressed, 'false');
    await pin.focus();
    const prompt = page.locator('#prompt');
    await prompt.focus();
    await post(page, { type: 'setSessionArchived', session: 's1', archived: true });
    assert.equal(
      await prompt.evaluate((node) => node === document.activeElement),
      true,
      'archive moved focus out of the Prompt box',
    );
    assert.equal(await heading.locator('[tabindex="0"]').count(), 1, 'archive lost the unfocused heading stop');
    await post(page, { type: 'setSessionArchived', session: 's1', archived: false });
    await pin.focus();
    assert.equal(await pin.evaluate((node) => node === document.activeElement && node.tabIndex === 0), true);
    await post(page, { type: 'setSessionArchived', session: 's1', archived: true });
    await post(page, renderPayload(['s1']));
    assert.equal(
      await page.locator('#list .sessionrow[data-session="s1"]').count(),
      1,
      'the archived session drew no heading, so this measures nothing',
    );
    assert.equal(await headingPin(page, 's1'), null, "an archived session's heading draws a pin on a fresh render");
  } finally {
    await browser.close();
  }
});

test('the heading pin follows a pin made while a comment editor holds the next view back', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const { payload, second } = twoSessionViews();
    await post(page, payload);
    const key = payload.cards[0].key;
    const opened = await page.evaluate(`(async () => {
      const card = document.querySelector('[data-key=${JSON.stringify(key)}]');
      if (card.querySelector('.body').hidden) {
        card.querySelector('.head').click();
        await ${SETTLED};
      }
      const range = document.createRange();
      range.selectNodeContents(card.querySelector('.summary p'));
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      await ${SETTLED};
      document.querySelector('.quotebar button').click();
      await ${SETTLED};
      const area = document.querySelector('.quoteslot .notearea');
      area.value = 'A draft the reader is still writing.';
      area.dispatchEvent(new Event('input', { bubbles: true }));
      return !!document.querySelector('.noteedit');
    })()`);
    assert.equal(opened, true, 'the comment editor did not open, so no view is held');
    await post(page, { ...payload, cards: [second], showing: 's2' });
    const held = payload.cards.map((card) => card.key);
    assert.deepEqual(await drawnKeys(page), held, 'the comment editor held nothing back, so this measures nothing');
    const pressed = (value: string) =>
      page.waitForFunction(
        `document.querySelector('#list [data-control="sessionpin:s1"]')?.getAttribute('aria-pressed') === ${JSON.stringify(value)}`,
        undefined,
        { timeout: 5_000 },
      );

    await page.locator('#list [data-control="sessionpin:s1"]').click();
    await pressed('true').catch(() => assert.fail('a press on the heading pin under a held view left it unpinned'));
    assert.deepEqual(
      await headingPin(page, 's1'),
      pinView(true, await page.locator('#list [data-control="session:s1"] .name').innerText()),
    );
    await post(page, { type: 'setSessionPinned', session: 's1', pinned: false });
    await pressed('false').catch(() =>
      assert.fail('an unpin from the menu under a held view left the heading pin blue'),
    );
    await page.locator('[data-control="railpin:s1"]').first().click({ force: true });
    await pressed('true').catch(() => assert.fail('a pin from the rail under a held view left the heading pin grey'));

    assert.deepEqual(await drawnKeys(page), held, 'the pin drew the view the comment editor was holding back');
    assert.equal(await page.locator('.noteedit').count(), 1, 'the pin closed the comment editor');
  } finally {
    await browser.close();
  }
});

test('heading read and membership context survive reversals while a comment holds a replacement and after release', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(themed(pageHtml()));
    const payload = renderPayload() as Payload;
    payload.rail = (payload.rail as Array<Record<string, unknown> & { id: string }>).map((row) => ({
      ...row,
      newestTurnAt: Math.max(
        ...payload.cards.filter((card) => card.sessionId === row.id).map((card) => Number(card.startedAt)),
      ),
    }));
    await post(page, payload);
    const key = payload.cards[0].key;
    const opened = await page.evaluate(`(async () => {
      const card = document.querySelector('[data-key=${JSON.stringify(key)}]');
      if (card.querySelector('.body').hidden) { card.querySelector('.head').click(); await ${SETTLED}; }
      const range = document.createRange(); range.selectNodeContents(card.querySelector('.summary p'));
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange')); await ${SETTLED};
      document.querySelector('.quotebar button').click(); await ${SETTLED};
      const area = document.querySelector('.quoteslot .notearea'); area.value = 'Keep this comment draft.';
      area.dispatchEvent(new Event('input', { bubbles: true }));
      return !!document.querySelector('.noteedit');
    })()`);
    assert.equal(opened, true);
    const next = structuredClone(payload);
    next.sessions[0].fullLabel = 'Replacement session title';
    next.sessions[0].label = 'Replacement session title';
    next.cards[0].headline = 'Replacement turn headline';
    next.cards[0].sessionTitle = 'Replacement session title';
    await post(page, next);
    const heading = page.locator('.sessionrow[data-session="s1"]');
    assert.notEqual(await heading.locator('button.session .name').textContent(), 'Replacement session title');
    // This check compares the read and membership context alone. The turn entries follow open turns, and marking a turn unread closes it.
    const context = () =>
      heading.evaluate((node) => {
        const parsed = JSON.parse((node as HTMLElement).dataset.vscodeContext!) as Record<string, unknown>;
        delete parsed.sessionTurnsShut;
        delete parsed.sessionTurnsOpen;
        return parsed;
      });
    const initialContext = await context();
    for (const value of [false, true, false, true]) {
      await post(page, { type: 'setSessionRead', session: 's1', read: value });
      assert.deepEqual(await context(), { ...initialContext, sessionRead: value ? 'read' : 'unread' });
      assert.equal(await page.locator('.noteedit').count(), 1);
    }
    const heldKeys = await drawnKeys(page);
    const heldTitle = await heading.locator('button.session .name').textContent();
    const heldStats = await heading.locator('.sessionstats').textContent();
    const readContext = await context();
    for (const pinned of [true, false, true]) {
      await post(page, { type: 'setSessionPinned', session: 's1', pinned });
      assert.deepEqual(await context(), { ...readContext, sessionPinned: pinned });
    }
    for (const archived of [true, false, true, false]) {
      await post(page, { type: 'setSessionArchived', session: 's1', archived });
      assert.deepEqual(await context(), {
        ...readContext,
        sessionPinned: false,
        webviewSection: archived ? 'arcSessionArchived' : 'arcSessionLive',
      });
      assert.equal(await heading.locator('button.session .name').textContent(), heldTitle);
      assert.equal(await heading.locator('.sessionstats').textContent(), heldStats);
      assert.deepEqual(await drawnKeys(page), heldKeys);
      assert.equal(await page.locator('.quoteslot .notearea').inputValue(), 'Keep this comment draft.');
    }
    await page.locator('.quoteslot .notearea').press('Escape');
    await page.evaluate(`getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange'));`);
    await page.evaluate(SETTLED);
    assert.equal(await heading.locator('button.session .name').textContent(), 'Replacement session title');
    for (const archived of [true, false, true, false]) {
      await post(page, { type: 'setSessionArchived', session: 's1', archived });
      assert.deepEqual(await context(), {
        ...readContext,
        sessionPinned: false,
        webviewSection: archived ? 'arcSessionArchived' : 'arcSessionLive',
      });
      assert.equal(await heading.locator('button.session .name').textContent(), 'Replacement session title');
    }
    for (const value of [false, true, false]) {
      await post(page, { type: 'setSessionRead', session: 's1', read: value });
      assert.deepEqual(await context(), { ...initialContext, sessionRead: value ? 'read' : 'unread' });
    }
  } finally {
    await browser.close();
  }
});

test('the session cost popover leads with its warning, splits into sections, shows its tabs on hover, and moves between tabs by arrow key', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    for (const width of [1350, 340]) {
      await page.setViewportSize({ width, height: 900 });
      await post(page, waitWarningPayload());
      await page.locator('.sessionstats [data-metric="cost"]').click();
      const pop = page.locator('.chippop.pinned');
      await pop.waitFor();
      const shape = await pop.evaluate((node) => ({
        lead: Array.from(node.children)
          .slice(0, 3)
          .map((child) => child.className),
        rowEnds: Array.from(node.querySelectorAll('.costrow:not(.costhead)')).map(
          (row) => row.lastElementChild?.className,
        ),
        sections: Array.from(node.querySelectorAll('[role="tabpanel"]')).map((panel) =>
          Array.from(panel.querySelectorAll('.costhead .costrole')).map((role) => role.textContent),
        ),
      }));
      assert.deepEqual(shape.lead, ['chippophead', 'line chippopwarning', 'split'], `${width}`);
      assert.ok(shape.rowEnds.length > 0);
      // Each row's bar sits under its name, dollars and percent.
      for (const end of shape.rowEnds) assert.equal(end, 'sbbar context-meter');
      // Both tabs draw the Main agent and Delegated sections.
      assert.deepEqual(shape.sections, [
        ['Main agent GPT-6.1 Sol', 'Delegated 3 agents'],
        ['Main agent GPT-6.1 Sol', 'Delegated 3 agents'],
      ]);
      // Each tab draws one row per figure: three usage categories and two delegated models, then
      // the five merged main agent tool rows and four delegated tool rows.
      assert.deepEqual(
        await pop.evaluate((node) =>
          Array.from(node.querySelectorAll('[role="tabpanel"]')).map(
            (panel) => panel.querySelectorAll('.costrow:not(.costhead)').length,
          ),
        ),
        [5, 9],
        `${width}`,
      );
      const selected = () =>
        pop.evaluate((node) => ({
          tab: node.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
          focused: document.activeElement?.getAttribute('aria-selected') === 'true',
          shown: Array.from(node.querySelectorAll<HTMLElement>('[role="tabpanel"]'))
            .filter((panel) => !panel.hidden)
            .map((panel) => panel.getAttribute('aria-labelledby')),
        }));
      // Each part the figure's description names: a tab panel by its tab, or another shown part.
      const described = () =>
        page.locator('.sessionstats [data-metric="cost"]').evaluate((figure) =>
          (figure.getAttribute('aria-describedby') ?? '')
            .split(' ')
            .filter(Boolean)
            .map((id) => {
              const part = document.getElementById(id);
              if (!part) return 'missing';
              if (part.hidden) return 'hidden';
              if (part.matches('.poptabs')) return 'strip';
              return part.getAttribute('role') === 'tabpanel' ? part.getAttribute('aria-labelledby') : 'part';
            }),
        );
      assert.deepEqual(
        (await described()).filter((part) => part !== 'part'),
        [`${await pop.getAttribute('id')}costtab-0`],
        `${width}`,
      );
      // Tab from the pinned figure enters the strip at the selected tab.
      await page.locator('.sessionstats [data-metric="cost"]').focus();
      await page.keyboard.press('Tab');
      assert.deepEqual(await selected(), {
        tab: 'Usage',
        focused: true,
        shown: [`${await pop.getAttribute('id')}costtab-0`],
      });
      for (const [key, tab] of [
        ['ArrowRight', 'Tools'],
        ['ArrowRight', 'Usage'],
        ['ArrowLeft', 'Tools'],
        ['Home', 'Usage'],
        ['End', 'Tools'],
      ]) {
        await page.keyboard.press(key);
        const now = await selected();
        assert.equal(now.tab, tab, key);
        assert.equal(now.focused, true, key);
        assert.equal(now.shown.length, 1, key);
      }
      // A press on a tab selects it and keeps the popover pinned.
      await pop.locator('[role="tab"]', { hasText: 'Tools' }).click();
      assert.equal(await page.locator('.chippop.pinned').count(), 1, 'a press on a tab closed the popover');
      assert.equal((await selected()).tab, 'Tools');
      // The figure's description names the shown panel, never the strip or a hidden panel.
      assert.deepEqual(
        (await described()).filter((part) => part !== 'part'),
        [`${await pop.getAttribute('id')}costtab-1`],
        `${width}`,
      );
      // Escape closes the pinned popover as before, and the next pin starts on Usage.
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.chippop.pinned'));
      await page.locator('.sessionstats [data-metric="cost"]').click();
      await pop.waitFor();
      assert.equal((await selected()).tab, 'Usage');
      // A press on a tab while the figure holds focus keeps the popover pinned.
      await pop.locator('[role="tab"]', { hasText: 'Tools' }).click();
      assert.equal(await page.locator('.chippop.pinned').count(), 1, 'a press from the figure closed the popover');
      assert.equal((await selected()).tab, 'Tools');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.chippop.pinned'));
      // A hover shows the strip on Usage. A press on a tab pins the popover on that tab.
      await page.mouse.move(0, 0);
      await page.locator('.sessionstats [data-metric="cost"]').hover();
      const hovered = page.locator('.chippop:not([hidden]):not(.pinned)');
      const hoverTools = hovered.locator('.poptabs [role="tab"]', { hasText: 'Tools' });
      await hoverTools.waitFor();
      assert.equal(await hovered.locator('[role="tab"][aria-selected="true"]').textContent(), 'Usage', `${width}`);
      // Only the tab strip takes pointer input in a hover popover. The notes stay closed to a press.
      assert.deepEqual(
        await hovered.evaluate((node) => {
          const input = (part: Element | null) => part && getComputedStyle(part).pointerEvents;
          return [
            input(node),
            input(node.querySelector('.poptabs')),
            input(node.querySelector('.chippopnotes summary')),
          ];
        }),
        ['none', 'auto', 'none'],
        `${width}`,
      );
      await hoverTools.click();
      await pop.waitFor();
      assert.equal((await selected()).tab, 'Tools', `${width}`);
      assert.equal((await selected()).shown.length, 1, `${width}`);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.chippop.pinned'));
      await page.mouse.move(0, 0);
    }
    // A taller tab places the popover again. A turn popover whose Usage tab fits below its figure
    // stays inside the viewport when its Tools tab needs the room above.
    const figure = page.locator('article.turn button.statchip[data-metric="cost"]').first();
    const pop = page.locator('.chippop.pinned');
    const box = () =>
      pop.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, height: rect.height, inner: window.innerHeight };
      });
    const figureBottom = () => figure.evaluate((node) => node.getBoundingClientRect().bottom);
    await page.setViewportSize({ width: 1350, height: 900 });
    await figure.click();
    await pop.waitFor();
    const usage = await box();
    await pop.locator('[role="tab"]', { hasText: 'Tools' }).click();
    const tools = await box();
    assert.ok(tools.height > usage.height + 12, `the Tools tab is ${tools.height}px against Usage ${usage.height}px`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.chippop.pinned'));
    // The viewport leaves the Usage tab just enough room below the figure.
    await page.setViewportSize({ width: 1350, height: Math.ceil((await figureBottom()) + 12 + usage.height) + 2 });
    await figure.click();
    await pop.waitFor();
    const fitted = await box();
    assert.ok(
      fitted.top > (await figureBottom()) && fitted.bottom <= fitted.inner,
      'Usage no longer fits below the figure',
    );
    await pop.locator('[role="tab"]', { hasText: 'Tools' }).click();
    const placed = await box();
    assert.ok(
      placed.bottom <= placed.inner,
      `the Tools tab ends at ${placed.bottom}px in a ${placed.inner}px viewport`,
    );
  } finally {
    await page.close();
  }
});

// Past three delegated models the rest wait behind the expander. A press in a hover pins the
// popover, and the open state holds through an update until the popover closes.
test('the Delegated section folds models past the third behind the View more expander', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    await page.setViewportSize({ width: 1350, height: 900 });
    const payload = waitWarningPayload('five');
    await post(page, payload);
    const figure = page.locator('.sessionstats [data-metric="cost"]');
    const state = () =>
      page.evaluate(() => {
        const pop = document.querySelector<HTMLElement>('.chippop:not([hidden])');
        const section = pop?.querySelectorAll('.costgrid:not([hidden]) .costsection')[1];
        return {
          pinned: Boolean(pop?.classList.contains('pinned')),
          shown: Array.from(section?.querySelectorAll<HTMLElement>('.costrow:not(.costhead)') ?? [])
            .filter((row) => !row.hidden)
            .map((row) => row.querySelector('.context-category-label')?.textContent),
          summary: section?.querySelector('.costmore summary')?.textContent,
          open: section?.querySelector('details')?.open,
        };
      });
    await figure.hover();
    await page.locator('.chippop:not([hidden]) .costmore summary').waitFor();
    assert.deepEqual(await state(), {
      pinned: false,
      shown: ['Model not recorded', 'GPT-6.1 Sol', 'Opus 5.5'],
      summary: 'View 2 more models',
      open: false,
    });
    await page.locator('.chippop:not([hidden]) .costmore summary').click();
    const opened = await state();
    assert.equal(opened.pinned, true, 'a press on the expander in a hover pins the popover');
    assert.equal(opened.shown.length, 5);
    assert.deepEqual([opened.summary, opened.open], ['Show fewer models', true]);
    await post(page, payload);
    assert.equal((await state()).shown.length, 5, 'an update closed the expander');
    // A changed payload redraws the popover, and the expander keeps the keyboard focus.
    await page.locator('.chippop.pinned .costmore summary').focus();
    const updated = structuredClone(payload) as {
      stats: Record<
        string,
        { metric: string; detailList?: { cost?: { sections: { facts?: { parts: string[] } }[] } } }[]
      >;
    };
    const facts = updated.stats.s1.find((stat) => stat.metric === 'cost')?.detailList?.cost?.sections[1]?.facts;
    assert.ok(facts, 'the fixture has a Delegated fact line');
    facts.parts.push('updated');
    await post(page, updated);
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('.chippop.pinned .costfacts')).some((line) =>
        line.textContent?.endsWith('· updated'),
      ),
    );
    assert.equal(
      await page.evaluate(() => document.activeElement?.matches('.chippop.pinned .costmore summary') ?? false),
      true,
      'a redraw took the focus from the expander',
    );
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.chippop.pinned'));
    await figure.click();
    await page.locator('.chippop.pinned .costmore summary').waitFor();
    assert.equal((await state()).summary, 'View 2 more models', 'a new pin opens with the expander closed');
  } finally {
    await page.close();
  }
});

test('cache-write warnings share cost faces and retain pinned detail through updates', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const payload = cacheWriteWarningPayload() as Payload;
    for (const width of [1350, 340]) {
      await page.setViewportSize({ width, height: 900 });
      await post(page, payload);
      await page.evaluate((minimum) => {
        document.getElementById('rail')!.style.flexBasis = `${minimum}px`;
      }, RAIL_WIDTH_MIN);
      await page.evaluate(SETTLED);
      const faces = await page.evaluate<
        Array<{
          text: string;
          signs: number;
          hidden: string;
          tabIndex: number;
          name: string;
          title: string;
          overflow: number;
        }>
      >(`(() => {
        const selectors = ['.sessionstats', '#list .turn .chips', '[data-control="rail:s1"] .railstats'];
        return selectors.map((selector) => {
          const chip = document.querySelector(selector + ' [data-metric="cost"]');
          const sign = chip?.querySelector('.statwarningsign');
          return { text: chip?.textContent, signs: chip?.querySelectorAll('.statwarningsign').length,
            hidden: sign?.getAttribute('aria-hidden'), tabIndex: sign?.tabIndex,
            name: chip?.getAttribute('aria-label'), title: chip?.getAttribute('title'),
            overflow: chip ? chip.scrollWidth - chip.clientWidth : null };
        });
      })()`);
      for (const face of faces) {
        assert.equal(face.signs, 1);
        assert.equal(face.hidden, 'true');
        assert.equal(face.tabIndex, -1);
        assert.match(face.text, /^\u26a0\ufe0e\$508$/);
        assert.ok(face.overflow <= 1, `cost figure clips at ${width}px`);
      }
      assert.match(faces[0].name, /Low cache reuse in this session/);
      assert.match(faces[1].name, /Low cache reuse in this session/);
      assert.match(faces[2].title, /3% cached/);
      assert.match(faces[2].title, /\$503 of \$508/);
      assert.match(
        (await page.locator('[data-control="rail:s1"]').getAttribute('aria-label')) || '',
        /Low cache reuse in this session/,
      );
      const chip = page.locator('.sessionstats [data-metric="cost"]');
      await chip.focus();
      await page.keyboard.press('Enter');
      assert.equal(await chip.getAttribute('aria-pressed'), 'true');
      // The warning leads the cost popover under its head, with one sign of its own.
      const first = page.locator('#chippop > .chippopwarning').first();
      assert.match(
        (await first.textContent()) || '',
        /Low cache reuse in this session.*\$503 of \$508 went to cache writes/s,
      );
      assert.equal(await first.locator('.statwarningsign').count(), 1);
      // The low cached share takes the warning tone. Its sign is a CSS mark screen readers skip,
      // so hidden words carry the warning to them.
      const low =
        'Less than 80% of input served from cache across at least five model requests and $0.50 of estimated input cost.';
      const facts = page.locator('#chippop .costgrid:not([hidden]) .costfacts').first();
      assert.equal(await facts.textContent(), `594 requests · 3% cached, warning: ${low} · 159k average input`);
      const cached = facts.locator('.chippopcachehit.is-warning');
      assert.equal(await cached.getAttribute('title'), low);
      assert.equal(await cached.locator('.sr-only').textContent(), `, warning: ${low}`);
      assert.equal(await cached.evaluate((node) => getComputedStyle(node, '::before').content), '"⚠︎" / ""');
      // Every cost row's percent wears the quiet tone class, as the approved boards draw it.
      const percents = page.locator('#chippop .costrow:not(.costhead) .pct');
      assert.ok((await percents.count()) > 0);
      assert.equal(await page.locator('#chippop .costrow:not(.costhead) .pct:not(.chippopscale)').count(), 0);
      const overflow = await page.locator('#chippop').evaluate((pop) => pop.scrollWidth - pop.clientWidth);
      assert.ok(overflow <= 1, `warning detail overflows at ${width}px`);
      await post(page, payload);
      assert.equal(await chip.getAttribute('aria-pressed'), 'true');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#chippop').isVisible(), false);
      assert.equal(await chip.evaluate((node) => document.activeElement === node), true);
    }
    const chip = page.locator('.sessionstats [data-metric="cost"]');
    await chip.click();
    const changed = structuredClone(payload);
    const cost = changed.stats.s1.find((stat) => stat.metric === 'cost')!;
    cost.warnings = [...(cost.warnings as unknown[]), { scope: 'delegated' }];
    await post(page, changed);
    assert.equal(await chip.locator('.statwarningsign').count(), 1, 'two flagged scopes must share one sign');
    const original = cost.detailList as { entries: Array<Record<string, unknown>> };
    cost.warnings = [];
    cost.detail = 'Updated cost detail.';
    cost.detailList = {
      ...original,
      cost: { ...(original as unknown as { cost: object }).cost, warnings: [] },
      entries: original.entries.map((entry) => ({
        ...entry,
        lines: (entry.lines as Array<Record<string, unknown>>).filter((line) => !line.warning),
      })),
    };
    await post(page, changed);
    assert.equal(await chip.locator('.statwarningsign').count(), 0);
    assert.equal(await chip.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#chippop .statwarningsign').count(), 0);
    await page.keyboard.press('Escape');
    assert.equal(await chip.evaluate((node) => document.activeElement === node), true);
  } finally {
    await browser.close();
  }
});

// The helper selects text inside one card before a session change removes that card.

async function heldOneCard(page: Page): Promise<string> {
  return (await page.evaluate(`(() => {
    const target = document.querySelector('article.turn .summary p');
    const range = document.createRange();
    range.selectNodeContents(target);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    return selection.toString();
  })()`)) as string;
}

async function drawnKeys(page: Page): Promise<(string | undefined)[]> {
  return await page
    .locator('article.turn')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.key));
}

function twoSessionViews(): { payload: Payload; second: Payload['cards'][number] } {
  const payload = renderPayload() as Payload;
  const first = payload.cards.slice(0, 3).map((card) => ({ ...card }));
  const second = {
    ...first[0],
    key: first[0].key.replace(/^s1:/, 's2:'),
    sessionId: 's2',
    sessionTitle: 'Codex parity sweep',
    headline: 'The session the reader opened.',
  };
  payload.cards = first;
  payload.showing = 's1';
  return { payload, second };
}

test('opening another session draws it while a selection is still held', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const { payload, second } = twoSessionViews();
    await post(page, payload);
    await page.locator(`[data-control=${JSON.stringify(`card:${payload.cards[0].key}`)}]`).click();
    assert.ok(await heldOneCard(page), 'nothing was selected, so the deferral under test never engages');

    await post(page, { ...payload, cards: [second], showing: 's2' });
    assert.deepEqual(await drawnKeys(page), [second.key], 'the timeline kept drawing the session the reader left');

    // Removing the outgoing selection must allow subsequent updates in the new session.

    const later = { ...second, key: `${second.key}:later`, headline: 'A turn that arrived after the change.' };
    await post(page, { ...payload, cards: [second, later], showing: 's2' });
    assert.deepEqual(
      await drawnKeys(page),
      [second.key, later.key],
      'an update arriving after the session change waited on the abandoned selection',
    );
  } finally {
    await browser.close();
  }
});

test('a selection spanning two cards does not hold back another session', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const { payload, second } = twoSessionViews();
    await post(page, payload);
    for (const card of payload.cards.slice(0, 2)) {
      await page.locator(`[data-control=${JSON.stringify(`card:${card.key}`)}]`).click();
    }
    const spanned = (await page.evaluate(`(() => {
      const cards = [...document.querySelectorAll('article.turn')];
      const start = cards[0].querySelector('.summary p').firstChild;
      const end = cards[1].querySelector('.summary p').firstChild;
      const range = document.createRange();
      range.setStart(start, 0);
      range.setEnd(end, end.textContent.length);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return selection.toString();
    })()`)) as string;
    assert.ok(spanned, 'nothing was selected across the two cards');

    await post(page, { ...payload, cards: [second], showing: 's2' });
    assert.deepEqual(
      await drawnKeys(page),
      [second.key],
      'a selection across two cards of the session being left held the new one back',
    );
  } finally {
    await browser.close();
  }
});

test('a session with no turns draws past a held selection and records what it drew', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const { payload } = twoSessionViews();
    await post(page, payload);
    await page.locator(`[data-control=${JSON.stringify(`card:${payload.cards[0].key}`)}]`).click();
    assert.ok(await heldOneCard(page), 'nothing was selected, so the deferral under test never engages');

    const bare = {
      ...payload,
      cards: [],
      showing: 's2',
      stats: {},
      diagnosis: { message: 'No turns were read for this session.' },
      usage: { ...payload.usage, composer: null },
    } as unknown as Payload;
    await post(page, bare);
    assert.deepEqual(
      await drawnKeys(page),
      [],
      'the session the reader left stayed on screen while their selection was alive',
    );

    // Reopening the first session replaces the empty view despite its active selection.

    const inForeign = (await page.evaluate(`(() => {
      const target = document.querySelector('.timeline-foreign');
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return selection.toString().trim();
    })()`)) as string;
    assert.ok(inForeign, 'the empty view drew no selectable text, so the rule under test never engages');

    await post(page, payload);
    assert.deepEqual(
      await drawnKeys(page),
      payload.cards.map((card) => card.key),
      'the empty view stayed while a selection inside it was alive',
    );
  } finally {
    await browser.close();
  }
});

test('dismissing a comment editor draws the session the reader opened', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const { payload, second } = twoSessionViews();
    await post(page, payload);
    const key = payload.cards[0].key;
    const opened = await page.evaluate(`(async () => {
      const card = document.querySelector('[data-key=${JSON.stringify(key)}]');
      if (card.querySelector('.body').hidden) {
        card.querySelector('.head').click();
        await ${SETTLED};
      }
      const target = card.querySelector('.summary p');
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      await ${SETTLED};
      document.querySelector('.quotebar button').click();
      await ${SETTLED};
      const area = document.querySelector('.quoteslot .notearea');
      area.value = 'A draft the reader walks away from.';
      area.dispatchEvent(new Event('input', { bubbles: true }));
      return !!document.querySelector('.noteedit');
    })()`);
    assert.equal(opened, true, 'the comment editor did not open, so the rule under test never engages');
    // Dismissing the comment editor must release the pending session view while another selection remains active.

    const elsewhere = (await page.evaluate(`(() => {
      const heading = [...document.querySelectorAll('article.turn .head')][1];
      const range = document.createRange();
      range.selectNodeContents(heading);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString().trim();
    })()`)) as string;
    assert.ok(elsewhere, 'no second selection was made, so the rule under test never engages');

    await post(page, { ...payload, cards: [second], showing: 's2' });
    assert.deepEqual(
      await drawnKeys(page),
      payload.cards.map((card) => card.key),
      'an open comment editor let a session change tear out the card it was anchored to',
    );

    await page.locator('.quoteslot .notearea').press('Escape');
    await page.evaluate(SETTLED);
    await page.locator(`[data-key=${JSON.stringify(second.key)}]`).waitFor();
    assert.deepEqual(
      await drawnKeys(page),
      [second.key],
      'the session the reader opened stayed parked after the editor was dismissed',
    );
  } finally {
    await browser.close();
  }
});

test('a turn arriving beside the card the reader is reading draws at once', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(pageHtml());
    const { payload } = twoSessionViews();
    await post(page, payload);
    const key = payload.cards[0].key;
    await page.locator(`[data-control=${JSON.stringify(`card:${key}`)}]`).click();
    const selected = await heldOneCard(page);
    assert.ok(selected, 'nothing was selected, so the rule under test never engages');

    // A new turn beside the selected card draws without replacing that card.

    const later = { ...payload.cards[2], key: `${key}:later`, headline: 'A turn that arrived while they read.' };
    await post(page, { ...payload, cards: [...payload.cards, later] });
    assert.deepEqual(
      await drawnKeys(page),
      [...payload.cards.map((card) => card.key), later.key],
      'a turn arriving beside the card the reader is reading waited on their selection',
    );
    assert.equal(
      await page.evaluate(`getSelection().toString()`),
      selected,
      'the redraw dropped the selection it was told to keep',
    );
  } finally {
    await browser.close();
  }
});

test('the gear opens Timeline layout with radio rows and keyboard dismissal', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    const payload = renderPayload() as Payload;
    Object.assign(payload, { timelineLayout: { cardLayout: 'two-columns', promptPosition: 'below' } });
    await page.setContent(themed(pageHtml(), 'dark'));
    await post(page, payload);
    const gear = page.locator('#list .sessionheading .sessionlayout').first();
    assert.equal(await gear.getAttribute('aria-haspopup'), 'dialog');
    assert.equal(await gear.getAttribute('aria-controls'), 'layoutpop');
    assert.equal(await gear.getAttribute('aria-expanded'), 'false');
    assert.equal(await gear.getAttribute('aria-label'), 'Timeline layout');

    await gear.click();
    await page.evaluate(SETTLED);
    const dialog = page.locator('#layoutpop');
    const read = () =>
      page.evaluate(`(() => {
      const pop = document.getElementById('layoutpop');
      return {
        hidden: pop.hidden,
        role: pop.getAttribute('role'),
        label: pop.getAttribute('aria-label'),
        groups: [...pop.querySelectorAll('[role="radiogroup"]')]
          .map((group) => document.getElementById(group.getAttribute('aria-labelledby')).textContent),
        checked: [...pop.querySelectorAll('[role="radio"][aria-checked="true"]')].map((row) => row.dataset.control),
        rows: [...pop.querySelectorAll('[role="radio"] .launchname')].map((name) => [name.textContent, name.title]),
        focused: document.activeElement?.dataset.control ?? null,
        expanded: document.querySelector('#list .sessionlayout').getAttribute('aria-expanded'),
      };
    })()`) as Promise<{
        hidden: boolean;
        role: string;
        label: string;
        groups: string[];
        checked: string[];
        rows: string[][];
        focused: string | null;
        expanded: string;
      }>;
    const opened = await read();
    assert.deepEqual(opened, {
      hidden: false,
      role: 'dialog',
      label: 'Timeline layout',
      groups: ['Card layout', 'Prompt'],
      checked: ['layout:cardLayout:two-columns', 'layout:promptPosition:below'],
      // Each row names its value and explains it on hover, in the words the Settings editor shows.
      rows: [
        [
          'Compact',
          "The card keeps its subagents, commits and files in the popovers under the figures in the card's top row.",
        ],
        ['One column', 'The card lists its subagents, commits and files under Activity.'],
        [
          'Two columns',
          'The card lists its subagents, commits and files beside the response on a wide card, and under Activity on a narrow one.',
        ],
        ['Above the response', 'The prompt leads the card, clamped to two lines.'],
        ['Below the response', 'The prompt follows the response, under its opening heading.'],
      ],
      focused: 'layout:cardLayout:two-columns',
      expanded: 'true',
    });

    // The arrows move within one group and wrap, and a press posts the row's value.
    await page.keyboard.press('ArrowDown');
    assert.equal((await read()).focused, 'layout:cardLayout:compact');
    await page.keyboard.press('Enter');
    await page.evaluate(SETTLED);
    const posted = await page.evaluate(`window.__posted.filter((message) => message.type === 'setLayout')`);
    assert.deepEqual(posted, [{ type: 'setLayout', key: 'cardLayout', value: 'compact' }]);

    // The dialog draws the value the host confirms, not the press.
    assert.deepEqual((await read()).checked, ['layout:cardLayout:two-columns', 'layout:promptPosition:below']);
    await page.evaluate(
      "window.postMessage({ type: 'layout', layout: { cardLayout: 'compact', promptPosition: 'above' } }, '*')",
    );
    await page.evaluate(SETTLED);
    assert.deepEqual((await read()).checked, ['layout:cardLayout:compact', 'layout:promptPosition:above']);

    await page.keyboard.press('Escape');
    await page.evaluate(SETTLED);
    const closed = await read();
    assert.equal(closed.hidden, true, 'Escape left the dialog open');
    assert.equal(closed.expanded, 'false');
    assert.equal(
      await gear.evaluate((node) => node === document.activeElement),
      true,
      'Escape did not return focus to the gear that opened the dialog',
    );

    await gear.click();
    await page.evaluate(SETTLED);
    assert.equal(await dialog.isVisible(), true);
    await page.mouse.click(5, 880);
    await page.evaluate(SETTLED);
    assert.equal(await dialog.isHidden(), true, 'a press outside the dialog left it open');

    // Tab past the final dialog row closes the dialog even when the editor consumes the key without moving page focus.

    await gear.click();
    await page.evaluate(SETTLED);
    await page.keyboard.press('Tab');
    assert.equal(
      (await read()).focused,
      'layout:promptPosition:above',
      'Tab from the Card layout row did not reach the Prompt row',
    );
    await page.evaluate(
      `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))`,
    );
    await page.evaluate(SETTLED);
    assert.equal(await dialog.isHidden(), true, 'Tab past the last row left the dialog open with focus outside it');

    // The dialog follows its gear when the panel resizes, right edge to right edge.
    await gear.click();
    await page.evaluate(SETTLED);
    const edges = `(() => {
      const pop = document.getElementById('layoutpop').getBoundingClientRect();
      const gear = document.querySelector('#list .sessionlayout').getBoundingClientRect();
      return { pop: Math.round(pop.right), gear: Math.round(gear.right), top: Math.round(pop.top), below: Math.round(gear.bottom) };
    })()`;
    const size = page.viewportSize() ?? { width: 1280, height: 900 };
    await page.setViewportSize({ width: size.width - 120, height: size.height });
    await page
      .waitForFunction(`(() => { const e = ${edges}; return e.pop === e.gear; })()`, undefined, { timeout: 5_000 })
      .catch(() => undefined);
    const placed = (await page.evaluate(edges)) as { pop: number; gear: number; top: number; below: number };
    assert.equal(placed.pop, placed.gear, 'the dialog stayed where it was when the panel narrowed under it');
    assert.ok(placed.top >= placed.below, 'the dialog covers the gear that opened it');
    await page.keyboard.press('Escape');
  } finally {
    await browser.close();
  }
});

for (const relation of ['dispatched', 'reader'] as const) {
  test(`the ${relation} parent opens by pointer and by Enter from the heading walk`, async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('Edge or Chrome is required');
      return;
    }
    const page = await browser.newPage();
    try {
      await page.setContent(themed(pageHtml()));
      const payload = renderPayload() as Payload;
      const stats = 'section.sessionsection[data-session="s1"] .sessionstats';
      const row = payload.sessions.find((candidate) => candidate.id === 's1')!;
      // The fixture lists the parent because parent navigation requires a session row.

      payload.sessions.push({ ...row, id: 'parent-session-full-id', label: 'Plan the dispatch', shown: false });
      await post(page, payload);
      const plain = await page.locator(stats).evaluate((node) => node.outerHTML);
      row.parent = { id: 'parent-session-full-id', label: 'Plan the dispatch', relation };
      await post(page, payload);
      const chip = page.locator(`${stats} button.sessionparent`);
      assert.equal(await chip.innerText(), 'from Plan the dispatch');

      await page.evaluate(`window.__posted.length = 0`);
      await chip.click();
      assert.deepEqual(
        await page.evaluate(
          `window.__posted.filter((message) => message.type === '${relation === 'reader' ? 'showReaderParent' : 'showSession'}')`,
        ),
        [{ type: relation === 'reader' ? 'showReaderParent' : 'showSession', session: 'parent-session-full-id' }],
        'a press did not ask the host to open the session that started this one',
      );

      // The walk reaches it after the heading's figures and before the label controls.
      await page.evaluate(`document.querySelector('#list .session').focus()`);
      const walk: string[] = [];
      for (let step = 0; step < 12; step += 1) {
        await page.keyboard.press('ArrowDown');
        walk.push(await page.evaluate<string>(`document.activeElement?.className ?? ''`));
        if (walk.at(-1)?.includes('sessionlabel')) {
          break;
        }
      }
      const at = walk.findIndex((name) => name.includes('sessionparent'));
      assert.ok(at > 0, `the heading walk never reached the press: ${JSON.stringify(walk)}`);
      assert.match(
        walk[at - 1],
        /statdetail/,
        `the press does not follow the heading's figures: ${JSON.stringify(walk)}`,
      );
      assert.match(
        walk[at + 1] ?? '',
        /sessionlabel/,
        `the press does not come before the label controls: ${JSON.stringify(walk)}`,
      );
      await page.keyboard.press('ArrowUp');
      await page.evaluate(`window.__posted.length = 0`);
      await page.keyboard.press('Enter');
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.evaluate(
          `window.__posted.filter((message) => message.type === '${relation === 'reader' ? 'showReaderParent' : 'showSession'}')`,
        ),
        [{ type: relation === 'reader' ? 'showReaderParent' : 'showSession', session: 'parent-session-full-id' }],
        'Enter did not ask the host to open the session that started this one',
      );

      delete row.parent;
      await post(page, payload);
      assert.equal(
        await page.locator(stats).evaluate((node) => node.outerHTML),
        plain,
        'a session with no parent draws figures that differ from a heading that never had one',
      );
    } finally {
      await browser.close();
    }
  });
}

// The subagent heading opens its parent by full session ID.

test('a subagent opened from its parent opens that parent again from its heading', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(themed(pageHtml()));
    const parentId = '3c2fb9d1-d328-4ec5-ba28-b7c0cbf56a89';
    const childId = 'a4f1c9e2b7d3e8f06';
    const base = renderPayload() as Payload & { timelineLayout?: unknown };
    base.cards = [base.cards[LONG_TURN_INDEX]];
    base.timelineLayout = { cardLayout: 'one-column', promptPosition: 'above' };
    const agents = base.cards[0].agents as Array<Record<string, unknown>>;
    const agent = agents.find((candidate) => candidate.sessionId);
    assert.ok(agent, 'the fixture turn has no subagent that opens as a session');
    agent.sessionId = childId;
    // Both views list the parent and child rows required for navigation.

    const shownAs = (shown: string, other: string) => {
      const view = JSON.parse(JSON.stringify(base).replaceAll('"s1"', JSON.stringify(shown))) as Payload;
      const row = view.sessions.find((candidate) => candidate.id === shown)!;
      view.sessions.push({
        ...row,
        id: other,
        label: other === parentId ? 'Plan the review' : 'Audit the rail',
        shown: false,
      });
      return { view, row };
    };

    const parent = shownAs(parentId, childId);
    parent.row.label = 'Plan the review';
    await post(page, parent.view);
    const card = page.locator('#list .turn').first();
    await card.locator('.head').click();
    await page.evaluate(`window.__posted.length = 0`);
    await card.locator('.recordagents .agentrow .namelink').first().click();
    assert.deepEqual(
      await page.evaluate(`window.__posted.filter((message) => message.type === 'showSession')`),
      [{ type: 'showSession', session: childId }],
      "the Subagents row did not open the subagent's own session",
    );

    const child = shownAs(childId, parentId);
    child.row.label = 'Audit the rail';
    child.row.parent = { id: parentId, label: 'Plan the review', relation: 'subagent' };
    await post(page, child.view);
    const chip = page.locator(`section.sessionsection[data-session="${childId}"] .sessionstats button.sessionparent`);
    assert.equal(await chip.innerText(), 'from Plan the review');
    assert.equal(await chip.getAttribute('data-hint'), 'Subagent from Plan the review');
    assert.equal(await chip.getAttribute('data-hint-detail'), 'Opens the session that started this one');
    assert.equal(await chip.getAttribute('aria-label'), 'Subagent from Plan the review, opens that session');
    await page.evaluate(`window.__posted.length = 0`);
    await chip.click();
    assert.deepEqual(
      await page.evaluate(`window.__posted.filter((message) => message.type === 'showSession')`),
      [{ type: 'showSession', session: parentId }],
      'the subagent heading did not open the session that started it',
    );
  } finally {
    await browser.close();
  }
});
