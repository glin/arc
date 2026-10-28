import { startingWorktree } from './repositoryscope';
import * as spendConsumers from './projectspend';
import * as cardConsumers from './turncard';
import { normalizePromptAssetBook } from './promptassets';
import {
  GuardedSends,
  SessionWriteRequests,
  agentMessageBinding,
  guardedRefusal,
  guardedPromptRefusal,
  requesterOf,
  payloadSha256,
} from './sessionwrites';
import { GuardedAttempt } from './agentwire';
import {
  queueSubmissionAfter,
  commentsForQueuedSubmission,
  queueCanDrain,
  queueEdit,
  queuedSubmission,
  sentPromptsToSave,
} from './composerview';
import {
  normalizeQueuedSubmissions,
  queuedSubmissionBookFits,
  normalizeDrafts,
  normalizeDraftCommentIds,
} from './turnview';
// @module-tag subprocess
import { sessionStatsFromFacts } from './turncard';
import { runningKey, sessionRunning, type LivePress } from './composerview';
import { compatibleDiscovery, discoveryCompatibility } from './progressiveworker';
import { claudeDispatchTranscript } from './turnfixtures';
import { sessionCoverageMember, sessionPresence, reconcileSessionCollisions } from './sessioncoverage';
import { sessionSourceKey, sessionPageSources, guardedSourceRevision } from './sessionreads';
import { afterAll, afterEach, beforeAll, test, vi } from 'vitest';
import { pendingResponseSessionAdmitted, resolveResponseSession } from './domain/session-link';
import { createPanelVisibility } from './panelvisibility';
import { outcomesFor } from './timelinestate';
import { claudeRelationshipKey, selectedDependencies } from './selectedsource';
import {
  projectSlug,
  isInside,
  supportedFileIdentity,
  replacedCatalogFiles,
  ClaudeChildSessionCache,
  enumerateClaudeChildSources,
  revisionOf as fileRevisionOf,
  revalidatedCatalogPaths,
  revalidatedCatalog,
  watchDirs,
  humanPromptScanSteps,
  promptScanLists,
} from './transcript';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import mutableFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import ts from 'typescript';
import { agentSpendIsOpen, spendFileVersion, spendTokens } from './agentspend';
import {
  CodexMetaCache,
  createCodexUsageLineReducer,
  CodexStatCache,
  codexSessionFiles,
  readRolloutStat,
  readCodexSessionTitlePair,
  coldOpeningPass,
  enumerateRolloutFilesAsync,
  codexSubagentFor,
  codexTitleFor,
  codexAgentSpendVersion,
  codexSpendIndex,
} from './codex';
import { CodexOpeningsWriter, loadCodexOpenings } from './codexopenings';
import { tempDir } from './temproot.ts';
import { claudeBackgroundHint, claudeBackgroundTranscript } from './agenthost';
import { buildSync, transformSync } from 'esbuild';
import { messageByteBudget, PanelPerformanceCounters, serializedMessageBytes } from './performancediagnostics';
import { SessionLoadingLine } from './sessionloadingline';
import {
  HostReadPersistence,
  ReadPersistenceUnknownError,
  ReadPublicationError,
  preserveHostRead,
  projectAgentRead,
} from './domain/read.ts';
import { sessionCatalogMembership, sessionDiscoveryMembership } from './sessionreads.ts';
import { REPOSITORY_SCOPE_CONFIRM_MS, REPOSITORY_SCOPE_REFRESH_MS, RepositoryScope } from './repositoryscope';
import {
  CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
  agentRunScanUnread,
  carryDerivedTitleFacts,
  derivedTitleCacheRevision,
  derivedTitleCacheStats,
  derivedTitleStats,
  loadDerivedCache,
  onlyGrew,
  railEnrichmentNeeds,
  METADATA_EXHAUSTED_RULE,
  saveDerivedCache,
  scanForRailEnrichment,
  SessionFactFigures,
  DerivedCacheCheckpointState,
  VERSION,
  withAgentRunScanProgress,
  withRailEnrichment,
  withMetadataCoverage,
  withSessionName,
} from './derivedcache';
import {
  aggregateUsageEvents,
  type UsageEvent,
  projectSpendDisplayFiles,
  prepareProjectSpendViewSteps,
  truncateProjectSpendView,
  projectSpendWindows,
  publicProjectSpendPrice,
  projectSpendHistoryCutoff,
  projectSpendOfferDecision,
  projectSpendSourceOfferDue,
  PROJECT_SPEND_PARSER_GENERATION,
  PROJECT_SPEND_SAVE_MAX_MS,
  PROJECT_SPEND_SAVE_MS,
  PROJECT_SPEND_SAVE_RETRIES,
  projectSpendSaveRetryDelay,
  SessionFiguresCache,
  SpendCoverage,
  spendRecordAgent,
  spendSourceHeld,
  pruneSpendFilesWithResult,
  sessionLifetimeDisplayFiles,
  spendRecordChangesRail,
  spendRecordHoldsLongLine,
  releaseSpendHeldLine,
  invalidateClaudeCostSupplements,
  claudeCostStateDependencies,
  discoverClaudeSessionSpendSources,
  loadSpendLedger,
  saveSpendLedger,
  type SpendFileIndex,
  SessionSpendSourceIndex,
  indexSpendFile,
  normalizeSpendFile,
  sessionSpendPartsBySession,
} from './projectspend';
import {
  messageFieldBytes,
  railInputKey,
  railMessage,
  railPayload,
  railWordingDay,
  sameRailInputs,
  selectionPayload,
} from './payload';
import { RowDeltaReceiver, RowDeltaSender } from './webview/row-deltas.ts';
import {
  acceptsProgressiveResult,
  CommitRepositoryReservations,
  commitRepositorySourceKey,
  INITIAL_RAIL_READ_BYTES,
  metadataReadBudget,
  preservesLoadedHistory,
  ProgressiveWorker,
  RAIL_ENRICHMENT_READ_BYTES,
  sameProgressiveRevision,
  unreadHeadBytes,
  type ProgressiveCheckpoint,
  type ProgressiveInput,
  type ProgressiveRequest,
  type ProgressiveResult,
} from './progressiveworker';
import { SessionNames, sessionLabelOf, storedSessionName, transcriptIdentity } from './sessionnames';
import {
  listingSignature,
  spendSourceSignature,
  newestTurnLoading,
  normalizePanelState,
  remapReaderParents,
  orderSessionCatalog,
  refreshWanted,
  turnBudget,
} from './turnview';
import {
  groupBySession,
  railCachesOf,
  sessionParentEdgeSet,
  sessionParentIndex,
  sessionParentOf,
  unsentBySession,
  writeTimeOfVersion,
} from './turnrail';
import { recordedCostBasis } from './pricing';
import { isTurnRead, readMovedOnlyFor, turnKey } from './domain/read.ts';
import { commitRowsOf } from './turncard';
import {
  agentSpendDependencyKey,
  childSpendVersion,
  claudeChildFileFor,
  claudeSubagentMetaReader,
  normalizeFsPath,
  createClaudeUsageLineReducer,
  readClaudeAgentSpend,
  refreshClaudeAgentFacts,
  sameSessionRevision,
  revisionOf,
  relationshipStamp,
  HEAD_KEY_BYTES,
  SESSION_HEAD_BYTES,
  type SessionFile,
  type SessionStatFacts,
  enumerateSessionFiles,
} from './transcript';
import { currentRecordsBySession, transcriptReadCacheKey } from './turnread';
import {
  afterHistoryPage,
  afterHistoryRequest,
  historyBytes,
  historyEvictions,
  historyPageReads,
  historyRequestContinues,
  historyRecordsOutside,
  historyStateAfterRevision,
  retainDisplacedWindow,
  staleCursorIsStuck,
  startSessionHistory,
} from './historypages';
import {
  adoptSessionIdentity,
  agentPromptToSend,
  commentsForActiveSubmission,
  clearSubmission,
  compactSubmission,
  livePressOver,
  pressIsMidTurn,
  pressesAfter,
  pressesAfterHandoff,
  pressesAfterSessionHandoff,
  queueAfterAcceptedRecovery,
  selectedWindowContainsRecordedTurn,
  sentAfter,
  rememberSessionAlias,
  sessionAdoptions,
  pressOfKind,
  runningSessions,
} from './composerview';
import { countedDispatchedCosts, pendingAskPosition, toCard, TURN_QUIET_MS } from './turncard';
import { COMMIT_REPOSITORY_PARSER_VERSION, commitRepositoryOccurrence } from './codexhistory';
import { RepositoryCommits } from './gitcommits';
import { CommitRepositories } from './commitrepositories';
import { railCacheMarkOf, sessionStatusOf, stableRailOrder } from './turnrail';
import { storedAssetsForPrompt } from './promptassets';
import { emptyTrail, renamePlace, visitPlace } from './turnplaces';
import { adoptLabelSession, labelsOf } from './turnlabels';
import { isSearch, searchScope, searchScopeName, searchTurns } from './turnsearch.ts';
import { dispatchPanelToHost, parsePanelToHost } from './webview/protocol.ts';
import {
  BoundedTrailingScheduler,
  IntegrityScheduler,
  CATALOG_REFRESH_DEADLINE_MS,
  mergeRefreshRequests,
  PendingWatcherWake,
  PollDirectoryGate,
  POLL_BACKSTOP_WALK_MS,
  childEventNamesFiles,
  listedFilesFor,
  sessionDirectoryOwners,
  unknownPathExtension,
  unknownPathShapes,
  watcherRefreshDecision,
} from './scheduler';
import { compaction, turn, subagent, claudeCostState } from './turnfixtures';
import {
  selectionCoverage,
  selectionFinished,
  pendingOverlap,
  instrumentSelection,
  SESSION_BUTTON,
  TRACE_SOURCE,
  type SelectionEvent,
} from '../scripts/panel-startup-measure/selection';
import type { ClaudeUsageReducerState } from './transcript';
import { costStateDependency, costStateIdentity, reconcileClaudeCostState } from './claudecoststate';
import { renderRichMarkdown } from './richtext';
import { measurementBuildPath, removeMeasurementTree } from '../scripts/panel-startup-measure/cleanup';
import {
  frozenPath,
  frozenFixturePaths,
  inputHashes,
  sanitizeMeasurementState,
  seedMeasurementStore,
  protectBaseline,
  measuredInstance,
  linesOf,
  outcomeOf,
  instrumentStartup,
  pollStartup,
} from '../scripts/panel-startup-measure/measure';

test('selection measurements reject missing stages, unrelated worker replies, and reversed browser clocks', () => {
  const stages = [
    'click',
    'host-receive',
    'worker-send',
    'worker-start',
    'worker-post',
    'worker-end',
    'worker-receive',
    'browser-receive',
    'draw',
    'frame',
  ];
  const events: SelectionEvent[] = stages.map((stage, time) => ({
    stage,
    time,
    origin: 100,
    clock: 'same',
    click: 'owned',
    payload: { id: 1, generation: 2, status: 'completed' },
  }));
  assert.equal(selectionCoverage(events, 'owned').complete, true);
  for (const stage of stages)
    assert.equal(
      selectionCoverage(
        events.filter((event) => event.stage !== stage),
        'owned',
      ).complete,
      false,
    );
  assert.equal(selectionCoverage(events, 'other').complete, false);
  for (const stage of ['worker-send', 'worker-start', 'worker-end', 'worker-post', 'worker-receive']) {
    assert.equal(
      selectionCoverage(
        [...events, { ...events[3], stage, payload: { id: 2, generation: 2, status: 'completed' } }],
        'owned',
      ).complete,
      false,
    );
  }
  for (const change of [{ clock: 'another' }, { origin: 200 }])
    assert.equal(
      selectionCoverage(
        events.map((event) => (event.stage === 'frame' ? { ...event, ...change } : event)),
        'owned',
      ).complete,
      false,
    );
  const cancelled = events.filter((event) => !['worker-post', 'worker-receive', 'worker-end'].includes(event.stage));
  cancelled.push({ ...events[2], stage: 'abort', time: 6, payload: { id: 1, generation: 2, status: 'cancelled' } });
  assert.equal(selectionCoverage(cancelled, 'owned').complete, true);
  assert.equal(
    selectionCoverage(
      cancelled.filter((event) => event.stage !== 'abort'),
      'owned',
    ).complete,
    false,
  );
  assert.equal(
    selectionCoverage(
      events.map((event) => (event.stage === 'worker-end' ? { ...event, payload: { id: 3, generation: 2 } } : event)),
      'owned',
    ).complete,
    false,
  );
  assert.equal(
    selectionCoverage(
      events.map((event) => (event.stage === 'frame' ? { ...event, time: 0 } : event)),
      'owned',
    ).complete,
    false,
  );
  assert.equal(
    selectionCoverage(
      events.map((event) => (event.stage === 'draw' ? { ...event, time: NaN } : event)),
      'owned',
    ).complete,
    false,
  );
});

test('selection measurements wait through loading and finish only the completed content frame', () => {
  const event = (stage: string, time: number, complete: boolean, draw: number): SelectionEvent => ({
    stage,
    time,
    origin: 100,
    clock: 'browser',
    click: 'B',
    payload: { session: 'B', generation: 2, complete, draw },
  });
  const events = [event('selection-accepted', 1, false, 1), event('draw', 2, false, 1), event('frame', 3, false, 1)];
  assert.equal(selectionFinished(events, 'B', 'B'), false);
  events.push(event('selection-accepted', 4, true, 2), event('draw', 5, true, 2));
  assert.equal(selectionFinished(events, 'B', 'B'), false);
  events.push(event('frame', 6, true, 2));
  assert.equal(selectionFinished(events, 'B', 'B'), true);
  assert.equal(selectionFinished(events, 'B', 'A'), false);
  assert.equal(
    selectionFinished(
      events.map((row) => (row.time === 6 ? { ...row, origin: 200 } : row)),
      'B',
      'B',
    ),
    false,
  );
});

test('selection measurement overlays use the real session button and leave untagged traffic unowned', () => {
  const tree = tempDir('selection-overlay');
  for (const name of ['panelhost.ts', 'progressiveworker.ts', 'progressiveworker-entry.ts', 'webview/panel.ts']) {
    const target = path.join(tree, 'extension', 'src', name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(__dirname, name), target);
  }
  instrumentSelection(tree);
  const rail = fs.readFileSync(path.join(__dirname, 'webview/rail.ts'), 'utf8');
  assert.match(rail, /['"]railcard['"]/);
  assert.equal(SESSION_BUTTON, 'button.railcard[data-session]');
  const panel = fs.readFileSync(path.join(tree, 'extension/src/webview/panel.ts'), 'utf8');
  const source = panel.slice(panel.indexOf('const trace ='), panel.indexOf('  let drawSerial'));
  const record = new Function(
    'window',
    'performance',
    transformSync(
      source +
        "trace('browser-receive', {type:'selection'}, 'tagged'); trace('browser-receive', {type:'rail'}, undefined); trace('browser-post', {type:'painted'}, undefined); return window.__arcEvents;",
      { loader: 'ts' },
    ).code,
  );
  const events = record({ __arcPayload: 'tagged' }, { now: () => 1, timeOrigin: 100 });
  assert.deepEqual(
    events.map((event: SelectionEvent) => event.click),
    ['tagged', undefined, undefined],
  );
});

test('selection measurement file traces retain descriptor ownership and available byte counts', () => {
  const tree = tempDir('selection-files');
  fs.writeFileSync(path.join(tree, 'trace.mjs'), TRACE_SOURCE);
  fs.writeFileSync(path.join(tree, 'first.txt'), 'é');
  fs.writeFileSync(path.join(tree, 'second.txt'), 'abc');
  const script = `import fs from 'node:fs'; import './trace.mjs';
    const first=fs.openSync('first.txt','r'); fs.readSync(first,Buffer.alloc(10),0,10,0); fs.closeSync(first);
    const second=fs.openSync('second.txt','r'); fs.readSync(second,Buffer.alloc(10),0,10,0); fs.closeSync(second);
    fs.readFileSync('first.txt','utf8'); fs.readFileSync('first.txt','latin1'); fs.readFileSync('second.txt');
    try { fs.readSync(second,Buffer.alloc(10),0,10,0); } catch {}`;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: tree,
    env: { ...process.env, ARC_MEASURE_TRACE: path.join(tree, 'selection-trace') },
  });
  const file = fs.readdirSync(tree).find((name) => name.endsWith('.jsonl'))!;
  const events = fs
    .readFileSync(path.join(tree, file), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const reads = events.filter((event) => event.payload?.operation === 'readSync').map((event) => event.payload);
  assert.deepEqual(
    [reads[0], reads[1], reads.at(-1)].map(({ target, bytes }: { target: string; bytes: number }) => [target, bytes]),
    [
      ['first.txt', 2],
      ['second.txt', 3],
      [null, null],
    ],
  );
  assert.deepEqual(
    events
      .filter((event) => event.payload?.operation === 'readFileSync')
      .map((event) => [event.payload.target, event.payload.bytes]),
    [
      ['first.txt', 2],
      ['first.txt', 2],
      ['second.txt', 3],
    ],
  );
});

test('selection measurements reject B completion between pending observation and browser click', () => {
  const event = (stage: string, time: number, clock: string, click: string, payload: unknown): SelectionEvent => ({
    stage,
    time,
    clock,
    click,
    payload,
    origin: 100,
  });
  const request = { id: 1, generation: 2, request: { kind: 'window', input: { session: { sessionId: 'B' } } } };
  const events = [
    event('worker-send', 10, 'host', 'B', request),
    event('worker-start', 10, 'worker', 'B', request),
    event('worker-post', 30, 'worker', 'B', request),
    event('worker-end', 30, 'worker', 'B', { ...request, status: 'completed' }),
    event('worker-receive', 30, 'host', 'B', request),
    event('clock-send', 0, 'browser', 'align', {}),
    event('clock-receive', 0, 'host', 'align', {}),
    event('browser-receive', 0, 'browser', 'align', {}),
    event('pending-observation', 20, 'driver', 'B', {}),
    event('click', 40, 'browser', 'A', {}),
  ];
  assert.deepEqual(pendingOverlap(events, 'B', 'A', 'B'), { available: false, reason: 'B completed before click' });
  assert.equal(
    pendingOverlap(
      events.map((row) => (row.stage === 'click' ? { ...row, time: 20 } : row)),
      'B',
      'A',
      'B',
    ).available,
    true,
  );
  assert.equal(
    pendingOverlap(
      events.filter((row) => row.stage !== 'worker-end'),
      'B',
      'A',
      'B',
    ).available,
    false,
  );
  assert.equal(
    pendingOverlap(
      events.map((row) => (row.stage === 'clock-receive' ? { ...row, origin: 200 } : row)),
      'B',
      'A',
      'B',
    ).available,
    false,
  );
  assert.equal(
    pendingOverlap(
      events.map((row) => (row.stage === 'click' ? { ...row, time: NaN } : row)),
      'B',
      'A',
      'B',
    ).available,
    false,
  );
  assert.equal(
    pendingOverlap(
      events
        .map((row) => (row.stage === 'browser-receive' ? { ...row, time: 10 } : row))
        .map((row) => (row.stage === 'click' ? { ...row, time: 35 } : row)),
      'B',
      'A',
      'B',
    ).available,
    false,
  );
});

test('isolated startup rejects live roots beneath an ancestor fixture manifest', () => {
  const root = tempDir('startup-ancestor');
  const inputs = { workspace: 'workspace', projects: 'projects', codex: 'codex', store: 'store', state: 'state.json' };
  for (const name of ['workspace', 'projects', 'codex', 'store']) fs.mkdirSync(path.join(root, name));
  fs.writeFileSync(path.join(root, 'state.json'), '{}');
  for (const live of ['projects', 'codex', 'store'])
    assert.throws(() => frozenFixturePaths(root, inputs, [path.join(root, live)]), /live data directory/);
  assert.throws(() => frozenFixturePaths(root, inputs, [path.dirname(root)]), /live data directory/);
  assert.equal(
    frozenFixturePaths(root, inputs, [tempDir('startup-unrelated')]).workspace,
    path.join(root, 'workspace'),
  );
});

test('isolated startup hashes only validated inputs despite sibling links and cycles', () => {
  const root = tempDir('startup-hashes');
  const external = tempDir('startup-external');
  const raw = { workspace: 'workspace', projects: 'projects', codex: 'codex', store: 'store', state: 'state.json' };
  for (const name of ['workspace', 'projects', 'codex', 'store']) fs.mkdirSync(path.join(root, name));
  fs.writeFileSync(path.join(root, 'projects', 'source.jsonl'), '{}');
  fs.writeFileSync(path.join(root, 'state.json'), '{}');
  const manifest = path.join(root, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify(raw));
  fs.writeFileSync(path.join(external, 'outside.jsonl'), 'external');
  const links = [path.join(root, 'a-sibling'), path.join(root, 'z-cycle')];
  fs.symlinkSync(external, links[0], process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const inputs = frozenFixturePaths(root, raw, [external]);
    const hashes = inputHashes(root, [manifest, ...Object.values(inputs)]);
    assert.deepEqual(
      Object.keys(hashes).sort(),
      ['manifest.json', path.join('projects', 'source.jsonl'), 'state.json'].sort(),
    );
    fs.symlinkSync(root, links[1], process.platform === 'win32' ? 'junction' : 'dir');
    assert.deepEqual(inputHashes(root, [manifest, ...Object.values(inputs)]), hashes);
  } finally {
    for (const link of links) {
      if (!fs.existsSync(link)) continue;
      if (process.platform === 'win32') fs.rmdirSync(link);
      else fs.unlinkSync(link);
    }
  }
  assert.equal(fs.readFileSync(path.join(external, 'outside.jsonl'), 'utf8'), 'external');
});

test('isolated startup cannot complete from copied historical diagnostics', () => {
  const source = tempDir('startup-store');
  const target = path.join(tempDir('startup-copy'), 'store');
  for (const directory of ['cache', 'logs', 'startup']) fs.mkdirSync(path.join(source, directory));
  const historic = ['shellReady', 'catalogReady', 'railReady', 'firstCard', 'completeRender'].map((milestone) => ({
    event: 'startup',
    milestone,
    instance: 'historic',
    measurementRun: 'previous',
  }));
  fs.writeFileSync(
    path.join(source, 'logs', 'historic.jsonl'),
    historic.map((line) => JSON.stringify(line)).join('\n'),
  );
  fs.writeFileSync(path.join(source, 'startup', 'historic.jsonl'), '{}');
  fs.writeFileSync(path.join(source, 'cache', 'retained.json'), '{}');
  seedMeasurementStore(source, target);
  assert.equal(fs.existsSync(path.join(target, 'logs')), false);
  assert.equal(fs.existsSync(path.join(target, 'startup')), false);
  assert.equal(fs.readFileSync(path.join(target, 'cache', 'retained.json'), 'utf8'), '{}');
  const current = { event: 'startup', milestone: 'shellReady', instance: 'current', measurementRun: 'owned' };
  const lines = [...historic, current];
  const instance = measuredInstance(lines, 'owned');
  assert.equal(instance, 'current');
  const selected = linesOf(lines, instance, 'owned');
  assert.deepEqual(selected, [current]);
  assert.equal(outcomeOf(selected, instance, null).complete, false);
  assert.deepEqual(linesOf(historic, null, 'owned'), []);
});

test('isolated startup remains incomplete after selected content until background session-list completion', () => {
  const lines = ['shellReady', 'catalogReady', 'railReady', 'firstCard'].map((milestone) => ({
    event: 'startup',
    milestone,
    instance: 'current',
    measurementRun: 'owned',
  }));
  const early = outcomeOf(lines, 'current', null);
  assert.equal(early.complete, false);
  assert.match(early.note!, /completeRender/);
  assert.equal(outcomeOf([...lines, { ...lines[0], milestone: 'completeRender' }], 'current', null).complete, true);
  assert.equal(
    outcomeOf(
      lines.filter((line) => line.milestone !== 'firstCard').concat({ ...lines[0], milestone: 'completeRender' }),
      'current',
      null,
    ).complete,
    false,
  );
});

test('isolated startup requires visible rows and the frozen selected newest turn', () => {
  const milestones = ['shellReady', 'catalogReady', 'railReady', 'firstCard', 'completeRender'].map((milestone) => ({
    event: 'startup',
    milestone,
  }));
  const selection = { session: 'selected', key: 'selected:2', prompt: 'Newest prompt', summary: 'Newest response' };
  const row = { event: 'measurementPaint', stage: 'railReady', accepted: true, usableRows: true };
  const card = {
    event: 'measurementPaint',
    stage: 'firstCard',
    accepted: true,
    observation: {
      ...selection,
      key: 'selected:2',
      responseRegion: 'response' as const,
      renderedResponse: 'Newest response',
      visibleResponse: 'Newest response',
      expectedRenderedResponse: 'Newest response',
    },
  };
  const complete = [...milestones, row, card];
  assert.equal(outcomeOf(complete, 'current', null, selection).complete, true);
  for (const observation of [
    { ...card.observation, session: 'other' },
    { ...card.observation, prompt: 'Older prompt' },
    { ...card.observation, summary: 'Older response' },
    { ...card.observation, renderedResponse: '' },
    { ...card.observation, visibleResponse: '' },
    { ...card.observation, renderedResponse: 'Older response' },
    { ...card.observation, responseRegion: undefined },
    { ...card.observation, key: '' },
    { ...card.observation, key: 'selected:1' },
  ])
    assert.equal(outcomeOf([...milestones, row, { ...card, observation }], 'current', null, selection).complete, false);
  assert.equal(
    outcomeOf([...milestones, row, { ...card, accepted: false }], 'current', null, selection).complete,
    false,
  );
  assert.equal(
    outcomeOf([...milestones, { ...row, usableRows: false }, card], 'current', null, selection).complete,
    false,
  );
  assert.equal(outcomeOf(complete, 'current', null, { session: 'selected' }).complete, false);
  const formatted = {
    ...selection,
    summary: '**Newest** response with [details](https://example.com).\n\nSecond paragraph.',
  };
  for (const responseRegion of ['response', 'headline'] as const) {
    const renderedResponse =
      responseRegion === 'response'
        ? 'Newest response with details. Second paragraph.'
        : 'Newest response with details.';
    const observation = {
      ...formatted,
      responseRegion,
      renderedResponse,
      visibleResponse: renderedResponse,
      expectedRenderedResponse: renderedResponse,
    };
    assert.equal(outcomeOf([...milestones, row, { ...card, observation }], 'current', null, formatted).complete, true);
    assert.equal(
      outcomeOf(
        [...milestones, row, { ...card, observation: { ...observation, key: 'selected:1' } }],
        'current',
        null,
        formatted,
      ).complete,
      false,
    );
  }
});

test('isolated startup rejects late completion and caps its final poll at the deadline', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  try {
    const milestones = ['shellReady', 'catalogReady', 'railReady', 'firstCard', 'completeRender'].map((milestone) => ({
      event: 'startup',
      milestone,
      instance: 'current',
      measurementRun: 'owned',
      at: new Date(10_100).toISOString(),
    }));
    assert.equal(outcomeOf(milestones, 'current', null, null, 10_200).complete, true);
    assert.equal(
      outcomeOf(
        milestones.map((line) =>
          line.milestone === 'completeRender' ? { ...line, at: new Date(10_201).toISOString() } : line,
        ),
        'current',
        null,
        null,
        10_200,
      ).complete,
      false,
    );
    const read = vi.fn<() => typeof milestones>(() => (Date.now() >= 10_250 ? milestones : []));
    const pending = pollStartup(read, { failure: null }, 250, 'owned', null);
    await vi.advanceTimersByTimeAsync(250);
    const outcome = await pending;
    assert.equal(outcome.complete, false);
    assert.match(outcome.note!, /incomplete after/);
    assert.equal(Date.now(), 10_250);
    assert.equal(read.mock.calls.length, 2);
    vi.setSystemTime(10_000);
    const early = pollStartup(() => milestones, { failure: null }, 250, 'owned', null);
    assert.equal((await early).complete, true);
  } finally {
    vi.useRealTimers();
  }
});

test('isolated startup propagates cleanup refusal without retrying', () => {
  const source = ts.createSourceFile(
    'measure.ts',
    fs.readFileSync(path.join(__dirname, '../scripts/panel-startup-measure/measure.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const functions = ['removeTree'].map((name) =>
    source.statements
      .find(
        (statement): statement is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(statement) && statement.name?.text === name,
      )!
      .getText(source),
  );
  let calls = 0;
  const deps = {
    removeMeasurementTree: (repository: string, scratch: string, tree: string) => {
      calls++;
      assert.equal(repository, 'owned-repository');
      assert.equal(scratch, 'owned-scratch');
      assert.equal(tree, 'owned-build');
      throw new Error('Cleanup refused.');
    },
    SCRATCH: 'owned-scratch',
    BUILD_TREE: 'owned-build',
    REPOSITORY: 'owned-repository',
  };
  const code = transformSync(`const {${Object.keys(deps).join(',')}} = deps; ${functions.join('\n')} removeTree();`, {
    loader: 'ts',
  }).code;
  assert.throws(() => new Function('deps', code)(deps), /Cleanup refused/);
  assert.equal(calls, 1);
});

test('isolated startup admits lowercase Windows retained paths while preserving platform boundaries and link rejection', () => {
  const root = tempDir('startup-retained-case');
  fs.mkdirSync(path.join(root, 'codex'));
  const file = path.join(root, 'codex', 'rollout-codex.jsonl');
  fs.writeFileSync(file, '{}');
  const retainedPath = frozenPath(root, normalizeFsPath(file));
  assert.equal(normalizeFsPath(retainedPath), normalizeFsPath(file));
  assert.equal(fs.readFileSync(retainedPath, 'utf8'), '{}');
  const runner = ts.createSourceFile(
    'measure.ts',
    fs.readFileSync(path.join(__dirname, '../scripts/panel-startup-measure/measure.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const transcript = ts.createSourceFile(
    'transcript.ts',
    fs.readFileSync(path.join(__dirname, 'transcript.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const extract = (source: ts.SourceFile, name: string) =>
    transformSync(
      source.statements
        .find(
          (statement): statement is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(statement) && statement.name?.text === name,
        )!
        .getText(source)
        .replace(/^export /, ''),
      { loader: 'ts' },
    ).code;
  for (const platform of ['win32', 'darwin', 'linux']) {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const fixtureRoot = platform === 'win32' ? 'C:\\Frozen\\Inputs' : '/Frozen/Inputs';
    const fixtureFile = paths.join(fixtureRoot, 'codex', 'source.jsonl');
    let linked = false;
    const fakeFs = {
      realpathSync: (input: string) =>
        platform === 'win32' && input.toLowerCase() === fixtureFile.toLowerCase() ? fixtureFile : input,
      lstatSync: (input: string) => ({
        isSymbolicLink: () => linked && paths.basename(input) === 'codex',
        isDirectory: () => false,
      }),
    };
    const normalize = new Function('process', `${extract(transcript, 'normalizeFsPath')} return normalizeFsPath;`)({
      platform,
    });
    const resolve = new Function(
      'fs',
      'path',
      'normalizeFsPath',
      `${extract(runner, 'frozenPath')} return frozenPath;`,
    )(fakeFs, paths, normalize);
    assert.equal(resolve(fixtureRoot, fixtureFile), fixtureFile);
    if (platform === 'win32') assert.equal(resolve(fixtureRoot, fixtureFile.toLowerCase()), fixtureFile);
    else assert.throws(() => resolve(fixtureRoot, fixtureFile.toLowerCase()), /outside its fixture/);
    assert.throws(
      () => resolve(fixtureRoot, fixtureRoot + '-sibling' + paths.sep + 'source.jsonl'),
      /outside its fixture/,
    );
    assert.throws(() => resolve(fixtureRoot, fixtureRoot), /outside its fixture/);
    linked = true;
    assert.throws(() => resolve(fixtureRoot, fixtureFile), /link/);
  }
});

test('isolated startup observes accepted browser content without replacing startup completion', () => {
  const tree = tempDir('startup-overlay');
  const sources = ['panelhost.ts', 'webview/panel.ts'];
  for (const relative of sources) {
    const target = path.join(tree, 'extension/src', relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(__dirname, relative), target);
  }
  instrumentStartup(tree);
  const host = fs.readFileSync(path.join(tree, 'extension/src/panelhost.ts'), 'utf8');
  const browser = fs.readFileSync(path.join(tree, 'extension/src/webview/panel.ts'), 'utf8');
  assert.match(host, /accepted: this.readyHosts.has\(host\) && msg.generation === this.refreshGeneration/);
  assert.match(browser, /measurementObservation:/);
  assert.match(browser, /if \(stamp.complete\) send\('completeRender'\)/);
  assert.match(browser, /item.key === article\?\.dataset.key/);
});

test('isolated startup pins source provenance before a moving reference builds', async () => {
  const text = fs.readFileSync(path.join(__dirname, '../scripts/panel-startup-measure/measure.ts'), 'utf8');
  const file = ts.createSourceFile('measure.ts', text, ts.ScriptTarget.Latest, true);
  const main = file.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === 'main',
  );
  assert.ok(main);
  const original = '1'.repeat(40);
  let reference = original;
  const sources: string[] = [];
  const resolved: string[] = [];
  let artifact: any;
  const deps = {
    readOptions: () => ({ fixture: 'manifest', commit: 'topic', keep: true }),
    loadFixture() {},
    fixture: { workspace: 'frozen' },
    editorCommandLine: () => 'code',
    SCRATCH: 'scratch',
    USER_DATA: 'profile',
    EXTENSIONS: 'extensions',
    ARC_STORE: 'store',
    MEASUREMENT_RUN: 'owned',
    fs: {
      mkdirSync() {},
      readFileSync: () => 'MEASURE_BLOCK_AGENTS',
      writeFileSync: (file: string, value: string) => {
        if (file.endsWith('artifact.json')) artifact = JSON.parse(value);
      },
    },
    git: (args: string[]) => {
      if (args.includes('--short')) return args.at(-1)!.slice(0, 12);
      resolved.push(args.at(-1)!);
      return reference;
    },
    prepareTree: (source: string) => {
      sources.push(source);
      return 'tree';
    },
    protectBaseline() {},
    instrumentStartup() {},
    expectedSelection: { session: 'selected' },
    __filename: 'measure.ts',
    npm: () => {
      reference = '2'.repeat(40);
    },
    run() {},
    seedProfile() {},
    createHash: () => ({ update: () => ({ digest: () => 'digest' }) }),
    isolatedEnvironment: () => ({}),
    measure: async () => ({ complete: true }),
    report() {},
    removeTree() {},
    path,
    process: { argv: [], stdout: { write() {} } },
  };
  const compiled = transformSync(`const {${Object.keys(deps).join(',')}} = deps; export ${main.getText(file)}`, {
    loader: 'ts',
    format: 'cjs',
  }).code;
  const module = { exports: {} as any };
  new Function('deps', 'module', 'exports', compiled)(deps, module, module.exports);
  await module.exports.main();
  assert.notEqual(reference, original);
  assert.deepEqual(sources, [original]);
  assert.deepEqual(resolved, ['topic']);
  assert.equal(artifact.source, original);
  assert.equal(artifact.label, original.slice(0, 12));
});

test('isolated startup protects baseline registrations without replacing their cache argument', () => {
  for (const cache of ['workspaceCache', 'workspaceCacheRoot', 'retainedCache']) {
    const tree = tempDir('startup-baseline');
    const source = path.join(tree, 'extension', 'src');
    fs.mkdirSync(source, { recursive: true });
    const registration = `const panel = registerPanel(context, root, ${cache});`;
    const original = {
      'agenthost.ts': `export const spawnCli: Spawner = (command, args, cwd, env${cache === 'workspaceCacheRoot' ? '' : cache === 'retainedCache' ? ', agent, cli' : ', agent'}) => { return 'spawned'; };`,
      'panelhost.ts':
        'const stored = this.memento?.get(STATE_KEY);\nconst identity = { startedAt: Math.round(performance.timeOrigin), };',
      'extension.ts': registration,
      'diagnosticslog.ts': 'interface Options { keptFiles?: number; }\nconst record = { instance: this.instance, };',
    };
    for (const [name, text] of Object.entries(original)) fs.writeFileSync(path.join(source, name), text);
    protectBaseline(tree);
    const protectedFiles = Object.fromEntries(
      Object.keys(original).map((name) => [name, fs.readFileSync(path.join(source, name), 'utf8')]),
    );
    assert.ok(protectedFiles['extension.ts'].startsWith(registration));
    const environment = { ARC_MEASURE_BLOCK_AGENTS: '1', ARC_MEASURE_STATE: 'frozen', ARC_MEASURE_RUN: 'owned' };
    const spawner = { exports: {} as any };
    new Function(
      'process',
      'module',
      'exports',
      transformSync(protectedFiles['agenthost.ts'], { loader: 'ts', format: 'cjs' }).code,
    )({ env: environment }, spawner, spawner.exports);
    assert.throws(() => spawner.exports.spawnCli(), /Agent connections are disabled/);
    const cacheValue = {};
    let opened = 0;
    new Function('process', 'context', 'root', cache, 'registerPanel', protectedFiles['extension.ts'])(
      { env: environment },
      {},
      'snapshots',
      cacheValue,
      (_context: unknown, root: string, value: unknown) => {
        assert.equal(root, 'snapshots');
        assert.equal(value, cacheValue);
        return { openInEditor: () => opened++ };
      },
    );
    assert.equal(opened, 1);
    const seeded = new Function(
      'process',
      'fs',
      'STATE_KEY',
      'performance',
      `${protectedFiles['panelhost.ts']} return { stored, identity };`,
    ).call(
      {
        memento: {
          get: () => {
            throw new Error('Live state was read');
          },
        },
      },
      { env: environment },
      {
        readFileSync: (file: string) => {
          assert.equal(file, 'frozen');
          return '{"showing":"selected"}';
        },
      },
      'state',
      { timeOrigin: 1 },
    );
    assert.deepEqual(seeded.stored, { showing: 'selected' });
    assert.equal(seeded.identity.measurementRun, 'owned');
    assert.ok(protectedFiles['diagnosticslog.ts'].includes('measurementRun: this.options.measurementRun,'));
    protectBaseline(tree);
    for (const [name, text] of Object.entries(protectedFiles))
      assert.equal(fs.readFileSync(path.join(source, name), 'utf8'), text);
    for (const unsupported of [
      'const panel = registerPanel(context, root, chooseCache());',
      `${registration}\n${registration}`,
      'const other = registerPanel(context, root, workspaceCache);',
      `// ${registration}`,
      `${registration} extra();`,
    ]) {
      fs.writeFileSync(path.join(source, 'extension.ts'), unsupported);
      assert.throws(() => protectBaseline(tree), /isolation boundary: extension.ts/);
      assert.equal(fs.readFileSync(path.join(source, 'extension.ts'), 'utf8'), unsupported);
    }
  }
});

test('isolated startup accepts a baseline that already blocks agents behind a newer spawn signature', () => {
  const tree = tempDir('startup-baseline');
  const source = path.join(tree, 'extension', 'src');
  fs.mkdirSync(source, { recursive: true });
  const original = {
    'agenthost.ts':
      "export const spawnCli: Spawner = (command, args, cwd, env, agent, cli, inherited) => { if (process.env[MEASUREMENT_ENVIRONMENT.blockAgents] === '1') throw new Error('blocked'); };",
    'panelhost.ts':
      'const stored = MEASUREMENT_ENVIRONMENT.state ? frozen() : this.memento?.get(STATE_KEY);\nconst identity = { measurementRun: run, };',
    'extension.ts':
      'const panel = registerPanel(context, root, workspaceCache); if (MEASUREMENT_ENVIRONMENT.state) panel.openInEditor();',
    'diagnosticslog.ts': 'interface Options { measurementRun?: string; }',
  };
  for (const [name, text] of Object.entries(original)) fs.writeFileSync(path.join(source, name), text);
  protectBaseline(tree);
  for (const [name, text] of Object.entries(original))
    assert.equal(fs.readFileSync(path.join(source, name), 'utf8'), text);
});

test('measurement cleanup limits build paths on Windows, macOS, and Linux', () => {
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const scratch = platform === 'win32' ? 'C:\\Temp\\Measure' : '/tmp/Measure';
    const build = paths.join(scratch, 'build');
    assert.equal(measurementBuildPath(scratch, build, platform), true);
    assert.equal(measurementBuildPath(scratch, build.toLowerCase(), platform), platform === 'win32');
    for (const other of [
      scratch,
      `${build}-sibling`,
      paths.join(build, 'nested'),
      paths.join(scratch, '..', 'build'),
    ]) {
      assert.equal(measurementBuildPath(scratch, other, platform), false);
    }
  }
});

test('measurement cleanup removes its detached build while preserving linked dependency targets', () => {
  const scratch = tempDir('startup-cleanup');
  const repository = path.join(scratch, 'repository');
  const build = path.join(scratch, 'build');
  const target = path.join(scratch, 'dependencies');
  fs.mkdirSync(repository);
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep.txt'), 'dependency contents');
  const git = (args: string[], cwd = repository) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  git(['init']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'fixture']);
  git(['worktree', 'add', '-b', 'measurement-fixture', build]);
  assert.throws(() => removeMeasurementTree(repository, scratch, build), /detached worktree/);
  git(['checkout', '--detach'], build);
  const nested = path.join(build, 'nested');
  fs.mkdirSync(nested);
  fs.mkdirSync(path.join(nested, '.Git'));
  assert.throws(() => removeMeasurementTree(repository, scratch, build), /nested checkout/);
  fs.rmdirSync(path.join(nested, '.Git'));
  const links = [path.join(build, 'node_modules'), path.join(nested, 'node_modules')];
  for (const link of links) fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join(target, 'keep.txt'), path.join(build, 'linked-file'));
    fs.symlinkSync(path.join(target, 'missing'), path.join(build, 'dangling-file'));
  }
  fs.writeFileSync(path.join(nested, 'generated.txt'), 'disposable output');
  try {
    removeMeasurementTree(repository, scratch, build);
    assert.equal(fs.existsSync(build), false);
    assert.deepEqual(fs.readdirSync(target), ['keep.txt']);
    assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'dependency contents');
    assert.equal(git(['worktree', 'list', '--porcelain']).includes(build.replaceAll(path.sep, '/')), false);
    removeMeasurementTree(repository, scratch, build);
  } finally {
    for (const link of links) if (fs.existsSync(link)) fs.unlinkSync(link);
  }
});

test('measurement cleanup preserves an unrelated missing worktree registration and index', () => {
  const scratch = tempDir('startup-cleanup-registration');
  const repository = path.join(scratch, 'repository');
  const build = path.join(scratch, 'build');
  const other = path.join(scratch, 'other');
  fs.mkdirSync(repository);
  const git = (args: string[], cwd = repository) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  git(['init']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'fixture']);
  git(['worktree', 'add', '--detach', build]);
  git(['worktree', 'add', '--detach', other]);
  fs.writeFileSync(path.join(other, 'retained.txt'), 'staged work');
  git(['add', 'retained.txt'], other);
  const metadata = git(['rev-parse', '--absolute-git-dir'], other).trim();
  const index = fs.readFileSync(path.join(metadata, 'index'));
  const retained = path.join(scratch, 'temporarily-moved');
  fs.renameSync(other, retained);
  try {
    removeMeasurementTree(repository, scratch, build);
    assert.equal(fs.existsSync(build), false);
    assert.ok(git(['worktree', 'list', '--porcelain']).includes(other.replaceAll(path.sep, '/')));
    assert.deepEqual(fs.readFileSync(path.join(metadata, 'index')), index);
  } finally {
    fs.renameSync(retained, other);
  }
});

test.for(['directory', 'file link'] as const)(
  'measurement cleanup refuses a redirected %s marker and preserves both checkouts',
  (kind, { skip }) => {
    const scratch = tempDir('startup-cleanup-marker');
    const repository = path.join(scratch, 'repository');
    const build = path.join(scratch, 'build');
    const other = path.join(scratch, 'other');
    fs.mkdirSync(repository);
    const git = (args: string[], cwd = repository) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    git(['init']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'fixture']);
    git(['worktree', 'add', '--detach', build]);
    git(['worktree', 'add', '--detach', other]);
    const checkouts = [build, other].map((checkout) => {
      fs.writeFileSync(path.join(checkout, 'retained.txt'), `staged work in ${path.basename(checkout)}`);
      git(['add', 'retained.txt'], checkout);
      const registration = git(['rev-parse', '--absolute-git-dir'], checkout).trim();
      return {
        checkout,
        registration,
        index: fs.readFileSync(path.join(registration, 'index')),
        sentinel: fs.readFileSync(path.join(checkout, 'retained.txt')),
      };
    });
    const marker = path.join(build, '.git');
    const contents = fs.readFileSync(marker);
    fs.unlinkSync(marker);
    try {
      if (kind === 'directory') fs.mkdirSync(marker);
      else {
        try {
          fs.symlinkSync(path.join(other, '.git'), marker, 'file');
        } catch (error) {
          if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
          skip();
          return;
        }
      }
      assert.throws(() => removeMeasurementTree(repository, scratch, build), /Git marker is not a plain file/);
      const inventory = git(['worktree', 'list', '--porcelain']);
      for (const { checkout, registration, index, sentinel } of checkouts) {
        assert.ok(inventory.includes(checkout.replaceAll(path.sep, '/')));
        assert.ok(fs.existsSync(registration));
        assert.deepEqual(fs.readFileSync(path.join(registration, 'index')), index);
        assert.deepEqual(fs.readFileSync(path.join(checkout, 'retained.txt')), sentinel);
      }
    } finally {
      if (fs.existsSync(marker)) {
        if (fs.lstatSync(marker).isDirectory()) fs.rmdirSync(marker);
        else fs.unlinkSync(marker);
      }
      fs.writeFileSync(marker, contents);
    }
  },
);

test('measurement cleanup refuses redirected, unregistered, and unrelated directories', () => {
  const scratch = tempDir('startup-cleanup-refusal');
  const target = tempDir('startup-cleanup-kept');
  const build = path.join(scratch, 'build');
  fs.writeFileSync(path.join(target, 'keep.txt'), 'keep');
  fs.symlinkSync(target, build, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    assert.throws(() => removeMeasurementTree(target, scratch, build), /plain directory/);
    assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'keep');
  } finally {
    fs.unlinkSync(build);
  }
  fs.mkdirSync(build);
  assert.throws(() => removeMeasurementTree(target, scratch, target), /outside the measurement build/);
  execFileSync('git', ['-C', target, 'init']);
  assert.throws(() => removeMeasurementTree(target, scratch, build), /detached worktree/);
  assert.equal(fs.existsSync(build), true);
});

test('isolated startup removes pending agent actions and rejects external frozen inputs', () => {
  assert.deepEqual(
    sanitizeMeasurementState({
      showing: 'selected',
      railFilter: 'is:running',
      queues: { selected: ['send'] },
      sent: ['send'],
      drafts: { selected: 'send' },
      newDrafts: ['launch'],
    }),
    { showing: 'selected', railFilter: 'is:running' },
  );
  const root = tempDir('startup-frozen');
  const external = tempDir('startup-live');
  fs.writeFileSync(path.join(root, 'source.jsonl'), '{}');
  assert.equal(frozenPath(root, 'source.jsonl'), path.join(root, 'source.jsonl'));
  assert.throws(() => frozenPath(root, external), /outside its fixture/);
  fs.symlinkSync(external, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  try {
    assert.throws(() => frozenPath(root, 'linked'), /link/);
  } finally {
    if (process.platform === 'win32') fs.rmdirSync(path.join(root, 'linked'));
    else fs.unlinkSync(path.join(root, 'linked'));
  }
  assert.equal(fs.existsSync(external), true);
});

let panelProviderMembers: Set<string> | undefined;
let harnessFaults: Error[] = [];
// Each guarded harness has a signal that resolves with its fault. The signal lives here, outside the proxy, so reading it
// never counts as a PanelProvider member read.
const harnessFaultSignals = new WeakMap<object, Promise<Error>>();

afterEach(() => {
  const faults = harnessFaults;
  harnessFaults = [];
  if (faults.length) throw faults[0];
});

// A harness copies only some PanelProvider methods. A path that retries after catching the TypeError from a missing method
// turns that miss into a microtask loop. The loop never yields to the event loop, so no test timer fires. The worker then
// spins until it runs out of memory. Tests tolerate a few missing methods, and each harness class declares them as the stubs
// below. The wrapper fails on the first read of any other PanelProvider method that the harness lacks. The error names that
// method. The proxy keeps the fault, so every later read throws and the retry loop ends. The afterEach hook rethrows the
// fault in the test that caused it. Other tests build fresh harnesses and are unaffected. A test that waits for work the
// fault stopped fails at once when it awaits through raceHarnessFault. Discovery reads the instance methods of the class by identifier or string name.
// Getters and properties that hold a function are not covered. A computed method name fails the discovery.
const OPTIONAL_PANEL_PROVIDER_STUBS = `
      updateProjectSpendIntegrity() {}
      publishProjectSpendCoverage() {}
      defaultContext() { return undefined; }
      acceptExplicitMetadataRead() {}
      launcherDefaults() { return undefined; }
      agentSpendKey() { return 'spend'; }
      refreshAgentFacts() {}
      usagePayloadForSession(session, webview) { return this.usagePayload(webview); }
`;

function panelProviderMemberNames(): Set<string> {
  const file = ts.createSourceFile(
    'panelhost.ts',
    fs.readFileSync(path.join(__dirname, 'panelhost.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const owner = file.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === 'PanelProvider',
  );
  assert.ok(owner);
  const names = new Set<string>();
  for (const member of owner.members) {
    if (!ts.isMethodDeclaration(member) || ts.isPrivateIdentifier(member.name)) continue;
    if (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static) continue;
    assert.ok(
      ts.isIdentifier(member.name) || ts.isStringLiteral(member.name),
      `The startup harness guard cannot read the PanelProvider method name ${member.name.getText(file)}.`,
    );
    names.add(member.name.text);
  }
  return names;
}

// Rejects with the harness fault when the harness records one before the wait settles. The signal resolves with the error and
// this wait rejects, so a fault that nobody waits on leaves no unhandled rejection.
function raceHarnessFault<T>(provider: object, wait: Promise<T>): Promise<T> {
  const signal = harnessFaultSignals.get(provider);
  assert.ok(signal, 'The provider is not a guarded harness.');
  return Promise.race([
    wait,
    signal.then((error): never => {
      throw error;
    }),
  ]);
}

function guardedHarness<T extends object>(provider: T): T {
  const members = (panelProviderMembers ??= panelProviderMemberNames());
  let fault: Error | null = null;
  let notify!: (error: Error) => void;
  const signal = new Promise<Error>((resolve) => {
    notify = resolve;
  });
  const guarded = new Proxy(provider, {
    get(target, key, receiver) {
      if (typeof key !== 'string' || key === 'then') return Reflect.get(target, key, receiver);
      if (!fault && members.has(key) && !(key in target)) {
        fault = new Error(
          `The startup harness lacks the PanelProvider member ${key}, which the code under test used. Add ${key} to the method list of the harness that built this provider.`,
        );
        harnessFaults.push(fault);
        notify(fault);
      }
      if (fault) throw fault;
      return Reflect.get(target, key, receiver);
    },
  });
  harnessFaultSignals.set(guarded, signal);
  return guarded;
}

function harness(pendingRefresh = false, registerRefreshHandler = true, extraMethods: string[] = []): any {
  const file = ts.createSourceFile(
    'panelhost.ts',
    fs.readFileSync(path.join(__dirname, 'panelhost.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const owner = file.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === 'PanelProvider',
  );
  assert.ok(owner);
  const methods = [
    'attach',
    'publishWindowState',
    'browserReady',
    'browserPainted',
    'anyVisible',
    'sendToHost',
    'abandonCatalogRefresh',
    'runPendingRefresh',
    'setRefreshUsageHandler',
    'requestInitialCatalogRefresh',
    'drainInitialCatalogRefresh',
    'refreshSelectedCatalogs',
    'releaseQueuedEditOffer',
  ];
  if (pendingRefresh) {
    methods.push('refresh');
  }
  methods.push(
    'refreshFrom',
    'refreshAs',
    'claimCatalogRefresh',
    'releaseCatalogRefresh',
    'scheduleDiscoveryContinuation',
    'continueDiscovery',
  );
  methods.push(...extraMethods);
  const body = owner.members
    .filter((member) => member.name && methods.includes(member.name.getText(file)))
    .map((member) => member.getText(file))
    .join('\n');
  const compiled = transformSync(
    `
    const serializedMessageBytes = () => 0;
    const isInside = () => true;
    const folderMatcher = () => () => true;
    const revalidatedCatalog = (sessions) => sessions;
    const replacedCatalogFiles = async () => [];
    const normalizeFsPath = ${normalizeFsPath.toString()};
    const messageByteBudget = () => null;
    const spendFileVersion = () => 'unchanged';
    const codexSessionIndexPath = () => 'index';
    const shortenTo = (line, limit, ellipsis) => line.length <= limit ? line : line.slice(0, Math.max(0, limit - ellipsis.length)) + ellipsis;
    const RAIL_NAME_LIMIT = 200;
    export class Harness {
      ${OPTIONAL_PANEL_PROVIDER_STUBS}
      membershipOf(session) { return this.sessions?.some((source) => source.sessionId === session) ? 'present' : 'absent'; }
      acceptSessionCoverage(current) { this.membershipCoverage = { status: 'complete' }; return current; }
      sessionQueryContext() { return undefined; }
      publishSessionQueryContext() {}
      hasHumanPrompt() { return true; }
      async prepareHumanPrompts(sessions) { return sessions.filter((session) => this.hasHumanPrompt(session)); }
      failSessionLoading() {}
      noteSessionRead() {}
      loadingLine = new SessionLoadingLine(() => {});
      hosts = []; readyHosts = new Set(); panelVisibility = createPanelVisibility(); reads = 0; polls = 0; usageRequests = [];
      queuedEditOffers = new Map(); queuedEditReservations = new Set();
      railOrder = []; boxText = {}; sessionRows = [{ id: 'selected', agentKey: 'claude' }]; refreshGeneration = 0; refreshController = null;
      refreshUsageHandler = null; initialCatalogRefreshPending = false; initialCatalogRefreshRequested = false;
      progressiveWorker = { stop() {} };
      performanceCounters = { recordRowPost() {}, recordRowsGap() {}, recordWork() {}, recordWatcherOperation() {}, registerPanel() {}, releasePanel() {}, recordStartup() {}, recordMessage() {}, recordRefresh() {}, recordRefreshStage() {} };
      poll = null; watching = true; codexStats = null; pendingWatch = new Map(); watchScheduler = { cancel() {} };
      watchDirectories() {}
      pendingRefresh = null; showing = 'selected'; repositoryScopeReady = true; repositoryScopeRoots = ['project']; awaitingSessionRecords = {}; newDrafts = {}; selectionGeneration = 0; selectionWork = null; selectionFailure = null;
      sessions = [{ file: 'selected.jsonl', size: 1, mtimeMs: 1 }];
      allSessions() { return this.sessions; }
      folders() { return ['project']; }
      ownCwdForSession() { return 'D:/selected-worktree'; }
      agentListingStamp() { return ''; }
      prepareClaudeChildren() { return Promise.resolve(true); }
      prepareMetadata() { this.reads++; return Promise.resolve(false); }
      refresh() { this.reads++; }
      startPolling() { this.polls++; }
      stopPolling() { this.polls = 0; }
      allowThemeFiles() {}
      panelStartedAt = null;
      notePanelStart() {}
      shell() { return 'shell'; }
      closeBrowserStagingForHost() {}
      healthPanel() { return { id: 1, posting: false }; }
      onMessage(message, host) { if (message.type === 'ready') this.browserReady(host); }
      ${body}
    }`,
    { loader: 'ts', format: 'cjs' },
  ).code;
  const module = { exports: {} as any };
  new Function(
    'module',
    'exports',
    'createPanelVisibility',
    'orderSessionCatalog',
    'mergeRefreshRequests',
    'CATALOG_REFRESH_DEADLINE_MS',
    'SessionLoadingLine',
    compiled,
  )(
    module,
    module.exports,
    createPanelVisibility,
    orderSessionCatalog,
    mergeRefreshRequests,
    CATALOG_REFRESH_DEADLINE_MS,
    SessionLoadingLine,
  );
  const provider = guardedHarness(new module.exports.Harness());
  if (registerRefreshHandler) {
    provider.setRefreshUsageHandler((agent: string | null, force: boolean) => {
      provider.usageRequests.push([agent, force]);
    });
  }
  return provider;
}

function host(readyDuringHtml = false, initiallyVisible = true): any {
  let receive: (message: unknown) => void;
  let dispose: () => void;
  let visibility: () => void;
  const sent: unknown[] = [];
  let visible = initiallyVisible;
  return {
    sent,
    visible: () => visible,
    ready() {
      receive({ type: 'ready' });
    },
    dispose() {
      dispose();
    },
    changeVisibility(next = true) {
      visible = next;
      visibility();
    },
    webview: {
      onDidReceiveMessage(callback: typeof receive) {
        receive = callback;
        return { dispose() {} };
      },
      set html(_html: string) {
        if (readyDuringHtml) {
          assert.ok(receive);
          receive({ type: 'ready' });
        }
      },
      postMessage(message: unknown) {
        sent.push(message);
        return Promise.resolve(true);
      },
    },
    onDidDispose(callback: typeof dispose) {
      dispose = callback;
      return { dispose() {} };
    },
    onDidChangeVisibility(callback: typeof visibility) {
      visibility = callback;
      return { dispose() {} };
    },
  };
}

function completeDiscoveryHarness(
  revalidate: (sessions: any[], showing: string | null, statOf: (file: string) => unknown) => any[] | null = (
    sessions,
  ) => sessions,
  realSelectedWindow = false,
  extraMethods: string[] = [],
  scope: Record<string, unknown> = {},
  railCacheMark: typeof railCacheMarkOf = () => null,
  cacheStats: typeof derivedTitleCacheStats = derivedTitleCacheStats,
): any {
  scope = { startingWorktree, ...scope };
  const file = ts.createSourceFile(
    'panelhost.ts',
    fs.readFileSync(path.join(__dirname, 'panelhost.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const owner = file.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === 'PanelProvider',
  );
  assert.ok(owner);
  scope = {
    CommitRepositories,
    RepositoryCommits,
    claudeSubagentMetaReader,
    claudeChildFileFor,
    codexSubagentFor,
    compatibleDiscovery,
    discoveryCompatibility,
    projectSpendWindows,
    sessionCoverageMember,
    reconcileSessionCollisions,
    sessionCatalogMembership,
    sessionPageSources,
    sessionPresence,
    sessionSourceKey,
    supportedFileIdentity,
    fs,
    fileRevisionOf,
    SpendCoverage,
    projectsRoot: () => 'projects',
    codexSessionsRoot: () => 'sessions',
    sameSessionRevision,
    outcomesFor,
    runningKey,
    replacedCatalogFiles: async () => [],
    enumerateRolloutFilesAsync,
    enumerateClaudeChildSources,
    ...scope,
  };
  const names = [
    'show',
    'publishWindowState',
    'createDraft',
    'refresh',
    'postRows',
    'rowSender',
    'refreshFrom',
    'refreshAs',
    'claimCatalogRefresh',
    'releaseCatalogRefresh',
    'scheduleDiscoveryContinuation',
    'continueDiscovery',
    'runPendingRefresh',
    'abandonCatalogRefresh',
    'drainInitialCatalogRefresh',
    'cancelProjectSpendHydration',
    'scheduleProjectSpendHydration',
    'scheduleNextProjectSpendFile',
    'sessionParentsOf',
    'sessionParentEdges',
    'acceptSessionCoverage',
    'membershipOf',
    'physicalMembershipOf',
    'parentOfShown',
    'dispatchEdges',
    'storeTitleEntry',
    'recordLoadingFailures',
    'sessionLoadingState',
    'sessionLoadingBlocker',
    'postSessionLoading',
    'sendSessionLoading',
    'withSourceCount',
    'settleSourceCount',
    'sourceCountOf',
    'failSessionLoading',
    'noteSessionRead',
    'applyCommitRepositories',
    'agentFile',
    'unresolvedLoadingFailure',
    ...extraMethods,
  ];
  if (realSelectedWindow) {
    names.push(
      'currentSelectedSession',
      'completeSelectedWindow',
      'commitRepositoryTurns',
      'commitRepositoryContexts',
      'applyCommitRepositoryEvidence',
      'carryCommitRepositories',
      'hydrateCommitRepositories',
      'updateHistoryAfterAcceptedWindow',
      'acceptExplicitMetadataRead',
      'acceptSelectedMetadataRead',
    );
  }
  if (names.includes('allSessions')) names.push('walkedSessions');
  if (names.includes('allSessions') || names.includes('runPendingWatch')) names.push('currentWalkedCatalog');
  if (names.includes('prepareClaudeChildren')) names.push('startedSources');
  names.push('walkCatalog');
  const body = owner.members
    .filter((member) => member.name && names.includes(member.name.getText(file)))
    .map((member) => member.getText(file))
    .join('\n');
  const compiled = transformSync(
    `
    const isInside = ${scope.scopeInside ? 'scopeInside' : '() => true'};
    const folderMatcher = (folders) => (target) => isInside(target, folders);
    const pickShowing = (sessions, wanted) => wanted && sessions.includes(wanted) ? wanted : sessions[0] ?? null;
    const sessionLauncherView = (_state, recent) => ({ recent, primary: recent?.[0] ? { key: 'recent:0', profile: recent[0] } : null });
    const launcherProfile = (view, request) => (request.kind === 'row' && view.primary?.key === request.key ? { ...view.primary.profile } : null);
    const newSessionDraft = (draftId, cwd, sourceSession, createdAt, profile, origin) => ({ draftId, cwd, sourceSession, createdAt, profile, origin });
    const withSessionSettings = (picks, session, settings) => ({ ...picks, [session]: settings });
    const sessionSettingsForProfile = (profile) => profile;
    const AGENT_NAMES = { claude: 'Claude', codex: 'Codex' }; const DRAFT_SESSION_PREFIX = 'draft:';
    const watchDirs = ${scope.productionWatchDirs ? 'productionWatchDirs' : '() => []'}; const readThreadNames = (_path, names) => names;
    const codexSessionIndexPath = () => 'index'; const spendFileVersion = () => 'unchanged';
    let spendSourceSignature = () => ''; let listingSignature = () => 'catalog';
    let projectSpendSourceOfferDue = () => false; const normalizeFsPath = ${scope.productionNormalizeFsPath ? 'productionNormalizeFsPath' : '(value) => value'};
    const trustedListedRevisions = () => new Map(); const sessionStatusOf = () => new Map();
    let refreshWanted = () => true; const statusMoved = () => false; const openChildrenKey = () => ''; const openChildCounts = () => new Map();
    const agentsWithNewTurns = (seen) => ({ seen, agents: [] }); const drawnSessionCards = (cards) => cards;
    const resumeCommand = () => ''; const formatWhen = () => ''; const formatRelative = () => '';
    let sessionStatsFromFacts = (facts) => facts; const railCacheMarkOf = railCacheMark; const derivedTitleCacheStats = cacheStats;
    const newestTurnLoading = () => ({}); const emptyTimeline = () => null;
    const readSetting = ${scope.snapshotHistoryDays ? 'snapshotHistoryDays' : '() => 3'}; const isLightColourTheme = () => false;
    const sessionLabelOf = (name, id) => ({ label: name?.label || 'Session ' + id.slice(0, 8), fullLabel: name?.fullLabel || name?.label || 'Session ' + id.slice(0, 8) });
    const storedSessionName = ${scope.realStoredSessionName ? 'realStoredSessionName' : '() => null'};
    const shortenTo = (line, limit, ellipsis) => line.length <= limit ? line : line.slice(0, Math.max(0, limit - ellipsis.length)) + ellipsis;
    const RAIL_NAME_LIMIT = 200;
    const TRANSCRIPT_TURN_LIMIT = 40; const TRANSCRIPT_TAIL_BYTES = 1024;
    const renderPayload = (value) => ({ type: 'render', ...value, ...value.rail }); const olderHistoryPossible = () => false;
    const olderHistoryControl = () => null; const syntheticDraftRows = (drafts) => drafts.map((draft) => ({ ...draft, id: draft.draftId, label: 'New session' }));
    const prunePlaces = (trail) => trail; const visitPlace = (trail) => trail;
    let railPayload = () => ({ rail: [], labels: [], views: [], railFilters: [], stats: {} });
    export class Harness {
      ${OPTIONAL_PANEL_PROVIDER_STUBS}
      sessionQueryContext() { return undefined; }
      publishSessionQueryContext() {}
      failSessionLoading() {}
      noteSessionRead() {}
      loadingLine = new SessionLoadingLine((event, record) => this.diagnostics.warn(event, record));
      commitRepositories = new CommitRepositories({ run: async () => null }, () => {});
      repositoryCommits = new RepositoryCommits({ run: async () => null }, () => {});
      _showing = null; selections = []; messages = []; partial = []; catalog = null; drawnCards = [];
      coverageRevision = 0; enumeratedAdmissionComplete = true; claudeChildren = [];
      authoritativeCatalog = null; attachmentHandoffs = new Set(); titles = new Map();
      metadataRevision = 0; drawnMetadataRevision = 0; startupProgressAt = 0;
      derivedCacheCheckpointState = { markChanged() {} };
      // Messages record the session rows the panel holds after rebuilding each row delta.
      heldRows = new RowDeltaReceiver();
      expandRows(message) { const held = this.heldRows.expand(message); if (!held) throw new Error('a ' + message.type + ' message did not apply to the rows the panel holds'); return held; }
      hosts = [{ webview: { postMessage: (message) => { this.messages.push(message.type === 'render' || message.type === 'rail' ? this.expandRows(message) : message); return Promise.resolve(true); } }, active: () => false, visible: () => true }]; readyHosts = new Set(this.hosts); panelVisibility = createPanelVisibility();
      refreshGeneration = 0; refreshController = null; pendingRefresh = null; refreshReason = 'startup'; targetedRefreshPaths = null; selectionGeneration = 0; selectionWork = null; selectionFailure = null;
      repositoryScopeReady = true; repositoryScopeRoots = ['project']; awaitingSessionRecords = {}; newDrafts = {}; draftProfiles = {}; sessionOrigins = {}; drafts = {}; picks = {};
      refreshUsageHandler = null; initialCatalogRefreshPending = false; initialCatalogRefreshRequested = false;
      recentProfiles = []; models = {}; watching = false; trail = null; sessionAliases = new Map();
      threadNames = { stamp: '' }; lastSpendSourceSignature = ''; projectSpendLastOfferAt = 0;
      windows = new Map(); newestBySession = new Map(); collectedAt = 0; drawnOpenChildren = ''; lastSignature = ''; cache = new Map();
      cards = []; seenTurns = new Set(); turnMarks = []; sessionRows = []; hidden = []; pinnedTop = []; saved = { comments: [], labels: {} };
      metadataStatsBySession = {}; metadataRailCaches = {}; metadataRailRevisions = {}; parsedRailCaches = {};
      metadataStatFigures = new SessionFactFigures(); metadataCacheFigures = new SessionFactFigures();
      lastRailMessageType = null; lastRailMessageSerializedBytes = null; lastRailKey = null;
      railRevision = 0; lastRailRevision = -1; lastRailDay = ''; lastRailCountsJson = '';
      sessionNames = { observe() { return false; }, get() { return null; }, observeTurns() { return new Set(); } };
      projectSpendHydrated = true; projectSpendHydrationReady = true; projectSpendHydrationTick = null;
      projectSpendIndexing = false; projectSpendOffers = new Set(); readWindows = new Map(); history = new Map(); historyRequest = null;
      projectSpendFiles = []; projectSpendVisibleFiles = [];
      projectSpendEpoch = 0; projectSpendSnapshot = null; projectSpendTomorrow = null;
      projectSpendSnapshotDate = null; projectSpendSnapshotPrice = null;
      projectSpendRebuild = null; projectSpendBuild = null;
      invalidateProjectSpendSnapshot() {} cancelProjectSpendRebuild() {}
      unknownProjectSpendSnapshot() { return null; }
      historyStructuralKeys = new Map(); dropped = 0; live = {};
      posts = []; markStartedPresses() {} postAcceptedResponses() {}
      post(message) { this.posts.push(message); return Promise.resolve(); }
      progressiveWorker = { run() { return Promise.resolve(null); } };
      performanceCounters = { recordRowPost() {}, recordRowsGap() {}, recordWork() {}, recordWatcherOperation() {}, recordMessage() {}, recordRefresh() {}, recordRefreshStage() {}, recordStartup() {} };
      warnedMessageBudgets = new Set(); performanceOutput = null; icons = { fontFaces() { return []; } };
      diagnostics = { log() {}, warn() {}, file() { return null; }, enabled() { return false; } };
      get showing() { return this._showing; }
      set showing(value) { if (value !== this._showing) this.selections.push(value); this._showing = value; }
      abandonDraft() { return false; }
      anyVisible() { return true; } allSessions() { return this.partial; } folders() { return ['project']; }
      hasHumanPrompt() { return true; }
      async prepareHumanPrompts(sessions) { return sessions.filter((session) => this.hasHumanPrompt(session)); }
      activityFor(session) { return session.activity; }
      // A discovery that runs while no further pass is pending stands for a complete reply under the current roots that answered the
      // held catalog.
      prepareClaudeChildren() {
        if (!this.dispatchDiscoveryPending)
          this.discoveryComplete = {
            scope: JSON.stringify(this.repositoryScopeRoots),
            files: new Set((this.catalog?.sessions ?? this.partial).map((session) => session.file)),
          };
        return this.discovery;
      }
      prepareMetadata() { return Promise.resolve(true); } ensureProjectSpendWorkspace() {} watchDirectories() {}
      shownSessions(sessions) { return sessions.filter((session) => session.sessionId === this.showing); }
      outcomesFor() { return new Map(); } agentListingStamp() { return ''; } queueProjectSpendIndex() {}
      // The ledger stands still unless a test asks for the real answer, which the methods a
      // test names replace this with.
      projectSpendBusy() { return this.projectSpendIndexing; } projectSpendSources() { return []; }
      postDispatchedCostsIfMoved() {}
      dispatchedCostsForTurn() { return []; }
      dispatchedDiscoveryWaiting() { return false; }
      indexNextClaudeCostState() { return false; }
      settleRailSeed() {}
      glanceAt() { return new Map(); } dropSpentPresses() { return false; } evictCache() {}
      collect() { return this.drawnCards; } unreadCounts() { return new Map(); } titleFor() { return null; } fullTitleFor() { return null; }
      sessionLabel(session) { return sessionLabelOf(null, session.sessionId); }
      agentRunFor() { return false; } drainPendingQueues() {} flushAgentQueue() {} metaFor() { return { stats: null, starts: undefined }; }
      runningSessions() { return []; } waitingSessions() { return []; } runningSince() { return new Map(); } liveOpenChildren() { return new Map(); } liveBackgroundCommands() { return new Map(); } pruneExits() {}
      railStatuses() { return { statuses: new Map(), openChildren: new Map() }; }
      heldLifetime = { stats: {}, costs: {}, contextDetails: {} };
      // The dispatched-source answers a drawn rail keeps. A test that reads real figures replaces this.
      lifetimeFigures = { answers: () => new Map(), pendingMoved: () => false };
      lifetimeFiguresBySession() { return this.heldLifetime; }
      // The inputs as the host gathers them: printed values built afresh, and the rows and
      // figures held by identity.
      railInputFor(counts, statuses) {
        const lifetime = this.lifetimeFiguresBySession();
        return {
          sessions: this.sessionRows, counts: counts ?? new Map(), newest: new Map(), statuses: statuses ?? new Map(),
          runningSince: this.runningSince(), openChildren: new Map(), hidden: new Set(this.hidden), showing: this.showing, pinnedTop: new Set(this.pinnedTop),
          unsent: new Map(), parsedStats: {}, metadataStats: this.metadataStatsBySession, lifetimeStats: lifetime.stats,
          lifetimeContextDetails: lifetime.contextDetails, lifetimeCosts: lifetime.costs, labels: this.saved.labels ?? {},
          caches: {}, views: this.saved.views ?? [], railFilters: this.saved.railFilters ?? [], now: Date.now(),
        };
      }
      useRailPayload(build) { railPayload = build; }
      progressiveCurrent() { return false; } projectSpendPayload() { return null; } postProjectSpend() {} usagePayload() { return null; }
      themedFor(cards) { return cards; } checkpointDerivedCache() {} prepareProgressive() { return Promise.resolve(false); }
      prepareRailEnrichment() { return Promise.resolve({ changed: false, catalogCurrent: true }); }
      revisionOf(session) { return { size: session.size, mtimeMs: session.mtimeMs, dev: session.dev ?? 1, ino: session.ino ?? 2 }; }
      structuralKey() { return ''; } agentFactsCurrent() { return true; } dropOlderHistory() { this.dropped++; }
      progressiveInput(session) { return { session, folders: [], children: [], maxTurns: 40, tailBytes: 1024 }; }
      ${realSelectedWindow ? '' : 'completeSelectedWindow() { return Promise.resolve(); }'}
      sendToHost(_host, message) { this.messages.push(message); return Promise.resolve(); }
      useRefreshGate(gate) { refreshWanted = gate; }
      useSessionStats(build) { sessionStatsFromFacts = build; }
      useListingSignature(sign) { listingSignature = sign; }
      useSpendSignature(sign) { spendSourceSignature = sign; }
      useSpendOfferGate(gate) { projectSpendSourceOfferDue = gate; }
      useSnapshotPrice(price) { publicProjectSpendPrice = price; }
      ${body}
    }`,
    { loader: 'ts', format: 'cjs' },
  ).code;
  const module = { exports: {} as any };
  new Function(
    'module',
    'exports',
    'createPanelVisibility',
    'orderSessionCatalog',
    'revalidatedCatalog',
    'sameProgressiveRevision',
    'transcriptReadCacheKey',
    'acceptsProgressiveResult',
    'preservesLoadedHistory',
    'historyStateAfterRevision',
    'retainDisplacedWindow',
    'historyRecordsOutside',
    'startSessionHistory',
    'onlyGrew',
    'mergeRefreshRequests',
    'CATALOG_REFRESH_DEADLINE_MS',
    'derivedTitleStats',
    'withMetadataCoverage',
    'railEnrichmentNeeds',
    'railInputKey',
    'railWordingDay',
    'RowDeltaReceiver',
    'RowDeltaSender',
    'sameRailInputs',
    'railMessage',
    'sessionAdoptions',
    'selectionPayload',
    'messageByteBudget',
    'messageFieldBytes',
    'serializedMessageBytes',
    'railCacheMark',
    'cacheStats',
    'derivedTitleCacheRevision',
    'sessionParentEdgeSet',
    'sessionParentIndex',
    'sessionParentOf',
    'recordedCostBasis',
    'SessionFactFigures',
    'isDeepStrictEqual',
    'invalidateClaudeCostSupplements',
    'countedDispatchedCosts',
    'SessionLoadingLine',
    'pendingResponseSessionAdmitted',
    'sessionDiscoveryMembership',
    ...Object.keys(scope),
    compiled,
  )(
    module,
    module.exports,
    createPanelVisibility,
    orderSessionCatalog,
    revalidate,
    sameProgressiveRevision,
    transcriptReadCacheKey,
    acceptsProgressiveResult,
    preservesLoadedHistory,
    historyStateAfterRevision,
    retainDisplacedWindow,
    historyRecordsOutside,
    startSessionHistory,
    onlyGrew,
    mergeRefreshRequests,
    CATALOG_REFRESH_DEADLINE_MS,
    derivedTitleStats,
    withMetadataCoverage,
    railEnrichmentNeeds,
    railInputKey,
    railWordingDay,
    RowDeltaReceiver,
    RowDeltaSender,
    sameRailInputs,
    railMessage,
    sessionAdoptions,
    selectionPayload,
    messageByteBudget,
    messageFieldBytes,
    serializedMessageBytes,
    railCacheMark,
    cacheStats,
    derivedTitleCacheRevision,
    sessionParentEdgeSet,
    sessionParentIndex,
    sessionParentOf,
    recordedCostBasis,
    SessionFactFigures,
    isDeepStrictEqual,
    invalidateClaudeCostSupplements,
    countedDispatchedCosts,
    SessionLoadingLine,
    pendingResponseSessionAdmitted,
    sessionDiscoveryMembership,
    ...Object.values(scope),
  );
  const provider = guardedHarness(new module.exports.Harness());
  if (!extraMethods.includes('allSessions')) {
    const accept = provider.acceptSessionCoverage.bind(provider);
    provider.acceptSessionCoverage = (current: any[], scope: string) => {
      const complete = { status: 'complete', files: current.map((source) => source.file), uncertain: [] };
      provider.sourceEnumerations = { claude: complete, codex: complete };
      provider.enumeratedAdmissionComplete = true;
      provider.enumeratedMembers = new Set(current.map(sessionCoverageMember));
      return accept(current, scope);
    };
  }
  return provider;
}

function railEnrichmentHarness(
  run: (request: ProgressiveRequest, generation: number, signal: AbortSignal) => Promise<ProgressiveResult | null>,
): any {
  const file = ts.createSourceFile(
    'panelhost.ts',
    fs.readFileSync(path.join(__dirname, 'panelhost.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const owner = file.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === 'PanelProvider',
  );
  assert.ok(owner);
  const method = owner.members.find((member) => member.name?.getText(file) === 'prepareRailEnrichment');
  assert.ok(method);
  const compiled = transformSync(
    `
    export class Harness {
      ${OPTIONAL_PANEL_PROVIDER_STUBS}
      sessionQueryContext() { return undefined; }
      publishSessionQueryContext() {}
      failSessionLoading() {}
      titles = new Map();
      refreshGeneration = 1;
      codexMetas = { get() { return undefined; } };
      derivedCacheCheckpointState = { changes: 0, markChanged() { this.changes++; } };
      progressiveWorker;
      constructor(run) { this.progressiveWorker = { run }; }
      revisionOf(session) { return { size: session.size, mtimeMs: session.mtimeMs, dev: 1, ino: 2 }; }
      observeStoredName(_session, entry) { return entry; }
      observeStoredEntry() {}
      ${owner.members.find((member) => member.name?.getText(file) === 'storeTitleEntry')?.getText(file) ?? ''}
      ${owner.members.find((member) => member.name?.getText(file) === 'noteSessionRead')?.getText(file) ?? ''}
      ${method.getText(file)}
    }`,
    { loader: 'ts', format: 'cjs' },
  ).code;
  const module = { exports: {} as any };
  new Function(
    'module',
    'exports',
    'createPanelVisibility',
    'INITIAL_RAIL_READ_BYTES',
    'RAIL_ENRICHMENT_READ_BYTES',
    'agentRunScanUnread',
    'metadataReadBudget',
    'railEnrichmentNeeds',
    'withRailEnrichment',
    'acceptsProgressiveResult',
    'onlyGrew',
    'withAgentRunScanProgress',
    'carryDerivedTitleFacts',
    'scanForRailEnrichment',
    'withMetadataCoverage',
    compiled,
  )(
    module,
    module.exports,
    createPanelVisibility,
    INITIAL_RAIL_READ_BYTES,
    RAIL_ENRICHMENT_READ_BYTES,
    agentRunScanUnread,
    metadataReadBudget,
    railEnrichmentNeeds,
    withRailEnrichment,
    acceptsProgressiveResult,
    onlyGrew,
    withAgentRunScanProgress,
    carryDerivedTitleFacts,
    scanForRailEnrichment,
    withMetadataCoverage,
  );
  return guardedHarness(new module.exports.Harness(run));
}

// Extracts prepareMetadata and optional naming methods from PanelProvider.
// A supplied cache file also enables constructor restore statements and display checkpoint methods.
function metadataHarness(
  run: (request: ProgressiveRequest, generation: number, signal: AbortSignal) => Promise<ProgressiveResult | null>,
  sessionNames?: SessionNames,
  derivedCacheFile?: string,
): any {
  const file = ts.createSourceFile(
    'panelhost.ts',
    fs.readFileSync(path.join(__dirname, 'panelhost.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const owner = file.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === 'PanelProvider',
  );
  assert.ok(owner);
  const method = owner.members.find((member) => member.name?.getText(file) === 'prepareMetadata');
  assert.ok(method);
  const naming = ['observeStoredName', 'observeStoredEntry'];
  const real = owner.members.filter((member) => member.name && naming.includes(member.name.getText(file)));
  assert.equal(real.length, naming.length, 'panelhost.ts no longer reports a stored metadata entry to the name owner');
  const names = sessionNames
    ? real.map((member) => member.getText(file)).join('\n')
    : 'observeStoredName(_session, entry) { return entry; }\n      observeStoredEntry() {}';
  let restore = '';
  let drawing = '';
  if (derivedCacheFile) {
    const statements = owner.members.find(ts.isConstructorDeclaration)?.body?.statements ?? [];
    const at = statements.findIndex((statement) =>
      statement.getText(file).startsWith('const cached = this.derivedCacheFile ? loadDerivedCache('),
    );
    assert.notEqual(at, -1, 'the provider no longer restores the derived cache at startup');
    restore = statements
      .slice(at, at + 2)
      .map((statement) => statement.getText(file))
      .join('\n');
    const drawn = ['sessionLabel', 'claudeName', 'titleFor', 'fullTitleFor', 'metaFor', 'writeDerivedCache'];
    const members = owner.members.filter((member) => member.name && drawn.includes(member.name.getText(file)));
    assert.equal(members.length, drawn.length, 'panelhost.ts no longer names sessions through these methods');
    drawing = members.map((member) => member.getText(file)).join('\n');
  }
  const compiled = transformSync(
    `
    export class Harness {
      ${OPTIONAL_PANEL_PROVIDER_STUBS}
      sessionQueryContext() { return undefined; }
      publishSessionQueryContext() {}
      failSessionLoading() {}
      noteSessionRead() {}
      titles = new Map(); carriedNames = new Map(); refreshGeneration = 1; metadataRevision = 0;
      commitRepositories = new CommitRepositories({ run: async () => null }, () => {});
      revision = ${derivedCacheFile ? 'null' : '{ size: 11, mtimeMs: 11, dev: 1, ino: 2 }'};
      codexMetas = { get() { return undefined; } };
      derivedCacheCheckpointState = { markChanged() {} };
      claudeChildReferenceEntries = new Map(); codexOpenings = null; threadNames = { names: new Map(), fullNames: new Map() };
      startupCache = {}; progressiveWorker; sessionNames; derivedCacheFile;
      constructor(run, sessionNames, derivedCacheFile) {
        this.progressiveWorker = { run }; this.sessionNames = sessionNames; this.derivedCacheFile = derivedCacheFile;
        ${restore}
      }
      revisionOf(session) { return this.revision ?? { size: session.size, mtimeMs: session.mtimeMs, dev: 1, ino: 2 }; }
      ${names}
      ${owner.members.find((member) => member.name?.getText(file) === 'storeTitleEntry')?.getText(file) ?? ''}
      ${drawing}
      ${method.getText(file)}
    }`,
    { loader: 'ts', format: 'cjs' },
  ).code;
  const module = { exports: {} as any };
  const scope = {
    CommitRepositories,
    INITIAL_RAIL_READ_BYTES,
    metadataReadBudget,
    sameSessionRevision,
    acceptsProgressiveResult,
    onlyGrew,
    carryDerivedTitleFacts,
    unreadHeadBytes,
    storedSessionName,
    withSessionName,
    transcriptIdentity,
    loadDerivedCache,
    saveDerivedCache,
    sessionLabelOf,
    codexTitleFor,
  };
  new Function('module', 'exports', ...Object.keys(scope), compiled)(module, module.exports, ...Object.values(scope));
  return guardedHarness(new module.exports.Harness(run, sessionNames, derivedCacheFile));
}

function selectedWindowHarness(
  run: (request: ProgressiveRequest, generation: number, signal: AbortSignal) => Promise<ProgressiveResult | null>,
  extra: string[] = [],
): any {
  const file = ts.createSourceFile(
    'panelhost.ts',
    fs.readFileSync(path.join(__dirname, 'panelhost.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const owner = file.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === 'PanelProvider',
  );
  assert.ok(owner);
  // spendVersion supplies revisions for keys built by the extracted methods.

  const names = new Set([
    'currentSelectedSession',
    'publishWindowState',
    'completeSelectedWindow',
    'commitRepositoryTurns',
    'commitRepositoryContexts',
    'applyCommitRepositoryEvidence',
    'carryCommitRepositories',
    'applyCommitRepositories',
    'agentFile',
    'hydrateCommitRepositories',
    'acceptExplicitMetadataRead',
    'storeTitleEntry',
    'acceptSelectedMetadataRead',
    'spendVersion',
    'updateHistoryAfterAcceptedWindow',
    'jointSplitWindow',
    'acceptJointSplitWindow',
    'refreshFrom',
    'refreshAs',
    'claimCatalogRefresh',
    'releaseCatalogRefresh',
    'scheduleDiscoveryContinuation',
    'continueDiscovery',
    ...extra,
    // evictCache calls pruneDerivedTitles.
    ...(extra.includes('evictCache') ? ['pruneDerivedTitles'] : []),
  ]);
  const body = owner.members
    .filter((member) => member.name && names.has(member.name.getText(file)))
    .map((member) => member.getText(file))
    .join('\n')
    .replace('} catch (error) {', '} catch (error) { this.lastError = error;');
  // The eviction harness refreshes all three selected sessions.

  const refreshBody = extra.includes('evictCache')
    ? `refresh() {
        this.refreshes++;
        const selected = (this.catalog ?? [this.session]).find((session) => session.sessionId === this.showing) ?? null;
        if (selected) { this.evictCache([selected], this.catalog ?? [this.session]); }
        const loadingNewest = selected ? !this.progressiveCurrent(selected) : false;
        this.refreshResults.push(newestTurnLoading(loadingNewest ? this.showing : null, true));
        return Promise.resolve();
      }`
    : `refresh() { this.refreshes++; const held = this.cache.get(this.session.file); if (held) this.published.push(held.revision); return Promise.resolve(); }`;
  const compiled = transformSync(
    `
    const TRANSCRIPT_TURN_LIMIT = 40; const TRANSCRIPT_TAIL_BYTES = 1024;
    export class Harness {
      ${OPTIONAL_PANEL_PROVIDER_STUBS}
      membershipOf(session) { return this.authoritativeCatalog.some((source) => source.sessionId === session) ? 'present' : 'absent'; }
      physicalMembershipOf(file) { return this.authoritativeCatalog.some((source) => source.file === file) ? 'present' : 'absent'; }
      sessionQueryContext() { return undefined; }
      publishSessionQueryContext() {}
      failSessionLoading() {}
      noteSessionRead() {}
      selectionGeneration = 1; refreshGeneration = 1; showing = 'selected'; selectionWork = null; selectionFailure = null;
      trail = { places: [], at: -1 };
      settleRailSeed() {}
      cache = new Map(); refreshes = 0; published = []; dropped = 0; lastError = null;
      commitRepositories = new CommitRepositories({ run: async () => null }, () => {});
      repositoryCommits = new RepositoryCommits({ run: async () => null }, () => {});
      history = new Map(); historyStructuralKeys = new Map(); structural = ''; historyRequest = null;
      session = { file: 'selected.jsonl', sessionId: 'selected', agent: 'claude', size: 10, mtimeMs: 10, dev: 1, ino: 2 };
      catalog = null; refreshResults = [];
      walkedClaude = []; titles = new Map(); carriedNames = new Map(); cwds = new Map(); humanScans = new Map(); claudeChildStatWrites = new Map();
      derivedCacheCheckpointState = { markChanged() {} };
      progressiveWorker;
      constructor(run) { this.progressiveWorker = { run }; }
      get authoritativeCatalog() { return Array.isArray(this.catalog) ? this.catalog : (this.catalog?.sessions ?? [this.session]); }
      revisionOf(session) { return { size: session.size, mtimeMs: session.mtimeMs, dev: session.dev, ino: session.ino }; }
      observeStoredName(_session, entry) { return entry; }
      observeStoredEntry() {}
      anyVisible() { return true; }
      progressiveCurrent(session) {
        const entry = this.cache.get(session.file);
        return !!entry && entry.key === transcriptReadCacheKey(session, 40, 1024, [])
          && sameProgressiveRevision(entry.revision, this.revisionOf(session));
      }
      structuralKey() { return this.structural; } historyAgentKey() { return this.structural; } agentSpendKey() { return ''; }
      progressiveInput(session) { return { session, folders: [], children: [], maxTurns: 40, tailBytes: 1024 }; }
      folders() { return []; }
      dropOlderHistory(sessionId) { this.dropped++; this.history.delete(sessionId); this.historyStructuralKeys.delete(sessionId); }
      abandonDraft() { return false; }
      protectedHistorySessions() { return new Set([this.showing]); }
      sessionCacheBudgetBytes() { return 16 * 1024 * 1024; }
      ${refreshBody}
      ${body}
    }`,
    { loader: 'ts', format: 'cjs' },
  ).code;
  const module = { exports: {} as any };
  new Function(
    'module',
    'exports',
    'createPanelVisibility',
    'sameSessionRevision',
    'transcriptReadCacheKey',
    'acceptsProgressiveResult',
    'sameProgressiveRevision',
    'preservesLoadedHistory',
    'historyStateAfterRevision',
    'retainDisplacedWindow',
    'historyRecordsOutside',
    'startSessionHistory',
    'onlyGrew',
    'historyBytes',
    'historyEvictions',
    'newestTurnLoading',
    'agentSpendIsOpen',
    'spendFileVersion',
    'claudeChildFileFor',
    'codexSubagentFor',
    'writeTimeOfVersion',
    'visitPlace',
    'agentSpendDependencyKey',
    'childSpendVersion',
    'claudeSubagentMetaReader',
    'codexAgentSpendVersion',
    'codexSpendIndex',
    'withMetadataCoverage',
    'CommitRepositories',
    'RepositoryCommits',
    'selectedDependencies',
    'claudeRelationshipKey',
    compiled,
  )(
    module,
    module.exports,
    createPanelVisibility,
    sameSessionRevision,
    transcriptReadCacheKey,
    acceptsProgressiveResult,
    sameProgressiveRevision,
    preservesLoadedHistory,
    historyStateAfterRevision,
    retainDisplacedWindow,
    historyRecordsOutside,
    startSessionHistory,
    onlyGrew,
    historyBytes,
    historyEvictions,
    newestTurnLoading,
    agentSpendIsOpen,
    spendFileVersion,
    claudeChildFileFor,
    codexSubagentFor,
    writeTimeOfVersion,
    visitPlace,
    agentSpendDependencyKey,
    childSpendVersion,
    claudeSubagentMetaReader,
    codexAgentSpendVersion,
    codexSpendIndex,
    withMetadataCoverage,
    CommitRepositories,
    RepositoryCommits,
    selectedDependencies,
    claudeRelationshipKey,
  );
  return guardedHarness(new module.exports.Harness(run));
}

function windowResult(
  generation: number,
  revision: { size: number; mtimeMs: number; dev: number; ino: number },
): ProgressiveResult {
  return {
    generation,
    revision,
    value: {
      kind: 'window',
      read: { turns: [], compactions: [], readBytes: revision.size, turnLimitReached: false },
      checkpoint: {} as ProgressiveCheckpoint,
      reset: false,
      appendFrom: null,
      readBytes: revision.size,
      retainedBytes: 1,
      checkpointBytes: 1,
      agentKey: '',
      structuralKey: '',
    },
  };
}

function selectedSourceFixture(agent: 'claude' | 'codex' = 'claude') {
  const root = tempDir('selected-opening-');
  const workspace = path.join(root, 'workspace');
  const worktree = path.join(root, 'registered');
  const projects = path.join(root, 'projects');
  const codex = path.join(root, 'codex');
  const sessionId = 'selected-native';
  const directory =
    agent === 'claude' ? path.join(projects, projectSlug(worktree)) : path.join(codex, '2026', '10', '04');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(
    directory,
    agent === 'claude' ? `${sessionId}.jsonl` : `rollout-2026-10-04-${sessionId}.jsonl`,
  );
  const opening = (id = sessionId, cwd = worktree) =>
    agent === 'claude'
      ? JSON.stringify({ type: 'user', sessionId: id, cwd, message: { content: 'Hello' } }) + '\n'
      : JSON.stringify({ type: 'session_meta', payload: { id, cwd } }) + '\n';
  fs.writeFileSync(file, opening());
  return { root, workspace, worktree, projects, codex, sessionId, file, opening };
}

test('selected transport excludes unrelated history while retaining nested cross-agent dependencies', () => {
  const unrelated = Array.from({ length: 10_000 }, (_, i) => ({
    threadId: `other-${i}`,
    parentThreadId: `other-parent-${i}`,
  })) as any[];
  const child = { threadId: 'child', parentThreadId: 'selected' } as any;
  const grandchild = { threadId: 'grandchild', parentThreadId: 'claude-child' } as any;
  const claude = { sessionId: 'claude-child', parentSessionId: 'child' } as any;
  const dispatch = { sessionId: 'dispatch', parentSessionId: 'grandchild', kind: 'dispatch' } as any;
  const small = selectedDependencies('selected', [child, grandchild], [claude], [dispatch]);
  const large = selectedDependencies('selected', [...unrelated, child, grandchild], [claude], [dispatch]);
  assert.deepEqual(large, small);
  assert.deepEqual(large.children, [child, grandchild]);
  assert.deepEqual(large.claudeChildren, [claude]);
  assert.deepEqual(large.claudeChildReferences, [dispatch]);
});

test('a restored session waits for the published catalog before it opens', async () => {
  for (const agent of ['claude', 'codex'] as const) {
    const fixture = selectedSourceFixture(agent);
    const provider = completeDiscoveryHarness(undefined, true, ['stateFor'], {
      projectsRoot: () => fixture.projects,
      codexSessionsRoot: () => fixture.codex,
    });
    provider.folders = () => [fixture.workspace];
    provider.repositoryScopeRoots = [fixture.workspace, fixture.worktree];
    provider.repositoryScope = { snapshot: () => ({ ready: true, roots: provider.repositoryScopeRoots, revision: 1 }) };
    provider._showing = fixture.sessionId;
    provider.hostSessions = new Map([[provider.hosts[0], fixture.sessionId]]);
    provider.discovery = new Promise(() => {});
    provider.revisionOf = (source: any) => {
      const stat = fs.statSync(source.file);
      return { size: stat.size, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino };
    };
    provider.progressiveCurrent = (source: any) => Boolean(provider.cache.get(source.file));
    let requests = 0;
    provider.progressiveWorker = {
      run: async (_request: ProgressiveRequest, generation: number) => {
        requests++;
        const result = windowResult(generation, provider.revisionOf({ file: fixture.file }));
        if (result.value.kind === 'window')
          result.value.read.turns = [
            turn({ sessionId: fixture.sessionId, summary: 'Recorded response\n\nSecond paragraph' }),
          ];
        return result;
      },
    };
    provider.collect = () => provider.cache.get(fixture.file)?.read.turns ?? [];
    const opened = () =>
      provider.messages.some((message: any) =>
        message.cards?.some((card: any) => card.summary === 'Recorded response\n\nSecond paragraph'),
      );

    // Discovery is pending, so the restored session is not read and nothing opens.
    await provider.completeSelectedWindow(fixture.sessionId, 0);
    assert.equal(requests, 0, 'a restored session was read before the catalog');
    assert.equal(opened(), false, 'a restored session opened before the catalog');

    // The published catalog lists the session, so it opens.
    provider.partial = [
      {
        file: fixture.file,
        sessionId: fixture.sessionId,
        agent,
        cwd: fixture.worktree,
        activity: 1,
        ...provider.revisionOf({ file: fixture.file }),
      },
    ];
    provider.catalog = { sessions: provider.partial };
    provider.discovery = Promise.resolve(true);
    await provider.refresh(true);
    assert.equal(provider.authoritativeCatalog.length, 1);
    await vi.waitFor(() => assert.ok(opened(), 'the restored session did not open after the catalog'));
    assert.equal(provider.showing, fixture.sessionId);
  }
});

test('an imported session waits for catalog publication after discovery completes', async () => {
  for (const agent of ['claude', 'codex'] as const) {
    const fixture = selectedSourceFixture(agent);
    const provider = completeDiscoveryHarness(undefined, true, ['progressiveCurrent'], {
      projectsRoot: () => fixture.projects,
      codexSessionsRoot: () => fixture.codex,
    });
    provider.folders = () => [fixture.workspace];
    provider.repositoryScopeRoots = [fixture.workspace, fixture.worktree];
    provider.repositoryScope = { snapshot: () => ({ ready: true, roots: provider.repositoryScopeRoots }) };
    provider._showing = fixture.sessionId;
    provider.hostSessions = new Map([[provider.hosts[0], fixture.sessionId]]);
    provider.authoritativeCatalog = [];
    provider.completeCatalogScope = JSON.stringify(provider.repositoryScopeRoots);
    provider.revisionOf = (source: any) => revisionOf(fs.statSync(source.file, { bigint: true }));
    provider.agentSpendKey = () => '';
    const requests: string[] = [];
    provider.progressiveWorker.run = async (request: ProgressiveRequest, generation: number) => {
      assert.equal(request.kind, 'window');
      if (request.kind !== 'window') return null;
      requests.push(request.input.session.sessionId);
      return windowResult(generation, provider.revisionOf(request.input.session));
    };
    await provider.completeSelectedWindow(fixture.sessionId, 0);
    assert.deepEqual(requests, [], 'an imported source opened outside the published catalog');
    assert.equal(provider.cache.has(fixture.file), false);
    assert.deepEqual(provider.awaitingSessionRecords, {}, 'an imported child became locally owned');
    await provider.refresh(true, true, true, true);
    assert.equal(
      provider.sessionRows.some((row: any) => row.id === fixture.sessionId),
      false,
    );

    const listed = {
      file: fixture.file,
      sessionId: fixture.sessionId,
      agent,
      cwd: fixture.worktree,
      activity: 1,
      ...provider.revisionOf({ file: fixture.file }),
    };
    provider.authoritativeCatalog = [listed];
    provider.catalog = { sessions: [listed] };
    provider._showing = fixture.sessionId;
    await provider.completeSelectedWindow(fixture.sessionId, 0);
    assert.deepEqual(requests, [fixture.sessionId]);
    assert.ok(provider.cache.has(fixture.file));
    assert.deepEqual(provider.awaitingSessionRecords, {});
  }
});

test('a slow selected read keeps its request until selection cancels it', async () => {
  vi.useFakeTimers();
  try {
    let finish!: (result: ProgressiveResult) => void;
    let requests = 0;
    const provider = selectedWindowHarness(() => {
      requests++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    }, ['show']);
    const progress = { accepted: ['historical-progress'] };
    provider.discoveryCheckpoint = progress;
    provider.refreshController = new AbortController();
    const pending = provider.completeSelectedWindow('selected', 1);
    const first = provider.selectionWork;
    await vi.advanceTimersByTimeAsync(30_000);
    assert.equal(first.controller.signal.aborted, false, 'elapsed time canceled a valid selected read');
    assert.equal(provider.selectionWork, first);
    assert.equal(requests, 1, 'elapsed time restarted a valid selected read');
    assert.equal(provider.discoveryCheckpoint, progress);
    assert.equal(provider.refreshController.signal.aborted, false);
    provider.catalog = { folders: '', sessions: [] };
    provider.show('other');
    assert.equal(first.controller.signal.aborted, true, 'switching kept an obsolete selected read');
    finish(windowResult(1, provider.revisionOf(provider.session)));
    await pending;
    assert.equal(provider.cache.size, 0, 'obsolete response replaced the new selection');
  } finally {
    vi.useRealTimers();
  }
});

test('selected delivery rejects changed host ownership and scope after the worker read', async () => {
  for (const change of ['host', 'scope'] as const) {
    const fixture = selectedSourceFixture();
    const provider = completeDiscoveryHarness(undefined, true, [], {
      projectsRoot: () => fixture.projects,
      codexSessionsRoot: () => fixture.codex,
    });
    provider.folders = () => [fixture.workspace];
    provider.repositoryScopeRoots = [fixture.workspace, fixture.worktree];
    provider.repositoryScope = { snapshot: () => ({ ready: true, roots: provider.repositoryScopeRoots }) };
    provider._showing = fixture.sessionId;
    provider.hostSessions = new Map([[provider.hosts[0], fixture.sessionId]]);
    const peer = { webview: {}, visible: () => true };
    provider.hosts.push(peer);
    provider.hostSessions.set(peer, 'peer-selected');
    provider.revisionOf = (source: any) => {
      const stat = fs.statSync(source.file);
      return { size: stat.size, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino };
    };
    let finish!: (result: ProgressiveResult) => void;
    provider.progressiveWorker = {
      run: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    };
    provider.authoritativeCatalog = [
      { file: fixture.file, sessionId: fixture.sessionId, agent: 'claude', cwd: fixture.worktree, activity: 1 },
    ];
    const pending = provider.completeSelectedWindow(fixture.sessionId, 0);
    await vi.waitFor(() => assert.ok(finish));
    if (change === 'host') provider.hostSessions.set(provider.hosts[0], 'another-selection');
    if (change === 'scope') provider.folders = () => [path.join(fixture.root, 'different-workspace')];
    finish(windowResult(0, provider.revisionOf({ file: fixture.file })));
    await pending;
    assert.equal(provider.cache.size, 0, `${change} change admitted obsolete content`);
    assert.ok(provider.messages.every((message: any) => !message.cards?.length));
  }
});

async function selectedPublicationFixture(
  evidence: 'changed' | 'unchanged' | 'absent' | 'recovery',
  scope: Record<string, unknown> = {},
  oldHasCommits = false,
) {
  const directory = tempDir('selected-publication-');
  const childFile = path.join(directory, 'child.jsonl');
  fs.writeFileSync(childFile, 'child record');
  const provider = completeDiscoveryHarness(undefined, true, ['readFor', 'sendToHost'], {
    codexSpendIndex,
    codexSubagentFor,
    commitRepositorySourceKey,
    COMMIT_REPOSITORY_PARSER_VERSION,
    commitRepositoryOccurrence,
    toCard,
    commitRowsOf,
    turnKey,
    ...scope,
  });
  const now = Date.now();
  const session = {
    file: path.join(directory, 'parent.jsonl'),
    sessionId: 'selected',
    agent: 'codex',
    size: 10,
    mtimeMs: 1,
    dev: 1,
    ino: 2,
  };
  fs.writeFileSync(session.file, 'parent record');
  provider._showing = session.sessionId;
  provider.hostSessions = new Map([[provider.hosts[0], session.sessionId]]);
  provider.partial = [
    session,
    ...Array.from({ length: 999 }, (_, i) => ({ ...session, file: `other-${i}.jsonl`, sessionId: `other-${i}` })),
  ];
  provider.authoritativeCatalog = provider.partial;
  provider.codexSubagents = [
    {
      threadId: 'child',
      parentThreadId: session.sessionId,
      file: childFile,
      agentPath: '/root/child',
      backgroundReview: false,
    },
  ];
  provider.commitRepositoryReplies = new Map();
  provider.commitRepositoryReservations = new CommitRepositoryReservations();
  provider.agentSpendKey = () => '';
  provider.progressiveCurrent = (source: SessionFile) => provider.cache.get(source.file)?.revision.size === source.size;
  const repositories = new RepositoryCommits({ run: async () => null }, () => {});
  provider.repositoryCommits = repositories;
  const repo = repositories as any;
  repositories.apply([], provider.folders());
  await repo.work;
  const destination = path.join(directory, 'verified');
  const key = `candidates|exact|abc1234|${[destination, 'project'].map(normalizeFsPath).sort().join('|')}`;
  repo.exactAnswers.set(key, { dir: destination });
  repo.identities.set(normalizeFsPath('project'), { commonDir: null, gitDir: null, root: null });
  repo.identities.set(normalizeFsPath(destination), { commonDir: destination, gitDir: destination, root: destination });
  const commit = {
    sha: 'abc1234',
    printedSha: 'abc1234',
    subject: 'Selected work',
    at: now - 100,
    dir: 'unproved',
    place: { kind: 'other', name: 'Unproved' },
    repository: { key: 'unproved', name: 'Unproved', own: false },
    repositoryEvidence: { complete: true, at: now - 100, dirs: ['unproved'], turnId: 'selected-turn' },
  } as any;
  const old = turn({
    agent: 'codex',
    sessionId: session.sessionId,
    startedAt: now - TURN_QUIET_MS - 2000,
    endedAt: now - TURN_QUIET_MS - 1000,
    finished: false,
    summary: '',
    promptId: 'same-prompt',
    contextTokens: 212319,
    agents: oldHasCommits
      ? [subagent({ id: 'child', commits: [{ ...commit, dir: null, place: null, repository: null }] })]
      : [],
  });
  const newest = turn({
    ...old,
    endedAt: now - 100,
    contextTokens: 166396,
    summary: 'Current response '.repeat(16000),
    agents: evidence === 'absent' ? [] : [subagent({ id: 'child', commits: [commit] })],
  });
  const revision = { size: session.size, mtimeMs: session.mtimeMs, dev: session.dev, ino: session.ino };
  provider.cache.set(session.file, {
    key: '',
    structuralKey: '',
    agentKey: '',
    revision,
    read: { turns: [old], compactions: [], readBytes: 10, turnLimitReached: false },
  });
  provider.collect = (sources: SessionFile[]) => {
    provider.collectedAt = now;
    return sources.flatMap((source) =>
      provider.readFor(source, 40, 1024).read.turns.map((value: any) => toCard(value, true, now, provider.folders())),
    );
  };
  provider.useRailPayload(railPayload);
  const bytes: number[] = [];
  const post = provider.hosts[0].webview.postMessage;
  provider.hosts[0].webview.postMessage = (message: any) => {
    const size = serializedMessageBytes(message);
    assert.notEqual(size, null);
    bytes.push(size!);
    if (evidence === 'recovery' && message.cards?.[0]?.status === 'running') provider.anyVisible = () => false;
    return post(message);
  };
  await provider.refresh(true, true, true, true);
  const first = provider.messages.at(-1).cards[0];
  assert.equal(first.status, 'stopped');
  assert.equal(isTurnRead(first, new Set(), new Map()), false);
  provider.messages.length = 0;
  bytes.length = 0;
  session.size += 1;
  session.mtimeMs += 1;
  let finish!: () => void;
  let started!: () => void;
  const hydrationStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let hydrationRequests = 0;
  provider.progressiveWorker = {
    run: async (request: ProgressiveRequest, generation: number) => {
      if (request.kind === 'window') {
        const result = windowResult(generation, { ...session });
        if (result.value.kind === 'window') {
          result.value.read.turns = [newest];
          result.value.recoveryPending = evidence === 'recovery';
        }
        return result;
      }
      assert.equal(request.kind, 'commit-repositories');
      hydrationRequests++;
      started();
      return new Promise<ProgressiveResult>((resolve) => {
        finish = () =>
          resolve({
            generation,
            revision: null,
            value: {
              kind: 'commit-repositories',
              parent: request.parent,
              child: request.child,
              parserVersion: request.parserVersion,
              status: 'complete',
              readBytes: { parent: 0, child: 0 },
              covered: { parent: [0, request.parent.revision.size], child: [0, request.child.revision.size] },
              token: null,
              targets:
                evidence === 'changed'
                  ? [
                      {
                        sha: 'abc1234',
                        occurrence: commitRepositoryOccurrence(request.commits[0]),
                        dirs: [destination],
                      },
                    ]
                  : [],
            },
          });
      });
    },
  };
  return {
    provider,
    first,
    newest,
    session,
    commit,
    bytes,
    get hydrationStarted() {
      return raceHarnessFault(provider, hydrationStarted);
    },
    finish: () => finish(),
    hydrationRequests: () => hydrationRequests,
  };
}

test('accepted unread same-turn facts publish before repository hydration', async () => {
  const fixture = await selectedPublicationFixture('changed');
  const { provider, first, newest, commit } = fixture;
  const pending = provider.completeSelectedWindow('selected', 0);
  await fixture.hydrationStarted;
  const card = provider.messages.at(-1)?.cards[0];
  assert.ok(card, 'the accepted unread turn waited for repository hydration');
  assert.equal(card.status, 'running');
  assert.equal(card.key, first.key);
  assert.equal(card.promptId, first.promptId);
  assert.equal(card.promptId, 'same-prompt');
  assert.equal(newest.contextTokens, 166396);
  assert.equal(card.summary, newest.summary);
  assert.equal(isTurnRead(card, new Set(), new Map()), false);
  assert.equal(commit.candidates.complete, false);
  assert.equal(commit.dir, null);
  assert.equal(commit.place, null);
  assert.equal(commit.repository, null);
  assert.equal(card.commits[0].dir, null);
  assert.equal(provider.messages.length, 1);
  fixture.finish();
  await pending;
  assert.equal(provider.messages.length, 2);
  assert.ok(provider.messages.at(-1).cards[0].commits[0].dir);
  assert.equal(fixture.bytes.length, 2);
});

test('a completed response appended during repository hydration publishes without another poll', async () => {
  for (const cached of [false, true]) {
    const fixture = await selectedPublicationFixture('changed', {}, cached);
    const { provider, session } = fixture;
    if (cached) provider.cache.get(session.file).revision = { ...provider.revisionOf(session) };
    const pending = provider.completeSelectedWindow('selected', 0);
    await fixture.hydrationStarted;
    const completed = { ...fixture.newest, summary: 'The **completed response** includes `rich-code`.', agents: [] };
    session.size++;
    session.mtimeMs++;
    let reads = 0;
    provider.progressiveWorker.run = async (request: ProgressiveRequest, generation: number) => {
      assert.equal(request.kind, 'window');
      reads++;
      const result = windowResult(generation, { ...session });
      assert.equal(result.value.kind, 'window');
      if (result.value.kind === 'window') result.value.read.turns = [completed];
      return result;
    };
    await provider.completeSelectedWindow('selected', 0);
    assert.equal(reads, 0, 'the completed response replaced an active selected read');
    fixture.finish();
    await pending;
    await vi.waitFor(() =>
      assert.equal(
        provider.messages.at(-1)?.cards[0]?.summary === completed.summary,
        true,
        'the completed response waited for another poll',
      ),
    );
    assert.equal(reads, 1, 'the appended response did not receive one replacement read');
    await vi.waitFor(() => assert.equal(provider.selectionWork, null));
  }
});

test('selected publication suppresses unchanged and obsolete repository enrichment', async () => {
  for (const outcome of [
    'unchanged',
    'absent',
    'recovery',
    'selection',
    'scope',
    'hidden',
    'cancelled',
    'revision',
    'published',
  ] as const) {
    const evidence = outcome === 'absent' || outcome === 'recovery' || outcome === 'unchanged' ? outcome : 'changed';
    const fixture = await selectedPublicationFixture(evidence);
    const { provider } = fixture;
    const pending = provider.completeSelectedWindow('selected', 0);
    if (evidence === 'absent' || evidence === 'recovery') {
      await pending;
      assert.equal(fixture.hydrationRequests(), 0, outcome);
    } else {
      await fixture.hydrationStarted;
      assert.equal(provider.messages.length, 1, outcome);
      if (outcome === 'selection') provider.hostSessions.set(provider.hosts[0], 'another');
      if (outcome === 'scope') provider.repositoryScopeRoots = ['another'];
      if (outcome === 'hidden') provider.anyVisible = () => false;
      if (outcome === 'cancelled') provider.selectionWork.controller.abort();
      if (outcome === 'revision') fixture.session.size++;
      if (outcome === 'published') {
        const context = provider.commitRepositoryContexts(fixture.session, [fixture.newest])[0];
        provider.commitRepositoryReplies.set(context.child.file, {
          key: context.key,
          reply: {
            status: 'complete',
            targets: [
              {
                sha: 'abc1234',
                occurrence: commitRepositoryOccurrence(context.wanted[0]),
                dirs: [path.join(path.dirname(fixture.session.file), 'verified')],
              },
            ],
          },
        });
        await provider.refresh(true, true, true, true);
        assert.ok(provider.messages.at(-1).cards[0].commits[0].dir);
      }
      fixture.finish();
      await pending;
    }
    assert.equal(
      provider.messages.length,
      outcome === 'published' ? 2 : 1,
      `${outcome} repeated the selected publication`,
    );
    assert.equal(fixture.bytes.length, outcome === 'published' ? 2 : 1, outcome);
  }
});

test('selected enrichment retries an owning panel after rejected independent delivery', async () => {
  for (const failure of ['false', 'rejection'] as const) {
    for (const peerAccepted of [false, true]) {
      const fixture = await selectedPublicationFixture('changed');
      const { provider } = fixture;
      const owner = provider.hosts[0];
      const peer = { webview: { postMessage: () => Promise.resolve(true) }, active: () => false, visible: () => true };
      if (peerAccepted) {
        provider.hosts.push(peer);
        provider.readyHosts.add(peer);
        provider.hostSessions.set(peer, fixture.session.sessionId);
      }
      const pending = provider.completeSelectedWindow('selected', 0);
      await fixture.hydrationStarted;
      const context = provider.commitRepositoryContexts(fixture.session, [fixture.newest])[0];
      provider.commitRepositoryReplies.set(context.child.file, {
        key: context.key,
        reply: {
          status: 'complete',
          targets: [
            {
              sha: 'abc1234',
              occurrence: commitRepositoryOccurrence(context.wanted[0]),
              dirs: [path.join(path.dirname(fixture.session.file), 'verified')],
            },
          ],
        },
      });
      const post = owner.webview.postMessage;
      let attempts = 0;
      let reject = true;
      owner.webview.postMessage = (message: any) => {
        attempts++;
        return reject
          ? failure === 'false'
            ? Promise.resolve(false)
            : Promise.reject(new Error('delivery failed'))
          : post(message);
      };
      await provider.refresh(true, true, true, true);
      await vi.waitFor(() => assert.equal(attempts, 1));
      assert.equal(provider.messages.at(-1).cards[0].commits[0].dir, null);
      assert.ok(provider.cards[0].commits[0].dir);
      if (peerAccepted)
        await vi.waitFor(() => assert.ok(provider.rowSender(peer).acceptedCards.get(fixture.first.key)[0].dir));
      reject = false;
      fixture.finish();
      await pending;
      await vi.waitFor(() =>
        assert.ok(
          provider.messages.at(-1).cards[0].commits[0].dir,
          'rejected independent delivery consumed commit navigation',
        ),
      );
      assert.equal(
        attempts,
        2,
        `${failure} consumed the owning panel's enrichment with peer acceptance ${peerAccepted}`,
      );
    }
  }
});

test.each([
  ['false', false],
  ['false', true],
  ['rejection', false],
  ['rejection', true],
] as const)(
  'selected enrichment retries current same-turn facts after %s early owner delivery with peer %s',
  async (failure, peerAccepted) => {
    const fixture = await selectedPublicationFixture('unchanged', {}, true);
    const { provider, first, newest } = fixture;
    const owner = provider.hosts[0];
    const peerMessages: any[] = [];
    const peer = {
      webview: {
        postMessage: (message: any) => {
          peerMessages.push(message);
          return Promise.resolve(true);
        },
      },
      active: () => false,
      visible: () => true,
    };
    if (peerAccepted) {
      provider.hosts.push(peer);
      provider.readyHosts.add(peer);
      provider.hostSessions.set(peer, fixture.session.sessionId);
    }
    const post = owner.webview.postMessage;
    let attempts = 0;
    let reject = true;
    owner.webview.postMessage = (message: any) => {
      attempts++;
      return reject
        ? failure === 'false'
          ? Promise.resolve(false)
          : Promise.reject(new Error('delivery failed'))
        : post(message);
    };
    const pending = provider.completeSelectedWindow('selected', 0);
    await fixture.hydrationStarted;
    await vi.waitFor(() => assert.equal(attempts, 1));
    assert.equal(provider.messages.length, 0, 'the owner accepted the failed early post');
    assert.deepEqual(provider.rowSender(owner).acceptedCards.get(first.key), provider.cards[0].commits);
    if (peerAccepted) {
      await vi.waitFor(() => assert.equal(peerMessages.at(-1)?.cards[0].summary, newest.summary));
      assert.equal(peerMessages.at(-1).cards[0].status, 'running');
    }
    reject = false;
    fixture.finish();
    await pending;
    await vi.waitFor(() =>
      assert.equal(
        provider.messages.at(-1)?.cards[0].summary,
        newest.summary,
        'failed early delivery lost current same-turn response',
      ),
    );
    const delivered = provider.messages.at(-1).cards[0];
    assert.equal(delivered.status, 'running');
    assert.equal(delivered.key, first.key);
    assert.equal(delivered.promptId, first.promptId);
    assert.equal(isTurnRead(delivered, new Set(), new Map()), false);
    assert.deepEqual(delivered.commits, first.commits, 'the fixture changed commit rows');
    assert.equal(attempts, 2, `${failure} failed to retry owner with peer acceptance ${peerAccepted}`);
  },
);

test('unchanged selected enrichment indexes retained history and projects only commit rows', async () => {
  for (const count of [1000, 10000]) {
    let keyReads = 0;
    let projections = 0;
    let fullCards = 0;
    const fixture = await selectedPublicationFixture('unchanged', {
      commitRowsOf: (...args: Parameters<typeof commitRowsOf>) => {
        projections++;
        return commitRowsOf(...args);
      },
      toCard: (...args: Parameters<typeof toCard>) => {
        fullCards++;
        return toCard(...args);
      },
    });
    const { provider } = fixture;
    const pending = provider.completeSelectedWindow('selected', 0);
    await fixture.hydrationStarted;
    const retained = Array.from({ length: count - 1 }, (_, i) =>
      turn({ sessionId: 'selected', startedAt: i + 1, endedAt: i + 2, promptId: `retained-${i}` }),
    );
    provider.history.set('selected', { pages: [{ turns: retained, compactions: [] }] });
    const all = [fixture.newest, ...retained];
    const cards = all.map((value) => ({
      get key() {
        keyReads++;
        return turnKey(value);
      },
      commits: commitRowsOf(value, provider.collectedAt, provider.folders()).rows,
    }));
    provider.collect = () => cards;
    await provider.refresh(true, true, true, true);
    keyReads = projections = fullCards = 0;
    fixture.finish();
    await pending;
    assert.equal(provider.messages.length, 2, 'unchanged retained commit rows added a publication');
    assert.ok(keyReads <= count * 2, `${count} retained turns performed ${keyReads} card key reads`);
    assert.equal(projections, count, 'retained turns did not use the shared commit-row projection');
    assert.equal(fullCards, 0, 'commit comparison projected response, activity, and file content');
  }
});

test('two visible hosts accept their own concurrent selected windows while a later discovery pass is held', async () => {
  const fixture = selectedSourceFixture();
  const secondId = 'second-native';
  const secondFile = path.join(path.dirname(fixture.file), `${secondId}.jsonl`);
  fs.writeFileSync(secondFile, fixture.opening(secondId));
  const provider = completeDiscoveryHarness(undefined, true, ['progressiveCurrent'], {
    projectsRoot: () => fixture.projects,
    codexSessionsRoot: () => fixture.codex,
  });
  provider.folders = () => [fixture.workspace];
  provider.repositoryScopeRoots = [fixture.workspace, fixture.worktree];
  provider.repositoryScope = { snapshot: () => ({ ready: true, roots: provider.repositoryScopeRoots }) };
  provider.selectionWorks = new Map();
  provider.progressiveCurrent = (source: SessionFile) => Boolean(provider.cache.get(source.file));
  const peer = { webview: {}, visible: () => true };
  provider.hosts.push(peer);
  provider.hostSessions = new Map([
    [provider.hosts[0], fixture.sessionId],
    [peer, secondId],
  ]);
  provider._showing = secondId;
  provider.revisionOf = (source: any) => {
    const stat = fs.statSync(source.file);
    return { size: stat.size, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino };
  };
  const completions = new Map<string, () => void>();
  provider.progressiveWorker = {
    run: (request: any, generation: number) =>
      new Promise((resolve) => {
        completions.set(request.input.session.sessionId, () =>
          resolve(windowResult(generation, provider.revisionOf(request.input.session))),
        );
      }),
  };
  provider.authoritativeCatalog = [
    {
      file: fixture.file,
      sessionId: fixture.sessionId,
      agent: 'claude',
      cwd: fixture.worktree,
      activity: 2,
      ...provider.revisionOf({ file: fixture.file }),
    },
    {
      file: secondFile,
      sessionId: secondId,
      agent: 'claude',
      cwd: fixture.worktree,
      activity: 1,
      ...provider.revisionOf({ file: secondFile }),
    },
  ];
  provider.dispatchDiscoveryPending = true;
  const first = provider.completeSelectedWindow(fixture.sessionId, 0);
  const second = provider.completeSelectedWindow(secondId, 0);
  await vi.waitFor(() => assert.equal(completions.size, 2));
  assert.equal(provider.selectionWorks.get(fixture.sessionId).controller.signal.aborted, false);
  completions.get(fixture.sessionId)!();
  await first;
  assert.ok(provider.cache.has(fixture.file));
  assert.equal(provider.selectionWorks.get(secondId).controller.signal.aborted, false);
  completions.get(secondId)!();
  await second;
  assert.ok(provider.cache.has(secondFile));
  assert.equal(provider.selectionWorks.size, 0);
});

function loadedHistory(revision: { size: number; mtimeMs: number }, pages: any[]): any {
  return {
    sessionId: 'selected',
    size: revision.size,
    mtimeMs: revision.mtimeMs,
    pages,
    cursor: null,
    atBeginning: false,
    coverage: null,
    scanTailTurnKeys: [],
    requests: 1,
    emptyRuns: 0,
    failed: false,
    usedAt: 1,
  };
}

test('a completed Codex response stays on the selected timeline after later turns push it out of the tail', async () => {
  const first = turn({
    agent: 'codex',
    sessionId: 'selected',
    startedAt: 10,
    prompt: 'First prompt',
    summary: 'First response',
  });
  const second = turn({
    agent: 'codex',
    sessionId: 'selected',
    startedAt: 20,
    prompt: 'Second prompt',
    summary: 'Second response',
  });
  const third = turn({
    agent: 'codex',
    sessionId: 'selected',
    startedAt: 30,
    prompt: 'Third prompt',
    summary: 'Third response',
  });
  const compacted = compaction({ sessionId: 'selected', at: 15 });
  const priorRevision = { size: 10, mtimeMs: 10, dev: 1, ino: 2 };
  let provider: any;
  provider = selectedWindowHarness(async (request, generation) => {
    const revision = provider.revisionOf(provider.session);
    if (request.kind === 'retained') {
      return { generation, revision, value: { kind: 'retained', pages: request.pages } };
    }
    assert.equal(request.kind, 'window');
    const result = windowResult(generation, revision);
    assert.equal(result.value.kind, 'window');
    result.value.appendFrom = { ...revision, size: revision.size - 10, mtimeMs: revision.mtimeMs - 10 };
    result.value.read = {
      turns: [revision.size === 20 ? second : third],
      compactions: [],
      readBytes: 4 * 1024 * 1024,
      turnLimitReached: false,
    };
    return result;
  });
  provider.session = { ...provider.session, agent: 'codex' };
  provider.cache.set('selected.jsonl', {
    key: 'previous',
    agentKey: '',
    structuralKey: '',
    revision: priorRevision,
    read: { turns: [first], compactions: [compacted], readBytes: 4 * 1024 * 1024, turnLimitReached: false },
    checkpoint: {} as ProgressiveCheckpoint,
    bytes: 100,
    checkpointBytes: 1,
  });

  for (const size of [20, 30]) {
    provider.session = { ...provider.session, size, mtimeMs: size };
    await provider.completeSelectedWindow('selected', 1);
    const tail = provider.cache.get('selected.jsonl').read;
    const older = historyRecordsOutside(provider.history.get('selected')?.pages ?? [], tail);
    const cards = [...tail.turns, ...older.turns]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((entry, index) => toCard(entry, index === 0, 40));
    assert.deepEqual(
      cards.map((card) => card.summary),
      size === 20 ? ['Second response', 'First response'] : ['Third response', 'Second response', 'First response'],
      'a completed response disappeared when a later turn exceeded the tail window',
    );
    assert.equal(older.compactions.length, 1, 'the compaction boundary disappeared with the preceding response');
  }
});

// Stopping polling clears rollout stats because hidden panels receive no watcher updates.

test('stopping the poll drops the rollout stats the panel held', () => {
  const provider = harness(false, true, ['stopPolling']);
  const file = 'rollout.jsonl';
  let stats = 0;
  // Written long before now, so the cache holds its answer instead of reading every listing.
  provider.codexStats = new CodexStatCache(
    () => {
      stats++;
      return { mtimeMs: 0, size: stats, isFile: true };
    },
    () => 100 * 60_000,
  );
  assert.deepEqual(
    [provider.codexStats.get(file)?.size, provider.codexStats.get(file)?.size],
    [1, 1],
    'the cache reads the rollout on every listing, so stopping the poll has nothing to drop',
  );

  provider.stopPolling();
  assert.equal(
    provider.codexStats.get(file)?.size,
    2,
    'a panel hidden before its first watcher opens keeps rollout stats nobody reports on',
  );
});

test('attachment and disposal before readiness perform no session or optional startup work', () => {
  const provider = harness();
  const panel = host();
  provider.attach(panel);
  panel.changeVisibility();
  assert.deepEqual([provider.reads, provider.polls, provider.usageRequests.length], [0, 0, 0]);
  panel.dispose();
  panel.ready();
  assert.deepEqual([provider.reads, provider.polls, provider.usageRequests.length], [0, 0, 0]);
});

test('a visible ready host holds one initial catalog refresh until its handler registers', () => {
  const provider = harness(false, false);
  const first = host(true);
  const second = host();
  provider.attach(first);
  provider.attach(second);
  second.ready();
  assert.deepEqual(provider.usageRequests, []);
  provider.setRefreshUsageHandler((agent: string | null, force: boolean) => {
    provider.usageRequests.push([agent, force]);
  });
  assert.deepEqual(provider.usageRequests, [[null, false]]);
});

test('cold startup carries the selected existing session into MCP discovery', () => {
  const provider = harness(false, false);
  const panel = host();
  provider.attach(panel);
  panel.ready();
  provider.setRefreshUsageHandler(
    (agent: string | null, force: boolean, owner?: string, ownerAgent?: string, ownerCwd?: string) => {
      provider.usageRequests.push([agent, force, owner, ownerAgent, ownerCwd]);
    },
  );
  assert.deepEqual(provider.usageRequests, [[null, false, 'selected', 'claude', 'D:/selected-worktree']]);
});

test('cold startup reads catalogs before the restored session row arrives', () => {
  const provider = harness(false, false);
  provider.sessionRows = [];
  provider.setRefreshUsageHandler((...request: unknown[]) => provider.usageRequests.push(request));
  const panel = host();
  provider.attach(panel);
  panel.ready();
  provider.drainInitialCatalogRefresh();
  assert.deepEqual(provider.usageRequests, [[null, false]]);
  assert.equal(provider.initialCatalogRefreshPending, true);
  provider.sessionRows = [{ id: 'selected', agentKey: 'claude' }];
  provider.drainInitialCatalogRefresh();
  provider.drainInitialCatalogRefresh();
  assert.deepEqual(provider.usageRequests, [
    [null, false],
    [null, false, 'selected', 'claude', 'D:/selected-worktree'],
  ]);
  assert.equal(provider.initialCatalogRefreshPending, false);
});

test('a hidden ready host waits until it becomes visible before requesting the catalog', () => {
  const provider = harness();
  const panel = host(false, false);
  provider.attach(panel);
  panel.ready();
  assert.deepEqual(provider.usageRequests, []);
  panel.changeVisibility();
  assert.deepEqual(provider.usageRequests, [[null, false]]);
});

test('visible ready hosts share one initial catalog refresh and ignore duplicate ready messages', () => {
  const provider = harness();
  const first = host(true);
  const second = host();
  provider.attach(first);
  provider.attach(second);
  second.ready();
  first.ready();
  second.ready();
  assert.deepEqual(provider.usageRequests, [[null, false]]);
});

test('returning to a visible panel retries the selected owner after an unanswered discovery', () => {
  const provider = harness(false, false);
  provider.setRefreshUsageHandler(
    (agent: string | null, force: boolean, owner?: string, ownerAgent?: string, ownerCwd?: string) =>
      provider.usageRequests.push([agent, force, owner, ownerAgent, ownerCwd]),
  );
  const panel = host();
  provider.attach(panel);
  panel.ready();
  panel.changeVisibility(false);
  panel.changeVisibility(true);

  assert.deepEqual(
    provider.usageRequests,
    [
      [null, false, 'selected', 'claude', 'D:/selected-worktree'],
      [null, false, 'selected', 'claude', 'D:/selected-worktree'],
    ],
    'the reopen lost the selected owner or the startup gate blocked its retry',
  );
});

test('reopening the last closed panel retries the selected owner', () => {
  const provider = harness(false, false);
  provider.setRefreshUsageHandler(
    (agent: string | null, force: boolean, owner?: string, ownerAgent?: string, ownerCwd?: string) =>
      provider.usageRequests.push([agent, force, owner, ownerAgent, ownerCwd]),
  );
  const first = host();
  provider.attach(first);
  first.ready();
  first.dispose();
  const reopened = host();
  provider.attach(reopened);
  reopened.ready();

  assert.deepEqual(
    provider.usageRequests,
    [
      [null, false, 'selected', 'claude', 'D:/selected-worktree'],
      [null, false, 'selected', 'claude', 'D:/selected-worktree'],
    ],
    'the reopened panel kept the old one-shot gate and did not retry the selected owner',
  );
});

test('disposing a ready host before handler registration clears its catalog demand', () => {
  const provider = harness(false, false);
  const panel = host(true);
  provider.attach(panel);
  panel.dispose();
  provider.setRefreshUsageHandler((agent: string | null, force: boolean) => {
    provider.usageRequests.push([agent, force]);
  });
  assert.deepEqual(provider.usageRequests, []);
});

// Listing coverage must survive a transcript that grows between a complete discovery reply and catalog publication.
test('a refresh stamps the published membership when a source grew after its complete discovery reply', async () => {
  const answered = {
    file: 'grown.jsonl',
    sessionId: 'grown',
    agent: 'claude',
    activity: 1,
    size: 10,
    mtimeMs: 1,
    dev: '7',
    ino: '9',
  };
  const provider = completeDiscoveryHarness();
  provider.partial = [{ ...answered, size: 20, mtimeMs: 2 }];
  provider.catalog = { sessions: provider.partial };
  provider.discovery = Promise.resolve(true);
  provider.prepareClaudeChildren = function (this: any) {
    this.discoveryComplete = {
      scope: JSON.stringify(this.repositoryScopeRoots),
      files: new Set([answered.file]),
      revisions: new Map([[answered.file, answered]]),
    };
    return this.discovery;
  };
  await provider.refresh(true);
  const published = provider.authoritativeCatalog;
  assert.deepEqual(
    published.map((source: any) => [source.size, source.dev, source.ino]),
    [[20, '7', '9']],
  );
  assert.equal(
    provider.sessionReadDiscoveryRevision,
    sessionCatalogMembership(JSON.stringify(provider.repositoryScopeRoots), published),
  );
});

for (const route of ['reused', 'targeted', 'full walk'] as const) {
  for (const replaced of ['Claude child', 'Codex rollout'] as const) {
    test(`a ${route} catalog refresh replaces an unselected ${replaced}`, async () => {
      const directory = tempDir('catalog-held-identities-');
      const fixed = new Date('2026-08-25T12:00:00Z');
      const childFile = path.join(directory, 'agent-child.jsonl');
      const rollout = path.join(directory, 'rollout.jsonl');
      for (const file of [childFile, rollout]) {
        fs.writeFileSync(file, 'original\n');
        fs.utimesSync(file, fixed, fixed);
      }
      const children = new ClaudeChildSessionCache(() => directory);
      const reference = { file: childFile, parentSessionId: 'parent', sessionId: 'child', toolUseIds: [] };
      const child = children.read(reference, [directory])!;
      const stats = new CodexStatCache(undefined, () => fixed.getTime() + 24 * 60 * 60_000);
      const codex = {
        ...stats.get(rollout)!,
        file: rollout,
        sessionId: 'codex',
        agent: 'codex',
        cwd: directory,
        activity: 1,
      };
      const parent = { ...codex, file: 'parent.jsonl', sessionId: 'parent', agent: 'claude' };
      const otherParent = { ...parent, file: 'other-parent.jsonl', sessionId: 'other-parent' };
      const checked: string[] = [];
      const stat = async (file: string) => {
        checked.push(file);
        return file === parent.file || file === otherParent.file
          ? parent
          : revisionOf(await fs.promises.stat(file, { bigint: true }));
      };
      const provider = completeDiscoveryHarness(undefined, false, [], {
        replacedCatalogFiles: (sources: any[], signal: AbortSignal) => replacedCatalogFiles(sources, signal, stat),
        path,
      });
      provider.repositoryScopeRoots = [directory];
      provider.showing = parent.sessionId;
      provider.catalogWalked = route === 'full walk';
      provider.targetedRefreshPaths = route === 'targeted' ? [parent.file] : null;
      provider.partial = [parent, otherParent, child, codex];
      provider.catalog = { sessions: provider.partial };
      provider.authoritativeCatalog = provider.partial;
      const oldMembership = sessionCatalogMembership(JSON.stringify([directory]), provider.partial);
      provider.sessionReadDiscoveryRevision = oldMembership;
      provider.codexStats = stats;
      let walks = 0;
      provider.allSessions = (reuse: boolean) => {
        if (reuse) return provider.catalog.sessions;
        walks++;
        provider.catalog = { sessions: [parent, otherParent, child, { ...codex, ...stats.get(rollout)! }] };
        return provider.catalog.sessions;
      };
      let discoveries = 0;
      provider.prepareClaudeChildren = function (this: any) {
        discoveries++;
        const sessions = this.catalog.sessions.map((source: any) =>
          source.file === childFile ? children.read(reference, [directory])! : source,
        );
        this.catalog = { sessions };
        this.discoveryComplete = {
          scope: JSON.stringify([directory]),
          files: new Set(sessions.map((source: any) => source.file)),
          revisions: new Map(sessions.map((source: any) => [source.file, source])),
        };
        return Promise.resolve(true);
      };
      const changedFile = replaced === 'Claude child' ? childFile : rollout;
      for (const file of [changedFile]) {
        const replacement = file + '.next';
        fs.writeFileSync(replacement, 'replaced\n');
        fs.utimesSync(replacement, fixed, fixed);
        fs.renameSync(replacement, file);
      }
      assert.equal(stats.get(rollout)?.ino, codex.ino, 'the inactive cache did not retain the original identity');
      await provider.refresh(false, route !== 'full walk');
      for (const held of [child, codex]) {
        const published = provider.authoritativeCatalog.find((source: any) => source.file === held.file);
        if (held.file === changedFile) {
          assert.notEqual(published.ino, held.ino, 'the published catalog retained a replaced identity');
        } else {
          assert.equal(published.ino, held.ino, 'the unchanged source lost its identity');
        }
        assert.equal(published.size, held.size);
        assert.equal(published.mtimeMs, held.mtimeMs);
      }
      assert.notEqual(provider.sessionReadDiscoveryRevision, oldMembership);
      assert.ok(checked.includes(childFile), 'the refresh omitted the held child identity');
      assert.ok(checked.includes(rollout), 'the refresh omitted the cached Codex identity');
      assert.equal(walks, route === 'full walk' ? 2 : 1);
      assert.equal(checked.includes(parent.file), false, 'the refresh repeated the checked parent identity');
      assert.equal(
        checked.includes(otherParent.file),
        route !== 'full walk',
        'the refresh omitted an unchecked parent identity',
      );
      assert.equal(discoveries, 1, 'catalog reuse skipped child discovery after replacement');
    });
  }
}

test('a carried discovery reply after removal clears listing coverage while completing the loading line', async () => {
  const surviving = {
    file: 'surviving.jsonl',
    sessionId: 'surviving',
    agent: 'claude',
    activity: 1,
    size: 10,
    mtimeMs: 1,
    dev: '7',
    ino: '9',
  };
  const removed = { ...surviving, file: 'removed.jsonl', sessionId: 'removed', ino: '10' };
  const provider = completeDiscoveryHarness();
  provider.partial = [surviving];
  provider.catalog = { sessions: provider.partial };
  provider.prepareClaudeChildren = function (this: any) {
    this.discoveryComplete = {
      scope: JSON.stringify(this.repositoryScopeRoots),
      files: new Set([surviving.file, removed.file]),
      revisions: new Map([
        [surviving.file, surviving],
        [removed.file, removed],
      ]),
    };
    return Promise.resolve(true);
  };
  await provider.refresh(true);
  assert.equal(provider.completeCatalogScope, JSON.stringify(provider.repositoryScopeRoots));
  assert.equal(provider.sessionReadDiscoveryRevision, undefined);
  assert.equal(provider.sessionQueryDiscoveryPending, true);
  assert.equal(
    provider.dispatchDiscoveryPending,
    true,
    'the missing listing proof did not request another discovery pass',
  );
});

test('complete discovery has one stable final order across Claude and Codex sessions', () => {
  const sessions = [
    { sessionId: 'codex-b', agent: 'codex', activity: 100 },
    { sessionId: 'claude-a', agent: 'claude', activity: 100 },
    { sessionId: 'claude-c', agent: 'claude', activity: 200 },
  ];
  const order = (input: typeof sessions) =>
    orderSessionCatalog(input, (session) => session.activity).map((session) => session.sessionId);
  assert.deepEqual(order(sessions), ['claude-c', 'claude-a', 'codex-b']);
  assert.deepEqual(order([sessions[1], sessions[0], sessions[2]]), ['claude-c', 'claude-a', 'codex-b']);
});

// Pending ownership must not replace the last accepted display or spend-source set.
test('pending Claude discovery acknowledges progress without replacing catalog rows figures or selection', async () => {
  const { provider, claude, codex } = bumpedCatalogHarness();
  const rows = [claude, codex];
  provider.authoritativeCatalog = rows;
  provider.catalog = { sessions: [claude] };
  provider.refreshGeneration = 4;
  provider.showing = codex.sessionId;
  provider.claudeChildReferences = [{ sessionId: 'accepted-child' }];
  provider.claudeChildren = [{ sessionId: 'accepted-child' }];
  const figures = new Map([['accepted-child', { spend: { partial: true } }]]);
  provider.dispatchFacts = figures;
  provider.checkpointDerivedCache = () => {};
  let spendUpdates = 0;
  provider.updateSessionSpendSources = () => spendUpdates++;
  const checkpoint = {
    compatibility: discoveryCompatibility(CLAUDE_CHILD_REFERENCE_PARSER_VERSION),
    parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
    parents: rows,
    catalog: rows,
    repositoryRoots: ['project'],
    completed: [],
    position: 1,
    sequence: 2,
  };
  provider.progressiveWorker.run = () =>
    Promise.resolve({
      generation: 4,
      value: {
        kind: 'claude-children-progress',
        checkpoint,
        referenceEntries: [],
        continuation: true,
        charges: {
          readBytes: 65536,
          hits: 0,
          resets: 0,
          quanta: 1,
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
        },
      },
    });
  assert.equal(await provider.prepareClaudeChildren(4, new AbortController().signal), true);
  assert.equal(provider.catalog.sessions, rows);
  assert.equal(provider.dispatchFacts, figures);
  assert.deepEqual(provider.claudeChildReferences, [{ sessionId: 'accepted-child' }]);
  assert.equal(provider.showing, codex.sessionId);
  assert.equal(spendUpdates, 0);
  assert.equal(provider.discoveryCheckpoint, checkpoint);
  assert.equal(provider.dispatchDiscoveryPending, true);
  assert.equal(provider.posts.at(-1)?.type, 'startupProgress', 'published catalog suppressed discovery counters');
  assert.equal(provider.posts.at(-1)?.known, rows.length);
});

// A progress reply before any accepted catalog keeps the held catalog, so the refresh that sends the next
// continuation reuses it instead of walking every session again.

test('pending Claude discovery before an accepted catalog keeps the walked rows for the next reuse', async () => {
  const { provider, claude, codex } = bumpedCatalogHarness();
  const walked = [claude, codex];
  provider.authoritativeCatalog = null;
  provider.catalog = { folders: 'project', sessions: walked };
  provider.refreshGeneration = 4;
  provider.showing = codex.sessionId;
  provider.checkpointDerivedCache = () => {};
  const checkpoint = {
    compatibility: discoveryCompatibility(CLAUDE_CHILD_REFERENCE_PARSER_VERSION),
    parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
    parents: walked,
    catalog: walked,
    repositoryRoots: ['project'],
    completed: [],
    position: 1,
    sequence: 2,
  };
  provider.progressiveWorker.run = () =>
    Promise.resolve({
      generation: 4,
      value: { kind: 'claude-children-progress', checkpoint, referenceEntries: [], continuation: true },
    });
  assert.equal(await provider.prepareClaudeChildren(4, new AbortController().signal), false);
  assert.equal(provider.dispatchDiscoveryPending, true);
  assert.equal(provider.catalog.sessions, walked, 'the progress reply dropped the walked rows from the held catalog');
  assert.ok(
    provider.catalog.sessions.some((session: SessionFile) => session.sessionId === codex.sessionId),
    'the selected row left the held catalog, so the next reuse must walk',
  );
});

// While relationship discovery continues, a refresh lists the rows of the accepted catalog. A transcript that grew since
// that catalog keeps its accepted membership, and its row still takes the facts of the walked revision. A listed row with
// another identity or a smaller size leaves the accepted row in place.
test('a session row follows the turns after a hand compaction while relationship discovery continues', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const directory = tempDir('compaction-row-');
  const sessionId = '9e33d208-0000-4000-8000-000000000003';
  const file = path.join(directory, `${sessionId}.jsonl`);
  const compactedAt = Date.UTC(2026, 9, 26, 17, 44, 59);
  const resumedAt = Date.UTC(2026, 9, 27, 3, 8, 8);
  const answeredAt = resumedAt + 146_000;
  vi.setSystemTime(answeredAt + 160_000);
  const iso = (ms: number) => new Date(ms).toISOString();
  const usage = (written: number) => ({
    input_tokens: 2,
    cache_read_input_tokens: 100_000,
    cache_creation_input_tokens: written,
    cache_creation: {
      ephemeral_5m_input_tokens: 0,
      ephemeral_1h_input_tokens: written,
    },
    output_tokens: 400,
  });
  const answer = (id: string, at: number, stop: string, content: object[], written: number) => ({
    type: 'assistant',
    uuid: id,
    timestamp: iso(at),
    message: {
      id,
      role: 'assistant',
      model: 'claude-opus-5-5',
      stop_reason: stop,
      content,
      usage: usage(written),
    },
  });
  const prompt = (id: string, at: number, text: string) => ({
    type: 'user',
    uuid: id,
    promptId: id,
    timestamp: iso(at),
    origin: { kind: 'human' },
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
  const write = (records: object[]) =>
    fs.appendFileSync(
      file,
      records.map((record) => JSON.stringify({ sessionId, entrypoint: 'sdk-cli', ...record })).join('\n') + '\n',
    );
  write([
    prompt('p1', compactedAt - 120_000, 'consult sol as well, then compact yourself'),
    answer('a1', compactedAt - 92_000, 'end_turn', [{ type: 'text', text: 'Both consults are in the plan.' }], 5000),
    {
      type: 'system',
      subtype: 'stop_hook_summary',
      uuid: 's1',
      timestamp: iso(compactedAt - 91_800),
    },
    {
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: iso(compactedAt - 34_700),
    },
    {
      type: 'queue-operation',
      operation: 'dequeue',
      timestamp: iso(compactedAt - 34_700),
    },
    {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 'b1',
      timestamp: iso(compactedAt),
      content: 'Conversation compacted',
      compactMetadata: {
        trigger: 'manual',
        preTokens: 151554,
        durationMs: 34707,
      },
    },
    {
      type: 'user',
      uuid: 'c1',
      timestamp: iso(compactedAt),
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
      message: {
        role: 'user',
        content: 'This session is being continued from a previous conversation.',
      },
    },
    {
      type: 'user',
      uuid: 'c2',
      isMeta: true,
      timestamp: iso(compactedAt - 34_700),
      message: {
        role: 'user',
        content: '<local-command-caveat>Caveat: run by the reader.</local-command-caveat>',
      },
    },
    {
      type: 'user',
      uuid: 'c3',
      timestamp: iso(compactedAt - 34_700),
      message: {
        role: 'user',
        content:
          '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>',
      },
    },
    {
      type: 'user',
      uuid: 'c4',
      timestamp: iso(compactedAt + 300),
      message: {
        role: 'user',
        content: '<local-command-stdout>Compacted </local-command-stdout>',
      },
    },
    {
      type: 'last-prompt',
      lastPrompt: 'consult sol as well, then compact yourself',
    },
    { type: 'mode', mode: 'normal' },
  ]);
  const listed = () => ({
    file,
    sessionId,
    agent: 'claude' as const,
    ...revisionOf(fs.statSync(file, { bigint: true })),
  });
  const accepted = listed();
  const worker = titleWorker();
  let discovery: 'complete' | 'pending' = 'complete';
  const run = (request: ProgressiveRequest, generation: number, signal: AbortSignal) => {
    if (request.kind !== 'claude-children') return worker.run(request, generation, signal);
    if (discovery === 'complete')
      return Promise.resolve({
        generation,
        revision: null,
        value: {
          compatibility: discoveryCompatibility(CLAUDE_CHILD_REFERENCE_PARSER_VERSION),
          kind: 'claude-children',
          complete: true,
          continuation: false,
          references: [],
          dispatchFacts: [],
          children: [],
          referenceEntries: [],
          scope: ['project'],
        },
      });
    return Promise.resolve({
      generation,
      revision: null,
      value: {
        kind: 'claude-children-progress',
        checkpoint: {
          compatibility: discoveryCompatibility(CLAUDE_CHILD_REFERENCE_PARSER_VERSION),
          parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
          parents: [accepted],
          catalog: [accepted],
          repositoryRoots: ['project'],
          completed: [],
          position: 0,
          sequence: 1,
        },
        referenceEntries: [],
        continuation: true,
      },
    });
  };
  const provider = titlePublicationHarness([accepted], run, undefined, {
    methods: ['prepareClaudeChildren', 'activityFor'],
    scope: { CLAUDE_CHILD_REFERENCE_PARSER_VERSION },
    railCacheMark: railCacheMarkOf,
  });
  Object.assign(provider, {
    claudeParents: [accepted],
    claudeChildReferences: [],
    claudeChildStatWrites: new Map(),
    updateSessionSpendSources() {},
    pruneDerivedTitles: () => false,
  });
  provider.useSessionStats(sessionStatsFromFacts);
  const row = () => provider.sessionRows.find((candidate: any) => candidate.id === sessionId);
  try {
    await provider.refresh(true);
    assert.equal(row()?.at, compactedAt + 300, 'the accepted revision did not draw the hand compaction turn');
    assert.equal(provider.metadataRailCaches[sessionId] ?? null, null, 'the compaction kept the earlier cache mark');
    assert.ok(provider.authoritativeCatalog?.some((source: SessionFile) => source.file === file));
    await vi.waitFor(() => assert.equal(provider.refreshController, null));

    // The reader asks again after nine hours. The turn launches a subagent and ends two minutes before the next walk.
    const child = path.join(directory, sessionId, 'subagents', 'agent-a1520ba3c1d67dae2.jsonl');
    fs.mkdirSync(path.dirname(child), { recursive: true });
    fs.writeFileSync(
      child,
      JSON.stringify({
        type: 'user',
        isSidechain: true,
        sessionId,
        agentId: 'a1520ba3c1d67dae2',
        timestamp: iso(resumedAt + 12_000),
        message: { role: 'user', content: 'Read the brief and answer.' },
      }) + '\n',
    );
    write([
      prompt('p2', resumedAt, 'what about vsix based installations?'),
      answer(
        'a2',
        resumedAt + 10_000,
        'tool_use',
        [
          {
            type: 'tool_use',
            id: 'toolu_consult',
            name: 'Agent',
            input: {
              description: 'Consult (fable)',
              prompt: 'Read the brief.',
            },
          },
        ],
        48344,
      ),
      {
        type: 'user',
        uuid: 'r2',
        timestamp: iso(answeredAt - 4_000),
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_consult',
              content: 'analysis',
            },
          ],
        },
      },
      answer('a3', answeredAt, 'end_turn', [{ type: 'text', text: 'A VSIX install keeps one release.' }], 408),
      {
        type: 'system',
        subtype: 'stop_hook_summary',
        uuid: 's2',
        timestamp: iso(answeredAt + 250),
      },
    ]);
    discovery = 'pending';
    provider.dispatchDiscoveryPending = true;
    provider.partial = [listed()];
    provider.claudeParents = provider.partial;
    await provider.refresh(true);

    assert.equal(row()?.at, answeredAt + 250, 'the session row kept the age of the hand compaction turn');
    const mark = provider.metadataRailCaches[sessionId];
    assert.equal(mark?.tier, '1h', 'the session row kept the cache facts from before the compaction');
    assert.ok(mark.expiresAt > resumedAt + 60 * 60_000, 'the cache mark did not time a request of the resumed turn');
    await vi.waitFor(() =>
      assert.ok(
        provider.windows.get(sessionId)?.starts.includes(resumedAt),
        'the unread count never saw the turn after the compaction',
      ),
    );

    // A listing with another inode or a smaller size is not the accepted source, so the accepted row and its facts stay.
    const grown = provider.authoritativeCatalog.find((source: SessionFile) => source.file === file);
    for (const moved of [
      { ...listed(), ino: `${String(grown.ino)}0` },
      { ...listed(), size: grown.size - 1 },
    ]) {
      await vi.waitFor(() => assert.equal(provider.refreshController, null));
      provider.partial = [moved];
      provider.claudeParents = provider.partial;
      await provider.refresh(true);
      assert.deepEqual(
        provider.authoritativeCatalog.map((source: SessionFile) => [String(source.ino), source.size]),
        [[String(grown.ino), grown.size]],
        'a listed row that is not the accepted source replaced the accepted row',
      );
      assert.equal(row()?.at, answeredAt + 250, 'a listed row that is not the accepted source moved the row facts');
    }
  } finally {
    provider.anyVisible = () => false;
    provider.abandonCatalogRefresh();
    worker.stop();
    vi.useRealTimers();
  }
});

// A Codex session this panel started takes its name and recorded responses while unrelated discovery stays pending.
test('a started Codex session publishes its name and recorded responses while relationship discovery stays pending', async () => {
  const directory = tempDir('pending-discovery-admission-');
  const id = '01a176ec-7cfb-7d62-9b62-ad564e398274';
  const record = (second: number, type: string, payload: object) =>
    JSON.stringify({ type, timestamp: `2026-10-26T00:00:${String(second).padStart(2, '0')}Z`, payload }) + '\n';
  const answered = (second: number, turnId: string, prompt: string, answer: string) =>
    record(second, 'event_msg', { type: 'task_started', turn_id: turnId }) +
    record(second + 1, 'event_msg', { type: 'user_message', message: prompt }) +
    record(second + 2, 'event_msg', { type: 'agent_message', message: answer }) +
    record(second + 3, 'event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: answer });
  const file = path.join(directory, `rollout-2026-10-26T00-00-00-${id}.jsonl`);
  fs.writeFileSync(
    file,
    record(0, 'session_meta', { id, cwd: directory, source: 'vscode' }) +
      answered(
        1,
        'one',
        'Explain the admission plan',
        'First **answer** with a [link](https://example.com)\n\n- one item',
      ),
  );
  const started = {
    file,
    sessionId: id,
    agent: 'codex' as const,
    cwd: directory,
    ...revisionOf(fs.statSync(file, { bigint: true })),
    activity: 2,
  };
  const {
    provider,
    codex: older,
    claude,
    codexWalk,
  } = bumpedCatalogHarness({ selectedWindowContainsRecordedTurn, livePressOver, sessionRunning }, true, [
    'readFor',
    'dropSpentPresses',
  ]);
  const accepted = [claude, older];
  (codexWalk as SessionFile[]).push(started);
  const worker = titleWorker();
  let discoveryReplies = 0;
  // The temporary cards of two consecutive prompts, each submitted before its recorded turn started.
  const press = (second: number, text: string, turnId: number): LivePress => ({
    sessionId: id,
    agent: 'codex',
    kind: 'prompt',
    text,
    at: Date.parse(`2026-10-26T00:00:0${second}.500Z`),
    reply: `${text} streamed as text`,
    completed: true,
    turnId,
    midTurn: false,
    ran: true,
    started: true,
    failed: false,
    reason: '',
  });
  Object.assign(provider, {
    authoritativeCatalog: accepted,
    authoritativeCatalogScope: JSON.stringify(provider.repositoryScopeRoots),
    catalog: { sessions: accepted },
    dispatchDiscoveryPending: true,
    awaitingSessionRecords: { [id]: { sessionId: id, agent: 'codex', cwd: directory, createdAt: 1 } },
    live: { [id]: [press(0, 'Explain the admission plan', 1), press(9, 'Continue', 2)] },
    running: new Set(),
    checkpointDerivedCache() {},
  });
  provider.showing = id;
  provider.threadNames = { names: new Map([[id, 'Admission plan']]), fullNames: new Map(), stamp: 'named' };
  provider.progressiveInput = (session: SessionFile) => ({
    session,
    folders: [],
    children: [],
    maxTurns: 40,
    tailBytes: 64 * 1024,
  });
  provider.progressiveCurrent = (source: SessionFile) => provider.cache.get(source.file)?.revision.size === source.size;
  provider.sessionCacheBudgetBytes = () => 64 * 1024 * 1024;
  // Cards come from the accepted selected read through the production renderer, and the newest recorded turn per session is
  // derived the way the panel's own collection derives it, so the real sweep decides which temporary card retires.
  provider.collect = (sources: SessionFile[]) => {
    const turns = sources.flatMap((source) => provider.readFor(source, 40, 1024).read.turns);
    provider.newestBySession = currentRecordsBySession(turns, []).newestTurns;
    return turns.map((value: any) => {
      const card = toCard(value, true, Date.now(), provider.folders());
      return { ...card, summaryHtml: renderRichMarkdown(card.summary) };
    });
  };
  provider.progressiveWorker = {
    run: (request: ProgressiveRequest, generation: number, signal: AbortSignal) => {
      if (request.kind !== 'claude-children') return worker.run(request, generation, signal);
      discoveryReplies++;
      // Relationship discovery for unrelated sessions never completes.
      return Promise.resolve({
        generation,
        value: {
          kind: 'claude-children-progress',
          checkpoint: {
            compatibility: discoveryCompatibility(CLAUDE_CHILD_REFERENCE_PARSER_VERSION),
            parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
            parents: request.parents,
            catalog: request.parents,
            repositoryRoots: request.repositoryRoots,
            completed: [],
            position: 0,
            sequence: discoveryReplies,
          },
          referenceEntries: [],
          continuation: true,
        },
      });
    },
    stop: () => worker.stop(),
  };
  // The selected window read posts the selected row and its cards in a selection message, and a catalog refresh in a render.
  const drawn = (count: number) =>
    provider.messages.findLast(
      (message: any) =>
        (message.type === 'render' || message.type === 'selection') &&
        message.showing === id &&
        message.cards?.length === count,
    );
  const first =
    '<p>First <strong>answer</strong> with a <a href="#" data-link="https://example.com">link</a></p>\n<ul>\n<li>one item</li>\n</ul>\n';
  try {
    await provider.refresh();
    assert.ok(discoveryReplies > 0, 'the refresh never reached relationship discovery');
    await vi.waitFor(
      () => assert.ok(drawn(1), 'the started session kept its temporary state, so no recorded response was drawn'),
      { timeout: 5000 },
    );
    assert.equal(drawn(1).sessions.find((row: any) => row.id === id)?.label, 'Admission plan');
    assert.deepEqual(
      drawn(1).cards.map((card: any) => card.summaryHtml),
      [first],
    );
    assert.equal(
      provider.awaitingSessionRecords[id],
      undefined,
      'the recorded session never replaced the temporary one',
    );
    assert.deepEqual(
      provider.live[id]?.map((held: LivePress) => held.text),
      ['Continue'],
      'the first recorded answer did not retire only its own temporary card',
    );
    fs.appendFileSync(file, answered(10, 'two', 'Continue', 'Second answer with `inline code`'));
    Object.assign(started, revisionOf(fs.statSync(file, { bigint: true })));
    await provider.refresh();
    await vi.waitFor(() => assert.ok(drawn(2), 'the second recorded answer was never drawn'), { timeout: 5000 });
    assert.deepEqual(
      drawn(2).cards.map((card: any) => card.summaryHtml),
      [first, '<p>Second answer with <code>inline code</code></p>\n'],
    );
    assert.equal(provider.live[id], undefined, 'the second recorded answer left its temporary card');
    assert.equal(provider.dispatchDiscoveryPending, true, 'relationship discovery completed');
    assert.equal(provider.sessionQueryDiscoveryPending, true, 'search coverage claimed complete discovery');
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// Only a walked source that alone answers a session this panel started joins the accepted rows before discovery completes.
test.each([
  'qualified',
  'not started here',
  'colliding session ID',
  'second walked source',
  'other provider',
  'already accepted',
  'outside repository scope',
  'child transcript',
  'not an enumerated member',
  'missing file identity',
  'inode zero',
  'without a recorded cwd',
  'qualified Claude',
] as const)('a pending discovery reply admits only a qualified started source: %s', async (change) => {
  const { provider, claude, codex } = bumpedCatalogHarness({ scopeInside: isInside });
  const root = path.resolve('project');
  const started: SessionFile = {
    file: 'fixture/started.jsonl',
    sessionId: 'started-session',
    agent: change === 'qualified Claude' ? 'claude' : 'codex',
    ...(change === 'without a recorded cwd'
      ? {}
      : { cwd: path.join(root, change === 'outside repository scope' ? '../elsewhere' : 'Nested') }),
    size: 10,
    mtimeMs: 10,
    ...(change === 'missing file identity' ? {} : { dev: 7, ino: change === 'inode zero' ? 0 : 3 }),
    ...(change === 'child transcript' ? { childTranscript: true } : {}),
  };
  const accepted: SessionFile[] =
    change === 'already accepted' ? [claude, codex, { ...started, file: 'fixture/older.jsonl' }] : [claude, codex];
  const walked: SessionFile[] = [
    claude,
    codex,
    started,
    ...(change === 'second walked source' ? [{ ...started, file: 'fixture/copy.jsonl', ino: 4 }] : []),
  ];
  Object.assign(provider, {
    repositoryScopeRoots: [root],
    authoritativeCatalog: accepted,
    catalog: { sessions: walked },
    refreshGeneration: 4,
    awaitingSessionRecords:
      change === 'not started here'
        ? {}
        : {
            [started.sessionId]: {
              sessionId: started.sessionId,
              agent: change === 'other provider' ? 'claude' : started.agent,
              cwd: root,
              createdAt: 1,
            },
          },
    enumeratedMembers: new Set(
      walked.filter((source) => change !== 'not an enumerated member' || source !== started).map(sessionCoverageMember),
    ),
    enumeratedAmbiguousIds: new Set(change === 'colliding session ID' ? [started.sessionId] : []),
    checkpointDerivedCache() {},
  });
  const checkpoint = {
    compatibility: discoveryCompatibility(CLAUDE_CHILD_REFERENCE_PARSER_VERSION),
    parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
    parents: walked,
    catalog: walked,
    repositoryRoots: [root],
    completed: [],
    position: 1,
    sequence: 2,
  };
  provider.progressiveWorker.run = () =>
    Promise.resolve({
      generation: 4,
      value: { kind: 'claude-children-progress', checkpoint, referenceEntries: [], continuation: true },
    });
  assert.equal(await provider.prepareClaudeChildren(4, new AbortController().signal), true);
  assert.equal(provider.dispatchDiscoveryPending, true);
  if (change === 'qualified' || change === 'without a recorded cwd' || change === 'qualified Claude')
    assert.deepEqual(provider.catalog.sessions, [...accepted, started]);
  else assert.equal(provider.catalog.sessions, accepted, 'a refused source joined the accepted rows');
});

test.each(['win32', 'darwin', 'linux'])('startup progress counts completed Windows sources on %s', async (platform) => {
  vi.stubGlobal('process', { ...process, platform });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    const { provider, claude } = bumpedCatalogHarness();
    provider.refreshGeneration = 4;
    const source = { ...claude, file: 'C:\\Users\\Reader\\Projects\\Session.JSONL' };
    const checkpoint = {
      compatibility: discoveryCompatibility(CLAUDE_CHILD_REFERENCE_PARSER_VERSION),
      epoch: 'counter',
      parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
      parents: [source],
      catalog: [source],
      repositoryRoots: ['project'],
      completed: [normalizeFsPath(source.file)],
      position: 1,
      sequence: 1,
    };
    provider.progressiveWorker.run = () =>
      Promise.resolve({
        generation: 4,
        value: { kind: 'claude-children-progress', checkpoint, referenceEntries: [], continuation: true },
      });
    assert.equal(await provider.prepareClaudeChildren(4, new AbortController().signal), false);
    assert.deepEqual(provider.posts, [
      {
        type: 'startupProgress',
        generation: 4,
        epoch: '4',
        sequence: 1,
        completed: 1,
        known: 1,
      },
    ]);
  } finally {
    clock.mockRestore();
    vi.unstubAllGlobals();
  }
});

test.each(['win32', 'darwin', 'linux'])(
  'startup progress deduplicates known sources and excludes unknown completions on %s',
  async (platform) => {
    vi.stubGlobal('process', { ...process, platform });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const { provider, claude } = bumpedCatalogHarness();
      provider.refreshGeneration = 4;
      const files = ['C:\\Projects\\Session.JSONL', '/Repo/Session.jsonl', '/repo/session.jsonl'];
      const checkpoint = {
        compatibility: discoveryCompatibility(CLAUDE_CHILD_REFERENCE_PARSER_VERSION),
        parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
        epoch: 'aliases',
        parents: files.map((file) => ({ ...claude, file })),
        catalog: [{ ...claude, file: 'c:/projects/session.jsonl' }],
        repositoryRoots: ['project'],
        completed: [files[0], normalizeFsPath(files[0]), normalizeFsPath(files[1]), '/unknown/session.jsonl'],
        position: 2,
        sequence: 1,
      };
      provider.progressiveWorker.run = () =>
        Promise.resolve({
          generation: 4,
          value: { kind: 'claude-children-progress', checkpoint, referenceEntries: [], continuation: true },
        });
      assert.equal(await provider.prepareClaudeChildren(4, new AbortController().signal), false);
      assert.deepEqual(provider.posts, [
        {
          type: 'startupProgress',
          generation: 4,
          epoch: '4',
          sequence: 1,
          completed: 2,
          known: platform === 'win32' ? 2 : 3,
        },
      ]);
    } finally {
      clock.mockRestore();
      vi.unstubAllGlobals();
    }
  },
);

test('host delta checkpoints retain completion and source progress through cancellation and durable restart', async () => {
  const directory = tempDir('host-discovery-delta-');
  const parents = ['done', 'pending', 'later'].map((sessionId, index) => {
    const file = path.join(directory, sessionId + '.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'ignored', text: index ? 'x'.repeat(2 * 1024 * 1024) : '' }) + '\n');
    const { size, mtimeMs } = fs.statSync(file);
    return { file, sessionId, agent: 'claude' as const, size, mtimeMs };
  });
  const { provider } = bumpedCatalogHarness();
  const snapshot = { claude: [{ file: parents[0].file, sessionId: 'done', primary: true }], codex: [], children: [] };
  Object.assign(provider, {
    refreshGeneration: 4,
    authoritativeCatalog: parents,
    catalog: { sessions: parents },
    claudeParents: parents,
    repositoryScopeRoots: [directory],
    claudeChildReferenceEntries: new Map(),
    enumeratedSpendSources: snapshot,
    checkpointDerivedCache() {},
  });
  const controller = new AbortController();
  const quantumClock = 'let tick = 0; performance.now = () => ++tick;';
  let worker = titleWorker(quantumClock);
  let messages = 0;
  let header: unknown;
  try {
    provider.progressiveWorker = {
      run: (
        request: ProgressiveRequest,
        generation: number,
        signal: AbortSignal,
        accept: (result: ProgressiveResult) => boolean,
      ) =>
        worker.run(
          request.kind === 'claude-children' ? { ...request, quantumBytes: 256 * 1024 } : request,
          generation,
          signal,
          (result) => {
            assert.equal(result.value.kind, 'claude-children-delta');
            if (result.value.kind !== 'claude-children-delta') return;
            messages++;
            assert.equal(accept(result), true);
            if (messages === 1) header = provider.discoveryCheckpoint;
            else {
              assert.equal(result.value.checkpoint, undefined, 'a source quantum replayed the epoch header');
              assert.equal(provider.discoveryCheckpoint, header);
              controller.abort();
            }
          },
        ),
    };
    assert.equal(await provider.prepareClaudeChildren(4, controller.signal), false);
    assert.equal(messages, 2);
    assert.equal(provider.discoveryCheckpoint.spendSources, snapshot);
    assert.deepEqual(provider.discoveryCheckpoint.completed, [normalizeFsPath(parents[0].file)]);
    assert.equal(provider.discoveryCheckpoint.position, 2);
    assert.equal(provider.discoveryCheckpoint.sequence, 2);
    const pendingFile = normalizeFsPath(parents[1].file);
    const held = provider.claudeChildReferenceEntries.get(pendingFile);
    const offset = held.claudeCursor.offset;
    assert.ok(offset > 0 && offset < parents[1].size);
    const cacheFile = path.join(directory, 'checkpoint.json');
    saveDerivedCache(cacheFile, [], provider.claudeChildReferenceEntries, [], undefined, provider.discoveryCheckpoint);
    const restored = loadDerivedCache(cacheFile);
    assert.deepEqual(restored.discovery!.completed, [normalizeFsPath(parents[0].file)]);
    assert.deepEqual(restored.discovery!.spendSources, snapshot);
    provider.discoveryCheckpoint = restored.discovery;
    provider.discoveryCompleted = undefined;
    provider.claudeChildReferenceEntries = restored.claudeChildReferences;
    worker.stop();
    worker = titleWorker(quantumClock);
    const resumed = new AbortController();
    provider.progressiveWorker = {
      run: (
        request: ProgressiveRequest,
        generation: number,
        signal: AbortSignal,
        accept: (result: ProgressiveResult) => boolean,
      ) =>
        worker.run(
          request.kind === 'claude-children' ? { ...request, quantumBytes: 256 * 1024 } : request,
          generation,
          signal,
          (result) => {
            assert.equal(result.value.kind, 'claude-children-delta');
            if (result.value.kind !== 'claude-children-delta') return;
            assert.equal(result.value.checkpoint, undefined, 'restart replayed the retained epoch header');
            assert.equal(accept(result), true);
            if (result.value.referenceEntries[0][0] === pendingFile) resumed.abort();
          },
        ),
    };
    assert.equal(await provider.prepareClaudeChildren(4, resumed.signal), false);
    assert.ok(provider.claudeChildReferenceEntries.get(pendingFile).claudeCursor.offset > offset);
    assert.equal(provider.claudeChildReferenceEntries.get(pendingFile).sourceGeneration, held.sourceGeneration);
    assert.deepEqual(provider.discoveryCheckpoint.completed, [normalizeFsPath(parents[0].file)]);
    assert.equal(provider.catalog.sessions, parents);
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a reload of a partial follow-up checkpoint starts its count at the unchanged finished sources', async () => {
  const directory = tempDir('host-discovery-follow-up-');
  const newline = String.fromCharCode(10);
  const write = (name: string, text: string) => {
    const file = path.join(directory, name + '.jsonl');
    fs.writeFileSync(file, text);
    return file;
  };
  // A rollout that ends inside a record being written reaches its end without completing, so discovery accepts it through visitedEof.
  const rollout = (id: string) =>
    JSON.stringify({ type: 'session_meta', payload: { id, cwd: directory } }) +
    newline +
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } }).slice(0, 24);
  const files = {
    codexA: write('codex-a', rollout('codex-a')),
    codexB: write('codex-b', rollout('codex-b')),
    big: write('big', JSON.stringify({ type: 'user', cwd: directory, message: { content: 'big' } }) + newline),
    small: write('small', JSON.stringify({ type: 'user', cwd: directory, message: { content: 'small' } }) + newline),
  };
  const rows = () =>
    (
      [
        ['codex', files.codexA, 'codex-a'],
        ['codex', files.codexB, 'codex-b'],
        ['claude', files.big, 'big'],
        ['claude', files.small, 'small'],
      ] as const
    ).map(([agent, file, sessionId]) => {
      const { size, mtimeMs } = fs.statSync(file);
      return { file, sessionId, agent, size, mtimeMs };
    });
  const { provider } = bumpedCatalogHarness();
  const listed = (parents: ReturnType<typeof rows>) =>
    Object.assign(provider, {
      authoritativeCatalog: parents,
      catalog: { sessions: parents },
      claudeParents: parents,
    });
  Object.assign(provider, {
    refreshGeneration: 4,
    repositoryScopeRoots: [directory],
    claudeChildReferenceEntries: new Map(),
    enumeratedSpendSources: { claude: [], codex: [], children: [] },
    checkpointDerivedCache() {},
  });
  listed(rows());
  // The byte allowance controls cancellation even when one chunk takes longer than the cooperative deadline.
  const quantumClock = 'let tick = 0; performance.now = () => ++tick;';
  let worker = titleWorker(quantumClock);
  let watch: ((result: ProgressiveResult) => void) | undefined;
  provider.progressiveWorker = {
    run: (
      request: ProgressiveRequest,
      generation: number,
      signal: AbortSignal,
      accept: (result: ProgressiveResult) => boolean,
    ) =>
      worker.run(
        request.kind === 'claude-children' ? { ...request, quantumBytes: 1024 * 1024 } : request,
        generation,
        signal,
        (result) => {
          if (accept(result)) watch?.(result);
        },
      ),
  };
  const finished = [files.codexA, files.codexB].map(normalizeFsPath);
  try {
    assert.equal(await provider.prepareClaudeChildren(4, new AbortController().signal), true);
    for (const file of finished) {
      const entry = provider.claudeChildReferenceEntries.get(file);
      assert.ok(
        entry.visitedEof === true && entry.complete === false,
        'the rollout fixture was not accepted at its end',
      );
    }
    // Both Claude sources grow, so a follow-up pass reads them. The large append leaves one source unfinished.
    fs.appendFileSync(files.big, JSON.stringify({ type: 'ignored', text: 'x'.repeat(2 * 1024 * 1024) }) + newline);
    fs.appendFileSync(
      files.small,
      JSON.stringify({ type: 'user', cwd: directory, message: { content: 'again' } }) + newline,
    );
    listed(rows());
    const followUp = new AbortController();
    watch = (result) => {
      if (
        result.value.kind === 'claude-children-delta' &&
        result.value.referenceEntries[0]?.[0] === normalizeFsPath(files.big)
      )
        followUp.abort();
    };
    assert.equal(await provider.prepareClaudeChildren(4, followUp.signal), false);
    assert.ok(provider.discoveryCheckpoint, 'the follow-up pass left no partial checkpoint');
    assert.deepEqual(
      [...provider.discoveryCheckpoint.completed].sort(),
      [...finished].sort(),
      'the partial checkpoint counted a changed source as finished',
    );
    const cacheFile = path.join(directory, 'checkpoint.json');
    saveDerivedCache(cacheFile, [], provider.claudeChildReferenceEntries, [], undefined, provider.discoveryCheckpoint);
    const restored = loadDerivedCache(cacheFile);
    Object.assign(provider, {
      discoveryCheckpoint: restored.discovery,
      discoveryCompleted: undefined,
      discoveryAcknowledgment: undefined,
      claudeChildReferenceEntries: restored.claudeChildReferences,
    });
    worker.stop();
    worker = titleWorker(quantumClock);
    const counts: string[][] = [];
    const resumed = new AbortController();
    watch = (result) => {
      if (result.value.kind !== 'claude-children-delta' || counts.length) return;
      const read = result.value.referenceEntries[0]?.[0];
      counts.push(provider.discoveryCheckpoint.completed.filter((file: string) => file !== read).sort());
      resumed.abort();
    };
    await provider.prepareClaudeChildren(4, resumed.signal);
    assert.deepEqual(counts, [finished.sort()], 'the reload count restarted below the unchanged finished sources');

    const checkpoint = structuredClone(provider.discoveryCheckpoint);
    watch = undefined;
    const claudeFiles = [files.big, files.small].map(normalizeFsPath);
    const completedClaude = () =>
      claudeFiles.every((file) => {
        const entry = provider.claudeChildReferenceEntries.get(file);
        const cursor = entry?.claudeCursor;
        const stamp = relationshipStamp(fs.statSync(file, { bigint: true }));
        return (
          entry?.complete === true &&
          entry.relationshipComplete === true &&
          cursor?.evidence !== undefined &&
          cursor.evidence.validation === undefined &&
          cursor.offset === stamp.size &&
          isDeepStrictEqual(cursor.evidence.accepted, stamp)
        );
      });
    for (let i = 0; i < 64 && !completedClaude(); i++) {
      await provider.prepareClaudeChildren(4, new AbortController().signal);
    }
    assert.ok(completedClaude(), 'the Claude fixture sources did not finish at their current revisions');

    // A saved checkpoint that has not counted a finished rollout, and whose remainder holds only Codex sources, reports the
    // seeded count before it reads them.
    fs.appendFileSync(
      files.codexA,
      newline + JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'later' } }).slice(0, 24),
    );
    listed(rows());
    saveDerivedCache(cacheFile, [], provider.claudeChildReferenceEntries, [], undefined, {
      ...checkpoint,
      parents: provider.claudeParents,
      catalog: provider.claudeParents,
      completed: claudeFiles,
      protectedFile: undefined,
    });
    const remainder = loadDerivedCache(cacheFile);
    Object.assign(provider, {
      discoveryCheckpoint: remainder.discovery,
      discoveryCompleted: undefined,
      discoveryAcknowledgment: undefined,
      claudeChildReferenceEntries: remainder.claudeChildReferences,
    });
    worker.stop();
    worker = titleWorker(quantumClock);
    const seeded: string[][] = [];
    const codexOnly = new AbortController();
    watch = (result) => {
      if (seeded.length) return;
      assert.equal(result.value.kind, 'claude-children-delta');
      if (result.value.kind !== 'claude-children-delta') return;
      assert.deepEqual(result.value.referenceEntries, []);
      seeded.push([...provider.discoveryCheckpoint.completed].sort());
      codexOnly.abort();
    };
    await provider.prepareClaudeChildren(4, codexOnly.signal);
    assert.deepEqual(
      seeded,
      [[...claudeFiles, normalizeFsPath(files.codexB)].sort()],
      'a Codex-only remainder kept the seeded count from the host',
    );
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('complete worker discovery keeps peer-wake roots out of visible catalog and dispatch spend membership', async () => {
  const { provider, claude, codex, claudeWalk } = bumpedCatalogHarness();
  const wake = { ...claude, sessionId: 'wake', file: 'wake.jsonl' };
  claudeWalk.push(wake);
  provider.hasHumanPrompt = (session: SessionFile) => session.sessionId !== 'wake';
  let published: SessionFile[] = [];
  provider.updateSessionSpendSources = (_codex: SessionFile[], sessions: SessionFile[]) => {
    published = sessions;
  };
  await provider.refresh(true);
  assert.ok(
    provider.claudeParents.some((session: SessionFile) => session.sessionId === 'wake'),
    'the discovery roots lost the peer-wake transcript',
  );
  assert.deepEqual(
    provider.catalog.sessions.map((session: SessionFile) => session.sessionId).sort(),
    [claude.sessionId, codex.sessionId, 'agent-child'].sort(),
  );
  assert.equal(
    published.some((session) => session.sessionId === 'wake'),
    false,
    'an unprompted root joined dispatch spend membership',
  );
});

test('refresh enumeration retains accepted spend sources until a complete Claude publication', async () => {
  const { provider, claude, codex, codexWalk, claudeWalk } = bumpedCatalogHarness();
  await provider.refresh(true);
  const acceptedRows = provider.authoritativeCatalog;
  const accepted = [{ file: 'accepted-child.jsonl', sessionId: 'accepted-child', primary: false }];
  provider.sessionSpendSources = accepted;
  provider.claudeSpendSources = accepted;
  provider.codexSpendSources = [{ file: codex.file }];
  provider.codexSubagents = [{ file: 'accepted-codex-child.jsonl' }];
  const codexSources = provider.codexSpendSources;
  const children = provider.codexSubagents;
  let updates = 0;
  provider.updateSessionSpendSources = (_codex: SessionFile[], sessions: SessionFile[]) => {
    updates++;
    provider.sessionSpendSources = sessions.map((session) => ({ file: session.file, sessionId: session.sessionId }));
  };
  codexWalk.splice(0);
  const fresh = { ...claude, sessionId: 'fresh', file: 'fresh.jsonl' };
  claudeWalk.push(fresh);
  provider.checkpointDerivedCache = () => {};
  let complete = false;
  provider.progressiveWorker.run = (
    request: Extract<ProgressiveRequest, { kind: 'claude-children' }>,
    generation: number,
  ) => {
    const checkpoint = {
      compatibility: discoveryCompatibility(CLAUDE_CHILD_REFERENCE_PARSER_VERSION),
      parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
      epoch: 'spend-epoch',
      parents: request.parents,
      catalog: request.parents,
      repositoryRoots: ['project'],
      completed: [],
      position: 0,
      sequence: complete ? 2 : 1,
    };
    return Promise.resolve({
      generation,
      value: complete
        ? {
            kind: 'claude-children',
            roots: request.parents,
            checkpoint,
            complete: true,
            continuation: false,
            references: [],
            children: [],
            dispatchFacts: [],
            referenceEntries: [],
          }
        : {
            kind: 'claude-children-progress',
            checkpoint,
            continuation: true,
            referenceEntries: [],
            charges: {
              readBytes: 1,
              hits: 0,
              resets: 0,
              quanta: 1,
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
            },
          },
    });
  };
  await provider.refresh(true);
  assert.equal(provider.catalog.sessions, acceptedRows);
  assert.equal(
    provider.sessionSpendSources,
    accepted,
    'enumeration replaced delegated membership during pending closure',
  );
  assert.equal(provider.claudeSpendSources, accepted);
  assert.equal(provider.codexSpendSources, codexSources);
  assert.equal(provider.codexSubagents, children);
  assert.equal(updates, 0);
  complete = true;
  await provider.refresh(true);
  assert.equal(updates, 1);
  assert.ok(provider.sessionSpendSources.some((source: { sessionId: string }) => source.sessionId === 'fresh'));
  assert.equal(
    provider.sessionSpendSources.some((source: { sessionId: string }) => source.sessionId === codex.sessionId),
    false,
  );
});

test('out-of-order complete and pending discovery cannot regress source acknowledgment across epochs parsers or scopes', async () => {
  const { provider, claude } = bumpedCatalogHarness();
  provider.refreshGeneration = 4;
  provider.authoritativeCatalog = [claude];
  provider.catalog = { sessions: [claude] };
  provider.claudeParents = [claude];
  provider.checkpointDerivedCache = () => {};
  const checkpoint = (sequence: number, scope = 'project', epoch = 'current') => ({
    compatibility: discoveryCompatibility(CLAUDE_CHILD_REFERENCE_PARSER_VERSION),
    parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
    epoch,
    sequence,
    parents: [claude],
    catalog: [claude],
    repositoryRoots: [scope],
    completed: [],
    position: 0,
  });
  const entry = (sourceGeneration: number, sequence: number) => ({
    parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
    source: 'claude',
    sourceGeneration,
    sequence,
    dev: 1,
    ino: sourceGeneration,
    size: 10,
    mtimeMs: 1,
    sessionId: claude.sessionId,
    childTranscript: false,
    references: [],
    complete: true,
  });
  const deliver = async (
    sequence: number,
    sourceGeneration: number,
    complete = false,
    scope = 'project',
    generation = 4,
    epoch = 'current',
    parserVersion = CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
  ) => {
    const cut = { ...checkpoint(sequence, scope, epoch), parserVersion };
    provider.progressiveWorker.run = () =>
      Promise.resolve({
        generation,
        value: complete
          ? {
              kind: 'claude-children',
              checkpoint: cut,
              scope: [scope],
              roots: [claude],
              complete: true,
              continuation: false,
              referenceEntries: [[claude.file, entry(sourceGeneration, sequence)]],
              references: [],
              children: [],
              dispatchFacts: [],
            }
          : {
              kind: 'claude-children-delta',
              checkpoint: provider.discoveryCheckpoint?.epoch === epoch ? undefined : cut,
              epoch,
              parserVersion,
              sequence,
              position: sequence,
              protectedFile: sourceGeneration === 3 ? claude.file : undefined,
              completed: [[claude.file, sourceGeneration !== 3]],
              referenceEntries: [[claude.file, entry(sourceGeneration, sequence)]],
              continuation: true,
              charges: {
                readBytes: 1,
                hits: 0,
                resets: 0,
                quanta: 1,
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
              },
            },
      });
    return provider.prepareClaudeChildren(4, new AbortController().signal);
  };
  assert.equal(await deliver(5, 2), true);
  const frozen = provider.discoveryCheckpoint;
  const completed = frozen.completed;
  assert.deepEqual(completed, [claude.file]);
  const held = provider.claudeChildReferenceEntries.get(claude.file);
  assert.equal(await deliver(3, 1, true, 'project', 3), false);
  assert.equal(await deliver(4, 1), false);
  assert.equal(provider.discoveryCheckpoint.sequence, 5);
  assert.equal(
    provider.claudeChildReferenceEntries.get(claude.file),
    held,
    'a cursorless complete answer replaced newer progress',
  );
  assert.equal(await deliver(6, 3, false, 'project', 4, 'current', CLAUDE_CHILD_REFERENCE_PARSER_VERSION - 1), false);
  assert.equal(await deliver(6, 3), true);
  assert.equal(provider.discoveryCheckpoint, frozen, 'a compact delta replaced the frozen epoch header');
  assert.equal(provider.discoveryCheckpoint.completed, completed, 'a quantum copied the cumulative completion list');
  assert.deepEqual(completed, []);
  assert.equal(provider.discoveryCheckpoint.protectedFile, claude.file);
  assert.equal(provider.discoveryCheckpoint.position, 6);
  assert.equal(provider.claudeChildReferenceEntries.get(claude.file).sourceGeneration, 3);
  assert.equal(await deliver(7, 2), false, 'a newer epoch sequence accepted an older source generation');
  assert.equal(provider.discoveryCheckpoint.sequence, 6);
  provider.repositoryScopeRoots = ['other-project'];
  assert.equal(
    await deliver(1, 1, false, 'other-project', 4, 'other'),
    true,
    'the new scope compared unrelated checkpoint sequences',
  );
  assert.equal(provider.discoveryCheckpoint.sequence, 1);
  assert.equal(provider.discoveryCheckpoint.protectedFile, undefined);
  assert.deepEqual(provider.discoveryCheckpoint.completed, [claude.file]);
  assert.equal(await deliver(9, 9, true, 'project'), false);
  assert.equal(await deliver(0, 1, true, 'other-project', 3, 'obsolete'), false);
  assert.equal(provider.claudeChildReferenceEntries.get(claude.file).sourceGeneration, 1);
  let finishOld: (value: unknown) => void = () => {};
  provider.progressiveWorker.run = () =>
    new Promise((resolve) => {
      finishOld = resolve;
    });
  const late = provider.prepareClaudeChildren(4, new AbortController().signal);
  assert.equal(await deliver(2, 1, false, 'other-project', 4, 'other'), true);
  finishOld({
    generation: 4,
    value: {
      kind: 'claude-children',
      checkpoint: checkpoint(99, 'other-project', 'late-old'),
      scope: ['other-project'],
      roots: [claude],
      complete: true,
      continuation: false,
      referenceEntries: [[claude.file, entry(9, 99)]],
      references: [],
      children: [],
      dispatchFacts: [],
    },
  });
  assert.equal(
    await late,
    false,
    'an older request replaced progress from a newer epoch in the same display generation',
  );
  assert.equal(provider.discoveryCheckpoint.sequence, 2);
  assert.equal(provider.claudeChildReferenceEntries.get(claude.file).sourceGeneration, 1);
  assert.equal(await deliver(3, 1, true, 'other-project', 4, 'other'), true);
  assert.equal(provider.discoveryCheckpoint, undefined);
  const published = provider.claudeChildReferenceEntries.get(claude.file);
  provider.progressiveWorker.run = () =>
    Promise.resolve({
      generation: 4,
      value: {
        kind: 'claude-children-delta',
        epoch: 'other',
        parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
        sequence: 2,
        position: 0,
        completed: [[claude.file, false]],
        referenceEntries: [[claude.file, entry(1, 2)]],
        continuation: true,
        charges: {
          readBytes: 1,
          hits: 0,
          resets: 0,
          quanta: 1,
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
        },
      },
    });
  assert.equal(await provider.prepareClaudeChildren(4, new AbortController().signal), false);
  assert.equal(provider.discoveryCheckpoint, undefined, 'a late delta reopened the completed epoch');
  assert.equal(provider.claudeChildReferenceEntries.get(claude.file), published);
});

test('complete discovery publishes one final rail without changing its selection', async () => {
  const sessions = [
    { file: 'codex.jsonl', sessionId: 'codex-b', agent: 'codex', activity: 100, size: 1, mtimeMs: 1 },
    { file: 'claude.jsonl', sessionId: 'claude-a', agent: 'claude', activity: 100, size: 1, mtimeMs: 1 },
  ];
  for (const completed of [sessions, [sessions[1], sessions[0]]]) {
    const provider = completeDiscoveryHarness();
    provider.partial = [sessions[0]];
    let finish: (value: boolean) => void = () => {};
    provider.discovery = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    const refresh = provider.refresh(true);
    await Promise.resolve();
    assert.deepEqual(provider.messages, [], 'a partial catalog reached the browser before discovery completed');
    provider.catalog = { sessions: completed };
    finish(true);
    await refresh;
    assert.equal(provider.messages.length, 1, 'complete discovery published more than one catalog payload');
    assert.deepEqual(
      provider.messages[0].sessions.map((session: { id: string }) => session.id),
      ['claude-a', 'codex-b'],
    );
    assert.deepEqual(
      provider.selections,
      ['claude-a'],
      'complete discovery changed the selected session more than once',
    );
  }
});

// A host with real eviction and session-list status. Every source holds a current metadata read, its turn starts, a
// working directory, and a human-prompt scan, as a restored derived cache does.
function heldFactsHarness(held: Array<{ file: string; size: number; mtimeMs: number; sessionId: string }>): any {
  const provider = completeDiscoveryHarness(
    undefined,
    false,
    ['evictCache', 'pruneDerivedTitles', 'protectedHistorySessions', 'metaFor', 'workspaceFoldersChanged'],
    { historyBytes, historyEvictions },
  );
  provider.sessionCacheBudgetBytes = () => Number.MAX_SAFE_INTEGER;
  provider.hostSessions = new Map();
  provider.walkedClaude = [];
  provider.carriedNames = new Map();
  provider.claudeChildrenDiscovered = true;
  provider.titles = new Map(
    held.map((session) => [
      session.file,
      {
        size: session.size,
        mtimeMs: session.mtimeMs,
        label: session.sessionId,
        fullLabel: session.sessionId,
        foldedLabel: session.sessionId,
        activityMs: 1,
        agentRun: false,
        outcome: null,
        stats: null,
        expandedStatsRead: true,
        starts: { starts: [1], whole: true },
      },
    ]),
  );
  provider.cwds = new Map(held.map((session) => [session.file, { cwd: 'project' }]));
  provider.humanScans = new Map(held.map((session) => [session.file, { found: true }]));
  return provider;
}

test('a selected-only refresh before the catalog keeps every held title, and the authoritative refresh completes and prunes', async () => {
  const selected = {
    file: 'selected.jsonl',
    sessionId: 'selected',
    agent: 'claude',
    activity: 300,
    size: 1,
    mtimeMs: 1,
  };
  const codex = { file: 'rollout-codex.jsonl', sessionId: 'codex', agent: 'codex', activity: 200, size: 1, mtimeMs: 1 };
  const child = {
    file: 'subagents/agent-child.jsonl',
    sessionId: 'child',
    agent: 'claude',
    childTranscript: true,
    activity: 100,
    size: 1,
    mtimeMs: 1,
  };
  const gone = { file: 'gone.jsonl', sessionId: 'gone', agent: 'codex', activity: 50, size: 1, mtimeMs: 1 };
  const provider = heldFactsHarness([selected, codex, child, gone]);
  const heldFiles = (map: Map<string, unknown>) => [...map.keys()].sort();
  const everyFile = [selected, codex, child, gone].map((session) => session.file).sort();

  // Reload: a selected-only refresh before discovery keeps the held source facts.
  provider.showing = selected.sessionId;
  await provider.refresh(true, true, true, true);
  assert.equal(provider.authoritativeCatalog, null, 'the fixture no longer refreshes before the catalog');
  assert.deepEqual(heldFiles(provider.titles), everyFile, 'a selected-only refresh dropped titles of unlisted sources');
  assert.ok(
    [codex, child].every((session) => provider.titles.get(session.file).starts),
    'a selected-only refresh dropped held turn starts',
  );
  assert.deepEqual(heldFiles(provider.cwds), everyFile, 'a selected-only refresh dropped working directories');
  assert.deepEqual(heldFiles(provider.humanScans), everyFile, 'a selected-only refresh dropped human-prompt scans');

  // Discovery completes. The authoritative catalog lacks the deleted source. Every listed source and the selected window
  // are current.
  provider.partial = [selected, codex, child];
  provider.catalog = { sessions: provider.partial };
  provider.discovery = Promise.resolve(true);
  provider.progressiveCurrent = () => true;
  await provider.refresh(true);
  assert.ok(provider.authoritativeCatalog, 'the full refresh did not set the authoritative catalog');
  const listed = [selected, codex, child].map((session) => session.file).sort();
  assert.deepEqual(heldFiles(provider.titles), listed, 'the authoritative refresh kept the deleted source title');
  assert.deepEqual(heldFiles(provider.cwds), listed, 'the authoritative refresh kept the deleted source directory');
  assert.deepEqual(heldFiles(provider.humanScans), listed, 'the authoritative refresh kept the deleted source scan');
  assert.equal(
    provider.messages.at(-1).startup?.complete,
    true,
    'the session list stayed loading although every listed source holds current facts',
  );

  // A workspace folder change clears the catalog. Once the new repository scope answers,
  // its full refresh waits in discovery while the selected window refreshes. That selected-only refresh lists no session
  // at all and keeps the old scope's facts. The new scope's authoritative refresh then prunes the sources outside it.
  provider.repositoryScope = { snapshot() {} };
  provider.allowThemeFiles = () => {};
  provider.partial = [selected];
  provider.catalog = { sessions: provider.partial };
  let finishWalk: (walked: boolean) => void = () => {};
  const walk = new Promise<boolean>((resolve) => {
    finishWalk = resolve;
  });
  let walking = false;
  provider.prepareClaudeChildren = () => {
    walking = true;
    return walk;
  };
  const refresh = vi.spyOn(provider, 'refresh');
  provider.workspaceFoldersChanged();
  await refresh.mock.results.at(-1)!.value;
  assert.equal(provider.authoritativeCatalog, null, 'the workspace folder change kept the old catalog');
  provider.repositoryScopeReady = true;
  const scoped = provider.refresh(true);
  await vi.waitFor(() => assert.ok(walking, 'the new scope refresh did not start discovery'));
  await provider.refresh(true, true, true, true);
  assert.deepEqual(heldFiles(provider.titles), listed, 'a selected-only refresh after a scope change dropped titles');
  assert.deepEqual(
    heldFiles(provider.cwds),
    listed,
    'a selected-only refresh after a scope change dropped directories',
  );
  assert.deepEqual(
    heldFiles(provider.humanScans),
    listed,
    'a selected-only refresh after a scope change dropped scans',
  );
  finishWalk(true);
  await scoped;
  assert.ok(provider.authoritativeCatalog, 'the new scope refresh did not set the authoritative catalog');
  assert.deepEqual(heldFiles(provider.titles), [selected.file], 'the new scope kept titles outside it');
});

// A selection changes the rows of the session it leaves and the session it enters. Its refresh checks the prompt sources
// and builds the session list payload of those two sessions alone.

test('a selection in a thousand-session catalog checks prompts and builds session list rows for the two switched sessions', async () => {
  const sessions = Array.from({ length: 1000 }, (_, index) => ({
    file: `session-${index}.jsonl`,
    sessionId: `session-${index}`,
    agent: 'claude',
    activity: 2000 - index,
    size: 100,
    mtimeMs: 1000 + index,
    dev: 1,
    ino: index + 1,
  }));
  const byFile = new Map(sessions.map((session) => [session.file, session]));
  const checked: string[] = [];
  const statOf = (file: string) => {
    const session = byFile.get(file);
    if (!session) throw new Error(`no fixture file ${file}`);
    return { size: session.size, mtimeMs: session.mtimeMs, dev: session.dev, ino: session.ino };
  };
  const provider = completeDiscoveryHarness(undefined, false, ['prepareHumanPrompts'], {
    fs: {
      ...fs,
      statSync: (file: string) => {
        checked.push(file);
        return statOf(file);
      },
    },
    humanPromptScanSteps,
    promptScanLists,
  });
  const work: string[] = [];
  provider.performanceCounters.recordWork = (name: string) => work.push(name);
  provider.humanScans = new Map(
    sessions.map((session) => [
      session.file,
      { bytes: session.size, found: true, complete: true, source: fileRevisionOf(statOf(session.file) as fs.Stats) },
    ]),
  );
  provider.partial = sessions;
  provider.catalog = { sessions };
  provider.discovery = Promise.resolve(true);
  provider.showing = 'session-0';
  await provider.refresh(true);
  assert.equal(provider.sessionRows.length, 1000, 'the catalog refresh did not list every session');

  const built: number[] = [];
  provider.useRailPayload((input: Parameters<typeof railPayload>[0], rows?: ReadonlySet<string | null>) => {
    const payload = railPayload(input, rows);
    built.push(payload.rail.length);
    return payload;
  });
  checked.length = 0;
  work.length = 0;
  const posted = provider.messages.length;
  const refresh = vi.spyOn(provider, 'refresh');
  provider.show('session-500');
  await refresh.mock.results.at(-1)!.value;

  assert.deepEqual(
    [...new Set(checked)].sort(),
    ['session-0.jsonl', 'session-500.jsonl'],
    'the selection checked the prompt sources of sessions it did not change',
  );
  assert.ok(
    work.filter((name) => name.startsWith('humanPromptStat:')).length <= 4,
    `the selection made ${work.filter((name) => name.startsWith('humanPromptStat:')).length} prompt checks`,
  );
  assert.ok(built.length > 0, 'the selection built no session list rows');
  assert.ok(
    built.every((rows) => rows <= 2),
    `the selection built ${built.join(', ')} session list rows`,
  );
  const selection = provider.messages.slice(posted).find((message: any) => message.type === 'selection');
  assert.ok(selection, 'the selection posted no selection message');
  assert.deepEqual(
    selection.rail.map((row: any) => [row.id, row.current]).sort(),
    [
      ['session-0', false],
      ['session-500', true],
    ],
    'the selection did not update the session list rows it left and entered',
  );
  assert.deepEqual(
    selection.sessions.map((row: any) => [row.id, row.shown]).sort(),
    [
      ['session-0', false],
      ['session-500', true],
    ],
    'the selection did not update the session rows it left and entered',
  );
  assert.equal(provider.authoritativeCatalog.length, 1000, 'the selection dropped catalog sessions it did not check');
});

test('a cold start walks the catalog once every opening record is read', async () => {
  const sessions = [
    { file: 'codex.jsonl', sessionId: 'codex-b', agent: 'codex', activity: 100, size: 1, mtimeMs: 1 },
    { file: 'claude.jsonl', sessionId: 'claude-a', agent: 'claude', activity: 100, size: 1, mtimeMs: 1 },
  ];
  const provider = completeDiscoveryHarness();
  provider.partial = sessions;
  provider.catalog = { sessions };
  provider.discovery = Promise.resolve(true);
  let finish: () => void = () => {};
  let coldPasses = 0;
  const walked = ['rollout.jsonl'];
  const enumeration = { status: 'complete', files: walked, uncertain: [] };
  provider.codexColdReads = () => {
    coldPasses += 1;
    return new Promise((resolve) => {
      finish = () => resolve({ walked, enumeration, read: false });
    });
  };
  let walks = 0;
  const enumerations: unknown[] = [];
  provider.allSessions = (_reuse: boolean, _defer: boolean, supplied: unknown) => {
    walks += 1;
    enumerations.push(supplied);
    return provider.partial;
  };
  const first = provider.refresh(true);
  provider.refreshFrom('watch');
  await vi.waitFor(() =>
    assert.ok(provider.pendingRefresh, 'a trigger during the opening reads did not wait behind them'),
  );
  assert.equal(walks, 0, 'the catalog was walked before every opening record was read');
  assert.deepEqual(provider.messages, [], 'a catalog reached the browser before every opening record was read');
  finish();
  await first;
  assert.equal(provider.messages.length, 1, 'the first refresh published more than one catalog payload');
  assert.deepEqual(
    provider.messages[0].sessions.map((session: { id: string }) => session.id),
    ['claude-a', 'codex-b'],
  );
  await vi.waitFor(() => assert.equal(walks, 2, 'the trigger that waited behind the reads never ran'));
  assert.equal(coldPasses, 1, 'a later refresh read the opening records again');
  assert.deepEqual(enumerations, [enumeration, undefined], 'cold traversal evidence outlived its refresh');
});

test('two loads of older history during the cold pass show the loading status at once and read the pages once, after the pass', async () => {
  const provider = completeDiscoveryHarness(undefined, false, ['loadOlderHistory'], {
    startSessionHistory,
    historyPageReads,
    afterHistoryPage,
    historyRequestContinues,
    afterHistoryRequest,
    staleCursorIsStuck,
  });
  const session = { sessionId: 'codex-b', file: 'codex-b.jsonl', size: 50_000, mtimeMs: 1 };
  provider._showing = 'codex-b';
  provider.hostSessions = new Map();
  provider.readWindows = new Map([['codex-b', { loadedTurns: 40 }]]);
  provider.historyGeneration = 0;
  let finish: () => void = () => {};
  provider.codexPriming = new Promise((resolve) => {
    finish = () => resolve({ walked: [], read: false });
  });
  let walks = 0;
  provider.allSessions = () => {
    walks += 1;
    return [session];
  };
  // The session each render would mark as loading older history.
  const statuses: (string | null)[] = [];
  provider.refresh = () => {
    statuses.push(provider.historyRequest?.sessionId ?? null);
    return Promise.resolve();
  };
  let pages = 0;
  provider.readOlderHistoryPage = () => {
    pages += 1;
    return Promise.resolve({ kind: 'failed' });
  };
  const first = provider.loadOlderHistory('codex-b');
  const second = provider.loadOlderHistory('codex-b');
  assert.equal(walks, 0, 'a press walked the catalog while the opening records were still being read');
  const duringPass = [...statuses];
  finish();
  await Promise.all([first, second]);
  assert.equal(walks, 1, 'the presses walked the catalog more than once after the pass, or never');
  assert.equal(pages, 1, 'the second press started a second request for the same pages');
  assert.deepEqual(
    duringPass,
    ['codex-b'],
    'a press during the cold pass showed no loading status until the pass ended',
  );
  assert.equal(provider.historyRequest, null);
});

test('loading older turns repaints the selected panel while a catalog refresh is busy', async () => {
  const provider = completeDiscoveryHarness(undefined, false, ['loadOlderHistory'], {
    startSessionHistory,
    historyPageReads,
    afterHistoryPage,
    historyRequestContinues,
    afterHistoryRequest,
    staleCursorIsStuck,
  });
  const session = { sessionId: 'codex-b', file: 'codex-b.jsonl', size: 50_000, mtimeMs: 1 };
  provider.partial = [session];
  provider._showing = session.sessionId;
  provider.hostSessions = new Map();
  provider.readWindows = new Map([[session.sessionId, { loadedTurns: 1 }]]);
  provider.historyGeneration = 0;
  const repaints: Array<{ busy: boolean; loaded: boolean }> = [];
  let queued = 0;
  provider.refresh = (_force: boolean, _reuse: boolean, _metadata: boolean, selectedOnly: boolean) => {
    if (selectedOnly) {
      repaints.push({
        busy: provider.historyRequest?.sessionId === session.sessionId,
        loaded: (provider.history.get(session.sessionId)?.pages.length ?? 0) > 0,
      });
    } else {
      queued += 1;
    }
    return Promise.resolve();
  };
  provider.readOlderHistoryPage = () =>
    Promise.resolve({
      kind: 'page',
      turns: [turn({ agent: 'codex', sessionId: session.sessionId, summary: 'Earlier response' })],
      compactions: [],
      cursor: null,
      ownedRange: { start: 0, end: session.size },
      openRange: null,
    });

  await provider.loadOlderHistory(session.sessionId);
  assert.deepEqual(
    repaints,
    [
      { busy: true, loaded: false },
      { busy: false, loaded: true },
    ],
    'the older-turn button stayed unchanged while its page loaded',
  );
  assert.equal(queued, 0, 'the older-turn status waited behind the busy catalog refresh');
});

test('a cold pass that ends hidden or before the repository scope hands on the triggers that waited', async () => {
  for (const ending of ['hidden', 'scope']) {
    const sessions = [
      { file: 'claude.jsonl', sessionId: 'claude-a', agent: 'claude', activity: 100, size: 1, mtimeMs: 1 },
    ];
    const provider = completeDiscoveryHarness();
    provider.partial = sessions;
    provider.catalog = { sessions };
    provider.discovery = Promise.resolve(true);
    let visible = true;
    provider.anyVisible = () => visible;
    let finish: () => void = () => {};
    let coldPasses = 0;
    provider.codexColdReads = () => {
      coldPasses += 1;
      return new Promise((resolve) => {
        finish = () => resolve({ walked: [], read: false });
      });
    };
    let walks = 0;
    provider.allSessions = () => {
      walks += 1;
      return provider.partial;
    };
    const first = provider.refresh(true);
    provider.refreshFrom('watch');
    await vi.waitFor(() => assert.ok(provider.pendingRefresh, `${ending}: the trigger did not wait behind the reads`));
    if (ending === 'hidden') {
      visible = false;
    } else {
      provider.repositoryScopeReady = false;
    }
    finish();
    await first;
    await vi.waitFor(() =>
      assert.equal(provider.pendingRefresh, null, `${ending}: the trigger that waited behind the reads was dropped`),
    );
    assert.deepEqual(provider.messages, [], `${ending}: a catalog reached the browser`);
    assert.equal(walks, ending === 'hidden' ? 0 : 2, `${ending}: the catalog walks after the pass`);
    visible = true;
    provider.repositoryScopeReady = true;
    await provider.refresh(true);
    assert.equal(provider.messages.length, 1, `${ending}: the refresh after the pass published no catalog`);
    assert.equal(coldPasses, 1, `${ending}: a later refresh read the opening records again`);
  }
});

test('opening records the cold pass reads reach the checkpoint and the shared file', async () => {
  const root = tempDir('codex-cold-root-');
  const rollout = path.join(
    root,
    '2026',
    '08',
    '25',
    'rollout-2026-08-25T12-00-00-01a032c9-1a92-7931-845c-723117d24dbe.jsonl',
  );
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  const opening = { id: '01a032c9-1a92-7931-845c-723117d24dbe', cwd: '/elsewhere', source: 'vscode' };
  fs.writeFileSync(
    rollout,
    `${JSON.stringify({ timestamp: '2026-08-25T12:00:00.000Z', type: 'session_meta', payload: opening })}\n`,
  );
  const shared = path.join(tempDir('codex-cold-shared-'), 'codex-openings.json');
  const cache = new CodexMetaCache(() => assert.fail('the walk read an opening record on the main thread'));
  const writer = new CodexOpeningsWriter(shared, cache, false);
  const sessions = [
    { file: 'claude.jsonl', sessionId: 'claude-a', agent: 'claude', activity: 100, size: 1, mtimeMs: 1 },
  ];
  const provider = completeDiscoveryHarness(undefined, false, ['writeDerivedCache']);
  provider.partial = sessions;
  provider.catalog = { sessions };
  provider.discovery = Promise.resolve(true);
  provider.codexOpenings = writer;
  provider.derivedCacheFile = null;
  // Cached titles leave opening records as the only checkpoint changes.
  const checkpoint = {
    compatibility: discoveryCompatibility(CLAUDE_CHILD_REFERENCE_PARSER_VERSION),
    parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
    dirty: false,
    markChanged() {
      this.dirty = true;
    },
    markSaved() {
      this.dirty = false;
    },
  };
  provider.derivedCacheCheckpointState = checkpoint;
  provider.checkpointDerivedCache = () => {
    if (checkpoint.dirty && provider.writeDerivedCache()) {
      checkpoint.markSaved();
    }
  };
  provider.codexColdReads = () => coldOpeningPass(cache, root);
  // allSessions retains the revision after the opening pass reads every record.
  provider.allSessions = (_reuse: boolean, _defer: boolean, enumeration: { files: string[] }) => {
    writer.setWalk(enumeration.files);
    return provider.partial;
  };
  await provider.refresh(true);
  assert.deepEqual(
    [...(loadCodexOpenings(shared)?.keys() ?? [])],
    [rollout],
    'the rows the cold pass read never reached the shared file',
  );
  assert.equal(checkpoint.dirty, false);
});

// Resolved dispatch references update the child heading even when no transcript changes.

test('a dispatch resolved with no transcript moving names its parent on the next render', async () => {
  const provider = completeDiscoveryHarness();
  provider.useRefreshGate(refreshWanted);
  provider.useListingSignature(listingSignature);
  const session = (sessionId: string, activity: number) => ({
    file: `${sessionId}.jsonl`,
    sessionId,
    agent: 'claude',
    activity,
    size: 1,
    mtimeMs: 1,
  });
  provider.partial = [session('child', 3), session('parent', 2), session('archived', 1)];
  provider.catalog = { sessions: provider.partial };
  provider.hidden = new Set(['archived']);
  const dispatch = (parent: string) => ({
    kind: 'dispatch',
    agent: 'claude',
    parentSessionId: parent,
    sessionId: 'child',
    file: 'child.jsonl',
    toolUseIds: ['launch'],
    name: null,
    owned: false,
  });
  let resolved: unknown[] = [];
  // The worker hands back a new list on every walk, as `prepareClaudeChildren` does.
  provider.prepareClaudeChildren = () => {
    provider.claudeChildReferences = [...resolved];
    return Promise.resolve(true);
  };
  const parentOfChild = () =>
    provider.messages.at(-1).sessions.find((row: { id: string }) => row.id === 'child').parent ?? null;
  const rowsWithParent = () =>
    provider.messages
      .at(-1)
      .sessions.filter((row: { parent?: unknown }) => row.parent)
      .map((row: { id: string }) => row.id);

  await provider.refresh();
  assert.equal(provider.messages.length, 1);
  assert.equal(parentOfChild(), null, 'a session nothing dispatched named a parent');

  resolved = [dispatch('parent')];
  await provider.refresh();
  assert.equal(provider.messages.length, 2, 'a resolved dispatch waited for an unrelated transcript to move');
  assert.deepEqual(parentOfChild(), { id: 'parent', label: 'Session parent', relation: 'dispatched' });

  await provider.refresh();
  assert.equal(provider.messages.length, 2, 'the same resolved dispatch repainted the panel on every walk');

  // An archived parent retains its row and remains archived when opened.

  resolved = [dispatch('archived')];
  await provider.refresh();
  assert.deepEqual(
    parentOfChild(),
    { id: 'archived', label: 'Session archived', relation: 'dispatched' },
    'the index did not follow the references the worker replaced',
  );
  provider.show('archived');
  await vi.waitFor(() => assert.equal(provider.messages.at(-1).showing, 'archived'));
  assert.deepEqual([...provider.hidden], ['archived'], 'opening an archived parent unarchived it');
  assert.deepEqual(rowsWithParent(), [], 'a session the panel is not showing carried the session that started it');
  provider.show('child');
  await vi.waitFor(() => assert.equal(provider.messages.at(-1).showing, 'child'));
  assert.deepEqual(
    parentOfChild(),
    { id: 'archived', label: 'Session archived', relation: 'dispatched' },
    'the chosen session lost its parent when the reader came back to it',
  );

  // A parent absent from the workspace catalog gets no navigation control.

  resolved = [dispatch('gone')];
  await provider.refresh();
  assert.equal(parentOfChild(), null, 'a parent with no session row was named');
});

// Catalog walks build parent edges once. Search and selection reuse those edges across different row orders.

test('a walk builds the parent edges once, and a search and a selection reuse them', async () => {
  const provider = completeDiscoveryHarness(
    undefined,
    false,
    ['updateSessionSpendSources', 'onMessage', 'answerSearch'],
    {
      parsePanelToHost,
      dispatchPanelToHost,
      isSearch,
      searchScope,
      searchScopeName,
      searchTurns,
      labelsOf,
    },
  );
  provider.useRefreshGate(refreshWanted);
  provider.useListingSignature(listingSignature);
  const session = (sessionId: string, activity: number) => ({
    file: `${sessionId}.jsonl`,
    sessionId,
    agent: 'claude',
    activity,
    size: 1,
    mtimeMs: 1,
  });
  provider.partial = [session('child', 3), session('parent', 2), session('other', 1)];
  provider.catalog = { sessions: provider.partial };
  provider.claudeChildReferences = [
    {
      kind: 'dispatch',
      agent: 'claude',
      parentSessionId: 'parent',
      sessionId: 'child',
      file: 'child.jsonl',
      toolUseIds: ['launch'],
      name: null,
      owned: false,
    },
  ];
  provider.prepareClaudeChildren = () => Promise.resolve(true);
  provider.sessionSpendSourceIndex = { revision: 0, update: () => new Map() };
  provider.searchCorpus = () => [];
  provider.archivedSessions = () => new Set();
  // Spend sources and search use parent-first order. Rendering uses activity order.

  const walkOrder = () => [...provider.partial].reverse();
  provider.allSessions = (reuseCatalog = false) => {
    if (reuseCatalog) {
      return walkOrder();
    }
    provider.updateSessionSpendSources([], walkOrder());
    return provider.partial;
  };
  const builds: unknown[] = [];
  let held: unknown = null;
  Object.defineProperty(provider, 'sessionParentEdgeSet', {
    configurable: true,
    get: () => held,
    set: (value: unknown) => {
      if (value !== held) {
        builds.push(value);
      }
      held = value;
    },
  });

  await provider.refresh();
  assert.equal(builds.length, 1, 'one walk built the parent edges more than once');
  assert.equal(provider.sessionParentEdgeSet?.key, 'child>parent:dispatched');
  await provider.onMessage({ type: 'search', text: 'find:hello' }, provider.hosts[0]);
  assert.equal(provider.posts.at(-1)?.type, 'results', 'the search never answered');
  provider.show('parent');
  await vi.waitFor(() => assert.equal(provider.messages.at(-1).showing, 'parent'));
  assert.equal(builds.length, 1, 'a search or the selection after it rebuilt the parent edges');
});

// Resolved child files establish subagent ownership. An unresolved reference from a fork cannot replace the resolved parent.

test('a subagent the worker hands over after the first render names its parent', async () => {
  const provider = completeDiscoveryHarness();
  provider.useRefreshGate(refreshWanted);
  provider.useListingSignature(listingSignature);
  const parents = ['fork', 'parent'].map((sessionId, index) => ({
    file: `${sessionId}.jsonl`,
    sessionId,
    agent: 'claude',
    activity: index + 1,
    size: 1,
    mtimeMs: 1,
  }));
  const child = (agentId: string, activity: number) => ({
    file: `project/parent/subagents/agent-${agentId}.jsonl`,
    sessionId: agentId,
    agent: 'claude',
    activity,
    size: 1,
    mtimeMs: 1,
    parentSessionId: 'parent',
    toolUseIds: [`task-${agentId}`],
    childTranscript: true,
    agentRun: true,
    cwd: 'project',
  });
  const reference = (parentSessionId: string, agentId: string) => ({
    kind: 'subagent',
    parentSessionId,
    sessionId: agentId,
    file: `project/${parentSessionId}/subagents/agent-${agentId}.jsonl`,
    toolUseIds: [`task-${agentId}`],
  });
  const children = [child('a1b2c3', 4), child('d4e5f6', 3)];
  // Pairing changes neither transcript revisions nor the catalog entries.

  provider.partial = [...parents, ...children];
  provider.catalog = { sessions: provider.partial };
  let paired = false;
  // The worker hands back new lists on every walk, as `prepareClaudeChildren` does.
  provider.prepareClaudeChildren = () => {
    provider.claudeChildReferences = [
      reference('parent', 'a1b2c3'),
      reference('fork', 'a1b2c3'),
      reference('parent', 'd4e5f6'),
    ];
    provider.claudeChildren = paired ? children.map((row) => ({ ...row })) : [];
    provider.catalog = { sessions: [...parents, ...children] };
    return Promise.resolve(true);
  };
  const last = () => provider.messages.at(-1);
  const parentOf = (id: string) => last().sessions.find((row: { id: string }) => row.id === id)?.parent ?? null;

  await provider.refresh();
  provider.show('a1b2c3');
  await provider.refresh();
  await vi.waitFor(() => assert.equal(last().showing, 'a1b2c3'));
  assert.equal(parentOf('a1b2c3'), null, 'a subagent named a parent before the worker paired it');

  // Only the parent relationship changes.
  const before = provider.messages.length;
  paired = true;
  await provider.refresh();
  assert.ok(provider.messages.length > before, 'a newly paired subagent drew nothing until another session moved');
  assert.deepEqual(
    parentOf('a1b2c3'),
    { id: 'parent', label: 'Session parent', relation: 'subagent' },
    'a subagent the worker handed over named no parent, or the fork took it',
  );
  assert.equal(parentOf('d4e5f6'), null, 'a subagent the panel is not showing carried the session that started it');

  const drawn = provider.messages.length;
  await provider.refresh();
  assert.equal(provider.messages.length, drawn, 'the same hand-off repainted the panel on every walk');
});

// A Codex subagent heading follows the parent session named by the current listing.

test('a Codex subagent names its parent thread and follows a replaced listing', async () => {
  const provider = completeDiscoveryHarness();
  provider.useRefreshGate(refreshWanted);
  provider.useListingSignature(listingSignature);
  const session = (sessionId: string, activity: number) => ({
    file: `${sessionId}.jsonl`,
    sessionId,
    agent: 'codex',
    activity,
    size: 1,
    mtimeMs: 1,
  });
  provider.partial = [session('helper', 3), session('lead', 2), session('other', 1)];
  provider.catalog = { sessions: provider.partial };
  const listing = (parentThreadId: string) => [
    { file: 'helper.jsonl', threadId: 'helper', parentThreadId, backgroundReview: false },
    { file: 'review.jsonl', threadId: 'review', parentThreadId, backgroundReview: true },
  ];
  provider.codexSubagents = listing('lead');
  provider.prepareClaudeChildren = () => Promise.resolve(true);
  const parentOf = (id: string) =>
    provider.messages.at(-1).sessions.find((row: { id: string }) => row.id === id)?.parent ?? null;

  await provider.refresh();
  assert.equal(provider.messages.at(-1).showing, 'helper');
  assert.deepEqual(
    parentOf('helper'),
    { id: 'lead', label: 'Session lead', relation: 'subagent' },
    'a Codex subagent with a session row named no parent',
  );

  provider.codexSubagents = listing('other');
  await provider.refresh();
  assert.deepEqual(
    parentOf('helper'),
    { id: 'other', label: 'Session other', relation: 'subagent' },
    'the heading did not follow the Codex listing the walk replaced',
  );
});

test('restored startup waits for all required metadata before its first payload', async () => {
  const provider = completeDiscoveryHarness();
  provider._showing = 'selected';
  provider.partial = Array.from({ length: 100 }, (_unused, index) => ({
    file: `${index}.jsonl`,
    sessionId: index ? `session-${index}` : 'selected',
    agent: 'claude',
    activity: 100 - index,
    size: 1,
    mtimeMs: 1,
  }));
  provider.catalog = { sessions: provider.partial };
  provider.discovery = Promise.resolve(true);
  let metadataStarted = false;
  let releaseMetadata: (value: boolean) => void = () => {};
  provider.prepareMetadata = () =>
    new Promise<boolean>((resolve) => {
      releaseMetadata = resolve;
      metadataStarted = true;
    });
  const startup = provider.refresh(true);
  await vi.waitFor(() => assert.equal(metadataStarted, true));
  assert.deepEqual(provider.messages, [], 'restored startup posted sessions before required metadata completed');
  releaseMetadata(true);
  await startup;
  assert.equal(provider.messages.length, 1);
});

// The harness controls discovery and failed worker requests. Successful requests read fixture records through the production worker.

function titlePublicationHarness(
  sessions: any[],
  run: any,
  cacheFile?: string,
  real: { methods?: string[]; scope?: Record<string, unknown>; railCacheMark?: typeof railCacheMarkOf } = {},
): any {
  const provider = completeDiscoveryHarness(
    undefined,
    false,
    [
      ...(real.methods ?? []),
      'prepareMetadata',
      'prepareRailEnrichment',
      'glanceAt',
      'metaFor',
      'sessionLabel',
      'claudeName',
      'titleFor',
      'fullTitleFor',
      'observeStoredName',
      'observeStoredEntry',
      'checkpointDerivedCache',
      'writeDerivedCache',
    ],
    {
      INITIAL_RAIL_READ_BYTES,
      RAIL_ENRICHMENT_READ_BYTES,
      metadataReadBudget,
      unreadHeadBytes,
      sameSessionRevision,
      carryDerivedTitleFacts,
      agentRunScanUnread,
      railEnrichmentNeeds,
      withRailEnrichment,
      withAgentRunScanProgress,
      scanForRailEnrichment,
      withMetadataCoverage,
      realStoredSessionName: storedSessionName,
      withSessionName,
      transcriptIdentity,
      codexTitleFor,
      saveDerivedCache,
      DERIVED_CACHE_CHECKPOINT_MS: 5 * 60 * 1000,
      ...real.scope,
    },
    real.railCacheMark,
  );
  const cached = cacheFile ? metadataHarness(run, new SessionNames(), cacheFile) : null;
  Object.assign(provider, {
    partial: sessions,
    catalog: { sessions },
    discovery: Promise.resolve(true),
    titles: cached?.titles ?? new Map(),
    carriedNames: cached?.carriedNames ?? new Map(),
    claudeChildReferenceEntries: cached?.claudeChildReferenceEntries ?? new Map(),
    discoveryCheckpoint: cached?.discoveryCheckpoint,
    sessionNames: new SessionNames(),
    threadNames: { stamp: '', names: new Map(), fullNames: new Map() },
    codexMetas: { get: () => undefined },
    progressiveWorker: { run },
    derivedCacheFile: cacheFile,
    derivedCacheCheckpointState: new DerivedCacheCheckpointState(Date.now()),
    lifetimeRailFacts: () => ({}),
    dispatchFiguresRevision: 0,
    drawnDispatchFiguresRevision: 0,
    metadataRevision: 0,
    drawnMetadataRevision: 0,
    metadataRecoveryQueue: [],
  });
  provider.useRefreshGate(refreshWanted);
  provider.useListingSignature(listingSignature);
  provider.useSpendSignature(spendSourceSignature);
  provider.useSpendOfferGate(projectSpendSourceOfferDue);
  provider.useRailPayload(railPayload);
  provider.sendToHost = (_host: unknown, message: any) => {
    provider.messages.push(
      message.type === 'render' || message.type === 'rail' ? provider.expandRows(message) : message,
    );
    return Promise.resolve(true);
  };
  provider.spendOffers = [];
  provider.scheduleProjectSpendIndex = (...args: unknown[]) => provider.spendOffers.push(args);
  return provider;
}

function titleRollout(directory: string, id: string, title: string, bytes = 0): SessionFile & { activity: number } {
  const file = path.join(directory, `${id}.jsonl`);
  fs.writeFileSync(
    file,
    [
      { type: 'session_meta', payload: { id, cwd: directory, timestamp: '2026-01-01T00:00:00Z' } },
      ...(bytes ? [{ type: 'ignored', text: 'x'.repeat(Math.min(bytes, 134000)) }] : []),
      { type: 'event_msg', payload: { type: 'user_message', message: title } },
      ...(bytes > 134000 ? [{ type: 'ignored', text: 'x'.repeat(bytes - 134000) }] : []),
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  return {
    file,
    sessionId: id,
    agent: 'codex' as const,
    ...revisionOf(fs.statSync(file, { bigint: true })),
    activity: 1,
  };
}

let titleWorkerSource: string;
let previousArcHome: string | undefined;
beforeAll(() => {
  previousArcHome = process.env.ARC_HOME;
  process.env.ARC_HOME = tempDir('startup-fixture-home-');
  titleWorkerSource = buildSync({
    entryPoints: [path.join(__dirname, 'progressiveworker-entry.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    write: false,
  }).outputFiles[0].text;
});

function titleWorker(extraSource = '') {
  return new ProgressiveWorker(titleWorkerSource + extraSource);
}

afterAll(() => {
  if (previousArcHome === undefined) delete process.env.ARC_HOME;
  else process.env.ARC_HOME = previousArcHome;
});

test('a recovered Codex title reaches the rail when later enrichment fails', async () => {
  const directory = tempDir('title-publication-');
  const selected = titleRollout(directory, 'selected', 'Selected session');
  const session = titleRollout(
    directory,
    '01a0cd13-0f8c-74f1-8e71-350abc0ca1e5',
    'Codex queue and request costs',
    134000,
  );
  const worker = titleWorker();
  let available = false;
  const requests: string[] = [];
  const run = (request: ProgressiveRequest, generation: number, signal: AbortSignal) => {
    requests.push(request.kind);
    if (
      request.kind === 'starts' ||
      (!available && 'session' in request && request.session.sessionId !== selected.sessionId)
    )
      return Promise.reject(new Error('record temporarily unavailable'));
    return worker.run(request, generation, signal);
  };
  const provider = titlePublicationHarness([selected, session], run, path.join(directory, 'cache.json'));
  provider._showing = selected.sessionId;
  const drawnName = () => {
    const row = provider.messages.at(-1)?.rail.find((row: any) => row.id === session.sessionId);
    return row?.name ?? row?.label;
  };
  try {
    await provider.refresh(true);
    assert.equal(drawnName(), 'Session 01a0cd13');
    available = true;
    await provider.refresh();
    await vi.waitFor(() => assert.equal(provider.refreshController, null));
    assert.equal(readCodexSessionTitlePair(session.file)?.short, 'Codex queue and request costs');
    assert.ok(requests.includes('starts'), 'the production enrichment path did not run');
    assert.equal(
      drawnName(),
      'Codex queue and request costs',
      'accepted metadata never replaced the rail identity label',
    );
    assert.equal(provider.spendOffers.length, 1, 'title publication restarted unchanged spend sources');
    await vi.waitFor(() => assert.ok(fs.existsSync(provider.derivedCacheFile)));
    const restarted = titlePublicationHarness([selected, session], run, provider.derivedCacheFile);
    restarted._showing = selected.sessionId;
    await restarted.refresh(true);
    assert.equal(
      restarted.messages[0].rail.find((row: any) => row.id === session.sessionId).label,
      'Codex queue and request costs',
    );
  } finally {
    provider.abandonCatalogRefresh();
    if (provider.derivedCacheCheckpointTick) clearTimeout(provider.derivedCacheCheckpointTick);
    worker.stop();
  }
});

test('a rejected render preserves recovered Codex names for the next unchanged refresh', async () => {
  const directory = tempDir('title-post-');
  const selected = titleRollout(directory, 'selected', 'Selected session');
  const session = titleRollout(directory, 'post', 'Recovered title');
  const worker = titleWorker();
  let available = false;
  let acceptPosts = true;
  const provider = titlePublicationHarness(
    [selected, session],
    (request: ProgressiveRequest, generation: number, signal: AbortSignal) => {
      if (
        request.kind === 'starts' ||
        (!available && 'session' in request && request.session.sessionId !== selected.sessionId)
      )
        return Promise.reject(new Error('record temporarily unavailable'));
      return worker.run(request, generation, signal);
    },
  );
  provider._showing = selected.sessionId;
  const send = provider.sendToHost.bind(provider);
  provider.sendToHost = (...args: any[]) => (acceptPosts ? send(...args) : Promise.resolve(false));
  try {
    await provider.refresh(true);
    available = true;
    acceptPosts = false;
    await provider.refresh();
    await vi.waitFor(() => assert.equal(provider.refreshController, null));
    assert.ok(
      provider.metadataRevision > provider.drawnMetadataRevision,
      'a rejected render consumed the accepted name',
    );
    acceptPosts = true;
    await provider.refresh(false, true);
    assert.equal(
      provider.messages.at(-1).rail.find((row: any) => row.id === session.sessionId).label,
      'Recovered title',
    );
    assert.equal(provider.metadataRevision, provider.drawnMetadataRevision);
  } finally {
    provider.abandonCatalogRefresh();
    worker.stop();
  }
});

for (const order of ['accepted first', 'rejected first', 'post failure']) {
  test(`two panels recover Codex titles after mixed render delivery with ${order}`, async () => {
    const directory = tempDir('title-multi-post-');
    const selected = titleRollout(directory, 'selected', 'Selected session');
    const session = titleRollout(directory, 'peer', 'Recovered peer title');
    const worker = titleWorker();
    let available = false;
    const provider = titlePublicationHarness(
      [selected, session],
      (request: ProgressiveRequest, generation: number, signal: AbortSignal) => {
        if (
          request.kind === 'starts' ||
          (!available && 'session' in request && request.session.sessionId !== selected.sessionId)
        )
          return Promise.reject(new Error('record temporarily unavailable'));
        return worker.run(request, generation, signal);
      },
    );
    provider._showing = selected.sessionId;
    const first = provider.hosts[0];
    const second = { webview: {}, active: () => false, visible: () => true };
    provider.hosts.push(second);
    provider.readyHosts.add(second);
    const delivered = new Map<any, any[]>();
    const pending = new Map<any, { accept(value: boolean): void; fail(error: Error): void; message: any }>();
    let defer = false;
    provider.sendToHost = (host: any, message: any) => {
      const accept = (value: boolean) => {
        if (value) delivered.set(host, [...(delivered.get(host) ?? []), message]);
        return value;
      };
      return defer
        ? new Promise<boolean>((resolve, reject) =>
            pending.set(host, { accept: (value) => resolve(accept(value)), fail: reject, message }),
          )
        : Promise.resolve(accept(true));
    };
    const name = (host: any) =>
      delivered
        .get(host)
        ?.filter((message: any) => message.type === 'render')
        .at(-1)
        .rail.find((row: any) => row.id === session.sessionId).label;
    try {
      await provider.refresh(true);
      assert.equal(name(first), 'Session peer');
      assert.equal(name(second), 'Session peer');
      available = true;
      defer = true;
      await provider.refresh();
      assert.equal(pending.size, 2, 'the recovered title did not reach both host boundaries');
      if (order === 'accepted first') {
        pending.get(first)!.accept(true);
        await vi.waitFor(() => assert.equal(name(first), 'Recovered peer title'));
        pending.get(second)!.accept(false);
      } else {
        if (order === 'post failure') pending.get(second)!.fail(new Error('panel rejected delivery'));
        else pending.get(second)!.accept(false);
        pending.get(first)!.accept(true);
      }
      await vi.waitFor(() => assert.equal(name(first), 'Recovered peer title'));
      defer = false;
      if (order === 'accepted first') {
        await provider.refresh(true, true, true, true);
        assert.ok(
          provider.metadataRevision > provider.drawnMetadataRevision,
          'a selected-only post consumed an unpublished peer title',
        );
      }
      await provider.refresh();
      assert.equal(name(second), 'Recovered peer title', "one panel consumed another panel's unpublished title");
      assert.equal(provider.metadataRevision, provider.drawnMetadataRevision);
      const posts = [...delivered.values()].reduce((count, messages) => count + messages.length, 0);
      await provider.refresh();
      assert.equal(
        [...delivered.values()].reduce((count, messages) => count + messages.length, 0),
        posts,
        'successful hosts never settled idle',
      );
      assert.equal(provider.spendOffers.length, 1, 'title retries restarted unchanged spend sources');
    } finally {
      for (const post of pending.values()) post.accept(false);
      provider.abandonCatalogRefresh();
      worker.stop();
    }
  });
}

for (const unavailable of ['hidden', 'disposed']) {
  test(`a ${unavailable} panel does not keep recovered Codex titles pending`, async () => {
    const directory = tempDir('title-inactive-post-');
    const session = titleRollout(directory, 'peer', 'Recovered peer title');
    const worker = titleWorker();
    const provider = titlePublicationHarness(
      [session],
      (request: ProgressiveRequest, generation: number, signal: AbortSignal) => {
        if (request.kind === 'starts') return Promise.reject(new Error('record temporarily unavailable'));
        return worker.run(request, generation, signal);
      },
    );
    const first = provider.hosts[0];
    let visible = true;
    const second = { webview: {}, active: () => false, visible: () => visible };
    provider.hosts.push(second);
    provider.readyHosts.add(second);
    let acceptFirst: ((value: boolean) => void) | undefined;
    provider.sendToHost = (host: any, message: any) => {
      provider.messages.push(message);
      return host === first
        ? new Promise<boolean>((resolve) => {
            acceptFirst = resolve;
          })
        : Promise.resolve(false);
    };
    try {
      await provider.refresh(true);
      assert.ok(acceptFirst);
      if (unavailable === 'hidden') visible = false;
      else {
        provider.hosts = [first];
        provider.readyHosts.delete(second);
      }
      acceptFirst(true);
      await vi.waitFor(() => assert.equal(provider.metadataRevision, provider.drawnMetadataRevision));
      const posts = provider.messages.length;
      await provider.refresh();
      assert.equal(provider.messages.length, posts, 'an unavailable panel forced idle title retries');
      if (unavailable === 'hidden') {
        visible = true;
        provider.sendToHost = (_host: any, message: any) => {
          provider.messages.push(message);
          return Promise.resolve(true);
        };
        await provider.refresh(true);
        assert.equal(
          provider.messages.at(-1).rail.find((row: any) => row.id === session.sessionId).label,
          'Recovered peer title',
        );
      }
    } finally {
      acceptFirst?.(false);
      provider.abandonCatalogRefresh();
      worker.stop();
    }
  });
}

test('obsolete panel acknowledgements preserve newer unpublished Codex titles', async () => {
  const directory = tempDir('title-obsolete-post-');
  const session = titleRollout(directory, 'peer', 'Recovered peer title');
  const worker = titleWorker();
  const provider = titlePublicationHarness(
    [session],
    (request: ProgressiveRequest, generation: number, signal: AbortSignal) => {
      if (request.kind === 'starts') return Promise.reject(new Error('record temporarily unavailable'));
      return worker.run(request, generation, signal);
    },
  );
  const second = { webview: {}, active: () => false, visible: () => true };
  provider.hosts.push(second);
  provider.readyHosts.add(second);
  const oldPosts: ((value: boolean) => void)[] = [];
  provider.sendToHost = () => new Promise<boolean>((resolve) => oldPosts.push(resolve));
  try {
    await provider.refresh(true);
    assert.equal(oldPosts.length, 2);
    provider.abandonCatalogRefresh();
    const newer = {
      ...provider.titles.get(session.file),
      label: 'Newer accepted title',
      fullLabel: 'Newer accepted title',
    };
    provider.storeTitleEntry(session.file, newer);
    provider.sendToHost = () => Promise.resolve(false);
    await provider.refresh();
    const drawn = provider.drawnMetadataRevision;
    for (const accept of oldPosts) accept(true);
    await provider.refresh(true, true, true, true);
    assert.equal(provider.drawnMetadataRevision, drawn, 'obsolete panel callbacks consumed newer publication demand');
    provider.sendToHost = (_host: any, message: any) => {
      provider.messages.push(message);
      return Promise.resolve(true);
    };
    await provider.refresh();
    assert.equal(
      provider.messages.at(-1).rail.find((row: any) => row.id === session.sessionId).label,
      'Newer accepted title',
    );
    assert.equal(provider.metadataRevision, provider.drawnMetadataRevision);
  } finally {
    for (const accept of oldPosts) accept(false);
    provider.abandonCatalogRefresh();
    worker.stop();
  }
});

test('accepted Codex names survive a later cancelled metadata read and unchanged replacement', async () => {
  const directory = tempDir('title-cancel-');
  const selected = titleRollout(directory, 'selected', 'Selected session');
  const sessions = [
    titleRollout(directory, 'first', 'First accepted title'),
    titleRollout(directory, 'later', 'Later title'),
  ];
  const worker = titleWorker();
  let phase = 'startup';
  let release: (() => void) | undefined;
  const provider = titlePublicationHarness(
    [selected, ...sessions],
    async (request: ProgressiveRequest, generation: number, signal: AbortSignal) => {
      if (
        request.kind === 'starts' ||
        (phase === 'startup' && 'session' in request && request.session.sessionId !== selected.sessionId)
      )
        throw new Error('record temporarily unavailable');
      if ('session' in request && request.session.sessionId === 'later') {
        if (phase === 'replacement') throw new Error('record temporarily unavailable');
        const result = await worker.run(request, generation, signal);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return result;
      }
      return worker.run(request, generation, signal);
    },
  );
  provider._showing = selected.sessionId;
  try {
    await provider.refresh(true);
    phase = 'recovery';
    const interrupted = provider.refresh();
    await vi.waitFor(() => assert.ok(release));
    assert.equal(provider.titles.get(sessions[0].file)?.label, 'First accepted title');
    provider.abandonCatalogRefresh();
    phase = 'replacement';
    await provider.refresh(false, true);
    assert.equal(provider.messages.at(-1).rail.find((row: any) => row.id === 'first').label, 'First accepted title');
    const published = provider.drawnMetadataRevision;
    release!();
    await interrupted;
    assert.equal(provider.titles.has(sessions[1].file), false, 'obsolete metadata completion replaced current facts');
    assert.equal(provider.drawnMetadataRevision, published, 'obsolete completion consumed publication demand');
    assert.equal(provider.spendOffers.length, 1);
  } finally {
    release?.();
    provider.abandonCatalogRefresh();
    worker.stop();
  }
});

for (const agent of ['codex', 'claude']) {
  for (const interruption of ['failure', 'cancellation']) {
    test(`a recovered ${agent} enrichment title reaches the session list after a later ${interruption}`, async () => {
      const directory = tempDir('title-enrichment-');
      const selected = titleRollout(directory, 'selected', 'Selected session');
      let session = titleRollout(directory, 'recovered', 'Recovered enrichment title');
      const later = titleRollout(directory, 'later', 'Later session');
      selected.activity = 3;
      session.activity = 2;
      const refused = path.join(directory, 'refused-head');
      if (agent === 'claude') {
        const padding = JSON.stringify({ type: 'ignored', text: 'x'.repeat(300000) }) + '\n';
        fs.writeFileSync(
          session.file,
          padding +
            JSON.stringify({ type: 'custom-title', customTitle: 'Recovered enrichment title' }) +
            '\n' +
            padding,
        );
        const stat = fs.statSync(session.file);
        session = { ...session, agent, size: stat.size, mtimeMs: stat.mtimeMs };
      } else {
        fs.writeFileSync(refused, 'refuse');
      }
      // The Codex tail stays readable while the first title-head read fails.
      const worker = titleWorker(`
        const nativeOpen = require('node:fs').openSync;
        require('node:fs').openSync = (...args) => {
          if (args[0] === ${JSON.stringify(session.file)} && require('node:fs').existsSync(${JSON.stringify(refused)}) && new Error().stack.includes('readCodexSessionTitlePair')) throw new Error('head temporarily unavailable');
          return nativeOpen(...args);
        };
      `);
      let phase = 'startup';
      let release: (() => void) | undefined;
      const requests: ProgressiveRequest[] = [];
      const provider = titlePublicationHarness(
        [selected, session, later],
        async (request: ProgressiveRequest, generation: number, signal: AbortSignal) => {
          requests.push(request);
          if (request.kind === 'starts') {
            if (
              phase === 'startup' ||
              (request.session.sessionId === later.sessionId && (interruption === 'failure' || phase === 'replacement'))
            )
              throw new Error('starts temporarily unavailable');
            if (request.session.sessionId === later.sessionId) {
              await new Promise<void>((resolve) => {
                release = resolve;
              });
              return null;
            }
          }
          return worker.run(request, generation, signal);
        },
      );
      provider._showing = selected.sessionId;
      // Saved lifetime starts keep the session list row count stable during enrichment.
      provider.lifetimeRailFacts = () =>
        Object.fromEntries([selected, session, later].map((row) => [row.sessionId, { newestTurnStartedAt: 1 }]));
      const drawnName = () => provider.messages.at(-1).rail.find((row: any) => row.id === session.sessionId).label;
      try {
        await provider.refresh(true);
        assert.equal(drawnName(), 'Session recovere');
        assert.equal(provider.titles.get(session.file).label, '', 'the initial read already found the name');
        const glanced = provider.windows.size;
        if (agent === 'codex') fs.unlinkSync(refused);
        phase = 'recovery';
        const interrupted = provider.refresh();
        if (interruption === 'cancellation') {
          await vi.waitFor(() => assert.ok(release));
          provider.abandonCatalogRefresh();
          release!();
        }
        await interrupted;
        assert.equal(provider.titles.get(session.file).label, 'Recovered enrichment title');
        assert.ok(
          requests.some(
            (request) =>
              request.kind === 'metadata' &&
              request.session.file === session.file &&
              request.tailBytes === RAIL_ENRICHMENT_READ_BYTES,
          ),
        );
        phase = 'replacement';
        await provider.refresh();
        await vi.waitFor(() => assert.equal(provider.refreshController, null));
        assert.equal(provider.windows.size, glanced, 'recovery changed glance cardinality');
        assert.equal(
          drawnName(),
          'Recovered enrichment title',
          'accepted enrichment never replaced the session identity label',
        );
        assert.equal(provider.spendOffers.length, 1, 'enrichment title publication restarted unchanged spend sources');
      } finally {
        release?.();
        provider.abandonCatalogRefresh();
        worker.stop();
      }
    });
  }
}

test('bounded startup metadata batches recover every Codex name and settle without idle reads', async () => {
  const directory = tempDir('title-batches-');
  const sessions = Array.from({ length: 110 }, (_, index) =>
    titleRollout(directory, `session-${index}`, `Prompt ${index}`, 1024 * 1024),
  );
  const worker = titleWorker();
  const requests: ProgressiveRequest[] = [];
  const charges = new Map<number, number>();
  const provider = titlePublicationHarness(
    sessions,
    (request: ProgressiveRequest, generation: number, signal: AbortSignal) => {
      requests.push(request);
      if (request.kind === 'metadata' && request.tailBytes === undefined) {
        charges.set(generation, (charges.get(generation) ?? 0) + metadataReadBudget(request.session));
      }
      return worker.run(request, generation, signal);
    },
  );
  const firstReadCounts: number[] = [];
  const send = provider.sendToHost.bind(provider);
  provider.sendToHost = (...args: any[]) => {
    firstReadCounts.push(
      requests.filter((request) => request.kind === 'metadata' && request.tailBytes === undefined).length,
    );
    return send(...args);
  };
  try {
    await provider.refresh(true);
    await vi.waitFor(() => assert.equal(provider.refreshController, null), { timeout: 10000 });
    assert.ok(firstReadCounts[0] < sessions.length, 'startup delayed its first draw until every title was read');
    assert.ok(charges.size >= 3, 'the catalog did not span several admission batches');
    assert.ok([...charges.values()].every((bytes) => bytes <= INITIAL_RAIL_READ_BYTES));
    const rail = provider.messages.at(-1).rail;
    for (let index = 0; index < sessions.length; index++) {
      assert.equal(rail.find((row: any) => row.id === sessions[index].sessionId).label, `Prompt ${index}`);
    }
    const admitted = requests.filter((request) => request.kind === 'metadata' && request.tailBytes === undefined);
    assert.equal(admitted.length, sessions.length, 'accepted entries repeated bounded title reads');
    const before = { reads: requests.length, draws: provider.messages.length, offers: provider.spendOffers.length };
    await provider.refresh(false, true);
    await provider.refresh(false, true);
    assert.deepEqual(
      { reads: requests.length, draws: provider.messages.length, offers: provider.spendOffers.length },
      before,
    );
    assert.ok(provider.messages.length < sessions.length, 'startup redrew once for each title');
  } finally {
    provider.abandonCatalogRefresh();
    worker.stop();
  }
});

test('metadata completed before another append keeps the revision that supplied its facts', async () => {
  const listed = { file: 'active.jsonl', sessionId: 'active', agent: 'claude' as const, size: 10, mtimeMs: 10 };
  const provider = metadataHarness(async (_request, generation) => ({
    generation,
    revision: { size: 10, mtimeMs: 10, dev: 1, ino: 2 },
    value: {
      kind: 'metadata',
      coverage: { whole: true, windowBytes: 16 * 1024 * 1024 },
      entry: {
        size: 10,
        mtimeMs: 10,
        label: 'Active',
        fullLabel: 'Active session',
        activityMs: 1,
        agentRun: false,
        outcome: null,
        stats: null,
        foldedLabel: 'active',
      },
    },
  }));

  assert.equal(await provider.prepareMetadata([listed], 1, new AbortController().signal), true);
  assert.deepEqual(
    { size: provider.titles.get(listed.file).size, mtimeMs: provider.titles.get(listed.file).mtimeMs },
    { size: 10, mtimeMs: 10 },
    'metadata facts were relabelled with a revision they did not read',
  );
});

// The first session list reports names from new reads and cached entries to SessionNames.

test('the first rail reports the name of a session it read and of one it kept', async () => {
  const names = new SessionNames();
  // The parsed custom name outranks the cached generated name.

  names.observe(
    'kept',
    { label: 'Owner name', fullLabel: 'Owner name', source: 'custom', at: 15 },
    { size: 20, headKey: 'k', ino: 2 },
  );
  const read = { file: 'read.jsonl', sessionId: 'read', agent: 'claude' as const, size: 10, mtimeMs: 10 };
  const kept = { file: 'kept.jsonl', sessionId: 'kept', agent: 'claude' as const, size: 20, mtimeMs: 20 };
  const provider = metadataHarness(
    async (_request, generation) => ({
      generation,
      revision: { size: 10, mtimeMs: 10, dev: 1, ino: 2 },
      value: {
        kind: 'metadata',
        coverage: { whole: true, windowBytes: 16 * 1024 * 1024 },
        entry: {
          size: 10,
          mtimeMs: 10,
          label: 'Read name',
          fullLabel: 'Read name',
          activityMs: 1,
          agentRun: false,
          outcome: null,
          stats: null,
          foldedLabel: 'read name',
          nameSource: 'custom' as const,
          nameAt: 9,
          headKey: 'r',
        },
      },
    }),
    names,
  );
  provider.revision = { size: 10, mtimeMs: 10, dev: 1, ino: 2 };
  provider.titles.set(kept.file, {
    size: 20,
    mtimeMs: 20,
    label: 'Kept name',
    fullLabel: 'Kept name',
    activityMs: 2,
    agentRun: false,
    outcome: null,
    stats: null,
    foldedLabel: 'kept name',
    nameSource: 'generated',
    nameAt: 19,
    headKey: 'k',
  });

  assert.equal(await provider.prepareMetadata([kept, read], 1, new AbortController().signal), true);
  assert.equal(
    names.get('kept')?.label,
    'Owner name',
    'a stored entry the first rail kept overwrote the higher name the panel already drew',
  );
  assert.equal(names.get('read')?.label, 'Read name', 'a metadata read the first rail took never reported its name');
  assert.equal(
    storedSessionName(provider.titles.get(kept.file))?.source,
    'custom',
    'the entry a kept session leaves holds the lower name, so a restart loses the one the panel drew',
  );
});

// Cached metadata consumes no read budget. Count revisionOf calls across 500 cached sessions to detect per-session filesystem work.

test('a first rail over a cached catalog reads no file for the sessions it keeps', async () => {
  const names = new SessionNames();
  const sessions = Array.from({ length: 500 }, (_unused, index) => ({
    file: `cached-${index}.jsonl`,
    sessionId: `cached-${index}`,
    agent: 'claude' as const,
    size: 20,
    mtimeMs: 20,
    ino: 100 + index,
  }));
  const provider = metadataHarness(async () => {
    throw new Error('the first rail read a session the derived cache already answered');
  }, names);
  let stats = 0;
  provider.revisionOf = () => {
    stats++;
    return provider.revision;
  };
  for (const session of sessions) {
    provider.titles.set(session.file, {
      size: 20,
      mtimeMs: 20,
      label: 'Cached name',
      fullLabel: 'Cached name',
      activityMs: 2,
      agentRun: false,
      outcome: null,
      stats: null,
      foldedLabel: 'cached name',
      nameSource: 'custom',
      nameAt: 19,
      headKey: 'c',
    });
  }

  assert.equal(await provider.prepareMetadata(sessions, 1, new AbortController().signal), true);
  assert.equal(stats, 0, 'the first rail stats every cached session on the extension host thread');
  assert.equal(names.get('cached-499')?.label, 'Cached name', 'a cached session never reported its name');
});

// Large Claude sessions reserve a prompt-head read. A title in the tail reduces the actual head read to 4 KiB.

test('the first rail gives back the prompt head a titled session did not read', async () => {
  const size = 1024 * 1024;
  const sessions = Array.from({ length: 400 }, (_, index) => ({
    file: `large-${index}.jsonl`,
    sessionId: `large-${index}`,
    agent: 'claude' as const,
    size,
    mtimeMs: 1,
  }));
  let reads = 0;
  const provider = metadataHarness(async (_request, generation) => {
    reads++;
    return {
      generation,
      revision: { size, mtimeMs: 1, dev: 1, ino: 2 },
      value: {
        kind: 'metadata',
        coverage: { whole: true, windowBytes: 16 * 1024 * 1024 },
        entry: {
          size,
          mtimeMs: 1,
          label: 'Titled',
          fullLabel: 'Titled',
          activityMs: 1,
          agentRun: false,
          outcome: null,
          stats: null,
          foldedLabel: 'titled',
          nameSource: 'generated' as const,
          nameAt: size - 100,
          headKey: 'h',
        },
      },
    };
  });
  provider.revision = { size, mtimeMs: 1, dev: 1, ino: 2 };

  assert.equal(await provider.prepareMetadata(sessions, 1, new AbortController().signal), true);
  // The expected read count uses fixed head and tail charges and the refunded head bytes.

  const charge = 256 * 1024 + SESSION_HEAD_BYTES;
  const net = charge - (SESSION_HEAD_BYTES - HEAD_KEY_BYTES);
  assert.equal(
    reads,
    Math.floor((INITIAL_RAIL_READ_BYTES - charge) / net) + 1,
    'the first rail read a number of large titled sessions the 64 MiB budget does not buy',
  );
  assert.equal(
    unreadHeadBytes({ agent: 'claude', size }, { nameSource: 'prompt' }),
    0,
    'a session named by its first prompt was refunded a head it did read',
  );
  assert.equal(
    unreadHeadBytes({ agent: 'claude', size: 1000 }, { nameSource: 'generated' }),
    0,
    'a session inside the tail window was refunded a head the budget never charged',
  );
});

// The fixture cache uses a different VERSION and retains Codex, Claude, and child names beyond the first metadata pass.

function bumpedDerivedCache() {
  const cacheFile = path.join(tempDir('derived-names-'), 'derived-session-cache.json');
  const codex = {
    file: 'fixture/codex.jsonl',
    sessionId: '01a08461-0000-7000-8000-000000000001',
    agent: 'codex' as const,
    size: 1000,
    mtimeMs: 10,
    ino: 2,
  };
  const claude = {
    file: 'fixture/claude.jsonl',
    sessionId: '6f2c1d9e-0000-4000-8000-000000000002',
    agent: 'claude' as const,
    size: 1000,
    mtimeMs: 10,
    ino: 2,
  };
  const child = {
    file: 'fixture/claude-child.jsonl',
    sessionId: 'agent-child',
    agent: 'claude' as const,
    childTranscript: true,
    size: 1000,
    mtimeMs: 10,
    ino: 2,
  };
  const ahead = Array.from({ length: 100 }, (_unused, index) => ({
    file: `ahead-${index}.jsonl`,
    sessionId: `ahead-${index}`,
    agent: 'codex' as const,
    size: 1024 * 1024,
    mtimeMs: 10,
    ino: 2,
  }));
  const stored = (label: string) => ({
    size: 1000,
    mtimeMs: 10,
    label,
    fullLabel: `${label} in full`,
    activityMs: 1,
    agentRun: false,
    outcome: null,
    stats: null,
    foldedLabel: label.toLowerCase(),
  });
  fs.writeFileSync(
    cacheFile,
    JSON.stringify({
      version: VERSION - 1,
      titles: [
        { file: codex.file, entry: stored('Codex stored name') },
        { file: claude.file, entry: stored('Claude stored name') },
        { file: child.file, entry: stored('Child stored name') },
      ],
    }),
  );
  const reads: string[] = [];
  // The metadata worker. A reread of either named session finds a newer name.
  const run = async (request: ProgressiveRequest, generation: number): Promise<ProgressiveResult> => {
    const session = (request as { session: { file: string; size: number; mtimeMs: number } }).session;
    reads.push(session.file);
    const renamed = new Map([
      [codex.file, 'Codex read name'],
      [claude.file, 'Claude read name'],
    ]);
    const label = renamed.get(session.file) ?? session.file;
    return {
      generation,
      revision: { size: session.size, mtimeMs: session.mtimeMs, dev: 1, ino: 2 },
      value: {
        kind: 'metadata',
        coverage: { whole: true, windowBytes: 16 * 1024 * 1024 },
        entry: {
          size: session.size,
          mtimeMs: session.mtimeMs,
          label,
          fullLabel: label,
          activityMs: 1,
          agentRun: false,
          outcome: null,
          stats: null,
          foldedLabel: label.toLowerCase(),
          nameSource: 'generated',
          nameAt: 5,
          headKey: 'h',
        },
      },
    };
  };
  return { cacheFile, codex, claude, child, catalog: [...ahead, codex, claude], reads, run };
}

test('a bounded pass after a derived cache version bump keeps the stored names of the rows it skips until their reread', async () => {
  const { cacheFile, codex, claude, catalog, reads, run } = bumpedDerivedCache();
  const provider = metadataHarness(run, new SessionNames(), cacheFile);
  const drawn = () => [codex, claude].map((session) => provider.sessionLabel(session));

  assert.equal(await provider.prepareMetadata(catalog, 1, new AbortController().signal), true);
  assert.ok(
    !reads.includes(codex.file) && !reads.includes(claude.file),
    'the first bounded pass reached both named sessions, so it no longer leaves a row unread',
  );
  assert.deepEqual(
    drawn(),
    [
      { label: 'Codex stored name', fullLabel: 'Codex stored name in full' },
      { label: 'Claude stored name', fullLabel: 'Claude stored name in full' },
    ],
    'a row the bounded pass skipped lost the name the old cache file stored',
  );

  assert.equal(await provider.prepareMetadata([codex, claude], 1, new AbortController().signal), true);
  assert.deepEqual(
    drawn(),
    [
      { label: 'Codex read name', fullLabel: 'Codex read name' },
      { label: 'Claude read name', fullLabel: 'Claude read name' },
    ],
    'a reread name never replaced the name the old cache file stored',
  );
});

// Restores a derived-cache fixture through catalog discovery and naming methods.
// The metadata harness reads no source bytes. codexWalk controls the returned Codex listing.
function bumpedCatalogHarness(
  scope: Record<string, unknown> = {},
  realSelectedWindow = false,
  extraMethods: string[] = [],
) {
  const { cacheFile, codex, claude, child } = bumpedDerivedCache();
  const codexWalk = [codex];
  const claudeWalk = [claude];
  const provider = completeDiscoveryHarness(
    undefined,
    realSelectedWindow,
    [
      'allSessions',
      'prepareClaudeChildren',
      'pruneDerivedTitles',
      'sessionLabel',
      'claudeName',
      'titleFor',
      'metaFor',
      ...extraMethods,
    ],
    {
      projectsRoot: () => 'projects',
      productionNormalizeFsPath: normalizeFsPath,
      enumerateSessionFilesFor: () => ({
        sessions: [...claudeWalk],
        files: claudeWalk.map((source) => source.file),
        status: 'complete',
        uncertain: [],
      }),
      enumerateClaudeChildSources: (parents: SessionFile[]) => {
        const sessions = parents.filter((session) => session.childTranscript);
        return {
          sessions,
          files: sessions.map((session) => session.file),
          directories: ['fixture'],
          status: 'complete',
          uncertain: [],
        };
      },
      CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
      codexSessionsRoot: () => 'sessions',
      codexSessionFiles: () => ({
        walked: codexWalk.map((session) => session.file),
        sessions: [...codexWalk],
        subagents: [],
        sources: [],
        enumeration: { status: 'complete', files: codexWalk.map((source) => source.file), uncertain: [] },
        admission: 'complete',
      }),
      readRolloutStat: () => null,
      staleMetas: () => [],
      discoverClaudeSessionSpendSources: () => [],
      sameClaudeChildReferenceCaches: () => true,
      sameSessionRevision,
      codexTitleFor,
      ...scope,
    },
  );
  const restored = loadDerivedCache(cacheFile);
  Object.assign(provider, {
    titles: restored.titles,
    carriedNames: restored.carriedNames,
    claudeChildReferenceEntries: restored.claudeChildReferences,
    claudeChildren: [],
    claudeChildStatWrites: new Map(),
    repositoryScope: { snapshot: () => ({ ready: true, roots: ['project'], revision: 1 }) },
    cwds: new Map(),
    codexMetas: { keys: () => [], revision: 1 },
    codexStats: new Map(),
    codexOpenings: null,
    subagentDirectories: { sweep() {} },
    derivedCacheCheckpointState: { markChanged() {} },
    humanScans: new Map(),
    hasHumanPrompt(session: any) {
      this.humanScans.set(session.file, { found: true });
      return true;
    },
    updateSessionSpendSources() {},
    threadNames: { names: new Map(), fullNames: new Map() },
    progressiveWorker: {
      run: (_request: ProgressiveRequest, generation: number) =>
        Promise.resolve({
          generation,
          value: {
            compatibility: discoveryCompatibility(CLAUDE_CHILD_REFERENCE_PARSER_VERSION),
            kind: 'claude-children',
            roots: _request.kind === 'claude-children' ? _request.parents : [],
            complete: true,
            continuation: false,
            references: [],
            dispatchFacts: [],
            children: [child],
            referenceEntries: [],
          },
        }),
    },
  });
  return { provider, codex, claude, child, codexWalk, claudeWalk };
}

test.each(['unresolved scope', 'reused catalog', 'targeted catalog'])(
  'a cold enumeration discarded by %s does not omit a new rollout from the next accepted catalog',
  async (earlyReturn) => {
    const root = tempDir('enumeration-owner-');
    const workspace = path.join(root, 'project');
    fs.mkdirSync(workspace);
    const writeRollout = (id: string) => {
      const file = path.join(root, `rollout-${id}.jsonl`);
      fs.writeFileSync(
        file,
        `${JSON.stringify({
          timestamp: '2026-10-01T12:00:00.000Z',
          type: 'session_meta',
          payload: { id, cwd: workspace, source: 'vscode' },
        })}\n`,
      );
      return file;
    };
    const earlier = writeRollout('earlier');
    const cache = new CodexMetaCache();
    let listingCalls = 0;
    const { provider, claudeWalk } = bumpedCatalogHarness({
      codexSessionsRoot: () => root,
      codexSessionFiles: (...args: Parameters<typeof codexSessionFiles>) => {
        listingCalls += 1;
        return codexSessionFiles(...args);
      },
      readRolloutStat,
      fs,
      fileRevisionOf,
      revalidatedCatalogPaths,
    });
    claudeWalk.splice(0);
    provider.claudeChildren = [];
    provider.codexMetas = cache;
    provider.codexStats = new CodexStatCache();
    provider.folders = () => [workspace];
    let ready = earlyReturn !== 'unresolved scope';
    provider.repositoryScope = { snapshot: () => ({ ready, roots: [workspace], revision: 1 }) };
    provider.prepareClaudeChildren = () => {
      provider.discoveryComplete = {
        scope: JSON.stringify(provider.repositoryScopeRoots),
        files: new Set(provider.catalog.sessions.map((session: SessionFile) => session.file)),
      };
      return Promise.resolve(true);
    };
    provider.prepareMetadata = () => Promise.resolve(true);
    provider.codexColdReads = null;
    if (ready) {
      await provider.refresh(true);
      assert.deepEqual(
        provider.authoritativeCatalog.map((session: SessionFile) => session.file),
        [earlier],
      );
    }
    provider.codexColdReads = () => coldOpeningPass(cache, root);
    provider.targetedRefreshPaths = earlyReturn === 'targeted catalog' ? [earlier] : null;
    const beforeEarlyReturn = listingCalls;
    await provider.refresh(true, earlyReturn === 'reused catalog');
    assert.equal(listingCalls, beforeEarlyReturn, 'the expected early return performed a broad listing');
    if (!ready) assert.equal(provider.authoritativeCatalog, null);
    const added = writeRollout('added');
    ready = true;
    provider.targetedRefreshPaths = null;
    await provider.refresh(true);
    assert.deepEqual(
      provider.authoritativeCatalog.map((session: SessionFile) => session.file).sort(),
      [earlier, added].sort(),
      'the first accepted resolved catalog omitted the rollout created after the discarded enumeration',
    );
  },
);

test('a cold handoff accepts the catalog without enumerating the rollout directory twice', async () => {
  const root = tempDir('enumeration-single-walk-');
  const { provider, claudeWalk } = bumpedCatalogHarness({
    codexSessionFiles,
    readRolloutStat,
    codexSessionsRoot: () => root,
  });
  claudeWalk.splice(0);
  const file = path.join(root, 'rollout-only.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id: 'only', cwd: 'project' } })}\n`);
  const cache = new CodexMetaCache();
  provider.codexMetas = cache;
  provider.codexColdReads = async () => {
    const pass = await coldOpeningPass(cache, root);
    provider.directoryReads = vi.spyOn(mutableFs, 'readdirSync');
    syncBuiltinESMExports();
    return pass;
  };
  provider.prepareClaudeChildren = () => Promise.resolve(true);
  try {
    await provider.refresh(true);
    assert.deepEqual(
      provider.authoritativeCatalog.map((session: SessionFile) => session.file),
      [file],
    );
    assert.equal(
      provider.directoryReads.mock.calls.filter(([directory]: [fs.PathLike]) => String(directory) === root).length,
      0,
      'catalog assembly repeated the cold traversal',
    );
  } finally {
    provider.directoryReads?.mockRestore();
    syncBuiltinESMExports();
  }
});

// A real Codex listing over a temporary rollout root, with every asynchronous walk held until the test releases it.
function heldWalkHarness(scope: Record<string, unknown> = {}, extraMethods: string[] = []) {
  const root = tempDir('enumeration-async-');
  const workspace = path.join(root, 'project');
  fs.mkdirSync(workspace);
  const writeRollout = (id: string) => {
    const file = path.join(root, `rollout-${id}.jsonl`);
    fs.writeFileSync(
      file,
      `${JSON.stringify({
        timestamp: '2026-10-01T12:00:00.000Z',
        type: 'session_meta',
        payload: { id, cwd: workspace, source: 'vscode' },
      })}\n`,
    );
    return file;
  };
  const walks: { root: string; release: () => void }[] = [];
  let currentRoot = root;
  const { provider, claudeWalk } = bumpedCatalogHarness(
    {
      codexSessionsRoot: () => currentRoot,
      codexSessionFiles,
      readRolloutStat,
      fs,
      fileRevisionOf,
      revalidatedCatalogPaths,
      path,
      enumerateRolloutFilesAsync: (walkRoot: string, signal?: AbortSignal) =>
        new Promise((resolve) => {
          // An asynchronous reader, so a synchronous read of the tree can only come from the synchronous driver.
          const reader = (dir: string) => mutableFs.promises.readdir(dir, { withFileTypes: true });
          walks.push({
            root: walkRoot,
            release: () => void enumerateRolloutFilesAsync(walkRoot, signal, reader).then(resolve),
          });
        }),
      ...scope,
    },
    false,
    extraMethods,
  );
  claudeWalk.splice(0);
  provider.claudeChildren = [];
  provider.codexMetas = new CodexMetaCache();
  provider.codexStats = new CodexStatCache();
  provider.codexColdReads = null;
  provider.folders = () => [workspace];
  provider.repositoryScope = { snapshot: () => ({ ready: true, roots: [workspace], revision: 1 }) };
  provider.prepareClaudeChildren = () => {
    provider.discoveryComplete = {
      scope: JSON.stringify(provider.repositoryScopeRoots),
      files: new Set(provider.catalog.sessions.map((session: SessionFile) => session.file)),
    };
    return Promise.resolve(true);
  };
  provider.prepareMetadata = () => Promise.resolve(true);
  const files = () => provider.authoritativeCatalog?.map((session: SessionFile) => session.file).sort() ?? null;
  const releaseAll = async (refresh: Promise<void>) => {
    let released = 0;
    const state = { done: false };
    void refresh.finally(() => (state.done = true));
    while (!state.done) {
      await vi.waitFor(() => assert.ok(state.done || walks.length > released, 'the refresh stalled without a walk'));
      while (walks.length > released) walks[released++].release();
    }
    await refresh;
  };
  return {
    provider,
    root,
    walks,
    files,
    writeRollout,
    releaseAll,
    moveRoot: (next: string) => (currentRoot = next),
    currentRoot: () => currentRoot,
  };
}

test('a broad refresh lists Codex rollouts from an asynchronous walk without a synchronous directory read', async () => {
  const { provider, root, walks, files, writeRollout } = heldWalkHarness();
  const file = writeRollout('first');
  const reads = vi.spyOn(mutableFs, 'readdirSync');
  syncBuiltinESMExports();
  try {
    const refresh = provider.refresh(true);
    await vi.waitFor(() => assert.equal(walks.length, 1, 'the broad refresh did not start an asynchronous walk'));
    assert.equal(provider.authoritativeCatalog, null, 'the catalog was accepted before the walk finished');
    walks[0].release();
    await refresh;
    assert.deepEqual(files(), [file]);
    assert.equal(
      (reads.mock.calls as unknown[][]).filter((call) => String(call[0]).startsWith(root)).length,
      0,
      'the broad refresh walked the rollout tree with the synchronous driver',
    );
  } finally {
    reads.mockRestore();
    syncBuiltinESMExports();
  }
});

test.each(['canceled refresh', 'newer generation', 'hidden panel', 'changed root'])(
  'an asynchronous walk finished after a %s never becomes the catalog',
  async (change) => {
    const { provider, root, walks, files, writeRollout, moveRoot } = heldWalkHarness();
    const earlier = writeRollout('earlier');
    const first = provider.refresh(true);
    await vi.waitFor(() => assert.equal(walks.length, 1));
    walks[0].release();
    await first;
    assert.deepEqual(files(), [earlier]);
    const accepted = provider.authoritativeCatalog;
    writeRollout('added');
    const second = provider.refresh(true);
    await vi.waitFor(() => assert.equal(walks.length, 2));
    if (change === 'canceled refresh') provider.refreshController.abort();
    if (change === 'newer generation') provider.refreshGeneration++;
    if (change === 'hidden panel') provider.anyVisible = () => false;
    if (change === 'changed root') moveRoot(path.join(root, 'elsewhere'));
    walks[1].release();
    await second;
    assert.equal(provider.authoritativeCatalog, accepted, `a walk that outlived its ${change} replaced the catalog`);
    assert.equal(walks.length, 2, `the ${change} started another walk inside the obsolete refresh`);
  },
);

test.each(['an abandoned refresh', 'a rollout root change', 'the last panel closing and reopening'])(
  'a cold opening pass finished after %s never becomes the catalog',
  async (change) => {
    const { provider, walks, files, writeRollout, moveRoot, currentRoot } = heldWalkHarness();
    const earlier = writeRollout('earlier');
    const held: (() => void)[] = [];
    // The production pass reads the rollout root when it starts. The test holds its finished answer.
    provider.codexColdReads = (signal: AbortSignal) =>
      coldOpeningPass(provider.codexMetas, currentRoot(), signal).then(
        (pass) => new Promise((resolve) => held.push(() => resolve(pass))),
      );
    let visible = true;
    provider.anyVisible = () => visible;
    const first = provider.refresh(true);
    await vi.waitFor(() => assert.equal(held.length, 1, 'the cold pass did not finish its walk'));
    let expected = [earlier, writeRollout('added')].sort();
    if (change === 'an abandoned refresh') provider.abandonCatalogRefresh();
    if (change === 'a rollout root change') {
      const moved = tempDir('enumeration-moved-');
      moveRoot(moved);
      const file = path.join(moved, 'rollout-moved.jsonl');
      fs.writeFileSync(
        file,
        `${JSON.stringify({ type: 'session_meta', payload: { id: 'moved', cwd: provider.folders()[0], source: 'vscode' } })}\n`,
      );
      expected = [file];
    }
    if (change === 'the last panel closing and reopening') {
      visible = false;
      provider.abandonCatalogRefresh();
      visible = true;
    }
    // The trigger that follows the change waits behind the cold pass.
    provider.refreshFrom('watch', true);
    held[0]();
    await first;
    assert.equal(provider.authoritativeCatalog, null, `the cold pass finished after ${change} and became the catalog`);
    if (change === 'a rollout root change') {
      await vi.waitFor(() => assert.equal(walks.length, 1, 'the waiting refresh did not walk the rollout tree again'));
      walks[0].release();
    } else {
      // Abandoning the refresh hands the cold pass back, so the next refresh runs it again.
      await vi.waitFor(() =>
        assert.equal(held.length, 2, 'the refresh after the cancellation did not start a cold pass'),
      );
      held[1]();
    }
    await vi.waitFor(() => assert.deepEqual(files(), expected));
  },
);

test.each(['closing', 'closing and reopening'])(
  'the last panel %s during a cold walk stops the pass before its opening reads',
  async (change) => {
    const { provider, root, walks, files, writeRollout } = heldWalkHarness();
    const day = path.join(root, '2026', '10', '16');
    fs.mkdirSync(day, { recursive: true });
    const nested = path.join(day, 'rollout-nested.jsonl');
    fs.writeFileSync(
      nested,
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'nested', cwd: provider.folders()[0], source: 'vscode' } })}\n`,
    );
    const expected = [writeRollout('top'), nested].sort();
    const signals: AbortSignal[] = [];
    provider.codexColdReads = (signal: AbortSignal) => {
      signals.push(signal);
      return coldOpeningPass(provider.codexMetas, root, signal);
    };
    const primes = vi.spyOn(provider.codexMetas, 'prime');
    let visible = true;
    provider.anyVisible = () => visible;
    const reads: string[] = [];
    let readsAtClose = -1;
    let canceled: unknown;
    let waitedOn: unknown;
    let reopened: Promise<void> | undefined;
    const read = mutableFs.readdirSync;
    // Each read spends a whole slice, so the walk yields after it. The panel closes during the yield after the second read.
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const close = () => {
      readsAtClose = reads.length;
      canceled = provider.codexPriming;
      visible = false;
      provider.abandonCatalogRefresh();
      if (change === 'closing and reopening') {
        visible = true;
        reopened = provider.refresh(true);
        waitedOn = provider.codexPriming;
      }
    };
    const spy = vi.spyOn(mutableFs, 'readdirSync').mockImplementation(((target: fs.PathLike, ...args: any[]) => {
      const answer = (read as any)(target, ...args);
      if (!String(target).startsWith(root)) return answer;
      reads.push(String(target));
      now += 1000;
      if (reads.length === 2 && readsAtClose < 0) setImmediate(close);
      return answer;
    }) as typeof fs.readdirSync);
    syncBuiltinESMExports();
    try {
      await provider.refresh(true);
      assert.ok(readsAtClose > 0, 'the panel never closed during the cold walk');
      if (change === 'closing') {
        assert.equal(reads.length, readsAtClose, 'the canceled cold walk kept reading directories');
        assert.equal(primes.mock.calls.length, 0, 'the canceled cold pass read opening records');
        assert.equal(provider.codexPriming, null, 'the canceled cold pass still held later requests');
        assert.ok(provider.codexColdReads, 'the canceled cold pass was not handed to the next refresh');
        return;
      }
      assert.ok(waitedOn && waitedOn !== canceled, 'the reopened panel waited behind the canceled cold pass');
      await reopened;
      assert.deepEqual(files(), expected);
      assert.equal(walks.length, 0, 'the reopened panel walked again after its cold pass');
      assert.deepEqual(
        primes.mock.calls.map((call) => call[4]),
        [signals[1]],
        'opening records were read by a pass other than the reopened one',
      );
    } finally {
      clock.mockRestore();
      spy.mockRestore();
      syncBuiltinESMExports();
    }
  },
);

test('targeted reuse avoids the broad walk, and a failed reuse performs exactly one walk', async () => {
  const { provider, walks, files, writeRollout, releaseAll } = heldWalkHarness();
  const held = writeRollout('held');
  await releaseAll(provider.refresh(true));
  assert.equal(walks.length, 1);
  fs.appendFileSync(held, '\n');
  provider.targetedRefreshPaths = [held];
  await provider.refresh(true);
  assert.equal(walks.length, 1, 'a successful targeted refresh walked the rollout tree');
  assert.deepEqual(files(), [held]);
  const added = writeRollout('added');
  provider.targetedRefreshPaths = [added];
  await releaseAll(provider.refresh(true));
  assert.equal(walks.length, 2, 'a failed targeted refresh did not walk exactly once');
  assert.deepEqual(files(), [added, held].sort());
});

test('each catalog walk names its requester, and the re-list after a replaced file names itself', async () => {
  let replaced: string[] = [];
  const { provider, walks, writeRollout, releaseAll } = heldWalkHarness(
    {
      replacedCatalogFiles: async () => replaced,
      watcherRefreshDecision,
      sessionDirectoryOwners,
      unknownPathShapes,
      unknownPathExtension,
    },
    ['runPendingWatch', 'unknownPathShapeOf'],
  );
  let counters = new PanelPerformanceCounters();
  provider.performanceCounters = counters;
  provider.pendingWatch = new PendingWatcherWake();
  const file = writeRollout('held');
  // The production call sites start the refresh without returning it, so hold the promise they start.
  const requested = (start: () => void) => {
    const refresh = provider.refresh;
    let started: Promise<void> | undefined;
    provider.refresh = (...args: unknown[]) => (started = refresh.apply(provider, args));
    try {
      start();
    } finally {
      provider.refresh = refresh;
    }
    assert.ok(started, 'the requester started no refresh');
    return releaseAll(started);
  };
  const walkCounts = () =>
    Object.fromEntries(Object.entries(counters.snapshot().work).filter(([name]) => name.startsWith('walk:')));
  await requested(() => provider.refreshFrom('startup', true));
  await requested(() => provider.refreshFrom('poll'));
  // A known path that changed identity fails targeted revalidation and walks.
  const copy = `${file}.copy`;
  fs.copyFileSync(file, copy);
  fs.renameSync(copy, file);
  provider.pendingWatch.noteFileEvent(path.dirname(file), path.basename(file), 'change', normalizeFsPath);
  await requested(() => provider.runPendingWatch({ cause: 'quiet', firstAt: 0, lastAt: 0, firedAt: 0 }));
  assert.equal(counters.snapshot().watcherDecisions.targeted, 1, 'the watcher batch was not targeted');
  replaced = [file];
  await releaseAll(provider.refresh(true, true));
  assert.equal(walks.length, 4);
  assert.deepEqual(walkCounts(), {
    'walk:replacedFiles': 1,
    'walk:requested:poll': 1,
    'walk:requested:startup': 1,
    'walk:requested:transcript': 1,
  });
  // Requests that wait behind a running refresh each count under their own name.
  provider.performanceCounters = counters = new PanelPerformanceCounters();
  replaced = [];
  const refresh = provider.refresh;
  const started: Promise<void>[] = [];
  provider.refresh = (...args: unknown[]) => {
    const run = refresh.apply(provider, args);
    started.push(run);
    return run;
  };
  try {
    provider.refreshFrom('trigger');
    await vi.waitFor(() => assert.equal(walks.length, 5, 'the first refresh did not reach its walk'));
    provider.refreshFrom('poll');
    provider.refreshFrom('child:tool');
    provider.refreshFrom('poll');
    await releaseAll(started[0]);
    assert.equal(started.length, 5, 'the waiting requests did not run once as one merged refresh');
    await releaseAll(started[4]);
  } finally {
    provider.refresh = refresh;
  }
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(counters.snapshot().work).filter(
        ([name]) => name.startsWith('walk:') || name.startsWith('coalesced:'),
      ),
    ),
    {
      'coalesced:child:tool': 1,
      'coalesced:poll': 2,
      'walk:requested:coalesced': 1,
      'walk:requested:trigger': 1,
    },
  );
});

// Claude transcripts and Codex rollouts on disk, with the poll tick, the watcher batches, the clock and the directory
// times driven by the test. `create` writes a file and moves its directory's time to the test clock, as the filesystem
// does for a new entry. `hidden` holds project directories that the walk lists but leaves out of its directory
// evidence, as when the poll's stat list misses a directory.
function pollWalkHarness() {
  const projects = tempDir('poll-walk-projects-');
  const project = path.join(projects, 'repo');
  const other = path.join(projects, 'other');
  fs.mkdirSync(project);
  fs.mkdirSync(other);
  const hidden = new Set<string>();
  let now = Date.parse('2026-10-27T12:00:00.000Z');
  const directoryTimes = new Map<string, number>();
  const create = (file: string, content = '{"type":"user"}\n') => {
    fs.writeFileSync(file, content);
    directoryTimes.set(path.dirname(file), now);
    return file;
  };
  const parent = path.join(project, 'parent.jsonl');
  fs.writeFileSync(parent, '{"type":"user"}\n');
  const subagents = path.join(project, 'parent', 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  fs.writeFileSync(path.join(subagents, 'agent-first.jsonl'), '{}\n');
  const harness = heldWalkHarness(
    {
      projectsRoot: () => projects,
      enumerateSessionFilesFor: () => {
        const listings = [project, other].map((directory) => enumerateSessionFiles(directory));
        return {
          status: 'complete',
          root: projects,
          sessions: listings.flatMap((listing) => listing.sessions),
          files: listings.flatMap((listing) => listing.files),
          directories: [project, other].filter((directory) => !hidden.has(directory)),
          uncertain: [],
        };
      },
      enumerateClaudeChildSources: (parents: SessionFile[]) => ({
        status: 'complete',
        sessions: [],
        files: [],
        directories: parents
          .filter((row) => row.agent === 'claude')
          .map((row) => path.join(path.dirname(row.file), row.sessionId, 'subagents')),
        uncertain: [],
      }),
      enumerateRolloutFilesAsync: (root: string, signal?: AbortSignal) => enumerateRolloutFilesAsync(root, signal),
      // The real selected revalidation, so a selection that no row holds misses the held catalog as in production.
      revalidatedCatalog,
      PollDirectoryGate,
      POLL_BACKSTOP_WALK_MS,
      sessionDirectoryOwners,
      childEventNamesFiles,
      listedFilesFor,
      watcherRefreshDecision,
      unknownPathShapes,
      unknownPathExtension,
      POLL_INTERVAL_MILLISECONDS: 5_000,
    },
    ['startPolling', 'pollCatalog', 'pollDirectories', 'runPendingWatch', 'unknownPathShapeOf', 'refreshFromChild'],
  );
  const { provider } = harness;
  const counters = new PanelPerformanceCounters();
  let discoveries = 0;
  const discover = provider.prepareClaudeChildren;
  // A directory that the test never moved keeps a time before the test clock starts.
  const before = now - 60_000;
  Object.assign(provider, {
    performanceCounters: counters,
    pendingWatch: new PendingWatcherWake(),
    newDrafts: {},
    watchDirectories() {},
    pollGate: new PollDirectoryGate(async (directory: string) => {
      if (!fs.existsSync(directory)) return null;
      const time = directoryTimes.get(directory) ?? before;
      return { mtimeMs: time, print: String(time) };
    }),
    prepareClaudeChildren: (...args: unknown[]) => {
      discoveries++;
      return discover(...args);
    },
  });
  const started: Promise<void>[] = [];
  const refresh = provider.refresh;
  provider.refresh = (...args: unknown[]) => {
    const run = refresh.apply(provider, args);
    started.push(run);
    return run;
  };
  // `vi.waitFor` advances a faked clock, so the wait for the directory stats yields without it.
  const settle = async () => {
    for (let turns = 0; provider.pollInFlight; turns++) {
      assert.ok(turns < 10_000, 'the poll never finished its directory stats');
      await new Promise((resolve) => setImmediate(resolve));
    }
    for (let index = 0; index < started.length; index++) await started[index];
  };
  let tick: () => void = () => assert.fail('polling never started');
  const at = (time: number) => vi.setSystemTime((now = time));
  // A watcher batch fires after its quiet interval.
  const watch = async (events: [string, 'rename' | 'change'][]) => {
    at(now + 200);
    for (const [file, kind] of events)
      provider.pendingWatch.noteFileEvent(path.dirname(file), path.basename(file), kind, normalizeFsPath);
    provider.runPendingWatch({ cause: 'quiet', firstAt: 0, lastAt: 0, firedAt: 0 });
    await settle();
  };
  const start = async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(now);
    provider.refreshFrom('startup', true);
    await settle();
    const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
      tick = callback;
      return 0;
    }) as typeof setInterval);
    try {
      provider.startPolling();
    } finally {
      interval.mockRestore();
    }
  };
  // One poll interval passes and the poll fires.
  const poll = async () => {
    at(now + 5_000);
    tick();
    await settle();
  };
  const walks = () =>
    Object.fromEntries(Object.entries(counters.snapshot().work).filter(([name]) => name.startsWith('walk:')));
  const listed = (file: string) =>
    (provider.authoritativeCatalog ?? []).some(
      (row: SessionFile) => normalizeFsPath(row.file) === normalizeFsPath(file),
    );
  return {
    ...harness,
    project,
    other,
    hidden,
    parent,
    subagents,
    counters,
    create,
    discoveries: () => discoveries,
    start,
    poll,
    watch,
    walks,
    listed,
    settle,
  };
}

// The statement that ends the child event handler in `extension.ts`, which turns every remaining event into a refresh.
function childEventRefresh(): (panel: unknown, host: unknown, key: string, event: unknown) => void {
  const source = fs.readFileSync(path.join(__dirname, 'extension.ts'), 'utf8');
  const file = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.Latest, true);
  let refresh: string | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isBlock(node)) {
      const at = node.statements.findIndex(
        (statement) =>
          ts.isIfStatement(statement) && statement.expression.getText(file) === "event.kind === 'sessionState'",
      );
      if (at >= 0) refresh = node.statements[at + 1]?.getText(file);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(refresh, 'extension.ts no longer ends the child event handler after the session state report');
  return new Function('panel', 'host', 'key', 'event', refresh) as never;
}

test('six appending writers and a new child transcript each minute walk only on the poll backstop', async () => {
  const { writeRollout, subagents, create, start, poll, watch, walks, discoveries, counters } = pollWalkHarness();
  const writers = Array.from({ length: 6 }, (_, index) => writeRollout(`writer-${index}`));
  try {
    await start();
    for (let minute = 0; minute < 3; minute++) {
      for (let interval = 0; interval < 12; interval++) {
        if (interval === 0) {
          // Windows reports a new file as a rename, then a change once its first line lands.
          const child = create(path.join(subagents, `agent-minute-${minute}.jsonl`), '{}\n');
          const discovered = discoveries();
          await watch([
            [child, 'rename'],
            [child, 'change'],
          ]);
          assert.equal(discoveries() - discovered, 1, 'the refresh for a new child file sent no child discovery');
        }
        for (const writer of writers) fs.appendFileSync(writer, '{}\n');
        await watch(writers.map((writer) => [writer, 'change']));
        await poll();
      }
    }
    assert.deepEqual(walks(), { 'walk:requested:startup': 1, 'walk:requested:poll:backstop': 3 });
    assert.equal(counters.snapshot().work['watcher:sessionDirectory'], 3, 'a new child file was not owned');
  } finally {
    vi.useRealTimers();
  }
});

test('a new top-level transcript in a polled directory lists within one poll, without a watcher event', async () => {
  const { project, create, start, poll, walks, listed } = pollWalkHarness();
  try {
    await start();
    // The first poll after the walk has no stat of its own to compare, so it compares with the walk's start.
    const added = create(path.join(project, 'added.jsonl'));
    await poll();
    assert.ok(listed(added), 'the new transcript waited for the backstop');
    await poll();
    assert.deepEqual(walks(), { 'walk:requested:startup': 1, 'walk:requested:poll:directory': 1 });
  } finally {
    vi.useRealTimers();
  }
});

test('a new transcript that a watcher walk listed makes no poll walk', async () => {
  const { project, create, start, poll, watch, walks, listed } = pollWalkHarness();
  try {
    await start();
    await poll();
    const added = create(path.join(project, 'watched.jsonl'));
    await watch([[added, 'rename']]);
    assert.ok(listed(added));
    await poll();
    await poll();
    assert.deepEqual(walks(), { 'walk:requested:startup': 1, 'walk:requested:transcript': 1 });
  } finally {
    vi.useRealTimers();
  }
});

// Discovery that reports progress and never completes, as in a window where discovery has not published. Each request
// keeps only the accepted rows, as `prepareClaudeChildren` does, and records the parents it was sent.
function discoveryInProgress(provider: any): SessionFile[][] {
  const parents: SessionFile[][] = [];
  provider.prepareClaudeChildren = () => {
    parents.push(provider.claudeParents);
    provider.discoveryComplete = undefined;
    provider.catalog = { ...provider.catalog, sessions: provider.authoritativeCatalog };
    return Promise.resolve(true);
  };
  return parents;
}

test('a write to a session that the walk listed and discovery has not accepted refreshes it without a walk', async () => {
  const { provider, project, create, start, watch, walks, listed, counters } = pollWalkHarness();
  try {
    await start();
    const accept = provider.prepareClaudeChildren;
    const parents = discoveryInProgress(provider);
    const late = create(path.join(project, 'late.jsonl'));
    const quiet = create(path.join(project, 'quiet.jsonl'));
    await watch([
      [late, 'rename'],
      [quiet, 'rename'],
    ]);
    assert.ok(!listed(late), 'discovery accepted the new session while it reported progress');
    fs.appendFileSync(late, '{"type":"assistant"}\n');
    await watch([[late, 'change']]);
    assert.deepEqual(walks(), { 'walk:requested:startup': 1, 'walk:requested:transcript': 1 });
    assert.equal(counters.snapshot().watcherDecisions.walkListedPaths, 1);
    const sent = parents.at(-1)?.find((row) => normalizeFsPath(row.file) === normalizeFsPath(late));
    assert.equal(sent?.size, fs.statSync(late).size, 'the discovery request carried the old size of the new session');
    assert.ok(
      parents.at(-1)?.some((row) => normalizeFsPath(row.file) === normalizeFsPath(quiet)),
      'the discovery request dropped a session that the walk listed and the wake did not name',
    );
    // Once discovery accepts it, the row lists at its newest revision, still without a walk.
    provider.prepareClaudeChildren = accept;
    fs.appendFileSync(late, '{"type":"assistant"}\n');
    await watch([[late, 'change']]);
    const row = provider.authoritativeCatalog.find(
      (session: SessionFile) => normalizeFsPath(session.file) === normalizeFsPath(late),
    );
    assert.equal(row?.size, fs.statSync(late).size, 'the accepted row kept an old revision');
    assert.deepEqual(walks(), { 'walk:requested:startup': 1, 'walk:requested:transcript': 1 });
  } finally {
    vi.useRealTimers();
  }
});

test('a targeted wake after a search walk keeps the parents that prompt admission left out', async () => {
  const { provider, project, create, start, watch, walks } = pollWalkHarness();
  try {
    await start();
    const parents = discoveryInProgress(provider);
    const late = create(path.join(project, 'late.jsonl'));
    const silent = create(path.join(project, 'silent.jsonl'), '{"type":"assistant"}\n');
    await watch([
      [late, 'rename'],
      [silent, 'rename'],
    ]);
    // A content search walks with prompt admission, so its listed rows leave out the session without a prompt.
    provider.hasHumanPrompt = (session: SessionFile) => session.sessionId !== 'silent';
    provider.allSessions(false, false, undefined, undefined, 'requested:search');
    assert.ok(
      !provider.walkedCatalog.sessions.some((row: SessionFile) => row.file === silent),
      'the search walk listed a session without a prompt',
    );
    fs.appendFileSync(late, '{"type":"assistant"}\n');
    await watch([[late, 'change']]);
    assert.ok(
      parents.at(-1)?.some((row) => normalizeFsPath(row.file) === normalizeFsPath(silent)),
      'the discovery request dropped a walked parent without a prompt',
    );
    assert.equal(walks()['walk:requested:transcript'], 1, 'the wake on a walk-listed session walked');
  } finally {
    vi.useRealTimers();
  }
});

test('a wake on a walk-listed session whose file was replaced walks', async () => {
  const { provider, project, create, start, watch, walks } = pollWalkHarness();
  try {
    await start();
    discoveryInProgress(provider);
    const late = create(path.join(project, 'late.jsonl'));
    await watch([[late, 'rename']]);
    const copy = `${late}.copy`;
    fs.writeFileSync(copy, '{"type":"user"}\n{"type":"assistant"}\n');
    fs.rmSync(late);
    fs.renameSync(copy, late);
    await watch([[late, 'change']]);
    assert.deepEqual(walks(), { 'walk:requested:startup': 1, 'walk:requested:transcript': 2 });
  } finally {
    vi.useRealTimers();
  }
});

test('a watcher batch with a file in neither catalog walks once, with or without a walk-listed file', async () => {
  const { provider, project, create, start, watch, walks, listed, counters } = pollWalkHarness();
  const stranger = (name: string) => {
    const file = path.join(project, name);
    fs.writeFileSync(file, '{"type":"user"}\n');
    return file;
  };
  try {
    await start();
    discoveryInProgress(provider);
    const late = create(path.join(project, 'late.jsonl'));
    await watch([[late, 'rename']]);
    const alone = stranger('alone.jsonl');
    await watch([[alone, 'change']]);
    assert.deepEqual(walks(), { 'walk:requested:startup': 1, 'walk:requested:transcript': 2 });
    const mixed = stranger('mixed.jsonl');
    fs.appendFileSync(late, '{"type":"assistant"}\n');
    await watch([
      [late, 'change'],
      [mixed, 'change'],
    ]);
    assert.deepEqual(walks(), { 'walk:requested:startup': 1, 'walk:requested:transcript': 3 });
    assert.ok(!listed(late) && !listed(mixed), 'discovery accepted a session while it reported progress');
    assert.deepEqual(counters.snapshot().watcherDecisions.broadReasons, { createOrRename: 1, unknownPath: 2 });
  } finally {
    vi.useRealTimers();
  }
});

test('a new transcript in a directory the stat list misses lists at the backstop', async () => {
  const { other, hidden, create, start, poll, walks, listed } = pollWalkHarness();
  hidden.add(other);
  try {
    await start();
    const added = create(path.join(other, 'unpolled.jsonl'));
    let polls = 0;
    while (!listed(added) && polls < 13) {
      await poll();
      polls++;
    }
    assert.equal(polls, 12, `the transcript did not list exactly at the 60 s backstop: ${JSON.stringify(walks())}`);
    assert.deepEqual(walks(), { 'walk:requested:startup': 1, 'walk:requested:poll:backstop': 1 });
  } finally {
    vi.useRealTimers();
  }
});

test('a selected draft keeps the held catalog through polls and child events', async () => {
  const { provider, start, poll, walks, settle } = pollWalkHarness();
  const receive = childEventRefresh();
  try {
    await start();
    // A draft in repository scope stays selected through each refresh.
    provider.newDrafts = { draft: { draftId: 'draft', cwd: provider.repositoryScopeRoots[0] } };
    provider.showing = 'draft';
    for (let interval = 0; interval < 11; interval++) {
      await poll();
      receive(provider, { get: () => ({ state: () => ({ sessionId: null }) }) }, 'child', { kind: 'ready' });
      await settle();
    }
    assert.equal(provider.showing, 'draft');
    assert.deepEqual(walks(), { 'walk:requested:startup': 1 });
  } finally {
    vi.useRealTimers();
  }
});

test('a thinking event from a live child updates its session row without a walk', async () => {
  const { provider, parent, writeRollout, start, walks, settle } = pollWalkHarness();
  const receive = childEventRefresh();
  writeRollout('shown');
  try {
    await start();
    provider.showing = 'shown';
    fs.appendFileSync(parent, '{"type":"assistant"}\n');
    receive(provider, { get: () => ({ state: () => ({ sessionId: 'parent' }) }) }, 'child', { kind: 'thinking' });
    await settle();
    const row = provider.authoritativeCatalog.find((session: SessionFile) => session.sessionId === 'parent');
    assert.equal(row.size, fs.statSync(parent).size, 'the thinking event left the session row at its old size');
    assert.deepEqual(walks(), { 'walk:requested:startup': 1 });
  } finally {
    vi.useRealTimers();
  }
});

test('a child event that names a replaced transcript walks and lists the replacement', async () => {
  const { provider, parent, writeRollout, start, walks, settle } = pollWalkHarness();
  const receive = childEventRefresh();
  writeRollout('shown');
  try {
    await start();
    provider.showing = 'shown';
    const held = provider.authoritativeCatalog.find((session: SessionFile) => session.sessionId === 'parent');
    const copy = `${parent}.copy`;
    fs.writeFileSync(copy, '{"type":"user"}\n{"type":"assistant"}\n');
    fs.rmSync(parent);
    fs.renameSync(copy, parent);
    receive(provider, { get: () => ({ state: () => ({ sessionId: 'parent' }) }) }, 'child', { kind: 'turnEnd' });
    await settle();
    const row = provider.authoritativeCatalog.find((session: SessionFile) => session.sessionId === 'parent');
    assert.notEqual(String(row.ino), String(held.ino), 'the replaced transcript kept its old row');
    assert.equal(row.size, fs.statSync(parent).size);
    assert.deepEqual(walks(), { 'walk:requested:startup': 1, 'walk:namedFileChanged': 1 });
  } finally {
    vi.useRealTimers();
  }
});

test('every refresh caller names its reason', () => {
  const bare: string[] = [];
  for (const [name, receiver] of [
    ['panelhost.ts', 'this'],
    ['extension.ts', 'panel'],
  ]) {
    const file = ts.createSourceFile(
      name,
      fs.readFileSync(path.join(__dirname, name), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node, method: string | undefined): void => {
      const owner = ts.isMethodDeclaration(node) ? node.name.getText(file) : method;
      if (
        ts.isPropertyAccessExpression(node) &&
        node.name.text === 'refresh' &&
        node.expression.getText(file) === receiver &&
        owner !== 'refreshAs'
      ) {
        bare.push(`${name}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`);
      }
      ts.forEachChild(node, (child) => visit(child, owner));
    };
    visit(file, undefined);
  }
  assert.deepEqual(bare, [], 'a refresh starts without a requester name, so captures count it as direct');
});

test('an unresolved repository scope starts no walk, and the resolved refresh walks once', async () => {
  const { provider, walks, files, writeRollout, releaseAll } = heldWalkHarness();
  const file = writeRollout('late');
  let ready = false;
  provider.repositoryScope = { snapshot: () => ({ ready, roots: [path.dirname(file)], revision: 1 }) };
  provider.folders = () => [path.dirname(file)];
  await provider.refresh(true);
  assert.equal(walks.length, 0, 'an unresolved scope walked the rollout tree');
  assert.equal(provider.authoritativeCatalog, null);
  ready = true;
  await releaseAll(provider.refresh(true));
  assert.equal(walks.length, 1);
  assert.ok(files()?.length, 'the resolved refresh accepted no catalog');
});

test('replacement recovery lists Codex rollouts through one asynchronous walk', async () => {
  let replaced: string[] = [];
  const { provider, root, walks, files, writeRollout, releaseAll } = heldWalkHarness({
    replacedCatalogFiles: async () => replaced,
  });
  const file = writeRollout('replaced');
  await releaseAll(provider.refresh(true));
  assert.equal(walks.length, 1);
  replaced = [file];
  const reads = vi.spyOn(mutableFs, 'readdirSync');
  syncBuiltinESMExports();
  try {
    await releaseAll(provider.refresh(true, true));
    assert.equal(walks.length, 2, 'replacement recovery did not walk exactly once');
    assert.equal(
      (reads.mock.calls as unknown[][]).filter((call) => String(call[0]).startsWith(root)).length,
      0,
      'replacement recovery walked the rollout tree with the synchronous driver',
    );
    assert.deepEqual(files(), [file]);
  } finally {
    reads.mockRestore();
    syncBuiltinESMExports();
  }
});

test('the first rail after a derived cache version bump draws every stored name, a Claude child included', async () => {
  const { provider, codex, claude, child } = bumpedCatalogHarness();
  await provider.refresh(true);
  assert.equal(provider.messages.length, 1, 'the first refresh posted no rail');
  assert.deepEqual(
    Object.fromEntries(provider.messages[0].sessions.map((row: { id: string; label: string }) => [row.id, row.label])),
    {
      [codex.sessionId]: 'Codex stored name',
      [claude.sessionId]: 'Claude stored name',
      [child.sessionId]: 'Child stored name',
    },
    'the first rail after a version bump drew a session it has not reread as Session and an id',
  );
});

// Removing a session from the catalog removes its carried name and retains names for listed sessions.

test('a catalog walk after child discovery drops the carried name of a session deleted since', async () => {
  const { provider, codex, claude, child, codexWalk } = bumpedCatalogHarness();
  await provider.refresh(true);
  assert.ok(provider.carriedNames.has(codex.file), 'the first refresh dropped a carried name the walk still listed');
  codexWalk.splice(0);
  provider.allSessions();
  assert.deepEqual(
    [...provider.carriedNames.keys()].sort(),
    [claude.file, child.file].sort(),
    'the catalog walk kept the carried name of a deleted session, or dropped one it still lists',
  );
});

test('a restart between bounded passes still draws the stored name of a session no pass reread', async () => {
  const { cacheFile, codex, claude, catalog, run } = bumpedDerivedCache();
  const first = metadataHarness(run, new SessionNames(), cacheFile);
  assert.equal(await first.prepareMetadata(catalog, 1, new AbortController().signal), true);
  // Save the first pass checkpoint before restarting.
  assert.equal(first.writeDerivedCache(), true);

  const restarted = metadataHarness(
    async () => {
      throw new Error('the restarted provider read a transcript before its first rail');
    },
    new SessionNames(),
    cacheFile,
  );
  assert.deepEqual(
    [codex, claude].map((session) => restarted.sessionLabel(session).label),
    ['Codex stored name', 'Claude stored name'],
    'the checkpoint after the first pass dropped the stored name of every session that pass did not reread',
  );
});

test('a selection-only render keeps the authoritative rail when selected revalidation cannot replace it', async () => {
  for (const scenario of ['deleted selected session', 'newer held catalog']) {
    const provider = completeDiscoveryHarness(() => null);
    const selected = {
      file: `${scenario}.jsonl`,
      sessionId: 'selected',
      agent: 'claude',
      activity: 2,
      size: 2,
      mtimeMs: 2,
    };
    const peer = { file: 'peer.jsonl', sessionId: 'peer', agent: 'codex', activity: 1, size: 1, mtimeMs: 1 };
    provider._showing = 'selected';
    provider.projectSpendPayload = vi.fn<() => null>(() => null);
    provider.partial = scenario === 'newer held catalog' ? [peer] : [selected, peer];
    provider.authoritativeCatalog = [selected, peer];
    await provider.refresh(true, true, true, true);
    const payload = provider.messages.at(-1);
    assert.deepEqual(
      payload.sessions.map((session: { id: string }) => session.id),
      ['selected'],
      `${scenario} sent unchanged session rows in the selection patch`,
    );
    assert.equal(payload.showing, 'selected', `${scenario} replaced the reader's selection`);
    assert.equal(
      provider.projectSpendPayload.mock.calls.length,
      0,
      `${scenario} aggregated Project cost without rendering it`,
    );
  }
});

test('an account usage update does not aggregate Project cost', () => {
  const provider = paintHarness(['setUsage', 'postProjectSpend']);
  provider.post = vi.fn<() => Promise<void>>(() => Promise.resolve());
  provider.usagePayload = vi.fn<() => null>(() => null);
  provider.projectSpendPayload = vi.fn<() => null>(() => null);
  provider.setUsage([]);
  assert.equal(
    provider.projectSpendPayload.mock.calls.length,
    0,
    'an account usage update aggregated unrelated Project cost',
  );
});

test('selection failure reaches the provider payload as history status or diagnosis', async () => {
  for (const cards of [[{ key: 'recorded-card' }], []]) {
    const provider = completeDiscoveryHarness();
    const selected = {
      file: 'selected.jsonl',
      sessionId: 'selected',
      agent: 'claude',
      activity: 2,
      size: 2,
      mtimeMs: 2,
    };
    provider._showing = 'selected';
    provider.partial = [selected];
    provider.authoritativeCatalog = [selected];
    provider.catalog = { sessions: [selected] };
    provider.discovery = Promise.resolve(true);
    provider.drawnCards = cards;
    provider.cache.set('selected.jsonl', {
      key: 'failed',
      agentKey: '',
      revision: provider.revisionOf(selected),
      read: { turns: [], compactions: [], readBytes: 1, turnLimitReached: false },
    });
    provider.readWindows.set('selected', { readBytes: 1, turnLimitReached: false, loadedTurns: cards.length });
    provider.selectionFailure = { sessionId: 'selected', generation: 0, revision: provider.revisionOf(selected) };
    await provider.refresh(true, true, true, true);
    const payload = provider.messages.at(-1);
    if (cards.length) {
      assert.equal(payload.cards.length, 1);
      assert.equal(payload.olderHistory.kind, 'failed');
      assert.equal(payload.diagnosis, null);
    } else {
      assert.equal(payload.olderHistory, null);
      assert.equal(payload.diagnosis.message, 'Could not read this session. Select it to try again.');
    }
  }
});

test('selection posts loading before metadata for one hundred unrelated sessions', async () => {
  const provider = completeDiscoveryHarness();
  provider.partial = Array.from({ length: 100 }, (_unused, index) => ({
    file: `${index}.jsonl`,
    sessionId: index ? `session-${index}` : 'selected',
    agent: 'claude',
    activity: 100 - index,
    size: 1,
    mtimeMs: 1,
  }));
  provider.catalog = { sessions: provider.partial };
  provider.authoritativeCatalog = provider.partial;
  provider.prepareMetadata = () => new Promise<boolean>(() => {});
  provider.show('selected');
  await vi.waitFor(() => assert.equal(provider.messages.length, 1));
  assert.equal(provider.messages[0].showing, 'selected');
});

test('a local draft renders during discovery without replacing the discovery request', async () => {
  const provider = completeDiscoveryHarness();
  const existing = { file: 'existing.jsonl', sessionId: 'existing', agent: 'claude', activity: 1, size: 1, mtimeMs: 1 };
  provider.partial = [existing];
  provider.catalog = { sessions: provider.partial };
  let releaseDiscovery: (value: boolean) => void = () => {};
  provider.discovery = new Promise<boolean>((resolve) => {
    releaseDiscovery = resolve;
  });
  const discovery = provider.refresh(true);
  await vi.waitFor(() => assert.ok(provider.refreshController));
  const discoveryController = provider.refreshController;
  provider.createDraft('draft:new', 'project', null, 1, {
    agent: 'claude',
    model: 'opus',
    effort: 'high',
    permissionMode: 'auto',
    source: 'recent',
  });
  await vi.waitFor(() => assert.equal(provider.messages.at(-1)?.showing, 'draft:new'));
  assert.equal(discoveryController.signal.aborted, false, 'New restarted complete discovery');
  assert.equal(provider.newDrafts['draft:new']?.draftId, 'draft:new');
  assert.deepEqual(
    provider.messages.at(-1).sessions.map((session: { id: string }) => session.id),
    ['draft:new'],
    'New published existing rows from discovery before their metadata completed',
  );
  assert.equal(
    provider.messages.at(-1).startup,
    undefined,
    'the local draft published a second startup catalog generation',
  );
  releaseDiscovery(true);
  await discovery;
  assert.equal(provider.showing, 'draft:new', 'catalog completion replaced the local draft selection');
  assert.equal(
    provider.messages.filter((message: any) =>
      message.sessions.some((session: { id: string }) => session.id === 'existing'),
    ).length,
    1,
    'existing sessions were published before or more than once after authoritative discovery',
  );
});

// Worker walks take 500 ms. Watcher batches arrive every 200 ms or every second, covering overlapping and separate walks.

const WORKER_AWAIT_MS = 500;
const WATCHER_BATCH_MS = 200;
const SLOW_WATCHER_BATCH_MS = 1_000;
const RENDER_BOUND_MS = 2_000;
const STREAM_TIMERS: Parameters<typeof vi.useFakeTimers>[0] = {
  toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
};
const DRAFT_PROFILE = { agent: 'claude', model: 'opus', effort: 'high', permissionMode: 'auto', source: 'recent' };

function slowCatalogWalks(provider: any): void {
  provider.prepareClaudeChildren = () => {
    let finish: (walked: boolean) => void = () => {};
    const walk = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    setTimeout(() => {
      finish(true);
    }, WORKER_AWAIT_MS);
    return walk;
  };
}

// A null interval sends no watcher batch at all.
function watcherStream(provider: any, every: number | null): () => void {
  if (every === null) {
    return () => {};
  }
  const stream = setInterval(() => provider.refreshFrom('watcher', false, false, ['other.jsonl']), every);
  return () => clearInterval(stream);
}

// Advance fake timers until the condition holds or the deadline passes. Return the missing condition on timeout.

async function reachWithinBound(reached: () => boolean, missed: () => string): Promise<string | null> {
  for (let elapsed = 0; elapsed < RENDER_BOUND_MS && !reached(); elapsed += 50) {
    await vi.advanceTimersByTimeAsync(50);
  }
  return reached() ? null : `${missed()} within ${RENDER_BOUND_MS} ms`;
}

function streamedCatalogHarness(
  realSelectedWindow = false,
  extraMethods: string[] = [],
  scope: Record<string, unknown> = {},
): any {
  const provider = completeDiscoveryHarness(undefined, realSelectedWindow, extraMethods, scope);
  const existing = {
    file: 'existing.jsonl',
    sessionId: 'existing',
    agent: 'claude',
    activity: 1,
    size: 1,
    mtimeMs: 1,
    dev: 1,
    ino: 3,
  };
  provider._showing = 'existing';
  provider.partial = [existing];
  provider.catalog = { sessions: provider.partial };
  provider.authoritativeCatalog = provider.partial;
  provider.sessionRows = [{ id: 'existing', agentKey: 'claude', shown: true }];
  // Prompt box state includes the selected row, its draft profile, and live controls.

  provider.composerState = () => {
    const row = provider.sessionRows.find((one: any) => one.id === provider.showing);
    return row
      ? {
          sessionId: row.id,
          agent: row.agentKey ?? 'claude',
          profile: provider.newDrafts[row.id]?.profile ?? null,
          draft: provider.drafts[row.id] ?? '',
          queued: [],
          comments: provider.saved.comments,
          assets: [],
          live: provider.live[row.id] ?? [],
        }
      : null;
  };
  provider.usagePayload = () => ({ composer: provider.composerState() });
  slowCatalogWalks(provider);
  return provider;
}

// createDraft posts the held catalog synchronously while watcher batches continue.

test('New posts its draft composer within the bound while watcher batches keep arriving', async () => {
  vi.useFakeTimers(STREAM_TIMERS);
  const provider = streamedCatalogHarness(false, ['newSession', 'launcherFor']);
  provider.recentProfiles = [DRAFT_PROFILE];
  const stop = watcherStream(provider, WATCHER_BATCH_MS);
  try {
    await vi.advanceTimersByTimeAsync(1_000);
    const before = provider.messages.length;
    assert.equal(provider.newSession(), true, 'New did not open a draft');
    const [draft] = Object.keys(provider.newDrafts);
    assert.ok(
      provider.posts.some((message: any) => message.type === 'focusComposer' && message.session === draft),
      'New did not focus the draft composer',
    );
    assert.equal(
      await reachWithinBound(
        () =>
          provider.messages
            .slice(before)
            .some(
              (message: any) =>
                message.showing === draft &&
                message.usage?.composer?.sessionId === draft &&
                message.usage.composer.profile?.model === DRAFT_PROFILE.model,
            ),
        () => 'no draft composer reached the panel after New while watcher batches arrived',
      ),
      null,
    );
  } finally {
    stop();
    vi.useRealTimers();
  }
});

const SEND_SCOPE = {
  remapReaderParents,
  adoptSessionIdentity,
  agentPromptToSend,
  commentsForActiveSubmission,
  clearSubmission,
  compactSubmission,
  labelsOf,
  adoptLabelSession,
  livePressOver,
  pendingAskPosition,
  pressIsMidTurn,
  pressesAfter,
  pressesAfterHandoff,
  pressesAfterSessionHandoff,
  rememberSessionAlias,
  renamePlace,
  selectedWindowContainsRecordedTurn,
  sentAfter,
  storedAssetsForPrompt,
  queueAfterAcceptedRecovery,
  LIVE_ACTIVITY_STALE_MS: 30 * 60 * 1000,
};

// The accepted first prompt adopts session fresh and refreshes its prompt box state.

async function sentPromptPosts(every: number | null): Promise<string | null> {
  vi.useFakeTimers(STREAM_TIMERS);
  const provider = streamedCatalogHarness(
    false,
    ['send', 'noteLive', 'adoptDraft', 'livePressAnswered', 'notePrompted', 'isAgentRunLaunch'],
    SEND_SCOPE,
  );
  Object.assign(provider, {
    newDrafts: {},
    awaitingSessionRecords: {},
    saved: { comments: [], labels: {} },
    trail: emptyTrail(),
    sentPrompts: {},
    assets: {},
    queues: {},
    boxText: {},
    railOrder: [],
    hidden: new Set(),
    pinnedTop: new Set(),
    sessionAliases: new Map(),
    mcpServers: {},
    draftCommentIds: {},
    liveActivity: {},
    attachmentNotices: {},
    attachmentAliases: new Map(),
    staging: new Set(),
    stagingTokens: new Map(),
    stagingOperations: new Map(),
    queueHandoffs: new Set(),
    flushQueue() {},
    assetCompletions: { begin: () => 0 },
    assetHandoffs: new Set(),
    assetIdsInHandoff: new Set(),
    livePressHosts: new Map(),
    clearAttachmentNotice() {},
    dropCarriedComments() {},
    dropCarriedAssets() {},
    rememberStarted() {},
    writeDrafts: () => Promise.resolve(),
    onSendDraftPrompt: () => Promise.resolve({ delivered: true, session: 'fresh' }),
  });
  const stop = watcherStream(provider, every);
  try {
    provider.createDraft('draft:new', 'project', null, 1, DRAFT_PROFILE);
    await vi.advanceTimersByTimeAsync(1_000);
    const state = provider.composerState();
    assert.equal(state?.sessionId, 'draft:new', 'the draft composer was not on screen before the send');
    const before = provider.messages.length;
    provider.send(state, 'hello');
    return await reachWithinBound(
      () =>
        provider.messages
          .slice(before)
          .some(
            (message: any) =>
              message.showing === 'fresh' &&
              message.usage?.composer?.live?.some((press: any) => press.kind === 'prompt' && press.text === 'hello'),
          ),
      () =>
        'no view of the session that took the prompt, carrying that prompt, reached the panel' +
        (every === null ? '' : ' while watcher batches arrived') +
        ` (showing ${provider.showing}, posted ${JSON.stringify(provider.messages.slice(before).map((message: any) => message.showing))})`,
    );
  } finally {
    stop();
    vi.useRealTimers();
  }
}

test('a prompt sent from a new draft posts its session within the bound while watcher batches keep arriving', async () => {
  assert.equal(await sentPromptPosts(SLOW_WATCHER_BATCH_MS), null);
  assert.equal(await sentPromptPosts(WATCHER_BATCH_MS), null);
});

// Without watcher batches, the refresh after prompt acceptance must draw the adopted session.

test('a prompt sent from a new draft posts its session when no other refresh trigger arrives', async () => {
  assert.equal(await sentPromptPosts(null), null);
});

test('a trigger during a catalog refresh waits for it and then runs one merged refresh', async () => {
  const provider = harness(true);
  const panel = host();
  provider.hosts.push(panel);
  provider.readyHosts.add(panel);
  provider.showing = null;
  let finishWalk: (walked: boolean) => void = () => {};
  provider.prepareClaudeChildren = () =>
    new Promise<boolean>((resolve) => {
      finishWalk = resolve;
    });
  const first = provider.refresh();
  const inFlight: AbortController = provider.refreshController;
  assert.ok(inFlight, 'the first refresh did not start its catalog work');
  await provider.refresh();
  provider.sessions[0].size++;
  provider.refreshFrom('watcher', false, false, ['selected.jsonl']);
  assert.equal(inFlight.signal.aborted, false, 'a later trigger aborted the refresh in flight');
  assert.equal(provider.reads, 0, 'a later trigger started its own refresh beside the one in flight');
  const finishFirst = finishWalk;
  provider.prepareClaudeChildren = () => Promise.resolve(true);
  finishFirst(true);
  await first;
  await vi.waitFor(() => assert.equal(provider.refreshController, null, 'the merged refresh did not finish'));
  assert.equal(provider.reads, 2, 'the two waiting triggers did not run as exactly one refresh after the first');
  assert.equal(provider.pendingRefresh, null);
});

test('a catalog refresh whose worker never answers gives way to the triggers that wait behind it', async () => {
  vi.useFakeTimers(STREAM_TIMERS);
  try {
    const provider = harness(true);
    const panel = host();
    provider.hosts.push(panel);
    provider.readyHosts.add(panel);
    provider.showing = null;
    provider.prepareClaudeChildren = () => new Promise<boolean>(() => {});
    void provider.refresh();
    const stuck: AbortController = provider.refreshController;
    assert.ok(stuck, 'the first refresh did not start its catalog work');
    provider.refreshFrom('watcher', false, false, ['selected.jsonl']);
    await vi.advanceTimersByTimeAsync(CATALOG_REFRESH_DEADLINE_MS - 1);
    assert.equal(stuck.signal.aborted, false, 'the refresh in flight was abandoned before its deadline');
    assert.equal(provider.reads, 0, 'the waiting trigger ran before the deadline');
    provider.prepareClaudeChildren = () => Promise.resolve(true);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(
      stuck.signal.aborted,
      true,
      'the refresh whose worker never answered was not abandoned at its deadline',
    );
    assert.equal(provider.reads, 1, 'the trigger that waited behind the unanswered worker request did not run');

    // Past the deadline with nothing waiting, the refresh keeps running until a trigger arrives.
    provider.prepareClaudeChildren = () => new Promise<boolean>(() => {});
    void provider.refresh();
    const idle: AbortController = provider.refreshController;
    await vi.advanceTimersByTimeAsync(CATALOG_REFRESH_DEADLINE_MS);
    assert.equal(idle.signal.aborted, false, 'an overdue refresh was abandoned with no trigger waiting');
    provider.prepareClaudeChildren = () => Promise.resolve(true);
    provider.refreshFrom('poll');
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(idle.signal.aborted, true, 'a trigger behind an overdue refresh did not abandon it');
    assert.equal(provider.reads, 2, 'a trigger behind an overdue refresh waited instead of running');
  } finally {
    vi.useRealTimers();
  }
});

test('a trigger that waits behind a catalog refresh that throws still runs', async () => {
  const provider = harness(true);
  const panel = host();
  provider.hosts.push(panel);
  provider.readyHosts.add(panel);
  provider.showing = null;
  let failWalk: () => void = () => {};
  provider.prepareClaudeChildren = () =>
    new Promise<boolean>((_resolve, reject) => {
      failWalk = () => reject(new Error('the catalog read failed'));
    });
  const first = provider.refresh();
  provider.prepareClaudeChildren = () => Promise.resolve(true);
  provider.refreshFrom('watcher', false, false, ['selected.jsonl']);
  assert.equal(provider.reads, 0);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    failWalk();
    await first;
    await vi.waitFor(() => assert.equal(provider.reads, 1, 'the trigger behind the failed refresh never ran'));
  } finally {
    warn.mockRestore();
  }
});

function heldCatalogHarness(extraMethods: string[] = []): any {
  const provider = completeDiscoveryHarness(undefined, false, extraMethods);
  const existing = {
    file: 'existing.jsonl',
    sessionId: 'existing',
    agent: 'claude',
    activity: 1,
    size: 1,
    mtimeMs: 1,
    dev: 1,
    ino: 3,
  };
  provider._showing = 'existing';
  provider.partial = [existing];
  provider.catalog = { sessions: provider.partial };
  provider.authoritativeCatalog = provider.partial;
  provider.sessionRows = [{ id: 'existing', agentKey: 'claude', shown: true }];
  provider.discovery = Promise.resolve(true);
  return provider;
}

test('a theme change that waits behind an unchanged poll still repaints', async () => {
  const provider = heldCatalogHarness();
  provider.useRefreshGate(refreshWanted);
  await provider.refresh(true);
  const settled = provider.messages.length;
  assert.ok(settled > 0, 'the first forced refresh did not render');
  let finishWalk: (walked: boolean) => void = () => {};
  provider.prepareClaudeChildren = () =>
    new Promise<boolean>((resolve) => {
      finishWalk = resolve;
    });
  const poll = provider.refresh();
  provider.prepareClaudeChildren = () => Promise.resolve(true);
  void provider.refresh(true);
  finishWalk(true);
  await poll;
  await vi.waitFor(() => assert.equal(provider.refreshController, null, 'the merged refresh did not finish'));
  assert.equal(provider.messages.length, settled + 1, 'the theme change that waited behind a poll did not repaint');
});

test('a workspace folder change abandons the catalog refresh in flight', async () => {
  const provider = heldCatalogHarness(['workspaceFoldersChanged']);
  provider.repositoryScope = { snapshot() {} };
  provider.allowThemeFiles = () => {};
  let finishWalk: (walked: boolean) => void = () => {};
  provider.prepareClaudeChildren = () =>
    new Promise<boolean>((resolve) => {
      finishWalk = resolve;
    });
  const walk = provider.refresh(true);
  const inFlight: AbortController = provider.refreshController;
  assert.ok(inFlight, 'the refresh did not start its catalog work');
  const before = provider.messages.length;
  provider.workspaceFoldersChanged();
  assert.equal(inFlight.signal.aborted, true, 'the workspace folder change left the old refresh running');
  finishWalk(true);
  await walk;
  await vi.waitFor(() => assert.equal(provider.refreshController, null));
  assert.equal(provider.messages.length, before, 'a refresh started under the previous folders rendered its catalog');
});

test('a workspace folder change makes the next session page index test each working directory again', () => {
  let tests = 0;
  const provider = completeDiscoveryHarness(undefined, false, ['workspaceFoldersChanged', 'sessionPageIndexFor'], {
    scopeInside: () => {
      tests++;
      return true;
    },
  });
  provider.repositoryScope = { snapshot() {} };
  provider.allowThemeFiles = () => {};
  const catalog = () => [{ agent: 'claude', sessionId: 'one', file: '/sessions/one.jsonl', cwd: '/work/repo' }];
  const roots = ['/work/repo'];
  const index = () => provider.sessionPageIndexFor(catalog(), JSON.stringify(roots), roots);
  index();
  assert.equal(tests, 1);
  index();
  assert.equal(tests, 1, 'a new catalog tested a working directory whose membership was known');
  provider.workspaceFoldersChanged();
  assert.equal(index().scoped.length, 1);
  assert.equal(tests, 2, 'scope membership from the previous folders outlived the folder change');
});

test('a selected record that keeps growing retries without publishing unstable windows', async () => {
  let provider: any;
  let attempts = 0;
  provider = selectedWindowHarness(async (request, generation) => {
    attempts++;
    assert.equal(request.kind, 'window');
    const requested = provider.revisionOf(request.input.session);
    if (attempts <= 3) {
      provider.session = {
        ...provider.session,
        size: provider.session.size + 1,
        mtimeMs: provider.session.mtimeMs + 1,
      };
    }
    return windowResult(generation, requested);
  });
  await provider.completeSelectedWindow('selected', 1);
  await vi.waitFor(() =>
    assert.equal(attempts, 4, 'a growing selected record stopped after its first completed prefix'),
  );
  await vi.waitFor(() =>
    assert.equal(
      provider.selectionWork,
      null,
      `selected work remained held: ${JSON.stringify(provider.selectionWork)}`,
    ),
  );
  assert.deepEqual(provider.cache.get('selected.jsonl').revision, { size: 13, mtimeMs: 13, dev: 1, ino: 2 });
  assert.deepEqual(
    provider.published,
    [{ size: 13, mtimeMs: 13, dev: 1, ino: 2 }],
    'continuous growth published a window assembled before the source settled',
  );
});

test('a selected excluded-content append keeps loaded older turns after cold recovery', async () => {
  const directory = tempDir('panel-selected-cold-append-');
  const file = path.join(directory, 'session.jsonl');
  fs.writeFileSync(
    file,
    [
      {
        type: 'user',
        promptId: 'prompt',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Keep this turn' }] },
      },
      {
        type: 'assistant',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'assistant',
          id: 'answer',
          model: 'claude-opus-5',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Finished' }],
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  const worker = titleWorker();
  const input = (): ProgressiveInput => {
    const revision = revisionOf(fs.statSync(file, { bigint: true }));
    return {
      session: { file, sessionId: 'selected', agent: 'claude', ...revision },
      folders: [],
      children: [],
      maxTurns: 40,
      tailBytes: 1024,
    };
  };
  try {
    const initial = await worker.run({ kind: 'window', input: input() }, 0, new AbortController().signal);
    assert.ok(initial?.value.kind === 'window');
    assert.ok(initial.revision);
    fs.appendFileSync(file, JSON.stringify({ type: 'ignored', text: 'x'.repeat(32 * 1024) }) + '\n');
    const recovered = await worker.run(
      { kind: 'window', input: input(), checkpoint: initial.value.checkpoint },
      1,
      new AbortController().signal,
    );
    assert.ok(recovered?.value.kind === 'window');
    assert.equal(recovered.value.reset, true, 'the fixture did not enter cold recovery');
    assert.deepEqual(recovered.value.appendFrom, initial.revision);

    const provider = selectedWindowHarness(async () => recovered);
    const olderTurn = { sessionId: 'selected', turnId: 'older', startedAt: 1 };
    provider.revisionOf = (session: SessionFile) => revisionOf(fs.statSync(session.file, { bigint: true }));
    provider.session = input().session;
    provider.cache.set(file, {
      key: 'previous',
      agentKey: '',
      revision: initial.revision,
      read: initial.value.read,
      checkpoint: initial.value.checkpoint,
      bytes: 10,
      checkpointBytes: 1,
    });
    provider.history.set(
      'selected',
      loadedHistory(initial.revision, [{ turns: [olderTurn], compactions: [], bytes: 40 }]),
    );
    provider.historyStructuralKeys.set('selected', '');

    await provider.completeSelectedWindow('selected', 1);

    assert.equal(provider.dropped, 0, 'cold recovery dropped loaded turns from the proved append');
    assert.equal(provider.history.get('selected').pages[0].turns[0], olderTurn, 'the loaded older turn disappeared');
    assert.deepEqual(
      provider.cache.get(file).revision,
      recovered.revision,
      'the recovered selected window was not accepted',
    );
    await vi.waitFor(() => assert.equal(provider.selectionWork, null, 'the recovered selected work did not finish'));
  } finally {
    worker.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('background refresh preserves loaded turns only for an exact revision or its proved append', async () => {
  const previous = { size: 10, mtimeMs: 10, dev: 1, ino: 2 };
  for (const decision of [
    { name: 'exact revision', revision: previous, appendFrom: null, preserves: true },
    { name: 'proved append', revision: { ...previous, size: 11, mtimeMs: 11 }, appendFrom: previous, preserves: true },
    {
      name: 'larger rewrite or failed anchor',
      revision: { ...previous, size: 11, mtimeMs: 11 },
      appendFrom: null,
      preserves: false,
    },
  ]) {
    let provider: any;
    provider = selectedWindowHarness(
      async (_request, generation) => {
        const result = windowResult(generation, decision.revision);
        assert.ok(result.value.kind === 'window');
        result.value.reset = true;
        result.value.appendFrom = decision.appendFrom;
        return result;
      },
      ['prepareProgressive'],
    );
    provider.showing = 'other';
    provider.session = { ...provider.session, ...decision.revision };
    provider.cache.set('selected.jsonl', {
      key: 'previous',
      agentKey: '',
      revision: previous,
      read: { turns: [], compactions: [], readBytes: 10, turnLimitReached: false },
      checkpoint: {} as ProgressiveCheckpoint,
      bytes: 10,
      checkpointBytes: 1,
    });
    provider.history.set(
      'selected',
      loadedHistory(previous, [
        { turns: [{ sessionId: 'selected', turnId: 'older', startedAt: 1 }], compactions: [], bytes: 40 },
      ]),
    );
    provider.historyStructuralKeys.set('selected', '');

    await provider.prepareProgressive([provider.session], 1, new AbortController().signal);

    assert.equal(provider.history.has('selected'), decision.preserves, decision.name);
  }
});

test('render-time catalog revisions do not change loaded history before worker admission', () => {
  const accepted = { size: 12, mtimeMs: 12, dev: 1, ino: 2 };
  const pages = [{ turns: [{ sessionId: 'selected', turnId: 'older', startedAt: 1 }], compactions: [], bytes: 40 }];
  for (const catalog of [
    { name: 'delayed append revision', revision: { ...accepted, size: 11, mtimeMs: 11 } },
    { name: 'same-size rewrite', revision: { ...accepted, mtimeMs: 13 } },
    { name: 'shrinkage', revision: { ...accepted, size: 8, mtimeMs: 14 } },
  ]) {
    const provider = selectedWindowHarness(async () => null, ['trimOlderHistory']);
    provider.cache.set('selected.jsonl', {
      key: 'accepted',
      agentKey: '',
      structuralKey: '',
      revision: accepted,
      read: { turns: [], compactions: [], readBytes: 12, turnLimitReached: false },
    });
    provider.history.set('selected', loadedHistory(accepted, pages));
    provider.trimOlderHistory([{ ...provider.session, ...catalog.revision }]);

    assert.equal(provider.history.get('selected').pages, pages, catalog.name);
    assert.deepEqual(
      { size: provider.history.get('selected').size, mtimeMs: provider.history.get('selected').mtimeMs },
      { size: accepted.size, mtimeMs: accepted.mtimeMs },
      catalog.name,
    );
    assert.equal(provider.dropped, 0, catalog.name);
  }
});

test('stale selected work retries without a new selection', async () => {
  let attempts = 0;
  const provider = selectedWindowHarness(async (_request, generation) => {
    attempts++;
    if (attempts === 1) {
      provider.session = { ...provider.session, size: 11, mtimeMs: 11 };
      return { generation, revision: provider.revisionOf(provider.session), value: { kind: 'stale' } };
    }
    return windowResult(generation, provider.revisionOf(provider.session));
  });
  await provider.completeSelectedWindow('selected', 1);
  await vi.waitFor(() => assert.equal(attempts, 2));
  await vi.waitFor(() =>
    assert.deepEqual(provider.cache.get('selected.jsonl')?.revision, { size: 11, mtimeMs: 11, dev: 1, ino: 2 }),
  );
});

test('poll and watcher refresh paths leave selected work running through completion', async () => {
  const provider = completeDiscoveryHarness(undefined, true, ['progressiveCurrent']);
  provider.progressiveCurrent = (source: SessionFile) => Boolean(provider.cache.get(source.file));
  const selected = {
    file: 'selected.jsonl',
    sessionId: 'selected',
    agent: 'claude',
    activity: 1,
    size: 10,
    mtimeMs: 10,
    dev: 1,
    ino: 2,
  };
  provider._showing = 'selected';
  provider.partial = [selected];
  provider.authoritativeCatalog = [selected];
  provider.catalog = { sessions: [selected] };
  provider.discovery = Promise.resolve(true);
  let finishSelected: (result: ProgressiveResult) => void = () => {};
  provider.progressiveWorker = {
    run: () =>
      new Promise<ProgressiveResult>((resolve) => {
        finishSelected = resolve;
      }),
  };
  const completion = provider.completeSelectedWindow('selected', 0);
  await vi.waitFor(() => assert.notEqual(finishSelected.toString(), '() => {}'));
  const catalogController = new AbortController();
  provider.refreshController = catalogController;
  const selectedController = provider.selectionWork.controller;

  await provider.refresh();
  assert.equal(selectedController.signal.aborted, false, 'the poll cancelled selected work');
  provider.refreshFrom('watcher', true, false, ['other.jsonl']);
  assert.equal(catalogController.signal.aborted, false, 'the watcher aborted the catalog work in flight');
  assert.equal(selectedController.signal.aborted, false, 'the watcher cancelled selected work');
  finishSelected(windowResult(0, provider.revisionOf(selected)));
  await completion;
  await vi.waitFor(() => assert.equal(provider.selectionWork, null));
  assert.deepEqual(
    provider.cache.get('selected.jsonl').revision,
    provider.revisionOf(selected),
    'selected work did not reach accepted completion after poll and watcher refreshes',
  );
});

async function finishedTurnReachesSelected(every: number): Promise<string | null> {
  vi.useFakeTimers(STREAM_TIMERS);
  const provider = streamedCatalogHarness(true);
  const selected = {
    file: 'selected.jsonl',
    sessionId: 'selected',
    agent: 'claude',
    activity: 2,
    size: 10,
    mtimeMs: 10,
    dev: 1,
    ino: 2,
  };
  // What a stat of each transcript answers, which is what the production revisionOf reads.
  const disk = new Map([[selected.file, { size: 10, mtimeMs: 10 }]]);
  provider.revisionOf = (session: any) => ({
    size: session.size,
    mtimeMs: session.mtimeMs,
    ...disk.get(session.file),
    dev: session.dev ?? 1,
    ino: session.ino ?? 2,
  });
  provider._showing = 'selected';
  provider.partial = [selected, ...provider.partial];
  provider.catalog = { sessions: provider.partial };
  provider.authoritativeCatalog = provider.partial;
  provider.progressiveCurrent = (session: any) => {
    const held = provider.cache.get(session.file);
    return Boolean(held) && sameProgressiveRevision(held.revision, provider.revisionOf(session));
  };
  provider.progressiveWorker = {
    run: (request: ProgressiveRequest, generation: number) =>
      Promise.resolve(windowResult(generation, provider.revisionOf((request as any).input.session))),
  };
  const stop = watcherStream(provider, every);
  try {
    await provider.completeSelectedWindow('selected', 0);
    assert.equal(provider.cache.get(selected.file)?.revision.size, 10, 'the selected window was not accepted');
    await vi.advanceTimersByTimeAsync(1_000);
    // The completed response grows the selected transcript. The next catalog lists its new revision and the watcher names its path.

    disk.set(selected.file, { size: 20, mtimeMs: 20 });
    provider.partial = [{ ...selected, size: 20, mtimeMs: 20 }, ...provider.partial.slice(1)];
    provider.catalog = { sessions: provider.partial };
    provider.refreshFrom('watcher', false, false, [selected.file]);
    return await reachWithinBound(
      () => provider.cache.get(selected.file)?.revision.size === 20,
      () =>
        `the selected session still held size ${provider.cache.get(selected.file)?.revision.size} after its turn finished` +
        ' while watcher batches arrived',
    );
  } finally {
    stop();
    vi.useRealTimers();
  }
}

test('a finished turn reaches the selected session while watcher batches keep arriving', async () => {
  assert.equal(await finishedTurnReachesSelected(SLOW_WATCHER_BATCH_MS), null);
  assert.equal(await finishedTurnReachesSelected(WATCHER_BATCH_MS), null);
});

test('selected work refreshes retained older history after the subagent list changes', async () => {
  const requests: { kind: string; generation: number; signal: AbortSignal }[] = [];
  const provider = selectedWindowHarness(async (request, generation, signal) => {
    requests.push({ kind: request.kind, generation, signal });
    const revision = provider.revisionOf(provider.session);
    return request.kind === 'retained'
      ? { generation, revision, value: { kind: 'retained', pages: [{ turns: [], compactions: [], bytes: 2 }] } }
      : windowResult(generation, revision);
  });
  provider.structural = 'new-subagent-list';
  const revision = provider.revisionOf(provider.session);
  provider.cache.set('selected.jsonl', {
    key: 'previous',
    agentKey: '',
    structuralKey: '',
    revision,
    read: { turns: [], compactions: [], readBytes: 10, turnLimitReached: false },
    checkpoint: {} as ProgressiveCheckpoint,
    bytes: 10,
    checkpointBytes: 1,
  });
  provider.history.set('selected', loadedHistory(revision, [{ turns: [], compactions: [], bytes: 1 }]));
  provider.historyStructuralKeys.set('selected', 'old-subagent-list');

  await provider.completeSelectedWindow('selected', 1);

  assert.deepEqual(
    requests.map((request) => [request.kind, request.generation]),
    [
      ['retained', 1],
      ['window', 1],
    ],
  );
  assert.equal(
    requests.every((request) => request.signal === requests[0].signal),
    true,
    'selected older-history enrichment used catalog cancellation',
  );
  assert.deepEqual(provider.history.get('selected').pages, [{ turns: [], compactions: [], bytes: 2 }]);
  assert.equal(provider.historyStructuralKeys.get('selected'), 'new-subagent-list');
});

test('growth during selected retained-history enrichment preserves pages and advances the selected window', async () => {
  const requests: ProgressiveRequest[] = [];
  let retainedAttempts = 0;
  let provider: any;
  provider = selectedWindowHarness(async (request, generation) => {
    requests.push(request);
    if (request.kind === 'retained') {
      retainedAttempts++;
      if (retainedAttempts <= 2) {
        provider.session = {
          ...provider.session,
          size: provider.session.size + 1,
          mtimeMs: provider.session.mtimeMs + 1,
        };
        return { generation, revision: provider.revisionOf(provider.session), value: { kind: 'stale' } };
      }
      return {
        generation,
        revision: provider.revisionOf(provider.session),
        value: { kind: 'retained', pages: request.pages },
      };
    }
    assert.equal(request.kind, 'window');
    assert.equal(
      request.input.session.size,
      10 + retainedAttempts,
      'the selected window retried the retained revision',
    );
    assert.equal(
      provider.history.get('selected').pages,
      pages,
      'growth discarded accepted older pages before window progress',
    );
    const revision = provider.revisionOf(provider.session);
    const result = windowResult(generation, revision);
    assert.ok(result.value.kind === 'window');
    result.value.appendFrom = { ...revision, size: revision.size - 1, mtimeMs: revision.mtimeMs - 1 };
    return result;
  });
  const retainedTurn = { sessionId: 'selected', turnId: 'older', startedAt: 1 };
  const pages = [{ turns: [retainedTurn], compactions: [], bytes: 40 }];
  provider.structural = 'new-subagent-list';
  const revision = provider.revisionOf(provider.session);
  provider.cache.set('selected.jsonl', {
    key: 'previous',
    agentKey: '',
    structuralKey: '',
    revision,
    read: { turns: [], compactions: [], readBytes: 10, turnLimitReached: false },
    checkpoint: {} as ProgressiveCheckpoint,
    bytes: 10,
    checkpointBytes: 1,
  });
  provider.history.set('selected', loadedHistory(revision, pages));
  provider.historyStructuralKeys.set('selected', 'old-subagent-list');

  await provider.completeSelectedWindow('selected', 1);
  await vi.waitFor(() =>
    assert.deepEqual(
      requests.map((request) => request.kind),
      ['retained', 'window', 'retained', 'window', 'retained'],
    ),
  );
  await vi.waitFor(() => assert.equal(provider.selectionWork, null));

  assert.deepEqual(provider.history.get('selected').pages, pages, 'growth discarded accepted older pages');
  assert.equal(provider.dropped, 0, 'growth dropped retained history');
  assert.deepEqual(provider.cache.get('selected.jsonl').revision, { size: 12, mtimeMs: 12, dev: 1, ino: 2 });
});

const selectedFileChanges = [
  { name: 'replacement', apply: (session: any) => ({ ...session, dev: 2, ino: 3 }) },
  { name: 'shrinkage', apply: (session: any) => ({ ...session, size: 9, mtimeMs: 11 }) },
  { name: 'identity change', apply: (session: any) => ({ ...session, ino: 3 }) },
  { name: 'same-size rewrite', apply: (session: any) => ({ ...session, mtimeMs: 11 }) },
];

test('a compatible selected checkpoint is reused until the file changes', async () => {
  for (const change of selectedFileChanges) {
    let attempts = 0;
    let finishRetry: (result: ProgressiveResult | null) => void = () => {};
    const checkpoint = { parserKey: 'cached revision' } as ProgressiveCheckpoint;
    let provider: any;
    provider = selectedWindowHarness(async (request, generation) => {
      attempts++;
      assert.equal(request.kind, 'window');
      if (attempts === 1) {
        assert.equal(request.checkpoint, checkpoint, `${change.name} discarded a compatible checkpoint`);
        const requested = provider.revisionOf(request.input.session);
        provider.session = change.apply(provider.session);
        return windowResult(generation, requested);
      }
      assert.equal(request.checkpoint, undefined, `${change.name} reused a checkpoint after the file changed`);
      return new Promise<ProgressiveResult | null>((resolve) => {
        finishRetry = resolve;
      });
    });
    provider.cache.set('selected.jsonl', {
      key: 'incomplete',
      agentKey: '',
      revision: provider.revisionOf(provider.session),
      read: {
        turns: [{ sessionId: 'selected', turnId: 'cached', startedAt: 1 }],
        compactions: [],
        readBytes: 10,
        turnLimitReached: false,
      },
      checkpoint,
      bytes: 10,
      checkpointBytes: 1,
    });
    await provider.completeSelectedWindow('selected', 1);
    await vi.waitFor(() => assert.equal(attempts, 2));
    assert.equal(
      provider.cache.has('selected.jsonl'),
      true,
      `${change.name} discarded the last accepted window before retry`,
    );
    finishRetry(null);
    await vi.waitFor(() => assert.equal(provider.selectionWork, null));
  }
});

// Returning to a cached session must reuse its read without showing a loading status.

test('a walk from A to B to C and back to A reads each session once', async () => {
  let attempts = 0;
  let provider: any;
  provider = selectedWindowHarness(
    async (request, generation) => {
      attempts++;
      assert.equal(request.kind, 'window');
      return windowResult(generation, provider.revisionOf(request.input.session));
    },
    ['show', 'evictCache', 'dropOlderHistory'],
  );
  const sessionA = { file: 'a.jsonl', sessionId: 'A', agent: 'claude', size: 10, mtimeMs: 10, dev: 1, ino: 1 };
  const sessionB = { file: 'b.jsonl', sessionId: 'B', agent: 'claude', size: 10, mtimeMs: 10, dev: 1, ino: 2 };
  const sessionC = { file: 'c.jsonl', sessionId: 'C', agent: 'claude', size: 10, mtimeMs: 10, dev: 1, ino: 3 };
  provider.catalog = [sessionA, sessionB, sessionC];

  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    let clock = 0;
    const select = async (sessionId: string) => {
      vi.setSystemTime(++clock);
      provider.show(sessionId);
      await vi.waitFor(() => assert.equal(provider.selectionWork, null));
    };
    await select('A');
    await select('B');
    await select('C');
    const beforeReturn = provider.refreshResults.length;
    await select('A');
    const duringReturn = provider.refreshResults.slice(beforeReturn);

    assert.equal(attempts, 3, 'the return to A read its transcript again instead of reusing the parsed session');
    assert.ok(duringReturn.length > 0, 'the return to A recorded no refresh');
    for (const loading of duringReturn) {
      assert.equal(
        loading.history?.kind === 'busy',
        false,
        'the return to A carried a busy history control for a session already retained',
      );
      assert.equal(
        Boolean(loading.diagnosis?.message?.includes('Loading the newest turn')),
        false,
        'the return to A reported loading the newest turn for a session already retained',
      );
    }
  } finally {
    vi.useRealTimers();
  }
});

// Eviction removes the stored entry and carried name of a session absent from the catalog.

test('eviction drops the stored entry and the carried name of a session the catalog no longer lists', () => {
  const provider = selectedWindowHarness(() => Promise.resolve(null), ['evictCache']);
  const kept = { file: 'kept.jsonl', sessionId: 'kept', agent: 'claude', size: 10, mtimeMs: 10, dev: 1, ino: 1 };
  const name = (label: string) => ({ label, fullLabel: label });
  provider.titles = new Map([
    [kept.file, { label: 'Kept' }],
    ['gone.jsonl', { label: 'Gone' }],
  ]);
  provider.carriedNames = new Map([
    [kept.file, name('Kept')],
    ['gone.jsonl', name('Gone')],
    ['unread-gone.jsonl', name('Unread and gone')],
  ]);
  provider.evictCache([kept], [kept]);
  assert.deepEqual([...provider.titles.keys()], [kept.file]);
  assert.deepEqual(
    [...provider.carriedNames.keys()],
    [kept.file],
    'a carried name outlived the session the catalog no longer lists',
  );
});

// Selecting a cached session must draw its retained window with one selected-only refresh.

test('selecting a cached session runs one selected-only refresh that draws its held window', async () => {
  let attempts = 0;
  let provider: any;
  provider = selectedWindowHarness(
    async (request, generation) => {
      attempts++;
      assert.equal(request.kind, 'window');
      return windowResult(generation, provider.revisionOf(request.input.session));
    },
    ['show', 'evictCache', 'dropOlderHistory'],
  );
  const sessionA = { file: 'a.jsonl', sessionId: 'A', agent: 'claude', size: 10, mtimeMs: 10, dev: 1, ino: 1 };
  const sessionB = { file: 'b.jsonl', sessionId: 'B', agent: 'claude', size: 10, mtimeMs: 10, dev: 1, ino: 2 };
  provider.catalog = [sessionA, sessionB];
  const select = async (sessionId: string) => {
    provider.show(sessionId);
    await vi.waitFor(() => assert.equal(provider.selectionWork, null));
  };
  await select('A');
  await select('B');
  assert.equal(attempts, 2);

  const before = provider.refreshes;
  const drawnBefore = provider.refreshResults.length;
  await select('A');
  assert.deepEqual(
    provider.refreshResults.slice(drawnBefore),
    [newestTurnLoading(null, true)],
    'the refresh after selecting the cached session drew a loading row instead of its held window',
  );
  assert.equal(attempts, 2, 'the return to A read its transcript again');
  assert.equal(provider.refreshes - before, 1, 'selecting a cached session ran more than one selected-only refresh');
});

// Subagent transcript writes must retain the unchanged parent window without a loading row.

test.each([99999, 100000])(
  'a running subagent writing its transcript keeps the selected read and shows no loading row from %ims',
  async (initialMtime) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(100001);
    try {
      const child = path.join(tempDir('panel-startup-subagent-'), 'agent-child.jsonl');
      fs.writeFileSync(child, JSON.stringify({ type: 'assistant', isSidechain: true }) + '\n');
      fs.utimesSync(child, new Date(initialMtime), new Date(initialMtime));
      const read: any = {
        turns: [
          {
            sessionId: 'selected',
            turnId: 'turn',
            startedAt: 1,
            agents: [
              {
                id: 'child',
                description: 'Review child',
                agentType: null,
                status: 'async_launched',
                toolUseId: 'launch-child',
              },
            ],
          },
        ],
        compactions: [],
        readBytes: 10,
        turnLimitReached: false,
      };
      const requests: string[] = [];
      let attempts = 0;
      let provider: any;
      provider = selectedWindowHarness(
        async (request, generation) => {
          requests.push(request.kind);
          if (request.kind === 'retained') {
            return {
              generation,
              revision: provider.revisionOf(request.input.session),
              value: { kind: 'retained', pages: request.pages },
            };
          }
          attempts++;
          assert.ok(request.kind === 'window');
          const result = windowResult(generation, provider.revisionOf(request.input.session));
          assert.ok(result.value.kind === 'window');
          result.value.read = read;
          result.value.agentKey = provider.agentSpendKey(request.input.session, read);
          result.value.structuralKey = provider.structuralKey(request.input.session);
          return result;
        },
        [
          'evictCache',
          'progressiveCurrent',
          'structuralKey',
          'claudeStructuralKey',
          'agentSpendKey',
          'agentFile',
          'agentListingStamp',
          'claudeChildRevisions',
          'claudeChildVersion',
          'codexStructuralChildren',
          'codexChildRevisions',
          'agentFactsCurrent',
          'historyAgentKey',
          'refreshAgentFacts',
          'jointSplitWindow',
          'acceptJointSplitWindow',
        ],
      );
      provider.claudeChildReferences = [
        { parentSessionId: 'selected', sessionId: 'child', toolUseIds: ['launch-child'], file: child },
      ];
      provider.claudeChildren = [];
      provider.codexSubagents = [];
      await provider.completeSelectedWindow('selected', 1);
      assert.equal(attempts, 1);
      const spendStamp = provider.agentListingStamp([provider.session]);
      const before = provider.refreshResults.length;
      fs.appendFileSync(
        child,
        JSON.stringify({
          type: 'assistant',
          isSidechain: true,
          message: { role: 'assistant', id: 'child-answer', usage: { input_tokens: 20, output_tokens: 5 } },
        }) + '\n',
      );
      fs.utimesSync(child, new Date(100001), new Date(100001));
      provider.refresh();
      await provider.completeSelectedWindow('selected', 1);
      await vi.waitFor(() => assert.equal(provider.selectionWork, null));
      const afterAppend = provider.refreshResults.slice(before);

      assert.equal(attempts, 1, 'a subagent append started another read of the unchanged selected session');
      assert.deepEqual(requests, initialMtime === 99999 ? ['window', 'retained'] : ['window']);
      assert.ok(afterAppend.length > 0, 'the subagent append recorded no refresh');
      for (const loading of afterAppend) {
        assert.equal(
          loading.history?.kind === 'busy',
          false,
          'a subagent append showed a busy loading row below the selected card',
        );
      }
      assert.notEqual(
        provider.agentListingStamp([provider.session]),
        spendStamp,
        'a subagent append did not move the child listing, so its spend never updates',
      );
    } finally {
      vi.useRealTimers();
    }
  },
);

// Nested subagent writes must update the finished launcher's cost.

test('a nested subagent that appears or grows after its launcher finished moves the launcher row cost', async () => {
  const folder = tempDir('panel-startup-nested-');
  const launcher = path.join(folder, 'agent-a1.jsonl');
  const nested = path.join(folder, 'agent-a2.jsonl');
  const line = (record: object) => JSON.stringify(record) + '\n';
  const prompt = (text: string) =>
    line({
      type: 'user',
      isSidechain: true,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: text },
    });
  const answer = (id: string, content: object[]) =>
    line({
      type: 'assistant',
      isSidechain: true,
      timestamp: '2026-01-01T00:00:01.000Z',
      message: {
        role: 'assistant',
        id,
        model: 'claude-haiku-4-5',
        stop_reason: 'end_turn',
        content,
        usage: { input_tokens: 1000, output_tokens: 0 },
      },
    });
  const done = [{ type: 'text', text: 'Done.' }];
  fs.writeFileSync(
    launcher,
    prompt('launch nested work') +
      answer('m1', [{ type: 'tool_use', id: 'launch-2', name: 'Agent', input: {} }, ...done]),
  );
  const read: any = {
    turns: [
      {
        sessionId: 'selected',
        turnId: 'turn',
        startedAt: 1,
        agents: [
          {
            id: 'a1',
            description: 'Launch nested work',
            agentType: null,
            status: 'completed',
            toolUseId: 'launch-1',
            spend: [],
            spendFound: true,
            spendPartial: false,
          },
        ],
      },
    ],
    compactions: [],
    readBytes: 10,
    turnLimitReached: false,
  };
  const priced = (turns: any[]) =>
    turns.map((turn) => ({
      ...turn,
      agents: turn.agents.map((agent: any) => {
        const spend = readClaudeAgentSpend(launcher);
        return { ...agent, spend: spend.models, spendPartial: spend.partial };
      }),
    }));
  const requests: string[] = [];
  let provider: any;
  provider = selectedWindowHarness(
    async (request, generation) => {
      requests.push(request.kind);
      const revision = provider.revisionOf(provider.session);
      if (request.kind === 'retained') {
        return {
          generation,
          revision,
          value: { kind: 'retained', pages: request.pages.map((page) => ({ ...page, turns: priced(page.turns) })) },
        };
      }
      const result = windowResult(generation, revision);
      assert.ok(result.value.kind === 'window');
      result.value.read = { ...read, turns: priced(read.turns) };
      result.value.agentKey = agentSpendDependencyKey(
        result.value.read.turns,
        () => launcher,
        (file) => childSpendVersion('claude', file),
        '',
        [],
        Date.now(),
      );
      return result;
    },
    [
      'agentSpendKey',
      'agentFile',
      'codexStructuralChildren',
      'refreshAgentFacts',
      'jointSplitWindow',
      'acceptJointSplitWindow',
    ],
  );
  provider.claudeChildReferences = [
    { parentSessionId: 'selected', sessionId: 'a1', toolUseIds: ['launch-1'], file: launcher },
  ];
  provider.claudeChildren = [];
  provider.codexSubagents = [];
  const input = () => provider.cache.get('selected.jsonl').read.turns[0].agents[0].spend[0]?.usage.input;

  await provider.completeSelectedWindow('selected', 1);
  fs.writeFileSync(
    path.join(folder, 'agent-a2.meta.json'),
    JSON.stringify({ toolUseId: 'launch-2', parentAgentId: 'a1' }),
  );
  fs.writeFileSync(nested, prompt('nested work') + answer('m2', done));
  await provider.completeSelectedWindow('selected', 1);
  assert.equal(input(), 2000, 'a nested subagent that appeared left the launcher row without its cost');
  fs.appendFileSync(nested, answer('m3', done));
  await provider.completeSelectedWindow('selected', 1);
  assert.equal(input(), 3000, 'a nested subagent that grew left the launcher row at its old cost');
  await provider.completeSelectedWindow('selected', 1);
  assert.deepEqual(
    requests,
    ['window', 'retained', 'retained'],
    'the cost key the window filed disagreed with the one the panel compares, so a read made an extra round trip',
  );
});

test('a subagent that discovery has not listed keys its cost through its meta file', async () => {
  const folder = tempDir('panel-startup-meta-child-');
  const session = path.join(folder, 'selected.jsonl');
  const subagents = path.join(folder, 'selected', 'subagents');
  const child = path.join(subagents, 'agent-a1.jsonl');
  fs.mkdirSync(subagents, { recursive: true });
  const line = (record: object) => JSON.stringify(record) + '\n';
  const answer = (id: string) =>
    line({
      type: 'assistant',
      isSidechain: true,
      timestamp: '2026-01-01T00:00:01.000Z',
      message: {
        role: 'assistant',
        id,
        model: 'claude-haiku-4-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Done.' }],
        usage: { input_tokens: 1000, output_tokens: 0 },
      },
    });
  fs.writeFileSync(
    child,
    line({
      type: 'user',
      isSidechain: true,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'review in the background' },
    }) + answer('m1'),
  );
  fs.writeFileSync(path.join(subagents, 'agent-a1.meta.json'), JSON.stringify({ toolUseId: 'launch-1' }));
  const read: any = {
    turns: [
      {
        sessionId: 'selected',
        turnId: 'turn',
        startedAt: 1,
        agents: [
          {
            id: 'a1',
            description: 'Review in the background',
            agentType: null,
            status: 'completed',
            toolUseId: 'launch-1',
            spend: [],
            spendFound: true,
            spendPartial: false,
          },
        ],
      },
    ],
    compactions: [],
    readBytes: 10,
    turnLimitReached: false,
  };
  const priced = (turns: any[]) =>
    turns.map((turn) => ({
      ...turn,
      agents: turn.agents.map((agent: any) => {
        const spend = readClaudeAgentSpend(child);
        return { ...agent, spend: spend.models, spendPartial: spend.partial };
      }),
    }));
  const requests: string[] = [];
  let provider: any;
  provider = selectedWindowHarness(
    async (request, generation) => {
      requests.push(request.kind);
      const revision = provider.revisionOf(provider.session);
      if (request.kind === 'retained') {
        return {
          generation,
          revision,
          value: { kind: 'retained', pages: request.pages.map((page) => ({ ...page, turns: priced(page.turns) })) },
        };
      }
      const result = windowResult(generation, revision);
      assert.ok(result.value.kind === 'window');
      result.value.read = { ...read, turns: priced(read.turns) };
      // The worker resolves the child through the same meta file.
      result.value.agentKey = agentSpendDependencyKey(
        result.value.read.turns,
        () => child,
        (file) => childSpendVersion('claude', file),
        '',
        [],
        Date.now(),
      );
      return result;
    },
    [
      'agentSpendKey',
      'agentFile',
      'codexStructuralChildren',
      'refreshAgentFacts',
      'jointSplitWindow',
      'acceptJointSplitWindow',
    ],
  );
  provider.session = { ...provider.session, file: session };
  provider.claudeChildReferences = [];
  provider.claudeChildren = [];
  provider.codexSubagents = [];
  const input = () => provider.cache.get(session).read.turns[0].agents[0].spend[0]?.usage.input;

  await provider.completeSelectedWindow('selected', 1);
  await provider.completeSelectedWindow('selected', 1);
  assert.equal(input(), 1000);
  fs.appendFileSync(child, answer('m2'));
  await provider.completeSelectedWindow('selected', 1);
  assert.equal(input(), 2000, 'a child append left the row at its old cost');
  await provider.completeSelectedWindow('selected', 1);
  assert.deepEqual(
    requests,
    ['window', 'retained'],
    'the panel keyed the child differently from the window, so a read made an extra round trip',
  );
});

// Codex subagent rollout writes retain the parent window.

test('a running Codex subagent writing its rollout keeps the selected read and shows no loading row', async () => {
  const child = path.join(tempDir('panel-startup-codex-subagent-'), 'rollout-child.jsonl');
  fs.writeFileSync(child, JSON.stringify({ type: 'turn_context' }) + '\n');
  const requests: string[] = [];
  let provider: any;
  provider = selectedWindowHarness(
    async (request, generation) => {
      requests.push(request.kind);
      if (request.kind === 'retained') {
        return {
          generation,
          revision: provider.revisionOf(request.input.session),
          value: {
            kind: 'retained',
            pages: request.pages,
          },
        };
      }
      assert.ok(request.kind === 'window');
      const result = windowResult(generation, provider.revisionOf(request.input.session));
      assert.ok(result.value.kind === 'window');
      result.value.agentKey = provider.agentSpendKey(request.input.session, result.value.read);
      result.value.structuralKey = provider.structuralKey(request.input.session);
      return result;
    },
    [
      'progressiveCurrent',
      'structuralKey',
      'claudeStructuralKey',
      'codexStructuralKey',
      'codexStructuralChildren',
      'codexChildRevisions',
      'agentSpendKey',
      'agentFile',
      'agentFactsCurrent',
      'historyAgentKey',
      'refreshAgentFacts',
      'jointSplitWindow',
      'acceptJointSplitWindow',
    ],
  );
  provider.session = { ...provider.session, agent: 'codex' };
  provider.claudeChildReferences = [];
  provider.claudeChildren = [];
  provider.codexSubagents = [
    {
      parentThreadId: 'selected',
      threadId: 'child',
      file: child,
      openedAt: 1,
      startedAt: 1,
      threadSource: 'shell',
      backgroundReview: false,
    },
  ];
  await provider.completeSelectedWindow('selected', 1);
  const held = provider.cache.get('selected.jsonl');
  const spendKey = provider.agentSpendKey(provider.session, held.read);

  fs.appendFileSync(child, JSON.stringify({ type: 'event_msg' }) + '\n');
  assert.equal(
    provider.progressiveCurrent(provider.session),
    true,
    'a Codex subagent append made the selected read stale and showed the loading row',
  );
  assert.notEqual(
    provider.agentSpendKey(provider.session, held.read),
    spendKey,
    'a Codex subagent append did not move the cost key, so its spend never updates',
  );
  provider.refresh();
  await provider.completeSelectedWindow('selected', 1);
  await vi.waitFor(() => assert.equal(provider.selectionWork, null));

  assert.equal(
    requests.filter((kind) => kind === 'window').length,
    1,
    'a Codex subagent append started another read of the unchanged selected session',
  );
});

// A parent write during retained child-cost hydration must replace the selected card's running state.

test('a parent write during a subagent cost refresh reaches the selected card', async () => {
  const child = path.join(tempDir('panel-startup-parent-write-'), 'agent-child.jsonl');
  const appendChild = (id: string) =>
    fs.appendFileSync(
      child,
      JSON.stringify({
        type: 'assistant',
        isSidechain: true,
        message: { role: 'assistant', id, model: 'claude-opus-4-1', usage: { input_tokens: 20, output_tokens: 5 } },
      }) + '\n',
    );
  appendChild('child-first');
  const turn = (endedAt: number) => ({
    sessionId: 'selected',
    turnId: 'turn',
    startedAt: 1,
    endedAt,
    agents: [
      {
        id: 'child',
        description: 'Review child',
        agentType: null,
        status: 'completed',
        toolUseId: 'launch-child',
        spend: [],
      },
    ],
  });
  const requests: string[] = [];
  let parentClosedTurn = false;
  let provider: any;
  provider = selectedWindowHarness(
    async (request, generation) => {
      requests.push(request.kind);
      if (request.kind === 'retained') {
        // The parent writes the record that closes its turn while this round trip runs.
        parentClosedTurn = true;
        provider.session.size += 20;
        provider.session.mtimeMs += 5;
        return {
          generation,
          revision: provider.revisionOf(request.input.session),
          value: {
            kind: 'retained',
            pages: request.pages,
          },
        };
      }
      assert.ok(request.kind === 'window');
      const result = windowResult(generation, provider.revisionOf(request.input.session));
      assert.ok(result.value.kind === 'window');
      result.value.read = { ...result.value.read, turns: [turn(parentClosedTurn ? 9 : 0)] } as any;
      result.value.agentKey = provider.agentSpendKey(request.input.session, result.value.read);
      result.value.structuralKey = provider.structuralKey(request.input.session);
      return result;
    },
    [
      'progressiveCurrent',
      'structuralKey',
      'claudeStructuralKey',
      'codexStructuralChildren',
      'codexChildRevisions',
      'agentSpendKey',
      'agentFile',
      'agentFactsCurrent',
      'historyAgentKey',
      'refreshAgentFacts',
      'jointSplitWindow',
      'acceptJointSplitWindow',
    ],
  );
  provider.claudeChildReferences = [
    { parentSessionId: 'selected', sessionId: 'child', toolUseIds: ['launch-child'], file: child },
  ];
  provider.claudeChildren = [];
  provider.codexSubagents = [];
  await provider.completeSelectedWindow('selected', 1);
  assert.equal(provider.cache.get('selected.jsonl').read.turns[0].endedAt, 0);

  appendChild('child-second');
  assert.equal(provider.agentFactsCurrent(provider.session), false);
  provider.refresh();
  await provider.completeSelectedWindow('selected', 1);
  await vi.waitFor(() => assert.equal(provider.selectionWork, null));

  assert.equal(
    requests.filter((kind) => kind === 'window').length,
    2,
    'the parent write during the cost refresh reached no reader',
  );
  assert.equal(
    provider.cache.get('selected.jsonl').read.turns[0].endedAt,
    9,
    'the selected card still calls the turn running while the rail row shows it finished',
  );
});

// Resuming a subagent updates its cost while retaining the selected session's turns.

function resumedSubagentProvider(tailShowsChild: boolean, extra: string[] = []) {
  const child = path.join(tempDir('panel-startup-resumed-'), 'agent-child.jsonl');
  const append = (id: string, output: number) =>
    fs.appendFileSync(
      child,
      JSON.stringify({
        type: 'assistant',
        isSidechain: true,
        message: {
          role: 'assistant',
          id,
          model: 'claude-opus-4-1',
          usage: { input_tokens: 20, output_tokens: output },
        },
      }) + '\n',
    );
  append('child-first', 5);
  const agentTurn = (turnId: string) => ({
    sessionId: 'selected',
    turnId,
    startedAt: 1,
    agents: [
      {
        id: 'child',
        description: 'Review child',
        agentType: null,
        status: 'completed',
        toolUseId: 'launch-child',
        spend: [],
      },
    ],
  });
  const lookup = (agent: { status: string }) =>
    agentSpendIsOpen(agent.status)
      ? { models: [], found: false, partial: false, effort: null }
      : readClaudeAgentSpend(child);
  const withSpend = (turns: any[]) => {
    const copy = structuredClone(turns);
    refreshClaudeAgentFacts(copy, lookup, undefined);
    return copy;
  };
  const requests: string[] = [];
  let provider: any;
  provider = selectedWindowHarness(
    async (request, generation) => {
      requests.push(request.kind);
      if (request.kind === 'retained') {
        return {
          generation,
          revision: provider.revisionOf(request.input.session),
          value: {
            kind: 'retained',
            pages: request.pages.map((page) => ({ ...page, turns: withSpend(page.turns) })),
          },
        };
      }
      assert.ok(request.kind === 'window');
      const result = windowResult(generation, provider.revisionOf(request.input.session));
      assert.ok(result.value.kind === 'window');
      result.value.read = { ...result.value.read, turns: withSpend(tailShowsChild ? [agentTurn('newest')] : []) };
      result.value.agentKey = provider.agentSpendKey(request.input.session, result.value.read);
      result.value.structuralKey = provider.structuralKey(request.input.session);
      return result;
    },
    [
      'progressiveCurrent',
      'structuralKey',
      'claudeStructuralKey',
      'agentSpendKey',
      'agentFile',
      'codexStructuralChildren',
      'codexChildRevisions',
      'agentFactsCurrent',
      'historyAgentKey',
      'refreshAgentFacts',
      'jointSplitWindow',
      'acceptJointSplitWindow',
      ...extra,
    ],
  );
  provider.claudeChildReferences = [
    { parentSessionId: 'selected', sessionId: 'child', toolUseIds: ['launch-child'], file: child },
  ];
  provider.claudeChildren = [];
  provider.codexSubagents = [];
  // Refresh starts selected work when its window or cost facts are stale.

  const settle = async () => {
    provider.refresh();
    if (!provider.progressiveCurrent(provider.session) || !provider.agentFactsCurrent(provider.session)) {
      await provider.completeSelectedWindow('selected', 1);
    }
    await vi.waitFor(() => assert.equal(provider.selectionWork, null));
  };
  const costOf = (turns: any[]) => spendTokens(turns[0].agents[0].spend);
  return { provider, requests, append, agentTurn, withSpend, settle, costOf };
}

test('a resumed subagent writing its transcript updates its cost on the selected card with no loading row', async () => {
  const { provider, requests, append, settle, costOf } = resumedSubagentProvider(true, [
    'evictCache',
    'agentListingStamp',
    'claudeChildRevisions',
    'claudeChildVersion',
  ]);
  await provider.completeSelectedWindow('selected', 1);
  assert.equal(costOf(provider.cache.get('selected.jsonl').read.turns), 25);
  const before = provider.refreshResults.length;
  // The cost each refresh draws, read as it starts.
  const drawnCosts: number[] = [];
  const draw = provider.refresh.bind(provider);
  provider.refresh = () => {
    drawnCosts.push(costOf(provider.cache.get('selected.jsonl').read.turns));
    return draw();
  };
  append('child-resumed', 5);
  await settle();

  assert.equal(
    requests.filter((kind) => kind === 'window').length,
    1,
    'a resumed subagent append started another read of the unchanged selected session',
  );
  const afterAppend = provider.refreshResults.slice(before);
  assert.ok(afterAppend.length > 0, 'the resumed subagent append drew nothing');
  for (const loading of afterAppend) {
    assert.equal(
      loading.history?.kind === 'busy',
      false,
      'a resumed subagent append showed a busy loading row below the selected card',
    );
  }
  assert.equal(
    costOf(provider.cache.get('selected.jsonl').read.turns),
    50,
    'the selected card kept the old cost of the resumed subagent',
  );
  assert.equal(drawnCosts.at(-1), 50, 'no refresh drew the new cost of the resumed subagent');
});

test('a resumed subagent writing its transcript updates its cost on a retained older page', async () => {
  const { provider, requests, append, agentTurn, withSpend, settle, costOf } = resumedSubagentProvider(false);
  await provider.completeSelectedWindow('selected', 1);
  const pages = [{ turns: withSpend([agentTurn('older')]), compactions: [], bytes: 40 }];
  provider.history.set('selected', { pages, requests: 1, emptyRuns: 0, atBeginning: false, failed: false });
  provider.historyStructuralKeys.set('selected', provider.historyAgentKey(provider.session, pages));
  assert.equal(provider.agentFactsCurrent(provider.session), true);
  // The older-page cost each refresh draws, read as it starts.
  const drawnCosts: number[] = [];
  const draw = provider.refresh.bind(provider);
  provider.refresh = () => {
    drawnCosts.push(costOf(provider.history.get('selected').pages[0].turns));
    return draw();
  };
  append('child-resumed', 5);
  await settle();

  assert.equal(
    requests.filter((kind) => kind === 'window').length,
    1,
    'a resumed subagent append started another read of the unchanged selected session',
  );
  assert.equal(
    costOf(provider.history.get('selected').pages[0].turns),
    50,
    'the retained older page kept the old cost of the resumed subagent',
  );
  assert.equal(drawnCosts.at(-1), 50, 'no refresh drew the new cost of the resumed subagent on the older page');
});

test('replacement, shrinkage, identity change, and same-size rewrite discard selected work', async () => {
  for (const change of selectedFileChanges) {
    let attempts = 0;
    let finishRetry: (result: ProgressiveResult | null) => void = () => {};
    let provider: any;
    provider = selectedWindowHarness(async (request, generation) => {
      attempts++;
      assert.equal(request.kind, 'window');
      if (attempts === 1) {
        assert.equal(request.checkpoint, undefined, `${change.name} began from an incompatible cached checkpoint`);
        const requested = provider.revisionOf(request.input.session);
        provider.session = change.apply(provider.session);
        return windowResult(generation, requested);
      }
      assert.equal(request.checkpoint, undefined, `${change.name} reused an incompatible checkpoint`);
      return new Promise<ProgressiveResult | null>((resolve) => {
        finishRetry = resolve;
      });
    });
    const checkpoint = { parserKey: 'old revision' } as ProgressiveCheckpoint;
    provider.cache.set('selected.jsonl', {
      key: 'incompatible',
      agentKey: '',
      revision: { ...provider.revisionOf(provider.session), dev: 9, ino: 9 },
      read: {
        turns: [{ sessionId: 'selected', turnId: 'old', startedAt: 1 }],
        compactions: [],
        readBytes: 10,
        turnLimitReached: false,
      },
      checkpoint,
      bytes: 10,
      checkpointBytes: 1,
    });
    provider.history.set(
      'selected',
      loadedHistory(provider.cache.get('selected.jsonl').revision, [
        { turns: [{ sessionId: 'selected', turnId: 'older', startedAt: 1 }], compactions: [], bytes: 40 },
      ]),
    );
    provider.historyStructuralKeys.set('selected', '');
    await provider.completeSelectedWindow('selected', 1);
    await vi.waitFor(() => assert.equal(attempts, 2));
    assert.equal(provider.cache.has('selected.jsonl'), true, `${change.name} discarded the accepted tail before retry`);
    assert.equal(provider.history.has('selected'), true, `${change.name} discarded loaded turns before retry`);
    const stable = windowResult(1, provider.revisionOf(provider.session));
    assert.ok(stable.value.kind === 'window');
    stable.value.reset = true;
    finishRetry(stable);
    await vi.waitFor(() => assert.equal(provider.selectionWork, null));
    assert.equal(provider.history.has('selected'), false, `${change.name} retained stale older turns after reset`);
  }
});

test('a selected read failure becomes visible state and a later read recovers', async () => {
  let fail = true;
  const provider = selectedWindowHarness(async (_request, generation) => {
    if (fail) {
      fail = false;
      throw new Error('read failed');
    }
    return windowResult(generation, provider.revisionOf(provider.session));
  });
  await provider.completeSelectedWindow('selected', 1);
  assert.equal(
    provider.selectionWork,
    null,
    `failed selected work remained held: ${JSON.stringify(provider.selectionWork)}`,
  );
  assert.deepEqual(provider.selectionFailure, {
    sessionId: 'selected',
    generation: 1,
    revision: { size: 10, mtimeMs: 10, dev: 1, ino: 2 },
  });
  assert.equal(provider.refreshes, 1, 'the read failure did not request its visible failed state');
  await provider.completeSelectedWindow('selected', 1);
  assert.equal(provider.selectionFailure, null);
  assert.ok(provider.cache.has('selected.jsonl'), 'the retry did not publish the selected window');
});

// Clearing a read failure must refresh even when the selected window needs no read.

test('a selected read that finds its window held clears a drawn read failure with one refresh', async () => {
  let attempts = 0;
  const provider = selectedWindowHarness(async (_request, generation) => {
    attempts++;
    return windowResult(generation, provider.revisionOf(provider.session));
  });
  await provider.completeSelectedWindow('selected', 1);
  assert.equal(attempts, 1);
  provider.selectionFailure = { sessionId: 'selected', generation: 1, revision: provider.revisionOf(provider.session) };
  const before = provider.refreshes;
  await provider.completeSelectedWindow('selected', 1);
  assert.equal(attempts, 1, 'the held window was read again');
  assert.equal(provider.selectionFailure, null);
  assert.equal(provider.refreshes - before, 1, 'the cleared read failure stayed on screen');
});

test('rejected expanded metadata keeps accepted rail progress for one bounded retry', async () => {
  const requests: ProgressiveRequest[] = [];
  let metadataAttempts = 0;
  const revision = { size: 1024, mtimeMs: 20, dev: 1, ino: 2 };
  const session = {
    file: 'session.jsonl',
    sessionId: 'session',
    agent: 'claude' as const,
    size: revision.size,
    mtimeMs: revision.mtimeMs,
  };
  const scan = {
    bytes: session.size,
    prompts: 1,
    finished: true,
    unattended: false,
    changedFile: false,
    deniedTool: false,
    command: false,
    bridgeSession: false,
    bg: false,
    person: false,
    entrypoint: 'sdk' as const,
  };
  const provider = railEnrichmentHarness(async (request, generation) => {
    requests.push(request);
    if (request.kind === 'starts') {
      return {
        generation,
        revision,
        value: { kind: 'starts', starts: { starts: [10], whole: true }, agentRunScan: scan },
      };
    }
    assert.equal(request.kind, 'metadata');
    metadataAttempts++;
    if (metadataAttempts === 1) {
      throw new Error('optional metadata unavailable');
    }
    return {
      generation,
      revision,
      value: {
        kind: 'metadata',
        coverage: { whole: true, windowBytes: 16 * 1024 * 1024 },
        entry: {
          size: session.size,
          mtimeMs: session.mtimeMs,
          label: 'Session',
          fullLabel: 'Session',
          activityMs: 10,
          agentRun: false,
          outcome: null,
          stats: { turns: [], compactions: [] },
          foldedLabel: 'Session',
        },
      },
    };
  });
  provider.titles.set(session.file, {
    size: session.size,
    mtimeMs: session.mtimeMs,
    label: 'Session',
    fullLabel: 'Session',
    activityMs: 10,
    agentRun: false,
    outcome: null,
    stats: null,
    foldedLabel: 'Session',
  });

  const first = await provider.prepareRailEnrichment([session], 1, new AbortController().signal);
  assert.deepEqual(first, { changed: true, catalogCurrent: true, progress: false });
  assert.deepEqual(provider.titles.get(session.file).starts, { starts: [10], whole: true });
  assert.equal(
    provider.titles.get(session.file).agentRunScan,
    scan,
    'the rejected optional metadata read discarded accepted scan progress',
  );

  provider.refreshGeneration = 2;
  const retry = await provider.prepareRailEnrichment([session], 2, new AbortController().signal);
  assert.deepEqual(retry, { changed: true, catalogCurrent: true, progress: false });
  assert.deepEqual(
    requests.map((request) => request.kind),
    ['starts', 'metadata', 'metadata'],
    'the retry repeated accepted starts instead of requesting only unresolved metadata',
  );
  assert.equal(provider.titles.get(session.file).expandedStatsRead, true);

  provider.refreshGeneration = 3;
  const settled = await provider.prepareRailEnrichment([session], 3, new AbortController().signal);
  assert.deepEqual(settled, { changed: false, catalogCurrent: true, progress: false });
  assert.equal(requests.length, 3, 'settled metadata scheduled another enrichment pass');
});

// A long turn starts before the bounded metadata tail, so the row bolt runs on held stats until enrichment reads the whole file.
// A session listed first that grows between the worker's stat and the host's catalog must not stop the reads of later sessions.
test("a growing first session cannot strand a later session's row facts", async () => {
  const heldRequestAt = Date.parse('2026-10-25T19:25:34Z');
  const newestRequestAt = Date.parse('2026-10-25T20:15:58Z');
  const now = Date.parse('2026-10-25T20:16:30Z');
  const turnStartedAt = Date.parse('2026-10-25T18:29:00Z');
  const factsAt = (requestAt: number) =>
    ({
      turns: [
        {
          startedAt: turnStartedAt,
          endedAt: requestAt,
          finished: false,
          error: false,
          model: 'claude-opus-5',
          provider: null,
          usage: { input: 1, cacheWrite1h: 2_000, cacheWrite5m: 0, cacheRead: 140_000, output: 40, thinking: 0 },
          contextTokens: 150_000,
          contextWindow: 1_000_000,
          contextRequest: {
            at: requestAt,
            lifetime: '1h' as const,
            inferenceClass: null,
            serviceTier: null,
            readBack: false,
            outputTokens: 40,
          },
          childSpendPartial: false,
        },
      ],
      compactions: [],
    }) as SessionStatFacts;
  const growing = {
    file: 'Growing.jsonl',
    sessionId: 'growing',
    agent: 'claude' as const,
    size: 3_400_000,
    mtimeMs: 100,
  };
  const waiting = {
    file: 'Waiting.jsonl',
    sessionId: 'waiting',
    agent: 'claude' as const,
    size: 1_280_000,
    mtimeMs: 200,
  };
  // The bounded tail found no turn in either session, and the waiting session holds stats from an older read.
  const unread = (session: typeof growing) => ({
    size: session.size,
    mtimeMs: session.mtimeMs,
    label: session.sessionId,
    fullLabel: session.sessionId,
    foldedLabel: session.sessionId,
    activityMs: null,
    agentRun: false,
    outcome: null,
    stats: null,
  });
  const growingEntry = unread(growing);
  const waitingEntry = {
    ...unread(waiting),
    heldStats: factsAt(heldRequestAt),
    heldRevision: { mtimeMs: 150, size: 1_000_000 },
  };
  const outcome = {
    finished: false,
    error: false,
    interrupted: false,
    endedAt: newestRequestAt,
    startedAt: turnStartedAt,
  };
  const requests: string[] = [];
  const provider = railEnrichmentHarness(async (request, generation) => {
    const session = (request as { session: typeof growing }).session;
    requests.push(`${request.kind}:${session.sessionId}`);
    if (session === growing) {
      // The worker finds the file larger than the catalog listed it, so the host rejects the read.
      return {
        generation,
        revision: { size: growing.size + 4_096, mtimeMs: growing.mtimeMs + 1, dev: 1, ino: 2 },
        value: { kind: 'stale' },
      };
    }
    const revision = provider.revisionOf(waiting);
    if (request.kind === 'starts') {
      return { generation, revision, value: { kind: 'starts', starts: { starts: [turnStartedAt], whole: true } } };
    }
    assert.equal(request.kind, 'metadata');
    return {
      generation,
      revision,
      value: {
        kind: 'metadata',
        coverage: { whole: true, windowBytes: 16 * 1024 * 1024 },
        entry: { ...unread(waiting), activityMs: newestRequestAt, outcome, stats: factsAt(newestRequestAt) },
      },
    };
  });
  provider.titles.set(growing.file, growingEntry);
  provider.titles.set(waiting.file, waitingEntry);
  const held = railCacheMarkOf(derivedTitleCacheStats(waitingEntry), now);
  assert.ok(
    held?.nearlyGoneAt != null && now >= held.nearlyGoneAt,
    'the held request does not draw a nearly gone bolt',
  );

  const result = await provider.prepareRailEnrichment([growing, waiting], 1, new AbortController().signal);

  const entry = provider.titles.get(waiting.file);
  const mark = railCacheMarkOf(derivedTitleCacheStats(entry), now);
  assert.ok(
    mark?.nearlyGoneAt != null && now < mark.nearlyGoneAt,
    `the waiting session's row bolt still times the held request: ${JSON.stringify(mark)}`,
  );
  assert.deepEqual(mark, railCacheMarkOf(factsAt(newestRequestAt), now));
  assert.equal(entry.heldStats, undefined, 'the enrichment read did not replace the held stats');
  assert.deepEqual(entry.stats, factsAt(newestRequestAt));
  assert.deepEqual(entry.outcome, outcome, 'the running turn did not reach the row');
  assert.deepEqual(requests, ['starts:growing', 'starts:waiting', 'metadata:waiting']);
  assert.deepEqual(provider.titles.get(growing.file), growingEntry, 'the rejected read changed the growing session');
  assert.deepEqual(
    result,
    { changed: true, catalogCurrent: false, progress: false },
    'the follow-up pass reuses the catalog that the growing session outran',
  );
});

// A large session without a scan cursor charges more than the whole pass budget.
// The worker refuses its read before opening the grown file, so the charge must not stop the sessions after it.
test("a refused read of a session larger than the pass budget cannot strand a later session's row facts", async () => {
  const heldRequestAt = Date.parse('2026-10-25T19:25:34Z');
  const newestRequestAt = Date.parse('2026-10-25T20:15:58Z');
  const now = Date.parse('2026-10-25T20:16:30Z');
  const turnStartedAt = Date.parse('2026-10-25T18:29:00Z');
  const factsAt = (requestAt: number) =>
    ({
      turns: [
        {
          startedAt: turnStartedAt,
          endedAt: requestAt,
          finished: false,
          error: false,
          model: 'claude-opus-5',
          provider: null,
          usage: { input: 1, cacheWrite1h: 2_000, cacheWrite5m: 0, cacheRead: 140_000, output: 40, thinking: 0 },
          contextTokens: 150_000,
          contextWindow: 1_000_000,
          contextRequest: {
            at: requestAt,
            lifetime: '1h' as const,
            inferenceClass: null,
            serviceTier: null,
            readBack: false,
            outputTokens: 40,
          },
          childSpendPartial: false,
        },
      ],
      compactions: [],
    }) as SessionStatFacts;
  const large = {
    file: 'Large.jsonl',
    sessionId: 'large',
    agent: 'claude' as const,
    size: 50 * 1024 * 1024,
    mtimeMs: 100,
  };
  const waiting = {
    file: 'Waiting.jsonl',
    sessionId: 'waiting',
    agent: 'claude' as const,
    size: 1_280_000,
    mtimeMs: 200,
  };
  assert.ok(
    Math.min(large.size, RAIL_ENRICHMENT_READ_BYTES) + agentRunScanUnread(large, undefined) > INITIAL_RAIL_READ_BYTES,
    'the large session no longer charges more than the pass budget',
  );
  const unread = (session: typeof large) => ({
    size: session.size,
    mtimeMs: session.mtimeMs,
    label: session.sessionId,
    fullLabel: session.sessionId,
    foldedLabel: session.sessionId,
    activityMs: null,
    agentRun: false,
    outcome: null,
    stats: null,
  });
  const largeEntry = unread(large);
  const waitingEntry = {
    ...unread(waiting),
    heldStats: factsAt(heldRequestAt),
    heldRevision: { mtimeMs: 150, size: 1_000_000 },
  };
  const requests: string[] = [];
  const provider = railEnrichmentHarness(async (request, generation) => {
    const session = (request as { session: typeof large }).session;
    requests.push(`${request.kind}:${session.sessionId}`);
    if (session === large) {
      // The worker's stat finds the file larger than requested and refuses the read before opening it.
      return {
        generation,
        revision: { size: large.size + 4_096, mtimeMs: large.mtimeMs + 1, dev: 1, ino: 2 },
        value: { kind: 'stale', unread: true },
      };
    }
    const revision = provider.revisionOf(waiting);
    if (request.kind === 'starts') {
      return { generation, revision, value: { kind: 'starts', starts: { starts: [turnStartedAt], whole: true } } };
    }
    return {
      generation,
      revision,
      value: {
        kind: 'metadata',
        coverage: { whole: true, windowBytes: 16 * 1024 * 1024 },
        entry: { ...unread(waiting), activityMs: newestRequestAt, stats: factsAt(newestRequestAt) },
      },
    };
  });
  provider.titles.set(large.file, largeEntry);
  provider.titles.set(waiting.file, waitingEntry);
  const held = railCacheMarkOf(derivedTitleCacheStats(waitingEntry), now);
  assert.ok(
    held?.nearlyGoneAt != null && now >= held.nearlyGoneAt,
    'the held request does not draw a nearly gone bolt',
  );

  await provider.prepareRailEnrichment([large, waiting], 1, new AbortController().signal);

  assert.deepEqual(requests, ['starts:large', 'starts:waiting', 'metadata:waiting']);
  const entry = provider.titles.get(waiting.file);
  assert.equal(entry.heldStats, undefined, 'the enrichment read did not replace the held stats');
  assert.deepEqual(entry.stats, factsAt(newestRequestAt));
  const mark = railCacheMarkOf(derivedTitleCacheStats(entry), now);
  assert.ok(
    mark?.nearlyGoneAt != null && now < mark.nearlyGoneAt,
    `the waiting session's row bolt still times the held request: ${JSON.stringify(mark)}`,
  );
  assert.deepEqual(provider.titles.get(large.file), largeEntry, 'the refused read changed the large session');
});

test('failed turn start and recovery reads of one session are each logged once until that kind of read succeeds', async () => {
  const session = {
    file: 'Mixed/Session.jsonl',
    sessionId: 'session',
    agent: 'claude' as const,
    size: 64,
    mtimeMs: 20,
  };
  const unread = {
    size: session.size,
    mtimeMs: session.mtimeMs,
    label: 'Session',
    fullLabel: 'Session',
    foldedLabel: 'session',
    stats: null,
    outcome: null,
    expandedStatsRead: false,
    metadataWindow: { whole: false, windowBytes: 1 },
  };
  let startsSucceed = false;
  const provider = railEnrichmentHarness(async (request, generation) => {
    if (request.kind === 'starts' && startsSucceed) {
      return {
        generation,
        revision: { size: session.size, mtimeMs: session.mtimeMs, dev: 1, ino: 2 },
        value: { kind: 'starts', starts: { starts: [], whole: true } },
      };
    }
    return null;
  });
  const records: Record<string, unknown>[] = [];
  provider.diagnostics = {
    warn: (event: string, record: Record<string, unknown>) => records.push({ event, ...record }),
  };
  provider.titles.set(session.file, unread);
  // Every pass reads turn starts and then recovery, and both fail.
  for (let pass = 0; pass < 3; pass++) await provider.prepareRailEnrichment([session], 1, new AbortController().signal);
  assert.deepEqual(
    records,
    [
      { event: 'sessionReadFailed', read: 'starts', file: session.file },
      { event: 'sessionReadFailed', read: 'recovery', file: session.file },
    ],
    'alternating failures of one session were logged more than once for each kind',
  );

  // A successful turn start read forgets its failure, so the next failure of that kind is logged again.
  startsSucceed = true;
  await provider.prepareRailEnrichment([session], 1, new AbortController().signal);
  startsSucceed = false;
  provider.titles.set(session.file, unread);
  await provider.prepareRailEnrichment([session], 1, new AbortController().signal);
  assert.deepEqual(
    records.slice(2),
    [{ event: 'sessionReadFailed', read: 'starts', file: session.file }],
    'a failure after a successful read of the same kind was not logged',
  );
});

test('a session read cancelled by its refresh writes no failure record', async () => {
  const session = { file: 'Mixed/Session.jsonl', sessionId: 'session', agent: 'codex' as const, size: 64, mtimeMs: 20 };
  for (const cancel of ['abort', 'newer generation'] as const) {
    const controller = new AbortController();
    const provider = railEnrichmentHarness(async () => {
      // The worker resolves a cancelled request without a result.
      if (cancel === 'abort') controller.abort();
      else provider.refreshGeneration++;
      return null;
    });
    const records: unknown[] = [];
    provider.diagnostics = { warn: (event: string, record: unknown) => records.push([event, record]) };
    provider.titles.set(session.file, {
      size: session.size,
      mtimeMs: session.mtimeMs,
      label: 'Session',
      fullLabel: 'Session',
      foldedLabel: 'session',
      stats: null,
      outcome: null,
      expandedStatsRead: false,
      metadataWindow: { whole: false, windowBytes: 1 },
    });
    await provider.prepareRailEnrichment([session], 1, controller.signal);
    assert.deepEqual(records, [], `a read cancelled by ${cancel} was logged as a failure`);
  }
});

test('the listener precedes shell assignment and each restored host receives its own initial readiness', async () => {
  const provider = harness();
  const first = host(true);
  const second = host();
  provider.attach(first);
  provider.attach(second);
  assert.equal(provider.reads, 1);
  await provider.sendToHost(second, { type: 'render' });
  assert.equal(second.sent.length, 0);
  second.ready();
  first.ready();
  second.ready();
  assert.equal(provider.reads, 2);
  await provider.sendToHost(first, { type: 'render' });
  await provider.sendToHost(second, { type: 'render' });
  assert.deepEqual(
    first.sent.map((message: any) => message.type),
    ['visibility', 'render'],
  );
  assert.deepEqual(
    second.sent.map((message: any) => message.type),
    ['visibility', 'render'],
  );
});

test('startup milestones keep their first measurement under one operation id', () => {
  const counters = new PanelPerformanceCounters(1000);
  counters.recordStartup('shellReady', 10);
  counters.recordStartup('catalogReady', 20);
  counters.recordStartup('railReady', 30);
  counters.recordStartup('firstCard', 50);
  counters.recordStartup('completeRender', 60);
  counters.recordStartup('firstCard', 80);
  assert.deepEqual(counters.snapshot().startup, {
    id: 1,
    milestones: { shellReady: 10, catalogReady: 20, railReady: 30, firstCard: 50, completeRender: 60 },
  });
});

test('host startup timing ignores an old generation and an unready host acknowledgement', () => {
  const provider = harness();
  const panel = host();
  const counters = new PanelPerformanceCounters();
  provider.performanceCounters = counters;
  provider.refreshGeneration = 2;
  provider.browserPainted(panel, 2, 'firstCard');
  assert.equal(counters.snapshot().startup, undefined);
  provider.readyHosts.add(panel);
  provider.browserPainted(panel, 1, 'firstCard');
  assert.equal(counters.snapshot().startup, undefined);
  provider.browserPainted(panel, 2, 'firstCard');
  assert.equal(typeof counters.snapshot().startup?.milestones.firstCard, 'number');
});

// The ledger save methods, and the production waits their scheduler runs on.
const LEDGER_SAVE_METHODS = [
  'newProjectSpendSaveScheduler',
  'scheduleProjectSpendSave',
  'flushProjectSpendSave',
  'commitProjectSpendCheckpoint',
  'retryProjectSpendSave',
  'cancelProjectSpendSaveRetry',
];
const LEDGER_SAVE_SCOPE = {
  BoundedTrailingScheduler,
  PROJECT_SPEND_SAVE_MS,
  PROJECT_SPEND_SAVE_MAX_MS,
  projectSpendSaveRetryDelay,
};

// Another process holds the ledger file, so the rename fails as it does on Windows.
function heldLedgerFile(): Error {
  return Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
}

// The harness supplies session list payloads and records later posts.
function railPostHarness(extraMethods: string[], scope: Record<string, unknown> = {}): any {
  const provider = completeDiscoveryHarness(
    undefined,
    false,
    ['postRail', 'post', 'sendToHost', 'readOwner', 'readSynchronization', 'readFacts', ...extraMethods],
    {
      normalizePanelState,
      HostReadPersistence,
      preserveHostRead,
      projectAgentRead,
      remapReaderParents,
      readMovedOnlyFor,
      STATE_KEY: 'arc.panel',
      pruneSpendFilesWithResult: (files: unknown[]) => ({ files, pruned: false }),
      ...scope,
    },
  );
  let build = 0;
  provider.useRailPayload(() => ({ rail: [`build ${build++}`] }));
  provider.refresh = () => Promise.resolve();
  provider.completeSelectedWindow = () => Promise.resolve();
  provider.saved = normalizePanelState({});
  provider.memento = { update: async () => {} };
  provider.readSession = (sessionId: string, newestAt: number) =>
    provider.readOwner().read(
      {
        id: `${sessionId}:${newestAt}`,
        observedRevision: provider.saved.readRevision ?? 0,
        action: 'session',
        target: { sessionId, startedAt: newestAt },
        newestAt,
        read: true,
      },
      () => null,
      () => true,
    );
  provider.rails = () => provider.messages.filter((message: any) => message.type === 'rail');
  return provider;
}

function projectSpendHydrationHarness(
  loadSpendLedger: () => {
    files: object[];
    completeFiles: object[];
  },
): any {
  const provider = railPostHarness(['hydrateProjectSpend', 'railRows'], { loadSpendLedger, stableRailOrder });
  provider.disposed = false;
  provider.projectSpendWorkspace = 'project';
  provider.projectSpendStorageDir = 'storage';
  provider.projectSpendHydrated = false;
  provider.projectSpendHydrationReady = true;
  provider.projectSpendRevision = 0;
  provider.projectSpendFiles = [];
  provider.projectSpendVisibleFiles = [];
  provider.scheduleProjectSpendSave = () => {};
  provider.scheduleProjectSpendMidnight = () => {};
  provider.scheduleProjectSpendIndex = () => {};
  return provider;
}

// Saved read watermarks supply the session list unread counts.
function readCounts(provider: any): void {
  provider.unreadCounts = () =>
    new Map(
      Object.entries(provider.saved.readTo).map(([session, to]) => [
        session,
        { count: 100 - (to as number), atLeast: false },
      ]),
    );
}

test('opening a session leaves the rail to the render that selection asked for', async () => {
  const owed = railPostHarness(['show', 'saveState', 'readPrint', 'settleRailSeed']);
  readCounts(owed);
  let finishOwed!: () => void;
  owed.refresh = () =>
    new Promise<void>((resolve) => {
      finishOwed = resolve;
    });
  owed.show('session-a');
  const owedRead = owed.readSession('session-a', 10);
  assert.deepEqual(
    owed.rails(),
    [],
    'the selection words the rail twice, once in its render and once from the read state it saved',
  );
  // A selection refresh that posts no render still owes the session list update.
  await owedRead;
  finishOwed();
  await vi.waitFor(() => assert.equal(owed.rails().length, 1));
  assert.equal(owed.railSeedSkipped, false);

  const provider = railPostHarness(['show', 'saveState', 'readPrint', 'settleRailSeed']);
  readCounts(provider);
  let finishSelection!: () => void;
  provider.refresh = () =>
    new Promise<void>((resolve) => {
      finishSelection = resolve;
    });
  provider.show('session-a');
  await provider.readSession('session-a', 10);
  await provider.readSession('session-b', 20);
  assert.equal(provider.rails().length, 1, 'a card the reader did not open keeps a count it has lost');

  // The second save already posts both read marks, satisfying the pending session list update.
  finishSelection();
  await vi.waitFor(() => assert.equal(provider.railSeedSkipped, false));
  assert.equal(provider.rails().length, 1, 'the owed rail was worded again over unmoved inputs');

  await provider.readSession('session-a', 30);
  assert.equal(provider.rails().length, 2, 'a read mark made once the selection settled never reaches the rail');
});

test('session selection reads cached spend signatures without enumerating sources', async () => {
  const provider = paintHarness();
  provider.watching = true;
  provider.spendIntegrity = {
    warmFiles() {
      throw new Error('selection enumerated watch priorities');
    },
  };
  provider.lastSpendSourceSignature = 'accepted catalog';
  let signatures = 0;
  provider.useSpendSignature(() => {
    signatures++;
    return 'unwanted enumeration';
  });
  provider.useListingSignature(listingSignature);
  provider.projectSpendSources = () => {
    throw new Error('selection enumerated spend sources');
  };
  provider.updateProjectSpendIntegrity = () => {
    throw new Error('selection rebuilt spend catalog');
  };
  await provider.refresh(true, true, false, true);
  await provider.refresh(true, true, false, true);
  assert.equal(signatures, 0);
  assert.equal(provider.messages.filter((message: any) => message.type === 'selection').length, 2);
});

// The harness retains the refresh stages that precede the render post.
function paintHarness(extraMethods: string[] = [], scope: Record<string, unknown> = {}): any {
  const session = {
    file: 'claude.jsonl',
    sessionId: 'claude-a',
    agent: 'claude',
    activity: 100,
    size: 1,
    mtimeMs: 1,
  };
  const provider = completeDiscoveryHarness(undefined, false, extraMethods, scope);
  provider.initialNamesChanged = () => {};
  provider.partial = [session];
  provider.catalog = { sessions: [session] };
  provider.discovery = Promise.resolve(true);
  return provider;
}

function recordPosts(provider: any, order: string[]): void {
  const send = provider.sendToHost.bind(provider);
  provider.sendToHost = (host: unknown, message: unknown) => {
    order.push('render posted');
    return send(host, message);
  };
}

test('a refresh posts the render the panel paints from before it offers a spend source', async () => {
  const provider = paintHarness(['scheduleProjectSpendIndex']);
  const order: string[] = [];
  provider.useSpendOfferGate(() => true);
  provider.useSpendSignature(() => 'changed source');
  provider.queueProjectSpendIndex = () => {
    order.push('spend sources offered');
  };
  recordPosts(provider, order);

  await provider.refresh(true);
  // The deferred spend offer must run after the render post.

  await vi.waitFor(() => assert.ok(order.includes('spend sources offered')));
  assert.ok(
    order.indexOf('render posted') < order.indexOf('spend sources offered'),
    'the paint waited on the spend offer, which stats every source the listing walk did not describe',
  );
});

test('a ready scope change while every panel is hidden retains its catalog rows', async () => {
  const provider = paintHarness(['repositoryScopeChanged'], { scopeInside: isInside });
  provider.anyVisible = () => false;
  provider.selectionWorks = new Map();
  provider.refreshFrom = () => {};
  provider.repositoryScope = { snapshot: () => ({ ready: true, roots: ['C:/kept'] }) };
  provider.authoritativeCatalog = [
    { sessionId: 'kept', cwd: 'C:/kept/project' },
    { sessionId: 'removed', cwd: 'C:/removed/project' },
    { sessionId: 'unknown', cwd: null },
  ];
  provider.newDrafts = { draft: { draftId: 'draft', cwd: 'C:/removed/draft' } };
  provider.awaitingSessionRecords = { awaiting: { sessionId: 'awaiting', cwd: 'C:/removed/new' } };
  provider.repositoryScopeChanged();
  await provider.refresh(true);
  assert.equal(provider.authoritativeCatalog.length, 3, 'hidden refresh must retain its catalog');
});

test('a repository scope change leaves a discovery continuation running and sends the next request under the new roots', async () => {
  const provider = paintHarness(['repositoryScopeChanged'], { scopeInside: isInside });
  provider.selectionWorks = new Map();
  provider.repositoryScope = { snapshot: () => ({ ready: true, roots: ['project', 'project/worker'] }) };
  provider.windowStateHandler = () => {};
  provider.publishWindowState = () => {};
  const requests: { roots: string[]; signal: AbortSignal }[] = [];
  let finishPass!: (discovered: boolean) => void;
  provider.prepareClaudeChildren = (_generation: number, signal: AbortSignal) => {
    requests.push({ roots: [...provider.repositoryScopeRoots], signal });
    if (requests.length === 1) return new Promise<boolean>((resolve) => (finishPass = resolve));
    // A later request finishes discovery, so the host sends no further continuation.
    provider.dispatchDiscoveryPending = false;
    return Promise.resolve(true);
  };
  provider.dispatchDiscoveryPending = true;
  const continuation = provider.continueDiscovery();
  await vi.waitFor(() => assert.equal(requests.length, 1));
  const generation = provider.refreshGeneration;
  provider.repositoryScopeChanged();
  // Cancelling the request would close the worker's receipt scan, and the next request would read every receipt again.
  assert.equal(requests[0].signal.aborted, false, 'the scope change cancelled the discovery continuation');
  assert.ok(provider.refreshGeneration > generation, 'the continuation kept the current generation');
  await vi.waitFor(() => assert.equal(requests.length, 2));
  assert.deepEqual(requests[1].roots, ['project', 'project/worker']);
  assert.equal(requests[0].signal.aborted, false);
  // A later cancellation, such as a workspace folder change, still reaches the kept continuation.
  provider.abandonCatalogRefresh();
  assert.equal(requests[0].signal.aborted, true, 'the kept discovery continuation outlived a cancellation');
  finishPass(true);
  await continuation;
});

test('hidden workspace-folder changes retain known directories until the replacement scope removes them', async () => {
  const provider = paintHarness(['workspaceFoldersChanged', 'repositoryScopeChanged'], { scopeInside: isInside });
  provider.anyVisible = () => false;
  provider.selectionWorks = new Map();
  provider.refreshFrom = () => {};
  provider.cancelProjectSpendHydration = () => {};
  provider.allowThemeFiles = () => {};
  let ready = false;
  let roots = ['C:/kept'];
  provider.repositoryScope = { snapshot: () => ({ ready, roots: ready ? roots : [] }) };
  provider.authoritativeCatalog = [
    { sessionId: 'kept', cwd: 'C:/kept/project' },
    { sessionId: 'removed', cwd: 'C:/removed/project' },
    { sessionId: 'unknown', cwd: null },
  ];
  provider.newDrafts = {};
  provider.awaitingSessionRecords = {};
  provider.workspaceFoldersChanged();
  await provider.refresh(true);
  assert.equal(provider.authoritativeCatalog, null, 'workspace invalidation must remove the old rendering catalog');
  ready = true;
  provider.repositoryScopeChanged();
  await provider.refresh(true);
  assert.deepEqual(
    [...provider.scopeSessionDirectories],
    [['kept', 'C:/kept/project']],
    'a surviving session must keep its directory until catalog replacement',
  );
  assert.equal(provider.authoritativeCatalog, null, 'hidden cancellation must not require a rebuilt catalog');
  ready = false;
  provider.workspaceFoldersChanged();
  await provider.refresh(true);
  roots = ['C:/different'];
  ready = true;
  provider.repositoryScopeChanged();
  await provider.refresh(true);
  assert.equal(
    provider.scopeSessionDirectories.size,
    0,
    'confirmed departures must release their retained directories',
  );
  assert.equal(provider.authoritativeCatalog, null);
});

test('a full deferred-metadata refresh retains hosted starts until matching authoritative publication', async () => {
  const provider = paintHarness(['railRows', 'rowForSession'], { stableRailOrder });
  const pending = { sessionId: 'accepted-start', createdAt: 1, agent: 'codex', cwd: 'project' };
  const source = { ...pending, file: 'accepted.jsonl', size: 1, mtimeMs: 1, dev: 1, ino: 2 };
  provider.partial = [source];
  provider.authoritativeCatalog = [];
  provider.authoritativeCatalogScope = JSON.stringify(['project']);
  provider.awaitingSessionRecords = { [pending.sessionId]: pending };
  await provider.refresh(true, true, true);
  assert.equal(provider.awaitingSessionRecords[pending.sessionId], pending);
  assert.deepEqual(provider.authoritativeCatalog, []);
  assert.equal(
    resolveResponseSession(
      pending.sessionId,
      provider.authoritativeCatalog,
      Object.values(provider.awaitingSessionRecords),
      () => true,
    ).kind,
    'resolved',
  );
  provider.partial = [{ ...source, agent: 'claude' }];
  provider.railOrder = [pending.sessionId];
  await provider.refresh(true, true, false);
  assert.equal(provider.awaitingSessionRecords[pending.sessionId], pending);
  const displayed = provider.railRows(new Map());
  assert.equal(displayed.find((row: any) => row.id === pending.sessionId)?.agentKey, 'claude');
  let selectedAgent: string | null = null;
  provider.onSelectionChanged = (_session: string, agent: string) => {
    selectedAgent = agent;
  };
  provider.ownCwdForSession = () => 'project';
  const refresh = provider.refresh;
  provider.refresh = () => Promise.resolve();
  try {
    provider.show(pending.sessionId);
    assert.equal(selectedAgent, 'claude', 'the displayed Claude session selects the pending Codex identity');
  } finally {
    provider.refresh = refresh;
  }
  assert.equal(provider.rowForSession(pending.sessionId)?.agentKey, 'claude');
  assert.equal(provider.sessionRows.filter((row: any) => row.id === pending.sessionId).length, 1);
  assert.equal(
    resolveResponseSession(
      pending.sessionId,
      provider.authoritativeCatalog,
      Object.values(provider.awaitingSessionRecords),
      () => true,
    ).kind,
    'ambiguous',
  );
  provider.partial = [source];
  await provider.refresh(true, true, false);
  assert.deepEqual(provider.awaitingSessionRecords, {});
});

test('an oversized full refresh records the largest ready-host message after each post', async () => {
  const provider = paintHarness(['sendToHost']);
  const order: string[] = [];
  const oversizedLabel = 'x'.repeat((messageByteBudget('render') ?? 0) + 1);
  const railRow = {
    id: 'session-a',
    label: oversizedLabel,
    toJSON() {
      order.push('rail row serialized');
      return { id: this.id, label: this.label };
    },
  };
  const rail = [railRow];
  provider.useRailPayload(() => ({ rail, labels: [], views: [], railFilters: [], stats: {} }));
  const warnings: string[] = [];
  provider.performanceOutput = {
    appendLine(message: string) {
      warnings.push(message);
    },
  };
  const first = provider.hosts[0];
  const recordPost = (message: unknown) => {
    provider.messages.push(message);
    order.push('render posted');
    return Promise.resolve(true);
  };
  const second = { webview: { postMessage: recordPost }, active: () => false, visible: () => true };
  first.webview.postMessage = recordPost;
  provider.hosts = [first, second];
  provider.readyHosts = new Set(provider.hosts);
  provider.hostSessions = new Map([
    [first, 'large'],
    [second, 'small'],
  ]);
  provider.awaitingSessionRecords = {
    large: { sessionId: 'large', createdAt: 1, agent: 'claude', cwd: 'project' },
    small: { sessionId: 'small', createdAt: 1, agent: 'claude', cwd: 'project' },
  };
  provider.usagePayloadForSession = (session: string) => ({
    account: session === 'large' ? 'y'.repeat(1_000) : 'y',
  });
  const serialize = JSON.stringify;
  const spy = vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown, ...rest: unknown[]) => {
    const type = (value as { type?: unknown } | null)?.type;
    if (type === 'render' || type === 'rail') {
      order.push(`${type} serialized`);
    }
    if (value === rail) {
      order.push('rail array serialized');
    }
    return (serialize as unknown as (...args: unknown[]) => string)(value, ...rest);
  }) as typeof JSON.stringify);
  try {
    await provider.refresh(true);
  } finally {
    spy.mockRestore();
  }

  // Each host prints its rows once to choose the changed rows, then measures the posted message once.
  assert.deepEqual(
    order,
    [
      'rail row serialized',
      'render posted',
      'render serialized',
      'rail row serialized',
      'rail row serialized',
      'render posted',
      'render serialized',
      'rail row serialized',
    ],
    'the oversized full refresh serialized before a post or serialized a host rail more than to print and measure it',
  );
  assert.match(warnings[0], /^render message is \d+ bytes, above its 250000-byte budget\. Largest non-rail fields:/);
  const measured = provider.messages.map((message: unknown) => serializedMessageBytes(message));
  assert.ok(
    measured[0] !== null && measured[1] !== null && measured[0] > measured[1],
    'the fixture did not put the larger render before the smaller render',
  );
  assert.equal(provider.lastRailMessageType, 'render');
  assert.equal(
    provider.lastRailMessageSerializedBytes,
    measured[0],
    'rail diagnostics did not retain the largest render from the delivery',
  );
});

test('a rail update serializes once for each actual ready-host post', () => {
  const provider = railPostHarness(['post', 'sendToHost']);
  const order: string[] = [];
  // A keyed row travels as a row delta, so every print of it reaches the order.
  const row = {
    id: 'changed',
    toJSON() {
      order.push('rail row serialized');
      return { id: 'changed' };
    },
  };
  provider.useRailPayload(() => ({ rail: [row], labels: [], views: [], railFilters: [], stats: {} }));
  const host = (name: string) => ({
    webview: {
      postMessage(message: unknown) {
        order.push(`${name} posted ${(message as { type?: unknown }).type}`);
        return Promise.resolve(true);
      },
    },
    active: () => false,
    visible: () => true,
  });
  const ready = host('ready');
  const unready = host('unready');
  provider.hosts = [ready, unready];
  provider.readyHosts = new Set([ready]);
  const serialize = JSON.stringify;
  const spy = vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown, ...rest: unknown[]) => {
    if ((value as { type?: unknown } | null)?.type === 'rail') {
      order.push('rail serialized');
    }
    return (serialize as unknown as (...args: unknown[]) => string)(value, ...rest);
  }) as typeof JSON.stringify);
  try {
    provider.postRail(true);
  } finally {
    spy.mockRestore();
  }

  // The ready host prints its row to choose the changed rows, then measures the posted message once.
  assert.deepEqual(
    order,
    ['rail row serialized', 'ready posted rail', 'rail serialized', 'rail row serialized'],
    'a rail update serialized outside an actual ready-host post or serialized one post more than once',
  );
});

test('an oversized rail warning does not serialize the rail data again', () => {
  const provider = railPostHarness(['post', 'sendToHost']);
  const oversizedLabel = 'x'.repeat((messageByteBudget('rail') ?? 0) + 1);
  let railSerializations = 0;
  const railRow = {
    id: 'session-a',
    label: oversizedLabel,
    toJSON() {
      railSerializations += 1;
      return { id: this.id, label: this.label };
    },
  };
  provider.useRailPayload(() => ({ rail: [railRow], labels: [], views: [], railFilters: [], stats: {} }));
  const warnings: string[] = [];
  provider.performanceOutput = {
    appendLine(message: string) {
      warnings.push(message);
    },
  };
  const ready = {
    webview: {
      postMessage() {
        return Promise.resolve(true);
      },
    },
    active: () => false,
    visible: () => true,
  };
  provider.hosts = [ready];
  provider.readyHosts = new Set([ready]);

  provider.postRail(true);

  // One serialization prints the row to choose the changed rows, and one measures the posted message.
  assert.equal(
    railSerializations,
    2,
    'the first oversized rail warning serialized the rail data again for its field breakdown',
  );
  assert.match(warnings[0], /^rail message is \d+ bytes, above its 1100000-byte budget\. Largest non-rail fields:/);
});

test('a selection replacement does not mark omitted rail state as delivered', async () => {
  const provider = paintHarness();
  const deliveredKey = { delivered: true };
  provider.lastRailKey = deliveredKey;
  provider.lastRailMessageType = 'rail';
  provider.lastRailMessageSerializedBytes = 73;
  provider.lastRailAdoptionsJson = 'complete adoptions';

  await provider.refresh(true, true, false, true);

  assert.strictEqual(
    provider.lastRailKey,
    deliveredKey,
    'the selection replacement recorded a key for peer rows and labels it did not send',
  );
  assert.equal(
    provider.lastRailMessageType,
    'rail',
    'the selection replacement changed the message type for peer rows and labels it did not send',
  );
  assert.equal(
    provider.lastRailMessageSerializedBytes,
    73,
    'the selection replacement recorded bytes for peer rows and labels it did not send',
  );
  assert.equal(
    provider.lastRailAdoptionsJson,
    'complete adoptions',
    'the selection replacement marked session adoptions it did not send as delivered',
  );
});

test('a process exit refreshes a background subagent row without a transcript write', async () => {
  const provider = paintHarness(['setRunning', 'runningSessions', 'renderTurnCard', 'postRail'], {
    runningSessions,
    pressOfKind,
    toCard,
    renderRichMarkdown: (text: string) => text,
  });
  provider.cardCacheExpiryWarning = () => null;
  const launched = Date.now() - 120_000;
  const recorded = turn({
    sessionId: 'claude-a',
    agents: [
      {
        id: null,
        toolUseId: 'agent-1',
        description: 'Audit the parser',
        agentType: 'Explore',
        model: 'claude-haiku-4-5',
        effort: null,
        spend: [],
        spendFound: false,
        spendPartial: false,
        durationMs: null,
        tokens: null,
        toolUses: null,
        status: 'async_launched',
      },
    ],
    steps: [{ ordinal: 1, name: 'Agent', id: 'agent-1', detail: '', at: launched, status: 'done' }],
    stepCount: 1,
  });
  provider.running = new Set(['claude:claude-a']);
  provider.runningSinceKeys = new Map([['claude:claude-a', launched]]);
  provider.sessionRows = [{ id: 'claude-a', agentKey: 'claude' }];
  provider.turnsByKey = new Map();
  provider.collect = () => [provider.renderTurnCard(recorded, false, 'Audit', Date.now())];

  await provider.refresh(true);
  const first = provider.messages[0].cards[0].agents[0];
  assert.deepEqual([first.state, first.since], ['running', launched]);

  provider.setRunning([]);
  await vi.waitFor(() => assert.equal(provider.messages.length, 2));
  const second = provider.messages[1].cards[0].agents[0];
  assert.deepEqual(
    [second.state, second.since],
    ['open', null],
    'a process exit left the selected subagent row busy until a transcript write',
  );
});

// The harness retains spend offers across panel changes and cancels them at workspace changes or disposal.

function spendOfferHarness(scope: Record<string, unknown> = {}): any {
  const provider = completeDiscoveryHarness(
    undefined,
    false,
    [
      'scheduleProjectSpendIndex',
      'cancelProjectSpendOffers',
      'projectSpendBusy',
      'projectSpendSources',
      'displayedProjectSpendFiles',
      'ensureProjectSpendWorkspace',
      'dispose',
      'disposeOwned',
      ...LEDGER_SAVE_METHODS,
    ],
    {
      ...LEDGER_SAVE_SCOPE,
      saveSpendLedger: () => {},
      discoverCodexSpendSources: () => [],
      projectSpendDisplayFiles,
      projectSpendWorkspace: (folders: string[]) => folders[0] ?? null,
      MULTI_ROOT_SPEND_WORKSPACE_PREFIX: 'multi:',
      loadSpendLedger: () => ({ files: [], completeFiles: [] }),
      pruneSpendFilesWithResult: (files: unknown[]) => ({ files, pruned: false }),
      ...scope,
    },
  );
  let folders = ['project'];
  provider.folders = () => folders;
  provider.useFolders = (next: string[]) => {
    folders = next;
  };
  provider.claudeSpendSources = [];
  provider.codexSpendSources = [];
  provider.codexSubagents = [];
  provider.projectSpendWorkspace = 'project';
  provider.projectSpendStorageDir = 'storage';
  provider.projectSpendFiles = [];
  provider.projectSpendVisibleFiles = [];
  provider.projectSpendQueue = [];
  provider.projectSpendQueued = new Set();
  provider.projectSpendTick = null;
  provider.projectSpendMidnight = null;
  provider.projectSpendRevision = 0;
  provider.postProjectSpend = () => {};
  provider.flushProjectSpendSave = () => {};
  provider.scheduleProjectSpendSave = () => {};
  provider.scheduleProjectSpendMidnight = () => {};
  // What disposal reaches for beyond the ledger.
  provider.progressiveWorker = {
    run() {
      return Promise.resolve(null);
    },
    stop() {},
  };
  provider.repositoryScope = { dispose() {} };
  provider.stopPolling = () => {};
  provider.writeDrafts = () => Promise.resolve();
  provider.writeDerivedCache = () => false;
  provider.derivedCacheCheckpointTick = null;
  provider.derivedCacheCheckpointState = { dirty: false, markSaved() {} };
  provider.activitySessions = new Set();
  provider.replyPost = null;
  provider.activityPost = null;
  provider.draftSave = null;
  provider.performanceOutput = null;
  provider.disposables = [];
  return provider;
}

// Each offer carries a marker to identify its timer execution.

function markedOffer(provider: any, mark: string): void {
  provider.scheduleProjectSpendIndex(new Map([['mark', mark]]), null);
}

// Production ownership supplies checking, indexing, publication, and panel lifecycle.
function integrityHostHarness(scope: Record<string, unknown> = {}, extraMethods: string[] = []): any {
  const provider = railPostHarness(
    [
      'updateProjectSpendIntegrity',
      'checkProjectSpendSources',
      'publishProjectSpendCoverage',
      'queueProjectSpendIndex',
      'indexNextProjectSpendFile',
      'finishProjectSpendIndex',
      'projectSpendHistoryCutoff',
      'scheduleProjectSpendIndex',
      'invalidateProjectSpendSnapshot',
      'projectSpendPayload',
      'postProjectSpend',
      'projectSpendBusy',
      'startPolling',
      'pollCatalog',
      'pollDirectories',
      'stopPolling',
      'watchDirectories',
      'wakeFromWatch',
      ...extraMethods,
    ],
    {
      normalizeSpendFile: (file: string) => file,
      spendRecordAgent,
      spendSourceHeld,
      IntegrityScheduler,
      projectSpendHistoryCutoff,
      projectSpendOfferDecision,
      spendRecordChangesRail,
      spendRecordHoldsLongLine,
      releaseSpendHeldLine,
      createClaudeUsageLineReducer,
      createCodexUsageLineReducer,
      indexSpendFile,
      invalidateSpendFileNormalization: () => {},
      prepareProjectSpendViewSteps,
      publicProjectSpendPrice,
      POLL_INTERVAL_MILLISECONDS: 1000,
      PollDirectoryGate,
      sessionDirectoryOwners,
      ...scope,
    },
  );
  Object.assign(provider, {
    projectSpendWorkspace: 'project',
    projectSpendStorageDir: 'storage',
    projectSpendRevision: 0,
    projectSpendSnapshotPrice: publicProjectSpendPrice,
    projectSpendQueue: [],
    projectSpendQueued: new Set(),
    projectSpendTick: null,
    sessionSpendSources: [],
    hostSessions: new Map(),
    running: new Set(),
    spendSourcesByFile: new Map(),
    spendRecordsByFile: new Map(),
    spendChecks: new SpendCoverage(),
    spendCoverageAt: null,
    sourceEnumerations: { claude: { status: 'complete' }, codex: { status: 'complete' } },
    membershipCoverage: { status: 'complete' },
    catalogWalked: true,
    codexStats: new CodexStatCache(),
    watchers: new Map(),
    pendingWatch: {
      clear() {},
      noteFileEvent() {
        return true;
      },
    },
    watchScheduler: { cancel() {}, offer() {} },
    poll: null,
  });
  provider.projectSpendSources = () => [];
  provider.scheduleProjectSpendSave = () => {};
  if (!extraMethods.includes('postRailIfSpendPendingMoved')) provider.postRailIfSpendPendingMoved = () => {};
  if (!extraMethods.includes('postDispatchedCostsIfMoved')) provider.postDispatchedCostsIfMoved = () => {};
  provider.indexNextClaudeCostState = () => false;
  return provider;
}

test.each(['stat', 'open', 'read'])(
  'failed %s after a replacement slice retains complete published cost and age',
  async (failure) => {
    vi.useFakeTimers();
    const root = tempDir('spend-partial-failure-');
    const file = normalizeSpendFile(path.join(root, 'session.jsonl'));
    const event = (dollars: number): UsageEvent => ({
      timestamp: Date.now(),
      agent: 'Codex',
      provider: 'openai',
      model: 'gpt-6.1-sol',
      contextWindow: null,
      billingClass: 'metered',
      inferenceClass: null,
      serviceTier: null,
      reportedCost: dollars,
      reportedCostBasis: 'list',
      requestKey: null,
      usage: { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite1h: 0, cacheWrite5m: 0 },
    });
    const reducer = () => ({
      parserKind: 'codex' as const,
      pushLine: (line: string) => [JSON.parse(line) as UsageEvent],
      snapshot: () => ({}),
    });
    fs.writeFileSync(file, JSON.stringify({ ...event(10), padding: 'x'.repeat(2048) }) + '\n');
    const complete = indexSpendFile(undefined, file, 'project', reducer).record;
    const firstLine = JSON.stringify(event(1)) + '\n';
    fs.writeFileSync(file, firstLine + JSON.stringify(event(2)) + '\n');
    const provider = integrityHostHarness(
      {
        sessionLifetimeDisplayFiles,
        sessionSpendPartsBySession,
        sessionTurnStatsBySession: spendConsumers.sessionTurnStatsBySession,
        sessionCacheFactsBySession: spendConsumers.sessionCacheFactsBySession,
        dispatchedSpendPartsBySession: spendConsumers.dispatchedSpendPartsBySession,
        sessionCostUsageOf: cardConsumers.sessionCostUsageOf,
        sessionCostProjection: cardConsumers.sessionCostProjection,
        sessionTurnStats: cardConsumers.sessionTurnStats,
        sessionCacheExpiryStats: cardConsumers.sessionCacheExpiryStats,
        sessionCompactionContextDetail: cardConsumers.sessionCompactionContextDetail,
        priceDispatchedParts: cardConsumers.priceDispatchedParts,
        createCodexUsageLineReducer: reducer,
        indexSpendFile: (...args: Parameters<typeof indexSpendFile>) =>
          indexSpendFile(args[0], args[1], args[2], args[3], {
            maxBytes: Buffer.byteLength(firstLine),
            maxMilliseconds: Infinity,
          }),
      },
      [
        'lifetimeFiguresBySession',
        'lifetimeDisplayFiles',
        'projectSpendHolds',
        'dispatchedTurnCosts',
        'postRailIfSpendPendingMoved',
      ],
    );
    provider.lifetimeFigures = new SessionFiguresCache();
    provider.sessionSpendSources = [
      { sessionId: 'session-a', file, primary: true },
      { sessionId: 'parent', file, primary: true, dispatchedVia: 'tool', dispatchedFrom: 'session-a' },
    ];
    provider.sessionRows = [
      {
        id: 'session-a',
        label: 'A',
        agent: 'Codex',
        agentKey: 'codex',
        when: '',
        shown: true,
        at: 1,
        relative: '',
        agentRun: false,
      },
    ];
    provider.useRailPayload(railPayload);
    Object.assign(provider, {
      projectSpendFiles: [complete],
      projectSpendVisibleFiles: [complete],
      projectSpendIndexing: true,
      spendRecordsByFile: new Map([[complete.file, 0]]),
      projectSpendQueue: [{ file, agent: 'codex' }],
      projectSpendQueued: new Set([complete.file]),
    });
    provider.spendChecks.set(complete, 50);
    provider.spendChecks.discover([complete.file], 80);
    provider.spendChecks.account(complete.file);
    provider.spendChecks.publish();
    Array.from(provider.spendChecks.prepare([complete]));
    provider.publishProjectSpendCoverage();
    provider.postRail(false);
    const heldDispatched = provider.dispatchedTurnCosts();
    assert.ok(Object.keys(heldDispatched).length, 'the fixture has no dispatched contribution');
    provider.indexNextProjectSpendFile();
    const partial = provider.projectSpendFiles[0];
    assert.equal(partial.complete, false);
    assert.equal(partial.buckets[0].reportedCost, 1);
    partial.newestTurnStartedAt = 200;
    const method = failure === 'stat' ? 'statSync' : failure === 'open' ? 'openSync' : 'readSync';
    const spy = vi.spyOn(mutableFs, method as 'statSync').mockImplementation(() => {
      throw Object.assign(new Error('held'), { code: 'EACCES' });
    });
    syncBuiltinESMExports();
    try {
      await vi.advanceTimersByTimeAsync(500);
      assert.equal(provider.projectSpendFiles[0], partial, 'retry progress was lost');
      assert.equal(provider.projectSpendVisibleFiles[0], complete, 'partial cost replaced complete cost');
      assert.equal(provider.spendCoverageAt, 50, 'failure renewed or erased successful age');
      const published = provider.messages.filter((post: any) => post.type === 'projectSpend').at(-1).projectSpend;
      assert.equal(published.windows[0].dollars, 10);
      assert.equal(published.lastIndexedAt, 50);
      provider.postRail(true);
      assert.equal(provider.rails().at(-1).rail[0].costDollars, 10, 'the session list lost complete lifetime cost');
      const dispatched = provider.dispatchedTurnCosts();
      const held = Object.values(heldDispatched).flatMap((value: any) => Object.values(value)) as any[];
      const current = Object.values(dispatched).flatMap((value: any) => Object.values(value)) as any[];
      assert.deepEqual(
        current.map((value) => value.costs),
        held.map((value) => value.costs),
        'dispatched money changed to partial usage',
      );
      assert.ok(
        current.every((value) => value.ownSettledAt === null),
        'failed replacement exposed a settled timestamp',
      );
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test('source addition backlog retains published age until its accounting reaches publication', async () => {
  vi.useFakeTimers();
  try {
    const provider = integrityHostHarness();
    const a = { file: 'a', size: 1, mtimeMs: 1, sourceIdentity: '1:2', complete: true, buckets: [] };
    provider.projectSpendFiles = [a];
    provider.projectSpendVisibleFiles = [a];
    provider.spendChecks.discover(['a'], 100);
    provider.spendChecks.account('a');
    provider.spendChecks.set(a, 100);
    provider.spendChecks.publish();
    Array.from(provider.spendChecks.prepare([a]));
    provider.publishProjectSpendCoverage();
    provider.projectSpendSources = () => [
      { file: 'a', agent: 'codex' },
      { file: 'b', agent: 'codex' },
    ];
    vi.setSystemTime(200);
    provider.updateProjectSpendIntegrity([]);
    provider.spendChecks.set(a, 200);
    provider.publishProjectSpendCoverage();
    assert.equal(provider.spendCoverageAt, 100);
    const partial = { ...a, file: 'b', complete: false };
    provider.projectSpendFiles = [a, partial];
    provider.spendRecordsByFile = new Map([
      ['a', 0],
      ['b', 1],
    ]);
    provider.projectSpendQueue = [{ file: 'b', agent: 'codex' }];
    provider.projectSpendQueued.add('b');
    provider.projectSpendIndexing = true;
    const denied = vi.spyOn(mutableFs, 'statSync').mockImplementation(() => {
      throw Object.assign(new Error('held'), { code: 'EACCES' });
    });
    syncBuiltinESMExports();
    try {
      provider.indexNextProjectSpendFile();
    } finally {
      denied.mockRestore();
      syncBuiltinESMExports();
    }
    await vi.advanceTimersByTimeAsync(500);
    assert.equal(provider.spendCoverageAt, 100, 'failed partial accounting accepted new source membership');
    const b = { ...a, file: 'b' };
    provider.projectSpendFiles = [a, b];
    provider.spendChecks.set(b, 200);
    provider.spendChecks.account('b');
    Array.from(provider.spendChecks.prepare([a]));
    provider.spendChecks.account('a', true);
    provider.publishProjectSpendCoverage();
    assert.equal(provider.spendCoverageAt, 100, 'unchanged accounting renewed a snapshot omitting completed work');
    provider.projectSpendIndexing = true;
    provider.finishProjectSpendIndex();
    assert.equal(provider.spendCoverageAt, 100, 'completion advanced age before publication');
    await vi.advanceTimersByTimeAsync(500);
    assert.equal(provider.spendCoverageAt, 200);
    const c = { ...a, file: 'c' };
    provider.spendChecks.discover(['a', 'b', 'c'], 300);
    for (const record of [a, b, c]) provider.spendChecks.set(record, 300);
    provider.spendChecks.account('c');
    const preparing = provider.spendChecks.prepare([a, b]);
    preparing.next();
    provider.spendChecks.publish();
    Array.from(preparing);
    provider.spendChecks.account('a', true);
    provider.publishProjectSpendCoverage();
    assert.equal(provider.spendCoverageAt, 200, 'preparation adopted membership published after it started');
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test('successful empty discovery publishes age without aggregation and failed discovery retains it', () => {
  vi.useFakeTimers();
  try {
    const provider = integrityHostHarness();
    provider.invalidateProjectSpendSnapshot = () => {
      throw new Error('empty discovery aggregated');
    };
    vi.setSystemTime(100);
    provider.updateProjectSpendIntegrity([]);
    assert.equal(provider.spendCoverageAt, 100);
    vi.setSystemTime(200);
    provider.updateProjectSpendIntegrity([]);
    assert.equal(provider.spendCoverageAt, 200);
    provider.sourceEnumerations.codex.status = 'partial';
    vi.setSystemTime(300);
    provider.updateProjectSpendIntegrity([]);
    assert.equal(provider.spendCoverageAt, 200);
    assert.equal(provider.messages.filter((post: any) => post.type === 'projectSpend').length, 2);
  } finally {
    vi.useRealTimers();
  }
});

test('host integrity callbacks maintain coverage without rescanning displayed history', async () => {
  const provider = integrityHostHarness({
    fs: {
      promises: {
        stat: async () => ({
          size: 1n,
          mtimeMs: 1n,
          dev: 1n,
          ino: 2n,
          isFile: () => true,
        }),
      },
    },
  });
  const records = Array.from({ length: 1024 }, (_, index) => ({
    file: String(index),
    size: 1,
    mtimeMs: 1,
    sourceIdentity: '1:2',
    complete: true,
  }));
  provider.projectSpendFiles = records;
  provider.spendRecordsByFile = new Map(records.map((record, index) => [record.file, index]));
  provider.spendSourcesByFile = new Map(records.map((record) => [record.file, { file: record.file, agent: 'claude' }]));
  provider.spendChecks.discover(
    records.map((record) => record.file),
    100,
  );
  for (const record of records) {
    provider.spendChecks.set(record, 50);
    provider.spendChecks.account(record.file);
  }
  provider.spendChecks.publish();
  Array.from(provider.spendChecks.prepare(records));
  let reads = 0;
  provider.projectSpendVisibleFiles = new Proxy(records, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  provider.queueProjectSpendIndex = () => {};
  const get = vi.spyOn(provider.spendChecks, 'get');
  for (let offset = 0; offset < records.length; offset += 16)
    await provider.checkProjectSpendSources(
      records.slice(offset, offset + 16).map((record) => record.file),
      () => true,
    );
  assert.equal(reads, 0, 'bounded callbacks traversed unrelated display records');
  assert.ok(get.mock.calls.length <= records.length, 'coverage lookups grew faster than checked sources');
  assert.equal(provider.spendCoverageAt, 100);
});

test.each(['win32', 'darwin', 'linux'])(
  'integrity preserves exact large physical identity through %s listing admission and indexing',
  async (platform) => {
    const inode = 149181737659217462n;
    const file = normalizeSpendFile(path.join(tempDir('spend-large-inode-'), 'source.jsonl'));
    fs.writeFileSync(file, '');
    const physical = { size: 0n, mtimeMs: 20n, dev: 1n, ino: inode, isFile: () => true };
    const normalized = new Function('process', `return (${normalizeFsPath.toString()});`)({ platform });
    assert.equal(normalized('/Mixed/Source'), platform === 'win32' ? '/mixed/source' : '/Mixed/Source');
    let indexingError: unknown;
    const provider = integrityHostHarness({
      indexSpendFile: (...args: Parameters<typeof indexSpendFile>) => {
        try {
          return indexSpendFile(...args);
        } catch (error) {
          indexingError = error;
          throw error;
        }
      },
      fs: {
        statSync: (_file: string, options: unknown) => {
          assert.deepEqual(options, { bigint: true });
          return physical;
        },
        promises: {
          stat: async (_file: string, options: any) =>
            options?.bigint ? physical : { ...physical, size: 0, mtimeMs: 20, dev: 1, ino: Number(inode) },
        },
      },
    });
    provider.spendSourcesByFile.set(file, { file, agent: 'codex' });
    provider.codexStats = new CodexStatCache(
      () => {
        throw new Error('held listing stat was not accepted');
      },
      () => 1_000_000,
    );
    provider.queueProjectSpendIndex = () => {};
    await provider.checkProjectSpendSources([file], () => true);
    const held = provider.codexStats.get(file)!;
    assert.equal(held.ino, '149181737659217462');
    assert.deepEqual(
      await replacedCatalogFiles([{ file, ...held } as SessionFile], new AbortController().signal, async () =>
        fileRevisionOf(physical as unknown as fs.BigIntStats),
      ),
      [],
    );
    const original = mutableFs.statSync;
    const spy = vi.spyOn(mutableFs, 'statSync').mockImplementation(((target: fs.PathLike, options: unknown) => {
      if (String(target) === file) {
        assert.deepEqual(options, { bigint: true });
        return physical;
      }
      return original(target, options as any);
    }) as typeof fs.statSync);
    syncBuiltinESMExports();
    try {
      const indexed = indexSpendFile(undefined, file, 'project', createCodexUsageLineReducer);
      assert.equal(indexed.record.sourceIdentity, '1:149181737659217462');
      provider.projectSpendFiles = [indexed.record];
      provider.spendRecordsByFile.set(file, 0);
      provider.projectSpendQueue = [{ file, agent: 'codex' }];
      provider.projectSpendQueued.add(file);
      provider.scheduleNextProjectSpendFile = () => {};
      provider.indexNextProjectSpendFile();
      assert.ifError(indexingError);
      assert.equal(
        provider.projectSpendQueue.length,
        0,
        'exact post-read identity falsely requeued an unchanged source',
      );
      assert.equal(typeof provider.spendChecks.get(provider.projectSpendFiles[0]), 'number');
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
  },
);

test('accounting-only pruning and normalized hydration retain revision-qualified successful coverage', () => {
  const at = Date.now();
  const record = {
    file: 'source',
    size: 10,
    mtimeMs: 20,
    sourceIdentity: '1:2',
    complete: true,
    buckets: [{ localDate: '2000-01-01' }, { localDate: projectSpendWindows(at)[0].start }],
  } as SpendFileIndex;
  const coverage = new SpendCoverage();
  coverage.discover(['source'], 100);
  coverage.account('source');
  coverage.publish();
  coverage.set(record, 50);
  Array.from(coverage.prepare([record]));
  const pruned = pruneSpendFilesWithResult([record], at).files[0];
  assert.notEqual(pruned, record);
  Array.from(coverage.prepare([pruned]));
  assert.equal(coverage.oldest(null), 50);
  const normalized = { ...pruned, pendingBytes: undefined, trailing: '' };
  Array.from(coverage.prepare([normalized]));
  assert.equal(coverage.oldest(null), 50);
  Array.from(coverage.prepare([{ ...normalized, sourceIdentity: '1:3' }]));
  assert.equal(coverage.oldest(null), null, 'replacement inherited old physical evidence');
  for (let cycle = 0; cycle < 32; cycle++) {
    const removed = { ...record, file: `removed-${cycle}` };
    coverage.discover([removed.file], 200 + cycle);
    coverage.account(removed.file);
    coverage.set(removed, 200 + cycle);
    coverage.publish();
    Array.from(coverage.prepare([removed]));
    coverage.discover([], 300 + cycle);
    coverage.publish();
    const empty = coverage.prepare([]);
    while (!empty.next().done) {
      assert.equal(coverage.get(removed), 200 + cycle, 'cleanup lost evidence supporting the displayed snapshot');
    }
    assert.equal(coverage.oldest(null), 300 + cycle);
    assert.equal((coverage as any).latest.size, 0, 'removed source identities accumulated');
    assert.equal((coverage as any).checks.size, 0, 'removed source evidence accumulated');
  }
});

test('warm demotion racing a late append recovers through host checking and reopening', async () => {
  vi.useFakeTimers();
  try {
    const file = normalizeSpendFile(path.join(tempDir('spend-demotion-'), 'source.jsonl'));
    fs.writeFileSync(file, '');
    const indexed = indexSpendFile(undefined, file, 'project', createCodexUsageLineReducer).record;
    const old = Date.now() - 8 * 86_400_000;
    fs.utimesSync(file, old / 1000, old / 1000);
    indexed.mtimeMs = readRolloutStat(file)!.mtimeMs;
    const provider = integrityHostHarness();
    provider.projectSpendFiles = [indexed];
    provider.projectSpendVisibleFiles = [indexed];
    provider.projectSpendSources = () => [{ file, agent: 'codex' }];
    provider.sessionSpendSources = [{ file, sessionId: 'session-a' }];
    provider.showing = 'session-a';
    provider.updateProjectSpendIntegrity([{ file, sessionId: 'session-a', agent: 'codex' }]);
    provider.startPolling();
    await vi.advanceTimersByTimeAsync(10);
    provider.showing = null;
    provider.updateProjectSpendIntegrity([{ file, sessionId: 'session-a', agent: 'codex' }]);
    fs.appendFileSync(file, '{}\n');
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 500);
    await vi.waitFor(() =>
      assert.equal(provider.projectSpendVisibleFiles[0].size, 3, 'cold rotation lost the late append'),
    );
    provider.stopPolling();
    fs.appendFileSync(file, '{}\n');
    provider.show('session-a');
    await vi.advanceTimersByTimeAsync(10);
    assert.equal(provider.projectSpendFiles[0].size, 3, 'hidden promotion ran before reopening');
    provider.startPolling();
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => assert.equal(provider.projectSpendVisibleFiles[0].size, 6, 'reopening lost promoted work'));
    provider.stopPolling();
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test('unwatched transcript appends beyond the cap recover in one warm or cold pass', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
  let openWatches = 0;
  let maximumWatches = 0;
  const nativeWatch = vi.spyOn(mutableFs, 'watch').mockImplementation((() => {
    maximumWatches = Math.max(maximumWatches, ++openWatches);
    return {
      on() {
        return this;
      },
      close: vi.fn<() => void>(() => {
        openWatches--;
      }),
    };
  }) as any);
  syncBuiltinESMExports();
  const ownedFiles = new Set<string>();
  const unmappedFiles: string[] = [];
  const stat = (file: string, options: { bigint: true }) => {
    if (!ownedFiles.has(normalizeFsPath(file))) {
      unmappedFiles.push(file);
      throw new Error(`Integrity stat escaped the fixture: ${file}`);
    }
    return fs.statSync(file, options);
  };
  const provider = integrityHostHarness({
    fs: {
      watch: mutableFs.watch,
      statSync: stat,
      promises: { stat: async (file: string, options: { bigint: true }) => stat(file, options) },
    },
  });
  try {
    const root = tempDir('spend-watch-cap-');
    const files = Array.from({ length: 258 }, (_, index) => {
      const folder = path.join(root, String(index).padStart(4, '0'));
      fs.mkdirSync(folder);
      const file = normalizeSpendFile(path.join(folder, 'session.jsonl'));
      fs.writeFileSync(file, '{}\n');
      fs.utimesSync(file, Date.now() / 1000, Date.now() / 1000);
      ownedFiles.add(normalizeFsPath(file));
      return file;
    });
    const records = files.map((file) => indexSpendFile(undefined, file, 'project', createCodexUsageLineReducer).record);
    const cold = files[257];
    const old = Date.now() - 8 * 86_400_000;
    fs.utimesSync(cold, old / 1000, old / 1000);
    records[257].mtimeMs = readRolloutStat(cold)!.mtimeMs;
    const sessions = files.map((file, index) => ({
      file,
      sessionId: `session-${index}`,
      agent: 'codex',
      ...readRolloutStat(file)!,
    }));
    provider.projectSpendFiles = records;
    provider.projectSpendVisibleFiles = records;
    provider.projectSpendSources = () => files.map((file) => ({ file, agent: 'codex' }));
    provider.sessionSpendSources = sessions;
    provider.partial = sessions;
    provider.catalog = { sessions };
    provider.refresh = paintHarness([], { productionWatchDirs: watchDirs }).refresh;
    provider.discovery = Promise.resolve(true);
    provider.startPolling();
    await provider.refresh(true);
    await vi.advanceTimersByTimeAsync(500);
    assert.equal(provider.watchers.size, 256);
    const warm = files[256];
    assert.equal(provider.watchers.has(path.dirname(warm)), false);
    assert.equal(provider.watchers.has(path.dirname(cold)), false);
    fs.appendFileSync(warm, '{}\n');
    fs.appendFileSync(cold, '{}\n');
    fs.utimesSync(warm, Date.now() / 1000, Date.now() / 1000);
    fs.utimesSync(cold, Date.now() / 1000, Date.now() / 1000);
    provider.refreshFrom = () => {};
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() =>
      assert.equal(provider.projectSpendVisibleFiles.find((record: SpendFileIndex) => record.file === warm).size, 6),
    );
    assert.equal(provider.projectSpendVisibleFiles.find((record: SpendFileIndex) => record.file === cold).size, 3);
    await vi.advanceTimersByTimeAsync(15 * 60_000 - 30_000);
    await vi.waitFor(() =>
      assert.equal(provider.projectSpendVisibleFiles.find((record: SpendFileIndex) => record.file === cold).size, 6),
    );
    for (const record of provider.projectSpendFiles) {
      fs.utimesSync(record.file, old / 1000, old / 1000);
      record.mtimeMs = readRolloutStat(record.file)!.mtimeMs;
    }
    provider.spendIntegrity.promote([cold]);
    await provider.refresh(true);
    assert.equal(provider.watchers.size, 256);
    assert.equal(provider.watchers.has(path.dirname(cold)), true, 'promotion did not receive watch priority');
    assert.equal(provider.watchers.has(path.dirname(files[255])), false, 'promotion kept the displaced watcher');
    provider.stopPolling();
    assert.equal(provider.watchers.size, 0);
    assert.equal(openWatches, 0);
    assert.equal(maximumWatches, 256, 'replacement opened watchers before releasing their allocation');
    assert.ok(nativeWatch.mock.results.every((result) => result.value.close.mock.calls.length === 1));
    assert.deepEqual(unmappedFiles, [], 'Integrity stat escaped the fixture.');
  } finally {
    provider.stopPolling();
    nativeWatch.mockRestore();
    syncBuiltinESMExports();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test('mixed warm and cold Codex folder retains its watcher and recovers missed child-directory discovery', async () => {
  vi.useFakeTimers();
  const nativeWatch = vi.spyOn(mutableFs, 'watch').mockImplementation((() => ({
    on() {
      return this;
    },
    close() {},
  })) as any);
  syncBuiltinESMExports();
  try {
    const root = tempDir('spend-mixed-folder-');
    const folder = path.join(root, '2026', '10', '01');
    fs.mkdirSync(folder, { recursive: true });
    const warm = normalizeSpendFile(path.join(folder, 'rollout-warm.jsonl'));
    const cold = normalizeSpendFile(path.join(folder, 'rollout-cold.jsonl'));
    for (const file of [warm, cold]) fs.writeFileSync(file, '{}\n');
    const records = [warm, cold].map(
      (file) => indexSpendFile(undefined, file, 'project', createCodexUsageLineReducer).record,
    );
    const old = Date.now() - 8 * 86_400_000;
    fs.utimesSync(cold, old / 1000, old / 1000);
    records[1].mtimeMs = readRolloutStat(cold)!.mtimeMs;
    const provider = integrityHostHarness();
    provider.projectSpendFiles = records;
    provider.projectSpendVisibleFiles = records;
    let files = [warm, cold];
    provider.projectSpendSources = () => files.map((file) => ({ file, agent: 'codex' }));
    provider.showing = 'warm';
    const sessions = () => files.map((file) => ({ file, sessionId: file === warm ? 'warm' : 'cold', agent: 'codex' }));
    provider.updateProjectSpendIntegrity(sessions());
    provider.watchDirectories([folder]);
    provider.startPolling();
    await vi.advanceTimersByTimeAsync(20);
    assert.ok(provider.watchers.has(folder), 'cold membership removed a mixed-folder watcher');
    const nested = path.join(folder, 'shard');
    fs.mkdirSync(nested);
    const discovered = normalizeSpendFile(path.join(nested, 'rollout-new.jsonl'));
    fs.writeFileSync(discovered, '{}\n');
    fs.appendFileSync(cold, '{}\n');
    let discoveries = 0;
    provider.refreshFrom = async (reason: string) => {
      if (reason !== 'project-spend-discovery') return;
      discoveries++;
      const enumeration = await enumerateRolloutFilesAsync(root);
      files = [...enumeration!.files];
      provider.updateProjectSpendIntegrity(sessions());
      provider.scheduleProjectSpendIndex(new Map(files.map((file) => [file, readRolloutStat(file)!])), null);
    };
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 500);
    await vi.waitFor(() => assert.equal(discoveries, 1));
    await vi.advanceTimersByTimeAsync(500);
    assert.ok(provider.projectSpendVisibleFiles.some((record: SpendFileIndex) => record.file === discovered));
    assert.equal(provider.projectSpendVisibleFiles.find((record: SpendFileIndex) => record.file === cold).size, 6);
    assert.ok(provider.watchers.has(folder));
    provider.stopPolling();
  } finally {
    nativeWatch.mockRestore();
    syncBuiltinESMExports();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test('successful integrity coverage includes unchanged dependencies and survives failures without aggregation', async () => {
  const record = { file: 'source', size: 10, mtimeMs: 20, sourceIdentity: '1:2', complete: true };
  const dependency = { ...record, file: 'dependency' };
  let error: string | null = null;
  let release: (() => void) | undefined;
  const provider = completeDiscoveryHarness(
    undefined,
    false,
    ['checkProjectSpendSources', 'publishProjectSpendCoverage'],
    {
      normalizeSpendFile: (file: string) => file,
      fs: {
        promises: {
          stat: async () => {
            if (release !== undefined)
              await new Promise<void>((resolve) => {
                release = resolve;
              });
            if (error) throw Object.assign(new Error(error), { code: error });
            return { size: 10, mtimeMs: 20, dev: 1, ino: 2, isFile: () => true };
          },
        },
      },
    },
  );
  provider.spendChecks = new SpendCoverage();
  provider.spendChecks.set(dependency, 50);
  provider.spendChecks.discover(['source', 'dependency'], 80);
  provider.spendChecks.account('source');
  provider.spendChecks.account('dependency');
  provider.spendChecks.publish();
  for (const _step of provider.spendChecks.prepare([record, dependency] as SpendFileIndex[])) {
  }
  provider.spendSourcesByFile = new Map([['source', { file: 'source', agent: 'claude' }]]);
  provider.spendRecordsByFile = new Map([['source', 0]]);
  provider.projectSpendFiles = [record];
  provider.projectSpendVisibleFiles = [record, dependency];
  provider.spendCoverageAt = null;
  const offers: unknown[] = [];
  provider.queueProjectSpendIndex = (...args: unknown[]) => offers.push(args);
  provider.invalidateProjectSpendSnapshot = () => {
    throw new Error('unchanged checks aggregated');
  };
  await provider.checkProjectSpendSources(['source'], () => true);
  assert.equal(provider.spendCoverageAt, 50);
  const checked = provider.spendChecks.get(record);
  error = 'EACCES';
  await provider.checkProjectSpendSources(['source'], () => true);
  assert.equal(provider.spendChecks.get(record), checked);
  assert.equal(provider.spendCoverageAt, 50);
  assert.equal((offers.at(-1) as any[])[2].length, 0, 'an unreadable source reached indexing');
  error = 'ENOENT';
  await provider.checkProjectSpendSources(['source'], () => true);
  assert.equal((offers.at(-1) as any[])[0].get('source'), null);
  assert.equal(provider.spendChecks.get(record), checked);
  error = null;
  let valid = true;
  release = () => {};
  const waiting = provider.checkProjectSpendSources(['source'], () => valid);
  valid = false;
  release();
  const count = offers.length;
  await waiting;
  assert.equal(offers.length, count, 'a disposed queue admitted a completed stat');
  for (const _step of provider.spendChecks.prepare([dependency] as SpendFileIndex[])) {
  }
  provider.projectSpendVisibleFiles = [{ ...record }];
  provider.publishProjectSpendCoverage();
  assert.equal(provider.spendCoverageAt, 50, 'a waiting rebuild renewed the coverage of the displayed snapshot');
  for (const _step of provider.spendChecks.prepare([])) {
  }
  provider.projectSpendVisibleFiles = [];
  provider.publishProjectSpendCoverage();
  assert.equal(provider.spendCoverageAt, 80, 'an empty ledger must use successful discovery coverage');
});

// Replaces the harness's inert ledger save with the production save methods and scheduler.
function useLedgerSave(provider: any): void {
  delete provider.flushProjectSpendSave;
  delete provider.scheduleProjectSpendSave;
  provider.projectSpendSaveOwed = false;
  provider.projectSpendRailOwed = false;
  provider.performanceCounters.recordLedgerSave = () => {};
  provider.projectSpendSaveScheduler = provider.newProjectSpendSaveScheduler();
}

test('disposal saves drafts and the derived cache when the ledger save fails', () => {
  vi.useFakeTimers();
  try {
    const provider = spendOfferHarness({
      saveSpendLedger: () => {
        throw heldLedgerFile();
      },
    });
    useLedgerSave(provider);
    const saved: string[] = [];
    provider.draftSave = setTimeout(() => {}, 1_000);
    provider.writeDrafts = () => {
      saved.push('drafts');
      return Promise.resolve();
    };
    provider.derivedCacheCheckpointState = { dirty: true, markSaved() {} };
    provider.writeDerivedCache = () => {
      saved.push('derived cache');
      return true;
    };
    provider.projectSpendFiles = [{ file: 'a.jsonl', complete: true, size: 1, mtimeMs: 1 }];
    provider.scheduleProjectSpendSave();
    provider.dispose();
    assert.deepEqual(saved, ['drafts', 'derived cache'], 'a failed ledger save at disposal skipped the saves after it');
    assert.equal(vi.getTimerCount(), 0, 'a failed ledger save at disposal left a retry on the disposed provider');
  } finally {
    vi.useRealTimers();
  }
});

test("a ledger save that fails at a workspace change never writes into the new workspace's ledger", () => {
  vi.useFakeTimers();
  try {
    let held = true;
    const written: string[] = [];
    const provider = spendOfferHarness({
      saveSpendLedger: (_storage: string, workspace: string) => {
        if (held) {
          throw heldLedgerFile();
        }
        written.push(workspace);
      },
    });
    useLedgerSave(provider);
    provider.projectSpendFiles = [{ file: 'a.jsonl', complete: true, size: 1, mtimeMs: 1 }];
    provider.projectSpendVisibleFiles = provider.projectSpendFiles;
    provider.scheduleProjectSpendSave();
    provider.useFolders(['other']);
    provider.ensureProjectSpendWorkspace();
    assert.equal(provider.projectSpendWorkspace, 'other');

    // The lock clears, and every retry, flush and disposal that follows gets its turn.
    held = false;
    vi.advanceTimersByTime(60 * 60 * 1_000);
    provider.flushProjectSpendSave();
    provider.dispose();
    assert.deepEqual(
      written,
      [],
      "the replaced workspace's save wrote its cleared lists into the new workspace's ledger",
    );
  } finally {
    vi.useRealTimers();
  }
});

test('a spend offer indexes the sources of the workspace that scheduled it', async () => {
  const provider = spendOfferHarness();
  const offered: string[][] = [];
  provider.queueProjectSpendIndex = (_revisions: unknown, _only: unknown, sources: { file: string }[]) => {
    offered.push(sources.map((source) => source.file));
  };
  provider.claudeSpendSources = [{ file: 'listed.jsonl', primary: true }];
  markedOffer(provider, 'listed');
  // Another workspace listing replaces the source lists while the scheduled offer waits.

  provider.claudeSpendSources = [{ file: 'elsewhere.jsonl', primary: true }];

  await vi.waitFor(() => assert.equal(offered.length, 1));
  assert.deepEqual(
    offered[0],
    ['listed.jsonl'],
    "the offer wrote another workspace's sources into the ledger of the one that listed it",
  );
});

test('a spend offer whose workspace moved under it queues nothing', async () => {
  const provider = spendOfferHarness();
  const ran: string[] = [];
  provider.queueProjectSpendIndex = (revisions: Map<string, string>) => {
    ran.push(String(revisions.get('mark')));
  };
  markedOffer(provider, 'stale');
  provider.projectSpendWorkspace = 'elsewhere';
  markedOffer(provider, 'current');

  await vi.waitFor(() => assert.ok(ran.includes('current')));
  assert.deepEqual(
    ran,
    ['current'],
    'an offer scheduled under one workspace queued its sources into the ledger of another',
  );
});

// The later offer runs after the cancelled offer's scheduled tick, establishing that cancellation prevented execution.

for (const ending of ['a changed workspace', 'a disposed provider']) {
  test(`${ending} drops a spend offer that is still waiting`, async () => {
    const provider = spendOfferHarness();
    const ran: string[] = [];
    provider.queueProjectSpendIndex = (revisions: Map<string, string>) => {
      ran.push(String(revisions.get('mark')));
    };
    markedOffer(provider, 'dropped');
    assert.equal(provider.projectSpendOffers.size, 1, 'nothing was scheduled to drop');

    if (ending === 'a changed workspace') {
      provider.useFolders(['elsewhere']);
      provider.ensureProjectSpendWorkspace();
    } else {
      provider.dispose();
    }
    assert.equal(provider.projectSpendOffers.size, 0, `${ending} left the offer on its timer`);

    provider.projectSpendWorkspace = 'elsewhere';
    markedOffer(provider, 'later');
    await vi.waitFor(() => assert.ok(ran.includes('later')));
    assert.deepEqual(ran, ['later'], `${ending} left an offer that went on to stat and queue files`);
  });
}

test('a hidden panel retains targeted integrity work until reopening', async () => {
  vi.useFakeTimers();
  try {
    const provider = spendOfferHarness();
    const ran: string[] = [];
    provider.spendIntegrity = new IntegrityScheduler(
      async (files) => {
        ran.push(...files);
      },
      () => {},
    );
    provider.queueProjectSpendIndex = () => {
      throw new Error('hidden integrity work reached indexing');
    };
    markedOffer(provider, 'offered');
    provider.hosts = [{ webview: {}, visible: () => false }];
    provider.readyHosts = new Set();
    await vi.advanceTimersByTimeAsync(1);
    assert.deepEqual(ran, []);
    provider.spendIntegrity.start();
    await vi.advanceTimersByTimeAsync(1);
    assert.deepEqual(ran, ['mark']);
    provider.spendIntegrity.pause();
  } finally {
    vi.useRealTimers();
  }
});

test('a restart with an unfinished ledger keeps its settled figures until the offer has run', async () => {
  const provider = spendOfferHarness();
  const resumable = [{ file: 'one.jsonl' }, { file: 'half-read.jsonl' }];
  const complete = [{ file: 'one.jsonl' }];
  provider.projectSpendFiles = resumable;
  provider.projectSpendVisibleFiles = complete;
  let queued = false;
  provider.queueProjectSpendIndex = () => {
    queued = true;
  };

  // A restored tab reads busy state before the scheduled offer runs.
  markedOffer(provider, 'restart');
  assert.equal(
    provider.projectSpendBusy(),
    true,
    'a waiting offer reports a settled ledger, so Project cost draws partial totals it then takes back',
  );
  assert.deepEqual(
    provider.displayedProjectSpendFiles(),
    complete,
    'Project cost drew the half-read totals a restart resumed from, with no word that it is working',
  );

  await vi.waitFor(() => assert.equal(queued, true));
  assert.equal(provider.projectSpendBusy(), false, 'the offer never let go of the ledger');
  assert.deepEqual(provider.displayedProjectSpendFiles(), resumable);
});

test('a cold start completes its session render before it restores Project cost', async () => {
  vi.useFakeTimers();
  try {
    const order: string[] = [];
    const provider = paintHarness(['hydrateProjectSpend'], {
      loadSpendLedger: () => {
        order.push('ledger restored');
        return { files: [], completeFiles: [] };
      },
      pruneSpendFilesWithResult: (files: object[]) => ({ files, pruned: false }),
    });
    provider.projectSpendHydrated = false;
    provider.projectSpendHydrationReady = false;
    provider.projectSpendWorkspace = 'project';
    provider.projectSpendStorageDir = 'storage';
    provider.projectSpendRevision = 0;
    provider.projectSpendFiles = [];
    provider.projectSpendVisibleFiles = [];
    provider.disposed = false;
    provider.scheduleProjectSpendSave = () => {};
    provider.scheduleProjectSpendMidnight = () => {};
    provider.scheduleProjectSpendIndex = () => {};
    provider.postProjectSpend = () => {};
    provider.postRail = () => {};
    provider.metaFor = () => ({
      ...provider.partial[0],
      foldedLabel: '',
      stats: null,
      starts: 0,
      expandedStatsRead: true,
    });
    provider.progressiveCurrent = () => true;
    recordPosts(provider, order);

    await provider.refresh(true);
    assert.equal(provider.messages.at(-1).startup.complete, true);
    assert.deepEqual(order, ['render posted'], 'the cold ledger restored before the first session render');

    await vi.runAllTimersAsync();
    assert.deepEqual(order, ['render posted', 'ledger restored']);
    assert.equal(provider.projectSpendHydrated, true);
  } finally {
    vi.useRealTimers();
  }
});

test.each([false, true])(
  'session-list loading waits for a complete discovery reply whatever the metadata, then completes an unchanged refresh: failure=%s',
  async (failed) => {
    vi.useFakeTimers();
    try {
      const provider = paintHarness();
      provider.progressiveCurrent = () => true;
      const session = provider.partial[0];
      const entry = {
        ...session,
        label: 'Session',
        fullLabel: 'Session',
        foldedLabel: 'session',
        stats: null,
        outcome: null,
        starts: { starts: [], whole: true },
        expandedStatsRead: true,
      };
      provider.titles.set(session.file, entry);
      provider.metaFor = () => provider.titles.get(session.file);
      provider.dispatchDiscoveryPending = true;
      await provider.refresh(true);
      assert.equal(provider.messages.at(-1).startup.complete, false, 'discovery continuation reported completion');
      provider.useRefreshGate(() => false);
      // A pending pass keeps the list loading whatever the state of the session's metadata.
      provider.titles.set(session.file, {
        ...entry,
        expandedStatsRead: false,
        metadataWindow: { whole: false, windowBytes: 1 },
      });
      await provider.refresh(false, true);
      assert.equal(
        provider.posts.at(-1).complete,
        false,
        'a pending pass reported completion during metadata recovery',
      );
      provider.titles.set(session.file, { ...entry, foldedLabel: undefined });
      await provider.refresh(false, true);
      assert.equal(provider.posts.at(-1).complete, false, 'a pending pass reported completion without a name');
      // A complete reply completes the list even while the session's metadata is outdated.
      provider.titles.set(session.file, { ...entry, mtimeMs: session.mtimeMs - 1 });
      provider.dispatchDiscoveryPending = false;
      const renders = provider.messages.length;
      await provider.refresh(false);
      assert.equal(provider.messages.length, renders, 'terminal status retransmitted the unchanged catalog');
      assert.equal(provider.posts.at(-1).complete, true, 'a complete reply never published completion');
      provider.titles.set(session.file, entry);
      const discoveryHost = bumpedCatalogHarness().provider;
      provider.prepareClaudeChildren = discoveryHost.prepareClaudeChildren;
      provider.startedSources = discoveryHost.startedSources;
      Object.assign(provider, {
        claudeParents: [session],
        claudeChildren: [],
        claudeChildReferences: [],
        claudeChildReferenceEntries: new Map(),
        claudeChildStatWrites: new Map(),
        hasHumanPrompt: () => true,
        updateSessionSpendSources() {},
        pruneDerivedTitles: () => false,
      });
      {
        const checkpoint = {
          compatibility: discoveryCompatibility(CLAUDE_CHILD_REFERENCE_PARSER_VERSION),
          epoch: randomUUID(),
          parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
          parents: [session],
          catalog: [session],
          repositoryRoots: ['project'],
          completed: [session.file],
          sequence: 1,
          position: 1,
        };
        provider.dispatchDiscoveryPending = true;
        provider.startupProgressAt = Date.now() - 250;
        provider.progressiveWorker.run = async (_request: unknown, generation: number) => ({
          generation,
          value: {
            kind: 'claude-children',
            checkpoint,
            complete: true,
            continuation: false,
            references: [],
            dispatchFacts: [],
            children: [],
            referenceEntries: [],
            roots: [session],
          },
        });
        provider.prepareRailEnrichment = async (_sessions: unknown, generation: number, signal: AbortSignal) => {
          if (failed) provider.failSessionLoading(generation, signal);
          return { changed: false, catalogCurrent: true };
        };
        await provider.refresh(false, true);
        assert.equal(provider.discoveryCheckpoint, undefined, 'final acknowledgment retained the checkpoint');
        assert.equal(provider.messages.length, renders, 'checkpoint completion retransmitted the unchanged catalog');
        const messages = provider.posts.filter(
          (message: { generation: number }) => message.generation === provider.refreshGeneration,
        );
        // The list completed before this generation, so a later work failure keeps its state but holds the line hidden.
        assert.equal(messages.at(-1).complete, !failed);
        assert.equal(messages.at(-1).failed, failed ? true : undefined);
        assert.equal(
          messages.at(-1).held,
          failed ? true : undefined,
          'a work failure after completion showed the loading line',
        );
        assert.equal(
          new Set(messages.map((message: { epoch: string }) => message.epoch)).size,
          1,
          'checkpoint removal changed the terminal lifecycle epoch',
        );
        assert.notEqual(messages.at(-1).epoch, checkpoint.epoch);
      }
      assert.equal(provider.projectSpendHydrated, true);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

// Two Codex sources and one healthy Claude source behind relationship discovery that reports a full source count on each poll.
function exhaustedLoadingHarness(extraMethods: string[] = [], scope: Record<string, unknown> = {}): any {
  const provider = paintHarness(['workspaceFoldersChanged', 'repositoryScopeChanged', ...extraMethods], scope);
  provider.progressiveCurrent = () => true;
  const healthy = provider.partial[0];
  const codex = (name: string, activity: number) => ({
    file: `${name}.jsonl`,
    sessionId: name,
    agent: 'codex',
    activity,
    size: 1,
    mtimeMs: 1,
  });
  const first = codex('codex-a', 90);
  const second = codex('codex-b', 80);
  const settled = (session: { size: number; mtimeMs: number }) => ({
    ...session,
    label: 'Session',
    fullLabel: 'Session',
    foldedLabel: 'session',
    stats: null,
    outcome: null,
    starts: { starts: [], whole: true },
    expandedStatsRead: true,
  });
  const recovering = (session: { size: number; mtimeMs: number }) => ({
    ...settled(session),
    expandedStatsRead: false,
    metadataWindow: { whole: false, windowBytes: 1 },
  });
  const exhausted = (session: { size: number; mtimeMs: number }) => ({
    ...recovering(session),
    metadataWindow: { whole: false, windowBytes: 1, exhausted: true, exhaustedRule: METADATA_EXHAUSTED_RULE },
  });
  const catalog = (sessions: unknown[]) => {
    provider.partial = sessions;
    provider.catalog = { sessions };
  };
  catalog([healthy, first, second]);
  provider.titles.set(healthy.file, settled(healthy));
  provider.titles.set(first.file, exhausted(first));
  provider.titles.set(second.file, exhausted(second));
  provider.metaFor = (session: { file: string }) => provider.titles.get(session.file);
  const discoveryHost = bumpedCatalogHarness().provider;
  provider.prepareClaudeChildren = discoveryHost.prepareClaudeChildren;
  provider.startedSources = discoveryHost.startedSources;
  Object.assign(provider, {
    claudeParents: [healthy],
    claudeChildren: [],
    claudeChildReferences: [],
    claudeChildReferenceEntries: new Map(),
    claudeChildStatWrites: new Map(),
    hasHumanPrompt: () => true,
    updateSessionSpendSources() {},
    pruneDerivedTitles: () => false,
    repositoryScope: { snapshot() {} },
    allowThemeFiles() {},
    prepareRailEnrichment: async () => ({ changed: false, catalogCurrent: true }),
  });
  const discovery: {
    pending: boolean;
    fail: boolean;
    // A complete reply asks for another pass.
    continuation?: boolean;
    // Further parents the discovery checkpoint reports, each one a known source beyond the healthy Claude source.
    more: { file: string }[];
    before?: (generation: number, signal: AbortSignal) => void;
    // The repository scope roots the checkpoint was counted under.
    roots?: () => string[];
  } = {
    pending: false,
    fail: false,
    more: [],
  };
  provider.progressiveWorker.run = async (_request: unknown, generation: number, signal: AbortSignal) => {
    discovery.before?.(generation, signal);
    if (discovery.fail) return null;
    const checkpoint = {
      compatibility: discoveryCompatibility(CLAUDE_CHILD_REFERENCE_PARSER_VERSION),
      parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
      epoch: randomUUID(),
      parents: [healthy, ...discovery.more],
      catalog: [healthy, ...discovery.more],
      repositoryRoots: discovery.roots?.() ?? ['project'],
      completed: [healthy.file],
      sequence: 1,
      position: 1,
    };
    return {
      generation,
      value: discovery.pending
        ? { kind: 'claude-children-progress', checkpoint, referenceEntries: [], continuation: true }
        : {
            kind: 'claude-children',
            checkpoint,
            complete: true,
            continuation: discovery.continuation === true,
            references: [],
            dispatchFacts: [],
            children: [],
            referenceEntries: [],
            roots: provider.partial,
          },
    };
  };
  // Each poll runs relationship discovery again and reports its full source count.
  const poll = async (known = 1) => {
    provider.dispatchDiscoveryPending = true;
    provider.startupProgressAt = Date.now() - 250;
    await provider.refresh(false, true);
    const posts = provider.posts.filter(
      (message: { generation: number }) => message.generation === provider.refreshGeneration,
    );
    const progress = posts.find((message: { known: number }) => message.known === known);
    // Once the list completes, the line holds completion and the poll posts no source count.
    if (!provider.loadingLine.held(JSON.stringify(provider.repositoryScopeRoots)))
      assert.ok(progress, 'the poll posted no source count');
    return { progress: progress?.failed, last: posts.at(-1) };
  };
  // Keeps the list loading: the published catalog came from an incomplete pass, and each further pass stays incomplete.
  const pendingPass = () => {
    discovery.pending = true;
    provider.authoritativeCatalog ??= provider.partial;
    provider.completeCatalogScope = undefined;
  };
  // Lets the next pass return a complete reply, which completes the list.
  const completePass = () => {
    discovery.pending = false;
  };
  return {
    provider,
    healthy,
    first,
    second,
    codex,
    settled,
    recovering,
    exhausted,
    catalog,
    discovery,
    poll,
    pendingPass,
    completePass,
  };
}

test('exhausted metadata sources settle the session list without a failure', async () => {
  vi.useFakeTimers();
  try {
    const { pendingPass, completePass, provider, poll } = exhaustedLoadingHarness();
    await provider.refresh(true);
    const stamp = provider.messages.at(-1).startup;
    assert.equal(stamp.complete, true, 'exhausted sources kept the session list pending');
    assert.equal(stamp.failed, undefined, 'exhausted sources marked the render failed');
    provider.useRefreshGate(() => false);

    for (const label of ['first poll', 'second poll']) {
      const { progress, last } = await poll();
      assert.equal(progress, undefined, `${label} reported exhausted sources as a failure`);
      assert.equal(last.complete, true, `${label} left the session list pending`);
    }
    pendingPass();
    let status = await poll();
    assert.equal(status.last.complete, false, 'a catalog from an incomplete pass reported completion');
    assert.equal(status.last.held, true, 'a pending pass after completion showed the loading line');
    assert.equal(status.last.failed, undefined);
    completePass();
    status = await poll();
    assert.equal(status.last.complete, true, 'a complete pass left the session list pending');
    assert.equal(
      provider.posts.some((message: { failed?: boolean }) => message.failed),
      false,
      'an exhausted source posted a failure',
    );

    const posted = provider.posts.length;
    provider.startupProgressAt = 0;
    const aborted = new AbortController();
    aborted.abort();
    await provider.prepareClaudeChildren(provider.refreshGeneration, aborted.signal);
    await provider.prepareClaudeChildren(provider.refreshGeneration - 1, new AbortController().signal);
    provider.failSessionLoading(provider.refreshGeneration, aborted.signal);
    assert.equal(provider.posts.length, posted, 'cancelled or obsolete work published a status');
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

// Every status the host sent for one generation: relationship and loading posts, then the render stamp.
function loadingStatuses(
  provider: any,
  generation: number,
): { complete?: boolean; failed?: boolean; completed?: number; known?: number }[] {
  return [
    ...provider.posts.filter(
      (message: { type: string; generation: number }) =>
        message.type === 'startupProgress' && message.generation === generation,
    ),
    ...provider.messages
      .filter((message: { startup?: { generation: number } }) => message.startup?.generation === generation)
      .map((message: { startup: object }) => message.startup),
  ];
}

test('pending loading statuses keep the last relationship source count until completion or a scope change', async () => {
  vi.useFakeTimers();
  try {
    const {
      pendingPass,
      completePass,
      provider,
      healthy,
      first,
      second,

      catalog,
      discovery,
      poll,
    } = exhaustedLoadingHarness();
    pendingPass();
    await provider.refresh(true);
    provider.useRefreshGate(() => false);
    const pending = (generation: number) =>
      loadingStatuses(provider, generation).filter((status) => !status.complete && !status.failed);

    // Each poll is a new generation. The count-free render and loading posts must carry the source count.
    for (const label of ['first poll', 'second poll', 'third poll']) {
      await poll();
      const statuses = pending(provider.refreshGeneration);
      assert.ok(statuses.length >= 2, `${label} sent too few pending statuses to compare`);
      assert.deepEqual(
        statuses.map((status) => [status.completed, status.known]),
        statuses.map(() => [1, 1]),
        `${label} replaced the source count with a count-free status`,
      );
    }

    // A render posts its own loading stamp, which repeats the count too.
    provider.useRefreshGate(() => true);
    await provider.refresh(false);
    provider.useRefreshGate(() => false);
    const stamp = provider.messages.at(-1).startup;
    assert.equal(stamp.generation, provider.refreshGeneration);
    assert.deepEqual([stamp.completed, stamp.known], [1, 1], 'the render stamp replaced the source count');

    // A newer count replaces the older one in the same generation and the next.
    discovery.more = [{ file: 'extra.jsonl' }];
    await poll(2);
    assert.deepEqual(
      pending(provider.refreshGeneration).map((status) => [status.completed, status.known]),
      pending(provider.refreshGeneration).map(() => [1, 2]),
      'a newer source count did not replace the older count',
    );

    // Discovery that a newer generation overtakes posts nothing and keeps the retained count.
    discovery.more = [{ file: 'extra.jsonl' }, { file: 'extra-two.jsonl' }];
    provider.startupProgressAt = 0;
    const posted = provider.posts.length;
    const overtaken = provider.refreshGeneration;
    discovery.before = () => {
      provider.refreshGeneration += 1;
    };
    await provider.prepareClaudeChildren(overtaken, new AbortController().signal);
    discovery.before = undefined;
    discovery.more = [];
    assert.equal(provider.posts.length, posted, 'overtaken discovery posted a source count');
    const signal = new AbortController().signal;
    provider.refreshGeneration += 1;
    provider.postSessionLoading(provider.refreshGeneration, signal);
    assert.equal(provider.posts.at(-1).known, 2, 'an older generation changed the retained count');

    // A scope change drops the count.
    const refresh = vi.spyOn(provider, 'refresh');
    provider.workspaceFoldersChanged();
    await refresh.mock.results.at(-1)!.value;
    assert.equal(provider.refreshController, null);
    Object.assign(provider, { repositoryScopeReady: true, repositoryScopeRoots: ['project'] });
    provider.refreshGeneration += 1;
    provider.postSessionLoading(provider.refreshGeneration, signal);
    assert.deepEqual(
      [provider.posts.at(-1).completed, provider.posts.at(-1).known],
      [0, 0],
      'a scope change kept the previous scope source count',
    );

    // Completion drops the count, so the next pending state starts from none.
    catalog([healthy, first, second]);
    await poll();
    completePass();
    await poll();
    assert.equal(provider.posts.at(-1).complete, true, 'settled sources did not complete loading');
    pendingPass();
    provider.refreshGeneration += 1;
    provider.postSessionLoading(provider.refreshGeneration, signal);
    assert.deepEqual(
      [provider.posts.at(-1).completed, provider.posts.at(-1).known],
      [0, 0],
      'completion kept the source count for the next pending state',
    );
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

// Two panels on one session list: one shows a session whose newest turns are current, the other one still reads its newest turns.
function twoPanelLoading(harness: any, loadingFirst: boolean) {
  const { provider, healthy, second } = harness;
  const current = provider.hosts[0];
  const reading = { webview: { postMessage: () => Promise.resolve(true) }, active: () => false, visible: () => true };
  provider.hosts = loadingFirst ? [reading, current] : [current, reading];
  provider.readyHosts = new Set(provider.hosts);
  provider.hostSessions = new Map([
    [current, healthy.sessionId],
    [reading, second.sessionId],
  ]);
  // The host reads loadingNewest only for the shown session, so the reading panel shows it.
  provider._showing = second.sessionId;
  provider.progressiveCurrent = (session: { sessionId: string }) => session.sessionId !== second.sessionId;
  const sent: { host: unknown; startup: any }[] = [];
  provider.sendToHost = (host: unknown, message: { startup?: object }) => {
    if (message.startup) sent.push({ host, startup: message.startup });
    return Promise.resolve();
  };
  const statuses = (host: unknown) =>
    sent.filter((entry) => entry.host === host && entry.startup.generation === provider.refreshGeneration);
  return { current, reading, sent, statuses };
}

test.for([true, false])(
  'the source count ends with the session list for every panel when the reading panel comes first: %s',
  async (loadingFirst) => {
    vi.useFakeTimers();
    try {
      const harness = exhaustedLoadingHarness();
      const { pendingPass, completePass, provider, healthy, first, second, catalog, poll } = harness;
      pendingPass();
      await provider.refresh(true);
      provider.useRefreshGate(() => false);
      const { current, reading, sent, statuses } = twoPanelLoading(harness, loadingFirst);
      const render = async () => {
        provider.useRefreshGate(() => true);
        await provider.refresh(false);
        provider.useRefreshGate(() => false);
      };
      const counts = (host: unknown) => statuses(host).map((entry) => [entry.startup.completed, entry.startup.known]);

      // While the list reads, both panels repeat the count.
      await poll();
      await render();
      for (const host of [current, reading]) {
        assert.ok(statuses(host).length > 0, 'a panel received no status');
        assert.deepEqual(
          counts(host),
          statuses(host).map(() => [1, 1]),
        );
      }

      // The list completes while one panel still reads its newest turns. Neither panel's order changes what the count does.
      catalog([healthy, first, second]);
      completePass();
      sent.length = 0;
      await poll();
      await render();
      assert.deepEqual(
        statuses(current).map((entry) => entry.startup.complete),
        statuses(current).map(() => true),
        'the current panel did not complete with the list',
      );
      assert.ok(statuses(reading).length > 0, 'the reading panel received no status');
      assert.deepEqual(
        counts(reading),
        statuses(reading).map(() => [undefined, undefined]),
        'the reading panel kept the count of a list that completed',
      );
      // The reading panel's newest turns keep its stamps pending, and the list completion holds its line hidden.
      assert.deepEqual(
        statuses(reading).map((entry) => [entry.startup.complete, entry.startup.held]),
        statuses(reading).map(() => [false, true]),
      );
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test('a render that leaves the loading status pending still ends the source count when the list completes', async () => {
  vi.useFakeTimers();
  try {
    const harness = exhaustedLoadingHarness();
    const { pendingPass, completePass, provider, healthy, first, second, catalog, poll } = harness;
    pendingPass();
    await provider.refresh(true);
    provider.useRefreshGate(() => false);
    const signal = new AbortController().signal;
    const pendingCount = () => {
      provider.completeCatalogScope = undefined;
      provider.refreshGeneration += 1;
      provider.postSessionLoading(provider.refreshGeneration, signal);
      return [provider.posts.at(-1).completed, provider.posts.at(-1).known];
    };

    // The only panel still reads its newest turns, so the render marks its own status pending while the list completes.
    twoPanelLoading(harness, true);
    provider.hosts = [provider.hosts[0]];
    provider.readyHosts = new Set(provider.hosts);
    await poll();
    assert.deepEqual(pendingCount(), [1, 1], 'the count was not retained while the list was reading');
    catalog([healthy, first, second]);
    completePass();
    await poll();
    assert.deepEqual(pendingCount(), [0, 0], 'a render with a pending panel status kept the count of a completed list');

    // A completed list that was already sent still ends the count when the same state is sent again.
    pendingPass();
    await poll();
    provider.completeCatalogScope = JSON.stringify(provider.repositoryScopeRoots);
    const generation = provider.refreshGeneration;
    provider.startupLoadingSent = JSON.stringify(provider.sessionLoadingState(generation));
    const posted = provider.posts.length;
    provider.postSessionLoading(generation, signal);
    assert.equal(provider.posts.length, posted, 'a repeated completed state posted again');
    assert.deepEqual(pendingCount(), [0, 0], 'duplicate suppression skipped the end of the source count');
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test('the source count follows the latest accepted checkpoint even when its progress post is throttled', async () => {
  vi.useFakeTimers();
  try {
    const { pendingPass, provider, discovery, poll } = exhaustedLoadingHarness();
    pendingPass();
    await provider.refresh(true);
    provider.useRefreshGate(() => false);
    await poll();

    // A checkpoint with more sources arrives inside the throttle window. It posts no progress and still replaces the older count.
    discovery.more = [{ file: 'extra.jsonl' }, { file: 'extra-two.jsonl' }];
    provider.dispatchDiscoveryPending = true;
    const throttledAt = Date.now() - 100;
    provider.startupProgressAt = throttledAt;
    await provider.refresh(false, true);
    const generation = provider.refreshGeneration;
    assert.equal(provider.startupProgressAt, throttledAt, 'the checkpoint passed the throttle');
    const statuses = loadingStatuses(provider, generation).filter((status) => !status.complete && !status.failed);
    assert.ok(statuses.length > 0, 'no pending status followed the throttled checkpoint');
    assert.deepEqual(
      statuses.map((status) => [status.completed, status.known]),
      statuses.map(() => [1, 3]),
      'a throttled checkpoint left an older source count on screen',
    );

    // The count is derived again after the checkpoint changes in place.
    const checkpoint = { sequence: 1, parents: [{ file: 'a' }], catalog: [{ file: 'b' }], completed: ['a'] };
    assert.deepEqual(provider.sourceCountOf(checkpoint), { completed: 1, known: 2 });
    checkpoint.completed.push('b');
    assert.deepEqual(
      provider.sourceCountOf(checkpoint),
      { completed: 2, known: 2 },
      'a changed checkpoint kept its count',
    );
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test('the source count is ignored under a discovery scope other than the one it was counted for', async () => {
  vi.useFakeTimers();
  try {
    const { pendingPass, provider, poll } = exhaustedLoadingHarness();
    pendingPass();
    await provider.refresh(true);
    provider.useRefreshGate(() => false);
    await poll();
    const signal = new AbortController().signal;
    const pendingCount = () => {
      provider.refreshGeneration += 1;
      provider.postSessionLoading(provider.refreshGeneration, signal);
      return [provider.posts.at(-1).completed, provider.posts.at(-1).known];
    };
    assert.deepEqual(pendingCount(), [1, 1]);
    // The roots change without a workspace folder change, as a repository scope refresh does.
    provider.repositoryScopeRoots = ['project', 'worktree'];
    assert.deepEqual(pendingCount(), [0, 0], 'a count from another discovery scope stayed on screen');
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test('an exhausted catalog source stays settled through selection renders and a discovery failure', async () => {
  vi.useFakeTimers();
  try {
    const { completePass, provider, healthy, discovery, poll } = exhaustedLoadingHarness();
    completePass();
    await provider.refresh(true);
    assert.equal(provider.messages.at(-1).startup.failed, undefined, 'the render failed an exhausted catalog source');

    provider._showing = healthy.sessionId;
    const rendered = provider.messages.length;
    await provider.refresh(true, true, true, true);
    assert.equal(provider.messages.length, rendered + 1, 'the selection refresh posted no render');
    assert.equal(provider.messages.at(-1).startup.failed, undefined, 'the selection render failed an exhausted source');
    provider.useRefreshGate(() => false);

    discovery.fail = true;
    provider.dispatchDiscoveryPending = true;
    await provider.refresh(false, true);
    assert.equal(provider.posts.at(-1).generation, provider.refreshGeneration);
    assert.equal(provider.posts.at(-1).failed, true, 'the discovery failure posted no failure');
    assert.equal(provider.posts.at(-1).held, true, 'a discovery failure after completion showed the loading line');
    discovery.fail = false;
    const { progress, last } = await poll();
    assert.equal(progress, undefined, 'the next source count kept a failure');
    assert.equal(last.failed, undefined);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test('relationship progress after a work failure in its generation keeps the failure', async () => {
  vi.useFakeTimers();
  try {
    const { pendingPass, provider, discovery, poll } = exhaustedLoadingHarness();
    pendingPass();
    await provider.refresh(true);
    assert.equal(provider.messages.at(-1).startup.failed, undefined);
    provider.useRefreshGate(() => false);

    discovery.before = (generation: number, signal: AbortSignal) => provider.failSessionLoading(generation, signal);
    const { progress } = await poll();
    assert.equal(progress, true, 'a source count after a work failure replaced the failure with reading text');
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

// Every loading state the panel receives, in delivery order: status posts and the stamps on renders and selections.
// A stamp shows the line unless it is complete, failed, or held, as the panel's applySessionLoading decides. The panel acknowledges
// completion for a stamp that is complete.
type LoadingEntry = { kind: string; generation: number; visible: boolean; complete: boolean };
function loadingStream(provider: any): LoadingEntry[] {
  const stream: LoadingEntry[] = [];
  const entry = (
    kind: string,
    stamp: { generation: number; complete?: boolean; failed?: boolean; held?: boolean },
  ) => ({
    kind,
    generation: stamp.generation,
    visible: stamp.complete !== true && stamp.failed !== true && stamp.held !== true,
    complete: stamp.complete === true,
  });
  const post = provider.post.bind(provider);
  provider.post = (message: any) => {
    if (message.type === 'startupProgress') stream.push(entry('progress', message));
    return post(message);
  };
  const send = provider.sendToHost.bind(provider);
  provider.sendToHost = (host: unknown, message: any) => {
    if (message.startup) stream.push(entry(message.type, message.startup));
    return send(host, message);
  };
  return stream;
}

test('the loading line stays hidden after the session list completes until the scope changes', async () => {
  vi.useFakeTimers();
  try {
    const {
      provider,
      healthy,
      first,
      second,
      codex,
      settled,
      recovering,
      catalog,
      discovery,
      poll,
      pendingPass,
      completePass,
    } = exhaustedLoadingHarness();
    const stream = loadingStream(provider);
    const render = async () => {
      provider.useRefreshGate(() => true);
      await provider.refresh(false);
      provider.useRefreshGate(() => false);
    };
    pendingPass();
    await provider.refresh(true);
    provider.useRefreshGate(() => false);
    await poll();
    await poll();
    assert.ok(
      stream.some((entry) => entry.visible),
      'the first load never showed the loading line',
    );
    assert.deepEqual(
      stream.filter((entry) => !entry.visible),
      [],
      'the incomplete first load claimed completion',
    );

    completePass();
    await poll();
    assert.equal(stream.at(-1)?.visible, false, 'the complete reply did not complete the list');
    const completedAt = stream.length;
    const hiddenSince = (label: string) =>
      assert.deepEqual(
        stream.slice(completedAt).filter((entry) => entry.visible),
        [],
        `${label} showed the loading line after completion`,
      );

    for (let index = 0; index < 3; index++) await poll();
    hiddenSince('an ordinary poll');

    // A live append grows a source, so its held metadata no longer matches its revision.
    provider.titles.set(first.file, recovering(first));
    const grown = { ...first, size: 2, mtimeMs: 2 };
    catalog([healthy, grown, second]);
    await render();
    await poll();
    hiddenSince('a live revision');

    // A new session arrives before its start times are read.
    const added = codex('codex-c', 70);
    provider.titles.set(added.file, { ...settled(added), starts: undefined });
    catalog([healthy, grown, second, added]);
    await render();
    await poll();
    hiddenSince('a new session without start times');

    // A source's metadata read reopens without a catalog change, so no render runs.
    provider.titles.set(second.file, recovering(second));
    await poll();
    provider.titles.set(second.file, settled(second));
    hiddenSince('a reopened metadata read');

    // A work failure, then its retry.
    discovery.fail = true;
    await poll();
    discovery.fail = false;
    await poll();
    hiddenSince('a work failure and its retry');

    // Discovery asks for further passes.
    discovery.pending = true;
    await poll();
    await poll();
    discovery.pending = false;
    hiddenSince('a discovery continuation');

    // The selected session's newest turn is loading.
    provider._showing = healthy.sessionId;
    provider.progressiveCurrent = () => false;
    await render();
    await provider.refresh(true, true, true, true);
    hiddenSince('a loading newest turn');
    assert.ok(stream.length - completedAt >= 10, 'too few posts followed completion to compare');

    // New workspace folders read again, so the render of their unsettled list shows the line.
    provider.workspaceFoldersChanged();
    await vi.waitFor(() => assert.equal(provider.refreshController, null));
    Object.assign(provider, { repositoryScopeReady: true, repositoryScopeRoots: ['project'] });
    pendingPass();
    const changedAt = stream.length;
    await render();
    assert.ok(
      stream.slice(changedAt).some((entry) => entry.kind === 'render' && entry.visible),
      'a scope change kept the previous scope complete',
    );
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test('a complete discovery reply that asks for another pass hides the loading line through the follow-up pass', async () => {
  vi.useFakeTimers();
  try {
    const { provider, first, second, settled, discovery, poll } = exhaustedLoadingHarness();
    const stream = loadingStream(provider);
    const scope = JSON.stringify(['project']);
    provider.titles.set(first.file, settled(first));
    provider.titles.set(second.file, settled(second));
    discovery.pending = true;
    await provider.refresh(true);
    provider.useRefreshGate(() => false);
    await poll();
    assert.equal(stream.at(-1)?.visible, true, 'pending discovery did not show the loading line');
    assert.equal(provider.loadingLine.held(scope), false);

    // A dispatched file changed during the read, so the complete reply asks for another pass.
    discovery.pending = false;
    discovery.continuation = true;
    await poll();
    assert.equal(provider.dispatchDiscoveryPending, true, 'the complete reply asked for no further pass');
    assert.equal(stream.at(-1)?.visible, false, 'the complete reply kept the loading line');
    assert.ok(provider.loadingLine.held(scope), 'the complete reply did not hold the line');
    const completedAt = stream.length;

    // The follow-up pass posts its own discovery progress.
    discovery.pending = true;
    for (let index = 0; index < 3; index++) await poll();
    discovery.pending = false;
    await poll();
    assert.ok(stream.length > completedAt, 'the follow-up pass posted nothing to compare');
    assert.deepEqual(
      stream.slice(completedAt).filter((entry) => entry.visible),
      [],
      'the follow-up pass showed the loading line',
    );

    // A follow-up pass under a root the list has not loaded shows the line again.
    provider.repositoryScopeRoots = ['project', 'worktree'];
    const at = stream.length;
    provider.dispatchDiscoveryPending = true;
    provider.postSessionLoading(provider.refreshGeneration, new AbortController().signal);
    assert.deepEqual(
      stream.slice(at).map((entry) => entry.visible),
      [true],
      'an unseen root kept the loading line hidden',
    );
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test('live Claude and Codex sources that keep growing after a complete discovery reply let the loading line hide', async () => {
  vi.useFakeTimers();
  try {
    const { provider, healthy, second, codex, settled, catalog, discovery, poll } = exhaustedLoadingHarness();
    const stream = loadingStream(provider);
    const scope = JSON.stringify(['project']);
    const claude = { ...healthy, agent: 'claude', size: 10, mtimeMs: 10 };
    const rollout = codex('codex-live', 85);
    let size = 10;
    // Each agent appends after every read: the Claude transcript's accepted metadata trails its revision, and the Codex rollout's
    // turn starts are not read yet.
    const grow = () => {
      size++;
      const liveClaude = { ...claude, size, mtimeMs: size };
      const liveCodex = { ...rollout, size, mtimeMs: size };
      catalog([liveClaude, liveCodex, second]);
      provider.titles.set(liveClaude.file, settled({ size: size - 1, mtimeMs: size - 1 }));
      provider.titles.set(liveCodex.file, { ...settled(liveCodex), starts: undefined });
    };
    grow();
    discovery.pending = true;
    await provider.refresh(true);
    provider.useRefreshGate(() => false);
    await poll();
    assert.equal(stream.at(-1)?.visible, true, 'pending discovery did not show the loading line');

    // A dispatched file changed during the read, so the complete reply asks for another pass while both sources keep growing.
    discovery.pending = false;
    discovery.continuation = true;
    grow();
    await poll();
    assert.equal(provider.dispatchDiscoveryPending, true, 'the complete reply asked for no further pass');
    assert.equal(stream.at(-1)?.visible, false, 'growing sources kept the loading line after a complete reply');
    assert.ok(provider.loadingLine.held(scope), 'the complete reply did not hold the line');
    const completedAt = stream.length;
    for (let index = 0; index < 3; index++) {
      grow();
      discovery.pending = index < 2;
      await poll();
    }
    assert.deepEqual(
      stream.slice(completedAt).filter((entry) => entry.visible),
      [],
      'a growing source or a follow-up pass showed the loading line',
    );
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test('a catalog reused after an incomplete pass under returning roots does not complete the list', async () => {
  vi.useFakeTimers();
  try {
    const { provider, discovery, poll } = exhaustedLoadingHarness();
    const stream = loadingStream(provider);
    provider.refreshFrom = () => {};
    provider.selectionWorks = new Map();
    discovery.roots = () => provider.repositoryScopeRoots;
    const moveTo = (roots: string[], revision: number) => {
      provider.repositoryScopeRoots = roots;
      provider.repositoryScope = { snapshot: () => ({ ready: true, revision, roots }) };
      provider.repositoryScopeChanged();
    };
    await provider.refresh(true);
    provider.useRefreshGate(() => false);
    await poll();
    assert.ok(
      provider.loadingLine.held(JSON.stringify(['project'])),
      'the complete reply under the first roots did not hold the line',
    );

    // The roots gain a worktree, and its discovery pass stays incomplete.
    discovery.pending = true;
    moveTo(['project', 'worktree'], 1);
    await poll();
    assert.equal(stream.at(-1)?.visible, true, 'the incomplete pass under new roots hid the loading line');

    // The roots return to the first ones. The catalog the first roots completed is reused after another incomplete pass.
    moveTo(['project'], 2);
    const returnedAt = stream.length;
    await poll();
    assert.ok(stream.length > returnedAt, 'the pass under the returning roots posted nothing');
    assert.deepEqual(
      stream.slice(returnedAt).map((entry) => entry.visible),
      stream.slice(returnedAt).map(() => true),
      'a catalog reused after an incomplete pass completed the returning roots',
    );
    assert.equal(provider.loadingLine.held(JSON.stringify(['project'])), false);

    // A complete reply under the returning roots completes the list.
    discovery.pending = false;
    await poll();
    assert.equal(stream.at(-1)?.visible, false, 'a complete reply under the returning roots kept the loading line');
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

// A harness whose published catalog came from an incomplete pass, and whose next discovery pass returns a complete reply.
async function unansweredCatalogHarness() {
  const harness = exhaustedLoadingHarness();
  const { provider, first, second, settled, discovery, pendingPass } = harness;
  const stream = loadingStream(provider);
  let discoveries = 0;
  discovery.before = () => discoveries++;
  provider.titles.set(first.file, settled(first));
  provider.titles.set(second.file, settled(second));
  pendingPass();
  provider.dispatchDiscoveryPending = true;
  await provider.refresh(true);
  provider.useRefreshGate(() => false);
  assert.equal(stream.at(-1)?.visible, true, 'the incomplete pass did not show the loading line');
  discovery.pending = false;
  return { ...harness, stream, discoveries: () => discoveries };
}

test('a complete reply carried to a catalog listed again with an unanswered session keeps the line up until discovery answers it', async () => {
  vi.useFakeTimers();
  try {
    const { provider, healthy, first, second, codex, settled, catalog, stream, discoveries } =
      await unansweredCatalogHarness();
    const scope = JSON.stringify(['project']);
    // The complete reply lands in a refresh that publishes no catalog.
    await provider.refresh(true, true, true);
    assert.equal(stream.at(-1)?.visible, true, 'a refresh that published no catalog hid the loading line');
    vi.clearAllTimers();

    // A new session appears, and the next refresh lists the catalog again without running discovery.
    const unscanned = codex('Unscanned', 95);
    catalog([healthy, first, second, unscanned]);
    provider.titles.set(unscanned.file, settled(unscanned));
    const before = discoveries();
    await provider.refresh(false, true);
    assert.equal(discoveries(), before, 'the listing refresh ran discovery');
    assert.equal(stream.at(-1)?.visible, true, 'a complete reply completed a catalog it never answered');
    assert.equal(provider.loadingLine.held(scope), false);

    // The refresh that discarded the reply schedules discovery, and its complete reply hides the line.
    await vi.waitFor(() => assert.equal(stream.at(-1)?.visible, false, 'the loading line stayed up'));
    assert.ok(discoveries() > before, 'no later refresh ran discovery');
    assert.ok(provider.loadingLine.held(scope));
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test('a complete reply that lands in a refresh publishing no catalog completes the next publication of that catalog', async () => {
  for (const landing of ['metadata after render', 'abandoned'] as const) {
    vi.useFakeTimers();
    try {
      const { provider, stream, discoveries } = await unansweredCatalogHarness();
      if (landing === 'metadata after render') {
        await provider.refresh(true, true, true);
      } else {
        const prepareMetadata = provider.prepareMetadata;
        provider.prepareMetadata = () => {
          provider.prepareMetadata = prepareMetadata;
          provider.abandonCatalogRefresh();
          return Promise.resolve(false);
        };
        await provider.refresh(true);
      }
      assert.equal(stream.at(-1)?.visible, true, `a ${landing} refresh hid the loading line`);
      vi.clearAllTimers();
      const before = discoveries();
      await provider.refresh(false, true);
      assert.equal(discoveries(), before, 'the publishing refresh ran discovery');
      assert.equal(
        stream.at(-1)?.visible,
        false,
        `a complete reply in a ${landing} refresh never completed its catalog`,
      );
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  }
});

test('a failed metadata read records the file and does not keep the loading line up', async () => {
  vi.useFakeTimers();
  try {
    const harness = exhaustedLoadingHarness(['prepareMetadata'], {
      INITIAL_RAIL_READ_BYTES,
      metadataReadBudget,
      unreadHeadBytes,
      acceptsProgressiveResult,
      onlyGrew,
      carryDerivedTitleFacts,
      sameSessionRevision,
    });
    const { provider, first, poll } = harness;
    const stream = loadingStream(provider);
    const failures: Record<string, unknown>[] = [];
    provider.diagnostics = {
      ...provider.diagnostics,
      warn: (event: string, record: Record<string, unknown>) => {
        if (event === 'sessionReadFailed') failures.push(record);
      },
    };
    provider.observeStoredEntry = () => {};
    provider.codexMetas = new Map();
    // The first Codex source's accepted metadata trails its revision, and every read of it fails.
    provider.titles.set(first.file, { ...harness.settled(first), size: 0, mtimeMs: 0 });
    const discover = provider.progressiveWorker.run;
    let metadataReads = 0;
    provider.progressiveWorker.run = (request: { kind: string }, generation: number, signal: AbortSignal) => {
      if (request.kind !== 'metadata') return discover(request, generation, signal);
      metadataReads++;
      return Promise.reject(new Error('read failed'));
    };
    await provider.refresh(true);
    provider.useRefreshGate(() => false);
    await poll();
    await poll();
    assert.ok(metadataReads >= 2, 'the fixture did not retry the failed metadata read');
    assert.equal(stream.at(-1)?.visible, false, 'a failed metadata read kept the loading line up');
    assert.ok(
      provider.loadingLine.held(JSON.stringify(['project'])),
      'a failed metadata read kept the list from completing',
    );
    assert.equal(
      provider.posts.some((message: { failed?: boolean }) => message.failed),
      false,
      'a failed metadata read posted a failure',
    );
    assert.deepEqual(
      failures,
      [{ read: 'metadata', file: first.file }],
      'the failed read was not recorded once for its file',
    );
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test('the startup acknowledgement waits for the selected newest turn when the list first completes', async () => {
  vi.useFakeTimers();
  try {
    const { provider, healthy, first, second, settled } = exhaustedLoadingHarness();
    const stream = loadingStream(provider);
    provider.titles.set(first.file, settled(first));
    provider.titles.set(second.file, settled(second));
    provider._showing = healthy.sessionId;
    provider.progressiveCurrent = () => false;
    await provider.refresh(true);
    provider.postSessionLoading(provider.refreshGeneration, new AbortController().signal);
    assert.ok(
      provider.loadingLine.held(JSON.stringify(provider.repositoryScopeRoots)),
      'the complete list did not hold the line',
    );
    assert.ok(
      stream.some((entry) => entry.kind !== 'progress'),
      'the first load posted no render stamp',
    );
    assert.deepEqual(
      stream.filter((entry) => entry.complete),
      [],
      'the panel was told to acknowledge completion while the newest turn loaded',
    );
    assert.equal(stream.at(-1)?.visible, false, 'the complete list kept the loading line');
    provider.progressiveCurrent = () => true;
    await provider.refresh(true, true, true, true);
    assert.equal(stream.at(-1)?.complete, true, 'the current newest turn did not complete the render');
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test('new repository scope roots show loading until a list listed under them completes', async () => {
  vi.useFakeTimers();
  try {
    const { provider, healthy, first, second, settled, poll } = exhaustedLoadingHarness();
    const stream = loadingStream(provider);
    provider.titles.set(first.file, settled(first));
    provider.titles.set(second.file, settled(second));
    provider._showing = healthy.sessionId;
    await provider.refresh(true);
    provider.useRefreshGate(() => false);
    await poll();
    assert.ok(provider.loadingLine.held(JSON.stringify(['project'])), 'the settled list did not hold the line');
    const signal = new AbortController().signal;
    // The selected window's render lists the catalog the previous roots built, and the list stays pending for the new roots.
    const pendingShows = async (label: string) => {
      const before = stream.length;
      provider.useRefreshGate(() => true);
      await provider.refresh(true, true, true, true);
      provider.useRefreshGate(() => false);
      assert.ok(stream.length > before, `${label} posted no selection render`);
      // The catalog was completed under the previous roots, so the new roots are pending until their own complete reply.
      provider.postSessionLoading(provider.refreshGeneration, signal);
      assert.deepEqual(
        stream.slice(before).map((entry) => entry.visible),
        stream.slice(before).map(() => true),
        `${label} held the new roots complete before their list loaded`,
      );
    };

    // Roots change on a path that releases nothing.
    provider.repositoryScopeRoots = ['project', 'worktree'];
    await pendingShows('a roots change without a release');

    // The repository scope callback fires while the full refresh for the new roots is still pending.
    provider.repositoryScopeRoots = ['project'];
    assert.ok(provider.loadingLine.held(JSON.stringify(['project'])), 'unchanged roots lost their hold');
    provider.selectionWorks = new Map();
    provider.refreshFrom = () => {};
    provider.repositoryScopeRoots = ['project', 'worktree'];
    provider.repositoryScope = { snapshot: () => ({ ready: true, revision: 2, roots: ['project', 'worktree'] }) };
    provider.repositoryScopeChanged();
    assert.equal(provider.loadingLine.held(JSON.stringify(['project'])), false, 'the scope callback kept the hold');
    await pendingShows('a selection render after the repository scope callback');
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

// A host whose repository scope reads scripted Git answers for the open folder `project`. Each answer lists `project` and the named
// worktrees. The scope's own timers ask Git again, and every refresh reads the roots from the scope, as the host does.
function gitScopedLoadingHarness() {
  const harness = exhaustedLoadingHarness(['createRepositoryScope'], { RepositoryScope });
  const { provider, first, second, settled, discovery } = harness;
  const answers: string[][] = [];
  provider.repositoryScope = provider.createRepositoryScope({
    run: async () => {
      const trees = answers.shift();
      if (!trees) return null;
      return ['project', ...trees].map((root) => `worktree ${root}\0HEAD a\0`).join('\0') + '\0';
    },
  });
  provider.allSessions = () => {
    const scope = provider.repositoryScope.snapshot(provider.folders());
    provider.repositoryScopeReady = scope.ready;
    provider.repositoryScopeRoots = scope.ready ? scope.roots : [];
    return provider.partial;
  };
  discovery.roots = () => provider.repositoryScopeRoots;
  const scopeChanges: string[][] = [];
  const changed = provider.repositoryScopeChanged.bind(provider);
  provider.repositoryScopeChanged = () => {
    scopeChanges.push(provider.repositoryScope.snapshot(provider.folders()).roots);
    changed();
  };
  // A scope change starts a full refresh, which each test runs itself so it can count it.
  const fullRefreshes: string[] = [];
  provider.selectionWorks = new Map();
  // A selected-only refresh is not a full refresh, so it runs through the real method.
  const refreshFrom = provider.refreshFrom;
  provider.refreshFrom = (reason: string, ...rest: unknown[]) =>
    rest[4] ? refreshFrom.call(provider, reason, ...rest) : fullRefreshes.push(reason);
  const lines: { event: string; record: any }[] = [];
  provider.diagnostics = {
    ...provider.diagnostics,
    warn: (event: string, record: any) => lines.push({ event, record }),
  };
  provider.titles.set(first.file, settled(first));
  provider.titles.set(second.file, settled(second));
  const stream = loadingStream(provider);
  // Loads the list under the first Git answer until it completes and holds the line.
  const complete = async (trees: string[]) => {
    answers.push(trees);
    provider.repositoryScope.snapshot(provider.folders());
    await vi.advanceTimersByTimeAsync(0);
    await provider.refresh(true);
    provider.useRefreshGate(() => false);
    await harness.poll();
    assert.ok(
      provider.loadingLine.held(JSON.stringify(provider.repositoryScopeRoots)),
      'the settled list did not hold the line',
    );
    assert.deepEqual(provider.repositoryScopeRoots, ['project', ...trees]);
    scopeChanges.length = 0;
    fullRefreshes.length = 0;
    return stream.length;
  };
  // Lets the regular scope interval pass, so the next scope read asks Git for its next answer, and lets that answer arrive.
  const interval = async () => {
    await vi.advanceTimersByTimeAsync(REPOSITORY_SCOPE_REFRESH_MS);
    provider.repositoryScope.snapshot(provider.folders());
    await vi.advanceTimersByTimeAsync(0);
  };
  const decisions = () =>
    lines.filter(({ event }) => event === 'repositoryScopeDecision').map(({ record }) => record.decision);
  const shownSince = (at: number) => stream.slice(at).filter((entry) => entry.visible);
  const { poll, recovering } = harness;
  return {
    provider,
    first,
    settled,
    recovering,
    discovery,
    poll,
    answers,
    scopeChanges,
    fullRefreshes,
    lines,
    stream,
    complete,
    interval,
    decisions,
    shownSince,
  };
}

const SCOPE_TREES = ['wt-a', 'wt-b'];

test('one short worktree list after the hold keeps the loading line hidden and the session list loaded', async () => {
  vi.useFakeTimers();
  try {
    const git = gitScopedLoadingHarness();
    const completedAt = await git.complete(SCOPE_TREES);
    // Git briefly lists only the main checkout, and its next answer lists every worktree again.
    git.answers.push([], SCOPE_TREES);
    await git.interval();
    await vi.advanceTimersByTimeAsync(REPOSITORY_SCOPE_CONFIRM_MS);
    for (let index = 0; index < 3; index++) await git.poll();

    assert.deepEqual(git.shownSince(completedAt), [], 'a short worktree list showed the loading line');
    assert.deepEqual(git.scopeChanges, [], 'a short worktree list changed the repository scope');
    assert.deepEqual(git.fullRefreshes, [], 'a short worktree list started a full refresh');
    assert.ok(
      git.provider.loadingLine.held(JSON.stringify(['project', ...SCOPE_TREES])),
      'a short worktree list released the hold',
    );
    assert.deepEqual(git.decisions(), ['accepted', 'held for confirmation', 'discarded']);
    const held = git.lines.find(({ record }) => record.decision === 'held for confirmation')?.record;
    assert.deepEqual(
      [held?.oldRoots, held?.newRoots, held?.answeredRoots, held?.removed, held?.removedCount, held?.addedCount],
      [3, 3, 1, SCOPE_TREES, 2, 0],
    );
    assert.ok(held?.stdoutLength > 0);
    assert.match(held?.oldScope ?? '', /^[0-9a-f]{8}$/);
    const heldLine = git.lines.find(({ event }) => event === 'sessionLoadingHeld')?.record;
    assert.equal(
      held?.oldScope,
      heldLine?.scope,
      'the scope decision hashed its roots differently from the loading line',
    );
    assert.deepEqual(
      git.lines.filter(({ record }) => record.decision === 'discarded').map(({ record }) => record.restored),
      [SCOPE_TREES],
    );
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test('two agreeing short worktree lists shrink the scope and keep the loading line hidden', async () => {
  vi.useFakeTimers();
  try {
    const git = gitScopedLoadingHarness();
    const { provider, first, recovering, settled } = git;
    const completedAt = await git.complete(SCOPE_TREES);
    git.answers.push([], []);
    await git.interval();
    await vi.advanceTimersByTimeAsync(REPOSITORY_SCOPE_CONFIRM_MS);
    assert.deepEqual(git.scopeChanges, [['project']], 'the confirmed removal did not change the repository scope');
    assert.deepEqual(git.fullRefreshes, ['repository-scope']);
    assert.deepEqual(git.decisions(), ['accepted', 'held for confirmation', 'confirmed']);

    // The reload under the smaller scope finds a source still reading its metadata.
    provider.titles.set(first.file, recovering(first));
    await provider.refresh(true);
    provider.useRefreshGate(() => false);
    await git.poll();
    provider.titles.set(first.file, settled(first));
    await git.poll();
    assert.deepEqual(provider.repositoryScopeRoots, ['project']);
    assert.deepEqual(git.shownSince(completedAt), [], 'the reload under the smaller scope showed the loading line');
    assert.ok(provider.loadingLine.held(JSON.stringify(['project'])), 'the smaller scope lost the hold');
    assert.deepEqual(
      git.lines
        .filter(({ event }) => ['sessionLoadingHeld', 'sessionLoadingKept', 'sessionLoadingReleased'].includes(event))
        .map(({ event, record }) => [event, record.cause]),
      [
        ['sessionLoadingHeld', undefined],
        ['sessionLoadingKept', 'repository scope'],
      ],
    );

    // A workspace folder change still releases the hold.
    provider.workspaceFoldersChanged();
    await vi.waitFor(() => assert.equal(provider.refreshController, null));
    assert.ok(
      git.lines.some(({ event, record }) => event === 'sessionLoadingReleased' && record.cause === 'workspace folders'),
      'a workspace folder change kept the hold',
    );
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test('a worktree list that adds a root releases the hold and shows loading for it', async () => {
  vi.useFakeTimers();
  try {
    const git = gitScopedLoadingHarness();
    const { provider, discovery } = git;
    const completedAt = await git.complete(SCOPE_TREES);
    git.answers.push([...SCOPE_TREES, 'wt-c']);
    await git.interval();
    assert.deepEqual(git.scopeChanges, [['project', ...SCOPE_TREES, 'wt-c']]);
    assert.deepEqual(git.decisions(), ['accepted', 'accepted']);
    assert.ok(
      git.lines.some(
        ({ event, record }: { event: string; record: any }) =>
          event === 'sessionLoadingReleased' && record.cause === 'repository scope',
      ),
      'a new worktree kept the hold',
    );
    assert.deepEqual(git.shownSince(completedAt), []);

    // Discovery for the new root is still running.
    discovery.pending = true;
    await provider.refresh(true);
    assert.ok(git.shownSince(completedAt).length > 0, 'loading for the new worktree stayed hidden');
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test('a worktree list that adds a root nested inside the open folder keeps the hold, the selection and the catalog', async () => {
  vi.useFakeTimers();
  try {
    const git = gitScopedLoadingHarness();
    const { provider } = git;
    const completedAt = await git.complete(SCOPE_TREES);
    const work = { sessionId: 'selected', controller: new AbortController() };
    provider.selectionWorks.set(work.sessionId, work);
    const catalog = provider.authoritativeCatalog;
    git.answers.push([...SCOPE_TREES, 'project/.claude/worktrees/Fix-Loading']);
    await git.interval();
    assert.deepEqual(git.scopeChanges, [], 'a nested worktree changed the scope');
    assert.deepEqual(git.fullRefreshes, [], 'a nested worktree started a full refresh');
    assert.deepEqual(provider.repositoryScopeRoots, ['project', ...SCOPE_TREES]);
    assert.equal(work.controller.signal.aborted, false, 'a nested worktree aborted the selection');
    assert.equal(provider.selectionWorks.get(work.sessionId), work);
    assert.equal(provider.authoritativeCatalog, catalog, 'a nested worktree dropped the catalog');
    assert.equal(
      git.lines.some(({ event }: { event: string }) => event === 'sessionLoadingReleased'),
      false,
      'a nested worktree released the hold',
    );
    assert.ok(provider.loadingLine.held(JSON.stringify(provider.repositoryScopeRoots)));
    await git.poll();
    assert.deepEqual(git.shownSince(completedAt), [], 'a nested worktree showed the loading line');
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test('a worktree list that adds one root and drops another releases the hold', async () => {
  vi.useFakeTimers();
  try {
    const git = gitScopedLoadingHarness();
    await git.complete(SCOPE_TREES);
    git.answers.push(['wt-a', 'wt-c']);
    await git.interval();
    // The dropped worktree waits for confirmation, while the new one applies at once.
    assert.deepEqual(git.scopeChanges, [['project', ...SCOPE_TREES, 'wt-c']]);
    assert.deepEqual(git.decisions(), ['accepted', 'held for confirmation']);
    assert.ok(
      git.lines.some(({ event, record }) => event === 'sessionLoadingReleased' && record.cause === 'repository scope'),
      'an answer that also added a worktree kept the hold',
    );
    assert.equal(git.provider.loadingLine.held(JSON.stringify(['project', ...SCOPE_TREES, 'wt-c'])), false);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test('a hold covers no empty scope, and a scope that is not ready releases it', () => {
  const written: string[] = [];
  const line = new SessionLoadingLine((event, record) => written.push(`${event} ${record.cause ?? ''}`.trim()));
  line.hold(JSON.stringify(['project', 'wt-a']), 1, 'session loading');
  assert.equal(line.held(JSON.stringify([])), false, 'the hold covered a scope with no roots');
  assert.equal(line.held(JSON.stringify(['wt-a'])), true);
  line.rescope(null, 'repository scope');
  assert.equal(line.held(JSON.stringify(['wt-a'])), false, 'a scope that is not ready kept the hold');
  assert.deepEqual(written, ['sessionLoadingHeld', 'sessionLoadingReleased repository scope']);
});

test('scope decisions and the reasons of a shown line write bounded records', () => {
  const written: { event: string; record: Record<string, any> }[] = [];
  const line = new SessionLoadingLine((event, record) => written.push({ event, record }), { scope: 2, blocked: 2 });
  const many = Array.from({ length: 8 }, (_, index) => `wt-${index}`);
  for (let index = 0; index < 4; index++)
    line.scopeDecision({
      decision: 'held for confirmation',
      previous: ['project', ...many],
      answered: ['project'],
      applied: ['project', ...many],
      restored: [],
      stdoutLength: 40,
      failed: 0,
    });
  const decisions = written.filter(({ event }) => event === 'repositoryScopeDecision').map(({ record }) => record);
  assert.equal(decisions.length, 2, 'scope decisions passed their limit');
  assert.deepEqual(
    [decisions[0].removed.length, decisions[0].removedCount],
    [5, 8],
    'a decision named every removed root',
  );
  assert.equal(decisions[1].limitReached, true);

  // A shown line writes once for each change of a path's blocking reason, and counts that path's repeats in between.
  const stamp = { generation: 1, complete: false };
  const reason = (found: 'catalog missing' | 'discovery complete' | 'discovery pending') => () => ({ reason: found });
  line.present('discovery progress', stamp, 'scope', reason('discovery pending'));
  line.present('discovery progress', stamp, 'scope', reason('discovery pending'));
  line.present('session loading', stamp, 'scope', reason('catalog missing'));
  line.present('session loading', stamp, 'scope', reason('catalog missing'));
  line.present('session loading', stamp, 'scope', reason('discovery complete'));
  for (let index = 0; index < 10; index++)
    line.present('render', stamp, 'scope', reason(index % 2 ? 'catalog missing' : 'discovery complete'));
  assert.deepEqual(
    written
      .filter(({ event }) => event === 'sessionLoadingBlocked')
      .map(({ record }) => [record.path, record.reason, record.repeats]),
    [
      ['session loading', 'catalog missing', 0],
      ['session loading', 'discovery complete', 1],
    ],
    'a shown line logged an unchanged reason, or its reasons passed their limit',
  );
  assert.deepEqual(
    written.filter(({ event }) => event === 'sessionLoadingLine').map(({ record }) => [record.visible, record.reason]),
    [[true, 'discovery pending']],
    'reason records silenced a change of the line',
  );
});

test('the diagnostics log records each loading line change and stays quiet through repeated polls', async () => {
  vi.useFakeTimers();
  try {
    const { provider, healthy, first, second, catalog, poll, pendingPass, completePass } = exhaustedLoadingHarness();
    const lines: { event: string; record: any }[] = [];
    provider.diagnostics = {
      ...provider.diagnostics,
      warn: (event: string, record: any) => {
        if (event.startsWith('sessionLoading')) lines.push({ event, record });
      },
    };
    const events = () =>
      lines.map(({ event, record }) =>
        event === 'sessionLoadingLine'
          ? `${record.visible ? 'shown' : 'hidden'} by ${record.path}${record.reason ? `: ${record.reason}` : ''}`
          : `${event} ${record.reason ?? record.cause ?? record.path}`,
      );
    pendingPass();
    await provider.refresh(true);
    provider.useRefreshGate(() => false);
    await poll();
    await poll();
    completePass();
    await poll();
    for (let index = 0; index < 3; index++) await poll();
    // A live append grows a source, then a catalog from an incomplete pass is withheld while the line is held.
    const grown = { ...first, size: 2, mtimeMs: 2 };
    catalog([healthy, grown, second]);
    for (let index = 0; index < 3; index++) await poll();
    pendingPass();
    for (let index = 0; index < 3; index++) await poll();
    const refresh = vi.spyOn(provider, 'refresh');
    provider.workspaceFoldersChanged();
    await refresh.mock.results.at(-1)!.value;
    assert.equal(provider.refreshController, null);

    assert.deepEqual(events(), [
      'shown by discovery progress: discovery pending',
      // The render and the session-list status each name their first reason while the line is shown.
      'sessionLoadingBlocked discovery pending',
      'sessionLoadingBlocked discovery pending',
      'sessionLoadingBlocked discovery complete',
      'sessionLoadingHeld session loading',
      'hidden by session loading',
      // Ordinary polls and a live append write nothing. The pending passes after completion are withheld once for each path.
      'sessionLoadingWithheld discovery complete',
      'sessionLoadingWithheld discovery pending',
      'sessionLoadingWithheld discovery pending',
      'sessionLoadingReleased workspace folders',
    ]);
    const shown = lines[0].record;
    assert.deepEqual([shown.completed, shown.known], [1, 1], 'the shown line lost its source count');
    const withheld = lines.find(
      (line) =>
        line.event === 'sessionLoadingWithheld' &&
        line.record.reason === 'discovery pending' &&
        line.record.path === 'session loading',
    )?.record;
    assert.equal(withheld?.path, 'session loading', 'the withheld line did not name the pending pass');
    // Each record names its scope, so lines from different roots stay apart.
    const held = lines.find((line) => line.event === 'sessionLoadingHeld')?.record;
    const released = lines.find((line) => line.event === 'sessionLoadingReleased')?.record;
    assert.deepEqual([held?.roots, released?.roots, withheld?.roots, shown.roots], [1, 1, 1, 1]);
    assert.match(held?.scope ?? '', /^[0-9a-f]{8}$/);
    assert.deepEqual([released?.scope, withheld?.scope, shown.scope], [held?.scope, held?.scope, held?.scope]);

    // A host writes a bounded number of lines however often the line changes. Withheld work spends its own budget, so it cannot
    // silence a later change of the line.
    const written: { event: string; record: Record<string, unknown> }[] = [];
    const line = new SessionLoadingLine((event, record) => written.push({ event, record }), { line: 3, withheld: 2 });
    const blocker = () => ({ reason: 'catalog missing' as const });
    line.hold('scope', 0, 'render');
    for (let generation = 0; generation < 10; generation++)
      line.withhold(
        'render',
        { generation, complete: false },
        'scope',
        generation % 2 ? blocker : () => ({ reason: 'discovery pending' as const }),
      );
    line.release('scope change');
    for (let generation = 0; generation < 10; generation++) {
      line.present('render', { generation, complete: false }, 'scope', blocker);
      line.present('render', { generation, complete: false, failed: true }, 'scope', blocker);
    }
    assert.equal(
      written.filter(({ event }) => event === 'sessionLoadingWithheld').length,
      2,
      'withheld work passed its limit',
    );
    assert.deepEqual(
      written.filter(({ event }) => event !== 'sessionLoadingWithheld').map(({ event }) => event),
      ['sessionLoadingHeld', 'sessionLoadingReleased', 'sessionLoadingLine'],
      'withheld work silenced a change of the line, or the line wrote past its limit',
    );
    assert.equal(written.at(-1)?.record.limitReached, true);

    // Each post path counts its own repeats between its withheld lines.
    const counted: Record<string, unknown>[] = [];
    const repeats = new SessionLoadingLine((event, record) => {
      if (event === 'sessionLoadingWithheld') counted.push(record);
    });
    const stamp = { generation: 1, complete: false };
    const reason = (found: 'catalog missing' | 'discovery pending') => () => ({ reason: found });
    repeats.hold('scope', 1, 'render');
    repeats.withhold('render', stamp, 'scope', reason('catalog missing'));
    repeats.withhold('selection', stamp, 'scope', reason('catalog missing'));
    repeats.withhold('render', stamp, 'scope', reason('catalog missing'));
    repeats.withhold('render', stamp, 'scope', reason('catalog missing'));
    repeats.withhold('selection', stamp, 'scope', reason('discovery pending'));
    repeats.withhold('render', stamp, 'scope', reason('discovery pending'));
    assert.deepEqual(
      counted.map((record) => [record.path, record.repeats]),
      [
        ['render', 0],
        ['selection', 0],
        ['selection', 0],
        ['render', 2],
      ],
    );
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test('the startup record counts a complete discovery reply that asks for another pass as a continuation', async () => {
  const { provider } = bumpedCatalogHarness();
  const counters = new PanelPerformanceCounters(1000);
  provider.performanceCounters = counters;
  provider.claudeParents = [];
  const run = provider.progressiveWorker.run;
  let continuation = true;
  provider.progressiveWorker.run = async (request: ProgressiveRequest, generation: number) => {
    const result = await run(request, generation);
    return { ...result, value: { ...result.value, continuation } };
  };
  const signal = new AbortController().signal;
  for (const pass of [true, true, false]) {
    continuation = pass;
    provider.refreshGeneration += 1;
    await provider.prepareClaudeChildren(provider.refreshGeneration, signal);
  }
  const { continuations, publications } = counters.snapshot().discovery;
  assert.deepEqual({ continuations, publications }, { continuations: 2, publications: 1 });
});

test('incomplete discovery replies continue without a catalog refresh, and the complete reply refreshes once', async () => {
  vi.useFakeTimers();
  try {
    const { provider, discovery } = exhaustedLoadingHarness();
    const counters = new PanelPerformanceCounters(1000);
    provider.performanceCounters = counters;
    const run = provider.progressiveWorker.run;
    let replies = 0;
    let inFlight = 0;
    let mostInFlight = 0;
    provider.progressiveWorker.run = async (request: ProgressiveRequest, generation: number, signal: AbortSignal) => {
      if (request.kind !== 'claude-children') return run(request, generation, signal);
      discovery.pending = ++replies <= 10;
      mostInFlight = Math.max(mostInFlight, ++inFlight);
      // A poll waits behind the first refresh and runs when it ends, so a continuation falls due while the poll holds the slot.
      if (replies === 1) provider.refreshFrom('poll', false, true);
      try {
        const reply = await run(request, generation, signal);
        // A worker reply arrives as a task of its own, after the continuations already due.
        await new Promise((resolve) => setTimeout(resolve, 0));
        return reply;
      } finally {
        inFlight--;
      }
    };
    provider.refreshFrom('startup', true);
    const settled = () =>
      counters.snapshot().discovery.publications === 1 &&
      provider.refreshController === null &&
      provider.discoveryComplete === undefined;
    // Each step runs the timers due and the work they release. The step bound is the test's deadline.
    for (let step = 0; step < 500 && !settled(); step++) await vi.advanceTimersByTimeAsync(1);
    assert.ok(settled(), 'discovery never completed, or no refresh accepted the complete reply');
    const { discovery: counted, refreshes, refreshStages } = counters.snapshot();
    assert.equal(refreshStages.abandoned, 0, 'a refresh reached its deadline');
    assert.equal(counted.continuations, 10);
    assert.equal(mostInFlight, 1, 'a continuation sent a request while a refresh held the slot');
    assert.equal(
      refreshes['dispatch-discovery']?.count,
      1,
      'incomplete replies refreshed the whole catalog, or the complete reply did not refresh it',
    );
    // The follow-up refresh accepts the complete reply without asking discovery again.
    assert.equal(replies, 11);
    assert.equal(provider.dispatchDiscoveryPending, false);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test('a continuation that receives a complete reply asking for another pass lists its sessions before the next pass', async () => {
  vi.useFakeTimers();
  try {
    const { provider, discovery, settled } = exhaustedLoadingHarness();
    const found = {
      file: 'codex-found.jsonl',
      sessionId: 'codex-found',
      agent: 'codex',
      activity: 70,
      size: 1,
      mtimeMs: 1,
    };
    provider.titles.set(found.file, settled(found));
    // A refresh that reuses the catalog lists the held rows, which a complete reply replaced with its own.
    provider.allSessions = () => provider.catalog.sessions;
    const run = provider.progressiveWorker.run;
    let replies = 0;
    provider.progressiveWorker.run = async (request: ProgressiveRequest, generation: number, signal: AbortSignal) => {
      // The second reply completes and asks for another pass. Every later pass stays incomplete.
      discovery.pending = ++replies !== 2;
      discovery.continuation = true;
      // A walk requested meanwhile waits behind the slice.
      if (replies === 2) provider.refreshFrom('poll');
      const reply = await run(request, generation, signal);
      return replies === 2 ? { ...reply, value: { ...reply.value, roots: [...provider.partial, found] } } : reply;
    };
    provider.refreshFrom('startup', true);
    const listed = () => provider.authoritativeCatalog?.some((session: SessionFile) => session.file === found.file);
    const passedOn = () => replies > 3 && listed();
    for (let step = 0; step < 500 && !passedOn(); step++) await vi.advanceTimersByTimeAsync(1);
    assert.ok(replies > 3, 'discovery stopped after the complete reply');
    assert.ok(listed(), 'the complete reply was replaced by the next pass before the catalog listed its sessions');
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test('current discovery failures are explicit before and after catalog publication while obsolete work stays silent', async () => {
  for (const published of [false, true]) {
    const { provider } = bumpedCatalogHarness();
    provider.refreshGeneration = 4;
    provider.authoritativeCatalog = published ? provider.partial : null;
    provider.progressiveWorker.run = () => Promise.reject(new Error('unreadable source'));
    assert.equal(await provider.prepareClaudeChildren(4, new AbortController().signal), false);
    assert.equal(provider.posts.at(-1).failed, true, 'current discovery failure left loading pending');
    const posted = provider.posts.length;
    const aborted = new AbortController();
    aborted.abort();
    await provider.prepareClaudeChildren(4, aborted.signal);
    await provider.prepareClaudeChildren(3, new AbortController().signal);
    assert.equal(provider.posts.length, posted, 'cancelled or obsolete discovery became a current failure');
  }
});

test('obsolete refresh failures leave the current session-list status unchanged', async () => {
  vi.useFakeTimers();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const provider = paintHarness();
    provider.prepareRailEnrichment = async () => {
      provider.refreshGeneration++;
      throw new Error('obsolete read');
    };
    await provider.refresh(true);
    assert.equal(
      provider.posts.some((message: { failed?: boolean }) => message.failed),
      false,
    );
  } finally {
    warning.mockRestore();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test('Project cost hydration updates lifetime figures without moving sessions or selection', async () => {
  vi.useFakeTimers();
  try {
    const restored = [{ file: 'a.jsonl' }];
    const provider = projectSpendHydrationHarness(() => ({ files: restored, completeFiles: restored }));
    const row = (id: string) => ({
      id,
      label: id,
      agent: 'Claude',
      agentKey: 'claude',
      when: '',
      shown: id === 'a',
      at: 1,
      relative: '',
      agentRun: false,
    });
    provider.sessionRows = [row('a'), row('b')];
    provider.railOrder = ['a', 'b'];
    provider.showing = 'a';
    provider.sessionOutcomes = new Map([
      ['a', null],
      ['b', null],
    ]);
    provider.outcomesFor = () =>
      new Map([
        ['a', null],
        ['b', { finished: false, error: false, interrupted: false, endedAt: null }],
      ]);
    provider.railStatuses = () => ({
      statuses: sessionStatusOf([], new Set(), provider.sessionOutcomes, Date.now()),
      openChildren: new Map(),
    });
    const expected = {
      stats: { a: [{ id: 'turns', value: '4 turns' }] },
      costs: { a: { dollars: 12, partial: false } },
      contextDetails: { a: { title: 'Context', rows: [] } },
    };
    provider.lifetimeFiguresBySession = () =>
      provider.projectSpendFiles.length ? expected : { stats: {}, costs: {}, contextDetails: {} };
    provider.railInputFor = function (counts: Map<string, unknown>, statuses: Map<string, unknown>) {
      const lifetime = this.lifetimeFiguresBySession();
      return {
        sessions: this.railRows(statuses),
        counts,
        newest: new Map(),
        statuses,
        runningSince: new Map(),
        openChildren: new Map(),
        hidden: new Set(),
        showing: this.showing,
        pinnedTop: new Set(),
        unsent: new Map(),
        parsedStats: {},
        metadataStats: {},
        lifetimeStats: lifetime.stats,
        lifetimeContextDetails: lifetime.contextDetails,
        lifetimeCosts: lifetime.costs,
        labels: {},
        caches: {},
        views: [],
        railFilters: [],
        now: Date.now(),
      };
    };
    provider.useRailPayload((input: any) => ({
      rail: input.sessions.map((session: { id: string }) => ({
        id: session.id,
        status: input.statuses.get(session.id),
        cost: input.lifetimeCosts[session.id],
      })),
      stats: input.lifetimeStats,
      contextDetails: input.lifetimeContextDetails,
    }));
    provider.catalog = null;
    provider.postRail(true);
    provider.catalog = { sessions: [{ sessionId: 'a' }, { sessionId: 'b' }] };
    provider.authoritativeCatalog = provider.catalog.sessions;

    provider.scheduleProjectSpendHydration(provider.refreshGeneration);
    await vi.runAllTimersAsync();

    const hydrated = provider.rails().at(-1);
    assert.deepEqual(
      hydrated.rail.map((session: { id: string }) => session.id),
      ['a', 'b'],
    );
    assert.equal(hydrated.rail[1].status, undefined, 'a ledger-only outcome moved a session after startup');
    assert.deepEqual(hydrated.stats, expected.stats);
    assert.deepEqual(hydrated.contextDetails, expected.contextDetails);
    assert.deepEqual(hydrated.rail[0].cost, expected.costs.a);
    assert.equal(provider.showing, 'a');
  } finally {
    vi.useRealTimers();
  }
});

for (const race of ['stale generation', 'replaced workspace', 'disposed provider'] as const) {
  test(`${race} drops deferred Project cost hydration`, async () => {
    vi.useFakeTimers();
    try {
      let loads = 0;
      const provider = projectSpendHydrationHarness(() => {
        loads++;
        return { files: [], completeFiles: [] };
      });
      provider.scheduleProjectSpendHydration(provider.refreshGeneration);
      if (race === 'stale generation') {
        provider.refreshGeneration++;
      }
      if (race === 'replaced workspace') {
        provider.projectSpendWorkspace = 'elsewhere';
      }
      if (race === 'disposed provider') {
        provider.disposed = true;
      }

      await vi.runAllTimersAsync();

      assert.equal(loads, 0);
      assert.equal(provider.projectSpendHydrated, false);
    } finally {
      vi.useRealTimers();
    }
  });
}

test('a rail payload keeps its context facts through a metadata read that found none', async () => {
  const facts = {
    turns: [{ startedAt: 10, endedAt: 20, contextTokens: 120, contextWindow: 1_000_000 }],
    compactions: [],
  } as unknown as SessionStatFacts;
  const session = {
    file: 'claude.jsonl',
    sessionId: 'claude-a',
    agent: 'claude',
    activity: 100,
    size: 40,
    mtimeMs: 11,
  };
  const provider = completeDiscoveryHarness();
  provider.partial = [session];
  provider.catalog = { sessions: [session] };
  provider.discovery = Promise.resolve(true);
  const answered = {
    mtimeMs: 10,
    size: 20,
    label: 'A session',
    fullLabel: 'A session',
    activityMs: 30,
    agentRun: false,
    outcome: null,
    stats: facts,
    starts: { starts: [10], whole: true },
    foldedLabel: 'a session',
  };
  // The metadata read returns no prompt facts while the turn runs.

  const running = carryDerivedTitleFacts(answered, { ...answered, mtimeMs: 11, size: 40, stats: null });
  provider.metaFor = () => running;
  await provider.refresh(true);
  assert.deepEqual(
    provider.metadataStatsBySession['claude-a'],
    facts,
    'the context chip leaves the card while a turn runs',
  );
});

test('a refresh derives the metadata figures again only for the session whose facts changed', async () => {
  const sessions = ['a', 'b', 'c', 'd'].map((id) => ({
    file: `${id}.jsonl`,
    sessionId: id,
    agent: 'claude',
    activity: 100,
    size: 40,
    mtimeMs: 11,
  }));
  const factsOf = (label: string) => ({ turns: [], compactions: [], label }) as unknown as SessionStatFacts;
  const entries = new Map<string, { stats: SessionStatFacts; title?: string; agentRun?: boolean }>(
    sessions.map((session) => [session.file, { stats: factsOf(session.sessionId) }]),
  );
  const marks = vi.fn<typeof railCacheMarkOf>(() => null);
  const provider = completeDiscoveryHarness(undefined, false, [], {}, marks);
  const derived: unknown[] = [];
  provider.useSessionStats((facts: unknown) => {
    derived.push(facts);
    return facts;
  });
  provider.partial = sessions;
  provider.catalog = { sessions };
  provider.discovery = Promise.resolve(true);
  provider.metaFor = (session: { file: string }) => entries.get(session.file);
  await provider.refresh(true);
  assert.equal(derived.length, sessions.length);

  // One transcript grew, and its metadata read replaced that session's facts.
  const grown = factsOf('b grown');
  entries.set('b.jsonl', { stats: grown });
  derived.length = 0;
  await provider.refresh(true);
  assert.deepEqual(derived, [grown], `a refresh after one session changed derived ${derived.length} figures`);
  assert.equal(provider.metadataStatsBySession.b, grown, 'the changed session kept its old figures');

  // Title and agent-run changes replace metadata entries. Activity changes replace catalog rows. All retain the same stats objects.

  const figures = provider.metadataStatsBySession;
  entries.set('a.jsonl', { ...entries.get('a.jsonl')!, title: 'Renamed' });
  entries.set('c.jsonl', { ...entries.get('c.jsonl')!, agentRun: true });
  provider.partial = sessions.map((session) => (session.sessionId === 'd' ? { ...session, activity: 200 } : session));
  provider.catalog = { sessions: provider.partial };
  derived.length = 0;
  marks.mockClear();
  await provider.refresh(true);
  assert.deepEqual(derived, [], 'a change outside the facts derived the figures again');
  assert.equal(marks.mock.calls.length, 0, 'a change outside the facts derived the cache marks again');
  assert.equal(provider.metadataStatsBySession, figures, 'a change outside the facts replaced the figure record');

  // A session that leaves the catalog leaves the figures with it.
  provider.partial = sessions.filter((session) => session.sessionId !== 'd');
  provider.catalog = { sessions: provider.partial };
  await provider.refresh(true);
  assert.deepEqual(Object.keys(provider.metadataStatsBySession).sort(), ['a', 'b', 'c']);
  assert.deepEqual(Object.keys(provider.metadataRailCaches).sort(), ['a', 'b', 'c']);
  assert.deepEqual(derived, [], 'a session leaving the catalog derived the others again');
});

test('a rail cache mark holds through incomplete metadata and clears current failure or compaction for both agents', async () => {
  const requestAt = 1_000_000;
  const usage = { input: 1, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 };
  const cases = [
    { agent: 'claude' as const, model: 'claude-opus-5', provider: null },
    { agent: 'codex' as const, model: 'gpt-5.6-sol', provider: 'openai' },
  ];
  const clock = vi.spyOn(Date, 'now').mockReturnValue(requestAt);
  try {
    for (const { agent, model, provider: modelProvider } of cases) {
      const warmFacts = {
        turns: [
          {
            startedAt: requestAt,
            endedAt: requestAt,
            finished: true,
            error: false,
            model,
            provider: modelProvider,
            usage,
            contextTokens: 300_000,
            contextWindow: 1_000_000,
            contextRequest: {
              at: requestAt,
              lifetime: '1h' as const,
              inferenceClass: null,
              serviceTier: null,
              readBack: false,
              outputTokens: 40,
            },
            childSpendPartial: false,
          },
        ],
        compactions: [],
      } as SessionStatFacts;
      const metadata = [
        {
          name: 'an answer-filled running tail',
          entry: { stats: null, heldStats: warmFacts },
          expected: railCacheMarkOf(warmFacts),
        },
        {
          name: 'a new running turn before its first usage record',
          entry: {
            stats: {
              turns: [
                {
                  startedAt: requestAt + 1,
                  endedAt: requestAt + 1,
                  finished: false,
                  error: false,
                  model,
                  provider: modelProvider,
                  usage,
                  contextTokens: 0,
                  contextWindow: null,
                  contextRequest: null,
                  childSpendPartial: false,
                },
              ],
              compactions: [],
            } as SessionStatFacts,
            heldStats: warmFacts,
          },
          expected: railCacheMarkOf(warmFacts),
        },
        {
          name: 'a failed current turn before its first usage record',
          entry: {
            stats: {
              turns: [
                {
                  startedAt: requestAt + 1,
                  endedAt: requestAt + 1,
                  finished: true,
                  error: true,
                  model,
                  provider: modelProvider,
                  usage,
                  contextTokens: 0,
                  contextWindow: null,
                  contextRequest: null,
                  childSpendPartial: false,
                },
              ],
              compactions: [],
            } as SessionStatFacts,
            heldStats: warmFacts,
          },
          expected: null,
        },
        {
          name: 'a current compaction',
          entry: {
            stats: { turns: [], compactions: [{ at: requestAt + 1, contextAfter: 3, trigger: 'manual', model: null }] },
            heldStats: warmFacts,
          },
          expected: null,
        },
      ];
      for (const { name, entry, expected } of metadata) {
        const session = { file: `${agent}.jsonl`, sessionId: agent, agent, activity: requestAt, size: 40, mtimeMs: 11 };
        const marks = vi.fn<typeof railCacheMarkOf>(railCacheMarkOf);
        const provider = completeDiscoveryHarness(undefined, false, [], {}, marks);
        provider.partial = [session];
        provider.catalog = { sessions: [session] };
        provider.discovery = Promise.resolve(true);
        provider.metaFor = () => entry;

        await provider.refresh(true);
        assert.deepEqual(provider.metadataRailCaches[agent], expected, `${agent} handled ${name} incorrectly`);
        if (expected) {
          // The same facts and a mark that has not expired keep the held mark.
          marks.mockClear();
          await provider.refresh(true);
          assert.equal(marks.mock.calls.length, 0, `${agent} derived an unexpired mark again after ${name}`);
          assert.deepEqual(provider.metadataRailCaches[agent], expected, `${agent} lost its held mark after ${name}`);
          // The facts stay the same objects, and the clock alone expires the mark.
          clock.mockReturnValue(expected.expiresAt);
          await provider.refresh(true);
          assert.equal(provider.metadataRailCaches[agent], null, `${agent} kept an expired mark after ${name}`);
          clock.mockReturnValue(requestAt);
        }
      }
    }
  } finally {
    clock.mockRestore();
  }
});

function runningCacheTurn(requestAt: number, lifetime: '1h' | '5m') {
  return {
    sessionId: 's',
    agent: 'claude',
    startedAt: requestAt,
    endedAt: requestAt,
    finished: false,
    error: false,
    model: 'claude-opus-5',
    provider: null,
    usage: { input: 1, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
    contextTokens: 300_000,
    contextWindow: 1_000_000,
    contextRequest: {
      at: requestAt,
      lifetime,
      inferenceClass: null,
      serviceTier: null,
      readBack: false,
      outputTokens: 40,
    },
    childSpendPartial: false,
  };
}

// Refreshes a host whose selected session has a timeline window at one revision.
// Each step supplies a session list read and returns the cache marks the session list carried for the session.
async function selectedCacheMarksSent(
  now: number,
  timeline: { turns: unknown[]; revision: { mtimeMs: number; size: number } },
  steps: { revision: { mtimeMs: number; size: number }; entry: Record<string, unknown> }[],
): Promise<unknown[][]> {
  const sent: unknown[] = [];
  const marks: unknown[][] = [];
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    const provider = completeDiscoveryHarness(
      undefined,
      false,
      ['collect', 'readFor', 'railInputFor'],
      {
        railCachesOf,
        turnBudget,
        turnKey,
        currentRecordsBySession,
        groupBySession,
        unsentBySession,
        sessionRunningSince: () => new Map(),
        composerRuntimeBySession: () => new Map(),
        promptsAcross: () => [],
        prunedSentPrompts: (sent: unknown) => sent,
        statsBySession: () => ({}),
      },
      railCacheMarkOf,
    );
    Object.assign(provider, {
      turnsByKey: new Map(),
      promptsBySession: new Map(),
      sentPrompts: {},
      repositoryCommits: { apply() {} },
      trimOlderHistory() {},
      commitRepositoryTurns: (_session: unknown, turns: unknown[]) => turns,
      applyCommitRepositoryEvidence() {},
      observeParsedNames() {},
      headingTitle: () => '',
      drawTurnCards: () => [],
      railRows: () => [],
      newestTurns: () => new Map(),
    });
    provider.useRailPayload((input: { caches: Record<string, unknown> }) => {
      sent.push(input.caches.s);
      return { rail: [], labels: [], views: [], railFilters: [], stats: {} };
    });
    provider.cache.set('s.jsonl', {
      read: { turns: timeline.turns, compactions: [], readBytes: 1, turnLimitReached: false, lastReportedModel: null },
      revision: timeline.revision,
    });
    provider.discovery = Promise.resolve(true);
    provider.showing = 's';
    for (const { revision, entry } of steps) {
      const session = { file: 's.jsonl', sessionId: 's', agent: 'claude', activity: now, ...revision };
      provider.partial = [session];
      provider.catalog = { sessions: [session] };
      provider.metaFor = () => ({ ...entry, ...revision });
      sent.length = 0;
      await provider.refresh(true);
      marks.push([...sent]);
    }
  } finally {
    clock.mockRestore();
  }
  return marks;
}

test('a selected session keeps its warm cache mark while its transcript grows past the session list read', async () => {
  const now = 10_000_000;
  // The timeline window read revision 1 and holds the request of the running turn a minute ago.
  const running = runningCacheTurn(now - 60_000, '1h');
  const firstRevision = { mtimeMs: 10, size: 300_000 };
  const secondRevision = { mtimeMs: 20, size: 400_000 };
  const thirdRevision = { mtimeMs: 30, size: 410_000 };
  const warm = railCacheMarkOf({ turns: [running], compactions: [] }, now);
  assert.ok(warm);
  // The session list tail lost the prompt of the running turn. It holds an older request whose five-minute cache expired.
  const older = { turns: [runningCacheTurn(now - 10 * 60_000, '5m')], compactions: [] } as unknown as SessionStatFacts;
  assert.equal(railCacheMarkOf(older, now), null);
  const failed = {
    turns: [{ ...running, startedAt: now - 30_000, error: true, contextTokens: 0, contextRequest: null }],
    compactions: [],
  };
  const steps = [
    {
      name: 'the session list read the same revision',
      revision: firstRevision,
      entry: { stats: null, heldStats: older, heldRevision: firstRevision },
      mark: warm,
    },
    {
      name: 'the transcript grew and the session list holds older facts',
      revision: secondRevision,
      entry: { stats: null, heldStats: older, heldRevision: firstRevision },
      mark: warm,
    },
    {
      name: 'the transcript grew and the session list holds no facts',
      revision: secondRevision,
      entry: { stats: null },
      mark: warm,
    },
    {
      name: 'the session list read a failed turn the timeline window has not reached',
      revision: thirdRevision,
      entry: { stats: failed },
      mark: null,
    },
  ];
  const sent = await selectedCacheMarksSent(now, { turns: [running], revision: firstRevision }, steps);
  steps.forEach(({ name, mark }, index) => {
    assert.ok(sent[index].length, `no session list was sent after ${name}`);
    for (const caches of sent[index]) {
      assert.deepEqual(caches, mark, `the wrong cache mark went out after ${name}`);
    }
  });
});

test('a selected session keeps a warm session list mark when the facts behind it become held', async () => {
  const now = 10_000_000;
  // The timeline window read revision 1 and holds only a request whose five-minute cache expired.
  const expired = runningCacheTurn(now - 10 * 60_000, '5m');
  const firstRevision = { mtimeMs: 10, size: 300_000 };
  const secondRevision = { mtimeMs: 20, size: 400_000 };
  const thirdRevision = { mtimeMs: 30, size: 410_000 };
  // The session list read revision 2 and found a warm request the timeline window has not reached.
  const warmFacts = { turns: [runningCacheTurn(now - 60_000, '1h')], compactions: [] } as unknown as SessionStatFacts;
  const warm = railCacheMarkOf(warmFacts, now);
  assert.ok(warm);
  const pending = {
    turns: [{ ...warmFacts.turns[0], startedAt: now - 30_000, contextTokens: 0, contextRequest: null }],
    compactions: [],
  };
  const steps = [
    { name: 'the session list read a warm request', revision: secondRevision, entry: { stats: warmFacts } },
    {
      name: 'a new prompt moved the warm request into held facts',
      revision: thirdRevision,
      entry: { stats: pending, heldStats: warmFacts, heldRevision: secondRevision },
    },
    {
      name: 'the tail lost the new prompt',
      revision: thirdRevision,
      entry: { stats: null, heldStats: warmFacts, heldRevision: secondRevision },
    },
  ];
  const sent = await selectedCacheMarksSent(now, { turns: [expired], revision: firstRevision }, steps);
  steps.forEach(({ name }, index) => {
    assert.ok(sent[index].length, `no session list was sent after ${name}`);
    for (const caches of sent[index]) {
      assert.deepEqual(caches, warm, `the cache mark went out after ${name}`);
    }
  });
});

test('the lifetime figures a pass built from settled files do not outlive the pass', () => {
  const walking = { file: 'a.jsonl', complete: false };
  const settled = { file: 'a.jsonl', complete: true };
  const provider = railPostHarness(['lifetimeRailFacts', 'lifetimeDisplayFiles'], {
    sessionLifetimeDisplayFiles,
    sessionRailFactsBySession: (records: Record<string, unknown>, sources: { sessionId: string }[]) => ({
      [sources[0].sessionId]: records['a.jsonl'],
    }),
  });
  provider.lifetimeRail = new SessionFiguresCache();
  provider.sessionSpendSources = [{ sessionId: 'a', file: 'a.jsonl', primary: true }];
  provider.projectSpendRevision = 4;
  provider.projectSpendFiles = [walking];
  provider.projectSpendVisibleFiles = [settled];
  provider.projectSpendIndexing = true;
  assert.deepEqual(provider.lifetimeRailFacts(), { a: settled });
  provider.projectSpendIndexing = false;
  assert.deepEqual(
    provider.lifetimeRailFacts(),
    { a: settled },
    'incomplete replacement figures remain held after the pass ends',
  );
});

test('read saves and unchanged rail posts skip payload builds', async () => {
  const provider = railPostHarness(['saveState', 'readPrint']);
  let wordings = 0;
  provider.useRailPayload(() => ({ rail: [`wording ${wordings++}`] }));
  const rows = [
    { id: 'session-a', label: 'A' },
    { id: 'session-b', label: 'B' },
  ];
  const figures = { stats: {}, costs: {}, contextDetails: {} };
  const metadataStats = {};
  const hidden = new Set<string>();
  let inputBuilds = 0;
  // Each post receives new containers over the same rows and figures.

  provider.railInputFor = () => {
    inputBuilds++;
    return {
      sessions: [...rows],
      counts: new Map([['session-a', { count: 2, atLeast: false }]]),
      newest: new Map(),
      statuses: new Map(),
      runningSince: new Map(),
      openChildren: new Map(),
      hidden: new Set(hidden),
      showing: 'session-a',
      pinnedTop: new Set(),
      unsent: new Map(),
      parsedStats: {},
      metadataStats,
      lifetimeStats: figures.stats,
      lifetimeContextDetails: figures.contextDetails,
      lifetimeCosts: figures.costs,
      labels: {},
      caches: {},
      views: [],
      railFilters: [],
    };
  };
  const serialize = JSON.stringify;
  let railStrings = 0;
  const spy = vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown, ...rest: unknown[]) => {
    if ((value as { type?: unknown } | null)?.type === 'rail') {
      railStrings++;
    }
    return (serialize as unknown as (...args: unknown[]) => string)(value, ...rest);
  }) as typeof JSON.stringify);
  try {
    provider.postRail(false);
    assert.deepEqual([inputBuilds, wordings, railStrings, provider.rails().length], [1, 1, 1, 1]);

    await provider.readSession('session-a', 10);
    assert.deepEqual(
      [inputBuilds, wordings, railStrings],
      [1, 1, 1],
      'a real read-state save rebuilt a rail whose unread counts did not move',
    );

    provider.postRail(true);
    assert.deepEqual(
      [inputBuilds, wordings, railStrings],
      [2, 1, 1],
      'a changed source whose assembled inputs stayed equal worded or serialized the rail',
    );

    provider.postRail(false);
    assert.deepEqual(
      [inputBuilds, wordings, railStrings],
      [2, 1, 1],
      'an unchanged post rebuilt after an equal changed-source notification',
    );

    hidden.add('session-b');
    provider.postRail(true);
    assert.deepEqual(
      [inputBuilds, wordings, railStrings, provider.rails().length],
      [3, 2, 2, 2],
      'an archived session never reaches the rail, because the post compared inputs that left it out',
    );
  } finally {
    spy.mockRestore();
  }
});

test('the lifetime figures hold through a spend pass that does not move them', () => {
  vi.useFakeTimers();
  try {
    let projections = 0;
    let indexed = {
      record: { file: 'a.jsonl', complete: false, size: 1, mtimeMs: 1 } as object,
      stateChanged: false,
      complete: false,
    };
    const provider = railPostHarness(
      ['lifetimeFiguresBySession', 'lifetimeDisplayFiles', 'indexNextProjectSpendFile', 'finishProjectSpendIndex'],
      {
        sessionLifetimeDisplayFiles,
        sessionSpendPartsBySession: () => {
          projections++;
          return {};
        },
        sessionTurnStatsBySession: () => ({}),
        sessionCacheFactsBySession: () => ({}),
        normalizeSpendFile: (file: string) => file,
        spendRecordChangesRail: () => false,
        spendRecordHoldsLongLine,
        createClaudeUsageLineReducer: () => null,
        createCodexUsageLineReducer: () => null,
        invalidateSpendFileNormalization: () => {},
        indexSpendFile: () => indexed,
        fs: { statSync: () => ({ size: 2, mtimeMs: 2 }) },
      },
    );
    const settled = { file: 'a.jsonl', complete: true, size: 1, mtimeMs: 1 };
    provider.lifetimeFigures = new SessionFiguresCache();
    provider.sessionSpendSources = [{ file: 'a.jsonl', sessionId: 'session-a', primary: true }];
    provider.projectSpendFiles = [settled];
    provider.projectSpendVisibleFiles = [settled];
    provider.projectSpendRevision = 0;
    provider.projectSpendWorkspace = 'workspace';
    provider.projectSpendStorageDir = 'storage';
    provider.projectSpendQueue = [];
    provider.projectSpendQueued = new Set();
    provider.projectSpendSaveOwed = false;
    provider.scheduleProjectSpendSave = () => {};
    provider.flushProjectSpendSave = () => {};
    provider.postProjectSpend = () => {};
    const read = () => provider.lifetimeFiguresBySession();

    const first = read();
    // Every refresh queues a pass, and a pass shows the files it has settled.
    provider.projectSpendIndexing = true;
    assert.equal(read(), first, 'a spend pass starting threw away the figures it still shows');

    // A partial read advances the ledger revision while retaining settled display records.

    provider.projectSpendQueue = [{ file: 'a.jsonl', agent: 'claude', primary: true }];
    provider.indexNextProjectSpendFile();
    assert.equal(provider.projectSpendRevision, 1);
    assert.equal(read(), first, 'a half-read file threw away figures the display still draws from its settled record');
    assert.equal(projections, 1);

    // The pass settles the file, so the figures move.
    vi.clearAllTimers();
    indexed = { record: { file: 'a.jsonl', complete: true, size: 2, mtimeMs: 2 }, stateChanged: false, complete: true };
    provider.projectSpendQueue = [{ file: 'a.jsonl', agent: 'claude', primary: true }];
    provider.indexNextProjectSpendFile();
    const moved = read();
    assert.notEqual(moved, first, 'a settled file kept the figures from before it was read');
    assert.equal(projections, 2);

    // The pass ends on the files it already showed.
    vi.clearAllTimers();
    provider.finishProjectSpendIndex();
    assert.equal(provider.projectSpendIndexing, false);
    assert.equal(provider.projectSpendRevision, 3);
    assert.equal(read(), moved, 'a spend pass ending threw away the figures it had just drawn');
    assert.equal(projections, 2);

    // The transcript moves to another session.
    provider.sessionSpendSources = [{ file: 'a.jsonl', sessionId: 'session-b', primary: true }];
    read();
    assert.equal(projections, 3, 'a new source list kept figures drawn for the old one');
  } finally {
    vi.useRealTimers();
  }
});

test('one spend index pass words the rail once, however often it checkpoints', () => {
  const provider = railPostHarness(['commitProjectSpendCheckpoint', 'finishProjectSpendIndex']);
  provider.projectSpendSaveOwed = false;
  provider.projectSpendFiles = [];
  provider.projectSpendVisibleFiles = [];
  provider.projectSpendRevision = 0;
  provider.projectSpendIndexing = true;
  provider.flushProjectSpendSave = () => {};
  provider.postProjectSpend = () => {};

  for (const _checkpoint of [1, 2, 3]) {
    provider.projectSpendRailOwed = true;
    provider.commitProjectSpendCheckpoint('quiet');
  }
  assert.deepEqual(provider.rails(), [], 'every ledger settle inside a pass words the whole rail again');

  provider.finishProjectSpendIndex();
  assert.equal(provider.rails().length, 1, 'the end of the pass does not word the rail');
  assert.equal(provider.projectSpendRailOwed, false, 'the owed rail outlives the pass that asked for it');
  assert.equal(provider.projectSpendRevision, 0, 'a pass that indexed nothing throws away the held spend figures');

  provider.projectSpendIndexing = false;
  provider.projectSpendRailOwed = true;
  provider.heldLifetime = { stats: {}, costs: {}, contextDetails: {} };
  provider.commitProjectSpendCheckpoint('quiet');
  assert.equal(provider.rails().length, 2, 'a settle outside a pass never words the rail');
});

test('a failed ledger save retries on a bounded backoff and writes the newest ledger once the lock clears', () => {
  vi.useFakeTimers();
  try {
    let held = true;
    let attempts = 0;
    const written: unknown[][] = [];
    const warnings: string[] = [];
    const provider = railPostHarness(LEDGER_SAVE_METHODS, {
      ...LEDGER_SAVE_SCOPE,
      saveSpendLedger: (_storage: string, _workspace: string, files: unknown[]) => {
        attempts++;
        if (held) {
          throw heldLedgerFile();
        }
        written.push([...files]);
      },
    });
    provider.diagnostics = { ...provider.diagnostics, warn: (event: string) => warnings.push(event) };
    const record = (size: number) => ({ file: 'a.jsonl', complete: true, size, mtimeMs: size });
    provider.projectSpendWorkspace = 'project';
    provider.projectSpendStorageDir = 'storage';
    provider.projectSpendFiles = [record(1)];
    provider.projectSpendVisibleFiles = provider.projectSpendFiles;
    provider.projectSpendSaveOwed = false;
    provider.projectSpendRailOwed = false;
    provider.projectSpendIndexing = false;
    provider.performanceCounters.recordLedgerSave = () => {};
    provider.projectSpendSaveScheduler = provider.newProjectSpendSaveScheduler();

    // The last change before the agents stop, so no later change carries the save.
    provider.scheduleProjectSpendSave();
    vi.advanceTimersByTime(PROJECT_SPEND_SAVE_MS);
    assert.equal(attempts, 1);
    assert.equal(provider.projectSpendSaveOwed, true, 'a failed ledger save was dropped');
    assert.deepEqual(warnings, ['projectSpendSaveFailed'], 'a failed ledger save left no line in the diagnostics log');

    // The lock clears before the first retry.
    held = false;
    vi.advanceTimersByTime(projectSpendSaveRetryDelay(0)!);
    assert.deepEqual(written, [[record(1)]], 'no retry wrote the owed ledger after the lock cleared');
    assert.equal(provider.projectSpendSaveOwed, false);
    assert.equal(vi.getTimerCount(), 0, 'a written ledger left a retry waiting');

    // A lock that never clears gets a bounded number of tries, and then the save waits.
    held = true;
    attempts = 0;
    provider.projectSpendFiles = [record(2)];
    const changedAt = Date.now();
    provider.scheduleProjectSpendSave();
    vi.advanceTimersByTime(60 * 60 * 1_000);
    assert.equal(attempts, 1 + PROJECT_SPEND_SAVE_RETRIES, `a held ledger file was tried ${attempts} times in an hour`);
    assert.equal(vi.getTimerCount(), 0, 'a held ledger file keeps a retry timer running');
    assert.equal(provider.projectSpendSaveOwed, true, 'the spent retries dropped the owed save');
    assert.equal(
      provider.projectSpendSaveOwedSince,
      changedAt,
      'the owed save lost the age of the change it has not written',
    );

    // The next change writes the newest ledger.
    held = false;
    provider.projectSpendFiles = [record(3)];
    provider.scheduleProjectSpendSave();
    vi.advanceTimersByTime(PROJECT_SPEND_SAVE_MS);
    assert.deepEqual(written.at(-1), [record(3)], 'the save after the failures missed the newest ledger');
    assert.equal(provider.projectSpendSaveOwedSince, null);
  } finally {
    vi.useRealTimers();
  }
});

test('continuous ledger changes start at most one save in 30 seconds, and a flush still writes at once', () => {
  vi.useFakeTimers();
  try {
    const saves: number[] = [];
    const provider = railPostHarness(LEDGER_SAVE_METHODS, {
      ...LEDGER_SAVE_SCOPE,
      saveSpendLedger: () => {
        saves.push(Date.now());
      },
    });
    provider.projectSpendWorkspace = 'project';
    provider.projectSpendStorageDir = 'storage';
    provider.projectSpendFiles = [];
    provider.projectSpendVisibleFiles = [];
    provider.projectSpendSaveOwed = false;
    provider.performanceCounters.recordLedgerSave = () => {};
    provider.projectSpendSaveScheduler = provider.newProjectSpendSaveScheduler();

    // An indexing pass changes the ledger every second for 90 seconds.
    const interval = 30_000;
    const from = Date.now();
    for (let second = 0; second < 90; second++) {
      provider.scheduleProjectSpendSave();
      vi.advanceTimersByTime(1_000);
    }
    const times = saves.map((at) => at - from);
    assert.equal(
      saves.length,
      3,
      `90 seconds of changes started ${saves.length} saves, the first at ${times.slice(0, 3).join(', ')} ms`,
    );
    times.forEach((at, index) => {
      const gap = at - (index ? times[index - 1] : 0);
      assert.ok(gap >= interval, `a save started ${gap} ms after the one before it`);
      assert.ok(gap <= interval, `a change waited ${gap} ms for a save, so a crash loses more than 30 seconds`);
    });

    // Disposal and a workspace change write an owed save without the wait.
    provider.scheduleProjectSpendSave();
    provider.flushProjectSpendSave();
    assert.equal(saves.length, 4, 'a flush waited for the save interval');
  } finally {
    vi.useRealTimers();
  }
});

test('a source of long lines leaves the queue front after each line, and one record holds a long line', () => {
  vi.useFakeTimers();
  try {
    const folder = tempDir('spend-long-lines');
    // Each source holds three lines of 600 KiB, and each slice reads 256 KiB.
    const sources = ['a', 'b'].map((name) => {
      const file = path.join(folder, `${name}.jsonl`);
      fs.writeFileSync(file, `{"pad":"${name.repeat(600 * 1024)}"}\n`.repeat(3));
      return file;
    });
    const [first, second] = sources.map(normalizeSpendFile);
    const provider = railPostHarness(['indexNextProjectSpendFile'], {
      normalizeSpendFile,
      spendRecordChangesRail: () => false,
      spendRecordHoldsLongLine,
      releaseSpendHeldLine,
      invalidateSpendFileNormalization: () => {},
      createClaudeUsageLineReducer: () => null,
      // The reducer state counts the lines read, so a line read twice or skipped changes the count.
      createCodexUsageLineReducer: (state: number | undefined) => {
        let lines = state ?? 0;
        return {
          pushLine: () => {
            lines++;
            return [];
          },
          snapshot: () => lines,
        };
      },
      indexSpendFile: (previous: never, file: string, workspace: string, makeReducer: never) =>
        indexSpendFile(previous, file, workspace, makeReducer, { maxBytes: 256 * 1024, now: () => 0 }),
      fs,
    });
    provider.projectSpendWorkspace = 'workspace';
    provider.projectSpendStorageDir = 'storage';
    provider.projectSpendFiles = [];
    provider.projectSpendRevision = 0;
    provider.projectSpendQueue = sources.map((file) => ({ file, agent: 'codex', primary: true }));
    provider.projectSpendQueued = new Set([first, second]);
    provider.projectSpendRailOwed = false;
    provider.scheduleProjectSpendSave = () => {};
    const record = (file: string) => provider.projectSpendFiles.find((entry: { file: string }) => entry.file === file);
    let slices = 0;
    let secondSliceAt: number | null = null;
    let firstDoneAt: number | null = null;
    let reordered = false;
    while (provider.projectSpendQueue.length && slices < 100) {
      const file = normalizeSpendFile(provider.projectSpendQueue[0].file);
      provider.indexNextProjectSpendFile();
      vi.clearAllTimers();
      slices++;
      if (file === second) secondSliceAt ??= slices;
      if (file === first && record(first).complete !== false) firstDoneAt ??= slices;
      const holding = provider.projectSpendFiles.filter(spendRecordHoldsLongLine).length;
      assert.ok(holding <= 1, `slice ${slices} left ${holding} records that hold a long line`);
      // A history change offers the sources again in source order, so a queued source can pass the one at the front.
      if (
        !reordered &&
        file === second &&
        spendRecordHoldsLongLine(record(second)) &&
        provider.projectSpendQueue.length > 1
      ) {
        provider.projectSpendQueue.reverse();
        reordered = true;
      }
    }
    assert.ok(secondSliceAt !== null && firstDoneAt !== null, `the queue did not drain in ${slices} slices`);
    assert.ok(
      secondSliceAt < firstDoneAt,
      `the second source waited for slice ${secondSliceAt}, after the first source ended at slice ${firstDoneAt}`,
    );
    for (const file of [first, second]) {
      assert.equal(record(file).complete, true);
      assert.equal(record(file).parserState, 3, `${file} read ${record(file).parserState} of its 3 lines`);
    }
  } finally {
    vi.useRealTimers();
  }
});

test('a pass that ends after a scheduled save owes the ledger the displayed files it moved', () => {
  vi.useFakeTimers();
  try {
    const written: { files: unknown[]; visible: unknown[] }[] = [];
    const provider = railPostHarness(['finishProjectSpendIndex', ...LEDGER_SAVE_METHODS], {
      ...LEDGER_SAVE_SCOPE,
      saveSpendLedger: (_storage: string, _workspace: string, files: unknown[], visible: unknown[]) => {
        written.push({ files: [...files], visible: [...visible] });
      },
    });
    const record = (size: number) => ({ file: 'a.jsonl', complete: true, size, mtimeMs: size });
    provider.projectSpendWorkspace = 'project';
    provider.projectSpendStorageDir = 'storage';
    provider.projectSpendFiles = [record(1)];
    provider.projectSpendVisibleFiles = provider.projectSpendFiles.slice();
    provider.projectSpendRevision = 0;
    provider.projectSpendSaveOwed = false;
    provider.projectSpendRailOwed = false;
    provider.projectSpendIndexing = true;
    provider.postProjectSpend = () => {};
    provider.performanceCounters.recordLedgerSave = () => {};
    provider.projectSpendSaveScheduler = provider.newProjectSpendSaveScheduler();

    // The pass reads the grown transcript, and the scheduler saves before the pass ends.
    provider.projectSpendFiles = [record(2)];
    provider.scheduleProjectSpendSave();
    vi.advanceTimersByTime(PROJECT_SPEND_SAVE_MAX_MS);
    assert.deepEqual(written.at(-1), { files: [record(2)], visible: [record(1)] });

    provider.finishProjectSpendIndex();
    vi.advanceTimersByTime(PROJECT_SPEND_SAVE_MAX_MS);
    assert.deepEqual(
      written.at(-1),
      { files: [record(2)], visible: [record(2)] },
      'the saved ledger kept the displayed files the pass replaced',
    );
  } finally {
    vi.useRealTimers();
  }
});

test('a rail post words the rail again when an input held by identity is replaced', () => {
  const provider = railPostHarness([]);
  const row = (id: string) => ({
    id,
    label: id,
    agent: 'Claude',
    agentKey: 'claude',
    when: '',
    shown: false,
    at: 1,
    relative: '',
    agentRun: false,
  });
  const [a, b] = [row('session-a'), row('session-b')];
  provider.sessionRows = [a, b];
  provider.postRail(false);
  assert.equal(provider.rails().length, 1);

  // A new list containing the same rows retains the posted session list.
  provider.sessionRows = [a, b];
  provider.postRail(true);
  assert.equal(provider.rails().length, 1, 'a new list over the same rows worded the rail again');

  // Each replacement carries the same contents, so only a comparison by identity sees it.
  const replacements: [string, () => void][] = [
    [
      'a session row',
      () => {
        provider.sessionRows = [a, { ...b }];
      },
    ],
    [
      'a session added',
      () => {
        provider.sessionRows = [...provider.sessionRows, row('session-c')];
      },
    ],
    [
      'the metadata stat records',
      () => {
        provider.metadataStatsBySession = {};
      },
    ],
    [
      'the lifetime stat records',
      () => {
        provider.heldLifetime = { ...provider.heldLifetime, stats: {} };
      },
    ],
    [
      'the lifetime costs',
      () => {
        provider.heldLifetime = { ...provider.heldLifetime, costs: {} };
      },
    ],
    [
      'the lifetime context details',
      () => {
        provider.heldLifetime = { ...provider.heldLifetime, contextDetails: {} };
      },
    ],
  ];
  for (const [at, [name, replace]] of replacements.entries()) {
    replace();
    provider.postRail(true);
    assert.equal(provider.rails().length, at + 2, `the panel kept a stale rail after ${name} was replaced`);
  }
});

test('a spend pass that settles a new cost posts a rail with that cost', () => {
  let coverage = { main: false, delegated: false, delegatedScopeIds: new Set<string>() };
  const cost = (dollars: number) => ({ file: 'a.jsonl', complete: true, size: dollars, mtimeMs: dollars, dollars });
  const provider = railPostHarness(
    ['commitProjectSpendCheckpoint', 'finishProjectSpendIndex', 'lifetimeFiguresBySession', 'lifetimeDisplayFiles'],
    {
      sessionLifetimeDisplayFiles,
      sessionSpendPartsBySession: (
        files: { dollars: number }[],
        _sources: unknown,
        _awaiting: unknown,
        _pending: unknown,
        scopes: Map<string, typeof coverage>,
      ) => {
        scopes.set('session-a', coverage);
        return { 'session-a': files.map((file) => ({ bucket: { usage: file.dollars }, role: 'primary' })) };
      },
      sessionTurnStatsBySession: () => ({}),
      sessionCacheFactsBySession: () => ({}),
      sessionCostUsageOf: (part: { bucket: { usage: number } }) => ({ usage: part.bucket.usage }),
      sessionCostProjection: (parts: { usage: number }[], scopes: typeof coverage) => ({
        stats: [],
        total: { dollars: parts.reduce((sum, part) => sum + part.usage, 0), partial: scopes.main || scopes.delegated },
      }),
      sessionTurnStats: () => [],
      sessionCacheExpiryStats: () => [],
      sessionCompactionContextDetail: () => null,
    },
  );
  provider.useRailPayload(railPayload);
  provider.lifetimeFigures = new SessionFiguresCache();
  provider.sessionSpendSources = [{ file: 'a.jsonl', sessionId: 'session-a', primary: true }];
  provider.sessionRows = [
    {
      id: 'session-a',
      label: 'A',
      agent: 'Claude',
      agentKey: 'claude',
      when: '',
      shown: true,
      at: 1,
      relative: '',
      agentRun: false,
    },
  ];
  provider.projectSpendSaveOwed = false;
  provider.projectSpendRevision = 0;
  provider.flushProjectSpendSave = () => {};
  provider.scheduleProjectSpendSave = () => {};
  provider.postProjectSpend = () => {};
  // The pass is walking the file to a new total, and the display still draws the settled one.
  provider.projectSpendIndexing = true;
  provider.projectSpendVisibleFiles = [cost(1)];
  provider.projectSpendFiles = [{ ...cost(2), complete: false }];
  provider.postRail(false);
  const costOf = () => provider.rails().at(-1).rail[0].costDollars;
  assert.equal(costOf(), 1);

  // The pass settles the file, and the rail it owes waits for the end of the pass.
  provider.projectSpendFiles = [cost(2)];
  provider.projectSpendRailOwed = true;
  provider.finishProjectSpendIndex();
  assert.equal(provider.rails().length, 2, 'the end of the pass kept the rail it drew before the pass');
  assert.equal(costOf(), 2);
  for (const [main, delegated] of [
    [true, false],
    [false, true],
    [true, true],
  ]) {
    coverage = { main, delegated, delegatedScopeIds: new Set() };
    provider.projectSpendFiles = [cost(2)];
    provider.projectSpendVisibleFiles = provider.projectSpendFiles;
    provider.postRail(true);
    assert.equal(provider.rails().at(-1).rail[0].costAtLeast, true);
  }
});

test('running agents that only grow their transcripts start no refresh from a spend pass and save on the maximum wait', async () => {
  vi.useFakeTimers();
  try {
    // Three sessions append while five remain idle. The simulated disk supplies current stats and complete reads.

    const growing = ['a.jsonl', 'b.jsonl', 'c.jsonl'];
    const idle = Array.from({ length: 5 }, (_, at) => `idle-${at}.jsonl`);
    const sessionOf = (file: string) => file.replace('.jsonl', '');
    const disk = new Map([...growing, ...idle].map((file) => [file, { size: 1, mtimeMs: Date.now() }]));
    let saves = 0;
    // The sessions each calculation reads, one entry for each session it recalculates.
    const lifetimeRecalculated: string[] = [];
    const railRecalculated: string[] = [];
    const sessionsOf = (sources: { sessionId: string }[]) => [...new Set(sources.map((source) => source.sessionId))];
    const changes: number[] = [];
    const saved: { at: number; changes: number }[] = [];
    const provider = railPostHarness(
      [
        'hydrateProjectSpend',
        'scheduleProjectSpendIndex',
        'queueProjectSpendIndex',
        'indexNextProjectSpendFile',
        'finishProjectSpendIndex',
        'postRailIfSpendPendingMoved',
        'projectSpendHolds',
        'projectSpendBusy',
        'projectSpendSources',
        'projectSpendHistoryCutoff',
        ...LEDGER_SAVE_METHODS,
        'lifetimeFiguresBySession',
        'lifetimeRailFacts',
        'lifetimeDisplayFiles',
        'outcomesFor',
      ],
      {
        ...LEDGER_SAVE_SCOPE,
        loadSpendLedger: () => ({ files: [], completeFiles: [] }),
        discoverCodexSpendSources: () => [],
        normalizeSpendFile: (file: string) => file,
        spendRecordAgent: () => 'claude',
        spendFileIsClaudeChild: () => false,
        invalidateSpendFileNormalization: () => {},
        projectSpendOfferDecision,
        projectSpendHistoryCutoff,
        spendRecordChangesRail,
        spendRecordHoldsLongLine,
        createClaudeUsageLineReducer: () => null,
        createCodexUsageLineReducer: () => null,
        fs: {
          promises: { stat: async (file: string) => ({ ...disk.get(file)! }) },
          statSync: (file: string) => {
            const stat = disk.get(file);
            assert.ok(stat, `the indexer stated ${file}, which no agent writes`);
            return { ...stat };
          },
        },
        indexSpendFile: (_previous: unknown, file: string) => {
          changes.push(Date.now());
          return {
            record: {
              file,
              complete: true,
              ...disk.get(file),
              lifetimeBuckets: [],
              turnCount: null,
              compactionCount: null,
              firstTurnAt: null,
              lastTurnAt: null,
              newestTurnStartedAt: null,
              outcome: null,
              cacheExpiry: null,
              parserGeneration: PROJECT_SPEND_PARSER_GENERATION,
            },
            stateChanged: true,
            complete: true,
          };
        },
        saveSpendLedger: () => {
          saves++;
          // The save writes every change read so far.
          saved.push({ at: Date.now(), changes: changes.length });
        },
        sessionLifetimeDisplayFiles,
        sessionSpendPartsBySession: (_files: unknown, sources: { sessionId: string }[]) => {
          lifetimeRecalculated.push(...sessionsOf(sources));
          return {};
        },
        sessionRailFactsBySession: (_records: unknown, sources: { sessionId: string }[]) => {
          railRecalculated.push(...sessionsOf(sources));
          return {};
        },
        sessionTurnStatsBySession: () => ({}),
        sessionCacheFactsBySession: () => ({}),
      },
    );
    provider.disposed = false;
    provider.projectSpendWorkspace = 'project';
    provider.projectSpendStorageDir = 'storage';
    provider.projectSpendHydrated = false;
    provider.projectSpendHydrationReady = true;
    provider.projectSpendRevision = 0;
    provider.projectSpendFiles = [];
    provider.projectSpendVisibleFiles = [];
    provider.projectSpendQueue = [];
    provider.projectSpendQueued = new Set();
    provider.projectSpendTick = null;
    provider.projectSpendSaveOwed = false;
    provider.projectSpendRailOwed = false;
    provider.claudeSpendSources = [...disk.keys()].map((file) => ({ file, primary: true }));
    provider.codexSpendSources = [];
    provider.codexSubagents = [];
    provider.sessionSpendSources = [...disk.keys()].map((file) => ({
      sessionId: sessionOf(file),
      file,
      primary: true,
    }));
    provider.lifetimeFigures = new SessionFiguresCache();
    provider.lifetimeRail = new SessionFiguresCache();
    // The catalog supplies outcomes for session list fact projection.
    provider.catalog = { sessions: [] };
    provider.scheduleProjectSpendMidnight = () => {};
    provider.performanceCounters.recordLedgerSave = () => {};
    provider.projectSpendSaveScheduler = provider.newProjectSpendSaveScheduler();
    // The refresh stub offers every transcript at its current size. Unrequested refreshes identify indexing-triggered work.

    let watching = false;
    let passRefreshes = 0;
    provider.refresh = () => {
      if (!watching) {
        passRefreshes++;
      }
      provider.scheduleProjectSpendIndex(new Map([...disk].map(([file, stat]) => [file, { ...stat }])), null);
      return Promise.resolve();
    };

    // Startup restores the ledger, and its first pass reads every transcript once.
    provider.hydrateProjectSpend('project', provider.refreshGeneration, null);
    // No agent writes yet, so every timer left is the pass and the ledger save it offered.
    await vi.runAllTimersAsync();
    assert.equal(provider.projectSpendBusy(), false, 'the first pass after the ledger was restored never settled');
    assert.equal(
      passRefreshes,
      0,
      `the first pass after the ledger was restored started ${passRefreshes} full refreshes`,
    );

    // Each simulated append triggers one refresh. The three agents append every 300 ms, offset by 100 ms.

    let events = 0;
    for (const [at, file] of growing.entries()) {
      setTimeout(() => {
        const append = () => {
          const stat = disk.get(file)!;
          disk.set(file, { size: stat.size + 100, mtimeMs: Date.now() });
          events++;
          watching = true;
          void provider.refresh(false);
          watching = false;
        };
        append();
        setInterval(append, 300);
      }, at * 100);
    }
    // Three maximum waits, so the count check covers more than one save.
    const seconds = (3 * PROJECT_SPEND_SAVE_MAX_MS) / 1_000;
    const [savesBefore, changesBefore] = [saves, changes.length];
    const [lifetimeBefore, railBefore] = [lifetimeRecalculated.length, railRecalculated.length];
    const appendsFrom = Date.now();
    await vi.advanceTimersByTimeAsync(seconds * 1_000);
    const perSecond = (count: number) => (count / seconds).toFixed(1);
    assert.ok(events >= seconds * 9, `the agents appended only ${events} times`);
    assert.equal(
      passRefreshes,
      0,
      `with the stub refresh, spend passes that only grew a transcript started ${perSecond(passRefreshes)} ` +
        `full refreshes a second beside ${perSecond(events)} watcher refreshes, with ` +
        `${perSecond(saves - savesBefore)} ledger saves and ` +
        `${perSecond(lifetimeRecalculated.length - lifetimeBefore)} lifetime figure recalculations a second`,
    );
    // Changed transcripts recalculate only their own figures and session list facts, at most once per change.

    const recordChanges = changes.length - changesBefore;
    for (const [figures, recalculated] of [
      ['lifetime figures', lifetimeRecalculated.slice(lifetimeBefore)],
      ['rail facts', railRecalculated.slice(railBefore)],
    ] as const) {
      assert.deepEqual(
        recalculated.filter((session) => !growing.map(sessionOf).includes(session)),
        [],
        `appends to ${growing.length} transcripts recalculated the ${figures} of idle sessions`,
      );
      assert.deepEqual(
        [...new Set(recalculated)].sort(),
        growing.map(sessionOf),
        `the ${figures} never read a grown session`,
      );
      assert.ok(
        recalculated.length <= recordChanges,
        `${recordChanges} record changes recalculated the ${figures} of ${recalculated.length} sessions`,
      );
    }
    // Continuous appends reset the quiet wait, so the maximum wait schedules saves.
    const count = saves - savesBefore;
    const allowed = (seconds * 1_000) / PROJECT_SPEND_SAVE_MAX_MS;
    assert.ok(
      count >= 1 && count <= allowed,
      `over ${seconds} seconds of appends the ledger saved ${count} times, and the save scheduler allows 1 to ${allowed}`,
    );
    // Check save delays only for changes whose maximum wait has elapsed.

    const late = changes.flatMap((at, index) => {
      if (at < appendsFrom || at > Date.now() - PROJECT_SPEND_SAVE_MAX_MS) {
        return [];
      }
      const save = saved.find((entry) => entry.changes > index);
      const wait = save ? save.at - at : Infinity;
      return wait > PROJECT_SPEND_SAVE_MAX_MS ? [`${wait} ms after ${at - appendsFrom} ms`] : [];
    });
    assert.deepEqual(late, [], `ledger saves waited longer than ${PROJECT_SPEND_SAVE_MAX_MS} ms after a change`);
  } finally {
    vi.useRealTimers();
  }
});

test('a rail post words the rail again when midnight moves a running start to yesterday', () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date(2026, 8, 16, 23, 30));
    const provider = railPostHarness([]);
    provider.useRailPayload(railPayload);
    const start = new Date(2026, 8, 16, 23, 0).getTime();
    provider.sessionRows = [
      {
        id: 'session-a',
        label: 'A',
        agent: 'Claude',
        agentKey: 'claude',
        when: '',
        shown: true,
        at: start,
        relative: '',
        agentRun: false,
      },
    ];
    provider.runningSince = () => new Map([['session-a', start]]);
    const gather = provider.railInputFor.bind(provider);
    provider.railInputFor = (counts: unknown) => gather(counts, new Map([['session-a', 'running']]));
    const since = () => provider.rails().at(-1).rail[0].runningSinceWhen;
    provider.postRail(false);
    assert.equal(since(), '11:00 PM');

    vi.setSystemTime(new Date(2026, 8, 16, 23, 45));
    provider.postRail(false);
    assert.equal(provider.rails().length, 1, 'the same day worded the rail again over unmoved inputs');

    vi.setSystemTime(new Date(2026, 8, 17, 0, 10));
    provider.postRail(false);
    assert.equal(provider.rails().length, 2, 'a running start kept reading as today after midnight');
    assert.equal(since(), 'Sep 16 11:00 PM');
  } finally {
    vi.useRealTimers();
  }
});

test('background spend publishes Claude usage only after native children finish indexing', async () => {
  const folder = tempDir('startup-background-cost-');
  const parent = path.join(folder, 'parent.jsonl');
  const child = path.join(folder, 'child.jsonl');
  const at = new Date(2026, 9, 4, 12).toISOString();
  fs.writeFileSync(
    parent,
    JSON.stringify({ type: 'progress', timestamp: at }) +
      '\n' +
      JSON.stringify(
        claudeCostState(
          {
            'claude-haiku-4-5': {
              inputTokens: 100,
              outputTokens: 0,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
          },
          1,
          'parent',
        ),
      ) +
      '\n',
  );
  const record = indexSpendFile(undefined, parent, 'workspace', createClaudeUsageLineReducer, 1, {
    maxMilliseconds: Infinity,
  }).record;
  const provider = completeDiscoveryHarness(undefined, false, ['indexNextClaudeCostState'], {
    costStateDependency,
    costStateIdentity,
    reconcileClaudeCostState,
    claudeCostStateDependencies,
    normalizeSpendFile,
    createClaudeUsageLineReducer,
  });
  provider.projectSpendFiles = [record];
  provider.projectSpendRevision = 0;
  provider.projectSpendCostQueue = null;
  provider.claudeSpendSources = [
    { sessionId: 'parent', file: parent, primary: true },
    { sessionId: 'parent', file: child, primary: false },
  ];
  provider.scheduleProjectSpendSave = vi.fn<() => void>();
  provider.claudeChildrenDiscovered = false;
  assert.equal(provider.indexNextClaudeCostState(), false);
  provider.claudeChildrenDiscovered = true;
  assert.equal(provider.indexNextClaudeCostState(), false);
  assert.equal(provider.projectSpendFiles[0].costStateSupplement, undefined);
  const answer = (input: number) => ({
    type: 'assistant',
    isSidechain: true,
    timestamp: at,
    // Claude Code gives each rewrite of a growing response its own uuid.
    uuid: `child-${input}`,
    message: { id: 'child', model: 'claude-haiku-4-5', usage: { input_tokens: input, output_tokens: 0 } },
  });
  fs.writeFileSync(child, JSON.stringify(answer(20)) + '\n');
  const factory = (state: Parameters<typeof createClaudeUsageLineReducer>[0]) =>
    createClaudeUsageLineReducer(state, { childTranscript: true });
  provider.projectSpendFiles.push(
    indexSpendFile(undefined, child, 'workspace', factory, 1, { maxMilliseconds: Infinity }).record,
  );
  provider.projectSpendCostQueue = null;
  // A frozen clock gives each cost-state slice its whole time budget, as on an idle machine.
  let frozen = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
  await vi.waitFor(() => {
    provider.indexNextClaudeCostState();
    assert.ok(provider.projectSpendFiles[0].costStateSupplement);
  });
  frozen.mockRestore();
  assert.equal(provider.projectSpendFiles[0].costStateSupplement.lifetime[0].usage.input, 80);
  const total = () =>
    sessionSpendPartsBySession(provider.projectSpendFiles, provider.claudeSpendSources).parent.reduce(
      (sum, part) => sum + part.bucket.usage.input,
      0,
    );
  assert.equal(total(), 100);
  fs.appendFileSync(child, JSON.stringify(answer(40)) + '\n');
  provider.projectSpendFiles[1] = indexSpendFile(provider.projectSpendFiles[1], child, 'workspace', factory, 2, {
    maxMilliseconds: Infinity,
  }).record;
  assert.equal(total(), 40);
  provider.projectSpendCostQueue = null;
  frozen = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
  await vi.waitFor(() => {
    provider.indexNextClaudeCostState();
    assert.equal(provider.projectSpendFiles[0].costStateSupplement?.lifetime[0]?.usage.input, 60);
  });
  frozen.mockRestore();
  assert.equal(total(), 100);
  assert.ok(provider.scheduleProjectSpendSave.mock.calls.length > 0);
});

test('native non-primary accounting owners publish before ancestors across delayed slices and persisted restart', () => {
  const folder = tempDir('startup-native-accounting-');
  const at = new Date(2026, 9, 4, 12).toISOString();
  const model = 'claude-haiku-4-5';
  const owner = path.join(folder, 'root.jsonl');
  const child = path.join(folder, 'root', 'subagents', 'agent-child.jsonl');
  const grandchild = path.join(folder, 'grandchild.jsonl');
  const sibling = path.join(folder, 'root', 'subagents', 'agent-sibling.jsonl');
  fs.mkdirSync(path.dirname(child), { recursive: true });
  const answer = (id: string, input: number) => ({
    type: 'assistant',
    isSidechain: true,
    timestamp: at,
    uuid: id,
    message: { id, model, usage: { input_tokens: input, output_tokens: 0 } },
  });
  const counter = (input: number) =>
    claudeCostState(
      { [model]: { inputTokens: input, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
      1,
      'root',
    );
  fs.writeFileSync(
    owner,
    [{ type: 'progress', timestamp: at }, counter(200)].map((record) => JSON.stringify(record)).join('\n') + '\n',
  );
  fs.writeFileSync(
    child,
    [answer('child', 100), counter(140)].map((record) => JSON.stringify(record)).join('\n') + '\n',
  );
  fs.writeFileSync(sibling, JSON.stringify(answer('sibling', 10)) + '\n');
  fs.writeFileSync(
    grandchild,
    JSON.stringify(answer('grandchild', 20)) +
      '\n' +
      Array.from({ length: 20 }, () => JSON.stringify({ type: 'progress', text: 'x'.repeat(64 * 1024) })).join('\n') +
      '\n',
  );
  const nativeSources = discoverClaudeSessionSpendSources([{ sessionId: 'root', file: owner }]);
  assert.equal(nativeSources.find((source) => source.file === child)?.primary, false);
  const sources = new SessionSpendSourceIndex().update(
    nativeSources,
    [
      { sessionId: 'native-child', file: child, parentSessionId: 'root' },
      { sessionId: 'native-grandchild', file: grandchild, parentSessionId: 'native-child' },
    ],
    [],
    [],
    { files: () => [] },
  );
  const records = [owner, child, sibling, grandchild].map(
    (file) =>
      indexSpendFile(
        undefined,
        file,
        'workspace',
        (state) => createClaudeUsageLineReducer(state as ClaudeUsageReducerState, { childTranscript: file !== owner }),
        1,
        { maxMilliseconds: Infinity, maxBytes: Infinity },
      ).record,
  );
  assert.deepEqual(
    claudeCostStateDependencies(
      sources.find((source) => source.file === child)!,
      sources,
      records,
    )!.map((file) => file.file),
    [normalizeSpendFile(child), normalizeSpendFile(grandchild)],
  );
  const make = (files: typeof records) => {
    const provider = completeDiscoveryHarness(undefined, false, ['indexNextClaudeCostState'], {
      costStateDependency,
      costStateIdentity,
      reconcileClaudeCostState,
      claudeCostStateDependencies,
      normalizeSpendFile,
      createClaudeUsageLineReducer,
    });
    provider.projectSpendFiles = files;
    provider.projectSpendRevision = 0;
    provider.projectSpendCostQueue = null;
    provider.claudeSpendSources = nativeSources;
    provider.sessionSpendSources = sources;
    provider.scheduleProjectSpendSave = vi.fn<() => void>();
    provider.claudeChildrenDiscovered = true;
    return provider;
  };
  let provider = make(records);
  // A frozen clock gives the cost-state slice its whole time budget, as on an idle machine.
  const frozen = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
  assert.equal(provider.indexNextClaudeCostState(), true);
  frozen.mockRestore();
  const childRecord = provider.projectSpendFiles.find(
    (file: SpendFileIndex) => file.file === normalizeSpendFile(child),
  );
  assert.equal(childRecord.costStateSupplement, undefined);
  assert.ok(childRecord.costStateProgress.offset > 0);
  const rootRecord = provider.projectSpendFiles.find((file: SpendFileIndex) => file.file === normalizeSpendFile(owner));
  const pending = reconcileClaudeCostState(
    (rootRecord.parserState as ClaudeUsageReducerState).costState!,
    claudeCostStateDependencies(sources[0], sources, provider.projectSpendFiles)!,
    (state) =>
      createClaudeUsageLineReducer(state as ClaudeUsageReducerState, {
        childTranscript: true,
        retainAllRequests: true,
      }),
    undefined,
    { maxMilliseconds: Infinity },
  );
  assert.equal(pending.complete, false);
  assert.equal(pending.progress.reason, undefined);
  rootRecord.costStateProgress = pending.progress;
  const store = tempDir('startup-native-accounting-ledger-');
  saveSpendLedger(store, 'workspace', provider.projectSpendFiles);
  const persisted = loadSpendLedger(store, 'workspace');
  assert.equal(persisted.files.length, 4);
  provider = make(persisted.files);
  for (
    let turn = 0;
    turn < 200 &&
    !provider.projectSpendFiles.find((file: SpendFileIndex) => file.file === normalizeSpendFile(owner))
      .costStateSupplement;
    turn++
  )
    provider.indexNextClaudeCostState();
  const root = provider.projectSpendFiles.find((file: SpendFileIndex) => file.file === normalizeSpendFile(owner));
  const publishedChild = provider.projectSpendFiles.find(
    (file: SpendFileIndex) => file.file === normalizeSpendFile(child),
  );
  assert.equal(publishedChild.costStateSupplement.lifetime[0].usage.input, 20);
  assert.equal(root.costStateSupplement.lifetime[0].usage.input, 50);
  const parts = sessionSpendPartsBySession(provider.projectSpendFiles, sources).root;
  assert.equal(
    parts.reduce((sum, part) => sum + part.bucket.usage.input, 0),
    200,
  );
  assert.equal(root.mtimeMs, records[0].mtimeMs);
  const previousIdentity = root.costStateSupplement.identity;
  provider.sessionSpendSources = sources.map((source) =>
    source.file === grandchild ? { ...source, nativeParentFile: sibling } : source,
  );
  provider.projectSpendFiles = invalidateClaudeCostSupplements(
    provider.projectSpendFiles,
    provider.sessionSpendSources,
  );
  provider.projectSpendCostQueue = null;
  assert.equal(
    provider.projectSpendFiles.find((file: SpendFileIndex) => file.file === normalizeSpendFile(child))
      .costStateSupplement,
    undefined,
  );
  for (let turn = 0; turn < 200; turn++) {
    provider.indexNextClaudeCostState();
    const updated = provider.projectSpendFiles.find((file: SpendFileIndex) => file.file === normalizeSpendFile(owner));
    if (updated.costStateSupplement && updated.costStateSupplement.identity !== previousIdentity) break;
  }
  const updated = provider.projectSpendFiles.find((file: SpendFileIndex) => file.file === normalizeSpendFile(owner));
  assert.equal(updated.costStateSupplement.lifetime[0].usage.input, 30);
  assert.equal(
    provider.projectSpendFiles.find((file: SpendFileIndex) => file.file === normalizeSpendFile(child))
      .costStateSupplement.lifetime[0].usage.input,
    40,
  );
  assert.equal(
    sessionSpendPartsBySession(provider.projectSpendFiles, provider.sessionSpendSources).root.reduce(
      (sum, part) => sum + part.bucket.usage.input,
      0,
    ),
    200,
  );
});

test('finite delegated reads publish the startup catalog while repeated catalog deadlines and polls continue', async () => {
  const directory = tempDir('startup-delegated-deadlines-');
  const id = 'aaaaaaaa-1111-1111-1111-111111111111';
  const parentFile = path.join(directory, 'parent.jsonl');
  const childFile = path.join(directory, id + '.jsonl');
  const record = (type: string, payload: object) =>
    JSON.stringify({ type, timestamp: '2026-01-01T00:00:01Z', payload }) + '\n';
  fs.writeFileSync(
    parentFile,
    claudeDispatchTranscript(
      'python child.py --arc-dispatch',
      `ARC_DISPATCH_SESSION={"agent":"codex","session_id":"${id}","owned":true}`,
    )
      .map((value) => JSON.stringify(value) + '\n')
      .join(''),
  );
  fs.writeFileSync(
    childFile,
    record('session_meta', { id, cwd: directory, source: 'exec' }) +
      record('event_msg', { type: 'task_started', turn_id: 'work' }) +
      record('turn_context', { turn_id: 'work', model: 'gpt-6.1-sol' }) +
      record('event_msg', { type: 'user_message', message: 'work' }) +
      Array.from({ length: 64 }, () => record('ignored', { text: 'x'.repeat(65500) })).join('') +
      record('event_msg', {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
          total_token_usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
        },
      }) +
      record('event_msg', { type: 'task_complete', turn_id: 'work' }),
  );
  const session = (file: string, sessionId: string, agent: 'claude' | 'codex') => ({
    file,
    sessionId,
    agent,
    ...revisionOf(fs.statSync(file, { bigint: true })),
    activity: 1,
  });
  const parent = session(parentFile, 'parent', 'claude'),
    child = session(childFile, id, 'codex');
  const { provider, claudeWalk, codexWalk } = bumpedCatalogHarness();
  (claudeWalk as SessionFile[]).splice(0, claudeWalk.length, parent);
  (codexWalk as SessionFile[]).splice(0, codexWalk.length, child);
  Object.assign(provider, {
    repositoryScopeRoots: [directory],
    repositoryScope: { snapshot: () => ({ ready: true, roots: [directory], revision: 1 }) },
    claudeChildReferenceEntries: new Map(),
    checkpointDerivedCache() {},
    showing: null,
  });
  const worker = titleWorker(
    '\nlet quantumClock = 0; performance.now = () => ++quantumClock; Date.now = () => ' +
      (Date.now() + 7_200_000) +
      ';',
  );
  let reads = 0;
  const delays: number[] = [];
  provider.progressiveWorker = {
    run: async (
      request: ProgressiveRequest,
      generation: number,
      signal: AbortSignal,
      progress: (result: ProgressiveResult) => void,
    ) => {
      const result = await worker.run(request, generation, signal, progress);
      if (!result || result.value.kind !== 'claude-children') return result;
      // A controlled slow disk charges one catalog deadline per two MiB. Finite whole reads exceed it.
      const delay = (result.value.charges!.dispatchSpendBytes * CATALOG_REFRESH_DEADLINE_MS) / (2 * 1024 * 1024);
      delays.push(delay);
      reads++;
      return new Promise<ProgressiveResult | null>((resolve) => {
        const cancel = () => {
          clearTimeout(timer);
          worker.stop();
          resolve(null);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', cancel);
          resolve(result);
        }, delay);
        signal.addEventListener('abort', cancel, { once: true });
      });
    },
    stop: () => worker.stop(),
  };
  vi.useFakeTimers(STREAM_TIMERS);
  try {
    void provider.refresh();
    for (let attempt = 0; attempt < 96 && !provider.dispatchFacts?.get(id)?.spend.found; attempt++) {
      await vi.waitFor(() => assert.ok(reads > attempt), { timeout: 5000 });
      provider.refreshFrom('poll');
      await vi.advanceTimersByTimeAsync(Math.min(delays[attempt] + 1, CATALOG_REFRESH_DEADLINE_MS));
    }
    assert.ok(
      provider.authoritativeCatalog?.some((source: SessionFile) => source.sessionId === id),
      'repeated deadlines starved publication of a finite catalog',
    );
    assert.equal(
      provider.claudeChildReferences.some((reference: any) => reference.sessionId === id && reference.owned),
      true,
      'publication lost delegated ownership',
    );
    assert.equal(
      provider.dispatchFacts.get(id)?.spend.models[0]?.usage.output,
      3,
      JSON.stringify({ reads, facts: provider.dispatchFacts.get(id), pending: provider.dispatchDiscoveryPending }),
    );
  } finally {
    provider.abandonCatalogRefresh?.();
    worker.stop();
    vi.useRealTimers();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test.each(['selected', 'background'] as const)(
  'a %s retained refresh settles after rendering updates history recency',
  async (lane) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(100001);
    try {
      for (const change of ['recency', 'pages', 'removal']) {
        const requests: ProgressiveRequest[] = [];
        let provider: any;
        provider = selectedWindowHarness(
          async (request, generation) => {
            requests.push(request);
            assert.equal(request.kind, 'retained');
            return {
              generation,
              revision: provider.revisionOf(provider.session),
              value: {
                kind: 'retained',
                pages: [
                  {
                    turns: [turn({ sessionId: 'selected', summary: 'Refreshed response' })],
                    compactions: [],
                    bytes: 40,
                  },
                ],
              },
            };
          },
          ['trimOlderHistory', 'prepareProgressive'],
        );
        provider.structural = 'current';
        if (lane === 'background') provider.showing = 'other';
        const revision = provider.revisionOf(provider.session);
        provider.cache.set(provider.session.file, {
          key: transcriptReadCacheKey(provider.session, 40, 1024, []),
          agentKey: '',
          revision,
          read: { turns: [], compactions: [], readBytes: 10, turnLimitReached: false },
        });
        provider.history.set(
          'selected',
          loadedHistory(revision, [
            { turns: [turn({ sessionId: 'selected', summary: 'Old response' })], compactions: [], bytes: 40 },
          ]),
        );
        const refresh = () =>
          lane === 'selected'
            ? provider.completeSelectedWindow('selected', 1)
            : provider.prepareProgressive([provider.session], 1, new AbortController().signal);
        const pending = refresh();
        vi.setSystemTime(100002);
        provider.trimOlderHistory([provider.session]);
        if (change === 'pages') {
          provider.history.set('selected', {
            ...provider.history.get('selected'),
            pages: [{ turns: [turn({ sessionId: 'selected', summary: 'New page' })], compactions: [], bytes: 40 }],
          });
        } else if (change === 'removal') {
          provider.dropOlderHistory('selected');
        }
        await pending;
        if (change === 'recency') {
          assert.equal(
            provider.history.get('selected').pages[0].turns[0].summary,
            'Refreshed response',
            'rendering discarded the refreshed response',
          );
          assert.equal(provider.history.get('selected').usedAt, 100002, 'acceptance discarded the rendered recency');
          await refresh();
          assert.equal(requests.length, 1, 'an unchanged render repeated retained work');
        } else {
          assert.equal(
            provider.historyStructuralKeys.has('selected'),
            false,
            'replaced history accepted the old dependency key',
          );
          assert.equal(
            provider.history.get('selected')?.pages[0].turns[0].summary,
            change === 'pages' ? 'New page' : undefined,
            'the earlier reply replaced newer history',
          );
        }
      }
    } finally {
      vi.useRealTimers();
    }
  },
);

// A metadata-only generation change must retain qualified relationship work through the startup barrier.
test('metadata-only upgrade resumes relationships before ordinary startup metadata recovery', async () => {
  const root = tempDir('metadata-upgrade-');
  const doneFile = path.join(root, 'done.jsonl');
  const partialFile = path.join(root, 'pending.jsonl');
  const user = (id: string) =>
    JSON.stringify({
      type: 'user',
      sessionId: id,
      uuid: id,
      timestamp: '2026-01-01T00:00:00Z',
      message: { role: 'user', content: 'Read ' + id },
    }) + '\n';
  fs.writeFileSync(doneFile, user('done'));
  fs.writeFileSync(
    partialFile,
    user('pending') + JSON.stringify({ type: 'ignored', text: 'x'.repeat(2 * 1024 * 1024) }) + '\n',
  );
  const source = (file: string, sessionId: string) => ({
    file,
    sessionId,
    agent: 'claude' as const,
    ...revisionOf(fs.statSync(file, { bigint: true })),
    activity: 1,
  });
  const sources = [
    source(doneFile, 'done'),
    titleRollout(root, 'codex', 'Codex completed'),
    source(partialFile, 'pending'),
  ];
  const cache = path.join(root, 'derived-session-cache-v1.json');
  const quantumClock = 'let tick = 0; performance.now = () => ++tick;';
  let worker = titleWorker(quantumClock);
  const { provider: seed } = bumpedCatalogHarness();
  Object.assign(seed, {
    refreshGeneration: 4,
    authoritativeCatalog: sources,
    catalog: { sessions: sources },
    claudeParents: sources,
    repositoryScopeRoots: [root],
    claudeChildReferenceEntries: new Map(),
    checkpointDerivedCache() {},
  });
  const stop = new AbortController();
  try {
    seed.progressiveWorker = {
      run: (
        request: ProgressiveRequest,
        generation: number,
        signal: AbortSignal,
        accept: (reply: ProgressiveResult) => boolean,
      ) =>
        worker.run(
          request.kind === 'claude-children' ? { ...request, quantumBytes: 65536 } : request,
          generation,
          signal,
          (reply) => {
            assert.equal(accept(reply), true);
            const held = seed.claudeChildReferenceEntries.get(normalizeFsPath(partialFile));
            if (held?.claudeCursor?.offset > 0 && held.claudeCursor.offset < sources[2].size) stop.abort();
          },
        ),
    };
    await seed.prepareClaudeChildren(4, stop.signal);
    const before = seed.claudeChildReferenceEntries.get(normalizeFsPath(partialFile)).claudeCursor.offset;
    assert.ok(before > 0 && before < sources[2].size);
    assert.equal(seed.claudeChildReferenceEntries.get(normalizeFsPath(doneFile)).complete, true);
    const meta = await worker.run({ kind: 'metadata', session: sources[0] }, 4, new AbortController().signal);
    assert.equal(meta?.value.kind, 'metadata');
    if (meta?.value.kind !== 'metadata') return;
    saveDerivedCache(
      cache,
      [[doneFile, meta.value.entry]],
      seed.claudeChildReferenceEntries,
      [],
      undefined,
      seed.discoveryCheckpoint,
    );
    const stored = JSON.parse(fs.readFileSync(cache, 'utf8'));
    stored.metadataVersion = VERSION - 1;
    fs.writeFileSync(cache, JSON.stringify(stored));
    worker.stop();
    worker = titleWorker(quantumClock);
    const requests: string[] = [];
    let charged = 0;
    const run = (
      request: ProgressiveRequest,
      generation: number,
      signal: AbortSignal,
      accept?: (reply: ProgressiveResult) => boolean,
    ) => {
      requests.push(request.kind);
      let observed = 0;
      const observe = (reply: ProgressiveResult) => {
        if (
          reply.value.kind === 'claude-children' ||
          reply.value.kind === 'claude-children-progress' ||
          reply.value.kind === 'claude-children-delta'
        )
          observed = Math.max(observed, reply.value.charges?.readBytes ?? 0);
      };
      return worker
        .run(
          request.kind === 'claude-children' ? { ...request, quantumBytes: 65536 } : request,
          generation,
          signal,
          (reply) => {
            observe(reply);
            return accept?.(reply);
          },
        )
        .then((reply) => {
          if (reply) observe(reply);
          charged += observed;
          return reply;
        });
    };
    const first = titlePublicationHarness(sources, run, cache);
    const configure = (provider: any) =>
      Object.assign(provider, {
        prepareClaudeChildren: seed.prepareClaudeChildren,
        repositoryScopeRoots: [root],
        claudeParents: sources,
        claudeChildStatWrites: new Map(),
        claudeChildren: [],
        pruneDerivedTitles: () => false,
        updateSessionSpendSources() {},
        checkpointDerivedCache() {},
      });
    configure(first);
    first.useSessionStats(sessionStatsFromFacts);
    assert.equal(first.titles.size, 0, 'rejected metadata entered startup');
    assert.equal(first.carriedNames.get(doneFile)?.label, meta.value.entry.label);
    assert.equal(first.claudeChildReferenceEntries.get(normalizeFsPath(partialFile)).claudeCursor.offset, before);
    await first.refresh(true);
    const after = first.claudeChildReferenceEntries.get(normalizeFsPath(partialFile)).claudeCursor.offset;
    assert.ok(after > before, 'the restart replayed partial relationships');
    assert.equal(requests.includes('metadata'), false, 'metadata passed pending relationship discovery');
    first.anyVisible = () => false;
    await vi.waitFor(() => assert.equal(first.refreshController, null));
    assert.equal(first.writeDerivedCache(), true);
    worker.stop();
    worker = titleWorker(quantumClock);
    const second = titlePublicationHarness(sources, run, cache);
    configure(second);
    second.useSessionStats(sessionStatsFromFacts);
    await second.refresh(true);
    await vi.waitFor(() => assert.ok(second.titles.has(doneFile), 'ordinary startup never recovered metadata'), {
      timeout: 10000,
    });
    second.anyVisible = () => false;
    await vi.waitFor(() => assert.equal(second.refreshController, null));
    assert.ok(
      charged < sources.reduce((sum, item) => sum + item.size, 0),
      'the metadata change replayed the whole corpus',
    );
    assert.equal(second.writeDerivedCache(), true);
    assert.ok(loadDerivedCache(cache).titles.has(doneFile));
    const metadataCalls = requests.filter((kind) => kind === 'metadata').length;
    second.anyVisible = () => true;
    await second.refresh(true);
    assert.equal(
      requests.filter((kind) => kind === 'metadata').length,
      metadataCalls,
      'unchanged recovered metadata was read again',
    );
    second.anyVisible = () => false;
    await vi.waitFor(() => assert.equal(second.refreshController, null));
    worker.stop();
    worker = titleWorker(quantumClock);
    let replayBytes = 0;
    let complete = false;
    for (let pass = 0; pass < 128 && !complete; pass++) {
      const reply = await worker.run(
        { kind: 'claude-children', parents: sources, repositoryRoots: [root], quantumBytes: 65536 },
        1,
        new AbortController().signal,
      );
      if (reply?.value.kind === 'claude-children' || reply?.value.kind === 'claude-children-progress') {
        replayBytes += reply.value.charges?.readBytes ?? 0;
        complete = reply.value.kind === 'claude-children';
      }
    }
    assert.equal(complete, true);
    assert.ok(charged < replayBytes, 'retained progress saved no relationship reads');
    // The replay reference differs only in retained relationship state. Metadata reads are excluded.
    assert.ok(replayBytes >= sources.reduce((sum, item) => sum + item.size, 0));
    assert.equal(
      replayBytes - charged,
      before + sources[0].size + sources[1].size,
      'read accounting lost retained source bytes',
    );
  } finally {
    worker.stop();
  }
});

test.each(['scope', 'stamp', 'missing stamp'])(
  'startup rejects stale discovery %s before attaching spend associations',
  async (failure) => {
    const { provider, claude } = bumpedCatalogHarness();
    const current = {
      claude: [{ file: claude.file, sessionId: 'current-source', primary: true }],
      codex: [],
      children: [],
    };
    const stale = {
      claude: [{ file: 'stale.jsonl', sessionId: 'stale-source', primary: true }],
      codex: [],
      children: [{ file: 'stale-child.jsonl', threadId: 'stale-child' }],
    };
    const fresh = {
      compatibility: discoveryCompatibility(CLAUDE_CHILD_REFERENCE_PARSER_VERSION),
      parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
      epoch: 'fresh',
      parents: [claude],
      catalog: [claude],
      repositoryRoots: ['project'],
      completed: [],
      position: 0,
      sequence: 1,
    };
    Object.assign(provider, {
      refreshGeneration: 4,
      claudeParents: [claude],
      enumeratedSpendSources: current,
      claudeChildStatWrites: new Map(),
      checkpointDerivedCache() {},
      discoveryCheckpoint: {
        ...fresh,
        epoch: 'stale',
        repositoryRoots: failure === 'scope' ? ['other'] : ['project'],
        compatibility: failure === 'stamp' ? 'old' : failure === 'missing stamp' ? undefined : fresh.compatibility,
        spendSources: stale,
      },
    });
    provider.progressiveWorker.run = async (
      request: any,
      generation: number,
      _signal: AbortSignal,
      accept: (reply: any) => boolean,
    ) => {
      assert.equal(request.discovery, undefined, 'stale scheduling reached the worker');
      assert.deepEqual(request.codexChildren, current.children, 'stale children reached the worker');
      assert.equal(
        accept({
          generation,
          value: { kind: 'claude-children-progress', checkpoint: fresh, referenceEntries: [], continuation: true },
        }),
        true,
      );
      return {
        generation,
        value: {
          kind: 'claude-children',
          checkpoint: fresh,
          referenceEntries: [],
          roots: [claude],
          children: [],
          references: [],
          dispatchFacts: [],
          complete: true,
          continuation: false,
        },
      };
    };
    assert.equal(await provider.prepareClaudeChildren(4, new AbortController().signal), true);
    assert.deepEqual((fresh as any).spendSources, current, 'a replacement checkpoint captured stale spend sources');
    assert.deepEqual(
      provider.claudeSpendSources,
      current.claude,
      'installed spend sources retained stale associations',
    );
    assert.deepEqual(provider.codexSubagents, []);
  },
);

const PROJECT_SPEND_SNAPSHOT_METHODS = [
  'projectSpendPayload',
  'postProjectSpend',
  'unknownProjectSpendSnapshot',
  'invalidateProjectSpendSnapshot',
  'cancelProjectSpendRebuild',
  'displayedProjectSpendFiles',
];

function snapshotSpendFile(dollars: number, date = '2026-10-21', requests = 1): SpendFileIndex {
  const at = new Date(`${date}T12:00:00`).getTime();
  const buckets = aggregateUsageEvents([
    {
      timestamp: at,
      agent: 'Claude',
      provider: 'anthropic',
      model: 'model',
      contextWindow: null,
      billingClass: 'metered',
      inferenceClass: null,
      serviceTier: null,
      reportedCost: dollars / requests,
      usage: { input: 1, output: 1, thinking: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0 },
    } as UsageEvent,
  ]);
  return {
    file: 'source.jsonl',
    workspace: 'project',
    size: 1,
    mtimeMs: at,
    offset: 1,
    trailing: '',
    complete: true,
    indexedAt: at,
    buckets: Array.from({ length: requests }, () => ({ ...buckets[0] })),
  };
}

function projectSpendSnapshotHarness(scope: Record<string, unknown> = {}, extraMethods: string[] = []): any {
  const provider = paintHarness(
    [...PROJECT_SPEND_SNAPSHOT_METHODS, 'setUsage', 'projectSpendHistoryCutoff', ...extraMethods],
    {
      prepareProjectSpendViewSteps,
      projectSpendWindows,
      projectSpendDisplayFiles,
      truncateProjectSpendView,
      projectSpendHistoryCutoff,
      publicProjectSpendPrice,
      ...scope,
    },
  );
  provider.disposed = false;
  provider.projectSpendWorkspace = 'project';
  provider.projectSpendRevision = 0;
  provider.projectSpendSnapshot = provider.unknownProjectSpendSnapshot();
  provider.projectSpendSnapshotPrice = publicProjectSpendPrice;
  provider.projectSpendFiles = [snapshotSpendFile(5)];
  provider.projectSpendVisibleFiles = provider.projectSpendFiles;
  return provider;
}

test('Project cost snapshot reads and repeated selections never advance a pending background build', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-21T12:00:00'));
  try {
    let steps = 0;
    let bucketReads = 0;
    const provider = projectSpendSnapshotHarness({
      prepareProjectSpendViewSteps: function* (...args: Parameters<typeof prepareProjectSpendViewSteps>) {
        const build = prepareProjectSpendViewSteps(...args);
        for (;;) {
          const before = bucketReads;
          const result = build.next();
          assert.ok(bucketReads - before <= 1, 'one aggregation step traversed multiple usage buckets');
          if (result.done) return result.value;
          steps++;
          yield;
        }
      },
    });
    const file = snapshotSpendFile(5, '2026-10-21', 2000);
    file.buckets = new Proxy(file.buckets, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^[0-9]+$/.test(key)) bucketReads++;
        return Reflect.get(target, key, receiver);
      },
    });
    provider.projectSpendFiles = [file];
    provider.projectSpendVisibleFiles = provider.projectSpendFiles;
    const invalidatedAt = Date.now();
    provider.invalidateProjectSpendSnapshot();
    assert.equal(steps, 0);
    vi.advanceTimersToNextTimer();
    assert.ok(Date.now() - invalidatedAt <= 1000, 'the rebuild did not start within one second');
    assert.ok(steps > 0 && steps <= 128, 'the first background slice exceeded its explicit work budget');
    const afterSlice = steps;
    for (let repeat = 0; repeat < 3; repeat++) {
      await provider.refresh(true, true, true, true);
      provider.setUsage([]);
      provider.projectSpendPayload();
    }
    assert.equal(steps, afterSlice, 'a panel action resumed project-wide aggregation');
    assert.ok(provider.projectSpendBuild, 'the fixture finished before the panel actions ran');
    await vi.runAllTimersAsync();
    assert.ok(Math.abs(provider.projectSpendPayload().windows[0].dollars - 5) < 1e-9);
    assert.equal(provider.projectSpendPayload().indexing, false);
  } finally {
    vi.useRealTimers();
  }
});

test.each(['resumable updates', 'unchanged completed index passes'])(
  'Project cost snapshot publishes unchanged complete history during continuing %s',
  (activity) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T12:00:00'));
    try {
      const provider = projectSpendSnapshotHarness(
        { pruneSpendFilesWithResult: (files: SpendFileIndex[]) => ({ files, pruned: false }) },
        ['finishProjectSpendIndex'],
      );
      provider.postRailIfSpendPendingMoved = () => {};
      provider.projectSpendVisibleFiles = [snapshotSpendFile(5, '2026-10-21', 2000)];
      provider.projectSpendFiles =
        activity === 'resumable updates'
          ? [{ ...snapshotSpendFile(9), complete: false }]
          : provider.projectSpendVisibleFiles.slice();
      provider.projectSpendIndexing = true;
      provider.invalidateProjectSpendSnapshot();
      let updates = 0;
      while (provider.projectSpendPayload().windows[0].dollars === null && updates < 1000) {
        vi.advanceTimersToNextTimer();
        updates++;
        if (activity === 'resumable updates') {
          provider.projectSpendFiles[0] = { ...provider.projectSpendFiles[0], offset: updates };
          provider.projectSpendRevision++;
          provider.invalidateProjectSpendSnapshot();
        } else {
          provider.projectSpendIndexing = true;
          provider.finishProjectSpendIndex();
        }
      }
      assert.ok(updates > 1, 'the fixture did not span continuing progress');
      assert.ok(
        provider.posts.some(
          (post: any) => post.type === 'projectSpend' && post.projectSpend.windows[0].dollars !== null,
        ),
        'continuing progress prevented publication',
      );
      assert.ok(Math.abs(provider.projectSpendPayload().windows[0].dollars - 5) < 1e-9);
      assert.equal(provider.projectSpendPayload().indexing, true);
      if (activity === 'resumable updates') {
        assert.ok(provider.projectSpendRebuild, 'the newer revision lost its owed rebuild');
      }
      provider.cancelProjectSpendRebuild();
    } finally {
      vi.useRealTimers();
    }
  },
);

test('Project cost snapshot discards a revision invalidated during aggregation', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-21T12:00:00'));
  try {
    const provider = projectSpendSnapshotHarness();
    provider.projectSpendFiles = [snapshotSpendFile(5, '2026-10-21', 2000)];
    provider.projectSpendVisibleFiles = provider.projectSpendFiles;
    provider.invalidateProjectSpendSnapshot();
    vi.advanceTimersToNextTimer();
    provider.projectSpendFiles = [snapshotSpendFile(8)];
    provider.projectSpendVisibleFiles = provider.projectSpendFiles;
    provider.projectSpendRevision++;
    provider.invalidateProjectSpendSnapshot();
    await vi.runAllTimersAsync();
    assert.equal(provider.projectSpendPayload().windows[0].dollars, 8);
    assert.ok(
      provider.posts
        .filter((post: any) => post.type === 'projectSpend')
        .every((post: any) => post.projectSpend.windows[0].dollars === 8),
      'an obsolete amount published before the owed revision',
    );
  } finally {
    vi.useRealTimers();
  }
});

test('Project cost snapshot switches A to B to A without accepting the earlier A build or offer', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-21T12:00:00'));
  try {
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const provider = spendOfferHarness({
      prepareProjectSpendViewSteps,
      projectSpendWindows,
      projectSpendHistoryCutoff,
      publicProjectSpendPrice,
    });
    const actual = projectSpendSnapshotHarness();
    for (const method of PROJECT_SPEND_SNAPSHOT_METHODS) provider[method] = actual[method];
    provider.projectSpendSnapshot = provider.unknownProjectSpendSnapshot();
    provider.projectSpendStorageDir = undefined;
    provider.projectSpendFiles = [snapshotSpendFile(3)];
    provider.projectSpendVisibleFiles = provider.projectSpendFiles;
    provider.invalidateProjectSpendSnapshot();
    await vi.runAllTimersAsync();
    assert.equal(provider.projectSpendPayload().windows[0].dollars, 3);
    provider.projectSpendFiles = [snapshotSpendFile(5, '2026-10-21', 2000)];
    provider.projectSpendVisibleFiles = provider.projectSpendFiles;
    provider.invalidateProjectSpendSnapshot();
    vi.advanceTimersToNextTimer();
    const staleBuild = provider.projectSpendBuild;
    const staleSlice = timer.mock.calls.at(-1)![0];
    let offers = 0;
    let indexed = 0;
    provider.indexNextProjectSpendFile = () => indexed++;
    provider.scheduleNextProjectSpendFile();
    const staleIndex = timer.mock.calls.at(-1)![0];
    provider.queueProjectSpendIndex = () => offers++;
    provider.scheduleProjectSpendIndex(new Map(), null);
    const staleOffer = timer.mock.calls.at(-1)![0];
    provider.useFolders(['B']);
    provider.ensureProjectSpendWorkspace();
    assert.equal(provider.projectSpendPayload().windows[0].dollars, null);
    provider.useFolders(['project']);
    provider.ensureProjectSpendWorkspace();
    assert.equal(provider.projectSpendPayload().windows[0].dollars, null);
    provider.projectSpendFiles = [snapshotSpendFile(11)];
    provider.projectSpendVisibleFiles = provider.projectSpendFiles;
    provider.projectSpendRevision++;
    provider.invalidateProjectSpendSnapshot();
    while (!staleBuild.next().done) {
      /* Complete the old generator before its queued callback. */
    }
    staleSlice();
    staleOffer();
    staleIndex();
    timer.mockRestore();
    await vi.runAllTimersAsync();
    assert.equal(provider.projectSpendPayload().windows[0].dollars, 11);
    assert.equal(offers, 0, 'a prior workspace offer reached the returned workspace');
    assert.equal(indexed, 0, 'a prior workspace index slice reached the returned workspace');
  } finally {
    vi.useRealTimers();
  }
});

test('Project cost snapshot publishes the new calendar date inside the midnight callback', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-21T23:59:59'));
  try {
    const provider = projectSpendSnapshotHarness({}, ['scheduleProjectSpendMidnight']);
    provider.invalidateProjectSpendSnapshot();
    await vi.runAllTimersAsync();
    assert.equal(provider.projectSpendPayload().windows[0].dollars, 5);
    provider.scheduleProjectSpendMidnight();
    vi.advanceTimersToNextTimer();
    const published = provider.posts.at(-1).projectSpend;
    assert.equal(published.windows[0].dollars, 0, 'midnight published yesterday as today');
    assert.equal(published.windows[1].dollars, 5);
    assert.ok(provider.projectSpendRebuild, 'the next projection was never requested');
    provider.cancelProjectSpendRebuild();
    clearTimeout(provider.projectSpendMidnight);
  } finally {
    vi.useRealTimers();
  }
});

test('Project cost snapshot publishes current truncation when midnight arrives late and rebuilding remains pending', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-21T23:59:59'));
  try {
    const provider = projectSpendSnapshotHarness({ snapshotHistoryDays: () => 6 }, ['scheduleProjectSpendMidnight']);
    provider.invalidateProjectSpendSnapshot();
    await vi.runAllTimersAsync();
    const timer = vi.spyOn(globalThis, 'setTimeout');
    provider.scheduleProjectSpendMidnight();
    const callback = timer.mock.calls.at(-1)![0];
    clearTimeout(provider.projectSpendMidnight);
    vi.setSystemTime(new Date('2026-10-22T00:00:00.001'));
    callback();
    const published = provider.posts.at(-1).projectSpend;
    assert.equal(published.windows[0].dollars, 0);
    assert.equal(published.windows[1].dollars, 5);
    assert.equal(published.windows[1].status, 'atLeast');
    assert.equal(published.windows[1].partial, true);
    assert.match(published.windows[1].display, /^At least /);
    assert.equal(published.categories[0].windows[1].status, 'atLeast');
    assert.ok(provider.projectSpendRebuild, 'the callback finished rebuilding before publication');
    provider.cancelProjectSpendRebuild();
    clearTimeout(provider.projectSpendMidnight);
    timer.mockRestore();
  } finally {
    vi.useRealTimers();
  }
});

test('Project cost snapshot hydration replaces an interrupted build without counting the restored source twice', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-21T12:00:00'));
  try {
    const restored = [snapshotSpendFile(11)];
    const provider = projectSpendSnapshotHarness(
      {
        loadSpendLedger: () => ({ files: restored, completeFiles: restored }),
        pruneSpendFilesWithResult: (files: SpendFileIndex[]) => ({ files, pruned: false }),
      },
      ['hydrateProjectSpend'],
    );
    provider.projectSpendStorageDir = 'storage';
    provider.projectSpendFiles = [snapshotSpendFile(5, '2026-10-21', 2000)];
    provider.projectSpendVisibleFiles = provider.projectSpendFiles;
    provider.scheduleProjectSpendMidnight = () => {};
    provider.scheduleProjectSpendIndex = () => {};
    provider.scheduleProjectSpendSave = () => {};
    provider.postRail = () => {};
    provider.invalidateProjectSpendSnapshot();
    vi.advanceTimersToNextTimer();
    provider.projectSpendHydrated = false;
    provider.scheduleProjectSpendHydration(provider.refreshGeneration);
    await vi.runAllTimersAsync();
    assert.equal(provider.projectSpendFiles.length, 1);
    assert.equal(provider.projectSpendPayload().windows[0].dollars, 11);
  } finally {
    vi.useRealTimers();
  }
});

test('Project cost snapshot rejects hydration from an earlier workspace epoch after A to B to A', () => {
  vi.useFakeTimers();
  try {
    const timer = vi.spyOn(globalThis, 'setTimeout');
    let loads = 0;
    const provider = projectSpendSnapshotHarness(
      {
        pruneSpendFilesWithResult: (files: SpendFileIndex[]) => ({ files, pruned: false }),
        loadSpendLedger: () => {
          loads++;
          return { files: [], completeFiles: [] };
        },
      },
      ['hydrateProjectSpend'],
    );
    provider.projectSpendStorageDir = 'storage';
    provider.projectSpendHydrated = false;
    provider.scheduleProjectSpendMidnight = () => {};
    provider.scheduleProjectSpendIndex = () => {};
    provider.scheduleProjectSpendSave = () => {};
    provider.postRail = () => {};
    provider.scheduleProjectSpendHydration(provider.refreshGeneration);
    const stale = timer.mock.calls.at(-1)![0];
    provider.projectSpendEpoch += 2;
    stale();
    assert.equal(loads, 0, 'a hydration callback used only the matching workspace name');
    timer.mockRestore();
  } finally {
    vi.useRealTimers();
  }
});

test.each(['pricing', 'history', 'period truncation'])(
  'Project cost snapshot retains an independent %s change during a slice',
  async (change) => {
    vi.useFakeTimers();
    const midnight = new Date('2026-10-21T00:00:00');
    vi.setSystemTime(change === 'period truncation' ? midnight : new Date('2026-10-21T12:00:00'));
    try {
      let history = change === 'history' ? 3 : change === 'period truncation' ? 6 : 0;
      const provider = projectSpendSnapshotHarness({ snapshotHistoryDays: () => history });
      const file = snapshotSpendFile(5, '2026-10-21', 2000);
      const quote = (dollars: number) => () => ({
        dollars,
        source: 'Configured rate',
        effectiveDate: null,
        estimated: true,
        provenance: 'configured' as const,
      });
      if (change === 'pricing') {
        file.buckets = file.buckets.map((bucket) => ({ ...bucket, reportedCost: null }));
        provider.useSnapshotPrice(quote(0.0025));
      }
      provider.projectSpendFiles = [file];
      provider.projectSpendVisibleFiles = [file];
      provider.invalidateProjectSpendSnapshot();
      vi.advanceTimersToNextTimer();
      if (change === 'pricing') provider.useSnapshotPrice(quote(0.005));
      if (change === 'history') history = 0;
      if (change === 'period truncation') {
        // Start exactly at the boundary, then move the clock without running another slice.
        provider.cancelProjectSpendRebuild();
        vi.setSystemTime(midnight);
        provider.invalidateProjectSpendSnapshot();
        vi.setSystemTime(new Date(midnight.getTime() - 100));
        vi.advanceTimersToNextTimer();
        vi.setSystemTime(new Date(midnight.getTime() + 1));
      }
      provider.invalidateProjectSpendSnapshot();
      await vi.runAllTimersAsync();
      const view = provider.projectSpendPayload();
      assert.ok(Math.abs(view.windows[0].dollars - (change === 'pricing' ? 10 : 5)) < 1e-8);
      assert.equal(view.windows[1].status, change === 'period truncation' ? 'atLeast' : 'exact');
      if (change === 'pricing') {
        assert.equal(view.rateSources[0].source, 'Configured rate');
        assert.ok(
          provider.posts.every(
            (post: any) => post.type !== 'projectSpend' || Math.abs(post.projectSpend.windows[0].dollars - 10) < 1e-8,
          ),
          'the obsolete price published before the current price',
        );
      }
    } finally {
      vi.useRealTimers();
    }
  },
);

test('Project cost snapshot reads complete display files while the index retains resumable progress', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-21T12:00:00'));
  try {
    const provider = projectSpendSnapshotHarness();
    provider.projectSpendFiles = [{ ...snapshotSpendFile(9), complete: false }];
    provider.projectSpendVisibleFiles = [snapshotSpendFile(5)];
    provider.projectSpendIndexing = true;
    provider.invalidateProjectSpendSnapshot();
    await vi.runAllTimersAsync();
    assert.equal(provider.projectSpendPayload().windows[0].dollars, 5);
    assert.equal(provider.projectSpendPayload().indexing, true);
    assert.equal(provider.projectSpendFiles[0].complete, false);
    provider.projectSpendFiles = [snapshotSpendFile(9)];
    provider.projectSpendVisibleFiles = provider.projectSpendFiles;
    provider.projectSpendIndexing = false;
    provider.projectSpendRevision++;
    provider.invalidateProjectSpendSnapshot();
    assert.equal(provider.projectSpendPayload().windows[0].dollars, 5);
    await vi.runAllTimersAsync();
    assert.equal(provider.projectSpendPayload().windows[0].dollars, 9);
  } finally {
    vi.useRealTimers();
  }
});

test.each([
  ['2026-10-21T00:00:00', '2026-10-21T00:00:00.001'],
  ['2026-03-09T00:30:00', '2026-03-09T01:00:00.001'],
])('Project cost snapshot schedules period truncation from %s across local clock changes', async (start, boundary) => {
  const priorTimezone = process.env.TZ;
  process.env.TZ = 'America/Chicago';
  vi.useFakeTimers();
  vi.setSystemTime(new Date(start));
  try {
    let history = 0;
    const provider = projectSpendSnapshotHarness({ snapshotHistoryDays: () => history }, [
      'scheduleProjectSpendMidnight',
      'restartProjectSpendOffer',
    ]);
    provider.projectSpendQueue = [];
    provider.projectSpendQueued = new Set();
    provider.queueProjectSpendIndex = () => {};
    provider.scheduleProjectSpendIndex = () => {};
    provider.invalidateProjectSpendSnapshot();
    await vi.runAllTimersAsync();
    vi.setSystemTime(new Date(start));
    provider.scheduleProjectSpendMidnight();
    history = 6;
    provider.restartProjectSpendOffer();
    const deadline = new Date(boundary).getTime();
    vi.advanceTimersByTime(deadline - Date.now() - 1);
    assert.equal(provider.projectSpendPayload().windows[1].status, 'exact');
    vi.advanceTimersByTime(1);
    assert.equal(Date.now(), deadline);
    const published = provider.posts.at(-1).projectSpend;
    assert.equal(published.windows[1].status, 'atLeast');
    assert.equal(published.categories[0].windows[1].status, 'atLeast');
    provider.cancelProjectSpendRebuild();
    clearTimeout(provider.projectSpendMidnight);
  } finally {
    vi.useRealTimers();
    if (priorTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = priorTimezone;
  }
});

// Exercise the production host drain with a native receipt writer and no visible target selection.
function agentMessageHost(agent: 'claude' | 'codex') {
  const file = ts.createSourceFile(
    'panelhost.ts',
    fs.readFileSync(path.join(__dirname, 'panelhost.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const owner = file.statements.find(
    (one): one is ts.ClassDeclaration => ts.isClassDeclaration(one) && one.name?.text === 'PanelProvider',
  )!;
  const names = [
    'sendAgentMessage',
    'queueAgentMessage',
    'backgroundRefusal',
    'flushAgentMessage',
    'recoverAgentMessage',
    'flushQueue',
    'flushAgentQueue',
    'dequeue',
    'readerWork',
    'continuationWork',
    'guardedTargetFacts',
    'releaseStaging',
    'livePressAnswered',
    'forgetLivePress',
    'requestQueuedEdit',
    'acceptQueuedEdit',
    'releaseQueuedEditOffer',
    'writeDrafts',
    'persistHostState',
    'saveHostState',
  ];
  const body = owner.members
    .filter((one) => one.name && names.includes(one.name.getText(file)))
    .map((one) => one.getText(file))
    .join('\n');
  const scope = {
    crypto: { randomUUID },
    ReadPersistenceUnknownError,
    ReadPublicationError,
    queuedSubmission,
    guardedRefusal,
    guardedPromptRefusal,
    requesterOf,
    payloadSha256,
    queueSubmissionAfter,
    queuedSubmissionBookFits,
    normalizeQueuedSubmissions,
    normalizeDrafts,
    normalizeDraftCommentIds,
    normalizePromptAssetBook,
    sentPromptsToSave,
    preserveHostRead,
    queueCanDrain,
    queueEdit,
    guardedSourceRevision,
    ACTIVE_RAIL_STATUSES: new Set(['running', 'waiting', 'subagents', 'background']),
    commentsForActiveSubmission,
    pressesAfterHandoff,
    clearRequest: () => null,
    compactSubmission,
    clearSubmission,
    queueAfterAcceptedRecovery,
    commentsForQueuedSubmission,
    queueWithout: (entries: any[], id: string) => entries.filter((one) => one.id !== id),
    queueAfterClearRecovery: (_agent: string, entries: any[]) => entries,
    claudeBackgroundHint,
    claudeBackgroundTranscript,
  };
  const compiled = transformSync(`class Host { ${body} }; return Host`, { loader: 'ts', format: 'cjs' }).code;
  const Host = new Function(...Object.keys(scope), compiled)(...Object.values(scope));
  const host: any = new Host();
  const reads: string[] = [];
  const text = '  exact message\n\twith whitespace  \n';
  let busy = true;
  let exited = false;
  let asks = false;
  let control = false;
  let replacement = false;
  let outcome: 'accepted' | 'refused' | 'unknown' = 'accepted';
  let receipt: ((attempt: GuardedAttempt) => void) | undefined;
  let beforeNative: (() => void) | undefined;
  let persist: (() => Promise<void>) | undefined;
  const child = {
    key: 'original-child',
    agent,
    state: () => ({ sessionId: 'target', exited, lastError: null }),
    guardedTurnEnds: () => 0,
    guardedIdle: () => (busy || asks || control ? 'busy' : null),
    guardedLiveReason: () => (asks || control ? 'Waiting for pending work.' : busy ? null : 'No running work.'),
    guardedLive: (value: string, uuid: string, submitted?: (turn: number) => void, beforeWrite?: () => void) =>
      child.guardedPrompt(value, uuid, agent === 'claude' ? submitted : undefined, beforeWrite),
    guardedPrompt: (value: string, uuid: string, submitted?: (turn: number) => void, beforeWrite?: () => void) => {
      const attempt = new GuardedAttempt(uuid, beforeWrite);
      submitted?.(7);
      busy = true; // Native preparation belongs to this attempt and must not refuse itself.
      beforeNative?.();
      try {
        attempt.prepareWrite();
        reads.push(value);
        attempt.markWritten();
        if (receipt) receipt(attempt);
        else attempt.settle({ outcome, nativeTurnId: 'native-7', reason: outcome });
      } catch (error) {
        attempt.settle({ outcome: 'unknown', nativeTurnId: null, reason: String(error) });
      }
      return attempt;
    },
  };
  const live = () => (replacement || exited ? null : child);
  const policy = new GuardedSends<typeof child>('window', () => live());
  const binding = () =>
    agentMessageBinding(
      policy,
      child,
      { find: live, withActivity: async (_key, work) => work(child) },
      () => false,
      randomUUID,
    );
  Object.assign(host, {
    repositoryScopeReady: true,
    hostSaveGeneration: 0,
    hidden: new Set(),
    membershipOf: () => 'present',
    queues: {},
    agentMessages: new Map(),
    queueHandoffs: new Set(),
    queuedEditReservations: new Set(),
    pendingQueueDrains: new Set(),
    clearSettlements: new Map(),
    live: {},
    livePressHosts: new Map(),
    hosts: [],
    staging: new Set(),
    stagingTokens: new Map(),
    assetHandoffs: new Set(),
    assetIdsInHandoff: new Set(),
    submissionsInFlight: new Set(),
    submittingDrafts: new Map(),
    assets: {},
    draftCommentIds: {},
    queuedEditOffers: new Map(),
    panelSession: (session: string) => session,
    questionSource: () => null,
    holdDraft: (session: string, text: string) => {
      host.drafts[session] = text;
    },
    sendToHost: async () => true,
    postAcceptedResponses: () => {},
    markStartedPresses: () => {},
    dropSpentPresses: () => {},
    attachmentStorageDir: null,
    newDrafts: {},
    awaitingSessionRecords: {},
    saved: { comments: [{ id: 'unclaimed', sessionId: 'target', text: 'private reader comment' }] },
    drafts: { target: 'reader draft' },
    stateFor: () => ({
      sessionId: 'target',
      agent,
      running: busy,
      clearing: false,
      asks: asks ? [{}] : [],
      draft: host.drafts.target,
      assets: [],
      queued: host.queues.target ?? [],
      comments: host.saved.comments,
    }),
    composerStateFor: () => host.stateFor(),
    guardedTargetFacts: () => ({
      current: true,
      archived: false,
      scope: 'scope',
      sourceRevision: null,
      latestTurn: null,
      queued: host.queues.target?.length ?? 0,
      pendingSubmissions: 0,
      pendingControls: Number(control),
      background: busy,
      writerConflict: false,
    }),
    writeDrafts: async () => {
      host.hostSaveGeneration++;
      host.stored = normalizeQueuedSubmissions(host.queues);
      await persist?.();
    },
    post: async () => {},
    usagePayload: () => ({}),
    onReaderAction: () => assert.fail('agent message entered reader action'),
    onReaderDirected: () => assert.fail('agent message granted reader direction'),
    onSendPrompt: () => assert.fail('agent message entered ordinary send'),
    send: () => assert.fail('agent message assembled reader input'),
  });
  const request = {
    id: 'window:message',
    requester: 'unrelated-reader-agent',
    requesterProvider: 'codex' as const,
    params: { sessionId: 'target', prompt: text },
  };
  return {
    host,
    child,
    policy,
    reads,
    text,
    request,
    binding,
    setBusy: (value: boolean) => {
      busy = value;
    },
    setAsks: (value: boolean) => {
      asks = value;
    },
    setControl: (value: boolean) => {
      control = value;
    },
    replace: () => {
      replacement = true;
    },
    exit: () => {
      exited = true;
    },
    setOutcome: (value: typeof outcome) => {
      outcome = value;
    },
    receipt: (work?: (attempt: GuardedAttempt) => void) => {
      receipt = work;
    },
    beforeNative: (work: () => void) => {
      beforeNative = work;
    },
    persist: (work: () => Promise<void>) => {
      persist = work;
    },
  };
}

for (const agent of ['claude', 'codex'] as const) {
  test(`${agent} ordinary reader corrections reach busy targets before current work finishes and retain the exact receipt`, async () => {
    const f = agentMessageHost(agent);
    const book = new SessionWriteRequests('window');
    const request = { ...f.request, params: { ...f.request.params, delivery: 'auto' as const } };
    // The accepted original turn still owns a visible prompt while it works.
    f.host.live.target = [{ kind: 'prompt', ran: true, started: true }];
    const facts = f.host.guardedTargetFacts;
    f.host.guardedTargetFacts = () => ({ ...facts(), pendingSubmissions: 1 });
    const { WindowChannel } = await import('./sessionrequests.ts');
    const { runManagement } = await import('../../cli/src/manage.ts');
    const home = tempDir('ordinary-send-');
    const channel = new WindowChannel(home);
    channel.setGuardedSendHandler((incoming) => f.host.sendAgentMessage(incoming, f.binding()));
    await channel.update({ folders: [home], scopeReady: true, panelReady: true, panelVisible: true });
    const prompt = path.join(home, 'correction.txt');
    fs.writeFileSync(prompt, f.text);
    const names = ['ARC_HOME', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID'];
    const prior = names.map((name) => process.env[name]);
    let accepted: any;
    try {
      process.env.ARC_HOME = home;
      process.env.CLAUDE_CODE_SESSION_ID = 'reader-agent';
      delete process.env.CODEX_THREAD_ID;
      accepted = JSON.parse(
        await runManagement('send', [
          'target',
          '--prompt-file',
          prompt,
          '--request-id',
          channel.hostId + ':correction',
          '--window',
          channel.hostId,
          '--json',
        ]),
      );
    } finally {
      names.forEach((name, index) => {
        if (prior[index] === undefined) delete process.env[name];
        else process.env[name] = prior[index];
      });
      await channel.dispose();
    }
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.delivery, agent === 'codex' ? 'steer' : 'live');
    assert.deepEqual(f.reads, [f.text]);
    assert.equal(f.host.stateFor().running, true, 'the original work has not finished');
    assert.equal(f.host.queues.target, undefined);
    assert.equal(f.policy.owner('target'), null);
    assert.equal(f.host.drafts.target, 'reader draft');
    assert.equal(f.host.saved.comments.length, 1);
    await book.runGuarded(request.id, request, () => accepted);
    assert.deepEqual(await book.runGuarded(request.id, request, () => assert.fail('retry wrote again')), accepted);
    await assert.rejects(
      book.runGuarded(request.id, f.request, () => assert.fail('changed mode wrote again')),
      /different request/,
    );
  });
  test(`${agent} ordinary sends start idle work and preserve pending-work and FIFO queue admission`, async () => {
    const idle = agentMessageHost(agent);
    idle.setBusy(false);
    const request = { ...idle.request, params: { ...idle.request.params, delivery: 'auto' as const } };
    assert.equal((await idle.host.sendAgentMessage(request, idle.binding())).delivery, 'turn');
    assert.deepEqual(idle.reads, [idle.text]);
    for (const blocker of ['ask', 'control', 'preparing', 'queue']) {
      const f = agentMessageHost(agent);
      if (blocker === 'ask') f.setAsks(true);
      if (blocker === 'control') f.setControl(true);
      if (blocker === 'preparing') {
        f.host.live.target = [{ kind: 'prompt', ran: false, started: false }];
        const facts = f.host.guardedTargetFacts;
        f.host.guardedTargetFacts = () => ({ ...facts(), pendingSubmissions: 1 });
      }
      if (blocker === 'queue')
        f.host.queues.target = queueSubmissionAfter([], 'older', 'older text', [], [], 1, false, {
          agent,
          owner: 'target',
        });
      const result = await f.host.sendAgentMessage(request, f.binding());
      assert.equal(result.status, 'queued', blocker);
      assert.deepEqual(f.reads, [], blocker);
    }
  });
  test(`${agent} retains a pending ordinary receipt through caller disconnect and wakes the queued head on settlement`, async () => {
    const f = agentMessageHost(agent);
    let attempt: GuardedAttempt | undefined;
    const attempts: GuardedAttempt[] = [];
    f.receipt((value) => {
      attempt = value;
      attempts.push(value);
    });
    const { WindowChannel } = await import('./sessionrequests.ts');
    const net = await import('node:net');
    const home = tempDir('pending-ordinary-send-');
    const channel = new WindowChannel(home);
    let settled = false;
    channel.setGuardedSendHandler(async (request) => {
      const result = await f.host.sendAgentMessage(request, f.binding());
      settled = true;
      return result;
    });
    await channel.update({ folders: [home], scopeReady: true, panelReady: true, panelVisible: false });
    const entry = JSON.parse(fs.readFileSync(path.join(home, 'hosts', channel.hostId + '.json'), 'utf8'));
    const socket = net.createConnection(entry.address);
    const request = {
      ...f.request,
      id: channel.hostId + ':pending',
      version: 1,
      token: entry.token,
      method: 'send',
      params: { ...f.request.params, delivery: 'auto' as const },
    };
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      socket.write(JSON.stringify(request) + '\n');
      await vi.waitFor(() => assert.ok(attempt?.inputWritten));
      const disconnected = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      socket.destroy();
      await disconnected;
      await vi.waitFor(() => assert.equal((channel as unknown as { sockets: Set<unknown> }).sockets.size, 0));
      const competing = { ...f.request, id: 'window:competing', requester: 'another-reader', params: request.params };
      let refused: { status: string; reason: string } | undefined;
      const competingSend = f.host.sendAgentMessage(competing, f.binding()).then((result: typeof refused) => {
        refused = result;
      });
      await vi.waitFor(() => assert.ok(refused || attempts.length > 1));
      assert.equal(attempts.length, 1, 'another requester wrote before the first receipt settled');
      assert.equal(refused!.status, 'refused');
      assert.match(refused!.reason, /still being delivered/);
      await competingSend;
      assert.equal((await f.host.queueAgentMessage(competing, f.binding())).status, 'refused');
      assert.equal(settled, false, 'caller disconnection must not settle the host attempt');
      assert.deepEqual(f.reads, [f.text]);
      // A queued head can become eligible while the provider still owes the earlier receipt.
      const queued = queueSubmissionAfter([], 'queued-after-write', 'queued next', [], [], 1, false, {
        agent,
        owner: 'target',
        origin: 'agent',
      });
      f.host.queues.target = queued;
      f.host.agentMessages.set(queued[0].id, f.binding());
      f.setBusy(false);
      f.host.flushAgentQueue('target');
      assert.deepEqual(f.reads, [f.text], 'the queued head cannot overtake the pending receipt');
      f.receipt();
      attempt!.settle({ outcome: 'accepted', nativeTurnId: 'native-7', reason: '' });
      await vi.waitFor(() => assert.deepEqual(f.reads, [f.text, 'queued next']));
      await vi.waitFor(() => assert.equal(f.host.agentMessages.size, 0));
      assert.equal(settled, true);
      assert.deepEqual(f.host.queues.target, []);
    } finally {
      for (const pending of attempts)
        pending.settle({ outcome: 'unknown', nativeTurnId: null, reason: 'fixture cleanup' });
      socket.destroy();
      await channel.dispose();
    }
  });
  test(`${agent} arc send and its queue name the recovery commands as a condition only for a Claude background transcript`, async () => {
    const f = agentMessageHost(agent);
    const home = tempDir('background-send-');
    const background = path.join(home, 'background.jsonl');
    const ordinary = path.join(home, 'ordinary.jsonl');
    const record = { type: 'system', subtype: 'informational', sessionId: 'target' };
    fs.writeFileSync(background, JSON.stringify({ ...record, sessionKind: 'bg' }) + '\n');
    fs.writeFileSync(ordinary, JSON.stringify(record) + '\n');
    const { WindowChannel } = await import('./sessionrequests.ts');
    const { runManagement } = await import('../../cli/src/manage.ts');
    const channel = new WindowChannel(home);
    // `activate` passes no binding when the target has no Arc child.
    channel.setGuardedSendHandler((incoming) => f.host.sendAgentMessage(incoming, null));
    await channel.update({ folders: [home], scopeReady: true, panelReady: true, panelVisible: true });
    const prompt = path.join(home, 'message.txt');
    fs.writeFileSync(prompt, f.text);
    const names = ['ARC_HOME', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID'];
    const prior = names.map((name) => process.env[name]);
    let requests = 0;
    const reasons = async (transcript: string) => {
      f.host.questionSource = (which: string, session: string) =>
        which === agent && session === 'target' ? transcript : null;
      const said: string[] = [];
      for (const queue of [[], ['--queue']]) {
        const reply = JSON.parse(
          await runManagement('send', [
            'target',
            '--prompt-file',
            prompt,
            ...queue,
            '--request-id',
            `${channel.hostId}:background-${requests++}`,
            '--window',
            channel.hostId,
            '--json',
          ]),
        );
        assert.equal(reply.status, 'refused');
        said.push(reply.reason);
      }
      return said;
    };
    const unavailable = 'The destination session is unavailable.';
    const hint =
      'If Claude Code runs this session in the background, claude attach target opens it in a terminal, ' +
      'and claude stop target lets Arc continue it.';
    try {
      process.env.ARC_HOME = home;
      process.env.CLAUDE_CODE_SESSION_ID = 'reader-agent';
      delete process.env.CODEX_THREAD_ID;
      assert.deepEqual(
        await reasons(background),
        agent === 'claude'
          ? [`${unavailable} ${hint} No message was sent.`, `${unavailable} ${hint} No message was queued.`]
          : [`${unavailable} No message was sent.`, `${unavailable} No message was queued.`],
      );
      assert.deepEqual(await reasons(ordinary), [
        `${unavailable} No message was sent.`,
        `${unavailable} No message was queued.`,
      ]);
    } finally {
      names.forEach((name, index) => {
        if (prior[index] === undefined) delete process.env[name];
        else process.env[name] = prior[index];
      });
      await channel.dispose();
    }
    assert.deepEqual(f.reads, []);
    assert.equal(f.host.queues.target, undefined);
  });
  test(`${agent} blocks unknown ordinary delivery without queue fallback`, async () => {
    const f = agentMessageHost(agent);
    const release = f.policy.reserve('target')!;
    const request = { ...f.request, params: { ...f.request.params, delivery: 'auto' as const } };
    assert.equal((await f.host.sendAgentMessage(request, f.binding())).status, 'refused');
    assert.equal((await f.host.queueAgentMessage(f.request, f.binding())).status, 'refused');
    release();
    f.setOutcome('unknown');
    assert.equal((await f.host.sendAgentMessage(request, f.binding())).status, 'unknown');
    assert.equal(
      (await f.host.sendAgentMessage({ ...request, id: 'window:next', requester: 'other' }, f.binding())).status,
      'refused',
    );
    assert.deepEqual(f.reads, [f.text]);
    assert.equal(f.host.queues.target, undefined);
  });
  test(`${agent} ordinary sends recheck native ownership and pending controls before writing`, async () => {
    for (const change of ['replacement', 'ask', 'control']) {
      const f = agentMessageHost(agent);
      f.beforeNative(() => {
        if (change === 'replacement') f.replace();
        if (change === 'ask') f.setAsks(true);
        if (change === 'control') f.setControl(true);
      });
      const result = await f.host.sendAgentMessage(
        { ...f.request, params: { ...f.request.params, delivery: 'auto' } },
        f.binding(),
      );
      assert.equal(result.status, change === 'replacement' ? 'refused' : 'queued');
      assert.deepEqual(f.reads, []);
      assert.equal(f.policy.messageRefusal('target'), null, 'a proven pre-write change creates no uncertainty block');
    }
  });
  test(`${agent} queues an explicit message to an unrelated busy offscreen target with unparsed history and unclaimed comments`, async () => {
    const f = agentMessageHost(agent);
    const requests = new SessionWriteRequests('window');
    let release!: () => void;
    f.persist(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    let returned = false;
    const admit = requests
      .runGuarded(f.request.id, f.request, () => f.host.queueAgentMessage(f.request, f.binding()))
      .then((result: any) => {
        returned = true;
        return result;
      });
    await vi.waitFor(() => assert.ok(release));
    assert.equal(returned, false);
    assert.deepEqual(f.reads, []);
    assert.equal(f.host.stored.target[0].origin, 'agent');
    assert.equal(f.host.stored.target[0].delivery.phase, 'recovery');
    release();
    f.persist(async () => {});
    const admitted = await admit;
    assert.equal(admitted.status, 'queued');
    assert.equal(admitted.payloadSha256, payloadSha256(f.text));
    assert.deepEqual(f.reads, []);
    assert.equal(f.host.agentMessages.size, 1);
    f.setBusy(false);
    f.host.flushQueue('target');
    await vi.waitFor(() => assert.equal(f.host.agentMessages.size, 0));
    assert.deepEqual(f.reads, [f.text]);
    assert.deepEqual(f.host.queues.target, []);
    assert.equal(f.host.drafts.target, 'reader draft');
    assert.equal(f.host.saved.comments.length, 1);
    assert.deepEqual(
      await requests.runGuarded(f.request.id, f.request, () => assert.fail('retry recreated queue entry')),
      admitted,
    );
  });
  test(`${agent} retains unknown messages and blocks another requester without granting parent ownership`, async () => {
    const f = agentMessageHost(agent);
    f.setOutcome('unknown');
    await f.host.queueAgentMessage(f.request, f.binding());
    f.setBusy(false);
    f.host.flushQueue('target');
    await vi.waitFor(() => assert.equal(f.host.queues.target[0].delivery.phase, 'recovery'));
    assert.equal(f.host.agentMessages.size, 0);
    assert.equal(f.policy.owner('target'), null);
    const next = await f.host.queueAgentMessage(
      { ...f.request, id: 'window:other', requester: 'another-agent' },
      f.binding(),
    );
    assert.equal(next.status, 'refused');
    assert.match(next.reason, /unknown outcome/);
    assert.deepEqual(f.reads, [f.text]);
    f.policy.invalidate('target');
    assert.ok(f.policy.messageRefusal('target'));
    f.policy.intervene('target');
    assert.equal(f.policy.messageRefusal('target'), null);
  });
  test(`${agent} never sends a retained message to a replacement child or across a final native ownership change`, async () => {
    for (const change of ['before-drain', 'before-write'] as const) {
      const f = agentMessageHost(agent);
      await f.host.queueAgentMessage(f.request, f.binding());
      if (change === 'before-drain') f.replace();
      else f.beforeNative(() => f.replace());
      f.setBusy(false);
      f.host.flushQueue('target');
      await vi.waitFor(() => assert.equal(f.host.queues.target[0].delivery.phase, 'recovery'));
      assert.deepEqual(f.reads, []);
      assert.equal(f.host.agentMessages.size, 0);
    }
  });
  test(`${agent} keeps messages waiting for asks and controls and preserves FIFO`, async () => {
    const f = agentMessageHost(agent);
    f.host.queues.target = queueSubmissionAfter([], randomUUID(), 'earlier reader', [], [], 1, false, {
      agent,
      owner: 'target',
    });
    await f.host.queueAgentMessage(f.request, f.binding());
    f.host.queues.target = queueSubmissionAfter(f.host.queues.target, randomUUID(), 'later reader', [], [], 2, false, {
      agent,
      owner: 'target',
    });
    assert.deepEqual(
      f.host.queues.target.map((one: any) => one.text),
      ['earlier reader', f.text, 'later reader'],
    );
    f.host.queues.target.shift();
    f.setBusy(false);
    f.setAsks(true);
    f.host.flushQueue('target');
    assert.deepEqual(f.reads, []);
    f.setAsks(false);
    f.setControl(true);
    f.host.flushQueue('target');
    assert.deepEqual(f.reads, []);
    f.setControl(false);
    f.host.flushQueue('target');
    await vi.waitFor(() => assert.deepEqual(f.reads, [f.text]));
    assert.equal(f.host.queues.target[0].text, 'later reader');
  });
}

test('message save refusal releases admission while uncertain publication retains recovery', async () => {
  for (const uncertain of [false, true]) {
    const f = agentMessageHost('claude');
    f.persist(async () => {
      throw uncertain ? new ReadPersistenceUnknownError() : new Error('storage refused');
    });
    const result = await f.host.queueAgentMessage(f.request, f.binding());
    assert.equal(result.status, uncertain ? 'unknown' : 'refused');
    assert.equal(f.host.agentMessages.size, 0);
    assert.equal(f.host.queues.target.length, uncertain ? 1 : 0);
    if (uncertain) assert.equal(f.host.queues.target[0].delivery.phase, 'recovery');
    assert.deepEqual(f.reads, []);
  }
});

test('Drop removes message authority and an identical request never recreates the dropped entry', async () => {
  const f = agentMessageHost('claude');
  const requests = new SessionWriteRequests('window');
  const result: any = await requests.runGuarded(f.request.id, f.request, () =>
    f.host.queueAgentMessage(f.request, f.binding()),
  );
  let directed = 0;
  f.host.onReaderDirected = () => directed++;
  f.host.dequeue(result.queuedSubmissionId, 'target');
  assert.equal(directed, 1);
  assert.equal(f.host.agentMessages.size, 0);
  assert.equal(f.host.queues.target, undefined);
  assert.deepEqual(
    await requests.runGuarded(f.request.id, f.request, () => assert.fail('Drop recreated message')),
    result,
  );
  assert.deepEqual(f.reads, []);
});

test('self messages, archived or absent scope, reset and capacity never gain a queue entry', async () => {
  for (const blocked of ['self', 'scope', 'membership', 'archived', 'reset', 'capacity']) {
    const f = agentMessageHost('codex');
    if (blocked === 'self') f.request.requester = 'target';
    if (blocked === 'scope') f.host.repositoryScopeReady = false;
    if (blocked === 'membership') f.host.membershipOf = () => 'unknown';
    if (blocked === 'archived') {
      const facts = f.host.guardedTargetFacts;
      f.host.guardedTargetFacts = () => ({ ...facts(), archived: true });
    }
    if (blocked === 'reset') f.host.clearSettlements.set('target', {});
    if (blocked === 'capacity')
      for (let i = 0; i < 100; i++)
        f.host.queues.target = queueSubmissionAfter(
          f.host.queues.target ?? [],
          randomUUID(),
          'reader',
          [],
          [],
          1,
          false,
          { agent: 'codex', owner: 'target' },
        );
    const result = await f.host.queueAgentMessage(f.request, f.binding());
    assert.equal(result.status, 'refused', blocked);
    assert.equal(f.host.agentMessages.size, 0);
    assert.deepEqual(f.reads, []);
  }
});

test('a queued message clears the reader-work wait before deferred compaction without granting reader authority', async () => {
  const f = agentMessageHost('codex');
  await f.host.queueAgentMessage(f.request, f.binding());
  // Deferred compaction consults this production port before acquiring native input.
  assert.equal(f.host.readerWork('target'), 'pending');
  f.setBusy(false);
  f.host.flushQueue('target');
  await vi.waitFor(() => assert.equal(f.host.agentMessages.size, 0));
  assert.equal(f.host.readerWork('target'), 'none');
  assert.deepEqual(f.reads, [f.text]);
  assert.equal(f.policy.owner('target'), null);
});

test('proven message-save refusal cannot return through an overlapping unrelated save and restored queues', async () => {
  for (const cleanupUnknown of [false, true]) {
    const f = agentMessageHost('claude');
    Object.assign(f.host, { assets: {}, draftCommentIds: {}, sentPrompts: {}, promptsBySession: new Map() });
    f.host.saved = { read: [], readTo: {}, since: 0, queues: {}, comments: f.host.saved.comments };
    let durable: any = structuredClone(f.host.saved);
    let rejectAdmission!: (error: Error) => void;
    let saves = 0;
    const owner = new HostReadPersistence<any>(
      durable,
      async (state) => {
        saves++;
        if (saves === 1)
          await new Promise<void>((_resolve, reject) => {
            rejectAdmission = reject;
          });
        durable = structuredClone(state);
        return saves === 3 && cleanupUnknown ? { status: 'unknown' as const } : undefined;
      },
      async () => {},
    );
    f.host.readOwner = () => owner;
    delete f.host.writeDrafts;
    const admission = f.host.queueAgentMessage(f.request, f.binding());
    await vi.waitFor(() => assert.ok(rejectAdmission));
    f.host.saved.comments.push({ id: 'later-comment', sessionId: 'target', text: 'unrelated reader change' });
    const overlapping = f.host.persistHostState();
    rejectAdmission(new Error('storage refused'));
    const result = await admission;
    await overlapping;
    assert.equal(result.status, cleanupUnknown ? 'unknown' : 'refused');
    assert.deepEqual(f.reads, []);
    assert.equal(durable.comments.length, 2);
    if (cleanupUnknown) {
      assert.equal(f.host.queues.target[0].text, f.text);
      assert.equal(f.host.queues.target[0].delivery.phase, 'recovery');
      assert.equal(f.host.saved.queues.target[0].text, f.text);
      assert.equal(f.host.saved.queues.target[0].delivery.phase, 'recovery');
    } else {
      assert.deepEqual(normalizeQueuedSubmissions(durable.queues), {});
      assert.deepEqual(f.host.saved.queues, {});
    }
    assert.equal(f.host.agentMessages.size, 0);
  }
});

test('idle agent messages wait for production panel staging and control facts until their settlement', async () => {
  for (const blocker of ['staging', 'control']) {
    const f = agentMessageHost('codex');
    f.setBusy(false);
    const source = { sessionId: 'target', agent: 'codex', file: __filename };
    Object.assign(f.host, {
      readScopeKey: () => 'scope',
      folders: () => [],
      repositoryScope: { snapshot: () => ({ roots: [] }) },
      authoritativeCatalogScope: '[]',
      authoritativeCatalog: [source],
      sessionPageIndexFor: () => ({ scoped: [source] }),
      railStatuses: () => ({ statuses: new Map([['target', 'idle']]) }),
    });
    delete f.host.guardedTargetFacts;
    if (blocker === 'staging') {
      f.host.staging.add('target');
      f.host.stagingTokens.set('target', 'attachment');
    } else f.host.live.target = [{ kind: 'compact', at: 1, text: '' }];
    let attempts = 0;
    f.persist(async () => {
      if (f.host.queues.target?.[0]?.delivery.phase === 'delivery') attempts++;
    });
    const result = await f.host.queueAgentMessage(f.request, f.binding());
    assert.equal(result.status, 'queued');
    assert.equal(f.host.queues.target[0].delivery.phase, 'queued');
    assert.equal(attempts, 0);
    assert.equal(f.host.agentMessages.size, 1);
    assert.deepEqual(f.reads, []);
    if (blocker === 'staging') f.host.releaseStaging('target', 'attachment');
    else f.host.livePressAnswered('target', 1, { delivered: false, reason: 'control ended' });
    await vi.waitFor(() => assert.equal(f.host.agentMessages.size, 0));
    assert.equal(attempts, 1);
    assert.deepEqual(f.reads, [f.text]);
  }
});

test('hosted child exit leaves an ordinary reader queue entry waiting without a launch', async () => {
  const f = agentMessageHost('claude');
  f.host.queues.target = queueSubmissionAfter([], randomUUID(), 'reader message', [], [], 1, false, {
    agent: 'claude',
    owner: 'target',
  });
  let launches = 0;
  f.host.onReaderAction = () => {};
  f.host.onReaderDirected = () => {};
  f.host.send = () => {
    launches++;
  };
  const file = ts.createSourceFile(
    'extension.ts',
    fs.readFileSync(path.join(__dirname, 'extension.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  let callback!: ts.Expression;
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === 'onStateChange') callback = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(callback);
  const scope = {
    panel: f.host,
    policyMoves: new Map(),
    policies: { forgetClear: () => {} },
    compaction: undefined,
    commandStateChanges: new Set(),
    publishCommands: () => {},
    updateAgentAffordance: () => {},
    usageReads: { failDeferred: () => {} },
    publishHostedSessions: () => {
      f.setBusy(false);
    },
  };
  f.host.invalidateContext = () => {};
  f.host.releaseDeliveredPromptAssets = () => {};
  f.host.noteRemoteControlOff = () => {};
  f.host.initialNamesChanged = () => {};
  const compiled = transformSync(`return (${callback.getText(file)})`, { loader: 'ts', format: 'cjs' }).code;
  const onStateChange = new Function(...Object.keys(scope), compiled)(...Object.values(scope));
  f.exit();
  onStateChange({ key: 'original-child', sessionId: 'target', agent: 'claude', busy: false, exited: true });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(launches, 0);
  assert.equal(f.host.queues.target[0].delivery.phase, 'queued');
});

test('recovery and Drop release drain markers and unblock compaction and continuation after terminal cleanup', async () => {
  for (const outcome of ['refused', 'unknown'] as const) {
    const f = agentMessageHost('claude');
    f.setOutcome(outcome);
    const result = await f.host.queueAgentMessage(f.request, f.binding());
    f.setBusy(false);
    f.host.flushQueue('target');
    await vi.waitFor(() => assert.equal(f.host.queues.target[0].delivery.phase, 'recovery'));
    assert.equal(f.host.pendingQueueDrains.has('target'), false);
    f.host.pendingQueueDrains.add('target');
    f.host.onReaderDirected = () => f.policy.intervene('target');
    f.host.dequeue(result.queuedSubmissionId, 'target');
    assert.equal(f.host.readerWork('target'), 'none');
    assert.equal(f.host.continuationWork('target'), 'none');
    assert.equal(f.policy.messageRefusal('target'), null);
  }
  const f = agentMessageHost('claude');
  const result = await f.host.queueAgentMessage(f.request, f.binding());
  f.host.queues.target = queueSubmissionAfter(f.host.queues.target, randomUUID(), 'later reader', [], [], 1, false, {
    agent: 'claude',
    owner: 'target',
  });
  f.host.recoverAgentMessage('target', result.queuedSubmissionId, 'needs reader');
  assert.equal(f.host.pendingQueueDrains.has('target'), true);
  assert.equal(f.host.queues.target[1].text, 'later reader');
});

test('Edit releases agent message authority and retained retry preserves the original admission without queue recreation', async () => {
  const f = agentMessageHost('codex');
  f.host.drafts.target = '';
  f.host.saved.comments = [];
  const requests = new SessionWriteRequests('window');
  const result: any = await requests.runGuarded(f.request.id, f.request, () =>
    f.host.queueAgentMessage(f.request, f.binding()),
  );
  const browser = {};
  const offers: any[] = [];
  f.host.sendToHost = async (_host: unknown, message: unknown) => {
    offers.push(message);
    return true;
  };
  f.host.onReaderDirected = () => {};
  f.host.requestQueuedEdit(result.queuedSubmissionId, 'target', 1, browser);
  assert.equal(offers[0].text, f.text);
  f.host.acceptQueuedEdit(result.queuedSubmissionId, 'target', 1, 2, true, browser);
  assert.equal(f.host.agentMessages.size, 0);
  assert.equal(f.host.drafts.target, f.text);
  assert.equal(f.host.queues.target, undefined);
  const [reader] = queueSubmissionAfter([], randomUUID(), f.host.drafts.target, [], [], 1, false, {
    agent: 'codex',
    owner: 'target',
  });
  assert.equal(reader.origin, undefined);
  assert.deepEqual(
    await requests.runGuarded(f.request.id, f.request, () => assert.fail('Edit recreated message')),
    result,
  );
  assert.equal(f.host.queues.target, undefined);
  assert.deepEqual(f.reads, []);
});

// A Claude session that dispatched another session lists the dispatch among its child references. The host and the worker
// agree on the window's relationships, so the newest turn stops loading after one read and later passes reuse it.
test('a selected session with a dispatched child reads its newest turn once', async () => {
  const directory = tempDir('selected-dispatch-');
  const file = path.join(directory, 'selected.jsonl');
  const childFile = path.join(directory, 'dispatched.jsonl');
  const transcript = (sessionId: string, text: string) =>
    [
      {
        type: 'user',
        uuid: `${sessionId}-u`,
        sessionId,
        timestamp: '2026-10-27T06:00:00.000Z',
        message: { role: 'user', content: text },
      },
      {
        type: 'assistant',
        uuid: `${sessionId}-a`,
        sessionId,
        timestamp: '2026-10-27T06:00:05.000Z',
        message: {
          id: `${sessionId}-m`,
          role: 'assistant',
          model: 'claude-opus-5-5',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: `answered ${text}` }],
          usage: { input_tokens: 2, output_tokens: 4 },
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n';
  fs.writeFileSync(file, transcript('selected', 'dispatch a review'));
  fs.writeFileSync(childFile, transcript('dispatched', 'review the change'));
  const worker = titleWorker();
  const kinds: string[] = [];
  const provider = selectedWindowHarness(
    (request, generation, signal) => {
      kinds.push(request.kind);
      return worker.run(request, generation, signal);
    },
    [
      'progressiveCurrent',
      'agentFactsCurrent',
      'progressiveInput',
      'structuralKey',
      'claudeStructuralKey',
      'agentSpendKey',
      'codexStructuralChildren',
    ],
  );
  try {
    provider.session = {
      file,
      sessionId: 'selected',
      agent: 'claude',
      ...revisionOf(fs.statSync(file, { bigint: true })),
    };
    // A subagent, its own nested subagent and a resolved child keep their places in the key beside the dispatch.
    const subagentFile = path.join(directory, 'agent-task.jsonl');
    fs.writeFileSync(subagentFile, transcript('agent-task', 'check the tests'));
    provider.claudeChildren = [
      {
        file: subagentFile,
        sessionId: 'agent-task',
        agent: 'claude',
        parentSessionId: 'selected',
        toolUseIds: ['toolu_task'],
        childTranscript: true,
        agentRun: true,
        cwd: directory,
        ...revisionOf(fs.statSync(subagentFile, { bigint: true })),
      },
    ];
    provider.claudeChildReferences = [
      {
        kind: 'dispatch',
        agent: 'claude',
        parentSessionId: 'selected',
        sessionId: 'dispatched',
        file: childFile,
        toolUseIds: ['toolu_dispatch'],
        name: null,
        owned: true,
      },
      { parentSessionId: 'selected', sessionId: 'agent-task', file: subagentFile, toolUseIds: ['toolu_task'] },
      { parentSessionId: 'agent-task', sessionId: 'agent-nested', file: subagentFile, toolUseIds: ['toolu_nested'] },
    ];
    provider.codexSubagents = [];
    await provider.completeSelectedWindow('selected', 1);
    assert.equal(provider.lastError, null);
    assert.deepEqual(kinds, ['window'], 'the selection did not read its newest turn');
    assert.ok(provider.progressiveCurrent(provider.session), 'the newest turn stayed loading after its window read');
    assert.ok(
      provider.agentFactsCurrent(provider.session),
      'the child figures of the newest turn stayed stale after its read',
    );
    await provider.completeSelectedWindow('selected', 1);
    assert.deepEqual(kinds, ['window'], 'a later pass read the unchanged newest turn again');
  } finally {
    worker.stop();
  }
});
