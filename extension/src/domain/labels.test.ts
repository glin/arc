import { test } from 'vitest';
import assert from 'node:assert';
import { LABEL_NAME_LIMIT, LABEL_NOTES, labelKey, labelTypedNotes } from './labels.ts';

test('label identity folds case without trimming the reader value', () => {
  assert.equal(labelKey('Release 0.4'), labelKey('release 0.4'));
  assert.notEqual(labelKey(' perf'), labelKey('perf'));
});

test('typed label notes preserve their order and exact ceiling', () => {
  const ceiling = 'a'.repeat(LABEL_NAME_LIMIT);
  assert.deepEqual(labelTypedNotes(ceiling), []);
  assert.deepEqual(labelTypedNotes(`${ceiling}b, rail`), ['comma', 'limit']);
  assert.ok(LABEL_NOTES.limit.includes(String(LABEL_NAME_LIMIT)));
});
