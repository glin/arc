import assert from 'node:assert';
import { test, vi } from 'vitest';
import type { BrowserStatePort, PanelHost } from './host.ts';
import { createReadState } from './read-state.ts';
import {
  createSavedState,
  mergeSubmittedPrompts,
  type SubmittedPrompt,
  type SavedPanelState,
  type SavedStateValues,
} from './state.ts';

function values(): SavedStateValues {
  return {
    open: new Set(['s1:1']),
    showing: 's1',
    railFilter: 'agent:codex',
    railFilterId: 'f2',
    railSort: 'cost-desc',
    railDefaultSort: 'latest',
    railDensity: 'compact',
    railGroupBy: 'label',
    railShowArchived: false,
    railShowRuns: false,
    railQuickFilters: ['unread'],
    railWidth: 311,
    composerHidden: true,
    promptFloor: 9.4,
    railFolds: new Map([['older', false]]),
    hidden: new Set(['s2']),
    pinnedTop: new Set(['s1']),
    read: new Set(['s1:1']),
    readTo: new Map([['s1', 17]]),
    since: 11,
    comments: [{ id: 'n1' }],
  };
}

function expectedState(): SavedPanelState {
  return {
    open: ['s1:1'],
    showing: 's1',
    railFilter: 'agent:codex',
    railFilterId: 'f2',
    railSort: 'cost-desc',
    railDefaultSort: 'latest',
    railDensity: 'compact',
    railGroupBy: 'label',
    railShowArchived: false,
    railShowRuns: false,
    railQuickFilters: ['unread'],
    railWidth: 311,
    composerHidden: true,
    promptFloor: 9.4,
    railFolds: { older: false },
    hidden: ['s2'],
    pinnedTop: ['s1'],
    read: ['s1:1'],
    readTo: { s1: 17 },
    since: 11,
    comments: [{ id: 'n1' }],
    assets: {},
  };
}

test('a recreated page restores the state written by the previous page', () => {
  let stored: unknown;
  const browserState: BrowserStatePort = {
    read() {
      return stored;
    },
    write(state) {
      stored = state;
    },
  };
  const host: PanelHost = { send() {} };

  createSavedState(undefined, browserState, host).save(values());
  assert.deepEqual(stored, expectedState());
  const recreated = createSavedState(undefined, browserState, host);
  assert.deepEqual(recreated.initial, expectedState());
});

test('saving keeps the two writers and the persisted asymmetry intact', async () => {
  const browserWrites: unknown[] = [];
  const hostWrites: unknown[] = [];
  const writerOrder: string[] = [];
  const browserState: BrowserStatePort = {
    read() {
      return {};
    },
    write(state) {
      writerOrder.push('browser');
      browserWrites.push(state);
    },
  };
  const host: PanelHost = {
    send(message) {
      writerOrder.push('host');
      hostWrites.push(message);
    },
  };

  const state = createSavedState(undefined, browserState, host).save(values());
  const expected = expectedState();
  assert.deepEqual(state, expected);
  await vi.waitFor(() => assert.equal(hostWrites.length, 1));
  assert.deepEqual(writerOrder, ['browser', 'host']);
  assert.deepEqual(browserWrites, [expected]);
  assert.deepEqual(hostWrites, [{ type: 'saveState', state: expected }]);
  assert.deepEqual(Object.keys(state), [
    'open',
    'showing',
    'railFilter',
    'railFilterId',
    'railSort',
    'railDefaultSort',
    'railDensity',
    'railGroupBy',
    'railShowArchived',
    'railShowRuns',
    'railQuickFilters',
    'railWidth',
    'composerHidden',
    'promptFloor',
    'railFolds',
    'hidden',
    'pinnedTop',
    'read',
    'readTo',
    'since',
    'comments',
    'assets',
  ]);
  assert.equal('drafts' in state, false);
  assert.equal('labels' in state, false);
  assert.deepEqual(state.comments, [{ id: 'n1' }]);
  assert.deepEqual(state.assets, {});
});

test('one render that marks several cards read sends the extension one whole state', async () => {
  const browserWrites: SavedPanelState[] = [];
  const hostWrites: { type: string; state: SavedPanelState }[] = [];
  const saved = createSavedState(
    undefined,
    {
      read() {
        return {};
      },
      write(state) {
        browserWrites.push(state as SavedPanelState);
      },
    },
    {
      send(message) {
        hostWrites.push(message as { type: string; state: SavedPanelState });
      },
    },
  );
  const cards = ['s1:1', 's1:2', 's1:3'];
  const read = createReadState({
    initial: {},
    open: new Set(),
    cards: () => [],
    newestTurnAt: () => null,
    refreshSelection() {},
    save() {
      saved.save({ ...values(), read: read.snapshot().read, readTo: read.snapshot().readTo });
    },
  });

  // A card marks itself read as it draws, so one render marks every open card in one task.
  for (const key of cards) {
    read.mark(key);
  }

  await vi.waitFor(() => assert.equal(hostWrites.length, 1));
  assert.deepEqual(
    hostWrites.map((message) => message.type),
    ['saveState'],
    'each card marked read sent the extension a state of its own, and each one words the rail again',
  );
  assert.deepEqual(hostWrites[0].state.read, cards, 'the state sent leaves out a card the render marked read');
  assert.deepEqual(browserWrites.at(-1)?.read, cards, 'the browser copy waits for the extension copy');
});

test('a panel saved before the rail row shipped writes no rail-row words', () => {
  const withoutRailRowWords = values();
  delete withoutRailRowWords.railDensity;
  delete withoutRailRowWords.railGroupBy;
  delete withoutRailRowWords.railShowArchived;
  delete withoutRailRowWords.railShowRuns;
  delete withoutRailRowWords.railQuickFilters;
  const browserState: BrowserStatePort = {
    read() {
      return {};
    },
    write() {},
  };
  const state = createSavedState(undefined, browserState, { send() {} }).save(withoutRailRowWords);
  assert.equal('railDensity' in state, false);
  assert.equal('railGroupBy' in state, false);
  assert.equal('railShowArchived' in state, false);
  assert.equal('railShowRuns' in state, false);
  assert.equal('railQuickFilters' in state, false);
  // A reader who unticked every Quick filters box saves an empty choice, not a missing one.
  const empty = createSavedState(undefined, browserState, { send() {} }).save({ ...values(), railQuickFilters: [] });
  assert.deepEqual(empty.railQuickFilters, []);
  // Saving omits the legacy railHeadLenses field.
  assert.equal('railHeadLenses' in empty, false);
});

test('the injected host state keeps precedence over restored browser state', () => {
  const browserState: BrowserStatePort = {
    read() {
      return { showing: 'browser' };
    },
    write() {},
  };
  const host: PanelHost = { send() {} };
  assert.deepEqual(createSavedState({ showing: 'host' }, browserState, host).initial, { showing: 'host' });
});

function submission(id: string, order: number, text = 'same prompt'): SubmittedPrompt {
  return { id, order, source: 'draft:old', revision: 9, text };
}

test('submitted recovery merges empty and overlapping lifetimes before bounding the newest five', () => {
  const browser = Array.from({ length: 5 }, (_, index) => submission(`b${index}`, index + 1));
  let stored: unknown = { showing: 'old', submittedPrompts: browser };
  const port = {
    read: () => stored,
    write: (state: unknown) => {
      stored = state;
    },
  };
  const host = { send() {} };
  const restored = createSavedState({ showing: '', submittedPrompts: [] }, port, host);
  assert.deepEqual(restored.recovery(), browser);
  restored.save(values());
  const recreated = createSavedState({ submittedPrompts: [browser[4], submission('host', 6)] }, port, host);
  const attempt = recreated.submit('draft:new', 10, '  next\n  ');
  assert.equal(attempt.order, 7);
  assert.deepEqual(
    recreated.recovery().map((entry) => entry.order),
    [3, 4, 5, 6, 7],
  );
  assert.equal(recreated.recovery().at(-1)?.text, '  next\n  ');
});

test('submitted recovery retains repeated exact multiline text through fresh pages and every ordinary save', () => {
  let stored: unknown;
  const port = {
    read: () => stored,
    write: (state: unknown) => {
      stored = state;
    },
  };
  const owner = createSavedState(undefined, port, { send() {} });
  for (const size of [4001, 20000]) {
    const text = '  \n' + 'x'.repeat(size - 5) + '\n ';
    const first = owner.submit('draft:claude', 1, text);
    const second = owner.submit('draft:codex', 2, text);
    assert.notEqual(first.id, second.id);
    owner.save(values());
    const fresh = createSavedState({}, port, { send() {} });
    assert.deepEqual(
      fresh
        .recovery()
        .slice(-2)
        .map((entry) => entry.text),
      [text, text],
    );
  }
  assert.throws(() => owner.submit('draft:claude', 3, 'x'.repeat(20001)), /20,000/);
  assert.equal(owner.recovery().length, 4);
  const exhausted = createSavedState({ submittedPrompts: [submission('last', Number.MAX_SAFE_INTEGER)] }, port, {
    send() {},
  });
  assert.throws(() => exhausted.submit('new', 1, 'keep visible'), /could not be saved/);
});

test('submitted recovery rejects failed writes without committing the attempt and reconnect never sends a prompt', () => {
  let fail = false;
  const messages: unknown[] = [];
  const owner = createSavedState(
    undefined,
    {
      read: () => ({}),
      write() {
        if (fail) throw new Error('storage full');
      },
    },
    { send: (message) => messages.push(message) },
  );
  owner.submit('old', 1, 'retained');
  fail = true;
  assert.throws(() => owner.submit('new', 2, 'unprotected'), /storage full/);
  assert.deepEqual(
    owner.recovery().map((entry) => entry.text),
    ['retained'],
  );
  owner.publishRecovery();
  assert.deepEqual(messages, [{ type: 'importPromptRecovery', submittedPrompts: owner.recovery() }]);
});

test('submitted recovery keeps immutable order, deterministic ties and confirmed ownership against stale receipts', () => {
  const original = submission('a', 1);
  const confirmed = { ...original, owner: 'fork', ownerRevision: 2 };
  const entries = mergeSubmittedPrompts(
    [submission('z', 1), original],
    [confirmed],
    [{ ...original, owner: 'source', ownerRevision: 1 }],
    [confirmed],
  );
  assert.deepEqual(
    entries.map((entry) => entry.id),
    ['a', 'z'],
  );
  assert.deepEqual(entries[0], confirmed);
  assert.notEqual(entries[0].accepted, true);
  const accepted = { ...confirmed, accepted: true, ownerRevision: 3 };
  assert.deepEqual(mergeSubmittedPrompts([accepted], [original], [confirmed])[0], accepted);
  assert.throws(() => mergeSubmittedPrompts([original], [{ ...original, text: 'different' }]), /conflicts/);
});
