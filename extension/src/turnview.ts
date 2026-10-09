import { DRAFT_SESSION_PREFIX, normalizeSessionLabels, sweepDraftLabels } from './turnlabels';
import { PROMPT_TEXT_CHARS } from './domain/prompt-text.ts';
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

// Compatibility re-exports for host projections owned by the `turn*` modules.
export * from './turncard';
export * from './turncomments';
export * from './turnformat';
export * from './turnlabels';
export * from './turnrail';
export * from './turnread';
export * from './turnsearch';

// Choose the displayed session from the workspace catalog. Return null only when the catalog is empty.
// Missing session ids and initial selections fall back to the newest session.
// The catalog arrives in newest-activity order, so its first entry supplies that fallback.
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

// Supply turns newest first. The selected session takes priority within the global turn budget.
// Every other parsed session retains its newest supplied turn, even when that extends the budget.
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

// Chooses an editor group for file and diff actions.
// Prefer a text editor group outside the panel's group.
// With no other text editor, reuse the panel group or the first editor group.
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
  // Otherwise use the leftmost visible text editor group outside the panel group.
  const open = state.visible.filter(notPanel).sort((a, b) => a - b);
  if (open.length) {
    return open[0];
  }
  // Reuse the panel group when no other text editor group is available.
  return state.panel ?? 1;
}

// Reuses the last beside-open group while it remains open and differs from the panel group.
// Editor columns identify positions, so closing a group can invalidate the retained destination.
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

// Maximum entries in per-session saved-state lists and watermarks.
// Removed sessions can leave stored ids, so normalization bounds retained state.
export const SESSION_LIMIT = 500;

// Queued-submission ownership and recovery phases.
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
  // Compatibility field normalized with saved state and cleared before storage.
  // Session heading disclosure uses turn keys instead.
  collapsed: string[];
  hidden: string[];
  // The sessions pinned to the top of the rail. They stay there and stay parsed
  // however old they get, which is what pinning promises.
  pinnedTop: string[];
  // Reader-applied labels by session id, in applied order.
  // `turnlabels.ts` normalizes names, spelling, and retained limits.
  labels: Record<string, string[]>;
  // Saved views in section order. Views organize the session list without changing the parse cut.
  // The host retains this reader-owned list separately from webview state saves.
  views: SavedView[];
  read: string[];
  // Session read watermarks keyed by id, using the newest marked turn's start time.
  // They complement per-turn read keys and cover older turns outside the current parse.
  readTo: Record<string, number>;
  // Initial workspace read boundary. Turns before it count as read unless a session has its own watermark.
  // Zero disables the boundary. The host retains the initial value across reloads.
  since: number;
  // Selected session id, or empty when no session is selected.
  showing: string;
  // Compatibility query field normalized with saved state and cleared before storage.
  // `railFilter` supplies the active session list query.
  filter: string;
  railFilter: string;
  railFilterId: string;
  railFilters: SavedRailFilter[];
  railSort: RailSort;
  railDefaultSort: RailSort;
  // View menu Group by and Rows presentation values. Saved filters do not replace them.
  railGroupBy: RailGroupBy;
  railDensity: RailDensity;
  // Whether the session list includes archived sessions and agent runs. Both default to enabled.
  railShowArchived: boolean;
  railShowRuns: boolean;
  // Quick filters enabled on the session list header. Saved filters do not replace this setting.
  railQuickFilters: RailLens[];
  railWidth: number;
  composerHidden: boolean;
  promptFloor: number;
  // Session list group folds by id. True means open, false means closed, and an absent id uses the default.
  railFolds: Record<string, boolean>;
  // Reader-authored turn comments in creation order.
  comments: TurnComment[];
  // Unsent prompt text by session id. Empty drafts have no entry.
  drafts: Record<string, string>;
  // Submitted prompts not yet present in the transcript, by session id, newest first.
  // `sentPromptsToSave` omits recorded prompts from storage while retaining in-memory prompt history.
  sentPrompts: Record<string, string[]>;
  // Comment ids reserved for a queued prompt returned to the prompt box for editing.
  // The comments remain on their turns and unavailable to earlier queued prompts.
  draftCommentIds: Record<string, string[]>;
  // Sessions the reader started from this panel, oldest first.
  // Retain launch ownership across reloads because transcript classification alone cannot establish it.
  started: string[];
  agentRuns?: string[];
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

// Normalizes saved fields and retained limits, replacing invalid values with field defaults.
// `heldRailFilters` supplies the host-owned saved filters when a webview save omits them.
// The selected filter id and query are reconciled against that list.
export function normalizePanelState(raw: unknown, heldRailFilters?: readonly SavedRailFilter[]): PanelState {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  // Limit each restored list to its newest entries. Lists store oldest entries first, so remove excess entries from the front, as `markRead` does.
  const ids = (value: unknown, limit: number): string[] => {
    const kept = Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
    return kept.slice(Math.max(0, kept.length - limit));
  };
  // Rebuild watermarks from finite numeric values. Strings and NaN cannot provide valid comparisons against turn start times.
  // Keep the newest entries, matching the lists' retention order.
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
  // Migrates compatibility lens fields to query terms before validating the saved-filter id.
  const storedRail = migrateStoredRailLens({
    filterId: src.railFilterId,
    query: boundedRailFilterQuery(src.railFilter),
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
    // Accept only a positive finite read boundary. Invalid values disable it.
    since: typeof src.since === 'number' && Number.isFinite(src.since) && src.since > 0 ? src.since : 0,
    showing: typeof src.showing === 'string' ? src.showing : '',
    filter: typeof src.filter === 'string' ? src.filter : '',
    railFilter: missingRailFilter ? '' : storedRail.query,

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
    // Normalize comment records and their count and text limits.
    comments: normalizeComments(src.comments),
    ...(src.submittedPrompts === undefined ? {} : { submittedPrompts: mergeSubmittedPrompts(src.submittedPrompts) }),
    drafts: normalizeDrafts(src.drafts),
    sentPrompts: normalizeSentPrompts(src.sentPrompts),
    draftCommentIds: normalizeDraftCommentIds(src.draftCommentIds),
    // One entry per session, so this takes the session-shaped ceiling beside them.
    started: ids(src.started, SESSION_LIMIT),
    ...(ids(src.agentRuns, SESSION_LIMIT).length ? { agentRuns: ids(src.agentRuns, SESSION_LIMIT) } : {}),
    assets: normalizePromptAssetBook(src.assets),
    queues: normalizeQueuedSubmissions(src.queues),
  };
}

// Removes abandoned draft label and reader-parent identities at startup.
// Run before normalization so draft labels cannot evict real sessions at the retained limit.
// Ordinary writes preserve active provisional identities until adoption or abandonment.
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

// Projects webview state while excluding host-owned labels, reader parents, and saved filters.
// Session cards carry the displayed label fields. Other panel-owned fields pass through.
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

// Rebuild stored fold state using recognized heading keys and boolean values.
// Discard bucket-id keys because headings use fold names. These discarded entries must not occupy the retained-state limit.
// A heading without retained state uses its default until the reader changes it.
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

// Maximum stored draft length in characters.
// Drop oversized drafts rather than silently restoring a truncated prompt.
export const DRAFT_TEXT_LIMIT = PROMPT_TEXT_CHARS;
export const DRAFT_BOOK_CHARS = SESSION_LIMIT * 20_000;
export const QUEUED_TEXT_CHARS = 64 * 20_000;
// Maximum prompt length offered by Up-arrow history.
// `promptHistory` and `promptsAcross` exclude longer transcript and panel-submitted prompts.
// `normalizeSentPrompts` applies the same limit to stored submissions.
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
    let textChars = 0;
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
      // Keep every admitted prompt whole. Admission refuses a book that would lose an entry.
      if (typeof entry.text === 'string' && entry.text.length > DRAFT_TEXT_LIMIT) continue;
      const text = typeof entry.text === 'string' ? entry.text.trim() : '';
      if (textChars + text.length > QUEUED_TEXT_CHARS) continue;
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
      textChars += text.length;
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
    return (
      kept?.length === entries.length &&
      entries.every((entry, index) => kept[index]?.id === entry.id && kept[index]?.text === entry.text.trim())
    );
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

// Normalizes unsent prompts and retains the newest bounded session entries.
// Drop nontext, empty, or oversized drafts.
export function normalizeDrafts(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const held = Object.entries(src).filter(
    ([, text]) => typeof text === 'string' && text !== '' && text.length <= DRAFT_TEXT_LIMIT,
  );
  let textChars = 0;
  const kept: [string, string][] = [];
  for (const [id, text] of held.slice(Math.max(0, held.length - SESSION_LIMIT)).reverse()) {
    if (textChars + (text as string).length > DRAFT_BOOK_CHARS) continue;
    textChars += (text as string).length;
    kept.push([id, text as string]);
  }
  for (const [id, text] of kept.reverse()) out[id] = text;
  return out;
}

// Normalizes stored sent prompts before transcript reconciliation.
// Drop nontext, blank, and oversized entries.
// Retain the newest bounded session entries. Per-session prompt counts are not capped here.
// Sessions without a usable prompt have no entry.
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

// Returns a shallow copy of the saved sent-prompt map for in-memory updates.
export function restoredSentPrompts(saved: Pick<PanelState, 'sentPrompts'>): Record<string, string[]> {
  return { ...saved.sentPrompts };
}

// Refresh facts shared by listing and spend-source signatures.
export interface ListingFacts {
  showing: string | null;
  files: { file: string; size: number; mtimeMs: number }[];
  threadNames: string;
  children: string;
  // Each session another session started, that session and the relation, as
  // `sessionParentsKey` spells them.
  sessionParents: string;
}

// Signs listed source revisions, child discovery, session names, parent relationships, and selection.
// Name and parent updates can change the drawn panel without changing a transcript.
export function listingSignature(now: ListingFacts): string {
  return `${now.showing}|${now.threadNames}|${now.sessionParents}|${spendSourceSignature(now)}`;
}

// Signs source revisions and child discovery for Project cost offers.
// Selection and the Codex name index change no spend source and are excluded.
export function spendSourceSignature(now: ListingFacts): string {
  return `${now.children}|` + now.files.map((f) => `${f.file}:${f.size}:${f.mtimeMs}`).join('|');
}

// Requests refresh for forced work, a changed signature, status or dispatched figures,
// changed live children, or changed metadata coverage.
// Clock-driven state changes require refresh even when source files stay unchanged.
export function refreshWanted(now: {
  force: boolean;
  signature: string;
  lastSignature: string;
  glancedBefore: number;
  glancedNow: number;
  statusMoved: boolean;
  dispatchFiguresMoved?: boolean;
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
  if (now.statusMoved || now.dispatchFiguresMoved) {
    return true;
  }
  if (now.openChildren.drawn !== now.openChildren.now) {
    return true;
  }
  return now.glancedNow !== now.glancedBefore;
}

// Initial transcript-read byte budget across metadata candidates in one refresh.
// Later refreshes continue filling session list metadata.
export const GLANCE_BUDGET_BYTES = 8 * 1024 * 1024;

// Takes candidates in caller order until their initial read costs reach the budget.
// Each cost is the lesser of file size and initial window size.
// Recovery reads beyond that initial window are not charged here.
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

// Explanation for an empty selected timeline.
// Messages require workspace-folder, selection, draft, and loading facts.
// Missing source-root and read-failure metadata cannot support more specific claims.
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

// Show loading text in the empty state when there are no cards.
// With visible cards, including partial compaction cards, show it in history status instead.
// These destinations remain exclusive so an empty timeline announces the text once.
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
