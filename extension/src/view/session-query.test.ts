import { test } from 'vitest';
import assert from 'node:assert';
import {
  activeNote,
  cacheExpiryNote,
  costNote,
  isNote,
  labelFilterToken,
  labelSuggestions,
  RAIL_MENU_LABEL_FOLD,
  railMenuLabelChips,
  railQueryTerms,
  railTermFold,
  type RailQueryTerm,
  type RailTermWords,
  whereNote,
  withoutRailQueryTerm,
} from './session-query.ts';
import { RAIL_ACTIVE_WINDOWS, railActiveWindow, railLensWords } from '../domain/rail-filters.ts';
import { activeWindowValue } from '../domain/session-query.ts';

const TERM_WORDS: RailTermWords = {
  lens: { running: 'Running', active: 'Active', unread: 'Unread', input: 'Needs input' },
  windowPhrase: (window) => `within ${activeWindowValue(window)}`,
  not: 'not',
};

function termShape(term: RailQueryTerm): [string, string | null, boolean] {
  return [term.text, term.detail, term.removable];
}

function shapes(query: string): [string, string | null, boolean][] {
  return railQueryTerms(query, TERM_WORDS).map(termShape);
}

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

test('an active: value that names no window receives a correction in the spelling the reader typed', () => {
  const use = 'names no window. Use active:6h, active:2d or active:today.';
  assert.equal(activeNote('active:6x'), `active:6x ${use}`);
  assert.equal(activeNote('label:ui active:"6h"'), `active:"6h" ${use}`);
  assert.equal(activeNote('-active:0h'), `-active:0h ${use}`);
  assert.equal(activeNote('active:6h active:today'), null);
  assert.equal(activeNote('active:'), null);
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

test('a held Active lens is one term at every window and hides the words it carries', () => {
  for (const choice of RAIL_ACTIVE_WINDOWS) {
    const window = railActiveWindow(choice);
    const query = railLensWords('active', window);
    const [term, ...rest] = railQueryTerms(query, TERM_WORDS);
    assert.deepEqual(rest, []);
    assert.deepEqual(termShape(term), ['Active', activeWindowValue(window), true]);
    assert.equal(term.name, `Active within ${activeWindowValue(window)}`);
    assert.equal(withoutRailQueryTerm(query, term), '');
  }
});

test('a held Running lens is one term placed at its first word, even with its words spread apart', () => {
  const query = 'label:a is:running label:b -is:archived label:c -is:agentrun';
  const terms = railQueryTerms(query, TERM_WORDS);
  assert.deepEqual(terms.map(termShape), [
    ['a', null, true],
    ['Running', null, true],
    ['b', null, true],
    ['c', null, true],
  ]);
  assert.equal(terms[1].name, 'Running');
  assert.equal(withoutRailQueryTerm(query, terms[1]), 'label:a label:b label:c');
});

test('labels show their names, negated terms read not, and a quoted value loses its quotes', () => {
  assert.deepEqual(shapes('label:composer -label:bug label:"release 0.4"'), [
    ['composer', null, true],
    ['not bug', null, true],
    ['release 0.4', null, true],
  ]);
  const [negated] = railQueryTerms('-label:bug -is:running', TERM_WORDS);
  assert.equal(negated.negated, true);
  assert.deepEqual(shapes('-is:running'), [['not is:running', null, true]]);
});

test('every other parsed term shows its query text, and an OR group is one term', () => {
  assert.deepEqual(shapes('agent:codex cost:>5 active:6h session:a OR session:b OR session:c fix'), [
    ['agent:codex', null, true],
    ['cost:>5', null, true],
    ['active:6h', null, true],
    ['session:a OR session:b OR session:c', null, true],
    ['fix', null, true],
  ]);
});

test('find text, what follows it, and words the parser does not read show plain with no remove', () => {
  assert.deepEqual(shapes('label:a in:prompt is:bogus find: two words label:b'), [
    ['a', null, true],
    ['in:prompt', null, false],
    ['is:bogus', null, false],
    ['find:', null, false],
    ['two', null, false],
    ['words', null, false],
    ['b', null, true],
  ]);
});

test('removing a term leaves every other word in place, spelled as the reader wrote it', () => {
  const query = 'label:"a b"   session:x OR session:y   is:running -is:archived -is:agentrun cost:>5';
  const written = (at: number) => withoutRailQueryTerm(query, railQueryTerms(query, TERM_WORDS)[at]);
  assert.equal(written(0), 'session:x OR session:y is:running -is:archived -is:agentrun cost:>5');
  assert.equal(written(1), 'label:"a b" is:running -is:archived -is:agentrun cost:>5');
  assert.equal(written(2), 'label:"a b" session:x OR session:y cost:>5');
  assert.equal(written(3), 'label:"a b" session:x OR session:y is:running -is:archived -is:agentrun');
});

test('an Active word at another window stays beside the lens term it does not belong to', () => {
  const query = 'active:6h is:active -is:archived -is:agentrun';
  const terms = railQueryTerms(query, TERM_WORDS);
  assert.deepEqual(terms.map(termShape), [
    ['Active', '6h', true],
    ['is:active', null, true],
  ]);
  assert.equal(withoutRailQueryTerm(query, terms[0]), 'is:active');
});

test('the fold keeps what fits, counts every hidden term, and always shows the first term', () => {
  assert.deepEqual(railTermFold([], 100, 4, 20), { shown: 0, more: 0 });
  assert.deepEqual(railTermFold([30, 30, 30], 98, 4, 20), { shown: 3, more: 0 });
  assert.deepEqual(railTermFold([30, 30, 30], 97, 4, 20), { shown: 2, more: 1 });
  assert.deepEqual(railTermFold([30, 30, 30, 30], 50, 4, 20), { shown: 1, more: 3 });
  // A first term wider than the room still shows, because a line of `+N` alone names nothing.
  assert.deepEqual(railTermFold([200, 30], 100, 4, 20), { shown: 1, more: 1 });
});
