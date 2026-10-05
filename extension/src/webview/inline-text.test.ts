import { test } from 'vitest';
import assert from 'node:assert';
import { h } from 'preact';
import { inlineText } from './inline-text.ts';

test('inline text keeps authored parts and separates only present siblings', () => {
  const keyed = h('span', { key: 'stable' }, 'element');
  const parts = inlineText(['first', null, 0, false, undefined, keyed, '']);
  assert.deepEqual(parts, ['first', ' ', 0, ' ', keyed, ' ', '']);
  assert.equal(parts[4], keyed, 'the helper replaced the keyed element it was given');
});
