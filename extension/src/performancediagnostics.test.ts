import { meterRead, readPhase, meterReadWork, withReadMetrics, type ReadMetrics } from './readmeter';
import { test } from 'vitest';
import assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  PERFORMANCE_DIAGNOSTICS_DIRECTORY_VARIABLE,
  PERFORMANCE_DIAGNOSTICS_SCHEMA_VERSION,
  PanelPerformanceCounters,
  PerformanceDiagnosticState,
  type PerformanceDiagnosticsFailure,
  messageByteBudget,
  performanceDiagnosticsFileName,
  projectPerformanceDiagnostics,
  savePerformanceDiagnosticsSnapshot,
  serializedMessageBytes,
} from './performancediagnostics.ts';
import { tempDir } from './temproot.ts';

function state(counters: ReturnType<PanelPerformanceCounters['snapshot']>): PerformanceDiagnosticState {
  return {
    panel: {
      hostCount: 2,
      visibleHostCount: 1,
      editorPanelOpen: true,
      polling: true,
      watching: true,
      hasSelection: true,
      activeChildCount: 4,
    },
    rail: {
      listedSessionCount: 12,
      parsedSessionCount: 3,
      rowCount: 13,
      pinCount: 4,
      archiveCount: 2,
      messageType: 'render',
      messageSerializedBytes: 900,
    },
    cacheBytes: { parsedTails: 100, retainedTails: 80, olderHistory: 40, patches: 20 },
    watcher: {
      pending: true,
      queuedEventCount: 6,
      distinctPathCount: 4,
      broadRequired: false,
      oldestPendingWakeAgeMs: 175,
    },
    ledger: {
      revision: 9,
      rebuilding: true,
      sourceCount: 8,
      completeDisplaySourceCount: 7,
      queuedSourceCount: 2,
      savePending: true,
      oldestPendingCheckpointAgeMs: 450,
    },
    counters,
  };
}

test('performance counters correlate posts and replies for every open panel', () => {
  const counters = new PanelPerformanceCounters(1_000, 'window-a');
  const firstPanel = {};
  const secondPanel = {};
  const idlePanel = {};
  counters.registerPanel(firstPanel);
  counters.registerPanel(secondPanel);
  counters.registerPanel(idlePanel);
  counters.recordRefresh('watcher', 8);
  counters.recordRefresh('watcher', 12);
  counters.recordRefresh('poll', 3);
  counters.recordRefreshStage('started');
  counters.recordRefreshStage('coalesced');
  counters.recordRefreshStage('coalesced');
  counters.recordRefreshStage('unchanged');
  counters.recordRefreshStage('rendered');
  counters.recordMessage('rail', 120, firstPanel);
  counters.recordMessage('rail', 80, firstPanel);
  counters.recordMessage('rail', null, secondPanel);
  counters.recordPanelMessage('render', 12, firstPanel);
  counters.recordPanelMessage('render', 8, firstPanel);
  counters.recordPanelMessage('rail', 3, secondPanel);
  counters.recordWatcherOperation({
    reason: 'transcript',
    eventCount: 4,
    distinctPathCount: 4,
    waitMs: 200,
    maximumWaitFired: false,
    decision: 'targeted',
    durationMs: 12,
  });
  counters.recordLedgerSave({ reason: 'maximum', durationMs: 20, succeeded: true });

  assert.deepEqual(counters.snapshot(), {
    discovery: {
      readBytes: 0,
      receiptEntries: 0,
      receiptChecks: 0,
      receiptBytes: 0,
      hits: 0,
      resets: 0,
      quanta: 0,
      dispatchRetries: 0,
      parentChecks: 0,
      parentCheckMs: 0,
      childHeadFiles: 0,
      childHeadBytes: 0,
      childHeadMs: 0,
      dispatchSpendVisits: 0,
      dispatchSpendRereads: 0,
      dispatchSpendFiles: 0,
      dispatchSpendBytes: 0,
      dispatchSpendMs: 0,
      dispatchSpendAggregateStarts: 0,
      dispatchSpendAggregateCompletions: 0,
      dispatchSpendRelationshipInvalidations: 0,
      dispatchSpendConsumedSourceInvalidations: 0,
      dispatchSpendSourceRestarts: 0,
      dispatchSpendParserAdvancements: 0,
      dispatchSpendRootWaits: 0,
      continuations: 0,
      publications: 0,
    },
    sourceId: 'window-a',
    startedAt: '1970-01-01T00:00:01.000Z',
    captureCount: 0,
    refreshes: {
      poll: { count: 1, totalDurationMs: 3, maximumDurationMs: 3, lastDurationMs: 3 },
      watcher: { count: 2, totalDurationMs: 20, maximumDurationMs: 12, lastDurationMs: 12 },
    },
    refreshStages: { started: 1, coalesced: 2, unchanged: 1, rendered: 1, abandoned: 0 },
    messages: {
      rail: {
        count: 3,
        serializedBytes: 200,
        maximumSerializedBytes: 120,
        unavailableByteCount: 1,
      },
    },
    panelPosts: {
      'panel-1': {
        rail: { count: 2, serializedBytes: 200, maximumSerializedBytes: 120, unavailableByteCount: 0 },
      },
      'panel-2': {
        rail: { count: 1, serializedBytes: 0, maximumSerializedBytes: 0, unavailableByteCount: 1 },
      },
      'panel-3': {},
    },
    panelMessages: {
      rail: { count: 1, totalDurationMs: 3, maximumDurationMs: 3, lastDurationMs: 3 },
      render: { count: 2, totalDurationMs: 20, maximumDurationMs: 12, lastDurationMs: 8 },
    },
    panelReplies: {
      'panel-1': {
        render: { count: 2, totalDurationMs: 20, maximumDurationMs: 12, lastDurationMs: 8 },
      },
      'panel-2': {
        rail: { count: 1, totalDurationMs: 3, maximumDurationMs: 3, lastDurationMs: 3 },
      },
      'panel-3': {},
    },
    watcherOperationCount: 1,
    ledgerSaveCount: 1,
    lastWatcherOperation: {
      id: 1,
      reason: 'transcript',
      eventCount: 4,
      distinctPathCount: 4,
      waitMs: 200,
      maximumWaitFired: false,
      decision: 'targeted',
      durationMs: 12,
    },
    lastLedgerSave: { id: 1, reason: 'maximum', durationMs: 20, succeeded: true },
  });
});

test('released panels leave no diagnostic entry after repeated disposal', () => {
  const counters = new PanelPerformanceCounters(1_000, 'window-a');
  const disposedPanel = {};
  counters.registerPanel(disposedPanel);
  counters.recordMessage('render', 20, disposedPanel);
  counters.releasePanel(disposedPanel);
  counters.releasePanel(disposedPanel);

  const replacementPanel = {};
  counters.registerPanel(replacementPanel);
  assert.deepEqual(counters.snapshot().panelPosts, { 'panel-2': {} });
  assert.deepEqual(counters.snapshot().panelReplies, { 'panel-2': {} });
});

test('the diagnostics projector emits the schema and only its redacted allowlist', () => {
  const counters = new PanelPerformanceCounters(1_000, 'window-a');
  counters.recordCapture();
  const input = state(counters.snapshot()) as ReturnType<typeof state> & {
    prompt: string;
    transcript: unknown;
    environment: unknown;
  };
  input.prompt = 'secret prompt';
  input.transcript = { text: 'secret transcript' };
  input.environment = { TOKEN: 'secret' };

  const projected = projectPerformanceDiagnostics(input, 2_000) as Record<string, unknown>;

  assert.equal(projected.schemaVersion, PERFORMANCE_DIAGNOSTICS_SCHEMA_VERSION);
  assert.equal(projected.capturedAt, '1970-01-01T00:00:02.000Z');
  assert.equal((projected.panel as { activeChildCount: number }).activeChildCount, 4);
  assert.deepEqual((projected as { rail: unknown }).rail, {
    listedSessionCount: 12,
    parsedSessionCount: 3,
    rowCount: 13,
    pinCount: 4,
    archiveCount: 2,
    messageType: 'render',
    messageSerializedBytes: 900,
  });
  assert.equal(JSON.stringify(projected).includes('secret'), false);
  assert.deepEqual(Object.keys(projected).sort(), [
    'cacheBytes',
    'capturedAt',
    'counters',
    'ledger',
    'panel',
    'rail',
    'redaction',
    'schemaVersion',
    'watcher',
  ]);
});

test('an unavailable field is explicit without dropping the rest of the snapshot', () => {
  const counters = new PanelPerformanceCounters(1_000);
  const input = state(counters.snapshot());
  input.rail.listedSessionCount = { unavailable: 'No catalog has been built.' };

  const projected = projectPerformanceDiagnostics(input, 2_000) as {
    rail: { listedSessionCount: unknown; pinCount: number };
  };

  assert.deepEqual(projected.rail.listedSessionCount, { unavailable: 'No catalog has been built.' });
  assert.equal(projected.rail.pinCount, 4);
});

test('capturing changes only the capture counter', () => {
  const counters = new PanelPerformanceCounters(1_000, 'window-a');
  counters.recordRefresh('poll', 3);
  counters.recordMessage('rail', 20);
  const before = counters.snapshot();

  counters.recordCapture();

  const after = counters.snapshot();
  assert.equal(after.captureCount, before.captureCount + 1);
  assert.deepEqual(after.refreshes, before.refreshes);
  assert.deepEqual(after.messages, before.messages);
  assert.deepEqual(after.panelPosts, before.panelPosts);
  assert.deepEqual(after.panelMessages, before.panelMessages);
  assert.deepEqual(after.panelReplies, before.panelReplies);
  assert.equal(after.watcherOperationCount, before.watcherOperationCount);
  assert.equal(after.ledgerSaveCount, before.ledgerSaveCount);
});

test('serialized message bytes use UTF-8 and unavailable values stay explicit in counters', () => {
  assert.equal(serializedMessageBytes({ type: 'x', text: 'é' }), Buffer.byteLength('{"type":"x","text":"é"}', 'utf8'));
  const circular: { self?: unknown } = {};
  circular.self = circular;
  assert.equal(serializedMessageBytes(circular), null);
});

test('render and rail messages have explicit production byte budgets', () => {
  assert.equal(messageByteBudget('render'), 250_000);
  assert.equal(messageByteBudget('rail'), 1_100_000);
  assert.equal(messageByteBudget('usage'), null);
});

// Startup, refresh, message, and watcher events carry their measured values.

test('every counted operation reaches the sink once, with what it cost', () => {
  const events: [string, Record<string, unknown>][] = [];
  const counters = new PanelPerformanceCounters(1_000, {
    enabled: () => true,
    emit: (event, record) => {
      events.push([event, record]);
    },
  });
  counters.recordStartup('firstCard', 89_000.4);
  counters.recordStartup('firstCard', 95_000);
  counters.recordRefresh('watcher', 12.6);
  counters.recordMessage('render', 300_000);
  counters.recordWatcherOperation({
    reason: 'watcher',
    eventCount: 2,
    distinctPathCount: 1,
    waitMs: 5,
    maximumWaitFired: false,
    decision: 'targeted',
    durationMs: 7.4,
  });
  counters.recordRefreshStage('rendered');
  counters.recordCapture();

  assert.deepEqual(
    events.map(([event]) => event),
    ['startup', 'refresh', 'message', 'watcher'],
    'a counted operation reaches the log twice, or an operation a reader needs reaches it never',
  );
  assert.deepEqual(events[0][1], { milestone: 'firstCard', elapsedMs: 89_000 });
  assert.deepEqual(events[1][1], { reason: 'watcher', durationMs: 13 });
  assert.deepEqual(events[2][1], { kind: 'render', bytes: 300_000 });
  assert.equal(events[3][1].id, 1);
  assert.equal(events[3][1].durationMs, 7);
  assert.equal(
    new PanelPerformanceCounters(1_000).snapshot().startedAt,
    '1970-01-01T00:00:01.000Z',
    'a host that hands over no sink cannot count at all',
  );
});

// A disabled sink skips message, refresh, and watcher payloads. Startup still emits its payload.

test('a counted operation builds no record while nothing reads the sink', () => {
  const events: string[] = [];
  let asked = 0;
  const counters = new PanelPerformanceCounters(1_000, {
    enabled: () => {
      asked++;
      return false;
    },
    emit: (event) => {
      events.push(event);
    },
  });
  counters.recordMessage('render', 300_000);
  counters.recordRefresh('watcher', 12);
  counters.recordWatcherOperation({
    reason: 'watcher',
    eventCount: 2,
    distinctPathCount: 1,
    waitMs: 5,
    maximumWaitFired: false,
    decision: 'targeted',
    durationMs: 7,
  });

  assert.deepEqual(events, [], 'a counted operation built a record for a sink that reads nothing');
  assert.equal(asked, 3, 'a counted operation reached the sink without asking whether anything reads it');
  assert.equal(counters.snapshot().messages.render.count, 1, 'a silent sink stopped the counters counting');

  // The startup threshold rides on this event and runs whatever the setting says.
  counters.recordStartup('firstCard', 89_000);
  assert.deepEqual(events, ['startup'], 'a slow startup reaches nobody while the log is off');
});

const CAPTURED_AT = Date.UTC(2026, 8, 21, 4, 5, 6, 700);
const ROOT = path.resolve(path.sep === '\\' ? 'C:\\arc-capture' : '/arc-capture');
const SNAPSHOT = { schemaVersion: PERFORMANCE_DIAGNOSTICS_SCHEMA_VERSION, panel: { hostCount: 1 } };

// Capture the save dialog, file writes, failure reports, and destination announcements.

function capture(options: { picks?: string | null; failure?: string } = {}) {
  const written: { file: string; contents: string }[] = [];
  const asked: (string | null)[] = [];
  const reported: PerformanceDiagnosticsFailure[] = [];
  const announced: string[] = [];
  return {
    written,
    asked,
    reported,
    announced,
    ask: (suggested: string | null): Promise<string | null> => {
      asked.push(suggested);
      return Promise.resolve(options.picks ?? null);
    },
    write: (file: string, contents: string): Promise<void> => {
      if (options.failure) {
        return Promise.reject(new Error(options.failure));
      }
      written.push({ file, contents });
      return Promise.resolve();
    },
    report: (failure: PerformanceDiagnosticsFailure): void => {
      reported.push(failure);
    },
    announce: (file: string): void => {
      announced.push(file);
    },
  };
}

test('a capture writes to the path it is given, and asks nobody', async () => {
  const sink = capture();
  const file = path.join(ROOT, 'startup.json');
  const written = await savePerformanceDiagnosticsSnapshot({
    snapshot: SNAPSHOT,
    target: file,
    environment: {},
    workspaceFolder: null,
    capturedAt: CAPTURED_AT,
    ...sink,
  });

  assert.equal(written, file, 'a capture given a path did not answer with the file it wrote');
  assert.deepEqual(sink.asked, [], 'a capture given a path still opened the dialog');
  assert.deepEqual(
    sink.written,
    [{ file, contents: `${JSON.stringify(SNAPSHOT, null, 2)}\n` }],
    'the snapshot did not reach the named file as formatted JSON',
  );

  // Resolve relative destinations against the open folder.

  const relative = await savePerformanceDiagnosticsSnapshot({
    snapshot: SNAPSHOT,
    target: 'out/startup.json',
    environment: {},
    workspaceFolder: ROOT,
    capturedAt: CAPTURED_AT,
    ...capture(),
  });
  assert.equal(
    relative,
    path.join(ROOT, 'out', 'startup.json'),
    'a relative path was not read against the open folder',
  );
  assert.deepEqual(sink.announced, [], 'a capture told the caller where its own named file went');
});

test('a relative destination with no folder open is refused and nothing is written', async () => {
  // A relative destination requires an open folder.

  const sink = capture();
  const refused = await savePerformanceDiagnosticsSnapshot({
    snapshot: SNAPSHOT,
    target: 'out/startup.json',
    environment: {},
    workspaceFolder: null,
    capturedAt: CAPTURED_AT,
    ...sink,
  });

  assert.equal(refused, null, 'a relative path with no folder open answered with a file');
  assert.deepEqual(sink.written, [], 'a relative path with no folder open was written somewhere');
  assert.deepEqual(sink.asked, [], 'a refused path fell through to the dialog');
  assert.equal(sink.reported.length, 1, 'a refused path told the caller nothing, or told it twice');
  assert.equal(sink.reported[0].file, null, 'a refused path named a file that was never a file');
  assert.ok(
    sink.reported[0].message.includes('out/startup.json'),
    'the refusal does not name the path it could not read',
  );
  assert.ok(
    sink.reported[0].reason.includes('out/startup.json'),
    'the reason in the log does not name the path it could not read',
  );

  // The variable names a directory, and it is read the same way.
  const variable = capture();
  const alsoRefused = await savePerformanceDiagnosticsSnapshot({
    snapshot: SNAPSHOT,
    environment: { [PERFORMANCE_DIAGNOSTICS_DIRECTORY_VARIABLE]: 'snapshots' },
    workspaceFolder: null,
    capturedAt: CAPTURED_AT,
    ...variable,
  });
  assert.equal(alsoRefused, null, 'a relative output directory with no folder open answered with a file');
  assert.deepEqual(variable.written, [], 'a relative output directory with no folder open was written somewhere');
  assert.equal(variable.reported.length, 1, 'a refused output directory told the caller nothing');
});

test('a destination the file system refuses answers with no file and carries its reason', async () => {
  // Writing onto an existing directory produces a filesystem error.

  const root = tempDir('arc-capture-');
  const onto = { write: (file: string, contents: string) => fs.writeFile(file, contents, 'utf8') };

  const atDirectory = capture();
  const overDirectory = await savePerformanceDiagnosticsSnapshot({
    snapshot: SNAPSHOT,
    target: root,
    environment: {},
    workspaceFolder: null,
    capturedAt: CAPTURED_AT,
    ...atDirectory,
    ...onto,
  });
  assert.equal(overDirectory, null, 'a capture aimed at a directory answered with a file');
  assert.equal(atDirectory.reported.length, 1, 'a capture aimed at a directory reported nothing');
  assert.equal(atDirectory.reported[0].file, root, 'the failure does not name the directory it was aimed at');
  assert.ok(atDirectory.reported[0].message.includes(root), 'the failure does not name the target it could not write');
  assert.ok(atDirectory.reported[0].reason.length > 0, 'the failure carries nothing the file system said');

  // A neighboring file succeeds with the same writer.

  const beside = path.join(root, 'startup.json');
  const good = capture();
  const wrote = await savePerformanceDiagnosticsSnapshot({
    snapshot: SNAPSHOT,
    target: beside,
    environment: {},
    workspaceFolder: null,
    capturedAt: CAPTURED_AT,
    ...good,
    ...onto,
  });
  assert.equal(wrote, beside, 'a target in a directory that is there was not written');
  assert.deepEqual(good.reported, [], 'a capture that wrote its file still reported a failure');
  assert.equal(
    await fs.readFile(beside, 'utf8'),
    `${JSON.stringify(SNAPSHOT, null, 2)}\n`,
    'the file on disk is not the formatted snapshot',
  );
});

test('the output directory variable captures a stamped file with no argument and no dialog', async () => {
  const sink = capture();
  const directory = path.join(ROOT, 'snapshots');
  const written = await savePerformanceDiagnosticsSnapshot({
    snapshot: SNAPSHOT,
    environment: { [PERFORMANCE_DIAGNOSTICS_DIRECTORY_VARIABLE]: directory },
    workspaceFolder: ROOT,
    capturedAt: CAPTURED_AT,
    ...sink,
  });

  assert.equal(
    written,
    path.join(directory, performanceDiagnosticsFileName(CAPTURED_AT)),
    'the variable did not name the directory the capture was written into',
  );
  assert.deepEqual(sink.asked, [], 'a run with the variable set still waited on the dialog');
  assert.ok(!path.basename(written ?? '').includes(':'), 'the stamped file name carries a character Windows refuses');
  assert.equal(sink.written.length, 1, 'the variable wrote no snapshot, or wrote more than one');
  // A capture selected through the output directory variable announces its destination.

  assert.deepEqual(
    sink.announced,
    [written],
    'a capture aimed by the variable left the reader with no way to find the file',
  );
});

test('a named path beats the output directory variable', async () => {
  const sink = capture();
  const file = path.join(ROOT, 'named.json');
  const written = await savePerformanceDiagnosticsSnapshot({
    snapshot: SNAPSHOT,
    target: file,
    environment: { [PERFORMANCE_DIAGNOSTICS_DIRECTORY_VARIABLE]: path.join(ROOT, 'snapshots') },
    workspaceFolder: ROOT,
    capturedAt: CAPTURED_AT,
    ...sink,
  });

  assert.equal(written, file, 'the variable took the capture away from the path the caller named');
  assert.deepEqual(sink.asked, [], 'the dialog opened with a path and a variable both set');
  assert.deepEqual(sink.announced, [], 'a caller that named the file was told where its file went');
});

test('with no path and no variable the reader picks the file', async () => {
  const picked = path.join(ROOT, 'picked.json');
  const sink = capture({ picks: picked });
  const written = await savePerformanceDiagnosticsSnapshot({
    snapshot: SNAPSHOT,
    environment: {},
    workspaceFolder: ROOT,
    capturedAt: CAPTURED_AT,
    ...sink,
  });

  assert.equal(written, picked, 'the file the reader picked was not the file written');
  assert.deepEqual(
    sink.asked,
    [path.join(ROOT, performanceDiagnosticsFileName(CAPTURED_AT))],
    'the dialog opened on no suggested file, or on the wrong one',
  );
  assert.deepEqual(sink.announced, [], 'the reader who picked the file was told where it went');

  // Dismissing the dialog leaves no snapshot.
  const dismissed = capture({ picks: null });
  const nothing = await savePerformanceDiagnosticsSnapshot({
    snapshot: SNAPSHOT,
    environment: {},
    workspaceFolder: ROOT,
    capturedAt: CAPTURED_AT,
    ...dismissed,
  });
  assert.equal(nothing, null, 'a closed dialog answered with a file');
  assert.deepEqual(dismissed.written, [], 'a closed dialog still wrote a snapshot');
  assert.deepEqual(dismissed.reported, [], 'a closed dialog was reported to the reader as a failure');
});

test('a path that cannot be written is reported, and answers with no file', async () => {
  const sink = capture({ failure: 'EACCES: permission denied' });
  const file = path.join(ROOT, 'locked', 'startup.json');
  const written = await savePerformanceDiagnosticsSnapshot({
    snapshot: SNAPSHOT,
    target: file,
    environment: {},
    workspaceFolder: ROOT,
    capturedAt: CAPTURED_AT,
    ...sink,
  });

  assert.equal(written, null, 'a failed write answered with a file that is not there');
  assert.equal(sink.reported.length, 1, 'a failed write told the reader nothing, or told them twice');
  assert.equal(sink.reported[0].file, file, 'the log record does not name the file it could not write');
  assert.ok(sink.reported[0].message.includes(file), 'the failure does not name the file it could not write');
  assert.equal(
    sink.reported[0].reason,
    'EACCES: permission denied',
    'the log record does not carry what the file system said',
  );
  assert.ok(
    sink.reported[0].message.includes('EACCES: permission denied'),
    'the failure does not carry what the file system said',
  );
});

test('discovery counters sum relationship read charges across worker replies', () => {
  const counters = new PanelPerformanceCounters(1000, 'window-a');
  const charges = {
    readBytes: 5,
    receiptEntries: 3,
    receiptChecks: 4,
    receiptBytes: 5,
    hits: 3,
    resets: 0,
    quanta: 0,
    dispatchRetries: 0,
    parentChecks: 6,
    parentCheckMs: 1.5,
    childHeadFiles: 1,
    childHeadBytes: 4096,
    childHeadMs: 2,
    dispatchSpendVisits: 1,
    dispatchSpendRereads: 1,
    dispatchSpendFiles: 2,
    dispatchSpendBytes: 90000,
    dispatchSpendMs: 7,
    dispatchSpendAggregateStarts: 1,
    dispatchSpendAggregateCompletions: 2,
    dispatchSpendRelationshipInvalidations: 3,
    dispatchSpendConsumedSourceInvalidations: 4,
    dispatchSpendSourceRestarts: 5,
    dispatchSpendParserAdvancements: 6,
    dispatchSpendRootWaits: 7,
  };
  counters.recordDiscovery(charges, { complete: false, continuation: true });
  counters.recordDiscovery(charges, { complete: true, continuation: false });
  assert.deepEqual(counters.snapshot().discovery, {
    readBytes: 10,
    receiptEntries: 6,
    receiptChecks: 8,
    receiptBytes: 10,
    hits: 6,
    resets: 0,
    quanta: 0,
    dispatchRetries: 0,
    parentChecks: 12,
    parentCheckMs: 3,
    childHeadFiles: 2,
    childHeadBytes: 8192,
    childHeadMs: 4,
    dispatchSpendVisits: 2,
    dispatchSpendRereads: 2,
    dispatchSpendFiles: 4,
    dispatchSpendBytes: 180000,
    dispatchSpendMs: 14,
    dispatchSpendAggregateStarts: 2,
    dispatchSpendAggregateCompletions: 4,
    dispatchSpendRelationshipInvalidations: 6,
    dispatchSpendConsumedSourceInvalidations: 8,
    dispatchSpendSourceRestarts: 10,
    dispatchSpendParserAdvancements: 12,
    dispatchSpendRootWaits: 14,
    continuations: 1,
    publications: 1,
  });
});

test('read measurements isolate concurrent exports and report content-free phase totals', async () => {
  const reports: ReadMetrics[] = [];
  let release!: () => void;
  const resumed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = withReadMetrics(
    async () => {
      readPhase('relationships');
      meterRead('/private/first', 10, 0);
      await resumed;
      meterRead('/private/first', 10, 5);
      meterRead('/private/first', 4);
      meterReadWork('cursorCopies');
    },
    (metrics) => reports.push(metrics),
  );
  await withReadMetrics(
    async () => {
      readPhase('numbers');
      meterRead('/private/second', 30, 0);
      meterReadWork('sourceChangeRetries');
    },
    (metrics) => reports.push(metrics),
  );
  release();
  await first;
  assert.equal(reports[0].numbers.bytes, 30);
  assert.equal(reports[0].numbers.sourceChangeRetries, 1);
  assert.equal(reports[0].relationships, undefined);
  assert.equal(reports[1].relationships.bytes, 24);
  assert.equal(reports[1].relationships.repeatedBytes, 5);
  assert.equal(reports[1].relationships.cursorCopies, 1);
  assert.equal(reports[1].numbers, undefined);
  assert.ok(!JSON.stringify(reports).includes('/private/'));
});
