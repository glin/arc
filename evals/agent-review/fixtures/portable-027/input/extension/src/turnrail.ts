// extension/src/turnrail.ts
//
// The session rail: which sessions it lists, how they are bucketed by time, what each one says and how wide the column may be.
//
// Split out of turnview.ts, which was 3,965 lines of pure functions with no shared state and
// no seam anyone could find. Nothing here was edited on the way: every declaration is the one
// that was there, in the order it was in. turnview.ts re-exports this module, so an import
// written against it still resolves.

import {
  AgentKind,
  Compaction,
  ContextRequest,
  SessionStatCompactionFacts,
  Turn,
  TurnOutcome,
  type BackgroundCommand,
  type ClosedChild,
} from './transcript';
import {
  CARD_ACTIONS,
  STATUS_WORDS,
  SessionStatChip,
  TURN_QUIET_MS,
  TurnStatus,
  cacheWriteWarningCondition,
  sessionStats,
  statusOf,
  type CacheExpiryCountFact,
  type SessionContextDetail,
  type SessionCostTotal,
  withSessionContextDetail,
} from './turncard';
import { labelsOf, railLabelFields } from './turnlabels';
import { formatWhen } from './turnformat';
import { NewCount } from './turnread';
import {
  NEEDS_INPUT,
  backgroundCommandsStillRunning,
  childrenOutliveTurn,
  railStatChips,
  subagentsStillRunning,
  type RailStatus,
} from './view/rail.ts';
import { CACHE_LIFETIME_MS, CONSERVATIVE_CACHE_BOUNDARY_MS, cacheLifetimeFor, nextTurnFloor } from './pricing';
export {
  archivedNote,
  clampRailWidth,
  NEEDS_INPUT,
  railBuckets,
  RAIL_BUCKETS,
  RAIL_MIN_WIDTH,
  RAIL_WIDTH_DEFAULT,
  RAIL_WIDTH_MIN,
  railTimeSlot,
  sessionCount,
} from './view/rail.ts';
export type { RailBucket, RailStatus } from './view/rail.ts';

export interface RailCacheMark {
  expiresAt: number;
  nearlyGoneAt: number | null;
}

export interface RevisionedRailCacheMark {
  mark: RailCacheMark | null;
  mtimeMs: number;
  size: number;
}

export const RAIL_CACHE_NEARLY_GONE_MIN_MS = 3 * 60_000;

// The rail needs a cache answer before its session joins the parse cut. It uses the
// same request and price lookup as the composer, but carries only the two clock boundaries
// the browser needs to redraw the decorative mark.
interface RailCacheFacts {
  turns: readonly {
    startedAt: number;
    finished: boolean;
    error: boolean | string | null;
    contextTokens: number;
    contextWindow: number | null;
    model: string | null;
    provider?: string | null;
    contextRequest?: ContextRequest | null;
  }[];
  compactions: readonly SessionStatCompactionFacts[];
}

export function railCacheMarkOf(facts: RailCacheFacts | null, now: number = Date.now()): RailCacheMark | null {
  if (!facts?.turns.length) {
    return null;
  }
  const newest = facts.turns.reduce((latest, turn) => (turn.startedAt > latest.startedAt ? turn : latest));
  if (newest.error) {
    return null;
  }
  const request = newest.contextRequest;
  if (!request || !newest.contextTokens) {
    return null;
  }
  if (facts.compactions.some((compaction) => compaction.at > request.at)) {
    return null;
  }
  if (
    !nextTurnFloor({
      contextTokens: newest.contextTokens,
      model: newest.model,
      provider: newest.provider,
      contextWindow: newest.contextWindow,
      tier: request.lifetime,
      inferenceClass: request.inferenceClass,
      serviceTier: request.serviceTier,
    })
  ) {
    return null;
  }
  const lifetimeTier = request.lifetime ?? cacheLifetimeFor(newest.model, newest.provider ?? null);
  if (!lifetimeTier) {
    return null;
  }
  const lifetime = CACHE_LIFETIME_MS[lifetimeTier];
  const expiresAt = request.at + lifetime - CONSERVATIVE_CACHE_BOUNDARY_MS;
  if (expiresAt <= now) {
    return null;
  }
  const finalQuarter = lifetime / 4;
  return {
    expiresAt,
    nearlyGoneAt: finalQuarter >= RAIL_CACHE_NEARLY_GONE_MIN_MS ? expiresAt - finalQuarter : null,
  };
}

export function railCachesOf(
  parsed: Readonly<Record<string, RevisionedRailCacheMark>>,
  metadata: Readonly<Record<string, RailCacheMark | null>>,
  revisions: Readonly<Record<string, Pick<RevisionedRailCacheMark, 'mtimeMs' | 'size'>>>,
): Record<string, RailCacheMark | null> {
  const caches = { ...metadata };
  for (const [sessionId, snapshot] of Object.entries(parsed)) {
    const revision = revisions[sessionId];
    if (revision?.mtimeMs === snapshot.mtimeMs && revision.size === snapshot.size) {
      caches[sessionId] = snapshot.mark;
    }
  }
  return caches;
}

// Cards leave here already grouped: all of one session's together, in the order they
// arrived, with the sessions themselves ordered by their first card. The panel draws one
// heading per run of the same id, so a list that interleaves two sessions repeats their
// headings all the way down instead of drawing each one once.
export function groupBySession<T extends { sessionId: string }>(cards: T[]): T[] {
  const order: string[] = [];
  for (const c of cards) {
    if (!order.includes(c.sessionId)) {
      order.push(c.sessionId);
    }
  }
  return order.flatMap((id) => cards.filter((c) => c.sessionId === id));
}

// The sessions to parse: the recent cut, plus every session pinned to the rail's
// top that the cut left out. A pinned session stays parsed however old it gets,
// which is what pinning promises, so the parse budget grows by the pins rather than the
// pins evicting live sessions from it. Fed the pool that already survived hiding, so a
// stale state holding a session as both hidden and pinned reads as hidden.
export function withPinned<T extends { sessionId: string }>(
  cut: T[],
  visible: T[],
  pinnedTop: ReadonlySet<string>,
): T[] {
  const have = new Set(cut.map((s) => s.sessionId));
  return [...cut, ...visible.filter((s) => pinnedTop.has(s.sessionId) && !have.has(s.sessionId))];
}

// The sessions left after the hidden ones are taken out. It runs before the panel cuts the
// list down to the few it will parse, which is the point of it: hiding a session that
// has finished frees one of those slots for a live one, and starting three agents is enough
// to push the session being read out of the list.
//
// A session pinned in the picker comes through whether or not it is hidden. Otherwise
// hiding the one that is pinned would take it off the list and leave nothing to pick it
// back with, and archiving the session on screen would empty the panel the reader is
// reading. `railSessions` has no such exemption, on purpose: the card is what the reader
// meant to put away, and the turns are not.
export function hideSessions<T extends { sessionId: string }>(
  sessions: T[],
  hidden: ReadonlySet<string>,
  pinned: string | null = null,
): T[] {
  return sessions.filter((s) => !hidden.has(s.sessionId) || s.sessionId === pinned);
}

// The figures for every session on screen, by session id.
//
// Which turns feed which session's figures is a decision, so it lives here beside
// `groupBySession` and `newestPerSession` rather than in the panel: those two exist for
// exactly this and are tested, and a grouping written in `panelhost.ts` is one nothing reads.
// The compactions are grouped the same way and handed to each session's own figures. They
// are required rather than optional, so the one caller in `panelhost.ts` has to answer for
// them: an optional list would default to empty there and the count would read zero on
// every session with no test able to see it.
export function statsBySession(turns: Turn[], compactions: Compaction[]): Record<string, SessionStatChip[]> {
  const mine = new Map<string, Turn[]>();
  for (const t of turns) {
    const held = mine.get(t.sessionId);
    if (held) {
      held.push(t);
    } else {
      mine.set(t.sessionId, [t]);
    }
  }
  const theirs = new Map<string, Compaction[]>();
  for (const c of compactions) {
    const held = theirs.get(c.sessionId);
    if (held) {
      held.push(c);
    } else {
      theirs.set(c.sessionId, [c]);
    }
  }
  const out: Record<string, SessionStatChip[]> = {};
  for (const [id, held] of mine) {
    out[id] = sessionStats(held, theirs.get(id) ?? []);
  }
  return out;
}

// Context falls back to the bounded metadata pass outside the parse cut, and a parsed
// session replaces it where available. Cost and turn count have a different source:
// the persisted full-file spend index. Until that index has the required complete sources,
// the rail omits each whole-session figure instead of showing a tail subtotal.
function projectedSessionStats(
  parsed: Readonly<Record<string, readonly SessionStatChip[]>>,
  metadata: Readonly<Record<string, readonly SessionStatChip[]>>,
  lifetime: Readonly<Record<string, readonly SessionStatChip[]>>,
  lifetimeMetrics: readonly ('cost' | 'turns' | 'cache-expiry')[],
): Record<string, SessionStatChip[]> {
  const out: Record<string, SessionStatChip[]> = {};
  const ids = new Set([...Object.keys(metadata), ...Object.keys(parsed), ...Object.keys(lifetime)]);
  for (const id of ids) {
    const contextual = [...(parsed[id] ?? metadata[id] ?? [])].filter(
      (stat) => stat.metric !== 'cost' && stat.metric !== 'turns',
    );
    const whole = lifetimeMetrics.flatMap((metric) => {
      const stat = lifetime[id]?.find((candidate) => candidate.metric === metric);
      return stat ? [stat] : [];
    });
    out[id] = [...whole, ...contextual];
  }
  return out;
}

export function sessionStatsOf(
  parsed: Readonly<Record<string, readonly SessionStatChip[]>>,
  metadata: Readonly<Record<string, readonly SessionStatChip[]>>,
  lifetime: Readonly<Record<string, readonly SessionStatChip[]>>,
  contextDetails: Readonly<Record<string, SessionContextDetail>> = {},
): Record<string, SessionStatChip[]> {
  const stats = projectedSessionStats(parsed, metadata, lifetime, ['cost', 'turns', 'cache-expiry']);
  return Object.fromEntries(
    Object.entries(stats).map(([id, chips]) => [id, withSessionContextDetail(chips, contextDetails[id])]),
  );
}

// The rail's order while it stays open. A refresh brings the sessions newest activity
// first, but activity is also what every running session changes repeatedly. Keep
// every session already on the rail where it was, append a session found since
// the last refresh, then move the running group above the inactive group without changing
// either group's internal order. A session that starts running therefore joins after
// the ones already running instead of making them trade places on every write.
//
// The order is reconciled over every known session rather than the cards `railSessions`
// returns. Remembering the first session is what lets the next one join beneath it
// instead of taking its place above it.
// The statuses `stableRailOrder` lifts into the running group. A `subagents` session still has
// work in progress, and a `background` session waits on a command that wakes it, so both sort
// with the running ones.
const RUNNING_GROUP: ReadonlySet<string> = new Set<RailStatus>(['background', 'running', 'subagents', 'waiting']);

export function stableRailOrder<T extends { id: string }>(
  sessions: readonly T[],
  previous: readonly string[],
  statuses: ReadonlyMap<string, RailStatus>,
): T[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const seen = new Set<string>();
  const ordered: T[] = [];
  for (const id of previous) {
    const session = byId.get(id);
    if (!session || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ordered.push(session);
  }
  for (const session of sessions) {
    if (seen.has(session.id)) {
      continue;
    }
    seen.add(session.id);
    ordered.push(session);
  }
  return [
    ...ordered.filter((session) => RUNNING_GROUP.has(statuses.get(session.id) ?? '')),
    ...ordered.filter((session) => !RUNNING_GROUP.has(statuses.get(session.id) ?? '')),
  ];
}

// The reader's words that have not left one session yet. Prompt text is a boolean
// because its length says nothing useful on the rail; comments keep their count so the
// card's accessible name can say exactly what is waiting.
export interface UnsentInput {
  prompt: boolean;
  comments: number;
}

// The prompt box follows the same blank rule as Send. Spacing alone cannot leave the box,
// so it does not mark a session as holding work to send.
export function hasUnsentPrompt(text: unknown): boolean {
  return typeof text === 'string' && text.trim().length > 0;
}

// The unsent input filed under each session. Comments need only their session id
// here: their text and turn anchor belong to turncomments.ts and do not affect the rail.
export function unsentBySession(
  drafts: Readonly<Record<string, string>>,
  comments: readonly { sessionId: string }[],
): Map<string, UnsentInput> {
  const out = new Map<string, UnsentInput>();
  for (const [sessionId, text] of Object.entries(drafts)) {
    if (sessionId && hasUnsentPrompt(text)) {
      out.set(sessionId, { prompt: true, comments: 0 });
    }
  }
  for (const comment of comments) {
    if (!comment.sessionId) {
      continue;
    }
    const held = out.get(comment.sessionId) ?? { prompt: false, comments: 0 };
    out.set(comment.sessionId, { prompt: held.prompt, comments: held.comments + 1 });
  }
  return out;
}

// The detail a rail card says and shows on hover. The visible word stays singular and
// compact; this names what opening the session will find.
export function unsentInputName(input: UnsentInput | undefined): string | null {
  if (!input || (!input.prompt && input.comments < 1)) {
    return null;
  }
  const comments = input.comments === 1 ? '1 unsent comment' : `${input.comments} unsent comments`;
  if (input.prompt && input.comments) {
    return `unsent prompt and ${comments}`;
  }
  if (input.prompt) {
    return 'unsent prompt';
  }
  return comments;
}
// One card on the session rail: a session, named, and what is new in it.
export interface RailCard {
  id: string;
  // Whether the session has a saved record. A provisional new session has none, so nothing
  // can rename it.
  persisted: boolean;
  // The short form of the session's name. The card's own action buttons (pin, archive,
  // label) are announced by it, because an accessible name for a control the reader
  // presses on every card should not grow with how much the reader once typed.
  label: string;
  // The card's own drawn name: `.railname` shows this, cut to 200 characters rather than
  // to `label`'s 60, so the row fills whatever width the reader drags the rail to before
  // the CSS ellipsis takes over. The rail has no maximum width, and 200 characters fills a
  // rail of about 1,300px at the panel's own type size, far wider than a normal rail.
  // Present only where it differs from `label`, so a session whose name never grew past the
  // sixty-character label costs nothing extra on the wire. A reader draws `name ?? label`.
  name?: string;
  agent: string;
  // How long ago the session was last active, feeding the accessible name only:
  // the drawn time is worded by the panel from `at` through the ticker's own ladder,
  // because this string is only as fresh as the refresh that posted it. The clock time
  // rides the hover as `absolute`, the same trade every turn card makes. Named for what
  // it holds: the session row's own `when` is the clock, and a card field called the
  // same thing holding the opposite reading was a trap.
  relative: string;
  at: number;
  absolute: string;
  // Whether this is the session the panel is showing alone. The rail is the chooser
  // at the widths it exists at, so the card carries the state a note above the list used
  // to say in a sentence; the note read as noise and went.
  current: boolean;
  // Whether the reader pinned this session to the rail's top. Drawn as the star on
  // the card's own control and said in the name; the ordering below is where it acts.
  pinnedTop: boolean;
  // Whether the reader archived this session. An archived card is not dropped from
  // the rail: it goes to the Archived bucket at the foot, folded, where one session
  // can be brought back on its own. The word is in the accessible name as well, because
  // the dimmer card says it to the eye alone.
  archived: boolean;
  // Whether another agent started this session rather than the reader. The cards
  // gather in a bucket of their own, folded, and leave the day buckets and the unread
  // counts to sessions somebody had. Archived wins over this for the bucket, so an
  // archived agent-run card carries `agentRun: false` and sits in the Archived bucket.
  agentRun: boolean;
  // The same fact `agentRun` names, apart from which bucket the card sits in. Archiving
  // never changes it, so the lens figures and the `is:agentrun` term can skip a
  // card an agent runs whether or not the Archived switch is also on.
  runByAgent: boolean;
  // What the card draws in the one slot its meta line keeps for the agent's name: the
  // name, or the phrase saying an agent ran it. Decided here rather than in the panel
  // because the panel would need its own copy of a rule with words in it, and the words
  // and the rule that picks them are worth testing together.
  agentWord: string;
  // The newest turn's status, or null where none is knowable. The card wears it as the
  // same left-border colour a turn card wears its own, and the name says it as a word,
  // because a colour reads out as nothing.
  status: RailStatus | null;
  // How many background children still work, where the status is `subagents`, else null.
  subagents: number | null;
  // How many background commands still run, where the status is `background`, else null.
  commands: number | null;
  runningSince: number | null;
  runningSinceWhen: string | null;
  // The prompt-cache mark's clock boundaries. The browser owns the current clock and turns
  // these into its two visual faces without asking the extension to refresh each minute.
  cache: RailCacheMark | null;
  // The clauses that surround the relative age, split from it because the browser inserts
  // or removes its cache state there. Neither carries the card's own name: `railCardName`
  // prepends `name` when it composes the accessible name, so the name rides the wire once
  // rather than once here and once again in `name` below.
  nameBeforeAge: string;
  nameAfterAge: string;
  // One compact word on the meta row, and the exact detail on its hover. Both are decided
  // here so the panel draws values rather than counting drafts or comments for itself.
  unsentWord: string | null;
  unsentName: string | null;
  // The recorded cost, independent from the figure the card draws for it. A heading over a run
  // of cards adds it, and the filter compares it with a typed threshold.
  //
  // Null where the session has no priced cost. Exact zero remains zero even though the
  // display rule omits its chip.
  costDollars: number | null;
  // Whether that figure is a floor rather than a total. A visible cost chip says the same
  // fact with `+`. Only a card carrying a figure can be a floor.
  costAtLeast: boolean;
  // The exact count of cache-expiry returns from lifetime primary-session indexed facts, read
  // the same way `costDollars` is. Null where the source cannot answer, which the `cache-expiry:`
  // filter reads as a match for neither comparison. Carried for the filter alone; the card draws
  // no stat for it.
  cacheExpiryCount: number | null;
  // Whether that count is a floor rather than the whole answer, read the same way `costAtLeast`
  // is. True wherever the classifier could not judge every adjacent pair, since an unjudged pair
  // may itself have been a qualifying return the count has not added in. Only a card carrying a
  // count can be a floor.
  cacheExpiryAtLeast: boolean;
  // Every label the session carries, in the order the reader applied them.
  //
  // The whole list rather than the drawn cut, because two readers of the card ask about the
  // whole of it. The rail filter answers a `label:` term off this, and the session heading
  // draws every label on a line that has the width the rail does not.
  labels: string[];
  // The labels the row draws, the front of the list above. The row takes a fixed number of
  // them, `RAIL_LABELS_SHOWN`, whatever width the rail has been dragged to: a count that
  // moved with the width would redraw the line on every drag, and the card would say a
  // different thing about the session at each one. What the row left out is counted in
  // the field below and said in full in the name. The card draws fewer than it holds and
  // claims nothing less.
  labelChips: string[];
  // How many labels the row left out, drawn as a count with a leading plus, and null when it
  // left none out. Worded here rather than in the panel. The count and the chips beside it
  // are then cut by one rule, and cannot disagree about how many are missing.
  labelsMore: string | null;
  // The labels the count stands for, so the chip drawn from it carries the whole of what it
  // hides on its hover. A count on its own is the one thing on the line a reader cannot read
  // their way out of: the chips beside it say words, and it says a number.
  labelsMoreName: string | null;
  // "3 new", or null when there is nothing to say. Two silences, and they differ: a parsed
  // session with nothing new, and one never parsed, whose count is not knowable. The
  // accessible name below tells them apart; the drawn card stays quiet for both.
  indicator: string | null;
  // The same count as a number, and null for both silences the indicator is quiet for.
  // Nothing on the rail draws it: the card would be saying in a figure what its heading
  // already says in words, and a figure cannot word the difference between a known zero
  // and no count at all. It is what `unread` is decided from, and the name is worded
  // beside it, so the mark and the count cannot disagree.
  newCount: number | null;
  // Whether the reader has anything waiting in this session. The card's leading dot
  // and its name in bold both follow this one field, so the two marks of the same thing
  // cannot fall out of step. False where the count is not knowable: an unread mark is a
  // claim, and the panel makes none it cannot support.
  unread: boolean;
  // When this session's newest parsed turn started, or null where none was parsed.
  //
  // The watermark "mark the session read" writes, carried on the card because the
  // panel cannot work it out for itself: while one session is shown alone the others
  // have no card drawn, and a watermark taken from the drawn turns would leave the entry
  // with nothing to mark. It is the newest *parsed* turn, the same list the count and the
  // status are read from, so a session the rail can describe is one the rail can mark.
  newestTurnAt: number | null;
  // The section the card names itself by for the editor's own context menu. Every card names
  // one: a session nothing has parsed can answer no read entry, and labelling a
  // session needs no parsed turn, so it names the plain section rather than carrying no
  // context at all. Decided here rather than in the panel, so the panel spells no section
  // name of its own; see RAIL_MENU_SECTIONS.
  menuSection: string;
}

// The section a rail card names itself by for the editor's own context menu, so a whole
// session can be marked read or unread from the rail. The section is the one piece of a
// webview's context a menu's when clause can match, so the read state is spelled into the
// name the way a turn card's is.
//
// Two of the names carry the state a card is in, and the menu then offers the one the
// session has not already taken. A session whose count is not knowable takes
// neither: it was never parsed, so there is no newest turn to set a watermark from, and the
// entry would do nothing.
//
// The third name is what that card takes instead. Filing a session under a label needs
// no parsed turn, so a card that can answer no read entry still has something a right-click
// reaches, and every card names itself. The read and the unread entries go on gating on the
// two named states, so the third adds no entry that would act on nothing.
export const RAIL_MENU_SECTIONS = {
  unread: 'arcRailUnread',
  read: 'arcRailRead',
  plain: 'arcRail',
} as const;

// The section a session heading names itself by for the editor's own context menu, so a
// session can be archived from the heading its turns are drawn under.
//
// The heading used to carry a cross of its own at the right-hand end. It was faint enough
// to be missed and close enough to the title to be pressed by mistake, and archiving is a
// rail action: the rail's own card carries the control, and the heading now only has to
// answer the reader who is below the rail's width, where no rail is drawn at all.
//
// Two names, for the two states a session can be in, so the menu offers the one it has
// not already taken. Both are reachable here: `hideSessions` exempts the session being
// shown, so archiving it leaves the heading and its turns on screen.
export { SESSION_MENU_SECTIONS } from './view/card-menu';

// The status a session wears on its rail card, so a glance says which sessions are
// running, finished or failed without opening any. Two things answer, and they answer in this
// order: an agent working in the session now, then the newest turn on the cards. A closed
// turn then yields to the background children it left at work, as `subagents`.
//
// The cards alone cannot say. They come off the transcript, so a session reads as
// running only once its agent has written the prompt to disk and the panel has parsed it,
// which is seconds behind the press. A compaction never gets there at all: it writes no turn,
// so the rail said the session had finished for the whole of one.
//
// The honesty rule is about what the cards can support, and it still holds over them: only a
// turn answers, a compaction has no status of its own, and a session whose cards say
// nothing wears nothing rather than a guess. A busy child is not a guess. It is the same
// claim the composer's own Stop is drawn from, it is true of a session outside the
// parsed window as much as one inside it, and that is the session a reader can least
// afford the rail to stay quiet about.
//
// It is not proof either, and `busySince` is what bounds it. Every record answer ages out
// through TURN_QUIET_MS, and a busy child used to answer for as long as the child lived. One
// lost ending was enough: the turn stayed in the session's open set, the child called itself
// busy for the rest of the window, and the rail wore `running` over sessions whose
// transcripts had said `done` for hours. So a claim is dropped once the record has caught up
// past the press it was made for. The record must both close the turn and close it after the
// child became busy, which is the case the transcript's lag cannot produce: while the panel
// waits for a press to reach disk, the newest closed turn is the one before it.
export function sessionStatusOf(
  cards: {
    sessionId: string;
    kind: string;
    startedAt?: number;
    endedAt?: number;
    processEndedAt?: number;
    status?: TurnStatus;
  }[],
  running: ReadonlySet<string> = new Set(),
  outcomes: ReadonlyMap<string, TurnOutcome | null> = new Map(),
  now: number = Date.now(),
  waiting: ReadonlySet<string> = new Set(),
  // When each busy child began the work it is busy with, by session. A session with
  // no entry keeps its claim unbounded, which is what a caller that cannot say means.
  busySince: ReadonlyMap<string, number> = new Map(),
  // How many background children each session still has at work, from `liveOpenChildCounts`.
  // A session whose newest turn closed and that no busy claim calls running wears
  // `subagents` while its count is above zero.
  openChildren: ReadonlyMap<string, number> = new Map(),
  // How many background commands each session still waits on, from `liveBackgroundCommands`.
  // A session whose newest turn closed wears `background` while its count is above zero.
  backgroundCommands: ReadonlyMap<string, number> = new Map(),
): Map<string, RailStatus> {
  const newest = new Map<string, { at: number; closedAt: number; status: TurnStatus }>();
  for (const c of cards) {
    if (c.kind !== 'turn' || c.status === undefined || c.startedAt === undefined) {
      continue;
    }
    const held = newest.get(c.sessionId);
    if (!held || c.startedAt > held.at) {
      newest.set(c.sessionId, {
        at: c.startedAt,
        closedAt: c.processEndedAt ?? c.endedAt ?? 0,
        status: c.status,
      });
    }
  }
  const out = new Map<string, RailStatus>();
  // When the record says the session's newest turn closed, for the bound below. Written
  // in the same order the statuses are, so the record that answers the bound is the record
  // that answered the word.
  const closed = new Map<string, number>();
  for (const [id, outcome] of outcomes) {
    if (!outcome) {
      continue;
    }
    const status = statusOf(outcome, true, now);
    out.set(id, status);
    const closedAt = outcome.processEndedAt ?? outcome.endedAt;
    if (status !== 'running' && closedAt > 0) {
      closed.set(id, closedAt);
    }
  }
  for (const [id, held] of newest) {
    out.set(id, held.status);
    if (held.status !== 'running' && held.closedAt > 0) {
      closed.set(id, held.closedAt);
    } else {
      closed.delete(id);
    }
  }
  for (const id of running) {
    const since = busySince.get(id);
    const settled = closed.get(id);
    if (since !== undefined && settled !== undefined && settled > since) {
      continue;
    }
    out.set(id, 'running');
  }
  // The main agent is idle and its background children still work, so the session is not
  // finished. A closed turn yields to them. Running and needs input do not, as the first
  // is already a busy word and the second is the action the reader can take now.
  for (const [id, count] of openChildren) {
    const status = out.get(id);
    if (count > 0 && status !== undefined && childrenOutliveTurn(status)) {
      out.set(id, 'subagents');
    }
  }
  // A command the agent started in the background wakes the agent when it ends, so the session
  // waits on it and is not finished. Subagents win, because a subagent is work in progress and
  // a command is a wait. A session already worded `subagents` fails `childrenOutliveTurn`.
  for (const [id, count] of backgroundCommands) {
    const status = out.get(id);
    if (count > 0 && status !== undefined && childrenOutliveTurn(status)) {
      out.set(id, 'background');
    }
  }
  // Waiting wins over running because it is the action the reader can take now. The child
  // remains busy while its request is open, so the opposite order would hide this state.
  for (const id of waiting) {
    out.set(id, 'waiting');
  }
  return out;
}

// A finished child writes its last transcript record a short while after the parent records
// the close, because the two writers finish independently. This margin keeps that trailing
// write from reopening the child, while a real resume clears it by writing seconds or minutes
// later.
export const CHILD_CLOSE_MARGIN_MS = 1000;

// Which of each session's background children are alive, by session, in launch order. An
// open child remains alive while its transcript is fresh. A closed child becomes alive again
// when its transcript was written more than CHILD_CLOSE_MARGIN_MS after its close time and
// remains fresh. A legacy close with no time stays closed. TURN_QUIET_MS ages out open and
// resumed children alike.
//
// Two records end every child at once. A recorded process end means the process that held
// them is gone. A host process that Arc started and that exited after the newest turn began
// is the same fact, told by the host rather than the transcript. A child whose write time is
// unknown is not counted, so the count can only be low.
export function liveOpenChildren(
  outcomes: ReadonlyMap<string, TurnOutcome | null>,
  writtenAt: (session: string, child: string) => number | undefined,
  // When the host process of each session that Arc hosts exited, by session.
  hostExitedAt: ReadonlyMap<string, number>,
  now: number,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [id, outcome] of outcomes) {
    if (!outcome || outcome.processEndedAt !== undefined) {
      continue;
    }
    const exited = hostExitedAt.get(id);
    if (exited !== undefined && exited >= (outcome.startedAt ?? 0)) {
      continue;
    }
    const closed = outcome.closedChildren ?? [];
    const closedIds = new Set(closed.map((child) => (typeof child === 'string' ? child : child.id)));
    const reopened = closed.flatMap((child) => {
      if (typeof child === 'string') {
        return [];
      }
      const at = writtenAt(id, child.id);
      return at !== undefined && at > child.closedAt + CHILD_CLOSE_MARGIN_MS ? [child.id] : [];
    });
    const candidates = [...(outcome.openChildren ?? []).filter((child) => !closedIds.has(child)), ...reopened];
    const live = [...new Set(candidates)].filter((child) => {
      const at = writtenAt(id, child);
      return at !== undefined && now - at <= TURN_QUIET_MS;
    });
    if (live.length > 0) {
      out.set(id, live);
    }
  }
  return out;
}

// How long a background command keeps its session in the `background` state when no end
// record arrives. A terminal that closes kills its command and writes no end record, so the
// state needs a bound, and the rail reads it on the clock alone.
export const BACKGROUND_COMMAND_CAP_MS = 60 * 60 * 1000;

// How many background commands each session still waits on, by session. A command counts
// from its launch until its end record, and for BACKGROUND_COMMAND_CAP_MS at most. A recorded
// process end, or an exit of a host process Arc started after the newest turn began, ends
// every command, as it ends every background child.
export function liveBackgroundCommands(
  outcomes: ReadonlyMap<string, TurnOutcome | null>,
  hostExitedAt: ReadonlyMap<string, number>,
  now: number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, outcome] of outcomes) {
    if (!outcome?.backgroundCommands || outcome.processEndedAt !== undefined) {
      continue;
    }
    const exited = hostExitedAt.get(id);
    if (exited !== undefined && exited >= (outcome.startedAt ?? 0)) {
      continue;
    }
    const count = outcome.backgroundCommands.filter(
      (command) => command.startedAt > 0 && now - command.startedAt < BACKGROUND_COMMAND_CAP_MS,
    ).length;
    if (count > 0) {
      out.set(id, count);
    }
  }
  return out;
}

// How many live open children each session has, from `liveOpenChildren`.
export function openChildCounts(live: ReadonlyMap<string, readonly string[]>): Map<string, number> {
  return new Map([...live].map(([id, children]) => [id, children.length]));
}

export function liveOpenChildCounts(...input: Parameters<typeof liveOpenChildren>): Map<string, number> {
  return openChildCounts(liveOpenChildren(...input));
}

// One spelling of the live open children and the live background command counts, so the
// refresh can tell whether a child went quiet or a command reached its cap since the cards
// were built. Neither change moves a file.
export function openChildrenKey(
  live: ReadonlyMap<string, readonly string[]>,
  commands: ReadonlyMap<string, number> = new Map(),
): string {
  const sorted = <T>(entries: ReadonlyMap<string, T>) => [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(commands.size ? [sorted(live), sorted(commands)] : sorted(live));
}

// The tail outcome with the open children two wider reads hold. The tail read sees only the
// end of the transcript, so a launch before it is missing there. The lifetime facts read the
// whole file, and the parsed window reads the turns the timeline holds. Each adds its open
// children only when it describes the same newest turn up to the same last record, so a read
// that lags behind the tail cannot bring back a closed child. A child that any of the three
// reads closed stays closed. The reads match a completion notice to its child in different
// ways, so one read can miss a notice that another read saw.
//
// `tailCommands` are the background commands a tail read found with no typed prompt in it. The
// wider outcome of that same turn carries them, because no other read records commands.
export function outcomeWithWiderChildren(
  tail: TurnOutcome | null,
  lifetime: TurnOutcome | null,
  parsed: TurnOutcome | null = null,
  tailCommands: readonly BackgroundCommand[] = [],
): TurnOutcome | null {
  const merged = mergedWiderChildren(tail, lifetime, parsed);
  return merged && tailCommands.length > 0 && !merged.backgroundCommands
    ? { ...merged, backgroundCommands: [...tailCommands] }
    : merged;
}

function mergedWiderChildren(
  tail: TurnOutcome | null,
  lifetime: TurnOutcome | null,
  parsed: TurnOutcome | null,
): TurnOutcome | null {
  if (!tail) {
    return lifetime;
  }
  if (tail.processEndedAt !== undefined) {
    return tail;
  }
  const held = tail.openChildren ?? [];
  const wider = [lifetime, parsed].flatMap((outcome) =>
    outcome?.openChildren?.length && outcome.startedAt === tail.startedAt && outcome.endedAt === tail.endedAt
      ? outcome.openChildren
      : [],
  );
  const closedById = new Map<string, ClosedChild>();
  for (const child of [tail, lifetime, parsed].flatMap((outcome) => outcome?.closedChildren ?? [])) {
    const id = typeof child === 'string' ? child : child.id;
    const previous = closedById.get(id);
    if (previous === undefined) {
      closedById.set(id, child);
      continue;
    }
    if (typeof previous === 'string' || typeof child === 'string') {
      closedById.set(id, id);
    } else if (child.closedAt > previous.closedAt) {
      closedById.set(id, child);
    }
  }
  const closedChildren = [...closedById.values()];
  const closedIds = new Set(closedChildren.map((child) => (typeof child === 'string' ? child : child.id)));
  const openChildren = [...new Set([...wider, ...held])].filter((id) => !closedIds.has(id));
  const tailClosed = tail.closedChildren ?? [];
  const sameClosed =
    closedChildren.length === tailClosed.length &&
    closedChildren.every((child, index) => {
      const previous = tailClosed[index];
      return typeof child === 'string' || typeof previous === 'string'
        ? child === previous
        : child.id === previous.id && child.closedAt === previous.closedAt;
    });
  if (sameClosed && openChildren.length === held.length && openChildren.every((id) => held.includes(id))) {
    return tail;
  }
  const merged: TurnOutcome = { ...tail, openChildren, closedChildren };
  if (!openChildren.length) {
    delete merged.openChildren;
  }
  if (!closedChildren.length) {
    delete merged.closedChildren;
  }
  return merged;
}

// The key that joins a child's write time to its parent session. The child id is the
// `agentId` a background launch result names, which is also the id child discovery reads
// off that result.
export function childWriteKey(session: string, child: string): string {
  return `${session}\n${child}`;
}

// The newest known write time of each Claude child, under `childWriteKey`. A discovered child
// carries its own stat. A referenced child outside the open folders has only the write time
// its revision last read.
export function claudeChildWriteIndex(
  children: readonly { parentSessionId: string; sessionId: string; mtimeMs: number }[],
  references: readonly { parentSessionId: string; sessionId: string; file: string }[],
  statWrites: ReadonlyMap<string, number>,
): Map<string, number> {
  const out = new Map<string, number>();
  const note = (key: string, at: number): void => {
    if (Number.isFinite(at) && at > (out.get(key) ?? -Infinity)) {
      out.set(key, at);
    }
  };
  for (const child of children) {
    note(childWriteKey(child.parentSessionId, child.sessionId), child.mtimeMs);
  }
  for (const reference of references) {
    const at = statWrites.get(reference.file);
    if (at !== undefined) {
      note(childWriteKey(reference.parentSessionId, reference.sessionId), at);
    }
  }
  return out;
}

// How a session came to be started by another: a shell command in the other session
// dispatched it, or the other session's agent started it as a subagent.
export type SessionParentRelation = 'dispatched' | 'subagent';

// The session that started a session, and how. `owned` is set on a dispatched edge whose
// launch recorded that the reader asked for the session.
export interface SessionParentEdge {
  parent: string;
  relation: SessionParentRelation;
  owned?: true;
}

// The session that started each session, as child id to edge. A dispatched Claude session, a
// Claude subagent and a Codex subagent each open as a session with a heading of their own,
// and the heading names the session that started it.
//
// A dispatch claims from its reference. A Claude subagent claims from its resolved child
// file, never from the reference that named it: a forked parent transcript repeats the
// `Agent` result of the session it forked from, and that reference names a file that never
// resolves. A Codex background review has no session row, so it has no entry here.
//
// Two claims from one parent by one relation, such as two tool results naming one launch,
// are one parent. The edge is owned when either claim is, because a second tool result that
// names the same launch without a receipt does not take back what the receipt recorded. A
// child that two distinct parents claim, or one parent claims by two relations, has no parent
// here, the way `resolveClaudeDispatchReferences` drops a prefix that two sessions match.
export function sessionParentIndex(
  references: readonly { kind?: string; parentSessionId: string; sessionId: string; owned?: boolean }[],
  claudeChildren: readonly { sessionId: string; parentSessionId: string }[] = [],
  codexChildren: readonly { threadId: string; parentThreadId: string | null; backgroundReview: boolean }[] = [],
): Map<string, SessionParentEdge> {
  const claimed = new Map<string, SessionParentEdge | null>();
  const claim = (child: string, parent: string, relation: SessionParentRelation, owned = false): void => {
    if (child === parent) {
      return;
    }
    const held = claimed.get(child);
    if (held === undefined) {
      claimed.set(child, owned ? { parent, relation, owned } : { parent, relation });
    } else if (held !== null && (held.parent !== parent || held.relation !== relation)) {
      claimed.set(child, null);
    } else if (held !== null && owned && !held.owned) {
      claimed.set(child, { ...held, owned });
    }
  };
  for (const reference of references) {
    if (reference.kind === 'dispatch') {
      claim(reference.sessionId, reference.parentSessionId, 'dispatched', reference.owned === true);
    }
  }
  for (const child of claudeChildren) {
    claim(child.sessionId, child.parentSessionId, 'subagent');
  }
  for (const child of codexChildren) {
    if (child.parentThreadId !== null && !child.backgroundReview) {
      claim(child.threadId, child.parentThreadId, 'subagent');
    }
  }
  const parents = new Map<string, SessionParentEdge>();
  for (const [child, edge] of claimed) {
    if (edge !== null) {
      parents.set(child, edge);
    }
  }
  return parents;
}

// The edges of the index above whose child and parent both have a session row. An edge with
// either end missing changes no heading and no rail card, so the heading, the Run by agents
// filing, the refresh key and the parent's lifetime cost all read this one set, and an edge
// that moves one of them moves the key too.
export function sessionParentEdgesAmong(
  parents: ReadonlyMap<string, SessionParentEdge>,
  rows: ReadonlySet<string>,
): Map<string, SessionParentEdge> {
  const edges = new Map<string, SessionParentEdge>();
  for (const [child, edge] of parents) {
    if (rows.has(child) && rows.has(edge.parent)) {
      edges.set(child, edge);
    }
  }
  return edges;
}

// The dispatched edges alone, as child id to parent id. A dispatched session joins its parent's
// lifetime cost from these, and files under Run by agents unless the reader owns it. A
// subagent's own transcript already files it as a run, and its file already counts in its
// parent's delegated work, so a subagent edge must reach neither.
export function dispatchedParents(edges: ReadonlyMap<string, SessionParentEdge>): Map<string, string> {
  const parents = new Map<string, string>();
  for (const [child, edge] of edges) {
    if (edge.relation === 'dispatched') {
      parents.set(child, edge.parent);
    }
  }
  return parents;
}

// The edges above as one string, for the refresh signature. The worker hands the host a new
// reference list on every catalog walk, so the list's identity says nothing about whether a
// heading changed. Sorted, because the worker's order is not a fact the panel draws.
export function sessionParentsKey(edges: ReadonlyMap<string, SessionParentEdge>): string {
  return [...edges]
    .map(([child, edge]) => `${child}>${edge.parent}:${edge.relation}${edge.owned ? ':owned' : ''}`)
    .sort()
    .join(',');
}

// The edges among one catalog, the dispatched part of them, and their key, built together.
// `rows` holds the catalog's ids, or null when the index is empty and the rows cannot change
// the answer. Each id maps to the pass that last saw it, which `sameIdSet` writes.
export interface SessionParentEdgeSet {
  parents: ReadonlyMap<string, SessionParentEdge>;
  rows: Map<string, number> | null;
  edges: ReadonlyMap<string, SessionParentEdge>;
  dispatched: ReadonlyMap<string, string>;
  key: string;
}

// The set above for `parents` over `sessions`, reusing `held` when neither moved. A selection
// renders the catalog it last walked, so it pays one pass over the ids and no new set, sort or
// join. The render, the spend sources and the search each hand over the catalog in their own
// order, so the ids are compared as a set: the edges read only which ids have a row.
export function sessionParentEdgeSet(
  held: SessionParentEdgeSet | null | undefined,
  parents: ReadonlyMap<string, SessionParentEdge>,
  sessions: readonly { sessionId: string }[],
): SessionParentEdgeSet {
  if (held && held.parents === parents && (held.rows === null || sameIdSet(held.rows, sessions))) {
    return held;
  }
  if (!parents.size) {
    return { parents, rows: null, edges: parents, dispatched: new Map(), key: '' };
  }
  const ids = new Set(sessions.map((session) => session.sessionId));
  const edges = sessionParentEdgesAmong(parents, ids);
  return {
    parents,
    rows: new Map([...ids].map((id) => [id, 0])),
    edges,
    dispatched: dispatchedParents(edges),
    key: sessionParentsKey(edges),
  };
}

let idSetPass = 0;

// Whether `sessions` holds exactly the ids in `rows`, in any order and with any repeats. Each
// pass stamps the ids it meets, so an id met twice counts once without a set of its own.
function sameIdSet(rows: Map<string, number>, sessions: readonly { sessionId: string }[]): boolean {
  const pass = ++idSetPass;
  let distinct = 0;
  for (const session of sessions) {
    const seen = rows.get(session.sessionId);
    if (seen === undefined) {
      return false;
    }
    if (seen !== pass) {
      rows.set(session.sessionId, pass);
      distinct++;
    }
  }
  return distinct === rows.size;
}

// The session a heading names as the one that started it, and how it started this one.
export interface SessionParent {
  id: string;
  label: string;
  relation: SessionParentRelation;
}

// The parent of one session: its id, the label the parent's own row draws, and the relation.
// Only the heading of the shown session draws it, so the host asks for that row alone and
// the payload stays flat in the number of children. A parent with no row gets none, because
// a selection of an id the workspace lacks falls to the newest session, and a press that
// opens the wrong session is worse than none.
export function sessionParentOf(
  rows: readonly { id: string; label: string }[],
  edges: ReadonlyMap<string, SessionParentEdge>,
  id: string | null,
): SessionParent | undefined {
  const edge = id === null ? undefined : edges.get(id);
  if (!edge) {
    return undefined;
  }
  const parent = rows.find((row) => row.id === edge.parent);
  return parent ? { id: parent.id, label: parent.label, relation: edge.relation } : undefined;
}

// The write time in a `spendFileVersion` revision, which reads `size:mtime`, or null for a
// file that is missing or not a file.
export function writeTimeOfVersion(version: string): number | null {
  const parts = version.split(':');
  if (parts.length !== 2) {
    return null;
  }
  const at = Number(parts[1]);
  return parts[1] !== '' && Number.isFinite(at) ? at : null;
}

// Record the hosted sessions whose process has exited, from the host's full list of exited
// keys. A key that was not exited on the previous call exited now, and its time replaces any
// older exit, so a session that was resumed and exited again reads its latest exit. A key
// that stays exited keeps its time. Answers the keys exited now, for the next call, and
// whether any exit time moved.
export function recordExits(
  exitedAt: Map<string, number>,
  wasExited: ReadonlySet<string>,
  keys: readonly string[],
  now: number,
): { exited: Set<string>; moved: boolean } {
  const exited = new Set(keys);
  let moved = false;
  for (const key of exited) {
    if (!wasExited.has(key)) {
      exitedAt.set(key, now);
      moved = true;
    }
  }
  return { exited, moved };
}

export function sessionRunningSince(
  cards: { sessionId: string; kind: string; startedAt?: number; status?: TurnStatus }[],
  running: ReadonlySet<string> = new Set(),
  outcomes: ReadonlyMap<string, TurnOutcome | null> = new Map(),
  now: number = Date.now(),
  waiting: ReadonlySet<string> = new Set(),
  busySince: ReadonlyMap<string, number> = new Map(),
): Map<string, number> {
  const statuses = sessionStatusOf(cards, running, outcomes, now, waiting, busySince);
  const starts = new Map<string, number>();
  const remember = (id: string, at: number | undefined): void => {
    if (statuses.get(id) !== 'running' || at === undefined || !Number.isFinite(at) || at <= 0) {
      return;
    }
    const prior = starts.get(id);
    if (prior === undefined || at < prior) {
      starts.set(id, at);
    }
  };
  for (const card of cards) {
    if (card.kind === 'turn' && card.status === 'running') {
      remember(card.sessionId, card.startedAt);
    }
  }
  for (const [id, outcome] of outcomes) {
    if (outcome && statusOf(outcome, true, now) === 'running') {
      remember(id, outcome.startedAt);
    }
  }
  for (const [id, at] of busySince) {
    if (running.has(id)) {
      remember(id, at);
    }
  }
  return starts;
}

// The unread badge's wording, for the rail card and the main session heading alike: one
// copy, or the two views could say different things about one session. Null both for zero
// and for no count at all; which silence it was is worded in the accessible name, from
// CARD_ACTIONS.sessionNothingNew, only where the count is known.
//
// A floor is said in words, not in a mark. `12+` is read out as "twelve plus" only by luck,
// and the badge is the one thing on a rail card a reader without a pointer has to be told.
// A floor of zero cannot happen, because a count of zero means every turn in the window was
// read and a read turn is what makes the figure a total; it is guarded anyway, so a wording
// this cannot produce cannot be produced by a caller either.
export function newIndicator(entry: NewCount | undefined): string | null {
  if (!entry || !entry.count) {
    return null;
  }
  return entry.atLeast ? `at least ${entry.count} new` : `${entry.count} new`;
}

export interface RailDraftRow {
  draftId: string;
  createdAt: number;
  agent: string;
  agentKey: AgentKind;
}

// Drafts have no transcript yet, but they are still sessions the reader can return to.
// Add them before the rail decides whether there is a chooser, without pretending a file or
// a parsed turn exists for them.
export function syntheticDraftRows(drafts: readonly RailDraftRow[]): (RailDraftRow & {
  id: string;
  persisted: false;
  label: string;
  when: string;
  at: number;
  relative: string;
  shown: boolean;
  fullLabel: string;
  agentRun: boolean;
})[] {
  return drafts.map((draft) => ({
    ...draft,
    id: draft.draftId,
    persisted: false,
    label: 'New session',
    fullLabel: 'New session',
    when: formatWhen(draft.createdAt),
    at: draft.createdAt,
    relative: 'now',
    shown: false,
    agentRun: false,
  }));
}

// Whether another agent ran a session, out of the guess read from its transcript and
// the sessions this window started itself.
//
// `agentRunIn` in transcript.ts reads the absence of a person, because a Claude transcript
// names nobody as the one who started it. A panel session whose prompts carry no human origin
// wears that same absence: one prompt and no question asked, and outside an SDK-only
// transcript also a first turn that finished and no file changed. So the reader started a
// session and the rail filed it under Run by agents. The window that started it holds the
// one positive fact the record never carries, and that fact outranks the guess.
// `syntheticDraftRows` above says the same thing for the stage before the session has an id
// at all.
//
// Only the window that started it can answer this way. Another window reads the transcript,
// where the guess is all there is.
//
// A child transcript is always an agent run: the parent's `Agent` call that started it is a
// positive fact, and it outranks the guessed reading and any cached answer that disagrees.
// A dispatched session is one too: the parent's shell command that started it is the same
// kind of fact, read from the dispatched edges. A session this window started stays the
// reader's even when a dispatch edge names it, because an opted-in wrapper's receipt can name
// any session.
//
// `readerOwned` is the positive fact the other way, for a dispatched session alone: its
// launch recorded that the reader asked for it, or a person spoke in its transcript. It
// outranks the transcript's guess the way `startedHere` does, because a `claude --bg` session
// whose one turn finished with no sign of a person still guesses as a run.
export function agentRunAnswer(
  guessed: boolean,
  sessionId: string,
  startedHere: ReadonlySet<string>,
  childTranscript: boolean,
  dispatched: boolean,
  readerOwned = false,
): boolean {
  if (childTranscript) {
    return true;
  }
  if (startedHere.has(sessionId) || (dispatched && readerOwned)) {
    return false;
  }
  return dispatched || guessed;
}

// The card's complete accessible name. `view/rail.ts` owns the wording, `webview/rail.ts`
// draws it with the two clauses the browser's own clock moves, and the wording rules here
// are read through the same function with neither clause.
export { railCardName } from './view/rail.ts';

// The rail's cards: which sessions, in what order, saying what.
//
// The pinned-to-top sessions come first in the sessions list's own order, and the
// rest follow in that same order. The host hands this function a list whose running and
// inactive runs are already stable, so a pinned session that starts running rises
// above inactive pinned sessions without disturbing the running sessions already
// there. Archived sessions come last, flagged rather than dropped, so the Archived
// bucket has cards to hold. Fewer than two live cards is no rail at all: a rail naming one
// session duplicates the heading drawn beside it, and an archive of forty behind a
// fold does not make a chooser out of it.
//
// The shown session is not exempt here, and it is exempt in `hideSessions`. The two
// answer different questions on purpose. This one decides what the rail draws, and a
// reader who archives the session they are reading means the card to go. That one
// decides what is parsed, and the turns stay on screen: archiving is a view, and it must
// not empty the list the reader is looking at.
export function railSessions(
  sessions: {
    id: string;
    persisted?: boolean;
    label: string;
    // The rail card's own drawn name, where it differs from `label`. Falls back to `label`
    // when absent, so a caller with no wide-name source still draws the short form it has.
    railName?: string;
    agent: string;
    when: string;
    at: number;
    relative: string;
    agentRun?: boolean;
  }[],
  counts: ReadonlyMap<string, NewCount>,
  newest: ReadonlyMap<string, number>,
  statuses: ReadonlyMap<string, RailStatus>,
  hidden: ReadonlySet<string>,
  pinned: string | null,
  pinnedTop: ReadonlySet<string>,
  unsent: ReadonlyMap<string, UnsentInput>,
  statsById: Readonly<Record<string, readonly SessionStatChip[]>>,
  // Every session's labels, by session id, whole rather than already cut. The card
  // words its name from all of them and draws the first few. One list feeds both, which is
  // what keeps the two from disagreeing about what the session carries.
  //
  // Required rather than optional, for the reason `statsBySession` gives about its
  // compactions. An optional record would default to empty at the one caller that has one.
  // Every card in the panel would then read as unlabelled, with no test able to see it.
  labelsById: Readonly<Record<string, readonly string[]>>,
  cacheById: Readonly<Record<string, RailCacheMark | null>> = {},
  costById: Readonly<Record<string, SessionCostTotal>> = {},
  runningSinceById: ReadonlyMap<string, number> = new Map(),
  now: number = Date.now(),
  // The live open-child counts `sessionStatusOf` read, by session.
  openChildrenById: ReadonlyMap<string, number> = new Map(),
  // The live background command counts `sessionStatusOf` read, by session.
  commandsById: ReadonlyMap<string, number> = new Map(),
  // The exact cache-expiry return count from lifetime indexed facts, by session, paired with
  // whether it is a floor. Absent or null where the source cannot answer.
  cacheExpiryById: Readonly<Record<string, CacheExpiryCountFact | null>> = {},
): RailCard[] {
  const out: RailCard[] = [];
  for (const s of sessions) {
    const archived = hidden.has(s.id);
    const entry = counts.get(s.id);
    const count = entry?.count;
    const indicator = newIndicator(entry);
    // The unread marks read the same count the indicator words, so a card cannot show a
    // dot beside a name that says nothing new.
    const newCount = count === undefined || count === 0 ? null : count;
    const unread = newCount !== null;
    const current = s.id === pinned;
    // Archiving wins over pinning wherever the two collide, which is the rule the panel's
    // own hide already follows by unpinning. Read here as well, because stored state can
    // hold a session as both, and a card that arrived pinned and archived would take
    // the rail's top from inside a folded bucket.
    const onTop = pinnedTop.has(s.id) && !archived;
    // Archiving and pinning are the reader's own word about a session, so both
    // outrank a guess about who started it. An archived run stays in the Archived bucket
    // and a pinned one keeps the top, and only a pinned one draws the phrase, because it
    // is the only marked card that sits under no heading saying so.
    const agentRun = s.agentRun === true && !archived;
    const runByAgent = s.agentRun === true;
    const status = statuses.get(s.id) ?? null;
    const runningSince = status === 'running' ? (runningSinceById.get(s.id) ?? null) : null;
    const runningSinceWhen = runningSince === null ? null : formatWhen(runningSince, now);
    const subagents = status === 'subagents' ? (openChildrenById.get(s.id) ?? null) : null;
    const commands = status === 'background' ? (commandsById.get(s.id) ?? null) : null;
    const unsentName = unsentInputName(unsent.get(s.id));
    const unsentWord = unsentName ? 'unsent' : null;
    // The figures this card draws, taken from the heading record the message already
    // carries. They name the card and they answer its cost, and the panel runs the same
    // projection over the same record when it draws the row.
    const stats = railStatChips(statsById[s.id] ?? []);
    // The raw total travels independently from the optional visible chip. An exact zero has
    // a recorded cost but no chip, while a session with no priced usage has neither.
    const costChip = stats.find((chip) => chip.metric === 'cost');
    const rawCost = costById[s.id];
    const costDollars = rawCost?.dollars ?? costChip?.dollars ?? null;
    // A missing total is never a floor. Where a chip exists, its `+` says the same fact.
    const costAtLeast = costDollars !== null && (rawCost?.partial ?? costChip?.partial);
    // Read straight off the lifetime index, the same source `costById` reads, and never off a
    // filtered stat chip: `railStatChips` drops the cache-expiry metric from the drawn row, but
    // the filter still needs the exact count underneath it.
    const cacheExpiryFact = cacheExpiryById[s.id] ?? null;
    const cacheExpiryCount = cacheExpiryFact?.count ?? null;
    // A missing count is never a floor, the same way a missing cost is not.
    const cacheExpiryAtLeast = cacheExpiryCount !== null && cacheExpiryFact?.atLeast === true;
    const statNames = stats.map((stat) =>
      stat.metric === 'cost'
        ? `whole session cost ${stat.compactLabel}${stat.partialDetail ? `, ${stat.partialDetail.replace(/\.$/, '')}` : ''}${stat.warnings?.length ? `, ${stat.warnings.map(cacheWriteWarningCondition).join(', ')}` : ''}`
        : stat.metric === 'turns'
          ? stat.compactLabel
          : `current context ${stat.compactLabel}`,
    );
    // The row and the name are read off one list. The row takes the front of it and counts
    // what it left. The name says all of it, because a reader who cannot see the chips hears
    // the folded ones nowhere else.
    //
    // The clause closes the name, because it is the only one of them that is a list. The
    // name is joined on commas, so a clause after it is read as one more label, and the
    // reader goes looking for a label called "showing now".
    // Named for the clause and not for the label, because `turnlabels.ts` exports a
    // `labelName` of its own and `turnview.ts` re-exports it. A local of that name here
    // shadows it everywhere in this file, and the day an import reaches for it the error
    // lands on a line that has nothing to do with the change that caused it.
    const { labelClause, ...labelFields } = railLabelFields(labelsOf(labelsById, s.id), CARD_ACTIONS.railLabelled);
    // The relative wording goes into the name; the panel words the drawn time from the
    // timestamp itself, and the clock time rides on the hover. The status is said as a
    // word here, through the same table every head row reads.
    const statusName =
      status === 'waiting'
        ? NEEDS_INPUT
        : status === 'subagents'
          ? subagentsStillRunning(subagents ?? 0)
          : status === 'background'
            ? backgroundCommandsStillRunning(commands ?? 0)
            : status
              ? STATUS_WORDS[status]
              : null;
    const cache = cacheById[s.id] ?? null;
    const cardName = s.railName ?? s.label;
    // The name itself is left out here: `railCardName` prepends `card.name` (or `label`
    // where it is absent) when it composes the accessible name, so this string carries only
    // the clauses that follow the name, and the wire never carries the name twice.
    // `unsentName` is left out too, for the same reason: it already rides its own field below,
    // and `railCardName` appends it after this clause. Folded in here, it turned this whole
    // string into one of a handful of phrases repeated across every session sharing an agent,
    // a status, and an unsent state, so the same text rode the wire once per matching session
    // instead of once per distinct phrase.
    const nameBeforeAge = [
      archived ? 'archived' : null,
      onTop ? 'pinned' : null,
      agentRun ? CARD_ACTIONS.agentRun : null,
      s.agent,
      runningSince === null && status !== 'subagents' && status !== 'background' ? statusName : null,
    ]
      .filter(Boolean)
      .join(', ');
    const nameAfterAge = [
      ...statNames,
      current ? 'showing now' : null,
      indicator ?? (count === 0 ? CARD_ACTIONS.sessionNothingNew : null),
      labelClause,
    ]
      .filter(Boolean)
      .join(', ');
    // The newest parsed turn's start, and which read entry the card's own context menu
    // offers. One fact decides both, because both answer whether the session was
    // parsed: a card that offered the entry with no timestamp behind it would be a press
    // that marks nothing, and one that carried a timestamp behind no entry would be a mark
    // nobody can reach. So the section is derived from the timestamp rather than from a
    // second lookup, and a card with no timestamp names the plain section, which offers the
    // labels every session can carry and no entry that reads a turn.
    const newestTurnAt = newest.get(s.id) ?? null;
    const menuSection =
      newestTurnAt === null ? RAIL_MENU_SECTIONS.plain : unread ? RAIL_MENU_SECTIONS.unread : RAIL_MENU_SECTIONS.read;
    // The phrase is drawn only where no heading says it, which after the ordering below
    // means a pinned run and nothing else. Inside its own bucket the heading has said it
    // once for every card under it, and repeating it per card would spend the agent's
    // name to say a thing the reader has already read.
    const agentWord = agentRun && onTop ? CARD_ACTIONS.agentRun : s.agent;
    out.push({
      id: s.id,
      persisted: s.persisted === true,
      label: s.label,
      ...(cardName === s.label ? {} : { name: cardName }),
      agent: s.agent,
      agentRun,
      runByAgent,
      agentWord,
      relative: s.relative,
      at: s.at,
      absolute: s.when,
      current,
      pinnedTop: onTop,
      archived,
      status,
      subagents,
      commands,
      runningSince,
      runningSinceWhen,
      cache,
      nameBeforeAge,
      nameAfterAge,
      unsentWord,
      unsentName,
      costDollars,
      costAtLeast,
      cacheExpiryCount,
      cacheExpiryAtLeast,
      ...labelFields,
      indicator,
      newCount,
      unread,
      newestTurnAt,
      menuSection,
    });
  }
  // The archived ones come last, whatever their age, because the bucket that holds them
  // sits under every other bucket. An empty result is still meaningful to the browser:
  // at wide widths the rail remains the navigation structure around this row list.
  const live = out.filter((c) => !c.archived);
  const archived = out.filter((c) => c.archived);
  const ordered = [...live.filter((c) => c.pinnedTop), ...live.filter((c) => !c.pinnedTop), ...archived];
  return ordered;
}
