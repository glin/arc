// The page the panel is served, and one render payload full enough to fill it.
//
// Two things build the real panel outside the editor. The `panel.layout*.test.ts` files
// measure it in a browser, and `scripts/panel-shots.ts` photographs it. Neither can read the other: a
// test file registers its tests as soon as anything imports it, so a script that reached for
// the page would run the whole suite to get it. The page and the payload live here instead,
// and both read them from one place.
//
// Nothing that ships imports this file. It sits beside the modules it calls so the fixture is
// built by the panel's own builders, which is what keeps it in step with the panel: a field
// either builder grows is carried into this page the way it is carried into the real one.

import { formatRelative, railSessions, toCard } from './turnview.ts';
import { labelCounts } from './turnlabels.ts';
import type { SavedView } from './domain/views.ts';
import type { SavedRailFilter } from './domain/rail-filters.ts';
import type { RailStatus } from './turnrail.ts';
import type {
  Turn,
  TurnAgent,
  TurnAsk,
  TurnCommit,
  TurnFileChange,
  TurnStep,
  TurnStepStatus,
  TurnUpdate,
} from './transcript.ts';
import {
  nextTurnBasisOf,
  sessionCostProjection,
  sessionStats,
  sessionTurnStats,
  toCompactionCard,
  type ActivityRow,
  type SessionStatChip,
  type TurnStatus,
} from './turncard.ts';
import type { ProjectSpendView } from './projectspend.ts';
import type { CompleteSetupValues, PinnedSetup } from './domain/session-setups.ts';
import type { Ask, PermissionAsk, QuestionAsk } from './agentwire.ts';
import { usageBar } from './usageview.ts';
import { composerView, pickMenu, sessionLauncherView } from './composerview.ts';
import { fillPanelText, panelValues } from './paneltext.ts';
import { browserBundle, browserStylesheet } from './panelbundle.ts';
import { renderRichMarkdown } from './richtext.ts';
import type { Compaction } from './transcript.ts';

// Fill the same built script and stylesheet that the extension serves.
let builtScript: string | null = null;
let builtStylesheet: string | null = null;
function evaluated(name: 'STYLE' | 'SCRIPT'): string {
  if (name === 'SCRIPT') {
    builtScript ??= browserBundle().text;
    return fillPanelText(builtScript, panelValues());
  }
  builtStylesheet ??= browserStylesheet();
  return fillPanelText(builtStylesheet, panelValues());
}

// The shell `PanelProvider.shell` serves, minus the content-security policy and the
// nonces, which are about what a webview may load rather than about how it lays out.
export function pageHtml(): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Arc</title>
<style>${evaluated('STYLE')}</style></head>
<!-- The class the editor puts on the body of a webview it serves in a dark theme. The panel
     keys the browser's colour scheme off it, so the native radios and checkboxes on a
     request card are drawn dark here the way they are in the editor. -->
<body class="vscode-dark">
<h1 class="sr-only">Arc</h1>
<main id="list" aria-label="Timeline"><p class="empty" data-startup-status role="status" aria-live="polite" aria-atomic="true">Reading sessions…</p></main>
<script>
  // What the extension host injects and what the webview asks it for. The panel posts to
  // this on nearly every press, so it records rather than throwing.
  window.__posted = [];
  const SAVED_STATE = {};
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => window.__posted.push(m),
    getState: () => ({}),
    setState: () => undefined,
  });
</script>
<script>${evaluated('SCRIPT')}</script>
</body></html>`;
}

// A session with enough in it to fill the column.
//
// The cards and the rail are built by the panel's own builders rather than written out
// here, so a field either grows is carried into this page the way it is carried into the
// real one. The headlines are long on purpose: the list sizes from its content, so a short
// one would fit beside the rail even in a body that wraps, and the guard would pass over
// the very bug it exists for.
const HEADLINE =
  'Landed the usage reducer in extension/src/usageview.ts, wired both wires to it, and put the refresh path behind one press on the strip rather than on every repaint of the panel';
// How far the newest turn sits behind the fixture's clock.
//
// The ten minutes are two bounds, not a preference. Over a minute, so the newest card reads
// as an elapsed age rather than "just now". Under an hour, so its turn is still inside the
// quiet window that makes a turn read as running.
export const NEWEST_TURN_AGE = 10 * 60_000;

// Where in the local day the fixture stands. The newest card sits `NEWEST_TURN_AGE` behind
// this, at 2:32 PM, which is the time the rail rows below write beside their names.
export const ANCHOR_HOUR = 14;
export const ANCHOR_MINUTE = 42;

// The instant the fixture treats as now, on the local calendar rather than on a pinned date.
//
// The rail files a card under a day by the calendar. A pinned date walks out of Today, then
// out of Yesterday, then out of Last 7 days. The page then stops drawing the buckets the
// layout test measures. A pinned 2026-08-28 passed for eight days and then failed every day
// after. Every card here is placed as an offset from this value.
//
// The answer stands at one position in the local day whatever clock it is handed. The fixture
// reaches back thirty-one hours, and the rail files each card by the browser's own calendar.
// A clock that followed the real one would move cards between Today and Yesterday with the
// hour of the run.
//
// Where the two buckets divide holds on every day of a standard length. A daylight-saving
// change makes two days a year twenty-three or twenty-five hours long, and one card crosses
// the divide on each of them. Both buckets keep cards either way, so the page draws both.
//
// The answer never sits in the future of the clock it is given, so every age the page draws
// from it is an elapsed one.
export function fixtureClock(realNow: number): number {
  const at = new Date(realNow);
  const anchor = new Date(at.getFullYear(), at.getMonth(), at.getDate(), ANCHOR_HOUR, ANCHOR_MINUTE, 0, 0);
  // The day before, until the anchor has passed. A calendar step rather than a subtracted day
  // length, so a daylight-saving change keeps the same wall time.
  if (anchor.getTime() > realNow) {
    anchor.setDate(anchor.getDate() - 1);
  }
  return anchor.getTime();
}

// The clock every guard and every picture of this page runs on. `test/browser.ts` starts the
// browser on it, so the day the page files a card under is the day the fixture placed it in.
export const FIXTURE_CLOCK = fixtureClock(Date.now());

export const NOW = FIXTURE_CLOCK - NEWEST_TURN_AGE;

// One card carries a path long enough to have no wrapping point in it. A flex item that has
// not been told it may shrink below its content refuses to, and the panel then scrolls
// sideways: a fixture made only of ordinary prose never asks the question.
export const LONG_PATH =
  'extension/src/deeply/nested/generated/fixtures/one-very-long-unbroken-directory-name/another-one-just-as-long/report.json';

// The turn the long card is built from. Its own index in `FIXTURE_TURNS`, so a guard, a
// picture and a measurement all reach the same card without counting rows.
export const LONG_TURN_N = 3;
export const LONG_TURN_INDEX = LONG_TURN_N - 1;

// The response of the long turn, as markdown, because the card renders markdown. Two
// paragraphs around a list, which is the shape a turn that delegated work and committed
// actually answers with. A one-line response draws a card as tall as its sections, and a
// design measured against that card is measured against the wrong problem.
export const LONG_SUMMARY = `The morning went to the tasks on the list from last week. Most of them were small, and each one closed before the next one started, so the list is shorter now than it has been for a while. Two items took longer than planned because they waited on answers from other people.

- The first item was a set of notes from the planning meeting, tidied and shared with the group so everyone reads the same version.
- The second item was a review of the open questions, with each one given an owner and a date for the answer.
- The third item was a short list of chores for the week, sorted by how long each one takes.
- The last item was a reply to the messages that came in overnight, so nothing is left waiting.

Everything that was planned for today is done. The two items that waited on other people have answers now, and the rest of the week has room for the larger piece of work that comes next.`;

// What the long turn carries in each of its record sections. Seven files at the lengths a
// real repository produces, three delegated runs, and two commits. The paths are spread from
// a bare \`README.md\` to the unbroken one above, because a column of names that are all the
// same length asks the layout nothing.
const LONG_FILES: TurnFileChange[] = [
  { path: 'c:/repo/extension/src/webview/card.ts', added: 142, removed: 38, isNew: false, edits: [] },
  { path: 'c:/repo/extension/src/webview/panel.css', added: 64, removed: 9, isNew: false, edits: [] },
  { path: 'c:/repo/extension/src/turncard.ts', added: 51, removed: 17, isNew: false, edits: [] },
  {
    path: 'c:/repo/extension/src/webview/sections/fold-state/section-fold-memory.ts',
    added: 9,
    removed: 2,
    isNew: false,
    edits: [],
  },
  { path: 'c:/repo/extension/src/webview/section-fold.test.ts', added: 96, removed: 0, isNew: true, edits: [] },
  { path: 'c:/repo/docs/architecture.md', added: 12, removed: 4, isNew: false, edits: [] },
  { path: 'c:/repo/README.md', added: 2, removed: 1, isNew: false, edits: [] },
];

// The id of the call that launched the long turn's open subagent.
const LONG_AGENT_LAUNCH = 'toolu-find-fixed-waits';

// Where the long turn's commits are placed on the clock, and where the rest of its record is.
// Every stamp below hangs off this, so the card's rows read in the order the turn ran them.
const LONG_TURN_START = NOW - LONG_TURN_N * 600_000;

// One commit in the open folder and two made in linked worktrees of it. The second worktree is
// named for its branch, so its row draws the branch alone. The third worktree's name differs,
// so a picture of this card answers whether its `where` word reads as a place rather than as
// another repository. The list is declared above the children, because one child holds the two
// worktree commits as its own.
const LONG_COMMITS: TurnCommit[] = [
  {
    sha: '4f2a91c',
    subject: 'feat(card): fold the Files, Subagents and Commits sections',
    head: { kind: 'branch', name: 'main' },
    files: 6,
    added: 188,
    removed: 54,
    at: LONG_TURN_START + 402_000,
    place: null,
    dir: 'c:/repo',
  },
  {
    sha: '9d7be30',
    subject: 'test(card): measure the open card at the three panel widths',
    head: { kind: 'branch', name: 'turn-card-density' },
    files: 2,
    added: 74,
    removed: 3,
    at: LONG_TURN_START + 470_000,
    place: { kind: 'worktree', dir: 'c:/repo-trees/turn-card-density' },
    dir: 'c:/repo-trees/turn-card-density',
  },
  {
    sha: 'b83e0d1',
    subject: 'fix(rail): keep the pinned row in view when the rail narrows',
    head: { kind: 'branch', name: 'fix/rail-pin' },
    files: 1,
    added: 9,
    removed: 2,
    at: LONG_TURN_START + 520_000,
    place: { kind: 'worktree', dir: 'c:/repo-trees/rail-review' },
    dir: 'c:/repo-trees/rail-review',
  },
];

// One run still going, one finished run whose child transcript the panel can open, and one
// finished run with no child to open. The third is the row that draws no link, so a picture
// of this card answers whether a reader can tell a linked row from an unlinked one. The
// open child pairs with its launch step in `LONG_STEPS` by `toolUseId`. The turn has ended, so
// its row reads running with no time. The finished children carry what they spent, so their
// rows draw a cost. The first finished child recorded a reasoning effort, so its row draws the
// model and the effort as one run. The second recorded no commit and no path, which is the
// commonest record a child leaves, so its row draws the cost alone.
const LONG_AGENTS: TurnAgent[] = [
  {
    id: null,
    description: 'Find every fixed wait in the browser tests',
    toolUseId: LONG_AGENT_LAUNCH,
    agentType: 'general-purpose',
    model: 'claude-opus-5',
    effort: null,
    spend: [],
    spendFound: false,
    spendPartial: false,
    durationMs: null,
    tokens: null,
    toolUses: null,
    status: 'running',
  },
  {
    id: 'agent-fold',
    childSessionId: 's2',
    description: 'Fold the Files rows behind a head line and prove the height guard goes red',
    agentType: 'general-purpose',
    model: 'claude-sonnet-5',
    effort: 'high',
    spend: [
      {
        model: 'claude-sonnet-5',
        usage: {
          requests: 18,
          input: 6_000,
          cacheWrite1h: 0,
          cacheWrite5m: 42_000,
          cacheRead: 610_000,
          output: 9_400,
          thinking: 0,
        },
      },
    ],
    spendFound: true,
    spendPartial: false,
    // The two worktree commits of the turn are this child's own, so the card attributes them
    // to it and its hover names them. The turn holds the same records, and the count stays at
    // three, because a sha the parent and the child both report is one commit.
    //
    // Two of the files are the turn's own as well, and the third is this child's alone. The
    // parent transcript records no edit a child made, so the card's Files list draws that third
    // file only because the card merges what the child recorded into its own rows.
    commits: [LONG_COMMITS[1], LONG_COMMITS[2]],
    artifacts: {
      files: [
        { path: 'c:/repo/extension/src/webview/card.ts', added: 150, removed: 30, isNew: false },
        { path: 'c:/repo/extension/src/webview/panel.css', added: 48, removed: 12, isNew: false },
        { path: 'c:/repo/extension/src/panel.layout.cards.test.ts', added: 20, removed: 5, isNew: false },
      ],
      commits: ['9d7be30', 'b83e0d1'],
      complete: true,
      revision: 'fixture-fold',
      // What its duration figure's record draws: the calls by tool, the two that failed, and
      // when it ran inside its parent turn.
      tools: { Bash: 12, Edit: 7, Read: 4 },
      failed: { count: 2, byTool: { Bash: 2 } },
      startedAt: NOW - LONG_TURN_N * 600_000 + 60_000,
      endedAt: NOW - LONG_TURN_N * 600_000 + 274_000,
    },
    durationMs: 214_000,
    tokens: 48_200,
    toolUses: 23,
    status: 'completed',
  },
  {
    id: 'agent-read',
    description: 'Read docs/architecture.md and name the component rows a fold head moves',
    agentType: 'Explore',
    model: 'claude-haiku-4-5',
    effort: null,
    spend: [
      {
        model: 'claude-haiku-4-5',
        usage: {
          requests: 7,
          input: 2_000,
          cacheWrite1h: 0,
          cacheWrite5m: 11_000,
          cacheRead: 96_000,
          output: 2_600,
          thinking: 0,
        },
      },
    ],
    spendFound: true,
    spendPartial: false,
    artifacts: { files: [], commits: [], complete: true, revision: 'fixture-read' },
    durationMs: 61_000,
    tokens: 12_400,
    toolUses: 9,
    status: 'completed',
  },
];

// What the agent wrote while it worked, which the Activity log draws as messages. Four of
// them at four lengths, because the log clamps a long one and leaves a short one whole, and
// a fixture of equal-length narration pictures the same log either way.
const LONG_UPDATES: TurnUpdate[] = [
  {
    sourceId: 'p3-update-1',
    stepsBefore: 1,
    kind: 'commentary',
    status: 'done',
    at: LONG_TURN_START + 40_000,
    text: 'Reading the card body first.',
  },
  {
    sourceId: 'p3-update-2',
    stepsBefore: 3,
    kind: 'commentary',
    status: 'done',
    at: LONG_TURN_START + 150_000,
    text: 'The six sections are pushed in one fixed order, so the fold head belongs in `Section` itself rather than in each of its callers.',
  },
  {
    sourceId: 'p3-update-3',
    stepsBefore: 6,
    kind: 'commentary',
    status: 'done',
    at: LONG_TURN_START + 320_000,
    text: 'The card test went red on the section order. The heading is a button now, so a query written against plain heading text no longer finds it. I have rewritten those queries against the accessible name, and the rest of the file passes untouched.',
  },
  {
    sourceId: 'p3-update-4',
    stepsBefore: 8,
    kind: 'commentary',
    status: 'done',
    at: LONG_TURN_START + 460_000,
    text: 'The build is clean and the browser guard measures the open card at 1350 as well as at 340.',
  },
];

// Eight calls, one of them failed, which is the shape of a turn that edited, built, went red
// and fixed what it broke. The failed one is what puts a failure mark in the log.
const LONG_STEPS: TurnStep[] = [
  { ordinal: 1, name: 'Read', detail: 'extension/src/webview/card.ts', at: LONG_TURN_START + 20_000, status: 'done' },
  { ordinal: 2, name: 'Grep', detail: 'sectionheading', at: LONG_TURN_START + 60_000, status: 'done' },
  { ordinal: 3, name: 'Edit', detail: 'extension/src/webview/card.ts', at: LONG_TURN_START + 140_000, status: 'done' },
  {
    ordinal: 4,
    name: 'Edit',
    detail: 'extension/src/webview/panel.css',
    at: LONG_TURN_START + 200_000,
    status: 'done',
  },
  {
    ordinal: 5,
    name: 'Bash',
    detail: 'npm --prefix extension run build',
    at: LONG_TURN_START + 260_000,
    status: 'done',
  },
  {
    ordinal: 6,
    name: 'Bash',
    detail: 'node test.mjs src/webview/card.test.ts',
    at: LONG_TURN_START + 310_000,
    status: 'failed',
  },
  { ordinal: 7, name: 'Edit', detail: 'extension/src/turncard.ts', at: LONG_TURN_START + 380_000, status: 'done' },
  {
    ordinal: 8,
    name: 'Bash',
    detail: 'git commit -F .git/COMMIT_EDITMSG',
    at: LONG_TURN_START + 400_000,
    status: 'done',
  },
  {
    ordinal: 9,
    name: 'Agent',
    id: LONG_AGENT_LAUNCH,
    detail: 'Find every fixed wait in the browser tests',
    at: LONG_TURN_START + 440_000,
    status: 'done',
  },
];

// Ordinal for ordinal with the calls above, which is how every count built from them reads.
const LONG_STEP_KINDS = ['reads', 'searches', 'edits', 'edits', 'commands', 'commands', 'edits', 'commands', 'agents'];

// Two things the reader typed while the turn ran. The card draws both under You asked, under
// the prompt that started it, so the section is three blocks tall rather than one.
const LONG_LATER_PROMPTS: TurnAsk[] = [
  { text: 'also check the 640 width while you are in there', at: LONG_TURN_START + 240_000, stepsBefore: 4 },
  {
    text: 'keep the chip row exactly where it is, the sections are the part I want shorter',
    at: LONG_TURN_START + 340_000,
    stepsBefore: 6,
  },
];

export const COMPACTION_SUMMARY = `# Delivery state

## Constraints that still apply

- Keep the card collapsed until the reader opens it.
- Preserve the existing \`What carried over\` section title.
- [Read the timeline guide](docs/timeline.md) before changing the browser fixture.

## Completed work

| Area | Result | Evidence |
| --- | --- | --- |
| Fixture | Long retained context is available to every later reader of the card | Browser coverage |
| Disclosure | The reader controls visibility, and the card opens on the part that changed | Saved panel state |
| Retention | extension/src/panelfixture.ts keeps the summary the compaction wrote | Node coverage |

## Follow-up command

\`\`\`powershell
npm --prefix extension run build
npm test
\`\`\`

The next reader must retain these constraints while reviewing the full Markdown summary.`;

const COMPACTION_SUMMARIES: Compaction[] = [
  {
    sessionId: 's1',
    at: NOW - 75_000,
    contextBefore: 186_420,
    contextAfter: 18_920,
    droppedTokens: 167_500,
    durationMs: 42_000,
    trigger: 'manual',
    model: 'claude-opus-5',
    summary: COMPACTION_SUMMARY,
  },
  {
    sessionId: 's1',
    at: NOW - 150_000,
    contextBefore: 200_000,
    contextAfter: 16_200,
    droppedTokens: 183_800,
    durationMs: 39_000,
    trigger: 'auto',
    model: 'claude-opus-5',
    summary: '## Automatic boundary\n\n- This summary stays closed until the reader opens it.',
  },
  {
    sessionId: 's1',
    at: NOW - 225_000,
    contextBefore: 200_000,
    contextAfter: 0,
    droppedTokens: 200_000,
    durationMs: 0,
    trigger: '',
    model: 'gpt-5.6-sol',
    summary: '',
  },
];

function turnAt(n: number): Turn {
  return {
    agent: 'claude',
    sessionId: 's1',
    sessionTitle: 'Embedded agent input',
    promptId: `p${n}`,
    startedAt: NOW - n * 600_000,
    endedAt: n === 1 ? NOW - 4_000 : NOW - n * 600_000 + 492_000,
    prompt:
      n === 1
        ? `${HEADLINE} in ${LONG_PATH}`
        : n === LONG_TURN_N
          ? 'The open card runs past a screen at every width. Fold the record sections behind a head line that keeps the count and a digest, and move the prompt above the response.'
          : `${HEADLINE} (${n})`,
    summary: n === LONG_TURN_N ? LONG_SUMMARY : HEADLINE,
    answers: [],
    model: 'claude-opus-5',
    effort: 'high',
    // Two turns changed files, and the rest draw no files-and-lines chip at all. A page where
    // every card drew one measures the same whether that chip is one pill or two, which is
    // the thing this fixture exists to tell apart.
    //
    // The two differ in how much they carry. One has a pair of files, which is what a card
    // with a short record draws. The long turn has seven, spread from a bare `README.md` to
    // the unbroken path above, which is what the card's own density is argued over.
    files:
      n === 2
        ? [
            { path: `c:/repo/${LONG_PATH}`, added: 80, removed: 12, isNew: false, edits: [] },
            { path: 'c:/repo/README.md', added: 5, removed: 0, isNew: true, edits: [] },
          ]
        : n === LONG_TURN_N
          ? LONG_FILES
          : [],
    agents: n === LONG_TURN_N ? LONG_AGENTS : [],
    commits: n === LONG_TURN_N ? LONG_COMMITS : [],
    usage: { input: 4200, cacheWrite1h: 0, cacheWrite5m: 1200, cacheRead: 180_000, output: 3100, thinking: 0 },
    contextTokens: 118_000,
    contextWindow: 200_000,
    // The request that set the level above, dated and named as itself. The turn's own end
    // moves with a tool result, so a page built on that alone would date the cache wrong.
    contextRequest: {
      at: n === 1 ? NOW - 4_000 : NOW - n * 600_000 + 492_000,
      lifetime: '5m' as const,
      inferenceClass: null,
      serviceTier: null,
      readBack: true,
      outputTokens: 2_900,
    },
    // The long turn reports the calls it actually lists, so the breakdown behind its Activity
    // head adds up to the run row above it. Every other turn keeps the tally it always had.
    toolUses: n === LONG_TURN_N ? 11 : 36,
    toolCounts:
      n === LONG_TURN_N
        ? { edits: 3, reads: 1, searches: 1, commands: 3, agents: 3, coordination: 0, web: 0, other: 0 }
        : { edits: 9, reads: 12, searches: 6, commands: 7, agents: 2, coordination: 0, web: 0, other: 0 },
    toolTally: {},
    // The newest card carries a log, with one row long enough to have no wrapping point in
    // it: a row that has not been told it may shrink below its content refuses to, and the
    // panel then scrolls sideways.
    // One turn was asked a second thing while it ran, which is the row the log draws for
    // the reader rather than for the agent.
    laterPrompts:
      n === 1
        ? [{ text: 'and check the narrow width while you are there', at: NOW - 45_000, stepsBefore: 62 }]
        : n === LONG_TURN_N
          ? LONG_LATER_PROMPTS
          : [],
    steps:
      n === 1
        ? [
            { ordinal: 61, name: 'Read', detail: LONG_PATH, at: NOW - 60_000, status: 'done' as const },
            { ordinal: 62, name: 'Skill', detail: 'review-the-change', at: NOW - 50_000, status: 'done' as const },
            {
              ordinal: 63,
              name: 'Bash',
              detail: `npm test -- ${LONG_PATH}`,
              at: NOW - 40_000,
              status: 'failed' as const,
            },
            { ordinal: 64, name: 'Grep', detail: 'livePressOver', at: NOW - 4_000, status: 'running' as const },
          ]
        : n === LONG_TURN_N
          ? LONG_STEPS
          : [],
    updates: n === LONG_TURN_N ? LONG_UPDATES : [],
    stepCount: n === 1 ? 64 : n === LONG_TURN_N ? LONG_STEPS.length : 0,
    // Ordinal for ordinal with the steps above, so the `Skill` call is marked as the skill
    // load it is and lands in no tool category at all.
    stepKinds:
      n === 1
        ? [...Array(60).fill('reads'), 'reads', 'skill', 'commands', 'searches']
        : n === LONG_TURN_N
          ? LONG_STEP_KINDS
          : [],
    failedOrdinals: n === 1 ? [63] : n === LONG_TURN_N ? [6] : [],
    // Two turns loaded skills, and between them they carry every row the skills popover draws:
    // a recorded load with a file to open, a second load of that same skill, a recorded load
    // no record named a file for, and a best-effort read with the sentence a catalog published.
    // Both are turns the popover boards are drawn from, so every state reaches a picture.
    skillUses:
      n === 1
        ? [
            {
              sourceId: 'p1-skill-1',
              name: 'review-the-change',
              at: NOW - 50_000,
              evidence: 'recorded',
              path: 'c:/repo/.claude/skills/review-the-change/SKILL.md',
            },
            {
              sourceId: 'p1-skill-2',
              name: 'review-the-change',
              at: NOW - 30_000,
              evidence: 'recorded',
              path: 'c:/repo/.claude/skills/review-the-change/SKILL.md',
            },
            { sourceId: 'p1-skill-3', name: 'polish', at: NOW - 20_000, evidence: 'recorded' },
          ]
        : n === 2
          ? [
              {
                sourceId: 'p2-skill-1',
                name: 'panel-mockup',
                at: NOW - 2 * 600_000 + 120_000,
                evidence: 'best-effort',
                description: 'Review the panel, draw a mockup for it, or compare several candidates',
                path: 'c:/repo/.claude/skills/panel-mockup/SKILL.md',
              },
            ]
          : [],
    skillUseCount: n === 1 ? 3 : n === 2 ? 1 : 0,
    // The newest turn is still running, which is what puts the line saying what the agent is
    // doing on its folded card. Every other turn has closed.
    failures: [],
    interrupted: false,
    finished: n !== 1,
    error: null,
  };
}

// The session the page is drawn from, newest first by the clock inside each turn.
//
// Exported so a guard can price and measure the same turns the page draws and compare the
// answer with the figures written out below. The two drifted apart once: the heading said
// one window and every card under it said another.
export const FIXTURE_TURNS: Turn[] = Array.from({ length: 24 }, (_, n) => turnAt(n + 1));

// What the composer is aimed at, and everything its controls and their menus are built from.
export const COMPOSER = {
  agent: 'claude' as const,
  session: 'Embedded agent input',
  draft: '',
  onScreen: '',
  queued: [],
  // Earlier prompts, so the layout board is drawn for a box the Up arrow can walk back
  // through. They are never on screen: the walk changes what the box holds and nothing else.
  history: ['Explain the snapshot store', 'Rename the note type to comment'],
  running: false,
  comments: [],
  sessionId: 's1',
  models: [
    { value: 'opus', label: 'Opus 5', description: '', efforts: [{ value: 'high', label: 'high', description: '' }] },
  ],
  // Enough commands, and long enough ones, that the menu is taller than its cap and wider
  // than the box. A short list never reaches either, so a menu drawn off the panel or one
  // that pushes the body sideways would measure exactly like a working one.
  commands: [
    {
      name: 'compact',
      description: 'Summarise the session so far and keep going in a smaller window',
      argumentHint: '',
    },
    { name: 'commit', description: 'Write a commit for what is in the working tree', argumentHint: '<message>' },
    {
      name: 'code-review',
      description:
        'Review the current diff for correctness bugs and cleanups at the given effort level, low through max',
      argumentHint: '[level]',
    },
    ...Array.from({ length: 14 }, (_, n) => ({
      name: `a-skill-with-a-fairly-long-name-${n}`,
      description:
        'A sentence the agent published about this one, long enough to have no wrapping point left on the row it is drawn on',
      argumentHint: '',
    })),
  ],
  settings: {
    selectedModel: 'opus',
    selectedEffort: 'high',
    effortModel: 'opus',
    pendingModel: null,
    pendingEffort: null,
    confirmedModel: null,
    confirmedEffort: null,
  },
  askMode: 'auto',
  context: { used: 118_000, max: 200_000 },
  // What the next turn's floor price is worked out from, taken off the same newest turn the
  // window figure comes from rather than written out again. The page then draws the real
  // sentence and the real working, at the real rate for the model the fixture records.
  nextTurn: nextTurnBasisOf(FIXTURE_TURNS[0], null),
  mcpServers: [],
  live: [],
  // No skill list has ever arrived for this fixture's working directory, so its Claude
  // commands fall back to the pre-skill-list rule wherever a test spreads `COMPOSER` without
  // its own value.
  claudeSkills: null,
};

// The same composer as a session nobody has started yet, which is what the four
// enabled pickers and the tag above them are drawn for. The session stays `s1`, so the
// draft is aimed at a row the rail already draws.
//
// It keeps the window figure `COMPOSER` carries. A draft has run no turn and has filled no
// window, so any figure reaching it belongs to the session its setup was copied from.
// Left in place, the layout guard proves that `composerView` drops it. Taken out, the guard
// would only prove that the fixture never offered one.
export const DRAFT_COMPOSER = {
  ...COMPOSER,
  profile: {
    agent: 'claude' as const,
    model: 'opus',
    effort: 'high',
    permissionMode: 'auto',
    source: 'inherited' as const,
  },
};

// A press the panel is still waiting on, in the shape `send` records one. The card it draws
// stands at the top of the column, so every card below it moves if it grows.
export const LIVE_PRESS = {
  sessionId: 's1',
  agent: 'claude' as const,
  kind: 'prompt' as 'prompt' | 'compact',
  // Long enough to run past three lines at both widths, because the card holds the height it
  // was first drawn at and the clamp is the only thing that makes that true. A shorter one
  // never reaches the clamp, so the height guard passes whether it is there or not.
  text:
    'take the sandbox with the approval and then run the whole smoke test again from the top, ' +
    'then read back what it printed and say which of the checks were skipped and why, and if ' +
    'any of them were skipped for a reason that is no longer true say so plainly rather than ' +
    'leaving it in the list, and then do the same for the browser tests',
  reply: '',
  at: NOW - 4000,
  // A fresh press, which is the one that draws a card. One sent into a turn already running
  // draws none: that turn's card is where it belongs.
  midTurn: false,
  ran: false,
  started: false,
  failed: false,
  reason: '',
};

// An agent's MCP servers, in the shape the wire hands them over.
//
// Five of them with two failed, because that is the widest the control on the composer row
// ever gets: the label carries the count and then the trouble, and a machine with two healthy
// servers draws a control narrow enough to fit anywhere. The names are long for the same
// reason the headlines above are, since a short one asks the layout no question, and one
// server carries an error long enough to wrap the row it is drawn on.
//
// The default is no servers at all, which is what every guard above this one measures. The
// control is not drawn for a machine with none, so the picker row those guards see is the
// three-control row it has always been.
export const MCP_SERVERS = [
  {
    name: 'github-enterprise-issues-and-pull-requests',
    status: 'connected',
    error: '',
    scope: 'project',
    title: 'GitHub',
    tools: ['create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request', 'list_commits'],
  },
  {
    name: 'playwright-browser-automation-and-screenshots',
    status: 'connected',
    error: '',
    scope: 'user',
    title: 'Playwright',
    tools: ['browser_navigate', 'browser_click', 'browser_snapshot'],
  },
  {
    name: 'unity-editor-bridge-for-the-sandbox-project',
    status: 'failed',
    scope: 'local',
    title: '',
    tools: [],
    error: 'The editor is not running, so there is nothing on the other end of the bridge to attach to.',
  },
  {
    name: 'postgres-analytics-warehouse-read-only',
    status: 'disabled',
    error: '',
    scope: 'project',
    title: '',
    tools: [],
  },
  {
    name: 'sentry-release-health-and-issue-search',
    status: 'failed',
    scope: 'user',
    title: '',
    tools: [],
    error: 'Connection refused on the configured port.',
  },
];

// Every rate source below is typed against the producer rather than left to inference. Bare,
// `provenance` widens to `string`, and a renamed member of `ProjectSpendProvenance` reaches
// the panel while every rates guard here goes on passing against the word the panel dropped.
type ProjectSpendRateSources = ProjectSpendView['rateSources'];

const PROJECT_SPEND_RATES: ProjectSpendRateSources = [
  { source: 'Provider-reported cost', effectiveDate: null, provenance: 'reported' },
  { source: 'Workspace contract', effectiveDate: '2026-08-01', provenance: 'configured' },
  { source: 'Anthropic list price', effectiveDate: '2026-08-01', provenance: 'public' },
];

export const PROJECT_SPEND = {
  name: 'Project cost',
  windows: [
    {
      id: 'today' as const,
      label: 'Today',
      dollars: 4.82,
      display: '$4.82',
      status: 'exact',
      partial: false,
      pricedRequests: 8,
      unpricedRequests: 0,
    },
    {
      id: 'sevenDays' as const,
      label: '7 days',
      dollars: 18.24,
      display: 'At least $18.24',
      status: 'atLeast',
      partial: true,
      pricedRequests: 29,
      unpricedRequests: 1,
    },
    {
      id: 'thirtyDays' as const,
      label: '30 days',
      dollars: 52.1,
      display: 'At least $52.10',
      status: 'atLeast',
      partial: true,
      pricedRequests: 92,
      unpricedRequests: 3,
    },
  ],
  categories: [
    {
      id: 'claude',
      label: 'Claude spend',
      windows: [
        {
          id: 'today' as const,
          label: 'Today',
          dollars: 4.81,
          display: '$4.81',
          status: 'exact',
          partial: false,
          pricedRequests: 6,
          unpricedRequests: 0,
        },
        {
          id: 'sevenDays' as const,
          label: '7 days',
          dollars: 18.04,
          display: 'At least $18.04',
          status: 'atLeast',
          partial: true,
          pricedRequests: 17,
          unpricedRequests: 1,
        },
        {
          id: 'thirtyDays' as const,
          label: '30 days',
          dollars: 51.2,
          display: 'At least $51',
          status: 'atLeast',
          partial: true,
          pricedRequests: 52,
          unpricedRequests: 3,
        },
      ],
    },
    {
      id: 'codex',
      label: 'Codex spend',
      windows: [
        {
          id: 'today' as const,
          label: 'Today',
          dollars: 0.01,
          display: '$0.01',
          status: 'exact',
          partial: false,
          pricedRequests: 2,
          unpricedRequests: 0,
        },
        {
          id: 'sevenDays' as const,
          label: '7 days',
          dollars: 0.2,
          display: '$0.20',
          status: 'exact',
          partial: false,
          pricedRequests: 12,
          unpricedRequests: 0,
        },
        {
          id: 'thirtyDays' as const,
          label: '30 days',
          dollars: 0.9,
          display: '$0.90',
          status: 'exact',
          partial: false,
          pricedRequests: 40,
          unpricedRequests: 0,
        },
      ],
    },
  ],
  earliestRecord: '2026-08-03',
  lastIndexedAt: NOW - 120_000,
  // What the pricing answered with, in the order it answered. The panel builds its rate lines
  // out of this, so a page without it draws no Pricing details at all. One entry per
  // provenance the payload can carry, because each takes a different phrase.
  //
  // Every entry is the one production sends. The reported entry is what `priceBucket` builds
  // for a cost the provider already charged, which carries no rate and no date. The public
  // entry is what `publicRateFor` names a rate it read out of the list-price table. A source
  // invented here would put words in the list that no reader ever sees.
  //
  // Both estimated rates share one date. The undated list below is the other case, where one
  // estimate has a date and one has none.
  rateSources: PROJECT_SPEND_RATES,
  // At rest, which is what a workspace shows for all but a few seconds at a time. A run is
  // posted by the tests that measure one, so nothing else has to wait one out.
  indexing: false,
  calculating: false,
  indexingStatus: null,
};

// The words the extension sends while it indexes. They stand in the place of the update age
// rather than beside it, so they must stay shorter than every age they replace. A guard in
// `panel.webview.test.ts` pairs this with the line that writes it.
export const PROJECT_SPEND_INDEXING_WORD = 'Updating…';

// The rates a workspace gets when one estimate has an effective date and another has none.
// Most rows of the list-price table carry no date, so `publicRateFor` sends null for them,
// and this is the ordinary payload rather than an edge of it. The reported entry is undated
// for the reason it always is: a charge the provider already made is not a rate.
//
// One date must not speak for an estimate that has none, so the lines built from this date
// the rate that has one and leave the other bare.
export const PROJECT_SPEND_UNDATED_RATES: ProjectSpendRateSources = [
  { source: 'Provider-reported cost', effectiveDate: null, provenance: 'reported' },
  { source: 'Workspace contract', effectiveDate: '2026-08-01', provenance: 'configured' },
  { source: 'OpenAI list price', effectiveDate: null, provenance: 'public' },
];

// The rates a workspace gets when it runs both agents and configures neither. Both are public,
// so rank settles nothing between them, and the order the payload sends is the order the walk
// over the records first met each one. That order turns over between passes, so the lines
// and the print built from them have to settle the pair themselves.
export const PROJECT_SPEND_PEER_RATES: ProjectSpendRateSources = [
  { source: 'Anthropic list price', effectiveDate: null, provenance: 'public' },
  { source: 'OpenAI list price', effectiveDate: null, provenance: 'public' },
];

// The figures the rail and the session heading draw, written out rather than computed, so
// the page reads as one fixture. `panelfixture.test.ts` builds the same chips from the turns
// below and fails when a literal here stops agreeing with them.
export const RAIL_STATS: Record<string, SessionStatChip[]> = {
  s1: [
    { metric: 'files', compactLabel: '7 files', kind: 'plain', label: '7 files', detail: '' },
    {
      metric: 'context',
      compactLabel: '59% ctx',
      kind: 'plain',
      label: '59% of 200k ctx (118k)',
      level: 'filling',
      detail: 'Context: 118k\nLatest compaction: Manual',
      detailList: {
        layout: 'economics',
        entries: [
          { label: 'Context', value: '118k' },
          { label: 'Latest compaction', value: 'Manual' },
        ],
      },
    },
    {
      metric: 'turns',
      compactLabel: '8 turns',
      kind: 'plain',
      label: '8 turns',
      detail: '8 turns in the main session. Delegated work does not add to this count.',
    },
    { metric: 'cost', compactLabel: '$1.87', kind: 'plain', label: '$1.87', detail: '', dollars: 1.87 },
    {
      metric: 'cache-expiry',
      compactLabel: '3 cache expiries',
      kind: 'plain',
      label: '3 cache expiries',
      focusable: true,
      detail:
        'Cache expiry: 3 affected turns\n\nCache lifetimes: 1 at 5m · 2 at 30m\nInput cost on affected requests: $7.42\nLongest qualifying gap: 1d 2h\nExcluded ambiguous events: 2\nThe record does not identify every cache-key change.',
      detailList: {
        layout: 'economics',
        heading: { label: 'Cache expiry', value: '3 affected turns' },
        entries: [
          { label: 'Cache lifetimes', value: '1 at 5m · 2 at 30m' },
          { label: 'Input cost on affected requests', value: '$7.42' },
          { label: 'Longest qualifying gap', value: '1d 2h' },
          { label: 'Excluded ambiguous events', value: '2' },
        ],
        footer: ['The record does not identify every cache-key change.'],
      },
    },
  ],
  // The session beside it is priced by no figure at all, which is what makes a heading
  // over both of them draw a floor rather than a total. A page where every card carried a
  // figure would picture the same heading whether the floor rule held or not.
  s2: [{ metric: 'context', compactLabel: '14% ctx', kind: 'plain', label: '14% of 1M ctx (140k)', detail: '' }],
  // The card carrying the longest label carries a figure too, so the browser guard that
  // measures the label line against the figures above it has figures to measure on every
  // card it reads. A hidden figure row has no box, and the distance from it is whatever the
  // viewport says, which passes for any draw order.
  s4: [{ metric: 'cost', compactLabel: '$0.42', kind: 'plain', label: '$0.42', detail: '', dollars: 0.42 }],
};

// The first rail row shows the ordinary warm bolt. The second shows the filled final-quarter
// face, so every full-panel picture includes both approved states.
const RAIL_CACHES = {
  s1: { expiresAt: FIXTURE_CLOCK + 45 * 60_000, nearlyGoneAt: FIXTURE_CLOCK + 30 * 60_000 },
  s2: { expiresAt: FIXTURE_CLOCK + 10 * 60_000, nearlyGoneAt: FIXTURE_CLOCK - 5 * 60_000 },
};

// What the reader filed each session under, in the order they applied it.
//
// The newest session carries one more label than the row can draw, so the fold is on
// screen. A fixture filled to exactly what the row holds would picture the same line whether
// the fold worked or not, and the fold is the half of it that no text scan can see.
//
// The one beside it carries a single label, so the page also holds a labelled card that
// folds nothing. Every session the record does not name carries none, so the page holds
// a card with no label line at all. The cases sit side by side because the line's own margin is what
// pushes the cards under it down, and a page where every card wore labels would measure
// the same whether the empty line is taken out or left standing.
//
// The `s4` card carries a label at `LABEL_NAME_LIMIT` characters, the longest a label can
// be. A short label fits the row at every width, so a page of short ones measures the same
// with the rule that cuts a chip and without it, and a chip that painted across its
// neighbour would draw exactly like one that gave way.
const RAIL_LABELS: Record<string, string[]> = {
  s1: ['composer', 'release 0.4', 'perf'],
  s2: ['release 0.4'],
  s4: ['worktree parallel sessions and the rails'],
};

// One view keeps archived sessions and another excludes them. An unmatched view shows an empty section.
const RAIL_VIEWS: SavedView[] = [
  { id: 'v1', name: 'Composer', query: 'label:composer', archived: false },
  { id: 'v2', name: 'Release 0.4', query: 'label:"release 0.4"', archived: true },
  { id: 'v3', name: 'Later', query: 'label:later', archived: false },
];

export const MAX_RAIL_FILTER_NAME = 'Maximum-length saved release work filter';

const RAIL_FILTERS: SavedRailFilter[] = [
  { id: 'f1', name: 'Unread costs', query: 'is:unread label:costs', sort: 'cost-desc' },
  { id: 'f2', name: MAX_RAIL_FILTER_NAME, query: 'label:"release 0.4"', sort: 'latest' },
];

// The two requests a live child can stop on, drawn at the foot of the selected session.
// They live here rather than in the guard that first needed them, because the pictures need
// the same two: a card photographed from one pair of requests and measured against another
// argues about the fixture instead of about the card.
export const QUESTION_ASK: QuestionAsk = {
  kind: 'question',
  id: 'layout-ask',
  toolUseId: 'layout-tool',
  input: {},
  questions: [
    {
      id: 'approach',
      question: 'Which implementation approach should the agent take?',
      header: 'Approach',
      multiSelect: false,
      secret: false,
      options: [
        { label: 'Small change', description: 'Keep the existing structure and change only the request path.' },
        {
          label: 'Larger refactor',
          description: 'Move the shared behavior into a new module before changing the request path.',
        },
      ],
    },
    {
      id: 'checks',
      question: 'Which additional checks should run before the agent continues?',
      header: 'Checks',
      multiSelect: true,
      secret: false,
      options: [
        { label: 'Browser layout', description: 'Measure the real panel at editor and sidebar widths.' },
        { label: 'Hook smoke test', description: 'Exercise the Claude hooks with deterministic input.' },
      ],
    },
  ],
};

// The answer a reader types on a question none of whose choices fit. Long on purpose: the tab
// that reports it cuts a value short and keeps the whole of it in its accessible name, and a
// short answer asks the strip no question.
export const LONG_WRITTEN_ANSWER =
  'Keep the tab strip, but let the arrow keys move between ' +
  'questions as well, and remember which question the reader was on across a repaint';

// A third request, for the card that draws one question at a time. Three questions is the
// smallest number that puts a question between the first and the last, so the strip has a tab
// the reader can only reach by pressing it. The middle question carries a label long enough to
// be cut on the tab, and is the one `LONG_WRITTEN_ANSWER` is written into.
export const THREE_QUESTION_ASK: QuestionAsk = {
  kind: 'question',
  id: 'layout-three',
  toolUseId: 'layout-three-tool',
  input: {},
  questions: [
    {
      id: 'scope',
      question: 'Which part of the panel should this change cover?',
      header: 'Scope',
      multiSelect: false,
      secret: false,
      options: [
        { label: 'The request card alone', description: 'Leave the prompt box and the timeline where they are.' },
        { label: 'The whole session foot', description: 'Move the prompt box and the queued prompts with it.' },
      ],
    },
    {
      id: 'strip',
      question: 'How should the strip behave once the questions no longer fit across one row?',
      header: 'Strip behaviour past the second row of tabs',
      multiSelect: false,
      secret: false,
      options: [
        { label: 'Wrap to a second row', description: 'Every tab keeps the answer it reports.' },
        { label: 'Drop the answers', description: 'Each tab marks only whether its question is answered.' },
      ],
    },
    {
      id: 'checks',
      question: 'Which additional checks should run before the agent continues?',
      header: 'Checks',
      multiSelect: true,
      secret: false,
      options: [
        { label: 'Browser layout', description: 'Measure the real panel at editor and sidebar widths.' },
        { label: 'Hook smoke test', description: 'Exercise the Claude hooks with deterministic input.' },
      ],
    },
  ],
};

// Six questions, which is where the strip runs past two rows at the sidebar width and drops
// every value. The last one asks for a secret, so a picture proves that its tab reports that
// it is answered without reporting what it says.
export const SIX_QUESTION_ASK: QuestionAsk = {
  kind: 'question',
  id: 'layout-six',
  toolUseId: 'layout-six-tool',
  input: {},
  questions: [
    {
      id: 'gap',
      question: 'Which gap do you want between the line diff and the word beside it?',
      header: 'Gap size',
      multiSelect: false,
      secret: false,
      options: [
        { label: '6px', description: "Matches the row's own gap." },
        { label: '3px', description: 'The smallest step that separates them.' },
      ],
    },
    {
      id: 'guard',
      question: 'Do you want a browser guard for the gap?',
      header: 'Guard',
      multiSelect: false,
      secret: false,
      options: [
        { label: 'Yes', description: 'Measure a file row and assert the gap.' },
        { label: 'No', description: 'Ship the stylesheet rule alone.' },
      ],
    },
    {
      id: 'docs',
      question: 'Which document records the rule?',
      header: 'Docs',
      multiSelect: false,
      secret: false,
      options: [
        { label: 'timeline.md', description: 'The document that owns card rendering.' },
        { label: 'None', description: 'The stylesheet comment carries it.' },
      ],
    },
    {
      id: 'rollout',
      question: 'How should the change reach the reader?',
      header: 'Rollout',
      multiSelect: false,
      secret: false,
      options: [
        { label: 'Behind a setting', description: 'The reader turns it on.' },
        { label: 'Straight away', description: 'Everybody gets it on the next build.' },
      ],
    },
    {
      id: 'shots',
      question: 'How many rows should the shot script take?',
      header: 'Shot rows',
      multiSelect: false,
      secret: false,
      options: [
        { label: 'Four', description: 'One per state the plan names.' },
        { label: 'Two', description: 'The two widths alone.' },
      ],
    },
    {
      id: 'token',
      question: 'Which token should the run use?',
      header: 'Review',
      multiSelect: false,
      secret: true,
      options: [
        { label: 'The workspace token', description: 'Already on this machine.' },
        { label: 'A fresh token', description: 'Type the one you want used.' },
      ],
    },
  ],
};

export const PERMISSION_COMMAND =
  'cd "/c/Users/dev/project" && ls -t *.jsonl | head -3\n' +
  'python -c "print(\'a long permission command that must stay inside the request card\')"';

export const PERMISSION_ASK: PermissionAsk = {
  kind: 'permission',
  id: 'layout-permission',
  toolUseId: 'layout-command',
  toolName: 'Bash',
  displayName: 'Bash',
  description: 'Run the deterministic layout command',
  input: { command: PERMISSION_COMMAND },
};

// `archived` is the set the reader put away, and it travels the way the extension sends
// it: in `hidden`, and again as the flag `railSessions` writes onto each card. The two are
// one answer from one rule, so a payload cannot say a session is archived on the rail
// and live in the list.
//
// The status the rail draws each session in, by session id. Empty for every page but
// the one about status colours: a card built with a status wears a border and a word, and a
// figure measured against a page where every card wore one would measure nothing about the
// card that wears none. The map reaches `railSessions`, so the card's accessible name is
// worded from the same status the border is drawn from.
export function renderPayload(
  archived: string[] = [],
  live: (typeof LIVE_PRESS)[] = [],
  runs: string[] = [],
  servers: typeof MCP_SERVERS = [],
  asks: Ask[] = [],
  pinned: string[] = [],
  statuses: ReadonlyMap<string, RailStatus> = new Map(),
  runningSince: ReadonlyMap<string, number> = new Map(),
  assets: readonly Record<string, unknown>[] = [],
  // The live open-child count of each session the map words as `subagents`.
  openChildren: ReadonlyMap<string, number> = new Map(),
  // The live background command count of each session the map words as `background`.
  commands: ReadonlyMap<string, number> = new Map(),
): Record<string, unknown> {
  // Both agents, and every limit each one reports, because that is the widest the status
  // bar ever gets and so the case that decides how much of the panel it takes.
  const usage = [
    {
      agent: 'claude',
      plan: 'max',
      spend: {
        usedMinor: 187519,
        limitMinor: 200000,
        exponent: 2,
        currency: 'USD',
        utilization: 187519 / 200000,
        readAt: NOW,
      },
      checkedAt: NOW,
      windows: [
        {
          window: 'weekly_all',
          group: 'weekly',
          scope: '',
          utilization: 0.06,
          resetsAtSeconds: NOW / 1000 + 200_000,
          status: '',
          readAt: NOW,
        },
        {
          window: 'session',
          group: 'session',
          scope: '',
          utilization: 0.1,
          resetsAtSeconds: NOW / 1000 + 9_000,
          status: '',
          readAt: NOW,
        },
        {
          window: 'weekly_scoped',
          group: 'weekly',
          scope: 'Fable',
          utilization: 0.02,
          resetsAtSeconds: NOW / 1000 + 200_000,
          status: '',
          readAt: NOW,
        },
      ],
    },
    {
      agent: 'codex',
      plan: 'plus',
      spend: null,
      checkedAt: NOW,
      windows: [
        {
          window: 'seven_day',
          group: 'weekly',
          scope: '',
          utilization: 0.1,
          resetsAtSeconds: NOW / 1000 + 200_000,
          status: '',
          readAt: NOW,
        },
        {
          window: 'five_hour',
          group: 'session',
          scope: '',
          utilization: 0.38,
          resetsAtSeconds: NOW / 1000 + 9_000,
          status: '',
          readAt: NOW,
        },
      ],
    },
  ];
  // Enough cards that the page is several viewports tall. On a short page a sticky row
  // reaches the end of the body it sticks inside within one scroll, and is released there
  // by the rules rather than by a fault, so a scrolled measurement says nothing.
  // The host renders each card's markdown beside it, so the page does the same. Every card
  // but one answers with a single paragraph. The long turn answers with the markdown it
  // records, because a design argued over a card whose response is one line is argued over a
  // card that does not exist.
  const cards = FIXTURE_TURNS.map((turn, index) => {
    const card = toCard(turn, index === 0, NOW);
    if (index !== LONG_TURN_INDEX) {
      return { ...card, summaryHtml: `<p>${HEADLINE}</p>` };
    }
    return {
      ...card,
      summaryHtml: renderRichMarkdown(turn.summary),
      // Each message in the log is rendered the same way, because the host renders one
      // beside every message it sends. A row that arrived without it draws its mark and no
      // words at all.
      activity: card.activity.map((row) =>
        row.kind === 'message' ? { ...row, summaryHtml: renderRichMarkdown(row.text ?? '') } : row,
      ),
    };
  });
  // Enough sessions that the rail is taller than the viewport. A short rail sizes from
  // its own content and never reaches the cap that keeps it clear of the foot, so a rail
  // running the full viewport height measures exactly like one that stops above the bar.
  const rows = [
    {
      id: 's1',
      label: 'Embedded agent input',
      agent: 'Claude',
      when: '2:32 PM',
      at: NOW,
      relative: formatRelative(NOW, NOW),
    },
    {
      id: 's2',
      label: 'Codex parity sweep',
      agent: 'Codex',
      when: '1:32 PM',
      at: NOW - 3_600_000,
      relative: formatRelative(NOW - 3_600_000, NOW),
    },
    ...Array.from({ length: 30 }, (_, n) => ({
      id: `s${n + 3}`,
      label: `An older session ${n + 3}`,
      agent: n % 2 ? 'Codex' : 'Claude',
      when: '11:00 AM',
      at: NOW - (n + 2) * 3_600_000,
      relative: formatRelative(NOW - (n + 2) * 3_600_000, NOW),
    })),
  ];
  // Which of them another agent ran, carried on the row the way the extension carries it,
  // so the rail this builds groups them the way the real one would.
  const marked = rows.map((r) => ({
    ...r,
    persisted: true,
    agentKey: r.agent.toLowerCase(),
    agentRun: runs.includes(r.id),
  }));
  return {
    type: 'render',
    cards,
    // No resume command: the panel words its own out of the agent key and the id each row
    // carries, the same two fields the extension would have worded it from.
    sessions: marked.map((r) => ({ ...r, shown: r.id === 's1' })),
    rail: railSessions(
      marked,
      new Map(),
      new Map(),
      statuses,
      new Set(archived),
      's1',
      new Set(pinned),
      new Map(),
      RAIL_STATS,
      RAIL_LABELS,
      RAIL_CACHES,
      {},
      runningSince,
      undefined,
      openChildren,
      commands,
    ),
    // Every label the fixture files, counted the way the extension counts them. The filter
    // box offers these rows, so a page built without them draws a box that offers nothing.
    labels: labelCounts(RAIL_LABELS),
    // The saved views, which the rail draws a section for.
    views: RAIL_VIEWS,
    railFilters: RAIL_FILTERS,
    // A copy of the keyed record, not the record itself. A caller that drops one session's
    // entry to draw a session with no figures drops it from this payload alone.
    stats: { ...RAIL_STATS },
    hidden: archived,
    pinnedTop: pinned,
    comments: [],
    // Every card built above belongs to this session, which is what the extension sends:
    // one session is drawn at a time and only its cards are posted.
    showing: 's1',
    sessionAdoptions: [],
    maxSessions: 10,
    timelineLayout: { cardLayout: 'compact', promptPosition: 'above' },
    olderHistory: null,
    diagnosis: null,
    iconFonts: [],
    projectSpend: PROJECT_SPEND,
    usage: {
      bar: usageBar(usage, NOW),
      // The servers menu is built the way the other three are, off the same state the
      // composer is built from. It answers with nothing for a machine that has no servers,
      // which the filter drops, so a payload with none carries the three settings menus and nothing more.
      menus: Object.fromEntries(
        ['model', 'effort', 'askmode', 'mcp']
          .map((c) => [c, pickMenu(c, { ...COMPOSER, mcpServers: servers })])
          .filter(([, m]) => m),
      ),
      composer: composerView(
        {
          ...COMPOSER,
          live,
          asks,
          mcpServers: servers,
          assets: assets as never[],
          assetPreviews: Object.fromEntries(
            assets.map((asset) => [
              String(asset.id),
              `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='36' height='36'%3E%3Crect width='36' height='36' fill='%233c6e91'/%3E%3Ccircle cx='12' cy='12' r='5' fill='%23f2cc8f'/%3E%3Cpath d='M3 31 14 20l7 7 5-5 7 9' fill='%2381b29a'/%3E%3C/svg%3E`,
            ]),
          ),
        },
        FIXTURE_CLOCK,
      ),
      launcher: sessionLauncherView(
        COMPOSER,
        [
          {
            agent: 'codex',
            model: 'gpt-5.6',
            effort: 'high',
            permissionMode: 'on-request',
            source: 'recent',
          },
        ],
        {
          claude: COMPOSER.models,
          codex: [
            {
              value: 'gpt-5.6',
              label: 'GPT-5.6',
              description: '',
              efforts: [{ value: 'high', label: 'High', description: '' }],
            },
          ],
        },
      ),
    },
  };
}

export function cacheWriteWarningPayload(): Record<string, unknown> {
  const payload = renderPayload();
  const counts = {
    requests: 594,
    input: 1_494,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheWrite30m: 91_406_802,
    cacheRead: 3_156_715,
    output: 174_010,
    thinking: 62_693,
  };
  const usagePart = {
    model: 'openai.gpt-5.6-sol',
    provider: 'amazon-bedrock',
    contextWindow: 258_400,
    contextBand: 'short' as const,
    inferenceClass: null,
    serviceTier: null,
    usage: counts,
  };
  const turn: Turn = {
    ...FIXTURE_TURNS[1],
    agent: 'codex',
    model: usagePart.model,
    provider: usagePart.provider,
    sessionTitle: 'Cache-write investigation',
    contextWindow: usagePart.contextWindow,
    usage: { ...counts, byContextBand: { short: { ...counts } } },
    usageParts: [usagePart],
    agents: [],
    files: [],
  };
  const stats = {
    s1: [
      ...sessionCostProjection([usagePart]).stats,
      ...sessionTurnStats({ turnCount: 1, firstTurnAt: turn.startedAt, lastTurnAt: turn.endedAt, compactionCount: 0 }),
      ...sessionStats([turn], []).filter((stat) => stat.metric !== 'cost'),
    ],
  };
  const sessions = (payload.sessions as Parameters<typeof railSessions>[0])
    .filter((session) => session.id === 's1')
    .map((session) => ({ ...session, label: turn.sessionTitle!, agent: 'Codex', agentKey: 'codex' }));
  return {
    ...payload,
    sessions,
    stats,
    views: [],
    cards: [{ ...toCard(turn, false, NOW), summaryHtml: '<p>Investigate repeated prompt-cache writes.</p>' }],
    rail: railSessions(sessions, new Map(), new Map(), new Map(), new Set(), 's1', new Set(), new Map(), stats, {}),
  };
}

// A focused production-shaped page for the compaction disclosure. The host normally adds
// rendered Markdown beside each card, so this fixture follows the same boundary instead of
// handing browser tests an invented HTML fragment.
export function compactionSummaryPayload(): Record<string, unknown> {
  const payload = renderPayload() as Record<string, unknown> & { cards: Record<string, unknown>[] };
  payload.cards = COMPACTION_SUMMARIES.map((compaction) => ({
    ...toCompactionCard(compaction, NOW),
    summaryHtml: renderRichMarkdown(compaction.summary),
  }));
  return payload;
}

// The same page with the composer aimed at a draft, for the guards and the pictures that
// are about a session nobody has started.
//
// It replaces the composer and its menus and nothing else. `renderPayload` is what every
// other layout guard is measured against, so a draft written into that one would move
// figures that have nothing to do with a draft.
//
// The page with the line above the box in a state the fixture's own clock does not reach.
//
// The session's newest turn is ten minutes old and bought a five-minute cache, so the
// page draws the cold face and nothing else. A guard or a picture built on that alone would
// see the warm or cold face.
//
// Only the clock and the recorded lifetime move here. Everything else is the same
// session, so a difference between two of these pages is the state and never the data.
export function nextTurnPayload(
  state: 'warm' | 'cold' | 'no-tier' | 'compacted',
  lastRequestAt?: number,
): Record<string, unknown> {
  const payload = renderPayload();
  const newest = FIXTURE_TURNS[0];
  const hour = 3_600_000;
  // The fixture's clock rather than the wall clock, because that is the one the page runs on.
  // The warm and cold states are one session at different moments. The clock is the
  // only thing that tells them apart.
  //
  // A caller can name the moment instead, which is how a guard puts the boundary a second or
  // two ahead and watches the face cross it on its own. Such a caller reads the page's own
  // clock, because seconds decide that answer and the page runs on from this instant.
  const now = FIXTURE_CLOCK;
  const endedAt = lastRequestAt ?? (state === 'warm' ? now - 10 * 60_000 : now - 3 * hour);
  // A compaction newer than the last request. Nothing has cached what it wrote, so the line
  // names the written price at every clock and says why.
  const compaction =
    state === 'compacted' ? { at: now - 60_000, contextAfter: 42_000, trigger: 'manual', model: newest.model } : null;
  const basis = nextTurnBasisOf(
    {
      ...newest,
      endedAt,
      // These pages isolate cache state after a completed turn. The ordinary fixture keeps
      // this same card running so the timeline can exercise its live activity row.
      finished: true,
      // A one-hour lifetime, which is what the harness this panel reads actually buys. The last
      // no-tier state names none at all, which makes the estimate conservative immediately.
      contextRequest: {
        at: endedAt,
        lifetime: state === 'no-tier' ? null : '1h',
        inferenceClass: null,
        serviceTier: null,
        readBack: true,
        outputTokens: 2_900,
      },
    },
    compaction,
  );
  (payload.usage as Record<string, unknown>).composer = composerView({ ...COMPOSER, nextTurn: basis }, FIXTURE_CLOCK);
  return payload;
}

// A catalog with enough models, efforts and modes for the New session menu to list sixteen
// pinned setups beside ten recent ones, each one different.
const LAUNCHER_PIN_CATALOG = {
  claude: [
    ...COMPOSER.models,
    {
      value: 'sonnet',
      label: 'Sonnet 5.5',
      description: '',
      efforts: ['low', 'medium', 'high'].map((value) => ({ value, label: value, description: '' })),
    },
  ],
  codex: [
    {
      value: 'gpt-5.6',
      label: 'GPT-5.6',
      description: '',
      efforts: ['low', 'medium', 'high', 'xhigh'].map((value) => ({ value, label: value, description: '' })),
    },
  ],
};

// Every setup the pin catalog offers, each one distinct, taken in a stride so neighbors
// differ in more than one value.
export function launcherPinSetups(): CompleteSetupValues[] {
  const catalog = sessionLauncherView(null, [], LAUNCHER_PIN_CATALOG).agents;
  const all = catalog.flatMap((agent) =>
    agent.models.flatMap((model) =>
      model.efforts.flatMap((effort) =>
        agent.permissions.map((permission) => ({
          agent: agent.value as 'claude' | 'codex',
          model: model.value,
          effort: effort.value,
          permissionMode: permission.value,
        })),
      ),
    ),
  );
  const order = all.map((_, index) => all[(index * 7) % all.length]);
  return new Set(order).size === all.length ? order : all;
}

// The render payload's usage with the New session menu built from these setups.
export function launcherPinsUsage(
  recents: readonly CompleteSetupValues[],
  pinned: readonly PinnedSetup[],
  inherited: boolean = true,
): Record<string, unknown> {
  const usage = (renderPayload() as { usage: Record<string, unknown> }).usage;
  usage.launcher = sessionLauncherView(
    inherited ? COMPOSER : null,
    recents.map((values) => ({ ...values, source: 'recent' as const })),
    LAUNCHER_PIN_CATALOG,
    pinned,
  );
  return usage;
}

// The New session menu with this many pinned setups beside ten recent ones, or `recents`.
// `unavailable` puts a pinned setup whose model left the catalog first.
export function launcherPinsPayload(
  pins: number,
  options: { recents?: number; unavailable?: boolean; inherited?: boolean } = {},
): Record<string, unknown> {
  const setups = launcherPinSetups();
  const pinned: PinnedSetup[] = setups.slice(20, 20 + pins).map((values, index) => ({ id: `pin-${index}`, ...values }));
  if (options.unavailable) {
    pinned.unshift({ id: 'pin-retired', agent: 'claude', model: 'opus-4-retired', effort: 'high', permissionMode: '' });
  }
  const payload = renderPayload();
  payload.usage = launcherPinsUsage(setups.slice(0, options.recents ?? 10), pinned, options.inherited !== false);
  return payload;
}

// The agent menu travels with the other four here the way it travels with them in the real
// render. A control whose menu answers nothing is dropped, which is what the servers control
// does on a draft.
export function draftRenderPayload(): Record<string, unknown> {
  const payload = renderPayload();
  const usage = payload.usage as Record<string, unknown>;
  return {
    ...payload,
    usage: {
      ...usage,
      menus: Object.fromEntries(
        ['agent', 'model', 'effort', 'askmode', 'mcp']
          .map((c) => [c, pickMenu(c, DRAFT_COMPOSER)])
          .filter(([, m]) => m),
      ),
      composer: composerView(DRAFT_COMPOSER, FIXTURE_CLOCK),
    },
  };
}

// VS Code Dark Modern, the variables the panel stylesheet reads, so a headless render looks
// like the editor tab rather than like an unstyled document. The screenshot script and the
// mockup skill both dress the page with it, so it is written once, here.
export const DARK_MODERN_THEME = `:root{
--vscode-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;
--vscode-editor-background:#1f1f1f;--vscode-sideBar-background:#181818;
--vscode-editorWidget-background:#202020;--vscode-editorWidget-foreground:#cccccc;--vscode-editorWidget-border:#454545;
--vscode-widget-border:#313131;--vscode-focusBorder:#0078d4;--vscode-textLink-foreground:#4daafc;
--vscode-list-hoverBackground:#2a2d2e;--vscode-list-activeSelectionBackground:#04395e;--vscode-list-activeSelectionForeground:#ffffff;
--vscode-list-inactiveSelectionBackground:#37373d;
--vscode-button-background:#0078d4;--vscode-button-foreground:#ffffff;--vscode-button-hoverBackground:#026ec1;
--vscode-button-secondaryBackground:#313131;--vscode-button-secondaryForeground:#cccccc;
--vscode-input-background:#313131;--vscode-input-foreground:#cccccc;--vscode-input-border:#3c3c3c;--vscode-input-placeholderForeground:#989898;
--vscode-dropdown-background:#313131;--vscode-dropdown-foreground:#cccccc;--vscode-dropdown-border:#3c3c3c;
--vscode-toolbar-hoverBackground:rgba(90,93,94,0.31);--vscode-textCodeBlock-background:#2b2b2b;--vscode-textBlockQuote-border:#616161;
--vscode-testing-iconPassed:#73c991;--vscode-testing-iconFailed:#f14c4c;--vscode-errorForeground:#f85149;--vscode-editorWarning-foreground:#cca700;
--vscode-progressBar-background:#0078d4;
--vscode-gitDecoration-addedResourceForeground:#81b88b;--vscode-gitDecoration-modifiedResourceForeground:#e2c08d;--vscode-gitDecoration-deletedResourceForeground:#c74e39;
--vscode-settings-headerForeground:#ffffff;--vscode-editorHoverWidget-background:#202020;--vscode-editorHoverWidget-border:#454545;
--vscode-editor-selectionBackground:#264f78;--vscode-editor-findMatchHighlightBackground:#ea5c0055;
--vscode-charts-yellow:#cca700;--vscode-charts-blue:#59a4f9;--vscode-charts-orange:#ea5c0055;
--vscode-font-family:"Segoe WPF","Segoe UI",system-ui,sans-serif;--vscode-font-size:13px;
--vscode-editor-font-family:Consolas,"Courier New",monospace;
}
body{background:var(--vscode-editor-background);color:var(--vscode-foreground);}`;

// VS Code Light Modern, the same variables at the values that theme and its registry
// defaults resolve to. `themed` picks this table for a light-page render, so a light
// screenshot or a light layout measurement dresses the page the way a reader who switched
// the editor's theme would actually see it, rather than in the dark table above.
export const LIGHT_MODERN_THEME = `:root{
--vscode-foreground:#3b3b3b;--vscode-descriptionForeground:#3b3b3b;
--vscode-editor-background:#ffffff;--vscode-sideBar-background:#f8f8f8;
--vscode-editorWidget-background:#f8f8f8;--vscode-editorWidget-foreground:#3b3b3b;--vscode-editorWidget-border:#e5e5e5;
--vscode-widget-border:#e5e5e5;--vscode-focusBorder:#005fb8;--vscode-textLink-foreground:#005fb8;
--vscode-list-hoverBackground:#f2f2f2;--vscode-list-activeSelectionBackground:#e8e8e8;--vscode-list-activeSelectionForeground:#000000;
--vscode-list-inactiveSelectionBackground:#e4e6f1;
--vscode-button-background:#005fb8;--vscode-button-foreground:#ffffff;--vscode-button-hoverBackground:#0258a8;
--vscode-button-secondaryBackground:#e5e5e5;--vscode-button-secondaryForeground:#3b3b3b;
--vscode-input-background:#ffffff;--vscode-input-foreground:#3b3b3b;--vscode-input-border:#cecece;--vscode-input-placeholderForeground:#767676;
--vscode-dropdown-background:#ffffff;--vscode-dropdown-foreground:#3b3b3b;--vscode-dropdown-border:#cecece;
--vscode-toolbar-hoverBackground:rgba(184,184,184,0.31);--vscode-textCodeBlock-background:#f8f8f8;--vscode-textBlockQuote-border:#e5e5e5;
--vscode-testing-iconPassed:#73c991;--vscode-testing-iconFailed:#f14c4c;--vscode-errorForeground:#f85149;--vscode-editorWarning-foreground:#bf8803;
--vscode-progressBar-background:#005fb8;
--vscode-gitDecoration-addedResourceForeground:#587c0c;--vscode-gitDecoration-modifiedResourceForeground:#895503;--vscode-gitDecoration-deletedResourceForeground:#ad0707;
--vscode-settings-headerForeground:#1f1f1f;--vscode-editorHoverWidget-background:#f8f8f8;--vscode-editorHoverWidget-border:#e5e5e5;
--vscode-editor-selectionBackground:#add6ff;--vscode-editor-findMatchHighlightBackground:#ea5c0055;
--vscode-charts-yellow:#bf8803;--vscode-charts-blue:#0063d3;--vscode-charts-orange:#ea5c0055;
--vscode-font-family:"Segoe WPF","Segoe UI",system-ui,sans-serif;--vscode-font-size:13px;
--vscode-editor-font-family:Consolas,"Courier New",monospace;
}
body{background:var(--vscode-editor-background);color:var(--vscode-foreground);}`;

// One Dark Pro Darker, a dark theme a reader installs, at the values its theme file sets. It
// sets no `foreground`, so the editor's dark default applies, and every variable the theme
// leaves out keeps the Dark Modern value above.
export const ONE_DARK_PRO_DARKER_THEME = `${DARK_MODERN_THEME}
:root{
--vscode-descriptionForeground:#abb2bf;--vscode-editor-background:#23272e;--vscode-sideBar-background:#1e2227;
--vscode-editorWidget-background:#1e2227;--vscode-focusBorder:#3e4452;--vscode-textLink-foreground:#61afef;
--vscode-list-hoverBackground:#2c313a;--vscode-list-activeSelectionBackground:#2c313a;--vscode-list-activeSelectionForeground:#d7dae0;
--vscode-list-inactiveSelectionBackground:#323842;
--vscode-button-background:#404754;--vscode-button-secondaryBackground:#30333d;--vscode-button-secondaryForeground:#c0bdbd;
--vscode-input-background:#1d1f23;--vscode-input-foreground:#abb2bf;
--vscode-dropdown-background:#1e2227;--vscode-dropdown-border:#1e2227;--vscode-textBlockQuote-border:#4b5362;
--vscode-editorWarning-foreground:#d19a66;--vscode-settings-headerForeground:#fff;
--vscode-editorHoverWidget-background:#1e2227;--vscode-editorHoverWidget-border:#181a1f;
--vscode-editor-selectionBackground:#67769660;--vscode-editor-findMatchHighlightBackground:#ffffff22;
}`;

// The editor's high-contrast registry values for the variables the fixture supplies.
export const HIGH_CONTRAST_DARK_THEME = `${DARK_MODERN_THEME}
:root{
--vscode-foreground:#fff;--vscode-descriptionForeground:#ffffffb3;
--vscode-editor-background:#000;--vscode-sideBar-background:#000;
--vscode-editorWidget-background:#0c141f;--vscode-editorWidget-foreground:#fff;--vscode-editorWidget-border:#6fc3df;
--vscode-widget-border:#6fc3df;--vscode-contrastBorder:#6fc3df;--vscode-contrastActiveBorder:#f38518;
--vscode-focusBorder:#f38518;--vscode-textLink-foreground:#21a6ff;
--vscode-list-hoverBackground:#ffffff1a;--vscode-list-activeSelectionBackground:#000;--vscode-list-activeSelectionForeground:#fff;
--vscode-list-inactiveSelectionBackground:#000;
--vscode-button-background:#000;--vscode-button-foreground:#fff;--vscode-button-hoverBackground:#000;
--vscode-button-secondaryBackground:transparent;--vscode-button-secondaryForeground:#fff;
--vscode-input-background:#000;--vscode-input-foreground:#fff;--vscode-input-border:#6fc3df;--vscode-input-placeholderForeground:#ffffffb3;
--vscode-dropdown-background:#000;--vscode-dropdown-foreground:#fff;--vscode-dropdown-border:#6fc3df;
--vscode-toolbar-hoverBackground:transparent;--vscode-textCodeBlock-background:#000;--vscode-textBlockQuote-border:#fff;
--vscode-testing-iconPassed:#73c991;--vscode-testing-iconFailed:#f48771;--vscode-errorForeground:#f48771;--vscode-editorWarning-foreground:#ffd370;
--vscode-progressBar-background:#6fc3df;--vscode-settings-headerForeground:#fff;
--vscode-editorHoverWidget-background:#0c141f;--vscode-editorHoverWidget-border:#6fc3df;
--vscode-editor-selectionBackground:#fff;--vscode-editor-findMatchHighlightBackground:transparent;
}`;

export const HIGH_CONTRAST_LIGHT_THEME = `${LIGHT_MODERN_THEME}
:root{
--vscode-foreground:#292929;--vscode-descriptionForeground:#292929b3;
--vscode-editor-background:#fff;--vscode-sideBar-background:#fff;
--vscode-editorWidget-background:#fff;--vscode-editorWidget-foreground:#292929;--vscode-editorWidget-border:#0f4a85;
--vscode-widget-border:#0f4a85;--vscode-contrastBorder:#0f4a85;--vscode-contrastActiveBorder:#006bbd;
--vscode-focusBorder:#006bbd;--vscode-textLink-foreground:#0f4a85;
--vscode-list-hoverBackground:#0f4a851a;--vscode-list-activeSelectionBackground:#fff;--vscode-list-activeSelectionForeground:#292929;
--vscode-list-inactiveSelectionBackground:#fff;
--vscode-button-background:#0f4a85;--vscode-button-foreground:#fff;--vscode-button-hoverBackground:#0f4a85;
--vscode-button-secondaryBackground:#fff;--vscode-button-secondaryForeground:#292929;
--vscode-input-background:#fff;--vscode-input-foreground:#292929;--vscode-input-border:#0f4a85;--vscode-input-placeholderForeground:#292929b3;
--vscode-dropdown-background:#fff;--vscode-dropdown-foreground:#292929;--vscode-dropdown-border:#0f4a85;
--vscode-toolbar-hoverBackground:transparent;--vscode-textCodeBlock-background:#fff;--vscode-textBlockQuote-border:#292929;
--vscode-testing-iconPassed:#007100;--vscode-testing-iconFailed:#b5200d;--vscode-errorForeground:#b5200d;--vscode-editorWarning-foreground:#895503;
--vscode-progressBar-background:#0f4a85;--vscode-settings-headerForeground:#292929;
--vscode-editorHoverWidget-background:#fff;--vscode-editorHoverWidget-border:#0f4a85;
--vscode-editor-selectionBackground:#0f4a8526;--vscode-editor-findMatchHighlightBackground:transparent;
}`;

export type FixtureTheme = 'dark' | 'light' | 'onedark' | 'hc-dark' | 'hc-light';

// The class the editor puts on the body of a webview it serves, which is what `themed`
// switches so the page's own `body.vscode-light` rule and the theme table it dresses the
// page with never disagree about which kind is on screen.
export function themed(html: string, kind: FixtureTheme = 'dark'): string {
  const tables = {
    dark: DARK_MODERN_THEME,
    light: LIGHT_MODERN_THEME,
    onedark: ONE_DARK_PRO_DARKER_THEME,
    'hc-dark': HIGH_CONTRAST_DARK_THEME,
    'hc-light': HIGH_CONTRAST_LIGHT_THEME,
  };
  const classes = {
    dark: 'vscode-dark',
    light: 'vscode-light',
    onedark: 'vscode-dark',
    'hc-dark': 'vscode-high-contrast',
    'hc-light': 'vscode-high-contrast-light',
  };
  return html
    .replace('class="vscode-dark"', `class="${classes[kind]}"`)
    .replace('</head>', `<style>${tables[kind]}</style></head>`);
}

// Popovers use the same builders as the panel, with a partial history and recorded cache lifetimes.
export function statPopoverPayload(): Record<string, unknown> {
  const payload = renderPayload();
  const turns = FIXTURE_TURNS.slice(0, 2).map((turn) => ({
    ...turn,
    finished: true,
    usage: { ...turn.usage, requests: 22, thinking: 1200, cacheWrite1h: 12500, cacheWrite30m: 5400 },
  }));
  const session = sessionStats(turns, []);
  const fixtureContext = RAIL_STATS.s1.find((chip) => chip.metric === 'context');
  const expiry = RAIL_STATS.s1.find((chip) => chip.metric === 'cache-expiry');
  return {
    ...payload,
    cards: turns.map((turn) => toCard(turn, false, NOW)),
    stats: {
      ...RAIL_STATS,
      s1: [
        ...session.filter((chip) => chip.metric !== 'context'),
        ...(fixtureContext ? [fixtureContext] : []),
        ...sessionTurnStats({ turnCount: 22, compactionCount: 2, firstTurnAt: NOW - 787_680_000, lastTurnAt: NOW }),
        ...(expiry ? [expiry] : []),
      ],
    },
  };
}

// The sources that put a class on a subagent row or on either figure popover that holds one, and
// the comment marks that wrap text on a row. A stylesheet scan reads every word these sources
// write as a class that can colour the row. A
// selector whose subject is a bare tag also counts, so a wrapper around the row needs no entry
// here for a rule such as `.cardmain span`. Paths are relative to `src`.
export const AGENT_ROW_BUILDERS = [
  'webview/card-rows.ts',
  'webview/stat-chip.ts',
  'webview/stat-detail.ts',
  'webview/comments.ts',
];

// The sources that put a class or an id on a turn card, its figures, the session heading above
// it, the page around the timeline, or either figure popover and its rows, and the sources that
// wrap or mark text inside a card or a row: code blocks in a summary, the files
// on a queued card and the pinned hint on a chip. A stylesheet scan reads every word these
// sources write as a class that can size a figure. A new source that draws an element around a
// figure, or around text on a card, joins this list.
export const FIGURE_BUILDERS = [
  ...AGENT_ROW_BUILDERS,
  'webview/card.ts',
  'webview/timeline-renderer.ts',
  'webview/queue-live.ts',
  'webview/panel.ts',
  'webview/inline-text.ts',
  'webview/summary.ts',
  'webview/attachments.ts',
  'webview/hints.ts',
  'paneldevelopment.ts',
];

// The values those builders substitute into a class from a field the webview reads as a plain
// string, as the host types them: the turn status on a card, and the status and kind on an
// Activity row. A stylesheet scan adds every string of this union to the builders' classes, so
// a new status joins it with no edit here. A builder that substitutes another such field into a
// class adds the field's host type.
export type FigureClassValues = TurnStatus | TurnStepStatus | ActivityRow['kind'];

// The classes the editor puts on the body of a webview: one theme kind, and the flags for
// reduced motion and a screen reader. No panel source writes them, so a stylesheet scan that
// reads classes from the sources adds these by hand.
export const EDITOR_BODY_CLASSES = [
  'vscode-dark',
  'vscode-light',
  'vscode-high-contrast',
  'vscode-high-contrast-light',
  'vscode-reduce-motion',
  'vscode-using-screen-reader',
];
