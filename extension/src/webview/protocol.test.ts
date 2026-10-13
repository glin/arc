import { unavailableContext } from '../domain/context-detail.ts';
import { test } from 'vitest';
import assert from 'node:assert';

test('response file citations retain their typed literal destination at the host boundary', () => {
  for (const path of ['C:/outside/file%20.csv#L10', '/outside/file:10']) {
    const message = { type: 'openLink', destination: { kind: 'fileCitation', path }, beside: true };
    assert.deepEqual(parsePanelToHost(message), message);
  }
  for (const destination of [
    null,
    {},
    { kind: 'fileCitation' },
    { kind: 'fileCitation', path: 4 },
    { kind: 'url', path: '/a' },
  ])
    assert.equal(parsePanelToHost({ type: 'openLink', destination }), null);
  assert.equal(
    parsePanelToHost({ type: 'openLink', destination: { kind: 'fileCitation', path: '/a' }, href: '/b' }),
    null,
  );
});

test('response session navigation retains its explicit marker and rejects malformed markers', () => {
  const message = { type: 'showSession', session: 'saved-id', responseLink: true };
  assert.deepEqual(parsePanelToHost(message), message);
  for (const responseLink of [false, 'true', 1, null])
    assert.equal(parsePanelToHost({ ...message, responseLink }), null);
  assert.deepEqual(parsePanelToHost({ type: 'showSession', session: 'row-id' }), {
    type: 'showSession',
    session: 'row-id',
  });
});

test('HTML export requires its initiating saved session and dispatches that identity', () => {
  for (const session of [undefined, null, 7, ''])
    assert.equal(parsePanelToHost({ type: 'exportSession', session }), null);
  const request = parsePanelToHost({ type: 'exportSession', session: 'initiating-session' });
  assert.deepEqual(request, { type: 'exportSession', session: 'initiating-session' });
  const seen: string[] = [];
  dispatchPanelToHost(request!, panelRecorder(seen));
  assert.deepEqual(seen, ['exportSession']);
});

test('visibility messages reject invalid state and revision values', () => {
  assert.deepEqual(parseHostToPanel({ type: 'visibility', visible: false, revision: 1 }), {
    type: 'visibility',
    visible: false,
    revision: 1,
  });
  for (const revision of [-1, 1.5, Infinity, NaN, '1', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(parseHostToPanel({ type: 'visibility', visible: true, revision }), null);
  }
  assert.equal(parseHostToPanel({ type: 'visibility', visible: 'false', revision: 1 }), null);
  const seen: string[] = [];
  dispatchHostToPanel({ type: 'visibility', visible: true, revision: 2 }, hostRecorder(seen));
  assert.deepEqual(seen, ['visibility']);
});
import {
  HostToPanel,
  HostToPanelHandlers,
  PanelToHost,
  PanelToHostHandlers,
  dispatchHostToPanel,
  dispatchPanelToHost,
  parseHostToPanel,
  parsePanelToHost,
} from './protocol.ts';

const LIVE_FILE: Extract<HostToPanel, { type: 'live' }>['live'][number]['files'][number] = {
  id: 'file-1',
  label: 'notes.txt',
  name: 'notes.txt, document, 1 KB',
  size: 1024,
  preview: null,
  kind: 'document',
  stem: 'notes',
  ext: '.txt',
  sizeLabel: '1 KB',
};

test('setup actions preserve displayed project ownership across parsing', () => {
  for (const message of [
    { type: 'newSession', request: { kind: 'row', key: 'recent:0' }, owner: 'A' },
    {
      type: 'pinSetup',
      request: { kind: 'custom', agent: 'claude', model: '', effort: '', permissionMode: '' },
      owner: 'A',
    },
    { type: 'unpinSetup', id: 'migrated-id', owner: 'A' },
  ]) {
    assert.deepEqual(parsePanelToHost(message), message);
    assert.equal(parsePanelToHost({ ...message, owner: 7 }), null);
  }
});

test('startup progress accepts known-source counters and rejects invalid totals', () => {
  const message = { type: 'startupProgress', generation: 1, epoch: 'accepted', sequence: 2, completed: 3, known: 4 };
  assert.deepEqual(parseHostToPanel(message), message);
  for (const terminal of [{ complete: true }, { failed: true }])
    assert.deepEqual(parseHostToPanel({ ...message, ...terminal }), { ...message, ...terminal });
  for (const changed of [
    { complete: 'true' },
    { failed: 1 },
    { completed: 5 },
    { completed: -1 },
    { sequence: 1.5 },
    { known: NaN },
  ])
    assert.equal(parseHostToPanel({ ...message, ...changed }), null);
});

const LIVE: Extract<HostToPanel, { type: 'live' }>['live'][number] = {
  kind: 'prompt',
  state: 'running',
  tone: 'running',
  relative: 'now',
  absolute: 'now',
  agent: 'Claude',
  model: 'Opus',
  label: 'Claude, running',
  headline: 'Review this',
  status: 'Running',
  reply: 'Working',
  at: 1,
  since: 1,
  dismissLabel: '',
  dismissName: '',
  dismissControl: '',
  restoreLabel: '',
  restoreName: '',
  restoreControl: '',
  reason: '',
  files: [LIVE_FILE],
};

const LABEL_ROW: Extract<HostToPanel, { type: 'labelEditor' }>['rows'][number] = {
  name: 'perf',
  count: 1,
  countName: '1 session',
  applied: true,
};

const PATH_ROW: Extract<HostToPanel, { type: 'pathCompletion' }>['rows'][number] = {
  name: 'work',
  directory: true,
  label: 'work/',
  accessibleName: 'Directory work/',
  completion: '~/Projects/work/',
};

const VIEW_ROW: Extract<PanelToHost, { type: 'setViews' }>['views'][number] = {
  id: 'v1',
  name: 'Perf work',
  query: 'label:perf',
  archived: true,
};

// A saved filter retaining the legacy lens field, which the parser accepts.
const RAIL_FILTER_ROW: Extract<PanelToHost, { type: 'setRailFilters' }>['railFilters'][number] & { lens?: unknown } = {
  id: 'f1',
  name: 'Needs costs',
  query: 'is:unread cost:>5',
  sort: 'cost-desc',
  lens: 'active',
};

const RENDER: Extract<HostToPanel, { type: 'render' }> = {
  type: 'render',
  cards: [],
  sessions: [],
  rail: [],
  stats: {},
  hidden: [],
  pinnedTop: [],
  comments: [],
  usage: null,
  labels: [],
  views: [VIEW_ROW],
  railFilters: [RAIL_FILTER_ROW],
  iconFonts: [],
  showing: null,
  sessionAdoptions: [],
  maxSessions: 1,
  olderHistory: null,
  projectSpend: null,
  diagnosis: null,
  startup: null,
  timelineLayout: { cardLayout: 'compact', promptPosition: 'above' },
};

const SELECTION: Extract<HostToPanel, { type: 'selection' }> = {
  type: 'selection',
  cards: [],
  sessions: [],
  rail: [],
  stats: {},
  replaces: ['s1', 's2'],
  showing: 's2',
  olderHistory: null,
  diagnosis: null,
  usage: null,
  startup: null,
};

// An unavailable context reply with valid request identity.
const CONTEXT_DETAIL = unavailableContext({
  session: 's1',
  request: 1,
  generation: 0,
  provider: 'claude',
  model: 'opus',
  source: 'child',
});
// Valid host messages and their parsed results cover every variant through the typed handler count.
const HOST: Array<{ raw: unknown; parsed: HostToPanel }> = [
  {
    raw: { type: 'readerReadAdmission', id: 'page:1', admitted: true },
    parsed: { type: 'readerReadAdmission', id: 'page:1', admitted: true },
  },
  {
    raw: { type: 'applySessionFilter', request: 'one', query: '', deadline: 1000 },
    parsed: { type: 'applySessionFilter', request: 'one', query: '', deadline: 1000 },
  },
  { raw: { type: 'health', sequence: 1 }, parsed: { type: 'health', sequence: 1 } },
  {
    raw: { type: 'visibility', visible: false, revision: 1 },
    parsed: { type: 'visibility', visible: false, revision: 1 },
  },
  {
    raw: { type: 'startupProgress', generation: 1, epoch: 'epoch', sequence: 2, completed: 3, known: 4 },
    parsed: { type: 'startupProgress', generation: 1, epoch: 'epoch', sequence: 2, completed: 3, known: 4 },
  },
  { raw: { type: 'promptRecovery', submittedPrompts: [] }, parsed: { type: 'promptRecovery', submittedPrompts: [] } },
  { raw: { type: 'requestPromptRecovery', request: 'r' }, parsed: { type: 'requestPromptRecovery', request: 'r' } },
  { raw: { type: 'contextDetail', detail: CONTEXT_DETAIL }, parsed: { type: 'contextDetail', detail: CONTEXT_DETAIL } },
  { raw: { type: 'focusProjectSpend' }, parsed: { type: 'focusProjectSpend' } },
  { raw: { type: 'openLauncher', custom: true }, parsed: { type: 'openLauncher', custom: true } },
  {
    raw: { type: 'layout', layout: { cardLayout: 'one-column', promptPosition: 'below' } },
    parsed: { type: 'layout', layout: { cardLayout: 'one-column', promptPosition: 'below' } },
  },
  {
    raw: { type: 'labelEditor', session: 's1', heading: 'Labels for one', rows: [LABEL_ROW] },
    parsed: { type: 'labelEditor', session: 's1', heading: 'Labels for one', rows: [LABEL_ROW] },
  },
  { raw: { type: 'labelsChanged', session: 's1' }, parsed: { type: 'labelsChanged', session: 's1' } },
  { raw: { type: 'openLabelEditor', session: 's1' }, parsed: { type: 'openLabelEditor', session: 's1' } },
  {
    raw: { type: 'showSessionDetails', session: 's1' },
    parsed: { type: 'showSessionDetails', session: 's1' },
  },
  {
    raw: { type: 'openViewEditor', view: 'v1', mode: 'rename' },
    parsed: { type: 'openViewEditor', view: 'v1', mode: 'rename' },
  },
  {
    raw: { type: 'openSessionRename', session: 's1', title: 'Full name' },
    parsed: { type: 'openSessionRename', session: 's1', title: 'Full name' },
  },
  {
    raw: { type: 'sessionRenameResult', session: 's1', request: 3, title: 'Full name', error: '' },
    parsed: { type: 'sessionRenameResult', session: 's1', request: 3, title: 'Full name', error: '' },
  },
  { raw: { type: 'focusComposer', session: 's1' }, parsed: { type: 'focusComposer', session: 's1' } },
  {
    raw: { type: 'pathCompletion', session: 's1', request: 1, token: '~/Projects/wo', caret: 12, rows: [PATH_ROW] },
    parsed: { type: 'pathCompletion', session: 's1', request: 1, token: '~/Projects/wo', caret: 12, rows: [PATH_ROW] },
  },
  {
    raw: { type: 'insertPrompt', session: 's1', text: 'src/a.ts' },
    parsed: { type: 'insertPrompt', session: 's1', text: 'src/a.ts' },
  },
  {
    raw: { type: 'fileStaging', session: 's1', token: 't1', pending: true },
    parsed: { type: 'fileStaging', session: 's1', token: 't1', pending: true },
  },
  {
    raw: { type: 'fileStagingRejected', session: 's1', token: 't1' },
    parsed: { type: 'fileStagingRejected', session: 's1', token: 't1' },
  },
  {
    raw: { type: 'usage', usage: { bars: [] } },
    parsed: { type: 'usage', usage: { bars: [] } } as unknown as HostToPanel,
  },
  {
    raw: { type: 'askRejected', session: 's1', id: 'a1' },
    parsed: { type: 'askRejected', session: 's1', id: 'a1' },
  },
  {
    raw: { type: 'projectSpend', projectSpend: { total: 1 } },
    parsed: { type: 'projectSpend', projectSpend: { total: 1 } } as unknown as HostToPanel,
  },
  {
    raw: { type: 'live', session: 's1', live: [LIVE] },
    parsed: { type: 'live', session: 's1', live: [LIVE] },
  },
  {
    raw: { type: 'readState', state: { revision: 1, read: ['s1:10'], readTo: { s1: 10 }, since: 0, agentRead: [] } },
    parsed: { type: 'readState', state: { revision: 1, read: ['s1:10'], readTo: { s1: 10 }, since: 0, agentRead: [] } },
  },
  {
    raw: { type: 'activity', session: 's1', card: { key: 's1:1' } },
    parsed: { type: 'activity', session: 's1', card: { key: 's1:1' } } as unknown as HostToPanel,
  },
  {
    raw: {
      type: 'rail',
      rail: [],
      stats: {},
      labels: [],
      views: [VIEW_ROW],
      railFilters: [RAIL_FILTER_ROW],
      sessionAdoptions: [{ provisional: 'draft:s1', durable: 's1' }],
      hidden: ['s2'],
      pinnedTop: ['s1'],
      rows: { revision: 2, base: 1, railOrder: { head: 1, tail: 0, ids: ['s1'] }, statsRemoved: ['s2'] },
    },
    parsed: {
      type: 'rail',
      rail: [],
      stats: {},
      labels: [],
      views: [VIEW_ROW],
      railFilters: [RAIL_FILTER_ROW],
      sessionAdoptions: [{ provisional: 'draft:s1', durable: 's1' }],
      hidden: ['s2'],
      pinnedTop: ['s1'],
      rows: { revision: 2, base: 1, railOrder: { head: 1, tail: 0, ids: ['s1'] }, statsRemoved: ['s2'] },
    },
  },
  { raw: { type: 'openPick', control: 'model' }, parsed: { type: 'openPick', control: 'model' } },
  {
    raw: { type: 'takeDraft', session: 's1', text: 'hello' },
    parsed: { type: 'takeDraft', session: 's1', text: 'hello' },
  },
  {
    raw: { type: 'takeQueuedDraft', session: 's1', text: 'hello', revision: 3, value: 'q1' },
    parsed: { type: 'takeQueuedDraft', session: 's1', text: 'hello', revision: 3, value: 'q1' },
  },
  {
    raw: { type: 'restoreDraft', session: 's1', text: 'hello', revision: 3 },
    parsed: { type: 'restoreDraft', session: 's1', text: 'hello', revision: 3 },
  },
  { raw: { type: 'notes', comments: [] }, parsed: { type: 'notes', comments: [] } },
  { raw: { type: 'openComment', key: 's1:1' }, parsed: { type: 'openComment', key: 's1:1' } },
  {
    raw: { type: 'sendSelectedText', key: 's1:1', copyLabels: true },
    parsed: { type: 'sendSelectedText', key: 's1:1', copyLabels: true },
  },
  {
    raw: { type: 'setRead', key: 's1:1', read: true },
    parsed: { type: 'setRead', key: 's1:1', read: true },
  },
  { raw: { type: 'forgetState', since: 17 }, parsed: { type: 'forgetState', since: 17 } },
  {
    raw: { type: 'setSessionRead', session: 's1', read: false },
    parsed: { type: 'setSessionRead', session: 's1', read: false },
  },
  {
    raw: { type: 'setSessionArchived', session: 's1', archived: true },
    parsed: { type: 'setSessionArchived', session: 's1', archived: true },
  },
  {
    raw: { type: 'setSessionPinned', session: 's1', pinned: true },
    parsed: { type: 'setSessionPinned', session: 's1', pinned: true },
  },
  {
    raw: { type: 'setComposerHidden', hidden: true },
    parsed: { type: 'setComposerHidden', hidden: true },
  },
  {
    raw: { type: 'results', query: 'label:perf', hits: [], scope: 'workspace' },
    parsed: { type: 'results', query: 'label:perf', hits: [], scope: 'workspace' },
  },
  { raw: SELECTION, parsed: SELECTION },
  { raw: RENDER, parsed: RENDER },
];

const PANEL: Array<{ raw: Record<string, unknown>; parsed: PanelToHost }> = [
  {
    raw: {
      type: 'readerRead',
      operation: { id: 'tab:1', namespace: 'browser', observedRevision: 0, action: 'reset', since: 10 },
    },
    parsed: {
      type: 'readerRead',
      operation: { id: 'tab:1', observedRevision: 0, action: 'reset', since: 10 },
    },
  },
  {
    raw: { type: 'sessionFilterApplied', request: 'one', state: {} },
    parsed: { type: 'sessionFilterApplied', request: 'one', state: {} },
  },
  { raw: { type: 'exportSession', session: 's1' }, parsed: { type: 'exportSession', session: 's1' } },
  { raw: { type: 'health', sequence: 1 }, parsed: { type: 'health', sequence: 1 } },
  {
    raw: { type: 'requestDefaults', agent: 'claude', model: '' },
    parsed: { type: 'requestDefaults', agent: 'claude', model: '' },
  },
  {
    raw: { type: 'importPromptRecovery', submittedPrompts: [], request: 'r' },
    parsed: { type: 'importPromptRecovery', submittedPrompts: [], request: 'r' },
  },
  {
    raw: { type: 'contextDetail', session: 's1', request: 1, generation: 0 },
    parsed: { type: 'contextDetail', session: 's1', request: 1, generation: 0 },
  },
  { raw: { type: 'ready', readerPageId: 'a'.repeat(32) }, parsed: { type: 'ready', readerPageId: 'a'.repeat(32) } },
  { raw: { type: 'rowsGap' }, parsed: { type: 'rowsGap' } },
  {
    raw: { type: 'painted', generation: 3, stage: 'firstCard' },
    parsed: { type: 'painted', generation: 3, stage: 'firstCard' },
  },
  { raw: { type: 'initialize' }, parsed: { type: 'initialize' } },
  { raw: { type: 'developmentReload' }, parsed: { type: 'developmentReload' } },
  { raw: { type: 'refresh' }, parsed: { type: 'refresh' } },
  {
    raw: { type: 'pathCompletion', session: 's1', request: 1, token: '~/Projects/wo', caret: 12 },
    parsed: { type: 'pathCompletion', session: 's1', request: 1, token: '~/Projects/wo', caret: 12 },
  },
  {
    raw: { type: 'perf', kind: 'render', ms: 12.5 },
    parsed: { type: 'perf', kind: 'render', ms: 12.5 },
  },
  { raw: { type: 'goBack' }, parsed: { type: 'goBack' } },
  { raw: { type: 'goForward' }, parsed: { type: 'goForward' } },
  {
    raw: { type: 'newSession', request: { kind: 'row', key: 'current' } },
    parsed: { type: 'newSession', request: { kind: 'row', key: 'current' } },
  },
  {
    raw: {
      type: 'pinSetup',
      request: {
        kind: 'row',
        key: 'recent:2',
        values: { agent: 'claude', model: 'opus', effort: 'high', permissionMode: 'default' },
      },
    },
    parsed: {
      type: 'pinSetup',
      request: {
        kind: 'row',
        key: 'recent:2',
        values: { agent: 'claude', model: 'opus', effort: 'high', permissionMode: 'default' },
      },
    },
  },
  { raw: { type: 'unpinSetup', id: 'pin-1' }, parsed: { type: 'unpinSetup', id: 'pin-1' } },
  {
    raw: { type: 'refreshUsage', agent: null, force: true },
    parsed: { type: 'refreshUsage', agent: null, force: true },
  },
  {
    raw: { type: 'openControl', control: 'mcp', session: 'draft-1' },
    parsed: { type: 'openControl', control: 'mcp', session: 'draft-1' },
  },
  {
    raw: {
      type: 'pick',
      control: 'model',
      agent: 'claude',
      session: 's1',
      model: 'opus',
      value: 'sonnet',
    },
    parsed: {
      type: 'pick',
      control: 'model',
      agent: 'claude',
      session: 's1',
      model: 'opus',
      value: 'sonnet',
    },
  },
  {
    raw: { type: 'draft', text: 'hi', keep: 'hi there', session: 's1' },
    parsed: { type: 'draft', text: 'hi', keep: 'hi there', session: 's1' },
  },
  {
    raw: { type: 'answerAsk', session: 's1', id: 'a1', answer: { decision: 'allow' } },
    parsed: { type: 'answerAsk', session: 's1', id: 'a1', answer: { decision: 'allow' } },
  },
  {
    raw: { type: 'beginFileStaging', session: 's1', token: 't1' },
    parsed: { type: 'beginFileStaging', session: 's1', token: 't1' },
  },
  {
    raw: {
      type: 'dropUris',
      session: 's1',
      types: ['resourceurls', 7],
      values: [
        { type: 'resourceurls', data: '[]' },
        { type: 'codeeditors', data: 5 },
      ],
    },
    parsed: {
      type: 'dropUris',
      session: 's1',
      types: ['resourceurls'],
      values: [{ type: 'resourceurls', data: '[]' }],
    },
  },
  {
    raw: { type: 'attachFiles', session: 's1', token: 't1', clipboard: true, files: [] },
    parsed: { type: 'attachFiles', session: 's1', token: 't1', clipboard: true, files: [] },
  },
  {
    raw: { type: 'fileReadError', session: 's1', token: 't1', name: 'one.png' },
    parsed: { type: 'fileReadError', session: 's1', token: 't1', name: 'one.png' },
  },
  {
    raw: {
      type: 'fileRejected',
      session: 's1',
      code: 'file-size',
      name: 'one.png',
      size: 900,
      rejected: 2,
    },
    parsed: {
      type: 'fileRejected',
      session: 's1',
      code: 'file-size',
      name: 'one.png',
      size: 900,
      rejected: 2,
    },
  },
  {
    raw: { type: 'removeFile', session: 's1', value: 'f1' },
    parsed: { type: 'removeFile', session: 's1', value: 'f1' },
  },
  {
    raw: { type: 'sendPrompt', text: 'go', session: 's1', revision: 2 },
    parsed: { type: 'sendPrompt', text: 'go', session: 's1', revision: 2 },
  },
  { raw: { type: 'compact', session: 's1' }, parsed: { type: 'compact', session: 's1' } },
  {
    raw: { type: 'dismissLive', session: 's1', kind: 'reply' },
    parsed: { type: 'dismissLive', session: 's1', kind: 'reply' },
  },
  {
    raw: { type: 'restoreLive', session: 's1', kind: 'reply' },
    parsed: { type: 'restoreLive', session: 's1', kind: 'reply' },
  },
  { raw: { type: 'stopTurn', session: 's1' }, parsed: { type: 'stopTurn', session: 's1' } },
  {
    raw: { type: 'dequeue', value: 'q1', session: 's1' },
    parsed: { type: 'dequeue', value: 'q1', session: 's1' },
  },
  {
    raw: { type: 'editQueued', value: 'q1', session: 's1', revision: 4 },
    parsed: { type: 'editQueued', value: 'q1', session: 's1', revision: 4 },
  },
  {
    raw: { type: 'acceptQueuedEdit', value: 'q1', session: 's1', revision: 4, currentRevision: 5, accepted: true },
    parsed: { type: 'acceptQueuedEdit', value: 'q1', session: 's1', revision: 4, currentRevision: 5, accepted: true },
  },
  { raw: { type: 'copy', text: 'words' }, parsed: { type: 'copy', text: 'words' } },
  {
    raw: { type: 'note', note: { op: 'write', note: { id: 'n1' } } },
    parsed: { type: 'note', note: { op: 'write', note: { id: 'n1' } } },
  },
  {
    raw: { type: 'armSelectedText', session: 's1', key: 's1:1' },
    parsed: { type: 'armSelectedText', session: 's1', key: 's1:1' },
  },
  {
    raw: { type: 'selectedTextHandoff', session: 's1', key: 's1:1', text: 'selected', copyLabels: false },
    parsed: { type: 'selectedTextHandoff', session: 's1', key: 's1:1', text: 'selected', copyLabels: false },
  },
  {
    raw: { type: 'armSessionDetails', session: 's1' },
    parsed: { type: 'armSessionDetails', session: 's1' },
  },
  { raw: { type: 'armComposer' }, parsed: { type: 'armComposer' } },
  { raw: { type: 'showReaderParent', session: 's1' }, parsed: { type: 'showReaderParent', session: 's1' } },
  { raw: { type: 'showSession', session: 's1' }, parsed: { type: 'showSession', session: 's1' } },
  { raw: { type: 'labelEditor', session: 's1' }, parsed: { type: 'labelEditor', session: 's1' } },
  {
    raw: { type: 'setLabels', session: 's1', names: ['perf', 'ui'] },
    parsed: { type: 'setLabels', session: 's1', names: ['perf', 'ui'] },
  },
  {
    raw: { type: 'setViews', views: [VIEW_ROW] },
    parsed: { type: 'setViews', views: [VIEW_ROW] },
  },
  {
    raw: { type: 'renameSession', session: 's1', request: 3, title: 'Full name' },
    parsed: { type: 'renameSession', session: 's1', request: 3, title: 'Full name' },
  },
  {
    raw: { type: 'setRailFilters', railFilters: [RAIL_FILTER_ROW] },
    parsed: { type: 'setRailFilters', railFilters: [RAIL_FILTER_ROW] },
  },
  {
    raw: { type: 'sessionMembership', action: 'pin', session: 's1', openPinned: true },
    parsed: { type: 'sessionMembership', action: 'pin', session: 's1', openPinned: true },
  },
  {
    raw: { type: 'setLayout', key: 'cardLayout', value: 'two-columns' },
    parsed: { type: 'setLayout', key: 'cardLayout', value: 'two-columns' },
  },
  {
    raw: { type: 'saveState', state: { open: ['s1:1'] } },
    parsed: { type: 'saveState', state: { open: ['s1:1'] } },
  },
  { raw: { type: 'search', text: 'label:perf' }, parsed: { type: 'search', text: 'label:perf' } },
  {
    raw: { type: 'loadOlder', session: 's1', token: 's1:0:40' },
    parsed: { type: 'loadOlder', session: 's1', token: 's1:0:40' },
  },
  {
    raw: { type: 'openLink', href: './notes.md', beside: true },
    parsed: { type: 'openLink', href: './notes.md', beside: true },
  },
  {
    raw: { type: 'openVisualization', path: 'chart.html' },
    parsed: { type: 'openVisualization', path: 'chart.html' },
  },
  {
    raw: { type: 'openImage', path: 'shot.png', beside: false },
    parsed: { type: 'openImage', path: 'shot.png', beside: false },
  },
  {
    raw: { type: 'openTurnDiff', key: 's1:1', beside: true },
    parsed: { type: 'openTurnDiff', key: 's1:1', beside: true },
  },
  {
    raw: { type: 'openCommit', key: 's1:1', sha: 'abc1234', dir: 'C:/work', beside: false },
    parsed: { type: 'openCommit', key: 's1:1', sha: 'abc1234', dir: 'C:/work', beside: false },
  },
  {
    raw: { type: 'openFile', key: 's1:1', path: 'C:/work/one.ts', beside: true },
    parsed: { type: 'openFile', key: 's1:1', path: 'C:/work/one.ts', beside: true },
  },
  {
    raw: { type: 'openSkill', key: 's1:1', path: 'C:/work/.claude/skills/polish/SKILL.md', beside: true },
    parsed: { type: 'openSkill', key: 's1:1', path: 'C:/work/.claude/skills/polish/SKILL.md', beside: true },
  },
];

// The typed handler record requires every host-message variant. Count and routing tests read its keys.
function hostRecorder(seen: string[]): HostToPanelHandlers {
  const take = (name: string) => () => {
    seen.push(name);
  };
  return {
    readState: take('readState'),
    readerReadAdmission: take('readerReadAdmission'),
    applySessionFilter: take('applySessionFilter'),
    visibility: take('visibility'),
    health: take('health'),
    contextDetail: take('contextDetail'),
    focusProjectSpend: take('focusProjectSpend'),
    openLauncher: take('openLauncher'),
    labelEditor: take('labelEditor'),
    labelsChanged: take('labelsChanged'),
    openLabelEditor: take('openLabelEditor'),
    showSessionDetails: take('showSessionDetails'),
    openViewEditor: take('openViewEditor'),
    openSessionRename: take('openSessionRename'),
    sessionRenameResult: take('sessionRenameResult'),
    focusComposer: take('focusComposer'),
    pathCompletion: take('pathCompletion'),
    insertPrompt: take('insertPrompt'),
    fileStaging: take('fileStaging'),
    fileStagingRejected: take('fileStagingRejected'),
    usage: take('usage'),
    askRejected: take('askRejected'),
    projectSpend: take('projectSpend'),
    layout: take('layout'),
    live: take('live'),
    activity: take('activity'),
    rail: take('rail'),
    openPick: take('openPick'),
    takeDraft: take('takeDraft'),
    takeQueuedDraft: take('takeQueuedDraft'),
    promptRecovery: take('promptRecovery'),
    requestPromptRecovery: take('requestPromptRecovery'),
    restoreDraft: take('restoreDraft'),
    notes: take('notes'),
    openComment: take('openComment'),
    sendSelectedText: take('sendSelectedText'),
    setRead: take('setRead'),
    forgetState: take('forgetState'),
    setSessionRead: take('setSessionRead'),
    setSessionArchived: take('setSessionArchived'),
    setSessionPinned: take('setSessionPinned'),
    setComposerHidden: take('setComposerHidden'),
    results: take('results'),
    selection: take('selection'),
    render: take('render'),
    startupProgress: take('startupProgress'),
  };
}

function panelRecorder(seen: string[]): PanelToHostHandlers<void> {
  const take = (name: string) => () => {
    seen.push(name);
  };
  return {
    readerRead: take('readerRead'),
    sessionFilterApplied: take('sessionFilterApplied'),
    contextDetail: take('contextDetail'),
    health: take('health'),
    ready: take('ready'),
    rowsGap: take('rowsGap'),
    painted: take('painted'),
    initialize: take('initialize'),
    developmentReload: take('developmentReload'),
    refresh: take('refresh'),
    perf: take('perf'),
    goBack: take('goBack'),
    goForward: take('goForward'),
    newSession: take('newSession'),
    pinSetup: take('pinSetup'),
    unpinSetup: take('unpinSetup'),
    refreshUsage: take('refreshUsage'),
    requestDefaults: take('requestDefaults'),
    openControl: take('openControl'),
    pick: take('pick'),
    draft: take('draft'),
    pathCompletion: take('pathCompletion'),
    answerAsk: take('answerAsk'),
    beginFileStaging: take('beginFileStaging'),
    attachFiles: take('attachFiles'),
    dropUris: take('dropUris'),
    fileReadError: take('fileReadError'),
    fileRejected: take('fileRejected'),
    removeFile: take('removeFile'),
    importPromptRecovery: take('importPromptRecovery'),
    sendPrompt: take('sendPrompt'),
    compact: take('compact'),
    dismissLive: take('dismissLive'),
    restoreLive: take('restoreLive'),
    stopTurn: take('stopTurn'),
    dequeue: take('dequeue'),
    editQueued: take('editQueued'),
    acceptQueuedEdit: take('acceptQueuedEdit'),
    copy: take('copy'),
    note: take('note'),
    armSelectedText: take('armSelectedText'),
    selectedTextHandoff: take('selectedTextHandoff'),
    armSessionDetails: take('armSessionDetails'),
    armComposer: take('armComposer'),
    showReaderParent: take('showReaderParent'),
    showSession: take('showSession'),
    labelEditor: take('labelEditor'),
    setLabels: take('setLabels'),
    setViews: take('setViews'),
    renameSession: take('renameSession'),
    setRailFilters: take('setRailFilters'),
    sessionMembership: take('sessionMembership'),
    setLayout: take('setLayout'),
    exportSession: take('exportSession'),
    saveState: take('saveState'),
    search: take('search'),
    loadOlder: take('loadOlder'),
    openLink: take('openLink'),
    openVisualization: take('openVisualization'),
    openImage: take('openImage'),
    openTurnDiff: take('openTurnDiff'),
    openCommit: take('openCommit'),
    openFile: take('openFile'),
    openSkill: take('openSkill'),
  };
}

test('every message the extension sends parses and reaches its own handler', () => {
  for (const one of HOST) {
    const raw = one.raw as Record<string, unknown>;
    const parsed = parseHostToPanel(one.raw);
    assert.deepEqual(parsed, one.parsed, `${String(raw.type)} did not parse to its variant`);
    const seen: string[] = [];
    dispatchHostToPanel(parsed!, hostRecorder(seen));
    assert.deepEqual(seen, [raw.type], `${String(raw.type)} reached the wrong handler`);
  }
});

test('every message the panel sends parses and reaches its own handler', () => {
  for (const one of PANEL) {
    const raw = one.raw;
    const parsed = parsePanelToHost(one.raw);
    assert.deepEqual(parsed, one.parsed, `${String(raw.type)} did not parse to its variant`);
    const seen: string[] = [];
    dispatchPanelToHost(parsed!, panelRecorder(seen));
    assert.deepEqual(seen, [raw.type], `${String(raw.type)} reached the wrong handler`);
  }
});

test('an Activity card list parses and reaches the existing handler', () => {
  const raw = {
    type: 'activity',
    cards: [
      { key: 's1:1', sessionId: 's1' },
      { key: 's2:1', sessionId: 's2' },
    ],
  };
  const parsed = parseHostToPanel(raw);
  assert.deepEqual(parsed, raw);
  const seen: string[] = [];
  dispatchHostToPanel(parsed!, hostRecorder(seen));
  assert.deepEqual(seen, ['activity']);
});

test('pin messages require a complete launcher request or a nonempty id', () => {
  for (const raw of [
    { type: 'pinSetup' },
    { type: 'pinSetup', request: null },
    { type: 'pinSetup', request: { kind: 'row' } },
    { type: 'pinSetup', request: { kind: 'row', key: 'recent:0' } },
    { type: 'pinSetup', request: { kind: 'row', key: 'recent:0', values: { agent: 'claude', model: 'x' } } },
    {
      type: 'pinSetup',
      request: {
        kind: 'row',
        key: 'recent:0',
        values: { agent: 'claude', model: 'x'.repeat(201), effort: '', permissionMode: '' },
      },
    },
    { type: 'pinSetup', request: { kind: 'custom', agent: 'claude' } },
    { type: 'unpinSetup' },
    { type: 'unpinSetup', id: '' },
    { type: 'unpinSetup', id: '   ' },
    { type: 'unpinSetup', id: 'x'.repeat(65) },
    { type: 'unpinSetup', id: 7 },
  ]) {
    assert.equal(parsePanelToHost(raw), null);
  }
});

test('the inventory covers every variant both dispatchers name', () => {
  assert.deepEqual(
    HOST.map((one) => (one.raw as Record<string, unknown>).type).sort(),
    Object.keys(hostRecorder([])).sort(),
    'a message the extension sends has no sample, or a sample names no variant',
  );
  assert.deepEqual(
    PANEL.map((one) => one.raw.type).sort(),
    Object.keys(panelRecorder([])).sort(),
    'a message the panel sends has no sample, or a sample names no variant',
  );
});

test('extra fields are dropped, and the render payload is handed back whole', () => {
  assert.deepEqual(parseHostToPanel({ type: 'focusComposer', session: 's1', extra: 1 }), {
    type: 'focusComposer',
    session: 's1',
  });
  assert.deepEqual(parsePanelToHost({ type: 'refresh', extra: 1 }), { type: 'refresh' });
  assert.deepEqual(parsePanelToHost({ type: 'ready' }), { type: 'ready' });
  assert.equal(parsePanelToHost({ type: 'ready', readerPageId: 'invalid' }), null);
  // Render parsing preserves the complete payload, including fields beyond the required contract.
  const render = { ...RENDER, anything: { deep: true } };
  assert.equal(parseHostToPanel(render), render);
});

test('context wire refuses invalid identity and reduces oversized detail to matching unavailable status', () => {
  assert.equal(
    parseHostToPanel({ type: 'contextDetail', detail: { ...CONTEXT_DETAIL, session: 'x'.repeat(257) } }),
    null,
  );
  const rejected = parseHostToPanel({
    type: 'contextDetail',
    detail: { ...CONTEXT_DETAIL, categories: Array(33).fill({ name: 'x', tokens: 1 }) },
  });
  assert.ok(rejected?.type === 'contextDetail');
  assert.equal(rejected.detail.status, 'unavailable');
  assert.equal(rejected.detail.request, CONTEXT_DETAIL.request);
  const oversized = parseHostToPanel({
    type: 'contextDetail',
    detail: { ...CONTEXT_DETAIL, extra: 'x'.repeat(32769) },
  });
  assert.ok(oversized?.type === 'contextDetail');
  assert.equal(oversized.detail.status, 'unavailable');
  assert.ok(JSON.stringify(oversized.detail).length < 32768);
  assert.equal('extra' in oversized.detail, false);
  assert.equal(parsePanelToHost({ type: 'contextDetail', session: 's1', request: -1, generation: 0 }), null);
});

test('context wire preserves bounded active reasons and rejects invented explanations', () => {
  const identity = { ...CONTEXT_DETAIL, provider: 'codex' as const };
  for (const reason of ['pending-tools', 'awaiting-measurement']) {
    const detail = { ...unavailableContext(identity), reason };
    assert.deepEqual(parseHostToPanel({ type: 'contextDetail', detail }), { type: 'contextDetail', detail });
  }
  for (const reason of ['unknown', '', null, ['pending-tools'], 'x'.repeat(32769)]) {
    const parsed = parseHostToPanel({ type: 'contextDetail', detail: { ...unavailableContext(identity), reason } });
    assert.ok(parsed?.type === 'contextDetail');
    assert.equal(parsed.detail.status, 'unavailable');
    assert.equal(parsed.detail.reason, undefined);
  }
});

const MALFORMED_HOST_CONTAINERS: unknown[] = [
  {
    type: 'rail',
    rail: [],
    stats: {},
    labels: [],
    views: [],
    railFilters: [],
    hidden: [],
    pinnedTop: [],
    rows: { revision: 1, base: 'x' },
  },
  {
    type: 'rail',
    rail: [],
    stats: {},
    labels: [],
    views: [],
    railFilters: [],
    hidden: [],
    pinnedTop: [],
    rows: { revision: 2, base: 1, railOrder: { head: -1, tail: 0, ids: [] } },
  },
  {
    type: 'rail',
    rail: [],
    stats: {},
    labels: [],
    views: [],
    railFilters: [],
    hidden: [],
    pinnedTop: [],
    rows: { revision: 2, base: 1, sessionsBase: 'x' },
  },
  { type: 'rail', rail: {}, stats: {}, labels: [], views: [] },
  { type: 'rail', rail: [], stats: [], labels: [], views: [] },
  { type: 'rail', rail: [], stats: {}, labels: [{ name: 'perf' }], views: [] },
  // Saved views reach the panel in rail and render messages. The parser rejects malformed lists and rows with missing fields.
  { type: 'rail', rail: [], stats: {}, labels: [] },
  { type: 'rail', rail: [], stats: {}, labels: [], views: {} },
  { type: 'rail', rail: [], stats: {}, labels: [], views: [null] },
  { type: 'rail', rail: [], stats: {}, labels: [], views: [{ ...VIEW_ROW }] },
  { type: 'rail', rail: [], stats: {}, labels: [], views: [], railFilters: {} },
  { type: 'rail', rail: [], stats: {}, labels: [], views: [], railFilters: [null] },
  { type: 'rail', rail: [], stats: {}, labels: [], views: [], railFilters: [{ ...RAIL_FILTER_ROW, sort: 'sideways' }] },
  { type: 'rail', rail: [], stats: {}, labels: [], views: [], railFilters: [], sessionAdoptions: [{}] },
  { type: 'rail', rail: [], stats: {}, labels: [], views: [], railFilters: [], pinnedTop: [] },
  { type: 'rail', rail: [], stats: {}, labels: [], views: [], railFilters: [], hidden: [] },
  { type: 'rail', rail: [], stats: {}, labels: [], views: [], railFilters: [], hidden: [7], pinnedTop: [] },
  { type: 'rail', rail: [], stats: {}, labels: [], views: [], railFilters: [], hidden: [], pinnedTop: {} },
  { ...RENDER, rail: {} },
  { ...RENDER, stats: [] },
  { ...RENDER, hidden: {} },
  { ...RENDER, pinnedTop: [7] },
  { ...RENDER, comments: {} },
  { ...RENDER, comments: [null] },
  { ...RENDER, views: 'v1' },
  { ...RENDER, sessionAdoptions: {} },
  { ...RENDER, sessionAdoptions: [{ provisional: 7, durable: 's1' }] },
];

test('a staging notice keeps a positive whole file count and drops any other', () => {
  const staging = { type: 'fileStaging', session: 's1', token: 't1', pending: true };
  assert.deepEqual(parseHostToPanel({ ...staging, count: 3 }), { ...staging, count: 3 });
  for (const count of [0, -1, 1.5, '3', null]) {
    assert.deepEqual(parseHostToPanel({ ...staging, count }), staging);
  }
});

test('a field the reader treated as missing arrives with the value it always had', () => {
  assert.deepEqual(parseHostToPanel({ type: 'fileStaging', session: 's1' }), {
    type: 'fileStaging',
    session: 's1',
    token: '',
    pending: false,
  });
  assert.deepEqual(parsePanelToHost({ type: 'draft', text: 'hi', session: 's1' }), {
    type: 'draft',
    text: 'hi',
    keep: 'hi',
    session: 's1',
  });
  assert.deepEqual(parsePanelToHost({ type: 'refreshUsage' }), { type: 'refreshUsage', agent: null, force: false });
  assert.deepEqual(parsePanelToHost({ type: 'search' }), { type: 'search', text: '' });
  assert.deepEqual(parsePanelToHost({ type: 'fileRejected', session: 's1' }), {
    type: 'fileRejected',
    session: 's1',
    code: 'read',
    name: '',
    size: 0,
    rejected: 0,
  });
  assert.deepEqual(parsePanelToHost({ type: 'openCommit', key: 's1:1', sha: 'abc' }), {
    type: 'openCommit',
    key: 's1:1',
    sha: 'abc',
    dir: null,
    beside: false,
  });
  assert.deepEqual(parsePanelToHost({ type: 'sendPrompt', text: 'go', session: 's1', revision: -2 }), {
    type: 'sendPrompt',
    text: 'go',
    session: 's1',
    revision: 0,
  });
});

test('a malformed message from the extension is refused', () => {
  const refused: unknown[] = [
    null,
    undefined,
    42,
    'render',
    [],
    [{ type: 'render' }],
    { type: 'ghost' },
    { type: 7 },
    {},
    { type: 'focusComposer' },
    { type: 'focusComposer', session: { id: 's1' } },
    { type: 'focusComposer', session: ['s1'] },
    { type: 'focusComposer', session: { toString: () => 's1' } },
    { type: 'showSessionDetails' },
    { type: 'showSessionDetails', session: '' },
    { type: 'showSessionDetails', session: 7 },
    { type: 'showSessionDetails', session: { id: 's1' } },
    { type: 'labelEditor', session: 7, rows: [] },
    { type: 'labelEditor', session: 's1', heading: 'Labels', rows: [null] },
    { type: 'labelEditor', session: 's1', heading: 'Labels', rows: [{ name: 'perf' }] },
    { type: 'fileStaging', session: null, token: 't1', pending: true },
    { type: 'fileStagingRejected', session: 's1' },
    { type: 'askRejected', session: 's1', id: 1 },
    { type: 'layout', layout: { cardLayout: 'three-columns', promptPosition: 'above' } },
    { type: 'layout', layout: { cardLayout: 'one-column', promptPosition: 'beside' } },
    { type: 'live', live: [LIVE] },
    { type: 'live', session: 's1' },
    { type: 'live', session: 's1', live: { kind: 'prompt' } },
    { type: 'live', session: 's1', live: [{ ...LIVE, reply: 7 }] },
    { type: 'live', session: 's1', live: [{ ...LIVE, files: [{ ...LIVE_FILE, id: 7 }] }] },
    { type: 'live', session: 's1', live: [{ ...LIVE, files: [{ ...LIVE_FILE, preview: 7 }] }] },
    { type: 'live', session: 's1', live: [{ ...LIVE, files: [{ ...LIVE_FILE, removeControl: 7 }] }] },
    { type: 'render', cards: [], sessions: [], labels: [], iconFonts: 'not-a-list' },
    { type: 'render', cards: [null], sessions: [], labels: [], iconFonts: [] },
    { type: 'render', cards: [], sessions: [], labels: [{ name: 'perf' }], iconFonts: [] },
    ...MALFORMED_HOST_CONTAINERS,
    { type: 'restoreDraft', session: 's1', text: 'hi', revision: '3' },
    { type: 'takeDraft', session: 's1' },
    { type: 'forgetState', since: '17' },
    { type: 'openComment', key: { key: 's1:1' } },
    { type: 'sendSelectedText', key: '', copyLabels: true },
    { type: 'sendSelectedText', key: 's1:1' },
    { type: 'sendSelectedText', key: 's1:1', copyLabels: 'yes' },
    { type: 'results', query: 'one', hits: [], scope: 7 },
    { type: 'openPick', control: null },
  ];
  for (const raw of refused) {
    assert.equal(parseHostToPanel(raw), null, JSON.stringify(raw) ?? String(raw));
  }
});

test('malformed state containers never reach a panel handler', () => {
  const seen: string[] = [];
  const handlers = hostRecorder(seen);
  for (const raw of MALFORMED_HOST_CONTAINERS) {
    const parsed = parseHostToPanel(raw);
    if (parsed) {
      dispatchHostToPanel(parsed, handlers);
    }
  }
  assert.deepEqual(seen, []);
});

test('a malformed message from the panel is refused', () => {
  const refused: unknown[] = [
    null,
    undefined,
    0,
    'refresh',
    [],
    { type: 'ghost' },
    { type: null },
    { type: 'pick', agent: 'claude', value: 'sonnet' },
    { type: 'pick', agent: ['claude'], value: 'sonnet', session: 's1' },
    { type: 'pick', agent: 'claude', value: null, session: 's1' },
    { type: 'draft', text: 'hi', session: { id: 's1' } },
    { type: 'sendPrompt', text: 'go' },
    { type: 'copy' },
    { type: 'copy', text: 7 },
    { type: 'showSession', session: null },
    { type: 'sessionMembership' },
    { type: 'sessionMembership', action: 'archive' },
    { type: 'sessionMembership', action: 'archive', session: 7 },
    { type: 'sessionMembership', action: 'erase', session: 's1' },
    { type: 'sessionMembership', action: 'pin', session: 's1', openPinned: 'yes' },
    { type: 'armSessionDetails' },
    { type: 'armSessionDetails', session: '' },
    { type: 'armSessionDetails', session: 7 },
    { type: 'setLabels', session: 's1', names: 'perf' },
    { type: 'openFile', key: 's1:1' },
    { type: 'openFile', path: 'C:/work/one.ts' },
    { type: 'openSkill', key: 's1:1' },
    { type: 'openSkill', path: 'C:/work/.claude/skills/polish/SKILL.md' },
    { type: 'perf', kind: '', ms: 1 },
    { type: 'perf', kind: 'reader-owned text', ms: 1 },
    { type: 'perf', kind: 'render', ms: -1 },
    { type: 'perf', kind: 'render', ms: Number.NaN },
    { type: 'perf', kind: 'render', ms: Number.POSITIVE_INFINITY },
    { type: 'openLink', href: { href: './notes.md' } },
    { type: 'loadOlder' },
    { type: 'removeFile', session: 's1' },
    { type: 'stopTurn', session: 7 },
    { type: 'attachFiles', token: 't1', files: [] },
    { type: 'armSelectedText', session: '', key: 's1:1' },
    { type: 'armSelectedText', session: 's1', key: '' },
    { type: 'armSelectedText', session: 's1' },
    { type: 'selectedTextHandoff', session: '', key: 's1:1', text: 'selected', copyLabels: true },
    { type: 'selectedTextHandoff', session: 's1', key: '', text: 'selected', copyLabels: true },
    { type: 'selectedTextHandoff', session: 's1', key: 's1:1', text: '', copyLabels: true },
    { type: 'selectedTextHandoff', session: 's1', key: 's1:1', text: '   ', copyLabels: true },
    { type: 'selectedTextHandoff', session: 's1', key: 's1:1', text: 'selected' },
    { type: 'selectedTextHandoff', session: 's1', key: 's1:1', text: 'selected', copyLabels: 1 },
  ];
  for (const raw of refused) {
    assert.equal(parsePanelToHost(raw), null, JSON.stringify(raw) ?? String(raw));
  }
});

test('a launcher request that names no offered shape is refused', () => {
  assert.deepEqual(parsePanelToHost({ type: 'newSession' }), { type: 'newSession' });
  const refused: unknown[] = [
    { type: 'newSession', request: null },
    { type: 'newSession', request: 'row' },
    { type: 'newSession', request: { kind: 'row' } },
    { type: 'newSession', request: { kind: 'row', key: 7 } },
    { type: 'newSession', request: { kind: 'custom', agent: 'claude' } },
    {
      type: 'newSession',
      request: { kind: 'custom', agent: 'claude', model: 'opus', effort: 'high', permissionMode: 7 },
    },
  ];
  for (const raw of refused) {
    assert.equal(parsePanelToHost(raw), null, JSON.stringify(raw));
  }
});

// The panel posts the whole saved-view list back. The host normalizes stored views, while the message parser checks each field's type.
test('a saved view crossing the wire is checked field by field', () => {
  // Check empty and populated saved-view lists.
  assert.deepEqual(parsePanelToHost({ type: 'setViews', views: [] }), { type: 'setViews', views: [] });
  assert.deepEqual(parsePanelToHost({ type: 'setViews', views: [VIEW_ROW, { ...VIEW_ROW, id: 'v2', name: 'Mine' }] }), {
    type: 'setViews',
    views: [VIEW_ROW, { ...VIEW_ROW, id: 'v2', name: 'Mine' }],
  });
  const broken: Record<string, unknown>[] = [
    { ...VIEW_ROW, id: '' },
    { ...VIEW_ROW, id: 7 },
    { ...VIEW_ROW, name: null },
    { ...VIEW_ROW, query: 7 },
    { ...VIEW_ROW, archived: 'yes' },
    { id: 'v1', name: 'Perf work' },
  ];
  for (const row of broken) {
    assert.equal(parsePanelToHost({ type: 'setViews', views: [row] }), null, JSON.stringify(row));
    // Reject the whole list when any row is invalid, so parsing cannot silently remove a displayed view.
    assert.equal(parsePanelToHost({ type: 'setViews', views: [VIEW_ROW, row] }), null, JSON.stringify(row));
  }
  for (const views of [undefined, null, 'v1', 42, {}, [null], [[VIEW_ROW]]]) {
    assert.equal(parsePanelToHost({ type: 'setViews', views }), null, JSON.stringify(views) ?? 'undefined');
  }
});

test('a saved rail filter crossing the wire is checked field by field', () => {
  // Reject unknown layout values and values belonging to another setting.
  assert.deepEqual(parsePanelToHost({ type: 'setLayout', key: 'promptPosition', value: 'below' }), {
    type: 'setLayout',
    key: 'promptPosition',
    value: 'below',
  });
  for (const raw of [
    { type: 'setLayout', key: 'cardLayout', value: 'below' },
    { type: 'setLayout', key: 'details', value: 'chips' },
    { type: 'setLayout', key: 'prompt', value: 'after' },
    { type: 'setLayout', key: 'promptPosition', value: 'compact' },
    { type: 'setLayout', key: 'maxSessions', value: 'chips' },
    { type: 'setLayout', key: 'cardLayout' },
  ]) {
    assert.equal(parsePanelToHost(raw), null, JSON.stringify(raw));
  }
  assert.deepEqual(parsePanelToHost({ type: 'setRailFilters', railFilters: [] }), {
    type: 'setRailFilters',
    railFilters: [],
  });
  // Retained lens fields do not change the parsed filter query.
  const { lens: _lens, ...noLens } = RAIL_FILTER_ROW;
  for (const row of [noLens, { ...RAIL_FILTER_ROW, lens: null }, { ...RAIL_FILTER_ROW, lens: 'needs-you' }]) {
    assert.deepEqual(
      parsePanelToHost({ type: 'setRailFilters', railFilters: [row] }),
      { type: 'setRailFilters', railFilters: [row] },
      JSON.stringify(row),
    );
  }
  const broken: Record<string, unknown>[] = [
    { ...RAIL_FILTER_ROW, id: '' },
    { ...RAIL_FILTER_ROW, id: 7 },
    { ...RAIL_FILTER_ROW, name: null },
    { ...RAIL_FILTER_ROW, query: 7 },
    { ...RAIL_FILTER_ROW, sort: 'sideways' },
    { ...RAIL_FILTER_ROW, lens: 'warm' },
    { ...RAIL_FILTER_ROW, lens: 7 },
    { id: 'f1', name: 'Unread costs' },
  ];
  for (const row of broken) {
    assert.equal(parsePanelToHost({ type: 'setRailFilters', railFilters: [row] }), null, JSON.stringify(row));
    assert.equal(
      parsePanelToHost({ type: 'setRailFilters', railFilters: [RAIL_FILTER_ROW, row] }),
      null,
      JSON.stringify(row),
    );
  }
  for (const railFilters of [undefined, null, 'f1', 42, {}, [null], [[RAIL_FILTER_ROW]]]) {
    assert.equal(
      parsePanelToHost({ type: 'setRailFilters', railFilters }),
      null,
      JSON.stringify(railFilters) ?? 'undefined',
    );
  }
});

// Native view commands carry the view id and editor mode. Form values stay in the panel.
test('the view editor opens on a named view and one of two presses', () => {
  assert.deepEqual(parseHostToPanel({ type: 'openViewEditor', view: 'v1', mode: 'delete' }), {
    type: 'openViewEditor',
    view: 'v1',
    mode: 'delete',
  });
  const refused: unknown[] = [
    { type: 'openViewEditor', view: 'v1' },
    { type: 'openViewEditor', view: 'v1', mode: 'remove' },
    { type: 'openViewEditor', view: 'v1', mode: null },
    { type: 'openViewEditor', view: 'v1', mode: ['rename'] },
    { type: 'openViewEditor', mode: 'rename' },
    { type: 'openViewEditor', view: 7, mode: 'rename' },
  ];
  for (const raw of refused) {
    assert.equal(parseHostToPanel(raw), null, JSON.stringify(raw));
  }
});

// Rename requests and results require session and request identities.
// Open-editor messages require session identity and a text title.
test('a session rename message names a session and a request and carries text', () => {
  for (const raw of [
    { type: 'renameSession', session: '', request: 1, title: 'Name' },
    { type: 'renameSession', session: 's1', request: 1 },
    { type: 'renameSession', session: 's1', request: 1, title: 7 },
    { type: 'renameSession', session: 's1', title: 'Name' },
    { type: 'renameSession', session: 's1', request: '1', title: 'Name' },
  ]) {
    assert.equal(parsePanelToHost(raw), null, JSON.stringify(raw));
  }
  for (const raw of [
    { type: 'openSessionRename', session: '', title: 'Name' },
    { type: 'openSessionRename', session: 's1', title: null },
    { type: 'sessionRenameResult', session: 's1', request: 1, title: 'Name' },
    { type: 'sessionRenameResult', session: '', request: 1, title: 'Name', error: '' },
    { type: 'sessionRenameResult', session: 's1', title: 'Name', error: '' },
  ]) {
    assert.equal(parseHostToPanel(raw), null, JSON.stringify(raw));
  }
});

test('an answer to an ask is read down to what the reader picked and what they wrote', () => {
  assert.deepEqual(
    parsePanelToHost({
      type: 'answerAsk',
      session: 's1',
      id: 'a1',
      answer: {
        decision: 'answer',
        answers: { q1: { labels: ['one', 'two'], written: '' }, q2: { labels: [], written: 'my own' } },
      },
    }),
    {
      type: 'answerAsk',
      session: 's1',
      id: 'a1',
      answer: {
        decision: 'answer',
        answers: { q1: { labels: ['one', 'two'], written: '' }, q2: { labels: [], written: 'my own' } },
      },
    },
  );
  assert.deepEqual(
    parsePanelToHost({ type: 'answerAsk', session: 's1', id: 'a1', answer: { decision: 'deny', reason: 'no' } }),
    { type: 'answerAsk', session: 's1', id: 'a1', answer: { decision: 'deny', reason: 'no' } },
  );
  const refused: unknown[] = [
    { type: 'answerAsk', session: 's1', id: 'a1', answer: {} },
    { type: 'answerAsk', session: 's1', id: 'a1', answer: { decision: 'deny' } },
    { type: 'answerAsk', session: 's1', id: 'a1', answer: { decision: 'allowed' } },
    { type: 'answerAsk', session: 's1', id: 'a1', answer: { decision: 'answer' } },
    {
      type: 'answerAsk',
      session: 's1',
      id: 'a1',
      answer: { decision: 'answer', answers: { q1: 'one' } },
    },
    {
      type: 'answerAsk',
      session: 's1',
      id: 'a1',
      answer: { decision: 'answer', answers: { q1: ['one', 'two'] } },
    },
    {
      type: 'answerAsk',
      session: 's1',
      id: 'a1',
      answer: { decision: 'answer', answers: { q1: { labels: ['one', 7], written: '' } } },
    },
    {
      type: 'answerAsk',
      session: 's1',
      id: 'a1',
      answer: { decision: 'answer', answers: { q1: { labels: ['one'] } } },
    },
  ];
  for (const raw of refused) {
    assert.equal(parsePanelToHost(raw), null, JSON.stringify(raw));
  }
});

test('external session filter messages require bounded queries and correlation', () => {
  const apply = {
    type: 'applySessionFilter',
    request: 'window:one',
    query: 'session:one OR session:codex:two',
    deadline: 1234,
  };
  assert.deepEqual(parseHostToPanel(apply), apply);
  const ack = { type: 'sessionFilterApplied', request: 'window:one', state: { railFilter: apply.query } };
  assert.deepEqual(parsePanelToHost(ack), ack);
  for (const bad of [
    { ...apply, extra: true },
    { ...apply, query: 'session:one OR' },
    { ...apply, query: 'x'.repeat(201) },
    { ...apply, request: '' },
    { ...apply, deadline: NaN },
  ])
    assert.equal(parseHostToPanel(bad), null);
  for (const bad of [
    { ...ack, extra: true },
    { ...ack, request: '' },
    { ...ack, state: null },
  ])
    assert.equal(parsePanelToHost(bad), null);
});
