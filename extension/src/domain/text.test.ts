import { test } from 'vitest';
import assert from 'node:assert';
import { shortenTo } from './text.ts';

// A surrogate with no partner, which is what a cut through an emoji leaves behind.
const HALF_A_CHARACTER = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

test('a line inside its limit comes back as it went in', () => {
  assert.equal(shortenTo('fits', 10, '…'), 'fits');
  assert.equal(shortenTo('a'.repeat(10), 10, '…'), 'a'.repeat(10));
});

test('a line past its limit is cut and carries the ellipsis it was given', () => {
  assert.equal(shortenTo('a'.repeat(12), 10, '…'), `${'a'.repeat(9)}…`);
  assert.equal(shortenTo('one two three', 8, '..'), 'one tw..');
});

test('a cut through an emoji drops the half it orphaned', () => {
  // Two plain characters, then an emoji of two code units. A limit of four cuts one unit
  // into the emoji, so the unit before the ellipsis is half a character.
  const cut = shortenTo('ab\u{1F6A7}cd', 4, '!');
  assert.equal(cut, 'ab!');
  assert.ok(!HALF_A_CHARACTER.test(cut), 'the cut left half a character behind');
});

test('a limit shorter than the ellipsis returns no more than the ellipsis', () => {
  // A negative count would make `slice` read from the end of the line, which returns the
  // tail rather than the opening.
  assert.equal(shortenTo('abcdef', 2, '...'), '...');
  assert.equal(shortenTo('abcdef', 0, '...'), '...');
});
