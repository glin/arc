// Pictures of the real panel, one per state worth looking at.
//
// `panel.layout.test.ts` measures the same page and says nothing about how it looks: a
// column can sit exactly where the guard wants it and still read as a wall of grey. This
// renders that page in a browser, dresses it in the editor's dark theme, presses the controls
// that open the panel's popovers, and writes a lossless WebP of each.
//
// Run it from the extension directory:
//
//     npx tsx scripts/panel-shots.ts [outDir]
//
// It drives a browser already on the machine and downloads nothing. With none installed it
// says so and writes no files.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { estimateCodexContext } from '../src/codexcontext.ts';
import { normalizeContext } from '../src/domain/context-detail.ts';
import { codexContextRecords } from '../src/turnfixtures.ts';
import { chromium } from 'playwright-core';
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
  nextTurnPayload,
  pageHtml,
  renderPayload,
  statPopoverPayload,
  themed,
} from '../src/panelfixture.ts';
import type { RailStatus } from '../src/turnrail.ts';
import type { RailDensity } from '../src/view/rail.ts';
import { toCard } from '../src/turncard.ts';

// The states, in the order they are taken. Each one starts from what the last one left on
// screen, so a state that needs a clean page asks for `escape` first. Add a row here to add a
// picture.
export interface Shot {
  contextDetail?: 'claude' | 'codex' | 'codex-compacted';
  name: string; // the file, without the extension
  width?: number; // move the viewport to this width first
  height?: number; // and to this height, for a state taller than the ordinary viewport
  openCard?: string; // press this card head, and only when the card is shut
  layout?: { cardLayout: string; promptPosition: string }; // draw with this Timeline layout, then put the default back
  railWidth?: number; // draw the rail at this saved width
  railDensity?: RailDensity; // choose this Rows value in the View menu, then put comfortable and the rail width back
  pinned?: string; // post the rail in its coloured states with this session pinned, then put the plain page back
  railFilterPreset?: string; // load this saved-filter id before the picture
  railFilterPicker?: 'open' | 'closed'; // set the saved-filter picker state
  escape?: boolean | number; // close whatever popover is open before pressing anything
  click?: string; // the control to press
  hover?: string; // the control to hover until its delayed hint opens
  after?: string; // the control to press once the picture is taken, so no state carries
  state?: 'first-project-empty' | 'first-project-draft';
  openCustom?: boolean;
  stats?: boolean;
  draft?: boolean; // aim the composer at a draft first, by posting the draft render
  unsent?: boolean; // post a rail card with unfinished reader input
  subagents?: boolean; // post the rail and the long card with background subagents still at work
  // Post the page with live requests: `true` is the permission and the one-question card,
  // `three` is the tabbed card, and `six` is the strip that runs past two rows.
  asks?: boolean | 'three' | 'six';
  files?: boolean; // aim the composer at the attachment fixture
  waiting?: boolean; // draw a locally queued attachment above a running compaction
  labels?: boolean; // answer the label editor's ask, so the popover the press opened fills
  details?: boolean; // open session details through the host-message path
  rename?: 'heading' | 'rail'; // right-click the first session heading or rail card, then answer Rename session
  filter?: string; // type this into the rail's filter box first
  railCount?: 'active'; // press this rail head count first
  railLens?: 'unread' | 'input'; // press this Filter value in the View menu, then close the menu
  headCounts?: boolean; // post running, unread, waiting and active sessions so the head draws all four counts
  railHeadUntick?: 'active' | 'unread' | 'input'; // open the View menu and untick this Quick filters box
  clip?: string; // picture only the top of this element, not the whole viewport
  clipWhole?: boolean; // picture all of the clip element, not only its top
  focus?: string; // keep this control focused in the capture
  nextTurn?: 'warm' | 'cold' | 'no-tier' | 'compacted'; // draw the line above the box in this cache state
  activity?: 'messages' | 'empty' | 'all' | 'breakdown';
  compactionSummary?: 'collapsed' | 'expanded';
  cacheWriteWarning?: boolean;
  composerSkill?: boolean;
  raisedComposer?: boolean;
  launcherPins?: number | 'unavailable'; // post the New session menu with this many pinned setups beside ten recent ones
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

// The one pressable part of the line above the box, on whichever face the clock is showing.
const NEXT_TURN_PRICE = '.cnextturnface:not(.is-off) .cnextturnprice';

// What the workspace has filed, for the label editor's picture. The extension owns the record
// and the panel asks for it, so a page with no extension behind it answers the ask from here.
// It names what the rail fixture files, so the popover and the chips on the cards agree.
const SHOT_LABELS: Record<string, string[]> = {
  s1: ['composer', 'release 0.4', 'perf'],
  s2: ['release 0.4'],
  s4: ['worktree parallel sessions and the rails'],
};

// The head that opens the long fixture turn, found by the key the timeline writes onto its
// card rather than by counting cards, so a card added above it moves nothing here.
const LONG_CARD_HEAD = `#list [data-key="${turnKey(FIXTURE_TURNS[LONG_TURN_INDEX])}"] h3.cardheading button.head`;
const LONG_CARD_FILES_CHIP = `#list [data-key="${turnKey(FIXTURE_TURNS[LONG_TURN_INDEX])}"] .statchip[data-metric="files"]`;
const LONG_CARD_AGENTS_CHIP = `#list [data-key="${turnKey(FIXTURE_TURNS[LONG_TURN_INDEX])}"] .statchip[data-metric="agents"]`;

export const SHOTS: Shot[] = [
  { name: 'wide', width: 1350 },
  ...(['claude', 'codex', 'codex-compacted'] as const).flatMap((contextDetail) =>
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
  // The card a compact row opens on hover, at the default rail width and at the rail's
  // minimum width, where the card crosses the rail edge over the session view. The first hovers
  // the pinned session, and the comfortable shot after it draws that session's row from the same
  // payload, so the hover's figure line compares against the row's own.
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
  { name: 'wide-session-heading-hint', width: 1350, hover: '.session' },
  { name: 'wide-rail-hint', hover: '.railrow .railhide' },
  { name: 'wide-launcher-menu-hint', hover: '#rail .railnewmenu' },
  { name: 'wide-project-cost', click: '.projectspendrailhost .projectspendbutton' },
  {
    name: 'wide-project-cost-pricing',
    click: '#projectspendpop [data-control="projectspend:pricing"]',
    after: '#projectspendpop [data-control="projectspend:pricing"]',
  },
  { name: 'wide-launcher', escape: true, click: '#rail .railnewmenu' },
  // The custom fields on the menu's own page, with an agent whose catalog differs.
  { name: 'wide-launcher-codex', click: '#launcher [data-control="launch-agent:codex"]' },
  { name: 'wide-label-editor', escape: 2, click: '.railrow .raillabelact', labels: true },
  { name: 'wide-details', escape: 2, details: true },
  // The heading's own label line, and the editor opened from the button that closes it. One
  // picture answers both halves: the chips the session carries, drawn where the reader
  // is actually reading it, and where the popover lands when the press is made there rather
  // than on the rail.
  { name: 'wide-session-labels', escape: true, click: '.sessionlabels .sessionlabelact', labels: true },
  // The session rename editor, opened from each place that offers it. Cancel closes it after
  // the picture, because the page blurs focus before it shoots and Escape then reaches nothing.
  { name: 'wide-session-rename', escape: true, rename: 'heading', after: '[data-control="session-rename-cancel"]' },
  { name: 'wide-rail-session-rename', escape: true, rename: 'rail', after: '[data-control="session-rename-cancel"]' },
  // The list the filter box offers while a `label:` term is being typed. The rail behind it
  // is whole: a `label:` word with nothing after it pushes no term, so the query narrows
  // nothing until the reader takes a name off the list.
  { name: 'wide-filter-offers', escape: true, filter: 'label:', after: '.filterclear' },
  { name: 'mid', width: 640, escape: true },
  { name: 'narrow', width: 340 },
  // The open card of the long fixture turn, whole, at the three widths the density plan
  // measures. The viewport is taller than the ordinary one because the card is: a picture
  // clipped at 900px would leave the last sections out and argue about the wrong card.
  { name: 'wide-long-card', width: 1350, height: 1650, escape: true, openCard: LONG_CARD_HEAD },
  { name: 'mid-long-card', width: 640, height: 1950, openCard: LONG_CARD_HEAD },
  // The Files chip pinned on the same card, which is where that turn's file record now
  // lives. The rows and the press under them are what the picture is taken for.
  { name: 'wide-long-card-files', width: 1350, height: 1650, openCard: LONG_CARD_HEAD, click: LONG_CARD_FILES_CHIP },
  // The Subagents chip pinned on the same card, at both widths, for the subagent rows.
  { name: 'wide-long-card-agents', width: 1350, height: 1650, openCard: LONG_CARD_HEAD, click: LONG_CARD_AGENTS_CHIP },
  // The hover of the first linked row in that popover, which is where the child's cost by
  // usage and its commits are read. It opens the popover for itself, so its picture does not
  // depend on the shot above it still being above it.
  {
    name: 'wide-long-card-agent-hint',
    width: 1350,
    height: 1650,
    escape: true,
    openCard: LONG_CARD_HEAD,
    click: LONG_CARD_AGENTS_CHIP,
    hover: '#chippop .agentrow .namelink',
  },
  // The narrow one closes the popover the wide one left open first. A press on a chip whose
  // popover is already open shuts it, and the picture then held the card with no rows in it.
  {
    name: 'narrow-long-card-agents',
    width: 340,
    height: 2650,
    escape: true,
    openCard: LONG_CARD_HEAD,
    click: LONG_CARD_AGENTS_CHIP,
  },
  // The same card and the rail once the main agent finished while two subagents still work,
  // with the rail card's hint open.
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
  // The same card under each other value of the two Timeline layout settings.
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
  // The Timeline layout dialog open under the session heading's gear.
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
  // The last of the three puts the card back, so no picture after it carries an open card.
  { name: 'narrow-long-card', width: 340, height: 2450, escape: true, openCard: LONG_CARD_HEAD, after: LONG_CARD_HEAD },
  { name: 'wide-composer-skill', width: 1350, escape: true, composerSkill: true, click: '.cskilltoken' },
  { name: 'narrow-composer-skill', width: 340, escape: true, composerSkill: true, click: '.cskilltoken' },
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
  // The rail head at rest at its default width, then with the box open over the words an
  // Active press wrote. The cross after the second picture clears the words and closes the box.
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
  // The same open box at a wide rail, where the box, the cross, the funnel and the New split share
  // one line, then at the default rail width, where the New split keeps the top line and the box
  // takes the next with the cross and the funnel in its right end.
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
  // The rail head at rest and with Active pressed, at a wide rail, at the default and between.
  // Each picture holds only the top of the rail, so the counts' widths and wrap read at a glance.
  // The resting head holds running, unread, waiting and active sessions, so it draws all four counts.
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
  // The Project cost box opens from the rail head. The box floats past the
  // rail's edge, so the picture holds the whole viewport.
  ...[480, RAIL_WIDTH_DEFAULT].map((railWidth): Shot => ({
    name: `rail-cost-open-${railWidth}`,
    width: 1350,
    escape: true,
    railWidth,
    click: '.projectspendrailhost .projectspendbutton',
    after: '.projectspendrailhost .projectspendbutton',
  })),
  // The whole rail at rest at the wide, default and minimum widths, so the head, the list and
  // the Project cost row read together.
  ...[480, RAIL_WIDTH_DEFAULT, RAIL_WIDTH_MIN].map((railWidth): Shot => ({
    name: `rail-whole-resting-${railWidth}`,
    width: 1350,
    escape: true,
    railWidth,
    headCounts: true,
    clip: '#rail',
    clipWhole: true,
  })),
  // The rail head under the Unread lens names the lens, pressed, at the default width and the
  // minimum. The press after each picture clears the lens.
  ...[RAIL_WIDTH_DEFAULT, RAIL_WIDTH_MIN].map((railWidth): Shot => ({
    name: `rail-head-unread-${railWidth}`,
    width: 1350,
    escape: true,
    railWidth,
    railLens: 'unread',
    clip: '#rail',
    after: '[data-control="railcount:unread"]',
  })),
  // The View menu open over the Unread lens, so the Filter row shows its checked value and
  // any lens at zero.
  {
    name: 'rail-lens-menu-open',
    width: 1350,
    escape: true,
    railWidth: RAIL_WIDTH_DEFAULT,
    railLens: 'unread',
    click: '[data-control="railfilters"]',
    after: '[data-control="raillens:all"]',
  },
  // The View menu open on the Filter section with Needs input unticked on the Quick filters
  // line. The press after the picture ticks it again.
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
  // A short narrow panel, where the list of setups shrinks before the menu scrolls.
  ...([0, 4, 16, 'unavailable'] as const).map((pins): Shot => ({
    name: `narrow-short-launcher-pins-${pins}`,
    width: 340,
    height: 360,
    escape: true,
    launcherPins: pins,
    click: '.controls .compactnewmenu',
  })),
  // A tall panel, where the list of setups grows with the viewport up to the menu's cap.
  {
    name: 'wide-tall-launcher-pins-16',
    width: 1200,
    height: 1000,
    escape: true,
    launcherPins: 16,
    click: '#rail .railnewmenu',
  },
  // A pinned row under the pointer, which lights as one row with its pin.
  {
    name: 'wide-tall-launcher-pinned-hover',
    width: 1200,
    height: 1000,
    escape: true,
    launcherPins: 4,
    click: '#rail .railnewmenu',
    hover: '#launcher .launchentry .launchpin.is-pinned',
  },
  // Unpin under the pointer on a pinned row that cannot start, which leaves the row unlit.
  {
    name: 'wide-tall-launcher-unavailable-hover',
    width: 1200,
    height: 1000,
    escape: true,
    launcherPins: 'unavailable',
    click: '#rail .railnewmenu',
    hover: '#launcher .launchentry.is-unavailable [data-control^="launchpin:"]',
  },
  // Edit on that row, which loads its values and names the one the catalog lacks.
  {
    name: 'wide-tall-launcher-edit-unavailable',
    width: 1200,
    height: 1000,
    launcherPins: 'unavailable',
    click: '#launcher [data-control="launchedit:pin:pin-retired"]',
  },
  // The longest Effort catalog in the narrow panel, where its choices have the least room.
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
  // The line above the box, in each state it can wear, with its working pinned open. The
  // fixture's own clock reaches only the cold one, so the warm state is posted.
  { name: 'wide-next-turn-warm', width: 1350, escape: true, nextTurn: 'warm', click: NEXT_TURN_PRICE },
  { name: 'wide-next-turn-cold', escape: true, nextTurn: 'cold', click: NEXT_TURN_PRICE },
  // A session with no recorded lifetime quotes the conservative price.
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
];

// The sessions the rail draws a colour for, and the state each one is in. Every state
// that earns a border is here, so one picture answers whether the reader can tell them
// apart. The first is the shown session, whose foot carries the two requests below.
const SHOT_STATUSES = new Map<string, RailStatus>([
  ['s1', 'waiting'],
  ['s2', 'running'],
  ['s3', 'subagents'],
  ['s4', 'waiting'],
  ['s6', 'failed'],
]);
const SHOT_RUNNING_SINCE = new Map<string, number>([['s2', FIXTURE_CLOCK - 31 * 60_000]]);
const SHOT_OPEN_CHILDREN = new Map<string, number>([['s3', 2]]);

// The page a live child has stopped on: a permission request and a question at the foot of
// the session, with the rail beside it holding a card in each coloured state.
function asksPayload(which: boolean | 'three' | 'six'): Record<string, unknown> {
  const asks =
    which === 'three' ? [THREE_QUESTION_ASK] : which === 'six' ? [SIX_QUESTION_ASK] : [PERMISSION_ASK, QUESTION_ASK];
  return renderPayload([], [], [], [], asks, [], SHOT_STATUSES, SHOT_RUNNING_SINCE, [], SHOT_OPEN_CHILDREN);
}

// The long turn after its main agent finished while its background subagents still work.
function subagentsPayload(): Record<string, unknown> {
  const payload = renderPayload([], [], [], [], [], [], SHOT_STATUSES, SHOT_RUNNING_SINCE, [], SHOT_OPEN_CHILDREN) as {
    cards: Record<string, unknown>[];
  };
  // The long turn's open child becomes a background launch, the kind that outlives its turn.
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

// One frame for the message to be taken, one for the layout it causes. A string rather than
// a function, because this file is transpiled and a transpiled arrow function calls helpers
// the page has never heard of.
export const SETTLED = 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))';

// A browser already installed, or nothing. Edge ships with Windows and Chrome is common
// everywhere else; the bundled Chromium is tried last, for a machine that has run
// `playwright install`. Nothing is downloaded here.
export async function browserOrNone(): Promise<Browser | null> {
  for (const channel of ['msedge', 'chrome', undefined]) {
    try {
      return await chromium.launch({
        headless: true,
        args: ['--hide-scrollbars'],
        ...(channel ? { channel } : {}),
      });
    } catch {
      // The next one, and no report: which browsers a machine has is not a fault in the panel.
    }
  }
  return null;
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
  // A session that has answered no prompt has no figures. The card and the heading over it
  // both read the keyed record, so clearing this payload's entry clears both.
  delete payload.stats.s1;
  payload.showing = 's1';
  return payload;
}

// How long ImageMagick gets for one conversion or one comparison.
const CONVERT_TIMEOUT_MS = 60_000;

// What both a page and a region accept. Playwright types the two separately, and this helper
// reads only the fields they share.
type ScreenshotOptions = {
  path?: string;
  clip?: { x: number; y: number; width: number; height: number };
  fullPage?: boolean;
};

// Writes one picture as a lossless WebP. The browser has no lossless WebP encoder, so the
// shot lands as a PNG first and ImageMagick converts it. The comparison that follows is what
// makes the word lossless true: it counts the differing pixels and refuses anything but zero,
// so a picture a reviewer measures a colour in is the picture the browser drew.
//
// The panel-mockup skill holds the same helper for its mockup boards. That skill is its own
// repository, reached through a symbolic link, so the extension cannot import from it.
export async function writeLosslessWebp(
  target: { screenshot(options: ScreenshotOptions): Promise<Buffer> },
  file: string,
  options: Omit<ScreenshotOptions, 'path'> = {},
): Promise<void> {
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

// The Rows value is chosen the way a reader chooses it, so the rows redraw with the short age
// as well as the compact layout. The View menu shuts again before the picture.
async function chooseRailDensity(page: Page, density: RailDensity): Promise<void> {
  if (!(await page.locator('#railfilterpop').isVisible())) {
    await page.locator('[data-control="railfilters"]').click();
  }
  await page.locator(`[data-control="raildensity:${density}"]`).click();
  await page.locator('[data-control="railfilters"]').click();
  await page.evaluate(SETTLED);
}

export async function shoot(page: Page, shot: Shot, outDir: string): Promise<void> {
  const file = path.join(outDir, `${shot.name}.webp`);
  fs.rmSync(file, { force: true });
  // Each state starts from the same focus condition. Actions below can move focus when the
  // state includes that behavior, but an earlier state cannot leave an outline behind.
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
  // A density shot puts the rail width back with the density, so the shots after it keep theirs.
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
    // A saved filter press leaves the View menu open, so the funnel shuts it again and the
    // picker step below opens it only for the shots that draw it.
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
    await page.evaluate(
      `window.postMessage(${JSON.stringify(shot.stats ? statPopoverPayload() : renderPayload())}, '*')`,
    );
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
    // The pinned session carries all three figures, with a lower-bound cost that has a warning
    // and a context near its limit, so a comfortable row and a compact row's hover both show
    // every figure state the line draws.
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
  if (shot.cacheWriteWarning) {
    // A query an earlier picture left behind, emptied where one is on screen. The box has no
    // resting place on the rail head row, so a page that rests on its counts has none.
    if (await page.locator('.railfilter').count()) {
      await page
        .locator('.railfilter')
        .first()
        .evaluate((node) => {
          (node as HTMLInputElement).value = '';
          node.dispatchEvent(new Event('input', { bubbles: true }));
        });
    }
    await page.evaluate(`window.postMessage(${JSON.stringify(cacheWriteWarningPayload())}, '*')`);
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
    // Three unread sessions, one waiting session and one running session beside the fixture's
    // active ones, so the head draws Running, Active, Unread and Needs input together.
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
    // The shot before this one leaves the menu open, so the funnel is pressed only when it is shut.
    const funnel = page.locator('[data-control="railfilters"]');
    if ((await funnel.getAttribute('aria-expanded')) !== 'true') {
      await funnel.click();
    }
    await page.evaluate(SETTLED);
    await page.locator(`[data-control="railheadlens:${shot.railHeadUntick}"]`).click();
    await page.evaluate(SETTLED);
  }
  if (shot.railLens) {
    // The fixture's sessions are all read, so the first three are posted unread to give the
    // Unread lens something to count.
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
    // The rail head row rests on its counts and its two tools, so the box has to be opened
    // before anything can be typed into it. The magnifying glass opens it directly.
    if (!(await page.locator('.railfilter').count())) {
      await page.locator('[data-control="railsearch"]').click();
      await page.evaluate(SETTLED);
    }
    // Typed rather than written onto the box. The list under it opens off the word the caret
    // stands in, and a value set straight on the element moves no caret and fires no press.
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
    // A card the panel remembers stays open for every picture after it, so the press is made
    // only on a shut card. Pressed unconditionally, the second of these states would shut the
    // card the first one opened.
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
  if (shot.hover) {
    try {
      await page.locator(shot.hover).first().hover({ timeout: 5_000 });
    } catch {
      console.log(`${shot.name}.webp not written: nothing on the page matches ${shot.hover}`);
      return;
    }
    // The hint opens after the editor's hover delay, which differs by platform and by what
    // the pointer rests on, so the shot waits for the box itself.
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
    // The popover opens on the answer and not on the press, because the extension owns the
    // rows. The press posted the ask; this is the reply the panel is waiting for.
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
  if (shot.rename) {
    // The editor opens on the command and not on the right-click, because the extension owns
    // the full name. The right-click arms it, and this posts the command's message.
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
  // A render message can schedule a Preact repaint from a layout effect after the first
  // pair of frames. Let that follow-up finish before the pixels are sampled.
  if (shot.contextDetail) {
    const provider = shot.contextDetail === 'claude' ? 'claude' : 'codex';
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
    const detail = normalizeContext(raw, { session: 's1', provider, model: '', source: 'capture', ...request });
    await page.evaluate((message) => window.postMessage(message, '*'), { type: 'contextDetail', detail });
    await page.evaluate(SETTLED);
  }
  await page.waitForTimeout(100);
  await page.evaluate(SETTLED);
  if (!shot.hover) {
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
  const viewport = page.viewportSize();
  const element = shot.clip ? await page.locator(shot.clip).first().boundingBox() : null;
  await writeLosslessWebp(page, file, {
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
  if (shot.labels || shot.hover) {
    // The pointer is left where it pressed, and a rail row under it draws its controls in
    // every picture after this one.
    await page.mouse.move(0, 0);
    await page.evaluate(SETTLED);
  }
  // The width goes back before the page redraws below, so the composer is placed for it.
  if (railBasis !== null) {
    await page.locator('#rail').evaluate((node, basis) => {
      (node as HTMLElement).style.flexBasis = basis;
    }, railBasis);
    await page.evaluate(SETTLED);
  }
  // A disclosure the panel remembers stays open for every picture after this one. The page
  // is shared, so a state opened for one shot is put back before the next.
  if (shot.layout || shot.pinned || shot.railLens || shot.launcherPins !== undefined || shot.contextDetail) {
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

// Every shot, taken twice: once dressed in Dark Modern and once in Light Modern. Dark keeps
// the plain names so an existing link to one still resolves; light earns a `-light` suffix,
// since the two are pictures of the same state and belong beside each other on disk.
function shotFor(shot: Shot, kind: 'dark' | 'light'): Shot {
  return kind === 'light' ? { ...shot, name: `${shot.name}-light` } : shot;
}

async function main(): Promise<void> {
  const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'shots');
  const browser = await browserOrNone();
  if (!browser) {
    console.log('No Edge, Chrome or bundled Chromium on this machine, so no pictures were written.');
    return;
  }
  const errors: string[] = [];
  try {
    fs.mkdirSync(outDir, { recursive: true });
    // A fresh page per theme kind, and not one page loaded twice: `setContent` writes into
    // the page's existing document rather than navigating it, so the inline script that
    // declares SAVED_STATE throws on a second call, having already declared it once.
    for (const kind of ['dark', 'light'] as const) {
      const page = await browser.newPage({
        viewport: { width: 1350, height: 900 },
        deviceScaleFactor: 2,
      });
      let currentShot = 'initial panel';
      page.on('pageerror', (e) => errors.push(`${currentShot}: ${String(e)}`));
      // Fix Date.now while browser timers continue. Time-sensitive labels then cannot cross a
      // threshold between captured states.
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
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
