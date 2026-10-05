import { DRAFT_SESSION_PREFIX, normalizeSessionLabels, sweepDraftLabels } from './turnlabels';
import { normalizeSavedViews, type SavedView } from './domain/views.ts';
import { normalizeRailSort, type RailSort } from './domain/rail-sort.ts';
import {
  ALL_RAIL_FILTER_ID,
  boundedRailFilterQuery,
  migrateStoredRailLens,
  normalizeRailFilterId,
  normalizeSavedRailFilters,
  type RailLens,
  type SavedRailFilter,
} from './domain/rail-filters.ts';
import { isQueryMatch, type QueryMatch } from './domain/session-query.ts';
import { READ_LIMIT } from './turnread';
import { COMMENT_LIMIT, TurnComment, normalizeComments } from './turncomments';
import { RAIL_BUCKETS, clampRailWidth } from './turnrail';
import { clampPromptFloor } from './view/composer-size';
import {
  RAIL_FOLDS,
  RAIL_GROUP_FOLD_PREFIX,
  normalizeRailDensity,
  normalizeRailGroupBy,
  normalizeRailShowArchived,
  normalizeRailShowRuns,
  normalizeRailQuickFilters,
  type RailDensity,
  type RailGroupBy,
} from './view/rail.ts';
import {
  StoredPromptAsset,
  MAX_PROMPT_ASSETS,
  MAX_PROMPT_ASSET_TOTAL_BYTES,
  normalizePromptAssetBook,
  normalizeStoredPromptAsset,
} from './promptassets';

// The seams this file was split into. Re-exported rather than left for every caller to
// find, so a module that imports from turnview.ts keeps working and the split stays a
// move rather than a rename of every import in the repo.
export * from './turncard';
export * from './turncomments';
export * from './turnformat';
export * from './turnlabels';
export * from './turnrail';
export * from './turnread';
export * from './turnsearch';

// Which session the panel has on screen, out of the ones the workspace has, given the
// one it was asked for. One session is drawn at a time, so this answers null only when
// there is no session to answer with: an id whose transcript has gone, and a first paint
// with nothing asked for, both fall to the newest.
//
// The list arrives newest activity first, which is the order every other cut here is made in,
// so the newest is its first entry and no ranking is worked out again.
export function pickShowing(sessions: readonly string[], wanted: string | null): string | null {
  if (wanted && sessions.includes(wanted)) {
    return wanted;
  }
  return sessions.length ? sessions[0] : null;
}

export function orderSessionCatalog<T extends { sessionId: string }>(
  sessions: readonly T[],
  activityFor: (session: T) => number,
): T[] {
  return [...sessions].sort(
    (left, right) => activityFor(right) - activityFor(left) || left.sessionId.localeCompare(right.sessionId),
  );
}

// The turns the panel lists, out of everything the parse produced, handed in newest
// first. One global cap bounds the DOM, and two rules bend it. The session being
// shown alone fills first: it is the one on screen, and a cap shared with every parsed
// neighbour would cut the very turns the reader is there to read. And every parsed
// session keeps at least its newest turn, because the rail's status and count are read
// off the listed cards: a session parsed but absent from the list would wear neither, a
// blank card that cost a full tail parse, the pinned-to-top sessions most of all.
export function turnBudget<T extends { sessionId: string; startedAt: number }>(
  turns: T[],
  max: number,
  shown: string | null,
): T[] {
  const first = shown ? turns.filter((t) => t.sessionId === shown) : [];
  const rest = shown ? turns.filter((t) => t.sessionId !== shown) : turns;
  const cut = [...first, ...rest].slice(0, max);
  const have = new Set(cut.map((t) => t.sessionId));
  for (const t of rest) {
    if (!have.has(t.sessionId)) {
      cut.push(t);
      have.add(t.sessionId);
    }
  }
  return cut;
}

// Which editor group a file or a diff opened from the panel should land in.
//
// The panel can be an editor tab of its own now, and a diff opened while that tab has focus
// lands in the panel's own group, which splits the reader's editor in two and puts the diff
// where the panel was. So the target is the group a text editor is actually in, and the
// panel's own group is never chosen while there is another.
//
// Numbers rather than `vscode.ViewColumn`, so the rule can be tested without an editor host.
// One is the first group, which is where a window with nothing open puts its first editor.
export function editorColumn(state: {
  active: number | null; // the column of the active text editor, if one has focus
  visible: number[]; // the column of every visible text editor
  panel: number | null; // the column the panel's own tab is in, if it is open
}): number {
  const notPanel = (c: number) => c !== state.panel;
  // What the reader was last looking at wins, because that is the group they mean by "here".
  if (state.active !== null && notPanel(state.active)) {
    return state.active;
  }
  // Otherwise the leftmost group holding a file, which is the one a reader with a split keeps
  // their work in.
  const open = state.visible.filter(notPanel).sort((a, b) => a - b);
  if (open.length) {
    return open[0];
  }
  // Nothing else is open. The panel's own group is then the right answer rather than a wrong
  // one: the diff opens as another tab beside the panel instead of splitting the window,
  // and not splitting is the whole point of this.
  return state.panel ?? 1;
}

// The group a beside-open reuses, or null when a new one has to be split off.
//
// Ctrl, or Cmd on a Mac, asks for a group of the diff's own, and the first press splits one
// off. A second press should land in the group the first one made, not split again: the
// editor's own lists reuse their side group the same way, and a reader who ctrl-clicks down
// a list of turns wants one comparison column, not one per press.
//
// The remembered column answers only while it can keep that promise. Columns are positions,
// not identities: closing a group hands its number to a neighbour, so a column no longer
// open says nothing, and one now occupied by the panel's own tab would land the diff on
// the panel, which is the one group editorColumn exists to refuse.
export function besideColumn(state: {
  last: number | null; // the column the previous beside-open landed in
  groups: number[]; // the column of every editor group open now
  panel: number | null; // the column the panel's own tab is in, if it is open
}): number | null {
  if (state.last === null) {
    return null;
  }
  if (state.last === state.panel) {
    return null;
  }
  return state.groups.includes(state.last) ? state.last : null;
}

// The same ceiling for the fields holding one entry per session: the folds, the hidden
// set, the pinned-to-top set and the read watermarks. Far past any real workspace, measured
// against the real thing: 52 sessions in this workspace and 132 in the largest project
// on this machine. Nothing here is under pressure, and the totals are small enough that this
// is tidiness rather than a leak; it exists because nothing drops an id whose session
// has gone, and Claude Code deletes its own transcripts on a schedule, so a hidden
// session's id outlives the session.
export const SESSION_LIMIT = 500;

// What the panel remembers between reloads, and now between the two places it can be drawn.
export type QueueDelivery =
  | { phase: 'queued'; owner: string; resetId?: string; barrier?: string }
  | { phase: 'delivery'; owner: string }
  | { phase: 'recovery'; owner: string; reason: string }
  | { phase: 'reset-in-flight'; owner: string; source: string; resetId: string }
  | { phase: 'unknown'; owner: string; source: string; resetId: string; reason: string }
  | { phase: 'source-recovery'; owner: string; source: string; resetId: string; reason: string }
  | { phase: 'draft-recovery'; owner: string; source: string; resetId: string; successor?: string }
  | { phase: 'source-owned'; owner: string; source: string; resetId: string }
  | { phase: 'source-delivery'; owner: string; source: string; resetId: string }
  | { phase: 'successor-owned'; owner: string; source: string; successor: string; resetId: string; barrier?: string }
  | { phase: 'successor-delivery'; owner: string; source: string; successor: string; resetId: string }
  | { phase: 'successor-recovery'; owner: string; source: string; successor: string; resetId: string; reason: string };

export interface QueuedSubmission {
  recoveryId?: string;
  id: string;
  text: string;
  commentIds: string[];
  assets: StoredPromptAsset[];
  at: number;
  reason?: string;
  delivery: QueueDelivery;
}

import { mergeSubmittedPrompts, type SubmittedPrompt } from './webview/state';

export interface PanelState {
  readerParents: Record<string, string>;
  submittedPrompts?: SubmittedPrompt[];
  open: string[];
  // The sessions a build with a fold on its heading had folded away. Nothing reads it:
  // the panel draws one session at a time, so folding it left a heading over an empty
  // list, and the heading's press now opens and shuts the turns instead. The field stays so
  // a value that build stored still normalizes rather than throwing, and so the next save
  // writes an empty one over it.
  collapsed: string[];
  hidden: string[];
  // The sessions pinned to the top of the rail. They stay there and stay parsed
  // however old they get, which is what pinning promises.
  pinnedTop: string[];
  // The labels the reader has filed each session under, by session id, in the order they
  // applied them.
  //
  // The reader's own opinion about a session, not a copy of anything the agent recorded.
  // The transcript already supplies a name, and that name says what the work was. A label says
  // what the reader will go looking for the session under later. That is a different
  // question, and nothing an agent writes answers it.
  //
  // Kept for the reason the notes and the drafts are. These are words the reader chose, and
  // no press rebuilds them. A session with no label takes no entry, so a workspace
  // nobody has filed costs nothing. `turnlabels.ts` holds the ceilings, and the rule that one
  // label carries one spelling.
  labels: Record<string, string[]>;
  // The filters the reader saved under a name, in the order they saved them. The rail draws
  // one section per view, so the order here is the order of the headings on screen.
  //
  // Held here for the reason the labels and the notes are. A view's name is a word the reader
  // typed, and no press rebuilds it. The panel edits the list through a message of its own,
  // and a state save carries back the copy that panel was served, so a second host opened
  // before the reader made a view would otherwise write an empty list over every one of them.
  //
  // A view narrows the rail alone. Nothing in the extension reads one to decide what to parse,
  // which is why this is the reader's own filing rather than a cut like the hidden set.
  views: SavedView[];
  read: string[];
  // How far the reader has marked each session read, by session id: the start time of
  // the newest turn they marked. The read set above is per turn, and a session's older turns
  // are usually not parsed, so "this session is read" cannot be written as a key per
  // turn: the ones on screen would be marked and the session would go unread again the
  // moment more of it was parsed. The watermark is the answer to that, and it stands beside
  // the per-turn set rather than replacing it, because a turn can be read on its own.
  readTo: Record<string, number>;
  // The moment this workspace first drew the panel. Every turn that started before it counts
  // as read, and it is written once and never again.
  //
  // Without it a reader opening a project for the first time is handed every turn every agent
  // has ever run there, all of it unread, and the one thing the panel is for, saying what is
  // new, says nothing. The reader did not fail to read those turns. They were not being
  // offered them.
  //
  // A floor rather than a watermark per session, because the rail lists sessions
  // the panel has never parsed and cannot name them all to write a mark each. `isTurnRead`
  // reads it as the watermark a session with none of its own falls back to, so a
  // session the reader has marked either way keeps its own answer and this decides only
  // the rest. Zero means no floor, which is what a reader who was already here has.
  since: number;
  // Which session is on screen, by id, or empty for none. The panel shows one
  // session at a time, so this is the whole of what it is looking at, and it is
  // remembered for the reason the folds are: a reload that opened on a different
  // session would read as a different panel.
  showing: string;
  // A session query, left by a build that had a box to type one into. Nothing reads or
  // writes it now: with no such box on screen a stored value would narrow the list for ever
  // and leave the reader nothing to widen it with. The field stays so an old value still
  // normalizes rather than throwing.
  filter: string;
  railFilter: string;
  railMatch: QueryMatch;
  railFilterId: string;
  railFilters: SavedRailFilter[];
  railSort: RailSort;
  railDefaultSort: RailSort;
  // The View menu's Group by value. Rail-wide view state like the sort, and not part of a saved
  // filter, so opening a saved filter keeps it.
  railGroupBy: RailGroupBy;
  // The View menu's Rows value. Rail-wide presentation state saved beside the rail width, and
  // not part of a saved filter or view.
  railDensity: RailDensity;
  // Whether the rail draws the archived sessions and the sessions an agent ran. The reader
  // sets each one from the View menu, and both start on, so a state saved before the
  // switches existed opens the rail drawing everything it drew before.
  railShowArchived: boolean;
  railShowRuns: boolean;
  // Which lens counts may draw on the rail head, from the View menu's Quick filters line. View
  // state like the Show switches, and not part of a saved filter.
  railQuickFilters: RailLens[];
  railWidth: number;
  composerHidden: boolean;
  promptFloor: number;
  // Which rail buckets the reader has opened or shut, by bucket id: true for one they
  // opened, false for one they shut, and no entry at all for one they have never pressed,
  // where the panel's own default stands.
  //
  // Remembered for the reason the shown session is. A reader who shuts Today means the
  // rail to look that way, and a reload that opened every bucket again would read as a
  // different panel rather than the same one back.
  railFolds: Record<string, boolean>;
  // The notes the reader has left on turns, oldest first. See `TurnComment` for what one
  // holds and why. This and the drafts below are the two fields here the reader wrote by
  // hand rather than made by pressing something, so they are the ones that cannot be got
  // back, and they are why the panel's state is remembered at all rather than rebuilt on
  // every reload.
  comments: TurnComment[];
  // What the reader typed into the prompt box and has not sent, by session id.
  //
  // Kept for the notes' reason. Every other field here is a set the reader can rebuild by
  // pressing the control again; a half-written prompt is words, and a reload is not always
  // chosen. An empty box stores nothing, so a session the reader never typed into
  // costs no entry.
  drafts: Record<string, string>;
  // The prompts this panel sent for a session that no transcript has recorded yet, by
  // session id, newest first.
  //
  // Kept for the drafts' own reason: an agent process that dies before it writes the
  // transcript takes the only other copy of these words with it. `sentAfter` fills this in
  // memory at send time. Once the transcript records the same prompt, the transcript is the
  // durable copy, so `sentPromptsToSave` drops that entry from what gets stored here. The
  // in-memory copy is not touched by that pruning, so Up still returns the typed words for
  // the rest of the window.
  sentPrompts: Record<string, string[]>;
  // Comment ids reserved for a waiting prompt currently back in the composer for editing.
  // They remain on their turns, so this claim keeps an earlier queued prompt from taking
  // them while the edit is unfinished.
  draftCommentIds: Record<string, string[]>;
  // The sessions this workspace started from the panel, oldest first. A fresh
  // session reads as a run another agent shelled out for: a Claude transcript names
  // nobody as its author, and a first turn carries no sign of a person. This record is the
  // one positive fact, and it is kept between reloads because the transcript never becomes
  // any more readable than it was on the day it was written.
  started: string[];
  // Normalized descriptors for extension-staged files held with each draft. The bytes stay
  // in global storage and never enter this state.
  assets: Record<string, StoredPromptAsset[]>;
  // Submissions accepted by the panel but not yet accepted by an agent, by session.
  // File descriptors move here from `assets` with the submission that owns them.
  queues: Record<string, QueuedSubmission[]>;
}

// Every node is visited once. A cycle loses its own edges, while incoming paths remain valid.
export function normalizeReaderParents(raw: unknown): Record<string, string> {
  const parents: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return parents;
  for (const [child, parent] of Object.entries(raw)) {
    if (child && child !== '__proto__' && typeof parent === 'string' && parent && child !== parent)
      parents[child] = parent;
  }
  const settled = new Set<string>();
  for (const child of Object.keys(parents)) {
    if (settled.has(child)) continue;
    const path: string[] = [];
    const positions = new Map<string, number>();
    let id: string | undefined = child;
    while (id !== undefined && !settled.has(id) && !positions.has(id)) {
      positions.set(id, path.length);
      path.push(id);
      id = Object.hasOwn(parents, id) ? parents[id] : undefined;
    }
    if (id !== undefined && positions.has(id)) {
      for (let index = positions.get(id)!; index < path.length; index++) delete parents[path[index]];
    }
    for (const node of path) settled.add(node);
  }
  return parents;
}

export function remapReaderParents(
  parents: Record<string, string>,
  provisional: string,
  actual: string,
): Record<string, string> {
  const moved: Record<string, string> = {};
  for (const [child, parent] of Object.entries(parents))
    moved[child === provisional ? actual : child] = parent === provisional ? actual : parent;
  return normalizeReaderParents(moved);
}

export function abandonReaderParents(parents: Record<string, string>, draft: string): Record<string, string> {
  return Object.fromEntries(Object.entries(parents).filter(([child, parent]) => child !== draft && parent !== draft));
}

// The saved state, made safe to use.
//
// It comes back from storage that outlives the code that wrote it: a set written by an older
// version, a key since renamed, or a file edited by hand all arrive here, and the panel has
// no way to report a bad one. So every field is rebuilt rather than trusted, a value of the
// wrong shape becomes the empty answer for its field rather than throwing, and every field
// with a ceiling is cut to it on the way in as well as on the way out. A panel that throws
// while reading its own state draws nothing at all and says nothing about why.
//
// `heldRailFilters` is the saved filter list the extension holds, for a caller whose state
// omits the list. A panel's state save carries no list, and the selected filter id, its query
// and its lens are checked against the one given here instead.
export function normalizePanelState(raw: unknown, heldRailFilters?: readonly SavedRailFilter[]): PanelState {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  // Every list is cut to its ceiling here, and the newest are what is kept: each is written
  // oldest first, so a list restored over its ceiling drops from the front, which is the end
  // `markRead` already drops.
  const ids = (value: unknown, limit: number): string[] => {
    const kept = Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
    return kept.slice(Math.max(0, kept.length - limit));
  };
  // The watermarks, rebuilt entry by entry. A value that is not a finite number is dropped
  // rather than kept: every other field here is rebuilt rather than trusted, and a watermark
  // read as a string or a NaN would compare against a turn's start time and answer nonsense.
  // The newest entries are kept for the same reason a list's are.
  const readTo: Record<string, number> = {};
  const marks =
    src.readTo && typeof src.readTo === 'object' && !Array.isArray(src.readTo)
      ? (src.readTo as Record<string, unknown>)
      : {};
  const held = Object.entries(marks).filter(([, at]) => typeof at === 'number' && Number.isFinite(at));
  for (const [id, at] of held.slice(Math.max(0, held.length - SESSION_LIMIT))) {
    readTo[id] = at as number;
  }
  const views = normalizeSavedViews(src.views);
  const railFilters = heldRailFilters ? [...heldRailFilters] : normalizeSavedRailFilters(src.railFilters);
  const railSort = normalizeRailSort(src.railSort);
  const railDefaultSort = src.railDefaultSort === undefined ? railSort : normalizeRailSort(src.railDefaultSort);
  // A lens an older build stored as rail state, as the old Warm words, or as the retired Needs
  // you filter id, joins the query as the words a count press now writes, before the id is
  // checked against the saved list.
  const storedRail = migrateStoredRailLens({
    filterId: src.railFilterId,
    query: boundedRailFilterQuery(src.railFilter),
    match: isQueryMatch(src.railMatch) ? src.railMatch : 'all',
    lens: src.railLens,
  });
  const railFilterId = normalizeRailFilterId(storedRail.filterId, railFilters);
  const missingRailFilter =
    typeof storedRail.filterId === 'string' &&
    storedRail.filterId !== '' &&
    storedRail.filterId !== ALL_RAIL_FILTER_ID &&
    railFilterId === ALL_RAIL_FILTER_ID;
  return {
    // A turn key, the same shape and the same units as a read one.
    open: ids(src.open, READ_LIMIT),
    // One entry per session, so these take the session-shaped ceiling.
    collapsed: ids(src.collapsed, SESSION_LIMIT),
    hidden: ids(src.hidden, SESSION_LIMIT),
    pinnedTop: ids(src.pinnedTop, SESSION_LIMIT),
    // Rebuilt by the module that owns them. It cuts a session's list and the record
    // itself to their ceilings, and files every name under one spelling.
    labels: normalizeSessionLabels(src.labels),
    readerParents: normalizeReaderParents(src.readerParents),
    // Rebuilt by the module that owns them, which cuts the list to its ceiling and drops an
    // entry it cannot read.
    views,
    read: ids(src.read, READ_LIMIT),
    readTo,
    // Rebuilt like the watermarks it stands in for, and zero rather than dropped where it
    // will not read: a floor that arrived as a string or a NaN would compare against a turn's
    // start and answer nonsense, and nonsense here hides turns rather than showing extra.
    since: typeof src.since === 'number' && Number.isFinite(src.since) && src.since > 0 ? src.since : 0,
    showing: typeof src.showing === 'string' ? src.showing : '',
    filter: typeof src.filter === 'string' ? src.filter : '',
    railFilter: missingRailFilter ? '' : storedRail.query,
    railMatch: missingRailFilter ? 'all' : storedRail.match,
    railFilterId,
    railFilters,
    railSort: missingRailFilter ? railDefaultSort : railSort,
    railDefaultSort,
    railGroupBy: normalizeRailGroupBy(src.railGroupBy),
    railDensity: normalizeRailDensity(src.railDensity),
    railShowArchived: normalizeRailShowArchived(src.railShowArchived),
    railShowRuns: normalizeRailShowRuns(src.railShowRuns),
    railQuickFilters: normalizeRailQuickFilters(src.railQuickFilters, src.railHeadLenses),
    railWidth: clampRailWidth(src.railWidth),
    composerHidden: src.composerHidden === true,
    promptFloor: clampPromptFloor(src.promptFloor, Number.POSITIVE_INFINITY),
    railFolds: normalizeRailFolds(src.railFolds),
    // The one field holding records rather than ids, so it is rebuilt record by record and
    // cut by its own count as well as by a ceiling on each string inside it.
    comments: normalizeComments(src.comments),
    ...(src.submittedPrompts === undefined ? {} : { submittedPrompts: mergeSubmittedPrompts(src.submittedPrompts) }),
    drafts: normalizeDrafts(src.drafts),
    sentPrompts: normalizeSentPrompts(src.sentPrompts),
    draftCommentIds: normalizeDraftCommentIds(src.draftCommentIds),
    // One entry per session, so this takes the session-shaped ceiling beside them.
    started: ids(src.started, SESSION_LIMIT),
    assets: normalizePromptAssetBook(src.assets),
    queues: normalizeQueuedSubmissions(src.queues),
  };
}

// The stored state with every abandoned draft's labels taken out of it.
//
// Run once, where the state is first read, and never on a write. `sweepDraftLabels` carries
// why, and this is the wrapper that puts the swept record back where the state holds it.
//
// It runs ahead of normalization rather than after it. `normalizeSessionLabels` cuts the
// record to its ceiling on the way through, so a stored record over that ceiling dropped an
// older real session to keep a draft id nothing can reach, and then shrank below the
// ceiling when the sweep ran a moment later. Sweeping first leaves the cut to decide between
// sessions that still exist.
//
// Reader parents also lose provisional identities at startup. Live normalization retains
// them until adoption or abandonment. Every other field remains with its normalizer.
export function withSweptDraftLabels(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return raw;
  }
  const src = raw as Record<string, unknown>;
  const labels = src.labels;
  const readerParents = normalizeReaderParents(src.readerParents);
  for (const [child, parent] of Object.entries(readerParents)) {
    if (child.startsWith(DRAFT_SESSION_PREFIX) || parent.startsWith(DRAFT_SESSION_PREFIX)) delete readerParents[child];
  }
  return {
    ...src,
    readerParents,
    ...(labels && typeof labels === 'object' && !Array.isArray(labels)
      ? { labels: sweepDraftLabels(labels as Record<string, string[]>) }
      : {}),
  };
}

// The stored state a webview is served, which is not the whole of it.
//
// `labels` stays behind. Nothing in the panel reads a label out of this state: each rail card
// arrives holding the chips it draws, worded beside the rule that decided which of them the
// row has room for. Serving the record would put every session's filing into the page of
// every host that opens, for no reader, and it would make the panel's own claim to keep no
// copy false of the page it was handed.
//
// Host-owned fields are taken out rather than naming the panel-owned fields to keep. A new
// panel-owned field then reaches the panel without changing this projection.
export function webviewPanelState(state: PanelState): Omit<PanelState, 'labels' | 'railFilters' | 'readerParents'> {
  const served: Partial<PanelState> = { ...state };
  delete served.labels;
  delete served.readerParents;
  delete served.railFilters;
  return served as Omit<PanelState, 'labels' | 'railFilters' | 'readerParents'>;
}

// How many folds the record keeps. Saved views have no reader-facing limit, so this ceiling
// only guards stored state that can retain keys for deleted views. The cut keeps the newest
// entries so a live view's fold replaces a stale one.
export const RAIL_FOLD_LIMIT = 200;

// The stored fold state, made safe to use.
//
// Rebuilt entry by entry rather than trusted, for the reason `normalizePanelState` gives.
// Only a key the rail can draw a heading for survives, and only a real boolean: a key the
// panel no longer has draws no heading to press, and a value of any other shape would decide
// a fold by whether it happens to be truthy.
//
// A key stored by a build that folded by the bucket id rather than by its fold name is
// dropped. Nothing reads one now, so keeping it would hold a place under the ceiling for a
// heading that can never be pressed. The reader loses one fold state on the upgrade and the
// defaults stand until they press a heading again.
export function normalizeRailFolds(raw: unknown): Record<string, boolean> {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const buckets = new Set<string>(RAIL_BUCKETS.map((id) => RAIL_FOLDS[id]));
  const held = Object.entries(src).filter(
    ([key, value]) => typeof value === 'boolean' && (buckets.has(key) || key.startsWith(RAIL_GROUP_FOLD_PREFIX)),
  );
  const out: Record<string, boolean> = {};
  for (const [key, value] of held.slice(Math.max(0, held.length - RAIL_FOLD_LIMIT))) {
    out[key] = value as boolean;
  }
  return out;
}

// The ceiling on one stored draft, in characters. A prompt written by hand runs far under
// it; a prompt pasted whole is the only thing that reaches it.
//
// A draft over the ceiling is dropped rather than cut. A cut one would come back into the
// box reading like the whole prompt, and the reader's next press would send the front half
// of what they wrote to the agent without either of them noticing. An empty box says
// plainly that nothing was kept.
export const DRAFT_TEXT_LIMIT = 20000;
// How big one prompt may be before Up-arrow history refuses to offer it. `promptHistory` and
// `promptsAcross` in composerview.ts skip any entry over this length, whether it came from
// the transcript or from a send this panel made. A saved prompt over this length could never
// reach the reader, so `normalizeSentPrompts` holds storage to the same bound.
export const PROMPT_HISTORY_ENTRY_CHARS = 4_000;
export const QUEUED_SUBMISSION_LIMIT = 64;
const QUEUED_SUBMISSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function legacyQueuedId(session: string, index: number, text: string): string {
  let hash = 0x811c9dc5;
  const input = `${session}\n${index}\n${text}`;
  for (let i = 0; i < input.length; i++) {
    hash = Math.imul(hash ^ input.charCodeAt(i), 0x01000193);
  }
  return `legacy-${index}-${(hash >>> 0).toString(36)}`;
}

export function normalizeQueuedSubmissions(raw: unknown): Record<string, QueuedSubmission[]> {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, QueuedSubmission[]> = {};
  for (const [session, value] of Object.entries(source).slice(-SESSION_LIMIT)) {
    if (!session || !Array.isArray(value)) {
      continue;
    }
    const entries: QueuedSubmission[] = [];
    const ids = new Set<string>();
    let precedingReset = '';
    for (const [index, rawEntry] of value.slice(-QUEUED_SUBMISSION_LIMIT).entries()) {
      const entry =
        typeof rawEntry === 'string'
          ? { id: legacyQueuedId(session, index, rawEntry), text: rawEntry }
          : rawEntry && typeof rawEntry === 'object' && !Array.isArray(rawEntry)
            ? (rawEntry as Record<string, unknown>)
            : null;
      if (!entry) {
        continue;
      }
      const text = typeof entry.text === 'string' && entry.text.length <= DRAFT_TEXT_LIMIT ? entry.text.trim() : '';
      const id = typeof entry.id === 'string' && QUEUED_SUBMISSION_ID.test(entry.id) ? entry.id : '';
      if (!id || ids.has(id)) {
        continue;
      }
      const rawCommentIds = 'commentIds' in entry && Array.isArray(entry.commentIds) ? entry.commentIds : [];
      const commentIds = [
        ...new Set(
          rawCommentIds.filter(
            (commentId): commentId is string =>
              typeof commentId === 'string' && commentId.length > 0 && commentId.length <= 256,
          ),
        ),
      ];
      const assets: StoredPromptAsset[] = [];
      let assetBytes = 0;
      const rawAssets = 'assets' in entry && Array.isArray(entry.assets) ? entry.assets : [];
      for (const rawAsset of rawAssets) {
        const asset = normalizeStoredPromptAsset(rawAsset);
        if (!asset || assets.some((one) => one.id === asset.id)) {
          continue;
        }
        if (assets.length >= MAX_PROMPT_ASSETS || assetBytes + asset.size > MAX_PROMPT_ASSET_TOTAL_BYTES) {
          break;
        }
        assets.push(asset);
        assetBytes += asset.size;
      }
      const storedDelivery =
        'delivery' in entry && entry.delivery && typeof entry.delivery === 'object' && !Array.isArray(entry.delivery)
          ? (entry.delivery as Record<string, unknown>)
          : null;
      const storedPhase = storedDelivery && typeof storedDelivery.phase === 'string' ? storedDelivery.phase : '';
      if (!text && !commentIds.length && !assets.length && storedPhase !== 'draft-recovery') {
        continue;
      }
      const at =
        'at' in entry && typeof entry.at === 'number' && Number.isFinite(entry.at) && entry.at > 0 ? entry.at : 0;
      const reason = 'reason' in entry && typeof entry.reason === 'string' ? entry.reason.trim().slice(0, 1000) : '';
      const sourceSession =
        storedDelivery && typeof storedDelivery.source === 'string' && storedDelivery.source
          ? storedDelivery.source
          : session;
      const successorSession =
        storedDelivery && typeof storedDelivery.successor === 'string' ? storedDelivery.successor : '';
      const storedResetId =
        storedDelivery &&
        typeof storedDelivery.resetId === 'string' &&
        QUEUED_SUBMISSION_ID.test(storedDelivery.resetId)
          ? storedDelivery.resetId
          : '';
      const legacyReset = /^\/new(?:[ \t]+.*)?$/i.test(text);
      const resetId = storedResetId || (legacyReset ? id : precedingReset);
      const storedReason =
        storedDelivery && typeof storedDelivery.reason === 'string'
          ? storedDelivery.reason.trim().slice(0, 1000)
          : reason;
      let delivery: QueueDelivery;
      if (storedPhase === 'reset-in-flight' || (legacyReset && 'attempted' in entry && entry.attempted === true)) {
        delivery = {
          phase: 'unknown',
          owner: session,
          source: sourceSession,
          resetId: resetId || id,
          reason: storedReason || 'The reset outcome is unknown after reload.',
        };
      } else if (storedPhase === 'unknown' || storedPhase === 'source-recovery') {
        delivery = {
          phase: storedPhase,
          owner: session,
          source: sourceSession,
          resetId: resetId || id,
          reason: storedReason || 'The reset payload needs recovery.',
        };
      } else if (storedPhase === 'draft-recovery' && resetId) {
        delivery = {
          phase: 'draft-recovery',
          owner: session,
          source: sourceSession,
          resetId,
          ...(successorSession === session ? { successor: session } : {}),
        };
      } else if (
        (storedPhase === 'source-owned' || storedPhase === 'source-delivery') &&
        sourceSession === session &&
        resetId
      ) {
        delivery =
          storedPhase === 'source-delivery'
            ? {
                phase: 'source-recovery',
                owner: session,
                source: session,
                resetId,
                reason: storedReason || 'The source prompt outcome is unknown after reload.',
              }
            : { phase: 'source-owned', owner: session, source: session, resetId };
      } else if (
        storedPhase === 'delivery' ||
        storedPhase === 'recovery' ||
        (!legacyReset && 'attempted' in entry && entry.attempted === true)
      ) {
        delivery = {
          phase: 'recovery',
          owner: session,
          reason: storedReason || 'The prompt outcome is unknown after reload.',
        };
      } else if (
        (storedPhase === 'successor-owned' ||
          storedPhase === 'successor-delivery' ||
          storedPhase === 'successor-recovery') &&
        successorSession === session &&
        resetId
      ) {
        const restoredPhase = storedPhase === 'successor-delivery' ? 'successor-recovery' : storedPhase;
        delivery =
          restoredPhase === 'successor-recovery'
            ? {
                phase: restoredPhase,
                owner: session,
                source: sourceSession,
                successor: session,
                resetId,
                reason: storedReason || 'The successor prompt outcome is unknown after reload.',
              }
            : {
                phase: restoredPhase,
                owner: session,
                source: sourceSession,
                successor: session,
                resetId,
                ...(storedDelivery &&
                typeof storedDelivery.barrier === 'string' &&
                QUEUED_SUBMISSION_ID.test(storedDelivery.barrier)
                  ? { barrier: storedDelivery.barrier }
                  : {}),
              };
      } else {
        const barrier =
          storedDelivery &&
          typeof storedDelivery.barrier === 'string' &&
          QUEUED_SUBMISSION_ID.test(storedDelivery.barrier)
            ? storedDelivery.barrier
            : 'heldForClear' in entry && entry.heldForClear === true
              ? precedingReset
              : '';
        delivery = {
          phase: 'queued',
          owner: session,
          ...(legacyReset ? { resetId: id } : {}),
          ...(barrier ? { barrier } : {}),
        };
      }
      entries.push({
        id,
        text,
        commentIds,
        assets,
        at,
        ...(reason ? { reason } : {}),
        delivery,
        ...(typeof entry.recoveryId === 'string' ? { recoveryId: entry.recoveryId } : {}),
      });
      if (delivery.phase === 'queued' && delivery.resetId && !delivery.barrier) {
        precedingReset = delivery.resetId;
      } else if (
        delivery.phase === 'reset-in-flight' ||
        delivery.phase === 'unknown' ||
        delivery.phase === 'source-recovery' ||
        delivery.phase === 'draft-recovery' ||
        delivery.phase === 'source-owned' ||
        delivery.phase === 'source-delivery'
      ) {
        precedingReset = delivery.resetId;
      }
      ids.add(id);
    }
    if (entries.length) {
      out[session] = entries;
    }
  }
  return out;
}

// The in-memory queue book has already passed through the normalizer. Check a proposed
// replacement as a whole before the active composer gives up ownership. Matching every
// session and ordered id proves that neither a per-session ceiling nor the book's
// session ceiling would discard a record.
export function queuedSubmissionBookFits(
  current: Readonly<Record<string, readonly QueuedSubmission[]>>,
  session: string,
  queued: readonly QueuedSubmission[],
): boolean {
  const prospective: Record<string, readonly QueuedSubmission[]> = { ...current };
  if (queued.length) {
    prospective[session] = [...queued];
  } else {
    delete prospective[session];
  }
  const normalized = normalizeQueuedSubmissions(prospective);
  const expected = Object.entries(prospective).filter(([, entries]) => entries.length > 0);
  if (Object.keys(normalized).length !== expected.length) {
    return false;
  }
  return expected.every(([session, entries]) => {
    const kept = normalized[session];
    return kept?.length === entries.length && entries.every((entry, index) => kept[index]?.id === entry.id);
  });
}

// Comment claims held by prompts currently back in the box for editing. The comments
// themselves remain the source of truth, so only bounded ids are retained here.
export function normalizeDraftCommentIds(raw: unknown): Record<string, string[]> {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, string[]> = {};
  for (const [session, value] of Object.entries(source).slice(-SESSION_LIMIT)) {
    if (!session || !Array.isArray(value)) {
      continue;
    }
    const ids = [
      ...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 256)),
    ].slice(-COMMENT_LIMIT);
    if (ids.length) {
      out[session] = ids;
    }
  }
  return out;
}

// The unsent prompts, made safe to use and cut to the ceilings.
//
// Rebuilt entry by entry rather than trusted, for the reason `normalizePanelState` gives:
// this comes back from storage that outlives the code that wrote it. An entry that is not
// text, is empty, or runs past `DRAFT_TEXT_LIMIT` is dropped; an empty draft and no draft
// are the same thing to the box. The record takes the session-shaped ceiling, and the
// newest entries are what is kept, the way the watermarks beside it are.
export function normalizeDrafts(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const held = Object.entries(src).filter(
    ([, text]) => typeof text === 'string' && text !== '' && text.length <= DRAFT_TEXT_LIMIT,
  );
  for (const [id, text] of held.slice(Math.max(0, held.length - SESSION_LIMIT))) {
    out[id] = text as string;
  }
  return out;
}

// The sent-but-not-yet-recorded prompts, made safe to use.
//
// An entry that is not text, is blank or whitespace, or runs past `PROMPT_HISTORY_ENTRY_CHARS`
// is dropped: `promptHistory` and `promptsAcross` refuse any entry that long, so a longer one
// stored here could never reach the reader through Up-arrow history anyway. The record takes
// the session-shaped ceiling, newest entries kept. `sentAfter` already bounds how many
// prompts one session holds in memory, so this adds no separate count cap of its own. A
// session left with no usable entry takes no place here, the way an empty draft takes none.
export function normalizeSentPrompts(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const held = Object.entries(src).filter(([, value]) => Array.isArray(value));
  for (const [id, value] of held.slice(Math.max(0, held.length - SESSION_LIMIT))) {
    const prompts = (value as unknown[]).filter(
      (text): text is string =>
        typeof text === 'string' && text.trim() !== '' && text.length <= PROMPT_HISTORY_ENTRY_CHARS,
    );
    if (prompts.length) {
      out[id] = prompts;
    }
  }
  return out;
}

// The prompts a reload puts back into memory: a plain copy of the saved book.
//
// Copied rather than aliased, the way `this.drafts` is restored from `this.saved.drafts`: a
// send fills this copy at send time, and the saved copy must move only when a save runs.
export function restoredSentPrompts(saved: Pick<PanelState, 'sentPrompts'>): Record<string, string[]> {
  return { ...saved.sentPrompts };
}

// The facts one refresh reads to decide what moved since the last one. Two questions are
// asked of it, and they are not the same question, so it is written down once and answered
// twice below.
export interface ListingFacts {
  showing: string | null;
  files: { file: string; size: number; mtimeMs: number }[];
  threadNames: string;
  children: string;
  // Each session another session started, that session and the relation, as
  // `sessionParentsKey` spells them.
  sessionParents: string;
}

// What one refresh compares against the last to decide whether anything moved.
//
// Every listed file's size and mtime, so any transcript that changed shows up, over all of
// them rather than the few parsed: the picker draws every session with its name and its
// clock time, so one that is listed and not parsed can still change what is on screen.
//
// Codex's thread-name index is the one term that is not a transcript. Codex names a thread
// after the rollout has stopped being written, into a file of its own, so a session being
// named moves nothing else in here. Without that term the panel keeps the old name until some
// unrelated session happens to move, which on an idle machine is never.
//
// The session shown alone is in it because showing one changes what is drawn without
// any file changing. The session parents are in it for the same reason: the worker can
// resolve a reference on a walk after the one that saw the parent transcript grow, and
// the heading of the dispatched session or subagent then changes with every file still.
export function listingSignature(now: ListingFacts): string {
  return `${now.showing}|${now.threadNames}|${now.sessionParents}|${spendSourceSignature(now)}`;
}

// The same facts, cut down to what a Project cost source can be discovered or re-read from:
// each listed transcript's revision, and the child listing, because a child transcript is a
// spend source of its own.
//
// It reads the same object as the signature above and drops two of its terms. Selecting a
// session cannot add, remove or grow a spend source. Codex names a thread into an index
// of its own and touches no transcript, so a rename cannot either. Both are real reasons to
// repaint and neither is a reason to offer.
//
// The offer walks every record in the ledger and stats the ones the listing does not carry,
// so a term in here that moves for a reason the spend index does not care about pays that
// whole walk for nothing. Adding one back is the cost of a click.
export function spendSourceSignature(now: ListingFacts): string {
  return `${now.children}|` + now.files.map((f) => `${f.file}:${f.size}:${f.mtimeMs}`).join('|');
}

// Whether a refresh has anything to do.
//
// Four terms, and each is a different reason to go on. `force` is the refresh button and a
// freshly shown panel, which repaint whatever moved. The signature is every listed file's
// size and mtime, so it answers whether any transcript changed. A glance that reached a
// session it had not reached before is a reason on its own: the budget spends over
// several polls, so a workspace where nothing is running produces the same signature for ever
// and the rail would fill by one budget and stop.
//
// `statusMoved` is the clock. A turn whose agent died is never written to again, so its
// signature never moves and the three terms above never fire, and the card it was drawn as
// would keep the word running for as long as the panel stayed open. The caller answers this
// by asking `statusOf` what each newest turn was at the last repaint and what it is now, so
// the rule for when a turn stops running stays in one place.
//
// Here rather than in the panel because it is a decision, and the call site in `panelhost.ts`
// is checked as source text rather than exercised. A guard there can see the terms in the
// right order; only running it catches a boundary written the wrong way round.
export function refreshWanted(now: {
  force: boolean;
  signature: string;
  lastSignature: string;
  glancedBefore: number;
  glancedNow: number;
  statusMoved: boolean;
  // The live open children the cards were built against and the ones live now, each as
  // `openChildrenKey` spells them. A child that goes quiet changes them with no file change.
  openChildren: { drawn: string; now: string };
}): boolean {
  if (now.force) {
    return true;
  }
  if (now.signature !== now.lastSignature) {
    return true;
  }
  if (now.statusMoved) {
    return true;
  }
  if (now.openChildren.drawn !== now.openChildren.now) {
    return true;
  }
  return now.glancedNow !== now.glancedBefore;
}

// How many bytes of transcript one refresh may glance at, over every session it has
// not glanced at before.
//
// A glance is 1 MB at most and costs 0.44 ms, so a cold start over this workspace's 49
// sessions reads 25.2 MB and the largest project's 130 read 20.2 MB. Taken in one go
// that is 22 ms and 58 ms of the extension host's event loop, which is survivable here and
// is not bounded: a workspace with five hundred sessions would freeze the host for a
// quarter of a second on the poll that happened to be first.
//
// So a refresh spends a budget and stops, and the rail fills over the next few polls. Eight
// megabytes covers this workspace in four refreshes and the largest project in three, at
// roughly 8 ms of scanning each. A session whose window has not been read yet says
// nothing, which is the answer every unparsed session gives today, so the filling reads
// as the rail catching up rather than as a wrong count settling down.
export const GLANCE_BUDGET_BYTES = 8 * 1024 * 1024;

// Which sessions a refresh glances at, newest first until the budget runs out.
//
// Newest first, because that is the order the rail draws and the order the reader looks in:
// a budget spent oldest first would fill the fold of the rail before its top. A session
// already glanced at is not re-read and does not spend budget, so a settled workspace spends
// nothing and only a session whose file moved comes back round.
//
// The size counted against the budget is the initial read cost. Most glances stop there.
// A miss can grow to the turn-start ceiling, but its revision cache pays that cost once.
// Charging every candidate at the ceiling would leave most of the refresh budget unused.
export function glanceBudget<T extends { size: number }>(
  candidates: readonly T[],
  windowBytes: number,
  budget: number = GLANCE_BUDGET_BYTES,
): T[] {
  const out: T[] = [];
  let spent = 0;
  for (const c of candidates) {
    const cost = Math.min(c.size, windowBytes);
    // The first candidate is always taken, however large. A budget smaller than one window
    // would otherwise glance at nothing for ever, and the rail would never fill at all.
    if (out.length && spent + cost > budget) {
      break;
    }
    out.push(c);
    spent += cost;
  }
  return out;
}

// Why the selected session has no cards. Decided here rather than in the panel because
// the panel is the file with no tests and must not infer workspace state from an empty list.
//
// Three states are all the current readers can support. Neither reader records whether its
// root exists, holds records for other workspaces, or held records it could not read, so
// no message may claim one of those; adding a state here means adding reader metadata for
// both sources first.
export interface EmptyTimeline {
  message: string;
}

export interface NewestTurnLoading {
  diagnosis: EmptyTimeline | null;
  history: { kind: 'busy'; label: string } | null;
}

function newestTurnLoadingMessage(label: string): string {
  return `Loading the newest turn from ${label}.`;
}

// A loading explanation occupies the empty state when there are no cards, and the history
// status below existing cards when a compaction or another partial card is already visible.
// Keeping the two destinations exclusive prevents the same sentence from being announced
// twice on an empty timeline.
export function newestTurnLoading(label: string | null, hasCards: boolean): NewestTurnLoading {
  if (!label) {
    return { diagnosis: null, history: null };
  }
  const message = newestTurnLoadingMessage(label);
  return hasCards
    ? { diagnosis: null, history: { kind: 'busy', label: message } }
    : { diagnosis: { message }, history: null };
}

export function emptyTimeline(state: {
  folders: number; // how many workspace folders are open
  session: boolean; // whether the panel has a selected session
  draft?: boolean; // whether the selected session has not been sent yet
  loading?: string | null;
}): EmptyTimeline {
  if (!state.folders) {
    return { message: 'No folder is open, so there is no session to show.' };
  }
  if (!state.session) {
    return { message: 'No sessions in this project yet.' };
  }
  if (state.loading) {
    return { message: newestTurnLoadingMessage(state.loading) };
  }
  if (state.draft) {
    return { message: 'Start this session with a prompt.' };
  }
  return { message: 'This session has not produced a response yet.' };
}
