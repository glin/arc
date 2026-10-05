import assert from 'node:assert';
import { test } from 'vitest';
import { browserOrNone, SETTLED } from '../../test/browser.ts';
import { pageHtml, renderPayload, themed } from '../panelfixture.ts';

async function post(page: import('playwright-core').Page, payload: unknown): Promise<void> {
  await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
  await page.evaluate(SETTLED);
}

test('consecutive completed prompts retain independent response disclosures until recorded replacement', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(themed(pageHtml()));
    const first = {
      ...livePress('s1', 'prompt', 'First prompt', 'First response\n\nIts second paragraph'),
      at: 1,
      completed: true,
    };
    const second = { ...livePress('s1', 'prompt', 'Second prompt', 'Second response'), at: 2 };
    const payload = renderPayload([], [first, second]) as any;
    await post(page, payload);
    await page.waitForFunction(() => document.querySelectorAll('.clive[data-live="prompt"]').length === 2);
    const firstCard = page.locator('.clive[data-live-at="1"]');
    const secondCard = page.locator('.clive[data-live-at="2"]');
    await firstCard.locator('button.head').click();
    await page.waitForFunction(
      () => document.querySelector('.clive[data-live-at="1"] button.head')?.getAttribute('aria-expanded') === 'true',
    );
    assert.equal(await firstCard.locator('.cliveresponse').textContent(), first.reply);
    assert.equal(await secondCard.locator('button.head').getAttribute('aria-expanded'), 'false');
    const live = payload.usage.composer.live.map((card: any) =>
      card.at === 2 ? { ...card, reply: 'Second complete response' } : card,
    );
    await post(page, { type: 'live', session: 's1', live });
    await page.waitForFunction(
      () =>
        document.querySelector('.clive[data-live-at="2"] .clivereplytext')?.textContent === 'Second complete response',
    );
    assert.equal(await firstCard.locator('button.head').getAttribute('aria-expanded'), 'true');
    await post(page, { type: 'live', session: 's1', live: live.filter((card: any) => card.at === 2) });
    await page.waitForFunction(() => !document.querySelector('.clive[data-live-at="1"]'));
    assert.equal(await secondCard.locator('button.head').getAttribute('aria-expanded'), 'false');
  } finally {
    await browser.close();
  }
});

function queued(id: string, label: string) {
  return {
    id,
    label,
    text: `${label}\nThe complete queued prompt.`,
    long: true,
    openName: `Show ${label}`,
    shutName: `Hide ${label}`,
    control: `queue:${id}:open`,
    dropName: `Drop ${label}`,
    dropControl: `queue:${id}:drop`,
    dropLabel: 'Drop',
    editName: `Edit ${label}`,
    editControl: `queue:${id}:edit`,
    editLabel: 'Edit',
    copyText: `${label}\nThe complete queued prompt.`,
    copyName: `Copy ${label}`,
    copyControl: `queue:${id}:copy`,
    copyLabel: 'Copy',
    at: 1,
    relative: 'now',
    absolute: 'now',
    agent: 'Claude',
    headName: `Queued ${label}`,
    status: 'Waiting to send',
    reason: '',
    files: [
      {
        id: `${id}-file`,
        name: 'note.txt',
        preview: '',
        kind: 'TXT',
        stem: 'note',
        ext: '.txt',
        sizeLabel: '1 B',
        removeLabel: 'Remove',
        removeName: 'Remove attached file note.txt',
        removeControl: `remove:${id}-file`,
      },
    ],
  };
}

function livePress(sessionId: string, kind: 'prompt' | 'compact', text: string, reply: string) {
  return {
    sessionId,
    agent: 'claude' as const,
    kind,
    text,
    reply,
    at: Date.now(),
    midTurn: false,
    ran: true,
    started: true,
    failed: false,
    reason: '',
  };
}

test('queued submissions retain their keyed cards, disclosure, focus, and scoped actions', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(themed(pageHtml()));
    const payload = renderPayload() as any;
    const first = queued('first', 'First queued prompt');
    const second = queued('second', 'Second queued prompt');
    payload.usage.composer.queue = [first, second];
    await post(page, payload);
    assert.equal(
      await page.locator('.cwaiting .cfileremove, .clive .cfileremove').count(),
      0,
      'queued or live attachment chips expose Composer removal controls',
    );
    const card = page.locator('.cwaiting[data-queued="second"]');
    assert.equal(
      await card.evaluate((node) => node.querySelector(':scope > .cfiles')?.parentElement === node),
      true,
      'the queued attachment list is no longer a direct card child',
    );
    await page.evaluate(`window.__queuedCard = document.querySelector('.cwaiting[data-queued="second"]')`);
    await page.evaluate(`window.__queuedAttachment = document.querySelector('.cwaiting[data-queued="second"] .cstem')`);
    await card.locator('[data-control="queue:second:open"]').click();
    const edit = card.locator('[data-control="queue:second:edit"]');
    await edit.focus();
    const changed = structuredClone(payload.usage);
    changed.composer.queue = [second, { ...first, status: 'Waiting for the earlier turn' }];
    await post(page, { type: 'usage', usage: changed });
    assert.equal(
      await page.evaluate(`window.__queuedCard === document.querySelector('.cwaiting[data-queued="second"]')`),
      true,
    );
    assert.equal(
      await page.evaluate(
        `window.__queuedAttachment === document.querySelector('.cwaiting[data-queued="second"] .cstem')`,
      ),
      true,
      'an unrelated queued update replaced the surviving attachment node',
    );
    assert.equal(await card.locator('[data-control="queue:second:open"]').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.evaluate(`document.activeElement?.dataset.control`), 'queue:second:edit');
    await card.locator('[data-control="queue:second:drop"]').click();
    assert.deepEqual(await page.evaluate(`window.__posted.filter((message) => message.type === 'dequeue').at(-1)`), {
      type: 'dequeue',
      value: 'second',
      session: payload.usage.composer.sessionId,
    });
  } finally {
    await browser.close();
  }
});

test('a delayed queued edit preserves a newer draft and keeps the queued submission', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(themed(pageHtml()));
    const payload = renderPayload() as any;
    const waiting = queued('delayed', 'Queued prompt to edit');
    payload.usage.composer.queue = [waiting];
    await post(page, payload);

    const prompt = page.locator('#prompt');
    await prompt.fill('durable draft before edit');
    await page.locator('[data-control="queue:delayed:edit"]').click();
    const request = (await page.evaluate(
      `window.__posted.filter((message) => message.type === 'editQueued').at(-1)`,
    )) as { session: string; revision: number };
    assert.ok(Number.isSafeInteger(request.revision), 'the queued edit request omitted its draft revision');

    await prompt.fill('newer durable draft');
    await post(page, {
      type: 'takeQueuedDraft',
      session: request.session,
      text: waiting.text,
      revision: request.revision,
      value: waiting.id,
    });
    const usage = structuredClone(payload.usage);
    usage.composer.draft = 'newer durable draft';
    usage.composer.queue = [waiting];
    await post(page, { type: 'usage', usage });

    assert.equal(await prompt.inputValue(), 'newer durable draft');
    assert.equal(await page.locator('.cwaiting[data-queued="delayed"]').count(), 1);
    assert.deepEqual(
      await page.evaluate(`window.__posted.filter((message) => message.type === 'acceptQueuedEdit').at(-1)`),
      {
        type: 'acceptQueuedEdit',
        value: waiting.id,
        session: request.session,
        revision: request.revision,
        currentRevision: request.revision + 1,
        accepted: false,
      },
      'the browser did not release a queued edit whose delayed success found a newer draft',
    );
  } finally {
    await browser.close();
  }
});

test('a host-accepted queued edit replaces the current draft once', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(themed(pageHtml()));
    const payload = renderPayload() as any;
    const waiting = queued('accepted', 'Queued prompt to edit');
    payload.usage.composer.queue = [waiting];
    await post(page, payload);
    const prompt = page.locator('#prompt');
    await prompt.fill('active draft');
    await page.locator('[data-control="queue:accepted:edit"]').click();
    const request = (await page.evaluate(
      `window.__posted.filter((message) => message.type === 'editQueued').at(-1)`,
    )) as { session: string; revision: number };

    const success = {
      type: 'takeQueuedDraft',
      session: request.session,
      text: waiting.text,
      revision: request.revision,
      value: waiting.id,
    };
    await post(page, success);
    assert.equal(await prompt.inputValue(), waiting.text);
    assert.deepEqual(
      await page.evaluate(`window.__posted.filter((message) => message.type === 'acceptQueuedEdit').at(-1)`),
      {
        type: 'acceptQueuedEdit',
        value: waiting.id,
        session: request.session,
        revision: request.revision,
        currentRevision: request.revision + 1,
        accepted: true,
      },
    );

    await prompt.fill('newer edit after success');
    await post(page, success);
    assert.equal(
      await prompt.inputValue(),
      'newer edit after success',
      'a repeated delayed success overwrote the draft after the first accepted swap',
    );
    assert.equal(
      await page.evaluate(
        `window.__posted.filter((message) => message.type === 'acceptQueuedEdit' && message.accepted).length`,
      ),
      1,
      'the browser accepted the same queued edit twice',
    );
  } finally {
    await browser.close();
  }
});

test('a complete streamed response opens with keyboard focus through live and foot updates', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(themed(pageHtml()));
    const payload = renderPayload([], [livePress('s1', 'prompt', 'Continue here.', '')]) as any;
    await post(page, payload);
    const reply = `The response begins here.\n\n${'Response content. '.repeat(100)}\n\n<script>window.bad = true</script>`;
    const streamed = { ...payload.usage.composer.live[0], reply };
    await post(page, { type: 'live', session: 's1', live: [streamed] });
    const card = page.locator('.clive[data-live="prompt"]');
    const disclosure = card.locator('button.head');
    assert.equal(await disclosure.count(), 1, 'the response has no keyboard disclosure');
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'false');
    assert.ok((await card.locator('.clivereplytext').textContent())!.length <= 400);
    await disclosure.focus();
    await page.keyboard.press('Enter');
    await page.evaluate(SETTLED);
    const body = card.locator('.cliveresponse');
    assert.equal(await body.textContent(), reply);
    assert.equal(await body.getAttribute('aria-hidden'), null);
    assert.equal(await disclosure.getAttribute('aria-controls'), await body.getAttribute('id'));
    assert.ok((await disclosure.getAttribute('aria-label'))?.includes(streamed.agent));
    assert.ok(
      (await disclosure.getAttribute('aria-label'))?.includes(await card.locator('.headline').innerText()),
      'the response disclosure name omits its visible prompt',
    );
    assert.equal(
      await body.evaluate((node) =>
        node.closest('[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"]'),
      ),
      null,
      'the full response is inside a live announcement',
    );
    assert.equal(
      await disclosure.evaluate((node) =>
        node.closest('[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"]'),
      ),
      null,
      'the response disclosure is inside a live announcement',
    );
    const status = card.locator('.doing[role="status"]');
    assert.equal(await status.count(), 1, 'the concise activity status has no announcement');
    assert.equal(await status.locator('.actverb').textContent(), streamed.status);
    assert.equal(await status.locator('button, .cliveresponse').count(), 0);
    assert.equal(await body.locator('script').count(), 0);
    assert.equal(await page.evaluate('window.bad'), undefined);
    await page.evaluate(`window.__liveButton = document.querySelector('.clive button.head')`);
    const final = { ...streamed, reply: reply + '\n\nThe final chunk.' };
    await post(page, { type: 'live', session: 's1', live: [final] });
    await post(page, { type: 'fileStaging', session: 's1', token: 'unrelated-foot-update', pending: true });
    assert.equal(await body.textContent(), final.reply);
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.evaluate('document.activeElement === window.__liveButton'), true);
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate('document.activeElement === window.__liveButton'), false);
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate('document.activeElement === window.__liveButton'), true);
    await post(page, { type: 'live', session: 's2', live: [{ ...final, reply: 'Other session response.' }] });
    assert.equal(await body.textContent(), final.reply, 'another session changed the response');
    await page.keyboard.press('Space');
    await page.evaluate(SETTLED);
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'false');
    await page.keyboard.press('Enter');
    await page.evaluate(SETTLED);
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'true');
    await post(page, { type: 'live', session: 's1', live: [{ ...final, at: final.at + 1, reply: 'Later response.' }] });
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'false', 'a later submission inherited expansion');
    assert.equal(await card.locator('.cliveresponse').isVisible(), false);
    assert.equal(await card.locator('.cliveresponse').textContent(), '');
  } finally {
    await browser.close();
  }
});

test('selection holds the expanded response through streaming and removal until release', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(themed(pageHtml()));
    const reply = 'The beginning.\n\nThe selected paragraph.';
    const payload = renderPayload([], [livePress('s1', 'prompt', 'Continue here.', reply)]) as any;
    await post(page, payload);
    await page.locator('.clive button.head').click();
    await page.evaluate(`(() => {
      const text = document.querySelector('.cliveresponse').firstChild;
      window.__selectedResponse = text;
      const range = document.createRange();
      range.selectNodeContents(text);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    })()`);
    const final = { ...payload.usage.composer.live[0], reply: reply + '\n\nFinal paragraph.' };
    await post(page, { type: 'live', session: 's1', live: [final] });
    assert.equal(await page.locator('.cliveresponse').textContent(), reply);
    assert.equal(await page.evaluate('getSelection().toString()'), reply);
    await page.evaluate(`getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange'))`);
    await page.waitForFunction((text) => document.querySelector('.cliveresponse')?.textContent === text, final.reply);
    await page.evaluate(`(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('.cliveresponse').firstChild);
      getSelection().addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    })()`);
    await post(page, { type: 'live', session: 's1', live: [] });
    assert.equal(await page.locator('.cliveresponse').textContent(), final.reply);
    await page.evaluate(`getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange'))`);
    await page.waitForFunction(() => !document.querySelector('.clive[data-live="prompt"]'));
  } finally {
    await browser.close();
  }
});

test('failed response cards retain separate Restore and Dismiss actions', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(themed(pageHtml()));
    const press = { ...livePress('s1', 'prompt', 'Restore my prompt.', 'Partial response.'), failed: true };
    await post(page, renderPayload([], [press]));
    const card = page.locator('.clive[data-live="prompt"]');
    await card.locator('button.head').click();
    assert.equal(await card.locator('.cliveresponse').textContent(), press.reply);
    assert.equal(await card.locator('button button').count(), 0);
    await card.locator('.cliverestore').click();
    assert.deepEqual(await page.evaluate('window.__posted.at(-1)'), {
      type: 'restoreLive',
      session: 's1',
      kind: 'prompt',
    });
    await card.locator('.cliveoff').click();
    assert.deepEqual(await page.evaluate('window.__posted.at(-1)'), {
      type: 'dismissLive',
      session: 's1',
      kind: 'prompt',
    });
  } finally {
    await browser.close();
  }
});

test('live replies stay hidden and separate their duration figure in the DOM', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(themed(pageHtml()));
    await post(page, renderPayload([], [livePress('s1', 'prompt', 'Continue here.', 'Visible live reply.')]));
    const live = (await page.evaluate(`(() => {
      const reply = document.querySelector('.clive[data-live="prompt"] .clivereply');
      const figure = document.querySelector('.clive[data-live="prompt"] .actfig');
      return {
        hidden: reply?.getAttribute('aria-hidden'),
        separator: figure?.previousSibling?.nodeType === Node.TEXT_NODE ? figure.previousSibling.textContent : null,
      };
    })()`)) as { hidden: string | null; separator: string | null };
    assert.equal(live.hidden, 'true', 'the live reply is no longer hidden from assistive technology');
    assert.equal(live.separator, ' ', 'the duration figure no longer has its literal DOM separator');
  } finally {
    await browser.close();
  }
});

test('selection release draws live work in the switched session', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(themed(pageHtml()));
    const first = renderPayload([], [livePress('s1', 'prompt', 'First session.', 'Selected live reply.')]) as any;
    await post(page, first);
    await page.evaluate(`(() => {
      const text = document.querySelector('.clive .clivereplytext').firstChild;
      const range = document.createRange();
      range.selectNodeContents(text);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    })()`);
    const switched = renderPayload(
      [],
      [livePress('s2', 'prompt', 'Second session.', 'Live work in the new session.')],
    ) as any;
    switched.cards = [];
    switched.sessions = [];
    switched.showing = 's2';
    switched.usage.composer.sessionId = 's2';
    switched.usage.composer.targetName = 'Second session';
    await post(page, switched);
    await page.evaluate(
      `(() => { getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); })()`,
    );
    await page.evaluate(SETTLED);
    assert.equal(
      await page
        .locator('section.sessionsection[data-session="s2"] .transientcards > .clive[data-live="prompt"]')
        .count(),
      1,
      'the switched session lost its live card after selection release',
    );
  } finally {
    await browser.close();
  }
});

test('selection release draws queued work in a switched session after recorded text', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(themed(pageHtml()));
    await post(page, renderPayload());
    await page.evaluate(`(() => {
      const text = document.querySelector('article.turn .summary p').firstChild;
      const range = document.createRange();
      range.selectNodeContents(text);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    })()`);
    const switched = renderPayload() as any;
    switched.cards = [];
    switched.sessions = [];
    switched.showing = 's2';
    switched.usage.composer.sessionId = 's2';
    switched.usage.composer.targetName = 'Second session';
    switched.usage.composer.queue = [queued('deferred', 'Queued after recorded selection')];
    switched.usage.composer.live = [];
    await post(page, switched);
    await page.evaluate(
      `(() => { getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); })()`,
    );
    await page.evaluate(SETTLED);
    assert.equal(
      await page
        .locator('section.sessionsection[data-session="s2"] .transientcards > .cwaiting[data-queued="deferred"]')
        .count(),
      1,
      'the switched session lost queued work after recorded text selection released',
    );
  } finally {
    await browser.close();
  }
});

test('an unrelated live update preserves a selected attachment subtree', async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(themed(pageHtml()));
    const payload = renderPayload(
      [],
      [
        livePress('s1', 'compact', '', 'Compaction reply.'),
        livePress('s1', 'prompt', 'Prompt with attachment.', 'Prompt reply.'),
      ],
    ) as any;
    const prompt = payload.usage.composer.live.find((live: { kind: string }) => live.kind === 'prompt');
    const compact = payload.usage.composer.live.find((live: { kind: string }) => live.kind === 'compact');
    prompt.files = [
      {
        id: 'selected-file',
        name: 'selected.txt',
        label: 'selected.txt, 1 B',
        size: 1,
        preview: '',
        kind: 'TXT',
        stem: 'selected',
        ext: '.txt',
        sizeLabel: '1 B',
      },
    ];
    compact.files = [
      {
        id: 'other-file',
        name: 'other.txt',
        label: 'other.txt, 1 B',
        size: 1,
        preview: '',
        kind: 'TXT',
        stem: 'other',
        ext: '.txt',
        sizeLabel: '1 B',
      },
    ];
    await post(page, payload);
    const selected = await page.evaluate(`(() => {
      const text = document.querySelector('.clive[data-live="prompt"] .cstem').firstChild;
      window.__selectedFileName = text;
      const range = document.createRange();
      range.selectNodeContents(text);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return selection.toString();
    })()`);
    const updated = structuredClone(payload.usage.composer.live);
    updated.find((live: { kind: string }) => live.kind === 'compact').reply = 'Compaction reply grew.';
    await post(page, { type: 'live', session: 's1', live: updated });
    assert.ok(
      (await page.locator('.clive[data-live="compact"]').textContent())?.includes('Compaction reply grew.'),
      'the unrelated live card did not update while attachment text was selected',
    );
    assert.equal(
      await page.evaluate(
        `window.__selectedFileName === document.querySelector('.clive[data-live="prompt"] .cstem').firstChild`,
      ),
      true,
      'an unrelated live update replaced the selected attachment node',
    );
    assert.equal(
      await page.evaluate(`getSelection().toString()`),
      selected,
      'an unrelated live update cleared the selected attachment text',
    );
    assert.equal(
      await page.locator('.clive .cfileremove').count(),
      0,
      'a live attachment chip exposes a Remove control',
    );
  } finally {
    await browser.close();
  }
});
