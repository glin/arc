// Browser-safe presentation values derived from session queries.

import {
  ACTIVE_PREFIX,
  activeWindowValue,
  FIND_PREFIX,
  IS_PREFIX,
  IS_VALUES,
  LABEL_PREFIX,
  parseSessionQuery,
  queryTokens,
  sessionQueryError,
  resolveSessionQuery,
  type SessionQueryContext,
  quoteQueryValue,
  type ActiveWindow,
  type QueryToken,
  type SearchWhere,
  WHERE_PREFIX,
} from '../domain/session-query.ts';
import { labelKey } from '../domain/labels.ts';
import { railHeldLensTokens, railQueryActiveWindow, railQueryHeldLens, type RailLens } from '../domain/rail-filters.ts';

export interface LabelSuggestionCount {
  name: string;
  count: number;
  countName: string;
}

export const SEARCH_WHERE_UNKNOWN = 'was not understood. Use in:prompt, in:summary or in:both.';
export const COST_UNKNOWN = 'was not understood. Use cost:>5.43 or cost:<5.43.';
export const CACHE_EXPIRY_UNKNOWN = 'was not understood. Use cache-expiry:>0 or cache-expiry:<3.';
// Build invalid-status guidance from IS_VALUES, the same list used by query completion.
export const IS_UNKNOWN = `was not understood. Use ${IS_VALUES.map((status) => `${IS_PREFIX}:${status}`)
  .slice(0, -1)
  .join(', ')} or ${IS_PREFIX}:${IS_VALUES[IS_VALUES.length - 1]}.`;

export function whereNote(query: string): string | null {
  const unknown = parseSessionQuery(query).unknownWhere;
  if (!unknown.length) {
    return null;
  }
  return `${WHERE_PREFIX}:${unknown[0]} ${SEARCH_WHERE_UNKNOWN}`;
}

export function costNote(query: string): string | null {
  const invalid = parseSessionQuery(query).terms.find((term) => term.field === 'cost' && !term.comparison);
  return invalid ? `cost:${invalid.needle} ${COST_UNKNOWN}` : null;
}

export function cacheExpiryNote(query: string): string | null {
  const invalid = parseSessionQuery(query).terms.find((term) => term.field === 'cache-expiry' && !term.comparison);
  return invalid ? `cache-expiry:${invalid.needle} ${CACHE_EXPIRY_UNKNOWN}` : null;
}

export const ACTIVE_UNKNOWN = `names no window. Use ${ACTIVE_PREFIX}:6h, ${ACTIVE_PREFIX}:2d or ${ACTIVE_PREFIX}:today.`;

// The first `active:` word that names no window, spelled as the reader typed it, quotes included.
export function activeNote(query: string): string | null {
  for (const token of queryTokens(query)) {
    const text = query.slice(token.start, token.end);
    const terms = parseSessionQuery(text).terms;
    if (terms.length === 1 && terms[0].field === 'active' && !terms[0].activeWindow) {
      return `${text} ${ACTIVE_UNKNOWN}`;
    }
  }
  return null;
}

export function sessionIdentityNote(query: string, context?: SessionQueryContext): string | null {
  return resolveSessionQuery(query, context).notes.join(' ') || null;
}

export function isNote(query: string): string | null {
  const invalid = sessionQueryError(query);
  if (invalid) return invalid;
  const unknown = parseSessionQuery(query).unknownIs;
  return unknown.length ? `${unknown[0]} ${IS_UNKNOWN}` : null;
}

// Build one label query term for session list suggestions and session heading labels.
// Quote spaces so the matcher reads the full label, without introducing a title term.
export function labelFilterToken(name: string): string {
  return `${LABEL_PREFIX}:${quoteQueryValue(name)}`;
}

export function labelSuggestions<T extends LabelSuggestionCount>(
  counts: readonly T[],
  value: string,
): (T & { token: string })[] {
  const needle = labelKey(value);
  return counts
    .flatMap((entry) => {
      const name = labelKey(entry.name);
      if (!name.includes(needle)) {
        return [];
      }
      const tier = name === needle ? 0 : name.startsWith(needle) ? 1 : 2;
      return [{ entry, tier }];
    })
    .sort((left, right) => left.tier - right.tier)
    .map(({ entry }) => ({ ...entry, token: labelFilterToken(entry.name) }));
}

// How many label chips the View menu draws before it folds the rest behind one chip.
export const RAIL_MENU_LABEL_FOLD = 12;

export interface RailMenuLabelChips<T> {
  chips: T[];
  // How many labels the fold hides, or null when the menu draws no fold chip.
  more: number | null;
}

// Sort View menu labels by usage, then name. Fold after twelve unless expanded.
// A find query shows all matching labels without folding.
export function railMenuLabelChips<T extends LabelSuggestionCount>(
  labels: readonly T[],
  find: string,
  expanded: boolean,
): RailMenuLabelChips<T> {
  const needle = labelKey(find);
  const ordered = labels
    .filter((label) => labelKey(label.name).includes(needle))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
  if (needle || ordered.length <= RAIL_MENU_LABEL_FOLD) {
    return { chips: ordered, more: null };
  }
  return {
    chips: expanded ? ordered : ordered.slice(0, RAIL_MENU_LABEL_FOLD),
    more: ordered.length - RAIL_MENU_LABEL_FOLD,
  };
}

export interface RailTermWords {
  lens: Readonly<Record<RailLens, string>>;
  // An Active window as words, such as "in the last 6 hours".
  windowPhrase: (window: ActiveWindow) => string;
  not: string;
}

// One query term as the filter box draws it while the input does not hold focus.
export interface RailQueryTerm {
  text: string;
  // What follows the name after a separator, such as an Active lens's window.
  detail: string | null;
  // The term in words, for the name of its remove button.
  name: string;
  negated: boolean;
  // Text with no term to remove, such as a `find:` word or a word the parser does not read.
  removable: boolean;
  // Every query word the term stands for. A lens's words can stand apart.
  covers: readonly QueryToken[];
}

function railPlainTerm(text: string, token: QueryToken): RailQueryTerm {
  return { text, detail: null, name: text, negated: false, removable: false, covers: [token] };
}

// Whether the words either side of an `OR` join into one session term, as the parser joins them.
function joinsSessionTerm(left: string, right: string): boolean {
  const { terms } = parseSessionQuery(`${left} OR ${right}`);
  return terms.length === 1 && terms[0].field === 'session' && !terms[0].invalid;
}

// The query as the terms the filter box draws, in query order. A held lens is one term at the
// place of its first word. After a `find:` word, plain words are search text, as the parser reads them.
export function railQueryTerms(query: string, words: RailTermWords): RailQueryTerm[] {
  const tokens = queryTokens(query);
  const textOf = (at: number): string => query.slice(tokens[at].start, tokens[at].end);
  const lens = railQueryHeldLens(query);
  const lensCovers = railHeldLensTokens(query);
  const lensStarts = new Set(lensCovers.map((token) => token.start));
  const terms: RailQueryTerm[] = [];
  let lensDrawn = false;
  let searching = false;
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at];
    if (lensStarts.has(token.start)) {
      if (!lensDrawn && lens !== null) {
        lensDrawn = true;
        const window = lens === 'active' ? railQueryActiveWindow(query) : null;
        terms.push({
          text: words.lens[lens],
          detail: window ? activeWindowValue(window) : null,
          name: window ? `${words.lens[lens]} ${words.windowPhrase(window)}` : words.lens[lens],
          negated: false,
          removable: true,
          covers: lensCovers,
        });
      }
      continue;
    }
    if (token.prefix === FIND_PREFIX) {
      searching = true;
    }
    let end = at;
    while (end + 2 < tokens.length && textOf(end + 1) === 'OR' && joinsSessionTerm(textOf(end), textOf(end + 2))) {
      end += 2;
    }
    if (end > at) {
      const text = query.slice(token.start, tokens[end].end);
      terms.push({
        text,
        detail: null,
        name: text,
        negated: false,
        removable: true,
        covers: tokens.slice(at, end + 1),
      });
      at = end;
      continue;
    }
    const written = textOf(at);
    const parsed = parseSessionQuery(written).terms;
    if (parsed.length !== 1 || (searching && parsed[0].plain)) {
      terms.push(railPlainTerm(written, token));
      continue;
    }
    const [term] = parsed;
    const negated = term.negated === true;
    const own = term.field === 'labels' ? term.needle : negated ? written.slice(1) : written;
    const text = negated ? `${words.not} ${own}` : own;
    terms.push({ text, detail: null, name: text, negated, removable: true, covers: [token] });
  }
  return terms;
}

// The query without the words this term covers. Every other word keeps its place and its spelling.
export function withoutRailQueryTerm(query: string, term: RailQueryTerm): string {
  const covered = new Set(term.covers.map((token) => token.start));
  return queryTokens(query)
    .filter((token) => !covered.has(token.start))
    .map((token) => query.slice(token.start, token.end))
    .join(' ');
}

export interface RailTermFold {
  shown: number;
  // How many terms fold behind the more button.
  more: number;
}

// How many leading terms fit on one line. The first term always shows, and every hidden term
// counts toward the more button, which folds with its own width and one gap.
export function railTermFold(widths: readonly number[], room: number, gap: number, moreWidth: number): RailTermFold {
  const line = (count: number): number =>
    widths.slice(0, count).reduce((sum, width) => sum + width, 0) + gap * Math.max(0, count - 1);
  if (line(widths.length) <= room) {
    return { shown: widths.length, more: 0 };
  }
  let shown = Math.min(1, widths.length);
  for (let count = shown + 1; count < widths.length; count++) {
    if (line(count) + gap + moreWidth <= room) {
      shown = count;
    }
  }
  return { shown, more: widths.length - shown };
}

export type { SearchWhere };
