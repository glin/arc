import { test } from 'vitest';
import assert from 'node:assert';
import {
  findView,
  nextViewId,
  normalizeSavedViews,
  VIEW_NAME_LIMIT,
  VIEW_QUERY_LIMIT,
  viewCanSave,
  viewFiles,
  viewKey,
  viewName,
  viewNameTaken,
  viewTypedNotes,
  type SavedView,
} from './views.ts';

function view(over: Partial<SavedView> = {}): SavedView {
  return {
    id: 'v1',
    name: 'Release 0.4',
    query: 'label:release-0.4',
    archived: false,
    ...over,
  };
}

test('a name is cleaned and cut the way a label name is', () => {
  assert.equal(viewName('  Release   0.4 '), 'Release 0.4');
  assert.equal(viewName('a'.repeat(VIEW_NAME_LIMIT + 10)), 'a'.repeat(VIEW_NAME_LIMIT));
  assert.equal(viewName(42), '');
  assert.equal(viewName('​'), '');
});

test('two names that differ only in case are one view', () => {
  assert.equal(viewKey(viewName('Release 0.4')), viewKey(viewName('release 0.4')));
});

test('a stored view is rebuilt field by field', () => {
  const [kept] = normalizeSavedViews([
    {
      id: ' v3 ',
      name: '  Later  ',
      query: '  label:later  ',
      archived: true,
    },
  ]);
  assert.deepEqual(kept, {
    id: 'v3',
    name: 'Later',
    query: 'label:later',
    archived: true,
  });
});

test('a stored view defaults to excluding archived sessions', () => {
  const [kept] = normalizeSavedViews([{ id: 'v1', name: 'Later', query: 'x' }]);

  assert.equal(kept.archived, false);
});

test('a stored view preserves the rail order and retains a recognized override', () => {
  assert.equal(normalizeSavedViews([{ id: 'v1', name: 'Later', query: 'label:later' }])[0].sort, undefined);
  assert.equal(
    normalizeSavedViews([{ id: 'v1', name: 'Later', query: 'label:later', sort: 'cost-desc' }])[0].sort,
    'cost-desc',
  );
  assert.equal(
    normalizeSavedViews([{ id: 'v1', name: 'Later', query: 'label:later', sort: 'sideways' }])[0].sort,
    undefined,
  );
});

test('a view with no id or no readable name is dropped', () => {
  assert.deepEqual(
    normalizeSavedViews([
      { id: '', name: 'Later', query: 'label:later' },
      { id: 'v2', name: '   ', query: 'label:later' },
      { id: 'v3', name: 42, query: 'label:later' },
      'not a view',
      null,
    ]),
    [],
  );
  assert.deepEqual(normalizeSavedViews('not a list'), []);
});

test('a repeated id or a repeated name keeps the first view alone', () => {
  const kept = normalizeSavedViews([
    { id: 'v1', name: 'Later', query: 'label:later' },
    { id: 'v1', name: 'Composer', query: 'label:composer' },
    { id: 'v2', name: 'LATER', query: 'label:later' },
    { id: 'v3', name: 'Composer', query: 'label:composer' },
  ]);
  assert.deepEqual(
    kept.map((one) => [one.id, one.name]),
    [
      ['v1', 'Later'],
      ['v3', 'Composer'],
    ],
  );
});

test('a query past the ceiling is cut, and the cut decides what the view files', () => {
  const room = VIEW_QUERY_LIMIT - 'label:kept '.length;
  const [long] = normalizeSavedViews([
    {
      id: 'v1',
      name: 'Long',
      query: `label:kept ${'x'.repeat(room + 5)}`,
    },
  ]);
  assert.equal(long.query.length, VIEW_QUERY_LIMIT);
  // A query whose only term sits past the cut reaches storage with no term at all, so the view
  // it would make holds every session. It goes, the way the panel refuses to make one.
  assert.deepEqual(
    normalizeSavedViews([
      {
        id: 'v2',
        name: 'Cut',
        query: `find:${'x'.repeat(VIEW_QUERY_LIMIT)} label:gone`,
      },
    ]),
    [],
  );
  assert.deepEqual(normalizeSavedViews([{ id: 'v3', name: 'Wrong', query: { text: 'x' } }]), []);
});

test('a view whose query narrows nothing is not a view', () => {
  for (const query of ['', '   ', 'find:needle', 'in:prompt', 'find:needle in:prompt']) {
    assert.deepEqual(
      normalizeSavedViews([{ id: 'v1', name: 'Every', query }]),
      [],
      `a query of ${JSON.stringify(query)} was stored as a view`,
    );
    assert.equal(viewFiles(query), false);
  }
  for (const query of ['label:later', 'agent:codex', 'composer', 'title:rail']) {
    assert.equal(viewFiles(query), true, `a query of ${query} was read as narrowing nothing`);
  }
});

// A view's section matches again on every draw, so a live term such as `cost:` or
// `cache-expiry:` files a view the way a status term does.
test('a cost or cache-expiry query saves as a view and survives normalization', () => {
  for (const query of ['cost:>10', 'cost:<1 label:later', 'cache-expiry:>5', 'cache-expiry:3 label:later']) {
    assert.equal(viewCanSave(query), true, `${query} could not file a view`);
    assert.equal(
      normalizeSavedViews([{ id: 'v1', name: 'Live', query }])[0]?.query,
      query,
      `${query} did not survive saved-view normalization`,
    );
  }
});

test('a status query can become a saved view and an incomplete one cannot', () => {
  for (const query of ['is:input', 'is:unread label:later', 'is:running']) {
    assert.equal(viewCanSave(query), true, `${query} could not file a view`);
    assert.equal(
      normalizeSavedViews([{ id: 'v1', name: 'Status', query }])[0]?.query,
      query,
      `${query} did not survive saved-view normalization`,
    );
  }
  for (const query of ['is:', 'is:unknown']) {
    assert.equal(viewCanSave(query), false, `${query} was allowed to file a view`);
    assert.deepEqual(normalizeSavedViews([{ id: 'v1', name: 'Status', query }]), []);
  }
});

test('the limit note measures the name the record keeps, not the raw string', () => {
  // The cleaning runs a row of spaces together, so this stores whole and warns about nothing.
  const spaced = `a${' '.repeat(VIEW_NAME_LIMIT)}b`;
  assert.equal(viewName(spaced), 'a b');
  assert.deepEqual(viewTypedNotes([], spaced, ''), []);
  // A name that really is cut still says so.
  assert.deepEqual(viewTypedNotes([], 'a'.repeat(VIEW_NAME_LIMIT + 1), ''), ['limit']);
  assert.deepEqual(viewTypedNotes([], 'a'.repeat(VIEW_NAME_LIMIT), ''), []);
});

test('the record keeps every view it holds, with no ceiling on the count', () => {
  const many = Array.from({ length: 500 }, (unused, at) => ({
    id: `v${at + 1}`,
    name: `View ${at + 1}`,
    query: `label:l${at}`,
  }));
  assert.equal(normalizeSavedViews(many).length, 500);
});

test('a fresh id is one no view in the list carries', () => {
  assert.equal(nextViewId([]), 'v1');
  assert.equal(nextViewId([view({ id: 'v1' }), view({ id: 'v2' })]), 'v3');
  assert.equal(nextViewId([view({ id: 'v1' }), view({ id: 'v3' })]), 'v2');
});

test('an empty id is All sessions rather than a view', () => {
  const views = [view({ id: 'v1' })];
  assert.equal(findView(views, ''), null);
  assert.equal(findView(views, 'v9'), null);
  assert.equal(findView(views, 'v1')?.name, 'Release 0.4');
});

test('a name is taken by another view, and never by the view being edited', () => {
  const views = [view({ id: 'v1', name: 'Later' }), view({ id: 'v2', name: 'Composer' })];
  assert.equal(viewNameTaken(views, 'later', 'v2'), true);
  assert.equal(viewNameTaken(views, 'Later', 'v1'), false);
  assert.equal(viewNameTaken(views, 'Release 0.4', ''), false);
  assert.equal(viewNameTaken(views, '   ', ''), false);
});

test('the editor is told when a typed name is empty and when another view has it', () => {
  const views = [view({ id: 'v1', name: 'Later' })];
  assert.deepEqual(viewTypedNotes(views, '  ', ''), ['unnamed']);
  assert.deepEqual(viewTypedNotes(views, 'LATER', ''), ['taken']);
  assert.deepEqual(viewTypedNotes(views, 'LATER', 'v1'), []);
  assert.deepEqual(viewTypedNotes(views, 'Composer', ''), []);
});
