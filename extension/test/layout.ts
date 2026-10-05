// Shared fixtures and measurements for panel-layout browser tests.

import assert from 'node:assert';
import { Page } from 'playwright-core';
import { SETTLED } from './browser.ts';
import { Ask } from '../src/agentwire.ts';
import { ROVING_SELECTOR } from '../src/webview/navigation.ts';
import {
  LIVE_PRESS,
  MCP_SERVERS,
  LONG_WRITTEN_ANSWER,
  PERMISSION_ASK,
  SIX_QUESTION_ASK,
  THREE_QUESTION_ASK,
  draftRenderPayload,
  renderPayload,
} from '../src/panelfixture.ts';
import { STEP_CUT, STEP_DETAIL_LIMIT, shortenTo } from '../src/transcript.ts';

// Use the production keyboard-navigation selector.
export function rovingSelector(): string {
  return ROVING_SELECTOR;
}

export const SECOND_PERMISSION_ASK: Ask = {
  ...PERMISSION_ASK,
  id: 'layout-permission-2',
  toolUseId: 'layout-command-2',
  description: 'Run the second deterministic layout command',
  input: { command: 'echo ask-card-layout-2' },
};

export const RAPID_PERMISSION_ASKS: Ask[] = [
  {
    ...PERMISSION_ASK,
    id: 'rapid-permission-1',
    toolUseId: 'rapid-command-1',
    input: { command: 'echo first-rapid-request' },
  },
  {
    ...PERMISSION_ASK,
    id: 'rapid-permission-2',
    toolUseId: 'rapid-command-2',
    input: { command: 'echo second-rapid-request' },
  },
  {
    ...PERMISSION_ASK,
    id: 'rapid-permission-3',
    toolUseId: 'rapid-command-3',
    input: { command: 'echo third-rapid-request' },
  },
];

// Panel element bounds and viewport measurements.
export interface Laid {
  composer: { top: number; left: number; right: number; bottom: number };
  ask: { top: number; left: number; right: number; bottom: number } | null;
  askArea: { top: number; left: number; right: number; bottom: number } | null;
  prompt: { top: number; left: number; right: number; bottom: number } | null;
  live: { top: number; left: number; right: number; bottom: number } | null;
  lives: { kind: string; top: number }[];
  liveInGroup: boolean;
  sessionHead: { top: number; left: number; right: number; bottom: number } | null;
  card: { top: number; left: number; right: number; bottom: number } | null;
  actrows: { top: number; left: number; right: number; bottom: number }[];
  doing: { top: number; left: number; right: number; bottom: number } | null;
  reply: { top: number; left: number; right: number; bottom: number } | null;
  replyText: { top: number; left: number; right: number; bottom: number } | null;
  promptLine: { top: number; left: number; right: number; bottom: number } | null;
  statusbar: { top: number; left: number; right: number; bottom: number };
  rail: { top: number; left: number; right: number; bottom: number } | null;
  controls: { top: number; left: number; right: number; bottom: number } | null;
  list: { top: number; left: number; right: number; bottom: number };
  firstRow: { top: number } | null;
  lastRow: { bottom: number } | null;
  documentWidth: number;
  viewportWidth: number;
}

// Send page code as strings. Transpiled functions can reference helpers unavailable in the browser.
export const MEASURE = `(() => {
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, right: r.right, bottom: r.bottom };
  };
  const rail = document.getElementById('rail');
  return {
    composer: box(document.getElementById('composer')),
    ask: box(document.querySelector('.cask')),
    askArea: box(document.querySelector('.casks')),
    prompt: box(document.getElementById('prompt')),
    live: box(document.querySelector('.clive')),
    // Every card the presses opened, in the order they stand on the page. A compaction and
    // the prompt sent during it put two up at once, and which is above the other is the
    // whole of what says the prompt is waiting behind the compaction.
    lives: [...document.querySelectorAll('.clive')].map(function (n) {
      return { kind: n.dataset.live, top: n.getBoundingClientRect().top };
    }),
    liveInGroup: !!document.querySelector('#list .group .clive'),
    sessionHead: box(document.querySelector('#list .sessionrow')),
    card: box(document.querySelector('#list .turn:not(.clive)')),
    actrows: [...document.querySelectorAll('#list .turn:not(.clive) .actrow')].map(box),
    doing: box(document.querySelector('#list .turn:not(.clive) .doing')),
    reply: box(document.querySelector('.clivereply')),
    replyText: box(document.querySelector('.clivereplytext')),
    promptLine: box(document.querySelector('.clive .headline')),
    statusbar: box(document.getElementById('statusbar')),
    lastRow: box(document.querySelector('#list > *:last-child')),
    rail: rail && !rail.hidden ? box(rail) : null,
    controls: box(document.querySelector('#list .controls')),
    list: box(document.getElementById('list')),
    firstRow: box(document.querySelector('#list > *')),
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  };
})()`;

// Read sticky-row positions and the status bar and prompt box boundaries.
export const STICKY = `(() => {
  const top = (s) => { const e = document.querySelector(s); return e ? e.getBoundingClientRect().top : null; };
  const tops = {};
  for (const [what, sel] of [['the rail', '#rail'], ['the control bar', '.controls'], ['a session heading', '.sessionrow']]) {
    const t = top(sel);
    if (t !== null) tops[what] = t;
  }
  const bottom = (s) => { const e = document.querySelector(s); return e ? e.getBoundingClientRect().bottom : null; };
  const bottoms = {};
  for (const [what, sel] of [['the rail', '#rail'], ['the last card', '#list > *:last-child']]) {
    const b = bottom(sel);
    if (b !== null) bottoms[what] = b;
  }
  return {
    tops, bottoms,
    barTop: document.getElementById('statusbar').getBoundingClientRect().top,
    composerTop: document.getElementById('composer').getBoundingClientRect().top,
  };
})()`;

export interface Scrolled {
  tops: Record<string, number>;
  bottoms: Record<string, number>;
  barTop: number;
  composerTop: number;
}

// Measure session-list headings within their scroller and against the viewport.
// Page scrolling does not describe the session list's independent scroll position.
export const RAILROWS = `(() => {
  const rail = document.getElementById('rail');
  if (!rail || rail.hidden) return null;
  const top = rail.querySelector('.railtop');
  return {
    boxBottom: top.getBoundingClientRect().bottom,
    railTop: rail.getBoundingClientRect().top,
    heads: [...rail.querySelectorAll('.railbucket')].map(function (n) {
      const r = n.getBoundingClientRect();
      const label = n.querySelector('.railbucketname');
      // What the column cannot hold of the label, read off a copy that is not allowed to
      // wrap and is taken out of the flow so it moves nothing. Measured this way rather than
      // from the label itself, because a label the stylesheet lets wrap needs no more width
      // than it was given and would report a column that fits when it does not.
      const copy = label.cloneNode(true);
      copy.style.position = 'absolute';
      copy.style.visibility = 'hidden';
      copy.style.whiteSpace = 'nowrap';
      copy.style.width = 'auto';
      n.appendChild(copy);
      const need = copy.getBoundingClientRect().width;
      n.removeChild(copy);
      return {
        name: label.textContent, offset: n.offsetTop, top: r.top, bottom: r.bottom,
        cut: need - label.getBoundingClientRect().width,
      };
    }),
  };
})()`;

export interface RailRows {
  boxBottom: number;
  railTop: number;
  heads: { name: string; offset: number; top: number; bottom: number; cut: number }[];
}

export async function railRows(page: Page, scrollTo: number | null = null): Promise<RailRows> {
  if (scrollTo !== null) await page.evaluate(`document.getElementById('rail').scrollTop = ${scrollTo}`);
  await page.evaluate(SETTLED);
  const found = (await page.evaluate(RAILROWS)) as RailRows | null;
  assert.ok(found, 'the page drew no rail, so this measures nothing');
  return found;
}

export async function scrolledLayout(page: Page, by: number): Promise<Scrolled> {
  await page.evaluate(`window.scrollTo(0, ${by})`);
  await page.evaluate(SETTLED);
  const found = (await page.evaluate(STICKY)) as Scrolled;
  assert.ok(Object.keys(found.tops).length >= 2, 'the page drew no sticky rows, so this measures nothing');
  await page.evaluate('window.scrollTo(0, 0)');
  return found;
}

export async function layoutAt(
  page: Page,
  width: number,
  archived: string[] = [],
  live: (typeof LIVE_PRESS)[] = [],
  runs: string[] = [],
  servers: typeof MCP_SERVERS = [],
  asks: Ask[] = [],
  pinned: string[] = [],
  assets: readonly Record<string, unknown>[] = [],
): Promise<Laid> {
  await page.setViewportSize({ width, height: 900 });
  await page.evaluate(
    `window.postMessage(${JSON.stringify(renderPayload(archived, live, runs, servers, asks, pinned, new Map(), new Map(), assets))}, '*')`,
  );
  await page.evaluate(SETTLED);
  return (await page.evaluate(MEASURE)) as Laid;
}

// Read the element's accessible name from Chromium's accessibility tree.
export async function axName(page: Page, selector: string): Promise<string | null> {
  const client = await page.context().newCDPSession(page);
  await client.send('Accessibility.enable');
  await client.send('DOM.enable');
  const { root } = await client.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  if (!nodeId) return null;
  const { node } = await client.send('DOM.describeNode', { nodeId });
  const tree = await client.send('Accessibility.getPartialAXTree', { backendNodeId: node.backendNodeId });
  return tree.nodes[0]?.name?.value ?? null;
}

// Measure the older-turn button or the status row shown at the first turn.
export const OLDER_ROW = `(() => {
  const btn = document.querySelector('#list .deeper');
  const note = document.querySelector('#list .deeper-note');
  const node = btn || note;
  if (!node) { return null; }
  const list = document.getElementById('list');
  const box = node.getBoundingClientRect();
  const cards = [...document.querySelectorAll('#list .turn')];
  const last = cards.length ? cards[cards.length - 1].getBoundingClientRect() : null;
  return {
    tag: node.tagName.toLowerCase(),
    text: node.textContent,
    control: node.dataset.control || null,
    role: node.getAttribute('role'),
    name: node.getAttribute('aria-label'),
    insideList: list.contains(node),
    inGroup: !!node.closest('.group'),
    width: box.width,
    height: box.height,
    left: box.left,
    right: box.right,
    listRight: list.getBoundingClientRect().right,
    belowLastCard: last ? box.top >= last.bottom - 1 : null,
    focusable: (() => { node.focus(); return document.activeElement === node; })(),
  };
})()`;

// Measure prompt box overlap with the status bar, including its wrapped height.
export const FOOT_OVER_BAR = `(() => {
  const bar = document.getElementById('statusbar');
  const composer = document.getElementById('composer');
  const picks = composer.querySelector('.cpicks');
  const send = composer.querySelector('.csend');
  const box = (n) => n.getBoundingClientRect();
  const barTop = box(bar).top;
  const over = [];
  for (const [what, node] of [['the composer', composer], ['the picker row', picks], ['Send', send]]) {
    if (node && box(node).bottom > barTop + 1) over.push(what);
  }
  return { over, barTop, barHeight: box(bar).height, reserved: document.body.style.getPropertyValue('--statusbar-height') };
})()`;

// Read selected-row classes in display order.
// These classes control the row background independently of checked inputs.
export async function pickedRows(page: Page): Promise<boolean[]> {
  return (await page.evaluate(`(() => [...document.querySelectorAll('.cask .caskchoice')]
    .map((row) => row.classList.contains('is-picked')))()`)) as boolean[];
}

// Read displayed question legends, excluding their key labels.
export async function drawnQuestions(page: Page): Promise<string[]> {
  return (await page.evaluate(`(() => [...document.querySelectorAll('.cask .casklegend')].map((legend) => {
    const key = legend.querySelector('.caskkey');
    return legend.textContent.slice(key ? key.textContent.length : 0);
  }))()`)) as string[];
}

export interface TabFace {
  name: string;
  value: string;
  chosen: boolean;
  stop: number;
}

// Read tab labels, visible values, selection, and tab stops. Hidden values contribute no text.
export async function tabFaces(page: Page): Promise<TabFace[]> {
  return (await page.evaluate(`(() => [...document.querySelectorAll('.cask .casktab')].map((tab) => {
    const pick = tab.querySelector('.casktabpick');
    const shown = pick && getComputedStyle(pick).display !== 'none';
    return {
      name: tab.querySelector('.casktabname').textContent,
      value: shown ? pick.textContent : '',
      chosen: tab.getAttribute('aria-selected') === 'true',
      stop: tab.tabIndex,
    };
  }))()`)) as TabFace[];
}

// A single-question request needs no question tabs.
export const ONE_QUESTION_ASK = {
  ...THREE_QUESTION_ASK,
  id: 'layout-one',
  toolUseId: 'layout-one-tool',
  questions: [THREE_QUESTION_ASK.questions[0]],
};

// Question IDs contain the question text, including spaces.
// aria-controls and aria-labelledby need whitespace-free IDs because they contain space-separated ID lists.
export const SPOKEN_ID_ASK: Ask = {
  ...THREE_QUESTION_ASK,
  id: 'layout-spoken',
  toolUseId: 'layout-spoken-tool',
  questions: THREE_QUESTION_ASK.questions.map((question) => ({ ...question, id: question.question })),
};

// An empty question request still needs a dismissal control.
export const NO_QUESTION_ASK: Ask = {
  ...THREE_QUESTION_ASK,
  id: 'layout-empty',
  toolUseId: 'layout-empty-tool',
  questions: [],
};

// Answer six questions with a long written answer, four listed choices, and a password.
// The long answer exercises tab-value wrapping.
export async function answerSixQuestions(page: Page): Promise<void> {
  const six = SIX_QUESTION_ASK.questions;
  await page.locator(`[data-control="ask:layout-six:${six[0].id}:Other"]`).click();
  await page.locator(`[data-control="askwritten:layout-six:${six[0].id}"]`).fill(LONG_WRITTEN_ANSWER);
  // Advance explicitly after a written answer.
  await page.locator('[data-control="ask:layout-six:answer"]').click();
  for (const question of six.slice(1, -1)) {
    await page.locator(`[data-control="ask:layout-six:${question.id}:${question.options[0].label}"]`).click();
  }
  const secret = six[six.length - 1];
  await page.locator(`[data-control="ask:layout-six:${secret.id}:Other"]`).click();
  await page.locator(`[data-control="askwritten:layout-six:${secret.id}"]`).fill('the-secret-answer');
}

// Read the tab row count and the class that suppresses tab values.
export const STRIP_ROWS = `(() => {
  const strip = document.querySelector('.cask .casktabs');
  return {
    marked: strip.classList.contains('is-marked'),
    rows: new Set([...strip.querySelectorAll('.casktab')].map((tab) => tab.offsetTop)).size,
  };
})()`;

// Bounds and visibility of a comment mark.
export interface MarkBox {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  display: string;
  visibility: string;
}

export async function markedLayout(
  page: Page,
  width: number,
): Promise<{
  marks: MarkBox[];
  documentWidth: number;
  viewportWidth: number;
  para: MarkBox;
  prompt: MarkBox;
  card: MarkBox;
  paraText: string;
}> {
  await page.setViewportSize({ width, height: 900 });
  // Place the prompt below the response so mark order matches the assertions.
  await page.evaluate(
    `window.postMessage(${JSON.stringify({ ...renderPayload(), timelineLayout: { cardLayout: 'compact', promptPosition: 'below' } })}, '*')`,
  );
  await page.evaluate(SETTLED);
  // Open the first card only if closed. Open state survives a render.
  await page.evaluate(`(() => {
    const turn = document.querySelector('.turn');
    if (turn.querySelector('.body').hidden) turn.querySelector('.head').click();
  })()`);
  await page.evaluate(SETTLED);
  const lines = (await page.evaluate(`(() => {
    const p = document.querySelector('.turn .summary p');
    const prompt = document.querySelector('.turn .prompt');
    return { para: p ? p.textContent : '', prompt: prompt ? prompt.textContent : '' };
  })()`)) as { para: string; prompt: string };
  const card = (await page.evaluate(`(() => {
    const turn = document.querySelector('.turn');
    return { key: turn.dataset.key, session: turn.dataset.key.split(':')[0] };
  })()`)) as { key: string; session: string };
  const note = (id: string, quote: string, part: string) => ({
    id,
    sessionId: card.session,
    turnKey: card.key,
    part,
    quote,
    note: 'A comment.',
    headline: '',
    sessionTitle: '',
    turnAt: 1,
    at: Number(id),
  });
  const comments = [
    note('1', lines.para, 'summary'),
    note('2', lines.para, 'summary'),
    note('3', lines.prompt, 'prompt'),
  ];
  await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'notes', comments })}, '*')`);
  await page.evaluate(SETTLED);
  return (await page.evaluate(`(() => {
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return {
        top: r.top, left: r.left, right: r.right, bottom: r.bottom,
        width: r.width, height: r.height, display: s.display, visibility: s.visibility,
      };
    };
    const para = document.querySelector('.turn .summary p');
    return {
      marks: [...document.querySelectorAll('.linemark:not(.offlinemark)')].map(box),
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      para: box(para),
      prompt: box(document.querySelector('.turn .prompt')),
      card: box(document.querySelector('.turn')),
      paraText: para ? para.textContent : '',
    };
  })()`)) as {
    marks: MarkBox[];
    documentWidth: number;
    viewportWidth: number;
    para: MarkBox;
    prompt: MarkBox;
    card: MarkBox;
    paraText: string;
  };
}

// Session-list metadata text, line counts, overflow, and clipping.
export interface MetaLine {
  words: string[];
  rects: number[];
  overflow: number;
  clipped: boolean;
}

// Count distinct text-range top positions to measure wrapped lines.
// Flex-item boxes contain every line and cannot identify wrapping.
// Ellipsis can produce multiple rectangles on one line, so count heights rather than rectangles.
export const META_LINES = `(() => {
  const rect = (e) => e.getBoundingClientRect();
  const lines = (e) => {
    const r = document.createRange();
    r.selectNodeContents(e);
    return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size;
  };
  return [...document.querySelectorAll('.railcard')].map((card) => {
    const meta = card.querySelector('.railmeta');
    const spans = [...meta.children].filter((s) => !s.hidden && getComputedStyle(s).display !== 'none');
    const right = rect(card).right - parseFloat(getComputedStyle(card).paddingRight);
    return {
      words: spans.map((s) => s.textContent),
      rects: spans.map(lines),
      overflow: Math.max(...spans.map((s) => rect(s).right)) - right,
      // Any span cut, not the first one. Only one span on this line shrinks, and which
      // position it sits in is a layout decision the measurement must not depend on.
      clipped: spans.some((s) => s.scrollWidth > s.clientWidth),
    };
  });
})()`;

// Session labels supplied when the page answers an editor request without an extension host.
export const EDITOR_LABELS: Record<string, string[]> = {
  s1: ['composer', 'release 0.4', 'perf'],
  s2: ['release 0.4', 'rail'],
  s3: ['rail'],
  s4: ['worktree parallel sessions and the rails'],
};

// Session-heading labels, accessibility attributes, and layout measurements.
export interface SessionLabelLine {
  chips: string[];
  titles: (string | null)[];
  hints: (string | null)[];
  said_chips: (string | null)[];
  tags: string[];
  rows: number;
  outside: number;
  figures: string[];
  figuresBeforeLabels: boolean;
  underFigures: number | null;
  overCard: number | null;
  word: string;
  said: string | null;
  tag: string;
  pop: string | null;
  haspopup: string | null;
  buttonRight: number;
  buttonBottom: number;
  rowBottom: number;
}

// Session-list labels and their distances from row, card, and list boundaries.
export interface RailLabelLine {
  chips: [string, string][];
  chipLines: number[];
  chipTops: number[];
  titles: string[];
  cutRule: string[];
  cut: boolean[];
  height: number;
  chipHeight: number;
  outsideRow: number;
  underFigures: number;
  pastCard: number;
  pastRail: number;
  coversActions: boolean;
}

// A long live reply exercises clipping at different panel widths.
export const LIVE_REPLY = {
  ...LIVE_PRESS,
  reply:
    'I have read the two wire files and the composer, and the next thing to change is the ' +
    'switch that drops the chunks the server already sends, which is one case long. The panel ' +
    'then holds the tail of the reply and draws it on the card, anchored to its end, so the ' +
    'words that have just arrived are the words on screen at whatever width the panel is ' +
    'dragged to, and the start of the line is what runs off it.',
};

export function setLogMessages(card: Record<string, unknown>): void {
  const messages = card.saidMessages as Record<string, unknown>[];
  const replies = messages.filter((message) => message.kind === 'answer').length;
  const counts = [
    messages.length === 1 ? '1 message' : `${messages.length} messages`,
    ...(replies ? [replies === 1 ? '1 reply' : `${replies} replies`] : []),
  ];
  card.activity = messages.map((message) => ({
    ...message,
    kind: 'message',
    messageKind: message.kind,
    spoken: [message.kind === 'answer' ? 'Replied' : '', message.absolute].filter(Boolean).join(', '),
    status: 'done',
    line: '',
    code: '',
    figure: '',
    since: null,
    title: '',
  }));
  card.activityName = ['Activity', ...counts].join(', ');
  card.activityCounts = counts;
  card.activityTools = '';
  card.toolMix = counts.join(', ');
}

export function flatLog(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.flatMap((row) => (row.steps as Record<string, unknown>[]) ?? [row]).map(({ id: _id, ...row }) => row);
}

// Paths for recorded and best-effort skill fixtures.
export const RECORDED_SKILL_PATH = 'c:/repo/.claude/skills/review-the-change/SKILL.md';
export const MOCKUP_SKILL_PATH = 'c:/repo/.claude/skills/panel-mockup/SKILL.md';
// Full skill description before display truncation.
export const MOCKUP_SKILL_FULL_DESCRIPTION =
  'Review the panel, draw a mockup for it, and check every candidate against real panel ' +
  'shots before the reviewer signs off on the version the team ships to every reader on ' +
  'every platform.';
// Apply the production description limit to the skill fixture.
export const MOCKUP_SKILL_DESCRIPTION = shortenTo(MOCKUP_SKILL_FULL_DESCRIPTION, STEP_DETAIL_LIMIT, STEP_CUT);
export const CARD_SKILLS = [
  {
    name: 'review-the-change',
    count: 2,
    evidence: 'recorded',
    path: RECORDED_SKILL_PATH,
    shownPath: RECORDED_SKILL_PATH,
  },
  {
    name: 'panel-mockup',
    count: 1,
    evidence: 'best-effort',
    description: MOCKUP_SKILL_DESCRIPTION,
    fullDescription: MOCKUP_SKILL_FULL_DESCRIPTION,
    path: MOCKUP_SKILL_PATH,
    shownPath: MOCKUP_SKILL_PATH,
  },
  {
    name: 'polish',
    count: 1,
    evidence: 'recorded',
  },
];

// Mid-turn message bounds, disclosure text, and control tab stops.
export interface BoundedBlock {
  bounded: boolean;
  height: number;
  bound: number;
  moreHidden: boolean;
  moreWord: string;
  stops: (string | null)[];
  under: boolean[];
}

// Message clipping boundary and measured content positions.
export interface SnappedBlock {
  cut: number;
  bound: number;
  height: number;
  moreHidden: boolean;
  rows: number[];
  shots: number[];
  lines: number[];
}

// Comment-mark placement within a bounded mid-turn message.
export interface Measured {
  bounded: boolean;
  clip: number;
  wrapper: number;
  firstLine: number;
  panel: number;
  drawn: number;
  cap: number;
  marks: { under: boolean; left: number; right: number; stop: string | null }[];
}

// A 400-by-2000 image exercises height limits that width limits alone cannot enforce.
export const TALL_PICTURE = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="2000">' +
    '<rect width="400" height="2000" fill="#456"/></svg>',
)}`;

// Response blocks for comment-selection tests. COMMENTABLE_ANSWER supplies an earlier answer.
export const COMMENTABLE_RESPONSE =
  '<p>The tokenizer now walks a table.</p>' +
  '<h3>What changed</h3>' +
  '<ul><li>Rewrote the scanner loop</li><li>Added a <strong>bold</strong> claim</li></ul>' +
  '<pre><code>walk(table);\nreturn done;</code></pre>' +
  '<blockquote><p>a quoted line</p></blockquote>' +
  '<table><tr><th>File</th><th>What</th></tr>' +
  '<tr><td>scanner.ts</td><td>the loop is a table walk now</td></tr>' +
  '<tr><td>lexer.ts</td><td>a second row, so a drag can leave the first</td></tr></table>';

export const COMMENTABLE_ANSWER =
  '<p>First pass at the scanner, later rewritten.</p>' + '<ul><li>Tried a switch and gave up on it</li></ul>';

// Selection cases pair a block with a drag or triple-click range.
// Triple-click ranges extend to offset zero of the next block.
export const COMMENT_SHAPES: { where: string; mode: string }[] = [];
for (const where of [
  'p',
  'h3',
  'li',
  'pre',
  'blockquote p',
  'td',
  'answer p',
  'answer li',
  'prompt',
  'prompt1',
  'prompt2',
]) {
  for (const mode of ['contents', 'triple']) COMMENT_SHAPES.push({ where, mode });
}
// A selection across table rows contains row text rather than one cell's text.
COMMENT_SHAPES.push({ where: 'td', mode: 'rows' });

// Select text, save a comment, and report its mark placement.
// The panel keeps comments locally, so no extension reply is needed to draw the mark.
export async function commentLands(page: Page, spec: { where: string; mode: string }): Promise<string> {
  return (await page.evaluate(`(async () => {
    const spec = ${JSON.stringify(spec)};
    const card = document.querySelector('.turn');
    const scope = spec.where.indexOf('answer ') === 0 ? card.querySelector('.answer')
      : spec.where.indexOf('prompt') === 0 ? card : card.querySelector('.summary');
    if (!scope) return 'no ' + spec.where + ' section on the card';
    const pick = spec.where.indexOf('prompt') === 0 ? '.prompt'
      : spec.where.indexOf('answer ') === 0 ? spec.where.slice('answer '.length) : spec.where;
    // prompt is the one that opened the turn; prompt1 and prompt2 are what the reader sent
    // while it ran, in the order they were sent.
    const nth = spec.where.indexOf('prompt') === 0 ? Number(spec.where.slice('prompt'.length) || 0) : 0;
    const target = spec.where.indexOf('prompt') === 0
      ? scope.querySelectorAll(pick)[nth]
      : scope.querySelector(pick);
    if (!target || !target.firstChild) return 'no ' + spec.where + ' to select';

    const totals = () => {
      let on = 0;
      for (const m of document.querySelectorAll('.linemark:not(.offlinemark)')) {
        on += Number(m.dataset.count || 1);
      }
      const off = document.querySelector('.offlinemark');
      const said = off ? /^(d+)/.exec(off.textContent || '') : null;
      return { on: on, off: said ? Number(said[1]) : 0 };
    };
    const before = totals();

    const range = document.createRange();
    if (spec.mode === 'rows') {
      // Out of the row entirely. A drag inside one cell and a triple click in one both clone
      // the cell's own text; only this clones the row, which the walk writes as a line of
      // pipes that is no cell's text.
      const row = target.closest('tr');
      const below = row && row.nextElementSibling;
      const cell = below && below.querySelector('td');
      if (!cell || !cell.firstChild) { range.selectNodeContents(target); }
      else {
        range.setStart(target.firstChild, 0);
        range.setEnd(cell.firstChild, Math.min(5, (cell.textContent || '').length));
      }
    } else if (spec.mode === 'triple') {
      const next = target.nextElementSibling;
      range.setStart(target.firstChild, 0);
      if (next && next.firstChild) { range.setEnd(next.firstChild, 0); }
      else { range.setEndAfter(target.lastChild); }
    } else {
      range.selectNodeContents(target);
    }
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    await ${SETTLED};

    const word = document.querySelector('.quotebar') && document.querySelector('.quotebar').children[0];
    if (!word || document.querySelector('.quotefloat').hidden) return 'the bar offered no way to comment';
    word.click();
    await ${SETTLED};
    const area = document.querySelector('.quoteslot .notearea');
    if (!area) return 'pressing Comment opened no box';
    area.value = 'a comment on ' + spec.where;
    document.querySelector('.quoteslot .notesave').click();
    await ${SETTLED};

    const after = totals();
    if (after.on > before.on) return 'onLine';
    if (after.off > before.off) return 'offLine';
    return 'nowhere';
  })()`)) as string;
}

// Command-menu text, selection, accessibility state, and bounds after keyboard and pointer input.
export interface Menued {
  rows: string[];
  on: string | null;
  active: string | null;
  expanded: string | null;
  value: string;
  caret: number;
  hidden: boolean;
  menu: { top: number; left: number; right: number; bottom: number } | null;
  promptTop: number;
  documentWidth: number;
  viewportWidth: number;
  viewportHeight: number;
  rowHeights: number[];
  posted: { type?: string; text?: string }[];
}

export async function slashMenu(page: Page, keys: string[]): Promise<Menued> {
  return (await page.evaluate(`(async () => {
    const keys = ${JSON.stringify(keys)};
    const box = document.getElementById('prompt');
    box.focus();
    for (const key of keys) {
      if (key === 'Press') {
        const row = document.querySelector('#slashpop .slashrow.on');
        if (row) {
          row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
          row.click();
        }
      } else if (key.indexOf('Caret:') === 0) {
        // The reader clicking or arrowing back into what they already wrote. The caret is
        // what decides which run is offered, so it is moved rather than assumed.
        const at = Number(key.slice('Caret:'.length));
        box.setSelectionRange(at, at);
        document.dispatchEvent(new Event('selectionchange'));
      } else if (key.length === 1) {
        // Typed at the caret rather than appended, so a run written into the middle of a
        // sentence is written the way the reader writes one.
        const at = box.selectionStart;
        box.value = box.value.slice(0, at) + key + box.value.slice(at);
        box.setSelectionRange(at + 1, at + 1);
        box.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        box.dispatchEvent(new KeyboardEvent('keydown', { key: key, bubbles: true, cancelable: true }));
      }
      await new Promise((r) => requestAnimationFrame(r));
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const pop = document.getElementById('slashpop');
    const rows = [...pop.querySelectorAll('.slashrow')];
    const on = pop.querySelector('.slashrow.on');
    const r = pop.hidden ? null : pop.getBoundingClientRect();
    const name = (n) => n.querySelector('.slashname').textContent;
    return {
      rows: rows.map(name),
      on: on ? name(on) : null,
      active: box.getAttribute('aria-activedescendant'),
      expanded: box.getAttribute('aria-expanded'),
      value: box.value,
      caret: box.selectionStart,
      hidden: pop.hidden,
      menu: r ? { top: r.top, left: r.left, right: r.right, bottom: r.bottom } : null,
      promptTop: box.getBoundingClientRect().top,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      rowHeights: rows.map((n) => n.getBoundingClientRect().height),
      posted: window.__posted.slice(-4),
    };
  })()`)) as Menued;
}

// Clear the prompt text field and dispatch input before the next interaction.
export async function clearBox(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const box = document.getElementById('prompt');
    box.value = '';
    box.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}

// Quotes for nested, overlapping, and unmatched comment-tint cases.
export const OUTER = 'The wrapper now only shapes the request and hands the response straight back.';
export const INNER = 'hands the response straight back';
export const WIDE =
  'the panel should retry at all when the transcript is mid-write, ' + 'or wait for the poll to come round again';
export const MIDDLE = 'retry at all when the transcript is mid-write';
export const LATE = 'when the transcript is mid-write, or wait for the poll';
export const SECOND_LINE = 'One question is open: whether ' + WIDE + '.';
// Table-row quote text differs from cell text.
// A mark can match the cell through table handling, but tint requires matching words.
export const ROW = '| scanner.ts | the loop is a table walk now |';

export const TINTED_RESPONSE =
  '<p>Moved the retry logic out of the fetch wrapper. ' +
  OUTER +
  '</p>' +
  '<p>' +
  SECOND_LINE +
  '</p>' +
  '<table><tr><th>File</th><th>What</th></tr>' +
  '<tr><td>scanner.ts</td><td>the loop is a table walk now</td></tr></table>';

// Collapse whitespace and trim the text for quote matching.
export const flatWords = (words: string): string => words.replace(/\s+/g, ' ').trim();

// Render an open card with comments and return them for redraw tests.
// Prefix lead content to place the commented response farther down the card.
export async function tintedCard(page: Page, quotes: string[], lead = ''): Promise<Record<string, unknown>[]> {
  const payload = renderPayload() as { cards: Record<string, unknown>[] };
  payload.cards[0].summaryHtml = lead + TINTED_RESPONSE;
  await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
  await page.evaluate(SETTLED);
  await page.evaluate(`(() => {
    const turn = document.querySelector('.turn');
    if (turn.querySelector('.body').hidden) turn.querySelector('.head').click();
  })()`);
  await page.evaluate(SETTLED);
  const card = (await page.evaluate(`(() => {
    const turn = document.querySelector('.turn');
    return { key: turn.dataset.key, session: turn.dataset.key.split(':')[0] };
  })()`)) as { key: string; session: string };
  const comments = quotes.map((quote, n) => ({
    id: `n${n + 1}`,
    sessionId: card.session,
    turnKey: card.key,
    part: 'summary',
    quote,
    note: `a comment on line ${n + 1}`,
    headline: '',
    sessionTitle: '',
    turnAt: 1,
    at: n + 1,
  }));
  await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'notes', comments })}, '*')`);
  await page.evaluate(SETTLED);
  return comments;
}

// Measure comment tint on the first card. Other fixture cards have no comments.
export const TINT = `(() => {
  const card = document.querySelector('.turn');
  const spans = (root) => [...root.querySelectorAll('.cmark')].map((s) => ({
    text: s.textContent,
    notes: (s.getAttribute('data-notes') || '').split(' ').filter(Boolean),
    background: getComputedStyle(s).backgroundColor,
    cursor: getComputedStyle(s).cursor,
    nested: !!s.parentElement.closest('.cmark'),
  }));
  const cell = card.querySelector('.summary td');
  return {
    paras: [...card.querySelectorAll('.summary p')].map((p) => ({
      marks: p.querySelectorAll('.linemark').length,
      spans: spans(p),
    })),
    cell: cell ? { marks: cell.querySelectorAll('.linemark').length, spans: spans(cell) } : null,
    offLine: card.querySelectorAll('.offlinemark').length,
  };
})()`;

export interface TintSpan {
  text: string;
  notes: string[];
  background: string;
  cursor: string;
  nested: boolean;
}
export interface TintPart {
  marks: number;
  spans: TintSpan[];
}
export interface Tinted {
  paras: TintPart[];
  cell: TintPart | null;
  offLine: number;
}

// Select the second response paragraph and dispatch selectionchange.
export const SELECT_SECOND_LINE = `(() => {
  const card = document.querySelector('.turn');
  const target = card.querySelectorAll('.summary p')[1];
  const range = document.createRange();
  range.selectNodeContents(target);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
})()`;

// Read whether the comment editor opened and which quote it shows.
export const BOX_OPEN = `(() => {
  const box = document.querySelector('.quoteslot .noteedit');
  const said = box ? box.querySelector('.notesaid') : null;
  return { open: !!box, said: said ? said.textContent : '' };
})()`;

// Measure prompt-box picker controls, draft setup, Send, and the prompt text field.
export const PICKER_ROW = `(() => {
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  };
  const composer = document.getElementById('composer');
  return {
    composer: box(composer),
    row: box(composer.querySelector('.cpicks')),
    picks: [...composer.querySelectorAll('.cpick')].map((n) => {
      const at = box(n);
      at.control = n.dataset.control;
      at.label = n.textContent;
      at.disabled = n.disabled;
      return at;
    }),
    figure: box(composer.querySelector('.cctx')),
    tag: box(composer.querySelector('.cdrafttag')),
    // The chip on its own. The line that holds it is a block and fills the composer whatever
    // the chip does, so a chip too wide for the panel overflows a box that still measures as
    // fitting.
    tagChip: box(composer.querySelector('.cdraftword')),
    // Every span the tag draws, and the whole setup off the container's tooltip.
    tagWords: [...composer.querySelectorAll('.cdrafttag > span')].map((n) => n.textContent),
    tagDetail: (composer.querySelector('.cdrafttag') || { title: '' }).title,
    send: box(composer.querySelector('.csend')),
    prompt: box(composer.querySelector('#prompt')),
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  };
})()`;

export interface Placed {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  control?: string;
  label?: string;
  disabled?: boolean;
}
export interface PickerRow {
  composer: Placed;
  row: Placed;
  picks: Placed[];
  figure: Placed | null;
  send: Placed | null;
  prompt: Placed | null;
  tag: Placed | null;
  tagChip: Placed | null;
  tagWords: string[];
  tagDetail: string;
  documentWidth: number;
  viewportWidth: number;
  viewportHeight: number;
}

// Reopen the MCP servers menu so its placement reflects the current viewport.
export const OPEN_SERVERS = `(() => {
  const control = document.querySelector('[data-control="mcp"]');
  if (!control) return false;
  // Shut first if it is already standing. The foot redraws only when something about it
  // changed and the placement runs at the end of that redraw, so a menu left open from the
  // last width would keep the coordinates it was given there.
  if (!document.getElementById('pickpop').hidden) control.click();
  control.click();
  return true;
})()`;

export const MENU_BOX = `(() => {
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  };
  const pop = document.getElementById('pickpop');
  return {
    hidden: pop.hidden,
    pop: box(pop),
    scrollHeight: pop.scrollHeight,
    clientHeight: pop.clientHeight,
    head: box(pop.querySelector('.pickhead')),
    rows: [...pop.querySelectorAll('.pickrow')].map((n) => {
      const at = box(n);
      at.control = n.dataset.control;
      at.role = n.getAttribute('role');
      return at;
    }),
    anchor: box(document.querySelector('[data-control="mcp"]')),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  };
})()`;

export interface MenuBox {
  hidden: boolean;
  pop: Placed;
  scrollHeight: number;
  clientHeight: number;
  head: Placed | null;
  rows: (Placed & { role?: string })[];
  anchor: Placed;
  viewportWidth: number;
  viewportHeight: number;
}

// Render the draft payload at the requested width.
export async function draftLayoutAt(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.evaluate(`window.postMessage(${JSON.stringify(draftRenderPayload())}, '*')`);
  await page.evaluate(SETTLED);
}

// Close any open picker menu before opening the agent menu to refresh placement.
export const OPEN_AGENT = `(() => {
  const control = document.querySelector('[data-control="agent"]');
  if (!control) return false;
  if (!document.getElementById('pickpop').hidden) control.click();
  control.click();
  return true;
})()`;

export const AGENT_MENU = `(() => {
  const pop = document.getElementById('composer-agent-list');
  return {
    hidden: pop.hidden,
    rows: [...pop.querySelectorAll('.pickrow')].map((n) => n.dataset.control),
  };
})()`;

export interface Measured {
  height: number;
  faceHeight: number;
  rows: number;
  promptTop: number;
  aboveBox: boolean;
  insideComposer: boolean;
  borderless: boolean;
  gap: number;
  shownFaces: number;
  state: string;
  name: string | null;
  text: string;
  span: string | null;
  statusTitle: string | null;
  priceText: string;
  priceGap: number;
  statusGap: number;
  priceTabIndex: number;
  priceTabbable: boolean;
  pressable: boolean;
  lineIsButton: boolean;
  lineTitle: string | null;
  priceTitle: string | null;
  wordsHidden: boolean;
  clipped: boolean;
  ellipsis: string;
  tabular: string;
}

// Measure the next-turn line above the prompt text field.
// Compare face height with its nowrap height to count rows without parsing CSS line-height.
export const NEXT_TURN = `(() => {
  const composer = document.getElementById('composer');
  const node = composer.querySelector('.cnextturn');
  const prompt = document.getElementById('prompt');
  if (!node || !prompt) return null;
  const box = node.getBoundingClientRect();
  const shown = [...node.querySelectorAll('.cnextturnface')]
    .filter((face) => getComputedStyle(face).visibility !== 'hidden');
  const face = shown[0] || null;
  const price = face ? face.querySelector('.cnextturnprice') : null;
  const span = face ? face.querySelector('.cnextturnspan') : null;
  const words = face ? face.querySelector('.cnextturnwords') : null;
  const status = face ? face.querySelectorAll('.cnextturnwords')[1] : null;
  const style = getComputedStyle(node);
  const faceBox = face ? face.getBoundingClientRect().height : 0;
  let oneRow = faceBox;
  if (face) {
    const kept = face.style.whiteSpace;
    face.style.whiteSpace = 'nowrap';
    oneRow = face.getBoundingClientRect().height;
    face.style.whiteSpace = kept;
  }
  return {
    height: Math.round(box.height),
    faceHeight: Math.round(faceBox),
    rows: oneRow > 0 ? Math.round(faceBox / oneRow) : 0,
    promptTop: Math.round(prompt.getBoundingClientRect().top),
    aboveBox: box.bottom <= prompt.getBoundingClientRect().top + 1,
    insideComposer: box.left >= composer.getBoundingClientRect().left - 1
      && box.right <= composer.getBoundingClientRect().right + 1,
    borderless: parseFloat(style.borderBottomWidth) === 0,
    gap: Math.round(prompt.getBoundingClientRect().top - box.bottom),
    shownFaces: shown.length,
    state: node.dataset.state,
    name: price ? price.getAttribute('aria-label') : null,
    text: face ? face.textContent : '',
    span: span ? span.textContent : null,
    statusTitle: status ? status.querySelector('[title]')?.getAttribute('title') ?? status.getAttribute('title') : null,
    priceText: price ? price.textContent : '',
    priceGap: price && words ? Math.round(price.getBoundingClientRect().left - words.getBoundingClientRect().right) : 0,
    statusGap: price && status ? Math.round(status.getBoundingClientRect().left - price.getBoundingClientRect().right) : 0,
    // The tab order, not merely focusability: focus() succeeds on a control carrying
    // tabindex="-1", which the Tab walk never reaches.
    priceTabIndex: price ? price.tabIndex : -1,
    priceTabbable: (() => { if (!price) return false; price.focus(); return document.activeElement === price; })(),
    pressable: !!price && price.tagName === 'BUTTON',
    lineIsButton: node.tagName === 'BUTTON',
    lineTitle: node.getAttribute('title'),
    priceTitle: price ? price.getAttribute('title') : null,
    wordsHidden: !!words && words.getAttribute('aria-hidden') === 'true',
    // A figure that has been cut is a wrong figure, so nothing here may ellipsize.
    clipped: node.scrollWidth > node.clientWidth + 1,
    ellipsis: style.textOverflow,
    tabular: style.fontVariantNumeric,
  };
})()`;

// Finished-subagent tooltip with duration and tool count.
export const REVIEW_CHILD_HINT = '3m · 23 tools';
// Cost-popover entries with usage details.
export const REVIEW_COST_ENTRIES = [
  {
    label: 'Cost by usage · opus-5',
    value: '$0.31',
    lines: [
      { text: 'Output: $0.11', cost: true },
      { text: 'Uncached input: $0.62', cost: true },
    ],
  },
];
// Plain-text cost detail for a popover without entries.
export const REVIEW_COST_RECORD = [
  '$0.31 spent',
  '',
  'Cost by usage · opus-5: $0.31',
  '  Output: $0.11',
  '  Uncached input: $0.62',
].join('\n');
// Commit and file filters identify rows in the long fixture card.
// The final path represents a file contributed by a subagent.
export const REVIEW_SHAS = ['9d7be30', 'b83e0d1'];
export const REVIEW_PATHS = [
  'c:/repo/extension/src/turncard.ts',
  'c:/repo/docs/architecture.md',
  'c:/repo/extension/src/panel.layout.cards.test.ts',
];

// Subagent-row states. The supplied clock fixes elapsed time for running rows.
export function subagentRows(now: number) {
  return [
    {
      description: 'Review child',
      model: 'opus-5',
      effort: 'high',
      figures: [
        {
          metric: 'cost',
          compactLabel: '$0.31',
          name: '$0.31 spent',
          record: { heading: { label: '$0.31 spent' }, entries: REVIEW_COST_ENTRIES },
          detail: REVIEW_COST_RECORD,
        },
        {
          metric: 'commits',
          compactLabel: '2 commits',
          name: '2 commits made',
          shas: REVIEW_SHAS,
          record: { heading: { label: '2 commits' }, layout: 'commits', actions: true, entries: [] },
          detail: '2 commits made',
        },
        {
          metric: 'files',
          compactLabel: '3 files',
          name: '3 files, 18 lines added, 4 removed',
          added: 18,
          removed: 4,
          paths: REVIEW_PATHS,
          record: {
            heading: { label: '3 files, 18 lines added, 4 removed' },
            layout: 'files',
            actions: true,
            entries: [],
          },
          detail: '3 files, 18 lines added, 4 removed',
        },
        // A figure with nothing behind it stays plain text, and the keyboard passes it by.
        { metric: 'tokens', compactLabel: '48k tokens', name: '48k tokens' },
      ],
      state: 'done',
      stateWord: '',
      since: null,
      hintDetail: REVIEW_CHILD_HINT,
      sessionId: 'child-session',
    },
    {
      description: 'Broken child',
      model: 'opus-5',
      effort: null,
      figures: [],
      state: 'failed',
      stateWord: 'failed',
      since: null,
      hintDetail: '2 tools',
      sessionId: 'broken-session',
    },
    {
      description: 'Busy child',
      model: 'opus-5',
      effort: null,
      figures: [],
      state: 'running',
      stateWord: 'running',
      since: now - 21 * 60_000 - 5_000,
      hintDetail: '',
      sessionId: 'busy-session',
    },
    {
      description: 'Quiet child',
      model: 'haiku-4-5',
      effort: null,
      figures: [],
      state: 'running',
      stateWord: 'running',
      since: now - 5_000,
      hintDetail: '4 tools',
      sessionId: null,
    },
    {
      description: 'Cut child',
      model: 'opus-5',
      effort: null,
      figures: [],
      state: 'interrupted',
      stateWord: 'interrupted',
      since: null,
      hintDetail: '',
      sessionId: 'cut-session',
    },
    {
      description: 'Left child',
      model: 'opus-5',
      effort: null,
      figures: [],
      state: 'stopped',
      stateWord: 'stopped',
      since: null,
      hintDetail: '',
      sessionId: 'left-session',
    },
    {
      // This open subagent has no launch timestamp for an elapsed-time figure.
      description: 'Open child',
      model: 'opus-5',
      effort: null,
      figures: [],
      state: 'open',
      stateWord: 'running',
      since: null,
      hintDetail: '',
      sessionId: 'open-session',
    },
    {
      // Long description and model text exercise wrapping in a narrow panel.
      description: 'Review the panel implementation for correctness, maintainability, and interaction design findings',
      model: 'claude-haiku-4-5-20251001',
      effort: 'high',
      figures: [
        { metric: 'cost', compactLabel: '$12.40' },
        { metric: 'commits', compactLabel: '11 commits' },
        {
          metric: 'files',
          compactLabel: '148 files',
          name: '148 files, 24913 lines added, 10842 removed',
          added: 24913,
          removed: 10842,
        },
      ],
      state: 'done',
      stateWord: '',
      since: null,
      hintDetail: '412 tools',
      sessionId: 'long-session',
    },
  ];
}
