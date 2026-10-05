import assert from 'node:assert';
import { test } from 'vitest';
import type { PanelToHost } from './protocol.ts';
import type { RailSnapshot } from './rail.ts';
import { createPanelSessionState } from './session-state.ts';
import { createSavedState, type SavedStateService, type SavedStateValues } from './state.ts';

function owner(initial: Record<string, unknown> = {}, rail: () => RailSnapshot | null = () => null) {
  const events: Array<string | PanelToHost> = [];
  const saves: SavedStateValues[] = [];
  const savedState: SavedStateService = {
    ...createSavedState(initial, { read: () => initial, write() {} }, { send() {} }),
    initial,
    save(values) {
      saves.push({ ...values, hidden: [...values.hidden], pinnedTop: [...values.pinnedTop] });
      events.push('save');
      return {} as never;
    },
  };
  const state = createPanelSessionState({
    savedState,
    sendToHost(message) {
      events.push(message);
    },
    rail,
    reading: () => null,
    comments: () => null,
    promptFloor: () => null,
    composerHidden: () => initial.composerHidden === true,
    refreshContext(session) {
      events.push(`context:${session}`);
    },
    refreshContexts(sessions) {
      events.push(`contexts:${sessions.join(',')}`);
    },
  });
  return { state, events, saves };
}

test('archiving a pinned session publishes one operation without a second save', () => {
  const { state, events, saves } = owner({ pinnedTop: ['s1'] });
  events.length = 0;
  saves.length = 0;
  state.hide('s1');
  assert.deepEqual(events, ['context:s1', { type: 'sessionMembership', action: 'archive', session: 's1' }]);
  assert.deepEqual(saves, []);
});

test('a local membership change sends an operation instead of a stale snapshot', () => {
  const { state, events, saves } = owner();
  state.adopt(['remote-archive'], ['remote-pin'], 'shown');
  events.length = 0;
  saves.length = 0;
  state.setPinned('local-pin', true);
  assert.deepEqual(events, ['context:local-pin', { type: 'sessionMembership', action: 'pin', session: 'local-pin' }]);
  assert.deepEqual(saves, []);
});

test('pinning can persist the fold through the same membership operation', () => {
  const { state, events, saves } = owner();
  state.setPinned('local-pin', true, true);
  assert.deepEqual(events, [
    'context:local-pin',
    { type: 'sessionMembership', action: 'pin', session: 'local-pin', openPinned: true },
  ]);
  assert.deepEqual(saves, []);
});

test('membership follows the displayed provisional identity until the complete render', () => {
  const { state, events } = owner({ showing: 'draft:s1' });
  const adoptions = [{ provisional: 'draft:s1', durable: 's1' }];
  state.adopt(['s1'], [], 'draft:s1', adoptions);
  assert.equal(state.showing(), 'draft:s1');
  assert.deepEqual([...state.hidden], ['draft:s1']);
  events.length = 0;
  state.unarchive('draft:s1');
  assert.deepEqual(events, [
    'context:draft:s1',
    { type: 'sessionMembership', action: 'unarchive', session: 'draft:s1' },
  ]);

  state.adopt([], ['s1'], 'draft:s1', adoptions);
  assert.deepEqual([...state.pinnedTop], ['draft:s1']);
  events.length = 0;
  state.setPinned('draft:s1', false);
  assert.deepEqual(events, ['context:draft:s1', { type: 'sessionMembership', action: 'unpin', session: 'draft:s1' }]);

  state.adopt([], ['s1'], 's1', adoptions);
  assert.equal(state.showing(), 's1');
  assert.deepEqual([...state.pinnedTop], ['s1']);
});

test('a membership action does not queue saveState through the real saved-state service', async () => {
  const messages: PanelToHost[] = [];
  const browserWrites: unknown[] = [];
  const savedState = createSavedState(
    {},
    {
      read: () => ({}),
      write(state) {
        browserWrites.push(state);
      },
    },
    {
      send(message) {
        messages.push(message);
      },
    },
  );
  const state = createPanelSessionState({
    savedState,
    sendToHost(message) {
      messages.push(message);
    },
    rail: () => null,
    reading: () => null,
    comments: () => null,
    promptFloor: () => null,
    composerHidden: () => false,
    refreshContext() {},
    refreshContexts() {},
  });

  state.hide('s1');
  await Promise.resolve();
  assert.deepEqual(messages, [{ type: 'sessionMembership', action: 'archive', session: 's1' }]);
  assert.deepEqual(browserWrites, []);
});

test('session context follows adopted archived and pinned state', () => {
  const { state } = owner();
  state.adopt(['archived'], ['pinned'], 'shown');
  assert.deepEqual(JSON.parse(state.context('archived', true)), {
    webviewSection: 'arcSessionArchived',
    session: 'archived',
    sessionPinned: false,
    sessionPersisted: true,
  });
  assert.deepEqual(JSON.parse(state.context('pinned', false)), {
    webviewSection: 'arcSessionLive',
    session: 'pinned',
    sessionPinned: true,
    sessionPersisted: false,
  });
  assert.equal(state.showing(), 'shown');
});

test('a heading context merges in the read state a caller already knows', () => {
  const { state } = owner();
  // An absent read state omits the key and its menu entries.
  assert.deepEqual(JSON.parse(state.context('s1', true, { sessionRead: undefined })), {
    webviewSection: 'arcSessionLive',
    session: 's1',
    sessionPinned: false,
    sessionPersisted: true,
  });
  assert.deepEqual(JSON.parse(state.context('s1', true, { sessionRead: 'unread' })), {
    webviewSection: 'arcSessionLive',
    session: 's1',
    sessionPinned: false,
    sessionPersisted: true,
    sessionRead: 'unread',
  });
  assert.deepEqual(JSON.parse(state.context('s1', true, { sessionRead: 'read' })), {
    webviewSection: 'arcSessionLive',
    session: 's1',
    sessionPinned: false,
    sessionPersisted: true,
    sessionRead: 'read',
  });
});

test('a heading and a rail row carry sessionLabeled only while the session has a label', () => {
  const { state } = owner();
  assert.equal(JSON.parse(state.context('s1', true, { sessionLabeled: true })).sessionLabeled, true);
  assert.equal(
    JSON.parse(state.context('s1', true, { menuSection: 'arcRail', sessionLabeled: true })).sessionLabeled,
    true,
  );
  // The key drops out rather than reading false, the way sessionRead does.
  assert.equal('sessionLabeled' in JSON.parse(state.context('s1', true, { sessionLabeled: false })), false);
  assert.equal('sessionLabeled' in JSON.parse(state.context('s1', true, { menuSection: 'arcRail' })), false);
});

test('the rail row words normalize on load and round-trip through every save', () => {
  const { state, saves } = owner({
    railDensity: 'compact',
    railGroupBy: 'agent',
    railShowArchived: false,
    railShowRuns: false,
    railQuickFilters: ['input'],
  });
  assert.equal(state.initialRail.density, 'compact');
  assert.equal(state.initialRail.groupBy, 'agent');
  assert.equal(state.initialRail.showArchived, false);
  assert.equal(state.initialRail.showRuns, false);
  assert.deepEqual(state.initialRail.headLenses, ['input']);
  state.save();
  const saved = saves.at(-1);
  assert.equal(saved?.railDensity, 'compact');
  assert.equal(saved?.railGroupBy, 'agent');
  assert.equal(saved?.railShowArchived, false);
  assert.equal(saved?.railShowRuns, false);
  assert.deepEqual(saved?.railQuickFilters, ['input']);
});

// Loading railHeadLenses adds Running. Saving uses railQuickFilters.
test('a Quick filters choice stored before the Running lens loads with Running and saves under the new field', () => {
  const all = ['running', 'active', 'unread', 'input'];
  const cases: [unknown, string[]][] = [
    [['active', 'unread', 'input'], all],
    [['unread'], ['running', 'unread']],
    [[], ['running']],
    [undefined, ['running', 'active', 'input']],
  ];
  for (const [legacy, loads] of cases) {
    const { state, saves } = owner(legacy === undefined ? {} : { railHeadLenses: legacy });
    assert.deepEqual(state.initialRail.headLenses, loads, JSON.stringify(legacy));
    state.save();
    assert.deepEqual(saves.at(-1)?.railQuickFilters, loads, JSON.stringify(legacy));
    assert.equal('railHeadLenses' in (saves.at(-1) ?? {}), false, JSON.stringify(legacy));
  }
  // railQuickFilters takes precedence over railHeadLenses.
  const { state } = owner({ railQuickFilters: [], railHeadLenses: ['active'] });
  assert.deepEqual(state.initialRail.headLenses, []);
});

// Preserve an explicit empty Quick filters choice through loading and saving.
test('an empty head lens choice stays empty through a load and a save', () => {
  const { state, saves } = owner({ railQuickFilters: [] });
  assert.deepEqual(state.initialRail.headLenses, []);
  state.save();
  assert.deepEqual(saves.at(-1)?.railQuickFilters, []);
});

test('a Group by or Rows press the rail holds is the value every save writes', () => {
  const { saves, state } = owner({ railGroupBy: 'agent', railDensity: 'comfortable' }, () => ({
    filter: '',
    filterId: '',
    width: 220,
    folds: new Map(),
    sort: 'latest',
    defaultSort: 'latest',
    showArchived: true,
    showRuns: true,
    headLenses: ['active'],
    groupBy: 'status',
    density: 'compact',
  }));
  state.save();
  assert.deepEqual(saves.at(-1)?.railQuickFilters, ['active']);
  assert.equal(saves.at(-1)?.railGroupBy, 'status');
  assert.equal(saves.at(-1)?.railDensity, 'compact', 'the save wrote the density the panel loaded');
});

test('a panel saved before the rail row shipped opens comfortable, grouped by time, with both buckets shown', () => {
  const { state } = owner({});
  assert.equal(state.initialRail.density, 'comfortable');
  assert.equal(state.initialRail.groupBy, 'time');
  assert.equal(state.initialRail.showArchived, true);
  assert.equal(state.initialRail.showRuns, true);
  assert.deepEqual(state.initialRail.headLenses, ['running', 'active', 'input']);
});

test('junk saved rail-row words fall back to the same defaults as a missing one, and a save writes the normalized words back', () => {
  const { state, saves } = owner({
    railDensity: 'huge',
    railGroupBy: 'nonsense',
    railShowArchived: 'no',
    railShowRuns: 0,
  });
  assert.equal(state.initialRail.density, 'comfortable');
  assert.equal(state.initialRail.groupBy, 'time');
  assert.equal(state.initialRail.showArchived, true);
  assert.equal(state.initialRail.showRuns, true);
  state.save();
  const saved = saves.at(-1);
  assert.equal(saved?.railDensity, 'comfortable');
  assert.equal(saved?.railGroupBy, 'time');
  assert.equal(saved?.railShowArchived, true);
  assert.equal(saved?.railShowRuns, true);
});

// Browser state bypasses host normalization. Convert stored lens fields and Warm query terms here.
// Preserve the needs-you query and typed is:running. Save query terms without a lens field.
test('a browser copy that names an old lens opens with the lens words in the query and saves them', () => {
  const cases: Array<[Record<string, unknown>, { filter: string; filterId: string }]> = [
    [
      { railFilterId: 'needs-you', railFilter: 'is:input is:unread -is:archived -is:agentrun' },
      { filter: 'is:input is:unread -is:archived -is:agentrun', filterId: 'all' },
    ],
    [
      { railFilterId: 'all', railFilter: 'is:warm -is:archived -is:agentrun' },
      { filter: 'is:active -is:archived -is:agentrun', filterId: 'all' },
    ],
    [
      { railFilterId: 'all', railFilter: 'is:running' },
      { filter: 'is:running', filterId: 'all' },
    ],
    [
      { railFilterId: 'f2', railFilter: 'label:ui', railLens: 'active' },
      { filter: 'is:active -is:archived -is:agentrun label:ui', filterId: 'f2' },
    ],
    [{ railLens: 'warm' }, { filter: '', filterId: '' }],
  ];
  for (const [initial, expected] of cases) {
    const { state, saves } = owner(initial);
    const { filter, filterId } = state.initialRail;
    assert.deepEqual({ filter, filterId }, expected, JSON.stringify(initial));
    state.save();
    assert.ok(!('railLens' in (saves.at(-1) ?? {})), JSON.stringify(initial));
    assert.equal(saves.at(-1)?.railFilter, expected.filter, JSON.stringify(initial));
  }
});

test('a rail context names its own section and spells out archived state directly', () => {
  const { state } = owner();
  state.adopt(['s1'], ['s1'], null);
  assert.deepEqual(
    JSON.parse(state.context('s1', true, { menuSection: 'arcRailRead', preventDefaultContextMenuItems: true })),
    {
      webviewSection: 'arcRailRead',
      session: 's1',
      sessionPinned: false,
      sessionPersisted: true,
      sessionArchived: true,
      preventDefaultContextMenuItems: true,
    },
  );
  // Session list contexts name archived and pinned state separately from read state.
  assert.deepEqual(JSON.parse(state.context('s2', false, { menuSection: 'arcRail' })), {
    webviewSection: 'arcRail',
    session: 's2',
    sessionPinned: false,
    sessionPersisted: false,
    sessionArchived: false,
  });
});
