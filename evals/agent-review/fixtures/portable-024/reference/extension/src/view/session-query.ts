// Browser-safe presentation values derived from session queries.

import {
  IS_PREFIX,
  IS_VALUES,
  LABEL_PREFIX,
  parseSessionQuery,
  quoteQueryValue,
  type SearchWhere,
  WHERE_PREFIX,
} from '../domain/session-query.ts';
import { labelKey } from '../domain/labels.ts';

export interface LabelSuggestionCount {
  name: string;
  count: number;
  countName: string;
}

export const SEARCH_WHERE_UNKNOWN = 'was not understood. Use in:prompt, in:summary or in:both.';
export const COST_UNKNOWN = 'was not understood. Use cost:>5.43 or cost:<5.43.';
export const CACHE_EXPIRY_UNKNOWN = 'was not understood. Use cache-expiry:>0 or cache-expiry:<3.';
// The correction names every value the grammar takes, read off the one list the completion
// offers, so a value added to the grammar reaches the correction with it.
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

export function isNote(query: string): string | null {
  const unknown = parseSessionQuery(query).unknownIs;
  return unknown.length ? `${unknown[0]} ${IS_UNKNOWN}` : null;
}

// The query text that files one label, written once for every control that offers one.
//
// Two controls write it: a row of the rail filter's own suggestions, and a chip on the
// session heading. A label carrying a space needs its quotes, or the grammar reads the
// second word as a title term, and a rule at each end is two answers to one question.
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

// The View menu's label chips: most used first, then by name, folded after twelve.
//
// Text in the find box shows every label it matches and draws no fold chip, because a reader
// who typed part of a name is looking for that label and a fold would hide it.
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

export type { SearchWhere };
