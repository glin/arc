import { test } from 'vitest';
import assert from 'node:assert';
import { formatCompactRelative, formatDuration, formatRelative, formatRelativeShort, RELATIVE_STEPS } from './time.ts';

test('compact relative ages use the shared time ladder without verbose units', () => {
  const now = new Date(2026, 7, 23, 20, 0).getTime();
  const secondsAgo = (seconds: number): number => now - seconds * 1000;
  const day = 24 * 3600;
  const cases: [number, string][] = [
    [-1, 'now'],
    [59, 'now'],
    [60, '1m ago'],
    [5 * 3600, '5h ago'],
    [23 * 3600, '23h ago'],
    [24 * 3600, '1d ago'],
    [6 * day, '6d ago'],
    [7 * day, '1w ago'],
    [34 * day, '4w ago'],
    [35 * day, '1mo ago'],
    [359 * day, '11mo ago'],
    [360 * day, '1y ago'],
    [3650 * day, '10y ago'],
  ];
  for (const [seconds, expected] of cases) {
    assert.equal(formatCompactRelative(secondsAgo(seconds), now), expected, `${seconds} seconds ago`);
  }
});

test('verbose relative ages use the same boundaries with readable units', () => {
  const now = new Date(2026, 7, 23, 20, 0).getTime();
  const secondsAgo = (seconds: number): number => now - seconds * 1000;
  const day = 24 * 3600;
  const cases: [number, string][] = [
    [-1, 'just now'],
    [59, 'just now'],
    [60, '1 min ago'],
    [120, '2 mins ago'],
    [23 * 3600, '23 hours ago'],
    [24 * 3600, '1 day ago'],
    [7 * day, '1 week ago'],
    [35 * day, '1 month ago'],
    [360 * day, '1 year ago'],
  ];
  for (const [seconds, expected] of cases) {
    assert.equal(formatRelative(secondsAgo(seconds), now), expected, `${seconds} seconds ago`);
  }
});

test('the compact row age uses the same ladder as the cache span, with no `ago`', () => {
  const now = new Date(2026, 7, 23, 20, 0).getTime();
  const secondsAgo = (seconds: number): number => now - seconds * 1000;
  const day = 24 * 3600;
  const cases: [number, string][] = [
    [-1, 'now'],
    [59, 'now'],
    [60, '1m'],
    [10 * 60, '10m'],
    [5 * 3600, '5h'],
    [23 * 3600, '23h'],
    [24 * 3600, '1d'],
    [3 * day, '3d'],
    [7 * day, '1w'],
    [14 * day, '2w'],
    [35 * day, '1mo'],
    [4 * 30 * day, '4mo'],
    [360 * day, '1y'],
  ];
  for (const [seconds, expected] of cases) {
    assert.equal(formatRelativeShort(secondsAgo(seconds), now), expected, `${seconds} seconds ago`);
  }
});

test('formatRelative and formatRelativeShort pick the same step for the same span', () => {
  const now = new Date(2026, 7, 23, 20, 0).getTime();
  for (let seconds = 0; seconds < 400 * 24 * 3600; seconds += 2617) {
    const at = now - seconds * 1000;
    const long = formatRelative(at, now);
    const short = formatRelativeShort(at, now);
    if (long === 'just now') {
      assert.equal(short, 'now', `${seconds} seconds ago`);
      continue;
    }
    // The long form counts, then a unit word, then ` ago`. The short form counts, then the
    // same step's unit letter. Both must agree on the count and the step so a reader never
    // sees `2h` beside `1 hour ago` for the same session.
    const [count, word] = long.split(' ');
    const step = RELATIVE_STEPS.findIndex((each) => each.singular === word || each.plural === word);
    assert.ok(step >= 0, `${seconds} seconds ago: ${long} names no step`);
    assert.equal(short, `${count}${['m', 'h', 'd', 'w', 'mo', 'y'][step]}`, `${seconds} seconds ago: ${long}`);
  }
  assert.ok(RELATIVE_STEPS.length > 0);
});

test('a duration keeps its tiers, its rounding and the space between hours and minutes', () => {
  const said: [number, string][] = [
    [0, '0s'],
    [59_000, '59s'],
    [60_000, '1m'],
    [59 * 60_000, '59m'],
    // 59m30s. The minutes are rounded before the split, so this is an hour and not 1h 60m.
    [3_570_000, '1h 0m'],
    [106 * 60_000, '1h 46m'],
    // A single-digit minute count, which is the case the space is here for: run together and
    // padded this reads 2h08m, and the eye takes that as one number.
    [128 * 60_000, '2h 8m'],
    // Past a day, where the hours keep counting up rather than becoming days.
    [25 * 3_600_000, '25h 0m'],
    // A negative span is a clock that disagrees with itself, not a turn that ran backwards.
    [-5_000, '0s'],
  ];
  for (const [ms, words] of said) {
    assert.equal(formatDuration(ms), words, `the duration is wrong ${ms} ms in`);
  }
});
