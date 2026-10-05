import { test } from 'vitest';
import assert from 'node:assert';
import {
  boundedRailFilterQuery,
  ALL_RAIL_FILTER_ID,
  RAIL_FILTER_NAME_LIMIT,
  RAIL_FILTER_QUERY_LIMIT,
  RAIL_FILTER_STORED_QUERY_LIMIT,
  findRailFilter,
  migrateStoredRailLens,
  nextRailFilterId,
  RAIL_LENSES,
  RAIL_LENS_WORDS,
  railQueryHeldLens,
  railQueryHoldsLens,
  railQueryLens,
  withRailLens,
  withoutRailLenses,
  pressRailLens,
  normalizeRailFilterId,
  normalizeSavedRailFilters,
  railFilterNameTaken,
  railFilterTermNegated,
  railFilterTermSelected,
  sameRailFilterLens,
  toggleRailFilterTerm,
} from './rail-filters.ts';

test('saved rail filters normalize every stored field and retain live terms', () => {
  const [kept] = normalizeSavedRailFilters([
    {
      id: ' f3 ',
      name: '  Needs   costs ',
      query: '  is:unread cost:>5  ',
      sort: 'cost-desc',
    },
  ]);
  assert.deepEqual(kept, {
    id: 'f3',
    name: 'Needs costs',
    query: 'is:unread cost:>5',
    sort: 'cost-desc',
  });
});

test('a saved rail filter stored with a lens loads with the Active words in its query and no lens field', () => {
  const kept = normalizeSavedRailFilters([
    { id: 'f1', name: 'Active costs', query: 'label:costs', lens: 'active' },
    { id: 'f2', name: 'Needs you', query: '', lens: 'needs-you' },
    { id: 'f3', name: 'Mine', query: 'label:mine', lens: 'needs-you' },
    { id: 'f4', name: 'Old', query: 'label:old' },
    { id: 'f5', name: 'Newer build', query: 'label:new', lens: 'warm' },
    { id: 'f6', name: 'Odd', query: 'label:odd', lens: 7 },
  ]);
  assert.deepEqual(
    kept.map((filter) => [filter.id, filter.query]),
    [
      ['f1', 'is:active -is:archived -is:agentrun label:costs'],
      // A retired Needs you id or lens preserves its query without applying the Warm rewrite.
      ['f2', ''],
      ['f3', 'label:mine'],
      ['f4', 'label:old'],
      ['f5', 'label:new'],
      ['f6', 'label:odd'],
    ],
  );
  assert.ok(
    kept.every((filter) => !('lens' in filter)),
    'a normalized record still carries a lens field',
  );
  // Loading the record again writes nothing twice.
  assert.deepEqual(normalizeSavedRailFilters(kept), kept);
});

test('saved rail filters reject duplicate identities and names', () => {
  const kept = normalizeSavedRailFilters([
    { id: 'f1', name: 'Costs', query: 'cost:>5' },
    { id: 'f1', name: 'Unread', query: 'is:unread' },
    { id: 'f2', name: 'COSTS', query: 'cost:<1' },
    { id: ALL_RAIL_FILTER_ID, name: 'Reserved', query: '' },
    { id: 'needs-you', name: 'Also reserved', query: '' },
  ]);
  assert.deepEqual(
    kept.map((filter) => filter.name),
    ['Costs'],
  );
  assert.equal(railFilterNameTaken(kept, 'costs'), true);
  assert.equal(railFilterNameTaken(kept, 'Costs', 'f1'), false);
});

test('saved rail filters reserve every visible built-in name', () => {
  const builtIns = ['All sessions', 'Running', 'Active', 'Unread', 'Needs input', 'Needs you', 'Custom'];
  // A stored filter under a built-in name keeps its query under a name of its own.
  assert.deepEqual(
    normalizeSavedRailFilters(
      builtIns.map((name, index) => ({
        id: `f${index + 1}`,
        name: name.toUpperCase(),
        query: `label:q${index + 1}`,
      })),
    ).map(({ name, query }) => [name, query]),
    builtIns.map((name, index) => [`${name.toUpperCase()} (saved)`, `label:q${index + 1}`]),
  );
  for (const name of builtIns) {
    assert.equal(railFilterNameTaken([], name.toLowerCase()), true, name);
  }
});

// A reader could name a saved filter Active before Active was a lens. The filter, its query and
// its order survive the load, under a name no built-in and no other stored filter holds, and a
// second load leaves the list as the first one left it.
test('a saved filter the reader named Active keeps its query under a name that does not collide', () => {
  const stored = [
    { id: 'f1', name: 'Active', query: 'is:warm label:ui', sort: 'cost-desc' },
    { id: 'f2', name: 'Active (saved)', query: 'label:perf' },
  ];
  const kept = normalizeSavedRailFilters(stored);
  assert.deepEqual(kept, [
    { id: 'f1', name: 'Active (saved 2)', query: 'is:warm label:ui', sort: 'cost-desc' },
    { id: 'f2', name: 'Active (saved)', query: 'label:perf', sort: 'latest' },
  ]);
  assert.deepEqual(normalizeSavedRailFilters(kept), kept);
  assert.equal(normalizeRailFilterId('f1', kept), 'f1');
});

// Running joined the Filter row after a reader could have named a saved filter Running.
test('a saved filter the reader named Running keeps its query under a name that does not collide', () => {
  const kept = normalizeSavedRailFilters([
    { id: 'f1', name: 'Running', query: 'is:running label:ui' },
    { id: 'f2', name: 'Running (saved)', query: 'label:perf' },
  ]);
  assert.deepEqual(
    kept.map(({ id, name, query }) => [id, name, query]),
    [
      ['f1', 'Running (saved 2)', 'is:running label:ui'],
      ['f2', 'Running (saved)', 'label:perf'],
    ],
  );
  assert.equal(railFilterNameTaken([], 'running'), true);
});

// The Running press writes its words in place of another lens's words, the funnel reads it back,
// and a typed bare `is:running` is a term of the query rather than the lens.
test('the Running lens writes its words, replaces another lens, and a bare is:running is no lens', () => {
  const running = RAIL_LENS_WORDS.running;
  assert.equal(running, 'is:running -is:archived -is:agentrun');
  assert.equal(pressRailLens('', 'running'), running);
  assert.equal(pressRailLens(`${RAIL_LENS_WORDS.unread} label:ui`, 'running'), `${running} label:ui`);
  assert.equal(railQueryHeldLens(pressRailLens('label:ui', 'running')), 'running');
  assert.equal(pressRailLens(`${running} label:ui`, 'running'), 'label:ui');
  assert.equal(railQueryHeldLens('is:running'), null);
  assert.equal(railQueryHeldLens('is:running label:ui'), null);
});

test('saved rail filters use the saved-view ceilings and safe field defaults', () => {
  const [kept] = normalizeSavedRailFilters([
    {
      id: 'f1',
      name: 'x'.repeat(RAIL_FILTER_NAME_LIMIT + 4),
      query: `label:${'x'.repeat(RAIL_FILTER_STORED_QUERY_LIMIT)}`,
      sort: 'sideways',
    },
  ]);
  assert.equal(kept.name.length, RAIL_FILTER_NAME_LIMIT);
  assert.equal(kept.query.length, RAIL_FILTER_STORED_QUERY_LIMIT);

  assert.equal(kept.sort, 'latest');
  assert.deepEqual(normalizeSavedRailFilters('not a list'), []);
});

test('saved rail filter ids and lookups are stable', () => {
  const filters = normalizeSavedRailFilters([
    { id: 'f1', name: 'One', query: '' },
    { id: 'f3', name: 'Three', query: '' },
  ]);
  assert.equal(nextRailFilterId(filters), 'f2');
  assert.equal(findRailFilter(filters, 'f3')?.name, 'Three');
  assert.equal(findRailFilter(filters, 'missing'), null);
  assert.equal(normalizeRailFilterId('f3', filters), 'f3');
  assert.equal(normalizeRailFilterId('needs-you', filters), ALL_RAIL_FILTER_ID);
  assert.equal(normalizeRailFilterId('missing', filters), ALL_RAIL_FILTER_ID);
});

test('the live filter compares query and sort order', () => {
  const saved = { query: ' label:costs ', sort: 'latest' as const };
  assert.equal(sameRailFilterLens(saved, { ...saved, query: 'label:costs' }), true);
  assert.equal(sameRailFilterLens(saved, { ...saved, query: 'label:other' }), false);
  assert.equal(sameRailFilterLens(saved, { ...saved, sort: 'cost-desc' }), false);
  assert.equal(sameRailFilterLens(saved, { ...saved, query: withRailLens(saved.query, 'active') }), false);
  const full = 'x'.repeat(RAIL_FILTER_QUERY_LIMIT);
  assert.equal(sameRailFilterLens({ ...saved, query: `${full}a` }, { ...saved, query: `${full}b` }), false);
});

test('a label choice edits the parser grammar without losing other terms', () => {
  const query = toggleRailFilterTerm('agent:codex title:rail', 'labels', 'release 0.4');
  assert.equal(query, 'agent:codex title:rail label:"release 0.4"');
  assert.equal(railFilterTermSelected(query, 'labels', 'Release 0.4'), true);
  assert.equal(toggleRailFilterTerm(query, 'labels', 'RELEASE 0.4'), 'agent:codex title:rail');
});

// The picker's rows ask which sessions a query keeps. A negated term asks for the ones it
// drops, so the row for it stays clear and a press leaves the reader's own word standing.
test('a negated term leaves the picker row for its value clear', () => {
  const query = 'label:ui -label:beta -label:draft';
  assert.equal(railFilterTermSelected(query, 'labels', 'ui'), true);
  assert.equal(railFilterTermSelected(query, 'labels', 'beta'), false);
  assert.equal(railFilterTermSelected(query, 'labels', 'draft'), false);
  // The picker drops a value the query already negates, so its rows never offer a press that
  // would write a term beside its own negation.
  assert.equal(railFilterTermNegated(query, 'labels', 'beta'), true);
  assert.equal(railFilterTermNegated(query, 'labels', 'draft'), true);
  assert.equal(railFilterTermNegated(query, 'labels', 'ui'), false);
  assert.equal(railFilterTermNegated('-label:Composer', 'labels', 'composer'), true);
  assert.equal(railFilterTermNegated('label:composer', 'labels', 'composer'), false);
  assert.equal(railFilterTermSelected('-label:"release 0.4"', 'labels', 'Release 0.4'), false);
  assert.equal(toggleRailFilterTerm(query, 'labels', 'archived'), `${query} label:archived`);
  assert.equal(toggleRailFilterTerm(query, 'labels', 'ui'), '-label:beta -label:draft');
});

test('a stored rail lens from an older build loads as the lens words in the query', () => {
  // The retired Needs you id preserves its query under All sessions. No filter button reads pressed.
  const oldNeedsYou = { query: 'is:input is:unread -is:archived -is:agentrun' };
  assert.deepEqual(migrateStoredRailLens({ filterId: 'needs-you', ...oldNeedsYou }), {
    filterId: ALL_RAIL_FILTER_ID,
    ...oldNeedsYou,
  });
  assert.equal(railQueryHoldsLens(oldNeedsYou.query, 'active'), false);
  // The old Warm words under All sessions, in any order, load as the Active words.
  for (const query of ['is:warm -is:archived -is:agentrun', ' -is:agentrun is:warm  -is:archived ']) {
    assert.deepEqual(
      migrateStoredRailLens({ filterId: ALL_RAIL_FILTER_ID, query }),
      { filterId: ALL_RAIL_FILTER_ID, query: RAIL_LENS_WORDS.active },
      query,
    );
  }
  // A lens stored as rail state joins its words to the saved query.
  assert.deepEqual(migrateStoredRailLens({ filterId: 'f1', query: 'label:ui label:bug', lens: 'active' }), {
    filterId: 'f1',
    query: 'is:active -is:archived -is:agentrun label:ui label:bug',
  });
  assert.deepEqual(migrateStoredRailLens({ filterId: ALL_RAIL_FILTER_ID, query: 'label:ui', lens: 'needs-you' }), {
    filterId: ALL_RAIL_FILTER_ID,
    query: 'label:ui',
  });
  // A retired Needs you id or lens preserves its query without applying the Warm rewrite.
  const needsYouOverWarmWords = { query: 'is:warm -is:archived -is:agentrun' };
  assert.deepEqual(migrateStoredRailLens({ filterId: 'needs-you', ...needsYouOverWarmWords }), {
    filterId: ALL_RAIL_FILTER_ID,
    ...needsYouOverWarmWords,
  });
  assert.deepEqual(
    migrateStoredRailLens({ filterId: ALL_RAIL_FILTER_ID, lens: 'needs-you', ...needsYouOverWarmWords }),
    { filterId: ALL_RAIL_FILTER_ID, ...needsYouOverWarmWords },
  );
  // Other queries keep their words, including typed statuses, Warm words under a saved filter, and queries already holding lens words.
  // An unknown stored lens adds no words.
  const kept = [
    { filterId: ALL_RAIL_FILTER_ID, query: 'is:running' },
    { filterId: ALL_RAIL_FILTER_ID, query: 'is:warm' },
    { filterId: 'f1', query: 'is:warm -is:archived -is:agentrun' },
    { filterId: ALL_RAIL_FILTER_ID, query: `${RAIL_LENS_WORDS.active} label:ui` },
  ];
  for (const stored of kept) {
    assert.deepEqual(migrateStoredRailLens(stored), stored, stored.query);
    assert.deepEqual(migrateStoredRailLens({ ...stored, lens: 'warm' }), stored, stored.query);
  }
});

test('a lens press adds and removes its own words and keeps every other word', () => {
  const active = RAIL_LENS_WORDS.active;
  assert.equal(withRailLens('', 'active'), active);
  assert.equal(withRailLens('label:ui cost:>5', 'active'), `${active} label:ui cost:>5`);
  assert.equal(withRailLens(`label:ui ${active}`, null), 'label:ui');
  // In any order, beside words the reader typed between them.
  assert.equal(withRailLens('-is:agentrun label:"release 0.4" is:active -is:archived', null), 'label:"release 0.4"');
  // A word the query already holds is not written twice.
  assert.equal(withRailLens('-is:archived label:ui', 'active'), 'is:active -is:agentrun -is:archived label:ui');
  // A lens held only in part is the reader's own words, so nothing reads it as pressed and a
  // removal leaves it.
  assert.equal(railQueryHoldsLens('is:active label:ui', 'active'), false);
  assert.equal(withoutRailLenses('is:active label:ui'), 'is:active label:ui');
  assert.equal(railQueryHoldsLens(`label:ui ${active}`, 'active'), true);
  // A negated lens term is a different word from the lens's own.
  assert.equal(railQueryHoldsLens('-is:active -is:archived -is:agentrun', 'active'), false);
});

test('the funnel names a lens only for a query of that lens words alone, in any order', () => {
  assert.equal(railQueryLens(RAIL_LENS_WORDS.active), 'active');
  assert.equal(railQueryLens(' -is:agentrun  is:active -is:archived'), 'active');
  // The words the retired Needs you count wrote name no lens.
  assert.equal(railQueryLens('is:needsyou -is:archived -is:agentrun'), null);
  assert.equal(railQueryLens(`${RAIL_LENS_WORDS.active} label:ui`), null);
  assert.equal(railQueryLens('is:active'), null);
  assert.equal(railQueryLens(''), null);
});

// Active words stored beside the retired Needs you lens.
const TYPED_ACTIVE_UNDER_NEEDS_YOU = {
  query: 'is:active -is:archived -is:agentrun label:ui',
  lens: 'needs-you',
};

test('a stored Needs you lens loads as no lens, and the record keeps its words', () => {
  const [filter] = normalizeSavedRailFilters([{ id: 'f1', name: 'Mine', ...TYPED_ACTIVE_UNDER_NEEDS_YOU }]);
  assert.equal(filter.query, TYPED_ACTIVE_UNDER_NEEDS_YOU.query);

  assert.deepEqual(migrateStoredRailLens({ filterId: ALL_RAIL_FILTER_ID, ...TYPED_ACTIVE_UNDER_NEEDS_YOU }), {
    filterId: ALL_RAIL_FILTER_ID,
    query: TYPED_ACTIVE_UNDER_NEEDS_YOU.query,
  });
});

test('a lens folded into a query at the typed limit cuts no word, on the first load or any later one', () => {
  const tail = ' label:bug';
  const typed = `${'title:x '.repeat(RAIL_FILTER_QUERY_LIMIT).slice(0, RAIL_FILTER_QUERY_LIMIT - tail.length)}${tail}`;
  assert.equal(typed.length, RAIL_FILTER_QUERY_LIMIT);
  for (const lens of RAIL_LENSES) {
    const [first] = normalizeSavedRailFilters([{ id: 'f1', name: 'Long', query: typed, lens }]);
    assert.ok(first.query.endsWith(typed), `${lens}: the saved filter lost the reader's words`);
    assert.ok(railQueryHoldsLens(first.query, lens), `${lens}: the saved filter lost the lens`);
    const [again] = normalizeSavedRailFilters(normalizeSavedRailFilters([first]));
    assert.equal(again.query, first.query, `${lens}: a reload and re-save cut the saved filter`);
    const state = migrateStoredRailLens({ filterId: ALL_RAIL_FILTER_ID, query: typed, lens });
    assert.ok(state.query.endsWith(typed), `${lens}: the stored state lost the reader's words`);
    assert.ok(state.query.length <= RAIL_FILTER_STORED_QUERY_LIMIT, `${lens}: the stored state outgrew the limit`);
  }
  // A press over a query at the typed limit, and a press that swaps one lens for another.
  for (const lens of RAIL_LENSES) {
    const pressed = pressRailLens(typed, lens);
    assert.ok(pressed.endsWith(typed) && pressed.length <= RAIL_FILTER_STORED_QUERY_LIMIT, pressed);
    for (const next of RAIL_LENSES) {
      const swapped = pressRailLens(pressed, next);
      assert.ok(swapped.endsWith(typed) && swapped.length <= RAIL_FILTER_STORED_QUERY_LIMIT, swapped);
    }
  }
  // A query the older build stored with its Needs you words in front reads back whole.
  const old = `is:needsyou -is:archived -is:agentrun ${typed}`;
  assert.equal(boundedRailFilterQuery(old), old);
});

test('a second press removes its own words', () => {
  const released = pressRailLens(`${RAIL_LENS_WORDS.active} label:ui`, 'active');
  assert.equal(released, 'label:ui');
  assert.equal(railQueryHoldsLens(released, 'active'), false);
  // A lens term typed twice leaves with every copy, so the count reads unpressed over a query
  // that no longer holds its term.
  const twice = pressRailLens('is:active label:ui is:active -is:archived -is:agentrun', 'active');
  assert.equal(twice, 'label:ui');
  assert.equal(railQueryHoldsLens(twice, 'active'), false);
  // A press over nothing writes the lens.
  assert.equal(pressRailLens('', 'active'), RAIL_LENS_WORDS.active);
});

test('a word the parser reads as no term beside a lens words makes the funnel read Custom', () => {
  assert.equal(railQueryLens(`is:bogus ${RAIL_LENS_WORDS.active}`), null);
});

test('the Running, Unread and Needs input lenses write their status beside the Active lens filing words', () => {
  assert.deepEqual(RAIL_LENS_WORDS, {
    running: 'is:running -is:archived -is:agentrun',
    active: 'is:active -is:archived -is:agentrun',
    unread: 'is:unread -is:archived -is:agentrun',
    input: 'is:input -is:archived -is:agentrun',
  });
  // A stored lens field of either loads as its words in the query.
  for (const lens of RAIL_LENSES) {
    assert.deepEqual(migrateStoredRailLens({ filterId: ALL_RAIL_FILTER_ID, query: 'label:ui', lens }), {
      filterId: ALL_RAIL_FILTER_ID,
      query: `${RAIL_LENS_WORDS[lens]} label:ui`,
    });
  }
});

// The rail holds at most one lens. Setting one takes out every other lens the query holds whole,
// shared filing words included, and keeps the reader's own words where they were.
test('a lens press sets one lens in place of any other and keeps every other word', () => {
  const { active, unread, input } = RAIL_LENS_WORDS;
  assert.equal(withRailLens(`${active} label:ui`, 'unread'), `${unread} label:ui`);
  assert.equal(withRailLens(`label:ui ${unread}`, 'input'), `is:input label:ui -is:archived -is:agentrun`);
  assert.equal(railQueryHeldLens(withRailLens(`label:ui ${unread}`, 'input')), 'input');
  // A count press on a lens the query does not hold follows the same rule, and a press on the
  // lens it holds clears it.
  assert.equal(pressRailLens(`${unread} label:ui`, 'active'), `${active} label:ui`);
  assert.equal(pressRailLens(`${input} label:ui`, 'input'), 'label:ui');
  // A typed status word that the lens asked for would complete leaves, so the result holds one
  // lens. The lenses share their filing words, so a typed `is:unread` beside the Needs input words
  // is the whole Unread lens.
  for (const lens of RAIL_LENSES) {
    for (const typed of ['is:active', 'is:unread', 'is:input']) {
      const set = withRailLens(`${typed} label:ui`, lens);
      assert.equal(railQueryHeldLens(set), lens, `${typed} then ${lens} wrote ${set}`);
      assert.equal(withoutRailLenses(set), 'label:ui', `${typed} then ${lens} wrote ${set}`);
      assert.equal(railQueryHeldLens(pressRailLens(`${typed} label:ui`, lens)), lens);
    }
  }
  assert.equal(withRailLens('is:unread label:ui', 'input'), `${input} label:ui`);
  // A typed word that completes no lens stays.
  assert.equal(withRailLens('is:done label:ui', 'input'), `${input} is:done label:ui`);
  // A query that holds two lenses whole holds no lens. An older build's Needs you query stored
  // both the Unread and the Needs input words, and it keeps them as typed until a press. A lens
  // set on it replaces both.
  const both = `is:input ${unread} label:ui`;
  assert.deepEqual([railQueryHoldsLens(both, 'input'), railQueryHoldsLens(both, 'unread')], [true, true]);
  assert.equal(railQueryHeldLens(both), null);
  assert.equal(withoutRailLenses(both), both);
  assert.equal(withRailLens(both, 'active'), `${active} label:ui`);
  assert.equal(pressRailLens(both, 'unread'), `${unread} label:ui`);
  assert.equal(withRailLens(`is:active ${unread} label:ui`, 'input'), `${input} label:ui`);
});

test('All clears every lens a query holds whole, so the rail returns to all sessions', () => {
  const [active, unread, input] = (['active', 'unread', 'input'] as const).map((lens) => RAIL_LENS_WORDS[lens]);
  // An older build's Needs you state stored both lenses' words, and the Filter row checks All.
  const stored = 'is:input is:unread -is:archived -is:agentrun';
  assert.equal(railQueryHeldLens(stored), null);
  assert.equal(withRailLens(stored, null), '');
  assert.equal(withRailLens(`label:ui ${stored} cost:>5`, null), 'label:ui cost:>5');
  assert.equal(withRailLens(`${active} ${unread} ${input} is:done`, null), 'is:done');
});

test('the funnel names each lens, and a typed synonym holds its lens', () => {
  for (const lens of RAIL_LENSES) {
    assert.equal(railQueryLens(RAIL_LENS_WORDS[lens]), lens);
    assert.equal(railQueryHeldLens(`label:ui ${RAIL_LENS_WORDS[lens]}`), lens);
    assert.equal(railQueryLens(`label:ui ${RAIL_LENS_WORDS[lens]}`), null);
  }
  assert.equal(railQueryLens('-is:agentrun is:waiting -is:archived'), 'input');
  assert.equal(railQueryHeldLens('is:unread label:ui'), null);
  assert.equal(railQueryHeldLens(''), null);
  assert.equal(railQueryHeldLens('is:input is:unread -is:archived -is:agentrun'), null);
});
