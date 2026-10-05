// Saved rail-wide filters and the query edits made by their picker.
//
// A saved rail filter narrows every existing section in place. It does not claim a
// session or create a section, which keeps it separate from SavedView.

import { labelKey } from './labels.ts';
import { normalizeRailSort, type RailSort } from './rail-sort.ts';
import {
  isQueryMatch,
  parseSessionQuery,
  queryTokens,
  quoteQueryValue,
  sameQueryTerms,
  type FilterTerm,
  type QueryMatch,
} from './session-query.ts';
import { cleanName } from './text.ts';
import { VIEW_NAME_LIMIT, VIEW_QUERY_LIMIT } from './views.ts';

export const RAIL_FILTER_NAME_LIMIT = VIEW_NAME_LIMIT;
export const RAIL_FILTER_QUERY_LIMIT = VIEW_QUERY_LIMIT;
export const ALL_RAIL_FILTER_ID = 'all';
// The saved filter id a build before rail lenses wrote while the rail sat on the Needs you
// lens. No saved filter may take it, so a stored panel state that names it reads as All
// sessions rather than as a saved filter.
const OLD_NEEDS_YOU_FILTER_ID = 'needs-you';
// The lens an older build stored beside a query while the Needs you count was pressed.
const OLD_NEEDS_YOU_LENS = 'needs-you';
// The words the Needs you count of an older build wrote. A query stored from that build still
// holds them as typed words, and the stored limit below keeps room for them.
const OLD_NEEDS_YOU_WORDS = 'is:needsyou -is:archived -is:agentrun';
export const RESERVED_RAIL_FILTER_NAMES = [
  'All sessions',
  'Running',
  'Active',
  'Unread',
  'Needs input',
  'Needs you',
  'Custom',
] as const;
const RESERVED_RAIL_FILTER_KEYS = new Set(RESERVED_RAIL_FILTER_NAMES.map((name) => railFilterKey(name)));

// The lenses the View menu's Filter row sets and the rail head's counts press: Running, Active,
// the recency lens, Unread, and Needs input. A press writes the lens's words into the query, the same
// words a reader could type, and the lens reads set while the query holds them. A `needs-you`
// lens an older build stored reads as no lens.
export type RailLens = 'running' | 'active' | 'unread' | 'input';
export const RAIL_LENSES: readonly RailLens[] = ['running', 'active', 'unread', 'input'];

// The words each lens writes. They drop a session the reader archived and one an agent runs,
// because neither is work the reader can pick up. The rail matches a lens's words apart from the
// rest of its query, so they combine with the rest as AND whatever the match mode.
export const RAIL_LENS_WORDS: Readonly<Record<RailLens, string>> = {
  running: 'is:running -is:archived -is:agentrun',
  active: 'is:active -is:archived -is:agentrun',
  unread: 'is:unread -is:archived -is:agentrun',
  input: 'is:input -is:archived -is:agentrun',
};

// The lenses that keep what they drew. A session the reader reads or answers leaves the lens's
// words and stays on the rail until the query changes. Running and Active do not keep, because
// each head row figure must equal what its press draws.
export const RAIL_KEEPING_LENSES: readonly RailLens[] = ['unread', 'input'];

// The longest query the rail stores and reads back. The box takes at most
// RAIL_FILTER_QUERY_LIMIT typed characters, and a lens press or a stored lens writes its words in
// front of them, so the stored limit holds the longest lens's words and the space after them as
// well. A press or a fold then never cuts a word the reader wrote. The older build's Needs you
// words count among them, so a query that build stored reads back whole.
export const RAIL_FILTER_STORED_QUERY_LIMIT =
  RAIL_FILTER_QUERY_LIMIT +
  Math.max(OLD_NEEDS_YOU_WORDS.length, ...RAIL_LENSES.map((lens) => RAIL_LENS_WORDS[lens].length)) +
  1;

export function isRailLens(raw: unknown): raw is RailLens {
  return RAIL_LENSES.includes(raw as RailLens);
}

// Whether a stored lens field holds a lens some build wrote: a lens this build knows, or the
// Needs you lens an older build wrote, which loads as no lens.
export function isStoredRailLens(raw: unknown): boolean {
  return isRailLens(raw) || raw === OLD_NEEDS_YOU_LENS;
}

// An absent or unknown lens reads as none, so a record written before the field existed keeps
// exactly the sessions its query kept.
function normalizeRailLens(raw: unknown): RailLens | null {
  return isRailLens(raw) ? raw : null;
}

export interface SavedRailFilter {
  id: string;
  name: string;
  query: string;
  match: QueryMatch;
  sort: RailSort;
}

export interface RailFilterLens {
  query: string;
  match: QueryMatch;
  sort: RailSort;
}

export function railFilterName(raw: unknown): string {
  return cleanName(raw, RAIL_FILTER_NAME_LIMIT);
}

export function railFilterKey(name: string): string {
  return name.toLocaleLowerCase();
}

export function boundedRailFilterQuery(raw: unknown): string {
  return typeof raw === 'string' ? raw.slice(0, RAIL_FILTER_STORED_QUERY_LIMIT) : '';
}

export function railFilterQuery(raw: unknown): string {
  return boundedRailFilterQuery(raw).trim();
}

// The name a saved filter takes when its stored name is one the rail now uses for itself, such
// as a filter the reader named Active before Active was a lens. The filter keeps its query
// under a name no built-in and no other saved filter holds.
function unreservedRailFilterName(name: string, taken: ReadonlySet<string>): string {
  for (let n = 1; ; n++) {
    const candidate = railFilterName(n === 1 ? `${name} (saved)` : `${name} (saved ${n})`);
    if (!taken.has(railFilterKey(candidate))) {
      return candidate;
    }
  }
}

export function normalizeSavedRailFilters(raw: unknown): SavedRailFilter[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const rows: { row: Record<string, unknown>; id: string; name: string }[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const row = entry as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id.trim().slice(0, 64) : '';
    const name = railFilterName(row.name);
    if (!id || id === ALL_RAIL_FILTER_ID || id === OLD_NEEDS_YOU_FILTER_ID || !name) {
      continue;
    }
    rows.push({ row, id, name });
  }
  // Every name a stored filter already holds, so a renamed filter never takes one of them.
  const held = new Set([...RESERVED_RAIL_FILTER_KEYS, ...rows.map(({ name }) => railFilterKey(name))]);
  const out: SavedRailFilter[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const { row, id, name: stored } of rows) {
    const name = RESERVED_RAIL_FILTER_KEYS.has(railFilterKey(stored)) ? unreservedRailFilterName(stored, held) : stored;
    const key = railFilterKey(name);
    if (ids.has(id) || names.has(key)) {
      continue;
    }
    held.add(key);
    ids.add(id);
    names.add(key);
    out.push({
      id,
      name,
      // A record saved while a lens was rail state carries it as a field. The lens's missing
      // words join the query, and every word the record held stays.
      query: foldRailLens(railFilterQuery(row.query), row.lens),
      match: isQueryMatch(row.match) ? row.match : 'all',
      sort: normalizeRailSort(row.sort),
    });
  }
  return out;
}

export function nextRailFilterId(filters: readonly SavedRailFilter[]): string {
  const taken = new Set(filters.map((filter) => filter.id));
  for (let n = 1; ; n++) {
    const id = `f${n}`;
    if (!taken.has(id)) {
      return id;
    }
  }
}

export function findRailFilter(filters: readonly SavedRailFilter[], id: string): SavedRailFilter | null {
  return filters.find((filter) => filter.id === id) ?? null;
}

export function normalizeRailFilterId(raw: unknown, filters: readonly SavedRailFilter[]): string {
  return typeof raw === 'string' && findRailFilter(filters, raw) ? raw : ALL_RAIL_FILTER_ID;
}

export function railFilterNameTaken(filters: readonly SavedRailFilter[], raw: string, exceptId = ''): boolean {
  const key = railFilterKey(railFilterName(raw));
  return (
    !!key &&
    (RESERVED_RAIL_FILTER_KEYS.has(key) ||
      filters.some((filter) => filter.id !== exceptId && railFilterKey(filter.name) === key))
  );
}

export function sameRailFilterLens(left: RailFilterLens, right: RailFilterLens): boolean {
  return left.query.trim() === right.query.trim() && left.match === right.match && left.sort === right.sort;
}

// The words the Warm count of a build before rail lenses wrote under All sessions.
const OLD_WARM_QUERY = 'is:warm -is:archived -is:agentrun';

export interface StoredRailLens {
  filterId: unknown;
  query: string;
  match: QueryMatch;
  // The lens a build that kept it as rail state stored beside the query.
  lens?: unknown;
}

export interface MigratedRailLens {
  filterId: unknown;
  query: string;
  match: QueryMatch;
}

// Reads the live rail filter a stored panel state names, and writes every lens an older build
// stored into the query as the words a press now writes. The old Needs you id loads as All
// sessions with its stored query and match, and a stored `needs-you` lens loads as no lens, so
// neither adds a word. The old Warm words under All sessions with all-term
// matching, the only match its press wrote, load as the Active words. A stored lens joins the
// query it was stored beside. A live `is:running` stays typed text, and a saved filter keeps
// its words.
export function migrateStoredRailLens(stored: StoredRailLens): MigratedRailLens {
  const wasNeedsYou = stored.filterId === OLD_NEEDS_YOU_FILTER_ID || stored.lens === OLD_NEEDS_YOU_LENS;
  const filterId = stored.filterId === OLD_NEEDS_YOU_FILTER_ID ? ALL_RAIL_FILTER_ID : stored.filterId;
  if (wasNeedsYou) {
    return { filterId, query: stored.query, match: stored.match };
  }
  const lens = normalizeRailLens(stored.lens);
  const allSessions = filterId === ALL_RAIL_FILTER_ID || filterId === '' || filterId === undefined;
  if (allSessions && lens === null && stored.match === 'all' && sameQueryTerms(stored.query, OLD_WARM_QUERY)) {
    return { filterId, query: RAIL_LENS_WORDS.active, match: 'all' };
  }
  return { filterId, query: foldRailLens(stored.query, lens), match: stored.match };
}

// A query with the words of a lens an older build stored beside it. The fold only adds, so every
// word the query already holds stays. A query stored with no lens, or with a lens this build
// does not know, keeps its words as they are.
function foldRailLens(query: string, stored: unknown): string {
  const lens = normalizeRailLens(stored);
  return lens === null ? query : withRailLensWords(query, lens);
}

// One query word as the parser reads it, sign included, or null for a word that is not a
// single term, such as a `find:` word.
function termKey(word: string): string | null {
  const { terms } = parseSessionQuery(word);
  if (terms.length !== 1) {
    return null;
  }
  const [term] = terms;
  return `${term.negated === true ? '-' : ''}${term.field}:${term.needle}`;
}

// Each word of a query, as written, beside the term key the parser reads from it.
function queryWords(query: string): { text: string; key: string | null }[] {
  return queryTokens(query).map((token) => {
    const text = query.slice(token.start, token.end);
    return { text, key: termKey(text) };
  });
}

// Whether the query holds every word of this lens, in any order and beside any other words.
export function railQueryHoldsLens(query: string, lens: RailLens): boolean {
  const held = new Set(queryWords(query).map((word) => word.key));
  return queryWords(RAIL_LENS_WORDS[lens]).every((word) => held.has(word.key));
}

// Every lens the query holds whole, in RAIL_LENSES order. A press leaves at most one, and a
// reader can still type the words of two.
export function railQueryLenses(query: string): RailLens[] {
  const held = new Set(queryWords(query).map((word) => word.key));
  return RAIL_LENSES.filter((lens) => railLensKeys(lens).every((key) => held.has(key)));
}

// The one lens the query holds whole, beside any other words, or null. The Filter row checks
// it and the head row draws its count pressed. No press writes two lenses, so a query that holds two
// whole was typed or stored by an older build. It holds no lens and keeps the meaning the
// grammar gives it.
export function railQueryHeldLens(query: string): RailLens | null {
  const lenses = railQueryLenses(query);
  return lenses.length === 1 ? lenses[0] : null;
}

// The lens the query holds and nothing else, in any order, or null. The funnel names the rail
// for this lens rather than Custom. A word the parser reads as no term, such as an unknown
// status, is still a word beside the lens's words.
export function railQueryLens(query: string): RailLens | null {
  if (queryWords(query).some((word) => word.key === null)) {
    return null;
  }
  return RAIL_LENSES.find((lens) => sameQueryTerms(query, RAIL_LENS_WORDS[lens])) ?? null;
}

function railLensKeys(lens: RailLens): (string | null)[] {
  return queryWords(RAIL_LENS_WORDS[lens]).map((word) => word.key);
}

// The query without any copy of these words, with each other word kept as the reader wrote it.
function withoutWords(query: string, drop: ReadonlySet<string | null>): string {
  return queryWords(query)
    .filter((word) => word.key === null || !drop.has(word.key))
    .map((word) => word.text)
    .join(' ');
}

// The query without the words of the one lens it holds whole. A query that holds no lens, or
// two lenses whole, comes back as it was.
export function withoutRailLenses(query: string): string {
  const held = railQueryHeldLens(query);
  return held === null ? query : withoutWords(query, new Set(railLensKeys(held)));
}

// The query with every word of this lens. The missing words lead, and every word the query
// already holds stays where the reader put it.
function withRailLensWords(query: string, lens: RailLens): string {
  const held = new Set(queryWords(query).map((word) => word.key));
  const words = queryWords(RAIL_LENS_WORDS[lens])
    .filter((word) => !held.has(word.key))
    .map((word) => word.text);
  return [...words, query.trim()].filter(Boolean).join(' ');
}

// The query with the lens's words, or with none. No lens takes out the words of every lens the
// query holds whole, two or more included, so All returns the rail to every session. The rail
// holds at most one lens, so the lens asked for adds the words the query lacks, then takes out
// each word of another lens that the result holds whole. The lenses share
// `-is:archived -is:agentrun`, so a typed `is:unread` beside the Needs input words would complete
// the Unread lens, and it leaves. A word the lens asked for also writes stays where the reader
// put it, and every other word stays.
export function withRailLens(query: string, lens: RailLens | null): string {
  if (lens === null) {
    return withoutWords(query, new Set(railQueryLenses(query).flatMap((held) => railLensKeys(held))));
  }
  const written = withRailLensWords(query, lens);
  const keep = new Set(railLensKeys(lens));
  const drop = new Set(
    railQueryLenses(written)
      .filter((other) => other !== lens)
      .flatMap((other) => railLensKeys(other))
      .filter((key) => !keep.has(key)),
  );
  return drop.size ? withoutWords(written, drop) : written;
}

// What a count press writes. A press on the lens the query holds removes its words, and a press
// on any other lens sets it in place of any other. Every other word stays.
export function pressRailLens(query: string, lens: RailLens): string {
  return railQueryHeldLens(query) === lens ? withoutRailLenses(query) : withRailLens(query, lens);
}

// Whether one parsed term names this value, whatever sign the reader gave it.
function termNames(term: FilterTerm, field: 'labels', value: string): boolean {
  return term.field === field && labelKey(term.needle) === labelKey(value);
}

// Whether the query keeps the sessions this term names. A negated term asks for the ones it
// drops, so the View menu's chip for it stays unpressed and its press leaves the negated word
// where the reader put it.
export function railFilterTermSelected(query: string, field: 'labels', value: string): boolean {
  return parseSessionQuery(query).terms.some((term) => term.negated !== true && termNames(term, field, value));
}

// Whether the query already drops the sessions this term names. The View menu offers no chip
// for such a value: pressing it would write the term beside its own negation, and the rail would
// empty with nothing on screen saying why.
export function railFilterTermNegated(query: string, field: 'labels', value: string): boolean {
  return parseSessionQuery(query).terms.some((term) => term.negated === true && termNames(term, field, value));
}

// Toggle one label term while preserving every other query word. The parser supplies decoded
// token bounds, so a quoted label follows the same grammar as matching.
export function toggleRailFilterTerm(query: string, field: 'labels', value: string): string {
  const remove = queryTokens(query).filter((token) => {
    const parsed = parseSessionQuery(query.slice(token.start, token.end)).terms;
    return parsed.some((term) => term.negated !== true && termNames(term, field, value));
  });
  if (remove.length) {
    const starts = new Set(remove.map((token) => token.start));
    return queryTokens(query)
      .filter((token) => !starts.has(token.start))
      .map((token) => query.slice(token.start, token.end))
      .join(' ');
  }
  const token = `label:${quoteQueryValue(value)}`;
  return [query.trim(), token].filter(Boolean).join(' ');
}
