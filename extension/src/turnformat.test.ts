// extension/src/turnformat.test.ts
//
// The tests for turnformat.ts. One that reads a second seam's names lives in turnview.test.ts
// instead, because neither file owns it. The builders a test is written against are here
// while only this file needs them, and in turnfixtures.ts once a second file does.
import { test } from 'vitest';
import assert from 'node:assert';
import {
  formatClock,
  formatDay,
  formatDuration,
  formatMegabytes,
  formatRelative,
  formatTokens,
  formatWhen,
  shortModel,
} from './turnformat.ts';
import { MB, NOW } from './turnfixtures.ts';

test('durations and token counts read at a glance', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(43_000), '43s');
  assert.equal(formatDuration(94_000), '2m');
  assert.equal(formatDuration(4_933_000), '1h 22m');
  assert.equal(formatTokens(940), '940');
  assert.equal(formatTokens(236_000), '236k');
  assert.equal(formatTokens(1_500_000), '1.5M');
});

test('a count that rounds up past its unit is said in the unit above it', () => {
  // The boundary itself. A count just under a million rounds to a thousand thousands, and
  // a thousand of a unit is one of the unit above it.
  assert.equal(formatTokens(999_500), '1M');
  assert.equal(formatTokens(999_999), '1M');
  assert.equal(formatTokens(1_000_000), '1M');
  // Just below the boundary, where the thousand is still the right unit.
  assert.equal(formatTokens(999_499), '999k');
  // The same boundary one unit up.
  assert.equal(formatTokens(999_950_000), '1B');
  assert.equal(formatTokens(1_000_000_000), '1B');
  assert.equal(formatTokens(999_949_000), '999.9M');
  // No unit reads as a count of a thousand or more of itself, at any size the panel can
  // be handed.
  for (const n of [0, 1, 999, 1000, 999_499, 999_500, 1_000_000, 999_949_000, 999_950_000, 4_500_000_000]) {
    assert.doesNotMatch(formatTokens(n), /^\d{4,}(\.\d)?[kMB]$/, `${n} reads in the wrong unit`);
  }
});

test('formatRelative counts up through minutes, hours, days, weeks, months and years', () => {
  const now = new Date(2026, 7, 23, 20, 0).getTime();
  const secondsAgo = (s: number) => now - s * 1000;
  const day = 24 * 3600;
  assert.equal(formatRelative(secondsAgo(59), now), 'just now');
  assert.equal(formatRelative(secondsAgo(60), now), '1 min ago');
  assert.equal(formatRelative(secondsAgo(120), now), '2 mins ago');
  assert.equal(formatRelative(secondsAgo(59 * 60), now), '59 mins ago');
  assert.equal(formatRelative(secondsAgo(60 * 60), now), '1 hour ago');
  assert.equal(formatRelative(secondsAgo(23 * 3600), now), '23 hours ago');
  assert.equal(formatRelative(secondsAgo(24 * 3600), now), '1 day ago');
  assert.equal(formatRelative(secondsAgo(2 * day), now), '2 days ago');
  // Each boundary written out from the ladder by hand: days give way at a week, weeks at
  // 5 (35 days is 1 of the 30-day months), months at 12 (360 days, exactly 1 of the
  // 360-day years). The point of the upper tiers is that an old session never reads as
  // "57 weeks ago" or "400 days ago".
  assert.equal(formatRelative(secondsAgo(6 * day), now), '6 days ago');
  assert.equal(formatRelative(secondsAgo(7 * day), now), '1 week ago');
  assert.equal(formatRelative(secondsAgo(13 * day), now), '1 week ago');
  assert.equal(formatRelative(secondsAgo(14 * day), now), '2 weeks ago');
  assert.equal(formatRelative(secondsAgo(34 * day), now), '4 weeks ago');
  assert.equal(formatRelative(secondsAgo(35 * day), now), '1 month ago');
  assert.equal(formatRelative(secondsAgo(359 * day), now), '11 months ago');
  assert.equal(formatRelative(secondsAgo(360 * day), now), '1 year ago');
  assert.equal(formatRelative(secondsAgo(400 * day), now), '1 year ago');
  assert.equal(formatRelative(secondsAgo(3650 * day), now), '10 years ago');
});

test('formatRelative treats a timestamp nudged into the future by clock skew as just now', () => {
  const now = new Date(2026, 7, 23, 20, 0).getTime();
  assert.equal(formatRelative(now + 5000, now), 'just now');
});

test('the model shows the part that tells two of them apart', () => {
  assert.equal(shortModel('claude-opus-5'), 'opus-5');
  assert.equal(shortModel('claude-haiku-4-5-20251001'), 'haiku-4-5');
  assert.equal(shortModel(null), null);
});

test('formatWhen names the day only when it is not today, and the year only when it differs', () => {
  const now = new Date(2026, 7, 24, 15, 0).getTime();
  assert.equal(formatWhen(new Date(2026, 7, 24, 14, 32).getTime(), now), '2:32 PM');
  assert.equal(formatWhen(new Date(2026, 7, 23, 14, 32).getTime(), now), 'Aug 23 2:32 PM');
  assert.equal(formatWhen(new Date(2025, 7, 23, 14, 32).getTime(), now), 'Aug 23 2025 2:32 PM');
});

test('the clock is 12-hour, and the day appears only when the turn is not from today', () => {
  assert.equal(formatClock(new Date(2026, 7, 23, 14, 32).getTime()), '2:32 PM');
  assert.equal(formatClock(new Date(2026, 7, 23, 9, 5).getTime()), '9:05 AM');
  assert.equal(formatClock(new Date(2026, 7, 23, 0, 7).getTime()), '12:07 AM');
  assert.equal(formatClock(new Date(2026, 7, 23, 12, 0).getTime()), '12:00 PM');
  assert.equal(formatDay(new Date(2026, 7, 23, 14, 32).getTime(), NOW), null);
  assert.equal(formatDay(new Date(2026, 6, 17, 9, 5).getTime(), NOW), 'Jul 17');
});

test('a byte count is said in the units the setting is written in', () => {
  assert.equal(formatMegabytes(4 * MB), '4 MB');
  assert.equal(formatMegabytes(24 * MB), '24 MB');
  // A reader who set a tail of their own gets what they set, not a rounded lie: half a
  // megabyte must not read as 0 MB.
  assert.equal(formatMegabytes(MB / 2), '0.5 MB');
  assert.equal(formatMegabytes(1_500_000), '1.4 MB');
  // Nothing reads as zero but zero. A tail under a tenth of a megabyte keeps enough of a
  // decimal to say what it is, which is the same lie one step smaller.
  assert.equal(formatMegabytes(0), '0 MB');
  assert.equal(formatMegabytes(50 * 1024), '0.05 MB');
  for (const bytes of [1, 100, 1000, 20_000, 52_000, 53_000]) {
    assert.notEqual(formatMegabytes(bytes), '0 MB', `${bytes} bytes reads as nothing at all`);
  }
  // The tail is a setting with no ceiling, so a size past 1024 megabytes is said in the
  // unit above. The last megabyte before the boundary keeps its own unit.
  assert.equal(formatMegabytes(1023 * MB), '1023 MB');
  assert.equal(formatMegabytes(1024 * MB), '1 GB');
  // The unit is picked after the rounding. A size that is not a whole megabyte, and that
  // rounds up to a whole gigabyte, is the only input that tells the two orders apart.
  assert.equal(formatMegabytes(1023.6 * MB), '1 GB');
  assert.equal(formatMegabytes(1536 * MB), '1.5 GB');
  assert.equal(formatMegabytes(4096 * MB), '4 GB');
});
