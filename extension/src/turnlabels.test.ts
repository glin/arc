// extension/src/turnlabels.test.ts
//
// The tests for turnlabels.ts. Every one of them is written against what the reader sees on a
// card or in a list of labels, because the record behind those is state that outlives the
// code and a rule proved only on the function that wrote it proves nothing about what comes
// back.
import { test } from 'vitest';
import assert from 'node:assert';
import {
  DRAFT_SESSION_PREFIX,
  LABELS_PER_SESSION,
  LABEL_NAME_LIMIT,
  LABEL_NOTES,
  LABELLED_SESSION_LIMIT,
  RAIL_LABELS_SHOWN,
  adoptLabelSession,
  labelCounts,
  labelEditorRows,
  labelName,
  labelTypedNotes,
  labelsOf,
  normalizeSessionLabels,
  railLabelChips,
  setSessionLabels,
  sweepDraftLabels,
} from './turnlabels.ts';

test('stored labels come back usable when the record holding them is junk', () => {
  // Everything a state file can hold that a label record must survive, in one record: a key
  // written as a number, a key that names nothing, a bare name where a list belongs, an empty
  // name, a name of only spaces, a name past the ceiling, and values that are not text.
  const kept = normalizeSessionLabels({
    3: ['perf'],
    '': ['composer'],
    s1: 'perf',
    s2: ['', '   ', 'perf'],
    s3: ['x'.repeat(LABEL_NAME_LIMIT + 20)],
    s4: ['  release   0.4  '],
    s5: [42, null, undefined, { name: 'docs' }, 'docs'],
    s6: ['word '.repeat(20)],
  });
  assert.deepEqual(kept['3'], ['perf'], 'a key stored as a number no longer names its session');
  assert.ok(!('' in kept), 'the empty key files a session no card can draw');
  assert.ok(!('s1' in kept), 'a bare name where a list belongs was spelled out letter by letter');
  assert.deepEqual(kept.s2, ['perf'], 'an empty name and a name of only spaces are not labels');
  assert.deepEqual(kept.s4, ['release 0.4'], 'the spacing the reader typed reaches the chip');
  assert.deepEqual(kept.s5, ['docs'], 'a value that is not text became a label');
  assert.equal(kept.s3[0].length, LABEL_NAME_LIMIT, 'a name past the ceiling was not cut to it');
  assert.equal(kept.s6[0].endsWith(' '), false, 'a cut that landed on a space left the chip a trailing gap');
  assert.ok(kept.s6[0].length <= LABEL_NAME_LIMIT);
  // A name that is not a string at all, and a record that is not a record: both answer with
  // the empty thing rather than throwing, because a panel that throws reading its own state
  // draws nothing at all.
  assert.equal(labelName(42), '');
  assert.equal(labelName(undefined), '');
  assert.equal(labelName('  spaced   out  '), 'spaced out');
  assert.deepEqual(normalizeSessionLabels(null), {});
  assert.deepEqual(normalizeSessionLabels(['perf']), {});
  assert.deepEqual(normalizeSessionLabels('perf'), {});
});

test('one label keeps one spelling wherever the reader typed it', () => {
  const one = normalizeSessionLabels({ s1: ['perf'], s2: ['Perf'], s3: ['PERF', 'perf'] });
  assert.deepEqual(one.s2, ['perf'], 'the second session kept a spelling of its own');
  assert.deepEqual(one.s3, ['perf'], 'one session naming a label twice drew two chips');
  assert.deepEqual(
    [one.s1, one.s2, one.s3],
    [['perf'], ['perf'], ['perf']],
    'three sessions under one name are filed under more than one label',
  );
  assert.deepEqual(
    normalizeSessionLabels({ s1: ['perf', 'Perf'] }).s1,
    ['perf'],
    'one session naming a label in two cases is filed under both',
  );
  // The first spelling seen is what wins, so the same record written the other way round
  // keeps the capitals the reader typed first.
  const capital = normalizeSessionLabels({ s1: ['Perf'], s2: ['perf'] });
  assert.deepEqual(capital.s2, ['Perf'], 'the spelling that arrived first lost to a later one');
});

test('a session past the label ceiling keeps the labels it was given first', () => {
  const many = [...Array(LABELS_PER_SESSION + 5).keys()].map((i) => `label ${i}`);
  assert.ok(many.length > LABELS_PER_SESSION, 'the fixture is under the ceiling, so this cuts nothing');
  const kept = normalizeSessionLabels({ s1: many });
  assert.equal(kept.s1.length, LABELS_PER_SESSION, 'the ceiling on one session did not hold');
  assert.equal(kept.s1[0], 'label 0', 'the cut took the label the reader applied first');
  assert.equal(
    kept.s1[LABELS_PER_SESSION - 1],
    `label ${LABELS_PER_SESSION - 1}`,
    'the cut kept the wrong end of the list',
  );
});

// A name cut at the ceiling is cut between characters, not between the halves of one. A
// plain slice keeps a high surrogate whose pair it just dropped, and the chip then draws the
// replacement box that says the panel mangled the reader's own word.
// The same visible word reaches storage two ways: with its accent as one character, or as a
// letter and a combining mark. They are different strings to every comparison in this module,
// so a reader would end up carrying two labels that draw identically on every card and cannot
// be told apart by any control.
test('one visible label is one label however its accents arrived', () => {
  const composed = 'rélease';
  const decomposed = 'rélease';
  assert.notEqual(composed, decomposed, 'the fixture is one string, so this compares nothing');
  assert.equal(labelName(decomposed), composed, 'the decomposed spelling is filed as a label of its own');
  const kept = normalizeSessionLabels({ s1: [composed], s2: [decomposed] });
  assert.deepEqual(
    [kept.s1, kept.s2],
    [[composed], [composed]],
    'two sessions under one visible label are filed under two',
  );
});

test('a name cut at the ceiling never ends in half a character', () => {
  const cut = labelName('a'.repeat(LABEL_NAME_LIMIT - 1) + String.fromCodePoint(0x1f600));
  assert.equal(cut, 'a'.repeat(LABEL_NAME_LIMIT - 1));
  const last = cut.charCodeAt(cut.length - 1);
  assert.ok(last < 0xd800 || last > 0xdbff);
});

test('a workspace past the session ceiling keeps its most recent labelled sessions', () => {
  const src: Record<string, string[]> = {};
  for (let i = 0; i < LABELLED_SESSION_LIMIT + 20; i += 1) {
    src[`s${i}`] = ['perf'];
  }
  const kept = normalizeSessionLabels(src);
  assert.equal(Object.keys(kept).length, LABELLED_SESSION_LIMIT, 'the ceiling on the record did not hold');
  assert.ok(!('s0' in kept), 'the oldest labelled session survived, so the cut took the wrong end');
  assert.ok(`s${LABELLED_SESSION_LIMIT + 19}` in kept, 'the session labelled last was dropped');
});

test('labelling one session leaves every other session alone', () => {
  const before = normalizeSessionLabels({
    s1: ['composer', 'release 0.4'],
    s2: ['perf'],
    s3: ['composer'],
  });
  const after = setSessionLabels(before, 's2', ['docs', 'Composer']);
  assert.deepEqual(after.s1, ['composer', 'release 0.4'], 'another session lost or reordered its labels');
  assert.deepEqual(after.s3, ['composer'], 'a session nobody touched came back changed');
  assert.deepEqual(
    after.s2,
    ['docs', 'composer'],
    'a spelling the workspace already carries lost to the capitals the reader typed',
  );
  assert.deepEqual(before.s2, ['perf'], 'the record handed in was edited in place');
  // Retyping the only holder's label is how its spelling changes, so this session's own
  // names must not be read back over the edit the reader just made.
  assert.deepEqual(
    setSessionLabels(before, 's1', ['Release 0.4']).s1,
    ['Release 0.4'],
    'the reader respelled the only session carrying a label and got the old spelling back',
  );
  // What `labelsOf` hands back belongs to the caller, so pushing to it cannot reach the state
  // and leave the screen and the storage disagreeing until the next reload.
  labelsOf(after, 's1').push('mine');
  assert.deepEqual(labelsOf(after, 's1'), ['composer', 'release 0.4']);
  assert.deepEqual(labelsOf(after, 'nobody'), [], 'a session with no labels answered with something');
  // An empty session names no session, so nothing is filed and nothing moves.
  assert.deepEqual(setSessionLabels(before, '', ['docs']), before);
});

test('a label disappears from the workspace once no session carries it', () => {
  const before = normalizeSessionLabels({ s1: ['perf', 'composer'], s2: ['perf'], s3: ['composer'] });
  const off = setSessionLabels(before, 's2', []);
  assert.ok(!('s2' in off), 'a session with no labels left is still filed under an empty list');
  const gone = setSessionLabels(off, 's1', ['composer']);
  // The record is the whole answer to which labels exist, so a label no session carries
  // is a label the workspace does not have. Nothing has to clean one up.
  assert.deepEqual(
    Object.values(gone).flat().sort(),
    ['composer', 'composer'],
    'a label no session carries is still named somewhere in the record',
  );
  assert.deepEqual(gone.s3, ['composer'], 'taking a label off one session took it off another');
});

test('a session the reader labelled while it was starting keeps its labels', () => {
  const drafted = normalizeSessionLabels({ 'new:1': ['composer', 'perf'], s9: ['docs'] });
  const moved = adoptLabelSession(drafted, 'new:1', 'abc');
  assert.deepEqual(moved.abc, ['composer', 'perf'], 'the labels did not reach the id the agent gave back');
  assert.ok(!('new:1' in moved), 'the session is filed twice, once under an id no card can show');
  assert.deepEqual(moved.s9, ['docs'], 'an unrelated session moved with the adoption');
  // And the session lands at the newest end of the record, so the next cut takes an
  // older entry rather than the one the reader filed seconds ago.
  const held = normalizeSessionLabels({ abc: ['docs'], s9: ['perf'], 'new:1': ['composer'] });
  assert.equal(
    Object.keys(adoptLabelSession(held, 'new:1', 'abc')).pop(),
    'abc',
    'the merged session kept the position it had before the reader filed it',
  );
  // The id the agent gave back already carries labels, so the draft's lead and the one they
  // share is drawn once. The draft's lead because they are the newest thing the reader said,
  // and because the row draws the front of the list.
  const both = normalizeSessionLabels({ 'new:1': ['composer', 'perf'], abc: ['perf', 'release 0.4'] });
  assert.deepEqual(
    adoptLabelSession(both, 'new:1', 'abc').abc,
    ['composer', 'perf', 'release 0.4'],
    'the merge repeated a label or put what the reader could already see ahead of the draft',
  );
  // No id, or the same id twice: nothing to move and nothing to lose.
  assert.deepEqual(adoptLabelSession(both, 'new:1', 'new:1'), both);
  assert.deepEqual(adoptLabelSession(both, '', 'abc'), both);
  assert.deepEqual(adoptLabelSession(both, 'new:1', ''), both);
});

test('a session that never got an id of its own leaves no label behind it', () => {
  // The panel files a session it started under a provisional id held in memory alone.
  // Nothing brings that id back, so every entry under one is dead by the time the record is
  // read again: no card draws it, no control takes it off, and it holds a place under the
  // record ceiling for ever. Its labels also stand in the workspace catalogue with a count
  // beside them, so the filter box would offer a label that files nothing a reader can open.
  const stored = normalizeSessionLabels({
    [`${DRAFT_SESSION_PREFIX}a1b2`]: ['composer'],
    s9: ['docs', 'composer'],
    [`${DRAFT_SESSION_PREFIX}c3d4`]: ['perf'],
  });
  const swept = sweepDraftLabels(stored);
  assert.deepEqual(Object.keys(swept), ['s9'], 'an abandoned draft kept its place in the record');
  assert.deepEqual(swept.s9, ['docs', 'composer'], 'a real session lost labels to the sweep');
  // The catalogue is counted off the record, so a label the sweep left with nothing carrying
  // it is a label the workspace no longer has.
  assert.deepEqual(
    labelCounts(swept).map((row) => row.name),
    ['composer', 'docs'],
  );
  assert.deepEqual(
    labelCounts(stored).map((row) => row.name),
    ['composer', 'docs', 'perf'],
  );
  // The text a stored record actually holds, spelled out here rather than built back out of
  // the constant. Every record a shipped panel wrote carries `draft:` at the front of a
  // provisional id, so a constant edited on its own leaves all of them standing with nothing
  // able to reach them. The places panelhost.ts builds one are held to the same constant in
  // panel.webview.test.ts.
  assert.deepEqual(Object.keys(sweepDraftLabels({ 'draft:a1b2': ['composer'], s9: ['docs'] })), ['s9']);
  // A session whose real id merely holds the word is kept. The prefix opens the id or it
  // means nothing.
  assert.deepEqual(Object.keys(sweepDraftLabels({ 'session-draft:1': ['perf'] })), ['session-draft:1']);
  // The lists come back as copies, so a caller that sorts what it was handed does not edit
  // the record it came out of.
  const source = { s1: ['perf'] };
  const copy = sweepDraftLabels(source);
  copy.s1.push('composer');
  assert.deepEqual(source.s1, ['perf'], 'the sweep handed back the record it was given');
  // The keys and values a stored record can hold that no code wrote are refused here the way
  // they are everywhere else, because this reads storage that outlives the code.
  const junk = JSON.parse('{"__proto__": ["perf"], "s2": "perf", "s3": ["docs"]}') as Record<string, string[]>;
  assert.deepEqual(sweepDraftLabels(junk), { s3: ['docs'] });
});

// Normalization runs on every write, and a draft the reader is looking at right now is a live
// session. Its labels have to survive one, or a label put on a session while it was
// starting would be gone by the next keystroke and the adoption onto its real id would have
// nothing left to move.
test('normalizing a record keeps the labels of a draft the reader is still looking at', () => {
  const live = normalizeSessionLabels({ [`${DRAFT_SESSION_PREFIX}a1b2`]: ['composer'], s9: ['docs'] });
  assert.deepEqual(
    live[`${DRAFT_SESSION_PREFIX}a1b2`],
    ['composer'],
    'a live draft lost the label the reader had just put on it',
  );
  const written = setSessionLabels(live, `${DRAFT_SESSION_PREFIX}a1b2`, ['composer', 'perf']);
  assert.deepEqual(written[`${DRAFT_SESSION_PREFIX}a1b2`], ['composer', 'perf']);
  // And the adoption still has something to carry onto the id the agent gives back.
  assert.deepEqual(adoptLabelSession(written, `${DRAFT_SESSION_PREFIX}a1b2`, 'abc').abc, ['composer', 'perf']);
});

// A session already filed under its full complement of labels, adopting a draft that
// carries one more. Something has to give at the ceiling, and it must not be the label the
// reader put on the draft seconds before: that is the whole promise of the adoption, and a
// merge that walked the older list first would swallow the ceiling and drop it silently.
test('a draft label survives adoption onto a session already filed to its ceiling', () => {
  const full = [...Array(LABELS_PER_SESSION).keys()].map((i) => `label ${i}`);
  const both = normalizeSessionLabels({ 'new:1': ['fresh'], abc: full });
  assert.equal(both.abc.length, LABELS_PER_SESSION, 'the fixture is under the ceiling, so this proves nothing');
  const moved = adoptLabelSession(both, 'new:1', 'abc');
  assert.ok(moved.abc.includes('fresh'), 'the label the reader put on the draft was dropped at the ceiling');
  assert.equal(moved.abc.length, LABELS_PER_SESSION, 'the merge carried the session past its ceiling');
  assert.ok(!('new:1' in moved), 'the provisional entry outlived the id it was replaced by');
});

// The ceiling on one session stops the walk rather than cutting its result, so a name
// past it teaches the workspace no spelling. A spelling that no card carries would rewrite a
// later session's label to a word the reader can see nowhere.
test('a label past a session ceiling teaches the workspace no spelling', () => {
  const full = [...Array(LABELS_PER_SESSION).keys()].map((i) => `label ${i}`);
  const kept = normalizeSessionLabels({ s1: [...full, 'Perf'], s2: ['perf'] });
  assert.equal(kept.s1.length, LABELS_PER_SESSION, 'the ceiling on one session did not hold');
  assert.deepEqual(
    kept.s2,
    ['perf'],
    'a label dropped at the ceiling still rewrote another session to a spelling nothing draws',
  );
});

// The record's own ceiling holds while the window is open, not only on the way back from
// storage, and the session just filed goes to the newest end. Without both, a workspace
// at the ceiling grows past it all session, the newest filing keeps the oldest position, and
// the cut on the next reload throws away the entry the reader had just written.
test('filing a session holds the record to its ceiling and puts it at the newest end', () => {
  const src: Record<string, string[]> = {};
  for (let i = 0; i < LABELLED_SESSION_LIMIT; i += 1) {
    src[`s${i}`] = ['perf'];
  }
  const full = normalizeSessionLabels(src);
  assert.equal(Object.keys(full).length, LABELLED_SESSION_LIMIT, 'the fixture is under the ceiling');
  const added = setSessionLabels(full, 'fresh', ['docs']);
  assert.equal(Object.keys(added).length, LABELLED_SESSION_LIMIT, 'filing a session grew the record past its ceiling');
  assert.ok('fresh' in added, 'the session the reader just filed is the one that was dropped');
  assert.ok(!('s0' in added), 'the cut took the newest entry rather than the oldest');
  // Refiling a session that already had an entry moves it to the newest end, so the next
  // reload's cut cannot take the one the reader touched last.
  const refiled = setSessionLabels(added, 's1', ['release 0.4']);
  assert.equal(Object.keys(refiled).pop(), 's1', 'a refiled session kept the position it had when it was oldest');
});

// A session id is never `__proto__`, and stored state comes back from outside this code.
// A plain assignment under that key replaces the record's prototype instead of adding an
// entry, so the entry is lost and every later reader is handed an object shaped like whatever
// arrived.
test('a stored key naming no session cannot reshape the record it arrives in', () => {
  const hostile = JSON.parse('{"__proto__": ["perf"], "s1": ["docs"]}');
  const kept = normalizeSessionLabels(hostile);
  assert.deepEqual(kept, { s1: ['docs'] }, 'a key naming no session was filed anyway');
  assert.equal(Object.getPrototypeOf(kept), Object.prototype, 'the record came back with a prototype of its own');
  const set = setSessionLabels(kept, '__proto__', ['perf']);
  assert.deepEqual(set, { s1: ['docs'] }, 'the setter filed a key naming no session');
  assert.equal(Object.getPrototypeOf(set), Object.prototype, 'the setter reshaped the record it returned');
  // And the third writer, which is the one that takes an id straight off the wire.
  const adopted = adoptLabelSession({ 'new:1': ['perf'], s1: ['docs'] }, 'new:1', '__proto__');
  assert.deepEqual(
    adopted,
    { 'new:1': ['perf'], s1: ['docs'] },
    'adoption filed a session under a key naming none, and lost the labels doing it',
  );
  assert.equal(Object.getPrototypeOf(adopted), Object.prototype, 'adoption reshaped the record it returned');
});

// The ceiling on the record drops the oldest entries, and it must drop them before any
// spelling is read. An entry the cut throws away owning the spelling of a label leaves every
// card that survived drawing a word the reader can see nowhere in the workspace.
test('a labelled session the record ceiling drops teaches no spelling to the ones it keeps', () => {
  const src: Record<string, string[]> = { oldest: ['Perf'] };
  for (let i = 0; i < LABELLED_SESSION_LIMIT; i += 1) {
    src[`s${i}`] = ['perf'];
  }
  const kept = normalizeSessionLabels(src);
  assert.ok(!('oldest' in kept), 'the fixture is under the ceiling, so nothing was dropped');
  assert.deepEqual(kept.s0, ['perf'], 'the entry the cut dropped still owns the spelling every kept card draws');
  assert.deepEqual(
    [...new Set(Object.values(kept).flat())],
    ['perf'],
    'the record still names a spelling no session carries',
  );
});

// The same rule where a session is filed rather than read back. The entry being written
// takes one of the ceiling's places, and the rest are cut before their spellings are read.
test('filing a session reads its spellings off the entries that survive the ceiling', () => {
  // The oldest entry is the only holder of its label, so it is the only thing that could
  // teach that label's spelling, and the write is what drops it.
  const src: Record<string, string[]> = { oldest: ['Solo'] };
  for (let i = 0; i < LABELLED_SESSION_LIMIT - 1; i += 1) {
    src[`s${i}`] = ['perf'];
  }
  const full = normalizeSessionLabels(src);
  assert.ok('oldest' in full, 'the fixture is already over the ceiling, so the write proves nothing');
  const after = setSessionLabels(full, 'fresh', ['solo']);
  assert.ok(!('oldest' in after), 'the write did not hold the record to its ceiling');
  assert.deepEqual(
    after.fresh,
    ['solo'],
    'the entry the cut dropped taught the workspace the spelling of the label just filed',
  );
  // And taking every label off a session costs no other session its entry.
  const cleared = setSessionLabels(after, 's0', []);
  assert.equal(
    Object.keys(cleared).length,
    LABELLED_SESSION_LIMIT - 1,
    'clearing one session dropped another that was inside the ceiling',
  );
});

// A name made only of characters that draw nothing is not a name. The whitespace rules cover
// the space characters and none of these, so without the strip the card draws an outlined
// chip with a border around nothing, the accessible name closes with a label nobody can read,
// and no control can take it off because the entry is a label like any other.
test('a name that draws nothing at all is not a label', () => {
  const invisible = [0x0, 0x200b, 0x200e, 0xad, 0x2060, 0xfe0f].map((code) => String.fromCodePoint(code));
  for (const ch of invisible) {
    assert.equal(labelName(ch), '', `a name made of code point ${ch.codePointAt(0)} was filed as a label`);
  }
  assert.equal(labelName(invisible.join('')), '', 'a name made only of invisible characters was filed');
  // And one inside a real name goes without leaving a gap where it stood, because it drew
  // none. Taking it out from between a letter and its accent leaves two characters that
  // compose, which is why the name is put into NFC again after the strip.
  assert.equal(
    labelName('re' + invisible[1] + 'lease'),
    'release',
    'an invisible character inside a name split it in two or survived in it',
  );
  assert.equal(
    labelName('re' + invisible[1] + '́lease'),
    'rélease',
    'a name whose accent was split by an invisible character was left decomposed',
  );
  const kept = normalizeSessionLabels({ s1: [invisible[1]], s2: ['docs'] });
  assert.deepEqual(kept, { s2: ['docs'] }, 'a session filed under nothing keeps an entry');
});

// A tab and a line break are control characters as well as spaces, so the strip has to run
// after the whitespace collapse. The other way round it deletes them and joins the words
// either side into one, which is what a paste out of a browser table gives: the reader ends
// up with `release0.4` beside `release 0.4` and no control that puts the two together.
test('a tab or a line break in a name is a space, not a deletion', () => {
  const tab = String.fromCodePoint(9);
  const feed = String.fromCodePoint(10);
  const carriage = String.fromCodePoint(13);
  assert.equal(labelName('release' + tab + '0.4'), 'release 0.4', 'a tab joined the words either side of it');
  assert.equal(labelName('perf' + feed + 'release 0.4'), 'perf release 0.4', 'a line break joined two words');
  assert.equal(labelName('a' + carriage + feed + 'b'), 'a b', 'a carriage return and a line feed joined two words');
  // The next-line character is a line break that the JavaScript shorthand for whitespace
  // leaves out, so the strip would delete it and join the words either side.
  assert.equal(
    labelName('release' + String.fromCodePoint(0x85) + '0.4'),
    'release 0.4',
    'a next-line character joined the words either side of it',
  );
  // And the byte order mark is not a space at all, whatever that shorthand says. Collapsed
  // to one it would leave a gap the reader cannot account for in the middle of a name.
  assert.equal(
    labelName('release' + String.fromCodePoint(0xfeff) + '0.4'),
    'release0.4',
    'a byte order mark inside a name was drawn as a space',
  );
});

// The strip takes out what draws nothing and nothing else. The two joiners hold one glyph
// together out of several characters, a private-use code point is a glyph the reader's own
// font theme draws, and a combining mark sits on the letter before it.
test('a name keeps every character a reader can see', () => {
  const zwj = String.fromCodePoint(0x200d);
  const family = String.fromCodePoint(0x1f468) + zwj + String.fromCodePoint(0x1f4bb);
  assert.equal(
    labelName(family + ' work'),
    family + ' work',
    'the joiner went, so one glyph the reader typed was drawn as two',
  );
  // A run of joiners, so a rule that kept only the first would be caught.
  const four = [0x1f468, 0x1f469, 0x1f467, 0x1f466].map((c) => String.fromCodePoint(c)).join(zwj);
  assert.equal(labelName(four), four, 'a joiner after the first went, so one glyph became several');
  // A joiner that follows a variation selector rather than the emoji itself.
  const rainbow = String.fromCodePoint(0x1f3f3) + String.fromCodePoint(0xfe0f) + zwj + String.fromCodePoint(0x1f308);
  assert.equal(labelName(rainbow), rainbow, 'a joiner after a variation selector went');
  // And one that follows a skin tone, which is neither the emoji nor a combining mark.
  const astronaut = String.fromCodePoint(0x1f469) + String.fromCodePoint(0x1f3fd) + zwj + String.fromCodePoint(0x1f680);
  assert.equal(labelName(astronaut), astronaut, 'a joiner after a skin tone went');
  // A joiner that follows a virama, which is how the Indic scripts ask for a conjunct.
  const conjunct = String.fromCodePoint(0x915) + String.fromCodePoint(0x94d) + zwj + String.fromCodePoint(0x937);
  assert.equal(labelName(conjunct), conjunct, 'a joiner after a virama went, so the word changed form');
  const glyph = String.fromCodePoint(0xe0a0);
  assert.equal(
    labelName('branch ' + glyph),
    'branch ' + glyph,
    'a glyph the font theme supplies was taken out of the name',
  );
  assert.equal(labelName(glyph), glyph, 'a name that is only a font-theme glyph was refused');
  const heart = String.fromCodePoint(0x2764) + String.fromCodePoint(0xfe0f);
  assert.equal(labelName(heart), heart, 'the variation selector went, so the glyph changed shape');
  // A subdivision flag is a black flag and a run of tag characters. The tags are format
  // characters like the zero-width spaces, and taking them out leaves a plain black flag.
  const scotland =
    String.fromCodePoint(0x1f3f4) +
    [0xe0067, 0xe0062, 0xe0073, 0xe0063, 0xe0074, 0xe007f].map((c) => String.fromCodePoint(c)).join('');
  assert.equal(labelName(scotland), scotland, 'the flag tags went, so one glyph became another');
  // An unassigned code point draws a box. A box is a poor name and it is still something on
  // the card, which is more than the panel can say about what the reader meant.
  const unassigned = String.fromCodePoint(0x378);
  assert.equal(labelName(unassigned), unassigned, 'a name that draws a box was refused');
  // And the non-joiner stays wherever it is, because it is a letter-level character in the
  // scripts that use it and taking it out of a word changes the word.
  const zwnj = String.fromCodePoint(0x200c);
  assert.equal(
    labelName('mi' + zwnj + 'shavad'),
    'mi' + zwnj + 'shavad',
    'a non-joiner inside a word was taken out of it',
  );
});

// The cut runs before the check for anything visible, because the cut is what can take the
// only visible character a name had. A name of variation selectors with one letter at its
// end passes a check made first, and what reaches the card is the variation selectors.
// The cut counts UTF-16 units and knows nothing about where a sequence ends, so a ceiling
// that falls inside a family emoji leaves a joiner with nothing after it to join. That name
// draws exactly like the same name without it and folds to a different key, which is one
// label the reader can see twice on the rail.
test('a joiner the ceiling cut loose is not left on the end of the name', () => {
  const zwj = String.fromCodePoint(0x200d);
  const pair = String.fromCodePoint(0x1f468) + zwj + String.fromCodePoint(0x1f4bb);
  const name = 'a'.repeat(LABEL_NAME_LIMIT - 3) + pair;
  assert.ok(name.length > LABEL_NAME_LIMIT, 'the fixture is inside the ceiling, so nothing is cut');
  const cut = labelName(name);
  assert.ok(!cut.endsWith(zwj), 'the cut left a joiner on the end, so one name is two labels');
  assert.equal(
    cut,
    'a'.repeat(LABEL_NAME_LIMIT - 3) + String.fromCodePoint(0x1f468),
    'the cut took more or less than the sequence it could not fit',
  );
  // And a flag keeps the tags it legitimately ends with.
  const scotland =
    String.fromCodePoint(0x1f3f4) +
    [0xe0067, 0xe0062, 0xe0073, 0xe0063, 0xe0074, 0xe007f].map((c) => String.fromCodePoint(c)).join('');
  assert.equal(labelName(scotland), scotland, 'the flag lost the tags it ends with');
});

test('a name the ceiling cut down to nothing visible is not a label', () => {
  const selector = String.fromCodePoint(0xfe0f);
  const name = selector.repeat(LABEL_NAME_LIMIT) + 'a';
  assert.ok(name.length > LABEL_NAME_LIMIT, 'the fixture is inside the ceiling, so nothing is cut');
  assert.equal(labelName(name), '', 'the cut left a name with nothing in it a reader can see');
});

// The three record helpers are as narrow as the writers beside them. A record whose own
// `__proto__` names a list arrives only from state nobody normalized, and a plain assignment
// under that key replaces the returned record's prototype rather than adding an entry.
test('a record nobody normalized cannot reshape what the helpers return', () => {
  const hostile = JSON.parse('{"__proto__": ["perf"], "s1": ["docs"]}');
  const set = setSessionLabels(hostile, 's2', ['rail']);
  assert.deepEqual(set, { s1: ['docs'], s2: ['rail'] }, 'the setter copied a key naming no session');
  assert.equal(Object.getPrototypeOf(set), Object.prototype, 'the setter returned a reshaped record');
  const moved = adoptLabelSession(hostile, 's1', 's9');
  assert.deepEqual(moved, { s9: ['docs'] }, 'adoption copied a key naming no session');
  assert.equal(Object.getPrototypeOf(moved), Object.prototype, 'adoption returned a reshaped record');
  // And a value that is not a list answers with nothing rather than one chip per letter.
  assert.deepEqual(
    labelsOf({ s1: 'docs' } as unknown as Record<string, string[]>, 's1'),
    [],
    'a name stored where a list belongs was drawn as one label per letter',
  );
});

test('a card with more labels than it can draw folds the rest into a count', () => {
  const three = railLabelChips(['composer', 'release 0.4', 'perf']);
  assert.deepEqual(three.chips, ['composer', 'release 0.4'], 'the card drew the wrong labels');
  assert.equal(three.chips.length, RAIL_LABELS_SHOWN, 'the fold drew a number of chips of its own');
  assert.equal(three.more, '+1', 'the labels the card left out are not counted anywhere on it');
  // And the count comes back beside the labels it stands for, so the chip drawn from it can
  // carry the whole of what it hides. One split answers both, or the number and the names
  // behind it could disagree.
  assert.deepEqual(three.rest, ['perf'], 'the count came back without the labels it stands for');
  const two = railLabelChips(['composer', 'perf']);
  assert.deepEqual(two.chips, ['composer', 'perf']);
  assert.equal(two.more, null, 'a card whose labels all fit still draws a fold chip');
  assert.deepEqual(two.rest, [], 'a card that folded nothing named something to hide');
  assert.deepEqual(railLabelChips([]), { chips: [], more: null, rest: [] });
  // And the count covers everything the row left out, however many that is.
  assert.deepEqual(
    railLabelChips(['a', 'b', 'c', 'd']).more,
    '+2',
    'the count stands for one label however many the row folded',
  );
});

// The record is the whole answer to which labels a workspace has, so the list the editor
// draws is counted off it. A count read a second way would say a label two sessions
// carry is carried by one, and the reader would tick a box that says the wrong thing about
// the workspace they are filing.
test('the list of labels says how many sessions carry each of them, most used first', () => {
  const counts = labelCounts(
    normalizeSessionLabels({
      s1: ['perf', 'composer'],
      s2: ['perf'],
      s3: ['docs', 'perf'],
      s4: ['composer'],
    }),
  );
  // Every row carries the spoken form of its own count. The editor's checkboxes and the
  // filter box's suggestions are handed one shape, so neither the extension nor the browser
  // words a count a second way.
  assert.deepEqual(
    counts,
    [
      { name: 'perf', count: 3, countName: 'carried by 3 sessions' },
      { name: 'composer', count: 2, countName: 'carried by 2 sessions' },
      { name: 'docs', count: 1, countName: 'carried by one session' },
    ],
    'the label the most sessions carry is counted wrong or drawn below a rarer one',
  );
  // Two labels the same number of sessions carry are ordered by name, so the list the
  // reader reads twice reads the same way both times.
  assert.deepEqual(
    labelCounts({ s1: ['beta', 'alpha'], s2: ['alpha', 'beta'] }),
    [
      { name: 'alpha', count: 2, countName: 'carried by 2 sessions' },
      { name: 'beta', count: 2, countName: 'carried by 2 sessions' },
    ],
    'two labels nothing separates by count come back in an order of their own',
  );
  // A record nobody normalized: a key naming no session, a key naming nothing at all, a
  // bare name where a list belongs, a name of only spaces, and one session naming a
  // label twice. The last is the one that reads wrong on screen: counted twice it would tell
  // the reader two sessions carry a label one does.
  const hostile = JSON.parse(
    '{"__proto__": ["perf"], "": ["ghost"], "s1": ["docs", "Docs"], "s2": "docs", "s3": ["   ", "docs"]}',
  );
  assert.deepEqual(
    labelCounts(hostile),
    [{ name: 'docs', count: 2, countName: 'carried by 2 sessions' }],
    'a label counted off a record nobody normalized stands for the wrong sessions',
  );
  // And two cases of one name are one label with one count, in the spelling that arrived
  // first, which is the spelling every card already draws.
  assert.deepEqual(
    labelCounts({ s1: ['Perf'], s2: ['perf'] }),
    [{ name: 'Perf', count: 2, countName: 'carried by 2 sessions' }],
    'one label the reader typed in two cases is offered as two rows',
  );
  assert.deepEqual(labelCounts({}), []);
});

// The editor draws one list, and the reader reads it as two things at once: what this
// session carries, and what the workspace has to offer it. Applied first is what makes
// the first of those readable without a second control.
test('the editor lists what the session carries before what the workspace has', () => {
  const labels = normalizeSessionLabels({
    s1: ['release 0.4', 'composer'],
    s2: ['perf'],
    s3: ['perf'],
    s4: ['perf', 'composer'],
  });
  const rows = labelEditorRows(labels, 's1');
  // The reader applied `release 0.4` first and one session carries it, while three
  // carry `perf`. The order the reader wrote is what leads, so the count cannot pull a label
  // out of it.
  assert.deepEqual(
    rows.map((row) => row.name),
    ['release 0.4', 'composer', 'perf'],
    'the session own labels lost their order, or the catalog was drawn in front of them',
  );
  assert.deepEqual(
    rows.map((row) => row.applied),
    [true, true, false],
    'a row does not say which of the two groups it came from',
  );
  // The count is said in words beside the box, because a figure read out after a name says
  // nothing about what it counts.
  assert.equal(rows[0].countName, 'carried by one session');
  assert.equal(rows[2].countName, 'carried by 3 sessions');
  assert.deepEqual(
    rows.map((row) => row.count),
    [1, 2, 3],
  );
  // A session with no labels of its own reads the catalog and nothing else.
  const fresh = labelEditorRows(labels, 's9');
  assert.deepEqual(
    fresh.map((row) => row.name),
    ['perf', 'composer', 'release 0.4'],
  );
  assert.deepEqual(
    fresh.map((row) => row.applied),
    [false, false, false],
    'a session nobody filed is drawn carrying a label',
  );
  // The rows are settled by the record and the session alone, so the list the reader is
  // looking at cannot reorder itself between one press and the next.
  assert.deepEqual(labelEditorRows(labels, 's1'), rows, 'one record drew two different lists');
  // Ticking a box is a write, and the label the reader just applied joins the end of what
  // this session carries rather than sorting itself into the counts.
  const ticked = labelEditorRows(setSessionLabels(labels, 's2', ['perf', 'composer']), 's2');
  assert.deepEqual(
    ticked.filter((row) => row.applied).map((row) => row.name),
    ['perf', 'composer'],
    'the label the reader ticked moved above the ones the session already carried',
  );
  assert.deepEqual(
    labelEditorRows(labels, 's2').map((row) => row.name),
    ['perf', 'composer', 'release 0.4'],
    'the write edited the rows the reader was already reading',
  );
});

// The two things a name can do that the reader cannot see from the box. Nothing else on
// screen says either, and both are wrong only after the name is stored, which is too late to
// tell them.
test('the reader is told what a comma or a name past the ceiling does to the label they type', () => {
  assert.deepEqual(labelTypedNotes('release 0.4'), [], 'an ordinary name is answered with a note');
  assert.deepEqual(labelTypedNotes('perf, docs'), ['comma']);
  const past = 'a'.repeat(LABEL_NAME_LIMIT + 1);
  assert.deepEqual(labelTypedNotes(past), ['limit'], 'a name the ceiling will cut is typed with nothing said');
  assert.deepEqual(
    labelTypedNotes('  ' + past + ', docs  '),
    ['comma', 'limit'],
    'the two notes came back in an order of their own, so the copy the browser holds cannot be compared with this',
  );
  // A name exactly at the ceiling loses nothing, so there is nothing to say about it.
  assert.deepEqual(labelTypedNotes('a'.repeat(LABEL_NAME_LIMIT)), []);
  // And the spaces around a name go before it is stored, so they cannot be what carries it
  // past the ceiling.
  assert.deepEqual(
    labelTypedNotes('  ' + 'a'.repeat(LABEL_NAME_LIMIT) + '  '),
    [],
    'the spaces the reader typed around a name were counted against the ceiling',
  );
  // Every note names words the editor can draw, and the ceiling is read from the rule rather
  // than written into the sentence twice.
  for (const note of labelTypedNotes(past + ',')) {
    assert.match(LABEL_NOTES[note], /\S/, 'a note the reader is shown has nothing in it to read');
  }
  assert.ok(
    LABEL_NOTES.limit.includes(String(LABEL_NAME_LIMIT)),
    'the note about the ceiling says a number the ceiling does not hold',
  );
});
