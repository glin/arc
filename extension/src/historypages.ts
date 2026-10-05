// Retain older session pages, admit new turn identities, and manage the older-history control.
// Requests chain from source-adapter cursors. Retained pages share the selected-session history budget.

import { Compaction, Turn } from './transcript';
import { turnKey } from './turnread';
import { settingDefault } from './settings';

// Target number of complete turns per older-history page.
export const HISTORY_PAGE_TURNS = 20;

// Supported `sessionCacheMiB` range. `historyBudgetBytes` clamps values to these bounds.
export const HISTORY_BUDGET_MIN_MIB = 1;
export const HISTORY_BUDGET_MAX_MIB = 256;

// Convert `sessionCacheMiB` to bytes. Floor finite values, clamp them, and use the setting default for nonfinite values.
// Retained pages charge serialized turns and compactions. Raw read buffers are excluded.
export function historyBudgetBytes(mib: number): number {
  const value = Number.isFinite(mib) ? Math.floor(mib) : settingDefault('sessionCacheMiB');
  return Math.min(HISTORY_BUDGET_MAX_MIB, Math.max(HISTORY_BUDGET_MIN_MIB, value)) * 1024 * 1024;
}

// Maximum page reads per request. `historyPageReads` scales the allowance with loaded turns, up to this ceiling.
export const HISTORY_PAGE_READ_CEILING = 8;

// Stop automatic requests after this many consecutive requests retain no page.
// The button remains available. Each request can read several pages.
export const HISTORY_EMPTY_RUN_LIMIT = 3;

// Charge this many bytes per turn or compaction when JSON serialization fails.
export const HISTORY_UNMEASURED_RECORD_BYTES = 2048;

// Accepted turns and compactions with their serialized byte charge.
export interface HistoryPage {
  turns: Turn[];
  compactions: Compaction[];
  bytes: number;
  fromWindow?: true;
}

// Source coverage and tail turn identities needed to confirm the completed prefix.
export interface HistoryCoverage {
  ownedRange: { start: number; end: number };
  openRange: { start: number; end: number } | null;
  tailTurnKeys: string[];
}

// Retained history beyond the ordinary tail for one session.
export interface SessionHistory<Cursor> {
  sessionId: string;
  // Source size and modification time used by `historyAfterRevision`.
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
  // Completed page-read attempts, including stale and failed reads. The control token includes this count.
  requests: number;
  emptyRuns: number;
  failed: boolean;
  // Last viewing time used to order unprotected sessions for eviction.
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

// Older history exists when the read excludes bytes or the parser reached its turn limit.
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

// Keep unchanged history unless selected-tail coverage has expired.
// Rebase a selected session on growth. Reset changed sessions otherwise.
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

// Apply the revision decision to retained pages and their cursor.
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

// Match the compaction card key to deduplicate records across page boundaries.
function compactionKey(compaction: Compaction): string {
  return `${compaction.sessionId}:compact:${compaction.at}`;
}

// Admit each turn or compaction identity once across the supplied page and retained identities.
// Initial older pages overlap the ordinary tail. Later appends can move retained records into that tail.
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

// Collect the identities used by `admitHistoryRecords`.
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

// Return retained turns and compactions absent from the ordinary tail. Callers sort the combined turns.
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

// Retain completed turns displaced by an append without changing explicit older pages.
// Limit the recent page by remaining turn slots and byte budget, allowing one oversized newest turn.
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

// Measure serialized turns and compactions for the retained budget.
// Use the fallback per-record charge when serialization fails.
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

// Scale the page-read allowance with loaded turns, up to `HISTORY_PAGE_READ_CEILING`.
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

// Advance the cursor and retain identities absent from the tail and older pages.
// Stale reads preserve pages and cursor. Failed reads set the retry state. Both increment the attempt count.
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

// Continue after a page adds no turn and leaves older history available.
// Stale and failed outcomes stop the current request.
export function historyRequestContinues<Cursor>(
  outcome: HistoryPageOutcome<Cursor>,
  applied: { history: SessionHistory<Cursor>; added: number },
): boolean {
  return outcome.kind === 'page' && applied.added === 0 && !applied.history.atBeginning;
}

// Reset the empty-request count when a request retains a page. Increment it otherwise.
export function afterHistoryRequest<Cursor>(
  held: SessionHistory<Cursor>,
  before: SessionHistory<Cursor>,
): SessionHistory<Cursor> {
  const added = held.pages.length > before.pages.length;
  return { ...held, emptyRuns: added ? 0 : before.emptyRuns + 1 };
}

// A stale cursor needs a restart when size and modification time remain unchanged.
// Rebasing those figures cannot resolve a changed file identity.
export function staleCursorIsStuck(
  held: { size: number; mtimeMs: number },
  current: { size: number; mtimeMs: number },
): boolean {
  return held.size === current.size && held.mtimeMs === current.mtimeMs;
}

// Evict the least recently used unprotected sessions until retained bytes fit the budget.
// Protected sessions remain even when their combined size exceeds the budget.
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

// Older-history presentation returned to the browser.
// `auto` permits viewport-triggered requests. `token` distinguishes completed attempts and loaded-turn counts.
// Failed reads require a button press to retry.
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
