// Browser checks for turn-card figures, response disclosures, and activity.
// Shared measurement helpers live in `../test/layout.ts`.

import { test } from 'vitest';
import assert from 'node:assert';
import type { Page } from 'playwright-core';
import { browserOrNone, SETTLED } from '../test/browser.ts';
import { logOf, toCard } from './turncard.ts';
import { commitRecordCards, subagent, turn } from './turnfixtures.ts';
import { CARD_ACTIONS, RAIL_WIDTH_DEFAULT, RAIL_WIDTH_MIN } from './turnview.ts';
import { LABEL_NAME_LIMIT } from './turnlabels.ts';
import { CARD_GLYPHS, commitHeadFact, groupCommitRows } from './view/card-presentation.ts';
import type { CommitRowView } from './webview/card-rows.ts';
import { composerView, type LivePress } from './composerview.ts';
import { renderRichMarkdown } from './richtext.ts';
import {
  COMPOSER,
  FIXTURE_TURNS,
  LIVE_PRESS,
  LONG_PATH,
  LONG_TURN_INDEX,
  NOW,
  QUESTION_ASK,
  pageHtml,
  renderPayload,
  themed,
} from './panelfixture.ts';
import { STEP_DETAIL_LIMIT } from './transcript.ts';

test(
  'native response disclosures retain open state and focus while routing descendant actions',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no browser installed');
      return;
    }
    try {
      const page = await browser.newPage();
      await page.setContent(themed(pageHtml()));
      const payload = renderPayload() as { cards: Record<string, any>[]; timelineLayout: { promptPosition: string } };
      const card = payload.cards[LONG_TURN_INDEX];
      payload.cards = [card];
      payload.timelineLayout.promptPosition = 'below';
      card.activity = [];
      card.chips = card.chips.filter((chip: { metric: string }) => chip.metric === 'files');
      const source =
        '<details><summary>Agent **measurements**</summary>\n\n- [Read](src/store.ts)\n\n```text\nexact code\n```\n</details>';
      card.summaryHtml = renderRichMarkdown(source);
      await page.evaluate((value) => window.postMessage(value, '*'), payload);
      await page.locator('.turn .head').click();
      const summary = page.locator('.turn .summary details > summary').first();
      await page.locator('.turn .statchip[data-metric="files"]').click();
      const pop = page.locator('#chippop');
      await pop.locator('button').last().focus();
      await page.keyboard.press('Tab');
      assert.equal(await pop.isHidden(), true);
      assert.equal(
        await summary.evaluate((node) => node === document.activeElement),
        true,
        'leaving the figure skipped the following response disclosure',
      );
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => !!document.querySelector<HTMLDetailsElement>('.turn .summary details')?.open);
      await page.keyboard.press('Tab');
      assert.equal(
        await page.locator('.turn .summary a[data-link]').evaluate((node) => node === document.activeElement),
        true,
      );
      await page.keyboard.press('Shift+Tab');
      assert.equal(await summary.evaluate((node) => node === document.activeElement), true);
      card.summaryHtml = renderRichMarkdown(source.replace('exact code', 'updated code'));
      await page.evaluate((value) => window.postMessage(value, '*'), payload);
      await page.waitForFunction(() =>
        document.querySelector('.turn .summary pre')?.textContent?.includes('updated code'),
      );
      assert.equal(await summary.evaluate((node) => node === document.activeElement), true);
      assert.equal(
        await page.locator('.turn .summary details').evaluate((node: HTMLDetailsElement) => node.open),
        true,
      );
      await page.keyboard.press('Space');
      await page.waitForFunction(() => !document.querySelector<HTMLDetailsElement>('.turn .summary details')?.open);
      await page.keyboard.press('Enter');
      const copy = page.locator('.turn .summary button.copy');
      await copy.focus();
      assert.equal(await copy.evaluate((node) => node === document.activeElement), true);
      card.summaryHtml = renderRichMarkdown(source.replace('exact code', 'refreshed code'));
      await page.evaluate((value) => window.postMessage(value, '*'), payload);
      await page.waitForFunction(() =>
        document.querySelector('.turn .summary pre')?.textContent?.includes('refreshed code'),
      );
      assert.equal(await copy.evaluate((node) => node === document.activeElement), true);
      assert.equal(
        await page.locator('.turn .summary details').evaluate((node: HTMLDetailsElement) => node.open),
        true,
      );
      await page.locator('.turn .summary a[data-link]').click();
      await page.locator('.turn .summary button.copy').click();
      const messages = await page.evaluate(() => (window as any).__posted);
      assert.ok(messages.some((m: any) => m.type === 'openLink' && m.href === 'src/store.ts'));
      assert.ok(messages.some((m: any) => m.type === 'copy' && m.text === 'refreshed code\n'));
      card.summaryHtml = renderRichMarkdown(source.replace('Agent **measurements**', 'Changed heading'));
      await page.evaluate((value) => window.postMessage(value, '*'), payload);
      await page.waitForFunction(
        () => document.querySelector('.turn .summary summary')?.textContent === 'Changed heading',
      );
      assert.equal(
        await page.locator('.turn .summary details').evaluate((node: HTMLDetailsElement) => node.open),
        false,
      );
    } finally {
      await browser.close();
    }
  },
);

test(
  'expanded Activity disclosures take clipped summaries out of the tab order and restore them on Show more',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no browser installed');
      return;
    }
    try {
      const page = await browser.newPage();
      await page.setContent(themed(pageHtml()));
      const payload = renderPayload() as { cards: Record<string, any>[] };
      const card = payload.cards[0];
      payload.cards = [card];
      const text = `<details><summary>Long body</summary>\n\n${Array.from({ length: 30 }, (_, n) => `Paragraph ${n}.\n\n`).join('')}</details>\n\n<details><summary>Later detail</summary>\nBody\n</details>`;
      card.saidMessages = [
        {
          id: 'commentary:disclosures',
          kind: 'commentary',
          at: NOW,
          text,
          when: 'now',
          absolute: 'now',
          summaryHtml: renderRichMarkdown(text),
        },
      ];
      setLogMessages(card);
      await page.evaluate((value) => window.postMessage(value, '*'), payload);
      await page.locator('.turn .head').click();
      const toggle = page.locator('.activitysec button.actword');
      if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
      const headings = page.locator('.saidtext summary');
      await headings.first().click();
      await page.waitForFunction(
        () => document.querySelectorAll('.saidtext summary')[1]?.getAttribute('tabindex') === '-1',
      );
      await page.locator('.said button.more').click();
      await page.waitForFunction(
        () => document.querySelectorAll('.saidtext summary')[1]?.getAttribute('tabindex') !== '-1',
      );
      assert.equal(await headings.nth(1).getAttribute('tabindex'), null);
      await headings.nth(1).focus();
      await page.keyboard.press('Space');
      await page.waitForFunction(() => document.querySelectorAll<HTMLDetailsElement>('.saidtext details')[1]?.open);
    } finally {
      await browser.close();
    }
  },
);
import {
  Laid,
  MEASURE,
  layoutAt,
  RailLabelLine,
  LIVE_REPLY,
  setLogMessages,
  flatLog,
  RECORDED_SKILL_PATH,
  MOCKUP_SKILL_PATH,
  MOCKUP_SKILL_DESCRIPTION,
  MOCKUP_SKILL_FULL_DESCRIPTION,
  CARD_SKILLS,
  Placed,
  subagentRows,
} from '../test/layout.ts';

// Label fixtures cover folded labels, one label, the maximum label length, and sessions without labels.

// Page source computes text contrast after compositing translucent ancestor backgrounds.

const CONTRAST_SOURCE = String.raw`
  function parsed(color) {
    const rgb = color.match(/rgba?\(([^)]+)\)/);
    if (rgb) {
      const parts = rgb[1].split(',').map(Number);
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    }
    const fn = color.match(/color\(srgb ([^/)]+)(?:\/ ([^)]+))?\)/);
    const channels = fn[1].trim().split(/\s+/).map(Number);
    return { r: channels[0] * 255, g: channels[1] * 255, b: channels[2] * 255, a: fn[2] === undefined ? 1 : Number(fn[2]) };
  }
  function over(top, below) {
    return {
      r: top.a * top.r + (1 - top.a) * below.r,
      g: top.a * top.g + (1 - top.a) * below.g,
      b: top.a * top.b + (1 - top.a) * below.b,
      a: 1,
    };
  }
  function linear(channel) {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function luminance(color) {
    return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
  }
  function contrastOn(element) {
    const layers = [];
    for (let node = element; node; node = node.parentElement) {
      const bg = parsed(getComputedStyle(node).backgroundColor);
      if (bg.a > 0) { layers.push(bg); }
      if (bg.a >= 1) { break; }
    }
    let ground = { r: 255, g: 255, b: 255, a: 1 };
    for (const layer of layers.reverse()) { ground = over(layer, ground); }
    const fg = over(parsed(getComputedStyle(element).color), ground);
    const lo = Math.min(luminance(fg), luminance(ground));
    const hi = Math.max(luminance(fg), luminance(ground));
    return (hi + 0.05) / (lo + 0.05);
  }
`;

// Read the pinned popover's `aria-describedby` text in reference order.

async function popoverDescriptions(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const pop = document.getElementById('chippop');
    return (pop?.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? '');
  });
}

async function skillPathContrastRatio(target: Page): Promise<number> {
  return target.evaluate(`(() => {
    function parsed(color) {
      const rgb = color.match(/rgba?\\(([^)]+)\\)/);
      if (rgb) {
        const parts = rgb[1].split(',').map(Number);
        return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
      }
      // A resolved color-mix() reports through the color() function on some engines, its
      // channels 0-1 rather than 0-255 and its alpha after a slash instead of a fourth comma.
      const fn = color.match(/color\\(srgb ([^/)]+)(?:\\/ ([^)]+))?\\)/);
      const channels = fn[1].trim().split(/\\s+/).map(Number);
      return {
        r: channels[0] * 255, g: channels[1] * 255, b: channels[2] * 255,
        a: fn[2] === undefined ? 1 : Number(fn[2]),
      };
    }
    function linear(channel) {
      const c = channel / 255;
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }
    function luminance(color) {
      return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
    }
    const path = document.querySelectorAll('#chippop .chippopitem')[1].querySelectorAll('.chippopsubitem')[1];
    const bg = parsed(getComputedStyle(document.querySelector('#chippop')).backgroundColor);
    let fg = parsed(getComputedStyle(path).color);
    if (fg.a < 1) {
      fg = {
        r: fg.a * fg.r + (1 - fg.a) * bg.r,
        g: fg.a * fg.g + (1 - fg.a) * bg.g,
        b: fg.a * fg.b + (1 - fg.a) * bg.b,
        a: 1,
      };
    }
    const lo = Math.min(luminance(fg), luminance(bg));
    const hi = Math.max(luminance(fg), luminance(bg));
    return (hi + 0.05) / (lo + 0.05);
  })()`);
}

test(
  'a rail card draws its labels under its figures, inside the rail, at every width',
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
        const folded = document.querySelector('[data-control="rail:s1"]');
        const single = document.querySelector('[data-control="rail:s2"]');
        const bare = document.querySelector('[data-control="rail:s3"] .raillabels');
        const long = document.querySelector('[data-control="rail:s4"]');
        if (!rail || !folded || !single || !bare || !long) return null;
        const rect = (node) => node.getBoundingClientRect();
        // How many lines one chip's own words came out on. The chip's box cannot answer
        // that: a flex item is blockified whatever it was written as, so its rect is one
        // box around however many lines of text sit inside it.
        const textLines = (chip) => {
          const range = document.createRange();
          range.selectNodeContents(chip);
          return [...new Set([...range.getClientRects()].map((box) => Math.round(box.top)))].length;
        };
        const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        const read = (card) => {
          const labels = card.querySelector('.raillabels');
          const box = rect(labels);
          const chips = [...labels.children];
          const boxes = chips.map(rect);
          const actions = [...card.parentElement.querySelectorAll('.railact')].map(rect);
          return {
            chips: chips.map((chip) => [chip.className, chip.textContent]),
            chipLines: chips.map(textLines),
            chipTops: boxes.map((chip) => chip.top),
            titles: chips.map((chip) => chip.title),
            cutRule: chips.map((chip) => {
              const style = getComputedStyle(chip);
              return style.overflow + ' ' + style.textOverflow;
            }),
            cut: chips.map((chip) => chip.scrollWidth > chip.clientWidth + 1),
            height: box.height,
            chipHeight: Math.max(...boxes.map((chip) => chip.height)),
            outsideRow: Math.max(...boxes.map((chip) => Math.max(box.top - chip.top, chip.bottom - box.bottom))),
            underFigures: box.top - rect(card.querySelector('.railstats')).bottom,
            pastCard: box.right - (rect(card).right - parseFloat(getComputedStyle(card).paddingRight)),
            pastRail: box.right - rect(rail).right,
            coversActions: actions.some((action) => overlaps(action, box)),
          };
        };
        // The card drawn under the folded one, in the order the rail lays them out, so the
        // line is measured against what it would push into rather than against a figure.
        const cards = [...document.querySelectorAll('.railcard')];
        const under = cards[cards.indexOf(folded) + 1] || null;
        return {
          folded: read(folded),
          single: read(single),
          long: read(long),
          bare: { hidden: bare.hidden, height: rect(bare).height, display: getComputedStyle(bare).display },
          coversCardBelow: under ? overlaps(rect(folded.querySelector('.raillabels')), rect(under)) : null,
        };
      })()`)) as null | {
          folded: RailLabelLine;
          single: RailLabelLine;
          long: RailLabelLine;
          bare: { hidden: boolean; height: number; display: string };
          coversCardBelow: boolean | null;
        };
        assert.ok(measured, `the rail did not draw the label fixtures at ${width}px`);
        // The fixture must display the folded count before measuring the folded row.

        assert.deepEqual(
          measured.folded.chips,
          [
            ['raillabel', 'composer'],
            ['raillabel', 'release 0.4'],
            ['raillabel raillabelmore', '+1'],
          ],
          `the session the fixture filed past the fold drew something other than its chips and the count at ${width}px`,
        );
        assert.deepEqual(
          measured.single.chips,
          [['raillabel', 'release 0.4']],
          `the session carrying one label drew a fold beside it at ${width}px`,
        );
        // Label tooltips retain complete labels. The folded count's tooltip names hidden labels.

        assert.deepEqual(
          measured.folded.titles,
          ['composer', 'release 0.4', 'perf'],
          `a chip on the folded card hovers with something other than the label it draws at ${width}px`,
        );
        assert.deepEqual(
          measured.single.titles,
          ['release 0.4'],
          `the single card's chip lost its hover at ${width}px`,
        );
        assert.equal(
          measured.long.chips[0][1].length,
          LABEL_NAME_LIMIT,
          `the fixture's longest label is not as long as a label may be, at ${width}px`,
        );
        assert.deepEqual(
          measured.long.titles,
          [measured.long.chips[0][1]],
          `the longest label lost the hover that is the only way to read the part the row cut`,
        );
        for (const [which, line] of [
          ['folded', measured.folded],
          ['single', measured.single],
          ['long', measured.long],
        ] as const) {
          assert.deepEqual(
            line.chipLines,
            line.chips.map(() => 1),
            `the ${which} card broke a label across lines at ${width}px, so the card is taller than its neighbours`,
          );
          // Row height is compared with chip height to accommodate theme text sizing.

          assert.ok(line.chipHeight > 0, `the ${which} card's label chips have no height at ${width}px`);
          assert.ok(
            line.height < line.chipHeight * 2,
            `the ${which} card's labels take ${Math.round(line.height)}px, over two rows of ${Math.round(line.chipHeight)}px chips, at ${width}px`,
          );
          assert.ok(
            line.outsideRow <= 1,
            `a chip on the ${which} card hangs ${Math.round(line.outsideRow)}px outside its own line at ${width}px`,
          );
          // Chip tops detect vertical misalignment independently of the row's bounding box.

          const drop = Math.max(...line.chipTops) - Math.min(...line.chipTops);
          assert.ok(
            drop <= 1,
            `a chip on the ${which} card sits ${Math.round(drop)}px below the chips beside it at ${width}px`,
          );
          assert.ok(
            line.underFigures >= -1,
            `the ${which} card draws its labels ${Math.round(-line.underFigures)}px above its figures at ${width}px`,
          );
          assert.ok(
            line.pastCard <= 1,
            `the ${which} card's labels run ${Math.round(line.pastCard)}px past the card at ${width}px`,
          );
          assert.ok(
            line.pastRail <= 1,
            `the ${which} card's labels run ${Math.round(line.pastRail)}px past the rail column at ${width}px`,
          );
          assert.equal(
            line.coversActions,
            false,
            `the archive and pin controls cover the ${which} card's labels at ${width}px`,
          );
          // Computed overflow and ellipsis rules detect clipped-text behavior that bounding rectangles do not establish.

          assert.deepEqual(
            line.cutRule,
            line.chips.map(() => 'hidden ellipsis'),
            `a chip on the ${which} card lost the rule that cuts it, so a long label paints over its neighbour at ${width}px`,
          );
        }
        // Short labels fit at the default width and wider. The longest label clips at narrow widths.

        if (width > RAIL_WIDTH_MIN) {
          assert.deepEqual(
            measured.folded.cut,
            measured.folded.chips.map(() => false),
            `a card carrying short labels cut one of them at ${width}px, the width the rail opens at or wider`,
          );
          assert.deepEqual(measured.single.cut, [false], `a card carrying one short label cut it at ${width}px`);
        } else {
          // The minimum-width fixture includes a label that requires clipping.

          assert.deepEqual(
            measured.long.cut,
            [true],
            `the longest label a reader may type still fits the rail at its floor, so nothing here needs cutting`,
          );
          // The folded count retains its width while neighboring labels can clip.

          const chips = measured.folded.cut;
          assert.equal(
            chips[chips.length - 1],
            false,
            `the folded count gave way at ${width}px, so the one piece that says a label is missing is unreadable`,
          );
          assert.ok(
            chips.slice(0, -1).includes(true),
            `nothing on the folded card had to give way at ${width}px, so the count keeping its width proves nothing`,
          );
        }
        assert.notEqual(
          measured.coversCardBelow,
          null,
          `the rail drew no card under the labelled one at ${width}px, so nothing measured what the line pushes into`,
        );
        assert.equal(measured.coversCardBelow, false, `the label line covers the card drawn under it at ${width}px`);
        assert.deepEqual(
          measured.bare,
          { hidden: true, height: 0, display: 'none' },
          `a session with no label keeps an empty fourth-line gap at ${width}px`,
        );
      }
      assert.deepEqual(failures, [], 'the panel threw while drawing rail labels');
    } finally {
      await browser.close();
    }
  },
);

// The live-card fixture includes a prompt exceeding the headline clamp at both tested widths.

test('the card a press opens stands at the top of the column and widens nothing', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (e) => failures.push(String(e)));
    // Capture interval handles so the test can stop the panel ticker.

    await page.setContent(
      pageHtml().replace(
        '<script>',
        `<script>
      (() => {
        const real = window.setInterval;
        window.__intervals = [];
        window.setInterval = function (fn, ms) {
          const handle = real.apply(this, arguments);
          window.__intervals.push({ ms, handle });
          return handle;
        };
      })();
    </script><script>`,
      ),
    );

    // Cover wide and narrow panel widths.

    for (const width of [1350, 340]) {
      const quiet = await layoutAt(page, width);
      assert.equal(quiet.live, null, `a session with no press in flight drew a card at ${width}px`);
      const busy = await layoutAt(page, width, [], [LIVE_PRESS]);
      assert.deepEqual(failures, [], 'the panel threw while drawing the card');
      assert.ok(busy.live, `the press was recorded and no card was drawn at ${width}px`);

      // The live card appears in the timeline above the Prompt box.

      assert.ok(
        busy.live.top < busy.composer.top,
        `the card runs from ${Math.round(busy.live.top)} to ${Math.round(busy.live.bottom)} ` +
          `with the composer from ${Math.round(busy.composer.top)} to ${Math.round(busy.composer.bottom)}: ` +
          'the card is drawn at the foot rather than in the column',
      );
      assert.ok(
        busy.live.top >= busy.list.top - 1,
        `at ${width}px the card is drawn above the top of the list, so it is not in the column at all`,
      );
      // The live card belongs below its session heading.

      assert.ok(busy.liveInGroup, `at ${width}px the card is drawn outside every session in the list`);
      assert.ok(
        busy.sessionHead && busy.live.top >= busy.sessionHead.bottom - 1,
        `at ${width}px the card is drawn over the session heading rather than under it`,
      );
      assert.ok(
        busy.live.right <= busy.list.right + 1 && busy.live.left >= busy.list.left - 1,
        `at ${width}px the card runs wider than the column it stands in`,
      );
      // Live and recorded cards share the timeline's horizontal bounds.

      assert.ok(busy.card, 'the fixture drew no recorded turn, so there is nothing to hold the press card against');
      assert.equal(
        Math.round(busy.live.left),
        Math.round(busy.card.left),
        `at ${width}px the press card and the turn card start at different edges`,
      );
      assert.equal(
        Math.round(busy.live.right),
        Math.round(busy.card.right),
        `at ${width}px the press card and the turn card end at different edges`,
      );

      // Compare long and short prompts to bound live-card height growth.

      const brief = await layoutAt(page, width, [], [{ ...LIVE_PRESS, text: 'take the sandbox off' }]);
      assert.ok(brief.live, `the short press drew no card at ${width}px`);
      const grew = busy.live.bottom - busy.live.top - (brief.live.bottom - brief.live.top);
      assert.ok(
        grew < 60,
        `a long prompt drew a card ${Math.round(grew)}px taller than a one-line one at ${width}px, ` +
          'so the headline is unclamped',
      );
      // The long prompt leaves the panel without horizontal overflow.
      assert.ok(
        busy.documentWidth <= busy.viewportWidth + 1,
        `the card scrolls the panel sideways at ${width}px: ${busy.documentWidth} wide in ${busy.viewportWidth}`,
      );

      // Failed delivery retains its cause and both recovery actions within the card.

      const failed = await layoutAt(
        page,
        width,
        [],
        [
          {
            ...LIVE_PRESS,
            failed: true,
            reason:
              'Codex already has this session open in another client. Close it there, restore this prompt, and try again.',
          },
        ],
      );
      const recovery = (await page.evaluate(`(() => {
        const card = document.querySelector('.clive');
        const restore = card && card.querySelector('.cliverestore');
        const dismiss = card && card.querySelector('.cliveoff');
        const reason = card && card.querySelector('.clivereason');
        const box = (n) => {
          if (!n) return null;
          const r = n.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        };
        return { card: box(card), restore: box(restore), dismiss: box(dismiss), reason: reason && reason.textContent };
      })()`)) as {
        card: { left: number; right: number; top: number; bottom: number } | null;
        restore: { left: number; right: number; top: number; bottom: number } | null;
        dismiss: { left: number; right: number; top: number; bottom: number } | null;
        reason: string | null;
      };
      assert.deepEqual(failures, [], 'the panel threw while drawing failed-send recovery');
      assert.ok(
        recovery.card && recovery.restore && recovery.dismiss,
        `at ${width}px the failed card does not draw both recovery actions`,
      );
      assert.ok(
        recovery.restore.left >= recovery.card.left - 1 && recovery.restore.right <= recovery.card.right + 1,
        `at ${width}px Restore runs outside the failed card`,
      );
      assert.ok(
        recovery.dismiss.left >= recovery.card.left - 1 && recovery.dismiss.right <= recovery.card.right + 1,
        `at ${width}px Dismiss runs outside the failed card`,
      );
      assert.match(
        recovery.reason ?? '',
        /another client/,
        `at ${width}px the failed card drops the reason the reader needs before retrying`,
      );
      assert.ok(
        failed.documentWidth <= failed.viewportWidth + 1,
        `failed-send recovery scrolls the panel sideways at ${width}px`,
      );
      // The Prompt box remains above the status bar.

      assert.ok(
        busy.composer.bottom <= busy.statusbar.top + 1,
        'the composer runs into the status bar once a card is on screen',
      );

      // A prompt sent during compaction preserves both live cards.

      const both = await layoutAt(
        page,
        width,
        [],
        [
          { ...LIVE_PRESS, kind: 'compact', text: '' },
          { ...LIVE_PRESS, at: LIVE_PRESS.at + 12_000 },
        ],
      );
      assert.deepEqual(failures, [], 'the panel threw while drawing two cards at once');
      assert.equal(
        both.lives.length,
        2,
        `at ${width}px a prompt sent during a compaction took the compaction card off the screen`,
      );
      // The newer prompt appears above the compaction card.

      assert.deepEqual(
        both.lives.map((one) => one.kind),
        ['prompt', 'compact'],
        `at ${width}px the compaction card is drawn above the prompt sent after it`,
      );
      assert.ok(both.lives[0].top < both.lives[1].top, `at ${width}px the two cards are drawn on top of each other`);
      assert.equal(
        Math.round(busy.composer.top),
        Math.round(quiet.composer.top),
        'the card moved the box, so it is still being drawn inside the foot',
      );
      assert.ok(busy.list.top < 200, `at ${width}px the timeline starts ${Math.round(busy.list.top)}px down the page`);
    }

    // Stop the captured one-second interval so the test measures elapsed text supplied by the live-card draw.

    assert.ok(
      await page.evaluate('Array.isArray(window.__intervals) && window.__intervals.some((one) => one.ms === 1000)'),
      'the page never recorded a one-second interval, so this measures nothing',
    );
    await page.evaluate(`(() => {
      for (const one of window.__intervals) { if (one.ms === 1000) clearInterval(one.handle); }
    })()`);
    // Deliver the live card through a usage message, independently of the full-render path.

    await layoutAt(page, 340);
    const usage = (renderPayload([], [LIVE_PRESS]) as { usage: unknown }).usage;
    await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'usage', usage })}, '*')`);
    await page.evaluate(SETTLED);
    const counted = (await page.evaluate(`(() => {
      const row = document.querySelector('.clive .doing');
      const glyph = row && row.querySelector('.actglyph')?.textContent || '';
      const status = row && row.querySelector('.actverb')?.textContent || '';
      const figure = row && row.querySelector('.actfig')?.textContent || '';
      return { text: row ? row.textContent.replace(/\\s+/g, ' ').trim() : '', glyph, status, figure };
    })()`)) as { text: string; glyph: string; status: string; figure: string };
    assert.ok(
      /^\d/.test(counted.figure),
      `the card's elapsed figure reads ${JSON.stringify(counted.figure)}, so it is blank until the next tick`,
    );
    assert.equal(
      counted.text,
      counted.glyph + counted.status + ' ' + counted.figure,
      'the temporary live status and elapsed age have no readable separation',
    );
    assert.deepEqual(failures, [], 'the panel threw while drawing the card');
  } finally {
    await browser.close();
  }
});

test('a local attachment queue card stays in the timeline and inside the panel', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  const asset = {
    id: '12345678-1234-4123-8123-123456789abc',
    name: 'pasted-14-32-05.png',
    mime: 'image/png',
    size: 200_000,
    digest: '0'.repeat(64),
  };
  const compacting: LivePress = { ...LIVE_PRESS, agent: 'codex', kind: 'compact', text: '' };
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(String(error)));
    await page.setContent(pageHtml());
    for (const width of [1350, 340]) {
      await page.setViewportSize({ width, height: 900 });
      const payload = renderPayload() as { usage: { composer: unknown } };
      payload.usage.composer = composerView(
        {
          ...COMPOSER,
          agent: 'codex',
          live: [compacting],
          queued: [
            {
              id: 'queue-1',
              text: '',
              commentIds: [],
              assets: [asset],
              at: NOW + 1_000,
              delivery: { phase: 'queued', owner: 's1' },
            },
          ],
          assetPreviews: { [asset.id]: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E' },
        },
        NOW,
      );
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);
      const measured = (await page.evaluate(`(() => {
        const box = (node) => {
          if (!node) return null;
          const at = node.getBoundingClientRect();
          return { left: at.left, right: at.right, top: at.top, bottom: at.bottom, width: at.width };
        };
        const waiting = document.querySelector('.cwaiting');
        const compact = document.querySelector('.clive:not(.cwaiting)[data-live="compact"]');
        const file = waiting && waiting.querySelector('.cfile');
        const headline = waiting && waiting.querySelector('.headline');
        return {
          waiting: box(waiting), compact: box(compact), file: box(file), headline: box(headline),
          head: box(waiting && waiting.querySelector('.head')),
          when: box(waiting && waiting.querySelector('.head > .when')),
          agent: box(waiting && waiting.querySelector('.head > .agent')),
          status: box(waiting && waiting.querySelector('.doing')),
          statusText: waiting && waiting.querySelector('.doing .actverb')?.textContent,
          headActions: waiting ? waiting.querySelectorAll('.head .cwaitingact').length : -1,
          statusActions: waiting ? waiting.querySelectorAll('.doing .cwaitingact').length : -1,
          inGroup: !!(waiting && waiting.closest('.group')),
          inComposer: !!document.querySelector('#composer .cwaiting'),
          controls: waiting ? [...waiting.querySelectorAll('.cwaitingact')].map(box) : [],
          removes: waiting ? waiting.querySelectorAll('.cfileremove').length : -1,
          role: waiting && waiting.getAttribute('role'),
          documentWidth: document.documentElement.scrollWidth,
        };
      })()`)) as {
        waiting: Placed | null;
        compact: Placed | null;
        file: Placed | null;
        headline: Placed | null;
        head: Placed | null;
        when: Placed | null;
        agent: Placed | null;
        status: Placed | null;
        statusText: string | null;
        headActions: number;
        statusActions: number;
        inGroup: boolean;
        inComposer: boolean;
        controls: Placed[];
        removes: number;
        role: string | null;
        documentWidth: number;
      };
      assert.ok(
        measured.waiting &&
          measured.compact &&
          measured.file &&
          measured.headline &&
          measured.head &&
          measured.when &&
          measured.agent &&
          measured.status,
        `the waiting card is missing part of the output-card hierarchy at ${width}px`,
      );
      assert.equal(measured.inGroup, true, `the waiting card is outside its session at ${width}px`);
      assert.equal(measured.inComposer, false, `the waiting card is still inside the composer at ${width}px`);
      assert.equal(measured.role, 'status', `the waiting card is not announced at ${width}px`);
      assert.ok(
        measured.waiting.top < measured.compact.top,
        `the waiting prompt is drawn below the compaction it follows at ${width}px`,
      );
      assert.ok(
        measured.file.left >= measured.waiting.left - 1 && measured.file.right <= measured.waiting.right + 1,
        `the waiting attachment chip escapes its card at ${width}px`,
      );
      assert.ok(
        Math.abs(measured.file.left - measured.headline.left) <= 1,
        `the waiting attachment is not aligned with its prompt at ${width}px`,
      );
      assert.ok(
        measured.when.left < measured.agent.left && measured.agent.right <= measured.head.right + 1,
        `the waiting card does not keep time left and the agent right at ${width}px`,
      );
      assert.equal(
        measured.headActions,
        0,
        `the waiting-card actions compete with time and agent metadata at ${width}px`,
      );
      assert.equal(measured.statusActions, 3, `the waiting-card actions are outside its queue-state row at ${width}px`);
      assert.equal(
        measured.statusText,
        'Waiting to send',
        `the waiting card uses a different visible state at ${width}px`,
      );
      assert.ok(
        measured.status.top >= measured.file.bottom - 1,
        `the waiting-card state overlaps its attachment at ${width}px`,
      );
      assert.equal(measured.controls.length, 3, `the waiting card lost an action at ${width}px`);
      for (const control of measured.controls) {
        assert.ok(
          control.left >= measured.waiting.left - 1 && control.right <= measured.waiting.right + 1,
          `a waiting-card action escapes the card at ${width}px`,
        );
      }
      assert.equal(measured.removes, 0, `the waiting file chip has a second remove action outside Drop at ${width}px`);
      assert.ok(
        measured.documentWidth <= width + 1,
        `the waiting card makes a ${width}px panel ${measured.documentWidth}px wide`,
      );
      assert.deepEqual(failures, [], `the panel threw while drawing the waiting card at ${width}px`);
    }

    const entries = [
      {
        id: 'first',
        text: 'first',
        commentIds: [],
        assets: [],
        at: NOW,
        delivery: { phase: 'queued' as const, owner: 's1' },
      },
      {
        id: 'second',
        text: 'second',
        commentIds: [],
        assets: [],
        at: NOW + 1_000,
        delivery: { phase: 'queued' as const, owner: 's1' },
      },
      {
        id: 'third',
        text: 'third',
        commentIds: [],
        assets: [],
        at: NOW + 2_000,
        delivery: { phase: 'queued' as const, owner: 's1' },
      },
    ];
    const ordered = (queued: typeof entries) =>
      composerView(
        {
          ...COMPOSER,
          agent: 'codex',
          live: [compacting],
          queued,
        },
        NOW,
      );
    const initial = renderPayload() as { usage: { composer: unknown } };
    initial.usage.composer = ordered(entries);
    await page.evaluate(`window.postMessage(${JSON.stringify(initial)}, '*')`);
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await page
        .locator('.cwaiting')
        .evaluateAll((cards) =>
          cards.map((card) => (card as unknown as { dataset: { queued?: string } }).dataset.queued),
        ),
      ['third', 'second', 'first'],
      'waiting submissions are not drawn newest first',
    );
    await page.locator('[data-control="drop:second"]').focus();
    const replacement = entries.map((entry) =>
      entry.id === 'second' ? { ...entry, id: 'replacement', text: 'replacement' } : entry,
    );
    await page.evaluate(
      `window.postMessage(${JSON.stringify({
        type: 'usage',
        usage: { ...(initial.usage as object), composer: ordered(replacement) },
      })}, '*')`,
    );
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await page
        .locator('.cwaiting')
        .evaluateAll((cards) =>
          cards.map((card) => (card as unknown as { dataset: { queued?: string } }).dataset.queued),
        ),
      ['third', 'replacement', 'first'],
      'editing a middle waiting submission changes its place in the queue',
    );
    const focus = (await page.evaluate(`(() => {
      const active = document.activeElement;
      const queueTabs = [...document.querySelectorAll('.cwaitingact')].map((node) => node.tabIndex);
      return {
        control: active && active.dataset ? active.dataset.control || '' : '',
        tag: active ? active.tagName : '',
        tabIndex: active ? active.tabIndex : -2,
        queueZeros: queueTabs.filter((value) => value === 0).length,
      };
    })()`)) as { control: string; tag: string; tabIndex: number; queueZeros: number };
    assert.equal(focus.tag, 'BUTTON', 'removing a focused waiting card leaves focus on the document body');
    assert.notEqual(focus.control, 'drop:second', 'focus remains on a control removed from the page');
    assert.equal(focus.tabIndex, 0, 'the focus fallback is outside the page roving tab stop');
    assert.ok(focus.queueZeros <= 1, 'a usage-only queue update creates one tab stop per waiting action');
    assert.deepEqual(failures, [], 'the panel threw while reconciling the waiting-card order');
  } finally {
    await browser.close();
  }
});

test('the reply is anchored to its end, and the card it fills still widens nothing', { timeout: 60_000 }, async (t) => {
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

    for (const width of [1350, 340]) {
      const busy = await layoutAt(page, width, [], [LIVE_REPLY]);
      assert.deepEqual(failures, [], 'the panel threw while drawing the reply');
      assert.ok(busy.live, `the reply was recorded and no card was drawn at ${width}px`);
      assert.ok(busy.reply && busy.replyText, `the reply is on the press and no line was drawn at ${width}px`);
      // The live card retains the prompt above the streamed reply.

      assert.ok(busy.promptLine, `at ${width}px the reply took the prompt off the card the reader is checking`);
      assert.ok(
        busy.promptLine.bottom <= busy.reply.top + 1,
        `at ${width}px the reply is drawn over the prompt rather than under it`,
      );

      // The reply fixture exceeds its row width so end anchoring is measurable.

      assert.ok(
        busy.replyText.right - busy.replyText.left > busy.reply.right - busy.reply.left + 1,
        `at ${width}px the reply fits the row, so nothing here measures which end is cut`,
      );
      // The newest reply text aligns with the row's trailing edge.

      assert.ok(
        Math.abs(busy.replyText.right - busy.reply.right) <= 1,
        `at ${width}px the reply ends ${Math.round(busy.reply.right - busy.replyText.right)}px short of the row, ` +
          'so the line stops moving after the first few words',
      );
      assert.ok(
        busy.replyText.left < busy.reply.left - 1,
        `at ${width}px the start of the reply is on screen, so the end of it is what was cut`,
      );

      // Reply overflow stays within the live card.

      assert.ok(
        busy.reply.left >= busy.live.left - 1 && busy.reply.right <= busy.live.right + 1,
        `at ${width}px the reply row runs wider than the card it sits in`,
      );
      assert.ok(
        busy.live.right <= busy.list.right + 1 && busy.live.left >= busy.list.left - 1,
        `at ${width}px the card runs wider than the column once a reply is on it`,
      );
      // Compare cards with and without a reply to bound height growth.

      const dry = await layoutAt(page, width, [], [LIVE_PRESS]);
      assert.ok(dry.live, `the press with no reply on it drew no card at ${width}px`);
      const grew = busy.live.bottom - busy.live.top - (dry.live.bottom - dry.live.top);
      assert.ok(grew < 40, `the reply made the card ${Math.round(grew)}px taller at ${width}px, so it wrapped`);
      assert.ok(
        busy.documentWidth <= busy.viewportWidth + 1,
        `the reply scrolls the panel sideways at ${width}px: ${busy.documentWidth} wide in ${busy.viewportWidth}`,
      );

      // A short reply uses its text width without a leading empty gap.

      const first = await layoutAt(page, width, [], [{ ...LIVE_REPLY, reply: 'One' }]);
      assert.ok(first.reply && first.replyText, `the first chunk of a reply drew no line at ${width}px`);
      assert.ok(
        first.reply.right - first.reply.left <= first.replyText.right - first.replyText.left + 1,
        `at ${width}px a three-letter reply is given a row ${Math.round(first.reply.right - first.reply.left)}px ` +
          'wide, so it is drawn at the far end of the card with a gap in front of it',
      );
    }
  } finally {
    await browser.close();
  }
});

test('message bubble shapes stay centered on their first text line', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no browser installed');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(themed(pageHtml()));
    const payload = renderPayload() as { cards: Record<string, unknown>[] };
    payload.cards = [payload.cards[0]];
    payload.cards[0].saidMessages = ['commentary', 'answer'].flatMap((kind) =>
      [false, true].map((wrapped) => ({
        id: `${kind}-${wrapped}`,
        kind,
        at: NOW,
        when: '2:31 PM',
        absolute: '2:31 PM',
        text: 'Narration 1, one line of it.',
        summaryHtml: `<p>${'Narration 1, one line of it. '.repeat(wrapped ? 15 : 1)}</p>`,
        ...(kind === 'answer' ? { answerIndex: 0 } : {}),
      })),
    );
    setLogMessages(payload.cards[0]);
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
    await page.click('#list .turn .head');
    for (const width of [340, 900]) {
      await page.setViewportSize({ width, height: 1100 });
      for (const size of [12, 16, 20]) {
        // Change the theme font size to exercise live text scaling.
        await page.evaluate((fontSize) => document.body.style.setProperty('--vscode-font-size', `${fontSize}px`), size);
        await page.evaluate(SETTLED);
        const shapes = await page.locator('.actrow.message').evaluateAll((rows) =>
          rows.map((row) => {
            const glyph = row.querySelector('.actglyph')!;
            const origin = glyph.getBoundingClientRect().top;
            const bounds = ['::before', '::after'].flatMap((pseudo) => {
              const style = getComputedStyle(glyph, pseudo);
              const top = origin + parseFloat(style.top);
              const height =
                parseFloat(style.height) +
                (style.boxSizing === 'border-box'
                  ? 0
                  : parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth));
              const spans = [{ top, bottom: top + height }];
              if (style.boxShadow !== 'none') {
                const values = style.boxShadow
                  .replace(/rgba?\([^)]+\)/g, '')
                  .match(/-?[\d.]+px/g)!
                  .map(parseFloat);
                const [, y, , spread] = values;
                spans.push({ top: top + y - spread, bottom: top + height + y + spread });
              }
              return spans;
            });
            const paragraph = row.querySelector('.summary p')!;
            const firstLineCenter =
              paragraph.getBoundingClientRect().top + parseFloat(getComputedStyle(paragraph).lineHeight) / 2;
            const glyphCenter =
              (Math.min(...bounds.map((box) => box.top)) + Math.max(...bounds.map((box) => box.bottom))) / 2;
            return {
              kind: row.classList.contains('answer') ? 'reply' : 'narration',
              offset: glyphCenter - firstLineCenter,
            };
          }),
        );
        assert.equal(shapes.length, 4);
        assert.deepEqual(
          shapes.filter((shape) => !Number.isFinite(shape.offset) || Math.abs(shape.offset) > 0.5),
          [],
          `bubble centers must match their first line at ${width}px and ${size}px text`,
        );
      }
    }
  } finally {
    await browser.close();
  }
});

test(
  'Activity counts filter the log without losing totals, keyboard access or message choices',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no browser installed');
      return;
    }
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(5000);
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(String(error)));
      await page.setViewportSize({ width: 1350, height: 900 });
      await page.setContent(pageHtml());
      const source = turn({ stepCount: 65, stepKinds: Array(65).fill('commands'), summary: 'Closing response' });
      source.steps = Array.from({ length: 60 }, (_, n) => ({
        ordinal: n + 6,
        name: 'Bash',
        detail: 'npm test',
        at: NOW - 65 + n,
        status: 'done',
      }));
      source.updates = Array.from({ length: 6 }, (_, n) => ({
        sourceId: `narration-${n}`,
        text: `Narration ${n + 1}. `.repeat(60),
        kind: 'commentary',
        status: 'done',
        at: NOW - 65 + (n + 1) * 10,
        stepsBefore: (n + 1) * 10,
      }));
      source.updates.push({
        sourceId: 'reasoning',
        text: 'Checking the next call.',
        kind: 'reasoning',
        status: 'done',
        at: NOW - 1,
        stepsBefore: 64,
      });
      source.answers = [20, 40].map((n) => ({
        text: `Reply after call ${n}. `.repeat(60),
        at: NOW - 65 + n,
        stepsBefore: n,
      }));
      source.laterPrompts = [{ text: 'Keep the original anchors.', at: NOW - 35, stepsBefore: 30 }];
      const built = toCard(source, false, NOW);
      const payload = renderPayload() as { cards: Array<Record<string, unknown> & { key: string; sessionId: string }> };
      const card = payload.cards[0];
      card.activity = built.activity.map((row) =>
        row.kind === 'message' ? { ...row, summaryHtml: renderRichMarkdown(row.text!) } : row,
      );
      card.activityCounts = built.activityCounts;
      card.activityTools = built.activityTools;
      card.activityToolCategories = built.activityToolCategories;
      card.toolTally = [{ name: 'Bash', count: 65, category: 'commands' }];
      card.activityName = built.activityName;
      card.status = built.status;
      // Use one card because the selectors address its Activity log by class.

      payload.cards = [card];
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);
      await page.click('#list .turn .head');
      await page.evaluate(SETTLED);
      const word = page.locator('#list .turn .activitysec button.actword');
      const messages = page.locator('#list .turn .actcount:not(.acttool):not(.actskills)').nth(0);
      const replies = page.locator('#list .turn .actcount:not(.acttool):not(.actskills)').nth(1);
      const rows = () =>
        page.evaluate(`(() => {
      const log = document.querySelector('#list .turn .actlist');
      return ['message', 'answer', 'ask', 'run', 'reasoning', 'step'].map(kind =>
        [...log.querySelectorAll('.actrow.' + kind)].filter(row => !row.closest('[hidden]')).length);
    })()`);
      const messagesOnly = await rows();
      assert.deepEqual(
        messagesOnly,
        [8, 2, 0, 0, 0, 0],
        `a done turn initially exposes rows other than agent messages: ${JSON.stringify(messagesOnly)}`,
      );
      assert.equal(await page.locator('#list .turn .actviewstate').textContent(), CARD_ACTIONS.logMessagesView);
      await page.locator('#list .turn .actviewaction').click();
      await page.evaluate(SETTLED);
      const all = await rows();
      assert.deepEqual(all, [8, 2, 1, 7, 1, 1]);
      assert.deepEqual(await page.locator('#list .turn .actcount:not(.acttool):not(.actskills)').allTextContents(), [
        '8 messages',
        '2 replies',
      ]);
      assert.equal(await page.locator('#list .turn button button').count(), 0, 'the head contains nested buttons');
      await word.focus();
      await page.keyboard.press('Tab');
      assert.equal(await messages.evaluate((node) => node === document.activeElement), true);
      await page.keyboard.press('Tab');
      assert.equal(await replies.evaluate((node) => node === document.activeElement), true);
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(`document.activeElement.matches('.acttool')`), true);

      for (const width of [1350, 340]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(SETTLED);
        const inside = await page.evaluate(`(() => {
        const card = document.querySelector('#list .turn').getBoundingClientRect();
        const head = document.querySelector('#list .turn .activitysec .acthead').getBoundingClientRect();
        return [...document.querySelectorAll('#list .turn .actcount')].every(node => {
          const box = node.getBoundingClientRect();
          return box.left >= card.left && box.right <= card.right && box.top >= head.top && box.bottom <= head.bottom + 1;
        });
      })()`);
        assert.equal(inside, true, `a count is clipped at ${width}px`);
        // At wide widths, counts share the Activity label's line. At narrow widths, the mix moves below it.

        const counts = (await page.evaluate(`(() => {
        const box = (node) => node.getBoundingClientRect();
        const mid = (rect) => rect.top + rect.height / 2;
        const word = box(document.querySelector('#list .turn .activitysec .actword'));
        const mix = box(document.querySelector('#list .turn .activitysec .actmix'));
        return [...document.querySelectorAll('#list .turn .activitysec .actcount')].map((count) => {
          const rect = box(count);
          const beside = rect.top < word.bottom && rect.bottom > word.top;
          return { beside, offset: mid(rect) - mid(beside ? word : mix) };
        });
      })()`)) as { beside: boolean; offset: number }[];
        if (width === 1350) {
          assert.deepEqual(
            counts.filter((count) => !count.beside),
            [],
            `an Activity count left the word's line at ${width}px, where the head has room for the whole mix beside it`,
          );
        }
        assert.deepEqual(
          counts.filter((count) => Math.abs(count.offset) > 0.5),
          [],
          `Activity counts do not share the visual center of the line they sit on at ${width}px`,
        );
        await word.focus();
        await page.keyboard.press('Tab');
        const ringVisible = await messages.evaluate((node) => {
          const style = getComputedStyle(node);
          const ring = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
          if (style.outlineStyle === 'none' || ring <= 0) return false;
          const box = node.getBoundingClientRect();
          for (let parent = node.parentElement; parent; parent = parent.parentElement) {
            const clipping = getComputedStyle(parent);
            const rect = parent.getBoundingClientRect();
            if (clipping.overflowX === 'hidden' && (box.left - ring < rect.left || box.right + ring > rect.right))
              return false;
            if (clipping.overflowY === 'hidden' && (box.top - ring < rect.top || box.bottom + ring > rect.bottom))
              return false;
          }
          return true;
        });
        assert.equal(ringVisible, true, `the count's focus ring is clipped at ${width}px`);
      }
      await word.focus();
      await page.keyboard.press('Shift+Enter');
      await page.evaluate(SETTLED);
      assert.equal(await page.locator('#list .turn .said button.more[aria-expanded="true"]').count(), 8);
      await replies.focus();
      await page.keyboard.press('Enter');
      await page.evaluate(SETTLED);
      assert.deepEqual(await rows(), [2, 2, 0, 0, 0, 0]);
      assert.equal(await replies.getAttribute('aria-pressed'), 'true');
      assert.equal(await replies.getAttribute('data-hint'), CARD_ACTIONS.logEverything);
      assert.equal(await replies.getAttribute('data-hint-detail'), CARD_ACTIONS.logFilterDetail);
      assert.match((await word.getAttribute('aria-label'))!, /, showing replies only, Collapse this section$/);
      assert.equal(
        await page
          .locator('#list .turn .actrow.answer .saidonly')
          .evaluateAll((nodes) => nodes.every((node) => node.textContent.startsWith('Replied, '))),
        true,
      );
      await word.focus();
      await page.keyboard.press('Shift+Enter');
      await page.evaluate(SETTLED);
      assert.equal(await word.evaluate((node) => node === document.activeElement), true);
      assert.equal(await page.locator('#list .turn .said button.more[aria-expanded="true"]').count(), 0);
      await replies.click();
      await page.evaluate(SETTLED);
      assert.deepEqual(await rows(), all);
      assert.equal(await replies.getAttribute('aria-pressed'), 'false');
      assert.equal(await replies.getAttribute('data-hint'), CARD_ACTIONS.logRepliesOnly);
      assert.equal(
        await page.locator('#list .turn .message:not(.answer) button.more[aria-expanded="true"]').count(),
        6,
        'a bulk press changed messages hidden by the reply filter',
      );
      await replies.click();
      await messages.focus();
      await page.keyboard.press('Space');
      await page.evaluate(SETTLED);
      assert.deepEqual(await rows(), [8, 2, 0, 0, 0, 0]);
      assert.equal(await messages.getAttribute('aria-pressed'), 'true');
      assert.equal(await replies.getAttribute('aria-pressed'), 'false');
      assert.match((await word.getAttribute('aria-label'))!, /, showing messages only, Collapse this section$/);
      await page.evaluate(
        `window.postMessage(${JSON.stringify({ type: 'activity', session: card.sessionId, card: { ...card, activityName: `${card.activityName}, refreshed` } })}, '*')`,
      );
      await page.evaluate(SETTLED);
      assert.deepEqual(await rows(), [8, 2, 0, 0, 0, 0], 'a refresh lost the active filter');
      await word.click();
      await page.evaluate(SETTLED);
      assert.match((await word.getAttribute('aria-label'))!, /, showing messages only, Expand this section$/);
      await replies.click();
      await page.evaluate(SETTLED);
      assert.equal(await word.getAttribute('aria-expanded'), 'true', 'a count left the log shut');
      assert.deepEqual(await rows(), [2, 2, 0, 0, 0, 0]);
      assert.deepEqual(await page.locator('#list .turn .actcount:not(.acttool):not(.actskills)').allTextContents(), [
        '8 messages',
        '2 replies',
      ]);
      const toolOnly = {
        ...card,
        activityCounts: [],
        activity: (card.activity as Array<{ kind: string }>).filter((row) => row.kind !== 'message'),
      };
      await page.evaluate(
        `window.postMessage(${JSON.stringify({
          type: 'activity',
          session: card.sessionId,
          card: toolOnly,
        })}, '*')`,
      );
      await page.evaluate(SETTLED);
      assert.equal(await page.locator('#list .turn .actcount:not(.acttool):not(.actskills)').count(), 0);
      await page.evaluate(
        `window.postMessage(${JSON.stringify({ type: 'activity', session: card.sessionId, card })}, '*')`,
      );
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.locator('#list .turn .actcount:not(.acttool):not(.actskills)').allTextContents(),
        ['8 messages', '2 replies'],
        'message counts did not return ahead of stable tool-count anchors',
      );
      assert.equal(
        await page.locator('#list .turn .actmix').textContent(),
        '8 messages, 2 replies · 65 run · 3 skills',
        'the returning message counts changed the order or separators of the Activity summary',
      );
      await page.evaluate(
        `window.postMessage(${JSON.stringify({
          type: 'activity',
          session: card.sessionId,
          card: { ...card, activityCounts: ['8 messages'] },
        })}, '*')`,
      );
      await page.evaluate(SETTLED);
      assert.equal(
        await page.locator('#list .turn .actmix').textContent(),
        '8 messages · 65 run · 3 skills',
        'removing a reply count changed the order or separators of the Activity summary',
      );
      await messages.click();
      const emptyCard = {
        ...card,
        activityCounts: [],
        activity: (card.activity as Array<{ kind: string }>).filter((row) => row.kind !== 'message'),
      };
      for (const width of [1350, 340]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(
          `window.postMessage(${JSON.stringify({
            type: 'activity',
            session: card.sessionId,
            card: emptyCard,
          })}, '*')`,
        );
        await page.evaluate(SETTLED);
        const lefts = (await page.evaluate(`(() => {
        const empty = document.querySelector('#list .turn .actempty').getBoundingClientRect();
        const view = document.querySelector('#list .turn .actview').getBoundingClientRect();
        return { empty: empty.left, view: view.left };
      })()`)) as { empty: number; view: number };
        assert.ok(Math.abs(lefts.empty - lefts.view) <= 0.5, `the empty Activity message is indented at ${width}px`);
      }
      const categoryCard = {
        ...card,
        activityToolCategories: [
          { key: 'commands', label: 'run', count: 17 },
          { key: 'edits', label: 'edit', count: 1 },
          { key: 'coordination', label: 'coordinate', count: 1 },
        ],
        toolTally: [
          { name: 'exec', count: 17, category: 'commands' },
          { name: 'apply_patch', count: 1, category: 'edits' },
          { name: 'send_message', count: 1, category: 'coordination' },
        ],
      };
      await page.setViewportSize({ width: 1350, height: 900 });
      await page.evaluate(
        `window.postMessage(${JSON.stringify({
          type: 'activity',
          session: card.sessionId,
          card: categoryCard,
        })}, '*')`,
      );
      await page.evaluate(SETTLED);
      const categoryCounts = page.locator('#list .turn .acttool');
      const popoverNames = () => page.locator('#chippop .chippopitem .chippoplabel').allTextContents();
      await categoryCounts.nth(0).hover();
      await page.evaluate(SETTLED);
      assert.deepEqual(await popoverNames(), ['exec'], 'hover shows tools outside the run category');
      await categoryCounts.nth(1).focus();
      await page.evaluate(SETTLED);
      assert.deepEqual(await popoverNames(), ['apply_patch'], 'focus shows tools outside the edit category');
      await categoryCounts.nth(2).click();
      await page.evaluate(SETTLED);
      assert.deepEqual(await popoverNames(), ['send_message'], 'click shows tools outside the coordination category');
      await page.keyboard.press('Escape');
      assert.deepEqual(failures, []);
    } finally {
      await browser.close();
    }
  },
);

test(
  'the Activity skill count opens a list the reader can walk into and open a skill from',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no browser installed');
      return;
    }
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(5000);
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(String(error)));
      await page.setViewportSize({ width: 1350, height: 900 });
      // Use the Dark Modern theme fixture for rendered contrast measurements.

      await page.setContent(themed(pageHtml(), 'dark'));
      const payload = renderPayload() as { cards: Array<Record<string, unknown> & { key: string; sessionId: string }> };
      const card = payload.cards[0];
      Object.assign(card, {
        status: 'done',
        activityCounts: ['1 message'],
        activityToolCategories: [{ key: 'commands', label: 'run', count: 2 }],
        toolTally: [{ name: 'exec', count: 2, category: 'commands' }],
        activitySkills: CARD_SKILLS,
        activitySkillCount: 4,
        activitySkillLabel: '4 skills',
        activity: [
          {
            kind: 'run',
            id: 'skill-run',
            status: 'done',
            count: 2,
            failed: 0,
            earlier: 0,
            line: '2 tool calls',
            code: '',
            figure: '',
            since: null,
            title: '',
            label: '2 tool calls',
            mix: '2 run',
            steps: [
              {
                kind: 'step',
                id: 'skill-step',
                status: 'done',
                line: 'Ran',
                code: 'cat SKILL.md',
                figure: '',
                since: null,
                title: 'cat SKILL.md',
                name: 'Ran cat SKILL.md',
              },
            ],
          },
          {
            kind: 'message',
            messageKind: 'commentary',
            id: 'skill-message',
            status: 'done',
            at: NOW,
            when: '2:31 PM',
            absolute: '2:31 PM',
            text: 'Finished.',
            summaryHtml: '<p>Finished.</p>',
            line: '',
            code: '',
            figure: '',
            since: null,
            title: '',
          },
        ],
      });
      payload.cards = [card];
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);
      await page.click('#list .turn .head');
      await page.evaluate(SETTLED);

      // The skill count follows the tool mix and remains separate from tool categories.

      const anchor = page.locator('#list .turn .actskills');
      assert.equal(await anchor.count(), 1);
      assert.equal(await anchor.textContent(), '4 skills');
      assert.equal(await anchor.getAttribute('aria-label'), `4 skills, ${CARD_ACTIONS.activitySkillsPopover}`);
      assert.equal(
        (await page.locator('#list .turn .acthead .actmix').textContent())?.replace(/\s+/g, ' ').trim(),
        '1 message · 2 run · 4 skills',
      );
      assert.equal(await page.locator('#list .turn .acttool').count(), 1, 'the skill count joined the tool categories');
      assert.equal(
        await page.locator('#list .turn .actcount:not(.acttool):not(.actskills)').count(),
        1,
        'the message filter buttons changed',
      );
      assert.equal(
        await anchor.getAttribute('aria-expanded'),
        'false',
        'the shut skills list is not announced as a disclosure',
      );

      // Hover displays the skill rows and file controls.

      const pop = page.locator('#chippop');
      await anchor.hover();
      await page.evaluate(SETTLED);
      assert.equal(await pop.isHidden(), false);
      assert.equal(await pop.getAttribute('role'), 'dialog');
      assert.equal(
        await pop.locator('.chippopsubitem.chippoppath .chippopnamelink').count(),
        2,
        'the hover drew a list with no file link on it, so the pointer reaches nothing',
      );
      // The unpinned skills popover ignores pointer events.

      assert.equal(
        await pop.evaluate((node) => getComputedStyle(node).pointerEvents),
        'none',
        'the shown skills popover takes the pointer before it is pinned',
      );

      // Pinning gives the popover its dialog name. Supporting text remains a description.

      await anchor.click();
      await page.evaluate(SETTLED);
      assert.equal(await pop.getAttribute('role'), 'dialog');
      assert.equal(await pop.getAttribute('aria-label'), CARD_ACTIONS.activitySkillsHeading);
      assert.equal(await anchor.getAttribute('aria-expanded'), 'true');
      assert.equal(await anchor.getAttribute('aria-pressed'), 'true');
      assert.equal(await anchor.getAttribute('aria-controls'), 'chippop');
      // The pinned popover accepts pointer events.

      assert.equal(await pop.evaluate((node) => getComputedStyle(node).pointerEvents), 'auto');
      assert.equal(await pop.locator('.chippophead .chippoplabel').textContent(), CARD_ACTIONS.activitySkillsHeading);
      assert.deepEqual(
        await pop.locator('.chippopitem .chippoplabel').allTextContents(),
        ['review-the-change ×2', 'panel-mockup', 'polish'],
        'the list lost a distinct skill or its repeat count',
      );
      assert.deepEqual(
        await pop.locator('.chippopitem .chippopvalue').allTextContents(),
        [],
        'no row names its evidence in the head',
      );
      // Skill rows include their description and recorded path.

      assert.deepEqual(await pop.locator('.chippopitem').nth(1).locator('.chippopsubitem').allTextContents(), [
        MOCKUP_SKILL_DESCRIPTION,
        MOCKUP_SKILL_PATH,
      ]);
      // The description fixture exceeds the text limit. Its native tooltip retains the complete description.

      assert.ok(
        MOCKUP_SKILL_FULL_DESCRIPTION.length > STEP_DETAIL_LIMIT,
        'the raw description is not longer than the row cuts it to, so the clamp guard below proves nothing',
      );
      const mockupDesc = pop.locator('.chippopitem').nth(1).locator('.chippopsubitem').nth(0);
      assert.equal(
        await mockupDesc.getAttribute('title'),
        MOCKUP_SKILL_FULL_DESCRIPTION,
        'the full description never reached the row as a hover title',
      );
      // The text limit fits within the row, so these assertions check the clamp rule rather than actual two-line overflow.

      assert.equal(
        await mockupDesc.evaluate((node) => node.classList.contains('chippopdesc')),
        true,
        'the description did not draw under the class that clamps it',
      );
      const mockupLineClamp = await mockupDesc.evaluate((node) =>
        getComputedStyle(node).getPropertyValue('-webkit-line-clamp'),
      );
      assert.equal(mockupLineClamp, '2', 'the clamp does not stop the row at two lines');
      // The file path uses the editor font separately from the description.

      const mockupPath = pop.locator('.chippopitem').nth(1).locator('.chippopsubitem').nth(1);
      assert.equal(
        await mockupPath.evaluate((node) => node.classList.contains('chippoppath')),
        true,
        'the path did not draw under the class that gives it the editor face',
      );
      const rowFonts = (await page.evaluate(`(() => {
      const row = document.querySelectorAll('#chippop .chippopitem')[1].querySelectorAll('.chippopsubitem');
      return {
        body: getComputedStyle(document.body).fontFamily,
        description: getComputedStyle(row[0]).fontFamily,
        path: getComputedStyle(row[1]).fontFamily,
      };
    })()`)) as { body: string; description: string; path: string };
      assert.equal(rowFonts.description, rowFonts.body, 'the description left the panel face');
      assert.notEqual(rowFonts.path, rowFonts.body, 'the path did not take the editor face apart from the description');
      const rowColors = (await page.evaluate(`(() => {
      const row = document.querySelectorAll('#chippop .chippopitem')[1].querySelectorAll('.chippopsubitem');
      return { description: getComputedStyle(row[0]).color, path: getComputedStyle(row[1]).color };
    })()`)) as { description: string; path: string };
      assert.notEqual(
        rowColors.description,
        rowColors.path,
        'the description and the path share one idle tone instead of a hierarchy',
      );
      // Rendered file-path contrast meets 4.5:1 in both default theme fixtures.

      const darkPathContrast = await skillPathContrastRatio(page);
      assert.ok(
        darkPathContrast >= 4.5,
        `the path contrast in Dark Modern fell to ${darkPathContrast.toFixed(2)}:1, under the 4.5:1 floor`,
      );
      // The Light Modern fixture also checks path and description hierarchy.

      const lightPage = await browser.newPage();
      try {
        lightPage.setDefaultTimeout(5000);
        await lightPage.setViewportSize({ width: 1350, height: 900 });
        await lightPage.setContent(themed(pageHtml(), 'light'));
        await lightPage.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
        await lightPage.evaluate(SETTLED);
        await lightPage.click('#list .turn .head');
        await lightPage.evaluate(SETTLED);
        await lightPage.click('#list .turn .actskills');
        await lightPage.evaluate(SETTLED);
        const lightColors = (await lightPage.evaluate(`(() => {
        const row = document.querySelectorAll('#chippop .chippopitem')[1].querySelectorAll('.chippopsubitem');
        return { description: getComputedStyle(row[0]).color, path: getComputedStyle(row[1]).color };
      })()`)) as { description: string; path: string };
        assert.notEqual(
          lightColors.description,
          lightColors.path,
          'the description and the path share one tone in Light Modern, where the theme gives the foreground and the idle tone the same value',
        );
        const lightPathContrast = await skillPathContrastRatio(lightPage);
        assert.ok(
          lightPathContrast >= 4.5,
          `the path contrast in Light Modern fell to ${lightPathContrast.toFixed(2)}:1, under the 4.5:1 floor`,
        );
      } finally {
        await lightPage.close();
      }
      assert.deepEqual(
        await pop.locator('.chippopitem').nth(0).locator('.chippopsubitem').allTextContents(),
        [RECORDED_SKILL_PATH],
        'a recorded row carries only its path',
      );
      // The file path is actionable while the skill name remains plain text.
      assert.equal(
        await pop
          .locator('.chippopitem')
          .nth(0)
          .locator('.chippopitemhead .chippoplabel')
          .evaluate((node) => node.tagName),
        'SPAN',
        'the skill name did not stay plain text',
      );
      assert.equal(
        await pop.locator('.chippopitem').nth(0).locator('.chippopsubitem.chippoppath .chippopnamelink').count(),
        1,
        'the recorded file path did not draw as the press',
      );
      // A skill without a recorded path has no open-file control.
      assert.deepEqual(await pop.locator('.chippopitem').nth(2).locator('.chippopsubitem').allTextContents(), [
        CARD_ACTIONS.activitySkillsMissing,
      ]);
      assert.equal(
        await pop.locator('.chippopitem').nth(2).locator('.chippopnamelink').count(),
        0,
        'a skill with no recorded file drew its name as a press that opens nothing',
      );
      assert.equal(
        await pop
          .locator('.chippopitem')
          .nth(2)
          .locator('.chippopitemhead .chippoplabel')
          .evaluate((node) => node.tagName),
        'SPAN',
        'a skill with no recorded file drew its plain name as a button anyway',
      );
      assert.deepEqual(
        await pop.locator('.chippopfoot').allTextContents(),
        [CARD_ACTIONS.activitySkillsBestEffort],
        'the reader is not told the list holds a best-effort Codex match',
      );
      assert.deepEqual(
        await popoverDescriptions(page),
        [CARD_ACTIONS.activitySkillsBestEffort],
        'the best-effort note is spoken as a description of the dialog',
      );
      const opens = pop.locator('.chippopsubitem.chippoppath .chippopnamelink');
      assert.equal(await opens.count(), 2);
      assert.equal(await opens.nth(0).textContent(), RECORDED_SKILL_PATH);
      // The file control's accessible name includes the skill label and path.
      assert.equal(await opens.nth(0).getAttribute('aria-label'), `review-the-change ×2, ${RECORDED_SKILL_PATH}`);
      assert.equal(
        await opens.nth(0).getAttribute('data-hint'),
        CARD_ACTIONS.activitySkillsOpen,
        'the file link carries no hint of what pressing it does',
      );
      assert.equal(await opens.nth(0).getAttribute('title'), null, 'the file link put a native title on a button');
      const clickablePathSizes = (await page.evaluate(`(() => {
      const link = document.querySelector('#chippop .chippopnamelink');
      return { link: getComputedStyle(link).fontSize, row: getComputedStyle(link.parentElement).fontSize };
    })()`)) as { link: string; row: string };
      assert.equal(
        clickablePathSizes.link,
        clickablePathSizes.row,
        'the clickable skill file path shrank below the other recorded paths',
      );
      assert.equal(
        await opens.nth(0).evaluate((node) => node.classList.contains('chippoppath')),
        false,
        'the clickable skill file path repeated the row styling that sets its text size',
      );

      // The file control uses the theme link color before interaction.

      const linkColors = (await page.evaluate(`(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--vscode-textLink-foreground)';
      document.body.appendChild(probe);
      const themeLink = getComputedStyle(probe).color;
      probe.remove();
      const pathLink = getComputedStyle(document.querySelectorAll('#chippop .chippopnamelink')[0]).color;
      const plainName = getComputedStyle(
        document.querySelectorAll('#chippop .chippopitem')[2].querySelector('.chippoplabel')).color;
      return { themeLink, pathLink, plainName };
    })()`)) as { themeLink: string; pathLink: string; plainName: string };
      assert.equal(
        linkColors.pathLink,
        linkColors.themeLink,
        "the skill file path's colour did not match the theme's link colour before any press",
      );
      assert.notEqual(
        linkColors.pathLink,
        linkColors.plainName,
        'the skill file path read the same colour as a plain row name',
      );

      // The keyboard enters the popover from its anchor and moves between file controls.
      await anchor.focus();
      await page.keyboard.press('ArrowDown');
      assert.equal(
        await page.evaluate('document.activeElement?.getAttribute("aria-label")'),
        `review-the-change ×2, ${RECORDED_SKILL_PATH}`,
      );
      // Focused file controls have a visible outline and underline.

      const focusIndicator = (await page.evaluate(`(() => {
      const style = getComputedStyle(document.activeElement);
      return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, textDecorationLine: style.textDecorationLine };
    })()`)) as { outlineStyle: string; outlineWidth: string; textDecorationLine: string };
      assert.notEqual(
        focusIndicator.outlineStyle,
        'none',
        'keyboard focus on the skill file path drew no visible outline',
      );
      assert.notEqual(
        focusIndicator.outlineWidth,
        '0px',
        'keyboard focus on the skill file path drew a zero-width outline',
      );
      assert.equal(
        focusIndicator.textDecorationLine,
        'underline',
        'keyboard focus on the skill file path did not underline it the way a pointer hover does',
      );
      await page.keyboard.press('ArrowDown');
      assert.equal(
        await page.evaluate('document.activeElement?.getAttribute("aria-label")'),
        `panel-mockup, ${MOCKUP_SKILL_PATH}`,
      );
      await page.keyboard.press('ArrowUp');
      assert.equal(
        await page.evaluate('document.activeElement?.getAttribute("aria-label")'),
        `review-the-change ×2, ${RECORDED_SKILL_PATH}`,
      );

      // Control-click requests opening the skill beside the current editor.
      await opens.nth(0).click({ modifiers: ['Control'] });
      await page.evaluate(SETTLED);
      assert.deepEqual(await page.evaluate(`window.__posted.filter((m) => m.type === 'openSkill').at(-1)`), {
        type: 'openSkill',
        key: card.key,
        path: RECORDED_SKILL_PATH,
        beside: true,
      });
      await opens.nth(1).click();
      await page.evaluate(SETTLED);
      assert.deepEqual(await page.evaluate(`window.__posted.filter((m) => m.type === 'openSkill').at(-1)`), {
        type: 'openSkill',
        key: card.key,
        path: MOCKUP_SKILL_PATH,
        beside: false,
      });

      // Escape closes the popover and returns focus to its skill count.
      await page.keyboard.press('Escape');
      await page.evaluate(SETTLED);
      assert.equal(await pop.isHidden(), true);
      assert.equal(await anchor.getAttribute('aria-expanded'), 'false');
      assert.equal(
        await page.evaluate('document.activeElement?.dataset.control'),
        `activity-skills:${card.key}`,
        'Escape left focus inside a popover the reader can no longer see',
      );

      // Tab leaves the body-mounted popover at its anchor's position in the keyboard order.

      await anchor.click();
      await page.evaluate(SETTLED);
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      assert.equal(await pop.isHidden(), true, 'walking past the last button left the popover open');
      assert.equal(
        await page.evaluate('document.activeElement?.className'),
        'actviewaction',
        'the walk out of the popover followed its place in the document instead of the anchor',
      );

      // Focus outside the popover and its anchor closes it.
      await anchor.click();
      await page.keyboard.press('ArrowDown');
      await page.locator('#list .turn .actviewaction').focus();
      await page.evaluate(SETTLED);
      assert.equal(
        await pop.isHidden(),
        true,
        'focus left the popover for another control and the popover stayed open',
      );

      // A second anchor press closes the popover.
      await anchor.click();
      await page.evaluate(SETTLED);
      assert.equal(await pop.isHidden(), false);
      await anchor.click();
      await page.evaluate(SETTLED);
      assert.equal(await pop.isHidden(), true, 'a second press on the count left the list open');

      // Read-only tool anchors describe a tooltip rather than control a dialog.

      const tool = page.locator('#list .turn .acttool');
      await tool.hover();
      await page.evaluate(SETTLED);
      assert.equal(await pop.getAttribute('role'), 'tooltip');
      assert.equal(await tool.getAttribute('aria-describedby'), 'chippop');
      assert.equal(await tool.getAttribute('aria-controls'), null);
      assert.equal(await pop.locator('.chippopnamelink').count(), 0);

      // Skill loads do not create tool categories, and zero skills omit the skill count.

      const loaded = toCard(turn({ stepCount: 2, stepKinds: ['commands', 'skill'] }), false, NOW);
      assert.deepEqual(
        loaded.activityToolCategories.map((category) => category.key),
        ['commands'],
        'a skill load reached the tool categories',
      );
      Object.assign(card, {
        activitySkills: [],
        activitySkillCount: 0,
        activitySkillLabel: '0 skills',
        activityToolCategories: loaded.activityToolCategories,
      });
      await page.evaluate(
        `window.postMessage(${JSON.stringify({ type: 'activity', session: card.sessionId, card })}, '*')`,
      );
      await page.evaluate(SETTLED);
      assert.equal(
        await page.locator('#list .turn .actskills').count(),
        0,
        'a turn that loaded no skill still draws a skill count',
      );
      assert.deepEqual(failures, []);
    } finally {
      await browser.close();
    }
  },
);

test(
  'a skills popover with only recorded skills draws no evidence label and no footer',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no browser installed');
      return;
    }
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(5000);
      await page.setViewportSize({ width: 1350, height: 900 });
      await page.setContent(pageHtml());
      const payload = renderPayload() as { cards: Array<Record<string, unknown> & { key: string; sessionId: string }> };
      const card = payload.cards[0];
      const claudeOnly = CARD_SKILLS.filter((skill) => skill.evidence === 'recorded');
      Object.assign(card, {
        status: 'done',
        activityCounts: ['1 message'],
        activitySkills: claudeOnly,
        activitySkillCount: claudeOnly.length,
        activitySkillLabel: `${claudeOnly.length} skills`,
      });
      payload.cards = [card];
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);
      await page.click('#list .turn .head');
      await page.evaluate(SETTLED);
      const anchor = page.locator('#list .turn .actskills');
      await anchor.click();
      await page.evaluate(SETTLED);
      const pop = page.locator('#chippop');
      assert.equal(await pop.getAttribute('role'), 'dialog');
      assert.deepEqual(
        await pop.locator('.chippopitem .chippopvalue').allTextContents(),
        [],
        'a Claude-only list still names its evidence in the head',
      );
      assert.equal(
        await pop.locator('.chippopfoot').count(),
        0,
        'a Claude-only list drew the Codex best-effort footer',
      );
    } finally {
      await browser.close();
    }
  },
);

test(
  'Activity defaults follow turn status and wait for a focused row on completion',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no browser installed');
      return;
    }
    try {
      const page = await browser.newPage();
      await page.setContent(pageHtml());
      const payload = renderPayload() as { cards: Array<Record<string, unknown> & { key: string; sessionId: string }> };
      const source = payload.cards[0];
      const message = {
        kind: 'message',
        messageKind: 'commentary',
        id: 'status-message',
        status: 'done',
        at: NOW,
        when: '2:31 PM',
        absolute: '2:31 PM',
        text: 'Status message.',
        summaryHtml: '<p>Status message.</p>',
        line: '',
        code: '',
        figure: '',
        since: null,
        title: '',
      };
      const run = {
        kind: 'run',
        id: 'status-run',
        status: 'done',
        count: 2,
        failed: 0,
        earlier: 0,
        line: '2 tool calls',
        code: '',
        figure: '',
        since: null,
        title: '',
        label: '2 tool calls',
        mix: '2 run',
        steps: [1, 2].map((ordinal) => ({
          kind: 'step',
          id: `status-step-${ordinal}`,
          status: 'done',
          line: 'Ran',
          code: 'npm test',
          figure: '',
          since: null,
          title: 'npm test',
          name: 'Ran npm test',
        })),
      };
      const statuses = ['done', 'running', 'failed', 'interrupted', 'stopped'];
      payload.cards = statuses.map((status) => ({
        ...source,
        key: `${source.key}-${status}`,
        status,
        activity: [run, message],
        activityCounts: ['1 message'],
        activityToolCategories: [{ key: 'commands', label: 'run', count: 2 }],
        toolTally: [{ name: 'exec', count: 2, category: 'commands' }],
      }));
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);
      await page
        .locator('#list .turn .head')
        .evaluateAll((heads) => heads.forEach((head) => (head as HTMLElement).click()));
      await page.evaluate(SETTLED);
      const defaults = await page.locator('#list .turn').evaluateAll((cards) =>
        cards.map((card) => ({
          status: Array.from(card.classList).find((name) =>
            ['done', 'running', 'failed', 'interrupted', 'stopped'].includes(name),
          ),
          view: card.querySelector('.actviewstate')?.textContent,
          rows: Array.from(card.querySelectorAll('.actrow'))
            .filter((row) => !row.closest('[hidden]'))
            .map((row) => Array.from(row.classList)),
        })),
      );
      assert.deepEqual(
        defaults.map((entry) => [entry.status, entry.view, entry.rows.some((row) => row.includes('run'))]),
        [
          ['done', CARD_ACTIONS.logMessagesView, false],
          ['running', CARD_ACTIONS.logAllActivity, true],
          ['failed', CARD_ACTIONS.logAllActivity, true],
          ['interrupted', CARD_ACTIONS.logAllActivity, true],
          ['stopped', CARD_ACTIONS.logAllActivity, true],
        ],
      );

      const running = {
        ...source,
        key: `${source.key}-transition`,
        status: 'running',
        activity: [run, message],
        activityCounts: ['1 message'],
        activityToolCategories: [{ key: 'commands', label: 'run', count: 2 }],
        toolTally: [{ name: 'exec', count: 2, category: 'commands' }],
      };
      payload.cards = [running];
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);
      await page.locator('#list .turn .head').click();
      await page.locator('#list .turn .actrow.run').focus();
      await page.evaluate(
        `window.postMessage(${JSON.stringify({
          type: 'activity',
          session: running.sessionId,
          card: { ...running, status: 'done' },
        })}, '*')`,
      );
      await page.evaluate(SETTLED);
      assert.equal(
        await page.locator('#list .turn .actviewstate').textContent(),
        CARD_ACTIONS.logAllActivity,
        'completion hid a focused tool group before focus left Activity',
      );
      await page.locator('#list .turn .actviewaction').focus();
      await page.evaluate(SETTLED);
      assert.equal(await page.locator('#list .turn .actviewstate').textContent(), CARD_ACTIONS.logMessagesView);
    } finally {
      await browser.close();
    }
  },
);

test('Activity and expandable prompt headings read as interactive in both themes', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no browser installed');
    return;
  }
  try {
    for (const kind of ['dark', 'light'] as const) {
      const page = await browser.newPage();
      await page.setViewportSize({ width: 340, height: 900 });
      await page.setContent(themed(pageHtml(), kind));
      const payload = renderPayload() as { cards: Array<Record<string, unknown>> };
      payload.cards[0].prompt =
        'Keep this prompt readable when its expandable heading receives pointer and keyboard focus. '.repeat(40);
      // Below the response displays the You asked heading.
      Object.assign(payload, { timelineLayout: { cardLayout: 'compact', promptPosition: 'below' } });
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);
      await page.locator('#list .turn .head').first().click();
      await page.evaluate(SETTLED);
      const word = page.locator('#list .turn .actword').first();
      const title = word.locator('.sec-title');
      const resting = await title.evaluate((node) => getComputedStyle(node).color);
      await word.hover();
      const hovered = await title.evaluate((node) => getComputedStyle(node).color);
      await page.mouse.move(0, 0);
      await page.keyboard.press('Tab');
      await word.focus();
      const focused = await title.evaluate((node) => getComputedStyle(node).color);
      assert.notEqual(hovered, resting, `pointer hover leaves Activity passive in the ${kind} theme`);
      assert.equal(focused, hovered, `keyboard focus and pointer hover disagree in the ${kind} theme`);

      const prompt = page.locator('#list .turn .promptsec button.acthead').first();
      assert.equal(await prompt.count(), 1, `the ${kind} fixture has no expandable prompt heading`);
      const promptTitle = prompt.locator('.sec-title');
      const promptResting = await promptTitle.evaluate((node) => getComputedStyle(node).color);
      await prompt.hover();
      const promptHovered = await promptTitle.evaluate((node) => getComputedStyle(node).color);
      await page.mouse.move(0, 0);
      await page.keyboard.press('Tab');
      await prompt.focus();
      const promptFocused = await promptTitle.evaluate((node) => getComputedStyle(node).color);
      assert.notEqual(promptHovered, promptResting, `pointer hover leaves You asked passive in the ${kind} theme`);
      assert.equal(
        promptFocused,
        promptHovered,
        `keyboard focus and pointer hover disagree for You asked in the ${kind} theme`,
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test(
  'settled group failures and raw tool detail keep their exact, neutral presentation',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no browser installed');
      return;
    }
    try {
      const page = await browser.newPage();
      await page.setViewportSize({ width: 340, height: 600 });
      await page.setContent(themed(pageHtml()));
      // Change font families while retaining the default theme colors.

      await page.evaluate(() => {
        document.documentElement.style.setProperty('--vscode-font-family', 'Arial');
        document.documentElement.style.setProperty('--vscode-editor-font-family', 'Consolas');
      });
      const payload = renderPayload() as { cards: Array<Record<string, unknown> & { key: string; sessionId: string }> };
      const card = payload.cards[0];
      Object.assign(card, {
        status: 'done',
        activityCounts: ['1 message'],
        activityToolCategories: [{ key: 'commands', label: 'run', count: 6 }],
        toolTally: Array.from({ length: 80 }, (_, index) => ({
          name: `raw_tool_${String(index).padStart(2, '0')}`,
          count: 80 - index,
          category: 'commands',
        })),
        activity: [
          {
            kind: 'run',
            id: 'failed-group',
            status: 'done',
            count: 6,
            failed: 2,
            earlier: 0,
            line: '6 tool calls',
            code: '',
            figure: '2 failed',
            since: null,
            title: '',
            label: '6 tool calls, 2 failed',
            mix: '6 run',
            steps: [
              {
                kind: 'step',
                id: 'failed-child',
                status: 'failed',
                line: 'Ran',
                code: 'exec',
                figure: 'failed',
                since: null,
                title: 'exec',
              },
              {
                kind: 'step',
                id: 'done-child',
                status: 'done',
                line: 'Ran',
                code: 'write_stdin',
                figure: '',
                since: null,
                title: 'write_stdin',
              },
            ],
          },
          {
            kind: 'message',
            messageKind: 'commentary',
            id: 'group-message',
            status: 'done',
            at: NOW,
            when: '2:31 PM',
            absolute: '2:31 PM',
            text: 'Finished.',
            summaryHtml: '<p>Finished.</p>',
            line: '',
            code: '',
            figure: '',
            since: null,
            title: '',
          },
        ],
      });
      payload.cards = [card];
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);
      await page.locator('#list .turn .head').click();
      await page.locator('#list .turn .actviewaction').click();
      await page.evaluate(SETTLED);
      const group = page.locator('#list .turn .actrow.run');
      assert.equal(
        (await group.textContent())?.replace(/\s+/g, ' ').trim(),
        '▸6 tool calls · 2 failed · 6 run',
        'the rendered failure count lost its literal separator',
      );
      assert.equal(
        await group.locator('.actglyph').textContent(),
        CARD_GLYPHS.disclosureClosed,
        'a failed child gives the settled group a failure glyph',
      );
      assert.equal(
        await group.locator('.actglyph').evaluate((node) => getComputedStyle(node).color),
        await group.locator('.actmix').evaluate((node) => getComputedStyle(node).color),
        'the settled group disclosure uses an outcome colour',
      );
      await group.click();
      assert.equal(await group.locator('.actglyph').textContent(), CARD_GLYPHS.disclosureOpen);
      assert.equal(await page.locator('#list .turn .actrow.step.failed .actglyph').textContent(), CARD_GLYPHS.failed);

      const anchor = page.locator('#list .turn .acttool');
      assert.match((await anchor.getAttribute('aria-label')) ?? '', /6 run, Show tool breakdown$/);
      await anchor.click();
      await page.evaluate(SETTLED);
      const measured = (await page.evaluate(`(() => {
      const pop = document.getElementById('chippop');
      const heads = [...pop.querySelectorAll('.chippopitemhead')];
      const first = heads[0];
      const label = first.querySelector('.chippoplabel').getBoundingClientRect();
      const value = first.querySelector('.chippopvalue').getBoundingClientRect();
      const box = pop.getBoundingClientRect();
      const selection = getSelection();
      const range = document.createRange();
      range.selectNodeContents(first.querySelector('.chippoplabel'));
      selection.removeAllRanges(); selection.addRange(range);
      return {
        heading: pop.querySelector('.chippophead').textContent,
        tools: pop.classList.contains('chippop-tools'),
        inside: box.left >= -1 && box.right <= innerWidth + 1,
        gap: Math.round(value.left - label.right),
        scrolls: pop.scrollHeight > pop.clientHeight,
        selected: selection.toString(),
      };
    })()`)) as { heading: string; tools: boolean; inside: boolean; gap: number; scrolls: boolean; selected: string };
      assert.deepEqual(measured, {
        heading: 'Recorded tool invocations',
        tools: true,
        inside: true,
        gap: measured.gap,
        scrolls: true,
        selected: 'raw_tool_00',
      });
      assert.ok(measured.gap > 0 && measured.gap <= 20, `the raw name and count are ${measured.gap}px apart`);
      const fonts = (await page.evaluate(`(() => ({
      body: getComputedStyle(document.body).fontFamily,
      heading: getComputedStyle(document.querySelector('#chippop .chippophead .chippoplabel')).fontFamily,
      rawName: getComputedStyle(document.querySelector('#chippop .chippopitem .chippoplabel')).fontFamily,
    }))()`)) as { body: string; heading: string; rawName: string };
      assert.equal(fonts.heading, fonts.body, 'the tool detail heading uses the editor face');
      assert.notEqual(fonts.rawName, fonts.heading, 'raw tool names do not use the editor face');
      const updated = { ...card, activityName: `${card.activityName}, refreshed` };
      await page.evaluate(
        `window.postMessage(${JSON.stringify({ type: 'activity', session: card.sessionId, card: updated })}, '*')`,
      );
      await page.evaluate(SETTLED);
      assert.equal(
        await page.evaluate('getSelection().toString()'),
        'raw_tool_00',
        'an unrelated card update rebuilt the open detail and lost its text selection',
      );
      await page.keyboard.press('Escape');
      assert.equal(
        await anchor.evaluate((node) => node === document.activeElement),
        true,
        'Escape did not return focus to the tool summary',
      );
      await anchor.click();
      await page.evaluate(`document.querySelector('#list .turn .head').click()`);
      await page.evaluate(SETTLED);
      assert.equal(
        await page.locator('#chippop').evaluate((node: HTMLElement) => node.hidden),
        true,
        'the tool detail stayed open after its ancestor disclosure hid the anchor',
      );
    } finally {
      await browser.close();
    }
  },
);

test('a capped long log keeps every message and empty run inside the narrow card', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no browser installed');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 340, height: 900 });
    await page.setContent(pageHtml());
    const source = turn({ stepCount: 399, stepKinds: Array(399).fill('commands'), summary: 'Closing response' });
    let before = 0;
    for (let n = 0; n < 129; n++) {
      before += n < 39 ? 4 : n < 100 ? 3 : n === 100 ? 4 : 2;
      if (n < 126)
        source.updates.push({
          sourceId: `message-${n}`,
          text: `Narration ${n + 1}.`,
          kind: 'commentary',
          status: 'done',
          at: NOW - 399 + before,
          stepsBefore: before,
        });
      else if (n === 126)
        source.answers.push({ text: 'An earlier reply.', at: NOW - 399 + before, stepsBefore: before });
      else if (n === 127)
        source.laterPrompts.push({ text: 'Keep the tests green.', at: NOW - 399 + before, stepsBefore: before });
    }
    source.steps = Array.from({ length: 60 }, (_, n) => ({
      ordinal: n + 340,
      name: 'Bash',
      detail: 'npm test',
      at: NOW - 60 + n,
      status: 'done',
    }));
    const log = logOf(source, null, false, NOW);
    const payload = renderPayload() as { cards: Record<string, unknown>[] };
    payload.cards[0].activity = log.rows.map((row) =>
      row.kind === 'message' ? { ...row, summaryHtml: renderRichMarkdown(row.text!) } : row,
    );
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
    await page.click('#list .turn .head');
    await page.evaluate(SETTLED);
    const seen = (await page.evaluate(`(() => {
      const card = document.querySelector('#list .turn');
      const box = card.getBoundingClientRect();
      const log = card.querySelector('.actlist');
      const empty = [...log.querySelectorAll('.actrow.earlier')];
      return {
        messages: log.querySelectorAll('.actrow.message').length,
        replies: log.querySelectorAll('.actrow.answer').length,
        prompts: log.querySelectorAll('.actrow.ask').length,
        empty: empty.length,
        interactiveEmpty: empty.some(row => row.tagName === 'BUTTON' || row.hasAttribute('aria-expanded') || row.querySelector('.actglyph').textContent),
        footerNotes: [...log.querySelectorAll('.actmore')].filter(row => !row.closest('.actrows')).length,
        overflow: [...log.querySelectorAll('.actrow')].filter(row => !row.closest('[hidden]')).filter(row => {
          const r = row.getBoundingClientRect(); return r.right > box.right + 1 || r.left < box.left - 1;
        }).map(row => row.textContent),
        narrationTabs: [...log.querySelectorAll('.message')].filter(row => row.hasAttribute('tabindex')).length,
      };
    })()`)) as {
      messages: number;
      replies: number;
      prompts: number;
      empty: number;
      interactiveEmpty: boolean;
      footerNotes: number;
      overflow: string[];
      narrationTabs: number;
    };
    assert.deepEqual(seen, {
      messages: 127,
      replies: 1,
      prompts: 1,
      empty: 100,
      interactiveEmpty: false,
      footerNotes: 0,
      overflow: [],
      narrationTabs: 0,
    });
  } finally {
    await browser.close();
  }
});

test('shortened reasoning opens its full text from the keyboard', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no browser installed');
    return;
  }
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(3000);
    await page.setContent(pageHtml());
    const payload = renderPayload() as { cards: Array<Record<string, unknown>> };
    const text = 'The complete reasoning summary must remain reachable. '.repeat(20);
    payload.cards[0].activity = logOf(
      turn({
        updates: [{ sourceId: 'long-reason', kind: 'reasoning', text, at: NOW, status: 'done', stepsBefore: 0 }],
      }),
      null,
      false,
      NOW,
    ).rows;
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
    await page.click('#list .turn .head');
    await page.evaluate(SETTLED);
    const row = page.locator('#list .turn button.actrow.reasoning');
    assert.equal(await row.count(), 1, 'shortened reasoning has no keyboard disclosure');
    await row.focus();
    await page.keyboard.press('Enter');
    assert.equal(await row.getAttribute('aria-expanded'), 'true');
    const detail = page.locator(`[id="${await row.getAttribute('aria-controls')}"]`);
    assert.equal(await detail.isVisible(), true);
    assert.equal(await detail.textContent(), text);
    await page.keyboard.press('Escape');
    assert.equal(await row.getAttribute('aria-expanded'), 'false');
    assert.equal(await row.evaluate((node) => node === document.activeElement), true);
  } finally {
    await browser.close();
  }
});

test(
  'a standalone command keeps focus and expanded text when a later call groups it',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no browser installed');
      return;
    }
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(3000);
      await page.setContent(pageHtml());
      const payload = renderPayload() as { cards: Array<Record<string, unknown> & { sessionId: string }> };
      const card = payload.cards[0];
      const exact = 'npm test -- ' + 'long-command-argument '.repeat(20);
      const first = {
        ordinal: 1,
        name: 'Bash',
        detail: 'npm test ...',
        fullDetail: exact,
        at: NOW - 2,
        status: 'done' as const,
      };
      const source = turn({ stepCount: 1, stepKinds: ['commands'], steps: [first] });
      card.activity = logOf(source, null, true, NOW).rows;
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);
      await page.click('#list .turn .head');
      const command = page.locator('#list .turn button[data-logrow="step:1"]');
      await command.focus();
      await page.keyboard.press('Enter');
      assert.equal(await command.getAttribute('aria-expanded'), 'true');
      card.activity = logOf(
        {
          ...source,
          stepCount: 2,
          stepKinds: ['commands', 'commands'],
          steps: [first, { ...first, ordinal: 2, detail: 'git status', fullDetail: 'git status', at: NOW - 1 }],
        },
        null,
        true,
        NOW,
      ).rows;
      await page.evaluate(
        `window.postMessage(${JSON.stringify({ type: 'activity', session: card.sessionId, card })}, '*')`,
      );
      await page.evaluate(SETTLED);
      assert.equal(
        await command.evaluate((node) => node === document.activeElement),
        true,
        'regrouping lost keyboard focus',
      );
      assert.equal(await command.getAttribute('aria-expanded'), 'true', 'regrouping lost the expanded command');
      assert.equal(await page.locator('#list .turn button.actrow.run').getAttribute('aria-expanded'), 'true');
      const detail = page.locator(`[id="${await command.getAttribute('aria-controls')}"]`);
      assert.equal(await detail.isVisible(), true);
      assert.equal(await detail.textContent(), exact);
    } finally {
      await browser.close();
    }
  },
);

test(
  'retaining newer activity moves focus from an evicted command to a surviving row',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no browser installed');
      return;
    }
    try {
      const page = await browser.newPage();
      await page.setContent(pageHtml());
      const payload = renderPayload() as { cards: Array<Record<string, unknown> & { sessionId: string }> };
      const card = payload.cards[0];
      const source = turn({
        stepCount: 2,
        stepKinds: ['commands', 'commands'],
        steps: [1, 2].map((ordinal) => ({
          ordinal,
          name: 'Bash',
          detail: 'npm ...',
          fullDetail: `npm test -- command-${ordinal}`,
          at: NOW - 3 + ordinal,
          status: 'running' as const,
        })),
      });
      card.activity = logOf(source, null, true, NOW).rows;
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);
      await page.click('#list .turn .head');
      await page.focus('#list .turn button[data-logrow="step:1"]');
      card.activity = logOf({ ...source, steps: source.steps.slice(1) }, null, true, NOW).rows;
      await page.evaluate(
        `window.postMessage(${JSON.stringify({ type: 'activity', session: card.sessionId, card })}, '*')`,
      );
      await page.evaluate(SETTLED);
      assert.equal(await page.evaluate(`document.activeElement.dataset.logrow`), 'run:1');
      assert.equal(await page.locator('#list .turn button.actrow.run').getAttribute('tabindex'), '0');
    } finally {
      await browser.close();
    }
  },
);

test(
  'runs fold when calls finish while manual choices and nested keyboard focus survive',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no browser installed');
      return;
    }
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(5000);
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(String(error)));
      await page.setViewportSize({ width: 340, height: 900 });
      await page.setContent(pageHtml());
      const payload = renderPayload() as { cards: Array<Record<string, unknown> & { key: string; sessionId: string }> };
      const card = payload.cards[0];
      const source = turn({
        stepCount: 8,
        stepKinds: Array(8).fill('commands'),
        failedOrdinals: [1],
        steps: Array.from({ length: 5 }, (_, n) => ({
          ordinal: n + 4,
          name: 'Bash',
          detail: 'npm test -- a-long-argument-that-cannot-fit-in-a-narrow-column',
          at: NOW - 5 + n,
          status: n === 4 ? 'running' : 'done',
        })),
      });
      const running = logOf(source, null, true, NOW).rows;
      card.activity = running;
      const send = async (activity: unknown) => {
        card.activity = activity;
        await page.evaluate(
          `window.postMessage(${JSON.stringify({ type: 'activity', session: card.sessionId, card })}, '*')`,
        );
        await page.evaluate(SETTLED);
      };
      const run = '#list .turn button.actrow.run';
      const line = '#list .turn .actrows button[data-logrow]';
      const word = '#list .turn .activitysec .actword';
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);
      await page.click('#list .turn .head');
      await page.evaluate(SETTLED);
      assert.equal(await page.getAttribute(run, 'aria-expanded'), 'true');
      assert.match((await page.getAttribute(run, 'aria-label'))!, /8 tool calls, 1 failed, running, 3 earlier, 8 run/);
      const stopped = logOf(source, null, false, NOW).rows;
      await send(stopped);
      assert.equal(await page.getAttribute(run, 'aria-expanded'), 'false');
      await page.click(run);
      await send(running);
      await send(stopped);
      assert.equal(await page.getAttribute(run, 'aria-expanded'), 'true', 'a manual opening was lost');
      await page.focus(run);
      await page.keyboard.press('Escape');
      assert.equal(await page.getAttribute(run, 'aria-expanded'), 'false');
      assert.equal(await page.evaluate(`document.activeElement.matches('button.actrow.run')`), true);

      // Reloading creates a card without retained run-disclosure choices.
      await page.goto('about:blank');
      await page.setContent(pageHtml());
      card.activity = running;
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);
      await page.click('#list .turn .head');
      await page.evaluate(SETTLED);
      await page.focus(line);
      await send(stopped);
      assert.equal(await page.getAttribute(run, 'aria-expanded'), 'true', 'completion folded the focused rows');
      const figuresInside = await page.evaluate(`(() => {
      const right = document.querySelector('#list .turn').getBoundingClientRect().right;
      return [...document.querySelectorAll('#list .turn .actrows .actfig')].every(node => node.getBoundingClientRect().right <= right + 1);
    })()`);
      assert.equal(figuresInside, true);
      await page.keyboard.press('Enter');
      await page.evaluate(SETTLED);
      assert.equal(await page.getAttribute(line, 'aria-expanded'), 'true');
      await page.keyboard.press('Escape');
      assert.equal(await page.getAttribute(line, 'aria-expanded'), 'false');
      await page.keyboard.press('ArrowDown');
      const focusedId = await page.evaluate(`document.activeElement.dataset.logrow`);
      await send(stopped);
      assert.equal(await page.evaluate(`document.activeElement.dataset.logrow`), focusedId);
      await page.keyboard.press('End');
      const last = await page.evaluate(`document.activeElement.dataset.logrow`);
      await page.keyboard.press('ArrowDown');
      assert.equal(await page.evaluate(`document.activeElement.dataset.logrow`), last);
      await page.keyboard.press('Home');
      assert.equal(await page.evaluate(`document.activeElement.matches('button.actrow.run')`), true);
      await page.keyboard.press('ArrowUp');
      assert.equal(await page.evaluate(`document.activeElement.matches('button.actrow.run')`), true);
      await page.evaluate(SETTLED);
      assert.equal(
        await page.getAttribute(run, 'aria-expanded'),
        'false',
        'completion did not fold after focus left the rows',
      );
      assert.equal(
        await page.evaluate(
          `document.querySelectorAll('#list .turn .actlist button[data-logrow][tabindex="0"]').length`,
        ),
        1,
      );
      await page.evaluate(`document.querySelector(${JSON.stringify(word)}).click()`);
      await page.evaluate(SETTLED);
      assert.equal(await page.evaluate(`document.activeElement.matches('.activitysec .actword')`), true);
      assert.deepEqual(failures, []);
    } finally {
      await browser.close();
    }
  },
);
test('the log fits the card at both widths, and its rows stay one line each', { timeout: 60_000 }, async (t) => {
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

    for (const width of [1350, 340]) {
      const shut = await layoutAt(page, width);
      // A closed card's Activity rows occupy no layout height.

      for (const row of shut.actrows) {
        assert.equal(row.bottom - row.top, 0, `a shut card lays out its log rows at ${width}px`);
      }

      // Open the card and open Activity if its disclosure is closed.

      await page.evaluate(`(() => {
        document.querySelector('#list .turn .head').click();
        const head = document.querySelector('#list .turn .activitysec .actword');
        if (head && head.getAttribute('aria-expanded') === 'false') head.click();
      })()`);
      await page.evaluate(SETTLED);
      const open = (await page.evaluate(MEASURE)) as Laid;
      assert.deepEqual(failures, [], 'the panel threw while drawing the log');
      // Count Activity rows on the opened card independently of other fixture cards.

      const opened = (await page.evaluate(
        `document.querySelector('#list .turn').querySelectorAll('.actrow').length`,
      )) as number;
      assert.equal(opened, 7, `the card drew ${opened} of its four steps and one mid-turn prompt at ${width}px`);
      assert.ok(open.card);

      for (const row of open.actrows) {
        if (!row.bottom && !row.top) {
          continue;
        }
        // The fixture includes an unbroken path to exercise row shrinking.

        assert.ok(
          row.right <= open.card.right + 1 && row.left >= open.card.left - 1,
          `at ${width}px a log row runs wider than the card it sits in`,
        );
        // Activity rows stay within the single-line height bound.

        assert.ok(
          row.bottom - row.top < 34,
          `a log row is ${Math.round(row.bottom - row.top)}px tall at ${width}px, so its line wrapped`,
        );
      }
      assert.ok(
        open.documentWidth <= open.viewportWidth + 1,
        `the log scrolls the panel sideways at ${width}px: ${open.documentWidth} wide in ${open.viewportWidth}`,
      );
      // Close the card before measuring the next width.
      await page.evaluate(`document.querySelector('#list .turn .head').click()`);
      await page.evaluate(SETTLED);
    }
  } finally {
    await browser.close();
  }
});

test(
  'a cut command opens its exact text and narration keeps its timestamp at both widths',
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
      const payload = renderPayload() as {
        cards: { activity: { kind: string; code: string; line: string; title?: string; name?: string }[] }[];
      };
      payload.cards[0].activity = flatLog(payload.cards[0].activity) as (typeof payload.cards)[0]['activity'];
      const command = payload.cards[0].activity.find((row) => row.code.startsWith('npm test'));
      assert.ok(command, 'the browser fixture has no command row');
      const exact = `npm test -- ${LONG_PATH}\nnode --test extension/src/turncard.test.ts`;
      command.title = exact;
      command.name = `Ran the focused checks: ${exact} done`;
      const shortCommand = { ...command, sourceId: 'layout-short-command', code: 'git status', title: 'git status' };
      payload.cards[0].activity.push(shortCommand);
      const narration = {
        kind: 'message',
        messageKind: 'commentary',
        id: 'layout-commentary',
        status: 'done',
        line: '',
        text: 'The public docs do not describe the usage-bar refresh behavior or explain the reset mismatch.',
        summaryHtml:
          '<p>The public docs do not describe the usage-bar refresh behavior or explain the reset mismatch.</p>',
        absolute: '2:31 PM',
        code: '',
        figure: '',
        since: null,
        title: 'The public docs do not describe the usage-bar refresh behavior or explain the reset mismatch.',
        name: 'Commentary: The public docs do not describe the usage-bar refresh behavior or explain the reset mismatch.',
      };
      payload.cards[0].activity.push(narration);

      for (const width of [1350, 340]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
        await page.evaluate(SETTLED);
        await page.click('#list .turn .head');
        await page.evaluate(SETTLED);
        const seen = (await page.evaluate(`(() => {
        const rows = [...document.querySelectorAll('#list .turn .actrow')];
        const command = rows.find(function (row) {
          const code = row.querySelector('.actcode');
          return code && code.textContent.startsWith('npm test');
        });
        const commandCode = command.querySelector('.actcode');
        const shortCommand = rows.find(function (row) {
          const code = row.querySelector('.actcode');
          return code && code.textContent === 'git status';
        });
        const shortCode = shortCommand.querySelector('.actcode');
        const shortText = document.createRange();
        shortText.selectNodeContents(shortCode);
        const narration = rows.find(function (row) { return row.classList.contains('commentary'); });
        const card = document.querySelector('#list .turn');
        const cardBox = card.getBoundingClientRect();
        return {
          commandTitle: command.nextElementSibling.textContent, commandName: command.getAttribute('aria-label'),
          narrationTitle: narration.title, narrationName: narration.querySelector('.saidtext').textContent,
          commandGlyph: command.querySelector('.actglyph').textContent,
          narrationGlyph: narration.querySelector('.actglyph').textContent,
          shortCommandWidth: shortCode.getBoundingClientRect().width,
          shortTextWidth: shortText.getBoundingClientRect().width,
          longCommandWidth: commandCode.clientWidth,
          longCommandContentWidth: commandCode.scrollWidth,
          longCommandRight: commandCode.getBoundingClientRect().right,
          longRowRight: command.getBoundingClientRect().right,
          cardLeft: cardBox.left, cardRight: cardBox.right,
          documentWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth,
        };
      })()`)) as {
          commandTitle: string;
          commandName: string;
          narrationTitle: string;
          narrationName: string;
          commandGlyph: string;
          narrationGlyph: string;
          shortCommandWidth: number;
          shortTextWidth: number;
          longCommandWidth: number;
          longCommandContentWidth: number;
          longCommandRight: number;
          longRowRight: number;
          cardLeft: number;
          cardRight: number;
          documentWidth: number;
          viewportWidth: number;
        };
        assert.equal(seen.commandTitle, exact);
        assert.ok(seen.commandName.includes(exact), 'the shortened command has no accessible copy of its full text');
        assert.equal(seen.narrationTitle, narration.absolute);
        assert.equal(
          seen.narrationName,
          narration.text,
          'the shortened narration has no accessible copy of its full text',
        );
        assert.notEqual(seen.commandGlyph, '');
        assert.equal(seen.narrationGlyph, '');
        assert.ok(
          Math.abs(seen.shortCommandWidth - seen.shortTextWidth) <= 1,
          `the short command background is ${Math.round(seen.shortCommandWidth)}px wide around ` +
            `${Math.round(seen.shortTextWidth)}px of text at ${width}px`,
        );
        assert.ok(
          seen.longCommandRight <= seen.longRowRight + 1,
          `the long command runs outside its activity row at ${width}px`,
        );
        if (width === 340) {
          assert.ok(
            seen.longCommandContentWidth > seen.longCommandWidth + 1,
            'the long command is not clipped at the narrow width',
          );
        }
        assert.ok(
          seen.documentWidth <= seen.viewportWidth + 1,
          `activity tooltips scroll the panel sideways at ${width}px`,
        );
        assert.deepEqual(failures, [], 'the panel threw while drawing activity tooltips');
        await page.click('#list .turn .head');
        await page.evaluate(SETTLED);
      }
    } finally {
      await browser.close();
    }
  },
);

test(
  'activity defaults and reader choices stay synchronized through activity updates',
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
      const payload = renderPayload() as {
        cards: Array<
          Record<string, unknown> & {
            key: string;
            sessionId: string;
            activity: Array<Record<string, unknown>>;
          }
        >;
      };
      const card = payload.cards[0];
      const titled = {
        ...flatLog(card.activity)[0],
        sourceId: 'activity-accessible-row',
        line: 'Ran the focused checks...',
        code: 'npm test...',
        title: 'npm test -- --runInBand',
        name: 'Ran the focused checks: npm test -- --runInBand done',
      };
      card.activity = [titled];
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);
      await page.click('#list .turn .head');
      await page.evaluate(SETTLED);

      const READ = `(() => {
      const activity = document.querySelector('#list .turn .activitysec .actword');
      const list = document.querySelector('#list .turn .actlist');
      const viewState = document.querySelector('#list .turn .actviewstate');
      const viewAction = document.querySelector('#list .turn .actviewaction');
      const titled = [...document.querySelectorAll('#list .turn .actrow')]
        .find((row) => row.dataset.logrow === 'activity-accessible-row');
      return {
        activityExpanded: activity.getAttribute('aria-expanded'),
        listHidden: list.hidden,
        listId: list.id,
        activityControls: activity.getAttribute('aria-controls'),
        viewState: viewState.textContent,
        viewAction: viewAction.textContent,
        rowName: titled && titled.getAttribute('aria-label'),
        rowTabIndex: titled && titled.tabIndex,
      };
    })()`;
      interface ActivityReading {
        activityExpanded: string;
        listHidden: boolean;
        listId: string;
        activityControls: string;
        viewState: string;
        viewAction: string;
        rowName: string | null;
        rowTabIndex: number | null;
      }
      const initial = (await page.evaluate(READ)) as ActivityReading;
      assert.equal(initial.activityExpanded, 'true', 'a running activity log did not use its open default');
      assert.equal(initial.listHidden, false);
      assert.equal(initial.activityControls, initial.listId);
      assert.equal(initial.viewState, CARD_ACTIONS.logAllActivity);
      assert.equal(initial.viewAction, CARD_ACTIONS.logShowMessagesOnly);
      assert.equal(initial.rowName, titled.name);
      assert.equal(initial.rowTabIndex, 0, 'a shortened activity row with detail is not keyboard reachable');

      const finished = { ...card, status: 'done' };
      await page.evaluate(
        `window.postMessage(${JSON.stringify({
          type: 'activity',
          session: card.sessionId,
          card: finished,
        })}, '*')`,
      );
      await page.evaluate(SETTLED);
      const defaulted = (await page.evaluate(READ)) as ActivityReading;
      assert.equal(defaulted.activityExpanded, 'true', 'finishing the turn shut its Activity log');
      assert.equal(defaulted.listHidden, false);
      assert.equal(defaulted.viewState, CARD_ACTIONS.logMessagesView);
      assert.equal(defaulted.viewAction, CARD_ACTIONS.logShowAllActivity);
      assert.equal(defaulted.rowName, null, 'the done default kept a tool row in the messages-only view');

      await page.click('#list .turn .actviewaction');
      await page.evaluate(SETTLED);
      const chosen = (await page.evaluate(READ)) as ActivityReading;
      assert.equal(chosen.activityExpanded, 'true');
      assert.equal(chosen.listHidden, false);
      assert.equal(chosen.viewState, CARD_ACTIONS.logAllActivity);
      assert.equal(chosen.viewAction, CARD_ACTIONS.logShowMessagesOnly);
      assert.equal(chosen.rowName, titled.name);

      const updated = {
        ...finished,
        activity: [
          ...finished.activity,
          {
            ...flatLog(finished.activity)[0],
            sourceId: 'activity-after-choice',
            line: 'Updated after the reader chose',
          },
        ],
      };
      await page.evaluate(
        `window.postMessage(${JSON.stringify({
          type: 'activity',
          session: card.sessionId,
          card: updated,
        })}, '*')`,
      );
      await page.evaluate(SETTLED);
      const held = (await page.evaluate(READ)) as ActivityReading;
      assert.equal(held.activityExpanded, 'true', 'the activity update overruled the reader open choice');
      assert.equal(held.listHidden, false);
      assert.equal(
        held.viewState,
        CARD_ACTIONS.logAllActivity,
        'the activity update overruled the reader filter choice',
      );
      assert.equal(held.viewAction, CARD_ACTIONS.logShowMessagesOnly);
      assert.deepEqual(failures, [], 'the panel threw while updating card-local activity state');
    } finally {
      await browser.close();
    }
  },
);

test('card disclosure controls own unique targets inside their card', { timeout: 60_000 }, async (t) => {
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
    await page.evaluate(`window.postMessage(${JSON.stringify(renderPayload())}, '*')`);
    await page.evaluate(SETTLED);
    const read = (await page.evaluate(`(() => {
      const controls = [...document.querySelectorAll(
        '#list .turn .head[aria-controls], #list .turn .activitysec .actword[aria-controls], '
        + '#list .compaction .head[aria-controls]'
      )];
      return controls.map((control) => {
        const id = control.getAttribute('aria-controls');
        const card = control.closest('.turn, .compaction');
        const targets = id ? [...document.querySelectorAll('[id]')].filter((node) => node.id === id) : [];
        return {
          id,
          targetCount: targets.length,
          targetInCard: targets.length === 1 && targets[0].closest('.turn, .compaction') === card,
        };
      });
    })()`)) as Array<{ id: string | null; targetCount: number; targetInCard: boolean }>;
    assert.ok(read.length > 3, 'the fixture did not draw disclosures across multiple cards');
    assert.equal(
      new Set(read.map((entry) => entry.id)).size,
      read.length,
      'two card controls share the same disclosure target',
    );
    assert.ok(
      read.every((entry) => entry.targetCount === 1 && entry.targetInCard),
      'a card control does not own exactly one target inside its wrapper',
    );
    assert.deepEqual(failures, [], 'the panel threw while drawing card disclosure targets');
  } finally {
    await browser.close();
  }
});

test('a summary update replaces its delegated link handler', { timeout: 60_000 }, async (t) => {
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
    const payload = renderPayload() as {
      cards: Array<Record<string, unknown> & { key: string; sessionId: string }>;
    };
    const card = payload.cards[0];
    card.summaryHtml = '<p><a data-link="first.txt">first</a></p>';
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
    await page.click('#list .turn .head');
    const updated = { ...card, summaryHtml: '<p><a data-link="second.txt">second</a></p>' };
    await page.evaluate(
      `window.postMessage(${JSON.stringify({
        type: 'activity',
        session: card.sessionId,
        card: updated,
      })}, '*')`,
    );
    await page.evaluate(SETTLED);
    await page.click('#list .turn .summary a[data-link]');
    const messages = (await page.evaluate(
      `window.__posted.filter((message) => message.type === 'openLink')`,
    )) as Array<{ href: string }>;
    assert.deepEqual(
      messages.map((message) => message.href),
      ['second.txt'],
      'one click after a summary update posted more than one openLink message',
    );
    assert.deepEqual(failures, [], 'the panel threw while replacing a summary link handler');
  } finally {
    await browser.close();
  }
});

test('a card with no body is not exposed as an empty disclosure', { timeout: 60_000 }, async (t) => {
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
    const payload = renderPayload() as { cards: Array<Record<string, unknown> & { key: string }> };
    const card = payload.cards[0];
    Object.assign(card, {
      prompt: '',
      summary: '',
      summaryHtml: '',
      earlierAnswers: [],
      laterPrompts: [],
      activity: [],
      files: [],
      agents: [],
      commits: [],
      errorText: null,
    });
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
    const read = (await page.evaluate(`(() => {
      const card = [...document.querySelectorAll('#list .turn')]
        .find((node) => node.dataset.key === ${JSON.stringify(card.key)});
      const head = card.querySelector('.head');
      const body = card.querySelector('.body');
      return {
        hasBody: card.classList.contains('has-body'),
        headTag: head.tagName,
        staticHead: head.classList.contains('statichead'),
        control: head.dataset.control || null,
        expanded: head.getAttribute('aria-expanded'),
        bodyHidden: body.hidden,
        bodyHeight: body.getBoundingClientRect().height,
      };
    })()`)) as {
      hasBody: boolean;
      headTag: string;
      staticHead: boolean;
      control: string | null;
      expanded: string | null;
      bodyHidden: boolean;
      bodyHeight: number;
    };
    assert.equal(read.hasBody, false);
    assert.equal(read.headTag, 'SPAN', 'a bodyless card head is static text with nothing to open');
    assert.equal(read.staticHead, true);
    assert.equal(read.control, null);
    assert.equal(read.expanded, null);
    assert.equal(read.bodyHidden, true);
    assert.equal(read.bodyHeight, 0);
    assert.deepEqual(failures, [], 'the panel threw while drawing a bodyless card');
  } finally {
    await browser.close();
  }
});

test('a live activity update keeps the reader at the same place in a long log', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (e) => failures.push(String(e)));
    await page.setViewportSize({ width: 900, height: 500 });
    await page.setContent(pageHtml());
    const payload = renderPayload() as {
      cards: Array<
        Record<string, unknown> & {
          key: string;
          sessionId: string;
          activity: Array<Record<string, unknown>>;
        }
      >;
    };
    const card = payload.cards[0];
    const row = flatLog(card.activity)[0];
    card.activity = Array.from({ length: 80 }, (_, index) => ({
      ...row,
      sourceId: `long-activity-${index}`,
      line: `Activity row ${String(index + 1).padStart(2, '0')}`,
      code: '',
      title: '',
    }));
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
    await page.click('#list .turn .head');
    await page.evaluate(SETTLED);
    const before = (await page.evaluate(`(() => {
      const row = document.querySelectorAll('#list .turn .actrow')[55];
      row.scrollIntoView({ block: 'start' });
      return { scroll: document.scrollingElement.scrollTop, top: row.getBoundingClientRect().top };
    })()`)) as { scroll: number; top: number };
    const updated = {
      ...card,
      activity: [
        ...card.activity,
        {
          ...row,
          sourceId: 'long-activity-new',
          line: 'Activity row 81',
          code: '',
          title: '',
        },
      ],
    };
    await page.evaluate(
      `window.postMessage(${JSON.stringify({
        type: 'activity',
        session: card.sessionId,
        card: updated,
      })}, '*')`,
    );
    await page.evaluate(SETTLED);
    const after = (await page.evaluate(`(() => {
      const row = document.querySelectorAll('#list .turn .actrow')[55];
      return { scroll: document.scrollingElement.scrollTop, top: row.getBoundingClientRect().top };
    })()`)) as { scroll: number; top: number };
    assert.ok(
      Math.abs(after.scroll - before.scroll) <= 1,
      `the activity update moved document scroll from ${before.scroll} to ${after.scroll}`,
    );
    assert.ok(
      Math.abs(after.top - before.top) <= 1,
      `the activity update moved the visible row from ${before.top}px to ${after.top}px`,
    );
    assert.deepEqual(failures, [], 'the panel threw while updating the long activity log');
  } finally {
    await browser.close();
  }
});

test(
  "background updates leave a long agent question at the reader's scroll position",
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
      await page.setViewportSize({ width: 900, height: 400 });
      await page.setContent(pageHtml());
      const payload = renderPayload([], [LIVE_PRESS], [], [], [QUESTION_ASK]) as {
        usage: {
          bar: Record<string, unknown>;
          composer: { live: Array<Record<string, unknown>> };
        };
      } & Record<string, unknown>;
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);

      const usage = JSON.parse(JSON.stringify(payload.usage)) as typeof payload.usage;
      usage.bar.age = '1m ago';
      usage.bar.read = 'Read limits again, last read 1m ago';
      usage.bar.name = `${String(usage.bar.name)} Last read 1m ago.`;
      const refreshed = JSON.parse(JSON.stringify(payload)) as typeof payload;
      refreshed.usage.composer.live[0].relative = '1m ago';
      const steps = [
        { name: 'usage', message: { type: 'usage', usage } },
        { name: 'render', message: refreshed },
      ];
      const moved: string[] = [];
      for (const step of steps) {
        const before = (await page.evaluate(`(() => {
        const questions = document.querySelector('.casks');
        if (!questions) return null;
        window.__heldQuestionRoot = questions;
        questions.scrollTop = Math.round((questions.scrollHeight - questions.clientHeight) / 2);
        return {
          top: questions.scrollTop,
          maximum: questions.scrollHeight - questions.clientHeight,
        };
      })()`)) as { top: number; maximum: number } | null;
        assert.ok(
          before && before.maximum > 40 && before.top > 20,
          `the question list is too short for a ${step.name} update to measure anything`,
        );
        await page.evaluate(`window.postMessage(${JSON.stringify(step.message)}, '*')`);
        await page.evaluate(SETTLED);
        const after = (await page.evaluate(`(() => {
        const questions = document.querySelector('.casks');
        return { top: questions?.scrollTop, same: questions === window.__heldQuestionRoot };
      })()`)) as { top: number | undefined; same: boolean };
        if (after.top === undefined || Math.abs(after.top - before.top) > 1) {
          moved.push(`${step.name} moved the question from ${before.top} to ${String(after.top)}`);
        }
        assert.equal(after.same, true, `${step.name} replaced the request component for unrelated state`);
      }
      assert.deepEqual(moved, [], `a background update reset the question scroll: ${moved.join('; ')}`);

      await page.evaluate(`document.querySelector('.casks').scrollTop = 70`);
      const replacement = renderPayload(
        [],
        [LIVE_PRESS],
        [],
        [],
        [
          {
            ...QUESTION_ASK,
            id: 'replacement-question',
            toolUseId: 'replacement-question-tool',
          },
        ],
      );
      await page.evaluate(`window.postMessage(${JSON.stringify(replacement)}, '*')`);
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.evaluate(`({
      top: document.querySelector('.casks')?.scrollTop,
      same: document.querySelector('.casks') === window.__heldQuestionRoot,
    })`),
        { top: 0, same: true },
        'a changed request identity did not reset only the request-owned scroll state',
      );
      assert.deepEqual(failures, [], 'the panel threw while redrawing a scrolled agent question');
    } finally {
      await browser.close();
    }
  },
);

// Activity updates retain both card-local disclosure state and focused controls.

test('a live activity update leaves an expanded prompt expanded', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (e) => failures.push(String(e)));
    await page.setViewportSize({ width: 900, height: 700 });
    await page.setContent(pageHtml());
    const payload = renderPayload() as {
      cards: Array<
        Record<string, unknown> & {
          key: string;
          sessionId: string;
          prompt: string;
          activity: Array<Record<string, unknown>>;
        }
      >;
    };
    const card = payload.cards[0];
    // Below the response displays the You asked heading.
    Object.assign(payload, { timelineLayout: { cardLayout: 'compact', promptPosition: 'below' } });
    // The prompt exceeds the four-line clamp so its expansion control exists.

    card.prompt = Array.from(
      { length: 14 },
      (_, index) => `Prompt line ${index + 1} of the request the reader sent to open this turn.`,
    ).join('\n');
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
    await page.click('#list .turn .head');
    await page.evaluate(SETTLED);
    await page.evaluate(
      `(() => { const head = document.querySelector('#list .turn .activitysec .actword'); if (head.getAttribute('aria-expanded') === 'false') head.click(); })()`,
    );
    await page.evaluate(SETTLED);
    const READ = `(() => {
      const control = ${JSON.stringify(`more:${card.key}`)};
      const all = [...document.querySelectorAll('[data-control]')];
      const more = all.find((n) => n.dataset.control === control);
      if (!more) return null;
      const prompt = more.previousElementSibling;
      return {
        hidden: more.hidden, label: more.textContent,
        expanded: more.getAttribute('aria-expanded'),
        full: prompt.classList.contains('is-full'),
        height: Math.round(prompt.getBoundingClientRect().height),
      };
    })()`;
    type Shown = {
      hidden: boolean;
      label: string;
      expanded: string | null;
      full: boolean;
      height: number;
    };
    const shut = (await page.evaluate(READ)) as Shown | null;
    assert.ok(shut, 'the card drew no prompt disclosure, so this test pressed nothing');
    assert.equal(shut.hidden, false, 'the disclosure stayed hidden, so the prompt never overflowed');
    assert.equal(shut.full, false, 'the prompt opened unclamped, so there was nothing to expand');
    await page.evaluate(`document.querySelector('[data-control="prompts:${card.key}"]').click()`);
    await page.evaluate(SETTLED);
    const fromHeading = (await page.evaluate(READ)) as Shown;
    assert.equal(fromHeading.full, true, 'pressing You asked did not show the whole prompt');
    assert.ok(fromHeading.height > shut.height, 'the prompt opened from You asked is no taller than the clamped one');
    await page.evaluate(`document.querySelector('[data-control="prompts:${card.key}"]').click()`);
    await page.evaluate(SETTLED);
    await page.evaluate(`(() => {
      const control = ${JSON.stringify(`more:${card.key}`)};
      [...document.querySelectorAll('[data-control]')].find((n) => n.dataset.control === control).click();
    })()`);
    await page.evaluate(SETTLED);
    const before = (await page.evaluate(READ)) as Shown;
    assert.equal(before.full, true, 'the press did not expand the prompt, so this test measures nothing');
    assert.ok(before.height > shut.height, 'the expanded prompt is no taller than the clamped one');
    // Retain the wrapper and controls to compare node identity across the update.

    const stood = (await page.evaluate(`(() => {
      window.heldCard = document.querySelector('#list .turn');
      const control = ${JSON.stringify(`more:${card.key}`)};
      const more = [...document.querySelectorAll('[data-control]')].find((n) => n.dataset.control === control);
      window.heldPromptControl = more;
      window.heldActivityControl = document.querySelector('#list .turn .activitysec .actword');
      more.focus();
      return {
        holds: window.heldCard.contains(more),
        focus: document.activeElement === more,
        activity: window.heldActivityControl.getAttribute('aria-expanded'),
      };
    })()`)) as { holds: boolean; focus: boolean; activity: string | null };
    assert.equal(stood.holds, true, 'the held node is not the card under test, so the rebuild check means nothing');
    assert.equal(stood.focus, true, 'the reader could not be stood on the disclosure, so focus proves nothing');
    assert.equal(stood.activity, 'true', 'the reader did not open the activity disclosure before the update');
    const updated = {
      ...card,
      activity: [
        ...card.activity,
        {
          ...flatLog(card.activity)[0],
          sourceId: 'prompt-expansion-activity',
          line: 'One more step while the prompt is open',
          code: '',
          title: '',
        },
      ],
    };
    await page.evaluate(
      `window.postMessage(${JSON.stringify({
        type: 'activity',
        session: card.sessionId,
        card: updated,
      })}, '*')`,
    );
    await page.evaluate(SETTLED);
    const identity = (await page.evaluate(`(() => ({
      card: document.querySelector('#list .turn') === window.heldCard,
      prompt: [...document.querySelectorAll('[data-control]')].find((n) => n.dataset.control === ${JSON.stringify(`more:${card.key}`)}) === window.heldPromptControl,
      activity: document.querySelector('#list .turn .activitysec .actword') === window.heldActivityControl,
      activityExpanded: window.heldActivityControl.getAttribute('aria-expanded'),
      appended: [...document.querySelectorAll('#list .turn .actrow')].some((row) => row.textContent.includes('One more step while the prompt is open')),
    }))()`)) as {
      card: boolean;
      prompt: boolean;
      activity: boolean;
      activityExpanded: string | null;
      appended: boolean;
    };
    assert.equal(identity.appended, true, 'the activity update did not draw its new row');
    assert.equal(identity.card, true, 'the activity update replaced the list-owned card wrapper');
    assert.equal(identity.prompt, true, 'the activity update replaced the focused prompt disclosure');
    assert.equal(identity.activity, true, 'the activity update replaced the activity disclosure');
    assert.equal(identity.activityExpanded, 'true', 'the activity update shut the activity disclosure');
    const after = (await page.evaluate(READ)) as Shown | null;
    assert.ok(after, 'the activity update removed the prompt disclosure');
    assert.equal(after.full, true, 'the activity update collapsed the expanded prompt');
    assert.equal(
      after.label,
      before.label,
      `the activity update reset the disclosure from "${before.label}" to "${after.label}"`,
    );
    assert.ok(
      Math.abs(after.height - before.height) <= 1,
      `the activity update shortened the prompt from ${before.height}px to ${after.height}px`,
    );
    const held = (await page.evaluate('document.activeElement && document.activeElement.dataset.control')) as
      | string
      | null;
    assert.equal(
      held,
      `more:${card.key}`,
      `the activity update moved the reader off the disclosure to ${JSON.stringify(held)}`,
    );
    // Disclosure attributes also describe the retained open state.

    assert.equal(shut.expanded, 'false', 'the clamped disclosure does not say that it is shut');
    assert.equal(before.expanded, 'true', 'the expanded disclosure does not say that it is open');
    assert.equal(after.expanded, 'true', 'the updated disclosure says that it is shut');
    assert.deepEqual(failures, [], 'the panel threw while updating the card under an expanded prompt');
  } finally {
    await browser.close();
  }
});

test('the folded running card carries a line saying what the agent is on, and one line only', async (t) => {
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

    for (const width of [1350, 340]) {
      const laid = await layoutAt(page, width);
      assert.deepEqual(failures, [], 'the panel threw while drawing the line');
      assert.ok(laid.doing, `the newest turn is running and its card said nothing at ${width}px`);
      assert.ok(laid.card);
      assert.ok(
        laid.doing.right <= laid.card.right + 1 && laid.doing.left >= laid.card.left - 1,
        `at ${width}px the line runs wider than the card it sits on`,
      );
      assert.ok(
        laid.doing.bottom - laid.doing.top < 34,
        `the line is ${Math.round(laid.doing.bottom - laid.doing.top)}px tall at ${width}px, so it wrapped`,
      );

      // The folded Activity line includes an elapsed-time figure.

      const wording = (await page.evaluate(`(() => {
        const row = document.querySelector('#list .turn .doing');
        const parts = [':scope > .actverb', ':scope > .actcode', ':scope > .actfig']
          .map((selector) => row && row.querySelector(selector)?.textContent || '')
          .filter(Boolean);
        return { text: row ? row.textContent.replace(/\\s+/g, ' ').trim() : '', parts };
      })()`)) as { text: string; parts: string[] };
      const figure = wording.parts[2] ?? null;
      assert.ok(
        figure && /^\d/.test(figure),
        `the line's figure reads ${JSON.stringify(figure)} at ${width}px, so it never counts up`,
      );
      assert.ok(
        wording.text.includes(wording.parts.join(' ')),
        `the folded running status has no readable separation at ${width}px: ${JSON.stringify(wording)}`,
      );
    }
  } finally {
    await browser.close();
  }
});

test(
  'the turn head keeps latest activity and duration distinct at wide and sidebar widths',
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

      for (const width of [1350, 340]) {
        await layoutAt(page, width);
        const seen = (await page.evaluate(`(() => {
        const card = document.querySelector('#list .turn:not(.clive)');
        const head = card && card.querySelector('.head');
        const when = head && head.querySelector('.timing .when');
        const duration = head && head.querySelector('.timing .durationfact');
        const inside = (outer, inner) => {
          const a = outer.getBoundingClientRect();
          const b = inner.getBoundingClientRect();
          return b.left >= a.left - 1 && b.right <= a.right + 1
            && b.top >= a.top - 1 && b.bottom <= a.bottom + 1;
        };
        const a = when && when.getBoundingClientRect();
        const b = duration && duration.getBoundingClientRect();
        const headStyle = head && getComputedStyle(head);
        const whenStyle = when && getComputedStyle(when);
        const durationStyle = duration && getComputedStyle(duration);
        // Every run on the row, with the two time facts read one level down: the box holding
        // them can shrink below its own text, and the text then carries on across whatever
        // stands to the right of it.
        const runs = [when, duration, ...head.querySelectorAll(':scope > .agent, :scope > .model, :scope > .effort')]
          .filter(Boolean)
          .map((node) => ({ text: (node.textContent || '').replace(/s+/g, ' ').trim(), box: node.getBoundingClientRect() }));
        let painted = null;
        for (let i = 0; i < runs.length; i += 1) {
          for (let j = i + 1; j < runs.length; j += 1) {
            const a = runs[i].box;
            const b = runs[j].box;
            if (a.right > b.left + 0.5 && b.right > a.left + 0.5
              && a.bottom > b.top + 0.5 && b.bottom > a.top + 0.5) {
              painted = runs[i].text + ' over ' + runs[j].text;
            }
          }
        }
        return {
          painted,
          when: when ? when.textContent : '',
          duration: duration ? duration.textContent.replace(/s+/g, ' ').trim() : '',
          durationTitle: duration ? duration.title : '',
          gap: a && b ? b.left - a.right : -1,
          headFont: headStyle ? headStyle.fontSize : '',
          whenFont: whenStyle ? whenStyle.fontSize : '',
          durationFont: durationStyle ? durationStyle.fontSize : '',
          headColor: headStyle ? headStyle.color : '',
          whenColor: whenStyle ? whenStyle.color : '',
          inside: !!head && !!when && !!duration && inside(head, when) && inside(head, duration),
          cardInside: !!card && !!head && inside(card, head),
        };
      })()`)) as {
          when: string;
          duration: string;
          durationTitle: string;
          gap: number;
          headFont: string;
          whenFont: string;
          durationFont: string;
          headColor: string;
          whenColor: string;
          inside: boolean;
          cardInside: boolean;
          painted: string | null;
        };
        assert.deepEqual(failures, [], `the panel threw while drawing the timing at ${width}px`);
        assert.match(seen.when, /ago$/, `the first time is not latest activity at ${width}px`);
        assert.match(
          seen.duration,
          /^(ran in|running for) \d/,
          `the second time is not a complete duration phrase at ${width}px`,
        );
        assert.match(
          seen.durationTitle,
          /^Started /,
          `the duration hover does not reveal the start time at ${width}px`,
        );
        assert.ok(seen.gap >= 6, `the latest activity and duration run together at ${width}px`);
        assert.equal(
          seen.whenFont,
          seen.headFont,
          `the latest activity shrank from the original header size at ${width}px`,
        );
        assert.equal(
          seen.durationFont,
          seen.headFont,
          `the duration shrank from the original header size at ${width}px`,
        );
        assert.equal(
          seen.whenColor,
          seen.headColor,
          `the latest activity lost the original foreground colour at ${width}px`,
        );
        assert.equal(seen.inside, true, `a time fact runs outside the head row at ${width}px`);
        assert.equal(seen.cardInside, true, `the head row runs outside the turn card at ${width}px`);
        // The painted-text check detects overlapping head-row text.

        assert.equal(seen.painted, null, `the head row paints ${seen.painted} at ${width}px`);
      }
    } finally {
      await browser.close();
    }
  },
);

// File figures and detail headings use the same one-way line-count wording.
test('the head of a record spells a one-way line count the way the figure does', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 800, height: 600 });
    await page.setContent(themed(pageHtml(), 'dark'));
    const payload = renderPayload() as {
      cards: Array<
        Record<string, unknown> & {
          chips: Array<{
            metric?: string;
            removed?: number;
            detailList?: { heading?: { diff?: { removed: number } } };
          }>;
        }
      >;
    };
    // Remove the deleted count from an existing two-way file-count fixture.

    const card = payload.cards[LONG_TURN_INDEX];
    const files = card.chips.find((chip) => chip.metric === 'files');
    assert.ok(files?.detailList?.heading?.diff, 'the long turn drew no Files figure with a line count');
    files.removed = 0;
    files.detailList.heading.diff.removed = 0;
    payload.cards = [card];
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
    await page.evaluate(`document.querySelector('#list .turn .head').click()`);
    await page.evaluate(SETTLED);
    await page.locator('#list .turn .statchip[data-metric="files"]').click();
    await page.evaluate(SETTLED);
    const spelled = (await page.evaluate(`(() => {
      const text = (node) => (node?.textContent ?? '').replace(/\\s+/g, ' ').trim();
      const figure = document.querySelector('#list .turn .statchip[data-metric="files"] [aria-hidden="true"]');
      const head = document.getElementById('chippop').querySelector('.chippophead');
      return {
        figure: text(figure), head: text(head),
        added: head.querySelectorAll('.add').length, removed: head.querySelectorAll('.del').length,
      };
    })()`)) as { figure: string; head: string; added: number; removed: number };
    assert.equal(
      spelled.head,
      spelled.figure,
      `the record head reads ${spelled.head} under a figure reading ${spelled.figure}`,
    );
    assert.deepEqual(
      [spelled.added, spelled.removed],
      [1, 0],
      `the record head reads ${spelled.head}, so it drew a half for a count that moved nothing`,
    );
  } finally {
    await browser.close();
  }
});

// Partial file counts retain their explanation in turn and subagent details.

test('a floor files figure opens a record that says why its count is a floor', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1350, height: 900 });
    await page.setContent(themed(pageHtml(), 'dark'));
    const card = toCard(
      turn({
        files: [
          { path: 'c:/repo/src/kept.ts', added: 3, removed: 0, isNew: false, edits: [] },
          {
            path: 'c:/repo/src/written.ts',
            added: 0,
            removed: 0,
            isNew: false,
            edits: [],
            countsUnknown: true,
            unknownReason: 'write',
          },
        ],
        agents: [
          subagent({
            description: 'Rewrite the config',
            artifacts: {
              files: [
                {
                  path: 'c:/repo/src/shelled.ts',
                  added: 0,
                  removed: 0,
                  isNew: false,
                  countsUnknown: true,
                  unknownReason: 'shell',
                },
              ],
              commits: [],
              complete: true,
              revision: 'child-shell',
            },
          }),
        ],
      }),
      false,
      NOW,
      ['c:/repo'],
    );
    const payload = renderPayload() as {
      cards: unknown[];
      timelineLayout?: { cardLayout: string; promptPosition: string };
    };
    payload.cards = [card];
    // One column exposes the subagent rows and their file figures.
    payload.timelineLayout = { cardLayout: 'one-column', promptPosition: 'above' };
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
    const turnCard = page.locator('#list .turn').first();
    if ((await turnCard.locator('.body').getAttribute('hidden')) !== null) {
      await turnCard.locator('.head').click();
    }
    await page.evaluate(SETTLED);
    const words = (selector: string) =>
      page.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})]
      .filter((node) => node.checkVisibility()).map((node) => node.textContent.replace(/\\s+/g, ' ').trim())`) as Promise<
        string[]
      >;

    await turnCard.locator('.chips .statchip[data-metric="files"]').click();
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await words('#chippop .chippopfoot'),
      [
        '1 file was written whole, so its old lines are unknown.',
        '1 file was named by the shell without its lines, so its line counts are unknown.',
      ],
      "the turn's files record does not say why its count is a floor",
    );
    await page.keyboard.press('Escape');
    await page.evaluate(SETTLED);

    await turnCard.locator('.recordagents .agentrow .railstatchip[data-metric="files"]').click();
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await words('#chippopnested .chippopfoot, #chippop .chippopfoot'),
      ['1 file was named by the shell without its lines, so its line counts are unknown.'],
      "the subagent's files record does not say why its count is a floor",
    );
  } finally {
    await browser.close();
  }
});

// The commit fixture defaults to the main agent's branch in the card's repository.

function commitRow(sha: string, subject: string, at: number, over: Partial<CommitRowView> = {}): CommitRowView {
  return {
    kind: 'commit',
    key: `commit:${sha}`,
    sha,
    subject,
    dir: 'c:/repo',
    where: null,
    repository: { key: 'c:/repo/.git', name: 'repo', own: true },
    branch: 'main',
    headKind: 'branch',
    madeBySession: null,
    detail: subject,
    added: 4,
    removed: 1,
    at,
    absolute: '2:22 PM',
    ...over,
  };
}

// Set commit rows and add a branch fact only for a single commit group.

function withCommits(card: Record<string, unknown>, rows: CommitRowView[]): void {
  card.commits = rows;
  const chip = (card.chips as { metric?: string; detailList?: { heading: Record<string, unknown> } }[]).find(
    (one) => one.metric === 'commits',
  );
  assert.ok(chip?.detailList, 'the long turn drew no Commits chip');
  const heading = chip.detailList.heading;
  delete heading.fact;
  const grouping = groupCommitRows(rows);
  if (grouping.single) {
    heading.fact = commitHeadFact(grouping.groups[0]);
  }
}

const LONG_BRANCH = 'feature/project-cost-popover-with-agent-specific-unpriced-request-totals-and-a-long-name';

test('links inside commit rows do not add standalone action spacing', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    // The viewport leaves vertical room for the expanded card's chip row.

    await page.setViewportSize({ width: 800, height: 600 });
    await page.setContent(pageHtml());
    const payload = renderPayload() as { cards: Record<string, unknown>[] };
    // One long branch name belongs to the popover heading without a separate group heading.

    const onBranch = { branch: LONG_BRANCH };
    const commits = [
      commitRow('6816be3', 'Mark nested custom-tool spend partial', NOW - 600_000, {
        ...onBranch,
        added: 15,
        removed: 1,
      }),
      // The subagent commit row also includes its maker line.
      commitRow('69ab5b4', 'Record the broader child-spend review', NOW - 480_000, {
        ...onBranch,
        added: 96,
        removed: 0,
        madeBy: 'Fold the Files rows behind a head line and prove the height guard goes red',
        madeBySession: 's-child',
      }),
      // Four-digit added and removed counts exercise wider count cells.
      commitRow('7c41d0e', 'Reflow every row at the narrow width', NOW - 360_000, {
        ...onBranch,
        added: 1284,
        removed: 1076,
      }),
      // Null counts exercise a row without line-count data.
      commitRow('0d5b7a2', 'Retag the release', NOW - 240_000, { ...onBranch, added: null, removed: null }),
    ];
    // The existing card's commit figure opens its supplied commit rows.

    const card = payload.cards[LONG_TURN_INDEX];
    withCommits(card, commits);
    payload.cards = [card];
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
    await page.evaluate(`document.querySelector('#list .turn .head').click()`);
    await page.evaluate(SETTLED);
    // Read the file-count gap as the comparison for commit-count spacing.

    await page.locator('#list .turn .statchip[data-metric="files"]').click();
    await page.evaluate(SETTLED);
    const filePairs = (await page.evaluate(`(() => {
      const rows = [...document.querySelectorAll('#chippop .chippoprows .row')];
      return rows.map((row) => {
        const add = row.querySelector('.add');
        const del = row.querySelector('.del');
        if (!add || !del) return null;
        return del.getBoundingClientRect().left - add.getBoundingClientRect().right;
      }).filter((gap) => gap !== null);
    })()`)) as number[];
    assert.ok(filePairs.length >= 2, 'the Files section drew fewer than two rows to measure');
    const filePairGap = filePairs[0];
    assert.ok(
      Math.max(...filePairs) - Math.min(...filePairs) <= 1,
      `the file counts are parted by ${filePairs.map(Math.round).join('px and ')}px, so there is no one measure to match`,
    );
    await page.locator('#list .turn .statchip[data-metric="commits"]').click();
    await page.evaluate(SETTLED);
    const seen = (await page.evaluate(`(() => {
      const section = document.querySelector('#chippop .chippoprows');
      if (!section) return null;
      const title = document.querySelector('#chippop .chippophead');
      const rows = [...section.querySelectorAll('.row')];
      const links = [...section.querySelectorAll('button.sha')];
      const box = (node) => {
        const r = node.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, height: r.height };
      };
      return {
        title: box(title),
        rows: rows.map(box),
        links: links.map(box),
        margins: links.map((node) => getComputedStyle(node).marginTop),
        branch: title.querySelector('.commitheadfact')?.textContent,
        groups: section.querySelectorAll('.commitgroup').length,
        parts: rows.map((row) => {
          const cell = (selector) => {
            const found = row.querySelector(selector);
            if (!found) return null;
            const r = found.getBoundingClientRect();
            return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
          };
          return {
            sha: cell('.sha'), name: cell('.name'), facts: cell('.commitfacts'), nums: cell('.commitnums'),
            add: cell('.commitnums .add'), del: cell('.commitnums .del'),
            numsText: (row.querySelector('.commitnums')?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
          };
        }),
        popLeft: document.getElementById('chippop').getBoundingClientRect().left,
        popRight: document.getElementById('chippop').getBoundingClientRect().right,
        viewport: innerWidth,
        rowsScroll: section.scrollWidth,
        rowsClient: section.clientWidth,
        popScroll: document.getElementById('chippop').scrollWidth,
        popClient: document.getElementById('chippop').clientWidth,
      };
    })()`)) as null | {
      title: { top: number; bottom: number; height: number };
      rows: { top: number; bottom: number; height: number }[];
      links: { top: number; bottom: number; height: number }[];
      margins: string[];
      branch: string | undefined;
      groups: number;
      parts: {
        sha: null | { top: number; bottom: number; left: number; right: number };
        name: null | { top: number; bottom: number; left: number; right: number };
        facts: null | { top: number; bottom: number; left: number; right: number };
        nums: null | { top: number; bottom: number; left: number; right: number };
        add: null | { top: number; bottom: number; left: number; right: number };
        del: null | { top: number; bottom: number; left: number; right: number };
        numsText: string;
      }[];
      popLeft: number;
      popRight: number;
      viewport: number;
      rowsScroll: number;
      rowsClient: number;
      popScroll: number;
      popClient: number;
    };
    assert.ok(seen, 'the open card drew no commits popover');
    assert.equal(seen.rows.length, 4, 'the popover did not draw every commit row');
    assert.equal(seen.groups, 0, 'a record of one branch drew group headings');
    assert.deepEqual(
      seen.margins,
      ['0px', '0px', '0px', '0px'],
      'a commit link inherited the standalone action margin',
    );
    assert.ok(
      seen.links[0].top - seen.rows[0].top <= 4,
      `the first commit link starts ${Math.round(seen.links[0].top - seen.rows[0].top)}px inside its row`,
    );
    // Measure the gap between row bounds rather than between their top edges.

    assert.ok(
      seen.rows[1].top - seen.rows[0].bottom <= 4,
      `commit rows leave ${Math.round(seen.rows[1].top - seen.rows[0].bottom)}px between them`,
    );
    assert.ok(
      seen.links[0].top - seen.title.bottom < 13,
      `the first commit starts ${Math.round(seen.links[0].top - seen.title.bottom)}px below its heading`,
    );
    // The popover heading retains the complete branch name.
    assert.equal(seen.branch, `· on ${LONG_BRANCH}`, 'the long branch name is not on the popover heading');
    assert.ok(
      seen.popLeft >= -1 && seen.popRight <= seen.viewport + 1,
      'a long branch name pushes the commit list outside the panel',
    );
    // Scroll width detects overflow inside a popover whose outer box stays within the viewport.

    assert.ok(
      seen.rowsScroll <= seen.rowsClient + 1,
      `the commit rows are ${Math.round(seen.rowsScroll - seen.rowsClient)}px wider than the list holding them, so the list scrolls sideways`,
    );
    assert.ok(
      seen.popScroll <= seen.popClient + 1,
      `the commit popover scrolls ${Math.round(seen.popScroll - seen.popClient)}px sideways`,
    );
    // Count cells retain alignment for subagent rows and rows without counts.

    for (const [index, part] of seen.parts.entries()) {
      const { sha, name, nums, add } = part;
      if (!sha || !name || !nums) {
        assert.fail(`commit row ${index} is missing a part`);
      }
      assert.ok(name.left >= sha.right, `commit row ${index} draws its subject over its hash`);
      assert.ok(nums.left >= name.right - 1, `commit row ${index} draws its line counts over its subject`);
      if (add) {
        assert.ok(
          Math.abs(add.top - name.top) <= 2,
          `commit row ${index} drops its line counts ${Math.round(add.top - name.top)}px below its subject`,
        );
      }
    }
    assert.deepEqual(
      seen.parts.map((part) => part.facts !== null),
      [false, true, false, false],
      "only the subagent's commit row draws a line under its subject",
    );
    const made = seen.parts[1];
    assert.ok(
      (made.facts?.top ?? 0) >= (made.name?.bottom ?? 0) - 1,
      "the subagent's row draws its maker beside its subject",
    );
    assert.ok(
      Math.abs((made.facts?.left ?? 0) - (made.name?.left ?? 0)) <= 1,
      `the subagent's row starts its maker ${Math.round((made.facts?.left ?? 0) - (made.name?.left ?? 0))}px from its subject`,
    );
    const edges = seen.parts.map((part) => Math.round(part.nums?.right ?? 0));
    assert.ok(
      Math.max(...edges) - Math.min(...edges) <= 1,
      `the line counts end at ${edges.join('px and ')}px, so they do not stand in one column`,
    );
    // Added and removed figures share the file-count component's gap.

    // Check the displayed count text before measuring rows that contain both figures.

    assert.deepEqual(
      seen.parts.map((part) => part.numsText),
      ['+15 −1', '+96', '+1284 −1076', ''],
      'the commit rows do not draw the line counts their record holds',
    );
    // A row with additions only has no count pair to measure.
    const pairs = seen.parts.filter((part) => part.add && part.del);
    assert.equal(pairs.length, 2, 'the two rows that moved lines both ways drew no pair to measure');
    for (const part of pairs) {
      const gap = (part.del?.left ?? 0) - (part.add?.right ?? 0);
      assert.ok(
        Math.abs(gap - filePairGap) <= 1,
        `a commit row parts its counts by ${Math.round(gap)}px, against ${Math.round(filePairGap)}px in the Files section`,
      );
    }
    const removed = pairs.map((part) => Math.round(part.del?.right ?? 0));
    assert.ok(
      Math.max(...removed) - Math.min(...removed) <= 1,
      `the removed counts end at ${removed.join('px and ')}px, so a four-digit count pulled its row out of the column`,
    );
    // Count cells keep the same width even for four-digit or absent counts.

    const cells = seen.parts.map((part) => Math.round((part.nums?.right ?? 0) - (part.nums?.left ?? 0)));
    assert.ok(
      Math.max(...cells) - Math.min(...cells) <= 1,
      `the count cells are ${cells.join('px and ')}px wide, so the cell does not hold one width`,
    );
    const starts = seen.parts.map((part) => Math.round(part.name?.left ?? 0));
    assert.ok(
      Math.max(...starts) - Math.min(...starts) <= 1,
      `the subjects start at ${starts.join('px and ')}px, so they do not start in one place`,
    );
    const columns = seen.parts.map((part) => Math.round(part.name?.right ?? 0));
    assert.ok(
      Math.max(...columns) - Math.min(...columns) <= 1,
      `the subject columns end at ${columns.join('px and ')}px, so a row dropped its count cell`,
    );
    // The maker line stays closer to its subject than to the next commit row.

    const inside = (made.facts?.top ?? 0) - (made.name?.bottom ?? 0);
    const between = (seen.parts[2].name?.top ?? 0) - (made.facts?.bottom ?? 0);
    assert.ok(
      between >= inside + 4,
      `commit rows 1 and 2 stand ${Math.round(between)}px apart, against ${Math.round(inside)}px inside row 1`,
    );
  } finally {
    await browser.close();
  }
});

// A landing without an explained source branch draws a merged-in row under its destination branch.

test('a landing no branch explains draws as a row that reads merged in', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 800, height: 600 });
    await page.setContent(pageHtml());
    const payload = renderPayload() as { cards: Record<string, unknown>[] };
    // Neighboring commits provide hash-alignment comparisons. A topic commit creates the second branch group.

    const landing: CommitRowView = {
      ...commitRow('6816be3', 'Retag the release', NOW - 600_000, { added: null, removed: null }),
      kind: 'landing',
      key: 'landing:merge-1',
      detail: 'Retag the release',
      mergedBranch: null,
      landingTarget: 'main',
    };
    const card = payload.cards[LONG_TURN_INDEX];
    withCommits(card, [
      commitRow('cccc333', 'Start the topic', NOW - 1_200_000, { branch: 'topic' }),
      commitRow('aaaa111', 'Write the release note', NOW - 900_000),
      landing,
      commitRow('bbbb222', 'Write the release note again', NOW - 300_000),
    ]);
    payload.cards = [card];
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
    await page.evaluate(`document.querySelector('#list .turn .head').click()`);
    await page.evaluate(SETTLED);
    await page.locator('#list .turn .statchip[data-metric="commits"]').click();
    await page.evaluate(SETTLED);
    const seen = (await page.evaluate(`(() => {
      const row = document.querySelector('#chippop .chippoprows .row[data-record="landing:merge-1"]');
      if (!row) return null;
      const box = (node) => {
        if (!node) return null;
        const r = node.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left };
      };
      const group = row.closest('.commitgroup');
      return {
        heading: group?.querySelector('.commitgroupname')?.textContent ?? null,
        sha: box(row.querySelector(':scope > .sha')),
        name: box(row.querySelector('.name')),
        facts: box(row.querySelector('.commitfacts')),
        factsLines: row.querySelector('.commitfacts')?.getClientRects().length ?? null,
        factsText: (row.querySelector('.commitfacts .dim')?.textContent ?? '').trim(),
        title: row.getAttribute('title'),
        neighbours: [...group.querySelectorAll('.row')].filter((one) => one !== row)
          .map((one) => box(one.querySelector(':scope > .sha'))),
      };
    })()`)) as null | {
      heading: string | null;
      sha: null | { top: number; bottom: number; left: number };
      name: null | { top: number; bottom: number; left: number };
      facts: null | { top: number; bottom: number; left: number };
      factsLines: number | null;
      factsText: string;
      title: string | null;
      neighbours: Array<null | { top: number; bottom: number; left: number }>;
    };
    assert.ok(seen, 'the open card drew no landing row in its commits popover');
    assert.equal(seen.heading, 'main', 'the landing sits under a heading other than the branch that moved');
    assert.equal(seen.factsText, 'merged in', 'the landing row does not read merged in');
    assert.equal(seen.factsLines, 1, 'the landing row broke merged in across lines');
    assert.match(
      seen.title ?? '',
      /^Retag the release\nMerged into main at 2:22 PM, as 6816be3\. The record does not say which branch it came from\.$/,
    );
    assert.ok(seen.sha && seen.name && seen.facts, 'the landing row is missing its hash, subject or facts');
    assert.ok(
      Math.abs((seen.name?.top ?? 0) - (seen.sha?.top ?? 0)) <= 1,
      'the landing hash sits on a different line from its subject',
    );
    assert.ok(
      (seen.facts?.top ?? 0) >= (seen.name?.bottom ?? 0) - 1,
      'the merged in line overlaps the subject instead of following it',
    );
    assert.ok(
      Math.abs((seen.facts?.left ?? 0) - (seen.name?.left ?? 0)) <= 1,
      'the merged in line starts away from the subject above it',
    );
    // The landing hash aligns with the neighboring commit hashes.

    assert.equal(seen.neighbours.length, 2, 'the popover drew no commit rows around the landing');
    for (const [index, neighbour] of seen.neighbours.entries()) {
      assert.ok(neighbour, `commit row ${index} beside the landing drew no hash`);
      assert.ok(
        Math.abs((seen.sha?.left ?? 0) - (neighbour?.left ?? 0)) <= 1,
        `the landing hash starts ${Math.round((seen.sha?.left ?? 0) - (neighbour?.left ?? 0))}px from the hash of commit row ${index}`,
      );
    }
  } finally {
    await browser.close();
  }
});

// The narrow fixture includes long subject and maker names to exercise ellipsis and column alignment.

test(
  'commit rows keep to their lines at 340 px, and group headings start over the hash column',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
      return;
    }
    try {
      const page = await browser.newPage();
      await page.setViewportSize({ width: 340, height: 900 });
      await page.setContent(themed(pageHtml()));
      const payload = renderPayload() as { cards: Record<string, unknown>[] };
      const card = payload.cards[LONG_TURN_INDEX];
      withCommits(card, commitRecordCards().longest.commits);
      payload.cards = [card];
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);
      await page.evaluate(`document.querySelector('#list .turn .head').click()`);
      await page.evaluate(SETTLED);
      await page.locator('#list .turn .statchip[data-metric="commits"]').click();
      await page.evaluate(SETTLED);
      const seen = (await page.evaluate(`(() => {
      const list = document.querySelector('#chippop .chippoprows');
      if (!list) return null;
      // The lines a row draws, counted from where its visible text lands. Hidden words are left
      // out, because they are positioned outside the row's lines.
      const textRects = (root) => {
        const rects = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent.trim() || node.parentElement.closest('.sr-only')) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          rects.push(...[...range.getClientRects()].filter((rect) => rect.width >= 1));
        }
        return rects;
      };
      const lines = (row, height) => {
        const middles = [];
        for (const rect of textRects(row)) {
          const middle = (rect.top + rect.bottom) / 2;
          if (!middles.some((held) => Math.abs(held - middle) < height / 2)) middles.push(middle);
        }
        return middles.length;
      };
      const middle = (box) => (box.top + box.bottom) / 2;
      return {
        rows: [...list.querySelectorAll('.commitrow')].map((row) => {
          const box = row.getBoundingClientRect();
          const style = getComputedStyle(row);
          const name = row.querySelector('.name');
          const nums = row.querySelector('.commitnums');
          const maker = row.querySelector('.commitmakerlink, .commitmakername');
          const nameBox = name.getBoundingClientRect();
          const numsBox = nums.getBoundingClientRect();
          return {
            lines: lines(row, nameBox.height),
            maker: maker !== null,
            nameCut: name.scrollWidth > name.clientWidth + 1 && getComputedStyle(name).textOverflow === 'ellipsis',
            makerCut: maker ? maker.scrollWidth > maker.clientWidth + 1 && getComputedStyle(maker).textOverflow === 'ellipsis' : null,
            numsOffLine: Math.abs(middle(numsBox) - middle(nameBox)),
            lineHeight: nameBox.height,
            numsFromEdge: box.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth) - numsBox.right,
          };
        }),
        heads: [...list.querySelectorAll('.commitgroup')].map((group) => ({
          text: textRects(group.querySelector('.commitgrouphead'))[0]?.left ?? null,
          hash: textRects(group.querySelector('.commitrow .sha'))[0]?.left ?? null,
        })),
      };
    })()`)) as null | {
        rows: {
          lines: number;
          maker: boolean;
          nameCut: boolean;
          makerCut: boolean | null;
          numsOffLine: number;
          lineHeight: number;
          numsFromEdge: number;
        }[];
        heads: { text: number | null; hash: number | null }[];
      };
      assert.ok(seen, 'the open card drew no commits popover');
      assert.equal(seen.rows.length, 3, 'the popover did not draw the three commit rows');
      assert.equal(seen.heads.length, 2, 'the popover did not group the rows by branch and repository');
      for (const [index, row] of seen.rows.entries()) {
        assert.equal(
          row.lines,
          row.maker ? 2 : 1,
          `commit row ${index} takes ${row.lines} lines at 340 px, against ${row.maker ? 2 : 1}`,
        );
        assert.ok(
          row.numsOffLine < row.lineHeight / 2,
          `commit row ${index} draws its line counts ${Math.round(row.numsOffLine)}px off its first line`,
        );
        assert.ok(
          Math.abs(row.numsFromEdge) <= 1,
          `commit row ${index} ends its line counts ${Math.round(row.numsFromEdge)}px from its right edge`,
        );
      }
      assert.deepEqual(
        seen.rows.slice(0, 2).map((row) => row.nameCut),
        [true, true],
        'the longest subject does not end in an ellipsis at 340 px',
      );
      assert.deepEqual(
        seen.rows.map((row) => row.makerCut),
        [null, true, null],
        'the longest maker name does not end in an ellipsis at 340 px',
      );
      for (const [index, head] of seen.heads.entries()) {
        assert.ok(head.text !== null && head.hash !== null, `group ${index} drew no heading text or no hash`);
        assert.ok(
          Math.abs(head.text - head.hash) <= 1,
          `group ${index} starts its heading ${Math.round(head.text - head.hash)}px from the hash column`,
        );
      }
    } finally {
      await browser.close();
    }
  },
);

// Keyboard navigation reaches rows from the Files, Subagents, and Commits figures.

test('the record chips say what they open and give the keyboard their rows', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 800, height: 900 });
    await page.setContent(pageHtml());
    const payload = renderPayload() as { cards: Record<string, unknown>[] };
    const card = payload.cards[LONG_TURN_INDEX];
    const cardKey = card.key as string;
    const agentRows = card.agents as Array<{ state: string; stateWord: string; since: number | null }>;
    Object.assign(agentRows[0], { state: 'running', stateWord: 'running', since: NOW - 120_000 });
    Object.assign(agentRows[1], { state: 'open', stateWord: 'no ending recorded', since: null });
    // The fixture supplies one running subagent and updates its popover heading accordingly.

    const agentsHead = (card.chips as { metric?: string; detailList?: { heading: Record<string, unknown> } }[]).find(
      (chip) => chip.metric === 'agents',
    )?.detailList?.heading;
    assert.ok(agentsHead, 'the long turn drew no Subagents head');
    agentsHead.value = '1 running';
    agentsHead.busyValue = true;
    payload.cards = [card];
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
    await page.evaluate(`document.querySelector('#list .turn .head').click()`);
    await page.evaluate(SETTLED);

    const pop = page.locator('#chippop');
    const chipFor = (metric: string) => page.locator(`#list .turn .statchip[data-metric="${metric}"]`);
    // Record figures identify their controlled popover and expanded state.

    for (const metric of ['files', 'agents', 'commits']) {
      const chip = chipFor(metric);
      assert.equal(await chip.count(), 1, `the long turn drew no ${metric} chip`);
      assert.equal(await chip.getAttribute('aria-controls'), 'chippop', `the ${metric} chip never says what it opens`);
      assert.equal(
        await chip.getAttribute('aria-expanded'),
        'false',
        `the shut ${metric} chip is not announced as a disclosure`,
      );
      await chip.click();
      await page.evaluate(SETTLED);
      assert.equal(await pop.isHidden(), false, `a press on the ${metric} chip opened nothing`);
      assert.equal(await chip.getAttribute('aria-expanded'), 'true', `the open ${metric} chip still reads as shut`);
      await page.keyboard.press('Escape');
      await page.evaluate(SETTLED);
      assert.equal(await pop.isHidden(), true, `Escape left the ${metric} popover open`);
    }

    // The running subagent count carries the busy tone.

    await chipFor('agents').click();
    await page.evaluate(SETTLED);
    const running = pop.locator('.chippophead .chippopvalue');
    assert.equal(await running.textContent(), '1 running');
    // The assertion checks the busy class. `tones.test.ts` checks its color.

    assert.equal(
      await running.evaluate((node) => node.classList.contains('is-busy')),
      true,
      'the running count in the head is drawn as plain text beside its label',
    );
    await page.keyboard.press('Escape');
    await page.evaluate(SETTLED);

    // Arrow keys enter and traverse file rows, then return to the figure.

    const files = chipFor('files');
    await files.click();
    await page.evaluate(SETTLED);
    await files.focus();
    await page.keyboard.press('ArrowDown');
    const firstRow = String(await page.evaluate('document.activeElement?.dataset.control ?? ""'));
    assert.match(firstRow, /^file:/, 'the arrow from the Files chip reached no file row');
    await page.keyboard.press('ArrowDown');
    const secondRow = String(await page.evaluate('document.activeElement?.dataset.control ?? ""'));
    assert.match(secondRow, /^file:/, 'the arrow moved off the rows after the first one');
    assert.notEqual(secondRow, firstRow, 'the arrow stayed on the same row');
    await page.keyboard.press('Enter');
    await page.evaluate(SETTLED);
    assert.equal(
      await page.evaluate(`window.__posted.filter((m) => m.type === 'openFile').at(-1)?.path`),
      secondRow.slice(`file:${cardKey}:`.length),
      'a key press on a file row opened a different file from the one it names',
    );
    await page.keyboard.press('ArrowUp');
    await page.keyboard.down('Shift');
    await page.keyboard.press('Tab');
    await page.keyboard.up('Shift');
    assert.equal(
      await page.evaluate('document.activeElement?.dataset.metric'),
      'files',
      'the backward walk out of the first row did not hand the Files chip back',
    );

    // Tab leaves the body-mounted popover through the card's keyboard order after its anchor.

    await pop.locator('button').last().focus();
    await page.keyboard.press('Tab');
    await page.evaluate(SETTLED);
    assert.equal(await pop.isHidden(), true, 'walking past the last press left the popover open');
    assert.equal(
      await page.evaluate(`document.getElementById('chippop').contains(document.activeElement)`),
      false,
      'the walk stayed inside a popover the reader can no longer see',
    );
    // With the prompt above the response, the later-prompts disclosure follows the chip row.

    assert.match(
      String(await page.evaluate(`document.activeElement?.dataset.control ?? ''`)),
      /^asks:/,
      'the walk off the last press reached something other than the control after the chip row',
    );

    // Closing an unpinned popover returns its row focus to the figure.

    // Move the pointer away first so hovering triggers a fresh entry event.

    await page.mouse.move(4, 4);
    await page.waitForFunction(`document.getElementById('chippop').hidden`);
    await files.hover();
    await page.waitForFunction(`!document.getElementById('chippop').hidden`);
    await pop.locator('.chippoprows button').first().click();
    await page.evaluate(SETTLED);
    assert.equal(
      await page.evaluate(`document.getElementById('chippop').contains(document.activeElement)`),
      true,
      'a press on a row while the popover was only hovered did not take focus',
    );
    await page.mouse.move(4, 4);
    await page.waitForFunction(`document.getElementById('chippop').hidden`);
    assert.equal(
      await page.evaluate('document.activeElement?.dataset.metric'),
      'files',
      'the popover closed under the reader and left focus on the page body',
    );
  } finally {
    await browser.close();
  }
});

// The message fixture combines many short messages with one message requiring expansion.

test(
  'every mid-turn message is drawn in full, and a long one is bounded and offers the rest',
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
      // The narrow viewport exercises content bounds and horizontal overflow.

      await page.setViewportSize({ width: 340, height: 900 });
      await page.setContent(pageHtml());
      const payload = renderPayload() as { cards: Record<string, unknown>[] };
      // The fixture includes one long message, one earlier reply, and short narration messages.

      const long = Array.from({ length: 60 }, (_, n) => `<p>Line ${n + 1} of a message that keeps going.</p>`).join('');
      const messages = Array.from({ length: 128 }, (_, n) => ({
        id: `${n === 3 ? 'answer' : 'commentary'}:${NOW - (128 - n) * 1000}:0`,
        kind: n === 3 ? 'answer' : 'commentary',
        at: NOW - (128 - n) * 1000,
        text: `narration ${n + 1}`,
        when: '2:31 PM',
        absolute: '2:31 PM',
        summaryHtml: n === 0 ? long : `<p>Narration ${n + 1}, one line of it.</p>`,
        ...(n === 3 ? { answerIndex: 0 } : {}),
      }));
      payload.cards[0].saidMessages = messages;
      setLogMessages(payload.cards[0]);
      payload.cards[0].saidName = `Activity, 128 messages, 1 reply`;
      payload.cards[0].saidMix = '128 messages, 1 reply';
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);
      await page.evaluate(`document.querySelector('#list .turn .head').click()`);
      await page.evaluate(SETTLED);
      const read = `(() => {
      const sections = [...document.querySelectorAll('#list .turn .sec')];
      const section = sections.find((node) => node.querySelector('.sec-title')?.textContent === ${JSON.stringify('Activity')});
      if (!section) return null;
      const activity = sections.find((node) => node.querySelector('.sec-title')?.textContent === 'Activity');
      const response = sections.find((node) => node.querySelector('.sec-title')?.textContent === 'Response');
      const head = section.querySelector('button.actword');
      const list = section.querySelector('.actlist');
      const blocks = [...section.querySelectorAll('.said')];
      const first = blocks[0];
      const text = first && first.querySelector('.saidtext');
      const more = first && first.querySelector('button.more');
      const answers = [...section.querySelectorAll('.said.answer')];
      const style = getComputedStyle(section);
      const listStyle = list && getComputedStyle(list);
      return {
        blocks: blocks.length,
        expanded: head && head.getAttribute('aria-expanded'),
        name: head && head.getAttribute('aria-label'),
        control: head && head.dataset.control,
        controls: head && head.getAttribute('aria-controls'),
        listId: list && list.id,
        mix: [...section.querySelectorAll('.actmix .actcount:not(.acttool):not(.actskills)')]
          .map((node) => node.textContent).join(', '),
        // The section itself is not bounded and has no scroller of its own: a scrollbar
        // inside a scrolling panel hides the messages it holds.
        sectionOverflow: style.overflowY,
        sectionScrolls: section.scrollHeight > section.clientHeight + 1,
        listOverflow: listStyle ? listStyle.overflowY : '',
        listScrolls: list ? list.scrollHeight > list.clientHeight + 1 : false,
        sectionHeight: Math.round(section.getBoundingClientRect().height),
        // The long block, bounded, with the words that lift the bound under it.
        bounded: !!text && text.scrollHeight > text.clientHeight + 2,
        boundHeight: text ? Math.round(text.getBoundingClientRect().height) : -1,
        moreHidden: more ? more.hidden : null,
        moreWord: more ? more.textContent : '',
        moreExpanded: more ? more.getAttribute('aria-expanded') : '',
        moreControls: more ? more.getAttribute('aria-controls') : '',
        moreControl: more ? more.dataset.control : '',
        textId: text ? text.id : '',
        // A short one has nothing to hide, so it offers nothing.
        shortMoreHidden: blocks[1] ? blocks[1].querySelector('button.more').hidden : null,
        shortBounded: blocks[1]
          ? blocks[1].querySelector('.saidtext').scrollHeight > blocks[1].querySelector('.saidtext').clientHeight + 2
          : null,
        // The closed answer, told from a narration by its tag, and still carrying the index
        // a note left on it anchors by.
        answers: answers.length,
        answerIndex: answers[0] ? answers[0].dataset.answer : null,
        answerWord: answers[0] ? answers[0].querySelector('.saidonly')?.textContent.split(', ')[0] : null,
        answerMeta: answers[0] ? answers[0].querySelector('.saidonly')?.textContent : null,
        answerClockTitle: answers[0] ? answers[0].title : null,
        answerClockWords: answers[0] ? answers[0].querySelector('.saidonly')?.textContent.split(', ')[1] : null,
        // The meta line recedes, which is what keeps it from reading as a heading with text
        // under it. Its tone is a stylesheet value and is guarded where the tones are.
        hiddenClock: first ? getComputedStyle(first.querySelector('.saidonly')).clipPath : null,
        sectionTitleFont: response ? getComputedStyle(response.querySelector('.sec-title')).fontSize : null,
        // The first narration carries a clock too, which is what makes the column a column.
        narrationClock: blocks[1] ? blocks[1].querySelector('.saidonly')?.textContent : null,
        narrationWord: blocks[1] ? blocks[1].querySelector('.saidkind') : null,
        // Where it sits, in document order.
        afterResponse: !!response && !!(response.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING),
        beforeActivity: !!activity && !!(activity.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_PRECEDING),
        pageWidth: document.documentElement.scrollWidth,
        viewport: innerWidth,
      };
    })()`;
      const seen = (await page.evaluate(read)) as null | Record<string, unknown>;
      assert.deepEqual(failures, [], 'the panel threw while drawing the mid-turn messages');
      assert.ok(seen, 'the open card drew no "Said while working" section');
      assert.equal(seen.blocks, 128, 'the section drew a different number of messages from the card it was given');
      assert.equal(seen.expanded, 'true', 'the section is shut on a card the reader just opened');
      assert.equal(
        seen.name,
        `Activity, 128 messages, 1 reply, ${CARD_ACTIONS.saidCollapse}`,
        'the head says nothing about how much was said, so a reader who cannot see it is told nothing',
      );
      assert.equal(seen.mix, '128 messages, 1 reply', 'the shut head shows no counts');
      assert.equal(
        seen.control,
        `activity:${(payload.cards[0] as { key: string }).key}`,
        'the head carries no key of its own, so a repaint throws the reader out of it',
      );
      assert.equal(seen.controls, seen.listId, 'the head does not name what it opens');
      // The message section and list use the panel's scroll region without inner scrolling.

      assert.equal(seen.sectionOverflow, 'visible', 'the section has an inner scroll region');
      assert.equal(seen.sectionScrolls, false, 'the section is bounded, so it hides what it holds');
      assert.equal(seen.listOverflow, 'visible', 'the message list has an inner scroll region');
      assert.equal(seen.listScrolls, false, 'the message list is bounded, so it hides what it holds');
      assert.ok(
        (seen.sectionHeight as number) > 2000,
        `the section is ${seen.sectionHeight}px tall, so the messages are not all drawn`,
      );
      // Only the long message receives a bound and an expansion control.
      assert.equal(seen.bounded, true, 'a message of thousands of characters is drawn at its full height');
      assert.ok(
        (seen.boundHeight as number) < 700,
        `the bounded block is ${seen.boundHeight}px tall, so the bound did not hold`,
      );
      assert.equal(seen.moreHidden, false, 'a bounded message offers no way to read the rest of it');
      assert.equal(seen.moreWord, CARD_ACTIONS.saidMore);
      assert.equal(seen.moreExpanded, 'false');
      assert.equal(seen.moreControls, seen.textId, 'the control does not name the block it opens');
      assert.equal(
        seen.moreControl,
        `saidmore:${(payload.cards[0] as { key: string }).key}:${messages[0].id}`,
        'the control carries no key of its own, so a repaint throws the reader out of it',
      );
      assert.equal(seen.shortBounded, false, 'a one-line message is bounded');
      assert.equal(seen.shortMoreHidden, true, 'a message with nothing hidden still offers to show the rest');
      // The earlier reply retains its label, timestamp, and comment anchor index.
      assert.equal(seen.answers, 1);
      assert.equal(seen.answerIndex, '0', 'a mid-turn answer lost the index every note left on it resolves through');
      assert.equal(seen.answerWord, CARD_ACTIONS.saidReplied, 'a reply is not told apart from a narration');
      // Reply metadata places its label before the timestamp with a literal separator.
      assert.match(
        String(seen.answerMeta),
        /^Replied, 2:31 PM$/,
        `the meta line reads "${seen.answerMeta}", so its two parts run together or are out of order`,
      );
      assert.equal(seen.answerClockTitle, 'Replied 2:31 PM', 'the message clock reveals no exact time');
      assert.equal(seen.answerClockWords, '2:31 PM', 'the message clock is not the time the record carries');
      // Narration retains its timestamp without the earlier-reply label.

      assert.equal(seen.narrationClock, '2:31 PM', 'a narration carries no clock, so the column has two shapes');
      assert.equal(seen.narrationWord, null, 'a narration carries a word of its own, so the mark means nothing');
      assert.equal(seen.afterResponse, true, 'the section is drawn above the response it led to');
      assert.equal(seen.beforeActivity, false, 'a second Activity section repeats the log');
      assert.ok(
        (seen.pageWidth as number) <= (seen.viewport as number) + 1,
        'a mid-turn message makes the panel scroll sideways',
      );

      // Expansion removes this message's bound and reverses its control wording.
      await page.evaluate(`document.querySelector('#list .turn .activitysec .said button.more').click()`);
      await page.evaluate(SETTLED);
      const opened = (await page.evaluate(read)) as Record<string, unknown>;
      assert.deepEqual(failures, [], 'the panel threw while opening a bounded message');
      assert.equal(opened.bounded, false, 'the whole message is still not readable after the press');
      assert.equal(
        opened.moreWord,
        CARD_ACTIONS.saidLess,
        'the control says the same thing in both states, so a reader cannot tell which way it goes',
      );
      assert.equal(opened.moreExpanded, 'true');
      assert.ok(
        (opened.boundHeight as number) > (seen.boundHeight as number),
        'the press changed the word and not the block',
      );
    } finally {
      await browser.close();
    }
  },
);

// Table fixtures use unbroken words and a long path. Table scrolling stays within the card and preserves requested column alignment.

test('a response table keeps its words whole and never widens the panel', { timeout: 60_000 }, async (t) => {
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
    const table = renderRichMarkdown(
      [
        '| Area | Result | Evidence |',
        '| --- | :---: | --- |',
        '| Disclosure | Unchanged | 1f28a8f4 |',
        '| Retention | Reverted | 16bbf006 |',
        '| extension/src/webview/panel.css | Rewritten | db3cc70d |',
      ].join('\n'),
    );

    for (const width of [1350, 340]) {
      await page.setViewportSize({ width, height: 900 });
      const payload = renderPayload() as { cards: Record<string, unknown>[] };
      payload.cards[0].summaryHtml = table;
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);
      await page.evaluate(`(() => {
        if (document.querySelector('#list .turn.is-open')) return;
        document.querySelector('#list .turn .head').click();
      })()`);
      await page.evaluate(SETTLED);

      const seen = (await page.evaluate(`(() => {
        const summary = document.querySelector('#list .turn .summary');
        const cells = [...summary.querySelectorAll('th, td')].map((cell) => {
          const range = document.createRange();
          range.selectNodeContents(cell);
          return {
            text: cell.textContent.trim(),
            lines: range.getClientRects().length,
            align: getComputedStyle(cell).textAlign,
          };
        });
        const table = summary.querySelector('table').getBoundingClientRect();
        const card = document.querySelector('#list .turn').getBoundingClientRect();
        return {
          cells,
          tableRight: table.right,
          cardRight: card.right,
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
        };
      })()`)) as {
        cells: { text: string; lines: number; align: string }[];
        tableRight: number;
        cardRight: number;
        documentWidth: number;
        viewportWidth: number;
      };

      assert.deepEqual(failures, [], `the panel threw while drawing the table at ${width}px`);
      assert.equal(seen.cells.length, 12, `the card drew ${seen.cells.length} of the table's 12 cells at ${width}px`);
      for (const cell of seen.cells) {
        assert.equal(cell.lines, 1, `at ${width}px the cell holding ${cell.text} broke across ${cell.lines} lines`);
      }
      assert.equal(
        seen.cells[0].align,
        'left',
        `at ${width}px the head reading Area sits ${seen.cells[0].align} of a left-aligned column`,
      );
      // Chromium includes a prefix in the computed alignment value.
      assert.ok(
        seen.cells[1].align.endsWith('center'),
        `at ${width}px the head reading Result sits ${seen.cells[1].align} of the column the response centered`,
      );
      assert.ok(
        seen.tableRight <= seen.cardRight + 1,
        `at ${width}px the table runs ${Math.round(seen.tableRight - seen.cardRight)}px past the card`,
      );
      assert.ok(
        seen.documentWidth <= seen.viewportWidth + 1,
        `the table scrolls the panel sideways at ${width}px: ${seen.documentWidth} wide in ${seen.viewportWidth}`,
      );
    }
  } finally {
    await browser.close();
  }
});

// Compact-layout height budgets leave limited room for font metrics and scrollbar differences.

const CARD_HEIGHT_BUDGET = [
  { width: 340, bound: 1570 },
  { width: 1350, bound: 735 },
];

// Read visible card body parts in document order.
const BODY_ORDER = `((selector) => {
  const body = document.querySelector(selector + ' .body');
  const name = (node) => node.classList.contains('promptlead') ? 'prompt'
    : node.classList.contains('promptsec') ? 'prompt'
      : node.classList.contains('activitysec') ? 'activity'
        : node.classList.contains('recordfiles') ? 'files'
          : node.classList.contains('recordagents') ? 'subagents'
            : node.classList.contains('recordcommits') ? 'commits' : 'response';
  return [...body.querySelectorAll('.promptlead, .sec')].filter((node) => !node.parentElement.closest('.sec')).map(name);
})`;

test("every Timeline layout draws the long card's body in its own order", { timeout: 90_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(pageHtml());
    await layoutAt(page, 1350);
    const payload = renderPayload() as { cards: { key: string }[] };
    const selector = `[data-key=${JSON.stringify(payload.cards[LONG_TURN_INDEX].key)}]`;
    await page.locator(`${selector} .head`).click();
    await page.evaluate(SETTLED);
    const record = ['subagents', 'commits', 'files'];
    for (const cardLayout of ['compact', 'one-column', 'two-columns']) {
      for (const promptPosition of ['above', 'below']) {
        Object.assign(payload, { timelineLayout: { cardLayout, promptPosition } });
        await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
        await page.evaluate(SETTLED);
        const order = await page.evaluate(`${BODY_ORDER}(${JSON.stringify(selector)})`);
        const prose = ['response', 'activity'];
        const expected = [
          ...(promptPosition === 'above' ? ['prompt'] : []),
          ...prose,
          // Two columns places a below-response prompt in the prose column before the record column.

          ...(cardLayout === 'two-columns' && promptPosition === 'below' ? ['prompt'] : []),
          ...(cardLayout === 'compact' ? [] : record),
          ...(cardLayout !== 'two-columns' && promptPosition === 'below' ? ['prompt'] : []),
        ];
        assert.deepEqual(
          order,
          expected,
          `the body under Card layout ${cardLayout} and Prompt position ${promptPosition}`,
        );
      }
    }
    await page.evaluate(
      "window.postMessage({ type: 'layout', layout: { cardLayout: 'one-column', promptPosition: 'above' } }, '*')",
    );
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await page.evaluate(`${BODY_ORDER}(${JSON.stringify(selector)})`),
      ['prompt', 'response', 'activity', ...record],
      'a saved layout did not redraw the open card without a full render',
    );
  } finally {
    await browser.close();
  }
});

// A one-branch landing appears on both Commits headings with destination, timestamp, and commit identity details.

test(
  'the merged word on a one-branch Commits heading speaks its arrival and follows the clock',
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
      const payload = renderPayload() as { cards: Record<string, unknown>[] };
      const card = payload.cards[LONG_TURN_INDEX] as Record<string, unknown> & { key: string; sessionId: string };
      const merged = (absolute: string): CommitRowView[] => [
        commitRow('aaaa111', 'Write the release note', NOW - 900_000, { branch: 'topic', absolute }),
        {
          ...commitRow('c36e7b5b', 'Merge topic', NOW - 300_000, { added: null, removed: null, absolute }),
          kind: 'landing',
          key: 'landing:merge-1',
          mergedBranch: 'topic',
          landingTarget: 'main',
        },
      ];
      withCommits(card, merged('4:49 PM'));
      Object.assign(payload, { timelineLayout: { cardLayout: 'one-column', promptPosition: 'above' } });
      const selector = `[data-key=${JSON.stringify(card.key)}]`;
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);
      await page.locator(`${selector} .head`).click();
      await page.evaluate(SETTLED);
      const arrivalOf = (root: string) =>
        page.evaluate(`(() => {
      const fact = document.querySelector(${JSON.stringify(root)} + ' .commitheadfact');
      const word = fact && fact.querySelector('.commitheadarrival');
      return fact && {
        text: fact.textContent,
        title: word && word.title,
        spoken: word && word.querySelector('.sr-only') && word.querySelector('.sr-only').textContent,
      };
    })()`) as Promise<{ text: string; title: string | null; spoken: string | null } | null>;
      // The landing fact is beside the collapse button, so lookup starts at the heading wrapper.

      const section = `${selector} .recordcommits .acthead`;
      assert.deepEqual(
        await arrivalOf(section),
        {
          text: '· on topic · merged into main at 4:49 PM, as c36e7b5b',
          title: 'Merged into main at 4:49 PM, as c36e7b5b, the last commit of this branch'.replace(
            'the last commit of this branch',
            "which holds this branch's work under a new hash: Merge topic",
          ),
          spoken: ' into main at 4:49 PM, as c36e7b5b',
        },
        'the section heading left the arrival to its hover alone',
      );
      await page.locator(`${selector} .statchip[data-metric="commits"]`).click();
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await arrivalOf('#chippop .chippophead'),
        await arrivalOf(section),
        'the popover heading says the arrival differently from the section heading',
      );
      assert.match(
        (await page.locator('#chippop').getAttribute('aria-label')) ?? '',
        / · on topic · merged(,|$)/,
        'the popover name leaves out the branch or the merged word its heading draws',
      );
      await page.keyboard.press('Escape');
      // The activity update supplies changed absolute-time text to the mounted heading.
      const later = { ...card, commits: merged('Aug 23 4:49 PM') };
      await page.evaluate(
        `window.postMessage(${JSON.stringify({ type: 'activity', session: card.sessionId, card: later })}, '*')`,
      );
      await page.evaluate(SETTLED);
      const turned = await arrivalOf(section);
      assert.match(turned?.title ?? '', /at Aug 23 4:49 PM/, 'the merged word kept the time the day turned away from');
      assert.equal(turned?.spoken, ' into main at Aug 23 4:49 PM, as c36e7b5b');
      // Grouped branch headings also update their accessible timestamp.
      const grouped = (absolute: string) => [
        ...merged(absolute),
        commitRow('bbbb222', 'Retag it', NOW - 100_000, { absolute }),
      ];
      withCommits(card, grouped('4:49 PM'));
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);
      const groupName = () =>
        page.locator(`${selector} .recordcommits .commitgroup`).first().getAttribute('aria-label');
      assert.equal(await groupName(), 'topic, merged into main at 4:49 PM');
      await page.evaluate(
        `window.postMessage(${JSON.stringify({ type: 'activity', session: card.sessionId, card: { ...card, commits: grouped('Aug 23 4:49 PM') } })}, '*')`,
      );
      await page.evaluate(SETTLED);
      assert.equal(await groupName(), 'topic, merged into main at Aug 23 4:49 PM');
    } finally {
      await browser.close();
    }
  },
);

// Two columns places records beside prose at wide widths and stacks them at narrow widths. Height budgets allow font and scrollbar variation.

const COLUMN_BUDGET = [
  { cardLayout: 'two-columns', width: 1350, beside: true, bound: 900 },
  { cardLayout: 'one-column', width: 340, beside: false, bound: 2670 },
  { cardLayout: 'two-columns', width: 340, beside: false, bound: 2670 },
];

test('Two columns sits the record beside the prose only where the card holds both', { timeout: 90_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(pageHtml());
    const payload = renderPayload() as { cards: { key: string }[] };
    const selector = `[data-key=${JSON.stringify(payload.cards[LONG_TURN_INDEX].key)}]`;
    for (const { cardLayout, width, beside, bound } of COLUMN_BUDGET) {
      await layoutAt(page, width);
      Object.assign(payload, { timelineLayout: { cardLayout, promptPosition: 'above' } });
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);
      if ((await page.locator(`${selector} .body`).getAttribute('hidden')) !== null) {
        await page.locator(`${selector} .head`).click();
        await page.evaluate(SETTLED);
      }
      const seen = (await page.evaluate(`(() => {
        const card = document.querySelector(${JSON.stringify(selector)});
        const files = card.querySelector('.recordfiles').getBoundingClientRect();
        const activity = card.querySelector('.activitysec').getBoundingClientRect();
        return {
          height: card.getBoundingClientRect().height,
          filesTop: files.top, filesLeft: files.left, activityRight: activity.right, activityBottom: activity.bottom,
          documentWidth: document.documentElement.scrollWidth, viewportWidth: document.documentElement.clientWidth,
        };
      })()`)) as {
        height: number;
        filesTop: number;
        filesLeft: number;
        activityRight: number;
        activityBottom: number;
        documentWidth: number;
        viewportWidth: number;
      };
      const where = `${cardLayout} at ${width}px`;
      if (beside) {
        assert.ok(
          seen.filesLeft >= seen.activityRight,
          `the Files section starts at ${Math.round(seen.filesLeft)}px, left of Activity's right edge at ${Math.round(seen.activityRight)}px, under ${where}`,
        );
      } else {
        assert.ok(
          seen.filesTop >= seen.activityBottom,
          `the Files section starts ${Math.round(seen.filesTop)}px down, above Activity's end at ${Math.round(seen.activityBottom)}px, under ${where}`,
        );
      }
      assert.ok(seen.documentWidth <= seen.viewportWidth + 1, `the panel scrolls sideways under ${where}`);
      assert.ok(
        seen.height <= bound,
        `the open long card is ${Math.round(seen.height)}px tall under ${where}, over its ${bound}px bound`,
      );
    }
  } finally {
    await browser.close();
  }
});

// Read each body part's position and height relative to the card.
const BODY_GEOMETRY = `((selector) => {
  const card = document.querySelector(selector);
  const top = card.getBoundingClientRect().top;
  return {
    height: Math.round(card.getBoundingClientRect().height * 2) / 2,
    parts: [...card.querySelectorAll('.body .promptlead, .body .sec')]
      .filter((node) => !node.parentElement.closest('.sec'))
      .map((node) => {
        const box = node.getBoundingClientRect();
        return [node.className, Math.round((box.top - top) * 2) / 2, Math.round(box.height * 2) / 2];
      }),
  };
})`;

async function showLayout(page: Page, payload: object, selector: string, cardLayout: string): Promise<void> {
  Object.assign(payload, { timelineLayout: { cardLayout, promptPosition: 'above' } });
  await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
  await page.evaluate(SETTLED);
  if ((await page.locator(`${selector} .body`).getAttribute('hidden')) !== null) {
    await page.locator(`${selector} .head`).click();
    await page.evaluate(SETTLED);
  }
}

test(
  'Files and Subagents collapse independently while their headings remain keyboard reachable',
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
      const payload = renderPayload() as { cards: Array<{ key: string; files: unknown[]; agents: unknown[] }> };
      const card = payload.cards[LONG_TURN_INDEX];
      card.files = card.files.slice(0, 1);
      card.agents = card.agents.slice(0, 1);
      payload.cards = [card];
      const selector = `[data-key=${JSON.stringify(card.key)}]`;
      await showLayout(page, payload, selector, 'one-column');
      const files = page.locator(`${selector} .recordfiles .actword`);
      const subagents = page.locator(`${selector} .recordagents .actword`);
      const fileList = await files.getAttribute('aria-controls');
      const subagentList = await subagents.getAttribute('aria-controls');
      assert.ok(fileList && subagentList, 'the record headings name no controlled rows');
      assert.equal(await files.getAttribute('aria-expanded'), 'true', 'Files does not start open like Activity');
      assert.equal(
        await subagents.getAttribute('aria-expanded'),
        'true',
        'Subagents does not start open like Activity',
      );
      assert.match((await files.getAttribute('aria-label')) ?? '', /^Files, 1 file, Collapse Files$/);
      assert.match((await subagents.getAttribute('aria-label')) ?? '', /^Subagents, 1 subagent, Collapse Subagents$/);
      assert.equal(
        await page.locator(`[id=${JSON.stringify(fileList)}]`).isHidden(),
        false,
        'Files starts without its rows',
      );
      assert.equal(
        await page.locator(`[id=${JSON.stringify(subagentList)}]`).isHidden(),
        false,
        'Subagents starts without its rows',
      );

      await files.focus();
      assert.equal(await files.evaluate((node) => node === document.activeElement), true, 'Files loses keyboard focus');
      await page.keyboard.press('Space');
      await page.evaluate(SETTLED);
      assert.equal(await files.getAttribute('aria-expanded'), 'false', 'Space does not collapse Files');
      assert.equal(
        await page.locator(`[id=${JSON.stringify(fileList)}]`).isHidden(),
        true,
        'collapsed Files still shows its rows',
      );
      assert.equal(await subagents.getAttribute('aria-expanded'), 'true', 'collapsing Files also collapses Subagents');
      assert.equal(
        await page.locator(`[id=${JSON.stringify(subagentList)}]`).isHidden(),
        false,
        'Subagents rows disappear with Files',
      );
      assert.equal(await files.isVisible(), true, 'collapsed Files loses its heading');
      assert.match((await files.getAttribute('aria-label')) ?? '', /^Files, 1 file, Expand Files$/);

      await files.focus();
      await page.keyboard.press('Enter');
      await page.evaluate(SETTLED);
      assert.equal(await files.getAttribute('aria-expanded'), 'true', 'Enter does not reopen Files');
      assert.equal(
        await page.locator(`[id=${JSON.stringify(fileList)}]`).isHidden(),
        false,
        'reopened Files keeps its rows hidden',
      );
    } finally {
      await browser.close();
    }
  },
);

test(
  'Two columns on a card too narrow for both draws every section where One column does',
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
      await layoutAt(page, 340);
      const payload = renderPayload() as { cards: { key: string }[] };
      const selector = `[data-key=${JSON.stringify(payload.cards[LONG_TURN_INDEX].key)}]`;
      await showLayout(page, payload, selector, 'one-column');
      const one = (await page.evaluate(`${BODY_GEOMETRY}(${JSON.stringify(selector)})`)) as {
        height: number;
        parts: [string, number, number][];
      };
      await showLayout(page, payload, selector, 'two-columns');
      const two = (await page.evaluate(`${BODY_GEOMETRY}(${JSON.stringify(selector)})`)) as {
        height: number;
        parts: [string, number, number][];
      };
      assert.ok(
        one.parts.some(([name]) => name.includes('recordfiles')),
        'One column drew no Files section to compare',
      );
      assert.deepEqual(two, one, 'Two columns stacked at 340px puts a section somewhere One column does not');
    } finally {
      await browser.close();
    }
  },
);

// Read the column threshold and grid rules from the panel stylesheet.

const COLUMNS_RULE = `(() => {
  for (const sheet of document.styleSheets) {
    for (const rule of sheet.cssRules) {
      if (rule instanceof CSSContainerRule && rule.cssText.includes('.cardcolsgrid')) {
        const found = /min-width:\\s*([\\d.]+)em/.exec(rule.conditionText);
        return { em: found ? Number(found[1]) : NaN, inner: [...rule.cssRules].map((inner) => inner.cssText).join(' ') };
      }
    }
  }
  return null;
})()`;

// Measure the card's content width in em, its font size, height, and column placement.

const COLUMNS_READING = `((selector) => {
  const card = document.querySelector(selector);
  const style = getComputedStyle(card);
  const px = parseFloat(style.fontSize);
  const files = card.querySelector('.recordfiles').getBoundingClientRect();
  const activity = card.querySelector('.activitysec').getBoundingClientRect();
  return {
    em: (card.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) / px,
    px,
    height: card.getBoundingClientRect().height,
    beside: files.left >= activity.right,
  };
})`;

// Compare forced two-column and one-column heights using the stylesheet's grid rules across widths.

test('Two columns starts at the width where it stops making the long card taller', { timeout: 180_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(pageHtml());
    await layoutAt(page, 1350);
    const payload = renderPayload() as { cards: { key: string }[] };
    const selector = `[data-key=${JSON.stringify(payload.cards[LONG_TURN_INDEX].key)}]`;
    const rule = (await page.evaluate(COLUMNS_RULE)) as { em: number; inner: string } | null;
    assert.ok(rule && Number.isFinite(rule.em), 'the stylesheet names no Two columns threshold in em');
    type Reading = { em: number; px: number; height: number; beside: boolean };
    const read = async () => (await page.evaluate(`${COLUMNS_READING}(${JSON.stringify(selector)})`)) as Reading;
    const at = async (width: number) => {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(SETTLED);
    };
    const force = async (on: boolean) => {
      await page.evaluate(`((css, on) => {
        let style = document.getElementById('forcedcolumns');
        if (!style) { style = document.createElement('style'); style.id = 'forcedcolumns'; style.textContent = css; document.head.append(style); }
        style.disabled = !on;
      })(${JSON.stringify(rule.inner)}, ${on})`);
      await page.evaluate(SETTLED);
    };
    // Compare both layouts at the same viewport width.
    const compare = async (width: number) => {
      await at(width);
      await showLayout(page, payload, selector, 'one-column');
      const stacked = (await read()).height;
      await showLayout(page, payload, selector, 'two-columns');
      await force(true);
      const reading = await read();
      await force(false);
      return { wins: reading.height <= stacked, em: reading.em };
    };
    let lo = 500;
    let hi = 1600;
    assert.equal((await compare(hi)).wins, true, 'two columns draw the long card taller even at 1600px');
    assert.equal((await compare(lo)).wins, false, 'two columns draw the long card shorter even at 500px');
    while (hi - lo > 8) {
      const mid = Math.round((lo + hi) / 2);
      if ((await compare(mid)).wins) {
        hi = mid;
      } else {
        lo = mid;
      }
    }
    const measured = (await compare(hi)).em;
    assert.ok(
      Math.abs(rule.em - measured) <= 1,
      `two columns stop making the long card taller at ${measured.toFixed(2)}em, and the stylesheet starts them at ${rule.em}em`,
    );

    // Measure placement immediately below and above the stylesheet threshold.
    await showLayout(page, payload, selector, 'two-columns');
    for (const [offset, beside] of [
      [-0.5, false],
      [0.5, true],
    ] as const) {
      const target = rule.em + offset;
      let width = hi;
      let seen = await read();
      for (let tries = 0; tries < 4 && Math.abs(seen.em - target) >= 0.1; tries += 1) {
        width = Math.round(width + (target - seen.em) * seen.px);
        await at(width);
        seen = await read();
      }
      assert.ok(
        Math.abs(seen.em - target) < 0.25,
        `the card could not be sized to ${target}em, it is ${seen.em.toFixed(2)}em`,
      );
      assert.equal(
        seen.beside,
        beside,
        `at ${seen.em.toFixed(2)}em the record ${seen.beside ? 'sits beside' : 'stacks under'} the prose, against a ${rule.em}em threshold`,
      );
    }
  } finally {
    await browser.close();
  }
});

test('the open long card stays inside its height budget at both panel widths', { timeout: 60_000 }, async (t) => {
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
    const key = (renderPayload() as { cards: { key: string }[] }).cards[LONG_TURN_INDEX].key;
    const selector = `[data-key=${JSON.stringify(key)}]`;
    for (const { width, bound } of CARD_HEIGHT_BUDGET) {
      // Open the card only if its retained disclosure state is closed.

      await layoutAt(page, width);
      if ((await page.locator(`${selector} .body`).getAttribute('hidden')) !== null) {
        await page.locator(`${selector} .head`).click();
        await page.evaluate(SETTLED);
      }
      const open = (await page.evaluate(`(() => {
        const card = document.querySelector(${JSON.stringify(selector)});
        const body = card.querySelector('.body');
        return { height: card.getBoundingClientRect().height, bodyHidden: body.hidden };
      })()`)) as { height: number; bodyHidden: boolean };
      assert.deepEqual(failures, [], `the panel threw while opening the long card at ${width}px`);
      assert.equal(open.bodyHidden, false, `the press did not open the long card at ${width}px`);
      assert.ok(
        open.height <= bound,
        `the open long card is ${Math.round(open.height)}px tall at ${width}px, over its ${bound}px bound`,
      );
    }
  } finally {
    await browser.close();
  }
});

// The dialog name includes its running count. Carried-subagent details remain a separate description.

test(
  'the subagents popover is announced with its running figure and its carried subagents',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
      return;
    }
    try {
      const recorded = FIXTURE_TURNS[LONG_TURN_INDEX];
      const background = {
        ...recorded,
        agents: recorded.agents.map((agent, index) =>
          index === 0 ? { ...agent, id: 'bg-live', status: 'running' } : agent,
        ),
      };
      // The fixture includes a live child from this turn and a carried child.
      const live = toCard(background, true, NOW, [], null, false, new Set(['bg-live', 'carried-1']));
      const page = await browser.newPage();
      await page.setViewportSize({ width: 1350, height: 900 });
      await page.setContent(themed(pageHtml(), 'dark'));
      const payload = renderPayload() as { cards: Record<string, unknown>[] };
      payload.cards = [{ ...payload.cards[LONG_TURN_INDEX], chips: live.chips, agents: live.agents }];
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);
      const chip = page.locator('#list .turn .statchip[data-metric="agents"]');
      assert.equal(
        (await chip.textContent())?.startsWith('4 subagents 2 running'),
        true,
        `the figure reads ${JSON.stringify(await chip.textContent())}, not the whole live count`,
      );
      await chip.click();
      await page.evaluate(SETTLED);
      const pop = page.locator('#chippop');
      assert.equal(await pop.getAttribute('role'), 'dialog');
      assert.equal(await pop.getAttribute('aria-label'), '4 subagents, 2 running');
      assert.deepEqual(
        await popoverDescriptions(page),
        ['1 subagent started before this turn'],
        'the carried subagents are spoken as a description of the dialog',
      );
      await page.close();
    } finally {
      await browser.close();
    }
  },
);

// The running-subagent count on a finished turn uses the busy tone and meets 4.5:1 contrast in both default themes.

test(
  'the open subagent count on a finished turn wears the busy tone and stays readable',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
      return;
    }
    try {
      const recorded = FIXTURE_TURNS[LONG_TURN_INDEX];
      // The fixture keeps the child's recorded running status and includes its id in the live-child set.

      const background = {
        ...recorded,
        agents: recorded.agents.map((agent, index) =>
          index === 0 ? { ...agent, id: 'bg-live', status: 'running' } : agent,
        ),
      };
      const live = toCard(background, false, NOW, [], null, false, new Set(['bg-live']));
      for (const kind of ['dark', 'light'] as const) {
        const page = await browser.newPage();
        await page.setViewportSize({ width: 1350, height: 900 });
        await page.setContent(themed(pageHtml(), kind));
        const payload = renderPayload() as { cards: Record<string, unknown>[] };
        payload.cards = [{ ...payload.cards[LONG_TURN_INDEX], chips: live.chips, agents: live.agents }];
        await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
        await page.evaluate(SETTLED);
        const chip = page.locator('#list .turn .statchip[data-metric="agents"]');
        assert.equal(await chip.count(), 1, 'the finished turn drew no subagents figure');
        assert.equal(
          (await chip.textContent())?.startsWith('3 subagents 1 running'),
          true,
          `the subagents figure reads ${JSON.stringify(await chip.textContent())}, not the open count`,
        );
        const measured = (await page.evaluate(`(() => {
        ${CONTRAST_SOURCE}
        const count = document.querySelector('#list .turn .statchip[data-metric="agents"] .statbusy');
        if (!count) { return null; }
        const probe = document.createElement('span');
        probe.style.color = 'var(--busy)';
        document.body.append(probe);
        const busy = getComputedStyle(probe).color;
        probe.remove();
        return { color: getComputedStyle(count).color, busy, ratio: contrastOn(count) };
      })()`)) as { color: string; busy: string; ratio: number } | null;
        assert.ok(measured, `the ${kind} figure drew its open count with no tone of its own`);
        assert.equal(measured.color, measured.busy, `the ${kind} open count is not drawn in the busy tone`);
        assert.ok(
          measured.ratio >= 4.5,
          `the ${kind} open count measures ${measured.ratio.toFixed(2)}:1 on its figure, under the 4.5:1 floor`,
        );
        await page.close();
      }
    } finally {
      await browser.close();
    }
  },
);

// Card, session list, and subagent figures share padding and height.

test('a card chip, a rail figure and a subagent row figure are one pill', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1350, height: 900 });
    await page.setContent(themed(pageHtml(), 'dark'));
    const payload = renderPayload() as { cards: Record<string, unknown>[] };
    // One column exposes the subagent figure without a covering popover.
    Object.assign(payload, { timelineLayout: { cardLayout: 'one-column', promptPosition: 'above' } });
    payload.cards = [
      {
        ...payload.cards[LONG_TURN_INDEX],
        agents: [
          {
            description: 'Review child',
            model: 'opus-5',
            effort: 'high',
            state: 'done',
            stateWord: '',
            since: null,
            hintDetail: '23 tools',
            sessionId: 'child-session',
            figures: [{ metric: 'cost', compactLabel: '$0.31' }],
          },
        ],
      },
    ];
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
    const card = page.locator('#list .turn').first();
    if ((await card.locator('.body').getAttribute('hidden')) !== null) {
      await card.locator('.head').click();
    }
    await page.evaluate(SETTLED);
    const pill = (await page.evaluate(`((selectors) => selectors.map((selector) => {
      const node = document.querySelector(selector);
      if (!node) { return null; }
      const style = getComputedStyle(node);
      const size = Number.parseFloat(style.fontSize);
      return {
        // The pill's own height and its side padding, each in the text size it is drawn at,
        // because a figure on the row reads at the row's size and one on a card at the card's.
        height: node.getBoundingClientRect().height / size,
        left: Number.parseFloat(style.paddingLeft) / size,
        right: Number.parseFloat(style.paddingRight) / size,
        px: node.getBoundingClientRect().height,
        fontSize: size,
      };
    }))(['#list .turn .chips .statchip', '#rail .railstats .railstatchip', '#list .recordagents .agentrow .railstatchip'])`)) as ({
      height: number;
      left: number;
      right: number;
      px: number;
      fontSize: number;
    } | null)[];
    const [chip, rail, figure] = pill;
    assert.ok(chip && rail && figure, `one of the three figures was not drawn: ${JSON.stringify(pill)}`);
    assert.ok(
      Math.abs(rail.height - chip.height) <= 0.02,
      `the rail figure stands ${rail.height}em tall against the card chip's ${chip.height}em`,
    );
    assert.deepEqual(
      [rail.left, rail.right],
      [chip.left, chip.right],
      `the rail figure pads its sides by ${rail.left}em against the card chip's ${chip.left}em`,
    );
    // Compare the subagent figure's padding and height with the card figure.

    assert.deepEqual(
      [figure.left, figure.right],
      [chip.left, chip.right],
      `the subagent row figure pads its sides by ${figure.left}em against the card chip's ${chip.left}em`,
    );
    assert.ok(
      Math.abs(figure.height - chip.height) <= 0.02,
      `the subagent row figure stands ${figure.height}em tall against the card chip's ${chip.height}em`,
    );
    // Check the figure's font size separately because matching box dimensions do not establish text sizing.

    const rowFontSize = (await page.evaluate(
      `Number.parseFloat(getComputedStyle(document.querySelector('#list .recordagents .agentrow')).fontSize)`,
    )) as number;
    assert.equal(
      figure.fontSize,
      rowFontSize,
      `the subagent row figure reads at ${figure.fontSize}px against the row's own ${rowFontSize}px`,
    );
    await page.close();
  } finally {
    await browser.close();
  }
});

// Read row and child-control keyboard stops in document order.

const SUBAGENT_STOPS = `((root) => [...document.querySelectorAll(root + ' .agentrow')].flatMap((row, index) => {
  const named = (node) => (node.classList.contains('namelink') ? 'name' : node.getAttribute('data-metric') || node.className);
  const own = row.getAttribute('tabindex') === '0' ? [index + ' row'] : [];
  return [...own, ...[...row.querySelectorAll('button, [tabindex="0"]')].map((node) => index + ' ' + named(node))];
}))`;

// Subagent rows share one figure stop. A row retains its own stop when no session link carries its run details.

test(
  'the subagent rows of a popover give the keyboard their links and one figure stop',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
      return;
    }
    try {
      const page = await browser.newPage();
      await page.setViewportSize({ width: 1350, height: 900 });
      await page.setContent(themed(pageHtml(), 'dark'));
      const now = (await page.evaluate('Date.now()')) as number;
      const payload = renderPayload() as { cards: Array<Record<string, unknown>> };
      const card = { ...payload.cards[LONG_TURN_INDEX], agents: subagentRows(now) };
      payload.cards = [card];
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);
      const turnCard = page.locator('#list .turn').first();
      if ((await turnCard.locator('.body').getAttribute('hidden')) !== null) {
        await turnCard.locator('.head').click();
      }
      await turnCard.locator('.statchip[data-metric="agents"]').click();
      await page.evaluate(SETTLED);
      assert.equal(
        await page.locator('#chippop').isHidden(),
        false,
        'the Subagents popover shut before its stops were read',
      );
      // The eight-child fixture yields nine stops, including one shared figure stop and one row without a session link.

      assert.deepEqual(
        await page.evaluate(`${SUBAGENT_STOPS}('#chippop')`),
        ['0 name', '0 cost', '1 name', '2 name', '3 row', '4 name', '5 name', '6 name', '7 name'],
        'the popover hands the keyboard more than one stop a row and its link',
      );

      // A completed child without a session link retains its row stop and supplies details for each figure.

      const lone = {
        ...payload.cards[0],
        agents: [
          {
            description: 'Audit the parser',
            model: 'haiku-4-5',
            effort: 'high',
            state: 'done',
            stateWord: '',
            since: null,
            hintDetail: '1 request',
            sessionId: null,
            figures: [
              {
                metric: 'cost',
                compactLabel: '$1.23',
                name: '$1.23 spent',
                record: { heading: { label: '$1.23 spent' }, entries: [{ label: 'Cost by usage · haiku-4-5' }] },
                detail: '$1.23 spent',
              },
              {
                metric: 'commits',
                compactLabel: '2 commits',
                name: '2 commits made',
                shas: ['1234567', '89abcde'],
                record: { heading: { label: '2 commits' }, layout: 'commits', entries: [] },
                detail: '2 commits made',
              },
              {
                metric: 'files',
                compactLabel: '3 files',
                name: '3 files, 18 lines added, 4 removed',
                added: 18,
                removed: 4,
                paths: ['extension/src/a.ts', 'extension/src/b.ts', 'extension/src/c.ts'],
                record: { heading: { label: '3 files, 18 lines added, 4 removed' }, layout: 'files', entries: [] },
                detail: '3 files, 18 lines added, 4 removed',
              },
            ],
          },
        ],
      };
      await page.evaluate(`window.postMessage(${JSON.stringify({ ...payload, cards: [lone] })}, '*')`);
      await page.evaluate(SETTLED);
      if (await page.locator('#chippop').isHidden()) {
        await page.locator('#list .turn').first().locator('.statchip[data-metric="agents"]').click();
        await page.evaluate(SETTLED);
      }
      assert.deepEqual(
        await page.evaluate(`${SUBAGENT_STOPS}('#chippop')`),
        ['0 row', '0 cost'],
        'a child with no session to open loses the run line no figure carries',
      );

      // After a nested detail closes, Shift+Tab moves from its figure through preceding figures and the row.

      const loneRow = page.locator('#chippop .agentrow').first();
      const isFocused = (selector: string) =>
        page.evaluate(`document.activeElement === document.querySelector(${JSON.stringify(selector)})`);
      await loneRow.locator('.railstatchip[data-metric="files"]').click();
      await page.evaluate(SETTLED);
      await page.keyboard.press('Escape');
      await page.evaluate(SETTLED);
      assert.equal(
        await isFocused('#chippop .agentrow .railstatchip[data-metric="files"]'),
        true,
        'Escape from a record did not return focus to its figure',
      );
      await page.keyboard.press('Shift+Tab');
      await page.evaluate(SETTLED);
      assert.equal(
        await isFocused('#chippop .agentrow .railstatchip[data-metric="cost"]'),
        true,
        'Shift+Tab from a figure outside the walk skipped the figure before it',
      );
      await page.keyboard.press('Shift+Tab');
      await page.evaluate(SETTLED);
      assert.equal(await isFocused('#chippop .agentrow'), true, 'Shift+Tab from the first figure skipped its row');

      // Place the child with figure details last to test entry, activation, and exit at the popover boundary.

      const rows = subagentRows(now);
      const last = { ...payload.cards[0], agents: [...rows.slice(1), rows[0]] };
      await page.evaluate(`window.postMessage(${JSON.stringify({ ...payload, cards: [last] })}, '*')`);
      await page.evaluate(SETTLED);
      if (await page.locator('#chippop').isHidden()) {
        await page.locator('#list .turn').first().locator('.statchip[data-metric="agents"]').click();
        await page.evaluate(SETTLED);
      }
      const lastRow = page.locator('#chippop .agentrow').last();
      const figure = lastRow.locator('.railstatchip[data-metric="cost"]');
      const focused = (locator: typeof figure) => locator.evaluate((node) => node === document.activeElement);
      await lastRow.locator('button.namelink').focus();
      await page.keyboard.press('Tab');
      await page.evaluate(SETTLED);
      assert.equal(await page.locator('#chippop').isHidden(), false, 'Tab from the last name shut the popover');
      assert.equal(await focused(figure), true, "Tab from the last name skipped that row's figure");
      await page.keyboard.press('Enter');
      await page.evaluate(SETTLED);
      assert.deepEqual(
        [await figure.getAttribute('aria-pressed'), await page.locator('#chippopnested').isHidden()],
        ['true', false],
        'Enter on a figure did not pin its record',
      );
      assert.equal(await focused(figure), true, 'pinning a figure from the keyboard moved focus off it');
      assert.equal(await page.locator('#chippop').isHidden(), false, 'pinning a figure shut the popover it sits in');
      await page.keyboard.press('Tab');
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.evaluate(
          `[document.querySelector('#chippop').hidden, !!document.activeElement.closest('#chippop, #chippopnested')]`,
        ),
        [true, false],
        'Tab from the last figure stop did not leave the popover and shut it',
      );
      await page.close();
    } finally {
      await browser.close();
    }
  },
);
