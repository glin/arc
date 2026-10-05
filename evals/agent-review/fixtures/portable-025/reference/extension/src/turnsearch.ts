// extension/src/turnsearch.ts
//
// Finding a turn or a session: the query language, what it matches, and the snippet a result shows.
//
// Split out of turnview.ts, which was 3,965 lines of pure functions with no shared state and
// no seam anyone could find. Nothing here was edited on the way: every declaration is the one
// that was there, in the order it was in. turnview.ts re-exports this module, so an import
// written against it still resolves.

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

// The answer half of a turn's search text. Every answer the turn closed joins it, or a
// search for words said in an earlier answer finds nothing; the summary still closes it
// for a turn whose newest text no response has closed yet.
//
// Left in the order the turn wrote them, which is not the order the card draws them in.
// Nobody reads this text: a hit is reported by the turn it is in and its snippet is cut
// from around the match, so the order decides nothing a reader can see, and the transcript's
// own order is the one that keeps a snippet spanning two answers reading forwards.
export function searchableSummary(turn: Pick<Turn, 'answers' | 'summary'>): string {
  const texts = turn.answers.map((a) => a.text);
  if (turn.summary && responseAnswerIndex(turn) < 0) {
    texts.push(turn.summary);
  }
  return texts.join('\n\n');
}

// The prompt half of a turn's search text. Everything the reader typed, not only the prompt
// the turn opened with, or a search for words typed while the turn ran finds nothing. The
// same rule as the answer half above, and for the same reason: the section on the card is
// named after everything the reader asked.
export function searchablePrompt(turn: Pick<Turn, 'prompt' | 'laterPrompts'>): string {
  return [turn.prompt, ...turn.laterPrompts.map((a) => a.text)].filter(Boolean).join('\n\n');
}

// One term read against one search entry. The archived and agent-run facts ride the entry
// beside its labels, so `is:archived` and `is:agentrun` narrow a content search the way they
// narrow the rail, and their negations exclude the same sessions. An entry carries no cost,
// no cache-expiry count, no turn state, no cache and no recency window, so a term over one of
// those holds for nothing here.
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

// One turn, reduced to the part of it a reader would search. Deliberately small: an id, where
// it came from, when, and the two pieces of text. No files, no usage, no recorded patches.
// That is what keeps a whole workspace's history to a few hundred kilobytes rather than the
// hundreds of megabytes it occupies on disk, and it is what makes searching it free.
export interface SearchEntry {
  key: string;
  sessionId: string;
  sessionTitle: string;
  agent: string;
  startedAt: number;
  prompt: string;
  summary: string;
  // Whether the read that produced this entry reached the beginning of its transcript.
  // Search reads its own window, which is neither the ordinary tail nor the older pages the
  // reader has loaded, so a scoped answer must not be worded as the whole session.
  whole?: boolean;
  // The labels the session carries, so a `label:` term beside `find:` narrows what is
  // read the way an `agent:` term does.
  //
  // Optional, and filled by the caller at the moment it searches rather than held with the
  // parsed text. Labels move when the reader presses a checkbox and the parsed text moves
  // when a transcript grows, so an entry that carried its labels through a cache keyed on a
  // file would answer with the labels the session had when it was last parsed.
  labels?: readonly string[];
  // Whether the reader archived this session, and whether an agent runs it.
  //
  // Optional, and filled by the caller at the moment it searches, for the reason the labels
  // are: the reader archives a session and an agent starts one on their own clock, so an
  // entry that carried either through a cache keyed on a file would answer with the facts
  // the session had when it was last parsed. A caller that hands in neither keeps no entry
  // under `is:archived` or `is:agentrun`.
  archived?: boolean;
  runByAgent?: boolean;
}

export interface SearchHit {
  key: string;
  sessionId: string;
  sessionTitle: string;
  agent: string;
  startedAt: number;
  when: string; // already worded, because the panel has no clock of its own
  where: 'prompt' | 'summary';
  snippet: string; // the line the query was found on
  // Where each searched word sits inside the snippet, as character positions, so the panel
  // can mark what matched without holding a copy of the matching rule.
  ranges: [number, number][];
}

// How much of a line to keep around the match. Enough to read the sentence it is in, and not
// so much that a result is a paragraph.
export const SNIPPET_BEFORE = 40;

export const SNIPPET_AFTER = 120;

// The line a needle was found on, cut to something a narrow list can draw.
//
// The line rather than a fixed window either side, because a summary is written in lines and a
// window that opens mid-sentence reads as noise. An ellipsis marks each end that was cut, so a
// snippet never reads as the whole of what was written.
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

// Every place any of the searched words appears in a snippet, as [from, to) character
// positions, sorted and with overlaps merged so the panel can walk them left to right.
// Case-insensitive the way the search itself is, and computed here rather than in the
// panel: the panel drawing a match it did not decide is what keeps one copy of the rule.
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

// The corpus a search reads while one session is pinned: that session alone.
//
// Pinning is the reader saying which session they are in, and a search typed there
// asks about it; a workspace-wide answer would bury the session's own turns under
// every other session's. It also keeps the expensive pass small: panelhost.ts narrows the
// corpus read by the same pin before the per-file reads, and this is the tested rule that
// says the narrowing is meant. The flag rides along so the panel can word the scope
// without holding a copy of the rule.
export function searchScope<T extends { sessionId: string; whole?: boolean }>(
  entries: T[],
  pinned: string | null,
): { entries: T[]; scoped: boolean; whole: boolean } {
  if (!pinned) {
    return { entries, scoped: false, whole: false };
  }
  const mine = entries.filter((e) => e.sessionId === pinned);
  // Every entry, because one turn read from a partial window makes the answer partial. An
  // empty scope is partial too: nothing proved that the search reached the first turn.
  return { entries: mine, scoped: true, whole: mine.length > 0 && mine.every((e) => e.whole === true) };
}

// Which of the three answers a finished search may give. The panel indexes its word tables
// by this name rather than choosing between them, because what a search covered is a fact
// about the read that ran and not about what is pinned when the reply lands.
export type SearchScopeName = 'workspace' | 'session' | 'sessionPart';

export function searchScopeName(scope: { scoped: boolean; whole: boolean }): SearchScopeName {
  if (!scope.scoped) {
    return 'workspace';
  }
  return scope.whole ? 'session' : 'sessionPart';
}

// The turns a content search finds, newest first.
//
// Every word has to appear, and in the same half of the turn, because a match spread across
// what the reader asked and what the agent answered is not a match for either question. The
// snippet comes from the first word, which is the one the reader typed first and the one they
// are most likely scanning for.
export function searchTurns(entries: SearchEntry[], query: string, now: number = Date.now()): SearchHit[] {
  const { find, where, terms } = parseSessionQuery(query);
  if (!find.length) {
    return [];
  }
  const halves: ('prompt' | 'summary')[] = where === 'both' ? ['prompt', 'summary'] : [where];
  const hits: SearchHit[] = [];
  // The session-level terms narrow the search too. `agent:codex find: patch` is one
  // question, not two, and a reader who names an agent and then searches expects the results
  // to be that agent's. Read against the entry rather than against a session list, because a
  // hit carries its session's name and agent with it and there is nothing else to match.
  // Search entries contain transcript text and stable session names, but no spend or
  // cache-expiry facts. The rail applies cost and cache-expiry filters to sessions. A content
  // search keeps reading its text terms instead of treating an absent numeric field as a
  // recorded zero.
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
      // One hit per turn: the same turn listed twice, once for each half, is one thing
      // reported as two.
      break;
    }
  }
  return hits.sort((a, b) => b.startedAt - a.startedAt);
}
