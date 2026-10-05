import { test } from 'vitest';
import assert from 'node:assert';
import { browserOrNone, SETTLED, type TestBrowser } from '../test/browser.ts';
import type { Page } from 'playwright-core';
import {
  launcherPinSetups,
  launcherPinsPayload,
  launcherPinsUsage,
  pageHtml,
  renderPayload,
  themed,
} from './panelfixture.ts';

test(
  'project changes clear retained custom fields and setup messages retain displayed ownership',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine');
      return;
    }
    try {
      const setups = launcherPinSetups();
      const heldPin = { ...setups[2], id: 'kept' };
      const a = launcherPinsUsage(setups.slice(0, 2), [heldPin]);
      (a.launcher as any).owner = 'A';
      const page = await openPins(browser, a);
      await page.locator('#launcher [data-control="launchpin:pin:kept"]').click();
      assert.equal((await posted(page)).at(-1)?.owner, 'A');
      await page.locator('#launcher [data-control="launchedit:pin:kept"]').click();
      const b = launcherPinsUsage(setups.slice(1, 2), [heldPin]);
      (b.launcher as any).owner = 'B';
      await postUsage(page, b);
      assert.equal(await page.locator('#launcher').isVisible(), false);
      await page.click('.controls .compactnewmenu');
      await page.locator('#launcher [data-control="launch-fieldpin"]').click();
      assert.equal((await posted(page)).at(-1)?.owner, 'B');
      await page.locator('#launcher [data-control="launch-create"]').click();
      assert.equal((await posted(page)).at(-1)?.owner, 'B');
      assert.equal((await posted(page)).at(-1)?.type, 'newSession');
    } finally {
      await browser.close();
    }
  },
);

test('changed launcher data keeps the active setting field', { timeout: 60_000 }, async (t) => {
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
    await page.setViewportSize({ width: 340, height: 900 });
    await page.evaluate(`window.postMessage(${JSON.stringify(renderPayload())}, '*')`);
    await page.evaluate(SETTLED);
    const payload = renderPayload();
    const usage = JSON.parse(JSON.stringify(payload.usage)) as {
      launcher: { recent: { key: string }[] };
    };

    await page.click('.controls .compactnewmenu');
    await page.evaluate(`(() => {
      const field = document.querySelector('#launcher [data-control="launch-model"]');
      field.focus();
      window.__launcherField = field;
    })()`);

    usage.launcher.recent = [
      ...usage.launcher.recent,
      ...usage.launcher.recent.map((row) => ({ ...row, key: `${row.key}:new` })),
    ];
    await page.evaluate(`window.postMessage({ type: 'usage', usage: ${JSON.stringify(usage)} }, '*')`);
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await page.evaluate(`({
      kept: window.__launcherField.isConnected,
      focused: document.activeElement === window.__launcherField,
      same: document.querySelector('#launcher [data-control="launch-model"]') === window.__launcherField,
    })`),
      { kept: true, focused: true, same: true },
      'launcher catalog data remounts the active setting field',
    );
    await page.locator('#prompt').focus();
    usage.launcher.recent = usage.launcher.recent.slice(0, 1);
    await page.evaluate(`window.postMessage({ type: 'usage', usage: ${JSON.stringify(usage)} }, '*')`);
    await page.evaluate(SETTLED);
    assert.equal(
      await page.evaluate("document.activeElement === document.getElementById('prompt')"),
      true,
      'a launcher repaint takes focus from a control outside the open launcher',
    );
    assert.deepEqual(failures, [], 'the panel threw while reconciling changed launcher data');
  } finally {
    await browser.close();
  }
});

// A fresh narrow page whose New session menu draws these setups, opened from the panel bar.
async function openPins(browser: TestBrowser, usage: Record<string, unknown>): Promise<Page> {
  const page = await browser.newPage();
  const failures: string[] = [];
  page.on('pageerror', (e) => failures.push(String(e)));
  await page.setContent(themed(pageHtml()));
  await page.setViewportSize({ width: 340, height: 900 });
  await page.evaluate(`window.postMessage(${JSON.stringify(renderPayload())}, '*')`);
  await page.evaluate(SETTLED);
  await postUsage(page, usage);
  await page.click('.controls .compactnewmenu');
  await page.evaluate(SETTLED);
  assert.deepEqual(failures, [], 'the panel threw while drawing the setup list');
  return page;
}

async function postUsage(page: Page, usage: Record<string, unknown>): Promise<void> {
  await page.evaluate(`window.postMessage({ type: 'usage', usage: ${JSON.stringify(usage)} }, '*')`);
  await page.evaluate(SETTLED);
}

const focused = (page: Page) => page.evaluate(`document.activeElement?.dataset?.control ?? null`) as Promise<string>;
const groupTarget = (_page: Page, field: string) => Promise.resolve(`launch-${field}`);
async function pickField(page: Page, field: string, value: string): Promise<void> {
  await page.locator(`#launcher [data-control="launch-${field}"]`).click();
  await page.locator(`[data-control="launch-${field}:${value}"]`).click();
}
const posted = (page: Page) =>
  page.evaluate<Record<string, unknown>[]>(
    `window.__posted.filter((m) => ['newSession', 'pinSetup', 'unpinSetup'].includes(m.type))`,
  );

test('a setup pin posts only its pin request, and focus follows the result', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const setups = launcherPinSetups();
    const recents = setups.slice(0, 4);
    const first = { id: 'a', ...setups[20] };
    const page = await openPins(browser, launcherPinsUsage(recents, [first]));
    await page.keyboard.press('Escape');
    await page.evaluate(SETTLED);
    await page.click('.controls .compactnewmenu');
    await page.evaluate(
      `document.getElementById('list').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`,
    );
    await page.evaluate(SETTLED);
    assert.deepEqual(await posted(page), [], 'opening, Escape or an outside press posted a request');

    await page.click('.controls .compactnewmenu');
    await page.evaluate(SETTLED);
    await page.focus('#launcher [data-control="launchpin:recent:1"]');
    await page.keyboard.press('Enter');
    await page.evaluate(SETTLED);
    assert.deepEqual(await posted(page), [
      { type: 'pinSetup', request: { kind: 'row', key: 'recent:1', values: recents[1] } },
    ]);
    assert.equal(
      await page.evaluate(`document.getElementById('launcher').hidden`),
      false,
      'a pin press closed the menu',
    );

    // A refresh that says nothing about the pin, and a refusal or failed write, which posts
    // the stored list back unchanged, both leave the reader on the pin they pressed.
    await postUsage(page, launcherPinsUsage(recents, [first]));
    assert.equal(await focused(page), 'launchpin:recent:1', 'an unrelated refresh moved focus off the pressed pin');
    await postUsage(page, launcherPinsUsage(recents, [first]));
    assert.equal(await focused(page), 'launchpin:recent:1', 'a refusal moved focus off the pressed pin');
    const second = { id: 'b', ...recents[1] };
    await postUsage(page, launcherPinsUsage(recents, [first, second]));
    assert.equal(await focused(page), 'launchpin:pin:b', 'a pin did not move focus to the new pinned row');

    // Focus that leaves the pressed pin and comes back ends the move. The pinned row then
    // hides its recent row, and focus takes the next row's pin as any refresh would.
    await page.focus('#launcher [data-control="launchpin:recent:2"]');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    assert.equal(await focused(page), await groupTarget(page, 'agent'));
    await page.keyboard.press('Shift+Tab');
    assert.equal(await focused(page), 'launchpin:recent:2');
    await postUsage(page, launcherPinsUsage(recents, [first, second, { id: 'c', ...recents[2] }]));
    assert.equal(await focused(page), 'launchpin:recent:3', 'a pin move survived focus leaving the pressed pin');

    // A refusal whose list holds the same values, pinned from another window, proves the pin.
    await page.focus('#launcher [data-control="launchpin:recent:0"]');
    await page.keyboard.press('Enter');
    await postUsage(
      page,
      launcherPinsUsage(recents, [first, second, { id: 'x', ...setups[21] }, { id: 'y', ...recents[0] }]),
    );
    assert.equal(await focused(page), 'launchpin:pin:y', 'a pin made in another window did not take focus');

    await page.focus('#launcher [data-control="launchpin:pin:x"]');
    await page.keyboard.press('Enter');
    assert.deepEqual((await posted(page)).at(-1), { type: 'unpinSetup', id: 'x' });
    await postUsage(page, launcherPinsUsage(recents, [first, second, { id: 'y', ...recents[0] }]));
    assert.equal(await focused(page), 'launchpin:pin:y', 'an unpin did not move focus to the next pin');

    assert.equal((await posted(page)).filter((m) => m.type === 'newSession').length, 0, 'a pin press created a draft');
    await page.click('#launcher [data-control="launch:recent:2"]');
    assert.equal((await posted(page)).filter((m) => m.type === 'newSession').length, 1, 'a row press created no draft');
  } finally {
    await browser.close();
  }
});

test('the setup list is one Tab stop that reaches every pin', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    let page = await openPins(
      browser,
      launcherPinsPayload(2, { recents: 2, unavailable: true }).usage as Record<string, unknown>,
    );
    assert.equal(await focused(page), 'launch:current');
    await page.keyboard.press('Tab');
    assert.equal(await focused(page), 'launchedit:pin:pin-retired', 'the list stop is not the first row it can focus');
    const rows = ['pin:pin-retired', 'pin:pin-0', 'pin:pin-1', 'recent:0', 'recent:1'];
    for (const kind of ['launchedit', 'launchpin']) {
      const walked: string[] = [];
      for (let step = 0; step < 5; step++) {
        walked.push(await focused(page));
        await page.keyboard.press('ArrowDown');
      }
      assert.deepEqual(
        walked,
        rows.map((row) => `${kind}:${row}`),
        `Down does not keep the ${kind} kind`,
      );
      assert.equal(await focused(page), `${kind}:pin:pin-retired`, 'Down does not wrap to the first row');
      if (kind === 'launchedit') {
        await page.keyboard.press('ArrowRight');
      }
    }
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await focused(page), 'launchedit:recent:1');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await focused(page), 'launch:recent:1', 'Left does not walk from Edit to the apply button');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await focused(page), 'launch:recent:1', 'Left does not stop at the row start');
    await page.keyboard.press('Home');
    assert.equal(await focused(page), 'launchpin:pin:pin-retired', 'Home landed on an apply button that cannot apply');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await focused(page), 'launchedit:pin:pin-retired', 'Left from Unpin does not reach Edit');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await focused(page), 'launchedit:pin:pin-retired', 'Left left a row with no apply button');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowUp');
    assert.equal(await focused(page), 'launchpin:pin:pin-retired', 'Up landed on an apply button that cannot apply');
    await page.keyboard.press('Tab');
    assert.equal(await focused(page), await groupTarget(page, 'agent'), 'Tab did not leave the list');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await focused(page), 'launchpin:pin:pin-retired', 'Shift+Tab did not return to the list stop');

    await page.evaluate(`document.querySelector('#launcher [data-control="launch:pin:pin-retired"]').click()`);
    await page.click('#launcher [data-control="launchpin:pin:pin-retired"]');
    assert.deepEqual(await posted(page), [{ type: 'unpinSetup', id: 'pin-retired' }]);

    page = await openPins(browser, launcherPinsPayload(0, { recents: 0 }).usage as Record<string, unknown>);
    await page.keyboard.press('Tab');
    assert.equal(await focused(page), await groupTarget(page, 'agent'), 'an empty list holds a Tab stop');

    page = await openPins(browser, launcherPinsPayload(3, { recents: 0 }).usage as Record<string, unknown>);
    await page.keyboard.press('Tab');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    const pins: string[] = [];
    for (let step = 0; step < 3; step++) {
      pins.push(await focused(page));
      await page.keyboard.press('ArrowDown');
    }
    assert.deepEqual(pins, ['launchpin:pin:pin-0', 'launchpin:pin:pin-1', 'launchpin:pin:pin-2']);

    // A refresh that retires the focused setup disables its apply button, so focus moves to
    // that row's pin.
    const stored = launcherPinSetups()
      .slice(20, 23)
      .map((values, index) => ({ id: `pin-${index}`, ...values }));
    await page.focus('#launcher [data-control="launch:pin:pin-1"]');
    await postUsage(
      page,
      launcherPinsUsage(
        [],
        stored.map((one) => (one.id === 'pin-1' ? { ...one, model: 'retired' } : one)),
      ),
    );
    assert.equal(await focused(page), 'launchpin:pin:pin-1', 'a refresh left focus on an apply button it disabled');
  } finally {
    await browser.close();
  }
});

const fields = (page: Page) =>
  page.evaluate(() => {
    const value = (field: string) =>
      document.querySelector<HTMLElement>(`#launcher [data-control="launch-${field}"]`)?.dataset.value ?? null;
    return {
      agent: value('agent') || null,
      model: value('model'),
      effort: value('effort'),
      permissionMode: value('permissions'),
      caution: document.querySelector('#launcher .launchcaution')?.textContent ?? '',
      pinned: document.querySelector('#launcher [data-control="launch-fieldpin"]')!.getAttribute('aria-pressed'),
    };
  });

test(
  'Edit loads a pinned setup into the fields, and the field pin follows each reply',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
      return;
    }
    try {
      const recents = launcherPinSetups().slice(0, 2);
      const retired = {
        id: 'pin-retired',
        agent: 'claude' as const,
        model: 'opus-4-retired',
        effort: 'high',
        permissionMode: 'retired-permission',
      };
      const page = await openPins(browser, launcherPinsUsage(recents, [retired]));
      await page.keyboard.press('Tab');
      assert.equal(await focused(page), 'launchedit:pin:pin-retired');
      await page.keyboard.press('Enter');
      await page.evaluate(SETTLED);
      const shown = await fields(page);
      assert.equal(shown.agent, 'claude', 'Edit did not load the row agent');
      assert.equal(shown.model, 'opus-4-retired', 'Edit discarded the stored unavailable model');
      assert.equal(shown.effort, 'high', 'Edit discarded the stored effort');
      assert.equal(shown.permissionMode, 'retired-permission', 'Edit discarded the stored unavailable permissions');
      assert.ok(shown.caution.includes('Model not available: opus-4-retired'), `the caution is ${shown.caution}`);
      assert.ok(shown.caution.includes('Effort not available: high'), `the caution is ${shown.caution}`);
      assert.ok(
        shown.caution.includes('Permissions not available: retired-permission'),
        `the caution is ${shown.caution}`,
      );
      assert.equal(await focused(page), 'launch-agent', 'Edit did not move focus to the Agent field');
      assert.deepEqual(await posted(page), [], 'Edit posted a request');

      const permissions = page.locator('#launcher [data-control="launch-permissions"]');
      const active = (field: string) =>
        page.evaluate(`(() => {
          const trigger = document.querySelector('#launcher [data-control="launch-${field}"]');
          const option = document.getElementById(trigger.getAttribute('aria-activedescendant'));
          return option?.getAttribute('data-control') ?? null;
        })()`);
      const usage = launcherPinsUsage(recents, [retired]) as any;
      const agent = usage.launcher.agents.find((item: any) => item.value === 'claude');
      const [firstPermission, secondPermission] = agent.permissions;
      await permissions.focus();
      await permissions.press('Space');
      assert.equal(await active('permissions'), `launch-permissions:${firstPermission.value}`);
      assert.deepEqual(await fields(page), shown, 'opening permissions changed the loaded setup');
      await permissions.press('ArrowDown');
      assert.equal(await active('permissions'), `launch-permissions:${secondPermission.value}`);
      await postUsage(page, usage);
      assert.equal(
        await active('permissions'),
        `launch-permissions:${secondPermission.value}`,
        'redraw lost the tentative choice',
      );
      await permissions.press('Escape');
      assert.deepEqual(await fields(page), shown, 'Escape changed the loaded setup');
      await permissions.press('Space');
      await permissions.press('ArrowDown');
      await permissions.press('Enter');
      assert.deepEqual(await fields(page), {
        ...shown,
        permissionMode: secondPermission.value,
        caution: (await fields(page)).caution,
      });
      await permissions.press('Space');
      const droppedPermission = structuredClone(usage);
      droppedPermission.launcher.agents.find((item: any) => item.value === 'claude').permissions = [firstPermission];
      await postUsage(page, droppedPermission);
      assert.equal(
        await active('permissions'),
        `launch-permissions:${firstPermission.value}`,
        'removed permission stayed active',
      );
      assert.equal(
        (await fields(page)).permissionMode,
        secondPermission.value,
        'catalog removal rewrote the stored permission',
      );
      await permissions.press('Escape');

      const unavailableEffort = { ...retired, model: 'sonnet', effort: 'retired-effort' };
      const effortUsage = launcherPinsUsage(recents, [unavailableEffort]) as any;
      await postUsage(page, effortUsage);
      await page.locator('#launcher [data-control="launchedit:pin:pin-retired"]').click();
      const effortShown = await fields(page);
      const effort = page.locator('#launcher [data-control="launch-effort"]');
      const efforts = effortUsage.launcher.agents
        .find((item: any) => item.value === 'claude')
        .catalog.find((item: any) => item.value === 'sonnet').efforts;
      await effort.focus();
      await effort.press('Space');
      assert.equal(await active('effort'), `launch-effort:${efforts[0].value}`);
      await effort.press('ArrowDown');
      assert.equal(await active('effort'), `launch-effort:${efforts[1].value}`);
      await postUsage(page, effortUsage);
      assert.equal(await active('effort'), `launch-effort:${efforts[1].value}`, 'redraw lost the tentative effort');
      await effort.press('Escape');
      assert.deepEqual(await fields(page), effortShown, 'Escape changed the unavailable effort or permissions');
      await effort.press('Space');
      await effort.press('ArrowDown');
      await effort.press('Enter');
      assert.equal((await fields(page)).effort, efforts[1].value);
      assert.equal(
        (await fields(page)).permissionMode,
        retired.permissionMode,
        'accepting effort rewrote the unavailable permission',
      );
      await effort.press('Space');
      const droppedEffort = structuredClone(effortUsage);
      const droppedAgent = droppedEffort.launcher.agents.find((item: any) => item.value === 'claude');
      droppedAgent.catalog.find((item: any) => item.value === 'sonnet').efforts = [efforts[0]];
      droppedAgent.supportedModels.find((item: any) => item.value === 'sonnet').efforts = [{ value: '' }, efforts[0]];
      await postUsage(page, droppedEffort);
      assert.equal(await active('effort'), `launch-effort:${efforts[0].value}`, 'removed effort stayed active');
      assert.equal((await fields(page)).effort, efforts[1].value, 'catalog removal rewrote the stored effort');
      await effort.press('Escape');
      await postUsage(page, usage);
      await page.locator('#launcher [data-control="launchedit:pin:pin-retired"]').click();

      await pickField(page, 'model', 'sonnet');
      await pickField(page, 'effort', 'high');
      await pickField(page, 'permissions', '');
      const chosen = await fields(page);
      const values = {
        agent: 'claude' as const,
        model: chosen.model ?? '',
        effort: chosen.effort ?? '',
        permissionMode: chosen.permissionMode ?? '',
      };
      await page.focus('#launcher [data-control="launch-fieldpin"]');
      await page.keyboard.press('Enter');
      assert.deepEqual(await posted(page), [{ type: 'pinSetup', request: { kind: 'custom', ...values } }]);
      const made = launcherPinsUsage(recents, [retired, { id: 'made', ...values }]);
      await postUsage(page, made);
      assert.equal(await focused(page), 'launch-fieldpin', 'a pin reply moved focus off the field pin');
      assert.equal((await fields(page)).pinned, 'true', 'the field pin does not read pressed after its pin');
      assert.equal(
        await page.evaluate(
          `document.querySelector('#launcher [data-control="launchpin:pin:pin-retired"]')?.getAttribute('aria-pressed')`,
        ),
        'true',
        'pinning the edited values removed the unavailable pin',
      );

      // A failed unpin answers with the record still stored, so the pin stays pressed.
      await page.keyboard.press('Enter');
      assert.deepEqual((await posted(page)).at(-1), { type: 'unpinSetup', id: 'made' });
      await postUsage(page, made);
      assert.equal(await focused(page), 'launch-fieldpin');
      assert.equal((await fields(page)).pinned, 'true', 'a failed unpin shows the field pin unpressed');
      // A refused pin answers with no matching record, so the pin stays unpressed.
      await postUsage(page, launcherPinsUsage(recents, [retired]));
      assert.equal((await fields(page)).pinned, 'false');
      await page.keyboard.press('Enter');
      const count = (await posted(page)).length;
      await postUsage(page, launcherPinsUsage(recents, [retired]));
      assert.equal(await focused(page), 'launch-fieldpin', 'a refusal moved focus off the field pin');
      assert.deepEqual(await fields(page), { ...chosen, pinned: 'false' }, 'a refusal changed the fields');
      assert.equal((await posted(page)).length, count, 'a reply made the launcher post again');
      assert.equal(
        (await posted(page)).filter((m) => m.type === 'newSession').length,
        0,
        'a pin press created a draft',
      );
    } finally {
      await browser.close();
    }
  },
);

test('launcher choices keep focus while navigation remains tentative', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no browser');
    return;
  }
  try {
    const usage = launcherPinsUsage(launcherPinSetups().slice(0, 2), []);
    const page = await openPins(browser, usage);
    await pickField(page, 'agent', 'claude');
    await pickField(page, 'model', 'sonnet');
    await pickField(page, 'effort', 'high');
    await pickField(page, 'model', 'opus');
    assert.equal((await fields(page)).effort, 'high');
    await pickField(page, 'model', 'sonnet');
    const effort = page.locator('#launcher [data-control="launch-effort"]');
    await effort.focus();
    const requestsBefore = await page.evaluate(
      'window.__posted.filter((message) => message.type === "requestDefaults").length',
    );
    await effort.press('ArrowDown');
    await effort.press('Home');
    assert.equal(
      await page.evaluate('window.__posted.filter((message) => message.type === "requestDefaults").length'),
      requestsBefore,
    );
    assert.equal(await focused(page), 'launch-effort');
    assert.equal((await fields(page)).effort, 'high');
    await effort.press('Escape');
    assert.equal((await fields(page)).effort, 'high');
    assert.equal(await page.locator('#launcher').isVisible(), true);
    await effort.press('ArrowDown');
    await effort.press('Home');
    await effort.press('Tab');
    assert.equal(await focused(page), 'launch-permissions');
    assert.equal((await fields(page)).effort, 'low');
    await pickField(page, 'effort', 'medium');
    const dropped = structuredClone(usage) as any;
    const agent = dropped.launcher.agents.find((item: any) => item.value === 'claude');
    const sonnet = agent.catalog.find((item: any) => item.value === 'sonnet');
    sonnet.efforts = sonnet.efforts.filter((item: any) => item.value !== 'medium');
    agent.supportedModels.find((item: any) => item.value === 'sonnet').efforts = [{ value: '' }, ...sonnet.efforts];
    await effort.focus();
    await postUsage(page, dropped);
    assert.equal(await focused(page), 'launch-effort');
    assert.ok((await fields(page)).caution.includes('Effort not available: medium'));
    await postUsage(page, usage);
    assert.equal((await fields(page)).caution, '');
    assert.equal((await fields(page)).effort, 'medium');
    const revised = structuredClone(usage) as any;
    const revisedAgent = revised.launcher.agents.find((item: any) => item.value === 'claude');
    revisedAgent.defaults = { ...revisedAgent.defaults, revision: (revisedAgent.defaults?.revision ?? 0) + 1 };
    await page.evaluate('window.__posted = []');
    await postUsage(page, revised);
    assert.deepEqual(await page.evaluate('window.__posted.filter((message) => message.type === "requestDefaults")'), [
      { type: 'requestDefaults', agent: 'claude', model: 'sonnet' },
    ]);
  } finally {
    await browser.close();
  }
});

test('accepting the selected option keeps the values Edit loaded', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    type Agent = {
      value: string;
      defaultPermission: string;
      models: { value: string; efforts: { value: string }[] }[];
    };
    const catalog = (launcherPinsUsage([], []).launcher as { agents: Agent[] }).agents;
    const claude = catalog.find((one) => one.value === 'claude') as Agent;
    // A setup whose every field differs from the defaults an Agent change applies.
    const setup = launcherPinSetups().find(
      (one) =>
        one.agent === 'claude' &&
        one.model !== claude.models[0].value &&
        one.effort !== claude.models[0].efforts[0]?.value &&
        one.permissionMode !== claude.defaultPermission,
    );
    assert.ok(setup, 'the catalog has no setup away from the Claude defaults');
    const page = await openPins(browser, launcherPinsUsage([], [{ id: 'pin-edit', ...setup }]));
    await page.focus('#launcher [data-control="launchedit:pin:pin-edit"]');
    await page.keyboard.press('Enter');
    await page.evaluate(SETTLED);
    assert.equal(await focused(page), 'launch-agent', 'Edit did not move focus to the Agent field');
    const loaded = await fields(page);
    const { agent, model, effort, permissionMode } = loaded;
    assert.deepEqual({ agent, model, effort, permissionMode }, setup, 'Edit did not load the row values');

    for (const field of ['agent', 'model', 'effort', 'permissions']) {
      const trigger = page.locator(`#launcher [data-control="launch-${field}"]`);
      await trigger.focus();
      await trigger.press('Space');
      await trigger.press('Enter');
      await trigger.click();
      await trigger.click();
      assert.deepEqual(await fields(page), loaded, `accepting the selected ${field} changed the setup`);
    }
    await page.click('#launcher [data-control="launch-create"]');
    assert.deepEqual(await posted(page), [{ type: 'newSession', request: { kind: 'custom', ...setup } }]);
    for (const omitted of [false, true]) {
      const kept = { agent: 'claude' as const, model: omitted ? '' : 'sonnet-alias', effort: '', permissionMode: '' };
      const usage = launcherPinsUsage([], [{ id: 'pin-alias', ...kept }]) as any;
      const agent = usage.launcher.agents.find((item: any) => item.value === 'claude');
      const sonnet = agent.catalog.find((item: any) => item.value === 'sonnet');
      agent.catalog.push({ ...sonnet, value: 'sonnet-alias', resolvedModel: 'sonnet' });
      agent.supportedModels.push({ ...sonnet, value: 'sonnet-alias', efforts: [{ value: '' }, ...sonnet.efforts] });
      agent.supportedModels.find((item: any) => item.value === '').efforts = [{ value: '' }, ...sonnet.efforts];
      const defaults = { status: 'ready', model: 'sonnet', effort: 'medium', reason: '' };
      agent.defaults = { revision: 1, base: defaults, models: { sonnet: defaults } };
      const aliasPage = await openPins(browser, usage);
      await aliasPage.locator('#launcher [data-control="launchedit:pin:pin-alias"]').click();
      const loadedAlias = await fields(aliasPage);
      assert.deepEqual(
        {
          agent: loadedAlias.agent,
          model: loadedAlias.model,
          effort: loadedAlias.effort,
          permissionMode: loadedAlias.permissionMode,
        },
        kept,
      );
      for (const field of ['agent', 'model', 'effort', 'permissions']) {
        const trigger = aliasPage.locator(`#launcher [data-control="launch-${field}"]`);
        await trigger.focus();
        await trigger.press('Space');
        assert.ok(await trigger.getAttribute('aria-activedescendant'), `the selected ${field} has no active option`);
        await trigger.press('Enter');
        assert.deepEqual(await fields(aliasPage), loadedAlias, `accepting ${field} rewrote alias or omitted values`);
      }
      await aliasPage.locator('#launcher [data-control="launch-create"]').click();
      assert.deepEqual(await posted(aliasPage), [{ type: 'newSession', request: { kind: 'custom', ...kept } }]);
      await aliasPage.close();
    }
  } finally {
    await browser.close();
  }
});

test('a custom opening starts on an unselected Agent combobox', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no browser');
    return;
  }
  try {
    const page = await openPins(browser, launcherPinsUsage([], [], false));
    await page.keyboard.press('Escape');
    for (const key of ['Space', 'ArrowDown']) {
      await page.evaluate("window.postMessage({ type: 'openLauncher', custom: true }, '*')");
      await page.evaluate(SETTLED);
      assert.equal(await focused(page), 'launch-agent');
      assert.equal((await fields(page)).agent, null);
      assert.equal(await page.locator('[data-control="launch-create"]').isDisabled(), true);
      assert.equal(await page.locator('[data-control="launch-fieldpin"]').isDisabled(), true);
      await page.keyboard.press(key);
      await page.keyboard.press('End');
      assert.equal((await fields(page)).agent, null);
      await page.keyboard.press('Enter');
      assert.equal((await fields(page)).agent, 'codex');
      await page.keyboard.press('Escape');
    }
    assert.deepEqual(await posted(page), []);
  } finally {
    await browser.close();
  }
});

test(
  'a hint in the New session menu takes the first Escape and hides on a list scroll',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
      return;
    }
    try {
      const page = await openPins(browser, launcherPinsPayload(16).usage as Record<string, unknown>);
      const hintOpen = `!document.getElementById('hintpop').hidden`;
      await page.keyboard.press('Tab');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      assert.equal(await focused(page), 'launchpin:pin:pin-0');
      await page.waitForFunction(hintOpen);
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(hintOpen), false, 'the first Escape left the hint open');
      assert.equal(
        await page.evaluate(`document.getElementById('launcher').hidden`),
        false,
        'the first Escape closed the menu',
      );

      await page.keyboard.press('ArrowLeft');
      assert.equal(await focused(page), 'launchedit:pin:pin-0');
      await page.waitForFunction(hintOpen);
      assert.equal(
        await page.evaluate(
          `document.getElementById('hintpop').textContent.startsWith(document.activeElement.dataset.hint)`,
        ),
        true,
        'the hint did not switch to the focused control',
      );
      // A scroll does not bubble, so only a listener in the capture phase hears the list's own.
      assert.ok(
        await page.evaluate(`(() => {
      const list = document.querySelector('#launcher .launchlist');
      list.scrollTop = 40;
      return list.scrollTop > 0;
    })()`),
        'the list did not scroll',
      );
      await page.waitForFunction(`document.getElementById('hintpop').hidden`);

      await page.keyboard.press('Escape');
      assert.equal(
        await page.evaluate(`document.getElementById('launcher').hidden`),
        true,
        'Escape left the menu open',
      );
      assert.deepEqual(await posted(page), [], 'Escape posted a request');
    } finally {
      await browser.close();
    }
  },
);
