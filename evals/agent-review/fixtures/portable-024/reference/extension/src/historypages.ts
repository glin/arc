// extension/src/historypages.ts
//
// Older session history, one page at a time.
//
// `history.ts` and the two source adapters read a semantic page off a transcript. This
// module owns what the provider does with one: which session may ask for a page, what
// a page adds once its adapter has proved both of its edges, when a request stops reading,
// how much retained history a session keeps, and what the control at the end of the
// list says.
//
// A request reads disjoint ranges, chains from the cursor the last page returned, and stops
// at the beginning of the file. Its cost does not grow with the session, because no
// range is read twice and no tail is parsed again.
//
// Nothing here imports `vscode`, so every rule below is tested. `panelhost.ts` is the
// orchestration seam and `webview/panel.ts` is the rendering seam, and neither decides
// anything this file decides.

import { Compaction, Turn } from './transcript';
import { turnKey } from './turnread';
import { settingDefault } from './settings';

// How many complete turns one page aims at. Large enough that a reader scrolling steadily is
// not waiting on a read, and small enough that one page stays a bounded piece of work.
export const HISTORY_PAGE_TURNS = 20;

// The supported range of the `sessionCacheMiB` setting, in MiB. `historyBudgetBytes` clamps
// to this range and `package.json` contributes the same bounds.
export const HISTORY_BUDGET_MIN_MIB = 1;
export const HISTORY_BUDGET_MAX_MIB = 256;

// Bytes of retained history the `sessionCacheMiB` setting allows, in bytes of serialized
// turns and compactions. Raw transcript chunks are transient and never enter it. Floors a
// fractional MiB value, clamps it to the supported range, and falls back to the setting's
// default when the value is not a finite number.
export function historyBudgetBytes(mib: number): number {
  const value = Number.isFinite(mib) ? Math.floor(mib) : settingDefault('sessionCacheMiB');
  return Math.min(HISTORY_BUDGET_MAX_MIB, Math.max(HISTORY_BUDGET_MIN_MIB, value)) * 1024 * 1024;
}

// The most pages one request will read while it looks for a turn the session does not
// already hold. The first request starts at the end of the file and walks back through
// everything the ordinary tail already listed, so it pays about one page read per page of
// loaded turns. Every later request chains from the stored cursor and reaches new turns on
// its first read.
export const HISTORY_PAGE_READ_CEILING = 8;

// How many requests in a row may return no new turn before the sentinel stops asking on its
// own. Without it a request that adds nothing leaves the sentinel on screen, and the panel
// asks again the moment it settles. The button stays, so the reader can still go further.
//
// Requests, not reads. One request reads several pages while it walks back past the turns
// the ordinary tail already lists, and counting those would switch the automatic trigger off
// on the first press of a long session.
export const HISTORY_EMPTY_RUN_LIMIT = 3;

// What one retained turn or compaction is charged when the serializer refuses to measure it.
// Set above what an ordinary record costs, so a value nobody can measure is never treated as
// the cheapest thing in the cache.
export const HISTORY_UNMEASURED_RECORD_BYTES = 2048;

// One accepted older page: the turns and compactions its adapter proved complete at both
// semantic edges, and what they cost the retained budget.
export interface HistoryPage {
  turns: Turn[];
  compactions: Compaction[];
  bytes: number;
  fromWindow?: true;
}

// The bounded evidence behind a completed-prefix claim. The final semantic page proves the
// source range, while the ordinary tail owns the turn identities beyond that range.
export interface HistoryCoverage {
  ownedRange: { start: number; end: number };
  openRange: { start: number; end: number } | null;
  tailTurnKeys: string[];
}

// What one session has loaded beyond its ordinary tail.
export interface SessionHistory<Cursor> {
  sessionId: string;
  // The file generation the pages were read from. `historyAfterRevision` decides what a
  // move of either figure does to them.
  size: number;
  mtimeMs: number;
  pages: HistoryPage[];
  // Where the next page starts. Null once the adapter reached the beginning of the file.
  cursor: Cursor | null;
  atBeginning: boolean;
  coverage: HistoryCoverage | null;
  // Tail-owned turns encountered while a backward scan is in progress. A completed
  // coverage claim depends on these identities until a later page retains them.
  scanTailTurnKeys: string[];
  // Every completed read attempt, including the ones that failed. The panel compares it
  // before it asks on its own, so a request that changed nothing cannot be repeated.
  requests: number;
  emptyRuns: number;
  failed: boolean;
  // When the reader last had this session on screen, which is what decides eviction.
  usedAt: number;
}

export function startSessionHistory<Cursor>(
  session: { sessionId: string; size: number; mtimeMs: number },
  at: number,
): SessionHistory<Cursor> {
  return {
    sessionId: session.sessionId,
    size: session.size,
    mtimeMs: session.mtimeMs,
    pages: [],
    cursor: null,
    atBeginning: false,
    coverage: null,
    scanTailTurnKeys: [],
    requests: 0,
    emptyRuns: 0,
    failed: false,
    usedAt: at,
  };
}

// Whether older history exists to ask for, before any page has been read. Two things say so.
// The ordinary tail does not reach the beginning of the file, or its parser discarded an
// older turn at the turn limit.
export function olderHistoryPossible(state: { size: number; readBytes: number; turnLimitReached: boolean }): boolean {
  return state.size > state.readBytes || state.turnLimitReached;
}

export type HistoryRevisionAnswer = 'keep' | 'rebase' | 'restart' | 'reset';

function coverageIsCurrent(coverage: HistoryCoverage, tail: { turns: readonly Turn[] }): boolean {
  if (coverage.ownedRange.start !== 0 || coverage.ownedRange.end < 0) {
    return false;
  }
  if (
    coverage.openRange &&
    (coverage.openRange.start !== coverage.ownedRange.end ||
      coverage.openRange.end <= coverage.openRange.start ||
      coverage.tailTurnKeys.length === 0)
  ) {
    return false;
  }
  return tailHasTurnKeys(coverage.tailTurnKeys, tail);
}

function tailHasTurnKeys(keys: readonly string[], tail: { turns: readonly Turn[] }): boolean {
  const current = new Set(tail.turns.map(turnKey));
  return keys.every((key) => current.has(key));
}

// What happens to retained pages when the transcript moves under them.
//
// An append leaves every retained byte where it was, so the pages still describe the file
// and only the revision the cursor records has to move with it. A session nobody is
// reading starts over instead: nothing validates its bytes while it is off screen, and its
// pages are a convenience rather than what is on the reader's screen.
export function historyAfterRevision(
  held: Pick<
    SessionHistory<unknown>,
    'sessionId' | 'size' | 'mtimeMs' | 'atBeginning' | 'coverage' | 'scanTailTurnKeys'
  >,
  current: { sessionId: string; size: number; mtimeMs: number },
  selected: boolean,
  tail?: { turns: readonly Turn[] },
): HistoryRevisionAnswer {
  if (held.sessionId !== current.sessionId) {
    return 'reset';
  }
  const unchanged = held.size === current.size && held.mtimeMs === current.mtimeMs;
  if (
    selected &&
    tail &&
    (!tailHasTurnKeys(held.scanTailTurnKeys, tail) ||
      (held.atBeginning && (!held.coverage || !coverageIsCurrent(held.coverage, tail))))
  ) {
    return 'restart';
  }
  if (unchanged) {
    return 'keep';
  }
  if (selected && current.size > held.size) {
    return 'rebase';
  }
  return 'reset';
}

// Apply the revision decision as one state transition. The provider calls this after it
// admits a stable tail, so tests can cover the same append path that updates its map.
export function historyStateAfterRevision<
  Cursor extends {
    revision: { size: number; mtimeMs: number };
  },
>(
  held: SessionHistory<Cursor>,
  current: { sessionId: string; size: number; mtimeMs: number },
  selected: boolean,
  tail: { turns: readonly Turn[] } | undefined,
  at: number,
): SessionHistory<Cursor> | null {
  const answer = historyAfterRevision(held, current, selected, tail);
  if (answer === 'reset') {
    return null;
  }
  if (answer === 'restart') {
    return restartHistoryCoverage(held, current, at);
  }
  const cursor =
    answer === 'rebase' && held.cursor
      ? {
          ...held.cursor,
          revision: {
            ...held.cursor.revision,
            size: current.size,
            mtimeMs: current.mtimeMs,
          },
        }
      : held.cursor;
  return {
    ...held,
    size: current.size,
    mtimeMs: current.mtimeMs,
    pages: held.pages,
    cursor,
    usedAt: selected ? at : held.usedAt,
  };
}

// Keep page-owned records when their completed-prefix claim expires. A null cursor restarts
// the backward reader from the current file end, where identity deduplication can admit only
// the records that left the ordinary tail.
export function restartHistoryCoverage<Cursor>(
  held: SessionHistory<Cursor>,
  current: { size: number; mtimeMs: number },
  at: number,
): SessionHistory<Cursor> {
  return {
    ...held,
    size: current.size,
    mtimeMs: current.mtimeMs,
    pages: held.pages,
    cursor: null,
    atBeginning: false,
    coverage: null,
    scanTailTurnKeys: [],
    usedAt: at,
  };
}

// A compaction's identity, spelled the way the card's key spells it. Two pages can carry the
// same compaction when their ranges meet at a boundary record.
function compactionKey(compaction: Compaction): string {
  return `${compaction.sessionId}:compact:${compaction.at}`;
}

// The turns and compactions a page adds, less the ones the session already holds.
//
// The first request reads from the end of the file, so its pages overlap the ordinary tail
// by design. The retained tail also grows as the file does, so a page admitted while it was
// outside the tail can be inside it later. A turn admitted twice draws two cards for one
// piece of work, which is why identity decides this and byte ranges do not.
export function admitHistoryRecords(
  held: Iterable<string>,
  page: { turns: readonly Turn[]; compactions: readonly Compaction[] },
): { turns: Turn[]; compactions: Compaction[] } {
  const have = new Set(held);
  const turns: Turn[] = [];
  for (const turn of page.turns) {
    const key = turnKey(turn);
    if (have.has(key)) {
      continue;
    }
    have.add(key);
    turns.push(turn);
  }
  const compactions: Compaction[] = [];
  for (const compaction of page.compactions) {
    const key = compactionKey(compaction);
    if (have.has(key)) {
      continue;
    }
    have.add(key);
    compactions.push(compaction);
  }
  return { turns, compactions };
}

// Every identity the retained pages hold, in the spelling `admitHistoryRecords` compares.
export function historyRecordKeys(pages: readonly HistoryPage[]): string[] {
  const keys: string[] = [];
  for (const page of pages) {
    for (const turn of page.turns) {
      keys.push(turnKey(turn));
    }
    for (const compaction of page.compactions) {
      keys.push(compactionKey(compaction));
    }
  }
  return keys;
}

// What the retained pages add to the list, less anything the ordinary tail already lists.
// The order here decides nothing: the caller sorts every turn by its start time.
export function historyRecordsOutside(
  pages: readonly HistoryPage[],
  tail: { turns: readonly Turn[]; compactions: readonly Compaction[] },
): { turns: Turn[]; compactions: Compaction[] } {
  const held = new Set<string>([...tail.turns.map(turnKey), ...tail.compactions.map(compactionKey)]);
  const turns: Turn[] = [];
  const compactions: Compaction[] = [];
  for (const page of pages) {
    const admitted = admitHistoryRecords(held, page);
    for (const turn of admitted.turns) {
      held.add(turnKey(turn));
      turns.push(turn);
    }
    for (const compaction of admitted.compactions) {
      held.add(compactionKey(compaction));
      compactions.push(compaction);
    }
  }
  return { turns, compactions };
}

// Keep completed turns that the reader saw before an append moved them out of the bounded
// read. Explicit older pages stay intact. This one recent page is bounded by the ordinary
// turn limit and the selected session's cache budget.
export function retainDisplacedWindow<Cursor>(
  held: SessionHistory<Cursor>,
  previous: { turns: readonly Turn[]; compactions: readonly Compaction[] },
  tail: { turns: readonly Turn[]; compactions: readonly Compaction[] },
  maxTurns: number,
  maxBytes: number,
  at: number,
): SessionHistory<Cursor> {
  const tailKeys = new Set(tail.turns.map(turnKey));
  const tailCompactions = new Set(tail.compactions.map(compactionKey));
  const displacedTurns = previous.turns.filter((turn) => turn.finished && !tailKeys.has(turnKey(turn)));
  const displacedCompactions = previous.compactions.filter(
    (compaction) => !tailCompactions.has(compactionKey(compaction)),
  );
  const recent = held.pages.filter((page) => page.fromWindow);
  if (!displacedTurns.length && !displacedCompactions.length) {
    return held;
  }
  const explicit = held.pages.filter((page) => !page.fromWindow);
  const explicitKeys = new Set(explicit.flatMap((page) => page.turns.map(turnKey)));
  const admitted = admitHistoryRecords([...tailKeys, ...tailCompactions, ...historyRecordKeys(explicit)], {
    turns: [...recent.flatMap((page) => page.turns), ...displacedTurns],
    compactions: [...recent.flatMap((page) => page.compactions), ...displacedCompactions],
  });
  const turns: Turn[] = [];
  let bytes = 0;
  const remainingBytes = Math.max(0, maxBytes - historyBytes(explicit));
  const limit = Math.max(0, Math.floor(maxTurns) - tail.turns.length);
  for (const turn of admitted.turns.sort((a, b) => b.startedAt - a.startedAt)) {
    if (turns.length >= limit) {
      break;
    }
    const cost = historyPageBytes({ turns: [turn], compactions: [] });
    if (turns.length && bytes + cost > remainingBytes) {
      continue;
    }
    turns.push(turn);
    bytes += cost;
  }
  const oldest = turns.at(-1)?.startedAt ?? Infinity;
  const compactions: Compaction[] = [];
  for (const compaction of admitted.compactions.filter((entry) => entry.at >= oldest).sort((a, b) => b.at - a.at)) {
    const cost = historyPageBytes({ turns: [], compactions: [compaction] });
    if (bytes + cost > remainingBytes) {
      continue;
    }
    compactions.push(compaction);
    bytes += cost;
  }
  const retained = new Set(turns.map(turnKey));
  const lost = recent.some((page) =>
    page.turns.some(
      (turn) => !retained.has(turnKey(turn)) && !tailKeys.has(turnKey(turn)) && !explicitKeys.has(turnKey(turn)),
    ),
  );
  const basis = lost ? restartHistoryCoverage(held, { size: held.size, mtimeMs: held.mtimeMs }, at) : held;
  const fromWindow: HistoryPage | null =
    turns.length || compactions.length
      ? { turns, compactions, bytes: historyPageBytes({ turns, compactions }), fromWindow: true }
      : null;
  return {
    ...basis,
    pages: [...explicit, ...(fromWindow ? [fromWindow] : [])],
    usedAt: at,
  };
}

// What a page costs the retained budget. Serialized once, when the page is admitted,
// because what a page retains varies by orders of magnitude between a bare prompt and a
// turn carrying recorded file text.
export function historyPageBytes(page: { turns: readonly Turn[]; compactions: readonly Compaction[] }): number {
  try {
    return Buffer.byteLength(JSON.stringify({ turns: page.turns, compactions: page.compactions }));
  } catch {
    return (page.turns.length + page.compactions.length) * HISTORY_UNMEASURED_RECORD_BYTES;
  }
}

export function historyBytes(pages: readonly HistoryPage[]): number {
  return pages.reduce((total, page) => total + page.bytes, 0);
}

// How many pages one request may read before it gives up on finding a new turn.
export function historyPageReads(loadedTurns: number, targetTurns: number = HISTORY_PAGE_TURNS): number {
  const covered = Math.ceil(Math.max(0, loadedTurns) / Math.max(1, targetTurns));
  return Math.max(1, Math.min(HISTORY_PAGE_READ_CEILING, covered + 1));
}

export type HistoryPageOutcome<Cursor> =
  | {
      kind: 'page';
      turns: readonly Turn[];
      compactions: readonly Compaction[];
      cursor: Cursor | null;
      ownedRange: { start: number; end: number };
      openRange: { start: number; end: number } | null;
    }
  | { kind: 'stale' }
  | { kind: 'failed' };

// What one completed read does to a session's retained history.
//
// A page that adds nothing still advances the cursor, or the next request reads the same
// bytes and answers the same way for ever. A page that adds nothing is not stored, because
// the cards it holds are already on the list.
//
// A stale read is the common answer on a live session: the agent appended while the page
// was being read. The pages still describe the file, so they stay, the cursor stays, and the
// request counts as one that added nothing. The next one reads from the rebased cursor. Only
// a read that cannot be repeated marks the session as failed and puts the reader in
// charge of the retry.
export function afterHistoryPage<Cursor>(
  held: SessionHistory<Cursor>,
  outcome: HistoryPageOutcome<Cursor>,
  tail: { turns: readonly Turn[]; compactions: readonly Compaction[] },
  at: number,
): { history: SessionHistory<Cursor>; added: number } {
  if (outcome.kind === 'stale') {
    return { history: { ...held, requests: held.requests + 1, usedAt: at }, added: 0 };
  }
  if (outcome.kind === 'failed') {
    return {
      history: { ...held, failed: true, requests: held.requests + 1, usedAt: at },
      added: 0,
    };
  }
  const admitted = admitHistoryRecords(
    [...tail.turns.map(turnKey), ...tail.compactions.map(compactionKey), ...historyRecordKeys(held.pages)],
    outcome,
  );
  const added = admitted.turns.length;
  const pages =
    admitted.turns.length || admitted.compactions.length
      ? [
          ...held.pages,
          {
            turns: admitted.turns,
            compactions: admitted.compactions,
            bytes: historyPageBytes(admitted),
          },
        ]
      : held.pages;
  const retainedTurnKeys = new Set(pages.flatMap((page) => page.turns.map(turnKey)));
  const tailTurnKeys = tail.turns.map(turnKey);
  const tailTurnKeySet = new Set(tailTurnKeys);
  const scanTailTurnKeys = [
    ...new Set([...held.scanTailTurnKeys, ...outcome.turns.map(turnKey).filter((key) => tailTurnKeySet.has(key))]),
  ].filter((key) => !retainedTurnKeys.has(key));
  const coverage =
    outcome.cursor === null
      ? {
          ownedRange: { ...outcome.ownedRange },
          openRange: outcome.openRange ? { ...outcome.openRange } : null,
          tailTurnKeys: [
            ...new Set([...scanTailTurnKeys, ...tailTurnKeys.filter((key) => !retainedTurnKeys.has(key))]),
          ],
        }
      : null;
  const coverageComplete = coverage ? coverageIsCurrent(coverage, tail) : false;
  return {
    history: {
      ...held,
      pages,
      cursor: outcome.cursor,
      atBeginning: outcome.cursor === null && coverageComplete,
      coverage: coverageComplete ? coverage : null,
      scanTailTurnKeys: outcome.cursor === null ? [] : scanTailTurnKeys,
      requests: held.requests + 1,
      failed: false,
      usedAt: at,
    },
    added,
  };
}

// Whether a request reads another page.
//
// It stops on the first page that carries a turn the session did not hold, at the
// beginning of the file, and on any answer that is not a page. A stale answer means the file
// moved under the read, so the next request reads it through rather than this one.
export function historyRequestContinues<Cursor>(
  outcome: HistoryPageOutcome<Cursor>,
  applied: { history: SessionHistory<Cursor>; added: number },
): boolean {
  return outcome.kind === 'page' && applied.added === 0 && !applied.history.atBeginning;
}

// What a finished request leaves behind. `afterHistoryPage` counts the reads inside it, and
// this counts the request itself, which is what the automatic trigger is bounded by.
export function afterHistoryRequest<Cursor>(
  held: SessionHistory<Cursor>,
  before: SessionHistory<Cursor>,
): SessionHistory<Cursor> {
  const added = held.pages.length > before.pages.length;
  return { ...held, emptyRuns: added ? 0 : before.emptyRuns + 1 };
}

// Whether a stale answer means the cursor can never be used again.
//
// A stale answer normally means the agent appended while the page was read. The next refresh
// rebases the cursor onto the file as it is now, and the next request reads it through. When
// the file did not move at all, the cursor names a generation the file no longer has, which
// no rebase can repair: a transcript copied over its own path keeps its size and its write
// time and takes a new inode. Every later request would answer stale for ever, and the reader
// would press a button that does nothing. The session starts over instead.
export function staleCursorIsStuck(
  held: { size: number; mtimeMs: number },
  current: { size: number; mtimeMs: number },
): boolean {
  return held.size === current.size && held.mtimeMs === current.mtimeMs;
}

// Which sessions give up their retained history.
//
// Protection first, then the budget, then recency. Sessions on screen are never evicted:
// they are what the reader is looking at, and active values larger than the budget keep their
// places while every optional one goes. Every optional session stays while all of them
// together fit the budget, so a walk from one session to another and back finds the first
// one still parsed. Past that, the least recently used optional session goes first.
export function historyEvictions(
  entries: readonly { sessionId: string; bytes: number; usedAt: number }[],
  protectedSessions: ReadonlySet<string>,
  budget: number,
): string[] {
  const optional = entries
    .filter((entry) => !protectedSessions.has(entry.sessionId))
    .sort((a, b) => a.usedAt - b.usedAt || a.sessionId.localeCompare(b.sessionId));
  const drop = new Set<string>();
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  for (const entry of optional) {
    if (total <= budget) {
      break;
    }
    drop.add(entry.sessionId);
    total -= entry.bytes;
  }
  return [...drop].sort();
}

// The control at the end of the selected session's list.
//
// `kind` decides what the panel draws. `load` and `retry` are real buttons, so the whole
// control works from the keyboard whatever the viewport does. `busy` and `beginning` are
// status lines, because there is nothing left to press.
//
// `auto` is what allows the panel to ask when the sentinel comes near the viewport, and
// `token` is what stops it asking twice for the same answer. A retry never asks on its own:
// a read that failed once fails again, in a loop nobody pressed for.
export interface OlderHistoryControl {
  kind: 'load' | 'busy' | 'retry' | 'beginning';
  label: string;
  name?: string;
  auto?: boolean;
  token?: string;
}

function turnWord(count: number): string {
  return `${count} turn${count === 1 ? '' : 's'}`;
}

export function olderHistoryControl(state: {
  sessionId: string;
  possible: boolean; // older history exists, judged from the ordinary read alone
  paged: boolean; // at least one page read has completed for this session
  atBeginning: boolean;
  busy: boolean;
  failed: boolean;
  emptyRuns: number;
  requests: number;
  loadedTurns: number;
}): OlderHistoryControl | null {
  if (state.busy) {
    return { kind: 'busy', label: 'Loading older turns.' };
  }
  if (state.paged && state.atBeginning) {
    return {
      kind: 'beginning',
      label: `The whole session is loaded. ${turnWord(state.loadedTurns)}.`,
    };
  }
  if (!state.paged && !state.possible) {
    return null;
  }
  const token = `${state.sessionId}:${state.requests}:${state.loadedTurns}`;
  if (state.failed) {
    return {
      kind: 'retry',
      label: 'Older turns did not load. Try again.',
      auto: false,
      token,
    };
  }
  return {
    kind: 'load',
    label: 'Load older turns',
    name: `Load older turns. ${turnWord(state.loadedTurns)} loaded now.`,
    auto: state.emptyRuns < HISTORY_EMPTY_RUN_LIMIT,
    token,
  };
}
