import { DARK_MODERN_THEME, LIGHT_MODERN_THEME, ONE_DARK_PRO_DARKER_THEME } from './view/static-themes.ts';
import { ChildCacheExpiryAttribution } from './childcacheexpiry.ts';
import { turnKey } from './domain/read.ts';
// Shared panel page and render payload for browser tests and screenshots.
// Importing a test module registers its tests, so scripts use this separate fixture module.
// Production modules do not import this file.
// The fixture uses the panel's builders to keep payload fields aligned with their output.

import { formatRelative, railSessions, toCard } from './turnview.ts';
import { labelCounts } from './turnlabels.ts';
import type { SavedView } from './domain/views.ts';
import type { SavedRailFilter } from './domain/rail-filters.ts';
import type { RailStatus } from './turnrail.ts';
import type {
  Turn,
  UsageCounts,
  UsageTools,
  TurnAgent,
  TurnAsk,
  TurnCommit,
  TurnFileChange,
  TurnStep,
  TurnStepStatus,
  TurnUpdate,
} from './transcript.ts';
import {
  CACHE_EXPIRY_COST_ADDED_HINT,
  nextTurnBasisOf,
  sessionCacheExpiryStats,
  sessionCostProjection,
  sessionStats,
  sessionTurnStats,
  toCompactionCard,
  turnCacheExpiryWarning,
  type ActivityRow,
  type SessionStatChip,
  type TurnStatus,
} from './turncard.ts';
import {
  emptyCacheExpiryFacts,
  type CacheExpiryFacts,
  type ProjectSpendView,
  type NativeChildCacheFacts,
} from './projectspend.ts';
import type { CompleteSetupValues, PinnedSetup } from './domain/session-setups.ts';
import type { Ask, PermissionAsk, QuestionAsk } from './agentwire.ts';
import { usageBar } from './usageview.ts';
import { composerView, pickMenu, sessionLauncherView } from './composerview.ts';
import { fillPanelText, panelValues } from './paneltext.ts';
import { browserBundle, browserStylesheet } from './panelbundle.ts';
import { renderRichMarkdown } from './richtext.ts';
import type { Compaction } from './transcript.ts';
import type { SubagentContextFigure } from './subagentcontext.ts';

// Fill the browser bundle and stylesheet with the panel's text values.
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

// Match the panel shell without its content-security policy or nonces.
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

// Long headlines exercise wrapping in the timeline.
// The panel's builders produce the cards and session list rows.
const HEADLINE =
  'Landed the usage reducer in extension/src/usageview.ts, wired both wires to it, and put the refresh path behind one press on the strip rather than on every repaint of the panel';
// Keep the newest turn over a minute old for an elapsed age.
// Keep it under an hour old for the running turn's quiet window.
export const NEWEST_TURN_AGE = 10 * 60_000;

// Anchor the fixture at 2:42 PM local time.
// NOW is ten minutes earlier, matching the first session row's 2:32 PM label.
export const ANCHOR_HOUR = 14;
export const ANCHOR_MINUTE = 42;

// Anchor the fixture to the local calendar so its session list retains relative day groups.
// A fixed wall time keeps group membership independent of the run's hour.
// A daylight-saving change moves one older session across midnight, while both day groups retain sessions.
// The anchor never exceeds the supplied clock, so all fixture ages remain elapsed.
export function fixtureClock(realNow: number): number {
  const at = new Date(realNow);
  const anchor = new Date(at.getFullYear(), at.getMonth(), at.getDate(), ANCHOR_HOUR, ANCHOR_MINUTE, 0, 0);
  // Use the previous calendar day before the anchor time.
  // Calendar subtraction preserves wall time across daylight-saving changes.
  if (anchor.getTime() > realNow) {
    anchor.setDate(anchor.getDate() - 1);
  }
  return anchor.getTime();
}

// Browser tests and screenshots share this clock.
// The browser uses its local calendar to group the fixture's sessions.
export const FIXTURE_CLOCK = fixtureClock(Date.now());

export const NOW = FIXTURE_CLOCK - NEWEST_TURN_AGE;

// This long path exercises horizontal overflow when a flex item cannot shrink below its content width.
export const LONG_PATH =
  'extension/src/deeply/nested/generated/fixtures/one-very-long-unbroken-directory-name/another-one-just-as-long/report.json';

// Identify the long turn by its one-based number and zero-based index.
// Tests and screenshots use these constants to select the same card.
export const LONG_TURN_N = 3;
export const LONG_TURN_INDEX = LONG_TURN_N - 1;

// The long response includes two paragraphs around a list to exercise a tall Markdown response.
export const LONG_SUMMARY = `The morning went to the tasks on the list from last week. Most of them were small, and each one closed before the next one started, so the list is shorter now than it has been for a while. Two items took longer than planned because they waited on answers from other people.

- The first item was a set of notes from the planning meeting, tidied and shared with the group so everyone reads the same version.
- The second item was a review of the open questions, with each one given an owner and a date for the answer.
- The third item was a short list of chores for the week, sorted by how long each one takes.
- The last item was a reply to the messages that came in overnight, so nothing is left waiting.

Everything that was planned for today is done. The two items that waited on other people have answers now, and the rest of the week has room for the larger piece of work that comes next.`;

// The long turn carries seven files with varied path lengths, three subagents, and three commits.
// The unbroken path exercises wrapping alongside short filenames.
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

// Place the long turn's activity and commits relative to its start time.
const LONG_TURN_START = NOW - LONG_TURN_N * 600_000;

// The commits cover the open folder and two linked worktrees.
// One worktree matches its branch name. The other has a separate directory name.
// One subagent also reports both worktree commits.
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

// The long turn has one running subagent and two completed subagents.
// Only one completed subagent has a child session link.
// The running subagent pairs with its launch step through toolUseId.
// The completed subagents carry cost data, and one also carries reasoning effort and artifacts.
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
    // The subagent and parent share two commits, which count once per SHA.
    // Two subagent files overlap the parent's files.
    // The third appears only in the subagent's artifacts, exercising combined file rows.
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
      // Include tool counts, failures, and start and end times in the duration details.
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

// Commentary messages vary in length to exercise clamped and unclamped Activity log text.
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

// Nine steps include one failed command, which supplies an Activity log failure mark.
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

// Match each step's tool category by ordinal.
const LONG_STEP_KINDS = ['reads', 'searches', 'edits', 'edits', 'commands', 'commands', 'edits', 'commands', 'agents'];

// Two later prompts accompany the initial prompt, exercising multiple reader submissions on one card.
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
- [Read the turn card guide](docs/turn-cards.md) before changing the browser fixture.

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
    // Only two turns carry file changes.
    // One has two files, and the long turn has seven with varied path lengths.
    // The remaining turns exercise cards without file figures.
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
    // Record the request timestamp separately from the turn's end for cache expiry.
    contextRequest: {
      at: n === 1 ? NOW - 4_000 : NOW - n * 600_000 + 492_000,
      lifetime: '5m' as const,
      inferenceClass: null,
      serviceTier: null,
      readBack: true,
      outputTokens: 2_900,
    },
    // Supply tool totals for the long turn and the other turns.
    toolUses: n === LONG_TURN_N ? 11 : 36,
    toolCounts:
      n === LONG_TURN_N
        ? { edits: 3, reads: 1, searches: 1, commands: 3, agents: 3, coordination: 0, web: 0, other: 0 }
        : { edits: 9, reads: 12, searches: 6, commands: 7, agents: 2, coordination: 0, web: 0, other: 0 },
    toolTally: {},
    // The newest turn's Activity log includes an unbroken path to exercise horizontal overflow.
    // It also includes a later prompt from the reader.
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
    // Match each category to its step ordinal.
    // The Skill step uses the skill category, which is separate from tool categories.
    stepKinds:
      n === 1
        ? [...Array(60).fill('reads'), 'reads', 'skill', 'commands', 'searches']
        : n === LONG_TURN_N
          ? LONG_STEP_KINDS
          : [],
    failedOrdinals: n === 1 ? [63] : n === LONG_TURN_N ? [6] : [],
    // Two turns cover recorded skill loads and a best-effort skill read.
    // They include repeated loads, missing paths, and a catalog description.
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
    // Keep the newest turn running for the folded card's activity text.
    // The other turns are finished.
    failures: [],
    interrupted: false,
    finished: n !== 1,
    error: null,
  };
}

// Export the session's turns in newest-first order.
// Tests compare their context level with the separately written session figures.
export const FIXTURE_TURNS: Turn[] = Array.from({ length: 24 }, (_, n) => turnAt(n + 1));

// State for the prompt box, its controls, and their menus.
export const COMPOSER = {
  agent: 'claude' as const,
  session: 'Embedded agent input',
  draft: '',
  onScreen: '',
  queued: [],
  // Supply prompt history for Up-arrow navigation without adding submitted prompts to the timeline.
  history: ['Explain the snapshot store', 'Rename the note type to comment'],
  running: false,
  comments: [],
  sessionId: 's1',
  models: [
    { value: 'opus', label: 'Opus 5', description: '', efforts: [{ value: 'high', label: 'high', description: '' }] },
  ],
  // Long command names and descriptions exercise menu wrapping.
  // The command count exercises the menu's height limit.
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
  // Derive the next-turn basis from the newest turn.
  // An unfinished turn produces no basis.
  nextTurn: nextTurnBasisOf(FIXTURE_TURNS[0], null),
  mcpServers: [],
  live: [],
  // A null skill catalog exercises Claude command fallback when callers retain this value.
  claudeSkills: null,
};

// Add an inherited draft profile while retaining session s1.
// Keep the copied context figure to exercise composerView's omission of context for drafts.
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

// A pending submission draws a live card above the timeline.
export const LIVE_PRESS = {
  sessionId: 's1',
  agent: 'claude' as const,
  kind: 'prompt' as 'prompt' | 'compact',
  // The long prompt exercises the live card's three-line clamp.
  text:
    'take the sandbox with the approval and then run the whole smoke test again from the top, ' +
    'then read back what it printed and say which of the checks were skipped and why, and if ' +
    'any of them were skipped for a reason that is no longer true say so plainly rather than ' +
    'leaving it in the list, and then do the same for the browser tests',
  reply: '',
  at: NOW - 4000,
  // A submission outside a running turn draws its own live card.
  midTurn: false,
  ran: false,
  started: false,
  failed: false,
  reason: '',
};

// Five MCP servers cover connected, failed, and disabled states.
// Long names and one long error exercise menu wrapping.
// The default prompt box has no servers, exercising omission of the server control.
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

// Type rate sources against ProjectSpendView so provenance values retain the producer's union type.
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
  // Rate sources cover reported, configured, and public pricing.
  // The reported charge has no effective date.
  // The configured and public rates share a date, exercising a shared pricing date.
  rateSources: PROJECT_SPEND_RATES,
  // Keep project cost idle unless a caller supplies an indexing or calculating state.
  indexing: false,
  calculating: false,
  indexingStatus: null,
};

// Use this wording while project cost indexes.
export const PROJECT_SPEND_INDEXING_WORD = 'Updating…';

// One estimated rate has an effective date and the other has none.
// Pricing details must attach the date only to the rate that supplies it.
// The reported charge remains undated.
export const PROJECT_SPEND_UNDATED_RATES: ProjectSpendRateSources = [
  { source: 'Provider-reported cost', effectiveDate: null, provenance: 'reported' },
  { source: 'Workspace contract', effectiveDate: '2026-08-01', provenance: 'configured' },
  { source: 'OpenAI list price', effectiveDate: null, provenance: 'public' },
];

// Both agents use public rates with equal provenance rank.
// Reversing these inputs must preserve the displayed rate order.
export const PROJECT_SPEND_PEER_RATES: ProjectSpendRateSources = [
  { source: 'Anthropic list price', effectiveDate: null, provenance: 'public' },
  { source: 'OpenAI list price', effectiveDate: null, provenance: 'public' },
];

// Write session figures separately from the displayed turns.
// The fixture test compares the context figure with the newest turn's context level.
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
        'Cache expiry: 3 affected requests\n\nCache lifetimes: 1 at 5m · 2 at 30m\nCost added: $2.86\nLongest qualifying gap: 1d 2h\nExcluded ambiguous events: 2\nThe record does not identify every cache-key change.',
      detailList: {
        layout: 'economics',
        heading: { label: 'Cache expiry', value: '3 affected requests' },
        entries: [
          { label: 'Cache lifetimes', value: '1 at 5m · 2 at 30m' },
          { label: 'Cost added', value: '$2.86', valueTitle: CACHE_EXPIRY_COST_ADDED_HINT },
          { label: 'Longest qualifying gap', value: '1d 2h' },
          { label: 'Excluded ambiguous events', value: '2' },
        ],
        notes: ['The record does not identify every cache-key change.'],
      },
    },
  ],
  // Session s2 has no cost figure, exercising a combined cost that remains a lower bound.
  s2: [{ metric: 'context', compactLabel: '14% ctx', kind: 'plain', label: '14% of 1M ctx (140k)', detail: '' }],
  // Session s4 pairs its long label with a cost figure for label placement measurements.
  s4: [{ metric: 'cost', compactLabel: '$0.42', kind: 'plain', label: '$0.42', detail: '', dollars: 0.42 }],
};

// The first session's cache is warm.
// The second is in the final quarter of its lifetime.
// Both hold a 1-hour cache.
const RAIL_CACHES = {
  s1: { expiresAt: FIXTURE_CLOCK + 45 * 60_000, nearlyGoneAt: FIXTURE_CLOCK + 30 * 60_000, tier: '1h' as const },
  s2: { expiresAt: FIXTURE_CLOCK + 10 * 60_000, nearlyGoneAt: FIXTURE_CLOCK - 5 * 60_000, tier: '1h' as const },
};

// Labels cover overflow, a single label, and sessions without labels.
// Session s4 has a long label to exercise truncation beside its cost figure.
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

// Share question and permission requests between browser tests and screenshots.
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

// A long written answer exercises tab truncation while retaining the full answer in its accessible name.
export const LONG_WRITTEN_ANSWER =
  'Keep the tab strip, but let the arrow keys move between ' +
  'questions as well, and remember which question the reader was on across a repaint';

// Three questions supply a middle tab and a long header.
// The first question receives LONG_WRITTEN_ANSWER in the browser test.
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

// Six questions exercise a wrapped tab strip.
// The final question accepts a secret, so its tab must indicate an answer without exposing it.
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
        { label: 'turn-cards.md', description: 'The document that owns card rendering.' },
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

// The archived IDs populate hidden and the session list's archived flags.
// Optional statuses reach railSessions for row styling and accessible names.
// An empty status map exercises rows without a status.
// The placeholder Remote Control session link. A fixture never carries a real one.
export const REMOTE_CONTROL_LINK = 'https://claude.ai/code/session_01ABCDEFGHJKMNPQRSTVWXYZ';

// Draw the Remote Control item in a payload's prompt box, as a connected session whose link is `url`.
export function withRemoteControl(
  payload: Record<string, unknown>,
  url: string | null = REMOTE_CONTROL_LINK,
): Record<string, unknown> {
  const usage = payload.usage as { composer: Record<string, unknown> };
  usage.composer = {
    ...usage.composer,
    remoteControl: composerView({ ...COMPOSER, remoteControl: { url } }, FIXTURE_CLOCK)!.remoteControl,
  };
  return payload;
}

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
  // Live subagent counts for sessions with subagents status.
  openChildren: ReadonlyMap<string, number> = new Map(),
  // Live command counts for sessions with background status.
  commands: ReadonlyMap<string, number> = new Map(),
): Record<string, unknown> {
  // Include usage windows for both agents and Claude spend to exercise a crowded usage bar.
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
  // Enough cards exercise sticky headings through a long timeline.
  // Render the long turn's Markdown response beside its card, matching the host payload.
  const cards = FIXTURE_TURNS.map((turn, index) => {
    const card = toCard(turn, index === 0, NOW);
    if (index !== LONG_TURN_INDEX) {
      return { ...card, summaryHtml: `<p>${HEADLINE}</p>` };
    }
    return {
      ...card,
      summaryHtml: renderRichMarkdown(turn.summary),
      // Render Markdown for Activity message rows beside their source text.
      activity: card.activity.map((row) =>
        row.kind === 'message' ? { ...row, summaryHtml: renderRichMarkdown(row.text ?? '') } : row,
      ),
    };
  });
  // Enough sessions exercise the session list's height limit above the panel foot.
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
  // Mark supplied session IDs as agent runs for session list grouping.
  const marked = rows.map((r) => ({
    ...r,
    persisted: true,
    agentKey: r.agent.toLowerCase(),
    agentRun: runs.includes(r.id),
  }));
  return {
    type: 'render',
    cards,
    // Leave resume commands to the browser, using each session's agent key and ID.
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
    // Count fixture labels for filter suggestions.
    labels: labelCounts(RAIL_LABELS),
    // Saved views supply session list sections.
    views: RAIL_VIEWS,
    railFilters: RAIL_FILTERS,
    // Copy the stats map so callers can remove a session's figures from this payload alone.
    stats: { ...RAIL_STATS },
    hidden: archived,
    pinnedTop: pinned,
    comments: [],
    // All timeline cards belong to the selected session s1.
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
      // Build settings and server menus from the prompt box state.
      // Remove empty menus, including the server menu when no servers exist.
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

// A Claude session with estimated compactions and cache expiries, and a turn that returned to an
// expired cache. The session cost popover names both overheads, and the turn warns on its figure.
// A Claude turn opened by a return to an expired cache, with the session facts that hold the return.
export function cacheExpiryReturnTurn(): { turn: Turn; expiry: CacheExpiryFacts } {
  const { turn, expiry } = costOverheadsParts();
  return { turn, expiry };
}

// A part of some usage, with its context bands, as a tool kind's even part of its requests holds it.
function usageShare(usage: Turn['usage'], share: number): Turn['usage'] {
  const scale = (counts: UsageCounts): UsageCounts =>
    Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, value * share])) as unknown as UsageCounts;
  const { byContextBand, ...counts } = usage;
  return {
    ...scale(counts),
    ...(byContextBand
      ? { byContextBand: Object.fromEntries(Object.entries(byContextBand).map(([band, held]) => [band, scale(held)])) }
      : {}),
  };
}

// Tool kinds from each kind's request count and its part of the usage.
function fixtureTools(requests: number, kinds: [string, number, Turn['usage']][]): UsageTools {
  return {
    requests,
    kinds: Object.fromEntries(kinds.map(([kind, count, usage]) => [kind, { requests: count, usage }])),
  };
}

function costOverheadsParts() {
  const usage = (over: Partial<Turn['usage']>): Turn['usage'] => ({
    requests: 1,
    input: 0,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheWrite30m: 0,
    cacheRead: 0,
    output: 0,
    thinking: 0,
    ...over,
  });
  const part = {
    model: 'claude-opus-5-5',
    provider: null,
    contextWindow: null,
    contextBand: null,
    inferenceClass: null,
    serviceTier: null,
  };
  const returned = usage({ requests: 1, input: 6_000, cacheWrite1h: 182_000, output: 1_600 });
  const expiry: CacheExpiryFacts = {
    counts: { '5m': 0, '30m': 0, '1h': 4 },
    longestGapMs: 5 * 60 * 60 * 1000,
    returns: [
      {
        lifetime: '1h',
        gapMs: 72 * 60 * 1000,
        request: {
          localDate: '2026-10-09',
          agent: 'claude',
          ...part,
          billingClass: 'metered',
          reportedCost: null,
          usage: returned,
          requests: 1,
        },
        visibleTurnId: 'claude-turn:9',
        requestKey: 'claude:msg-return',
        previousInputSide: 180_000,
      },
    ],
    excluded: 0,
    unavailable: 0,
    truncated: true,
  };
  const turn: Turn = {
    ...FIXTURE_TURNS[1],
    agent: 'claude',
    model: part.model,
    provider: null,
    sessionTitle: 'Cost overheads',
    contextWindow: null,
    usage: returned,
    // The one request read a file and a search result, so each holds half its cost.
    usageParts: [
      {
        ...part,
        usage: returned,
        tools: fixtureTools(1, [
          ['file read', 1, usageShare(returned, 0.5)],
          ['search', 1, usageShare(returned, 0.5)],
        ]),
      },
    ],
    responseIds: ['msg-return'],
    openingResponseId: 'msg-return',
    agents: [],
    files: [],
  };
  return { usage, part, turn, expiry };
}

export function costOverheadsPayload(): Record<string, unknown> {
  const payload = renderPayload();
  const { usage, part, turn, expiry } = costOverheadsParts();
  const childTurn = {
    ...turn,
    startedAt: turn.startedAt + 20 * 60_000,
    endedAt: turn.startedAt + 21 * 60_000,
    promptId: 'child-expiry-parent',
    responseIds: [],
    openingResponseId: undefined,
    prompt: 'Review the subagents after their cache expires.',
  };
  const childFacts: CacheExpiryFacts = {
    ...emptyCacheExpiryFacts(),
    counts: { '5m': 2, '30m': 0, '1h': 0 },
    returns: [0, 1].map((at) => ({
      ...expiry.returns[0],
      lifetime: '5m',
      timestamp: childTurn.startedAt + (10 + at) * 60_000,
      requestKey: `claude:child-only-return-${at}`,
    })),
  };
  const childSource: NativeChildCacheFacts = {
    source: 'fixture-subagent.jsonl',
    revision: {} as NativeChildCacheFacts['revision'],
    facts: childFacts,
    endedAt: null,
    outcome: null,
  };
  const aggregate: CacheExpiryFacts = { ...expiry, counts: { ...expiry.counts, '5m': 2 }, childSources: [childSource] };
  const childCosts = new ChildCacheExpiryAttribution().read([turn, childTurn], { [turn.sessionId]: aggregate }, NOW);
  const session = usage({
    requests: 410,
    input: 1_900_000,
    cacheWrite1h: 1_800_000,
    cacheRead: 24_000_000,
    output: 620_000,
  });
  const compactions = usage({ requests: 3, input: 160_000, cacheRead: 300_000, output: 36_000 });
  const stats = {
    s1: [
      ...sessionCostProjection(
        [
          {
            agent: 'claude',
            role: 'main',
            ...part,
            usage: session,
            tools: fixtureTools(300, [
              ['file read', 120, usageShare(session, 0.24)],
              ['file edit', 60, usageShare(session, 0.17)],
              ['test or build', 40, usageShare(session, 0.14)],
              ['search', 50, usageShare(session, 0.08)],
              ['git', 20, usageShare(session, 0.04)],
              ['subagent launch', 4, usageShare(session, 0.02)],
              ['other', 30, usageShare(session, 0.09)],
            ]),
          },
          { agent: 'claude', role: 'main', ...part, compactionEstimate: true, usage: compactions },
        ],
        false,
        { compactionCount: 3, expiry: aggregate },
      ).stats,
      ...sessionTurnStats({ turnCount: 22, firstTurnAt: turn.startedAt, lastTurnAt: turn.endedAt, compactionCount: 3 }),
      ...sessionCacheExpiryStats(aggregate),
    ],
  };
  const sessions = (payload.sessions as Parameters<typeof railSessions>[0])
    .filter((session) => session.id === 's1')
    .map((session) => ({ ...session, label: turn.sessionTitle!, agent: 'Claude', agentKey: 'claude' }));
  return {
    ...payload,
    sessions,
    stats,
    views: [],
    cards: [
      {
        ...toCard(turn, false, NOW, [], null, false, new Set(), [], turnCacheExpiryWarning(turn, expiry)),
        summaryHtml: '<p>Resumed after lunch.</p>',
      },
      {
        ...toCard(
          childTurn,
          false,
          NOW,
          [],
          null,
          false,
          new Set(),
          [],
          turnCacheExpiryWarning(childTurn, aggregate, childCosts.get(turnKey(childTurn))),
        ),
        summaryHtml: '<p>Both subagents returned after their caches expired.</p>',
      },
    ],
    rail: railSessions(sessions, new Map(), new Map(), new Map(), new Set(), 's1', new Set(), new Map(), stats, {}),
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

// A Codex coordinator whose main agent spent over a fifth of its cost reading subagent wait returns.
// Delegated work keeps the waits under a quarter of the whole session's cost. `five` adds children
// with recorded costs, so the delegated work holds five model groups, two without a recorded model.
export function waitWarningPayload(delegated: 'three' | 'five' = 'three'): Record<string, unknown> {
  const payload = renderPayload();
  const usage = (over: Partial<Turn['usage']>): Turn['usage'] => {
    const counts = {
      requests: 1,
      input: 0,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      cacheWrite30m: 0,
      cacheRead: 0,
      output: 0,
      thinking: 0,
      ...over,
    };
    return { ...counts, byContextBand: { short: { ...counts } } };
  };
  const part = {
    model: 'gpt-6.1-sol',
    provider: 'openai',
    contextWindow: 1_050_000,
    contextBand: 'short' as const,
    inferenceClass: null,
    serviceTier: null,
  };
  const ran = usage({ requests: 160, input: 900_000, cacheRead: 30_000_000, output: 240_000 });
  const waits = {
    requests: 42,
    timedOut: 30,
    tools: { wait_agent: 36, write_stdin: 6 },
    usage: usage({ requests: 42, input: 60_000, cacheRead: 13_000_000, output: 9_000 }),
  };
  // The wait requests read wait returns alone. Other requests read files, tests, Git and searches.
  const tools = fixtureTools(120, [
    ['wait', 42, waits.usage],
    ['file read', 30, usage({ requests: 30, input: 150_000, cacheRead: 5_000_000, output: 40_000 })],
    ['test or build', 20, usage({ requests: 20, input: 120_000, cacheRead: 4_000_000, output: 30_000 })],
    ['git', 10, usage({ requests: 10, input: 50_000, cacheRead: 1_500_000, output: 10_000 })],
    ['search', 6, usage({ requests: 6, input: 30_000, cacheRead: 1_000_000, output: 8_000 })],
    ['other', 12, usage({ requests: 12, input: 90_000, cacheRead: 2_500_000, output: 25_000 })],
  ]);
  const turn: Turn = {
    ...FIXTURE_TURNS[1],
    agent: 'codex',
    model: part.model,
    provider: part.provider,
    sessionTitle: 'Subagent waits',
    contextWindow: part.contextWindow,
    usage: ran,
    usageParts: [{ ...part, usage: ran, waits, tools }],
    agents: [],
    files: [],
  };
  // Three named children share the delegated work.
  const child = (agentName: string, model: string, session: string, share: number) => ({
    agent: 'codex',
    role: 'delegated' as const,
    scopeId: `source:/codex/sessions/rollout-2026-10-09T10-00-00-${session}.jsonl`,
    agentName,
    ...part,
    model,
    usage: usageShare(usage({ requests: 220, input: 1_400_000, cacheRead: 40_000_000, output: 380_000 }), share),
  });
  const stats = {
    s1: [
      ...sessionCostProjection([
        { agent: 'codex', role: 'main', ...part, usage: ran, waits, tools },
        child('code_review_1_npm_tests_astra', 'gpt-6-astra', '01a1535a-e7c6-7cc3-a9aa-9552803efb51', 0.03),
        child('code_implement_1_npm_tests_sol', 'gpt-6.1-sol', '01a1503b-b2f2-7be2-a08f-fde25f58b552', 0.55),
        child('code_fix_1_npm_tests_sol_deadlines', 'gpt-6.1-sol', '01a15289-b637-7f71-bce5-143c96986ad2', 0.42),
        ...(delegated === 'five'
          ? (
              [
                ['code_audit_1_logs', null, '01a15301-0000-7000-8000-000000000001', 6],
                ['code_audit_2_logs', null, '01a15301-0000-7000-8000-000000000002', 5],
                ['code_plan_1_schema_opus', 'claude-opus-5-5', '01a15301-0000-7000-8000-000000000003', 4],
                ['code_lint_1_haiku', 'claude-haiku-5-5', '01a15301-0000-7000-8000-000000000004', 0.2],
              ] as const
            ).map(([name, model, session, recordedCost]) => ({
              ...child(name, 'gpt-6.1-sol', session, 0.01),
              model,
              recordedCost,
              costBasis: 'list',
            }))
          : []),
      ]).stats,
      ...sessionTurnStats({ turnCount: 1, firstTurnAt: turn.startedAt, lastTurnAt: turn.endedAt, compactionCount: 0 }),
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
    cards: [{ ...toCard(turn, false, NOW), summaryHtml: '<p>Waited on two reviewers.</p>' }],
    rail: railSessions(sessions, new Map(), new Map(), new Map(), new Set(), 's1', new Set(), new Map(), stats, {}),
  };
}

// Build compaction cards and render their summaries as Markdown, matching the host payload.
export function compactionSummaryPayload(): Record<string, unknown> {
  const payload = renderPayload() as Record<string, unknown> & { cards: Record<string, unknown>[] };
  payload.cards = COMPACTION_SUMMARIES.map((compaction) => ({
    ...toCompactionCard(compaction, NOW),
    summaryHtml: renderRichMarkdown(compaction.summary),
  }));
  return payload;
}

// Build next-turn cost states from a completed turn with a one-hour cache lifetime or no recorded lifetime.
// Warm and cold states vary the request timestamp.
// The compacted state supplies a newer compaction and its retained context level.
export function nextTurnPayload(
  state: 'warm' | 'cold' | 'no-tier' | 'compacted',
  lastRequestAt?: number,
): Record<string, unknown> {
  const payload = renderPayload();
  const newest = FIXTURE_TURNS[0];
  const hour = 3_600_000;
  // Use the browser fixture's clock for cache expiry.
  // An explicit request timestamp lets callers place the expiry boundary relative to that clock.
  const now = FIXTURE_CLOCK;
  const endedAt = lastRequestAt ?? (state === 'warm' ? now - 10 * 60_000 : now - 3 * hour);
  // A newer compaction supplies uncached retained context for the next-turn estimate.
  const compaction =
    state === 'compacted' ? { at: now - 60_000, contextAfter: 42_000, trigger: 'manual', model: newest.model } : null;
  const basis = nextTurnBasisOf(
    {
      ...newest,
      endedAt,
      // Complete the turn so nextTurnBasisOf can supply its cost basis.
      finished: true,
      // Use a one-hour cache lifetime except in the no-tier state, which records none.
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

// A model catalog supplies distinct combinations for pinned and recent setups.
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

// Enumerate distinct setup combinations.
// Use a stride when it covers every combination, otherwise retain the enumeration order.
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

// Build the payload's New session menu from supplied recent and pinned setups.
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

// Supply the requested pins and recent setups, defaulting to ten recents.
// The unavailable option prepends a pin whose model is absent from the catalog.
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

// Build draft menus, including the agent menu, and remove empty menus.
// Build the prompt box from the draft profile.
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

// Dark Modern theme variables for browser tests, screenshots, and mockups.
export { DARK_MODERN_THEME, LIGHT_MODERN_THEME } from './view/static-themes.ts';

// Layer One Dark Pro Darker values over the Dark Modern table.
// Variables omitted here retain the Dark Modern values.
export { ONE_DARK_PRO_DARKER_THEME } from './view/static-themes.ts';
// High-contrast dark values layered over the Dark Modern table.
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

// Apply the theme's body class and variable table together.
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

// The subagent results cases of the context chip popover, as the approved board draws them.
export type SubagentContextCase =
  | 'board'
  | 'measured'
  | 'longest'
  | 'many'
  | 'partial'
  | 'removed'
  | 'unattributed'
  | 'missing';

// The context level every subagent results case shares, about 118k as on the board.
const SUBAGENT_CASE_CONTEXT = 117_000;
const BOARD_SUBAGENTS = [
  { name: 'Survey every caller of renderPayload and list the fields each one reads', tokens: 6200 },
  { name: 'Fix the stale cache key in the usage reducer', tokens: 3800 },
  { name: 'Check the plan for steps that name no file', tokens: 1600 },
  { name: 'Delete the scratch worktree', tokens: 800 },
];
const subagentFigure = (agents: Array<{ name: string; tokens: number }>, extra = 0): SubagentContextFigure => ({
  tokens: agents.reduce((sum, line) => sum + line.tokens, extra),
  partial: false,
  removed: false,
  agents,
});

export const SUBAGENT_CONTEXT_CASES: Record<SubagentContextCase, SubagentContextFigure | undefined> = {
  board: subagentFigure(BOARD_SUBAGENTS),
  measured: subagentFigure([
    { name: 'Review the parser', tokens: 1000 },
    { name: 'Find the fixtures', tokens: 520 },
    { name: 'List the session files', tokens: 280 },
  ]),
  longest: subagentFigure([
    {
      name: 'Read every caller of the usage reducer, trace how each one keys its cache, and report the callers that pass a stale session path',
      tokens: 5100,
    },
  ]),
  many: subagentFigure([
    BOARD_SUBAGENTS[0],
    BOARD_SUBAGENTS[1],
    BOARD_SUBAGENTS[2],
    { name: 'Read the oversized tool output and summarize the failures', tokens: 900 },
    BOARD_SUBAGENTS[3],
    ...Array.from({ length: 7 }, (_, index) => ({ name: `Check fixture ${index + 1}`, tokens: 300 })),
  ]),
  partial: { ...subagentFigure(BOARD_SUBAGENTS), partial: true },
  removed: { tokens: 0, partial: false, removed: true, agents: [] },
  // A wait output with two receivers counts in the value and in no line.
  unattributed: subagentFigure(BOARD_SUBAGENTS.slice(0, 2), 1200),
  missing: undefined,
};

// Popovers use the same builders as the panel, with a partial history and recorded cache lifetimes.
// A subagent results case gives both turns its figure and draws the session context chip from them.
export function statPopoverPayload(subagents?: SubagentContextCase): Record<string, unknown> {
  const payload = renderPayload();
  const figure = subagents ? SUBAGENT_CONTEXT_CASES[subagents] : undefined;
  const turns = FIXTURE_TURNS.slice(0, 2).map((turn) => ({
    ...turn,
    finished: true,
    outputRate: { output: 84, milliseconds: 10000 },
    usage: { ...turn.usage, requests: 22, thinking: 1200, cacheWrite1h: 12500, cacheWrite30m: 5400 },
    ...(subagents ? { contextTokens: SUBAGENT_CASE_CONTEXT } : {}),
    ...(figure ? { subagentContext: figure } : {}),
  }));
  const session = sessionStats(turns, []);
  const fixtureContext = (subagents ? session : RAIL_STATS.s1).find((chip) => chip.metric === 'context');
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

// Source paths for the subagent row color checks, relative to src.
// The check also includes selectors with a bare tag subject, such as .cardmain span.
export const AGENT_ROW_BUILDERS = [
  'webview/card-rows.ts',
  'webview/stat-chip.ts',
  'webview/stat-detail.ts',
  'webview/comments.ts',
];

// Source paths for the card figure size checks, including text wrappers and hints.
// Add sources that create elements around figures or card text.
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

// Host union types supply dynamic class values for figure size checks.
// Add the host type when a builder uses another plain-string field in a class.
export type FigureClassValues = TurnStatus | TurnStepStatus | ActivityRow['kind'];

// Include editor body classes in figure size checks because panel sources do not create them.
export const EDITOR_BODY_CLASSES = [
  'vscode-dark',
  'vscode-light',
  'vscode-high-contrast',
  'vscode-high-contrast-light',
  'vscode-reduce-motion',
  'vscode-using-screen-reader',
];
