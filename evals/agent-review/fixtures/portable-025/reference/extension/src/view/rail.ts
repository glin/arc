// Browser-safe session rail projections.

import { matchSessions, parseSessionQuery, railStatusRuns, type QueryMatch } from '../domain/session-query.ts';
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

// `subagents` is a session whose main agent is idle while its background subagents still run.
// `background` is a session whose agent is idle while a command it started in the background
// still runs. The agent resumes by itself when the command ends.
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

// The time after a running word, with the space that parts the two, or nothing under a minute.
// A figure the panel clock rewrites carries its own space, so a row drawn under a minute holds
// no stray space before the time arrives.
export interface RailCardNameParts {
  // The card's own drawn name, present only where it differs from `label`. `nameBeforeAge`
  // used to repeat this text so the accessible name could lead with it; it no longer does,
  // so the wire never carries the name twice, and this function falls back to `label` where
  // `name` is absent.
  name?: string;
  label: string;
  nameBeforeAge: string;
  nameAfterAge: string;
  relative: string;
  status: string | null;
  subagents?: number | null;
  commands?: number | null;
  // What is waiting to be sent, or null once nothing is. `nameBeforeAge` used to carry this
  // clause itself, which repeated the same handful of phrases across every session sharing an
  // agent, a status, and an unsent state, so the wire counted the repeats as one string per
  // card. It arrives on its own field instead, the same field the card's hint reads, and this
  // function appends it once.
  unsentName?: string | null;
}

// The card's complete accessible name, composed from the name and the two clauses around it
// that the payload carries separately.
//
// The payload sends the clauses and not the joined string, because the panel owns the two
// clauses that go between them: the prompt-cache state and how long a running session has
// run, both of which move with the browser's own clock. A caller holding that clock passes
// the clauses in, and a caller without one passes neither and reads the same wording.
//
// A `subagents` or `background` card draws no time, so its name says none either. Its name
// ends on the state, which is also a comfortable card's hint title.
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

// The fixed window the Active lens reads. One hour, chosen so the lens holds a session a
// reader might still be thinking about even after its own cache runs out.
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

// Whether a card holds the Active lens, which is what the lens's words keep. The lens drops a
// session the reader archived and one an agent runs, what `-is:archived -is:agentrun` drops,
// because neither is work the reader can pick up.
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
// each press adds. A query with text draws every match in one Matches section, and over a
// large workspace that is thousands of rows on one keystroke.
export const RAIL_ROW_STEP = 200;

// How many of a section's `count` cards a draw puts on screen after `steps` presses of its
// Show more press.
//
// Pinned draws every card. The reader pinned each one, so a pin made while Pinned holds more
// than a step would otherwise land under the press. A section also draws at least through
// `current`, the index of the current session's card in it, or the session the reader is
// looking at has no row until enough presses reach it. That reach is rounded up to a whole
// step, so the answer is always a whole number of steps and a press adds exactly one.
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

// The rows a draw puts on screen, in the order it draws them, and per section the number of
// cards it left undrawn.
//
// A shut heading draws no row under it, so its cards are left out here and it leaves none.
// `drawn` answers how many of a section's cards go on screen, and the rest wait under that
// section's Show more press. The draw builds its rows from this list and the clock reads the
// same list back, which is what keeps a card nobody can see from asking for a repaint.
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

// The element id a row answers to.
//
// A session drawn once takes its own id. A session that a second saved view or a second group
// also holds draws a second row, and a repeated element id is a defect, because a fold
// heading's `aria-controls` is a list of element ids and cannot say which of the two it means.
// So every row after the first names its section as well.
//
// Which row is first is the order the sections are drawn in, which `railSections` settles. It
// does not move while a session stays in the same sections.
export function railRowId(section: string, id: string, repeat: boolean): string {
  return repeat ? `railrow-${safeIdPart(section)}__${safeIdPart(id)}` : `railrow-${safeIdPart(id)}`;
}

// The key a row's element reconciles under: the session and the section, for every row. A row
// that moves to another section, by a regroup or a pin, is a new element, so the focus, the
// open label editor and the hover state of one section's row never pass to another's. The
// focus follows the session through `focusAfterList`, which looks in the old section first.
export function railRowKey(section: string, id: string): string {
  return `${id}:${section}`;
}

// A piece of an element id that no two values share. `encodeURIComponent` already gives each
// value its own spelling. Its `_` is escaped as well, so after every `%` turns into `_` an
// underscore only ever opens an escape, and `__` only ever joins a section to a session.
function safeIdPart(value: string): string {
  return encodeURIComponent(value).replace(/_/g, '%5F').replace(/%/g, '_');
}

// Which occurrence of a session is a second one, by section.
//
// Read once for the whole draw rather than while the rows are built, because a heading names
// its rows in `aria-controls` before those rows exist and has to spell the same ids they will
// take. The first section holding a session keeps the plain id, in the order
// `railSections` settled, and every section after it names itself.
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

// What a clock tick owes the rows the rail has drawn.
//
// The rows are the ones a draw put on screen, so a card under a folded heading is not in the
// list and cannot ask for a repaint of a row nobody can see. Every comparison is between the
// wording a time yields now and the wording the drawn time yielded, which is what those rows
// carry, so the answer needs no reading of the page.
//
// A cache tooltip is the one piece of wording a redraw is too much for. It lives inside a
// decorative mark, it changes every minute, and the row around it says nothing new, so it
// travels back as a text to write into the row that already holds it.
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

export function archivedNote(n: number): { text: string; action: string } {
  return {
    text: `${n} session${n === 1 ? '' : 's'} archived`,
    action: n === 1 ? 'Bring it back' : 'Bring them all back',
  };
}

export function sessionCount(turns: number): string {
  return `${turns} turn${turns === 1 ? '' : 's'}`;
}

// The three figures a rail card draws, in the order it draws them: cost leads, the
// whole-session turn count follows, and current context closes the line. A figure the
// session has no record for takes no place.
//
// The heading over a session draws more metrics than these, and it draws them in an order
// of its own, so the heading's record is the one that crosses the wire and this is the
// projection the rail takes from it. The card names its own figures for a reader who cannot
// see them, so the host runs this over the same record while it words those names.
export const RAIL_STAT_METRICS = ['cost', 'turns', 'context'] as const;

export function railStatChips<Chip extends { metric: string }>(chips: readonly Chip[]): Chip[] {
  return RAIL_STAT_METRICS.flatMap((metric) => {
    const chip = chips.find((candidate) => candidate.metric === metric);
    return chip ? [chip] : [];
  });
}

// Live and failed states use the rail's single status slot; unsent input takes the time slot.
// A `subagents` session draws its open child count in the running word's place, with no time.
// A `background` session draws its command count there in the same way.
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

// What each time bucket's fold is saved under. The bucket id names the run of cards and this
// names the reader's choice about it, and the two are different strings because the saved key
// outlives the code that wrote it. One module answers what a fold is called, so the browser
// and the grouping below cannot disagree about which key a heading writes.
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

// What a view's section writes its fold under. The view's own id follows it, so a view and a
// time bucket can never take one another's fold, and a stored fold outlives the name the
// reader gave the view.
// What a fold key is. A time bucket writes the name in `RAIL_FOLDS`. A saved view and a group
// heading each write a key under this one prefix instead, so a view or a group called `today`
// cannot take the Today bucket's fold. Each grouping writes its own second word after it, so a
// label group and an agent group never share a fold.
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
  // Whether an agent runs this session, apart from `agentRun` above, which archiving can
  // turn off for the same card. `railCounts` and `is:warm` read this one, so neither ever
  // counts a cache only an agent is spending, archived or not.
  runByAgent?: boolean;
}

// The figures the rail head row's counts and the View menu's Filter row draw. The caller passes
// only the archived and agent-run buckets' shown state, so a hidden bucket's sessions fall out of every figure the same
// switch that empties them from the list.
//
// `active` and `expiring` are the Active count's figures. Each unpressed lens figure equals what
// its press would leave on screen, because `railHeadCounts` counts it inside the rest of the query
// that its own press produces. The pressed lens's figure counts what its lens keeps now, and its
// press clears the lens. `unread` and `input` count over what is unread or waiting now, so either
// can read smaller than the list its lens keeps.
export interface RailCounts {
  // How many cards hold the Running lens: not archived, not run by an agent, and in the
  // running, subagents or background state.
  running: number;
  // How many Active sessions have a warm cache in its last stretch. Every one of these is also
  // in `active`, so the row reads the smaller figure as a clause on the larger one.
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

// Both buckets on, which is what the reader gets before they touch the View menu's `Show`
// section. The rail passes its own saved pair to the list and to the counts together, so a
// bucket that is off is out of both at once and a figure can never report a session the list
// leaves out.
export const RAIL_SHOWN_BUCKETS: RailCountsOptions = { showArchived: true, showRuns: true };

// What the Active figures count inside. `inQuery` keeps the cards the rail's query keeps,
// and a caller with no query leaves it out.
export interface RailCountScope {
  inQuery?: (card: RailSectionCard) => boolean;
}

// `running` is what `is:running` matches, which folds the `subagents` and `background` states
// in with `running` because the grammar has one term for all three, and only over the cards
// `inQuery` keeps.
// `active` is what `railLensHolds` keeps, read against the clock the caller passes in, and only
// over the cards `inQuery` keeps.
//
// The counting loop stays a loop rather than a `matchSessions` call, because a `matchSessions`
// pass allocates a filtered array and this runs on every render. `rail.test.ts` ties each
// condition to the lens that reads it so the loop cannot drift from it.
export function railCounts(
  cards: readonly RailSectionCard[],
  { showArchived, showRuns }: RailCountsOptions,
  now: number,
  { inQuery = () => true }: RailCountScope = {},
): RailCounts {
  let running = 0;
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
    // A card an agent runs, or a card the reader archived, never adds to any figure, whether or
    // not the Show switches draw it, because every lens's words drop both.
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
      if (railCacheState(card.cache ?? null, now) === 'nearly-gone') {
        expiring++;
      }
    }
  }
  return { running, expiring, active, unread, input };
}

// Whether a query asks about either fact this module answers against its own clock: a prompt
// cache's remaining span, or a session's recency window, which `is:active` and `is:needsyou`
// both read. A card carries the moment either one
// runs out or falls outside the window, not a flag, so the rail stamps `cacheWarm` and
// `active` on its cards only when a query it is about to run reads one of them. Every other
// draw hands the matcher the cards it already holds.
export function railQueryReadsCache(query: string): boolean {
  return parseSessionQuery(query).terms.some(
    (term) =>
      term.field === 'status' && (term.needle === 'warm' || term.needle === 'active' || term.needle === 'needsyou'),
  );
}

// A card with the two clock facts the query grammar reads stamped on it: whether its prompt
// cache is still warm, and whether it sits inside the Active window, both at `at`.
export type RailClockCard<Card> = Card & { cacheWarm?: boolean; active?: boolean };

export function railClockCards<Card extends RailActiveCard>(cards: readonly Card[], at: number): RailClockCard<Card>[] {
  return cards.map((card) => ({
    ...card,
    cacheWarm: railCacheState(card.cache ?? null, at) !== null,
    active: railCardActive(card, at),
  }));
}

// What the rail is narrowed by: the live query and how its terms combine.
export interface RailNarrowing {
  query: string;
  match: QueryMatch;
}

// What a keeping lens drew under one query: the query, its match mode, and the ids of the cards
// it drew. The webview holds it and nothing stores it, so a panel reload starts it again.
export interface RailKept {
  query: string;
  match: QueryMatch;
  ids: ReadonlySet<string>;
}

// The cards the rail draws, before sections claim them: the query's matches. A lens is words in
// the query. The words of the one lens a query holds whole are matched apart from the rest of the
// query and combine with it as AND, so a lens narrows under either match mode. No press writes
// two lenses, so a query that holds two was typed or stored by an older build, and it keeps the
// meaning the grammar gives it. A saved view's own `is:unread` keeps its meaning too, because a
// view's query never passes through here.
//
// Under a keeping lens, a card the rail drew under this same query stays drawn after it leaves
// the lens's words, while it still matches every other word and is neither archived nor run by an
// agent. `kept` is what the previous draw returned from `railKeptAfter`. A different query or
// match mode reads it as empty.
//
// `stamp` says whether any query run over these cards reads a clock fact. It defaults to the rail
// query alone, and the rail also passes true when one of its saved views reads one.
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
    return matchSessions(pool, rail.query, rail.match);
  }
  const rest = matchSessions(pool, withoutRailLenses(rail.query), rail.match);
  const matched = new Set(matchSessions(rest, RAIL_LENS_WORDS[lens], 'all').map((card) => card.id));
  const still =
    kept && kept.query === rail.query && kept.match === rail.match && railKeepingQuery(rail.query) ? kept.ids : null;
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
  return { query: rail.query, match: rail.match, ids: new Set(shown.map((card) => card.id)) };
}

// The head row's and the Filter row's figures. Each unpressed lens figure equals what its press
// would draw. A press keeps every other word and writes its own lens in place of any other, so each lens
// is counted inside `withoutRailLenses(pressRailLens(query, lens))`, the rest its own press leaves.
// A press on the pressed lens clears it, so that lens is counted inside the query without its
// words, which is what the lens keeps now.
// The rests differ only when a typed word completes another lens, such as a bare `is:input`,
// because a press on another lens removes that word. Each distinct rest is matched once, so a
// query without such a word runs one match.
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
      counts = railCountsInRest(cards, shown, at, rest, rail.match);
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
  match: QueryMatch,
): RailCounts {
  if (!parseSessionQuery(rest).terms.length) {
    return railCounts(cards, shown, at);
  }
  const pool: RailClockCard<RailSectionCard>[] = railQueryReadsCache(rest) ? railClockCards(cards, at) : [...cards];
  const kept = new Set(matchSessions(pool, rest, match).map((card) => card.id));
  return railCounts(cards, shown, at, { inQuery: (card) => kept.has(card.id) });
}

// The lens a rail head count presses.
export type RailCountKind = RailLens;

export interface RailCountWords {
  running: string;
  active: string;
  unread: string;
  input: string;
  expiring: string;
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
  // The second figure, drawn after the first inside the same run of text and said after the
  // first in the name. Absent while nothing is expiring, and on the Unread and Needs input
  // buttons, because a cache about to go is a fact about recent work only.
  expiring: string | null;
  pressed: boolean;
  name: string;
  hint: string;
}

// Whether the rail rests on what one count sets: the query holds that lens's words whole, and no
// other lens whole, whatever wrote them. A count press, a saved filter, a restored panel and a
// reader who typed the words all press it, and a reader who deletes one of the words unpresses it.
export function railCountPressed(kind: RailCountKind, lens: RailHeadLens): boolean {
  return railQueryHeldLens(lens.query) === kind;
}

// The whole drawing of the head row's counts, worded here rather than in the webview so a Node
// test reads the same names and pressed states the panel draws.
//
// The head draws one count per lens in `RAIL_LENSES` order, Running, Active, Unread, Needs input,
// when the reader ticked that lens in the View menu's Quick filters line and its figure is above
// zero. A count at zero leaves the head. The pressed count is the
// exception: it draws whatever its figure and its tick say, because it names the lens the list is
// on and its press is the way back to every session. Each figure is the one the Filter row draws
// for the same lens, and no drawn count is ever disabled.
export function railCountButtons(
  counts: RailCounts,
  lens: RailHeadLens,
  words: RailCountWords,
  headLenses: readonly RailLens[] = RAIL_LENSES,
): RailCountButton[] {
  const hints: Record<RailCountKind, string> = {
    running: words.runningHint,
    active: words.activeHint,
    unread: words.unreadHint,
    input: words.inputHint,
  };
  return RAIL_LENSES.filter(
    (kind) => railCountPressed(kind, lens) || (headLenses.includes(kind) && counts[kind] > 0),
  ).map((kind) => {
    const count = counts[kind];
    const figure = count.toLocaleString('en-US');
    const pressed = railCountPressed(kind, lens);
    // The clause reads the same whichever figure it carries, because `2 expiring` and
    // `1 expiring` both say what is about to go.
    const expiring =
      kind === 'active' && counts.expiring > 0 ? `${counts.expiring.toLocaleString('en-US')} ${words.expiring}` : null;
    const said = count === 1 ? words.session : words.sessions;
    return {
      kind,
      control: `railcount:${kind}`,
      label: words[kind],
      figure,
      expiring,
      pressed,
      name: `${words[kind]}, ${figure} ${said}${expiring ? `, ${expiring}` : ''}`,
      hint: pressed ? words.pressedHint : hints[kind],
    };
  });
}

// One checkbox of the View menu's Quick filters line, which chooses the lenses whose counts may
// draw on the rail head.
export interface RailHeadLensBox {
  lens: RailLens;
  control: string;
  label: string;
  checked: boolean;
}

// The Quick filters checkboxes in `RAIL_LENSES` order, worded here so a Node test reads the
// names and ticks the menu draws.
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

// One value of the View menu's Filter row. `figure` is null for All, which is not a lens.
export interface RailNarrowToValue {
  value: 'all' | RailLens;
  control: string;
  label: string;
  figure: string | null;
  checked: boolean;
  disabled: boolean;
}

// The View menu's Filter row: All, then each lens with the figure its press would count. A lens
// whose figure is zero answers no press unless it is the checked value, because a checked lens is
// where the reader stands. The menu keeps every value drawn so nothing moves under the pointer,
// where the head drops a count at zero.
export function railNarrowToRow(
  counts: RailCounts,
  query: string,
  words: Readonly<Record<'all' | RailLens, string>>,
): RailNarrowToValue[] {
  const held = railQueryHeldLens(query);
  return (['all', ...RAIL_LENSES] as const).map((value) => {
    const checked = value === 'all' ? held === null : held === value;
    const count = value === 'all' ? null : counts[value];
    return {
      value,
      control: `raillens:${value}`,
      label: words[value],
      figure: count === null ? null : count.toLocaleString('en-US'),
      checked,
      disabled: count === 0 && !checked,
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

// Whether a card sits in a bucket the reader shows. The View menu's two Show switches each take
// one bucket off the rail, and everything that reads the rail's sessions asks this one question,
// so a hidden session leaves the list, the figures and the label chips together.
export function railCardShown(card: RailBucketCard, { showArchived, showRuns }: RailCountsOptions): boolean {
  return (showArchived || !card.archived) && (showRuns || !card.agentRun);
}

// The View menu's label chips with the hidden buckets taken out of each count. The catalogue
// counts every session carrying a label, and a session the Show switches hide is taken off each
// label it carries, so a chip never counts a session its press could not draw. A label no shown
// session carries keeps its chip at zero, because a pressed chip is the way to unpress it.
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

// Whether the query holds text beyond its one lens's words. A lens press writes the lens's words
// into the query and keeps the rail grouped, because the lens narrows every group the same way.
// A query that holds two lenses whole holds no lens, so it reads as text. Any other word turns
// grouping off and draws one `Matches` run, a search word such as
// `find:` or `in:` included, because the reader typed it.
export function railQueryHasText(query: string): boolean {
  return withoutRailLenses(query).trim().length > 0;
}

export function railGroupFoldId(groupBy: 'label' | 'agent' | 'status', key: string): string {
  return `${RAIL_GROUP_FOLD_PREFIX}${groupBy}:${key}`;
}

// The one section a query with text draws. It holds no fold, so a match is never hidden.
export const RAIL_MATCHES_ID = 'railmatches';
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
// for every row under it, so the rows there leave it out. Everywhere else, Pinned and the
// `Matches` run included, the row keeps it, because no heading says it there.
export function railAgentWordShown(sectionId: string): boolean {
  return !sectionId.startsWith(`${RAIL_GROUP_FOLD_PREFIX}agent:`);
}

// How the rail groups its sessions: the `Group by` value, and whether the query holds text that
// turns grouping off for one `Matches` run.
export interface RailGrouping {
  groupBy?: RailGroupBy;
  matches?: boolean;
}

// The rail's sections, in the order the reader meets them: Pinned, then one per saved view, then
// the groups over everything no view claimed, then Run by agents, then Archived.
//
// A view is a group of its own. It answers its query over every session the reader has not
// archived. Pinned holds its own copy first, so a pinned session that matches also appears in
// the view. Archived stays outside unless the view says it keeps archived sessions.
//
// A session two views match appears under both. Each view answers for itself, and a rule
// that gave the first view the card would make a section's contents depend on the order the
// reader happened to save its neighbours in.
//
// A view whose query matches nothing keeps its heading, folded, saying nothing is under it. The
// heading is where the reader renames and deletes the view, so a section that vanished would
// take the view out of reach the moment its query went stale.
//
// Under Group by Label, Agent or Status a pinned session sits under Pinned and again under its
// group, the way a saved view holds a pinned match. Under Time and None it sits under Pinned
// only. A session carrying two labels sits under both. Under a query with text the saved views
// and the groups give way to one `Matches` run over every match not pinned or archived, so no
// fold or copy hides a match. A view saved from the query in the box appears once the box is
// cleared.
export function railSections<T extends RailSectionCard>(
  cards: T[],
  now: number,
  views: readonly SavedView[],
  railSort: RailSort = 'latest',
  shown: RailCountsOptions = RAIL_SHOWN_BUCKETS,
  { groupBy = 'time', matches = false }: RailGrouping = {},
): { sections: RailSection<T>[]; folded: Record<string, boolean> } {
  const folded: Record<string, boolean> = {};
  const sections: RailSection<T>[] = [];
  const add = (id: string, label: string, held: T[], shut: boolean) => {
    folded[id] = shut;
    sections.push(section(id, label, held, railSort));
  };
  // A bucket the reader turned off takes its sessions out of everything below: the pinned
  // run, the saved views, the groups and the matches under a query. A view that keeps
  // archived sessions therefore keeps none while the Archived bucket is off, because the
  // reader asked not to see them at all.
  const drawn = shown.showArchived && shown.showRuns ? cards : cards.filter((card) => railCardShown(card, shown));
  const pinned = drawn.filter((card) => card.pinnedTop && !card.archived);
  const archived = drawn.filter((card) => card.archived);
  const active = drawn.filter((card) => !card.archived);
  const rest = active.filter((card) => !card.pinnedTop);
  if (pinned.length) {
    add(RAIL_FOLDS.top, 'Pinned', pinned, false);
  }
  const claimed = new Set<string>();
  // Under a query with text the rail is Pinned, one `Matches` run and Archived. A saved view
  // would claim its matches into a section of its own, and a view the reader had folded
  // would then hide a match from the run.
  for (const view of matches ? [] : views) {
    // A view that does not keep archived sessions never sees one, so its section cannot
    // draw a card the reader put away.
    const pool = view.archived ? [...active, ...archived] : active;
    const matched = matchSessions(pool, view.query, view.match);
    for (const card of matched) {
      claimed.add(card.id);
    }
    const id = viewFoldId(view);
    folded[id] = matched.length === 0;
    const sort = !view.sort || view.sort === 'inherit' ? railSort : view.sort;
    sections.push(section(id, view.name, matched, sort));
  }
  const loose = rest.filter((card) => !claimed.has(card.id));
  if (matches) {
    // Drawn even when empty, so a query that matches nothing still says `Matches · 0`.
    add(RAIL_MATCHES_ID, 'Matches', loose, false);
  } else if (groupBy === 'time') {
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
    // Run by agents stays a bucket of its own under every grouping, and a pinned session an
    // agent runs sits under Pinned only, as it does under time grouping.
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

// The `Rows` row's values. A third, denser level is one more word here and one more block of
// CSS rules. Every table keyed by `RailDensity` then fails the typecheck until it names the
// new level, so its menu words and its age cannot be left out.
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

// A card's hover. A `subagents` or `background` card explains its state in every density,
// because neither word alone says that the agent is idle and takes a prompt now. A row that
// drops the agent word, the figures and the labels shows them in its hover instead, drawn as a
// card under the session's name: `body` names that card, and `hint` is the name. A comfortable
// card in any other state has no hover.
//
// The accessible name always carries the agent word, the figures, the labels and a `subagents`
// or `background` card's state word, in both densities. `detail` is the plain hover's second
// line, in the words the accessible name uses. The card replaces it on screen, and it stays
// what a screen reader reaches through `aria-describedby` where no `description` is set.
// `description` is what a screen reader reads instead. It drops what `detail` says only because
// the name already says it. That is the dropped words in a compact card with no state, and the
// dropped words' line in a compact `subagents` or `background` card. That card's state
// explanation is not in the name, so it stays in the description.
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
  // The instant a running `state` part's duration counts from, the words that lead the
  // duration, and the duration as `runningFor` words it, empty in the first minute. The lead
  // and the duration end `text` together, and the panel clock rewrites them alone, so `for`
  // shows only beside a duration.
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

// The words of the card a compact rail row opens on hover: the session's name, a meta line, a
// `subagents` or `background` card's explanation, and the labels. The meta line holds the
// agent, the agent-run word where it differs, the state word, the unsent word and the long
// age. A running card with a recorded start shows `running`, adds its duration after the
// first minute, and shows no age. A running card with no recorded start shows `running` and
// the age. A `subagents` or `background` card shows no age. The card draws the rail's own
// figure line beside these words. The age is worded against `now`, never the host's
// `relative`, which is fixed when the host builds the card.
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
      // The mark is set in the first minute too, so a card open when the minute passes gains
      // its duration from the clock with no host update.
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

// The `Show` section's two rows. Both default on, so a panel saved before this build opens
// with every bucket it drew before: only a stored `false` turns one off.
export function normalizeRailShowArchived(raw: unknown): boolean {
  return raw !== false;
}

export function normalizeRailShowRuns(raw: unknown): boolean {
  return raw !== false;
}

// The lenses whose counts may draw on the rail head, from the View menu's Quick filters line.
// `raw` is the stored `railQuickFilters` field, and an empty array there is a choice the reader
// made and stays empty. `legacy` is the `railHeadLenses` field a build without the Running lens
// stored, read only while `railQuickFilters` is absent. That build drew a running figure on
// every rail, so its list reads with Running added, and an upgrade never takes away a figure the
// reader saw before. A panel that stored neither draws all four. Unknown values leave, and the
// rest read in `RAIL_LENSES` order.
export function normalizeRailQuickFilters(raw: unknown, legacy?: unknown): RailLens[] {
  if (Array.isArray(raw)) {
    return RAIL_LENSES.filter((lens) => raw.includes(lens));
  }
  if (Array.isArray(legacy)) {
    return RAIL_LENSES.filter((lens) => lens === 'running' || legacy.includes(lens));
  }
  return [...RAIL_LENSES];
}
