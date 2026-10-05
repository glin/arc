// extension/src/turnsearch.test.ts
//
// The tests for turnsearch.ts. One that reads a second seam's names lives in turnview.test.ts
// instead, because neither file owns it. The builders a test is written against are here
// while only this file needs them, and in turnfixtures.ts once a second file does.
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
  // The engine is whole and nothing on screen starts a search: the box that did was taken
  // out and what replaces it is not built yet. The rule is kept and tested so the search can
  // be reached again by putting a control back, rather than by writing this a second time.
  const entries = [
    { sessionId: 'a', key: 'a:1', whole: true },
    { sessionId: 'b', key: 'b:1', whole: true },
    { sessionId: 'a', key: 'a:2', whole: true },
  ];
  // No session named: everything, and the flag says the answer is the workspace's.
  assert.deepEqual(searchScope(entries, null), { entries, scoped: false, whole: false });
  // One named: that session's entries alone, in their order.
  assert.deepEqual(searchScope(entries, 'a'), { entries: [entries[0], entries[2]], scoped: true, whole: true });
  // A session with no entries is a scoped search of nothing, never a quiet fall-back to
  // the whole workspace: the flag still says scoped, so the empty answer is worded as the
  // session's. It is not worded as the whole session either: nothing proved that
  // the search reached its first turn.
  assert.deepEqual(searchScope(entries, 'zzz'), { entries: [], scoped: true, whole: false });
  // Search reads its own window of a transcript. One entry from a read that stopped short
  // makes the whole scoped answer an answer about part of the session.
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
  // Without it nothing is searched at all, which is what keeps the expensive half from
  // running because somebody typed a letter in a box.
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
  // The reported query, word for word: in:response was silently ignored and the search
  // read as broken. Each synonym is pinned to its value here, not just to "some value".
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
  // Enter and the offer row prepend find: and drop nothing, so a query already holding
  // in: keeps it. This is the reported query with the word the offer types in front.
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
  // The synonym table is a plain object, so a bare lookup would find every prototype
  // member. in:constructor is a typo, never a hit.
  const proto = parseSessionQuery('find: x in:constructor');
  assert.equal(proto.where, 'both');
  assert.deepEqual(proto.unknownWhere, ['constructor']);
});

test('whereNote says an in: value was not understood, and stays quiet otherwise', () => {
  // The anchor, written out: the panel joins nothing, it draws this string.
  assert.equal(whereNote('find: x in:respons'), 'in:respons was not understood. Use in:prompt, in:summary or in:both.');
  assert.equal(whereNote('find: x in:response'), null);
  assert.equal(whereNote('find: x in:prompt'), null);
  assert.equal(whereNote(''), null);
  // One sentence, not a list: a query holds one typo far more often than two.
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
  // The empty word marks nothing. The skip is also what stops the scan looping: indexOf of
  // an empty needle past the end returns the length, not -1, for ever.
  assert.deepEqual(snippetRanges('abc', ['']), []);
});

test('a bare word can start a search, and an axis term cannot', () => {
  // Asked of the plain flag, never of the field: `title:` writes the same title field a
  // bare word does, and deciding by field made Enter on `title:foo` prepend `find:` on
  // every press while no search ever ran, because the axis term keeps the find list empty.
  assert.equal(canStartSearch('foo'), true);
  assert.equal(canStartSearch('agent:codex foo'), true);
  assert.equal(canStartSearch('title:foo'), false);
  assert.equal(canStartSearch('agent:codex'), false);
  assert.equal(canStartSearch('find: foo'), false);
  assert.equal(canStartSearch('find: title:foo'), false);
  assert.equal(canStartSearch(''), false);
  assert.equal(canStartSearch('in:prompt'), false);
  // The flag itself, so a copy that forgets to set it cannot pass by way of the field.
  assert.equal(parseSessionQuery('foo').terms[0].plain, true);
  assert.equal(parseSessionQuery('title:foo').terms[0].plain, undefined);
});

test('a control can set which half is searched without the reader typing the grammar', () => {
  assert.equal(withWhere('find: root', 'prompt'), 'find: root in:prompt');
  assert.equal(withWhere('find: root', 'summary'), 'find: root in:summary');
  // `both` is what no token already means, so setting it removes the token rather than
  // writing one the grammar would have to special-case.
  assert.equal(withWhere('find: root in:prompt', 'both'), 'find: root');
  // Rebuilt, not appended: a query holding several would otherwise keep them all and only the
  // last would win, which is a query that does not say what it does.
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
  // The card names its section after everything the reader asked, so a search that read
  // only the first of them would fail to find words the card is showing.
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
  // A turn asked once reads exactly as it did before there was a second half to read.
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
  // A turn with no closed answers searches by its summary alone, as before.
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
  // "Timeline UI work" holds both; "Codex pricing table" holds neither pair.
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

// The sessions the label axis is asked about. Two of them carry the same label written
// two ways, because folding is what makes those one label everywhere else in the panel.
const FILED = [
  { id: '1', label: 'Timeline UI work', agent: 'Claude', labels: ['release 0.4', 'perf'] },
  { id: '2', label: 'Codex pricing table', agent: 'Claude', labels: ['Release 0.4'] },
  { id: '3', label: 'Hook smoke test', agent: 'Codex', labels: [] },
  { id: '4', label: 'Release notes', agent: 'Codex' },
];

const filed = (q: string) => matchSessions(FILED, q).map((s) => s.id);

test('a label term matches a whole name, folded, where a title still matches a part of one', () => {
  // The whole name, because the reader picked it off a list that completes it in one press.
  // `label:re` answering with `release 0.4` would file the press under a label they did not
  // choose, and the two labels here differ only after the letters a partial match would take.
  assert.deepEqual(filed('label:perf'), ['1']);
  assert.deepEqual(filed('label:pe'), [], 'a label term answered to part of a name');
  assert.deepEqual(filed('label:perfect'), [], 'a label term answered to a name it only starts');
  // Folded the way every other lookup keyed by a label is, so one name written two ways is
  // one label to the box as well as to the card.
  assert.deepEqual(filed('label:"release 0.4"'), ['1', '2']);
  assert.deepEqual(filed('label:"RELEASE 0.4"'), ['1', '2']);
  // A session carrying no label answers no label term, and neither does one whose row
  // never carried a list at all.
  assert.deepEqual(filed('label:release'), []);
  // A title is prose, so it keeps the substring rule the reader has always had.
  assert.deepEqual(filed('title:timeline'), ['1']);
  assert.deepEqual(filed('release'), ['4'], 'a bare word stopped asking the title');
  // Half-typed, so the list must not empty under the reader while they finish the value.
  assert.deepEqual(filed('label:'), ['1', '2', '3', '4']);
  // And the axis narrows beside the others, because that is what a second word is for.
  assert.deepEqual(filed('label:perf agent:claude'), ['1']);
  assert.deepEqual(filed('label:perf agent:codex'), []);
});

test('a label value is folded once, by the rule that owns label names', () => {
  // `labelKey` folds by locale and this parser does not. Folded in both places, a dotted or
  // dotless I came out one way on the query and the other way on the name, so on a Turkish
  // host the suggestion list offered a name, one press wrote it, and the rail emptied.
  assert.deepEqual(parseSessionQuery('label:API').terms, [{ field: 'labels', needle: 'API' }]);
  assert.deepEqual(
    parseSessionQuery('LABEL:API').terms,
    [{ field: 'labels', needle: 'API' }],
    'the axis name is folded with the value, so a label term written in capitals asks the title',
  );
  // Every other value keeps this file's own fold, because each is compared with a word spelled
  // out here or matched inside lowercased prose. Folding the whole query by locale instead
  // turns `TITLE:` into `tıtle` and the axis stops resolving at all.
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
  // Without this `label:release 0.4` is two words: an axis term nothing matches, and a title
  // term beside it. A label with a space is the first one this reader will make.
  assert.deepEqual(parseSessionQuery('label:"release 0.4"').terms, [{ field: 'labels', needle: 'release 0.4' }]);
  assert.deepEqual(parseSessionQuery('label:release 0.4').terms, [
    { field: 'labels', needle: 'release' },
    { field: 'title', needle: '0.4', plain: true },
  ]);
  // The quotes bound a word and decide nothing else. A bare quoted word is still the title
  // term a bare word is, and a quoted value after `find:` is still one word to search for.
  assert.deepEqual(parseSessionQuery('"two words"').terms, [{ field: 'title', needle: 'two words', plain: true }]);
  assert.deepEqual(parseSessionQuery('find: "root commit"').find, ['root commit']);
  // A run nobody closed reaches the end of the query. The reader is mid-word until they type
  // the closing quote, and dropping the run until then would empty the rail under their hand.
  assert.deepEqual(parseSessionQuery('label:"release 0.').terms, [{ field: 'labels', needle: 'release 0.' }]);
  // Two quotes inside a quoted run stand for one quote character, which is the only way a
  // name holding a quote can be written at all.
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
  // A query the reader can read is one they can edit, so a value that needs no quotes gets
  // none. Every value the two older axes take is one of those.
  assert.equal(quoteQueryValue('perf'), 'perf');
  assert.equal(quoteQueryValue('release 0.4'), '"release 0.4"');
  assert.equal(quoteQueryValue('say "hi"'), '"say ""hi"""');
  assert.equal(quoteQueryValue(''), '');
  // The writer and the parser are two halves of one rule, so whatever one writes the other
  // reads back whole. A suggestion that cannot complete the name it offers is worse than no
  // suggestion at all.
  for (const name of ['perf', 'release 0.4', 'say "hi"', 'two  spaces', 'a"b']) {
    assert.equal(
      parseSessionQuery(`label:${quoteQueryValue(name)}`).terms[0].needle,
      name.toLowerCase(),
      `the parser does not read back the token written for "${name}"`,
    );
  }
});

test('the word the caret sits in is what a suggestion list is offered for', () => {
  // The axis it names and the value after it, plus where the word begins and ends, which is
  // what writes a completion back into the box without a rule in the browser for where a
  // word starts.
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
  // A word with no axis on it is all value, which is how a bare partial prefix is offered the
  // axis names.
  assert.deepEqual(queryToken('lab', 3), { prefix: '', value: 'lab', start: 0, end: 3 });
  // The quotes are inside the word, so a completion replaces them rather than doubling them.
  assert.deepEqual(queryToken('label:"release 0', 16), { prefix: 'label', value: 'release 0', start: 0, end: 16 });
  // A caret in whitespace, or in an empty box, is an empty word at the caret. The list has
  // something to offer there too, and the caller writes at the caret with no rule of its own.
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
  // The caret comes back beside the text because it is part of the same answer: the reader
  // carries on typing after what the list wrote.
  assert.equal(written.query.slice(0, written.caret), 'agent:codex label:"release 0.4"');
  // Whatever follows the word stays where it was, so a completion in the middle of a query
  // leaves the terms after it alone.
  assert.deepEqual(replaceToken('lab agent:codex', 0, 3, 'label:perf'), { query: 'label:perf agent:codex', caret: 10 });
  // Written into an empty box, and at a caret with no word under it.
  assert.deepEqual(replaceToken('', 0, 0, 'label:perf'), { query: 'label:perf', caret: 10 });
  assert.deepEqual(replaceToken('perf ', 5, 5, 'label:perf'), { query: 'perf label:perf', caret: 15 });
  // A token measured against a query the reader has since edited writes inside the box rather
  // than past its end.
  assert.deepEqual(replaceToken('ab', 40, 99, 'x'), { query: 'abx', caret: 3 });
  // An end before its start is an insert at the start rather than a cut backwards, so a
  // stale pair takes none of the query with it.
  assert.deepEqual(replaceToken('abcd', 3, 1, 'x'), { query: 'abcxd', caret: 4 });
});

test('the filter box is offered the labels the workspace has, in the order it counted them', () => {
  // Built by labelCounts, because that is the catalogue the extension actually sends and the
  // rows the panel actually holds. A list written out here would let this pass against a
  // shape the box never sees.
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
  // The catalogue's own order, which leads with what the workspace leans on. A list that
  // re-sorted itself per keystroke would move a row out from under the reader's hand.
  assert.deepEqual(
    labelSuggestions(counts, '').map((row) => row.name),
    ['release 0.4', 'Composer', 'perf'],
  );
  // Found by a part of the folded name, which is the opposite of what a term matches: the
  // reader types the few letters they remember, and the press takes the whole name.
  assert.deepEqual(
    labelSuggestions(counts, 'RELE').map((row) => row.name),
    ['release 0.4'],
  );
  assert.deepEqual(
    labelSuggestions(counts, 'e').map((row) => row.name),
    ['release 0.4', 'Composer', 'perf'],
  );
  assert.deepEqual(labelSuggestions(counts, 'nothing'), []);
  // The row hands back the whole word the box takes, axis and all, quoted when the name needs
  // it. The control that presses a row never has to know the grammar.
  assert.deepEqual(labelSuggestions(counts, 'perf'), [
    { name: 'perf', count: 1, countName: 'carried by one session', token: 'label:perf' },
  ]);
  assert.equal(labelSuggestions(counts, 'release')[0].token, 'label:"release 0.4"');
  assert.equal(labelSuggestions(counts, 'release')[0].countName, 'carried by 3 sessions');
  // And what a row writes is a term that matches the label it offered, which is the whole
  // point of the list: one press, one whole name.
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
  // One question, not two: a reader who names a label and then searches expects the results
  // to be that label's.
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
  // Search entries intentionally carry no spend or cache-expiry data. A cost or cache-expiry
  // term belongs to the rail and must not erase matching transcript text by treating that
  // absent figure as zero.
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
  // Nothing holds the literal string "agnet:codex" in its title, so the list empties. That is
  // a thing the reader can see and undo; an error message in a sidebar is one more thing to
  // dismiss.
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
  // The words a reader reaches for narrow the same way the value each one means does.
  // in:response searching both halves would return the prompt-only turn too, so this is
  // the case that fails if the synonym stops reaching the search.
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
  // "root" is what the reader asked and "commit" is what the agent answered. Neither half
  // holds both, so this is not a hit for either question.
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
  // The line, not a window: a summary is written in lines and a window opening mid-sentence
  // reads as noise.
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
  // Both occurrences, case-insensitively, as positions into the snippet itself, so the panel
  // can mark them without holding a copy of the matching rule.
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
  ];
  const keys = (query: string): string[] =>
    searchTurns(entries, query)
      .map((h) => h.key)
      .sort();
  assert.deepEqual(keys('is:archived find: patch'), ['away']);
  assert.deepEqual(keys('is:agentrun find: patch'), ['agent']);
  assert.deepEqual(keys('-is:archived -is:agentrun find: patch'), ['mine']);
  assert.deepEqual(keys('find: patch'), ['agent', 'away', 'mine']);
});

test('naming a session and searching it is one question, not two', () => {
  // Found by printing against the real store: `agent:codex find: patch` returned every turn
  // that said patch, from both agents, because the search ignored the terms beside it.
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
