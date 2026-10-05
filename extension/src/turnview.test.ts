// extension/src/turnview.test.ts
//
// The tests for turnview.ts, and the ones no single file owns: a test that reads more than
// one of the turn modules belongs to neither, so it stays here rather than being split.
// The builders a second test file needs are in turnfixtures.ts.
import { test, vi } from 'vitest';
import assert from 'node:assert';
import { DRAFT_SESSION_PREFIX, LABELLED_SESSION_LIMIT } from './turnlabels.ts';
import {
  RAIL_MENU_SECTIONS,
  pickShowing,
  formatClock,
  toCard,
  newestPerSession,
  formatWhen,
  emptyTimeline,
  newestTurnLoading,
  CARD_ACTIONS,
  normalizePanelState,
  normalizeReaderParents,
  remapReaderParents,
  abandonReaderParents,
  normalizeDrafts,
  normalizeSentPrompts,
  restoredSentPrompts,
  normalizeDraftCommentIds,
  normalizeQueuedSubmissions,
  queuedSubmissionBookFits,
  DRAFT_TEXT_LIMIT,
  PROMPT_HISTORY_ENTRY_CHARS,
  READ_LIMIT,
  SESSION_LIMIT,
  editorColumn,
  besideColumn,
  searchTurns,
  newBySession,
  newCounts,
  newestTurnStarts,
  glanceBudget,
  GLANCE_BUDGET_BYTES,
  listingSignature,
  spendSourceSignature,
  refreshWanted,
  turnKey,
  newIndicator,
  railSessions,
  sessionStatusOf,
  turnBudget,
  RAIL_WIDTH_DEFAULT,
  RAIL_BUCKETS,
  RAIL_FOLD_LIMIT,
  cardPrint,
  earlierAnswersOf,
  searchableSummary,
  COMMENT_ACTIONS,
  COMMENT_LIMIT,
  webviewPanelState,
  withSweptDraftLabels,
} from './turnview.ts';
import type { TurnStatus, NewCount } from './turnview.ts';
import { RAIL_FOLDS } from './view/rail.ts';
import { projectSpendSourceOfferDue } from './projectspend.ts';
import { NOW, comment, entry, turn } from './turnfixtures.ts';
import {
  BACKGROUND_COMMAND_CAP_MS,
  liveBackgroundCommands,
  liveOpenChildren,
  openChildCounts,
  openChildrenKey,
  railCardName,
} from './turnrail.ts';
import { TURN_QUIET_MS } from './turncard.ts';
import type { TurnOutcome } from './transcript.ts';

test('the answers a turn closed before its last one reach the card, worded and timed', () => {
  const t1 = new Date(2026, 7, 23, 14, 40).getTime();
  const t2 = new Date(2026, 7, 23, 14, 42).getTime();
  const t3 = new Date(2026, 7, 23, 14, 44).getTime();
  const answered = turn({
    summary: 'Third answer.',
    answers: [
      { stepsBefore: 0, text: 'First answer.', at: t1 },
      { stepsBefore: 0, text: 'Second answer.', at: t2 },
      { stepsBefore: 0, text: 'Third answer.', at: t3 },
    ],
  });
  const earlier = earlierAnswersOf(answered, NOW);
  assert.deepEqual(
    earlier.map((a) => a.summary),
    ['Second answer.', 'First answer.'],
    'the last answer is the summary and must not be drawn twice',
  );
  // Newest first, so the card reads in the same direction as the list of cards around it.
  assert.deepEqual(
    earlier.map((a) => a.at),
    [t2, t1],
  );
  assert.equal(earlier[0].absolute, formatWhen(t2, NOW), "the hover clock time is not the answer's own");
  // A turn whose newest text no response has closed yet: every closed answer is earlier.
  const running = turn({
    summary: 'Live text, still typing.',
    answers: [{ stepsBefore: 0, text: 'First answer.', at: t1 }],
  });
  assert.deepEqual(
    earlierAnswersOf(running, NOW).map((a) => a.summary),
    ['First answer.'],
  );
  // The ordinary turn: one answer, and it is the summary, so nothing is earlier.
  assert.deepEqual(
    earlierAnswersOf(turn({ summary: 'Done.', answers: [{ stepsBefore: 0, text: 'Done.', at: t1 }] }), NOW),
    [],
  );
  assert.deepEqual(earlierAnswersOf(turn({ summary: 'Done.', answers: [] }), NOW), []);
  // The card carries them, the headline stays the last answer's first line, and the
  // waiting signal keeps reading the last answer alone: an ask from an earlier answer
  // the turn went on past is superseded state, and a union would mark it open forever.
  const askEarly = turn({
    summary: 'All done, nothing left for you.',
    answers: [
      { stepsBefore: 0, text: 'Holding.\n\n- 🙋 **Your actions** - install the build and look', at: t1 },
      { stepsBefore: 0, text: 'All done, nothing left for you.', at: t2 },
    ],
  });
  const card = toCard(askEarly, false, NOW);
  assert.deepEqual(
    card.earlierAnswers.map((a) => a.summary),
    ['Holding.\n\n- 🙋 **Your actions** - install the build and look'],
  );
  assert.equal(card.headline, 'All done, nothing left for you.');
  assert.deepEqual(
    card.marks.map((m) => m.id),
    [],
    'an ask from an earlier answer marks the card, so every resolved ask reads as open',
  );
});

test('the earlier answers are handed over newest first, by turning the file round rather than sorting it', () => {
  // The card reads in one direction, the same one the list of cards around it reads in: the
  // response first, then back through the answers that came before it. The whole of that
  // decision is here, so the panel draws the array as it is handed and picks nothing.
  //
  // Three answers whose clock times are deliberately not their order in the file, because
  // two answers cannot tell the three candidate rules apart: with two, sorting by the clock
  // gives the same answer as one of the other two whichever way the fixture is built. With
  // three, leaving the array alone, reversing it, and sorting it by the clock each give a
  // different list, so this pins reversal and not merely "something changed".
  const t1 = new Date(2026, 7, 23, 14, 40).getTime();
  const t2 = new Date(2026, 7, 23, 14, 42).getTime();
  const t3 = new Date(2026, 7, 23, 14, 44).getTime();
  // A turn whose newest text no response has closed yet, so all three answers are earlier
  // than the live text and every one of them is drawn.
  const jumbled = turn({
    summary: 'Live text, still typing.',
    answers: [
      { stepsBefore: 0, text: 'Written first.', at: t2 },
      { stepsBefore: 0, text: 'Written second.', at: t3 },
      { stepsBefore: 0, text: 'Written third.', at: t1 },
    ],
  });
  const said = earlierAnswersOf(jumbled, NOW).map((a) => a.summary);
  assert.deepEqual(
    said,
    ['Written third.', 'Written second.', 'Written first.'],
    'the earlier answers are not handed over newest first',
  );
  // Written out, so the two rules this is not can never be mistaken for a pass.
  assert.notDeepEqual(
    said,
    ['Written first.', 'Written second.', 'Written third.'],
    'the file order is handed over untouched, so a card still reads oldest to newest',
  );
  assert.notDeepEqual(
    said,
    ['Written second.', 'Written first.', 'Written third.'],
    'the answers are sorted by their clock rather than turned round, which re-decides what the file already recorded',
  );
  // The card carries what this hands over, in the same order.
  assert.deepEqual(
    toCard(jumbled, false, NOW).earlierAnswers.map((a) => a.summary),
    said,
    'the card reorders the answers on its way through, so the panel draws an order nothing here decided',
  );
  // The order the turn wrote them in is untouched, because the search corpus is joined out
  // of the answers themselves and no reader ever sees that order.
  assert.equal(
    searchableSummary(jumbled),
    'Written first.\n\nWritten second.\n\nWritten third.\n\nLive text, still typing.',
    'the search corpus was turned round with the card, so a snippet spanning two answers reads backwards',
  );
});

test('the count of what is new goes over the turns parsed, not the few the list kept', () => {
  // The reported failure: a session the reader is not looking at wore the wrong
  // count, and the count came back the moment they clicked into it. Two sessions,
  // one of them shown, and a list budget small enough that the other cannot fit.
  const t = (sessionId: string, startedAt: number) => ({ sessionId, startedAt });
  const parsed = [
    ...[...Array(12).keys()].map((i) => t('other', 1200 - i * 10)),
    ...[...Array(3).keys()].map((i) => t('shown', 300 - i * 10)),
  ].sort((a, b) => b.startedAt - a.startedAt);
  const asCard = (x: { sessionId: string; startedAt: number }) => ({
    key: turnKey(x),
    sessionId: x.sessionId,
    startedAt: x.startedAt,
    kind: 'turn',
  });
  const none = new Map<string, number>();

  // What the list keeps: the shown session whole, and the other one down to the
  // floor of a single card. That floor is the bug's whole mechanism.
  const listed = turnBudget(parsed, 3, 'shown');
  assert.equal(
    listed.filter((x) => x.sessionId === 'other').length,
    1,
    'the budget no longer cuts the unshown session to its floor, so this no longer reproduces',
  );
  assert.equal(
    newBySession(listed.map(asCard), [], none).get('other'),
    1,
    'the listed set is what produced the reported count, so it must still produce it here',
  );

  // Over what was parsed, the answer is the truth, and the reader is not told that twelve
  // unread turns are one.
  assert.equal(newBySession(parsed.map(asCard), [], none).get('other'), 12);

  // The signature of the bug was that the count depended on which session the reader
  // was looking at: clicking into it made it the shown one and the budget then filled it
  // first. Over the listed cards that movement is still there, and over the parsed turns
  // there is nothing left for a click to move.
  const clicked = turnBudget(parsed, 3, 'other');
  assert.notEqual(
    newBySession(clicked.map(asCard), [], none).get('other'),
    newBySession(listed.map(asCard), [], none).get('other'),
    'the budget no longer favours the shown session, so this no longer reproduces',
  );
  assert.equal(
    newBySession(parsed.map(asCard), [], none).get('other'),
    12,
    'the parsed answer moved with the session the reader is looking at',
  );

  // And the one thing the widening must not take away: a session nothing parsed has
  // no entry at all, which is how the rail tells "nothing new" from "cannot say".
  assert.equal(newBySession(parsed.map(asCard), [], none).has('never parsed'), false);
});

test('a turn the reader marked read is the same turn the count stops counting', () => {
  // The count is now built from turnKey and the read set is written from the card's own
  // key, so the two are the same string or the reader marks one turn read and the rail
  // goes on counting another. Only a real card can hold that: the key has to come off
  // toCard, not out of the formula the count uses.
  const card = toCard(turn({}), false, NOW);
  const ref = {
    key: turnKey({ sessionId: card.sessionId, startedAt: card.startedAt }),
    sessionId: card.sessionId,
    startedAt: card.startedAt,
    kind: 'turn',
  };
  assert.equal(ref.key, card.key, 'the card and the count spell one turn two ways');
  const none = new Map<string, number>();
  assert.equal(newBySession([ref], [], none).get(card.sessionId), 1);
  assert.equal(
    newBySession([ref], [card.key], none).get(card.sessionId),
    0,
    'marking the card read left the count where it was',
  );
});

// The badge wording, one rule for the rail card and the main session heading: every
// answer written out, because the two views draw it independently and this is where they
// are held together. Null is both silences; which one it was is worded in the accessible
// name, from CARD_ACTIONS.sessionNothingNew, only where the count is known.
test('the unread indicator is worded once, for the rail and the header alike', () => {
  const exact = (count: number) => ({ count, atLeast: false });
  assert.equal(newIndicator(undefined), null);
  assert.equal(newIndicator(exact(0)), null);
  assert.equal(newIndicator(exact(1)), '1 new');
  assert.equal(newIndicator(exact(3)), '3 new');
  assert.equal(CARD_ACTIONS.sessionNothingNew, 'nothing new');
  // A floor says so in words. `12+` is read out as "twelve plus" only by luck, and this
  // wording is the whole of what a reader without a pointer is told about the badge.
  assert.equal(newIndicator({ count: 12, atLeast: true }), 'at least 12 new');
  assert.equal(newIndicator({ count: 1, atLeast: true }), 'at least 1 new');
  const floor = newIndicator({ count: 12, atLeast: true });
  if (floor === null) {
    assert.fail('the unread floor is missing');
  }
  assert.doesNotMatch(floor, /[+~>]/);
  // A floor of zero is a wording that must not exist: nothing new is nothing new, however
  // little of the session was looked at.
  assert.equal(newIndicator({ count: 0, atLeast: true }), null);
});

test('the rail names every session on it, and stays honest about what it cannot count', () => {
  const s = (id: string) => ({
    id,
    label: `Session ${id}`,
    agent: 'Claude',
    when: '2:32 PM',
    at: 4200,
    relative: '3 hours ago',
  });
  const counts = new Map([
    ['a', { count: 3, atLeast: false }],
    ['b', { count: 0, atLeast: false }],
  ]);
  // The two parsed sessions, and when each last started a turn. `c` was listed and
  // never parsed, so it has no entry here either.
  const parsed = new Map([
    ['a', 4000],
    ['b', 3000],
  ]);
  const rail = railSessions(
    [s('a'), s('b'), s('c')],
    counts,
    parsed,
    new Map(),
    new Set(),
    null,
    new Set(),
    new Map(),
    {},
    {},
  );
  assert.equal(rail.length, 3);
  // The count is worded in the card's name and drawn nowhere on it: the panel says it in
  // words on the session's own heading instead. The card and its name carry the
  // relative wording; the clock time moves to the hover, like a turn card's own time.
  assert.equal(rail[0].indicator, '3 new');
  assert.equal(railCardName(rail[0]), 'Session a, Claude, 3 hours ago, 3 new');
  assert.equal(rail[0].relative, '3 hours ago');
  assert.equal(rail[0].absolute, '2:32 PM');
  assert.equal(rail[0].at, 4200);
  // Parsed with nothing new: quiet card, and the name says the answer is known.
  assert.equal(rail[1].indicator, null);
  assert.equal(railCardName(rail[1]), 'Session b, Claude, 3 hours ago, nothing new');
  // Never parsed: quiet card, and no claim at all, since the count is not knowable.
  assert.equal(rail[2].indicator, null);
  assert.equal(railCardName(rail[2]), 'Session c, Claude, 3 hours ago');
  // The order is the list's own; the rail never reorders by count.
  assert.deepEqual(
    rail.map((r) => r.id),
    ['a', 'b', 'c'],
  );
  // The session being shown alone says so on its card, where the note above the
  // list used to, and only that card says it.
  const shown = railSessions([s('a'), s('b')], counts, parsed, new Map(), new Set(), 'b', new Set(), new Map(), {}, {});
  assert.equal(shown[0].current, false);
  assert.doesNotMatch(railCardName(shown[0]), /showing now/);
  assert.equal(shown[1].current, true);
  assert.equal(railCardName(shown[1]), 'Session b, Claude, 3 hours ago, showing now, nothing new');
  // The status is the newest turn's, said as a word through the same table every head
  // row reads; the drawn card wears it as a colour, which reads out as nothing. A
  // session with no knowable status wears and says none.
  const busy = railSessions(
    [s('a'), s('b')],
    counts,
    parsed,
    new Map<string, TurnStatus>([['a', 'running']]),
    new Set(),
    null,
    new Set(),
    new Map(),
    {},
    {},
  );
  assert.equal(busy[0].status, 'running');
  assert.equal(railCardName(busy[0]), 'Session a, Claude, running, 3 hours ago, 3 new');
  assert.equal(busy[1].status, null);
  assert.equal(railCardName(busy[1]), 'Session b, Claude, 3 hours ago, nothing new');
});

test("a session wears its newest turn's status, and only a parsed one wears any", () => {
  const t = (sessionId: string, startedAt: number, status: TurnStatus) => ({
    sessionId,
    kind: 'turn',
    startedAt,
    status,
  });
  const statuses = sessionStatusOf([
    // The newest by start time answers, whatever order the cards arrive in.
    t('a', 100, 'done'),
    t('a', 300, 'running'),
    t('a', 200, 'failed'),
    t('b', 50, 'failed'),
    // A compaction has no status to wear, and must not stand in for the session's.
    { sessionId: 'c', kind: 'compaction', startedAt: 900 },
  ]);
  assert.equal(statuses.get('a'), 'running');
  assert.equal(statuses.get('b'), 'failed');
  // No entry rather than a guess: the rail words nothing it cannot know.
  assert.equal(statuses.has('c'), false);
  assert.equal(statuses.size, 2);
});

test('a session being worked in reads as running, whatever its cards say', () => {
  // The cards come off the transcript, so they are seconds behind the press at best. A
  // compaction never reaches them at all: it writes no turn, so the rail went on saying the
  // session had finished for the whole of one, and the only session a reader could
  // tell was busy was the one they were already looking at.
  const cards = [
    { sessionId: 'a', kind: 'turn', startedAt: 100, status: 'done' as TurnStatus },
    { sessionId: 'b', kind: 'turn', startedAt: 100, status: 'done' as TurnStatus },
  ];
  assert.equal(sessionStatusOf(cards).get('a'), 'done', 'the cards alone cannot say');
  const working = sessionStatusOf(cards, new Set(['a']));
  assert.equal(working.get('a'), 'running');
  assert.equal(working.get('b'), 'done', 'a quiet session is untouched');
  // A session nothing has been parsed for still wears the answer, because a busy child
  // is evidence in its own right rather than a guess off cards that do not exist.
  assert.equal(sessionStatusOf([], new Set(['c'])).get('c'), 'running');
});

test('the rail sends every row, including zero or one live session, with archives last', () => {
  const s = (id: string) => ({ id, label: id, agent: 'Codex', when: '9:05 AM', at: 1000, relative: '2 days ago' });
  const three = [s('a'), s('b'), s('c')];
  const none = new Map<string, NewCount>();
  const noTurns = new Map<string, number>();
  // An archived session is flagged and sent last, rather than dropped: the Archived
  // bucket at the foot of the rail needs a card to hold, and that card is the way back.
  const one = railSessions(three, none, noTurns, new Map(), new Set(['b']), null, new Set(), new Map(), {}, {});
  assert.deepEqual(
    one.map((r) => r.id),
    ['a', 'c', 'b'],
  );
  assert.deepEqual(
    one.map((r) => r.archived),
    [false, false, true],
  );
  // The session on screen is not exempt. This is the whole of the archive bug: while
  // it was, archiving what you were reading left its card sitting on the rail until you
  // opened something else. `hideSessions` keeps its own exemption, so the turns stay.
  const shown = railSessions(three, none, noTurns, new Map(), new Set(['b']), 'b', new Set(), new Map(), {}, {});
  assert.deepEqual(
    shown.map((r) => r.id),
    ['a', 'c', 'b'],
  );
  assert.equal(shown[2].archived, true);
  assert.equal(shown[2].current, true, 'the card still says it is the one on screen');
  // The word is in the name, because the dimmer card says it to the eye alone.
  assert.equal(railCardName(shown[2]), 'b, archived, Codex, 2 days ago, showing now');
  // Row count does not decide whether the browser owns the rail. One live row remains a
  // valid payload, and archived rows remain available behind their own bucket.
  assert.deepEqual(
    railSessions([s('a')], none, noTurns, new Map(), new Set(), null, new Set(), new Map(), {}, {}).map((r) => r.id),
    ['a'],
  );
  assert.deepEqual(
    railSessions(three, none, noTurns, new Map(), new Set(['a', 'b']), null, new Set(), new Map(), {}, {}).map(
      (r) => r.id,
    ),
    ['c', 'a', 'b'],
  );
  assert.deepEqual(railSessions([], none, noTurns, new Map(), new Set(), null, new Set(), new Map(), {}, {}), []);
});

// Who a session belongs to is read off the transcript and decided in transcript.ts.
// What the rail does with the answer is decided here: the phrase joins the accessible name
// of every marked card, and takes the drawn slot the agent's name has on the one marked
// card that sits under no heading saying so.
test('a session an agent ran says so, in the name always and on screen only where no heading does', () => {
  const s = (id: string, agentRun = false) => ({
    id,
    label: `Session ${id}`,
    agent: 'Claude',
    when: '2:32 PM',
    at: 4200,
    relative: '3 hours ago',
    agentRun,
  });
  const none = new Map<string, NewCount>();
  const noTurns = new Map<string, number>();
  const rail = railSessions(
    [s('mine'), s('run', true)],
    none,
    noTurns,
    new Map(),
    new Set(),
    null,
    new Set(),
    new Map(),
    {},
    {},
  );
  assert.equal(rail[0].agentRun, false);
  assert.equal(rail[1].agentRun, true);
  // The name says both: what ran it, and which agent it ran on. Nothing is lost to a
  // reader who cannot see the card.
  assert.equal(railCardName(rail[1]), 'Session run, run by an agent, Claude, 3 hours ago');
  // Inside its own bucket the heading has said it, so the card keeps the agent's name.
  assert.equal(rail[1].agentWord, 'Claude');
  assert.equal(rail[0].agentWord, 'Claude');
  // Pinned, it sits under a heading that says nothing about who ran it, so the phrase takes the
  // slot. Both together break the meta line at the rail's own width.
  const pinned = railSessions(
    [s('mine'), s('run', true)],
    none,
    noTurns,
    new Map(),
    new Set(),
    null,
    new Set(['run']),
    new Map(),
    {},
    {},
  );
  assert.equal(pinned[0].id, 'run');
  assert.equal(pinned[0].agentWord, 'run by an agent');
  assert.equal(pinned[0].agent, 'Claude', 'the agent name is lost rather than kept for the accessible name');
  assert.equal(railCardName(pinned[0]), 'Session run, pinned, run by an agent, Claude, 3 hours ago');
  // Archiving is the reader's own word about a session and outranks the guess, so an
  // archived run is drawn as archived and nothing else.
  const away = railSessions(
    [s('mine'), s('other'), s('run', true)],
    none,
    noTurns,
    new Map(),
    new Set(['run']),
    null,
    new Set(),
    new Map(),
    {},
    {},
  );
  const archived = away.find((c) => c.id === 'run');
  assert.equal(archived?.agentRun, false);
  assert.equal(archived?.agentWord, 'Claude');
  assert.match(archived ? railCardName(archived) : '', /^Session run, archived, Claude/);
});

test('pinned sessions hold the top of the rail, whatever their age', () => {
  const s = (id: string) => ({ id, label: id, agent: 'Codex', when: '9:05 AM', at: 1000, relative: '2 days ago' });
  const four = [s('a'), s('b'), s('c'), s('d')];
  const none = new Map<string, NewCount>();
  const noTurns = new Map<string, number>();
  // Pinned first, in the list's own order among themselves; the rest keep that order too.
  const rail = railSessions(four, none, noTurns, new Map(), new Set(), null, new Set(['b', 'd']), new Map(), {}, {});
  assert.deepEqual(
    rail.map((r) => r.id),
    ['b', 'd', 'a', 'c'],
  );
  assert.deepEqual(
    rail.map((r) => r.pinnedTop),
    [true, true, false, false],
  );
  // The name says so, right after the session's own name.
  assert.equal(railCardName(rail[0]), 'b, pinned, Codex, 2 days ago');
  assert.equal(railCardName(rail[2]), 'a, Codex, 2 days ago');
  // Archiving wins over pinning where a stored state holds both: the card goes to the end
  // and gives up the top, or it would hold the rail's top from inside a folded bucket.
  const both = railSessions(four, none, noTurns, new Map(), new Set(['b']), null, new Set(['b']), new Map(), {}, {});
  assert.deepEqual(
    both.map((r) => r.id),
    ['a', 'c', 'd', 'b'],
  );
  assert.deepEqual(
    both.map((r) => r.pinnedTop),
    [false, false, false, false],
  );
  assert.equal(both[3].archived, true);
  assert.equal(
    railCardName(both[3]),
    'b, archived, Codex, 2 days ago',
    'a card cannot read as both archived and pinned',
  );
});

test('a rail card takes its newest turn from the parsed cards, not the drawn ones', () => {
  // The fact itself, through the rule that works it out: the rail's counts and statuses are
  // computed over every parsed card, and the timestamp comes from the same list, or a
  // session the rail can count would be one it cannot mark.
  const t = (sessionId: string, startedAt: number) => ({ sessionId, startedAt });
  const newest = newestPerSession([t('a', 100), t('b', 900), t('a', 700)]);
  const s = (id: string) => ({ id, label: id, agent: 'Codex', when: '9:05 AM', at: 1000, relative: '2 days ago' });
  const rail = railSessions(
    [s('a'), s('b')],
    new Map([
      ['a', { count: 1, atLeast: false }],
      ['b', { count: 0, atLeast: false }],
    ]),
    newest,
    new Map(),
    new Set(),
    'a',
    new Set(),
    new Map(),
    {},
    {},
  );
  // The shown session and the one with nothing drawn beside it both carry a timestamp
  // and both offer an entry.
  assert.equal(rail[0].newestTurnAt, 700);
  assert.equal(rail[1].newestTurnAt, 900);
  assert.equal(rail[0].menuSection, RAIL_MENU_SECTIONS.unread);
  assert.equal(rail[1].menuSection, RAIL_MENU_SECTIONS.read);

  // The timestamp is what decides, and the count is not. A session counted with no
  // newest turn behind it cannot happen while both are read off one list of cards, and it
  // is exactly what a second condition would let through: the card offers no read entry.
  const split = railSessions(
    [s('a'), s('b')],
    new Map([
      ['a', { count: 0, atLeast: false }],
      ['b', { count: 0, atLeast: false }],
    ]),
    new Map([['a', 700]]),
    new Map(),
    new Set(),
    null,
    new Set(),
    new Map(),
    {},
    {},
  );
  assert.equal(split[1].newestTurnAt, null);
  assert.equal(
    split[1].menuSection,
    RAIL_MENU_SECTIONS.plain,
    'a session with a count and no newest turn offers the entry, which would mark nothing',
  );
});

test('the turn budget serves the session on screen first, and every parsed session keeps a turn', () => {
  const t = (sessionId: string, startedAt: number) => ({ sessionId, startedAt });
  // Newest first, as collect hands them over.
  const turns = [t('a', 90), t('b', 80), t('a', 70), t('c', 60), t('b', 50), t('c', 40)];
  // The session on screen fills first, so the view it fills keeps its depth, and every
  // other parsed session still keeps its newest turn: the rail reads a card's status and its
  // count off the listed turns, so a session parsed and absent from the list wears neither.
  assert.deepEqual(turnBudget(turns, 3, 'c'), [t('c', 60), t('c', 40), t('a', 90), t('b', 80)]);
  // The workspace with no session at all is the one case that passes null, and it is
  // the only way the panel reaches this rule without one. The cut is then the newest N plus
  // the newest turn of any session cut out entirely.
  assert.deepEqual(turnBudget(turns, 3, null), [t('a', 90), t('b', 80), t('a', 70), t('c', 60)]);
  // A budget past the list changes nothing, and an empty list stays empty.
  assert.deepEqual(turnBudget(turns, 99, null), turns);
  assert.deepEqual(turnBudget([], 5, 'a'), []);
});

// The rule that keeps a session on screen. One is drawn at a time, so the panel has to
// answer this on every refresh: with nothing stored, with an id whose transcript has gone, and
// in a workspace that holds no session at all.
test('the panel always has a session to show, whatever it was asked for', () => {
  // Sorted newest activity first, which is the order allSessions hands them over in.
  const live = ['new', 'older', 'oldest'];
  // What the reader asked for, where it is still there.
  assert.equal(pickShowing(live, 'older'), 'older');
  // An id the workspace no longer lists falls to the newest, never to nothing: a stored id
  // outlives the transcript it names, because Claude Code deletes its own on a schedule.
  assert.equal(pickShowing(live, 'gone'), 'new');
  // A first paint, with nothing asked for.
  assert.equal(pickShowing(live, null), 'new');
  assert.equal(pickShowing(live, ''), 'new');
  // The one case with no answer: a workspace holding no session.
  assert.equal(pickShowing([], 'gone'), null);
  assert.equal(pickShowing([], null), null);
});

test('an empty session says why without describing the workspace parse set', () => {
  assert.deepEqual(emptyTimeline({ folders: 0, session: false }), {
    message: 'No folder is open, so there is no session to show.',
  });
  assert.deepEqual(emptyTimeline({ folders: 1, session: false }), {
    message: 'No sessions in this project yet.',
  });
  assert.deepEqual(emptyTimeline({ folders: 1, session: true }), {
    message: 'This session has not produced a response yet.',
  });
  assert.deepEqual(emptyTimeline({ folders: 1, session: true, draft: true }), {
    message: 'Start this session with a prompt.',
  });
  assert.deepEqual(emptyTimeline({ folders: 1, session: true, loading: 'Parser repair' }), {
    message: 'Loading the newest turn from Parser repair.',
  });
  assert.equal(
    emptyTimeline({ folders: 0, session: true }).message,
    'No folder is open, so there is no session to show.',
  );
});

test('newest-turn loading stays visible when a compaction card is already drawn', () => {
  const message = 'Loading the newest turn from Parser repair.';
  assert.deepEqual(newestTurnLoading('Parser repair', false), {
    diagnosis: { message },
    history: null,
  });
  assert.deepEqual(newestTurnLoading('Parser repair', true), {
    diagnosis: null,
    history: { kind: 'busy', label: message },
  });
});

test('the saved panel state is rebuilt rather than trusted', () => {
  // It comes back from storage that outlives the code that wrote it, so every shape below is
  // one this has to survive without throwing: a panel that throws reading its own state
  // draws nothing at all and says nothing about why.
  const empty = {
    open: [],
    collapsed: [],
    hidden: [],
    pinnedTop: [],
    read: [],
    readTo: {},
    since: 0,
    showing: '',
    filter: '',
    railFilter: '',
    railFilterId: 'all',
    railFilters: [],
    railSort: 'latest',
    railDefaultSort: 'latest',
    railGroupBy: 'time',
    railDensity: 'comfortable',
    railShowArchived: true,
    railShowRuns: true,
    railQuickFilters: ['running', 'active', 'input'],
    railWidth: RAIL_WIDTH_DEFAULT,
    composerHidden: false,
    promptFloor: 4.2,
    railFolds: {},
    comments: [],
    drafts: {},
    sentPrompts: {},
    draftCommentIds: {},
    started: [],
    labels: {},
    readerParents: {},
    views: [],
    assets: {},
    queues: {},
  };
  assert.deepEqual(normalizePanelState(null), empty);
  assert.deepEqual(normalizePanelState(undefined), empty);
  assert.deepEqual(normalizePanelState('not an object'), empty);
  assert.deepEqual(normalizePanelState(42), empty);
  assert.deepEqual(normalizePanelState([]), empty);
  // A field of the wrong shape becomes that field's empty answer and takes nothing else
  // down with it.
  assert.deepEqual(normalizePanelState({ open: 'nope', collapsed: ['a'] }), { ...empty, collapsed: ['a'] });
  // Non-strings inside a list are dropped rather than carried through as ids nothing matches.
  assert.deepEqual(normalizePanelState({ hidden: ['a', 7, null, 'b'] }).hidden, ['a', 'b']);
  assert.deepEqual(normalizePanelState({ pinnedTop: ['a', 7, null] }).pinnedTop, ['a']);
  // The sessions this panel started, which decide whether a session is filed as a
  // run. A stored entry of any other shape is dropped rather than kept as an id nothing has.
  assert.deepEqual(normalizePanelState({ started: ['a', 7, null, 'b'] }).started, ['a', 'b']);
  assert.deepEqual(normalizePanelState({ started: 'a' }).started, []);
  // A state written when the two card checkboxes existed still normalizes, and their
  // retired flags do not come back as fields.
  assert.deepEqual(normalizePanelState({ changedOnly: true, needsMeOnly: true, open: ['x'] }), {
    ...empty,
    open: ['x'],
  });
  const retiredKey = ['line', 'age'].join('');
  const retiredState = normalizePanelState({ [retiredKey]: { origins: { child: { parent: 'root' } } } });
  assert.deepEqual(retiredState, empty);
  assert.equal(retiredKey in retiredState, false);
  // The filter is the one remembered value that is not a list or a flag, so a value of the
  // wrong shape becomes an empty box rather than something the panel tries to read as a query.
  assert.equal(normalizePanelState({ filter: 'agent:codex' }).filter, 'agent:codex');
  assert.equal(normalizePanelState({ filter: 42 }).filter, '');
  assert.equal(normalizePanelState({ filter: ['a'] }).filter, '');
  // The session on screen is remembered the same way, and it is why a reload opens where
  // the reader left off. Take this field out of the state and a window reload draws whichever
  // session is newest instead of the one they were reading.
  assert.equal(normalizePanelState({ showing: 'abc123' }).showing, 'abc123');
  assert.equal(normalizePanelState({ showing: 42 }).showing, '');
  assert.equal(normalizePanelState({ showing: ['a'] }).showing, '');
  // The floor a fresh workspace stamps. It is compared against a turn's start time, so a
  // value that will not read has to become no floor at all rather than be carried through:
  // a NaN or a string here would answer nonsense about every turn in the workspace.
  assert.equal(normalizePanelState({ since: 1_700_000_000_000 }).since, 1_700_000_000_000);
  assert.equal(normalizePanelState({ since: 0 }).since, 0);
  for (const bad of ['yesterday', NaN, Infinity, -1, null, {}, ['x']]) {
    assert.equal(
      normalizePanelState({ since: bad }).since,
      0,
      `a floor of ${JSON.stringify(bad)} was carried through rather than dropped`,
    );
  }
  // The rail's own box is remembered under the same rule as the main one.
  assert.equal(normalizePanelState({ railFilter: 'codex' }).railFilter, 'codex');
  assert.equal(normalizePanelState({ railFilter: 42 }).railFilter, '');
  // The rail's width comes back through the clamp, so a width written by an older
  // version or edited by hand cannot collapse the rail or the list.
  assert.equal(normalizePanelState({ railWidth: 300 }).railWidth, 300);
  assert.equal(normalizePanelState({ railWidth: '300' }).railWidth, RAIL_WIDTH_DEFAULT);
  assert.equal(normalizePanelState({ railWidth: 9999 }).railWidth, 9999);
  assert.equal(normalizePanelState({ promptFloor: 12.4 }).promptFloor, 12.4);
  assert.equal(normalizePanelState({ promptFloor: '12.4' }).promptFloor, 4.2);
  // The rail's folds are rebuilt entry by entry against the keys the rail can draw a heading
  // for. A press the reader made is kept both ways round, a key no longer drawn goes, and a
  // value of any other shape goes with it: a fold decided by whether a value is truthy is a
  // heading the reader cannot open.
  assert.deepEqual(normalizePanelState({ railFolds: { railtoday: false, railarchived: true } }).railFolds, {
    railtoday: false,
    railarchived: true,
  });
  // A saved view is remembered under its own prefix, so a view called `today` cannot take the
  // Today bucket's fold.
  assert.deepEqual(
    normalizePanelState({ railFolds: { 'railgroup:view:v1': true, 'railgroup:view:v2': false } }).railFolds,
    { 'railgroup:view:v1': true, 'railgroup:view:v2': false },
  );
  // A grouped rail's headings each fold under the same prefix, one key per label, agent and
  // status group plus the flat `all` heading Group by `None` draws.
  assert.deepEqual(
    normalizePanelState({
      railFolds: {
        'railgroup:label:composer': true,
        'railgroup:label:': false,
        'railgroup:agent:codex': true,
        'railgroup:status:running': false,
        'railgroup:all': true,
      },
    }).railFolds,
    {
      'railgroup:label:composer': true,
      'railgroup:label:': false,
      'railgroup:agent:codex': true,
      'railgroup:status:running': false,
      'railgroup:all': true,
    },
  );
  // A key stored by the build that folded by the bucket id goes, because nothing draws a
  // heading under one now.
  assert.deepEqual(normalizePanelState({ railFolds: { today: false, archived: true } }).railFolds, {});
  assert.deepEqual(
    normalizePanelState({ railFolds: { retired: false, railpinned: 'yes', railolder: 1, railruns: null } }).railFolds,
    {},
  );
  for (const bad of ['shut', 42, null, ['railtoday'], undefined]) {
    assert.deepEqual(
      normalizePanelState({ railFolds: bad }).railFolds,
      {},
      `a fold state of ${JSON.stringify(bad)} was carried through rather than dropped`,
    );
  }
  // Every bucket the rail draws can be remembered, or one of them is a heading whose press
  // is forgotten on the next reload.
  const all = Object.fromEntries(RAIL_BUCKETS.map((id) => [RAIL_FOLDS[id], false]));
  assert.deepEqual(normalizePanelState({ railFolds: all }).railFolds, all);
  // The record stops at its ceiling. A panel that deletes a view drops its fold, and a second
  // panel holding the same view open never learns of it, so a key no heading draws survives.
  const many = Object.fromEntries(
    Array.from({ length: RAIL_FOLD_LIMIT + 5 }, (unused, at) => [`railgroup:view:v${at}`, true]),
  );
  assert.equal(Object.keys(normalizePanelState({ railFolds: many }).railFolds).length, RAIL_FOLD_LIMIT);
});

// The filters the reader saved, which the rail draws a section from. The list is the reader's
// own filing, so it comes back through the module that owns it rather than being trusted.
test('the saved views come back rebuilt entry by entry', () => {
  const perf = { id: 'v1', name: 'Perf work', query: 'label:perf', archived: true };
  // The list itself is rebuilt by `normalizeSavedViews`, so a stored entry with no id and one
  // with no name both go, and the entry the reader wrote survives whole.
  assert.deepEqual(normalizePanelState({ views: [perf, { name: 'No id' }, { id: 'v2' }] }).views, [
    { id: 'v1', name: 'Perf work', query: 'label:perf', archived: true },
  ]);
  // A stored list of any other shape becomes no views rather than throwing.
  for (const bad of ['v1', 42, null, { v1: perf }]) {
    assert.deepEqual(
      normalizePanelState({ views: bad }).views,
      [],
      `a view list of ${JSON.stringify(bad)} was carried through rather than dropped`,
    );
  }
});

test('saved rail filters and the one the rail is on come back rebuilt entry by entry', () => {
  const costly = { id: 'f1', name: 'High cost', query: 'cost:>=5', sort: 'cost-desc' };
  assert.deepEqual(
    normalizePanelState({
      railFilters: [costly, { name: 'No id' }, { id: 'f2' }],
      railFilterId: 'f1',
      railSort: 'cost-desc',
      railDefaultSort: 'cost-asc',
    }),
    {
      ...normalizePanelState(null),
      railFilters: [costly],
      railFilterId: 'f1',
      railSort: 'cost-desc',
      railDefaultSort: 'cost-asc',
    },
  );
  const missing = normalizePanelState({
    railFilters: [costly],
    railFilterId: 'missing',
    railLens: 'active',
    railFilter: 'is:unread',
    railSort: 'cost-desc',
    railDefaultSort: 'cost-asc',
  });
  assert.deepEqual(
    {
      railFilter: missing.railFilter,
      railFilterId: missing.railFilterId,
      railSort: missing.railSort,
    },
    { railFilter: '', railFilterId: 'all', railSort: 'cost-asc' },
  );
  assert.deepEqual(normalizePanelState({ railFilters: 'not a list', railFilterId: 'f1' }).railFilters, []);

  assert.equal(normalizePanelState({ railSort: 'unknown' }).railSort, 'latest');
  assert.equal(normalizePanelState({ railDefaultSort: 'unknown' }).railDefaultSort, 'latest');
  assert.equal(
    normalizePanelState({ railSort: 'cost-asc' }).railDefaultSort,
    'cost-asc',
    "state saved before the default field lost the reader's chosen rail order",
  );
});

// The two Show switches are rail state the reader set, and a restored panel reads the host's
// copy of that state ahead of the browser's. A copy that carried neither reopened the rail
// with the buckets the reader had turned off drawn again.
test('the rail Show switches come back from stored state, on where nothing turned them off', () => {
  const fresh = normalizePanelState(null);
  assert.deepEqual(
    { archived: fresh.railShowArchived, runs: fresh.railShowRuns },
    { archived: true, runs: true },
    'a panel with no stored answer opened with a bucket hidden',
  );
  const off = normalizePanelState({ railShowArchived: false, railShowRuns: false });
  assert.deepEqual(
    { archived: off.railShowArchived, runs: off.railShowRuns },
    { archived: false, runs: false },
    'the reader turned both buckets off and the reopened panel drew them',
  );
  // Only a stored `false` turns one off, which is the rule the rail itself reads, so a value
  // of another shape leaves the bucket drawn.
  const odd = normalizePanelState({ railShowArchived: 'no', railShowRuns: 0 });
  assert.deepEqual({ archived: odd.railShowArchived, runs: odd.railShowRuns }, { archived: true, runs: true });
  assert.deepEqual(
    webviewPanelState(normalizePanelState({ railShowRuns: false })).railShowRuns,
    false,
    'the panel was served no answer about the Run by agents bucket',
  );
});

// The Quick filters choice is rail state the reader set, so the host carries it both ways.
// A choice stored before the Running lens existed loads with Running added, because that build
// drew a running figure on every rail.
test('the rail head lens choice comes back from stored state, and Unread waits where nothing chose', () => {
  const all = ['running', 'active', 'unread', 'input'];
  const quick = (raw: unknown) => normalizePanelState(raw).railQuickFilters;
  assert.deepEqual(quick(null), ['running', 'active', 'input']);
  assert.deepEqual(quick({ railQuickFilters: 'input', railHeadLenses: 'unread' }), ['running', 'active', 'input']);
  assert.deepEqual(quick({ railQuickFilters: ['unread'], railHeadLenses: ['active'] }), ['unread']);
  assert.deepEqual(quick({ railHeadLenses: ['active', 'unread', 'input'] }), all);
  assert.deepEqual(quick({ railHeadLenses: ['unread'] }), ['running', 'unread']);
  assert.deepEqual(quick({ railHeadLenses: [] }), ['running']);
  assert.deepEqual(quick({ railQuickFilters: [] }), []);
  assert.deepEqual(quick({ railQuickFilters: [], railHeadLenses: ['active'] }), []);
  assert.deepEqual(quick({ railQuickFilters: ['input', 'bogus', 'active'] }), ['active', 'input']);
  const sent = webviewPanelState(normalizePanelState({ railHeadLenses: ['unread'] }));
  assert.deepEqual(sent.railQuickFilters, ['running', 'unread']);
  assert.equal('railHeadLenses' in sent, false);
});

// Group by is rail state the reader set, and a restored panel reads the host's copy of that
// state. A copy that dropped it reopened the rail grouped by time.
test('the rail Group by value comes back from stored state, time where nothing chose one', () => {
  assert.equal(normalizePanelState(null).railGroupBy, 'time');
  assert.equal(normalizePanelState({ railGroupBy: 'nonsense' }).railGroupBy, 'time');
  const stored = normalizePanelState({ railGroupBy: 'label' });
  assert.equal(stored.railGroupBy, 'label', 'the reopened panel lost the Group by value');
  assert.equal(
    webviewPanelState(normalizePanelState(webviewPanelState(stored))).railGroupBy,
    'label',
    'the panel was served no Group by value',
  );
});

// The row density is rail state the reader set, and a restored panel reads the host's copy of
// that state. A copy that dropped it reopened the rail in comfortable rows.
test('the rail row density comes back from stored state, comfortable where nothing chose one', () => {
  assert.equal(normalizePanelState(null).railDensity, 'comfortable');
  assert.equal(normalizePanelState({ railDensity: 'nonsense' }).railDensity, 'comfortable');
  const stored = normalizePanelState({ railDensity: 'compact' });
  assert.equal(stored.railDensity, 'compact', 'the reopened panel lost the row density');
  assert.equal(
    webviewPanelState(normalizePanelState(webviewPanelState(stored))).railDensity,
    'compact',
    'the panel was served no row density',
  );
});

// A panel saved by a build that kept a lens as rail state, or wrote it as the old words, opens
// with the lens's words in the query. The owner's own stored state sat on the old Needs you id,
// so that case is the common one.
test('a stored rail lens from an older build loads as the lens words in the query', () => {
  const lensOf = (state: ReturnType<typeof normalizePanelState>) => ({
    railFilter: state.railFilter,
    railFilterId: state.railFilterId,
  });
  assert.deepEqual(
    lensOf(
      normalizePanelState({
        railFilterId: 'needs-you',
        railFilter: 'is:input is:unread -is:archived -is:agentrun',
      }),
    ),
    { railFilter: 'is:input is:unread -is:archived -is:agentrun', railFilterId: 'all' },
  );
  assert.deepEqual(
    lensOf(normalizePanelState({ railFilterId: 'all', railFilter: '-is:agentrun is:warm -is:archived' })),
    { railFilter: 'is:active -is:archived -is:agentrun', railFilterId: 'all' },
  );
  assert.deepEqual(lensOf(normalizePanelState({ railFilterId: 'all', railFilter: 'is:running' })), {
    railFilter: 'is:running',
    railFilterId: 'all',
  });
  // A lens stored as rail state joins its query, and an unknown one leaves the query alone.
  assert.deepEqual(lensOf(normalizePanelState({ railFilterId: 'all', railFilter: 'label:ui', railLens: 'active' })), {
    railFilter: 'is:active -is:archived -is:agentrun label:ui',
    railFilterId: 'all',
  });
  assert.equal(normalizePanelState({ railFilter: 'label:ui', railLens: 'warm' }).railFilter, 'label:ui');
  // A lens folded into a query at the box's limit cuts none of the reader's words, and a
  // reload of the folded state keeps it whole.
  const typed = `${'title:x '.repeat(30).slice(0, 190)} label:bug`;
  const folded = normalizePanelState({ railFilterId: 'all', railFilter: typed, railLens: 'active' });
  assert.equal(folded.railFilter, `is:active -is:archived -is:agentrun ${typed}`);
  // A stored Needs you lens is no lens, so the query loads as it was stored.
  assert.equal(
    normalizePanelState({ railFilterId: 'all', railFilter: typed, railLens: 'needs-you' }).railFilter,
    typed,
  );
  assert.equal(normalizePanelState(webviewPanelState(folded)).railFilter, folded.railFilter);
  // Nothing writes the field again.
  assert.ok(!('railLens' in normalizePanelState({ railLens: 'active' })));
  assert.ok(!('railLens' in webviewPanelState(normalizePanelState({ railLens: 'active' }))));
});

// The state a webview is served leaves host-owned records behind. The current label and saved
// filter lists arrive in render messages, so a stale panel state cannot overwrite either one.
test('the state a webview is served carries no host-owned records', () => {
  const held = normalizePanelState(null);
  held.labels = { s1: ['composer'] };
  held.railFilters = [{ id: 'f1', name: 'High cost', query: 'cost:>=5', sort: 'cost-desc' }];
  const served = webviewPanelState(held) as Record<string, unknown>;
  assert.ok(!('labels' in served), 'every session the reader has filed is written into the page');
  assert.ok(!('railFilters' in served), 'the host-owned saved filter list is written into the page state');
  // And nothing else is dropped with it, so a field added to the state reaches the panel the
  // way the rest do and only the one exception has to be argued.
  const wanted = Object.keys(held)
    .filter((key) => key !== 'labels' && key !== 'railFilters' && key !== 'readerParents')
    .sort();
  assert.deepEqual(
    Object.keys(served).sort(),
    wanted,
    'the served state dropped a field the panel reads, or kept one it does not',
  );
  // Views remain in panel state because the panel owns their edits. Saved filters use an
  // explicit host message and arrive with every render instead.
  assert.ok('views' in served, 'the panel was served no view list to draw');
  assert.deepEqual(held.labels, { s1: ['composer'] }, 'the state handed in was edited in place');
  assert.equal(held.railFilters.length, 1, 'the saved filters handed in were edited in place');
});

test('every remembered field has a ceiling, and each keeps the newest', () => {
  // Nothing here is under pressure: the totals are small, and this is tidiness. What it is
  // for is that nothing drops an id whose session has gone, and Claude Code deletes its
  // own transcripts on a schedule, so a hidden session's id outlives the session.
  //
  // The two ceilings, and which field takes which: a turn key is the same shape and the same
  // units as a read one, and everything else here holds one entry per session.
  const many = (n: number) => [...Array(n).keys()].map(String);
  const state = normalizePanelState({
    open: many(READ_LIMIT + 3),
    read: many(READ_LIMIT + 3),
    collapsed: many(SESSION_LIMIT + 3),
    hidden: many(SESSION_LIMIT + 3),
    pinnedTop: many(SESSION_LIMIT + 3),
    started: many(SESSION_LIMIT + 3),
    readTo: Object.fromEntries(many(SESSION_LIMIT + 3).map((id, at) => [id, at])),
  });
  // Written out rather than derived: a slice off the wrong end is the same length, and the
  // sets are written oldest first, so the cut has to come off the front.
  for (const field of ['open', 'read'] as const) {
    assert.equal(state[field].length, READ_LIMIT, `${field} is not held to the turn ceiling`);
    assert.equal(state[field][0], '3', `${field} was cut from the newest end`);
    assert.equal(state[field][READ_LIMIT - 1], String(READ_LIMIT + 2), `${field} lost its newest entry`);
  }
  for (const field of ['collapsed', 'hidden', 'pinnedTop', 'started'] as const) {
    assert.equal(state[field].length, SESSION_LIMIT, `${field} is not held to the session ceiling`);
    assert.equal(state[field][0], '3', `${field} was cut from the newest end`);
    assert.equal(state[field][SESSION_LIMIT - 1], String(SESSION_LIMIT + 2), `${field} lost its newest entry`);
  }
  // The watermarks are a map rather than a list, and are cut the same way and from the same
  // end: the session marked read longest ago is the one that goes.
  const marks = Object.keys(state.readTo);
  assert.equal(marks.length, SESSION_LIMIT, 'the watermarks are not held to the session ceiling');
  assert.equal(marks[0], '3', 'the watermarks were cut from the newest end');
  assert.equal(marks[SESSION_LIMIT - 1], String(SESSION_LIMIT + 2), 'the watermarks lost their newest entry');
  // The ceilings are far past any real workspace, measured against the real thing: 23
  // sessions here and 109 in the largest project on this machine.
  assert.ok(SESSION_LIMIT >= 200, 'the session ceiling is close enough to a real workspace to cut one');
  // A state inside its ceilings is left exactly as it is.
  const small = normalizePanelState({ open: ['a'], collapsed: ['b'], readTo: { s: 5 } });
  assert.deepEqual(small.open, ['a']);
  assert.deepEqual(small.collapsed, ['b']);
  assert.deepEqual(small.readTo, { s: 5 });
});

test('a watermark of the wrong shape is rebuilt, and a wholly wrong state still comes back usable', () => {
  // The watermarks are the one remembered field that is a map, so they are rebuilt entry by
  // entry: a value that is not a finite number would be compared against a turn's start time
  // and answer nonsense, so it is dropped rather than carried through.
  assert.deepEqual(normalizePanelState({ readTo: { a: 5, b: '5', c: NaN, d: null, e: Infinity } }).readTo, { a: 5 });
  // A field that is not a map at all becomes the empty answer for that field, and takes
  // nothing else down with it.
  assert.deepEqual(normalizePanelState({ readTo: 'nope', open: ['a'] }).readTo, {});
  assert.deepEqual(normalizePanelState({ readTo: ['a', 1] }).readTo, {});
  assert.deepEqual(normalizePanelState({ readTo: null, open: ['a'] }).open, ['a']);
  // And the whole point of the function: a state object of entirely the wrong shape comes
  // back usable rather than throwing, because a panel that throws while reading its own
  // state draws nothing at all and says nothing about why.
  const wrong = normalizePanelState({
    open: 42,
    collapsed: {},
    hidden: 'a',
    pinnedTop: null,
    read: { a: 1 },
    readTo: 7,
    filter: [],
    railFilter: 0,
    railWidth: 'wide',
  });
  assert.deepEqual(wrong, normalizePanelState(null));
});

test('a read set restored over its ceiling is cut, and cut from the old end', () => {
  const ids = [...Array(READ_LIMIT + 3).keys()].map(String);
  const cut = normalizePanelState({ read: ids }).read;
  assert.equal(cut.length, READ_LIMIT);
  // The newest survive: the set is written oldest first, so the cut comes off the front.
  // Written out rather than derived, because a slice off the wrong end is the same length.
  assert.equal(cut[0], '3');
  assert.equal(cut[cut.length - 1], String(READ_LIMIT + 2));
});

test('a diff opens where the reader keeps their files, never in the panel own group', () => {
  // What they were last looking at is what they mean by "here".
  assert.equal(editorColumn({ active: 2, visible: [1, 2], panel: null }), 2);
  assert.equal(editorColumn({ active: 1, visible: [1, 2], panel: 3 }), 1);

  // The panel as an editor tab is the case this exists for. With the panel focused in
  // group 2 and files in group 1, the diff belongs in 1: opening it in 2 puts the diff where
  // the panel was and splits the reader's editor in two.
  assert.equal(editorColumn({ active: 2, visible: [1], panel: 2 }), 1);
  assert.equal(editorColumn({ active: null, visible: [1, 3], panel: 1 }), 3);

  // Leftmost of the groups holding a file, which is where a reader with a split keeps their
  // work. Written out rather than derived: the highest would be just as plausible and wrong.
  assert.equal(editorColumn({ active: null, visible: [3, 1, 2], panel: null }), 1);
  assert.equal(editorColumn({ active: null, visible: [3, 2], panel: 2 }), 3);

  // Nothing else open. The panel's own group is then the right answer rather than a wrong one:
  // the diff opens as another tab beside the panel instead of splitting the window, and not
  // splitting is the whole point.
  assert.equal(editorColumn({ active: null, visible: [], panel: 2 }), 2);
  assert.equal(editorColumn({ active: 2, visible: [2], panel: 2 }), 2);
  // No panel and no editors at all is the first group, which is where a fresh window puts one.
  assert.equal(editorColumn({ active: null, visible: [], panel: null }), 1);
});

test('a repeated beside-open reuses the group the first press made', () => {
  // The first press has nothing to reuse, so it splits.
  assert.equal(besideColumn({ last: null, groups: [1], panel: null }), null);
  // The second lands in the group the first one made.
  assert.equal(besideColumn({ last: 2, groups: [1, 2], panel: null }), 2);
  assert.equal(besideColumn({ last: 3, groups: [1, 2, 3], panel: 1 }), 3);
  // A column no longer open says nothing: closing a group hands its number to a neighbour.
  assert.equal(besideColumn({ last: 3, groups: [1, 2], panel: null }), null);
  // A column the panel's own tab now occupies is refused, the promise editorColumn makes.
  assert.equal(besideColumn({ last: 2, groups: [1, 2], panel: 2 }), null);
});

test('a search says when each turn was and which session it belongs to', () => {
  const found = searchTurns(
    [entry({ sessionTitle: 'Timeline UI', agent: 'Codex', startedAt: 5000, summary: 'about root' })],
    'find: root',
    5000,
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].sessionTitle, 'Timeline UI');
  assert.equal(found[0].agent, 'Codex');
  // Worded here, because the panel has no clock of its own and every other time on screen
  // comes through the same helper.
  assert.equal(found[0].when, formatWhen(5000, 5000));
});

test('the notes ride the stored panel state through the same rebuild as everything else', () => {
  // The state comes back from storage that outlives the code that wrote it, and the notes
  // are the one field in it the reader typed rather than pressed, so a state that throws
  // here loses work nothing can get back.
  assert.deepEqual(normalizePanelState(null).comments, []);
  assert.deepEqual(normalizePanelState({ comments: 'nope', open: ['a'] }).comments, []);
  assert.deepEqual(
    normalizePanelState({ comments: 'nope', open: ['a'] }).open,
    ['a'],
    'a bad note list took the rest of the remembered state down with it',
  );
  const state = normalizePanelState({ comments: [comment(), 'nope', comment({ id: 'n2' })] });
  assert.deepEqual(
    state.comments.map((c) => c.id),
    ['n1', 'n2'],
  );
  assert.equal(
    normalizePanelState({
      comments: Array.from({ length: COMMENT_LIMIT + 3 }, (_, i) => comment({ id: 'n' + i })),
    }).comments.length,
    COMMENT_LIMIT,
  );
});

test("the words for the notes are their own table, folded whole into the panel's", () => {
  // The fold spreads these in at the head of CARD_ACTIONS, so a key spelled again further
  // down that table takes the word back, silently, and the control the panel draws for the
  // note would be named after something else on screen. Held on the value rather than on
  // the key, because after the fold every one of these keys is in CARD_ACTIONS by design
  // and only the word can say which table it came from.
  for (const [key, word] of Object.entries(COMMENT_ACTIONS)) {
    assert.equal(
      CARD_ACTIONS[key as keyof typeof CARD_ACTIONS],
      word,
      `CARD_ACTIONS spells ${key} itself, so the fold does not reach the panel`,
    );
  }
  // Every control the panel will draw is named, and no name is blank: a blank one reaches
  // the screen as an unlabelled button and nothing anywhere says so.
  for (const [key, word] of Object.entries(COMMENT_ACTIONS)) {
    assert.equal(typeof word, 'string');
    assert.ok(word.trim().length > 0, `${key} has no word, so the control it names is announced as nothing`);
  }
  for (const named of [
    'write',
    'save',
    'cancel',
    'edit',
    'delete',
    'markOne',
    'markMany',
    'offLineOne',
    'offLineMany',
  ]) {
    assert.ok(named in COMMENT_ACTIONS, `nothing names ${named}, so the panel would spell it itself`);
  }
  // One word for the whole feature, on every surface it reaches. The reader sees "comment"
  // in the panel, in the card menu and in the pasted block, and a word that drifted back
  // would leave the same thing called two things on one screen.
  for (const [key, word] of Object.entries(COMMENT_ACTIONS)) {
    assert.doesNotMatch(word, /\bnotes?\b/i, `${key} calls a comment a note, so the panel says both`);
  }
  for (const named of ['write', 'editor', 'edit', 'delete', 'markOne', 'markMany', 'offLineOne', 'offLineMany']) {
    assert.match(
      COMMENT_ACTIONS[named as keyof typeof COMMENT_ACTIONS],
      /comment/i,
      `${named} names the thing it acts on as something other than a comment`,
    );
  }
});

// A count taken from a window and drawn as a total is wrong in the direction that reads as
// right, so the figure carries whether it is a floor and the wording says so in words.
test('a count taken from part of a session is drawn as a floor, not as a total', () => {
  const none = new Map<string, number>();
  const partial = (starts: number[]) => new Map([['a', { starts, whole: false }]]);

  // Nothing in the window has been read, so there is no boundary: every turn in it counts,
  // and the turns older than it would have counted too. A floor.
  const floor = newCounts([], partial([100, 200, 300]), [], none).get('a');
  assert.deepEqual(floor, { count: 3, atLeast: true });
  assert.equal(newIndicator(floor), 'at least 3 new');

  // Something in the window has been read, so the boundary sits inside it. Everything
  // outside the window is older than everything in it, so nothing out there can be new: the
  // figure is a total even though the window did not reach the start of the file.
  const read = [turnKey({ sessionId: 'a', startedAt: 100 })];
  const exact = newCounts([], partial([100, 200, 300]), read, none).get('a');
  assert.deepEqual(exact, { count: 2, atLeast: false });
  assert.equal(newIndicator(exact), '2 new');

  // A watermark inside the window does the same, since it is the same read rule.
  assert.deepEqual(newCounts([], partial([100, 200, 300]), [], new Map([['a', 100]])).get('a'), {
    count: 2,
    atLeast: false,
  });

  // A window that reached the start of the file has nothing outside it, so it is always a
  // total, read or not.
  assert.deepEqual(newCounts([], new Map([['a', { starts: [100, 200], whole: true }]]), [], none).get('a'), {
    count: 2,
    atLeast: false,
  });
});

// A card that showed a count with no watermark behind it would wear a mark the reader has no
// way to clear, and one with a watermark behind no count would offer a press that changes
// nothing. Both come off the same two sources, so neither can happen.
test('a glanced-at session can be marked read, and the rail says so on its card', () => {
  const parsed = [{ sessionId: 'p', startedAt: 500 }];
  const windows = new Map([
    ['g', { starts: [100, 200, 300], whole: false }],
    ['q', { starts: [], whole: true }],
  ]);
  const newest = newestTurnStarts(parsed, windows);
  // The newest start the window holds is the newest the file holds: a window is the end of
  // a file, whatever it missed further back.
  assert.equal(newest.get('g'), 300);
  assert.equal(newest.get('p'), 500);
  assert.equal(newest.has('q'), false, 'a window that found no turn handed one out anyway');

  const s = (id: string) => ({ id, label: id, agent: 'Claude', when: '2:32 PM', at: 4200, relative: '3 hours ago' });
  const counts = newCounts(
    [{ key: turnKey({ sessionId: 'p', startedAt: 500 }), sessionId: 'p', startedAt: 500, kind: 'turn' }],
    windows,
    [],
    new Map(),
  );
  const rail = railSessions(
    [s('g'), s('p'), s('q')],
    counts,
    newest,
    new Map(),
    new Set(),
    null,
    new Set(),
    new Map(),
    {},
    {},
  );
  // The glanced-at session draws a mark, says its floor in words, and offers the entry
  // that clears it.
  assert.equal(rail[0].indicator, 'at least 3 new');
  assert.equal(rail[0].unread, true);
  assert.equal(rail[0].newestTurnAt, 300);
  assert.equal(rail[0].menuSection, RAIL_MENU_SECTIONS.unread);
  assert.equal(railCardName(rail[0]), 'g, Claude, 3 hours ago, at least 3 new');
  // The one nothing could glance at keeps saying nothing, and offers no read entry.
  assert.equal(rail[2].indicator, null);
  assert.equal(rail[2].unread, false);
  assert.equal(rail[2].menuSection, RAIL_MENU_SECTIONS.plain);
  // The invariant, over every card: a read entry and a watermark are one answer, so the
  // plain section is worn by exactly the cards with no turn behind them.
  for (const card of rail) {
    assert.equal(
      card.menuSection === RAIL_MENU_SECTIONS.plain,
      card.newestTurnAt === null,
      card.id + ' offers an entry with no turn to mark, or holds a turn nobody can mark',
    );
  }
});

// A whole-file pass extracting turn starts costs 227 ms over this workspace and 1,849 ms
// over the largest project on this machine, so the panel glances at a window instead and
// spends a budget per refresh. A text scan cannot catch a budget quietly loosened, so the
// rule is lifted and run.
test('a refresh glances at what it has budget for, newest first, and stops', () => {
  const mb = 1024 * 1024;
  const files = (sizes: number[]) => sizes.map((size, i) => ({ size, id: 's' + i }));

  // Newest first is the caller's order, and the budget is spent down that order: the rail
  // fills from its top, which is where the reader is looking.
  const taken = glanceBudget(files([mb, mb, mb, mb]), mb, 2 * mb);
  assert.deepEqual(
    taken.map((f) => f.id),
    ['s0', 's1'],
  );

  // The scheduled cost is the smaller of the file and the initial window. Most glances stop
  // there, and charging every large file at the rare growth ceiling stops the fill early.
  assert.deepEqual(
    glanceBudget(files([mb / 4, mb / 4, mb / 4, mb / 4]), mb, mb).map((f) => f.id),
    ['s0', 's1', 's2', 's3'],
  );

  // A file larger than the window has the window's initial scheduled cost.
  assert.deepEqual(
    glanceBudget(files([100 * mb, mb]), mb, 2 * mb).map((f) => f.id),
    ['s0', 's1'],
  );

  // The budget is a ceiling, and this is what a loosened one breaks.
  for (const [budget, want] of [
    [0, 1],
    [mb, 1],
    [3 * mb, 3],
    [99 * mb, 4],
  ] as const) {
    const got = glanceBudget(files([mb, mb, mb, mb]), mb, budget);
    assert.equal(got.length, want, 'a budget of ' + budget + ' bytes glanced at ' + got.length + ' windows');
    const spent = got.reduce((a, f) => a + Math.min(f.size, mb), 0);
    assert.ok(spent <= Math.max(budget, mb), 'the pass spent ' + spent + ' bytes against a budget of ' + budget);
  }

  // The first candidate is always taken. A budget smaller than one window would otherwise
  // glance at nothing for ever and the rail would never fill at all.
  assert.equal(glanceBudget(files([mb]), mb, 1).length, 1);
  assert.deepEqual(glanceBudget([], mb, 99 * mb), []);

  // The figure the panel actually spends, stated once so a change to it is a change here.
  // Eight megabytes covers this workspace's 49 sessions in four refreshes and the
  // largest project's 130 in three, at roughly 8 ms of scanning each.
  assert.equal(GLANCE_BUDGET_BYTES, 8 * 1024 * 1024);
});

// The glance spends a budget per refresh, so the rail fills over several polls. A workspace
// where no agent is running produces the same signature for ever, so a refresh that stops on
// the signature alone stops the fill: the panel glanced at one budget on the poll that opened
// it and every session past that budget stayed silent. Each term written out, because a
// guard over the source text can see three terms and not which way round one of them runs.
test('a refresh goes on while a glance is still reaching new sessions', () => {
  const same = {
    force: false,
    signature: 'a',
    lastSignature: 'a',
    glancedBefore: 4,
    glancedNow: 4,
    statusMoved: false,
    openChildren: { drawn: '', now: '' },
  };
  assert.equal(refreshWanted(same), false, 'nothing moved and nothing was glanced, so there is nothing to do');
  assert.equal(refreshWanted({ ...same, dispatchFiguresMoved: true }), true);
  assert.equal(refreshWanted({ ...same, dispatchFiguresMoved: false }), false);

  // A glance that reached a session it had not reached before is a reason on its own.
  assert.equal(
    refreshWanted({ ...same, glancedNow: 5 }),
    true,
    'a session was glanced at and the rail was never told, so it stays silent',
  );
  // And so is one dropping off, or the rail would keep drawing a count for a session
  // that has since been parsed or has gone.
  assert.equal(refreshWanted({ ...same, glancedNow: 3 }), true);

  // The two reasons that were there before.
  assert.equal(refreshWanted({ ...same, signature: 'b' }), true, 'a transcript moved and nothing repainted');
  assert.equal(refreshWanted({ ...same, force: true }), true, 'the refresh button repainted nothing');
  // Force wins over everything, which is what the button and a freshly shown panel need.
  assert.equal(
    refreshWanted({
      force: true,
      signature: 'a',
      lastSignature: 'a',
      glancedBefore: 0,
      glancedNow: 0,
      statusMoved: false,
      openChildren: { drawn: '', now: '' },
    }),
    true,
  );

  // The first refresh of all: nothing glanced yet and no signature to compare against.
  assert.equal(
    refreshWanted({
      force: false,
      signature: 'a',
      lastSignature: '',
      glancedBefore: 0,
      glancedNow: 0,
      statusMoved: false,
      openChildren: { drawn: '', now: '' },
    }),
    true,
  );

  // A turn whose agent died is never written to again, so the three terms above never fire.
  // Without this one the card keeps the word running for as long as the panel stays open.
  assert.equal(
    refreshWanted({ ...same, statusMoved: true }),
    true,
    'a turn stopped running and the poll skipped the parse that would have said so',
  );
  assert.equal(
    refreshWanted({ ...same, statusMoved: false, openChildren: { drawn: '', now: '' } }),
    false,
    'nothing moved on the clock either, so the poll still has nothing to do',
  );
});

// A command whose terminal closed writes no end record and the transcript stays still. The poll
// still has to notice when the hour cap passes, or the rail keeps the session in the background
// state until something unrelated repaints it.
test('a refresh goes on when a background command reaches the hour cap with no file change', () => {
  vi.useFakeTimers({ now: 10 * 60 * 60 * 1000 });
  try {
    const launchedAt = Date.now() - 50_000;
    const outcome: TurnOutcome = {
      finished: true,
      error: false,
      interrupted: false,
      startedAt: Date.now() - 60_000,
      endedAt: Date.now() - 30_000,
      backgroundCommands: [{ id: 'cmd1', startedAt: launchedAt }],
    };
    const outcomes = new Map([['a', outcome]]);
    const read = () => liveBackgroundCommands(outcomes, new Map(), Date.now());
    const drawn = openChildrenKey(new Map(), read());
    const poll = () =>
      refreshWanted({
        force: false,
        signature: 'a',
        lastSignature: 'a',
        glancedBefore: 1,
        glancedNow: 1,
        statusMoved: false,
        openChildren: { drawn, now: openChildrenKey(new Map(), read()) },
      });
    const status = () =>
      sessionStatusOf([], new Set(), outcomes, Date.now(), new Set(), new Map(), new Map(), read()).get('a');
    assert.equal(status(), 'background');
    assert.equal(poll(), false, 'the command still runs inside its hour, so the poll has nothing to do');
    vi.advanceTimersByTime(launchedAt + BACKGROUND_COMMAND_CAP_MS - 1 - Date.now());
    assert.equal(status(), 'background', 'the hour has not run out yet');
    assert.equal(poll(), false, 'the hour has not run out yet');
    vi.advanceTimersByTime(1);
    assert.equal(poll(), true, 'the hour ran out and the poll skipped the repaint');
    assert.equal(status(), 'done');
  } finally {
    vi.useRealTimers();
  }
});

// A background child that dies with no notice never writes again, so no transcript moves and
// no turn's clock changes. The poll still has to notice when its quiet hour runs out, or the
// rail keeps the session in the subagents state until something unrelated repaints it.
test('a refresh goes on when a live open child goes quiet with no file change', () => {
  vi.useFakeTimers({ now: 10 * 60 * 60 * 1000 });
  try {
    const outcome: TurnOutcome = {
      finished: true,
      error: false,
      interrupted: false,
      startedAt: Date.now() - 60_000,
      endedAt: Date.now() - 30_000,
      openChildren: ['x1'],
    };
    const outcomes = new Map([['a', outcome]]);
    const wroteAt = Date.now();
    const read = () => liveOpenChildren(outcomes, () => wroteAt, new Map(), Date.now());
    const drawn = openChildrenKey(read());
    const poll = () =>
      refreshWanted({
        force: false,
        signature: 'a',
        lastSignature: 'a',
        glancedBefore: 1,
        glancedNow: 1,
        statusMoved: false,
        openChildren: { drawn, now: openChildrenKey(read()) },
      });
    const status = () =>
      sessionStatusOf([], new Set(), outcomes, Date.now(), new Set(), new Map(), openChildCounts(read())).get('a');
    assert.equal(status(), 'subagents');
    assert.equal(poll(), false, 'the child still writes inside its hour, so the poll has nothing to do');
    vi.advanceTimersByTime(TURN_QUIET_MS);
    assert.equal(poll(), false, 'the hour has not run out yet');
    vi.advanceTimersByTime(1);
    assert.equal(poll(), true, 'the child went quiet for an hour and the poll skipped the repaint');
    assert.equal(status(), 'done');
  } finally {
    vi.useRealTimers();
  }
});

test('a replacement panel initialization repaints unchanged host state', () => {
  assert.equal(
    refreshWanted({
      force: true,
      signature: 'unchanged',
      lastSignature: 'unchanged',
      glancedBefore: 4,
      glancedNow: 4,
      statusMoved: false,
      openChildren: { drawn: '', now: '' },
    }),
    true,
  );
});

test('a mid-turn prompt reaches the card in full, with the time it was sent', () => {
  // Days back, so the hover clock carries a day name the drawn one does not. A prompt sent
  // today would make the two strings equal and the print guard below would pass on nothing.
  const sentAt = NOW - 3 * 24 * 3600_000;
  const card = toCard(
    turn({ laterPrompts: [{ stepsBefore: 0, text: 'and keep the tests green', at: sentAt }] }),
    false,
    NOW,
  );
  assert.deepEqual(
    card.laterPrompts.map((a) => a.text),
    ['and keep the tests green'],
  );
  assert.equal(card.laterPrompts[0].when, formatClock(sentAt));
  assert.ok(card.laterPrompts[0].absolute.includes(card.laterPrompts[0].when));
  assert.notEqual(card.laterPrompts[0].absolute, card.laterPrompts[0].when);

  // The hover clock gains its day name at midnight, and a day boundary must not read as the
  // card's content moving: every multi-prompt card on screen would rebuild at once.
  const print = cardPrint(card);
  assert.ok(print.includes('and keep the tests green'), 'the text a card draws is outside its content print');
  assert.ok(!print.includes(card.laterPrompts[0].absolute), 'the hover clock is inside the content print');
  // The clock drawn beside it is fixed and stays in, or a prompt that moved by a minute
  // would repaint as though the card had not changed.
  assert.ok(print.includes(card.laterPrompts[0].when), 'the drawn clock is outside the content print');
  // And so does the label, which is how the card says whether the transcript holds it yet.
  assert.ok(print.includes(CARD_ACTIONS.askedMidTurn), 'the label is outside the content print');
});

test('an unsent prompt survives the round trip through stored state', () => {
  const kept = normalizePanelState({ drafts: { 'session-1': 'rename the store module' } }).drafts;
  assert.deepEqual(
    kept,
    { 'session-1': 'rename the store module' },
    'a prompt typed and not sent was dropped on the way back out of storage',
  );
  // Newlines and the characters a reader actually types, because the box is a textarea and
  // the store is JSON: a prompt cut at its first newline reads whole and is not.
  const long = 'first line\nsecond line\n\n  indented `code` and "quotes"';
  assert.equal(normalizePanelState({ drafts: { s: long } }).drafts.s, long);
});

test('a queued prompt survives stored state with its identity, comments, and files', () => {
  const asset = {
    id: '12345678-1234-4123-8123-123456789abc',
    name: 'diagram.png',
    mime: 'image/png',
    size: 4,
    digest: '0'.repeat(64),
  };
  const queues = {
    'session-1': [
      {
        id: 'queue-1',
        text: '',
        commentIds: ['comment-1'],
        assets: [asset],
        at: 12,
        reason: 'The prompt outcome is unknown after reload.',
        delivery: {
          phase: 'recovery',
          owner: 'session-1',
          reason: 'The prompt outcome is unknown after reload.',
        },
      },
    ],
  };
  assert.deepEqual(normalizeQueuedSubmissions(queues), queues);
  assert.deepEqual(normalizePanelState({ queues }).queues, queues);

  const legacy = normalizeQueuedSubmissions({ 'session-1': ['keep this prompt'] })['session-1'][0];
  assert.match(legacy.id, /^legacy-0-/);
  assert.equal(legacy.text, 'keep this prompt');
  assert.deepEqual(legacy.commentIds, []);
  assert.deepEqual(legacy.assets, []);

  assert.deepEqual(
    normalizeQueuedSubmissions({
      'session-1': [
        { id: '../bad', text: 'escape', commentIds: [], assets: [], at: 1 },
        { id: 'empty', text: '', commentIds: [], assets: [], at: 1 },
      ],
    }),
    {},
  );
});

test('queue admission refuses a new session before stored state evicts an older one', () => {
  const submission = (id: string) => ({
    id,
    text: `prompt ${id}`,
    commentIds: [],
    assets: [],
    at: 1,
    delivery: { phase: 'queued' as const, owner: 'session-0' },
  });
  const full = Object.fromEntries(
    Array.from({ length: SESSION_LIMIT }, (_, index) => [`session-${index}`, [submission(`queue-${index}`)]]),
  );
  assert.equal(
    queuedSubmissionBookFits(full, 'new-session', [submission('new-queue')]),
    false,
    'the prospective queue book silently drops its oldest session',
  );
  assert.equal(
    queuedSubmissionBookFits(full, 'session-0', [submission('queue-0'), submission('another-queue')]),
    true,
    'adding to a session already in the book is refused at the session ceiling',
  );
});

test('an edited waiting prompt keeps its comment claim through stored state', () => {
  const claims = { 'session-1': ['comment-1', 'comment-1', 'comment-2'] };
  assert.deepEqual(normalizeDraftCommentIds(claims), {
    'session-1': ['comment-1', 'comment-2'],
  });
  assert.deepEqual(normalizePanelState({ draftCommentIds: claims }).draftCommentIds, {
    'session-1': ['comment-1', 'comment-2'],
  });
  assert.deepEqual(normalizeDraftCommentIds({ 'session-1': ['ok', 2, '', '../also-ok'] }), {
    'session-1': ['ok', '../also-ok'],
  });
});

test('a state with no drafts in it answers with no drafts rather than throwing', () => {
  // The field arrives from storage written by a version that had none, which is every
  // workspace that had the panel open before this existed.
  assert.deepEqual(normalizePanelState(null).drafts, {});
  assert.deepEqual(normalizePanelState({}).drafts, {});
  assert.deepEqual(normalizePanelState({ drafts: 'not an object' }).drafts, {});
  assert.deepEqual(normalizePanelState({ drafts: ['not', 'a', 'record'] }).drafts, {});
});

test('a stored draft that is not usable text is dropped rather than drawn', () => {
  const drafts = normalizeDrafts({
    good: 'still worth keeping',
    empty: '',
    numeric: 12,
    nothing: null,
    nested: { text: 'wrapped' },
  });
  assert.deepEqual(
    drafts,
    { good: 'still worth keeping' },
    'a draft of the wrong shape reached the box, where it would draw as [object Object]',
  );
});

test('a draft too long to store is dropped whole rather than cut', () => {
  // Cutting is the failure this refuses. A prompt restored at half its length reads like the
  // whole thing, and the next press sends the front half to the agent.
  const edge = 'x'.repeat(DRAFT_TEXT_LIMIT);
  const over = 'x'.repeat(DRAFT_TEXT_LIMIT + 1);
  assert.equal(normalizeDrafts({ s: edge }).s, edge, 'a draft at the ceiling was refused');
  assert.deepEqual(
    normalizeDrafts({ s: over }),
    {},
    'a draft over the ceiling was kept, so something cut or unbounded reached storage',
  );
});

test('the drafts are held to the same count as everything else keyed by session', () => {
  const many: Record<string, string> = {};
  for (let i = 0; i < SESSION_LIMIT + 40; i += 1) {
    many[`s${i}`] = `draft ${i}`;
  }
  const drafts = normalizeDrafts(many);
  assert.equal(
    Object.keys(drafts).length,
    SESSION_LIMIT,
    'nothing drops a session whose transcript has gone, so an unbounded record grows forever',
  );
  // The newest are what is kept, which is the end every list beside this one keeps.
  assert.equal(drafts[`s${SESSION_LIMIT + 39}`], `draft ${SESSION_LIMIT + 39}`);
  assert.equal(drafts.s0, undefined);
});

test('a state with no sent prompts in it answers with none rather than throwing', () => {
  // The field arrives from storage written by a version that had none, which is every
  // workspace that had the panel open before this existed.
  assert.deepEqual(normalizePanelState(null).sentPrompts, {});
  assert.deepEqual(normalizePanelState({}).sentPrompts, {});
  assert.deepEqual(normalizePanelState({ sentPrompts: 'not an object' }).sentPrompts, {});
  assert.deepEqual(normalizePanelState({ sentPrompts: { s: 'not a list' } }).sentPrompts, {});
});

test('a stored sent prompt that is not usable text is dropped rather than offered', () => {
  const sentPrompts = normalizeSentPrompts({
    good: ['still worth keeping', '', '   ', 12, null, { text: 'wrapped' }],
    numeric: 'not a list',
    empty: [],
  });
  assert.deepEqual(
    sentPrompts,
    { good: ['still worth keeping'] },
    'a sent prompt of the wrong shape, or one that is blank once trimmed, reached the walk',
  );
});

test('a sent prompt too long for history to ever offer is dropped whole rather than cut', () => {
  // `promptHistory` and `promptsAcross` in composerview.ts both refuse any entry over
  // `PROMPT_HISTORY_ENTRY_CHARS`, whether it came from the transcript or from a send this
  // panel made, so a longer prompt kept here could never reach Up-arrow history anyway.
  // Cutting is the other failure this refuses, the same reason a draft is refused whole: a
  // prompt restored at half its length reads like the whole thing.
  const edge = 'x'.repeat(PROMPT_HISTORY_ENTRY_CHARS);
  const over = 'x'.repeat(PROMPT_HISTORY_ENTRY_CHARS + 1);
  assert.deepEqual(normalizeSentPrompts({ s: [edge] }).s, [edge], 'a sent prompt at the ceiling was refused');
  assert.deepEqual(
    normalizeSentPrompts({ s: [over] }),
    {},
    'a sent prompt over the ceiling was kept, though history would never offer it back',
  );
});

test('a reload restores the saved sent prompts into a record of its own', () => {
  const saved = normalizePanelState({ sentPrompts: { s1: ['fix the flaky test'] } });
  const restored = restoredSentPrompts(saved);
  assert.deepEqual(restored, { s1: ['fix the flaky test'] });
  restored.s2 = ['a session the reload never saw'];
  assert.equal(
    saved.sentPrompts.s2,
    undefined,
    'the restored book aliased the saved one, so a session added in this window reached storage on its own',
  );
});

test('the sent prompts are held to the same session count as everything else keyed by session', () => {
  const many: Record<string, string[]> = {};
  for (let i = 0; i < SESSION_LIMIT + 40; i += 1) {
    many[`s${i}`] = [`prompt ${i}`];
  }
  const sentPrompts = normalizeSentPrompts(many);
  assert.equal(
    Object.keys(sentPrompts).length,
    SESSION_LIMIT,
    'nothing drops a session whose transcript has gone, so an unbounded record grows forever',
  );
  assert.deepEqual(sentPrompts[`s${SESSION_LIMIT + 39}`], [`prompt ${SESSION_LIMIT + 39}`]);
  assert.equal(sentPrompts.s0, undefined);
});

test('the labels a reader filed a session under come back the way they were left', () => {
  // Labels are words the reader chose. They are kept for the reason the notes and the drafts
  // are: nothing else can produce them again.
  assert.deepEqual(normalizePanelState({ labels: { s1: ['composer', 'release 0.4'] } }).labels, {
    s1: ['composer', 'release 0.4'],
  });
  // In the order they were applied. The rail draws the front of the list and folds the rest.
  // A record that came back sorted would move which labels a card shows.
  assert.deepEqual(normalizePanelState({ labels: { s1: ['perf', 'composer'] } }).labels.s1, ['perf', 'composer']);
  // Two states answer with none rather than throwing: a workspace nobody has filed, and one
  // stored by a build that had no labels at all.
  assert.deepEqual(normalizePanelState(null).labels, {});
  assert.deepEqual(normalizePanelState({}).labels, {});
  // A field of the wrong shape becomes no labels and takes nothing else down with it.
  assert.deepEqual(normalizePanelState({ labels: 'nope', open: ['a'] }).labels, {});
  assert.deepEqual(normalizePanelState({ labels: 'nope', open: ['a'] }).open, ['a']);
  // And inside the record, an entry that names no usable label is dropped on its own. A
  // session left with nothing takes no entry, so it reads the same as one never filed.
  assert.deepEqual(normalizePanelState({ labels: { s1: 'composer', s2: ['   ', 42], s3: ['perf'] } }).labels, {
    s3: ['perf'],
  });
});

// The order of the two rules that read the stored label record.
//
// Normalization cuts the record to its ceiling on the way through. Run first, it decides
// between a dead draft id and a real session by which entry is older, so a record over
// the ceiling drops the labels of a session the reader can still open and keeps a draft
// nothing can reach. The sweep then takes the draft out and leaves the record under the
// ceiling, with the real session gone for good.
test('a stored record over its ceiling loses its dead drafts before it loses a session', () => {
  const src: Record<string, string[]> = { oldest: ['perf'] };
  for (let i = 0; i < LABELLED_SESSION_LIMIT; i += 1) {
    src[`${DRAFT_SESSION_PREFIX}d${i}`] = ['composer'];
  }
  for (let i = 0; i < 10; i += 1) {
    src[`s${i}`] = ['docs'];
  }

  const labels = normalizePanelState(withSweptDraftLabels({ labels: src })).labels;
  assert.deepEqual(labels.oldest, ['perf'], 'the oldest real session lost its labels to draft ids nothing can reach');
  assert.deepEqual(
    Object.keys(labels).filter((id) => id.startsWith(DRAFT_SESSION_PREFIX)),
    [],
    'an abandoned draft kept its place in the record',
  );
  assert.deepEqual(
    Object.keys(labels).sort(),
    ['oldest', ...Array.from({ length: 10 }, (_, i) => `s${i}`)].sort(),
    'the record came back holding something other than the sessions that still exist',
  );

  // The wrapper leaves every other field to normalization, and hands back anything that is not
  // a label record rather than throwing on state an older version of the panel wrote.
  assert.deepEqual(withSweptDraftLabels({ showing: 's1', labels: { s1: ['perf'] } }), {
    showing: 's1',
    readerParents: {},
    labels: { s1: ['perf'] },
  });
  for (const junk of [null, undefined, 7, 'labels', [], { labels: 'perf' }, { labels: ['perf'] }]) {
    assert.deepEqual(
      withSweptDraftLabels(junk),
      junk && typeof junk === 'object' && !Array.isArray(junk) ? { ...junk, readerParents: {} } : junk,
    );
  }
});

test('labels are held to the same number of sessions as every other field the panel keeps', () => {
  // The two ceilings are one number written twice. turnlabels.ts cannot import this one.
  // This file reads that one, and a cycle between them arrives as an undefined export the
  // first time the panel loads. Nothing else holds the two together. A change to either would
  // leave labels on a different ceiling from the drafts, the pins and the watermarks beside
  // them.
  assert.equal(LABELLED_SESSION_LIMIT, SESSION_LIMIT);
});

test('the refresh signature carries external facts that can move while a parent transcript stays still', () => {
  const files = [{ file: 'a.jsonl', size: 10, mtimeMs: 1 }];
  const base = listingSignature({
    showing: null,
    files,
    threadNames: '20643:1000',
    children: 'child:10:1',
    sessionParents: '',
  });

  // The same listing twice is the same answer, or an idle workspace would repaint for ever.
  assert.equal(
    base,
    listingSignature({ showing: null, files, threadNames: '20643:1000', children: 'child:10:1', sessionParents: '' }),
  );

  // A transcript that grew, and the session shown alone, which changes what is drawn
  // with no file moving at all.
  assert.notEqual(
    base,
    listingSignature({
      showing: null,
      files: [{ file: 'a.jsonl', size: 11, mtimeMs: 1 }],
      threadNames: '20643:1000',
      children: 'child:10:1',
      sessionParents: '',
    }),
  );
  assert.notEqual(
    base,
    listingSignature({ showing: 'a', files, threadNames: '20643:1000', children: 'child:10:1', sessionParents: '' }),
  );

  // And the term with no transcript behind it. Codex names a thread into a file of its own,
  // after the rollout has stopped being written, so this is the only thing that moves when a
  // finished session is given its name.
  assert.notEqual(
    base,
    listingSignature({ showing: null, files, threadNames: '20777:1160', children: 'child:10:1', sessionParents: '' }),
    'a session was named and the panel had no reason to repaint',
  );
  assert.notEqual(
    base,
    listingSignature({ showing: null, files, threadNames: '20643:1000', children: 'child:11:2', sessionParents: '' }),
    'a child transcript grew and the panel had no reason to repaint its parent turn',
  );

  // The worker can resolve a dispatch on a later walk than the one that saw its parent grow.
  // The heading of the dispatched session changes then, and no file does. No spend source
  // moves with it, so the source offer stays still.
  const dispatched = {
    showing: null,
    files,
    threadNames: '20643:1000',
    children: 'child:10:1',
    sessionParents: 'child>parent:dispatched',
  };
  assert.notEqual(
    base,
    listingSignature(dispatched),
    'a dispatch resolved and the panel had no reason to repaint its heading',
  );
  assert.equal(
    spendSourceSignature({ ...dispatched, sessionParents: '' }),
    spendSourceSignature(dispatched),
    'a resolved dispatch offered Project cost sources again',
  );
});

test('a click a second offers Project cost sources once, not thirty times', () => {
  // The measured symptom. The source offer ran 33 times in 30 seconds and spent 394 ms in
  // `stat`, because the offer gate read the listing signature and the listing signature
  // carries the shown session. The reader clicked throughout, so the gate opened on a
  // term no spend source depends on.
  //
  // Both signatures read the same facts here, exactly as `refresh` builds them, so this
  // counts what each one would have done over one clicking minute.
  const facts = (showing: string) => ({
    showing,
    files: [{ file: 'a.jsonl', size: 10, mtimeMs: 1 }],
    threadNames: '20643:1000',
    children: 'child:10:1',
    sessionParents: '',
  });
  let lastListing = listingSignature(facts('a'));
  let lastSources = spendSourceSignature(facts('a'));
  let lastOfferAt = 0;
  let listingMoves = 0;
  let offers = 0;

  // Thirty refreshes, one a second, each one the reader selecting a different session.
  // No file grows, no child appears and nothing is renamed.
  for (let second = 1; second <= 30; second += 1) {
    const now = second * 1000;
    const next = facts(`session-${second}`);
    const listing = listingSignature(next);
    if (listing !== lastListing) {
      listingMoves += 1;
    }
    lastListing = listing;
    const sources = spendSourceSignature(next);
    const sourcesMoved = sources !== lastSources;
    lastSources = sources;
    if (projectSpendSourceOfferDue(sourcesMoved, now, lastOfferAt)) {
      lastOfferAt = now;
      offers += 1;
    }
  }

  assert.equal(listingMoves, 30, 'the panel stopped repainting when the reader selects a different session');
  assert.equal(offers, 1, 'selecting a session still offers every Project cost source, which stats the ledger');
});

test('a transcript that grows still offers Project cost sources', () => {
  // The other half of the gate. Narrowing it must not stop a real append from being indexed,
  // or a session the reader is watching would never move its cost.
  const facts = (size: number, mtimeMs: number, children: string) => ({
    showing: 'a',
    files: [{ file: 'a.jsonl', size, mtimeMs }],
    threadNames: '20643:1000',
    children,
    sessionParents: '',
  });
  let lastSources = spendSourceSignature(facts(10, 1, 'child:10:1'));
  let lastOfferAt = 0;
  let offers = 0;

  for (let second = 1; second <= 5; second += 1) {
    const now = second * 1000;
    const sources = spendSourceSignature(facts(10 + second, second, 'child:10:1'));
    const sourcesMoved = sources !== lastSources;
    lastSources = sources;
    if (projectSpendSourceOfferDue(sourcesMoved, now, lastOfferAt)) {
      lastOfferAt = now;
      offers += 1;
    }
  }
  assert.equal(offers, 5, 'an appended transcript is no longer offered to the spend index');

  // A child transcript is a spend source with no parent revision behind it, so one appearing
  // has to open the gate on its own.
  assert.notEqual(
    spendSourceSignature(facts(10, 1, 'child:10:1')),
    spendSourceSignature(facts(10, 1, 'child:10:1|child2:4:9')),
    'a new child transcript is not offered to the spend index',
  );
});

test('reader parents reject malformed cycles and retain durable missing sessions without a saved-field ceiling', () => {
  const chain = Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [`child${index}`, `child${index + 1}`]));
  const raw = { ...chain, self: 'self', a: 'b', b: 'c', c: 'a', incoming: 'a', empty: '', wrong: 3 };
  const normalized = normalizeReaderParents(raw);
  assert.deepEqual(normalized, { ...chain, incoming: 'a' });
  assert.deepEqual(normalizePanelState({ readerParents: raw }).readerParents, normalized);
  for (const invalid of [null, [], 3, 'parent']) assert.deepEqual(normalizeReaderParents(invalid), {});
  const draft = `${DRAFT_SESSION_PREFIX}parent`;
  const child = `${DRAFT_SESSION_PREFIX}child`;
  const live = { durable: draft, [child]: 'missing', kept: 'undiscovered' };
  assert.deepEqual(normalizePanelState({ readerParents: live }).readerParents, live);
  for (const labels of [undefined, null, [], 'bad', { durable: ['work'] }]) {
    const stored = normalizePanelState(withSweptDraftLabels({ readerParents: live, labels }));
    assert.deepEqual(stored.readerParents, { kept: 'undiscovered' });
    assert.equal('readerParents' in webviewPanelState(stored), false);
  }
});

test('reader parent identity follows both ends and abandonment removes incoming draft references', () => {
  const parents = { child: 'draft', draft: 'ancestor', sibling: 'ancestor' };
  const moved = remapReaderParents(parents, 'draft', 'actual');
  assert.deepEqual(moved, { child: 'actual', actual: 'ancestor', sibling: 'ancestor' });
  assert.deepEqual(abandonReaderParents(parents, 'draft'), { sibling: 'ancestor' });
  assert.deepEqual(remapReaderParents({ child: 'draft' }, 'draft', 'child'), {});
  assert.deepEqual(parents, { child: 'draft', draft: 'ancestor', sibling: 'ancestor' });
});
