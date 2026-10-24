export interface ProjectSpendWindow {
  id: string;
  label: string;
  display: string;
  status: string;
  unpricedRequests?: unknown;
}

export interface ProjectSpendCategory {
  id: string;
  label: string;
  windows?: readonly ProjectSpendWindow[];
}

export interface ProjectSpendRateSource {
  source: string;
  effectiveDate: string | null;
  provenance: string;
}

export interface ProjectSpend {
  name: string;
  calculating?: boolean;
  windows?: readonly ProjectSpendWindow[];
  categories?: readonly ProjectSpendCategory[];
  earliestRecord?: string | null;
  lastIndexedAt?: number | null;
  indexing?: boolean;
  indexingStatus?: string | null;
  rateSources?: readonly ProjectSpendRateSource[];
}

export interface ProjectSpendFace {
  label: string;
  value: string;
  when: string;
  quiet: boolean;
}

export const PROJECT_SPEND_INDEXING_SHOW_MS = 1500;
export const PROJECT_SPEND_INDEXING_HOLD_MS = 4000;
export const PROJECT_SPEND_WHEN: Record<string, string> = {
  today: 'today',
  sevenDays: '· 7d',
  thirtyDays: '· 30d',
};
export const PROJECT_SPEND_RATE_ORDER: Record<string, number> = { reported: 0, configured: 1 };

export function projectSpendWindow(rows: unknown, id: string): ProjectSpendWindow | null {
  return Array.isArray(rows) ? (rows.find((row) => row.id === id) ?? rows[0] ?? null) : null;
}

export function projectSpendCategory(spend: { categories?: unknown }, id: string): ProjectSpendCategory | null {
  return Array.isArray(spend.categories) ? (spend.categories.find((category) => category.id === id) ?? null) : null;
}

export function projectSpendDate(localDate: unknown, withYear = false): string {
  const parts = typeof localDate === 'string' ? localDate.split('-').map(Number) : [];
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) {
    return '';
  }
  const shape: Intl.DateTimeFormatOptions = withYear
    ? { year: 'numeric', month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric' };
  return new Date(parts[0], parts[1] - 1, parts[2]).toLocaleDateString(undefined, shape);
}

export function projectSpendAgentName(label: unknown): string {
  return String(label == null ? '' : label).replace(/ spend$/, '');
}

export function projectSpendFace(
  spend: Pick<ProjectSpend, 'name' | 'calculating'>,
  window: ProjectSpendWindow,
  place: string,
): ProjectSpendFace {
  // The compact bar shows the figure alone. The dollar sign names it, and the button's
  // accessible name carries the full label.
  const label = place === 'compact' ? '' : spend.name;
  if (spend.calculating) {
    return { label, value: 'Calculating…', when: '', quiet: true };
  }
  return {
    label,
    value: window.display,
    when: PROJECT_SPEND_WHEN[window.id] ?? '',
    quiet: window.status === 'unknown',
  };
}

export function projectSpendRateRank(provenance: string): number {
  const rank = PROJECT_SPEND_RATE_ORDER[provenance];
  return Number.isFinite(rank) ? rank : 2;
}

export function projectSpendRatePhrase(source: ProjectSpendRateSource): string {
  return source.provenance === 'reported' ? 'Provider-reported, where recorded' : source.source;
}

export function projectSpendRateLines(rateSources: unknown): string[] {
  const sources = (Array.isArray(rateSources) ? rateSources : []).slice().sort((a, b) => {
    const rank = projectSpendRateRank(a.provenance) - projectSpendRateRank(b.provenance);
    if (rank) {
      return rank;
    }
    const firstName = String(a.source);
    const secondName = String(b.source);
    if (firstName !== secondName) {
      return firstName < secondName ? -1 : 1;
    }
    const firstDate = String(a.effectiveDate ?? '');
    const secondDate = String(b.effectiveDate ?? '');
    return firstDate < secondDate ? -1 : firstDate > secondDate ? 1 : 0;
  });
  return sources.map((source) => {
    const when = projectSpendDate(source.effectiveDate, true);
    return projectSpendRatePhrase(source) + (when ? `, effective ${when}` : '');
  });
}

export function projectSpendIndexingRun(indexing: boolean, busySince: number, now: number): boolean {
  return indexing && busySince > 0 && now - busySince >= PROJECT_SPEND_INDEXING_SHOW_MS;
}

export function projectSpendIndexingWord(indexing: boolean, busySince: number, wordAt: number, now: number): boolean {
  return (
    projectSpendIndexingRun(indexing, busySince, now) || (wordAt > 0 && now - wordAt < PROJECT_SPEND_INDEXING_HOLD_MS)
  );
}

export function projectSpendWordMark(indexing: boolean, shown: boolean, wordAt: number, now: number): number {
  return indexing && shown ? now : wordAt;
}

export function projectSpendWordWake(busySince: number, wordAt: number, now: number): number {
  const next =
    busySince > 0
      ? busySince + PROJECT_SPEND_INDEXING_SHOW_MS
      : wordAt > 0
        ? wordAt + PROJECT_SPEND_INDEXING_HOLD_MS
        : 0;
  return next > now ? next : 0;
}

export function projectSpendFaceName(
  spend: Pick<ProjectSpend, 'name'>,
  window: Pick<ProjectSpendWindow, 'label'>,
  face: ProjectSpendFace,
  open: boolean,
): string {
  return `${spend.name}, ${face.when ? `${window.label} ` : ''}${face.value}, ${open ? 'Hide cost details' : 'Show cost details'}`;
}
