// Browser-safe session list projections.

export function createSessionLabelIndex() {
  let source: readonly { id: string; labels?: string[] }[] | undefined;
  let labels = new Map<string, string[]>();
  const empty: string[] = [];
  return {
    labels(rows: typeof source, id: string): string[] {
      if (rows !== source) {
        source = rows;
        labels = new Map();
        for (const row of rows ?? []) {
          if (!labels.has(row.id)) labels.set(row.id, row.labels ?? empty);
        }
      }
      return labels.get(id) ?? empty;
    },
  };
}

import { matchSessions, parseSessionQuery, railStatusRuns } from '../domain/session-query.ts';
import {
  RAIL_KEEPING_LENSES,
  RAIL_LENSES,
  RAIL_LENS_WORDS,
  pressRailLens,
  railQueryHeldLens,
  withoutRailLenses,
  type RailLens,
} from '../domain/rail-filters.ts';
import type { SavedView } from '../domain/views.ts';
import { labelKey, sessionsCarrying } from '../domain/labels.ts';
import type { RailSort } from '../domain/rail-sort.ts';
import {
  CACHE_SPAN_MINIMUM_SECONDS,
  formatCacheSpan,
  formatDuration,
  formatRelative,
  formatRelativeShort,
} from './time.ts';

// The subagents status means the main agent is idle while background subagents run.
// The background status means a started command still runs. The agent continues when the command ends.
export type RailStatus =
  | 'background'
  | 'done'
  | 'failed'
  | 'interrupted'
  | 'running'
  | 'stopped'
  | 'subagents'
  | 'waiting';

export const NEEDS_INPUT = 'needs input';

// The pin glyph, a stroked 16 by 16 path. The rail card's pin and the session heading's pin
// both draw it, so the two read as one control.
export const PIN_GLYPH = 'M9 2l5 5-3 1-2.5 4L6 9.5 2 14M9 6L6.5 8.5';
// A pencil in the pin's stroke, for Edit beside a pin.
export const PENCIL_GLYPH = 'M11 2.5l2.5 2.5L5.5 13H3v-2.5zM9.5 4l2.5 2.5';

// The word a session in the `subagents` state draws where `running` sits. A count the card
// did not receive draws the bare word, never a zero.
export function subagentsWord(count: number): string {
  if (!(count > 0)) {
    return 'subagents';
  }
  return `${count} subagent${count === 1 ? '' : 's'}`;
}

// Whether a newest turn in this status lets its session's live carried subagents and its own
// live background subagents count. The rail words such a session `subagents`, and the newest
// turn card counts the same children, so both read this one rule. A running or stopped turn
// counts none.
export function childrenOutliveTurn(status: string): boolean {
  return status === 'done' || status === 'failed' || status === 'interrupted';
}

// What a session in the `subagents` state says about its children. It is a comfortable card's
// hint title, the state on a compact card's hover card, and the end of its accessible name.
export function subagentsStillRunning(count: number): string {
  return `${subagentsWord(count)} still running`;
}

// The hint detail under that title: why the state is not `running`, and what the reader can do.
export function subagentsHintDetail(count: number): string {
  return (
    `The main agent is idle and will continue when ${count === 1 ? 'it finishes' : 'they finish'}. ` +
    'You can send a prompt now.'
  );
}

// The word a session in the `background` state draws where `running` sits. A count the card
// did not receive draws the bare phrase, never a zero.
export function backgroundCommandsWord(count: number): string {
  if (!(count > 0)) {
    return 'background commands';
  }
  return `${count} background command${count === 1 ? '' : 's'}`;
}

// What a session in the `background` state says about its commands. It is a comfortable card's
// hint title, the state on a compact card's hover card, and the end of its accessible name.
export function backgroundCommandsStillRunning(count: number): string {
  return `${backgroundCommandsWord(count)} still running`;
}

// The hint detail under that title: why the state is not `running`, and what the reader can do.
export function backgroundCommandsHintDetail(count: number): string {
  return (
    `The agent is idle and will continue when ${count === 1 ? 'it finishes' : 'they finish'}. ` +
    'You can send a prompt now.'
  );
}

// Fields used to assemble a session list card accessible name.
export interface RailCardNameParts {
  // The displayed name, when different from label. railCardName falls back to label when name is absent.
  name?: string;
  label: string;
  nameBeforeAge: string;
  nameAfterAge: string;
  relative: string;
  status: string | null;
  subagents?: number | null;
  commands?: number | null;
  // The unsent-input clause, separate from nameBeforeAge. railCardName appends it once, and the card hint reads the same field.
  unsentName?: string | null;
}

// Compose the accessible name from the card name, metadata and unsent-input clause.
// The caller supplies cache and running-duration clauses using its clock.
// Subagents and background statuses omit the age and end with their state explanation.
export function railCardName(
  card: RailCardNameParts,
  clauses: { running?: string | null; cache?: string | null } = {},
): string {
  const before = [card.name ?? card.label, card.nameBeforeAge, card.unsentName].filter(Boolean).join(', ');
  const parts =
    card.status === 'subagents'
      ? [before, clauses.cache, card.nameAfterAge, subagentsStillRunning(card.subagents ?? 0)]
      : card.status === 'background'
        ? [before, clauses.cache, card.nameAfterAge, backgroundCommandsStillRunning(card.commands ?? 0)]
        : [before, clauses.running, card.relative, clauses.cache, card.nameAfterAge];
  return parts.filter(Boolean).join(', ');
}

export function runningFor(since: number, now: number): string {
  const word = railRunningWord(since, now);
  return word ? ` ${word}` : '';
}

export function railRunningWord(since: number, now: number): string | null {
  const elapsed = now - since;
  return elapsed < 60_000 ? null : formatDuration(elapsed);
}

// How long a prompt cache has left, as the rail draws it.
export interface RailCacheSpan {
  expiresAt: number;
  nearlyGoneAt: number | null;
}

export type RailCacheState = 'warm' | 'nearly-gone';

export function railCacheState(cache: RailCacheSpan | null, now: number): RailCacheState | null {
  if (!cache || now >= cache.expiresAt) {
    return null;
  }
  return cache.nearlyGoneAt !== null && now >= cache.nearlyGoneAt ? 'nearly-gone' : 'warm';
}

export function railCacheTitle(cache: RailCacheSpan, now: number): string {
  if (cache.expiresAt - now <= CACHE_SPAN_MINIMUM_SECONDS * 1000) {
    return 'Cache expiring about now';
  }
  return `Cache warm for another ${formatCacheSpan(cache.expiresAt - now)}`;
}

// The Active lens includes activity from the last hour, independently of cache lifetime.
export const ACTIVE_WINDOW_MS = 60 * 60 * 1000;

// The parts of a card the Active lens reads: when the session last recorded activity, and how
// long its prompt cache has left.
export interface RailActiveCard {
  at: number;
  cache?: RailCacheSpan | null;
}

// Whether a session sits inside the Active lens's recency window: its prompt cache is still
// live, or it recorded activity inside the last hour. Read against the caller's own clock, so
// the answer moves as the clock does and never as a stored fact.
export function railCardActive(card: RailActiveCard, now: number): boolean {
  return railCacheState(card.cache ?? null, now) !== null || now - card.at < ACTIVE_WINDOW_MS;
}

// The parts of a card the Active lens reads beyond recency: the reader's own filing.
export interface RailLensCard extends RailActiveCard {
  archived?: boolean;
  runByAgent?: boolean;
}

// The Active lens excludes archived sessions and agent runs, matching its -is:archived and -is:agentrun terms.
export function railLensHolds(card: RailLensCard, now: number): boolean {
  return !card.archived && !card.runByAgent && railCardActive(card, now);
}

// The parts of a rail card whose wording moves with the clock alone.
export interface RailTickCard {
  at: number;
  status: RailStatus | null;
  runningSince: number | null;
  cache: RailCacheSpan | null;
}

// One drawn rail row: the element id it took, and the card it drew.
export interface RailTickRow {
  id: string;
  card: RailTickCard;
}

// One row a draw is about to put on screen, with the section it sits under.
export interface RailDrawnRow<Card> {
  bucket: string;
  repeat: boolean;
  id: string;
  card: Card;
}

// The most rows one section draws before it offers the rest under a press, and the number
// each press adds.
export const RAIL_ROW_STEP = 200;

// Return the row count after Show more presses. Pinned always draws every row.
// Other sections extend through the current session, rounding its position up to a full step.
// Limit the result to the available card count.
export function railRowsDrawn(
  section: string,
  steps: number,
  count: number,
  current = -1,
  step = RAIL_ROW_STEP,
): number {
  if (section === RAIL_FOLDS.top) {
    return count;
  }
  const reach = current < 0 ? 0 : Math.ceil((current + 1) / step);
  return Math.min(count, Math.max(steps + 1, reach) * step);
}

// Return drawn rows in section order and the remaining card count for each open section.
// Folded sections contribute no rows or remaining counts. Show more holds the rows beyond the drawn limit.
// The renderer and clock share this list, excluding hidden rows from tick work.
export function railDrawnRows<Card extends RailTickCard & { id: string }>(
  sections: readonly { id: string; cards: readonly Card[] }[],
  folded: Readonly<Record<string, boolean>>,
  repeated: ReadonlyMap<string, ReadonlySet<string>>,
  rowId: (bucket: string, card: string, repeat: boolean) => string,
  drawn: (section: string, count: number) => number = (_section, count) => count,
): { rows: RailDrawnRow<Card>[]; left: Map<string, number> } {
  const rows: RailDrawnRow<Card>[] = [];
  const left = new Map<string, number>();
  for (const section of sections) {
    if (folded[section.id]) {
      continue;
    }
    const repeats = repeated.get(section.id);
    const shown = Math.max(0, Math.min(section.cards.length, drawn(section.id, section.cards.length)));
    for (const card of section.cards.slice(0, shown)) {
      const repeat = repeats?.has(card.id) ?? false;
      rows.push({ bucket: section.id, repeat, id: rowId(section.id, card.id, repeat), card });
    }
    if (shown < section.cards.length) {
      left.set(section.id, section.cards.length - shown);
    }
  }
  return { rows, left };
}

// Build a session row element id. Repeated rows include their section to keep ids distinct.
// The first occurrence uses the plain session id, according to railSections order.
export function railRowId(section: string, id: string, repeat: boolean): string {
  return repeat ? `railrow-${safeIdPart(section)}__${safeIdPart(id)}` : `railrow-${safeIdPart(id)}`;
}

// Key each row by session and section. Moving sections creates a new element without the old editor or hover state.
// focusAfterList restores session focus, looking in the old section first.
export function railRowKey(section: string, id: string): string {
  return `${id}:${section}`;
}

// Encode an element id part without collisions. Escape underscores before replacing percent signs, reserving double underscores for the section/session separator.
function safeIdPart(value: string): string {
  return encodeURIComponent(value).replace(/_/g, '%5F').replace(/%/g, '_');
}

// Which occurrence of a session is a second one, by section.
//
// The first section holding a session keeps the plain row id in `railSections` order.
// Every later section names itself. One pass establishes these identities for the complete draw.
export function railRepeatRows(
  sections: readonly { id: string; cards: readonly { id: string }[] }[],
): Map<string, ReadonlySet<string>> {
  const drawn = new Set<string>();
  const out = new Map<string, ReadonlySet<string>>();
  for (const section of sections) {
    const here = new Set<string>();
    for (const card of section.cards) {
      if (drawn.has(card.id)) {
        here.add(card.id);
      } else {
        drawn.add(card.id);
      }
    }
    out.set(section.id, here);
  }
  return out;
}

export interface RailTickWork {
  redraw: boolean;
  titles: readonly { id: string; text: string }[];
}

function tickRunningWord(card: RailTickCard, now: number): string | null {
  return card.status === 'running' && card.runningSince !== null ? railRunningWord(card.runningSince, now) : null;
}

// Compare drawn rows with their wording at the new clock time. Folded rows are absent from the input.
// Return changed cache tooltip text separately so the existing row can receive it without a redraw.
export function railTickWork(
  rows: readonly RailTickRow[],
  drawnAt: number,
  at: number,
  titlesAt: number = drawnAt,
  age: (at: number, now: number) => string = formatRelative,
): RailTickWork {
  let redraw = false;
  const titles: { id: string; text: string }[] = [];
  for (const { id, card } of rows) {
    const state = railCacheState(card.cache, at);
    if (
      age(card.at, at) !== age(card.at, drawnAt) ||
      tickRunningWord(card, at) !== tickRunningWord(card, drawnAt) ||
      state !== railCacheState(card.cache, drawnAt)
    ) {
      redraw = true;
      continue;
    }
    if (card.cache && state && railCacheTitle(card.cache, at) !== railCacheTitle(card.cache, titlesAt)) {
      titles.push({ id, text: railCacheTitle(card.cache, at) });
    }
  }
  return { redraw, titles };
}
// The browser and stylesheet read this breakpoint from the same source so hidden rail
// controls cannot remain in the keyboard walk.
export const RAIL_MIN_WIDTH = 700;
export const RAIL_WIDTH_MIN = 160;
export const RAIL_WIDTH_DEFAULT = 220;

export function clampRailWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return RAIL_WIDTH_DEFAULT;
  }
  return Math.max(RAIL_WIDTH_MIN, Math.round(value));
}

export function railWidthMaximum(viewport: number, sash: number): number {
  return Math.max(
    RAIL_WIDTH_MIN,
    Math.floor((Number.isFinite(viewport) ? viewport : 0) - (Number.isFinite(sash) ? sash : 0)),
  );
}

export function effectiveRailWidth(preferred: number, maximum: number): number {
  return Math.min(clampRailWidth(preferred), maximum);
}

export function railWidthKey(key: string, width: number, maximum: number): number | null {
  const next =
    key === 'ArrowLeft'
      ? width - 10
      : key === 'ArrowRight'
        ? width + 10
        : key === 'Home'
          ? RAIL_WIDTH_MIN
          : key === 'End'
            ? maximum
            : null;
  return next === null ? null : effectiveRailWidth(next, maximum);
}

export function railGroupListId(section: string): string {
  return `raillist-${safeIdPart(section)}`;
}

export function railGroupHeadingId(section: string): string {
  return `railheading-${safeIdPart(section)}`;
}

export function archivedNote(n: number): { text: string; action: string } {
  return {
    text: `${n} session${n === 1 ? '' : 's'} archived`,
    action: n === 1 ? 'Unarchive' : 'Unarchive all',
  };
}

export function sessionCount(turns: number): string {
  return `${turns} turn${turns === 1 ? '' : 's'}`;
}

// Session list figures appear in cost, whole-session turns and current-context order. Omit unavailable figures.
// The host and browser project these figures from the session heading data, including their accessible wording.
export const RAIL_STAT_METRICS = ['cost', 'turns', 'context'] as const;

export function railStatChips<Chip extends { metric: string }>(chips: readonly Chip[]): Chip[] {
  return RAIL_STAT_METRICS.flatMap((metric) => {
    const chip = chips.find((candidate) => candidate.metric === metric);
    return chip ? [chip] : [];
  });
}

// Live and failed states use the status slot. Unsent input uses the time slot.
// Subagents and background statuses show their counts in place of running, without an age.
export function railTimeSlot(
  status: RailStatus | null,
  unsent: boolean = false,
  subagents: number | null = null,
  commands: number | null = null,
): { word: string | null; time: boolean } {
  if (status === 'waiting') {
    return { word: NEEDS_INPUT, time: false };
  }
  if (status === 'running') {
    return { word: 'running', time: false };
  }
  if (status === 'subagents') {
    return { word: subagentsWord(subagents ?? 0), time: false };
  }
  if (status === 'background') {
    return { word: backgroundCommandsWord(commands ?? 0), time: false };
  }
  if (status === 'failed') {
    return { word: 'failed', time: !unsent };
  }
  return { word: null, time: !unsent };
}

export const RAIL_BUCKETS = ['top', 'today', 'yesterday', 'week', 'older', 'agent', 'archived'] as const;
export type RailBucket = (typeof RAIL_BUCKETS)[number];

// Saved fold keys for time buckets. Keep these keys independent of bucket ids because saved panel state retains them.
export const RAIL_FOLDS: Record<RailBucket, string> = {
  top: 'railpinned',
  today: 'railtoday',
  yesterday: 'railyesterday',
  week: 'railweek',
  older: 'railolder',
  agent: 'railruns',
  archived: 'railarchived',
};

export interface RailBucketCard {
  at: number;
  pinnedTop: boolean;
  current: boolean;
  archived: boolean;
  agentRun?: boolean;
}

export function railBuckets<T extends RailBucketCard>(
  cards: T[],
  now: number,
): { buckets: { id: RailBucket; label: string; cards: T[] }[]; olderFolded: boolean; agentFolded: boolean } {
  // Walk calendar dates so daylight-saving changes do not move a card across a day boundary.
  const dayStart = (back: number): number => {
    const day = new Date(now);
    return new Date(day.getFullYear(), day.getMonth(), day.getDate() - back).getTime();
  };
  const startToday = dayStart(0);
  const startYesterday = dayStart(1);
  const startWeek = dayStart(7);
  const top: T[] = [];
  const today: T[] = [];
  const yesterday: T[] = [];
  const week: T[] = [];
  const older: T[] = [];
  const agent: T[] = [];
  const archived: T[] = [];
  for (const card of cards) {
    if (card.archived) {
      archived.push(card);
    } else if (card.pinnedTop) {
      top.push(card);
    } else if (card.agentRun) {
      agent.push(card);
    } else if (card.at >= startToday) {
      today.push(card);
    } else if (card.at >= startYesterday) {
      yesterday.push(card);
    } else if (card.at >= startWeek) {
      week.push(card);
    } else {
      older.push(card);
    }
  }
  const buckets: { id: RailBucket; label: string; cards: T[] }[] = [];
  if (top.length) {
    buckets.push({ id: 'top', label: 'Pinned', cards: top });
  }
  if (today.length) {
    buckets.push({ id: 'today', label: 'Today', cards: today });
  }
  if (yesterday.length) {
    buckets.push({ id: 'yesterday', label: 'Yesterday', cards: yesterday });
  }
  if (week.length) {
    buckets.push({ id: 'week', label: 'Last 7 days', cards: week });
  }
  if (older.length) {
    buckets.push({ id: 'older', label: 'Older', cards: older });
  }
  if (agent.length) {
    buckets.push({ id: 'agent', label: 'Run by agents', cards: agent });
  }
  if (archived.length) {
    buckets.push({ id: 'archived', label: 'Archived', cards: archived });
  }
  const onScreen = cards.length - archived.length - older.length - agent.length;
  let olderFolded = older.length > 0 && !older.some((card) => card.current);
  if (onScreen < 2) {
    olderFolded = false;
  }
  let agentFolded = agent.length > 0 && !agent.some((card) => card.current);
  if (onScreen < 2) {
    agentFolded = false;
  }
  return { buckets, olderFolded, agentFolded };
}

// Saved views and groups use this fold-key prefix. Their keys remain distinct from time-bucket keys and from other grouping types.
export const RAIL_GROUP_FOLD_PREFIX = 'railgroup:';

export const VIEW_FOLD_PREFIX = `${RAIL_GROUP_FOLD_PREFIX}view:`;

export function viewFoldId(view: SavedView): string {
  return `${VIEW_FOLD_PREFIX}${view.id}`;
}

// A session as a section reads it: what the query matches on. Cost fields remain on cards
// because card sorting and query matching use them.
export interface RailSectionCard extends RailBucketCard {
  id: string;
  label: string;
  agent: string;
  labels?: readonly string[];
  costDollars?: number | null;
  costAtLeast?: boolean;
  // The exact cache-expiry return count `cache-expiry:` matches on. Present for the same
  // reason the cost fields are: query matching reads it straight off the card.
  cacheExpiryCount?: number | null;
  // Whether that count is a floor rather than the whole answer, read the same way `costAtLeast`
  // is.
  cacheExpiryAtLeast?: boolean;
  status?: RailStatus | null;
  unread?: boolean;
  // How long this session's prompt cache has left, which the Active lens reads against the
  // clock the caller passes in.
  cache?: RailCacheSpan | null;
  // Agent-run identity remains true when archiving clears agentRun presentation. Counts and cache matching use this identity.
  runByAgent?: boolean;
}

// Figures for session list filter buttons and the View menu. Hidden buckets do not contribute.
// railHeadCounts applies the remaining query terms after a lens press.
// Unread and Needs input count current matches, while their displayed lists also retain sessions the reader has read or answered.
export interface RailCounts {
  // How many cards hold the Running lens: not archived, not run by an agent, and in the
  // running, subagents or background state.
  running: number;
  // How many Active sessions have a warm cache with time still on it, and how many have one in
  // its last stretch. Every one of these is also in `active`. Neither is drawn as a figure: the
  // Active count reads the pair only to choose its bolt.
  warm: number;
  expiring: number;
  // How many cards hold the Active lens: not archived, not run by an agent, and inside the
  // recency window `railCardActive` reads.
  active: number;
  // How many cards hold the Unread lens: not archived, not run by an agent, and unread.
  unread: number;
  // How many cards hold the Needs input lens: not archived, not run by an agent, and waiting on
  // the reader, the card state `is:input` reads.
  input: number;
}

export interface RailCountsOptions {
  showArchived: boolean;
  showRuns: boolean;
}

// Both Show buckets default on. The list and counts use the same saved visibility settings.
export const RAIL_SHOWN_BUCKETS: RailCountsOptions = { showArchived: true, showRuns: true };

// What the Active figures count inside. `inQuery` keeps the cards the rail's query keeps,
// and a caller with no query leaves it out.
export interface RailCountScope {
  inQuery?: (card: RailSectionCard) => boolean;
}

// Count lens matches within inQuery and the shown buckets. Running includes running, subagents and background statuses.
// Active uses the supplied clock.
// Count in one loop without allocating a filtered matchSessions array on every render.
export function railCounts(
  cards: readonly RailSectionCard[],
  { showArchived, showRuns }: RailCountsOptions,
  now: number,
  { inQuery = () => true }: RailCountScope = {},
): RailCounts {
  let running = 0;
  let warm = 0;
  let expiring = 0;
  let active = 0;
  let unread = 0;
  let input = 0;
  for (const card of cards) {
    if (card.archived && !showArchived) {
      continue;
    }
    if (card.agentRun && !showRuns) {
      continue;
    }
    // All lenses exclude agent runs and archived sessions, even when Show settings draw them.
    if (card.runByAgent || card.archived || !inQuery(card)) {
      continue;
    }
    if (railStatusRuns(card.status)) {
      running++;
    }
    if (card.unread) {
      unread++;
    }
    if (card.status === 'waiting') {
      input++;
    }
    if (railCardActive(card, now)) {
      active++;
      const cache = railCacheState(card.cache ?? null, now);
      if (cache === 'nearly-gone') {
        expiring++;
      } else if (cache === 'warm') {
        warm++;
      }
    }
  }
  return { running, warm, expiring, active, unread, input };
}

// Identify queries that read cache warmth or Active recency. Stamp these clock-derived fields only when the query requires them.
export function railQueryReadsCache(query: string): boolean {
  return parseSessionQuery(query).terms.some(
    (term) =>
      term.field === 'status' && (term.needle === 'warm' || term.needle === 'active' || term.needle === 'needsyou'),
  );
}

// Card fields for cache warmth and Active recency at the supplied clock time.
export type RailClockCard<Card> = Card & { cacheWarm?: boolean; active?: boolean };

export function railClockCards<Card extends RailActiveCard>(cards: readonly Card[], at: number): RailClockCard<Card>[] {
  return cards.map((card) => ({
    ...card,
    cacheWarm: railCacheState(card.cache ?? null, at) !== null,
    active: railCardActive(card, at),
  }));
}

// The live query that narrows the rail.
export interface RailNarrowing {
  query: string;
}

// A keeping lens retains these session ids while the query stays the same. Panel reloads clear retention.
export interface RailKept {
  query: string;
  ids: ReadonlySet<string>;
}

// Match the live query before sections claim sessions.
// Unread and Needs input retain matching sessions while the query remains unchanged and its other terms still match.
// Archived sessions and agent runs leave retention. A changed query clears retention.
// Stamp clock facts when the query or a saved view reads them.
export function railShownCards<Card extends RailSectionCard>(
  cards: readonly Card[],
  rail: RailNarrowing,
  at: number,
  stamp = railQueryReadsCache(rail.query),
  kept: RailKept | null = null,
): RailClockCard<Card>[] {
  const pool: RailClockCard<Card>[] = stamp ? railClockCards(cards, at) : [...cards];
  const lens = railQueryHeldLens(rail.query);
  if (lens === null) {
    return matchSessions(pool, rail.query);
  }
  const rest = matchSessions(pool, withoutRailLenses(rail.query));
  const matched = new Set(matchSessions(rest, RAIL_LENS_WORDS[lens]).map((card) => card.id));
  const still = kept && kept.query === rail.query && railKeepingQuery(rail.query) ? kept.ids : null;
  return rest.filter(
    (card) => matched.has(card.id) || (still !== null && still.has(card.id) && !card.archived && !card.runByAgent),
  );
}

// Whether the query's lens keeps what it drew: it holds one lens whole, and that lens keeps.
function railKeepingQuery(query: string): boolean {
  const lens = railQueryHeldLens(query);
  return lens !== null && RAIL_KEEPING_LENSES.includes(lens);
}

// What the rail keeps after a draw of `shown` under this query, for the next `railShownCards`
// call. Null when the query holds no keeping lens, so a lens change or a cleared query starts
// the next keeping lens empty.
export function railKeptAfter(rail: RailNarrowing, shown: readonly { id: string }[]): RailKept | null {
  if (!railKeepingQuery(rail.query)) {
    return null;
  }
  return { query: rail.query, ids: new Set(shown.map((card) => card.id)) };
}

// Count each lens inside the query that remains after its press.
// Active uses these scoped cache counts for its cache indication.
export function railHeadCounts(
  cards: readonly RailSectionCard[],
  shown: RailCountsOptions,
  at: number,
  rail: RailNarrowing,
): RailCounts {
  const byRest = new Map<string, RailCounts>();
  const countsFor = (lens: RailLens): RailCounts => {
    const rest = withoutRailLenses(pressRailLens(rail.query, lens));
    let counts = byRest.get(rest);
    if (!counts) {
      counts = railCountsInRest(cards, shown, at, rest);
      byRest.set(rest, counts);
    }
    return counts;
  };
  return {
    ...countsFor('active'),
    running: countsFor('running').running,
    unread: countsFor('unread').unread,
    input: countsFor('input').input,
  };
}

function railCountsInRest(
  cards: readonly RailSectionCard[],
  shown: RailCountsOptions,
  at: number,
  rest: string,
): RailCounts {
  if (!parseSessionQuery(rest).terms.length) {
    return railCounts(cards, shown, at);
  }
  const pool: RailClockCard<RailSectionCard>[] = railQueryReadsCache(rest) ? railClockCards(cards, at) : [...cards];
  const kept = new Set(matchSessions(pool, rest).map((card) => card.id));
  return railCounts(cards, shown, at, { inQuery: (card) => kept.has(card.id) });
}

// The lens a rail head count presses.
export type RailCountKind = RailLens;

export interface RailCountWords {
  running: string;
  active: string;
  unread: string;
  input: string;
  cacheWarm: string;
  cacheExpiring: string;
  cacheNone: string;
  session: string;
  sessions: string;
  runningHint: string;
  activeHint: string;
  unreadHint: string;
  inputHint: string;
  pressedHint: string;
}

// What the rail is filtered by, as the head row reads it: the saved filter id and the live
// query.
export interface RailHeadLens {
  filterId: string;
  query: string;
}

export interface RailCountButton {
  kind: RailCountKind;
  control: string;
  label: string;
  figure: string;
  // The Active count shows an expiring cache before a warm cache, or no indication when neither exists.
  // cacheDetail names the same state. Both fields are null for other lens counts.
  cacheState: RailCacheState | null;
  cacheDetail: string | null;
  pressed: boolean;
  name: string;
  hint: string;
}

// A count is pressed when the query contains its complete lens and no other complete lens, regardless of query source.
export function railCountPressed(kind: RailCountKind, lens: RailHeadLens): boolean {
  return railQueryHeldLens(lens.query) === kind;
}

// Configured shortcuts draw while selected or while their scoped session count is positive.
// Naming holds their counts and disables presses. Active adds its scoped cache information.
export function railCountButtons(
  counts: RailCounts | null,
  lens: RailHeadLens,
  words: RailCountWords,
  headLenses: readonly RailLens[] = DEFAULT_RAIL_QUICK_FILTERS,
): RailCountButton[] {
  const hints: Record<RailCountKind, string> = {
    running: words.runningHint,
    active: words.activeHint,
    unread: words.unreadHint,
    input: words.inputHint,
  };
  return RAIL_LENSES.filter(
    (kind) => headLenses.includes(kind) && (counts === null || counts[kind] > 0 || railCountPressed(kind, lens)),
  ).map((kind) => {
    const count = counts?.[kind];
    const figure = count === undefined ? '' : count.toLocaleString('en-US');
    const pressed = railCountPressed(kind, lens);
    const cacheState: RailCacheState | null =
      kind !== 'active' || !counts ? null : counts.expiring > 0 ? 'nearly-gone' : counts.warm > 0 ? 'warm' : null;
    const cacheDetail =
      kind !== 'active' || !counts
        ? null
        : cacheState === 'nearly-gone'
          ? words.cacheExpiring
          : cacheState === 'warm'
            ? words.cacheWarm
            : words.cacheNone;
    return {
      kind,
      control: `railcount:${kind}`,
      label: words[kind],
      figure,
      cacheState,
      cacheDetail,
      pressed,
      name:
        count === undefined
          ? words[kind]
          : `${words[kind]}, ${figure} ${count === 1 ? words.session : words.sessions}${cacheDetail ? `. ${cacheDetail}` : ''}`,
      hint: pressed ? words.pressedHint : hints[kind],
    };
  });
}

// One Quick filters checkbox selecting whether its lens count appears on the session list header.
export interface RailHeadLensBox {
  lens: RailLens;
  control: string;
  label: string;
  checked: boolean;
}

// Quick filters checkbox names and checked states in RAIL_LENSES order.
export function railHeadLensBoxes(
  headLenses: readonly RailLens[],
  labels: Readonly<Record<RailLens, string>>,
): RailHeadLensBox[] {
  return RAIL_LENSES.map((lens) => ({
    lens,
    control: `railheadlens:${lens}`,
    label: labels[lens],
    checked: headLenses.includes(lens),
  }));
}

// The head lenses with one lens ticked or unticked, kept in `RAIL_LENSES` order.
export function withRailHeadLensToggled(headLenses: readonly RailLens[], lens: RailLens): RailLens[] {
  const on = !headLenses.includes(lens);
  return RAIL_LENSES.filter((each) => (each === lens ? on : headLenses.includes(each)));
}

// A label-only status choice in the View menu.
export interface RailNarrowToValue {
  value: 'all' | RailLens;
  control: string;
  label: string;
  checked: boolean;
}

// All clears the current status lens. Every lens remains selectable without matches.
export function railNarrowToRow(query: string, words: Readonly<Record<'all' | RailLens, string>>): RailNarrowToValue[] {
  const held = railQueryHeldLens(query);
  return (['all', ...RAIL_LENSES] as const).map((value) => {
    const checked = value === 'all' ? held === null : held === value;
    return {
      value,
      control: `raillens:${value}`,
      label: words[value],
      checked,
    };
  });
}

// One heading and the cards under it.
export interface RailSection<T> {
  id: string;
  label: string;
  cards: T[];
  count: number;
  name: string;
  sort: RailSort;
}

function section<T extends RailSectionCard>(
  id: string,
  label: string,
  cards: T[],
  sort: RailSort = 'latest',
): RailSection<T> {
  const count = cards.length;
  const said = `${label}, ${count} ${count === 1 ? 'session' : 'sessions'}`;
  return { id, label, cards, count, name: said, sort };
}

function tie<T extends RailSectionCard>(left: T, right: T): number {
  return right.at - left.at || left.id.localeCompare(right.id);
}

export function sortRailCards<T extends RailSectionCard>(cards: readonly T[], sort: RailSort): T[] {
  if (sort === 'latest') {
    return [...cards];
  }
  return [...cards].sort((left, right) => {
    if (sort === 'needs-you') {
      const rank = (card: T) => (card.status === 'waiting' ? 0 : card.unread ? 1 : railStatusRuns(card.status) ? 2 : 3);
      return rank(left) - rank(right) || tie(left, right);
    }
    const priced = (card: T) => typeof card.costDollars === 'number' && Number.isFinite(card.costDollars);
    if (priced(left) !== priced(right)) {
      return priced(left) ? -1 : 1;
    }
    if (!priced(left)) {
      return tie(left, right);
    }
    const amount =
      sort === 'cost-desc' ? right.costDollars! - left.costDollars! : left.costDollars! - right.costDollars!;
    if (amount) {
      return amount;
    }
    if (sort === 'cost-asc' && left.costAtLeast !== right.costAtLeast) {
      return left.costAtLeast ? 1 : -1;
    }
    return tie(left, right);
  });
}

// Apply the two Show settings to bucket visibility. The list, counts and label chips share this rule.
export function railCardShown(card: RailBucketCard, { showArchived, showRuns }: RailCountsOptions): boolean {
  return (showArchived || !card.archived) && (showRuns || !card.agentRun);
}

// Subtract hidden sessions from each label count. Keep zero-count labels available so a selected label can still be cleared.
export function railShownLabelCounts<Label extends { name: string; count: number; countName: string }>(
  labels: readonly Label[],
  cards: readonly RailSectionCard[],
  shown: RailCountsOptions,
): Label[] {
  if (shown.showArchived && shown.showRuns) {
    return [...labels];
  }
  const hidden = new Map<string, number>();
  for (const card of cards) {
    if (railCardShown(card, shown)) {
      continue;
    }
    for (const key of new Set((card.labels ?? []).map(labelKey))) {
      hidden.set(key, (hidden.get(key) ?? 0) + 1);
    }
  }
  return labels.map((label) => {
    const less = hidden.get(labelKey(label.name)) ?? 0;
    if (!less) {
      return label;
    }
    const count = Math.max(0, label.count - less);
    return { ...label, count, countName: sessionsCarrying(count) };
  });
}

export function railGroupFoldId(groupBy: 'label' | 'agent' | 'status', key: string): string {
  return `${RAIL_GROUP_FOLD_PREFIX}${groupBy}:${key}`;
}

// The one run Group by None draws.
export const RAIL_ALL_ID = `${RAIL_GROUP_FOLD_PREFIX}all`;

// The status groups in the order the rail draws them. A session waiting on the reader is under
// Needs input only, even when it is also unread, so each session sits in one status group.
const RAIL_STATUS_GROUPS = [
  ['needs-input', 'Needs input'],
  ['running', 'Running'],
  ['unread', 'Unread'],
  ['read', 'Read'],
] as const;
type RailStatusGroup = (typeof RAIL_STATUS_GROUPS)[number][0];

function railStatusGroup(card: RailSectionCard): RailStatusGroup {
  if (card.status === 'waiting') {
    return 'needs-input';
  }
  if (railStatusRuns(card.status ?? null)) {
    return 'running';
  }
  return card.unread ? 'unread' : 'read';
}

// Whether a row draws the card's agent word. An agent group's heading already says the agent
// for every row under it, so the rows there leave it out. Everywhere else the row keeps it.
export function railAgentWordShown(sectionId: string): boolean {
  return !sectionId.startsWith(`${RAIL_GROUP_FOLD_PREFIX}agent:`);
}

// How the rail groups its sessions.
export interface RailGrouping {
  groupBy?: RailGroupBy;
}

// Build sections in Pinned, saved-view, unclaimed-group, Run by agents and Archived order.
// Views match independently, so a session can appear in several views and in Pinned.
// A view includes archived sessions only when its archived option permits them. Empty views retain their headings and start folded.
// Label, Agent and Status groups repeat pinned sessions. Time and None do not repeat them. Multiple labels create multiple group memberships.
// The caller applies the live query before section assignment.
export function railSections<T extends RailSectionCard>(
  cards: T[],
  now: number,
  views: readonly SavedView[],
  railSort: RailSort = 'latest',
  shown: RailCountsOptions = RAIL_SHOWN_BUCKETS,
  { groupBy = 'time' }: RailGrouping = {},
): { sections: RailSection<T>[]; folded: Record<string, boolean> } {
  const folded: Record<string, boolean> = {};
  const sections: RailSection<T>[] = [];
  const add = (id: string, label: string, held: T[], shut: boolean) => {
    folded[id] = shut;
    sections.push(section(id, label, held, railSort));
  };
  // Hidden buckets leave Pinned, saved views and groups. Hiding Archived also excludes those sessions from views that include archived sessions.
  const drawn = shown.showArchived && shown.showRuns ? cards : cards.filter((card) => railCardShown(card, shown));
  const pinned = drawn.filter((card) => card.pinnedTop && !card.archived);
  const archived = drawn.filter((card) => card.archived);
  const active = drawn.filter((card) => !card.archived);
  const rest = active.filter((card) => !card.pinnedTop);
  if (pinned.length) {
    add(RAIL_FOLDS.top, 'Pinned', pinned, false);
  }
  const claimed = new Set<string>();
  for (const view of views) {
    // A view that does not keep archived sessions never sees one, so its section cannot
    // draw a card the reader put away.
    const pool = view.archived ? [...active, ...archived] : active;
    const matched = matchSessions(pool, view.query);
    for (const card of matched) {
      claimed.add(card.id);
    }
    const id = viewFoldId(view);
    folded[id] = matched.length === 0;
    const sort = !view.sort || view.sort === 'inherit' ? railSort : view.sort;
    sections.push(section(id, view.name, matched, sort));
  }
  const loose = rest.filter((card) => !claimed.has(card.id));
  if (groupBy === 'time') {
    const timed = railBuckets(loose, now);
    for (const bucket of timed.buckets) {
      const id = RAIL_FOLDS[bucket.id];
      add(
        id,
        bucket.label,
        bucket.cards,
        bucket.id === 'older' ? timed.olderFolded : bucket.id === 'agent' ? timed.agentFolded : false,
      );
    }
  } else {
    // Run by agents keeps a separate bucket in each grouping. Pinned agent-run sessions remain under Pinned only.
    const runs = loose.filter((card) => card.agentRun);
    // A pinned copy keeps its own place in the rail's order rather than leading its group.
    const members = active.filter(
      (card) => !card.agentRun && !claimed.has(card.id) && (groupBy !== 'none' || !card.pinnedTop),
    );
    railGroups(members, groupBy, add);
    if (runs.length) {
      add(RAIL_FOLDS.agent, 'Run by agents', runs, members.length >= 2 && !runs.some((card) => card.current));
    }
  }

  if (archived.length) {
    add(RAIL_FOLDS.archived, 'Archived', archived, true);
  }
  return {
    sections: sections.map((section) => ({
      ...section,
      cards: sortRailCards(section.cards, section.sort),
    })),
    folded,
  };
}

// The groups one `Group by` value draws over `members`, handed to `add` in drawing order. An
// empty group is never drawn.
function railGroups<T extends RailSectionCard>(
  members: T[],
  groupBy: Exclude<RailGroupBy, 'time'>,
  add: (id: string, label: string, held: T[], shut: boolean) => void,
): void {
  if (groupBy === 'none') {
    if (members.length) {
      add(RAIL_ALL_ID, 'Sessions', members, false);
    }
    return;
  }
  if (groupBy === 'status') {
    for (const [key, label] of RAIL_STATUS_GROUPS) {
      const held = members.filter((card) => railStatusGroup(card) === key);
      if (held.length) {
        add(railGroupFoldId('status', key), label, held, false);
      }
    }
    return;
  }
  // A label group takes the first spelling it meets, the answer the label catalogue gives. An
  // agent group is named by the agent's own name and keyed by its lower case.
  const groups = new Map<string, { label: string; cards: T[]; newest: number }>();
  const unlabelled: T[] = [];
  for (const card of members) {
    const names = groupBy === 'agent' ? [card.agent] : (card.labels ?? []);
    if (!names.length) {
      unlabelled.push(card);
      continue;
    }
    const here = new Set<string>();
    for (const name of names) {
      const key = groupBy === 'agent' ? name.toLowerCase() : labelKey(name);
      if (here.has(key)) {
        continue;
      }
      here.add(key);
      const group = groups.get(key);
      if (group) {
        group.cards.push(card);
        group.newest = Math.max(group.newest, card.at);
      } else {
        groups.set(key, { label: name, cards: [card], newest: card.at });
      }
    }
  }
  // Label groups follow each group's newest session, because the rail is about what is active.
  // Agent groups follow the agent's name, so Claude and Codex keep one order.
  const ordered = [...groups.entries()].sort(([, left], [, right]) =>
    groupBy === 'agent'
      ? left.label.localeCompare(right.label)
      : right.newest - left.newest || left.label.localeCompare(right.label),
  );
  for (const [key, group] of ordered) {
    add(railGroupFoldId(groupBy, key), group.label, group.cards, false);
  }
  // The remainder starts folded, because most sessions carry no label and the groups above
  // hold what the reader filed.
  if (unlabelled.length) {
    add(railGroupFoldId('label', ''), 'Unlabelled', unlabelled, true);
  }
}

// Supported Rows values. Tables keyed by RailDensity must supply every value, including its menu name and age formatter.
export const RAIL_DENSITIES = ['comfortable', 'compact'] as const;
export type RailDensity = (typeof RAIL_DENSITIES)[number];

export function normalizeRailDensity(raw: unknown): RailDensity {
  return (RAIL_DENSITIES as readonly unknown[]).includes(raw) ? (raw as RailDensity) : 'comfortable';
}

// The age a row draws in each density. A compact row prints the short form, and the clock tick
// compares ages with the same formatter the rows were drawn with. The accessible name keeps
// the long form in both densities.
const RAIL_AGE_FORMATS: Record<RailDensity, (at: number, now: number) => string> = {
  comfortable: formatRelative,
  compact: formatRelativeShort,
};

export function railAgeFormat(density: RailDensity): (at: number, now: number) => string {
  return RAIL_AGE_FORMATS[density];
}

// Whether a row leaves the agent word, the figures and the labels out of its drawing.
const RAIL_DENSITY_DROPS: Record<RailDensity, boolean> = { comfortable: false, compact: true };

// Full rows show state hints for subagents and background commands. Other full rows have no hint.
// Compact rows show a hover card named for the session, including their hidden metadata.
// Accessible descriptions omit metadata already present in the accessible name. They retain the state explanation.
// description overrides detail for screen readers. Without description, detail supplies the linked description.
export function railCardHint(
  card: { name?: string; label: string; agentWord: string; nameAfterAge: string },
  density: RailDensity,
  state: { hint: string; detail: string } | null,
): { hint?: string; detail?: string; description?: string; lines: boolean; body?: 'railcard' } {
  if (!RAIL_DENSITY_DROPS[density]) {
    return state ? { hint: state.hint, detail: state.detail, lines: false } : { lines: false };
  }
  const hint = card.name ?? card.label;
  const dropped = [card.agentWord, card.nameAfterAge].filter(Boolean);
  if (state) {
    return dropped.length
      ? {
          hint,
          detail: `${state.detail}\n${dropped.join(', ')}`,
          description: state.detail,
          lines: true,
          body: 'railcard',
        }
      : { hint, detail: state.detail, lines: false, body: 'railcard' };
  }
  const detail = dropped.slice(1).join(', ') || undefined;
  return { hint, detail, description: detail ? '' : undefined, lines: false, body: 'railcard' };
}

// The class list of a card's status word, which carries the word's tone.
export function railStatusClass(status: RailStatus | null): string {
  return `railstatus${status ? ` ${status}` : ''}`;
}

// What the card a compact row opens on hover reads off the rail card.
export interface RailHoverCard {
  name?: string;
  label: string;
  agent: string;
  agentWord: string;
  status: RailStatus | null;
  subagents: number | null;
  commands: number | null;
  runningSince: number | null;
  unsentWord: string | null;
  at: number;
  labels: readonly string[];
}

export interface RailHoverWords {
  hoverFor: string;
  hoverMore: string;
}

export interface RailHoverPart {
  kind: 'agent' | 'agentRun' | 'state' | 'unsent' | 'age';
  text: string;
  // The status word's class list, for a `state` part.
  className?: string;
  // The instant behind an `age` part, which the panel clock rewords.
  at?: number;
  // Running-state start time, duration prefix and formatted duration. The clock updates the prefix and duration together.
  // The first minute has no duration or prefix.
  runningSince?: number;
  lead?: string;
  duration?: string;
}

export interface RailHoverLines {
  name: string;
  meta: RailHoverPart[];
  note: string | null;
  labels: { shown: string[]; more: string | null };
}

// How many labels the hover card draws before it folds the rest into one `+N more` chip.
export const RAIL_HOVER_LABELS = 8;

// Compact hover cards show the name, metadata, state explanation and labels beside the shared session figures.
// Metadata includes the agent, agent-run label, status, unsent-input label and age.
// Running sessions with a start time replace age with duration after the first minute. Those without a start retain age.
// Subagents and background statuses omit age. Format ages using now because the host-supplied relative text has a fixed clock.
export function railHoverLines(card: RailHoverCard, now: number, words: RailHoverWords): RailHoverLines {
  const meta: RailHoverPart[] = [{ kind: 'agent', text: card.agent }];
  if (card.agentWord && card.agentWord !== card.agent) {
    meta.push({ kind: 'agentRun', text: card.agentWord });
  }
  const className = railStatusClass(card.status);
  let note: string | null = null;
  let aged = card.status !== 'subagents' && card.status !== 'background';
  if (card.status === 'subagents') {
    meta.push({ kind: 'state', text: subagentsStillRunning(card.subagents ?? 0), className });
    note = subagentsHintDetail(card.subagents ?? 0);
  } else if (card.status === 'background') {
    meta.push({ kind: 'state', text: backgroundCommandsStillRunning(card.commands ?? 0), className });
    note = backgroundCommandsHintDetail(card.commands ?? 0);
  } else if (card.status === 'running') {
    const since = card.runningSince;
    if (since === null) {
      meta.push({ kind: 'state', text: 'running', className });
    } else {
      // Keep the running start time during the first minute so the clock can add a duration without a host update.
      const lead = ` ${words.hoverFor}`;
      const duration = runningFor(since, now);
      meta.push({
        kind: 'state',
        text: duration ? `running${lead}${duration}` : 'running',
        className,
        runningSince: since,
        lead,
        duration,
      });
    }
    aged = since === null;
  } else {
    const word = railTimeSlot(card.status).word;
    if (word) {
      meta.push({ kind: 'state', text: word, className });
    }
  }
  if (card.unsentWord) {
    meta.push({ kind: 'unsent', text: card.unsentWord });
  }
  if (aged) {
    meta.push({ kind: 'age', text: formatRelative(card.at, now), at: card.at });
  }
  const folded = card.labels.length - RAIL_HOVER_LABELS;
  return {
    name: card.name ?? card.label,
    meta,
    note,
    labels: {
      shown: card.labels.slice(0, RAIL_HOVER_LABELS),
      more: folded > 0 ? `+${folded} ${words.hoverMore}` : null,
    },
  };
}

// The `Group by` row's values. `railSections` reads this to choose which grouping it builds.
// `none` draws every session in one `Sessions` run.
export const RAIL_GROUP_BY = ['time', 'label', 'agent', 'status', 'none'] as const;
export type RailGroupBy = (typeof RAIL_GROUP_BY)[number];

export function normalizeRailGroupBy(raw: unknown): RailGroupBy {
  return (RAIL_GROUP_BY as readonly unknown[]).includes(raw) ? (raw as RailGroupBy) : 'time';
}

// Both Show settings default on. Only an explicit false hides a bucket.
export function normalizeRailShowArchived(raw: unknown): boolean {
  return raw !== false;
}

export function normalizeRailShowRuns(raw: unknown): boolean {
  return raw !== false;
}

// The lenses a panel draws on its head until the reader chooses in the View menu's Quick
// filters line, and again after Forget State. Unread waits for the reader to tick it.
export const DEFAULT_RAIL_QUICK_FILTERS: readonly RailLens[] = ['running', 'active', 'input'];

// Normalize the saved railQuickFilters list, preserving an explicit empty choice.
// When absent, import legacy railHeadLenses with Running added. With neither list, use DEFAULT_RAIL_QUICK_FILTERS.
// Discard unknown values and return selections in RAIL_LENSES order.
export function normalizeRailQuickFilters(raw: unknown, legacy?: unknown): RailLens[] {
  if (Array.isArray(raw)) {
    return RAIL_LENSES.filter((lens) => raw.includes(lens));
  }
  if (Array.isArray(legacy)) {
    return RAIL_LENSES.filter((lens) => lens === 'running' || legacy.includes(lens));
  }
  return [...DEFAULT_RAIL_QUICK_FILTERS];
}
