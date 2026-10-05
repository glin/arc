import { test } from 'vitest';
import assert from 'node:assert';
import {
  cacheExpiryNote,
  costNote,
  isNote,
  labelFilterToken,
  labelSuggestions,
  RAIL_MENU_LABEL_FOLD,
  railMenuLabelChips,
  whereNote,
} from './session-query.ts';

test('label suggestions rank exact and prefix matches before substring matches', () => {
  const counts = [
    { name: 'refactor', count: 3, countName: 'carried by 3 sessions' },
    { name: 'activity', count: 2, countName: 'carried by 2 sessions' },
    { name: 'act', count: 1, countName: 'carried by one session' },
    { name: 'release 0.4', count: 1, countName: 'carried by one session' },
  ];
  assert.deepEqual(labelSuggestions(counts, 'ACT'), [
    { ...counts[2], token: 'label:act' },
    { ...counts[1], token: 'label:activity' },
    { ...counts[0], token: 'label:refactor' },
  ]);
  assert.deepEqual(labelSuggestions(counts, ''), [
    { ...counts[0], token: 'label:refactor' },
    { ...counts[1], token: 'label:activity' },
    { ...counts[2], token: 'label:act' },
    { ...counts[3], token: 'label:"release 0.4"' },
  ]);
});

test('the View menu draws the twelve most used labels, then folds the rest behind one chip', () => {
  const labels = Array.from({ length: 15 }, (_, index) => ({
    name: `label${String(index).padStart(2, '0')}`,
    count: 20 - index,
    countName: `carried by ${20 - index} sessions`,
  }));
  // Two labels tie on the highest count, so the name decides between them.
  labels.push({ name: 'Alpha', count: 20, countName: 'carried by 20 sessions' });
  const names = (chips: readonly { name: string }[]) => chips.map((chip) => chip.name);

  const folded = railMenuLabelChips([...labels].reverse(), '', false);
  assert.equal(RAIL_MENU_LABEL_FOLD, 12);
  assert.deepEqual(names(folded.chips), ['Alpha', ...names(labels.slice(0, 11))]);
  assert.equal(folded.more, 4);

  const expanded = railMenuLabelChips(labels, '', true);
  assert.equal(expanded.chips.length, 16);
  assert.equal(expanded.more, 4);

  // A typed find shows every label it matches, past the fold and with no fold chip.
  const found = railMenuLabelChips(labels, 'LABEL', false);
  assert.equal(found.chips.length, 15);
  assert.equal(found.more, null);

  // Twelve labels fit, so there is nothing to fold.
  const twelve = railMenuLabelChips(labels.slice(0, 12), '', false);
  assert.equal(twelve.chips.length, 12);
  assert.equal(twelve.more, null);
  assert.deepEqual(railMenuLabelChips(labels.slice(0, 13), '', false).more, 1);
  assert.deepEqual(railMenuLabelChips([], '', false), { chips: [], more: null });
});

test('one label becomes one query term, quoted where the grammar needs it', () => {
  // Session list suggestions and session heading labels share this token rule. Quote spaces so the label remains one query term.
  assert.equal(labelFilterToken('perf'), 'label:perf');
  assert.equal(labelFilterToken('release 0.4'), 'label:"release 0.4"');
  assert.equal(labelFilterToken('say "yes"'), 'label:"say ""yes"""');
});

test('unknown search areas receive one stable note', () => {
  assert.equal(whereNote('find: x in:respons'), 'in:respons was not understood. Use in:prompt, in:summary or in:both.');
  assert.equal(whereNote('find: x in:response'), null);
});

test('an unknown is value is corrected with every value the grammar takes', () => {
  assert.equal(
    isNote('is:sideways'),
    'is:sideways was not understood. ' +
      'Use is:input, is:unread, is:read, is:running, is:warm, is:active, is:needsyou, is:archived or is:agentrun.',
  );
  // The note quotes the word the reader wrote, mark and all, so it never answers about a
  // query they did not type.
  assert.equal(
    isNote('-is:sideways'),
    '-is:sideways was not understood. ' +
      'Use is:input, is:unread, is:read, is:running, is:warm, is:active, is:needsyou, is:archived or is:agentrun.',
  );
  assert.equal(isNote('is:archived'), null);
  assert.equal(isNote('is:agentrun'), null);
});

test('an invalid cost value receives one stable correction', () => {
  assert.equal(costNote('cost:5.43'), 'cost:5.43 was not understood. Use cost:>5.43 or cost:<5.43.');
  assert.equal(costNote('agent:codex cost:$5'), 'cost:$5 was not understood. Use cost:>5.43 or cost:<5.43.');
  assert.equal(costNote('cost:>5.43'), null);
  assert.equal(costNote(''), null);
});

test('an invalid cache-expiry value receives one stable correction', () => {
  assert.equal(
    cacheExpiryNote('cache-expiry:3'),
    'cache-expiry:3 was not understood. Use cache-expiry:>0 or cache-expiry:<3.',
  );
  assert.equal(
    cacheExpiryNote('agent:codex cache-expiry:$5'),
    'cache-expiry:$5 was not understood. Use cache-expiry:>0 or cache-expiry:<3.',
  );
  assert.equal(cacheExpiryNote('cache-expiry:>0'), null);
  assert.equal(cacheExpiryNote(''), null);
});
