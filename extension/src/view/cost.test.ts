import { test } from 'vitest';
import assert from 'node:assert';
import { formatCost } from './cost.ts';

test('an unknown or empty spend has no money to show', () => {
  assert.equal(formatCost(null), null);
  assert.equal(formatCost(0), null);
  assert.equal(formatCost(-2.5), null, 'a figure below zero is not money either');
});

test('a spend under a cent reads as a ceiling', () => {
  assert.equal(formatCost(0.0001), '<$0.01');
  assert.equal(formatCost(0.0099), '<$0.01');
});

test('a spend under ten dollars keeps its cents', () => {
  assert.equal(formatCost(0.5), '$0.50');
  assert.equal(formatCost(3.456), '$3.46');
});

test('a spend of ten dollars or more rounds to whole dollars', () => {
  assert.equal(formatCost(10.4), '$10');
  assert.equal(formatCost(87.6), '$88');
});
