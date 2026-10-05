// Formats durations, local times, token counts, byte counts, and model names.
// `turnview.ts` re-exports these helpers for existing callers.

export {
  formatCompactRelative,
  formatDuration,
  formatRelative,
  RELATIVE_STEPS,
  RELATIVE_UNDER_A_MINUTE,
} from './view/time.ts';
export type { RelativeStep } from './view/time.ts';
export { formatTokens } from './view/tokens.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatClock(at: number): string {
  const d = new Date(at);
  const h = d.getHours();
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

// The day, or null when the turn is from today and the clock alone is enough.
export function formatDay(at: number, now: number = Date.now()): string | null {
  const d = new Date(at);
  if (d.toDateString() === new Date(now).toDateString()) {
    return null;
  }
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

// Removes the Claude model prefix and trailing snapshot date.
export function shortModel(model: string | null): string | null {
  if (!model) {
    return null;
  }
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

// Formats binary megabytes with one decimal below 10 MB and whole numbers above it.
// Rounded values at or above 1024 MB use gigabytes, so 1023.6 MB displays as `1 GB`.
export function formatMegabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 10) {
    const whole = Math.round(mb);
    if (whole >= 1024) {
      return `${Number((whole / 1024).toFixed(1))} GB`;
    }
    return `${whole} MB`;
  }
  const tenths = Math.round(mb * 10) / 10;
  // Keep a positive byte count visible when rounding to tenths would produce zero.
  if (tenths === 0 && bytes > 0) {
    return `${Number(mb.toPrecision(1))} MB`;
  }
  return `${tenths} MB`;
}

// When a session was last active, for the picker. A clock alone reads as today, so
// anything older names its day, and anything from another year names that too.
export function formatWhen(at: number, now: number = Date.now()): string {
  const day = formatDay(at, now);
  if (!day) {
    return formatClock(at);
  }
  const year = new Date(at).getFullYear();
  const suffix = year === new Date(now).getFullYear() ? '' : ` ${year}`;
  return `${day}${suffix} ${formatClock(at)}`;
}
