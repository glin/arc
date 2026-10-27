// Turn value formatting. Cross-module wording checks live in turnview.test.ts.

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
  friendlyModel,
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
  // Age units change at seven days, thirty-five days, and twelve thirty-day months.

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

test('a model reads its family and version, and an unknown model reads its recorded ID', () => {
  for (const [model, name] of [
    ['claude-opus-5-5', 'Opus 5.5'],
    ['claude-opus-5-5-20261001', 'Opus 5.5'],
    ['claude-opus-5-5[1m]', 'Opus 5.5'],
    ['claude-sonnet-5', 'Sonnet 5'],
    ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
    ['claude-3-5-haiku-20241022', 'Haiku 3.5'],
    ['gpt-6.1-sol', 'GPT-6.1 Sol'],
    ['gpt-6-astra', 'GPT-6 Astra'],
    ['gpt-5.1-codex-max', 'GPT-5.1 Codex Max'],
    ['gpt-6', 'GPT-6'],
    ['codex-auto-review', 'codex-auto-review'],
    ['claude-mystery-1', 'claude-mystery-1'],
  ] as const) {
    assert.equal(friendlyModel(model), name, model);
  }
  assert.equal(friendlyModel(null), 'Model not recorded');
  assert.equal(friendlyModel(''), 'Model not recorded');
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
  // A half-megabyte value must retain its fractional size.

  assert.equal(formatMegabytes(MB / 2), '0.5 MB');
  assert.equal(formatMegabytes(1_500_000), '1.4 MB');
  // Nonzero byte counts must not display as zero.

  assert.equal(formatMegabytes(0), '0 MB');
  assert.equal(formatMegabytes(50 * 1024), '0.05 MB');
  for (const bytes of [1, 100, 1000, 20_000, 52_000, 53_000]) {
    assert.notEqual(formatMegabytes(bytes), '0 MB', `${bytes} bytes reads as nothing at all`);
  }
  // Convert sizes at or above 1024 MiB to gigabytes.

  assert.equal(formatMegabytes(1023 * MB), '1023 MB');
  assert.equal(formatMegabytes(1024 * MB), '1 GB');
  // Choose the unit after rounding so 1023.6 MiB displays as 1 GB.

  assert.equal(formatMegabytes(1023.6 * MB), '1 GB');
  assert.equal(formatMegabytes(1536 * MB), '1.5 GB');
  assert.equal(formatMegabytes(4096 * MB), '4 GB');
});
