// Capture panel states in Dark Modern and Light Modern as lossless WebP images.
//
// Run from the extension directory:
//
//     npx tsx scripts/panel-shots.ts [outDir]
//
// The script uses an installed browser and downloads nothing. Without a browser, it writes no files.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { estimateCodexContext } from '../src/codexcontext.ts';
import { normalizeContext, unavailableContext, type ContextIdentity } from '../src/domain/context-detail.ts';
import { codexContextRecords } from '../src/turnfixtures.ts';
import type { Browser, Page } from 'playwright-core';
import { composerView, sessionLauncherView, type LivePress } from '../src/composerview.ts';
import {
  CARD_ACTIONS,
  RAIL_WIDTH_DEFAULT,
  RAIL_WIDTH_MIN,
  labelEditorRows,
  newestTurnLoading,
} from '../src/turnview.ts';
import { turnKey } from '../src/domain/read.ts';
import {
  COMPOSER,
  FIXTURE_TURNS,
  LONG_TURN_INDEX,
  LIVE_PRESS,
  NOW,
  PERMISSION_ASK,
  QUESTION_ASK,
  SIX_QUESTION_ASK,
  THREE_QUESTION_ASK,
  FIXTURE_CLOCK,
  draftRenderPayload,
  launcherPinsPayload,
  compactionSummaryPayload,
  cacheWriteWarningPayload,
  costOverheadsPayload,
  waitWarningPayload,
  nextTurnPayload,
  pageHtml,
  renderPayload,
  statPopoverPayload,
  type SubagentContextCase,
  themed,
  withRemoteControl,
} from '../src/panelfixture.ts';
import type { RailStatus } from '../src/turnrail.ts';
import type { RailDensity } from '../src/view/rail.ts';
import { toCard } from '../src/turncard.ts';

// Capture options for one panel state. Shots share page state, so `escape` closes popovers before the next capture.
export interface Shot {
  contextDetail?: 'claude' | 'claude-unavailable' | 'codex' | 'codex-compacted';
  name: string; // Output filename without the extension.
  width?: number; // Viewport width before capture.
  height?: number; // Viewport height when setting the width.
  openCard?: string; // Card heading to press if its card is closed.
  layout?: { cardLayout: string; promptPosition: string }; // Timeline layout for capture. Restore the default afterward.
  railWidth?: number; // Saved session list width for capture.
  railDensity?: RailDensity; // Rows value for capture. Restore Full rows and the prior session list width afterward.
  pinned?: string; // Session to pin in the status fixture. Restore the default payload afterward.
  railFilterPreset?: string; // Saved filter ID to select before capture.
  railFilterPicker?: 'open' | 'closed'; // View menu state before capture.
  escape?: boolean | number; // Number of Escape presses before other actions. `true` presses once.
  click?: string; // Control selector to press.
  costTab?: 'Tools'; // Cost popover tab to select after the click pins it.
  costHover?: string; // Cost figure to hover until its unpinned popover opens.
  hover?: string; // Control selector to hover until its hint opens.
  after?: string; // Control selector to press after capture.
  state?: 'first-project-empty' | 'first-project-draft';
  openCustom?: boolean;
  stats?: boolean;
  subagentContext?: SubagentContextCase; // Load the popover fixture with this subagent results case.
  draft?: boolean; // Load a draft into the prompt box.
  unsent?: boolean; // Load a session list card with unsent reader input.
  longName?: boolean; // Name the first session with a long prompt that holds a path and slash commands.
  subagents?: boolean; // Load sessions and the long turn card with running background subagents.
  // Load live requests. `true` supplies a permission request and one question.
  // `three` supplies tabbed questions. `six` supplies questions spanning more than two rows.
  asks?: boolean | 'three' | 'six';
  files?: boolean; // Load the prompt attachment fixture.
  waiting?: boolean; // Show a queued attachment above a running compaction.
  labels?: boolean; // Supply label editor rows after the control requests them.
  labelTyped?: string; // Text to type into the label editor's find box after its rows arrive.
  details?: boolean; // Open session details through a host message.
  rename?: 'heading' | 'rail'; // Open Rename session from the first session heading or session list card.
  filter?: string; // Text to type into the session list filter box.
  railCount?: 'active'; // Session list header count to press.
  railLens?: 'unread' | 'input'; // Filter value to select before closing the View menu.
  headCounts?: boolean; // Load sessions that populate Running, Active, Unread, and Needs input counts.
  railHeadUntick?: 'active' | 'unread' | 'input'; // Quick filters checkbox to clear in the View menu.
  clip?: string; // Element selector to crop to its first 140 pixels.
  clipWhole?: boolean; // Capture the entire selected element.
  focus?: string; // Control selector to focus before capture.
  nextTurn?: 'warm' | 'cold' | 'no-tier' | 'compacted'; // Cache state for the next-turn starting price.
  activity?: 'messages' | 'empty' | 'all' | 'breakdown';
  compactionSummary?: 'collapsed' | 'expanded';
  cacheWriteWarning?: boolean;
  costOverheads?: boolean | 'delegated'; // `delegated` adds delegated work and a turn compaction.
  waitWarning?: boolean | 'five'; // `five` gives the delegated work five model groups.
  waitWarningTurnAgents?: boolean; // The turn holds the delegated children as its subagents.
  waitWarningNoChildTools?: boolean; // The delegated children read no tool results.
  composerSkill?: boolean;
  remoteControl?: boolean; // Draw the prompt box of a session whose Remote Control is connected with a link.
  raisedComposer?: boolean;
  launcherPins?: number | 'unavailable'; // Pinned setups for the New session menu fixture, beside ten recent setups.
}

const ATTACHMENT_ASSETS = [
  {
    id: 'image-one',
    name: 'pasted-14-32-05.png',
    mime: 'image/png',
    size: 200_000,
    digest: '0'.repeat(64),
    path: 'C:/staged/image-one',
  },
  {
    id: 'image-two',
    name: 'pasted-14-33-41.png',
    mime: 'image/png',
    size: 200_000,
    digest: '1'.repeat(64),
    path: 'C:/staged/image-two',
  },
  {
    id: 'document',
    name: `${'usage-reducer-design-notes-'.repeat(2)}final-reviewed.pdf`,
    mime: 'application/pdf',
    size: 3 * 1024 * 1024,
    digest: '2'.repeat(64),
    path: 'C:/staged/document',
  },
];

// The visible next-turn starting price control.
const NEXT_TURN_PRICE = '.cnextturnface:not(.is-off) .cnextturnprice';

// Label editor replies use these session labels to match the session list fixture.
const SHOT_LABELS: Record<string, string[]> = {
  s1: ['composer', 'release 0.4', 'perf'],
  s2: ['release 0.4'],
  s4: ['worktree parallel sessions and the rails'],
};

// Find the long turn by its key, so adding earlier cards leaves the selector unchanged.
const LONG_CARD_HEAD = `#list [data-key="${turnKey(FIXTURE_TURNS[LONG_TURN_INDEX])}"] h3.cardheading button.head`;
const LONG_CARD_FILES_CHIP = `#list [data-key="${turnKey(FIXTURE_TURNS[LONG_TURN_INDEX])}"] .statchip[data-metric="files"]`;
const LONG_CARD_AGENTS_CHIP = `#list [data-key="${turnKey(FIXTURE_TURNS[LONG_TURN_INDEX])}"] .statchip[data-metric="agents"]`;
const LONG_CARD_COST_CHIP = `#list [data-key="${turnKey(FIXTURE_TURNS[LONG_TURN_INDEX])}"] .statchip[data-metric="cost"]`;

export const SHOTS: Shot[] = [
  { name: 'wide', width: 1350 },
  ...(['claude', 'claude-unavailable', 'codex', 'codex-compacted'] as const).flatMap((contextDetail) =>
    [1350, 340].map((width) => ({
      name: `${width === 1350 ? 'wide' : 'narrow'}-composer-context-${contextDetail}`,
      width,
      escape: true,
      contextDetail,
      focus: '.cctx',
      clip: '#composer-context-detail',
      clipWhole: true,
    })),
  ),
  { name: 'wide-composer-raised', width: 1350, raisedComposer: true },
  {
    name: 'wide-stat-context',
    width: 1350,
    escape: true,
    stats: true,
    click: '.sessionstats .statchip:has-text("ctx")',
  },
  {
    name: 'wide-stat-cache-expiry',
    width: 1350,
    escape: true,
    stats: true,
    click: '.sessionstats [data-metric="cache-expiry"]',
  },
  {
    name: 'wide-stat-turns',
    width: 1350,
    escape: true,
    stats: true,
    click: '.sessionstats .statchip:has-text("turns")',
  },
  {
    name: 'wide-stat-files',
    width: 1350,
    escape: true,
    stats: true,
    click: '.sessionstats .statchip:has-text("files")',
  },
  { name: 'wide-stat-tokens', width: 1350, escape: true, stats: true, click: '.chips .statchip:has-text("in")' },
  { name: 'wide-stat-turn-files', width: 1350, escape: true, stats: true, click: '.chips .statchip:has(.add)' },
  {
    name: 'wide-stat-no-files',
    width: 1350,
    escape: true,
    stats: true,
    click: '.chips .statchip:has-text("no file changes")',
  },
  ...(['board', 'measured', 'longest', 'many', 'partial', 'removed', 'unattributed', 'missing'] as const).map(
    (subagentContext): Shot => ({
      name: `wide-stat-turn-context-subagents-${subagentContext}`,
      width: 1350,
      escape: true,
      stats: true,
      subagentContext,
      click: '.chips .statchip:has-text("ctx")',
    }),
  ),
  ...(['board', 'removed'] as const).map((subagentContext): Shot => ({
    name: `wide-stat-context-subagents-${subagentContext}`,
    width: 1350,
    escape: true,
    stats: true,
    subagentContext,
    click: '.sessionstats .statchip:has-text("ctx")',
  })),
  {
    name: 'narrow-stat-turn-context-subagents-board',
    width: 340,
    escape: true,
    stats: true,
    subagentContext: 'board',
    click: '.chips .statchip:has-text("ctx")',
  },
  {
    name: 'narrow-stat-context-subagents-board',
    width: 340,
    escape: true,
    stats: true,
    subagentContext: 'board',
    click: '.sessionstats .statchip:has-text("ctx")',
  },
  {
    name: 'narrow-stat-context',
    width: 340,
    escape: true,
    stats: true,
    click: '.sessionstats .statchip:has-text("ctx")',
  },
  {
    name: 'narrow-stat-cache-expiry',
    width: 340,
    escape: true,
    stats: true,
    click: '.sessionstats [data-metric="cache-expiry"]',
  },
  {
    name: 'narrow-stat-turns',
    width: 340,
    escape: true,
    stats: true,
    click: '.sessionstats .statchip:has-text("turns")',
  },
  {
    name: 'narrow-stat-files',
    width: 340,
    escape: true,
    stats: true,
    click: '.sessionstats .statchip:has-text("files")',
  },
  { name: 'narrow-stat-tokens', width: 340, escape: true, stats: true, click: '.chips .statchip:has-text("in")' },
  { name: 'narrow-stat-turn-files', width: 340, escape: true, stats: true, click: '.chips .statchip:has(.add)' },
  {
    name: 'narrow-stat-no-files',
    width: 340,
    escape: true,
    stats: true,
    click: '.chips .statchip:has-text("no file changes")',
  },
  { name: 'wide-restored', width: 1350, escape: true, stats: false },
  {
    name: 'wide-compact',
    width: 1350,
    escape: true,
    railWidth: RAIL_WIDTH_DEFAULT,
    railDensity: 'compact',
    pinned: 's6',
  },
  // Capture the compact row hover at default and minimum session list widths.
  // The Full rows capture uses the same pinned-session payload for comparison.
  {
    name: 'wide-compact-hover',
    width: 1350,
    escape: true,
    railWidth: RAIL_WIDTH_DEFAULT,
    railDensity: 'compact',
    pinned: 's6',
    hover: '#rail .railcard[data-session="s6"]',
  },
  {
    name: 'wide-comfortable-pinned',
    width: 1350,
    escape: true,
    railWidth: RAIL_WIDTH_DEFAULT,
    railDensity: 'comfortable',
    pinned: 's6',
  },
  {
    name: 'narrow-rail-compact-hover',
    width: 1350,
    escape: true,
    railWidth: RAIL_WIDTH_MIN,
    railDensity: 'compact',
    hover: '#rail .railcard',
  },
  // The narrow state comes first, so the wide one restores the width the states after it inherit.
  { name: 'narrow-session-heading-hint', width: 340, longName: true, hover: '.session' },
  { name: 'wide-session-heading-hint', width: 1350, longName: true, hover: '.session' },
  // A press pins the whole name open. A second press closes it before the next state.
  { name: 'narrow-session-heading-pinned', width: 340, longName: true, click: '.session', after: '.session' },
  { name: 'wide-session-heading-pinned', width: 1350, longName: true, click: '.session', after: '.session' },
  { name: 'wide-rail-hint', hover: '.railrow .railhide' },
  { name: 'wide-launcher-menu-hint', hover: '#rail .railnewmenu' },
  { name: 'wide-project-cost', click: '.projectspendrailhost .projectspendbutton' },
  {
    name: 'wide-project-cost-pricing',
    click: '#projectspendpop [data-control="projectspend:pricing"]',
    after: '#projectspendpop [data-control="projectspend:pricing"]',
  },
  { name: 'wide-launcher', escape: true, click: '#rail .railnewmenu' },
  // Capture custom fields with the Codex model catalog.
  { name: 'wide-launcher-codex', click: '#launcher [data-control="launch-agent:codex"]' },
  { name: 'wide-label-editor', escape: 2, click: '.railrow .raillabelact', labels: true },
  { name: 'wide-details', escape: 2, details: true },
  // Capture session labels and their editor under the session heading. The action closes the editor after capture, since Escape alone leaves it open.
  {
    name: 'wide-session-labels',
    escape: true,
    click: '.sessionlabels .sessionlabelact',
    labels: true,
    after: '.sessionlabels .sessionlabelact',
  },
  // Typed text shows the Create row with Enter, and the key on the row that Tab applies, past an applied row and a long name.
  {
    name: 'wide-label-typed',
    escape: true,
    click: '.sessionlabels .sessionlabelact',
    labels: true,
    labelTyped: 're',
    after: '.sessionlabels .sessionlabelact',
  },
  // Cancel closes Rename session after capture. Capture blurs focus, so Escape alone leaves the editor open.
  { name: 'wide-session-rename', escape: true, rename: 'heading', after: '[data-control="session-rename-cancel"]' },
  { name: 'wide-rail-session-rename', escape: true, rename: 'rail', after: '[data-control="session-rename-cancel"]' },
  // An unfinished `label:` term opens label suggestions without narrowing the session list.
  { name: 'wide-filter-offers', escape: true, filter: 'label:', after: '.filterclear' },
  // The same typed editor at a narrow width. The next capture sets its own width.
  {
    name: 'narrow-label-typed',
    width: 340,
    escape: true,
    click: '.sessionlabels .sessionlabelact',
    labels: true,
    labelTyped: 're',
    after: '.sessionlabels .sessionlabelact',
  },
  { name: 'mid', width: 640, escape: true },
  { name: 'narrow', width: 340 },
  // Use taller viewports for long turn card captures at wide and intermediate widths.
  { name: 'wide-long-card', width: 1350, height: 1650, escape: true, openCard: LONG_CARD_HEAD },
  { name: 'mid-long-card', width: 640, height: 1950, openCard: LONG_CARD_HEAD },
  // Capture the long turn card with its Files popover pinned open.
  { name: 'wide-long-card-files', width: 1350, height: 1650, openCard: LONG_CARD_HEAD, click: LONG_CARD_FILES_CHIP },
  // Capture the long turn card with its Subagents popover pinned open.
  { name: 'wide-long-card-agents', width: 1350, height: 1650, openCard: LONG_CARD_HEAD, click: LONG_CARD_AGENTS_CHIP },
  // The linked subagent row opens its own popover for usage cost and commits.
  {
    name: 'wide-long-card-agent-hint',
    width: 1350,
    height: 1650,
    escape: true,
    openCard: LONG_CARD_HEAD,
    click: LONG_CARD_AGENTS_CHIP,
    hover: '#chippop .agentrow .namelink',
  },
  // Close the wide capture's popover before pressing the same chip. Pressing an open chip closes its popover.
  {
    name: 'narrow-long-card-agents',
    width: 340,
    height: 2650,
    escape: true,
    openCard: LONG_CARD_HEAD,
    click: LONG_CARD_AGENTS_CHIP,
  },
  // The long turn's cost popover, with its delegated work, at both widths.
  ...[1350, 340].map((width) => ({
    name: `${width === 1350 ? 'wide' : 'narrow'}-long-card-cost`,
    width,
    height: width === 1350 ? 1650 : 2650,
    escape: true,
    openCard: LONG_CARD_HEAD,
    click: LONG_CARD_COST_CHIP,
  })),
  // Capture the long turn after its main agent finishes while two subagents run.
  {
    name: 'wide-long-card-subagents',
    width: 1350,
    height: 1650,
    escape: 2,
    subagents: true,
    openCard: LONG_CARD_HEAD,
    hover: '#rail .railcard.subagents',
  },
  {
    name: 'narrow-long-card-subagents',
    width: 340,
    height: 2650,
    escape: 2,
    subagents: true,
    openCard: LONG_CARD_HEAD,
  },
  // Capture the long turn under each alternative Timeline layout.
  {
    name: 'wide-long-card-one-column',
    width: 1350,
    height: 1650,
    escape: true,
    openCard: LONG_CARD_HEAD,
    layout: { cardLayout: 'one-column', promptPosition: 'above' },
  },
  {
    name: 'wide-long-card-two-columns',
    width: 1350,
    height: 1650,
    openCard: LONG_CARD_HEAD,
    layout: { cardLayout: 'two-columns', promptPosition: 'above' },
  },
  {
    name: 'wide-long-card-prompt-below',
    width: 1350,
    height: 1650,
    openCard: LONG_CARD_HEAD,
    layout: { cardLayout: 'compact', promptPosition: 'below' },
  },
  {
    name: 'narrow-long-card-two-columns',
    width: 340,
    height: 2650,
    openCard: LONG_CARD_HEAD,
    layout: { cardLayout: 'two-columns', promptPosition: 'above' },
  },
  // Capture the Timeline layout dialog under the session heading.
  {
    name: 'wide-layout-dialog',
    width: 1350,
    escape: true,
    click: '#list .sessionlayout',
    after: '#list .sessionlayout',
  },
  {
    name: 'narrow-layout-dialog',
    width: 340,
    escape: true,
    click: '#list .sessionlayout',
    after: '#list .sessionlayout',
  },
  // Close the long turn card after the narrow capture.
  { name: 'narrow-long-card', width: 340, height: 2450, escape: true, openCard: LONG_CARD_HEAD, after: LONG_CARD_HEAD },
  { name: 'wide-composer-skill', width: 1350, escape: true, composerSkill: true, click: '.cskilltoken' },
  { name: 'narrow-composer-skill', width: 340, escape: true, composerSkill: true, click: '.cskilltoken' },
  { name: 'wide-composer-remote-control', width: 1350, escape: true, remoteControl: true },
  { name: 'narrow-composer-remote-control', width: 340, escape: true, remoteControl: true },
  { name: 'wide-compaction-summary', width: 1350, escape: true, compactionSummary: 'collapsed' },
  {
    name: 'wide-compaction-summary-open',
    width: 1350,
    compactionSummary: 'expanded',
    after: 'section.compaction .head',
  },
  { name: 'narrow-compaction-summary', width: 340, compactionSummary: 'collapsed' },
  {
    name: 'narrow-compaction-summary-open',
    width: 340,
    compactionSummary: 'expanded',
    after: 'section.compaction .head',
  },
  // Capture the session list header at rest and with the Active query visible. Clear the query afterward.
  { name: 'wide-rail-head-resting', width: 1350, escape: true, railWidth: RAIL_WIDTH_DEFAULT },
  {
    name: 'wide-rail-head-lens-words',
    width: 1350,
    escape: true,
    railWidth: RAIL_WIDTH_DEFAULT,
    railCount: 'active',
    click: '[data-control="railsearch"]',
    after: '[data-control="railclear"]',
  },
  // Capture the open filter box at wide and default session list widths.
  // Its tools share one line at the wide width and use two lines at the default width.
  {
    name: 'rail-head-box-open-480',
    width: 1350,
    escape: true,
    railWidth: 480,
    railCount: 'active',
    click: '[data-control="railsearch"]',
    clip: '#rail',
    after: '[data-control="railclear"]',
  },
  {
    name: 'rail-head-box-open-220',
    width: 1350,
    escape: true,
    railWidth: RAIL_WIDTH_DEFAULT,
    railCount: 'active',
    click: '[data-control="railsearch"]',
    clip: '#rail',
    after: '[data-control="railclear"]',
  },
  // Capture the session list header at several widths, at rest and with Active selected.
  // The resting fixture populates Running, Active, Unread, and Needs input counts.
  ...[480, 300, 247, 220].flatMap((railWidth): Shot[] => [
    {
      name: `rail-head-resting-${railWidth}`,
      width: 1350,
      escape: true,
      railWidth,
      headCounts: true,
      clip: '#rail',
    },
    {
      name: `rail-head-active-${railWidth}`,
      width: 1350,
      escape: true,
      railWidth,
      railCount: 'active',
      clip: '#rail',
      after: '[data-control="railcount:active"]',
    },
  ]),
  // Capture the full viewport because Project cost extends beyond the session list.
  ...[480, RAIL_WIDTH_DEFAULT].map((railWidth): Shot => ({
    name: `rail-cost-open-${railWidth}`,
    width: 1350,
    escape: true,
    railWidth,
    click: '.projectspendrailhost .projectspendbutton',
    after: '.projectspendrailhost .projectspendbutton',
  })),
  // Capture the complete session list at wide, default, and minimum widths.
  ...[480, RAIL_WIDTH_DEFAULT, RAIL_WIDTH_MIN].map((railWidth): Shot => ({
    name: `rail-whole-resting-${railWidth}`,
    width: 1350,
    escape: true,
    railWidth,
    headCounts: true,
    clip: '#rail',
    clipWhole: true,
  })),
  // Capture the Unread lens at default and minimum widths. Clear the lens after each capture.
  ...[RAIL_WIDTH_DEFAULT, RAIL_WIDTH_MIN].map((railWidth): Shot => ({
    name: `rail-head-unread-${railWidth}`,
    width: 1350,
    escape: true,
    railWidth,
    railLens: 'unread',
    clip: '#rail',
    after: '[data-control="railcount:unread"]',
  })),
  // Capture the View menu with Unread selected, including lenses with zero sessions.
  {
    name: 'rail-lens-menu-open',
    width: 1350,
    escape: true,
    railWidth: RAIL_WIDTH_DEFAULT,
    railLens: 'unread',
    click: '[data-control="railfilters"]',
    after: '[data-control="raillens:all"]',
  },
  // Capture Quick filters with Needs input cleared. Select it again afterward.
  {
    name: 'rail-head-config-menu',
    width: 1350,
    escape: true,
    railWidth: RAIL_WIDTH_DEFAULT,
    headCounts: true,
    railHeadUntick: 'input',
    after: '[data-control="railheadlens:input"]',
  },
  { name: 'rail-compact-minimum', width: 1350, escape: true, railWidth: RAIL_WIDTH_MIN, railDensity: 'compact' },
  {
    name: 'rail-filter-default-closed',
    width: 1350,
    railWidth: RAIL_WIDTH_DEFAULT,
    railFilterPreset: 'f2',
    railFilterPicker: 'closed',
  },
  { name: 'rail-filter-default-open', railWidth: RAIL_WIDTH_DEFAULT, railFilterPreset: 'f2', railFilterPicker: 'open' },
  { name: 'rail-filter-minimum-closed', railWidth: RAIL_WIDTH_MIN, railFilterPreset: 'f2', railFilterPicker: 'closed' },
  { name: 'rail-filter-minimum-open', railWidth: RAIL_WIDTH_MIN, railFilterPreset: 'f2', railFilterPicker: 'open' },
  { name: 'wide-activity-messages', width: 1350, escape: true, activity: 'messages' },
  { name: 'narrow-activity-messages', width: 340, activity: 'messages' },
  { name: 'wide-activity-empty', width: 1350, activity: 'empty' },
  { name: 'narrow-activity-empty', width: 340, activity: 'empty' },
  { name: 'wide-activity-breakdown', width: 1350, activity: 'breakdown', click: '.acttool' },
  { name: 'narrow-activity-breakdown', width: 340, escape: true, activity: 'breakdown', click: '.acttool' },
  { name: 'wide-activity-skills', width: 1350, activity: 'breakdown', click: '.actskills' },
  { name: 'narrow-activity-skills', width: 340, escape: true, activity: 'breakdown', click: '.actskills' },
  { name: 'wide-activity-all', width: 1350, escape: true, activity: 'all', click: '.actviewaction' },
  { name: 'narrow-activity-all', width: 340, activity: 'all' },
  { name: 'narrow-details', escape: true, details: true },
  { name: 'narrow-project-cost', click: '.projectspendcompacthost .projectspendbutton' },
  { name: 'narrow-launcher', escape: true, click: '.controls .compactnewmenu' },
  // Capture a short narrow panel where the setup list shrinks before the menu scrolls.
  ...([0, 4, 16, 'unavailable'] as const).map((pins): Shot => ({
    name: `narrow-short-launcher-pins-${pins}`,
    width: 340,
    height: 360,
    escape: true,
    launcherPins: pins,
    click: '.controls .compactnewmenu',
  })),
  // Capture a tall panel where the setup list grows to the menu's size limit.
  {
    name: 'wide-tall-launcher-pins-16',
    width: 1200,
    height: 1000,
    escape: true,
    launcherPins: 16,
    click: '#rail .railnewmenu',
  },
  // Capture the hover highlight across a pinned setup and its pin.
  {
    name: 'wide-tall-launcher-pinned-hover',
    width: 1200,
    height: 1000,
    escape: true,
    launcherPins: 4,
    click: '#rail .railnewmenu',
    hover: '#launcher .launchentry .launchpin.is-pinned',
  },
  // Capture Unpin on an unavailable setup without highlighting the row.
  {
    name: 'wide-tall-launcher-unavailable-hover',
    width: 1200,
    height: 1000,
    escape: true,
    launcherPins: 'unavailable',
    click: '#rail .railnewmenu',
    hover: '#launcher .launchentry.is-unavailable [data-control^="launchpin:"]',
  },
  // Edit loads the unavailable setup and identifies its missing catalog value.
  {
    name: 'wide-tall-launcher-edit-unavailable',
    width: 1200,
    height: 1000,
    launcherPins: 'unavailable',
    click: '#launcher [data-control="launchedit:pin:pin-retired"]',
  },
  // Capture the longest Effort catalog in the narrow panel.
  {
    name: 'narrow-launcher-pins-4',
    width: 340,
    height: 900,
    escape: true,
    launcherPins: 4,
    click: '.controls .compactnewmenu',
  },
  {
    name: 'narrow-launcher-pins-codex',
    width: 340,
    height: 900,
    launcherPins: 4,
    click: '#launcher [data-control="launch-agent:codex"]',
  },
  { name: 'first-project-empty-wide', width: 1350, escape: true, state: 'first-project-empty' },
  { name: 'first-project-setup', openCustom: true },
  { name: 'first-project-draft-wide', escape: 2, state: 'first-project-draft' },
  { name: 'first-project-draft-narrow', width: 340 },
  { name: 'first-project-draft-restored-wide', width: 1350 },
  { name: 'wide-draft', width: 1350, escape: true, draft: true },
  { name: 'narrow-draft', width: 340, draft: true },
  { name: 'wide-unsent', width: 1350, unsent: true },
  { name: 'wide-asks', width: 1350, asks: true },
  { name: 'narrow-asks', width: 340, asks: true },
  { name: 'wide-asks-tabs', width: 1350, asks: 'three' },
  { name: 'wide-asks-written', click: '[data-control="ask:layout-three:scope:Other"]' },
  { name: 'wide-asks-shut', asks: 'three', click: '[data-control="askfold:layout-three"]' },
  { name: 'wide-asks-six', asks: 'six' },
  { name: 'narrow-asks-tabs', width: 340, asks: 'three' },
  { name: 'narrow-asks-six', width: 340, asks: 'six' },
  { name: 'wide-attachments', width: 1350, escape: true, files: true },
  { name: 'narrow-attachments', width: 340, files: true },
  { name: 'wide-waiting-attachment', width: 1350, waiting: true },
  { name: 'narrow-waiting-attachment', width: 340, waiting: true },
  // Capture next-turn starting price details in each cache state.
  // The fixture clock produces the cold state, so the warm state needs an explicit payload.
  { name: 'wide-next-turn-warm', width: 1350, escape: true, nextTurn: 'warm', click: NEXT_TURN_PRICE },
  { name: 'wide-next-turn-cold', escape: true, nextTurn: 'cold', click: NEXT_TURN_PRICE },
  // Capture the conservative price when the session has no recorded cache lifetime.
  { name: 'wide-next-turn-no-tier', escape: true, nextTurn: 'no-tier', click: NEXT_TURN_PRICE },
  { name: 'narrow-next-turn-warm', width: 340, escape: true, nextTurn: 'warm' },
  { name: 'narrow-next-turn-cold', escape: true, nextTurn: 'cold' },
  { name: 'wide-next-turn-compacted', width: 1350, escape: true, nextTurn: 'compacted', click: NEXT_TURN_PRICE },
  { name: 'wide-cache-write-warning', width: 1350, escape: true, cacheWriteWarning: true },
  {
    name: 'wide-cache-write-detail',
    width: 1350,
    escape: true,
    cacheWriteWarning: true,
    click: '.sessionstats [data-metric="cost"]',
  },
  { name: 'narrow-cache-write-warning', width: 340, escape: true, cacheWriteWarning: true },
  {
    name: 'narrow-cache-write-detail',
    width: 340,
    escape: true,
    cacheWriteWarning: true,
    click: '.sessionstats [data-metric="cost"]',
  },
  { name: 'rail-cache-write-warning', width: 1350, railWidth: RAIL_WIDTH_MIN, escape: true, cacheWriteWarning: true },
  ...[1350, 340].flatMap((width) => {
    const size = width === 1350 ? 'wide' : 'narrow';
    return [
      {
        name: `${size}-cost-overheads-session`,
        width,
        escape: true,
        costOverheads: true,
        click: '.sessionstats [data-metric="cost"]',
      },
      {
        name: `${size}-cost-overheads-turn`,
        width,
        escape: true,
        costOverheads: true,
        click: '.chips [data-metric="cost"]',
      },
      {
        name: `${size}-cost-overheads-session-delegated`,
        width,
        escape: true,
        costOverheads: 'delegated' as const,
        click: '.sessionstats [data-metric="cost"]',
      },
      {
        name: `${size}-cost-overheads-turn-delegated`,
        width,
        escape: true,
        costOverheads: 'delegated' as const,
        click: '.chips [data-metric="cost"]',
      },
      {
        name: `${size}-cost-overheads-turn-tools`,
        width,
        escape: true,
        costOverheads: true,
        click: '.chips [data-metric="cost"]',
        costTab: 'Tools' as const,
      },
      {
        name: `${size}-wait-warning-session`,
        width,
        escape: true,
        waitWarning: true,
        click: '.sessionstats [data-metric="cost"]',
      },
      {
        name: `${size}-wait-warning-session-five-models`,
        width,
        escape: true,
        waitWarning: 'five' as const,
        click: '.sessionstats [data-metric="cost"]',
      },
      {
        name: `${size}-wait-warning-session-hover`,
        width,
        escape: true,
        waitWarning: true,
        costHover: '.sessionstats [data-metric="cost"]',
      },
      {
        name: `${size}-wait-warning-session-tools`,
        width,
        escape: true,
        waitWarning: true,
        click: '.sessionstats [data-metric="cost"]',
        costTab: 'Tools' as const,
      },
      {
        name: `${size}-wait-warning-turn`,
        width,
        escape: true,
        waitWarning: true,
        click: '.chips [data-metric="cost"]',
      },
      {
        name: `${size}-wait-warning-turn-delegated-tools`,
        width,
        escape: true,
        waitWarning: true,
        waitWarningTurnAgents: true,
        click: '.chips [data-metric="cost"]',
        costTab: 'Tools' as const,
      },
      {
        name: `${size}-wait-warning-turn-main-tools-only`,
        width,
        escape: true,
        waitWarning: true,
        waitWarningTurnAgents: true,
        waitWarningNoChildTools: true,
        click: '.chips [data-metric="cost"]',
        costTab: 'Tools' as const,
      },
      {
        name: `${size}-wait-warning-turn-five-models`,
        width,
        escape: true,
        waitWarning: 'five' as const,
        waitWarningTurnAgents: true,
        click: '.chips [data-metric="cost"]',
      },
    ];
  }),
];

// Session list status fixtures include waiting, running, running subagents, and failed sessions.
const SHOT_STATUSES = new Map<string, RailStatus>([
  ['s1', 'waiting'],
  ['s2', 'running'],
  ['s3', 'subagents'],
  ['s4', 'waiting'],
  ['s6', 'failed'],
]);
const SHOT_RUNNING_SINCE = new Map<string, number>([['s2', FIXTURE_CLOCK - 31 * 60_000]]);
const SHOT_OPEN_CHILDREN = new Map<string, number>([['s3', 2]]);

// Live requests appear below the selected session, beside session list status fixtures.
function asksPayload(which: boolean | 'three' | 'six'): Record<string, unknown> {
  const asks =
    which === 'three' ? [THREE_QUESTION_ASK] : which === 'six' ? [SIX_QUESTION_ASK] : [PERMISSION_ASK, QUESTION_ASK];
  return renderPayload([], [], [], [], asks, [], SHOT_STATUSES, SHOT_RUNNING_SINCE, [], SHOT_OPEN_CHILDREN);
}

// The long turn has finished main-agent work and running background subagents.
function subagentsPayload(): Record<string, unknown> {
  const payload = renderPayload([], [], [], [], [], [], SHOT_STATUSES, SHOT_RUNNING_SINCE, [], SHOT_OPEN_CHILDREN) as {
    cards: Record<string, unknown>[];
  };
  // Mark the first subagent as a background launch that outlives its turn.
  const recorded = FIXTURE_TURNS[LONG_TURN_INDEX];
  const background = {
    ...recorded,
    agents: recorded.agents.map((agent, index) => (index === 0 ? { ...agent, status: 'async_launched' } : agent)),
  };
  const live = toCard(background, false, NOW, [], null, true);
  payload.cards[LONG_TURN_INDEX] = { ...payload.cards[LONG_TURN_INDEX], chips: live.chips, agents: live.agents };
  return payload;
}

function unsentPayload(): Record<string, unknown> {
  const payload = renderPayload() as { rail: Record<string, unknown>[] };
  payload.rail[0] = {
    ...payload.rail[0],
    unsentWord: 'unsent',
    unsentName: 'unsent prompt',
    name: 'Embedded agent input, Claude, unsent prompt, 6 days ago, showing now',
  };
  return payload;
}

// A session named by its first prompt, with a path, slash commands and a session ID in it.
const LONG_SESSION_NAME =
  'C:/Users/greg/Documents/arc/.claude/plans/2026/10/2026-10-24-arc-start-session-link/plan.md /review this plan again, get a sol high review too then /ship it if it makes sense. also see claude sesion 10d8aebf-803c-465d-b2ed-365386af7d7c /close-session and archive it if everyhthing there is done, you were taking over';

function longNamePayload(): Record<string, unknown> {
  const payload = renderPayload() as { sessions: Record<string, unknown>[] };
  payload.sessions[0] = { ...payload.sessions[0], label: LONG_SESSION_NAME, fullLabel: LONG_SESSION_NAME };
  return payload;
}

function waitingPayload(): Record<string, unknown> {
  const payload = renderPayload() as {
    cards: Record<string, unknown>[];
    sessions: Record<string, unknown>[];
    rail: Record<string, unknown>[];
    usage: { composer: unknown };
  };
  const live: LivePress = { ...LIVE_PRESS, agent: 'codex', kind: 'compact', text: '' };
  payload.cards = payload.cards.map((card) => ({ ...card, agent: 'Codex', model: 'gpt-5.6' }));
  payload.sessions = payload.sessions.map((session) =>
    session.id === 's1' ? { ...session, agent: 'Codex' } : session,
  );
  payload.rail = payload.rail.map((row) => (row.id === 's1' ? { ...row, agent: 'Codex' } : row));
  payload.usage.composer = composerView(
    {
      ...COMPOSER,
      agent: 'codex',
      live: [live],
      queued: [
        {
          id: 'waiting-attachment',
          text: 'Check this screenshot after compaction',
          commentIds: [],
          assets: [ATTACHMENT_ASSETS[0]],
          at: NOW + 1_000,
          delivery: { phase: 'queued', owner: 's1' },
        },
      ],
      assetPreviews: {
        'image-one':
          "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='36' height='36'%3E%3Crect width='36' height='36' fill='%233c6e91'/%3E%3Ccircle cx='12' cy='12' r='5' fill='%23f2cc8f'/%3E%3Cpath d='M3 31 14 20l7 7 5-5 7 9' fill='%2381b29a'/%3E%3C/svg%3E",
      },
    },
    FIXTURE_CLOCK,
  );
  return payload;
}

function activityPayload(which: NonNullable<Shot['activity']>): Record<string, unknown> {
  const payload = renderPayload() as { cards: Array<Record<string, unknown>> };
  const card = payload.cards[0];
  const message = {
    kind: 'message',
    messageKind: 'commentary',
    id: 'shot-message',
    status: 'done',
    at: NOW,
    when: '2:31 PM',
    absolute: '2:31 PM',
    text: 'The implementation and its focused checks are complete.',
    summaryHtml: '<p>The implementation and its focused checks are complete.</p>',
    line: '',
    code: '',
    figure: '',
    since: null,
    title: '',
  };
  const run = {
    kind: 'run',
    id: 'shot-run',
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
    mix: '5 run · 1 edit',
    steps: [
      {
        kind: 'step',
        id: 'shot-failed',
        status: 'failed',
        line: 'Ran',
        code: 'exec',
        figure: 'failed',
        since: null,
        title: 'exec',
      },
      {
        kind: 'step',
        id: 'shot-done',
        status: 'done',
        line: 'Ran',
        code: 'write_stdin',
        figure: '',
        since: null,
        title: 'write_stdin',
      },
    ],
  };
  Object.assign(card, {
    status: 'done',
    statusWord: 'done',
    live: false,
    durationWord: 'ran for',
    durationDetail: '2:22 PM to 2:32 PM',
    activity: which === 'empty' ? [run] : [run, message],
    activityCounts: which === 'empty' ? [] : ['1 message'],
    activityToolCategories: [
      { key: 'commands', label: 'run', count: 5 },
      { key: 'edits', label: 'edit', count: 1 },
    ],
    toolTally: [
      { name: 'exec', count: 5, category: 'commands' },
      { name: 'apply_patch', count: 1, category: 'edits' },
    ],
  });
  payload.cards = [card];
  return payload;
}

// Advance two animation frames. This does not confirm delivery of native browser events.
// Use a string because transpiled functions can reference helpers unavailable inside the page.
export const SETTLED = 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))';

// Use the shared launcher, which orders browsers to avoid the Edge and Chrome Windows sign-in failure.
export async function browserOrNone(): Promise<Browser | null> {
  const { launchAnyBrowser } = await import('../test/browserchannels.mjs');
  return (await launchAnyBrowser({ args: ['--hide-scrollbars'] }))?.browser ?? null;
}

export function firstProjectPayload(draft: boolean): Record<string, unknown> {
  const payload = renderPayload() as {
    cards: Record<string, unknown>[];
    sessions: Record<string, unknown>[];
    rail: Record<string, unknown>[];
    showing: string | null;
    diagnosis: { message: string };
    stats: Record<string, unknown>;
    projectSpend: unknown;
    usage: { composer: unknown; launcher: unknown };
  };
  payload.cards = [];
  payload.projectSpend = null;
  payload.diagnosis = {
    message: draft ? 'Start this session with a prompt.' : 'No sessions in this project yet.',
  };
  if (!draft) {
    payload.sessions = [];
    payload.rail = [];
    payload.showing = null;
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
    return payload;
  }
  const now = FIXTURE_CLOCK;
  payload.sessions = payload.sessions.slice(0, 1).map((session) => ({
    ...session,
    label: 'New session',
    relative: 'just now',
    when: 'Now',
    at: now,
  }));
  payload.rail = payload.rail.slice(0, 1).map((row) => ({
    ...row,
    label: 'New session',
    relative: 'just now',
    absolute: 'Now',
    at: now,
    labels: [],
    labelChips: [],
    labelsMore: 0,
    labelsMoreName: null,
    name: 'New session, Claude, just now, showing now',
  }));
  // An unsubmitted draft has no session figures. Deleting its keyed stats clears the card and heading.
  delete payload.stats.s1;
  payload.showing = 's1';
  return payload;
}

// Deadline for one ImageMagick conversion or comparison.
const CONVERT_TIMEOUT_MS = 60_000;

// Screenshot options shared by Playwright page and element captures.
type ScreenshotOptions = {
  path?: string;
  clip?: { x: number; y: number; width: number; height: number };
  fullPage?: boolean;
};

// Capture PNG, convert it to lossless WebP, and reject any differing pixels.
// The panel-mockup skill has the same helper in a separate repository that the extension cannot import.
export async function writeLosslessWebp(
  target: { screenshot(options: ScreenshotOptions): Promise<Buffer> },
  file: string,
  options: Omit<ScreenshotOptions, 'path'> = {},
): Promise<void> {
  admitPanelShotFile(file);
  const temporary = `${file}.${process.pid}.png`;
  try {
    await target.screenshot({ ...options, path: temporary });
    const converted = spawnSync('magick', [temporary, '-define', 'webp:lossless=true', file], {
      encoding: 'utf8',
      timeout: CONVERT_TIMEOUT_MS,
    });
    if (converted.error || converted.status !== 0) {
      throw new Error(
        `ImageMagick could not write ${file}: ${(converted.error?.message || converted.stderr || '').trim()}`,
      );
    }
    const compared = spawnSync('magick', ['compare', '-metric', 'AE', temporary, file, 'null:'], {
      encoding: 'utf8',
      timeout: CONVERT_TIMEOUT_MS,
    });
    const difference = (compared.stderr || compared.stdout || '').trim();
    if (compared.error || compared.status !== 0 || !/^0(?:\s|$)/.test(difference)) {
      throw new Error(
        `lossless WebP check failed for ${file}: ${(compared.error?.message || difference || 'no result').trim()}`,
      );
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

// Select Rows through the View menu so row layout and relative ages update together. Close the menu before capture.
async function chooseRailDensity(page: Page, density: RailDensity): Promise<void> {
  if (!(await page.locator('#railfilterpop').isVisible())) {
    await page.locator('[data-control="railfilters"]').click();
  }
  await page.locator(`[data-control="raildensity:${density}"]`).click();
  await page.locator('[data-control="railfilters"]').click();
  await page.evaluate(SETTLED);
}

export async function shoot(
  page: Page,
  shot: Shot,
  outDir: string,
  writer: typeof writeLosslessWebp = writeLosslessWebp,
): Promise<void> {
  const file = path.join(outDir, `${shot.name}.webp`);
  if (writer === writeLosslessWebp) {
    admitPanelShotFile(file);
    fs.rmSync(file, { force: true });
  }
  // Clear focus from the preceding capture before applying this state's actions.
  await page.evaluate(`document.activeElement instanceof HTMLElement && document.activeElement.blur()`);
  const escapes = shot.escape === true ? 1 : shot.escape || 0;
  for (let index = 0; index < escapes; index++) {
    await page.keyboard.press('Escape');
    await page.evaluate(SETTLED);
  }
  if (shot.width) {
    await page.setViewportSize({ width: shot.width, height: shot.height ?? 900 });
    await page.evaluate(SETTLED);
  }
  // Save the session list width for restoration after a density capture.
  const railBasis = shot.railDensity
    ? await page.locator('#rail').evaluate((node) => (node as HTMLElement).style.flexBasis)
    : null;
  if (shot.railWidth) {
    const width = await page.locator('#rail').evaluate((node) => node.getBoundingClientRect().width);
    const sash = await page.locator('#railsash').boundingBox();
    if (!sash) {
      throw new Error('the rail sash is unavailable');
    }
    const x = sash.x + sash.width / 2;
    const y = sash.y + sash.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + shot.railWidth - width, y);
    await page.mouse.up();
    await page.evaluate(SETTLED);
  }
  if (shot.railDensity) {
    await chooseRailDensity(page, shot.railDensity);
  }
  if (shot.railFilterPreset) {
    if (!(await page.locator('#railfilterpop').isVisible())) {
      await page.locator('[data-control="railfilters"]').click();
    }
    await page.locator(`[data-control="railfilterpick:${shot.railFilterPreset}"]`).click();
    // Selecting a saved filter leaves the View menu open. Close it before applying the requested menu state.
    await page.locator('[data-control="railfilters"]').click();
    await page.evaluate(SETTLED);
  }
  if (shot.railFilterPicker) {
    const open = await page.locator('#railfilterpop').isVisible();
    if (open !== (shot.railFilterPicker === 'open')) {
      await page.locator('[data-control="railfilters"]').click();
      await page.evaluate(SETTLED);
    }
  }
  if (shot.stats !== undefined) {
    const payload = shot.stats ? statPopoverPayload(shot.subagentContext) : renderPayload();
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
  }
  if (shot.pinned) {
    const pinned = renderPayload(
      [],
      [],
      [],
      [],
      [],
      [shot.pinned],
      SHOT_STATUSES,
      SHOT_RUNNING_SINCE,
      [],
      SHOT_OPEN_CHILDREN,
    ) as { stats: Record<string, unknown> };
    // The pinned-session fixture has cost, turns, and context figures.
    // Its cost has a partial-total warning, and its context is near the limit.
    pinned.stats = {
      ...pinned.stats,
      [shot.pinned]: [
        {
          metric: 'cost',
          compactLabel: '$12.40+',
          kind: 'plain',
          label: '$12.40+',
          detail: 'Some usage could not be priced in 2 of 41 turns, so the estimated total may be low.',
          partialDetail: 'Some usage could not be priced in 2 of 41 turns, so the estimated total may be low.',
          warnings: [{ scope: 'main' }],
        },
        { metric: 'turns', compactLabel: '41 turns', kind: 'plain', label: '41 turns', detail: '' },
        {
          metric: 'context',
          compactLabel: '93% ctx',
          kind: 'plain',
          label: '93% of 200k ctx (186k)',
          level: 'nearlyFull',
          detail: '',
        },
      ],
    };
    await page.evaluate(`window.postMessage(${JSON.stringify(pinned)}, '*')`);
    await page.evaluate(SETTLED);
  }
  if (shot.state) {
    await page.evaluate(
      `window.postMessage(${JSON.stringify(firstProjectPayload(shot.state === 'first-project-draft'))}, '*')`,
    );
    await page.evaluate(SETTLED);
  }
  if (shot.openCustom) {
    await page.evaluate("window.postMessage({ type: 'openLauncher', custom: true }, '*')");
    await page.evaluate(SETTLED);
  }
  if (shot.launcherPins !== undefined) {
    const payload =
      shot.launcherPins === 'unavailable'
        ? launcherPinsPayload(1, { unavailable: true })
        : launcherPinsPayload(shot.launcherPins);
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
  }
  if (shot.draft) {
    await page.evaluate(`window.postMessage(${JSON.stringify(draftRenderPayload())}, '*')`);
    await page.evaluate(SETTLED);
  }
  if (shot.longName) {
    await page.evaluate(`window.postMessage(${JSON.stringify(longNamePayload())}, '*')`);
    await page.evaluate(SETTLED);
  }
  if (shot.unsent) {
    await page.evaluate(`window.postMessage(${JSON.stringify(unsentPayload())}, '*')`);
    await page.evaluate(SETTLED);
  }
  if (shot.subagents) {
    await page.evaluate(`window.postMessage(${JSON.stringify(subagentsPayload())}, '*')`);
    await page.evaluate(SETTLED);
  }
  if (shot.asks) {
    await page.evaluate(`window.postMessage(${JSON.stringify(asksPayload(shot.asks))}, '*')`);
    await page.evaluate(SETTLED);
  }
  if (shot.files) {
    await page.evaluate(
      `window.postMessage(${JSON.stringify(renderPayload([], [], [], [], [], [], new Map(), new Map(), ATTACHMENT_ASSETS))}, '*')`,
    );
    await page.evaluate(SETTLED);
  }
  if (shot.waiting) {
    await page.evaluate(`window.postMessage(${JSON.stringify(waitingPayload())}, '*')`);
    await page.evaluate(SETTLED);
  }
  if (shot.activity) {
    await page.evaluate(`window.postMessage(${JSON.stringify(activityPayload(shot.activity))}, '*')`);
    await page.evaluate(SETTLED);
    if (await page.locator('#railfilterpop').isVisible()) {
      await page.locator('[data-control="railfilters"]').click();
      await page.evaluate(SETTLED);
    }
    await page.evaluate(`(() => {
      const head = document.querySelector('#list .turn .head');
      if (head && head.getAttribute('aria-expanded') === 'false') head.click();
    })()`);
    await page.evaluate(SETTLED);
  }
  if (shot.compactionSummary) {
    await page.evaluate(`window.postMessage(${JSON.stringify(compactionSummaryPayload())}, '*')`);
    await page.evaluate(SETTLED);
    if (shot.compactionSummary === 'expanded') {
      await page.locator('section.compaction .head').first().click();
      await page.evaluate(SETTLED);
    }
  }
  if (shot.cacheWriteWarning || shot.costOverheads || shot.waitWarning) {
    // Clear the session list query a preceding capture left, open or closed, so the list draws
    // the fixture's session. The clear control also closes the box.
    if (await page.locator('[data-control="railsearch"]').isVisible()) {
      await page.locator('[data-control="railsearch"]').click();
      await page.evaluate(SETTLED);
    }
    if (await page.locator('[data-control="railclear"]').isVisible()) {
      await page.locator('[data-control="railclear"]').click();
      await page.evaluate(SETTLED);
    }
  }
  if (shot.cacheWriteWarning) {
    await page.evaluate(`window.postMessage(${JSON.stringify(cacheWriteWarningPayload())}, '*')`);
    await page.evaluate(SETTLED);
  }
  if (shot.costOverheads) {
    const payload = costOverheadsPayload(shot.costOverheads === 'delegated');
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
  }
  if (shot.waitWarning) {
    const delegated = shot.waitWarning === 'five' ? 'five' : 'three';
    const payload = waitWarningPayload(delegated, shot.waitWarningTurnAgents ?? false, !shot.waitWarningNoChildTools);
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
  }
  if (shot.remoteControl) {
    await page.evaluate(`window.postMessage(${JSON.stringify(withRemoteControl(renderPayload()))}, '*')`);
    await page.evaluate(SETTLED);
  }
  if (shot.composerSkill) {
    const payload = renderPayload();
    const composer = (payload.usage as { composer: Record<string, unknown> }).composer;
    composer.agent = 'codex';
    composer.draft = 'Use /land to merge this change after review.';
    composer.commands = [
      {
        kind: 'skill',
        command: 'land',
        prefix: '/',
        label: '/land',
        hint: '',
        description: 'Land one reviewed change',
        path: 'C:\\Users\\reader\\.agents\\skills\\land\\SKILL.md',
        name: '/land. Land one reviewed change',
        completion: '/land ',
      },
    ];
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.locator('#prompt').fill('Use /land to merge this change after review.');
    await page.evaluate(SETTLED);
  }
  if (shot.nextTurn) {
    const payload = nextTurnPayload(shot.nextTurn);
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
  }
  if (shot.railCount) {
    await page.locator(`[data-control="railcount:${shot.railCount}"]`).click();
    await page.evaluate(SETTLED);
  }
  if (shot.headCounts) {
    // Unread, waiting, and running fixtures populate all four session list header counts alongside active sessions.
    const payload = renderPayload() as { rail: Record<string, unknown>[] };
    const idle = payload.rail.findIndex((card, index) => index > 3 && !card.status);
    payload.rail = payload.rail.map((card, index) =>
      index < 3
        ? { ...card, unread: true }
        : index === 3
          ? { ...card, status: 'waiting' }
          : index === idle
            ? { ...card, status: 'running' }
            : card,
    );
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
  }
  if (shot.railHeadUntick) {
    // Open the View menu only when it is closed.
    const funnel = page.locator('[data-control="railfilters"]');
    if ((await funnel.getAttribute('aria-expanded')) !== 'true') {
      await funnel.click();
    }
    await page.evaluate(SETTLED);
    await page.locator(`[data-control="railheadlens:${shot.railHeadUntick}"]`).click();
    await page.evaluate(SETTLED);
  }
  if (shot.railLens) {
    // Mark the first three fixture sessions unread so the Unread lens has sessions to count.
    const payload = renderPayload() as { rail: Record<string, unknown>[] };
    payload.rail = payload.rail.map((card, index) => (index < 3 ? { ...card, unread: true } : card));
    await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
    await page.evaluate(SETTLED);
    await page.locator('[data-control="railfilters"]').click();
    await page.locator(`[data-control="raillens:${shot.railLens}"]`).click();
    await page.keyboard.press('Escape');
    await page.evaluate(SETTLED);
  }
  if (shot.filter) {
    // Open the filter box before typing.
    if (!(await page.locator('.railfilter').count())) {
      await page.locator('[data-control="railsearch"]').click();
      await page.evaluate(SETTLED);
    }
    // Type into the filter box to move the caret and trigger suggestions for its current word.
    await page.locator('.railfilter').first().click();
    await page.keyboard.type(shot.filter);
    await page.evaluate(SETTLED);
  }
  if (shot.raisedComposer) {
    await page.locator('#footsash').focus();
    for (let line = 0; line < 7; line++) {
      await page.locator('#footsash').press('ArrowUp');
    }
    await page.evaluate(SETTLED);
  }
  if (shot.layout) {
    await page.evaluate(
      `window.postMessage(${JSON.stringify({ ...renderPayload(), timelineLayout: shot.layout })}, '*')`,
    );
    await page.evaluate(SETTLED);
  }
  if (shot.openCard) {
    // Press only closed card headings. A second press closes a card retained from the preceding capture.
    await page.evaluate(`(() => {
      const head = document.querySelector(${JSON.stringify(shot.openCard)});
      if (head && head.getAttribute('aria-expanded') === 'false') { head.click(); }
    })()`);
    await page.evaluate(SETTLED);
  }
  if (shot.click) {
    try {
      const agentPick = /launch-agent:(claude|codex)/.exec(shot.click);
      if (agentPick) await page.locator('#launcher [data-control="launch-agent"]').click();
      const target = page.locator(agentPick ? `[data-control="launch-agent:${agentPick[1]}"]` : shot.click).first();
      if (shot.composerSkill) {
        const box = await target.boundingBox({ timeout: 5_000 });
        if (!box) {
          throw new Error('the Composer skill mark has no box');
        }
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      } else {
        await target.click({ timeout: 5_000 });
      }
    } catch (error) {
      console.log(`${shot.name}.webp not written: ${shot.click}: ${String(error)}`);
      return;
    }
    await page.evaluate(SETTLED);
  }
  if (shot.costTab) {
    // Select the tab from the keyboard, as a reader moves along the strip.
    const tabs = ['Usage', 'Tools'];
    await page.locator('.chippop.pinned .poptabs [aria-selected="true"]').focus({ timeout: 5_000 });
    for (let at = 0; at < tabs.indexOf(shot.costTab); at++) await page.keyboard.press('ArrowRight');
    // Return focus to the pinned figure, where the other cost captures hold it. The tab stays selected.
    if (shot.click) await page.locator(shot.click).first().focus();
    await page.evaluate(SETTLED);
  }
  if (shot.costHover) {
    // Release the focus an earlier capture left on the figure first. The blur before capture would
    // otherwise close the popover that focus opened.
    await page.evaluate('document.activeElement instanceof HTMLElement && document.activeElement.blur()');
    try {
      await page.locator(shot.costHover).first().hover({ timeout: 5_000 });
      await page.locator('.chippop:not([hidden]) .split').first().waitFor({ timeout: 5_000 });
    } catch (error) {
      console.log(`${shot.name}.webp not written: ${shot.costHover}: ${String(error)}`);
      return;
    }
    await page.evaluate(SETTLED);
  }
  if (shot.hover) {
    try {
      await page.locator(shot.hover).first().hover({ timeout: 5_000 });
    } catch {
      console.log(`${shot.name}.webp not written: nothing on the page matches ${shot.hover}`);
      return;
    }
    // Wait for the hint itself because hover delay varies by platform and target.
    try {
      await page.waitForFunction(() => document.getElementById('hintpop')?.hidden === false, undefined, {
        timeout: 5_000,
      });
    } catch {
      console.log(`${shot.name}.webp not written: no hint opened over ${shot.hover}`);
      return;
    }
    await page.evaluate(SETTLED);
  }
  if (shot.labels) {
    // The label editor waits for host-owned rows. Supply its reply after the control sends its request.
    const row = page.locator('.railrow').first();
    const session = (await row.locator('.railcard').getAttribute('data-session')) ?? '';
    const title = await row.locator('.railname').innerText();
    const answer = {
      type: 'labelEditor',
      session,
      heading: `${CARD_ACTIONS.labelHeading} ${title}`,
      rows: labelEditorRows(SHOT_LABELS, session),
    };
    await page.evaluate(`window.postMessage(${JSON.stringify(answer)}, '*')`);
    await page.evaluate(SETTLED);
  }
  if (shot.labelTyped) {
    await page.locator('.labelfind').click();
    await page.keyboard.type(shot.labelTyped);
    await page.evaluate(SETTLED);
  }
  if (shot.rename) {
    // Right-click establishes the rename target. The host message opens the editor with the full session name.
    const node = page.locator(shot.rename === 'heading' ? '.sessionrow .session' : '.railrow .railcard').first();
    const named = await node.evaluate((element) => ({
      session: element.closest<HTMLElement>('[data-session]')?.dataset.session ?? '',
      title: element.querySelector('.name, .railname')?.textContent ?? '',
    }));
    await node.evaluate((element) => {
      element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'openSessionRename', ...named })}, '*')`);
    await page.evaluate(SETTLED);
  }
  if (shot.details) {
    const row = page.locator('.sessionrow').first();
    const session = (await row.getAttribute('data-session')) ?? '';
    await row.evaluate((node) => {
      node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    await row.evaluate((node) => {
      node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    await page.evaluate(`window.postMessage(${JSON.stringify({ type: 'showSessionDetails', session })}, '*')`);
    await page.evaluate(SETTLED);
  }
  // Supply provider-specific context detail for the prompt box popover.
  if (shot.contextDetail) {
    const provider = shot.contextDetail.startsWith('claude') ? 'claude' : 'codex';
    const payload = renderPayload();
    const composer = (payload.usage as { composer: any }).composer;
    composer.agent = provider;
    composer.context = { ...composer.context, used: 10_100, capacity: 20_000, generation: 1 };
    await page.evaluate((message) => window.postMessage(message, '*'), payload);
    await page.evaluate(SETTLED);
    await page.locator('#prompt').focus();
    await page.locator('.cctx').focus();
    const request = await page.evaluate<{ request: number; generation: number }>(
      'window.__posted.filter(m => m.type === "contextDetail").at(-1)',
    );
    let raw: unknown;
    if (provider === 'codex') {
      const records = codexContextRecords('s1', shot.contextDetail === 'codex-compacted');
      if (shot.contextDetail === 'codex-compacted')
        records.at(-1)!.payload.info.last_token_usage = { input_tokens: 0, output_tokens: 0, total_tokens: 10_100 };
      raw = estimateCodexContext(records, 's1');
    } else
      raw = {
        totalTokens: 10_100,
        rawMaxTokens: 20_000,
        model: 'claude-opus-5-5',
        categories: [
          { name: 'Messages', kind: 'used', tokens: 7_000 },
          { name: 'System tools', kind: 'used', tokens: 2_000 },
          { name: 'System prompt', kind: 'used', tokens: 1_100 },
          { name: 'Free space', kind: 'free', tokens: 7_000 },
          { name: 'Compaction reserve', kind: 'buffer', tokens: 2_900 },
        ],
      };
    const identity: ContextIdentity = { session: 's1', provider, model: '', source: 'capture', ...request };
    const detail =
      shot.contextDetail === 'claude-unavailable'
        ? { ...unavailableContext({ ...identity, source: '' }), reason: 'claude-no-live-session' as const }
        : normalizeContext(raw, identity);
    await page.evaluate((message) => window.postMessage(message, '*'), { type: 'contextDetail', detail });
    await page.evaluate(SETTLED);
  }
  await page.waitForTimeout(100);
  await page.evaluate(SETTLED);
  if (!shot.hover && !shot.costHover) {
    await page.mouse.move(0, 0);
  }
  await page.evaluate(`
    document.activeElement instanceof HTMLElement && document.activeElement.blur();
    document.querySelectorAll('.turn').forEach((card) => card.classList.add('is-read'));
  `);
  await page.evaluate(SETTLED);
  if (shot.focus) {
    await page.locator(shot.focus).first().focus();
    await page.evaluate(SETTLED);
  }
  if (shot.costHover && !(await page.locator('.chippop:not([hidden]):not(.pinned) .split').first().isVisible())) {
    console.log(`${shot.name}.webp not written: the hover popover over ${shot.costHover} closed before capture`);
    return;
  }
  const viewport = page.viewportSize();
  const element = shot.clip ? await page.locator(shot.clip).first().boundingBox() : null;
  await writer(page, file, {
    clip: element
      ? {
          x: element.x,
          y: element.y,
          width: element.width,
          height: shot.clipWhole ? element.height : Math.min(element.height, 140),
        }
      : viewport
        ? { x: 0, y: 0, width: viewport.width - 13, height: viewport.height }
        : undefined,
  });
  console.log(file);
  if (shot.raisedComposer) {
    await page.locator('#footsash').press('Home');
    await page.evaluate(SETTLED);
  }
  if (shot.labels || shot.hover || shot.costHover) {
    // Move the pointer away so later captures omit session list row hover controls.
    await page.mouse.move(0, 0);
    await page.evaluate(SETTLED);
  }
  // Restore the session list width before redrawing the prompt box.
  if (railBasis !== null) {
    await page.locator('#rail').evaluate((node, basis) => {
      (node as HTMLElement).style.flexBasis = basis;
    }, railBasis);
    await page.evaluate(SETTLED);
  }
  // Restore the default payload after captures that replace its layout, sessions, or prompt box state.
  if (
    shot.layout ||
    shot.pinned ||
    shot.longName ||
    shot.railLens ||
    shot.launcherPins !== undefined ||
    shot.contextDetail ||
    shot.remoteControl
  ) {
    await page.evaluate(`window.postMessage(${JSON.stringify(renderPayload())}, '*')`);
    await page.evaluate(SETTLED);
  }
  if (shot.railDensity && shot.railDensity !== 'comfortable') {
    await chooseRailDensity(page, 'comfortable');
  }
  if (shot.after) {
    try {
      await page.locator(shot.after).first().click({ timeout: 5_000 });
      await page.evaluate(SETTLED);
    } catch {
      console.log(`${shot.name}.webp kept the state it opened: nothing matches ${shot.after}`);
    }
  }
}

// Light Modern captures append `-light` to the filename. Dark Modern captures keep the base name.
function shotFor(shot: Shot, kind: 'dark' | 'light'): Shot {
  return kind === 'light' ? { ...shot, name: `${shot.name}-light` } : shot;
}

// Inspect ancestors before launch without opening redirected directories.
export function panelShotDestination(
  destination: string,
  cwd = process.cwd(),
  platform: NodeJS.Platform = process.platform,
  inspect: (file: string) => Pick<fs.Stats, 'isSymbolicLink' | 'isDirectory'> = fs.lstatSync,
): string {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const resolved = paths.resolve(cwd, destination);
  const root = paths.parse(resolved).root;
  const segments = resolved.slice(root.length).split(paths.sep);
  if (
    segments.some(
      (segment, index) => segment.toLowerCase() === '.claude' && segments[index + 1]?.toLowerCase() === 'plans',
    )
  ) {
    throw new Error('Plan screenshots require --owner PLAN --run RUN --reservation BYTES [--shots NAMES]');
  }
  let ancestor = root;
  for (const segment of ['', ...segments]) {
    ancestor = paths.join(ancestor, segment);
    try {
      const stat = inspect(ancestor);
      if (stat.isSymbolicLink()) throw new Error(`Screenshot destination contains a redirect: ${ancestor}`);
      if (!stat.isDirectory()) throw new Error(`Screenshot destination is not a directory: ${ancestor}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  return resolved;
}

function admitPanelShotFile(file: string): void {
  panelShotDestination(path.dirname(file));
  try {
    if (fs.lstatSync(file).isSymbolicLink()) {
      throw new Error(`Screenshot destination contains a redirect: ${file}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

type BoundedCapture = (argv: string[]) => Promise<void>;

export async function loadBoundedPanelCapture(
  file = path.join(__dirname, '../../.claude/plans/2026-10-07-plan-artifact-prevention/panel_capture.mjs'),
): Promise<BoundedCapture> {
  if (!fs.existsSync(file)) throw new Error(`Bounded panel capture adapter is unavailable: ${file}`);
  const adapter = await import(pathToFileURL(file).href);
  if (typeof adapter.capturePanel !== 'function')
    throw new Error(`Bounded panel capture entry point is unavailable: ${file}`);
  return adapter.capturePanel;
}

export async function runPanelShots(
  argv: string[],
  loadCapture: () => Promise<BoundedCapture> = loadBoundedPanelCapture,
  captureLegacy: (outDir: string) => Promise<void> = capturePanelMatrix,
): Promise<void> {
  if (argv.some((value) => value.startsWith('-'))) {
    const flags = new Set<string>();
    for (let index = 0; index < argv.length; index += 2) {
      const flag = argv[index];
      const value = argv[index + 1];
      if (
        !['--owner', '--run', '--reservation', '--shots'].includes(flag) ||
        flags.has(flag) ||
        !value ||
        value.startsWith('--')
      ) {
        throw new Error('Use --owner PLAN --run RUN --reservation BYTES [--shots NAMES]');
      }
      flags.add(flag);
    }
    if (!['--owner', '--run', '--reservation'].every((flag) => flags.has(flag))) {
      throw new Error('Owner, run and byte reservation are required');
    }
    const capture = await loadCapture();
    await capture(argv);
    return;
  }
  if (argv.length > 1) throw new Error('Use one screenshot directory or complete plan capture options');
  const outDir = panelShotDestination(argv[0] ?? path.join(__dirname, '..', 'shots'));
  await captureLegacy(outDir);
}

async function capturePanelMatrix(outDir: string): Promise<void> {
  const browser = await browserOrNone();
  if (!browser) {
    console.log('No Edge, Chrome or bundled Chromium on this machine, so no pictures were written.');
    return;
  }
  const errors: string[] = [];
  try {
    fs.mkdirSync(outDir, { recursive: true });
    // Use a fresh page for each theme. Repeating setContent redeclares SAVED_STATE in the same document and throws.
    for (const kind of ['dark', 'light'] as const) {
      const page = await browser.newPage({
        viewport: { width: 1350, height: 900 },
        deviceScaleFactor: 2,
      });
      let currentShot = 'initial panel';
      page.on('pageerror', (e) => errors.push(`${currentShot}: ${String(e)}`));
      // Fix Date.now while browser timers continue, keeping time labels stable between captures.
      await page.clock.setFixedTime(FIXTURE_CLOCK);
      const initialPayload = renderPayload() as { cards: Array<{ key: string }> };
      const savedState = JSON.stringify({ read: initialPayload.cards.map((card) => card.key) });
      const html = pageHtml().replace('const SAVED_STATE = {};', `const SAVED_STATE = ${savedState};`);
      await page.setContent(themed(html, kind));
      await page.addStyleTag({
        content: `
        *, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }
        html, body, * { scrollbar-width: none !important; }
        ::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
      `,
      });
      await page.evaluate(SETTLED);
      await writeLosslessWebp(page, path.join(outDir, `startup-no-payload-${kind}.webp`));
      await page.evaluate((payload) => window.postMessage(payload, '*'), {
        ...initialPayload,
        cards: [],
        diagnosis: newestTurnLoading('Selected session', false).diagnosis,
      });
      await page.evaluate(SETTLED);
      await writeLosslessWebp(page, path.join(outDir, `startup-rail-ready-${kind}.webp`));
      await page.evaluate(`window.postMessage(${JSON.stringify(initialPayload)}, '*')`);
      await page.evaluate(SETTLED);
      await writeLosslessWebp(page, path.join(outDir, `startup-first-card-${kind}.webp`));
      for (const shot of SHOTS) {
        const themedShot = shotFor(shot, kind);
        currentShot = themedShot.name;
        await shoot(page, themedShot, outDir);
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
  if (errors.length) {
    console.log('The panel threw while drawing:');
    for (const error of errors) {
      console.log(`  ${error}`);
    }
  }
}

if (require.main === module) {
  runPanelShots(process.argv.slice(2)).catch((error) => {
    console.error(error);
    if (process.exitCode !== 130) process.exitCode = 1;
  });
}
