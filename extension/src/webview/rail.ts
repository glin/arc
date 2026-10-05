import { Fragment, h, render, type ComponentChildren } from 'preact';
import { nativeMenuIcon, pressNativeMenu } from './native-menu.ts';
import { navigationIndex, plainNavigationKey } from './navigation.ts';
import type { SessionLauncherView } from '../view/launcher.ts';
import { newSessionKeyshortcut, newSessionName, UNREADY_LAUNCHER_WORDS } from '../view/launcher.ts';
import { LABEL_NOTES, labelKey, labelTypedNotes } from '../domain/labels.ts';
import {
  IS_PREFIX,
  IS_VALUES,
  LABEL_PREFIX,
  NEGATE_MARK,
  parseSessionQuery,
  queryToken,
  replaceToken,
  SESSION_AXES,
  type QueryToken,
} from '../domain/session-query.ts';
import {
  RAIL_SORTS,
  normalizeRailSort,
  normalizeSavedViewSort,
  railSortName,
  railSortShortName,
  type RailSort,
  type SavedViewSort,
} from '../domain/rail-sort.ts';
import {
  cacheExpiryNote,
  costNote,
  labelFilterToken,
  labelSuggestions,
  railMenuLabelChips,
  type LabelSuggestionCount,
} from '../view/session-query.ts';
import {
  DEFAULT_RAIL_QUICK_FILTERS,
  clampRailWidth,
  effectiveRailWidth,
  railWidthMaximum,
  railWidthKey,
  RAIL_WIDTH_MIN,
  railGroupListId,
  railGroupHeadingId,
  normalizeRailShowArchived,
  normalizeRailShowRuns,
  normalizeRailQuickFilters,
  PIN_GLYPH,
  RAIL_FOLDS,
  RAIL_MIN_WIDTH,
  RAIL_SHOWN_BUCKETS,
  RAIL_WIDTH_DEFAULT,
  railCacheTitle,
  railCardName,
  railCountButtons,
  railHeadLensBoxes,
  withRailHeadLensToggled,
  railNarrowToRow,
  railDrawnRows,
  railCacheState,
  railCardActive,
  railHeadCounts,
  railQueryReadsCache,
  railRunningWord,
  railSections,
  railKeptAfter,
  railShownCards,
  railStatChips,
  railTickWork,
  railTimeSlot,
  sortRailCards,
  subagentsHintDetail,
  subagentsStillRunning,
  backgroundCommandsHintDetail,
  backgroundCommandsStillRunning,
  VIEW_FOLD_PREFIX,
  viewFoldId,
  normalizeRailDensity,
  normalizeRailGroupBy,
  railAgeFormat,
  railAgentWordShown,
  railCardHint,
  railHoverLines,
  railStatusClass,
  type RailHoverWords,
  railRepeatRows,
  railRowId,
  railRowsDrawn,
  RAIL_ROW_STEP,
  railRowKey,
  railShownLabelCounts,
  RAIL_DENSITIES,
  RAIL_GROUP_BY,
  type RailDensity,
  type RailGroupBy,
  type RailCountButton,
  type RailCountKind,
  type RailCounts,
  type RailCountsOptions,
  type RailDrawnRow,
  type RailKept,
  type RailNarrowing,
  type RailSection,
  type RailTickRow,
} from '../view/rail.ts';
import {
  findView,
  nextViewId,
  VIEW_NOTES,
  viewCanSave,
  viewFiles,
  viewName,
  viewNameTaken,
  viewQuery,
  viewQueryNotes,
  viewTypedNotes,
  type SavedView,
  type ViewNote,
} from '../domain/views.ts';
import {
  ALL_RAIL_FILTER_ID,
  RAIL_FILTER_QUERY_LIMIT,
  boundedRailFilterQuery,
  findRailFilter,
  nextRailFilterId,
  normalizeRailFilterId,
  normalizeSavedRailFilters,
  RAIL_LENSES,
  railQueryLens,
  railFilterName,
  railFilterNameTaken,
  railFilterQuery,
  railFilterTermNegated,
  railFilterTermSelected,
  pressRailLens,
  sameRailFilterLens,
  toggleRailFilterTerm,
  withRailLens,
  type RailFilterLens,
  type RailLens,
  type SavedRailFilter,
} from '../domain/rail-filters.ts';
import type { PanelStat, PanelToHost } from './protocol.ts';
import { found, placeFloat } from './dom.ts';
import { inlineText } from './inline-text.ts';
import {
  SessionRenameEditor,
  answeredRename,
  submittedRename,
  type OpenRename,
  type SessionRenameAnswer,
  type SessionRenameWords,
} from './session-rename.ts';
import { RailStats } from './stat-chip.ts';
import { railHoverCard } from './rail-hover.ts';
import type { Clock } from './clock.ts';
import type { RailCacheMark, RailCardView, RailStat } from './payload-contracts.ts';

interface RailEvents {
  document(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  window(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
}

export type { RailCardView } from './payload-contracts.ts';

export interface LabelEditorRow extends LabelSuggestionCount {
  applied: boolean;
}

interface RailWords extends SessionRenameWords, RailHoverWords {
  railLabel: string;
  railFilter: string;
  railFilterHint: string;
  railFilterClear: string;
  railFilterClose: string;
  railSearch: string;
  railSearchHint: string;
  railCountActive: string;
  railCountCacheWarm: string;
  railCountCacheExpiring: string;
  railCountCacheNone: string;
  railCountSession: string;
  railCountSessions: string;
  railCountRunningHint: string;
  railCountActiveHint: string;
  railCountUnreadHint: string;
  railCountInputHint: string;
  railCountPressedHint: string;
  railFilterEmpty: string;
  railFilterOffers: string;
  railFilterTake: string;
  railFilterWithout: string;
  railFilters: string;
  railFiltersHint: string;
  railFilterAll: string;
  railFilterCustom: string;
  railFilterFind: string;
  railSortBy: string;
  railGroupBy: string;
  railGroupByValues: Record<RailGroupBy, string>;
  railNarrowTo: string;
  railNarrowToValues: Record<'all' | RailLens, string>;
  railHeadLensesName: string;
  railRowsName: string;
  railRowsComfortable: string;
  railRowsCompact: string;
  railRowsComfortableHint: string;
  railRowsCompactHint: string;
  railFilterPresets: string;
  railFilterShow: string;
  railShowArchived: string;
  railShowRuns: string;
  railFilterLabels: string;
  railFilterLabelsMore: string;
  railMoreShow: string;
  railMoreIn: string;
  railFilterLabelsFewer: string;
  railFilterLabelsNone: string;
  railFilterSaveChanges: string;
  railFilterSaveAsNew: string;
  railFilterRename: string;
  railFilterDelete: string;
  railFilterDeleteConfirm: string;
  railFilterName: string;
  railFilterNameTaken: string;
  railFilterSave: string;
  railFilterCancel: string;
  labelOpen: string;
  labelOpenDetail: string;
  labelFind: string;
  labelCreate: string;
  labelCreateWhy: string;
  labelCreateKey: string;
  labelNone: string;
  hideSession: string;
  unarchiveSession: string;
  hideSessionHint: string;
  hideSessionDetail: string;
  unarchiveSessionHint: string;
  unarchiveSessionDetail: string;
  railPin: string;
  railUnpin: string;
  railPinHint: string;
  railPinDetail: string;
  railUnpinHint: string;
  railUnpinDetail: string;
  railViewSave: string;
  railViewName: string;
  railViewNameKey: string;
  railViewNameCancel: string;
  railViewEmpty: string;
  railViewEdit: string;
  railViewNameField: string;
  railViewCancel: string;
  railViewSaveAction: string;
  railViewDelete: string;
  railViewDeleteConfirm: string;
}

interface LauncherPorts {
  open(): boolean;
  anchor(): HTMLElement | null;
  compactMenu(): HTMLElement | null;
  close(returnFocus: boolean): void;
  toggle(anchor: HTMLElement): void;
}

interface RailOptions {
  document: Document;
  clock: Pick<Clock, 'subscribe'>;
  before: HTMLElement;
  events: RailEvents;
  platform: string;
  words: RailWords;
  twist: { open: string; shut: string };
  cross: string;
  initial: {
    filter: string;
    filterId: unknown;
    width: unknown;
    folds: Record<string, unknown>;
    sort: unknown;
    defaultSort: unknown;
    showArchived: unknown;
    showRuns: unknown;
    headLenses: unknown;
    groupBy: unknown;
    density: unknown;
  };
  sendToHost(message: PanelToHost): void;
  save(): void;
  selectionWithin(node: HTMLElement | null): boolean;
  fallbackFocus(): HTMLElement | null;
  showSession(session: string): void;
  archiveSession(session: string): void;
  unarchiveSession(session: string): void;
  setPinned(session: string, pinned: boolean, openPinned?: boolean): void;
  // A row's native context menu, carrying the section its read state names, the pinned and
  // archived facts the session heading answers from its own state, and whether the session
  // is saved. The session heading and the rail card read the pin and archive state from the
  // same place, so a press on either answers the other's menu correctly on the next open.
  rowContext(sessionId: string, menuSection: string, persisted: boolean): string;
  onLayoutChange(): void;
  onVisibilityChange(visible: boolean, filterable: boolean): void;
  onLabelEditorChange(): void;
  dismissHint(): void;
  // Focus that a pointer press moves to this control shows no hint.
  quietHint(target: HTMLElement): void;
  // Registers the drawing of a hint body, and draws an open hint of that body again.
  hintBody(kind: string, draw: (anchor: HTMLElement) => HTMLElement | null): void;
  redrawHint(kind: string): void;
  contextClass(level: string): string;
  launcher: LauncherPorts;
  // A test-only counter of full rail draws. Production never supplies it, so the count
  // adds no cost and no state outside a test that asks for it.
  onDraw?(): void;
}

// A rail card with the two facts the query grammar cannot read off it. `is:warm` asks whether
// the prompt cache still has time on it, and `is:active` asks whether the session sits inside
// its own recency window. Both are read against the browser's clock, so the rail stamps the
// answers on before it matches.
type RailMatchCard = RailCardView & { cacheWarm?: boolean; active?: boolean };

// Session counts and Active's visible cache information change on the clock.
function countsMoved(drawn: RailCounts, at: RailCounts): boolean {
  const state = (counts: RailCounts) => (counts.expiring > 0 ? 'nearly-gone' : counts.warm > 0 ? 'warm' : null);
  return (
    drawn.running !== at.running ||
    drawn.active !== at.active ||
    drawn.unread !== at.unread ||
    drawn.input !== at.input ||
    state(drawn) !== state(at)
  );
}

export interface RailSnapshot {
  filter: string;
  filterId: string;
  width: number;
  folds: ReadonlyMap<string, boolean>;
  sort: RailSort;
  defaultSort: RailSort;
  showArchived: boolean;
  showRuns: boolean;
  headLenses: RailLens[];
  groupBy: RailGroupBy;
  density: RailDensity;
}

// releaseSelection, tick, reset, filterByLabel and receiveLabelEditor each end in the rail's
// own full list draw. Calling one in a loop over sessions costs a full draw per session.
export interface RailRenderer {
  updateLoading(text: string | null): void;
  readonly element: HTMLElement;
  readonly sashElement: HTMLElement;
  readonly projectSpendMount: HTMLElement;
  update(
    cards: readonly RailCardView[] | null | undefined,
    labels: readonly LabelSuggestionCount[] | null | undefined,
    views: readonly SavedView[] | null | undefined,
    railFilters: readonly SavedRailFilter[] | null | undefined,
    // The session figures the message keyed by session id. The rail draws three of them on
    // each card, so it reads the same record the session heading reads.
    stats: Readonly<Record<string, readonly PanelStat[]>>,
    catalogAvailable?: boolean,
  ): void;
  openViewEditor(view: string, mode: 'rename' | 'delete'): void;
  openSessionRename(session: string, title: string): void;
  receiveSessionRenameResult(answer: SessionRenameAnswer): void;
  updateLauncher(view: SessionLauncherView | null): void;
  releaseSelection(): void;
  tick(now?: number): void;
  reset(): void;
  snapshot(): RailSnapshot;
  visible(): boolean;
  visibleFor(cards: readonly RailCardView[] | null | undefined): boolean;
  newButton(): HTMLElement | null;
  newMenu(): HTMLElement | null;
  labelOpen(session: string): boolean;
  filterable(): boolean;
  filterByLabel(name: string): void;
  toggleLabelEditor(session: string, anchor?: HTMLElement | null): void;
  receiveLabelEditor(session: string, heading: string, rows: LabelEditorRow[]): void;
  labelsChanged(session: string): void;
  openArmedLabelEditor(session: string): void;
  adoptSessionIdentity(provisional: string, durable: string): void;
  handleHotkey(event: KeyboardEvent, from: HTMLElement): boolean;
  place(): void;
  setViewSort(value: string): void;
  // Redraws one row's native context menu in place, after a pin or an archive changes what
  // it offers. Timeline-renderer's own `drawRowContext` answers the same call for the
  // session heading.
  drawRowContext(session: string): void;
  // The same rewrite for many sessions at once, drawing once for the whole batch.
  drawRowContexts(sessions: readonly string[]): void;
}

interface FilterOffer {
  key: string;
  token: string;
  start: number;
  end: number;
  whole: boolean;
  axis: string;
  name: string;
  count: string;
  said: string;
}

interface OpenLabels {
  session: string;
  // The fold id of the section the press came from, and null for a press made outside the rail.
  // A session two saved views both match draws a row under each, so the session alone
  // does not say which control the popover hangs off, which row reports it open, or which press
  // shuts it rather than moving it.
  section: string | null;
  anchor: HTMLElement | null;
  control: string | null;
  heading: string;
  rows: LabelEditorRow[];
}

interface PendingLabels {
  session: string;
  section: string | null;
  anchor: HTMLElement | null;
  control: string | null;
  at: number;
}

interface LabelArm {
  session: string;
  node: HTMLElement;
  at: number;
}

// The view the editor is open over, and what the reader has done to it so far.
interface OpenView {
  view: string;
  name: string;
  sort: string;
  // Whether the delete button is on its second press. It disarms on Escape and on Cancel, so a
  // reader who armed it and walked away comes back to a button that reads what it does.
  armed: boolean;
  anchor: HTMLElement | null;
  control: string;
}

// What the reader is naming, once they press the row under the filter box. The query is held
// here rather than read back off the box, because the box is now the name field.
interface NamingView {
  // Naming captures the query and sort. Payloads and ticks leave the captured lens alone.
  lens: RailFilterLens;
  name: string;
}

interface RailFilterNameMode {
  kind: 'save' | 'rename';
  name: string;
}

const MENU_ARM_MS = 30_000;

// Whether the native menu over this node offers Rename session. The context names the session
// as saved, so a provisional new session never offers it.
function renameOffered(node: HTMLElement): boolean {
  try {
    return (JSON.parse(node.dataset.vscodeContext ?? '{}') as { sessionPersisted?: unknown }).sessionPersisted === true;
  } catch {
    return false;
  }
}
// The draft adoptions the rail remembers. A draft is adopted once, on its first answered prompt,
// so a handful covers every draft a reader can have open.
const ADOPTIONS_KEPT = 16;

function railCardClass(card: RailCardView): string {
  return (
    `railcard${card.status ? ` ${card.status}` : ''}${card.current ? ' is-current' : ''}` +
    `${card.unread ? ' is-unread' : ''}${card.archived ? ' is-archived' : ''}`
  );
}

function hotkeyName(name: string, hotkey: string | null): string {
  return hotkey ? `${name} (${hotkey})` : name;
}

function railActionLabel(action: string, card: RailCardView, hotkey: string | null): string {
  return `${hotkeyName(action, hotkey)}: ${card.label}`;
}

function actionProps(
  action: string,
  card: RailCardView,
  hotkey: string | null,
  keyshortcut: string | null,
  hint: string,
  detail: string,
): Record<string, unknown> {
  return {
    'aria-label': railActionLabel(action, card, hotkey),
    'aria-keyshortcuts': keyshortcut ?? undefined,
    'data-hint': hotkeyName(hint, hotkey),
    'data-hint-detail': detail,
  };
}

function icon(path: string): ComponentChildren {
  return h('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' }, h('path', { d: path }));
}

function pinIcon(): ComponentChildren {
  return icon(PIN_GLYPH);
}

function archiveIcon(): ComponentChildren {
  return icon('M2 4h12v3H2zM3 7v6h10V7M6.5 10h3');
}

function labelIcon(): ComponentChildren {
  return icon('M8.5 2H14v5.5L7.5 14 2 8.5zM11 5h.01');
}

// A cache bolt. A row's bolt names its own cache's span in its title. The Active count's bolt
// has no span and no title, because the count's own name says what the bolt means.
function cacheIcon(state: 'warm' | 'nearly-gone', cache: RailCacheMark | null, now: number): ComponentChildren {
  const path = h('path', { d: 'M6.9 1.3 2.6 7h2.8L5 10.7 9.4 5H6.6z' });
  return h(
    'svg',
    {
      class: `railcache${cache ? '' : ' railcountcache'} is-${state}`,
      viewBox: '0 0 12 12',
      width: cache ? '12' : undefined,
      height: cache ? '12' : undefined,
      'aria-hidden': 'true',
      focusable: 'false',
      'data-cache-state': state,
    },
    cache ? [h('title', null, railCacheTitle(cache, now)), path] : path,
  );
}

// The drawn name: the wording `view/rail.ts` owns, with the two clauses this file's clock
// supplies. The name a card is read by has one owner, and this is where its clauses arrive.
function drawnRailCardName(card: RailCardView, now: number): string {
  const state = railCacheState(card.cache, now);
  const cacheName = state === 'nearly-gone' ? 'cache nearly gone' : state === 'warm' ? 'cache warm' : null;
  const running =
    card.status === 'running' && card.runningSince !== null ? railRunningWord(card.runningSince, now) : null;
  const runningName = running
    ? `running for ${running}`
    : card.status === 'running' && card.runningSince !== null
      ? 'running'
      : null;
  return `${railCardName(card, { running: runningName, cache: cacheName })}, Last activity ${card.absolute}`;
}

const NO_RAIL_STATS: readonly RailStat[] = [];

// The three figures every card draws, out of the record a message keyed by session id. A
// figure the host sent without a metric or without a compact form has nothing to draw with.
//
// The whole record is projected once, where the rail takes it, rather than once inside each
// row. Every row redraws on a clock tick, and a workspace of several thousand sessions would
// otherwise repeat this search behind each of them on every tick.
function drawnRailStats(record: Readonly<Record<string, readonly PanelStat[]>>): Record<string, readonly RailStat[]> {
  const drawn: Record<string, readonly RailStat[]> = {};
  for (const [session, chips] of Object.entries(record)) {
    drawn[session] = railStatChips(
      chips.filter(
        (chip): chip is PanelStat & RailStat =>
          typeof chip.metric === 'string' && typeof chip.compactLabel === 'string',
      ),
    );
  }
  return drawn;
}

function RailLabels({ card }: { card: RailCardView }): ComponentChildren {
  const chips: { key: string; text: string; title: string; more: boolean }[] = card.labelChips.map((name, index) => ({
    key: `label:${index}:${name}`,
    text: name,
    title: name,
    more: false,
  }));
  if (card.labelsMore) {
    chips.push({ key: 'more', text: card.labelsMore, title: card.labelsMoreName || '', more: true });
  }
  return h(
    'div',
    { class: 'raillabels', hidden: !chips.length },
    inlineText(
      chips.map((chip) =>
        h(
          'span',
          {
            class: chip.more ? 'raillabel raillabelmore' : 'raillabel',
            key: chip.key,
            title: chip.title,
          },
          chip.text,
        ),
      ),
    ),
  );
}

function RailRow({
  card,
  stats,
  bucket,
  view,
  repeat,
  owner,
  options,
  now,
  density,
  labelsOpen,
}: {
  card: RailCardView;
  stats: readonly RailStat[];
  bucket: string;
  view: boolean;
  repeat: boolean;
  owner: RailRenderer;
  options: RailOptions;
  now: number;
  density: RailDensity;
  labelsOpen: { session: string; section: string | null } | null;
}): ComponentChildren {
  // One control says the editor is open, and it is the one the editor hangs off. A press made
  // outside the rail names no section, and the first row drawing the session answers for
  // it, because that row is the one `labelAnchorFor` reaches first.
  const labelsHere =
    !!labelsOpen &&
    labelsOpen.session === card.id &&
    (labelsOpen.section === null ? !repeat : labelsOpen.section === bucket);
  const slot = railTimeSlot(card.status, !!card.unsentWord, card.subagents, card.commands);
  const subagents = card.status === 'subagents' ? (card.subagents ?? 0) : null;
  const commands = card.status === 'background' ? (card.commands ?? 0) : null;
  const archiveKey = /^Mac/.test(options.platform || '') ? 'Backspace' : 'Delete';
  const labelShortcut = card.archived ? null : 'L';
  const pinShortcut = card.archived ? null : 'P';
  const awayHotkey = card.archived ? null : archiveKey;
  const cache = railCacheState(card.cache, now);
  const hint = railCardHint(
    card,
    density,
    subagents !== null
      ? { hint: subagentsStillRunning(subagents), detail: subagentsHintDetail(subagents) }
      : commands !== null
        ? { hint: backgroundCommandsStillRunning(commands), detail: backgroundCommandsHintDetail(commands) }
        : null,
  );
  return h(
    'li',
    {
      class: view ? 'railrow railviewedge' : 'railrow',
      id: railRowId(bucket, card.id, repeat),
      'data-rail-bucket': bucket,
      key: railRowKey(bucket, card.id),
    },
    [
      h(
        'button',
        {
          class: railCardClass(card),
          'data-control': `rail:${card.id}`,
          'data-session': card.id,
          'data-archived': String(card.archived),
          'data-vscode-context': options.rowContext(card.id, card.menuSection, card.persisted),
          'aria-label': drawnRailCardName(card, now),
          'aria-current': card.current ? 'true' : undefined,
          'data-hint': hint.hint,
          'data-hint-detail': hint.detail,
          'data-hint-description': hint.description,
          'data-hint-lines': hint.lines ? '' : undefined,
          'data-hint-body': hint.body,
          onClick: () => options.showSession(card.id),
        },
        [
          h('div', { class: 'railname' }, card.name ?? card.label),
          h(
            'div',
            { class: 'railmeta' },
            inlineText([
              railAgentWordShown(bucket) ? h('span', { class: 'railagent' }, card.agentWord) : null,
              h('span', { class: railStatusClass(card.status) }, [
                slot.word || '',
                card.status === 'running' && card.runningSince !== null && railRunningWord(card.runningSince, now)
                  ? [
                      ' ',
                      h(
                        'span',
                        { class: 'railfor', title: `Started ${card.runningSinceWhen}\nLast activity ${card.absolute}` },
                        railRunningWord(card.runningSince, now),
                      ),
                    ]
                  : null,
              ]),
              !slot.time && cache && card.cache ? cacheIcon(cache, card.cache, now) : null,
              h('span', { class: 'railunsent', title: card.unsentName || '' }, card.unsentWord || ''),
              h(
                'span',
                {
                  class: 'railwhen',
                  title: card.absolute,
                  'data-at': String(card.at),
                  hidden: !slot.time,
                },
                railAgeFormat(density)(card.at, now),
              ),
              slot.time && cache && card.cache ? cacheIcon(cache, card.cache, now) : null,
            ]),
          ),
          h(RailStats, { stats, contextClass: options.contextClass }),
          h(RailLabels, { card }),
        ],
      ),
      h(
        'button',
        {
          class: 'railact raillabelact',
          'data-control': `raillabels:${card.id}`,
          'data-session': card.id,
          'aria-controls': 'labelpop',
          'aria-haspopup': 'dialog',
          'aria-expanded': String(labelsHere),
          ...actionProps(
            options.words.labelOpen,
            card,
            'L',
            labelShortcut,
            options.words.labelOpen,
            options.words.labelOpenDetail,
          ),
          onClick: (event: MouseEvent) => owner.toggleLabelEditor(card.id, event.currentTarget as HTMLElement),
        },
        labelIcon(),
      ),
      h(
        'button',
        {
          class: card.archived ? 'railact railhide is-archived' : 'railact railhide',
          'data-control': `railhide:${card.id}`,
          ...actionProps(
            card.archived ? options.words.unarchiveSession : options.words.hideSession,
            card,
            awayHotkey,
            card.archived ? null : archiveKey,
            card.archived ? options.words.unarchiveSessionHint : options.words.hideSessionHint,
            card.archived ? options.words.unarchiveSessionDetail : options.words.hideSessionDetail,
          ),
          onClick: () => (card.archived ? options.unarchiveSession(card.id) : options.archiveSession(card.id)),
        },
        archiveIcon(),
      ),
      h(
        'button',
        {
          class: card.pinnedTop ? 'railact railpin is-pinned' : 'railact railpin',
          'data-control': `railpin:${card.id}`,
          ...actionProps(
            card.pinnedTop ? options.words.railUnpin : options.words.railPin,
            card,
            'P',
            pinShortcut,
            card.pinnedTop ? options.words.railUnpinHint : options.words.railPinHint,
            card.pinnedTop ? options.words.railUnpinDetail : options.words.railPinDetail,
          ),
          onClick: () => (owner as RailRenderer & { togglePinned(card: RailCardView): void }).togglePinned(card),
        },
        pinIcon(),
      ),
    ],
  );
}

// The press under a section that draws the next `RAIL_ROW_STEP` of its cards. A section draws
// at most that many rows until it is pressed, so a keystroke over a large workspace draws a
// bounded list. It is one keyed element per section, so it stays the same button, and keeps
// focus, while the rows drawn above it grow.
//
// Several groups can each end in a press with the same text, so the
// accessible name adds the section. The press carries its section id the way a row does, so a
// press a poll draw removes hands the focus to its own section, not to the top of the rail.
function RailMoreRow({
  section,
  label,
  name,
  raise,
}: {
  section: string;
  label: string;
  name: string;
  raise(section: string): void;
}): ComponentChildren {
  return h(
    'button',
    {
      type: 'button',
      class: 'railmore',
      key: `more:${section}`,
      'data-control': `railmore:${section}`,
      'data-rail-bucket': section,
      'aria-label': name,
      onClick: () => raise(section),
    },
    label,
  );
}

// The heading over one run of sessions, whether a saved view gathered them or the clock
// did. The section answers for its own count and the whole of what a reader who cannot see it
// is told.
//
// A view's heading opens its name and order editor or deletion, so it carries the context the
// editor's own commands read. A time bucket is not the reader's to name, so it carries none.
function BucketHead({
  bucket,
  folded,
  view,
  drawn,
  owner,
  options,
}: {
  bucket: RailSection<RailCardView>;
  folded: boolean;
  view: SavedView | null;
  // How many of the section's cards the draw put on screen. The rest wait under its Show more
  // press, and a heading names no row that is not on the page.
  drawn: number;
  owner: { toggleBucket(id: string): void };
  options: RailOptions;
}): ComponentChildren {
  const control = bucket.id;
  const sortName = view?.sort && view.sort !== 'inherit' ? railSortName(bucket.sort) : '';
  const headingName = sortName ? `${bucket.name}, ${sortName}` : bucket.name;
  const controls = folded || drawn <= 0 ? undefined : railGroupListId(bucket.id);
  const disclosure = h(
    'button',
    {
      type: 'button',
      class: 'railfold railviewfold',
      key: 'disclosure',
      'data-bucket': view ? undefined : bucket.id,
      'data-control': control,
      'aria-controls': controls,
      'aria-expanded': String(!folded),
      'aria-label': headingName,
      'data-hint': view ? bucket.label : undefined,
      'data-hint-detail': view ? headingName : undefined,
      onClick: () => owner.toggleBucket(bucket.id),
    },
    [
      h('span', { class: 'twist', 'aria-hidden': 'true' }, folded ? options.twist.shut : options.twist.open),
      h('span', { class: 'railbucketname' }, bucket.label),
      h('span', { class: 'railbucketcount' }, `· ${bucket.count}`),
    ],
  );
  if (!view) {
    return h('h2', { class: 'railbucket', id: railGroupHeadingId(bucket.id), key: `bucket:${bucket.id}` }, disclosure);
  }
  return h(
    'h2',
    {
      class: 'railbucket railviewheading',
      id: railGroupHeadingId(bucket.id),
      'aria-label': headingName,
      key: `bucket:${bucket.id}`,
      'data-bucket': bucket.id,
      'data-vscode-context': JSON.stringify({
        webviewSection: 'arcRailView',
        view: view.id,
        preventDefaultContextMenuItems: true,
      }),
    },
    [
      disclosure,
      h(
        'button',
        {
          type: 'button',
          class: 'sessionmenu railviewmenu',
          'data-control': `viewmenu:${view.id}`,
          'aria-haspopup': 'menu',
          'aria-label': `View actions: ${bucket.label}`,
          'data-hint': 'View actions',
          'data-hint-detail': `Edit or delete ${bucket.label}`,
          onClick: pressNativeMenu,
        },
        nativeMenuIcon(),
      ),
    ],
  );
}

function FilterRows({
  rows,
  selected,
  take,
}: {
  rows: FilterOffer[];
  selected: number;
  take(row: FilterOffer): void;
}): ComponentChildren {
  return h(
    Fragment,
    null,
    rows.map((row, index) =>
      h(
        'div',
        {
          class: `filterrow${index === selected ? ' on' : ''}`,
          id: `filterrow${index}`,
          key: row.key,
          role: 'option',
          'aria-selected': String(index === selected),
          'aria-label': row.said,
          onPointerDown: (event: PointerEvent) => event.preventDefault(),
          onClick: () => take(row),
        },
        [
          row.axis ? h('span', { class: 'filteraxis' }, row.axis) : null,
          h('span', { class: 'filtername', title: row.name }, row.name),
          row.count ? h('span', { class: 'filtercount' }, row.count) : null,
        ],
      ),
    ),
  );
}

function LabelPopover({
  owner,
  open,
  rows,
  create,
  notes,
  options,
  setInput,
}: {
  owner: RailRenderer;
  open: OpenLabels | null;
  rows: LabelEditorRow[];
  create: string;
  notes: readonly (keyof typeof LABEL_NOTES)[];
  options: RailOptions;
  setInput(node: HTMLInputElement | null): void;
}): ComponentChildren {
  return h(Fragment, null, [
    h('div', { class: 'launchhead', key: 'head' }, open?.heading || ''),
    h(
      'div',
      { class: 'labelsearch', key: 'search' },
      h('input', {
        type: 'text',
        class: 'labelfind',
        placeholder: options.words.labelFind,
        'aria-label': options.words.labelFind,
        'data-control': 'label-find',
        ref: setInput,
        onInput: (event: Event) => {
          const input = event.currentTarget as HTMLInputElement;
          (owner as RailRenderer & { setLabelFilter(value: string): void }).setLabelFilter(input.value);
        },
        onKeyDown: (event: KeyboardEvent) => {
          (owner as RailRenderer & { labelInputKeydown(event: KeyboardEvent): void }).labelInputKeydown(event);
        },
      }),
    ),
    h('div', { class: 'labellist', key: 'list' }, [
      ...notes.map((note) => h('div', { class: 'labelnote', key: `note:${note}` }, LABEL_NOTES[note])),
      create
        ? h(
            'button',
            {
              class: 'launchrow labelcreate',
              type: 'button',
              key: 'create',
              'data-control': 'label-create',
              'aria-label': `${options.words.labelCreate} ${create}, ${options.words.labelCreateKey}, ${options.words.labelCreateWhy}`,
              onClick: () => (owner as RailRenderer & { createLabel(name: string): void }).createLabel(create),
            },
            [
              h('span', { class: 'launchname' }, [
                `${options.words.labelCreate} ${create}`,
                h('kbd', { class: 'labelkey' }, options.words.labelCreateKey),
              ]),
              h('span', { class: 'launchdetail' }, options.words.labelCreateWhy),
            ],
          )
        : null,
      ...rows.map((row) =>
        h('label', { class: 'labelrow', key: labelKey(row.name) }, [
          h('input', {
            type: 'checkbox',
            class: 'labelbox',
            checked: row.applied,
            'aria-label': `${row.name}, ${row.countName}`,
            'data-control': `label:${row.name}`,
            onKeyDown: (event: KeyboardEvent) => {
              if (event.isComposing || event.keyCode === 229 || event.key !== 'Enter') {
                return;
              }
              const input = event.currentTarget as HTMLInputElement;
              input.checked = !input.checked;
              event.preventDefault();
              (owner as RailRenderer & { setLabelApplied(name: string, applied: boolean): void }).setLabelApplied(
                row.name,
                input.checked,
              );
            },
            onChange: (event: Event) => {
              (owner as RailRenderer & { setLabelApplied(name: string, applied: boolean): void }).setLabelApplied(
                row.name,
                (event.currentTarget as HTMLInputElement).checked,
              );
            },
          }),
          h('span', { class: 'labelname' }, row.name),
          h('span', { class: 'labelcount' }, String(row.count)),
        ]),
      ),
      !rows.length && !create ? h('div', { class: 'labelempty', key: 'empty' }, options.words.labelNone) : null,
    ]),
  ]);
}

// The View menu the funnel opens: the find box, the lens the rail narrows to, how the rail
// groups, sorts and lays out its rows, which buckets it draws, the label chips, and the saved
// filters, in that order.
//
// Every press inside the menu leaves it open with focus on the pressed control, so a reader
// changes one thing after another and watches the rail answer each.
function RailFilterPicker({
  owner,
  open,
  filters,
  filterId,
  lens,
  defaultSort,
  shown,
  headLenses,
  groupBy,
  density,
  labels,
  labelsExpanded,
  search,
  nameMode,
  deleteArmed,
  options,
  setSearchInput,
  setNameInput,
}: {
  owner: RailRenderer;
  open: boolean;
  filters: readonly SavedRailFilter[];
  filterId: string;
  lens: RailFilterLens;
  defaultSort: RailSort;
  shown: RailCountsOptions;
  headLenses: readonly RailLens[];
  groupBy: RailGroupBy;
  density: RailDensity;
  labels: readonly LabelSuggestionCount[];
  labelsExpanded: boolean;
  search: string;
  nameMode: RailFilterNameMode | null;
  deleteArmed: boolean;
  options: RailOptions;
  setSearchInput(node: HTMLInputElement | null): void;
  setNameInput(node: HTMLInputElement | null): void;
}): ComponentChildren {
  if (!open) {
    return null;
  }
  // Each Rows value's word and hint. A density this table does not name fails the typecheck.
  const densityWords: Record<RailDensity, { name: string; hint: string }> = {
    comfortable: { name: options.words.railRowsComfortable, hint: options.words.railRowsComfortableHint },
    compact: { name: options.words.railRowsCompact, hint: options.words.railRowsCompactHint },
  };
  const menu = owner as RailRenderer & {
    selectRailFilter(id: string): void;
    setRailFilterSearch(value: string): void;
    setRailFilterSort(value: string): void;
    setRailLens(value: string): void;
    setRailGroupBy(value: string): void;
    setRailDensity(value: string): void;
    toggleRailShow(value: string): void;
    toggleRailHeadLens(value: string): void;
    toggleRailFilterLabel(value: string): void;
    toggleRailFilterLabelFold(): void;
  };
  const current = findRailFilter(filters, filterId);
  const exact = current ? sameRailFilterLens(current, lens) : false;
  const wanted = labelKey(search);
  const shownFilters = wanted ? filters.filter((filter) => labelKey(filter.name).includes(wanted)) : filters;
  // A label the query already negates has no chip, because pressing it would write the term
  // beside its own negation and empty the rail.
  const chips = railMenuLabelChips(
    labels.filter((label) => !railFilterTermNegated(lens.query, 'labels', label.name)),
    search,
    labelsExpanded,
  );
  const name = nameMode ? railFilterName(nameMode.name) : '';
  const nameTaken = nameMode ? railFilterNameTaken(filters, name, nameMode.kind === 'rename' ? filterId : '') : false;
  const filterButton = (id: string, word: string, query: string) =>
    h(
      'button',
      {
        class: 'launchrow railfilterchoice',
        type: 'button',
        role: 'radio',
        key: id,
        'aria-checked': String(
          filterId === id &&
            (id === ALL_RAIL_FILTER_ID ? sameRailFilterLens(lens, { query: '', sort: defaultSort }) : exact),
        ),
        'data-control': `railfilterpick:${id}`,
        onClick: () => menu.selectRailFilter(id),
      },
      inlineText([
        h('span', { class: 'launchname', title: word }, word),
        query ? h('span', { class: 'launchdetail' }, query) : null,
      ]),
    );
  return h(Fragment, null, [
    h('div', { class: 'launchhead', key: 'head' }, options.words.railFilters),
    h(
      'div',
      { class: 'labelsearch', key: 'search' },
      h('input', {
        type: 'search',
        class: 'labelfind',
        placeholder: options.words.railFilterFind,
        'aria-label': options.words.railFilterFind,
        'data-control': 'railfilter-find',
        defaultValue: search,
        ref: setSearchInput,
        onInput: (event: Event) => menu.setRailFilterSearch((event.currentTarget as HTMLInputElement).value),
      }),
    ),
    // The Filter row selects one status lens. Quick filters configures the rail-head buttons.
    h('div', { class: 'railfiltersection', key: 'narrow' }, [
      h('div', { class: 'railfiltersectionname', id: 'railnarrowname' }, options.words.railNarrowTo),
      h(
        'div',
        { class: 'railfiltermatch', role: 'radiogroup', 'aria-labelledby': 'railnarrowname' },
        railNarrowToRow(lens.query, options.words.railNarrowToValues).map((value) =>
          h(
            'button',
            {
              type: 'button',
              class: 'railfilterlabel',
              role: 'radio',
              key: value.value,
              'aria-checked': String(value.checked),
              'data-control': value.control,
              onClick: () => menu.setRailLens(value.value),
            },
            value.label,
          ),
        ),
      ),
      h('div', { class: 'railfiltersectionname railheadlensname', id: 'railheadlensname' }, [
        options.words.railHeadLensesName,
      ]),
      h(
        'div',
        { class: 'railheadlensline', role: 'group', 'aria-labelledby': 'railheadlensname' },
        railHeadLensBoxes(headLenses, options.words.railNarrowToValues).map((box) =>
          h('label', { class: 'labelrow', key: box.lens }, [
            h('input', {
              type: 'checkbox',
              class: 'labelbox',
              checked: box.checked,
              'data-control': box.control,
              onChange: () => menu.toggleRailHeadLens(box.lens),
              onKeyDown: (event: KeyboardEvent) => {
                if (event.isComposing || event.keyCode === 229 || event.key !== 'Enter') {
                  return;
                }
                event.preventDefault();
                menu.toggleRailHeadLens(box.lens);
              },
            }),
            h('span', { class: 'labelname' }, box.label),
          ]),
        ),
      ),
    ]),
    // How the rail groups its sessions. A value carries no count, because pressing it filters
    // nothing.
    h('div', { class: 'railfiltersection', key: 'groupby' }, [
      h('div', { class: 'railfiltersectionname', id: 'railgroupbyname' }, options.words.railGroupBy),
      h(
        'div',
        { class: 'railfiltermatch', role: 'radiogroup', 'aria-labelledby': 'railgroupbyname' },
        RAIL_GROUP_BY.map((value) =>
          h(
            'button',
            {
              type: 'button',
              class: 'railfilterlabel',
              role: 'radio',
              key: value,
              'aria-checked': String(groupBy === value),
              'data-control': `railgroupby:${value}`,
              onClick: () => menu.setRailGroupBy(value),
            },
            options.words.railGroupByValues[value],
          ),
        ),
      ),
    ]),
    h('div', { class: 'railfiltersection', key: 'sort' }, [
      h('div', { class: 'railfiltersectionname', id: 'railfiltersortname' }, options.words.railSortBy),
      h(
        'div',
        { class: 'railfiltermatch', role: 'radiogroup', 'aria-labelledby': 'railfiltersortname' },
        RAIL_SORTS.map((sort) =>
          h(
            'button',
            {
              type: 'button',
              class: 'railfilterlabel',
              role: 'radio',
              key: sort,
              'aria-checked': String(lens.sort === sort),
              'data-control': `railfilter-order:${sort}`,
              // The value shows the short name. Its accessible name and its hint carry the whole
              // one, so a value drawn with an arrow still says which way it runs.
              'data-hint': railSortName(sort),
              onClick: () => menu.setRailFilterSort(sort),
            },
            [
              h('span', { 'aria-hidden': 'true' }, railSortShortName(sort)),
              h('span', { class: 'sr-only' }, railSortName(sort)),
            ],
          ),
        ),
      ),
    ]),
    // How much of each session a row draws. Every value is the same card markup, and the
    // stylesheet reads `data-density` on the rail to lay it out.
    h('div', { class: 'railfiltersection', key: 'rows' }, [
      h('div', { class: 'railfiltersectionname', id: 'railrowsname' }, options.words.railRowsName),
      h(
        'div',
        { class: 'railfiltermatch', role: 'radiogroup', 'aria-labelledby': 'railrowsname' },
        RAIL_DENSITIES.map((value) =>
          h(
            'button',
            {
              type: 'button',
              class: 'railfilterlabel',
              role: 'radio',
              key: value,
              'aria-checked': String(density === value),
              'data-control': `raildensity:${value}`,
              'data-hint': densityWords[value].hint,
              onClick: () => menu.setRailDensity(value),
            },
            densityWords[value].name,
          ),
        ),
      ),
    ]),
    // Which buckets the rail draws at all. These are not filters: a filter narrows by
    // something a session is, and these two show or hide a run of sessions the rail already
    // keeps apart. A bucket that is off leaves the list and every figure together.
    h('div', { class: 'railfiltersection', key: 'show' }, [
      h('div', { class: 'railfiltersectionname' }, options.words.railFilterShow),
      ...(
        [
          ['archived', options.words.railShowArchived, shown.showArchived],
          ['runs', options.words.railShowRuns, shown.showRuns],
        ] as const
      ).map(([bucket, word, on]) =>
        h('label', { class: 'labelrow', key: bucket }, [
          h('input', {
            type: 'checkbox',
            class: 'labelbox',
            checked: on,
            'data-control': `railshow:${bucket}`,
            onChange: () => menu.toggleRailShow(bucket),
            onKeyDown: (event: KeyboardEvent) => {
              if (event.isComposing || event.keyCode === 229 || event.key !== 'Enter') {
                return;
              }
              event.preventDefault();
              menu.toggleRailShow(bucket);
            },
          }),
          h('span', { class: 'labelname' }, word),
        ]),
      ),
    ]),
    // A workspace with no labels shows the note and no Match line. A workspace with labels
    // always shows Match, because it governs every term in the query, and draws the chip group
    // only when the query or the find box leaves a chip to draw.
    h('div', { class: 'railfiltersection', key: 'labels' }, [
      h('div', { class: 'railfiltersectionname' }, options.words.railFilterLabels),
      chips.chips.length
        ? h('div', { class: 'railfilterlabels', role: 'group', 'aria-label': options.words.railFilterLabels }, [
            ...chips.chips.map((label) =>
              h(
                'button',
                {
                  type: 'button',
                  class: 'railfilterlabel',
                  key: labelKey(label.name),
                  'aria-pressed': String(railFilterTermSelected(lens.query, 'labels', label.name)),
                  'aria-label': `${label.name}, ${label.countName}`,
                  'data-control': `railfilterlabel:${label.name}`,
                  onClick: () => menu.toggleRailFilterLabel(label.name),
                },
                inlineText([
                  h('span', { class: 'railfilterlabelname', title: label.name }, label.name),
                  h('span', { class: 'railfilterlabelcount' }, String(label.count)),
                ]),
              ),
            ),
            chips.more === null
              ? null
              : h(
                  'button',
                  {
                    type: 'button',
                    class: 'railfilterlabel railfilterlabelsmore',
                    key: 'more',
                    'aria-expanded': String(labelsExpanded),
                    'data-control': 'railfilter-more-labels',
                    onClick: () => menu.toggleRailFilterLabelFold(),
                  },
                  labelsExpanded
                    ? options.words.railFilterLabelsFewer
                    : `${chips.more} ${options.words.railFilterLabelsMore}`,
                ),
          ])
        : null,
      labels.length ? null : h('div', { class: 'labelempty' }, options.words.railFilterLabelsNone),
    ]),
    h('div', { class: 'railfiltersection', key: 'saved' }, [
      h('div', { class: 'railfiltersectionname' }, options.words.railFilterPresets),
      h('div', { class: 'railfilterpicklist', role: 'radiogroup', 'aria-label': options.words.railFilterPresets }, [
        filterButton(ALL_RAIL_FILTER_ID, options.words.railFilterAll, ''),
        ...shownFilters.map((filter) => filterButton(filter.id, filter.name, filter.query)),
      ]),
    ]),
    nameMode
      ? h('div', { class: 'launchfield railfilternamefield', key: 'name' }, [
          h('label', { class: 'launchfieldname', for: 'railfiltername' }, options.words.railFilterName),
          h('input', {
            id: 'railfiltername',
            type: 'text',
            class: 'labelfind',
            value: nameMode.name,
            'data-control': 'railfilter-name',
            'aria-invalid': String(!name || nameTaken),
            ref: setNameInput,
            onInput: (event: Event) =>
              (owner as RailRenderer & { setRailFilterName(value: string): void }).setRailFilterName(
                (event.currentTarget as HTMLInputElement).value,
              ),
            onKeyDown: (event: KeyboardEvent) => {
              if (event.isComposing || event.keyCode === 229 || event.key !== 'Enter') {
                return;
              }
              event.preventDefault();
              (owner as RailRenderer & { saveNamedRailFilter(): void }).saveNamedRailFilter();
            },
          }),
          nameTaken ? h('div', { class: 'labelnote' }, options.words.railFilterNameTaken) : null,
        ])
      : null,
    h(
      'div',
      { class: 'launchactions railfilteractions', key: 'actions' },
      nameMode
        ? [
            h(
              'button',
              {
                type: 'button',
                class: 'launchback',
                'data-control': 'railfilter-name-cancel',
                onClick: () => (owner as RailRenderer & { cancelRailFilterName(): void }).cancelRailFilterName(),
              },
              options.words.railFilterCancel,
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'launchcreate',
                'data-control': 'railfilter-name-save',
                disabled: !name || nameTaken,
                onClick: () => (owner as RailRenderer & { saveNamedRailFilter(): void }).saveNamedRailFilter(),
              },
              options.words.railFilterSave,
            ),
          ]
        : [
            current && !exact
              ? h(
                  'button',
                  {
                    type: 'button',
                    class: 'launchcreate',
                    'data-control': 'railfilter-update',
                    onClick: () => (owner as RailRenderer & { updateRailFilter(): void }).updateRailFilter(),
                  },
                  options.words.railFilterSaveChanges,
                )
              : null,
            h(
              'button',
              {
                type: 'button',
                class: 'launchback',
                'data-control': 'railfilter-save-as',
                onClick: () => (owner as RailRenderer & { nameNewRailFilter(): void }).nameNewRailFilter(),
              },
              options.words.railFilterSaveAsNew,
            ),
            current
              ? h(
                  'button',
                  {
                    type: 'button',
                    class: 'launchback',
                    'data-control': 'railfilter-rename',
                    onClick: () => (owner as RailRenderer & { renameRailFilter(): void }).renameRailFilter(),
                  },
                  options.words.railFilterRename,
                )
              : null,
            current
              ? h(
                  'button',
                  {
                    type: 'button',
                    class: 'launchback railviewdelete',
                    'data-control': 'railfilter-delete',
                    onClick: () => (owner as RailRenderer & { deleteRailFilter(): void }).deleteRailFilter(),
                  },
                  deleteArmed ? options.words.railFilterDeleteConfirm : options.words.railFilterDelete,
                )
              : null,
          ],
    ),
  ]);
}

// The whole of what the reader can change about a saved view: its name, and whether it stays.
//
// Rename and delete commands on a view heading's context menu open this editor.
// A view keeps the query captured when saved, so this editor changes only its name or deletes it.
//
// The keyboard walks the way the label editor's does: the arrows and Home and End move between
// the name box and the three actions, and Escape gives up an armed delete before it gives up the
// form. Two popovers in one panel answering the arrow keys differently is a difference the
// reader meets rather than one the code has a reason for.
function ViewEditor({
  owner,
  open,
  views,
  notes,
  options,
  setInput,
}: {
  owner: RailRenderer;
  open: OpenView | null;
  views: readonly SavedView[];
  notes: readonly ViewNote[];
  options: RailOptions;
  setInput(node: HTMLInputElement | null): void;
}): ComponentChildren {
  if (!open) {
    return null;
  }
  const named = viewName(open.name);
  return h(Fragment, null, [
    h('div', { class: 'launchhead', key: 'head' }, options.words.railViewEdit),
    h('div', { class: 'launchfield', key: 'name' }, [
      h('label', { class: 'launchfieldname', for: 'viewname' }, options.words.railViewNameField),
      h('input', {
        type: 'text',
        id: 'viewname',
        class: 'labelfind',
        value: open.name,
        'data-control': 'view-name',
        // The notes under the box, named by the box, for the reason the rail's own naming box
        // names its own.
        'aria-describedby': 'viewnotes',
        'aria-invalid': notes.some((note) => note === 'unnamed' || note === 'taken') ? 'true' : undefined,
        ref: setInput,
        onInput: (event: Event) =>
          (owner as RailRenderer & { setViewName(value: string): void }).setViewName(
            (event.currentTarget as HTMLInputElement).value,
          ),
        onKeyDown: (event: KeyboardEvent) => {
          if (event.isComposing || event.keyCode === 229 || event.key !== 'Enter') {
            return;
          }
          event.preventDefault();
          (owner as RailRenderer & { saveEditedView(): void }).saveEditedView();
        },
      }),
    ]),
    h('div', { class: 'launchfield', key: 'order' }, [
      h('label', { class: 'launchfieldname', for: 'vieworder' }, 'Order'),
      h(
        'select',
        {
          id: 'vieworder',
          class: 'labelfind',
          value: open.sort,
          'data-control': 'view-order',
          onChange: (event: Event) =>
            (owner as RailRenderer & { setViewSort(value: string): void }).setViewSort(
              (event.currentTarget as HTMLSelectElement).value,
            ),
          onKeyDown: (event: KeyboardEvent) => {
            if (event.key !== 'Tab' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
              return;
            }
            event.preventDefault();
            options.document.querySelector<HTMLElement>('[data-control="view-delete"]')?.focus();
          },
        },
        [
          h('option', { value: 'inherit' }, 'Follow default order'),
          ...RAIL_SORTS.map((sort) => h('option', { value: sort }, railSortName(sort))),
        ],
      ),
    ]),
    h(
      'div',
      { class: 'railviewnotes', id: 'viewnotes', key: 'notes', role: 'status' },
      notes.map((note) => h('div', { class: 'labelnote', key: `note:${note}` }, VIEW_NOTES[note])),
    ),
    h('div', { class: 'launchactions', key: 'actions' }, [
      h(
        'button',
        {
          class: 'launchback railviewdelete',
          type: 'button',
          'data-control': 'view-delete',
          'aria-label': open.armed ? options.words.railViewDeleteConfirm : options.words.railViewDelete,
          onClick: () => (owner as RailRenderer & { pressDeleteView(): void }).pressDeleteView(),
        },
        open.armed ? options.words.railViewDeleteConfirm : options.words.railViewDelete,
      ),
      h(
        'button',
        {
          class: 'launchback',
          type: 'button',
          'data-control': 'view-cancel',
          onClick: () => (owner as RailRenderer & { closeViewEditor(back: boolean): void }).closeViewEditor(true),
        },
        options.words.railViewCancel,
      ),
      h(
        'button',
        {
          class: 'launchcreate',
          type: 'button',
          disabled: !named || viewNameTaken(views, named, open.view),
          'data-control': 'view-save',
          onClick: () => (owner as RailRenderer & { saveEditedView(): void }).saveEditedView(),
        },
        options.words.railViewSaveAction,
      ),
    ]),
  ]);
}

function withViewSort(view: SavedView, name: string, sort: SavedViewSort): SavedView {
  const edited = { ...view, name };
  if (sort === 'inherit') {
    delete edited.sort;
  } else {
    edited.sort = sort;
  }
  return edited;
}

export function createRailRenderer(options: RailOptions): RailRenderer {
  const document = options.document;
  const nav = document.createElement('nav');
  nav.id = 'rail';
  nav.hidden = true;
  nav.setAttribute('aria-label', options.words.railLabel);
  const landmarkHeading = document.createElement('h1');
  landmarkHeading.className = 'sr-only';
  landmarkHeading.textContent = options.words.railLabel;
  nav.appendChild(landmarkHeading);
  const top = document.createElement('div');
  top.className = 'railtop';
  const topMount = document.createElement('div');
  const projectSpendMount = document.createElement('div');
  projectSpendMount.className = 'projectspendrailmount';
  top.append(topMount, projectSpendMount);
  const list = document.createElement('div');
  list.className = 'raillist';
  const loadingStatus = document.createElement('p');
  loadingStatus.dataset.sessionLoadingStatus = '';
  loadingStatus.setAttribute('role', 'status');
  loadingStatus.setAttribute('aria-live', 'polite');
  loadingStatus.setAttribute('aria-atomic', 'true');
  loadingStatus.hidden = true;
  nav.append(top, list);
  nav.insertBefore(loadingStatus, list);
  document.body.insertBefore(nav, options.before);

  const sash = document.createElement('div');
  sash.id = 'railsash';
  sash.className = 'sash';
  sash.hidden = true;
  sash.tabIndex = 0;
  sash.setAttribute('role', 'separator');
  sash.setAttribute('aria-label', 'Session list width');
  sash.setAttribute('aria-orientation', 'vertical');
  sash.setAttribute('aria-controls', 'rail');
  document.body.insertBefore(sash, options.before);

  const filterPop = document.createElement('div');
  filterPop.id = 'filterpop';
  filterPop.className = 'pop';
  filterPop.hidden = true;
  filterPop.setAttribute('role', 'listbox');
  filterPop.setAttribute('aria-label', options.words.railFilterOffers);
  document.body.appendChild(filterPop);

  const labelPop = document.createElement('div');
  labelPop.id = 'labelpop';
  labelPop.className = 'pop';
  labelPop.hidden = true;
  labelPop.setAttribute('role', 'dialog');
  document.body.appendChild(labelPop);

  const viewPop = document.createElement('div');
  viewPop.id = 'viewpop';
  viewPop.className = 'pop';
  viewPop.hidden = true;
  viewPop.setAttribute('role', 'dialog');
  document.body.appendChild(viewPop);

  const renamePop = document.createElement('div');
  renamePop.id = 'sessionrenamepop';
  renamePop.className = 'pop';
  renamePop.hidden = true;
  renamePop.setAttribute('role', 'dialog');
  renamePop.setAttribute('aria-label', options.words.sessionRename);
  document.body.appendChild(renamePop);

  const railFilterPop = document.createElement('div');
  railFilterPop.id = 'railfilterpop';
  railFilterPop.className = 'pop';
  railFilterPop.hidden = true;
  railFilterPop.setAttribute('role', 'dialog');
  railFilterPop.setAttribute('aria-label', options.words.railFilters);
  document.body.appendChild(railFilterPop);

  const media = window.matchMedia(`(min-width: ${RAIL_MIN_WIDTH}px)`);
  const folds = new Map<string, boolean>(
    Object.entries(options.initial.folds).map(([id, open]) => [id, open === true]),
  );
  let filter = boundedRailFilterQuery(options.initial.filter);
  const filteredFolds = new Map<string, boolean>();
  const effectiveFilter = () => parseSessionQuery(filter).terms.length > 0;
  let width = clampRailWidth(options.initial.width);
  const widthMaximum = () => railWidthMaximum(document.documentElement.clientWidth, sash.getBoundingClientRect().width);
  const effectiveWidth = () => effectiveRailWidth(width, widthMaximum());
  let drawnWidth: number | null = null;
  const drawWidth = () => {
    const maximum = widthMaximum();
    const effective = effectiveRailWidth(width, maximum);
    const changed = effective !== drawnWidth;
    drawnWidth = effective;
    nav.style.flexBasis = `${effective}px`;
    sash.setAttribute('aria-valuemin', String(RAIL_WIDTH_MIN));
    sash.setAttribute('aria-valuemax', String(maximum));
    sash.setAttribute('aria-valuenow', String(effective));
    sash.setAttribute('aria-valuetext', `${effective} pixels`);
    return changed;
  };
  const listControls = () =>
    [...nav.querySelectorAll<HTMLElement>('button, input')].filter(
      (node) => !node.closest('[hidden]') && !(node as HTMLButtonElement).disabled,
    );
  const primaryControls = () => listControls().filter((node) => node.matches('.railcard, .railfold, .railmore'));
  const headerFocus = () => listControls().find((node) => top.contains(node)) ?? options.fallbackFocus();
  let launcherView: SessionLauncherView | null = null;
  const currentOf = (cards: readonly RailCardView[]): string | null => cards.find((card) => card.current)?.id ?? null;
  let latestCards: readonly RailCardView[] = [];
  let drawnCards: readonly RailCardView[] = [];
  let railKept: RailKept | null = null;
  // The figures the newest message carries, keyed by session id, and the three each drawn row
  // takes out of them. The drawn figures move with `drawnCards`, because a row the rail
  // retained carries the accessible name the host worded from the figures it was drawn with.
  let latestStats: Readonly<Record<string, readonly PanelStat[]>> = {};
  let drawnStats: Record<string, readonly RailStat[]> = {};
  // A compact row's hover card, built from the card and figures the rail last drew. A session
  // the rail no longer holds has no card, and the hint closes.
  options.hintBody('railcard', (anchor) => {
    const id = anchor.dataset.session;
    const card = drawnCards.find((candidate) => candidate.id === id);
    return card
      ? railHoverCard(document, railHoverLines(card, Date.now(), options.words), drawnStats[card.id] ?? NO_RAIL_STATS)
      : null;
  });
  let labels: readonly LabelSuggestionCount[] = [];
  let hasPayload = false;
  let countsKnown = false;
  let repaintOwed = false;
  // A pointer held down inside the rail is a drag the reader is still making. The rows it
  // covers stay until the button comes up, whoever asked for the session change.
  let dragging = false;
  let railToTop = false;
  let filterFrame: number | null = null;
  let filterAt = 0;
  let filterShutOn: { start: number; text: string } | null = null;
  // The magnifying glass opens the action row's box. Escape clears it before closing it.
  // Count presses preserve this state. The panel does not save it.
  let filterRowOpen = false;
  let filterInput: HTMLInputElement | null = null;
  let railNew: HTMLButtonElement | null = null;
  let railNewMenu: HTMLButtonElement | null = null;
  let labelInput: HTMLInputElement | null = null;
  let labelsOpen: OpenLabels | null = null;
  let labelsPending: PendingLabels | null = null;
  // Durable ids by the provisional id each draft ran under, newest last. A heading or a reply
  // can still name the provisional id after the adoption, and the label editor answers it as
  // the durable session.
  const adopted = new Map<string, string>();
  const current = (session: string) => adopted.get(session) ?? session;
  let labelFilter = '';
  let labelsMade: string[] = [];
  let labelArm: LabelArm | null = null;
  // The right-click this host saw on a view heading, and when. The editor's own commands reach
  // every open panel, so without this a right-click in the sidebar opens the editor in the
  // editor tab as well and pulls the reader's focus into a name box they cannot see. The label
  // editor answers its own command the same way.
  let viewArm: { view: string; node: HTMLElement; at: number } | null = null;
  let views: readonly SavedView[] = [];
  let naming: NamingView | null = null;
  let viewOpen: OpenView | null = null;
  let viewInput: HTMLInputElement | null = null;
  // The right-click this host saw on a saved session's rail row or heading, for the reason
  // `viewArm` exists. A provisional session arms nothing, so the command opens nothing from it.
  let renameArm: { session: string; node: HTMLElement; at: number } | null = null;
  let renameOpen: OpenRename | null = null;
  let renameInput: HTMLInputElement | null = null;
  // The id the last rename request carried. The host sends it back, so the editor can tell the
  // answer it waits on from the answer to a rename the reader walked away from. Each page load
  // starts the count at a random point, so an answer to a rename an earlier page sent never
  // matches a rename this page sends.
  let renameRequests = Math.floor(Math.random() * 2 ** 40);
  let now = Date.now();
  // The rows the last draw put on screen, and the time whose wording they carry. The clock
  // tick reads these instead of the page: a row under a shut heading is not among them, so it
  // cannot ask for a repaint nobody would see.
  let drawnRows: RailTickRow[] = [];
  // The Show more presses a reader made, per query and section. The key holds the query, so a
  // new query starts every section at its first step with no reset, and a query the reader
  // returns to keeps what they pressed for. Each entry is one small number, so a query change
  // drops none. A reset clears the map, and a deleted view takes its own entries with it.
  const railRaised = new Map<string, number>();
  const railRaisedKey = (section: string) => `${filter}\u0000${section}`;
  // The section whose Show more press the next draw answers, once. The draw raises it from the
  // layout it computes anyway, so a press costs one layout.
  let raisePending: string | null = null;
  let drawnTitlesAt = now;
  // Naming holds the last drawn cache information until the reader saves or cancels.
  let drawnCounts: RailCounts | null = null;
  let railFilters: readonly SavedRailFilter[] = [];
  let railFilterId = typeof options.initial.filterId === 'string' ? options.initial.filterId : ALL_RAIL_FILTER_ID;
  let railSort = normalizeRailSort(options.initial.sort);
  let railDefaultSort =
    options.initial.defaultSort === undefined ? railSort : normalizeRailSort(options.initial.defaultSort);
  let railShowArchived = normalizeRailShowArchived(options.initial.showArchived);
  let railShowRuns = normalizeRailShowRuns(options.initial.showRuns);
  let railQuickFilters = normalizeRailQuickFilters(options.initial.headLenses);
  let railGroupBy = normalizeRailGroupBy(options.initial.groupBy);
  let railDensity = normalizeRailDensity(options.initial.density);
  nav.dataset.density = railDensity;
  const shownBuckets = (): RailCountsOptions => ({
    showArchived: railShowArchived,
    showRuns: railShowRuns,
  });
  let railFilterOpen = false;
  let railFilterSearch = '';
  let railFilterButton: HTMLButtonElement | null = null;
  let railFilterSearchInput: HTMLInputElement | null = null;
  let railFilterNameInput: HTMLInputElement | null = null;
  let railFilterNameMode: RailFilterNameMode | null = null;
  let railFilterDeleteArmed = false;
  // Set by a press outside the open View menu and read when that press ends, once the
  // browser has moved focus to wherever the press landed.
  let railFilterFocusBack = false;
  // Whether the View menu draws every label chip rather than the most used twelve. It folds
  // again whenever the menu closes.
  let railFilterLabelsExpanded = false;

  const snapshot = (): RailSnapshot => ({
    filter,

    filterId: railFilterId,
    width,
    folds,
    sort: railSort,
    defaultSort: railDefaultSort,
    showArchived: railShowArchived,
    showRuns: railShowRuns,
    headLenses: railQuickFilters,
    groupBy: railGroupBy,
    density: railDensity,
  });
  const visible = () => hasPayload && media.matches;
  // Whether anything the pool reaches asks about the cache or the recency window. The text
  // box is one reader of it and every saved view is another, because `railSections` runs each
  // view's query over these same cards. A view holding `is:warm` or `is:active` therefore
  // keeps nothing while the box is empty unless the fact is stamped for it as well.
  const poolReadsCache = (): boolean =>
    railQueryReadsCache(filter) || views.some((view) => railQueryReadsCache(view.query));
  const narrowing = (): RailNarrowing => ({ query: filter });
  // Every query change goes through here and empties the kept set immediately.
  // Changing the query and putting it back before the next draw also starts the set again.
  const setRailQuery = (query: string) => {
    if (query !== filter) {
      railKept = null;
      filteredFolds.clear();
    }
    filter = query;
  };
  // The cards the query keeps. `is:warm`, `is:active` and `is:needsyou` are the terms whose
  // answer the card does not carry, so `railShownCards` stamps both clock facts on only for
  // the draws where the box or a saved view asks about one of them.
  //
  // Under the Unread or Needs input lens the rail keeps what it drew, so a session the reader
  // reads or answers stays until the query changes. `railKept` is that set. It lives only here,
  // so a panel reload starts it empty, and `setRailQuery` empties it.
  const shownCards = (): RailMatchCard[] => {
    const rail = narrowing();
    const shown = railShownCards(drawnCards, rail, now, poolReadsCache(), railKept);
    railKept = railKeptAfter(rail, shown);
    return shown;
  };
  // Cache information reads the newest payload. Cache readings share the current query and Show switches.
  let counted: {
    cards: readonly RailCardView[];
    at: number;
    rail: RailNarrowing;
    shown: RailCountsOptions;
    counts: RailCounts;
  } | null = null;
  const headCounts = (at: number): RailCounts => {
    const rail = narrowing();
    const shown = shownBuckets();
    const held = counted;
    if (
      held &&
      held.cards === latestCards &&
      held.at === at &&
      held.rail.query === rail.query &&
      held.shown.showArchived === shown.showArchived &&
      held.shown.showRuns === shown.showRuns
    ) {
      return held.counts;
    }
    const counts = railHeadCounts(latestCards, shown, at, rail);
    counted = { cards: latestCards, at, rail, shown, counts };
    return counts;
  };
  const viewOfSection = (id: string): SavedView | null => views.find((view) => viewFoldId(view) === id) ?? null;
  // The rail's sections and which of them are shut.
  //
  // `railSections` answers what the sections are and how each one starts, and the reader's own
  // presses are laid over that. A narrowing filter opens everything the reader did not press themselves,
  // because a query that reaches into a shut section would otherwise find nothing on screen.
  const layout = () => {
    const grouped = railSections(shownCards(), now, views, 'latest', shownBuckets(), { groupBy: railGroupBy });
    const ordered = grouped.sections.map((section) => {
      const view = viewOfSection(section.id);
      const sort = view?.sort && view.sort !== 'inherit' ? view.sort : railSort;
      return { ...section, cards: sortRailCards(section.cards, sort), sort };
    });
    const filtering = effectiveFilter();
    const sections = filtering ? ordered.filter((section) => section.cards.length > 0) : ordered;
    const folded: Record<string, boolean> = {};
    for (const [id, shut] of Object.entries(grouped.folded)) {
      folded[id] = filtering ? !(filteredFolds.get(id) ?? true) : folds.has(id) ? !folds.get(id) : shut;
    }
    return { sections, folded, filtering };
  };
  const filterWord = (): QueryToken => queryToken(filterInput?.value ?? filter, filterInput?.selectionStart ?? 0);
  const filterShutWord = (word: QueryToken) => ({
    start: word.start,
    text: (filterInput?.value ?? filter).slice(word.start, word.end),
  });
  const filterOffers = (word: QueryToken): FilterOffer[] => {
    // A word opening on the negation mark asks for the sessions its term drops. The list
    // reads the rest of the word as any other, writes the mark back onto every row it
    // offers, and says `Filter out` where it would otherwise say `Filter by`. A reader who
    // has typed the mark alone is offered every axis under it, which is where the box
    // teaches the mark.
    const negated = (word.prefix || word.value).startsWith(NEGATE_MARK);
    const prefix = negated && word.prefix ? word.prefix.slice(1) : word.prefix;
    const value = negated && !word.prefix ? word.value.slice(1) : word.value;
    const mark = negated ? NEGATE_MARK : '';
    const take = negated ? options.words.railFilterWithout : options.words.railFilterTake;
    if (prefix === IS_PREFIX) {
      return IS_VALUES.filter((status) => status.startsWith(value.toLowerCase())).map((status) => ({
        key: `is:${mark}${status}:${word.start}`,
        token: `${mark}${IS_PREFIX}:${status}`,
        start: word.start,
        end: word.end,
        whole: true,
        axis: `${IS_PREFIX}:`,
        name: `${mark}${IS_PREFIX}:${status}`,
        count: '',
        said: `${take} ${IS_PREFIX}: ${status}`,
      }));
    }
    if (prefix === LABEL_PREFIX) {
      return labelSuggestions(labels, value).map((row) => ({
        key: `label:${mark}${row.token}:${word.start}`,
        token: `${mark}${row.token}`,
        start: word.start,
        end: word.end,
        whole: true,
        axis: `${LABEL_PREFIX}:`,
        name: `${mark}${row.name}`,
        count: String(row.count),
        said: `${take} ${LABEL_PREFIX} ${row.name}, ${row.countName}`,
      }));
    }
    if (prefix || (!value && !negated)) {
      return [];
    }
    const typed = value.toLowerCase();
    return SESSION_AXES.filter((axis) => axis.prefix.startsWith(typed)).map((axis) => ({
      key: `axis:${mark}${axis.prefix}:${word.start}`,
      token: `${mark}${axis.prefix}:`,
      start: word.start,
      end: word.end,
      whole: false,
      axis: '',
      name: `${mark}${axis.prefix}:`,
      count: '',
      said: `${take} ${axis.prefix}`,
    }));
  };
  const currentFilterRows = (): FilterOffer[] => {
    // The box holds a name while a view is being saved, and a name is not a query. An offer
    // taken over one replaces the word under the caret, which is the name the reader typed,
    // and the query being saved is not in the box to put back.
    if (naming) {
      return [];
    }
    if (document.activeElement !== filterInput) {
      return [];
    }
    const word = filterWord();
    const here = filterShutWord(word);
    if (filterShutOn && filterShutOn.start === here.start && filterShutOn.text === here.text) {
      return [];
    }
    return filterOffers(word);
  };
  const placeFilterPop = () => {
    if (filterPop.hidden || !filterInput) {
      return;
    }
    const wrap = filterInput.closest('.railbox');
    if (!wrap) {
      return;
    }
    const at = filterInput.getBoundingClientRect();
    filterPop.style.width = `${Math.max(0, Math.min(at.width, window.innerWidth - 12))}px`;
    placeFloat(window, filterPop, filterInput, { around: wrap as HTMLElement, gap: 0, overflow: 'slide' });
  };

  // toggleRailFilterLabel, toggleBucket and saveEditedView each end in the rail's full list draw.
  // The methods documented on RailRenderer above follow the same rule.
  let owner = null as unknown as RailRenderer & {
    toggleBucket(id: string): void;
    setLabelFilter(value: string): void;
    labelInputKeydown(event: KeyboardEvent): void;
    createLabel(name: string): void;
    setLabelApplied(name: string, applied: boolean): void;
    togglePinned(card: RailCardView): void;
    setViewName(value: string): void;
    saveEditedView(): void;
    pressDeleteView(): void;
    closeViewEditor(back: boolean): void;
    selectRailFilter(id: string): void;
    setRailFilterSearch(value: string): void;
    setRailFilterSort(value: string): void;
    setRailLens(value: string): void;
    setRailGroupBy(value: string): void;
    setRailDensity(value: string): void;
    toggleRailShow(value: string): void;
    toggleRailHeadLens(value: string): void;
    toggleRailFilterLabel(value: string): void;
    toggleRailFilterLabelFold(): void;
    updateRailFilter(): void;
    nameNewRailFilter(): void;
    renameRailFilter(): void;
    deleteRailFilter(): void;
    setRailFilterName(value: string): void;
    saveNamedRailFilter(): void;
    cancelRailFilterName(): void;
  };

  const takeFilterRow = (row: FilterOffer) => {
    if (!filterInput) {
      return;
    }
    const written = replaceToken(filterInput.value, row.start, row.end, row.token);
    setRailQuery(boundedRailFilterQuery(written.query));
    filterInput.value = filter;
    filterShutOn = row.whole ? { start: row.start, text: row.token } : null;
    filterAt = 0;
    filterInput.focus();
    const caret = Math.min(written.caret, filter.length);
    filterInput.setSelectionRange(caret, caret);
    scheduleFilterDraw();
    drawFilterPop();
  };
  const drawFilterPop = () => {
    const rows = currentFilterRows();
    if (filterAt >= rows.length) {
      filterAt = 0;
    }
    filterPop.hidden = rows.length === 0;
    // The box is a combobox over the offers, and while it is taking a view name it is not one
    // at all. The state written here would outlive the roles the draw took off, and a box
    // reporting a list it does not have is a box a reader is told the wrong thing about.
    if (naming) {
      filterInput?.removeAttribute('aria-expanded');
    } else {
      filterInput?.setAttribute('aria-expanded', String(rows.length > 0));
    }
    if (!rows.length) {
      filterInput?.removeAttribute('aria-activedescendant');
      render(null, filterPop);
      return;
    }
    filterInput?.setAttribute('aria-activedescendant', `filterrow${filterAt}`);
    render(h(FilterRows, { rows, selected: filterAt, take: takeFilterRow }), filterPop);
    placeFilterPop();
    filterPop.querySelector('.filterrow.on')?.scrollIntoView?.({ block: 'nearest' });
  };
  // One frame for a burst of typing. It saves the query, reads the clock once, counts the head
  // for the new query and draws the list. A keystroke's own head draw keeps the figures already
  // on screen, so a burst runs the count match once.
  const drawFilterFrame = () => {
    filterFrame = null;
    options.save();
    now = Date.now();
    drawTop();
    drawList();
  };
  const scheduleFilterDraw = () => {
    if (filterFrame !== null) {
      return;
    }
    filterFrame = requestAnimationFrame(drawFilterFrame);
  };
  // The cross closes the emptied box. Escape keeps it open after clearing.
  const clearFilter = (close = true) => {
    setRailQuery('');
    filterRowOpen = !close;
    if (filterInput) {
      filterInput.value = '';
    }
    if (filterFrame !== null) {
      cancelAnimationFrame(filterFrame);
      filterFrame = null;
    }
    filterShutOn = null;
    filterAt = 0;
    options.save();
    drawTop();
    drawList();
    focusFilterRow();
    drawFilterPop();
  };
  // Where focus lands after the box empties or closes. A box still on the head keeps it. A box
  // that has closed hands focus back to the magnifying glass that opened it, so a close never
  // drops the reader on the page.
  const focusFilterRow = () => {
    (filterInput ?? found(topMount, 'railsearch') ?? railFilterButton)?.focus();
  };
  // An empty box hands focus back to the magnifying glass when Escape closes it.
  const closeFilterBox = () => {
    filterRowOpen = false;
    if (filterFrame !== null) {
      cancelAnimationFrame(filterFrame);
      filterFrame = null;
      drawList();
    }
    filterShutOn = null;
    filterAt = 0;
    options.save();
    drawTop();
    focusFilterRow();
    drawFilterPop();
  };
  const openFilterBox = () => {
    filterRowOpen = true;
    drawTop();
    filterInput?.focus();
    drawFilterPop();
  };

  const liveRailFilter = (): RailFilterLens => ({
    query: railFilterQuery(filter),
    sort: railSort,
  });
  const selectedRailFilterLens = (): RailFilterLens | null => {
    if (railFilterId === ALL_RAIL_FILTER_ID) {
      return { query: '', sort: railDefaultSort };
    }
    return findRailFilter(railFilters, railFilterId);
  };
  // Whether the rail is still on the saved lens its id names. The funnel words a rail that
  // is not Custom.
  const railFilterSelected = (): boolean => {
    const expected = selectedRailFilterLens();
    return Boolean(expected && sameRailFilterLens(expected, liveRailFilter()));
  };
  // A query over All sessions that holds one lens's words and nothing else is named for the
  // lens, whatever the word order and whatever sort the reader chose, because a lens press keeps
  // the sort. Other words beside the lens's words read Custom.
  const railFilterWord = (): string => {
    const lens = railFilterId === ALL_RAIL_FILTER_ID ? railQueryLens(filter) : null;
    if (lens !== null) {
      return options.words.railNarrowToValues[lens];
    }
    if (!railFilterSelected()) {
      return options.words.railFilterCustom;
    }
    if (railFilterId === ALL_RAIL_FILTER_ID) {
      return options.words.railFilterAll;
    }
    return findRailFilter(railFilters, railFilterId)?.name ?? options.words.railFilterCustom;
  };
  const placeRailFilterPop = () => {
    if (!railFilterOpen || railFilterPop.hidden || !railFilterButton) {
      return;
    }
    placeFloat(window, railFilterPop, railFilterButton, { gap: 4, overflow: 'slide' });
  };
  const drawRailFilterPop = (focusControl?: string | null) => {
    railFilterPop.hidden = !railFilterOpen;
    const active = document.activeElement as HTMLElement | null;
    const held = active && railFilterPop.contains(active) ? (active.dataset.control ?? null) : null;
    render(
      h(RailFilterPicker, {
        owner,
        open: railFilterOpen,
        filters: railFilters,
        filterId: railFilterId,
        lens: liveRailFilter(),
        defaultSort: railDefaultSort,
        shown: shownBuckets(),
        headLenses: railQuickFilters,
        groupBy: railGroupBy,
        density: railDensity,
        // A session a Show switch hides leaves the chip counts with the list.
        labels: railShownLabelCounts(labels, latestCards, shownBuckets()),
        labelsExpanded: railFilterLabelsExpanded,
        search: railFilterSearch,
        nameMode: railFilterNameMode,
        deleteArmed: railFilterDeleteArmed,
        options,
        setSearchInput: (node) => {
          railFilterSearchInput = node;
        },
        setNameInput: (node) => {
          railFilterNameInput = node;
        },
      }),
      railFilterPop,
    );
    if (!railFilterOpen) {
      return;
    }
    const wanted = focusControl || held;
    const target = wanted ? found(railFilterPop, wanted) : null;
    if (target && target !== document.activeElement) {
      target.focus();
    }
    placeRailFilterPop();
  };
  const closeRailFilterPicker = (returnFocus: boolean) => {
    railFilterOpen = false;
    railFilterSearch = '';
    railFilterNameMode = null;
    railFilterDeleteArmed = false;
    railFilterLabelsExpanded = false;
    if (railFilterSearchInput) {
      railFilterSearchInput.value = '';
    }
    drawRailFilterPop();
    drawTop();
    if (returnFocus && railFilterButton?.isConnected) {
      railFilterButton.focus();
    }
  };
  const setLiveRailFilter = (lens: RailFilterLens, id: string, draw = true) => {
    setRailQuery(railFilterQuery(lens.query));
    railSort = lens.sort;
    railFilterId = id;
    // While the reader names a view the box holds the name, and `naming` holds the query being
    // named, so a filter change leaves the box alone.
    if (filterInput && !naming) {
      filterInput.value = filter;
    }
    if (filterFrame !== null) {
      cancelAnimationFrame(filterFrame);
      filterFrame = null;
    }
    filterShutOn = null;
    filterAt = 0;
    options.save();
    if (!draw) {
      return;
    }
    drawTop();
    drawList();
    drawFilterPop();
  };
  // A filter press sets or clears its lens words and preserves other query words, sort order, and selected filter identity.
  // Focus moves to the selected button, else the first button, else the funnel.
  // Removing a shortcut uses the same focus rule.
  const restoreRailCountFocus = () => {
    const count = drawnCountButtons.find((each) => each.pressed) ?? drawnCountButtons[0];
    ((count ? found(topMount, count.control) : null) ?? found(topMount, 'railfilters'))?.focus();
  };
  const pressRailCount = (kind: RailCountKind) => {
    if (naming) {
      return;
    }
    setLiveRailFilter({ ...liveRailFilter(), query: pressRailLens(filter, kind) }, railFilterId);
    restoreRailCountFocus();
  };
  const postRailFilters = (next: SavedRailFilter[]) => {
    railFilters = next;
    options.sendToHost({ type: 'setRailFilters', railFilters: next });
  };
  const filterKeydown = (event: KeyboardEvent): boolean => {
    if (event.isComposing || event.keyCode === 229) {
      return false;
    }
    const rows = currentFilterRows();
    if (!rows.length) {
      return false;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      filterAt = (filterAt + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
      drawFilterPop();
      return true;
    }
    if (
      (event.key === 'Enter' || event.key === 'Tab') &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      event.stopPropagation();
      takeFilterRow(rows[filterAt]);
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      filterShutOn = filterShutWord(filterWord());
      drawFilterPop();
      return true;
    }
    return false;
  };

  const railSortChangesDefault = () => railFilterId === ALL_RAIL_FILTER_ID && !filter && railSort === railDefaultSort;
  const selectRailFilterSort = (sort: RailSort) => {
    const changesDefault = railSortChangesDefault();
    railSort = sort;
    if (changesDefault) {
      railDefaultSort = sort;
    }
    drawTop();
    drawList();
    drawRailFilterPop(`railfilter-order:${sort}`);
    options.save();
  };

  // The action row opens its box for search or saved-view naming.
  const boxOpen = (): boolean => filterRowOpen || Boolean(naming);
  // The count presentation stays until ordinary input's frame draws fresh figures.
  // Naming holds this presentation while the box takes the name.
  let drawnCountButtons: RailCountButton[] = [];
  // Whether the counts hold figures from before the reader started naming a view. Neither a
  // keystroke nor a tick counts them then, so the draw that ends naming counts at the current time.
  let countsHeld = false;
  // `counted` carries figures a caller already matched, such as the clock tick, so the head
  // draws them without running the same match again. `keepCounts` draws the figures already on
  // screen, for a keystroke whose frame counts the new query.
  const drawTop = (counted?: RailCounts, keepCounts = false) => {
    const view = launcherView;
    const primaryName = view
      ? newSessionName(view.words.primaryName, options.platform)
      : UNREADY_LAUNCHER_WORDS.primaryName;
    const railLabel = view?.words.railLabel ?? options.words.railLabel;
    nav.setAttribute('aria-label', railLabel);
    // A count that holds focus and leaves the head in this draw hands focus on by the press rule.
    const focused = document.activeElement;
    const focusedCount =
      focused instanceof HTMLElement && topMount.contains(focused) && focused.dataset.control?.startsWith('railcount:')
        ? focused
        : null;
    const invalidCost = naming ? null : costNote(filter);
    // Read the same way `invalidCost` is: an invalid `cache-expiry:` value gets its own note
    // and DOM id, so the box never conflates the two axes' corrections.
    const invalidCacheExpiry = naming ? null : cacheExpiryNote(filter);
    const open = boxOpen();
    // Active reads current cache information within the query and shown buckets.
    // Naming holds the last drawn buttons, counts and cache information.
    if ((!naming && !keepCounts) || drawnCounts === null) {
      drawnCounts = counted ?? headCounts(countsHeld ? Date.now() : now);
      drawnCountButtons = railCountButtons(
        countsKnown ? drawnCounts : null,
        { filterId: railFilterId, query: railFilterQuery(filter) },
        {
          running: options.words.railNarrowToValues.running,
          active: options.words.railCountActive,
          unread: options.words.railNarrowToValues.unread,
          input: options.words.railNarrowToValues.input,
          cacheWarm: options.words.railCountCacheWarm,
          cacheExpiring: options.words.railCountCacheExpiring,
          cacheNone: options.words.railCountCacheNone,
          session: options.words.railCountSession,
          sessions: options.words.railCountSessions,
          runningHint: options.words.railCountRunningHint,
          activeHint: options.words.railCountActiveHint,
          unreadHint: options.words.railCountUnreadHint,
          inputHint: options.words.railCountInputHint,
          pressedHint: options.words.railCountPressedHint,
        },
        railQuickFilters,
      );
    }
    countsHeld = Boolean(naming);
    const counts = drawnCountButtons;
    const filtersButton = h(
      'button',
      {
        class: 'railfiltersbutton',
        type: 'button',
        'data-control': 'railfilters',
        key: 'filters',
        ref: (node: HTMLButtonElement | null) => {
          railFilterButton = node;
        },
        'aria-haspopup': 'dialog',
        'aria-expanded': String(railFilterOpen),
        'aria-controls': 'railfilterpop',
        'aria-label': `${options.words.railFilters}, ${railFilterWord()}, ${railSortName(railSort)}`,
        'data-hint': options.words.railFiltersHint,
        'data-hint-detail': `${railFilterWord()} · ${railSortName(railSort)}`,
        onClick: () => {
          const opening = !railFilterOpen;
          if (!opening) {
            closeRailFilterPicker(true);
            return;
          }
          if (labelsOpen) {
            closeLabelEditor(false);
          }
          if (viewOpen) {
            closeViewEditor(false);
          }
          if (renameOpen) {
            closeSessionRename(false);
          }
          railFilterOpen = true;
          railFilterSearch = '';
          railFilterNameMode = null;
          railFilterDeleteArmed = false;
          railFilterLabelsExpanded = false;
          drawTop();
          drawRailFilterPop('railfilter-find');
        },
      },
      h(
        'svg',
        {
          class: `railfiltersicon${railFilterWord() === options.words.railFilterAll && railSort === railDefaultSort ? '' : ' active'}`,
          viewBox: '0 0 16 16',
          width: '16',
          height: '16',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', { d: 'M2 3h12l-5 5v4l-2 1V8z' }),
      ),
    );
    render(
      h(Fragment, null, [
        h('div', { class: 'filterwrap railbox railfilterrow', key: 'filter' }, [
          // The rail head: the Sessions heading, the box while it is open, then the two tools and
          // the New split. The heading is read-only text and adds no stop to the tab order.
          h('div', { class: `railhead${open ? ' boxopen' : ''}`, key: 'head' }, [
            h('span', { class: 'railheadlabel', key: 'label' }, railLabel),
            // One box, and two things to type into it. While the reader is naming a view it holds
            // the name, because the query it held a press ago is what they are naming and a
            // second box over the top of it would cover the thing being named.
            open
              ? h(
                  'div',
                  { class: 'railfilterbox', key: 'box' },
                  h('input', {
                    type: 'text',
                    class: 'railfilter',
                    defaultValue: filter,
                    maxLength: RAIL_FILTER_QUERY_LIMIT,
                    placeholder: naming ? options.words.railViewName : options.words.railFilterHint,
                    role: naming ? undefined : 'combobox',
                    'aria-autocomplete': naming ? undefined : 'list',
                    'aria-controls': naming ? undefined : 'filterpop',
                    'aria-expanded': naming ? undefined : 'false',
                    'aria-label': naming ? options.words.railViewName : options.words.railFilter,
                    // What is wrong with the name, and what the key under it does, both pointed at from
                    // the box the reader is typing in. A note drawn beside a box and not named by it is
                    // a note a reader without a pointer never meets. Both axes can be invalid at once,
                    // and the box must name both notes it draws.
                    'aria-describedby': naming
                      ? 'railviewnotes'
                      : [invalidCost ? 'railcostnote' : null, invalidCacheExpiry ? 'railcacheexpirynote' : null]
                          .filter(Boolean)
                          .join(' ') || undefined,
                    'aria-invalid': naming
                      ? namingRefused()
                        ? 'true'
                        : undefined
                      : invalidCost || invalidCacheExpiry
                        ? 'true'
                        : undefined,
                    'data-control': 'railfilter',
                    ref: (node: HTMLInputElement | null) => {
                      filterInput = node;
                    },
                    onInput: (event: Event) => {
                      const typed = (event.currentTarget as HTMLInputElement).value;
                      if (naming) {
                        naming = { ...naming, name: typed };
                        drawTop();
                        return;
                      }
                      setRailQuery(boundedRailFilterQuery(typed));
                      if (filter !== typed) {
                        (event.currentTarget as HTMLInputElement).value = filter;
                      }
                      filterAt = 0;
                      scheduleFilterDraw();
                      drawTop(undefined, true);
                      drawFilterPop();
                    },
                    onKeyDown: (event: KeyboardEvent) => {
                      if (event.isComposing || event.keyCode === 229) {
                        return;
                      }
                      if (naming) {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          saveNamedView();
                          return;
                        }
                        if (event.key !== 'Escape') {
                          return;
                        }
                        event.preventDefault();
                        event.stopPropagation();
                        stopNaming();
                        return;
                      }
                      if (filterKeydown(event)) {
                        return;
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        event.stopPropagation();
                        if (filter) {
                          clearFilter(false);
                        } else {
                          closeFilterBox();
                        }
                        return;
                      }
                    },
                    onFocus: drawFilterPop,
                    onBlur: () => {
                      filterShutOn = null;
                      drawFilterPop();
                    },
                    onKeyUp: drawFilterPop,
                    onClick: drawFilterPop,
                  }),
                )
              : null,
            // The magnifying glass opens the box, and the cross takes its place while the box is
            // open. The funnel opens the View menu from the same place in both.
            h('span', { class: 'railfiltertools', key: 'tools' }, [
              open
                ? h(
                    'button',
                    {
                      // Clears the query and closes the box. The name says which of the two the press
                      // does to the reader's query.
                      class: 'filterclear',
                      type: 'button',
                      key: 'clear',
                      'aria-label': naming
                        ? options.words.railViewNameCancel
                        : filter
                          ? options.words.railFilterClear
                          : options.words.railFilterClose,
                      'data-control': naming ? 'railviewnamecancel' : 'railclear',
                      onClick: () => (naming ? stopNaming() : clearFilter()),
                    },
                    options.cross,
                  )
                : h(
                    'button',
                    {
                      class: 'railsearchbutton',
                      type: 'button',
                      'data-control': 'railsearch',
                      key: 'search',
                      // The button carries no `aria-expanded`. The box replaces the count rather than
                      // opening under the button, so there is nothing here for a reader to watch expand.
                      'aria-label': options.words.railSearch,
                      'data-hint': options.words.railSearchHint,
                      onClick: openFilterBox,
                    },
                    h(
                      'svg',
                      {
                        viewBox: '0 0 16 16',
                        width: '16',
                        height: '16',
                        'aria-hidden': 'true',
                        focusable: 'false',
                      },
                      [h('circle', { cx: '6.5', cy: '6.5', r: '4.2' }), h('path', { d: 'M9.8 9.8 14 14' })],
                    ),
                  ),
              filtersButton,
            ]),
            // The New split closes the head, after the funnel, so a reader tabbing through the rail meets
            // the filters before the launcher. Its key keeps the node, and the `railNew` ref and any
            // focus on it, across every redraw of the head.
            h('span', { class: 'railnewsplit', key: 'new-split' }, [
              h(
                'button',
                {
                  class: 'railnew',
                  ref: (node: HTMLButtonElement | null) => {
                    railNew = node;
                  },
                  disabled: !view,
                  'aria-label': primaryName || undefined,
                  'aria-keyshortcuts': view ? newSessionKeyshortcut(options.platform) : undefined,
                  'data-hint': primaryName || undefined,
                  'data-hint-detail': view?.words.primaryDetail,
                  onClick: () =>
                    options.sendToHost({
                      type: 'newSession',
                      ...(view?.owner === undefined ? {} : { owner: view.owner }),
                    }),
                },
                view?.words.primaryLabel ?? UNREADY_LAUNCHER_WORDS.primaryLabel,
              ),
              h(
                'button',
                {
                  class: 'railnewmenu',
                  ref: (node: HTMLButtonElement | null) => {
                    railNewMenu = node;
                  },
                  disabled: !view,
                  'aria-haspopup': 'dialog',
                  'aria-controls': 'launcher',
                  'aria-expanded': String(options.launcher.open() && options.launcher.anchor() === railNewMenu),
                  'aria-label': view?.words.menuName ?? UNREADY_LAUNCHER_WORDS.menuName,
                  'data-hint': view?.words.menuName,
                  onClick: (event: MouseEvent) => options.launcher.toggle(event.currentTarget as HTMLElement),
                },
                options.twist.shut,
              ),
            ]),
          ]),
          // Both axes draw their own note when both are invalid, so a reader correcting one
          // value is not left wondering whether the other has been read at all.
          [
            invalidCost
              ? h(
                  'div',
                  {
                    class: 'railviewnotes',
                    id: 'railcostnote',
                    key: 'costnote',
                    role: 'status',
                  },
                  h('div', { class: 'labelnote' }, invalidCost),
                )
              : null,
            invalidCacheExpiry
              ? h(
                  'div',
                  {
                    class: 'railviewnotes',
                    id: 'railcacheexpirynote',
                    key: 'cacheexpirynote',
                    role: 'status',
                  },
                  h('div', { class: 'labelnote' }, invalidCacheExpiry),
                )
              : null,
          ],
          // The offer to keep the query, under the box it was typed into and only while the box
          // is open. A count press leaves the count on the head with the box closed, and an
          // offer there would ask the reader to name something the head already gives them in
          // one press. A rail nobody has filtered pays nothing for this.
          open && !naming && viewFiles(filter) && !invalidCost && !invalidCacheExpiry
            ? h(
                'button',
                {
                  class: 'launchrow railviewsave',
                  type: 'button',
                  key: 'viewsave',
                  'data-control': 'railviewsave',
                  'aria-label': options.words.railViewSave,
                  onClick: startNaming,
                },
                [h('span', { class: 'launchname' }, options.words.railViewSave)],
              )
            : null,
          // What is wrong with the name and what the key under it does, in one region the box
          // names. It reports itself, so a note that arrives while the reader types is spoken
          // rather than waiting for them to go looking for it.
          naming
            ? h(
                'div',
                {
                  class: 'railviewnotes',
                  id: 'railviewnotes',
                  key: 'viewnotes',
                  role: 'status',
                },
                [
                  ...namingNotes().map((note) =>
                    h('div', { class: 'labelnote', key: `viewnote:${note}` }, VIEW_NOTES[note]),
                  ),
                  h('div', { class: 'labelnote railviewnamehint', key: 'viewkey' }, options.words.railViewNameKey),
                ],
              )
            : null,
          // Filter buttons stay live under the open box. Naming holds their counts and disables presses.
          h(
            'div',
            { class: 'railcounts', key: 'counts' },
            counts.map((count) =>
              h(
                'button',
                {
                  type: 'button',
                  class: 'railcount',
                  key: count.control,
                  'data-control': count.control,
                  'aria-pressed': String(count.pressed),
                  'aria-label': count.name,
                  'data-hint': count.hint,
                  // The cache sentence already ends the name, so the hint shows it without a
                  // description that would say it twice.
                  'data-hint-detail': count.cacheDetail ?? undefined,
                  'data-hint-description': count.cacheDetail ? '' : undefined,
                  disabled: Boolean(naming),
                  onClick: () => pressRailCount(count.kind),
                },
                inlineText([
                  h('span', { class: 'railcountname' }, count.label),
                  count.figure ? h('span', { class: 'railcountfig' }, count.figure) : null,
                  count.cacheState ? cacheIcon(count.cacheState, null, now) : null,
                ]),
              ),
            ),
          ),
        ]),
      ]),
      topMount,
    );
    if (focusedCount && !focusedCount.isConnected) {
      restoreRailCountFocus();
    }
  };

  // The whole list goes to the host on every change, the way a session's labels do, and
  // the panel adopts it at once rather than waiting to be told. The rail redraws under the
  // reader's press, and the next rail message replaces what is held here.
  // Every write posts the whole list, where a label write posts one session.
  //
  // Two panels can hold the list at once, so a write built on a stale copy drops what the other
  // one saved. The window is one message: the host stores the list and posts the rail back to
  // every panel inside the same turn, so a second panel is level again before a reader reaches
  // a control. Closing it properly needs a tombstone per deleted view, to tell a delete from a
  // panel that never saw the view at all, and that is state this feature does not otherwise
  // need.
  const postViews = (next: SavedView[]) => {
    pruneViewFolds(next);
    views = next;
    options.sendToHost({ type: 'setViews', views: next });
  };
  // What the box has to say about the name in it. Read in two places, the box's own state and
  // the region under it, so the two cannot disagree about whether the name is good.
  const namingNotes = (): readonly ViewNote[] =>
    naming ? [...viewQueryNotes(naming.lens.query), ...viewTypedNotes(views, naming.name, '')] : [];
  // Whether the name in the box is one the save will refuse. The limit note is advice about a
  // cut the reader cannot see, and the name it warns about is stored, so it marks nothing
  // invalid: a box that reports invalid over a name it then accepts teaches the reader to
  // ignore the state.
  const namingRefused = (): boolean => namingNotes().some((note) => note === 'unnamed' || note === 'taken');
  // Where the reader is left once the view they deleted takes its heading with it.
  //
  // The popover hung off that heading, so an ordinary close has nothing to hand focus back to
  // and drops the reader on the document. Three answers in order: the first heading the rail
  // still draws, then the filter box, then whatever the panel
  // offers when the rail itself is down. A rail with no heading and no box is a panel with no
  // rail, and the last of the three is the same fallback every other rail path uses.
  // The folds of views the list no longer holds. `nextViewId` fills the gap a delete left, so a
  // view made after one is deleted takes the same id, and a fold nobody swept would hand it the
  // deleted view's open or shut state. The local delete drops its own, and this catches the
  // delete another panel made. The Show more presses under a gone view go the same way, or the
  // next view to take its id would open with the rows the deleted one was raised to.
  // Prune before replacing the saved views list.
  const pruneViewFolds = (next: readonly SavedView[]): void => {
    const live = new Set(next.map((one) => viewFoldId(one)));
    const before = new Map(views.map((one) => [viewFoldId(one), one]));
    const changed = new Set(
      next
        .filter((one) => {
          const was = before.get(viewFoldId(one));
          return !!was && was.query !== one.query;
        })
        .map((one) => viewFoldId(one)),
    );
    for (const choices of [folds, filteredFolds]) {
      for (const key of [...choices.keys()]) {
        if (key.startsWith(VIEW_FOLD_PREFIX) && !live.has(key)) {
          choices.delete(key);
        }
      }
    }
    for (const key of [...railRaised.keys()]) {
      const section = key.slice(key.lastIndexOf('\u0000') + 1);
      if (section.startsWith(VIEW_FOLD_PREFIX) && (!live.has(section) || changed.has(section))) {
        railRaised.delete(key);
      }
    }
  };
  const focusAfterViewGone = (): void => {
    const heading = listControls().find((node) => node.classList.contains('railfold')) ?? null;
    // A hidden control takes focus and shows the reader nothing. Below the breakpoint the whole
    // rail is away, so the box is there and cannot be reached.
    const box = filterInput?.isConnected && !filterInput.closest('[hidden]') ? filterInput : null;
    const next = heading ?? box ?? options.fallbackFocus();
    if (!next) {
      return;
    }
    next.focus();
  };
  const startNaming = () => {
    if (!viewCanSave(filter)) {
      return;
    }
    // A keystroke's frame still owed draws now, so the counts that hold still under the name
    // are the ones for the query being named.
    if (filterFrame !== null) {
      cancelAnimationFrame(filterFrame);
      drawFilterFrame();
    }
    naming = { lens: { ...liveRailFilter(), query: filter }, name: '' };
    filterShutOn = null;
    filterAt = 0;
    if (filterInput) {
      filterInput.value = '';
    }
    drawTop();
    drawFilterPop();
    filterInput?.focus();
  };
  // Out of naming and back to the query, which the box holds again. The filter never moved
  // while the name was being typed, so the rail under it did not either.
  const stopNaming = () => {
    naming = null;
    if (filterInput) {
      filterInput.value = filter;
    }
    drawTop();
    drawFilterPop();
    focusFilterRow();
  };
  // Whether a query files anything. A query of spaces alone, or one holding only `find:` and
  // `in:` words, leaves the grammar no term, and `matchSessions` answers with every
  // session to a query that has none. A view over one is the whole rail under a name.
  // The query as it will be stored, because the record cuts it at its own ceiling. A long
  // query whose only term sits past that cut reaches storage with no term at all, and a view
  // with no term is the whole rail under a name.
  const saveNamedView = () => {
    if (!naming || !viewCanSave(naming.lens.query)) {
      return;
    }
    const name = viewName(naming.name);
    if (!name || viewNameTaken(views, name, '')) {
      return;
    }
    postViews([
      ...views,
      {
        id: nextViewId(views),
        name,
        query: viewQuery(naming.lens.query),
        archived: false,
        sort: naming.lens.sort,
      },
    ]);
    naming = null;
    if (filterInput) {
      filterInput.value = filter;
    }
    drawTop();
    drawFilterPop();
    drawList();
    filterInput?.focus();
  };

  const focusAfterList = (
    active: HTMLElement | null,
    activeWasInRail: boolean,
    activeControl: string | null,
    activeBucket: string | null,
    rowIndex: number,
    target: HTMLElement | null,
  ) => {
    // The row this draw was asked to focus comes before every fallback, so the focus moves once.
    if (target) {
      target.focus();
      return;
    }
    if (!active || !activeWasInRail) {
      return;
    }
    if (active.isConnected && !active.closest('[hidden]')) {
      // Moving a keyed group can drop focus while its control remains mounted.
      if (document.activeElement === document.body && active.getClientRects().length) {
        active.focus({ preventScroll: true });
      }
      return;
    }
    const visibleControls = listControls();
    // A row keys by its section, so a row that moved section is a new element. The focus
    // follows its session, to the copy in the section it sat in when one is still drawn.
    const matchingStop = activeControl
      ? (visibleControls.find(
          (node) =>
            node.dataset.control === activeControl &&
            node.closest<HTMLElement>('.railrow')?.dataset.railBucket === activeBucket,
        ) ??
        visibleControls.find((node) => node.dataset.control === activeControl) ??
        null)
      : null;
    const bucketStop = activeBucket
      ? (visibleControls.find((node) => node.classList.contains('railfold') && node.dataset.control === activeBucket) ??
        null)
      : null;
    // A Show more press sits under its section's last drawn row. When a draw removes it and the
    // section has no surviving fold heading, that row is where the press was.
    const sectionEnd =
      activeBucket && activeControl?.startsWith('railmore:')
        ? (visibleControls
            .filter(
              (node) =>
                node.classList.contains('railcard') &&
                node.closest<HTMLElement>('.railrow')?.dataset.railBucket === activeBucket,
            )
            .at(-1) ?? null)
        : null;
    const selectors = visibleControls.filter((node) => node.classList.contains('railcard'));
    const nearbyRow = selectors[Math.min(Math.max(0, rowIndex), selectors.length - 1)] ?? null;
    (matchingStop || bucketStop || sectionEnd || nearbyRow || headerFocus())?.focus();
  };
  // A press draws the section's next step. The press stays under the new rows and keeps focus.
  // A press that draws the section's last row removes itself, and the draw focuses that row.
  const raiseRail = (section: string) => {
    raisePending = section;
    drawList();
  };
  const drawList = () => {
    const raising = raisePending;
    raisePending = null;
    if (!hasPayload) {
      render(null, list);
      return;
    }
    const active = document.activeElement as HTMLElement | null;
    const activeWasInRail = !!(active && nav.contains(active));
    const controlBefore = activeWasInRail ? (active?.dataset.control ?? null) : null;
    const split = controlBefore?.indexOf(':') ?? -1;
    const activeControl =
      controlBefore && split >= 0
        ? `${controlBefore.slice(0, split + 1)}${current(controlBefore.slice(split + 1))}`
        : controlBefore;
    const activeRow = activeWasInRail ? active?.closest('.railrow')?.querySelector('.railcard') : null;
    const rowIndex = activeRow ? [...nav.querySelectorAll('.railcard')].indexOf(activeRow) : -1;
    const activeBucket = activeWasInRail
      ? (active.closest<HTMLElement>('.railrow, .railmore')?.dataset.railBucket ??
        active.closest<HTMLElement>('[data-bucket]')?.dataset.bucket ??
        null)
      : null;
    const railLayout = layout();
    const repeated = railRepeatRows(railLayout.sections);
    const children: ComponentChildren[] = [];
    // A section draws at least through the current session's row.
    const currentAt = new Map(
      railLayout.sections.map((section) => [section.id, section.cards.findIndex((card) => card.current)]),
    );
    const drawnIn = (section: string, count: number) =>
      railRowsDrawn(section, railRaised.get(railRaisedKey(section)) ?? 0, count, currentAt.get(section) ?? -1);
    // A press counts from what its section drew, which the current row can have taken past
    // the presses alone. Every answer but the whole section is a whole number of steps.
    const raisedCount = raising
      ? railLayout.sections.find((section) => section.id === raising)?.cards.length
      : undefined;
    if (raising && raisedCount !== undefined) {
      railRaised.set(railRaisedKey(raising), Math.ceil(drawnIn(raising, raisedCount) / RAIL_ROW_STEP));
    }
    // One list, read twice. The rows drawn here are the rows the clock compares later, so a
    // card left out of the draw cannot ask the clock for a repaint of a row nobody can see.
    const { rows, left } = railDrawnRows(railLayout.sections, railLayout.folded, repeated, railRowId, drawnIn);
    const rowsByBucket = new Map<string, RailDrawnRow<RailCardView>[]>();
    for (const row of rows) {
      const held = rowsByBucket.get(row.bucket);
      if (held) {
        held.push(row);
      } else {
        rowsByBucket.set(row.bucket, [row]);
      }
    }
    // Each group list retains keyed rows while their session and group remain unchanged.
    for (const bucket of railLayout.sections) {
      const view = viewOfSection(bucket.id);
      children.push(
        h(BucketHead, {
          bucket,
          folded: railLayout.folded[bucket.id],
          view,
          drawn: rowsByBucket.get(bucket.id)?.length ?? 0,
          owner,
          options,
          key: `bucket:${bucket.id}`,
        }),
      );
      const bucketRows = rowsByBucket.get(bucket.id);
      if (!bucketRows) {
        // A view whose query reaches nothing keeps its heading, because that heading is the
        // way to edit and delete it. Opened, it says why it holds no card.
        if (!railLayout.folded[bucket.id] && !bucket.cards.length) {
          children.push(
            h(
              'p',
              {
                class: 'railempty railsectionempty',
                key: `empty:${bucket.id}`,
              },
              options.words.railViewEmpty,
            ),
          );
        }
        continue;
      }
      children.push(
        h(
          'ul',
          {
            class: 'railgrouplist',
            key: `list:${bucket.id}`,
            id: railGroupListId(bucket.id),
            'aria-labelledby': railGroupHeadingId(bucket.id),
          },
          bucketRows.map(({ card, repeat }) =>
            h(RailRow, {
              card,
              stats: drawnStats[card.id] ?? NO_RAIL_STATS,
              bucket: bucket.id,
              view: !!view,
              owner,
              options,
              now,
              density: railDensity,
              repeat,
              labelsOpen: labelsOpen && { session: labelsOpen.session, section: labelsOpen.section },
              key: railRowKey(bucket.id, card.id),
            }),
          ),
        ),
      );
      const undrawn = left.get(bucket.id) ?? 0;
      if (undrawn > 0) {
        const label = `${options.words.railMoreShow} ${Math.min(RAIL_ROW_STEP, undrawn)} ${options.words.railFilterLabelsMore}`;
        children.push(
          h(RailMoreRow, {
            section: bucket.id,
            label,
            name: `${label} ${options.words.railMoreIn} ${bucket.label}`,
            raise: raiseRail,
            key: `more:${bucket.id}`,
          }),
        );
      }
    }
    if (!children.length && railLayout.filtering) {
      children.push(h('p', { class: 'railempty', key: 'empty' }, options.words.railFilterEmpty));
    }
    const toTop = railToTop;
    const scroll = toTop ? 0 : nav.scrollTop;
    render(h(Fragment, null, children), list);
    options.onDraw?.();
    drawnRows = rows;
    drawnTitlesAt = now;
    if (toTop || nav.scrollTop !== scroll) {
      nav.scrollTop = scroll;
    }
    railToTop = false;
    // A press that drew its section's last row has gone, and the focus moves straight to that
    // row instead of through a fallback.
    const lastRaised = raising && !left.has(raising) ? rowsByBucket.get(raising)?.at(-1) : undefined;
    const target = lastRaised
      ? (document.getElementById(lastRaised.id)?.querySelector<HTMLElement>('.railcard') ?? null)
      : null;
    focusAfterList(active, activeWasInRail, activeControl, activeBucket, rowIndex, target);
    if (viewOpen) {
      if (viewAnchor()) {
        placeViewPop();
      } else {
        const rescue = viewPop.contains(document.activeElement);
        closeViewEditor(false);
        if (rescue) {
          listControls()[0]?.focus();
        }
      }
    }
    // The scroll kept above holds the rows over the press still, so the rows a press adds push
    // the press down past the fold. Only a draw a press caused brings its control back into
    // view. Any other draw keeps the rail where the reader left it.
    const focused = document.activeElement as HTMLElement | null;
    if (raising && focused && (focused === target || focused.dataset.control === `railmore:${raising}`)) {
      focused.scrollIntoView?.({ block: 'nearest' });
    }
  };

  const labelFold = (name: string) => name.trim().toLocaleLowerCase();
  const labelShownRows = () => {
    const rows = labelsOpen?.rows ?? [];
    const wanted = labelFold(labelFilter);
    return wanted ? rows.filter((row) => labelFold(row.name).includes(wanted)) : rows;
  };
  const labelCreateName = () => {
    const typed = labelFilter.trim();
    if (!typed) {
      return '';
    }
    const wanted = labelFold(typed);
    return (labelsOpen?.rows ?? []).some((row) => labelFold(row.name) === wanted) ? '' : typed;
  };
  const labelAppliedNames = () => {
    const names = (labelsOpen?.rows ?? []).filter((row) => row.applied).map((row) => row.name);
    for (const made of labelsMade) {
      if (!names.some((name) => labelFold(name) === labelFold(made))) {
        names.push(made);
      }
    }
    return names;
  };
  const postLabels = () => {
    if (labelsOpen) {
      options.sendToHost({ type: 'setLabels', session: labelsOpen.session, names: labelAppliedNames() });
    }
  };
  // The control a label editor hangs off, looked for inside the row the press came from before
  // anywhere else.
  //
  // A session two saved views both match draws a row under each of them, so a lookup on
  // the session alone finds two controls and takes whichever is drawn first. The reader
  // who pressed `L` on the second copy then watches the editor open over the first. The row is
  // passed in wherever the press knows it, and the whole-page lookup is what remains for a rail
  // rebuilt from nothing between the ask and the answer.
  const sectionOf = (node: HTMLElement | null | undefined): string | null =>
    node?.closest<HTMLElement>('.railrow')?.dataset.railBucket ?? null;
  // The row a section's fold id names, so a re-anchor after a rebuild goes back to the row the
  // press came from rather than to whichever copy is drawn first.
  const sectionRow = (section: string | null): HTMLElement | null =>
    section ? document.querySelector<HTMLElement>(`.railrow[data-rail-bucket="${CSS.escape(section)}"]`) : null;
  const labelAnchorFor = (session: string, control?: string | null, within?: HTMLElement | null): HTMLElement | null =>
    (within && control ? found(within, control) : null) ||
    (within ? found(within, `raillabels:${session}`) : null) ||
    (control ? found(document.body, control) : null) ||
    found(document.body, `raillabels:${session}`) ||
    found(document.body, `sessionlabels:${session}`) ||
    found(document.body, `session:${session}`);
  const labelAnchor = () => {
    if (!labelsOpen) {
      return null;
    }
    const held = labelsOpen.anchor;
    if (held?.isConnected && !held.closest('[hidden]')) {
      return held;
    }
    const again = labelAnchorFor(labelsOpen.session, labelsOpen.control, sectionRow(labelsOpen.section));
    if (again) {
      labelsOpen.anchor = again;
    }
    return again ?? held;
  };
  const placeLabelPop = () => {
    if (!labelsOpen || labelPop.hidden) {
      return;
    }
    const anchor = labelAnchor();
    if (!anchor) {
      return;
    }
    // The editor opens clear of the whole row, above or below it, so it never covers the
    // session it labels.
    const row = anchor.closest<HTMLElement>('.railrow') || anchor.closest<HTMLElement>('.sessionrow');
    placeFloat(window, labelPop, anchor, { around: row ?? anchor, align: 'end', gap: 4, overflow: 'flip-or-stay' });
  };
  const drawLabelPop = (focusControl?: string | null, notifyEditorChange = true) => {
    labelPop.hidden = !labelsOpen;
    labelPop.setAttribute('aria-label', labelsOpen?.heading ?? '');
    if (notifyEditorChange) {
      options.onLabelEditorChange();
    }
    const active = document.activeElement as HTMLElement | null;
    const held = active && labelPop.contains(active) ? (active.dataset.control ?? null) : null;
    render(
      h(LabelPopover, {
        owner,
        open: labelsOpen,
        rows: labelShownRows(),
        create: labelCreateName(),
        notes: labelTypedNotes(labelFilter),
        options,
        setInput: (node) => {
          labelInput = node;
        },
      }),
      labelPop,
    );
    if (!labelsOpen) {
      return;
    }
    const wanted = focusControl || held;
    const target = wanted ? found(labelPop, wanted) || found(labelPop, 'label-find') : null;
    if (target && target !== document.activeElement) {
      target.focus();
    }
    placeLabelPop();
  };
  const closeLabelEditor = (returnFocus: boolean) => {
    const back = labelAnchor();
    labelsOpen = null;
    labelsPending = null;
    labelsMade = [];
    labelFilter = '';
    if (labelInput) {
      labelInput.value = '';
    }
    drawLabelPop();
    drawList();
    if (returnFocus && back?.isConnected) {
      back.focus();
    }
  };
  const openLabelEditor = (session: string, anchor?: HTMLElement | null) => {
    // Two popovers must never float at once, so the view editor gives way to this one.
    if (viewOpen) {
      closeViewEditor(false);
    }
    if (renameOpen) {
      closeSessionRename(false);
    }
    if (railFilterOpen) {
      closeRailFilterPicker(false);
    }
    labelsPending = {
      session: current(session),
      section: sectionOf(anchor),
      anchor: anchor ?? null,
      control: anchor?.dataset.control ?? null,
      at: Date.now(),
    };
    options.sendToHost({ type: 'labelEditor', session });
  };
  const rowsInPlace = (held: LabelEditorRow[], sent: LabelEditorRow[]): LabelEditorRow[] => {
    const byName = new Map(sent.map((row) => [labelFold(row.name), row]));
    const rows: LabelEditorRow[] = [];
    for (const row of held) {
      const fresh = byName.get(labelFold(row.name));
      if (!fresh) {
        continue;
      }
      rows.push(fresh);
      byName.delete(labelFold(row.name));
    }
    for (const row of sent) {
      if (byName.has(labelFold(row.name))) {
        rows.push(row);
      }
    }
    return rows;
  };

  // The heading the editor was opened from, found again after a redraw replaced it.
  const viewAnchorFor = (id: string, control?: string): HTMLElement | null => {
    const view = findView(views, id);
    const anchor = view ? (control && found(nav, control)) || found(nav, viewFoldId(view)) : null;
    return anchor?.isConnected && !anchor.closest('[hidden]') ? anchor : null;
  };
  const viewAnchor = () => {
    if (!viewOpen) {
      return null;
    }
    const held = viewOpen.anchor;
    if (held?.isConnected && !held.closest('[hidden]')) {
      return held;
    }
    const again = viewAnchorFor(viewOpen.view, viewOpen.control);
    viewOpen.anchor = again;
    return again;
  };
  const placeViewPop = () => {
    if (!viewOpen || viewPop.hidden) {
      return;
    }
    const anchor = viewAnchor();
    if (anchor) {
      placeFloat(window, viewPop, anchor, { gap: 4, overflow: 'flip-or-stay' });
    }
  };
  const drawViewPop = (focusControl?: string | null) => {
    viewPop.hidden = !viewOpen;
    viewPop.setAttribute('aria-label', options.words.railViewEdit);
    const active = document.activeElement as HTMLElement | null;
    const held = active && viewPop.contains(active) ? (active.dataset.control ?? null) : null;
    render(
      h(ViewEditor, {
        owner,
        open: viewOpen,
        views,
        notes: viewOpen
          ? [
              ...viewQueryNotes(findView(views, viewOpen.view)?.query ?? ''),
              ...viewTypedNotes(views, viewOpen.name, viewOpen.view),
            ]
          : [],
        options,
        setInput: (node) => {
          viewInput = node;
        },
      }),
      viewPop,
    );
    if (!viewOpen) {
      return;
    }
    const wanted = focusControl || held;
    const target = wanted ? found(viewPop, wanted) || found(viewPop, 'view-name') : null;
    if (target && target !== document.activeElement) {
      target.focus();
    }
    placeViewPop();
  };
  const closeViewEditor = (returnFocus: boolean) => {
    const back = viewAnchor();
    viewOpen = null;
    if (viewInput) {
      viewInput.value = '';
    }
    drawViewPop();
    if (returnFocus && back?.isConnected) {
      back.focus();
    }
  };

  // The rail row or heading control the rename editor was opened from, found again after a
  // redraw replaced it. A heading control has no rail section, so the whole page is searched.
  const renameAnchor = (): HTMLElement | null => {
    if (!renameOpen) {
      return null;
    }
    const held = renameOpen.anchor;
    if (held?.isConnected && !held.closest('[hidden]')) {
      return held;
    }
    const within = renameOpen.section ? sectionRow(renameOpen.section) : document.body;
    const again =
      (within && renameOpen.control ? found(within, renameOpen.control) : null) ||
      found(document.body, `rail:${renameOpen.session}`);
    if (again) {
      renameOpen.anchor = again;
    }
    return again;
  };
  const placeRenamePop = () => {
    if (!renameOpen || renamePop.hidden) {
      return;
    }
    const anchor = renameAnchor();
    if (anchor) {
      placeFloat(window, renamePop, anchor, { gap: 4, overflow: 'flip-or-stay' });
    }
  };
  const drawRenamePop = (focus = false) => {
    renamePop.hidden = !renameOpen;
    render(
      h(SessionRenameEditor, {
        open: renameOpen,
        words: options.words,
        setInput: (node) => {
          renameInput = node;
        },
        onTitle: setSessionRenameTitle,
        onSubmit: submitSessionRename,
        onCancel: () => closeSessionRename(true),
      }),
      renamePop,
    );
    if (!renameOpen) {
      return;
    }
    if (focus && renameInput && renameInput !== document.activeElement) {
      renameInput.focus();
    }
    placeRenamePop();
  };
  // Whether the reader is still in the rename editor, or focus went nowhere because a
  // control in it was disabled. Only then may an answer move focus.
  const focusInRename = (): boolean => {
    const active = document.activeElement;
    return !active || active === document.body || renamePop.contains(active);
  };
  // Closes the editor. Escape, a press outside, and another popover close it even while a
  // rename waits, so a lost answer never strands the reader. That rename still finishes, and
  // its late answer finds no editor waiting on it and changes nothing. Focus goes back to the
  // rail row or heading control the editor opened from when it can take focus. Below the rail
  // breakpoint a rail row is still in the page but hidden, so focus goes to the timeline.
  const closeSessionRename = (returnFocus: boolean) => {
    if (!renameOpen) {
      return;
    }
    const back = returnFocus ? renameAnchor() : null;
    renameOpen = null;
    drawRenamePop();
    if (!returnFocus) {
      return;
    }
    if (back?.isConnected && !back.closest('[hidden]') && back.getClientRects().length > 0) {
      back.focus();
    } else {
      options.fallbackFocus()?.focus();
    }
  };
  const setSessionRenameTitle = (value: string) => {
    if (!renameOpen || renameOpen.request !== null) {
      return;
    }
    renameOpen = { ...renameOpen, title: value, error: '' };
    drawRenamePop();
  };
  const submitSessionRename = () => {
    const sent = renameOpen ? submittedRename(renameOpen, renameRequests + 1) : null;
    if (!sent) {
      return;
    }
    // Save turns disabled while the rename waits, so a press on it would drop focus out of the
    // editor and out of reach of Escape. The box keeps it instead.
    const held = focusInRename();
    renameRequests += 1;
    renameOpen = sent;
    drawRenamePop(held);
    options.sendToHost({ type: 'renameSession', session: sent.session, request: renameRequests, title: sent.title });
  };

  const drawVisibility = () => {
    const shown = visible();
    nav.hidden = !shown;
    sash.hidden = !shown;
    options.onVisibilityChange(shown, media.matches);
    drawWidth();
    if (!shown && (nav.contains(document.activeElement) || sash === document.activeElement)) {
      const next = options.fallbackFocus();
      if (next) {
        next.focus();
      }
    }
    options.onLayoutChange();
  };

  owner = {
    updateLoading(text) {
      loadingStatus.className = text === null ? '' : 'railempty';
      loadingStatus.hidden = text === null;
      loadingStatus.textContent = text ?? '';
    },
    element: nav,
    sashElement: sash,
    projectSpendMount,
    update(cards, catalog, saved, savedRailFilters, stats, catalogAvailable = false) {
      countsKnown ||= catalogAvailable;
      // The startup shell carries empty views without a saved-filter catalog.
      if (Array.isArray(savedRailFilters) && Array.isArray(saved)) {
        pruneViewFolds(saved);
      }
      hasPayload = Array.isArray(cards);
      latestStats = stats;
      latestCards = Array.isArray(cards) ? cards : [];
      labels = Array.isArray(catalog) ? catalog : [];
      views = Array.isArray(saved) ? saved : [];
      // The startup shell has no catalog. Preserve restored filters until the host supplies one.
      if (Array.isArray(savedRailFilters)) {
        railFilters = normalizeSavedRailFilters(savedRailFilters);
        const nextFilterId = normalizeRailFilterId(railFilterId, railFilters);
        if (nextFilterId !== railFilterId) {
          setLiveRailFilter({ query: '', sort: railDefaultSort }, ALL_RAIL_FILTER_ID, false);
        }
      }
      // A view the reader deleted in another host takes its editor with it, because the form
      // would otherwise rename something that is gone.
      //
      // The rescue is owed rather than taken here. The reader holding the form has to land
      // somewhere, and the headings it lands on are the ones drawn after this message, not the
      // ones on screen now, which still include the section about to go.
      const rescue = !!viewOpen && !findView(views, viewOpen.view) && viewPop.contains(document.activeElement);
      if (viewOpen && !findView(views, viewOpen.view)) {
        closeViewEditor(false);
      }
      // A session that left the rail takes its rename editor with it. A reader typing in it
      // lands on the timeline, because the row they came from is gone.
      if (renameOpen && !latestCards.some((card) => card.id === renameOpen?.session)) {
        const typing = renamePop.contains(document.activeElement);
        closeSessionRename(false);
        if (typing) {
          options.fallbackFocus()?.focus();
        }
      }
      drawVisibility();
      drawFilterPop();
      drawTop();
      drawRailFilterPop();
      // The reader opened another session. The highlight names where they are now, so
      // it follows them even while a selection in the row they left is still alive.
      const movedOn = currentOf(latestCards) !== currentOf(drawnCards) && !dragging;
      if (!movedOn && options.selectionWithin(nav)) {
        repaintOwed = true;
        if (rescue) {
          focusAfterViewGone();
        }
        return;
      }
      drawnCards = latestCards;
      drawnStats = drawnRailStats(latestStats);
      now = Date.now();
      repaintOwed = false;
      drawList();
      if (rescue) {
        focusAfterViewGone();
      }
      // A figure or a state can change while every attribute on the row stays the same, so
      // an open hover card is drawn again from what the rail now holds.
      options.redrawHint('railcard');
    },
    updateLauncher(view) {
      launcherView = view;
      drawTop();
      drawFilterPop();
    },
    drawRowContext(session) {
      owner.drawRowContexts([session]);
    },
    drawRowContexts(sessions) {
      const wanted = new Set(sessions);
      // A saved view can draw a second row for the same session, so every match is patched
      // rather than the first: the session heading returns after one because it draws at
      // most one row per session, and the rail does not share that limit.
      for (const row of nav.querySelectorAll<HTMLElement>('[data-vscode-context]')) {
        const session = row.dataset.session;
        if (session === undefined || !wanted.has(session)) {
          continue;
        }
        const old = JSON.parse(row.dataset.vscodeContext ?? '{}') as {
          sessionPersisted?: unknown;
          webviewSection?: unknown;
        };
        const persisted = old.sessionPersisted === true;
        const menuSection = typeof old.webviewSection === 'string' ? old.webviewSection : '';
        row.dataset.vscodeContext = options.rowContext(session, menuSection, persisted);
      }
      // Preact keeps the props it last committed, not the attribute the patch above just
      // wrote. A later draw that happens to recompute the value the patch replaced would see
      // no difference from what it remembers and skip the write, so the row would answer a
      // press that reopens its menu with what the patch said rather than the state the press
      // is actually about. Drawing again now folds the patch into what Preact remembers before
      // a later draw can lose it. Cards keep the bucket the last host payload placed them in:
      // this only redraws what a card already carries, it does not move any row.
      drawList();
    },
    releaseSelection() {
      if (!repaintOwed || options.selectionWithin(nav)) {
        return;
      }
      drawnCards = latestCards;
      drawnStats = drawnRailStats(latestStats);
      now = Date.now();
      repaintOwed = false;
      // A tick this selection deferred left the head's figures as they were, so the head draws
      // again with the list.
      drawTop();
      drawList();
      options.redrawHint('railcard');
    },
    tick(at = Date.now()) {
      const work = railTickWork(drawnRows, now, at, drawnTitlesAt, railAgeFormat(railDensity));
      // A cache tooltip is written where it stands. The row around it says the same words as
      // before, and a redraw for a tooltip nobody has open would remount the node the tooltip
      // hangs off while the pointer rests on it.
      //
      // The row is looked for inside the rail. A row id names one element of the rail, and an
      // element elsewhere on the page carrying that id owns none of this wording.
      let written = 0;
      for (const { id, text } of work.titles) {
        const row = document.getElementById(id);
        const title = row && nav.contains(row) ? row.querySelector('.railcache title') : null;
        if (!title) {
          continue;
        }
        written += 1;
        if (title.textContent !== text) {
          title.textContent = text;
        }
      }
      // The baseline moves only when every owed tooltip reached its mark. A row the rail has
      // not mounted is owed its wording again on the next tick.
      if (written && written === work.titles.length) {
        drawnTitlesAt = at;
      }
      // Refresh counts and Active's cache state on the clock. Naming holds both until it ends.
      const fresh = drawnCounts !== null && !naming ? headCounts(at) : null;
      const headMoved = fresh !== null && drawnCounts !== null && countsMoved(drawnCounts, fresh);
      const clockMoved =
        poolReadsCache() &&
        drawnCards.some(
          (card) =>
            railCardActive(card, now) !== railCardActive(card, at) ||
            (railCacheState(card.cache ?? null, now) !== null) !== (railCacheState(card.cache ?? null, at) !== null),
        );
      if (!work.redraw && !headMoved && !clockMoved) {
        return;
      }
      if (options.selectionWithin(nav)) {
        repaintOwed = true;
        return;
      }
      now = at;
      // The figures this tick already matched, so the head draws without a second match.
      if (headMoved && fresh !== null) {
        drawTop(fresh);
      }
      drawList();
    },
    reset() {
      setRailQuery('');
      // The box goes with the query. A rail that has forgotten everything rests on its
      // count, and an empty box left on the row would hold the place it belongs.
      filterRowOpen = false;
      railFilterId = ALL_RAIL_FILTER_ID;
      railFilters = [];
      width = RAIL_WIDTH_DEFAULT;
      railSort = 'latest';
      railDefaultSort = 'latest';
      // The two bucket switches go back on with the rest. A reader asking the panel to forget
      // everything is asking for the rail they started with, and a switch left off keeps a
      // whole bucket of sessions off a rail that says it has forgotten what hid them.
      railShowArchived = RAIL_SHOWN_BUCKETS.showArchived;
      railShowRuns = RAIL_SHOWN_BUCKETS.showRuns;
      railQuickFilters = [...DEFAULT_RAIL_QUICK_FILTERS];
      railGroupBy = 'time';
      railDensity = 'comfortable';
      nav.dataset.density = railDensity;
      railFilterOpen = false;
      railFilterSearch = '';
      railFilterNameMode = null;
      railFilterDeleteArmed = false;
      folds.clear();
      filteredFolds.clear();
      railRaised.clear();
      railToTop = false;
      repaintOwed = false;
      filterAt = 0;
      filterShutOn = null;
      if (filterFrame !== null) {
        cancelAnimationFrame(filterFrame);
        filterFrame = null;
      }
      labelsPending = null;
      labelsOpen = null;
      labelsMade = [];
      labelFilter = '';
      labelArm = null;
      naming = null;
      viewOpen = null;
      renameArm = null;
      renameOpen = null;
      if (filterInput) {
        filterInput.value = '';
      }
      if (labelInput) {
        labelInput.value = '';
      }
      if (viewInput) {
        viewInput.value = '';
      }
      drawWidth();
      drawTop();
      drawFilterPop();
      drawLabelPop();
      drawViewPop();
      drawRenamePop();
      drawRailFilterPop();
      drawList();
      options.onLayoutChange();
    },
    snapshot,
    visible,
    visibleFor: (cards) => Array.isArray(cards) && media.matches,
    newButton: () => railNew,
    newMenu: () => railNewMenu,
    labelOpen: (session) => labelsOpen?.session === current(session),
    // Whether a filter set from elsewhere would be on screen to see.
    //
    // The width alone, and not `visible`, which also asks whether a payload has arrived. The
    // session heading is drawn from the same payload the rail is, and `render` builds the
    // headings first, so a heading asking `visible` on the first paint is told the rail is
    // down and draws its chips as words. They would stay words until something else redrew
    // the line.
    filterable: () => media.matches,
    // File the rail by one label, from a press the reader made somewhere else.
    //
    // The session heading's chips call this. The filter box is where the reader edits and
    // clears a filter, so the press writes the term into that box and leaves the focus on it,
    // rather than filing the list from a control that then says nothing about what it did.
    //
    // Nothing happens while the rail is down. The heading draws its chips as plain words at
    // those widths for that reason, so no press reaches here with no list to file.
    filterByLabel(name) {
      if (!visible()) {
        return;
      }
      const written = labelFilterToken(name);
      setRailQuery(boundedRailFilterQuery(written));
      filterRowOpen = true;
      if (filterInput) {
        filterInput.value = filter;
      }
      if (filterFrame !== null) {
        cancelAnimationFrame(filterFrame);
        filterFrame = null;
      }
      // The term is a whole label and not a word part way through being typed, so the offers
      // stay shut over it, the way they do when the reader takes one of the rows themselves.
      filterShutOn = { start: 0, text: written };
      filterAt = 0;
      options.save();
      drawTop();
      drawList();
      filterInput?.focus();
      filterInput?.setSelectionRange(written.length, written.length);
      drawFilterPop();
      drawRailFilterPop();
    },
    selectRailFilter(id) {
      const selected =
        id === ALL_RAIL_FILTER_ID ? { query: '', sort: railDefaultSort } : findRailFilter(railFilters, id);
      if (!selected) {
        return;
      }
      // An armed Delete and an open name box belong to the lens they were opened on, so a
      // press on another row drops both before that row's own actions draw. So does a press on
      // the selected row while the rail is Custom, because the press puts the saved lens back
      // and a name typed for the edited lens would save a copy of the stored one. A press on
      // the row already selected and unedited keeps both, with any name the reader has typed.
      if (id !== railFilterId || !railFilterSelected()) {
        railFilterDeleteArmed = false;
        railFilterNameMode = null;
      }
      setLiveRailFilter(selected, id);
      drawRailFilterPop(`railfilterpick:${id}`);
    },
    setRailFilterSearch(value) {
      railFilterSearch = value;
      drawRailFilterPop('railfilter-find');
    },
    setRailFilterSort(value) {
      if (!RAIL_SORTS.includes(value as RailSort)) {
        return;
      }
      selectRailFilterSort(value as RailSort);
    },
    // A Filter press sets one lens in the query, or none for All, and keeps every other word,
    // the sort and the selected filter id. The menu stays open on the pressed value.
    setRailLens(value) {
      const lens = value === 'all' ? null : RAIL_LENSES.find((each) => each === value);
      if (lens === undefined) {
        return;
      }
      const query = withRailLens(filter, lens);
      if (query !== filter) {
        setLiveRailFilter({ ...liveRailFilter(), query }, railFilterId);
      }
      drawRailFilterPop(`raillens:${value}`);
    },
    // A grouping press changes only the list and the menu's own checked value. It is view
    // state, saved with the rail like the sort and the Show switches.
    setRailGroupBy(value) {
      const next = normalizeRailGroupBy(value);
      if (next !== value || next === railGroupBy) {
        return;
      }
      railGroupBy = next;
      options.save();
      drawList();
      drawRailFilterPop(`railgroupby:${next}`);
    },
    // A density press changes how each row is laid out and which age it prints. It is
    // presentation state saved with the rail width, and no saved filter or view holds it.
    setRailDensity(value) {
      const next = normalizeRailDensity(value);
      if (next !== value || next === railDensity) {
        return;
      }
      railDensity = next;
      nav.dataset.density = next;
      options.save();
      drawList();
      drawRailFilterPop(`raildensity:${next}`);
    },
    // A bucket press changes what the rail draws and what every figure counts, so the list,
    // the row and the menu are all redrawn, and the choice is saved with the rail.
    toggleRailShow(value) {
      if (value === 'archived') {
        railShowArchived = !railShowArchived;
      } else if (value === 'runs') {
        railShowRuns = !railShowRuns;
      } else {
        return;
      }
      options.save();
      drawTop();
      drawList();
      drawRailFilterPop(`railshow:${value}`);
    },
    // A checkbox changes configured button visibility and saves the choice. Focus stays on the checkbox.
    toggleRailHeadLens(value) {
      const lens = RAIL_LENSES.find((each) => each === value);
      if (!lens) {
        return;
      }
      railQuickFilters = withRailHeadLensToggled(railQuickFilters, lens);
      options.save();
      drawTop();
      drawRailFilterPop(`railheadlens:${lens}`);
    },
    toggleRailFilterLabel(value) {
      setRailQuery(boundedRailFilterQuery(toggleRailFilterTerm(filter, 'labels', value)));
      if (filterInput) {
        filterInput.value = filter;
      }
      options.save();
      drawTop();
      drawList();
      drawFilterPop();
      drawRailFilterPop(`railfilterlabel:${value}`);
    },
    toggleRailFilterLabelFold() {
      railFilterLabelsExpanded = !railFilterLabelsExpanded;
      drawRailFilterPop('railfilter-more-labels');
    },
    updateRailFilter() {
      const current = findRailFilter(railFilters, railFilterId);
      if (!current) {
        return;
      }
      postRailFilters(
        railFilters.map((saved) => (saved.id === current.id ? { ...saved, ...liveRailFilter() } : saved)),
      );
      drawTop();
      drawRailFilterPop('railfilter-update');
    },
    nameNewRailFilter() {
      railFilterDeleteArmed = false;
      railFilterNameMode = { kind: 'save', name: '' };
      drawRailFilterPop('railfilter-name');
    },
    renameRailFilter() {
      const current = findRailFilter(railFilters, railFilterId);
      if (!current) {
        return;
      }
      railFilterDeleteArmed = false;
      railFilterNameMode = { kind: 'rename', name: current.name };
      drawRailFilterPop('railfilter-name');
      railFilterNameInput?.select();
    },
    deleteRailFilter() {
      const current = findRailFilter(railFilters, railFilterId);
      if (!current) {
        return;
      }
      if (!railFilterDeleteArmed) {
        railFilterDeleteArmed = true;
        drawRailFilterPop('railfilter-delete');
        return;
      }
      postRailFilters(railFilters.filter((saved) => saved.id !== current.id));
      railFilterDeleteArmed = false;
      setLiveRailFilter({ query: '', sort: railDefaultSort }, ALL_RAIL_FILTER_ID);
      drawRailFilterPop(`railfilterpick:${ALL_RAIL_FILTER_ID}`);
    },
    setRailFilterName(value) {
      if (!railFilterNameMode) {
        return;
      }
      railFilterNameMode = { ...railFilterNameMode, name: value };
      drawRailFilterPop('railfilter-name');
    },
    saveNamedRailFilter() {
      if (!railFilterNameMode) {
        return;
      }
      const name = railFilterName(railFilterNameMode.name);
      const except = railFilterNameMode.kind === 'rename' ? railFilterId : '';
      if (!name || railFilterNameTaken(railFilters, name, except)) {
        return;
      }
      if (railFilterNameMode.kind === 'rename') {
        const current = findRailFilter(railFilters, railFilterId);
        if (!current) {
          return;
        }
        postRailFilters(railFilters.map((saved) => (saved.id === current.id ? { ...saved, name } : saved)));
      } else {
        const saved = { id: nextRailFilterId(railFilters), name, ...liveRailFilter() };
        postRailFilters([...railFilters, saved]);
        railFilterId = saved.id;
        options.save();
      }
      railFilterNameMode = null;
      drawTop();
      drawRailFilterPop('railfilter-save-as');
    },
    cancelRailFilterName() {
      railFilterNameMode = null;
      drawRailFilterPop('railfilter-save-as');
    },
    toggleLabelEditor(session, anchor) {
      // The press shuts the editor only when it is the press that opened it. A session two
      // saved views both match has a control under each, and the second one moves the editor to
      // its own row rather than closing an editor the reader is looking at elsewhere.
      const here = labelsOpen?.session === current(session) && labelsOpen.section === sectionOf(anchor);
      if (here) {
        closeLabelEditor(true);
      } else {
        openLabelEditor(session, anchor);
      }
    },
    receiveLabelEditor(asked, heading, rows) {
      const session = current(asked);
      if (labelsOpen?.session === session) {
        labelsOpen = { ...labelsOpen, heading, rows: rowsInPlace(labelsOpen.rows, rows) };
        labelsMade = [];
        drawLabelPop();
        drawList();
        return;
      }
      const pending = labelsPending;
      if (!pending || pending.session !== session) {
        return;
      }
      if (Date.now() - pending.at > MENU_ARM_MS) {
        labelsPending = null;
        return;
      }
      labelsPending = null;
      labelFilter = '';
      if (labelInput) {
        labelInput.value = '';
      }
      labelsMade = [];
      labelsOpen = {
        session,
        section: pending.section,
        anchor: pending.anchor,
        control: pending.control,
        heading,
        rows,
      };
      drawLabelPop('label-find');
      drawList();
    },
    labelsChanged(session) {
      if (labelsOpen && labelsOpen.session !== current(session)) {
        options.sendToHost({ type: 'labelEditor', session: labelsOpen.session });
      }
    },
    // A draft took its durable id. The open editor and an unanswered ask move to that id, so
    // the anchor lookup finds the controls drawn under the new id and each change is sent for
    // the session that owns the labels. A press or a reply that still names the provisional id
    // reaches the same editor through the adoption record. The held anchor stays until a
    // redraw replaces it.
    adoptSessionIdentity(provisional, durable) {
      adopted.delete(provisional);
      adopted.set(provisional, durable);
      if (adopted.size > ADOPTIONS_KEPT) {
        adopted.delete(adopted.keys().next().value!);
      }
      const moved = (control: string | null) =>
        control?.endsWith(`:${provisional}`) ? `${control.slice(0, -provisional.length)}${durable}` : control;
      if (labelsOpen?.session === provisional) {
        labelsOpen = { ...labelsOpen, session: durable, control: moved(labelsOpen.control) };
      }
      if (labelsPending?.session === provisional) {
        labelsPending = { ...labelsPending, session: durable, control: moved(labelsPending.control) };
      }
    },
    openArmedLabelEditor(session) {
      const arm = labelArm;
      if (!arm || arm.session !== session) {
        return;
      }
      if (Date.now() - arm.at > MENU_ARM_MS) {
        labelArm = null;
        return;
      }
      labelArm = null;
      // The node the right-click landed on wins. It names the row the reader meant, which a
      // lookup by session cannot do once two sections draw that session.
      openLabelEditor(session, arm.node.isConnected ? arm.node : labelAnchorFor(session));
    },
    handleHotkey(event, from) {
      if (
        !from.classList.contains('railcard') ||
        !from.dataset.session ||
        from.dataset.archived === 'true' ||
        !plainNavigationKey(event)
      ) {
        return false;
      }
      const id = from.dataset.session;
      if (event.key === 'l') {
        event.preventDefault();
        const row = from.closest<HTMLElement>('.railrow');
        owner.toggleLabelEditor(id, labelAnchorFor(id, null, row) || from);
        return true;
      }
      const archiveKey = event.key === 'Delete' || (/^Mac/.test(options.platform || '') && event.key === 'Backspace');
      const control = event.key === 'p' ? `railpin:${id}` : archiveKey ? `railhide:${id}` : null;
      const button = control ? found(from.closest<HTMLElement>('.railrow') ?? nav, control) : null;
      if (!button) {
        return false;
      }
      event.preventDefault();
      button.click();
      return true;
    },
    place() {
      if (drawWidth()) {
        options.onLayoutChange();
      }
      placeFilterPop();
      placeLabelPop();
      placeViewPop();
      placeRenamePop();
      placeRailFilterPop();
    },
    // The edit and delete commands, which the editor answers on the heading they were pressed
    // on. Two popovers must never float at once, so the label editor gives way to this one.
    openViewEditor(view, mode) {
      const arm = viewArm;
      viewArm = null;
      if (!arm || arm.view !== view || Date.now() - arm.at > MENU_ARM_MS) {
        return;
      }
      const saved = findView(views, view);
      if (!saved) {
        return;
      }
      if (labelsOpen) {
        closeLabelEditor(false);
      }
      if (renameOpen) {
        closeSessionRename(false);
      }
      if (railFilterOpen) {
        closeRailFilterPicker(false);
      }
      viewOpen = {
        view,
        name: saved.name,
        sort: saved.sort ?? 'inherit',
        armed: mode === 'delete',
        anchor: arm.node.isConnected ? arm.node : viewAnchorFor(view, arm.node.dataset.control),
        control: arm.node.dataset.control!,
      };
      drawViewPop(mode === 'delete' ? 'view-delete' : 'view-name');
    },
    // Rename session on a saved session's rail row or heading context menu. Every host is
    // told, and only the one that saw the right-click opens the editor.
    openSessionRename(session, title) {
      const arm = renameArm;
      renameArm = null;
      if (!arm || arm.session !== session || Date.now() - arm.at > MENU_ARM_MS) {
        return;
      }
      if (renameOpen) {
        closeSessionRename(false);
      }
      if (labelsOpen) {
        closeLabelEditor(false);
      }
      if (viewOpen) {
        closeViewEditor(false);
      }
      if (railFilterOpen) {
        closeRailFilterPicker(false);
      }
      renameOpen = {
        session,
        title,
        error: '',
        request: null,
        section: sectionOf(arm.node),
        anchor: arm.node,
        control: arm.node.dataset.control ?? null,
      };
      drawRenamePop(true);
      renameInput?.select();
    },
    // The host's answer. Success closes the editor, because the rail and the heading already
    // carry the new name. Focus moves only when the reader is still in the editor, so an
    // answer never pulls them out of a box they moved on to.
    receiveSessionRenameResult(answer) {
      const next = answeredRename(renameOpen, answer);
      if (next === 'ignore') {
        return;
      }
      const held = focusInRename();
      if (next === 'close') {
        closeSessionRename(held);
        return;
      }
      renameOpen = next;
      drawRenamePop(held);
    },
    toggleBucket(id) {
      const open = !layout().folded[id];
      (effectiveFilter() ? filteredFolds : folds).set(id, !open);
      now = Date.now();
      options.save();
      drawList();
    },
    setViewName(value) {
      if (!viewOpen) {
        return;
      }
      viewOpen = { ...viewOpen, name: value };
      drawViewPop();
    },
    setViewSort(value: string) {
      if (!viewOpen) {
        return;
      }
      viewOpen = { ...viewOpen, sort: normalizeSavedViewSort(value) };
      drawViewPop();
    },
    saveEditedView() {
      const saved = viewOpen ? findView(views, viewOpen.view) : null;
      const name = viewOpen ? viewName(viewOpen.name) : '';
      if (!saved || !name || viewNameTaken(views, name, saved.id)) {
        return;
      }
      const sort = normalizeSavedViewSort(viewOpen!.sort);
      postViews(views.map((view) => (view.id === saved.id ? withViewSort(view, name, sort) : view)));
      closeViewEditor(true);
      drawList();
    },
    // Two presses on one button. The first changes the word, so the reader reads what the next
    // press does rather than answering a box drawn over the view they are deleting.
    pressDeleteView() {
      const saved = viewOpen ? findView(views, viewOpen.view) : null;
      if (!viewOpen || !saved) {
        return;
      }
      if (!viewOpen.armed) {
        viewOpen = { ...viewOpen, armed: true };
        drawViewPop('view-delete');
        return;
      }
      // The section's fold and presses go with it. Nothing draws a heading under that key any
      // more, and the record keeps a bounded number of them.
      postViews(views.filter((view) => view.id !== saved.id));
      closeViewEditor(false);
      options.save();
      drawList();
      focusAfterViewGone();
    },
    closeViewEditor(back) {
      closeViewEditor(back);
    },
    setLabelFilter(value) {
      labelFilter = value;
      // Filtering changes only the popover. Editor transitions still update the session heading.
      drawLabelPop(null, false);
    },
    labelInputKeydown(event) {
      if (event.isComposing || event.keyCode === 229) {
        return;
      }
      const takeMatch = event.key === 'Tab' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
      if (event.key !== 'Enter' && !takeMatch) {
        return;
      }
      if (takeMatch) {
        if (!labelFilter.trim()) {
          return;
        }
        const row = labelShownRows().find((candidate) => !candidate.applied);
        if (!row) {
          return;
        }
        event.preventDefault();
        owner.setLabelApplied(row.name, true);
        labelFilter = '';
        if (labelInput) {
          labelInput.value = '';
        }
        drawLabelPop('label-find');
        return;
      }
      const typed = labelFilter.trim();
      const row = typed
        ? labelsOpen?.rows.find((candidate) => labelFold(candidate.name) === labelFold(typed))
        : undefined;
      if (row) {
        event.preventDefault();
        if (!row.applied) {
          owner.setLabelApplied(row.name, true);
        }
        return;
      }
      const name = labelCreateName();
      if (!name) {
        return;
      }
      event.preventDefault();
      owner.createLabel(name);
    },
    createLabel(name) {
      labelsMade.push(name);
      postLabels();
    },
    setLabelApplied(name, applied) {
      const row = labelsOpen?.rows.find((candidate) => labelFold(candidate.name) === labelFold(name));
      if (row) {
        row.applied = applied;
      }
      postLabels();
    },
    togglePinned(card) {
      let openPinned = false;
      if (!card.pinnedTop) {
        (effectiveFilter() ? filteredFolds : folds).set(RAIL_FOLDS.top, true);
        railToTop = true;
        openPinned = !effectiveFilter();
      }
      options.setPinned(card.id, !card.pinnedTop, openPinned);
    },
  };

  labelPop.addEventListener('keydown', (event) => {
    if (!labelsOpen) {
      return;
    }
    if (event.isComposing || event.keyCode === 229) {
      return;
    }
    if (event.key === 'Escape') {
      closeLabelEditor(true);
      event.preventDefault();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      return;
    }
    if ((event.key === 'Home' || event.key === 'End') && document.activeElement === labelInput) {
      return;
    }
    const stops = [...labelPop.querySelectorAll<HTMLElement>('.labelfind, .labelcreate, .labelbox')];
    if (!stops.length) {
      return;
    }
    let at = stops.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Home') {
      at = 0;
    } else if (event.key === 'End') {
      at = stops.length - 1;
    } else if (event.key === 'ArrowDown') {
      at = Math.min(at + 1, stops.length - 1);
    } else {
      at = Math.max(at - 1, 0);
    }
    stops[at]?.focus();
    event.preventDefault();
  });

  // Escape alone. Everything inside is a box or a button, and Tab already walks those, so this
  // popover builds no walk of its own. The label editor beside it does build one, because its
  // list of checkboxes grows to whatever the workspace has filed.
  //
  // An armed delete gives way first. A reader who armed it and changed their mind presses the
  // key that means no, and losing the whole form to that press would take the rename with it.
  viewPop.addEventListener('keydown', (event) => {
    if (!viewOpen || event.isComposing || event.keyCode === 229) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (viewOpen.armed) {
        viewOpen = { ...viewOpen, armed: false };
        drawViewPop('view-delete');
        return;
      }
      closeViewEditor(true);
      return;
    }
    if (
      event.key === 'Tab' &&
      !event.shiftKey &&
      (document.activeElement as HTMLElement | null)?.dataset.control === 'view-order'
    ) {
      event.preventDefault();
      found(viewPop, 'view-delete')?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      return;
    }
    if ((document.activeElement as HTMLElement | null)?.dataset.control === 'view-order') {
      return;
    }
    // The box keeps Home and End, which move the caret inside the name being typed.
    if ((event.key === 'Home' || event.key === 'End') && document.activeElement === viewInput) {
      return;
    }
    // A disabled button is not a stop. Save is disabled while the name is empty or taken, and a
    // walk that landed on it would leave the reader holding nothing at the end of the list.
    const stops = [...viewPop.querySelectorAll<HTMLElement>('.labelfind, .launchactions button')].filter(
      (node) => !(node as HTMLButtonElement).disabled,
    );
    if (!stops.length) {
      return;
    }
    let at = stops.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Home') {
      at = 0;
    } else if (event.key === 'End') {
      at = stops.length - 1;
    } else if (event.key === 'ArrowDown') {
      at = Math.min(at + 1, stops.length - 1);
    } else {
      at = Math.max(at - 1, 0);
    }
    stops[at]?.focus();
    event.preventDefault();
  });

  // Escape alone. The box and the two buttons are what Tab already walks.
  renamePop.addEventListener('keydown', (event) => {
    if (!renameOpen || event.isComposing || event.keyCode === 229 || event.key !== 'Escape') {
      return;
    }
    event.preventDefault();
    closeSessionRename(true);
  });

  railFilterPop.addEventListener('keydown', (event) => {
    if (!railFilterOpen || event.isComposing || event.keyCode === 229) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (railFilterDeleteArmed) {
        railFilterDeleteArmed = false;
        drawRailFilterPop('railfilter-delete');
      } else if (railFilterNameMode) {
        railFilterNameMode = null;
        drawRailFilterPop('railfilter-save-as');
      } else {
        closeRailFilterPicker(true);
      }
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      return;
    }
    if (
      (event.key === 'Home' || event.key === 'End') &&
      (document.activeElement === railFilterSearchInput || document.activeElement === railFilterNameInput)
    ) {
      return;
    }
    const stops = [...railFilterPop.querySelectorAll<HTMLElement>('input, button')].filter(
      (node) => !(node as HTMLButtonElement).disabled,
    );
    if (!stops.length) {
      return;
    }
    let at = stops.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Home') {
      at = 0;
    } else if (event.key === 'End') {
      at = stops.length - 1;
    } else if (event.key === 'ArrowDown') {
      at = Math.min(at + 1, stops.length - 1);
    } else {
      at = Math.max(at - 1, 0);
    }
    stops[at]?.focus();
    event.preventDefault();
  });

  nav.addEventListener('keydown', (event) => {
    if (!plainNavigationKey(event)) return;
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    const from = target.closest<HTMLElement>('button');
    if (!from || owner.handleHotkey(event, from)) return;
    const controls = primaryControls();
    const primary = from.matches('.railact')
      ? from.closest('.railrow')?.querySelector<HTMLElement>('.railcard')
      : from.matches('.railviewmenu')
        ? from.closest('h2')?.querySelector<HTMLElement>('.railfold')
        : from;
    const index = controls.indexOf(primary as HTMLElement);
    if (index < 0) return;
    const next = navigationIndex(event.key, index, controls.length);
    if (next === null) return;
    event.preventDefault();
    controls[next]?.focus();
  });
  sash.addEventListener('keydown', (event) => {
    if (!plainNavigationKey(event)) return;
    const next = railWidthKey(event.key, effectiveWidth(), widthMaximum());
    if (next === null) return;
    event.preventDefault();
    if (next === effectiveWidth()) return;
    width = next;
    drawWidth();
    options.onLayoutChange();
    options.save();
  });
  nav.addEventListener('scroll', options.dismissHint);
  sash.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    sash.setPointerCapture(event.pointerId);
    const fromX = event.clientX;
    const fromWidth = effectiveWidth();
    const moved = (move: PointerEvent) => {
      width = effectiveRailWidth(fromWidth + move.clientX - fromX, widthMaximum());
      drawWidth();
      options.onLayoutChange();
    };
    const done = () => {
      sash.removeEventListener('pointermove', moved);
      sash.removeEventListener('pointerup', done);
      sash.removeEventListener('pointercancel', done);
      options.save();
    };
    sash.addEventListener('pointermove', moved);
    sash.addEventListener('pointerup', done);
    sash.addEventListener('pointercancel', done);
  });

  media.addEventListener('change', () => {
    const launcherBack = options.launcher.open() ? options.launcher.anchor() : null;
    if (options.launcher.open()) {
      options.launcher.close(false);
    }
    drawVisibility();
    drawFilterPop();
    if (launcherBack) {
      const compactMenu = options.launcher.compactMenu();
      const button =
        launcherBack === railNewMenu || launcherBack === compactMenu
          ? visible()
            ? railNewMenu
            : compactMenu
          : launcherBack;
      if (button?.isConnected && !button.closest('[hidden]')) {
        button.focus();
      }
    }
  });
  options.events.document('selectionchange', () => owner.releaseSelection());
  // A press outside the View menu gives focus to the control it landed on. A press on
  // anything that takes no focus leaves focus on the body or in the hidden menu, so the
  // funnel takes it back there.
  const settleRailFilterFocus = () => {
    if (!railFilterFocusBack) {
      return;
    }
    railFilterFocusBack = false;
    const active = document.activeElement;
    const lost = !active || active === document.body || railFilterPop.contains(active);
    if (lost && !railFilterOpen && railFilterButton?.isConnected) {
      // The pointer rests where the reader pressed, so the funnel takes focus without its hint.
      options.quietHint(railFilterButton);
      railFilterButton.focus();
    }
  };
  options.events.document('pointerup', () => {
    dragging = false;
    settleRailFilterFocus();
  });
  options.events.document('pointercancel', () => {
    dragging = false;
    settleRailFilterFocus();
  });
  options.events.document('pointerdown', (event) => {
    const target = event.target as HTMLElement | null;
    dragging = !!target && nav.contains(target);
    railFilterFocusBack = false;
    if (labelsOpen) {
      const back = labelAnchor();
      if (!labelPop.contains(target) && !back?.contains?.(target)) {
        closeLabelEditor(false);
      }
    }
    if (viewOpen) {
      const back = viewAnchor();
      if (!viewPop.contains(target) && !back?.contains?.(target)) {
        closeViewEditor(false);
      }
    }
    if (renameOpen && !renamePop.contains(target) && !renameAnchor()?.contains?.(target)) {
      closeSessionRename(false);
    }
    if (railFilterOpen && !railFilterPop.contains(target) && !railFilterButton?.contains?.(target)) {
      closeRailFilterPicker(false);
      railFilterFocusBack = true;
    }
    if (labelsPending && !labelsPending.anchor?.contains?.(target)) {
      labelsPending = null;
    }
    if (!filterPop.hidden && !filterPop.contains(target) && target !== filterInput) {
      filterShutOn = filterShutWord(filterWord());
      drawFilterPop();
    }
  });
  options.events.document('contextmenu', (event) => {
    labelArm = null;
    viewArm = null;
    renameArm = null;
    const target = event.target as HTMLElement | null;
    const head = target?.closest<HTMLElement>('.railviewheading');
    const bucket = head?.dataset.bucket;
    if (bucket?.startsWith(VIEW_FOLD_PREFIX)) {
      const node = target?.closest<HTMLElement>('.railviewmenu') || head!.querySelector<HTMLElement>('.railfold');
      if (node) {
        viewArm = { view: bucket.slice(VIEW_FOLD_PREFIX.length), node, at: Date.now() };
      }
    }
    const row = target?.closest<HTMLElement>('.railrow') || target?.closest<HTMLElement>('.sessionrow');
    if (!row) {
      return;
    }
    const card = row.querySelector<HTMLElement>('.railcard');
    const session = card?.dataset.session ?? row.dataset.session;
    if (!session) {
      return;
    }
    // The arm reads the context the menu reads, so the editor opens exactly where the menu
    // offers Rename session. A heading's anchor is the control the press came from: the
    // Session actions button, or else the disclosure.
    if (renameOffered(card ?? row)) {
      const heading = row.classList.contains('sessionrow')
        ? target?.closest<HTMLElement>('.sessionheading > .sessionmenu:not(.sessionlayout):not(.sessionpin)') ||
          row.querySelector<HTMLElement>('.session')
        : null;
      renameArm = { session, node: heading || card || row, at: Date.now() };
    }
    const node =
      row.querySelector<HTMLElement>('.raillabelact') || row.querySelector<HTMLElement>('.session') || card || row;
    labelArm = { session, node, at: Date.now() };
  });
  options.events.window('resize', () => owner.place());

  if (typeof ResizeObserver === 'function') {
    // The head includes Project cost. Its height offsets the sticky bucket headings and the
    // scroll padding, so a row reached from the keyboard stays below the head.
    const measured = new ResizeObserver(() => {
      nav.style.setProperty('--rail-top', `${top.getBoundingClientRect().height}px`);
    });
    measured.observe(top);
  }
  drawWidth();
  drawTop();
  drawLabelPop();
  drawViewPop();
  drawRenamePop();
  drawRailFilterPop();
  drawVisibility();
  options.clock.subscribe((now) => owner.tick(now));
  return owner;
}
