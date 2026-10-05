// Shared helpers for the panel-layout browser test files.
//
// The tests that drive a real browser and measure the panel live in `extension/src/panel.layout*.test.ts`.
// Those files import their fixtures and measurement helpers from here so each one stays a plain list of tests.

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

// The walk the panel uses comes from its production owner.
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

// The page, rendered once at a given width, with everything measured off it.
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

// Every one of these runs in the page as a **string**, never as a function. This file is
// transpiled before it runs, and a transpiler rewrites an arrow function to call helpers of
// its own; handed to the browser, that function throws on a helper the page has never heard
// of. A string is the source the page actually gets.
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

// Where the three sticky rows sit once the page has moved under them, and where the foot
// begins. A sticky row that has ridden up above the viewport is drawn off the top of the
// panel; anything below the foot's own top edge is drawn behind it.
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

// The rail scrolls inside itself rather than with the page, so the page scroll above says
// nothing about what its own headings do. This reads the box that stays over them and every
// heading drawn, each one twice: where it sits in the scroller, which does not move, and
// where it is drawn, which is the whole question.
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

// The name a screen reader would read for one element, taken from Chromium's own
// accessibility tree. A hand-rolled version built by walking `textContent` and `aria-label`
// risks its own answer, one no real screen reader gives. This asks the browser the same
// question a screen reader asks.
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

// The sentinel, measured on the real page. Two states, because they draw different elements:
// the button that asks for a page, and the status line that replaces it at the first turn.
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

// Where the foot stands against the bar under it, with nothing about the page changed but
// its width. The bar wraps to a second row in a narrow panel and the box grows with what is
// in it, and neither of those reaches the composer's own print.
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

// Which choice rows on the drawn request card wear the taken mark, in the order they are
// drawn. Read off the class rather than off the controls, because the class is what puts the
// ground on the row and a control the stylesheet never reached would still report checked.
export async function pickedRows(page: Page): Promise<boolean[]> {
  return (await page.evaluate(`(() => [...document.querySelectorAll('.cask .caskchoice')]
    .map((row) => row.classList.contains('is-picked')))()`)) as boolean[];
}

// Every question the card has on screen. One question at a time is the whole of the change,
// so a guard that reads the choices without reading this measures a card that could still be
// drawing all of them.
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

// What the strip shows and where its one tab stop is. The value is read off the face rather
// than off the name, because past the second row the face drops it and the name keeps it.
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

// One question, which is the card that needs no strip. A strip of one tab is a tab widget over
// nothing, and no board draws one.
export const ONE_QUESTION_ASK = {
  ...THREE_QUESTION_ASK,
  id: 'layout-one',
  toolUseId: 'layout-one-tool',
  questions: [THREE_QUESTION_ASK.questions[0]],
};

// Claude names a question by the question itself, so a real card carries ids holding spaces
// and a question mark. `aria-controls` and `aria-labelledby` are space-separated lists of ids,
// so an id built from one of those resolves to nothing at all.
export const SPOKEN_ID_ASK: Ask = {
  ...THREE_QUESTION_ASK,
  id: 'layout-spoken',
  toolUseId: 'layout-spoken-tool',
  questions: THREE_QUESTION_ASK.questions.map((question) => ({ ...question, id: question.question })),
};

// A question request holding no questions. The Codex wire builds one whatever its list holds,
// and the reader still needs the way out of it.
export const NO_QUESTION_ASK: Ask = {
  ...THREE_QUESTION_ASK,
  id: 'layout-empty',
  toolUseId: 'layout-empty-tool',
  questions: [],
};

// Every question of the six answered: the first in the reader's own words, which is the long
// value in practice, the four after it off the list, and the last in its password box. It is
// the state the strip is widest in, which is what the two-row rule is about.
export async function answerSixQuestions(page: Page): Promise<void> {
  const six = SIX_QUESTION_ASK.questions;
  await page.locator(`[data-control="ask:layout-six:${six[0].id}:Other"]`).click();
  await page.locator(`[data-control="askwritten:layout-six:${six[0].id}"]`).fill(LONG_WRITTEN_ANSWER);
  // Next, because a written answer never moves the card by itself.
  await page.locator('[data-control="ask:layout-six:answer"]').click();
  for (const question of six.slice(1, -1)) {
    await page.locator(`[data-control="ask:layout-six:${question.id}:${question.options[0].label}"]`).click();
  }
  const secret = six[six.length - 1];
  await page.locator(`[data-control="ask:layout-six:${secret.id}:Other"]`).click();
  await page.locator(`[data-control="askwritten:layout-six:${secret.id}"]`).fill('the-secret-answer');
}

// How many rows the strip took, and whether it gave up its values to get there.
export const STRIP_ROWS = `(() => {
  const strip = document.querySelector('.cask .casktabs');
  return {
    marked: strip.classList.contains('is-marked'),
    rows: new Set([...strip.querySelectorAll('.casktab')].map((tab) => tab.offsetTop)).size,
  };
})()`;

// The mark on a commented line, measured. Its vertical place is the one it would have had in
// the line, and its horizontal place is a negative offset into the indent the card body
// already leaves. Neither is knowable from the source: a mark clipped away by a code block,
// pushed under the card's own left edge, or dropped a line below the text it belongs to reads
// exactly like a working one to every text scan in this repository.
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
  // The marks are read in the order the card draws the response and then You asked, which is
  // the order the Prompt position setting draws with the prompt below the response.
  await page.evaluate(
    `window.postMessage(${JSON.stringify({ ...renderPayload(), timelineLayout: { cardLayout: 'compact', promptPosition: 'below' } })}, '*')`,
  );
  await page.evaluate(SETTLED);
  // The first card, opened, because a folded body has no layout at all. Only where it is
  // shut: the open set outlives a render, so a second pass would fold it again.
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

// One rail card's meta line: the words on it, whether each drew as a single unbroken run,
// how tall the line came out against one line of its own text, how far past the card it
// runs, and whether the first word had to be cut to fit inside the column.
export interface MetaLine {
  words: string[];
  rects: number[];
  overflow: number;
  clipped: boolean;
}

// How many lines a span's words actually came out on. Its own box cannot answer that: a
// flex item is blockified whatever it was written as, so `getClientRects` on the span gives
// one rect around the whole block however many lines of text sit inside it, and its height
// grows in step with the line's, so a box-against-box check moves with the fault rather
// than catching it. A range over the contents is measured instead.
//
// Counted by how many heights the rects sit at, and never by how many rects there are. A
// clipped end draws a second rect at the same top as the first, so a span cut by its own
// ellipsis reads as two lines to a count and as one to this.
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

// The meta line under a rail card's name, at the narrowest column the sash can leave it.
//
// It is one line, or the card is wrong. The name above it was given nowrap and an ellipsis
// when it was written and this line was not, so each of its spans shrank to its longest
// word and then wrapped inside it: the agent's name over two lines with the time under it
// over two more, on a card at nothing like the rail's minimum. Nothing measured a card's
// own contents, so every text scan of the stylesheet read the rule as working.
//
// The words are the widest run the panel can actually draw and not an invented one. A
// pinned session another agent ran says `run by an agent` where a name would go, its
// last turn failed, and unfinished input replaces the time with `unsent`.
// What the workspace has filed, for the editor the guard below opens. The rows come from the
// extension in the real panel, so a page with no extension behind it answers the ask here.
export const EDITOR_LABELS: Record<string, string[]> = {
  s1: ['composer', 'release 0.4', 'perf'],
  s2: ['release 0.4', 'rail'],
  s3: ['rail'],
  s4: ['worktree parallel sessions and the rails'],
};

// The label editor, opened over the rail and measured.
//
// It is a popover about one card, hung off a control on that card, so the first thing it can
// get wrong is covering the session it is about. The second is its own rows: a name as
// long as a reader can type has to give way to the count beside it rather than push it out of
// the popover. Neither shows in a scan of the stylesheet.
//
// The keyboard is measured here too, because it is the part no text scan can answer at all.
// The popover sits on the document body, outside the rail, so the page's own arrow-key walk
// never reaches into it and the walk inside it is the only way through by keyboard.

// One heading's label line, as the browser laid it out.
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

// One card's label line, as the browser laid it out. Every figure is a distance rather than
// a verdict, so a failure says how far out the line came and not only that it did.
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

// The same press, with a reply arriving on it. As long as the panel ever holds, which is the
// only length worth measuring: the card keeps a tail and this is a full one, so the line runs
// off the row at every width the panel is dragged to and which end gets cut is a real answer.
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

// The three rows the skills popover can draw, as a card carries them. Written out here rather
// than parsed, so the guard measures what the panel does with each row and not what the parser
// made of one recording.
export const RECORDED_SKILL_PATH = 'c:/repo/.claude/skills/review-the-change/SKILL.md';
export const MOCKUP_SKILL_PATH = 'c:/repo/.claude/skills/panel-mockup/SKILL.md';
// The published paragraph a skill's front matter carries, the way a real one reads before
// anything cuts it.
export const MOCKUP_SKILL_FULL_DESCRIPTION =
  'Review the panel, draw a mockup for it, and check every candidate against real panel ' +
  'shots before the reviewer signs off on the version the team ships to every reader on ' +
  'every platform.';
// What the row actually shows: the same cut `activitySkillsOf` puts on every skill's
// description, so the fixture never clamps a length production would not have reached.
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

// One mid-turn message as the browser laid it out: whether the bound cut it, how far it
// cleared or broke the cut, what the control under it offers, and the tab stop each control
// inside it holds.
export interface BoundedBlock {
  bounded: boolean;
  height: number;
  bound: number;
  moreHidden: boolean;
  moreWord: string;
  stops: (string | null)[];
  under: boolean[];
}

// One bounded message, and where the browser put the cut in it.
export interface SnappedBlock {
  cut: number;
  bound: number;
  height: number;
  moreHidden: boolean;
  rows: number[];
  shots: number[];
  lines: number[];
}

// One commented mid-turn message as the browser laid it out.
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

// A picture far taller than it is wide, so both bounds have work to do. The width bound alone
// holds a wide screenshot inside the panel and does nothing to this one, which would run
// 2000px down a 900px viewport and take every card under it off the screen.
export const TALL_PICTURE = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="2000">' +
    '<rect width="400" height="2000" fill="#456"/></svg>',
)}`;

// A response holding every shape a real one does, and an earlier answer under it. The answer
// is the piece no fixture in this repository drew under a comment before, and it is where the
// fault below lived.
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

// Which block to select in, and how the reader selected it. contents is a drag inside one
// line. triple is what a triple click actually gives in Chromium, which runs to offset zero of
// the next block and so carries the block boundary with it.
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
// A table earns a third way of being selected. Its lines are its cells, and a drag that leaves
// the row is the one shape where what the walk writes is not a line at all.
COMMENT_SHAPES.push({ where: 'td', mode: 'rows' });

// Select a line, press Comment, save, and say where the mark went.
//
// The whole path in one go, because the halves each read correct on their own. The panel keeps
// its own copy of the comments, so the mark is drawn even though no extension answers the
// message the save posts.
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

// What the command menu is showing, after a run of real keys and presses through the box.
//
// Driven rather than drawn. The menu narrows on what is in the box, so a guard that called
// the builder directly would measure a list nobody ever typed.
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

// The box, emptied the way a completed prompt leaves it, so each run below starts from
// nothing rather than from what the run before it typed.
export async function clearBox(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const box = document.getElementById('prompt');
    box.value = '';
    box.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}

// The tint on the commented words, measured in a browser.
//
// This is the only check in the repository that can see it at all. A tint painted onto the
// wrong words, painted twice over the run two comments share, or left behind after the box
// shuts reads exactly like a working one to every text scan: the classes are there, the
// functions are named, and nothing in Node draws a colour.
//
// The paragraphs are the mockup's own cases. One comment inside another, three overlapping
// with one crossing another's edge rather than sitting inside it, and a quote no line of the
// card holds as words.
export const OUTER = 'The wrapper now only shapes the request and hands the response straight back.';
export const INNER = 'hands the response straight back';
export const WIDE =
  'the panel should retry at all when the transcript is mid-write, ' + 'or wait for the poll to come round again';
export const MIDDLE = 'retry at all when the transcript is mid-write';
export const LATE = 'when the transcript is mid-write, or wait for the poll';
export const SECOND_LINE = 'One question is open: whether ' + WIDE + '.';
// A quote no line holds as words. A drag down a table clones the row, so what was stored is a
// line of pipes; the cell it began in reads `scanner.ts` and holds none of that. The mark
// still finds the cell, because a mark matches on a coarser rule, and the tint refuses.
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

// One run of drawn words as the quote that found them reads: every run of whitespace is one
// space, which is the panel's own rule for both sides of the search.
export const flatWords = (words: string): string => words.replace(/\s+/g, ' ').trim();

// The card, opened, with a written-out set of comments on it. The comments come back, so a
// guard can send the same set again and see what a redraw does with the tint already there.
// Lines in `lead` go ahead of the response, which puts the commented lines far down the card.
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

// What the card came out as. Read off the first card alone, because every other card in the
// fixture draws a summary of its own and none of them carry comments.
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

// The words a selection is made of, as one string, so a guard can say the box opened on the
// line the reader had rather than on some other one.
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

// What the box came out as, or nothing where none opened.
export const BOX_OPEN = `(() => {
  const box = document.querySelector('.quoteslot .noteedit');
  const said = box ? box.querySelector('.notesaid') : null;
  return { open: !!box, said: said ? said.textContent : '' };
})()`;

// The composer's picker row, measured with every control on it.
//
// The row holds four controls for an agent with MCP servers and three for one without, and
// every guard above this one draws a machine with none. So the four-control row is measured
// here and nowhere else, which is exactly the shape of the fault at the top of this file: one
// more item in a flex row, and nothing in the repository looking at what the row did with it.
//
// The narrow width is the case that decides it. A wide panel has room for anything, and the
// row wraps rather than scrolling, so what breaks is a control pushed off the edge or the box
// and the send squeezed out from under it.
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

// The servers menu, opened and measured.
//
// It is the tallest thing the popover ever holds: one row per server, each carrying the
// state, the tool count, where it is configured and, for a failed one, the error.
// `placePickPop` puts the popover above the control that opened it where there is room and
// below it where there is not, and the control sits at the bottom of the panel. So a menu
// this tall placed the wrong way runs off the bottom edge and takes its last rows with it.
//
// No text scan can see that. The menu draws, every row is there in the markup, the panel
// throws nothing, and the reader finds out by opening it.
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

// The same page with the composer aimed at a draft. It replaces the composer and its menus
// and leaves every other figure the payload carries alone.
export async function draftLayoutAt(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.evaluate(`window.postMessage(${JSON.stringify(draftRenderPayload())}, '*')`);
  await page.evaluate(SETTLED);
}

// The agent control, pressed. Shut first if a menu is already standing, because the foot is
// redrawn only when something about it changed and the placement runs at the end of that
// redraw.
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

// What the line above the box measures, in each state and at each width.
//
// `rows` compares the face against its own height with wrapping turned off, which is the one
// measure that does not need the stylesheet's line height to be a readable number.
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

// A finished child's own hover, as `agentDisplay` writes it: the duration and the tool uses,
// which word the row's own state. Every total the row draws sits on a figure of its own.
export const REVIEW_CHILD_HINT = '3m · 23 tools';
// The record behind the cost figure, in the shape the card's own Cost popover draws: a block
// headed by the spend, its total in a second column, and its lines indented under it.
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
// The same record as one run of text, which the popover reads where it has no list to draw.
export const REVIEW_COST_RECORD = [
  '$0.31 spent',
  '',
  'Cost by usage · opus-5: $0.31',
  '  Output: $0.11',
  '  Uncached input: $0.62',
].join('\n');
// What the commits and the files records are filtered to. Both are shas and paths the long
// fixture card already holds rows for, so each record draws the card's own rows. The last path
// is one no edit of the turn recorded: the card holds a row for it only because it merged what
// a child recorded into its own files, which is how a child's paths reach a card in production.
export const REVIEW_SHAS = ['9d7be30', 'b83e0d1'];
export const REVIEW_PATHS = [
  'c:/repo/extension/src/turncard.ts',
  'c:/repo/docs/architecture.md',
  'c:/repo/extension/src/panel.layout.cards.test.ts',
];

// Every state a subagent row takes, as the card record carries it. `since` is filled from the
// page clock, so the running figure is known.
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
      // An open child of a turn that no longer runs. Its record carries no launch time to count from.
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
      // The longest description and the longest model run a record has held, so the panel's
      // narrowest width is measured on the row that wraps rather than on one that never can.
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
