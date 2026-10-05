// Browser-safe rail ordering values and names.

export const RAIL_SORTS = ['latest', 'cost-desc', 'cost-asc', 'needs-you'] as const;
export type RailSort = (typeof RAIL_SORTS)[number];
export type SavedViewSort = 'inherit' | RailSort;

export function normalizeRailSort(raw: unknown): RailSort {
  return RAIL_SORTS.includes(raw as RailSort) ? (raw as RailSort) : 'latest';
}

export function normalizeSavedViewSort(raw: unknown): SavedViewSort {
  return raw === 'inherit' ? raw : normalizeRailSort(raw) === raw ? (raw as RailSort) : 'inherit';
}

export function railSortName(sort: RailSort): string {
  return {
    latest: 'Latest update',
    'cost-desc': 'Cost, highest first',
    'cost-asc': 'Cost, lowest first',
    'needs-you': 'Needs you first',
  }[sort];
}

export function railSortShortName(sort: RailSort): string {
  return { latest: 'Latest', 'cost-desc': 'Cost \u2193', 'cost-asc': 'Cost \u2191', 'needs-you': 'Needs you' }[sort];
}
