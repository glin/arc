// extension/src/turnformat.ts
//
// How a duration, a moment, a token count, a size and a model name are spelled on screen.
//
// Split out of turnview.ts, which was 3,965 lines of pure functions with no shared state and
// no seam anyone could find. Nothing here was edited on the way: every declaration is the one
// that was there, in the order it was in. turnview.ts re-exports this module, so an import
// written against it still resolves.

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

// Model ids are long and share a prefix; the part that tells them apart is the tail.
export function shortModel(model: string | null): string | null {
  if (!model) {
    return null;
  }
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

// A byte count as the reader thinks of it. Whole megabytes at the default, and one decimal
// for a reader who set a tail of their own, because rounding 0.5 MB to 0 is a lie.
//
// The tail is a setting, so the size it names has no ceiling the panel controls. Past 1024
// megabytes the megabyte is the wrong unit. The gigabyte is tested against the rounded
// figure, so 1023.6 MB reads `1 GB` and never `1024 MB`.
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
  // A tail under a tenth of a megabyte is the same lie one step smaller, so a count of real
  // bytes keeps enough of a decimal to read as the size it is.
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
