export interface RelativeStep {
  unitSeconds: number;
  max: number | null;
  singular: string;
  plural: string;
}

// The upper tiers use a 30-day month and a 12-of-those year. The boundaries therefore hand
// over at a count of 1: 35 days becomes 1 month, and 360 days becomes 1 year.
export const RELATIVE_STEPS: RelativeStep[] = [
  { unitSeconds: 60, max: 59, singular: 'min', plural: 'mins' },
  { unitSeconds: 3600, max: 23, singular: 'hour', plural: 'hours' },
  { unitSeconds: 86400, max: 6, singular: 'day', plural: 'days' },
  { unitSeconds: 604800, max: 4, singular: 'week', plural: 'weeks' },
  { unitSeconds: 2592000, max: 11, singular: 'month', plural: 'months' },
  { unitSeconds: 31104000, max: null, singular: 'year', plural: 'years' },
];

const COMPACT_RELATIVE_UNITS = ['m', 'h', 'd', 'w', 'mo', 'y'] as const;

export const RELATIVE_UNDER_A_MINUTE = 'just now';

export function formatRelative(at: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < RELATIVE_STEPS[0].unitSeconds) {
    return RELATIVE_UNDER_A_MINUTE;
  }
  for (const step of RELATIVE_STEPS) {
    const count = Math.floor(seconds / step.unitSeconds);
    if (step.max === null || count <= step.max) {
      return `${count} ${count === 1 ? step.singular : step.plural} ago`;
    }
  }
  return RELATIVE_UNDER_A_MINUTE;
}

// Cache estimates switch to cold 90 seconds before inferred expiry. Spans under two minutes use near-boundary wording.
export const CACHE_SPAN_MINIMUM_SECONDS = 120;

// Format cache lifetime or time since expiry using compact relative units, without ago or seconds.
export function formatCacheSpan(ms: number): string {
  const seconds = Math.max(CACHE_SPAN_MINIMUM_SECONDS, Math.floor(ms / 1000));
  for (let i = 0; i < RELATIVE_STEPS.length; i += 1) {
    const step = RELATIVE_STEPS[i];
    const count = Math.floor(seconds / step.unitSeconds);
    if (step.max === null || count <= step.max) {
      return `${count}${COMPACT_RELATIVE_UNITS[i]}`;
    }
  }
  return `${CACHE_SPAN_MINIMUM_SECONDS / 60}m`;
}

// Format elapsed time with a space between hours and unpadded minutes. Two hours and eight minutes reads 2h 8m.
// Round minutes before splitting hours, so 1h59m30s reads 2h 0m.
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// Share compactRelativeStep between compact spans and short ages, keeping counts and unit letters consistent.
// Test each bounded step before handling the final unbounded step.
function compactRelativeStep(seconds: number): { count: number; unit: string } {
  for (let i = 0; i < RELATIVE_STEPS.length - 1; i += 1) {
    const step = RELATIVE_STEPS[i];
    const count = Math.floor(seconds / step.unitSeconds);
    if (count <= step.max!) {
      return { count, unit: COMPACT_RELATIVE_UNITS[i] };
    }
  }
  const last = RELATIVE_STEPS.length - 1;
  return { count: Math.floor(seconds / RELATIVE_STEPS[last].unitSeconds), unit: COMPACT_RELATIVE_UNITS[last] };
}

export function formatCompactRelative(at: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < RELATIVE_STEPS[0].unitSeconds) {
    return 'now';
  }
  const { count, unit } = compactRelativeStep(seconds);
  return `${count}${unit} ago`;
}

// A compact row's age: no `ago`, so it reads beside the state slot rather than as a
// sentence. Under a minute it prints `now`.
export function formatRelativeShort(at: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < RELATIVE_STEPS[0].unitSeconds) {
    return 'now';
  }
  const { count, unit } = compactRelativeStep(seconds);
  return `${count}${unit}`;
}
