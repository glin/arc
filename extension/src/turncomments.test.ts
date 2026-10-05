// extension/src/turncomments.test.ts
//
// The tests for turncomments.ts. One that reads a second seam's names lives in turnview.test.ts
// instead, because neither file owns it. The builders a test is written against are here
// while only this file needs them, and in turnfixtures.ts once a second file does.
import { test } from 'vitest';
import assert from 'node:assert';
import {
  COMMENT_ACTIONS,
  COMMENT_CUT,
  COMMENT_LIMIT,
  COMMENT_LINE_LIMIT,
  COMMENT_TEXT_LIMIT,
  answerPart,
  asQuote,
  blockOfQuote,
  commentAnchorText,
  commentsFor,
  commentsOn,
  emitComments,
  emitTurnComments,
  laterPromptPart,
  normalizeComments,
  quoteStanding,
  looksLikeComments,
} from './turncomments.ts';
import { TURN_AT, comment } from './turnfixtures.ts';
import { quotesPromptHeading } from './view/comments.ts';

test('the text a note is anchored to is found by its part, or not claimed at all', () => {
  const card = {
    prompt: 'address the review findings',
    summary: 'the tokenizer now walks a table',
    earlierAnswers: [{ summary: 'first pass, still switching' }, { summary: 'second pass' }],
    laterPrompts: [{ text: 'also check the lexer' }, { text: 'leave the tests alone' }],
    saidMessages: [{ id: 'commentary:1757000000000:0', text: 'reading the two wire files first' }],
  };
  assert.equal(commentAnchorText(card, 'prompt'), 'address the review findings');
  assert.equal(commentAnchorText(card, 'summary'), 'the tokenizer now walks a table');
  assert.equal(commentAnchorText(card, 'answer:0'), 'first pass, still switching');
  assert.equal(commentAnchorText(card, 'answer:1'), 'second pass');
  // An answer the card does not hold: the tail window can be read back to fewer bytes and
  // lose the early answers of a turn it still draws. Nothing is there, so nothing is said.
  assert.equal(commentAnchorText(card, 'answer:2'), null);
  // What the reader sent while the turn was running, each its own part. The prompt that
  // opened the turn keeps the bare name, so every comment already saved still finds its text.
  assert.equal(commentAnchorText(card, 'prompt:0'), 'also check the lexer');
  assert.equal(commentAnchorText(card, 'prompt:1'), 'leave the tests alone');
  // One the card no longer holds, for the reason the missing answer above gives.
  assert.equal(commentAnchorText(card, 'prompt:2'), null);
  assert.equal(commentAnchorText({ ...card, summary: '' }, 'summary'), null);
  assert.equal(commentAnchorText({ ...card, prompt: '' }, 'prompt'), null);
  // The opening prompt and the first later one are different parts, not the same one twice.
  assert.notEqual(commentAnchorText(card, 'prompt'), commentAnchorText(card, 'prompt:0'));
  // A message the agent wrote while the turn ran is named by the message's own id, so an
  // Activity filter that removes rows cannot move it onto another part of the card.
  assert.equal(commentAnchorText(card, 'said:commentary:1757000000000:0'), 'reading the two wire files first');
  // A message the card no longer holds, for the reason the missing answer above gives.
  assert.equal(commentAnchorText(card, 'said:commentary:1757000000001:0'), null);
});

test('a stored offset chooses the repeated line where the comment began', () => {
  const lines = ['repeat these words', 'middle', 'repeat these words'];
  assert.equal(blockOfQuote(lines, 'repeat these words'), 0);
  assert.equal(blockOfQuote(lines, 'repeat these words', 31), 2);
  assert.equal(
    blockOfQuote(['catalogue'], 'log'),
    -1,
    'a substring inside another word was treated as the selected word',
  );
});

test('both visible prompt headings keep the prompt-section comment identity', () => {
  assert.equal(quotesPromptHeading('You asked'), true);
  assert.equal(quotesPromptHeading('Assigned task'), true);
  assert.equal(quotesPromptHeading('Assigned work'), false);
});

test('comment normalization keeps a valid selection offset', () => {
  assert.equal(normalizeComments([comment({ offset: 14 })])[0].offset, 14);
  assert.equal(normalizeComments([comment({ offset: 14.9 })])[0].offset, 14);
  assert.equal(normalizeComments([comment({ offset: -1 })])[0].offset, undefined);
  assert.equal(normalizeComments([comment({ offset: Number.NaN })])[0].offset, undefined);
});

test('the word on the bar teaches its key, and says in words what the chip draws', () => {
  // One character, because the chip draws it as a key cap and the panel binds it bare.
  assert.equal(COMMENT_ACTIONS.writeKey.length, 1, 'the shortcut is more than one key, which no chip can draw');
  assert.equal(
    COMMENT_ACTIONS.writeKey,
    COMMENT_ACTIONS.writeKey.toLowerCase(),
    'the key is written in upper case, which is Shift and the letter rather than the key the panel binds',
  );
  // The name replaces everything the button holds, so it has to carry the word as well as the
  // key, and the key has to be said rather than left as a letter on its own.
  assert.ok(
    COMMENT_ACTIONS.writeName.startsWith(COMMENT_ACTIONS.write),
    'the name does not open with what the press does, so a screen reader announces the key first',
  );
  assert.match(
    COMMENT_ACTIONS.writeName,
    new RegExp(String.raw`\b${COMMENT_ACTIONS.writeKey}\b`),
    'the name never says the key the chip draws, so the shortcut is taught to the eye alone',
  );
  assert.match(
    COMMENT_ACTIONS.writeName,
    /keyboard shortcut/i,
    'the name gives the key as a bare letter without saying it is a shortcut',
  );
});

test('a selection becomes a quote block ready to paste into a chat box', () => {
  const NL = String.fromCharCode(10);
  const CR = String.fromCharCode(13);
  assert.equal(asQuote('one line'), '> one line');
  assert.equal(asQuote(`first${NL}second`), `> first${NL}> second`);
  // A blank line inside a quote would end it, so it becomes a bare marker and the whole
  // selection stays one block.
  assert.equal(asQuote(`first${NL}${NL}second`), `> first${NL}>${NL}> second`);
  // Windows line endings arrive from a copy just as often as any other kind.
  assert.equal(asQuote(`first${CR}${NL}second`), `> first${NL}> second`);
  // A trailing pair of spaces is a hard line break in markdown, and the reader did not ask
  // for one by dragging a selection past the end of a word.
  assert.equal(asQuote(`first  ${NL}second`), `> first${NL}> second`);
  // A drag past the end of a paragraph picks up the blank lines around it.
  assert.equal(asQuote(`${NL}${NL}first${NL}${NL}`), '> first');
  assert.equal(asQuote(`   ${NL}  `), '');
  assert.equal(asQuote(''), '');
});

test('a note is dropped when it is not a note, and patched when it is only incomplete', () => {
  // What makes a note a note: text to send, and a session, a turn and a moment to hang
  // it on. A note missing any of those cannot be drawn or copied honestly, so it goes whole
  // rather than being drawn as a blank row nothing explains.
  for (const gone of ['id', 'sessionId', 'turnKey', 'note', 'at', 'turnAt'] as const) {
    const partial: Record<string, unknown> = { ...comment() };
    delete partial[gone];
    assert.deepEqual(
      normalizeComments([partial]),
      [],
      `a note with no ${gone} was kept, and nothing on screen or in the paste can say what it is about`,
    );
    // The same field of the wrong type, which is what a hand-edited state or an older
    // version writes, takes the same path rather than reaching the panel as a number.
    assert.deepEqual(
      normalizeComments([{ ...comment(), [gone]: { nested: true } }]),
      [],
      `a ${gone} of the wrong type was carried through rather than dropped`,
    );
  }
  // A note whose text is only whitespace is a note with nothing in it.
  assert.deepEqual(normalizeComments([comment({ note: '   \n  ' })]), []);
  // Anything that is not an object at all, inside a list that is otherwise fine.
  assert.deepEqual(normalizeComments(['nope', 42, null, [], comment()]).length, 1);
  // A list that is not a list is no notes, not a throw: the panel that throws reading its
  // own state draws nothing at all and says nothing about why.
  assert.deepEqual(normalizeComments(undefined), []);
  assert.deepEqual(normalizeComments({ id: 'n1' }), []);
  assert.deepEqual(normalizeComments('[]'), []);

  // What only describes a note falls back rather than dropping it. The quote is the case
  // that matters: a webview offers no keyboard text selection, so a note with none is the
  // shape a reader who does not use a mouse leaves.
  const patched = normalizeComments([comment({ quote: 42, headline: null, sessionTitle: 7 } as never)]);
  assert.equal(patched.length, 1, 'a note lost its text because a field beside it was wrong');
  assert.deepEqual([patched[0].quote, patched[0].headline, patched[0].sessionTitle], ['', '', '']);
  // The part is the same: a value the grammar does not read takes the summary, which costs
  // at most a standing check that says nothing rather than one that says something false.
  assert.equal(normalizeComments([comment({ part: 'answer:2' })])[0].part, 'answer:2');
  assert.equal(normalizeComments([comment({ part: 'prompt' })])[0].part, 'prompt');
  assert.equal(normalizeComments([comment({ part: 'answer:x' } as never)])[0].part, 'summary');
  assert.equal(normalizeComments([comment({ part: 'answer:12345' } as never)])[0].part, 'summary');
  assert.equal(normalizeComments([comment({ part: 99 } as never)])[0].part, 'summary');
  assert.equal(
    normalizeComments([comment({ part: 'said:commentary:1757000000000:0' })])[0].part,
    'said:commentary:1757000000000:0',
  );
  assert.equal(normalizeComments([comment({ part: 'said:' } as never)])[0].part, 'summary');
  assert.equal(normalizeComments([comment({ part: 'said:has a space' } as never)])[0].part, 'summary');
  assert.equal(answerPart(3), 'answer:3');
  assert.equal(answerPart(-1), 'answer:0');
  assert.equal(answerPart(2.7), 'answer:2');
  // The same shape for a prompt the reader sent after the turn had started. Held here because
  // the panel spells this string itself, from a count of the blocks on the card, and the guard
  // below in panel.webview.test.ts holds that spelling against this one.
  assert.equal(laterPromptPart(0), 'prompt:0');
  assert.equal(laterPromptPart(3), 'prompt:3');
  assert.equal(laterPromptPart(-1), 'prompt:0');
  assert.equal(laterPromptPart(2.7), 'prompt:2');
  // Never the bare name, whatever it is given. That name belongs to the prompt the turn opened
  // with, and every comment saved before mid-turn prompts existed carries it.
  assert.notEqual(laterPromptPart(0), 'prompt');
});

test('a stored note is cut to its ceiling, and the cut says so', () => {
  // Every string on a note has a ceiling, the way every list in the stored state does. The
  // quote takes the measured one: over every transcript on this machine the longest
  // paragraph a turn closed with is 4,828 characters, so a full paragraph is never cut and
  // only a whole-summary selection is.
  const paragraph = 'x'.repeat(4_828);
  assert.equal(
    normalizeComments([comment({ quote: paragraph })])[0].quote,
    paragraph,
    'the longest paragraph measured in a real transcript was cut, which is what the ceiling exists not to do',
  );
  const huge = 'y'.repeat(COMMENT_TEXT_LIMIT + 500);
  const cut = normalizeComments([comment({ quote: huge, note: huge })])[0];
  assert.equal(cut.quote.length, COMMENT_TEXT_LIMIT);
  assert.equal(cut.note.length, COMMENT_TEXT_LIMIT);
  // Cut, never silently: the mark is what tells the reader, and the agent reading the paste,
  // that the passage does not end there.
  assert.ok(cut.quote.endsWith(COMMENT_CUT), 'a cut quote reads as the whole passage');
  assert.ok(cut.note.endsWith(COMMENT_CUT));
  // The one-line fields take the smaller ceiling, above the longest headline measured.
  const line = normalizeComments([comment({ headline: 'h'.repeat(5_000), sessionTitle: 't'.repeat(5_000) })])[0];
  assert.equal(line.headline.length, COMMENT_LINE_LIMIT);
  assert.equal(line.sessionTitle.length, COMMENT_LINE_LIMIT);
  assert.equal(
    normalizeComments([comment({ headline: 'h'.repeat(1_336) })])[0].headline.length,
    1_336,
    'the longest headline measured in a real transcript was cut',
  );
});

test('the notes are capped by count, and the oldest are the ones that go', () => {
  // The same rule and the same end as the read set: the list is written oldest first, so a
  // list restored over its ceiling drops from the front. A reader who loses the note they
  // wrote a minute ago and keeps one from last month has lost the wrong one.
  const many = Array.from({ length: COMMENT_LIMIT + 5 }, (_, i) => comment({ id: 'n' + i, at: TURN_AT + i }));
  const kept = normalizeComments(many);
  assert.equal(kept.length, COMMENT_LIMIT);
  assert.equal(kept[0].id, 'n5', 'the cut took from the wrong end and the newest notes went');
  assert.equal(kept[kept.length - 1].id, 'n' + (COMMENT_LIMIT + 4));
  // Under the ceiling nothing moves.
  assert.deepEqual(
    normalizeComments(many.slice(0, 3)).map((c) => c.id),
    ['n0', 'n1', 'n2'],
  );
});

test('notes are gathered per session, never across them', () => {
  // The reader has several agents open at once and each set of notes goes back to the agent
  // that ran the turns it is about. A set gathered across sessions pastes one agent's
  // review into another's box.
  const notes = [
    comment({ id: 'a1', sessionId: 'a' }),
    comment({ id: 'b1', sessionId: 'b' }),
    comment({ id: 'a2', sessionId: 'a' }),
  ];
  assert.deepEqual(
    commentsFor(notes, 'a').map((c) => c.id),
    ['a1', 'a2'],
  );
  assert.deepEqual(
    commentsFor(notes, 'b').map((c) => c.id),
    ['b1'],
  );
  assert.deepEqual(commentsFor(notes, 'zzz'), []);
  assert.ok(!emitComments(notes, 'a').includes('b1'));
});

test('the copy takes one turn, and never the session around it', () => {
  // The copy is per turn now. A reader sends one turn's comments back to the agent that ran
  // it, so a paste holding every turn they have written on is one they have to edit down.
  // Each note says which turn it is on: sharing one wording, the assertions below would pass
  // on the wrong turn's comment and never see it.
  const notes = [
    comment({ id: 'on', turnKey: 'sess:1', note: 'left on turn one', headline: 'headline of turn one' }),
    comment({ id: 'also', turnKey: 'sess:1', note: 'and again on turn one', headline: 'headline of turn one' }),
    comment({ id: 'off', turnKey: 'sess:2', note: 'left on turn two', headline: 'headline of turn two' }),
    comment({
      id: 'other',
      sessionId: 'b',
      turnKey: 'sess:1',
      note: 'left in another session',
      headline: 'headline elsewhere',
    }),
  ];
  // Both halves name a turn. A turn key carries its own session, and the case that
  // matters is two sessions whose keys collide: reading either half alone draws right
  // almost always and wrong there.
  assert.deepEqual(
    commentsOn(notes, 'sess:1', 'sess').map((c) => c.id),
    ['on', 'also'],
  );
  assert.deepEqual(
    commentsOn(notes, 'sess:1', 'b').map((c) => c.id),
    ['other'],
  );
  assert.deepEqual(commentsOn(notes, 'sess:9', 'sess'), []);

  const block = emitTurnComments(notes, 'sess:1', 'sess');
  assert.ok(block.includes('left on turn one'), 'the copy lost a comment on the turn it names');
  assert.ok(block.includes('and again on turn one'), 'the copy took one of the two comments on the turn');
  assert.ok(
    block.includes('headline of turn one'),
    'the copy lost the headline the turn captured, which is all there is to head it with',
  );
  assert.ok(
    !block.includes('left on turn two'),
    'the copy reached into another turn, so a paste carries what the reader did not mean to send',
  );
  assert.ok(
    !block.includes('left in another session'),
    'the copy reached into another session, which sends one agent a review of another',
  );
  // No session heading. The turn is named, which is what the agent needs to know which of
  // its own answers this is about, and naming the session the reader is pasting into
  // tells that agent what it already knows.
  assert.doesNotMatch(block, /^Notes on/m, 'the per-turn copy still heads itself with the session');
  // A turn nobody wrote on copies nothing, rather than a heading with no comments under it.
  assert.equal(emitTurnComments(notes, 'sess:3', 'sess'), '');
  assert.equal(emitTurnComments([], 'sess:1', 'sess'), '');
});

test('a quote is only said to stand where it really does', () => {
  const summary = 'The parser now walks a table\ninstead of the switch it had.';
  // Whitespace is not the same on both sides of the trip: the summary is drawn through a
  // markdown renderer and the quote is walked back out of the rendered fragment, so a line
  // break on one side is a space on the other.
  assert.equal(quoteStanding('walks a table instead of the switch', summary), 'standing');
  assert.equal(quoteStanding('walks   a\n\n table', summary), 'standing');
  // The summary genuinely changed under the quote: the words are not in it any more.
  assert.equal(quoteStanding('walks a tree instead of the switch', summary), 'moved');
  assert.equal(quoteStanding('the switch it kept', summary), 'moved');
  // Nothing to look in, and nothing to look for. Both say nothing rather than guess, and
  // the note is drawn and copied the same either way.
  assert.equal(quoteStanding('walks a table', null), 'unknown');
  assert.equal(quoteStanding('', summary), 'unknown');
  assert.equal(quoteStanding('   \n ', summary), 'unknown');
  assert.equal(quoteStanding('', null), 'unknown');
  // A quote cut at the ceiling carries the mark that says so, and that mark is in no text it
  // came from, so it is taken off before the comparison rather than making every long quote
  // read as moved.
  const long = normalizeComments([comment({ quote: summary + 'z'.repeat(COMMENT_TEXT_LIMIT) })])[0].quote;
  assert.ok(long.endsWith(COMMENT_CUT));
  assert.equal(quoteStanding(long, summary + 'z'.repeat(COMMENT_TEXT_LIMIT)), 'standing');
});

test("a session's notes copy as something a person could have written", () => {
  const notes = [
    comment({ id: 'n1', at: TURN_AT + 1_000 }),
    comment({
      id: 'n2',
      turnKey: 'sess:' + (TURN_AT + 3_600_000),
      turnAt: TURN_AT + 3_600_000,
      headline: 'Added a regression test.',
      quote: '',
      note: 'This passes with the bug still in.',
      at: TURN_AT + 4_000_000,
    }),
  ];
  const now = new Date(2026, 7, 23, 20, 0).getTime();
  assert.equal(
    emitComments(notes, 'sess', now),
    [
      '**Added a regression test.** (3:32 PM)',
      'This passes with the bug still in.',
      '**Rewrote the tokenizer to be table driven.** (2:32 PM)',
      '> the tokenizer now walks a table',
      'Measure this on the hot path first.',
    ].join('\n\n'),
  );
  // Newest turn first, which is the order the list itself draws them in, so the paste and
  // the screen it was made from read the same way down.
  assert.ok(
    emitComments(notes, 'sess', now).indexOf('Added a regression test.') <
      emitComments(notes, 'sess', now).indexOf('Rewrote the tokenizer'),
  );
  // A note with no quote is the note alone. An empty blockquote in front of it is a
  // quotation of nothing, which whoever reads the paste has to work out is not a mistake.
  assert.ok(!emitComments([notes[1]], 'sess', now).includes('>'));
  assert.ok(!emitComments([comment({ quote: '  \n  ' })], 'sess', now).includes('>'));
  // Nothing the reader neither wrote nor saw on screen reaches the paste: no note id, no
  // turn key, no session id.
  const block = emitComments(notes, 'sess', now);
  for (const internal of ['n1', 'n2', 'sess:', 'answer:']) {
    assert.ok(!block.includes(internal), `the paste carries ${internal}, which names nothing to whoever reads it`);
  }
  // No notes at all is no block, rather than a heading over nothing.
  assert.equal(emitComments([], 'sess', now), '');
  assert.equal(emitComments(notes, 'nobody', now), '');
});

test('several notes on one turn are headed once, in the order they were written', () => {
  // A reader reads a turn once and leaves three notes down it. Three headings for one turn
  // reads as three turns, and the notes have to keep the order they were thought in.
  const notes = [
    comment({ id: 'third', note: 'And the error path is untested.', at: TURN_AT + 3_000 }),
    comment({ id: 'first', note: 'Measure this on the hot path first.', quote: '', at: TURN_AT + 1_000 }),
    comment({
      id: 'second',
      note: 'The table is not the one the docs describe.',
      quote: 'walks a table',
      at: TURN_AT + 2_000,
    }),
  ];
  const block = emitComments(notes, 'sess', new Date(2026, 7, 23, 20, 0).getTime());
  assert.equal(
    block.split('**Rewrote the tokenizer to be table driven.**').length - 1,
    1,
    'one turn was headed more than once, so the paste reads as several turns',
  );
  assert.equal(
    block,
    [
      '**Rewrote the tokenizer to be table driven.** (2:32 PM)',
      'Measure this on the hot path first.',
      '> walks a table',
      'The table is not the one the docs describe.',
      '> the tokenizer now walks a table',
      'And the error path is untested.',
    ].join('\n\n'),
  );
});

test('the comments block a submission sends alone is told from a prompt', () => {
  // The prompt walk asks. A submission with an empty box sends these notes and nothing else,
  // and the transcript records the whole document as the prompt.
  const held = comment();
  const notes = emitComments([held], held.sessionId, TURN_AT);
  assert.equal(looksLikeComments(notes), true);
  const untitled = emitComments([{ ...held, sessionTitle: '' }], held.sessionId, TURN_AT);
  assert.equal(
    looksLikeComments(untitled),
    true,
    'a session with no title yet writes a block the walk offers back as a prompt',
  );
});

test('a prompt of the reader own is not told for a comments block', () => {
  // Two things have to agree, because a prompt read as notes leaves the walk in silence.
  assert.equal(looksLikeComments('**Blocker** (3:32 PM)'), false, 'no blank line under it');
  assert.equal(
    looksLikeComments(`say which is faster

**Blocker** (3:32 PM)`),
    false,
    'no heading under the prompt first line',
  );
  assert.equal(
    looksLikeComments(`**Blocker**: it drops CRLF

Fix it.`),
    false,
    'a bold first line with no parenthesized tail',
  );
  // The bound. A turn with no headline heads itself only with the time, which the rule does
  // not match, and the walk offers the document back. Wrong in the direction that costs the
  // reader nothing.
  const held = comment({ headline: '' });
  const notes = emitComments([held], held.sessionId, TURN_AT);
  assert.equal(looksLikeComments(notes), false);
});
