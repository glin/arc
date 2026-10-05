// Builds searchable turn text, filters entries, and prepares result snippets.
// `turnview.ts` re-exports these helpers for existing callers.

import { Turn, responseAnswerIndex } from './transcript';
import { formatWhen } from './turnformat';
import { NUMERIC_FIELDS, parseSessionQuery, sessionTermHolds, type FilterTerm } from './domain/session-query.ts';
export {
  canStartSearch,
  FIND_PREFIX,
  IS_PREFIX,
  IS_SYNONYMS,
  IS_VALUES,
  isSearch,
  LABEL_PREFIX,
  matchSessions,
  parseSessionQuery,
  queryToken,
  quoteQueryValue,
  replaceToken,
  SESSION_AXES,
  WHERE_PREFIX,
  WHERE_SYNONYMS,
  WHERE_VALUES,
  withWhere,
} from './domain/session-query.ts';
export type {
  FilterTerm,
  QueryToken,
  SearchWhere,
  SessionAxis,
  SessionField,
  SessionQuery as Query,
} from './domain/session-query.ts';
export { isNote, labelSuggestions, whereNote } from './view/session-query.ts';

// Joins completed answers in source order, followed by an unclosed summary when present.
// Search includes earlier answers and keeps snippets spanning answers in reading order.
export function searchableSummary(turn: Pick<Turn, 'answers' | 'summary'>): string {
  const texts = turn.answers.map((a) => a.text);
  if (turn.summary && responseAnswerIndex(turn) < 0) {
    texts.push(turn.summary);
  }
  return texts.join('\n\n');
}

// Joins the first prompt and later prompts for search.
export function searchablePrompt(turn: Pick<Turn, 'prompt' | 'laterPrompts'>): string {
  return [turn.prompt, ...turn.laterPrompts.map((a) => a.text)].filter(Boolean).join('\n\n');
}

// Matches session text, labels, archived state, and agent-run state against a search entry.
// Entries supply no cost, cache-expiry, turn status, prompt-cache state, or recency facts.
function termHolds(term: FilterTerm, entry: SearchEntry): boolean {
  return sessionTermHolds(
    term,
    entry.agent,
    entry.sessionTitle,
    entry.labels,
    null,
    false,
    null,
    false,
    false,
    entry.runByAgent === true,
    entry.archived === true,
  );
}

// Compact searchable turn text and session metadata, excluding files, usage, and patches.
export interface SearchEntry {
  key: string;
  sessionId: string;
  sessionTitle: string;
  agent: string;
  startedAt: number;
  prompt: string;
  summary: string;
  // Whether the search read reached the transcript's beginning.
  // Search reads its own window, separate from the ordinary tail and loaded history pages. Describe incomplete results as scoped, not session-wide.
  whole?: boolean;
  // Session labels supplied by the caller at search time.
  // They remain separate from cached transcript text because label edits do not change the source file.
  labels?: readonly string[];
  // Session archived and agent-run facts supplied at search time.
  // Missing facts do not match `is:archived` or `is:agentrun`.
  archived?: boolean;
  runByAgent?: boolean;
}

export interface SearchHit {
  key: string;
  sessionId: string;
  sessionTitle: string;
  agent: string;
  startedAt: number;
  when: string; // Host-formatted turn time.
  where: 'prompt' | 'summary';
  snippet: string; // The line containing the query match.
  // Character positions of each searched word within the snippet. The panel marks these ranges without duplicating the matching rule.
  ranges: [number, number][];
}

// How much of a line to keep around the match. Enough to read the sentence it is in, and not
// so much that a result is a paragraph.
export const SNIPPET_BEFORE = 40;

export const SNIPPET_AFTER = 120;

// Returns the matching line, bounded by the snippet limits.
// Ellipses identify trimmed ends.
export function snippetAround(text: string, needle: string): string | null {
  const at = text.toLowerCase().indexOf(needle);
  if (at === -1) {
    return null;
  }
  let from = text.lastIndexOf('\n', at) + 1;
  let to = text.indexOf('\n', at);
  if (to === -1) {
    to = text.length;
  }
  let cutHead = false;
  let cutTail = false;
  if (at - from > SNIPPET_BEFORE) {
    from = at - SNIPPET_BEFORE;
    cutHead = true;
  }
  if (to - at > SNIPPET_AFTER) {
    to = at + SNIPPET_AFTER;
    cutTail = true;
  }
  const line = text.slice(from, to).trim();
  return `${cutHead ? '...' : ''}${line}${cutTail ? '...' : ''}`;
}

// Returns case-insensitive match ranges as sorted [from, to) character offsets.
// Overlapping ranges combine so the panel can highlight them in reading order.
export function snippetRanges(snippet: string, words: string[]): [number, number][] {
  const lower = snippet.toLowerCase();
  const found: [number, number][] = [];
  for (const word of words) {
    if (!word) {
      continue;
    }
    let at = lower.indexOf(word);
    while (at !== -1) {
      found.push([at, at + word.length]);
      at = lower.indexOf(word, at + 1);
    }
  }
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const range of found) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1]);
    } else {
      merged.push([range[0], range[1]]);
    }
  }
  return merged;
}

// Narrows search to the selected session when an id is supplied.
// Returns scope metadata for result wording.
export function searchScope<T extends { sessionId: string; whole?: boolean }>(
  entries: T[],
  pinned: string | null,
): { entries: T[]; scoped: boolean; whole: boolean } {
  if (!pinned) {
    return { entries, scoped: false, whole: false };
  }
  const mine = entries.filter((e) => e.sessionId === pinned);
  // A complete scoped search requires at least one entry and whole-file coverage for every entry.
  return { entries: mine, scoped: true, whole: mine.length > 0 && mine.every((e) => e.whole === true) };
}

// Names the coverage of a completed search independently of the current selection.
export type SearchScopeName = 'workspace' | 'session' | 'sessionPart';

export function searchScopeName(scope: { scoped: boolean; whole: boolean }): SearchScopeName {
  if (!scope.scoped) {
    return 'workspace';
  }
  return scope.whole ? 'session' : 'sessionPart';
}

// Finds turns containing every search word in the same prompt or answer half.
// Results sort newest first. The first search word determines the snippet location.
export function searchTurns(entries: SearchEntry[], query: string, now: number = Date.now()): SearchHit[] {
  const { find, where, terms } = parseSessionQuery(query);
  if (!find.length) {
    return [];
  }
  const halves: ('prompt' | 'summary')[] = where === 'both' ? ['prompt', 'summary'] : [where];
  const hits: SearchHit[] = [];
  // Apply nonnumeric session terms to each search entry.
  // Entries have no spend or cache-expiry facts, so content search excludes those numeric filters.
  // Missing numeric fields must not be treated as recorded zero.
  const searchableTerms = terms.filter((term) => !NUMERIC_FIELDS.includes(term.field));
  const narrowed = searchableTerms.length
    ? entries.filter((e) => searchableTerms.every((t) => termHolds(t, e)))
    : entries;
  for (const entry of narrowed) {
    for (const half of halves) {
      const text = half === 'prompt' ? entry.prompt : entry.summary;
      if (!text) {
        continue;
      }
      const lower = text.toLowerCase();
      if (!find.every((word) => lower.includes(word))) {
        continue;
      }
      const snippet = snippetAround(text, find[0]);
      if (!snippet) {
        continue;
      }
      hits.push({
        key: entry.key,
        sessionId: entry.sessionId,
        sessionTitle: entry.sessionTitle,
        agent: entry.agent,
        startedAt: entry.startedAt,
        when: formatWhen(entry.startedAt, now),
        where: half,
        snippet,
        ranges: snippetRanges(snippet, find),
      });
      // Return one hit per turn, even when both text halves match.
      break;
    }
  }
  return hits.sort((a, b) => b.startedAt - a.startedAt);
}
