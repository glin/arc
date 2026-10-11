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
  sessionQueryError,
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
  viewNameForQuery,
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
import { textField } from './text-field.ts';
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
  labelFindClear: string;
  railFilterFindClear: string;
  railFilterNameClear: string;
  viewNameClear: string;
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
  readOnly?: boolean;
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
  // Native menu context carries read-state section, pin state, archive state, and saved-session status.
  // Session headings and session list rows use the same pin and archive state.
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
  // Optional full-list draw counter for tests. Production supplies no callback.
  onDraw?(): void;
}

// Query matching reads cache warmth and recent activity against the browser clock.
// Attach these facts to session list cards before matching.
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

// releaseSelection, tick, reset, filterByLabel, and receiveLabelEditor can redraw the full session list.
// Call these methods after processing a batch rather than inside a session loop.
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
    // Figures keyed by session id. Session list cards and session headings read the same source.
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
  applyQuery(query: string): void;
  filterByLabel(name: string): void;
  toggleLabelEditor(session: string, anchor?: HTMLElement | null): void;
  receiveLabelEditor(session: string, heading: string, rows: LabelEditorRow[]): void;
  labelsChanged(session: string): void;
  openArmedLabelEditor(session: string): void;
  adoptSessionIdentity(provisional: string, durable: string): void;
  handleHotkey(event: KeyboardEvent, from: HTMLElement): boolean;
  place(): void;
  setViewSort(value: string): void;
  // Refresh one session's native menu context after a pin or archive change.
  // The timeline renderer exposes the same operation for session headings.
  drawRowContext(session: string): void;
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
  // Section fold id, or null for an action outside the session list.
  // Repeated sessions need a section identity to anchor, report, and toggle the correct label popover.
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

// Saved-view editor state.
interface OpenView {
  view: string;
  name: string;
  sort: string;
  // The first Delete press arms confirmation. Escape or Cancel disarms it.
  armed: boolean;
  anchor: HTMLElement | null;
  control: string;
}

// Hold the query separately while the filter box contains the new view name.
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

// Saved-session context enables Rename. Provisional drafts have no saved record.
function renameOffered(node: HTMLElement): boolean {
  try {
    return (JSON.parse(node.dataset.vscodeContext ?? '{}') as { sessionPersisted?: unknown }).sessionPersisted === true;
  } catch {
    return false;
  }
}
// Retain a bounded set of provisional-to-durable draft identities.
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

// A row's cache bolt names its cache lifetime in a native title.
// Active's count bolt uses the count's accessible name and has no separate title.
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

// Combine the shared card name with clock-dependent running and cache text, then the full activity time.
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

// Project the figures once when adopting a payload. Rows reuse this result on clock redraws.
// Only figures with metric and compactLabel fields enter the projection.
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
  // Mark the row that anchors the open label editor.
  // An action outside the session list uses the first occurrence, matching labelAnchorFor.
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
              railAgentWordShown(bucket)
                ? h(
                    'span',
                    { class: 'railagent', title: card.agentWord !== card.agent ? card.agentWord : undefined },
                    card.agent || card.agentWord,
                  )
                : null,
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
      !options.readOnly &&
        h(
          'button',
          {
            class: 'railact raillabelact',
            hidden: options.readOnly,
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
      !options.readOnly &&
        h(
          'button',
          {
            class: card.archived ? 'railact railhide is-archived' : 'railact railhide',
            hidden: options.readOnly,
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
      !options.readOnly &&
        h(
          'button',
          {
            class: card.pinnedTop ? 'railact railpin is-pinned' : 'railact railpin',
            hidden: options.readOnly,
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

// Show more adds the next RAIL_ROW_STEP rows to its section.
// The keyed button preserves focus as rows appear above it. Its accessible name includes the group.
// Its section id also identifies the focus fallback when a redraw removes it.
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

// Each group heading reports its own name and total count.
// Saved-view headings carry context for rename and delete commands. Time-bucket headings carry no editing context.
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
  // Number of mounted session rows. Folded and empty groups expose no controlled list.
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
  filter,
  notes,
  options,
  setInput,
}: {
  owner: RailRenderer;
  open: OpenLabels | null;
  rows: LabelEditorRow[];
  create: string;
  filter: string;
  notes: readonly (keyof typeof LABEL_NOTES)[];
  options: RailOptions;
  setInput(node: HTMLInputElement | null): void;
}): ComponentChildren {
  return h(Fragment, null, [
    h('div', { class: 'launchhead', key: 'head' }, open?.heading || ''),
    h(
      'div',
      { class: 'labelsearch', key: 'search' },
      textField({
        type: 'text',
        class: 'labelfind',
        placeholder: options.words.labelFind,
        'aria-label': options.words.labelFind,
        'data-control': 'label-find',
        ref: setInput,
        text: filter,
        cross: options.cross,
        clearLabel: options.words.labelFindClear,
        clearControl: 'label-find-clear',
        onClear: () => (owner as RailRenderer & { setLabelFilter(value: string): void }).setLabelFilter(''),
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

// The funnel opens the View menu: find, Filter, Group by, Sort by, Rows, Show, labels, and saved filters.
// Setting presses leave the menu open with focus on the pressed control.
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
  // Omit chips for negated labels. Adding the positive term would contradict the query and empty the session list.
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
      textField({
        type: 'text',
        class: 'labelfind',
        placeholder: options.words.railFilterFind,
        'aria-label': options.words.railFilterFind,
        'data-control': 'railfilter-find',
        defaultValue: search,
        ref: setSearchInput,
        text: search,
        cross: options.cross,
        clearLabel: options.words.railFilterFindClear,
        clearControl: 'railfilter-find-clear',
        onClear: () => menu.setRailFilterSearch(''),
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
      !options.readOnly &&
        h('div', { class: 'railfiltersectionname railheadlensname', id: 'railheadlensname' }, [
          options.words.railHeadLensesName,
        ]),
      !options.readOnly &&
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
    // Group by rearranges sessions without filtering them, so its values carry no counts.
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
              // The visible sort name is abbreviated. Accessible names and hints carry the full direction.
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
    // Both row densities use the same card markup. The stylesheet reads the session list's data-density.
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
    // Show switches hide archived sessions or agent runs together with their counted figures.
    // They control group visibility rather than query matching.
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
    // Show Match whenever the workspace has labels. Draw chips only when the query and find box leave matches.
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
          textField({
            id: 'railfiltername',
            type: 'text',
            class: 'labelfind',
            value: nameMode.name,
            'data-control': 'railfilter-name',
            text: nameMode.name,
            cross: options.cross,
            clearLabel: options.words.railFilterNameClear,
            clearControl: 'railfilter-name-clear',
            onClear: () => (owner as RailRenderer & { setRailFilterName(value: string): void }).setRailFilterName(''),
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
    !options.readOnly &&
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

// Rename and delete context commands open this saved-view editor.
// It edits the name and sort order, or deletes the view. The saved query stays unchanged.
// Arrow keys and Home or End move between fields and enabled actions outside the native sort selector.
// Escape disarms Delete before closing the editor.
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
      textField({
        type: 'text',
        id: 'viewname',
        class: 'labelfind',
        value: open.name,
        'data-control': 'view-name',
        text: open.name,
        cross: options.cross,
        clearLabel: options.words.viewNameClear,
        clearControl: 'view-name-clear',
        onClear: () => (owner as RailRenderer & { setViewName(value: string): void }).setViewName(''),
        // Associate the name field with its validation notes.
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
  // Keep the newest figures separately from the drawn figures. Retained rows must use the figures in their current accessible names.
  let latestStats: Readonly<Record<string, readonly PanelStat[]>> = {};
  let drawnStats: Record<string, readonly RailStat[]> = {};
  // Build compact hover cards from the drawn rows and figures. Missing sessions close the hint.
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
  // Retain rows during a pointer drag until release, including when the selected session changes.
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
  // Map provisional draft ids to durable ids, newest last. Delayed heading actions and label replies resolve through this map.
  const adopted = new Map<string, string>();
  const current = (session: string) => adopted.get(session) ?? session;
  let labelFilter = '';
  let labelsMade: string[] = [];
  let labelArm: LabelArm | null = null;
  // Remember this panel's view context-menu target and time.
  // Commands reach all panels, so only the panel that opened the menu must open the editor.
  let viewArm: { view: string; node: HTMLElement; at: number } | null = null;
  let views: readonly SavedView[] = [];
  let naming: NamingView | null = null;
  let viewOpen: OpenView | null = null;
  let viewInput: HTMLInputElement | null = null;
  // Remember this panel's saved-session context-menu target. Provisional drafts cannot arm Rename.
  let renameArm: { session: string; node: HTMLElement; at: number } | null = null;
  let renameOpen: OpenRename | null = null;
  let renameInput: HTMLInputElement | null = null;
  // The host echoes each rename request id. Ignore answers for editors that closed or sent a later request.
  // Randomize the starting id to reduce collisions with answers from an earlier page load.
  let renameRequests = Math.floor(Math.random() * 2 ** 40);
  let now = Date.now();
  // Retain mounted rows and their wording time for clock comparisons. Folded rows require no redraw.
  let drawnRows: RailTickRow[] = [];
  // Remember Show more steps per query and section. Returning to a query restores its steps.
  // Reset clears the map. Deleting a view removes its entries.
  const railRaised = new Map<string, number>();
  const railRaisedKey = (section: string) => `${filter}\u0000${section}`;
  // The next draw consumes this Show more request and computes one layout.
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
  let railQuickFilters = options.readOnly ? [] : normalizeRailQuickFilters(options.initial.headLenses);
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
  // An outside press defers focus restoration until the browser finishes moving focus.
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
  // Stamp clock facts whenever the filter or any saved-view query reads cache warmth or recent activity.
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
  // Match drawn cards after attaching required clock facts for the filter and saved views.
  // Unread and Needs input lenses retain read or answered sessions until the query changes.
  // The retained set is local to this page. setRailQuery clears it.
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
  // Build ordered groups and apply reader-owned folds.
  // A narrowing filter opens groups unless the reader has folded them under that filter.
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
    // Negated tokens offer ordinary completions with the negation mark restored and Filter out wording.
    // The mark alone offers every supported axis.
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
    // Suppress query completions while the box holds a view name. Accepting one would replace the typed name.
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
    // View naming removes combobox roles. Remove aria-expanded too, so the field cannot report an absent suggestions list.
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
  // Coalesce typing into one frame that saves the query, reads the clock, counts matches, and draws the list.
  // Immediate keystroke draws preserve the current counts until this frame.
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
  // Focus the open filter box, else Search, else the funnel.
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
  // Whether the current query and sort match the selected saved filter.
  const railFilterSelected = (): boolean => {
    const expected = selectedRailFilterLens();
    return Boolean(expected && sameRailFilterLens(expected, liveRailFilter()));
  };
  // All sessions displays a recognized status lens name regardless of term order or sort. Other edited queries display Custom.
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
    // Preserve the typed view name while naming holds the captured query separately.
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
  // Restore focus to the selected filter button, else the first button, else the funnel.
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
  // Naming holds existing counts. Refresh them at the current time when naming ends.
  let countsHeld = false;
  // Reuse supplied clock counts. keepCounts preserves displayed figures until the scheduled typing frame refreshes them.
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
    const invalidCost = naming ? null : (sessionQueryError(filter) ?? costNote(filter));
    // Invalid cache-expiry values have a separate note and DOM id from invalid cost values.
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
          // The action row holds Sessions or the filter box, Search or Clear, the funnel, then New.
          // Sessions is a read-only heading with no tab stop.
          h('div', { class: `railhead${open ? ' boxopen' : ''}`, key: 'head' }, [
            h('span', { class: 'railheadlabel', key: 'label' }, railLabel),
            // Reuse the filter box for the view name while naming retains the captured query.
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
                    // Associate the field with naming guidance or every visible query-validation note. Both query axes can be invalid together.
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
                      // Naming cancels the name. Filtering clears the query and closes the box. The accessible name describes the current action.
                      class: 'filterclear fieldclear',
                      type: 'button',
                      key: 'clear',
                      'aria-label': naming
                        ? options.words.railViewNameCancel
                        : filter
                          ? options.words.railFilterClear
                          : options.words.railFilterClose,
                      'data-hint': naming
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
                      // Search is replaced by Clear when the box opens. It has no expandable child.
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
            // New follows the filters in tab order. Its stable key preserves the button, ref, and focus across header redraws.
            !options.readOnly &&
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
          // Cost and cache-expiry each report their own invalid value.
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
          // Offer to save a valid filtering query only while the box is open and not already naming a view.
          !options.readOnly && open && !naming && viewFiles(filter) && !invalidCost && !invalidCacheExpiry
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
          // The field names this status region. It announces naming guidance as the reader types.
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
                  // Cache detail already appears in the accessible name. Show it in the hint without repeating the spoken description.
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

  // Adopt and post the complete saved-view list on each change. The next host payload replaces this local copy.
  // Concurrent edits from panels holding different copies can overwrite another panel's saved views.
  const postViews = (next: SavedView[]) => {
    pruneViewFolds(next);
    views = next;
    options.sendToHost({ type: 'setViews', views: next });
  };
  // Share naming notes between field validation and the status region.
  const namingNotes = (): readonly ViewNote[] =>
    naming ? [...viewQueryNotes(naming.lens.query), ...viewTypedNotes(views, naming.name, '')] : [];
  // Empty and taken names block saving. The length-limit note describes truncation and does not mark an accepted name invalid.
  const namingRefused = (): boolean => namingNotes().some((note) => note === 'unnamed' || note === 'taken');
  // Remove folds for deleted views and Show more steps for deleted views or changed queries.
  // View ids can be reused, so retained entries would give a new view the deleted view's presentation state.
  // Run before replacing the saved-view list.
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
  // Restore focus after deleting a view: first surviving group heading, then the visible filter box, then the panel fallback.
  const focusAfterViewGone = (): void => {
    const heading = listControls().find((node) => node.classList.contains('railfold')) ?? null;
    // Skip a filter box inside a hidden session list.
    const box = filterInput?.isConnected && !filterInput.closest('[hidden]') ? filterInput : null;
    const next = heading ?? box ?? options.fallbackFocus();
    if (!next) {
      return;
    }
    next.focus();
  };
  const startNaming = () => {
    if (options.readOnly) return;
    if (!viewCanSave(filter)) {
      return;
    }
    // Flush pending typing before freezing counts for the query being named.
    if (filterFrame !== null) {
      cancelAnimationFrame(filterFrame);
      drawFilterFrame();
    }
    naming = { lens: { ...liveRailFilter(), query: filter }, name: viewNameForQuery(filter, labels) };
    filterShutOn = null;
    filterAt = 0;
    if (filterInput) {
      filterInput.value = naming.name;
    }
    drawTop();
    drawFilterPop();
    filterInput?.focus();
    filterInput?.select();
  };
  // Restore the current query in the box when naming ends.
  const stopNaming = () => {
    naming = null;
    if (filterInput) {
      filterInput.value = filter;
    }
    drawTop();
    drawFilterPop();
    focusFilterRow();
  };
  // Save the captured query only if its bounded form contains a session-filter term.
  // Spaces, find terms, and in terms alone would create a view matching every session.
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
    // Restore the same control in its original group when available, then another occurrence of that control.
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
    // When Show more and its heading disappear, fall back to the last selector in that section.
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
  // Show more retains focus while rows remain. Drawing the final row removes the button and focuses that row.
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
    // Advance from the drawn extent, including rows revealed for the current session. Round to a whole step.
    const raisedCount = raising
      ? railLayout.sections.find((section) => section.id === raising)?.cards.length
      : undefined;
    if (raising && raisedCount !== undefined) {
      railRaised.set(railRaisedKey(raising), Math.ceil(drawnIn(raising, raisedCount) / RAIL_ROW_STEP));
    }
    // Use the mounted rows for drawing and later clock comparisons. Omitted rows cannot request a clock redraw.
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
        // An empty saved view keeps its heading for editing and deletion when no filter is active.
        // Its unfolded body explains the empty result.
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
    // Focus the final row directly when Show more disappears.
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
    // Preserve scroll on ordinary redraws. A Show more redraw scrolls its surviving button or final row into view.
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
  // Find the section identity of the row containing this control.
  const sectionOf = (node: HTMLElement | null | undefined): string | null =>
    node?.closest<HTMLElement>('.railrow')?.dataset.railBucket ?? null;
  // Find the first mounted row in a section after rebuilding the list.
  const sectionRow = (section: string | null): HTMLElement | null =>
    section ? document.querySelector<HTMLElement>(`.railrow[data-rail-bucket="${CSS.escape(section)}"]`) : null;
  // Prefer the initiating row when finding a label-editor anchor. Fall back to session controls elsewhere if rebuilding removed that row.
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
    // Place the label editor outside the session list row or session heading.
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
        filter: labelFilter,
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
    if (options.readOnly) return;
    // Close other popovers before opening the label editor.
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

  // Keep a connected rename anchor outside hidden elements. Otherwise, try its control in the section's first row.
  // If that fails, use the first session list occurrence. Anchors without a section use a whole-page lookup.
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
        cross: options.cross,
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
  // An answer moves focus only while it remains in the rename editor or has fallen back to the page body.
  const focusInRename = (): boolean => {
    const active = document.activeElement;
    return !active || active === document.body || renamePop.contains(active);
  };
  // Close the rename editor even while its request is pending. Late answers find no waiting editor.
  // Return focus to its visible anchor when requested, else the panel fallback.
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
    // Keep focus in the name box when Save becomes disabled during the request.
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
      // Close an editor whose saved view disappeared. Restore its focus after drawing the surviving headings.
      const rescue = !!viewOpen && !findView(views, viewOpen.view) && viewPop.contains(document.activeElement);
      if (viewOpen && !findView(views, viewOpen.view)) {
        closeViewEditor(false);
      }
      // A removed session closes its rename editor. Move focus to the panel fallback if the editor held it.
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
      // Move the current-session highlight despite retained text selection, unless a pointer drag is still active.
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
      // Refresh an open hover card after figure or state changes that leave the row's attributes unchanged.
      options.redrawHint('railcard');
    },
    updateLauncher(view) {
      launcherView = view;
      drawTop();
      drawFilterPop();
    },
    drawRowContext(session) {
      // Refresh every occurrence of the session, including repeated saved-view rows.
      for (const row of nav.querySelectorAll<HTMLElement>('[data-vscode-context]')) {
        if (row.dataset.session !== session) {
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
      // Redraw after patching menu context so Preact's retained props match the DOM.
      // Otherwise a later redraw can skip an attribute write and leave stale menu actions.
      // Use drawnCards so this refresh preserves the groups from the last adopted payload.
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
      // Refresh header counts deferred by the selection together with the list.
      drawTop();
      drawList();
      options.redrawHint('railcard');
    },
    tick(at = Date.now()) {
      const work = railTickWork(drawnRows, now, at, drawnTitlesAt, railAgeFormat(railDensity));
      // Update cache titles in place to preserve the hovered node.
      // Restrict row lookups to the session list even if another page element has the requested id.
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
      // Advance the tooltip clock only when every requested title was found. Retry missing titles on the next tick.
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
      // Reset closes the filter box together with clearing its query.
      filterRowOpen = false;
      railFilterId = ALL_RAIL_FILTER_ID;
      railFilters = [];
      width = RAIL_WIDTH_DEFAULT;
      railSort = 'latest';
      railDefaultSort = 'latest';
      // Restore default Show switches so reset reveals both archived sessions and agent runs.
      railShowArchived = RAIL_SHOWN_BUCKETS.showArchived;
      railShowRuns = RAIL_SHOWN_BUCKETS.showRuns;
      railQuickFilters = options.readOnly ? [] : [...DEFAULT_RAIL_QUICK_FILTERS];
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
    // Uses width alone so headings enable label filters before the first session list payload arrives.
    filterable: () => media.matches,
    // An external full assignment starts retention again, including an unchanged query.
    applyQuery(query) {
      railKept = null;
      filteredFolds.clear();
      setRailQuery(query);
      railFilterId = ALL_RAIL_FILTER_ID;
      if (filterInput) filterInput.value = filter;
      if (filterFrame !== null) {
        cancelAnimationFrame(filterFrame);
        filterFrame = null;
      }
      drawTop();
      drawList();
      drawFilterPop();
    },
    // Filter by a session heading's label and focus the filter box. Ignore the action while the session list is hidden.
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
      // Suppress suggestions for this completed label term.
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
      // Switching filters or restoring a Custom query clears naming and armed deletion.
      // Pressing the selected, unchanged filter preserves its typed name and delete state.
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
    // Set the selected status lens while preserving other terms, sort, and saved-filter identity. Keep the menu open on that value.
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
    // Save group presentation independently of the query. Redraw the list and menu.
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
    // Density changes row layout and age format. Save it with session list presentation, independently of saved filters and views.
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
    // Save group visibility and refresh list rows, header counts, and the menu.
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
      if (options.readOnly) return;
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
      if (options.readOnly) return;
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
      if (options.readOnly) return;
      railFilterDeleteArmed = false;
      railFilterNameMode = { kind: 'save', name: '' };
      drawRailFilterPop('railfilter-name');
    },
    renameRailFilter() {
      if (options.readOnly) return;
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
      if (options.readOnly) return;
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
      if (options.readOnly) return;
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
      if (options.readOnly) return;
      // The same session occurrence toggles its editor closed. Another occurrence moves the editor to that row.
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
    // Move open and pending label-editor state to the durable session id. Preserve the anchor until redraw replaces it.
    // Delayed provisional actions resolve through the retained identity map.
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
      if (options.readOnly) return;
      const arm = labelArm;
      if (!arm || arm.session !== session) {
        return;
      }
      if (Date.now() - arm.at > MENU_ARM_MS) {
        labelArm = null;
        return;
      }
      labelArm = null;
      // Prefer the context-menu target over session lookup, which cannot distinguish repeated rows.
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
    // Open the saved-view editor only for this panel's recent context-menu target. Close other popovers first.
    openViewEditor(view, mode) {
      if (options.readOnly) return;
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
    // Open Rename only in the panel holding the matching recent context-menu target.
    openSessionRename(session, title) {
      if (options.readOnly) return;
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
    // Apply the matching rename answer. Success closes the editor.
    // Move focus only if it remains in the editor or has fallen back to the body.
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
    // The first Delete press asks for confirmation on the same button. The second deletes the view.
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
      // Posting the updated list removes this view's folds and Show more steps.
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
      if (options.readOnly) return;
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
    const stops = [...labelPop.querySelectorAll<HTMLElement>('.labelfind, .fieldclear, .labelcreate, .labelbox')];
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

  // Native Tab walks the editor fields and actions. Arrow keys and Home or End supplement it outside the sort selector.
  // Escape disarms Delete first, then closes the editor.
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
    // Skip disabled buttons, including Save for an empty or taken name.
    const stops = [...viewPop.querySelectorAll<HTMLElement>('.labelfind, .fieldclear, .launchactions button')].filter(
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

  // Escape alone. The box, its cross, and the two buttons are what Tab already walks.
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
  // After an outside press, preserve focus on the pressed control. Restore the funnel if focus remains on the body or closed menu.
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
    // Arm Rename only where saved-session context offers it.
    // Session headings anchor to Session actions or the disclosure that opened the menu.
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
    // Measure the full header, including Project cost, for sticky group offsets and keyboard scroll padding.
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
