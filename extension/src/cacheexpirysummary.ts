import type { CacheTier } from './pricing';

export interface CacheExpirySummary {
  counts: Record<CacheTier, number>;
  longestGap: number | null;
  excluded: number;
  unavailable: number;
}

export function combineCacheExpiryAmounts(
  items: readonly { dollars: number | null; partial: boolean }[],
  withholdUnknown = false,
): { dollars: number | null; partial: boolean } {
  const known = items.filter((item) => item.dollars !== null);
  const partial = items.some((item) => item.partial || item.dollars === null);
  return {
    dollars:
      (withholdUnknown && partial) || (!known.length && items.length)
        ? null
        : known.reduce((sum, item) => sum + item.dollars!, 0),
    partial,
  };
}

// Combine independently classified sources without creating cross-source request neighbors.
export function combineCacheExpirySummaries(items: readonly CacheExpirySummary[]): CacheExpirySummary {
  const combined: CacheExpirySummary = {
    counts: { '5m': 0, '30m': 0, '1h': 0 },
    longestGap: null,
    excluded: 0,
    unavailable: 0,
  };
  for (const item of items) {
    for (const lifetime of ['5m', '30m', '1h'] as const) combined.counts[lifetime] += item.counts[lifetime];
    if (item.longestGap !== null) combined.longestGap = Math.max(combined.longestGap ?? 0, item.longestGap);
    combined.excluded += item.excluded;
    combined.unavailable += item.unavailable;
  }
  return combined;
}
