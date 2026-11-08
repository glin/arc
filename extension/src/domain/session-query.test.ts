import {
  resolveSessionQuery,
  sessionQueryResolutionError,
  sessionQueryNeedsShorthand,
  sessionQueryError,
  type SessionQueryContext,
} from './session-query.ts';
import { test } from 'vitest';
import assert from 'node:assert';
import {
  canStartSearch,
  isSearch,
  IS_VALUES,
  matchSessions,
  parseSessionQuery,
  sameQueryTerms,
  listingQueryError,
  listingTermHolds,
  queryToken,
  queryTokens,
  quoteQueryValue,
  replaceToken,
  withWhere,
} from './session-query.ts';

const sessions = [
  { id: 'one', label: 'Timeline UI work', agent: 'Claude', labels: ['release 0.4', 'perf'] },
  { id: 'two', label: 'Hook smoke test', agent: 'Codex', labels: ['Release 0.4'] },
  { id: 'three', label: 'Timeline UI work', agent: 'Codex' },
];

const costSessions = [
  { id: 'exact-high', label: 'Exact high', agent: 'Claude', costDollars: 9, costAtLeast: false },
  { id: 'exact-low', label: 'Exact low', agent: 'Codex', costDollars: 2, costAtLeast: false },
  { id: 'floor-high', label: 'Floor high', agent: 'Claude', costDollars: 8, costAtLeast: true },
  { id: 'floor-low', label: 'Floor low', agent: 'Codex', costDollars: 1, costAtLeast: true },
  { id: 'unknown', label: 'Unknown', agent: 'Claude', costDollars: null, costAtLeast: false },
];

test("a free-text term matches the rail card's drawn name, not only the capped label", () => {
  // Search includes the fuller session list name, including words beyond the 60-character label.
  const label = 'a'.repeat(60);
  const name = `${'a'.repeat(60)} distinctword`;
  const rows = [
    { id: 'long', label, agent: 'Claude', name },
    { id: 'short', label: 'Unrelated title', agent: 'Claude', name: 'Unrelated title' },
  ];
  assert.deepEqual(
    matchSessions(rows, 'distinctword').map((row) => row.id),
    ['long'],
  );
  // A row with no `name` still matches on `label` alone.
  assert.deepEqual(
    matchSessions([{ id: 'plain', label: 'plain title', agent: 'Claude' }], 'plain').map((row) => row.id),
    ['plain'],
  );
});

test('session queries keep title, agent, label, and content terms distinct', () => {
  assert.deepEqual(
    matchSessions(sessions, 'agent:codex timeline').map((session) => session.id),
    ['three'],
  );
  assert.deepEqual(
    matchSessions(sessions, 'label:"release 0.4"').map((session) => session.id),
    ['one', 'two'],
  );
  assert.deepEqual(matchSessions(sessions, 'label:release 0.4'), []);
  assert.deepEqual(matchSessions(sessions, 'find: root'), sessions);
  assert.deepEqual(parseSessionQuery('LABEL:API title:Work FIND: Root').terms, [
    { field: 'labels', needle: 'API' },
    { field: 'title', needle: 'work' },
  ]);
});

test('cost queries parse strict whole and decimal comparisons', () => {
  assert.deepEqual(parseSessionQuery('cost:>5').terms, [
    {
      field: 'cost',
      needle: '>5',
      comparison: { operator: '>', threshold: { digits: '5', exponent: 0 } },
    },
  ]);
  assert.deepEqual(parseSessionQuery('cost:<5.43').terms, [
    {
      field: 'cost',
      needle: '<5.43',
      comparison: { operator: '<', threshold: { digits: '543', exponent: -2 } },
    },
  ]);
  assert.deepEqual(parseSessionQuery('COST:>0.01').terms, [
    {
      field: 'cost',
      needle: '>0.01',
      comparison: { operator: '>', threshold: { digits: '1', exponent: -2 } },
    },
  ]);
});

test('invalid cost values remain in the query and make every query empty', () => {
  const invalid = ['', '5.43', '+5', '>-5', '>$5.43', '>NaN', '>Infinity', '>=5', '>.5', '>5.'];
  for (const value of invalid) {
    const query = `cost:${value}`;
    assert.deepEqual(
      parseSessionQuery(query).terms,
      [{ field: 'cost', needle: value }],
      `${query} was not retained as an invalid cost term`,
    );
    assert.deepEqual(matchSessions(costSessions, `${query} agent:claude`), [], `${query} matched under all`);
  }
  assert.deepEqual(parseSessionQuery('cost:">5"').terms, [{ field: 'cost', needle: '>5' }]);
});

test('exact costs and lower bounds match only when the comparison is certain', () => {
  const ids = (query: string): string[] => matchSessions(costSessions, query).map((session) => session.id);
  assert.deepEqual(ids('cost:>5'), ['exact-high', 'floor-high']);
  assert.deepEqual(ids('cost:<5'), ['exact-low']);
  assert.deepEqual(ids('cost:>9'), []);
  assert.deepEqual(ids('cost:<2'), []);
  assert.deepEqual(ids('cost:>0'), ['exact-high', 'exact-low', 'floor-high', 'floor-low']);
});

test('cost thresholds keep every typed decimal digit when recorded numbers use decimal or exponent form', () => {
  const recorded = [
    { id: 'decimal', label: 'Decimal', agent: 'Claude', costDollars: 0.1 },
    { id: 'small-exponent', label: 'Small exponent', agent: 'Claude', costDollars: 1e-7 },
    { id: 'large-exponent', label: 'Large exponent', agent: 'Claude', costDollars: 1e21 },
  ];
  const ids = (query: string): string[] => matchSessions(recorded, query).map((session) => session.id);
  assert.deepEqual(ids('cost:<0.100000000000000005'), ['decimal', 'small-exponent']);
  assert.deepEqual(ids('cost:>0.000000099999999999999999999999'), ['decimal', 'small-exponent', 'large-exponent']);
  assert.deepEqual(ids('cost:>999999999999999999999.9'), ['large-exponent']);
});

test('cost comparisons combine with text terms under every query', () => {
  assert.deepEqual(
    matchSessions(costSessions, 'cost:>5 agent:claude').map((session) => session.id),
    ['exact-high', 'floor-high'],
  );
});

// A leading `-` asks for the sessions a term drops. The mark is part of the word rather than
// a term of its own, so the parser has to keep it off the needle, keep it out of a word that
// names no term, and leave the query text the reader typed untouched.
test('a leading dash negates the term it opens and a bare dash names none', () => {
  assert.deepEqual(parseSessionQuery('-is:running').terms, [{ field: 'status', needle: 'running', negated: true }]);
  assert.deepEqual(parseSessionQuery('-timeline -agent:codex -label:perf').terms, [
    { field: 'title', needle: 'timeline', plain: true, negated: true },
    { field: 'agent', needle: 'codex', negated: true },
    { field: 'labels', needle: 'perf', negated: true },
  ]);
  assert.deepEqual(parseSessionQuery('-label:"release 0.4"').terms, [
    { field: 'labels', needle: 'release 0.4', negated: true },
  ]);
  // A word that is only the mark excludes nothing, so it adds no term at all rather than a
  // title term looking for a dash.
  assert.deepEqual(parseSessionQuery('-').terms, []);
  assert.deepEqual(parseSessionQuery('timeline - is:read').terms, [
    { field: 'title', needle: 'timeline', plain: true },
    { field: 'status', needle: 'read' },
  ]);
  // The query text survives the token bounds every control edits a query through, and the
  // rebuilt text parses to the same terms.
  const written = 'is:input -is:running -label:"release 0.4" -timeline';
  const rebuilt = queryTokens(written)
    .map((token) => written.slice(token.start, token.end))
    .join(' ');
  assert.equal(rebuilt, written);
  assert.deepEqual(parseSessionQuery(rebuilt).terms, parseSessionQuery(written).terms);
});

test('a word that opens with two marks adds no term', () => {
  assert.deepEqual(parseSessionQuery('--is:warm').terms, []);
  assert.deepEqual(parseSessionQuery('is:warm --fix').terms, [{ field: 'status', needle: 'warm' }]);
  // Quoting the word asks for the text instead.
  assert.deepEqual(parseSessionQuery('"--fix"').terms, [{ field: 'title', needle: '--fix', plain: true }]);
});

test('a word that opens with a quote holds its leading mark as text', () => {
  assert.deepEqual(parseSessionQuery('"-fix"').terms, [{ field: 'title', needle: '-fix', plain: true }]);
  assert.deepEqual(parseSessionQuery('title:x "-"').terms, [
    { field: 'title', needle: 'x' },
    { field: 'title', needle: '-', plain: true },
  ]);
  assert.deepEqual(parseSessionQuery('find: "-name"').find, ['-name']);
  // The mark outside the quotes still negates the term it opens.
  assert.deepEqual(parseSessionQuery('-label:"release 0.4"').terms, [
    { field: 'labels', needle: 'release 0.4', negated: true },
  ]);
});

test('a negated term narrows under every query', () => {
  const rows = [
    { label: 'Waiting', agent: 'Claude', status: 'waiting', unread: true, archived: false },
    { label: 'Unread', agent: 'Codex', status: 'done', unread: true, archived: false },
    { label: 'Put away', agent: 'Claude', status: 'waiting', unread: true, archived: true },
    { label: 'Read', agent: 'Claude', status: 'done', unread: false, archived: false },
  ];
  const ids = (query: string): string[] => matchSessions(rows, query).map((row) => row.label);

  assert.deepEqual(ids('is:unread -agent:claude'), ['Unread']);
  // Negated terms exclude their matches.
  assert.deepEqual(ids('-is:unread'), ['Read']);

  assert.deepEqual(ids('is:unread -is:unread'), []);
});

// A negated cost term keeps every session the comparison drops. That is the session priced
// on the other side of the threshold, the session with no recorded cost, and the lower-bound
// total that has not yet crossed a `<` threshold.
test('a negated cost term keeps the sessions the comparison drops', () => {
  const ids = (query: string): string[] => matchSessions(costSessions, query).map((session) => session.id);
  assert.deepEqual(ids('-cost:>5'), ['exact-low', 'floor-low', 'unknown']);
  assert.deepEqual(ids('-cost:<5'), ['exact-high', 'floor-high', 'floor-low', 'unknown']);
  // An invalid cost value still empties the rail, negated or not, so a typing mistake never
  // reads as a lens over every session.
  assert.deepEqual(ids('-cost:five'), []);
});

const cacheExpirySessions = [
  { id: 'many', label: 'Many returns', agent: 'Claude', cacheExpiryCount: 3 },
  { id: 'one', label: 'One return', agent: 'Codex', cacheExpiryCount: 1 },
  { id: 'none', label: 'No returns', agent: 'Claude', cacheExpiryCount: 0 },
  // Absent and explicit null both name a source that cannot answer, the way a missing cost
  // does, so both stay out of every comparison.
  { id: 'unindexed', label: 'Not yet indexed', agent: 'Codex' },
  { id: 'unavailable', label: 'Unavailable', agent: 'Claude', cacheExpiryCount: null },
];

// Incomplete adjacent-request evidence gives a lower bound on cache-expiry returns.
const cacheExpiryFloorSessions = [
  { id: 'exact-high', label: 'Exact high', agent: 'Claude', cacheExpiryCount: 9, cacheExpiryAtLeast: false },
  { id: 'exact-low', label: 'Exact low', agent: 'Codex', cacheExpiryCount: 2, cacheExpiryAtLeast: false },
  { id: 'floor-high', label: 'Floor high', agent: 'Claude', cacheExpiryCount: 8, cacheExpiryAtLeast: true },
  { id: 'floor-low', label: 'Floor low', agent: 'Codex', cacheExpiryCount: 1, cacheExpiryAtLeast: true },
  { id: 'unknown', label: 'Unknown', agent: 'Claude', cacheExpiryCount: null, cacheExpiryAtLeast: false },
];

test('cache-expiry queries parse and match through the same strict comparison cost uses', () => {
  assert.deepEqual(parseSessionQuery('cache-expiry:>0').terms, [
    {
      field: 'cache-expiry',
      needle: '>0',
      comparison: { operator: '>', threshold: { digits: '0', exponent: 0 } },
    },
  ]);
  assert.deepEqual(parseSessionQuery('cache-expiry:<3').terms, [
    {
      field: 'cache-expiry',
      needle: '<3',
      comparison: { operator: '<', threshold: { digits: '3', exponent: 0 } },
    },
  ]);
  const ids = (query: string): string[] => matchSessions(cacheExpirySessions, query).map((session) => session.id);
  assert.deepEqual(ids('cache-expiry:>0'), ['many', 'one']);
  assert.deepEqual(ids('cache-expiry:<1'), ['none']);
  assert.deepEqual(ids('cache-expiry:>2'), ['many']);
});

test('an unavailable or incomplete cache-expiry index matches neither comparison', () => {
  const ids = (query: string): string[] => matchSessions(cacheExpirySessions, query).map((session) => session.id);
  // Neither a session never indexed nor one recorded as explicitly unavailable answers `>` or
  // `<`, the same way a session with no recorded cost answers neither.
  assert.ok(!ids('cache-expiry:>0').includes('unindexed'));
  assert.ok(!ids('cache-expiry:>0').includes('unavailable'));
  assert.ok(!ids('cache-expiry:<100').includes('unindexed'));
  assert.ok(!ids('cache-expiry:<100').includes('unavailable'));
});

test('invalid cache-expiry values remain in the query and make every query empty', () => {
  const invalid = ['', '5.43', '+5', '>-5', '>$5.43', '>NaN', '>Infinity', '>=5', '>.5', '>5.'];
  for (const value of invalid) {
    const query = `cache-expiry:${value}`;
    assert.deepEqual(
      parseSessionQuery(query).terms,
      [{ field: 'cache-expiry', needle: value }],
      `${query} was not retained as an invalid cache-expiry term`,
    );
    assert.deepEqual(matchSessions(cacheExpirySessions, `${query} agent:claude`), [], `${query} matched under all`);
  }
});

test('cache-expiry comparisons combine with text terms under every query', () => {
  assert.deepEqual(
    matchSessions(cacheExpirySessions, 'cache-expiry:>0 agent:claude').map((session) => session.id),
    ['many'],
  );
});

// A negated cache-expiry term keeps every session the comparison drops: the session on the
// other side of the threshold, and the session whose facts are unavailable or not yet indexed.
test('a negated cache-expiry term keeps the sessions the comparison drops', () => {
  const ids = (query: string): string[] => matchSessions(cacheExpirySessions, query).map((session) => session.id);
  assert.deepEqual(ids('-cache-expiry:>0'), ['none', 'unindexed', 'unavailable']);
  assert.deepEqual(ids('-cache-expiry:<1'), ['many', 'one', 'unindexed', 'unavailable']);
  assert.deepEqual(ids('-cache-expiry:five'), []);
});

// A lower bound matches > only after its known count exceeds the threshold. It never establishes a < match.
test('a cache-expiry floor matches only the comparison a lower bound can answer', () => {
  const ids = (query: string): string[] => matchSessions(cacheExpiryFloorSessions, query).map((session) => session.id);
  assert.deepEqual(ids('cache-expiry:>5'), ['exact-high', 'floor-high']);
  assert.deepEqual(ids('cache-expiry:<5'), ['exact-low']);
  assert.deepEqual(ids('cache-expiry:>9'), []);
  assert.deepEqual(ids('cache-expiry:<2'), []);
  assert.deepEqual(ids('cache-expiry:>0'), ['exact-high', 'exact-low', 'floor-high', 'floor-low']);
  // A negated floor keeps the session its comparison drops, which includes a lower bound that
  // has not yet crossed a `<` threshold.
  assert.deepEqual(ids('-cache-expiry:>5'), ['exact-low', 'floor-low', 'unknown']);
  assert.deepEqual(ids('-cache-expiry:<5'), ['exact-high', 'floor-high', 'floor-low', 'unknown']);
});

// The Rail draws its cards from the same session objects on every redraw, so a card whose
// facts arrive after the reader has already typed the query must start matching once its
// count exists, without the reader touching the box again.
test('a card whose cache-expiry facts arrive later starts matching the query already typed', () => {
  const before = [{ id: 's1', label: 'Session', agent: 'Claude', cacheExpiryCount: null }];
  const after = [{ id: 's1', label: 'Session', agent: 'Claude', cacheExpiryCount: 2 }];
  assert.deepEqual(matchSessions(before, 'cache-expiry:>0'), []);
  assert.deepEqual(
    matchSessions(after, 'cache-expiry:>0').map((session) => session.id),
    ['s1'],
  );
});

test('an empty query keeps every session', () => {
  assert.deepEqual(matchSessions(sessions, ''), sessions);
  assert.deepEqual(matchSessions(sessions, '   '), sessions);
});

test('quoted query values and caret replacements round trip', () => {
  const quoted = quoteQueryValue('say "hi"');
  assert.equal(quoted, '"say ""hi"""');
  assert.equal(parseSessionQuery(`label:${quoted}`).terms[0].needle, 'say "hi"');
  assert.deepEqual(queryToken('agent:codex label:"release 0.4"', 25), {
    prefix: 'label',
    value: 'release 0.4',
    start: 12,
    end: 31,
  });
  assert.deepEqual(replaceToken('agent:codex lab', 12, 15, 'label:perf'), {
    query: 'agent:codex label:perf',
    caret: 22,
  });
});

test('content-search eligibility and scope tokens use the parsed grammar', () => {
  assert.equal(canStartSearch('timeline'), true);
  assert.equal(canStartSearch('title:timeline'), false);
  assert.equal(canStartSearch('find: timeline'), false);
  assert.equal(isSearch('find: timeline'), true);
  assert.equal(withWhere('find: root in:prompt', 'summary'), 'find: root in:summary');
  assert.equal(parseSessionQuery('find: root in:response').where, 'summary');
  assert.deepEqual(parseSessionQuery('find: root in:sideways').unknownWhere, ['sideways']);
});

test('is terms match the reader-facing rail states and retain unknown values', () => {
  assert.deepEqual(parseSessionQuery('is:input is:unread is:read is:running').terms, [
    { field: 'status', needle: 'input' },
    { field: 'status', needle: 'unread' },
    { field: 'status', needle: 'read' },
    { field: 'status', needle: 'running' },
  ]);
  assert.deepEqual(parseSessionQuery('is:waiting is:blocked is:unknown').terms, [
    { field: 'status', needle: 'input' },
    { field: 'status', needle: 'input' },
  ]);
  assert.deepEqual(parseSessionQuery('is:waiting is:blocked is:unknown').unknownIs, ['is:unknown']);
  const rows = [
    { label: 'Input', agent: 'Claude', status: 'waiting', unread: true },
    { label: 'Unread', agent: 'Codex', status: 'running', unread: true },
    { label: 'Read', agent: 'Claude', status: 'done', unread: false },
  ];
  assert.deepEqual(
    matchSessions(rows, 'is:input').map((row) => row.label),
    ['Input'],
  );
  assert.deepEqual(
    matchSessions(rows, 'is:unread').map((row) => row.label),
    ['Input', 'Unread'],
  );
  assert.deepEqual(
    matchSessions(rows, 'is:read').map((row) => row.label),
    ['Read'],
  );
  assert.deepEqual(
    matchSessions(rows, 'is:running').map((row) => row.label),
    ['Unread'],
  );
  const withSubagents = [
    ...rows,
    { label: 'Subagents', agent: 'Claude', status: 'subagents', unread: false },
    { label: 'Background', agent: 'Claude', status: 'background', unread: false },
  ];
  assert.deepEqual(
    matchSessions(withSubagents, 'is:running').map((row) => row.label),
    ['Unread', 'Subagents', 'Background'],
  );
});

// Two of the words the rail files a session under are facts the reader or the agent put on
// it rather than states of its newest turn. Each reads the plain fact the caller hands in,
// so the answer never depends on which buckets the caller happens to draw.
test('is:archived and is:agentrun read the filing on a session', () => {
  assert.deepEqual(parseSessionQuery('is:archived is:agentrun').terms, [
    { field: 'status', needle: 'archived' },
    { field: 'status', needle: 'agentrun' },
  ]);
  const rows = [
    { label: 'Mine', agent: 'Claude', status: 'done', unread: false },
    { label: 'Put away', agent: 'Claude', status: 'done', unread: false, archived: true },
    { label: 'Agent', agent: 'Codex', status: 'done', unread: false, runByAgent: true },
    // Archiving takes the card out of the agent-run bucket, so a caller reading its own
    // bucket would miss this one. Both terms hold on the plain facts.
    { label: 'Both', agent: 'Codex', status: 'done', unread: false, archived: true, runByAgent: true },
  ];
  const ids = (query: string = 'all'): string[] => matchSessions(rows, query).map((row) => row.label);
  assert.deepEqual(ids('is:archived'), ['Put away', 'Both']);
  assert.deepEqual(ids('is:agentrun'), ['Agent', 'Both']);

  assert.deepEqual(ids('-is:archived -is:agentrun'), ['Mine']);
});

// `is:warm` asks about the prompt cache, which no session record carries as a state. The
// caller answers it with `cacheWarm`, read against its own clock, and a caller that holds no
// cache facts keeps nothing rather than everything.
test('is:warm keeps the sessions whose caller called their cache warm', () => {
  assert.deepEqual(parseSessionQuery('is:warm').terms, [{ field: 'status', needle: 'warm' }]);
  const rows = [
    { label: 'Warm', agent: 'Claude', status: 'done', unread: false, cacheWarm: true },
    { label: 'Cold', agent: 'Codex', status: 'done', unread: false, cacheWarm: false },
    { label: 'Unsaid', agent: 'Claude', status: 'done', unread: false },
  ];
  assert.deepEqual(
    matchSessions(rows, 'is:warm').map((row) => row.label),
    ['Warm'],
  );
  // The two terms are separate questions, so one running session with a cold cache holds
  // neither lens on its own.
  const both = [
    { label: 'Both', agent: 'Claude', status: 'running', unread: false, cacheWarm: true },
    { label: 'Running only', agent: 'Claude', status: 'running', unread: false, cacheWarm: false },
  ];
  assert.deepEqual(
    matchSessions(both, 'is:warm is:running').map((row) => row.label),
    ['Both'],
  );

  // The term asks about the cache and nothing else, so a session an agent runs and one the
  // reader put away both hold it while their cache has time left. A lens that wants the warm
  // sessions a reader can act on excludes them in words.
  const filed = [
    { label: 'Person', agent: 'Claude', status: 'done', unread: false, cacheWarm: true },
    { label: 'Agent', agent: 'Claude', status: 'done', unread: false, cacheWarm: true, runByAgent: true },
    { label: 'Archived', agent: 'Claude', status: 'done', unread: false, cacheWarm: true, archived: true },
  ];
  assert.deepEqual(
    matchSessions(filed, 'is:warm').map((row) => row.label),
    ['Person', 'Agent', 'Archived'],
  );
  assert.deepEqual(
    matchSessions(filed, 'is:warm -is:archived -is:agentrun').map((row) => row.label),
    ['Person'],
  );
});

// `is:active` asks about a session's recency, which no session record carries as a state. The
// caller hands in the session's last activity time and its own clock, the same way it hands in
// `cacheWarm` for `is:warm`.
const CLOCK = Date.UTC(2026, 10, 7, 12);
const RECENT = CLOCK - 5 * 60_000;
const STALE = CLOCK - 2 * 60 * 60_000;

test('is:active keeps the sessions with a warm cache or activity in the last hour', () => {
  assert.deepEqual(parseSessionQuery('is:active').terms, [{ field: 'status', needle: 'active' }]);
  assert.deepEqual(parseSessionQuery('-is:active').terms, [{ field: 'status', needle: 'active', negated: true }]);
  const rows = [
    { label: 'Active', agent: 'Claude', status: 'done', unread: false, at: RECENT },
    { label: 'Warm', agent: 'Claude', status: 'done', unread: false, at: STALE, cacheWarm: true },
    { label: 'Stale', agent: 'Codex', status: 'done', unread: false, at: STALE },
    { label: 'Unsaid', agent: 'Claude', status: 'done', unread: false },
  ];
  assert.deepEqual(
    matchSessions(rows, 'is:active', undefined, CLOCK).map((row) => row.label),
    ['Active', 'Warm'],
  );
  assert.deepEqual(
    matchSessions(rows, '-is:active', undefined, CLOCK).map((row) => row.label),
    ['Stale', 'Unsaid'],
  );
  // A caller that passes no clock asks no recency, so the term holds for no session.
  assert.deepEqual(matchSessions(rows, 'is:active'), []);

  // The term asks about recency alone, so a session an agent runs and one the reader put away
  // both hold it while inside the window. A lens that wants the sessions a reader can act on
  // excludes them in words, the same as `is:warm`.
  const filed = [
    { label: 'Person', agent: 'Claude', status: 'done', unread: false, at: RECENT },
    { label: 'Agent', agent: 'Claude', status: 'done', unread: false, at: RECENT, runByAgent: true },
    { label: 'Archived', agent: 'Claude', status: 'done', unread: false, at: RECENT, archived: true },
  ];
  assert.deepEqual(
    matchSessions(filed, 'is:active', undefined, CLOCK).map((row) => row.label),
    ['Person', 'Agent', 'Archived'],
  );
  assert.deepEqual(
    matchSessions(filed, 'is:active -is:archived -is:agentrun', undefined, CLOCK).map((row) => row.label),
    ['Person'],
  );
});

// `is:needsyou` asks for an active session that waits on the reader or is unread. It reads the
// same recency `is:active` reads.
test('is:needsyou keeps the active sessions that wait on the reader or are unread', () => {
  assert.deepEqual(parseSessionQuery('is:needsyou').terms, [{ field: 'status', needle: 'needsyou' }]);
  const rows = [
    { label: 'Waiting', agent: 'Claude', status: 'waiting', unread: false, at: RECENT },
    { label: 'Unread', agent: 'Claude', status: 'done', unread: true, at: RECENT },
    { label: 'Read', agent: 'Claude', status: 'done', unread: false, at: RECENT },
    { label: 'Stale-waiting', agent: 'Claude', status: 'waiting', unread: true, at: STALE },
  ];
  const match = (query: string) => matchSessions(rows, query, undefined, CLOCK);
  assert.deepEqual(
    match('is:needsyou').map((row) => row.label),
    ['Waiting', 'Unread'],
  );
  assert.deepEqual(
    match('-is:needsyou').map((row) => row.label),
    ['Read', 'Stale-waiting'],
  );
  // It holds exactly where `is:active` and one of `is:input` or `is:unread` both hold.
  const either = new Set([...match('is:active is:input'), ...match('is:active is:unread')]);
  assert.deepEqual(
    match('is:needsyou'),
    rows.filter((row) => either.has(row)),
  );
});

test('active: names a whole number of hours or days, or today, and nothing else', () => {
  assert.deepEqual(parseSessionQuery('active:6h').terms, [
    { field: 'active', needle: '6h', activeWindow: { unit: 'hour', count: 6 } },
  ]);
  assert.deepEqual(parseSessionQuery('ACTIVE:2D').terms, [
    { field: 'active', needle: '2d', activeWindow: { unit: 'day', count: 2 } },
  ]);
  assert.deepEqual(parseSessionQuery('-active:Today').terms, [
    { field: 'active', needle: 'today', activeWindow: { unit: 'today' }, negated: true },
  ]);
  assert.deepEqual(parseSessionQuery('active:').terms, [], 'an empty value added a term');
  for (const value of ['0h', '1.5h', '6', '6m', '-1h', 'week', '"6h"']) {
    const query = `active:${value}`;
    const terms = parseSessionQuery(query).terms;
    assert.equal(terms.length, 1, query);
    assert.equal(terms[0].activeWindow, undefined, `${query} named a window`);
    assert.deepEqual(matchSessions([{ label: 'Live', agent: 'Claude', at: CLOCK }], query, undefined, CLOCK), []);
  }
  assert.equal(sameQueryTerms('active:6H', 'active:6h'), true);
});

// `is:active` and `active:1h` read one window, so a stored `is:active` and `is:needsyou` keep
// their meaning. The rows sit on both sides of the hour edge.
test('is:active matches exactly the sessions active:1h matches', () => {
  const hour = 60 * 60_000;
  const rows = [
    { label: 'Now', agent: 'Claude', at: CLOCK },
    { label: 'Just inside', agent: 'Claude', at: CLOCK - hour + 1 },
    { label: 'On the edge', agent: 'Claude', at: CLOCK - hour },
    { label: 'Just outside', agent: 'Claude', at: CLOCK - hour - 1 },
    { label: 'Stale', agent: 'Codex', at: STALE },
    { label: 'Warm and stale', agent: 'Codex', at: STALE, cacheWarm: true },
    { label: 'Ahead of the clock', agent: 'Codex', at: CLOCK + 60_000 },
    { label: 'Unsaid', agent: 'Codex' },
  ];
  const labels = (query: string) => matchSessions(rows, query, undefined, CLOCK).map((row) => row.label);
  assert.deepEqual(labels('active:1h'), ['Now', 'Just inside', 'Warm and stale', 'Ahead of the clock']);
  for (const [status, window] of [
    ['is:active', 'active:1h'],
    ['-is:active', '-active:1h'],
    ['is:active -is:archived -is:agentrun', 'active:1h -is:archived -is:agentrun'],
  ]) {
    assert.deepEqual(labels(status), labels(window), `${status} and ${window} disagree`);
  }
});

test('active: hours and days reach back from the caller clock', () => {
  const hour = 60 * 60_000;
  const rows = [
    { label: '5h', agent: 'Claude', at: CLOCK - 5 * hour },
    { label: '7h', agent: 'Claude', at: CLOCK - 7 * hour },
    { label: '47h', agent: 'Claude', at: CLOCK - 47 * hour },
    { label: '49h', agent: 'Claude', at: CLOCK - 49 * hour },
  ];
  const labels = (query: string) => matchSessions(rows, query, undefined, CLOCK).map((row) => row.label);
  assert.deepEqual(labels('active:6h'), ['5h']);
  assert.deepEqual(labels('active:2d'), ['5h', '7h', '47h']);
  assert.deepEqual(labels('-active:6h'), ['7h', '47h', '49h']);
  // A caller that passes no clock asks no recency.
  assert.deepEqual(matchSessions(rows, 'active:2d'), []);
});

// `today` starts at local midnight, read from calendar fields. Chicago days are 23 hours long on
// 8 March 2026 and 25 hours long on 1 November 2026, so a fixed 24-hour day moves the edge.
test('active:today starts at local midnight across midnight and daylight-saving changes', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/Chicago';
  try {
    const local = (month: number, day: number, hour: number, minute = 0) =>
      new Date(2026, month - 1, day, hour, minute).getTime();
    const today = (at: number, clock: number) =>
      matchSessions([{ label: 'Row', agent: 'Claude', at }], 'active:today', undefined, clock).length === 1;
    // Across midnight: activity at 23:00 is today until the clock reaches midnight.
    const lateEvening = local(3, 6, 23);
    assert.equal(today(lateEvening, local(3, 7, 0) - 1), true, 'activity before midnight left today early');
    assert.equal(today(lateEvening, local(3, 7, 0)), false, 'activity before midnight stayed today past midnight');
    assert.equal(today(local(3, 7, 0), local(3, 7, 0)), true, 'activity at midnight was not today');
    // On the short day, noon is 11 hours after midnight.
    assert.equal(local(3, 8, 12) - local(3, 8, 0), 11 * 60 * 60_000);
    assert.equal(today(local(3, 8, 0, 30), local(3, 8, 12)), true, 'the short day lost its first hour');
    assert.equal(today(local(3, 7, 23, 30), local(3, 8, 12)), false, 'the short day reached into yesterday');
    // On the long day, noon is 13 hours after midnight.
    assert.equal(local(11, 1, 12) - local(11, 1, 0), 13 * 60 * 60_000);
    assert.equal(today(local(11, 1, 0, 30), local(11, 1, 12)), true, 'the long day lost its first hour');
    assert.equal(today(local(10, 31, 23, 30), local(11, 1, 12)), false, 'the long day reached into yesterday');
  } finally {
    if (previous === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previous;
    }
  }
});

test('is: completes nine values and no value is a prefix of another', () => {
  assert.equal(IS_VALUES.length, 9);
  assert.ok(IS_VALUES.includes('needsyou'));
  assert.deepEqual([...IS_VALUES].sort(), [...new Set(IS_VALUES)].sort());
  for (const left of IS_VALUES) {
    for (const right of IS_VALUES) {
      if (left === right) {
        continue;
      }
      assert.equal(left.startsWith(right), false, `${right} is a prefix of ${left}`);
    }
  }
});

test('every positive term holds when labels and statuses combine', () => {
  const rows = [
    { id: 'first', label: 'First', agent: 'Claude', labels: ['ui'], status: 'running' },
    { id: 'second', label: 'Second', agent: 'Claude', labels: ['bug'], status: 'running' },
    { id: 'both', label: 'Both', agent: 'Claude', labels: ['ui', 'bug'], status: 'running' },
    { id: 'neither', label: 'Neither', agent: 'Claude', labels: [], status: 'running' },
    { id: 'idle-both', label: 'Idle both', agent: 'Claude', labels: ['ui', 'bug'], status: 'done' },
  ];
  assert.deepEqual(
    matchSessions(rows, 'label:ui label:bug').map((row) => row.id),
    ['both', 'idle-both'],
  );
  assert.deepEqual(
    matchSessions(rows, 'label:ui label:bug is:running').map((row) => row.id),
    ['both'],
  );
});

test('full session identities select mixed providers and preserve global predicates', () => {
  const rows = [
    { id: 'ef5a03c3-f255-41b6-b57c-c15af453ac8a', agent: 'Claude', label: 'First', labels: ['arc'] },
    { id: 'codex-native', agent: 'Codex', label: 'Second', labels: ['arc'] },
    { id: 'unrelated', agent: 'Claude', label: 'Third', labels: ['arc'] },
    { id: 'codex-native', agent: 'Claude', label: 'Collision', labels: ['other'] },
    { id: 'codex-native', agent: 'Codex', label: 'Duplicate source', labels: ['arc'], archived: true },
  ];
  const union = 'session:claude:ef5a03c3-f255-41b6-b57c-c15af453ac8a OR session:codex:codex-native';
  assert.deepEqual(matchSessions(rows, union), [rows[0], rows[1], rows[4]]);
  assert.deepEqual(matchSessions(rows, `label:arc -is:archived ${union}`), [rows[0], rows[1]]);
  assert.deepEqual(matchSessions(rows, `agent:codex ${union}`), [rows[1], rows[4]]);
  assert.deepEqual(matchSessions(rows, 'session:codex-native -session:codex:codex-native'), [rows[3]]);
  assert.deepEqual(matchSessions(rows, 'session:CODEX:codex-native'), [rows[1], rows[4]]);
  for (const query of [
    'session:CODEX-NATIVE',
    'session:codex-nat',
    'session:unknown',
    'session:codex-native session:unrelated',
  ])
    assert.deepEqual(matchSessions(rows, query), [], query);
  assert.deepEqual(matchSessions(rows, 'session:codex-native OR session:codex-native'), [rows[1], rows[3], rows[4]]);
  assert.ok(
    sameQueryTerms(
      union,
      'session:codex:codex-native OR session:claude:ef5a03c3-f255-41b6-b57c-c15af453ac8a OR session:codex:codex-native',
    ),
  );
  assert.ok(!sameQueryTerms('session:claude:codex-native', 'session:codex:codex-native'));
  assert.ok(!sameQueryTerms('session:codex-native OR session:unrelated', 'session:codex-native session:unrelated'));
});

test('quote-headed session selectors remain literal title text', () => {
  const rows = [
    { id: 'one', agent: 'Claude', label: 'Unrelated' },
    { id: 'literal', agent: 'Codex', label: 'Discuss session:one' },
    { id: 'other', agent: 'Claude', label: 'Discuss session:two' },
  ];
  assert.deepEqual(matchSessions(rows, '"session:one"'), [rows[1]]);
  assert.deepEqual(matchSessions(rows, 'session:"one"'), [rows[0]]);
  assert.deepEqual(parseSessionQuery('find: "session:one"').find, ['session:one']);
  assert.deepEqual(parseSessionQuery('find: "session:one"').terms, []);
  assert.deepEqual(parseSessionQuery('"agent:codex"').terms, [{ field: 'agent', needle: 'codex' }]);
  assert.deepEqual(parseSessionQuery('"title:one"').terms, [{ field: 'title', needle: 'one' }]);
  assert.deepEqual(parseSessionQuery('"label:Arc"').terms, [{ field: 'labels', needle: 'Arc' }]);
  assert.deepEqual(parseSessionQuery('"cost:>1"').terms, [{ field: 'cost', needle: '>1' }]);
  assert.deepEqual(parseSessionQuery('"cache-expiry:<1"').terms, [{ field: 'cache-expiry', needle: '<1' }]);
  assert.deepEqual(parseSessionQuery('"is:unread"').terms, [{ field: 'status', needle: 'unread' }]);
  assert.deepEqual(parseSessionQuery('"find:one"').find, ['one']);
  assert.equal(parseSessionQuery('"in:prompt"').where, 'prompt');
});

test('malformed selectors and selector OR chains never widen results', () => {
  for (const query of [
    'session:',
    '-session:',
    'session:claude:',
    'session:other:id',
    'session:/path',
    'session:one OR',
    'OR session:one',
    'session:one OR OR session:two',
    'session:one OR title:Timeline',
    'title:Timeline OR session:one',
    '-session:one OR session:two',
    'session:one OR -session:two',
    'session:"two words"',
  ])
    assert.deepEqual(matchSessions(sessions, query), [], query);
  assert.deepEqual(matchSessions([{ id: 'a', agent: 'claude', label: 'OR or' }], 'OR'), [
    { id: 'a', agent: 'claude', label: 'OR or' },
  ]);
  assert.deepEqual(parseSessionQuery('find: OR').find, ['or']);
  assert.equal(parseSessionQuery('session:a OR session:b OR session:c').terms.length, 1);
  assert.equal(parseSessionQuery('session:a "OR" session:b').terms.length, 3);
  assert.equal(parseSessionQuery('session:a or session:b').terms.length, 3);
});

test('listing queries reject unavailable axes and never invert missing agent-run facts', () => {
  for (const query of ['find:x', 'find:', 'in:both', 'cost:>1', 'cache-expiry:<1', 'is:unread', 'is:running'])
    assert.match(listingQueryError(query)!, /arc filter/);
  assert.equal(listingQueryError('label:arc -is:archived session:a OR session:codex:b'), null);
  const row = { sessionId: 'a', agent: 'claude', title: 'First', labels: [], archived: false, agentRun: null };
  assert.equal(listingTermHolds(parseSessionQuery('-is:agentrun').terms[0], row), false);
});

test('ID shorthand resolves unions and collisions against complete catalog identities', () => {
  const rows = [
    { id: 'abcdefgh-one', agent: 'Claude', label: 'First', labels: ['arc'] },
    { id: 'ijklmnop-two', agent: 'Codex', label: 'Second', labels: ['arc'] },
    { id: 'abcdefgh-other', agent: 'Codex', label: 'Hidden', archived: true },
    { id: 'abcdefgh-one', agent: 'Claude', label: 'Duplicate source' },
    { id: 'one', agent: 'Claude', label: 'Short' },
    { id: 'abcdefgh', agent: 'Claude', label: 'Exact' },
  ];
  const context = (
    pool = rows.slice(0, 5),
    coverage: SessionQueryContext['coverage'] = 'complete',
  ): SessionQueryContext => ({
    identities: pool.map((row) => ({ sessionId: row.id, agent: row.agent })),
    coverage,
    scope: 'scope',
    revision: '1',
  });
  const full = context();
  assert.deepEqual(matchSessions(rows, 'id:abcdefgh label:arc id:ijklmnop -id:codex:abcdefgh', full), [
    rows[0],
    rows[1],
  ]);
  assert.deepEqual(matchSessions(rows, 'id:claude:abcdefgh id:codex:ijklmnop', full), [rows[0], rows[1], rows[3]]);
  assert.deepEqual(matchSessions(rows, 'session:abcdefgh session:ijklmnop', full), []);
  assert.deepEqual(matchSessions(rows, 'id:abcdefgh session:ijklmnop', full), []);
  assert.deepEqual(matchSessions(rows, 'id:abcdefgh OR session:ijklmnop id:one', full), rows.slice(0, 5));
  assert.deepEqual(matchSessions(rows, 'session:abcdefgh OR session:ijklmnop id:one', full), []);
  assert.deepEqual(matchSessions(rows, 'id:abcdefg', full), []);
  assert.deepEqual(matchSessions(rows, 'id:ABCDEFGH', full), []);
  assert.deepEqual(matchSessions(rows, 'id:one', full), [rows[4]]);
  assert.deepEqual(matchSessions(rows, 'id:abcdefgh', context(rows)), [rows[5]]);
  assert.deepEqual(resolveSessionQuery('agent:claude id:abcdefgh', full).notes, ['abcdefgh matches 2 sessions.']);
  assert.ok(sameQueryTerms('id:abcdefgh id:ijklmnop', 'id:ijklmnop OR id:abcdefgh'));
  assert.ok(!sameQueryTerms('id:abcdefgh id:ijklmnop', 'session:abcdefgh session:ijklmnop'));
  for (const query of ['id:', '-id:', 'id:other:abcdefgh', 'id:abcdefgh OR label:arc', 'id:abcdefgh OR -id:ijklmnop'])
    assert.ok(sessionQueryError(query));
  assert.deepEqual(parseSessionQuery('find: "id:abcdefgh"').find, ['id:abcdefgh']);
  for (const query of ['id:abcdefgh', '-id:abcdefgh', 'session:codex:abcdefgh', 'id:one id:abcdefgh']) {
    for (const coverage of ['incomplete', 'unavailable'] as const) {
      assert.deepEqual(matchSessions(rows, query, context(undefined, coverage)), []);
      assert.match(sessionQueryResolutionError(query, context(undefined, coverage))!, /discovery/);
      assert.ok(
        resolveSessionQuery(query, context(undefined, coverage)).notes.every((note) => !note.includes('matches')),
      );
    }
    assert.equal(sessionQueryResolutionError(query, full), null);
  }
  const uuid = 'ef5a03c3-f255-41b6-b57c-c15af453ac8a';
  assert.deepEqual(
    matchSessions(
      [
        { id: uuid, agent: 'Claude', label: '' },
        { id: uuid + 'x', agent: 'Claude', label: '' },
      ],
      'id:' + uuid,
      context(),
    ),
    [{ id: uuid, agent: 'Claude', label: '' }],
  );
  for (const query of ['id:one', '-ID:claude:abcdefgh', 'session:codex:abcdefgh', '-session:abcdefgh'])
    assert.ok(sessionQueryNeedsShorthand(query));
  for (const query of [
    '"id:abcdefgh"',
    'find: "id:abcdefgh"',
    'session:one',
    'session:' + uuid,
    '-session:codex:' + uuid,
  ])
    assert.ok(!sessionQueryNeedsShorthand(query));
});

test('unknown agent-run classification matches neither polarity', () => {
  const rows = [{ id: 'unknown', agent: 'Claude', label: 'unknown', runByAgent: null }];
  assert.deepEqual(matchSessions(rows, 'is:agentrun'), []);
  assert.deepEqual(matchSessions(rows, '-is:agentrun'), []);
  assert.deepEqual(matchSessions(rows, ''), rows);
});
