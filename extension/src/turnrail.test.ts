// Session list projections, status precedence, grouping, and parent relationships.

import { test } from 'vitest';
import assert from 'node:assert';
import { matchSessions } from './domain/session-query.ts';
import {
  CHILD_CLOSE_MARGIN_MS,
  RAIL_MENU_SECTIONS,
  RAIL_WIDTH_DEFAULT,
  RAIL_WIDTH_MIN,
  agentRunAnswer,
  clampRailWidth,
  dispatchedParents,
  sessionParentEdgesAmong,
  sessionParentIndex,
  sessionParentsKey,
  sessionParentEdgeSet,
  sessionParentOf,
  groupBySession,
  hasUnsentPrompt,
  hideSessions,
  liveBackgroundCommands,
  liveOpenChildCounts,
  outcomeWithWiderChildren,
  railBuckets,
  railCardName,
  recordExits,
  railCacheMarkOf,
  railCachesOf,
  railSessions,
  railTimeSlot,
  sessionCount,
  sessionRunningSince,
  sessionStatsOf,
  sessionStatusOf,
  stableRailOrder,
  statsBySession,
  syntheticDraftRows,
  unsentBySession,
  unsentInputName,
  withPinned,
} from './turnrail.ts';
import { agentRunIn } from './transcript.ts';
import type { ClosedChild, SessionStatFacts, TurnOutcome } from './transcript.ts';
import { railStatChips, type RailStatus } from './view/rail.ts';
import { formatWhen } from './turnformat.ts';
import {
  sessionCompactionContextDetail,
  sessionCostProjection,
  sessionTurnStats,
  type SessionStatChip,
} from './turncard.ts';
import {
  bgAwaySummaryTranscript,
  bgSessionTranscript,
  bgWorkerFollowUpTranscript,
  compaction,
  resumedSdkTranscript,
  sdkFileChangeTranscript,
  sdkSlashCommandTranscript,
  turn,
} from './turnfixtures.ts';
import type { CompactionFact } from './projectspend.ts';

// Calendar arithmetic keeps day-group boundaries local to each timezone.

const bucketNow = new Date(2026, 7, 24, 15, 0).getTime();

const railAt = (at: number, over: { pinnedTop?: boolean; current?: boolean; archived?: boolean } = {}) => ({
  at,
  pinnedTop: false,
  current: false,
  archived: false,
  ...over,
});

const bucketOf = (at: number): string | undefined => railBuckets([railAt(at)], bucketNow).buckets[0]?.id;

test('groupBySession makes every session contiguous, keeping first-seen order', () => {
  const c = (sessionId: string, key: number) => ({ sessionId, key });
  // Interleaved by clock is what the sort leaves behind, and what repeats headings.
  assert.deepEqual(
    groupBySession([c('a', 1), c('b', 2), c('a', 3), c('b', 4), c('a', 5)]).map((x) => x.sessionId),
    ['a', 'a', 'a', 'b', 'b'],
  );
  assert.deepEqual(
    groupBySession([c('a', 1), c('a', 2)]).map((x) => x.key),
    [1, 2],
    'a single session keeps its order untouched',
  );
  assert.deepEqual(groupBySession([]), []);
  assert.deepEqual(
    groupBySession([c('b', 1), c('a', 2)]).map((x) => x.sessionId),
    ['b', 'a'],
    'sessions follow the order their first card appeared in, not their name',
  );
});

test('a rail card gives its time slot to waiting, running, or failed state', () => {
  // Waiting uses needs input for the visible word and accessible name.

  assert.deepEqual(railTimeSlot('waiting'), { word: 'needs input', time: false });
  // Running replaces the age slot with its status word.

  assert.deepEqual(railTimeSlot('running'), { word: 'running', time: false });
  // Failed says so and keeps the time, because when it failed is the next question.
  assert.deepEqual(railTimeSlot('failed'), { word: 'failed', time: true });
  // Done, interrupted, and stopped show only age.
  assert.deepEqual(railTimeSlot('done'), { word: null, time: true });
  assert.deepEqual(railTimeSlot('interrupted'), { word: null, time: true });
  assert.deepEqual(railTimeSlot('stopped'), { word: null, time: true });
  // A session with no knowable status wears no word, the way its card wears no colour.
  assert.deepEqual(railTimeSlot(null), { word: null, time: true });
  // Unsent input replaces age while retaining any status word.
  assert.deepEqual(railTimeSlot('done', true), { word: null, time: false });
  assert.deepEqual(railTimeSlot('failed', true), { word: 'failed', time: false });
  assert.deepEqual(railTimeSlot('running', true), { word: 'running', time: false });
  assert.deepEqual(railTimeSlot('waiting', true), { word: 'needs input', time: false });
  assert.deepEqual(railTimeSlot('subagents', false, 1), { word: '1 subagent', time: false });
  assert.deepEqual(railTimeSlot('subagents', true, 2), { word: '2 subagents', time: false });
  assert.deepEqual(railTimeSlot('background', false, null, 1), { word: '1 background command', time: false });
  assert.deepEqual(railTimeSlot('background', true, null, 2), { word: '2 background commands', time: false });
});

test('unsent input is filed by session and worded for the rail', () => {
  assert.equal(hasUnsentPrompt('  write the test  '), true);
  assert.equal(hasUnsentPrompt(' \n\t '), false);
  assert.equal(hasUnsentPrompt(null), false);

  const unsent = unsentBySession({ a: 'draft', blank: '  ', c: 'another draft' }, [
    { sessionId: 'a' },
    { sessionId: 'b' },
    { sessionId: 'b' },
    { sessionId: 'c' },
    { sessionId: '' },
  ]);
  assert.deepEqual(
    [...unsent],
    [
      ['a', { prompt: true, comments: 1 }],
      ['c', { prompt: true, comments: 1 }],
      ['b', { prompt: false, comments: 2 }],
    ],
  );
  assert.equal(unsent.has('blank'), false);
  assert.equal(unsentInputName(undefined), null);
  assert.equal(unsentInputName({ prompt: true, comments: 0 }), 'unsent prompt');
  assert.equal(unsentInputName({ prompt: false, comments: 1 }), '1 unsent comment');
  assert.equal(unsentInputName({ prompt: false, comments: 2 }), '2 unsent comments');
  assert.equal(unsentInputName({ prompt: true, comments: 2 }), 'unsent prompt and 2 unsent comments');

  const s = (id: string) => ({
    id,
    label: `Session ${id}`,
    agent: 'Claude',
    when: '2:32 PM',
    at: 4200,
    relative: '3 hours ago',
  });
  const rail = railSessions(
    [s('a'), s('b'), s('c')],
    new Map(),
    new Map(),
    new Map<string, 'running' | 'failed'>([
      ['a', 'running'],
      ['c', 'failed'],
    ]),
    new Set(['b']),
    'a',
    new Set(['c']),
    unsent,
    {},
    {},
  );
  const byId = new Map(rail.map((card) => [card.id, card]));
  assert.equal(byId.get('a')?.unsentWord, 'unsent');
  assert.equal(byId.get('a')?.unsentName, 'unsent prompt and 1 unsent comment');
  assert.equal(
    railCardName(byId.get('a')!),
    'Session a, Claude, running, unsent prompt and 1 unsent comment, 3 hours ago, showing now',
  );
  assert.equal(railCardName(byId.get('b')!), 'Session b, archived, Claude, 2 unsent comments, 3 hours ago');
  assert.equal(
    railCardName(byId.get('c')!),
    'Session c, pinned, Claude, failed, unsent prompt and 1 unsent comment, 3 hours ago',
  );
});

test('the parse cut stretches to hold every pinned session', () => {
  const s = (sessionId: string) => ({ sessionId });
  const all = [s('a'), s('b'), s('c'), s('d')];
  // The limit retains the two newest sessions. Pins add excluded visible sessions once each.
  assert.deepEqual(
    withPinned(all.slice(0, 2), all, new Set(['a', 'd'])).map((x) => x.sessionId),
    ['a', 'b', 'd'],
  );
  // No pins leaves the cut exactly as it was.
  assert.deepEqual(
    withPinned(all.slice(0, 2), all, new Set()).map((x) => x.sessionId),
    ['a', 'b'],
  );
  // Pins outside the visible pool add nothing.

  assert.deepEqual(
    withPinned(all.slice(0, 1), all.slice(0, 1), new Set(['zzz'])).map((x) => x.sessionId),
    ['a'],
  );
});

test('hiding a session takes it off the list, and pinning it brings it back', () => {
  const sessions = [{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }];
  assert.deepEqual(hideSessions(sessions, new Set()), sessions);
  assert.deepEqual(hideSessions(sessions, new Set(['b'])), [{ sessionId: 'a' }, { sessionId: 'c' }]);
  assert.deepEqual(hideSessions(sessions, new Set(['a', 'b', 'c'])), []);
  // The picker's pinned session remains available when hidden.

  assert.deepEqual(hideSessions(sessions, new Set(['b']), 'b'), sessions);
  assert.deepEqual(hideSessions(sessions, new Set(['a', 'b']), 'b'), [{ sessionId: 'b' }, { sessionId: 'c' }]);
  // An id nobody has is not an error, since the set outlives the sessions in it.
  assert.deepEqual(hideSessions(sessions, new Set(['gone'])), sessions);
});

test('hiding runs before the list is cut, so a hidden session gives up its slot', () => {
  // Hide sessions before applying the parse limit so hidden sessions consume no slots.

  const sessions = [{ sessionId: 'old' }, { sessionId: 'older' }, { sessionId: 'live' }];
  const MAX = 2;
  assert.deepEqual(hideSessions(sessions, new Set(['old', 'older'])).slice(0, MAX), [{ sessionId: 'live' }]);
  // Applying the limit first leaves no visible session in this fixture.
  assert.deepEqual(hideSessions(sessions.slice(0, MAX), new Set(['old', 'older'])), []);
});

test('a session heading says how many turns it holds', () => {
  assert.equal(sessionCount(1), '1 turn');
  assert.equal(sessionCount(2), '2 turns');
  assert.equal(sessionCount(0), '0 turns');
  assert.equal(sessionCount(12), '12 turns');
  // Turn-count wording contains no waiting or needs-input claim.

  assert.doesNotMatch(sessionCount(9), /waiting|needs/);
});

test('the rail reads a newest outcome outside the parse cut without guessing through a partial tail', () => {
  const outcome = { finished: false, error: true, interrupted: false, endedAt: 1_000 };
  // Unparsed listed sessions require metadata status outside the card list.

  const read = new Map([
    ['unparsed', outcome],
    ['partial', null],
  ]);
  assert.equal(sessionStatusOf([], new Set(), read, 1_001).get('unparsed'), 'failed');
  assert.equal(sessionStatusOf([], new Set(), read, 1_001).get('partial'), undefined);
});

test('a parsed card beats the tail outcome, and an old cached fact stops without being reread', () => {
  const outcome = { finished: false, error: false, interrupted: false, endedAt: 1_000 };
  const outcomes = new Map([
    ['read', outcome],
    ['cached', outcome],
  ]);
  assert.equal(
    sessionStatusOf(
      [{ sessionId: 'read', kind: 'turn', startedAt: 2_000, status: 'done' }],
      new Set(),
      outcomes,
      1_001,
    ).get('read'),
    'done',
  );
  assert.equal(sessionStatusOf([], new Set(), outcomes, 1_001).get('cached'), 'running');
  assert.equal(sessionStatusOf([], new Set(), outcomes, 1_000 + 60 * 60 * 1000 + 1).get('cached'), 'stopped');
  const ended = new Map([
    [
      'ended',
      {
        finished: false,
        error: false,
        interrupted: false,
        endedAt: 1_000,
        processEndedAt: 3_000,
      },
    ],
  ]);
  assert.equal(sessionStatusOf([], new Set(), ended, 1_001).get('ended'), 'stopped');
  assert.equal(
    sessionStatusOf([], new Set(['ended']), ended, 3_001, new Set(), new Map([['ended', 2_000]])).get('ended'),
    'stopped',
  );
});

test('a busy child stops answering once the record closes the turn it was pressed for', () => {
  const done = [{ sessionId: 'a', kind: 'turn', startedAt: 2_000, endedAt: 3_000, status: 'done' as const }];
  const busy = new Set(['a']);
  assert.equal(
    sessionStatusOf(done, busy, new Map(), 4_000).get('a'),
    'running',
    'a caller that cannot say when the press was made keeps the unbounded claim',
  );
  // A closed turn bounds a busy claim whose press predates that turn's end.

  assert.equal(sessionStatusOf(done, busy, new Map(), 4_000, new Set(), new Map([['a', 1_000]])).get('a'), 'done');
  // A later press keeps running state despite the earlier closed turn.

  assert.equal(sessionStatusOf(done, busy, new Map(), 4_000, new Set(), new Map([['a', 3_500]])).get('a'), 'running');
  // A request still open outranks both, because it is the action the reader can take now.
  assert.equal(
    sessionStatusOf(done, busy, new Map(), 4_000, new Set(['a']), new Map([['a', 1_000]])).get('a'),
    'waiting',
  );
});

test('the tail outcome bounds a busy claim the way a parsed card does', () => {
  const outcomes = new Map([['a', { finished: true, error: false, interrupted: false, endedAt: 3_000 }]]);
  const busy = new Set(['a']);
  assert.equal(sessionStatusOf([], busy, outcomes, 4_000, new Set(), new Map([['a', 1_000]])).get('a'), 'done');
  assert.equal(sessionStatusOf([], busy, outcomes, 4_000, new Set(), new Map([['a', 3_500]])).get('a'), 'running');
  // A turn the record leaves open closes nothing, so it bounds nothing.
  const open = new Map([['a', { finished: false, error: false, interrupted: false, endedAt: 0 }]]);
  assert.equal(sessionStatusOf([], busy, open, 4_000, new Set(), new Map([['a', 1_000]])).get('a'), 'running');
});

test('a closed turn reads subagents while a background child it left open still writes', () => {
  const hour = 60 * 60 * 1000;
  const now = 10 * hour;
  const done: TurnOutcome = {
    finished: true,
    error: false,
    interrupted: false,
    startedAt: now - 2 * hour,
    endedAt: now - hour,
    openChildren: ['live', 'unknown'],
  };
  const fresh = (_session: string, child: string) => (child === 'live' ? now - 60_000 : undefined);
  const statusFor = (
    outcome: TurnOutcome,
    writtenAt = fresh,
    exited = new Map<string, number>(),
    running = new Set<string>(),
    waiting = new Set<string>(),
  ) => {
    const outcomes = new Map([['a', outcome]]);
    const open = liveOpenChildCounts(outcomes, writtenAt, exited, now);
    return sessionStatusOf([], running, outcomes, now, waiting, new Map(), open).get('a');
  };
  assert.equal(statusFor(done), 'subagents');
  // A child with no known write time is not counted.
  assert.deepEqual(liveOpenChildCounts(new Map([['a', done]]), fresh, new Map(), now), new Map([['a', 1]]));
  assert.equal(statusFor({ ...done, openChildren: undefined }), 'done', 'no open child');
  assert.equal(
    statusFor(done, () => now - hour - 1),
    'done',
    'the child file went quiet for an hour',
  );
  assert.equal(statusFor({ ...done, processEndedAt: now - hour }), 'done', 'the process end was recorded');
  assert.equal(statusFor(done, fresh, new Map([['a', now - hour]])), 'done', 'the host process exited');
  // An exit before the newest turn began belongs to a process that turn did not run in.
  assert.equal(statusFor(done, fresh, new Map([['a', now - 3 * hour]])), 'subagents');
  assert.equal(statusFor(done, fresh, new Map(), new Set(['a'])), 'running', 'a busy main agent reads running');
  assert.equal(statusFor({ ...done, finished: false, endedAt: now - 60_000 }), 'running', 'an open turn reads running');
  assert.equal(statusFor(done, fresh, new Map(), new Set(), new Set(['a'])), 'waiting');
  const outcomes = new Map([['a', done]]);
  const open = liveOpenChildCounts(outcomes, fresh, new Map(), now);
  const rail = railSessions(
    [{ id: 'a', label: 'Session a', agent: 'Claude', when: '2:32 PM', at: now, relative: 'now' }],
    new Map(),
    new Map(),
    sessionStatusOf([], new Set(), outcomes, now, new Set(), new Map(), open),
    new Set(),
    null,
    new Set(),
    new Map(),
    {},
    {},
    {},
    {},
    new Map(),
    now,
    open,
  );
  assert.equal(rail[0].subagents, 1);
  assert.equal(railCardName(rail[0]), 'Session a, Claude, 1 subagent still running');
});

test('a closed child becomes live when new work follows its close', () => {
  const hour = 60 * 60 * 1000;
  const now = 10 * hour;
  const outcome: TurnOutcome = {
    finished: true,
    error: false,
    interrupted: false,
    startedAt: now - hour,
    endedAt: now - 120_000,
    closedChildren: [{ id: 'resumed', closedAt: now - 120_000 }],
  };
  const live = (value: TurnOutcome, workAt: number | undefined) =>
    liveOpenChildCounts(
      new Map([['a', value]]),
      () => now - 60_000,
      new Map(),
      now,
      () => workAt,
    );

  const resumed = live(outcome, now - 60_000);
  assert.deepEqual(resumed, new Map([['a', 1]]));
  assert.equal(
    sessionStatusOf([], new Set(), new Map([['a', outcome]]), now, new Set(), new Map(), resumed).get('a'),
    'subagents',
  );
  assert.deepEqual(live(outcome, now - 180_000), new Map(), 'work before the close stays closed');
  assert.deepEqual(live(outcome, undefined), new Map(), 'unknown work stays closed');
  assert.deepEqual(
    live({ ...outcome, closedChildren: ['resumed'] }, now - 60_000),
    new Map(),
    'a legacy close stays closed',
  );
  assert.deepEqual(
    live({ ...outcome, processEndedAt: now - 90_000 }, now - 60_000),
    new Map(),
    'a process end stays closed',
  );
});

// Child work within CHILD_CLOSE_MARGIN_MS does not reopen the closed child.

test('a trailing child work record after the close does not reopen it', () => {
  const hour = 60 * 60 * 1000;
  const now = 10 * hour;
  const closedAt = now - 120_000;
  const outcome: TurnOutcome = {
    finished: true,
    error: false,
    interrupted: false,
    startedAt: now - hour,
    endedAt: closedAt,
    closedChildren: [{ id: 'trailing', closedAt }],
  };
  const live = (workAt: number | undefined) =>
    liveOpenChildCounts(
      new Map([['a', outcome]]),
      () => now - 60_000,
      new Map(),
      now,
      () => workAt,
    );

  const withinMargin = live(closedAt + 80);
  assert.deepEqual(withinMargin, new Map(), 'work 80ms after the close lands inside the margin');
  assert.equal(
    sessionStatusOf([], new Set(), new Map([['a', outcome]]), now, new Set(), new Map(), withinMargin).get('a'),
    'done',
    'the rail does not draw the session as having subagents',
  );
  assert.deepEqual(live(closedAt + CHILD_CLOSE_MARGIN_MS), new Map(), 'work exactly at the close margin stays closed');
  assert.deepEqual(
    live(closedAt + CHILD_CLOSE_MARGIN_MS + 1),
    new Map([['a', 1]]),
    'work just past the close margin reopens the child',
  );
});

test('subagents and background sessions sort with the running sessions', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }];
  const order = stableRailOrder(
    rows,
    ['a', 'b', 'c', 'd', 'e'],
    new Map<string, RailStatus>([
      ['b', 'running'],
      ['c', 'done'],
      ['d', 'subagents'],
      ['e', 'background'],
    ]),
  );
  assert.deepEqual(
    order.map((row) => row.id),
    ['b', 'd', 'e', 'a', 'c'],
  );
});

// Repeated exit reports retain the first timestamp. An exit after a resume replaces it.

test('a hosted session that exits again after a resume reads its latest exit', () => {
  const exits = new Map<string, number>();
  let held = recordExits(exits, new Set(), ['claude:a'], 100);
  assert.equal(held.moved, true);
  held = recordExits(exits, held.exited, ['claude:a'], 200);
  assert.equal(held.moved, false, 'a repeated report is not a new exit');
  assert.equal(exits.get('claude:a'), 100);
  held = recordExits(exits, held.exited, [], 300);
  held = recordExits(exits, held.exited, ['claude:a'], 400);
  assert.equal(held.moved, true);
  assert.equal(exits.get('claude:a'), 400);
  const resumed: TurnOutcome = {
    finished: true,
    error: false,
    interrupted: false,
    startedAt: 350,
    endedAt: 360,
    openChildren: ['x1'],
  };
  assert.deepEqual(
    liveOpenChildCounts(new Map([['a', resumed]]), () => 390, new Map([['a', exits.get('claude:a')!]]), 400),
    new Map(),
  );
});

// Lifetime child facts supplement the tail only when both describe the same newest turn through the same end.

test('the lifetime facts add an open child the tail read cannot see', () => {
  const tail: TurnOutcome = { finished: true, error: false, interrupted: false, startedAt: 10, endedAt: 20 };
  const lifetime: TurnOutcome = { ...tail, openChildren: ['old'] };
  assert.deepEqual(outcomeWithWiderChildren(tail, lifetime)?.openChildren, ['old']);
  assert.equal(outcomeWithWiderChildren(tail, { ...lifetime, endedAt: 15 }), tail, 'a lagging lifetime read');
  assert.equal(outcomeWithWiderChildren(tail, { ...lifetime, startedAt: 5 }), tail, 'an older turn');
  assert.equal(outcomeWithWiderChildren(null, lifetime), lifetime);
  assert.deepEqual(outcomeWithWiderChildren(tail, null, { ...tail, openChildren: ['parsed'] })?.openChildren, [
    'parsed',
  ]);
  assert.equal(
    outcomeWithWiderChildren(tail, null, { ...tail, openChildren: ['parsed'], endedAt: 15 }),
    tail,
    'a lagging parsed window',
  );
  assert.deepEqual(
    outcomeWithWiderChildren(
      { ...tail, closedChildren: [{ id: 'closed', closedAt: 12 }] },
      { ...tail, closedChildren: [{ id: 'closed', closedAt: 18 }] },
    )?.closedChildren,
    [{ id: 'closed', closedAt: 18 }],
    'the latest close time survives a wider merge',
  );
});

test('closed-child merging reads identifiers in linear work while preserving source order', () => {
  let idReads = 0;
  const closedChildren = Array.from(
    { length: 1_000 },
    (_unused, index) =>
      Object.defineProperty({ closedAt: index }, 'id', {
        enumerable: true,
        get: () => {
          idReads++;
          return `child-${index}`;
        },
      }) as ClosedChild,
  );
  const outcome: TurnOutcome = {
    finished: true,
    error: false,
    interrupted: false,
    startedAt: 0,
    endedAt: 1,
    closedChildren,
  };
  const merged = outcomeWithWiderChildren(
    { ...outcome, closedChildren: closedChildren.slice(0, 250) },
    { ...outcome, closedChildren: closedChildren.slice(250, 750) },
    { ...outcome, closedChildren: closedChildren.slice(750) },
  );
  assert.deepEqual(
    merged?.closedChildren?.map((child) => (typeof child === 'string' ? child : child.id)),
    Array.from({ length: 1_000 }, (_unused, index) => `child-${index}`),
  );
  assert.ok(idReads < 5_000, `merging 1,000 distinct children read their ids ${idReads} times`);
});

test('a subagents card name ends on its hint title after labels and unread text', () => {
  const now = 10 * 60 * 60 * 1000;
  const open = new Map([['a', 2]]);
  const rail = railSessions(
    [{ id: 'a', label: 'Session a', agent: 'Claude', when: '2:32 PM', at: now, relative: 'now' }],
    new Map([['a', { count: 3, atLeast: false }]]),
    new Map([['a', now - 1_000]]),
    new Map<string, RailStatus>([['a', 'subagents']]),
    new Set(),
    'a',
    new Set(['a']),
    new Map(),
    {},
    { a: ['phase 2'] },
    {},
    {},
    new Map(),
    now,
    open,
  );
  assert.match(railCardName(rail[0]), /phase 2/);
  assert.match(
    railCardName(rail[0]),
    /, 2 subagents still running$/,
    `the card is named ${JSON.stringify(railCardName(rail[0]))}`,
  );
});

test('a background card counts its commands and names the state last', () => {
  const now = 10 * 60 * 60 * 1000;
  const rail = railSessions(
    [{ id: 'a', label: 'Session a', agent: 'Claude', when: '2:32 PM', at: now, relative: 'now' }],
    new Map(),
    new Map(),
    new Map<string, RailStatus>([['a', 'background']]),
    new Set(),
    null,
    new Set(),
    new Map(),
    {},
    {},
    {},
    {},
    new Map(),
    now,
    new Map([['a', 3]]),
    new Map([['a', 1]]),
  );
  assert.equal(rail[0].commands, 1);
  assert.equal(rail[0].subagents, null, 'the open child count belongs to the subagents state alone');
  assert.equal(railCardName(rail[0]), 'Session a, Claude, 1 background command still running');
});

test('a closed turn reads background while a command it started still runs', () => {
  const hour = 60 * 60 * 1000;
  const now = 10 * hour;
  const done: TurnOutcome = {
    finished: true,
    error: false,
    interrupted: false,
    startedAt: now - 2 * hour,
    endedAt: now - 60_000,
    backgroundCommands: [{ id: 'cmd1', startedAt: now - 120_000 }],
  };
  const statusFor = (
    outcome: TurnOutcome,
    exited = new Map<string, number>(),
    running = new Set<string>(),
    waiting = new Set<string>(),
  ) => {
    const outcomes = new Map([['a', outcome]]);
    const commands = liveBackgroundCommands(outcomes, exited, now);
    return sessionStatusOf([], running, outcomes, now, waiting, new Map(), new Map(), commands).get('a');
  };
  assert.equal(statusFor(done), 'background');
  assert.equal(statusFor({ ...done, processEndedAt: now - 30_000 }), 'done', 'the process end was recorded');
  assert.equal(statusFor(done, new Map([['a', done.startedAt!]])), 'done', 'the host process exited as the turn began');
  assert.equal(statusFor(done, new Map([['a', now - 30_000]])), 'done', 'the host process exited');
  // An exit before the newest turn began belongs to a process that turn did not run in.
  assert.equal(statusFor(done, new Map([['a', now - 3 * hour]])), 'background');
  assert.equal(statusFor(done, new Map(), new Set(['a'])), 'running', 'a busy main agent reads running');
  assert.equal(statusFor({ ...done, finished: false, endedAt: now - 60_000 }), 'running', 'an open turn reads running');
  assert.equal(statusFor(done, new Map(), new Set(), new Set(['a'])), 'waiting');
});

test('a pending request overrides running and is announced as needs input', () => {
  const statuses = sessionStatusOf(
    [{ sessionId: 'a', kind: 'turn', startedAt: 2_000, status: 'done' }],
    new Set(['a']),
    new Map(),
    2_001,
    new Set(['a']),
  );
  assert.equal(statuses.get('a'), 'waiting');
  const s = (id: string) => ({
    id,
    label: `Session ${id}`,
    agent: 'Claude',
    when: '2:32 PM',
    at: 4200,
    relative: '3 hours ago',
  });
  const rail = railSessions(
    [s('a'), s('b')],
    new Map(),
    new Map(),
    statuses,
    new Set(),
    null,
    new Set(),
    new Map(),
    {},
    {},
  );
  assert.equal(rail[0].status, 'waiting');
  // Visible waiting text and the accessible name share the needs input phrase.

  assert.equal(railTimeSlot(rail[0].status).word, 'needs input');
  assert.match(railCardName(rail[0]), /needs input/);
  assert.doesNotMatch(
    railCardName(rail[0]),
    /waiting/,
    'the name says needs input alone, so the eye and the screen reader get one phrase',
  );
});

test('a running rail card uses the earliest active turn start and never times needs input', () => {
  const now = 20_000;
  const outcomes = new Map([
    [
      'record',
      {
        finished: false,
        error: false,
        interrupted: false,
        endedAt: 15_000,
        startedAt: 10_000,
      },
    ],
    [
      'closed',
      {
        finished: true,
        error: false,
        interrupted: false,
        endedAt: 15_000,
        startedAt: 10_000,
      },
    ],
  ]);
  const starts = sessionRunningSince(
    [],
    new Set(['record', 'busy', 'closed']),
    outcomes,
    now,
    new Set(['busy']),
    new Map([
      ['record', 8_000],
      ['busy', 9_000],
      ['closed', 9_000],
    ]),
  );
  assert.deepEqual(
    [...starts],
    [['record', 8_000]],
    'a record start and a busy claim choose the earlier active turn start while needs input and closed records stay silent',
  );
});

test('rail context falls back beyond the parse cut while lifetime figures never change on selection', () => {
  const chip = (metric: SessionStatChip['metric'], compactLabel: string): SessionStatChip => ({
    metric,
    compactLabel,
    kind: 'plain',
    label: compactLabel,
    detail: compactLabel,
  });
  // Metadata supplies figures for a session outside the parse limit.

  const parsed = {
    newest: [chip('cost', '$1.00'), chip('context', '30% ctx')],
    noTotalYet: [chip('cost', '$9.00'), chip('context', '40% ctx')],
  };
  const metadata = {
    newest: [chip('cost', '$0.75')],
    second: [chip('context', '20% ctx')],
    third: [],
    outsideCut: [chip('cost', '$2.00'), chip('context', '60% ctx')],
  };
  const lifetime = {
    newest: [chip('cost', '$3.00'), chip('turns', '8 turns'), chip('cache-expiry', '2 cache expiries')],
    outsideCut: [chip('cost', '$4.00'), chip('turns', '3 turns')],
  };
  assert.deepEqual(sessionStatsOf(parsed, metadata, lifetime), {
    newest: [
      chip('cost', '$3.00'),
      chip('turns', '8 turns'),
      chip('cache-expiry', '2 cache expiries'),
      chip('context', '30% ctx'),
    ],
    noTotalYet: [chip('context', '40% ctx')],
    second: [chip('context', '20% ctx')],
    third: [],
    outsideCut: [chip('cost', '$4.00'), chip('turns', '3 turns'), chip('context', '60% ctx')],
  });
});

test('the latest indexed compaction trigger attaches to turns when current context is unavailable', () => {
  const sessionId = 'compacted';
  const parsed = statsBySession(
    [turn({ sessionId, contextTokens: 120_000, startedAt: 1_000, endedAt: 2_000 })],
    [compaction({ sessionId, at: 3_000, contextAfter: 0 })],
  );
  assert.equal(
    parsed[sessionId].some((chip) => chip.metric === 'context'),
    false,
  );
  const fact: CompactionFact = {
    ordinal: 1,
    at: 3_000,
    trigger: 'manual',
    contextBefore: 120_000,
    contextAfter: null,
    requestsAfter: 0,
    firstRequestAfter: null,
    requestUsage: {
      requests: 1,
      input: 120_000,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      cacheWrite30m: 0,
      cacheRead: 0,
      output: 2_000,
      thinking: 0,
    },
    requestModel: 'gpt-5.6-sol',
    requestProvider: 'openai',
    requestServiceTier: null,
    requestContextWindow: 272_000,
  };
  const detail = sessionCompactionContextDetail([fact]);
  assert.ok(detail);

  const projected = sessionStatsOf(
    parsed,
    {},
    {
      [sessionId]: sessionTurnStats({
        turnCount: 1,
        compactionCount: 1,
        firstTurnAt: 1_000,
        lastTurnAt: 2_000,
      }),
    },
    { [sessionId]: detail },
  );
  const turns = projected[sessionId].find((chip) => chip.metric === 'turns');
  assert.equal(turns?.compactLabel, '1 turn');
  assert.equal(turns?.detailList?.layout, 'economics');
  assert.deepEqual(
    turns?.detailList?.entries.find((entry) => entry.label === 'Latest compaction'),
    {
      label: 'Latest compaction',
      value: 'Manual',
    },
  );
  assert.match(turns?.detail ?? '', /Compactions: 1/);
  assert.match(turns?.detail ?? '', /The turn count excludes delegated work\./);
});

test('the open heading and rail use one lifetime cost and turn count', () => {
  const chip = (metric: 'cost' | 'turns' | 'context', compactLabel: string): SessionStatChip => ({
    metric,
    compactLabel,
    kind: 'plain',
    label: compactLabel,
    detail: compactLabel,
  });
  const parsed = {
    selected: [chip('cost', '$1.87'), chip('turns', '4 turns'), chip('context', '62% ctx')],
    noLifetimeCost: [chip('cost', '$0.42'), chip('context', '14% ctx')],
  };
  const metadata = { outsideCut: [chip('context', '31% ctx')] };
  const lifetimeCost: SessionStatChip = {
    ...chip('cost', '$111+'),
    detail: 'Estimated total: $111+\n\nCost by usage\n  Session rereads: $92',
    detailList: {
      heading: { label: 'Estimated total', value: '$111+' },
      entries: [{ label: 'Cost by usage', lines: ['Session rereads: $92'] }],
    },
  };
  const lifetime = {
    selected: [lifetimeCost, chip('turns', '240 turns')],
    outsideCut: [chip('cost', '$9.00'), chip('turns', '12 turns')],
  };

  const projected = sessionStatsOf(parsed, metadata, lifetime);
  assert.deepEqual(projected, {
    selected: [lifetimeCost, chip('turns', '240 turns'), chip('context', '62% ctx')],
    noLifetimeCost: [chip('context', '14% ctx')],
    outsideCut: [chip('cost', '$9.00'), chip('turns', '12 turns'), chip('context', '31% ctx')],
  });
  assert.equal(
    projected.selected[1].compactLabel,
    '240 turns',
    'the parsed-window count replaced the lifetime count on the open session',
  );
  assert.equal(
    projected.selected[0],
    lifetimeCost,
    'projecting the lifetime chip dropped or rebuilt the shared heading and rail detail',
  );
});

test('a rail width is clamped through one rule, whatever shape it arrives in', () => {
  // Width normalization defaults non-finite values, rounds finite numbers, and enforces the minimum width.

  assert.equal(clampRailWidth(undefined), RAIL_WIDTH_DEFAULT);
  assert.equal(clampRailWidth('220'), RAIL_WIDTH_DEFAULT);
  assert.equal(clampRailWidth(NaN), RAIL_WIDTH_DEFAULT);
  assert.equal(clampRailWidth(Infinity), RAIL_WIDTH_DEFAULT);
  assert.equal(clampRailWidth(10), RAIL_WIDTH_MIN);
  assert.equal(clampRailWidth(160), 160);
  assert.equal(clampRailWidth(219.6), 220);
  assert.equal(clampRailWidth(480), 480);
  assert.equal(clampRailWidth(481), 481);
});

test('rail activity updates do not move existing sessions and new ones join at the end', () => {
  const row = (id: string) => ({ id, value: `row ${id}` });
  const quiet = new Map();

  // The first list retains incoming order even with only one session.

  const first = stableRailOrder([row('a')], [], quiet);
  assert.deepEqual(
    first.map((session) => session.id),
    ['a'],
  );

  // The next refresh arrives newest activity first. Existing sessions keep the order
  // the reader saw, while both newly discovered sessions append in their incoming order.
  const second = stableRailOrder(
    [row('c'), row('b'), row('a')],
    first.map((session) => session.id),
    quiet,
  );
  assert.deepEqual(
    second.map((session) => session.id),
    ['a', 'c', 'b'],
  );

  // Activity can reverse every incoming row without moving any card already present.
  const noisy = stableRailOrder(
    [row('b'), row('a'), row('c')],
    second.map((session) => session.id),
    quiet,
  );
  assert.deepEqual(
    noisy.map((session) => session.id),
    ['a', 'c', 'b'],
  );
  assert.equal(noisy[0].value, 'row a', 'the stable order keeps an old row instead of its current data');

  // A returning removed session appends after the sessions that stayed.

  const withoutC = stableRailOrder(
    [row('b'), row('a')],
    noisy.map((session) => session.id),
    quiet,
  );
  assert.deepEqual(
    withoutC.map((session) => session.id),
    ['a', 'b'],
  );
  const returned = stableRailOrder(
    [row('c'), row('b'), row('a')],
    withoutC.map((session) => session.id),
    quiet,
  );
  assert.deepEqual(
    returned.map((session) => session.id),
    ['a', 'b', 'c'],
  );
});

test('running sessions rise once and keep their order, including among pinned cards', () => {
  const row = (id: string) => ({
    id,
    label: `Session ${id}`,
    agent: 'Claude',
    when: '2:32 PM',
    at: 4200,
    relative: '3 hours ago',
  });
  const statuses = (...running: string[]) => new Map(running.map((id) => [id, 'running'] as const));
  const ids = (sessions: readonly { id: string }[]) => sessions.map((session) => session.id);
  const source = [row('a'), row('b'), row('c'), row('d')];

  const first = stableRailOrder(source, [], statuses());
  const bRunning = stableRailOrder(source, ids(first), statuses('b'));
  assert.deepEqual(ids(bRunning), ['b', 'a', 'c', 'd'], 'a session that starts running stays below inactive sessions');

  // New running sessions follow existing running sessions without later activity reordering them.

  const bcRunning = stableRailOrder(source, ids(bRunning), statuses('b', 'c'));
  assert.deepEqual(ids(bcRunning), ['b', 'c', 'a', 'd']);
  const noisy = stableRailOrder([...source].reverse(), ids(bcRunning), statuses('b', 'c'));
  assert.deepEqual(ids(noisy), ['b', 'c', 'a', 'd']);
  const withE = stableRailOrder([row('e'), ...source], ids(noisy), statuses('b', 'c', 'e'));
  assert.deepEqual(ids(withE), ['b', 'c', 'e', 'a', 'd']);

  // Pinned grouping remains outermost. Running pinned sessions retain their order ahead of inactive pins.

  const pinned = new Set(['a', 'c', 'e']);
  const rail = railSessions(
    withE,
    new Map(),
    new Map(),
    statuses('b', 'c', 'e'),
    new Set(),
    null,
    pinned,
    new Map(),
    {},
    {},
  );
  assert.deepEqual(ids(rail), ['c', 'e', 'a', 'b', 'd']);
});

test('waiting sessions remain in the stable active group', () => {
  const row = (id: string) => ({ id });
  const first = stableRailOrder([row('a'), row('b'), row('c')], [], new Map());
  const active = stableRailOrder(
    [row('a'), row('b'), row('c')],
    first.map((one) => one.id),
    new Map([
      ['b', 'running' as const],
      ['c', 'waiting' as const],
    ]),
  );
  assert.deepEqual(
    active.map((one) => one.id),
    ['b', 'c', 'a'],
  );
});

test('a rail card carries its count as a figure, and marks unread only where it can count', () => {
  const s = (id: string) => ({
    id,
    label: `Session ${id}`,
    agent: 'Claude',
    when: '2:32 PM',
    at: 4200,
    relative: '3 hours ago',
  });
  // Three new: the pill draws the figure, and the dot and the bold name follow the flag.
  const rail = railSessions(
    [s('a'), s('b'), s('c')],
    new Map([
      ['a', { count: 3, atLeast: false }],
      ['b', { count: 0, atLeast: false }],
    ]),
    new Map([
      ['a', 4000],
      ['b', 3000],
    ]),
    new Map(),
    new Set(),
    null,
    new Set(),
    new Map(),
    {},
    {},
  );
  assert.equal(rail[0].newCount, 3);
  assert.equal(rail[0].unread, true);
  // A known zero draws no unread count.
  assert.equal(rail[1].newCount, null);
  assert.equal(rail[1].unread, false);
  // Never parsed: the count is not knowable, so the card makes no unread claim either.
  assert.equal(rail[2].newCount, null);
  assert.equal(rail[2].unread, false);
  // Accessible wording retains the same unread count.
  assert.equal(rail[0].indicator, '3 new');
  assert.equal(railCardName(rail[0]), 'Session a, Claude, 3 hours ago, 3 new');
  assert.equal(railCardName(rail[1]), 'Session b, Claude, 3 hours ago, nothing new');
});

test('rail cards project cost, turns, then current context and omit missing figures', () => {
  const s = (id: string) => ({
    id,
    label: `Session ${id}`,
    agent: 'Claude',
    when: '2:32 PM',
    at: 4200,
    relative: '3 hours ago',
  });
  const chip = (metric: SessionStatChip['metric'], compactLabel: string, partialDetail?: string): SessionStatChip => ({
    metric,
    compactLabel,
    kind: 'plain',
    label: compactLabel,
    detail: partialDetail ?? '',
    partialDetail,
  });
  const context = { ...chip('context', '62% ctx'), level: 'filling' as const };
  const stats = {
    // Deliberately not in display order. The rail owns its fixed projection.
    a: [
      chip('files', '7 files'),
      context,
      chip('turns', '8 turns'),
      chip('cache-expiry', '2 cache expiries'),
      chip(
        'cost',
        '$1.87+',
        'Cost unavailable for unlisted-model · provider not recorded: reliable list-price estimate unavailable. Some usage could not be priced, so the estimated total may be low.',
      ),
      chip('commits', '1 commit'),
    ],
    b: [chip('context', '14% ctx')],
    c: [chip('turns', '2 turns'), chip('cost', '$2.00')],
  };
  const rail = railSessions(
    [s('a'), s('b'), s('c')],
    new Map(),
    new Map(),
    new Map(),
    new Set(),
    null,
    new Set(),
    new Map(),
    stats,
    {},
  );

  assert.deepEqual(
    railStatChips(stats.a).map((stat) => [stat.metric, stat.compactLabel]),
    [
      ['cost', '$1.87+'],
      ['turns', '8 turns'],
      ['context', '62% ctx'],
    ],
  );
  assert.equal(railStatChips(stats.a)[2].level, 'filling', 'the context tone did not reach the rail');
  assert.ok(
    !railStatChips(stats.a).some((stat) => stat.metric === 'cache-expiry'),
    'the session-only cache-expiry figure leaked onto the Rail card',
  );
  assert.match(
    railCardName(rail[0]),
    /whole session cost \$1\.87\+, Cost unavailable for unlisted-model · provider not recorded: reliable list-price estimate unavailable\. Some usage could not be priced, so the estimated total may be low, 8 turns, current context 62% ctx/,
  );
  assert.deepEqual(
    railStatChips(stats.b).map((stat) => stat.metric),
    ['context'],
  );
  assert.match(railCardName(rail[1]), /current context 14% ctx/);
  assert.doesNotMatch(railCardName(rail[1]), /whole session cost|turns/);
  assert.deepEqual(
    railStatChips(stats.c).map((stat) => [stat.metric, stat.compactLabel]),
    [
      ['cost', '$2.00'],
      ['turns', '2 turns'],
    ],
  );
  assert.match(railCardName(rail[2]), /whole session cost \$2\.00, 2 turns/);
  assert.doesNotMatch(railCardName(rail[2]), /undefined|Cost unavailable/);
});

test('a rail card keeps warning metadata, full detail, and every condition in its name', () => {
  const s = { id: 'a', label: 'Session a', agent: 'Claude', when: '2:32 PM', at: 4200, relative: '3 hours ago' };
  const projection = sessionCostProjection([
    {
      role: 'main',
      model: 'claude-sonnet-5',
      provider: null,
      contextWindow: null,
      usage: {
        requests: 5,
        input: 0,
        cacheWrite1h: 2_000_000,
        cacheWrite5m: 0,
        cacheRead: 100_000,
        output: 0,
        thinking: 0,
      },
    },
  ]);
  const [card] = railSessions(
    [s],
    new Map(),
    new Map(),
    new Map(),
    new Set(),
    null,
    new Set(),
    new Map(),
    { a: projection.stats },
    {},
    {},
    { a: projection.total },
  );
  const cost = railStatChips(projection.stats).find((chip) => chip.metric === 'cost')!;
  assert.equal(cost.warnings?.length, 1);
  assert.match(
    cost.detail,
    /Main agent · sonnet-5: \$8\.02\n  Low cache reuse in this session: \$8\.00 of \$8\.02 went to cache writes\n  Cached input reads: \$0\.02 \(5% cached · 5 requests · 420k avg input\)/,
  );
  assert.match(railCardName(card), /whole session cost \$8\.02, Low cache reuse in this session/);
});

test('a rail cache mark counts down a fast session where the model publishes a fast rate', () => {
  const requestAt = 1_000_000;
  const newest = (model: string, serviceTier: string): SessionStatFacts => ({
    turns: [
      {
        startedAt: requestAt,
        endedAt: requestAt,
        finished: true,
        error: false,
        model,
        provider: null,
        usage: { input: 1, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
        contextTokens: 100_000,
        contextWindow: 1_000_000,
        contextRequest: {
          at: requestAt,
          lifetime: '1h',
          inferenceClass: null,
          serviceTier,
          readBack: false,
          outputTokens: 40,
        },
        childSpendPartial: false,
      },
    ],
    compactions: [],
  });
  assert.deepEqual(railCacheMarkOf(newest('claude-opus-5', 'fast'), requestAt), {
    expiresAt: requestAt + 58.5 * 60_000,
    nearlyGoneAt: requestAt + 43.5 * 60_000,
  });
  assert.equal(railCacheMarkOf(newest('claude-opus-4-7', 'fast'), requestAt), null, 'Opus 4.7 has no fast rate');
  assert.equal(railCacheMarkOf(newest('claude-opus-5', 'turbo'), requestAt), null, 'a speed with no published rate');
});

test('a rail cache mark follows the newest priced request, then disappears at expiry', () => {
  const requestAt = 1_000_000;
  const facts: SessionStatFacts = {
    turns: [
      {
        startedAt: requestAt,
        endedAt: requestAt,
        finished: true,
        error: false,
        model: 'claude-opus-5',
        provider: null,
        usage: { input: 1, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
        contextTokens: 300_000,
        contextWindow: 1_000_000,
        contextRequest: {
          at: requestAt,
          lifetime: '1h',
          inferenceClass: null,
          serviceTier: null,
          readBack: false,
          outputTokens: 40,
        },
        childSpendPartial: false,
      },
    ],
    compactions: [],
  };
  assert.deepEqual(railCacheMarkOf(facts, requestAt + 44 * 60_000), {
    expiresAt: requestAt + 58.5 * 60_000,
    nearlyGoneAt: requestAt + 43.5 * 60_000,
  });
  assert.equal(
    railCacheMarkOf(facts, requestAt + 58.5 * 60_000),
    null,
    'an expired cache would leave a warm mark beside a session that must pay a write again',
  );
  assert.equal(railCacheMarkOf({ ...facts, turns: [{ ...facts.turns[0], contextRequest: null }] }, requestAt), null);
  assert.deepEqual(
    railCacheMarkOf({ ...facts, turns: [{ ...facts.turns[0], finished: false }] }, requestAt),
    {
      expiresAt: requestAt + 58.5 * 60_000,
      nearlyGoneAt: requestAt + 43.5 * 60_000,
    },
    'the warm cache mark disappeared while the newest turn was running',
  );
  assert.deepEqual(
    railCacheMarkOf(
      {
        ...facts,
        turns: [
          {
            ...facts.turns[0],
            model: 'gpt-5.6-sol',
            provider: 'openai',
            contextRequest: { ...facts.turns[0].contextRequest!, lifetime: null },
          },
        ],
      },
      requestAt,
    ),
    {
      expiresAt: requestAt + 28.5 * 60_000,
      nearlyGoneAt: requestAt + 21 * 60_000,
    },
    'a cache lifetime absent from the request loses the rail mark despite the model documenting one',
  );
  assert.equal(railCacheMarkOf({ ...facts, turns: [{ ...facts.turns[0], model: 'unpriced-model' }] }, requestAt), null);
  assert.equal(
    railCacheMarkOf(
      {
        ...facts,
        turns: [
          {
            ...facts.turns[0],
            contextRequest: { ...facts.turns[0].contextRequest!, lifetime: '5m' },
          },
        ],
      },
      requestAt,
    )?.nearlyGoneAt,
    null,
    'a 75-second final quarter says more about the clock error than about the cache',
  );
  assert.equal(
    railCacheMarkOf(
      { ...facts, compactions: [{ at: requestAt + 1, contextAfter: 3, trigger: 'manual', model: null }] },
      requestAt,
    ),
    null,
  );
});

test('a rail cache mark keeps the previous request until a new turn reports one', () => {
  const requestAt = 1_000_000;
  const priced: SessionStatFacts['turns'][number] = {
    startedAt: requestAt,
    endedAt: requestAt,
    finished: true,
    error: false,
    model: 'claude-opus-5',
    provider: null,
    usage: { input: 1, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
    contextTokens: 300_000,
    contextWindow: 1_000_000,
    contextRequest: {
      at: requestAt,
      lifetime: '1h',
      inferenceClass: null,
      serviceTier: null,
      readBack: false,
      outputTokens: 40,
    },
    childSpendPartial: false,
  };
  const pending = {
    ...priced,
    startedAt: requestAt + 60_000,
    endedAt: requestAt + 60_000,
    finished: false,
    contextTokens: 0,
    contextRequest: null,
  };
  const failed = { ...pending, startedAt: requestAt + 1, endedAt: requestAt + 1, finished: true, error: true };
  const warm = railCacheMarkOf({ turns: [priced], compactions: [] }, requestAt);
  assert.ok(warm);
  assert.deepEqual(
    railCacheMarkOf({ turns: [pending, priced], compactions: [] }, requestAt),
    warm,
    'the warm mark left at the new prompt and returned with its first response',
  );
  assert.equal(
    railCacheMarkOf({ turns: [priced, failed, pending], compactions: [] }, requestAt),
    null,
    'a failed turn between the priced request and the new prompt kept the mark',
  );
  assert.equal(
    railCacheMarkOf(
      {
        turns: [priced, pending],
        compactions: [{ at: requestAt + 1, contextAfter: 3, trigger: 'manual', model: null }],
      },
      requestAt,
    ),
    null,
    'a compaction after the kept request kept the mark',
  );
});

test('a parsed cache mark survives when bounded metadata cannot recover a complete turn', () => {
  const warm = { expiresAt: 8_000_000, nearlyGoneAt: 7_000_000 };
  const revision = { mtimeMs: 10, size: 20 };
  assert.deepEqual(
    railCachesOf({ selected: { mark: warm, ...revision } }, { selected: null, unparsed: warm }, { selected: null }),
    {
      selected: warm,
      unparsed: warm,
    },
  );
  assert.deepEqual(
    railCachesOf({ selected: { mark: null, ...revision } }, { selected: warm }, { selected: revision }),
    { selected: null },
    'parsed compaction evidence did not replace a stale metadata mark',
  );
  for (const older of [
    { mtimeMs: 10, size: 20 },
    { mtimeMs: 9, size: 20 },
    { mtimeMs: 10, size: 10 },
  ]) {
    assert.deepEqual(
      railCachesOf({ selected: { mark: warm, ...revision } }, { selected: null }, { selected: older }),
      { selected: warm },
      'a metadata read no newer than the parsed read replaced its mark',
    );
  }
  for (const newer of [
    { mtimeMs: 11, size: 20 },
    { mtimeMs: 10, size: 30 },
  ]) {
    assert.deepEqual(
      railCachesOf({ selected: { mark: warm, ...revision } }, { selected: null }, { selected: newer }),
      { selected: null },
      'facts read at a newer revision did not replace the parsed mark',
    );
  }
});

test('a replaced, shorter transcript orders the two cache reads by write time', () => {
  const warm = { expiresAt: 8_000_000, nearlyGoneAt: 7_000_000 };
  const replaced = { mtimeMs: 10, size: 300_000 };
  const replacement = { mtimeMs: 20, size: 10_000 };
  assert.deepEqual(
    railCachesOf({ selected: { mark: null, ...replacement } }, { selected: warm }, { selected: replaced }),
    { selected: null },
    'a warm mark read from the replaced transcript hid the failed turn of its replacement',
  );
  assert.deepEqual(
    railCachesOf({ selected: { mark: warm, ...replaced } }, { selected: null }, { selected: replacement }),
    { selected: null },
    'the parsed mark of the replaced transcript hid a failure read from its replacement',
  );
});

function railCacheRefreshFacts() {
  const requestAt = 1_000_000;
  const warmFacts: SessionStatFacts = {
    turns: [
      {
        startedAt: requestAt,
        endedAt: requestAt,
        finished: true,
        error: false,
        model: 'claude-opus-5',
        provider: null,
        usage: { input: 1, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
        contextTokens: 300_000,
        contextWindow: 1_000_000,
        contextRequest: {
          at: requestAt,
          lifetime: '1h',
          inferenceClass: null,
          serviceTier: null,
          readBack: false,
          outputTokens: 40,
        },
        childSpendPartial: false,
      },
    ],
    compactions: [],
  };
  const warm = railCacheMarkOf(warmFacts, requestAt);
  const compacted = railCacheMarkOf(
    {
      ...warmFacts,
      compactions: [{ at: requestAt + 1, contextAfter: 3, trigger: 'manual', model: null }],
    },
    requestAt,
  );
  return {
    warm,
    compacted,
    firstRevision: { mtimeMs: 10, size: 20 },
    secondRevision: { mtimeMs: 11, size: 30 },
  };
}

test('after an append, current warm metadata replaces a stale parsed null before the next parse', () => {
  const { warm, compacted, firstRevision, secondRevision } = railCacheRefreshFacts();
  assert.deepEqual(
    railCachesOf({ selected: { mark: compacted, ...firstRevision } }, { selected: null }, { selected: firstRevision }),
    {
      selected: null,
    },
  );
  assert.deepEqual(
    railCachesOf({ selected: { mark: compacted, ...firstRevision } }, { selected: warm }, { selected: secondRevision }),
    {
      selected: warm,
    },
    'a parsed null from an older compaction hid the current warm metadata mark',
  );
});

test('after an append, current metadata compaction replaces a stale parsed warm mark before the next parse', () => {
  const { warm, compacted, firstRevision, secondRevision } = railCacheRefreshFacts();
  assert.deepEqual(
    railCachesOf({ selected: { mark: warm, ...firstRevision } }, { selected: warm }, { selected: firstRevision }),
    {
      selected: warm,
    },
  );
  assert.deepEqual(
    railCachesOf({ selected: { mark: warm, ...firstRevision } }, { selected: compacted }, { selected: secondRevision }),
    {
      selected: null,
    },
    'a parsed warm mark from an older revision hid the current metadata compaction',
  );
});

test('a rail card leaves its changing cache state to the browser after its age', () => {
  const s = (id: string) => ({
    id,
    label: `Session ${id}`,
    agent: 'Claude',
    when: '2:32 PM',
    at: 4_200,
    relative: '3 hours ago',
  });
  const cache = { expiresAt: Date.now() + 60 * 60_000, nearlyGoneAt: null };
  const [card] = railSessions(
    [s('a')],
    new Map(),
    new Map(),
    new Map(),
    new Set(),
    null,
    new Set(),
    new Map(),
    {},
    {},
    { a: cache },
  );
  assert.equal(card.cache, cache);
  assert.equal(
    railCardName(card),
    'Session a, Claude, 3 hours ago',
    'the host name carries a cache phrase that becomes stale before the browser redraws it',
  );
  assert.equal(card.nameBeforeAge, 'Claude', 'the name no longer rides inside nameBeforeAge; railCardName prepends it');
  assert.equal(card.nameAfterAge, '');
});

test('a rail card carries the number behind its cost chip, so several can be added', () => {
  const s = (id: string) => ({
    id,
    label: `Session ${id}`,
    agent: 'Claude',
    when: '2:32 PM',
    at: 4200,
    relative: '3 hours ago',
  });
  const cost = (compactLabel: string, dollars: number, partial: boolean): SessionStatChip => ({
    metric: 'cost',
    compactLabel,
    kind: 'plain',
    label: compactLabel,
    detail: '',
    dollars,
    partial,
  });
  const stats = {
    a: [cost('$1.87', 1.87, false)],
    b: [cost('$4.20+', 4.2, true)],
    // A session nothing priced carries no cost chip at all.
    c: [{ metric: 'context' as const, compactLabel: '14% ctx', kind: 'plain' as const, label: '14% ctx', detail: '' }],
  };
  const rail = railSessions(
    [s('a'), s('b'), s('c')],
    new Map(),
    new Map(),
    new Map(),
    new Set(),
    null,
    new Set(),
    new Map(),
    stats,
    {},
  );

  // A whole figure travels as a number, so the heading adds it rather than parsing `$1.87`.
  assert.deepEqual([rail[0].costDollars, rail[0].costAtLeast], [1.87, false]);
  // A floor says so, and one part the index left unpriced makes the whole sum a floor.
  assert.deepEqual([rail[1].costDollars, rail[1].costAtLeast], [4.2, true]);
  // An absent cost has null dollars without a lower-bound claim.

  assert.deepEqual([rail[2].costDollars, rail[2].costAtLeast], [null, false]);
});

test('the rail keeps an exact zero cost distinct from a missing cost', () => {
  const s = (id: string) => ({
    id,
    label: `Session ${id}`,
    agent: 'Claude',
    when: '2:32 PM',
    at: 4200,
    relative: '3 hours ago',
  });
  const zero = sessionCostProjection([
    {
      model: null,
      provider: null,
      contextWindow: null,
      recordedCost: 0,
      costBasis: 'list',
      usage: { input: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
    },
  ]);
  const rail = railSessions(
    [s('zero'), s('missing')],
    new Map(),
    new Map(),
    new Map(),
    new Set(),
    null,
    new Set(),
    new Map(),
    {},
    {},
    {},
    { zero: zero.total },
  );

  assert.deepEqual(zero.stats, []);
  assert.equal(
    railStatChips(zero.stats).some((chip) => chip.metric === 'cost'),
    false,
  );
  assert.deepEqual([rail[0].costDollars, rail[0].costAtLeast], [0, false]);
  assert.deepEqual([rail[1].costDollars, rail[1].costAtLeast], [null, false]);
  assert.deepEqual(
    matchSessions(rail, 'cost:<5.43').map((card) => card.id),
    ['zero'],
  );
});

test('the rail carries the exact cache-expiry return count, keeping zero distinct from unavailable', () => {
  const s = (id: string) => ({
    id,
    label: `Session ${id}`,
    agent: 'Claude',
    when: '2:32 PM',
    at: 4200,
    relative: '3 hours ago',
  });
  const buildRail = (cacheExpiryById: Readonly<Record<string, { count: number; atLeast: boolean } | null>>) =>
    railSessions(
      [s('many'), s('zero'), s('unindexed'), s('unavailable'), s('floor')],
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      null,
      new Set(),
      new Map(),
      {},
      {},
      {},
      {},
      new Map(),
      undefined,
      new Map(),
      new Map(),
      cacheExpiryById,
    );
  const rail = buildRail({
    many: { count: 3, atLeast: false },
    zero: { count: 0, atLeast: false },
    unavailable: null,
    floor: { count: 1, atLeast: true },
  });
  const byId = Object.fromEntries(rail.map((card) => [card.id, [card.cacheExpiryCount, card.cacheExpiryAtLeast]]));
  // Recorded zero stays zero. Unindexed and unavailable counts stay null. Lower bounds retain their count and cacheExpiryAtLeast flag.

  assert.deepEqual(byId, {
    many: [3, false],
    zero: [0, false],
    unindexed: [null, false],
    unavailable: [null, false],
    floor: [1, true],
  });
  assert.deepEqual(
    matchSessions(rail, 'cache-expiry:>0').map((card) => card.id),
    ['many', 'floor'],
  );
  assert.deepEqual(
    matchSessions(rail, 'cache-expiry:<1').map((card) => card.id),
    ['zero'],
  );
  // Lower bounds cannot match less-than comparisons. Exact zero can match them.

  assert.deepEqual(
    matchSessions(rail, 'cache-expiry:<2').map((card) => card.id),
    ['zero'],
  );

  // Updated indexed facts change query matches without changing the query text.

  const before = buildRail({});
  assert.deepEqual(matchSessions(before, 'cache-expiry:>0'), []);
  const after = buildRail({ many: { count: 3, atLeast: false } });
  assert.deepEqual(
    matchSessions(after, 'cache-expiry:>0').map((card) => card.id),
    ['many'],
  );
});

test('a rail card shows the labels it has room for, counts the rest, and says all of them', () => {
  const s = (id: string) => ({
    id,
    label: `Session ${id}`,
    agent: 'Claude',
    when: '2:32 PM',
    at: 4200,
    relative: '3 hours ago',
  });
  const labels = { a: ['composer', 'release 0.4', 'perf'], b: ['release 0.4'] };
  const rail = railSessions(
    [s('a'), s('b'), s('c')],
    new Map(),
    new Map(),
    new Map(),
    new Set(),
    'a',
    new Set(),
    new Map(),
    {},
    labels,
  );

  // Visible labels keep application order and fold the remainder into a count.

  assert.deepEqual(rail[0].labelChips, ['composer', 'release 0.4']);
  assert.equal(rail[0].labelsMore, '+1');
  // The full label list supplies filtering and the session heading independently of the row's display limit.

  assert.deepEqual(rail[0].labels, ['composer', 'release 0.4', 'perf']);
  // The fold count carries the names it hides.

  assert.equal(rail[0].labelsMoreName, 'perf');
  // The accessible name ends with every label so later comma-separated fields cannot read as more labels.

  assert.equal(
    railCardName(rail[0]),
    'Session a, Claude, 3 hours ago, showing now, labelled composer, release 0.4, perf',
  );
  // Labels that fit produce no fold count or hidden-label name.

  assert.deepEqual(rail[1].labelChips, ['release 0.4']);
  assert.deepEqual(rail[1].labels, ['release 0.4']);
  assert.equal(rail[1].labelsMore, null);
  assert.equal(rail[1].labelsMoreName, null, 'a card that folded nothing named something to hide');
  assert.equal(railCardName(rail[1]), 'Session b, Claude, 3 hours ago, labelled release 0.4');
  // Unlabelled sessions omit label wording.

  assert.deepEqual(rail[2].labelChips, []);
  assert.deepEqual(rail[2].labels, []);
  assert.equal(rail[2].labelsMore, null);
  assert.equal(rail[2].labelsMoreName, null);
  assert.doesNotMatch(railCardName(rail[2]), /labelled/);
});

test('partial zero attention retains uncertainty through rail names, menus and queries', () => {
  const rows = railSessions(
    [{ id: 'partial', label: 'Partial', agent: 'Codex', when: 'noon', at: 10, relative: 'now' }],
    new Map([['partial', { count: 0, atLeast: true }]]),
    new Map([['partial', 10]]),
    new Map(),
    new Set(),
    null,
    new Set(),
    new Map(),
    {},
    {},
  );
  assert.equal(rows[0].indicator, null);
  assert.equal(rows[0].unread, null);
  assert.match(railCardName(rows[0]), /new turns unknown/);
  assert.doesNotMatch(railCardName(rows[0]), /nothing new/);
  assert.equal(rows[0].menuSection, RAIL_MENU_SECTIONS.unread);
  for (const query of ['is:read', 'is:unread', '-is:read', '-is:unread'])
    assert.deepEqual(matchSessions(rows, query), []);
  for (const query of ['is:needsyou', '-is:needsyou'])
    assert.deepEqual(matchSessions([{ ...rows[0], active: true }], query), []);
  rows[0].unread = false;
  assert.deepEqual(matchSessions(rows, 'is:read'), rows);
});

test('a rail card names the read entry its session can take, and none where it cannot', () => {
  const s = (id: string) => ({
    id,
    label: `Session ${id}`,
    agent: 'Claude',
    when: '2:32 PM',
    at: 4200,
    relative: '3 hours ago',
  });
  // Menu sections distinguish unread, read, and unparsed sessions. The unparsed session has no newest turn timestamp.

  const newest = new Map([
    ['a', 4000],
    ['b', 3000],
  ]);
  const rail = railSessions(
    [s('a'), s('b'), s('c')],
    new Map([
      ['a', { count: 3, atLeast: false }],
      ['b', { count: 0, atLeast: false }],
    ]),
    newest,
    new Map(),
    new Set(),
    null,
    new Set(),
    new Map(),
    {},
    {},
  );
  assert.equal(rail[0].menuSection, RAIL_MENU_SECTIONS.unread);
  assert.equal(rail[0].menuSection, 'arcRailUnread');
  assert.equal(rail[1].menuSection, RAIL_MENU_SECTIONS.read);
  assert.equal(rail[1].menuSection, 'arcRailRead');
  // A session with no newest turn gets label actions but no read-state action.

  assert.equal(rail[2].menuSection, RAIL_MENU_SECTIONS.plain);
  assert.equal(rail[2].menuSection, 'arcRail');
  // The three names are distinct, or one entry would appear on two states at once.
  assert.equal(
    new Set(Object.values(RAIL_MENU_SECTIONS)).size,
    Object.keys(RAIL_MENU_SECTIONS).length,
    'two sections share a name, so an entry written for one is offered on the other',
  );

  // The newest parsed turn timestamp supplies read actions even when that session has no drawn turn card.

  assert.equal(rail[0].newestTurnAt, 4000);
  assert.equal(rail[1].newestTurnAt, 3000);
  assert.equal(rail[2].newestTurnAt, null);
  // The plain menu section corresponds exactly to a missing newest-turn timestamp.

  for (const card of rail) {
    assert.equal(
      card.menuSection === RAIL_MENU_SECTIONS.plain,
      card.newestTurnAt === null,
      `${card.id} offers an entry with no turn to mark, or holds a turn nobody can mark`,
    );
  }
});

test('a rail bucket boundary is local midnight, not a count of hours back', () => {
  // The minute before local midnight belongs to yesterday and the minute after belongs to today.

  assert.equal(bucketOf(new Date(2026, 7, 24, 0, 1).getTime()), 'today');
  assert.equal(bucketOf(new Date(2026, 7, 23, 23, 59).getTime()), 'yesterday');
  // Yesterday starts at its local midnight. The previous minute belongs to Last 7 days.
  assert.equal(bucketOf(new Date(2026, 7, 23, 0, 0).getTime()), 'yesterday');
  assert.equal(bucketOf(new Date(2026, 7, 22, 23, 59).getTime()), 'week');
  // The week reaches back to midnight seven days ago, and stops there.
  assert.equal(bucketOf(new Date(2026, 7, 17, 0, 0).getTime()), 'week');
  assert.equal(bucketOf(new Date(2026, 7, 16, 23, 59).getTime()), 'older');
  // Today runs to the far end of today, not to the moment called now.
  assert.equal(bucketOf(new Date(2026, 7, 24, 23, 59).getTime()), 'today');
});

test('the rail names each day it groups by, and draws no heading over an empty one', () => {
  const cards = [
    railAt(new Date(2026, 7, 10, 9, 0).getTime(), { pinnedTop: true }),
    railAt(new Date(2026, 7, 24, 9, 0).getTime()),
    railAt(new Date(2026, 7, 23, 9, 0).getTime()),
    railAt(new Date(2026, 7, 20, 9, 0).getTime()),
    railAt(new Date(2026, 7, 1, 9, 0).getTime()),
  ];
  const all = railBuckets(cards, bucketNow);
  assert.deepEqual(
    all.buckets.map((b) => b.id),
    ['top', 'today', 'yesterday', 'week', 'older'],
  );
  // Every nonempty bucket supplies its disclosure label, including Pinned.

  assert.deepEqual(
    all.buckets.map((b) => b.label),
    ['Pinned', 'Today', 'Yesterday', 'Last 7 days', 'Older'],
  );
  // Pinned sessions retain incoming order and appear in no day bucket.

  const pinnedTwice = railBuckets(
    [
      railAt(new Date(2019, 0, 1, 9, 0).getTime(), { pinnedTop: true }),
      railAt(new Date(2026, 7, 24, 9, 0).getTime(), { pinnedTop: true }),
      railAt(new Date(2026, 7, 24, 8, 0).getTime()),
    ],
    bucketNow,
  );
  assert.deepEqual(
    pinnedTwice.buckets.map((b) => b.id),
    ['top', 'today'],
  );
  assert.deepEqual(
    pinnedTwice.buckets.map((b) => b.cards.length),
    [2, 1],
  );
  assert.equal(pinnedTwice.buckets[0].cards[0].at, new Date(2019, 0, 1, 9, 0).getTime());
  // Days with nothing in them are left out entirely rather than drawn as bare headings.
  const gap = railBuckets(
    [
      railAt(new Date(2026, 7, 24, 9, 0).getTime()),
      railAt(new Date(2026, 7, 24, 8, 0).getTime()),
      railAt(new Date(2026, 6, 1, 9, 0).getTime()),
    ],
    bucketNow,
  );
  assert.deepEqual(
    gap.buckets.map((b) => b.id),
    ['today', 'older'],
  );
  // Nothing to group is no headings at all.
  assert.deepEqual(railBuckets([], bucketNow).buckets, []);
});

test('the older sessions start folded, unless folding would hide what matters', () => {
  const today = railAt(new Date(2026, 7, 24, 9, 0).getTime());
  const alsoToday = railAt(new Date(2026, 7, 24, 8, 0).getTime());
  const old = railAt(new Date(2026, 7, 1, 9, 0).getTime());
  const olderStill = railAt(new Date(2026, 6, 1, 9, 0).getTime());
  // The default: old sessions sit behind the fold.
  assert.equal(railBuckets([today, alsoToday, old], bucketNow).olderFolded, true);
  // The session on screen must stay visible in the chooser that points at it.
  const shownOld = railAt(new Date(2026, 7, 1, 9, 0).getTime(), { current: true });
  assert.equal(railBuckets([today, alsoToday, shownOld], bucketNow).olderFolded, false);
  // Older remains open when folding would leave fewer than two visible cards.

  assert.equal(railBuckets([today, old, olderStill], bucketNow).olderFolded, false);
  // Two left standing is enough for the fold to hold.
  assert.equal(railBuckets([today, alsoToday, old, olderStill], bucketNow).olderFolded, true);
  // Pinned cards count toward the visible-card threshold.
  assert.equal(
    railBuckets(
      [
        railAt(new Date(2026, 7, 24, 9, 0).getTime(), { pinnedTop: true }),
        railAt(new Date(2026, 7, 23, 9, 0).getTime(), { pinnedTop: true }),
        old,
      ],
      bucketNow,
    ).olderFolded,
    true,
  );
  // Nothing old is nothing to fold.
  assert.equal(railBuckets([today, alsoToday], bucketNow).olderFolded, false);
  assert.equal(railBuckets([], bucketNow).olderFolded, false);
  // Archived cards do not count toward the visible-card threshold because they have their own fold.

  const archivedOld = railAt(new Date(2026, 7, 1, 9, 0).getTime(), { archived: true });
  const archivedToday = railAt(new Date(2026, 7, 24, 9, 0).getTime(), { archived: true });
  assert.equal(railBuckets([today, archivedToday, archivedOld, old], bucketNow).olderFolded, false);
});

test('archived sessions go to one bucket at the foot, whatever day they belong to', () => {
  const today = railAt(new Date(2026, 7, 24, 9, 0).getTime());
  const alsoToday = railAt(new Date(2026, 7, 24, 8, 0).getTime());
  const old = railAt(new Date(2026, 7, 1, 9, 0).getTime());
  // All archived sessions share the last bucket regardless of activity date.

  const mixed = railBuckets(
    [
      today,
      railAt(new Date(2026, 7, 24, 7, 0).getTime(), { archived: true }),
      alsoToday,
      railAt(new Date(2026, 7, 1, 7, 0).getTime(), { archived: true }),
      old,
    ],
    bucketNow,
  );
  assert.deepEqual(
    mixed.buckets.map((b) => [b.id, b.label, b.cards.length]),
    [
      ['today', 'Today', 2],
      ['older', 'Older', 1],
      ['archived', 'Archived', 2],
    ],
  );
  // Archived grouping overrides pinned grouping.

  const pinnedAndArchived = railBuckets(
    [today, alsoToday, railAt(new Date(2026, 7, 24, 7, 0).getTime(), { archived: true, pinnedTop: true })],
    bucketNow,
  );
  assert.deepEqual(
    pinnedAndArchived.buckets.map((b) => b.id),
    ['today', 'archived'],
  );
  // A bucket holding nothing is left out, the way every other bucket is.
  assert.deepEqual(
    railBuckets([today, alsoToday], bucketNow).buckets.map((b) => b.id),
    ['today'],
  );
});

test("each session gets the figures for its own turns and nobody else's", () => {
  const usage = { input: 100_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 20_000, thinking: 0 };
  const commit = { sha: 'abc1234', subject: 'x', files: 1, added: 1, removed: 0, at: 0, place: null, dir: null };
  const all = statsBySession(
    [
      turn({ sessionId: 'a', usage, commits: [commit], contextTokens: 200_000 }),
      turn({ sessionId: 'b', usage, contextTokens: 200_000 }),
      turn({ sessionId: 'a', usage, commits: [commit, commit], contextTokens: 200_000 }),
    ],
    [compaction({ sessionId: 'a' })],
  );
  assert.deepEqual(Object.keys(all).sort(), ['a', 'b']);
  // Loaded compactions still establish current context, but they do not supply the indexed
  // provenance row that the lifetime ledger owns.
  const ctxOf = (id: string) => all[id].find((c) => c.label.includes('ctx'))?.detail ?? '';
  assert.match(ctxOf('a'), /Context after the latest compaction/);
  assert.doesNotMatch(ctxOf('a'), /Compactions:|Compaction: requested/);
  assert.doesNotMatch(ctxOf('b'), /Compactions:|Compaction: requested/);
  // Session a contains two $1 turns and session b contains one.

  assert.equal(all.a.find((c) => c.label.startsWith('$'))?.label, '$2.00');
  assert.equal(all.b.find((c) => c.label.startsWith('$'))?.label, '$1.00');
  assert.equal(all.a.find((c) => c.label.endsWith('commits'))?.label, '3 commits');
  assert.equal(
    all.b.find((c) => c.label.includes('commit')),
    undefined,
  );
});

test('rail context follows each session newest recorded boundary', () => {
  const turns = [
    turn({ sessionId: 'unknown', contextTokens: 760_000, startedAt: 1_000, endedAt: 2_000 }),
    turn({ sessionId: 'known', contextTokens: 760_000, startedAt: 1_000, endedAt: 2_000 }),
  ];
  const compactions = [
    compaction({ sessionId: 'unknown', at: 3_000, contextAfter: 0, summary: '' }),
    compaction({ sessionId: 'known', at: 3_000, contextAfter: 14_172 }),
  ];
  const afterCompaction = statsBySession(turns, compactions);
  assert.equal(
    afterCompaction.unknown.some((chip) => chip.metric === 'context'),
    false,
  );
  assert.equal(afterCompaction.known.find((chip) => chip.metric === 'context')?.compactLabel, '1% ctx');

  const afterRequest = statsBySession(
    [...turns, turn({ sessionId: 'unknown', contextTokens: 120_000, startedAt: 4_000, endedAt: 5_000 })],
    compactions,
  );
  assert.equal(afterRequest.unknown.find((chip) => chip.metric === 'context')?.compactLabel, '12% ctx');
});

test('a session with no turns is not in the table at all', () => {
  assert.deepEqual(statsBySession([], []), {});
  // Compactions without turns produce no session stats entry.

  assert.deepEqual(statsBySession([], [compaction({ sessionId: 'a' })]), {});
});

test('a synthetic draft row names a session before it has a transcript', () => {
  const row = syntheticDraftRows([{ draftId: 'draft-a', createdAt: 10, agent: 'Claude', agentKey: 'claude' }])[0];
  assert.equal(row.id, 'draft-a');
  assert.equal(row.persisted, false);
  assert.equal(row.label, 'New session');
  assert.equal(row.agentRun, false);
});

test("a synthetic draft row carries a real timestamp for the age's tooltip", () => {
  // Draft creation time supplies the same formatted timestamp used by saved-session age tooltips.

  const row = syntheticDraftRows([{ draftId: 'draft-a', createdAt: 10, agent: 'Codex', agentKey: 'codex' }])[0];
  assert.equal(row.when, formatWhen(10));
});

test('synthetic draft rows retain their creation order', () => {
  assert.deepEqual(
    syntheticDraftRows([
      { draftId: 'first', createdAt: 1, agent: 'Claude', agentKey: 'claude' },
      { draftId: 'second', createdAt: 2, agent: 'Codex', agentKey: 'codex' },
    ]).map((row) => row.id),
    ['first', 'second'],
  );
});

// The Claude fixture contains one completed prompt with no file change or question.

const startedFromThePanel = [
  {
    type: 'user',
    promptId: 'p1',
    timestamp: '2026-09-01T09:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'say what the rail buckets do' }] },
  },
  {
    type: 'assistant',
    timestamp: '2026-09-01T09:00:20.000Z',
    message: {
      role: 'assistant',
      id: 'm1',
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'They group the sessions by day.' }],
    },
  },
].map((line) => JSON.stringify(line));

test("a session this window started is the reader's, whatever its transcript looks like", () => {
  // The transcript classifies this fixture as an agent run. Window-owned creation must override that classification.

  assert.equal(
    agentRunIn(startedFromThePanel, true),
    true,
    'the fixture is no longer the transcript shape that produced the fault',
  );
  // The window that started it holds the fact the record never carries.
  assert.equal(
    agentRunAnswer(true, 'sess-new', new Set(['sess-new']), false, false),
    false,
    'a session this window started is still filed as a run',
  );
  // Every other session keeps the transcript answer, in both directions.
  assert.equal(agentRunAnswer(true, 'sess-other', new Set(['sess-new']), false, false), true);
  assert.equal(agentRunAnswer(false, 'sess-new', new Set(['sess-new']), false, false), false);
  assert.equal(agentRunAnswer(true, 'sess-other', new Set(), false, false), true);
});

test('a child transcript answers as an agent run even against a stale cached false', () => {
  // Child-transcript identity overrides a cached false agentRun value.

  assert.equal(
    agentRunAnswer(false, 'sess-child', new Set(), true, false),
    true,
    'a child transcript with a stale cached false does not answer as an agent run',
  );
  assert.equal(
    agentRunAnswer(false, 'sess-child', new Set(['sess-child']), true, false),
    true,
    'a child transcript started by this window still answers as an agent run',
  );

  const now = new Date(2026, 0, 2).getTime();
  const { buckets } = railBuckets(
    [
      {
        at: now,
        pinnedTop: false,
        current: false,
        archived: false,
        agentRun: agentRunAnswer(false, 'sess-child', new Set(), true, false),
      },
    ],
    now,
  );
  assert.ok(
    buckets.some((bucket) => bucket.id === 'agent'),
    'a child transcript with a stale cached false is not filed under the agent bucket',
  );
  assert.equal(
    buckets.some((bucket) => bucket.id === 'today'),
    false,
    'a child transcript with a stale cached false is also filed under today',
  );
});

// A completed single-prompt sdk-cli transcript with a file change groups under agent runs.

test('a finished sdk-cli run that wrote a file files under the agent bucket', () => {
  const lines = sdkFileChangeTranscript().map((l) => JSON.stringify(l));
  assert.equal(agentRunIn(lines, true), true, 'a finished sdk-cli run that wrote a file was not read as an agent run');

  const now = new Date(2026, 0, 1).getTime();
  const { buckets } = railBuckets(
    [
      {
        at: now,
        pinnedTop: false,
        current: false,
        archived: false,
        agentRun: agentRunIn(lines, true) ?? false,
      },
    ],
    now,
  );
  assert.ok(
    buckets.some((bucket) => bucket.id === 'agent'),
    'a finished sdk-cli run that wrote a file is not filed under the agent bucket',
  );
  assert.equal(
    buckets.some((bucket) => bucket.id === 'today'),
    false,
    'a finished sdk-cli run that wrote a file is also filed under today',
  );
});

test('an SDK slash-command run files under the agent bucket', () => {
  const lines = sdkSlashCommandTranscript().map((l) => JSON.stringify(l));
  assert.equal(agentRunIn(lines, true), true, 'an SDK slash-command run was not read as an agent run');
  const now = new Date(2026, 0, 1).getTime();
  const { buckets } = railBuckets(
    [
      {
        at: now,
        pinnedTop: false,
        current: false,
        archived: false,
        agentRun: agentRunIn(lines, true) ?? false,
      },
    ],
    now,
  );
  assert.ok(
    buckets.some((bucket) => bucket.id === 'agent'),
    'an SDK slash-command run is not filed under the agent bucket',
  );
  assert.equal(
    buckets.some((bucket) => bucket.id === 'today'),
    false,
    'an SDK slash-command run is also filed under today',
  );
});

test('a background session run files under the agent bucket', () => {
  const lines = bgSessionTranscript().map((l) => JSON.stringify(l));
  assert.equal(agentRunIn(lines, true), true, 'a background session run was not read as an agent run');
  const now = new Date(2026, 0, 1).getTime();
  const { buckets } = railBuckets(
    [
      {
        at: now,
        pinnedTop: false,
        current: false,
        archived: false,
        agentRun: agentRunIn(lines, true) ?? false,
      },
    ],
    now,
  );
  assert.ok(
    buckets.some((bucket) => bucket.id === 'agent'),
    'a background session run is not filed under the agent bucket',
  );
  assert.equal(
    buckets.some((bucket) => bucket.id === 'today'),
    false,
    'a background session run is also filed under today',
  );
});

test("a background worker's dispatched follow-up files under the agent bucket", () => {
  const lines = bgWorkerFollowUpTranscript().map((l) => JSON.stringify(l));
  assert.equal(
    agentRunIn(lines, true),
    true,
    "a background worker's dispatched follow-up was not read as an agent run",
  );
  const now = new Date(2026, 0, 1).getTime();
  const { buckets } = railBuckets(
    [
      {
        at: now,
        pinnedTop: false,
        current: false,
        archived: false,
        agentRun: agentRunIn(lines, true) ?? false,
      },
    ],
    now,
  );
  assert.ok(
    buckets.some((bucket) => bucket.id === 'agent'),
    "a background worker's dispatched follow-up is not filed under the agent bucket",
  );
  assert.equal(
    buckets.some((bucket) => bucket.id === 'today'),
    false,
    "a background worker's dispatched follow-up is also filed under today",
  );
});

test('a background session with an away_summary record files under the agent bucket', () => {
  const lines = bgAwaySummaryTranscript().map((l) => JSON.stringify(l));
  assert.equal(
    agentRunIn(lines, true),
    true,
    'a background session with an away_summary record was not read as an agent run',
  );
  const now = new Date(2026, 0, 1).getTime();
  const { buckets } = railBuckets(
    [
      {
        at: now,
        pinnedTop: false,
        current: false,
        archived: false,
        agentRun: agentRunIn(lines, true) ?? false,
      },
    ],
    now,
  );
  assert.ok(
    buckets.some((bucket) => bucket.id === 'agent'),
    'a background session with an away_summary record is not filed under the agent bucket',
  );
  assert.equal(
    buckets.some((bucket) => bucket.id === 'today'),
    false,
    'a background session with an away_summary record is also filed under today',
  );
});

test('a resumed SDK review files under the agent bucket', () => {
  const lines = resumedSdkTranscript().map((l) => JSON.stringify(l));
  assert.equal(agentRunIn(lines, true), true, 'a resumed SDK review was not read as an agent run');
  const now = new Date(2026, 0, 1).getTime();
  const { buckets } = railBuckets(
    [
      {
        at: now,
        pinnedTop: false,
        current: false,
        archived: false,
        agentRun: agentRunIn(lines, true) ?? false,
      },
    ],
    now,
  );
  assert.ok(
    buckets.some((bucket) => bucket.id === 'agent'),
    'a resumed SDK review is not filed under the agent bucket',
  );
  assert.equal(
    buckets.some((bucket) => bucket.id === 'today'),
    false,
    'a resumed SDK review is also filed under today',
  );
});

test('a session this window started stays parsed while the reader reads another', () => {
  // A reader-started session outside the selected view stays eligible for parsing through its ownership override.

  const guessed = new Map([
    ['sess-new', true],
    ['sess-run', true],
    ['sess-mine', false],
  ]);
  const startedHere = new Set(['sess-new']);
  const showing = 'sess-mine';
  const cut = ['sess-new', 'sess-run', 'sess-mine'].filter(
    (id) => !agentRunAnswer(guessed.get(id) === true, id, startedHere, false, false) || id === showing,
  );
  assert.deepEqual(
    cut,
    ['sess-new', 'sess-mine'],
    'a session the panel started leaves the cut as soon as the reader looks at another',
  );
});

// Resolved dispatch references link the child heading to its parent row.

const dispatchRows = [
  { id: 'parent-a', label: 'Plan the dispatch' },
  { id: 'parent-b', label: 'Review the plan' },
  { id: 'child', label: 'Build phase one' },
];
const dispatchOf = (parent: string, child: string, tool = 'toolu_1') => ({
  kind: 'dispatch' as const,
  parentSessionId: parent,
  sessionId: child,
  file: `${child}.jsonl`,
  toolUseIds: [tool],
  name: null,
  owned: false,
});
// A Claude subagent claims from its resolved child file, which carries the parent that owns it.
const subagentOf = (parent: string, child: string) => ({ parentSessionId: parent, sessionId: child });
const parentsOf = (
  references: Parameters<typeof sessionParentIndex>[0],
  subagents: Parameters<typeof sessionParentIndex>[1] = [],
  codex: Parameters<typeof sessionParentIndex>[2] = [],
  rows = dispatchRows,
) => {
  const index = sessionParentIndex(references, subagents, codex);
  return Object.fromEntries(rows.map((row) => [row.id, sessionParentOf(rows, index, row.id) ?? null]));
};

test("a dispatched session names the session that started it by that session's own label", () => {
  assert.deepEqual(parentsOf([dispatchOf('parent-a', 'child')]), {
    'parent-a': null,
    'parent-b': null,
    child: { id: 'parent-a', label: 'Plan the dispatch', relation: 'dispatched' },
  });
  assert.deepEqual(
    parentsOf([dispatchOf('parent-a', 'child', 'toolu_1'), dispatchOf('parent-a', 'child', 'toolu_2')]).child,
    { id: 'parent-a', label: 'Plan the dispatch', relation: 'dispatched' },
    'two tool results naming one launch did not read as one parent',
  );
});

test('a dispatched session or subagent names no parent when the parent is unknown or contested', () => {
  const none = { 'parent-a': null, 'parent-b': null, child: null };
  assert.equal(
    sessionParentOf(dispatchRows, sessionParentIndex([]), 'child'),
    undefined,
    'references still resolving named a parent',
  );
  assert.deepEqual(
    parentsOf([dispatchOf('parent-a', 'child'), dispatchOf('parent-b', 'child')]),
    none,
    'a child two sessions claim named one of them',
  );
  assert.deepEqual(parentsOf([dispatchOf('parent-gone', 'child')]), none, 'a parent with no row was named');
  assert.deepEqual(
    parentsOf([], [subagentOf('parent-a', 'child'), subagentOf('parent-b', 'child')]),
    none,
    'a subagent two sessions claim named one of them',
  );
  assert.deepEqual(
    parentsOf([], [subagentOf('parent-gone', 'child')]),
    none,
    'a subagent whose parent has no row was named',
  );
});

// Conflicting dispatch and subagent relationships suppress parent navigation even when they name the same parent.

test('a child claimed by a dispatch and as a subagent names no parent', () => {
  const none = { 'parent-a': null, 'parent-b': null, child: null };
  assert.deepEqual(
    parentsOf([dispatchOf('parent-a', 'child')], [subagentOf('parent-a', 'child')]),
    none,
    'one parent claiming a child by two relations named one of them',
  );
  assert.deepEqual(
    parentsOf([dispatchOf('parent-a', 'child')], [subagentOf('parent-b', 'child')]),
    none,
    'a dispatch from one session and a subagent from another named one of them',
  );
});

// A listed subagent carries its parent session and subagent relationship.

test('a Claude subagent and a Codex subagent with a session row name the session that started them', () => {
  assert.deepEqual(parentsOf([], [subagentOf('parent-b', 'child')]).child, {
    id: 'parent-b',
    label: 'Review the plan',
    relation: 'subagent',
  });
  const codexChild = (threadId: string, backgroundReview = false) => ({
    threadId,
    parentThreadId: 'parent-a',
    backgroundReview,
  });
  assert.deepEqual(
    parentsOf([], [], [codexChild('child')]).child,
    { id: 'parent-a', label: 'Plan the dispatch', relation: 'subagent' },
    'a Codex subagent with a session row named no parent',
  );
  assert.deepEqual(
    [
      ...sessionParentIndex(
        [],
        [],
        [codexChild('review', true), { threadId: 'root', parentThreadId: null, backgroundReview: false }],
      ),
    ],
    [],
    'a Codex background review or a thread with no parent named a parent',
  );
});

// An unresolved reference copied by a fork cannot contest ownership from the resolved child file.

test('a forked parent that repeats an Agent result leaves the subagent its real parent', () => {
  const fromFork = { kind: 'subagent' as const, parentSessionId: 'parent-a', sessionId: 'child' };
  const fromParent = { kind: 'subagent' as const, parentSessionId: 'parent-b', sessionId: 'child' };
  assert.deepEqual(
    parentsOf([fromParent, fromFork], [subagentOf('parent-b', 'child')]).child,
    { id: 'parent-b', label: 'Review the plan', relation: 'subagent' },
    'the fork took the subagent from its parent',
  );
  assert.equal(parentsOf([fromFork]).child, null, 'a subagent reference whose file never resolved named a parent');
});

// Dispatch establishes agent-run identity. Window-owned creation or reader ownership overrides it for dispatched sessions.

test('a dispatched session is a run unless this window started it or the reader owns it', () => {
  const filed = (agentRun: boolean) => {
    const now = new Date(2026, 0, 2).getTime();
    const { buckets } = railBuckets([{ at: now, pinnedTop: false, current: false, archived: false, agentRun }], now);
    return buckets.map((bucket) => bucket.id);
  };
  assert.deepEqual(
    filed(agentRunAnswer(false, 'child', new Set(), false, true)),
    ['agent'],
    "a dispatched session with a person in its transcript was filed as the reader's own",
  );
  assert.equal(
    agentRunAnswer(false, 'child', new Set(['child']), false, true),
    false,
    'a session this window started was filed as a run because another session resumed it',
  );
  assert.equal(
    agentRunAnswer(true, 'child', new Set(['child']), false, true),
    false,
    'a session this window started was filed as a run because its transcript and a dispatch edge both said so',
  );
  assert.equal(
    agentRunAnswer(false, 'child', new Set(['child']), true, true),
    true,
    'a child transcript this window started stopped reading as a run',
  );
  assert.deepEqual(
    filed(agentRunAnswer(true, 'child', new Set(), false, true, true)),
    ['today'],
    'a dispatched session the reader owns was filed under Run by agents',
  );
  assert.equal(
    agentRunAnswer(true, 'child', new Set(), false, false, true),
    true,
    'a reader-owned fact without a dispatch edge overrode the transcript guess',
  );
});

// Either matching dispatch reference can establish reader ownership regardless of reference order.

test('a dispatched edge is owned when either reference to it is', () => {
  const owned = { ...dispatchOf('parent-a', 'child'), owned: true };
  for (const references of [
    [owned, dispatchOf('parent-a', 'child', 'toolu_2')],
    [dispatchOf('parent-a', 'child', 'toolu_2'), owned],
  ]) {
    assert.deepEqual(sessionParentIndex(references).get('child'), {
      parent: 'parent-a',
      relation: 'dispatched',
      owned: true,
    });
  }
  assert.deepEqual(sessionParentIndex([dispatchOf('parent-a', 'child')]).get('child'), {
    parent: 'parent-a',
    relation: 'dispatched',
  });
  assert.equal(sessionParentsKey(sessionParentIndex([owned])), 'child>parent-a:dispatched:owned');
});

test('a dispatch reference with no parent or child row does not change the parents key', () => {
  const rows = new Set(dispatchRows.map((row) => row.id));
  const key = (references: Parameters<typeof sessionParentIndex>[0]) =>
    sessionParentsKey(sessionParentEdgesAmong(sessionParentIndex(references), rows));
  const drawn = key([dispatchOf('parent-a', 'child')]);
  assert.equal(drawn, 'child>parent-a:dispatched');
  assert.equal(
    key([dispatchOf('parent-a', 'child'), dispatchOf('parent-gone', 'child-b')]),
    drawn,
    'a reference whose parent has no row changed the key',
  );
  assert.equal(
    key([dispatchOf('parent-a', 'child'), dispatchOf('parent-b', 'child-gone')]),
    drawn,
    'a reference whose child has no row changed the key',
  );
  assert.notEqual(
    key([dispatchOf('parent-a', 'child'), dispatchOf('parent-b', 'parent-a')]),
    drawn,
    'a reference between two sessions with rows left the key unchanged',
  );
});

// Subagent relationships update heading refresh keys but stay outside dispatched edges used for grouping and cost.

test('a subagent edge moves the parents key and stays out of the dispatched edges', () => {
  const rows = new Set(dispatchRows.map((row) => row.id));
  const edges = sessionParentEdgesAmong(sessionParentIndex([], [subagentOf('parent-a', 'child')]), rows);
  assert.equal(sessionParentsKey(edges), 'child>parent-a:subagent', 'a paired subagent left the refresh key unchanged');
  assert.deepEqual([...dispatchedParents(edges)], [], 'a subagent edge reached the filing and the cost');
  const both = sessionParentEdgesAmong(
    sessionParentIndex([dispatchOf('parent-b', 'parent-a')], [subagentOf('parent-a', 'child')]),
    rows,
  );
  assert.deepEqual([...dispatchedParents(both)], [['parent-a', 'parent-b']]);
});

// Parent edge sets reuse their projection and key while the parent index and catalog IDs stay the same. Empty indexes ignore catalog changes.

test('the parent edge set is reused until the index or the catalog ids move', () => {
  const sessions = dispatchRows.map((row) => ({ sessionId: row.id }));
  const parents = sessionParentIndex([dispatchOf('parent-a', 'child')], [subagentOf('parent-b', 'parent-a')]);
  const held = sessionParentEdgeSet(null, parents, sessions);
  assert.equal(held.key, 'child>parent-a:dispatched,parent-a>parent-b:subagent');
  assert.deepEqual([...held.dispatched], [['child', 'parent-a']]);
  assert.equal(
    sessionParentEdgeSet(
      held,
      parents,
      sessions.map((session) => ({ ...session })),
    ),
    held,
    'a selection over the same catalog rebuilt the edges',
  );
  assert.equal(
    sessionParentEdgeSet(held, parents, [...sessions].reverse()),
    held,
    'a catalog in another order rebuilt the edges',
  );
  const repeated = [sessions[0], ...sessions.slice(0, -1)];
  assert.notEqual(
    sessionParentEdgeSet(held, parents, repeated),
    held,
    'a catalog that repeated one id in place of another reused the edges',
  );
  const shrunk = sessionParentEdgeSet(
    held,
    parents,
    sessions.filter((session) => session.sessionId !== 'parent-b'),
  );
  assert.notEqual(shrunk, held, 'a catalog that lost a session reused the edges');
  assert.equal(shrunk.key, 'child>parent-a:dispatched', 'a catalog that lost a parent kept its edge');
  const replaced = sessionParentIndex([dispatchOf('parent-b', 'child')]);
  assert.equal(
    sessionParentEdgeSet(held, replaced, sessions).key,
    'child>parent-b:dispatched',
    'a replaced index reused the edges of the one before',
  );
  const empty = sessionParentEdgeSet(null, new Map(), sessions);
  assert.equal(
    sessionParentEdgeSet(empty, empty.parents, sessions.slice(1)),
    empty,
    'an empty index rebuilt for a new catalog',
  );
});

test('read-only Bedrock reuse keeps the session list cache mark on its latest request clock', () => {
  const requestAt = 4 * 60_000;
  for (const model of [
    'openai.gpt-6.1-sol',
    'us.openai.gpt-6.1-sol',
    'global.openai.gpt-6.1-sol',
    'openai.gpt-6-luna',
  ]) {
    const facts: SessionStatFacts = {
      turns: [
        {
          startedAt: requestAt,
          endedAt: requestAt,
          finished: true,
          error: false,
          model,
          provider: 'amazon-bedrock',
          usage: { input: 1, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
          contextTokens: 300_000,
          contextWindow: 1_000_000,
          contextRequest: {
            at: requestAt,
            lifetime: null,
            inferenceClass: null,
            serviceTier: null,
            readBack: true,
            outputTokens: 40,
          },
          childSpendPartial: false,
        },
      ],
      compactions: [],
    };
    assert.equal(railCacheMarkOf(facts, requestAt + 26 * 60_000)?.expiresAt, requestAt + 28.5 * 60_000, model);
    assert.equal(railCacheMarkOf(facts, requestAt + 28.5 * 60_000), null, model);
  }
});
