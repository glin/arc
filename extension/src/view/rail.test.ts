import { test } from 'vitest';
import { createSessionLabelIndex } from './rail.ts';

test('session label lookup indexes authoritative rows once and follows replacement', () => {
  let reads = 0;
  const rows = Array.from({ length: 1000 }, (_, i) => ({
    get id() {
      reads++;
      return `session${i}`;
    },
    labels: [`label${i}`],
  }));
  const lookup = createSessionLabelIndex();
  for (let repeat = 0; repeat < 5; repeat++) {
    for (let i = 0; i < rows.length; i++) assert.deepEqual(lookup.labels(rows, `session${i}`), [`label${i}`]);
  }
  assert.ok(reads <= rows.length * 2, 'repeated lookup scans the session list again');
  assert.deepEqual(lookup.labels(rows, 'missing'), []);
  const replaced = [{ id: 'session0', labels: [] }, { id: 'session0', labels: ['duplicate'] }, { id: 'session1' }];
  assert.deepEqual(lookup.labels(replaced, 'session0'), []);
  assert.deepEqual(lookup.labels(replaced, 'session1'), []);
  assert.deepEqual(lookup.labels([{ id: 'session0', labels: ['updated'] }], 'session0'), ['updated']);
  assert.deepEqual(lookup.labels(undefined, 'session0'), []);
});
import assert from 'node:assert';
import {
  clampRailWidth,
  effectiveRailWidth,
  railWidthMaximum,
  railWidthKey,
  normalizeRailDensity,
  normalizeRailGroupBy,
  normalizeRailShowArchived,
  normalizeRailShowRuns,
  normalizeRailQuickFilters,
  railHeadLensBoxes,
  withRailHeadLensToggled,
  railAgeFormat,
  railBuckets,
  railCardActive,
  railCardHint,
  railHoverLines,
  runningFor,
  subagentsHintDetail,
  subagentsStillRunning,
  backgroundCommandsHintDetail,
  type RailHoverCard,
  type RailHoverLines,
  railCountButtons,
  railNarrowToRow,
  railCountPressed,
  railCounts,
  railHeadCounts,
  railLensHolds,
  railSections,
  railKeptAfter,
  railShownCards,
  sortRailCards,
  ACTIVE_WINDOW_MS,
  RAIL_DENSITIES,
  RAIL_FOLDS,
  RAIL_GROUP_BY,
  RAIL_SHOWN_BUCKETS,
  RAIL_WIDTH_DEFAULT,
  RAIL_WIDTH_MIN,
  railRunningWord,
  railTimeSlot,
  sessionCount,
  viewFoldId,
  railCacheState,
  railCacheTitle,
  railDrawnRows,
  RAIL_ROW_STEP,
  railRowsDrawn,
  railAgentWordShown,
  railRepeatRows,
  railRowId,
  railRowKey,
  railShownLabelCounts,
  type RailGroupBy,
  type RailGrouping,
  railQueryReadsCache,
  railTickWork,
  type RailSection,
  type RailSectionCard,
  type RailTickCard,
} from './rail.ts';
import type { SavedView } from '../domain/views.ts';
import { matchSessions } from '../domain/session-query.ts';
import {
  ALL_RAIL_FILTER_ID,
  RAIL_LENSES,
  RAIL_LENS_WORDS,
  pressRailLens,
  withRailLens,
  type RailLens,
} from '../domain/rail-filters.ts';
import { CARD_ACTIONS } from './card-words.ts';
import { formatRelative } from './time.ts';

test('rail width and compact wording have one browser-safe owner', () => {
  assert.equal(clampRailWidth(undefined), RAIL_WIDTH_DEFAULT);
  assert.equal(clampRailWidth(10), RAIL_WIDTH_MIN);
  assert.equal(clampRailWidth(9999), 9999);
  assert.equal(clampRailWidth(219.6), 220);
  assert.equal(sessionCount(1), '1 turn');
  assert.deepEqual(railTimeSlot('waiting', true), { word: 'needs input', time: false });
  assert.deepEqual(railTimeSlot('failed', false), { word: 'failed', time: true });
});

test('session list resize decisions share finite viewport bounds without changing a saved preference', () => {
  assert.equal(railWidthMaximum(900, 5), 895);
  assert.equal(railWidthMaximum(100, 5), RAIL_WIDTH_MIN);
  assert.equal(railWidthMaximum(NaN, Infinity), RAIL_WIDTH_MIN);
  const preferred = 1200;
  assert.equal(effectiveRailWidth(preferred, 895), 895);
  assert.equal(effectiveRailWidth(preferred, 1395), preferred);
  assert.equal(railWidthKey('ArrowLeft', 220, 895), 210);
  assert.equal(railWidthKey('ArrowRight', 895, 895), 895);
  assert.equal(railWidthKey('Home', 220, 895), 160);
  assert.equal(railWidthKey('End', 220, 895), 895);
  assert.equal(railWidthKey('Tab', 220, 895), null);
});

test('running rail figures begin at one minute and use the shared duration wording', () => {
  const now = 10_000_000;
  assert.equal(railRunningWord(now - 59_000, now), null);
  assert.equal(railRunningWord(now - 60_000, now), '1m');
  assert.equal(railRunningWord(now - 31 * 60_000, now), '31m');
  assert.equal(railRunningWord(now - (59 * 60 + 30) * 1000, now), '1h 0m');
  assert.equal(railRunningWord(now - (2 * 60 + 14) * 60_000, now), '2h 14m');
});

// The clock the cache counts are read against. Every card below that carries a cache span
// places it either side of this moment.
const countsNow = 5_000_000;

test('the Running count sums running, subagents and background over the shown sessions no agent runs', () => {
  const recent = countsNow - 5 * 60_000;
  const stale = countsNow - 2 * ACTIVE_WINDOW_MS;
  const cards: RailSectionCard[] = [
    testCard('waiting', { status: 'waiting', at: recent }),
    testCard('unread-done', { status: 'done', unread: true, at: recent }),
    testCard('running', { status: 'running', at: recent }),
    testCard('subagents', { status: 'subagents', at: recent }),
    testCard('background', { status: 'background', at: recent }),
    // Outside the hour-long Active window, so it never adds to `active` whatever the Show
    // switches say.
    testCard('read-done', { status: 'done', unread: false, at: stale }),
    testCard('archived-waiting', { status: 'waiting', archived: true, at: recent }),
    // Set both agent-run fields as turnrail does for unarchived sessions. Agent runs never contribute to Running or Active counts.
    testCard('agent-running', { status: 'running', agentRun: true, runByAgent: true, at: recent }),
  ];
  // Archived sessions and agent runs never contribute to these counts. The stale read-done session also falls outside Active.
  // The five remaining sessions count as Active under every Show combination.
  assert.deepEqual(railCounts(cards, { showArchived: true, showRuns: true }, countsNow), {
    running: 3,
    warm: 0,
    expiring: 0,
    active: 5,
    unread: 1,
    input: 1,
  });
  // Hiding Archived leaves the counts unchanged because archived sessions are already excluded.
  assert.deepEqual(railCounts(cards, { showArchived: false, showRuns: true }, countsNow), {
    running: 3,
    warm: 0,
    expiring: 0,
    active: 5,
    unread: 1,
    input: 1,
  });
  assert.deepEqual(railCounts(cards, { showArchived: true, showRuns: false }, countsNow), {
    running: 3,
    warm: 0,
    expiring: 0,
    active: 5,
    unread: 1,
    input: 1,
  });
  assert.deepEqual(railCounts(cards, { showArchived: false, showRuns: false }, countsNow), {
    running: 3,
    warm: 0,
    expiring: 0,
    active: 5,
    unread: 1,
    input: 1,
  });
});

// Count sessions from the drawn sections, using RAIL_SHOWN_BUCKETS. Deduplicate pinned copies by session id.
test('the head row counts exactly the sessions the rail draws', () => {
  // Keep n3 and r2 outside Active so its count differs from the total drawn list.
  const cards: RailSectionCard[] = workspace().map((card) => ({
    ...card,
    status: card.id === 'arch' ? 'waiting' : card.id === 'n4' ? 'running' : card.id === 'c1' ? 'subagents' : 'done',
    unread: card.id === 'r1',
    at: card.id === 'n3' || card.id === 'r2' ? countsNow - 2 * ACTIVE_WINDOW_MS : countsNow - 5 * 60_000,
  }));
  const drawn = new Map<string, RailSectionCard>();
  for (const section of railSections(cards, sectionNow, []).sections) {
    for (const card of section.cards) {
      drawn.set(card.id, card);
    }
  }
  assert.deepEqual(
    railCounts(cards, RAIL_SHOWN_BUCKETS, countsNow),
    railCounts([...drawn.values()], { showArchived: true, showRuns: true }, countsNow),
    'a figure on the head row counts sessions the rail leaves out of its list, or misses ones it draws',
  );
  assert.deepEqual(
    railCounts(cards, RAIL_SHOWN_BUCKETS, countsNow),
    { running: 1, warm: 0, expiring: 0, active: 6, unread: 1, input: 0 },
    'the workspace this measures no longer carries an archived session, an agent run and the two stale sessions in the counts',
  );
});

test('an empty rail counts zero', () => {
  assert.deepEqual(railCounts([], { showArchived: true, showRuns: true }, countsNow), {
    running: 0,
    warm: 0,
    expiring: 0,
    active: 0,
    unread: 0,
    input: 0,
  });
});

const SHOW_COMBOS = [
  { showArchived: true, showRuns: true },
  { showArchived: false, showRuns: true },
  { showArchived: true, showRuns: false },
  { showArchived: false, showRuns: false },
] as const;

// Count expiring caches only within Active. Exclude archived sessions and agent runs under every Show combination.
test('the expiring clause counts nearly gone caches on Active sessions only', () => {
  const recent = countsNow - 5 * 60_000;
  const nearlyGone = { expiresAt: countsNow + 5 * 60_000, nearlyGoneAt: countsNow - 60_000 };
  const cards: RailSectionCard[] = [
    testCard('fresh', {
      at: recent,
      cache: { expiresAt: countsNow + 30 * 60_000, nearlyGoneAt: countsNow + 20 * 60_000 },
    }),
    testCard('nearly-gone', { at: recent, cache: nearlyGone }),
    testCard('expired', {
      at: recent,
      cache: { expiresAt: countsNow - 60_000, nearlyGoneAt: countsNow - 10 * 60_000 },
    }),
    testCard('archived-nearly-gone', { at: recent, archived: true, cache: nearlyGone }),
    testCard('agent-nearly-gone', { at: recent, agentRun: true, runByAgent: true, cache: nearlyGone }),
  ];
  for (const shown of SHOW_COMBOS) {
    assert.equal(railCounts(cards, shown, countsNow).expiring, 1, JSON.stringify(shown));
  }
  // The cache runs out on a clock, so the same cards read differently ten minutes later.
  assert.equal(railCounts(cards, RAIL_SHOWN_BUCKETS, countsNow + 10 * 60_000).expiring, 0);
});

// Return drawn session ids after applying the lens query and Show settings. Deduplicate pinned copies.
function drawnUnderLens(
  cards: readonly RailSectionCard[],
  query: string,
  lens: RailLens | null,
  shown: { showArchived: boolean; showRuns: boolean },
  now: number,
): string[] {
  const kept = railShownCards(cards, { query: withRailLens(query, lens) }, now);
  const ids = railSections(kept, now, [], 'latest', shown).sections.flatMap((section) =>
    section.cards.map((card) => card.id),
  );
  return [...new Set(ids)].sort();
}

// A lens count uses the remaining query terms. Pressing its button adds the lens terms to that same query.
test('the lens figure equals what its press draws, with and without a query', () => {
  const now = countsNow;
  const recent = now - 5 * 60_000;
  const stale = now - 2 * ACTIVE_WINDOW_MS;
  const cards: RailSectionCard[] = [
    testCard('ui-waiting', { status: 'waiting', at: recent, labels: ['ui'] }),
    testCard('ui-unread', { status: 'done', unread: true, at: recent, labels: ['ui'] }),
    testCard('ui-read', { status: 'done', unread: false, at: recent, labels: ['ui'] }),
    testCard('ui-running', { status: 'running', at: recent, labels: ['ui'] }),
    testCard('perf-unread', { status: 'done', unread: true, at: recent, labels: ['perf'] }),
    testCard('plain-read', { status: 'done', unread: false, at: recent }),
    testCard('ui-stale-unread', { status: 'done', unread: true, at: stale, labels: ['ui'] }),
    testCard('ui-warm-stale', {
      status: 'done',
      at: stale,
      labels: ['ui'],
      cache: { expiresAt: now + 60_000, nearlyGoneAt: null },
    }),
    testCard('ui-archived-waiting', { status: 'waiting', at: recent, archived: true, labels: ['ui'] }),
    testCard('ui-agent-unread', {
      status: 'done',
      unread: true,
      at: recent,
      agentRun: true,
      runByAgent: true,
      labels: ['ui'],
    }),
    testCard('pinned-ui-unread', { status: 'done', unread: true, at: recent, pinnedTop: true, labels: ['ui'] }),
  ];
  for (const query of ['', 'label:ui', 'label:ui label:perf', 'is:running', '-label:ui']) {
    {
      for (const shown of SHOW_COMBOS) {
        const where = `${JSON.stringify(query)} ${JSON.stringify(shown)}`;
        for (const pressed of [null, ...RAIL_LENSES]) {
          const counts = railHeadCounts(cards, shown, now, { query: withRailLens(query, pressed) });
          for (const lens of RAIL_LENSES) {
            assert.equal(
              counts[lens],
              drawnUnderLens(cards, query, lens, shown, now).length,
              `${lens}, ${where}, ${pressed} pressed`,
            );
          }
        }
      }
    }
  }
  // The rail holds exactly what both keep.
  assert.deepEqual(drawnUnderLens(cards, 'label:ui', 'active', RAIL_SHOWN_BUCKETS, now), [
    'pinned-ui-unread',
    'ui-read',
    'ui-running',
    'ui-unread',
    'ui-waiting',
    'ui-warm-stale',
  ]);

  // A query with both status terms requires both statuses.
  const both = { query: `is:input ${RAIL_LENS_WORDS.unread}` };
  assert.deepEqual(
    railShownCards(cards, both, now)
      .map((card) => card.id)
      .sort(),
    [],
  );
  assert.deepEqual(railSections(railShownCards(cards, both, now), now, []).sections, []);
  assert.equal(railHeadCounts(cards, RAIL_SHOWN_BUCKETS, now, both).unread, 4);
  const view = testView({ query: 'is:unread label:ui' });
  const [section] = railSections(cards, now, [view]).sections.filter((one) => one.id === viewFoldId(view));
  assert.ok(
    section.cards.every((card) => card.unread && card.labels?.includes('ui')),
    'a view read is:unread as a lens',
  );
  // No lens leaves the query's list as it was.
  assert.deepEqual(drawnUnderLens(cards, 'label:perf', null, RAIL_SHOWN_BUCKETS, now), ['perf-unread']);
});

// Unread and Needs input keep what they drew, so a session the reader reads or answers stays on
// the rail until the query changes. A kept session still answers to every other word and to the
// reader's own filing. The figures count what holds the lens now.
test('the Unread and Needs input lenses keep what they drew until the query changes', () => {
  const now = countsNow;
  const cards: RailSectionCard[] = [
    testCard('ui-unread', { status: 'done', unread: true, labels: ['ui'] }),
    testCard('ui-waiting', { status: 'waiting', labels: ['ui'] }),
    testCard('perf-unread', { status: 'waiting', unread: true, labels: ['perf'] }),
    testCard('ui-read', { status: 'done', labels: ['ui'] }),
  ];
  const ids = (shown: readonly RailSectionCard[]) => shown.map((card) => card.id);
  const cases = [
    { lens: 'unread', held: 'ui-unread', done: { unread: false } },
    { lens: 'input', held: 'ui-waiting', done: { status: 'done' } },
  ] as const;
  for (const { lens, held, done } of cases) {
    const rail = { query: withRailLens('label:ui', lens) };
    const first = railShownCards(cards, rail, now);
    assert.deepEqual(ids(first), [held], lens);
    const kept = railKeptAfter(rail, first);
    const change = (over: Partial<RailSectionCard>) =>
      cards.map((card) => (card.id === held ? { ...card, ...done, ...over } : card));
    const read = change({});
    assert.deepEqual(ids(railShownCards(read, rail, now)), [], `${lens}: the lens words still hold`);
    const again = railShownCards(read, rail, now, false, kept);
    assert.deepEqual(ids(again), [held], `${lens}: a session the reader acted on left the rail`);
    // A second draw keeps it again.
    assert.deepEqual(ids(railShownCards(read, rail, now, false, railKeptAfter(rail, again))), [held], lens);
    assert.equal(railHeadCounts(read, RAIL_SHOWN_BUCKETS, now, rail)[lens], 0, `${lens}: the figure kept`);
    // A kept session still answers to the other words, and to archiving and agent runs.
    assert.deepEqual(ids(railShownCards(change({ labels: ['perf'] }), rail, now, false, kept)), [], lens);
    assert.deepEqual(ids(railShownCards(change({ archived: true }), rail, now, false, kept)), [], lens);
    assert.deepEqual(ids(railShownCards(change({ runByAgent: true }), rail, now, false, kept)), [], lens);
    const perf = { query: withRailLens('label:ui label:perf', lens) };
    assert.deepEqual(ids(railShownCards(read, perf, now, false, kept)), [], lens);
    const other = { query: withRailLens('label:ui', lens === 'unread' ? 'input' : 'unread') };
    assert.ok(!ids(railShownCards(read, other, now, false, kept)).includes(held), lens);
  }
  // Active does not keep, because its figure equals what its press draws.
  const active = { query: withRailLens('', 'active') };
  assert.equal(railKeptAfter(active, railShownCards(cards, active, now)), null);
  assert.equal(railKeptAfter({ query: 'label:ui' }, cards), null);
});

// The Running count is a lens like the other three, so its figure counts inside the rest of the
// query its own press produces. An archived running session and one an agent runs count on
// neither side, whichever Show switches draw them.
test('the Running count equals what its press draws', () => {
  const now = countsNow;
  const recent = now - 5 * 60_000;
  const stale = now - 2 * ACTIVE_WINDOW_MS;
  const cards: RailSectionCard[] = [
    testCard('running-read', { status: 'running', at: recent, labels: ['ui'] }),
    testCard('running-unread', { status: 'running', unread: true, at: recent }),
    testCard('running-stale', { status: 'running', at: stale }),
    testCard('running-archived', { status: 'running', at: recent, archived: true }),
    testCard('running-agent', { status: 'running', at: recent, agentRun: true, runByAgent: true }),
    testCard('waiting', { status: 'waiting', at: recent, labels: ['ui'] }),
  ];
  for (const shown of SHOW_COMBOS) {
    for (const query of ['', 'label:ui', 'is:input', 'label:none']) {
      {
        const where = `${JSON.stringify(query)} ${JSON.stringify(shown)}`;
        const drawn = railShownCards(cards, { query: pressRailLens(query, 'running') }, now);
        assert.equal(railHeadCounts(cards, shown, now, { query }).running, drawn.length, where);
        assert.equal(
          drawn.some((card) => card.archived || card.runByAgent),
          false,
          `an archived or agent-run session counts, ${where}`,
        );
      }
    }
  }
  // Under an empty query the figure is every running session the reader can pick up.
  assert.equal(railHeadCounts(cards, RAIL_SHOWN_BUCKETS, now, { query: '' }).running, 3);
});

// Use one clock for the lens list and count. Crossing the recency boundary removes a session from both.
test('a session leaving the recency window leaves the lens list and its figure on the same tick', () => {
  const before = countsNow;
  const after = countsNow + 60_000;
  const cards: RailSectionCard[] = [
    testCard('leaving', { status: 'done', unread: true, at: before - ACTIVE_WINDOW_MS + 30_000 }),
    testCard('staying', { status: 'done', unread: false, at: before - 5 * 60_000 }),
  ];
  for (const [now, active] of [
    [before, ['leaving', 'staying']],
    [after, ['staying']],
  ] as const) {
    assert.deepEqual(
      railShownCards(cards, { query: RAIL_LENS_WORDS.active }, now).map((card) => card.id),
      active,
    );
    assert.equal(railCounts(cards, RAIL_SHOWN_BUCKETS, now).active, active.length);
  }
  assert.deepEqual(
    railShownCards(cards, { query: '' }, after).map((card) => card.id),
    ['leaving', 'staying'],
  );
});

// The Active count says whether any session it counts has a warm cache or one about to go, and
// never how many. Any cache about to go chooses the expiring state over a warm one.
test('the Active button carries its session count and one aggregate cache state', () => {
  const said = (counts: { active: number; warm: number; expiring: number }) => {
    const active = railCountButtons(
      { running: 0, unread: 0, input: 0, ...counts },
      ALL_LENS,
      HEAD_WORDS,
      RAIL_LENSES,
    ).find((button) => button.kind === 'active')!;
    return [active.cacheState, active.cacheDetail, active.name];
  };
  const warm = CARD_ACTIONS.railCountCacheWarm;
  const expiring = CARD_ACTIONS.railCountCacheExpiring;
  const none = CARD_ACTIONS.railCountCacheNone;
  assert.deepEqual(said({ active: 2, warm: 1, expiring: 0 }), ['warm', warm, `Active, 2 sessions. ${warm}`]);
  assert.deepEqual(said({ active: 2, warm: 0, expiring: 1 }), [
    'nearly-gone',
    expiring,
    `Active, 2 sessions. ${expiring}`,
  ]);
  assert.deepEqual(said({ active: 5, warm: 3, expiring: 2 }), [
    'nearly-gone',
    expiring,
    `Active, 5 sessions. ${expiring}`,
  ]);
  assert.deepEqual(said({ active: 1, warm: 0, expiring: 0 }), [null, none, `Active, 1 session. ${none}`]);
});

// Count warm and expiring caches within Active. Expired caches contribute to neither count.
test('railCounts counts warm and expiring caches only over the Active sessions in scope', () => {
  const recent = countsNow - 5 * 60_000;
  const warm = { expiresAt: countsNow + 10 * 60_000, nearlyGoneAt: countsNow + 8 * 60_000 };
  const cards: RailSectionCard[] = [
    testCard('warm', { status: 'done', at: recent, cache: warm }),
    testCard('expiring', {
      status: 'done',
      at: recent,
      cache: { expiresAt: countsNow + 60_000, nearlyGoneAt: countsNow - 1 },
    }),
    testCard('gone', { status: 'done', at: recent, cache: { expiresAt: countsNow - 1, nearlyGoneAt: null } }),
    testCard('none', { status: 'done', at: recent }),
    testCard('archived-warm', { status: 'done', archived: true, at: recent, cache: warm }),
    testCard('agent-warm', { status: 'done', agentRun: true, runByAgent: true, at: recent, cache: warm }),
  ];
  const shown = { showArchived: true, showRuns: true };
  const pair = (inQuery?: (card: RailSectionCard) => boolean) => {
    const counts = railCounts(cards, shown, countsNow, { inQuery });
    return [counts.active, counts.warm, counts.expiring];
  };
  assert.deepEqual(pair(), [4, 1, 1]);
  assert.deepEqual(
    pair((card) => card.id !== 'expiring'),
    [3, 1, 0],
  );
  assert.deepEqual(
    pair((card) => card.id === 'gone' || card.id === 'none'),
    [2, 0, 0],
  );
  const scoped = cards.map((card) => ({ ...card, labels: card.id === 'expiring' ? ['beta'] : ['alpha'] }));
  {
    for (const [query, members, warmCount, expiringCount, state] of [
      ['label:alpha', ['warm', 'gone', 'none'], 1, 0, 'warm'],
      ['label:beta', ['expiring'], 0, 1, 'nearly-gone'],
      ['label:alpha label:beta', [], 0, 0, null],
    ] as const) {
      const lens = { ...ALL_LENS, query };
      const counts = railHeadCounts(scoped, shown, countsNow, lens);
      const kept = railShownCards(scoped, { query: pressRailLens(query, 'active') }, countsNow);
      assert.deepEqual(
        kept.map((card) => card.id),
        members,
        query,
      );
      assert.deepEqual([counts.active, counts.warm, counts.expiring], [members.length, warmCount, expiringCount]);
      const active = railCountButtons(counts, lens, HEAD_WORDS, RAIL_LENSES).find((button) => button.kind === 'active');
      assert.equal(active?.cacheState ?? null, state);

      assert.ok(kept.every((card) => !card.archived && !card.runByAgent));
    }
  }
});

test('railCounts counts running from is:running over the shown buckets', () => {
  const cards: RailSectionCard[] = [
    testCard('waiting', { status: 'waiting' }),
    testCard('waiting-unread', { status: 'waiting', unread: true }),
    testCard('done-unread', { status: 'done', unread: true }),
    testCard('done-read', { status: 'done', unread: false }),
    testCard('failed-unread', { status: 'failed', unread: true }),
    testCard('failed-read', { status: 'failed', unread: false }),
    testCard('interrupted', { status: 'interrupted' }),
    testCard('running', { status: 'running' }),
    testCard('running-unread', { status: 'running', unread: true }),
    testCard('subagents', { status: 'subagents' }),
    testCard('subagents-unread', { status: 'subagents', unread: true }),
    testCard('background', { status: 'background' }),
    testCard('stopped', { status: 'stopped' }),
    testCard('archived-waiting', { status: 'waiting', archived: true }),
    testCard('agent-running', { status: 'running', agentRun: true }),
  ];
  const combos = [
    { showArchived: true, showRuns: true },
    { showArchived: false, showRuns: true },
    { showArchived: true, showRuns: false },
    { showArchived: false, showRuns: false },
  ];
  for (const options of combos) {
    const shown = cards.filter(
      (card) => (options.showArchived || !card.archived) && (options.showRuns || !card.agentRun),
    );
    const counts = railCounts(cards, options, countsNow);
    assert.equal(counts.running, matchSessions(shown, 'is:running').length);
  }
});

// The Active lens holds a session whose prompt cache is still live or that recorded activity
// inside the fixed hour-long window, whichever the clock says.
test('railCardActive reads the live cache and the hour-long recency window', () => {
  const now = 10_000_000;
  assert.equal(railCardActive({ at: now - 59 * 60_000, cache: null }, now), true);
  assert.equal(railCardActive({ at: now - 61 * 60_000, cache: null }, now), false);
  // A live cache keeps an old session active even outside the window.
  assert.equal(
    railCardActive({ at: now - 5 * ACTIVE_WINDOW_MS, cache: { expiresAt: now + 60_000, nearlyGoneAt: null } }, now),
    true,
  );
  // An expired cache on a recent session still reads active from the recency window alone.
  assert.equal(
    railCardActive({ at: now - 5 * 60_000, cache: { expiresAt: now - 60_000, nearlyGoneAt: null } }, now),
    true,
  );
  // An expired cache and stale activity leave the session outside Active.
  assert.equal(
    railCardActive({ at: now - 5 * ACTIVE_WINDOW_MS, cache: { expiresAt: now - 60_000, nearlyGoneAt: null } }, now),
    false,
  );
});

// Clock-dependent query terms require clock-derived card fields, whether the query is typed or saved.
test('railQueryReadsCache answers true for both clock terms and false otherwise', () => {
  assert.equal(railQueryReadsCache('is:active'), true);
  assert.equal(railQueryReadsCache('-is:active'), true);
  assert.equal(railQueryReadsCache('is:warm'), true);
  assert.equal(railQueryReadsCache('is:unread'), false);
  assert.equal(railQueryReadsCache(''), false);
});

// `railLensHolds` has to answer the way the query grammar does, because the count sums it and
// the box can type the same words. Every card here is read both ways and the two must agree.
test('railLensHolds answers the way is:active -is:archived -is:agentrun does', () => {
  const now = 10_000_000;
  const cards: RailSectionCard[] = [
    testCard('waiting', { status: 'waiting', at: now - 5 * 60_000 }),
    testCard('unread', { status: 'done', unread: true, at: now - 5 * 60_000 }),
    testCard('read', { status: 'done', unread: false, at: now - 5 * 60_000 }),
    testCard('stale-waiting', { status: 'waiting', at: now - 2 * ACTIVE_WINDOW_MS }),
    testCard('archived-waiting', { status: 'waiting', archived: true, at: now - 5 * 60_000 }),
    testCard('agent-waiting', { status: 'waiting', agentRun: true, runByAgent: true, at: now - 5 * 60_000 }),
  ];
  for (const card of cards) {
    const stamped = { ...card, active: railCardActive(card, now) };
    const activeMatch = matchSessions([stamped], 'is:active -is:archived -is:agentrun').length > 0;
    assert.equal(railLensHolds(card, now), activeMatch, `Active disagrees for ${card.id}`);
  }
  // An archived session or agent run never matches Active, regardless of recent activity.
  assert.equal(
    railLensHolds(
      cards.find((c) => c.id === 'agent-waiting')!,
      now,
    ),
    false,
  );
  // Repeat the comparison with the shared workspace fixture. Keep n3 and r2 outside the recency window.
  const workCards: RailSectionCard[] = workspace().map((card) => ({
    ...card,
    at: card.id === 'n3' || card.id === 'r2' ? now - 2 * ACTIVE_WINDOW_MS : now - 5 * 60_000,
  }));
  for (const card of workCards) {
    const stamped = { ...card, active: railCardActive(card, now) };
    const activeMatch = matchSessions([stamped], 'is:active -is:archived -is:agentrun').length > 0;
    assert.equal(railLensHolds(card, now), activeMatch, `Active disagrees for ${card.id}`);
  }
  assert.equal(
    railCounts(workCards, RAIL_SHOWN_BUCKETS, now).active,
    workCards.filter((card) => railLensHolds(card, now)).length,
  );
});

// The Active count equals the sessions matched by the complete typed lens query.
test('railCounts.active equals the typed lens query', () => {
  const now = 10_000_000;
  const cards: RailSectionCard[] = [
    testCard('waiting', { status: 'waiting', at: now - 5 * 60_000 }),
    testCard('unread', { status: 'done', unread: true, at: now - 5 * 60_000 }),
    testCard('read', { status: 'done', unread: false, at: now - 5 * 60_000 }),
    testCard('stale-waiting', { status: 'waiting', at: now - 2 * ACTIVE_WINDOW_MS }),
    testCard('warm-stale', {
      status: 'done',
      at: now - 2 * ACTIVE_WINDOW_MS,
      cache: { expiresAt: now + 60_000, nearlyGoneAt: null },
    }),
    testCard('archived-waiting', { status: 'waiting', archived: true, at: now - 5 * 60_000 }),
    testCard('agent-waiting', { status: 'waiting', agentRun: true, runByAgent: true, at: now - 5 * 60_000 }),
  ];
  const stamped = cards.map((card) => ({ ...card, active: railCardActive(card, now) }));
  const activeCards = matchSessions(stamped, 'is:active -is:archived -is:agentrun');
  const counts = railCounts(cards, RAIL_SHOWN_BUCKETS, now);
  assert.equal(counts.active, activeCards.length);
  assert.deepEqual(
    activeCards.map((card) => card.id).sort(),
    cards
      .filter((card) => railLensHolds(card, now))
      .map((card) => card.id)
      .sort(),
  );
});

// A toggle takes a whole bucket out of the rail, which is not the same as narrowing by a
// property of a session. Off means the bucket is out of the sections, out of a saved view's
// matches and out of every figure, all on the one press.
test('a bucket the reader turned off leaves the sections and the counts together', () => {
  const cards: RailSectionCard[] = [
    testCard('live', { status: 'running' }),
    testCard('archived-run', { status: 'running', archived: true }),
    testCard('agent-run', { status: 'running', agentRun: true }),
    testCard('pinned-archived', { status: 'running', archived: true, pinnedTop: true }),
  ];
  const keeper: SavedView = {
    id: 'keeper',
    name: 'Keeper',
    query: 'is:running',
    archived: true,
  };
  const drawn = (shown: { showArchived: boolean; showRuns: boolean }, grouping: RailGrouping = {}) => {
    const ids = new Set<string>();
    for (const section of railSections(cards, sectionNow, [keeper], 'latest', shown, grouping).sections) {
      for (const card of section.cards) {
        ids.add(card.id);
      }
    }
    return [...ids].sort();
  };
  assert.deepEqual(drawn(RAIL_SHOWN_BUCKETS), ['agent-run', 'archived-run', 'live', 'pinned-archived']);
  // The view keeps archived sessions, and the reader has said they want none on screen.
  assert.deepEqual(drawn({ showArchived: false, showRuns: true }), ['agent-run', 'live']);
  assert.deepEqual(drawn({ showArchived: true, showRuns: false }), ['archived-run', 'live', 'pinned-archived']);
  assert.deepEqual(drawn({ showArchived: false, showRuns: false }), ['live']);
  // Every grouping keeps the same visibility choices.
  for (const groupBy of RAIL_GROUP_BY) {
    for (const shown of SHOW_COMBOS) {
      assert.deepEqual(drawn(shown, { groupBy }), drawn(shown));
    }
  }
  for (const shown of [
    RAIL_SHOWN_BUCKETS,
    { showArchived: false, showRuns: true },
    { showArchived: true, showRuns: false },
    { showArchived: false, showRuns: false },
  ]) {
    // The Running figure never counts an archived session, so it agrees with the drawn cards the
    // reader has not archived.
    const byId = new Map(cards.map((card) => [card.id, card]));
    assert.equal(
      railCounts(cards, shown, countsNow).running,
      drawn(shown).filter((id) => !byId.get(id)?.archived && !byId.get(id)?.runByAgent).length,
      `the Running figure and the drawn list disagree under ${JSON.stringify(shown)}`,
    );
  }
});

const HEAD_WORDS = {
  running: CARD_ACTIONS.railNarrowToValues.running,
  active: CARD_ACTIONS.railCountActive,
  unread: CARD_ACTIONS.railNarrowToValues.unread,
  input: CARD_ACTIONS.railNarrowToValues.input,
  cacheWarm: CARD_ACTIONS.railCountCacheWarm,
  cacheExpiring: CARD_ACTIONS.railCountCacheExpiring,
  cacheNone: CARD_ACTIONS.railCountCacheNone,
  session: 'session',
  sessions: 'sessions',
  runningHint: CARD_ACTIONS.railCountRunningHint,
  activeHint: CARD_ACTIONS.railCountActiveHint,
  unreadHint: CARD_ACTIONS.railCountUnreadHint,
  inputHint: CARD_ACTIONS.railCountInputHint,
  pressedHint: CARD_ACTIONS.railCountPressedHint,
};

const ALL_LENS = { filterId: ALL_RAIL_FILTER_ID, query: '' };

test('startup shows configured quick filters with restored selection and unavailable counts', () => {
  const buttons = railCountButtons(null, { ...ALL_LENS, query: RAIL_LENS_WORDS.running }, HEAD_WORDS, [
    'running',
    'active',
  ]);
  assert.deepEqual(
    buttons.map(({ kind, figure, pressed, cacheState, cacheDetail, name }) => ({
      kind,
      figure,
      pressed,
      cacheState,
      cacheDetail,
      name,
    })),
    [
      { kind: 'running', figure: '', pressed: true, cacheState: null, cacheDetail: null, name: HEAD_WORDS.running },
      { kind: 'active', figure: '', pressed: false, cacheState: null, cacheDetail: null, name: HEAD_WORDS.active },
    ],
  );
  assert.deepEqual(railCountButtons(null, ALL_LENS, HEAD_WORDS, []), []);
});

test('a lens count is pressed while the query holds its words, whatever wrote them', () => {
  for (const lens of ['running', 'active'] as const) {
    const words = RAIL_LENS_WORDS[lens];
    assert.equal(railCountPressed(lens, { ...ALL_LENS, query: words }), true);
    // A saved filter holding the words presses its count, and so do the words beside others,
    // in any order, typed by hand.
    assert.equal(railCountPressed(lens, { filterId: 'f1', query: `label:ui ${words}` }), true);
    assert.equal(railCountPressed(lens, { ...ALL_LENS, query: words.split(' ').reverse().join(' ') }), true);
    assert.equal(railCountPressed(lens, ALL_LENS), false);
    // Deleting one of the words unpresses it.
    assert.equal(railCountPressed(lens, { ...ALL_LENS, query: words.replace(' -is:agentrun', '') }), false);
  }
  // The Needs you query does not select the Active count.
  assert.equal(railCountPressed('active', { ...ALL_LENS, query: 'is:needsyou -is:archived -is:agentrun' }), false);
});

test('a selected configured zero-match lens keeps its live count and clearing action', () => {
  const zero = { running: 0, warm: 0, expiring: 0, active: 0, unread: 0, input: 0 };
  assert.deepEqual(railCountButtons(zero, ALL_LENS, HEAD_WORDS, RAIL_LENSES), []);
  for (const lens of RAIL_LENSES) {
    for (const filterId of [ALL_RAIL_FILTER_ID, 'saved']) {
      const query = `label:ui ${RAIL_LENS_WORDS[lens]}`;
      const selected = { filterId, query };
      assert.deepEqual(railCountButtons(zero, selected, HEAD_WORDS, []), [], lens);
      const buttons = railCountButtons(zero, selected, HEAD_WORDS, RAIL_LENSES);
      assert.equal(buttons.length, 1, lens);
      const [button] = buttons;
      assert.deepEqual(
        [button.kind, button.figure, button.pressed, button.hint, button.name],
        [
          lens,
          '0',
          true,
          HEAD_WORDS.pressedHint,
          `${HEAD_WORDS[lens]}, 0 ${HEAD_WORDS.sessions}${lens === 'active' ? `. ${HEAD_WORDS.cacheNone}` : ''}`,
        ],
      );
      const cleared = { ...selected, query: pressRailLens(query, lens) };
      assert.equal(cleared.query, 'label:ui');
      assert.deepEqual(railCountButtons(zero, cleared, HEAD_WORDS, RAIL_LENSES), []);
    }
  }
});

test('an unchecked positive-match lens stays hidden even when selected', () => {
  const counts = { running: 1, warm: 0, expiring: 2, active: 7, unread: 12, input: 3 };
  const controls = (query: string, ticked: readonly RailLens[]) =>
    railCountButtons(counts, { ...ALL_LENS, query }, HEAD_WORDS, ticked).map((count) => count.control);
  assert.deepEqual(controls('', ['unread', 'input']), ['railcount:unread', 'railcount:input']);
  assert.deepEqual(controls('', []), []);
  // A panel that never chose draws Running, Active and Needs input, and leaves Unread out.
  assert.deepEqual(
    railCountButtons(counts, ALL_LENS, HEAD_WORDS).map((count) => count.control),
    ['railcount:running', 'railcount:active', 'railcount:input'],
  );
  assert.deepEqual(controls(RAIL_LENS_WORDS.active, ['unread']), ['railcount:unread']);
  for (const lens of RAIL_LENSES) {
    assert.deepEqual(controls(RAIL_LENS_WORDS[lens], []), [], lens);
  }
});

// A reader who set Unread or Needs input from the View menu sees it pressed on the closed head
// and clears it with one press. The other counts stay beside it.
test('the rail head draws the Unread or Needs input lens the rail is on pressed, beside the others', () => {
  const counts = { running: 1, warm: 0, expiring: 2, active: 7, unread: 12, input: 3 };
  const head = (query: string) => railCountButtons(counts, { ...ALL_LENS, query }, HEAD_WORDS, RAIL_LENSES);
  assert.deepEqual(head(withRailLens('label:ui', 'unread'))[2], {
    kind: 'unread',
    control: 'railcount:unread',
    label: 'Unread',
    figure: '12',
    cacheState: null,
    cacheDetail: null,
    pressed: true,
    name: 'Unread, 12 sessions',
    hint: 'Show every session again',
  });
  const input = head(RAIL_LENS_WORDS.input)[3];
  assert.deepEqual(
    [input.control, input.label, input.cacheState, input.pressed, input.name],
    ['railcount:input', 'Needs input', null, true, 'Needs input, 3 sessions'],
  );
  // The cache state sits on Active only, under any query.
  for (const [query, pressed] of [
    [RAIL_LENS_WORDS.active, true],
    ['', false],
    ['is:unread label:ui', false],
    [RAIL_LENS_WORDS.unread, false],
  ] as const) {
    assert.deepEqual(
      head(query).map((count) => [count.control, count.cacheState]),
      [
        ['railcount:running', null],
        ['railcount:active', 'nearly-gone'],
        ['railcount:unread', null],
        ['railcount:input', null],
      ],
      query,
    );
    assert.equal(head(query)[1].pressed, pressed, query);
  }
  // A query containing two complete lenses selects no count and checks All. Its typed query remains intact.
  const old = 'is:input is:unread -is:archived -is:agentrun label:ui';
  const [first] = head(old);
  assert.deepEqual(
    head(old).map((count) => count.pressed),
    [false, false, false, false],
  );
  const checked = railNarrowToRow(old, CARD_ACTIONS.railNarrowToValues).find((value) => value.checked);
  assert.equal(checked?.value, 'all');
  assert.equal(pressRailLens(old, first.kind), `${RAIL_LENS_WORDS.running} label:ui`);
});

// An Unread press replaces the typed Needs input lens. Its count includes both unread sessions, regardless of waiting state.
test('each head figure equals what its own press draws under a typed bare is:input', () => {
  const now = countsNow;
  const cards: RailSectionCard[] = [
    testCard('unread-waiting', { status: 'waiting', unread: true }),
    testCard('unread-done', { status: 'done', unread: true }),
    testCard('read-done', { status: 'done' }),
  ];
  const rail = { query: 'is:input' };
  const counts = railHeadCounts(cards, RAIL_SHOWN_BUCKETS, now, rail);
  assert.equal(counts.unread, 2);
  for (const lens of ['unread', 'input'] as const) {
    const drawn = railShownCards(cards, { ...rail, query: pressRailLens(rail.query, lens) }, now);
    assert.equal(counts[lens], drawn.length, lens);
  }
});

test('the Quick filters boxes name each lens and tick the chosen lenses', () => {
  assert.deepEqual(
    railHeadLensBoxes(['input', 'active'], CARD_ACTIONS.railNarrowToValues).map((box) => [
      box.control,
      box.label,
      box.checked,
    ]),
    [
      ['railheadlens:running', 'Running', false],
      ['railheadlens:active', 'Active', true],
      ['railheadlens:unread', 'Unread', false],
      ['railheadlens:input', 'Needs input', true],
    ],
  );
  assert.deepEqual(withRailHeadLensToggled(['input'], 'active'), ['active', 'input']);
  assert.deepEqual(withRailHeadLensToggled(['active', 'input'], 'active'), ['input']);
});

// Legacy railHeadLenses imports add Running. Explicit railQuickFilters values preserve the selected list, including an empty list.
test('normalizeRailQuickFilters adds Running to a legacy list and keeps a new empty choice', () => {
  const all = ['running', 'active', 'unread', 'input'];
  assert.deepEqual(normalizeRailQuickFilters(undefined), ['running', 'active', 'input']);
  assert.deepEqual(normalizeRailQuickFilters(undefined, undefined), ['running', 'active', 'input']);
  assert.deepEqual(normalizeRailQuickFilters('active', 'active'), ['running', 'active', 'input']);
  assert.deepEqual(normalizeRailQuickFilters(undefined, ['active', 'unread', 'input']), all);
  assert.deepEqual(normalizeRailQuickFilters(undefined, ['unread']), ['running', 'unread']);
  assert.deepEqual(normalizeRailQuickFilters(undefined, []), ['running']);
  assert.deepEqual(normalizeRailQuickFilters([]), []);
  assert.deepEqual(normalizeRailQuickFilters(['input', 'bogus']), ['input']);
  assert.deepEqual(normalizeRailQuickFilters(['unread', 'running'], ['active']), ['running', 'unread']);
  assert.deepEqual(normalizeRailQuickFilters([], ['active', 'unread', 'input']), []);
  assert.deepEqual(normalizeRailQuickFilters(['input', 'bogus']), ['input']);
  assert.deepEqual(normalizeRailQuickFilters(['input', 'needs-you', 7, 'active', 'input']), ['active', 'input']);
});

test('the rail-row saved words fall back to what a panel drawn before this build already showed', () => {
  assert.deepEqual(RAIL_DENSITIES, ['comfortable', 'compact']);
  assert.equal(normalizeRailDensity(undefined), 'comfortable');
  assert.equal(normalizeRailDensity('roomy'), 'comfortable');
  assert.equal(normalizeRailDensity('compact'), 'compact');

  assert.deepEqual(RAIL_GROUP_BY, ['time', 'label', 'agent', 'status', 'none']);
  assert.equal(normalizeRailGroupBy(undefined), 'time');
  assert.equal(normalizeRailGroupBy('folder'), 'time');
  for (const value of RAIL_GROUP_BY) {
    assert.equal(normalizeRailGroupBy(value), value);
  }

  assert.equal(normalizeRailShowArchived(undefined), true);
  assert.equal(normalizeRailShowArchived('no'), true);
  assert.equal(normalizeRailShowArchived(true), true);
  assert.equal(normalizeRailShowArchived(false), false);

  assert.equal(normalizeRailShowRuns(undefined), true);
  assert.equal(normalizeRailShowRuns(0), true);
  assert.equal(normalizeRailShowRuns(true), true);
  assert.equal(normalizeRailShowRuns(false), false);
});

// Compact rows use short ages. Full rows use long ages. The tick uses the same formatter as the drawn row.
test('each density draws its own age, and the tick compares with it', () => {
  const now = Date.UTC(2026, 8, 24, 12, 0);
  const at = now - 2 * 3600 * 1000;
  assert.equal(railAgeFormat('compact')(at, now), '2h');
  assert.equal(railAgeFormat('comfortable')(at, now), '2 hours ago');
  const rows = [{ id: 'railrow-a', card: { at: now - 59_000, cache: null, status: null, runningSince: null } }];
  assert.equal(railTickWork(rows, now, now + 500, now, railAgeFormat('compact')).redraw, false);
  assert.equal(railTickWork(rows, now, now + 1_000, now, railAgeFormat('compact')).redraw, true);
});

// A compact row drops the agent word, the figures and the labels from its drawing, so its
// hover opens the card under the session's name. A comfortable row draws them and gains no
// hover, and a state hint stays in both densities.
test("a compact card's hover opens the card under its name, and a state hint stays in both densities", () => {
  const card = {
    label: 'Fix login (retry)',
    agentWord: 'Codex',
    nameAfterAge: '$1.20 estimated, 4 turns, labelled release',
  };
  const state = { hint: 'Subagents still running', detail: 'Takes a prompt now' };
  assert.deepEqual(railCardHint(card, 'comfortable', null), { lines: false });
  assert.deepEqual(railCardHint(card, 'comfortable', state), { ...state, lines: false });
  const compact = railCardHint(card, 'compact', null);
  assert.equal(compact.body, 'railcard');
  assert.equal(compact.hint, 'Fix login (retry)', 'the card did not lead with the whole name');
  assert.equal(railCardHint({ ...card, name: 'A longer drawn name' }, 'compact', null).hint, 'A longer drawn name');
  const both = railCardHint(card, 'compact', state);
  assert.equal(both.body, 'railcard');
  assert.equal(both.hint, card.label, 'a compact state card led with its state rather than its name');
  assert.ok(both.detail?.includes(state.detail) && both.detail.includes(card.nameAfterAge), both.detail);
  const bare = railCardHint({ label: card.label, agentWord: '', nameAfterAge: '' }, 'compact', state);
  assert.deepEqual(bare, { hint: card.label, detail: state.detail, lines: false, body: 'railcard' });
});

// Accessible names include the agent, figures and labels in both densities. Descriptions omit those repeated words and retain the state explanation.
test("a compact card's linked description never repeats what the name already says", () => {
  const card = { label: 'Fix login', agentWord: 'Codex', nameAfterAge: '$1.20 estimated, 4 turns, labelled release' };
  assert.equal(railCardHint(card, 'comfortable', null).description, undefined);
  const compactPlain = railCardHint(card, 'compact', null);
  assert.equal(compactPlain.description, '', 'a compact card with only dropped words kept a linked description');
  const state = { hint: 'Subagents still running', detail: 'Takes a prompt now' };
  assert.equal(railCardHint(card, 'comfortable', state).description, undefined);
  const compactState = railCardHint(card, 'compact', state);
  assert.equal(compactState.description, state.detail);
  assert.ok(!compactState.description!.includes(card.agentWord), compactState.description);
  assert.ok(!compactState.description!.includes(card.nameAfterAge), compactState.description);
});

// A compact row with only an agent word needs no second detail line or linked description. Its hover still shows the card.
test('a compact card with one dropped word carries no detail and no description', () => {
  const hint = railCardHint({ label: 'Fix login', agentWord: 'Codex', nameAfterAge: '' }, 'compact', null);
  assert.equal(hint.hint, 'Fix login');
  assert.equal(hint.body, 'railcard');
  assert.equal(hint.detail, undefined, 'a single dropped word wrote a second hover line');
  assert.equal(hint.description, undefined, 'a single dropped word linked an empty description');
});

const HOVER_NOW = Date.UTC(2026, 8, 26, 14, 42);
const hoverCard = (over: Partial<RailHoverCard> = {}): RailHoverCard => ({
  label: 'Embedded agent input',
  agent: 'Claude',
  agentWord: 'Claude',
  status: 'waiting',
  subagents: null,
  commands: null,
  runningSince: null,
  unsentWord: null,
  at: HOVER_NOW - 10 * 60_000,
  labels: ['composer', 'release 0.4', 'perf'],
  ...over,
});
const hover = (card: RailHoverCard): RailHoverLines => railHoverLines(card, HOVER_NOW, CARD_ACTIONS);
const partsOf = (lines: RailHoverLines): string[] => lines.meta.map((part) => `${part.kind}:${part.text}`);

// The card a compact row opens on hover says, in full, what the row cut: the name, then a
// meta line, then the labels. A waiting card's meta line is its agent, its state word and its
// long age. The figures are the rail's own figure line, which the card draws beside these
// words, so the words carry no figure at all.
test('the compact hover card words a waiting session as its agent, state word and long age', () => {
  const lines = hover(hoverCard({ name: 'Fix login (retry)' }));
  assert.equal(lines.name, 'Fix login (retry)');
  assert.deepEqual(partsOf(lines), [
    'agent:Claude',
    'state:needs input',
    `age:${formatRelative(HOVER_NOW - 10 * 60_000, HOVER_NOW)}`,
  ]);
  assert.equal(lines.meta.find((part) => part.kind === 'state')?.className, 'railstatus waiting');
  assert.equal(lines.meta.find((part) => part.kind === 'age')?.at, HOVER_NOW - 10 * 60_000);
  assert.deepEqual(Object.keys(lines).sort(), ['labels', 'meta', 'name', 'note'], 'the hover words carried figures');
  assert.deepEqual(lines.labels, { shown: ['composer', 'release 0.4', 'perf'], more: null });
  assert.equal(lines.note, null);
  assert.ok(!lines.meta.some((part) => /showing now|nothing new/.test(part.text)), partsOf(lines).join());
});

test('the compact hover card leaves out labels a session does not have', () => {
  const lines = hover(hoverCard({ labels: [], status: null }));
  assert.deepEqual(lines.labels, { shown: [], more: null });
  assert.equal(lines.note, null);
  assert.ok(!lines.meta.some((part) => part.kind === 'state'), partsOf(lines).join());
});

// A running session with a recorded start shows no age. Its state word gains how long it has
// run after the first minute. The duration is the part the panel clock rewrites, so it
// arrives apart from the words before it. A running session with no recorded start keeps its
// age.
test('a running session with a recorded start shows its duration and no age', () => {
  const since = HOVER_NOW - 31 * 60_000;
  const running = hover(hoverCard({ status: 'running', runningSince: since, labels: ['release 0.4'] }));
  assert.deepEqual(partsOf(running), ['agent:Claude', 'state:running for 31m']);
  const state = running.meta[1];
  assert.equal(state.runningSince, since);
  assert.equal(state.duration, runningFor(since, HOVER_NOW));
  assert.ok(state.text.endsWith(`${state.lead}${state.duration}`), state.text);
  const fresh = hover(hoverCard({ status: 'running', runningSince: HOVER_NOW - 30_000 }));
  assert.deepEqual(partsOf(fresh), ['agent:Claude', 'state:running']);
  assert.equal(fresh.meta[1].duration, '');
  assert.equal(fresh.meta[1].runningSince, HOVER_NOW - 30_000, 'a run in its first minute carried no clock mark');
  const unknown = hover(hoverCard({ status: 'running', runningSince: null }));
  assert.equal(unknown.meta[1].runningSince, undefined, 'a run with no recorded start carried a clock mark');
  assert.equal(unknown.meta.at(-1)?.kind, 'age', 'a run with no recorded start lost its age');
});

test('the compact hover card folds labels past eight into a count', () => {
  const labels = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'hooks', 'composer'];
  const lines = hover(hoverCard({ labels }));
  assert.deepEqual(lines.labels.shown, labels.slice(0, 8));
  assert.equal(lines.labels.more, '+2 more');
});

// A `subagents` or `background` card leads with its name like every other, and its state
// explanation takes its own line under the meta line.
test('a subagents or background card explains its state under the meta line', () => {
  const subagents = hover(hoverCard({ status: 'subagents', subagents: 2, labels: [] }));
  assert.deepEqual(partsOf(subagents), ['agent:Claude', `state:${subagentsStillRunning(2)}`]);
  assert.equal(subagents.note, subagentsHintDetail(2));
  const background = hover(hoverCard({ status: 'background', commands: 1, labels: ['perf'] }));
  assert.deepEqual(partsOf(background), ['agent:Claude', 'state:1 background command still running']);
  assert.equal(background.note, backgroundCommandsHintDetail(1));
  assert.deepEqual(background.labels.shown, ['perf']);
});

test('the hover meta line names an agent run, a failure and an unsent draft', () => {
  const run = hover(hoverCard({ agentWord: CARD_ACTIONS.agentRun, status: null }));
  assert.deepEqual(partsOf(run).slice(0, 2), ['agent:Claude', 'agentRun:run by an agent']);
  const failed = hover(hoverCard({ status: 'failed', unsentWord: 'unsent' }));
  assert.deepEqual(partsOf(failed), [
    'agent:Claude',
    'state:failed',
    'unsent:unsent',
    `age:${formatRelative(HOVER_NOW - 10 * 60_000, HOVER_NOW)}`,
  ]);
  assert.equal(failed.meta[1].className, 'railstatus failed');
});

test('rail sort comparators rank costs and attention deterministically', () => {
  const cards: RailSectionCard[] = [
    {
      id: 'floor',
      at: 3,
      pinnedTop: false,
      current: false,
      archived: false,
      label: 'Floor',
      agent: 'Claude',
      costDollars: 2,
      costAtLeast: true,
      status: 'done',
      unread: false,
    },
    {
      id: 'exact',
      at: 2,
      pinnedTop: false,
      current: false,
      archived: false,
      label: 'Exact',
      agent: 'Claude',
      costDollars: 2,
      costAtLeast: false,
      status: 'done',
      unread: false,
    },
    {
      id: 'missing',
      at: 9,
      pinnedTop: false,
      current: false,
      archived: false,
      label: 'Missing',
      agent: 'Claude',
      costDollars: null,
      status: 'running',
      unread: false,
    },
    {
      id: 'input',
      at: 1,
      pinnedTop: false,
      current: false,
      archived: false,
      label: 'Input',
      agent: 'Claude',
      costDollars: 1,
      status: 'waiting',
      unread: true,
    },
    {
      id: 'unread',
      at: 4,
      pinnedTop: false,
      current: false,
      archived: false,
      label: 'Unread',
      agent: 'Claude',
      costDollars: 1,
      status: 'running',
      unread: true,
    },
  ];
  assert.deepEqual(
    sortRailCards(cards, 'cost-desc').map((card) => card.id),
    ['floor', 'exact', 'unread', 'input', 'missing'],
  );
  assert.deepEqual(
    sortRailCards(cards, 'cost-asc').map((card) => card.id),
    ['unread', 'input', 'exact', 'floor', 'missing'],
  );
  assert.deepEqual(
    sortRailCards(cards, 'needs-you').map((card) => card.id),
    ['input', 'unread', 'missing', 'floor', 'exact'],
  );
  // A session whose subagents still run ranks with the running ones.
  const subagents: RailSectionCard = {
    id: 'subagents',
    at: 0,
    pinnedTop: false,
    current: false,
    archived: false,
    label: 'Subagents',
    agent: 'Claude',
    costDollars: null,
    status: 'subagents',
    unread: false,
  };
  assert.deepEqual(
    sortRailCards([...cards, subagents], 'needs-you').map((card) => card.id),
    ['input', 'unread', 'missing', 'subagents', 'floor', 'exact'],
  );
});

test('rail sorting changes only completed section card order and permits a view override', () => {
  const cards = workspace();
  const costly = testView({ id: 'costly', query: 'label:composer', sort: 'cost-desc' });
  const latest = testView({ id: 'latest', query: 'label:composer', sort: 'inherit' });
  const base = railSections(cards, sectionNow, [costly, latest], 'latest');
  const sorted = railSections(cards, sectionNow, [costly, latest], 'latest');
  assert.deepEqual(
    sorted.sections.map((section) => [section.id, section.count, section.name]),
    base.sections.map((section) => [section.id, section.count, section.name]),
  );
  assert.deepEqual(sorted.folded, base.folded);
  assert.deepEqual(
    named(sorted.sections, viewFoldId(costly)).cards.map((card) => card.id),
    ['c2', 'pin', 'c1'],
  );
  assert.deepEqual(
    named(sorted.sections, viewFoldId(latest)).cards.map((card) => card.id),
    ['pin', 'c1', 'c2'],
  );
});

test('rail buckets use calendar boundaries and keep exceptional groups separate', () => {
  const now = new Date(2026, 7, 27, 15, 30).getTime();
  const at = (days: number, hour = 12): number => new Date(2026, 7, 27 - days, hour).getTime();
  const card = (id: string, days: number, extra: Record<string, unknown> = {}) => ({
    id,
    at: at(days),
    pinnedTop: false,
    current: false,
    archived: false,
    ...extra,
  });
  const grouped = railBuckets(
    [
      card('pin', 40, { pinnedTop: true }),
      card('today', 0),
      card('yesterday', 1),
      card('week', 5),
      card('older', 30),
      card('agent', 0, { agentRun: true }),
      card('archived', 0, { archived: true }),
    ],
    now,
  );
  assert.deepEqual(
    grouped.buckets.map((bucket) => [bucket.id, bucket.label]),
    [
      ['top', 'Pinned'],
      ['today', 'Today'],
      ['yesterday', 'Yesterday'],
      ['week', 'Last 7 days'],
      ['older', 'Older'],
      ['agent', 'Run by agents'],
      ['archived', 'Archived'],
    ],
  );
  assert.equal(grouped.olderFolded, true);
  assert.equal(grouped.agentFolded, true);
  assert.equal(railBuckets([card('old', 30, { current: true })], now).olderFolded, false);
});

const sectionNow = new Date(2026, 7, 27, 15, 30).getTime();
const sectionAt = (days: number): number => new Date(2026, 7, 27 - days, 12).getTime();

function testCard(id: string, extra: Partial<RailSectionCard> = {}): RailSectionCard {
  return {
    id,
    label: id,
    at: sectionAt(0),
    pinnedTop: false,
    current: false,
    archived: false,
    agent: 'Claude',
    costDollars: null,
    costAtLeast: false,
    ...extra,
  };
}

function testView(over: Partial<SavedView> = {}): SavedView {
  return { id: 'v1', name: 'Composer', query: 'label:composer', archived: false, ...over };
}

// One workspace every section test reads: two sessions the reader put aside, four carrying
// labels, and four carrying none that fall across three time buckets.
function workspace(): RailSectionCard[] {
  return [
    testCard('pin', { pinnedTop: true, labels: ['Composer'], costDollars: 3 }),
    testCard('arch', { archived: true, labels: ['Composer'], costDollars: 4 }),
    testCard('c1', { labels: ['Composer'], costDollars: 1.87 }),
    testCard('c2', { labels: ['Composer', 'Release 0.4'], costDollars: 6.1 }),
    testCard('r1', { labels: ['Release 0.4'] }),
    testCard('r2', { labels: ['Release 0.4'], costDollars: 2, agent: 'Codex' }),
    testCard('n1', { costDollars: 1 }),
    testCard('n2', { costDollars: 1 }),
    testCard('n3', { at: sectionAt(30), costDollars: 1 }),
    testCard('n4', { agentRun: true, runByAgent: true, costDollars: 1, agent: 'Codex' }),
  ];
}

const shape = (sections: readonly RailSection<RailSectionCard>[]) =>
  sections.map((one) => [one.id, one.label, one.cards.map((card) => card.id)]);

function named(sections: readonly RailSection<RailSectionCard>[], id: string): RailSection<RailSectionCard> {
  const found = sections.find((one) => one.id === id);
  assert.ok(found, `no section is filed under ${id}`);
  return found;
}

test('a rail with no view keeps exactly the buckets it has today', () => {
  const { sections, folded } = railSections(workspace(), sectionNow, []);
  assert.deepEqual(shape(sections), [
    [RAIL_FOLDS.top, 'Pinned', ['pin']],
    [RAIL_FOLDS.today, 'Today', ['c1', 'c2', 'r1', 'r2', 'n1', 'n2']],
    [RAIL_FOLDS.older, 'Older', ['n3']],
    [RAIL_FOLDS.agent, 'Run by agents', ['n4']],
    [RAIL_FOLDS.archived, 'Archived', ['arch']],
  ]);
  assert.deepEqual(folded, {
    [RAIL_FOLDS.top]: false,
    [RAIL_FOLDS.today]: false,
    [RAIL_FOLDS.older]: true,
    [RAIL_FOLDS.agent]: true,
    [RAIL_FOLDS.archived]: true,
  });
});

test('a pinned structural child stays in the pinned section', () => {
  const child = testCard('child', { agentRun: true, pinnedTop: true });
  const { sections } = railSections([child], sectionNow, []);
  assert.deepEqual(shape(sections), [[RAIL_FOLDS.top, 'Pinned', ['child']]]);
});

test('a view takes its own section between Pinned and the time buckets', () => {
  const view = testView();
  const { sections } = railSections(workspace(), sectionNow, [view]);
  assert.deepEqual(
    shape(sections).map((one) => one[0]),
    [RAIL_FOLDS.top, viewFoldId(view), RAIL_FOLDS.today, RAIL_FOLDS.older, RAIL_FOLDS.agent, RAIL_FOLDS.archived],
  );
  // The sessions the query matched leave the time buckets, and the rest stay in them.
  assert.deepEqual(
    named(sections, viewFoldId(view)).cards.map((card) => card.id),
    ['pin', 'c1', 'c2'],
  );
  assert.deepEqual(
    named(sections, RAIL_FOLDS.today).cards.map((card) => card.id),
    ['r1', 'r2', 'n1', 'n2'],
  );
});

test('a view matches a pinned session while time buckets keep it out', () => {
  const view = testView();
  const { sections } = railSections(workspace(), sectionNow, [view]);
  assert.deepEqual(
    named(sections, RAIL_FOLDS.top).cards.map((card) => card.id),
    ['pin'],
  );
  assert.deepEqual(
    named(sections, viewFoldId(view)).cards.map((card) => card.id),
    ['pin', 'c1', 'c2'],
  );
  const timed = sections.filter(
    (one) => Object.values(RAIL_FOLDS).includes(one.id) && one.id !== RAIL_FOLDS.top && one.id !== RAIL_FOLDS.archived,
  );
  assert.equal(
    timed.some((one) => one.cards.some((card) => card.id === 'pin')),
    false,
  );
});

test('a session two views match appears under both', () => {
  const composer = testView({ id: 'v1', name: 'Composer', query: 'label:composer' });
  const release = testView({ id: 'v2', name: 'Release 0.4', query: 'label:"release 0.4"' });
  const { sections } = railSections(workspace(), sectionNow, [composer, release]);
  assert.deepEqual(
    named(sections, viewFoldId(composer)).cards.map((card) => card.id),
    ['pin', 'c1', 'c2'],
  );
  assert.deepEqual(
    named(sections, viewFoldId(release)).cards.map((card) => card.id),
    ['c2', 'r1', 'r2'],
  );
  // Claimed once or twice, a session still leaves the time buckets.
  assert.deepEqual(
    named(sections, RAIL_FOLDS.today).cards.map((card) => card.id),
    ['n1', 'n2'],
  );
});

test('a view keeps archived sessions only when it says it does', () => {
  const away = testView({ archived: false });
  const kept = testView({ archived: true });
  assert.deepEqual(
    named(railSections(workspace(), sectionNow, [away]).sections, viewFoldId(away)).cards.map((card) => card.id),
    ['pin', 'c1', 'c2'],
  );
  assert.deepEqual(
    named(railSections(workspace(), sectionNow, [kept]).sections, viewFoldId(kept)).cards.map((card) => card.id),
    ['pin', 'c1', 'c2', 'arch'],
  );
  // The Archived section retains its session whether the view includes archived sessions or excludes them.
  assert.deepEqual(
    named(railSections(workspace(), sectionNow, [kept]).sections, RAIL_FOLDS.archived).cards.map((card) => card.id),
    ['arch'],
  );
});

test('a view whose query matches nothing keeps its heading, folded and saying so', () => {
  const empty = testView({ query: 'label:nothing' });
  const { sections, folded } = railSections(workspace(), sectionNow, [empty]);
  const section = named(sections, viewFoldId(empty));
  assert.equal(section.count, 0);
  assert.equal(section.name, 'Composer, 0 sessions');
  assert.equal(folded[viewFoldId(empty)], true);
  // A view holding sessions starts open beside it.
  const full = testView({ id: 'v2', query: 'label:composer' });
  assert.equal(railSections(workspace(), sectionNow, [full]).folded[viewFoldId(full)], false);
});

test('section names contain only their label and session count', () => {
  const composerView = testView();
  const releaseView = testView({ id: 'v2', name: 'Release 0.4', query: 'label:"release 0.4"' });
  const { sections } = railSections(workspace(), sectionNow, [composerView, releaseView]);
  const composer = named(sections, viewFoldId(composerView));
  assert.equal(composer.name, 'Composer, 3 sessions');
  const release = named(sections, viewFoldId(releaseView));
  assert.equal(release.name, 'Release 0.4, 3 sessions');
  const pinned = named(sections, RAIL_FOLDS.top);
  assert.equal(pinned.name, 'Pinned, 1 session');
  const today = named(sections, RAIL_FOLDS.today);
  assert.equal(today.name, 'Today, 2 sessions');
  const older = named(sections, RAIL_FOLDS.older);
  assert.equal(older.name, 'Older, 1 session');
  const archived = named(sections, RAIL_FOLDS.archived);
  assert.equal(archived.name, 'Archived, 1 session');
});

test('a view writes its fold under its own id, so a rename cannot lose it', () => {
  const view = testView({ id: 'v7' });
  assert.equal(viewFoldId(view), 'railgroup:view:v7');
  assert.equal(viewFoldId({ ...view, name: 'Another name' }), 'railgroup:view:v7');
});

test('a clock tick reads the rows a draw put on screen and asks for one repaint', () => {
  const minute = 60_000;
  const drawnAt = 1_000_000;
  const card = (at: number, extra: Partial<RailTickCard> = {}): RailTickCard => ({
    at,
    status: null,
    runningSince: null,
    cache: null,
    ...extra,
  });
  const rows = [
    { id: 'railrow-fresh', card: card(drawnAt) },
    { id: 'railrow-old', card: card(drawnAt - 40 * minute) },
  ];
  assert.deepEqual(railTickWork(rows, drawnAt, drawnAt + 1_000), { redraw: false, titles: [] });
  assert.equal(
    railTickWork(rows, drawnAt, drawnAt + minute).redraw,
    true,
    'a card whose age wording moved asks for no repaint',
  );
  assert.equal(
    railTickWork([], drawnAt, drawnAt + 10 * minute).redraw,
    false,
    'a rail with no drawn row asks for a repaint of nothing',
  );
});

test('a card under a shut heading is left out of the rows a draw records', () => {
  const card = (id: string): RailTickCard & { id: string } => ({
    id,
    at: 1_000_000,
    status: null,
    runningSince: null,
    cache: null,
  });
  const sections = [
    { id: 'railtoday', cards: [card('s1'), card('s2')] },
    { id: 'railarchived', cards: [card('s2'), card('s3')] },
  ];
  const repeated = new Map([['railarchived', new Set(['s2'])]]);
  const rowId = (bucket: string, id: string, repeat: boolean) => `${bucket}/${id}${repeat ? '/again' : ''}`;
  assert.deepEqual(
    railDrawnRows(sections, { railarchived: true }, repeated, rowId).rows.map((row) => row.id),
    ['railtoday/s1', 'railtoday/s2'],
    'a card under a shut heading reaches the clock, which asks for a repaint nobody can see',
  );
  assert.deepEqual(
    railDrawnRows(sections, {}, repeated, rowId).rows.map((row) => row.id),
    ['railtoday/s1', 'railtoday/s2', 'railarchived/s2/again', 'railarchived/s3'],
    'an open heading loses its rows, or a card drawn twice takes one id for both',
  );
});

test('status grouping keeps partial zero attention outside the read group', () => {
  const card = { id: 'partial', label: 'Partial', agent: 'Codex', at: 1_000_000, unread: null };
  const { sections } = railSections([card], 1_000_000, [], 'latest', RAIL_SHOWN_BUCKETS, { groupBy: 'status' });
  assert.equal(sections.find((section) => section.cards.includes(card))?.label, 'Unread');
});

test('a section draws 200 rows a step and leaves the rest under its press', () => {
  assert.equal(RAIL_ROW_STEP, 200);
  const card = (id: string): RailTickCard & { id: string } => ({
    id,
    at: 1_000_000,
    status: null,
    runningSince: null,
    cache: null,
  });
  const cards = (n: number) => Array.from({ length: n }, (_, i) => card(`s${i}`));
  const sections = [
    { id: 'railtoday', cards: cards(450) },
    { id: 'railsmall', cards: cards(120) },
    { id: 'railshut', cards: cards(300) },
  ];
  const rowId = (bucket: string, id: string) => `${bucket}/${id}`;
  const drawAfter = (steps: number) => {
    const { rows, left } = railDrawnRows(sections, { railshut: true }, new Map(), rowId, (section, count) =>
      railRowsDrawn(section, steps, count),
    );
    const count = (id: string) => rows.filter((row) => row.bucket === id).length;
    return {
      drawn: [count('railtoday'), count('railsmall'), count('railshut')],
      left: Object.fromEntries(left),
    };
  };
  assert.deepEqual(drawAfter(0), { drawn: [200, 120, 0], left: { railtoday: 250 } });
  assert.deepEqual(drawAfter(1), { drawn: [400, 120, 0], left: { railtoday: 50 } });
  assert.deepEqual(drawAfter(2), { drawn: [450, 120, 0], left: {} });
  assert.deepEqual(drawAfter(5), { drawn: [450, 120, 0], left: {} });
  const first = railDrawnRows(sections, { railshut: true }, new Map(), rowId, (section, count) =>
    railRowsDrawn(section, 0, count),
  ).rows;
  assert.equal(first[199].id, 'railtoday/s199', 'a section draws its first cards, in its own order');
  assert.equal(first[200].id, 'railsmall/s0', 'the next section starts right after the ceiling');
});

test('a section draws through its current card, and Pinned draws every card', () => {
  const card = (id: string): RailTickCard & { id: string } => ({
    id,
    at: 1_000_000,
    status: null,
    runningSince: null,
    cache: null,
  });
  const cards = (n: number) => Array.from({ length: n }, (_, i) => card(`s${i}`));
  const sections = [
    { id: 'railolder', cards: cards(2000) },
    { id: 'railpinned', cards: cards(450) },
  ];
  const current = new Map([['railolder', 1234]]);
  const drawAfter = (steps: number) => {
    const { rows, left } = railDrawnRows(
      sections,
      {},
      new Map(),
      (bucket, id) => `${bucket}/${id}`,
      (section, count) => railRowsDrawn(section, steps, count, current.get(section) ?? -1),
    );
    return {
      drawn: [
        rows.filter((row) => row.bucket === 'railolder').length,
        rows.filter((row) => row.bucket === 'railpinned').length,
      ],
      left: Object.fromEntries(left),
    };
  };
  assert.deepEqual(
    drawAfter(0),
    { drawn: [1400, 450], left: { railolder: 600 } },
    'the current session has no row until enough presses reach it, or a pin lands under the press',
  );
  assert.equal(railRowsDrawn('railolder', 7, 2000, 1234), 1600, 'a press from the current row adds one step');
  assert.equal(
    railRowsDrawn('railolder', 0, 2000, 199),
    200,
    'a current card at the end of the first step takes a second step',
  );
  assert.equal(railRowsDrawn('railolder', 0, 1300, 1234), 1300, 'the reach passes the section');
});

test('a running card asks for a repaint when its duration begins and grows', () => {
  const drawnAt = 1_000_000;
  const running: RailTickCard = {
    at: drawnAt,
    status: 'running',
    runningSince: drawnAt - 30_000,
    cache: null,
  };
  const rows = [{ id: 'railrow-running', card: running }];
  assert.equal(railTickWork(rows, drawnAt, drawnAt + 10_000).redraw, false);
  assert.equal(
    railTickWork(rows, drawnAt, drawnAt + 31_000).redraw,
    true,
    'the first minute of a run does not reach the card',
  );
});

test('a cache tooltip travels as a text to write, and its state change asks for a repaint', () => {
  const drawnAt = 1_000_000;
  const cached: RailTickCard = {
    at: drawnAt - 3 * 24 * 60 * 60_000,
    status: null,
    runningSince: null,
    cache: { expiresAt: drawnAt + 45 * 60_000, nearlyGoneAt: drawnAt + 40 * 60_000 },
  };
  const rows = [{ id: 'railrow-cached', card: cached }];
  assert.deepEqual(railTickWork(rows, drawnAt, drawnAt + 60_000), {
    redraw: false,
    titles: [{ id: 'railrow-cached', text: 'Cache warm for another 44m' }],
  });
  const written = railTickWork(rows, drawnAt, drawnAt + 50_000, drawnAt + 30_000);
  assert.deepEqual(written.titles, [], 'a tooltip already written is written again every tick');
  assert.equal(
    railTickWork(rows, drawnAt, drawnAt + 41 * 60_000).redraw,
    true,
    'a cache that has nearly gone keeps the face it was drawn with',
  );
  assert.equal(railCacheState(cached.cache, drawnAt + 46 * 60_000), null);
  assert.equal(railCacheTitle(cached.cache!, drawnAt + 44 * 60_000), 'Cache expiring about now');
});

// Group the shared workspace. pin is pinned, c2 has two labels, r2 and n4 use Codex, n4 is agent-run, and arch is archived.
const grouped = (groupBy: RailGroupBy, extra: Partial<RailGrouping> = {}) =>
  railSections(workspace(), sectionNow, [], 'latest', RAIL_SHOWN_BUCKETS, { groupBy, ...extra });

test('Group by Label draws one group per label, newest first, then Unlabelled folded', () => {
  const cards = workspace().map((card) =>
    card.id === 'r1' ? { ...card, at: sectionNow - 60_000 } : card.id === 'c1' ? { ...card, at: sectionAt(2) } : card,
  );
  const { sections, folded } = railSections(cards, sectionNow, [], 'latest', RAIL_SHOWN_BUCKETS, { groupBy: 'label' });
  assert.deepEqual(shape(sections), [
    [RAIL_FOLDS.top, 'Pinned', ['pin']],
    // Release 0.4 holds the newest session, so it leads even though Composer is the larger group.
    ['railgroup:label:release 0.4', 'Release 0.4', ['c2', 'r1', 'r2']],
    ['railgroup:label:composer', 'Composer', ['pin', 'c1', 'c2']],
    ['railgroup:label:', 'Unlabelled', ['n1', 'n2', 'n3']],
    [RAIL_FOLDS.agent, 'Run by agents', ['n4']],
    [RAIL_FOLDS.archived, 'Archived', ['arch']],
  ]);
  assert.equal(folded['railgroup:label:'], true, 'Unlabelled starts open and buries the labelled groups');
  assert.equal(folded['railgroup:label:composer'], false);
});

test('Group by Agent, Status and None draw their own groups', () => {
  assert.deepEqual(shape(grouped('agent').sections), [
    [RAIL_FOLDS.top, 'Pinned', ['pin']],
    ['railgroup:agent:claude', 'Claude', ['pin', 'c1', 'c2', 'r1', 'n1', 'n2', 'n3']],
    ['railgroup:agent:codex', 'Codex', ['r2']],
    [RAIL_FOLDS.agent, 'Run by agents', ['n4']],
    [RAIL_FOLDS.archived, 'Archived', ['arch']],
  ]);
  const statuses = workspace().map((card) => {
    const status: Partial<RailSectionCard> =
      card.id === 'c1'
        ? { status: 'waiting', unread: true }
        : card.id === 'c2'
          ? { status: 'subagents' }
          : card.id === 'r1'
            ? { status: 'running' }
            : card.id === 'r2'
              ? { status: 'done', unread: true }
              : { status: 'done', unread: false };
    return { ...card, ...status };
  });
  const byStatus = railSections(statuses, sectionNow, [], 'latest', RAIL_SHOWN_BUCKETS, { groupBy: 'status' });
  assert.deepEqual(shape(byStatus.sections), [
    [RAIL_FOLDS.top, 'Pinned', ['pin']],
    // A waiting unread session sits under Needs input only, and subagents sit under Running.
    ['railgroup:status:needs-input', 'Needs input', ['c1']],
    ['railgroup:status:running', 'Running', ['c2', 'r1']],
    ['railgroup:status:unread', 'Unread', ['r2']],
    ['railgroup:status:read', 'Read', ['pin', 'n1', 'n2', 'n3']],
    [RAIL_FOLDS.agent, 'Run by agents', ['n4']],
    [RAIL_FOLDS.archived, 'Archived', ['arch']],
  ]);
  assert.deepEqual(shape(grouped('none').sections), [
    [RAIL_FOLDS.top, 'Pinned', ['pin']],
    ['railgroup:all', 'Sessions', ['c1', 'c2', 'r1', 'r2', 'n1', 'n2', 'n3']],
    [RAIL_FOLDS.agent, 'Run by agents', ['n4']],
    [RAIL_FOLDS.archived, 'Archived', ['arch']],
  ]);
});

test('a pinned session is copied into its group under Label, Agent and Status, and only under Pinned otherwise', () => {
  const holders = (groupBy: RailGroupBy) =>
    grouped(groupBy)
      .sections.filter((one) => one.cards.some((card) => card.id === 'pin'))
      .map((one) => one.id);
  assert.deepEqual(holders('time'), [RAIL_FOLDS.top]);
  assert.deepEqual(holders('none'), [RAIL_FOLDS.top]);
  assert.deepEqual(holders('label'), [RAIL_FOLDS.top, 'railgroup:label:composer']);
  assert.deepEqual(holders('agent'), [RAIL_FOLDS.top, 'railgroup:agent:claude']);
  assert.deepEqual(holders('status'), [RAIL_FOLDS.top, 'railgroup:status:read']);
});

test('query-first sections keep matching reader sessions, agent runs and copies in every grouping', () => {
  const cards = workspace().map((card) => ({
    ...card,
    label: ['c2', 'n4', 'pin', 'arch'].includes(card.id) ? 'Shared work' : 'Other work',
  }));
  const filtered = railShownCards(cards, { query: 'Shared' }, sectionNow);
  for (const groupBy of RAIL_GROUP_BY) {
    const sections = railSections(filtered, sectionNow, [], 'latest', RAIL_SHOWN_BUCKETS, { groupBy }).sections;
    assert.deepEqual(
      sections.find((section) => section.id === RAIL_FOLDS.agent)?.cards.map((card) => card.id),
      ['n4'],
    );
    assert.deepEqual(
      sections.find((section) => section.id === RAIL_FOLDS.archived)?.cards.map((card) => card.id),
      ['arch'],
    );
    assert.deepEqual(
      sections.find((section) => section.id === RAIL_FOLDS.top)?.cards.map((card) => card.id),
      ['pin'],
    );
    assert.ok(sections.some((section) => section.cards.some((card) => card.id === 'c2')));
    assert.ok(sections.every((section) => section.cards.every((card) => card.label === 'Shared work')));
  }
  const views = [testView(), testView({ id: 'v2' })];
  const withViews = railSections(filtered, sectionNow, views, 'latest', RAIL_SHOWN_BUCKETS, { groupBy: 'label' });
  for (const view of views) {
    assert.deepEqual(
      named(withViews.sections, viewFoldId(view)).cards.map((card) => card.id),
      ['pin', 'c2'],
    );
  }
  const labels = railSections(filtered, sectionNow, [], 'latest', RAIL_SHOWN_BUCKETS, { groupBy: 'label' }).sections;
  assert.equal(labels.filter((section) => section.cards.some((card) => card.id === 'c2')).length, 2);
});

test('a query with no matching cards leaves only ordinary empty saved views', () => {
  const filtered = railShownCards(workspace(), { query: 'missing' }, sectionNow);
  for (const groupBy of RAIL_GROUP_BY) {
    assert.deepEqual(
      shape(railSections(filtered, sectionNow, [testView()], 'latest', RAIL_SHOWN_BUCKETS, { groupBy }).sections),
      [[viewFoldId(testView()), 'Composer', []]],
    );
  }
});

test('a session drawn in two groups takes a distinct row id and key in each', () => {
  for (const groupBy of RAIL_GROUP_BY) {
    const { sections } = grouped(groupBy);
    const rows = railDrawnRows(
      sections.map((one) => ({
        ...one,
        cards: one.cards.map((card) => ({ ...card, status: null, runningSince: null, cache: null })),
      })),
      {},
      railRepeatRows(sections),
      railRowId,
    ).rows;
    const ids = rows.map((row) => row.id);
    const keys = rows.map((row) => railRowKey(row.bucket, row.card.id));
    assert.equal(new Set(ids).size, ids.length, `a row id repeats under ${groupBy}`);
    assert.equal(new Set(keys).size, keys.length, `a row key repeats under ${groupBy}`);
    if (groupBy === 'label') {
      assert.equal(rows.filter((row) => row.card.id === 'pin').length, 2);
      assert.equal(rows.filter((row) => row.card.id === 'c2').length, 2);
    }
  }
});

test('a row key names its section, so a row that changes section is a new row', () => {
  const key = (groupBy: RailGroupBy, id: string) =>
    grouped(groupBy).sections.flatMap((one) =>
      one.cards.filter((card) => card.id === id).map(() => railRowKey(one.id, id)),
    );
  // Changing sections changes the row key. The new row receives no focus or editor state from the old row.
  assert.deepEqual(key('time', 'c1'), [`c1:${RAIL_FOLDS.today}`]);
  assert.deepEqual(key('status', 'c1'), ['c1:railgroup:status:read']);
  assert.deepEqual(key('label', 'pin'), [`pin:${RAIL_FOLDS.top}`, 'pin:railgroup:label:composer']);
});

test('two labels that differ only in escaped characters give their rows different ids', () => {
  const cards = workspace().map((card) => (card.id === 'c2' ? { ...card, labels: ['a/b', 'a_2Fb'] } : card));
  const { sections, folded } = railSections(cards, sectionNow, [], 'latest', RAIL_SHOWN_BUCKETS, {
    groupBy: 'label',
  });
  const open = Object.fromEntries(Object.keys(folded).map((id) => [id, false]));
  const rows = railDrawnRows(
    sections.map((one) => ({
      ...one,
      cards: one.cards.map((card) => ({ ...card, status: null, runningSince: null, cache: null })),
    })),
    open,
    railRepeatRows(sections),
    railRowId,
  ).rows;
  const ids = rows.filter((row) => row.card.id === 'c2').map((row) => row.id);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1], 'the rows under a/b and a_2Fb share an element id');
  // The join between a section and a session is not a spelling either of them can take.
  assert.notEqual(railRowId('a-b', 'c', true), railRowId('a', 'b-c', true));
  assert.notEqual(railRowId('a_', 'b', true), railRowId('a', '_b', true));
  assert.notEqual(railRowId('s', 'a', true), railRowId('x', 's__a', false));
});

test('under Group by Agent a row leaves out the agent word its heading says', () => {
  const shown = Object.fromEntries(grouped('agent').sections.map((one) => [one.id, railAgentWordShown(one.id)]));
  assert.deepEqual(shown, {
    [RAIL_FOLDS.top]: true,
    'railgroup:agent:claude': false,
    'railgroup:agent:codex': false,
    [RAIL_FOLDS.agent]: true,
    [RAIL_FOLDS.archived]: true,
  });
  for (const groupBy of RAIL_GROUP_BY.filter((value) => value !== 'agent')) {
    for (const one of grouped(groupBy).sections) {
      assert.equal(railAgentWordShown(one.id), true, `${groupBy} hid the agent word under ${one.id}`);
    }
  }
  assert.equal(railAgentWordShown(RAIL_FOLDS.today), true);
});

test('a hidden bucket leaves the label chip counts with the list', () => {
  const catalogue = [
    { name: 'Composer', count: 4, countName: 'carried by 4 sessions' },
    { name: 'Release 0.4', count: 3, countName: 'carried by 3 sessions' },
    { name: 'Ops', count: 1, countName: 'carried by one session' },
  ];
  const cards = [...workspace(), testCard('ops-run', { agentRun: true, runByAgent: true, labels: ['ops'] })];
  const counts = (shown: { showArchived: boolean; showRuns: boolean }) =>
    railShownLabelCounts(catalogue, cards, shown).map((label) => [label.name, label.count, label.countName]);
  assert.deepEqual(
    counts(RAIL_SHOWN_BUCKETS),
    catalogue.map((label) => [label.name, label.count, label.countName]),
  );
  assert.deepEqual(counts({ showArchived: false, showRuns: true }), [
    ['Composer', 3, 'carried by 3 sessions'],
    ['Release 0.4', 3, 'carried by 3 sessions'],
    ['Ops', 1, 'carried by one session'],
  ]);
  assert.deepEqual(counts({ showArchived: true, showRuns: false }), [
    ['Composer', 4, 'carried by 4 sessions'],
    ['Release 0.4', 3, 'carried by 3 sessions'],
    ['Ops', 0, 'carried by 0 sessions'],
  ]);
});

test('zero-match rail shortcuts stay hidden while View choices remain label-only and selectable', () => {
  const zero = { running: 0, warm: 0, expiring: 0, active: 0, unread: 0, input: 0 };
  const buttons = railCountButtons(zero, ALL_LENS, HEAD_WORDS, RAIL_LENSES);
  assert.deepEqual(buttons, []);
  const values = railNarrowToRow('', CARD_ACTIONS.railNarrowToValues);
  assert.deepEqual(
    values.map((value) => value.value),
    ['all', ...RAIL_LENSES],
  );
  assert.ok(values.every((value) => !('figure' in value) && !('disabled' in value)));
});

test('live and saved prefix queries retain full catalog resolution across coverage changes', () => {
  const cards = [
    { id: 'abcdefgh-one', agent: 'Claude', label: 'First', at: 1, pinnedTop: false, current: false, archived: false },
    { id: 'abcdefgh-hidden', agent: 'Codex', label: 'Hidden', at: 1, pinnedTop: false, current: false, archived: true },
  ];
  const identities = cards.map((card) => ({ sessionId: card.id, agent: card.agent }));
  const view = { id: 'prefix', name: 'Prefix', query: 'id:abcdefgh', archived: false };
  for (const coverage of ['complete', 'incomplete', 'complete', 'unavailable', 'complete'] as const) {
    const queryContext = { identities, coverage, scope: 'scope', revision: coverage };
    const shown = railShownCards(cards, { query: 'id:abcdefgh', queryContext }, 0);
    assert.equal(shown.length, coverage === 'complete' ? 2 : 0);
    const result = railSections(cards, 0, [view], 'latest', RAIL_SHOWN_BUCKETS, { queryContext });
    assert.equal(
      result.sections.find((section) => section.label === 'Prefix')!.cards.length,
      coverage === 'complete' ? 1 : 0,
    );
  }
});
