// Session-query grammar, scoped search, snippets, and label completion.

import { test } from 'vitest';
import assert from 'node:assert';
import {
  SESSION_AXES,
  WHERE_SYNONYMS,
  canStartSearch,
  isSearch,
  labelSuggestions,
  matchSessions,
  parseSessionQuery,
  queryToken,
  quoteQueryValue,
  replaceToken,
  searchScope,
  searchTurns,
  searchablePrompt,
  searchableSummary,
  snippetAround,
  snippetRanges,
  whereNote,
  withWhere,
} from './turnsearch.ts';
import { labelCounts } from './turnlabels.ts';
import { entry, turn } from './turnfixtures.ts';

const SESSIONS = [
  { id: '1', label: 'Timeline UI work', agent: 'Claude' },
  { id: '2', label: 'Codex pricing table', agent: 'Claude' },
  { id: '3', label: 'Timeline UI work', agent: 'Codex' },
  { id: '4', label: 'Hook smoke test', agent: 'Codex' },
];

const ids = (q: string) => matchSessions(SESSIONS, q).map((s) => s.id);

const NL = String.fromCharCode(10);

test('the session on screen scopes the search to itself, and no control reaches it', () => {
  // The engine can scope entries to the selected session.

  const entries = [
    { sessionId: 'a', key: 'a:1', whole: true },
    { sessionId: 'b', key: 'b:1', whole: true },
    { sessionId: 'a', key: 'a:2', whole: true },
  ];
  // No session named: everything, and the flag says the answer is the workspace's.
  assert.deepEqual(searchScope(entries, null), { entries, scoped: false, whole: false });
  // One named: that session's entries alone, in their order.
  assert.deepEqual(searchScope(entries, 'a'), { entries: [entries[0], entries[2]], scoped: true, whole: true });
  // A missing selected session returns an empty scoped result without claiming whole-session coverage.

  assert.deepEqual(searchScope(entries, 'zzz'), { entries: [], scoped: true, whole: false });
  // One incomplete entry makes the scoped result partial.

  assert.equal(
    searchScope([entries[0], { sessionId: 'a', key: 'a:3', whole: false }], 'a').whole,
    false,
    'a partly read session answers as though the search reached its first turn',
  );
  assert.equal(
    searchScope([{ sessionId: 'a', key: 'a:1' }], 'a').whole,
    false,
    'an entry that never said what it covered answers for the whole session',
  );
});

test('every axis the table holds can actually be asked for', () => {
  for (const axis of SESSION_AXES) {
    const value = axis.field === 'cost' ? '>1' : axis.field === 'status' ? 'input' : 'x';
    const term =
      axis.field === 'cost'
        ? {
            field: axis.field,
            needle: value,
            comparison: { operator: '>' as const, threshold: { digits: '1', exponent: 0 } },
          }
        : axis.field === 'session'
          ? {
              field: axis.field,
              needle: value,
              identities: { any: new Set([value]), claude: new Set(), codex: new Set() },
              ...(axis.prefix === 'id' ? { shorthand: true } : {}),
            }
          : { field: axis.field, needle: value };
    assert.deepEqual(
      parseSessionQuery(`${axis.prefix}:${value}`).terms,
      [term],
      `the ${axis.prefix} axis is in the table but nothing reads it`,
    );
  }
});

test('find: switches the plain words after it from titles to what the turns say', () => {
  const q = parseSessionQuery('timeline find: root commit');
  // "timeline" came before the switch, so it still names a session.
  assert.deepEqual(q.terms, [{ field: 'title', needle: 'timeline', plain: true }]);
  assert.deepEqual(q.find, ['root', 'commit']);
  assert.equal(q.where, 'both');
  // Queries without find: filter titles without starting content search.

  assert.deepEqual(parseSessionQuery('root commit').find, []);
  assert.equal(isSearch('root commit'), false);
  assert.equal(isSearch('find: root'), true);
  // A bare find: is the switch and nothing else, so a query being typed does not search yet.
  assert.deepEqual(parseSessionQuery('find:').find, []);
  assert.equal(isSearch('find:'), false);
  // Attached to a word it is both the switch and the first word.
  assert.deepEqual(parseSessionQuery('find:root commit').find, ['root', 'commit']);
});

test('in: chooses which half of a turn is read, and an unknown value changes nothing', () => {
  assert.equal(parseSessionQuery('find: x in:prompt').where, 'prompt');
  assert.equal(parseSessionQuery('find: x in:summary').where, 'summary');
  assert.equal(parseSessionQuery('find: x in:both').where, 'both');
  // Not a value the axis holds, so the default stands rather than the list emptying.
  assert.equal(parseSessionQuery('find: x in:sideways').where, 'both');
  // And it is never mistaken for a word to search for.
  assert.deepEqual(parseSessionQuery('find: x in:prompt').find, ['x']);
});

test('in: reads the words a reader reaches for as the value each one means', () => {
  // Search-area synonyms map to their exact prompt or summary value.

  assert.equal(parseSessionQuery('find: x in:response').where, 'summary');
  assert.equal(parseSessionQuery('find: x in:answer').where, 'summary');
  assert.equal(parseSessionQuery('find: x in:reply').where, 'summary');
  assert.equal(parseSessionQuery('find: x in:ask').where, 'prompt');
  assert.equal(parseSessionQuery('find: x in:me').where, 'prompt');
  // The table itself only ever names values the grammar reads.
  for (const value of Object.values(WHERE_SYNONYMS)) {
    assert.ok(['both', 'prompt', 'summary'].includes(value), `${value} is not a search half`);
  }
  // A synonym is never mistaken for a word to search for, the rule in:prompt already has.
  assert.deepEqual(parseSessionQuery('find: x in:response').find, ['x']);
  // Prepending find: retains the supplied in:response term.

  const offered = parseSessionQuery('find: in:response dark blue');
  assert.equal(offered.where, 'summary');
  assert.deepEqual(offered.find, ['dark', 'blue']);
});

test('an in: value the grammar does not read is remembered so the panel can say so', () => {
  assert.deepEqual(parseSessionQuery('find: x in:respons').unknownWhere, ['respons']);
  assert.deepEqual(parseSessionQuery('find: x in:prompt').unknownWhere, []);
  assert.deepEqual(parseSessionQuery('find: x in:response').unknownWhere, []);
  // A half-typed in: is a reader mid-word, not a mistake.
  assert.deepEqual(parseSessionQuery('find: x in:').unknownWhere, []);
  // Prototype names are unknown search-area values rather than synonym entries.

  const proto = parseSessionQuery('find: x in:constructor');
  assert.equal(proto.where, 'both');
  assert.deepEqual(proto.unknownWhere, ['constructor']);
});

test('whereNote says an in: value was not understood, and stays quiet otherwise', () => {
  // whereNote returns the complete correction string for an unknown search-area value.
  assert.equal(whereNote('find: x in:respons'), 'in:respons was not understood. Use in:prompt, in:summary or in:both.');
  assert.equal(whereNote('find: x in:response'), null);
  assert.equal(whereNote('find: x in:prompt'), null);
  assert.equal(whereNote(''), null);
  // Report the first unknown search-area value.
  assert.equal(
    whereNote('in:respons in:summry'),
    'in:respons was not understood. Use in:prompt, in:summary or in:both.',
  );
});

test('match positions merge where they touch, and vanish where nothing matched', () => {
  // Adjacent and overlapping spans are one mark, not a seam of them.
  assert.deepEqual(snippetRanges('abcabc', ['abc', 'ab']), [[0, 6]]);
  assert.deepEqual(snippetRanges('ababa', ['aba']), [[0, 5]]);
  assert.deepEqual(snippetRanges('Case CASE case', ['case']), [
    [0, 4],
    [5, 9],
    [10, 14],
  ]);
  assert.deepEqual(snippetRanges('nothing here', ['xyz']), []);
  assert.deepEqual(snippetRanges('two words apart', ['two', 'apart']), [
    [0, 3],
    [10, 15],
  ]);
  // Skip empty needles because indexOf returns the string length after its end instead of terminating the scan.

  assert.deepEqual(snippetRanges('abc', ['']), []);
});

test('a bare word can start a search, and an axis term cannot', () => {
  // Only plain words can start content search. Explicit title terms retain their axis even though they use the title field.

  assert.equal(canStartSearch('foo'), true);
  assert.equal(canStartSearch('agent:codex foo'), true);
  assert.equal(canStartSearch('title:foo'), false);
  assert.equal(canStartSearch('agent:codex'), false);
  assert.equal(canStartSearch('find: foo'), false);
  assert.equal(canStartSearch('find: title:foo'), false);
  assert.equal(canStartSearch(''), false);
  assert.equal(canStartSearch('in:prompt'), false);
  // Check the plain flag separately from its title field.
  assert.equal(parseSessionQuery('foo').terms[0].plain, true);
  assert.equal(parseSessionQuery('title:foo').terms[0].plain, undefined);
});

test('a control can set which half is searched without the reader typing the grammar', () => {
  assert.equal(withWhere('find: root', 'prompt'), 'find: root in:prompt');
  assert.equal(withWhere('find: root', 'summary'), 'find: root in:summary');
  // Both is the default, so selecting it removes the in: token.

  assert.equal(withWhere('find: root in:prompt', 'both'), 'find: root');
  // Replace existing in: tokens rather than appending another value.

  assert.equal(withWhere('find: root in:prompt', 'summary'), 'find: root in:summary');
  assert.equal(withWhere('in:prompt find: root in:summary', 'prompt'), 'find: root in:prompt');
  // The terms beside it are left exactly where they were.
  assert.equal(withWhere('agent:codex find: a b', 'summary'), 'agent:codex find: a b in:summary');
  assert.equal(withWhere('', 'both'), '');
  // A synonym token is an in: token, so the control replaces it rather than stacking one.
  assert.equal(withWhere('find: x in:response', 'prompt'), 'find: x in:prompt');
  // And whatever it writes, the grammar reads it back as the same thing.
  for (const where of ['both', 'prompt', 'summary'] as const) {
    assert.equal(parseSessionQuery(withWhere('find: x', where)).where, where);
  }
});

test('a search reads everything the reader typed, not only the prompt that opened the turn', () => {
  // Searchable prompts include the opening prompt and later prompts shown on the card.

  const asked = searchablePrompt({
    prompt: 'start the parser work',
    laterPrompts: [
      { stepsBefore: 0, text: 'and keep the tests green', at: 2 },
      { stepsBefore: 0, text: 'one more thing', at: 3 },
    ],
  });
  assert.ok(asked.includes('start the parser work'));
  assert.ok(asked.includes('and keep the tests green'), 'words typed while the turn ran are unfindable');
  assert.ok(asked.includes('one more thing'));
  // A single prompt remains unchanged.
  assert.equal(searchablePrompt({ prompt: 'only this', laterPrompts: [] }), 'only this');
});

test('searchableSummary reads every answer, so a search can find what an earlier one said', () => {
  const t1 = new Date(2026, 7, 23, 14, 40).getTime();
  const t2 = new Date(2026, 7, 23, 14, 44).getTime();
  const finished = turn({
    summary: 'Second answer.',
    answers: [
      { stepsBefore: 0, text: 'First answer, with the deliverable link.', at: t1 },
      { stepsBefore: 0, text: 'Second answer.', at: t2 },
    ],
  });
  assert.equal(searchableSummary(finished), 'First answer, with the deliverable link.\n\nSecond answer.');
  // The live text closes the search text for a turn no response has closed yet.
  const running = turn({ summary: 'Live text.', answers: [{ stepsBefore: 0, text: 'First answer.', at: t1 }] });
  assert.equal(searchableSummary(running), 'First answer.\n\nLive text.');
  // With no completed answers, the summary supplies the search text.
  assert.equal(searchableSummary(turn({ summary: 'Only text.' })), 'Only text.');
  assert.equal(searchableSummary(turn({})), '');
});

test('an empty filter leaves every session on the list', () => {
  assert.deepEqual(ids(''), ['1', '2', '3', '4']);
  assert.deepEqual(ids('   '), ['1', '2', '3', '4']);
});

test('plain words match the session title, whatever case either is written in', () => {
  assert.deepEqual(ids('timeline'), ['1', '3']);
  assert.deepEqual(ids('TIMELINE'), ['1', '3']);
  assert.deepEqual(ids('hook'), ['4']);
  assert.deepEqual(ids('nothing here matches'), []);
});

test('every word has to match, because a second word is for narrowing', () => {
  // Timeline UI work matches both words. Codex pricing table matches neither pair.
  assert.deepEqual(ids('timeline work'), ['1', '3']);
  assert.deepEqual(ids('timeline pricing'), []);
});

test('an axis is asked by its prefix, and it narrows with the words beside it', () => {
  assert.deepEqual(ids('agent:codex'), ['3', '4']);
  assert.deepEqual(ids('agent:claude'), ['1', '2']);
  // The axis and a plain word together: Codex sessions whose title says timeline.
  assert.deepEqual(ids('agent:codex timeline'), ['3']);
  // `title:` is the same as writing the word on its own.
  assert.deepEqual(ids('title:timeline'), ids('timeline'));
});

// Case variants of the same label share lookup identity.

const FILED = [
  { id: '1', label: 'Timeline UI work', agent: 'Claude', labels: ['release 0.4', 'perf'] },
  { id: '2', label: 'Codex pricing table', agent: 'Claude', labels: ['Release 0.4'] },
  { id: '3', label: 'Hook smoke test', agent: 'Codex', labels: [] },
  { id: '4', label: 'Release notes', agent: 'Codex' },
];

const filed = (q: string) => matchSessions(FILED, q).map((s) => s.id);

test('a label term matches a whole name, folded, where a title still matches a part of one', () => {
  // Label terms require complete names and reject prefixes or longer names.

  assert.deepEqual(filed('label:perf'), ['1']);
  assert.deepEqual(filed('label:pe'), [], 'a label term answered to part of a name');
  assert.deepEqual(filed('label:perfect'), [], 'a label term answered to a name it only starts');
  // Case variants match through the shared label-name rule.

  assert.deepEqual(filed('label:"release 0.4"'), ['1', '2']);
  assert.deepEqual(filed('label:"RELEASE 0.4"'), ['1', '2']);
  // Empty and absent label lists match no complete label term.

  assert.deepEqual(filed('label:release'), []);
  // Title terms retain substring matching.
  assert.deepEqual(filed('title:timeline'), ['1']);
  assert.deepEqual(filed('release'), ['4'], 'a bare word stopped asking the title');
  // Half-typed, so the list must not empty under the reader while they finish the value.
  assert.deepEqual(filed('label:'), ['1', '2', '3', '4']);
  // And the axis narrows beside the others, because that is what a second word is for.
  assert.deepEqual(filed('label:perf agent:claude'), ['1']);
  assert.deepEqual(filed('label:perf agent:codex'), []);
});

test('a label value is folded once, by the rule that owns label names', () => {
  // The parser preserves label value case because labelKey owns locale folding.

  assert.deepEqual(parseSessionQuery('label:API').terms, [{ field: 'labels', needle: 'API' }]);
  assert.deepEqual(
    parseSessionQuery('LABEL:API').terms,
    [{ field: 'labels', needle: 'API' }],
    'the axis name is folded with the value, so a label term written in capitals asks the title',
  );
  // Other query axes and text values use the parser's locale-independent lowercase rule.

  assert.deepEqual(parseSessionQuery('TITLE:API').terms, [{ field: 'title', needle: 'api' }]);
  assert.deepEqual(parseSessionQuery('AGENT:Codex').terms, [{ field: 'agent', needle: 'codex' }]);
  assert.deepEqual(parseSessionQuery('API').terms, [{ field: 'title', needle: 'api', plain: true }]);
  assert.equal(parseSessionQuery('IN:Prompt').where, 'prompt');
  assert.deepEqual(parseSessionQuery('FIND: Root').find, ['root']);
  // And a name matches whichever case the reader typed, which is what the one fold buys.
  assert.deepEqual(filed('label:"RELEASE 0.4"'), ['1', '2']);
  assert.deepEqual(filed('label:"release 0.4"'), ['1', '2']);
});

test('a value in double quotes is one word, so a label holding a space can be typed', () => {
  // Quotes keep a label containing spaces in one term.

  assert.deepEqual(parseSessionQuery('label:"release 0.4"').terms, [{ field: 'labels', needle: 'release 0.4' }]);
  assert.deepEqual(parseSessionQuery('label:release 0.4').terms, [
    { field: 'labels', needle: 'release' },
    { field: 'title', needle: '0.4', plain: true },
  ]);
  // Quoted bare words remain title terms. Quoted words after find: remain search text.

  assert.deepEqual(parseSessionQuery('"two words"').terms, [{ field: 'title', needle: 'two words', plain: true }]);
  assert.deepEqual(parseSessionQuery('find: "root commit"').find, ['root commit']);
  // An unclosed quote consumes the remaining query while the reader types.

  assert.deepEqual(parseSessionQuery('label:"release 0.').terms, [{ field: 'labels', needle: 'release 0.' }]);
  // Two quotes inside a quoted value represent one quote.

  assert.deepEqual(parseSessionQuery('label:"say ""hi"""').terms, [{ field: 'labels', needle: 'say "hi"' }]);
  // The terms beside it are read exactly as they were.
  assert.deepEqual(parseSessionQuery('agent:codex label:"release 0.4" find: patch'), {
    terms: [
      { field: 'agent', needle: 'codex' },
      { field: 'labels', needle: 'release 0.4' },
    ],
    find: ['patch'],
    where: 'both',
    unknownWhere: [],
    unknownIs: [],
  });
});

test('a value is quoted only when it needs to be, and comes back as it went in', () => {
  // Leave values unquoted unless spaces or quotes require escaping.

  assert.equal(quoteQueryValue('perf'), 'perf');
  assert.equal(quoteQueryValue('release 0.4'), '"release 0.4"');
  assert.equal(quoteQueryValue('say "hi"'), '"say ""hi"""');
  assert.equal(quoteQueryValue(''), '');
  // The parser must recover each label value written by quoteQueryValue.

  for (const name of ['perf', 'release 0.4', 'say "hi"', 'two  spaces', 'a"b']) {
    assert.equal(
      parseSessionQuery(`label:${quoteQueryValue(name)}`).terms[0].needle,
      name.toLowerCase(),
      `the parser does not read back the token written for "${name}"`,
    );
  }
});

test('the word the caret sits in is what a suggestion list is offered for', () => {
  // queryToken returns the axis, typed value, and replacement boundaries for the caret's word.

  assert.deepEqual(queryToken('agent:codex label:perf', 17), { prefix: 'label', value: 'perf', start: 12, end: 22 });
  assert.deepEqual(
    queryToken('agent:codex label:perf', 22),
    { prefix: 'label', value: 'perf', start: 12, end: 22 },
    'the caret at the end of a word reads as though it were somewhere else',
  );
  assert.deepEqual(queryToken('agent:codex label:perf', 12), { prefix: 'label', value: 'perf', start: 12, end: 22 });
  // The prefix is folded, because a caller compares it with an axis name. The value is handed
  // back as typed, because whoever matches it owns the fold for its own subject.
  assert.deepEqual(queryToken('LABEL:Perf', 10), { prefix: 'label', value: 'Perf', start: 0, end: 10 });
  // A bare word has an empty prefix so it can complete an axis name.

  assert.deepEqual(queryToken('lab', 3), { prefix: '', value: 'lab', start: 0, end: 3 });
  // The quotes are inside the word, so a completion replaces them rather than doubling them.
  assert.deepEqual(queryToken('label:"release 0', 16), { prefix: 'label', value: 'release 0', start: 0, end: 16 });
  // Whitespace and empty queries produce an empty token at the caret.

  assert.deepEqual(queryToken('perf ', 5), { prefix: '', value: '', start: 5, end: 5 });
  assert.deepEqual(queryToken('', 0), { prefix: '', value: '', start: 0, end: 0 });
  assert.deepEqual(
    queryToken('perf', 99),
    { prefix: '', value: 'perf', start: 0, end: 4 },
    'a caret past the end of the box is read somewhere the box does not reach',
  );
});

test('a completion replaces the word it was offered for and says where the caret goes', () => {
  const written = replaceToken('agent:codex lab', 12, 15, 'label:"release 0.4"');
  assert.deepEqual(written, { query: 'agent:codex label:"release 0.4"', caret: 31 });
  // Completion places the caret after the inserted token.

  assert.equal(written.query.slice(0, written.caret), 'agent:codex label:"release 0.4"');
  // Terms following the replaced token remain unchanged.

  assert.deepEqual(replaceToken('lab agent:codex', 0, 3, 'label:perf'), { query: 'label:perf agent:codex', caret: 10 });
  // Written into an empty box, and at a caret with no word under it.
  assert.deepEqual(replaceToken('', 0, 0, 'label:perf'), { query: 'label:perf', caret: 10 });
  assert.deepEqual(replaceToken('perf ', 5, 5, 'label:perf'), { query: 'perf label:perf', caret: 15 });
  // Clamp stale token bounds to the current query length.

  assert.deepEqual(replaceToken('ab', 40, 99, 'x'), { query: 'abx', caret: 3 });
  // A reversed range inserts at its start without deleting text.

  assert.deepEqual(replaceToken('abcd', 3, 1, 'x'), { query: 'abcxd', caret: 4 });
});

test('the filter box is offered the labels the workspace has, in the order it counted them', () => {
  // labelCounts supplies the same catalog row shape sent to the panel.

  const counts = labelCounts({
    s1: ['release 0.4', 'Composer', 'perf'],
    s2: ['release 0.4', 'Composer'],
    s3: ['release 0.4'],
  });
  assert.deepEqual(
    counts.map((row) => row.name),
    ['release 0.4', 'Composer', 'perf'],
    'the catalogue this reads is not the one the assertions below are written against',
  );
  // Empty-value suggestions retain catalog order.

  assert.deepEqual(
    labelSuggestions(counts, '').map((row) => row.name),
    ['release 0.4', 'Composer', 'perf'],
  );
  // Suggestions match folded substrings and complete the full name.

  assert.deepEqual(
    labelSuggestions(counts, 'RELE').map((row) => row.name),
    ['release 0.4'],
  );
  assert.deepEqual(
    labelSuggestions(counts, 'e').map((row) => row.name),
    ['release 0.4', 'Composer', 'perf'],
  );
  assert.deepEqual(labelSuggestions(counts, 'nothing'), []);
  // Suggestion rows include the complete quoted label token.

  assert.deepEqual(labelSuggestions(counts, 'perf'), [
    { name: 'perf', count: 1, countName: 'carried by one session', token: 'label:perf' },
  ]);
  assert.equal(labelSuggestions(counts, 'release')[0].token, 'label:"release 0.4"');
  assert.equal(labelSuggestions(counts, 'release')[0].countName, 'carried by 3 sessions');
  // Every offered token matches the label it names.

  for (const row of labelSuggestions(counts, '')) {
    assert.deepEqual(
      matchSessions([{ id: 'x', label: 'A session', agent: 'Claude', labels: [row.name] }], row.token).map((s) => s.id),
      ['x'],
      `the token for "${row.name}" matches nothing once it is typed`,
    );
  }
});

test('a label term narrows a content search the way an agent term does', () => {
  const entries = [
    entry({ key: 'a', sessionId: '1', startedAt: 1000, prompt: 'fix the root commit parser', labels: ['perf'] }),
    entry({ key: 'b', sessionId: '2', startedAt: 2000, prompt: 'fix the root commit rule', labels: ['release 0.4'] }),
    entry({ key: 'c', sessionId: '3', startedAt: 3000, prompt: 'fix the root commit test' }),
  ];
  // Label terms narrow content-search results.

  assert.deepEqual(
    searchTurns(entries, 'label:perf find: root commit').map((h) => h.key),
    ['a'],
  );
  assert.deepEqual(
    searchTurns(entries, 'label:"release 0.4" find: root commit').map((h) => h.key),
    ['b'],
  );
  // A turn whose session carries no label answers no label term, and every turn is still
  // searched when no term names one.
  assert.deepEqual(
    searchTurns(entries, 'find: root commit').map((h) => h.key),
    ['c', 'b', 'a'],
  );
  // Content search omits numeric session filters because its entries carry no cost or cache-expiry facts.

  assert.deepEqual(
    searchTurns(entries, 'cost:>5 find: root commit').map((h) => h.key),
    ['c', 'b', 'a'],
  );
  assert.deepEqual(
    searchTurns(entries, 'cache-expiry:>0 find: root commit').map((h) => h.key),
    ['c', 'b', 'a'],
  );
});

test('an unknown prefix is read as text, so a typo narrows rather than erroring', () => {
  // Unknown prefixes remain literal title text and narrow the list.

  assert.deepEqual(ids('agnet:codex'), []);
  assert.deepEqual(parseSessionQuery('agnet:codex').terms, [{ field: 'title', needle: 'agnet:codex', plain: true }]);
});

test('a half-typed axis does not empty the list while it is being typed', () => {
  // "agent:" on its own is what the box holds for as long as it takes to type the value.
  assert.deepEqual(parseSessionQuery('agent:').terms, []);
  assert.deepEqual(ids('agent:'), ['1', '2', '3', '4']);
});

test('a content search finds the turn and says which half it was found in', () => {
  const entries = [
    entry({ key: 'a', startedAt: 1000, prompt: 'fix the root commit parser', summary: 'Done.' }),
    entry({ key: 'b', startedAt: 2000, prompt: 'something else', summary: 'I changed the root commit rule.' }),
    entry({ key: 'c', startedAt: 3000, prompt: 'nothing here', summary: 'nor here' }),
  ];
  const both = searchTurns(entries, 'find: root commit');
  // Newest first, and the turn that matches nothing is not in it.
  assert.deepEqual(
    both.map((h) => h.key),
    ['b', 'a'],
  );
  assert.deepEqual(
    both.map((h) => h.where),
    ['summary', 'prompt'],
  );

  assert.deepEqual(
    searchTurns(entries, 'find: root commit in:prompt').map((h) => h.key),
    ['a'],
  );
  assert.deepEqual(
    searchTurns(entries, 'find: root commit in:summary').map((h) => h.key),
    ['b'],
  );
  // Search-area synonyms restrict results to the same half as their target value.

  assert.deepEqual(
    searchTurns(entries, 'find: root commit in:response').map((h) => h.key),
    ['b'],
  );
  assert.deepEqual(
    searchTurns(entries, 'find: root commit in:ask').map((h) => h.key),
    ['a'],
  );
  // No search asked for is no results, never every turn.
  assert.deepEqual(searchTurns(entries, 'root commit'), []);
  assert.deepEqual(searchTurns(entries, ''), []);
});

test('every word has to be in the same half, because a match split across two is neither', () => {
  // Words split between prompt and response form no hit for the combined query.

  const split = [entry({ prompt: 'about root', summary: 'about commit' })];
  assert.deepEqual(searchTurns(split, 'find: root commit'), []);
  // Each word on its own still finds it.
  assert.equal(searchTurns(split, 'find: root').length, 1);
  assert.equal(searchTurns(split, 'find: commit').length, 1);
});

test('a turn holding the words in both halves is one result, not two', () => {
  const twice = [entry({ prompt: 'about root', summary: 'also about root' })];
  assert.equal(searchTurns(twice, 'find: root').length, 1);
  // The prompt is read first, because that is what the reader typed.
  assert.equal(searchTurns(twice, 'find: root')[0].where, 'prompt');
});

test('the snippet is the line the word was found on, cut at both ends when it is long', () => {
  assert.equal(snippetAround('one line about root here', 'root'), 'one line about root here');
  // A snippet selects the matching line.

  assert.equal(snippetAround(`first line${NL}the root is here${NL}third line`, 'root'), 'the root is here');
  // Cut ends are marked, so a snippet never reads as the whole of what was written.
  const long = `${'x'.repeat(100)} root ${'y'.repeat(300)}`;
  const cut = snippetAround(long, 'root');
  assert.ok(cut!.startsWith('...'), 'a cut head is not marked');
  assert.ok(cut!.endsWith('...'), 'a cut tail is not marked');
  assert.ok(cut!.includes('root'), 'the word searched for is not in its own snippet');
  assert.ok(cut!.length < 200, `the snippet is a paragraph, not a line: ${cut!.length} characters`);
  // A word that is not there has no line to show.
  assert.equal(snippetAround('nothing here', 'root'), null);
});

test('a hit says where each searched word sits in its snippet', () => {
  const hits = searchTurns([entry({ summary: 'the Root commit and the root rule' })], 'find: root');
  assert.equal(hits.length, 1);
  // Match ranges identify each case-insensitive occurrence within the snippet.

  assert.deepEqual(hits[0].ranges, [
    [4, 8],
    [24, 28],
  ]);
  for (const [from, to] of hits[0].ranges) {
    assert.equal(hits[0].snippet.slice(from, to).toLowerCase(), 'root');
  }
});

test('a content search reads the archived and agent-run facts its entries carry', () => {
  const entries = [
    entry({ key: 'mine', sessionId: 'mine', summary: 'about the patch' }),
    entry({ key: 'away', sessionId: 'away', summary: 'about the patch', archived: true }),
    entry({ key: 'agent', sessionId: 'agent', summary: 'about the patch', runByAgent: true }),
    entry({ key: 'unknown', sessionId: 'unknown', summary: 'about the patch', runByAgent: null }),
  ];
  const keys = (query: string): string[] =>
    searchTurns(entries, query)
      .map((h) => h.key)
      .sort();
  assert.deepEqual(keys('is:archived find: patch'), ['away']);
  assert.deepEqual(keys('is:agentrun find: patch'), ['agent']);
  assert.deepEqual(keys('-is:archived -is:agentrun find: patch'), ['mine']);
  assert.deepEqual(keys('find: patch'), ['agent', 'away', 'mine', 'unknown']);
});

test('naming a session and searching it is one question, not two', () => {
  // Agent terms must narrow transcript text matches to the named agent.

  const entries = [
    entry({ key: 'a', sessionTitle: 'Timeline UI', agent: 'Claude', summary: 'about the patch' }),
    entry({ key: 'b', sessionTitle: 'Codex work', agent: 'Codex', summary: 'about the patch' }),
    entry({ key: 'c', sessionTitle: 'Timeline UI', agent: 'Codex', summary: 'nothing relevant' }),
  ];
  assert.deepEqual(
    searchTurns(entries, 'find: patch')
      .map((h) => h.key)
      .sort(),
    ['a', 'b'],
  );
  assert.deepEqual(
    searchTurns(entries, 'agent:codex find: patch').map((h) => h.key),
    ['b'],
  );
  assert.deepEqual(
    searchTurns(entries, 'timeline find: patch').map((h) => h.key),
    ['a'],
  );
  // A term that matches no session leaves nothing, rather than falling back to all.
  assert.deepEqual(searchTurns(entries, 'agent:nobody find: patch'), []);
});

test('quote-headed session text searches content without selecting its identity', () => {
  const entries = [
    {
      sessionId: 'one',
      key: 'one:1',
      sessionTitle: 'Work',
      agent: 'Claude',
      startedAt: 1,
      prompt: 'Unrelated',
      summary: '',
    },
    {
      sessionId: 'literal',
      key: 'literal:1',
      sessionTitle: 'Work',
      agent: 'Codex',
      startedAt: 2,
      prompt: 'Discuss session:one',
      summary: '',
    },
    {
      sessionId: 'other',
      key: 'other:1',
      sessionTitle: 'Work',
      agent: 'Claude',
      startedAt: 3,
      prompt: 'Discuss session:two',
      summary: '',
    },
  ];
  assert.deepEqual(
    searchTurns(entries, 'find: "session:one"').map((hit) => hit.sessionId),
    ['literal'],
  );
  assert.deepEqual(
    searchTurns(entries, 'session:"one" find:Unrelated').map((hit) => hit.sessionId),
    ['one'],
  );
});

test('content search narrows mixed-provider results through native session IDs', () => {
  const entries = ['one', 'two', 'other'].map((sessionId, index) => ({
    sessionId,
    key: sessionId + ':1',
    sessionTitle: 'Work',
    agent: index === 1 ? 'Codex' : 'Claude',
    startedAt: index,
    prompt: 'needle OR',
    summary: '',
  }));
  assert.deepEqual(
    searchTurns(entries, 'session:claude:one OR session:codex:two find:needle').map((hit) => hit.sessionId),
    ['two', 'one'],
  );
  assert.deepEqual(searchTurns(entries, 'session:one OR find:needle'), []);
  assert.equal(searchTurns(entries, 'find: OR').length, 3);
});

test('content prefix matching reads hidden catalog identities and suspends incomplete exclusions', () => {
  const entries = [
    entry({ sessionId: 'abcdefgh-one', agent: 'Claude', prompt: 'needle' }),
    entry({ sessionId: 'other', agent: 'Codex', prompt: 'needle' }),
  ];
  const identities = [
    { sessionId: 'abcdefgh-one', agent: 'Claude' },
    { sessionId: 'abcdefgh-hidden', agent: 'Codex' },
    { sessionId: 'other', agent: 'Codex' },
  ];
  const context = { identities, coverage: 'complete' as const, scope: 'scope', revision: '1' };
  assert.deepEqual(
    searchTurns(entries, 'id:abcdefgh find:needle', 0, context).map((hit) => hit.sessionId),
    ['abcdefgh-one'],
  );
  for (const coverage of ['incomplete', 'unavailable'] as const)
    assert.deepEqual(searchTurns(entries, '-id:abcdefgh find:needle', 0, { ...context, coverage }), []);
  assert.deepEqual(
    searchTurns(entries, '-id:abcdefgh find:needle', 0, { ...context, revision: '2' }).map((hit) => hit.sessionId),
    ['other'],
  );
});
