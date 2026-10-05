// Browser tests measure the packaged panel page. Shared fixtures and helpers live in `../test/layout.ts`. Tests skip without an installed supported browser.

import { test } from 'vitest';
import assert from 'node:assert';
import { browserOrNone, SETTLED } from '../test/browser.ts';
import { railPayload } from './payload.ts';
import { CARD_ACTIONS, RAIL_MIN_WIDTH } from './turnview.ts';
import { composerView, sessionLauncherView } from './composerview.ts';
import { labelEditorRows } from './turnlabels.ts';
import { HOVER_GRACE_MS, TAB_STOPS } from './webview/stat-detail.ts';
import { toCard } from './turncard.ts';
import { subagent, turn as recordedTurn } from './turnfixtures.ts';
import {
  COMPOSER,
  DRAFT_COMPOSER,
  FIXTURE_CLOCK,
  LIVE_PRESS,
  NOW,
  LONG_TURN_INDEX,
  LONG_WRITTEN_ANSWER,
  PERMISSION_ASK,
  PERMISSION_COMMAND,
  QUESTION_ASK,
  SIX_QUESTION_ASK,
  THREE_QUESTION_ASK,
  pageHtml,
  renderPayload,
  themed,
} from './panelfixture.ts';
import {
  SECOND_PERMISSION_ASK,
  RAPID_PERMISSION_ASKS,
  scrolledLayout,
  layoutAt,
  OLDER_ROW,
  FOOT_OVER_BAR,
  pickedRows,
  drawnQuestions,
  tabFaces,
  ONE_QUESTION_ASK,
  SPOKEN_ID_ASK,
  NO_QUESTION_ASK,
  answerSixQuestions,
  EDITOR_LABELS,
  REVIEW_CHILD_HINT,
  REVIEW_PATHS,
  REVIEW_SHAS,
  subagentRows,
} from '../test/layout.ts';

// Finished fixture rows share the same state mark.
const DONE_MARK = '\u2713';

test(
  'question reference links activate without answering and formatted choices submit exact values',
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
      const ask = structuredClone(QUESTION_ASK);
      ask.questions[0].question = 'Read [ship skill](skills/ship/SKILL.md).\n\n- Keep **values**';
      ask.questions[0].options[0] = { label: '**Small change**', description: '[Read](x.md) and `keep` values' };
      const payload = renderPayload([], [LIVE_PRESS], [], [], [ask]);
      await page.evaluate((value) => window.postMessage(value, '*'), payload);
      const link = page.locator('.caskquestion a[data-link]');
      await link.focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => (window as any).__posted.some((m: any) => m.type === 'openLink'));
      assert.deepEqual(
        await page.evaluate(() => (window as any).__posted.filter((m: any) => m.type === 'openLink').at(-1)),
        { type: 'openLink', href: 'skills/ship/SKILL.md', beside: false },
      );
      assert.equal(
        await page.evaluate(() => (window as any).__posted.filter((m: any) => m.type === 'answerAsk').length),
        0,
      );
      assert.equal(await page.locator('.caskchoice a, .caskchoice button').count(), 0);
      await page.locator('.caskchoice input').first().check();
      await page.waitForFunction(() =>
        document.querySelector('.casktab[aria-selected="true"]')?.textContent?.includes('Checks'),
      );
      await page.locator('.caskchoice input').first().check();
      await page.getByRole('button', { name: 'Answer all 2 agent questions', exact: true }).click();
      const posted = await page.evaluate(() =>
        (window as any).__posted.filter((m: any) => m.type === 'answerAsk').at(-1),
      );
      assert.deepEqual(posted.answer.answers, {
        approach: { labels: ['**Small change**'], written: '' },
        checks: { labels: ['Browser layout'], written: '' },
      });
    } finally {
      await browser.close();
    }
  },
);
// Row-state tones are independent of the surrounding card's status.
const MARK_TONES = {
  done: '--ok',
  running: '--busy',
  open: '--idle',
  failed: '--bad',
  interrupted: '--idle',
  stopped: '--idle',
};

// Read visible and accessible subagent row values under one root.
const SUBAGENT_ROWS = `((root) => {
  const probe = (css) => {
    const node = document.createElement('span');
    node.className = css;
    document.querySelector(root).appendChild(node);
    const color = getComputedStyle(node).color;
    node.remove();
    return color;
  };
  const tone = (name) => {
    const node = document.createElement('span');
    node.style.color = 'var(' + name + ')';
    document.querySelector(root).appendChild(node);
    const color = getComputedStyle(node).color;
    node.remove();
    return color;
  };
  // What a reader sees of one line, with the state mark and the hidden words taken out. Read
  // off a copy of the whole row, so the row's own rules still apply and \`innerText\` reports the
  // text as it is laid out rather than every character the markup holds.
  const seen = (row, selector) => {
    const copy = row.cloneNode(true);
    copy.style.cssText = 'position: fixed; left: -10000px; top: 0';
    row.parentNode.appendChild(copy);
    copy.querySelectorAll('.sr-only, .glyph').forEach((node) => node.remove());
    const text = copy.querySelector(selector).innerText.replace(/\\s+/g, ' ').trim();
    copy.remove();
    return text;
  };
  // The line boxes the text of one element really draws on. A box count over the elements
  // themselves cannot see this: a flex item or a grid item reports one box however many lines
  // its own text takes, and an inline-block figure reports one box around a wrapped label.
  // The hidden words are absolutely placed one pixel squares, so they are dropped by size.
  const lineRects = (el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return [...range.getClientRects()].filter((rect) => rect.width > 2 && rect.height > 2);
  };
  // One line holds every run of text that overlaps it, however tall each run is. Two sizes on
  // one line start at two heights, so a run's top is no test of which line it belongs to.
  const textLines = (el) => {
    const lines = [];
    for (const rect of lineRects(el).sort((a, b) => a.top - b.top)) {
      const line = lines[lines.length - 1];
      const shared = line ? Math.min(line.bottom, rect.bottom) - Math.max(line.top, rect.top) : 0;
      if (line && shared > rect.height / 2) {
        line.top = Math.min(line.top, rect.top);
        line.bottom = Math.max(line.bottom, rect.bottom);
      } else {
        lines.push({ top: rect.top, bottom: rect.bottom });
      }
    }
    return lines.length;
  };
  const tint = probe('chippoppath');
  const idle = tone('--idle');
  const all = [...document.querySelectorAll(root + ' .agentrow')];
  return all.map((row, index) => {
    const box = row.getBoundingClientRect();
    const head = row.querySelector('.agenthead').getBoundingClientRect();
    const facts = row.querySelector('.agentfacts');
    const factsLine = lineRects(facts)[0];
    const name = row.querySelector('.name');
    const nameBox = name.getBoundingClientRect();
    const nameLine = lineRects(name)[0];
    const model = row.querySelector('.model');
    const effort = row.querySelector('.effort');
    const modelRun = row.querySelector('.agentmodelrun');
    const modelRunBox = modelRun ? modelRun.getBoundingClientRect() : null;
    const mark = row.querySelector('.glyph');
    const markBox = mark.getBoundingClientRect();
    const markLine = lineRects(mark)[0];
    const word = row.querySelector('.agentstate');
    const state = row.getAttribute('data-state');
    const size = Number.parseFloat(getComputedStyle(row).fontSize);
    const link = row.querySelector('.namelink');
    return {
      tag: row.tagName,
      rowStop: row.getAttribute('tabindex') === '0',
      linkHint: link ? link.getAttribute('data-hint') : null,
      linkDetail: link ? link.getAttribute('data-hint-detail') : null,
      linkColour: link ? getComputedStyle(link).color : null,
      figureStops: [...facts.querySelectorAll('.railstatchip')].map((figure) => figure.getAttribute('tabindex') === '0'),
      html: row.outerHTML.replace(/> \\d+m</g, '><'),
      text: row.innerText.replace(/\\s+/g, ' ').trim(),
      shown: ['.agenthead', '.agentfacts'].map((selector) => seen(row, selector)),
      hint: row.getAttribute('data-hint'),
      detail: row.getAttribute('data-hint-detail'),
      title: row.getAttribute('title'),
      label: row.getAttribute('aria-label'),
      mark: mark.textContent,
      state,
      word: word ? word.textContent : null,
      ticks: row.querySelector('[data-running-since]') !== null,
      markTone: getComputedStyle(mark).color === tone(${JSON.stringify(MARK_TONES)}[state]),
      wordTone: word
        ? getComputedStyle(word).color === (state === 'failed' ? tone('--bad')
          : state === 'running' ? tone('--busy') : tone('--idle'))
        : null,
      // What the owner asked for: the whole row, and the space above it. A two-line row of a
      // one-line name and a one-line facts run is the shape the height target was set on, so
      // both counts ride beside the height rather than being assumed from the row's state.
      height: box.height,
      gapAbove: index ? box.top - all[index - 1].getBoundingClientRect().bottom : null,
      nameLines: textLines(name),
      factsLines: textLines(facts),
      // The white space the stylesheet opens between the two lines, in the row's own text
      // size. The grid's row gap and the facts margin are the whole of it, and a figure's own
      // height moves the box the other way, so this is read off the boxes and the height above
      // answers for the figures.
      factsGap: (facts.getBoundingClientRect().top - head.bottom) / size,
      factsTone: getComputedStyle(facts).color === idle && idle !== tint,
      factsSize: getComputedStyle(facts).fontSize === getComputedStyle(row).fontSize,
      underline: [...row.querySelectorAll('*')].some((node) => getComputedStyle(node).textDecorationLine !== 'none'),
      twoLines: facts.getBoundingClientRect().top >= head.bottom - 1,
      size,
      // The mark's column and the gap after it, in the row's own text size, because the rule
      // this row keeps is written in em. The same gap in pixels rides beside it, so the two
      // surfaces are compared in the unit their difference is judged in.
      markGap: (nameBox.left - markBox.right) / size,
      markGapPx: nameBox.left - markBox.right,
      // The first line the name draws on, against the mark beside it. A wrapped name ends
      // lower than its mark, so the last line is no test of whether the two sit together.
      markBaseline: Math.abs(markLine.bottom - nameLine.bottom),
      // Line two starts where line one starts, whatever the mark's column costs. Both are read
      // off the text itself, because a padding inside the facts moves their words and not the
      // box around them.
      factsIndent: factsLine && nameLine ? nameLine.left - factsLine.left : null,
      // The gap between the name and the model run, where the two share a line. Where the name
      // fills its line the run is on the next one, and the gap is the head's line gap instead.
      modelOnNameLine: modelRunBox !== null && Math.abs(modelRunBox.top - nameBox.top) <= 1,
      modelGap: modelRunBox ? (modelRunBox.left - nameBox.right) / size : null,
      // The head's own gap parts the name from the run, so a model inside the row carries none
      // of the margin it wears on the card head. That margin sits inside the run, where it
      // moves the words and leaves the run's own box where it was.
      modelMargin: model ? getComputedStyle(model).marginLeft : null,
      // The model and its effort are one run: one line, with the effort after the model on it.
      modelRunLines: modelRun ? textLines(modelRun) : null,
      effortAfterModel: model && effort
        ? Math.abs(model.getBoundingClientRect().top - effort.getBoundingClientRect().top) <= 1
          && effort.getBoundingClientRect().left >= model.getBoundingClientRect().right - 1
        : null,
      // Each figure draws on one line at the row's own size, and spills rather than being cut.
      figures: [...facts.querySelectorAll('.railstatchip')].map((figure) => {
        const style = getComputedStyle(figure);
        return {
          size: Number.parseFloat(style.fontSize) / size,
          overflow: style.overflow, textOverflow: style.textOverflow, lines: textLines(figure),
        };
      }),
    };
  });
})`;

type SubagentFigure = { size: number; overflow: string; textOverflow: string; lines: number };
type SubagentRow = {
  tag: string;
  rowStop: boolean;
  linkHint: string | null;
  linkDetail: string | null;
  linkColour: string | null;
  figureStops: boolean[];
  html: string;
  text: string;
  shown: string[];
  hint: string | null;
  detail: string | null;
  title: string | null;
  label: string | null;
  state: string;
  word: string | null;
  ticks: boolean;
  mark: string;
  markTone: boolean;
  wordTone: boolean | null;
  height: number;
  gapAbove: number | null;
  nameLines: number;
  factsLines: number;
  factsGap: number;
  factsTone: boolean;
  factsSize: boolean;
  underline: boolean;
  twoLines: boolean;
  size: number;
  markGap: number;
  markGapPx: number;
  markBaseline: number;
  factsIndent: number | null;
  modelOnNameLine: boolean;
  modelGap: number | null;
  modelRunLines: number | null;
  modelMargin: string | null;
  effortAfterModel: boolean | null;
  figures: SubagentFigure[];
};

// Two single-line text runs use a height bound in the row's own em units.

const PLAIN_ROW_EMS = 3.9;

function readsAsTheApprovedRow(rows: SubagentRow[], where: string): void {
  let sharedLine = 0;
  let plain = 0;
  for (const row of rows) {
    // Apply the height bound to rows whose name and facts each occupy one line.

    if (row.nameLines === 1 && row.factsLines === 1) {
      plain += 1;
      const ems = row.height / row.size;
      assert.ok(ems <= PLAIN_ROW_EMS, `${row.text} in the ${where} is ${ems}em tall over two lines of its own text`);
    }
    // The taller state mark slightly increases the gap below the first grid track.

    assert.ok(
      row.factsGap <= 0.3,
      `${row.text} in the ${where} leaves ${row.factsGap}em between its name and its figures`,
    );
    if (row.gapAbove !== null) {
      assert.ok(row.gapAbove <= 1.5, `${row.text} in the ${where} sits ${row.gapAbove}px under the row above it`);
    }
    if (row.modelRunLines !== null) {
      assert.ok(row.modelOnNameLine, `${row.text} in the ${where} drops its model run onto a line of its own`);
    }
    assert.ok(row.markGap >= 0.4, `${row.text} in the ${where} leaves ${row.markGap}em after its state mark`);
    assert.ok(
      row.markBaseline <= 1,
      `${row.text} in the ${where} drops its name ${row.markBaseline}px off its state mark`,
    );
    // `lineRects` measures figure border boxes. The indentation assertion allows for the chip's text padding.

    if (row.factsIndent !== null) {
      assert.ok(
        row.factsIndent >= 0.05 * row.size && row.factsIndent <= 0.35 * row.size,
        `${row.text} in the ${where} starts its figures ${row.factsIndent}px off its name`,
      );
    }
    if (row.modelMargin !== null) {
      assert.equal(row.modelMargin, '0px', `${row.text} in the ${where} keeps the card head's margin on its model`);
    }
    if (row.modelRunLines !== null) {
      assert.equal(row.modelRunLines, 1, `${row.text} in the ${where} splits its model from its reasoning effort`);
      assert.notEqual(
        row.effortAfterModel,
        false,
        `${row.text} in the ${where} does not draw its effort after its model`,
      );
    }
    if (row.modelOnNameLine) {
      sharedLine += 1;
      // A shared name-and-model line retains at least the head's minimum gap.

      assert.ok(
        (row.modelGap as number) >= 0.4 - 0.08,
        `${row.text} in the ${where} parts its name and its model by ${row.modelGap}em`,
      );
    }
    for (const figure of row.figures) {
      assert.deepEqual(
        [figure.size, figure.overflow, figure.textOverflow, figure.lines],
        [1, 'visible', 'clip', 1],
        `${row.text} in the ${where} shrinks, clips or wraps inside a figure`,
      );
    }
  }
  assert.ok(sharedLine > 0, `no row in the ${where} draws its name and its model on one line`);
  assert.ok(plain > 0, `no row in the ${where} draws one line of name over one line of figures`);
}

// Compare dimensions owned by the shared row across the card and popover.

function sameGeometry(card: SubagentRow[], pop: SubagentRow[], where: string): void {
  assert.equal(card.length, pop.length, `the card and the popover drew different row counts ${where}`);
  for (const [index, row] of card.entries()) {
    const held = pop[index];
    // Container widths can change which line holds the model. The comparisons below use CSS pixels.

    assert.deepEqual(
      [row.figures, row.modelRunLines, row.modelMargin],
      [held.figures, held.modelRunLines, held.modelMargin],
      `${row.text} draws different figures or model run in the card and the popover ${where}`,
    );
    for (const [name, mine, theirs] of [
      ['mark gap', row.markGapPx, held.markGapPx],
      ['baseline', row.markBaseline, held.markBaseline],
      ['facts indent', row.factsIndent, held.factsIndent],
    ] as const) {
      assert.equal(mine === null, theirs === null, `${row.text} measures its ${name} in one surface only ${where}`);
      if (mine === null || theirs === null) {
        continue;
      }
      assert.ok(
        Math.abs(mine - theirs) <= 1,
        `${row.text} changes its ${name} between the card and the popover ${where}`,
      );
    }
  }
}

test('a dispatched session uses the child row in its section and figure', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no browser installed');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(themed(pageHtml()));
    const payload = renderPayload() as {
      cards: Array<Record<string, unknown>>;
      timelineLayout?: { cardLayout: string; promptPosition: string };
    };
    payload.cards = [payload.cards[LONG_TURN_INDEX]];
    const turn = payload.cards[0];
    const agent = (turn.agents as Array<Record<string, unknown>>)[1];
    const sourceFile = (turn.files as Array<Record<string, unknown>>)[0];
    const sourceCommit = (turn.commits as Array<Record<string, unknown>>).find((row) => row.kind === 'commit');
    assert.ok(sourceCommit, 'the dispatched figure fixture needs one written commit');
    const file = {
      ...sourceFile,
      path: 'c:/repo/child-only.ts',
      name: 'child-only.ts',
      label: 'child-only.ts',
      shownPath: 'child-only.ts',
    };
    const commit = {
      ...sourceCommit,
      key: 'commit:9f8e7d6',
      sha: '9f8e7d6c5b4a3210',
      subject: 'Write the child artifact',
      dir: 'c:/repo',
    };
    turn.files = [];
    turn.commits = [];
    turn.agents = [{ ...agent, figures: [{ metric: 'cost', compactLabel: '$0.31' }] }];
    turn.dispatched = [
      {
        ...agent,
        kind: 'dispatch',
        description: 'Review the panel in a separate session',
        sessionId: '4f4bf298-958f-4751-8782-d8688ff808a6',
        files: [file],
        commits: [commit],
        figures: [
          { metric: 'cost', compactLabel: '$0.31' },
          { metric: 'files', compactLabel: '1 file', paths: [file.path], record: { layout: 'files', entries: [] } },
          {
            metric: 'commits',
            compactLabel: '1 commit',
            shas: [commit.sha],
            record: { layout: 'commits', entries: [] },
          },
        ],
      },
    ];
    (turn.chips as Array<Record<string, unknown>>).push({
      kind: 'plain',
      metric: 'dispatched',
      label: '1 dispatched',
      detail: 'Review the panel in a separate session',
      detailList: {
        layout: 'dispatched',
        actions: true,
        heading: { label: '1 dispatched session' },
        entries: [{ label: 'Review the panel in a separate session' }],
      },
    });
    payload.timelineLayout = { cardLayout: 'one-column', promptPosition: 'above' };
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
    const card = page.locator('#list .turn').first();
    await card.locator('.head').click();
    const subagent = card.locator('.recordagents .agentrow').first();
    const dispatched = card.locator('.recorddispatched .agentrow');
    assert.equal(await dispatched.getAttribute('data-kind'), 'dispatch');
    assert.equal(await subagent.getAttribute('data-kind'), 'subagent');
    const peers = (await page.evaluate(`(() => {
      const row = (selector) => {
        const node = document.querySelector(selector);
        const head = node.querySelector('.agenthead').getBoundingClientRect();
        const facts = node.querySelector('.agentfacts').getBoundingClientRect();
        return { display: getComputedStyle(node).display, columns: getComputedStyle(node).gridTemplateColumns,
          headLeft: head.left - node.getBoundingClientRect().left,
          factsLeft: facts.left - node.getBoundingClientRect().left };
      };
      return [row('.recordagents .agentrow'), row('.recorddispatched .agentrow')];
    })()`)) as Array<Record<string, number | string>>;
    assert.deepEqual(peers[1], peers[0], 'dispatched and subagent rows do not share the two-line grid');
    const heading = card.locator('.recorddispatched .actword');
    await heading.click();
    assert.equal(await heading.getAttribute('aria-expanded'), 'false');
    await heading.click();
    await dispatched.locator('.namelink').click();
    assert.deepEqual(
      await page.evaluate(`window.__posted.filter((message) => message.type === 'showSession').at(-1)`),
      { type: 'showSession', session: '4f4bf298-958f-4751-8782-d8688ff808a6' },
    );
    await dispatched.locator('.railstatchip[data-metric="files"]').click();
    await page.evaluate(SETTLED);
    assert.equal(
      await page.locator('#chippopnested .chippoprows > .row.click').count(),
      1,
      'the dispatched section files figure did not keep the child-only file row',
    );
    await page.locator('#chippopnested .row.click').click();
    assert.deepEqual(await page.evaluate(`window.__posted.at(-1)`), {
      type: 'openFile',
      key: turn.key,
      path: file.path,
      sourceSessionId: '4f4bf298-958f-4751-8782-d8688ff808a6',
      beside: false,
    });
    await dispatched.locator('.railstatchip[data-metric="commits"]').click();
    await page.evaluate(SETTLED);
    assert.equal(
      await page.locator('#chippopnested .commitrow').count(),
      1,
      'the dispatched section commits figure did not keep the child-only commit row',
    );
    await page.locator('#chippopnested .commitrow').hover();
    await page.mouse.move(2, 2);
    await page.clock.runFor(HOVER_GRACE_MS + 50);
    await page.evaluate(SETTLED);
    assert.equal(
      await page.locator('#chippopnested').isVisible(),
      true,
      'a pressed figure record closed when the pointer left it',
    );
    await page.locator('#chippopnested .commitrow .sha').click();
    assert.deepEqual(await page.evaluate(`window.__posted.at(-1)`), {
      type: 'openCommit',
      key: turn.key,
      sha: commit.sha,
      dir: commit.dir,
      beside: false,
    });
    await card.locator('.statchip[data-metric="dispatched"]').click();
    await page.evaluate(SETTLED);
    assert.equal(await page.locator('#chippop .agentrow[data-kind="dispatch"]').count(), 1);
    assert.equal(await page.locator('#chippop .agentrow .railstatchip[data-metric="cost"]').count(), 1);
    await page.locator('#chippop .railstatchip[data-metric="files"]').click();
    await page.evaluate(SETTLED);
    assert.equal(
      await page.locator('#chippopnested .chippoprows > .row.click').count(),
      1,
      'the dispatched files figure did not keep the card file rows',
    );
    await page.locator('#chippopnested .row.click').click();
    assert.deepEqual(await page.evaluate(`window.__posted.at(-1)`), {
      type: 'openFile',
      key: turn.key,
      path: file.path,
      sourceSessionId: '4f4bf298-958f-4751-8782-d8688ff808a6',
      beside: false,
    });
    await page.locator('#chippop .railstatchip[data-metric="commits"]').click();
    await page.evaluate(SETTLED);
    assert.equal(
      await page.locator('#chippopnested .commitrow').count(),
      1,
      'the dispatched commits figure did not keep the card commit rows',
    );
    await page.locator('#chippopnested .commitrow .sha').click();
    assert.deepEqual(await page.evaluate(`window.__posted.at(-1)`), {
      type: 'openCommit',
      key: turn.key,
      sha: commit.sha,
      dir: commit.dir,
      beside: false,
    });
  } finally {
    await browser.close();
  }
});

// Read nested popover styles for headings, entries, values, supporting lines, and separators.

const NESTED_RECORD_STYLE = `(() => {
  const pop = document.querySelector('#chippopnested');
  const pick = (selector, props) => {
    const node = selector ? pop.querySelector(selector) : pop;
    if (!node) { return null; }
    const style = getComputedStyle(node);
    return Object.fromEntries(props.map((prop) => [prop, style.getPropertyValue(prop)]));
  };
  const text = ['font-family', 'font-size', 'font-weight', 'line-height', 'color'];
  return {
    pop: pick(null, ['width', 'padding-top', 'padding-left', 'line-height', 'background-color']),
    heading: pick('.chippophead', [...text, 'padding-bottom', 'border-bottom-width', 'border-bottom-color']),
    list: pick('.chippoplist', ['margin-top', 'padding-left', 'list-style-type']),
    head: pick('.chippopitemhead', ['display', 'justify-content', 'column-gap']),
    label: pick('.chippopitemhead .chippoplabel', text),
    value: pick('.chippopitemhead .chippopvalue', [...text, 'font-variant-numeric']),
    line: pick('.chippopsubitem', [...text, 'padding-top', 'padding-bottom']),
    sublist: pick('.chippopsublist', ['margin-top', 'padding-left', 'color']),
    separated: pick('.chippopitem.is-separated', ['margin-top', 'padding-top', 'border-top-width', 'border-top-color']),
  };
})()`;

test("a subagent's duration record draws like its cost record", { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no browser installed');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(themed(pageHtml(), 'light'));
    const payload = renderPayload() as {
      cards: Array<Record<string, unknown>>;
      timelineLayout?: { cardLayout: string; promptPosition: string };
    };
    payload.cards = [payload.cards[LONG_TURN_INDEX]];
    payload.timelineLayout = { cardLayout: 'one-column', promptPosition: 'above' };
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
    const card = page.locator('#list .turn').first();
    await card.locator('.head').click();
    // The finished child fixture includes tool counts, failures, and runtime.
    const row = card.locator('.recordagents .agentrow').nth(1);
    const open = async (metric: string) => {
      await page.keyboard.press('Escape');
      await row.locator(`.railstatchip[data-metric="${metric}"]`).click();
      await page.waitForFunction(`document.querySelector('#chippopnested')?.checkVisibility()
        && document.querySelector('#chippopnested .chippophead')?.textContent.length > 0`);
      await page.evaluate(SETTLED);
      return {
        heading: await page.locator('#chippopnested .chippophead').innerText(),
        labels: await page.locator('#chippopnested .chippopitemhead .chippoplabel').allInnerTexts(),
        style: (await page.evaluate(NESTED_RECORD_STYLE)) as Record<string, Record<string, string> | null>,
      };
    };
    const ran = await open('duration');
    assert.equal(ran.heading, 'Ran for 4m');
    assert.deepEqual(ran.labels, ['Calls by tool', 'Failed calls', 'Started', 'Ended']);
    const cost = await open('cost');
    assert.equal(cost.heading, '$0.33 spent');
    for (const [part, style] of Object.entries(ran.style)) {
      assert.ok(style, `the duration record draws no ${part}`);
      assert.deepEqual(
        style,
        cost.style[part],
        `the duration record draws its ${part} unlike the cost record beside it`,
      );
    }
  } finally {
    await browser.close();
  }
});

// A running child displays partial cost and its running state, without completed file or commit figures.

test('a running subagent row draws its cost so far and the record that says so', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no browser installed');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(themed(pageHtml()));
    await page.setViewportSize({ width: 340, height: 900 });
    const usage = {
      requests: 4,
      input: 20_000,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      cacheRead: 0,
      output: 3_000,
      thinking: 0,
    };
    const artifacts = {
      files: [{ path: 'c:/repo/extension/src/turncard.ts', added: 4, removed: 1, isNew: false }],
      commits: ['9d7be30'],
      complete: true,
      revision: 'live',
    };
    const live = toCard(
      recordedTurn({
        finished: false,
        endedAt: NOW,
        agents: [
          subagent({
            description: 'Busy child',
            status: 'running',
            durationMs: null,
            artifacts,
            spend: [{ model: 'claude-opus-5', usage }],
          }),
        ],
      }),
      true,
      NOW,
    );
    const payload = renderPayload() as { cards: Array<Record<string, unknown>> };
    payload.cards = [{ ...payload.cards[LONG_TURN_INDEX], agents: live.agents }];
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
    const card = page.locator('#list .turn').first();
    if ((await card.locator('.body').getAttribute('hidden')) !== null) {
      await card.locator('.head').click();
    }
    await card.locator('.statchip[data-metric="agents"]').click();
    await page.evaluate(SETTLED);
    await page.clock.pauseAt(Number(await page.evaluate('Date.now()')) + 1_000);
    const row = page.locator('#chippop .agentrow').first();
    assert.equal(await row.getAttribute('data-state'), 'running');
    assert.deepEqual(
      await row
        .locator('.railstatchip')
        .evaluateAll((figures) => figures.map((figure) => figure.getAttribute('data-metric'))),
      ['cost'],
      'a running row draws a figure other than its cost so far',
    );
    const cost = row.locator('.railstatchip[data-metric="cost"]');
    const label = live.agents[0].figures[0].compactLabel;
    assert.match(label, /\+$/);
    assert.ok((await cost.textContent())?.includes(label), `the running cost figure reads ${await cost.textContent()}`);
    await cost.hover();
    await page.clock.runFor(1_000);
    const record = page.locator('#chippopnested');
    assert.equal(await record.isHidden(), false, 'the running cost figure opened no record');
    assert.match((await record.locator('.chippophead .chippoplabel').textContent()) ?? '', /^At least .+ spent$/);
    assert.ok(
      (await record.textContent())?.includes('Still running. This is the cost so far.'),
      `the running cost record does not say the child still runs: ${await record.textContent()}`,
    );
    await page.close();
  } finally {
    await browser.close();
  }
});

test(
  'a Subagents row is one two-line row in the chip popover and the card, and names its state',
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
      await page.setViewportSize({ width: 340, height: 900 });
      const now = (await page.evaluate('Date.now()')) as number;
      const payload = renderPayload() as {
        cards: Array<Record<string, unknown> & { key: string; chips: { metric?: string }[] }>;
      };
      const turn = payload.cards[LONG_TURN_INDEX];
      turn.agents = subagentRows(now);
      assert.ok(
        turn.chips.some((chip) => chip.metric === 'agents'),
        'the long turn drew no Subagents chip',
      );
      payload.cards = [turn];
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);
      const card = page.locator('#list .turn').first();
      if ((await card.locator('.body').getAttribute('hidden')) !== null) {
        await card.locator('.head').click();
      }
      await card.locator('.statchip[data-metric="agents"]').click();
      await page.evaluate(SETTLED);
      // Pause the page clock ahead of its current time so later advances control elapsed figures.

      await page.clock.pauseAt(Number(await page.evaluate('Date.now()')) + 1_000);
      // An open popover is required because hidden rows have zero rectangles.

      assert.equal(
        await page.locator('#chippop').isHidden(),
        false,
        'the Subagents popover was shut before its rows were measured',
      );
      const pop = (await page.evaluate(`${SUBAGENT_ROWS}('#chippop')`)) as SubagentRow[];

      assert.deepEqual(
        pop.map((row) => [row.tag, row.mark, row.shown]),
        [
          ['DIV', '\u2713', ['Review child opus-5 · high', '$0.31 2 commits 3 files +18 −4 48k tokens']],
          ['DIV', '\u2715', ['Broken child opus-5', 'failed']],
          ['DIV', '\u25CF', ['Busy child opus-5', 'running 21m']],
          ['DIV', '\u25CF', ['Quiet child haiku-4-5', 'running']],
          ['DIV', '\u25A0', ['Cut child opus-5', 'interrupted']],
          ['DIV', '\u2298', ['Left child opus-5', 'stopped']],
          ['DIV', '\u25CF', ['Open child opus-5', 'running']],
          [
            'DIV',
            DONE_MARK,
            [
              'Review the panel implementation for correctness, maintainability, and interaction design findings claude-haiku-4-5-20251001 · high',
              '$12.40 11 commits 148 files +24913 −10842',
            ],
          ],
        ],
      );
      for (const row of pop) {
        // Figures use the shared idle tone independently of path-link colors.

        assert.deepEqual(
          [row.markTone, row.factsTone, row.factsSize, row.underline, row.twoLines, row.label],
          [true, true, true, false, true, null],
          `${row.text} does not draw the approved row`,
        );
      }
      readsAsTheApprovedRow(pop, 'popover at 340px');
      assert.deepEqual(
        pop.map((row) => row.wordTone),
        [null, true, true, true, true, true, true, null],
      );
      // A running duration below one minute omits an empty time suffix.
      assert.deepEqual(
        pop.map((row) => row.word),
        [null, 'failed', 'running 21m', 'running', 'interrupted', 'stopped', 'running', null],
      );
      assert.deepEqual(
        pop.map((row) => row.ticks),
        [false, false, true, true, false, false, false, false],
      );
      // The row hint describes its run. The name link also opens its session.

      assert.deepEqual(
        pop.map((row) => [row.hint, row.detail, row.title]),
        [
          [CARD_ACTIONS.subagentRecord, REVIEW_CHILD_HINT, null],
          [CARD_ACTIONS.subagentRecord, '2 tools', null],
          [CARD_ACTIONS.subagentRecord, null, null],
          [CARD_ACTIONS.subagentRecord, '4 tools', null],
          [CARD_ACTIONS.subagentRecord, null, null],
          [CARD_ACTIONS.subagentRecord, null, null],
          [CARD_ACTIONS.subagentRecord, null, null],
          [CARD_ACTIONS.subagentRecord, '412 tools', null],
        ],
      );
      assert.deepEqual(
        pop.map((row) => [row.linkHint, row.linkDetail]),
        [
          [CARD_ACTIONS.openSubagentSession, REVIEW_CHILD_HINT],
          [CARD_ACTIONS.openSubagentSession, '2 tools'],
          [CARD_ACTIONS.openSubagentSession, null],
          // A child without a session has a plain name and no session action.
          [null, null],
          [CARD_ACTIONS.openSubagentSession, null],
          [CARD_ACTIONS.openSubagentSession, null],
          [CARD_ACTIONS.openSubagentSession, null],
          [CARD_ACTIONS.openSubagentSession, '412 tools'],
        ],
      );
      // Figures share one keyboard stop. Arrow keys reach other actionable figures.

      assert.deepEqual(pop[0].figureStops, [true, false, false, false]);
      assert.deepEqual(
        pop.map((row) => row.rowStop),
        [false, false, false, true, false, false, false, false],
      );

      // Accessible names include state and elapsed runtime.

      // Normalize Chrome's hidden-text space before commas in the accessibility snapshot.

      const names = (await page.locator('#chippop .chippoprows').ariaSnapshot()).replace(/ ,/g, ',');
      for (const name of [
        'button "Open Review child session,"',
        'button "Open Broken child session,"',
        'button "Open Busy child session,"',
      ]) {
        assert.ok(names.includes(name), `the rows are not announced as ${name}:\n${names}`);
      }
      // A row without a session link announces its session as unavailable.
      assert.ok(
        names.includes('Quiet child, haiku-4-5 running, session unavailable'),
        `a row with no session to open does not say so: ${names}`,
      );

      // The name link's hint includes the run details.
      const name = page.locator('#chippop .namelink').first();
      await name.focus();
      await page.clock.runFor(1_000);
      assert.equal(await page.locator('#hintpop').isHidden(), false, 'focus opened no hint on the subagent name');
      assert.deepEqual(
        [
          await page.locator('#hintpop .hinttitle').textContent(),
          await page.locator('#hintpop .hintdetail').textContent(),
          await name.getAttribute('aria-describedby'),
        ],
        [CARD_ACTIONS.openSubagentSession, REVIEW_CHILD_HINT, 'hintdetail'],
      );

      // Figure details use a nested popover so they preserve the enclosing subagent list.

      const cost = page.locator('#chippop .agentrow .railstatchip[data-metric="cost"]').first();
      await cost.hover();
      await page.clock.runFor(1_000);
      assert.equal(
        await page.locator('#chippopnested').isHidden(),
        false,
        'the cost figure opened no record of its own',
      );
      // Nested cost details use structured heading, value, and supporting lines.

      assert.deepEqual(
        await page.evaluate(`(() => {
      const pop = document.querySelector('#chippopnested');
      const item = pop.querySelector('.chippopitem');
      const label = item.querySelector('.chippoplabel');
      const value = item.querySelector('.chippopvalue');
      const line = item.querySelector('.chippopsubitem');
      return [
        pop.querySelector('.chippophead .chippoplabel').textContent,
        label.textContent,
        value.textContent,
        value.getBoundingClientRect().left > label.getBoundingClientRect().right,
        line.textContent,
        line.getBoundingClientRect().left > label.getBoundingClientRect().left,
      ];
    })()`),
        ['$0.31 spent', 'Cost by usage · opus-5', '$0.31', true, 'Output: $0.11', true],
        'the cost record is not drawn in the shape the card draws its own',
      );
      // Equal z-index values place the later body-mounted popover above the earlier one.

      assert.deepEqual(
        await page.evaluate(`(() => {
      const nested = document.querySelector('#chippopnested');
      const pop = document.querySelector('#chippop');
      const boxes = [nested.getBoundingClientRect(), pop.getBoundingClientRect()];
      const order = [...document.body.children];
      return [
        boxes[0].left < boxes[1].right && boxes[1].left < boxes[0].right
          && boxes[0].top < boxes[1].bottom && boxes[1].top < boxes[0].bottom,
        order.indexOf(nested) > order.indexOf(pop),
        getComputedStyle(nested).zIndex === getComputedStyle(pop).zIndex,
      ];
    })()`),
        [true, true, true],
        'the figure record drew under the Subagents popover',
      );
      // The pinned-detail class marks only the figure with open details.

      const pinned = async (metric: string): Promise<boolean> =>
        (
          (await page
            .locator(`#chippop .agentrow .railstatchip[data-metric="${metric}"]`)
            .first()
            .getAttribute('class')) ?? ''
        )
          .split(' ')
          .includes('detail-pinned');
      // A second figure press closes its pinned detail.

      await cost.dispatchEvent('click');
      assert.deepEqual(
        [await pinned('cost'), await pinned('tokens')],
        [true, false],
        'the open record left its own figure unlit',
      );
      await cost.dispatchEvent('click');
      assert.equal(
        await page.locator('#chippopnested').isHidden(),
        true,
        'a second press on the figure left its record open',
      );
      // Hovering the row closes figure details and displays the run hint.

      await page
        .locator('#chippop .agentrow')
        .first()
        .hover({ position: { x: 4, y: 4 } });
      await page.clock.runFor(1_000);
      assert.deepEqual(
        [
          await page.locator('#chippopnested').isHidden(),
          await page.locator('#hintpop .hinttitle').textContent(),
          await page.locator('#hintpop .hintdetail').textContent(),
        ],
        [true, CARD_ACTIONS.subagentRecord, REVIEW_CHILD_HINT],
        'the row repeats a record a figure owns',
      );
      // Closing details clears the figure's pinned mark.
      assert.equal(await pinned('cost'), false, 'the cost figure stayed lit after its record closed');

      // The name uses link color during pointer hover and keyboard focus.

      const linkTone = (await page.evaluate(`(() => {
      const node = document.createElement('span');
      node.style.color = 'var(--vscode-textLink-foreground)';
      document.querySelector('#chippop').appendChild(node);
      const colour = getComputedStyle(node).color;
      node.remove();
      return colour;
    })()`)) as string;
      const nameTone = () =>
        page
          .locator('#chippop .namelink')
          .first()
          .evaluate((node) => getComputedStyle(node).color);
      await page.mouse.move(0, 0);
      await page
        .locator('#chippop')
        .first()
        .hover({ position: { x: 2, y: 2 } });
      assert.notEqual(await nameTone(), linkTone, 'the name reads as a link before the reader reaches it');
      await page.locator('#chippop .namelink').first().hover();
      assert.equal(await nameTone(), linkTone, 'the name takes no link colour under the pointer');
      // Use Shift+Tab to exercise `:focus-visible` on the name link.

      await page.mouse.move(0, 0);
      await cost.focus();
      await page.keyboard.press('Shift+Tab');
      assert.ok(
        await page.evaluate(`document.activeElement === document.querySelector('#chippop .namelink')`),
        'the Tab key does not reach the name from the figure beside it',
      );
      assert.equal(await nameTone(), linkTone, 'the name takes no link colour from the keyboard');

      // Only the name link opens the session. The row body leaves it closed.

      // Dispatch clicks while the clock is paused to avoid waiting for actionability animations.

      const opened = () => page.evaluate(`window.__posted.filter((message) => message.type === 'showSession').length`);
      const before = (await opened()) as number;
      await page.locator('#chippop .agentrow').first().dispatchEvent('click');
      assert.equal(await opened(), before, 'a press on the row body opened a session');
      await page.locator('#chippop .namelink').first().dispatchEvent('click');
      assert.deepEqual(
        await page.evaluate(`window.__posted.filter((message) => message.type === 'showSession').at(-1)`),
        { type: 'showSession', session: 'child-session' },
      );

      // A row without a session link exposes its run hint through keyboard focus.

      const quiet = page.locator('#chippop .agentrow[tabindex="0"]');
      await quiet.focus();
      assert.deepEqual(
        [
          await page.locator('#hintpop').isHidden(),
          await page.locator('#hintpop .hinttitle').textContent(),
          await page.locator('#hintpop .hintdetail').textContent(),
          await quiet.getAttribute('aria-describedby'),
          await quiet.evaluate((node) => node === document.activeElement),
        ],
        [false, CARD_ACTIONS.subagentRecord, '4 tools', 'hintdetail', true],
        'the row with no session to open keeps its record from the keyboard',
      );

      // Advancing the controlled page clock updates running durations, including the first minute.
      await page.clock.runFor(60_000);
      const later = (await page.evaluate(`${SUBAGENT_ROWS}('#chippop')`)) as SubagentRow[];
      assert.deepEqual(
        later.slice(2, 4).map((row) => row.word),
        ['running 22m', 'running 1m'],
      );
      // An open child outside a running turn has no elapsed clock.
      assert.deepEqual([later[6].word, later[6].ticks], ['running', false]);
      // The first Escape closes the focused row's hint while preserving the enclosing popover.

      await page.keyboard.press('Escape');
      // Resume the page clock before waiting for render animation frames.

      await page.clock.resume();
      await page.evaluate(SETTLED);
      assert.equal(
        await page.locator('#chippop').isHidden(),
        false,
        'Escape closed the Subagents popover rather than the row hint over it',
      );
      // Measure the still-open popover at wide width, including shared name-and-model lines.

      await page.setViewportSize({ width: 1350, height: 900 });
      await page.evaluate(SETTLED);
      assert.equal(
        await page.locator('#chippop').isHidden(),
        false,
        'the Subagents popover shut before its rows were measured at 1350px',
      );
      const widePop = (await page.evaluate(`${SUBAGENT_ROWS}('#chippop')`)) as SubagentRow[];
      readsAsTheApprovedRow(widePop, 'popover at 1350px');
      // Normalize figure measurements to each figure's own font size.

      const pills =
        (await page.evaluate(`['#chippop .agentrow .railstatchip', '#rail .railstats .railstatchip', '.sessionstats .statchip']
      .map((one) => {
        const node = document.querySelector(one);
        if (!node) { return one; }
        const style = getComputedStyle(node);
        const size = Number.parseFloat(style.fontSize);
        return [style.paddingTop, style.paddingBottom, style.paddingLeft, style.paddingRight, style.lineHeight]
          .map((value) => Math.round((Number.parseFloat(value) / size) * 100) / 100);
      })`)) as Array<string | number[]>;
      const [rowPill, railPill, sessionPill] = pills;
      // Check the shared figure dimensions before comparing rendered peers.

      assert.deepEqual(railPill, [0.1, 0.1, 0.5, 0.5, 1.3], 'the rail figure lost the shared pill face');
      assert.deepEqual(sessionPill, railPill, 'the rail figure and the session figure part company');
      // Subagent figures retain the same shared dimensions.

      assert.deepEqual(rowPill, railPill, 'the subagent row figure did not take the shared pill face');
      await page.keyboard.press('Escape');
      await page.evaluate(SETTLED);
      assert.equal(
        await page.locator('#chippop').isHidden(),
        true,
        'the Subagents popover stayed open after its row hint closed',
      );

      // The card's Subagents section uses the shared row renderer.
      Object.assign(payload, { timelineLayout: { cardLayout: 'one-column', promptPosition: 'above' } });
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);
      if ((await card.locator('.body').getAttribute('hidden')) !== null) {
        await card.locator('.head').click();
      }
      const wideBody = (await page.evaluate(`${SUBAGENT_ROWS}('#list .recordagents')`)) as SubagentRow[];
      readsAsTheApprovedRow(wideBody, 'card at 1350px');
      sameGeometry(wideBody, widePop, 'at 1350px');
      assert.deepEqual(
        wideBody.map((row) => row.html),
        widePop.map((row) => row.html),
        'the wide card section and the chip popover draw different subagent rows',
      );
      await page.setViewportSize({ width: 340, height: 900 });
      await page.evaluate(SETTLED);
      if ((await card.locator('.body').getAttribute('hidden')) !== null) {
        await card.locator('.head').click();
      }
      const body = (await page.evaluate(`${SUBAGENT_ROWS}('#list .recordagents')`)) as SubagentRow[];
      assert.deepEqual(
        body.map((row) => row.html),
        pop.map((row) => row.html),
        'the card section and the chip popover draw different subagent rows',
      );
      readsAsTheApprovedRow(body, 'card at 340px');
      sameGeometry(body, pop, 'at 340px');
      // Subagent state-mark tones remain independent of the containing card's status.

      for (const status of ['done', 'running', 'stopped', 'interrupted', 'failed']) {
        turn.status = status;
        await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
        await page.evaluate(SETTLED);
        if ((await card.locator('.body').getAttribute('hidden')) !== null) {
          await card.locator('.head').click();
        }
        assert.ok(
          await card.evaluate((node, held) => node.classList.contains(held), status),
          `the card does not carry ${status}`,
        );
        const inCard = (await page.evaluate(`${SUBAGENT_ROWS}('#list .recordagents')`)) as SubagentRow[];
        await card.locator('.statchip[data-metric="agents"]').click();
        await page.evaluate(SETTLED);
        const inPop = (await page.evaluate(`${SUBAGENT_ROWS}('#chippop')`)) as SubagentRow[];
        await page.keyboard.press('Escape');
        await page.evaluate(SETTLED);
        for (const [where, rows] of [
          ['card', inCard],
          ['popover', inPop],
        ] as const) {
          assert.equal(rows.length, 8, `the ${where} of a ${status} card drew ${rows.length} subagent rows`);
          for (const row of rows) {
            assert.deepEqual(
              [row.markTone, row.wordTone !== false, row.factsTone, row.factsSize, row.twoLines],
              [true, true, true, true, true],
              `${row.text} in the ${where} of a ${status} card does not draw its own ${row.state} tone`,
            );
          }
        }
      }
    } finally {
      await browser.close();
    }
  },
);

test(
  'cache expiry detail is keyboard reachable and economics values stack in a narrow panel',
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
      await page.setViewportSize({ width: 340, height: 900 });
      await page.evaluate(`window.postMessage(${JSON.stringify(renderPayload())}, '*')`);
      await page.evaluate(SETTLED);
      const chip = page.locator('.sessionrow [data-metric="cache-expiry"]');
      assert.equal(await chip.evaluate((node) => node.tagName), 'BUTTON');
      await chip.focus();
      assert.equal(await chip.evaluate((node) => document.activeElement === node), true);
      await page.keyboard.press('Enter');
      await page.evaluate(SETTLED);
      const measured = (await page.evaluate(`(() => {
      const pop = document.getElementById('chippop');
      const box = pop.getBoundingClientRect();
      const rows = [...pop.querySelectorAll('.chippopitemhead')].filter((row) => row.querySelector('.chippopvalue'));
      return {
        economics: pop.classList.contains('chippop-economics'),
        text: pop.textContent,
        inside: box.left >= -1 && box.right <= innerWidth + 1,
        stacked: rows.every((row) => row.querySelector('.chippopvalue').getBoundingClientRect().top
          > row.querySelector('.chippoplabel').getBoundingClientRect().top + 1),
      };
    })()`)) as { economics: boolean; text: string; inside: boolean; stacked: boolean };
      assert.equal(measured.economics, true);
      assert.match(measured.text, /Cache expiry 3 affected turns/);
      assert.equal(measured.inside, true);
      assert.equal(measured.stacked, true);
    } finally {
      await browser.close();
    }
  },
);

test(
  'Details keeps its identity, copy actions, and focus behavior across panel redraws',
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
      for (const width of [340, 1350, 340]) {
        const payload = renderPayload();
        const rows = payload.sessions as Array<Record<string, unknown>>;
        rows[0].fullLabel = 'A complete session name that is longer than the compact heading value';
        // The expected resume command is formed from the session row.
        const command = 'claude --resume s1';
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
        await page.evaluate(SETTLED);
        const sessionRow = page.locator('#list .sessionrow').first();
        assert.equal(
          await sessionRow.locator('.sessiondetails').count(),
          0,
          `the session heading still carries a Details control at ${width}px`,
        );
        const openDetails = async () => {
          const session = (await sessionRow.getAttribute('data-session')) ?? '';
          await sessionRow.evaluate((row) => {
            row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
          });
          await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'showSessionDetails', session })}, '*')`);
          await page.evaluate(SETTLED);
        };
        await openDetails();
        await page.locator('.sessiondetailscopy').filter({ hasText: 'Copy ID' }).click();
        await page.locator('.sessiondetailscopy').filter({ hasText: 'Copy command' }).click();
        assert.deepEqual(
          await page.evaluate('window.__posted.slice(-2)'),
          [
            { type: 'copy', text: 's1' },
            { type: 'copy', text: command },
          ],
          `Details sends incorrect copy payloads at ${width}px`,
        );
        const measured = (await page.evaluate(`(() => {
        const dialog = document.getElementById('sessiondetails');
        const row = document.querySelector('#list .sessionrow');
        const r = dialog.getBoundingClientRect(); const h = row.getBoundingClientRect();
        const value = dialog.querySelector('.sessiondetailsvalue');
        const range = document.createRange(); range.selectNodeContents(value); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        const copy = dialog.querySelectorAll('.sessiondetailscopy')[1];
        const copyStyle = getComputedStyle(copy);
        const copyRect = copy.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight,
          wraps: getComputedStyle(value).overflowWrap, afterRow: r.top >= h.bottom || r.bottom <= h.top,
          copyWhiteSpace: copyStyle.whiteSpace, copyShrink: copyStyle.flexShrink,
          copyBelow: copyRect.top > value.getBoundingClientRect().bottom,
          copyRight: copyRect.right > r.right - 20,
          rowRight: h.right };
      })()`)) as {
          left: number;
          top: number;
          right: number;
          bottom: number;
          width: number;
          height: number;
          wraps: string;
          copyWhiteSpace: string;
          copyShrink: string;
          copyBelow: boolean;
          copyRight: boolean;
          rowRight: number;
        };
        assert.ok(
          measured.left >= 0 &&
            measured.top >= 0 &&
            measured.right <= measured.width &&
            measured.bottom <= measured.height,
          `Details leaves the viewport at ${width}px`,
        );
        assert.equal(measured.wraps, 'anywhere', `Details does not wrap long values at ${width}px`);
        assert.equal(measured.copyWhiteSpace, 'nowrap', `Details copy action wraps at ${width}px`);
        assert.equal(measured.copyShrink, '0', `Details copy action shrinks at ${width}px`);
        assert.ok(
          Math.abs(measured.right - measured.rowRight) <= 6,
          `Details is not aligned to the session heading at ${width}px`,
        );
        if (width === 340) {
          assert.ok(measured.left <= 6, 'the narrow Details dialog does not use the available panel width');
          assert.equal(measured.copyBelow, true, 'the narrow Details copy action does not drop below its value');
          assert.equal(measured.copyRight, true, 'the narrow Details copy action is not right-aligned');
        }
        const sessionHeading = page.locator('#list .sessionrow .session').first();
        const sessionName = sessionHeading.locator('.name');
        await sessionName.hover();
        await page.clock.fastForward(350);
        assert.equal(
          await sessionHeading.locator('[title]').count(),
          0,
          `the pressable session heading gives a descendant a native browser title at ${width}px`,
        );
        assert.equal(
          await page.locator('#hintpop').isHidden(),
          false,
          `the panel hint stays shut over a clipped session heading at ${width}px`,
        );
        assert.equal(
          await page.locator('#hintpop .hinttitle').textContent(),
          rows[0].fullLabel,
          `the clipped session heading does not put its full title first at ${width}px`,
        );
        assert.ok(
          ((await page.locator('#hintpop .hintdetail').textContent()) ?? '').endsWith(CARD_ACTIONS.expandAllTurns),
          `the clipped session heading does not put its action second at ${width}px`,
        );
        assert.match(
          (await sessionHeading.getAttribute('aria-label')) || '',
          new RegExp(String(rows[0].fullLabel)),
          `the session heading accessible name drops its full title at ${width}px`,
        );
        const full: Record<string, unknown> = { ...payload, showing: null };
        await page.evaluate(`window.postMessage(${JSON.stringify(full)}, '*')`);
        await page.evaluate(SETTLED);
        assert.equal(
          await page.locator('#sessiondetails').isHidden(),
          false,
          `Details closes when a full render replaces its session row at ${width}px`,
        );
        assert.equal(
          await page.evaluate('getSelection().toString().length > 0'),
          true,
          `an ordinary update replaced Details and lost its selected value at ${width}px`,
        );
        await page.locator('.sessiondetailsclose').focus();
        await page.evaluate(`(() => {
        const value = document.querySelectorAll('#sessiondetails .sessiondetailsvalue')[2];
        const range = document.createRange();
        range.selectNodeContents(value);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      })()`);
        const renamedRows = (full.sessions as Array<Record<string, unknown>>).map((row) =>
          row.id === 's1' ? { ...row, fullLabel: `${row.fullLabel} after a live rename` } : row,
        );
        await page.evaluate(`window.postMessage(${JSON.stringify({ ...full, sessions: renamedRows })}, '*')`);
        await page.evaluate(SETTLED);
        assert.equal(
          await page.evaluate(
            `document.activeElement && document.activeElement.classList.contains('sessiondetailsclose')`,
          ),
          true,
          `a live title change drops focus from the open Details dialog at ${width}px`,
        );
        assert.equal(
          await page.locator('#sessiondetails .sessiondetailsvalue').first().textContent(),
          renamedRows[0].fullLabel,
          `a live title change leaves stale Details text at ${width}px`,
        );
        assert.equal(
          await page.evaluate('getSelection().toString()'),
          's1',
          `a live title change clears selected session ID text at ${width}px`,
        );
        await page.keyboard.press('Escape');
        assert.equal(
          await page.evaluate('document.activeElement && document.activeElement.dataset.control'),
          'session:s1',
          `Escape does not return focus to the session heading at ${width}px`,
        );
        const closedRenamedRows = renamedRows.map((row) =>
          row.id === 's1' ? { ...row, fullLabel: `${row.fullLabel} while Details is closed` } : row,
        );
        await page.evaluate(`window.postMessage(${JSON.stringify({ ...full, sessions: closedRenamedRows })}, '*')`);
        await page.evaluate(SETTLED);
        await openDetails();
        assert.equal(
          await page.locator('#sessiondetails .sessiondetailsvalue').first().textContent(),
          closedRenamedRows[0].fullLabel,
          `opening Details after a closed title change shows stale text at ${width}px`,
        );
        await page.keyboard.press('Escape');
        assert.equal(
          await page.locator('#sessiondetails').isHidden(),
          true,
          `Escape does not close Details at ${width}px`,
        );
        await openDetails();
        if (width === 1350) {
          const sash = (await page.evaluate(`(() => {
          const box = document.getElementById('railsash').getBoundingClientRect();
          return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
        })()`)) as { x: number; y: number };
          await page.mouse.move(sash.x, sash.y);
          await page.mouse.down();
          assert.equal(
            await page.locator('#sessiondetails').isHidden(),
            true,
            'pressing the rail sash does not dismiss the open Details dialog before the rail moves',
          );
          await page.mouse.up();
          await openDetails();
        }
        const missing = {
          ...full,
          cards: [],
          rail: [],
          sessions: (full.sessions as Array<Record<string, unknown>>).filter((row) => row.id !== 's1'),
        };
        await page.evaluate(`window.postMessage(${JSON.stringify(missing)}, '*')`);
        await page.evaluate(SETTLED);
        assert.equal(
          await page.locator('#sessiondetails').isHidden(),
          true,
          `Details remains open after its session identity disappears at ${width}px`,
        );
        assert.equal(
          await page.evaluate(`(() => {
        const active = document.activeElement;
        return !!active && active.matches('.railnew, .compactnew') && active.offsetParent !== null;
      })()`),
          true,
          `removing the open session leaves focus inside hidden Details at ${width}px`,
        );
      }
    } finally {
      await browser.close();
    }
  },
);

test('the sentinel draws below every card, inside the panel, and takes focus', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (e) => failures.push(String(e)));
    await page.setViewportSize({ width: 900, height: 900 });
    await page.setContent(pageHtml());
    await page.evaluate(
      `window.postMessage(${JSON.stringify({
        ...renderPayload(),
        olderHistory: {
          kind: 'load',
          label: 'Load older turns',
          name: 'Load older turns. 40 turns loaded now.',
          auto: true,
          token: 's1:0:40',
          session: 's1',
        },
      })}, '*')`,
    );
    await page.evaluate(SETTLED);
    const row = (await page.evaluate(OLDER_ROW)) as Record<string, unknown> | null;
    assert.ok(row, 'the sentinel drew nothing, so nothing was measured');
    assert.equal(row.tag, 'button', 'the sentinel is not a button, so a keyboard reader cannot press it');
    assert.equal(row.text, 'Load older turns');
    assert.equal(row.control, 'olderHistory', 'the sentinel carries no id, so a repaint cannot find it again');
    assert.equal(
      row.name,
      'Load older turns. 40 turns loaded now.',
      'the spoken name leaves out how much of the session is already loaded',
    );
    assert.equal(row.focusable, true, 'the sentinel cannot be reached without a mouse');
    assert.equal(row.insideList, true, 'the sentinel is drawn outside the list it ends');
    assert.equal(
      row.inGroup,
      false,
      'the sentinel sits inside a session group, so folding that group hides the way further back',
    );
    assert.equal(row.belowLastCard, true, 'the sentinel is drawn above a card, so it does not end the list');
    assert.ok((row.height as number) > 0 && (row.width as number) > 0, 'the sentinel has no size on screen');
    assert.ok(
      (row.right as number) <= (row.listRight as number) + 1,
      'the sentinel runs past the right edge of the list',
    );
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});
test('the line at the first turn replaces the button and is announced', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (e) => failures.push(String(e)));
    await page.setViewportSize({ width: 900, height: 900 });
    await page.setContent(pageHtml());
    await page.evaluate(
      `window.postMessage(${JSON.stringify({
        ...renderPayload(),
        olderHistory: {
          kind: 'beginning',
          label: 'The whole session is loaded. 60 turns.',
          session: 's1',
        },
      })}, '*')`,
    );
    await page.evaluate(SETTLED);
    const row = (await page.evaluate(OLDER_ROW)) as Record<string, unknown> | null;
    assert.ok(row, 'the closing line drew nothing, so nothing was measured');
    assert.equal(row.tag, 'div', 'the first turn still offers a press that cannot add a turn');
    assert.equal(
      row.role,
      'status',
      'the closing line is never announced, so a reader who pressed the button hears nothing',
    );
    assert.equal(row.text, 'The whole session is loaded. 60 turns.');
    assert.equal(row.control, 'olderHistory', 'the reader standing on the button is not carried onto the line');
    assert.equal(row.focusable, true, 'focus has nowhere to land when the button takes itself away');
    assert.equal(row.belowLastCard, true, 'the closing line is drawn above a card');
    assert.equal(
      await page.evaluate("!!document.querySelector('#list .deeper')"),
      false,
      'the button is still on screen beside the line that says there is nothing left to load',
    );
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});

test(
  'zero and one session keep the correct navigation surface through a live resize',
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

      for (const rowCount of [0, 1]) {
        const payload = renderPayload() as {
          cards: Record<string, unknown>[];
          sessions: Record<string, unknown>[];
          rail: Record<string, unknown>[];
          showing: string | null;
          diagnosis: { message: string } | null;
          usage: { composer: unknown; launcher: unknown };
        };
        payload.cards = [];
        payload.rail = payload.rail.slice(0, rowCount);
        payload.sessions = payload.sessions.slice(0, rowCount);
        payload.showing = rowCount ? 's1' : null;
        payload.diagnosis = {
          message: rowCount ? 'Start this session with a prompt.' : 'No sessions in this project yet.',
        };
        if (!rowCount) {
          payload.usage.composer = null;
          payload.usage.launcher = sessionLauncherView(null, [], {
            claude: COMPOSER.models,
            codex: [
              {
                value: 'gpt-5.6',
                label: 'GPT-5.6',
                description: '',
                efforts: [{ value: 'high', label: 'High', description: '' }],
              },
            ],
          });
        }

        await page.setViewportSize({ width: 1350, height: 900 });
        await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
        await page.evaluate(SETTLED);
        assert.equal(
          await page.evaluate("document.getElementById('rail').hidden"),
          false,
          `the ${rowCount}-row rail is hidden at the wide width`,
        );
        // Count distinct session identities because saved views can repeat session list cards.

        assert.equal(
          await page
            .locator('#rail .railcard')
            .evaluateAll((nodes) => new Set(nodes.map((node) => (node as HTMLElement).dataset.session)).size),
          rowCount,
          `the wide rail does not contain the ${rowCount} sessions it was sent`,
        );
        assert.deepEqual(
          await page
            .locator('#list > .controls')
            .evaluateAll((nodes) =>
              nodes.map((node) => ({ hidden: node.hasAttribute('hidden'), boxes: node.getClientRects().length })),
            ),
          [{ hidden: true, boxes: 0 }],
          `the compact controls are visible beside the ${rowCount}-row wide rail`,
        );
        if (!rowCount) {
          assert.equal(
            await page.locator('#rail .railnew:visible').count(),
            1,
            'the wide empty rail does not expose exactly one New control',
          );
          assert.equal(
            await page.locator('#list .compactnew:visible').count(),
            0,
            'the wide empty rail exposes a second New control in the session view',
          );
        }

        for (const wideWidth of [1350, RAIL_MIN_WIDTH]) {
          if (wideWidth !== 1350) {
            await page.setViewportSize({ width: wideWidth, height: 900 });
            await page.evaluate(SETTLED);
          }
          const rail = (await page.evaluate(`(() => {
          const node = document.getElementById('rail');
          const bar = document.getElementById('statusbar');
          const railBox = node.getBoundingClientRect();
          const barBox = bar.getBoundingClientRect();
          const sidebarProbe = document.createElement('div');
          sidebarProbe.style.backgroundColor = 'var(--vscode-sideBar-background)';
          document.body.appendChild(sidebarProbe);
          const sidebarBackground = getComputedStyle(sidebarProbe).backgroundColor;
          sidebarProbe.remove();
          return {
            hidden: node.hidden,
            bottom: railBox.bottom,
            statusbarTop: barBox.top,
            background: getComputedStyle(node).backgroundColor,
            sidebarBackground,
          };
        })()`)) as {
            hidden: boolean;
            bottom: number;
            statusbarTop: number;
            background: string;
            sidebarBackground: string;
          };
          assert.equal(
            rail.hidden,
            false,
            `the ${rowCount}-row rail is hidden at its exact wide width of ${wideWidth}px`,
          );
          assert.ok(
            Math.abs(rail.bottom - rail.statusbarTop) <= 1,
            `the ${rowCount}-row rail ends at ${Math.round(rail.bottom)}px instead of the ` +
              `status bar top at ${Math.round(rail.statusbarTop)}px at ${wideWidth}px`,
          );
          assert.equal(
            rail.background,
            rail.sidebarBackground,
            `the ${rowCount}-row rail does not use the sidebar background at ${wideWidth}px`,
          );
        }

        if (!rowCount) {
          await page.evaluate("window.postMessage({ type: 'openLauncher', custom: true }, '*')");
          await page.evaluate(SETTLED);
          const agent = page.locator('#launcher [data-control="launch-agent"]');
          assert.equal(
            await agent.getAttribute('data-value'),
            '',
            'the first-project setup silently selected an agent',
          );
          assert.equal(
            await agent.evaluate((node) => node === document.activeElement),
            true,
            'the fresh setup did not focus its first decision',
          );
          assert.equal(
            await page.locator('#launcher .launchcreate').isDisabled(),
            true,
            'the setup can create a draft before an agent is chosen',
          );
          await page.keyboard.press('Escape');
        } else {
          const prompt = page.locator('#prompt');
          await prompt.fill('kept across widths');
          await prompt.focus();
          // Count selected session identities independently of repeated matching cards.

          assert.deepEqual(
            await page
              .locator('#rail .railcard.is-current')
              .evaluateAll((nodes) => [...new Set(nodes.map((node) => (node as HTMLElement).dataset.session))]),
            ['s1'],
            'the only draft is not marked as the selected session',
          );
          assert.equal(await page.locator('#list .empty').textContent(), 'Start this session with a prompt.');
        }

        await page.setViewportSize({ width: RAIL_MIN_WIDTH - 1, height: 900 });
        await page.evaluate(SETTLED);
        assert.equal(
          await page.evaluate("document.getElementById('rail').hidden"),
          true,
          `the ${rowCount}-row rail remains active below its breakpoint`,
        );
        assert.equal(
          await page.locator('#list > .controls').count(),
          1,
          `the ${rowCount}-row narrow view has no single compact control bar`,
        );

        await page.setViewportSize({ width: 1350, height: 900 });
        await page.evaluate(SETTLED);
        assert.equal(
          await page.evaluate("document.getElementById('rail').hidden"),
          false,
          `the ${rowCount}-row rail did not return after widening`,
        );
        // The restored session list retains its distinct-session count.
        assert.equal(
          await page
            .locator('#rail .railcard')
            .evaluateAll((nodes) => new Set(nodes.map((node) => (node as HTMLElement).dataset.session)).size),
          rowCount,
          `the restored rail changed its ${rowCount}-row payload`,
        );
        assert.deepEqual(
          await page
            .locator('#list > .controls')
            .evaluateAll((nodes) =>
              nodes.map((node) => ({ hidden: node.hasAttribute('hidden'), boxes: node.getClientRects().length })),
            ),
          [{ hidden: true, boxes: 0 }],
          `the compact controls are visible after restoring the ${rowCount}-row rail`,
        );
        if (rowCount) {
          assert.equal(
            await page.locator('#prompt').inputValue(),
            'kept across widths',
            'the selected draft text changed across the resize',
          );
          assert.equal(
            await page.evaluate("document.getElementById('prompt') === document.activeElement"),
            true,
            'the selected draft lost focus across the resize',
          );
        }
      }
      assert.deepEqual(failures, [], 'the first-project resize path threw while drawing');
    } finally {
      await browser.close();
    }
  },
);

test('Details follows a first-prompt heading before and after its durable render', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(pageHtml());
    const provisionalId = 'draft:s1';
    const durableId = 'thread-one';
    const provisional = JSON.parse(
      JSON.stringify(renderPayload([], [LIVE_PRESS])).replaceAll(JSON.stringify('s1'), JSON.stringify(provisionalId)),
    ) as Record<string, unknown>;
    provisional.sessionAdoptions = [];
    await page.evaluate(`window.postMessage(${JSON.stringify(provisional)}, '*')`);
    await page.evaluate(SETTLED);
    const arm = async () => {
      await page.locator('#list .sessionrow').evaluate((row) => {
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      });
    };
    const choose = async () => {
      await page.evaluate(
        `window.postMessage(${JSON.stringify({
          type: 'showSessionDetails',
          session: provisionalId,
        })}, '*')`,
      );
      await page.evaluate(SETTLED);
    };

    await arm();
    await choose();
    assert.equal(
      await page.locator('#sessiondetails').isVisible(),
      true,
      'choosing Details before adoption did not open the provisional session',
    );
    assert.equal(await page.locator('#sessiondetails .sessiondetailsvalue').nth(2).textContent(), provisionalId);
    await page.keyboard.press('Escape');

    await arm();
    const durable = JSON.parse(
      JSON.stringify(renderPayload([], [LIVE_PRESS])).replaceAll(JSON.stringify('s1'), JSON.stringify(durableId)),
    ) as Record<string, unknown>;
    durable.sessionAdoptions = [{ provisional: provisionalId, durable: durableId }];
    await page.evaluate(`window.postMessage(${JSON.stringify(durable)}, '*')`);
    await page.evaluate(SETTLED);
    await choose();
    assert.equal(
      await page.locator('#sessiondetails').isVisible(),
      true,
      'choosing Details after adoption did not resolve the provisional menu target',
    );
    assert.equal(await page.locator('#sessiondetails .sessiondetailsvalue').nth(2).textContent(), durableId);
  } finally {
    await browser.close();
  }
});

test(
  'the first-prompt shell stays complete until the durable session render arrives',
  { timeout: 60_000 },
  async (t) => {
    const browser = await browserOrNone();
    if (!browser) {
      t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
      return;
    }
    try {
      for (const agent of ['claude', 'codex'] as const)
        for (const width of [1350, 340]) {
          const page = await browser.newPage();
          const failures: string[] = [];
          const provisional = 'draft:s1';
          const durableId = 'thread-one';
          page.on('pageerror', (error) => failures.push(String(error)));
          await page.setViewportSize({ width, height: 900 });
          await page.setContent(pageHtml());
          const submitted = JSON.parse(
            JSON.stringify(renderPayload([], [LIVE_PRESS])).replaceAll(
              JSON.stringify('s1'),
              JSON.stringify(provisional),
            ),
          ) as {
            cards: Record<string, unknown>[];
            diagnosis: { message: string } | null;
            usage: { composer: unknown };
            rail: Array<Record<string, unknown>>;
            stats: unknown;
            labels: unknown;
            views: unknown;
            railFilters: unknown;
          };
          submitted.cards = [];
          submitted.diagnosis = { message: 'Start this session with a prompt.' };
          submitted.usage.composer = composerView(
            {
              ...DRAFT_COMPOSER,
              agent,
              session: provisional,
              sessionId: provisional,
              draft: '',
              onScreen: '',
              live: [LIVE_PRESS],
            },
            FIXTURE_CLOCK,
          );
          submitted.rail = submitted.rail.map((row) =>
            row.id === provisional ? { ...row, agent: agent === 'claude' ? 'Claude' : 'Codex', agentKey: agent } : row,
          );
          await page.evaluate(`window.postMessage(${JSON.stringify(submitted)}, '*')`);
          await page.evaluate(SETTLED);

          await page.locator('#prompt').fill('revision before adoption');
          await page.locator('#prompt').press('Enter');
          const firstSend = (await page.evaluate(
            `window.__posted.filter((message) => message.type === 'sendPrompt').at(-1)`,
          )) as {
            session: string;
            revision: number;
          };
          assert.equal(firstSend.session, provisional);
          if (width >= RAIL_MIN_WIDTH) {
            await page.locator('#rail .railrow .railpin').first().click();
          } else {
            await page.evaluate(
              `window.postMessage(${JSON.stringify({ type: 'setSessionPinned', session: provisional, pinned: true })}, '*')`,
            );
          }

          await page.locator('#list .sessionrow').evaluate((row) => {
            row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
          });
          await page.evaluate(
            `window.postMessage(${JSON.stringify({ type: 'openLabelEditor', session: provisional })}, '*')`,
          );
          await page.evaluate(SETTLED);
          await page.evaluate(
            `window.postMessage(${JSON.stringify({
              type: 'labelEditor',
              session: provisional,
              heading: CARD_ACTIONS.labelHeading + ' Embedded agent input',
              rows: labelEditorRows(EDITOR_LABELS, provisional),
            })}, '*')`,
          );
          await page.locator('#labelpop input[data-control="label:rail"]').click();
          await page.locator('#labelpop .labelfind').fill('ra');
          await page.evaluate(SETTLED);
          const actions = (await page.evaluate(
            `window.__posted.filter((message) => message.type === 'setLabels' || message.type === 'sessionMembership')`,
          )) as Array<Record<string, unknown>>;
          assert.ok(
            actions.some(
              (message) =>
                message.type === 'setLabels' &&
                message.session === provisional &&
                Array.isArray(message.names) &&
                message.names.includes('rail'),
            ),
            `the label action did not target the provisional session at ${width}px`,
          );
          assert.ok(
            actions.some(
              (message) =>
                message.type === 'sessionMembership' && message.action === 'pin' && message.session === provisional,
            ),
            `the pin action did not target the provisional session at ${width}px`,
          );

          const providerRows = submitted.rail.map((row) => ({
            id: row.id === provisional ? durableId : String(row.id),
            persisted: true,
            label: String(row.label),
            agent: String(row.agent),
            when: String(row.absolute),
            at: Number(row.at),
            relative: String(row.relative),
            agentRun: row.agentRun === true,
          }));
          const providerLabels = Object.fromEntries(
            submitted.rail.map((row) => [
              row.id === provisional ? durableId : String(row.id),
              row.id === provisional
                ? [...new Set([...(Array.isArray(row.labels) ? row.labels : []), 'rail'])]
                : row.id === 's2'
                  ? ['unrelated']
                  : Array.isArray(row.labels)
                    ? row.labels
                    : [],
            ]),
          );
          const postedRail = railPayload({
            sessions: providerRows,
            counts: new Map(),
            newest: new Map(),
            statuses: new Map(),
            runningSince: new Map(),
            openChildren: new Map(),
            backgroundCommands: new Map(),
            hidden: new Set(),
            showing: 's2',
            pinnedTop: new Set([durableId]),
            unsent: new Map(),
            parsedStats: {},
            metadataStats: {},
            lifetimeStats: {},
            lifetimeCosts: {},
            labels: providerLabels,
            caches: {},
            views: submitted.views as [],
            railFilters: submitted.railFilters as [],
            now: NOW,
          });
          await page.evaluate(
            `window.postMessage(${JSON.stringify({
              type: 'rail',
              ...postedRail,
              hidden: [],
              pinnedTop: [durableId],
            })}, '*')`,
          );
          await page.evaluate(SETTLED);
          assert.ok(
            (await page.locator(`#rail [data-session="${provisional}"]`).count()) > 0,
            `an unmapped rail update discarded the last coherent provisional row at ${width}px`,
          );
          await page.evaluate(
            `window.postMessage(${JSON.stringify({
              type: 'rail',
              ...postedRail,
              sessionAdoptions: [{ provisional, durable: durableId }],
              hidden: [],
              pinnedTop: [durableId],
            })}, '*')`,
          );
          await page.evaluate(SETTLED);
          const interimRail = (await page.evaluate(`(() => ({
        provisional: !!document.querySelector('#rail [data-session="draft:s1"]'),
        durable: !!document.querySelector('#rail [data-session="thread-one"]'),
        unrelated: !!document.querySelector('#rail [data-session="s2"]'),
        pinned: !!document.querySelector('#rail .railrow:has([data-session="draft:s1"]) .railpin.is-pinned'),
        labels: document.querySelector('#rail [data-session="draft:s1"]')?.getAttribute('aria-label') || '',
        unrelatedLabels: document.querySelector('#rail [data-session="s2"]')?.getAttribute('aria-label') || '',
        headingLabels: document.querySelector('#list .sessionlabels')?.textContent || '',
      }))()`)) as {
            provisional: boolean;
            durable: boolean;
            unrelated: boolean;
            pinned: boolean;
            labels: string;
            unrelatedLabels: string;
            headingLabels: string;
          };
          assert.equal(
            interimRail.provisional,
            true,
            `the provider rail update removed the retained provisional row at ${width}px`,
          );
          assert.equal(
            interimRail.durable,
            false,
            `the provider rail update introduced the durable row before the complete render at ${width}px`,
          );
          assert.equal(
            interimRail.unrelated,
            true,
            `the provider rail update renamed the unrelated current row at ${width}px`,
          );
          assert.equal(
            interimRail.pinned,
            true,
            `the provider rail update lost the durable pin on the provisional row at ${width}px`,
          );
          assert.ok(
            interimRail.labels.includes('rail') && interimRail.headingLabels.includes('rail'),
            `the provider rail update lost the durable label on the provisional shell at ${width}px`,
          );
          assert.ok(
            interimRail.unrelatedLabels.includes('unrelated') && !interimRail.labels.includes('unrelated'),
            `the unrelated current row overwrote the provisional row labels at ${width}px`,
          );

          await page.evaluate(`(() => {
        const missing = [];
        const inspect = () => {
          const visible = (selector) => {
            const node = document.querySelector(selector);
            return !!node && !node.closest('[hidden]') && node.getClientRects().length > 0;
          };
          for (const [name, selector] of [
            ['composer', '#composer'], ['heading', '#list .sessionrow'],
            ['labels', '#list .sessionlabels'], ['pending prompt', '#list .clive, #list .turn'],
          ]) {
            if (!visible(selector)) missing.push(name);
          }
          if ([...document.querySelectorAll('#list .empty')]
            .some((node) => node.textContent === 'Start this session with a prompt.')) {
            missing.push('first-prompt diagnosis');
          }
        };
        window.__firstPromptMissing = missing;
        window.__firstPromptObserver = new MutationObserver(inspect);
        window.__firstPromptObserver.observe(document.body, {
          childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'style', 'class'],
        });
        window.__firstPromptNodes = {
          composer: document.getElementById('composer'), prompt: document.getElementById('prompt'),
          heading: document.querySelector('#list .sessionrow'), labels: document.querySelector('#list .sessionlabels'),
          pending: document.querySelector('#list .clive, #list .turn'), labelpop: document.getElementById('labelpop'),
        };
        inspect();
      })()`);
          const interim = JSON.parse(JSON.stringify(submitted.usage));
          interim.composer = null;
          await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'usage', usage: interim })}, '*')`);
          await page.evaluate(SETTLED);
          const held = (await page.evaluate(`(() => {
        const before = window.__firstPromptNodes;
        const same = (name, node) => before[name] === node;
        return {
          nodes: {
            composer: same('composer', document.getElementById('composer')),
            prompt: same('prompt', document.getElementById('prompt')),
            heading: same('heading', document.querySelector('#list .sessionrow')),
            labels: same('labels', document.querySelector('#list .sessionlabels')),
            pending: same('pending', document.querySelector('#list .clive, #list .turn')),
            labelpop: same('labelpop', document.getElementById('labelpop')),
          },
          draft: document.getElementById('prompt').value,
          focused: document.activeElement && document.activeElement.dataset.control,
          labelFilter: document.querySelector('#labelpop .labelfind').value,
          labelOpen: !document.getElementById('labelpop').hidden,
          labelChecked: document.querySelector('#labelpop input[data-control="label:rail"]').checked,
          headingLabels: document.querySelector('#list .sessionlabels').textContent,
        };
      })()`)) as {
            nodes: Record<string, boolean>;
            draft: string;
            focused: string | null;
            labelFilter: string;
            labelOpen: boolean;
            labelChecked: boolean;
            headingLabels: string;
          };
          assert.ok(
            Object.values(held.nodes).every(Boolean),
            `the interim durable composer remounted the provisional shell at ${width}px`,
          );
          assert.equal(held.draft, '');
          assert.equal(held.focused, 'label-find');
          assert.equal(held.labelFilter, 'ra');
          assert.equal(held.labelOpen, true);
          assert.equal(held.labelChecked, true);
          assert.ok(held.headingLabels.includes('rail'));
          await page
            .locator(`#rail [data-session="${provisional}"]`)
            .first()
            .evaluate((node: HTMLElement) => node.click());
          assert.deepEqual(
            await page.evaluate(`window.__posted.filter((message) => message.type === 'showSession').at(-1)`),
            { type: 'showSession', session: provisional },
            `the projected rail changed the provisional row action at ${width}px`,
          );
          await page
            .locator('#rail [data-session="s2"]')
            .first()
            .evaluate((node: HTMLElement) => node.click());
          assert.deepEqual(
            await page.evaluate(`window.__posted.filter((message) => message.type === 'showSession').at(-1)`),
            { type: 'showSession', session: 's2' },
            `the projected rail changed the unrelated row action at ${width}px`,
          );
          const durableSource = renderPayload([], [], [], [], [], ['s1']) as Record<string, unknown> & {
            rail: Array<Record<string, unknown>>;
          };
          durableSource.rail = durableSource.rail.map((row) =>
            row.id === 's1' ? { ...row, labels: [...new Set([...((row.labels as string[]) ?? []), 'rail'])] } : row,
          );
          const durable = JSON.parse(
            JSON.stringify(durableSource).replaceAll(JSON.stringify('s1'), JSON.stringify(durableId)),
          );
          durable.usage.composer.agent = agent;
          durable.rail = durable.rail.map((row: Record<string, unknown>) =>
            row.id === durableId ? { ...row, agent: agent === 'claude' ? 'Claude' : 'Codex', agentKey: agent } : row,
          );
          durable.sessionAdoptions = [{ provisional, durable: durableId }];
          const prompt = page.locator('#prompt');
          await prompt.focus();
          await prompt.type('follow-up draft');
          await prompt.type(' stays');
          await prompt.evaluate((node: HTMLTextAreaElement) => {
            node.setSelectionRange(3, 9);
            document.dispatchEvent(new Event('selectionchange'));
          });
          assert.equal(
            await page.evaluate(`window.__posted.filter((message) => message.type === 'sendPrompt').length`),
            1,
            `the follow-up was sent before the stale durable render at ${width}px`,
          );
          await page.evaluate(`window.postMessage(${JSON.stringify(durable)}, '*')`);
          await page.evaluate(SETTLED);
          assert.equal(
            await prompt.inputValue(),
            'follow-up draft stays',
            `the stale durable render replaced the local follow-up at ${width}px`,
          );
          assert.deepEqual(
            await prompt.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd]),
            [3, 9],
            `the durable identity change replaced the follow-up selection at ${width}px`,
          );
          assert.equal(
            await prompt.evaluate((node) => document.activeElement === node),
            true,
            `the durable identity change moved focus out of the follow-up at ${width}px`,
          );
          await prompt.press('Control+z');
          assert.notEqual(
            await prompt.inputValue(),
            'follow-up draft stays',
            `the durable identity change discarded the follow-up undo state at ${width}px`,
          );
          await prompt.press('Control+Shift+z');
          assert.equal(
            await prompt.inputValue(),
            'follow-up draft stays',
            `the durable identity change discarded the follow-up redo state at ${width}px`,
          );
          await prompt.press('Enter');
          const secondSend = (await page.evaluate(
            `window.__posted.filter((message) => message.type === 'sendPrompt').at(-1)`,
          )) as {
            session: string;
            revision: number;
          };
          assert.equal(
            secondSend.session,
            durableId,
            `the adopted follow-up did not target the durable session at ${width}px`,
          );
          assert.ok(
            secondSend.revision > firstSend.revision,
            `the durable identity change reset the follow-up revision at ${width}px`,
          );
          const missing = (await page.evaluate(`(() => {
        window.__firstPromptObserver.disconnect();
        return window.__firstPromptMissing;
      })()`)) as string[];
          assert.deepEqual(
            missing,
            [],
            `the first-prompt shell became incomplete at ${width}px: ${[...new Set(missing)].join(', ')}`,
          );
          assert.equal(
            await page.locator('#list .sessionrow').getAttribute('data-session'),
            durableId,
            `the durable render did not replace the provisional heading at ${width}px`,
          );
          assert.ok(
            ((await page.locator('#list .sessionlabels').textContent()) ?? '').includes('rail'),
            `the durable heading lost the label applied during adoption at ${width}px`,
          );
          assert.equal(
            await page
              .locator('#rail .railrow:has(.railcard[data-session="thread-one"]) .railpin')
              .evaluateAll((nodes) => nodes.length > 0 && nodes.every((node) => node.classList.contains('is-pinned'))),
            true,
            `the durable rail row lost its pin at ${width}px`,
          );
          assert.deepEqual(failures, [], `the first-prompt transition threw at ${width}px`);
          await page.close();
        }
    } finally {
      await browser.close();
    }
  },
);

test('the panel lays out with the rail beside the list, not above it', { timeout: 60_000 }, async (t) => {
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

    // The wide viewport displays the session list beside the timeline.
    const wide = await layoutAt(page, 1350);
    assert.deepEqual(failures, [], 'the panel threw while drawing');
    assert.ok(wide.rail, `the rail is not drawn at 1350px, so this measures nothing`);
    assert.ok(
      wide.list.left >= wide.rail.right - 1,
      `the list starts at ${wide.list.left} and the rail ends at ${wide.rail.right}: they overlap`,
    );
    // Compare timeline top with session list bottom because sticky positioning can change the session list's top.

    assert.ok(
      wide.list.top < wide.rail.bottom,
      `the list starts at ${Math.round(wide.list.top)} and the rail ends at ${Math.round(wide.rail.bottom)}: ` +
        'the list wrapped onto a line of its own below the rail',
    );

    // The timeline begins within the initial viewport.

    assert.ok(
      wide.list.top < 200,
      `the top of the timeline is ${Math.round(wide.list.top)}px down the page, so the panel opens blank`,
    );
    assert.deepEqual(
      await page.evaluate(`(() => {
      const node = document.querySelector('#list .sessionsection > .sessionrow');
      const style = getComputedStyle(node);
      return { marginTop: style.marginTop, borderTopWidth: style.borderTopWidth };
    })()`),
      { marginTop: '0px', borderTopWidth: '0px' },
      'the first wide session heading adds a separator above the timeline',
    );

    // The narrow control bar remains mounted but occupies no space at wide width.

    assert.deepEqual(
      wide.controls,
      { top: 0, left: 0, right: 0, bottom: 0 },
      'a control bar is drawn beside the rail, where it holds nothing',
    );
    const firstCard = (await page.evaluate(
      `(() => { const e = [...document.querySelectorAll('#list .timeline-tree > *')].find((node) => node.getClientRects().length); return e ? e.className : null; })()`,
    )) as string | null;
    assert.ok(
      firstCard !== null && !firstCard.includes('controls'),
      `the list opens on "${firstCard}" rather than on the timeline itself`,
    );

    // The account status bar spans the panel's bottom edge.

    assert.ok(
      wide.statusbar.bottom >= 899,
      `the status bar ends ${Math.round(900 - wide.statusbar.bottom)}px above the panel bottom edge`,
    );
    assert.ok(
      wide.statusbar.right - wide.statusbar.left > wide.viewportWidth - 20,
      'the status bar does not span the panel',
    );

    // The Prompt box sits above the status bar within the session view.

    assert.ok(
      wide.composer.bottom <= wide.statusbar.top + 1,
      `the composer ends at ${Math.round(wide.composer.bottom)} with the bar starting at ` +
        `${Math.round(wide.statusbar.top)}, so one is drawn over the other`,
    );
    assert.ok(
      wide.composer.left >= wide.rail.right - 1,
      `the composer starts at ${Math.round(wide.composer.left)} and the rail ends at ` +
        `${Math.round(wide.rail.right)}: the composer covers the rail`,
    );
    assert.ok(wide.composer.right > wide.viewportWidth - 20, 'the composer stops short of the panel right edge');

    // The independently scrolling session list ends above the status bar.

    assert.ok(
      wide.rail.bottom <= wide.statusbar.top + 1,
      `the rail ends at ${Math.round(wide.rail.bottom)} with the bar starting at ` +
        `${Math.round(wide.statusbar.top)}: the rail runs behind the status bar`,
    );

    // Scroll the panel before measuring sticky offsets.

    const scrolled = await scrolledLayout(page, 400);
    for (const [what, top] of Object.entries(scrolled.tops)) {
      assert.ok(
        top >= -1,
        `${what} is drawn at ${Math.round(top)}, above the top of the panel, so the reader loses it on a scroll`,
      );
      assert.ok(
        top <= scrolled.barTop - 1,
        `${what} is drawn at ${Math.round(top)} with the status bar starting at ${Math.round(scrolled.barTop)}, ` +
          'so the bar covers it once the reader scrolls',
      );
    }
    // The scrolled session list still clears the status bar.

    assert.ok(
      scrolled.bottoms['the rail'] <= scrolled.barTop + 1,
      `the rail ends at ${Math.round(scrolled.bottoms['the rail'])} with the status bar starting at ` +
        `${Math.round(scrolled.barTop)}, so its last card is behind it`,
    );

    // Scroll to the document bottom to check that the last card clears the fixed footer.

    const atBottom = await scrolledLayout(page, 1_000_000);
    assert.ok('the last card' in atBottom.bottoms, 'the list drew no last card, so this measures nothing');
    assert.ok(
      atBottom.bottoms['the last card'] > atBottom.composerTop - 400,
      'the page did not scroll to its own bottom, so the reservation is not what is being measured',
    );
    assert.ok(
      atBottom.bottoms['the last card'] <= atBottom.composerTop + 1,
      `the last card ends at ${Math.round(atBottom.bottoms['the last card'])} with the composer starting at ` +
        `${Math.round(atBottom.composerTop)}, so the page reserves nothing for the foot and the last card is behind it`,
    );
    assert.ok(
      atBottom.tops['the rail'] >= -1,
      `the rail is drawn at ${Math.round(atBottom.tops['the rail'])} at the bottom of the page, ` +
        'above the top of the panel, so the reader loses it after the timeline ends',
    );
    assert.ok(
      atBottom.bottoms['the rail'] >= atBottom.barTop - 1,
      `the rail ends at ${Math.round(atBottom.bottoms['the rail'])} with the status bar starting at ` +
        `${Math.round(atBottom.barTop)} at the bottom of the page, so an empty gap opens under it`,
    );

    // Below the session list width boundary, the narrow bar exposes its session picker.

    const narrow = await layoutAt(page, RAIL_MIN_WIDTH - 60);
    assert.equal(narrow.rail, null, 'the rail is drawn below its own width, so this measures nothing');
    assert.ok(narrow.controls, 'no control bar below the rail width, so nothing chooses a session there');
    const picker = (await page.evaluate(
      `(() => { const s = document.querySelector('#list .controls select'); return s ? s.options.length : 0; })()`,
    )) as number;
    assert.equal(picker, 32, 'the picker does not list one option per session and nothing else');

    // A picker change posts immediately and remains selected through the confirming render.

    const chosen = await page.evaluate(`(() => {
      const current = document.querySelector('#list .controls select');
      window.__heldPicker = current;
      current.focus();
      current.value = 's2';
      current.dispatchEvent(new Event('change', { bubbles: true }));
      return window.__posted.filter((message) => message.type === 'showSession').at(-1);
    })()`);
    assert.deepEqual(
      chosen,
      { type: 'showSession', session: 's2' },
      'the compact picker sent a different session than the one chosen',
    );
    const chosenRefresh = renderPayload();
    chosenRefresh.showing = 's2';
    await page.evaluate(`window.postMessage(${JSON.stringify(chosenRefresh)}, '*')`);
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await page.evaluate(`(() => {
      const current = document.querySelector('#list .controls select');
      return {
        same: current === window.__heldPicker,
        active: document.activeElement === current,
        value: current.value,
      };
    })()`),
      { same: true, active: true, value: 's2' },
      'the focused compact picker reverted the session the reader chose',
    );

    // Retain the focused native select and its option text during background updates.

    const refresh = renderPayload();
    const refreshedSessions = refresh.sessions as Array<Record<string, unknown>>;
    refreshedSessions[1] = { ...refreshedSessions[1], when: '2:33 PM', relative: 'just now', at: NOW + 60_000 };
    await page.evaluate(`(() => {
      window.__heldPicker = document.querySelector('#list .controls select');
      window.__heldPicker.focus();
      window.__heldPickerText = window.__heldPicker.options[1].textContent;
    })()`);
    await page.evaluate(`window.postMessage(${JSON.stringify(refresh)}, '*')`);
    await page.evaluate(SETTLED);
    const heldPicker = (await page.evaluate(`(() => {
      const current = document.querySelector('#list .controls select');
      return {
        same: current === window.__heldPicker,
        active: document.activeElement === current,
        deferred: current.options[1].textContent === window.__heldPickerText,
      };
    })()`)) as { same: boolean; active: boolean; deferred: boolean };
    assert.deepEqual(
      heldPicker,
      { same: true, active: true, deferred: true },
      'a live repaint disturbed the focused session picker',
    );
    await page.evaluate('window.__heldPicker.blur()');
    await page.evaluate(SETTLED);
    const updatedAfterBlur = (await page.evaluate(
      "window.__heldPicker.options[1].textContent.includes('2:33 PM')",
    )) as boolean;
    assert.equal(updatedAfterBlur, true, 'the picker did not adopt deferred session changes after blur');

    // Also retain the focused picker when the selected session has no cards.

    const emptyRefresh = renderPayload();
    emptyRefresh.cards = [];
    const emptySessions = emptyRefresh.sessions as Array<Record<string, unknown>>;
    emptySessions[1] = { ...emptySessions[1], when: '1:34 PM', relative: 'just now', at: NOW + 120_000 };
    await page.evaluate(`(() => {
      window.__heldPicker.focus();
      window.__heldPickerText = window.__heldPicker.options[1].textContent;
    })()`);
    await page.evaluate(`window.postMessage(${JSON.stringify(emptyRefresh)}, '*')`);
    await page.evaluate(SETTLED);
    const emptyPicker = (await page.evaluate(`(() => {
      const current = document.querySelector('#list .controls select');
      return {
        same: current === window.__heldPicker,
        active: document.activeElement === current,
        deferred: current.options[1].textContent === window.__heldPickerText,
        empty: !!document.querySelector('#list .empty'),
      };
    })()`)) as { same: boolean; active: boolean; deferred: boolean; empty: boolean };
    assert.deepEqual(
      emptyPicker,
      { same: true, active: true, deferred: true, empty: true },
      'an empty-session repaint disturbed the focused session picker',
    );
    await page.evaluate('window.__heldPicker.blur()');
    await page.evaluate(SETTLED);
    const emptyUpdatedAfterBlur = (await page.evaluate(
      "window.__heldPicker.options[1].textContent.includes('1:34 PM')",
    )) as boolean;
    assert.equal(emptyUpdatedAfterBlur, true, 'the empty-session picker did not adopt deferred changes after blur');

    await page.setViewportSize({ width: 1350, height: 900 });
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await page.evaluate(`({
      same: document.querySelector('#list .controls select') === window.__heldPicker,
      connected: window.__heldPicker.isConnected,
      hidden: document.querySelector('#list .controls').hidden,
    })`),
      { same: true, connected: true, hidden: true },
      'crossing to the rail replaced the compact session picker',
    );
    await page.setViewportSize({ width: RAIL_MIN_WIDTH - 60, height: 900 });
    await page.evaluate(SETTLED);
    assert.deepEqual(
      await page.evaluate(`({
      same: document.querySelector('#list .controls select') === window.__heldPicker,
      connected: window.__heldPicker.isConnected,
      hidden: document.querySelector('#list .controls').hidden,
    })`),
      { same: true, connected: true, hidden: false },
      'returning from the rail replaced the compact session picker',
    );

    // The tested panel widths leave no horizontal page overflow.
    for (const width of [1350, RAIL_MIN_WIDTH - 60, 340]) {
      const at = await layoutAt(page, width);
      assert.ok(
        at.documentWidth <= at.viewportWidth + 1,
        `the panel scrolls sideways at ${width}px: ${at.documentWidth} wide in a ${at.viewportWidth} viewport`,
      );
      assert.ok(at.list.top < 200, `at ${width}px the timeline starts ${Math.round(at.list.top)}px down the page`);
    }
    assert.deepEqual(failures, [], 'the panel threw while drawing');
  } finally {
    await browser.close();
  }
});

test('the first session heading begins on its sticky line', { timeout: 60_000 }, async (t) => {
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
    for (const width of [1350, RAIL_MIN_WIDTH - 60]) {
      const payload = renderPayload() as { cards: Record<string, unknown>[] };
      const split = Math.floor(payload.cards.length / 2);
      for (const card of payload.cards.slice(split)) {
        card.sessionId = 's2';
        card.sessionTitle = 'Codex parity sweep';
      }
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);
      const setup = (await page.evaluate(`(() => {
        const rows = document.querySelectorAll('#list .sessionrow');
        const first = rows[0];
        const later = rows[1];
        if (!first || !later) return null;
        const laterStyle = getComputedStyle(later);
        return {
          firstTop: first.getBoundingClientRect().top,
          laterMargin: laterStyle.marginTop,
          laterBorder: laterStyle.borderTopWidth,
          scrollable: document.documentElement.scrollHeight > innerHeight + 20,
        };
      })()`)) as {
        firstTop: number;
        laterMargin: string;
        laterBorder: string;
        scrollable: boolean;
      } | null;
      assert.ok(setup, `the page drew fewer than two session headings at ${width}px, so this measures nothing`);
      assert.equal(setup.laterMargin, '6px', `the later heading lost its separator margin at ${width}px`);
      assert.equal(setup.laterBorder, '1px', `the later heading lost its separator border at ${width}px`);
      assert.equal(setup.scrollable, true, `the shared fixture does not scroll at ${width}px`);
      for (const scrollY of [0, 1, 2, 4, 6, 8, 10, 12]) {
        await page.evaluate(`window.scrollTo(0, ${scrollY})`);
        await page.evaluate(SETTLED);
        const top = (await page.evaluate(
          `document.querySelector('#list .sessionrow').getBoundingClientRect().top`,
        )) as number;
        assert.ok(
          Math.abs(top - setup.firstTop) <= 0.5,
          `the first heading moves from ${setup.firstTop}px to ${top}px at scrollY ${scrollY}px in the ${width}px layout`,
        );
      }
    }
    assert.deepEqual(failures, [], 'the panel threw while measuring the first sticky heading');
  } finally {
    await browser.close();
  }
});

test('the composer clears the status bar when the reader narrows the panel', { timeout: 60_000 }, async (t) => {
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
    // Render once, then resize without new payloads to exercise footer measurement.

    await layoutAt(page, 640);
    for (const width of [340, 380, 420, 1350, 340]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(SETTLED);
      await page.waitForFunction(() => {
        const bar = document.getElementById('statusbar');
        if (!bar) return false;
        const reserved = Number.parseFloat(document.body.style.getPropertyValue('--statusbar-height'));
        return Math.round(reserved) === Math.round(bar.getBoundingClientRect().height);
      });
      const seen = (await page.evaluate(FOOT_OVER_BAR)) as {
        over: string[];
        barTop: number;
        barHeight: number;
        reserved: string;
      };
      assert.deepEqual(failures, [], `the panel threw while resizing to ${width}px`);
      assert.equal(
        Math.round(Number.parseFloat(seen.reserved)),
        Math.round(seen.barHeight),
        `the panel reserves ${seen.reserved} for a status bar ${Math.round(seen.barHeight)}px tall at ${width}px`,
      );
      assert.deepEqual(
        seen.over,
        [],
        `${seen.over.join(' and ')} run behind the status bar at ${width}px, so Send is unreachable there`,
      );
    }
  } finally {
    await browser.close();
  }
});

test('automatic composer growth stays inside a short panel', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(pageHtml());
    await page.setViewportSize({ width: 720, height: 340 });
    await page.evaluate(`window.postMessage(${JSON.stringify(renderPayload())}, '*')`);
    await page.evaluate(SETTLED);
    await page.locator('#prompt').fill(Array.from({ length: 24 }, (_, at) => `line ${at}`).join('\n'));
    await page.evaluate(SETTLED);
    const measured = (await page.evaluate(`(() => {
      const prompt = document.getElementById('prompt').getBoundingClientRect();
      const composer = document.getElementById('composer').getBoundingClientRect();
      const heading = document.querySelector('#list .sessionrow').getBoundingClientRect();
      return { promptBottom: prompt.bottom, composerTop: composer.top, headingBottom: heading.bottom, viewport: innerHeight };
    })()`)) as { promptBottom: number; composerTop: number; headingBottom: number; viewport: number };
    assert.ok(measured.composerTop >= 0, `automatic prompt growth moved the Composer top to ${measured.composerTop}px`);
    assert.ok(
      measured.headingBottom <= measured.composerTop + 1,
      'automatic prompt growth covered the session heading',
    );
    assert.ok(
      measured.promptBottom <= measured.viewport + 1,
      'automatic prompt growth moved the text box beyond the viewport',
    );
  } finally {
    await browser.close();
  }
});

test('eight prompt lines leave the session heading visible in a short panel', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(pageHtml());
    await page.setViewportSize({ width: 720, height: 340 });
    await page.evaluate(`window.postMessage(${JSON.stringify(renderPayload())}, '*')`);
    await page.evaluate(SETTLED);
    await page.locator('#prompt').fill(Array.from({ length: 8 }, (_, at) => `line ${at}`).join('\n'));
    await page.evaluate(SETTLED);
    const measured = (await page.evaluate(`(() => {
      const prompt = document.getElementById('prompt');
      const promptBox = prompt.getBoundingClientRect();
      const promptStyle = getComputedStyle(prompt);
      const composer = document.getElementById('composer').getBoundingClientRect();
      const heading = document.querySelector('#list .sessionrow').getBoundingClientRect();
      const visibleLines = Math.ceil((promptBox.height
        - Number.parseFloat(promptStyle.paddingTop)
        - Number.parseFloat(promptStyle.paddingBottom)) / Number.parseFloat(promptStyle.lineHeight) - 1e-9);
      return {
        composerTop: composer.top,
        headingBottom: heading.bottom,
        visibleLines,
        sashLines: Number(document.getElementById('footsash').getAttribute('aria-valuenow')),
      };
    })()`)) as { composerTop: number; headingBottom: number; visibleLines: number; sashLines: number };
    assert.ok(measured.headingBottom <= measured.composerTop + 1, 'eight prompt lines covered the session heading');
    assert.equal(
      measured.sashLines,
      measured.visibleLines,
      'the Composer separator did not report the visible line count after the viewport clamp',
    );
  } finally {
    await browser.close();
  }
});

test('requested composer growth clears the active heading in a scrolled timeline', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(pageHtml());
    const payload = renderPayload() as { cards: Record<string, unknown>[] };
    const split = Math.floor(payload.cards.length / 2);
    for (const card of payload.cards.slice(split)) {
      card.sessionId = 's2';
      card.sessionTitle = 'Codex parity sweep';
    }
    await page.setViewportSize({ width: 720, height: 340 });
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
    const sash = page.locator('#footsash');
    const measured = async () =>
      (await page.evaluate(`(() => {
      const controlsBottom = document.querySelector('.controls').getBoundingClientRect().bottom;
      const rows = [...document.querySelectorAll('#list .sessionsection:not([hidden]) > .sessionrow')];
      const active = rows.find((row) => {
        const box = row.getBoundingClientRect();
        return box.bottom > controlsBottom && box.top <= controlsBottom + 2;
      });
      const composer = document.getElementById('composer').getBoundingClientRect();
      const activeBox = active?.getBoundingClientRect();
      return {
        session: active?.getAttribute('data-session') ?? null,
        headingBottom: activeBox?.bottom ?? null,
        composerTop: composer.top,
        promptBottom: document.getElementById('prompt').getBoundingClientRect().bottom,
        viewport: innerHeight,
      };
    })()`)) as {
        session: string | null;
        headingBottom: number | null;
        composerTop: number;
        promptBottom: number;
        viewport: number;
      };

    await page.evaluate(`(() => {
      const rows = document.querySelectorAll('#list .sessionrow');
      window.scrollTo(0, rows[1].offsetTop + 40);
    })()`);
    await page.evaluate(SETTLED);
    assert.equal(
      (await measured()).session,
      's2',
      'the fixture did not scroll the second session onto the sticky line',
    );

    for (const key of ['ArrowUp', 'End']) {
      await sash.focus();
      await sash.press(key);
      await page.evaluate(SETTLED);
      const foot = (await page.evaluate(FOOT_OVER_BAR)) as { over: string[] };
      assert.deepEqual(foot.over, [], `${key} put a Composer control behind the status bar`);
      const raised = (await page.evaluate(`(() => {
        const list = document.getElementById('list');
        const controlsBottom = list.querySelector('.controls').getBoundingClientRect().bottom;
        const heading = [...list.querySelectorAll('.sessionrow')].find((row) => {
          const rect = row.getBoundingClientRect();
          return rect.bottom > controlsBottom && rect.top <= controlsBottom + 2;
        });
        const foot = Number.parseFloat(document.body.style.getPropertyValue('--foot-height'));
        const padding = Number.parseFloat(getComputedStyle(list).paddingBottom);
        const box = heading.getBoundingClientRect();
        const composerTop = document.getElementById('composer').getBoundingClientRect().top;
        return {
          session: heading.getAttribute('data-session'), foot, padding,
          headingTop: box.top, headingBottom: box.bottom, composerTop, viewport: innerHeight,
        };
      })()`)) as {
        session: string;
        foot: number;
        padding: number;
        headingTop: number;
        headingBottom: number;
        composerTop: number;
        viewport: number;
      };
      assert.equal(raised.session, 's2', `${key} measured a session that was not active`);
      assert.ok(
        Math.abs(raised.padding - (raised.foot + 28)) <= 1,
        `${key} left the timeline padding out of sync with the foot`,
      );
      assert.ok(
        raised.headingTop >= 0 && raised.headingBottom <= raised.viewport,
        `${key} moved the session heading outside the viewport`,
      );
      assert.ok(raised.headingBottom <= raised.composerTop + 1, `${key} let the Composer cover the session heading`);
    }
  } finally {
    await browser.close();
  }
});

test('agent questions stay above the prompt and submit only complete answers', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    for (const width of [1350, 340]) {
      const page = await browser.newPage();
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(String(error)));
      await page.setContent(pageHtml());
      const laid = await layoutAt(page, width, [], [], [], [], [QUESTION_ASK]);
      assert.deepEqual(failures, [], `the question card threw while drawing at ${width}px`);
      assert.ok(laid.ask && laid.askArea && laid.prompt, `the question card or prompt is missing at ${width}px`);
      assert.ok(
        laid.askArea.bottom <= laid.prompt.top + 1,
        `the question area ends at ${Math.round(laid.askArea.bottom)} and the prompt starts at ${Math.round(laid.prompt.top)} at ${width}px`,
      );
      assert.ok(
        laid.ask.left >= laid.composer.left && laid.ask.right <= laid.composer.right + 1,
        `the question card leaves the session column at ${width}px`,
      );
      assert.ok(
        laid.documentWidth <= laid.viewportWidth + 1,
        `the question card makes a ${laid.documentWidth}px document in a ${laid.viewportWidth}px panel`,
      );
      assert.match(
        (await page.locator('#ask-announcer').textContent()) ?? '',
        /waiting for you/,
        `the question arrival is not announced at ${width}px`,
      );
      // Check that the history announcement region is mounted and visually hidden.

      const walkRegion = (await page.evaluate(`(() => {
        const r = document.querySelector('#walk-announcer');
        if (!r || !document.body.contains(r)) { return null; }
        const box = r.getBoundingClientRect();
        return { role: r.getAttribute('role'), live: r.getAttribute('aria-live'),
          atomic: r.getAttribute('aria-atomic'), cls: r.className,
          hidden: box.width <= 1 && box.height <= 1 };
      })()`)) as { role: string; live: string; atomic: string; cls: string; hidden: boolean } | null;
      assert.deepEqual(
        walkRegion,
        { role: 'status', live: 'polite', atomic: 'true', cls: 'sr-only', hidden: true },
        `the walk has no live region of its own in the page at ${width}px`,
      );
      // An empty Prompt box omits wording that promises to answer waiting requests.

      assert.equal(
        await page.evaluate(`!!document.querySelector('.csendover')`),
        false,
        `the composer promises to answer the request over a press that sends nothing at ${width}px`,
      );
      const typedUsage = (
        renderPayload([], [], [], [], [QUESTION_ASK]) as {
          usage: { composer: Record<string, unknown> };
        }
      ).usage;
      typedUsage.composer.draft = 'neither of those, keep the gap where it is';
      typedUsage.composer.sendOverAsk = 'Send answers the request above with this prompt.';
      // The manual usage payload enables Send when it supplies answer-request wording.

      (typedUsage.composer.box as Record<string, unknown>).actionEnabled = true;
      await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'usage', usage: typedUsage })}, '*')`);
      await page.evaluate(SETTLED);
      const overAsk = (await page.evaluate(`(() => {
        const banner = document.querySelector('.csendover');
        const region = document.querySelector('#send-announcer');
        const send = document.querySelector('.csend');
        const row = document.querySelector('.cpicks').getBoundingClientRect();
        const rowStyle = getComputedStyle(document.querySelector('.cpicks'));
        const at = send.getBoundingClientRect();
        const words = banner ? banner.getBoundingClientRect() : null;
        return {
          said: banner ? banner.textContent : null,
          // Beside the button on a row that holds both, and above it on a row too narrow for
          // that. Either way the sentence comes first and Send keeps the end of the row.
          beside: !!(words && (words.right <= at.left + 1 || words.bottom <= at.top + 1)),
          sendAligned: Math.abs(at.right - (row.right - parseFloat(rowStyle.paddingRight))) <= 1,
          region: region ? region.getAttribute('role') + ' ' + region.getAttribute('aria-live') + ' ' + region.className : null,
          spoken: region ? region.textContent : null,
        };
      })()`)) as {
        said: string;
        beside: boolean;
        sendAligned: boolean;
        region: string;
        spoken: string;
      };
      assert.equal(
        overAsk.said,
        'Send answers the request above with this prompt.',
        `the composer does not draw what Send will do to the waiting request at ${width}px`,
      );
      assert.equal(overAsk.beside, true, `the sentence is not drawn before Send at ${width}px`);
      assert.equal(
        overAsk.sendAligned,
        true,
        `the sentence beside Send moved the button away from its inset edge at ${width}px`,
      );
      assert.equal(
        overAsk.region,
        'status polite sr-only',
        `the send banner has no live region of its own at ${width}px`,
      );
      // The Send announcement region reports the updated request-answer wording.

      assert.equal(
        overAsk.spoken,
        'Send answers the request above with this prompt.',
        `the sentence beside Send changed under the reader with nothing saying so at ${width}px`,
      );
      // Browser file staging disables Send and removes its request-answer wording.

      const stagingToken = 'action-stage';
      // Staging retains the Send button while removing its unusable keyboard shortcut.

      const keysBeforeStaging = (await page.evaluate(
        `document.querySelector('.csend').getAttribute('aria-keyshortcuts')`,
      )) as string | null;
      assert.ok(keysBeforeStaging, `the send control announces no key shortcut at ${width}px`);
      await page.evaluate(
        `window.postMessage(${JSON.stringify({ type: 'fileStaging', session: 's1', token: stagingToken, pending: true })}, '*')`,
      );
      await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'usage', usage: typedUsage })}, '*')`);
      await page.evaluate(SETTLED);
      const staging = (await page.evaluate(`(() => {
        const send = document.querySelector('.csend');
        return {
          disabled: send.disabled,
          banner: !!document.querySelector('.csendover'),
          name: send.getAttribute('aria-label'),
          hint: send.dataset.hint,
          hintDetail: send.dataset.hintDetail,
          keys: send.getAttribute('aria-keyshortcuts'),
        };
      })()`)) as {
        disabled: boolean;
        banner: boolean;
        name: string;
        hint: string;
        hintDetail: string;
        keys: string | null;
      };
      assert.equal(staging.disabled, true, `attaching a file left Send pressable at ${width}px`);
      assert.equal(
        staging.banner,
        false,
        `the composer promises to answer the request beside a Send disabled by an attachment at ${width}px`,
      );
      assert.equal(
        staging.name,
        typedUsage.composer.filePendingName,
        `the disabled icon does not name the attachment wait at ${width}px`,
      );
      assert.equal(
        staging.hint,
        (typedUsage.composer.box as Record<string, unknown>).actionLabel,
        `the disabled icon has no visible Send hint at ${width}px`,
      );
      assert.equal(
        staging.hintDetail,
        typedUsage.composer.filePendingName,
        `the disabled icon hint does not explain the attachment wait at ${width}px`,
      );
      assert.equal(
        staging.keys,
        null,
        `the disabled icon still announces the send chord while a file attaches at ${width}px`,
      );
      await page.evaluate(
        `window.postMessage(${JSON.stringify({ type: 'fileStaging', session: 's1', token: stagingToken, pending: false })}, '*')`,
      );
      await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'usage', usage: typedUsage })}, '*')`);
      await page.evaluate(SETTLED);
      assert.equal(
        await page.evaluate(`!!document.querySelector('.csendover')`),
        true,
        `the sentence did not come back once the attachment finished at ${width}px`,
      );
      assert.equal(
        await page.evaluate(`document.querySelector('.csend').getAttribute('aria-keyshortcuts')`),
        keysBeforeStaging,
        `the send chord was not announced again once the attachment finished at ${width}px`,
      );
      await page.evaluate(`(() => {
        window.__askAnnouncementChanges = 0;
        new MutationObserver((records) => { window.__askAnnouncementChanges += records.length; })
          .observe(document.querySelector('#ask-announcer'), { childList: true, characterData: true, subtree: true });
      })()`);
      await page.locator('.caskanswer').scrollIntoViewIfNeeded();
      const visibleAnswer = await page.evaluate(`(() => {
        const area = document.querySelector('.casks').getBoundingClientRect();
        const answer = document.querySelector('.caskanswer').getBoundingClientRect();
        return answer.top >= area.top - 1 && answer.bottom <= area.bottom + 1;
      })()`);
      assert.equal(visibleAnswer, true, `the Answer control cannot be reached in the question area at ${width}px`);

      // The request state word stays within the card without overlapping its title.

      const headRow = (await page.evaluate(`(() => {
        const card = document.querySelector('.cask');
        const title = card.querySelector('.casktitle');
        const state = card.querySelector('.caskstate');
        if (!title || !state) { return null; }
        const box = card.getBoundingClientRect();
        const t = title.getBoundingClientRect();
        const w = state.getBoundingClientRect();
        return {
          word: state.textContent,
          inside: w.left >= box.left - 1 && w.right <= box.right + 1,
          clear: w.left >= t.right - 1 || w.top >= t.bottom - 1,
        };
      })()`)) as { word: string; inside: boolean; clear: boolean } | null;
      assert.deepEqual(
        headRow,
        { word: 'needs input', inside: true, clear: true },
        `the request card draws its state word wrong at ${width}px`,
      );

      const before = (await page.evaluate(`(() => {
        const button = document.querySelector('.caskanswer');
        return { label: button.textContent, disabled: button.disabled, name: button.getAttribute('aria-label') };
      })()`)) as { label: string; disabled: boolean; name: string };
      assert.deepEqual(
        before,
        {
          label: 'Next',
          disabled: true,
          name: 'Answer every question first',
        },
        `the request card opens on the wrong action at ${width}px`,
      );
      // The card shows one question and provides a tab for each question.
      assert.deepEqual(
        (await drawnQuestions(page)).map((question) => question.trim()),
        ['Which implementation approach should the agent take?'],
        `the card draws more than the question the reader is on at ${width}px`,
      );
      assert.deepEqual(
        await tabFaces(page),
        [
          { name: 'Approach', value: '', chosen: true, stop: 0 },
          { name: 'Checks', value: '', chosen: false, stop: -1 },
        ],
        `the strip does not report the two questions at ${width}px`,
      );
      // The action row identifies the current question and total.

      assert.equal(
        await page.evaluate(`document.querySelector('.cask .caskwait').textContent`),
        'Question 1 of 2',
        `the card does not say which question the reader is on at ${width}px`,
      );
      // Address the choice by its control identity because answering changes the visible question.

      await page.locator('[data-control="ask:layout-ask:approach:Small change"]').click();
      // A single-choice answer advances to the next unanswered question and moves focus.

      assert.deepEqual(
        (await drawnQuestions(page)).map((question) => question.trim()),
        ['Which additional checks should run before the agent continues?'],
        `a single-choice answer did not move to the next question at ${width}px`,
      );
      assert.deepEqual(
        await tabFaces(page),
        [
          { name: 'Approach', value: 'Small change', chosen: false, stop: -1 },
          { name: 'Checks', value: '', chosen: true, stop: 0 },
        ],
        `the strip does not report the answer already taken at ${width}px`,
      );
      assert.equal(
        await page.evaluate(`document.activeElement && document.activeElement.dataset.control`),
        'asktab:layout-ask:checks',
        `the automatic move left the reader's focus off the page at ${width}px`,
      );
      // Question navigation uses its own announcement region.

      // Advance the controlled clock through the announcement's zero-delay timer.

      await page.clock.fastForward(0);
      // Resume real-time clock progression for later request timers.
      await page.clock.resume();
      assert.equal(
        (await page.locator('#walk-announcer').textContent()) ?? '',
        'Question 2 of 2. Which additional checks should run before the agent continues?',
        `the automatic move is announced nowhere at ${width}px`,
      );
      assert.deepEqual(
        await pickedRows(page),
        [false, false, false],
        `the card carried the first question's mark onto the second at ${width}px`,
      );
      const repaintedUsage = (
        renderPayload([], [], [], [], [QUESTION_ASK]) as {
          usage: { bar: unknown };
        }
      ).usage;
      repaintedUsage.bar = null;
      await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'usage', usage: repaintedUsage })}, '*')`);
      await page.evaluate(SETTLED);
      assert.equal(
        await page.evaluate(`window.__askAnnouncementChanges`),
        0,
        `the same question was announced again on a foot repaint at ${width}px`,
      );
      assert.deepEqual(
        (await drawnQuestions(page)).map((question) => question.trim()),
        ['Which additional checks should run before the agent continues?'],
        `a foot repaint forgot which question the reader was on at ${width}px`,
      );
      assert.deepEqual(
        (await tabFaces(page))[0],
        { name: 'Approach', value: 'Small change', chosen: false, stop: -1 },
        `a foot repaint forgot the first answer at ${width}px`,
      );
      assert.equal(
        await page.evaluate(`document.activeElement && document.activeElement.dataset.control`),
        'asktab:layout-ask:checks',
        `a foot repaint took focus from the tab the reader was standing on at ${width}px`,
      );
      const awayUsage = JSON.parse(JSON.stringify(repaintedUsage)) as typeof repaintedUsage & {
        composer: { sessionId: string; asks: unknown[] };
      };
      awayUsage.composer.sessionId = 's2';
      awayUsage.composer.asks = [];
      await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'usage', usage: awayUsage })}, '*')`);
      await page.evaluate(SETTLED);
      assert.equal(
        await page.locator('.cask').count(),
        0,
        `the request remained on screen after the composer moved to another session at ${width}px`,
      );
      await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'usage', usage: repaintedUsage })}, '*')`);
      await page.evaluate(SETTLED);
      assert.deepEqual(
        (await drawnQuestions(page)).map((question) => question.trim()),
        ['Which additional checks should run before the agent continues?'],
        `returning to a pending request reopened its first question at ${width}px`,
      );
      assert.deepEqual(
        (await tabFaces(page))[0],
        { name: 'Approach', value: 'Small change', chosen: false, stop: -1 },
        `returning to a pending request forgot its unfinished answer at ${width}px`,
      );
      await page.locator('[data-control="ask:layout-ask:checks:Browser layout"]').click();
      // Multi-select answers remain on the question until the reader advances.

      assert.deepEqual(
        (await drawnQuestions(page)).map((question) => question.trim()),
        ['Which additional checks should run before the agent continues?'],
        `a multi-select answer moved the card off the question at ${width}px`,
      );
      // Selected choices retain their marks.

      assert.deepEqual(
        await pickedRows(page),
        [true, false, false],
        `the taken choice row is not marked at ${width}px`,
      );
      const ready = (await page.evaluate(`(() => {
        const button = document.querySelector('.caskanswer');
        return { label: button.textContent, disabled: button.disabled, name: button.getAttribute('aria-label') };
      })()`)) as { label: string; disabled: boolean; name: string };
      assert.deepEqual(
        ready,
        {
          label: 'Answer',
          disabled: false,
          name: 'Answer all 2 agent questions',
        },
        `the action does not send once every question has an answer at ${width}px`,
      );
      assert.equal(
        await page.evaluate(`document.querySelector('.cask .caskwait').textContent`),
        'Question 2 of 2',
        `the line beside the action does not follow the question on screen at ${width}px`,
      );
      await page.evaluate(`document.querySelector('.caskanswer').click()`);
      const answers = (await page.evaluate(
        `window.__posted.filter((message) => message.type === 'answerAsk')`,
      )) as unknown[];
      assert.deepEqual(answers, [
        {
          type: 'answerAsk',
          session: 's1',
          id: 'layout-ask',
          answer: {
            decision: 'answer',
            answers: {
              approach: { labels: ['Small change'], written: '' },
              checks: { labels: ['Browser layout'], written: '' },
            },
          },
        },
      ]);
      assert.equal(
        await page.evaluate(`document.querySelector('.caskanswer').disabled`),
        true,
        'the pressed answer stayed enabled while the host was resolving it',
      );

      await page.locator('#prompt').focus();
      const permissionUsage = (
        renderPayload([], [], [], [], [PERMISSION_ASK, SECOND_PERMISSION_ASK]) as {
          usage: unknown;
        }
      ).usage;
      await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'usage', usage: permissionUsage })}, '*')`);
      await page.evaluate(SETTLED);
      assert.equal(
        await page.evaluate(`document.activeElement && document.activeElement.id`),
        'prompt',
        `a permission arriving at ${width}px took focus from the prompt`,
      );
      assert.match(
        (await page.locator('#ask-announcer').textContent()) ?? '',
        /Bash wants to run/,
        `the permission arrival is not announced at ${width}px`,
      );
      const firstPermission = page.locator('.cask[data-ask="layout-permission"]');
      const command = firstPermission.locator('pre.caskcode code');
      assert.equal(await command.count(), 1, `the Bash command is not a code block at ${width}px`);
      assert.equal(
        await command.textContent(),
        PERMISSION_COMMAND,
        `the Bash command changed while it was drawn at ${width}px`,
      );
      const commandLayout = (await page.evaluate(`(() => {
        const block = document.querySelector('.cask[data-ask="layout-permission"] pre.caskcode');
        const card = block.closest('.cask').getBoundingClientRect();
        const box = block.getBoundingClientRect();
        const style = getComputedStyle(block);
        return {
          left: box.left, right: box.right, cardLeft: card.left, cardRight: card.right,
          whiteSpace: style.whiteSpace, fontFamily: style.fontFamily,
        };
      })()`)) as {
        left: number;
        right: number;
        cardLeft: number;
        cardRight: number;
        whiteSpace: string;
        fontFamily: string;
      };
      assert.equal(commandLayout.whiteSpace, 'pre-wrap');
      assert.match(
        commandLayout.fontFamily.toLowerCase(),
        /mono/,
        `the Bash command does not use the editor code face at ${width}px`,
      );
      assert.ok(
        commandLayout.left >= commandLayout.cardLeft - 1 && commandLayout.right <= commandLayout.cardRight + 1,
        `the Bash command leaves its request card at ${width}px`,
      );
      assert.ok(
        await page.evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 1`),
        `the Bash command widens the ${width}px panel`,
      );
      assert.deepEqual(await firstPermission.locator('.caskaction').allTextContents(), ['Allow', 'Deny']);
      await firstPermission.locator('.caskaction.deny').focus();
      await firstPermission.locator('.caskaction.deny').click();
      const permissionAnswers = (await page.evaluate(
        `window.__posted.filter((message) => message.type === 'answerAsk' && message.id === 'layout-permission')`,
      )) as unknown[];
      assert.deepEqual(permissionAnswers, [
        {
          type: 'answerAsk',
          session: 's1',
          id: 'layout-permission',
          answer: {
            decision: 'deny',
            reason: 'The reader refused this from the panel.',
          },
        },
      ]);
      await page.evaluate(
        `window.postMessage(${JSON.stringify({
          type: 'askRejected',
          session: 's1',
          id: 'layout-permission',
        })}, '*')`,
      );
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.evaluate(`(() => {
        const active = document.activeElement;
        return {
          control: active && active.dataset.control,
          disabled: document.querySelector('[data-control="ask:layout-permission:deny"]').disabled,
        };
      })()`),
        { control: 'ask:layout-permission:deny', disabled: false },
        `a rejected answer did not restore its enabled control and focus at ${width}px`,
      );
      const secondUsage = (renderPayload([], [], [], [], [SECOND_PERMISSION_ASK]) as { usage: unknown }).usage;
      await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'usage', usage: secondUsage })}, '*')`);
      await page.evaluate(SETTLED);
      assert.equal(
        await page.evaluate(`document.activeElement && document.activeElement.dataset.control`),
        'ask:layout-permission-2:allow',
        `resolving one request did not move focus to the next request at ${width}px`,
      );
      await page.locator('[data-control="ask:layout-permission-2:allow"]').click();
      await page.locator('#prompt').focus();
      const noAskUsage = (renderPayload() as { usage: unknown }).usage;
      await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'usage', usage: noAskUsage })}, '*')`);
      await page.evaluate(SETTLED);
      assert.equal(
        await page.evaluate(`document.activeElement && document.activeElement.id`),
        'prompt',
        `resolving the last request took focus from the prompt at ${width}px`,
      );
      await page.locator('#prompt').evaluate((prompt) => (prompt as HTMLElement).blur());
      await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'usage', usage: noAskUsage })}, '*')`);
      await page.evaluate(SETTLED);
      assert.equal(
        await page.evaluate(`document.activeElement && document.activeElement.tagName`),
        'BODY',
        `an old request submission focused the prompt after the reader moved elsewhere at ${width}px`,
      );
      // Deliver rapid requests through separate messages and a shared task to exercise announcement ordering.

      const rapid = (count: number) =>
        (
          renderPayload([], [], [], [], RAPID_PERMISSION_ASKS.slice(0, count)) as {
            usage: unknown;
          }
        ).usage;
      await page.evaluate(`(() => {
        const region = document.querySelector('#ask-announcer');
        const later = new MutationObserver(() => {
          if (!region.textContent.includes('first-rapid-request')) { return; }
          later.disconnect();
          window.postMessage(${JSON.stringify({ type: 'usage', usage: rapid(2) })}, '*');
          window.postMessage(${JSON.stringify({ type: 'usage', usage: rapid(3) })}, '*');
        });
        later.observe(region, { childList: true, characterData: true, subtree: true });
        window.postMessage(${JSON.stringify({ type: 'usage', usage: rapid(1) })}, '*');
      })()`);
      await page.waitForFunction(() =>
        (document.querySelector('#ask-announcer')?.textContent ?? '').includes('third-rapid-request'),
      );
      const rapidAnnouncement = (await page.locator('#ask-announcer').textContent()) ?? '';
      assert.match(
        rapidAnnouncement,
        /first-rapid-request/,
        `a request that arrived next took the place of the first request's announcement at ${width}px`,
      );
      assert.match(
        rapidAnnouncement,
        /second-rapid-request/,
        `the second of three rapid requests was not announced at ${width}px`,
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('one question is on screen and the strip carries the rest', { timeout: 60_000 }, async (t) => {
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
    await layoutAt(page, 620, [], [], [], [], [THREE_QUESTION_ASK]);
    assert.deepEqual(failures, [], 'the three-question card threw while drawing');
    assert.deepEqual(
      (await drawnQuestions(page)).map((question) => question.trim()),
      ['Which part of the panel should this change cover?'],
      'the card draws more than the question the reader is on',
    );
    assert.deepEqual(
      (await tabFaces(page)).map((tab) => tab.chosen),
      [true, false, false],
      'the strip does not open on the first question',
    );
    // The tab holds the short question label without repeating it in the legend.

    assert.equal(
      await page.evaluate(`document.querySelectorAll('.cask .caskkey').length`),
      0,
      'the short label is drawn on the tab and again as a chip in the legend under it',
    );
    assert.deepEqual(
      (await tabFaces(page)).map((tab) => tab.name),
      THREE_QUESTION_ASK.questions.map((question) => question.header),
      'the strip does not carry the short label the legend gave up',
    );

    // Arrow navigation changes the selected question.

    await page.locator('[data-control="asktab:layout-three:scope"]').focus();
    await page.keyboard.press('ArrowRight');
    assert.deepEqual(
      (await drawnQuestions(page)).map((question) => question.trim()),
      ['How should the strip behave once the questions no longer fit across one row?'],
      'the right arrow did not move to the next question',
    );
    assert.equal(
      await page.evaluate(`document.activeElement && document.activeElement.dataset.control`),
      'asktab:layout-three:strip',
      'the right arrow left focus on the tab it moved off',
    );
    await page.keyboard.press('End');
    assert.deepEqual(
      (await tabFaces(page)).map((tab) => tab.chosen),
      [false, false, true],
      'End did not reach the last question',
    );
    await page.keyboard.press('Home');
    assert.deepEqual(
      (await tabFaces(page)).map((tab) => tab.chosen),
      [true, false, false],
      'Home did not reach the first question',
    );
    // The strip shares one Tab stop after the fold control.

    await page.locator('[data-control="askfold:layout-three"]').focus();
    await page.keyboard.press('Tab');
    assert.equal(
      await page.evaluate(`document.activeElement && document.activeElement.dataset.control`),
      'asktab:layout-three:scope',
      'Tab out of the fold does not reach the question the reader is on',
    );
    await page.keyboard.press('Tab');
    assert.equal(
      await page.evaluate(`document.activeElement && document.activeElement.dataset.control`),
      'ask:layout-three:scope:The request card alone',
      'Tab out of the strip stops on a second tab rather than reaching the question',
    );

    // Other opens a written-answer field below its choice row.

    await page.locator('[data-control="ask:layout-three:scope:Other"]').click();
    const box = page.locator('[data-control="askwritten:layout-three:scope"]');
    assert.equal(await box.count(), 1, 'taking Other opened no box to answer in');
    await box.fill('   ');
    assert.equal(
      await page.evaluate(`document.querySelector('.caskanswer').disabled`),
      true,
      'a box holding nothing but spaces counted as an answer',
    );
    await box.fill(LONG_WRITTEN_ANSWER);
    assert.equal(
      await page.evaluate(`document.querySelector('.caskanswer').disabled`),
      false,
      'the action stayed off after the reader typed their own answer',
    );
    // Usage updates retain the written answer's caret position.

    await box.focus();
    for (let back = 0; back < 5; back++) {
      await page.keyboard.press('ArrowLeft');
    }
    const caretUsage = (
      renderPayload([], [], [], [], [THREE_QUESTION_ASK]) as {
        usage: { bar: unknown };
      }
    ).usage;
    caretUsage.bar = null;
    await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'usage', usage: caretUsage })}, '*')`);
    await page.evaluate(SETTLED);
    const caret = (await page.evaluate(`(() => {
      const one = document.querySelector('[data-control="askwritten:layout-three:scope"]');
      return { at: one.selectionStart, held: document.activeElement === one, value: one.value };
    })()`)) as { at: number; held: boolean; value: string };
    assert.equal(caret.value, LONG_WRITTEN_ANSWER, 'a repaint forgot what the reader had typed');
    assert.equal(caret.held, true, 'a repaint took focus out of the box the reader was typing in');
    assert.equal(
      caret.at,
      LONG_WRITTEN_ANSWER.length - 5,
      'a repaint moved the caret to the end of what the reader had typed',
    );
    // The tab can clip a written answer visually while retaining it in its accessible name.

    const written = (await page.evaluate(`(() => {
      const tab = document.querySelector('[data-control="asktab:layout-three:scope"]');
      const pick = tab.querySelector('.casktabpick');
      return { cut: pick.scrollWidth > pick.clientWidth, face: pick.textContent, name: tab.getAttribute('aria-label') };
    })()`)) as { cut: boolean; face: string; name: string };
    assert.equal(written.cut, true, 'the written answer is drawn whole on the tab, so the strip grows with it');
    assert.equal(written.face, LONG_WRITTEN_ANSWER, 'the tab reports an answer the reader did not give');
    assert.equal(written.name, `Scope, answered ${LONG_WRITTEN_ANSWER}`, 'the tab name drops what the face cut off');

    // Enter invokes Next without submitting and selects the next unanswered question.

    await box.press('Enter');
    assert.deepEqual(
      (await drawnQuestions(page)).map((question) => question.trim()),
      ['How should the strip behave once the questions no longer fit across one row?'],
      'Next did not reach the next question with no answer',
    );
    // Focus moves to the next question's tab when its disabled action cannot receive focus.

    assert.equal(
      await page.evaluate(`document.activeElement && document.activeElement.dataset.control`),
      'asktab:layout-three:strip',
      'Next left the reader with focus on nothing',
    );
    assert.deepEqual(
      await page.evaluate(`window.__posted.filter((message) => message.type === 'answerAsk')`),
      [],
      'Next posted an answer the reader has not finished',
    );
    await page.locator('[data-control="ask:layout-three:strip:Wrap to a second row"]').click();

    // Questions accept either offered choices or a written answer, never both.

    await page.locator('[data-control="ask:layout-three:checks:Browser layout"]').click();
    await page.locator('[data-control="ask:layout-three:checks:Other"]').click();
    assert.deepEqual(await pickedRows(page), [false, false, true], 'taking Other left the boxes the reader had ticked');
    assert.equal(
      await page.locator('[data-control="askwritten:layout-three:checks"]').count(),
      1,
      'taking Other on a multi-select opened no box',
    );
    await page.locator('[data-control="ask:layout-three:checks:Browser layout"]').click();
    assert.equal(
      await page.locator('[data-control="askwritten:layout-three:checks"]').count(),
      0,
      'ticking a box left the reader answering in their own words as well',
    );
    assert.deepEqual(await pickedRows(page), [true, false, false], 'ticking a box after Other left Other taken');

    const done = (await page.evaluate(`(() => {
      const button = document.querySelector('.caskanswer');
      return { label: button.textContent, disabled: button.disabled };
    })()`)) as { label: string; disabled: boolean };
    assert.deepEqual(
      done,
      { label: 'Answer', disabled: false },
      'the action does not send once every question has an answer',
    );
    await page.locator('[data-control="ask:layout-three:answer"]').click();
    assert.deepEqual(
      await page.evaluate(`window.__posted.filter((message) => message.type === 'answerAsk')`),
      [
        {
          type: 'answerAsk',
          session: 's1',
          id: 'layout-three',
          answer: {
            decision: 'answer',
            answers: {
              scope: { labels: [], written: LONG_WRITTEN_ANSWER },
              strip: { labels: ['Wrap to a second row'], written: '' },
              checks: { labels: ['Browser layout'], written: '' },
            },
          },
        },
      ],
      'the written answer did not reach the host as the reader typed it',
    );
    // The request fold's accessible name includes its sending state.

    await page.evaluate(SETTLED);
    const sendingFold = (await page.evaluate(`(() => {
      const head = document.querySelector('.cask.question .caskfold');
      return {
        drawn: document.querySelector('.cask.question .caskstate').textContent,
        spoken: head.getAttribute('aria-label'),
        pressable: !head.disabled,
      };
    })()`)) as { drawn: string; spoken: string; pressable: boolean };
    assert.equal(sendingFold.drawn, 'sending your answer', 'the head row does not say that the answer has gone');
    assert.ok(
      sendingFold.spoken.endsWith('sending your answer'),
      `the fold still says "${sendingFold.spoken}" once the answer has gone`,
    );
    assert.equal(sendingFold.pressable, true, 'the fold cannot be pressed while the host resolves the answer');
    assert.deepEqual(failures, [], 'the three-question card threw while the reader answered it');
    await page.close();
  } finally {
    await browser.close();
  }
});

test('the strip stops at two rows and a folded request is one', { timeout: 60_000 }, async (t) => {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('no Edge, Chrome or bundled Chromium on this machine, so nothing was measured');
    return;
  }
  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(String(error)));
    // Use the theme fixture for the pixel-height comparison.

    await page.setContent(themed(pageHtml()));
    // The narrow viewport forces the six answered tabs to share limited space.
    await layoutAt(page, 340, [], [], [], [], [SIX_QUESTION_ASK, PERMISSION_ASK]);
    assert.deepEqual(failures, [], 'the six-question card threw while drawing');
    const six = SIX_QUESTION_ASK.questions;
    const secret = six[six.length - 1];
    await answerSixQuestions(page);
    // A secret written answer uses a password field.
    assert.equal(
      await page.evaluate(`document.querySelector('[data-control="askwritten:layout-six:${secret.id}"]').type`),
      'password',
      'a secret answer is typed in the open',
    );
    const rows = (await page.evaluate(`(() => {
      const strip = document.querySelector('.cask .casktabs');
      const count = () => new Set([...strip.querySelectorAll('.casktab')].map((tab) => tab.offsetTop)).size;
      const marked = strip.classList.contains('is-marked');
      strip.classList.remove('is-marked');
      const withValues = count();
      strip.classList.add('is-marked');
      const withMarks = count();
      strip.classList.toggle('is-marked', marked);
      return { marked, withValues, withMarks };
    })()`)) as { marked: boolean; withValues: number; withMarks: number };
    assert.ok(
      rows.withValues > 2,
      `six answered tabs take ${rows.withValues} rows with their values at 340px, so this measures nothing`,
    );
    assert.equal(rows.marked, true, 'the strip kept reporting values past the second row');
    assert.ok(
      rows.withMarks <= 2,
      `the strip takes ${rows.withMarks} rows with its values dropped, and it is allowed two`,
    );
    assert.deepEqual(
      (await tabFaces(page)).map((tab) => tab.value),
      ['', '', '', '', '', ''],
      'a tab still draws its value on a strip that ran past the second row',
    );
    // Accessible tab names retain omitted answers but disclose only answered state for secret questions.

    assert.deepEqual(
      await page.evaluate(
        `[...document.querySelectorAll('.cask .casktab')].map((tab) => tab.getAttribute('aria-label'))`,
      ),
      six.map((question, index) => {
        if (index === six.length - 1) {
          return `${question.header}, answered`;
        }
        const value = index === 0 ? LONG_WRITTEN_ANSWER : question.options[0].label;
        return `${question.header}, answered ${value}`;
      }),
      'the dropped values are in no tab name either, so the strip says only how many are done',
    );
    const told = (await page.evaluate(`(() => {
      const tab = document.querySelector('[data-control="asktab:layout-six:${secret.id}"]');
      return tab.textContent;
    })()`)) as string;
    assert.equal(told.includes('the-secret-answer'), false, 'the strip draws a secret answer on the face of its tab');

    // Fold both requests before measuring closed height and question counts.

    await page.locator('[data-control="askfold:layout-six"]').click();
    await page.locator('[data-control="askfold:layout-permission"]').click();
    const shut = (await page.evaluate(`(() => {
      const card = document.querySelector('.cask[data-ask="layout-six"]');
      const body = card.querySelector('.caskbody');
      const head = card.querySelector('.caskhead');
      const count = card.querySelector('.caskcount');
      return {
        height: Math.round(card.getBoundingClientRect().height),
        expanded: head.getAttribute('aria-expanded'),
        controls: head.getAttribute('aria-controls') === body.id,
        name: head.getAttribute('aria-label'),
        count: count ? count.textContent : null,
        state: card.querySelector('.caskstate').textContent,
        drawn: [...body.querySelectorAll('button, input')].filter((one) => one.offsetParent !== null).length,
        shutPermissionCount: !!document.querySelector('.cask[data-ask="layout-permission"] .caskcount'),
      };
    })()`)) as {
      height: number;
      expanded: string;
      controls: boolean;
      name: string;
      count: string | null;
      state: string;
      drawn: number;
      shutPermissionCount: boolean;
    };
    assert.deepEqual(
      shut,
      {
        height: 36,
        expanded: 'false',
        controls: true,
        name: 'Claude asked 6 questions. Press to show it. 6 of 6 answered. needs input',
        count: '6 of 6 answered',
        state: 'needs input',
        drawn: 0,
        // A folded permission request has no question count.
        shutPermissionCount: false,
      },
      'the shut request card is drawn wrong',
    );
    // Tab leaves a folded request without entering hidden controls.
    await page.locator('[data-control="askfold:layout-six"]').focus();
    await page.keyboard.press('Tab');
    assert.equal(
      await page.evaluate(
        `!!(document.activeElement && document.activeElement.closest('.cask[data-ask="layout-six"]'))`,
      ),
      false,
      'a control inside the shut card still holds a tab stop',
    );
    // Reopening retains the selected question.
    await page.locator('[data-control="askfold:layout-six"]').click();
    assert.deepEqual(
      (await drawnQuestions(page)).map((question) => question.trim()),
      [secret.question],
      'the fold gave the card back on another question',
    );
    await page.locator(`[data-control="askwritten:layout-six:${secret.id}"]`).press('Enter');
    assert.deepEqual(
      await page.evaluate(`(() => {
      const posted = window.__posted.filter((message) => message.type === 'answerAsk');
      return { count: posted.length, written: posted[0]?.answer?.answers?.[${JSON.stringify(secret.id)}]?.written };
    })()`),
      { count: 1, written: 'the-secret-answer' },
      'Enter did not send the complete secret answer once',
    );
    assert.deepEqual(failures, [], 'the panel threw while the reader folded the request away');
    await page.close();
  } finally {
    await browser.close();
  }
});

test('a single question needs no strip and keeps its own short label', { timeout: 60_000 }, async (t) => {
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
    await layoutAt(page, 620, [], [], [], [], [ONE_QUESTION_ASK]);
    assert.deepEqual(failures, [], 'the one-question card threw while drawing');
    const read = `(() => {
      const card = document.querySelector('.cask');
      const key = card.querySelector('.caskkey');
      const button = card.querySelector('.caskanswer');
      return {
        strips: card.querySelectorAll('.casktabs').length,
        key: key ? key.textContent : null,
        role: card.querySelector('.caskquestion').getAttribute('role'),
        label: button.textContent,
        name: button.getAttribute('aria-label'),
        disabled: button.disabled,
        wait: card.querySelector('.caskwait').textContent,
      };
    })()`;
    assert.deepEqual(
      await page.evaluate(read),
      {
        strips: 0,
        // A single-question card keeps its short label because it has no tab strip.
        key: ONE_QUESTION_ASK.questions[0].header,
        role: null,
        // A single unanswered question uses Answer and its incomplete-answer explanation.

        label: 'Answer',
        name: 'Choose an answer first',
        disabled: true,
        wait: 'Choose an answer first',
      },
      'the one-question card draws a strip, a second copy of its label, or a count of nothing',
    );
    await page.locator('[data-control="ask:layout-one:scope:Other"]').click();
    const box = page.locator('[data-control="askwritten:layout-one:scope"]');
    await box.fill('First line');
    await box.press('Shift+Enter');
    await box.pressSequentially('Second line');
    assert.equal(
      await box.inputValue(),
      'First line\nSecond line',
      'Shift+Enter did not keep a line break in the written answer',
    );
    assert.deepEqual(
      await page.evaluate(`window.__posted.filter((message) => message.type === 'answerAsk')`),
      [],
      'Shift+Enter submitted the written answer',
    );
    assert.deepEqual(
      await page.evaluate(read),
      {
        strips: 0,
        key: ONE_QUESTION_ASK.questions[0].header,
        role: null,
        label: 'Answer',
        name: 'Answer the agent question',
        disabled: false,
        // The completed-answer explanation becomes empty while its row remains mounted.

        wait: '',
      },
      'the answered one-question card still says why its action is off',
    );
    await box.evaluate((input) => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
          isComposing: true,
        }),
      );
      const legacy = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      Object.defineProperty(legacy, 'keyCode', { value: 229 });
      input.dispatchEvent(legacy);
    });
    assert.deepEqual(
      await page.evaluate(`window.__posted.filter((message) => message.type === 'answerAsk')`),
      [],
      'an input-method Enter submitted the written answer',
    );
    await box.press('Enter');
    assert.deepEqual(
      await page.evaluate(`window.__posted.filter((message) => message.type === 'answerAsk')`),
      [
        {
          type: 'answerAsk',
          session: 's1',
          id: 'layout-one',
          answer: {
            decision: 'answer',
            answers: { scope: { labels: [], written: 'First line\nSecond line' } },
          },
        },
      ],
      'Enter did not send the exact multiline answer once',
    );
    assert.deepEqual(failures, [], 'the one-question card threw while the reader answered it');
    await page.close();
  } finally {
    await browser.close();
  }
});

test('a question named by its own words still reaches its panel', { timeout: 60_000 }, async (t) => {
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
    await layoutAt(page, 620, [], [], [], [], [SPOKEN_ID_ASK]);
    assert.deepEqual(failures, [], 'the card threw on a question named by its own words');
    const wired = (await page.evaluate(`(() => {
      const card = document.querySelector('.cask');
      const tabs = [...card.querySelectorAll('.casktab')];
      const panel = card.querySelector('.caskquestion');
      const named = panel.getAttribute('aria-labelledby');
      const legend = named ? document.getElementById(named) : null;
      return {
        broken: tabs.some((tab) => tab.id.includes(' ')) || panel.id.includes(' ') || (named || '').includes(' '),
        pointing: tabs.map((tab) => tab.getAttribute('aria-controls')),
        reaches: tabs
          .filter((tab) => tab.getAttribute('aria-controls'))
          .every((tab) => document.getElementById(tab.getAttribute('aria-controls')) === panel),
        legend: legend ? legend.className : null,
      };
    })()`)) as { broken: boolean; pointing: (string | null)[]; reaches: boolean; legend: string | null };
    assert.equal(
      wired.broken,
      false,
      'an id built from what the agent sent carries a space, so the reference holding it resolves to nothing',
    );
    // Only the selected question has a mounted panel for its tab to reference.
    assert.equal(wired.pointing.filter(Boolean).length, 1, 'a tab points at a question panel that was never drawn');
    assert.equal(wired.pointing[0] !== null, true, 'the chosen tab points at no panel at all');
    assert.equal(wired.reaches, true, 'the chosen tab points at something other than the question on screen');
    // The tabpanel uses its legend as the accessible name.

    assert.equal(wired.legend, 'casklegend', 'the question panel reaches no name of its own');
    await page.close();
  } finally {
    await browser.close();
  }
});

test('a request holding no questions still draws the way out of it', { timeout: 60_000 }, async (t) => {
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
    await layoutAt(page, 620, [], [], [], [], [NO_QUESTION_ASK]);
    assert.deepEqual(failures, [], 'the card threw on a request holding no questions');
    const empty = (await page.evaluate(`(() => {
      const card = document.querySelector('.cask');
      return {
        strips: card.querySelectorAll('.casktabs').length,
        questions: card.querySelectorAll('.caskquestion').length,
        answers: card.querySelectorAll('.caskanswer').length,
        actions: [...card.querySelectorAll('.caskaction')].map((one) => one.textContent),
        prompt: !!document.getElementById('prompt'),
      };
    })()`)) as {
      strips: number;
      questions: number;
      answers: number;
      actions: string[];
      prompt: boolean;
    };
    assert.deepEqual(
      empty,
      {
        strips: 0,
        questions: 0,
        answers: 0,
        actions: ['Decline'],
        // A request without questions still leaves the Prompt box available.

        prompt: true,
      },
      'a request with nothing to answer leaves the reader no way out of it',
    );
    await page.close();
  } finally {
    await browser.close();
  }
});

// Body and popover file and commit actions use shared card rows. Subagent details include only that child's artifacts.

test(
  'a subagent figure record draws the card rows the child touched, and one press opens one tab',
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
      const payload = renderPayload() as { cards: Array<Record<string, unknown> & { key: string }> };
      const turn = payload.cards[LONG_TURN_INDEX];
      turn.agents = subagentRows(now);
      payload.cards = [turn];
      Object.assign(payload, { timelineLayout: { cardLayout: 'one-column', promptPosition: 'above' } });
      await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
      await page.evaluate(SETTLED);
      const card = page.locator('#list .turn').first();
      if ((await card.locator('.body').getAttribute('hidden')) !== null) {
        await card.locator('.head').click();
      }

      const filePress = `[data-control="file:${turn.key}:${REVIEW_PATHS[0]}"]`;
      const commitPress = `[data-control="commit:${turn.key}:${REVIEW_SHAS[0]}"]`;
      const posted = (type: string) =>
        page.evaluate(`window.__posted.filter((message) => message.type === '${type}').at(-1)`);
      const openedFrom = async (root: string) => {
        await page.locator(`${root} ${filePress}`).first().click();
        const file = await posted('openFile');
        await page.locator(`${root} ${commitPress}`).first().click();
        return [file, await posted('openCommit')];
      };

      // Read file and commit actions from the card body.
      const fromBody = await openedFrom('#list');
      assert.deepEqual(fromBody[0], { type: 'openFile', key: turn.key, path: REVIEW_PATHS[0], beside: false });
      assert.deepEqual(fromBody[1], {
        type: 'openCommit',
        key: turn.key,
        sha: REVIEW_SHAS[0],
        dir: 'c:/repo-trees/turn-card-density',
        beside: false,
      });

      // Read the same actions from the card's Files and Commits popovers.
      await card.locator('.statchip[data-metric="files"]').click();
      await page.evaluate(SETTLED);
      await page.locator(`#chippop ${filePress}`).first().click();
      const popFile = await posted('openFile');
      await card.locator('.statchip[data-metric="commits"]').click();
      await page.evaluate(SETTLED);
      await page.locator(`#chippop ${commitPress}`).first().click();
      const popCommit = await posted('openCommit');
      assert.deepEqual(
        [popFile, popCommit],
        fromBody,
        'the card popovers and the card body open different tabs for one row',
      );

      // Read child artifact actions from a nested subagent figure popover.
      await card.locator('.statchip[data-metric="agents"]').click();
      await page.evaluate(SETTLED);
      const figure = (metric: string) =>
        page.locator(`#chippop .agentrow .railstatchip[data-metric="${metric}"]`).first();
      await figure('commits').dispatchEvent('click');
      await page.evaluate(SETTLED);
      // Artifact rows use a named dialog controlled by their figure.

      assert.deepEqual(
        await page.evaluate(`(() => {
      const pop = document.querySelector('#chippopnested');
      const press = document.querySelector('#chippop .agentrow .railstatchip[data-metric="commits"]');
      return [pop.getAttribute('role'), pop.getAttribute('aria-label'),
        press.getAttribute('aria-controls'), press.getAttribute('aria-expanded')];
    })()`),
        ['dialog', '2 commits', 'chippopnested', 'true'],
        'the record of rows does not announce itself as a dialog the reader walks into',
      );
      // The nested commit rows include the child's hashes and subjects without the turn's unrelated commit.

      assert.deepEqual(
        await page.evaluate(`[...document.querySelectorAll('#chippopnested .commitrow')]
      .map((row) => [row.querySelector('.sha').textContent, row.querySelector('.name').textContent])`),
        [
          [REVIEW_SHAS[0], 'test(card): measure the open card at the three panel widths'],
          [REVIEW_SHAS[1], 'fix(rail): keep the pinned row in view when the rail narrows'],
        ],
        "the commits record is not the card's own rows, or it names a commit the child never made",
      );
      // An artifact-row press keeps both nested and enclosing popovers open.
      await page.locator(`#chippopnested ${commitPress}`).first().click();
      const nestedCommit = await posted('openCommit');
      assert.deepEqual(
        [await page.locator('#chippopnested').isHidden(), await page.locator('#chippop').isHidden()],
        [false, false],
        'a press inside the record closed it or the popover under it',
      );

      await figure('files').dispatchEvent('click');
      await page.evaluate(SETTLED);
      // Child file details include shared rows and omit the whole-turn diff.

      assert.deepEqual(
        await page.evaluate(`(() => {
      const pop = document.querySelector('#chippopnested');
      const rows = [...pop.querySelectorAll('.chippoprows > .row.click')];
      return [
        rows.map((row) => row.getAttribute('data-control').split(':').slice(3).join(':')),
        rows.every((row) => !!row.querySelector('.ficon')),
        rows.some((row) => !!row.querySelector('.nums .add') || !!row.querySelector('.nums .del')),
        pop.querySelectorAll('.actions').length,
      ];
    })()`),
        [REVIEW_PATHS, true, true, 0],
        "the files record is not the card's own rows, or it holds a path the child never changed",
      );
      await page.locator(`#chippopnested ${filePress}`).first().click();
      assert.deepEqual(
        [await posted('openFile'), nestedCommit],
        fromBody,
        'a press in the figure record opens a different tab from the card body',
      );

      // Escape closes nested details before the enclosing popover and restores each anchor's focus.

      await page.keyboard.press('Escape');
      assert.deepEqual(
        [
          await page.locator('#chippopnested').isHidden(),
          await page.locator('#chippop').isHidden(),
          await page.evaluate(
            `document.activeElement === document.querySelector('#chippop .agentrow .railstatchip[data-metric="files"]')`,
          ),
        ],
        [true, false, true],
        'Escape closed the Subagents popover before the record over it',
      );
      await page.keyboard.press('Escape');
      assert.deepEqual(
        [
          await page.locator('#chippop').isHidden(),
          await page.evaluate(
            `document.activeElement === document.querySelector('#list .statchip[data-metric="agents"]')`,
          ),
        ],
        [true, true],
        'the second Escape left the Subagents popover open or lost the reader',
      );

      // Tab leaves the nested record through the enclosing row's controls, even when its anchor is outside the shared Tab stop.

      await card.locator('.statchip[data-metric="agents"]').click();
      await page.evaluate(SETTLED);
      await figure('files').dispatchEvent('click');
      await page.evaluate(SETTLED);
      await page.evaluate(`(() => {
      const rows = document.querySelectorAll('#chippopnested .chippoprows > .row.click');
      rows[rows.length - 1].focus();
    })()`);
      await page.keyboard.press('Tab');
      assert.deepEqual(
        await page.evaluate(`[
      document.querySelector('#chippopnested').hidden,
      document.querySelector('#chippop').contains(document.activeElement),
      document.activeElement === document.querySelector('#chippop .agentrow .railstatchip[data-metric="files"]'),
    ]`),
        [true, true, false],
        'Tab out of the record left it open, sent the reader back to the figure, or landed outside the Subagents popover',
      );
      // A second anchor press closes its popover.
      await card.locator('.statchip[data-metric="agents"]').click();
      await page.evaluate(SETTLED);

      // Hide later page controls to exercise leaving an enclosing popover while nested details remain open.

      await card.locator('.statchip[data-metric="agents"]').click();
      await page.evaluate(SETTLED);
      await figure('files').dispatchEvent('click');
      await page.evaluate(SETTLED);
      const arranged = await page.evaluate(`(() => {
      const pop = document.querySelector('#chippop');
      const nested = document.querySelector('#chippopnested');
      const chip = document.querySelector('#list .statchip[data-metric="agents"]');
      let after = false;
      window.walkHidden = [];
      for (const stop of document.querySelectorAll(${JSON.stringify(TAB_STOPS)})) {
        if (stop === chip) { after = true; continue; }
        if (after && !pop.contains(stop) && !nested.contains(stop) && !stop.hidden) {
          stop.hidden = true;
          window.walkHidden.push(stop);
        }
      }
      window.walkedInto = [];
      document.addEventListener('focusin', (event) => {
        window.walkedInto.push(nested.contains(event.target));
      }, true);
      const presses = pop.querySelectorAll('.chippopnamelink, .chippoprows button');
      presses[presses.length - 1].focus();
      return [nested.hidden, nested.querySelectorAll('.chippoprows button').length > 0,
        pop.contains(document.activeElement)];
    })()`);
      assert.deepEqual(
        arranged,
        [false, true, true],
        'the record was not standing over the popover, so this walk had nothing to skip',
      );
      await page.keyboard.press('Tab');
      assert.deepEqual(
        await page.evaluate(`[
      window.walkedInto.some(Boolean),
      document.querySelector('#chippop').hidden,
    ]`),
        [false, true],
        'the walk out of the Subagents popover landed inside the record standing over it',
      );
      await page.evaluate(`window.walkHidden.forEach((stop) => { stop.hidden = false; })`);

      // Opening a card-body figure detail does not pin an unrelated hovered popover.

      await card.locator('.statchip[data-metric="files"]').hover();
      await page.evaluate(SETTLED);
      await page.locator('#list .agentrow .railstatchip[data-metric="cost"]').first().dispatchEvent('click');
      await page.evaluate(SETTLED);
      assert.deepEqual(
        await page.evaluate(`[
      document.querySelector('#chippop').classList.contains('pinned'),
      document.querySelector('#chippopnested').hidden,
    ]`),
        [false, false],
        'a press on a figure in the card body pinned a popover it does not stand in',
      );
      await page.close();
    } finally {
      await browser.close();
    }
  },
);
