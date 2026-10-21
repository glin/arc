import { describe, test, vi } from 'vitest';
import {
  costStateDependency,
  reconcileClaudeCostState,
  CLAUDE_COST_STATE_SNAPSHOTS,
  CLAUDE_COST_STATE_MODELS,
  type ClaudeCostProgress,
  validClaudeCostProgress,
  CLAUDE_COST_STATE_BYTES,
} from './claudecoststate';
import { claudeCostState } from './turnfixtures';
import { claudeCostStateDependencies, invalidateClaudeCostSupplements } from './projectspend';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  PROJECT_SPEND_INTEGRITY_MILLISECONDS,
  PROJECT_SPEND_HELD_LINE_BYTES,
  PROJECT_SPEND_PARSER_GENERATION,
  spendRecordHoldsLongLine,
  sessionCacheFactsBySession,
  SessionFiguresCache,
  aggregateUsageEvents,
  cacheExpiryExtraCost,
  discoverClaudeSessionSpendSources,
  discoverClaudeSpendSources,
  discoverCodexSessionSpendSources,
  discoverCodexSpendSources,
  formatProjectCost,
  indexSpendFile,
  invalidateSpendFileNormalization,
  loadSpendLedger,
  normalizeSpendFile,
  normalizeWorkspace,
  prepareProjectSpendView,
  projectSpendDisplayFiles,
  projectSpendHistoryCutoff,
  projectSpendOfferDecision,
  projectSpendSourceOfferDue,
  projectSpendWindows,
  pruneSpendFiles,
  pruneSpendFilesWithResult,
  publicProjectSpendPrice,
  saveSpendLedger,
  SessionSpendSourceIndex,
  sessionLifetimeDisplayFiles,
  sessionRailFactsBySession,
  sessionSpendBySession,
  sessionSpendPartsBySession,
  spendSourceHeld,
  withDispatchedSpendSources,
  dispatchedSpendPartsBySession,
  type SessionSpendPart,
  type SessionSpendCoverage,
  sessionTurnStatsBySession,
  spendFileIsClaudeChild,
  spendRecordAgent,
  spendRecordChangesRail,
  spendRecordHasLifetimeFacts,
  SUBAGENT_DIRECTORY_SETTLE_MS,
  SubagentDirectoryCache,
  type ProjectUsageBucket,
  type SessionSpendSource,
  type SpendChildFile,
  type SpendSessionFile,
  type SpendFileIndex,
  type UsageEvent,
  type UsageCounts,
  type UsageReducerFactory,
} from './projectspend.ts';
import { RETAINED_COMPACTIONS, RETAINED_REQUESTS, retainedParserPayload } from './parserstate.ts';
import {
  CLAUDE_COMPACTION_INSTRUCTION_TOKENS,
  CLAUDE_COMPACTION_SUMMARY_CHARS_PER_TOKEN,
  estimateCompactionCost,
  estimateCost,
  MODEL_DEFINITIONS,
  type ModelDefinition,
} from './pricing.ts';
import {
  readClaudeHistoryPage,
  readClaudeHistoryPageAsync,
  readClaudeSessionIncremental,
  readClaudeSessionIncrementalAsync,
} from './claudehistory.ts';
import { costDetail, sessionCostProjection, sessionCostUsageOf, toCompactionCard, turnCost } from './turncard.ts';
import { dispatchedParents, sessionParentIndex } from './turnrail.ts';
import {
  COMPACTION_SAMPLES,
  ADVISOR_MODEL,
  ADVISOR_MODEL_USAGE,
  advisorIteration,
  advisorProbeRecords,
  advisorResponseRecords,
  MIXED_PASS_ITERATIONS,
  PER_PASS_ITERATIONS,
  claudeCompactionTranscript,
  previousContextOf,
  subagent,
  turn,
  type ClaudeCompactionTranscriptOptions,
} from './turnfixtures.ts';
import {
  claudeUsage,
  createClaudeUsageLineReducer,
  emptyClaudeUsageReducerState,
  readClaudeAgentSpend,
  readSession,
  type ClaudeUsageReducerState,
  type Compaction,
  type SessionRead,
} from './transcript.ts';
import { emptyUsage } from './agentspend.ts';
import { CODEX_USAGE_ASSOCIATION_LIMIT, createCodexUsageLineReducer, emptyCodexUsageReducerState } from './codex.ts';
import { tempDir } from './temproot.ts';

const dir = () => tempDir('project-spend-');
const usage = () => ({
  input: 1,
  cacheWrite1h: 0,
  cacheWrite5m: 0,
  cacheWrite30m: 0,
  cacheRead: 0,
  output: 1,
  thinking: 0,
});
const event = (timestamp: number, more: Partial<UsageEvent> = {}): UsageEvent => ({
  timestamp,
  agent: 'Claude',
  provider: 'anthropic',
  model: 'model',
  contextWindow: null,
  billingClass: 'metered',
  inferenceClass: null,
  serviceTier: null,
  reportedCost: null,
  usage: usage(),
  requestKey: null,
  ...more,
});
const reducer: UsageReducerFactory<ClaudeUsageReducerState> = (state) => {
  let lines = state?.closedTurns ?? 0;
  return {
    parserKind: 'claude',
    pushLine(line) {
      lines++;
      return line ? [JSON.parse(line) as UsageEvent] : [];
    },
    snapshot: () => ({
      seenRequestKeys: [],
      closedTurns: lines,
      openTurn: false,
      openTurnAnswered: false,
      compactionCount: 0,
      recentCompactions: [],
      visibleTurns: 0,
      firstTurnAt: null,
      currentTurnStartedAt: null,
      currentTurnEndedAt: null,
      currentTurnOutcome: null,
    }),
  };
};
const stamp = (value: string) => new Date(value).getTime();

test('literal native spend generation 30 rebuilds an unchanged zero-usage decision', () => {
  const folder = dir();
  const file = path.join(folder, 'native.jsonl');
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const records = [
    {
      type: 'session_meta',
      timestamp: at(10),
      payload: {
        id: 'native',
        session_id: 'parent',
        parent_thread_id: 'parent',
        timestamp: at(0),
        model_provider: 'openai',
        thread_source: 'subagent',
        source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } },
      },
    },
    {
      type: 'event_msg',
      timestamp: at(11),
      payload: { type: 'task_started', turn_id: 'own', started_at: stamp(at(1)) / 1000 },
    },
    { type: 'turn_context', timestamp: at(12), payload: { turn_id: 'own', model: 'gpt-6-astra', effort: 'high' } },
    {
      type: 'event_msg',
      timestamp: at(13),
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 1000, output_tokens: 100 },
        },
      },
    },
  ];
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const current = indexSpendFile(undefined, file, 'workspace', createCodexUsageLineReducer, 1).record;
  const state = structuredClone(current.parserState as ReturnType<typeof emptyCodexUsageReducerState>);
  state.openingTimestamp = stamp(at(10));
  state.currentTurnCopied = true;
  state.copiedTurnIds.own = true;
  state.nativeSpawnedAt = null;
  const stale = {
    ...current,
    parserGeneration: 30,
    buckets: [],
    lifetimeBuckets: [],
    turnCount: 0,
    firstTurnAt: null,
    lastTurnAt: null,
    newestTurnStartedAt: null,
    outcome: null,
    parserState: state,
  };
  const result = indexSpendFile(stale, file, 'workspace', createCodexUsageLineReducer, 2);
  assert.equal(result.rebuilt, true);
  assert.deepEqual(result.record.lifetimeBuckets, current.lifetimeBuckets);
  assert.equal(result.record.turnCount, 1);
  const targetState = emptyCodexUsageReducerState('openai', stamp(at(10)), 'native');
  Object.assign(targetState, {
    currentTurnId: 'own',
    currentTurnCopied: true,
    recentTurnIds: ['own'],
    seenTurnIds: { own: true },
    copiedTurnIds: { own: true },
  });
  const frozenTargetState = { ...targetState } as Record<string, unknown>;
  for (const key of ['nativeSpawnedAt', 'pendingOwnership', 'currentTurnRepeated']) delete frozenTargetState[key];
  for (const parserGeneration of [31, 32]) {
    const targetResult = indexSpendFile(
      {
        ...stale,
        parserGeneration,
        parserState: frozenTargetState as unknown as ReturnType<typeof emptyCodexUsageReducerState>,
      },
      file,
      'workspace',
      createCodexUsageLineReducer,
      2,
    );
    assert.equal(targetResult.rebuilt, true, `generation ${parserGeneration} kept the unchanged native source empty`);
    assert.deepEqual(targetResult.record.lifetimeBuckets, current.lifetimeBuckets);
    assert.equal(targetResult.record.turnCount, 1);
  }
});

test('unconfirmed native spend keeps project totals unknown through a saved checkpoint', () => {
  const folder = dir();
  const file = path.join(folder, 'native.jsonl');
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const records = [
    {
      type: 'session_meta',
      timestamp: at(10),
      payload: {
        id: 'native',
        session_id: 'parent',
        parent_thread_id: 'parent',
        timestamp: new Date(stamp(at(0)) + 750).toISOString(),
        model_provider: 'openai',
        thread_source: 'subagent',
        source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } },
      },
    },
    {
      type: 'event_msg',
      timestamp: at(11),
      payload: { type: 'task_started', turn_id: 'own', started_at: stamp(at(0)) / 1000 },
    },
    { type: 'turn_context', timestamp: at(12), payload: { turn_id: 'own', model: 'gpt-6-astra', effort: 'high' } },
    {
      type: 'event_msg',
      timestamp: at(13),
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 1000, output_tokens: 100 },
        },
      },
    },
  ];
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const current = indexSpendFile(undefined, file, 'workspace', createCodexUsageLineReducer, stamp(at(14))).record;
  saveSpendLedger(folder, 'workspace', [current]);
  const loaded = loadSpendLedger(folder, 'workspace').files;
  assert.equal(loaded.length, 1);
  const view = prepareProjectSpendView(loaded, publicProjectSpendPrice, { now: stamp(at(14)) });
  assert.equal(view.windows[0].dollars, null);
  assert.equal(view.windows[0].status, 'unknown');
  // Push the unconfirmed opening request beyond the reducer's association horizon.
  const later = Array.from({ length: CODEX_USAGE_ASSOCIATION_LIMIT + 1 }, (_, ordinal) => {
    const turnId = `later-${ordinal}`;
    return [
      { type: 'event_msg', timestamp: at(20 + ordinal), payload: { type: 'task_started', turn_id: turnId } },
      { type: 'turn_context', timestamp: at(20 + ordinal), payload: { turn_id: turnId, model: 'gpt-6-astra' } },
      {
        type: 'event_msg',
        timestamp: at(20 + ordinal),
        payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 2000, output_tokens: 100 } } },
      },
      { type: 'event_msg', timestamp: at(20 + ordinal), payload: { type: 'task_complete', turn_id: turnId } },
    ];
  }).flat();
  fs.appendFileSync(file, later.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const evicted = indexSpendFile(current, file, 'workspace', createCodexUsageLineReducer, stamp(at(100))).record;
  assert.ok(evicted.lifetimeBuckets!.some((bucket) => bucket.incomplete));
  saveSpendLedger(folder, 'workspace', [evicted]);
  const restored = loadSpendLedger(folder, 'workspace').files;
  assert.equal(restored.length, 1);
  const sources = [{ sessionId: 'native', file, primary: true }];
  const coverage = new Map<string, SessionSpendCoverage>();
  const parts = sessionSpendPartsBySession(restored, sources, undefined, undefined, coverage).native;
  assert.equal(
    parts.reduce((sum, part) => sum + part.bucket.usage.input, 0),
    2000 * (CODEX_USAGE_ASSOCIATION_LIMIT + 1),
  );
  assert.equal(sessionCostProjection(parts.map(sessionCostUsageOf), coverage.get('native')).total.partial, true);
});

test('spend path normalization resolves the same input only once', () => {
  const folder = dir();
  const file = path.join(folder, 'source.jsonl');
  fs.writeFileSync(file, '');
  const nativeRealpath = fs.realpathSync.native;
  let realpathCalls = 0;
  vi.spyOn(fs.realpathSync, 'native').mockImplementation((candidate: fs.PathLike) => {
    realpathCalls++;
    return nativeRealpath(candidate);
  });

  assert.equal(normalizeSpendFile(file), normalizeSpendFile(file));
  assert.equal(realpathCalls, 1);
});

test('missing source validation invalidates its normalized path', () => {
  const folder = dir();
  const file = path.join(folder, 'source.jsonl');
  fs.writeFileSync(file, '');
  const nativeRealpath = fs.realpathSync.native;
  let realpathCalls = 0;
  vi.spyOn(fs.realpathSync, 'native').mockImplementation((candidate: fs.PathLike) => {
    realpathCalls++;
    return nativeRealpath(candidate);
  });

  normalizeSpendFile(file);
  fs.unlinkSync(file);
  assert.equal(indexSpendFile(undefined, file, 'w', reducer, 1).found, false);
  fs.writeFileSync(file, '');
  normalizeSpendFile(file);
  assert.equal(realpathCalls, 2);
  invalidateSpendFileNormalization(file);
  normalizeSpendFile(file);
  assert.equal(realpathCalls, 3);
});

// Calculate one session's lifetime figures from its spend sources.
function sessionFactsOf(
  sessionId: string,
  files: readonly SpendFileIndex[],
  sources: readonly SessionSpendSource[],
  pending?: (file: string, record: SpendFileIndex | undefined) => boolean,
) {
  const awaiting = new Set<string>();
  const parts = sessionSpendPartsBySession(files, sources, awaiting, pending)[sessionId];
  const turns = sessionTurnStatsBySession(files, sources)[sessionId];
  const cache = sessionCacheFactsBySession(files, sources)[sessionId];
  return parts || turns || cache
    ? { parts: parts ?? null, awaiting: awaiting.has(sessionId), turns: turns ?? null, cache: cache ?? null }
    : undefined;
}

// Recalculate lifetime figures for all sessions from the complete project sources.
function projectFactsOf(files: readonly SpendFileIndex[], sources: readonly SessionSpendSource[]) {
  const awaiting = new Set<string>();
  const parts = sessionSpendPartsBySession(files, sources, awaiting);
  const turns = sessionTurnStatsBySession(files, sources);
  const cache = sessionCacheFactsBySession(files, sources);
  const ids = new Set([...Object.keys(parts), ...Object.keys(turns), ...Object.keys(cache)]);
  return Object.fromEntries(
    [...ids].map((id) => [
      id,
      { parts: parts[id] ?? null, awaiting: awaiting.has(id), turns: turns[id] ?? null, cache: cache[id] ?? null },
    ]),
  );
}

function sessionFiguresReader() {
  const cache = new SessionFiguresCache<NonNullable<ReturnType<typeof sessionFactsOf>>, object>();
  const calculated: string[] = [];
  const read = (
    files: readonly SpendFileIndex[],
    sources: readonly SessionSpendSource[],
    pending?: (file: string, record: SpendFileIndex | undefined) => boolean,
  ) =>
    cache.read(
      files,
      sources,
      (sessionId, own, from, reads) => {
        calculated.push(sessionId);
        return sessionFactsOf(sessionId, own, from, reads);
      },
      (figures) => Object.fromEntries(figures),
      pending,
    );
  return { read, calculated };
}

function lifetimeRecord(file: string, tokens: number, whole = true): SpendFileIndex {
  return {
    file,
    workspace: 'w',
    size: tokens,
    mtimeMs: tokens,
    offset: tokens,
    trailing: '',
    buckets: [],
    lifetimeBuckets: [{ agent: 'claude', model: 'm', usage: { input: tokens } } as unknown as ProjectUsageBucket],
    turnCount: tokens,
    compactionCount: 0,
    firstTurnAt: 1,
    lastTurnAt: tokens,
    cacheExpiry: {
      facts: {
        counts: { '5m': tokens, '30m': 0, '1h': 0 },
        longestGapMs: null,
        returns: [],
        excluded: 0,
        unavailable: 0,
        truncated: false,
      },
      compactions: [],
    } as unknown as SpendFileIndex['cacheExpiry'],
    indexedAt: tokens,
    complete: whole,
  };
}

test('held lifetime figures copy the record list, which the ledger edits in place', () => {
  const { read, calculated } = sessionFiguresReader();
  const sources: SessionSpendSource[] = [{ sessionId: 'a', file: 'a.jsonl', primary: true }];
  const files = [lifetimeRecord('a.jsonl', 1)];
  const first = read(files, sources);
  assert.equal(read([files[0]], sources), first);
  files[0] = lifetimeRecord('a.jsonl', 2);
  assert.notEqual(read(files, sources), first);
  assert.deepEqual(calculated, ['a', 'a']);
});

test('shared child supplements reject either parent-child recency direction after the child changes', () => {
  const now = stamp('2026-08-31T12:00:00');
  const [bucket] = aggregateUsageEvents([event(stamp('2026-08-31T10:00:00'))]);
  const supplement = (parent: SpendFileIndex, child: SpendFileIndex) => ({
    identity: `${parent.file}:${child.file}`,
    dependencies: [costStateDependency(parent), costStateDependency(child, 1)],
    snapshots: [],
    lifetime: [],
    dated: [bucket],
    lifetimeAllocations: [],
    datedAllocations: [],
  });
  for (const [parentMtime, childMtime] of [
    [2, 1],
    [1, 2],
  ]) {
    const child = lifetimeRecord('shared-child.jsonl', childMtime);
    const left = lifetimeRecord(`left-${parentMtime}-${childMtime}.jsonl`, parentMtime);
    const right = lifetimeRecord(`right-${parentMtime}-${childMtime}.jsonl`, parentMtime + 10);
    const files = [
      { ...left, costStateSupplement: supplement(left, child) },
      { ...right, costStateSupplement: supplement(right, child) },
      child,
    ];
    const price = () => ({
      dollars: 1,
      source: 'test',
      effectiveDate: null,
      estimated: false,
      provenance: 'public' as const,
    });
    assert.equal(prepareProjectSpendView(files, price, { now }).windows[0].dollars, 2);
    const changed = files.map((file) => (file.file === child.file ? { ...file, mtimeMs: file.mtimeMs + 1 } : file));
    assert.equal(prepareProjectSpendView(changed, price, { now }).windows[0].dollars, 0);
  }
});

// Queue changes recalculate sessions with unread dispatched sources. Other unread sources retain their existing figures.

test('a source the ledger queues or lets go recalculates only the sessions it was dispatched to', () => {
  const { read, calculated } = sessionFiguresReader();
  const sources: SessionSpendSource[] = [
    { sessionId: 'parent', file: 'parent.jsonl', primary: true },
    { sessionId: 'parent', file: 'child.jsonl', primary: false, dispatchedFrom: 'child' },
    { sessionId: 'other', file: 'other.jsonl', primary: true },
    { sessionId: 'other', file: 'other-agent.jsonl', primary: false },
    { sessionId: 'quiet', file: 'quiet.jsonl', primary: true },
  ];
  const files = ['parent.jsonl', 'other.jsonl', 'quiet.jsonl'].map((file) => lifetimeRecord(file, 1));
  // The ledger queues a file under its resolved path.
  const queued = new Set(['child.jsonl', 'other-agent.jsonl'].map(normalizeSpendFile));
  const pending = (file: string) => queued.has(file);
  const first = read(files, sources, pending) as Record<string, { awaiting: boolean }>;
  assert.equal(first.parent.awaiting, true, 'a queued dispatched source left its parent whole');
  assert.deepEqual(calculated.splice(0), ['parent', 'other', 'quiet']);
  assert.equal(read(files, sources, pending), first, 'an unchanged queue moved the figures');
  queued.delete(normalizeSpendFile('other-agent.jsonl'));
  assert.equal(read(files, sources, pending), first, 'a queue change no dispatched source sees moved the figures');
  queued.delete(normalizeSpendFile('child.jsonl'));
  const settled = read(files, sources, pending) as Record<string, { awaiting: boolean }>;
  assert.equal(settled.parent.awaiting, false, 'a dispatched source the ledger let go kept its parent a lower bound');
  assert.deepEqual(calculated, ['parent'], 'a queue change recalculated a session with no unread dispatched source');
});

// A partially read dispatched source marks its parent while queued. An unfinished last line keeps that mark until it falls outside the history limit.

test('a dispatched source read in part lets its parent go once the ledger stops queueing it', () => {
  const sources: SessionSpendSource[] = [
    { sessionId: 'parent', file: 'parent.jsonl', primary: true },
    { sessionId: 'parent', file: 'child.jsonl', primary: false, dispatchedFrom: 'child' },
  ];
  const child = lifetimeRecord('child.jsonl', 7);
  for (const [state, record, cutoff, held] of [
    ['went away during a read', { ...child, complete: false, scanOffset: 3, missingAt: 1 }, null, false],
    ['the history limit now skips', { ...child, complete: false, scanOffset: 3 }, null, false],
    ['is still being written', { ...child, trailing: '{"type":' }, null, true],
    ['stopped mid-line before the history limit', { ...child, trailing: '{"type":' }, child.mtimeMs + 1, false],
  ] as const) {
    const { read } = sessionFiguresReader();
    const files = [lifetimeRecord('parent.jsonl', 1), record];
    let queued = true;
    const pending = (file: string, found: SpendFileIndex | undefined) =>
      spendSourceHeld(found, queued && file.endsWith('child.jsonl'), cutoff);
    type Figures = Record<string, { awaiting: boolean; parts: readonly unknown[] | null }>;
    const reading = (read(files, sources, pending) as Figures).parent;
    assert.equal(reading.awaiting, true, `a queued child that ${state} left its parent whole`);
    assert.equal(reading.parts?.length, 1, `the parent counted a queued child that ${state}`);
    queued = false;
    const settled = (read(files, sources, pending) as Figures).parent;
    assert.equal(settled.awaiting, held, `the parent's mark after the queue cleared, for a child that ${state}`);
    assert.equal(
      settled.parts?.length,
      held ? 1 : 2,
      `the parent's parts after the queue cleared, for a child that ${state}`,
    );
  }
});

test('a grown transcript recalculates the lifetime figures of the one session that reads it', () => {
  const { read, calculated } = sessionFiguresReader();
  const sources: SessionSpendSource[] = ['a', 'b', 'c'].map((id) => ({
    sessionId: id,
    file: `${id}.jsonl`,
    primary: true,
  }));
  const files = sources.map((source) => lifetimeRecord(source.file, 1));
  const first = read(files, sources);
  assert.deepEqual(calculated.sort(), ['a', 'b', 'c']);

  calculated.length = 0;
  // The ledger replaces the record of the file that grew, and keeps the other two.
  const grown = [files[0], lifetimeRecord('b.jsonl', 2), files[2]];
  const moved = read(grown, sources);
  assert.deepEqual(calculated, ['b'], `one grown transcript recalculated ${calculated.length} sessions`);
  assert.notEqual(moved, first);
  assert.deepEqual(moved, projectFactsOf(grown, sources));

  // A source list listed again with the same sources recalculates nothing.
  calculated.length = 0;
  assert.equal(
    read(
      grown,
      sources.map((source) => ({ ...source })),
    ),
    moved,
  );
  assert.deepEqual(calculated, []);

  // A source that changes its role moves its session, though its record is the same.
  const relisted = sources.map((source) => (source.sessionId === 'c' ? { ...source, primary: false } : source));
  assert.deepEqual(read(grown, relisted), projectFactsOf(grown, relisted));
  assert.deepEqual(calculated, ['c']);
});

test('lifetime figures held per session equal a calculation from scratch after any sequence of changes', () => {
  // A small seeded generator, so a failure names a sequence that can be replayed.
  let seed = 0x5eed;
  const random = (below: number) => {
    seed = (seed * 16_807) % 2_147_483_647;
    return Math.floor((seed / 2_147_483_647) * below);
  };
  const sessions = ['a', 'b', 'c', 'd'];
  const paths = [...sessions.map((id) => `${id}.jsonl`), 'a-agent.jsonl', 'b-agent.jsonl', 'orphan.jsonl'];
  const sourcesFor = (layout: number): SessionSpendSource[] => {
    const own = sessions.map((id) => ({ sessionId: id, file: `${id}.jsonl`, primary: true }));
    // A subagent transcript that moves between parents, and a dispatched session counted
    // under the session that dispatched it.
    const agent = { sessionId: sessions[layout % 4], file: 'a-agent.jsonl', primary: layout % 7 === 0 };
    const other = { sessionId: 'b', file: layout % 2 ? 'sub/../b-agent.jsonl' : 'b-agent.jsonl', primary: false };
    const dispatched =
      layout % 3 === 0 ? [{ sessionId: 'a', file: 'd.jsonl', primary: false, dispatchedFrom: 'd' }] : [];
    const listed = layout % 5 === 4 ? own.filter((source) => source.sessionId !== 'c') : own;
    return [...listed, agent, other, ...dispatched];
  };
  const { read, calculated } = sessionFiguresReader();
  let sources = sourcesFor(0);
  let files: SpendFileIndex[] = [];
  let ops = 0;
  let recalculated = 0;
  for (let step = 0; step < 1_000; step++) {
    const change = random(10);
    const file = paths[random(paths.length)];
    const at = files.findIndex((record) => record.file === file);
    if (change < 5) {
      // A record is added or replaced: a transcript grew, or a rescan is part-way.
      const record = lifetimeRecord(file, step + 1, random(6) !== 0);
      files = at < 0 ? [...files, record] : files.map((held, index) => (index === at ? record : held));
    } else if (change < 7) {
      // A prune or a history-limit change drops a record.
      files = files.filter((record) => record.file !== file);
    } else if (change < 9) {
      sources = sourcesFor(random(30));
    } else if (change === 9 && random(4) === 0) {
      // A workspace change starts from an empty ledger.
      files = [];
      sources = sourcesFor(random(30));
    }
    calculated.length = 0;
    assert.deepEqual(read(files, sources), projectFactsOf(files, sources), `step ${step} after change ${change}`);
    ops++;
    recalculated += calculated.length;
  }
  assert.ok(recalculated < ops * sessions.length, 'every change recalculated every session');
  assert.ok(recalculated > 0, 'the sequence changed nothing the figures read');
});

test('lifetime figures follow an alias that resolves to another record after its path is invalidated', () => {
  const alias = 'alias-session.jsonl';
  const [one, two] = ['real-one.jsonl', 'real-two.jsonl'];
  let target = one;
  const nativeRealpath = fs.realpathSync.native;
  vi.spyOn(fs.realpathSync, 'native').mockImplementation((candidate: fs.PathLike) =>
    String(candidate) === path.resolve(alias) ? path.resolve(target) : nativeRealpath(candidate),
  );
  invalidateSpendFileNormalization(alias);
  const { read, calculated } = sessionFiguresReader();
  // Only the resolved path associates this alias with its spend record.
  const sources: SessionSpendSource[] = [
    { sessionId: 'a', file: alias, primary: true },
    { sessionId: 'b', file: 'b.jsonl', primary: true },
  ];
  const files = [lifetimeRecord(one, 1), lifetimeRecord(two, 2), lifetimeRecord('b.jsonl', 3)];
  const before = projectFactsOf(files, sources);
  assert.deepEqual(read(files, sources), before);

  target = two;
  invalidateSpendFileNormalization(alias);
  calculated.length = 0;
  const expected = projectFactsOf(files, sources);
  assert.notDeepEqual(expected, before, 'the alias names the same record after its path was invalidated');
  assert.deepEqual(read(files, sources), expected, 'the figures kept the record the alias named before');
  assert.deepEqual(calculated, ['a']);
});

test('spend source integrity checks leave quiet polls alone', () => {
  assert.equal(projectSpendSourceOfferDue(true, 1, 1), true);
  assert.equal(projectSpendSourceOfferDue(false, PROJECT_SPEND_INTEGRITY_MILLISECONDS - 1, 0), false);
  assert.equal(projectSpendSourceOfferDue(false, PROJECT_SPEND_INTEGRITY_MILLISECONDS, 0), true);
});

test('rail cost refreshes when a source becomes incomplete or completes', () => {
  const record = (complete: boolean): SpendFileIndex => ({
    file: 'source.jsonl',
    workspace: 'workspace',
    size: 1,
    mtimeMs: 1,
    offset: 0,
    trailing: '',
    buckets: [],
    indexedAt: 1,
    complete,
  });
  assert.equal(spendRecordChangesRail(record(true), record(false)), true);
  assert.equal(spendRecordChangesRail(record(false), record(true)), true);
  assert.equal(spendRecordChangesRail(undefined, record(true)), true);
  assert.equal(spendRecordChangesRail(undefined, record(false)), false);
  assert.equal(spendRecordChangesRail(record(false), record(false)), false);
});

test('calendar windows include local days rather than fixed hours', () => {
  const windows = projectSpendWindows(stamp('2026-03-09T12:00:00'));
  assert.deepEqual(
    windows.map((window) => window.start),
    ['2026-03-09', '2026-03-03', '2026-02-08'],
  );
});

test('day windows cross daylight-saving time by calendar date', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/Chicago';
  try {
    const start = new Date(2026, 2, 8).getTime();
    const next = new Date(2026, 2, 9).getTime();
    assert.equal(next - start, 23 * 60 * 60 * 1000);
    assert.equal(projectSpendWindows(next)[1].start, '2026-03-03');
  } finally {
    if (previous === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previous;
    }
  }
});

test('raw buckets retain pricing identity and split before and after midnight', () => {
  const buckets = aggregateUsageEvents([
    event(stamp('2026-08-30T23:59:00')),
    event(stamp('2026-08-31T00:01:00'), { serviceTier: 'priority' }),
  ]);
  assert.equal(buckets.length, 2);
  assert.deepEqual(
    buckets.map((bucket) => bucket.localDate),
    ['2026-08-30', '2026-08-31'],
  );
});

test('raw buckets keep inexact request counts separate from exact requests', () => {
  const at = stamp('2026-08-31T10:00:00');
  const buckets = aggregateUsageEvents([event(at), event(at + 1, { requestCountExact: false })]);
  assert.equal(buckets.length, 2);
  assert.deepEqual(
    buckets.map((bucket) => bucket.requestCountExact),
    [undefined, false],
  );
});

describe('Project cost history limit', () => {
  const now = stamp('2026-08-31T12:00:00');
  const old = stamp('2026-08-01T10:00:00');
  const recent = stamp('2026-08-30T10:00:00');
  const saved = (more: Partial<SpendFileIndex> = {}): SpendFileIndex => ({
    file: 'a',
    workspace: 'w',
    size: 10,
    mtimeMs: old,
    offset: 10,
    trailing: '',
    buckets: [],
    indexedAt: 1,
    lifetimeBuckets: [],
    turnCount: 0,
    compactionCount: 0,
    firstTurnAt: null,
    lastTurnAt: null,
    newestTurnStartedAt: null,
    outcome: null,
    cacheExpiry: undefined,
    parserGeneration: PROJECT_SPEND_PARSER_GENERATION,
    ...more,
  });
  const offers = (cutoff: number | null) => [
    projectSpendOfferDecision(undefined, undefined, cutoff),
    projectSpendOfferDecision(undefined, { size: 10, mtimeMs: old }, cutoff),
    projectSpendOfferDecision(saved(), { size: 10, mtimeMs: old }, cutoff),
    projectSpendOfferDecision(saved(), { size: 20, mtimeMs: old }, cutoff),
    projectSpendOfferDecision(saved({ complete: false }), { size: 10, mtimeMs: old }, cutoff),
    projectSpendOfferDecision(saved(), null, cutoff),
    projectSpendOfferDecision(saved({ missingAt: 1 }), null, cutoff),
    projectSpendOfferDecision(saved({ mtimeMs: recent }), { size: 20, mtimeMs: recent }, cutoff),
  ];
  const buckets = aggregateUsageEvents([
    event(stamp('2026-08-31T10:00:00'), { reportedCost: 1.25 }),
    event(stamp('2026-08-10T10:00:00'), { reportedCost: 3.5 }),
  ]);
  const files = [saved({ buckets, lifetimeBuckets: buckets })];

  test('a limit of 0 offers every source and shows every window as before', () => {
    const cutoff = projectSpendHistoryCutoff(0, now);
    assert.equal(cutoff, null);
    assert.deepEqual(offers(cutoff), ['queue', 'queue', 'current', 'queue', 'queue', 'queue', 'current', 'queue']);
    assert.deepEqual(
      prepareProjectSpendView(files, () => null, { now, historyCutoff: cutoff }),
      prepareProjectSpendView(files, () => null, { now }),
    );
  });

  test('the offer skips a new or saved source that last changed before the limit', () => {
    const cutoff = projectSpendHistoryCutoff(7, now);
    assert.equal(cutoff, now - 7 * 86_400_000);
    assert.deepEqual(offers(cutoff), ['queue', 'skip', 'skip', 'skip', 'skip', 'queue', 'current', 'queue']);
    assert.equal(projectSpendOfferDecision(undefined, { size: 1, mtimeMs: cutoff! }, cutoff), 'queue');
    assert.equal(projectSpendOfferDecision(undefined, { size: 1, mtimeMs: cutoff! - 1 }, cutoff), 'skip');
  });

  test('a window that starts before the limit is a lower bound and a window inside it stays exact', () => {
    const week = prepareProjectSpendView(files, () => null, { now, historyCutoff: projectSpendHistoryCutoff(7, now) });
    assert.deepEqual(
      week.windows.map((window) => window.status),
      ['exact', 'exact', 'atLeast'],
    );
    assert.deepEqual(
      week.windows.map((window) => window.display),
      ['$1.25', '$1.25', 'At least $4.75'],
    );
    assert.deepEqual(
      week.categories[0].windows.map((window) => window.status),
      ['exact', 'exact', 'atLeast'],
    );
    const days = prepareProjectSpendView(files, () => null, { now, historyCutoff: projectSpendHistoryCutoff(3, now) });
    assert.deepEqual(
      days.windows.map((window) => window.status),
      ['exact', 'atLeast', 'atLeast'],
    );
    const month = prepareProjectSpendView(files, () => null, {
      now,
      historyCutoff: projectSpendHistoryCutoff(30, now),
    });
    assert.deepEqual(
      month.windows.map((window) => window.status),
      ['exact', 'exact', 'exact'],
    );
    const empty = prepareProjectSpendView([], () => null, { now, historyCutoff: projectSpendHistoryCutoff(3, now) });
    assert.deepEqual(
      empty.windows.map((window) => window.display),
      ['$0.00', 'At least $0.00', 'At least $0.00'],
    );
  });

  test('a session whose skipped source has no saved record retains known lifetime usage', () => {
    const parts = sessionSpendPartsBySession(
      [saved({ file: 'parent', lifetimeBuckets: buckets })],
      [
        { sessionId: 's', file: 'parent', primary: true },
        { sessionId: 's', file: 'child', primary: false },
      ],
    );
    assert.deepEqual(
      parts.s.map((part) => part.bucket),
      buckets,
    );
  });
});

test('agent categories require local evidence and retain a confirmed zero', () => {
  const empty = prepareProjectSpendView([], () => null, { now: stamp('2026-08-31T12:00:00') });
  assert.deepEqual(empty.categories, []);

  const buckets = aggregateUsageEvents([event(stamp('2026-08-31T10:00:00'), { reportedCost: 0 })]);
  const evidenced = prepareProjectSpendView(
    [{ file: 'a', workspace: 'w', size: 1, mtimeMs: 1, offset: 1, trailing: '', buckets, indexedAt: 1 }],
    () => null,
    { now: stamp('2026-08-31T12:00:00') },
  );
  assert.deepEqual(
    evidenced.categories.map((category) => category.id),
    ['claude'],
  );
  assert.equal(evidenced.categories[0].windows[0].display, '$0.00');

  const lifetimeOnly = prepareProjectSpendView(
    [
      {
        file: 'old',
        workspace: 'w',
        size: 1,
        mtimeMs: 1,
        offset: 1,
        trailing: '',
        buckets: [],
        lifetimeBuckets: buckets,
        indexedAt: 1,
      },
    ],
    () => null,
    { now: stamp('2026-08-31T12:00:00') },
  );
  assert.deepEqual(
    lifetimeOnly.categories.map((category) => category.id),
    ['claude'],
  );
  assert.equal(lifetimeOnly.categories[0].windows[0].display, '$0.00');
});

test('view separates Claude and Codex spend regardless of billing class', () => {
  const files = [
    {
      file: 'a',
      workspace: 'w',
      size: 0,
      mtimeMs: 0,
      offset: 0,
      trailing: '',
      buckets: [
        ...aggregateUsageEvents([event(stamp('2026-08-31T10:00:00'), { reportedCost: 4.82 })]),
        ...aggregateUsageEvents([
          event(stamp('2026-08-31T11:00:00'), {
            agent: 'codex',
            provider: 'openai',
            billingClass: 'subscription',
          }),
        ]),
        ...aggregateUsageEvents([event(stamp('2026-08-31T12:00:00'), { model: 'unknown' })]),
      ],
      indexedAt: stamp('2026-08-31T12:30:00'),
    },
  ];
  const view = prepareProjectSpendView(
    files,
    (bucket) =>
      bucket.model === 'unknown'
        ? null
        : { dollars: 99, source: 'Public rate', effectiveDate: '2026-01-01', estimated: true, provenance: 'public' },
    { now: stamp('2026-08-31T13:00:00') },
  );
  assert.equal(view.windows[0].display, 'At least $104');
  assert.equal(view.windows[0].status, 'atLeast');
  assert.equal(view.categories[0].label, 'Claude spend');
  assert.equal(view.categories[0].windows[0].display, 'At least $4.82');
  assert.equal(view.categories[1].label, 'Codex spend');
  assert.equal(view.categories[1].windows[0].display, '$99');
  assert.deepEqual(view.rateSources.map((source) => source.provenance).sort(), ['public', 'reported']);
});

test('an unsupported price marks only the relevant agent and combined windows unknown', () => {
  const buckets = aggregateUsageEvents([
    event(stamp('2026-08-31T10:00:00'), { billingClass: 'unknown' }),
    event(stamp('2026-08-28T10:00:00'), { agent: 'codex', provider: 'openai', model: 'unknown' }),
    event(stamp('2026-08-03T10:00:00'), { provider: 'amazon-bedrock', model: 'unknown' }),
  ]);
  const view = prepareProjectSpendView(
    [{ file: 'a', workspace: 'w', size: 1, mtimeMs: 1, offset: 1, trailing: '', buckets, indexedAt: 1 }],
    () => null,
    { now: stamp('2026-08-31T12:00:00') },
  );
  assert.deepEqual(
    view.windows.map((window) => window.display),
    ['Cost unknown', 'Cost unknown', 'Cost unknown'],
  );
  assert.deepEqual(
    view.categories[0].windows.map((window) => window.display),
    ['Cost unknown', 'Cost unknown', 'Cost unknown'],
  );
  assert.deepEqual(
    view.categories[1].windows.map((window) => window.display),
    ['$0.00', 'Cost unknown', 'Cost unknown'],
  );
});

test('an unknown amount is not presented as at least zero dollars', () => {
  const buckets = [
    ...aggregateUsageEvents([event(stamp('2026-08-31T10:00:00'), { reportedCost: 0 })]),
    ...aggregateUsageEvents([event(stamp('2026-08-31T11:00:00'), { model: 'unknown' })]),
  ];
  const view = prepareProjectSpendView(
    [{ file: 'a', workspace: 'w', size: 1, mtimeMs: 1, offset: 1, trailing: '', buckets, indexedAt: 1 }],
    () => null,
    { now: stamp('2026-08-31T12:00:00') },
  );
  assert.equal(view.windows[0].display, 'Cost unknown');
  assert.equal(view.categories[0].windows[0].display, 'Cost unknown');
});

test('reported request costs are summed and expired buckets stay out of the detail', () => {
  const recent = stamp('2026-08-31T10:00:00');
  const buckets = aggregateUsageEvents([
    event(recent, { reportedCost: 1.25 }),
    event(recent + 1, { reportedCost: 2.5 }),
    event(stamp('2026-09-01T00:01:00'), { reportedCost: 8 }),
    event(stamp('2026-07-01T10:00:00'), { billingClass: 'subscription' }),
  ]);
  const view = prepareProjectSpendView(
    [{ file: 'a', workspace: 'w', size: 1, mtimeMs: 1, offset: 1, trailing: '', buckets, indexedAt: recent }],
    () => ({ dollars: 99, source: 'Public rate', effectiveDate: '2026-01-01', estimated: true, provenance: 'public' }),
    {
      now: stamp('2026-08-31T12:00:00'),
    },
  );
  assert.equal(view.windows[0].display, '$3.75');
  assert.equal(view.categories[0].windows[0].display, '$3.75');
});

test('a linked Claude result is used only when its direct transcript is absent', () => {
  const at = stamp('2026-09-01T12:00:00');
  const sessionId = '5a7b07c1-bfcf-4d96-9eb2-8ef1fb609881';
  const linked = aggregateUsageEvents([
    event(at, {
      agent: 'claude',
      provider: null,
      model: 'claude-opus-5',
      reportedCost: 3.25,
      reportedCostBasis: 'list',
      linkedSessionId: sessionId,
      linkedInvocationId: `parent-command:${sessionId}`,
      requestCountExact: false,
    }),
  ]);
  const direct = aggregateUsageEvents([
    event(at, {
      agent: 'claude',
      provider: null,
      model: 'claude-opus-5',
      reportedCost: 3.25,
      reportedCostBasis: 'list',
    }),
  ]);
  const record = (
    file: string,
    buckets: ProjectUsageBucket[],
    parserState: unknown = emptyClaudeUsageReducerState(),
    parserKind: 'claude' | 'codex' = 'claude',
  ): SpendFileIndex => ({
    file: normalizeSpendFile(file),
    workspace: normalizeWorkspace('w'),
    size: 1,
    mtimeMs: at,
    offset: 1,
    trailing: '',
    buckets,
    lifetimeBuckets: buckets,
    turnCount: 1,
    parserGeneration: PROJECT_SPEND_PARSER_GENERATION,
    parserKind,
    indexedAt: at,
    complete: true,
    parserState,
  });
  const parent = record(
    'rollout-parent.jsonl',
    linked,
    {
      ...emptyCodexUsageReducerState(),
      recentClaudeInvocationIds: [`parent-command:${sessionId}`],
      seenClaudeInvocations: { [`parent-command:${sessionId}`]: true },
    },
    'codex',
  );
  const directSource = record(path.join('claude-project', `${sessionId}.jsonl`), direct);
  const onlyLinked = prepareProjectSpendView([parent], publicProjectSpendPrice, { now: at });
  assert.equal(onlyLinked.windows[0].dollars, 3.25);
  assert.equal(onlyLinked.windows[0].status, 'exact');
  assert.equal(onlyLinked.windows[0].display, '$3.25');
  assert.equal(onlyLinked.rateSources[0]?.source, 'Claude CLI recorded list price');

  for (const files of [
    [parent, directSource],
    [directSource, parent],
  ]) {
    const view = prepareProjectSpendView(files, publicProjectSpendPrice, { now: at });
    assert.equal(view.windows[0].dollars, 3.25);
    assert.equal(view.categories.find((category) => category.id === 'claude')?.windows[0].dollars, 3.25);
  }
  const emptyDirect = record(path.join('empty-project', `${sessionId}.jsonl`), []);
  assert.equal(
    prepareProjectSpendView([parent, emptyDirect], publicProjectSpendPrice, { now: at }).windows[0].dollars,
    3.25,
  );
  const unfinishedDirect = {
    ...record(path.join('unfinished-project', `${sessionId}.jsonl`), direct),
    trailing: '{"type":"assistant"',
  };
  const unfinishedView = prepareProjectSpendView([parent, unfinishedDirect], publicProjectSpendPrice, { now: at });
  assert.equal(unfinishedView.windows[0].dollars, 3.25);
  assert.equal(unfinishedView.windows[0].status, 'atLeast');
  assert.deepEqual(
    sessionSpendBySession([parent, directSource], [{ sessionId: 'codex-parent', file: parent.file, primary: true }])[
      'codex-parent'
    ],
    linked,
  );

  const storage = dir();
  saveSpendLedger(storage, 'w', [parent, directSource]);
  const loaded = loadSpendLedger(storage, 'w');
  assert.deepEqual(loaded.files.find((file) => file.file === parent.file)?.parserState, parent.parserState);
  assert.equal(prepareProjectSpendView(loaded.files, publicProjectSpendPrice, { now: at }).windows[0].dollars, 3.25);
});

test('incomplete linked usage keeps known project cost partial and unclassified cache survives reload', () => {
  const at = stamp('2026-09-01T12:00:00');
  const linkedSessionId = 'linked-claude-session';
  const incomplete = event(at, {
    agent: 'claude',
    provider: null,
    model: null,
    incomplete: true,
    linkedSessionId,
    linkedInvocationId: 'claude-incomplete:command',
    usage: { ...usage(), requests: 1, input: 0, output: 0 },
  });
  const priced = event(at + 1, { reportedCost: 1 });
  const cache = event(at + 2, {
    agent: 'claude',
    model: 'claude-opus-5',
    reportedCost: 3.25,
    reportedCostBasis: 'list',
    linkedSessionId,
    linkedInvocationId: 'complete-command',
    unclassifiedCacheWrite: 110,
  });
  const buckets = aggregateUsageEvents([incomplete, priced, cache]);
  assert.equal(buckets.find((bucket) => bucket.linkedInvocationId === 'complete-command')?.unclassifiedCacheWrite, 110);
  const view = prepareProjectSpendView(
    [
      {
        file: 'parent.jsonl',
        workspace: 'w',
        size: 1,
        mtimeMs: 1,
        offset: 1,
        trailing: '',
        buckets,
        lifetimeBuckets: buckets,
        indexedAt: at,
        complete: true,
      },
    ],
    publicProjectSpendPrice,
    { now: at },
  );
  assert.equal(view.windows[0].display, 'At least $4.25');

  const storage = dir();
  saveSpendLedger(storage, 'w', [
    {
      file: 'parent.jsonl',
      workspace: normalizeWorkspace('w'),
      size: 1,
      mtimeMs: 1,
      offset: 1,
      trailing: '',
      buckets,
      lifetimeBuckets: buckets,
      indexedAt: at,
      complete: true,
    },
  ]);
  const loaded = loadSpendLedger(storage, 'w').files[0];
  assert.equal(
    loaded.buckets.find((bucket) => bucket.linkedInvocationId === 'complete-command')?.unclassifiedCacheWrite,
    110,
  );
  assert.equal(loaded.buckets.find((bucket) => bucket.incomplete)?.requests, 1);
});

test('an accepted result removes an earlier incomplete bucket', () => {
  const at = stamp('2026-09-01T12:00:00');
  const marker = event(at, {
    agent: 'claude',
    provider: null,
    model: null,
    incomplete: true,
    linkedInvocationId: 'incomplete-command',
    usage: { ...usage(), requests: 1, input: 0, output: 0 },
  });
  const remove = { ...marker, usage: { ...marker.usage, requests: -1 } };
  const complete = event(at + 1, {
    agent: 'claude',
    model: 'claude-opus-5',
    reportedCost: 3.25,
    reportedCostBasis: 'list',
    linkedInvocationId: 'complete-command',
    unclassifiedCacheWrite: 110,
  });
  const buckets = aggregateUsageEvents([marker, remove, complete]);
  assert.equal(
    buckets.some((bucket) => bucket.incomplete),
    false,
  );
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].unclassifiedCacheWrite, 110);
});

test('metered Codex usage remains Codex spend', () => {
  const buckets = aggregateUsageEvents([
    event(stamp('2026-08-31T10:00:00'), {
      agent: 'codex',
      provider: 'my-company-gateway',
      reportedCost: 1,
    }),
  ]);
  const view = prepareProjectSpendView(
    [{ file: 'a', workspace: 'w', size: 1, mtimeMs: 1, offset: 1, trailing: '', buckets, indexedAt: 1 }],
    () => null,
    { now: stamp('2026-08-31T12:00:00') },
  );
  assert.deepEqual(
    view.categories.map((category) => category.id),
    ['codex'],
  );
  assert.equal(view.categories[0].windows[0].display, '$1.00');
});

test('an unfinished long line stays in memory once, as pending bytes', () => {
  const folder = dir();
  const file = path.join(folder, 'source.jsonl');
  const first = JSON.stringify(event(stamp('2026-08-31T10:00:00'))) + '\n';
  const giant = JSON.stringify(event(stamp('2026-08-31T10:30:00'), { requestKey: 'x'.repeat(6 * 1024 * 1024) })) + '\n';
  fs.writeFileSync(file, first + giant);
  // A stopped clock leaves the byte budget as the only limit, so each slice reads 1 MiB.
  const budget = { maxBytes: 1024 * 1024, now: () => 0 };
  let record = indexSpendFile(undefined, file, 'w', reducer, budget).record;
  let slices = 1;
  while (record.complete === false) {
    const held = (record.scanOffset ?? record.offset) - record.offset;
    assert.equal(record.trailing, '', `slice ${slices} kept the held line as text`);
    assert.equal(record.trailingBytes, undefined, `slice ${slices} kept a second copy of the held line`);
    assert.ok(
      (record.pendingBytes?.length ?? 0) <= 1.4 * held,
      `slice ${slices} kept ${record.pendingBytes?.length} characters for ${held} held bytes`,
    );
    assert.equal(spendRecordHoldsLongLine(record), held > PROJECT_SPEND_HELD_LINE_BYTES);
    record = indexSpendFile(record, file, 'w', reducer, budget).record;
    slices++;
  }
  assert.equal(slices, 7);
  assert.equal(
    record.buckets.reduce((sum, bucket) => sum + bucket.requests, 0),
    2,
  );
});

test('a record holds a long line only when it holds more than PROJECT_SPEND_HELD_LINE_BYTES', () => {
  const holding = (bytes: number) =>
    ({ complete: false, pendingBytes: Buffer.alloc(bytes).toString('base64') }) as never;
  assert.equal(spendRecordHoldsLongLine(holding(PROJECT_SPEND_HELD_LINE_BYTES)), false);
  assert.equal(
    spendRecordHoldsLongLine(holding(PROJECT_SPEND_HELD_LINE_BYTES + 1)),
    true,
    'a record that holds one byte past the limit does not count as holding a long line',
  );
});

test('a source that disappears in the middle of a long line lets the held bytes go', () => {
  const folder = dir();
  const file = path.join(folder, 'source.jsonl');
  fs.writeFileSync(
    file,
    JSON.stringify(event(stamp('2026-08-31T10:30:00'), { requestKey: 'x'.repeat(512 * 1024) })) + '\n',
  );
  const budget = { maxBytes: 256 * 1024, now: () => 0 };
  const held = indexSpendFile(undefined, file, 'w', reducer, budget).record;
  assert.equal(spendRecordHoldsLongLine(held), true);
  fs.rmSync(file);
  const missing = indexSpendFile(held, file, 'w', reducer, budget).record;
  assert.notEqual(missing.missingAt, undefined);
  assert.equal(missing.pendingBytes, undefined, 'a disappeared source kept its unfinished line');
});

test('incremental source reading preserves an incomplete UTF-8 CRLF line and does not rescan completed bytes', () => {
  const folder = dir();
  const file = path.join(folder, 'source.jsonl');
  const first = JSON.stringify(event(stamp('2026-08-31T10:00:00'))) + '\r\n';
  const second = Buffer.from(JSON.stringify(event(stamp('2026-08-31T10:30:00'), { requestKey: '€' })), 'utf8');
  fs.writeFileSync(file, Buffer.concat([Buffer.from(first), second.subarray(0, second.length - 1)]));
  let record = indexSpendFile(undefined, file, 'w', reducer, 1).record;
  assert.equal(record.buckets[0].requests, 1);
  assert.equal(record.offset, Buffer.byteLength(first));
  fs.appendFileSync(
    file,
    Buffer.concat([
      second.subarray(second.length - 1),
      Buffer.from('\n' + JSON.stringify(event(stamp('2026-08-31T11:00:00'))) + '\n'),
    ]),
  );
  const next = indexSpendFile(record, file, 'w', reducer, 2);
  record = next.record;
  assert.equal((record.parserState as ClaudeUsageReducerState).closedTurns, 3, 'completed first line was rescanned');
  assert.equal(record.buckets[0].requests, 3);
});

test('a growing Claude child response contributes its final cumulative usage exactly once', () => {
  const folder = dir();
  const file = path.join(folder, 'child.jsonl');
  const record = (output: number) =>
    JSON.stringify({
      type: 'assistant',
      isSidechain: true,
      uuid: `u${output}`,
      timestamp: '2026-08-31T10:00:00Z',
      message: { id: 'm1', model: 'claude-opus-5', usage: { input_tokens: 3, output_tokens: output } },
    });
  fs.writeFileSync(file, record(4) + '\n');
  const makeChildReducer = (state: Parameters<typeof createClaudeUsageLineReducer>[0]) =>
    createClaudeUsageLineReducer(state, { childTranscript: true });
  const first = indexSpendFile(undefined, file, 'w', makeChildReducer, 1).record;
  fs.appendFileSync(file, record(10) + '\n');
  const final = indexSpendFile(first, file, 'w', makeChildReducer, 2).record;
  assert.equal(final.buckets[0].requests, 1);
  assert.equal(final.buckets[0].usage.input, 3);
  assert.equal(final.buckets[0].usage.output, 10);
  assert.equal(final.lifetimeBuckets?.[0].usage.output, 10);
});

test('a completed Claude child turn supplies lifetime timing and outcome facts', () => {
  const folder = dir();
  const file = path.join(folder, 'child.jsonl');
  fs.writeFileSync(
    file,
    [
      JSON.stringify({
        type: 'user',
        isSidechain: true,
        timestamp: '2026-08-31T10:00:00Z',
        message: { role: 'user', content: 'Inspect the failure.' },
      }),
      JSON.stringify({
        type: 'assistant',
        isSidechain: true,
        timestamp: '2026-08-31T10:00:05Z',
        message: {
          id: 'child-answer',
          role: 'assistant',
          model: 'claude-opus-5',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'The failure is fixed.' }],
          usage: { input_tokens: 3, output_tokens: 4 },
        },
      }),
    ].join('\n') + '\n',
  );
  const makeChildReducer = (state: Parameters<typeof createClaudeUsageLineReducer>[0]) =>
    createClaudeUsageLineReducer(state, { childTranscript: true });
  const indexed = indexSpendFile(undefined, file, 'w', makeChildReducer, 1).record;

  assert.equal(indexed.turnCount, 1);
  assert.equal(indexed.firstTurnAt, stamp('2026-08-31T10:00:00Z'));
  assert.equal(indexed.lastTurnAt, stamp('2026-08-31T10:00:05Z'));
  assert.equal(indexed.newestTurnStartedAt, stamp('2026-08-31T10:00:00Z'));
  assert.deepEqual(indexed.outcome, {
    startedAt: stamp('2026-08-31T10:00:00Z'),
    endedAt: stamp('2026-08-31T10:00:05Z'),
    finished: true,
    error: false,
    interrupted: false,
  });
  const stale = {
    ...indexed,
    turnCount: 0,
    firstTurnAt: null,
    lastTurnAt: null,
    newestTurnStartedAt: null,
    outcome: null,
    parserGeneration: PROJECT_SPEND_PARSER_GENERATION - 1,
  };
  const rebuilt = indexSpendFile(stale, file, 'w', makeChildReducer, 2);
  assert.equal(rebuilt.rebuilt, true);
  assert.equal(rebuilt.record.turnCount, 1);
  assert.equal(rebuilt.record.firstTurnAt, stamp('2026-08-31T10:00:00Z'));
  assert.equal(rebuilt.record.lastTurnAt, stamp('2026-08-31T10:00:05Z'));
});

test('a Claude child replacement moves the request when date and cost provenance change', () => {
  const folder = dir();
  const file = path.join(folder, 'child.jsonl');
  const record = (timestamp: string, output: number, cost?: number) =>
    JSON.stringify({
      type: 'assistant',
      isSidechain: true,
      uuid: `u${output}`,
      timestamp,
      message: {
        id: 'm1',
        model: 'claude-opus-5',
        usage: { input_tokens: 3, output_tokens: output, ...(cost === undefined ? {} : { cost_usd: cost }) },
      },
    });
  fs.writeFileSync(file, record('2026-08-31T23:59:00', 4) + '\n');
  const makeChildReducer = (state: Parameters<typeof createClaudeUsageLineReducer>[0]) =>
    createClaudeUsageLineReducer(state, { childTranscript: true });
  const first = indexSpendFile(undefined, file, 'w', makeChildReducer, 1).record;
  fs.appendFileSync(file, record('2026-09-01T00:01:00', 10, 0.42) + '\n');
  const final = indexSpendFile(first, file, 'w', makeChildReducer, 2).record;
  assert.equal(final.buckets.length, 1);
  assert.equal(final.buckets[0].localDate, '2026-09-01');
  assert.equal(final.buckets[0].reportedCost, 0.42);
  assert.equal(final.buckets[0].requests, 1);
  assert.equal(final.buckets[0].usage.input, 3);
  assert.equal(final.buckets[0].usage.output, 10);
  assert.equal(final.lifetimeBuckets?.length, 1);
  assert.equal(final.lifetimeBuckets?.[0].reportedCost, 0.42);
});

test('truncation and same-size replacement rebuild one source', () => {
  const folder = dir();
  const file = path.join(folder, 'source.jsonl');
  fs.writeFileSync(file, JSON.stringify(event(stamp('2026-08-30T10:00:00'))) + '\n');
  const first = indexSpendFile(undefined, file, 'w', reducer, 1).record;
  fs.writeFileSync(file, JSON.stringify(event(stamp('2026-08-31T10:00:00'))) + '\n');
  fs.utimesSync(file, new Date(2_000), new Date(2_000));
  const replacement = indexSpendFile(first, file, 'w', reducer, 2);
  assert.equal(replacement.rebuilt, true);
  assert.equal(replacement.record.buckets[0].localDate, '2026-08-31');
  fs.writeFileSync(file, '');
  assert.equal(indexSpendFile(replacement.record, file, 'w', reducer, 3).rebuilt, true);
});

test('deleted records persist until their last possible 30-day contribution expires', () => {
  const file = {
    file: 'gone',
    workspace: 'w',
    size: 0,
    mtimeMs: 0,
    offset: 0,
    trailing: '',
    buckets: aggregateUsageEvents([event(stamp('2026-08-02T10:00:00'))]),
    indexedAt: 1,
    missingAt: 2,
  };
  assert.equal(pruneSpendFiles([file], stamp('2026-08-31T12:00:00')).length, 1);
  assert.equal(pruneSpendFiles([file], stamp('2026-09-01T12:00:00')).length, 0);
});

test('pruning drops expired buckets from live sources but retains their incremental cursor', () => {
  const old = event(stamp('2026-07-31T10:00:00'));
  const current = event(stamp('2026-08-31T10:00:00'));
  const file = {
    file: 'live',
    workspace: 'w',
    size: 123,
    mtimeMs: 456,
    offset: 123,
    trailing: '',
    buckets: aggregateUsageEvents([old, current]),
    lifetimeBuckets: aggregateUsageEvents([old, current]),
    indexedAt: 789,
    parserState: { lines: 2 },
  };
  const result = pruneSpendFilesWithResult([file], stamp('2026-08-31T12:00:00'));
  assert.equal(result.pruned, true);
  assert.deepEqual(
    result.files[0].buckets.map((bucket) => bucket.localDate),
    ['2026-08-31'],
  );
  assert.deepEqual(
    result.files[0].lifetimeBuckets?.map((bucket) => bucket.localDate),
    ['2026-07-31', '2026-08-31'],
  );
  assert.deepEqual(result.files[0].parserState, { lines: 2 });
  assert.equal(result.files[0].offset, 123);
});

test('an append after pruning keeps expired usage in the lifetime total', () => {
  const folder = dir();
  const file = path.join(folder, 'source.jsonl');
  const old = event(stamp('2026-07-01T10:00:00'));
  const current = event(stamp('2026-08-31T10:00:00'));
  fs.writeFileSync(file, `${JSON.stringify(old)}\n${JSON.stringify(current)}\n`);
  const indexed = indexSpendFile(undefined, file, 'w', reducer, 1).record;
  const pruned = pruneSpendFiles([indexed], stamp('2026-08-31T12:00:00'))[0];
  fs.appendFileSync(file, `${JSON.stringify(event(stamp('2026-08-31T11:00:00')))}\n`);
  const updated = indexSpendFile(pruned, file, 'w', reducer, 2).record;
  assert.equal(updated.buckets[0].requests, 2);
  assert.deepEqual(
    updated.lifetimeBuckets?.map((bucket) => bucket.localDate),
    ['2026-07-01', '2026-08-31'],
  );
  assert.equal(
    updated.lifetimeBuckets?.reduce((sum, bucket) => sum + bucket.requests, 0),
    3,
  );
});

test('a source that returns at the same version clears its missing state', () => {
  const folder = dir();
  const source = path.join(folder, 'source.jsonl');
  const line = JSON.stringify(event(stamp('2026-08-31T10:00:00'))) + '\n';
  fs.writeFileSync(source, line);
  const original = indexSpendFile(undefined, source, 'w', reducer, 1).record;
  fs.unlinkSync(source);
  const missing = indexSpendFile(original, source, 'w', reducer, 2).record;
  fs.writeFileSync(source, line);
  fs.utimesSync(source, new Date(original.mtimeMs), new Date(original.mtimeMs));
  const restored = indexSpendFile(missing, source, 'w', reducer, 3);
  assert.equal(restored.rebuilt, true);
  assert.equal(restored.record.missingAt, undefined);
  assert.equal(restored.record.buckets[0].requests, 1);
});

test('persistence tolerates malformed data and keeps workspaces partitioned', () => {
  const folder = dir();
  fs.writeFileSync(path.join(folder, 'junk.json'), '{');
  assert.deepEqual(loadSpendLedger(folder, 'one').files, []);
  saveSpendLedger(folder, 'one', []);
  saveSpendLedger(folder, 'two', []);
  assert.equal(fs.readdirSync(folder).filter((name) => name.endsWith('.json')).length, 3);
  assert.equal(loadSpendLedger(folder, 'one').workspace, path.resolve('one').replace(/\\/g, '/').toLowerCase());
});

test('persistence keeps the last complete display ledger apart from resumable scan progress', () => {
  const folder = dir();
  const source = path.join(folder, 'source.jsonl');
  fs.writeFileSync(source, JSON.stringify(event(stamp('2026-08-31T10:00:00'))) + '\n');
  const complete = indexSpendFile(undefined, source, 'one', reducer, 1).record;
  fs.appendFileSync(source, JSON.stringify(event(stamp('2026-08-31T11:00:00'))) + '\n');
  const partial = indexSpendFile(complete, source, 'one', reducer, 2, { maxBytes: 1 }).record;
  assert.equal(partial.complete, false);
  saveSpendLedger(folder, 'one', [partial], [complete]);
  const stored = JSON.parse(ledgerText(folder));
  assert.ok(Array.isArray(stored.files[0].lifetimeBuckets));
  assert.ok(Array.isArray(stored.displayFiles[0].lifetimeBuckets));
  const loaded = loadSpendLedger(folder, 'one');
  const checkpoint = { ...partial, scanOffset: partial.offset, trailing: '' };
  delete checkpoint.pendingBytes;
  delete checkpoint.trailingBytes;
  assert.deepEqual(loaded.files, [checkpoint]);
  assert.deepEqual(loaded.completeFiles, [complete]);
  const resumed = indexSpendFile(loaded.files[0], source, 'one', reducer, 3);
  assert.equal(resumed.rebuilt, false);
  assert.equal(resumed.complete, true);
  assert.equal(resumed.record.buckets[0].requests, 2);
});

test('a ledger save writes the whole ledger in pieces under 1 MiB', () => {
  const folder = dir();
  // Multi-byte text and records longer than one write, with surrogate pairs at both parities.
  const records = Array.from({ length: 2_000 }, (_, at) =>
    spendRecord(`source-${at}.jsonl`, { indexedAt: at, trailing: `€${at}`.repeat(200) }),
  );
  records[7] = spendRecord('long-even.jsonl', { trailing: '😀'.repeat(300_000) });
  records[8] = spendRecord('long-odd.jsonl', { trailing: `a${'😀'.repeat(300_000)}` });
  const expected =
    `{"workspace":${JSON.stringify(normalizeWorkspace('one'))}` +
    `,"parserGeneration":${PROJECT_SPEND_PARSER_GENERATION}` +
    `,"files":[${records.map((record) => JSON.stringify(record)).join(',')}]` +
    `,"displayFiles":[${records.map((_, at) => at).join(',')}]}`;
  const writes: number[] = [];
  const write = fs.writeSync;
  const spy = vi.spyOn(fs, 'writeSync').mockImplementation((...args: unknown[]) => {
    const written = (write as (...values: unknown[]) => number)(...args);
    writes.push(written);
    return written;
  });
  try {
    saveSpendLedger(folder, 'one', records);
  } finally {
    spy.mockRestore();
  }
  assert.equal(ledgerText(folder), expected);
  assert.ok(writes.length > 10, `the save wrote ${writes.length} times`);
  assert.equal(
    writes.reduce((sum, bytes) => sum + bytes, 0),
    Buffer.byteLength(expected),
  );
  assert.ok(Math.max(...writes) < 1024 * 1024, `one write held ${Math.max(...writes)} bytes`);
});

test('cache rewrites preserve historical lifetime usage and missing sources in the existing array format', () => {
  const folder = dir();
  const source = path.join(folder, 'source.jsonl');
  const now = stamp('2026-10-04T12:00:00');
  fs.writeFileSync(source, JSON.stringify(event(now, { reportedCost: 4.25 })) + '\n');
  const complete = indexSpendFile(undefined, source, 'one', reducer, now).record;
  const historical = {
    ...complete,
    file: normalizeSpendFile(path.join(folder, 'historical.jsonl')),
    lifetimeBuckets: [
      ...complete.lifetimeBuckets!,
      ...aggregateUsageEvents([event(stamp('2026-08-01T12:00:00'), { reportedCost: 9 })]),
    ],
  };
  const missing = {
    ...complete,
    file: normalizeSpendFile(path.join(folder, 'missing.jsonl')),
    missingAt: now,
  };
  const records = [complete, historical, missing];
  saveSpendLedger(folder, 'one', records);
  const stored = JSON.parse(ledgerText(folder));
  assert.ok(Array.isArray(stored.files[0].lifetimeBuckets));
  assert.deepEqual(stored.files[1].lifetimeBuckets, historical.lifetimeBuckets);
  assert.ok(Array.isArray(stored.files[2].lifetimeBuckets));
  const loaded = loadSpendLedger(folder, 'one');
  assert.deepEqual(loaded.files, records);
  assert.deepEqual(
    prepareProjectSpendView(loadSpendLedger(folder, 'one').completeFiles, publicProjectSpendPrice, { now }),
    prepareProjectSpendView(records, publicProjectSpendPrice, { now }),
  );
  const retainedInput = loaded.files[0].lifetimeBuckets![0].usage.input;
  loaded.files[0].buckets[0].usage.input++;
  assert.equal(loaded.files[0].lifetimeBuckets![0].usage.input, retainedInput);
  const expired = pruneSpendFiles(loadSpendLedger(folder, 'one').files, stamp('2026-12-01T12:00:00'));
  assert.equal(expired[0].buckets.length, 0);
  assert.deepEqual(expired[0].lifetimeBuckets, complete.lifetimeBuckets);

  fs.writeFileSync(path.join(folder, ledgerName(folder)), JSON.stringify(stored));
  assert.deepEqual(loadSpendLedger(folder, 'one').files, records);
  stored.files[0].lifetimeBuckets = false;
  fs.writeFileSync(path.join(folder, ledgerName(folder)), JSON.stringify(stored));
  assert.deepEqual(loadSpendLedger(folder, 'one').files, []);
});

test('a valid ledger restores canonical record paths without resolving them again', () => {
  const folder = dir();
  const sources = ['one.jsonl', 'two.jsonl'].map((name) => path.join(folder, name));
  for (const source of sources) {
    fs.writeFileSync(source, '');
  }
  const records = sources.map((source) =>
    spendRecord(source, {
      file: normalizeSpendFile(source),
      parserGeneration: PROJECT_SPEND_PARSER_GENERATION,
      complete: true,
    }),
  );
  saveSpendLedger(folder, 'one', records);
  for (const record of records) {
    invalidateSpendFileNormalization(record.file);
  }
  const nativeRealpath = fs.realpathSync.native;
  let realpathCalls = 0;
  vi.spyOn(fs.realpathSync, 'native').mockImplementation((candidate: fs.PathLike) => {
    realpathCalls++;
    return nativeRealpath(candidate);
  });

  const loaded = loadSpendLedger(folder, 'one');

  assert.deepEqual(
    loaded.files.map((record) => record.file),
    records.map((record) => record.file),
  );
  assert.equal(realpathCalls, 0, 'restoring canonical ledger paths resolved every source again');
});

test('ledger restoration keeps lexical platform path normalization', () => {
  const folder = dir();
  const source = path.join(folder, 'Case-Source.jsonl');
  fs.writeFileSync(source, '');
  saveSpendLedger(folder, 'one', [spendRecord(source, { complete: true })]);
  const target = path.join(folder, ledgerName(folder));
  const saved = JSON.parse(ledgerText(folder)) as { files: Array<{ file: string }> };
  saved.files[0].file =
    process.platform === 'win32'
      ? saved.files[0].file.toUpperCase()
      : path.join(path.dirname(saved.files[0].file), '.', path.basename(saved.files[0].file));
  fs.writeFileSync(target, JSON.stringify(saved));

  assert.equal(loadSpendLedger(folder, 'one').files[0].file, normalizeWorkspace(saved.files[0].file));
});

test('lifetime projection does not resolve restored canonical records again', () => {
  const folder = dir();
  const source = path.join(folder, 'source.jsonl');
  fs.writeFileSync(source, '');
  const record = spendRecord(source, {
    file: normalizeSpendFile(source),
    complete: true,
    turnCount: 1,
    compactionCount: 0,
    firstTurnAt: 1,
    lastTurnAt: 2,
    newestTurnStartedAt: 1,
    outcome: { finished: true, error: false, interrupted: false, endedAt: 2 },
  });
  saveSpendLedger(folder, 'one', [record]);
  const loaded = loadSpendLedger(folder, 'one').files[0];
  invalidateSpendFileNormalization(source);
  invalidateSpendFileNormalization(loaded.file);
  const nativeRealpath = fs.realpathSync.native;
  let realpathCalls = 0;
  vi.spyOn(fs.realpathSync, 'native').mockImplementation((candidate: fs.PathLike) => {
    realpathCalls++;
    return nativeRealpath(candidate);
  });
  const sources = [{ sessionId: 'session', file: source, primary: true }];

  sessionSpendPartsBySession([loaded], sources);
  sessionTurnStatsBySession([loaded], sources);
  sessionRailFactsBySession({ source: loaded }, sources);

  assert.equal(realpathCalls, 0, 'projecting restored records repeated startup realpath work');
});

test('a checkpoint does not serialize an in-progress JSONL record', () => {
  const folder = dir();
  const held = Buffer.alloc(2 * 1024 * 1024, 0x78);
  const record = {
    file: 'large.jsonl',
    workspace: normalizeWorkspace('one'),
    size: held.length + 10,
    mtimeMs: 1,
    offset: 10,
    scanOffset: held.length + 10,
    trailing: held.toString('utf8'),
    trailingBytes: held.toString('base64'),
    pendingBytes: held.toString('base64'),
    buckets: [],
    lifetimeBuckets: [],
    indexedAt: 1,
    complete: false,
  };
  saveSpendLedger(folder, 'one', [record]);
  const [saved] = loadSpendLedger(folder, 'one').files;
  assert.equal(saved.offset, 10);
  assert.equal(saved.scanOffset, 10);
  assert.equal(saved.trailing, '');
  assert.equal(saved.trailingBytes, undefined);
  assert.equal(saved.pendingBytes, undefined);
  assert.ok(fs.statSync(path.join(folder, fs.readdirSync(folder)[0])).size < 10_000);
});

const spendRecord = (name: string, more: Partial<SpendFileIndex> = {}): SpendFileIndex => ({
  file: normalizeSpendFile(name),
  workspace: normalizeWorkspace('one'),
  size: 10,
  mtimeMs: 1,
  offset: 10,
  trailing: '',
  buckets: [],
  lifetimeBuckets: [],
  indexedAt: 1,
  ...more,
});

const ledgerName = (folder: string): string => fs.readdirSync(folder).filter((entry) => entry.endsWith('.json'))[0];

const ledgerText = (folder: string): string => fs.readFileSync(path.join(folder, ledgerName(folder)), 'utf8');

test('persistence accepts one complete Codex usage snapshot and rejects malformed counter arrays', () => {
  const validSnapshot = { turnId: 'turn-1', last: [1, 2, 3, 4, 5, 6], total: [7, 8, 9, 10, 11, 12] };
  const savedRecord = spendRecord('snapshot.jsonl', {
    parserGeneration: PROJECT_SPEND_PARSER_GENERATION,
    parserKind: 'codex',
    parserState: { ...emptyCodexUsageReducerState(), lastUsageSnapshot: validSnapshot },
  });
  const folder = dir();
  saveSpendLedger(folder, 'one', [savedRecord]);
  assert.deepEqual(
    (loadSpendLedger(folder, 'one').files[0].parserState as ReturnType<typeof emptyCodexUsageReducerState>)
      .lastUsageSnapshot,
    validSnapshot,
  );

  const target = path.join(folder, ledgerName(folder));
  const saved = JSON.parse(ledgerText(folder)) as {
    files: Array<{ parserState: { lastUsageSnapshot: typeof validSnapshot } }>;
  };
  for (const bad of [[], [1, 2, 3, 4, 5]]) {
    const malformed = structuredClone(saved);
    malformed.files[0].parserState.lastUsageSnapshot.last = bad;
    fs.writeFileSync(target, JSON.stringify(malformed));
    assert.deepEqual(loadSpendLedger(folder, 'one').files, []);
  }
});

test('persistence keeps a withdrawn Claude command turn and rejects a damaged one', () => {
  const turn = { open: true, answered: false, startedAt: 2000, endedAt: 3000, firstTurnAt: 1000, outcome: null };
  const savedRecord = spendRecord('withdrawn.jsonl', {
    parserGeneration: PROJECT_SPEND_PARSER_GENERATION,
    parserKind: 'claude',
    parserState: {
      ...emptyClaudeUsageReducerState(),
      currentTurnPrevious: { ...turn, localStopAt: 2500 },
      currentTurnWithdrawn: { ...turn, compact: false, localStopAt: 2500 },
    },
  });
  const folder = dir();
  saveSpendLedger(folder, 'one', [savedRecord]);
  const state = loadSpendLedger(folder, 'one').files[0]?.parserState as ClaudeUsageReducerState | undefined;
  assert.deepEqual(
    [state?.currentTurnPrevious, state?.currentTurnWithdrawn],
    [
      { ...turn, localStopAt: 2500 },
      { ...turn, compact: false, localStopAt: 2500 },
    ],
  );

  const target = path.join(folder, ledgerName(folder));
  const saved = JSON.parse(ledgerText(folder)) as { files: Array<{ parserState: Record<string, any> }> };
  for (const [field, key, bad] of [
    ['currentTurnWithdrawn', 'compact', 'yes'],
    ['currentTurnWithdrawn', 'localStopAt', 'soon'],
    ['currentTurnPrevious', 'localStopAt', 'soon'],
  ] as const) {
    const malformed = structuredClone(saved);
    malformed.files[0].parserState[field][key] = bad;
    fs.writeFileSync(target, JSON.stringify(malformed));
    assert.deepEqual(loadSpendLedger(folder, 'one').files, [], `a damaged ${field}.${key} loaded`);
  }
});

function malformedSpendFixture() {
  const folder = dir();
  const buckets = aggregateUsageEvents([event(stamp('2026-08-31T10:00:00'))]);
  const valid = spendRecord('valid.jsonl', {
    buckets,
    lifetimeBuckets: buckets,
    parserGeneration: PROJECT_SPEND_PARSER_GENERATION,
    parserKind: 'claude',
    parserState: emptyClaudeUsageReducerState(),
    complete: true,
  });
  saveSpendLedger(folder, 'one', [valid]);
  const target = path.join(folder, ledgerName(folder));
  const saved = JSON.parse(ledgerText(folder)) as {
    parserGeneration: unknown;
    files: Record<string, unknown>[];
    displayFiles: unknown[];
  };
  const changed = (change: (record: Record<string, unknown>) => void): string => {
    const copy = structuredClone(saved);
    change(copy.files[0]);
    return JSON.stringify(copy);
  };
  const cases = new Map<string, string>([
    [
      'wrong record workspace',
      changed((record) => {
        record.workspace = 'another workspace';
      }),
    ],
    [
      'offset past the file end',
      changed((record) => {
        record.offset = 11;
      }),
    ],
    [
      'invalid calendar date',
      changed((record) => {
        (record.buckets as Record<string, unknown>[])[0].localDate = '2026-02-30';
      }),
    ],
    [
      'negative token count',
      changed((record) => {
        ((record.buckets as Record<string, unknown>[])[0].usage as Record<string, unknown>).input = -1;
      }),
    ],
    [
      'malformed parser state',
      changed((record) => {
        record.parserState = {
          ...emptyClaudeUsageReducerState(),
          seenRequestKeys: [null],
        };
      }),
    ],
    [
      'malformed Codex parser state',
      changed((record) => {
        record.parserState = { ...emptyCodexUsageReducerState(), requestNumber: -1 };
      }),
    ],
    [
      'parser state for another source kind',
      changed((record) => {
        record.parserKind = 'codex';
      }),
    ],
    [
      'event from another source kind',
      changed((record) => {
        record.parserState = {
          ...emptyClaudeUsageReducerState(),
          seenRequestKeys: ['codex:request'],
          requestEvents: { 'codex:request': event(1, { agent: 'codex', requestKey: 'codex:request' }) },
        };
      }),
    ],
    [
      'Claude event in a Codex pending request',
      changed((record) => {
        record.parserKind = 'codex';
        record.parserState = {
          ...emptyCodexUsageReducerState(),
          recentTurnIds: ['turn'],
          seenTurnIds: { turn: true },
          pendingRequestKeys: ['claude:request'],
          pendingRequests: { turn: [event(1, { agent: 'claude', model: null, requestKey: 'claude:request' })] },
        };
      }),
    ],
    [
      'Codex event in a pending Claude result',
      changed((record) => {
        record.parserKind = 'codex';
        record.parserState = {
          ...emptyCodexUsageReducerState(),
          pendingClaudeResultIds: ['command'],
          pendingClaudeResults: { command: event(1, { agent: 'codex', requestKey: 'codex:request' }) },
        };
      }),
    ],
    [
      'copied current Codex turn without copied-turn evidence',
      changed((record) => {
        record.parserKind = 'codex';
        record.parserState = {
          ...emptyCodexUsageReducerState(),
          currentTurnId: 'turn',
          currentTurnCopied: true,
          recentTurnIds: ['turn'],
          seenTurnIds: { turn: true },
        };
      }),
    ],
    [
      'current Codex turn marked copied only in its identity map',
      changed((record) => {
        record.parserKind = 'codex';
        record.parserState = {
          ...emptyCodexUsageReducerState(),
          currentTurnId: 'turn',
          recentTurnIds: ['turn'],
          seenTurnIds: { turn: true },
          copiedTurnIds: { turn: true },
        };
      }),
    ],
    [
      'duplicate pending Codex request',
      changed((record) => {
        const pending = event(1, { agent: 'codex', model: null, requestKey: 'codex:request' });
        record.parserKind = 'codex';
        record.parserState = {
          ...emptyCodexUsageReducerState(),
          recentTurnIds: ['turn'],
          seenTurnIds: { turn: true },
          pendingRequestKeys: ['codex:request'],
          pendingRequests: { turn: [pending, pending] },
        };
      }),
    ],
    [
      'pending Codex request with a resolved model',
      changed((record) => {
        record.parserKind = 'codex';
        record.parserState = {
          ...emptyCodexUsageReducerState(),
          recentTurnIds: ['turn'],
          seenTurnIds: { turn: true },
          pendingRequestKeys: ['codex:request'],
          pendingRequests: { turn: [event(1, { agent: 'codex', requestKey: 'codex:request' })] },
        };
      }),
    ],
    [
      'Codex retention queue above its bound',
      changed((record) => {
        const ids = Array.from({ length: CODEX_USAGE_ASSOCIATION_LIMIT + 1 }, (_, index) => `turn-${index}`);
        record.parserKind = 'codex';
        record.parserState = {
          ...emptyCodexUsageReducerState(),
          recentTurnIds: ids,
          seenTurnIds: Object.fromEntries(ids.map((id) => [id, true])),
        };
      }),
    ],
    [
      'Codex retention queue that disagrees with its identity map',
      changed((record) => {
        record.parserKind = 'codex';
        record.parserState = {
          ...emptyCodexUsageReducerState(),
          recentTurnIds: ['missing'],
        };
      }),
    ],
    [
      'event timestamp outside the JavaScript date range',
      changed((record) => {
        record.parserState = {
          ...emptyClaudeUsageReducerState(),
          seenRequestKeys: ['claude:request'],
          requestEvents: { 'claude:request': event(1e308, { agent: 'claude', requestKey: 'claude:request' }) },
        };
      }),
    ],
    ...[-1, 1.5, '40000', null].map(
      (contextTokens) =>
        [
          `invalid retained context measurement ${JSON.stringify(contextTokens)}`,
          changed((record) => {
            record.parserState = {
              ...emptyClaudeUsageReducerState(),
              seenRequestKeys: ['claude:request'],
              requestEvents: {
                'claude:request': {
                  ...event(1, { agent: 'claude', contextBand: null, requestKey: 'claude:request' }),
                  contextTokens,
                },
              },
            };
          }),
        ] as [string, string],
    ),
    [
      'invalid interrupted checkpoint',
      changed((record) => {
        record.complete = false;
        record.scanOffset = 11;
      }),
    ],
    [
      'interrupted checkpoint with an unaccounted byte gap',
      changed((record) => {
        record.complete = false;
        record.size = 100;
        record.scanOffset = 50;
      }),
    ],
    [
      'completed checkpoint with unaccounted trailing bytes',
      changed((record) => {
        record.trailing = 'skipped';
        record.trailingBytes = Buffer.from('skipped').toString('base64');
      }),
    ],
    [
      'legacy completed checkpoint with an unaccounted trailing string',
      changed((record) => {
        record.trailing = 'skipped';
      }),
    ],
    [
      'timestamp outside the JavaScript date range',
      changed((record) => {
        record.mtimeMs = 1e308;
      }),
    ],
    [
      'nonfinite token count',
      changed((record) => {
        ((record.buckets as Record<string, unknown>[])[0].usage as Record<string, unknown>).input = '__INFINITY__';
      }).replace('"__INFINITY__"', '1e400'),
    ],
    [
      'negative compaction count',
      changed((record) => {
        record.compactionCount = -1;
      }),
    ],
    [
      'non-integer compaction count',
      changed((record) => {
        record.compactionCount = 1.5;
      }),
    ],
    [
      'non-numeric first turn timestamp',
      changed((record) => {
        record.firstTurnAt = 'not-a-timestamp';
      }),
    ],
    [
      'last turn timestamp outside the JavaScript date range',
      changed((record) => {
        record.lastTurnAt = 1e308;
      }),
    ],
    [
      'last turn earlier than the first turn',
      changed((record) => {
        record.firstTurnAt = stamp('2026-08-31T10:00:00');
        record.lastTurnAt = stamp('2026-08-31T09:00:00');
      }),
    ],
    [
      'first turn without a matching last turn',
      changed((record) => {
        record.firstTurnAt = stamp('2026-08-31T09:00:00');
      }),
    ],
    [
      'last turn without a matching first turn',
      changed((record) => {
        record.lastTurnAt = stamp('2026-08-31T09:00:00');
      }),
    ],
  ]);

  return { cases, folder, saved, target };
}

const malformedSpend = malformedSpendFixture();

describe('persisted spend validation refuses malformed nested state before it reaches totals', () => {
  test.each([...malformedSpend.cases])('%s', (_name, ledger) => {
    fs.writeFileSync(malformedSpend.target, ledger);
    const loaded = loadSpendLedger(malformedSpend.folder, 'one');
    assert.deepEqual(loaded.files, []);
    assert.deepEqual(loaded.completeFiles, []);
  });

  test('malformed ledger version', () => {
    fs.writeFileSync(malformedSpend.target, JSON.stringify({ ...malformedSpend.saved, parserGeneration: '4' }));
    assert.deepEqual(loadSpendLedger(malformedSpend.folder, 'one').files, []);
  });
});

function duplicateSpendFixture() {
  const folder = dir();
  const bucket = aggregateUsageEvents([event(stamp('2026-08-31T10:00:00'))])[0];
  const valid = spendRecord('valid.jsonl', {
    buckets: [bucket],
    lifetimeBuckets: [bucket],
    parserGeneration: PROJECT_SPEND_PARSER_GENERATION,
    parserKind: 'claude',
    parserState: emptyClaudeUsageReducerState(),
    complete: true,
  });
  saveSpendLedger(folder, 'one', [valid]);
  const target = path.join(folder, ledgerName(folder));
  const saved = JSON.parse(ledgerText(folder)) as {
    files: Record<string, unknown>[];
    displayFiles: unknown[];
  };

  return { folder, saved, target };
}

const duplicateSpend = duplicateSpendFixture();

describe('persisted spend validation rejects duplicate bucket and source identities', () => {
  test('duplicate current bucket', () => {
    const { folder, saved, target } = duplicateSpend;
    const copy = structuredClone(saved);
    const buckets = copy.files[0].buckets as unknown[];
    buckets.push(structuredClone(buckets[0]));
    fs.writeFileSync(target, JSON.stringify(copy));
    assert.deepEqual(loadSpendLedger(folder, 'one').files, []);
  });
  test('duplicate lifetime bucket', () => {
    const { folder, saved, target } = duplicateSpend;
    const copy = structuredClone(saved);
    const buckets = copy.files[0].lifetimeBuckets as unknown[];
    buckets.push(structuredClone(buckets[0]));
    fs.writeFileSync(target, JSON.stringify(copy));
    assert.deepEqual(loadSpendLedger(folder, 'one').files, []);
  });
  test('same source under a noncanonical path', () => {
    const { folder, saved, target } = duplicateSpend;
    const copy = structuredClone(saved);
    const duplicate = structuredClone(copy.files[0]);
    duplicate.file = path.join('.', path.basename(String(duplicate.file)));
    copy.files.push(duplicate);
    copy.displayFiles = [0, 1];
    fs.writeFileSync(target, JSON.stringify(copy));
    assert.deepEqual(loadSpendLedger(folder, 'one').files, []);
  });
});

test('a record from a reducer that reports zero turns and no span passes stored-record validation', () => {
  const folder = dir();
  const file = path.join(folder, 'source.jsonl');
  const at = (second: number) => new Date(Date.UTC(2026, 7, 25, 12, 0, second)).toISOString();
  const line = (payload: Record<string, unknown>, second: number) =>
    JSON.stringify({
      timestamp: at(second),
      type: 'event_msg',
      payload,
    });
  // The Codex reducer reports no turn span for this empty task. Stored-record validation must accept both absent timestamps.

  fs.writeFileSync(
    file,
    [
      line({ type: 'task_started', turn_id: 'empty-one' }, 1),
      line({ type: 'task_complete', turn_id: 'empty-one', last_agent_message: '' }, 2),
    ].join('\n') + '\n',
  );

  const indexed = indexSpendFile(undefined, file, 'w', createCodexUsageLineReducer, 1).record;
  assert.equal(indexed.turnCount, 0);
  assert.equal(indexed.firstTurnAt, null);
  assert.equal(indexed.lastTurnAt, null);

  saveSpendLedger(folder, 'w', [indexed]);
  const loaded = loadSpendLedger(folder, 'w');
  assert.equal(loaded.files.length, 1, 'a record with both span timestamps null was rejected');
  assert.equal(loaded.files[0].firstTurnAt, null);
  assert.equal(loaded.files[0].lastTurnAt, null);
});

test('a saved Claude index withdraws a local command whose answer arrives after the load', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
  const prompt = (text: string, second: number, uuid: string) =>
    JSON.stringify({ type: 'user', uuid, timestamp: at(second), message: { role: 'user', content: text } });
  const indexed = createClaudeUsageLineReducer();
  indexed.pushLine(prompt('an unanswered prompt', 0, 'prompt-1'));
  indexed.pushLine(
    prompt('<command-name>/rename</command-name>\n<command-args>next name</command-args>', 1, 'rename-1'),
  );
  const folder = dir();
  const saved = spendRecord('local-command.jsonl', {
    parserGeneration: PROJECT_SPEND_PARSER_GENERATION,
    parserKind: 'claude',
    parserState: indexed.snapshot(),
  });
  saveSpendLedger(folder, 'one', [saved]);
  const loaded = loadSpendLedger(folder, 'one').files[0];
  assert.ok(loaded.parserState, 'the saved index state was rejected on load');

  const resumed = createClaudeUsageLineReducer(loaded.parserState as ClaudeUsageReducerState);
  resumed.pushLine(
    JSON.stringify({
      type: 'system',
      subtype: 'local_command',
      parentUuid: 'rename-1',
      timestamp: at(1),
      content: '<local-command-stdout>Session renamed to: next name</local-command-stdout>',
    }),
  );
  assert.equal(resumed.turnCount(), 1, 'the loaded index counts the command as a turn');
  assert.equal(
    resumed.newestTurnOutcome()?.startedAt,
    Date.parse(at(0)),
    'the loaded index lost the unanswered prompt',
  );

  // The withdrawn command is saved with the index, so model work read after a second load
  // answers the prompt before it and clears the stop the answer gave that prompt.
  saveSpendLedger(folder, 'one', [
    spendRecord('local-command.jsonl', {
      parserGeneration: PROJECT_SPEND_PARSER_GENERATION,
      parserKind: 'claude',
      parserState: resumed.snapshot(),
    }),
  ]);
  const reloaded = loadSpendLedger(folder, 'one').files[0];
  assert.ok(reloaded.parserState, 'the saved withdrawn command was rejected on load');
  const again = createClaudeUsageLineReducer(reloaded.parserState as ClaudeUsageReducerState);
  again.pushLine(
    JSON.stringify({
      type: 'assistant',
      timestamp: at(2),
      message: {
        role: 'assistant',
        id: 'reply-1',
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'The prompt is answered.' }],
      },
    }),
  );
  assert.equal(again.turnCount(), 1, 'the reloaded index counts the command as a turn');
  assert.equal(again.newestTurnOutcome()?.startedAt, Date.parse(at(0)), 'the reply did not land on the waiting prompt');
  assert.equal(again.newestTurnOutcome()?.processEndedAt, undefined, 'the reloaded index kept the inferred stop');
});

test('a record both ledgers share is written once, and a differing one is written twice', () => {
  const folder = dir();
  const shared = [0, 1, 2, 3].map((at) =>
    spendRecord(`shared-${at}.jsonl`, {
      parserGeneration: PROJECT_SPEND_PARSER_GENERATION,
      parserKind: 'claude',
      parserState: {
        ...emptyClaudeUsageReducerState(),
        seenRequestKeys: [`claude:k${at}`],
        closedTurns: at,
      },
    }),
  );
  const whole = spendRecord('rescanned.jsonl', { size: 40, offset: 40 });
  const rescanning = spendRecord('rescanned.jsonl', { size: 90, complete: false, scanOffset: 40 });
  saveSpendLedger(folder, 'one', [...shared, rescanning], [...shared, whole]);

  const text = ledgerText(folder);
  for (const record of shared) {
    assert.equal(
      text.split(`"${record.file}"`).length - 1,
      1,
      `${record.file} is identical in both ledgers, so it belongs in the file once`,
    );
  }
  assert.equal(
    text.split(JSON.stringify(whole.file)).length - 1,
    2,
    'the rescanned file differs between the two ledgers, so each keeps its own record',
  );

  const loaded = loadSpendLedger(folder, 'one');
  assert.deepEqual(loaded.files, [...shared, { ...rescanning, scanOffset: rescanning.offset, trailing: '' }]);
  assert.deepEqual(loaded.completeFiles, [...shared, whole]);
  assert.ok(
    loaded.files[0] === loaded.completeFiles[0],
    'an index loads the record it names, so both lists hold one object',
  );
});

test('a display ledger index that names no record refuses the whole file', () => {
  const folder = dir();
  saveSpendLedger(folder, 'one', [spendRecord('whole.jsonl')]);
  const name = ledgerName(folder);
  const saved = JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(path.join(folder, name), JSON.stringify({ ...saved, displayFiles: [-1] }), 'utf8');

  const loaded = loadSpendLedger(folder, 'one');
  assert.deepEqual(loaded.files, [], 'a damaged file starts over rather than showing a short ledger');
  assert.deepEqual(loaded.completeFiles, []);
});

test('a gap in either list handed over does not spoil the written file', () => {
  const folder = dir();
  const whole = spendRecord('whole.jsonl');
  const second = spendRecord('second.jsonl');
  const gapped: SpendFileIndex[] = [whole];
  gapped[2] = second;
  const gappedDisplay: SpendFileIndex[] = [whole];
  gappedDisplay[2] = second;

  saveSpendLedger(folder, 'one', gapped, gappedDisplay);
  const loaded = loadSpendLedger(folder, 'one');
  assert.deepEqual(
    loaded.files.map((record) => record.file),
    [whole.file, second.file],
  );
  assert.deepEqual(
    loaded.completeFiles.map((record) => record.file),
    [whole.file, second.file],
  );
});

test('a ledger written before the display ledger was shared still loads whole', () => {
  const folder = dir();
  const whole = spendRecord('rescanned.jsonl', { size: 40, offset: 40 });
  const rescanning = spendRecord('rescanned.jsonl', { size: 90, complete: false, scanOffset: 10 });
  saveSpendLedger(folder, 'one', [whole]);
  fs.writeFileSync(
    path.join(folder, ledgerName(folder)),
    JSON.stringify({
      workspace: loadSpendLedger(folder, 'one').workspace,
      parserGeneration: PROJECT_SPEND_PARSER_GENERATION,
      files: [rescanning],
      completeFiles: [whole],
    }),
    'utf8',
  );

  const loaded = loadSpendLedger(folder, 'one');
  assert.equal(
    loaded.parserGeneration,
    PROJECT_SPEND_PARSER_GENERATION,
    'an older file reads at the current generation, so nothing rebuilds',
  );
  assert.deepEqual(loaded.files, [rescanning]);
  assert.deepEqual(loaded.completeFiles, [whole], 'the older array still names the display ledger');
});

test('a current parser snapshot without a source kind rebuilds instead of resuming ambiguously', () => {
  const folder = dir();
  const record = spendRecord('source.jsonl', {
    parserGeneration: PROJECT_SPEND_PARSER_GENERATION,
    parserState: emptyClaudeUsageReducerState(),
  });
  saveSpendLedger(folder, 'one', [record]);

  const loaded = loadSpendLedger(folder, 'one').files[0];
  assert.equal(loaded.parserGeneration, 0);
  assert.equal(loaded.parserState, undefined);
});

test('saving trims a retained request window written under a larger limit', () => {
  const folder = dir();
  const keys = Array.from({ length: RETAINED_REQUESTS + 20 }, (unused, at) => `claude:m${at}`);
  const requestEvents = Object.fromEntries(
    keys.map((key) => [
      key,
      event(1, {
        agent: 'claude',
        contextBand: null,
        requestKey: key,
      }),
    ]),
  );
  const buckets = aggregateUsageEvents([event(1)]);
  const record = spendRecord('child.jsonl', {
    buckets,
    parserGeneration: PROJECT_SPEND_PARSER_GENERATION,
    parserKind: 'claude',
    parserState: {
      seenRequestKeys: keys,
      closedTurns: 1,
      openTurn: false,
      openTurnAnswered: false,
      compactionCount: 0,
      recentCompactions: [],
      visibleTurns: 0,
      firstTurnAt: null,
      currentTurnStartedAt: null,
      currentTurnEndedAt: null,
      currentTurnOutcome: null,
      requestEvents,
    },
  });
  saveSpendLedger(folder, 'one', [record]);

  const [saved] = loadSpendLedger(folder, 'one').files;
  const state = saved.parserState as { seenRequestKeys: string[]; requestEvents: Record<string, UsageEvent> };
  assert.deepEqual(Object.keys(state.requestEvents), keys.slice(-RETAINED_REQUESTS));
  assert.deepEqual(state.seenRequestKeys, keys, 'the save trims the event map and leaves the saved queue alone');
  assert.deepEqual(saved.buckets, record.buckets, 'trimming the window changes no total');
});

test('a save clears the temporaries an earlier save in this process left behind', () => {
  const folder = dir();
  saveSpendLedger(folder, 'one', []);
  const name = ledgerName(folder);
  for (const at of [1, 2, 3]) {
    fs.writeFileSync(path.join(folder, `${name}.${process.pid}.${at}.tmp`), '');
  }
  saveSpendLedger(folder, 'one', []);
  assert.deepEqual(
    fs.readdirSync(folder).filter((entry) => entry.endsWith('.tmp')),
    [],
  );
});

test('a save that cannot finish leaves no temporary behind', () => {
  const folder = dir();
  saveSpendLedger(folder, 'one', []);
  const held = path.join(folder, ledgerName(folder));
  fs.unlinkSync(held);
  fs.mkdirSync(held);
  fs.writeFileSync(path.join(held, 'blocking'), 'x');

  assert.throws(() => saveSpendLedger(folder, 'one', []));
  assert.deepEqual(
    fs.readdirSync(folder).filter((entry) => entry.endsWith('.tmp')),
    [],
  );
});

test('a subagent transcript read as a parent saves complete and empty', () => {
  // A parent reducer skips all sidechain records and stores a complete empty result. Reader role therefore affects the persisted figures.

  const folder = dir();
  const file = path.join(folder, 'p', 'subagents', 'child.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      type: 'assistant',
      isSidechain: true,
      uuid: 'u1',
      timestamp: '2026-08-31T10:00:00Z',
      message: { id: 'm1', model: 'claude-opus-5', usage: { input_tokens: 3, output_tokens: 4 } },
    }) + '\n',
  );
  const readAs = (primary: boolean) => (state: Parameters<typeof createClaudeUsageLineReducer>[0]) =>
    createClaudeUsageLineReducer(state, { childTranscript: !primary });

  const asParent = indexSpendFile(undefined, file, 'w', readAs(true), 1).record;
  assert.deepEqual(asParent.buckets, [], 'a parent read must count none of a subagent transcript');
  assert.equal(asParent.complete, true, 'and must then hold the file as finished');

  const byPath = indexSpendFile(undefined, file, 'w', readAs(!spendFileIsClaudeChild(file)), 1).record;
  assert.equal(byPath.buckets[0]?.requests, 1, 'the role taken from the path did not count the subagent transcript');
});

test('a saved record names the reader that made it, not its first surviving bucket', () => {
  // Embedded Claude usage sorts before Codex usage. Reader identity must remain Codex even when the retained buckets change.

  const rollout = {
    file: 'rollout.jsonl',
    workspace: 'w',
    size: 0,
    mtimeMs: 0,
    offset: 0,
    trailing: '',
    buckets: aggregateUsageEvents([event(stamp('2026-08-02T10:00:00'), { agent: 'claude' })]),
    lifetimeBuckets: aggregateUsageEvents([
      event(stamp('2026-07-20T10:00:00'), { agent: 'codex' }),
      event(stamp('2026-08-02T10:00:00'), { agent: 'claude' }),
    ]),
    indexedAt: 1,
  };
  assert.equal(
    spendRecordAgent(rollout),
    'codex',
    'a Codex rollout was handed to the Claude reader, which counts nothing in it',
  );
  assert.equal(spendRecordAgent({ ...rollout, lifetimeBuckets: rollout.buckets }), 'claude');
  assert.equal(spendRecordAgent({ ...rollout, parserKind: 'codex', lifetimeBuckets: rollout.buckets }), 'codex');
  assert.equal(
    spendRecordAgent({
      ...rollout,
      lifetimeBuckets: aggregateUsageEvents([event(stamp('2026-08-02T10:00:00'), { agent: 'Codex' })]),
    }),
    'codex',
    'an agent saved under another case named the wrong reader',
  );
});

test('a re-offered record takes the same role discovery gave the same file', () => {
  // A record re-offered from the saved ledger carries no role of its own, so the re-offer
  // reads the role off the path. The two must agree for every file discovery can offer.
  const folder = dir();
  const parent = path.join(folder, 'parent.jsonl');
  const children = path.join(folder, 'p', 'subagents');
  fs.mkdirSync(children, { recursive: true });
  fs.writeFileSync(parent, '');
  fs.writeFileSync(path.join(children, 'child.jsonl'), '');

  const sources = discoverClaudeSessionSpendSources([{ file: parent, sessionId: 'p' }]);
  assert.equal(sources.length, 2, 'the fixture must offer one parent and one child');
  for (const source of sources) {
    assert.equal(
      !spendFileIsClaudeChild(normalizeSpendFile(source.file)),
      source.primary,
      'the re-offer and discovery disagree about ' + source.file,
    );
  }
});

test('source discovery includes all parent and child sources once', () => {
  const folder = dir();
  const parent = path.join(folder, 'parent.jsonl');
  const children = path.join(folder, 'p', 'subagents');
  fs.mkdirSync(children, { recursive: true });
  fs.writeFileSync(parent, '');
  fs.writeFileSync(path.join(children, 'child.jsonl'), '');
  assert.deepEqual(
    discoverClaudeSpendSources([{ file: parent, sessionId: 'p' }]).sort(),
    [parent, path.join(children, 'child.jsonl')].sort(),
  );
  assert.equal(
    discoverCodexSpendSources([{ file: parent }], [{ file: parent }, { file: path.join(children, 'child.jsonl') }])
      .length,
    2,
  );
  assert.deepEqual(
    discoverClaudeSessionSpendSources([{ file: parent, sessionId: 'p' }]).map((source) => [
      source.sessionId,
      source.primary,
    ]),
    [
      ['p', true],
      ['p', false],
    ],
  );
  const codex = discoverCodexSessionSpendSources(
    [{ file: parent, sessionId: 'root' }],
    [
      { file: path.join(children, 'child.jsonl'), threadId: 'child', parentThreadId: 'root' },
      { file: path.join(children, 'grandchild.jsonl'), threadId: 'grandchild', parentThreadId: 'child' },
    ],
  );
  assert.deepEqual(
    codex.map((source) => [source.sessionId, source.primary]),
    [
      ['root', true],
      ['root', false],
      ['root', false],
    ],
  );
});

// Reference source discovery follows each child's parent chain. The indexed traversal must return the same sources.

function referenceCodexSessionSpendSources(sessions: readonly SpendSessionFile[], children: readonly SpendChildFile[]) {
  const byThread = new Map(children.map((child) => [child.threadId, child]));
  const out: SessionSpendSource[] = [];
  for (const session of sessions) {
    out.push({ sessionId: session.sessionId, file: session.file, primary: true });
    for (const child of children) {
      let parent = child.parentThreadId;
      const seen = new Set<string>();
      while (parent && !seen.has(parent)) {
        if (parent === session.sessionId) {
          out.push({ sessionId: session.sessionId, file: child.file, primary: false });
          break;
        }
        seen.add(parent);
        parent = byThread.get(parent)?.parentThreadId ?? null;
      }
    }
  }
  return out;
}

function referenceClaudeSessionSpendSources(
  parents: readonly SpendSessionFile[],
  files: (directory: string) => readonly string[],
) {
  const sources: SessionSpendSource[] = [];
  const seen = new Set<string>();
  const add = (source: SessionSpendSource) => {
    const key = `${source.sessionId}\0${source.file}`;
    if (!seen.has(key)) {
      seen.add(key);
      sources.push(source);
    }
  };
  const bySession = new Map(parents.map((parent) => [parent.sessionId, parent]));
  for (const parent of parents) {
    add({ sessionId: parent.sessionId, file: parent.file, primary: true });
    for (const file of files(path.join(path.dirname(parent.file), parent.sessionId, 'subagents'))) {
      add({ sessionId: parent.sessionId, file, primary: false });
    }
    for (const candidate of parents) {
      let ancestor = candidate.parentSessionId;
      const visited = new Set<string>();
      while (ancestor && !visited.has(ancestor)) {
        if (ancestor === parent.sessionId) {
          add({ sessionId: parent.sessionId, file: candidate.file, primary: false });
          break;
        }
        visited.add(ancestor);
        ancestor = bySession.get(ancestor)?.parentSessionId;
      }
    }
  }
  return sources;
}

test('indexed spend source discovery matches the chain walk for cycles, missing parents, and repeats', () => {
  let state = 20260915;
  const pick = (limit: number) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % limit;
  };
  const ids = ['', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const folder = path.join(dir(), 'sessions');
  const fileOf = (index: number) => path.join(folder, `f${index}.jsonl`);
  const listing = (directory: string) =>
    directory.length % 3 === 0 ? [path.join(directory, 'agent.jsonl'), fileOf(1)] : [];
  for (let round = 0; round < 400; round++) {
    const sessions = Array.from({ length: pick(7) }, () => ({
      sessionId: ids[pick(ids.length)],
      file: fileOf(pick(6)),
    }));
    const children = Array.from({ length: pick(12) }, () => ({
      threadId: ids[pick(ids.length)],
      parentThreadId: pick(5) === 0 ? null : ids[pick(ids.length)],
      file: fileOf(pick(10)),
    }));
    assert.deepEqual(
      discoverCodexSessionSpendSources(sessions, children),
      referenceCodexSessionSpendSources(sessions, children),
      'Codex sources differ for ' + JSON.stringify({ sessions, children }),
    );
    const parents = Array.from({ length: pick(10) }, () => ({
      sessionId: ids[pick(ids.length)],
      file: fileOf(pick(8)),
      ...(pick(4) === 0 ? {} : { parentSessionId: ids[pick(ids.length)] }),
    }));
    assert.deepEqual(
      discoverClaudeSessionSpendSources(parents, { files: listing }).map(
        ({ nativeParentFile: _parent, ...source }) => source,
      ),
      referenceClaudeSessionSpendSources(parents, listing),
      'Claude sources differ for ' + JSON.stringify(parents),
    );
  }
  const chain = Array.from({ length: 150 }, (_, index) => ({
    threadId: `t${index}`,
    parentThreadId: index ? `t${index - 1}` : 'root',
    file: fileOf(index),
  }));
  const siblings = Array.from({ length: 150 }, (_, index) => ({
    threadId: `s${index}`,
    parentThreadId: `t${(index * 7) % 150}`,
    file: fileOf(1000 + index),
  }));
  const deep = [...siblings, ...chain].sort((a, b) => a.file.localeCompare(b.file));
  const owners = [
    { sessionId: 'root', file: fileOf(-1) },
    ...chain.map((child) => ({ sessionId: child.threadId, file: child.file })),
  ];
  assert.deepEqual(
    discoverCodexSessionSpendSources(owners, deep),
    referenceCodexSessionSpendSources(owners, deep),
    'a deep chain with many siblings lost or reordered a source',
  );
});

test('a Claude subagent listing is read again when its directory time moves', () => {
  const folder = dir();
  const parent = path.join(folder, 'parent.jsonl');
  const children = path.join(folder, 'p', 'subagents');
  fs.mkdirSync(children, { recursive: true });
  fs.writeFileSync(parent, '');
  fs.writeFileSync(path.join(children, 'one.jsonl'), '');
  const settled = new Date('2026-08-01T00:00:00Z');
  const moved = new Date('2026-08-02T00:00:00Z');
  fs.utimesSync(children, settled, settled);
  const directories = new SubagentDirectoryCache();
  const names = (reader = directories) =>
    discoverClaudeSessionSpendSources([{ file: parent, sessionId: 'p' }], reader)
      .map((source) => path.basename(source.file))
      .sort();
  assert.deepEqual(names(), ['one.jsonl', 'parent.jsonl']);
  fs.writeFileSync(path.join(children, 'two.jsonl'), '');
  fs.utimesSync(children, settled, settled);
  assert.deepEqual(names(), ['one.jsonl', 'parent.jsonl'], 'an unchanged directory time listed the directory again');
  fs.utimesSync(children, moved, moved);
  assert.deepEqual(
    names(),
    ['one.jsonl', 'parent.jsonl', 'two.jsonl'],
    'a new subagent transcript never became a spend source',
  );
  const young = new SubagentDirectoryCache(undefined, () => moved.getTime() + SUBAGENT_DIRECTORY_SETTLE_MS / 2);
  names(young);
  fs.writeFileSync(path.join(children, 'three.jsonl'), '');
  fs.utimesSync(children, moved, moved);
  assert.deepEqual(
    names(young),
    ['one.jsonl', 'parent.jsonl', 'three.jsonl', 'two.jsonl'],
    'a listing read inside the settle window hid a transcript added in the same clock tick',
  );
});

test('session spend sources are built again when a listed file or a parent link changes', () => {
  const index = new SessionSpendSourceIndex();
  const claude = [{ sessionId: 'c', file: 'c.jsonl', primary: true }];
  const sessions = [
    { sessionId: 'root', file: 'root.jsonl' },
    { sessionId: 'other', file: 'other.jsonl' },
  ];
  const pairs = () => index.sources.map((source) => `${source.sessionId}:${source.file}:${source.primary}`);
  index.update(claude, [], sessions, []);
  const held = index.sources;
  const first = index.revision;
  index.update([...claude], [], [...sessions], []);
  assert.equal(index.sources, held, 'an unchanged listing built the sources again');
  assert.equal(index.revision, first, 'an unchanged listing moved the revision');
  index.update(claude, [], sessions, [{ threadId: 'kid', parentThreadId: 'root', file: 'kid.jsonl' }]);
  assert.deepEqual(
    pairs(),
    ['c:c.jsonl:true', 'root:root.jsonl:true', 'root:kid.jsonl:false', 'other:other.jsonl:true'],
    'a new child session never became a spend source',
  );
  const kid = [{ threadId: 'kid', parentThreadId: 'other', file: 'kid.jsonl' }];
  index.update(claude, [], sessions, kid);
  assert.deepEqual(
    pairs(),
    ['c:c.jsonl:true', 'root:root.jsonl:true', 'other:other.jsonl:true', 'other:kid.jsonl:false'],
    'a changed parent kept the old owner',
  );
  const grown = [...sessions, { sessionId: 'new', file: 'new.jsonl' }];
  index.update(claude, [], grown, kid);
  assert.equal(pairs().at(-1), 'new:new.jsonl:true', 'a new session file never became a spend source');
  const moved = index.revision;
  assert.ok(moved > first, 'a changed source list kept the revision');
  index.update([{ ...claude[0], primary: false }], [], grown, kid);
  assert.ok(index.revision > moved, 'a source changing between main and delegated work kept the revision');
});

// A dispatched session contributes its whole cost as delegated work to its parent. Project totals count each transcript once.

describe('a dispatched session in lifetime cost', () => {
  const at = stamp('2026-08-31T10:00:00');
  const record = (file: string, input: number): SpendFileIndex => {
    const lifetimeBuckets = aggregateUsageEvents([
      event(at, { agent: 'claude', provider: null, model: 'claude-opus-5', usage: { ...usage(), input } }),
    ]);
    return {
      file,
      workspace: 'w',
      size: 10,
      mtimeMs: at,
      offset: 10,
      trailing: '',
      buckets: lifetimeBuckets,
      indexedAt: 1,
      lifetimeBuckets,
      turnCount: 1,
      compactionCount: 0,
      firstTurnAt: at,
      lastTurnAt: at,
      newestTurnStartedAt: at,
      outcome: null,
      cacheExpiry: undefined,
      parserGeneration: PROJECT_SPEND_PARSER_GENERATION,
    };
  };
  const records = [
    record('parent.jsonl', 100_000),
    record('child.jsonl', 150_000),
    record('child-agent.jsonl', 50_000),
  ];
  const claude = discoverClaudeSessionSpendSources(
    [
      { file: 'parent.jsonl', sessionId: 'parent' },
      { file: 'child.jsonl', sessionId: 'child' },
    ],
    { files: (directory) => (directory.includes('child') ? ['child-agent.jsonl'] : []) },
  );
  const launch = (toolUseId: string) => ({
    kind: 'dispatch' as const,
    parentSessionId: 'parent',
    sessionId: 'child',
    file: 'child.jsonl',
    toolUseIds: [toolUseId],
  });
  const sourcesWith = (references: Parameters<typeof sessionParentIndex>[0]) =>
    new SessionSpendSourceIndex().update(
      claude,
      [],
      [],
      [],
      undefined,
      dispatchedParents(sessionParentIndex(references)),
    );
  // Project the session figures supplied to the panel.
  const costs = (
    sources: readonly SessionSpendSource[],
    files: readonly SpendFileIndex[] = records,
    pending?: (file: string, record: SpendFileIndex | undefined) => boolean,
  ) => {
    const awaiting = new Set<string>();
    return Object.fromEntries(
      Object.entries(sessionSpendPartsBySession(files, sources, awaiting, pending)).map(([id, parts]) => [
        id,
        sessionCostProjection(
          parts.map(({ bucket, role, scopeId }) => ({ ...bucket, role, scopeId })),
          awaiting.has(id),
        ),
      ]),
    );
  };
  const projectTotal = (sources: readonly SessionSpendSource[], held = records) => {
    const files = new Set(sources.map((source) => source.file));
    return prepareProjectSpendView(
      held.filter((file) => files.has(file.file)),
      publicProjectSpendPrice,
      { now: at },
    ).windows[0].dollars;
  };

  // What each dispatched session adds to a turn card of a session above it.
  const contributionCost = (contribution: { parts: Record<string, SessionSpendPart[]> } | undefined) =>
    sessionCostProjection(
      Object.values(contribution?.parts ?? {}).flatMap((parts) =>
        parts.map(({ bucket, role, scopeId }) => ({ ...bucket, role, scopeId })),
      ),
    ).total.dollars;
  const chain = (parents: [string, string][], delegators: [string, string][] = []) =>
    withDispatchedSpendSources(
      ['parent', 'helper', 'child', 'other', 'grandchild'].map((id) => ({
        sessionId: id,
        file: `${id}.jsonl`,
        primary: true,
      })),
      new Map(parents),
      new Map(delegators),
    );
  const chainRecords = ['parent', 'helper', 'child', 'other', 'grandchild'].map((id, at) =>
    record(`${id}.jsonl`, 100_000 * (at + 1)),
  );

  test('a dispatched contribution waits per group by the session total rule and its history limit', () => {
    const sources = chain([['child', 'parent']]);
    const writing = chainRecords.map((held) =>
      held.file === 'child.jsonl' ? { ...held, trailing: '{"type":', mtimeMs: at } : held,
    );
    const waiting = dispatchedSpendPartsBySession(writing, sources, () => true).parent.child;
    assert.deepEqual([waiting.short, waiting.parts], [true, {}]);
    const past = dispatchedSpendPartsBySession(writing, sources, (_file, held) => spendSourceHeld(held, false, at + 1))
      .parent.child;
    assert.equal(past.short, false);
    assert.deepEqual(
      past.parts.child.map((part) => part.bucket),
      writing.find((held) => held.file === 'child.jsonl')!.lifetimeBuckets,
    );
    assert.equal(past.own?.file.endsWith('child.jsonl'), true);
    // A child the ledger never read waits while the ledger queues it, then adds nothing.
    const unread = chainRecords.filter((held) => held.file !== 'child.jsonl');
    assert.equal(dispatchedSpendPartsBySession(unread, sources, () => true).parent.child.short, true);
    const dropped = dispatchedSpendPartsBySession(unread, sources, () => false).parent.child;
    assert.deepEqual([dropped.short, dropped.parts.child], [false, []]);
  });

  test('a dispatched contribution holds the sessions its session dispatched, and the session total does not move', () => {
    const sources = chain([
      ['child', 'parent'],
      ['grandchild', 'child'],
    ]);
    const writing = chainRecords.map((held) =>
      held.file === 'grandchild.jsonl' ? { ...held, trailing: '{"type":' } : held,
    );
    const contribution = dispatchedSpendPartsBySession(writing, sources, () => true).parent.child;
    assert.equal(contribution.short, true, 'a waiting grandchild left the contribution whole');
    assert.deepEqual(Object.keys(contribution.parts), ['child']);
    const total = costs(sources, writing, () => true).parent.total.dollars!;
    // The parent's own 100k input and the ready child's 300k, without the waiting grandchild.
    assert.ok(Math.abs(total - 2.00005) < 1e-9, `the session total moved to ${total}`);
    const own = costs(chain([]), writing).parent.total.dollars!;
    assert.ok(Math.abs(contributionCost(contribution)! - (total - own)) < 1e-9);
    const ready = dispatchedSpendPartsBySession(chainRecords, sources, () => true).parent.child;
    assert.deepEqual([ready.short, Object.keys(ready.parts).sort()], [false, ['child', 'grandchild']]);
  });

  test('a session that a subagent dispatched reaches the top session under its own id', () => {
    const sources = chain(
      [
        ['child', 'helper'],
        ['grandchild', 'child'],
        ['other', 'helper'],
      ],
      [['helper', 'parent']],
    );
    const top = dispatchedSpendPartsBySession(chainRecords, sources, () => true).parent;
    assert.deepEqual(Object.keys(top).sort(), ['child', 'other']);
    assert.deepEqual(Object.keys(top.child.parts).sort(), ['child', 'grandchild']);
    assert.deepEqual(Object.keys(top.other.parts), ['other']);
    assert.equal(top.helper, undefined, 'a subagent became a contribution key');
  });

  test("a parent's delegated work holds the dispatched session's whole cost once", () => {
    const alone = costs(sourcesWith([]));
    const child = alone.child.total.dollars;
    const parent = alone.parent.total.dollars;
    assert.ok(child !== null && parent !== null && child > 0 && parent > 0, 'the fixture priced nothing');
    for (const references of [[launch('toolu_1')], [launch('toolu_1'), launch('toolu_2')]]) {
      const linked = costs(sourcesWith(references));
      assert.ok(
        Math.abs((linked.parent.total.dollars ?? 0) - (parent + child)) < 1e-9,
        `${references.length} launch results put ${linked.parent.total.dollars} on the parent, not ${parent} plus the child's ${child}`,
      );
      const delegated = linked.parent.stats[0]?.detailList?.entries.find((entry) => entry.label === 'Delegated work');
      assert.ok(delegated, "the parent's cost names no delegated work");
      assert.equal(
        delegated.value,
        alone.child.stats[0]?.detailList?.heading?.value,
        "the parent's delegated work does not read as the child's own total",
      );
      assert.equal(linked.child.total.dollars, child, "the dispatched session's own total moved");
      assert.equal(linked.parent.total.partial, false, "the parent's whole figure reads as a lower bound");
    }
  });

  // A subagent's shell command can dispatch a session too. The top session's figure already
  // holds the subagent's transcript, and the dispatched session joins it through the subagent.
  test("a session a subagent dispatched counts once in the top session's delegated work", () => {
    const held = [record('top.jsonl', 100_000), record('helper.jsonl', 40_000), record('launched.jsonl', 150_000)];
    const directories = { files: (directory: string) => (directory.includes('top') ? ['helper.jsonl'] : []) };
    const helper = { sessionId: 'helper', file: 'helper.jsonl', parentSessionId: 'top' };
    const sessions = discoverClaudeSessionSpendSources(
      [
        { file: 'top.jsonl', sessionId: 'top' },
        { file: 'launched.jsonl', sessionId: 'launched' },
      ],
      directories,
    );
    const dispatch = (toolUseId: string) => ({
      kind: 'dispatch' as const,
      parentSessionId: 'helper',
      sessionId: 'launched',
      file: 'launched.jsonl',
      toolUseIds: [toolUseId],
    });
    const nested = (references: Parameters<typeof sessionParentIndex>[0]) =>
      new SessionSpendSourceIndex().update(
        sessions,
        [helper],
        [],
        [],
        directories,
        dispatchedParents(sessionParentIndex(references, [helper])),
      );
    const without = nested([]);
    const alone = costs(without, held);
    const top = alone.top.total.dollars ?? 0;
    const launched = alone.launched.total.dollars ?? 0;
    assert.ok(top > 0 && launched > 0 && (alone.helper.total.dollars ?? 0) > 0, 'the fixture priced nothing');
    for (const references of [[dispatch('toolu_1')], [dispatch('toolu_1'), dispatch('toolu_2')]]) {
      const linked = nested(references);
      const figures = costs(linked, held);
      assert.ok(
        Math.abs((figures.top.total.dollars ?? 0) - (top + launched)) < 1e-9,
        `${references.length} launch results put ${figures.top.total.dollars} on the top session, not ${top} plus the dispatched ${launched}`,
      );
      const delegated = figures.top.stats[0]?.detailList?.entries.find((entry) => entry.label === 'Delegated work');
      assert.equal(
        delegated?.value,
        figures.helper.stats[0]?.detailList?.heading?.value,
        "the top session's delegated work does not read as the subagent's whole figure",
      );
      assert.equal(figures.launched.total.dollars, launched, "the dispatched session's own total moved");
      assert.equal(
        projectTotal(linked, held),
        projectTotal(without, held),
        "the subagent's dispatch edge changed the project total",
      );
    }
  });

  // An unfinished dispatched session leaves the parent's own cost available and contributes a lower-bound delegated figure.

  test("a parent keeps its own figure while a dispatched session's source is not whole", () => {
    const alone = costs(sourcesWith([]));
    const parent = alone.parent.total.dollars;
    const sources = sourcesWith([launch('toolu_1')]);
    const unsettled: [string, (file: string) => SpendFileIndex[]][] = [
      ['missing', (file) => records.filter((record) => record.file !== file)],
      [
        'unfinished',
        (file) => records.map((record) => (record.file === file ? { ...record, complete: false } : record)),
      ],
      [
        'half a line',
        (file) => records.map((record) => (record.file === file ? { ...record, trailing: '{"type"' } : record)),
      ],
    ];
    for (const [state, files] of unsettled) {
      for (const file of ['child.jsonl', 'child-agent.jsonl']) {
        const linked = costs(sources, files(file));
        assert.ok(linked.parent, `the parent's figure went blank while the dispatched ${file} was ${state}`);
        assert.equal(
          linked.parent.total.dollars,
          parent,
          `the parent counted part of a dispatched session while its ${file} was ${state}`,
        );
        assert.equal(
          linked.parent.total.partial,
          true,
          `the parent's figure was not a lower bound while the dispatched ${file} was ${state}`,
        );
        assert.match(
          linked.parent.stats[0]?.label ?? '',
          /[+]$/,
          `the parent's cost drew no lower-bound mark while the dispatched ${file} was ${state}`,
        );
      }
    }
  });

  // A skipped or missing source retains recorded usage without a lower-bound mark. A queued or unfinished source keeps that mark.

  test('a dispatched source the ledger no longer reads keeps the usage it read and marks nothing', () => {
    const own = costs(sourcesWith([])).parent.total.dollars;
    const sources = sourcesWith([launch('toolu_1')]);
    const child = (change: Partial<SpendFileIndex> | null) =>
      records.flatMap((record) =>
        record.file !== 'child.jsonl' ? [record] : change === null ? [] : [{ ...record, ...change }],
      );
    const whole = costs(sources).parent.total.dollars ?? 0;
    const subagentOnly = costs(sources, child({ lifetimeBuckets: [] })).parent.total.dollars ?? 0;
    assert.ok(subagentOnly > (own ?? 0) && whole > subagentOnly, 'the fixture priced no subagent of the child');
    for (const [state, files, expected] of [
      ['has no record while its subagent was read', child(null), subagentOnly],
      ['went away before any read', child({ missingAt: 1, complete: false, lifetimeBuckets: undefined }), subagentOnly],
      ['went away after a read', child({ missingAt: 1, complete: false }), whole],
    ] as const) {
      const reading = costs(sources, files, () => true).parent;
      assert.equal(
        reading.total.dollars,
        own,
        `the parent counted part of a child the ledger still reads that ${state}`,
      );
      assert.equal(
        reading.total.partial,
        true,
        `the parent drew whole while the ledger still reads a child that ${state}`,
      );
      const done = costs(sources, files, () => false).parent;
      assert.ok(
        Math.abs((done.total.dollars ?? 0) - expected) < 1e-9,
        `the parent drew ${done.total.dollars}, not ${expected}, for a child that ${state}`,
      );
      assert.equal(done.total.partial, false, `the parent stayed a lower bound for a child that ${state}`);
      assert.doesNotMatch(
        done.stats[0]?.label ?? '',
        /[+]$/,
        `the parent drew a lower bound for a child that ${state}`,
      );
    }
    const writing = child({ trailing: '{"type":' });
    const heldUntil = (cutoff: number | null) => (_file: string, record: SpendFileIndex | undefined) =>
      spendSourceHeld(record, false, cutoff);
    assert.equal(
      costs(sources, writing, heldUntil(null)).parent.total.partial,
      true,
      'the parent hid a child still being written',
    );
    const cut = costs(sources, writing, heldUntil(Number.MAX_SAFE_INTEGER)).parent;
    assert.equal(cut.total.partial, false, 'a child cut off mid-line past the history limit held its parent');
    assert.ok(
      Math.abs((cut.total.dollars ?? 0) - whole) < 1e-9,
      `a child cut off mid-line past the history limit put ${cut.total.dollars} on the parent, not ${whole}`,
    );
  });

  // Two sessions that each name the other as the session they dispatched climb once around the
  // loop and stop. Each figure counts every transcript once.
  test('a dispatch cycle counts each session once and ends', () => {
    const alone = costs(sourcesWith([]));
    const back = {
      kind: 'dispatch' as const,
      parentSessionId: 'child',
      sessionId: 'parent',
      file: 'parent.jsonl',
      toolUseIds: ['toolu_9'],
    };
    const sources = sourcesWith([launch('toolu_1'), back]);
    const both = (alone.parent.total.dollars ?? 0) + (alone.child.total.dollars ?? 0);
    const linked = costs(sources);
    for (const id of ['parent', 'child']) {
      assert.ok(
        Math.abs((linked[id].total.dollars ?? 0) - both) < 1e-9,
        `the cycle put ${linked[id].total.dollars} on ${id}, not the two sessions' ${both}`,
      );
    }
    assert.equal(projectTotal(sources), projectTotal(sourcesWith([])), 'the cycle changed the project total');
  });

  test('a Codex subagent dispatch joins its parent cost once', () => {
    const held = [record('codex-a.jsonl', 10_000), record('codex-b.jsonl', 20_000), record('claude-c.jsonl', 30_000)];
    const children = [{ threadId: 'codex-b', parentThreadId: 'codex-a', file: 'codex-b.jsonl' }];
    const codex = [{ sessionId: 'codex-a', file: 'codex-a.jsonl' }];
    const claude = [{ sessionId: 'claude-c', file: 'claude-c.jsonl', primary: true }];
    const references = [
      {
        kind: 'dispatch' as const,
        parentSessionId: 'codex-b',
        sessionId: 'claude-c',
        file: 'claude-c.jsonl',
        toolUseIds: ['launch', 'repeated-launch'],
      },
    ];
    const sources = new SessionSpendSourceIndex().update(
      claude,
      [],
      codex,
      children,
      undefined,
      dispatchedParents(sessionParentIndex(references)),
    );
    const figures = costs(sources, held);
    const alone = costs(new SessionSpendSourceIndex().update(claude, [], codex, children), held);
    assert.equal(
      sources.filter((source) => source.sessionId === 'codex-a' && source.file === 'claude-c.jsonl').length,
      1,
    );
    assert.ok(
      Math.abs(
        (figures['codex-a'].total.dollars ?? 0) -
          ((alone['codex-a'].total.dollars ?? 0) + (alone['claude-c'].total.dollars ?? 0)),
      ) < 1e-9,
    );
    assert.equal(
      projectTotal(sources, held),
      projectTotal(new SessionSpendSourceIndex().update(claude, [], codex, children), held),
    );
  });

  // Follow the mixed subagent and dispatch chain once. An unfinished deepest source marks the top session's delegated figure as a lower bound.

  test("a mixed chain of subagents and dispatched sessions counts once in the top session's figure", () => {
    const ids = ['top', 'helper', 'launched', 'worker', 'deep'];
    const held = ids.map((id, at) => record(`${id}.jsonl`, 10_000 * (at + 1)));
    const directories = {
      files: (directory: string) =>
        directory.includes('top') ? ['helper.jsonl'] : directory.includes('launched') ? ['worker.jsonl'] : [],
    };
    const children = [
      { sessionId: 'helper', file: 'helper.jsonl', parentSessionId: 'top' },
      { sessionId: 'worker', file: 'worker.jsonl', parentSessionId: 'launched' },
    ];
    const sessions = discoverClaudeSessionSpendSources(
      ['top', 'launched', 'deep'].map((id) => ({ file: `${id}.jsonl`, sessionId: id })),
      directories,
    );
    const dispatch = (parentSessionId: string, sessionId: string) => ({
      kind: 'dispatch' as const,
      parentSessionId,
      sessionId,
      file: `${sessionId}.jsonl`,
      toolUseIds: [`toolu_${sessionId}`],
    });
    const chain = (references: Parameters<typeof sessionParentIndex>[0]) =>
      new SessionSpendSourceIndex().update(
        sessions,
        children,
        [],
        [],
        directories,
        dispatchedParents(sessionParentIndex(references, children)),
      );
    const alone = costs(chain([]), held);
    const linked = chain([dispatch('helper', 'launched'), dispatch('worker', 'deep')]);
    const figures = costs(linked, held);
    const whole = ['top', 'launched', 'deep'].reduce((sum, id) => sum + (alone[id].total.dollars ?? 0), 0);
    assert.ok(
      Math.abs((figures.top.total.dollars ?? 0) - whole) < 1e-9,
      `the chain put ${figures.top.total.dollars} on the top session, not ${whole}`,
    );
    const below = (alone.launched.total.dollars ?? 0) + (alone.deep.total.dollars ?? 0);
    assert.ok(
      Math.abs((figures.launched.total.dollars ?? 0) - below) < 1e-9,
      `the chain put ${figures.launched.total.dollars} on the dispatched session, not ${below}`,
    );
    assert.equal(projectTotal(linked, held), projectTotal(chain([]), held), 'the chain changed the project total');
    const delegatedOf = (figure: (typeof figures)[string]) => {
      const value = figure.stats[0]?.detailList?.entries.find((entry) => entry.label === 'Delegated work')?.value;
      return typeof value === 'string' ? value : '';
    };
    const footerOf = (figure: (typeof figures)[string]) => figure.stats[0]?.detailList?.footer ?? [];
    const writing = held.map((file) => (file.file === 'deep.jsonl' ? { ...file, complete: false } : file));
    const short = costs(linked, writing).top;
    assert.match(delegatedOf(short), /[+]$/, "the top session's delegated work drew no lower-bound mark");
    assert.ok(
      footerOf(short).some((line) => typeof line === 'string' && line.includes('may be low')),
      'the top session lost the may-be-low note',
    );
    const done = costs(linked, held).top;
    assert.doesNotMatch(delegatedOf(done), /[+]$/, 'the delegated work kept its mark once the record completed');
    assert.ok(
      !footerOf(done).some((line) => typeof line === 'string' && line.includes('may be low')),
      'the may-be-low note outlived the partial record',
    );
  });

  // Resolving a path can read the filesystem, so a project with thousands of sessions and one
  // dispatch edge resolves only the paths of the two sessions the edge names.
  test('a dispatch edge resolves only the paths of the sessions it names', () => {
    const folder = dir();
    const sources: SessionSpendSource[] = [
      { sessionId: 'parent', file: path.join(folder, 'parent.jsonl'), primary: true },
      { sessionId: 'child', file: path.join(folder, 'child.jsonl'), primary: true },
      ...Array.from({ length: 200 }, (_, at) => ({
        sessionId: `other-${at}`,
        file: path.join(folder, `other-${at}.jsonl`),
        primary: true,
      })),
    ];
    const nativeRealpath = fs.realpathSync.native;
    let realpathCalls = 0;
    vi.spyOn(fs.realpathSync, 'native').mockImplementation((candidate: fs.PathLike) => {
      realpathCalls++;
      return nativeRealpath(candidate);
    });
    const out = withDispatchedSpendSources(sources, new Map([['child', 'parent']]));
    assert.deepEqual(out.at(-1), {
      sessionId: 'parent',
      file: sources[1].file,
      primary: false,
      dispatchedFrom: 'child',
      dispatchedVia: 'child',
      dispatchedPrimary: true,
    });
    assert.equal(realpathCalls, 2, 'a dispatch edge resolved the path of a session it does not name');
  });

  test('the project total is equal with and without the dispatch edge', () => {
    const without = sourcesWith([]);
    const linked = sourcesWith([launch('toolu_1')]);
    const files = (sources: readonly SessionSpendSource[]) => [...new Set(sources.map((source) => source.file))].sort();
    assert.deepEqual(files(linked), files(without), 'the dispatch edge added a transcript for the project to count');
    assert.equal(projectTotal(linked), projectTotal(without), 'the dispatch edge changed the project total');
    const alone = costs(without);
    const sessions = (alone.parent.total.dollars ?? 0) + (alone.child.total.dollars ?? 0);
    assert.ok(
      Math.abs((projectTotal(linked) ?? 0) - sessions) < 1e-9,
      `the project total ${projectTotal(linked)} does not count each session once, ${sessions}`,
    );
  });
});

test('session spend sources are not built again for the same inputs in another order', () => {
  const folder = dir();
  const runs = { claude: 0, codex: 0 };
  const index = new SessionSpendSourceIndex({
    claude: (...args) => {
      runs.claude++;
      return discoverClaudeSessionSpendSources(...args);
    },
    codex: (...args) => {
      runs.codex++;
      return discoverCodexSessionSpendSources(...args);
    },
  });
  const directories = new SubagentDirectoryCache();
  const claude = [{ sessionId: 'p', file: path.join(folder, 'p.jsonl'), primary: true }];
  const children = [
    { sessionId: 'k1', file: path.join(folder, 'k1.jsonl'), parentSessionId: 'p' },
    { sessionId: 'k2', file: path.join(folder, 'k2.jsonl'), parentSessionId: 'k1' },
  ];
  const codex = [
    { sessionId: 'a', file: 'a.jsonl' },
    { sessionId: 'b', file: 'b.jsonl' },
  ];
  const threads = [
    { threadId: 't', parentThreadId: 'a', file: 't.jsonl' },
    { threadId: 'u', parentThreadId: 'b', file: 'u.jsonl' },
  ];
  const held = index.update(claude, children, codex, threads, directories);
  index.update(claude, [...children].reverse(), [...codex].reverse(), [...threads].reverse(), directories);
  assert.equal(index.sources, held, 'the same sessions in another order built the sources again');
  assert.deepEqual(runs, { claude: 1, codex: 1 }, 'an unchanged set of session files and parents ran discovery again');
  const nested = path.join(folder, 'k2', 'subagents');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'agent.jsonl'), '');
  index.update(claude, children, codex, threads, directories);
  assert.ok(
    index.sources.some((source) => source.sessionId === 'k2' && source.file === path.join(nested, 'agent.jsonl')),
    'a subagent transcript under a Claude child never became a spend source',
  );
});

test('a subagent listing that failed is read again with the same directory time', () => {
  const folder = dir();
  const parent = path.join(folder, 'parent.jsonl');
  const children = path.join(folder, 'p', 'subagents');
  fs.mkdirSync(children, { recursive: true });
  fs.writeFileSync(path.join(children, 'one.jsonl'), '');
  const settled = new Date('2026-08-01T00:00:00Z');
  fs.utimesSync(children, settled, settled);
  let denied = true;
  const directories = new SubagentDirectoryCache((directory) =>
    denied ? null : fs.readdirSync(directory).map((name) => path.join(directory, name)),
  );
  const names = () =>
    discoverClaudeSessionSpendSources([{ file: parent, sessionId: 'p' }], directories).map((source) =>
      path.basename(source.file),
    );
  assert.deepEqual(names(), ['parent.jsonl']);
  denied = false;
  assert.deepEqual(
    names(),
    ['parent.jsonl', 'one.jsonl'],
    'a subagent transcript stayed out of spend after read access returned',
  );
});

test('a subagent directory no pass listed is forgotten', () => {
  const folder = dir();
  const settled = new Date('2026-08-01T00:00:00Z');
  const [kept, dropped] = ['kept', 'dropped'].map((name) => {
    const directory = path.join(folder, name);
    fs.mkdirSync(directory);
    fs.utimesSync(directory, settled, settled);
    return directory;
  });
  let reads = 0;
  const directories = new SubagentDirectoryCache(() => {
    reads++;
    return [];
  });
  directories.files(kept);
  directories.files(dropped);
  directories.sweep();
  directories.files(kept);
  directories.sweep();
  directories.files(kept);
  directories.files(dropped);
  assert.equal(reads, 3, 'a directory that left the scope stayed held, or a listed one was forgotten');
});

test('Claude lifetime cost follows a root-child-grandchild tree', () => {
  const folder = dir();
  const root = path.join(folder, 'root.jsonl');
  const children = path.join(folder, 'root', 'subagents');
  const child = path.join(children, 'agent-child.jsonl');
  const grandchild = path.join(children, 'agent-grandchild.jsonl');
  fs.mkdirSync(children, { recursive: true });
  for (const file of [root, child, grandchild]) {
    fs.writeFileSync(file, '');
  }
  const childSessions = [
    { file: child, sessionId: 'child', parentSessionId: 'root' },
    { file: grandchild, sessionId: 'grandchild', parentSessionId: 'child' },
  ];
  const sources = [
    ...discoverClaudeSessionSpendSources([{ file: root, sessionId: 'root' }]),
    ...discoverClaudeSessionSpendSources(childSessions),
  ];
  const bucket = (model: string, dollars: number) =>
    aggregateUsageEvents([event(stamp('2026-08-31T10:00:00Z'), { model, reportedCost: dollars })]);
  const record = (file: string, model: string, dollars: number): SpendFileIndex => ({
    file,
    workspace: 'w',
    size: 1,
    mtimeMs: 1,
    offset: 1,
    trailing: '',
    buckets: bucket(model, dollars),
    lifetimeBuckets: bucket(model, dollars),
    indexedAt: 1,
    complete: true,
  });
  const files = [record(root, 'root', 1), record(child, 'child', 2), record(grandchild, 'grandchild', 4)];
  const spend = sessionSpendPartsBySession(files, sources);
  const total = (sessionId: string) => spend[sessionId].reduce((sum, part) => sum + (part.bucket.reportedCost ?? 0), 0);

  assert.equal(total('root'), 7);
  assert.equal(total('child'), 6);
  assert.equal(total('grandchild'), 4);
  assert.deepEqual(
    spend.child.map((part) => [part.bucket.model, part.role]),
    [
      ['child', 'main'],
      ['grandchild', 'delegated'],
    ],
  );
  assert.deepEqual(
    discoverClaudeSpendSources([{ file: root, sessionId: 'root' }]).sort(),
    [root, child, grandchild].sort(),
  );
});

test('session spend includes lifetime buckets from children and retains missing-source coverage', () => {
  const folder = dir();
  const parent = path.join(folder, 'parent.jsonl');
  const child = path.join(folder, 'child.jsonl');
  const old = aggregateUsageEvents([event(stamp('2026-01-01T10:00:00'))]);
  const recent = aggregateUsageEvents([event(stamp('2026-08-31T10:00:00'))]);
  const record = (file: string, lifetimeBuckets: ProjectUsageBucket[]) => ({
    file,
    workspace: 'w',
    size: 1,
    mtimeMs: 1,
    offset: 1,
    trailing: '',
    buckets: recent,
    lifetimeBuckets,
    indexedAt: 1,
    complete: true,
  });
  const sources = [
    { sessionId: 'complete', file: parent },
    { sessionId: 'complete', file: child },
    { sessionId: 'complete', file: child },
    { sessionId: 'waiting', file: 'missing' },
  ];
  const bySession = sessionSpendBySession([record(parent, old), record(child, recent)], sources);
  assert.deepEqual(bySession.complete, [...old, ...recent]);
  assert.deepEqual(bySession.waiting, []);
});

test('an unresolved child preserves the safe lifetime heading subtotal and compaction exactly once', () => {
  const at = stamp('2026-08-31T10:00:00Z');
  const buckets = (input: number, more: Partial<UsageEvent> = {}) =>
    aggregateUsageEvents([
      event(at, { model: 'claude-opus-5', provider: null, usage: { ...usage(), requests: 1, input }, ...more }),
    ]).map((bucket) => ({ ...bucket, ...(more.compactionEstimate ? { compactionEstimate: true as const } : {}) }));
  const parent = spendRecord('parent', {
    lifetimeBuckets: [...buckets(100_000), ...buckets(20_000, { compactionEstimate: true })],
  });
  const child = spendRecord('child', { lifetimeBuckets: buckets(40_000) });
  const uncertain = spendRecord('uncertain', {
    parserKind: 'codex',
    parserState: { pendingOwnership: { unresolved: true } },
    lifetimeBuckets: [...buckets(30_000), ...buckets(900_000, { incomplete: true })],
  });
  const sources = [
    { sessionId: 'parent', file: 'parent', primary: true },
    { sessionId: 'parent', file: 'child', primary: false },
    { sessionId: 'parent', file: 'uncertain', primary: false },
    { sessionId: 'parent', file: 'uncertain', primary: false },
  ];
  const coverage = new Map<string, SessionSpendCoverage>();
  const parts = sessionSpendPartsBySession([parent, child, uncertain], sources, undefined, undefined, coverage).parent;
  const projection = sessionCostProjection(parts.map(sessionCostUsageOf), coverage.get('parent'));
  const safe = sessionCostProjection(
    [...parent.lifetimeBuckets!, ...child.lifetimeBuckets!, ...buckets(30_000)].map((bucket) =>
      sessionCostUsageOf({ bucket, role: 'main' }),
    ),
  );
  assert.equal(parts.length, 4);
  assert.equal(projection.total.dollars, safe.total.dollars);
  assert.equal(projection.total.partial, true);
  assert.match(projection.stats[0].compactLabel, /\+$/);
  assert.match(projection.stats[0].detail, /Includes an estimated \$0\.10 for 1 compaction\./);
  // The estimate stays in the visible footer, not under the notes disclosure.
  assert.match(projection.stats[0].detailList?.footer?.[0] ?? '', /Includes an estimated \$0\.10 for 1 compaction\./);
  const entries = projection.stats[0].detailList!.entries;
  assert.doesNotMatch(String(entries[0].value), /\+$/);
  assert.match(String(entries[1].value), /\+$/);
  const complete = sessionSpendPartsBySession(
    [parent, child, { ...uncertain, parserState: { pendingOwnership: {} }, lifetimeBuckets: buckets(30_000) }],
    sources,
    undefined,
    undefined,
    coverage,
  ).parent;
  assert.equal(sessionCostProjection(complete.map(sessionCostUsageOf), coverage.get('parent')).total.partial, false);
  const missing = sessionSpendPartsBySession([], sources, undefined, undefined, coverage).parent;
  assert.deepEqual(sessionCostProjection(missing.map(sessionCostUsageOf), coverage.get('parent')), {
    stats: [],
    total: { dollars: null, partial: true },
  });
});

test.each(['ordinary', 'warning', 'identity', 'review'] as const)(
  'excluded lifetime buckets suppress only affected scope statistics in the %s cost detail layout',
  (layout) => {
    const at = stamp('2026-08-31T10:00:00Z');
    const buckets = (model: string, more: Partial<UsageEvent> = {}) =>
      aggregateUsageEvents([
        event(at, {
          model,
          provider: null,
          usage: { ...usage(), requests: layout === 'warning' ? 5 : 4, input: 1_000, cacheWrite5m: 900_000 },
          ...more,
        }),
      ]);
    const childModel = layout === 'review' ? 'codex-auto-review' : 'claude-opus-5';
    const records = [
      spendRecord('parent', { lifetimeBuckets: buckets('claude-opus-5') }),
      spendRecord('child', {
        lifetimeBuckets: buckets(childModel, layout === 'review' ? { agent: 'codex', provider: 'openai' } : {}),
      }),
      spendRecord('peer', {
        lifetimeBuckets: buckets('claude-sonnet-5', {
          usage: { ...usage(), requests: 5, input: 1_000, cacheWrite5m: layout === 'warning' ? 3_000_000 : 0 },
        }),
      }),
      ...(layout === 'identity'
        ? [
            spendRecord('review', {
              lifetimeBuckets: buckets('codex-auto-review', {
                agent: 'codex',
                provider: 'openai',
                usage: { ...usage(), requests: 1 },
              }),
            }),
          ]
        : []),
    ];
    const sources = records.map((record, index) => ({ sessionId: 'parent', file: record.file, primary: index === 0 }));
    const projection = (main: boolean, child: boolean) => {
      const coverage = new Map<string, SessionSpendCoverage>();
      const files = records.map((record) => {
        const incomplete = (record.file === records[0].file && main) || (record.file === records[1].file && child);
        return {
          ...record,
          lifetimeBuckets: [
            ...record.lifetimeBuckets!,
            ...(incomplete ? record.lifetimeBuckets!.map((bucket) => ({ ...bucket, incomplete: true })) : []),
          ],
        };
      });
      const parts = sessionSpendPartsBySession(files, sources, undefined, undefined, coverage).parent;
      assert.equal(parts.length, records.length, 'incomplete buckets entered the priced subtotal');
      return sessionCostProjection(parts.map(sessionCostUsageOf), coverage.get('parent')).stats[0];
    };
    const details = (chip: ReturnType<typeof projection>) => {
      const entries = chip.detailList!.entries;
      const main = entries.find((entry) => entry.label.startsWith('Main agent'))!;
      assert.ok(main, `${layout}: ${JSON.stringify(entries)}`);
      if (layout === 'ordinary') {
        const lines = entries.find((entry) => entry.label === 'Delegated work')!.lines!;
        const child = lines.find((line) => typeof line === 'object' && 'text' in line && line.text.includes('opus-5'))!;
        const peer = lines.find(
          (line) => typeof line === 'object' && 'text' in line && line.text.includes('sonnet-5'),
        )!;
        return {
          main,
          child: { value: typeof child === 'object' && 'text' in child ? child.text : '', lines: [child] },
          peer: [peer],
        };
      }
      const child = entries.find((entry) =>
        layout === 'warning'
          ? entry.label.startsWith('Subagent 1')
          : layout === 'review'
            ? entry.label === 'Codex Auto Review'
            : entry.label.startsWith('Claude'),
      )!;
      const peer = entries.find((entry) => entry.label.includes('sonnet-5'))!;
      return { main, child, peer: peer.lines! };
    };
    const cacheFacts = (lines: NonNullable<ReturnType<typeof details>['main']['lines']>) =>
      lines.filter((line) => typeof line === 'object' && 'cacheHit' in line);
    const complete = details(projection(false, false));
    assert.ok(cacheFacts(complete.main.lines!).length, `${layout}: complete main statistics absent`);
    assert.ok(cacheFacts(complete.child.lines!).length, `${layout}: complete child statistics absent`);
    assert.ok(cacheFacts(complete.peer).length, `${layout}: complete peer statistics absent`);
    for (const [mainShort, childShort] of [
      [true, false],
      [false, true],
      [true, true],
    ]) {
      const chip = projection(mainShort, childShort);
      const held = details(chip);
      for (const [name, incomplete] of [
        ['main', mainShort],
        ['child', childShort],
      ] as const) {
        const entry = held[name];
        assert.equal(String(entry.value).endsWith('+'), incomplete, `${layout}: ${name} subtotal`);
        assert.deepEqual(
          cacheFacts(entry.lines!),
          incomplete ? [] : cacheFacts(complete[name].lines!),
          `${layout}: ${name} cache statistics`,
        );
        if (incomplete) {
          assert.doesNotMatch(
            JSON.stringify(entry.lines),
            /% cached|avg input|cacheHit/,
            `${layout}: ${name} incomplete statistics`,
          );
        }
      }
      assert.deepEqual(cacheFacts(held.peer), cacheFacts(complete.peer), `${layout}: complete peer statistics changed`);
      assert.equal(
        (chip.warnings ?? []).some((warning) => warning.scope === 'main'),
        layout === 'warning' && !mainShort,
      );
      assert.equal(
        (chip.warnings ?? []).some((warning) => 'id' in warning && warning.id?.endsWith('child')),
        layout === 'warning' && !childShort,
      );
    }
  },
);

test('session spend identifies main, child-transcript, and linked delegated usage', () => {
  const at = stamp('2026-08-31T10:00:00');
  const main = aggregateUsageEvents([event(at, { model: 'main-model' })]);
  const linked = aggregateUsageEvents([
    event(at + 1, {
      model: 'linked-model',
      linkedSessionId: 'linked-session',
      linkedInvocationId: 'shell-call',
    }),
  ]);
  const child = aggregateUsageEvents([event(at + 2, { model: 'child-model' })]);
  const record = (file: string, lifetimeBuckets: ProjectUsageBucket[]) => ({
    file,
    workspace: 'w',
    size: 1,
    mtimeMs: 1,
    offset: 1,
    trailing: '',
    buckets: lifetimeBuckets,
    lifetimeBuckets,
    indexedAt: 1,
    complete: true,
  });

  const parts = sessionSpendPartsBySession(
    [record('parent', [...main, ...linked]), record('child', child)],
    [
      { sessionId: 'session', file: 'parent', primary: true },
      { sessionId: 'session', file: 'child', primary: false },
    ],
  ).session;

  assert.deepEqual(
    parts.map((part) => [part.bucket.model, part.role, part.scopeId]),
    [
      ['main-model', 'main', undefined],
      ['linked-model', 'delegated', 'invocation:shell-call'],
      ['child-model', 'delegated', `source:${normalizeSpendFile('child')}`],
    ],
  );
});

test('session turn stats come only from the complete primary transcript', () => {
  const buckets = aggregateUsageEvents([event(stamp('2026-08-31T10:00:00'))]);
  const record = (file: string, turnCount: number, more: Partial<SpendFileIndex> = {}): SpendFileIndex => ({
    file,
    workspace: 'w',
    size: 1,
    mtimeMs: 1,
    offset: 1,
    trailing: '',
    buckets,
    lifetimeBuckets: buckets,
    turnCount,
    indexedAt: 1,
    complete: true,
    ...more,
  });
  const files = [
    record('parent', 4, {
      compactionCount: 2,
      firstTurnAt: stamp('2026-08-31T09:00:00'),
      lastTurnAt: stamp('2026-08-31T10:00:00'),
    }),
    record('child', 20),
    record('unfinished', 3, { complete: false }),
  ];
  assert.deepEqual(
    sessionTurnStatsBySession(files, [
      { sessionId: 'ready', file: 'parent', primary: true },
      { sessionId: 'ready', file: 'child', primary: false },
      { sessionId: 'waiting', file: 'unfinished', primary: true },
    ]),
    {
      ready: {
        turnCount: 4,
        compactionCount: 2,
        firstTurnAt: stamp('2026-08-31T09:00:00'),
        lastTurnAt: stamp('2026-08-31T10:00:00'),
      },
    },
  );
  assert.deepEqual(
    sessionTurnStatsBySession(
      [{ ...record('legacy', 1), turnCount: undefined }],
      [{ sessionId: 'legacy', file: 'legacy', primary: true }],
    ),
    {},
  );
});

test('session rail facts select one completed primary source and follow source replacement', () => {
  const buckets = aggregateUsageEvents([event(stamp('2026-08-31T10:00:00'))]);
  const outcome = (endedAt: number) => ({ finished: true, error: false, interrupted: false, endedAt });
  const record = (file: string, startedAt: number, more: Partial<SpendFileIndex> = {}): SpendFileIndex => ({
    file,
    workspace: 'w',
    size: 1,
    mtimeMs: 1,
    offset: 1,
    trailing: '',
    buckets,
    lifetimeBuckets: buckets,
    newestTurnStartedAt: startedAt,
    outcome: outcome(startedAt + 1),
    indexedAt: 1,
    complete: true,
    ...more,
  });
  const files = {
    parent: record('parent', 10),
    child: record('child', 20),
    replacement: record('replacement', 30),
    incomplete: record('incomplete', 40, { complete: false }),
  };
  assert.deepEqual(
    sessionRailFactsBySession(files, [
      { sessionId: 'ready', file: 'parent', primary: true },
      { sessionId: 'ready', file: 'child', primary: false },
      { sessionId: 'replaced', file: 'replacement', primary: true },
      { sessionId: 'waiting', file: 'incomplete', primary: true },
    ]),
    {
      ready: { newestTurnStartedAt: 10, outcome: outcome(11) },
      replaced: { newestTurnStartedAt: 30, outcome: outcome(31) },
    },
  );
  assert.deepEqual(sessionRailFactsBySession(files, [{ sessionId: 'ready', file: 'replacement', primary: true }]), {
    ready: { newestTurnStartedAt: 30, outcome: outcome(31) },
  });
});

test('a forced render during indexing keeps the last complete session total', () => {
  const buckets = aggregateUsageEvents([event(stamp('2026-08-31T10:00:00'))]);
  const record = (complete: boolean) => ({
    file: 'source',
    workspace: 'w',
    size: 1,
    mtimeMs: 1,
    offset: 1,
    trailing: '',
    buckets,
    lifetimeBuckets: buckets,
    indexedAt: 1,
    complete,
  });
  const visible = { ...record(true), indexedAt: 1 };
  const resumable = { ...record(false), indexedAt: 2 };
  const sources = [{ sessionId: 'session', file: 'source' }];
  assert.deepEqual(
    sessionSpendBySession(projectSpendDisplayFiles(true, [resumable], [visible]), sources).session,
    buckets,
  );
  const held = sessionLifetimeDisplayFiles(true, [resumable], [visible]);
  assert.deepEqual(sessionSpendBySession(held, sources).session, buckets);
  assert.equal(held[0].indexedAt, 1, 'the partial replacement hid the last complete session facts');
  assert.equal(sessionLifetimeDisplayFiles(true, [{ ...resumable, complete: true }], [visible])[0].indexedAt, 2);
  assert.deepEqual(
    sessionSpendBySession(projectSpendDisplayFiles(false, [resumable], [visible]), sources).session,
    buckets,
  );
});

test('session spend retains unavailable cost for an unfinished first record', () => {
  const folder = dir();
  const file = path.join(folder, 'source.jsonl');
  fs.writeFileSync(file, JSON.stringify(event(stamp('2026-08-31T10:00:00'))));
  const unfinished = indexSpendFile(undefined, file, 'w', reducer, 1).record;
  const sources = [{ sessionId: 'session', file }];
  assert.equal(unfinished.complete, true);
  assert.notEqual(unfinished.trailing, '');
  assert.deepEqual(sessionSpendBySession([unfinished], sources).session, []);
  fs.appendFileSync(file, '\n');
  const finished = indexSpendFile(unfinished, file, 'w', reducer, 2).record;
  assert.equal(finished.trailing, '');
  assert.equal(sessionSpendBySession([finished], sources).session?.length, 1);
});

test('session spend matches the canonical path used by the index', () => {
  const folder = dir();
  const target = path.join(folder, 'target');
  const alias = path.join(folder, 'alias');
  fs.mkdirSync(target);
  fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const physical = path.join(target, 'source.jsonl');
  fs.writeFileSync(physical, '');
  const buckets = aggregateUsageEvents([event(stamp('2026-08-31T10:00:00'))]);
  const record = {
    file: physical,
    workspace: 'w',
    size: 1,
    mtimeMs: 1,
    offset: 1,
    trailing: '',
    buckets,
    lifetimeBuckets: buckets,
    indexedAt: 1,
    complete: true,
  };
  const found = sessionSpendBySession([record], [{ sessionId: 'session', file: path.join(alias, 'source.jsonl') }]);
  assert.deepEqual(found.session, buckets);
});

test('a persisted canonical record does not hide a retargeted live symlink', () => {
  const folder = dir();
  const firstTarget = path.join(folder, 'first');
  const secondTarget = path.join(folder, 'second');
  const alias = path.join(folder, 'alias');
  fs.mkdirSync(firstTarget);
  fs.mkdirSync(secondTarget);
  fs.symlinkSync(firstTarget, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const live = path.join(alias, 'source.jsonl');
  const firstEvent = event(stamp('2026-08-30T10:00:00'), { usage: { ...usage(), input: 3, output: 5 } });
  const secondEvent = event(stamp('2026-08-31T10:00:00'), { usage: { ...usage(), input: 17, output: 19 } });
  const firstLine = JSON.stringify(firstEvent) + '\n';
  const secondLine = JSON.stringify(secondEvent) + '\n';
  fs.writeFileSync(path.join(firstTarget, 'source.jsonl'), firstLine);
  fs.writeFileSync(path.join(secondTarget, 'source.jsonl'), secondLine);
  const first = indexSpendFile(undefined, live, 'one', reducer, 1).record;
  saveSpendLedger(folder, 'one', [first]);
  const restored = loadSpendLedger(folder, 'one').files[0];
  const source = [{ sessionId: 'session', file: live }];
  const restoredTotals = sessionSpendBySession([restored], source).session;

  fs.unlinkSync(alias);
  fs.symlinkSync(secondTarget, alias, process.platform === 'win32' ? 'junction' : 'dir');
  invalidateSpendFileNormalization(live);
  const reconciled = indexSpendFile(restored, live, 'one', reducer, 2);

  assert.equal(reconciled.rebuilt, true);
  assert.equal(reconciled.record.file, normalizeSpendFile(path.join(secondTarget, 'source.jsonl')));
  assert.equal(reconciled.record.buckets[0].localDate, '2026-08-31');
  const reconciledTotals = sessionSpendBySession([reconciled.record], source).session;
  assert.notDeepEqual(reconciledTotals, restoredTotals);
  assert.deepEqual(reconciledTotals, reconciled.record.lifetimeBuckets);
});

test('an old spend record without lifetime buckets rebuilds once', () => {
  const folder = dir();
  const file = path.join(folder, 'source.jsonl');
  fs.writeFileSync(file, JSON.stringify(event(stamp('2026-08-31T10:00:00'))) + '\n');
  const current = indexSpendFile(undefined, file, 'w', reducer, 1).record;
  const legacy = { ...current, lifetimeBuckets: undefined };
  const rebuilt = indexSpendFile(legacy, file, 'w', reducer, 2);
  assert.equal(rebuilt.rebuilt, true);
  assert.deepEqual(rebuilt.record.lifetimeBuckets, rebuilt.record.buckets);
});

test('an old spend record without a turn count rebuilds once', () => {
  const folder = dir();
  const file = path.join(folder, 'source.jsonl');
  fs.writeFileSync(file, JSON.stringify(event(stamp('2026-08-31T10:00:00'))) + '\n');
  const current = indexSpendFile(undefined, file, 'w', reducer, 1).record;
  const legacy = { ...current };
  delete legacy.turnCount;
  assert.equal(spendRecordHasLifetimeFacts(legacy), false);
  assert.equal(spendRecordHasLifetimeFacts({ ...current, turnCount: -1 }), false);
  assert.equal(spendRecordHasLifetimeFacts({ ...current, turnCount: 'four' as unknown as number }), false);
  const rebuilt = indexSpendFile(legacy, file, 'w', reducer, 2);
  assert.equal(rebuilt.rebuilt, true);
  assert.equal(rebuilt.record.turnCount, null);
  assert.equal(spendRecordHasLifetimeFacts(rebuilt.record), true);
  assert.equal(
    spendRecordHasLifetimeFacts({
      ...rebuilt.record,
      outcome: { finished: false, error: false, interrupted: false, endedAt: 1, processEndedAt: Number.NaN },
    }),
    false,
  );
  assert.equal(indexSpendFile(rebuilt.record, file, 'w', reducer, 3).rebuilt, false);
});

test('manual CLI compaction rebuilds generation 38 at unchanged EOF and preserves pending restart state', () => {
  const directory = dir();
  const file = path.join(directory, 'compact.jsonl');
  const storage = dir();
  const opening = {
    type: 'user',
    uuid: 'compact-opening',
    timestamp: '2026-10-07T09:17:51.416Z',
    message: { role: 'user', content: '/compact' },
  };
  const completion = [
    {
      type: 'system',
      subtype: 'compact_boundary',
      timestamp: '2026-10-07T09:18:03.839Z',
      compactMetadata: { trigger: 'manual', preTokens: 62077, postTokens: 4336, durationMs: 12409 },
    },
    {
      type: 'user',
      isCompactSummary: true,
      timestamp: '2026-10-07T09:18:03.827Z',
      message: { role: 'user', content: 'Retained summary' },
    },
  ];
  fs.writeFileSync(file, JSON.stringify(opening) + '\n');
  const pending = indexSpendFile(undefined, file, 'w', createClaudeUsageLineReducer, 1).record;
  saveSpendLedger(storage, 'w', [pending]);
  const loaded = loadSpendLedger(storage, 'w').files[0];
  assert.equal((loaded.parserState as ClaudeUsageReducerState).currentTurnCompact, true);
  fs.appendFileSync(file, completion.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const current = indexSpendFile(loaded, file, 'w', createClaudeUsageLineReducer, 2).record;
  assert.equal(current.turnCount, 0);
  assert.equal(current.outcome, null);
  assert.equal(current.compactionCount, 1);
  const before = fs.statSync(file);
  saveSpendLedger(storage, 'w', [
    {
      ...current,
      parserGeneration: 38,
      turnCount: 1,
      outcome: { finished: false, error: false, interrupted: false, endedAt: Date.parse(opening.timestamp) },
    },
  ]);
  const stale = loadSpendLedger(storage, 'w').files[0];
  const rebuilt = indexSpendFile(stale, file, 'w', createClaudeUsageLineReducer, 3);
  assert.equal(rebuilt.rebuilt, true);
  assert.equal(rebuilt.record.turnCount, 0);
  assert.equal(rebuilt.record.outcome, null);
  assert.deepEqual(rebuilt.record.lifetimeBuckets, current.lifetimeBuckets);
  saveSpendLedger(storage, 'w', [rebuilt.record]);
  assert.equal(
    indexSpendFile(loadSpendLedger(storage, 'w').files[0], file, 'w', createClaudeUsageLineReducer, 4).rebuilt,
    false,
  );
  assert.equal(fs.statSync(file).size, before.size);
  assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
});

test('an older parser generation rebuilds an unchanged source once', () => {
  const folder = dir();
  const file = path.join(folder, 'source.jsonl');
  fs.writeFileSync(file, JSON.stringify(event(stamp('2026-08-31T10:00:00'))) + '\n');
  const current = indexSpendFile(undefined, file, 'w', reducer, 1).record;
  const legacy = { ...current, parserGeneration: PROJECT_SPEND_PARSER_GENERATION - 1 };
  const rebuilt = indexSpendFile(legacy, file, 'w', reducer, 2);
  assert.equal(spendRecordHasLifetimeFacts(legacy), false);
  assert.equal(rebuilt.rebuilt, true);
  assert.equal(rebuilt.record.parserGeneration, PROJECT_SPEND_PARSER_GENERATION);
  assert.equal(rebuilt.stateChanged, true);
  assert.equal(indexSpendFile(rebuilt.record, file, 'w', reducer, 3).rebuilt, false);

  saveSpendLedger(folder, 'w', [rebuilt.record]);
  assert.equal(loadSpendLedger(folder, 'w').parserGeneration, PROJECT_SPEND_PARSER_GENERATION);
});

test('Codex append indexing preserves retained checkpoint outcomes and display persistence', () => {
  const folder = dir();
  const file = path.join(folder, 'source.jsonl');
  const startedAt = Date.parse('2026-10-03T03:10:08Z');
  const finishedAt = startedAt + 30_000;
  const line = (type: string, payload: Record<string, unknown>, at = startedAt) =>
    JSON.stringify({ type, timestamp: new Date(at).toISOString(), payload });
  fs.writeFileSync(
    file,
    [
      line('session_meta', {
        id: 'sess',
        source: 'vscode',
        model_provider: 'openai',
        timestamp: new Date(startedAt - 1000).toISOString(),
      }),
      line('event_msg', { type: 'task_started', turn_id: 'turn-1', started_at: startedAt / 1000 }),
      line('turn_context', { turn_id: 'turn-1', model: 'gpt-5.6-sol', effort: 'high' }),
      line('response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Complete the task' }],
        internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] },
      }),
      line('event_msg', {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 10, output_tokens: 1 } },
      }),
      '',
    ].join('\n'),
  );
  fs.utimesSync(file, startedAt / 1000, startedAt / 1000);
  const predecessor = indexSpendFile(undefined, file, 'w', createCodexUsageLineReducer, startedAt).record;
  const retained = structuredClone(predecessor);
  const unfinished = { finished: false, error: false, interrupted: false, endedAt: startedAt, startedAt };
  assert.equal(predecessor.turnCount, 1);
  assert.deepEqual(predecessor.outcome, unfinished);
  saveSpendLedger(folder, 'w', [predecessor]);
  const savedBytes = fs.readFileSync(path.join(folder, ledgerName(folder)));

  fs.appendFileSync(
    file,
    line('event_msg', { type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'Task complete' }, finishedAt) +
      '\n',
  );
  fs.utimesSync(file, finishedAt / 1000, finishedAt / 1000);
  const appended = indexSpendFile(predecessor, file, 'w', createCodexUsageLineReducer, finishedAt);
  assert.equal(appended.rebuilt, false);
  assert.equal(appended.complete, true);
  assert.deepEqual(predecessor, retained, 'append indexing must preserve the retained predecessor');
  saveSpendLedger(folder, 'w', [predecessor]);
  assert.deepEqual(fs.readFileSync(path.join(folder, ledgerName(folder))), savedBytes);
  const successor = appended.record;
  const finished = { ...unfinished, finished: true, endedAt: finishedAt };
  assert.deepEqual(successor.outcome, finished);
  assert.deepEqual(
    (successor.parserState as ReturnType<typeof emptyCodexUsageReducerState>).currentTurnOutcome,
    finished,
  );
  assert.equal(successor.lastTurnAt, finishedAt);
  saveSpendLedger(folder, 'w', [successor], [predecessor]);
  const loaded = loadSpendLedger(folder, 'w');
  assert.equal(loaded.files.length, 1);
  assert.equal(loaded.completeFiles.length, 1);
  assert.deepEqual(loaded.files[0].outcome, finished);
  assert.deepEqual(loaded.completeFiles[0].outcome, unfinished);
  assert.deepEqual(
    (loaded.files[0].parserState as ReturnType<typeof emptyCodexUsageReducerState>).currentTurnOutcome,
    finished,
  );
  assert.deepEqual(
    (loaded.completeFiles[0].parserState as ReturnType<typeof emptyCodexUsageReducerState>).currentTurnOutcome,
    unfinished,
  );
  const fresh = indexSpendFile(undefined, file, 'w', createCodexUsageLineReducer, finishedAt).record;
  assert.deepEqual(successor.parserState, fresh.parserState);
  assert.deepEqual(successor, fresh);
});

test('a saved delayed Codex opening rebuilds the missing first turn and its usage', () => {
  const folder = dir();
  const file = path.join(folder, 'source.jsonl');
  const envelope = '2026-10-03T03:10:22.496Z';
  const line = (type: string, payload: Record<string, unknown>, timestamp = envelope) =>
    JSON.stringify({ type, timestamp, payload });
  const opening = { id: 'sess', source: 'vscode', model_provider: 'openai' };
  const turns = ['original-turn', 'second-turn', 'third-turn'].flatMap((turn_id, n) => {
    const start = Date.parse('2026-10-03T03:10:08Z') + n * 60_000;
    return [
      line('event_msg', { type: 'task_started', turn_id, started_at: start / 1000 }),
      line('turn_context', { turn_id, model: 'gpt-5.6-sol', effort: 'high' }),
      line('response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `${turn_id} prompt` }],
        internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] },
      }),
      line('event_msg', {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: n + 10, output_tokens: 1 } },
      }),
      line(
        'event_msg',
        { type: 'task_complete', turn_id, last_agent_message: `${turn_id} answer` },
        new Date(start + 30_000).toISOString(),
      ),
    ];
  });
  fs.writeFileSync(
    file,
    [line('session_meta', { ...opening, timestamp: '2026-10-03T03:10:04.531Z' }), ...turns, ''].join('\n'),
  );
  const oldReducer: UsageReducerFactory = () => {
    const reader = createCodexUsageLineReducer();
    return {
      ...reader,
      pushLine(text) {
        const record = JSON.parse(text);
        if (record.type === 'session_meta') delete record.payload.timestamp;
        return reader.pushLine(JSON.stringify(record));
      },
    };
  };
  const wrong = indexSpendFile(undefined, file, 'w', oldReducer, 1).record;
  assert.equal(wrong.turnCount, 2);
  const stale = { ...wrong, parserGeneration: 28 };
  saveSpendLedger(folder, 'w', [stale]);
  const saved = loadSpendLedger(folder, 'w').files[0];
  assert.equal(saved.turnCount, 2);
  const rebuilt = indexSpendFile(saved, file, 'w', createCodexUsageLineReducer, 2);
  assert.equal(rebuilt.rebuilt, true);
  assert.equal(rebuilt.record.turnCount, 3);
  assert.deepEqual(
    Object.keys((rebuilt.record.parserState as ReturnType<typeof emptyCodexUsageReducerState>).copiedTurnIds),
    [],
  );
  assert.equal(
    (rebuilt.record.lifetimeBuckets ?? []).reduce((total, bucket) => total + bucket.usage.input, 0),
    33,
  );
  assert.equal(indexSpendFile(rebuilt.record, file, 'w', createCodexUsageLineReducer, 3).rebuilt, false);
  saveSpendLedger(folder, 'w', [rebuilt.record]);
  assert.equal(loadSpendLedger(folder, 'w').files[0].turnCount, 3);
});

test("a spend record carries a transcript reducer's compaction count and turn span", () => {
  const folder = dir();
  const file = path.join(folder, 'source.jsonl');
  const promptAt = '2026-08-31T10:00:00.000Z';
  const answerAt = '2026-08-31T10:00:01.000Z';
  const compactionAt = '2026-08-31T10:00:02.000Z';
  const prompt = JSON.stringify({
    type: 'user',
    timestamp: promptAt,
    message: { role: 'user', content: 'first' },
  });
  const answer = JSON.stringify({
    type: 'assistant',
    uuid: 'answer-1',
    timestamp: answerAt,
    message: {
      id: 'answer-1',
      model: 'claude-sonnet-5',
      content: [{ type: 'text', text: 'done' }],
      usage: { output_tokens: 1 },
    },
  });
  const compaction = JSON.stringify({
    type: 'user',
    timestamp: compactionAt,
    isCompactSummary: true,
    message: { content: 'summary' },
  });
  fs.writeFileSync(file, [prompt, answer, compaction].join('\n') + '\n');
  const indexed = indexSpendFile(undefined, file, 'w', createClaudeUsageLineReducer, 1).record;
  assert.equal(indexed.turnCount, 1);
  assert.equal(indexed.compactionCount, 1);
  assert.equal(indexed.firstTurnAt, Date.parse(promptAt));
  assert.equal(indexed.lastTurnAt, Date.parse(answerAt));
  assert.equal(spendRecordHasLifetimeFacts(indexed), true);
});

test('a session total counts a Claude compaction as an estimate beside its main requests', () => {
  const folder = dir();
  const file = path.join(folder, 'source.jsonl');
  const row = COMPACTION_SAMPLES[0];
  const lines = claudeCompactionTranscript(row);
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  const record = indexSpendFile(undefined, file, 'w', createClaudeUsageLineReducer, 1).record;
  const parts = sessionSpendPartsBySession([record], [{ sessionId: 's', file, primary: true }]).s;
  const projection = sessionCostProjection(parts.map(({ bucket, role, scopeId }) => ({ ...bucket, role, scopeId })));
  const answer = lines[1] as { timestamp: string; message: { usage: Parameters<typeof claudeUsage>[0] } };
  const main = estimateCost(claudeUsage(answer.message.usage), row.model);
  assert.ok(
    main !== null && (projection.total.dollars ?? 0) > main + 0.01,
    `the session total ${projection.total.dollars} leaves out the compaction after the $${main} answer`,
  );
  const compaction = estimateCompactionCost({
    model: row.model,
    at: Date.parse((lines[3] as { timestamp: string }).timestamp),
    contextBefore: previousContextOf(row),
    contextAfter: row.postTokens!,
    previousRequest: {
      tokens: previousContextOf(row),
      cacheRead: row.previousRead,
      cacheWrite: row.previousWrite,
      at: Date.parse(answer.timestamp),
      lifetime: '5m',
    },
    summaryChars: row.summaryChars,
  });
  assert.ok(main !== null && compaction !== null);
  assert.ok(
    Math.abs((projection.total.dollars ?? 0) - (main + compaction)) < 1e-9,
    `${projection.total.dollars} should be ${main} for the answer plus ${compaction} for the compaction`,
  );
  assert.match(projection.stats[0]?.detail ?? '', /compaction/i, 'the total says it holds a compaction estimate');
});

const COMPACTION_ROW = COMPACTION_SAMPLES[0];
const COMPACTION_OUTPUT = Math.round(COMPACTION_ROW.summaryChars / CLAUDE_COMPACTION_SUMMARY_CHARS_PER_TOKEN);

// Indexes a parent transcript and optional child, then projects their session cost.
// An unterminated child has no final newline, and the export record limit lets the index accept its last record.
function indexCompactionSession(lines: readonly object[], child?: readonly object[], unterminated = false) {
  const folder = dir();
  const file = path.join(folder, 'source.jsonl');
  const write = (target: string, items: readonly object[], end = '\n') =>
    fs.writeFileSync(target, items.map((line) => JSON.stringify(line)).join('\n') + end);
  // Use an unlimited time budget so indexing completes in one pass, including the 256 KiB filler.

  const whole = { maxMilliseconds: Number.POSITIVE_INFINITY };
  write(file, lines);
  const record = indexSpendFile(undefined, file, 'w', createClaudeUsageLineReducer, 1, whole).record;
  const records = [record];
  const sources: SessionSpendSource[] = [{ sessionId: 's', file, primary: true }];
  if (child) {
    const childFile = path.join(folder, 'child.jsonl');
    write(childFile, child, unterminated ? '' : '\n');
    const makeChildReducer = (state: Parameters<typeof createClaudeUsageLineReducer>[0]) =>
      createClaudeUsageLineReducer(state, { childTranscript: true });
    const childBudget = unterminated ? { ...whole, exportRecordBytes: 1 << 20 } : whole;
    records.push(indexSpendFile(undefined, childFile, 'w', makeChildReducer, 1, childBudget).record);
    sources.push({ sessionId: 's', file: childFile, primary: false });
  }
  const parts = sessionSpendPartsBySession(records, sources).s;
  const projection = sessionCostProjection(parts.map(({ bucket, role, scopeId }) => ({ ...bucket, role, scopeId })));
  const estimates = parts.filter(({ bucket }) => bucket.compactionEstimate);
  return { file, childFile: path.join(folder, 'child.jsonl'), record, records, sources, parts, projection, estimates };
}

test('per-pass pricing replaces growing child bands after a ledger reload without losing zero-request slices', () => {
  const folder = dir();
  const file = path.join(folder, 'child.jsonl');
  const storage = path.join(folder, 'ledger');
  const makeChildReducer = (state: Parameters<typeof createClaudeUsageLineReducer>[0]) =>
    createClaudeUsageLineReducer(state, { childTranscript: true });
  const budget = { maxBytes: 1 << 20, maxMilliseconds: Number.POSITIVE_INFINITY };
  const write = (records: object[]) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  fs.writeFileSync(
    file,
    write(advisorResponseRecords({ sidechain: true, iterations: MIXED_PASS_ITERATIONS.slice(0, 1), blocks: 1 })),
  );
  const first = indexSpendFile(undefined, file, 'w', makeChildReducer, 1, budget).record;
  saveSpendLedger(storage, 'w', [first]);
  const restored = loadSpendLedger(storage, 'w').files[0];
  // The grown response is written twice, so the resumed read also proves that a replayed line adds nothing.
  for (let replay = 0; replay < 2; replay++)
    fs.appendFileSync(file, write(advisorResponseRecords({ sidechain: true, iterations: MIXED_PASS_ITERATIONS })));
  const resumed = indexSpendFile(restored, file, 'w', makeChildReducer, 2, budget).record;
  const full = indexSpendFile(undefined, file, 'w', makeChildReducer, 2, budget).record;
  assert.deepEqual(resumed.buckets, full.buckets);
  assert.equal(
    resumed.buckets.reduce((sum, bucket) => sum + bucket.requests, 0),
    1,
  );
  assert.equal(resumed.buckets.find((bucket) => bucket.contextBand === 'short')?.requests, 0);
  const dollars = resumed.buckets.reduce((sum, bucket) => sum + publicProjectSpendPrice(bucket)!.dollars, 0);
  assert.ok(Math.abs(dollars - 0.0600315) < 1e-12);
});

test('Project cost counts a recorded response cost once across two pass bands', () => {
  const { record } = indexCompactionSession(
    advisorResponseRecords({ iterations: MIXED_PASS_ITERATIONS, reportedCost: 0.123 }),
  );
  assert.equal(record.buckets[0].reportedCost, 0.123);
  assert.equal(publicProjectSpendPrice(record.buckets[0])?.dollars, 0.123);
  assert.equal(
    record.buckets.reduce((sum, bucket) => sum + (bucket.reportedCost ?? 0), 0),
    0.123,
  );
  assert.equal(
    record.buckets.reduce((sum, bucket) => sum + (publicProjectSpendPrice(bucket)?.dollars ?? 0), 0),
    0.123,
  );
  assert.equal(record.buckets.length, 1);
});

test('Project cost keeps same-model advisor and executor buckets separate on later responses', () => {
  const iterations = [
    advisorIteration({ input_tokens: 1000 }),
    advisorIteration({ type: 'advisor_message', model: 'claude-haiku-5-5', input_tokens: 2000 }),
  ];
  const { record } = indexCompactionSession([
    ...advisorResponseRecords({ id: 'first', iterations }),
    ...advisorResponseRecords({ id: 'second', at: 30, iterations }),
  ]);
  const advisor = event(stamp('2026-10-11T09:08:09Z'), { usageOrigin: 'claude-advisor' });
  const executor = event(advisor.timestamp);
  const once = aggregateUsageEvents([advisor, executor]);
  assert.deepEqual(once.map((b) => b.usageOrigin ?? null).sort(), ['claude-advisor', null]);
  assert.equal(aggregateUsageEvents([], once).length, 2);
  assert.equal(record.buckets.length, 2);
  assert.deepEqual(
    record.buckets.map((bucket) => [bucket.usageOrigin ?? null, bucket.requests, bucket.usage.input]),
    [
      ['claude-advisor', 2, 4000],
      [null, 2, 2000],
    ],
  );
});

test('generation 60 mixed-tier lifetime rebuilds once and resumes bounded slices through warm ledger reuse', () => {
  for (const [seconds, returns] of [
    [600, 0],
    [3601, 1],
  ] as const) {
    const prompt = {
      ...advisorProbeRecords()[0],
      uuid: 'later-prompt',
      timestamp: new Date(Date.parse('2026-10-11T09:08:09Z') + seconds * 1000).toISOString(),
      message: { role: 'user', content: 'Review the next item.' },
    };
    const fixture = indexCompactionSession([
      advisorProbeRecords()[0],
      ...advisorResponseRecords({ id: 'prefix', iterations: PER_PASS_ITERATIONS }),
      prompt,
      ...advisorResponseRecords({ id: 'return', at: seconds, iterations: [advisorIteration({ input_tokens: 66035 })] }),
    ]);
    const storage = dir();
    saveSpendLedger(storage, 'w', [{ ...fixture.record, parserGeneration: 60 }]);
    let record = loadSpendLedger(storage, 'w').files[0];
    const options = { maxBytes: 2048, maxMilliseconds: Number.POSITIVE_INFINITY };
    let rebuilds = 0;
    let slices = 0;
    do {
      assert.ok(slices++ < 32, 'bounded ledger slices stopped advancing');
      const before = record.scanOffset ?? record.offset;
      const result = indexSpendFile(record, fixture.file, 'w', createClaudeUsageLineReducer, 2, options);
      rebuilds += Number(result.rebuilt);
      if (!result.rebuilt) assert.ok((result.record.scanOffset ?? result.record.offset) > before);
      record = result.record;
      saveSpendLedger(storage, 'w', [record]);
      record = loadSpendLedger(storage, 'w').files[0];
    } while (!record.complete);
    assert.equal(rebuilds, 1);
    assert.equal(record.cacheExpiry?.facts.returns.length, returns);
    assert.equal(record.cacheExpiry?.facts.unavailable, 0);
    assert.equal((record.parserState as ClaudeUsageReducerState).lastRequest?.lifetime, '1h');
    for (let refresh = 0; refresh < 3; refresh++) {
      const result = indexSpendFile(record, fixture.file, 'w', createClaudeUsageLineReducer, 3 + refresh, options);
      assert.equal(result.rebuilt, false);
      assert.equal(result.changed, false);
      assert.strictEqual(result.record, record);
    }
  }
});

test('a Claude explicit unknown lifetime never acquires a documented model lifetime in saved expiry facts', () => {
  const file = path.join(dir(), 'unknown-lifetime.jsonl');
  const first = event(stamp('2026-10-11T09:00:00Z'), {
    model: 'gpt-6.1-sol',
    provider: 'openai',
    visibleTurnId: 'first',
    cacheLifetime: null,
    usage: { ...usage(), cacheWrite5m: 1000 },
  });
  const second = event(first.timestamp + 31 * 60000, {
    model: first.model,
    provider: first.provider,
    visibleTurnId: 'second',
    cacheLifetime: null,
  });
  fs.writeFileSync(file, [first, second].map((item) => JSON.stringify(item)).join('\n') + '\n');
  const makeReducer: typeof reducer = (state) => ({ ...reducer(state), recentCompactions: () => [] });
  const record = indexSpendFile(undefined, file, 'w', makeReducer, 1).record;
  const storage = dir();
  saveSpendLedger(storage, 'w', [record]);
  const saved = loadSpendLedger(storage, 'w').files[0];
  assert.equal(saved.cacheExpiry?.facts.unavailable, 1);
  assert.equal(saved.cacheExpiry?.facts.returns.length, 0);
  assert.equal(saved.cacheExpiry?.carry?.lifetime, null);
});

test('per-pass pricing retains first-pass expiry cost through a spend-ledger reload', () => {
  const prompt = (at: number) => ({
    ...advisorProbeRecords()[0],
    uuid: `prompt-${at}`,
    timestamp: new Date(Date.parse('2026-10-11T09:08:09Z') + at * 1000).toISOString(),
  });
  const lines = [
    prompt(0),
    ...advisorResponseRecords({
      id: 'before',
      iterations: [
        advisorIteration({ cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 0 } }),
      ],
    }),
    prompt(599),
    ...advisorResponseRecords({
      id: 'after',
      at: 600,
      iterations: [
        advisorIteration({ cache_creation: { ephemeral_5m_input_tokens: 100000, ephemeral_1h_input_tokens: 0 } }),
        advisorIteration({ cache_read_input_tokens: 100001 }),
      ],
    }),
  ];
  const { record } = indexCompactionSession(lines);
  const storage = dir();
  saveSpendLedger(storage, 'w', [record]);
  const facts = loadSpendLedger(storage, 'w').files[0].cacheExpiry!.facts;
  assert.equal(facts.returns.length, 1);
  assert.ok(Math.abs(cacheExpiryExtraCost(facts, publicProjectSpendPrice).dollars! - 0.000115) < 1e-12);
  assert.equal(facts.returns[0].firstPassContextBand, 'short');
});

const estimatedRequests = (buckets: readonly ProjectUsageBucket[]) =>
  buckets.filter((bucket) => bucket.compactionEstimate).reduce((sum, bucket) => sum + bucket.requests, 0);

test('Project spend prices an expired return from final executor context across checkpoint restoration', () => {
  for (const childTranscript of [false, true]) {
    const prompt = { ...advisorProbeRecords()[0], isSidechain: childTranscript };
    const before = [
      prompt,
      ...advisorResponseRecords({
        id: 'two-pass',
        sidechain: childTranscript,
        iterations: [
          advisorIteration({ cache_creation: { ephemeral_5m_input_tokens: 30_000, ephemeral_1h_input_tokens: 0 } }),
          advisorIteration({ cache_creation: { ephemeral_5m_input_tokens: 40_000, ephemeral_1h_input_tokens: 0 } }),
          advisorIteration({ type: 'advisor_message', model: ADVISOR_MODEL, input_tokens: 90_000 }),
        ],
      }),
    ];
    const after = [
      {
        ...prompt,
        uuid: 'return-prompt',
        timestamp: '2026-10-11T09:14:10.214Z',
        message: { role: 'user', content: 'Continue after the cache expires.' },
      },
      ...advisorResponseRecords({
        id: 'return',
        at: 361,
        sidechain: childTranscript,
        iterations: [
          advisorIteration({ cache_creation: { ephemeral_5m_input_tokens: 70_000, ephemeral_1h_input_tokens: 0 } }),
          advisorIteration({ type: 'advisor_message', model: ADVISOR_MODEL, input_tokens: 90_000 }),
        ],
      }),
    ];
    const file = path.join(dir(), 'source.jsonl');
    const makeReducer = (state: Parameters<typeof createClaudeUsageLineReducer>[0]) =>
      createClaudeUsageLineReducer(state, { childTranscript });
    const budget = { maxMilliseconds: Number.POSITIVE_INFINITY };
    fs.writeFileSync(file, before.map((line) => JSON.stringify(line)).join('\n') + '\n');
    const first = indexSpendFile(undefined, file, 'w', makeReducer, 1, budget).record;
    const storage = dir();
    saveSpendLedger(storage, 'w', [first]);
    const [loaded] = loadSpendLedger(storage, 'w').files;
    assert.ok(loaded);
    fs.appendFileSync(file, after.map((line) => JSON.stringify(line)).join('\n') + '\n');
    const resumed = indexSpendFile(loaded, file, 'w', makeReducer, 2, budget);
    assert.equal(resumed.rebuilt, false);
    const whole = indexSpendFile(undefined, file, 'w', makeReducer, 2, budget).record;
    for (const record of [whole, resumed.record]) {
      assert.ok(record.cacheExpiry);
      const extra = cacheExpiryExtraCost(record.cacheExpiry.facts, publicProjectSpendPrice);
      assert.equal(extra.status, 'exact');
      const expected = 0.0046;
      assert.ok(Math.abs(extra.dollars! - expected) < 1e-12, `expired context cost was ${extra.dollars}`);
      assert.equal(record.cacheExpiry.facts.counts['5m'], 1);
      assert.equal(record.cacheExpiry.facts.returns[0].previousInputSide, 40_000);
      assert.equal(record.cacheExpiry.facts.returns[0].timestamp, record.cacheExpiry.carry?.timestamp);
      assert.equal(record.cacheExpiry.carry?.requestKey, 'claude:return');
    }
    assert.equal(loaded.cacheExpiry?.carry?.inputTokens, 40_000);
    assert.equal(loaded.lifetimeBuckets?.find((bucket) => !bucket.usageOrigin)?.usage.cacheWrite5m, 70_000);
    if (childTranscript) {
      const state = loaded.parserState as ClaudeUsageReducerState;
      assert.equal(state.requestEvents?.['claude:two-pass'].contextTokens, 40_000);
    }
    assert.deepEqual(resumed.record.cacheExpiry, whole.cacheExpiry);
  }
});

test('Project spend compaction figures use final executor context across checkpoint restoration', () => {
  const [prompt, , boundary, summary] = claudeCompactionTranscript(COMPACTION_ROW, { gapMs: 60_000 });
  const [before] = advisorResponseRecords({
    id: 'before-compaction',
    iterations: [
      advisorIteration({ cache_read_input_tokens: 30_000 }),
      advisorIteration({ cache_read_input_tokens: 40_000 }),
      advisorIteration({ type: 'advisor_message', model: ADVISOR_MODEL, input_tokens: 90_000 }),
    ],
    blocks: 1,
  });
  const [after] = advisorResponseRecords({
    id: 'after-compaction',
    iterations: [
      advisorIteration({ cache_read_input_tokens: 5_000 }),
      advisorIteration({ cache_read_input_tokens: 6_000 }),
      advisorIteration({ type: 'advisor_message', model: ADVISOR_MODEL, input_tokens: 90_000 }),
    ],
    blocks: 1,
  });
  const prefix = [prompt, { ...before, timestamp: '2026-09-20T10:00:01.000Z' }, boundary, summary];
  const suffix = { ...after, timestamp: '2026-09-20T10:01:02.000Z' };
  const { file, record: first } = indexCompactionSession(prefix);
  const storage = dir();
  saveSpendLedger(storage, 'w', [first]);
  const [loaded] = loadSpendLedger(storage, 'w').files;
  assert.ok(loaded);
  fs.appendFileSync(file, JSON.stringify(suffix) + '\n');
  const resumed = indexSpendFile(loaded, file, 'w', createClaudeUsageLineReducer, 2, {
    maxMilliseconds: Number.POSITIVE_INFINITY,
  });
  assert.equal(resumed.rebuilt, false);
  const whole = indexCompactionSession([...prefix, suffix]).record;
  for (const record of [whole, resumed.record]) {
    const [fact] = record.cacheExpiry!.compactions;
    assert.equal(fact.contextBefore, 40_000);
    assert.equal(fact.contextAfter, 6_000);
    assert.equal(fact.requestsAfter, 1);
    assert.equal(fact.firstRequestAfter?.usage.cacheRead, 11_000);
    assert.equal(record.cacheExpiry?.carry?.requestKey, 'claude:after-compaction');
  }
  assert.equal(loaded.cacheExpiry?.compactions[0].contextBefore, 40_000);
  assert.equal(loaded.cacheExpiry?.compactions[0].contextAfter, null);
  assert.deepEqual(resumed.record.cacheExpiry, whole.cacheExpiry);
});

test('a Claude compaction reaches the session total whichever of its summary and boundary comes first', () => {
  for (const summaryFirst of [false, true]) {
    const { projection, estimates } = indexCompactionSession(
      claudeCompactionTranscript(COMPACTION_ROW, { summaryFirst }),
    );
    const name = summaryFirst ? 'summary first' : 'boundary first';
    assert.equal(
      estimates.reduce((sum, { bucket }) => sum + bucket.requests, 0),
      1,
      name,
    );
    assert.equal(estimates[0].bucket.usage.output, COMPACTION_OUTPUT, name);
    assert.match(projection.stats[0]?.detail ?? '', /for 1 compaction\./, name);
  }
});

test('a boundary that no summary claims lends its sizes to no later compaction', () => {
  const lines = claudeCompactionTranscript(COMPACTION_ROW, { rounds: 2, summaryFirst: true });
  const answerAt = Date.parse((lines[1] as { timestamp: string }).timestamp);
  const orphan = {
    type: 'system',
    subtype: 'compact_boundary',
    uuid: 'orphan',
    timestamp: new Date(answerAt + 5_000).toISOString(),
    compactMetadata: { trigger: 'auto', preTokens: 170_000, postTokens: 99_999 },
  };
  const { estimates } = indexCompactionSession([...lines.slice(0, 2), orphan, ...lines.slice(2)]);
  assert.deepEqual(
    estimates.map(({ bucket }) => [bucket.requests, bucket.usage.output]),
    [[2, COMPACTION_OUTPUT * 2]],
    'each compaction is priced with its own summary size',
  );
});

test('a compaction card and the session total price the same compaction the same way', () => {
  const cases: Array<[string, ClaudeCompactionTranscriptOptions]> = [
    ['the request before it has no clock', { untimedAnswers: true, gapMs: 10 * 60_000 }],
    [
      'its request started inside the lifetime and finished after it',
      { gapMs: 5 * 60_000 + 30_000, durationMs: 60_000 },
    ],
  ];
  for (const [name, options] of cases) {
    const { file, projection } = indexCompactionSession(claudeCompactionTranscript(COMPACTION_ROW, options));
    const [compacted] = readSession(file, 's').compactions;
    const cost = toCompactionCard(compacted).chips.find((chip) => chip.metric === 'cost');
    assert.match(cost?.detail ?? '', /cached input reads, .*because the session was still cached\./, name);
    assert.ok(
      (projection.stats[0]?.detail ?? '').includes(`Includes an estimated ${cost?.label} for 1 compaction.`),
      `${name}: the total says ${projection.stats[0]?.detail}`,
    );
  }
});

const COLD_ROW = COMPACTION_SAMPLES.find((row) => row.name === '386c0253 cold')!;

test('a zero read after five minutes preserves a cold Claude compaction prefix across main cache lifetimes', () => {
  for (const lifetime of ['5m', '1h'] as const) {
    for (const passes of [1, 2]) {
      for (const [minutes, read] of [
        [4, 0],
        [5, 0],
        [6, 0],
        [6, 18825],
      ] as const) {
        const lines = claudeCompactionTranscript({ ...COLD_ROW, lifetime });
        const { file, record } = indexCompactionSession(lines);
        const folder = dir();
        saveSpendLedger(folder, 'w', [record]);
        const [restored] = loadSpendLedger(folder, 'w').files;
        const lastAt = Math.max(...lines.map((line) => Date.parse((line as { timestamp: string }).timestamp)));
        lines.push({
          type: 'assistant',
          uuid: 'following-response',
          timestamp: new Date(lastAt + minutes * 60_000).toISOString(),
          message: {
            id: 'following-response',
            model: COLD_ROW.model,
            content: [{ type: 'text', text: 'Complete.' }],
            usage: {
              input_tokens: 2000 + (passes === 2 ? 2 : 0),
              cache_read_input_tokens: read + (passes === 2 ? 18825 : 0),
              output_tokens: 30 + (passes === 2 ? 4 : 0),
              ...(passes === 2
                ? {
                    iterations: [
                      advisorIteration({ input_tokens: 2000, cache_read_input_tokens: read, output_tokens: 30 }),
                      advisorIteration({ input_tokens: 2, cache_read_input_tokens: 18825, output_tokens: 4 }),
                    ],
                  }
                : {}),
            },
          },
        });
        fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
        const reducer: UsageReducerFactory = (state) =>
          createClaudeUsageLineReducer(state as ClaudeUsageReducerState | undefined);
        const resumed = indexSpendFile(restored, file, 'w', reducer, 2, { maxMilliseconds: Infinity }).record;
        const whole = indexSpendFile(undefined, file, 'w', reducer, 2, { maxMilliseconds: Infinity }).record;
        assert.deepEqual(resumed.lifetimeBuckets, whole.lifetimeBuckets);
        const [compaction] = readSession(file, 's').compactions;
        const expected = read > 0 ? read : minutes < 5 ? 0 : null;
        assert.equal(
          compaction.postCompactionCacheRead,
          expected,
          `${lifetime}, ${passes} passes, ${minutes} minutes, ${read} read`,
        );
        const estimate = resumed.lifetimeBuckets!.find((bucket) => bucket.compactionEstimate)!;
        const prefix = expected ?? COLD_ROW.firstRead!;
        assert.equal(estimate.usage.cacheWrite1h + estimate.usage.cacheWrite5m, prefix);
        assert.equal(estimate.usage.input, previousContextOf(COLD_ROW) + CLAUDE_COMPACTION_INSTRUCTION_TOKENS - prefix);
        assert.equal(
          toCompactionCard(compaction).chips.find((chip) => chip.metric === 'cost')?.label,
          `$${publicProjectSpendPrice(estimate)!.dollars.toFixed(2)}`,
        );
      }
    }
  }
});

test('a cold Claude compaction reaches the session total as a write of the shared prefix and uncached input', () => {
  const { file, projection, estimates } = indexCompactionSession(claudeCompactionTranscript(COLD_ROW));
  assert.equal(estimates.length, 1);
  const { usage } = estimates[0].bucket;
  assert.deepEqual(
    [usage.input, usage.cacheRead, usage.cacheWrite5m, usage.cacheWrite1h],
    [
      previousContextOf(COLD_ROW) + CLAUDE_COMPACTION_INSTRUCTION_TOKENS - COLD_ROW.firstRead!,
      0,
      0,
      COLD_ROW.firstRead,
    ],
  );
  const cost = toCompactionCard(readSession(file, 's').compactions[0]).chips.find((chip) => chip.metric === 'cost');
  assert.match(
    cost?.detail ?? '',
    /Estimated as 10k of 1-hour cache writes and 222k of uncached input, because the cache had expired and the context was sent again without it\./,
  );
  assert.doesNotMatch(cost?.detail ?? '', /cached input reads/);
  assert.ok((projection.stats[0]?.detail ?? '').includes(`Includes an estimated ${cost?.label} for 1 compaction.`));
});

// A cold compaction transcript whose first request sits outside a 64 KB read of its tail.
function coldCompactionPastTheWindow(options: ClaudeCompactionTranscriptOptions = {}): object[] {
  const lines = claudeCompactionTranscript(COLD_ROW, options);
  const filler = {
    type: 'system',
    subtype: 'informational',
    timestamp: new Date(Date.UTC(2026, 8, 20, 9, 59, 0)).toISOString(),
    content: 'x'.repeat(256 * 1024),
    ...(options.sidechain ? { isSidechain: true } : {}),
  };
  return [...lines.slice(0, 2), filler, ...lines.slice(2)];
}

const WINDOW_BYTES = 64 * 1024;

// Asserts that one compaction card read from the tail prices what the session total prices.
function assertCardMatchesTotal(name: string, compactions: readonly Compaction[], totalDetail: string) {
  assert.equal(compactions.length, 1, name);
  const cost = toCompactionCard(compactions[0]).chips.find((chip) => chip.metric === 'cost');
  assert.match(cost?.detail ?? '', /10k of 1-hour cache writes/, name);
  assert.ok(
    totalDetail.includes(`Includes an estimated ${cost?.label} for 1 compaction.`),
    `${name}: the card says ${cost?.label} and the total says ${totalDetail}`,
  );
}

test('a compaction card on a transcript larger than its read window prices the first request the total prices', async () => {
  const { file, projection } = indexCompactionSession(coldCompactionPastTheWindow());
  const totalDetail = projection.stats[0]?.detail ?? '';
  const tailBytes = WINDOW_BYTES;
  const page = await readClaudeHistoryPageAsync(file, 's', null, { chunkBytes: WINDOW_BYTES, targetTurns: 1 });
  assert.ok(page.page && page.page.ownedRange.start > 0, 'the page does not reach the first request');
  const cards = [
    ['the tail read', readSession(file, 's', { tailBytes }).compactions],
    ['the incremental read', readClaudeSessionIncremental(file, 's', undefined, { tailBytes }).read?.compactions ?? []],
    [
      'the async incremental read',
      (await readClaudeSessionIncrementalAsync(file, 's', undefined, { tailBytes })).read?.compactions ?? [],
    ],
    ['the history page', page.page?.compactions ?? []],
    [
      'the sync history page',
      readClaudeHistoryPage(file, 's', null, { chunkBytes: WINDOW_BYTES, targetTurns: 1 }).page?.compactions ?? [],
    ],
  ] as const;
  for (const [name, compactions] of cards) {
    assertCardMatchesTotal(name, compactions, totalDetail);
  }
});

test('a child transcript compaction card past its read window prices the first request its share prices', () => {
  const parent = claudeCompactionTranscript(COMPACTION_ROW).slice(0, 2);
  const { childFile, projection } = indexCompactionSession(parent, coldCompactionPastTheWindow({ sidechain: true }));
  const compactions = readSession(childFile, 's', { tailBytes: WINDOW_BYTES, childTranscript: true }).compactions;
  assert.ok(compactions[0]?.previousRequest, 'the child compaction has a request before it');
  assertCardMatchesTotal('the child read', compactions, projection.stats[0]?.detail ?? '');
});

test('a transcript is read from its head once until the file is replaced', () => {
  const { file } = indexCompactionSession(coldCompactionPastTheWindow());
  const tailBytes = WINDOW_BYTES;
  const firstRead = (read: SessionRead | null) => read?.compactions[0]?.firstRequestCachedTokens;
  const first = readClaudeSessionIncremental(file, 's', undefined, { tailBytes });
  assert.equal(firstRead(first.read), COLD_ROW.firstRead);
  // The same file with a different first request, the same size and the same identity.
  const text = fs.readFileSync(file, 'utf8');
  const changed = text.replace(
    `"cache_read_input_tokens":${COLD_ROW.firstRead}`,
    `"cache_read_input_tokens":${COLD_ROW.firstRead! + 1}`,
  );
  assert.notEqual(changed, text);
  assert.equal(changed.length, text.length);
  const fd = fs.openSync(file, 'r+');
  try {
    fs.writeSync(fd, changed, 0, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  const refreshed = readClaudeSessionIncremental(file, 's', first.checkpoint ?? undefined, { tailBytes });
  assert.equal(firstRead(refreshed.read), COLD_ROW.firstRead, 'a refresh reads the head again');
  // A new file in its place has a new identity.
  const replacement = `${file}.next`;
  fs.writeFileSync(replacement, changed);
  fs.renameSync(replacement, file);
  const replaced = readClaudeSessionIncremental(file, 's', refreshed.checkpoint ?? undefined, { tailBytes });
  assert.equal(firstRead(replaced.read), COLD_ROW.firstRead! + 1, 'a replaced file is read from its head again');
});

test('every Claude compaction counts in the lifetime total past the retained compaction window', () => {
  const rounds = RETAINED_COMPACTIONS + 2;
  const { record, projection } = indexCompactionSession(claudeCompactionTranscript(COMPACTION_ROW, { rounds }));
  assert.equal(record.compactionCount, rounds);
  assert.equal(estimatedRequests(record.lifetimeBuckets ?? []), rounds);
  assert.ok((projection.stats[0]?.detail ?? '').includes(`for ${rounds} compactions.`));
});

test('project cost windows leave a Claude compaction estimate out', () => {
  const { record } = indexCompactionSession(claudeCompactionTranscript(COMPACTION_ROW));
  assert.equal(estimatedRequests(record.lifetimeBuckets ?? []), 1);
  assert.equal(estimatedRequests(record.buckets), 0);
  assert.equal(
    record.buckets.reduce((sum, bucket) => sum + bucket.requests, 0),
    1,
    'the recorded answer stays',
  );
});

test('a child transcript compaction estimate counts as delegated work', () => {
  const parent = claudeCompactionTranscript(COMPACTION_ROW).slice(0, 2);
  const child = claudeCompactionTranscript(COMPACTION_ROW, { sidechain: true });
  const { estimates } = indexCompactionSession(parent, child);
  assert.deepEqual(
    estimates.map(({ role, bucket }) => [role, bucket.requests]),
    [['delegated', 1]],
  );
});

// A subagent's row figure and cost detail beside its part of the session total, for one child
// transcript under a parent that answered once.
function subagentCompactionParity(child: readonly object[]) {
  const parent = claudeCompactionTranscript(COMPACTION_ROW).slice(0, 2);
  const { parts, childFile } = indexCompactionSession(parent, child);
  const delegated = parts.filter(({ role }) => role === 'delegated');
  const share = (estimated: boolean) =>
    sessionCostProjection(
      delegated
        .filter(({ bucket }) => Boolean(bucket.compactionEstimate) === estimated)
        .map(({ bucket, role, scopeId }) => ({ ...bucket, role, scopeId })),
    ).total.dollars ?? 0;
  const spend = readClaudeAgentSpend(childFile);
  const own = turn({ usage: emptyUsage(), usageParts: [], agents: [] });
  const withChild = { ...own, agents: [subagent({ model: COMPACTION_ROW.model, spend: spend.models })] };
  return {
    requests: share(false),
    estimate: share(true),
    estimated: estimatedRequests(delegated.map(({ bucket }) => bucket)),
    figure: (turnCost(withChild).dollars ?? 0) - (turnCost(own).dollars ?? 0),
    detail: costDetail(withChild),
  };
}

// One recorded Claude request outside the compaction fixture's model.
const haikuAnswer = (id: string, at: number, sidechain: boolean) => ({
  type: 'assistant',
  uuid: id,
  timestamp: new Date(at).toISOString(),
  ...(sidechain ? { isSidechain: true } : {}),
  message: {
    id,
    model: 'claude-haiku-4-5',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 3_000, output_tokens: 100 },
  },
});

test('a subagent that compacted costs the same on its row as in the delegated share', () => {
  const cases: Array<[string, readonly object[], number]> = [
    ['one warm compaction', claudeCompactionTranscript(COMPACTION_ROW, { sidechain: true }), 1],
    ['two compactions', claudeCompactionTranscript(COMPACTION_ROW, { sidechain: true, rounds: 2 }), 2],
    [
      'the summary before its boundary',
      claudeCompactionTranscript(COMPACTION_ROW, { sidechain: true, summaryFirst: true }),
      1,
    ],
    ['a cold compaction', claudeCompactionTranscript(COMPACTION_ROW, { sidechain: true, gapMs: 6 * 60_000 }), 1],
  ];
  for (const [name, child, count] of cases) {
    const { requests, estimate, estimated, figure, detail } = subagentCompactionParity(child);
    assert.equal(estimated, count, `${name}: the delegated share holds each compaction`);
    assert.ok(requests > 0 && estimate > 0, `${name}: the delegated share holds the answers and the estimates`);
    assert.ok(
      Math.abs(figure - (requests + estimate)) < 1e-9,
      `${name}: subagent ${figure} against delegated ${requests + estimate}`,
    );
    const words = ` for ${count} compaction${count === 1 ? '' : 's'}.`;
    assert.ok(
      detail.some((line) => /Includes an estimated \$[\d.]+ for/.test(line) && line.includes(words)),
      `${name}: the subagent figure says ${detail.join(' | ')}`,
    );
  }
});

test('a subagent compaction with no request before it costs nothing on its row or in the total', () => {
  const [prompt, answer, boundary, summary] = claudeCompactionTranscript(COMPACTION_ROW, { sidechain: true });
  const { requests, estimate, estimated, figure, detail } = subagentCompactionParity([
    prompt,
    boundary,
    summary,
    answer,
  ]);
  assert.equal(estimated, 0, 'the delegated share holds no estimate');
  assert.equal(estimate, 0);
  assert.ok(requests > 0 && Math.abs(figure - requests) < 1e-9, `subagent ${figure} against delegated ${requests}`);
  assert.ok(
    !detail.some((line) => /Includes an estimated/.test(line)),
    `the subagent figure says ${detail.join(' | ')}`,
  );
});

test('a subagent compaction note names the model that ran it', () => {
  const child = claudeCompactionTranscript(COMPACTION_ROW, { sidechain: true });
  const last = Date.parse((child.at(-1) as { timestamp: string }).timestamp);
  const { detail } = subagentCompactionParity([...child, haikuAnswer('haiku-1', last + 1_000, true)]);
  const note = detail.find((line) => /Includes an estimated \$[\d.]+ for 1 compaction\./.test(line));
  assert.ok(note, `the subagent figure says ${detail.join(' | ')}`);
  assert.match(note, /^[^:]*· [^:]*opus[^:]*: Includes/i, `the note names ${note}`);
  assert.ok(
    detail.some((line) => /· .*haiku/i.test(line)),
    `the Haiku request has its own block: ${detail.join(' | ')}`,
  );
});

test('a dispatched session sizes a compaction from its main request, not an inline subagent request', () => {
  const lines = claudeCompactionTranscript(COMPACTION_ROW);
  const answerAt = Date.parse((lines[1] as { timestamp: string }).timestamp);
  const withSidechain = [...lines.slice(0, 2), haikuAnswer('side-1', answerAt + 5_000, true), ...lines.slice(2)];
  const { file, estimates } = indexCompactionSession(withSidechain);
  assert.equal(estimates.length, 1);
  const own = estimates[0].bucket;
  const dispatched = readClaudeAgentSpend(file, [], false)
    .models.flatMap((model) => model.usageParts ?? [])
    .filter((part) => part.compactionEstimate);
  assert.deepEqual(
    dispatched.map((part) => [
      part.model,
      part.usage.input,
      part.usage.cacheRead,
      part.usage.cacheWrite5m,
      part.usage.output,
    ]),
    [[own.model, own.usage.input, own.usage.cacheRead, own.usage.cacheWrite5m, own.usage.output]],
  );
});

test('a spend record saved between the halves of a compaction keeps its estimate', () => {
  for (const summaryFirst of [false, true]) {
    const name = summaryFirst ? 'summary first' : 'boundary first';
    const lines = claudeCompactionTranscript(COMPACTION_ROW, { summaryFirst });
    const folder = dir();
    const file = path.join(folder, 'source.jsonl');
    fs.writeFileSync(
      file,
      lines
        .slice(0, 3)
        .map((line) => JSON.stringify(line))
        .join('\n') + '\n',
    );
    const first = indexSpendFile(undefined, file, 'w', createClaudeUsageLineReducer, 1).record;
    const storage = dir();
    saveSpendLedger(storage, 'w', [first]);
    const [loaded] = loadSpendLedger(storage, 'w').files;
    assert.ok(loaded, `${name}: the saved record reads back`);
    const state = loaded.parserState as ClaudeUsageReducerState;
    assert.ok(summaryFirst ? state.unsizedCompaction : state.pendingCompactionSize, `${name}: the first half survives`);
    assert.equal(
      state.firstRequestCachedTokens,
      COMPACTION_ROW.previousRead + COMPACTION_ROW.previousWrite,
      `${name}: the first request survives`,
    );
    assert.deepEqual(
      [state.lastRequest?.cacheRead, state.lastRequest?.cacheWrite],
      [COMPACTION_ROW.previousRead, COMPACTION_ROW.previousWrite],
      `${name}: the cache split of the request before it survives`,
    );
    if (summaryFirst) {
      assert.equal(state.unsizedCompaction?.summaryChars, COMPACTION_ROW.summaryChars, name);
    }
    fs.appendFileSync(file, JSON.stringify(lines[3]) + '\n');
    const resumed = indexSpendFile(loaded, file, 'w', createClaudeUsageLineReducer, 2).record;
    assert.equal(estimatedRequests(resumed.lifetimeBuckets ?? []), 1, name);
    const whole = indexCompactionSession(lines).record;
    const estimate = (record: typeof whole) =>
      (record.lifetimeBuckets ?? []).find((bucket) => bucket.compactionEstimate);
    assert.deepEqual(
      estimate(resumed),
      estimate(whole),
      `${name}: the resumed estimate matches a read of the whole file`,
    );
  }
});

test('a session with no compaction reports a zero count, not a missing one', () => {
  const folder = dir();
  const file = path.join(folder, 'source.jsonl');
  const prompt = JSON.stringify({
    type: 'user',
    timestamp: '2026-08-31T10:00:00.000Z',
    message: { role: 'user', content: 'first' },
  });
  fs.writeFileSync(file, `${prompt}\n`);
  const indexed = indexSpendFile(undefined, file, 'w', createClaudeUsageLineReducer, 1).record;
  assert.equal(indexed.compactionCount, 0);
  assert.notEqual(indexed.compactionCount, null);
  assert.notEqual(indexed.compactionCount, undefined);
  assert.equal(indexed.newestTurnStartedAt, stamp('2026-08-31T10:00:00.000Z'));
  assert.deepEqual(indexed.outcome, {
    finished: false,
    error: false,
    interrupted: false,
    startedAt: stamp('2026-08-31T10:00:00.000Z'),
    endedAt: stamp('2026-08-31T10:00:00.000Z'),
  });
});

test('indexing notices a change when only the compaction count or turn span moves', () => {
  const folder = dir();
  const file = path.join(folder, 'source.jsonl');
  fs.writeFileSync(file, 'first\n');
  let compactions = 0;
  const spanningReducer: UsageReducerFactory<ClaudeUsageReducerState> = () => ({
    parserKind: 'claude',
    pushLine: () => [],
    snapshot: () => ({
      seenRequestKeys: [],
      closedTurns: 1,
      openTurn: false,
      openTurnAnswered: false,
      compactionCount: 0,
      recentCompactions: [],
      visibleTurns: 0,
      firstTurnAt: null,
      currentTurnStartedAt: null,
      currentTurnEndedAt: null,
      currentTurnOutcome: null,
    }),
    turnCount: () => 1,
    compactionCount: () => compactions,
    firstTurnAt: () => stamp('2026-08-31T09:00:00'),
    lastTurnAt: () => stamp('2026-08-31T09:00:00'),
  });
  const first = indexSpendFile(undefined, file, 'w', spanningReducer, 1);
  assert.equal(first.record.compactionCount, 0);
  fs.appendFileSync(file, 'second\n');
  compactions = 1;
  const second = indexSpendFile(first.record, file, 'w', spanningReducer, 2);
  assert.equal(second.record.compactionCount, 1);
  assert.equal(second.totalsChanged, true, 'a moved compaction count alone must mark the record changed');
});

test('a source rebuilds when it is offered to a different reducer kind', () => {
  const folder = dir();
  const file = path.join(folder, 'source.jsonl');
  fs.writeFileSync(file, '');
  const claude = indexSpendFile(undefined, file, 'w', reducer, 1).record;
  const codex = indexSpendFile(claude, file, 'w', createCodexUsageLineReducer, 2);
  assert.equal(claude.parserKind, 'claude');
  assert.equal(codex.rebuilt, true);
  assert.equal(codex.record.parserKind, 'codex');
});

test('indexing does not change a known cost into a partial amount', () => {
  const buckets: ProjectUsageBucket[] = aggregateUsageEvents([event(stamp('2026-08-31T10:00:00'))]);
  const view = prepareProjectSpendView(
    [
      {
        file: 'a',
        workspace: 'w',
        size: 1,
        mtimeMs: 1,
        offset: 0,
        trailing: '',
        buckets,
        indexedAt: stamp('2026-08-31T11:00:00'),
      },
    ],
    () => ({
      dollars: 0.004,
      source: 'Configured rate',
      effectiveDate: '2026-08-01',
      estimated: true,
      provenance: 'configured',
    }),
    { now: stamp('2026-08-31T12:00:00'), indexing: true },
  );
  assert.equal(view.windows[0].display, '<$0.01');
  assert.equal(view.windows[0].status, 'exact');
  assert.equal(view.indexing, true);
  assert.equal(view.earliestRecord, '2026-08-31');
  assert.equal(view.rateSources[0].source, 'Configured rate');
  assert.equal(view.rateSources[0].provenance, 'configured');
  assert.equal(formatProjectCost(0), '$0.00');
  assert.equal(formatProjectCost(4.82), '$4.82');
  assert.equal(formatProjectCost(1234), '$1,234');
});

test('a Claude Sonnet 5.5 bucket is priced from its stored usage, cache writes included', () => {
  const [bucket] = aggregateUsageEvents([
    event(stamp('2026-08-31T10:00:00'), {
      agent: 'claude',
      provider: null,
      model: 'claude-sonnet-5-5',
      billingClass: 'unknown',
      usage: {
        ...usage(),
        input: 1_000_000,
        cacheRead: 1_000_000,
        cacheWrite5m: 1_000_000,
        cacheWrite1h: 1_000_000,
        output: 1_000_000,
      },
    }),
  ]);
  assert.equal(bucket.reportedCost, null);
  assert.equal(publicProjectSpendPrice(bucket)?.dollars, 2 + 0.1 + 2.5 + 4 + 10);
});

test('Claude uses its public price without a billing route and accepts a configured override', () => {
  const [bucket] = aggregateUsageEvents([
    event(stamp('2026-08-31T10:00:00'), {
      agent: 'claude',
      provider: null,
      model: 'claude-sonnet-5',
      billingClass: 'unknown',
      usage: { ...usage(), input: 1_000_000, output: 0 },
    }),
  ]);
  assert.equal(publicProjectSpendPrice(bucket)?.dollars, 2);
  const view = prepareProjectSpendView(
    [{ file: 'a', workspace: 'w', size: 1, mtimeMs: 1, offset: 1, trailing: '', buckets: [bucket], indexedAt: 1 }],
    publicProjectSpendPrice,
    { now: stamp('2026-08-31T12:00:00') },
  );
  assert.equal(view.categories[0].windows[0].display, '$2.00');
  const configured = publicProjectSpendPrice(bucket, [
    {
      model: 'claude-sonnet-5',
      input: 7,
      output: 9,
      source: 'Workspace agreement',
      effectiveDate: '2026-08-01',
    },
  ]);
  assert.deepEqual(configured, {
    dollars: 7,
    source: 'Workspace agreement',
    effectiveDate: '2026-08-01',
    estimated: true,
    provenance: 'configured',
  });
});

test('Project cost prices retained bands at a synthetic model threshold', () => {
  const definition: ModelDefinition = {
    pattern: /^synthetic-model$/,
    cachePolicy: { kind: 'unknown', sources: ['https://example.com/synthetic-model'] },
    rate: { input: 2, output: 10 },
    providers: ['openai'],
    window: 1_000_000,
    longContext: { threshold: 500_000, inputMultiplier: 2, outputMultiplier: 1.5 },
  };
  const definitions = [definition, ...MODEL_DEFINITIONS];
  const lookup = vi.spyOn(MODEL_DEFINITIONS, 'find').mockImplementation((predicate) => definitions.find(predicate));
  try {
    const buckets = aggregateUsageEvents(
      [300_000, 300_000, 600_000].map((input, index) =>
        event(stamp(`2026-10-01T1${index}:00:00`), {
          agent: 'codex',
          provider: 'openai',
          model: 'synthetic-model',
          usage: { ...usage(), input, output: 0 },
        }),
      ),
    );
    assert.equal(buckets.length, 2);
    assert.equal(buckets.find((bucket) => bucket.contextBand === 'short')?.requests, 2);
    assert.equal(publicProjectSpendPrice(buckets.find((bucket) => bucket.contextBand === 'short')!)?.dollars, 1.2);
    assert.equal(publicProjectSpendPrice(buckets.find((bucket) => bucket.contextBand === 'long')!)?.dollars, 2.4);
  } finally {
    lookup.mockRestore();
  }
});

test('configured Claude Bedrock rates match recorded regional evidence', () => {
  const [bucket] = aggregateUsageEvents([
    event(stamp('2026-10-01T10:00:00'), {
      provider: null,
      model: 'claude-opus-5-5',
      inferenceClass: 'bedrock-regional',
      usage: { ...usage(), input: 1_000_000, output: 0 },
    }),
  ]);
  const configured = {
    model: 'claude-opus-5-5',
    inferenceClass: 'bedrock-regional' as const,
    input: 7,
    output: 9,
    source: 'Workspace agreement',
    effectiveDate: '2026-08-01',
  };
  assert.equal(publicProjectSpendPrice(bucket, [configured])?.dollars, 7);
  assert.equal(publicProjectSpendPrice({ ...bucket, inferenceClass: null }, [configured])?.dollars, 4);
  assert.equal(publicProjectSpendPrice(bucket)?.dollars, 4.4);
});

test('Bedrock rate bands stay with each request before daily aggregation', () => {
  const buckets = aggregateUsageEvents([
    event(stamp('2026-08-31T10:00:00'), {
      agent: 'codex',
      provider: 'amazon-bedrock',
      model: 'openai.gpt-5.6-sol',
      usage: { ...usage(), input: 150_000, output: 0 },
    }),
    event(stamp('2026-08-31T11:00:00'), {
      agent: 'codex',
      provider: 'amazon-bedrock',
      model: 'openai.gpt-5.6-sol',
      usage: { ...usage(), input: 150_000, output: 0 },
    }),
  ]);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].contextBand, 'short');
  assert.equal(
    publicProjectSpendPrice(buckets[0])?.dollars,
    1.32,
    'two short requests were priced as one long request',
  );
});

test('Bedrock GPT-6.1 Sol rebuilds saved unpriced requests without treating two short requests as long', () => {
  for (const [model, expected] of [
    ['openai.gpt-6.1-sol', 1.76],
    ['us.openai.gpt-6.1-sol', 1.76],
    ['global.openai.gpt-6.1-sol', 1.6],
  ] as const) {
    const folder = dir();
    const file = path.join(folder, 'bedrock-sol.jsonl');
    const events = [100_000, 100_000, 150_000].map((input, index) =>
      event(stamp(`2026-10-01T1${index}:00:00`), {
        agent: 'codex',
        provider: 'amazon-bedrock',
        model,
        serviceTier: 'default',
        usage: {
          ...usage(),
          input,
          cacheWrite30m: 20_000,
          cacheRead: index === 2 ? 150_000 : 100_000,
          output: 10_000,
        },
      }),
    );
    fs.writeFileSync(file, events.map((request) => JSON.stringify(request)).join('\n') + '\n');
    const current = indexSpendFile(undefined, file, 'w', reducer, 1).record;
    const unbanded = {
      ...current.buckets[0],
      contextBand: null,
      requests: 3,
      input: 350_000,
      cacheWrite30m: 60_000,
      cacheRead: 350_000,
      output: 30_000,
    };
    assert.equal(publicProjectSpendPrice(unbanded), null);
    const storage = dir();
    saveSpendLedger(storage, 'w', [
      {
        ...current,
        parserGeneration: 27,
        buckets: [unbanded],
        lifetimeBuckets: [unbanded],
      },
    ]);
    const loaded = loadSpendLedger(storage, 'w').files[0];
    assert.ok(loaded);
    assert.equal(loaded.offset, loaded.size);
    const upgraded = indexSpendFile(loaded, file, 'w', reducer, 2);
    assert.equal(upgraded.rebuilt, true);
    assert.equal(upgraded.record.parserGeneration, PROJECT_SPEND_PARSER_GENERATION);
    assert.equal(upgraded.record.buckets.find((bucket) => bucket.contextBand === 'short')?.requests, 2);
    assert.equal(upgraded.record.buckets.find((bucket) => bucket.contextBand === 'long')?.requests, 1);
    saveSpendLedger(storage, 'w', [upgraded.record]);
    const restored = loadSpendLedger(storage, 'w').files[0];
    const dollars = restored.buckets.reduce((sum, bucket) => sum + publicProjectSpendPrice(bucket)!.dollars, 0);
    assert.ok(Math.abs(dollars - expected) < 1e-12);
    assert.equal(indexSpendFile(restored, file, 'w', reducer, 3).rebuilt, false);
  }
});

test('direct OpenAI rate bands stay with each request before daily aggregation', () => {
  const buckets = aggregateUsageEvents([
    event(stamp('2026-08-31T10:00:00'), {
      agent: 'codex',
      provider: 'openai',
      model: 'gpt-5.5',
      usage: { ...usage(), input: 150_000, output: 0 },
    }),
    event(stamp('2026-08-31T11:00:00'), {
      agent: 'codex',
      provider: 'openai',
      model: 'gpt-5.5',
      usage: { ...usage(), input: 150_000, output: 0 },
    }),
    event(stamp('2026-08-31T12:00:00'), {
      agent: 'codex',
      provider: 'openai',
      model: 'gpt-5.5',
      usage: { ...usage(), input: 272_001, output: 0 },
    }),
  ]);
  assert.equal(buckets.length, 2);
  const short = buckets.find((bucket) => bucket.contextBand === 'short');
  const long = buckets.find((bucket) => bucket.contextBand === 'long');
  assert.equal(short?.requests, 2);
  assert.ok(Math.abs(publicProjectSpendPrice(short!)!.dollars - 1.5) < 1e-12);
  assert.equal(long?.requests, 1);
  assert.ok(Math.abs(publicProjectSpendPrice(long!)!.dollars - 2.72001) < 1e-12);
});

test('Project cost includes Auto Review in an exact Codex total', () => {
  const buckets = aggregateUsageEvents([
    event(stamp('2026-08-31T10:00:00'), {
      agent: 'codex',
      provider: 'openai',
      billingClass: 'subscription',
      model: 'gpt-5.6-sol',
      usage: { ...usage(), input: 100_000, output: 20_000 },
    }),
    event(stamp('2026-08-31T11:00:00'), {
      agent: 'codex',
      provider: 'openai',
      billingClass: 'subscription',
      model: 'codex-auto-review',
      usage: { ...usage(), input: 100_000, cacheWrite30m: 20_000, output: 20_000 },
    }),
  ]);
  const view = prepareProjectSpendView(
    [{ file: 'a', workspace: 'w', size: 1, mtimeMs: 1, offset: 1, trailing: '', buckets, indexedAt: 1 }],
    publicProjectSpendPrice,
    { now: stamp('2026-08-31T12:00:00') },
  );
  assert.equal(view.windows[0].display, '$1.35');
  assert.equal(view.windows[0].status, 'exact');
  assert.equal(view.categories.find((category) => category.id === 'codex')?.windows[0].unpricedRequests, 0);
  assert.deepEqual(view.rateSources.map((source) => source.source).sort(), [
    'OpenAI Codex rate card',
    'OpenAI list price',
  ]);
});

test('Project cost prices OpenAI default-tier usage at the standard public rate', () => {
  const [bucket] = aggregateUsageEvents([
    event(stamp('2026-08-31T10:00:00'), {
      agent: 'codex',
      provider: 'openai',
      model: 'gpt-5.6-sol',
      serviceTier: 'default',
      usage: { ...usage(), input: 1_000_000, output: 0 },
    }),
  ]);
  assert.equal(
    publicProjectSpendPrice(bucket)?.dollars,
    8,
    "the default service tier still uses the request's long-context rate",
  );

  const view = prepareProjectSpendView(
    [{ file: 'a', workspace: 'w', size: 1, mtimeMs: 1, offset: 1, trailing: '', buckets: [bucket], indexedAt: 1 }],
    publicProjectSpendPrice,
    { now: stamp('2026-08-31T12:00:00') },
  );
  assert.equal(view.categories[0].windows[0].display, '$8.00');
  assert.equal(view.categories[0].windows[0].unpricedRequests, 0);
});

test('Project cost does not silently drop an unpublished OpenAI cache-write category', () => {
  const [bucket] = aggregateUsageEvents([
    event(stamp('2026-08-31T10:00:00'), {
      agent: 'codex',
      provider: 'openai',
      model: 'gpt-5.5',
      usage: { ...usage(), input: 0, cacheWrite30m: 1, output: 0 },
    }),
  ]);
  assert.equal(publicProjectSpendPrice(bucket), null);
});

test('a configured input rate retains a published 30-minute cache-write multiplier', () => {
  const [bucket] = aggregateUsageEvents([
    event(stamp('2026-08-31T10:00:00'), {
      agent: 'codex',
      provider: 'amazon-bedrock',
      model: 'openai.gpt-5.6-sol',
      serviceTier: 'priority',
      usage: { ...usage(), input: 1_000, cacheWrite30m: 2_000, output: 500 },
    }),
  ]);
  const priced = publicProjectSpendPrice(bucket, [
    {
      model: 'openai.gpt-5.6-sol',
      provider: 'amazon-bedrock',
      serviceTier: 'priority',
      input: 7,
      output: 9,
      source: 'Workspace agreement',
      effectiveDate: '2026-08-01',
    },
  ]);
  assert.ok(Math.abs(priced!.dollars - 0.029) < 1e-12);
  assert.deepEqual(
    { ...priced, dollars: 0.029 },
    {
      dollars: 0.029,
      source: 'Workspace agreement',
      effectiveDate: '2026-08-01',
      estimated: true,
      provenance: 'configured',
    },
  );
});

// A configured rate without a service tier prices standard Claude usage and refuses fast usage.

test('a configured rate refuses a fast Claude turn and keeps pricing a standard one', () => {
  const bucketAt = (serviceTier: string) =>
    aggregateUsageEvents([
      event(stamp('2026-08-31T10:00:00'), {
        provider: null,
        model: 'claude-opus-5-5',
        serviceTier,
        usage: { ...usage(), input: 1_000_000, output: 0 },
      }),
    ])[0];
  const configured = {
    model: 'claude-opus-5-5',
    input: 3,
    output: 15,
    source: 'Workspace agreement',
    effectiveDate: '2026-08-01',
  };
  assert.equal(publicProjectSpendPrice(bucketAt('standard'), [configured])?.dollars, 3);
  assert.equal(publicProjectSpendPrice(bucketAt('fast'), [configured]), null);
  assert.equal(publicProjectSpendPrice(bucketAt('fast'))?.dollars, 8, 'a fast turn takes the fast list rate');
  const fastConfigured = { ...configured, serviceTier: 'fast', input: 6 };
  assert.deepEqual(publicProjectSpendPrice(bucketAt('fast'), [fastConfigured]), {
    dollars: 6,
    source: 'Workspace agreement',
    effectiveDate: '2026-08-01',
    estimated: true,
    provenance: 'configured',
  });
});

test('a legacy multi-request long-context bucket stays unpriced without request bands', () => {
  const bucket: ProjectUsageBucket = {
    localDate: '2026-08-31',
    agent: 'codex',
    provider: 'openai',
    model: 'gpt-5.5',
    contextWindow: 1_050_000,
    contextBand: null,
    billingClass: 'subscription',
    inferenceClass: null,
    serviceTier: null,
    reportedCost: null,
    usage: { ...usage(), input: 300_000, output: 0 },
    requests: 2,
  };
  assert.equal(publicProjectSpendPrice(bucket), null);
  assert.deepEqual(
    publicProjectSpendPrice(bucket, [
      {
        model: 'gpt-5.5',
        provider: 'openai',
        input: 7,
        output: 9,
        source: 'Workspace agreement',
        effectiveDate: '2026-08-01',
      },
    ]),
    {
      dollars: 2.1,
      source: 'Workspace agreement',
      effectiveDate: '2026-08-01',
      estimated: true,
      provenance: 'configured',
    },
  );
  assert.deepEqual(publicProjectSpendPrice({ ...bucket, reportedCost: 0.42 }), {
    dollars: 0.42,
    source: 'Provider-reported cost',
    effectiveDate: null,
    estimated: false,
    provenance: 'reported',
  });
  assert.equal(
    publicProjectSpendPrice({
      ...bucket,
      usage: { ...bucket.usage, input: 100_000 },
    })?.dollars,
    0.5,
    'an aggregate below the threshold can only contain short requests',
  );
});

test('cold indexing continues within a byte budget without retaining earlier lines', () => {
  const folder = dir();
  const file = path.join(folder, 'large.jsonl');
  const lines = Array.from(
    { length: 800 },
    (_, index) => JSON.stringify(event(stamp('2026-08-31T10:00:00') + index)) + '\n',
  );
  fs.writeFileSync(file, lines.join(''));
  let result = indexSpendFile(undefined, file, 'w', reducer, { maxBytes: 512, maxMilliseconds: 1000 });
  assert.equal(result.complete, false);
  const targetSize = result.record.size;
  while (!result.complete) {
    result = indexSpendFile(result.record, file, 'w', reducer, { maxBytes: 512, maxMilliseconds: 1000 });
    assert.equal(result.record.size, targetSize);
  }
  assert.equal(result.record.buckets[0].requests, lines.length);
  assert.equal((result.record.parserState as ClaudeUsageReducerState).closedTurns, lines.length);
});

test('a slice whose deadline passes before its first read still reads forward', () => {
  const folder = dir();
  const file = path.join(folder, 'late.jsonl');
  const lines = Array.from(
    { length: 40 },
    (_, index) => JSON.stringify(event(stamp('2026-08-31T10:00:00') + index)) + '\n',
  );
  fs.writeFileSync(file, lines.join(''));
  // The clock sets the deadline on its first call and reads past it on every later call.
  const late = () => {
    let calls = 0;
    return { now: () => (calls++ === 0 ? 0 : 1_000), maxBytes: 512 };
  };
  let result = indexSpendFile(undefined, file, 'w', reducer, late());
  let reached = 0;
  for (let slice = 0; !result.complete && slice < lines.length * 4; slice++) {
    const position = result.record.scanOffset ?? result.record.offset;
    assert.ok(position > reached, `slice ${slice} stopped at byte ${position} without reading`);
    reached = position;
    result = indexSpendFile(result.record, file, 'w', reducer, late());
  }
  assert.equal(result.complete, true);
  assert.equal(result.record.buckets[0].requests, lines.length);
});

test('pricing overrides use the newest valid historical date in a stable order', () => {
  const [bucket] = aggregateUsageEvents([
    event(stamp('2026-06-15T10:00:00'), {
      agent: 'claude',
      provider: null,
      model: 'private-model',
      usage: { ...usage(), input: 1_000_000, output: 0 },
    }),
  ]);
  const overrides = [
    { model: 'private-model', input: 9, output: 9, source: 'Future', effectiveDate: '2026-07-01' },
    { model: 'private-model', input: 3, output: 3, source: 'January', effectiveDate: '2026-01-01' },
    { model: 'private-model', input: 5, output: 5, source: 'May', effectiveDate: '2026-05-01' },
  ];
  assert.equal(publicProjectSpendPrice(bucket, overrides)?.dollars, 5);
  assert.equal(publicProjectSpendPrice(bucket, [...overrides].reverse())?.source, 'May');
  const [older] = aggregateUsageEvents([
    event(stamp('2025-12-31T10:00:00'), { agent: 'claude', provider: null, model: 'private-model' }),
  ]);
  assert.equal(publicProjectSpendPrice(older, overrides), null, 'a future override priced history');
});

test('a window with only unpriced usage says that its cost is unknown', () => {
  const buckets = aggregateUsageEvents([event(stamp('2026-08-31T10:00:00'), { billingClass: 'unknown' })]);
  const view = prepareProjectSpendView(
    [{ file: 'a', workspace: 'w', size: 1, mtimeMs: 1, offset: 1, trailing: '', buckets, indexedAt: 1 }],
    () => null,
    { now: stamp('2026-08-31T12:00:00') },
  );
  assert.equal(view.windows[0].dollars, null);
  assert.equal(view.windows[0].display, 'Cost unknown');
  assert.equal(view.windows[0].status, 'unknown');
  assert.equal(view.categories[0].windows[0].display, 'Cost unknown');
  assert.deepEqual(
    view.categories.map((category) => category.id),
    ['claude'],
  );
});

test('bounded scan progress is not reported as an incomplete source', () => {
  const buckets = aggregateUsageEvents([event(stamp('2026-08-31T10:00:00'))]);
  const file = {
    file: 'a',
    workspace: 'w',
    size: 2,
    mtimeMs: 1,
    offset: 1,
    trailing: 'partial',
    trailingBytes: Buffer.from('partial').toString('base64'),
    buckets,
    indexedAt: 1,
    complete: false,
  };
  const view = prepareProjectSpendView(
    [file],
    () => ({
      dollars: 1,
      source: 'Public rate',
      effectiveDate: null,
      estimated: true,
      provenance: 'public',
    }),
    { now: stamp('2026-08-31T12:00:00'), indexing: true },
  );
  assert.equal(view.windows[0].display, '$1.00');
  assert.equal(view.categories[0].windows[0].display, '$1.00');
});

test('a Bedrock session keeps its profile and its regional charge through a saved spend ledger', () => {
  const folder = dir();
  const file = path.join(folder, 'bedrock.jsonl');
  fs.copyFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', 'bedrock-tool-calls.jsonl'), file);
  const claude: UsageReducerFactory<ClaudeUsageReducerState> = (state) => createClaudeUsageLineReducer(state);
  const indexed = indexSpendFile(undefined, file, 'w', claude, 1).record;
  const storage = dir();
  saveSpendLedger(storage, 'w', [indexed]);
  const loaded = loadSpendLedger(storage, 'w').files[0];
  assert.ok(loaded, 'the saved ledger was rejected on load');
  assert.equal((loaded.parserState as ClaudeUsageReducerState).modelProfile, 'us.anthropic.claude-opus-5-5[1m]');
  assert.deepEqual(
    loaded.buckets.map((bucket) => [bucket.inferenceClass, bucket.requests]),
    [['bedrock-regional', 2]],
  );
  const dollars = publicProjectSpendPrice(loaded.buckets[0])?.dollars ?? Number.NaN;
  assert.ok(Math.abs(dollars - 0.1585482 * 1.1) < 1e-9, `priced at ${dollars}`);
});

test('newline followed by NUL padding indexes an appended line the same after a rebuild', () => {
  const folder = dir();
  const file = path.join(folder, 'padded.jsonl');
  const first = JSON.stringify(event(stamp('2026-09-23T10:00:00'), { reportedCost: 2 })) + '\n';
  const padding = Buffer.alloc(19);
  fs.writeFileSync(file, Buffer.concat([Buffer.from(first), padding]));
  fs.utimesSync(file, new Date('2026-09-23T10:00:00'), new Date('2026-09-23T10:00:00'));
  const indexed = indexSpendFile(undefined, file, 'one', reducer, 1).record;
  assert.equal(indexed.offset, indexed.size);
  assert.equal(indexed.trailing, '');
  assert.equal(indexed.trailingBytes, '');
  assert.equal(indexed.buckets[0].requests, 1);
  const storage = dir();
  saveSpendLedger(storage, 'one', [indexed]);
  const loaded = loadSpendLedger(storage, 'one').files[0];
  assert.equal(loaded.offset, indexed.size);
  assert.equal(loaded.trailing, '');
  assert.deepEqual(
    prepareProjectSpendView([loaded], publicProjectSpendPrice, { now: stamp('2026-09-29T12:00:00') }).windows.map(
      (window) => window.display,
    ),
    ['$0.00', '$2.00', '$2.00'],
  );
  fs.appendFileSync(file, JSON.stringify(event(stamp('2026-09-29T10:00:00'), { reportedCost: 3 })) + '\n');
  const resumed = indexSpendFile(loaded, file, 'one', reducer, 2);
  assert.equal(resumed.rebuilt, false);
  assert.equal(resumed.record.offset, resumed.record.size);
  assert.equal(
    resumed.record.buckets.reduce((sum, bucket) => sum + bucket.requests, 0),
    2,
  );
  assert.equal(
    prepareProjectSpendView([resumed.record], publicProjectSpendPrice, { now: stamp('2026-09-29T12:00:00') }).windows[0]
      .display,
    '$3.00',
  );
  const rebuilt = indexSpendFile(undefined, file, 'one', reducer, 3).record;
  assert.deepEqual(rebuilt.buckets, resumed.record.buckets);
  assert.equal(rebuilt.offset, rebuilt.size);
  assert.equal(rebuilt.trailing, '');
});

test('an old padded checkpoint becomes complete on load without rescanning the source', () => {
  const folder = dir();
  const file = path.join(folder, 'padded.jsonl');
  const line = JSON.stringify(event(stamp('2026-09-23T10:00:00'), { reportedCost: 2 })) + '\n';
  const padding = Buffer.alloc(7);
  fs.writeFileSync(file, Buffer.concat([Buffer.from(line), padding]));
  fs.utimesSync(file, new Date('2026-09-23T10:00:00'), new Date('2026-09-23T10:00:00'));
  const indexed = indexSpendFile(undefined, file, 'one', reducer, 1).record;
  const old = {
    ...indexed,
    offset: Buffer.byteLength(line),
    trailing: '\0'.repeat(7),
    trailingBytes: padding.toString('base64'),
  };
  const storage = dir();
  saveSpendLedger(storage, 'one', [old]);
  const loaded = loadSpendLedger(storage, 'one');
  assert.equal(loaded.files[0].offset, old.size);
  assert.equal(loaded.completeFiles[0].offset, old.size);
  assert.equal(loaded.files[0].trailing, '');
  assert.equal(indexSpendFile(loaded.files[0], file, 'one', reducer, 2).rebuilt, false);
  assert.equal(
    prepareProjectSpendView(loaded.completeFiles, publicProjectSpendPrice, { now: stamp('2026-09-29T12:00:00') })
      .windows[1].display,
    '$2.00',
  );
});

test('an unfinished line stays unfinished and a bounded NUL scan waits for EOF', () => {
  const folder = dir();
  const file = path.join(folder, 'source.jsonl');
  const line = JSON.stringify(event(stamp('2026-09-29T10:00:00'))) + '\n';
  for (const tail of [Buffer.from('{'), Buffer.from([0, 0, 0x7b])]) {
    fs.writeFileSync(file, Buffer.concat([Buffer.from(line), tail]));
    const indexed = indexSpendFile(undefined, file, 'one', reducer, 1).record;
    assert.equal(indexed.offset, Buffer.byteLength(line));
    assert.equal(indexed.trailingBytes, tail.toString('base64'));
  }
  fs.writeFileSync(file, Buffer.alloc(3));
  const withoutNewline = indexSpendFile(undefined, file, 'one', reducer, 1).record;
  assert.equal(withoutNewline.offset, 0);
  assert.equal(withoutNewline.trailingBytes, Buffer.alloc(3).toString('base64'));
  const padding = Buffer.alloc(12);
  fs.writeFileSync(file, Buffer.concat([Buffer.from(line), padding]));
  const partial = indexSpendFile(undefined, file, 'one', reducer, 1, { maxBytes: Buffer.byteLength(line) + 3 }).record;
  assert.equal(partial.complete, false);
  assert.equal(partial.offset, Buffer.byteLength(line));
  assert.equal(partial.pendingBytes, padding.subarray(0, 3).toString('base64'));
  const finished = indexSpendFile(partial, file, 'one', reducer, 2).record;
  assert.equal(finished.complete, true);
  assert.equal(finished.offset, finished.size);
  assert.equal(finished.buckets[0].requests, 1);
});

test('unfinished tails affect only reachable windows and agent categories', () => {
  const now = stamp('2026-09-29T12:00:00');
  const older = stamp('2026-09-23T10:00:00');
  const oldBucket = aggregateUsageEvents([event(older, { reportedCost: 2 })]);
  const codexBucket = aggregateUsageEvents([event(now, { agent: 'codex', reportedCost: 4 })]);
  const unfinished = (
    file: string,
    mtimeMs: number,
    parserKind?: 'claude' | 'codex',
    buckets: ProjectUsageBucket[] = [],
  ): SpendFileIndex => ({
    file,
    workspace: 'w',
    size: 2,
    mtimeMs,
    offset: 1,
    trailing: '{',
    trailingBytes: Buffer.from('{').toString('base64'),
    buckets,
    lifetimeBuckets: buckets,
    indexedAt: now,
    complete: true,
    ...(parserKind ? { parserKind } : {}),
  });
  const old = unfinished('old.jsonl', older, 'claude', oldBucket);
  const oldView = prepareProjectSpendView([old], publicProjectSpendPrice, { now });
  assert.deepEqual(
    oldView.windows.map((window) => window.display),
    ['$0.00', 'At least $2.00', 'At least $2.00'],
  );
  const recent = unfinished('recent.jsonl', now, 'claude', oldBucket);
  assert.equal(prepareProjectSpendView([recent], publicProjectSpendPrice, { now }).windows[0].display, 'Cost unknown');
  assert.equal(
    prepareProjectSpendView([unfinished('empty.jsonl', now, 'claude')], publicProjectSpendPrice, { now }).windows[0]
      .display,
    'Cost unknown',
  );
  const codex = { ...unfinished('codex.jsonl', now, 'codex', codexBucket), trailing: '', trailingBytes: '', offset: 2 };
  const separated = prepareProjectSpendView([recent, codex], publicProjectSpendPrice, { now });
  assert.equal(separated.windows[0].display, 'At least $4.00');
  assert.equal(separated.categories.find((category) => category.id === 'claude')?.windows[0].display, 'Cost unknown');
  assert.equal(separated.categories.find((category) => category.id === 'codex')?.windows[0].display, '$4.00');
  const linkedClaude = aggregateUsageEvents([event(now, { reportedCost: 1, linkedSessionId: 'linked' })]);
  for (const kind of ['codex', undefined] as const) {
    const mixed = prepareProjectSpendView(
      [codex, unfinished('other.jsonl', now, kind, linkedClaude)],
      publicProjectSpendPrice,
      { now },
    );
    assert.equal(mixed.categories.find((category) => category.id === 'claude')?.windows[0].status, 'atLeast');
    assert.equal(mixed.categories.find((category) => category.id === 'codex')?.windows[0].status, 'atLeast');
  }
});

test('loaded padded child contributes its session and delegated lifetime cost', () => {
  const folder = dir();
  const parentFile = path.join(folder, 'parent.jsonl');
  const childFile = path.join(folder, 'child.jsonl');
  fs.writeFileSync(parentFile, 'parent\n');
  fs.writeFileSync(childFile, Buffer.concat([Buffer.from('child\n'), Buffer.alloc(5)]));
  const at = stamp('2026-09-23T10:00:00');
  const lifetimeBuckets = aggregateUsageEvents([event(at, { reportedCost: 2 })]);
  const parent = spendRecord(parentFile, {
    size: 7,
    offset: 7,
    lifetimeBuckets,
    turnCount: 1,
    compactionCount: 0,
    firstTurnAt: at,
    lastTurnAt: at,
  });
  const child = spendRecord(childFile, {
    size: 11,
    offset: 6,
    trailing: '\0'.repeat(5),
    trailingBytes: Buffer.alloc(5).toString('base64'),
    lifetimeBuckets,
    turnCount: 1,
    compactionCount: 0,
    firstTurnAt: at,
    lastTurnAt: at,
  });
  const storage = dir();
  saveSpendLedger(storage, 'one', [parent, child]);
  const loaded = loadSpendLedger(storage, 'one').files;
  const sources: SessionSpendSource[] = [
    { sessionId: 'parent', file: parentFile, primary: true },
    { sessionId: 'child', file: childFile, primary: true },
    { sessionId: 'parent', file: childFile, primary: false, dispatchedFrom: 'child' },
  ];
  const awaiting = new Set<string>();
  const parts = sessionSpendPartsBySession(loaded, sources, awaiting);
  assert.equal(parts.child.length, 1);
  assert.equal(parts.parent.length, 2);
  assert.deepEqual([...awaiting], []);
  assert.equal(sessionTurnStatsBySession(loaded, sources).child.turnCount, 1);
  assert.equal(spendSourceHeld(loaded[1], false, null), false);
  const unfinished = { ...loaded[1], offset: 6, trailing: '{', trailingBytes: Buffer.from('{').toString('base64') };
  assert.equal(spendSourceHeld(unfinished, false, null), true);
});

test('generation 34 zero-return Bedrock ledgers rebuild and persist corrected facts without source growth', () => {
  for (const parserGeneration of [33, 34]) {
    const folder = dir();
    const file = path.join(folder, 'bedrock-lifetime.jsonl');
    const base = Date.parse('2026-10-01T00:00:00Z');
    const line = (type: string, minute: number, payload: object) =>
      JSON.stringify({ type, timestamp: new Date(base + minute * 60_000).toISOString(), payload });
    fs.writeFileSync(
      file,
      [
        line('session_meta', 0, { id: 'sess', cwd: folder, model_provider: 'amazon-bedrock' }),
        ...[1, 32].flatMap((minute, n) => [
          line('event_msg', minute, { type: 'task_started', turn_id: `t${n}` }),
          line('turn_context', minute, { turn_id: `t${n}`, model: 'openai.gpt-6.1-sol' }),
          line('event_msg', minute, { type: 'user_message', message: `prompt ${n}` }),
          line('event_msg', minute, {
            type: 'token_count',
            info: { last_token_usage: { input_tokens: 1000, output_tokens: 10 } },
          }),
          line('event_msg', minute, { type: 'task_complete', turn_id: `t${n}` }),
        ]),
        '',
      ].join('\n'),
    );
    const before = fs.statSync(file);
    const current = indexSpendFile(undefined, file, 'w', createCodexUsageLineReducer, 1).record;
    assert.ok(current.cacheExpiry?.carry);
    const stale: SpendFileIndex = {
      ...current,
      parserGeneration,
      cacheExpiry: {
        ...current.cacheExpiry,
        carry: { ...current.cacheExpiry.carry, lifetime: null },
        facts: {
          ...current.cacheExpiry.facts,
          counts: { '5m': 0, '30m': 0, '1h': 0 },
          returns: [],
          unavailable: 1,
          longestGapMs: null,
        },
      },
    };
    saveSpendLedger(folder, 'w', [stale]);
    const saved = loadSpendLedger(folder, 'w').files[0];
    assert.equal(saved.cacheExpiry?.facts.counts['30m'], 0);
    const rebuilt = indexSpendFile(saved, file, 'w', createCodexUsageLineReducer, 2);
    assert.equal(rebuilt.rebuilt, true);
    assert.equal(rebuilt.record.cacheExpiry?.facts.counts['30m'], 1);
    assert.equal(rebuilt.record.cacheExpiry?.carry?.lifetime, '30m');
    assert.equal(fs.statSync(file).size, before.size);
    assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
    saveSpendLedger(folder, 'w', [rebuilt.record]);
    const persisted = loadSpendLedger(folder, 'w').files[0];
    assert.equal(persisted.parserGeneration, PROJECT_SPEND_PARSER_GENERATION);
    assert.equal(persisted.cacheExpiry?.facts.counts['30m'], 1);
    assert.equal(persisted.cacheExpiry?.carry?.lifetime, '30m');
    assert.equal(indexSpendFile(persisted, file, 'w', createCodexUsageLineReducer, 3).rebuilt, false);
  }
});

describe('Claude background cost accounting', () => {
  const at = new Date(2026, 9, 4, 12).getTime();
  const model = 'claude-haiku-4-5';
  const clock = (time = at) => ({ type: 'progress', timestamp: new Date(time).toISOString() });
  const cli = (input: number, output = 0, cacheRead = 0, cacheWrite = 0) => ({
    inputTokens: input,
    outputTokens: output,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheWrite,
  });
  const snapshot = (input: number, more: Record<string, Record<string, number>> = {}) =>
    claudeCostState({ [model]: cli(input), ...more });
  const answer = (id: string, time: number, input: number, sidechain = false) => {
    const record = haikuAnswer(id, time, sidechain);
    record.message.usage = { input_tokens: input, output_tokens: 0 };
    return record;
  };
  const replay = (fixture: ReturnType<typeof indexCompactionSession>, budget = {}, progress?: ClaudeCostProgress) => {
    const capture = (fixture.records[0].parserState as ClaudeUsageReducerState).costState!;
    const result = reconcileClaudeCostState(
      capture,
      fixture.records,
      (state) =>
        createClaudeUsageLineReducer(state as ClaudeUsageReducerState | undefined, {
          childTranscript: true,
          retainAllRequests: true,
        }),
      progress,
      { maxMilliseconds: Number.POSITIVE_INFINITY, ...budget },
    );
    if (result.supplement)
      fixture.records[0] = {
        ...fixture.records[0],
        costStateSupplement: result.supplement,
        costStateProgress: result.progress,
      };
    return result;
  };
  const tokens = (buckets: readonly ProjectUsageBucket[], field: keyof UsageCounts = 'input') =>
    buckets.reduce((sum, bucket) => sum + (bucket.usage[field] ?? 0), 0);

  // The clock sets the deadline on its first call and reads past it on every later call.
  const late = () => {
    let calls = 0;
    return {
      maxMilliseconds: 15,
      now: () => (calls++ === 0 ? 0 : 1_000),
      maxBytes: 4096,
      maxWorkingSetBytes: 1 << 20,
    };
  };

  test('an expired cost-state slice advances without buffering the transcript', () => {
    const filler = Array.from({ length: 5000 }, (_, index) => clock(at - 10_000 + index));
    const fixture = indexCompactionSession([clock(), snapshot(120)], [...filler, answer('last', at - 1, 100, true)]);
    assert.ok(fixture.records[1].size > 256 * 1024);
    const capture = (fixture.records[0].parserState as ClaudeUsageReducerState).costState!;
    const whole = reconcileClaudeCostState(
      capture,
      fixture.records,
      (state) =>
        createClaudeUsageLineReducer(state as ClaudeUsageReducerState | undefined, {
          childTranscript: true,
          retainAllRequests: true,
        }),
      undefined,
      { maxMilliseconds: Number.POSITIVE_INFINITY },
    );
    assert.equal(tokens(whole.supplement!.lifetime), 20);
    let result = replay(fixture, late());
    let buffered = 0;
    for (let slice = 0; !result.complete && slice < filler.length * 2; slice++) {
      result = replay(fixture, late(), result.progress);
      buffered = Math.max(buffered, Buffer.from(result.progress.pending, 'base64').length);
    }
    assert.equal(result.complete, true);
    assert.equal(result.progress.reason, undefined);
    assert.ok(buffered <= 2 * 4096, `the pending buffer reached ${buffered} bytes`);
    assert.deepEqual(result.supplement, whole.supplement);
  });

  test('an expired cost-state slice completes at most one zero-byte native child', () => {
    const fixture = indexCompactionSession([clock(), snapshot(120)], [answer('a', at, 100, true)]);
    for (let index = 0; index < 20; index++) {
      const file = path.join(path.dirname(fixture.file), `empty-${index}.jsonl`);
      fs.writeFileSync(file, '');
      fixture.records.push(
        indexSpendFile(
          undefined,
          file,
          'w',
          (state) =>
            createClaudeUsageLineReducer(state as ClaudeUsageReducerState | undefined, { childTranscript: true }),
          1,
          { maxMilliseconds: Infinity },
        ).record,
      );
    }
    const capture = (fixture.records[0].parserState as ClaudeUsageReducerState).costState!;
    const whole = reconcileClaudeCostState(
      capture,
      fixture.records,
      (state) =>
        createClaudeUsageLineReducer(state as ClaudeUsageReducerState | undefined, {
          childTranscript: true,
          retainAllRequests: true,
        }),
      undefined,
      { maxMilliseconds: Number.POSITIVE_INFINITY },
    );
    assert.equal(tokens(whole.supplement!.lifetime), 20);
    let result = replay(fixture, late());
    let slices = 1;
    while (!result.complete && slices < fixture.records.length * 4) {
      const child = result.progress.child;
      result = replay(fixture, late(), result.progress);
      slices++;
      assert.ok(result.progress.child - child <= 1, `one slice completed ${result.progress.child - child} children`);
    }
    assert.equal(result.complete, true);
    assert.equal(result.progress.reason, undefined);
    assert.deepEqual(result.supplement, whole.supplement);
  });

  test('an export skips a repeated child record and counts the record after it in the final chunk', () => {
    const child = [
      answer('first', at - 3, 100, true),
      answer('first', at - 3, 100, true),
      answer('second', at - 2, 7, true),
    ];
    const fixture = indexCompactionSession([clock(), snapshot(140)], child);
    const lines = child.map((line) => Buffer.byteLength(JSON.stringify(line)) + 1);
    // The repeated record starts at its run start, and the next record starts at its run end.
    assert.deepEqual(fixture.records[1].claudeRepeated?.runs, [lines[0], lines[0] + lines[1]]);
    const exported = { now: () => 0, maxBytes: 1 << 20, exportRecordBytes: 1 << 20 };
    // One read holds the whole child, so every line sits in the final chunk of the export.
    assert.equal(tokens(replay(fixture, { now: () => 0, maxBytes: 1 << 20 }).supplement!.lifetime), 33);
    assert.equal(tokens(replay(fixture, exported).supplement!.lifetime), 33);
    // A slice that expires inside the final chunk resumes from its buffered lines.
    let result = replay(fixture, { ...late(), exportRecordBytes: 1 << 20 });
    for (let slice = 0; !result.complete && slice < 20; slice++)
      result = replay(fixture, { ...late(), exportRecordBytes: 1 << 20 }, result.progress);
    assert.equal(result.complete, true);
    assert.equal(tokens(result.supplement!.lifetime), 33);
  });

  test('an export counts the unterminated last record of a child after a repeated record', () => {
    const child = [
      answer('first', at - 3, 100, true),
      answer('first', at - 3, 100, true),
      answer('second', at - 2, 7, true),
    ];
    const fixture = indexCompactionSession([clock(), snapshot(140)], child, true);
    const exported = { now: () => 0, maxBytes: 1 << 20, exportRecordBytes: 1 << 20 };
    assert.equal(tokens(replay(fixture, exported).supplement!.lifetime), 33);
    // Each expired slice parses one record, and the last one has only the unterminated record pending.
    let result = replay(fixture, { ...late(), exportRecordBytes: 1 << 20 });
    for (let slice = 0; !result.complete && slice < 20; slice++)
      result = replay(fixture, { ...late(), exportRecordBytes: 1 << 20 }, result.progress);
    assert.equal(result.complete, true);
    assert.equal(tokens(result.supplement!.lifetime), 33);
    // Outside an export the unterminated record is not complete, and each expired slice still returns.
    result = replay(fixture, late());
    for (let slice = 0; slice < 3; slice++) {
      assert.equal(result.complete, false);
      result = replay(fixture, late(), result.progress);
    }
    assert.equal(result.complete, false);
  });

  test('repeated CLI counters correct intervening parent and child usage in session and Project totals', () => {
    for (const child of [false, true]) {
      const fixture = indexCompactionSession(
        child
          ? [clock(at), snapshot(120), clock(at + 2000), snapshot(120)]
          : [answer('first', at, 100), snapshot(120), answer('second', at + 1000, 20), snapshot(120)],
        child ? [answer('first', at - 1, 100, true), answer('second', at + 1000, 20, true)] : undefined,
      );
      const result = replay(fixture);
      assert.equal(result.supplement!.lifetime.length, 0);
      assert.equal(
        tokens(sessionSpendPartsBySession(fixture.records, fixture.sources).s.map((part) => part.bucket)),
        120,
      );
      assert.equal(
        prepareProjectSpendView(fixture.records, publicProjectSpendPrice, { now: at + 2000 }).windows[0].dollars,
        estimateCost({ ...emptyUsage(), input: 120 }, model),
      );
    }
  });

  test('native child cache-write evidence supplies the latest tier and preserves tied uncertainty', () => {
    const write = (id: string, time: number, hour: boolean, sidechain: boolean) => {
      const record = answer(id, time, 0, sidechain);
      Object.assign(record.message.usage, {
        cache_creation_input_tokens: 10,
        cache_creation: { ephemeral_1h_input_tokens: hour ? 10 : 0, ephemeral_5m_input_tokens: hour ? 0 : 10 },
      });
      return record;
    };
    for (const kind of ['child-only', 'later-child', 'later-parent', 'tie'] as const) {
      const parent =
        kind === 'child-only' ? [] : [write('parent', kind === 'later-parent' ? at + 1000 : at, false, false)];
      const child = write('child', kind === 'later-child' || kind === 'child-only' ? at + 1000 : at, true, true);
      const recorded = kind === 'child-only' ? 10 : 20;
      const fixture = indexCompactionSession(
        [...parent, clock(at + 2000), claudeCostState({ [model]: cli(0, 0, 0, recorded + 20) })],
        [child],
      );
      replay(fixture);
      const supplement = fixture.records[0].costStateSupplement!;
      assert.equal(
        tokens(supplement.lifetime, 'cacheWrite1h'),
        kind === 'child-only' || kind === 'later-child' ? 20 : 0,
      );
      assert.equal(supplement.lifetime[0].incomplete, kind === 'tie');
      const projection = sessionCostProjection(
        sessionSpendPartsBySession(fixture.records, fixture.sources).s.map(sessionCostUsageOf),
      );
      assert.equal(projection.total.partial, kind === 'tie');
      if (kind !== 'tie') {
        const expected = estimateCost(
          {
            ...emptyUsage(),
            cacheWrite1h: kind === 'child-only' ? 30 : kind === 'later-child' ? 30 : 10,
            cacheWrite5m: kind === 'later-child' ? 10 : kind === 'later-parent' ? 30 : 0,
          },
          model,
        );
        assert.equal(projection.total.dollars, expected);
        assert.equal(
          prepareProjectSpendView(fixture.records, publicProjectSpendPrice, { now: at + 2000 }).windows[0].dollars,
          expected,
        );
      }
    }
  });

  test('restored substantial request history respects zero budgets and cooperatively withholds oversized state', () => {
    const fixture = indexCompactionSession([clock(), snapshot(18020)], [answer('stub', at - 1, 1, true)]);
    const reducer = createClaudeUsageLineReducer(undefined, { childTranscript: true, retainAllRequests: true });
    for (let index = 0; index < 18000; index++)
      reducer.pushLine(JSON.stringify(answer(`history-${index}`, at - 1, 1, true)));
    const restored = replay(fixture, { maxBytes: 0 }).progress;
    restored.reducer = reducer.snapshot();
    const factory = vi.fn<(state: unknown) => ReturnType<typeof createClaudeUsageLineReducer>>((state: unknown) =>
      createClaudeUsageLineReducer(state as ClaudeUsageReducerState, {
        childTranscript: true,
        retainAllRequests: true,
      }),
    );
    const clone = vi.spyOn(globalThis, 'structuredClone');
    const capture = (fixture.records[0].parserState as ClaudeUsageReducerState).costState!;
    const paused = reconcileClaudeCostState(capture, fixture.records, factory, restored, {
      maxBytes: 0,
      maxMilliseconds: 0,
    });
    assert.equal(paused.progress, restored);
    assert.equal(factory.mock.calls.length, 0);
    assert.equal(clone.mock.calls.length, 0);
    clone.mockRestore();
    const read = vi.spyOn(fs, 'readSync');
    let result = paused;
    for (let turn = 0; turn < 100 && !result.complete; turn++) {
      result = reconcileClaudeCostState(capture, fixture.records, factory, result.progress, {
        maxMilliseconds: Infinity,
      });
      assert.equal(result.progress.offset, 0);
    }
    assert.equal(result.progress.reason, 'working set limit');
    assert.equal(result.supplement, undefined);
    assert.equal(result.progress.reducer, undefined);
    assert.equal(factory.mock.calls.length, 0);
    assert.equal(read.mock.calls.length, 0);
    read.mockRestore();
    assert.equal(validClaudeCostProgress(result.progress), true);
  });

  test('task-notification checkpoints retain accounting through a saved ledger restart', () => {
    const child = [
      {
        type: 'user',
        isSidechain: true,
        timestamp: new Date(at - 2).toISOString(),
        message: { role: 'user', content: 'Work' },
      },
      answer('notice-request', at - 1, 100, true),
      {
        type: 'user',
        timestamp: new Date(at).toISOString(),
        origin: { kind: 'task-notification' },
        message: {
          role: 'user',
          content:
            '<task-notification><task-id>native</task-id><tool-use-id>native</tool-use-id><status>completed</status></task-notification>',
        },
      },
    ];
    const bytes = Buffer.byteLength(child.map((record) => JSON.stringify(record)).join('\n') + '\n');
    const fixture = indexCompactionSession(
      [clock(at + 1), snapshot(120)],
      [...child, { type: 'progress', text: 'x'.repeat(1024) }],
    );
    const partial = replay(fixture, { maxBytes: bytes });
    assert.equal(partial.complete, false);
    assert.equal((partial.progress.reducer as ClaudeUsageReducerState).closedChildIndex?.size, 1);
    fixture.records[0] = { ...fixture.records[0], costStateProgress: partial.progress };
    const store = dir();
    saveSpendLedger(store, 'w', fixture.records);
    const loaded = loadSpendLedger(store, 'w');
    assert.equal(loaded.files.length, 2);
    const resumed = replay(fixture, {}, loaded.files[0].costStateProgress);
    assert.equal(tokens(resumed.supplement!.lifetime), 20);
    assert.equal(
      tokens(sessionSpendPartsBySession(fixture.records, fixture.sources).s.map((part) => part.bucket)),
      120,
    );
  });

  test.each(['user task-notification', 'attachment task-notification', 'deferred tool-name'] as const)(
    'substantial %s history withholds before admission loses the saved baseline',
    (format) => {
      const notices = Array.from({ length: 650 }, (_, index) => {
        const prompt = `<task-notification><task-id>${index}-${'x'.repeat(10000)}</task-id><status>completed</status></task-notification>`;
        return format === 'user task-notification'
          ? {
              type: 'user',
              timestamp: new Date(at).toISOString(),
              origin: { kind: 'task-notification' },
              message: { role: 'user', content: prompt },
            }
          : format === 'attachment task-notification'
            ? {
                type: 'attachment',
                timestamp: new Date(at).toISOString(),
                attachment: { type: 'queued_command', commandMode: 'task-notification', prompt },
              }
            : {
                type: 'attachment',
                timestamp: new Date(at).toISOString(),
                attachment: { type: 'deferred_tools_delta', addedNames: [`${index}-${'x'.repeat(10000)}`] },
              };
      });
      const fixture = indexCompactionSession(
        [clock(at + 1), snapshot(120)],
        [
          { type: 'user', isSidechain: true, message: { role: 'user', content: 'Work' } },
          answer('notice-history', at - 1, 100, true),
          ...notices,
        ],
      );
      const store = dir();
      fixture.records[1] = indexSpendFile(
        undefined,
        fixture.childFile,
        'w',
        (state) =>
          createClaudeUsageLineReducer(state as ClaudeUsageReducerState | undefined, { childTranscript: true }),
        1,
        { maxBytes: Infinity, maxMilliseconds: Infinity },
      ).record;
      let result = replay(fixture);
      for (let turn = 0; turn < 100; turn++) {
        if (!result.complete) assert.ok(retainedParserPayload(result.progress) * 4 < CLAUDE_COST_STATE_BYTES);
        fixture.records[0] = { ...fixture.records[0], costStateProgress: result.progress };
        saveSpendLedger(store, 'w', fixture.records);
        const loaded = loadSpendLedger(store, 'w');
        assert.equal(loaded.files.length, 2);
        assert.equal(tokens(loaded.files[1].lifetimeBuckets!), 100);
        if (result.complete) break;
        result = replay(fixture, {}, result.progress);
      }
      assert.equal(result.complete, true);
      assert.equal(result.progress.reason, 'working set limit');
      assert.equal(result.supplement, undefined);
      assert.equal(result.progress.reducer, undefined);
      assert.equal(result.progress.pending, '');
      assert.equal(result.progress.activeTierRequests, undefined);
      const loaded = loadSpendLedger(store, 'w');
      assert.equal(replay(fixture, {}, loaded.files[0].costStateProgress).progress.reason, 'working set limit');
      assert.equal(tokens(sessionSpendPartsBySession(loaded.files, fixture.sources).s.map((part) => part.bucket)), 100);
    },
  );

  test('replaced writes price residuals from surviving request evidence across saved cuts', () => {
    const write = (id: string, time: number, hour: boolean | null) => {
      const record = answer(id, time, 0, true);
      // Claude Code gives each rewrite of a growing response its own uuid.
      record.uuid = `${id}-${String(hour)}`;
      Object.assign(record.message.usage, {
        cache_creation_input_tokens: hour === null ? 0 : 10,
        cache_creation: {
          ephemeral_1h_input_tokens: hour === true ? 10 : 0,
          ephemeral_5m_input_tokens: hour === false ? 10 : 0,
        },
      });
      return record;
    };
    for (const kind of ['same-clock', 'remove-latest', 'independent-tie', 'parent-capture'] as const) {
      const writes =
        kind === 'remove-latest'
          ? [write('older', at - 2, true), write('latest', at - 1, false), write('latest', at - 1, null)]
          : [write('latest', at - 1, true), write(kind === 'independent-tie' ? 'other' : 'latest', at - 1, false)];
      const recorded = kind === 'independent-tie' ? 20 : 10;
      const cuts = [clock(at), claudeCostState({ [model]: cli(0, 0, 0, recorded + 20) })];
      const fixture = indexCompactionSession(
        kind === 'parent-capture' ? [...writes, ...cuts] : cuts,
        kind === 'parent-capture' ? undefined : writes,
      );
      if (kind === 'parent-capture') {
        const reducer = createClaudeUsageLineReducer(undefined, { childTranscript: true });
        reducer.pushLine(JSON.stringify(writes[0]));
        fixture.records[0] = { ...fixture.records[0], parserState: reducer.snapshot() };
        const captureStore = dir();
        saveSpendLedger(captureStore, 'w', fixture.records);
        const savedCapture = loadSpendLedger(captureStore, 'w').files[0].parserState as ClaudeUsageReducerState;
        const resumed = createClaudeUsageLineReducer(savedCapture, { childTranscript: true });
        for (const record of [...writes.slice(1), ...cuts]) resumed.pushLine(JSON.stringify(record));
        fixture.records[0] = { ...fixture.records[0], parserState: resumed.snapshot() };
      }
      const partial = replay(fixture, {
        maxBytes: kind === 'parent-capture' ? 0 : Buffer.byteLength(JSON.stringify(writes[0]) + '\n'),
      });
      fixture.records[0] = { ...fixture.records[0], costStateProgress: partial.progress };
      const store = dir();
      saveSpendLedger(store, 'w', fixture.records);
      const loaded = loadSpendLedger(store, 'w');
      assert.equal(loaded.files.length, fixture.records.length);
      const result = replay(fixture, {}, loaded.files[0].costStateProgress);
      const bucket = result.supplement!.lifetime[0];
      assert.equal(bucket.incomplete, kind === 'independent-tie');
      assert.equal(tokens(result.supplement!.lifetime, kind === 'remove-latest' ? 'cacheWrite1h' : 'cacheWrite5m'), 20);
      assert.equal(
        sessionCostProjection(
          result.supplement!.lifetime.map((item) => sessionCostUsageOf({ bucket: item, role: 'main' })),
        ).total.partial,
        kind === 'independent-tie',
      );
      if (kind !== 'parent-capture') {
        const expected = estimateCost(
          {
            ...emptyUsage(),
            cacheWrite1h: kind === 'remove-latest' ? 30 : kind === 'independent-tie' ? 10 : 0,
            cacheWrite5m: kind === 'remove-latest' ? 0 : kind === 'independent-tie' ? 10 : 30,
          },
          model,
        );
        if (kind !== 'independent-tie')
          assert.equal(
            prepareProjectSpendView(fixture.records, publicProjectSpendPrice, { now: at }).windows[0].dollars,
            expected,
          );
      }
    }
  });

  test('record-boundary deadlines retain pending records and resume without rereading frozen bytes', () => {
    const fixture = indexCompactionSession(
      [clock(), snapshot(120)],
      Array.from({ length: 100 }, (_, index) => answer(`clocked-${index}`, at - 1, 1, true)),
    );
    const read = vi.spyOn(fs, 'readSync');
    let tick = 0;
    const paused = replay(fixture, { maxMilliseconds: 8, now: () => tick++ });
    assert.equal(paused.complete, false);
    assert.equal(paused.progress.offset, fixture.records[1].size);
    assert.ok(paused.progress.pending.length > 0);
    const done = replay(fixture, {}, paused.progress);
    assert.equal(tokens(done.supplement!.lifetime), 20);
    assert.equal(
      read.mock.results.reduce((sum, result) => sum + Number(result.value), 0),
      fixture.records[1].size,
    );
    read.mockRestore();
  });

  test('retained replay checkpoints share full history and admit payload before parsing more requests', () => {
    const fixture = indexCompactionSession(
      [clock(), snapshot(5000)],
      Array.from({ length: 1500 }, (_, index) => answer(`many-${index}`, at - 1, 1, true)),
    );
    let result = replay(fixture, { maxBytes: 32 * 1024 });
    const history = (result.progress.reducer as ClaudeUsageReducerState).requestEvents;
    assert.ok(Object.keys(history!).length > 64);
    const before = result.progress.offset;
    const stringify = vi.spyOn(JSON, 'stringify');
    const clone = vi.spyOn(globalThis, 'structuredClone');
    result = replay(fixture, { maxBytes: 32 * 1024 }, result.progress);
    assert.equal((result.progress.reducer as ClaudeUsageReducerState).requestEvents, history);
    assert.ok(result.progress.offset > before);
    assert.equal(clone.mock.calls.length, 0);
    assert.equal(
      stringify.mock.calls.some((call) => call[0] === result.progress),
      false,
    );
    clone.mockRestore();
    stringify.mockRestore();
    assert.ok((result.progress.resourceBytes ?? 0) < CLAUDE_COST_STATE_BYTES);
    assert.ok(
      retainedParserPayload([result.progress, (fixture.records[0].parserState as ClaudeUsageReducerState).costState]) *
        4 <
        result.progress.resourceBytes!,
    );
    const saved = structuredClone(result.progress);
    const factory = vi.fn<(state: unknown) => ReturnType<typeof createClaudeUsageLineReducer>>((state: unknown) =>
      createClaudeUsageLineReducer(state as ClaudeUsageReducerState, {
        childTranscript: true,
        retainAllRequests: true,
      }),
    );
    const admitted = reconcileClaudeCostState(
      (fixture.records[0].parserState as ClaudeUsageReducerState).costState!,
      fixture.records,
      factory,
      saved,
      { maxMilliseconds: Infinity },
    );
    assert.equal(admitted.progress.offset, saved.offset);
    assert.equal(factory.mock.calls.length, 0, 'restoration must yield before constructing the retained request index');
    for (let turn = 0; turn < 100 && !result.complete; turn++)
      result = replay(fixture, { maxBytes: 32 * 1024 }, result.progress);
    assert.equal(result.progress.reason, 'working set limit');
    assert.equal(result.supplement, undefined);
    assert.equal(tokens(fixture.records[1].lifetimeBuckets!), 1500);
  });

  test('an unrecorded Haiku request reaches existing session and Project figures with zero requests', () => {
    const fixture = indexCompactionSession([clock(), claudeCostState({ [model]: cli(1050, 13) })]);
    const before = prepareProjectSpendView(fixture.records, publicProjectSpendPrice, { now: at });
    assert.equal(before.windows[0].dollars, 0);
    const result = replay(fixture);
    assert.equal(result.complete, true);
    const parts = sessionSpendPartsBySession(fixture.records, fixture.sources).s;
    const expected = estimateCost({ ...emptyUsage(), input: 1050, output: 13 }, model)!;
    assert.ok(expected > 0);
    assert.equal(sessionCostProjection(parts.map(sessionCostUsageOf)).total.dollars, expected);
    const view = prepareProjectSpendView(fixture.records, publicProjectSpendPrice, { now: at });
    assert.equal(view.windows[0].dollars, expected);
    assert.equal(view.windows[0].pricedRequests, 0);
    assert.equal(view.categories[0].windows[0].dollars, expected);
    assert.equal(fixture.records[0].buckets.length, 0);
    assert.equal(parts[0].bucket.usageOrigin, 'claude-cost-state');
    assert.equal(sessionCostUsageOf(parts[0]).usageOrigin, 'claude-cost-state');
  });

  test('an unpriced supplemental-only window keeps unknown cost and zero request counts', () => {
    const fixture = indexCompactionSession([clock(), claudeCostState({ unknown: cli(1000) })]);
    replay(fixture);
    const view = prepareProjectSpendView(fixture.records, publicProjectSpendPrice, { now: at });
    assert.equal(view.windows[0].status, 'unknown');
    assert.equal(view.categories[0].windows[0].status, 'unknown');
    assert.equal(view.windows[0].unpricedRequests, 0);
    assert.equal(
      sessionCostProjection(sessionSpendPartsBySession(fixture.records, fixture.sources).s.map(sessionCostUsageOf))
        .total.dollars,
      null,
    );
  });

  test('advisor usage explains its cost-state counters, so Claude supplemental accounting adds nothing', () => {
    const expected = Object.values(ADVISOR_MODEL_USAGE).reduce((sum, usage) => sum + usage.costUSD, 0);
    const check = (fixture: ReturnType<typeof indexCompactionSession>) => {
      assert.equal(replay(fixture).complete, true);
      const parts = sessionSpendPartsBySession(fixture.records, fixture.sources).s;
      // A zero supplement alone proves nothing: reconciliation skips a model whose recorded usage exceeds its counter.
      assert.deepEqual(
        parts.filter(({ bucket }) => bucket.usageOrigin === 'claude-cost-state'),
        [],
      );
      const total = sessionCostProjection(parts.map(sessionCostUsageOf)).total.dollars;
      assert.ok(Math.abs(total! - expected) < 1e-9, String(total));
    };
    check(indexCompactionSession(advisorProbeRecords()));
    // An ancestor's process-end record also counts the advisor usage of its native child.
    const probe = advisorProbeRecords();
    check(indexCompactionSession([probe[0], ...probe.slice(-2)], advisorResponseRecords({ sidechain: true })));
  });

  test('Project cost includes actual compaction residual independently of lifetime estimates', () => {
    const lines = claudeCompactionTranscript(COMPACTION_ROW);
    const baseline = indexCompactionSession(lines);
    const recorded = baseline.record.lifetimeBuckets!.filter((bucket) => !bucket.compactionEstimate);
    const estimates = baseline.record.lifetimeBuckets!.filter((bucket) => bucket.compactionEstimate);
    const raw = cli(
      tokens(recorded) + tokens(estimates),
      tokens(recorded, 'output') + tokens(estimates, 'output'),
      tokens(recorded, 'cacheRead') + tokens(estimates, 'cacheRead'),
      tokens(recorded, 'cacheWrite5m') +
        tokens(recorded, 'cacheWrite1h') +
        tokens(estimates, 'cacheWrite5m') +
        tokens(estimates, 'cacheWrite1h'),
    );
    const fixture = indexCompactionSession([...lines, claudeCostState({ [COMPACTION_ROW.model]: raw })]);
    const result = replay(fixture);
    assert.equal(result.supplement!.lifetime.length, 0);
    assert.equal(tokens(result.supplement!.dated), tokens(estimates));
    const overestimated = indexCompactionSession([
      ...lines,
      claudeCostState({ [COMPACTION_ROW.model]: { ...raw, inputTokens: tokens(recorded) + 1 } }),
    ]);
    const corrected = replay(overestimated).supplement!;
    assert.equal(tokens(corrected.lifetime), 0);
    assert.equal(tokens(corrected.dated), 1);
  });

  test('a same-day child cut excludes later usage and preserves signed revision timestamps', () => {
    const fixture = indexCompactionSession(
      [clock(at), snapshot(120), clock(at + 2000), snapshot(340)],
      [answer('a', at - 1000, 100, true), answer('b', at + 1000, 200, true)],
    );
    const result = replay(fixture);
    assert.equal(tokens(result.supplement!.lifetime), 40);
    assert.equal(result.progress.recorded[0][model].input, 100);
    assert.equal(tokens(result.supplement!.dated), 40);
    assert.equal(tokens(fixture.records[1].lifetimeBuckets!), 300);
    const revised = indexCompactionSession(
      [clock(at), snapshot(120), clock(at + 2000), snapshot(170)],
      [answer('a', at - 1000, 100, true), answer('a', at + 1000, 150, true)],
    );
    assert.equal(tokens(replay(revised).supplement!.lifetime), 20);
  });

  test('full child retention withholds a model when the displayed buckets counted an evicted revision twice', () => {
    const child = [
      answer('old', at - 1000, 100, true),
      ...Array.from({ length: 65 }, (_, index) => answer(`filler-${index}`, at - 500, 0, true)),
      answer('old', at + 1000, 150, true),
    ];
    const fixture = indexCompactionSession([clock(at + 2000), snapshot(170)], child);
    assert.equal(tokens(fixture.records[1].lifetimeBuckets!), 250);
    let result = replay(fixture, { maxBytes: 1300 });
    while (!result.complete) {
      fixture.records[0] = { ...fixture.records[0], costStateProgress: result.progress };
      const store = dir();
      saveSpendLedger(store, 'w', fixture.records);
      const restored = loadSpendLedger(store, 'w');
      assert.equal(restored.files.length, 2);
      result = replay(fixture, { maxBytes: 1300 }, restored.files[0].costStateProgress);
    }
    assert.deepEqual(result.progress.blocked, [model]);
    assert.equal(result.supplement!.lifetime.length, 0);
  });

  test('decreasing gaps correct their original dates after a persisted restart', () => {
    const fixture = indexCompactionSession([
      clock(at - 86400000),
      snapshot(20),
      clock(at),
      snapshot(10),
      clock(at + 86400000),
      snapshot(20),
    ]);
    const result = replay(fixture);
    assert.equal(tokens(result.supplement!.dated), 20);
    assert.deepEqual(
      result.supplement!.dated.map((bucket) => bucket.usage.input),
      [10, 10],
    );
    assert.ok(result.supplement!.dated.every((bucket) => bucket.usage.input >= 0));
    const store = dir();
    saveSpendLedger(store, 'w', fixture.records);
    const loaded = loadSpendLedger(store, 'w');
    assert.equal(tokens(loaded.files[0].costStateSupplement!.dated), 20);
    assert.equal(loaded.files[0].costStateSupplement!.dated[0].usageOrigin, 'claude-cost-state');
  });

  test('deficits retain eligible counters while other counters and missing models still reconcile', () => {
    const fixture = indexCompactionSession([
      answer('a', at, 100),
      snapshot(120),
      claudeCostState({ [model]: cli(90, 10) }),
      claudeCostState({ other: cli(5) }),
    ]);
    const result = replay(fixture).supplement!;
    assert.equal(tokens(result.lifetime), 25);
    assert.equal(tokens(result.lifetime, 'output'), 10);
  });

  test('duplicates, empty records, lineage resets, and malformed counters cannot add new usage', () => {
    const malformed = { ...snapshot(500), modelUsage: { [model]: { ...cli(500), inputTokens: -1 } } };
    const fixture = indexCompactionSession([
      clock(),
      snapshot(20),
      snapshot(20),
      claudeCostState({}),
      malformed,
      { ...snapshot(100), startTime: 2 },
      snapshot(500),
    ]);
    const capture = (fixture.record.parserState as ClaudeUsageReducerState).costState!;
    assert.equal(capture.snapshots.length, 3);
    assert.equal(tokens(replay(fixture).supplement!.lifetime), 20);
  });

  test('tool-result clocks date snapshots and missing clocks supply lifetime usage only', () => {
    const fixture = indexCompactionSession([
      {
        type: 'user',
        timestamp: new Date(at).toISOString(),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
      },
      snapshot(10),
    ]);
    assert.equal(replay(fixture).supplement!.dated[0].localDate, '2026-10-04');
    const unknown = indexCompactionSession([snapshot(10)]);
    const result = replay(unknown).supplement!;
    assert.equal(tokens(result.lifetime), 10);
    assert.equal(result.dated.length, 0);
  });

  test('unknown child clocks withhold the comparison instead of proving zero child usage', () => {
    const child = { ...answer('a', at, 100, true), timestamp: '' };
    const fixture = indexCompactionSession([clock(), snapshot(120)], [child]);
    const result = replay(fixture);
    assert.equal(result.supplement!.lifetime.length, 0);
  });

  test('native dependencies exclude dispatched and unrelated sources and deduplicate paths', () => {
    const fixture = indexCompactionSession([clock(), snapshot(120)], [answer('a', at, 100, true)]);
    const own = fixture.sources[0];
    const sources = [
      ...fixture.sources,
      fixture.sources[1],
      { sessionId: 's', file: 'foreign', primary: false, dispatchedFrom: 'foreign', dispatchedVia: 'foreign' },
      { sessionId: 'unrelated', file: 'direct', primary: true },
    ];
    assert.equal(claudeCostStateDependencies(own, sources, fixture.records)!.length, 2);
    assert.equal(
      claudeCostStateDependencies(own, [...sources, { sessionId: 's', file: 'late', primary: false }], fixture.records),
      null,
    );
    assert.equal(tokens(replay(fixture).supplement!.lifetime), 20);
    const late = [...fixture.sources, { sessionId: 's', file: 'late', primary: false }];
    const invalidated = invalidateClaudeCostSupplements(fixture.records, late);
    assert.equal(invalidated[0].costStateSupplement, undefined);
    assert.equal(tokens(invalidated[1].lifetimeBuckets!), 100);
  });

  test('native grandchildren and a child accounting owner each contribute once', () => {
    const fixture = indexCompactionSession(
      [clock(at + 2000), snapshot(170)],
      [answer('a', at, 100, true), clock(at + 1000), snapshot(120)],
    );
    const childCapture = (fixture.records[1].parserState as ClaudeUsageReducerState).costState!;
    const childSupplement = reconcileClaudeCostState(
      childCapture,
      [fixture.records[1]],
      (state) =>
        createClaudeUsageLineReducer(state as ClaudeUsageReducerState | undefined, {
          childTranscript: true,
          retainAllRequests: true,
        }),
      undefined,
      { maxMilliseconds: Number.POSITIVE_INFINITY },
    ).supplement!;
    fixture.records[1] = { ...fixture.records[1], costStateSupplement: childSupplement };
    const grandchildFile = path.join(path.dirname(fixture.file), 'grandchild.jsonl');
    fs.writeFileSync(grandchildFile, JSON.stringify(answer('grandchild', at, 30, true)) + '\n');
    fixture.records.push(
      indexSpendFile(
        undefined,
        grandchildFile,
        'w',
        (state) =>
          createClaudeUsageLineReducer(state as ClaudeUsageReducerState | undefined, { childTranscript: true }),
        1,
        { maxMilliseconds: Infinity },
      ).record,
    );
    fixture.sources.push({ sessionId: 's', file: grandchildFile, primary: false });
    const result = replay(fixture).supplement!;
    assert.equal(tokens(result.lifetime), 20);
    const parts = sessionSpendPartsBySession(fixture.records, fixture.sources).s;
    assert.equal(tokens(parts.map((part) => part.bucket)), 170);
    assert.equal(
      prepareProjectSpendView(fixture.records, publicProjectSpendPrice, { now: at + 2000 }).windows[0].dollars,
      estimateCost({ ...emptyUsage(), input: 170 }, model),
    );
  });

  test('cancellation and time exhaustion retain the cursor and parse each frozen child byte once', () => {
    const fixture = indexCompactionSession([clock(), snapshot(120)], [answer('a', at, 100, true)]);
    const cancelled = replay(fixture, { maxBytes: 0 });
    assert.equal(cancelled.complete, false);
    assert.equal(cancelled.progress.offset, 0);
    const read = vi.spyOn(fs, 'readSync');
    const bytesRead = () => read.mock.results.reduce((sum, result) => sum + Number(result.value), 0);
    let clockTick = 0;
    const exhausted = replay(fixture, { maxMilliseconds: 1, now: () => clockTick++ }, cancelled.progress);
    assert.equal(exhausted.complete, false);
    assert.equal(exhausted.progress.offset, fixture.records[1].size);
    assert.equal(exhausted.progress.offset, bytesRead());
    assert.equal(Buffer.from(exhausted.progress.pending, 'base64').length, bytesRead());
    const completed = replay(fixture, {}, exhausted.progress);
    assert.equal(tokens(completed.supplement!.lifetime), 20);
    assert.equal(bytesRead(), fixture.records[1].size);
    read.mockRestore();
    assert.equal(
      reconcileClaudeCostState(
        (fixture.record.parserState as ClaudeUsageReducerState).costState!,
        [{ ...fixture.record, parserGeneration: 34 }, fixture.records[1]],
        (state) =>
          createClaudeUsageLineReducer(state as ClaudeUsageReducerState | undefined, {
            childTranscript: true,
            retainAllRequests: true,
          }),
        completed.progress,
        { maxBytes: 0 },
      ).progress.child,
      1,
    );
  });

  test('a working-set overflow preserves baseline usage and a resumable valid ledger', () => {
    const fixture = indexCompactionSession([clock(), snapshot(120)], [answer('a', at, 100, true)]);
    fs.appendFileSync(fixture.childFile, JSON.stringify({ type: 'progress', text: 'x'.repeat(64 * 1024) }) + '\n');
    fixture.records[1] = indexSpendFile(
      fixture.records[1],
      fixture.childFile,
      'w',
      (state) => createClaudeUsageLineReducer(state as ClaudeUsageReducerState | undefined, { childTranscript: true }),
      2,
      { maxMilliseconds: Infinity, maxBytes: Infinity },
    ).record;
    const result = replay(fixture, { maxBytes: Infinity, maxWorkingSetBytes: 32 * 1024 });
    assert.equal(result.progress.reason, 'working set limit');
    assert.equal(result.supplement, undefined);
    fixture.records[0] = { ...fixture.records[0], costStateProgress: result.progress };
    const store = dir();
    saveSpendLedger(store, 'w', fixture.records);
    const restored = loadSpendLedger(store, 'w');
    assert.equal(restored.files.length, 2);
    assert.equal(tokens(restored.files[1].lifetimeBuckets!), 100);
  });

  test('a changed child cannot publish a frozen result or join it against newer display buckets', () => {
    const fixture = indexCompactionSession([clock(), snapshot(120)], [answer('a', at, 100, true)]);
    const partial = replay(fixture, { maxBytes: 5 });
    assert.equal(partial.complete, false);
    assert.equal(partial.supplement, undefined);
    fs.appendFileSync(fixture.childFile, JSON.stringify(answer('b', at - 1, 20, true)) + '\n');
    assert.equal(replay(fixture, {}, partial.progress).invalidated, true);
    fixture.records[1] = indexSpendFile(
      fixture.records[1],
      fixture.childFile,
      'w',
      (state) => createClaudeUsageLineReducer(state as ClaudeUsageReducerState | undefined, { childTranscript: true }),
      2,
      { maxMilliseconds: Infinity },
    ).record;
    const published = replay(fixture).supplement!;
    assert.equal(tokens(published.lifetime), 0);
    fixture.records[0] = {
      ...fixture.records[0],
      costStateSupplement: {
        ...published,
        lifetime: [{ ...published.dated[0], usage: { ...emptyUsage(), input: 50 } }],
      },
    };
    fixture.records[1] = { ...fixture.records[1], mtimeMs: fixture.records[1].mtimeMs + 1 };
    assert.equal(
      sessionSpendPartsBySession(fixture.records, fixture.sources).s.filter((part) => part.bucket.usageOrigin).length,
      0,
    );
  });

  test('snapshots and raw-model overflow withhold the whole supplemental figure', () => {
    const snapshots = indexCompactionSession([
      clock(),
      ...Array.from({ length: CLAUDE_COST_STATE_SNAPSHOTS + 1 }, (_, index) => snapshot(index + 1)),
    ]);
    assert.equal(replay(snapshots).supplement, undefined);
    const models = indexCompactionSession([
      clock(),
      claudeCostState(
        Object.fromEntries(Array.from({ length: CLAUDE_COST_STATE_MODELS + 1 }, (_, index) => [`m-${index}`, cli(1)])),
      ),
    ]);
    assert.equal(replay(models).supplement, undefined);
  });

  test('cache writes use each model tier and unknown request-size pricing remains unpriced', () => {
    const recorded = answer('one', at, 0);
    Object.assign(recorded.message.usage, {
      cache_creation: { ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 0 },
      cache_creation_input_tokens: 10,
    });
    const fixture = indexCompactionSession([
      recorded,
      claudeCostState({ [model]: cli(0, 0, 0, 30), 'gpt-5.4': cli(10), 'claude-haiku-4-5[1m]': cli(0) }),
    ]);
    const result = replay(fixture).supplement!;
    assert.equal(
      result.lifetime.some((bucket) => bucket.model === model),
      false,
      'unproved aliases must not reuse one transcript comparison',
    );
    const tiers = indexCompactionSession([
      recorded,
      claudeCostState({ [model]: cli(0, 0, 0, 30), 'gpt-5.4': cli(10) }),
    ]);
    const buckets = replay(tiers).supplement!.lifetime;
    assert.equal(buckets.find((bucket) => bucket.model === model)!.usage.cacheWrite1h, 20);
    assert.equal(buckets.find((bucket) => bucket.model === 'gpt-5.4')!.incomplete, true);
    const projection = sessionCostProjection(
      sessionSpendPartsBySession(tiers.records, tiers.sources).s.map(sessionCostUsageOf),
    );
    assert.equal(projection.total.partial, true);
  });

  test('supplements do not change dispatched card usage, request metrics, or cache predecessors', () => {
    const fixture = indexCompactionSession([
      answer('a', at - 1000, 100),
      clock(),
      snapshot(120),
      answer('b', at + 1000, 100),
    ]);
    const before = structuredClone(fixture.record.cacheExpiry);
    replay(fixture);
    const sources = [
      {
        sessionId: 'codex',
        file: fixture.file,
        primary: false,
        dispatchedFrom: 's',
        dispatchedVia: 's',
        dispatchedPrimary: true as const,
      },
      ...fixture.sources,
    ];
    const parts = sessionSpendPartsBySession(fixture.records, sources).codex;
    assert.equal(tokens(parts.map((part) => part.bucket)), 220);
    const dispatched = dispatchedSpendPartsBySession(fixture.records, sources).codex.s.parts.s;
    assert.equal(tokens(dispatched.map((part) => part.bucket)), 200);
    assert.deepEqual(fixture.records[0].cacheExpiry, before);
    assert.equal(fixture.records[0].lifetimeBuckets![0].requests, 2);
    const baselineRead = readClaudeAgentSpend(fixture.file, [], false);
    assert.equal(baselineRead.models[0].usage.input, 200);
  });
});

test('Bedrock Astra rebuilds literal parser generation 37 at unchanged EOF before saved spend is priced', () => {
  const folder = dir();
  const file = path.join(folder, 'bedrock-astra.jsonl');
  const events = [100_000, 100_000].map((input, index) =>
    event(stamp(`2026-10-01T1${index}:00:00`), {
      agent: 'codex',
      provider: 'amazon-bedrock',
      model: 'openai.gpt-6-astra',
      serviceTier: 'default',
      usage: { ...usage(), input, cacheWrite30m: 20_000, cacheRead: 100_000, output: 10_000 },
    }),
  );
  fs.writeFileSync(file, events.map((request) => JSON.stringify(request)).join('\n') + '\n');
  const current = indexSpendFile(undefined, file, 'w', reducer, 1).record;
  const unpriced = current.buckets.map((bucket) => ({ ...bucket, contextBand: null, inferenceClass: null }));
  const storage = dir();
  saveSpendLedger(storage, 'w', [{ ...current, parserGeneration: 37, buckets: unpriced, lifetimeBuckets: unpriced }]);
  const before = fs.statSync(file);
  const loaded = loadSpendLedger(storage, 'w').files[0];
  assert.equal(loaded.offset, loaded.size);
  const rebuilt = indexSpendFile(loaded, file, 'w', reducer, 2);
  assert.equal(rebuilt.rebuilt, true);
  assert.equal(rebuilt.record.buckets[0]?.requests, 2);
  assert.equal(rebuilt.record.buckets[0]?.contextBand, 'short');
  saveSpendLedger(storage, 'w', [rebuilt.record]);
  const restored = loadSpendLedger(storage, 'w').files[0];
  assert.ok(Math.abs(publicProjectSpendPrice(restored.buckets[0])!.dollars - 4.07) < 1e-12);
  assert.equal(indexSpendFile(restored, file, 'w', reducer, 3).rebuilt, false);
  assert.equal(fs.statSync(file).size, before.size);
  assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
});

for (const childTranscript of [false, true])
  test(`a cold Claude prefix follows the first later cache read across ledger restoration, child=${childTranscript}`, () => {
    const reducer: UsageReducerFactory = (state) =>
      createClaudeUsageLineReducer(state as ClaudeUsageReducerState | undefined, { childTranscript });
    const lines = claudeCompactionTranscript(COLD_ROW);
    const folder = dir();
    const file = path.join(folder, 'source.jsonl');
    fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    const initial = indexSpendFile(undefined, file, 'w', reducer, 1, {
      maxMilliseconds: Infinity,
    }).record;
    saveSpendLedger(folder, 'w', [initial]);
    const [restored] = loadSpendLedger(folder, 'w').files;
    assert.ok(restored);
    const lastAt = Math.max(...lines.map((line) => Date.parse((line as { timestamp: string }).timestamp)));
    lines.push(
      {
        type: 'user',
        uuid: 'following-prompt',
        timestamp: new Date(lastAt + 1000).toISOString(),
        message: { role: 'user', content: 'Continue.' },
      },
      {
        type: 'assistant',
        uuid: 'following-response',
        timestamp: new Date(lastAt + 2000).toISOString(),
        message: {
          id: 'following-response',
          model: COLD_ROW.model,
          content: [{ type: 'text', text: 'Complete.' }],
          usage: { input_tokens: 2000, cache_read_input_tokens: 18825, output_tokens: 30 },
        },
      },
    );
    fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    const resumed = indexSpendFile(restored, file, 'w', reducer, 2, {
      maxMilliseconds: Infinity,
    }).record;
    const whole = indexSpendFile(undefined, file, 'w', reducer, 2, {
      maxMilliseconds: Infinity,
    }).record;
    assert.deepEqual(resumed.lifetimeBuckets, whole.lifetimeBuckets);
    const estimates = resumed.lifetimeBuckets!.filter((bucket) => bucket.compactionEstimate);
    assert.equal(
      estimates.reduce((sum, bucket) => sum + bucket.requests, 0),
      1,
    );
    assert.equal(estimates[0].usage.cacheRead, 0);
    assert.equal(estimates[0].usage.cacheWrite1h, 18825);
    const [compaction] = readSession(file, 'session').compactions;
    assert.equal(compaction.postCompactionCacheRead, 18825);
    const dollars = publicProjectSpendPrice(estimates[0])!.dollars;
    assert.equal(
      toCompactionCard(compaction).chips.find((chip) => chip.metric === 'cost')?.label,
      `$${dollars.toFixed(2)}`,
    );
  });
