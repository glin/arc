// Projects the session list, its statuses, cache marks, labels, and parent relationships.
// `turnview.ts` re-exports these helpers for existing callers.

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
  waitShareCondition,
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
import {
  CACHE_LIFETIME_MS,
  CONSERVATIVE_CACHE_BOUNDARY_MS,
  cacheLifetimeFor,
  nextTurnFloor,
  type CacheTier,
} from './pricing';
export {
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
  // The lifetime the cache was bought for, which the bolt's tooltip and the card's accessible name word.
  tier?: CacheTier | null;
}

export interface RevisionedRailCacheMark {
  mark: RailCacheMark | null;
  mtimeMs: number;
  size: number;
}

export const RAIL_CACHE_NEARLY_GONE_MIN_MS = 3 * 60_000;

// Provides session cache facts before full selected parsing.
// The shared request and pricing lookup supplies the browser's decorative cache-mark clock boundaries.
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
  // A new turn has no request before its first response, so the mark keeps the previous request until then.
  // A failed turn ends the walk, because the cache state after a failure is unknown.
  let newest: RailCacheFacts['turns'][number] | null = null;
  for (const turn of [...facts.turns].sort((a, b) => b.startedAt - a.startedAt)) {
    if (turn.error) {
      return null;
    }
    if (turn.contextRequest && turn.contextTokens) {
      newest = turn;
      break;
    }
  }
  const request = newest?.contextRequest;
  if (!newest || !request) {
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
    tier: lifetimeTier,
  };
}

// The transcript revision whose read found a session list cache mark.
export type RailCacheRevision = Pick<RevisionedRailCacheMark, 'mtimeMs' | 'size'>;

// Orders revisions by mtime, with size as the tie-break for equal mtimes.
// A replaced transcript can be shorter than the one it replaced, so size alone cannot order two reads.
function newerRailCacheRevision(revision: RailCacheRevision, than: RailCacheRevision): boolean {
  return revision.mtimeMs > than.mtimeMs || (revision.mtimeMs === than.mtimeMs && revision.size > than.size);
}

// Merges timeline marks over session list marks.
// The list mark replaces a timeline mark only when the read that found its facts covered a strictly newer revision.
// `listed` holds that revision for each session, or null when no read with a known revision found the facts.
// A transcript grows during a turn, so newer bytes add a later request, a failure, or a compaction.
// A list read that holds older facts never replaces the timeline mark, even when the file grew after the timeline read.
export function railCachesOf(
  parsed: Readonly<Record<string, RevisionedRailCacheMark>>,
  metadata: Readonly<Record<string, RailCacheMark | null>>,
  listed: Readonly<Record<string, RailCacheRevision | null>>,
): Record<string, RailCacheMark | null> {
  const caches = { ...metadata };
  for (const [sessionId, snapshot] of Object.entries(parsed)) {
    const list = listed[sessionId] ?? null;
    const listNewer = list !== null && newerRailCacheRevision(list, snapshot);
    if (!listNewer) {
      caches[sessionId] = snapshot.mark;
    }
  }
  return caches;
}

// Group cards by session, preserving their arrival order. Order sessions by their first card.
// The panel draws a heading for each run of one session id. Interleaving sessions would repeat their headings.
export function groupBySession<T extends { sessionId: string }>(cards: T[]): T[] {
  const order: string[] = [];
  for (const c of cards) {
    if (!order.includes(c.sessionId)) {
      order.push(c.sessionId);
    }
  }
  return order.flatMap((id) => cards.filter((c) => c.sessionId === id));
}

// Adds visible pinned sessions absent from the recent parse cut.
// Pins extend the parse budget instead of evicting recent sessions.
// The caller must exclude hidden sessions from the visible pool.
export function withPinned<T extends { sessionId: string }>(
  cut: T[],
  visible: T[],
  pinnedTop: ReadonlySet<string>,
): T[] {
  const have = new Set(cut.map((s) => s.sessionId));
  return [...cut, ...visible.filter((s) => pinnedTop.has(s.sessionId) && !have.has(s.sessionId))];
}

// Excludes hidden sessions before choosing the parse cut, except the selected session.
// Archiving the selected session therefore retains its timeline.
// `railSessions` separately places its card in the archived group.
export function hideSessions<T extends { sessionId: string }>(
  sessions: T[],
  hidden: ReadonlySet<string>,
  pinned: string | null = null,
): T[] {
  return sessions.filter((s) => !hidden.has(s.sessionId) || s.sessionId === pinned);
}

// A session figure carries cache-write and wait warnings only. A cache-expiry warning belongs to a turn figure.
function sessionWarningWords(warnings: SessionStatChip['warnings']): string {
  const words = (warnings ?? []).flatMap((warning) =>
    warning.scope === 'cache-expiry'
      ? []
      : warning.scope === 'wait'
        ? [waitShareCondition(warning)]
        : [cacheWriteWarningCondition(warning)],
  );
  return words.length ? `, ${words.join(', ')}` : '';
}

// Groups turns and compactions by session before preparing session statistics.
// Callers must supply compactions so their counts cannot silently default to zero.
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

// Statuses lifted into the running group by `stableRailOrder`.
// Sessions waiting on requests, subagents, or background commands join running sessions.
// The caller supplies the previous order, which remains stable within each group.
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

// Unsent prompt presence and comment count for one session.
// The accessible name includes the number of waiting comments.
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

// Accessible and tooltip wording for unsent input.
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
// One session list card and its session metadata.
export interface RailCard {
  id: string;
  // Whether the session has a saved record. A provisional new session has none, so nothing
  // can rename it.
  persisted: boolean;
  // Short session name used in card action accessible names.
  label: string;
  // Longer session name for `.railname`, omitted when it equals `label`.
  // The panel renders `name ?? label` and clips text to the available width.
  name?: string;
  agent: string;
  // Relative activity age for the accessible name.
  // The panel formats visible age from `at` using its current clock.
  // `absolute` supplies the full time tooltip.
  relative: string;
  at: number;
  absolute: string;
  // Whether this is the selected session shown in the session view.
  current: boolean;
  // Whether the reader pinned this session at the session list's top.
  pinnedTop: boolean;
  // Whether the session is archived. Its card enters the archived group
  // and its accessible name includes that state.
  archived: boolean;
  // Whether the card belongs to the agent-run group. Archived cards set this to false.
  agentRun: boolean;
  // The `agentRun` fact, independent of its bucket. Archiving does not change it.
  // Lens figures and `is:agentrun` exclude agent runs whether or not the Archived switch is on.
  runByAgent: boolean | null;
  // Agent wording for the card meta row. Pinned agent runs use the agent-run phrase.
  agentWord: string;
  // The newest turn's status, or null when unknown.
  // The card uses the corresponding turn card border color. Its accessible name also states the status as text.
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
  // Accessible name clauses around the relative age. The browser inserts or removes cache state between them.
  // `railCardName` prepends the card name. These clauses omit it to avoid duplicating the separate `name` field.
  nameBeforeAge: string;
  nameAfterAge: string;
  // One compact word on the meta row, and the exact detail on its hover. Both are decided
  // here so the panel draws values rather than counting drafts or comments for itself.
  unsentWord: string | null;
  unsentName: string | null;
  // Recorded session cost for aggregation and filters, independent of the visible figure.
  // Null means no priced cost. Exact zero remains zero even when no figure is drawn.
  costDollars: number | null;
  // Whether that figure is a floor rather than a total. A visible cost chip says the same
  // fact with `+`. Only a card carrying a figure can be a floor.
  costAtLeast: boolean;
  // Lifetime indexed cache-expiry count for filters, or null when unavailable.
  // The card draws no cache-expiry figure.
  cacheExpiryCount: number | null;
  // Whether the cache-expiry count is a known minimum.
  // Unclassified adjacent request pairs can contain further returns. A missing count is never a minimum.
  cacheExpiryAtLeast: boolean;
  // All session labels in applied order, used by filters and the session heading.
  labels: string[];
  // The first `RAIL_LABELS_SHOWN` labels for display, independent of session list width.
  labelChips: string[];
  // Folded label count with a leading plus, or null when none are folded.
  labelsMore: string | null;
  // Comma-separated folded label names for the count's tooltip.
  labelsMoreName: string | null;
  // Unread indicator, or null for a known zero or unavailable count.
  // The accessible name distinguishes those two cases.
  indicator: string | null;
  // Numeric unread count, or null for a known zero or unavailable count.
  // The unread mark follows this value.
  newCount: number | null;
  // Null leaves older unread turns unknown after a partial zero.
  // The leading dot and bold name identify known unread turns.
  unread: boolean | null;
  // Newest known turn start, or null when no read-action boundary is available.
  // The session read action uses this watermark, including fallback window starts.
  newestTurnAt: number | null;
  // Native context-menu section, including a plain section when no read watermark exists.
  // Label actions remain available without parsed turns.
  menuSection: string;
}

// Native session list context-menu sections for read, unread, and unknown states.
// The plain section retains label actions but supplies no session read action.
export const RAIL_MENU_SECTIONS = {
  unread: 'arcRailUnread',
  read: 'arcRailRead',
  plain: 'arcRail',
} as const;

// Native session heading context-menu sections for archive state.
// The selected timeline remains visible when its session is archived.
export { SESSION_MENU_SECTIONS } from './view/card-menu';

// Projects session status from recorded outcomes, drawn turns, and live agent state.
// A recorded turn closed after `busySince` ends the corresponding running claim.
// A missing busy timestamp leaves the claim unbounded.
// Live children and background commands extend a closed turn's session status.
// Open requests take precedence as the waiting state. Compactions contribute no turn status.
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
  // Closure times use the same outcome precedence as projected statuses.
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

// Work recorded within this margin of the parent's closure does not reopen a child.
export const CHILD_CLOSE_MARGIN_MS = 1000;

// Live background children by session, in launch order. Open children count while their transcripts are fresh.
// Closed children resume when their newest work exceeds their close time by CHILD_CLOSE_MARGIN_MS. Legacy closes without times remain closed.
// TURN_QUIET_MS expires both open and resumed children.
// A recorded process end closes every child. An Arc-hosted process exit after the newest turn began does the same.
// Children with unknown write times do not count, so missing timestamps can undercount children.
export function liveOpenChildren(
  outcomes: ReadonlyMap<string, TurnOutcome | null>,
  writtenAt: (session: string, child: string) => number | undefined,
  // When the host process of each session that Arc hosts exited, by session.
  hostExitedAt: ReadonlyMap<string, number>,
  now: number,
  workAt: (session: string, child: string) => number | undefined = () => undefined,
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
      const at = workAt(id, child.id);
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

// Maximum background-command age without an ending record.
export const BACKGROUND_COMMAND_CAP_MS = 60 * 60 * 1000;

// Background command counts by session. Commands count from launch until their end record, bounded by BACKGROUND_COMMAND_CAP_MS.
// A recorded process end closes every command. An Arc-hosted process exit after the newest turn began does the same.
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

// Encode live open children and background command counts for refresh comparison.
// Children become quiet and commands reach their cap without changing files. This key detects both changes.
export function openChildrenKey(
  live: ReadonlyMap<string, readonly string[]>,
  commands: ReadonlyMap<string, number> = new Map(),
): string {
  const sorted = <T>(entries: ReadonlyMap<string, T>) => [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(commands.size ? [sorted(live), sorted(commands)] : sorted(live));
}

// Combine the tail outcome with open children from lifetime facts and the parsed window.
// The tail can omit earlier launches. Lifetime facts read the whole file, while the parsed window covers timeline turns.
// Without a tail outcome, such as when the tail misses the newest turn's opening prompt, the later of the lifetime and parsed outcomes takes its place.
// It then follows the tail rules, so open children that only an older lifetime outcome holds do not carry over.
// A lifetime or parsed outcome of a newer turn than the tail outcome takes its place by the same rules.
// Accept children only from outcomes describing the same newest turn through the same last record. Older reads cannot reopen closed children.
// A child closed by any read remains closed. Completion matching differs between readers, so their closed sets can differ.
// `tailCommands` come from tail reads without a typed prompt. Wider outcomes retain those commands for the same turn because other readers omit commands.
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

// The outcome that describes later work: a newer turn, or the same turn through a later record.
// A tie keeps the lifetime outcome, so a parsed window of older history cannot reopen a closed turn.
function laterOutcome(lifetime: TurnOutcome | null, parsed: TurnOutcome | null): TurnOutcome | null {
  if (!parsed || !lifetime) {
    return lifetime ?? parsed;
  }
  const lifetimeStart = lifetime.startedAt ?? 0;
  const parsedStart = parsed.startedAt ?? 0;
  return parsedStart > lifetimeStart || (parsedStart === lifetimeStart && parsed.endedAt > lifetime.endedAt)
    ? parsed
    : lifetime;
}

function mergedWiderChildren(
  tail: TurnOutcome | null,
  lifetime: TurnOutcome | null,
  parsed: TurnOutcome | null,
): TurnOutcome | null {
  if (!tail) {
    const base = laterOutcome(lifetime, parsed);
    return base && base !== lifetime ? mergedWiderChildren(base, lifetime, parsed) : lifetime;
  }
  // A tail read of an earlier revision can hold a turn that a later turn replaced.
  const newer = laterOutcome(lifetime, parsed);
  if (newer && (newer.startedAt ?? 0) > (tail.startedAt ?? 0)) {
    return mergedWiderChildren(newer, lifetime, parsed);
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

// How another session started this session: through a dispatched shell command or as a subagent.
export type SessionParentRelation = 'dispatched' | 'subagent';

// The session that started a session, and how. `owned` is set on a dispatched edge whose
// launch recorded that the reader asked for the session.
export interface SessionParentEdge {
  parent: string;
  relation: SessionParentRelation;
  owned?: true;
}

// Indexes parent relationships by child session id.
// Dispatch references, resolved Claude child files, and Codex children supply edges.
// Claude subagent edges require resolved child files. Unresolved dispatch claims still participate in conflicts.
// Codex background reviews supply no session edge.
// Duplicate claims with the same parent and relation combine reader ownership.
// Conflicting parents or relations remove the edge.
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

// Resolved dispatch references share the heading's conflict and ownership policy.
export function admittedDispatchReferences(
  references: readonly import('./transcript').ClaudeChildSessionReference[],
  claudeChildren: readonly { sessionId: string; parentSessionId: string }[] = [],
  codexChildren: readonly { threadId: string; parentThreadId: string | null; backgroundReview: boolean }[] = [],
): import('./transcript').ClaudeChildSessionReference[] {
  const resolved = references.filter((reference) => reference.kind !== 'dispatch' || reference.file !== null);
  const parents = sessionParentIndex(references, claudeChildren, codexChildren);
  const duplicatesBySession = new Map<string, import('./transcript').ClaudeDispatchSessionReference[]>();
  for (const reference of resolved) {
    if (reference.kind !== 'dispatch') continue;
    const duplicates = duplicatesBySession.get(reference.sessionId) ?? [];
    duplicates.push(reference);
    duplicatesBySession.set(reference.sessionId, duplicates);
  }
  const seen = new Set<string>();
  return resolved.flatMap<import('./transcript').ClaudeChildSessionReference>((reference) => {
    if (reference.kind !== 'dispatch') return [reference];
    const edge = parents.get(reference.sessionId);
    if (edge?.relation !== 'dispatched' || edge.parent !== reference.parentSessionId || seen.has(reference.sessionId))
      return [];
    seen.add(reference.sessionId);
    const duplicates = duplicatesBySession.get(reference.sessionId)!;
    if (new Set(duplicates.map((item) => item.file)).size !== 1) return [];
    const toolUseIds = [...new Set(duplicates.flatMap((item) => item.toolUseIds))].sort();
    return [{ ...reference, toolUseIds, owned: edge.owned === true }];
  });
}

// Parent edges whose child and parent both have session rows. Missing endpoints affect no heading or session list card.
// Headings, Run by agents filing, the refresh key, and parent lifetime cost share these edges. An edge change also changes the key.
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

// Dispatched edges as child id to parent id. They add dispatched session costs to parents and file them under Run by agents unless reader-owned.
// Exclude subagent edges. Subagent transcripts already establish their run status, and their files already contribute to their parents' delegated work.
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

// A catalog's parent edges, dispatched edges, and refresh key.
// `rows` stores catalog ids, or null when an empty index makes them irrelevant.
// Each id maps to the latest pass that saw it, as written by `sameIdSet`.
export interface SessionParentEdgeSet {
  parents: ReadonlyMap<string, SessionParentEdge>;
  rows: Map<string, number> | null;
  edges: ReadonlyMap<string, SessionParentEdge>;
  dispatched: ReadonlyMap<string, string>;
  key: string;
}

// Reuse `held` when `parents` and the session id set remain unchanged.
// Selection reuses its catalog with one pass over ids, without allocating, sorting, or joining a new set.
// Render, spend, and search catalogs arrive in different orders. Compare their ids as a set because edges depend only on row membership.
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
  relation: SessionParentRelation | 'reader';
}

// A session's parent id, displayed parent label, and relation.
// Only the displayed session heading needs this payload, keeping its size independent of child count.
// Omit parents without rows. Selecting a missing session falls back to the newest session, which would open the wrong parent.
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

// Record Arc-hosted process exits from the host's full exited-key list.
// Newly exited keys receive the current time, replacing any exit before a resume. Keys that remain exited keep their time.
// Return the exited keys for the next call and whether any exit time changed.
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

// Unread-indicator wording for the session list.
// Zero and unavailable counts return null. Known minimum counts use words rather than a plus mark.
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
    label: `New ${draft.agent} session`,
    fullLabel: `New ${draft.agent} session`,
    when: formatWhen(draft.createdAt),
    at: draft.createdAt,
    relative: 'now',
    shown: false,
    agentRun: false,
  }));
}

// Classifies agent runs using transcript evidence and retained launch ownership.
// A child transcript is always an agent run.
// Reader-started sessions and reader-owned dispatches are not agent runs.
// Other dispatches count as agent runs. Remaining sessions retain the transcript classification.
export function agentRunAnswer(
  guessed: boolean,
  sessionId: string,
  startedHere: ReadonlySet<string>,
  childTranscript: boolean,
  dispatched: boolean,
  readerOwned?: boolean,
): boolean;
export function agentRunAnswer(
  guessed: boolean | null,
  sessionId: string,
  startedHere: ReadonlySet<string>,
  childTranscript: boolean,
  dispatched: boolean | null,
  readerOwned?: boolean,
): boolean | null;
export function agentRunAnswer(
  guessed: boolean | null,
  sessionId: string,
  startedHere: ReadonlySet<string>,
  childTranscript: boolean,
  dispatched: boolean | null,
  readerOwned = false,
): boolean | null {
  if (childTranscript) {
    return true;
  }
  if (startedHere.has(sessionId) || (dispatched && readerOwned)) {
    return false;
  }
  if (dispatched === null)
    return guessed === false && readerOwned ? false : guessed === true && !readerOwned ? true : null;
  return dispatched || guessed;
}

// The card's complete accessible name. `view/rail.ts` supplies the wording.
// `webview/rail.ts` supplies the two clauses affected by its clock. Wording checks call the same function without those clauses.
export { railCardName } from './view/rail.ts';

// Prepares session list cards in supplied order, with live pinned sessions first and archived sessions last.
// Archiving does not exempt the selected card from its archived state.
// The separate parse filter retains the selected timeline.
// An empty card list remains meaningful to the browser's navigation structure.
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
    agentRun?: boolean | null;
  }[],
  counts: ReadonlyMap<string, NewCount>,
  newest: ReadonlyMap<string, number>,
  statuses: ReadonlyMap<string, RailStatus>,
  hidden: ReadonlySet<string>,
  pinned: string | null,
  pinnedTop: ReadonlySet<string>,
  unsent: ReadonlyMap<string, UnsentInput>,
  statsById: Readonly<Record<string, readonly SessionStatChip[]>>,
  // Complete session labels by id, shared by display fields and accessible names.
  // Callers must supply this map instead of silently defaulting all sessions to unlabelled.
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
    const unread = count === 0 && entry?.atLeast ? null : newCount !== null;
    const current = s.id === pinned;
    // Archiving takes precedence over pinning, matching the unpinning performed when the panel archives a session.
    // Stored state can contain both flags. A pinned archived card must stay in its folded bucket rather than occupying the list top.
    const onTop = pinnedTop.has(s.id) && !archived;
    // Archiving and pinning take precedence over inferred session origins. Archived runs stay in Archived. Pinned runs stay at the top.
    // Only pinned runs need the origin phrase because they appear without a heading that supplies it.
    const agentRun = s.agentRun === true && !archived;
    const runByAgent = s.agentRun === null ? null : s.agentRun === true;
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
    // Read the lifetime index used by `costById`.
    // `railStatChips` omits the cache-expiry figure from display, but filtering still requires its exact count.
    const cacheExpiryFact = cacheExpiryById[s.id] ?? null;
    const cacheExpiryCount = cacheExpiryFact?.count ?? null;
    // A missing count is never a floor, the same way a missing cost is not.
    const cacheExpiryAtLeast = cacheExpiryCount !== null && cacheExpiryFact?.atLeast === true;
    const statNames = stats.map((stat) =>
      stat.metric === 'cost'
        ? `whole session cost ${stat.compactLabel}${stat.partialDetail ? `, ${stat.partialDetail.replace(/\.$/, '')}` : ''}${sessionWarningWords(stat.warnings)}`
        : stat.metric === 'turns'
          ? stat.compactLabel
          : `current context ${stat.compactLabel}`,
    );
    // Use one full label list for visible fields and the accessible label clause.
    // Keep the label clause last so later comma-separated text is not read as another label.
    const { labelClause, ...labelFields } = railLabelFields(labelsOf(labelsById, s.id), CARD_ACTIONS.railLabelled);
    // Use relative age in the accessible name. The panel formats visible age from the timestamp.
    // Use the full clock time for the tooltip and shared status wording for the state.
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
    // Exclude the session name and unsent detail from these clauses.
    // `railCardName` adds their separate fields when composing the accessible name.
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
      indicator ?? (count === 0 ? (unread === null ? 'new turns unknown' : CARD_ACTIONS.sessionNothingNew) : null),
      labelClause,
    ]
      .filter(Boolean)
      .join(', ');
    // Choose the native read-action section from the available newest-turn watermark.
    // No watermark uses the plain section, which still permits label actions.
    const newestTurnAt = newest.get(s.id) ?? null;
    const menuSection =
      newestTurnAt === null
        ? RAIL_MENU_SECTIONS.plain
        : unread !== false
          ? RAIL_MENU_SECTIONS.unread
          : RAIL_MENU_SECTIONS.read;
    // Pinned agent runs use the agent-run phrase because they sit outside the agent-run heading.
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
