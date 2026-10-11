import { sessionCostProjection, sessionCostUsageOf } from './turncard';
import { revisionOf } from './transcript';
// extension/src/codex.test.ts
import { test, vi } from 'vitest';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EXPORT_LIMITS, ExportLimitError } from './exportlimits.ts';
import { RepositoryCommits, nodeGitRunner } from './gitcommits.ts';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tempDir } from './temproot.ts';
import type { BackwardRangeReader, TurnAgent } from './transcript.ts';
import type { CodexSubagentFile } from './codex.ts';
import { childFileTotals } from './childartifacts.ts';
import { AgentSpendCache, childSpendRevisionKey, readChildSpend, spendFileVersion } from './agentspend.ts';
import {
  STEP_CUT,
  STEP_DETAIL_LIMIT,
  TURN_ASK_LIMIT,
  TURN_STEP_LIMIT,
  normalizeFsPath,
  sessionStatFactsOf,
  shortenTo,
  worktreeRelationships,
} from './transcript.ts';
import {
  CODEX_STAT_REVALIDATE_MS,
  CODEX_USAGE_ASSOCIATION_LIMIT,
  CodexMetaCache,
  coldOpeningPass,
  CodexStatCache,
  readCodexAgentSpend,
  codexAgentSpendReader,
  codexAgentSpendVersion,
  codexSpendIndex,
  readCodexDispatchedSpend,
  scanForCodexPerson,
  readCodexSession,
  readCodexOpening,
  readCodexSessionActivity,
  readCodexSessionMeta,
  readCodexSessionMetaAsync,
  readCodexSessionTitle,
  readCodexSessionTitlePair,
  REFUSED_OPENING_FIRST_RETRY_MS,
  REFUSED_OPENING_RETRY_MS,
  rolloutFiles,
  codexSessionFiles,
  codexSessionsRoot,
  codexSessionIndexPath,
  codexSubagentFor,
  codexTitleFor,
  parseThreadNames,
  readThreadNames,
  codexPrompt,
  hunksFromUnifiedDiff,
  scriptFailure,
  errorMessage,
  mayHaveUnrecordedEdits,
  staleMetas,
  readCodexTurnStarts,
  emptyCodexUsageReducerState,
  reduceCodexUsageRecord,
  createCodexUsageLineReducer,
  createCodexSessionReducer,
  discoverCodexNewestTurn,
  claudeCommandResult,
  scanCodexDispatchReferences,
  scanCodexDispatchReferencesAsync,
  codexDispatchCursor,
  codexDispatchRecord,
  refreshCodexStructuralAgents,
  structuralAgentStatus,
} from './codex.ts';
import {
  readCodexHistoryPage,
  readCodexHistoryPageAsync,
  readCodexSessionIncremental,
  readCodexSessionIncrementalAsync,
  type CodexForwardCheckpoint,
  createCommitRepositoryCursor,
  scanCommitRepositorySource,
  commitRepositoryTargets,
  commitRepositoryOccurrence,
  type CommitRepositorySource,
} from './codexhistory.ts';
import { afterHistoryPage, historyRecordsOutside, startSessionHistory } from './historypages.ts';
import {
  powershellDispatchCommand,
  powershellDispatchExecution,
  throughStructuredClone,
  worktreeCreationCommand,
  turn as fixtureTurn,
} from './turnfixtures.ts';
import { retainedTurnLimit, turnKey } from './turnread.ts';
import {
  currentContextOf,
  composerRuntimeBySession,
  costDetail,
  countedDispatchedCosts,
  logOf,
  nextTurnBasisOf,
  statusOf,
  toCompactionCard,
  TURN_QUIET_MS,
  priceDispatchedParts,
  turnCost,
  toCard,
} from './turncard.ts';
import { formatWhen } from './turnformat.ts';
import { agentRunAnswer, railCacheMarkOf } from './turnrail.ts';
import { resumeCommand } from './domain/resume.ts';
import {
  PROJECT_SPEND_PARSER_GENERATION,
  aggregateUsageEvents,
  indexSpendFile,
  loadSpendLedger,
  publicProjectSpendPrice,
  discoverCodexSessionSpendSources,
  sessionSpendPartsBySession,
  saveSpendLedger,
} from './projectspend.ts';
import { RETAINED_COMPACTIONS } from './parserstate.ts';
import { estimateCodexContext, inspectCodexContext, readCodexContext, CODEX_CONTEXT_ITEMS } from './codexcontext.ts';
import { bedrockAstraRecords, codexContextRecords } from './turnfixtures.ts';
import { emptyCodexResponseClock, reduceCodexResponseClock } from './outputrate';

test('native Codex speed excludes serial and parallel tool waits without subtracting overlapping generation', () => {
  for (const toolWait of [1000, 1000000]) {
    const state = emptyCodexResponseClock();
    const owner = { sessionId: 'main', turnId: 'turn', model: 'gpt-6.1-sol', eligible: true };
    const push = (kind: string, at: number, payload: Record<string, unknown> = {}) =>
      reduceCodexResponseClock(state, { kind, at, payload }, owner);
    const usageRecord = (id: string) => ({
      thread_id: 'main',
      turn_id: 'turn',
      response_id: id,
      usage: { output_tokens: 84, reasoning_output_tokens: 40 },
    });
    push('task_started', 1);
    push('function_call', 500, { call_id: 'parallel-a' });
    push('custom_tool_call', 600, { call_id: 'parallel-b' });
    assert.equal(push('token_usage_record', 1000, usageRecord('first')), null);
    push('function_call_output', 1000 + toolWait / 2, { call_id: 'parallel-a' });
    push('custom_tool_call_output', 1000 + toolWait, { call_id: 'parallel-b' });
    // This call overlaps the next generation. Its output precedes that response's native completion.
    push('function_call', 2000 + toolWait, { call_id: 'overlap' });
    push('function_call_output', 3000 + toolWait, { call_id: 'overlap' });
    assert.deepEqual(push('token_usage_record', 11000 + toolWait, usageRecord('second')), {
      output: 84,
      milliseconds: 10000,
    });
    assert.equal(push('token_usage_record', 50000 + toolWait, usageRecord('second')), null);
    assert.deepEqual(push('token_usage_record', 21000 + toolWait, usageRecord('third')), {
      output: 84,
      milliseconds: 10000,
    });
  }
});

test('native Codex speed rejects contaminated or unproved response boundaries', () => {
  for (const reason of [
    'steering',
    'compaction',
    'model',
    'foreign',
    'replay',
    'missing',
    'negative',
    'unfinished',
    'aborted',
  ]) {
    const state = emptyCodexResponseClock();
    const owner = { sessionId: 'main', turnId: 'turn', model: 'gpt-6.1-sol', eligible: true };
    const push = (kind: string, at: number, payload: Record<string, unknown> = {}) =>
      reduceCodexResponseClock(state, { kind, at, payload }, owner);
    const payload = {
      thread_id: 'main',
      turn_id: 'turn',
      response_id: 'one',
      usage: { output_tokens: 84, reasoning_output_tokens: 40 },
    };
    push('task_started', 1);
    push('token_usage_record', 1000, payload);
    if (reason === 'steering') push('user_message', 5000);
    if (reason === 'compaction') push('compacted', 5000);
    if (reason === 'aborted') push('turn_aborted', 5000);
    if (reason === 'model') owner.model = 'gpt-6-astra';
    if (reason === 'replay') owner.eligible = false;
    if (reason === 'unfinished') {
      state.blocking.push('still-running');
    }
    const current = {
      ...payload,
      response_id: 'two',
      ...(reason === 'foreign' ? { thread_id: 'child' } : {}),
      ...(reason === 'missing' ? { usage: {} } : {}),
    };
    assert.equal(push('token_usage_record', reason === 'negative' ? 900 : 11000, current), null, reason);
  }
});

test('native Codex speed survives incremental append and rebuild with exact output usage', () => {
  const thread = '01a032c9-1a92-7931-845c-723117d24dbe';
  const native = (second: number, id: string, output: number) => ({
    type: 'token_usage_record',
    timestamp: at(second),
    payload: {
      thread_id: thread,
      session_id: thread,
      turn_id: TURN,
      response_id: id,
      usage: usage({ output_tokens: output, reasoning_output_tokens: 40, total_tokens: output }),
    },
  });
  const records = [
    meta(),
    event('task_started', 1, { turn_id: TURN }),
    turnContext(2, TURN, 'gpt-6.1-sol', 'high'),
    event('user_message', 3, { message: 'work' }),
    item('function_call', 4, { call_id: 'blocking', name: 'shell_command', arguments: '{}' }),
    native(5, 'first', 84),
  ];
  const file = writeRollout(records);
  const initial = readCodexSessionIncremental(file, thread);
  assert.ok(initial.checkpoint);
  assert.equal(initial.read?.turns[0].outputRate, undefined);
  const append = [
    item('function_call_output', 25, { call_id: 'blocking', output: 'finished' }),
    native(35, 'second', 168),
    native(36, 'second', 168),
    tokens(40, { input_tokens: 1000, output_tokens: 168, reasoning_output_tokens: 40 }),
    event('task_complete', 41, { turn_id: TURN, last_agent_message: 'done' }),
  ];
  fs.appendFileSync(file, append.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const resumed = readCodexSessionIncremental(file, thread, throughStructuredClone(initial.checkpoint));
  const full = readCodexSession(file, thread);
  assert.deepEqual(resumed.read?.turns, full.turns);
  assert.deepEqual(full.turns[0].outputRate, { output: 168, milliseconds: 10000 });
  assert.equal(full.turns[0].outputRateModel, 'gpt-6.1-sol');
  const legacy = throughStructuredClone(initial.checkpoint);
  legacy.parserState.responseClock.rates = [{ output: 10, milliseconds: 1000, responseId: 'legacy' }];
  const legacyRead = readCodexSessionIncremental(file, thread, legacy).read!;
  assert.deepEqual(legacyRead.turns[0].outputRate, { output: 178, milliseconds: 11000 });
  assert.equal(legacyRead.turns[0].outputRateModel, undefined);
  const truncated = writeRollout([
    meta(),
    native(35, 'second', 168),
    tokens(40, { input_tokens: 1000, output_tokens: 168 }),
  ]);
  assert.ok(readCodexSession(truncated, thread).turns.every((turn) => !turn.outputRate));
});

test('Codex child measurement sums native intervals and retains only direct measured identity', () => {
  const records = (id: string, parent: string, model: string): object[] => {
    const native = (second: number, turnId: string, response: string, output: number) => ({
      type: 'token_usage_record',
      timestamp: at(second),
      payload: {
        thread_id: id,
        turn_id: turnId,
        response_id: response,
        usage: usage({
          input_tokens: model === 'gpt-6-astra' ? 100000 : 1000,
          output_tokens: output,
          total_tokens: output,
        }),
      },
    });
    return [
      meta({
        id,
        session_id: id,
        model_provider: 'openai',
        source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: `/root/${id}` } } },
      }),
      event('task_started', 1, { turn_id: 'one' }),
      turnContext(2, 'one', model, 'high'),
      event('user_message', 3, { message: 'work' }),
      native(5, 'one', 'first', 10),
      native(15, 'one', 'second', 84),
      tokens(15.5, { input_tokens: model === 'gpt-6-astra' ? 100000 : 1000, output_tokens: 94 }),
      event('task_complete', 16, { turn_id: 'one', last_agent_message: 'done' }),
      event('task_started', 20, { turn_id: 'two' }),
      turnContext(21, 'two', model, 'high'),
      event('user_message', 22, { message: 'resume' }),
      native(25, 'two', 'first-resumed', 10),
      native(45, 'two', 'second-resumed', 336),
      tokens(45.5, { input_tokens: model === 'gpt-6-astra' ? 100000 : 1000, output_tokens: 346 }),
      event('task_complete', 46, { turn_id: 'two', last_agent_message: 'done' }),
    ];
  };
  const childFile = writeRollout(records('child', 'root', 'gpt-6.1-sol'));
  const grandchildFile = writeRollout(records('grandchild', 'child', 'gpt-6-astra'));
  const entry = (file: string, threadId: string, parentThreadId: string): CodexSubagentFile => ({
    file,
    threadId,
    parentThreadId,
    agentPath: `/root/${threadId}`,
    openedAt: ms(4),
    startedAt: ms(4),
    threadSource: 'subagent',
    backgroundReview: false,
  });
  const catalog = [entry(childFile, 'child', 'root'), entry(grandchildFile, 'grandchild', 'child')];
  const own = readCodexAgentSpend(childFile);
  assert.deepEqual(own.outputRate, { output: 420, milliseconds: 30000 });
  assert.equal(own.outputRateModel, 'gpt-6.1-sol');
  const aggregate = readCodexAgentSpend(childFile, catalog);
  assert.deepEqual(aggregate.outputRate, own.outputRate);
  assert.equal(aggregate.outputRateModel, own.outputRateModel);
  assert.ok(aggregate.models.some((part) => part.model === 'gpt-6-astra'));
  const parentRecords = [
    meta({ id: 'root', session_id: 'root' }),
    event('task_started', 1, { turn_id: 'root-turn' }),
    turnContext(2, 'root-turn', 'gpt-6.1-sol', 'high'),
    event('user_message', 3, { message: 'work' }),
    event('task_complete', 50, { turn_id: 'root-turn', last_agent_message: 'done' }),
  ];
  const lookup = codexAgentSpendReader(codexSpendIndex(catalog));
  const parent = readCodexSession(writeRollout(parentRecords), 'root', {
    structuralChildren: catalog,
    agentSpendOf: (ref) => lookup(ref.id === 'child' ? childFile : grandchildFile),
  });
  assert.deepEqual(parent.turns[0].agents[0].outputRate, own.outputRate);
  assert.equal(structuredClone(parent.turns)[0].agents[0].outputRateModel, own.outputRateModel);
  assert.equal(parent.turns[0].outputRate, undefined);
  refreshCodexStructuralAgents(parent.turns, 'root', catalog, () => ({
    models: [],
    found: true,
    partial: true,
    effort: null,
  }));
  assert.equal(parent.turns[0].agents[0].outputRate, undefined);
  assert.equal(parent.turns[0].agents[0].outputRateModel, undefined);
  const mixed = records('child', 'root', 'gpt-6.1-sol');
  mixed[9] = turnContext(21, 'two', 'gpt-6-astra', 'high');
  assert.equal(readCodexAgentSpend(writeRollout(mixed)).outputRate, undefined);
  const aborted = records('child', 'root', 'gpt-6.1-sol');
  aborted[7] = event('turn_aborted', 16, { turn_id: 'one' });
  assert.deepEqual(readCodexAgentSpend(writeRollout(aborted)).outputRate, { output: 336, milliseconds: 20000 });
});

test('native Codex model transition clears prior measurement and qualifies only later intervals', () => {
  const thread = '01a032c9-1a92-7931-845c-723117d24dbe';
  const native = (second: number, id: string, output: number) => ({
    type: 'token_usage_record',
    timestamp: at(second),
    payload: { thread_id: thread, turn_id: TURN, response_id: id, usage: usage({ output_tokens: output }) },
  });
  const file = writeRollout([
    meta(),
    event('task_started', 1, { turn_id: TURN }),
    turnContext(2, TURN, 'gpt-6.1-sol', 'high'),
    event('user_message', 3, { message: 'work' }),
    native(5, 'sol-first', 10),
    native(15, 'sol-second', 84),
  ]);
  const initial = readCodexSessionIncremental(file, thread);
  assert.ok(initial.checkpoint);
  assert.deepEqual(initial.read?.turns[0].outputRate, { output: 84, milliseconds: 10000 });
  assert.equal(initial.read?.turns[0].outputRateModel, 'gpt-6.1-sol');
  fs.appendFileSync(file, JSON.stringify(turnContext(20, TURN, 'gpt-6-astra', 'high')) + '\n');
  const changed = readCodexSessionIncremental(file, thread, throughStructuredClone(initial.checkpoint));
  assert.ok(changed.checkpoint);
  assert.equal(changed.read?.turns[0].outputRate, undefined);
  assert.equal(changed.read?.turns[0].outputRateModel, undefined);
  const suffix = [
    native(25, 'astra-first', 10),
    native(45, 'astra-second', 336),
    event('task_complete', 46, { turn_id: TURN, last_agent_message: 'done' }),
  ];
  fs.appendFileSync(file, suffix.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const full = readCodexSession(file, thread);
  assert.deepEqual(full.turns[0].outputRate, { output: 336, milliseconds: 20000 });
  assert.equal(full.turns[0].outputRateModel, 'gpt-6-astra');
  assert.deepEqual(
    readCodexSessionIncremental(file, thread, throughStructuredClone(changed.checkpoint)).read?.turns,
    full.turns,
  );
  const child = readCodexAgentSpend(file);
  assert.deepEqual(child.outputRate, full.turns[0].outputRate);
  assert.equal(child.outputRateModel, full.turns[0].outputRateModel);
});

test('native Codex speed retracts later classified compaction across append and cloned snapshots', () => {
  for (const hasWorkRate of [false, true]) {
    const thread = '01a032c9-1a92-7931-845c-723117d24dbe';
    const native = (second: number, id: string, output: number) => ({
      type: 'token_usage_record',
      timestamp: at(second),
      payload: {
        thread_id: thread,
        turn_id: TURN,
        response_id: id,
        usage: usage({ output_tokens: output, reasoning_output_tokens: 40, total_tokens: output }),
      },
    });
    const records = [
      meta(),
      event('task_started', 1, { turn_id: TURN }),
      turnContext(2, TURN, 'gpt-6.1-sol', 'high'),
      event('user_message', 3, { message: 'work' }),
      native(5, 'first', 84),
    ];
    if (hasWorkRate) records.push(native(15, 'work', 168));
    records.push(
      tokens(hasWorkRate ? 16 : 6, {
        input_tokens: 1000,
        output_tokens: hasWorkRate ? 252 : 84,
        reasoning_output_tokens: 40,
      }),
      native(25, 'compaction', 840),
    );
    const file = writeRollout(records);
    const provisional = readCodexSessionIncremental(file, thread);
    assert.ok(provisional.checkpoint);
    assert.ok(provisional.read?.turns[0].outputRate);
    assert.equal(provisional.read?.turns[0].outputRateModel, 'gpt-6.1-sol');
    const clone = throughStructuredClone(provisional.checkpoint);
    const suffix = [
      {
        timestamp: at(26),
        type: 'compacted',
        payload: {
          compaction_response_id: 'compaction',
          latest_token_usage_record: {
            usage: usage({ output_tokens: 840, reasoning_output_tokens: 40, total_tokens: 840 }),
          },
          replacement_history: [],
        },
      },
      event('task_complete', 27, { turn_id: TURN }),
    ];
    fs.appendFileSync(file, suffix.map((row) => JSON.stringify(row)).join('\n') + '\n');
    const full = readCodexSession(file, thread);
    const expected = hasWorkRate ? { output: 168, milliseconds: 10000 } : undefined;
    assert.deepEqual(full.turns[0].outputRate, expected);
    assert.equal(full.turns[0].outputRateModel, hasWorkRate ? 'gpt-6.1-sol' : undefined);
    const child = readCodexAgentSpend(file);
    assert.deepEqual(child.outputRate, expected);
    assert.equal(child.outputRateModel, hasWorkRate ? 'gpt-6.1-sol' : undefined);
    assert.equal(
      toCard(full.turns[0], false, Date.parse(at(28)))
        .chips.find((chip) => chip.metric === 'tokens')
        ?.detailList?.entries.some(
          (row) =>
            row.label === 'Output' &&
            row.lines?.some((line) => typeof line === 'object' && 'text' in line && line.text.includes('tok/s')),
        ),
      hasWorkRate,
    );
    for (const checkpoint of [provisional.checkpoint, clone]) {
      const resumed = readCodexSessionIncremental(file, thread, checkpoint);
      assert.deepEqual(resumed.read?.turns, full.turns);
    }
  }
});

test('Codex active context explains pending tools and unmeasured results until a new complete measurement', async () => {
  for (const compacted of [false, true]) {
    const records = codexContextRecords('s1', compacted);
    const previous = structuredClone(records.at(-1)!);
    const file = writeRollout(records);
    const read = async () => {
      fs.writeFileSync(file, records.map((row) => JSON.stringify(row)).join('\n') + '\n');
      return readCodexContext(
        file,
        's1',
        revisionOf(fs.statSync(file, { bigint: true })),
        new AbortController().signal,
      );
    };
    assert.equal((await read())?.kind, 'codex-retained-context');
    records.push({
      type: 'response_item',
      payload: { type: 'function_call', call_id: 'pending', name: 'read', arguments: '{}' },
    });
    assert.deepEqual(await read(), {
      kind: 'codex-context-unavailable',
      session: 's1',
      model: 'gpt-6.1-sol',
      reason: 'pending-tools',
    });
    assert.equal(estimateCodexContext(records, 's1'), null);
    records.push({
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'pending', output: 'new result' },
    });
    assert.equal((await read())?.kind, 'codex-context-unavailable');
    assert.deepEqual(inspectCodexContext(records, 's1'), {
      kind: 'codex-context-unavailable',
      session: 's1',
      model: 'gpt-6.1-sol',
      reason: 'awaiting-measurement',
    });
    records.push(previous);
    assert.equal(estimateCodexContext(records, 's1'), null);
    assert.equal((await read())?.kind, 'codex-context-unavailable');
    const next = structuredClone(previous);
    next.payload.info.last_token_usage.input_tokens += 50;
    records.push(next);
    const restored = await read();
    assert.ok(restored?.kind === 'codex-retained-context');
    assert.equal(restored.used, 10_150);
    assert.ok(restored.categories.some((row) => row.name === 'Tool calls'));
    for (const invalid of [
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'orphan', output: 'result' } },
      { type: 'response_item', payload: { type: 'configuration_update' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [null] } },
      { type: 'turn_context', payload: { model: 'different' } },
      { type: 'session_meta', payload: { id: 'foreign' } },
      { type: 'event_msg', payload: { type: 'thread_rolled_back' } },
    ])
      assert.equal(inspectCodexContext([...records, invalid], 's1'), null);
  }
});

test('Codex interrupted context stops reporting unanswered calls as pending and recovers with complete retained history', async () => {
  for (const compacted of [false, true]) {
    const records = codexContextRecords('s1', compacted);
    const previous = structuredClone(records.at(-1)!);
    const file = writeRollout(records);
    const read = async () => {
      fs.writeFileSync(file, records.map((row) => JSON.stringify(row)).join('\n') + '\n');
      return readCodexContext(
        file,
        's1',
        revisionOf(fs.statSync(file, { bigint: true })),
        new AbortController().signal,
      );
    };
    assert.equal((await read())?.kind, 'codex-retained-context');
    records.push({
      type: 'response_item',
      payload: { type: 'function_call', call_id: 'interrupted', name: 'read', arguments: '{}' },
    });
    assert.deepEqual(await read(), {
      kind: 'codex-context-unavailable',
      session: 's1',
      model: 'gpt-6.1-sol',
      reason: 'pending-tools',
    });
    records.push({
      type: 'event_msg',
      payload: { type: 'turn_aborted', turn_id: 'context-turn', reason: 'interrupted' },
    });
    assert.equal(await read(), null);
    const closed = readCodexSession(file, 's1');
    assert.equal(closed.turns.at(-1)?.interrupted, true);
    const reducer = createCodexSessionReducer('s1');
    for (const record of records) reducer.pushLine(JSON.stringify(record));
    assert.equal(reducer.openRange(), null);
    const next = structuredClone(previous);
    next.payload.info.last_token_usage.input_tokens += 50;
    records.push(next);
    assert.equal(await read(), null);
    records.push({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'resumed' } });
    records.push(...codexContextRecords('s1', true).filter((row) => row.type === 'compacted'));
    records.push({ type: 'turn_context', payload: { turn_id: 'resumed', model: 'gpt-6.1-sol' } });
    records.push(next);
    const restored = await read();
    assert.ok(restored?.kind === 'codex-retained-context');
    assert.equal(restored.used, 10_150);
    records.push({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'resumed', reason: 'interrupted' } });
    records.push({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'next' } });
    records.push({
      type: 'response_item',
      payload: { type: 'function_call', call_id: 'resumed', name: 'read', arguments: '{}' },
    });
    assert.deepEqual(await read(), {
      kind: 'codex-context-unavailable',
      session: 's1',
      model: 'gpt-6.1-sol',
      reason: 'pending-tools',
    });
    records.push({
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'resumed', output: 'new result' },
    });
    assert.deepEqual(await read(), {
      kind: 'codex-context-unavailable',
      session: 's1',
      model: 'gpt-6.1-sol',
      reason: 'awaiting-measurement',
    });
    const complete = structuredClone(next);
    complete.payload.info.last_token_usage.input_tokens += 50;
    records.push(complete);
    assert.equal((await read())?.kind, 'codex-retained-context');
  }
});

test('Codex categories use retained ordinary and compacted histories without lifetime or cached-input duplication', async () => {
  const ordinary = estimateCodexContext(codexContextRecords(), 's1')!;
  const compacted = estimateCodexContext(codexContextRecords('s1', true), 's1')!;
  assert.deepEqual(
    compacted.categories.filter((row) => row.name !== 'Tool results' && row.name !== 'Unattributed context'),
    ordinary.categories.filter((row) => row.name !== 'Unattributed context'),
  );
  const resumed = codexContextRecords('s1', true).filter((row) => row.type !== 'turn_context');
  resumed.find((row) => row.type === 'compacted')!.payload.resume_metadata = {
    previous_turn_settings: { model: 'gpt-6.1-sol' },
  };
  assert.deepEqual(estimateCodexContext(resumed, 's1')?.categories, compacted.categories);
  assert.equal(ordinary.used, 10_100);
  assert.equal(
    ordinary.categories.reduce((sum, row) => sum + row.tokens, 0),
    ordinary.used,
  );
  assert.ok(ordinary.categories.some((row) => row.name === 'Messages'));
  assert.ok(ordinary.categories.some((row) => row.name === 'Instructions'));
  assert.ok(ordinary.categories.some((row) => row.name === 'Tool calls'));
  assert.ok(ordinary.categories.some((row) => row.name === 'Unattributed context'));
  const tmp = tempDir('codex-context');
  const file = path.join(tmp, 'rollout.jsonl');
  fs.writeFileSync(
    file,
    codexContextRecords('s1', true)
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  );
  const stat = revisionOf(fs.statSync(file, { bigint: true }));
  const revision = { size: stat.size, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino };
  assert.deepEqual(await readCodexContext(file, 's1', revision, new AbortController().signal), compacted);
  assert.equal(await readCodexContext(file, 'other', revision, new AbortController().signal), null);
  assert.equal(
    await readCodexContext(file, 's1', { ...revision, size: revision.size + 1 }, new AbortController().signal),
    null,
  );
  assert.equal(await readCodexContext(file, 's1', revision, AbortSignal.abort()), null);
  fs.appendFileSync(file, '{"type":"response_item"');
  assert.equal(
    await readCodexContext(file, 's1', { ...revision, size: fs.statSync(file).size }, new AbortController().signal),
    null,
  );
  const saved = codexContextRecords().map((row) => JSON.stringify(row));
  const record = JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', detail: 'x'.repeat(60_000) } });
  for (const suffix of [
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', detail: 'x'.repeat(600_000) } }),
    (record + '\n').repeat(300),
    '{"type":"event_msg","payload":{"type":"task_complete"}}\n'.repeat(20_001),
  ]) {
    fs.writeFileSync(file, saved.join('\n') + '\n' + suffix + '\n');
    const bounded = revisionOf(fs.statSync(file, { bigint: true }));
    assert.equal(await readCodexContext(file, 's1', bounded, new AbortController().signal), null);
  }
});

test('Codex attributes checkpoint tool text while leaving ordinary and opaque results unattributed', () => {
  const records = codexContextRecords('s1', true);
  const checkpoint = records.find((row) => row.type === 'compacted')!.payload.replacement_history;
  checkpoint.find((item: any) => item.type === 'function_call_output').output = [
    { type: 'input_text', text: 'abcd'.repeat(10) },
    { type: 'encrypted_content', encrypted_content: 'opaque'.repeat(100) },
    { type: 'input_image', image_url: 'opaque' },
  ];
  checkpoint.push(
    { type: 'custom_tool_call', call_id: 'custom', name: 'custom', input: 'abcd' },
    { type: 'custom_tool_call_output', call_id: 'custom', output: 'abcd'.repeat(20) },
  );
  const usage = records.pop()!;
  records.push(
    { type: 'response_item', payload: { type: 'function_call', call_id: 'later', name: 'exec', arguments: 'abcd' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'later', output: 'abcd'.repeat(1000) } },
    usage,
  );
  const result = estimateCodexContext(records, 's1')!;
  assert.equal(result.categories.find((row) => row.name === 'Tool results')?.tokens, 30);
  assert.equal(
    result.categories.reduce((sum, row) => sum + row.tokens, 0),
    result.used,
  );
  const smaller = structuredClone(records);
  smaller.at(-1)!.payload.info.last_token_usage = { input_tokens: 1, output_tokens: 0 };
  const mismatch = estimateCodexContext(smaller, 's1')!;
  assert.ok(mismatch.categories.reduce((sum, row) => sum + row.tokens, 0) > mismatch.used);
  assert.equal(
    mismatch.categories.some((row) => row.name === 'Unattributed context'),
    false,
  );
  const ordinary = estimateCodexContext(codexContextRecords(), 's1')!;
  assert.equal(
    ordinary.categories.some((row) => row.name === 'Tool results'),
    false,
  );
  const latest = {
    type: 'compacted',
    payload: {
      window_number: 3,
      replacement_history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'abcd' }] }],
    },
  };
  assert.equal(
    estimateCodexContext([...records, latest, usage], 's1')!.categories.some((row) => row.name === 'Tool results'),
    false,
  );
});

test('Codex context refuses unmeasured inputs, rollback, malformed boundaries, and incomplete histories', () => {
  for (const extra of [
    { type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 } },
    {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'new input' }] },
    },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'new', output: 'new output' } },
    { type: 'compacted', payload: { message: 'summary' } },
    { type: 'unknown_mutation', payload: {} },
    { type: 'turn_context', payload: { model: 'other-model' } },
    { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'other-model' } } },
  ])
    assert.equal(estimateCodexContext([...codexContextRecords(), extra], 's1'), null);
  const orphan = codexContextRecords().filter((row) => row.payload.type !== 'function_call');
  assert.equal(estimateCodexContext(orphan, 's1'), null);
  const noUsage = codexContextRecords().filter((row) => row.type !== 'event_msg');
  assert.equal(estimateCodexContext(noUsage, 's1'), null);
  const bounded = codexContextRecords();
  bounded.splice(
    1,
    0,
    ...Array.from({ length: CODEX_CONTEXT_ITEMS }, () => ({ type: 'response_item', payload: { type: 'reasoning' } })),
  );
  assert.equal(estimateCodexContext(bounded, 's1'), null);
  const fork = codexContextRecords('fork');
  fork[0].payload.forked_from_id = 'parent';
  assert.deepEqual(
    estimateCodexContext(fork, 'fork')?.categories,
    estimateCodexContext(codexContextRecords(), 's1')?.categories,
  );
  const tooSmall = codexContextRecords();
  tooSmall.at(-1)!.payload.info.last_token_usage.input_tokens = 1;
  assert.ok(estimateCodexContext(tooSmall, 's1')!.categories.reduce((sum, row) => sum + row.tokens, 0) > 101);
});

test('Codex context validates tool families and client search pairs while retaining server outputs', () => {
  const estimate = (items: Record<string, unknown>[]) => {
    const records = codexContextRecords();
    records.splice(-1, 0, ...items.map((payload) => ({ type: 'response_item', payload })));
    return estimateCodexContext(records, 's1');
  };
  const call = { type: 'function_call', call_id: 'same', name: 'read', arguments: '{}' };
  const custom = { type: 'custom_tool_call', call_id: 'same', name: 'read', input: '{}' };
  const search = { type: 'tool_search_call', call_id: 'same', execution: 'client', arguments: {} };
  const output = { type: 'function_call_output', call_id: 'same', output: 'result' };
  const customOutput = { ...output, type: 'custom_tool_call_output' };
  const searchOutput = { type: 'tool_search_output', call_id: 'same', execution: 'client', tools: [] };
  for (const items of [
    [call, customOutput],
    [custom, output],
    [call, searchOutput],
    [search, output],
    [searchOutput],
    [search],
    [call, custom, output],
    [custom, call, customOutput],
    [{ type: 'local_shell_call', call_id: 'same' }, customOutput],
    [{ ...searchOutput, call_id: null }],
  ])
    assert.equal(estimate(items), null, JSON.stringify(items));
  for (const items of [
    [call, output, custom, customOutput, search, searchOutput],
    [{ type: 'local_shell_call', call_id: 'same' }, output],
    [{ ...searchOutput, execution: 'server' }],
    [{ ...searchOutput, execution: 'server', call_id: null }],
  ])
    assert.ok(estimate(items), JSON.stringify(items));
});

test('Codex context retains copied fork ancestry and refuses unrelated metadata or a foreign physical opening', async () => {
  const parent = codexContextRecords('parent');
  parent[0].payload.forked_from_id = 'grandparent';
  const fork = [
    { type: 'session_meta', payload: { id: 'fork', forked_from_id: 'parent' } },
    parent[0],
    { type: 'session_meta', payload: { id: 'grandparent' } },
    ...parent.slice(1),
  ];
  const expected = estimateCodexContext(codexContextRecords(), 's1')!.categories;
  assert.deepEqual(estimateCodexContext(fork, 'fork')?.categories, expected);
  for (const metadata of [
    { id: 'unrelated' },
    { id: 'fork' },
    { id: 'parent' },
    { id: 'grandparent', forked_from_id: 4 },
  ]) {
    const changed = structuredClone(fork);
    changed[2].payload = metadata;
    assert.equal(estimateCodexContext(changed, 'fork'), null);
  }
  assert.equal(estimateCodexContext([{ ...fork[0], payload: { id: 'fork' } }, ...fork.slice(1)], 'fork'), null);
  assert.equal(
    estimateCodexContext([...codexContextRecords(), { type: 'session_meta', payload: { id: null } }], 's1'),
    null,
  );
  const file = writeRollout(fork);
  const stat = revisionOf(fs.statSync(file, { bigint: true }));
  const revision = { size: stat.size, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino };
  assert.deepEqual(await readCodexContext(file, 'fork', revision, new AbortController().signal), {
    ...estimateCodexContext(fork, 'fork')!,
    categories: expected,
  });
  assert.equal(await readCodexContext(file, 'parent', revision, new AbortController().signal), null);
});

test('Codex post-compaction estimates remain separate from billed usage and repeated snapshots cannot refresh later input', () => {
  const records = codexContextRecords('s1', true);
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 10_100,
  };
  records.at(-1)!.payload.info.last_token_usage = usage;
  const estimate = estimateCodexContext(records, 's1')!;
  assert.equal(estimate.used, 10_100);
  assert.equal(estimate.basis, 'retained-estimate');
  const saved = readCodexSession(writeRollout(records), 's1');
  assert.equal(saved.turns[0].contextTokens, 10_100);
  assert.equal(saved.turns[0].contextWindow, 20_000);
  assert.equal(saved.turns[0].usage.requests, 0);
  assert.equal(saved.turns[0].usage.input, 0);
  assert.equal(saved.turns[0].contextRequest, undefined);
  assert.equal(saved.compactions[0].contextAfter, 0);
  assert.deepEqual(saved.compactions[0].retainedContext, { tokens: 10_100, window: 20_000 });
  const closed = codexContextRecords();
  closed.push(
    {
      type: 'event_msg',
      timestamp: '2026-01-01T00:00:30Z',
      payload: { type: 'task_complete', turn_id: 'context-turn' },
    },
    { ...records.find((row) => row.type === 'compacted')!, timestamp: '2026-01-01T00:00:31Z' },
    { ...records.at(-1)!, timestamp: '2026-01-01T00:00:32Z' },
  );
  const closedRead = readCodexSession(writeRollout(closed), 's1');
  const facts = sessionStatFactsOf(closedRead)!;
  assert.deepEqual(currentContextOf(facts.turns.at(-1)!, facts.compactions.at(-1)!), {
    tokens: 10_100,
    window: 20_000,
    afterCompaction: true,
  });
  assert.equal(closedRead.turns[0].usage.requests, 1);
  const ordinary = codexContextRecords();
  ordinary.at(-1)!.payload.info.last_token_usage = usage;
  assert.equal(estimateCodexContext(ordinary, 's1'), null);
  const repeated = codexContextRecords();
  repeated.push(
    {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'New user input' }] },
    },
    structuredClone(repeated.at(-1)!),
  );
  assert.equal(estimateCodexContext(repeated, 's1'), null);
});

const at = (second: number) => new Date(Date.UTC(2026, 7, 25, 12, 0, second)).toISOString();
const ms = (second: number) => Date.parse(at(second));

// These helpers construct rollout records. event_msg and response_item store their item types inside payloads. Other records identify their type directly.

const meta = (over: Record<string, unknown> = {}) => ({
  timestamp: at(0),
  type: 'session_meta',
  payload: {
    session_id: '01a032c9-1a92-7931-845c-723117d24dbe',
    id: '01a032c9-1a92-7931-845c-723117d24dbe',
    cwd: 'c:\\repo',
    originator: 'codex_vscode',
    cli_version: '0.146.0',
    source: 'vscode',
    thread_source: 'user',
    git: { branch: 'main', commit_hash: 'abc123def456' },
    // The metadata context_window identifies a compaction window. Numeric model context limits belong to task_started and token_count records.

    context_window: { window_id: '019f4a1b-cd5c-7390-8337-c3f7570679d0' },
    ...over,
  },
});
const event = (kind: string, second: number, over: Record<string, unknown> = {}) => ({
  timestamp: at(second),
  type: 'event_msg',
  payload: { type: kind, ...over },
});
const item = (kind: string, second: number, over: Record<string, unknown> = {}) => ({
  timestamp: at(second),
  type: 'response_item',
  payload: { type: kind, ...over },
});
const turnContext = (second: number, turnId: string, model: string, effort: string) => ({
  timestamp: at(second),
  type: 'turn_context',
  payload: { turn_id: turnId, cwd: 'c:\\repo', model, effort },
});
const usage = (over: Record<string, number> = {}) => ({
  input_tokens: 0,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
  total_tokens: 0,
  ...over,
});
const tokens = (second: number, last: Record<string, number>) =>
  event('token_count', second, {
    info: { last_token_usage: usage(last), total_token_usage: usage(last), model_context_window: 258400 },
  });
const shortPricedUsage = (counts: Record<string, unknown>) => ({
  ...counts,
  byContextBand: { short: { ...counts } },
});
const recordedAt = (record: object, timestamp: string) => ({ ...record, timestamp });
const toolOutput = (second: number, callId: string, text: string) =>
  item('custom_tool_call_output', second, { call_id: callId, output: [{ type: 'input_text', text }] });
const message = (role: string, second: number, text: string, block = 'input_text', kinds?: string[]) =>
  item('message', second, {
    role,
    content: [{ type: block, text }],
    ...(kinds ? { internal_chat_message_metadata_passthrough: { content_item_kinds: kinds } } : {}),
  });
const commandCompleted = (
  second: number,
  command: string,
  exitCode = 0,
  status = 'completed',
  id = `exec-${second}`,
  over: Record<string, unknown> = {},
) =>
  event('item_completed', second, {
    item: {
      type: 'CommandExecution',
      id,
      command: ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-Command', command],
      parsed_cmd: [{ type: 'unknown', cmd: command }],
      status,
      exit_code: exitCode,
      cwd: 'file:///C:/repo',
      ...over,
    },
  });

const CLAUDE_SESSION = '5a7b07c1-bfcf-4d96-9eb2-8ef1fb609881';
const DISPATCH_COMMAND =
  'python dispatch.py --runner claude --read-only --arc-dispatch --model claude-fable-5-1 --effort high --name arc-ui-proposal-fable';
const DISPATCH_RECEIPT = `ARC_DISPATCH_SESSION={"agent":"claude","session_id":"${CLAUDE_SESSION}","name":"arc-ui-proposal-fable"}`;

test('export dispatch scanning admits paired receipts beyond the panel record window', async () => {
  const file = writeRollout([
    meta(),
    event('task_started', 1, { turn_id: TURN }),
    turnContext(2, TURN, 'gpt-6-astra', 'high'),
    commandCompleted(3, DISPATCH_COMMAND, 0, 'completed', 'large-receipt', {
      stdout: DISPATCH_RECEIPT + '\n' + 'x'.repeat(5 * 1024 * 1024),
    }),
    event('task_complete', 4, { turn_id: TURN }),
  ]);
  const panel = scanCodexDispatchReferences(file, 'parent');
  assert.equal(panel.complete, false);
  assert.equal(panel.cursor.lostRecords, true);
  let capture = await scanCodexDispatchReferencesAsync(
    file,
    'parent',
    panel.cursor,
    256 * 1024,
    () => false,
    undefined,
    EXPORT_LIMITS,
  );
  while (!capture.traversed) {
    capture = await scanCodexDispatchReferencesAsync(
      file,
      'parent',
      capture.cursor,
      256 * 1024,
      () => false,
      undefined,
      EXPORT_LIMITS,
    );
  }
  assert.equal(capture.complete, true);
  assert.equal(capture.cursor.seenBloom, null);
  assert.deepEqual(
    capture.references.map((reference) => reference.toolUseIds),
    [['large-receipt']],
  );
});

test('dispatch evidence loss remains partial after a newline, resumption, and EOF', () => {
  const file = writeRollout([
    meta(),
    event('task_started', 1, { turn_id: TURN }),
    turnContext(2, TURN, 'gpt-6-astra', 'high'),
  ]);
  fs.appendFileSync(file, '{"type":"ignored","payload":"' + 'x'.repeat(5 * 1024 * 1024));
  let scan = scanCodexDispatchReferences(file, 'parent');
  assert.equal(scan.cursor.skipLongLine, true);
  assert.equal(scan.complete, false);
  fs.appendFileSync(
    file,
    '"}\n' +
      JSON.stringify(
        commandCompleted(3, DISPATCH_COMMAND, 0, 'completed', 'after-loss', { stdout: DISPATCH_RECEIPT }),
      ) +
      '\n',
  );
  scan = scanCodexDispatchReferences(file, 'parent', scan.cursor);
  assert.equal(scan.cursor.skipLongLine, false);
  assert.equal(scan.cursor.lostRecords, true);
  assert.equal(scan.traversed, true);
  assert.equal(scan.complete, false);
  assert.deepEqual(
    scan.references.map((reference) => reference.toolUseIds),
    [['after-loss']],
  );
  assert.equal(scanCodexDispatchReferences(file, 'parent', scan.cursor).complete, false);
});

test('exact export dispatch identities retain a native child receipt that Bloom membership rejects', () => {
  const ids = Array.from({ length: 19999 }, (_item, index) => `prior-${index}`);
  const bloom = Buffer.alloc(64 * 1024);
  const indexes = (id: string) => {
    const hash = createHash('sha256').update(id).digest();
    return [0, 4, 8, 12].map((at) => hash.readUInt32LE(at) % (bloom.length * 8));
  };
  for (const id of ids) for (const index of indexes(id)) bloom[index >> 3] |= 1 << (index & 7);
  let id = '';
  for (let index = 0; index < 100000; index++) {
    const candidate = `not-seen-${index}`;
    if (indexes(candidate).every((bit) => (bloom[bit >> 3] & (1 << (bit & 7))) !== 0)) {
      id = candidate;
      break;
    }
  }
  assert.ok(id, 'the fixture has no deterministic false-positive identity');
  assert.ok(!ids.includes(id));
  const native = meta({
    id: 'native-child',
    thread_source: 'subagent',
    parent_thread_id: 'parent',
    timestamp: at(0),
    source: { subagent: { thread_spawn: { parent_thread_id: 'parent', agent_path: '/root/helper' } } },
  });
  const records = [
    native,
    event('task_started', 1, { turn_id: id }),
    turnContext(2, id, 'gpt-6-astra', 'high'),
    commandCompleted(3, DISPATCH_COMMAND, 0, 'completed', 'native-receipt', { stdout: DISPATCH_RECEIPT }),
  ];
  const make = (exact: boolean) => {
    const cursor = codexDispatchCursor('', 0, 0, 'native-child');
    cursor.seenTurnIds = exact ? ids : [];
    cursor.seenBloom = exact ? null : bloom.toString('base64');
    if (exact) cursor.exportPolicy = EXPORT_LIMITS;
    for (const record of records) codexDispatchRecord(cursor, JSON.stringify(record), 'native-child', new Set());
    return cursor;
  };
  assert.equal(make(false).candidates.length, 0);
  const exact = make(true);
  assert.equal(exact.candidates.length, 1);
  assert.equal(exact.candidates[0].reference.sessionId, CLAUDE_SESSION);
  assert.throws(
    () =>
      codexDispatchRecord(
        exact,
        JSON.stringify(event('task_started', 5, { turn_id: 'one-too-many' })),
        'native-child',
        new Set(),
      ),
    (error) => error instanceof ExportLimitError && error.boundary === 'dispatch identities',
  );
});

test('export dispatch scanning rejects a record before decoding bytes above its admitted limit', async () => {
  const file = writeRollout([meta(), { type: 'ignored', payload: 'x'.repeat(8 * 1024 * 1024) }]);
  await assert.rejects(
    scanCodexDispatchReferencesAsync(file, 'parent', null, Infinity, () => false, undefined, EXPORT_LIMITS),
    (error) => error instanceof ExportLimitError && error.boundary === 'record',
  );
});

test('synchronous dispatch growth retains every reference before the captured size', () => {
  const file = writeRollout([
    meta(),
    event('task_started', 1, { turn_id: TURN }),
    turnContext(2, TURN, 'gpt-6-astra', 'high'),
    ...Array.from({ length: 300 }, () => ({ type: 'ignored', payload: 'x'.repeat(1024) })),
    commandCompleted(3, DISPATCH_COMMAND, 0, 'completed', 'late-launch', { stdout: DISPATCH_RECEIPT }),
  ]);
  const capturedSize = fs.statSync(file).size;
  const nativeFs = createRequire(__filename)('node:fs') as typeof fs;
  const read = nativeFs.readSync;
  let grew = false;
  nativeFs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
    const bytes = read(...args);
    if (!grew) {
      grew = true;
      fs.appendFileSync(file, '{"type":"ignored"}\n');
    }
    return bytes;
  }) as typeof fs.readSync;
  syncBuiltinESMExports();
  try {
    const scan = scanCodexDispatchReferences(file, 'parent');
    assert.equal(grew, true);
    assert.equal(scan.cursor.offset, capturedSize);
    assert.deepEqual(
      scan.references.map((reference) => reference.toolUseIds),
      [['late-launch']],
    );
  } finally {
    nativeFs.readSync = read;
    syncBuiltinESMExports();
  }
});

test('a Codex shell launch links its own stdout receipt to the launching turn across a resumed scan', () => {
  const id = 'exec-987b9951-5d03-4b9c-ab46-099b76702eaf';
  const records = [
    meta(),
    event('task_started', 1, { turn_id: TURN }),
    turnContext(2, TURN, 'gpt-6-astra', 'high'),
    ...Array.from({ length: 32 }, () => ({ type: 'ignored', payload: 'x'.repeat(1024) })),
    event('user_message', 3, { message: 'review the proposal' }),
    commandCompleted(4, DISPATCH_COMMAND, 0, 'completed', id, { stdout: DISPATCH_RECEIPT }),
    commandCompleted(5, DISPATCH_COMMAND, 0, 'completed', id, { stdout: DISPATCH_RECEIPT }),
    ...Array.from({ length: TURN_STEP_LIMIT + 5 }, (_unused, index) => [
      item('function_call', index + 6, {
        name: 'exec_command',
        call_id: `later-${index}`,
        arguments: JSON.stringify({ cmd: 'git status' }),
      }),
      item('function_call_output', index + 6, { call_id: `later-${index}`, output: 'Process exited with code 0' }),
    ]).flat(),
    event('task_complete', TURN_STEP_LIMIT + 12, { turn_id: TURN, last_agent_message: 'review complete' }),
  ];
  const file = writeRollout(records);
  const turn = readCodexSession(file, 'parent', { maxTurns: 1 }).turns[0];
  assert.deepEqual(turn.dispatchToolUseIds, [id]);
  assert.ok(turn.stepCount > TURN_STEP_LIMIT);
  assert.ok(turn.steps.every((step) => (step as { id?: string }).id !== id));
  let scan = scanCodexDispatchReferences(file, 'parent', null, 32 * 1024);
  for (let pass = 0; !scan.complete && pass < 100; pass++)
    scan = scanCodexDispatchReferences(file, 'parent', scan.cursor, 32 * 1024);
  assert.deepEqual(
    scan.references.map((reference) => [reference.sessionId, reference.toolUseIds]),
    [[CLAUDE_SESSION, [id]]],
  );
});

test('the completed PowerShell dispatch envelope retains its launch identity through bounded EOF discovery', () => {
  const timestamp = '2026-09-30T14:49:12.816Z';
  const file = writeRollout([
    recordedAt(meta(), '2026-09-30T14:49:10.000Z'),
    recordedAt(event('task_started', 1, { turn_id: TURN }), '2026-09-30T14:49:10.001Z'),
    recordedAt(turnContext(2, TURN, 'gpt-6-astra', 'high'), '2026-09-30T14:49:10.002Z'),
    recordedAt(event('user_message', 3, { message: 'review the change' }), '2026-09-30T14:49:10.003Z'),
    ...Array.from({ length: 32 }, () => ({ type: 'ignored', payload: 'x'.repeat(1024) })),
    recordedAt(
      commandCompleted(
        4,
        powershellDispatchCommand,
        0,
        'completed',
        powershellDispatchExecution.id,
        powershellDispatchExecution,
      ),
      timestamp,
    ),
  ]);
  assert.deepEqual(readCodexSession(file, 'parent').turns[0].dispatchToolUseIds, [powershellDispatchExecution.id]);
  const expected = [['3f99580e', [powershellDispatchExecution.id]]];
  const full = scanCodexDispatchReferences(file, 'parent');
  assert.equal(full.complete, true);
  assert.deepEqual(
    full.references.map((reference) => [reference.sessionId, reference.toolUseIds]),
    expected,
  );
  let scan = scanCodexDispatchReferences(file, 'parent', null, 32 * 1024);
  assert.equal(scan.complete, false);
  for (let pass = 0; !scan.complete && pass < 4; pass++)
    scan = scanCodexDispatchReferences(file, 'parent', scan.cursor, 32 * 1024);
  assert.equal(scan.complete, true);
  assert.deepEqual(
    scan.references.map((reference) => [reference.sessionId, reference.toolUseIds]),
    expected,
  );
});

test('PowerShell expression contents and comments cannot own a paired Codex stdout receipt', () => {
  for (const command of [
    'python dispatch.py --prompt (Write-Output `) --arc-dispatch | Out-String)',
    'python show_receipt.py --input (Join-Path root receipt.txt) # --arc-dispatch',
    'python show_receipt.py --input (Join-Path root receipt.txt) <# --arc-dispatch #>',
    'python show_receipt.py --input (Join-Path root receipt.txt) <# " ; python fake.py --arc-dispatch\nclaude --bg fake #>',
    'python dispatch.py --prompt (Join-Path root file) --message "hello `" ; claude --bg fake `" now"',
  ]) {
    const file = writeRollout([
      meta(),
      event('task_started', 1, { turn_id: TURN }),
      turnContext(2, TURN, 'gpt-6-astra', 'high'),
      event('user_message', 3, { message: 'read the receipt' }),
      commandCompleted(4, command, 0, 'completed', 'unowned-receipt', { stdout: DISPATCH_RECEIPT }),
    ]);
    assert.deepEqual(readCodexSession(file, 'parent').turns[0].dispatchToolUseIds ?? [], [], command);
    assert.deepEqual(scanCodexDispatchReferences(file, 'parent').references, [], command);
  }
});

test('recorded command shells control receipt ownership and unknown context rejects conflicting launches', () => {
  const first = 'python first.py --arc-dispatch';
  const command = `${first}; echo {tag}#note; python second.py --arc-dispatch`;
  const secondReceipt = DISPATCH_RECEIPT.replace(CLAUDE_SESSION, '11111111-1111-4111-8111-111111111111');
  const cases: Array<[string, Record<string, unknown>, number]> = [
    ['Bash', { command: ['/bin/bash', '-lc', command], stdout: `${DISPATCH_RECEIPT}\n${secondReceipt}` }, 2],
    ['PowerShell', { stdout: DISPATCH_RECEIPT }, 1],
    ['pwsh', { command: ['pwsh.exe', '-NoProfile', '-Command', command], stdout: DISPATCH_RECEIPT }, 1],
    ['unknown runtime', { command: ['custom-shell', '-c', command], stdout: DISPATCH_RECEIPT }, 0],
    ['raw string', { command, parsed_cmd: [], stdout: DISPATCH_RECEIPT }, 0],
    ['unrecorded shell field', { command, parsed_cmd: [], shell: 'powershell', stdout: DISPATCH_RECEIPT }, 0],
    ['different parsed command', { command: ['powershell.exe', '-Command', first], stdout: DISPATCH_RECEIPT }, 0],
    ['plain raw string', { command: first, parsed_cmd: [], stdout: DISPATCH_RECEIPT }, 1],
    [
      'unknown plain parsed command',
      { command: ['custom-shell', '-c', first], parsed_cmd: [{ cmd: first }], stdout: DISPATCH_RECEIPT },
      1,
    ],
  ];
  for (const [name, over, count] of cases) {
    const file = writeRollout([
      meta(),
      event('task_started', 1, { turn_id: TURN }),
      turnContext(2, TURN, 'gpt-6-astra', 'high'),
      event('user_message', 3, { message: 'start the child' }),
      commandCompleted(3, command, 0, 'completed', 'shell-owned', over),
    ]);
    assert.deepEqual(
      readCodexSession(file, 'parent').turns[0].dispatchToolUseIds ?? [],
      count ? ['shell-owned'] : [],
      name,
    );
    assert.equal(scanCodexDispatchReferences(file, 'parent').references.length, count, name);
  }
  for (const tail of ['{foo,bar}#note', '{1..3}#note', '{foo}#note', '{}#note', '{#note', '}#note', '@(tag)#note']) {
    const resumed = `${first}; echo ${tail}; claude --resume ${CLAUDE_SESSION}`;
    for (const recorded of [true, false]) {
      const file = writeRollout([
        meta(),
        event('task_started', 1, { turn_id: TURN }),
        turnContext(2, TURN, 'gpt-6-astra', 'high'),
        event('user_message', 3, { message: 'read the child result' }),
        commandCompleted(3, resumed, 0, 'completed', 'resumed-stdout', {
          command: recorded ? ['/bin/bash', '-c', resumed] : resumed,
          stdout: DISPATCH_RECEIPT,
        }),
      ]);
      assert.deepEqual(readCodexSession(file, 'parent').turns[0].dispatchToolUseIds ?? [], [], tail);
      assert.deepEqual(scanCodexDispatchReferences(file, 'parent').references, [], tail);
    }
  }
  const differentLaunches =
    'echo {tag}#note; python first.py --arc-dispatch\n<#\necho text\n#>; python second.py --arc-dispatch';
  const unknown = writeRollout([
    meta(),
    event('task_started', 1, { turn_id: TURN }),
    turnContext(2, TURN, 'gpt-6-astra', 'high'),
    event('user_message', 3, { message: 'read the child result' }),
    commandCompleted(4, differentLaunches, 0, 'completed', 'different-launches', {
      command: differentLaunches,
      stdout: DISPATCH_RECEIPT,
    }),
  ]);
  assert.deepEqual(readCodexSession(unknown, 'parent').turns[0].dispatchToolUseIds ?? [], []);
  assert.deepEqual(scanCodexDispatchReferences(unknown, 'parent').references, []);
});

test('recorded Bash grammar frames retain paired Codex receipt ownership', () => {
  for (const command of [
    ...[
      'echo $((2*(3)))',
      'echo $((2+(3)))',
      'echo `true #x`',
      'echo `true #x\n`',
      'echo $((((1)+2)*(3)))',
      '((x=((1)+2)*(3)))',
      'echo ${unset_arc_var:-+(tag)}',
      '[[ $x == @(a|b) ]]',
      '[[ $x != +(a|b) ]]',
      '{ [[ $x == @(a|b) ]]; }',
      '! { [[ $x == @(a|b) ]]; }',
      'time [[ $x == +(a) ]]',
      'time -p [[ $x == +(a) ]]',
      'time -- [[ $x == +(a) ]]',
      'time -p -- [[ $x == +(a) ]]',
      '! time [[ $x == +(a) ]]',
      'time ! [[ $x == +(a) ]]',
      'echo `cat <<EOF #comment\nx\nEOF`',
    ].map((statement) => `${statement}; python child.py --arc-dispatch`),
    'python child.py --prompt { [[ literal ]] --arc-dispatch',
    'python child.py --prompt time -p -- [[ literal ]] --arc-dispatch',
    'python child.py --prompt "{ [[ literal ]]" --arc-dispatch',
    'python child.py --prompt "time -p -- [[ literal ]]" --arc-dispatch',
  ]) {
    const file = writeRollout([
      meta(),
      event('task_started', 1, { turn_id: TURN }),
      turnContext(2, TURN, 'gpt-6-astra', 'high'),
      event('user_message', 3, { message: 'start the child' }),
      commandCompleted(4, command, 0, 'completed', 'bash-receipt', {
        command: ['/bin/bash', '-lc', command],
        stdout: DISPATCH_RECEIPT,
      }),
    ]);
    assert.deepEqual(readCodexSession(file, 'parent').turns[0].dispatchToolUseIds, ['bash-receipt'], command);
    assert.deepEqual(
      scanCodexDispatchReferences(file, 'parent').references.map((reference) => [
        reference.sessionId,
        reference.toolUseIds,
      ]),
      [[CLAUDE_SESSION, ['bash-receipt']]],
      command,
    );
  }
  for (const command of [
    'echo "{ [[ literal ]]; python child.py --arc-dispatch"',
    'echo "time -p -- [[ literal ]]; python child.py --arc-dispatch"',
    '"{ " [[ @(tag) ]]; python child.py --arc-dispatch',
    '"time" [[ @(tag) ]]; python child.py --arc-dispatch',
    '\\{ [[ @(tag) ]]; python child.py --arc-dispatch',
    'ti\\me [[ @(tag) ]]; python child.py --arc-dispatch',
  ]) {
    const file = writeRollout([
      meta(),
      event('task_started', 1, { turn_id: TURN }),
      turnContext(2, TURN, 'gpt-6-astra', 'high'),
      event('user_message', 3, { message: 'read the child result' }),
      commandCompleted(4, command, 0, 'completed', 'unowned-pattern', {
        command: ['/bin/bash', '-lc', command],
        stdout: DISPATCH_RECEIPT,
      }),
    ]);
    assert.deepEqual(readCodexSession(file, 'parent').turns[0].dispatchToolUseIds ?? [], [], command);
    assert.deepEqual(scanCodexDispatchReferences(file, 'parent').references, [], command);
  }
  const resumed = `claude -p fresh --output-format text; echo \`cat <<EOF #comment\nx\nEOF\`; claude --resume ${CLAUDE_SESSION} --output-format json`;
  const resumedFile = writeRollout([
    meta(),
    event('task_started', 1, { turn_id: TURN }),
    turnContext(2, TURN, 'gpt-6-astra', 'high'),
    event('user_message', 3, { message: 'read the child result' }),
    commandCompleted(4, resumed, 0, 'completed', 'resumed-stdout', {
      command: ['/bin/bash', '-lc', resumed],
      stdout: `fresh-response\n${JSON.stringify({ type: 'result', session_id: CLAUDE_SESSION })}`,
    }),
  ]);
  assert.deepEqual(readCodexSession(resumedFile, 'parent').turns[0].dispatchToolUseIds ?? [], []);
  assert.deepEqual(scanCodexDispatchReferences(resumedFile, 'parent').references, []);
  const command = 'python outer.py --prompt (Write-Output `) | Out-String) --arc-dispatch';
  const file = writeRollout([
    meta(),
    event('task_started', 1, { turn_id: TURN }),
    turnContext(2, TURN, 'gpt-6-astra', 'high'),
    event('user_message', 3, { message: 'start the child' }),
    commandCompleted(4, command, 0, 'completed', 'powershell-receipt', { stdout: DISPATCH_RECEIPT }),
  ]);
  assert.deepEqual(readCodexSession(file, 'parent').turns[0].dispatchToolUseIds, ['powershell-receipt']);
  assert.equal(scanCodexDispatchReferences(file, 'parent').references[0]?.sessionId, CLAUDE_SESSION);
});

test('a delayed copied Codex turn context retracts its dispatch receipt', () => {
  const id = 'copied';
  const records = [
    recordedAt(meta(), '2026-08-27T12:00:00.000Z'),
    recordedAt(event('task_started', 1, { turn_id: id }), '2026-08-27T12:00:00.001Z'),
    commandCompleted(2, DISPATCH_COMMAND, 0, 'completed', 'exec-copied', { stdout: DISPATCH_RECEIPT }),
    event('task_complete', 3, { turn_id: id, last_agent_message: 'done' }),
  ];
  const file = writeRollout(records);
  const initial = scanCodexDispatchReferences(file, 'child');
  assert.deepEqual(initial.references, []);
  fs.appendFileSync(
    file,
    JSON.stringify(
      recordedAt(
        { type: 'turn_context', payload: { turn_id: id, current_date: '2026-08-26' } },
        '2026-08-27T12:00:00.004Z',
      ),
    ) + '\n',
  );
  assert.deepEqual(scanCodexDispatchReferences(file, 'child', initial.cursor).references, []);
});

test('a repeated copied turn keeps the original dispatch and rejects the copied receipt', () => {
  const records = [
    meta(),
    event('task_started', 1, { turn_id: TURN }),
    turnContext(2, TURN, 'gpt-6-astra', 'high'),
    commandCompleted(3, DISPATCH_COMMAND, 0, 'completed', 'original', { stdout: DISPATCH_RECEIPT }),
    event('task_complete', 4, { turn_id: TURN }),
    event('task_started', 5, { turn_id: TURN }),
    commandCompleted(6, DISPATCH_COMMAND, 0, 'completed', 'copied', { stdout: DISPATCH_RECEIPT }),
    event('task_complete', 7, { turn_id: TURN }),
    { ...turnContext(8, TURN, 'gpt-6-astra', 'high'), payload: { turn_id: TURN, current_date: '2026-08-24' } },
  ];
  const scan = scanCodexDispatchReferences(writeRollout(records), 'parent');
  assert.deepEqual(
    scan.references.map((reference) => reference.toolUseIds),
    [['original']],
  );
});

test('a same-prefix rollout rewrite drops its stale dispatch cursor', () => {
  const records = [
    meta(),
    event('task_started', 1, { turn_id: TURN }),
    turnContext(2, TURN, 'gpt-6-astra', 'high'),
    commandCompleted(3, DISPATCH_COMMAND, 0, 'completed', 'launch', { stdout: DISPATCH_RECEIPT }),
  ];
  const file = writeRollout(records);
  fs.utimesSync(file, 1_700_000_000, 1_700_000_000);
  const first = scanCodexDispatchReferences(file, 'parent');
  assert.equal(first.references.length, 1);
  const replacement =
    records
      .map((record) => JSON.stringify(record))
      .join('\n')
      .replace(CLAUDE_SESSION, '00000000-0000-0000-0000-000000000000') + '\n';
  assert.equal(Buffer.byteLength(replacement), fs.statSync(file).size);
  fs.writeFileSync(file, replacement);
  fs.utimesSync(file, 1_700_000_001, 1_700_000_001);
  const invalidated = scanCodexDispatchReferences(file, 'parent', first.cursor);
  assert.equal(invalidated.reset, true);
  const rewritten = scanCodexDispatchReferences(file, 'parent', invalidated.cursor);
  assert.deepEqual(
    rewritten.references.map((reference) => reference.sessionId),
    ['00000000-0000-0000-0000-000000000000'],
  );
  assert.deepEqual(
    scanCodexDispatchReferences(
      file,
      'another-parent',
      scanCodexDispatchReferences(file, 'another-parent', rewritten.cursor).cursor,
    ).references.map((reference) => reference.parentSessionId),
    ['another-parent'],
  );
});

test.each([65536, 1024 * 1024])(
  'Codex interior rewrite plus growth resumes to the fresh relationships at %i bytes',
  (budget) => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const firstId = '11111111-1111-4111-8111-111111111111';
    const secondId = '22222222-2222-4222-8222-222222222222';
    const file = writeRollout([
      meta(),
      event('task_started', 1, { turn_id: TURN }),
      turnContext(2, TURN, 'gpt-6-astra', 'high'),
      { type: 'ignored', payload: 'x'.repeat(1024) },
      commandCompleted(3, DISPATCH_COMMAND, 0, 'completed', 'launch', {
        stdout: DISPATCH_RECEIPT.replace(CLAUDE_SESSION, firstId),
      }),
      ...Array.from({ length: 100 }, () => ({ type: 'ignored', payload: 'y'.repeat(1024) })),
    ]);
    const first = scanCodexDispatchReferences(file, 'parent', null, budget);
    assert.deepEqual(
      first.references.map((reference) => reference.sessionId),
      [firstId],
    );
    const old = fs.readFileSync(file, 'utf8');
    assert.ok(old.indexOf(firstId) > 256 && old.indexOf(firstId) < first.cursor.offset - 4096);
    fs.writeFileSync(file, old.replace(firstId, secondId) + '{"type":"ignored"}\n');
    fs.utimesSync(file, new Date(0), new Date(first.cursor.mtimeMs + 2000));
    let resumed = scanCodexDispatchReferences(file, 'parent', first.cursor, budget);
    for (let pass = 0; !resumed.complete && pass < 100; pass++)
      resumed = scanCodexDispatchReferences(file, 'parent', JSON.parse(JSON.stringify(resumed.cursor)), budget);
    assert.ok(resumed.complete);
    assert.deepEqual(resumed.references, scanCodexDispatchReferences(file, 'parent').references);
  },
);

test('Codex append validation retains parsing position and replaces a superseded comparison', () => {
  const file = writeRollout(Array.from({ length: 300 }, () => ({ type: 'ignored', payload: 'x'.repeat(1024) })));
  let scan = scanCodexDispatchReferences(file, 'parent', null, 65536);
  const offset = scan.cursor.offset;
  fs.appendFileSync(file, '{"type":"ignored"}\n');
  scan = scanCodexDispatchReferences(file, 'parent', scan.cursor, 32768);
  assert.equal(scan.reset, false);
  assert.equal(scan.complete, false);
  assert.equal(scan.cursor.offset, offset);
  assert.ok(scan.cursor.evidence?.validation?.digest.offset);
  const candidate = scan.cursor.evidence.validation.stamp;
  fs.appendFileSync(file, '{"type":"ignored"}\n');
  scan = scanCodexDispatchReferences(file, 'parent', scan.cursor, 32768);
  assert.equal(scan.cursor.offset, offset);
  assert.notDeepEqual(scan.cursor.evidence?.validation?.stamp, candidate);
  assert.ok(scan.cursor.evidence!.validation.digest.offset <= 16384);
  for (let pass = 0; !scan.complete && pass < 100; pass++) {
    const before = scan.cursor.offset;
    scan = scanCodexDispatchReferences(file, 'parent', scan.cursor, 65536);
    assert.equal(scan.reset, false);
    assert.ok(scan.cursor.offset >= before);
  }
  assert.equal(scan.complete, true);
  assert.equal(scan.cursor.offset, fs.statSync(file).size);
});

test('Codex replacement and truncation retire completed relationships before rebuilding', () => {
  const records = [
    meta(),
    event('task_started', 1, { turn_id: TURN }),
    turnContext(2, TURN, 'gpt-6-astra', 'high'),
    commandCompleted(3, DISPATCH_COMMAND, 0, 'completed', 'launch', { stdout: DISPATCH_RECEIPT }),
  ];
  for (const change of ['replacement', 'truncation']) {
    const file = writeRollout(records);
    const first = scanCodexDispatchReferences(file, 'parent');
    assert.equal(first.complete, true);
    assert.equal(first.references.length, 1);
    if (change === 'replacement') {
      fs.renameSync(file, file + '.old');
      fs.writeFileSync(file, JSON.stringify(meta()) + '\n');
    } else fs.writeFileSync(file, JSON.stringify(meta()) + '\n');
    const invalidated = scanCodexDispatchReferences(file, 'parent', first.cursor);
    assert.equal(invalidated.reset, true);
    assert.equal(invalidated.complete, false);
    assert.deepEqual(invalidated.references, []);
    const fresh = scanCodexDispatchReferences(file, 'parent', invalidated.cursor);
    assert.equal(fresh.complete, true);
    assert.deepEqual(fresh.references, scanCodexDispatchReferences(file, 'parent').references);
  }
});

test('a same-size middle rewrite replaces a dispatch receipt outside both cursor anchors', () => {
  const firstId = '11111111-1111-4111-8111-111111111111';
  const secondId = '22222222-2222-4222-8222-222222222222';
  const file = writeRollout([
    meta(),
    event('task_started', 1, { turn_id: TURN }),
    turnContext(2, TURN, 'gpt-6-astra', 'high'),
    ...Array.from({ length: 6 }, () => ({ type: 'ignored', payload: 'x'.repeat(1024) })),
    commandCompleted(3, DISPATCH_COMMAND, 0, 'completed', 'launch', {
      stdout: DISPATCH_RECEIPT.replace(CLAUDE_SESSION, firstId),
    }),
    ...Array.from({ length: 6 }, () => ({ type: 'ignored', payload: 'y'.repeat(1024) })),
  ]);
  const first = scanCodexDispatchReferences(file, 'parent');
  assert.deepEqual(
    first.references.map((reference) => reference.sessionId),
    [firstId],
  );
  const before = revisionOf(fs.statSync(file, { bigint: true }));
  const old = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, old.replace(firstId, secondId));
  fs.utimesSync(file, new Date(before.mtimeMs), new Date(before.mtimeMs + 2000));
  assert.equal(fs.statSync(file).size, before.size);
  const reset = scanCodexDispatchReferences(file, 'parent', first.cursor);
  assert.equal(reset.reset, true);
  const refreshed = scanCodexDispatchReferences(file, 'parent', reset.cursor);
  assert.deepEqual(
    refreshed.references.map((reference) => reference.sessionId),
    [secondId],
  );
});

test('a terminal dispatch record appears at stable EOF and survives a later newline append once', () => {
  const records = [
    meta(),
    event('task_started', 1, { turn_id: TURN }),
    turnContext(2, TURN, 'gpt-6-astra', 'high'),
    commandCompleted(3, DISPATCH_COMMAND, 0, 'completed', 'launch', { stdout: DISPATCH_RECEIPT }),
  ];
  const file = writeRollout(records);
  fs.truncateSync(file, fs.statSync(file).size - 1);
  const first = scanCodexDispatchReferences(file, 'parent');
  assert.equal(first.complete, true);
  assert.deepEqual(
    first.references.map((reference) => reference.toolUseIds),
    [['launch']],
  );
  fs.appendFileSync(file, '\n' + JSON.stringify(event('task_complete', 4, { turn_id: TURN })) + '\n');
  const appended = scanCodexDispatchReferences(file, 'parent', first.cursor);
  assert.equal(appended.complete, true);
  assert.deepEqual(
    appended.references.map((reference) => reference.toolUseIds),
    [['launch']],
  );
});

test('a terminal dispatch record continues when every slice starts past its deadline', async () => {
  // Each reading of the clock lands a full slice after the previous one, so every deadline has passed.
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => (clock += 1_000));
  const file = writeRollout([
    meta(),
    event('task_started', 1, { turn_id: TURN }),
    turnContext(2, TURN, 'gpt-6-astra', 'high'),
    commandCompleted(3, DISPATCH_COMMAND, 0, 'completed', 'launch', { stdout: DISPATCH_RECEIPT }),
  ]);
  fs.truncateSync(file, fs.statSync(file).size - 1);
  const finish = async (cursor: Awaited<ReturnType<typeof scanCodexDispatchReferencesAsync>>['cursor'] | null) => {
    let scan = await scanCodexDispatchReferencesAsync(file, 'parent', cursor, 64 * 1024, () => false);
    for (let pass = 0; !scan.complete && pass < 100; pass++)
      scan = await scanCodexDispatchReferencesAsync(file, 'parent', scan.cursor, 64 * 1024, () => false);
    return scan;
  };
  const first = await finish(null);
  assert.equal(first.complete, true);
  assert.equal(first.cursor.terminalApplied, true);
  fs.appendFileSync(file, '\n' + JSON.stringify(event('task_complete', 4, { turn_id: TURN })) + '\n');
  const appended = await finish(first.cursor);
  assert.equal(appended.complete, true, 'the scan read the records after the terminal record');
  assert.deepEqual(
    appended.references.map((reference) => reference.toolUseIds),
    [['launch']],
  );
});

test('resuming a spilled partial line waits for enough budget and counts the replay bytes', () => {
  const smallFile = writeRollout([meta()]);
  fs.appendFileSync(smallFile, '{"type":"ignored"');
  assert.equal(scanCodexDispatchReferences(smallFile, 'parent').complete, false);
  const file = writeRollout([meta()]);
  const partial = JSON.stringify({ type: 'ignored', payload: 'x'.repeat(8192) });
  fs.appendFileSync(file, partial.slice(0, -1));
  const first = scanCodexDispatchReferences(file, 'parent');
  assert.ok(first.cursor.fragmentStart !== null);
  const offset = first.cursor.offset;
  fs.appendFileSync(file, '}\n');
  const small = scanCodexDispatchReferences(file, 'parent', first.cursor, 6 * 1024);
  assert.equal(small.cursor.offset, offset);
  assert.ok(small.readBytes <= 6 * 1024);
  assert.equal(small.complete, false);
  let resumed = scanCodexDispatchReferences(file, 'parent', small.cursor, 32 * 1024);
  for (let pass = 0; !resumed.complete && pass < 10; pass++)
    resumed = scanCodexDispatchReferences(file, 'parent', resumed.cursor, 32 * 1024);
  assert.equal(resumed.complete, true);
  assert.ok(resumed.readBytes > 0);
  assert.ok(resumed.readBytes <= 32 * 1024);
});
const claudePrintResult = (over: Record<string, unknown> = {}) => ({
  type: 'result',
  session_id: CLAUDE_SESSION,
  total_cost_usd: 3.25,
  duration_ms: 12_345,
  is_error: false,
  usage: {
    input_tokens: 20,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 300,
    output_tokens: 40,
    cache_creation: { ephemeral_1h_input_tokens: 80, ephemeral_5m_input_tokens: 20 },
  },
  modelUsage: {
    'claude-haiku-4-5-20251001': {
      inputTokens: 10,
      outputTokens: 2,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      thinkingTokens: 0,
      costUSD: 0.01,
      contextWindow: 200_000,
      canonicalModel: 'claude-haiku-4-5',
      costBasis: 'list',
    },
    'claude-opus-5': {
      inputTokens: 20,
      outputTokens: 40,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 100,
      thinkingTokens: 12,
      costUSD: 3.24,
      contextWindow: 1_000_000,
      canonicalModel: 'claude-opus-5',
      costBasis: 'list',
    },
  },
  ...over,
});

function claudeCommandCompleted(
  second: number,
  id = `exec-claude-${second}`,
  result: Record<string, unknown> | string = claudePrintResult(),
  itemOver: Record<string, unknown> = {},
): object {
  return event('item_completed', second, {
    item: {
      type: 'CommandExecution',
      id,
      command: [
        'powershell.exe',
        '-Command',
        '$prompt = Get-Content review.txt -Raw; claude -p $prompt --output-format json',
      ],
      parsed_cmd: [
        { type: 'unknown', cmd: '$prompt = Get-Content review.txt -Raw; claude -p $prompt --output-format json' },
      ],
      status: 'completed',
      exit_code: 0,
      stdout: typeof result === 'string' ? result : JSON.stringify(result),
      ...itemOver,
    },
  });
}

function writeRollout(
  records: object[],
  name = 'rollout-2026-08-25T12-00-00-01a032c9-1a92-7931-845c-723117d24dbe.jsonl',
): string {
  const dir = tempDir('codex-');
  const file = path.join(dir, name);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

function ignoredCodexLineOfBytes(bytes: number): string {
  const prefix = '{"type":"ignored","payload":"';
  const suffix = '"}\n';
  assert.ok(bytes >= Buffer.byteLength(prefix + suffix));
  return prefix + 'x'.repeat(bytes - Buffer.byteLength(prefix + suffix)) + suffix;
}

// One turn that did the ordinary things: it was asked, it ran a command, it edited a file
// and it answered.
const TURN = '01a032c9-1e07-78b2-ae0c-dc76f2dd7901';

function ordinaryTurn(): object[] {
  return [
    meta(),
    event('task_started', 1, { turn_id: TURN, model_context_window: 258400 }),
    turnContext(2, TURN, 'gpt-5.6-sol', 'high'),
    event('user_message', 3, { message: 'fix the parser' }),
    item('custom_tool_call', 4, {
      name: 'exec',
      call_id: 'call_a',
      input: 'const r = await tools.shell_command({command:"npm test"});',
    }),
    toolOutput(5, 'call_a', 'Script completed\nExit code: 0\nOutput:\nok'),
    event('patch_apply_end', 6, {
      call_id: 'exec-1',
      turn_id: TURN,
      success: true,
      stdout: 'Success.',
      changes: {
        'c:\\repo\\src\\a.ts': {
          type: 'update',
          unified_diff: '@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+extra\n',
          move_path: null,
        },
      },
    }),
    tokens(7, { input_tokens: 20003, cached_input_tokens: 11008, output_tokens: 225, reasoning_output_tokens: 96 }),
    event('task_complete', 8, { turn_id: TURN, last_agent_message: '- fixed the parser', duration_ms: 7000 }),
  ];
}

function turnWithClaudeCommands(...commands: object[]): object[] {
  return [
    meta(),
    event('task_started', 1, { turn_id: TURN, model_context_window: 258400 }),
    turnContext(2, TURN, 'gpt-5.6-sol', 'high'),
    event('user_message', 3, { message: 'review the change' }),
    ...commands,
    event('task_complete', 20, { turn_id: TURN, last_agent_message: 'reviewed' }),
  ];
}

// A wrapper launches a Claude session and the same turn resumes it in print mode. The print row
// keeps its own amount, so the session's share on the card holds the rest of its cost.
test('a wrapper receipt and a Claude print resume of one session count the session once on the Codex card', () => {
  const resume = `claude -p --resume ${CLAUDE_SESSION} "continue" --output-format json`;
  const file = writeRollout(
    turnWithClaudeCommands(
      commandCompleted(4, DISPATCH_COMMAND, 0, 'completed', 'exec-wrapper', { stdout: DISPATCH_RECEIPT }),
      claudeCommandCompleted(5, 'exec-resume', claudePrintResult(), {
        command: ['powershell.exe', '-Command', resume],
        parsed_cmd: [{ type: 'unknown', cmd: resume }],
      }),
    ),
  );
  const [turn] = readCodexSession(file, 'parent').turns;
  const rows = turn.agents.filter((agent) => agent.agentType === 'claude-cli');
  assert.deepEqual(
    rows.map((agent) => agent.id),
    [CLAUDE_SESSION],
  );
  const counted = countedDispatchedCosts(
    turn,
    scanCodexDispatchReferences(file, 'parent').references,
    new Set(turn.dispatchToolUseIds ?? []),
    () => ({ [CLAUDE_SESSION]: dispatchedContribution(5_000_000, turn.startedAt) }),
    false,
  );
  assert.deepEqual(
    counted.map((cost) => cost.sessionId),
    [CLAUDE_SESSION],
  );
  const own = turnCost(turn).dollars!;
  const figure = toCard(turn, false, Date.parse(at(20)), [], null, false, new Set(), counted).chips.find(
    (chip) => chip.metric === 'cost',
  );
  // The print row priced 3.25 of the session's 5 dollars, so the card adds 1.75 for it.
  assert.equal(figure?.label, `$${(own + 5 - 3.25).toFixed(2)}`);
});

test('a successful Claude print result becomes a priced child with its model split', () => {
  const [turn] = readCodexSession(writeRollout(turnWithClaudeCommands(claudeCommandCompleted(4))), 'sess').turns;
  assert.equal(turn.agents.length, 1);
  assert.deepEqual(turn.agents[0], {
    id: CLAUDE_SESSION,
    invocationId: `exec-claude-4:${CLAUDE_SESSION}`,
    description: 'Claude CLI',
    agentType: 'claude-cli',
    model: null,
    effort: null,
    spend: [
      {
        model: 'claude-haiku-4-5',
        contextWindow: 200_000,
        recordedCost: 0.01,
        costBasis: 'list',
        usage: {
          requests: 1,
          input: 10,
          cacheWrite1h: 0,
          cacheWrite5m: 0,
          cacheWrite30m: 0,
          cacheRead: 0,
          output: 2,
          thinking: 0,
        },
      },
      {
        model: 'claude-opus-5',
        contextWindow: 1_000_000,
        recordedCost: 3.24,
        costBasis: 'list',
        usage: {
          requests: 1,
          input: 20,
          cacheWrite1h: 80,
          cacheWrite5m: 20,
          cacheWrite30m: 0,
          cacheRead: 300,
          output: 40,
          thinking: 12,
        },
      },
    ],
    spendFound: true,
    spendPartial: false,
    durationMs: 12_345,
    tokens: null,
    toolUses: null,
    status: 'done',
  });
  assert.deepEqual(turnCost(turn), { dollars: 3.25, partial: false });
});

test('cache creation shared by several Claude models remains unclassified', () => {
  const result = claudePrintResult({
    total_cost_usd: 3.25,
    usage: {
      cache_creation_input_tokens: 110,
      cache_creation: { ephemeral_1h_input_tokens: 90, ephemeral_5m_input_tokens: 20 },
    },
    modelUsage: {
      haiku: {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 10,
        thinkingTokens: 0,
        costUSD: 0.01,
        contextWindow: 200_000,
        canonicalModel: 'claude-haiku-4-5',
        costBasis: 'list',
      },
      opus: {
        inputTokens: 20,
        outputTokens: 40,
        cacheReadInputTokens: 300,
        cacheCreationInputTokens: 100,
        thinkingTokens: 12,
        costUSD: 3.24,
        contextWindow: 1_000_000,
        canonicalModel: 'claude-opus-5',
        costBasis: 'list',
      },
    },
  });
  const parsed = claudeCommandResult(
    (claudeCommandCompleted(4, 'shared-cache', result) as { payload: Record<string, unknown> }).payload,
  );
  assert.deepEqual(
    parsed?.models.map((part) => part.unclassifiedCacheWrite),
    [10, 100],
  );
  assert.deepEqual(
    parsed?.models.map((part) => [part.usage.cacheWrite1h, part.usage.cacheWrite5m]),
    [
      [0, 0],
      [0, 0],
    ],
  );
});

test('a Claude child on a regional Bedrock profile pays 1.1 times the list price it recorded', () => {
  const bedrockResult = (profile: string) =>
    claudePrintResult({
      total_cost_usd: 0.5,
      modelUsage: {
        [profile]: {
          inputTokens: 20,
          outputTokens: 40,
          cacheReadInputTokens: 300,
          cacheCreationInputTokens: 100,
          thinkingTokens: 12,
          costUSD: 0.5,
          contextWindow: 1_000_000,
          canonicalModel: 'claude-opus-5-5',
          costBasis: 'list',
        },
      },
    });
  const recorded = (profile: string) =>
    claudeCommandResult(
      (claudeCommandCompleted(4, 'bedrock-child', bedrockResult(profile)) as { payload: Record<string, unknown> })
        .payload,
    )?.models.map((part) => part.recordedCost);
  assert.deepEqual(recorded('us.anthropic.claude-opus-5-5[1m]'), [0.55]);
  assert.deepEqual(recorded('apac.anthropic.claude-opus-5-5'), [0.55]);
  assert.deepEqual(recorded('global.anthropic.claude-opus-5-5'), [0.5]);
  assert.deepEqual(recorded('claude-opus-5-5'), [0.5]);

  // The turn card shows the charged total and says where it came from.
  const card = (profile: string) => {
    const [turn] = readCodexSession(
      writeRollout(turnWithClaudeCommands(claudeCommandCompleted(4, 'bedrock-child', bedrockResult(profile)))),
      'sess',
    ).turns;
    return { dollars: turnCost(turn).dollars, detail: costDetail(turn).join('\n') };
  };
  const bedrock = card('us-gov.anthropic.claude-opus-5-5');
  assert.ok(Math.abs((bedrock.dollars ?? Number.NaN) - 0.55) < 1e-9, `priced at ${bedrock.dollars}`);
  assert.match(bedrock.detail, /: \$0\.55/);
  assert.match(bedrock.detail, /Total recorded by Claude CLI at list price, times 1\.1 for Amazon Bedrock/);
  const firstParty = card('claude-opus-5-5');
  assert.equal(firstParty.dollars, 0.5);
  assert.match(firstParty.detail, /^\s*Total recorded by Claude CLI at list price$/m);

  // Project cost uses the same charged total and source description.
  const spend = (profile: string) => {
    const state = emptyCodexUsageReducerState();
    reduceCodexUsageRecord(state, { kind: 'task_started', timestamp: ms(1), payload: { turn_id: TURN } });
    const completed = claudeCommandCompleted(4, 'bedrock-child', bedrockResult(profile));
    const event = reduceCodexUsageRecord(state, {
      kind: 'item_completed',
      timestamp: ms(4),
      payload: (completed as { payload: Record<string, unknown> }).payload,
    });
    return publicProjectSpendPrice(aggregateUsageEvents(event ? [event] : [])[0]);
  };
  const bedrockSpend = spend('us.anthropic.claude-opus-5-5[1m]');
  assert.ok(Math.abs((bedrockSpend?.dollars ?? Number.NaN) - 0.55) < 1e-9, `priced at ${bedrockSpend?.dollars}`);
  assert.equal(bedrockSpend?.source, 'Claude CLI recorded list price, times 1.1 for Amazon Bedrock');
  assert.deepEqual(
    [spend('claude-opus-5-5')?.dollars, spend('claude-opus-5-5')?.source],
    [0.5, 'Claude CLI recorded list price'],
  );
});

test('Claude command model aggregates do not claim an exact request count', () => {
  const state = emptyCodexUsageReducerState();
  reduceCodexUsageRecord(state, { kind: 'task_started', timestamp: ms(1), payload: { turn_id: TURN } });
  const completed = claudeCommandCompleted(4);
  const first = reduceCodexUsageRecord(state, {
    kind: 'item_completed',
    timestamp: ms(4),
    payload: (completed as { payload: Record<string, unknown> }).payload,
  });
  assert.equal(first?.requestCountExact, false);
  assert.equal(first?.incomplete, undefined);
  assert.equal(first?.reportedCost, 0.01);
});

test('Claude command identity counts duplicate completions once and resumed sessions per invocation', () => {
  const first = claudeCommandCompleted(4, 'first');
  const second = claudeCommandCompleted(5, 'second');
  const duplicate = claudeCommandCompleted(6, 'first');
  const [turn] = readCodexSession(writeRollout(turnWithClaudeCommands(first, second, duplicate)), 'sess').turns;
  assert.deepEqual(
    turn.agents.map((agent) => agent.invocationId),
    [`first:${CLAUDE_SESSION}`, `second:${CLAUDE_SESSION}`],
  );
  assert.deepEqual(turnCost(turn), { dollars: 6.5, partial: false });
});

test('a complete Claude result replaces an incomplete record for the same command in either order', () => {
  const incomplete = claudeCommandCompleted(4, 'same-command', '{"type":"result","session_id":');
  const complete = claudeCommandCompleted(5, 'same-command');
  for (const commands of [
    [incomplete, complete],
    [complete, incomplete],
  ]) {
    const [turn] = readCodexSession(writeRollout(turnWithClaudeCommands(...commands)), 'sess').turns;
    assert.equal(turn.agents.length, 1);
    assert.equal(turn.agents[0].status, 'done');
    assert.equal(turn.agents[0].spendPartial, false);
    assert.deepEqual(turnCost(turn), { dollars: 3.25, partial: false });
  }
});

test('a resumed turn replaces its incomplete Claude row when the complete result arrives', () => {
  const prefix = turnWithClaudeCommands().slice(0, 4);
  const first = createCodexSessionReducer('sess');
  for (const record of [...prefix, claudeCommandCompleted(4, 'resumed-command', '{"type":"result"')]) {
    first.pushLine(JSON.stringify(record));
  }
  const resumed = createCodexSessionReducer('sess', {}, null, first.snapshot());
  resumed.pushLine(JSON.stringify(claudeCommandCompleted(5, 'resumed-command')));
  resumed.pushLine(JSON.stringify(event('task_complete', 20, { turn_id: TURN, last_agent_message: 'reviewed' })));
  const [turn] = resumed.finish().turns;
  assert.equal(turn.agents.length, 1);
  assert.equal(turn.agents[0].status, 'done');
  assert.deepEqual(turnCost(turn), { dollars: 3.25, partial: false });
});

test('concurrent exec wrappers do not prevent either Claude completion from being attributed', () => {
  const records = turnWithClaudeCommands(
    item('custom_tool_call', 4, { name: 'exec', call_id: 'outer-a', input: 'first' }),
    item('custom_tool_call', 4, { name: 'exec', call_id: 'outer-b', input: 'second' }),
    claudeCommandCompleted(5, 'first'),
    claudeCommandCompleted(6, 'second', claudePrintResult({ session_id: 'another-session' })),
  );
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  assert.deepEqual(
    turn.agents.map((agent) => agent.id),
    [CLAUDE_SESSION, 'another-session'],
  );
});

test('failed and malformed Claude results mark the parent cost as incomplete', () => {
  const failed = claudeCommandCompleted(4, 'failed', claudePrintResult(), { status: 'failed', exit_code: 1 });
  const truncated = claudeCommandCompleted(5, 'truncated', '{"type":"result","session_id":');
  const negative = claudeCommandCompleted(6, 'negative', claudePrintResult({ total_cost_usd: -1 }));
  const unrelated = commandCompleted(7, 'echo json');
  (unrelated as unknown as { payload: { item: Record<string, unknown> } }).payload.item.stdout =
    JSON.stringify(claudePrintResult());
  const [turn] = readCodexSession(
    writeRollout(turnWithClaudeCommands(failed, truncated, negative, unrelated)),
    'sess',
  ).turns;
  assert.equal(turn.agents.length, 3);
  assert.ok(turn.agents.every((agent) => !agent.spendFound && agent.spendPartial && agent.status === 'failed'));
  assert.deepEqual(turnCost(turn), { dollars: 0, partial: true });
});

test('quoted and commented Claude examples are not treated as executed commands', () => {
  const commands = [
    '$example = "; claude -p fake"; Write-Output $example',
    '# claude -p fake\nWrite-Output "saved result"',
    "$example = @'\n; claude -p fake\n'@\nWrite-Output $example",
    "$example = @'\ntext '@; claude -p fake\n'@\nWrite-Output $example",
  ];
  for (const [index, command] of commands.entries()) {
    const record = commandCompleted(8 + index, command);
    (record as unknown as { payload: { item: Record<string, unknown> } }).payload.item.stdout =
      JSON.stringify(claudePrintResult());
    assert.equal(claudeCommandResult((record as { payload: Record<string, unknown> }).payload), null);
  }
});

test('a single-quoted Windows root path before Claude does not hide the executed command', () => {
  const record = commandCompleted(12, "$root = 'C:\\'; claude -p $prompt --output-format json");
  (record as unknown as { payload: { item: Record<string, unknown> } }).payload.item.stdout =
    JSON.stringify(claudePrintResult());
  assert.equal(claudeCommandResult((record as { payload: Record<string, unknown> }).payload)?.accepted, true);
});

test('usage reducer restoration owns nested outcomes and defaults missing outcomes to null', () => {
  for (const value of [undefined, null]) {
    const restored = createCodexUsageLineReducer({
      ...emptyCodexUsageReducerState(),
      currentTurnOutcome: value,
      lastTurnOutcome: value,
    } as ReturnType<typeof emptyCodexUsageReducerState>);
    assert.equal(restored.snapshot().currentTurnOutcome, null);
    assert.equal(restored.snapshot().lastTurnOutcome, null);
    assert.equal(restored.newestTurnOutcome(), null);
  }
  for (const field of ['currentTurnOutcome', 'lastTurnOutcome'] as const) {
    const outcome = {
      finished: false,
      error: true,
      interrupted: true,
      endedAt: ms(8),
      startedAt: ms(1),
      processEndedAt: ms(7),
      openChildren: ['open-child'],
      closedChildren: ['legacy-child', { id: 'closed-child', closedAt: ms(6) }],
      backgroundCommands: [{ id: 'command', startedAt: ms(2) }],
    };
    const checkpoint = {
      ...emptyCodexUsageReducerState(),
      currentTurnId: field === 'currentTurnOutcome' ? 'turn-1' : null,
      [field]: outcome,
    };
    const retained = structuredClone(checkpoint);
    const restored = createCodexUsageLineReducer(checkpoint);
    assert.deepEqual(restored.snapshot()[field], outcome);
    const active = restored.newestTurnOutcome();
    assert.deepEqual(active, outcome);
    assert.notStrictEqual(active!.openChildren, outcome.openChildren);
    assert.notStrictEqual(active!.closedChildren, outcome.closedChildren);
    assert.notStrictEqual(active!.closedChildren![1], outcome.closedChildren[1]);
    assert.notStrictEqual(active!.backgroundCommands, outcome.backgroundCommands);
    assert.notStrictEqual(active!.backgroundCommands![0], outcome.backgroundCommands[0]);
    active!.openChildren!.push('another-child');
    const closed = active!.closedChildren![1];
    assert.ok(typeof closed !== 'string');
    closed.closedAt = ms(9);
    active!.backgroundCommands![0].startedAt = ms(3);
    assert.deepEqual(checkpoint, retained);
  }
});

test('the incremental usage reducer persists Claude invocation deduplication', () => {
  const reducer = createCodexUsageLineReducer();
  for (const record of turnWithClaudeCommands().slice(0, 4)) {
    reducer.pushLine(JSON.stringify(record));
  }
  const completion = JSON.stringify(claudeCommandCompleted(4, 'persisted'));
  const first = reducer.pushLine(completion);
  assert.deepEqual(
    first.map((entry) => [entry.model, entry.reportedCost, entry.linkedSessionId]),
    [
      ['claude-haiku-4-5', 0.01, CLAUDE_SESSION],
      ['claude-opus-5', 3.24, CLAUDE_SESSION],
    ],
  );
  const resumed = createCodexUsageLineReducer(reducer.snapshot());
  assert.deepEqual(resumed.pushLine(completion), []);
  assert.equal(resumed.pushLine(JSON.stringify(claudeCommandCompleted(5, 'new-command'))).length, 2);
});

test('the incremental reducer replaces a persisted incomplete result with complete usage', () => {
  const reducer = createCodexUsageLineReducer();
  for (const record of turnWithClaudeCommands().slice(0, 4)) {
    reducer.pushLine(JSON.stringify(record));
  }
  const incomplete = reducer.pushLine(
    JSON.stringify(claudeCommandCompleted(4, 'late-result', '{"type":"result","session_id":')),
  );
  assert.equal(incomplete.length, 1);
  assert.equal(incomplete[0].incomplete, true);
  assert.equal(incomplete[0].usage.requests, 1);

  const resumed = createCodexUsageLineReducer(reducer.snapshot());
  const replacement = resumed.pushLine(JSON.stringify(claudeCommandCompleted(5, 'late-result')));
  assert.equal(replacement.length, 3);
  assert.deepEqual(
    replacement.map((entry) => [entry.incomplete ?? false, entry.usage.requests]),
    [
      [true, -1],
      [false, 1],
      [false, 1],
    ],
  );
  assert.deepEqual(resumed.pushLine(JSON.stringify(claudeCommandCompleted(6, 'late-result'))), []);
});

test('a Codex child spend read includes Claude work it launched through the shell', () => {
  const file = writeRollout(turnWithClaudeCommands(claudeCommandCompleted(4)));
  const spend = readCodexAgentSpend(file);
  const dispatched = readCodexDispatchedSpend([file], [], Date.now() + 6000);
  assert.equal(dispatched.partial, false);
  assert.deepEqual(dispatched.models, spend.models);
  assert.equal(spend.found, true);
  assert.equal(spend.partial, false);
  assert.deepEqual(
    spend.models.map((part) => [part.model, part.recordedCost, part.costBasis, part.unclassifiedCacheWrite ?? 0]),
    [
      ['claude-haiku-4-5', 0.01, 'list', 0],
      ['claude-opus-5', 3.24, 'list', 0],
    ],
  );
});

test('a Codex child spend marks a pending linked Claude result as nested partial work', () => {
  const incomplete = readCodexAgentSpend(
    writeRollout(turnWithClaudeCommands(claudeCommandCompleted(4, 'missing-result', '{"type":"result"'))),
  );
  assert.equal(incomplete.found, true);
  assert.equal(incomplete.partial, true);
  assert.equal(
    readCodexDispatchedSpend(
      [writeRollout(turnWithClaudeCommands(claudeCommandCompleted(4, 'missing-result', '{"type":"result"')))],
      [],
      Date.now() + 6000,
    ).partial,
    true,
  );
  assert.equal(incomplete.usageIncomplete, undefined);
  assert.deepEqual(incomplete.models, []);

  const replaced = readCodexAgentSpend(
    writeRollout(
      turnWithClaudeCommands(
        claudeCommandCompleted(4, 'late-result', '{"type":"result"'),
        claudeCommandCompleted(5, 'late-result'),
      ),
    ),
  );
  assert.equal(replaced.partial, false);
  assert.equal(replaced.usageIncomplete, undefined);
  assert.equal(replaced.models.length, 2);
});

function recordingCodexRangeReader(ranges: Array<[number, number]>): BackwardRangeReader {
  return (file, start, length, revision) => {
    ranges.push([start, start + length]);
    const stat = revisionOf(fs.statSync(file, { bigint: true }));
    if (stat.size !== revision.size || stat.mtimeMs !== revision.mtimeMs) {
      return null;
    }
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.allocUnsafe(length);
      return fs.readSync(fd, buffer, 0, length, start) === length ? buffer : null;
    } finally {
      fs.closeSync(fd);
    }
  };
}

test('the Codex session reducer resumes tool metadata and pending execution', () => {
  const records = ordinaryTurn();
  const split =
    records.findIndex((record) => (record as { payload?: { type?: string } }).payload?.type === 'custom_tool_call') + 1;
  const all = createCodexSessionReducer('sess', {}, readCodexSessionMeta(writeRollout(records)));
  for (const record of records) {
    all.pushLine(JSON.stringify(record));
  }
  const first = createCodexSessionReducer('sess', {}, readCodexSessionMeta(writeRollout(records)));
  for (const record of records.slice(0, split)) {
    first.pushLine(JSON.stringify(record));
  }
  const resumed = createCodexSessionReducer('sess', {}, null, first.snapshot());
  for (const record of records.slice(split)) {
    resumed.pushLine(JSON.stringify(record));
  }
  assert.deepEqual(resumed.read(), all.read());
  const step = resumed.read().turns[0].steps[0];
  assert.equal(Object.getOwnPropertyDescriptor(step, 'id')?.enumerable, false);
  assert.equal((step as { id?: string }).id, 'call_a');
  assert.equal(Object.getOwnPropertyDescriptor(step, 'fullDetail')?.enumerable, false);
  assert.equal((step as { fullDetail?: string }).fullDetail, 'npm test');
});

test('Codex reducer reads stay independent while finish transfers owned state', () => {
  const reducer = createCodexSessionReducer('sess', {}, readCodexSessionMeta(writeRollout(ordinaryTurn())));
  for (const record of ordinaryTurn()) {
    reducer.pushLine(JSON.stringify(record));
  }
  const copied = reducer.read();
  copied.turns[0].summary = 'changed copy';
  assert.equal(reducer.read().turns[0].summary, '- fixed the parser');
  const owned = reducer.finish();
  owned.turns[0].summary = 'changed owned state';
  assert.equal(reducer.finish().turns[0].summary, 'changed owned state');
});

test('Codex usage records do not walk the replay ledger for every source offset', () => {
  const entries = 600;
  let visits = 0;
  const state = emptyCodexUsageReducerState();
  const seen: Record<string, true> = {};
  for (let index = 0; index < entries; index++) {
    seen[`walk-${index}`] = true;
    state.seenTurnOffsets[`walk-${index}`] = index;
    state.legacyReplayLinks.push({
      id: `walk-${index}`,
      evidenceOffset: index,
      replayOffset: entries + index,
    });
  }
  state.seenTurnIds = new Proxy(seen, {
    ownKeys: (target) => {
      const keys = Reflect.ownKeys(target);
      visits += keys.length;
      return keys;
    },
  });
  state.legacyReplayLinks = new Proxy(state.legacyReplayLinks, {
    get: (target, property, receiver) => {
      if (typeof property === 'string' && /^\d+$/.test(property)) {
        visits++;
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  const record = {
    kind: 'ignored',
    timestamp: 0,
    payload: {},
    sourceStart: entries * 2,
    sourceEnd: entries * 2 + 1,
  };
  for (let index = 0; index < entries; index++) {
    reduceCodexUsageRecord(state, record);
  }
  assert.ok(visits <= entries * 2, `replay pruning visited ${visits} ledger entries`);
});

test('the Codex reducer resumes an agent launch through completion', () => {
  const turnId = 'agent-turn';
  const records = [
    meta(),
    event('task_started', 1, { turn_id: turnId }),
    turnContext(2, turnId, 'gpt-5.6-sol', 'high'),
    event('user_message', 3, { message: 'delegate' }),
    item('function_call', 4, {
      name: 'spawn_agent',
      call_id: 'spawn-1',
      arguments: JSON.stringify({ task_name: 'worker', message: 'do it' }),
    }),
    event('sub_agent_activity', 5, {
      event_id: 'spawn-1',
      agent_thread_id: 'child-1',
      agent_path: '/root/worker',
      kind: 'running',
    }),
    item('agent_message', 6, {
      author: '/root/worker',
      content: [{ type: 'input_text', text: 'Message Type: FINAL_ANSWER' }],
    }),
    event('task_complete', 7, { turn_id: turnId, last_agent_message: 'complete' }),
  ];
  const reducer = createCodexSessionReducer('sess', {}, readCodexSessionMeta(writeRollout(records)));
  for (const record of records.slice(0, 5)) {
    reducer.pushLine(JSON.stringify(record));
  }
  const resumed = createCodexSessionReducer('sess', {}, null, reducer.snapshot());
  for (const record of records.slice(5)) {
    resumed.pushLine(JSON.stringify(record));
  }
  const agent = resumed.read().turns[0].agents[0];
  assert.deepEqual([agent.id, agent.agentType, agent.status], ['child-1', '/root/worker', 'completed']);
  assert.equal(Object.getOwnPropertyDescriptor(agent, 'toolUseId')?.enumerable, false);
});

// Build a dispatched cost contribution with an explicit settlement time.

const dispatchedContribution = (input: number, ownSettledAt: number | null) => ({
  costs: priceDispatchedParts([
    {
      model: 'claude-haiku-4-5',
      provider: null,
      contextWindow: null,
      own: true,
      usage: {
        requests: 1,
        input,
        cacheWrite1h: 0,
        cacheWrite5m: 0,
        cacheWrite30m: 0,
        cacheRead: 0,
        output: 0,
        thinking: 0,
      },
    },
  ]),
  short: false,
  ownSettledAt,
});

test('a Codex turn counts a session that its native subagent dispatched, on the card that spawned it', () => {
  const turnId = 'spawn-turn';
  const records = [
    meta(),
    event('task_started', 1, { turn_id: turnId }),
    turnContext(2, turnId, 'gpt-5.6-sol', 'high'),
    event('user_message', 3, { message: 'delegate' }),
    item('function_call', 4, {
      name: 'spawn_agent',
      call_id: 'spawn-helper',
      arguments: JSON.stringify({ task_name: 'helper', message: 'dispatch the child' }),
    }),
    event('sub_agent_activity', 5, {
      event_id: 'spawn-helper',
      agent_thread_id: 'helper-thread',
      agent_path: '/root/helper',
      kind: 'running',
    }),
    event('task_complete', 7, { turn_id: turnId, last_agent_message: 'delegated' }),
  ];
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  assert.deepEqual([turn.sessionId, turn.agents[0]?.id], ['sess', 'helper-thread']);
  // The dispatch scan reads the helper's own rollout, so its receipt names the helper thread.
  const references = [
    {
      kind: 'dispatch',
      parentSessionId: 'helper-thread',
      sessionId: 'child',
      toolUseIds: ['exec-child'],
      name: 'Child',
    },
  ];
  const threads = [
    { threadId: 'helper-thread', parentThreadId: 'sess' },
    { threadId: 'inner-thread', parentThreadId: 'helper-thread' },
  ];
  const costs = { child: dispatchedContribution(2_000_000, null), grandchild: dispatchedContribution(1_000_000, null) };
  const counted = (refs: typeof references, held = threads) =>
    countedDispatchedCosts(turn, refs, new Set(turn.dispatchToolUseIds ?? []), () => costs, false, held).map(
      (cost) => cost.name,
    );
  assert.deepEqual(counted(references), ['Child']);
  // A thread the helper spawned in turn reaches the card too.
  const nested = [
    ...references,
    {
      kind: 'dispatch',
      parentSessionId: 'inner-thread',
      sessionId: 'grandchild',
      toolUseIds: ['exec-g'],
      name: 'Grandchild',
    },
  ];
  assert.deepEqual(counted(nested), ['Child', 'Grandchild']);
  // A thread that another turn's row names is not this card's.
  assert.deepEqual(counted(references, [{ threadId: 'helper-thread', parentThreadId: 'other-session' }]), []);
  const own = turnCost(turn).dollars ?? 0;
  const card = toCard(
    turn,
    false,
    Date.parse(at(7)),
    [],
    null,
    false,
    new Set(),
    countedDispatchedCosts(turn, references, new Set(turn.dispatchToolUseIds ?? []), () => costs, false, threads),
  );
  // The helper row has no usage yet, so the turn's own cost is a lower bound.
  assert.equal(
    card.chips.find((chip) => chip.metric === 'cost')?.label,
    `$${(own + 2).toFixed(2)}${turnCost(turn).partial ? '+' : ''}`,
  );
});

test('a Codex child still out when its turn ended says no ending was recorded, with no time', () => {
  const turnId = 'launch-turn';
  const records = [
    meta(),
    event('task_started', 1, { turn_id: turnId }),
    turnContext(2, turnId, 'gpt-5.6-sol', 'high'),
    event('user_message', 3, { message: 'delegate' }),
    item('function_call', 4, {
      name: 'spawn_agent',
      call_id: 'spawn-row',
      arguments: JSON.stringify({ task_name: 'worker', message: 'do it' }),
    }),
    event('sub_agent_activity', 5, {
      event_id: 'spawn-row',
      agent_thread_id: 'child-row',
      agent_path: '/root/worker',
      kind: 'running',
    }),
    event('task_complete', 7, { turn_id: turnId, last_agent_message: 'waiting on the worker' }),
  ];
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  assert.equal(turn.agents[0].status, 'launched');
  // Codex records no process end, so Arc cannot tell whether the child outlived the session.
  const card = toCard(turn, true, Date.parse(at(7)) + 3 * 24 * 60 * 60_000);
  assert.equal(card.status, 'done');
  assert.deepEqual(
    card.agents.map((agent) => [agent.state, agent.stateWord, agent.since]),
    [['open', 'no ending recorded', null]],
  );
  // While the turn still runs, the row counts up from the spawn_agent call.
  const [running] = readCodexSession(writeRollout(records.slice(0, -1)), 'sess').turns;
  const live = toCard(running, true, Date.parse(at(5)) + 120_000);
  assert.equal(live.status, 'running');
  assert.deepEqual(
    live.agents.map((agent) => [agent.state, agent.stateWord, agent.since]),
    [['running', 'running', Date.parse(at(4))]],
  );
  // A stopped turn leaves the child open too.
  const stopped = toCard(running, false, Date.parse(at(5)) + 3 * 24 * 60 * 60_000);
  assert.equal(stopped.status, 'stopped');
  assert.deepEqual(
    stopped.agents.map((agent) => [agent.state, agent.stateWord, agent.since]),
    [['open', 'no ending recorded', null]],
  );
});

test('a Codex checkpoint applies an append and equals a one-shot read', () => {
  const records = ordinaryTurn();
  const file = writeRollout(records.slice(0, -1));
  const initial = readCodexSessionIncremental(file, 'sess');
  assert.equal(initial.kind, 'reset');
  fs.appendFileSync(file, JSON.stringify(records.at(-1)) + '\n');
  const appended = readCodexSessionIncremental(file, 'sess', initial.checkpoint ?? undefined);
  assert.equal(appended.kind, 'appended');
  assert.deepEqual(appended.read, readCodexSession(file, 'sess'));
});

test('a Codex checkpoint clears a prior overflow after its source leaves the tail', () => {
  const turn = (index: number) => [
    event('task_started', index * 4 + 1, { turn_id: `overflow-${index}` }),
    turnContext(index * 4 + 2, `overflow-${index}`, 'gpt-5.6-sol', 'high'),
    event('user_message', index * 4 + 3, { message: `overflow prompt ${index}` }),
    event('task_complete', index * 4 + 4, {
      turn_id: `overflow-${index}`,
      last_agent_message: `overflow answer ${index}`,
    }),
  ];
  const file = writeRollout([meta(), ...turn(0), ...turn(1)]);
  fs.appendFileSync(file, ignoredCodexLineOfBytes(4096));
  fs.appendFileSync(file, [...turn(2), ...turn(3)].map((record) => JSON.stringify(record)).join('\n') + '\n');
  const options = { maxTurns: 2, tailBytes: fs.statSync(file).size };
  const initial = readCodexSessionIncremental(file, 'sess', undefined, options);
  assert.equal(initial.checkpoint?.parserState.turnLimitReached, true);
  fs.appendFileSync(file, ignoredCodexLineOfBytes(2000));
  const resumed = readCodexSessionIncremental(file, 'sess', initial.checkpoint ?? undefined, options);
  const fresh = readCodexSession(file, 'sess', options);
  assert.equal(resumed.kind, 'appended');
  assert.deepEqual(resumed.read, fresh);
  assert.equal(resumed.read?.turnLimitReached, false);
});

test('a Codex checkpoint resumes usage, context, and compaction state', () => {
  const firstId = 'first-complete';
  const secondId = 'second-open';
  const initialRecords = [
    meta(),
    event('task_started', 1, { turn_id: firstId }),
    turnContext(2, firstId, 'gpt-5.6-sol', 'high'),
    event('user_message', 3, { message: 'first' }),
    tokens(4, { input_tokens: 33 }),
    event('task_complete', 5, { turn_id: firstId, last_agent_message: 'first done' }),
    event('compacted', 6),
    event('task_started', 7, { turn_id: secondId }),
    turnContext(8, secondId, 'gpt-5.6-sol', 'medium'),
    event('user_message', 9, { message: 'second' }),
  ];
  const file = writeRollout(initialRecords);
  const initial = readCodexSessionIncremental(file, 'sess');
  fs.appendFileSync(
    file,
    [
      JSON.stringify(tokens(10, { input_tokens: 12 })),
      JSON.stringify(event('task_complete', 11, { turn_id: secondId, last_agent_message: 'second done' })),
      '',
    ].join('\n'),
  );
  const appended = readCodexSessionIncremental(file, 'sess', initial.checkpoint ?? undefined);
  assert.equal(appended.kind, 'appended');
  assert.deepEqual(appended.read, readCodexSession(file, 'sess'));
  assert.equal(appended.read?.compactions[0].contextBefore, 33);
  assert.equal(appended.read?.compactions[0].trigger, 'auto');
  assert.deepEqual(
    appended.read?.turns.map((turn) => [turn.model, turn.effort, turn.usage.input]),
    [
      ['gpt-5.6-sol', 'high', 33],
      ['gpt-5.6-sol', 'medium', 12],
    ],
  );
});

test('an unchanged Codex checkpoint reads no rollout bytes', () => {
  const file = writeRollout(ordinaryTurn());
  const initial = readCodexSessionIncremental(file, 'sess');
  assert.equal(initial.read?.readBytes, fs.statSync(file).size);
  const reused = readCodexSessionIncremental(file, 'sess', initial.checkpoint ?? undefined);
  assert.equal(reused.kind, 'reused');
  assert.equal(reused.readBytes, 0);
  assert.equal(reused.read?.readBytes, fs.statSync(file).size);
  assert.deepEqual(reused.read, initial.read);
});

test('a Codex checkpoint resets when parser options change', () => {
  const records: object[] = [meta()];
  for (let index = 0; index < 3; index++) {
    const id = `configured-${index}`;
    records.push(
      event('task_started', index * 4 + 1, { turn_id: id }),
      turnContext(index * 4 + 2, id, 'gpt-5.6-sol', 'high'),
      event('user_message', index * 4 + 3, { message: `configured ${index}` }),
      event('task_complete', index * 4 + 4, { turn_id: id, last_agent_message: `answer ${index}` }),
    );
  }
  const file = writeRollout(records);
  const first = readCodexSessionIncremental(file, 'sess', undefined, { maxTurns: 1 });
  assert.equal(first.read?.turns.length, 1);
  const reset = readCodexSessionIncremental(file, 'sess', first.checkpoint ?? undefined, { maxTurns: 3 });
  assert.equal(reset.kind, 'reset');
  assert.deepEqual(reset.read, readCodexSession(file, 'sess', { maxTurns: 3 }));
});

test('a Codex checkpoint bounds persisted closed turns at maxTurns', () => {
  const records: object[] = [meta()];
  for (let index = 0; index < 8; index++) {
    const id = `bounded-${index}`;
    records.push(
      event('task_started', index * 4 + 1, { turn_id: id }),
      turnContext(index * 4 + 2, id, 'gpt-5.6-sol', 'high'),
      event('user_message', index * 4 + 3, { message: `bounded prompt ${index}` }),
      event('task_complete', index * 4 + 4, { turn_id: id, last_agent_message: `answer ${index}` }),
    );
  }
  const file = writeRollout(records);
  const result = readCodexSessionIncremental(file, 'sess', undefined, { maxTurns: 3 });
  assert.equal(result.checkpoint?.parserState.turns.length, 3);
  assert.equal(result.checkpoint?.parserState.turnRanges.length, 3);
  assert.equal(result.checkpoint?.parserState.turnLimitReached, true);
  assert.deepEqual(result.read, readCodexSession(file, 'sess', { maxTurns: 3 }));
});

test('a Codex checkpoint bounds completed turns that never receive context', () => {
  const records: object[] = [meta()];
  for (let index = 0; index < 20; index++) {
    const id = `contextless-${index}`;
    records.push(
      event('task_started', index * 3 + 1, { turn_id: id }),
      event('user_message', index * 3 + 2, { message: `contextless prompt ${index}` }),
      event('task_complete', index * 3 + 3, { turn_id: id, last_agent_message: `answer ${index}` }),
    );
  }
  const file = writeRollout(records);
  const result = readCodexSessionIncremental(file, 'sess', undefined, { maxTurns: 3 });
  assert.equal(result.checkpoint?.parserState.turns.length, 6);
  assert.equal(result.checkpoint?.parserState.turnRanges.length, 6);
  assert.equal(result.checkpoint?.parserState.pendingClassification.length, 3);
  const usageState = result.checkpoint!.parserState.usageState;
  assert.deepEqual(
    {
      contexts: result.checkpoint!.parserState.contexts.size,
      seenTurnIds: Object.keys(usageState.seenTurnIds).length,
      copiedTurnIds: Object.keys(usageState.copiedTurnIds).length,
      datedCopiedTurnIds: Object.keys(usageState.datedCopiedTurnIds).length,
      countedTurnIds: Object.keys(usageState.countedTurnIds).length,
      turnModels: Object.keys(usageState.turnModels).length,
      turnWindows: Object.keys(usageState.turnWindows).length,
      pendingRequests: Object.keys(usageState.pendingRequests).length,
      pendingRequestSources: Object.keys(usageState.pendingRequestSources).length,
    },
    {
      contexts: 0,
      seenTurnIds: 20,
      copiedTurnIds: 0,
      datedCopiedTurnIds: 0,
      countedTurnIds: 5,
      turnModels: 0,
      turnWindows: 0,
      pendingRequests: 0,
      pendingRequestSources: 0,
    },
  );
  assert.deepEqual(result.read, readCodexSession(file, 'sess', { maxTurns: 3 }));
});

test('a long Codex checkpoint bounds every retained turn association', () => {
  const records: object[] = [meta()];
  for (let index = 0; index < 20; index += 1) {
    const turnId = `associated-${index}`;
    const second = index * 9 + 1;
    const execId = `bounded-exec-${index}`;
    const spawnId = `bounded-spawn-${index}`;
    records.push(
      event('task_started', second, { turn_id: turnId, model_context_window: 258400 }),
      turnContext(second + 1, turnId, 'gpt-5.6-sol', 'high'),
      event('user_message', second + 2, { message: `bounded prompt ${index}` }),
      tokens(second + 3, { input_tokens: 10 + index }),
      item('custom_tool_call', second + 4, { name: 'exec', call_id: execId, input: `echo ${index}` }),
      toolOutput(second + 5, execId, 'ok'),
      item('function_call', second + 6, {
        name: 'spawn_agent',
        call_id: spawnId,
        arguments: JSON.stringify({ task_name: `worker-${index}`, message: 'do it' }),
      }),
      event('sub_agent_activity', second + 7, {
        event_id: spawnId,
        agent_thread_id: `child-${index}`,
        agent_path: `/root/worker-${index}`,
        kind: 'running',
      }),
      item('agent_message', second + 8, {
        author: `/root/worker-${index}`,
        content: [{ type: 'input_text', text: 'Message Type: FINAL_ANSWER' }],
      }),
      event('task_complete', second + 9, { turn_id: turnId, last_agent_message: `answer ${index}` }),
      event('compacted', second + 9),
    );
  }
  const reducer = createCodexSessionReducer('sess', { maxTurns: 3 });
  for (const record of records) {
    reducer.pushLine(JSON.stringify(record));
  }
  const state = reducer.snapshot();
  assert.deepEqual(
    {
      turns: state.turns.length,
      turnRanges: state.turnRanges.length,
      turnMembershipStarts: state.turnMembershipStarts.length,
      contexts: state.contexts.size,
      toolNames: state.toolNames.size,
      stepById: state.stepById.size,
      updateById: state.updateById.size,
      pendingExec: state.pendingExec.size,
      launched: state.launched.size,
      currentSpawns: state.currentSpawns.size,
      byName: state.byName.size,
      seenTurnIds: Object.keys(state.usageState.seenTurnIds).length,
      copiedTurnIds: Object.keys(state.usageState.copiedTurnIds).length,
      datedCopiedTurnIds: Object.keys(state.usageState.datedCopiedTurnIds).length,
      countedTurnIds: Object.keys(state.usageState.countedTurnIds).length,
      turnModels: Object.keys(state.usageState.turnModels).length,
      turnWindows: Object.keys(state.usageState.turnWindows).length,
      pendingRequests: Object.keys(state.usageState.pendingRequests).length,
      pendingRequestSources: Object.keys(state.usageState.pendingRequestSources).length,
      compactions: state.compactions.length,
      compactionRanges: state.compactionRanges.length,
      compactionValueSources: state.compactionValueSources.length,
    },
    {
      turns: 3,
      turnRanges: 3,
      turnMembershipStarts: 3,
      contexts: 0,
      toolNames: 0,
      stepById: 0,
      updateById: 0,
      pendingExec: 0,
      launched: 0,
      currentSpawns: 0,
      byName: 0,
      seenTurnIds: 20,
      copiedTurnIds: 0,
      datedCopiedTurnIds: 0,
      countedTurnIds: 2,
      turnModels: 3,
      turnWindows: 3,
      pendingRequests: 0,
      pendingRequestSources: 0,
      compactions: 3,
      compactionRanges: 3,
      compactionValueSources: 3,
    },
  );
  const file = writeRollout(records);
  assert.deepEqual(reducer.read(fs.statSync(file).size), readCodexSession(file, 'sess', { maxTurns: 3 }));
});

test('a copied context appended immediately after completion retracts that checkpoint turn', () => {
  const records = [
    recordedAt(meta(), '2026-08-27T12:00:00.000Z'),
    recordedAt(event('task_started', 0, { turn_id: 'immediate-copy' }), '2026-08-27T12:00:00.001Z'),
    recordedAt(event('user_message', 0, { message: 'copied prompt' }), '2026-08-27T12:00:00.002Z'),
    recordedAt(
      event('task_complete', 0, {
        turn_id: 'immediate-copy',
        last_agent_message: 'copied answer',
      }),
      '2026-08-27T12:00:00.003Z',
    ),
    recordedAt(
      {
        type: 'turn_context',
        payload: {
          turn_id: 'immediate-copy',
          cwd: 'c:\\repo',
          model: 'gpt-5.6-sol',
          effort: 'high',
          current_date: '2026-08-26',
        },
      },
      '2026-08-27T12:00:00.004Z',
    ),
  ];
  const file = writeRollout(records.slice(0, -1));
  const initial = readCodexSessionIncremental(file, 'child-thread');
  assert.deepEqual(
    initial.read?.turns.map((turn) => turn.promptId),
    ['immediate-copy'],
  );
  fs.appendFileSync(file, JSON.stringify(records.at(-1)) + '\n');
  const appended = readCodexSessionIncremental(file, 'child-thread', initial.checkpoint ?? undefined);
  assert.equal(appended.kind, 'appended');
  assert.deepEqual(appended.checkpoint?.parserState.turns, []);
  assert.deepEqual(appended.checkpoint?.parserState.pendingClassification, []);
  assert.deepEqual(appended.read, readCodexSession(file, 'child-thread'));
  assert.deepEqual(appended.read?.turns, []);
});

test('a Codex checkpoint remembers a replay id beyond the visible turn limit', () => {
  const records: object[] = [meta()];
  const ids = ['old-id', 'middle-a', 'middle-b', 'middle-c'];
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    records.push(
      event('task_started', index * 4 + 1, { turn_id: id }),
      turnContext(index * 4 + 2, id, 'gpt-5.6-sol', 'high'),
      event('user_message', index * 4 + 3, { message: `${id} prompt` }),
      event('task_complete', index * 4 + 4, { turn_id: id, last_agent_message: `${id} answer` }),
    );
  }
  const file = writeRollout(records);
  const initial = readCodexSessionIncremental(file, 'child-thread', undefined, { maxTurns: 2 });
  assert.deepEqual(
    initial.read?.turns.map((turn) => turn.promptId),
    ['middle-b', 'middle-c'],
  );
  fs.appendFileSync(
    file,
    [
      JSON.stringify(event('task_started', 20, { turn_id: 'old-id' })),
      JSON.stringify(event('user_message', 21, { message: 'copied old prompt' })),
      JSON.stringify(event('task_complete', 22, { turn_id: 'old-id', last_agent_message: 'copied old answer' })),
      '',
    ].join('\n'),
  );
  const appended = readCodexSessionIncremental(file, 'child-thread', initial.checkpoint ?? undefined, { maxTurns: 2 });
  assert.equal(appended.kind, 'appended');
  assert.deepEqual(appended.read, readCodexSession(file, 'child-thread', { maxTurns: 2 }));
  assert.deepEqual(
    appended.read?.turns.map((turn) => turn.promptId),
    ['middle-b', 'middle-c'],
  );
  assert.equal(appended.checkpoint?.parserState.usageState.seenTurnIds['old-id'], true);
  assert.equal(Object.keys(appended.checkpoint!.parserState.usageState.seenTurnIds).length, 4);
});

test('a Codex checkpoint slides its replay ledger without rereading the source window', () => {
  const records: object[] = [meta()];
  for (let index = 0; index < 8; index += 1) {
    const id = `windowed-${index}`;
    records.push(
      event('task_started', index * 4 + 1, { turn_id: id }),
      turnContext(index * 4 + 2, id, 'gpt-5.6-sol', 'high'),
      event('user_message', index * 4 + 3, { message: `${id} ${'x'.repeat(120)}` }),
      event('task_complete', index * 4 + 4, { turn_id: id, last_agent_message: `${id} answer` }),
    );
  }
  const file = writeRollout(records);
  const options = { maxTurns: 2, tailBytes: 900 };
  const initial = readCodexSessionIncremental(file, 'sess', undefined, options);
  const appendedRecords = [
    event('task_started', 40, { turn_id: 'after-window' }),
    turnContext(41, 'after-window', 'gpt-5.6-sol', 'high'),
    event('user_message', 42, { message: 'after window prompt' }),
    event('task_complete', 43, { turn_id: 'after-window', last_agent_message: 'after window answer' }),
  ];
  fs.appendFileSync(file, appendedRecords.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const appended = readCodexSessionIncremental(file, 'sess', initial.checkpoint ?? undefined, options);
  assert.equal(appended.kind, 'appended');
  assert.ok((appended.checkpoint?.coveredFrom ?? 0) > initial.checkpoint!.coveredFrom);
  assert.ok((appended.read?.readBytes ?? Number.POSITIVE_INFINITY) <= options.tailBytes);
  const floor = appended.checkpoint!.coveredFrom;
  assert.ok(
    Object.values(appended.checkpoint!.parserState.usageState.seenTurnOffsets).every((offset) => offset >= floor),
  );
  assert.deepEqual(appended.read, readCodexSession(file, 'sess', options));
});

test('stopped Codex model recovery crosses capped records and caches completed identity or absence', async () => {
  for (const kind of ['ordinary', 'oversized', 'oversized-event', 'blocked', 'absent', 'copied', 'split']) {
    const records = [
      meta(),
      event('task_started', 1, { turn_id: TURN }),
      ...(kind === 'absent' ? [] : [turnContext(2, TURN, 'gpt-6-astra', 'high')]),
      event('task_complete', 3, { turn_id: TURN, last_agent_message: 'Done' }),
      ...(kind === 'copied'
        ? [
            meta({ id: 'foreign', session_id: 'foreign' }),
            event('task_started', 1, { turn_id: 'copied', started_at: 1 }),
            turnContext(2, 'copied', 'gpt-6.1-sol', 'high'),
            event('task_complete', 3, { turn_id: 'copied' }),
          ]
        : []),
      ...(kind === 'oversized-event'
        ? [event('agent_message', 3, { message: 'x'.repeat(3 * 1024 * 1024) })]
        : kind === 'split'
          ? [{ type: 'ignored', payload: 'x'.repeat(400) }]
          : kind === 'oversized'
            ? [{ type: 'ignored', payload: 'x'.repeat(3 * 1024 * 1024) }]
            : kind === 'blocked'
              ? [
                  {
                    type: 'turn_context',
                    padding: 'x'.repeat(3 * 1024 * 1024),
                    payload: { turn_id: TURN, model: 'gpt-6.1-sol' },
                  },
                ]
              : Array.from({ length: 180 }, () => ({ type: 'ignored', payload: 'x'.repeat(16384) }))),
      event('task_started', 4, { turn_id: 'stopped', model_context_window: 258400 }),
      event('turn_aborted', 5, { turn_id: 'stopped', reason: 'interrupted' }),
    ];
    const file = writeRollout(records);
    const options = { tailBytes: 512 };
    const work = { modelBudget: { maxBytes: kind === 'split' ? 64 : 128 * 1024, maxMilliseconds: 1000 } };
    let result = await readCodexSessionIncrementalAsync(file, 'sess', undefined, options, work);
    assert.ok(result.read);
    assert.equal(result.recoveryPending, true);
    let slices = 0;
    while (result.recoveryPending && slices++ < 50) {
      const checkpoint = result.checkpoint as CodexForwardCheckpoint;
      assert.ok(checkpoint.modelRecovery!.cursor.fragment.length <= 256 * 1024);
      assert.ok((result.recoveryBytes ?? 0) <= 128 * 1024);
      result = await readCodexSessionIncrementalAsync(file, 'sess', throughStructuredClone(checkpoint), options, work);
    }
    assert.equal(result.recoveryPending, false);
    const expected = kind === 'blocked' || kind === 'absent' || kind === 'copied' ? null : 'gpt-6-astra';
    assert.equal(result.read?.lastReportedModel, expected, kind);
    assert.equal(result.read?.turns.at(-1)?.model, null);
    const runtime = composerRuntimeBySession(
      result.read!.turns,
      new Map(),
      new Map([['sess', result.read!.lastReportedModel ?? null]]),
    );
    assert.equal(runtime.get('sess')?.confirmedModel, expected);
    assert.equal(runtime.get('sess')?.context, null);
    assert.equal(runtime.get('sess')?.nextTurn, null);
    const reused = await readCodexSessionIncrementalAsync(file, 'sess', result.checkpoint!, options, work);
    assert.equal(reused.recoveryBytes, 0);
    assert.equal(reused.read?.lastReportedModel, expected);
    fs.appendFileSync(file, JSON.stringify({ type: 'ignored', payload: 'append' }) + '\n');
    const appended = await readCodexSessionIncrementalAsync(file, 'sess', reused.checkpoint!, options, work);
    assert.equal(appended.read?.lastReportedModel, expected);
  }
});

test('stopped Codex display model prefers the newest settings without changing billed turn identity', async () => {
  const records = [
    ...ordinaryTurn(),
    event('thread_settings_applied', 9, { thread_settings: { model: 'gpt-6.1-sol' } }),
    event('task_started', 10, { turn_id: 'stopped', model_context_window: 258400 }),
    event('turn_aborted', 11, { turn_id: 'stopped', reason: 'interrupted' }),
  ];
  const result = await readCodexSessionIncrementalAsync(writeRollout(records), 'sess');
  assert.equal(result.read?.lastReportedModel, 'gpt-6.1-sol');
  assert.equal(result.recoveryBytes, undefined);
  const stopped = result.read!.turns.at(-1)!;
  const runtime = composerRuntimeBySession(
    result.read!.turns,
    new Map(),
    new Map([['sess', result.read!.lastReportedModel ?? null]]),
  );
  assert.equal(runtime.get('sess')?.confirmedModel, 'gpt-6.1-sol');
  assert.equal(stopped.model, null);
  assert.equal(stopped.usage.requests, 0);
  assert.equal(result.read!.turns[0].model, 'gpt-5.6-sol');
  assert.equal(
    composerRuntimeBySession([{ ...stopped, sessionId: 'other' }], new Map(), new Map([['sess', 'gpt-6-astra']])).get(
      'other',
    )?.confirmedModel,
    null,
  );
});

test('stopped Codex recovery admits opening settings and blocks newer unproved ownership', async () => {
  for (const kind of ['settings', 'foreign-settings', 'unproved', 'copied', 'model-less']) {
    const child = 'stopped-native-child';
    const opening = lateOpeningRollout(
      child,
      {
        parent_thread_id: 'sess',
        thread_source: 'subagent',
        source: { subagent: { thread_spawn: { parent_thread_id: 'sess', agent_path: '/root/reviewer' } } },
      },
      [],
    )[0];
    const records: object[] = kind.includes('settings')
      ? [
          opening,
          ...(kind === 'foreign-settings' ? [meta({ id: 'foreign' })] : []),
          event('thread_settings_applied', 5, { thread_settings: { model: 'gpt-6-astra' } }),
        ]
      : [
          opening,
          event('task_started', 6, { turn_id: 'older' }),
          turnContext(7, 'older', 'gpt-6-astra', 'high'),
          event('task_complete', 8, { turn_id: 'older' }),
          event('task_started', 9, { turn_id: 'newer', started_at: ms(kind === 'copied' ? -60 : 4) / 1000 }),
          ...(kind === 'model-less' ? [] : [turnContext(10, 'newer', 'gpt-6.1-sol', 'high')]),
          event('task_complete', 11, { turn_id: 'newer' }),
        ];
    records.push(
      { type: 'ignored', payload: { text: 'x'.repeat(3000) } },
      event('task_started', 20, { turn_id: 'stopped', started_at: ms(20) / 1000 }),
      event('turn_aborted', 21, { turn_id: 'stopped', reason: 'interrupted' }),
    );
    const file = writeRollout(records);
    const expected = kind === 'unproved' || kind === 'foreign-settings' ? null : 'gpt-6-astra';
    const result = await readCodexSessionIncrementalAsync(
      file,
      child,
      undefined,
      { tailBytes: 512 },
      { modelBudget: { maxMilliseconds: 1000 } },
    );
    assert.equal(result.recoveryPending, false);
    assert.equal(result.read?.lastReportedModel, expected, kind);
    assert.equal(
      composerRuntimeBySession(
        result.read!.turns,
        new Map(),
        new Map([[child, result.read!.lastReportedModel ?? null]]),
      ).get(child)?.confirmedModel,
      expected,
      kind,
    );
    if (kind === 'settings') assert.equal(readCodexSession(file, child).lastReportedModel, expected);
  }
});

test('stopped Codex display promotes confirmed native context in source order across checkpoints', () => {
  for (const timing of ['none', 'older', 'newer']) {
    const child = 'stopped-native-child';
    const own = 'native-context';
    const records = lateOpeningRollout(
      child,
      {
        parent_thread_id: 'sess',
        thread_source: 'subagent',
        source: { subagent: { thread_spawn: { parent_thread_id: 'sess', agent_path: '/root/reviewer' } } },
      },
      [{ turnId: own, second: 4, input: 1000, endSecond: 18 }],
    );
    for (const row of records as Array<{ type: string; payload: Record<string, unknown> }>)
      if (row.type === 'turn_context' && row.payload.turn_id === own) row.payload.model = 'gpt-6-astra';
    if (timing === 'older')
      records.splice(1, 0, event('thread_settings_applied', 13, { thread_settings: { model: 'gpt-6.1-sol' } }));
    records.push(
      event('task_started', 20, { turn_id: 'stopped', started_at: ms(20) / 1000, model_context_window: 258400 }),
    );
    if (timing === 'newer')
      records.push(event('thread_settings_applied', 20, { thread_settings: { model: 'gpt-6.1-sol' } }));
    records.push(event('turn_aborted', 21, { turn_id: 'stopped', reason: 'interrupted' }));
    const file = writeRollout(records);
    const initial = readCodexSessionIncremental(file, child);
    assert.equal(initial.checkpoint!.parserState.usageState.pendingOwnership[own], true);
    fs.appendFileSync(
      file,
      JSON.stringify({
        type: 'token_usage_record',
        timestamp: at(22),
        payload: {
          thread_id: child,
          turn_id: own,
          response_id: 'native-response',
          usage: usage({ input_tokens: 1000, output_tokens: 1, total_tokens: 1001 }),
        },
      }) + '\n',
    );
    const resumed = readCodexSessionIncremental(file, child, throughStructuredClone(initial.checkpoint!));
    const expected = timing === 'newer' ? 'gpt-6.1-sol' : 'gpt-6-astra';
    assert.equal(resumed.read?.lastReportedModel, expected, timing);
    assert.equal(readCodexSession(file, child).lastReportedModel, expected, timing);
    const runtime = composerRuntimeBySession(
      resumed.read!.turns,
      new Map(),
      new Map([[child, resumed.read!.lastReportedModel ?? null]]),
    ).get(child)!;
    assert.equal(runtime.confirmedModel, expected, timing);
    assert.equal(runtime.context, null);
    assert.equal(runtime.nextTurn, null);
    assert.equal(resumed.read!.turns.find((row) => row.promptId === own)?.model, 'gpt-6-astra');
    assert.equal(resumed.read!.turns.at(-1)?.model, null);
  }
});

test('stopped Codex recovery rejects obsolete evidence after rewrites, replacement, truncation, and cancellation', async () => {
  const file = writeRollout([
    ...ordinaryTurn(),
    { type: 'ignored', payload: 'x'.repeat(5000) },
    event('task_started', 10, { turn_id: 'stopped' }),
    event('turn_aborted', 11, { turn_id: 'stopped', reason: 'interrupted' }),
  ]);
  const options = { tailBytes: 512 };
  let result = await readCodexSessionIncrementalAsync(file, 'sess', undefined, options, {
    modelBudget: { maxBytes: 64 },
  });
  assert.equal(result.recoveryPending, true);
  const original = fs.readFileSync(file, 'utf8');
  for (const change of ['rewrite', 'replace', 'truncate']) {
    const before = fs.statSync(file);
    const replacement =
      change === 'truncate'
        ? original.slice(original.indexOf('{"timestamp":', original.lastIndexOf('x') + 1))
        : original.replace('gpt-5.6-sol', 'gpt-6-astra');
    if (change === 'replace') {
      const temp = file + '.new';
      fs.writeFileSync(temp, replacement);
      fs.renameSync(temp, file);
    } else fs.writeFileSync(file, replacement);
    fs.utimesSync(file, before.atime, new Date(before.mtimeMs + 2000));
    result = await readCodexSessionIncrementalAsync(file, 'sess', result.checkpoint!, options, {
      modelBudget: { maxMilliseconds: 1000 },
    });
    assert.equal(result.read?.lastReportedModel, change === 'truncate' ? null : 'gpt-6-astra');
  }
  const controller = new AbortController();
  fs.writeFileSync(file, original.replace('x'.repeat(5000), 'x'.repeat(600 * 1024)));
  let clocks = 0;
  const cancelled = await readCodexSessionIncrementalAsync(file, 'sess', undefined, options, {
    signal: controller.signal,
    modelBudget: {
      maxBytes: 512 * 1024,
      clock: () => {
        if (++clocks === 3) controller.abort();
        return 0;
      },
    },
  });
  assert.equal(cancelled.kind, 'cancelled');
  assert.ok((cancelled.recoveryBytes ?? 0) > 0);
  assert.ok((cancelled.recoveryBytes ?? 0) < 512 * 1024);
  assert.equal(cancelled.read, null);
  assert.equal(cancelled.checkpoint, null);
});

test('a Codex checkpoint keeps an active turn when it grows beyond the tail window', () => {
  const file = writeRollout([
    meta(),
    event('task_started', 1, { turn_id: 'oversized-active' }),
    turnContext(2, 'oversized-active', 'gpt-5.6-sol', 'high'),
    event('user_message', 3, { message: 'keep the active turn' }),
  ]);
  const options = { maxTurns: 2, tailBytes: 512 };
  const initial = readCodexSessionIncremental(file, 'sess', undefined, options);
  fs.appendFileSync(
    file,
    JSON.stringify(
      item('agent_message', 4, {
        message: `${'x'.repeat(1_200)} active answer`,
      }),
    ) + '\n',
  );
  const oversized = readCodexSessionIncremental(file, 'sess', initial.checkpoint ?? undefined, options);
  assert.equal(oversized.kind, 'appended');
  assert.equal(oversized.checkpoint?.parserState.open?.promptId, 'oversized-active');
  assert.ok(oversized.checkpoint!.coveredFrom > initial.checkpoint!.coveredFrom);
  fs.appendFileSync(
    file,
    JSON.stringify(
      event('task_complete', 5, {
        turn_id: 'oversized-active',
        last_agent_message: 'active answer',
      }),
    ) + '\n',
  );
  const completed = readCodexSessionIncremental(file, 'sess', oversized.checkpoint ?? undefined, options);
  assert.equal(completed.kind, 'appended');
  assert.deepEqual(completed.read?.turns, []);
  assert.deepEqual(
    { ...completed.read, lastReportedModel: null },
    { ...readCodexSession(file, 'sess', options), lastReportedModel: null },
  );
});

test('a prompt submitted after an unclosed Codex turn keeps its card across a cloned checkpoint', () => {
  const records: object[] = [meta()];
  for (let index = 1; index <= 12; index += 1) {
    records.push(event('task_started', index * 3, { turn_id: `turn-${index}` }));
    records.push(event('user_message', index * 3 + 1, { message: `prompt ${index}` }));
    // The newest turn's close was never written, which is the shape that keeps a Codex turn
    // on the reducer's open slot rather than in its emitted list.
    if (index < 12) {
      records.push(
        event('task_complete', index * 3 + 2, {
          turn_id: `turn-${index}`,
          last_agent_message: `answer ${index} ${'x'.repeat(600)}`,
        }),
      );
    } else {
      records.push(commandCompleted(index * 3 + 2, `echo ${'x'.repeat(600)}`));
    }
  }
  const file = writeRollout(records);
  // Smaller than the rollout, so the resumed read has a tail floor above byte zero. That
  // floor is what discards a turn whose range came back as zero.
  const options = { tailBytes: 4096 };
  const initial = readCodexSessionIncremental(file, 'sess', undefined, options);
  assert.equal(initial.read?.turns[initial.read.turns.length - 1].prompt, 'prompt 12');
  fs.appendFileSync(
    file,
    [
      event('task_started', 100, { turn_id: 'the-new-turn' }),
      event('user_message', 101, { message: 'the new message' }),
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  const resumed = readCodexSessionIncremental(file, 'sess', throughStructuredClone(initial.checkpoint!), options);
  const cold = readCodexSession(file, 'sess', options);
  assert.ok(resumed.checkpoint!.coveredFrom > 0);
  assert.deepEqual(
    resumed.read?.turns.map((turn) => turn.prompt),
    cold.turns.map((turn) => turn.prompt),
  );
  assert.deepEqual(resumed.read, cold);
});

test('a Codex checkpoint excludes a turn whose start is the exact tail floor', () => {
  const opening = meta();
  const records = [
    opening,
    event('task_started', 1, { turn_id: 'exact-codex-floor' }),
    event('user_message', 2, { message: 'exact Codex floor' }),
    event('task_complete', 3, { turn_id: 'exact-codex-floor', last_agent_message: 'answer above floor' }),
  ];
  const turnStart = Buffer.byteLength(JSON.stringify(opening) + '\n');
  const file = writeRollout(records);
  const options = { tailBytes: fs.statSync(file).size, maxTurns: 3 };
  const initial = readCodexSessionIncremental(file, 'sess', undefined, options);
  fs.appendFileSync(file, ignoredCodexLineOfBytes(turnStart));
  const resumed = readCodexSessionIncremental(file, 'sess', initial.checkpoint ?? undefined, options);
  assert.equal(resumed.checkpoint?.coveredFrom, turnStart);
  assert.deepEqual(resumed.read, readCodexSession(file, 'sess', options));
  assert.deepEqual(resumed.read?.turns, []);
});

test('Codex tail membership follows task_started while pages own earlier turn context', () => {
  const prefix = { type: 'ignored', payload: 'p'.repeat(240) };
  const context = turnContext(1, 'context-before-membership', 'gpt-5.6-sol', 'high');
  const started = event('task_started', 2, { turn_id: 'context-before-membership' });
  const prompt = event('user_message', 3, { message: 'prompt after early context' });
  const completed = event('task_complete', 4, {
    turn_id: 'context-before-membership',
    last_agent_message: 'answer after early context',
  });
  const records = [prefix, context, started, prompt, completed];
  const encoded = records.map((record) => JSON.stringify(record));
  const starts: number[] = [];
  let cursor = 0;
  for (const line of encoded) {
    starts.push(cursor);
    cursor += Buffer.byteLength(`${line}\n`);
  }
  const contextStart = starts[1];
  const taskStart = starts[2];
  const floors = [
    ...new Set([contextStart - 1, contextStart, contextStart + 1, taskStart - 2, taskStart - 1, taskStart]),
  ];
  for (const floor of floors) {
    const file = writeRollout(records);
    const options = { tailBytes: fs.statSync(file).size, maxTurns: 3 };
    const initial = readCodexSessionIncremental(file, `codex-membership-${floor}`, undefined, options);
    fs.appendFileSync(file, ignoredCodexLineOfBytes(floor));
    const resumed = readCodexSessionIncremental(
      file,
      `codex-membership-${floor}`,
      initial.checkpoint ?? undefined,
      options,
    );
    const fresh = readCodexSession(file, `codex-membership-${floor}`, options);
    assert.equal(resumed.checkpoint?.coveredFrom, floor);
    assert.deepEqual(
      { ...resumed.read, lastReportedModel: null },
      { ...fresh, lastReportedModel: null },
      `tail floor ${floor}`,
    );
    if (floor >= contextStart && floor < taskStart) {
      assert.deepEqual(
        fresh.turns.map((turn) => [turn.prompt, turn.model, turn.effort]),
        [['prompt after early context', null, null]],
      );
    }
  }

  const older = [
    event('task_started', 0, { turn_id: 'older-guard' }),
    event('user_message', 0, { message: 'older prompt' }),
    event('task_complete', 0, { turn_id: 'older-guard', last_agent_message: 'older answer' }),
  ];
  const pagedRecords = [...older, context, started, prompt, completed];
  const pageFile = writeRollout(pagedRecords);
  const contextPageStart = Buffer.byteLength(older.map((record) => `${JSON.stringify(record)}\n`).join(''));
  const page = readCodexHistoryPage(pageFile, 'sess', null, {
    chunkBytes: fs.statSync(pageFile).size,
    targetTurns: 1,
  });
  assert.equal(page.kind, 'page');
  assert.equal(page.page?.ownedRange.start, contextPageStart);
  assert.deepEqual(
    [page.page?.turns[0].prompt, page.page?.turns[0].model, page.page?.turns[0].effort],
    ['prompt after early context', 'gpt-5.6-sol', 'high'],
  );
});

test('a Codex checkpoint revives a legacy replay when its evidence leaves the source window', () => {
  const original = [
    event('task_started', 1, { turn_id: 'legacy-floor-crossing' }),
    event('user_message', 2, { message: 'original legacy prompt' }),
    event('task_complete', 3, {
      turn_id: 'legacy-floor-crossing',
      last_agent_message: 'original legacy answer',
    }),
  ];
  const replay = [
    event('task_started', 4, { turn_id: 'legacy-floor-crossing' }),
    event('user_message', 5, { message: 'replayed legacy prompt' }),
    event('task_complete', 6, {
      turn_id: 'legacy-floor-crossing',
      last_agent_message: 'replayed legacy answer',
    }),
  ];
  const lines = [meta(), ...original, ...replay].map((record) => JSON.stringify(record) + '\n');
  const originalStart = Buffer.byteLength(lines[0]);
  const replayStart = Buffer.byteLength(lines.slice(0, 4).join(''));
  const file = writeRollout([meta(), ...original, ...replay]);
  const options = { tailBytes: fs.statSync(file).size - originalStart + 1, maxTurns: 3 };
  const initial = readCodexSessionIncremental(file, 'sess', undefined, options);
  assert.deepEqual(
    initial.read?.turns.map((turn) => turn.prompt),
    ['original legacy prompt'],
  );
  const availableShift = replayStart - originalStart;
  const wrapperBytes = Buffer.byteLength(JSON.stringify({ type: 'ignored', payload: '' }) + '\n');
  const ignored =
    JSON.stringify({
      type: 'ignored',
      payload: 'z'.repeat(Math.max(1, Math.floor(availableShift / 2) - wrapperBytes)),
    }) + '\n';
  fs.appendFileSync(file, ignored);
  const resumed = readCodexSessionIncremental(file, 'sess', initial.checkpoint ?? undefined, options);
  const fresh = readCodexSession(file, 'sess', options);
  assert.equal(resumed.kind, 'reset');
  assert.ok(resumed.checkpoint!.coveredFrom > originalStart);
  assert.ok(resumed.checkpoint!.coveredFrom < replayStart);
  assert.deepEqual(resumed.read, fresh);
  assert.deepEqual(
    resumed.read?.turns.map((turn) => turn.prompt),
    ['replayed legacy prompt'],
  );
});

test('a Codex checkpoint rebuilds when legacy replay evidence starts at the exact tail floor', () => {
  const opening = meta();
  const original = [
    event('task_started', 1, { turn_id: 'legacy-exact-floor' }),
    event('user_message', 2, { message: 'original exact-floor prompt' }),
    event('task_complete', 3, { turn_id: 'legacy-exact-floor', last_agent_message: 'original answer' }),
  ];
  const replay = [
    event('task_started', 4, { turn_id: 'legacy-exact-floor' }),
    event('user_message', 5, { message: 'replayed exact-floor prompt' }),
    event('task_complete', 6, { turn_id: 'legacy-exact-floor', last_agent_message: 'replayed answer' }),
  ];
  const originalStart = Buffer.byteLength(JSON.stringify(opening) + '\n');
  const file = writeRollout([opening, ...original, ...replay]);
  const options = { tailBytes: fs.statSync(file).size - originalStart + 1, maxTurns: 3 };
  const initial = readCodexSessionIncremental(file, 'sess', undefined, options);
  assert.deepEqual(
    initial.read?.turns.map((turn) => turn.prompt),
    ['original exact-floor prompt'],
  );
  fs.appendFileSync(file, 'x');
  const resumed = readCodexSessionIncremental(file, 'sess', initial.checkpoint ?? undefined, options);
  assert.equal(resumed.checkpoint?.coveredFrom, originalStart);
  assert.equal(resumed.kind, 'reset');
  assert.deepEqual(resumed.read, readCodexSession(file, 'sess', options));
  assert.deepEqual(
    resumed.read?.turns.map((turn) => turn.prompt),
    ['replayed exact-floor prompt'],
  );
});

function codexImplicitCompactionFixture(includeCompaction = true) {
  const id = `implicit-codex-${includeCompaction ? 'retained' : 'appended'}`;
  const records = [
    meta(),
    event('task_started', 1, { turn_id: id }),
    turnContext(2, id, 'gpt-5.6-sol', 'high'),
    event('user_message', 3, { message: 'implicit Codex compaction source' }),
    tokens(4, { input_tokens: 431, output_tokens: 7 }),
    event('task_complete', 5, { turn_id: id, last_agent_message: 'answer before compaction' }),
  ];
  const compaction = event('compacted', 6);
  const tokenStart = Buffer.byteLength(
    records
      .slice(0, 4)
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  return { records: [...records, ...(includeCompaction ? [compaction] : [])], tokenStart, compaction };
}

test('a Codex checkpoint drops implicit compaction values sourced at the exact tail floor', () => {
  const fixture = codexImplicitCompactionFixture();
  const file = writeRollout(fixture.records);
  const options = { tailBytes: fs.statSync(file).size, maxTurns: 3 };
  const initial = readCodexSessionIncremental(file, 'implicit-codex-exact', undefined, options);
  fs.appendFileSync(file, ignoredCodexLineOfBytes(fixture.tokenStart));
  const resumed = readCodexSessionIncremental(file, 'implicit-codex-exact', initial.checkpoint ?? undefined, options);
  assert.equal(resumed.checkpoint?.coveredFrom, fixture.tokenStart);
  assert.deepEqual(
    resumed.read?.compactions.map((item) => [item.contextBefore, item.model]),
    [[0, null]],
  );
  assert.equal(resumed.read?.compactions[0].trigger, 'auto');
  assert.equal(readCodexSession(file, 'implicit-codex-exact', options).compactions[0].trigger, '');
});

test('a Codex checkpoint drops implicit compaction values sourced below the tail floor', () => {
  const fixture = codexImplicitCompactionFixture();
  const floor = fixture.tokenStart + 8;
  const file = writeRollout(fixture.records);
  const options = { tailBytes: fs.statSync(file).size, maxTurns: 3 };
  const initial = readCodexSessionIncremental(file, 'implicit-codex-beyond', undefined, options);
  fs.appendFileSync(file, ignoredCodexLineOfBytes(floor));
  const resumed = readCodexSessionIncremental(file, 'implicit-codex-beyond', initial.checkpoint ?? undefined, options);
  assert.equal(resumed.checkpoint?.coveredFrom, floor);
  assert.deepEqual(
    resumed.read?.compactions.map((item) => [item.contextBefore, item.model]),
    [[0, null]],
  );
  assert.equal(resumed.read?.compactions[0].trigger, 'auto');
  assert.equal(readCodexSession(file, 'implicit-codex-beyond', options).compactions[0].trigger, '');
});

test('a newly appended Codex compaction ignores expired implicit values', () => {
  const fixture = codexImplicitCompactionFixture(false);
  const floor = fixture.tokenStart + 8;
  const file = writeRollout(fixture.records);
  const options = { tailBytes: fs.statSync(file).size, maxTurns: 3 };
  const initial = readCodexSessionIncremental(file, 'implicit-codex-appended', undefined, options);
  fs.appendFileSync(file, ignoredCodexLineOfBytes(floor));
  const trimmed = readCodexSessionIncremental(
    file,
    'implicit-codex-appended',
    initial.checkpoint ?? undefined,
    options,
  );
  assert.deepEqual([trimmed.checkpoint?.parserState.lastContext, trimmed.checkpoint?.parserState.lastModel], [0, null]);
  fs.appendFileSync(file, `${JSON.stringify(fixture.compaction)}\n`);
  const resumed = readCodexSessionIncremental(
    file,
    'implicit-codex-appended',
    trimmed.checkpoint ?? undefined,
    options,
  );
  assert.deepEqual(
    resumed.read?.compactions.map((item) => [item.contextBefore, item.model]),
    [[0, null]],
  );
  assert.equal(resumed.read?.compactions[0].trigger, 'auto');
  assert.equal(readCodexSession(file, 'implicit-codex-appended', options).compactions[0].trigger, '');
});

test('a Codex checkpoint retains exact compaction context when its earlier turn leaves the tail', () => {
  const fixture = codexImplicitCompactionFixture(false);
  const compacted = {
    timestamp: at(6),
    type: 'compacted',
    payload: {
      message: '',
      replacement_history: [],
      window_number: 2,
      latest_token_usage_record: { usage: usage({ input_tokens: 152_584, output_tokens: 1_442 }) },
    },
  };
  const settings = event('thread_settings_applied', 7, {
    thread_settings: { model: 'gpt-5.6-sol', model_provider_id: 'openai', service_tier: 'default' },
  });
  const file = writeRollout([...fixture.records, compacted, settings]);
  const options = { tailBytes: fs.statSync(file).size, maxTurns: 3 };
  const initial = readCodexSessionIncremental(file, 'exact-codex-compaction', undefined, options);
  fs.appendFileSync(file, ignoredCodexLineOfBytes(fixture.tokenStart));
  const resumed = readCodexSessionIncremental(file, 'exact-codex-compaction', initial.checkpoint ?? undefined, options);

  assert.equal(resumed.checkpoint?.coveredFrom, fixture.tokenStart);
  assert.deepEqual(
    resumed.read?.compactions.map((item) => [item.contextBefore, item.model]),
    [[152_584, 'gpt-5.6-sol']],
  );
});

test('a copied-date context cannot retract a turn beyond the classification horizon', () => {
  const records = [
    recordedAt(meta(), '2026-08-27T12:00:00.000Z'),
    recordedAt(event('task_started', 0, { turn_id: 'past-horizon' }), '2026-08-27T12:00:00.001Z'),
    recordedAt(event('user_message', 0, { message: 'keep this prompt' }), '2026-08-27T12:00:00.002Z'),
    recordedAt(
      event('task_complete', 0, {
        turn_id: 'past-horizon',
        last_agent_message: 'keep this answer',
      }),
      '2026-08-27T12:00:00.003Z',
    ),
    recordedAt(event('task_started', 0, { turn_id: 'newer-pending' }), '2026-08-27T12:00:00.004Z'),
    recordedAt(event('user_message', 0, { message: 'newer copied prompt' }), '2026-08-27T12:00:00.005Z'),
    recordedAt(
      event('task_complete', 0, {
        turn_id: 'newer-pending',
        last_agent_message: 'newer copied answer',
      }),
      '2026-08-27T12:00:00.006Z',
    ),
    recordedAt(
      {
        type: 'turn_context',
        payload: {
          turn_id: 'past-horizon',
          cwd: 'c:\\repo',
          model: 'gpt-5.6-sol',
          effort: 'high',
          current_date: '2026-08-26',
        },
      },
      '2026-08-27T12:00:00.007Z',
    ),
    recordedAt(
      {
        type: 'turn_context',
        payload: {
          turn_id: 'newer-pending',
          cwd: 'c:\\repo',
          model: 'gpt-5.6-sol',
          effort: 'high',
          current_date: '2026-08-26',
        },
      },
      '2026-08-27T12:00:00.008Z',
    ),
  ];
  const reducer = createCodexSessionReducer('sess', { maxTurns: 1 });
  for (const record of records.slice(0, -1)) {
    reducer.pushLine(JSON.stringify(record));
  }
  assert.deepEqual(
    reducer.snapshot().turns.map((turn) => turn.promptId),
    ['past-horizon', 'newer-pending'],
  );
  reducer.pushLine(JSON.stringify(records.at(-1)));
  assert.deepEqual(
    reducer.snapshot().turns.map((turn) => turn.promptId),
    ['past-horizon'],
  );
  assert.deepEqual(
    reducer.read().turns.map((turn) => [turn.promptId, turn.model]),
    [['past-horizon', 'gpt-5.6-sol']],
  );
});

test('Codex checkpoint truncation rebuilds only that source', () => {
  const file = writeRollout(ordinaryTurn());
  const initial = readCodexSessionIncremental(file, 'sess');
  fs.writeFileSync(
    file,
    [JSON.stringify(meta()), JSON.stringify(event('task_started', 20, { turn_id: 'new' }))].join('\n') + '\n',
  );
  const reset = readCodexSessionIncremental(file, 'sess', initial.checkpoint ?? undefined);
  assert.equal(reset.kind, 'reset');
  assert.deepEqual(
    reset.read?.turns.map((turn) => turn.promptId),
    [],
  );
});

test('a malformed Codex record does not hide a valid unterminated completion', () => {
  const records = ordinaryTurn();
  const dir = tempDir('codex-history-');
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(
    file,
    records
      .slice(0, -1)
      .map((record) => JSON.stringify(record))
      .concat('{bad', JSON.stringify(records.at(-1)))
      .join('\n'),
  );
  const result = readCodexSessionIncremental(file, 'sess');
  assert.equal(result.read?.turns[0].summary, '- fixed the parser');
  assert.ok((result.checkpoint?.lineFragment.length ?? 0) > 0);
  assert.deepEqual(result.read, readCodexSession(file, 'sess'));
});

test('Codex semantic pages preserve context written before a turn starts', () => {
  const turnId = 'context-first';
  const file = writeRollout([
    meta(),
    turnContext(1, turnId, 'gpt-5.6-sol', 'high'),
    event('task_started', 2, { turn_id: turnId }),
    event('user_message', 3, { message: 'context first' }),
    tokens(4, { input_tokens: 22 }),
    event('task_complete', 5, { turn_id: turnId, last_agent_message: 'done' }),
  ]);
  const result = readCodexHistoryPage(file, 'sess', null, { chunkBytes: 31, targetTurns: 1 });
  assert.equal(result.kind, 'page');
  assert.deepEqual([result.page?.turns[0].model, result.page?.turns[0].effort], ['gpt-5.6-sol', 'high']);
});

test('Codex history uses the legacy guardian payload clock for dated replay fallback', () => {
  const file = writeRollout([
    recordedAt(
      meta({
        id: 'legacy-history',
        thread_source: 'subagent',
        source: { subagent: { other: 'guardian' } },
        timestamp: '2026-08-25T23:59:58.000Z',
      }),
      '2026-08-26T12:00:00.000Z',
    ),
    recordedAt(event('task_started', 0, { turn_id: 'guardian-history' }), '2026-08-26T12:00:00.001Z'),
    recordedAt(
      {
        type: 'turn_context',
        payload: {
          turn_id: 'guardian-history',
          cwd: 'c:\\repo',
          model: 'codex-auto-review',
          effort: 'low',
          current_date: '2026-08-25',
        },
      },
      '2026-08-26T12:00:00.002Z',
    ),
    recordedAt(event('user_message', 0, { message: 'review this change' }), '2026-08-26T12:00:00.003Z'),
    recordedAt(
      event('task_complete', 0, {
        turn_id: 'guardian-history',
        last_agent_message: 'allow',
      }),
      '2026-08-26T12:00:00.004Z',
    ),
  ]);
  const result = readCodexHistoryPage(file, 'legacy-history', null, {
    chunkBytes: fs.statSync(file).size,
    targetTurns: 1,
  });
  assert.equal(result.kind, 'page');
  assert.deepEqual(
    result.page?.turns.map((turn) => turn.promptId),
    ['guardian-history'],
  );
});

test('Codex history rereads metadata when a cursor belongs to another session', async () => {
  const turnRecords = (prefix: string, start: number, startedAt = ms(start) / 1_000) => [
    event('task_started', start, {
      turn_id: `${prefix}-turn`,
      started_at: startedAt,
    }),
    turnContext(start + 1, `${prefix}-turn`, 'gpt-5.6-sol', 'high'),
    event('user_message', start + 2, { message: `${prefix} prompt` }),
    event('task_complete', start + 3, {
      turn_id: `${prefix}-turn`,
      last_agent_message: `${prefix} answer`,
    }),
  ];
  const fileA = writeRollout([
    recordedAt(
      meta({
        id: 'session-a',
        session_id: 'session-a',
        cwd: 'c:\\rollout-a',
        model_provider: 'amazon-bedrock',
      }),
      '2026-08-27T12:00:00.000Z',
    ),
    ...turnRecords('a-older', 1, Date.parse('2026-08-27T12:00:01.000Z') / 1_000),
    ...turnRecords('a-newer', 5, Date.parse('2026-08-27T12:00:05.000Z') / 1_000),
  ]);
  const pageA = readCodexHistoryPage(fileA, 'session-a', null, {
    chunkBytes: fs.statSync(fileA).size,
    targetTurns: 1,
  });
  assert.equal(pageA.kind, 'page');
  const cursorA = pageA.page?.nextOlderCursor;
  assert.ok(cursorA);

  const fileB = writeRollout([
    recordedAt(
      meta({
        id: 'session-b',
        session_id: 'session-b',
        cwd: 'c:\\rollout-b',
        model_provider: 'openai',
      }),
      '2026-08-25T12:00:00.000Z',
    ),
    ...turnRecords('b-older', 1),
    ...turnRecords('b-newer', 5),
  ]);
  const check = (result: Awaited<ReturnType<typeof readCodexHistoryPageAsync>>) => {
    assert.equal(result.kind, 'page');
    assert.equal(result.page?.turns.length, 1);
    assert.equal(result.page?.turns[0]?.prompt, 'b-newer prompt');
    assert.equal(result.page?.turns[0]?.provider, 'openai');
    assert.deepEqual(
      [
        result.page?.nextOlderCursor?.adapterState.meta?.sessionId,
        result.page?.nextOlderCursor?.adapterState.meta?.cwd,
        result.page?.nextOlderCursor?.adapterState.meta?.modelProvider,
      ],
      ['session-b', 'c:\\rollout-b', 'openai'],
    );
  };
  check(
    readCodexHistoryPage(fileB, 'session-b', cursorA ?? null, {
      chunkBytes: fs.statSync(fileB).size,
      targetTurns: 1,
    }),
  );
  check(
    await readCodexHistoryPageAsync(fileB, 'session-b', cursorA ?? null, {
      chunkBytes: fs.statSync(fileB).size,
      targetTurns: 1,
    }),
  );
});

test('a delayed Codex context retracts a completed copied turn across page edges', () => {
  const records = [
    recordedAt(meta(), '2026-08-27T12:00:00.000Z'),
    recordedAt(event('task_started', 0, { turn_id: 'copied' }), '2026-08-27T12:00:00.001Z'),
    recordedAt(event('user_message', 0, { message: 'copied prompt' }), '2026-08-27T12:00:00.002Z'),
    recordedAt(
      event('task_complete', 0, { turn_id: 'copied', last_agent_message: 'copied answer' }),
      '2026-08-27T12:00:00.003Z',
    ),
    recordedAt(event('task_started', 0, { turn_id: 'own' }), '2026-08-27T12:00:00.004Z'),
    recordedAt(turnContext(0, 'own', 'gpt-5.6-sol', 'high'), '2026-08-27T12:00:00.005Z'),
    recordedAt(
      {
        type: 'turn_context',
        payload: {
          turn_id: 'copied',
          cwd: 'c:\\repo',
          model: 'gpt-5.6-sol',
          effort: 'high',
          current_date: '2026-08-26',
        },
      },
      '2026-08-27T12:00:00.006Z',
    ),
    recordedAt(event('user_message', 0, { message: 'own prompt' }), '2026-08-27T12:00:00.007Z'),
    recordedAt(
      event('task_complete', 0, { turn_id: 'own', last_agent_message: 'own answer' }),
      '2026-08-27T12:00:00.008Z',
    ),
  ];
  const file = writeRollout(records);
  const prompts: string[] = [];
  let cursor = null;
  do {
    const result = readCodexHistoryPage(file, 'child-thread', cursor, { chunkBytes: 80, targetTurns: 1 });
    assert.equal(result.kind, 'page');
    if (result.kind !== 'page') {
      break;
    }
    prompts.push(...result.page.turns.map((turn) => turn.prompt));
    cursor = result.page.nextOlderCursor;
  } while (cursor);
  assert.deepEqual(prompts, ['own prompt']);
});

test('Codex history consumes a carried copied occurrence after its matching turn', () => {
  const tick = (value: number) => `2026-08-27T12:00:00.${String(value).padStart(3, '0')}Z`;
  const records: object[] = [recordedAt(meta(), tick(0))];
  let value = 1;
  for (const id of ['ancient-a', 'ancient-b']) {
    records.push(
      recordedAt(event('task_started', 0, { turn_id: id }), tick(value++)),
      recordedAt(turnContext(0, id, 'gpt-5.6-sol', 'high'), tick(value++)),
      recordedAt(event('user_message', 0, { message: `${id} prompt` }), tick(value++)),
      recordedAt(event('task_complete', 0, { turn_id: id, last_agent_message: `${id} answer` }), tick(value++)),
    );
  }
  records.push(
    recordedAt(event('task_started', 0, { turn_id: 'carried-copy' }), tick(value++)),
    recordedAt(event('user_message', 0, { message: 'copied prompt' }), tick(value++)),
    recordedAt(
      event('task_complete', 0, {
        turn_id: 'carried-copy',
        last_agent_message: 'copied answer',
      }),
      tick(value++),
    ),
    recordedAt(event('task_started', 0, { turn_id: 'newest' }), tick(value++)),
    recordedAt(turnContext(0, 'newest', 'gpt-5.6-sol', 'high'), tick(value++)),
    recordedAt(
      {
        type: 'turn_context',
        payload: {
          turn_id: 'carried-copy',
          cwd: 'c:\\repo',
          model: 'gpt-5.6-sol',
          effort: 'high',
          current_date: '2026-08-26',
        },
      },
      tick(value++),
    ),
    recordedAt(event('user_message', 0, { message: 'newest prompt' }), tick(value++)),
    recordedAt(
      event('task_complete', 0, {
        turn_id: 'newest',
        last_agent_message: 'newest answer',
      }),
      tick(value++),
    ),
  );
  const file = writeRollout(records);
  const prompts: string[] = [];
  const carriedCounts: number[] = [];
  let cursor = null;
  do {
    const result = readCodexHistoryPage(file, 'child-thread', cursor, { chunkBytes: 80, targetTurns: 1 });
    assert.equal(result.kind, 'page');
    if (result.kind !== 'page') {
      break;
    }
    prompts.push(...result.page.turns.map((turn) => turn.prompt));
    cursor = result.page.nextOlderCursor;
    if (cursor) {
      carriedCounts.push(cursor.adapterState.copiedTurnIds.length);
    }
  } while (cursor);
  assert.deepEqual(
    { prompts, carriedCounts },
    {
      prompts: ['newest prompt', 'ancient-b prompt', 'ancient-a prompt'],
      carriedCounts: [1, 0],
    },
  );
});

test('Codex evidence scanning resolves a distant replay with bounded read amplification', () => {
  const records: object[] = [
    meta(),
    event('task_started', 1, { turn_id: 'repeated-across-pages' }),
    event('user_message', 2, { message: 'original prompt' }),
    event('task_complete', 3, { turn_id: 'repeated-across-pages', last_agent_message: 'original answer' }),
  ];
  for (let index = 0; index < 45; index += 1) {
    const second = 4 + index * 4;
    const id = `complete-middle-${index}`;
    records.push(
      event('task_started', second, { turn_id: id }),
      turnContext(second + 1, id, 'gpt-5.6-sol', 'high'),
      event('user_message', second + 2, { message: `middle prompt ${index}` }),
      event('task_complete', second + 3, { turn_id: id, last_agent_message: `middle answer ${index}` }),
    );
  }
  records.push(
    event('task_started', 184, { turn_id: 'repeated-across-pages' }),
    event('user_message', 185, { message: 'replayed prompt' }),
    event('task_complete', 186, { turn_id: 'repeated-across-pages', last_agent_message: 'replayed answer' }),
  );
  const file = writeRollout(records);
  const reads: Array<[number, number]> = [];
  const chunkBytes = 72;
  const pages = [];
  let cursor = null;
  do {
    const result = readCodexHistoryPage(
      file,
      'child-thread',
      cursor,
      {
        chunkBytes,
        targetTurns: 1,
        readRange: recordingCodexRangeReader(reads),
      },
      { maxTurns: 60 },
    );
    assert.equal(result.kind, 'page');
    if (result.kind !== 'page') {
      break;
    }
    pages.push(result.page);
    cursor = result.page.nextOlderCursor;
  } while (cursor);
  const paged = [...pages].reverse().flatMap((page) => page.turns);
  assert.deepEqual(paged, readCodexSession(file, 'child-thread', { maxTurns: 60 }).turns);
  assert.deepEqual(
    paged.map((turn) => turn.prompt),
    ['original prompt', ...Array.from({ length: 45 }, (_value, index) => `middle prompt ${index}`)],
  );
  const sourceBytes = fs.statSync(file).size;
  const readBytes = reads.reduce((sum, [start, end]) => sum + end - start, 0);
  assert.ok(readBytes <= sourceBytes * 3, `evidence scan read ${readBytes} bytes from a ${sourceBytes}-byte source`);
  assert.ok(
    reads.length <= Math.ceil(sourceBytes / chunkBytes) * 3,
    `evidence scan issued ${reads.length} reads for ${sourceBytes} bytes`,
  );
});

test('consecutive ambiguous Codex replays share one bounded evidence scan', () => {
  const replayCount = 12;
  const middleCount = 20;
  const records: object[] = [meta()];
  let second = 1;
  for (let index = 0; index < replayCount; index++) {
    const id = `batched-replay-${index}`;
    records.push(
      event('task_started', second++, { turn_id: id }),
      event('user_message', second++, { message: `original prompt ${index}` }),
      event('task_complete', second++, { turn_id: id, last_agent_message: `original answer ${index}` }),
    );
  }
  for (let index = 0; index < middleCount; index++) {
    const id = `batched-middle-${index}`;
    records.push(
      event('task_started', second++, { turn_id: id }),
      turnContext(second++, id, 'gpt-5.6-sol', 'high'),
      event('user_message', second++, { message: `middle prompt ${index}` }),
      event('task_complete', second++, { turn_id: id, last_agent_message: `middle answer ${index}` }),
    );
  }
  for (let index = 0; index < replayCount; index++) {
    const id = `batched-replay-${index}`;
    records.push(
      event('task_started', second++, { turn_id: id }),
      event('user_message', second++, { message: `copied prompt ${index}` }),
      event('task_complete', second++, { turn_id: id, last_agent_message: `copied answer ${index}` }),
    );
  }
  const file = writeRollout(records);
  const reads: Array<[number, number]> = [];
  const chunkBytes = 64;
  const pages = [];
  let cursor = null;
  do {
    const result = readCodexHistoryPage(
      file,
      'child-thread',
      cursor,
      {
        chunkBytes,
        targetTurns: 1,
        readRange: recordingCodexRangeReader(reads),
      },
      { maxTurns: 80 },
    );
    assert.equal(result.kind, 'page');
    if (result.kind !== 'page') {
      break;
    }
    pages.push(result.page);
    cursor = result.page.nextOlderCursor;
  } while (cursor);
  const paged = [...pages].reverse().flatMap((page) => page.turns);
  const oneShot = readCodexSession(file, 'child-thread', { maxTurns: 80 });
  assert.deepEqual(paged, oneShot.turns);
  const sourceBytes = fs.statSync(file).size;
  const readBytes = reads.reduce((sum, [start, end]) => sum + end - start, 0);
  assert.ok(
    readBytes < sourceBytes * 3,
    `consecutive evidence read ${readBytes} bytes from a ${sourceBytes}-byte source across ${reads.length} reads`,
  );
  assert.ok(
    reads.length < Math.ceil(sourceBytes / chunkBytes) * 3,
    `consecutive evidence issued ${reads.length} reads for ${sourceBytes} bytes`,
  );
});

test('Codex page evidence ignores missing and empty ids but resolves duplicate nonempty ids', () => {
  const idlessReads: Array<[number, number]> = [];
  const idlessFile = writeRollout([
    { type: 'ignored-prefix', payload: 'q'.repeat(20 * 1024) },
    event('task_started', 1),
    event('user_message', 2, { message: 'missing id prompt' }),
    event('task_complete', 3, { last_agent_message: 'missing id answer' }),
    event('task_started', 4, { turn_id: '' }),
    event('user_message', 5, { message: 'empty id prompt' }),
    event('task_complete', 6, { turn_id: '', last_agent_message: 'empty id answer' }),
  ]);
  let idlessCursor = null;
  do {
    const result = readCodexHistoryPage(idlessFile, 'sess', idlessCursor, {
      chunkBytes: 512,
      targetTurns: 1,
      readRange: recordingCodexRangeReader(idlessReads),
    });
    assert.equal(result.kind, 'page');
    if (result.kind !== 'page') {
      break;
    }
    idlessCursor = result.page.nextOlderCursor;
  } while (idlessCursor);
  for (let index = 1; index < idlessReads.length; index += 1) {
    assert.equal(idlessReads[index][1], idlessReads[index - 1][0]);
  }

  const records = [
    meta(),
    event('task_started', 1),
    event('user_message', 2, { message: 'missing id prompt' }),
    event('task_complete', 3, { last_agent_message: 'missing id answer' }),
    event('task_started', 4, { turn_id: '' }),
    event('user_message', 5, { message: 'empty id prompt' }),
    event('task_complete', 6, { turn_id: '', last_agent_message: 'empty id answer' }),
    event('task_started', 7, { turn_id: 'duplicate-real-id' }),
    event('user_message', 8, { message: 'original duplicate prompt' }),
    event('task_complete', 9, { turn_id: 'duplicate-real-id', last_agent_message: 'original answer' }),
    event('task_started', 10, { turn_id: 'middle-real-id' }),
    turnContext(11, 'middle-real-id', 'gpt-5.6-sol', 'high'),
    event('user_message', 12, { message: 'middle prompt' }),
    event('task_complete', 13, { turn_id: 'middle-real-id', last_agent_message: 'middle answer' }),
    event('task_started', 14, { turn_id: 'duplicate-real-id' }),
    event('user_message', 15, { message: 'copied duplicate prompt' }),
    event('task_complete', 16, { turn_id: 'duplicate-real-id', last_agent_message: 'copied answer' }),
  ];
  const file = writeRollout(records);
  const pages = [];
  let cursor = null;
  do {
    const result = readCodexHistoryPage(file, 'sess', cursor, { chunkBytes: 75, targetTurns: 1 });
    assert.equal(result.kind, 'page');
    if (result.kind !== 'page') {
      break;
    }
    pages.push(result.page);
    cursor = result.page.nextOlderCursor;
    assert.ok(!cursor?.adapterState.copiedTurnIds.includes(''));
  } while (cursor);
  const paged = [...pages].reverse().flatMap((page) => page.turns);
  assert.deepEqual(paged, readCodexSession(file, 'sess').turns);
  assert.deepEqual(
    paged.map((turn) => turn.prompt),
    ['missing id prompt', 'empty id prompt', 'original duplicate prompt', 'middle prompt'],
  );
});

test('three Codex history pages have exact disjoint reads and stable identities', () => {
  const records: object[] = [meta()];
  for (let index = 0; index < 4; index++) {
    const id = `turn-${index}`;
    const second = index * 8;
    records.push(
      event('task_started', second + 1, { turn_id: id }),
      turnContext(second + 2, id, 'gpt-5.6-sol', 'high'),
      event('user_message', second + 3, { message: `prompt ${index} ${'y'.repeat(180)}` }),
      item('custom_tool_call', second + 4, {
        name: 'exec',
        call_id: `paged-codex-${index}`,
        input: `const r = await tools.exec_command({cmd:"echo codex-${index}"});`,
      }),
      toolOutput(second + 5, `paged-codex-${index}`, 'Script completed\nExit code: 0\nOutput:\nok'),
      event('task_complete', second + 6, { turn_id: id, last_agent_message: `answer ${index}` }),
    );
    if (index === 0) {
      records.push(event('compacted', second + 7));
    }
  }
  const file = writeRollout(records);
  const reads: Array<[number, number]> = [];
  const pages = [];
  let cursor = null;
  do {
    const result = readCodexHistoryPage(file, 'sess', cursor, {
      chunkBytes: 97,
      targetTurns: 1,
      readRange: recordingCodexRangeReader(reads),
    });
    assert.equal(result.kind, 'page');
    if (result.kind !== 'page') {
      break;
    }
    pages.push(result.page);
    cursor = result.page.nextOlderCursor;
  } while (cursor && pages.length < 10);
  assert.equal(pages.length, 4);
  for (let index = 1; index < reads.length; index++) {
    assert.equal(reads[index][1], reads[index - 1][0]);
  }
  for (let index = 1; index < pages.length; index++) {
    assert.equal(pages[index].ownedRange.end, pages[index - 1].ownedRange.start);
  }
  const paged = [...pages].reverse().flatMap((page) => page.turns);
  const oneShot = readCodexSession(file, 'sess');
  assert.deepEqual(paged, oneShot.turns);
  assert.deepEqual(
    [...pages].reverse().flatMap((page) => page.compactions),
    oneShot.compactions,
  );
  assert.equal(new Set(paged.map((turn) => turn.promptId)).size, paged.length);
  for (let turnIndex = 0; turnIndex < paged.length; turnIndex++) {
    for (let stepIndex = 0; stepIndex < paged[turnIndex].steps.length; stepIndex++) {
      for (const key of ['id', 'fullDetail'] as const) {
        const actual = Object.getOwnPropertyDescriptor(paged[turnIndex].steps[stepIndex], key);
        const expected = Object.getOwnPropertyDescriptor(oneShot.turns[turnIndex].steps[stepIndex], key);
        assert.deepEqual(actual?.value, expected?.value);
        assert.equal(actual?.enumerable, false);
        assert.equal(expected?.enumerable, false);
      }
    }
  }
});

test('Codex semantic pages materialize child spend like a one-shot read', () => {
  const records = [
    meta(),
    event('task_started', 1, { turn_id: 'spend-page' }),
    turnContext(2, 'spend-page', 'gpt-5.6-sol', 'high'),
    event('user_message', 3, { message: 'delegate with spend' }),
    item('function_call', 4, {
      name: 'spawn_agent',
      call_id: 'spend-call',
      arguments: JSON.stringify({ task_name: 'worker', message: 'do it' }),
    }),
    event('sub_agent_activity', 5, {
      event_id: 'spend-call',
      agent_thread_id: 'child-spend',
      agent_path: '/root/worker',
      kind: 'running',
    }),
    event('task_complete', 6, { turn_id: 'spend-page', last_agent_message: 'done' }),
  ];
  const file = writeRollout(records);
  const opts = {
    agentSpendOf: () => ({
      models: [
        {
          model: 'gpt-5.6-sol',
          provider: null,
          contextWindow: 258_400,
          usage: {
            requests: 1,
            input: 2,
            cacheWrite1h: 0,
            cacheWrite5m: 0,
            cacheWrite30m: 0,
            cacheRead: 3,
            output: 4,
            thinking: 0,
          },
        },
      ],
      found: true,
      partial: false,
      effort: null,
    }),
  };
  const page = readCodexHistoryPage(file, 'sess', null, { chunkBytes: 1024 * 1024 }, opts);
  assert.equal(page.kind, 'page');
  assert.deepEqual(page.page?.turns, readCodexSession(file, 'sess', opts).turns);
});

test('a Codex page keeps the next task start as lookahead for an abrupt older turn', () => {
  const file = writeRollout([
    meta(),
    event('task_started', 1, { turn_id: 'older-abrupt' }),
    turnContext(2, 'older-abrupt', 'gpt-5.6-sol', 'high'),
    event('user_message', 3, { message: 'older abrupt turn' }),
    item('custom_tool_call', 4, {
      name: 'exec',
      call_id: 'abrupt-codex',
      input: 'const r = await tools.exec_command({cmd:"echo older"});',
    }),
    event('task_started', 5, { turn_id: 'newer-closed' }),
    turnContext(6, 'newer-closed', 'gpt-5.6-sol', 'high'),
    event('user_message', 7, { message: 'newer closed turn' }),
    event('task_complete', 8, { turn_id: 'newer-closed', last_agent_message: 'newer answer' }),
  ]);
  const pages = [];
  let cursor = null;
  do {
    const result = readCodexHistoryPage(file, 'sess', cursor, { chunkBytes: 80, targetTurns: 1 });
    assert.equal(result.kind, 'page');
    if (result.kind !== 'page') {
      break;
    }
    pages.push(result.page);
    cursor = result.page.nextOlderCursor;
  } while (cursor);
  const paged = [...pages].reverse().flatMap((page) => page.turns);
  const expected = readCodexSession(file, 'sess').turns;
  assert.deepEqual(paged, expected);
  assert.equal((paged[0].steps[0] as { id?: string }).id, (expected[0].steps[0] as { id?: string }).id);
  assert.equal(Object.getOwnPropertyDescriptor(paged[0].steps[0], 'id')?.enumerable, false);
  assert.equal(
    (paged[0].steps[0] as { fullDetail?: string }).fullDetail,
    (expected[0].steps[0] as { fullDetail?: string }).fullDetail,
  );
  assert.equal(Object.getOwnPropertyDescriptor(paged[0].steps[0], 'fullDetail')?.enumerable, false);
});

test('Codex history keeps an open turn in checkpoint-owned state', () => {
  const openTurn = 'open-turn';
  const records = [
    ...ordinaryTurn(),
    event('task_started', 9, { turn_id: openTurn }),
    turnContext(10, openTurn, 'gpt-5.6-sol', 'high'),
    event('user_message', 11, { message: 'keep working' }),
  ];
  const file = writeRollout(records);
  const page = readCodexHistoryPage(file, 'sess', null, { chunkBytes: 64, targetTurns: 20 });
  assert.equal(page.kind, 'page');
  assert.deepEqual(
    page.page?.turns.map((turn) => turn.promptId),
    [TURN],
  );
  assert.ok(page.openRange);
  const checkpoint = readCodexSessionIncremental(file, 'sess');
  assert.deepEqual(
    checkpoint.read?.turns.map((turn) => turn.promptId),
    [TURN, openTurn],
  );
  assert.ok(checkpoint.read);
  assert.ok(page.page);
  const revision = revisionOf(fs.statSync(file, { bigint: true }));
  const applied = afterHistoryPage(
    startSessionHistory({ sessionId: 'sess', size: revision.size, mtimeMs: revision.mtimeMs }, 1),
    {
      kind: 'page',
      turns: page.page.turns,
      compactions: page.page.compactions,
      cursor: page.page.nextOlderCursor,
      ownedRange: page.page.ownedRange,
      openRange: page.openRange,
    },
    checkpoint.read,
    2,
  );
  assert.equal(applied.history.atBeginning, true);
  assert.deepEqual(
    applied.history.coverage?.openRange,
    page.openRange,
    'history state dropped the parser range that keeps the open turn covered',
  );
  const outside = historyRecordsOutside(applied.history.pages, checkpoint.read);
  const visibleKeys = [...checkpoint.read.turns, ...outside.turns].map(turnKey);
  assert.equal(
    new Set(visibleKeys).size,
    visibleKeys.length,
    'one Codex turn identity appears in both the current tail and retained pages',
  );
  assert.deepEqual(
    applied.history.pages,
    [],
    'history retained a completed turn that the current Codex tail already owns',
  );
});

test('a turn runs from task_started to task_complete, and carries what it was asked and what it answered', () => {
  const { turns } = readCodexSession(writeRollout(ordinaryTurn()), 'sess');
  assert.equal(turns.length, 1);
  const turn = turns[0];
  assert.equal(turn.promptId, TURN);
  assert.equal(turn.prompt, 'fix the parser');
  assert.equal(turn.summary, '- fixed the parser');
  assert.equal(turn.model, 'gpt-5.6-sol');
  assert.equal(turn.effort, 'high');
  assert.equal(turn.startedAt, ms(1));
  assert.equal(turn.endedAt, ms(8));
  assert.equal(turn.finished, true);
  assert.equal(turn.interrupted, false);
  assert.equal(turn.error, null);
  assert.equal(turn.toolUses, 1);
  assert.deepEqual(turn.toolCounts, {
    edits: 0,
    reads: 0,
    searches: 0,
    commands: 1,
    agents: 0,
    coordination: 0,
    web: 0,
    other: 0,
  });
  assert.deepEqual(
    turn.files.map((f) => [f.path, f.added, f.removed, f.isNew]),
    [['c:\\repo\\src\\a.ts', 2, 1, false]],
  );
});

test('one Codex tail read returns both its activity and newest outcome', () => {
  const records = ordinaryTurn();
  const file = writeRollout(records);
  assert.deepEqual(readCodexSessionActivity(file), {
    coverage: { whole: true, windowBytes: 256 * 1024 },
    activityMs: ms(8),
    outcome: { finished: true, error: false, interrupted: false, endedAt: ms(8), startedAt: ms(1) },
  });
  assert.equal(
    readCodexSessionActivity(file, 20).outcome,
    null,
    'a tail that cannot reach task_started does not guess at the newest turn',
  );
});

test('Codex metadata statistics use the parser over the tail already in memory', () => {
  const file = writeRollout(ordinaryTurn());
  const meta = readCodexSessionMeta(file);
  const parsed = readCodexSession(file, 'sess', { tailBytes: 256 * 1024, maxTurns: 40 });
  const activity = readCodexSessionActivity(file, 256 * 1024, { sessionId: 'sess', meta });
  assert.deepEqual(activity.stats, sessionStatFactsOf(parsed));
  assert.equal(
    readCodexSessionActivity(file, 20, { sessionId: 'sess', meta }).stats,
    null,
    'a tail that cannot reach task_started supplies no rail figures',
  );
});

test('a Codex answer alone makes both the card and metadata outcome drawable', () => {
  const file = writeRollout([
    meta(),
    event('task_started', 1, { turn_id: TURN }),
    event('task_complete', 2, { turn_id: TURN, last_agent_message: 'Here is the answer.' }),
  ]);
  assert.equal(readCodexSession(file, 'sess').turns.length, 1);
  assert.deepEqual(readCodexSessionActivity(file).outcome, {
    finished: true,
    error: false,
    interrupted: false,
    endedAt: ms(2),
    startedAt: ms(1),
  });
});

test('a Codex abort closes its outcome before a later completion record', () => {
  const file = writeRollout([
    meta(),
    event('task_started', 1, { turn_id: TURN }),
    event('user_message', 2, { message: 'stop this task' }),
    event('turn_aborted', 3, { turn_id: TURN, reason: 'interrupted' }),
    event('task_complete', 4, { turn_id: TURN, last_agent_message: 'late completion' }),
  ]);
  const card = readCodexSession(file, 'sess').turns[0];
  assert.deepEqual(readCodexSessionActivity(file).outcome, {
    finished: card.finished,
    error: card.error !== null,
    interrupted: card.interrupted,
    endedAt: card.endedAt,
    startedAt: card.startedAt,
  });
  assert.equal(card.endedAt, ms(3));
});

test('a Codex patch outcome needs a visible file change', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['empty changes', {}],
    [
      'ephemeral changes',
      {
        [path.join(os.homedir(), '.codex', 'config.toml')]: {
          type: 'update',
          unified_diff: '@@ -1 +1 @@\n-old\n+new\n',
          move_path: null,
        },
      },
    ],
  ];
  for (const [what, changes] of cases) {
    const file = writeRollout([
      meta(),
      event('task_started', 1, { turn_id: TURN }),
      event('patch_apply_end', 2, { turn_id: TURN, success: true, changes }),
      event('task_complete', 3, { turn_id: TURN, last_agent_message: '' }),
    ]);
    assert.equal(readCodexSession(file, 'sess').turns.length, 0, what);
    assert.equal(readCodexSessionActivity(file).outcome, null, what);
  }
});

test('a Codex metadata outcome follows every visible parsed update', () => {
  const cases: [string, object][] = [
    [
      'commentary message',
      item('message', 3, {
        id: 'commentary',
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'output_text', text: 'Checking the current change.' }],
      }),
    ],
    [
      'completed agent narration',
      event('item_completed', 3, {
        item: {
          type: 'AgentMessage',
          id: 'completed-commentary',
          phase: 'commentary',
          content: [{ type: 'Text', text: 'Running the focused tests.' }],
        },
      }),
    ],
    [
      'reasoning record',
      item('reasoning', 3, {
        id: 'reasoning',
        summary: [{ type: 'summary_text', text: 'The transcript is complete.' }],
      }),
    ],
  ];
  for (const [what, update] of cases) {
    const file = writeRollout([meta(), event('task_started', 1, { turn_id: TURN }), update]);
    const card = readCodexSession(file, 'sess').turns[0];
    assert.deepEqual(
      readCodexSessionActivity(file).outcome,
      {
        finished: card.finished,
        error: card.error !== null,
        interrupted: card.interrupted,
        endedAt: card.endedAt,
        startedAt: card.startedAt,
      },
      what,
    );
    assert.equal(card.endedAt, ms(3), what);
  }
});

test('late Codex commentary keeps a metadata outcome running', () => {
  const late = 7200;
  const file = writeRollout([
    meta(),
    event('task_started', 1, { turn_id: TURN }),
    event('user_message', 2, { message: 'keep working' }),
    item('message', late, {
      id: 'late-commentary',
      role: 'assistant',
      phase: 'commentary',
      content: [{ type: 'output_text', text: 'Still checking the final result.' }],
    }),
  ]);
  const card = readCodexSession(file, 'sess').turns[0];
  const outcome = readCodexSessionActivity(file).outcome!;
  assert.equal(outcome.endedAt, card.endedAt);
  assert.equal(statusOf(outcome, true, ms(late) + TURN_QUIET_MS), 'running');
});

test('an empty newer Codex turn does not hide the newest drawable outcome', () => {
  const failed = [
    meta(),
    event('task_started', 1, { turn_id: TURN }),
    event('user_message', 2, { message: 'keep the earlier failure visible' }),
    event('task_complete', 3, { turn_id: TURN, last_agent_message: '', error: { message: 'request failed' } }),
  ];
  const cases: [string, object[]][] = [
    ['open', [...failed, event('task_started', 4, { turn_id: 'empty-open' })]],
    [
      'completed',
      [
        ...failed,
        event('task_started', 4, { turn_id: 'empty-complete' }),
        event('task_complete', 5, { turn_id: 'empty-complete', last_agent_message: '' }),
      ],
    ],
  ];
  for (const [what, records] of cases) {
    const file = writeRollout(records);
    const newestCard = readCodexSession(file, 'sess').turns.at(-1)!;
    assert.deepEqual(
      readCodexSessionActivity(file).outcome,
      {
        finished: newestCard.finished,
        error: newestCard.error !== null,
        interrupted: newestCard.interrupted,
        endedAt: newestCard.endedAt,
        startedAt: newestCard.startedAt,
      },
      what,
    );
  }
});

test('a Codex metadata outcome keeps the parser end time for every activity record', () => {
  const base = () => [
    meta(),
    event('task_started', 1, { turn_id: TURN }),
    event('user_message', 2, { message: 'keep going' }),
  ];
  const cases: [string, object[], number][] = [
    ['tool output', [...base(), toolOutput(3, 'call_x', 'done')], 3],
    [
      'completed command',
      [
        ...base(),
        item('custom_tool_call', 3, { name: 'exec', call_id: 'call_x', input: '{}' }),
        commandCompleted(4, 'Get-ChildItem'),
      ],
      4,
    ],
    [
      'completed file change',
      [
        ...base(),
        item('custom_tool_call', 3, { name: 'exec', call_id: 'call_x', input: '{}' }),
        event('item_completed', 4, {
          item: {
            type: 'FileChange',
            id: 'change_x',
            status: 'completed',
            changes: { 'c:\\repo\\src\\a.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-old\n+new\n' } },
          },
        }),
      ],
      4,
    ],
    ['subagent activity', [...base(), event('sub_agent_activity', 3, { event_id: 'call_x', kind: 'started' })], 3],
    [
      'final child message',
      [
        ...base(),
        item('agent_message', 3, {
          author: '/root/review_sol',
          content: [{ type: 'input_text', text: 'Message Type: FINAL_ANSWER' }],
        }),
      ],
      3,
    ],
  ];
  for (const [what, records, second] of cases) {
    const file = writeRollout(records);
    assert.equal(
      readCodexSessionActivity(file).outcome?.endedAt,
      readCodexSession(file, 'sess').turns[0].endedAt,
      what,
    );
    assert.equal(readCodexSessionActivity(file).outcome?.endedAt, ms(second), what);
  }
});

test('a turn says which agent recorded it and what window it actually ran against', () => {
  const { turns } = readCodexSession(writeRollout(ordinaryTurn()), 'sess');
  assert.equal(turns[0].agent, 'codex');
  // The turn retains its recorded context limit rather than a model catalog maximum.

  assert.equal(turns[0].contextWindow, 258400);
});

test('the window comes from the turn’s opening record, and again from its last request', () => {
  // Use different context limits on the opening and request records so either missing read changes the result.

  const opener = ordinaryTurn();
  opener[7] = event('token_count', 7, { info: { last_token_usage: usage({ input_tokens: 10 }) } });
  assert.equal(readCodexSession(writeRollout(opener), 'sess').turns[0].contextWindow, 258400);

  const moved = ordinaryTurn();
  moved[7] = event('token_count', 7, {
    info: { last_token_usage: usage({ input_tokens: 10 }), model_context_window: 353400 },
  });
  // The last request wins. A model swapped part-way through moves the window, and the
  // request that set it is the one the context count beside it was measured against.
  assert.equal(readCodexSession(writeRollout(moved), 'sess').turns[0].contextWindow, 353400);
});

test('a session says which agent wrote it, so a merged list can tell two of them apart', () => {
  const root = sessionsRoot([{ day: '2026/08/25', name: ROLLOUT(UUID_A), records: [meta({ id: UUID_A })] }]);
  assert.deepEqual(
    codexSessionFiles(root, ['c:\\repo']).sessions.map((s) => s.agent),
    ['codex'],
  );
});

test('a window the turn never recorded is left for the price table to answer', () => {
  const records = ordinaryTurn();
  records[1] = event('task_started', 1, { turn_id: TURN });
  records[7] = event('token_count', 7, {
    info: { last_token_usage: { input_tokens: 20003, cached_input_tokens: 11008, output_tokens: 225 } },
  });
  const { turns } = readCodexSession(writeRollout(records), 'sess');
  assert.equal(turns[0].contextWindow, null);
});

test('an interrupted turn is closed by the abort, and says it did not finish', () => {
  const records = ordinaryTurn().slice(0, -1);
  records.push(event('turn_aborted', 9, { turn_id: TURN, reason: 'interrupted', duration_ms: 1590 }));
  const { turns } = readCodexSession(writeRollout(records), 'sess');
  assert.equal(turns.length, 1);
  assert.equal(turns[0].interrupted, true);
  assert.equal(turns[0].finished, false);
  assert.equal(turns[0].endedAt, ms(9));
  // The turn still carries what it managed before it was stopped.
  assert.equal(turns[0].files.length, 1);
});

test('a turn with no task_complete is the one still running', () => {
  const records = ordinaryTurn().slice(0, -1);
  const { turns } = readCodexSession(writeRollout(records), 'sess');
  assert.equal(turns.length, 1);
  assert.equal(turns[0].finished, false);
  assert.equal(turns[0].interrupted, false);
  assert.equal(turns[0].summary, '');
  // The last record it did write is how far the turn has got.
  assert.equal(turns[0].endedAt, ms(7));
});

test('a request the service refused is what the turn failed on', () => {
  const records = ordinaryTurn();
  records[records.length - 1] = event('task_complete', 8, {
    turn_id: TURN,
    last_agent_message: '',
    error: {
      message: 'You’ve hit your usage limit.\nTry again later.',
      codex_error_info: 'usage_limit_exceeded',
    },
  });
  const { turns } = readCodexSession(writeRollout(records), 'sess');
  // Recorded as an object rather than as text, so reading the field straight across would
  // put no error on a turn that plainly had one.
  assert.equal(turns[0].error, 'You’ve hit your usage limit.');
});

test('a failed request hides cache guidance after a later tool result', () => {
  const file = writeRollout([
    meta({ model_provider: 'openai' }),
    event('task_started', 1, { turn_id: TURN }),
    turnContext(1, TURN, 'gpt-5.6-sol', 'high'),
    event('user_message', 1, { message: 'inspect the large result' }),
    tokens(2, { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 }),
    item('custom_tool_call', 3, { name: 'exec', call_id: 'call_x', input: '{}' }),
    toolOutput(4, 'call_x', 'a large result that the earlier request did not measure'),
    event('task_complete', 5, {
      turn_id: TURN,
      last_agent_message: '',
      error: { message: 'request failed' },
    }),
  ]);
  const read = readCodexSession(file, 'sess');
  const newest = read.turns[0];
  assert.equal(
    nextTurnBasisOf(newest, null),
    null,
    'the composer quoted the request before the unmeasured tool result',
  );
  assert.equal(
    railCacheMarkOf(sessionStatFactsOf(read), ms(3)),
    null,
    'the rail marked the stale request cache as ready for the next turn',
  );
});

test('a failure the service sent as its own envelope reaches the card as a sentence', () => {
  const envelope = JSON.stringify({
    type: 'error',
    status: 400,
    error: {
      type: 'invalid_request_error',
      message: "The 'gpt-5-sol' model is not supported when using Codex with a ChatGPT account.",
    },
  });
  // The session reader must unwrap the service error envelope before storing the turn error.

  const records = ordinaryTurn();
  records[records.length - 1] = event('task_complete', 8, {
    turn_id: TURN,
    last_agent_message: '',
    error: { message: envelope, codex_error_info: 'other' },
  });
  const { turns } = readCodexSession(writeRollout(records), 'sess');
  assert.equal(turns[0].error, "The 'gpt-5-sol' model is not supported when using Codex with a ChatGPT account.");
  // What the reader has to act on is inside it. Left as written, the card would open with a
  // status code and a type name and say nothing about the model.
  assert.equal(
    errorMessage(envelope),
    "The 'gpt-5-sol' model is not supported when using Codex with a ChatGPT account.",
  );
  // Most failures are already a sentence, and a sentence is not to be searched for a field.
  assert.equal(errorMessage('You’ve hit your usage limit.'), 'You’ve hit your usage limit.');
  // Something that opens like an envelope and is not one is still the message.
  assert.equal(errorMessage('{ this is not JSON'), '{ this is not JSON');
  assert.equal(errorMessage('{"status":500}'), '{"status":500}');
});

test('a turn whose start is outside the window is dropped rather than half drawn', () => {
  // Only the closing half of a turn, as a tail window cutting mid-turn would leave it.
  const records = [
    event('user_message', 3, { message: 'fix the parser' }),
    event('task_complete', 8, { turn_id: TURN, last_agent_message: 'done' }),
    event('task_started', 9, { turn_id: 'second', model_context_window: 258400 }),
    event('user_message', 10, { message: 'now the other one' }),
    event('task_complete', 11, { turn_id: 'second', last_agent_message: 'done again' }),
  ];
  const { turns } = readCodexSession(writeRollout(records), 'sess');
  assert.deepEqual(
    turns.map((t) => t.prompt),
    ['now the other one'],
  );
});

test('the selected Codex session discovers its newest complete turn', async () => {
  const latest = '01a032c9-1e07-78b2-ae0c-dc76f2dd7902';
  const records = [
    meta(),
    event('task_started', 1, { turn_id: TURN }),
    event('user_message', 2, { message: 'older turn' }),
    item('custom_tool_call', 3, { name: 'exec', call_id: 'old', input: '{}' }),
    toolOutput(4, 'old', 'x'.repeat(5000)),
    event('task_complete', 5, { turn_id: TURN, last_agent_message: 'older answer' }),
    event('task_started', 6, { turn_id: latest }),
    event('user_message', 7, { message: 'newest turn' }),
    item('custom_tool_call', 8, { name: 'exec', call_id: 'new', input: '{}' }),
    toolOutput(9, 'new', 'y'.repeat(1500)),
    event('task_complete', 10, { turn_id: latest, last_agent_message: 'newest answer' }),
  ];
  const file = writeRollout(records);

  const initial = readCodexSession(file, 'sess', { tailBytes: 256, prepareNewestTurnDiscovery: true });
  assert.deepEqual(initial.turns, [], 'an ordinary tail that starts mid-turn drew a partial card');
  assert.ok(initial.newestTurnCursor);
  const found = await discoverCodexNewestTurn(file, initial.newestTurnCursor, initial.newestTurnState, {
    chunkBytes: 257,
    pause: async () => {},
  });
  assert.equal(found.kind, 'found');
  if (found.kind !== 'found') {
    return;
  }
  const recovered = readCodexSession(file, 'sess', { tailBytes: found.readBytes });
  assert.deepEqual(
    recovered.turns.map((turn) => [turn.prompt, turn.summary]),
    [['newest turn', 'newest answer']],
  );
});

test('a retained Codex tail keeps a running turn beside its later compaction', async () => {
  const file = writeRollout([
    meta(),
    event('task_started', 1, { turn_id: TURN, model_context_window: 258400 }),
    event('user_message', 2, { message: 'keep this turn unread' }),
    item('custom_tool_call', 3, { name: 'exec', call_id: 'wide', input: '{}' }),
    toolOutput(4, 'wide', 'x'.repeat(5000)),
    { timestamp: at(5), type: 'compacted', payload: { message: '', replacement_history: [], window_number: 2 } },
    event('agent_message_delta', 6, { delta: 'still working' }),
  ]);

  const ordinary = readCodexSession(file, 'sess', {
    tailBytes: 512,
    prepareNewestTurnDiscovery: true,
  });
  assert.deepEqual(ordinary.turns, []);
  assert.equal(ordinary.compactions.length, 1);
  assert.ok(ordinary.newestTurnCursor);

  const found = await discoverCodexNewestTurn(file, ordinary.newestTurnCursor, ordinary.newestTurnState, {
    chunkBytes: 257,
    pause: async () => {},
  });
  assert.equal(found.kind, 'found');
  if (found.kind !== 'found') {
    return;
  }

  const retained = readCodexSession(file, 'sess', { tailBytes: found.readBytes });
  assert.equal(retained.compactions.length, 1);
  assert.equal(retained.turns.length, 1);
  assert.equal(retained.turns[0].finished, false);
  assert.equal(turnKey(retained.turns[0]), `sess:${ms(1)}`);
});

test('newest-turn discovery ignores a late completion after an empty abort', async () => {
  const file = writeRollout([
    meta(),
    event('task_started', 1, { turn_id: 'older' }),
    event('user_message', 2, { message: 'older turn' }),
    event('task_complete', 3, { turn_id: 'older', last_agent_message: 'older answer' }),
    event('task_started', 4, { turn_id: 'empty' }),
    event('turn_aborted', 5, { turn_id: 'empty', reason: 'replaced' }),
    toolOutput(6, 'late', 'x'.repeat(5000)),
    event('task_complete', 7, { turn_id: 'empty', last_agent_message: 'late completion' }),
  ]);
  const initial = readCodexSession(file, 'sess', { tailBytes: 256, prepareNewestTurnDiscovery: true });
  assert.deepEqual(initial.turns, []);
  assert.ok(initial.newestTurnCursor);
  const found = await discoverCodexNewestTurn(file, initial.newestTurnCursor, initial.newestTurnState, {
    chunkBytes: 257,
    pause: async () => {},
  });
  assert.equal(found.kind, 'found');
  if (found.kind !== 'found') {
    return;
  }
  assert.deepEqual(
    readCodexSession(file, 'sess', { tailBytes: found.readBytes }).turns.map((turn) => turn.prompt),
    ['older turn'],
  );
});

test('a new Codex message does not shrink away turns already read from the selected session', async () => {
  const second = '01a032c9-1e07-78b2-ae0c-dc76f2dd7902';
  const third = '01a032c9-1e07-78b2-ae0c-dc76f2dd7903';
  const records = [
    meta(),
    event('task_started', 1, { turn_id: TURN }),
    event('user_message', 2, { message: 'first message' }),
    event('task_complete', 3, { turn_id: TURN, last_agent_message: 'first answer' }),
    event('task_started', 4, { turn_id: second }),
    event('user_message', 5, { message: 'second message' }),
    item('custom_tool_call', 6, { name: 'exec', call_id: 'long', input: '{}' }),
    toolOutput(7, 'long', 'x'.repeat(5000)),
    event('task_complete', 8, { turn_id: second, last_agent_message: 'second answer' }),
  ];
  const file = writeRollout(records);
  const initial = readCodexSession(file, 'sess', { tailBytes: 512, prepareNewestTurnDiscovery: true });
  assert.ok(initial.newestTurnCursor);
  const found = await discoverCodexNewestTurn(file, initial.newestTurnCursor, initial.newestTurnState, {
    chunkBytes: 256,
    pause: async () => {},
  });
  assert.equal(found.kind, 'found');
  if (found.kind !== 'found') {
    return;
  }
  const recovered = readCodexSession(file, 'sess', { tailBytes: found.readBytes });
  assert.deepEqual(
    recovered.turns.map((turn) => turn.prompt),
    ['second message'],
  );

  const appended =
    [
      event('task_started', 9, { turn_id: third }),
      event('user_message', 10, { message: 'third message' }),
      event('task_complete', 11, { turn_id: third, last_agent_message: 'third answer' }),
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n';
  fs.appendFileSync(file, appended);
  assert.deepEqual(
    readCodexSession(file, 'sess', {
      tailBytes: 512,
    }).turns.map((turn) => turn.prompt),
    ['third message'],
    'the fixture no longer reproduces the ordinary tail shrinking after a new turn',
  );
  const retained = readCodexSession(file, 'sess', {
    tailBytes: recovered.readBytes + Buffer.byteLength(appended),
  });
  assert.deepEqual(
    retained.turns.map((turn) => turn.prompt),
    ['second message', 'third message'],
  );
});

test('a new Codex turn at the turn limit keeps every turn already shown', () => {
  const turn = (n: number) => [
    event('task_started', n * 3 + 1, { turn_id: `turn-${n}` }),
    event('user_message', n * 3 + 2, { message: `message ${n}` }),
    event('task_complete', n * 3 + 3, { turn_id: `turn-${n}`, last_agent_message: `answer ${n}` }),
  ];
  const file = writeRollout([meta(), ...turn(1), ...turn(2), ...turn(3)]);
  const first = readCodexSession(file, 'sess', { maxTurns: 3 });
  assert.equal(first.turnLimitReached, false);
  const retained = {
    identity: 'sess',
    size: fs.statSync(file).size,
    bytes: first.readBytes,
    maxTurns: 3,
    turnKeys: first.turns.map(turnKey),
    fingerprint: 'fixture',
  };

  fs.appendFileSync(
    file,
    turn(4)
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  const capped = readCodexSession(file, 'sess', { maxTurns: 3 });
  assert.equal(capped.turnLimitReached, true);
  assert.deepEqual(
    capped.turns.map((item) => item.prompt),
    ['message 2', 'message 3', 'message 4'],
    'the fixture no longer reaches the parser limit and displaces the oldest shown turn',
  );
  const expanded = readCodexSession(file, 'sess', {
    maxTurns: retainedTurnLimit(3, capped.turns.map(turnKey), retained),
  });
  assert.deepEqual(
    expanded.turns.map((item) => item.prompt),
    ['message 1', 'message 2', 'message 3', 'message 4'],
  );
  assert.equal(expanded.turnLimitReached, false);
});

test('newest-turn discovery continues across every chunk needed for its boundary', async () => {
  const records = ordinaryTurn();
  records.splice(-1, 0, toolOutput(8, 'call_a', 'x'.repeat(3000)));
  const file = writeRollout(records);
  const initial = readCodexSession(file, 'sess', { tailBytes: 256, prepareNewestTurnDiscovery: true });
  assert.deepEqual(initial.turns, []);
  assert.ok(initial.newestTurnCursor);
  const found = await discoverCodexNewestTurn(file, initial.newestTurnCursor, initial.newestTurnState, {
    chunkBytes: 128,
    pause: async () => {},
  });
  assert.equal(found.kind, 'found');
  if (found.kind !== 'found') {
    return;
  }
  assert.ok(found.readBytes > 1024, 'the fixture no longer crosses several discovery chunks');
  assert.deepEqual(
    readCodexSession(file, 'sess', { tailBytes: found.readBytes }).turns.map((turn) => turn.prompt),
    ['fix the parser'],
  );
});

// The byte size this fixture has to beat, so its newest turn is larger than any bounded tail
// the panel reads on its own.
const OVER_CEILING_BYTES = 32 * 1024 * 1024;

test('a selected Codex turn larger than the history ceiling opens without a reader press', async () => {
  const records: object[] = [
    meta(),
    event('task_started', 1, { turn_id: TURN }),
    event('user_message', 2, { message: 'the over-ceiling turn' }),
    item('custom_tool_call', 3, { name: 'exec', call_id: 'wide', input: '{}' }),
  ];
  const wide = 'x'.repeat(256 * 1024);
  for (let i = 0; i < 129; i += 1) {
    records.push(toolOutput(4 + i, 'wide', wide));
  }
  records.push(event('task_complete', 140, { turn_id: TURN, last_agent_message: 'finished' }));
  const file = writeRollout(records);
  assert.ok(fs.statSync(file).size > OVER_CEILING_BYTES);

  const initial = readCodexSession(file, 'sess', {
    tailBytes: 4 * 1024 * 1024,
    prepareNewestTurnDiscovery: true,
  });
  assert.deepEqual(initial.turns, []);
  assert.ok(initial.newestTurnCursor);
  let yields = 0;
  const found = await discoverCodexNewestTurn(file, initial.newestTurnCursor, initial.newestTurnState, {
    pause: async () => {
      yields += 1;
    },
  });
  assert.equal(found.kind, 'found');
  assert.ok(yields > 20, 'the scanner no longer yields between bounded reads');
  if (found.kind !== 'found') {
    return;
  }
  assert.ok(found.readBytes > OVER_CEILING_BYTES);
  assert.deepEqual(
    readCodexSession(file, 'sess', { tailBytes: found.readBytes }).turns.map((turn) => turn.prompt),
    ['the over-ceiling turn'],
  );
});

test('a turn asked over and over keeps the newest, the way the Claude reader does', () => {
  // Keep only the newest later prompts up to TURN_ASK_LIMIT.

  const records = ordinaryTurn();
  const extra = [];
  for (let i = 0; i < TURN_ASK_LIMIT + 3; i += 1) {
    extra.push(event('user_message', 3 + i, { message: `ask ${i}` }));
  }
  records.splice(4, 0, ...extra);
  const { turns } = readCodexSession(writeRollout(records), 'sess');
  const kept = turns[0].laterPrompts;
  assert.equal(kept.length, TURN_ASK_LIMIT, 'a Codex turn asked over and over drew every one of them');
  assert.equal(kept[0].text, 'ask 3');
  assert.equal(kept[kept.length - 1].text, `ask ${TURN_ASK_LIMIT + 2}`);
});

test('two prompts inside one turn both reach the card, and are told apart', () => {
  // The opening prompt and the later prompt retain separate text and timestamps within one turn.

  const records = ordinaryTurn();
  records.splice(4, 0, event('user_message', 3, { message: 'and keep the tests green' }));
  const { turns } = readCodexSession(writeRollout(records), 'sess');
  assert.equal(turns[0].prompt, 'fix the parser');
  assert.deepEqual(
    turns[0].laterPrompts.map((a) => a.text),
    ['and keep the tests green'],
  );
  assert.ok(turns[0].laterPrompts[0].at > 0, 'a mid-turn prompt reached the card with no time on it');
});

test('current user message records supply the prompt, later asks, title and turn start', () => {
  const records = ordinaryTurn();
  records.splice(
    3,
    1,
    message('developer', 2, 'internal orchestration'),
    message('assistant', 2, 'I can help', 'output_text'),
    message('user', 2, '<recommended_plugins>internal context</recommended_plugins>', 'input_text', [
      'plugins.recommendations',
    ]),
    message(
      'user',
      3,
      [
        '# Context from my IDE setup:',
        '## Open tabs:',
        '- codex.ts',
        '## My request for Codex:',
        'show the prompt on the card',
      ].join('\n'),
      'input_text',
      ['user.text'],
    ),
    message('user', 4, 'and keep the command beside Ran', 'input_text', ['user.text']),
  );
  const file = writeRollout(records);
  const { turns } = readCodexSession(file, 'sess');
  assert.equal(turns[0].prompt, 'show the prompt on the card');
  assert.deepEqual(
    turns[0].laterPrompts.map((ask) => ask.text),
    ['and keep the command beside Ran'],
  );
  assert.equal(readCodexSessionTitle(file), 'show the prompt on the card');
  assert.deepEqual(readCodexTurnStarts(file), { starts: [ms(1)], whole: true });
});

test('a Codex subagent turn keeps its recorded assignment when the parent instructions are encrypted', () => {
  const task = '/root/compare_lineage_branch';
  const records = [
    meta({
      id: 'child-thread',
      parent_thread_id: 'parent-thread',
      thread_source: 'subagent',
      agent_path: task,
      source: { subagent: { thread_spawn: { parent_thread_id: 'parent-thread', agent_path: task } } },
    }),
    event('task_started', 1, { turn_id: 'child-turn' }),
    turnContext(2, 'child-turn', 'gpt-5.6-sol', 'high'),
    { timestamp: at(3), type: 'inter_agent_communication_metadata', payload: { trigger_turn: true } },
    item('agent_message', 4, {
      author: '/root',
      recipient: task,
      content: [
        { type: 'input_text', text: `Message Type: NEW_TASK\nTask name: ${task}\nSender: /root\nPayload:\n` },
        { type: 'encrypted_content', encrypted_content: 'ciphertext' },
      ],
    }),
    event('task_complete', 5, { turn_id: 'child-turn', last_agent_message: 'Compared the branches.' }),
  ];
  const file = writeRollout(records);
  const [turn] = readCodexSession(file, 'child-thread').turns;
  assert.equal(turn.prompt, '');
  assert.deepEqual(turn.delegation, { text: task, complete: false });
  assert.equal(readCodexSessionTitle(file), task);

  const active = readCodexSession(writeRollout(records.slice(0, -1)), 'child-thread').turns;
  assert.equal(active.length, 1, 'the assignment alone did not make the active turn drawable');
  assert.deepEqual(readCodexTurnStarts(file), { starts: [ms(1)], whole: true });
});

test('a Codex subagent turn keeps readable assignment instructions', () => {
  const task = '/root/implement_parser';
  const file = writeRollout([
    meta({ id: 'child-thread', parent_thread_id: 'parent-thread', thread_source: 'subagent', agent_path: task }),
    event('task_started', 1, { turn_id: 'child-turn' }),
    turnContext(2, 'child-turn', 'gpt-5.6-sol', 'high'),
    item('agent_message', 3, {
      author: '/root',
      recipient: task,
      content: [
        {
          type: 'input_text',
          text: [
            'Message Type: NEW_TASK',
            `Task name: ${task}`,
            'Sender: /root',
            'Payload:',
            'Fix the parser and run its focused tests.',
          ].join('\n'),
        },
      ],
    }),
    event('task_complete', 4, { turn_id: 'child-turn', last_agent_message: 'Done.' }),
  ]);
  const [turn] = readCodexSession(file, 'child-thread').turns;
  assert.equal(turn.prompt, '');
  assert.deepEqual(turn.delegation, { text: 'Fix the parser and run its focused tests.', complete: true });
  assert.equal(readCodexSessionTitle(file), 'Fix the parser and run its focused tests.');
});

test('a Codex subagent keeps readable assignment text incomplete when another block is encrypted', () => {
  const task = '/root/implement_parser';
  const file = writeRollout([
    meta({ id: 'child-thread', parent_thread_id: 'parent-thread', thread_source: 'subagent', agent_path: task }),
    event('task_started', 1, { turn_id: 'child-turn' }),
    turnContext(2, 'child-turn', 'gpt-5.6-sol', 'high'),
    item('agent_message', 3, {
      author: '/root',
      recipient: task,
      content: [
        {
          type: 'input_text',
          text: [
            'Message Type: NEW_TASK',
            `Task name: ${task}`,
            'Sender: /root',
            'Payload:',
            'Fix the parser and run its focused tests.',
          ].join('\n'),
        },
        { type: 'encrypted_content', encrypted_content: 'ciphertext' },
      ],
    }),
    event('task_complete', 4, { turn_id: 'child-turn', last_agent_message: 'Done.' }),
  ]);
  const [turn] = readCodexSession(file, 'child-thread').turns;
  assert.deepEqual(turn.delegation, {
    text: 'Fix the parser and run its focused tests.',
    complete: false,
  });
  assert.equal(readCodexSessionTitle(file), 'Fix the parser and run its focused tests.');
});

test('a completed assignment-only Codex turn reaches lifetime count and outcome metadata', () => {
  const task = '/root/review_parser';
  const records = [
    meta({ id: 'child-thread', parent_thread_id: 'parent-thread', thread_source: 'subagent', agent_path: task }),
    event('task_started', 1, { turn_id: 'child-turn' }),
    turnContext(2, 'child-turn', 'gpt-5.6-sol', 'high'),
    item('agent_message', 3, {
      author: '/root',
      recipient: task,
      content: [
        {
          type: 'input_text',
          text: [
            'Message Type: NEW_TASK',
            `Task name: ${task}`,
            'Sender: /root',
            'Payload:',
            'Review the parser.',
          ].join('\n'),
        },
      ],
    }),
    event('task_complete', 4, { turn_id: 'child-turn', last_agent_message: '' }),
  ];
  const reducer = createCodexUsageLineReducer();
  for (const record of records) {
    reducer.pushLine(JSON.stringify(record));
  }
  assert.equal(reducer.turnCount(), 1);
  assert.deepEqual(reducer.newestTurnOutcome(), {
    finished: true,
    error: false,
    interrupted: false,
    startedAt: ms(1),
    endedAt: ms(4),
  });
});

test('ordinary and invalid agent messages are not Codex subagent assignments', () => {
  const task = '/root/implement_parser';
  const messages = [
    {
      recipient: task,
      text: 'Message Type: FINAL_ANSWER\nTask name: /root/implement_parser\nSender: /root\nPayload:\nDone.',
    },
    { recipient: task, text: 'Message Type: NEW_TASK\nTask name: /root/implement_parser\nPayload:\nMissing sender.' },
    {
      recipient: '/root/another_agent',
      text: 'Message Type: NEW_TASK\nTask name: /root/implement_parser\nSender: /root\nPayload:\nWrong recipient.',
    },
    { recipient: task, text: 'Please inspect the parser.' },
  ];
  for (const [index, message] of messages.entries()) {
    const file = writeRollout([
      meta({ id: 'child-thread', parent_thread_id: 'parent-thread', thread_source: 'subagent', agent_path: task }),
      event('task_started', 1, { turn_id: `child-turn-${index}` }),
      turnContext(2, `child-turn-${index}`, 'gpt-5.6-sol', 'high'),
      item('agent_message', 3, {
        author: '/root',
        recipient: message.recipient,
        content: [{ type: 'input_text', text: message.text }],
      }),
      event('task_complete', 4, { turn_id: `child-turn-${index}`, last_agent_message: 'Done.' }),
    ]);
    assert.equal(readCodexSession(file, 'child-thread').turns[0].delegation, undefined, message.text);
  }
});

// Tool-related words admit these records through the fast filter. Role and block checks must still reject them as prompts.

test('only input text from a current user message is treated as a prompt', () => {
  const records = ordinaryTurn();
  records.splice(
    3,
    1,
    message('developer', 2, 'task_complete closes the turn', 'input_text'),
    message('assistant', 2, 'the turn ends on task_complete', 'output_text'),
    message('user', 3, 'why is task_complete late', 'output_text'),
  );
  const file = writeRollout(records);
  const { turns } = readCodexSession(file, 'sess');
  assert.equal(turns[0].prompt, '');
  assert.equal(readCodexSessionTitle(file), null);
});

// Codex puts the text the reader typed in the same message as the context it injected, and
// names each block apart in the metadata. The block the reader wrote is the prompt and the
// rest is not, so the card cannot open on a plugin list.
test('a user message mixing injected context with typed text keeps only the typed text', () => {
  const records = ordinaryTurn();
  records.splice(
    3,
    1,
    item('message', 3, {
      role: 'user',
      content: [
        { type: 'input_text', text: '<recommended_plugins>internal context</recommended_plugins>' },
        { type: 'input_text', text: 'read the command off the record' },
      ],
      internal_chat_message_metadata_passthrough: {
        content_item_kinds: ['plugins.recommendations', 'user.text'],
      },
    }),
  );
  const file = writeRollout(records);
  assert.equal(readCodexSession(file, 'sess').turns[0].prompt, 'read the command off the record');
  assert.equal(readCodexSessionTitle(file), 'read the command off the record');
});

// Some current rollouts omit the per-block kind metadata. Their injected messages retain
// the client-owned wrappers, which keep them apart from what the reader wrote.
test('current messages without kind metadata skip client-injected context', () => {
  const records = ordinaryTurn();
  records.splice(
    3,
    1,
    item('message', 3, {
      role: 'user',
      content: [
        { type: 'input_text', text: '<recommended_plugins>internal context</recommended_plugins>' },
        { type: 'input_text', text: '# AGENTS.md instructions for C:\\repo\n<INSTRUCTIONS>internal</INSTRUCTIONS>' },
        { type: 'input_text', text: '<environment_context>internal</environment_context>' },
        { type: 'input_text', text: '<permissions instructions>internal</permissions instructions>' },
        { type: 'input_text', text: '<apps_instructions>internal</apps_instructions>' },
        { type: 'input_text', text: '<plugins_instructions>internal</plugins_instructions>' },
        { type: 'input_text', text: '<skills_instructions>internal</skills_instructions>' },
        { type: 'input_text', text: 'The following is the Codex agent history from an earlier turn.' },
        { type: 'input_text', text: 'keep only what I typed' },
      ],
    }),
  );
  const file = writeRollout(records);
  assert.equal(readCodexSession(file, 'sess').turns[0].prompt, 'keep only what I typed');
  assert.equal(readCodexSessionTitle(file), 'keep only what I typed');
});

// OpenAI input_tokens includes cached input. Subtract cached tokens before pricing uncached input.

test('cached input is taken out of the input count rather than charged twice', () => {
  const { turns } = readCodexSession(writeRollout(ordinaryTurn()), 'sess');
  const u = turns[0].usage;
  // 20003 was billed in all, of which 11008 came from the cache: 8995 at the base rate.
  assert.equal(u.input, 8995);
  assert.equal(u.cacheRead, 11008);
  // Read straight across, `input` would be 20003 and the total prompt would come to 31011.
  assert.notEqual(u.input, 20003);
  assert.equal(u.input + u.cacheRead, 20003);
  // This request records no cache write, so neither Claude cache-write tier is populated.
  assert.equal(u.cacheWrite1h, 0);
  assert.equal(u.cacheWrite5m, 0);
  assert.equal(u.output, 225);
  assert.equal(u.thinking, 96);
  assert.equal(u.requests, 1);
  // The context a turn reached is the whole prompt it last sent, cache included.
  assert.equal(turns[0].contextTokens, 20003);
});

test('a Bedrock turn separates cache writes from uncached input and keeps its provider', () => {
  const records = ordinaryTurn();
  records[0] = meta({ model_provider: 'amazon-bedrock' });
  records[2] = turnContext(2, TURN, 'openai.gpt-5.6-sol', 'high');
  records[7] = tokens(7, {
    input_tokens: 56568,
    cached_input_tokens: 35714,
    cache_write_input_tokens: 20562,
    output_tokens: 807,
    reasoning_output_tokens: 190,
  });
  const turn = readCodexSession(writeRollout(records), 'sess').turns[0];
  assert.equal(turn.provider, 'amazon-bedrock');
  assert.equal(turn.model, 'openai.gpt-5.6-sol');
  assert.equal(turn.usage.input, 292);
  assert.equal(turn.usage.cacheRead, 35714);
  assert.equal(turn.usage.cacheWrite30m, 20562);
  assert.equal(turn.usage.input + turn.usage.cacheRead + (turn.usage.cacheWrite30m ?? 0), 56568);
  assert.equal(turn.usage.output, 807);
  assert.equal(turn.usage.thinking, 190);
});

test('Bedrock GPT-6.1 and GPT-6 recorded usage retains routes and costs in both request bands', () => {
  for (const [model, expected] of [
    ['openai.gpt-6-astra', [2.035, 2.035, 5.005]],
    ['us.openai.gpt-6-astra', [2.035, 2.035, 5.005]],
    ['global.openai.gpt-6-astra', [1.85, 1.85, 4.55]],
    ['openai.gpt-6.1-sol', [0.396, 0.396, 0.968]],
    ['us.openai.gpt-6.1-sol', [0.396, 0.396, 0.968]],
    ['global.openai.gpt-6.1-sol', [0.36, 0.36, 0.88]],
    ['openai.gpt-6-sol', [0.407, 0.407, 1.001]],
    ['us.openai.gpt-6-sol', [0.407, 0.407, 1.001]],
    ['global.openai.gpt-6-sol', [0.37, 0.37, 0.91]],
    ['openai.gpt-6-luna', [0.02035, 0.02035, 0.05005]],
    ['us.openai.gpt-6-luna', [0.02035, 0.02035, 0.05005]],
    ['global.openai.gpt-6-luna', [0.0185, 0.0185, 0.0455]],
  ] as const) {
    const records: object[] = [
      meta({ model_provider: 'amazon-bedrock' }),
      {
        type: 'thread_settings_applied',
        timestamp: at(0),
        payload: { thread_settings: { model_provider_id: 'amazon-bedrock', service_tier: 'default' } },
      },
    ];
    for (const [index, inputTokens] of [220_000, 220_000, 320_000].entries()) {
      const second = index * 10;
      const turnId = `bedrock-${index}`;
      records.push(
        event('task_started', second + 1, { turn_id: turnId, model_context_window: 1_000_000 }),
        turnContext(second + 2, turnId, model, 'high'),
        event('user_message', second + 3, { message: 'price this request' }),
        tokens(second + 4, {
          input_tokens: inputTokens,
          cached_input_tokens: index === 2 ? 150_000 : 100_000,
          cache_write_input_tokens: 20_000,
          output_tokens: 10_000,
          reasoning_output_tokens: 0,
        }),
        event('task_complete', second + 5, { turn_id: turnId, last_agent_message: 'done' }),
      );
    }
    const file = writeRollout(records);
    const { turns } = readCodexSession(file, 'sess');
    assert.equal(turns.length, 3);
    for (const [index, turn] of turns.entries()) {
      assert.equal(turn.model, model);
      assert.equal(turn.provider, 'amazon-bedrock');
      assert.equal(turn.contextWindow, 258_400);
      assert.equal(turn.contextRequest?.lifetime, model.endsWith('astra') ? null : '30m');
      assert.equal(turn.usage.input, index === 2 ? 150_000 : 100_000);
      assert.equal(turn.usage.cacheWrite30m, 20_000);
      assert.equal(turn.usage.cacheRead, index === 2 ? 150_000 : 100_000);
      assert.equal(turn.usageParts?.[0]?.serviceTier, 'default');
      const route = model.startsWith('global.') ? 'global' : model.startsWith('us.') ? 'geo' : 'in-region';
      assert.equal(turn.usageParts?.[0]?.inferenceClass, route, model);
      assert.equal(turn.contextRequest?.inferenceClass, route, model);
      assert.equal(turn.usageParts?.[0]?.contextBand, index === 2 ? 'long' : 'short');
      const cost = turnCost(turn);
      assert.equal(cost?.partial, false);
      assert.ok(
        cost && cost.dollars !== null && Math.abs(cost.dollars - expected[index]) < 1e-12,
        `${model}: ${cost?.dollars}`,
      );
    }
    const spend = readCodexAgentSpend(file);
    assert.equal(spend.found, true);
    assert.equal(spend.partial, false);
    assert.equal(spend.models[0]?.usage.byContextBand?.short?.requests, 2);
    assert.equal(spend.models[0]?.usage.byContextBand?.long?.requests, 1);
    assert.equal(spend.models[0]?.usage.cacheWrite30m, 60_000);
    assert.equal(spend.models[0]?.usage.cacheRead, 350_000);
    const compacted = readCodexSession(
      writeRollout([
        ...records,
        {
          timestamp: at(30),
          type: 'compacted',
          payload: {
            message: '',
            replacement_history: [],
            window_number: 2,
            latest_token_usage_record: {
              usage: usage({
                input_tokens: 320_000,
                cached_input_tokens: 150_000,
                cache_write_input_tokens: 20_000,
                output_tokens: 10_000,
                reasoning_output_tokens: 0,
              }),
            },
          },
        },
        {
          timestamp: at(31),
          type: 'thread_settings_applied',
          payload: {
            thread_settings: { model, model_provider_id: 'amazon-bedrock', service_tier: 'default' },
          },
        },
      ]),
      'sess',
    ).compactions[0];
    assert.equal(
      compacted?.inferenceClass,
      model.startsWith('global.') ? 'global' : model.startsWith('us.') ? 'geo' : 'in-region',
      model,
    );
    assert.equal(compacted?.contextBefore, 320_000, model);
    assert.equal(
      toCompactionCard(compacted).chips.find((chip) => chip.label.startsWith('$'))?.label,
      `$${expected[2].toFixed(2)}`,
      model,
    );
  }
});

test('usage is summed over every request the turn made', () => {
  const records = ordinaryTurn();
  // An earlier request in the same turn, so the context the turn reached is still the last.
  records.splice(
    7,
    0,
    tokens(5, { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50, reasoning_output_tokens: 10 }),
  );
  const { turns } = readCodexSession(writeRollout(records), 'sess');
  const u = turns[0].usage;
  assert.equal(u.input, 600 + 8995);
  assert.equal(u.cacheRead, 400 + 11008);
  assert.equal(u.output, 50 + 225);
  assert.equal(u.thinking, 10 + 96);
  assert.equal(u.requests, 2);
  // Not a sum: the context is where the session stood when the turn ended.
  assert.equal(turns[0].contextTokens, 20003);
});

test('request pricing bands survive when a Codex turn crosses the long-context threshold', () => {
  const records = ordinaryTurn();
  records[2] = turnContext(2, TURN, 'gpt-5.5', 'high');
  records[7] = event('token_count', 7, {
    info: {
      last_token_usage: usage({ input_tokens: 300_001, output_tokens: 20_000 }),
      model_context_window: 1_050_000,
    },
  });
  records.splice(
    7,
    0,
    event('token_count', 5, {
      info: {
        last_token_usage: usage({ input_tokens: 100_000, output_tokens: 10_000 }),
        model_context_window: 1_050_000,
      },
    }),
  );
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  assert.equal(turn.contextWindow, 1_050_000);
  assert.deepEqual(turn.usage.byContextBand, {
    short: {
      requests: 1,
      input: 100_000,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      cacheWrite30m: 0,
      cacheRead: 0,
      output: 10_000,
      thinking: 0,
    },
    long: {
      requests: 1,
      input: 300_001,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      cacheWrite30m: 0,
      cacheRead: 0,
      output: 20_000,
      thinking: 0,
    },
  });
});

test('cache reads and writes count toward the Codex request pricing boundary', () => {
  const records = ordinaryTurn();
  records[2] = turnContext(2, TURN, 'gpt-5.6-sol', 'high');
  records[7] = tokens(7, {
    input_tokens: 272_001,
    cached_input_tokens: 100_000,
    cache_write_input_tokens: 72_000,
    output_tokens: 0,
  });
  records.splice(
    7,
    0,
    tokens(5, {
      input_tokens: 272_000,
      cached_input_tokens: 100_000,
      cache_write_input_tokens: 72_000,
      output_tokens: 0,
    }),
  );
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  assert.deepEqual(turn.usage.byContextBand, {
    short: {
      requests: 1,
      input: 100_000,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      cacheWrite30m: 72_000,
      cacheRead: 100_000,
      output: 0,
      thinking: 0,
    },
    long: {
      requests: 1,
      input: 100_001,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      cacheWrite30m: 72_000,
      cacheRead: 100_000,
      output: 0,
      thinking: 0,
    },
  });
});

test('the prompt is what the user typed, with the editor state the extension wrapped it in taken off', () => {
  const wrapped = [
    '# Context from my IDE setup:',
    '',
    '## Active file: .mcp.json',
    '## Active selection of the file:',
    '    "blender-mcp": { "command": "blender-mcp" }',
    '## Open tabs:',
    '- .mcp.json: .mcp.json',
    '',
    '## My request for Codex:',
    'merge the two armatures',
  ].join('\n');
  assert.equal(codexPrompt(wrapped), 'merge the two armatures');
  // A prompt from the CLI carries no wrapper and is already what was typed.
  assert.equal(codexPrompt('just this'), 'just this');
  // Diagnostic text in a Claude local-command element stays in a Codex prompt.
  assert.equal(
    codexPrompt('Explain <local-command-stderr>Connection refused</local-command-stderr>'),
    'Explain Connection refused',
  );
});

test('a rollout with no session_meta at its head says nothing about itself', () => {
  const file = writeRollout([event('task_started', 1, { turn_id: TURN })]);
  assert.equal(readCodexSessionMeta(file), null);
});

test('the opening record says which project the session ran in and who started it', () => {
  const file = writeRollout(ordinaryTurn());
  const read = readCodexSessionMeta(file);
  assert.equal(read?.sessionId, '01a032c9-1a92-7931-845c-723117d24dbe');
  assert.equal(read?.cwd, 'c:\\repo');
  assert.equal(read?.modelProvider, null);
  assert.equal(read?.openedAt, ms(0));
  assert.equal(read?.replayBoundaryAt, ms(0));
  assert.equal(read?.launchSource, 'vscode');
  assert.equal(read?.threadSource, 'user');
  // A user session: `source` is a string, and no parent thread is named.
  assert.equal(read?.parentThreadId, null);
  assert.equal(read?.agentPath, null);
  assert.equal(read?.subagentKind, null);
  assert.equal(read?.hasSubagentSource, false);
});

// An opening record that carries long base instructions, padded to about `bytes` long.
function longOpening(bytes: number): object {
  return meta({ base_instructions: { text: 'x'.repeat(bytes) } });
}

test('an opening record that ends the file with no newline is the first line', () => {
  // A long record read first leaves its bytes, and a newline, in the shared read buffer.
  assert.equal(readCodexSessionMeta(writeRollout([longOpening(60 * 1024), ordinaryTurn()[1]]))?.cwd, 'c:\\repo');
  const dir = tempDir('codex-');
  const file = path.join(dir, 'rollout-2026-08-25T12-00-00-01a032c9-1a92-7931-845c-723117d24dbe.jsonl');
  fs.writeFileSync(file, JSON.stringify(meta({ cwd: '/short' })));
  assert.equal(readCodexSessionMeta(file)?.cwd, '/short');
});

test('an opening record longer than the first read is read whole', () => {
  const read = readCodexSessionMeta(writeRollout([longOpening(40 * 1024), ...ordinaryTurn().slice(1)]));
  assert.equal(read?.cwd, 'c:\\repo');
  assert.equal(read?.openedAt, ms(0));
});

test('an opening record longer than the head window is no opening record', () => {
  assert.equal(readCodexSessionMeta(writeRollout([longOpening(200 * 1024), ...ordinaryTurn().slice(1)])), null);
});

test('the asynchronous opening read answers what the synchronous one does at every edge', async () => {
  const unterminated = path.join(tempDir('codex-'), ROLLOUT(UUID_A));
  fs.writeFileSync(unterminated, JSON.stringify(meta({ cwd: '/short' })));
  const files = [
    unterminated,
    writeRollout([longOpening(40 * 1024), ...ordinaryTurn().slice(1)]),
    writeRollout([longOpening(200 * 1024), ...ordinaryTurn().slice(1)]),
  ];
  // One buffer across every read, as one lane of a cold pass uses it.
  const buf = Buffer.alloc(128 * 1024, 0x0a);
  for (const file of files) {
    assert.deepEqual(await readCodexSessionMetaAsync(file, buf), readCodexSessionMeta(file), file);
  }
  const missing = path.join(tempDir('codex-'), 'missing.jsonl');
  assert.equal(readCodexSessionMeta(missing), null);
  await assert.rejects(
    readCodexSessionMetaAsync(missing, buf),
    'a refused asynchronous read answered like a head with no record',
  );
});

test('the opening record carries the parent and the subagent source where they are there', () => {
  const spawned = readCodexSessionMeta(
    writeRollout([
      meta({ parent_thread_id: '01a032c9-aaaa-7000-8000-000000000001', source: { subagent: { other: 'guardian' } } }),
    ]),
  );
  assert.equal(spawned?.parentThreadId, '01a032c9-aaaa-7000-8000-000000000001');
  assert.equal(spawned?.agentPath, null, 'the guardian was given a path that it never recorded');
  assert.equal(spawned?.subagentKind, 'guardian');
  assert.equal(spawned?.hasSubagentSource, true);
  // An empty parent is no parent, and a string source is no subagent source.
  const bare = readCodexSessionMeta(writeRollout([meta({ parent_thread_id: '', source: 'vscode' })]));
  assert.equal(bare?.parentThreadId, null);
  assert.equal(bare?.hasSubagentSource, false);
  // A structured source without a subagent object does not classify the session as a subagent.
  const other = readCodexSessionMeta(writeRollout([meta({ source: { ide: 'vscode' } })]));
  assert.equal(other?.hasSubagentSource, false);
  const child = readCodexSessionMeta(
    writeRollout([
      meta({
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: 'parent',
              agent_path: null,
              agent_nickname: 'Laplace',
              agent_role: 'explorer',
            },
          },
        },
      }),
    ]),
  );
  assert.equal(child?.parentThreadId, 'parent');
  assert.equal(child?.agentPath, null);
});

test('guardian metadata separates its payload clock from its delayed envelope', () => {
  const payloadTime = '2026-08-25T12:00:05.000Z';
  const envelopeTime = '2026-08-25T12:00:10.355Z';
  const legacy = readCodexSessionMeta(
    writeRollout([
      recordedAt(
        meta({
          thread_source: 'subagent',
          source: { subagent: { other: 'guardian' } },
          timestamp: payloadTime,
        }),
        envelopeTime,
      ),
    ]),
  );
  // A guardian's own turn records its start rounded down to the second, so the reducer's
  // five-second replay slack ends one second before the payload clock.
  const guardianBoundary = Date.parse(payloadTime) + 4_000;
  assert.equal(legacy?.openedAt, Date.parse(envelopeTime));
  assert.equal(legacy?.startedAt, Date.parse(payloadTime));
  assert.equal(legacy?.replayBoundaryAt, guardianBoundary);

  const current = readCodexSessionMeta(
    writeRollout([
      recordedAt(
        meta({
          thread_source: 'guardian_review',
          source: { subagent: { other: 'guardian' } },
          timestamp: payloadTime,
        }),
        envelopeTime,
      ),
    ]),
  );
  assert.equal(current?.openedAt, Date.parse(envelopeTime));
  assert.equal(current?.startedAt, Date.parse(payloadTime));
  assert.equal(current?.replayBoundaryAt, guardianBoundary);

  const dispatched = readCodexSessionMeta(
    writeRollout([
      recordedAt(
        meta({
          thread_source: 'subagent',
          source: { subagent: { thread_spawn: { parent_thread_id: 'sess', agent_path: '/root/review_sol' } } },
          timestamp: payloadTime,
        }),
        envelopeTime,
      ),
    ]),
  );
  assert.equal(dispatched?.startedAt, Date.parse(envelopeTime));
  assert.equal(dispatched?.replayBoundaryAt, Date.parse(envelopeTime));

  const malformed = readCodexSessionMeta(
    writeRollout([
      recordedAt(
        meta({
          thread_source: 'subagent',
          source: { subagent: { other: 'guardian' } },
          timestamp: 'not-a-time',
        }),
        envelopeTime,
      ),
    ]),
  );
  assert.equal(malformed?.startedAt, Date.parse(envelopeTime));
  assert.equal(malformed?.replayBoundaryAt, Date.parse(envelopeTime));
});

test('CODEX_HOME moves the rollout tree that session discovery reads', () => {
  const previousArc = process.env.ARC_CODEX_ROOT;
  const previousCodex = process.env.CODEX_HOME;
  const home = tempDir('codex-home-');
  const root = path.join(home, 'sessions', '2026', '08', '25');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, ROLLOUT(UUID_A)), JSON.stringify(meta({ id: UUID_A, cwd: 'c:\\repo' })) + '\n');
  try {
    delete process.env.ARC_CODEX_ROOT;
    process.env.CODEX_HOME = home;
    assert.deepEqual(
      codexSessionFiles(codexSessionsRoot(), ['c:\\repo']).sessions.map((session) => session.sessionId),
      [UUID_A],
    );
  } finally {
    if (previousArc === undefined) {
      delete process.env.ARC_CODEX_ROOT;
    } else {
      process.env.ARC_CODEX_ROOT = previousArc;
    }
    if (previousCodex === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodex;
    }
  }
});

test('the Arc Codex override wins, and an empty Codex home uses the home directory', () => {
  const previousArc = process.env.ARC_CODEX_ROOT;
  const previousCodex = process.env.CODEX_HOME;
  const codexHome = path.join('c:', 'codex-home');
  try {
    process.env.CODEX_HOME = codexHome;
    process.env.ARC_CODEX_ROOT = path.join('c:', 'elsewhere');
    assert.equal(codexSessionsRoot(), path.join('c:', 'elsewhere'));
    delete process.env.ARC_CODEX_ROOT;
    assert.equal(codexSessionsRoot(), path.join(codexHome, 'sessions'));
    process.env.CODEX_HOME = 'relative-codex-home';
    assert.equal(codexSessionsRoot(), path.join('relative-codex-home', 'sessions'));
    process.env.CODEX_HOME = '';
    assert.equal(codexSessionsRoot(), path.join(os.homedir(), '.codex', 'sessions'));
  } finally {
    if (previousArc === undefined) {
      delete process.env.ARC_CODEX_ROOT;
    } else {
      process.env.ARC_CODEX_ROOT = previousArc;
    }
    if (previousCodex === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodex;
    }
  }
});

test('the session is named after the first thing the user typed', () => {
  const file = writeRollout(ordinaryTurn());
  assert.equal(readCodexSessionTitle(file), 'fix the parser');
});

test('an image-bearing first prompt supplies normalized short and full session names', () => {
  const prompt =
    '**Compare** the screenshot with [the panel](docs/ui-design.md)\nand explain the missing session heading';
  const file = writeRollout([
    meta(),
    item('message', 1, {
      role: 'user',
      content: [
        {
          type: 'input_text',
          text:
            '# AGENTS.md instructions for C:/repo\n<INSTRUCTIONS>' +
            'injected-context '.repeat(9000) +
            '</INSTRUCTIONS>',
        },
      ],
    }),
    item('message', 2, {
      role: 'user',
      content: [{ type: 'input_text', text: '<environment_context>injected environment</environment_context>' }],
    }),
    item('message', 3, {
      role: 'user',
      content: [
        { type: 'input_text', text: prompt },
        { type: 'input_image', image_url: 'data:image/png;base64,' + 'A'.repeat(576978) },
      ],
    }),
  ]);
  const pair = readCodexSessionTitlePair(file);
  assert.deepEqual(pair, {
    short: 'Compare the screenshot with the panel and explain the mis...',
    full: 'Compare the screenshot with the panel and explain the missing session heading',
  });
  assert.ok(!JSON.stringify(pair).includes('injected'));
  assert.ok(!JSON.stringify(pair).includes('data:image'));
  assert.ok(!JSON.stringify(pair).includes('AAAA'));
});

test('a first prompt whose complete image record exceeds one MiB remains outside the title window', () => {
  const file = writeRollout([
    meta(),
    item('message', 1, {
      role: 'user',
      content: [
        { type: 'input_text', text: 'Compare this screenshot' },
        { type: 'input_image', image_url: 'data:image/png;base64,' + 'A'.repeat(1024 * 1024) },
      ],
    }),
  ]);
  assert.deepEqual(readCodexSessionTitlePair(file), { short: null, full: null });
  assert.deepEqual(readCodexSessionTitlePair(file, fs.statSync(file).size), {
    short: 'Compare this screenshot',
    full: 'Compare this screenshot',
  });
});

test('a Codex prompt title discards rich content instead of drawing it as text', () => {
  const rich = `\uE200visualize\uE202${JSON.stringify({ path: path.resolve('fixtures', 'rail.html') })}\uE201`;
  const titled = (prompt: string) => {
    const records = ordinaryTurn();
    records[3] = event('user_message', 3, { message: prompt });
    return readCodexSessionTitle(writeRollout(records));
  };
  assert.equal(titled(`Keep\n${rich}\nthis title`), 'Keep this title');
  assert.equal(titled(rich), null);
});

// Convert Markdown to plain title text before applying the sixty-unit limit.

test('a title made from a Markdown link names the text, not the syntax', () => {
  const titled = (message: string) => {
    const records = ordinaryTurn();
    records[3] = event('user_message', 3, { message });
    return readCodexSessionTitle(writeRollout(records));
  };
  // An escaped link opener still resolves to its visible skill name.

  assert.equal(titled('[$review-ai-pr]\\(/c:/skills/review-ai-pr/SKILL.md) check PR 12'), '$review-ai-pr check PR 12');
  assert.equal(
    titled('read [the architecture](docs/architecture.md) and `npm test` it'),
    'read the architecture and npm test it',
  );
  // Converted before the cut: the target alone is longer than a title, and the text fits.
  assert.equal(titled(`[a short name](${'x'.repeat(80)})`), 'a short name');
  // Literal marks are someone's real characters and stay.
  assert.equal(titled('rename foo_bar, then 2*3*4'), 'rename foo_bar, then 2*3*4');
});

test('a normalized title still fits sixty units and never ends on half a character', () => {
  const records = ordinaryTurn();
  records[3] = event('user_message', 3, { message: '**' + '\u{1F6A7}'.repeat(40) + '**' });
  const title = readCodexSessionTitle(writeRollout(records));
  assert.ok(title, 'the emphasis-only prompt produced no title at all');
  assert.ok(title.length <= 60, 'the normalized title runs past sixty units');
  const last = title.charCodeAt(title.length - 4);
  assert.ok(!(last >= 0xd800 && last <= 0xdbff), 'the cut left half a character before the ellipsis');
});

// Expected hunk coordinates remain independent of the parser output.

test('a unified diff becomes the hunks the diff view already speaks', () => {
  const diff = '@@ -10,3 +10,4 @@\n keep\n-out\n+in\n+more\n@@ -40,2 +41,2 @@\n-gone\n+here\n still\n';
  const hunks = hunksFromUnifiedDiff(diff);
  assert.equal(hunks.length, 2);
  assert.deepEqual(hunks[0], {
    oldStart: 10,
    oldLines: 3,
    newStart: 10,
    newLines: 4,
    lines: [' keep', '-out', '+in', '+more'],
  });
  assert.deepEqual(hunks[1], {
    oldStart: 40,
    oldLines: 2,
    newStart: 41,
    newLines: 2,
    lines: ['-gone', '+here', ' still'],
  });
});

test('a hunk header with no count covers one line', () => {
  const hunks = hunksFromUnifiedDiff('@@ -7 +7 @@\n-was\n+is\n');
  assert.deepEqual(hunks, [{ oldStart: 7, oldLines: 1, newStart: 7, newLines: 1, lines: ['-was', '+is'] }]);
});

// A trailing diff newline creates an empty split entry. A blank context line contains one space and must remain.

test('a blank line inside a hunk is kept and the trailing empty string is not', () => {
  const diff = '@@ -1,4 +1,4 @@\n first\n \n-third\n+3rd\n';
  const hunks = hunksFromUnifiedDiff(diff);
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0].lines, [' first', ' ', '-third', '+3rd']);
  // The fixture contains four hunk entries and three file lines on each side. Check entries without treating the header counts as measured lines.

  assert.equal(hunks[0].lines.length, 4);
});

test('a hunk carries exactly the lines its header counted', () => {
  const diff = '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n';
  const [hunk] = hunksFromUnifiedDiff(diff);
  const old = hunk.lines.filter((l) => l.startsWith(' ') || l.startsWith('-')).length;
  const now = hunk.lines.filter((l) => l.startsWith(' ') || l.startsWith('+')).length;
  assert.equal(old, 3);
  assert.equal(now, 3);
  assert.equal(hunk.oldLines, 3);
  assert.equal(hunk.newLines, 3);
});

test('an added file counts its whole text, and a removed one counts what went', () => {
  const records = ordinaryTurn();
  records[6] = event('patch_apply_end', 6, {
    call_id: 'exec-1',
    turn_id: TURN,
    success: true,
    changes: {
      'c:\\repo\\new.md': { type: 'add', content: 'one\ntwo\nthree\n' },
      'c:\\repo\\gone.md': { type: 'delete', content: 'a\nb\n' },
    },
  });
  const { turns } = readCodexSession(writeRollout(records), 'sess');
  const rows = new Map(turns[0].files.map((f) => [f.path, f]));
  assert.equal(rows.get('c:\\repo\\new.md')?.added, 3);
  assert.equal(rows.get('c:\\repo\\new.md')?.isNew, true);
  assert.equal(rows.get('c:\\repo\\gone.md')?.removed, 2);
  assert.equal(rows.get('c:\\repo\\gone.md')?.isNew, false);
  // A create carries its whole after side and a delete its whole before side, so the diff
  // view can draw both without reading a file that has since moved on.
  assert.equal(rows.get('c:\\repo\\new.md')?.edits[0].content, 'one\ntwo\nthree\n');
  assert.equal(rows.get('c:\\repo\\gone.md')?.edits[0].originalFile, 'a\nb\n');
  assert.equal(rows.get('c:\\repo\\gone.md')?.edits[0].content, '');
});

test('a renamed file is listed where it now is, not where it was', () => {
  const records = ordinaryTurn();
  records[6] = event('patch_apply_end', 6, {
    call_id: 'exec-1',
    turn_id: TURN,
    success: true,
    changes: {
      'c:\\repo\\old.md': { type: 'update', unified_diff: '@@ -1 +1 @@\n-was\n+is\n', move_path: 'c:\\repo\\new.md' },
    },
  });
  const { turns } = readCodexSession(writeRollout(records), 'sess');
  assert.deepEqual(
    turns[0].files.map((f) => f.path),
    ['c:\\repo\\new.md'],
  );
  const changed = turns[0].steps.find((step) => step.name === 'apply_patch');
  assert.equal(changed?.fullDetail, 'c:\\repo\\old.md\nc:\\repo\\new.md');
});

test('one file written twice under either case of drive letter is one row', () => {
  const records = ordinaryTurn();
  records[6] = event('patch_apply_end', 6, {
    call_id: 'exec-1',
    turn_id: TURN,
    success: true,
    changes: { 'c:\\repo\\src\\a.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-was\n+is\n', move_path: null } },
  });
  records.splice(
    7,
    0,
    event('patch_apply_end', 7, {
      call_id: 'exec-2',
      turn_id: TURN,
      success: true,
      changes: {
        'C:\\repo\\src\\a.ts': { type: 'update', unified_diff: '@@ -9 +9 @@\n-two\n+three\n', move_path: null },
      },
    }),
  );
  const { turns } = readCodexSession(writeRollout(records), 'sess');
  assert.equal(turns[0].files.length, 1);
  assert.equal(turns[0].files[0].added, 2);
  assert.equal(turns[0].files[0].removed, 2);
  assert.equal(turns[0].files[0].edits.length, 2);
});

test('a change under the agent’s own state is not a change the user asked to review', () => {
  const records = ordinaryTurn();
  records[6] = event('patch_apply_end', 6, {
    call_id: 'exec-1',
    turn_id: TURN,
    success: true,
    changes: {
      [path.join(os.homedir(), '.codex', 'config.toml')]: {
        type: 'update',
        unified_diff: '@@ -1 +1 @@\n-a\n+b\n',
        move_path: null,
      },
      'c:\\repo\\src\\a.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-a\n+b\n', move_path: null },
    },
  });
  const { turns } = readCodexSession(writeRollout(records), 'sess');
  assert.deepEqual(
    turns[0].files.map((f) => f.path),
    ['c:\\repo\\src\\a.ts'],
  );
});

test('refused patches stay visible as failed Activity steps and change nothing', () => {
  const records = ordinaryTurn();
  const refused = (second: number) =>
    event('patch_apply_end', second, {
      call_id: `exec-${second}`,
      turn_id: TURN,
      success: false,
      status: 'declined',
      stdout: '',
      stderr: 'This action was rejected due to unacceptable risk.',
      changes: { 'c:\\repo\\src\\a.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-a\n+b\n', move_path: null } },
    });
  records[6] = refused(6);
  records.splice(7, 0, refused(6.1), refused(6.2));
  const { turns } = readCodexSession(writeRollout(records), 'sess');
  assert.equal(turns[0].files.length, 0);
  assert.deepEqual(
    turns[0].failures,
    Array(3).fill({ tool: 'apply_patch', message: 'This action was rejected due to unacceptable risk.' }),
  );
  const activity = logOf(turns[0]).rows[0];
  assert.equal(activity.failed, 3);
  assert.equal(activity.figure, '3 failed');
  assert.deepEqual(
    activity.steps?.filter((step) => step.figure === 'failed').map((step) => [step.line, step.code, step.figure]),
    [
      ['Edited', 'c:\\repo\\src\\a.ts', 'failed'],
      ['Edited', 'c:\\repo\\src\\a.ts', 'failed'],
      ['Edited', 'c:\\repo\\src\\a.ts', 'failed'],
    ],
  );
  const card = toCard(turns[0], false, ms(9));
  assert.equal(
    card.chips.some((chip) => chip.label.includes('tool calls failed')),
    false,
  );
  assert.equal(
    card.marks.some((mark) => mark.id === 'failures'),
    false,
  );
});

// Only what says outright that something went wrong. Codex records no failure flag, and the
// exec sandbox reports a command that exited non-zero the same way it reports a script that
// threw, so the exit code has to be told apart from the error.
test('a command that exited non-zero is not a failed turn', () => {
  const grepped =
    'Script failed\nWall time 0.5 seconds\nOutput:\n\nScript error:\nExit code: 1\nWall time: 0.4 seconds\nOutput:\n';
  assert.equal(scriptFailure(grepped), null);
});

test('a script that threw is a failure, named by what it said', () => {
  const refused =
    'Script failed\nOutput:\n\nScript error:\napply_patch verification failed: Failed to read C:\\repo\\a.md\n';
  assert.equal(scriptFailure(refused), 'apply_patch verification failed: Failed to read C:\\repo\\a.md');
  assert.equal(scriptFailure('Script completed\nExit code: 0\n'), null);
});

test('a failure is named after the tool that produced it', () => {
  const records = ordinaryTurn();
  records[5] = toolOutput(5, 'call_a', 'Script failed\n\nScript error:\nReferenceError: btoa is not defined\n');
  const { turns } = readCodexSession(writeRollout(records), 'sess');
  assert.deepEqual(turns[0].failures, [{ tool: 'exec', message: 'ReferenceError: btoa is not defined' }]);
});

test('completed command records replace a bare exec row with each exact command', () => {
  const records = ordinaryTurn();
  records.splice(
    5,
    0,
    commandCompleted(5, 'npm test', 0, 'completed', 'exec-first'),
    commandCompleted(5, 'git status --short', 0, 'completed', 'exec-second'),
  );
  const { turns } = readCodexSession(writeRollout(records), 'sess');
  assert.deepEqual(
    turns[0].steps.filter((step) => step.name === 'exec'),
    [
      { ordinal: 1, name: 'exec', detail: 'npm test', at: ms(5), status: 'done', sourceId: 'exec-first' },
      { ordinal: 2, name: 'exec', detail: 'git status --short', at: ms(5), status: 'done', sourceId: 'exec-second' },
    ],
  );
  assert.equal(turns[0].toolUses, 1, 'nested command records inflated the outer tool total');
  assert.equal(turns[0].toolCounts.commands, 1, 'nested command records inflated the command mix');
});

test('client tool wrappers keep the nested tool name instead of a bare Ran row', () => {
  const records = ordinaryTurn();
  records[4] = item('custom_tool_call', 4, {
    name: 'exec',
    call_id: 'call_a',
    input: 'const result = await tools.update_plan({plan: []}); text(result);',
  });
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  assert.deepEqual(
    turn.steps.filter((step) => step.at === ms(4)).map((step) => [step.name, step.detail]),
    [['update_plan', '']],
  );
  assert.equal(
    turn.steps.some((step) => step.name === 'exec' && !step.detail),
    false,
  );
  assert.equal(turn.toolTally.update_plan, 1);
});

test('a client command wrapper keeps its command when no completed item follows', () => {
  const records = ordinaryTurn();
  records[4] = item('custom_tool_call', 4, {
    name: 'exec',
    call_id: 'call_a',
    input:
      'const result = await tools.exec_command({"cmd":"npm --prefix extension test","workdir":"C:\\\\repo"}); text(result);',
  });
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  const command = turn.steps.find((step) => step.id === 'call_a');
  assert.equal(command?.detail, 'npm --prefix extension test');
  assert.equal(command?.fullDetail, 'npm --prefix extension test');
  assert.equal(
    turn.steps.some((step) => step.name === 'exec' && !step.detail),
    false,
  );
});

test('a completed file change replaces its client wrapper with the edited path', () => {
  const records = ordinaryTurn();
  records[4] = item('custom_tool_call', 4, {
    name: 'exec',
    call_id: 'call_a',
    input: 'const result = await tools.apply_patch(patch); text(result);',
  });
  records.splice(
    5,
    0,
    event('item_completed', 5, {
      item: {
        type: 'FileChange',
        id: 'exec-file-change',
        status: 'completed',
        changes: { 'c:\\repo\\src\\a.ts': { type: 'update', unified_diff: '@@ -1 +1 @@' } },
      },
    }),
  );
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  const changed = turn.steps.find((step) => step.sourceId === 'exec-file-change');
  assert.deepEqual(changed, {
    ordinal: 1,
    name: 'apply_patch',
    detail: 'c:\\repo\\src\\a.ts',
    at: ms(5),
    status: 'done',
    sourceId: 'exec-file-change',
  });
  assert.equal(
    turn.steps.some((step) => step.name === 'exec' && !step.detail),
    false,
  );
  assert.equal(turn.toolCounts.edits, 1);
  assert.equal(turn.toolCounts.commands, 0);
});

test('a completed file change records its added and updated files without a wrapper match', () => {
  const records = ordinaryTurn();
  records[6] = event('item_completed', 6, {
    item: {
      type: 'FileChange',
      id: 'unmatched-file-change',
      status: 'completed',
      changes: {
        'c:\\repo\\src\\added.ts': { type: 'add', content: 'one\ntwo\n' },
        'c:\\repo\\src\\updated.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-before\n+after\n' },
      },
    },
  });
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  assert.deepEqual(
    turn.files.map((file) => [file.path, file.added, file.removed, file.isNew]),
    [
      ['c:\\repo\\src\\added.ts', 2, 0, true],
      ['c:\\repo\\src\\updated.ts', 1, 1, false],
    ],
  );
  assert.equal(turn.files.find((file) => file.path.endsWith('updated.ts'))?.edits[0]?.hunks.length, 1);
});

test('a failed completed file change does not record a file', () => {
  const records = ordinaryTurn();
  records[6] = event('item_completed', 6, {
    item: {
      type: 'FileChange',
      id: 'failed-file-change',
      status: 'failed',
      changes: { 'c:\\repo\\src\\a.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-before\n+after\n' } },
    },
  });
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  assert.deepEqual(turn.files, []);
});

test('a completed file change does not duplicate a patch_apply_end file record', () => {
  const records = ordinaryTurn();
  records.splice(
    7,
    0,
    event('item_completed', 7, {
      item: {
        type: 'FileChange',
        id: 'duplicate-file-change',
        status: 'completed',
        changes: {
          'c:\\repo\\src\\a.ts': {
            type: 'update',
            unified_diff: '@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+extra\n',
            move_path: null,
          },
        },
      },
    }),
  );
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  assert.deepEqual(
    turn.files.map((file) => [file.path, file.added, file.removed, file.edits.length]),
    [['c:\\repo\\src\\a.ts', 2, 1, 1]],
  );
});

test('an apply_patch wrapper keeps all paths before a late file item arrives', () => {
  const records = ordinaryTurn();
  const patch = [
    '*** Begin Patch',
    '*** Update File: c:\\repo\\src\\a.ts',
    '*** Add File: c:\\repo\\src\\b.ts',
    '*** End Patch',
  ].join('\n');
  records[4] = item('custom_tool_call', 4, {
    name: 'exec',
    call_id: 'call_a',
    input: `const patch = ${JSON.stringify(patch)}; text(await tools.apply_patch(patch));`,
  });
  records.splice(
    6,
    0,
    event('item_completed', 6, {
      item: {
        type: 'FileChange',
        id: 'exec-late-file-change',
        status: 'completed',
        changes: {
          'c:\\repo\\src\\a.ts': { type: 'update', unified_diff: '@@' },
          'c:\\repo\\src\\b.ts': { type: 'create', unified_diff: '@@' },
        },
      },
    }),
  );
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  const changed = turn.steps.find((step) => step.sourceId === 'exec-late-file-change');
  assert.ok(changed);
  assert.equal(changed.detail, 'c:\\repo\\src\\a.ts c:\\repo\\src\\b.ts');
  assert.equal(changed.fullDetail, 'c:\\repo\\src\\a.ts\nc:\\repo\\src\\b.ts');
  assert.equal(Object.prototype.propertyIsEnumerable.call(changed, 'fullDetail'), false);
});

test('an apply_patch wrapper retains a move destination without a structured file item', () => {
  const records = ordinaryTurn();
  const patch = [
    '*** Begin Patch',
    '*** Update File: c:\\repo\\old.md',
    '*** Move to: c:\\repo\\new.md',
    '*** End Patch',
  ].join('\n');
  records[4] = item('custom_tool_call', 4, {
    name: 'exec',
    call_id: 'move_patch',
    input: `const patch = ${JSON.stringify(patch)}; text(await tools.apply_patch(patch));`,
  });
  records[5] = toolOutput(5, 'move_patch', 'Script completed\nExit code: 0\n');
  records.splice(6, 1);
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  const changed = turn.steps.find((step) => step.sourceId === 'move_patch');
  assert.equal(changed?.detail, 'c:\\repo\\old.md c:\\repo\\new.md');
  assert.equal(changed?.fullDetail, 'c:\\repo\\old.md\nc:\\repo\\new.md');
});

test('a failed apply_patch wrapper cannot take the successful retry file item', () => {
  const records = ordinaryTurn();
  const patch = ['*** Begin Patch', '*** Update File: c:\\repo\\src\\a.ts', '*** End Patch'].join('\n');
  const wrapper = `const patch = ${JSON.stringify(patch)}; text(await tools.apply_patch(patch));`;
  records.splice(
    4,
    3,
    item('custom_tool_call', 4, { name: 'exec', call_id: 'failed_patch', input: wrapper }),
    toolOutput(5, 'failed_patch', 'Script failed\n\nScript error:\napply_patch verification failed: context changed\n'),
    item('custom_tool_call', 5, { name: 'exec', call_id: 'retry_patch', input: wrapper }),
    toolOutput(5, 'retry_patch', 'Script completed\nExit code: 0\n'),
    event('item_completed', 6, {
      item: {
        type: 'FileChange',
        id: 'retry-file-change',
        status: 'completed',
        changes: { 'c:\\repo\\src\\a.ts': { type: 'update', unified_diff: '@@' } },
      },
    }),
  );
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  assert.equal(turn.steps.find((step) => step.sourceId === 'failed_patch')?.status, 'failed');
  const changed = turn.steps.find((step) => step.sourceId === 'retry-file-change');
  assert.ok(changed);
  assert.equal(changed.name, 'apply_patch');
  assert.equal(changed.detail, 'c:\\repo\\src\\a.ts');
  assert.equal(changed.status, 'done');
});

test('wrapped web calls retain each supported request subject', () => {
  const cases = [
    ['{search_query:[{q:"activity details"},{q:"permission details"}]}', 'activity details\npermission details'],
    ['{image_query:[{q:"wide panel"},{q:"narrow panel"}]}', 'wide panel\nnarrow panel'],
    ['{find:[{ref_id:"turn0",pattern:"needle"},{ref_id:"turn1",pattern:"thread"}]}', 'needle\nthread'],
    ['{open:[{ref_id:"turn0"},{ref_id:"turn1"}]}', 'turn0\nturn1'],
    ['{finance:[{ticker:"AMD"},{ticker:"NVDA"}]}', 'AMD\nNVDA'],
    ['{weather:[{location:"Chicago"},{location:"Austin"}]}', 'Chicago\nAustin'],
    ['{sports:[{team:"MIN",league:"nba"},{team:"OKC",league:"nba"}]}', 'MIN\nOKC'],
    ['{time:[{utc_offset:"-05:00"},{utc_offset:"+01:00"}]}', '-05:00\n+01:00'],
  ];
  for (const [input, exact] of cases) {
    const records = ordinaryTurn();
    records[4] = item('custom_tool_call', 4, {
      name: 'exec',
      call_id: 'web_call',
      input: `text(await tools.web__run(${input}));`,
    });
    records[5] = toolOutput(5, 'web_call', 'Script completed\nExit code: 0\n');
    const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
    const step = turn.steps.find((one) => one.sourceId === 'web_call');
    assert.equal(step?.name, 'web__run', input);
    assert.equal(step?.detail, exact.replace(/\n/g, ' '), input);
    assert.equal(step?.fullDetail, exact, input);
  }
});

test('a recorded non-zero command is a failed activity row, not a failed turn', () => {
  const records = ordinaryTurn();
  records.splice(5, 0, commandCompleted(5, 'rg missing src', 1, 'failed'));
  const { turns } = readCodexSession(writeRollout(records), 'sess');
  assert.deepEqual(
    turns[0].steps.filter((step) => step.name === 'exec'),
    [{ ordinal: 1, name: 'exec', detail: 'rg missing src', at: ms(5), status: 'failed', sourceId: 'exec-5' }],
  );
  assert.deepEqual(turns[0].failures, []);
});

test('a recorded multiline command uses the shared one-line activity cut', () => {
  const records = ordinaryTurn();
  records.splice(5, 0, commandCompleted(5, `Get-Content a.ts\n${'Select-String parser '.repeat(20)}`));
  const step = readCodexSession(writeRollout(records), 'sess').turns[0].steps.find(
    (candidate) => candidate.name === 'exec',
  );
  const detail = step?.detail ?? '';
  assert.ok(detail.length <= STEP_DETAIL_LIMIT);
  assert.ok(detail.endsWith(STEP_CUT));
  assert.ok(!detail.includes('\n'));
  assert.equal(step?.fullDetail, `Get-Content a.ts\n${'Select-String parser '.repeat(20)}`);
  assert.equal(Object.prototype.propertyIsEnumerable.call(step, 'fullDetail'), false);
});

test('current exec_command calls show their command and keep adjacent calls distinct', () => {
  const records = ordinaryTurn();
  records.splice(
    5,
    0,
    item('function_call', 4, {
      name: 'exec_command',
      call_id: 'call_first',
      arguments: JSON.stringify({ cmd: 'npm test' }),
    }),
    item('function_call', 4, {
      name: 'exec_command',
      call_id: 'call_second',
      arguments: JSON.stringify({ cmd: 'git status --short' }),
    }),
    item('function_call_output', 5, { call_id: 'call_first', output: 'Process exited with code 0' }),
    item('function_call_output', 5, { call_id: 'call_second', output: 'Process exited with code 0' }),
  );
  const steps = readCodexSession(writeRollout(records), 'sess').turns[0].steps.filter(
    (step) => step.name === 'exec_command',
  );
  assert.deepEqual(
    steps.map((step) => ({
      sourceId: step.sourceId,
      detail: step.detail,
      status: step.status,
      fullDetail: step.fullDetail,
    })),
    [
      { sourceId: 'call_first', detail: 'npm test', status: 'done', fullDetail: 'npm test' },
      { sourceId: 'call_second', detail: 'git status --short', status: 'done', fullDetail: 'git status --short' },
    ],
  );
});

test('current exec_command keeps exact multiline detail behind its folded preview', () => {
  const command = `Get-Content -LiteralPath 'a.ts'\r\n${'Select-String parser '.repeat(20)}  `;
  const records = ordinaryTurn();
  records.splice(
    5,
    0,
    item('function_call', 4, {
      name: 'exec_command',
      call_id: 'call_multiline',
      arguments: JSON.stringify({ cmd: command }),
    }),
  );
  const step = readCodexSession(writeRollout(records), 'sess').turns[0].steps.find(
    (candidate) => candidate.name === 'exec_command',
  );
  assert.ok(step);
  assert.ok(step.detail.length <= STEP_DETAIL_LIMIT);
  assert.ok(step.detail.endsWith(STEP_CUT));
  assert.ok(!step.detail.includes('\n'));
  assert.equal(step.fullDetail, command);
  assert.equal(Object.prototype.propertyIsEnumerable.call(step, 'fullDetail'), false);
  assert.equal(JSON.stringify(step).includes('fullDetail'), false);
});

test('current exec_command ignores missing, blank, and non-string cmd values', () => {
  const records = ordinaryTurn();
  records.splice(
    5,
    0,
    item('function_call', 4, { name: 'exec_command', call_id: 'call_missing', arguments: '{}' }),
    item('function_call', 4, {
      name: 'exec_command',
      call_id: 'call_blank',
      arguments: JSON.stringify({ cmd: ' \r\n ' }),
    }),
    item('function_call', 4, {
      name: 'exec_command',
      call_id: 'call_number',
      arguments: JSON.stringify({ cmd: 42 }),
    }),
  );
  const steps = readCodexSession(writeRollout(records), 'sess').turns[0].steps.filter(
    (step) => step.name === 'exec_command',
  );
  assert.deepEqual(
    steps.map((step) => step.detail),
    ['', '', ''],
  );
  assert.deepEqual(
    steps.map((step) => step.fullDetail),
    [undefined, undefined, undefined],
  );
});

test('commentary is activity while final-answer messages remain the closing response', () => {
  const records = ordinaryTurn();
  records.splice(
    5,
    0,
    event('item_completed', 4, {
      item: {
        type: 'AgentMessage',
        id: 'msg_commentary',
        phase: 'commentary',
        content: [{ type: 'Text', text: 'Checking the parser fixtures.' }],
      },
    }),
    event('item_completed', 5, {
      item: {
        type: 'AgentMessage',
        id: 'msg_final',
        phase: 'final_answer',
        content: [{ type: 'Text', text: 'The parser is fixed.' }],
      },
    }),
  );
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  assert.deepEqual(turn.updates, [
    {
      sourceId: 'msg_commentary',
      kind: 'commentary',
      text: 'Checking the parser fixtures.',
      at: ms(4),
      status: 'done',
      stepsBefore: 1,
    },
  ]);
  assert.equal(turn.summary, '- fixed the parser');
});

test('a final answer overtaken by a mid-turn prompt stays on the card as a reply, once', () => {
  const records = [
    meta(),
    event('task_started', 1, { turn_id: TURN, model_context_window: 258400 }),
    turnContext(2, TURN, 'gpt-5.6-sol', 'high'),
    event('user_message', 3, { message: 'what is the height limit' }),
    event('item_completed', 4, {
      item: {
        type: 'AgentMessage',
        id: 'msg_first',
        phase: 'final_answer',
        content: [{ type: 'Text', text: 'The limit is 1736.3px.' }],
      },
    }),
    item('message', 4, {
      id: 'msg_first',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: 'The limit is 1736.3px.' }],
    }),
    event('user_message', 5, { message: 'just do the right thing, use your judgement' }),
    item('custom_tool_call', 6, {
      name: 'exec',
      call_id: 'call_b',
      input: 'const r = await tools.shell_command({command:"npm test"});',
    }),
    toolOutput(7, 'call_b', 'Script completed\nExit code: 0\nOutput:\nok'),
    event('item_completed', 8, {
      item: {
        type: 'AgentMessage',
        id: 'msg_second',
        phase: 'final_answer',
        content: [{ type: 'Text', text: 'Landed the unrelated fix.' }],
      },
    }),
    item('message', 8, {
      id: 'msg_second',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: 'Landed the unrelated fix.' }],
    }),
    event('task_complete', 9, { turn_id: TURN, last_agent_message: 'Landed the unrelated fix.' }),
  ];
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  assert.deepEqual(
    turn.answers.map((a) => a.text),
    ['The limit is 1736.3px.', 'Landed the unrelated fix.'],
  );
  const card = toCard(turn, true, ms(10));
  assert.equal(card.summary, 'Landed the unrelated fix.');
  assert.deepEqual(
    card.earlierAnswers.map((a) => a.summary),
    ['The limit is 1736.3px.'],
  );
  const answerReplies = card.saidMessages.filter((said) => said.kind === 'answer');
  assert.deepEqual(
    answerReplies.map((said) => said.text),
    ['The limit is 1736.3px.'],
  );
});

// A question the model asked with `request_user_input_async`, as a rollout records it: the
// model's own call, the completed `AgentMessage` item carrying `delivery: "async"` and
// `phase: "final_answer"`, and the tool output that returned to the model. Codex leaves such a
// question out of `last_agent_message`, so a turn that asked and then stopped closes with no
// reply at all.
const ASYNC_QUESTION = {
  title: 'The rail migration is landed and rebuilt. Does the rail look right after a reload?',
  options: ['Works after reload', 'I found an issue', 'I will check later'],
};
function asyncQuestionTurn(asked: object[]): object[] {
  return [
    meta(),
    event('task_started', 1, { turn_id: TURN, model_context_window: 258400 }),
    turnContext(2, TURN, 'gpt-6-sol', 'high'),
    event('user_message', 3, { message: 'land the rail migration' }),
    item('function_call', 4, {
      name: 'request_user_input_async',
      call_id: 'call_rail_question',
      arguments: JSON.stringify({ questions: [ASYNC_QUESTION] }),
    }),
    ...asked,
    item('function_call_output', 6, { call_id: 'call_rail_question', output: '{"accepted":true}' }),
    tokens(7, { input_tokens: 20003, cached_input_tokens: 11008, output_tokens: 225 }),
    event('task_complete', 8, { turn_id: TURN, last_agent_message: '', duration_ms: 7000 }),
  ];
}

test('a recorded async question is one Activity update and never the turn reply', () => {
  const recorded = event('item_completed', 5, {
    turn_id: TURN,
    item: {
      type: 'AgentMessage',
      id: 'call_rail_question',
      content: [
        {
          type: 'Text',
          text: `${ASYNC_QUESTION.title}\n- Works after reload\n- I found an issue\n- I will check later`,
        },
      ],
      phase: 'final_answer',
      delivery: 'async',
      questions: [ASYNC_QUESTION],
    },
  });
  const without = readCodexSession(writeRollout(asyncQuestionTurn([])), 'sess').turns;
  const read = readCodexSession(writeRollout(asyncQuestionTurn([recorded])), 'sess').turns;
  const [turn] = read;
  assert.deepEqual(turn.updates, [
    {
      sourceId: 'call_rail_question',
      kind: 'commentary',
      text: `${ASYNC_QUESTION.title}\n- Works after reload\n- I found an issue\n- I will check later`,
      at: ms(5),
      status: 'done',
      stepsBefore: 1,
    },
  ]);
  assert.equal(turn.summary, '');
  assert.deepEqual(turn.answers, []);
  const card = toCard(turn, true, ms(10));
  assert.equal(card.summary, '');
  assert.deepEqual(card.earlierAnswers, []);
  assert.deepEqual(
    card.saidMessages.map((said) => said.kind),
    ['commentary'],
  );
  assert.equal(read.length, without.length);
  assert.equal(turn.toolUses, without[0].toolUses);
  assert.deepEqual(turn.toolCounts, without[0].toolCounts);
  assert.equal(turn.steps.length, without[0].steps.length);
});

test('a recorded async message with no question is one Activity update and never the turn reply', () => {
  const said = event('item_completed', 5, {
    turn_id: TURN,
    item: {
      type: 'AgentMessage',
      id: 'call_rail_notice',
      content: [{ type: 'Text', text: 'The build is running. I will report when it lands.' }],
      phase: 'final_answer',
      delivery: 'async',
      questions: null,
    },
  });
  const [turn] = readCodexSession(writeRollout(asyncQuestionTurn([said])), 'sess').turns;
  assert.deepEqual(
    turn.updates.map((update) => [update.sourceId, update.kind, update.text]),
    [['call_rail_notice', 'commentary', 'The build is running. I will report when it lands.']],
  );
  assert.equal(turn.summary, '');
  assert.deepEqual(turn.answers, []);
});

// The reply envelope Codex clients send to answer an async question, in the shape of the
// Codex TUI's own reply test.
const LAUNCH_REPLY =
  '<send_user_message_question_reply>' +
  JSON.stringify([
    {
      questionItemId: JSON.stringify(['request_user_input_async', 'audience-question', 0]),
      question: 'Who should receive the launch update?',
      answer: 'Customers',
    },
  ]) +
  '</send_user_message_question_reply>';

test('a recorded reply envelope reads as the question and its answer on every card field', () => {
  const records = [
    meta(),
    event('task_started', 1, { turn_id: TURN, model_context_window: 258400 }),
    turnContext(2, TURN, 'gpt-6-sol', 'high'),
    message('user', 3, LAUNCH_REPLY, 'input_text', ['user.text']),
    item('custom_tool_call', 4, {
      name: 'exec',
      call_id: 'call_a',
      input: 'const r = await tools.shell_command({command:"npm test"});',
    }),
    toolOutput(5, 'call_a', 'Script completed\nExit code: 0\nOutput:\nok'),
    event('user_message', 6, { message: LAUNCH_REPLY }),
    event('task_complete', 8, { turn_id: TURN, last_agent_message: 'Sent the launch update to customers.' }),
  ];
  const session = readCodexSession(writeRollout(records), 'sess');
  const [turn] = session.turns;
  const answered = 'Who should receive the launch update?\nCustomers';
  assert.equal(turn.prompt, answered);
  assert.deepEqual(
    turn.laterPrompts.map((later) => later.text),
    [answered],
  );
  const card = toCard(turn, true, ms(10));
  for (const read of [JSON.stringify(session), JSON.stringify(card)]) {
    assert.doesNotMatch(read, /send_user_message_question_reply|questionItemId/);
  }
});

test('a recorded user message with text outside the reply envelope stays the prompt it was', () => {
  const typed = `Thanks. ${LAUNCH_REPLY}`;
  const records = [
    meta(),
    event('task_started', 1, { turn_id: TURN, model_context_window: 258400 }),
    turnContext(2, TURN, 'gpt-6-sol', 'high'),
    event('user_message', 3, { message: typed }),
    event('task_complete', 8, { turn_id: TURN, last_agent_message: 'Sent.' }),
  ];
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  assert.equal(turn.prompt, typed);
});

// The live wire draws an async question as one Activity row: each titled question, its
// options behind `- `, and a blank line between questions. A reload draws the same text.
test('a recorded async item with two questions reads as the live Activity row for both', () => {
  const recorded = event('item_completed', 5, {
    turn_id: TURN,
    item: {
      type: 'AgentMessage',
      id: 'call_rail_question',
      content: [{ type: 'Text', text: 'Two questions about the rail.' }],
      phase: 'final_answer',
      delivery: 'async',
      questions: [ASYNC_QUESTION, { title: 'Which window did you reload?', options: ['The first', 'Both'] }],
    },
  });
  const [turn] = readCodexSession(writeRollout(asyncQuestionTurn([recorded])), 'sess').turns;
  assert.deepEqual(
    turn.updates.map((update) => update.text),
    [
      `${ASYNC_QUESTION.title}\n- Works after reload\n- I found an issue\n- I will check later\n\n` +
        'Which window did you reload?\n- The first\n- Both',
    ],
  );
});

test('a recorded async item whose questions all lack a title reads as its own text', () => {
  const recorded = event('item_completed', 5, {
    turn_id: TURN,
    item: {
      type: 'AgentMessage',
      id: 'call_rail_question',
      content: [{ type: 'Text', text: 'Pick one when the rebuild ends.' }],
      phase: 'final_answer',
      delivery: 'async',
      questions: [{ options: ['Now', 'Later'] }, { title: '', options: ['Skip'] }],
    },
  });
  const [turn] = readCodexSession(writeRollout(asyncQuestionTurn([recorded])), 'sess').turns;
  assert.deepEqual(
    turn.updates.map((update) => [update.sourceId, update.text]),
    [['call_rail_question', 'Pick one when the rebuild ends.']],
  );
  assert.deepEqual(turn.answers, []);
});

// Some rollouts write a message only as an `event_msg` `agent_message`. An async one there
// is no more an answer than it is as a completed item.
test('an async agent_message event is never the turn reply', () => {
  const said = event('agent_message', 5, {
    id: 'call_rail_notice',
    role: 'assistant',
    phase: 'final_answer',
    delivery: 'async',
    content: [{ type: 'Text', text: 'The build is running. I will report when it lands.' }],
  });
  const [turn] = readCodexSession(writeRollout(asyncQuestionTurn([said])), 'sess').turns;
  assert.deepEqual(turn.answers, []);
  assert.equal(turn.summary, '');
  assert.equal(toCard(turn, true, ms(10)).summary, '');
});

test('a recorded reply envelope holding one answer object reads as the question and its answer', () => {
  const single =
    '<send_user_message_question_reply>' +
    JSON.stringify({
      questionItemId: JSON.stringify(['request_user_input_async', 'audience-question', 0]),
      question: 'Who should receive the launch update?',
      answer: 'Customers',
    }) +
    '</send_user_message_question_reply>';
  const records = ordinaryTurn();
  records[3] = event('user_message', 3, { message: single });
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  assert.equal(turn.prompt, 'Who should receive the launch update?\nCustomers');
});

test('a session whose first prompt is a reply envelope is named after the question and its answer', () => {
  const records = ordinaryTurn();
  records[3] = event('user_message', 3, { message: LAUNCH_REPLY });
  const file = writeRollout(records);
  assert.equal(readCodexSessionTitle(file), 'Who should receive the launch update? Customers');
  assert.deepEqual(readCodexSessionTitlePair(file), {
    short: 'Who should receive the launch update? Customers',
    full: 'Who should receive the launch update? Customers',
  });
});

test('a turn that closes one final answer keeps it only as the response, not as a reply too', () => {
  const records = [
    meta(),
    event('task_started', 1, { turn_id: TURN, model_context_window: 258400 }),
    turnContext(2, TURN, 'gpt-5.6-sol', 'high'),
    event('user_message', 3, { message: 'fix the parser' }),
    event('item_completed', 4, {
      item: {
        type: 'AgentMessage',
        id: 'msg_only',
        phase: 'final_answer',
        content: [{ type: 'Text', text: 'Fixed the parser.' }],
      },
    }),
    item('message', 4, {
      id: 'msg_only',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: 'Fixed the parser.' }],
    }),
    event('task_complete', 5, { turn_id: TURN, last_agent_message: 'Fixed the parser.' }),
  ];
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  assert.deepEqual(
    turn.answers.map((a) => a.text),
    ['Fixed the parser.'],
  );
  const card = toCard(turn, true, ms(6));
  assert.equal(card.summary, 'Fixed the parser.');
  assert.deepEqual(card.earlierAnswers, []);
  assert.equal(
    card.saidMessages.some((said) => said.kind === 'answer'),
    false,
  );
});

test('a task_complete summary with a trailing newline still matches its recorded answer once', () => {
  const records = [
    meta(),
    event('task_started', 1, { turn_id: TURN, model_context_window: 258400 }),
    turnContext(2, TURN, 'gpt-5.6-sol', 'high'),
    event('user_message', 3, { message: 'fix the parser' }),
    event('item_completed', 4, {
      item: {
        type: 'AgentMessage',
        id: 'msg_only',
        phase: 'final_answer',
        content: [{ type: 'Text', text: 'Fixed the parser.' }],
      },
    }),
    item('message', 4, {
      id: 'msg_only',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: 'Fixed the parser.' }],
    }),
    event('task_complete', 5, { turn_id: TURN, last_agent_message: 'Fixed the parser.\n' }),
  ];
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  assert.deepEqual(
    turn.answers.map((a) => a.text),
    ['Fixed the parser.'],
  );
  const card = toCard(turn, true, ms(6));
  assert.equal(card.summary, 'Fixed the parser.');
  assert.deepEqual(card.earlierAnswers, []);
  assert.equal(
    card.saidMessages.some((said) => said.kind === 'answer'),
    false,
  );
});

test('a multi-block final answer joined differently in last_agent_message still matches once', () => {
  const records = [
    meta(),
    event('task_started', 1, { turn_id: TURN, model_context_window: 258400 }),
    turnContext(2, TURN, 'gpt-5.6-sol', 'high'),
    event('user_message', 3, { message: 'fix the parser' }),
    event('item_completed', 4, {
      item: {
        type: 'AgentMessage',
        id: 'msg_only',
        phase: 'final_answer',
        content: [
          { type: 'Text', text: 'Part one.' },
          { type: 'Text', text: 'Part two.' },
        ],
      },
    }),
    item('message', 4, {
      id: 'msg_only',
      role: 'assistant',
      phase: 'final_answer',
      content: [
        { type: 'output_text', text: 'Part one.' },
        { type: 'output_text', text: 'Part two.' },
      ],
    }),
    // The recorded answer joins its two blocks with a newline. `last_agent_message` here
    // joins them with nothing, the way Codex sometimes serializes a multi-block summary.
    event('task_complete', 5, { turn_id: TURN, last_agent_message: 'Part one.Part two.' }),
  ];
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  assert.deepEqual(
    turn.answers.map((a) => a.text),
    ['Part one.\nPart two.'],
  );
  const card = toCard(turn, true, ms(6));
  assert.equal(card.summary, 'Part one.\nPart two.');
  assert.deepEqual(card.earlierAnswers, []);
  assert.equal(
    card.saidMessages.some((said) => said.kind === 'answer'),
    false,
  );
});

// Pair an item-N final answer with its msg_ response item by text when their IDs differ.

test('a final answer paired by an item-N id and a msg_ id a few ms apart dedups by text once', () => {
  const records = [
    meta(),
    event('task_started', 1, { turn_id: TURN, model_context_window: 258400 }),
    turnContext(2, TURN, 'gpt-5.6-sol', 'high'),
    event('user_message', 3, { message: 'fix the parser' }),
    recordedAt(
      event('item_completed', 4, {
        item: {
          type: 'AgentMessage',
          id: 'item-17',
          phase: 'final_answer',
          content: [{ type: 'Text', text: 'Fixed the parser.' }],
        },
      }),
      '2026-08-25T12:00:04.259Z',
    ),
    recordedAt(
      item('message', 4, {
        id: 'msg_0a56bff55a4c9f04016a59b48855ec819a8752e43afecfa96d',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'Fixed the parser.' }],
      }),
      '2026-08-25T12:00:04.269Z',
    ),
    event('task_complete', 5, { turn_id: TURN, last_agent_message: 'Fixed the parser.' }),
  ];
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  assert.deepEqual(
    turn.answers.map((a) => a.text),
    ['Fixed the parser.'],
  );
  const card = toCard(turn, true, ms(6));
  assert.equal(card.summary, 'Fixed the parser.');
  assert.deepEqual(card.earlierAnswers, []);
  assert.equal(
    card.saidMessages.some((said) => said.kind === 'answer'),
    false,
  );
});

test('two id-mismatched final answers with the same text on either side of a mid-turn prompt stay separate', () => {
  const records = [
    meta(),
    event('task_started', 1, { turn_id: TURN, model_context_window: 258400 }),
    turnContext(2, TURN, 'gpt-5.6-sol', 'high'),
    event('user_message', 3, { message: 'what is the height limit' }),
    recordedAt(
      event('item_completed', 4, {
        item: {
          type: 'AgentMessage',
          id: 'item-1',
          phase: 'final_answer',
          content: [{ type: 'Text', text: 'Same answer text.' }],
        },
      }),
      '2026-08-25T12:00:04.100Z',
    ),
    recordedAt(
      item('message', 4, {
        id: 'msg_aaa',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'Same answer text.' }],
      }),
      '2026-08-25T12:00:04.110Z',
    ),
    event('user_message', 5, { message: 'just do the right thing, use your judgement' }),
    recordedAt(
      event('item_completed', 6, {
        item: {
          type: 'AgentMessage',
          id: 'item-2',
          phase: 'final_answer',
          content: [{ type: 'Text', text: 'Same answer text.' }],
        },
      }),
      '2026-08-25T12:00:06.100Z',
    ),
    recordedAt(
      item('message', 6, {
        id: 'msg_bbb',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'Same answer text.' }],
      }),
      '2026-08-25T12:00:06.110Z',
    ),
    event('task_complete', 7, { turn_id: TURN, last_agent_message: 'Same answer text.' }),
  ];
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  assert.deepEqual(
    turn.answers.map((a) => a.text),
    ['Same answer text.', 'Same answer text.'],
  );
});

// A final_answer response_item must reach the parser without a paired item_completed event.

test('a final answer written only as a phased response_item message still reaches the card', () => {
  const records = [
    meta(),
    event('task_started', 1, { turn_id: TURN, model_context_window: 258400 }),
    turnContext(2, TURN, 'gpt-5.6-sol', 'high'),
    event('user_message', 3, { message: 'fix the parser' }),
    item('message', 4, {
      id: 'msg_only',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: 'Fixed the parser.' }],
    }),
    event('task_complete', 5, { turn_id: TURN, last_agent_message: 'Fixed the parser.' }),
  ];
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  assert.deepEqual(
    turn.answers.map((a) => a.text),
    ['Fixed the parser.'],
  );
  const card = toCard(turn, true, ms(6));
  assert.equal(card.summary, 'Fixed the parser.');
  assert.deepEqual(card.earlierAnswers, []);
});

test('a final answer written only as a phased event_msg agent_message still reaches the card', () => {
  const records = [
    meta(),
    event('task_started', 1, { turn_id: TURN, model_context_window: 258400 }),
    turnContext(2, TURN, 'gpt-5.6-sol', 'high'),
    event('user_message', 3, { message: 'fix the parser' }),
    event('agent_message', 4, {
      id: 'msg_only',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'Text', text: 'Fixed the parser.' }],
    }),
    event('task_complete', 5, { turn_id: TURN, last_agent_message: 'Fixed the parser.' }),
  ];
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  assert.deepEqual(
    turn.answers.map((a) => a.text),
    ['Fixed the parser.'],
  );
  const card = toCard(turn, true, ms(6));
  assert.equal(card.summary, 'Fixed the parser.');
});

test('a turn stopped after a final answer shows that answer as the response, not as stopped', () => {
  const records = [
    meta(),
    event('task_started', 1, { turn_id: TURN, model_context_window: 258400 }),
    turnContext(2, TURN, 'gpt-5.6-sol', 'high'),
    event('user_message', 3, { message: 'fix the parser' }),
    event('item_completed', 4, {
      item: {
        type: 'AgentMessage',
        id: 'msg_only',
        phase: 'final_answer',
        content: [{ type: 'Text', text: 'Fixed the parser.' }],
      },
    }),
    item('message', 4, {
      id: 'msg_only',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: 'Fixed the parser.' }],
    }),
    event('user_message', 5, { message: 'stop this task' }),
    event('turn_aborted', 6, { turn_id: TURN, reason: 'interrupted' }),
  ];
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  assert.equal(turn.summary, 'Fixed the parser.');
  assert.deepEqual(
    turn.answers.map((a) => a.text),
    ['Fixed the parser.'],
  );
  const card = toCard(turn, true, ms(7));
  assert.equal(card.headline, 'Fixed the parser.');
  assert.deepEqual(card.earlierAnswers, []);
  assert.equal(card.saidMessages.filter((said) => said.kind === 'answer').length, 0);
});

test('a turn stopped with no final answer keeps the stopped wording', () => {
  const records = [
    meta(),
    event('task_started', 1, { turn_id: TURN, model_context_window: 258400 }),
    turnContext(2, TURN, 'gpt-5.6-sol', 'high'),
    event('user_message', 3, { message: 'fix the parser' }),
    event('turn_aborted', 4, { turn_id: TURN, reason: 'interrupted' }),
  ];
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  assert.equal(turn.summary, '');
  const card = toCard(turn, true, ms(5));
  assert.equal(card.headline, 'Stopped by you before it answered.');
});

test('an open turn with a final answer and no task_complete yet keeps the answer once', () => {
  const records = [
    meta(),
    event('task_started', 1, { turn_id: TURN, model_context_window: 258400 }),
    turnContext(2, TURN, 'gpt-5.6-sol', 'high'),
    event('user_message', 3, { message: 'fix the parser' }),
    event('item_completed', 4, {
      item: {
        type: 'AgentMessage',
        id: 'msg_only',
        phase: 'final_answer',
        content: [{ type: 'Text', text: 'Fixed the parser.' }],
      },
    }),
    item('message', 4, {
      id: 'msg_only',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: 'Fixed the parser.' }],
    }),
  ];
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  assert.equal(turn.summary, '');
  assert.deepEqual(
    turn.answers.map((a) => a.text),
    ['Fixed the parser.'],
  );
  const card = toCard(turn, true, ms(5));
  assert.deepEqual(
    card.earlierAnswers.map((a) => a.summary),
    ['Fixed the parser.'],
  );
  assert.equal(card.saidMessages.filter((said) => said.kind === 'answer').length, 1);
});

test('an incremental read restoring a v10 parser state keeps a split final answer once', () => {
  const records = [
    meta(),
    event('task_started', 1, { turn_id: TURN, model_context_window: 258400 }),
    turnContext(2, TURN, 'gpt-5.6-sol', 'high'),
    event('user_message', 3, { message: 'what is the height limit' }),
    event('item_completed', 4, {
      item: {
        type: 'AgentMessage',
        id: 'msg_first',
        phase: 'final_answer',
        content: [{ type: 'Text', text: 'The limit is 1736.3px.' }],
      },
    }),
    item('message', 4, {
      id: 'msg_first',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: 'The limit is 1736.3px.' }],
    }),
    event('user_message', 5, { message: 'just do the right thing, use your judgement' }),
    event('item_completed', 6, {
      item: {
        type: 'AgentMessage',
        id: 'msg_second',
        phase: 'final_answer',
        content: [{ type: 'Text', text: 'Landed the unrelated fix.' }],
      },
    }),
    item('message', 6, {
      id: 'msg_second',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: 'Landed the unrelated fix.' }],
    }),
    event('task_complete', 7, { turn_id: TURN, last_agent_message: 'Landed the unrelated fix.\n' }),
  ];
  const all = createCodexSessionReducer('sess', {}, readCodexSessionMeta(writeRollout(records)));
  for (const record of records) {
    all.pushLine(JSON.stringify(record));
  }
  const split = records.findIndex(
    (record) =>
      (record as { payload?: { message?: string } }).payload?.message === 'just do the right thing, use your judgement',
  );
  const first = createCodexSessionReducer('sess', {}, readCodexSessionMeta(writeRollout(records)));
  for (const record of records.slice(0, split)) {
    first.pushLine(JSON.stringify(record));
  }
  const resumed = createCodexSessionReducer('sess', {}, null, first.snapshot());
  for (const record of records.slice(split)) {
    resumed.pushLine(JSON.stringify(record));
  }
  assert.deepEqual(resumed.read(), all.read());
  const [turn] = resumed.read().turns;
  assert.deepEqual(
    turn.answers.map((a) => a.text),
    ['The limit is 1736.3px.', 'Landed the unrelated fix.'],
  );
  const card = toCard(turn, true, ms(8));
  assert.equal(card.summary, 'Landed the unrelated fix.');
  assert.deepEqual(
    card.earlierAnswers.map((a) => a.summary),
    ['The limit is 1736.3px.'],
  );
  assert.equal(card.saidMessages.filter((said) => said.kind === 'answer').length, 1);
});

test('paired commentary records with one id produce one update at the first position', () => {
  const records = ordinaryTurn();
  records.splice(
    5,
    0,
    event('item_completed', 4, {
      item: {
        type: 'AgentMessage',
        id: 'msg_pair',
        phase: 'commentary',
        content: [{ type: 'Text', text: 'Checking.' }],
      },
    }),
    item('message', 5, {
      id: 'msg_pair',
      role: 'assistant',
      phase: 'commentary',
      content: [{ type: 'output_text', text: 'Checking the parser.' }],
    }),
    event('item_completed', 6, {
      item: {
        type: 'AgentMessage',
        id: 'msg_next',
        phase: 'commentary',
        content: [{ type: 'Text', text: 'Running the focused test.' }],
      },
    }),
  );
  const updates = readCodexSession(writeRollout(records), 'sess').turns[0].updates;
  assert.deepEqual(
    updates.map((update) => [update.sourceId, update.text, update.at]),
    [
      ['msg_pair', 'Checking the parser.', ms(4)],
      ['msg_next', 'Running the focused test.', ms(6)],
    ],
  );
});

test('the Codex step cap preserves every message and the original call positions', () => {
  for (const total of [TURN_STEP_LIMIT + 5, (TURN_STEP_LIMIT + 5) * 10]) {
    const records: object[] = [meta(), event('task_started', 1), message('user', 2, 'keep the complete log')];
    for (let ordinal = 1; ordinal <= total; ordinal++) {
      records.push(
        item('function_call', ordinal + 2, {
          name: 'exec_command',
          call_id: `call-${ordinal}`,
          arguments: JSON.stringify({ cmd: `read ${ordinal}.ts` }),
        }),
      );
      records.push(
        item('function_call_output', ordinal + 2, {
          call_id: `call-${ordinal}`,
          output: ordinal === 1 ? 'Script error:\nMissing file' : 'Process exited with code 0',
        }),
      );
      if (ordinal % 10 === 0) {
        records.push(
          item('message', ordinal + 2, {
            id: `message-${ordinal}`,
            role: 'assistant',
            phase: 'commentary',
            content: [{ type: 'output_text', text: `After call ${ordinal}` }],
          }),
        );
      }
      if (ordinal === 30) {
        records.push(message('user', ordinal + 2, 'Check the second file too.'));
      }
    }
    const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
    assert.equal(turn.steps.length, TURN_STEP_LIMIT);
    assert.equal(turn.stepCount, total);
    assert.deepEqual(
      turn.steps.map((step) => step.ordinal),
      Array.from({ length: TURN_STEP_LIMIT }, (_, i) => total - TURN_STEP_LIMIT + i + 1),
    );
    assert.equal(turn.updates.length, Math.floor(total / 10));
    assert.deepEqual(
      turn.updates.map((update) => update.stepsBefore),
      Array.from({ length: Math.floor(total / 10) }, (_, i) => (i + 1) * 10),
    );
    assert.deepEqual(turn.answers, []);
    assert.deepEqual(turn.laterPrompts, [{ text: 'Check the second file too.', at: ms(32), stepsBefore: 30 }]);
    assert.deepEqual(turn.failedOrdinals, [1]);
    assert.deepEqual(turn.stepKinds, Array(total).fill('commands'));
  }
});

test('paired narration records with different ids produce one message identity', () => {
  const timestamp = '2026-07-31T09:16:56.179Z';
  const text = 'I’m using the repository’s review steps. I’ll read the open findings, then write down what changed.';
  const sourceId = 'msg_06cbbaaa3ea9a72a016a6c6807daa8819a9bd320edaf95f78f';
  const pair = [
    {
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: {
          type: 'AgentMessage',
          id: 'item-2',
          content: [{ type: 'Text', text }],
          phase: 'commentary',
        },
      },
    },
    {
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        id: sourceId,
        role: 'assistant',
        content: [{ type: 'output_text', text }],
        phase: 'commentary',
      },
    },
  ];
  for (const records of [pair, [...pair].reverse()]) {
    const [turn] = readCodexSession(
      writeRollout([meta(), event('task_started', 1), message('user', 2, 'review latest commits'), ...records]),
      'sess',
    ).turns;
    assert.deepEqual(
      turn.updates.map((update) => [update.sourceId, update.text, update.at, update.status]),
      [[sourceId, text, Date.parse(timestamp), 'done']],
    );
  }
});

test('equal commentary and reasoning remain distinct in either record order', () => {
  const text = 'Check the command output.';
  const pair = [
    item('message', 4, {
      id: 'comment',
      role: 'assistant',
      phase: 'commentary',
      content: [{ type: 'output_text', text }],
    }),
    item('reasoning', 4, { id: 'reason', summary: [{ type: 'summary_text', text }] }),
  ];
  for (const records of [pair, [...pair].reverse()]) {
    const [turn] = readCodexSession(
      writeRollout([meta(), event('task_started', 1), message('user', 2, 'Check'), ...records]),
      'sess',
    ).turns;
    assert.deepEqual(turn.updates.map((update) => update.kind).sort(), ['commentary', 'reasoning']);
  }
});

test('grouped web searches use the same categories as the Activity head', () => {
  const records = [
    meta(),
    event('task_started', 1),
    message('user', 2, 'Search'),
    item('web_search_call', 3, { status: 'completed', action: { type: 'search', query: 'first query' } }),
    item('web_search_call', 4, { status: 'completed', action: { type: 'search', query: 'second query' } }),
  ];
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  const card = toCard(turn, true, ms(5));
  assert.equal(card.activity[0].mix, card.activityTools);
  assert.equal(card.activityTools, '2 web');
});

test('expanded commands use the same unit in the Activity head and grouped run', () => {
  const records = [
    meta(),
    event('task_started', 1),
    message('user', 2, 'Run checks'),
    item('custom_tool_call', 3, { name: 'exec', call_id: 'wrapper', input: '{}' }),
    commandCompleted(4, 'npm test'),
    commandCompleted(5, 'git status', 0, 'completed', 'second'),
    toolOutput(6, 'wrapper', 'Script completed\nExit code: 0\n'),
  ];
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  const card = toCard(turn, true, ms(9));
  assert.equal(card.activityTools, '2 run');
  assert.equal(card.activity[0].mix, card.activityTools);
  assert.match(card.activityName, /2 steps, 2 run/);
});

test('only clear non-empty reasoning summaries become activity', () => {
  const records = ordinaryTurn();
  records.splice(
    5,
    0,
    event('item_completed', 4, {
      item: {
        type: 'Reasoning',
        id: 'reason_clear',
        summary_text: [{ type: 'Text', text: 'The command field is the durable source.' }],
        raw_content: [],
      },
    }),
    event('item_completed', 5, {
      item: {
        type: 'Reasoning',
        id: 'reason_empty',
        summary_text: [],
        raw_content: [],
      },
    }),
    item('reasoning', 6, { id: 'reason_encrypted', summary: [], encrypted_content: 'opaque-data' }),
    item('reasoning', 7, {
      id: 'reason_clear',
      summary: [{ type: 'summary_text', text: 'The command field is the durable source.' }],
      encrypted_content: 'opaque-data',
    }),
  );
  assert.deepEqual(readCodexSession(writeRollout(records), 'sess').turns[0].updates, [
    {
      sourceId: 'reason_clear',
      kind: 'reasoning',
      text: 'The command field is the durable source.',
      at: ms(4),
      status: 'done',
      stepsBefore: 1,
    },
  ]);
});

test('malformed and ambiguously paired records keep only readable wrapper detail', () => {
  const malformed = ordinaryTurn();
  malformed.splice(
    5,
    0,
    event('item_completed', 5, {
      item: {
        type: 'CommandExecution',
        command: ['powershell.exe', '-Command', 'npm test'],
        parsed_cmd: [],
        status: 'completed',
      },
    }),
  );
  assert.deepEqual(
    readCodexSession(writeRollout(malformed), 'sess').turns[0].steps.filter((step) => step.name === 'exec'),
    [{ ordinal: 1, name: 'exec', detail: 'npm test', at: ms(4), status: 'done', sourceId: 'call_a' }],
  );

  const ambiguous = ordinaryTurn();
  ambiguous.splice(
    5,
    0,
    item('custom_tool_call', 4, { name: 'exec', call_id: 'call_b', input: 'another wrapper' }),
    commandCompleted(5, 'npm test'),
    toolOutput(5, 'call_b', 'Script completed\nExit code: 0\nOutput:\nok'),
  );
  assert.deepEqual(
    readCodexSession(writeRollout(ambiguous), 'sess')
      .turns[0].steps.filter((step) => step.name === 'exec')
      .map((step) => step.detail),
    ['npm test', ''],
  );
});

// Legacy rollouts without completed command records expose commits from tool output without checking the command. Quoted commit lines remain indistinguishable there.

test('a legacy commit is read out of output when its rollout carries no command record', () => {
  const records = ordinaryTurn();
  records[5] = toolOutput(
    5,
    'call_a',
    'Script completed\nExit code: 0\nOutput:\n[main f572f41] Add the camera plan\n 1 file changed, 186 insertions(+)\n',
  );
  const { turns } = readCodexSession(writeRollout(records), 'sess');
  // The command's output establishes no repository ownership.
  assert.deepEqual(turns[0].commits, [
    {
      sha: 'f572f41',
      subject: 'Add the camera plan',
      head: { kind: 'branch', name: 'main' },
      files: 1,
      added: 186,
      removed: 0,
      at: ms(5),
      place: null,
      dir: null,
    },
  ]);
});

function ownershipSource(file: string, sessionId: string): CommitRepositorySource {
  const { size, mtimeMs, dev, ino } = revisionOf(fs.statSync(file, { bigint: true }));
  return { file, sessionId, revision: { size, mtimeMs, dev, ino } };
}

async function ownershipScan(file: string, sessionId: string, parent: string | null, dirs: string[]) {
  const cursor = createCommitRepositoryCursor(ownershipSource(file, sessionId), parent, dirs);
  for (let quantum = 0; quantum < 128; quantum++) {
    const result = await scanCommitRepositorySource(cursor, 512 * 1024, undefined, () => 0);
    assert.ok(result.readBytes <= 512 * 1024);
    if (result.status !== 'pending') return cursor;
  }
  throw new Error('ownership scan did not finish within its source allowance');
}

function ownershipRecords(
  roots: string[],
  hashes: string[],
  mutation?: string,
  native?: { created: number; started: number },
) {
  const dirs = roots.map((root) => root + '/.claude/worktrees/worker');
  const printed = hashes
    .map((sha, index) => `[ship/worker ${sha.slice(0, 7)}] Recorded ${index}\n 1 file changed, 2 insertions(+)\n${sha}`)
    .join('\n');
  const command = (second: number, text: string, stdout = '') =>
    commandCompleted(second, text, 0, 'completed', `exec-${second}`, {
      stdout,
      started_at_ms: ms(second) - 10,
      completed_at_ms: ms(second),
    });
  return {
    dirs,
    parent: [
      meta({ id: 'parent', session_id: 'parent' }),
      event('task_started', 1, { turn_id: 'parent-turn' }),
      turnContext(1, 'parent-turn', 'gpt-6.1-sol', 'high'),
      command(2, worktreeCreationCommand(roots)),
      event('task_complete', 9, { turn_id: 'parent-turn' }),
    ],
    child: [
      {
        ...meta({
          id: 'child',
          session_id: 'child',
          parent_thread_id: 'parent',
          thread_source: 'subagent',
          cwd: 'C:/outer',
          ...(native
            ? {
                timestamp: new Date(ms(0) + native.created).toISOString(),
                source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } },
              }
            : {}),
        }),
        ...(native ? { timestamp: at(10) } : {}),
      },
      event('task_started', 3, {
        turn_id: 'child-turn',
        ...(native ? { started_at: (ms(0) + native.started) / 1000 } : {}),
      }),
      turnContext(3, 'child-turn', 'gpt-6.1-sol', 'high'),
      event('user_message', 3, { message: 'Commit both repositories' }),
      ...(mutation ? [command(4, mutation)] : []),
      command(5, "$code=@'\nfor repo in roots: print(commit(repo))\n'@; $code | python -", printed),
      toolOutput(5, 'legacy', printed),
      command(
        6,
        'python report.py',
        JSON.stringify({
          candidates: Object.fromEntries(hashes.map((sha, index) => [String(index), { sha, repository: dirs[index] }])),
        }),
      ),
      event('task_complete', 7, { turn_id: 'child-turn' }),
    ],
  };
}

test.each(['native', 'guardian', 'fork', 'unsupported', 'native-before-opening', 'native-evidence-before-opening'])(
  'command ownership uses the physical opening clock for %s sources',
  async (source) => {
    const sha = 'a'.repeat(40);
    const fixture = ownershipRecords(['C:/first'], [sha], undefined, { created: 3000, started: 4000 });
    const opening = fixture.child[0] as any;
    if (source === 'guardian') opening.payload.source = { subagent: { other: 'guardian' } };
    if (source === 'fork') opening.payload.forked_from_id = 'earlier';
    if (source === 'unsupported') opening.payload.source = { subagent: { other: 'unknown' } };
    if (source === 'native-before-opening') (fixture.child[4] as any).payload.item.started_at_ms = ms(3) - 10;
    if (source === 'native-evidence-before-opening') (fixture.child[6] as any).payload.item.started_at_ms = ms(3) - 10;
    const parent = await ownershipScan(writeRollout(fixture.parent), 'parent', null, fixture.dirs);
    const child = await ownershipScan(writeRollout(fixture.child), 'child', 'parent', fixture.dirs);
    assert.equal(parent.complete, true);
    assert.equal(child.complete, true);
    const wanted = { sha, at: ms(5), evidenceAt: ms(6), dirs: fixture.dirs, turnId: 'child-turn' };
    assert.deepEqual(
      commitRepositoryTargets(parent, child, [wanted]),
      source === 'native' || source === 'guardian'
        ? [{ sha, dirs: ['C:/first'], occurrence: commitRepositoryOccurrence(wanted) }]
        : [],
    );
  },
);

test.each([
  'before',
  'after',
  'closed',
  'closed-context',
  'repeated',
  'dated',
  'closed-dated',
  'foreign',
  'missing',
  'evicted',
])('rounded native command ownership resolves the original occurrence: %s', async (timing) => {
  const sha = 'a'.repeat(40);
  const fixture = ownershipRecords(['C:/first'], [sha], undefined, { created: 3745, started: 3000 });
  const bill = event('token_usage_record', 8, {
    turn_id: 'child-turn',
    thread_id: timing === 'foreign' ? 'other' : 'child',
    session_id: 'parent',
    response_id: 'own',
    usage: usage({ input_tokens: 1000 }),
  });
  bill.timestamp = new Date(ms(0) + (timing === 'before' ? 3900 : timing === 'after' ? 6500 : 8000)).toISOString();
  if (timing === 'dated') (fixture.child[2] as any).payload.current_date = '1900-01-01';
  if (timing === 'before') fixture.child.splice(4, 0, bill);
  else if (timing !== 'missing') {
    if (timing === 'repeated')
      fixture.child.push(
        event('task_started', 8, { turn_id: 'child-turn', started_at: ms(8) / 1000 }),
        ...fixture.child.slice(4, 7).map((record) => structuredClone(record)),
      );
    if (timing === 'evicted')
      fixture.child.push(
        ...Array.from({ length: 64 }, (_, index) =>
          event('task_started', 8, { turn_id: `other-${index}`, started_at: ms(3) / 1000 }),
        ),
      );
    fixture.child.splice(timing === 'after' ? 7 : fixture.child.length, 0, bill);
    if (timing === 'closed-context') fixture.child.push(turnContext(9, 'child-turn', 'gpt-6-astra', 'high'));
    if (timing === 'closed-dated') {
      const copiedContext = turnContext(9, 'child-turn', 'gpt-6-astra', 'high');
      Object.assign(copiedContext.payload, { current_date: '1900-01-01' });
      fixture.child.push(copiedContext);
    }
  }
  const parent = await ownershipScan(writeRollout(fixture.parent), 'parent', null, fixture.dirs);
  const child = await ownershipScan(writeRollout(fixture.child), 'child', 'parent', fixture.dirs);
  const admitted = ['before', 'after', 'closed', 'closed-context', 'repeated'].includes(timing);
  const wanted = { sha, at: ms(5), evidenceAt: ms(6), dirs: fixture.dirs, turnId: 'child-turn' };
  assert.deepEqual(
    commitRepositoryTargets(parent, child, [wanted]),
    admitted ? [{ sha, dirs: ['C:/first'], occurrence: commitRepositoryOccurrence(wanted) }] : [],
    timing,
  );
  assert.equal(child.complete, !['foreign', 'missing', 'evicted'].includes(timing), timing);
});

test('native Codex loop commits in separate repositories recover exact owners after worktree removal', async () => {
  const directory = tempDir('separate-commit-owners-');
  const roots = [path.join(directory, 'FirstRepo'), path.join(directory, 'SecondRepo')].map((root) =>
    root.replace(/\\/g, '/'),
  );
  const outer = path.join(directory, 'outer').replace(/\\/g, '/');
  const git = (root: string, ...args: string[]) =>
    execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], {
      encoding: 'utf8',
    }).trim();
  const hashes: string[] = [];
  for (const [index, root] of [...roots, outer].entries()) {
    fs.mkdirSync(root);
    git(root, 'init', '-q');
    fs.writeFileSync(path.join(root, 'file.txt'), 'base');
    git(root, 'add', 'file.txt');
    git(root, 'commit', '-q', '-m', `Base ${index}`);
    if (index === 2) continue;
    const worktree = root + '/.claude/worktrees/worker';
    git(root, 'worktree', 'add', '-q', '-b', 'ship/worker', worktree);
    fs.writeFileSync(path.join(worktree, 'file.txt'), `changed ${index}`);
    git(worktree, 'commit', '-q', '-am', `Actual ${index}`);
    hashes.push(git(worktree, 'rev-parse', 'HEAD'));
    git(root, 'worktree', 'remove', worktree, '--force');
  }
  const fixture = ownershipRecords(roots, hashes);
  fixture.parent.splice(
    3,
    0,
    ...Array.from({ length: 40 }, (_unused, index) =>
      event('patch_apply_end', 1, {
        success: true,
        changes: { [outer + '/notes-' + index + '.txt']: { type: 'update' } },
      }),
    ),
  );
  fixture.child[0] = meta({
    id: 'child',
    session_id: 'child',
    parent_thread_id: 'parent',
    thread_source: 'subagent',
    cwd: outer,
  });
  const parentFile = writeRollout(fixture.parent);
  const childFile = writeRollout(fixture.child);
  const childEntry: CodexSubagentFile = {
    threadId: 'child',
    parentThreadId: 'parent',
    file: childFile,
    agentPath: '/root/worker',
    backgroundReview: false,
    openedAt: ms(0),
    startedAt: ms(0),
    threadSource: 'subagent',
  };
  const spend = readCodexAgentSpend(childFile, [childEntry]);
  assert.equal(spend.commits?.length, 2);
  const commits = spend.commits!;
  assert.deepEqual(
    commits.map((commit) => commit.dir),
    [null, null],
  );
  assert.deepEqual(
    commits.map((commit) => commit.printedSha),
    hashes,
  );
  const original = commits.map(({ subject, files, added, removed, at, sha }) => ({
    subject,
    files,
    added,
    removed,
    at,
    sha,
  }));
  const parent = await ownershipScan(parentFile, 'parent', null, fixture.dirs);
  const child = await ownershipScan(childFile, 'child', 'parent', fixture.dirs);
  const targets = commitRepositoryTargets(
    parent,
    child,
    commits.map((commit) => ({
      sha: commit.printedSha!,
      at: commit.at,
      evidenceAt: commit.repositoryEvidence!.at,
      dirs: commit.repositoryEvidence!.dirs,
      turnId: commit.repositoryEvidence!.turnId,
    })),
  );
  assert.deepEqual(
    targets,
    hashes.map((sha, index) => ({
      sha,
      dirs: [roots[index]],
      occurrence: commitRepositoryOccurrence({
        sha,
        at: commits[index].at,
        evidenceAt: commits[index].repositoryEvidence!.at,
        turnId: commits[index].repositoryEvidence!.turnId,
        dirs: commits[index].repositoryEvidence!.dirs,
      }),
    })),
  );
  const copiedRecords = structuredClone(fixture.child);
  copiedRecords[2] = {
    ...turnContext(3, 'child-turn', 'gpt-6.1-sol', 'high'),
    payload: { ...turnContext(3, 'child-turn', 'gpt-6.1-sol', 'high').payload, current_date: '1900-01-01' },
  } as (typeof copiedRecords)[number];
  const copiedChild = await ownershipScan(writeRollout(copiedRecords), 'child', 'parent', fixture.dirs);
  assert.deepEqual(
    commitRepositoryTargets(
      parent,
      copiedChild,
      commits.map((commit) => ({
        sha: commit.printedSha!,
        at: commit.at,
        evidenceAt: commit.repositoryEvidence!.at,
        dirs: commit.repositoryEvidence!.dirs,
        turnId: commit.repositoryEvidence!.turnId,
      })),
    ),
    [],
  );
  for (const commit of commits)
    commit.candidates = { dirs: targets.find((target) => target.sha === commit.printedSha)!.dirs, complete: true };
  const owner = fixtureTurn({ commits });
  const resolver = new RepositoryCommits(nodeGitRunner(), () => {});
  await vi.waitFor(
    () => {
      resolver.apply([owner], [outer]);
      assert.deepEqual(
        commits.map((commit) => commit.dir),
        roots.map(normalizeFsPath),
      );
    },
    { timeout: 10_000 },
  );
  assert.deepEqual(
    commits.map(({ subject, files, added, removed, at, sha }) => ({ subject, files, added, removed, at, sha })),
    original,
  );
});

test('worktree ownership accepts constant loops and rejects binding or failure ambiguity', () => {
  const command = worktreeCreationCommand(['C:/first', 'C:/second']);
  assert.deepEqual(
    worktreeRelationships(command, 'powershell'),
    ['C:/first', 'C:/second'].map((repository) => ({ repository, dir: repository + '/.claude/worktrees/worker' })),
  );
  for (const changed of [
    command.replace('$spec.repository+', "$spec.repository='C:/other'\n$spec.worktree=$spec.repository+"),
    command.replace('in $specs)', 'in ($specs | Where-Object { $_.enabled }))'),
    command.replace("throw 'Worktree creation failed'", "Write-Output 'failed'"),
    command.replace("if($LASTEXITCODE -ne 0){throw 'Worktree creation failed'}", ''),
    command.replace('$spec.worktree=$spec.repository+', '$alias=$spec\n$spec.worktree=$alias.repository+'),
    command.replace("'/.claude/worktrees/worker'", '$suffix'),
  ])
    assert.equal(worktreeRelationships(changed, 'powershell'), null, changed);
});

test.each(['selected', 'ambiguous', 'redirected'])(
  'a child recreating a parent worktree refuses ownership despite an object present in both roots: %s',
  async (selection) => {
    const directory = tempDir('recreated-owner-');
    const roots = ['first', 'second'].map((name) => path.join(directory, name).replace(/\\/g, '/'));
    const git = (root: string, ...args: string[]) =>
      execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], {
        encoding: 'utf8',
      }).trim();
    for (const root of roots) {
      fs.mkdirSync(root);
      git(root, 'init', '-q');
      fs.writeFileSync(path.join(root, 'file'), root);
      git(root, 'add', 'file');
      git(root, 'commit', '-qm', 'Base');
    }
    const worktree = roots[0] + '/.claude/worktrees/worker';
    git(roots[0], 'worktree', 'add', '-q', '-b', 'parent', worktree);
    git(roots[0], 'worktree', 'remove', worktree);
    git(roots[1], 'worktree', 'add', '-q', '-b', 'child', worktree);
    fs.writeFileSync(path.join(worktree, 'file'), 'Child commit');
    git(worktree, 'commit', '-qam', 'Child commit');
    const sha = git(worktree, 'rev-parse', 'HEAD');
    git(roots[0], 'fetch', '-q', roots[1], sha);
    assert.equal(git(roots[0], 'cat-file', '-t', sha), 'commit');
    assert.equal(git(roots[1], 'cat-file', '-t', sha), 'commit');
    fs.renameSync(path.join(roots[0], '.git'), path.join(roots[0], '.git-original'));
    git(roots[0], 'init', '-q');
    git(roots[0], 'fetch', '-q', roots[1], sha);
    assert.equal(git(roots[0], 'cat-file', '-t', sha), 'commit');
    const fixture = ownershipRecords(
      [roots[0]],
      [sha],
      `git -C '${roots[0]}' worktree remove '${worktree}'\ngit -C '${roots[1]}' worktree add '${worktree}'`,
    );
    if (selection === 'ambiguous')
      (fixture.child[4] as any).payload.item.parsed_cmd = [
        { cmd: `git -C '${roots[0]}' worktree remove '${worktree}'` },
        { cmd: `git -C '${roots[1]}' worktree add '${worktree}'` },
      ];
    if (selection === 'redirected') {
      const removal = `rm -rf '${worktree}' > C:/logs/remove.txt`;
      const copying = `cp -a '${roots[1]}' '${worktree}' > C:/logs/copy.txt`;
      (fixture.child[4] as any).payload.item.command = ['bash', '-c', removal + '\n' + copying];
      (fixture.child[4] as any).payload.item.parsed_cmd = [{ cmd: removal + '\n' + copying }];
    }
    const parent = await ownershipScan(writeRollout(fixture.parent), 'parent', null, fixture.dirs);
    const child = await ownershipScan(writeRollout(fixture.child), 'child', 'parent', fixture.dirs);
    assert.deepEqual(
      commitRepositoryTargets(parent, child, [
        { sha, at: ms(5), evidenceAt: ms(6), dirs: fixture.dirs, turnId: 'child-turn' },
      ]),
      [],
    );
    if (selection === 'selected') {
      for (const confirmation of ['before', 'after', 'closed'] as const) {
        const rounded = ownershipRecords(
          [roots[0]],
          [sha],
          `git -C '${roots[0]}' worktree remove '${worktree}'\ngit -C '${roots[1]}' worktree add '${worktree}'`,
          { created: 3745, started: 3000 },
        );
        const bill = event('token_usage_record', 8, {
          turn_id: 'child-turn',
          thread_id: 'child',
          session_id: 'parent',
          response_id: 'own',
          usage: usage({ input_tokens: 1000 }),
        });
        bill.timestamp = new Date(
          ms(0) + (confirmation === 'before' ? 3900 : confirmation === 'after' ? 4500 : 8000),
        ).toISOString();
        rounded.child.splice(
          confirmation === 'before' ? 4 : confirmation === 'after' ? 5 : rounded.child.length,
          0,
          bill,
        );
        const before = await ownershipScan(writeRollout(rounded.parent), 'parent', null, rounded.dirs);
        const after = await ownershipScan(writeRollout(rounded.child), 'child', 'parent', rounded.dirs);
        assert.equal(after.complete, true, confirmation);
        assert.deepEqual(
          commitRepositoryTargets(before, after, [
            { sha, at: ms(5), evidenceAt: ms(6), dirs: rounded.dirs, turnId: 'child-turn' },
          ]),
          [],
          confirmation + ' must refuse the wrong surviving owner',
        );
      }
    }
    for (const stream of ['parent', 'child'] as const) {
      const replacement = ownershipRecords([roots[0]], [sha]);
      replacement[stream].splice(
        stream === 'parent' ? 4 : 4,
        0,
        commandCompleted(4, `Remove-Item -LiteralPath '${roots[0]}/.git' -Recurse`, 0, 'completed', 'replace-owner', {
          started_at_ms: ms(4) - 10,
          completed_at_ms: ms(4),
        }),
      );
      const before = await ownershipScan(writeRollout(replacement.parent), 'parent', null, replacement.dirs);
      const after = await ownershipScan(writeRollout(replacement.child), 'child', 'parent', replacement.dirs);
      assert.deepEqual(
        commitRepositoryTargets(before, after, [
          { sha, at: ms(5), evidenceAt: ms(6), dirs: replacement.dirs, turnId: 'child-turn' },
        ]),
        [],
        stream + ' backing Git entry replacement',
      );
    }
    if (selection === 'selected') {
      const results: Record<string, ReturnType<typeof commitRepositoryTargets>> = {};
      for (const stream of ['parent', 'child'] as const) {
        for (const protocol of ['FileChange', 'patch_apply_end'] as const) {
          for (const changedPath of ['written', 'moved-from', 'moved-to', 'unrelated'] as const) {
            for (const timing of ['complete', 'missing-start', 'missing-end', 'reversed'] as const) {
              const replacement = ownershipRecords([roots[0]], [sha]);
              const gitEntry = worktree + '/.git';
              const unrelated = roots[1] + '/output.txt';
              const written = changedPath === 'moved-to' || changedPath === 'unrelated' ? unrelated : gitEntry;
              const changes = {
                [written]: {
                  type: 'update',
                  ...(changedPath === 'moved-to' ? { move_path: gitEntry } : {}),
                  ...(changedPath === 'moved-from' ? { move_path: unrelated } : {}),
                  unified_diff: '@@ -1 +1 @@\n-old\n+gitdir: ' + roots[1] + '/.git/worktrees/worker\n',
                },
              };
              const times = {
                ...(timing !== 'missing-start' ? { started_at_ms: ms(timing === 'reversed' ? 8 : 4) - 10 } : {}),
                ...(timing !== 'missing-end' ? { completed_at_ms: ms(4) } : {}),
              };
              const mutation =
                protocol === 'FileChange'
                  ? event('item_completed', 4, {
                      item: { type: protocol, id: 'write-git-entry', status: 'completed', changes, ...times },
                    })
                  : event(protocol, 4, { call_id: 'write-git-entry', success: true, changes, ...times });
              if (timing === 'missing-end') mutation.timestamp = '';
              replacement[stream].splice(4, 0, mutation);
              const before = await ownershipScan(writeRollout(replacement.parent), 'parent', null, replacement.dirs);
              const after = await ownershipScan(writeRollout(replacement.child), 'child', 'parent', replacement.dirs);
              const key = [stream, protocol, changedPath, timing].join(' ');
              const targets = commitRepositoryTargets(before, after, [
                { sha, at: ms(5), evidenceAt: ms(6), dirs: replacement.dirs, turnId: 'child-turn' },
              ]);
              if (changedPath === 'unrelated') assert.equal(targets.length, 1, key);
              else results[key] = targets;
            }
          }
        }
      }
      assert.deepEqual(results, Object.fromEntries(Object.keys(results).map((key) => [key, []])));
    }
    git(roots[1], 'worktree', 'remove', worktree);
  },
);

test('copied command JSON and contradictory parent creations never establish commit ownership', async () => {
  const sha = 'a'.repeat(40);
  for (const copied of [true, false]) {
    const fixture = ownershipRecords(['C:/first'], [sha]);
    if (copied)
      fixture.child[2] = {
        ...turnContext(3, 'child-turn', 'gpt-6.1-sol', 'high'),
        payload: { ...turnContext(3, 'child-turn', 'gpt-6.1-sol', 'high').payload, current_date: '1900-01-01' },
      } as (typeof fixture.child)[number];
    else
      fixture.parent.splice(
        4,
        0,
        commandCompleted(4, worktreeCreationCommand(['C:/first']), 0, 'completed', 'conflict', {
          started_at_ms: ms(4) - 10,
          completed_at_ms: ms(4),
        }),
      );
    const parent = await ownershipScan(writeRollout(fixture.parent), 'parent', null, fixture.dirs);
    const child = await ownershipScan(writeRollout(fixture.child), 'child', 'parent', fixture.dirs);
    assert.deepEqual(
      commitRepositoryTargets(parent, child, [
        { sha, at: ms(5), evidenceAt: ms(6), dirs: fixture.dirs, turnId: 'child-turn' },
      ]),
      [],
    );
  }
});

test('child ownership mutations and uncertain ordering leave exact matching objects unresolved', async () => {
  const hashes = ['a'.repeat(40), 'b'.repeat(40)];
  for (const mutation of [
    'git -C C:/first worktree remove C:/first/.claude/worktrees/worker\ngit -C C:/second worktree add C:/first/.claude/worktrees/worker',
    'Remove-Item -LiteralPath $unknown -Recurse',
    'Remove-Item -LiteralPath C:/unrelated\npython -c "import shutil; shutil.rmtree(target)"',
    "Set-Content C:/first/.claude/worktrees/worker/.git 'gitdir: C:/second/.git'",
    "echo 'gitdir: C:/second/.git' > C:/first/.claude/worktrees/worker/.git",
    "printf '%s' 'gitdir: C:/second/.git' > C:/first/.claude/worktrees/worker/.git",
    'cp C:/second/.git C:/first/.claude/worktrees/worker/.git',
    "'gitdir: C:/second/.git' | Out-File -LiteralPath C:/first/.claude/worktrees/worker/.git",
    'python -c "import shutil; shutil.rmtree(target)"',
  ]) {
    const fixture = ownershipRecords(['C:/first', 'C:/second'], hashes, mutation);
    const parent = await ownershipScan(writeRollout(fixture.parent), 'parent', null, fixture.dirs);
    const child = await ownershipScan(writeRollout(fixture.child), 'child', 'parent', fixture.dirs);
    const wanted = hashes.map((sha, index) => ({
      sha,
      at: ms(5),
      evidenceAt: ms(6),
      dirs: [fixture.dirs[index]],
      turnId: 'child-turn',
    }));
    assert.equal(
      commitRepositoryTargets(parent, child, wanted).some((target) => target.sha === hashes[0]),
      false,
      mutation,
    );
  }
  const fixture = ownershipRecords(['C:/first'], [hashes[0]]);
  const creation = fixture.parent[3] as unknown as { payload: { item: Record<string, unknown> } };
  creation.payload.item.completed_at_ms = ms(5);
  const parent = await ownershipScan(writeRollout(fixture.parent), 'parent', null, fixture.dirs);
  const child = await ownershipScan(writeRollout(fixture.child), 'child', 'parent', fixture.dirs);
  assert.deepEqual(
    commitRepositoryTargets(parent, child, [
      { sha: hashes[0], at: ms(5), evidenceAt: ms(6), dirs: fixture.dirs, turnId: 'child-turn' },
    ]),
    [],
  );
});

test('raw ambiguous completed commands preserve conflicting worktree mutations', async () => {
  const sha = 'a'.repeat(40);
  for (const failed of [false, true]) {
    const fixture = ownershipRecords(['C:/first', 'C:/second'], [sha, 'b'.repeat(40)]);
    const removal = `Remove-Item -LiteralPath '${fixture.dirs[0]}' -Recurse`;
    const recreation = `git -C C:/second worktree add '${fixture.dirs[0]}'`;
    fixture.child.splice(
      4,
      0,
      commandCompleted(4, removal + '\n' + recreation, failed ? 1 : 0, 'completed', 'raw-mutation', {
        parsed_cmd: [{ cmd: removal }, { cmd: recreation }],
        started_at_ms: ms(4) - 10,
        completed_at_ms: ms(4),
      }),
    );
    const parent = await ownershipScan(writeRollout(fixture.parent), 'parent', null, fixture.dirs);
    const child = await ownershipScan(writeRollout(fixture.child), 'child', 'parent', fixture.dirs);
    assert.deepEqual(
      commitRepositoryTargets(parent, child, [
        { sha, at: ms(5), evidenceAt: ms(6), dirs: [fixture.dirs[0]], turnId: 'child-turn' },
      ]),
      [],
    );
  }
});

test.each([
  ['bash', "echo 'gitdir: C:/second/.git' > C:/first/.claude/worktrees/worker/.git"],
  ['bash', "printf '%s' 'gitdir: C:/second/.git' > C:/first/.claude/worktrees/worker/.git"],
  ['bash', 'cp C:/second/.git C:/first/.claude/worktrees/worker/.git'],
  ['powershell', "'gitdir: C:/second/.git' | Out-File -LiteralPath C:/first/.claude/worktrees/worker/.git"],
])('Git entry writes through %s invalidate recorded ownership: %s', async (shell, mutation) => {
  const sha = 'a'.repeat(40);
  const fixture = ownershipRecords(['C:/first', 'C:/second'], [sha, sha], mutation);
  (fixture.child[4] as any).payload.item.command = [
    shell === 'bash' ? 'bash' : 'powershell.exe',
    shell === 'bash' ? '-c' : '-Command',
    mutation,
  ];
  const parent = await ownershipScan(writeRollout(fixture.parent), 'parent', null, fixture.dirs);
  const child = await ownershipScan(writeRollout(fixture.child), 'child', 'parent', fixture.dirs);
  assert.deepEqual(
    commitRepositoryTargets(parent, child, [
      { sha, at: ms(5), evidenceAt: ms(6), dirs: [fixture.dirs[0]], turnId: 'child-turn' },
    ]),
    [],
  );
});

test('creation envelopes refuse exposed native writes to worktree Git entries', async () => {
  const fixture = ownershipRecords(['C:/first', 'C:/second'], ['a'.repeat(40), 'b'.repeat(40)]);
  const command =
    worktreeCreationCommand(['C:/first', 'C:/second']) +
    `\n$report='C:/unrelated'\nnode -e "require('fs').writeFileSync('${fixture.dirs[0]}/.git','gitdir: C:/second/.git')" | Out-File -LiteralPath ($report+'/output.txt') -Encoding utf8`;
  assert.equal(worktreeRelationships(command, 'powershell'), null);
  (fixture.parent[3] as any).payload.item.parsed_cmd = [{ cmd: command }];
  (fixture.parent[3] as any).payload.item.command = ['powershell.exe', '-Command', command];
  const parent = await ownershipScan(writeRollout(fixture.parent), 'parent', null, fixture.dirs);
  const child = await ownershipScan(writeRollout(fixture.child), 'child', 'parent', fixture.dirs);
  assert.deepEqual(
    commitRepositoryTargets(parent, child, [
      { sha: 'a'.repeat(40), at: ms(5), evidenceAt: ms(6), dirs: [fixture.dirs[0]], turnId: 'child-turn' },
    ]),
    [],
  );
});

test.each(['overlap', 'reversed', 'early-mutation'])(
  'ownership refuses inconsistent or overlapping command intervals: %s',
  async (issue) => {
    const fixture = ownershipRecords(['C:/first', 'C:/second'], ['a'.repeat(40), 'b'.repeat(40)]);
    const creation = (fixture.parent[3] as any).payload.item;
    if (issue === 'overlap') {
      creation.started_at_ms = ms(3);
      creation.completed_at_ms = ms(4);
      (fixture.child[4] as any).payload.item.started_at_ms = ms(1);
    } else if (issue === 'reversed') {
      creation.started_at_ms = ms(3);
      creation.completed_at_ms = ms(2);
    } else {
      creation.started_at_ms = ms(1);
      creation.completed_at_ms = ms(2);
      fixture.parent.splice(
        3,
        0,
        commandCompleted(2, `Remove-Item -LiteralPath '${fixture.dirs[0]}' -Recurse`, 0, 'completed', 'early-removal', {
          started_at_ms: ms(1) + 10,
          completed_at_ms: ms(2) - 10,
        }),
      );
    }
    const parent = await ownershipScan(writeRollout(fixture.parent), 'parent', null, fixture.dirs);
    const child = await ownershipScan(writeRollout(fixture.child), 'child', 'parent', fixture.dirs);
    assert.deepEqual(
      commitRepositoryTargets(parent, child, [
        { sha: 'a'.repeat(40), at: ms(5), evidenceAt: ms(6), dirs: [fixture.dirs[0]], turnId: 'child-turn' },
      ]),
      [],
      issue,
    );
  },
);

test('completed Codex quiet commits keep their command windows and local directory forms', () => {
  const cases = [
    ['file:///C:/repo', 'C:/repo'],
    ['file:///workspace/repo', '/workspace/repo'],
    ['file://server/share/repo', '//server/share/repo'],
  ];
  for (const [cwd, dir] of cases) {
    const records = ordinaryTurn();
    records.splice(
      5,
      0,
      commandCompleted(5, 'git commit -q -m quiet', 0, 'completed', `quiet-${cwd}`, {
        cwd,
        stdout: '',
        started_at_ms: ms(3),
        completed_at_ms: ms(7),
      }),
    );
    assert.deepEqual(readCodexSession(writeRollout(records), 'sess').turns[0].commitIntents, [
      { dir, from: ms(3), to: ms(7), expected: 1 },
    ]);
  }
});

test('completed Codex commands refuse failed or incomplete quiet-commit evidence', () => {
  const invalid = [
    commandCompleted(5, 'git commit -q -m quiet', 1, 'completed', 'failed', {
      cwd: 'file:///C:/repo',
      stdout: '',
      started_at_ms: ms(3),
      completed_at_ms: ms(7),
    }),
    commandCompleted(5, 'git commit -q -m quiet', 0, 'completed', 'missing-start', {
      cwd: 'file:///C:/repo',
      stdout: '',
      completed_at_ms: ms(7),
    }),
    commandCompleted(5, 'git commit -q -m quiet', 0, 'completed', 'reversed-window', {
      cwd: 'file:///C:/repo',
      stdout: '',
      started_at_ms: ms(7),
      completed_at_ms: ms(3),
    }),
    commandCompleted(5, 'cd C:/recovered && git commit -q -m quiet', 0, 'completed', 'missing-cwd', {
      stdout: '',
      started_at_ms: ms(3),
      completed_at_ms: ms(7),
      cwd: 'relative/repo',
    }),
  ];
  for (const command of invalid) {
    const records = ordinaryTurn();
    records.splice(5, 0, command);
    assert.deepEqual(readCodexSession(writeRollout(records), 'sess').turns[0].commitIntents ?? [], []);
  }
});

test('an invalid completed-command directory leaves the printed commit unresolved', () => {
  const output = '[main f572f41] Add the camera plan\n 1 file changed, 186 insertions(+)\n';
  const records = ordinaryTurn();
  records[5] = commandCompleted(5, 'git commit -m visible', 0, 'completed', 'invalid-cwd', {
    cwd: 'relative/repo',
    stdout: output,
    started_at_ms: ms(3),
    completed_at_ms: ms(7),
  });
  records.splice(6, 0, toolOutput(6, 'call_a', `Script completed\nExit code: 0\nOutput:\n${output}`));
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  assert.equal(turn.commits.length, 1);
  assert.equal(turn.commits[0].dir, null);
  assert.deepEqual(turn.commitIntents ?? [], []);
});

test('completed Codex commit output stays a single printed row', () => {
  const records = ordinaryTurn();
  records.splice(
    5,
    0,
    commandCompleted(5, 'git commit -m visible', 0, 'completed', 'printed', {
      cwd: 'file:///C:/repo',
      stdout: '[main f572f41] Add the camera plan\n 1 file changed, 186 insertions(+)\n',
      started_at_ms: ms(3),
      completed_at_ms: ms(7),
    }),
  );
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  assert.equal(turn.commits.length, 1);
  assert.deepEqual(turn.commitIntents ?? [], []);
});

test('completed Codex guarded quiet commits retain their witnessed SHA and independent windows', () => {
  const records = ordinaryTurn();
  records.splice(
    5,
    0,
    commandCompleted(5, 'git commit -q -m quiet && git log --oneline -1 || echo aborted', 0, 'completed', 'guarded', {
      cwd: 'file:///C:/repo',
      stdout: 'f572f41 Add the camera plan\n',
      started_at_ms: ms(3),
      completed_at_ms: ms(7),
    }),
    commandCompleted(6, 'git commit -q -m later', 0, 'completed', 'later', {
      cwd: 'file:///C:/repo',
      stdout: '',
      started_at_ms: ms(5),
      completed_at_ms: ms(9),
    }),
  );
  const file = writeRollout(records);
  const intents = readCodexSession(file, 'sess').turns[0].commitIntents;
  assert.deepEqual(intents, [
    { dir: 'C:/repo', from: ms(3), to: ms(7), expected: 1, witnessedSha: 'f572f41' },
    { dir: 'C:/repo', from: ms(5), to: ms(9), expected: 1 },
  ]);
  const initial = readCodexSessionIncremental(file, 'sess');
  fs.appendFileSync(file, `${JSON.stringify({ type: 'ignored', payload: 'resume' })}\n`);
  const resumed = readCodexSessionIncremental(file, 'sess', initial.checkpoint ?? undefined);
  assert.deepEqual(resumed.read?.turns[0].commitIntents, readCodexSession(file, 'sess').turns[0].commitIntents);
});

test('the tool mix reads Codex’s own tool names, and leaves the two it has no tool for at zero', () => {
  const records = ordinaryTurn();
  records.splice(
    5,
    0,
    item('custom_tool_call', 4, { name: 'apply_patch', call_id: 'call_p' }),
    item('function_call', 4, { name: 'shell_command', call_id: 'call_s', arguments: '{}' }),
    item('function_call', 4, { name: 'update_plan', call_id: 'call_u', arguments: '{}' }),
    item('function_call', 4, { name: 'wait_agent', call_id: 'call_w', arguments: '{}' }),
  );
  const { turns } = readCodexSession(writeRollout(records), 'sess');
  assert.deepEqual(turns[0].toolCounts, {
    edits: 1,
    reads: 0,
    searches: 0,
    commands: 2,
    agents: 0,
    coordination: 1,
    web: 0,
    other: 1,
  });
  assert.deepEqual(turns[0].toolTally, {
    apply_patch: 1,
    shell_command: 1,
    update_plan: 1,
    wait_agent: 1,
    exec: 1,
  });
  assert.equal(turns[0].toolUses, 5);
  assert.deepEqual(
    turns[0].steps.filter((step) => step.sourceId?.startsWith('call_')).map((step) => step.sourceId),
    ['call_a', 'call_p', 'call_s', 'call_u', 'call_w'],
  );
});

test('agent coordination calls do not inflate the launch count', () => {
  const records = ordinaryTurn();
  records.splice(
    5,
    0,
    item('function_call', 4, {
      name: 'spawn_agent',
      call_id: 'call_x',
      arguments: JSON.stringify({ task_name: 'review_sol' }),
    }),
    item('function_call', 4, { name: 'wait_agent', call_id: 'call_w1', arguments: '{}' }),
    item('function_call', 4, { name: 'wait_agent', call_id: 'call_w2', arguments: '{}' }),
    item('function_call', 4, { name: 'wait_agent', call_id: 'call_w3', arguments: '{}' }),
  );
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  assert.equal(turn.toolCounts.agents, 1);
  assert.equal(turn.toolCounts.coordination, 3);
  assert.equal(turn.agents.length, 1);
  assert.equal(turn.toolTally.spawn_agent, 1);
  assert.equal(turn.toolTally.wait_agent, 3);
});

test('Codex tool names inherited by ordinary objects remain ordinary tally rows', () => {
  const records = ordinaryTurn();
  records.splice(
    5,
    0,
    item('function_call', 4, { name: 'constructor', call_id: 'call_c', arguments: '{}' }),
    item('function_call', 4, { name: 'toString', call_id: 'call_t', arguments: '{}' }),
    item('function_call', 4, { name: '__proto__', call_id: 'call_p', arguments: '{}' }),
  );
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  const names = ['constructor', 'toString', '__proto__', 'exec'];
  assert.deepEqual(Object.keys(turn.toolTally).sort(), names.slice().sort());
  for (const name of names) {
    assert.ok(Object.prototype.hasOwnProperty.call(turn.toolTally, name));
    assert.equal(turn.toolTally[name], 1);
  }
});

test('a web search counts, though Codex calls no tool to run one', () => {
  const records = ordinaryTurn();
  records.splice(
    5,
    0,
    item('web_search_call', 4, {
      status: 'completed',
      action: { type: 'search', query: 'unified diff trailing newline', queries: ['unified diff trailing newline'] },
    }),
  );
  const { turns } = readCodexSession(writeRollout(records), 'sess');
  // It is a record of its own with no `name` on it, so a tool-name table can never see it.
  assert.equal(turns[0].toolCounts.web, 1);
  assert.equal(turns[0].toolTally.web_search, 1);
  assert.equal(turns[0].toolUses, 2);
  assert.equal(turns[0].steps.find((step) => step.name === 'web_search')?.detail, 'unified diff trailing newline');
});

// An empty compaction turn creates no turn card. The compacted record still supplies the compaction boundary.

test('a turn that recorded nothing to look at is not a card', () => {
  const { turns, compactions } = readCodexSession(
    writeRollout([
      meta(),
      event('task_started', 1, { turn_id: 'compact-turn' }),
      { timestamp: at(2), type: 'compacted', payload: { message: '', replacement_history: [], window_number: 2 } },
      tokens(3, { input_tokens: 190000, cached_input_tokens: 180000, output_tokens: 8000 }),
      event('task_complete', 4, { turn_id: 'compact-turn', last_agent_message: '' }),
      event('task_started', 5, { turn_id: TURN }),
      event('user_message', 6, { message: 'carry on' }),
      event('task_complete', 7, { turn_id: TURN, last_agent_message: 'done' }),
    ]),
    'sess',
  );
  assert.deepEqual(
    turns.map((t) => t.promptId),
    [TURN],
  );
  // Compaction events remain visible when their surrounding empty turn is omitted.
  assert.equal(compactions.length, 1);
});

test('a completed visible FileChange counts as Codex work without a patch_apply_end record', () => {
  const records = [
    meta(),
    event('task_started', 1, { turn_id: 'file-change' }),
    event('item_completed', 2, {
      item: {
        type: 'FileChange',
        id: 'file-change-1',
        status: 'completed',
        changes: { 'c:\\repo\\src\\changed.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-old\n+new\n' } },
      },
    }),
    event('task_complete', 3, { turn_id: 'file-change', last_agent_message: '' }),
  ];
  assert.equal(readCodexSession(writeRollout(records), 'sess').turns.length, 1);
  const usage = createCodexUsageLineReducer();
  for (const record of records) {
    usage.pushLine(JSON.stringify(record));
  }
  assert.equal(usage.turnCount(), 1);
});

test('a Codex compaction uses the active turn shape as its trigger', () => {
  const records = [
    meta(),
    event('task_started', 1, { turn_id: 'manual' }),
    event('compacted', 2),
    event('compacted', 3),
    tokens(4, { input_tokens: 190_000, cached_input_tokens: 180_000, output_tokens: 8_000 }),
    event('task_complete', 5, { turn_id: 'manual', last_agent_message: '' }),
    event('task_started', 6, { turn_id: 'automatic' }),
    event('user_message', 7, { message: 'continue working' }),
    event('compacted', 8),
    event('compacted', 9),
    event('task_complete', 10, { turn_id: 'automatic', last_agent_message: 'done' }),
  ];
  const parsed = readCodexSession(writeRollout(records), 'sess');
  assert.deepEqual(
    parsed.compactions.map((compaction) => compaction.trigger),
    ['manual', 'manual', 'auto', 'auto'],
  );

  const usage = createCodexUsageLineReducer();
  for (const record of records) {
    usage.pushLine(JSON.stringify(record));
  }
  assert.deepEqual(
    usage.recentCompactions().map((compaction) => compaction.trigger),
    ['manual', 'manual', 'auto', 'auto'],
  );
});

test('a Codex compaction without its containing turn start remains unknown', () => {
  const [compaction] = readCodexSession(writeRollout([meta(), event('compacted', 1)]), 'sess').compactions;
  assert.equal(compaction.trigger, '');
});

test('a delayed copied turn context retracts its compaction from the session and spend ledgers', () => {
  const records = [
    meta(),
    event('task_started', 1, { turn_id: 'copied' }),
    event('user_message', 2, { message: 'replayed work' }),
    event('compacted', 3),
    event('task_complete', 4, { turn_id: 'copied', last_agent_message: 'done' }),
    event('task_started', 5, { turn_id: 'current' }),
    {
      timestamp: at(6),
      type: 'turn_context',
      payload: {
        turn_id: 'copied',
        model: 'gpt-5.6-sol',
        current_date: '2026-08-23',
      },
    },
  ];
  const file = writeRollout(records);
  const parsed = readCodexSession(file, 'sess');
  assert.equal(parsed.compactions.length, 0);
  const usage = createCodexUsageLineReducer();
  for (const record of records) {
    usage.pushLine(JSON.stringify(record));
  }
  assert.equal(usage.compactionCount(), 0);
  assert.deepEqual(usage.recentCompactions(), []);

  const folder = tempDir('codex-compaction-spend-');
  const ledgerFile = path.join(folder, 'rollout.jsonl');
  fs.copyFileSync(file, ledgerFile);
  const indexed = indexSpendFile(undefined, ledgerFile, 'workspace', createCodexUsageLineReducer, 1).record;
  assert.equal(indexed.compactionCount, 0);
  saveSpendLedger(folder, 'workspace', [indexed]);
  const loaded = loadSpendLedger(folder, 'workspace').files[0];
  assert.equal(loaded.compactionCount, 0);
  assert.equal((loaded.parserState as ReturnType<typeof usage.snapshot>).recentCompactions.length, 0);
  const rebuilt = indexSpendFile(
    { ...loaded, parserGeneration: PROJECT_SPEND_PARSER_GENERATION - 1 },
    ledgerFile,
    'workspace',
    createCodexUsageLineReducer,
    2,
  );
  assert.equal(rebuilt.rebuilt, true);
  assert.equal(rebuilt.record.compactionCount, 0);
});

test('Project cost rebuilds old GPT-6.1 Sol buckets for two short requests', () => {
  const file = writeRollout([
    meta({ model_provider: 'openai' }),
    event('task_started', 1, { turn_id: TURN, model_context_window: 1_050_000 }),
    turnContext(2, TURN, 'gpt-6.1-sol', 'high'),
    event('user_message', 3, { message: 'complete first request' }),
    tokens(4, { input_tokens: 200_000 }),
    event('task_complete', 5, { turn_id: TURN, last_agent_message: 'first done' }),
    event('task_started', 6, { turn_id: 'second', model_context_window: 1_050_000 }),
    turnContext(7, 'second', 'gpt-6.1-sol', 'high'),
    event('user_message', 8, { message: 'complete second request' }),
    tokens(9, { input_tokens: 200_000 }),
    event('task_complete', 10, { turn_id: 'second', last_agent_message: 'second done' }),
  ]);
  const current = indexSpendFile(undefined, file, 'workspace', createCodexUsageLineReducer, 1).record;
  const unbanded = current.buckets.map((bucket) => ({ ...bucket, contextBand: null }));
  const old = {
    ...current,
    parserGeneration: 26,
    buckets: unbanded,
    lifetimeBuckets: unbanded,
  };
  assert.equal(unbanded[0]?.requests, 2);
  assert.equal(publicProjectSpendPrice(unbanded[0]), null);
  const upgraded = indexSpendFile(old, file, 'workspace', createCodexUsageLineReducer, 2);
  assert.equal(upgraded.rebuilt, true);
  assert.equal(upgraded.record.buckets[0]?.contextBand, 'short');
  assert.equal(upgraded.record.buckets[0]?.requests, 2);
  assert.ok(Math.abs(publicProjectSpendPrice(upgraded.record.buckets[0])!.dollars - 0.8) < 1e-12);
});

test('retracting a copied Codex compaction keeps later compaction ordinals and billing identity', () => {
  const copied = 'copied';
  const current = 'current';
  const compacted = (second: number, exact = false) => ({
    timestamp: at(second),
    type: 'compacted',
    payload: {
      message: '',
      replacement_history: [],
      window_number: second,
      ...(exact
        ? { latest_token_usage_record: { usage: usage({ input_tokens: 152_584, output_tokens: 1_442 }) } }
        : {}),
    },
  });
  const records = [
    meta(),
    event('task_started', 1, { turn_id: copied }),
    event('user_message', 2, { message: 'replayed work' }),
    compacted(3),
    event('task_complete', 4, { turn_id: copied, last_agent_message: 'done' }),
    event('task_started', 5, { turn_id: current }),
    event('user_message', 6, { message: 'current work' }),
    compacted(7, true),
    {
      timestamp: at(8),
      type: 'turn_context',
      payload: {
        turn_id: copied,
        model: 'gpt-5.6-sol',
        current_date: '2026-08-23',
      },
    },
    event('thread_settings_applied', 9, {
      thread_settings: { model: 'gpt-5.6-sol', model_provider_id: 'openai', service_tier: 'default' },
    }),
    compacted(10),
  ];

  const usageReducer = createCodexUsageLineReducer();
  for (const record of records) {
    usageReducer.pushLine(JSON.stringify(record));
  }
  assert.equal(usageReducer.compactionCount(), 2);
  assert.deepEqual(
    usageReducer.recentCompactions().map((item) => item.ordinal),
    [1, 2],
  );

  const parsed = readCodexSession(writeRollout(records), 'sess');
  assert.equal(parsed.compactions.length, 2);
  assert.equal(parsed.compactions[0].model, 'gpt-5.6-sol');
  assert.equal(
    toCompactionCard(parsed.compactions[0]).chips.find((chip) => chip.label.startsWith('$'))?.label,
    '$0.64',
  );
});

test('a session is identified by the id that belongs to its own rollout', () => {
  // The opening id identifies this rollout. session_id can be shared across rollouts.

  const file = writeRollout([meta({ id: 'this-rollout', session_id: 'shared-between-rollouts' })]);
  assert.equal(readCodexSessionMeta(file)?.sessionId, 'this-rollout');
});

test('a subagent the turn spawned is listed with what it was asked to be', () => {
  const records = ordinaryTurn();
  records.splice(
    5,
    0,
    item('function_call', 4, {
      name: 'spawn_agent',
      call_id: 'call_x',
      arguments: JSON.stringify({ task_name: 'review_sol', model: 'gpt-5.6-sol', reasoning_effort: 'high' }),
    }),
    item('function_call_output', 5, { call_id: 'call_x', output: '{"task_name":"/root/review_sol"}' }),
    event('sub_agent_activity', 5, {
      event_id: 'call_x',
      agent_thread_id: 'thread-2',
      agent_path: '/root/review_sol',
      kind: 'started',
    }),
  );
  const { turns } = readCodexSession(writeRollout(records), 'sess');
  assert.deepEqual(turns[0].agents, [
    {
      id: 'thread-2',
      description: 'review_sol',
      agentType: '/root/review_sol',
      model: 'gpt-5.6-sol',
      effort: 'high',
      spend: [],
      spendFound: false,
      spendPartial: false,
      startedAt: ms(4),
      durationMs: null,
      tokens: null,
      toolUses: null,
      // A finished parent turn supplies no recorded completion for this subagent. Keep its launched status.

      status: 'launched',
    },
  ]);
});

test('a subagent that failed to launch is not reported as a running child', () => {
  const records = ordinaryTurn();
  records.splice(
    5,
    0,
    item('function_call', 4, {
      name: 'spawn_agent',
      call_id: 'call_x',
      arguments: JSON.stringify({ task_name: 'review_terra', model: 'gpt-5.6-terra' }),
    }),
    item('function_call_output', 5, {
      call_id: 'call_x',
      output: 'agent path `/root/review_terra` already exists',
    }),
  );
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  assert.deepEqual(turn.agents, []);
  assert.equal(turn.steps.find((step) => step.name === 'spawn_agent')?.status, 'failed');
  assert.deepEqual(turn.failures, [
    {
      tool: 'spawn_agent',
      message: 'agent path `/root/review_terra` already exists',
    },
  ]);
});

test('a spawned Codex rollout keeps billed requests under their turn models and reports nested work', () => {
  const other = '01a032c9-2000-7000-8000-000000000002';
  const file = writeRollout([
    meta(),
    event('task_started', 1, { turn_id: TURN }),
    turnContext(2, TURN, 'gpt-5.6-sol', 'high'),
    tokens(3, { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10, reasoning_output_tokens: 4 }),
    event('task_started', 4, { turn_id: other }),
    // Deliberately after the usage record. The grouping is by turn id, not record order.
    tokens(5, { input_tokens: 50, cached_input_tokens: 20, output_tokens: 5 }),
    turnContext(6, other, 'gpt-5.6-terra', 'medium'),
    item('function_call', 7, { name: 'spawn_agent', call_id: 'nested', arguments: '{}' }),
  ]);
  const { artifacts: _artifacts, ...spend } = readCodexAgentSpend(file);
  assert.deepEqual(
    { ...spend, models: spend.models.map(({ usageParts: _usageParts, ...model }) => model) },
    {
      models: [
        {
          model: 'gpt-5.6-sol',
          contextWindow: 258400,
          usage: shortPricedUsage({
            requests: 1,
            input: 20,
            cacheWrite1h: 0,
            cacheWrite5m: 0,
            cacheWrite30m: 0,
            cacheRead: 80,
            output: 10,
            thinking: 4,
          }),
        },
        {
          model: 'gpt-5.6-terra',
          contextWindow: 258400,
          usage: shortPricedUsage({
            requests: 1,
            input: 30,
            cacheWrite1h: 0,
            cacheWrite5m: 0,
            cacheWrite30m: 0,
            cacheRead: 20,
            output: 5,
            thinking: 0,
          }),
        },
      ],
      found: true,
      partial: true,
      effort: 'medium',
    },
  );
  assert.deepEqual(
    spend.models.map((model) =>
      model.usageParts?.map((part) => [
        part.model,
        part.provider,
        part.contextWindow,
        part.contextBand,
        part.inferenceClass,
        part.serviceTier,
      ]),
    ),
    [[['gpt-5.6-sol', null, 258400, 'short', null, null]], [['gpt-5.6-terra', null, 258400, 'short', null, null]]],
  );
  assert.deepEqual(readCodexAgentSpend(path.join(path.dirname(file), 'missing.jsonl')), {
    models: [],
    found: false,
    partial: false,
    effort: null,
  });
});

test('a Codex child with no recorded effort leaves it blank', () => {
  const file = writeRollout([
    meta(),
    event('task_started', 1, { turn_id: TURN }),
    event('user_message', 2, { message: 'inspect' }),
  ]);
  assert.equal(readCodexAgentSpend(file).effort, null);
});

test('a spawned Codex rollout preserves provider and tier changes on request parts', () => {
  const file = writeRollout([
    meta({ model_provider: 'openai' }),
    event('task_started', 1, { turn_id: TURN }),
    {
      type: 'thread_settings_applied',
      timestamp: at(2),
      payload: {
        thread_settings: { model_provider_id: 'openai', service_tier: 'priority' },
      },
    },
    turnContext(3, TURN, 'gpt-5.6-sol', 'high'),
    tokens(4, { input_tokens: 100, output_tokens: 10 }),
    {
      type: 'thread_settings_applied',
      timestamp: at(5),
      payload: {
        thread_settings: { model_provider_id: 'amazon-bedrock', service_tier: 'standard' },
      },
    },
    turnContext(6, TURN, 'openai.gpt-5.6-sol', 'high'),
    tokens(7, { input_tokens: 200, output_tokens: 20 }),
  ]);
  assert.deepEqual(
    readCodexAgentSpend(file)
      .models.flatMap((part) => part.usageParts ?? [])
      .map((part) => ({
        provider: part.provider,
        model: part.model,
        serviceTier: part.serviceTier,
        inferenceClass: part.inferenceClass,
        requests: part.usage.requests,
      })),
    [
      { provider: 'openai', model: 'gpt-5.6-sol', serviceTier: 'priority', inferenceClass: null, requests: 1 },
      {
        provider: 'amazon-bedrock',
        model: 'openai.gpt-5.6-sol',
        serviceTier: 'standard',
        inferenceClass: 'in-region',
        requests: 1,
      },
    ],
  );
});

test('a historical Bedrock default-tier rollout keeps a priced request identity', () => {
  const file = writeRollout([
    meta({ model_provider: 'amazon-bedrock', cli_version: '0.147.0-alpha.6.5' }),
    event('task_started', 1, { turn_id: TURN }),
    {
      type: 'thread_settings_applied',
      timestamp: at(2),
      payload: {
        thread_settings: { model_provider_id: 'amazon-bedrock', service_tier: 'default' },
      },
    },
    turnContext(3, TURN, 'openai.gpt-5.6-sol', 'high'),
    tokens(4, { input_tokens: 1_000_000 }),
    event('task_complete', 5, { turn_id: TURN, last_agent_message: 'done' }),
  ]);
  const [turn] = readCodexSession(file, 'sess').turns;
  assert.ok(turn.usageParts);
  assert.deepEqual(
    turn.usageParts.map((part) => ({
      provider: part.provider,
      model: part.model,
      serviceTier: part.serviceTier,
    })),
    [{ provider: 'amazon-bedrock', model: 'openai.gpt-5.6-sol', serviceTier: 'default' }],
  );
  assert.deepEqual(turnCost(turn), { dollars: 8.8, partial: false });
});

test('Codex usage events retain provider, cache categories, model context, and metered state', () => {
  const state = emptyCodexUsageReducerState();
  reduceCodexUsageRecord(state, {
    kind: 'session_meta',
    timestamp: ms(0),
    payload: { model_provider: 'amazon-bedrock' },
  });
  reduceCodexUsageRecord(state, { kind: 'rate_limits', timestamp: ms(1), payload: { plan_type: 'pro' } });
  reduceCodexUsageRecord(state, {
    kind: 'task_started',
    timestamp: ms(2),
    payload: { turn_id: TURN, model_context_window: 258400 },
  });
  reduceCodexUsageRecord(state, {
    kind: 'turn_context',
    timestamp: ms(3),
    payload: { turn_id: TURN, model: 'openai.gpt-5.6-sol' },
  });
  const restored = JSON.parse(JSON.stringify(state));
  const event = reduceCodexUsageRecord(restored, {
    kind: 'token_count',
    timestamp: ms(4),
    payload: {
      info: {
        model_context_window: 258400,
        last_token_usage: usage({
          input_tokens: 100,
          cached_input_tokens: 60,
          cache_write_input_tokens: 30,
          output_tokens: 10,
          reasoning_output_tokens: 4,
        }),
      },
    },
  });
  assert.deepEqual(event, {
    timestamp: ms(4),
    agent: 'codex',
    provider: 'amazon-bedrock',
    model: 'openai.gpt-5.6-sol',
    contextWindow: 258400,
    contextBand: 'short',
    billingClass: 'metered',
    inferenceClass: 'in-region',
    serviceTier: null,
    effort: null,
    toolListVersion: null,
    reportedCost: null,
    requestKey: `codex:${TURN}:${ms(4)}:1`,
    // This request records no cache lifetime, so the model policy supplies it.
    visibleTurnId: `codex-turn:${TURN}`,
    cacheLifetime: null,
    compactionsBefore: 0,
    usage: {
      requests: 1,
      input: 10,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      cacheWrite30m: 30,
      cacheRead: 60,
      output: 10,
      thinking: 4,
    },
  });
});

test('repeated Codex usage snapshots do not create another billed request', () => {
  const first = usage({
    input_tokens: 247_116,
    cache_write_input_tokens: 247_114,
    output_tokens: 116,
    reasoning_output_tokens: 16,
    total_tokens: 247_232,
  });
  const total = usage({
    input_tokens: 10_010_557,
    cache_write_input_tokens: 10_010_421,
    output_tokens: 34_098,
    reasoning_output_tokens: 15_715,
    total_tokens: 10_044_655,
  });
  const reducer = createCodexUsageLineReducer();
  reducer.pushLine(JSON.stringify(meta({ model_provider: 'openai' })));
  reducer.pushLine(JSON.stringify(event('task_started', 1, { turn_id: TURN })));
  reducer.pushLine(JSON.stringify(turnContext(2, TURN, 'gpt-5.6-sol', 'high')));
  const tokenCount = (second: number, lastTokenUsage: unknown, totalTokenUsage: unknown) =>
    event('token_count', second, {
      info: { last_token_usage: lastTokenUsage, total_token_usage: totalTokenUsage, model_context_window: 258400 },
    });

  assert.equal(
    reducer.pushLine(JSON.stringify(recordedAt(tokenCount(3, first, total), '2026-08-14T20:18:10.117Z'))).length,
    1,
  );
  const resumed = createCodexUsageLineReducer(reducer.snapshot());
  assert.deepEqual(
    resumed.pushLine(JSON.stringify(recordedAt(tokenCount(4, first, total), '2026-08-14T20:18:11.296Z'))),
    [],
  );

  const advanced = usage({
    ...total,
    input_tokens: 10_257_673,
    cache_write_input_tokens: 10_257_535,
    output_tokens: 34_214,
    reasoning_output_tokens: 15_731,
    total_tokens: 10_291_887,
  });
  assert.equal(
    resumed.pushLine(JSON.stringify(tokenCount(5, first, advanced))).length,
    1,
    'an equal-sized request with an advancing cumulative counter must remain billed',
  );
  const reset = usage({
    ...total,
    input_tokens: 247_116,
    cache_write_input_tokens: 247_114,
    output_tokens: 116,
    reasoning_output_tokens: 16,
    total_tokens: 247_232,
  });
  assert.equal(
    resumed.pushLine(JSON.stringify(tokenCount(6, first, reset))).length,
    1,
    'a cumulative reset inside the turn must remain billed',
  );
  assert.equal(
    resumed.pushLine(JSON.stringify(tokenCount(7, first, undefined))).length,
    1,
    'a record without cumulative evidence must remain billed',
  );

  const nextTurn = '01a032c9-2000-7000-8000-000000000003';
  resumed.pushLine(JSON.stringify(event('task_started', 8, { turn_id: nextTurn })));
  resumed.pushLine(JSON.stringify(turnContext(9, nextTurn, 'gpt-5.6-sol', 'high')));
  assert.equal(
    resumed.pushLine(JSON.stringify(tokenCount(10, first, total))).length,
    1,
    'a new turn can restart cumulative counters at the same values',
  );
});

test('a Codex turn retains usage under each request pricing identity', () => {
  const records = [
    meta({ model_provider: 'openai' }),
    event('task_started', 1, { turn_id: TURN }),
    {
      type: 'thread_settings_applied',
      timestamp: at(2),
      payload: {
        thread_settings: { service_tier: 'priority', model_provider_id: 'openai' },
      },
    },
    turnContext(3, TURN, 'gpt-5.6-sol', 'high'),
    tokens(4, { input_tokens: 100, output_tokens: 10 }),
    {
      type: 'thread_settings_applied',
      timestamp: at(5),
      payload: {
        thread_settings: { service_tier: 'standard', model_provider_id: 'openai' },
      },
    },
    turnContext(6, TURN, 'gpt-5.6-terra', 'high'),
    tokens(7, { input_tokens: 200, output_tokens: 20 }),
    tokens(8, { input_tokens: 300, output_tokens: 30 }),
    event('task_complete', 9, { turn_id: TURN, last_agent_message: 'done' }),
  ];
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  assert.deepEqual(
    turn.usageParts?.map((part) => ({
      model: part.model,
      provider: part.provider,
      contextWindow: part.contextWindow,
      contextBand: part.contextBand,
      inferenceClass: part.inferenceClass,
      serviceTier: part.serviceTier,
      requests: part.usage.requests,
    })),
    [
      {
        model: 'gpt-5.6-sol',
        provider: 'openai',
        contextWindow: 258400,
        contextBand: 'short',
        inferenceClass: null,
        serviceTier: 'priority',
        requests: 1,
      },
      {
        model: 'gpt-5.6-terra',
        provider: 'openai',
        contextWindow: 258400,
        contextBand: 'short',
        inferenceClass: null,
        serviceTier: 'standard',
        requests: 2,
      },
    ],
  );
  assert.equal(turn.usageParts?.length, 2, 'equal pricing identities must stay aggregated');
});

test('a Codex turn marks a request with missing usage as incomplete', () => {
  const records = [
    meta({ model_provider: 'openai' }),
    event('task_started', 1, { turn_id: TURN }),
    turnContext(2, TURN, 'gpt-5.6-sol', 'high'),
    event('token_count', 3, { info: { total_token_usage: usage({ input_tokens: 100 }) } }),
    event('task_complete', 4, { turn_id: TURN, last_agent_message: 'done' }),
  ];
  const [turn] = readCodexSession(writeRollout(records), 'sess').turns;
  assert.equal(turn.usage.requests, 1);
  assert.deepEqual(
    turn.usageParts?.map((part) => ({ incomplete: part.incomplete, requests: part.usage.requests })),
    [{ incomplete: true, requests: 1 }],
  );
});

test('embedded plan and thread settings classify OpenAI requests without changing Bedrock billing', () => {
  const state = emptyCodexUsageReducerState();
  reduceCodexUsageRecord(state, { kind: 'session_meta', timestamp: ms(0), payload: { model_provider: 'openai' } });
  reduceCodexUsageRecord(state, {
    kind: 'thread_settings_applied',
    timestamp: ms(1),
    payload: {
      thread_settings: { service_tier: 'priority', model_provider_id: 'openai' },
    },
  });
  reduceCodexUsageRecord(state, { kind: 'task_started', timestamp: ms(2), payload: { turn_id: TURN } });
  reduceCodexUsageRecord(state, {
    kind: 'turn_context',
    timestamp: ms(3),
    payload: { turn_id: TURN, model: 'gpt-5.6-sol' },
  });
  const request = reduceCodexUsageRecord(state, {
    kind: 'token_count',
    timestamp: ms(4),
    payload: {
      rate_limits: { plan_type: 'prolite' },
      info: { last_token_usage: usage({ input_tokens: 10 }) },
    },
  });
  assert.equal(request?.billingClass, 'subscription');
  assert.equal(request?.serviceTier, 'priority');
});

test('an incremental Codex reducer holds token usage until its later turn context names the model', () => {
  const first = createCodexUsageLineReducer();
  first.pushLine(JSON.stringify(meta({ model_provider: 'openai' })));
  first.pushLine(JSON.stringify(event('task_started', 1, { turn_id: TURN, model_context_window: 258400 })));
  assert.deepEqual(first.pushLine(JSON.stringify(tokens(2, { input_tokens: 300_001, output_tokens: 3 }))), []);
  const resumed = createCodexUsageLineReducer(first.snapshot());
  const released = resumed.pushLine(JSON.stringify(turnContext(3, TURN, 'gpt-5.6-sol', 'high')));
  assert.deepEqual(
    released.map((request) => ({
      model: request.model,
      contextBand: request.contextBand,
      requestKey: request.requestKey,
      usage: request.usage,
    })),
    [
      {
        model: 'gpt-5.6-sol',
        contextBand: 'long',
        requestKey: `codex:${TURN}:${ms(2)}:1`,
        usage: {
          requests: 1,
          input: 300_001,
          cacheWrite1h: 0,
          cacheWrite5m: 0,
          cacheWrite30m: 0,
          cacheRead: 0,
          output: 3,
          thinking: 0,
        },
      },
    ],
  );
  assert.deepEqual(
    resumed.pushLine(JSON.stringify(turnContext(4, TURN, 'gpt-5.6-sol', 'high'))),
    [],
    'the later context must not issue a correction for a request already released',
  );

  const legacy = first.snapshot() as Partial<ReturnType<typeof first.snapshot>>;
  delete legacy.pendingRequests;
  assert.doesNotThrow(
    () =>
      createCodexUsageLineReducer(legacy as ReturnType<typeof first.snapshot>).pushLine(
        JSON.stringify(turnContext(5, TURN, 'gpt-5.6-sol', 'high')),
      ),
    'a ledger written before pending request state was added cannot resume',
  );
});

test('known and delayed models use the same clamped request volume for pricing bands', () => {
  const records = [meta({ model_provider: 'openai' }), event('task_started', 1, { turn_id: TURN })];
  const tokenRecord = tokens(3, {
    input_tokens: 200_000,
    cached_input_tokens: 200_000,
    cache_write_input_tokens: 100_000,
  });
  const known = createCodexUsageLineReducer();
  records.forEach((record) => known.pushLine(JSON.stringify(record)));
  known.pushLine(JSON.stringify(turnContext(2, TURN, 'gpt-5.6-sol', 'high')));
  const [knownRequest] = known.pushLine(JSON.stringify(tokenRecord));

  const delayed = createCodexUsageLineReducer();
  records.forEach((record) => delayed.pushLine(JSON.stringify(record)));
  assert.deepEqual(delayed.pushLine(JSON.stringify(tokenRecord)), []);
  const [delayedRequest] = delayed.pushLine(JSON.stringify(turnContext(4, TURN, 'gpt-5.6-sol', 'high')));

  assert.equal(knownRequest.contextBand, 'long');
  assert.equal(delayedRequest.contextBand, 'long');
  assert.deepEqual(knownRequest.usage, delayedRequest.usage);
});

test('the incremental Codex usage filter retains every record that changes request identity', () => {
  const reducer = createCodexUsageLineReducer();
  const push = (record: unknown) => reducer.pushLine(JSON.stringify(record));
  push(meta({ model_provider: 'openai' }));
  push(event('rate_limits', 1, { plan_type: 'pro' }));
  push({
    type: 'thread_settings_applied',
    timestamp: new Date(ms(2)).toISOString(),
    payload: {
      thread_settings: { service_tier: 'priority', model_provider_id: 'openai' },
    },
  });
  push(event('task_started', 3, { turn_id: TURN, model_context_window: 258400 }));
  push(turnContext(4, TURN, 'gpt-5.6-sol', 'high'));
  const [request] = push(tokens(5, { input_tokens: 10, output_tokens: 2 }));
  assert.deepEqual(
    {
      provider: request.provider,
      billingClass: request.billingClass,
      serviceTier: request.serviceTier,
      model: request.model,
      contextWindow: request.contextWindow,
    },
    {
      provider: 'openai',
      billingClass: 'subscription',
      serviceTier: 'priority',
      model: 'gpt-5.6-sol',
      contextWindow: 258400,
    },
  );
  assert.deepEqual(
    push({
      type: 'response_item',
      timestamp: new Date(ms(6)).toISOString(),
      payload: {
        type: 'function_call_output',
        output: 'x'.repeat(1024 * 1024),
      },
    }),
    [],
  );
});

test('the incremental Codex usage reducer counts drawable turns and excludes empty ones', () => {
  const first = createCodexUsageLineReducer();
  first.pushLine(JSON.stringify(event('task_started', 1, { turn_id: 'abandoned' })));
  assert.equal(first.turnCount(), 1, 'the current open turn was omitted');
  first.pushLine(JSON.stringify(event('task_started', 2, { turn_id: 'empty' })));
  assert.equal(first.turnCount(), 1, 'an empty prior turn was retained after the next start');
  first.pushLine(JSON.stringify(event('task_complete', 3, { turn_id: 'empty', last_agent_message: '' })));
  assert.equal(first.turnCount(), 0, 'an empty completed turn was counted');
  first.pushLine(JSON.stringify(event('task_started', 4, { turn_id: 'asked' })));
  first.pushLine(JSON.stringify(message('user', 5, 'fix it')));
  first.pushLine(JSON.stringify(event('task_complete', 6, { turn_id: 'asked', last_agent_message: 'done' })));
  assert.equal(first.turnCount(), 1);

  const resumed = createCodexUsageLineReducer(first.snapshot());
  resumed.pushLine(JSON.stringify(event('task_started', 7, { turn_id: 'running' })));
  assert.equal(resumed.turnCount(), 2, 'a resumed reducer lost its completed turn count');

  const ignored = createCodexUsageLineReducer();
  ignored.pushLine(JSON.stringify(event('task_started', 1, { turn_id: 'empty-patch' })));
  ignored.pushLine(JSON.stringify(event('patch_apply_end', 2, { success: true, changes: {} })));
  ignored.pushLine(JSON.stringify(event('task_complete', 3, { last_agent_message: '' })));
  ignored.pushLine(JSON.stringify(event('task_started', 4, { turn_id: 'state-patch' })));
  ignored.pushLine(
    JSON.stringify(
      event('patch_apply_end', 5, {
        success: true,
        changes: { [path.join(os.homedir(), '.codex', 'config.toml')]: { type: 'update' } },
      }),
    ),
  );
  ignored.pushLine(JSON.stringify(event('task_complete', 6, { last_agent_message: '' })));
  ignored.pushLine(JSON.stringify(event('task_started', 7, { turn_id: 'not-interrupted' })));
  ignored.pushLine(JSON.stringify(event('turn_aborted', 8, { reason: 'replaced' })));
  ignored.pushLine(JSON.stringify(event('task_complete', 9, { last_agent_message: 'late completion' })));
  assert.equal(ignored.turnCount(), 0, 'non-drawable patch and abort records were counted');
});

test('the incremental Codex usage reducer tracks compactions and the session span across a resume', () => {
  const first = createCodexUsageLineReducer();
  assert.equal(first.compactionCount(), 0, 'a session with no compaction reports zero, not a missing value');
  assert.equal(first.firstTurnAt(), null);
  assert.equal(first.lastTurnAt(), null);

  first.pushLine(JSON.stringify(event('task_started', 1, { turn_id: 'first' })));
  assert.equal(first.firstTurnAt(), ms(1));
  assert.equal(first.lastTurnAt(), ms(1), 'an open turn falls back to its startedAt');
  first.pushLine(JSON.stringify(event('task_complete', 2, { turn_id: 'first', last_agent_message: 'done' })));
  assert.equal(first.lastTurnAt(), ms(2), 'a completed turn reports its completion time as endedAt');
  assert.equal(first.newestTurnStartedAt(), ms(1));
  assert.deepEqual(first.newestTurnOutcome(), {
    finished: true,
    error: false,
    interrupted: false,
    endedAt: ms(2),
    startedAt: ms(1),
  });
  first.pushLine(JSON.stringify(event('compacted', 3, {})));
  assert.equal(first.compactionCount(), 1);
  assert.equal(first.lastTurnAt(), ms(2), 'a compaction does not move the last turn span');

  const resumed = createCodexUsageLineReducer(first.snapshot());
  assert.equal(resumed.compactionCount(), 1, 'a resumed reducer kept its compaction count');
  assert.equal(resumed.newestTurnStartedAt(), ms(1));
  assert.deepEqual(resumed.newestTurnOutcome(), {
    finished: true,
    error: false,
    interrupted: false,
    endedAt: ms(2),
    startedAt: ms(1),
  });
  assert.equal(resumed.firstTurnAt(), ms(1), 'a resumed reducer kept the first turn it saw');
  resumed.pushLine(JSON.stringify(event('task_started', 4, { turn_id: 'second' })));
  assert.equal(resumed.firstTurnAt(), ms(1), 'the first turn never moves once a later turn opens');
  assert.equal(resumed.lastTurnAt(), ms(4), 'the newly opened turn is now the last one, open and not yet completed');
  resumed.pushLine(JSON.stringify(event('compacted', 5, {})));
  assert.equal(resumed.compactionCount(), 2);
});

test('the incremental Codex usage reducer spans only the turns turnCount() counts', () => {
  const reducer = createCodexUsageLineReducer();
  reducer.pushLine(JSON.stringify(event('task_started', 1, { turn_id: 'empty' })));
  reducer.pushLine(JSON.stringify(event('task_started', 3, { turn_id: 'real' })));
  reducer.pushLine(JSON.stringify(event('task_complete', 5, { turn_id: 'real', last_agent_message: 'done' })));

  assert.equal(reducer.turnCount(), 1, 'the empty task before the real turn was counted');
  assert.equal(reducer.firstTurnAt(), ms(3), 'the span started at the empty task instead of the real turn');
  assert.equal(reducer.lastTurnAt(), ms(5));
  assert.equal(reducer.lastTurnAt()! - reducer.firstTurnAt()!, ms(5) - ms(3), 'the span was not 2 seconds');
});

test('the incremental Codex usage reducer does not extend the span into a trailing empty task', () => {
  const reducer = createCodexUsageLineReducer();
  reducer.pushLine(JSON.stringify(event('task_started', 1, { turn_id: 'real' })));
  reducer.pushLine(JSON.stringify(event('task_complete', 3, { turn_id: 'real', last_agent_message: 'done' })));
  reducer.pushLine(JSON.stringify(event('task_started', 5, { turn_id: 'empty' })));
  reducer.pushLine(JSON.stringify(event('task_complete', 9, { turn_id: 'empty', last_agent_message: '' })));

  assert.equal(reducer.turnCount(), 1, 'the trailing empty task was counted');
  assert.equal(reducer.firstTurnAt(), ms(1));
  assert.equal(
    reducer.lastTurnAt(),
    ms(3),
    'the span ran into the trailing empty task instead of stopping at the real turn',
  );
});

test('the incremental Codex usage reducer reports no span when every task is empty', () => {
  const reducer = createCodexUsageLineReducer();
  reducer.pushLine(JSON.stringify(event('task_started', 1, { turn_id: 'first-empty' })));
  reducer.pushLine(JSON.stringify(event('task_complete', 3, { turn_id: 'first-empty', last_agent_message: '' })));
  reducer.pushLine(JSON.stringify(event('task_started', 5, { turn_id: 'second-empty' })));
  reducer.pushLine(JSON.stringify(event('task_complete', 9, { turn_id: 'second-empty', last_agent_message: '' })));

  assert.equal(reducer.turnCount(), 0, 'an empty-only rollout counted a turn');
  assert.equal(reducer.firstTurnAt(), null, 'an empty-only rollout named a first turn');
  assert.equal(reducer.lastTurnAt(), null, 'an empty-only rollout named a last turn with no counted turn to match it');
});

test('a late reclassification of a counted turn drops the span along with the turn it retracts', () => {
  const lateContext = (second: number, turnId: string) => ({
    timestamp: at(second),
    type: 'turn_context',
    payload: { turn_id: turnId, cwd: 'c:\\repo', model: 'gpt-5.6-sol', effort: 'high', current_date: '2026-08-24' },
  });
  const push = (reducer: ReturnType<typeof createCodexUsageLineReducer>) => {
    reducer.pushLine(JSON.stringify(meta()));
    reducer.pushLine(JSON.stringify(event('task_started', 1, { turn_id: 'A' })));
    reducer.pushLine(JSON.stringify(event('task_complete', 2, { turn_id: 'A', last_agent_message: 'A done' })));
    reducer.pushLine(JSON.stringify(event('task_started', 3, { turn_id: 'B' })));
    reducer.pushLine(JSON.stringify(event('task_complete', 4, { turn_id: 'B', last_agent_message: 'B done' })));
    reducer.pushLine(JSON.stringify(event('task_started', 5, { turn_id: 'C' })));
    const beforeRetraction = reducer.snapshot();
    assert.equal(beforeRetraction.closedTurns, 2, 'B was still counted before the delayed context arrived');
    assert.equal(beforeRetraction.lastTurnAt, ms(4), 'B still stood for the last counted turn before the retraction');
    // The delayed turn_context reclassifies B as copied after C has already made B the
    // last counted turn's boundary. Retracting B must not leave that boundary standing.
    reducer.pushLine(JSON.stringify(lateContext(6, 'B')));
    reducer.pushLine(JSON.stringify(event('task_complete', 7, { turn_id: 'C', last_agent_message: '' })));
    return reducer;
  };

  const reducer = push(createCodexUsageLineReducer());
  assert.equal(reducer.turnCount(), 1, 'A is still the one turn the ledger counts');
  assert.equal(
    reducer.firstTurnAt(),
    null,
    'the retracted turn B had become the boundary; no other value is known to be right',
  );
  assert.equal(
    reducer.lastTurnAt(),
    null,
    "reporting B's end after B was retracted would disagree with the turn count",
  );
  assert.equal(reducer.newestTurnStartedAt(), null, 'a copied turn kept its start as a newest rail fact');
  assert.equal(reducer.newestTurnOutcome(), null, 'a copied turn kept its outcome as a newest rail fact');

  const resumed = createCodexUsageLineReducer(reducer.snapshot());
  assert.equal(resumed.turnCount(), 1, 'a resumed reducer lost track of the retraction');
  assert.equal(
    resumed.firstTurnAt(),
    null,
    'a resumed reducer re-grew a first-turn boundary the live reducer had dropped',
  );
  assert.equal(
    resumed.lastTurnAt(),
    null,
    'a resumed reducer re-grew a last-turn boundary the live reducer had dropped',
  );
  assert.equal(resumed.newestTurnStartedAt(), null, 'a resumed reducer restored a retracted start');
  assert.equal(resumed.newestTurnOutcome(), null, 'a resumed reducer restored a retracted outcome');
});

test('the incremental Codex spend reducer bounds turn associations across checkpoints', () => {
  const total = CODEX_USAGE_ASSOCIATION_LIMIT * 4;
  const run = (checkpoint: boolean) => {
    let reducer = createCodexUsageLineReducer();
    const requests = [];
    reducer.pushLine(JSON.stringify(meta({ model_provider: 'openai' })));
    for (let index = 0; index < total; index++) {
      const turnId = `bounded-spend-${index}`;
      const second = index * 5 + 1;
      reducer.pushLine(
        JSON.stringify(
          event('task_started', second, {
            turn_id: turnId,
            model_context_window: 258400,
          }),
        ),
      );
      reducer.pushLine(JSON.stringify(turnContext(second + 1, turnId, 'gpt-5.6-sol', 'high')));
      reducer.pushLine(JSON.stringify(event('user_message', second + 2, { message: `work ${index}` })));
      requests.push(...reducer.pushLine(JSON.stringify(tokens(second + 3, { input_tokens: index + 1 }))));
      reducer.pushLine(
        JSON.stringify(
          event('task_complete', second + 4, {
            turn_id: turnId,
            last_agent_message: 'done',
          }),
        ),
      );
      if (checkpoint && index % 17 === 16) {
        reducer = createCodexUsageLineReducer(reducer.snapshot());
      }
    }
    return { reducer, requests, state: reducer.snapshot() };
  };

  const uninterrupted = run(false);
  const resumed = run(true);
  assert.deepEqual(resumed.requests, uninterrupted.requests);
  assert.equal(resumed.requests.length, total);
  assert.equal(resumed.reducer.turnCount(), total);
  assert.equal(resumed.state.closedTurns, total - 1);
  assert.deepEqual(
    {
      recentTurnIds: resumed.state.recentTurnIds.length,
      seenTurnIds: Object.keys(resumed.state.seenTurnIds).length,
      countedTurnIds: Object.keys(resumed.state.countedTurnIds).length,
      turnModels: Object.keys(resumed.state.turnModels).length,
      turnWindows: Object.keys(resumed.state.turnWindows).length,
    },
    {
      recentTurnIds: CODEX_USAGE_ASSOCIATION_LIMIT,
      seenTurnIds: CODEX_USAGE_ASSOCIATION_LIMIT,
      countedTurnIds: CODEX_USAGE_ASSOCIATION_LIMIT - 1,
      turnModels: CODEX_USAGE_ASSOCIATION_LIMIT,
      turnWindows: CODEX_USAGE_ASSOCIATION_LIMIT,
    },
  );
  resumed.reducer.pushLine(JSON.stringify(turnContext(total * 5 + 1, 'bounded-spend-0', 'gpt-5.6-sol', 'high')));
  const afterLateContext = resumed.reducer.snapshot();
  assert.equal(afterLateContext.turnModels['bounded-spend-0'], undefined);
  assert.equal(Object.keys(afterLateContext.turnModels).length, CODEX_USAGE_ASSOCIATION_LIMIT);
});

test('the incremental Codex spend reducer bounds compaction associations across checkpoints', () => {
  let reducer = createCodexUsageLineReducer();
  reducer.pushLine(JSON.stringify(meta()));
  for (let index = 0; index <= CODEX_USAGE_ASSOCIATION_LIMIT; index++) {
    const turnId = `bounded-compaction-${index}`;
    reducer.pushLine(JSON.stringify(event('task_started', index * 3 + 1, { turn_id: turnId })));
    reducer.pushLine(JSON.stringify(event('compacted', index * 3 + 2)));
    reducer.pushLine(
      JSON.stringify(event('task_complete', index * 3 + 3, { turn_id: turnId, last_agent_message: '' })),
    );
    if (index === 31) {
      reducer = createCodexUsageLineReducer(reducer.snapshot());
    }
  }
  const state = reducer.snapshot();
  assert.equal(Object.keys(state.compactionTurnOrdinals).length, CODEX_USAGE_ASSOCIATION_LIMIT);
  assert.equal(state.compactionTurnOrdinals['bounded-compaction-0'], undefined);
  assert.deepEqual(
    Object.keys(state.compactionTurnOrdinals),
    Array.from({ length: CODEX_USAGE_ASSOCIATION_LIMIT }, (_value, index) => `bounded-compaction-${index + 1}`),
  );

  reducer.pushLine(JSON.stringify(event('task_started', 200, { turn_id: 'many-compactions' })));
  for (let index = 0; index <= RETAINED_COMPACTIONS; index++) {
    reducer.pushLine(JSON.stringify(event('compacted', 201 + index)));
  }
  const retained = reducer.snapshot().compactionTurnOrdinals['many-compactions'];
  assert.equal(retained.length, RETAINED_COMPACTIONS);
  assert.deepEqual(
    retained,
    Array.from({ length: RETAINED_COMPACTIONS }, (_value, index) => CODEX_USAGE_ASSOCIATION_LIMIT + index + 3),
  );
});

test('model-less Codex requests leave retained state once without losing their usage', () => {
  const reducer = createCodexUsageLineReducer();
  reducer.pushLine(JSON.stringify(event('task_started', 1, { turn_id: TURN })));
  const requests = [];
  for (let index = 0; index <= CODEX_USAGE_ASSOCIATION_LIMIT; index++) {
    requests.push(...reducer.pushLine(JSON.stringify(tokens(index + 2, { input_tokens: index + 1 }))));
  }
  const held = reducer.snapshot();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, null);
  assert.equal(held.pendingRequestKeys.length, CODEX_USAGE_ASSOCIATION_LIMIT);
  assert.equal(held.pendingRequests[TURN].length, CODEX_USAGE_ASSOCIATION_LIMIT);

  const resumed = createCodexUsageLineReducer(held);
  requests.push(
    ...resumed.pushLine(JSON.stringify(turnContext(CODEX_USAGE_ASSOCIATION_LIMIT + 3, TURN, 'gpt-5.6-sol', 'high'))),
  );
  assert.equal(requests.length, CODEX_USAGE_ASSOCIATION_LIMIT + 1);
  assert.equal(new Set(requests.map((request) => request.requestKey)).size, requests.length);
  assert.equal(resumed.snapshot().pendingRequestKeys.length, 0);
});

test('the incremental Codex spend reducer bounds Claude command identities', () => {
  const reducer = createCodexUsageLineReducer();
  for (const record of turnWithClaudeCommands().slice(0, 4)) {
    reducer.pushLine(JSON.stringify(record));
  }
  const total = CODEX_USAGE_ASSOCIATION_LIMIT * 4;
  for (let index = 0; index < total; index++) {
    reducer.pushLine(
      JSON.stringify(
        claudeCommandCompleted(
          index + 4,
          `bounded-command-${index}`,
          claudePrintResult({ session_id: `bounded-session-${index}` }),
        ),
      ),
    );
  }
  let state = reducer.snapshot();
  assert.deepEqual(
    {
      invocationIds: state.recentClaudeInvocationIds.length,
      invocations: Object.keys(state.seenClaudeInvocations).length,
      commandIds: state.recentClaudeCommandIds.length,
      commands: Object.keys(state.seenClaudeCommands).length,
    },
    {
      invocationIds: CODEX_USAGE_ASSOCIATION_LIMIT,
      invocations: CODEX_USAGE_ASSOCIATION_LIMIT,
      commandIds: CODEX_USAGE_ASSOCIATION_LIMIT,
      commands: CODEX_USAGE_ASSOCIATION_LIMIT,
    },
  );
  const newest = JSON.stringify(
    claudeCommandCompleted(
      total + 4,
      `bounded-command-${total - 1}`,
      claudePrintResult({ session_id: `bounded-session-${total - 1}` }),
    ),
  );
  const resumed = createCodexUsageLineReducer(state);
  assert.deepEqual(resumed.pushLine(newest), []);

  for (let index = 0; index < total; index++) {
    resumed.pushLine(
      JSON.stringify(
        claudeCommandCompleted(total + index + 5, `pending-command-${index}`, '{"type":"result","session_id":'),
      ),
    );
  }
  state = resumed.snapshot();
  assert.equal(state.pendingClaudeResultIds.length, CODEX_USAGE_ASSOCIATION_LIMIT);
  assert.equal(Object.keys(state.pendingClaudeResults).length, CODEX_USAGE_ASSOCIATION_LIMIT);
  const replacement = resumed.pushLine(
    JSON.stringify(
      claudeCommandCompleted(
        total * 2 + 5,
        `pending-command-${total - 1}`,
        claudePrintResult({ session_id: `pending-session-${total - 1}` }),
      ),
    ),
  );
  assert.deepEqual(
    replacement.map((entry) => [entry.incomplete ?? false, entry.usage.requests]),
    [
      [true, -1],
      [false, 1],
      [false, 1],
    ],
  );
});

function replayedSubagentRollout(includeStartedAt = true): object[] {
  const opening = Date.parse('2026-08-27T00:26:41.322Z');
  const copied = Array.from({ length: 3 }, (_, index) => {
    const turnId = `copied-${index}`;
    return [
      recordedAt(
        event('task_started', 0, {
          turn_id: turnId,
          ...(includeStartedAt ? { started_at: Date.parse(`2026-08-${24 + index}T12:00:00Z`) / 1000 } : {}),
        }),
        `2026-08-27T00:26:41.${323 + index * 10}Z`,
      ),
      recordedAt(
        {
          type: 'turn_context',
          payload: {
            turn_id: turnId,
            cwd: 'c:\\repo',
            model: 'gpt-5.6-sol',
            effort: 'high',
            current_date: includeStartedAt ? '2026-08-27' : '2026-08-26',
          },
        },
        `2026-08-27T00:26:41.${324 + index * 10}Z`,
      ),
      recordedAt(
        event('user_message', 0, { message: `inherited prompt ${index}` }),
        `2026-08-27T00:26:41.${325 + index * 10}Z`,
      ),
      recordedAt(
        tokens(0, { input_tokens: 100 + index, output_tokens: 10 }),
        `2026-08-27T00:26:41.${326 + index * 10}Z`,
      ),
      recordedAt(
        event('task_complete', 0, { turn_id: turnId, last_agent_message: `inherited answer ${index}` }),
        `2026-08-27T00:26:41.${327 + index * 10}Z`,
      ),
    ];
  }).flat();
  const ownTurn = 'child-own-turn';
  return [
    recordedAt(
      meta({
        id: 'child-thread',
        session_id: 'child-thread',
        thread_source: 'subagent',
        parent_thread_id: 'parent-thread',
      }),
      '2026-08-27T00:26:41.322Z',
    ),
    recordedAt(meta({ id: 'parent-thread', session_id: 'parent-thread' }), '2026-08-27T00:26:41.323Z'),
    ...copied,
    recordedAt(
      event('task_started', 0, {
        turn_id: ownTurn,
        started_at: Math.floor(opening / 1000),
        model_context_window: 258400,
      }),
      '2026-08-27T00:26:41.569Z',
    ),
    recordedAt(
      {
        type: 'turn_context',
        payload: {
          turn_id: ownTurn,
          cwd: 'c:\\repo',
          model: 'gpt-5.6-sol',
          effort: 'high',
          current_date: '2026-08-27',
        },
      },
      '2026-08-27T00:26:41.570Z',
    ),
    recordedAt(event('user_message', 0, { message: 'child prompt' }), '2026-08-27T00:26:41.571Z'),
    recordedAt(tokens(0, { input_tokens: 13, output_tokens: 2 }), '2026-08-27T00:26:41.572Z'),
    recordedAt(
      event('task_complete', 0, { turn_id: ownTurn, last_agent_message: 'child answer' }),
      '2026-08-27T00:26:41.573Z',
    ),
  ];
}

function legacyGuardianRollout(): object[] {
  const payloadTime = '2026-08-25T12:00:05.000Z';
  const records: object[] = [
    recordedAt(
      meta({
        id: 'legacy-guardian',
        session_id: 'parent-thread',
        parent_thread_id: 'parent-thread',
        thread_source: 'subagent',
        source: { subagent: { other: 'guardian' } },
        model_provider: 'openai',
        timestamp: payloadTime,
      }),
      '2026-08-25T12:00:10.355Z',
    ),
  ];
  for (let index = 0; index < 4; index++) {
    const turnId = `review-${index}`;
    const startedAt = Date.parse(payloadTime) / 1_000 + index * 10;
    records.push(
      recordedAt(
        event('task_started', 0, {
          turn_id: turnId,
          started_at: startedAt,
          model_context_window: 258400,
        }),
        new Date(Date.parse(payloadTime) + 5_356 + index * 10_000).toISOString(),
      ),
      recordedAt(
        turnContext(0, turnId, 'codex-auto-review', 'low'),
        new Date(Date.parse(payloadTime) + 5_357 + index * 10_000).toISOString(),
      ),
      recordedAt(
        event('user_message', 0, { message: `review request ${index}` }),
        new Date(Date.parse(payloadTime) + 5_358 + index * 10_000).toISOString(),
      ),
      recordedAt(
        tokens(0, { input_tokens: 10 + index, output_tokens: 1 }),
        new Date(Date.parse(payloadTime) + 5_359 + index * 10_000).toISOString(),
      ),
      recordedAt(
        event('task_complete', 0, { turn_id: turnId, last_agent_message: 'allow' }),
        new Date(Date.parse(payloadTime) + 5_360 + index * 10_000).toISOString(),
      ),
    );
  }
  return records;
}

test('a legacy guardian keeps every genuine turn across all Codex readers', () => {
  const records = legacyGuardianRollout();
  const reducer = createCodexUsageLineReducer();
  const requests = records.flatMap((record) => reducer.pushLine(JSON.stringify(record)));
  assert.equal(requests.length, 4);
  assert.equal(reducer.turnCount(), 4);

  const file = writeRollout(records);
  assert.deepEqual(
    readCodexSession(file, 'legacy-guardian').turns.map((turn) => turn.promptId),
    ['review-0', 'review-1', 'review-2', 'review-3'],
  );
  assert.equal(
    readCodexAgentSpend(file).models.reduce((total, model) => total + (model.usage.requests ?? 0), 0),
    4,
  );
});

test('an ordinary dispatched child still rejects a near-boundary parent replay', () => {
  const records = [
    recordedAt(
      meta({
        id: 'dispatched-child',
        session_id: 'dispatched-child',
        thread_source: 'subagent',
        source: { subagent: { thread_spawn: { parent_thread_id: 'parent-thread', agent_path: '/root/review' } } },
        timestamp: '2026-08-25T12:00:04.000Z',
      }),
      '2026-08-25T12:00:10.000Z',
    ),
    recordedAt(
      event('task_started', 0, {
        turn_id: 'parent-turn',
        started_at: Date.parse('2026-08-25T12:00:04.000Z') / 1_000,
      }),
      '2026-08-25T12:00:10.001Z',
    ),
    recordedAt(turnContext(0, 'parent-turn', 'gpt-5.6-sol', 'high'), '2026-08-25T12:00:10.002Z'),
    recordedAt(event('user_message', 0, { message: 'inherited prompt' }), '2026-08-25T12:00:10.003Z'),
    recordedAt(tokens(0, { input_tokens: 99 }), '2026-08-25T12:00:10.004Z'),
    recordedAt(
      event('task_complete', 0, { turn_id: 'parent-turn', last_agent_message: 'inherited answer' }),
      '2026-08-25T12:00:10.005Z',
    ),
    recordedAt(
      event('task_started', 0, {
        turn_id: 'child-turn',
        started_at: Date.parse('2026-08-25T12:00:10.000Z') / 1_000,
      }),
      '2026-08-25T12:00:10.006Z',
    ),
    recordedAt(turnContext(0, 'child-turn', 'gpt-5.6-sol', 'high'), '2026-08-25T12:00:10.007Z'),
    recordedAt(event('user_message', 0, { message: 'child prompt' }), '2026-08-25T12:00:10.008Z'),
    recordedAt(tokens(0, { input_tokens: 12 }), '2026-08-25T12:00:10.009Z'),
    recordedAt(
      event('task_complete', 0, { turn_id: 'child-turn', last_agent_message: 'child answer' }),
      '2026-08-25T12:00:10.010Z',
    ),
  ];
  const reducer = createCodexUsageLineReducer();
  assert.deepEqual(
    records.flatMap((record) => reducer.pushLine(JSON.stringify(record))).map((request) => request.usage.input),
    [12],
  );
  assert.deepEqual(
    readCodexSession(writeRollout(records), 'dispatched-child').turns.map((turn) => turn.promptId),
    ['child-turn'],
  );
});

test('a valid legacy payload clock survives a malformed opening envelope in every reader', () => {
  const records = [
    recordedAt(
      meta({
        id: 'legacy-guardian',
        session_id: 'parent-thread',
        parent_thread_id: 'parent-thread',
        thread_source: 'subagent',
        source: { subagent: { other: 'guardian' } },
        model_provider: 'openai',
        timestamp: '2026-08-25T12:00:10.000Z',
      }),
      'not-a-time',
    ),
    recordedAt(
      event('task_started', 0, {
        turn_id: 'inherited',
        started_at: Date.parse('2026-08-25T12:00:00.000Z') / 1_000,
      }),
      '2026-08-25T12:00:10.001Z',
    ),
    recordedAt(turnContext(0, 'inherited', 'codex-auto-review', 'low'), '2026-08-25T12:00:10.002Z'),
    recordedAt(event('user_message', 0, { message: 'inherited review' }), '2026-08-25T12:00:10.003Z'),
    recordedAt(tokens(0, { input_tokens: 99 }), '2026-08-25T12:00:10.004Z'),
    recordedAt(
      event('task_complete', 0, { turn_id: 'inherited', last_agent_message: 'old' }),
      '2026-08-25T12:00:10.005Z',
    ),
    recordedAt(
      event('task_started', 0, {
        turn_id: 'guardian-own',
        started_at: Date.parse('2026-08-25T12:00:10.000Z') / 1_000,
      }),
      '2026-08-25T12:00:10.006Z',
    ),
    recordedAt(turnContext(0, 'guardian-own', 'codex-auto-review', 'low'), '2026-08-25T12:00:10.007Z'),
    recordedAt(event('user_message', 0, { message: 'current review' }), '2026-08-25T12:00:10.008Z'),
    recordedAt(tokens(0, { input_tokens: 12 }), '2026-08-25T12:00:10.009Z'),
    recordedAt(
      event('task_complete', 0, { turn_id: 'guardian-own', last_agent_message: 'allow' }),
      '2026-08-25T12:00:10.010Z',
    ),
  ];
  const reducer = createCodexUsageLineReducer();
  assert.deepEqual(
    records.flatMap((record) => reducer.pushLine(JSON.stringify(record))).map((request) => request.usage.input),
    [12],
  );

  const file = writeRollout(records);
  assert.deepEqual(
    readCodexSession(file, 'legacy-guardian').turns.map((turn) => turn.promptId),
    ['guardian-own'],
  );
  assert.equal(
    readCodexAgentSpend(file).models.reduce((total, model) => total + (model.usage.requests ?? 0), 0),
    1,
  );
});

test('a replayed parent history does not become child usage, turns, or cards', () => {
  const records = replayedSubagentRollout();
  const reducer = createCodexUsageLineReducer();
  const requests = records.flatMap((record) => reducer.pushLine(JSON.stringify(record)));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].usage.input, 13);
  assert.equal(reducer.turnCount(), 1);

  const { turns } = readCodexSession(writeRollout(records), 'child-thread');
  assert.deepEqual(
    turns.map((turn) => [turn.promptId, turn.prompt, turn.usage.requests]),
    [['child-own-turn', 'child prompt', 1]],
  );
});

test('an old replay without started_at uses its recorded current date', () => {
  const records = replayedSubagentRollout(false);
  const reducer = createCodexUsageLineReducer();
  const requests = records.flatMap((record) => reducer.pushLine(JSON.stringify(record)));
  assert.equal(requests.length, 1);
  assert.equal(reducer.turnCount(), 1);
  assert.deepEqual(
    readCodexSession(writeRollout(records), 'child-thread').turns.map((turn) => turn.promptId),
    ['child-own-turn'],
  );
});

test('a repeated turn id is treated as replayed when its clocks cannot decide', () => {
  const records = [
    meta(),
    event('task_started', 1, { turn_id: 'first' }),
    turnContext(2, 'first', 'gpt-5.6-sol', 'high'),
    event('user_message', 3, { message: 'first prompt' }),
    tokens(4, { input_tokens: 11 }),
    event('task_complete', 5, { turn_id: 'first', last_agent_message: 'first answer' }),
    event('task_started', 6, { turn_id: 'first' }),
    turnContext(7, 'first', 'gpt-5.6-sol', 'high'),
    event('user_message', 8, { message: 'copied prompt' }),
    tokens(9, { input_tokens: 99 }),
    event('task_complete', 10, { turn_id: 'first', last_agent_message: 'copied answer' }),
    event('task_started', 11, { turn_id: 'second' }),
    turnContext(12, 'second', 'gpt-5.6-sol', 'high'),
    event('user_message', 13, { message: 'second prompt' }),
    tokens(14, { input_tokens: 12 }),
    event('task_complete', 15, { turn_id: 'second', last_agent_message: 'second answer' }),
  ];
  const reducer = createCodexUsageLineReducer();
  const requests = records.flatMap((record) => reducer.pushLine(JSON.stringify(record)));
  assert.deepEqual(
    requests.map((request) => request.usage.input),
    [11, 12],
  );
  assert.equal(reducer.turnCount(), 2);
  assert.deepEqual(
    readCodexSession(writeRollout(records), 'sess').turns.map((turn) => turn.prompt),
    ['first prompt', 'second prompt'],
  );
});

test('a copied turn is removed when its dated context arrives after the next turn starts', () => {
  const records = [
    recordedAt(meta(), '2026-08-27T12:00:00.000Z'),
    recordedAt(event('task_started', 0, { turn_id: 'copied' }), '2026-08-27T12:00:00.001Z'),
    recordedAt(event('user_message', 0, { message: 'copied prompt' }), '2026-08-27T12:00:00.002Z'),
    recordedAt(tokens(0, { input_tokens: 99 }), '2026-08-27T12:00:00.003Z'),
    recordedAt(
      event('task_complete', 0, { turn_id: 'copied', last_agent_message: 'copied answer' }),
      '2026-08-27T12:00:00.004Z',
    ),
    recordedAt(event('task_started', 0, { turn_id: 'own' }), '2026-08-27T12:00:00.005Z'),
    recordedAt(turnContext(0, 'own', 'gpt-5.6-sol', 'high'), '2026-08-27T12:00:00.006Z'),
    recordedAt(
      {
        type: 'turn_context',
        payload: {
          turn_id: 'copied',
          cwd: 'c:\\repo',
          model: 'gpt-5.6-sol',
          effort: 'high',
          current_date: '2026-08-26',
        },
      },
      '2026-08-27T12:00:00.007Z',
    ),
    recordedAt(event('user_message', 0, { message: 'own prompt' }), '2026-08-27T12:00:00.008Z'),
    recordedAt(tokens(0, { input_tokens: 12 }), '2026-08-27T12:00:00.009Z'),
    recordedAt(
      event('task_complete', 0, { turn_id: 'own', last_agent_message: 'own answer' }),
      '2026-08-27T12:00:00.010Z',
    ),
  ];
  const reducer = createCodexUsageLineReducer();
  const requests = records.flatMap((record) => reducer.pushLine(JSON.stringify(record)));
  assert.deepEqual(
    requests.map((request) => request.usage.input),
    [12],
  );
  assert.equal(reducer.turnCount(), 1);
  assert.deepEqual(
    readCodexSession(writeRollout(records), 'child-thread').turns.map((turn) => turn.promptId),
    ['own'],
  );
});

test.each([false, true])(
  'dated copied prompts retract person evidence before and after the launch in full and bounded reads (%s)',
  (copiedFirst) => {
    const launch = [
      event('task_started', 1, { turn_id: 'launch' }),
      event('user_message', 2, { message: 'work' }),
      message('user', 2, 'work'),
    ];
    const copied = [
      event('task_started', 3, { turn_id: 'copied' }),
      event('user_message', 4, { message: 'copied prompt' }),
      event('task_complete', 5, { turn_id: 'copied' }),
    ];
    const records = [
      meta(),
      ...(copiedFirst ? [...copied, ...launch] : [...launch, ...copied]),
      event('task_started', 6, { turn_id: 'next' }),
    ];
    const file = writeRollout(records);
    let scan = scanForCodexPerson(file, fs.statSync(file).size);
    assert.equal(scan.person, true);
    fs.appendFileSync(
      file,
      JSON.stringify({
        ...turnContext(7, 'copied', 'gpt-5.6-sol', 'high'),
        payload: { turn_id: 'copied', current_date: '2026-08-24' },
      }) + '\n',
    );
    scan = scanForCodexPerson(file, fs.statSync(file).size, scan);
    assert.equal(scan.person, false);
    assert.equal(readCodexDispatchedSpend([file], [], Date.now() + 6000).person, false);
    fs.appendFileSync(file, JSON.stringify(event('user_message', 8, { message: 'please continue' })) + '\n');
    assert.equal(scanForCodexPerson(file, fs.statSync(file).size, scan).person, true);
    assert.equal(readCodexDispatchedSpend([file], [], Date.now() + 6000).person, true);
  },
);

test.each(['event', 'response'])(
  'headless dispatch continuations retain final agent classification through active and quiet reads (%s)',
  (shape) => {
    const id = UUID_B;
    const parent = writeRollout([
      meta(),
      event('task_started', 1, { turn_id: TURN }),
      turnContext(1, TURN, 'gpt-6.1-sol', 'high'),
      commandCompleted(2, 'python dispatch.py --runner codex --arc-dispatch', 0, 'completed', 'dispatch', {
        stdout: `ARC_DISPATCH_SESSION={"agent":"codex","session_id":"${id}"}`,
      }),
    ]);
    const [edge] = scanCodexDispatchReferences(parent, 'parent').references;
    assert.equal(edge.sessionId, id);
    assert.equal(edge.owned, false);
    const root = sessionsRoot([
      { day: '2026/08/25', name: ROLLOUT(id), records: [meta({ id, source: 'exec', originator: 'codex_exec' })] },
    ]);
    const [session] = codexSessionFiles(root, ['c:\\repo']).sessions;
    let scan = scanForCodexPerson(session.file, fs.statSync(session.file).size, undefined, id);
    for (let index = 0; index < 3; index++) {
      const second = index * 5 + 1;
      const prompt = `task ${index}`;
      const records = [
        event('task_started', second, { turn_id: String(index) }),
        shape === 'event'
          ? event('user_message', second + 1, { message: prompt })
          : message('user', second + 1, prompt),
        turnContext(second + 2, String(index), 'gpt-6.1-sol', 'high'),
        tokens(second + 3, { input_tokens: 10 }),
        event('task_complete', second + 4, { turn_id: String(index) }),
      ];
      fs.appendFileSync(session.file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
      scan = scanForCodexPerson(session.file, fs.statSync(session.file).size, scan, id);
      if (index < 2) continue;
      for (const now of [Date.now(), Date.now() + 6000]) {
        const spend = readCodexDispatchedSpend([session.file], [], now);
        assert.equal(
          agentRunAnswer(session.agentRun === true, id, new Set(), false, true, edge.owned || spend.person),
          true,
        );
        assert.equal(spend.person, false);
        assert.equal(scan.person, spend.person);
        assert.equal(
          agentRunAnswer(session.agentRun === true, id, new Set(), false, true, edge.owned || scan.person),
          true,
        );
        assert.equal(agentRunAnswer(true, id, new Set([id]), false, true, scan.person), false);
        assert.equal(agentRunAnswer(true, id, new Set(), false, true, true), false);
        assert.equal(agentRunAnswer(true, id, new Set([id]), true, true, true), true);
      }
      assert.equal(scan.dispatchCompletion?.terminal?.id, String(index));
      assert.equal(scanForCodexPerson(session.file, fs.statSync(session.file).size, scan, id).person, false);
    }
    assert.equal(
      scan.prompts.reduce((sum, entry) => sum + entry.count, 0),
      3,
    );
  },
);

test.each(['cli', 'vscode'])(
  'interactive Codex resume metadata retains reader ownership across bounded appends (%s)',
  (source) => {
    const file = writeRollout([
      meta({ source: 'exec' }),
      event('task_started', 1, { turn_id: 'launch' }),
      event('user_message', 2, { message: 'work' }),
      message('user', 2, 'work'),
      event('task_complete', 3, { turn_id: 'launch' }),
    ]);
    let scan = scanForCodexPerson(file, fs.statSync(file).size);
    assert.equal(scan.person, false);
    fs.appendFileSync(file, JSON.stringify(recordedAt(meta({ source }), at(6))) + '\n');
    scan = scanForCodexPerson(file, fs.statSync(file).size, scan);
    assert.equal(scan.person, false, 'resume metadata alone adds no prompt');
    fs.appendFileSync(
      file,
      [
        event('task_started', 7, { turn_id: 'resumed' }),
        message('user', 8, 'continue'),
        event('task_complete', 9, { turn_id: 'resumed' }),
        recordedAt(meta({ source: 'exec' }), at(10)),
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    scan = scanForCodexPerson(file, fs.statSync(file).size, scan);
    assert.equal(scan.person, true);
    assert.equal(scanForCodexPerson(file, fs.statSync(file).size, scan).person, true);
    assert.equal(readCodexDispatchedSpend([file], [], Date.now() + 6000).person, true);
    assert.equal(agentRunAnswer(true, UUID_A, new Set(), false, true, scan.person), false);
  },
);

test.each([
  'foreign',
  'foreign history',
  'missing identity',
  'replayed opening',
  'older clock',
  'copied turn',
  'unknown source',
])('unqualified Codex resume metadata preserves headless ownership (%s)', (shape) => {
  const records: object[] = [
    meta({ source: 'exec' }),
    event('task_started', 1, { turn_id: 'launch' }),
    event('user_message', 2, { message: 'work' }),
    event('task_complete', 3, { turn_id: 'launch' }),
  ];
  if (shape === 'copied turn') records.push(event('task_started', 4, { turn_id: 'copy', started_at: ms(-60) / 1000 }));
  if (shape === 'foreign history') records.push(recordedAt(meta({ id: UUID_B, source: 'cli' }), at(5)));
  records.push(
    recordedAt(
      meta({
        source: shape === 'unknown source' ? 'unknown' : 'cli',
        ...(shape === 'foreign' ? { id: UUID_B } : {}),
        ...(shape === 'missing identity' ? { id: null, session_id: null } : {}),
      }),
      at(shape === 'replayed opening' ? 0 : shape === 'older clock' ? -10 : 6),
    ),
  );
  records.push(
    recordedAt(meta({ source: 'exec' }), at(7)),
    event('task_started', 8, { turn_id: 'continuation' }),
    message('user', 9, 'continue'),
    event('task_complete', 10, { turn_id: 'continuation' }),
  );
  const file = writeRollout(records);
  const scan = scanForCodexPerson(file, fs.statSync(file).size);
  assert.equal(scan.person, false);
  assert.equal(readCodexDispatchedSpend([file], [], Date.now() + 6000).person, false);
  assert.equal(agentRunAnswer(true, UUID_A, new Set(), false, true, scan.person), true);
});

test.each(
  ['cli', 'vscode'].flatMap((source) =>
    ['same turn', 'next turn'].flatMap((context) => ['whole', 'appends'].map((read) => ({ source, context, read }))),
  ),
)(
  'delayed copied Codex resume metadata preserves final agent filing ($source, $context, $read)',
  ({ source, context, read }) => {
    const opening = [
      meta({ source: 'exec' }),
      event('task_started', 1, { turn_id: 'launch' }),
      event('user_message', 2, { message: 'work' }),
      event('task_complete', 3, { turn_id: 'launch' }),
    ];
    const copied = [
      event('task_started', 4, { turn_id: 'copy' }),
      recordedAt(meta({ source }), at(6)),
      event('user_message', 6, { message: 'copied work' }),
    ];
    const date = {
      ...turnContext(10, 'copy', 'gpt-6.1-sol', 'high'),
      payload: { turn_id: 'copy', current_date: '2026-08-24' },
    };
    const continuation = [
      recordedAt(meta({ source: 'exec' }), at(8)),
      event('task_started', 9, { turn_id: 'continuation' }),
    ];
    const end = [message('user', 11, 'continue'), event('task_complete', 12, { turn_id: 'continuation' })];
    const batches = [
      opening,
      copied,
      ...(context === 'same turn' ? [[date], continuation] : [continuation, [date]]),
      end,
    ];
    const file = writeRollout(read === 'whole' ? batches.flat() : opening);
    let scan = scanForCodexPerson(file, fs.statSync(file).size);
    if (read === 'appends') {
      for (const batch of batches.slice(1)) {
        fs.appendFileSync(file, batch.map((record) => JSON.stringify(record)).join('\n') + '\n');
        scan = scanForCodexPerson(file, fs.statSync(file).size, scan);
      }
    }
    assert.equal(agentRunAnswer(true, UUID_A, new Set(), false, true, scan.person), true);
    const spend = readCodexDispatchedSpend([file], [], Date.now() + 6000);
    assert.equal(agentRunAnswer(true, UUID_A, new Set(), false, true, spend.person), true);
    assert.equal(scan.person, spend.person);
    assert.equal(
      scan.prompts.reduce((sum, entry) => sum + entry.count, 0),
      2,
    );
  },
);

test.each(['outside turn', 'genuine turn'])(
  'delayed copied Codex resume retains independent interactive evidence (%s)',
  (provenance) => {
    const file = writeRollout([
      meta({ source: 'exec' }),
      ...(provenance === 'outside turn' ? [recordedAt(meta({ source: 'vscode' }), at(1))] : []),
      event('task_started', 2, { turn_id: 'launch' }),
      ...(provenance === 'genuine turn' ? [recordedAt(meta({ source: 'vscode' }), at(3))] : []),
      event('user_message', 4, { message: 'work' }),
      event('task_complete', 5, { turn_id: 'launch' }),
      event('task_started', 6, { turn_id: 'copy' }),
      recordedAt(meta({ source: 'cli' }), at(7)),
      event('task_started', 8, { turn_id: 'continuation' }),
    ]);
    let scan = scanForCodexPerson(file, fs.statSync(file).size);
    fs.appendFileSync(
      file,
      [
        { ...turnContext(9, 'copy', 'gpt-6.1-sol', 'high'), payload: { turn_id: 'copy', current_date: '2026-08-24' } },
        message('user', 10, 'continue'),
        event('task_complete', 11, { turn_id: 'continuation' }),
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    scan = scanForCodexPerson(file, fs.statSync(file).size, scan);
    assert.equal(agentRunAnswer(true, UUID_A, new Set(), false, true, scan.person), false);
    assert.equal(
      agentRunAnswer(
        true,
        UUID_A,
        new Set(),
        false,
        true,
        readCodexDispatchedSpend([file], [], Date.now() + 6000).person,
      ),
      false,
    );
  },
);

test('delayed copied Codex resume retracts metadata-only turns beyond the usage association limit', () => {
  const copiedIds = Array.from({ length: CODEX_USAGE_ASSOCIATION_LIMIT + 1 }, (_, index) => `copy-${index}`);
  const file = writeRollout([
    meta({ source: 'exec' }),
    event('task_started', 1, { turn_id: 'launch' }),
    event('user_message', 2, { message: 'work' }),
    event('task_complete', 3, { turn_id: 'launch' }),
    ...copiedIds.flatMap((turn_id, index) => [
      event('task_started', 4 + index * 2, { turn_id }),
      recordedAt(meta({ source: 'cli' }), at(5 + index * 2)),
    ]),
    event('task_started', 150, { turn_id: 'continuation' }),
  ]);
  let scan = scanForCodexPerson(file, fs.statSync(file).size);
  assert.equal(
    scan.prompts.reduce((sum, entry) => sum + entry.count, 0),
    1,
    'metadata adds no prompts',
  );
  fs.appendFileSync(
    file,
    [
      ...copiedIds.map((turn_id) => ({
        ...turnContext(151, turn_id, 'gpt-6.1-sol', 'high'),
        payload: { turn_id, current_date: '2026-08-24' },
      })),
      message('user', 152, 'continue'),
      event('task_complete', 153, { turn_id: 'continuation' }),
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  scan = scanForCodexPerson(file, fs.statSync(file).size, scan);
  assert.equal(agentRunAnswer(true, UUID_A, new Set(), false, true, scan.person), true);
  assert.equal(
    agentRunAnswer(
      true,
      UUID_A,
      new Set(),
      false,
      true,
      readCodexDispatchedSpend([file], [], Date.now() + 6000).person,
    ),
    true,
  );
  assert.equal(scan.prompts.length, 2, 'copied metadata-only evidence is removed');
});

test.each(['cli', 'vscode', undefined])(
  'interactive and unknown Codex launches retain prompt ownership (%s)',
  (source) => {
    const file = writeRollout([
      meta({ source }),
      event('user_message', 1, { message: 'first' }),
      message('user', 1, 'first'),
      event('user_message', 2, { message: 'second' }),
    ]);
    assert.equal(scanForCodexPerson(file, fs.statSync(file).size).person, true);
    assert.equal(readCodexDispatchedSpend([file], [], Date.now() + 6000).person, true);
  },
);

test('bounded person reads retain a context line larger than the opening window before the first launch', () => {
  const file = writeRollout([
    meta(),
    { type: 'turn_context', payload: { instructions: 'x'.repeat(300 * 1024) } },
    event('task_started', 1, { turn_id: 'launch' }),
  ]);
  const firstSize = fs.statSync(file).size;
  const first = scanForCodexPerson(file, firstSize);
  assert.ok(first.bytes <= 256 * 1024);
  assert.ok(first.fragment.length > 0);
  fs.appendFileSync(
    file,
    [event('user_message', 2, { message: 'work' }), message('user', 2, 'work')]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  const next = scanForCodexPerson(file, fs.statSync(file).size, first);
  assert.equal(next.person, false);
  assert.equal(next.fragment.length, 0);
  assert.equal(next.prompts.length, 1);
  assert.equal(readCodexDispatchedSpend([file], [], Date.now() + 6000).person, false);
});

test('dispatch completion requires an owned final terminal across bounded slices', () => {
  const start = event('task_started', 1, { turn_id: 'work', started_at: ms(1) });
  const end = event('task_complete', 4, { turn_id: 'work' });
  const opening = meta({ id: 'child', session_id: 'child', source: 'exec' });
  const cases: Array<[string, object[], boolean]> = [
    ['owned', [opening, start, end], true],
    ['aborted', [opening, start, event('turn_aborted', 4, { turn_id: 'work' })], true],
    ['duplicate', [opening, start, end, end], true],
    ['settings', [opening, start, end, { type: 'thread_settings_applied', payload: {} }], true],
    ['limits', [opening, start, end, event('rate_limits', 5)], true],
    ['missing start', [opening, end], false],
    ['missing identity', [opening, event('task_started', 1), end], false],
    ['missing clock', [opening, { ...start, timestamp: '' }, end], false],
    ['missing opening clock', [{ ...opening, timestamp: '' }, start, end], false],
    ['wrong opening', [meta(), start, end], false],
    ['foreign metadata', [opening, meta(), start, end], false],
    ['foreign interleaving', [opening, start, meta(), opening, end], false],
    [
      'fresh start after foreign metadata',
      [
        opening,
        start,
        meta(),
        opening,
        event('task_started', 2, { turn_id: 'fresh' }),
        event('task_complete', 4, { turn_id: 'fresh' }),
      ],
      true,
    ],
    [
      'delayed direct opening',
      [
        { ...meta({ id: 'child', session_id: 'child', source: 'cli', timestamp: at(0) }), timestamp: at(10) },
        start,
        end,
      ],
      true,
    ],
    ['copied clock', [opening, event('task_started', 1, { turn_id: 'work', started_at: ms(-100) }), end], false],
    ['repeated start', [opening, start, start, end], false],
    [
      'delayed date',
      [opening, start, { type: 'turn_context', payload: { turn_id: 'work', current_date: '2025-12-01' } }, end],
      false,
    ],
    ['mismatched terminal', [opening, start, event('task_complete', 4, { turn_id: 'other' })], false],
    ['older terminal', [opening, start, event('task_complete', 0, { turn_id: 'work' })], false],
    ['resumed', [opening, start, end, event('task_started', 5, { turn_id: 'next' })], false],
    ['prompt', [opening, start, end, event('user_message', 5, { message: 'continue' })], false],
    ['tool', [opening, start, end, item('function_call', 5, { name: 'exec_command' })], false],
    ['usage', [opening, start, end, event('token_count', 5)], false],
    ['context', [opening, start, end, turnContext(5, 'work', 'gpt-6.1-sol', 'high')], false],
    [
      'eviction',
      [
        opening,
        ...Array.from({ length: 65 }, (_, i) => event('task_started', 1, { turn_id: String(i) })),
        event('task_complete', 4, { turn_id: '64' }),
      ],
      false,
    ],
  ];
  for (const [name, records, expected] of cases) {
    const file = writeRollout(records);
    let scan;
    for (let size = 0; size < fs.statSync(file).size;) {
      size = Math.min(fs.statSync(file).size, size + 100);
      scan = scanForCodexPerson(file, size, scan, 'child');
    }
    assert.equal(!!scan?.dispatchCompletion?.terminal && !scan.dispatchCompletion.invalid, expected, name);
  }
  for (const ending of ['partial', 'malformed', 'oversized', 'null then resumed']) {
    const file = writeRollout([opening, start, end]);
    fs.appendFileSync(
      file,
      ending === 'partial'
        ? '{'
        : ending === 'malformed'
          ? 'broken\n'
          : ending === 'null then resumed'
            ? 'null\n' + JSON.stringify(event('task_started', 5, { turn_id: 'next' })) + '\n'
            : 'x'.repeat(1024 * 1024 + 1),
    );
    let scan = scanForCodexPerson(file, fs.statSync(file).size, undefined, 'child');
    while (scan.bytes < fs.statSync(file).size) scan = scanForCodexPerson(file, fs.statSync(file).size, scan, 'child');
    assert.equal(
      scan.fragment.length === 0 && !!scan.dispatchCompletion?.terminal && !scan.dispatchCompletion.invalid,
      false,
      ending,
    );
    assert.ok(scan.fragment.length <= 1024 * 1024);
    if (ending === 'null then resumed') {
      assert.equal(scan.dispatchCompletion?.invalid, true);
      assert.equal(scan.dispatchCompletion?.start, 'next', 'malformed input does not hide later activity');
    }
  }
});

test('a genuine local-date turn near UTC midnight is not treated as replayed', () => {
  const records = [
    recordedAt(meta(), '2026-08-27T00:05:00.000Z'),
    recordedAt(event('task_started', 0, { turn_id: 'local-date' }), '2026-08-27T00:05:00.001Z'),
    recordedAt(
      {
        type: 'turn_context',
        payload: {
          turn_id: 'local-date',
          cwd: 'c:\\repo',
          model: 'gpt-5.6-sol',
          effort: 'high',
          current_date: '2026-08-26',
        },
      },
      '2026-08-27T00:05:00.002Z',
    ),
    recordedAt(event('user_message', 0, { message: 'genuine prompt' }), '2026-08-27T00:05:00.003Z'),
    recordedAt(tokens(0, { input_tokens: 14 }), '2026-08-27T00:05:00.004Z'),
    recordedAt(
      event('task_complete', 0, { turn_id: 'local-date', last_agent_message: 'genuine answer' }),
      '2026-08-27T00:05:00.005Z',
    ),
  ];
  const reducer = createCodexUsageLineReducer();
  const requests = records.flatMap((record) => reducer.pushLine(JSON.stringify(record)));
  assert.deepEqual(
    requests.map((request) => request.usage.input),
    [14],
  );
  assert.equal(reducer.turnCount(), 1);
  assert.deepEqual(
    readCodexSession(writeRollout(records), 'sess').turns.map((turn) => turn.promptId),
    ['local-date'],
  );
});

test('late copy removal applies the turn limit after genuine cards are known', () => {
  const records: object[] = [recordedAt(meta(), '2026-08-27T12:00:00.000Z')];
  for (const [turnId, second] of [
    ['first', 1],
    ['second', 5],
  ] as const) {
    records.push(
      recordedAt(event('task_started', 0, { turn_id: turnId }), `2026-08-27T12:00:0${second}.000Z`),
      recordedAt(
        {
          type: 'turn_context',
          payload: {
            turn_id: turnId,
            cwd: 'c:\\repo',
            model: 'gpt-5.6-sol',
            effort: 'high',
            current_date: '2026-08-27',
          },
        },
        `2026-08-27T12:00:0${second}.001Z`,
      ),
      recordedAt(event('user_message', 0, { message: `${turnId} prompt` }), `2026-08-27T12:00:0${second}.002Z`),
      recordedAt(
        event('task_complete', 0, { turn_id: turnId, last_agent_message: `${turnId} answer` }),
        `2026-08-27T12:00:0${second}.003Z`,
      ),
    );
  }
  records.push(
    recordedAt(event('task_started', 0, { turn_id: 'copied' }), '2026-08-27T12:00:09.000Z'),
    recordedAt(event('user_message', 0, { message: 'copied prompt' }), '2026-08-27T12:00:09.001Z'),
    recordedAt(
      event('task_complete', 0, { turn_id: 'copied', last_agent_message: 'copied answer' }),
      '2026-08-27T12:00:09.002Z',
    ),
    recordedAt(event('task_started', 0, { turn_id: 'empty' }), '2026-08-27T12:00:09.003Z'),
    recordedAt(
      {
        type: 'turn_context',
        payload: {
          turn_id: 'copied',
          cwd: 'c:\\repo',
          model: 'gpt-5.6-sol',
          effort: 'high',
          current_date: '2026-08-26',
        },
      },
      '2026-08-27T12:00:09.004Z',
    ),
    recordedAt(event('task_complete', 0, { turn_id: 'empty', last_agent_message: '' }), '2026-08-27T12:00:09.005Z'),
  );
  const read = readCodexSession(writeRollout(records), 'sess', { maxTurns: 2 });
  assert.deepEqual(
    read.turns.map((turn) => turn.promptId),
    ['first', 'second'],
  );
  assert.equal(read.turnLimitReached, false);
});

test('a completion after an unresolved copied turn cannot evict genuine bounded history', () => {
  const records: object[] = [recordedAt(meta(), '2026-08-27T12:00:00.000Z')];
  for (const [turnId, second] of [
    ['first-real', 1],
    ['second-real', 5],
  ] as const) {
    records.push(
      recordedAt(event('task_started', 0, { turn_id: turnId }), `2026-08-27T12:00:0${second}.000Z`),
      recordedAt(
        {
          type: 'turn_context',
          payload: {
            turn_id: turnId,
            cwd: 'c:\\repo',
            model: 'gpt-5.6-sol',
            effort: 'high',
            current_date: '2026-08-27',
          },
        },
        `2026-08-27T12:00:0${second}.001Z`,
      ),
      recordedAt(event('user_message', 0, { message: `${turnId} prompt` }), `2026-08-27T12:00:0${second}.002Z`),
      recordedAt(
        event('task_complete', 0, { turn_id: turnId, last_agent_message: `${turnId} answer` }),
        `2026-08-27T12:00:0${second}.003Z`,
      ),
    );
  }
  records.push(
    recordedAt(event('task_started', 0, { turn_id: 'late-copied' }), '2026-08-27T12:00:09.000Z'),
    recordedAt(event('user_message', 0, { message: 'copied prompt' }), '2026-08-27T12:00:09.001Z'),
    recordedAt(
      event('task_complete', 0, { turn_id: 'late-copied', last_agent_message: 'copied answer' }),
      '2026-08-27T12:00:09.002Z',
    ),
    recordedAt(event('task_started', 0, { turn_id: 'following-real' }), '2026-08-27T12:00:10.000Z'),
    recordedAt(
      {
        type: 'turn_context',
        payload: {
          turn_id: 'following-real',
          cwd: 'c:\\repo',
          model: 'gpt-5.6-sol',
          effort: 'high',
          current_date: '2026-08-27',
        },
      },
      '2026-08-27T12:00:10.001Z',
    ),
    recordedAt(event('user_message', 0, { message: 'following prompt' }), '2026-08-27T12:00:10.002Z'),
    recordedAt(
      event('task_complete', 0, { turn_id: 'following-real', last_agent_message: 'following answer' }),
      '2026-08-27T12:00:10.003Z',
    ),
    recordedAt(
      {
        type: 'turn_context',
        payload: {
          turn_id: 'late-copied',
          cwd: 'c:\\repo',
          model: 'gpt-5.6-sol',
          effort: 'high',
          current_date: '2026-08-26',
        },
      },
      '2026-08-27T12:00:10.004Z',
    ),
  );
  const file = writeRollout(records);
  const expected = ['second-real', 'following-real'];
  assert.deepEqual(
    readCodexSession(file, 'sess', { maxTurns: 2 }).turns.map((turn) => turn.promptId),
    expected,
  );
  const incremental = readCodexSessionIncremental(file, 'sess', undefined, { maxTurns: 2 });
  assert.deepEqual(
    incremental.read?.turns.map((turn) => turn.promptId),
    expected,
  );
});

test('later resume metadata does not move the rollout opening clock', () => {
  const records: object[] = [recordedAt(meta(), '2026-08-25T12:00:00.000Z')];
  for (let index = 0; index < 57; index += 1) {
    records.push(recordedAt(meta(), `2026-08-27T00:00:${String(index).padStart(2, '0')}.000Z`));
  }
  records.push(
    recordedAt(
      event('task_started', 0, { turn_id: 'resumed', started_at: Date.parse('2026-08-26T12:00:00Z') / 1000 }),
      '2026-08-27T00:01:00.000Z',
    ),
    recordedAt(turnContext(0, 'resumed', 'gpt-5.6-sol', 'high'), '2026-08-27T00:01:00.001Z'),
    recordedAt(event('user_message', 0, { message: 'resume prompt' }), '2026-08-27T00:01:00.002Z'),
    recordedAt(tokens(0, { input_tokens: 7 }), '2026-08-27T00:01:00.003Z'),
    recordedAt(
      event('task_complete', 0, { turn_id: 'resumed', last_agent_message: 'resume answer' }),
      '2026-08-27T00:01:00.004Z',
    ),
  );
  const reducer = createCodexUsageLineReducer();
  const requests = records.flatMap((record) => reducer.pushLine(JSON.stringify(record)));
  assert.equal(requests.length, 1);
  assert.equal(reducer.turnCount(), 1);
  assert.equal(readCodexSession(writeRollout(records), 'sess').turns.length, 1);
});

test('a spawned Bedrock rollout keeps provider-qualified cache-write spend', () => {
  const file = writeRollout([
    meta({ model_provider: 'amazon-bedrock' }),
    event('task_started', 1, { turn_id: TURN }),
    turnContext(2, TURN, 'openai.gpt-5.6-sol', 'high'),
    tokens(3, {
      input_tokens: 100,
      cached_input_tokens: 60,
      cache_write_input_tokens: 30,
      output_tokens: 10,
    }),
  ]);
  const { artifacts: _artifacts, ...spend } = readCodexAgentSpend(file);
  assert.deepEqual(
    { ...spend, models: spend.models.map(({ usageParts: _usageParts, ...model }) => model) },
    {
      models: [
        {
          model: 'openai.gpt-5.6-sol',
          provider: 'amazon-bedrock',
          contextWindow: 258400,
          usage: shortPricedUsage({
            requests: 1,
            input: 10,
            cacheWrite1h: 0,
            cacheWrite5m: 0,
            cacheWrite30m: 30,
            cacheRead: 60,
            output: 10,
            thinking: 0,
          }),
        },
      ],
      found: true,
      partial: true,
      effort: 'high',
    },
  );
  assert.deepEqual(
    spend.models[0].usageParts?.map((part) => [part.provider, part.contextBand, part.inferenceClass, part.serviceTier]),
    [['amazon-bedrock', 'short', 'in-region', null]],
  );
});

test('a spawned rollout marks direct usage incomplete when a billed request has no usable token counts', () => {
  const file = writeRollout([
    meta(),
    event('task_started', 1, { turn_id: TURN }),
    turnContext(2, TURN, 'gpt-5.6-sol', 'high'),
    event('token_count', 3, { info: { last_token_usage: null } }),
  ]);
  assert.deepEqual((({ artifacts: _artifacts, ...spend }) => spend)(readCodexAgentSpend(file)), {
    models: [],
    found: true,
    partial: true,
    effort: 'high',
    usageIncomplete: true,
  });
});

test('a child uses the opening context window when its token event omits one', () => {
  const file = writeRollout([
    meta({ model_provider: 'amazon-bedrock' }),
    event('task_started', 1, { turn_id: TURN, model_context_window: 1_000_000 }),
    turnContext(2, TURN, 'openai.gpt-5.6-sol', 'high'),
    event('token_count', 3, {
      info: { last_token_usage: usage({ input_tokens: 100, output_tokens: 10 }) },
    }),
  ]);
  const spend = readCodexAgentSpend(file);
  assert.equal(spend.models[0].contextWindow, 1_000_000);
});

test('a child token event context window overrides the opening value', () => {
  const file = writeRollout([
    meta({ model_provider: 'amazon-bedrock' }),
    event('task_started', 1, { turn_id: TURN, model_context_window: 1_000_000 }),
    turnContext(2, TURN, 'openai.gpt-5.6-sol', 'high'),
    tokens(3, { input_tokens: 100, output_tokens: 10 }),
  ]);
  const spend = readCodexAgentSpend(file);
  assert.equal(spend.models[0].contextWindow, 258400);
});

test('child spend stays split when one model runs under two pricing tiers', () => {
  const longTurn = '01a032c9-2000-7000-8000-000000000003';
  const file = writeRollout([
    meta({ model_provider: 'amazon-bedrock' }),
    event('task_started', 1, { turn_id: TURN, model_context_window: 258400 }),
    turnContext(2, TURN, 'openai.gpt-5.6-sol', 'high'),
    event('token_count', 3, {
      info: { last_token_usage: usage({ input_tokens: 100, output_tokens: 10 }) },
    }),
    event('task_started', 4, { turn_id: longTurn, model_context_window: 1_000_000 }),
    turnContext(5, longTurn, 'openai.gpt-5.6-sol', 'high'),
    event('token_count', 6, {
      info: { last_token_usage: usage({ input_tokens: 300_000, output_tokens: 1000 }) },
    }),
  ]);
  const spend = readCodexAgentSpend(file);
  assert.deepEqual(
    spend.models.map((part) => [part.model, part.contextWindow, part.usage.input]),
    [
      ['openai.gpt-5.6-sol', 258400, 100],
      ['openai.gpt-5.6-sol', 1_000_000, 300_000],
    ],
  );
});

test('a direct OpenAI child keeps mixed request bands under one model', () => {
  const longTurn = '01a032c9-2000-7000-8000-000000000004';
  const file = writeRollout([
    meta({ model_provider: 'openai' }),
    event('task_started', 1, { turn_id: TURN }),
    turnContext(2, TURN, 'gpt-5.5', 'high'),
    tokens(3, { input_tokens: 100, output_tokens: 10 }),
    event('task_started', 4, { turn_id: longTurn }),
    turnContext(5, longTurn, 'gpt-5.5', 'high'),
    tokens(6, { input_tokens: 300_001, output_tokens: 20 }),
  ]);
  const spend = readCodexAgentSpend(file);
  assert.equal(spend.models.length, 1);
  assert.deepEqual(spend.models[0].usage.byContextBand, {
    short: {
      requests: 1,
      input: 100,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      cacheWrite30m: 0,
      cacheRead: 0,
      output: 10,
      thinking: 0,
    },
    long: {
      requests: 1,
      input: 300_001,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      cacheWrite30m: 0,
      cacheRead: 0,
      output: 20,
      thinking: 0,
    },
  });
});

test('a child model change keeps each request under the model that served it', () => {
  const file = writeRollout([
    meta({ model_provider: 'openai' }),
    event('task_started', 1, { turn_id: TURN }),
    turnContext(2, TURN, 'gpt-5.4', 'high'),
    tokens(3, { input_tokens: 100, output_tokens: 10 }),
    turnContext(4, TURN, 'gpt-5.5', 'high'),
    tokens(5, { input_tokens: 300_001, output_tokens: 20 }),
  ]);
  const spend = readCodexAgentSpend(file);
  assert.deepEqual(
    spend.models.map((part) => ({
      model: part.model,
      bands: Object.keys(part.usage.byContextBand ?? {}),
      input: part.usage.input,
    })),
    [
      { model: 'gpt-5.4', bands: ['short'], input: 100 },
      { model: 'gpt-5.5', bands: ['long'], input: 300_001 },
    ],
  );
});

test('a nested Codex spawn in a custom tool call leaves child spend explicitly partial', () => {
  const file = writeRollout([
    meta(),
    event('task_started', 1, { turn_id: TURN }),
    turnContext(2, TURN, 'gpt-5.6-sol', 'high'),
    tokens(3, { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 }),
    item('custom_tool_call', 4, { name: 'spawn_agent', call_id: 'nested', input: '{}' }),
  ]);
  const spend = readCodexAgentSpend(file);
  assert.equal(
    spend.partial,
    true,
    'a nested custom-tool spawn was omitted without marking the child total as a floor',
  );
});

function nestedCodexCostFixture() {
  const header = (id: string, parent: string | null, agentPath: string, second: number) => ({
    ...meta({
      id,
      session_id: 'root',
      model_provider: 'openai',
      ...(parent
        ? {
            source: {
              subagent: {
                thread_spawn: { parent_thread_id: parent, depth: parent === 'root' ? 1 : 2, agent_path: agentPath },
              },
            },
          }
        : {}),
    }),
    timestamp: at(second),
  });
  const task = (id: string, second: number, input: number, effort = 'high') => [
    event('task_started', second, { turn_id: id, started_at: ms(second) / 1000 }),
    turnContext(second + 1, id, 'gpt-5.6-sol', effort),
    event('user_message', second + 1, { message: 'review' }),
    tokens(second + 2, { input_tokens: input }),
  ];
  const spawn = (second: number, name: string) => [
    item('function_call', second, {
      name: 'spawn_agent',
      call_id: `spawn-${name}`,
      arguments: JSON.stringify({ task_name: name }),
    }),
    item('function_call_output', second + 1, {
      call_id: `spawn-${name}`,
      output: JSON.stringify({ task_name: `/root/${name}` }),
    }),
  ];
  const root = writeRollout([
    header('root', null, '/root', 0),
    ...task('root-turn', 1, 100_000),
    ...spawn(4, 'child'),
    event('task_complete', 30, { turn_id: 'root-turn', last_agent_message: 'done' }),
  ]);
  const child = writeRollout([
    header('child', 'root', '/root/child', 6),
    ...task('child-turn', 7, 200_000, 'medium'),
    ...spawn(10, 'child/grandchild'),
    event('task_complete', 25, { turn_id: 'child-turn', last_agent_message: 'done' }),
  ]);
  const grandchild = writeRollout([
    header('grandchild', 'child', '/root/child/grandchild', 14),
    ...task('child-turn', 7, 200_000, 'medium').map((record) => recordedAt(record, at(14))),
    ...task('grandchild-turn', 16, 400_000, 'xhigh'),
    event('task_complete', 24, { turn_id: 'grandchild-turn', last_agent_message: 'done' }),
  ]);
  const children: CodexSubagentFile[] = [
    {
      file: child,
      threadId: 'child',
      parentThreadId: 'root',
      agentPath: '/root/child',
      openedAt: ms(6),
      startedAt: ms(6),
      threadSource: 'subagent',
      backgroundReview: false,
    },
    {
      file: grandchild,
      threadId: 'grandchild',
      parentThreadId: 'child',
      agentPath: '/root/child/grandchild',
      openedAt: ms(12),
      startedAt: ms(12),
      threadSource: 'subagent',
      backgroundReview: false,
    },
  ];
  const options = {
    structuralChildren: children,
    agentSpendOf: (ref: import('./agentspend').AgentSpendRef) => {
      const target = codexSubagentFor(children, 'root', ref);
      return target
        ? readCodexAgentSpend(target.file, children)
        : { models: [], found: false, partial: false, effort: null };
    },
  };
  return { root, child, grandchild, children, options, task };
}

test('a root Codex turn includes grandchild cost once beside unchanged session and Project totals', () => {
  const { root, child, grandchild, children, options } = nestedCodexCostFixture();
  const [turn] = readCodexSession(root, 'root', options).turns;
  const records = [root, child, grandchild].map(
    (file) => indexSpendFile(undefined, file, 'workspace', createCodexUsageLineReducer, 1).record,
  );
  const sources = discoverCodexSessionSpendSources([{ sessionId: 'root', file: root }], children);
  const session = sessionSpendPartsBySession(records, sources).root;
  const sessionInput = session.reduce((sum, part) => sum + part.bucket.usage.input, 0);
  const projectInput = records.flatMap((record) => record.buckets).reduce((sum, bucket) => sum + bucket.usage.input, 0);
  assert.equal(sessionInput, 700_000);
  assert.equal(projectInput, 700_000);
  assert.equal(
    turn.usage.input + turn.agents.flatMap((agent) => agent.spend).reduce((sum, part) => sum + part.usage.input, 0),
    700_000,
  );
  assert.equal(turn.agents[0].effort, 'medium');
  assert.equal(
    turnCost(turn).partial,
    false,
    JSON.stringify({
      cost: turnCost(turn),
      agents: turn.agents.map((agent) => ({ status: agent.status, partial: agent.spendPartial, spend: agent.spend })),
    }),
  );
  assert.equal(turn.agents.length, 1);
  const sessionDollars = session.reduce((sum, part) => sum + (publicProjectSpendPrice(part.bucket)?.dollars ?? 0), 0);
  assert.equal(turnCost(turn).dollars, sessionDollars);
});

test('nested Codex spend counts repeated sources once and refuses conflicting ownership and cycles', () => {
  const { child, grandchild, children } = nestedCodexCostFixture();
  const duplicated = [...children, ...children];
  assert.equal(
    readCodexAgentSpend(child, duplicated).models.reduce((sum, part) => sum + part.usage.input, 0),
    600_000,
  );
  const conflict = [...children, { ...children[1], parentThreadId: 'other' }];
  const refused = readCodexAgentSpend(child, conflict);
  assert.equal(
    refused.models.reduce((sum, part) => sum + part.usage.input, 0),
    200_000,
  );
  assert.equal(refused.partial, true);
  const cycle = [...children, { ...children[0], parentThreadId: 'grandchild' }];
  assert.equal(readCodexAgentSpend(child, cycle).partial, true);
  const saved = fs.readFileSync(child, 'utf8');
  const lines = saved.trimEnd().split('\n');
  const opening = JSON.parse(lines[0]);
  opening.payload.source.subagent.thread_spawn.parent_thread_id = 'grandchild';
  lines[0] = JSON.stringify(opening);
  fs.writeFileSync(child, lines.join('\n') + '\n');
  const cyclic = readCodexAgentSpend(child, [{ ...children[0], parentThreadId: 'grandchild' }, children[1]]);
  assert.equal(cyclic.partial, true);
  assert.equal(
    cyclic.models.reduce((sum, part) => sum + part.usage.input, 0),
    200_000,
  );
  fs.writeFileSync(child, saved);
  assert.equal(
    codexSubagentFor(children, 'other', { id: 'grandchild', name: '', path: null, status: 'completed' }),
    null,
  );
  assert.equal(
    readCodexAgentSpend(grandchild, children).models.reduce((sum, part) => sum + part.usage.input, 0),
    400_000,
  );
});

test('nested Codex spend retains uncertainty for unresolved, missing, unreadable, truncated, and open descendants', () => {
  const { child, grandchild, children, task } = nestedCodexCostFixture();
  assert.equal(readCodexAgentSpend(child, [children[0]]).partial, true);
  const saved = fs.readFileSync(grandchild);
  fs.writeFileSync(grandchild, Buffer.concat([saved, Buffer.from('{"type":')]));
  assert.equal(readCodexAgentSpend(child, children).partial, true);
  fs.writeFileSync(grandchild, saved);
  fs.appendFileSync(
    grandchild,
    task('resume', 40, 10)
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  assert.equal(readCodexAgentSpend(child, children).partial, true);
  fs.writeFileSync(grandchild, saved);
  const nativeFs = createRequire(__filename)('node:fs') as typeof fs;
  const open = nativeFs.openSync;
  const spy = vi.spyOn(nativeFs, 'openSync').mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
    if (file === grandchild) throw new Error('read denied');
    return Reflect.apply(open, nativeFs, [file, ...args]);
  }) as typeof open);
  syncBuiltinESMExports();
  try {
    assert.equal(readCodexAgentSpend(child, children).partial, true);
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
  fs.unlinkSync(grandchild);
  assert.equal(readCodexAgentSpend(child, children).partial, true);
});

test('nested Codex spend reuses each own-source scan across aggregates and versions descendant relationships', () => {
  const { child, grandchild, children } = nestedCodexCostFixture();
  const unrelated = {
    ...children[1],
    file: `${grandchild}-unrelated`,
    threadId: 'unrelated',
    parentThreadId: 'elsewhere',
  };
  const catalog = [...children, unrelated];
  const index = codexSpendIndex(catalog);
  assert.equal(codexSpendIndex(catalog), index);
  Object.defineProperty(unrelated, 'file', {
    get: () => {
      throw new Error('unrelated relationship was scanned');
    },
  });
  const read = codexAgentSpendReader(index);
  const nativeFs = createRequire(__filename)('node:fs') as typeof fs;
  const open = nativeFs.openSync;
  const counts = new Map<string, number>();
  const spy = vi.spyOn(nativeFs, 'openSync').mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
    const name = String(file);
    counts.set(name, (counts.get(name) ?? 0) + 1);
    return Reflect.apply(open, nativeFs, [file, ...args]);
  }) as typeof open);
  syncBuiltinESMExports();
  try {
    read(child);
    const first = counts.get(grandchild);
    assert.ok(first && first <= 2);
    read(grandchild);
    read(child);
    assert.equal(counts.get(grandchild), first);
    const version = codexAgentSpendVersion(child, index);
    assert.ok(version.includes('grandchild'));
    assert.notEqual(codexAgentSpendVersion(child, codexSpendIndex([children[0]])), version);
    assert.equal(counts.get(grandchild), first);
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
});

test('nested Codex spend preserves descendant pricing identities and incomplete and unpriced usage', () => {
  const { child, grandchild, children, task } = nestedCodexCostFixture();
  fs.appendFileSync(
    grandchild,
    [
      ...task('linked', 40, 10),
      claudeCommandCompleted(43),
      event('task_complete', 45, { turn_id: 'linked', last_agent_message: 'done' }),
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  const own = readCodexAgentSpend(grandchild);
  const nested = readCodexAgentSpend(child, children);
  for (const part of own.models) {
    assert.ok(nested.models.some((held) => held.model === part.model && held.costBasis === part.costBasis));
  }
  assert.ok(
    own.models.some(
      (part) =>
        part.recordedCost !== undefined && part.costBasis && part.usageParts?.some((usage) => usage.linkedInvocationId),
    ),
  );
  fs.appendFileSync(
    grandchild,
    [
      event('task_started', 50, { turn_id: 'incomplete' }),
      turnContext(51, 'incomplete', 'unknown-model', 'low'),
      event('token_count', 52, { info: { total_token_usage: usage({ input_tokens: 100 }) } }),
      tokens(53, { input_tokens: 100 }),
      event('task_complete', 54, { turn_id: 'incomplete', last_agent_message: 'done' }),
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  assert.equal(readCodexAgentSpend(child, children).usageIncomplete, true);
  const { root, options } = nestedCodexCostFixture();
  const [turn] = readCodexSession(root, 'root', {
    ...options,
    agentSpendOf: () => readCodexAgentSpend(child, children),
  }).turns;
  assert.equal(turnCost(turn).partial, true);
});

test('nested Codex cost survives unreadable ancestors and keeps ownership uncertainty', () => {
  const { root, child, grandchild, children } = nestedCodexCostFixture();
  const total = (file = child) => readCodexAgentSpend(file, children);
  const saved = fs.readFileSync(child);
  fs.writeFileSync(child, '{"type":');
  assert.equal(
    total().models.reduce((sum, part) => sum + part.usage.input, 0),
    400_000,
  );
  assert.equal(total().partial, true);
  assert.equal(
    total(root).models.reduce((sum, part) => sum + part.usage.input, 0),
    500_000,
  );
  assert.equal(total(root).partial, true);
  fs.unlinkSync(child);
  assert.equal(
    total().models.reduce((sum, part) => sum + part.usage.input, 0),
    400_000,
  );
  assert.equal(total().partial, true);
  fs.mkdirSync(child);
  assert.equal(
    total().models.reduce((sum, part) => sum + part.usage.input, 0),
    400_000,
  );
  fs.rmdirSync(child);
  fs.writeFileSync(child, saved);
  const lines = saved.toString().trimEnd().split('\n');
  const opening = JSON.parse(lines[0]);
  opening.payload.source.subagent.thread_spawn.parent_thread_id = 'other';
  lines[0] = JSON.stringify(opening);
  fs.writeFileSync(child, lines.join('\n') + '\n');
  assert.equal(
    total().models.reduce((sum, part) => sum + part.usage.input, 0),
    0,
  );
  assert.equal(total().partial, true);
  fs.writeFileSync(child, saved);
  assert.equal(total(grandchild).partial, false);
  const conflicting = readCodexAgentSpend(child, [...children, { ...children[0], threadId: 'other' }]);
  assert.equal(conflicting.models.length, 0);
  assert.equal(conflicting.partial, true);
});

test('nested Codex completion follows the current turn and preserves interruptions', () => {
  for (const terminal of ['task_complete', 'turn_aborted']) {
    const { child, grandchild, children, task } = nestedCodexCostFixture();
    fs.appendFileSync(
      grandchild,
      [
        ...task('resume', 40, 10),
        event(terminal, 44, {
          turn_id: terminal === 'task_complete' ? 'grandchild-turn' : 'resume',
          reason: 'interrupted',
        }),
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    assert.equal(readCodexAgentSpend(child, children).partial, true, terminal);
  }
});

test('root turn cost stays partial until the direct child genuinely finishes its latest turn', () => {
  for (const state of ['running', 'empty-resume', 'interrupted', 'older-terminal', 'missing-start']) {
    const { root, child, children, options, task } = nestedCodexCostFixture();
    const initial = turnCost(readCodexSession(root, 'root', options).turns[0]);
    const records =
      state === 'missing-start'
        ? [JSON.parse(fs.readFileSync(child, 'utf8').split('\n')[0]), event('task_complete', 44, { turn_id: 'resume' })]
        : [
            ...(state === 'empty-resume' ? [event('task_started', 40, { turn_id: 'resume' })] : task('resume', 40, 10)),
            ...(state === 'interrupted' ? [event('turn_aborted', 44, { turn_id: 'resume' })] : []),
            ...(state === 'older-terminal' ? [event('task_complete', 44, { turn_id: 'child-turn' })] : []),
          ];
    const text = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
    if (state === 'missing-start') fs.writeFileSync(child, text);
    else fs.appendFileSync(child, text);
    const cost = turnCost(readCodexSession(root, 'root', options).turns[0]);
    assert.equal(cost.partial, true, state);
    assert.equal(readCodexAgentSpend(child, children).partial, true, state);
    if (state === 'empty-resume') assert.equal(cost.dollars, initial.dollars);
    if (state !== 'missing-start' && state !== 'interrupted') {
      fs.appendFileSync(child, JSON.stringify(event('task_complete', 45, { turn_id: 'resume' })) + '\n');
      assert.equal(turnCost(readCodexSession(root, 'root', options).turns[0]).partial, false, state);
    }
  }
});

test('root turn cost rejects copied completion until a genuine descendant task finishes', () => {
  for (const shape of ['clock', 'idless-clock', 'repeated-id', 'delayed-date']) {
    const { root, grandchild, options } = nestedCodexCostFixture();
    const header = JSON.parse(fs.readFileSync(grandchild, 'utf8').split('\n')[0]);
    header.timestamp = '2026-08-27T00:26:41.322Z';
    const replay = replayedSubagentRollout();
    let copied = replay.slice(2, 7) as { payload: Record<string, unknown> }[];
    if (shape === 'idless-clock') {
      copied = structuredClone(copied);
      for (const record of copied) delete record.payload.turn_id;
    }
    if (shape === 'repeated-id') {
      const own = replay.slice(17) as { payload: Record<string, unknown> }[];
      copied = [...own, ...structuredClone(own)];
    }
    if (shape === 'delayed-date') {
      copied = structuredClone(copied);
      delete copied[0].payload.started_at;
      copied[1].payload.current_date = '2026-08-24';
      copied.push(copied.splice(1, 1)[0]);
    }
    fs.writeFileSync(grandchild, [header, ...copied].map((record) => JSON.stringify(record)).join('\n') + '\n');
    assert.equal(turnCost(readCodexSession(root, 'root', options).turns[0]).partial, true, shape);
    const genuine = structuredClone(replay.slice(17)) as { payload: Record<string, unknown> }[];
    for (const record of genuine) {
      if (record.payload.turn_id) record.payload.turn_id = 'eventual-own';
    }
    fs.appendFileSync(grandchild, genuine.map((record) => JSON.stringify(record)).join('\n') + '\n');
    const complete = readCodexSession(root, 'root', options).turns[0];
    assert.equal(turnCost(complete).partial, false, shape);
    assert.equal(
      complete.agents[0].spend.reduce((sum, part) => sum + part.usage.input, 0),
      200_000 + (shape === 'repeated-id' ? 26 : 13),
      shape,
    );
  }
});

test('genuine failed descendants finish while independent usage uncertainty remains partial', () => {
  for (const shape of ['priced', 'truncated', 'incomplete', 'unpriced', 'mismatched']) {
    const { root, grandchild, options, task } = nestedCodexCostFixture();
    const header = JSON.parse(fs.readFileSync(grandchild, 'utf8').split('\n')[0]);
    const records = [
      header,
      ...task('failed-own', 40, 10),
      event('task_complete', 45, {
        turn_id: shape === 'mismatched' ? 'other' : 'failed-own',
        error: { message: 'failed' },
      }),
    ];
    if (shape === 'incomplete') records.splice(-1, 0, event('token_count', 44, { info: { last_token_usage: null } }));
    if (shape === 'unpriced') (records[2] as { payload: Record<string, unknown> }).payload.model = 'unknown-model';
    fs.writeFileSync(
      grandchild,
      records.map((record) => JSON.stringify(record)).join('\n') + '\n' + (shape === 'truncated' ? '{"type":' : ''),
    );
    const cost = turnCost(readCodexSession(root, 'root', options).turns[0]);
    assert.equal(cost.partial, shape !== 'priced', shape);
    assert.ok(cost.dollars !== null);
  }
});

test('unique explicit Codex IDs count sources without parent metadata once and remain partial', () => {
  const { child, grandchild, children } = nestedCodexCostFixture();
  const lines = fs.readFileSync(grandchild, 'utf8').trimEnd().split('\n');
  const opening = JSON.parse(lines[0]);
  delete opening.payload.source;
  opening.payload.thread_source = 'subagent';
  lines[0] = JSON.stringify(opening);
  fs.writeFileSync(grandchild, lines.join('\n') + '\n');
  const catalog = [children[0], { ...children[1], parentThreadId: null }];
  const ref = { id: 'grandchild', name: '', path: null, status: 'completed' };
  assert.equal(codexSubagentFor(catalog, 'child', ref)?.file, grandchild);
  const childLines = fs.readFileSync(child, 'utf8').trimEnd().split('\n');
  const completion = childLines.pop();
  fs.writeFileSync(
    child,
    childLines.join('\n') +
      '\n' +
      [
        item('function_call', 26, { name: 'spawn_agent', call_id: 'explicit', arguments: '{}' }),
        item('function_call_output', 27, {
          call_id: 'explicit',
          output: JSON.stringify({ agent_id: 'grandchild', nickname: 'grandchild' }),
        }),
        item('function_call', 28, { name: 'spawn_agent', call_id: 'repeat', arguments: '{}' }),
        item('function_call_output', 29, {
          call_id: 'repeat',
          output: JSON.stringify({ agent_id: 'grandchild', nickname: 'grandchild' }),
        }),
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') +
      '\n' +
      completion +
      '\n',
  );
  const spend = readCodexAgentSpend(child, catalog);
  assert.equal(
    spend.models.reduce((sum, part) => sum + part.usage.input, 0),
    600_000,
  );
  assert.equal(spend.partial, true);
});

test('explicit Codex child IDs retain transcript links when parent metadata is absent', () => {
  const { root, child, children } = nestedCodexCostFixture();
  const childRecords = fs
    .readFileSync(child, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  delete childRecords[0].payload.source;
  childRecords[0].payload.thread_source = 'subagent';
  fs.writeFileSync(child, childRecords.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const rootRecords = fs
    .readFileSync(root, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  const acknowledgment = rootRecords.find((record) => record.payload.type === 'function_call_output');
  acknowledgment.payload.output = JSON.stringify({ agent_id: 'child', nickname: 'child' });
  fs.writeFileSync(root, rootRecords.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const catalog = [{ ...children[0], parentThreadId: null }, children[1]];
  const addFacts = () =>
    fs.appendFileSync(
      child,
      [
        event('task_started', 40, { turn_id: 'facts' }),
        turnContext(40, 'facts', 'gpt-5.6-sol', 'high'),
        ...ordinaryTurn().slice(3, -2),
        item('custom_tool_call', 41, { name: 'exec', call_id: 'failed' }),
        toolOutput(42, 'failed', 'Script error: ReferenceError: missing value'),
        event('token_count', 43, { info: { last_token_usage: null } }),
        commandCompleted(43, 'git commit -m visible', 0, 'completed', 'printed', {
          stdout: '[main f572f41] Add the camera plan\n 1 file changed, 186 insertions(+)\n',
        }),
        event('task_complete', 44, { turn_id: 'facts' }),
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
  const [turn] = readCodexSession(root, 'root', {
    structuralChildren: catalog,
    agentSpendOf: (ref) => {
      const target = codexSubagentFor(catalog, 'root', ref);
      return target
        ? readCodexAgentSpend(target.file, catalog)
        : { models: [], found: false, partial: false, effort: null };
    },
  }).turns;
  assert.equal(turn.agents[0].childSessionId, 'child');
  assert.equal(turnCost(turn).partial, true);
  assert.equal(
    turn.agents[0].spend.reduce((sum, part) => sum + part.usage.input, 0),
    600_000,
  );
  addFacts();
  const own = readCodexDispatchedSpend([child], [catalog[0], catalog[1]], Date.now() + 6000);
  const dispatched = readCodexDispatchedSpend([root], catalog, Date.now() + 6000);
  assert.equal(dispatched.usageIncomplete, true);
  assert.equal(dispatched.partial, true);
  assert.equal(dispatched.artifacts?.complete, false);
  assert.deepEqual(dispatched.artifacts?.files, own.artifacts?.files);
  assert.deepEqual(dispatched.artifacts?.commits, ['f572f41']);
  assert.deepEqual(dispatched.commits, own.commits);
  assert.deepEqual(dispatched.artifacts?.failed, own.artifacts?.failed);
  assert.ok((dispatched.artifacts?.failed?.count ?? 0) > 0);
  assert.equal(dispatched.artifacts?.turnCount, (own.artifacts?.turnCount ?? 1) + 1);
  assert.equal(dispatched.toolUses, (own.toolUses ?? 0) + 1);
});

test('dispatched Codex facts exclude valid-looking descendants under a rejected ancestor', () => {
  const { root, child, grandchild, children } = nestedCodexCostFixture();
  const rootOwn = readCodexDispatchedSpend([root], [], Date.now() + 6000);
  const records = fs
    .readFileSync(child, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  records[0].payload.id = 'different-session';
  fs.writeFileSync(child, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  fs.appendFileSync(
    grandchild,
    [
      event('task_started', 40, { turn_id: 'bad' }),
      ...ordinaryTurn().slice(3, -2),
      item('custom_tool_call', 41, { name: 'exec', call_id: 'failed' }),
      toolOutput(42, 'failed', 'Script error: ReferenceError: missing value'),
      event('task_complete', 43, { turn_id: 'bad' }),
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  const spend = readCodexDispatchedSpend([root, child, grandchild], children, Date.now() + 6000);
  assert.equal(spend.partial, true);
  assert.equal(spend.artifacts?.complete, false);
  assert.deepEqual(spend.artifacts?.tools, rootOwn.artifacts?.tools);
  assert.deepEqual(spend.artifacts?.files, rootOwn.artifacts?.files);
  assert.equal(spend.artifacts?.failed, undefined);
  assert.equal(spend.artifacts?.turnCount, undefined);
  assert.deepEqual(spend.commits, rootOwn.commits);
  assert.deepEqual(spend.models, rootOwn.models);
});

test('nested Codex spend merges equal pricing identities without changing exact usage parts', () => {
  const { child, grandchild, children, task } = nestedCodexCostFixture();
  const own = [readCodexAgentSpend(child), readCodexAgentSpend(grandchild)];
  const spend = readCodexAgentSpend(child, children);
  assert.equal(spend.models.length, 1);
  assert.equal(spend.models[0].usage.input, 600_000);
  assert.deepEqual(
    spend.models[0].usageParts,
    own.flatMap((value) => value.models.flatMap((part) => part.usageParts ?? [])),
  );
  const result = claudePrintResult({
    usage: { input_tokens: 20, cache_creation_input_tokens: 100, cache_read_input_tokens: 300, output_tokens: 40 },
  });
  for (const [file, id] of [
    [child, 'child-invocation'],
    [grandchild, 'grandchild-invocation'],
  ]) {
    fs.appendFileSync(
      file,
      [
        ...task('linked', 40, 10),
        claudeCommandCompleted(43, 'shared-invocation', result),
        claudeCommandCompleted(44, id, result),
        event('task_complete', 45, { turn_id: 'linked', last_agent_message: 'done' }),
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
  }
  const linked = readCodexAgentSpend(child, children);
  const parts = [readCodexAgentSpend(child), readCodexAgentSpend(grandchild)].flatMap((value) => value.models);
  const shared = linked.models.filter((part) =>
    part.usageParts?.some((usage) => usage.linkedInvocationId?.startsWith('shared-invocation:')),
  );
  assert.equal(shared.length, 2);
  assert.equal(shared.find((part) => part.model === 'claude-opus-5')?.recordedCost, 6.48);
  assert.equal(shared.find((part) => part.model === 'claude-opus-5')?.unclassifiedCacheWrite, 200);
  assert.equal(linked.models.filter((part) => part.model === 'claude-opus-5').length, 3);
  for (const part of shared) {
    const expected = parts.filter(
      (value) =>
        value.model === part.model &&
        value.usageParts?.some((usage) => usage.linkedInvocationId?.startsWith('shared-invocation:')),
    );
    assert.deepEqual(
      part.usageParts,
      expected.flatMap((value) => value.usageParts ?? []),
    );
  }
});

test('serialized Codex catalogs reuse canonical resolution until their relationships change', () => {
  const { child, children } = nestedCodexCostFixture();
  const index = codexSpendIndex(children);
  const nativeFs = createRequire(__filename)('node:fs') as typeof fs;
  const spy = vi.spyOn(nativeFs.realpathSync, 'native');
  try {
    assert.equal(codexSpendIndex(structuredClone(children)), index);
    assert.equal(spy.mock.calls.length, 0);
    const changed = structuredClone(children);
    changed[1].parentThreadId = 'other';
    const next = codexSpendIndex(changed);
    assert.notEqual(next, index);
    assert.equal(next.resolve('child', { id: 'grandchild', name: '', path: null, status: 'completed' }), null);
    const movedRoot = structuredClone(children);
    movedRoot[0].parentThreadId = 'other-root';
    assert.notEqual(codexAgentSpendVersion(child, index), codexAgentSpendVersion(child, codexSpendIndex(movedRoot)));
  } finally {
    spy.mockRestore();
  }
});

test('dispatched Codex dependency revisions stay bounded and retain catalog and source invalidation', () => {
  const { child, grandchild, children } = nestedCodexCostFixture();
  const now = ms(90);
  fs.utimesSync(child, now / 1000, now / 1000);
  fs.utimesSync(grandchild, now / 1000, now / 1000);
  const catalog = [
    ...children,
    ...Array.from({ length: 256 }, (_, index) => ({
      ...children[1],
      file: `${grandchild}-unrelated-${index}`,
      threadId: `unrelated-${index}`,
      parentThreadId: 'elsewhere',
    })),
  ];
  const version = (entries = catalog, dependencies = [grandchild]) =>
    codexAgentSpendVersion(child, codexSpendIndex(entries), 'child', dependencies);
  const first = version();
  const savedWrongOwnershipVersion = first.replace(/commit-repositories:[0-9]+/, 'commit-repositories:3');
  assert.notEqual(first, savedWrongOwnershipVersion, 'literal navigation generation 3 kept a wrong ownership decision');
  assert.ok(first.length < 1024, `a dispatched dependency revision retained ${first.length} characters`);
  assert.equal(version([...catalog].reverse()), first);
  assert.equal(version([...catalog, { ...children[1] }]), first);
  const alias = `${path.dirname(grandchild)}${path.sep}.${path.sep}${path.basename(grandchild)}`;
  assert.equal(version([...catalog, { ...children[1], file: alias }]), first);
  assert.equal(version(catalog, [grandchild, grandchild, alias]), first);
  const empty = version([]);
  assert.equal(childSpendRevisionKey('completed', empty, now), empty, 'an empty catalog gained a refresh band');
  const key = childSpendRevisionKey('completed', first, now);
  assert.ok(key.startsWith('open:'), 'recent native writes lost their refresh band');
  for (const field of ['threadId', 'parentThreadId', 'agentPath', 'file'] as const) {
    const changed = structuredClone(catalog);
    changed[1][field] = `${changed[1][field]}-changed`;
    const next = version(changed);
    assert.notEqual(next, first, `${field} changed without invalidating dispatched spend`);
    assert.notEqual(childSpendRevisionKey('completed', next, now), key, `${field} disappeared from the refresh band`);
  }
  assert.notEqual(version(catalog.slice(0, 1)), first, 'a late native child kept its previous dependency revision');
  assert.notEqual(
    version([...catalog, { ...children[1], threadId: 'conflict' }]),
    first,
    'an ambiguous source kept its previous dependency revision',
  );
  fs.appendFileSync(grandchild, '\n');
  assert.notEqual(version(), first, 'descendant growth kept its previous dependency revision');
  assert.notEqual(codexAgentSpendVersion(child, codexSpendIndex(catalog), 'other-child', [grandchild]), version());
});

test('retained inferred Codex task associations reconsider catalog ambiguity after serialization', () => {
  const { root, children, options } = nestedCodexCostFixture();
  const retained = structuredClone(readCodexSession(root, 'root', options).turns);
  const catalog = [...children, { ...children[0], threadId: 'other-child', file: `${children[0].file}-other` }];
  const lookup = (ref: import('./agentspend').AgentSpendRef) => {
    const target = codexSubagentFor(catalog, 'root', ref);
    return target
      ? readCodexAgentSpend(target.file, catalog)
      : { models: [], found: false, partial: false, effort: null };
  };
  refreshCodexStructuralAgents(retained, 'root', catalog, lookup);
  const fresh = readCodexSession(root, 'root', { structuralChildren: catalog, agentSpendOf: lookup }).turns;
  assert.deepEqual(turnCost(retained[0]), turnCost(fresh[0]));
  assert.deepEqual(
    retained[0].agents.map((agent) => [agent.id, agent.childSessionId]),
    fresh[0].agents.map((agent) => [agent.id, agent.childSessionId]),
  );
});

test('serialized parent-recorded Codex rows match fresh status and cost after direct child resume', () => {
  for (const identity of ['inferred', 'explicit', 'parent-terminal']) {
    const { root, child, children, options } = nestedCodexCostFixture();
    if (identity !== 'inferred') {
      const records = fs
        .readFileSync(root, 'utf8')
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line));
      const output = records.find((record) => record.payload.type === 'function_call_output');
      output.payload.output = JSON.stringify({ agent_id: 'child', nickname: '/root/child' });
      if (identity === 'parent-terminal')
        records.splice(
          -1,
          0,
          item('agent_message', 28, {
            author: '/root/child',
            recipient: '/root',
            content: [{ type: 'input_text', text: 'Message Type: FINAL_ANSWER\nSender: /root/child\nPayload:\nDone' }],
          }),
        );
      fs.writeFileSync(root, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    }
    let retained = structuredClone(readCodexSession(root, 'root', options).turns);
    const originalId = retained[0].agents[0].id;
    const facts = (turns: typeof retained) => ({
      cost: turnCost(turns[0]),
      rows: turns[0].agents.map((agent) => [
        agent.id,
        agent.status,
        agent.durationMs,
        agent.childSessionId,
        agent.spendPartial,
      ]),
    });
    for (const [index, records] of [
      [event('task_started', 40, { turn_id: 'resume' })],
      [event('task_complete', 41, { turn_id: 'child-turn' })],
      [event('task_complete', 45, { turn_id: 'resume' })],
    ].entries()) {
      fs.appendFileSync(child, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
      retained = structuredClone(retained);
      refreshCodexStructuralAgents(retained, 'root', children, options.agentSpendOf);
      const fresh = readCodexSession(root, 'root', options).turns;
      assert.deepEqual(facts(retained), facts(fresh), identity);
      assert.equal(retained[0].agents[0].id, originalId);
      if (identity === 'parent-terminal') {
        assert.equal(retained[0].agents[0].status, 'completed');
        assert.equal(retained[0].agents[0].durationMs, index === 2 ? 39_000 : null);
      }
    }
  }
});

test('a parent turn attaches child spend by the thread id its activity recorded', () => {
  const records = ordinaryTurn();
  records.splice(
    5,
    0,
    item('function_call', 4, {
      name: 'spawn_agent',
      call_id: 'call_x',
      arguments: JSON.stringify({ task_name: 'review_sol', model: 'gpt-5.6-sol' }),
    }),
    event('sub_agent_activity', 5, {
      event_id: 'call_x',
      agent_thread_id: 'thread-2',
      agent_path: '/root/review_sol',
      kind: 'started',
    }),
  );
  const spend = [
    {
      model: 'gpt-5.6-sol',
      usage: { input: 1, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 2, output: 3, thinking: 1 },
    },
  ];
  const { turns } = readCodexSession(writeRollout(records), 'sess', {
    agentSpendOf: (agent) => ({
      models: agent.id === 'thread-2' ? spend : [],
      found: agent.id === 'thread-2',
      partial: false,
      effort: null,
    }),
  });
  assert.deepEqual(turns[0].agents[0].spend, spend);
  assert.equal(turns[0].agents[0].effort, null);
});

test('a subagent that handed its answer back is done, and its commentary is not that', () => {
  const records = ordinaryTurn();
  records.splice(
    5,
    0,
    item('function_call', 4, {
      name: 'spawn_agent',
      call_id: 'call_x',
      arguments: JSON.stringify({ task_name: 'review_sol', model: 'gpt-5.6-sol' }),
    }),
    // What the model narrates to the user as it works. It has no sender, so it is not an
    // answer from anybody and must leave the row alone.
    event('agent_message', 5, { message: 'Spawning the reviewer now.', phase: 'commentary' }),
    item('agent_message', 6, {
      id: 'amsg_1',
      author: '/root/review_sol',
      recipient: '/root',
      content: [
        { type: 'input_text', text: 'Message Type: FINAL_ANSWER\nSender: /root/review_sol\nPayload:\n## Summary' },
      ],
    }),
  );
  const { turns } = readCodexSession(writeRollout(records), 'sess');
  assert.equal(turns[0].agents.length, 1);
  assert.equal(turns[0].agents[0].status, 'completed');
});

test('a subagent the turn stopped says so', () => {
  const records = ordinaryTurn();
  records.splice(
    5,
    0,
    item('function_call', 4, {
      name: 'spawn_agent',
      call_id: 'call_x',
      arguments: JSON.stringify({ task_name: 'review_sol' }),
    }),
    event('sub_agent_activity', 5, { event_id: 'call_x', agent_path: '/root/review_sol', kind: 'interrupted' }),
  );
  const { turns } = readCodexSession(writeRollout(records), 'sess');
  assert.equal(turns[0].agents[0].status, 'interrupted');
});

const currentChildNotification = (second: number, childId: string, status: object | string) =>
  message(
    'user',
    second,
    `<subagent_notification>\n${JSON.stringify({ agent_path: childId, status })}\n</subagent_notification>`,
    'input_text',
    ['multi_agent.subagent_notification'],
  );

function currentSpawn(
  callId = 'current-spawn',
  childId = 'current-child',
  nickname = 'Laplace',
  includeOutput = true,
): object[] {
  const call = item('function_call', 4, {
    name: 'spawn_agent',
    namespace: 'multi_agent_v1',
    call_id: callId,
    arguments: JSON.stringify({
      agent_type: 'explorer',
      fork_context: false,
      message: 'inspect the parser',
      reasoning_effort: 'medium',
    }),
  });
  const completed = event('item_completed', 5, {
    item: {
      type: 'CollabAgentToolCall',
      id: callId,
      tool: 'spawn_agent',
      status: 'completed',
      receiver_thread_ids: [childId],
      receiver_agents: [{ thread_id: childId, agent_nickname: nickname, agent_role: 'explorer' }],
      model: 'openai.gpt-5.6-sol',
      reasoning_effort: 'high',
    },
  });
  const output = item('function_call_output', 6, {
    call_id: callId,
    output: JSON.stringify({ agent_id: childId, nickname }),
  });
  return includeOutput ? [call, completed, output] : [call, completed];
}

const currentSubAgentActivity = (
  second: number,
  callId: string | null,
  childId: string | null,
  agentPath: string | null,
) =>
  event('item_completed', second, {
    item: {
      type: 'SubAgentActivity',
      ...(callId ? { id: callId } : {}),
      ...(childId ? { agent_thread_id: childId } : {}),
      ...(agentPath ? { agent_path: agentPath } : {}),
    },
  });

function structuralChild(
  parentThreadId: string,
  threadId: string,
  openedSecond = 4,
  lifecycle: 'completed' | 'failed' | 'interrupted' | 'running' = 'completed',
  threadSource = 'guardian_review',
): CodexSubagentFile {
  const childTurn = `${threadId}-turn`;
  const records: object[] = [
    recordedAt(
      meta({
        id: threadId,
        parent_thread_id: parentThreadId,
        thread_source: threadSource,
        source: { subagent: { other: 'guardian' } },
        model_provider: 'openai',
      }),
      at(openedSecond),
    ),
    event('task_started', openedSecond, { turn_id: childTurn, model_context_window: 258400 }),
    turnContext(openedSecond + 1, childTurn, 'codex-auto-review', 'medium'),
    event('user_message', openedSecond + 2, { message: 'review' }),
    tokens(openedSecond + 3, { input_tokens: 20, cached_input_tokens: 10, output_tokens: 5 }),
  ];
  if (lifecycle === 'completed') {
    records.push(event('task_complete', openedSecond + 8, { turn_id: childTurn, last_agent_message: 'reviewed' }));
  } else if (lifecycle === 'failed') {
    records.push(
      event('task_complete', openedSecond + 8, {
        turn_id: childTurn,
        error: { message: 'review failed' },
        last_agent_message: '',
      }),
    );
  } else if (lifecycle === 'interrupted') {
    records.push(event('turn_aborted', openedSecond + 8, { turn_id: childTurn, reason: 'interrupted' }));
  }
  return {
    file: writeRollout(records),
    threadId,
    parentThreadId,
    agentPath: null,
    openedAt: ms(openedSecond),
    startedAt: ms(openedSecond),
    threadSource,
    backgroundReview: true,
  };
}

function namedStructuralChild(
  parentThreadId: string,
  threadId: string,
  agentPath: string,
  model = 'gpt-5.6-sol',
): CodexSubagentFile {
  const childTurn = `${threadId}-turn`;
  const openedSecond = 4;
  const records = [
    recordedAt(
      meta({
        id: threadId,
        parent_thread_id: parentThreadId,
        thread_source: 'subagent',
        source: { subagent: { thread_spawn: { parent_thread_id: parentThreadId, agent_path: agentPath } } },
        model_provider: 'openai',
      }),
      at(openedSecond),
    ),
    event('task_started', openedSecond, { turn_id: childTurn, model_context_window: 1_050_000 }),
    turnContext(openedSecond + 1, childTurn, model, 'high'),
    event('user_message', openedSecond + 2, { message: 'implement' }),
    tokens(openedSecond + 3, { input_tokens: 200_000, cached_input_tokens: 100_000 }),
    event('task_complete', openedSecond + 8, { turn_id: childTurn, last_agent_message: 'implemented' }),
  ];
  return {
    file: writeRollout(records),
    threadId,
    parentThreadId,
    agentPath,
    openedAt: ms(openedSecond),
    startedAt: ms(openedSecond),
    threadSource: 'subagent',
    backgroundReview: false,
  };
}

function currentActivityIdentityFixture(childModel = 'gpt-5.6-sol', spawnModel = 'gpt-6-astra') {
  const callId = 'current-activity-spawn';
  const childId = 'current-activity-child';
  const agentPath = '/root/astra_implementer';
  const child = namedStructuralChild('sess', childId, agentPath, childModel);
  const records: object[] = [
    meta(),
    event('task_started', 1, { turn_id: TURN, model_context_window: 258400 }),
    turnContext(2, TURN, 'gpt-5.6-sol', 'high'),
    event('user_message', 3, { message: 'implement the correction' }),
    item('function_call', 4, {
      name: 'spawn_agent',
      call_id: callId,
      arguments: JSON.stringify({ task_name: 'astra_implementer', model: spawnModel }),
    }),
    item('function_call_output', 5, {
      call_id: callId,
      output: JSON.stringify({ task_name: agentPath }),
    }),
    currentSubAgentActivity(6, callId, childId, agentPath),
    event('task_complete', 8, { turn_id: TURN, last_agent_message: 'implemented' }),
  ];
  const options = {
    structuralChildren: [child],
    agentSpendOf: (agent: Parameters<typeof codexSubagentFor>[2]) => {
      const source = codexSubagentFor([child], 'sess', agent);
      return source ? readCodexAgentSpend(source.file) : { models: [], found: false, partial: false, effort: null };
    },
  };
  return { records, child, options };
}

test('a current SubAgentActivity binds one named row to its structural child before spend attaches', () => {
  const { records, child, options } = currentActivityIdentityFixture();
  const [turn] = readCodexSession(writeRollout(records), 'sess', options).turns;
  assert.deepEqual(
    turn.agents.map((agent) => ({
      id: agent.id,
      description: agent.description,
      status: agent.status,
      spendFound: agent.spendFound,
      childSessionId: agent.childSessionId,
    })),
    [
      {
        id: child.threadId,
        description: 'astra_implementer',
        status: 'completed',
        spendFound: true,
        childSessionId: child.threadId,
      },
    ],
  );
  assert.ok(Math.abs(turnCost(turn).dollars! - 0.44) < 1e-12);
  assert.equal(turnCost(turn).partial, false);
});

test('a GPT-6.1 Sol structural child contributes priced delegated usage to its parent turn', () => {
  const { records, options } = currentActivityIdentityFixture('gpt-6.1-sol', 'gpt-6.1-sol');
  const [turn] = readCodexSession(writeRollout(records), 'sess', options).turns;
  assert.equal(turn.agents[0]?.childSessionId, 'current-activity-child');
  assert.equal(turn.agents[0]?.spend[0]?.model, 'gpt-6.1-sol');
  assert.deepEqual(turnCost(turn), { dollars: 0.21, partial: false });
});

test('current SubAgentActivity identity ignores missing and unmatched launch ids', () => {
  const records = [
    meta(),
    event('task_started', 1, { turn_id: TURN }),
    event('user_message', 2, { message: 'delegate' }),
    item('function_call', 3, {
      name: 'spawn_agent',
      call_id: 'known-spawn',
      arguments: JSON.stringify({ task_name: 'review_sol' }),
    }),
    item('function_call_output', 4, {
      call_id: 'known-spawn',
      output: JSON.stringify({ task_name: '/root/review_sol' }),
    }),
    currentSubAgentActivity(5, null, 'missing-id-child', '/root/wrong'),
    currentSubAgentActivity(6, 'unknown-spawn', 'unknown-child', '/root/wrong'),
    currentSubAgentActivity(7, 'known-spawn', null, '/root/wrong'),
    currentSubAgentActivity(8, 'known-spawn', 'missing-path-child', null),
    event('task_complete', 9, { turn_id: TURN, last_agent_message: 'done' }),
  ];
  const [agent] = readCodexSession(writeRollout(records), 'sess').turns[0].agents;
  assert.deepEqual(
    { id: agent.id, description: agent.description },
    {
      id: null,
      description: 'review_sol',
    },
  );
});

test('a prior Codex parser state rebuilds child identity and exact compaction usage from the rollout', () => {
  const { records, child, options } = currentActivityIdentityFixture();
  records.push({
    timestamp: at(9),
    type: 'compacted',
    payload: {
      message: '',
      replacement_history: [],
      window_number: 2,
      latest_token_usage_record: {
        usage: usage({
          input_tokens: 20_000,
          cached_input_tokens: 5_000,
          cache_write_input_tokens: 1_000,
          output_tokens: 2_000,
          reasoning_output_tokens: 0,
        }),
      },
    },
  });
  const file = writeRollout(records);
  const initial = readCodexSessionIncremental(file, 'sess', undefined, options);
  assert.ok(initial.checkpoint);
  const parserKey = initial.checkpoint.parserKey;
  (initial.checkpoint.parserState as { version: number }).version = 14;
  assert.equal(initial.checkpoint.parserKey, parserKey);
  const [agent] = initial.checkpoint.parserState.turns[0].agents;
  initial.checkpoint.parserState.turns[0].agents = [
    { ...agent, id: null, description: 'astra_implementer', agentType: null },
    { ...agent, id: child.threadId, description: 'agent', agentType: child.agentPath },
  ];

  const reset = readCodexSessionIncremental(file, 'sess', initial.checkpoint, options);
  assert.equal(reset.kind, 'reset');
  assert.equal(reset.checkpoint?.parserState.version, 20);
  assert.deepEqual(
    reset.read?.turns[0].agents.map((row) => [row.id, row.description]),
    [[child.threadId, 'astra_implementer']],
  );
  assert.ok(Math.abs(turnCost(reset.read!.turns[0]).dollars! - 0.44) < 1e-12);
  assert.equal(turnCost(reset.read!.turns[0]).partial, false);
  const exactUsage = {
    requests: 1,
    input: 14_000,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheWrite30m: 1_000,
    cacheRead: 5_000,
    output: 2_000,
    thinking: 0,
  };
  assert.deepEqual(reset.read?.compactions[0].usage, exactUsage);
  const reused = readCodexSessionIncremental(file, 'sess', reset.checkpoint ?? undefined, options);
  assert.equal(reused.kind, 'reused');
  assert.deepEqual(reused.read?.compactions[0].usage, exactUsage);
});

test('a guardian header attaches background review and spend to its parent turn', () => {
  const child = structuralChild('sess', 'guardian-child');
  const spend = readCodexAgentSpend(child.file);
  const [turn] = readCodexSession(writeRollout(ordinaryTurn()), 'sess', {
    structuralChildren: [child],
    agentSpendOf: (agent) =>
      agent.id === child.threadId ? spend : { models: [], found: false, partial: false, effort: null },
  }).turns;
  assert.equal(turn.agents.length, 1);
  assert.equal(turn.agents[0].childSessionId, undefined);
  assert.deepEqual(
    {
      id: turn.agents[0].id,
      description: turn.agents[0].description,
      status: turn.agents[0].status,
      durationMs: turn.agents[0].durationMs,
      model: turn.agents[0].spend[0]?.model,
      spendFound: turn.agents[0].spendFound,
    },
    {
      id: 'guardian-child',
      description: 'Background review',
      status: 'completed',
      durationMs: 8_000,
      model: 'codex-auto-review',
      spendFound: true,
    },
  );
  assert.deepEqual(turnCost(turn), { dollars: 0.044985699999999997, partial: false });
});

test('a current guardian whose opening record is written late keeps its turn, time, and spend', () => {
  // The guardian writes its opening record 7.7s after the clock in its payload, and after its
  // own turn started. That turn is the review, not history copied from the parent.
  const plus = (second: number, extra: number) => new Date(ms(second) + extra).toISOString();
  const childId = 'guardian-review-child';
  const childTurn = 'guardian-review-turn';
  const startedAt = ms(4) / 1000;
  const childFile = writeRollout([
    recordedAt(
      meta({
        id: childId,
        session_id: 'sess',
        parent_thread_id: 'sess',
        timestamp: plus(4, 710),
        source: { subagent: { other: 'guardian' } },
        thread_source: 'guardian_review',
        model_provider: 'openai',
        history_mode: 'paginated',
        subagent_history_start_ordinal: 14,
        git: {},
      }),
      plus(12, 398),
    ),
    recordedAt(
      event('task_started', 0, { turn_id: childTurn, started_at: startedAt, model_context_window: 258400 }),
      plus(13, 248),
    ),
    recordedAt(turnContext(0, childTurn, 'codex-auto-review', 'low'), plus(13, 259)),
    recordedAt(message('user', 0, 'review this action', 'input_text', ['user.text']), plus(13, 266)),
    recordedAt(
      event('item_completed', 0, {
        thread_id: childId,
        turn_id: childTurn,
        item: { type: 'UserMessage', id: 'item-1' },
      }),
      plus(13, 267),
    ),
    recordedAt(message('assistant', 0, '{"outcome":"allow"}', 'output_text'), plus(18, 167)),
    recordedAt(
      tokens(0, { input_tokens: 27365, cached_input_tokens: 4864, output_tokens: 177, reasoning_output_tokens: 117 }),
      plus(18, 168),
    ),
    recordedAt(
      event('task_complete', 0, {
        turn_id: childTurn,
        last_agent_message: '{"outcome":"allow"}',
        started_at: startedAt,
        completed_at: startedAt + 14,
        duration_ms: 13347,
      }),
      plus(18, 180),
    ),
  ]);
  const childMeta = readCodexSessionMeta(childFile);
  const child: CodexSubagentFile = {
    file: childFile,
    threadId: childId,
    parentThreadId: 'sess',
    agentPath: null,
    openedAt: childMeta?.openedAt ?? null,
    startedAt: childMeta?.startedAt ?? null,
    threadSource: childMeta?.threadSource ?? null,
    backgroundReview: true,
  };
  const parent = writeRollout([
    meta({ id: 'sess', session_id: 'sess' }),
    event('task_started', 1, { turn_id: TURN, model_context_window: 258400 }),
    turnContext(2, TURN, 'gpt-5.6-sol', 'high'),
    event('user_message', 3, { message: 'commit the change' }),
    event('task_complete', 30, { turn_id: TURN, last_agent_message: 'committed' }),
  ]);
  const [turn] = readCodexSession(parent, 'sess', {
    structuralChildren: [child],
    agentSpendOf: (agent) =>
      agent.id === childId
        ? readCodexAgentSpend(childFile)
        : { models: [], found: false, partial: false, effort: null },
  }).turns;
  const now = ms(60);
  const [row] = toCard(turn, false, now).agents;
  assert.equal(row.description, 'Background review');
  const figure = (metric: string) => row.figures.find((entry) => entry.metric === metric);
  assert.equal(figure('duration')?.compactLabel, '13s');
  // Both clocks fall within one displayed minute. Check the exact Started timestamp against the guardian payload clock.

  assert.equal(turn.agents[0].artifacts?.startedAt, ms(4) + 710);
  assert.deepEqual(figure('duration')?.record?.entries, [
    { label: 'Started', value: formatWhen(ms(4) + 710, now) },
    { label: 'Ended', value: formatWhen(ms(18) + 180, now) },
  ]);
  assert.ok(figure('cost'), 'the row carries the review spend');
  assert.equal(turn.agents[0].spend[0]?.model, 'codex-auto-review');
});

test('a current guardian whose payload clock sits just before a minute boundary shows the payload minute', () => {
  // Shift the fixture so the payload timestamp and the task_started write time fall in different displayed minutes.

  const plus = (second: number, extra: number) => new Date(ms(second) + extra).toISOString();
  const childId = 'guardian-review-child-minute';
  const childTurn = 'guardian-review-turn-minute';
  const startedAt = ms(58) / 1000;
  const childFile = writeRollout([
    recordedAt(
      meta({
        id: childId,
        session_id: 'sess',
        parent_thread_id: 'sess',
        timestamp: plus(58, 710),
        source: { subagent: { other: 'guardian' } },
        thread_source: 'guardian_review',
        model_provider: 'openai',
        history_mode: 'paginated',
        subagent_history_start_ordinal: 14,
        git: {},
      }),
      plus(66, 398),
    ),
    recordedAt(
      event('task_started', 0, { turn_id: childTurn, started_at: startedAt, model_context_window: 258400 }),
      plus(67, 248),
    ),
    recordedAt(turnContext(0, childTurn, 'codex-auto-review', 'low'), plus(67, 259)),
    recordedAt(message('user', 0, 'review this action', 'input_text', ['user.text']), plus(67, 266)),
    recordedAt(
      event('item_completed', 0, {
        thread_id: childId,
        turn_id: childTurn,
        item: { type: 'UserMessage', id: 'item-1' },
      }),
      plus(67, 267),
    ),
    recordedAt(message('assistant', 0, '{"outcome":"allow"}', 'output_text'), plus(72, 167)),
    recordedAt(
      tokens(0, { input_tokens: 27365, cached_input_tokens: 4864, output_tokens: 177, reasoning_output_tokens: 117 }),
      plus(72, 168),
    ),
    recordedAt(
      event('task_complete', 0, {
        turn_id: childTurn,
        last_agent_message: '{"outcome":"allow"}',
        started_at: startedAt,
        completed_at: startedAt + 14,
        duration_ms: 13347,
      }),
      plus(72, 180),
    ),
  ]);
  const childMeta = readCodexSessionMeta(childFile);
  const child: CodexSubagentFile = {
    file: childFile,
    threadId: childId,
    parentThreadId: 'sess',
    agentPath: null,
    openedAt: childMeta?.openedAt ?? null,
    startedAt: childMeta?.startedAt ?? null,
    threadSource: childMeta?.threadSource ?? null,
    backgroundReview: true,
  };
  const parent = writeRollout([
    meta({ id: 'sess', session_id: 'sess' }),
    event('task_started', 1, { turn_id: TURN, model_context_window: 258400 }),
    turnContext(2, TURN, 'gpt-5.6-sol', 'high'),
    event('user_message', 3, { message: 'commit the change' }),
    event('task_complete', 80, { turn_id: TURN, last_agent_message: 'committed' }),
  ]);
  const [turn] = readCodexSession(parent, 'sess', {
    structuralChildren: [child],
    agentSpendOf: (agent) =>
      agent.id === childId
        ? readCodexAgentSpend(childFile)
        : { models: [], found: false, partial: false, effort: null },
  }).turns;
  const now = ms(120);
  const [row] = toCard(turn, false, now).agents;
  assert.equal(turn.agents[0].artifacts?.startedAt, ms(58) + 710);
  const figure = (metric: string) => row.figures.find((entry) => entry.metric === metric);
  const started = figure('duration')?.record?.entries.find((entry) => entry.label === 'Started');
  // The displayed minute must be the payload clock's minute, 12:00, not the task_started
  // record's write time, which crossed into 12:01.
  assert.equal(started?.value, formatWhen(ms(58) + 710, now));
  assert.notEqual(started?.value, formatWhen(ms(67) + 248, now));
});

test('a guardian with no payload timestamp takes Started from its opening envelope', () => {
  const childId = 'guardian-no-payload-child';
  const childTurn = 'guardian-no-payload-turn';
  const childFile = writeRollout([
    recordedAt(
      meta({
        id: childId,
        session_id: 'sess',
        parent_thread_id: 'sess',
        source: { subagent: { other: 'guardian' } },
        thread_source: 'guardian_review',
        model_provider: 'openai',
      }),
      at(20),
    ),
    recordedAt(event('task_started', 0, { turn_id: childTurn, model_context_window: 258400 }), at(25)),
    recordedAt(turnContext(0, childTurn, 'codex-auto-review', 'medium'), at(25)),
    recordedAt(event('user_message', 0, { message: 'review' }), at(25)),
    recordedAt(tokens(0, { input_tokens: 20, cached_input_tokens: 10, output_tokens: 5 }), at(26)),
    recordedAt(event('task_complete', 0, { turn_id: childTurn, last_agent_message: 'reviewed' }), at(30)),
  ]);
  const spend = readCodexAgentSpend(childFile);
  // Without a guardian payload timestamp, Started uses the opening envelope time rather than the turn start.

  assert.equal(spend.artifacts?.startedAt, ms(20));
});

test('a non-guardian Codex child keeps the Started its own turns recorded', () => {
  const childId = 'non-guardian-child';
  const childTurn = 'non-guardian-turn';
  const childFile = writeRollout([
    recordedAt(
      meta({
        id: childId,
        session_id: 'sess',
        parent_thread_id: 'sess',
        source: { subagent: { thread_spawn: { parent_thread_id: 'sess', agent_path: '/root/impl' } } },
        thread_source: 'subagent',
        model_provider: 'openai',
      }),
      at(2),
    ),
    recordedAt(event('task_started', 0, { turn_id: childTurn, model_context_window: 258400 }), at(5)),
    recordedAt(turnContext(0, childTurn, 'gpt-5.6-sol', 'high'), at(5)),
    recordedAt(event('user_message', 0, { message: 'implement' }), at(5)),
    recordedAt(tokens(0, { input_tokens: 20, cached_input_tokens: 10, output_tokens: 5 }), at(6)),
    recordedAt(event('task_complete', 0, { turn_id: childTurn, last_agent_message: 'implemented' }), at(9)),
  ]);
  const spend = readCodexAgentSpend(childFile);
  // This child is an ordinary subagent, not a guardian, so the override never applies. Started
  // stays the turn's own recorded start (12:00:05), not the opening envelope (12:00:02).
  assert.equal(spend.artifacts?.startedAt, ms(5));
});

// A rollout whose opening record is written at 12:00:12.398, 7.7s after the 12:00:04.710 clock
// in its payload. Two copied parent turns come first: one started a minute before that clock and
// one 2.7s before it. `own` lists the turns the rollout ran itself, by recorded start second.
function lateOpeningRollout(
  id: string,
  source: Record<string, unknown>,
  own: ReadonlyArray<{ turnId: string; second: number; input: number; endSecond: number }>,
): object[] {
  const stamp = (second: number, extra = 0) => new Date(ms(second) + extra).toISOString();
  const turn = (turnId: string, startSecond: number, input: number, writtenSecond: number, endSecond: number) => [
    recordedAt(
      event('task_started', 0, { turn_id: turnId, started_at: ms(startSecond) / 1000, model_context_window: 258400 }),
      stamp(writtenSecond, 1),
    ),
    recordedAt(turnContext(0, turnId, 'codex-auto-review', 'low'), stamp(writtenSecond, 2)),
    recordedAt(event('user_message', 0, { message: `${turnId} prompt` }), stamp(writtenSecond, 3)),
    recordedAt(tokens(0, { input_tokens: input, output_tokens: 1 }), stamp(endSecond, 4)),
    recordedAt(
      event('task_complete', 0, {
        turn_id: turnId,
        last_agent_message: `${turnId} answer`,
        duration_ms: (endSecond - startSecond) * 1000,
      }),
      stamp(endSecond, 5),
    ),
  ];
  return [
    recordedAt(
      meta({ id, session_id: 'sess', timestamp: stamp(4, 710), model_provider: 'openai', ...source }),
      stamp(12, 398),
    ),
    ...turn('parent-far', -60, 900, 12, 12),
    ...turn('parent-near', 2, 800, 12, 12),
    ...own.flatMap((entry) =>
      turn(entry.turnId, entry.second, entry.input, Math.max(entry.second, 13), entry.endSecond),
    ),
  ];
}

test('a delayed direct opening keeps three completed turns after cold reconstruction', () => {
  const creation = '2026-10-03T03:10:04.531Z';
  const envelope = '2026-10-03T03:10:22.496Z';
  const starts = ['2026-10-03T03:10:08Z', '2026-10-03T03:12:08Z', '2026-10-03T03:13:08Z'];
  const ids = ['original-turn', 'second-turn', 'third-turn'];
  for (const source of ['vscode', 'cli']) {
    for (const thread_source of [undefined, 'user']) {
      const records = [
        recordedAt(meta({ id: 'sess', timestamp: creation, source, thread_source }), envelope),
        ...ids.flatMap((id, n) => {
          const start = Date.parse(starts[n]);
          const written = new Date(Math.max(start, Date.parse(envelope)) + 1).toISOString();
          return [
            recordedAt(event('task_started', 0, { turn_id: id, started_at: start / 1000 }), written),
            recordedAt(turnContext(0, id, 'gpt-5.6-sol', 'high'), written),
            recordedAt(message('user', 0, '<environment_context>workspace</environment_context>'), written),
            recordedAt(message('user', 0, `${id} prompt`, 'input_text', ['user.text']), written),
            ...(n === 0
              ? [
                  recordedAt(
                    commandCompleted(0, DISPATCH_COMMAND, 0, 'completed', 'dispatch', { stdout: DISPATCH_RECEIPT }),
                    written,
                  ),
                ]
              : []),
            recordedAt(tokens(0, { input_tokens: n + 10, output_tokens: 1 }), written),
            recordedAt(
              event('task_complete', 0, { turn_id: id, last_agent_message: `${id} answer` }),
              new Date(start + 60_000).toISOString(),
            ),
          ];
        }),
      ];
      const file = writeRollout(records);
      const ordinary = readCodexSession(file, 'sess');
      assert.deepEqual(
        ordinary.turns.map((turn) => turn.promptId),
        ids,
      );
      assert.deepEqual(
        ordinary.turns.map((turn) => turn.prompt),
        ids.map((id) => `${id} prompt`),
      );
      assert.ok(ordinary.turns.every((turn) => turn.finished));
      const cold = readCodexSessionIncremental(file, 'sess');
      assert.ok(cold.read);
      assert.deepEqual(cold.read.turns, ordinary.turns);
      assert.deepEqual(readCodexSessionIncremental(file, 'sess').read?.turns, ordinary.turns);
      const page = readCodexHistoryPage(file, 'sess', null, { chunkBytes: fs.statSync(file).size, targetTurns: 3 });
      assert.equal(page.kind, 'page');
      assert.deepEqual(page.page?.turns, ordinary.turns);
      const usageReader = createCodexUsageLineReducer();
      assert.deepEqual(
        records.flatMap((record) => usageReader.pushLine(JSON.stringify(record))).map((request) => request.usage.input),
        [10, 11, 12],
      );
      assert.equal(usageReader.turnCount(), 3);
      assert.deepEqual(Object.keys(usageReader.snapshot().copiedTurnIds), []);
      assert.equal(scanForCodexPerson(file, fs.statSync(file).size).person, true);
      assert.deepEqual(
        scanCodexDispatchReferences(file, 'sess').references.map((reference) => reference.sessionId),
        [CLAUDE_SESSION],
      );

      const stale = throughStructuredClone(cold.checkpoint);
      stale.parserKey = JSON.stringify({ ...JSON.parse(stale.parserKey), version: 6 });
      stale.parserState.turns.shift();
      stale.parserState.turnRanges.shift();
      stale.parserState.turnMembershipStarts.shift();
      stale.parserState.usageState.copiedTurnIds[ids[0]] = true;
      stale.parserState.usageState.closedTurns = 2;
      stale.parserState.usageState.openingTimestamp = Date.parse(envelope);
      const rebuilt = readCodexSessionIncremental(file, 'sess', stale);
      assert.equal(rebuilt.kind, 'reset');
      assert.ok(rebuilt.read);
      assert.deepEqual(rebuilt.read.turns, ordinary.turns);
    }
  }
});

test('native spawned work survives a delayed envelope across full and saved readers', () => {
  const child = 'native-delayed-child';
  const records = lateOpeningRollout(
    child,
    {
      parent_thread_id: 'sess',
      thread_source: 'subagent',
      source: { subagent: { thread_spawn: { parent_thread_id: 'sess', agent_path: '/root/reviewer' } } },
    },
    [{ turnId: 'own-astra', second: 6, input: 1000, endSecond: 18 }],
  );
  for (const record of records) {
    const value = record as { type: string; payload: Record<string, unknown> };
    if (value.type === 'turn_context' && value.payload.turn_id === 'own-astra') {
      Object.assign(value.payload, { model: 'gpt-6-astra', effort: 'high' });
    }
  }
  const file = writeRollout(records);
  const full = readCodexSession(file, child);
  assert.deepEqual(
    full.turns.map((turn) => [turn.promptId, turn.model, turn.effort, turn.usage.input]),
    [['own-astra', 'gpt-6-astra', 'high', 1000]],
  );
  const forward = readCodexSessionIncremental(file, child);
  assert.ok(forward.checkpoint);
  assert.deepEqual(forward.read?.turns, full.turns);
  assert.deepEqual(
    readCodexHistoryPage(file, child, null, { chunkBytes: fs.statSync(file).size, targetTurns: 1 }).page?.turns,
    full.turns,
  );
  const saved = throughStructuredClone(forward.checkpoint);
  saved.parserKey = JSON.stringify({ ...JSON.parse(saved.parserKey), version: 8 });
  saved.parserState.turns = [];
  saved.parserState.turnRanges = [];
  saved.parserState.turnMembershipStarts = [];
  saved.parserState.usageState.openingTimestamp = ms(12) + 398;
  saved.parserState.usageState.copiedTurnIds['own-astra'] = true;
  const rebuilt = readCodexSessionIncremental(file, child, saved);
  assert.equal(rebuilt.kind, 'reset');
  assert.deepEqual(rebuilt.read?.turns, full.turns);
});

test('rounded native ownership retains known context through cloned spend and forward checkpoints', () => {
  const child = 'native-rounded-child';
  const own = 'rounded-astra';
  const records = lateOpeningRollout(
    child,
    {
      parent_thread_id: 'sess',
      thread_source: 'subagent',
      source: { subagent: { thread_spawn: { parent_thread_id: 'sess', agent_path: '/root/reviewer' } } },
    },
    [{ turnId: own, second: 4, input: 1000, endSecond: 18 }],
  );
  for (const record of records) {
    const value = record as { type: string; payload: Record<string, unknown> };
    if (value.type === 'turn_context' && value.payload.turn_id === own) {
      Object.assign(value.payload, { model: 'gpt-6-astra', effort: 'high' });
    }
  }
  const bill = {
    type: 'token_usage_record',
    timestamp: at(19),
    payload: {
      thread_id: child,
      session_id: 'sess',
      turn_id: own,
      response_id: 'native-response',
      usage: {
        input_tokens: 1000,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 1,
        reasoning_output_tokens: 0,
        total_tokens: 1001,
      },
    },
  };
  records.splice(
    records.length - 1,
    0,
    recordedAt(
      commandCompleted(0, DISPATCH_COMMAND, 0, 'completed', 'native-dispatch', { stdout: DISPATCH_RECEIPT }),
      at(17),
    ),
  );
  const file = writeRollout(records);
  const initialDispatch = scanCodexDispatchReferences(file, child);
  assert.deepEqual(initialDispatch.references, []);
  const initialForward = readCodexSessionIncremental(file, child);
  assert.ok(initialForward.checkpoint);
  const initialSpend = indexSpendFile(undefined, file, 'workspace', createCodexUsageLineReducer, 1).record;
  assert.deepEqual(initialForward.read?.turns, []);
  const retained = (initialSpend.parserState as ReturnType<typeof emptyCodexUsageReducerState>).pendingRequests[own];
  assert.deepEqual(
    retained.map((event) => [event.model, event.effort, event.usage.input]),
    [['gpt-6-astra', 'high', 1000]],
  );
  const saved = structuredClone(initialSpend);
  const ledger = path.join(tempDir('native-rounded-ledger-'), 'spend.json');
  saveSpendLedger(ledger, 'workspace', [saved]);
  const loaded = loadSpendLedger(ledger, 'workspace').files;
  assert.equal(loaded.length, 1);
  const fullReducer = createCodexUsageLineReducer();
  const expected = [...records, bill].flatMap((record) => fullReducer.pushLine(JSON.stringify(record)));
  const restored = createCodexUsageLineReducer(
    structuredClone(initialSpend.parserState as ReturnType<typeof emptyCodexUsageReducerState>),
  );
  assert.deepEqual(restored.pushLine(JSON.stringify(bill)), expected);
  assert.equal(restored.snapshot().currentTurnEndedAt, ms(18) + 5);
  fs.appendFileSync(file, JSON.stringify(bill) + '\n');
  const resumedDispatch = scanCodexDispatchReferences(file, child, structuredClone(initialDispatch.cursor));
  assert.deepEqual(resumedDispatch.references, scanCodexDispatchReferences(file, child).references);
  assert.deepEqual(
    resumedDispatch.references.map((reference) => reference.sessionId),
    [CLAUDE_SESSION],
  );
  const resumedSpend = indexSpendFile(loaded[0], file, 'workspace', createCodexUsageLineReducer, 2).record;
  const fullSpend = indexSpendFile(undefined, file, 'workspace', createCodexUsageLineReducer, 2).record;
  assert.deepEqual(resumedSpend.buckets, fullSpend.buckets);
  assert.deepEqual(resumedSpend.lifetimeBuckets, fullSpend.lifetimeBuckets);
  const resumed = readCodexSessionIncremental(file, child, throughStructuredClone(initialForward.checkpoint));
  const full = readCodexSession(file, child);
  assert.equal(readCodexAgentSpend(file).effort, 'high');
  assert.deepEqual(resumed.read?.turns, full.turns);
  assert.deepEqual(
    full.turns.map((turn) => [turn.promptId, turn.model, turn.effort, turn.usage.input]),
    [[own, 'gpt-6-astra', 'high', 1000]],
  );
  assert.deepEqual(
    readCodexHistoryPage(file, child, null, { chunkBytes: fs.statSync(file).size, targetTurns: 1 }).page?.turns,
    full.turns,
  );
  for (const thread of ['sess', 'foreign']) {
    const rejected = createCodexUsageLineReducer(
      structuredClone(initialSpend.parserState as ReturnType<typeof emptyCodexUsageReducerState>),
    );
    assert.deepEqual(
      rejected.pushLine(JSON.stringify({ ...bill, payload: { ...bill.payload, thread_id: thread } })),
      [],
    );
    assert.equal(rejected.snapshot().pendingRequests[own][0].model, 'gpt-6-astra');
  }
  const replay = [
    recordedAt(event('task_started', 0, { turn_id: own, started_at: ms(4) / 1000 }), at(19)),
    turnContext(20, own, 'gpt-6-sol', 'low'),
    tokens(21, { input_tokens: 9000, output_tokens: 10 }),
    commandCompleted(22, DISPATCH_COMMAND, 0, 'completed', 'repeated-native-dispatch', { stdout: DISPATCH_RECEIPT }),
    event('task_complete', 23, { turn_id: own }),
  ];
  const repeatedFile = writeRollout([...records, ...replay, bill]);
  const repeatedReducer = createCodexUsageLineReducer();
  const repeatedEvents = [...records, ...replay, bill].flatMap((record) =>
    repeatedReducer.pushLine(JSON.stringify(record)),
  );
  assert.deepEqual(repeatedEvents, expected);
  assert.deepEqual(readCodexSession(repeatedFile, child).turns, full.turns);
  assert.deepEqual(scanCodexDispatchReferences(repeatedFile, child).references, resumedDispatch.references);
});

test('native ownership evidence eviction preserves unknown usage at the association bound', () => {
  const child = 'native-eviction';
  const own = 'rounded-eviction';
  const records = lateOpeningRollout(
    child,
    {
      parent_thread_id: 'sess',
      thread_source: 'subagent',
      source: { subagent: { thread_spawn: { parent_thread_id: 'sess' } } },
    },
    [{ turnId: own, second: 4, input: 1000, endSecond: 18 }],
  );
  const reducer = createCodexUsageLineReducer();
  records.slice(0, -2).forEach((record) => reducer.pushLine(JSON.stringify(record)));
  reducer.pushLine(JSON.stringify(turnContext(17, own, 'gpt-6-astra', 'high')));
  const released = [];
  for (let index = 1; index <= CODEX_USAGE_ASSOCIATION_LIMIT + 1; index++) {
    const snapshot = event('token_count', 18 + index, {
      info: {
        last_token_usage: usage({ input_tokens: 1000, output_tokens: 1 }),
        total_token_usage: usage({ total_tokens: 1001 * index }),
      },
    });
    released.push(...reducer.pushLine(JSON.stringify(snapshot)));
  }
  assert.equal(reducer.snapshot().pendingRequestKeys.length, CODEX_USAGE_ASSOCIATION_LIMIT);
  assert.equal(released.length, 1);
  assert.equal(released[0].model, 'gpt-6-astra');
  assert.equal(released[0].incomplete, true);
  assert.equal(released[0].usage.input, 1000);
});

test('native ownership confirmation keeps model-less requests through spend and forward checkpoints', () => {
  const child = 'native-late-context';
  const own = 'rounded-late-context';
  const records = lateOpeningRollout(
    child,
    {
      parent_thread_id: 'sess',
      thread_source: 'subagent',
      source: { subagent: { thread_spawn: { parent_thread_id: 'sess' } } },
    },
    [{ turnId: own, second: 4, input: 1000, endSecond: 18 }],
  ).filter((record) => {
    const value = record as { type: string; payload: Record<string, unknown> };
    return !(value.type === 'turn_context' && value.payload.turn_id === own);
  });
  const bill = {
    type: 'token_usage_record',
    timestamp: at(19),
    payload: {
      turn_id: own,
      thread_id: child,
      response_id: 'late-context',
      usage: usage({ input_tokens: 1000, output_tokens: 1 }),
    },
  };
  const context = turnContext(20, own, 'gpt-6-astra', 'high');
  for (const contextFirst of [false, true]) {
    const prefix = [...records, ...(contextFirst ? [context] : []), bill];
    const reducer = createCodexUsageLineReducer();
    const early = prefix.flatMap((record) => reducer.pushLine(JSON.stringify(record)));
    assert.equal(early.length, contextFirst ? 1 : 0);
    const held = reducer.snapshot().pendingRequests[own] ?? [];
    assert.equal(held.length, contextFirst ? 0 : 1);
    const file = writeRollout(prefix);
    const spend = indexSpendFile(undefined, file, 'workspace', createCodexUsageLineReducer, 1).record;
    const forward = readCodexSessionIncremental(file, child);
    assert.ok(forward.checkpoint);
    const ledger = path.join(tempDir('native-late-context-ledger-'), 'spend.json');
    saveSpendLedger(ledger, 'workspace', [structuredClone(spend)]);
    const loaded = loadSpendLedger(ledger, 'workspace').files;
    assert.equal(loaded.length, 1);
    if (!contextFirst) {
      const restored = createCodexUsageLineReducer(structuredClone(reducer.snapshot()));
      const events = restored.pushLine(JSON.stringify(context));
      assert.deepEqual(
        events.map((event) => [event.model, event.effort, event.usage.input]),
        [['gpt-6-astra', 'high', 1000]],
      );
      fs.appendFileSync(file, JSON.stringify(context) + '\n');
    }
    const full = readCodexSession(file, child);
    const resumed = readCodexSessionIncremental(file, child, throughStructuredClone(forward.checkpoint));
    assert.deepEqual(resumed.read?.turns, full.turns);
    assert.deepEqual(
      full.turns.map((turn) => [turn.promptId, turn.model, turn.effort, turn.usage.input]),
      [[own, 'gpt-6-astra', 'high', 1000]],
    );
    const fullSpend = indexSpendFile(undefined, file, 'workspace', createCodexUsageLineReducer, 2).record;
    const resumedSpend = indexSpendFile(loaded[0], file, 'workspace', createCodexUsageLineReducer, 2).record;
    assert.deepEqual(resumedSpend.buckets, fullSpend.buckets);
    assert.equal(fullSpend.buckets[0].model, 'gpt-6-astra');
  }
});

test('rounded native Claude print usage waits for exact ownership and releases once across saved spend', () => {
  const child = 'native-claude-print';
  const own = 'rounded-print';
  const records = lateOpeningRollout(
    child,
    {
      parent_thread_id: 'sess',
      thread_source: 'subagent',
      source: { subagent: { thread_spawn: { parent_thread_id: 'sess' } } },
    },
    [{ turnId: own, second: 4, input: 1000, endSecond: 18 }],
  );
  const command = claudeCommandCompleted(17, 'owned-print');
  records.splice(
    records.length - 1,
    0,
    claudeCommandCompleted(16, 'owned-print', '{"type":"result","session_id":'),
    command,
    command,
    turnContext(17, own, 'gpt-6-astra', 'high'),
  );
  const bill = {
    type: 'token_usage_record',
    timestamp: at(20),
    payload: {
      turn_id: own,
      thread_id: child,
      response_id: 'print-own',
      usage: usage({ input_tokens: 1000, output_tokens: 1 }),
    },
  };
  const file = writeRollout(records);
  const spend = indexSpendFile(undefined, file, 'workspace', createCodexUsageLineReducer, 1).record;
  const ledger = path.join(tempDir('native-print-ledger-'), 'spend.json');
  saveSpendLedger(ledger, 'workspace', [structuredClone(spend)]);
  const loaded = loadSpendLedger(ledger, 'workspace').files;
  assert.equal(loaded.length, 1);
  const checkpoint = readCodexSessionIncremental(file, child).checkpoint;
  assert.ok(checkpoint);
  for (const thread of [child, 'sess', 'foreign', null]) {
    const reducer = createCodexUsageLineReducer(
      structuredClone(spend.parserState as ReturnType<typeof emptyCodexUsageReducerState>),
    );
    const events = thread
      ? reducer.pushLine(JSON.stringify({ ...bill, payload: { ...bill.payload, thread_id: thread } }))
      : [];
    const prints = events.filter((event) => event.agent === 'claude');
    assert.equal(prints.length, thread === child ? 2 : 0);
    if (thread === child) {
      assert.deepEqual(
        prints.map((event) => [event.model, event.reportedCost]),
        [
          ['claude-haiku-4-5', 0.01],
          ['claude-opus-5', 3.24],
        ],
      );
      assert.deepEqual(reducer.pushLine(JSON.stringify(command)), []);
    } else assert.equal(reducer.snapshot().pendingRequests[own].filter((event) => event.agent === 'claude').length, 2);
  }
  fs.appendFileSync(file, JSON.stringify(bill) + '\n');
  const resumed = indexSpendFile(loaded[0], file, 'workspace', createCodexUsageLineReducer, 2).record;
  const full = indexSpendFile(undefined, file, 'workspace', createCodexUsageLineReducer, 2).record;
  assert.deepEqual(resumed.buckets, full.buckets);
  assert.equal(full.buckets.filter((bucket) => bucket.agent === 'claude').length, 2);
  const forward = readCodexSessionIncremental(file, child, throughStructuredClone(checkpoint));
  assert.deepEqual(forward.read?.turns, readCodexSession(file, child).turns);
  assert.equal(forward.read?.turns[0].usage.input, 1000);
  const repeated = [
    ...records,
    recordedAt(event('task_started', 0, { turn_id: own, started_at: ms(4) / 1000 }), at(19)),
    claudeCommandCompleted(19, 'repeated-print'),
    bill,
  ];
  const replay = createCodexUsageLineReducer();
  const replayEvents = repeated.flatMap((record) => replay.pushLine(JSON.stringify(record)));
  assert.equal(replayEvents.filter((event) => event.agent === 'claude').length, 2);
  const evicted = createCodexUsageLineReducer();
  records.forEach((record) => evicted.pushLine(JSON.stringify(record)));
  const released = Array.from({ length: 64 }, (_, index) =>
    event('task_started', 21 + index, { turn_id: `later-${index}` }),
  )
    .flatMap((record) => evicted.pushLine(JSON.stringify(record)))
    .filter((event) => event.agent === 'claude');
  assert.equal(released.length, 2);
  assert.ok(released.every((event) => event.incomplete));
});

test('only direct opening sources use a valid creation clock', () => {
  const creation = new Date(ms(4) + 531).toISOString();
  const envelope = new Date(ms(22) + 496).toISOString();
  const cases: Array<[Record<string, unknown>, boolean]> = [
    [{ source: 'vscode', thread_source: undefined }, true],
    [{ source: 'cli', thread_source: 'user', parent_thread_id: '', forked_from_id: '' }, true],
    [{ source: 'vscode', parent_thread_id: 'parent' }, false],
    [{ source: 'vscode', forked_from_id: 'parent' }, false],
    [{ source: 'exec' }, false],
    [{ source: undefined }, false],
    [{ source: 'unknown' }, false],
    [{ source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } } }, false],
    [{ thread_source: 'subagent' }, false],
    [{ thread_source: 'unknown' }, false],
    [{ timestamp: undefined }, false],
    [{ timestamp: 'invalid' }, false],
  ];
  for (const [fields, direct] of cases) {
    const file = writeRollout([recordedAt(meta({ timestamp: creation, ...fields }), envelope)]);
    const opening = readCodexSessionMeta(file)!;
    assert.equal(opening.openedAt, Date.parse(envelope));
    assert.equal(opening.startedAt, Date.parse(direct ? creation : envelope), JSON.stringify(fields));
    assert.equal(opening.replayBoundaryAt, opening.startedAt);
  }
  const file = writeRollout(
    lateOpeningRollout('direct-rounded', { source: 'vscode' }, [
      { turnId: 'rounded-start', second: 4, input: 12, endSecond: 18 },
    ]),
  );
  assert.deepEqual(
    readCodexSession(file, 'direct-rounded').turns.map((turn) => turn.promptId),
    ['parent-near', 'rounded-start'],
  );
});

test('a current guardian with a late opening record keeps its own turns and drops copied parent turns', () => {
  const guardianId = 'late-guardian';
  const guardianRecords = lateOpeningRollout(
    guardianId,
    { parent_thread_id: 'sess', thread_source: 'guardian_review', source: { subagent: { other: 'guardian' } } },
    [
      { turnId: 'guardian-first', second: 4, input: 12, endSecond: 18 },
      { turnId: 'guardian-second', second: 20, input: 13, endSecond: 25 },
    ],
  );
  // A child the guardian dispatched carries the same clocks, but it keeps the envelope boundary,
  // so the turn recorded at the guardian's opening second is history it copied.
  const dispatchedRecords = lateOpeningRollout(
    'late-dispatched',
    {
      thread_source: 'subagent',
      source: { subagent: { thread_spawn: { parent_thread_id: guardianId, agent_path: '/root/review_sol' } } },
    },
    [
      { turnId: 'guardian-first', second: 4, input: 12, endSecond: 18 },
      { turnId: 'dispatched-own', second: 20, input: 14, endSecond: 25 },
    ],
  );
  const cases = [
    { id: guardianId, records: guardianRecords, turns: ['guardian-first', 'guardian-second'], inputs: [12, 13] },
    { id: 'late-dispatched', records: dispatchedRecords, turns: ['dispatched-own'], inputs: [14] },
    {
      id: 'user-fork',
      records: lateOpeningRollout('user-fork', { source: 'vscode', thread_source: 'user', forked_from_id: 'sess' }, [
        { turnId: 'guardian-first', second: 4, input: 12, endSecond: 18 },
        { turnId: 'fork-own', second: 20, input: 14, endSecond: 25 },
      ]),
      turns: ['fork-own'],
      inputs: [14],
    },
  ];
  for (const { id, records, turns, inputs } of cases) {
    const reducer = createCodexUsageLineReducer();
    assert.deepEqual(
      records.flatMap((record) => reducer.pushLine(JSON.stringify(record))).map((request) => request.usage.input),
      inputs,
      id,
    );
    const file = writeRollout(records);
    assert.deepEqual(
      readCodexSession(file, id).turns.map((turn) => turn.promptId),
      turns,
      id,
    );
    const spend = readCodexAgentSpend(file);
    assert.deepEqual(
      [
        spend.models.reduce((total, model) => total + (model.usage.requests ?? 0), 0),
        spend.models.reduce((total, model) => total + model.usage.input, 0),
      ],
      [inputs.length, inputs.reduce((total, input) => total + input, 0)],
      id,
    );
    const ledgerFile = path.join(tempDir('codex-late-opening-spend-'), 'rollout.jsonl');
    fs.copyFileSync(file, ledgerFile);
    const indexed = indexSpendFile(undefined, ledgerFile, 'workspace', createCodexUsageLineReducer, 1).record;
    assert.equal(indexed.turnCount, turns.length, id);
    assert.deepEqual(
      [
        (indexed.lifetimeBuckets ?? []).reduce((total, bucket) => total + bucket.requests, 0),
        (indexed.lifetimeBuckets ?? []).reduce((total, bucket) => total + bucket.usage.input, 0),
      ],
      [inputs.length, inputs.reduce((total, input) => total + input, 0)],
      id,
    );
  }

  // The row counts from the guardian's payload clock to the end of its last turn, which is longer
  // than either the span from its late opening record or the last turn's recorded duration.
  const guardianFile = writeRollout(guardianRecords);
  const guardianMeta = readCodexSessionMeta(guardianFile);
  const child: CodexSubagentFile = {
    file: guardianFile,
    threadId: guardianId,
    parentThreadId: 'sess',
    agentPath: null,
    openedAt: guardianMeta?.openedAt ?? null,
    startedAt: guardianMeta?.startedAt ?? null,
    threadSource: guardianMeta?.threadSource ?? null,
    backgroundReview: true,
  };
  const parent = writeRollout([
    meta({ id: 'sess', session_id: 'sess' }),
    event('task_started', 1, { turn_id: TURN, model_context_window: 258400 }),
    turnContext(2, TURN, 'gpt-5.6-sol', 'high'),
    event('user_message', 3, { message: 'commit the change' }),
    event('task_complete', 30, { turn_id: TURN, last_agent_message: 'committed' }),
  ]);
  const [turn] = readCodexSession(parent, 'sess', { structuralChildren: [child] }).turns;
  assert.deepEqual(
    turn.agents.map((row) => [row.description, row.status, row.durationMs]),
    [['Background review', 'completed', ms(25) + 5 - (ms(4) + 710)]],
  );
});

test('a child that has only replayed parent history keeps the time since its opening record', () => {
  const childId = 'replay-only-child';
  const opened = ms(4);
  const written = (extra: number) => new Date(opened + extra).toISOString();
  const file = writeRollout([
    recordedAt(
      meta({
        id: childId,
        session_id: childId,
        thread_source: 'subagent',
        source: { subagent: { thread_spawn: { parent_thread_id: 'sess', agent_path: '/root/worker' } } },
        model_provider: 'openai',
      }),
      written(0),
    ),
    recordedAt(event('task_started', 0, { turn_id: 'parent-turn', started_at: ms(1) / 1000 }), written(1)),
    recordedAt(turnContext(0, 'parent-turn', 'gpt-5.6-sol', 'high'), written(2)),
    recordedAt(event('user_message', 0, { message: 'inherited prompt' }), written(3)),
    recordedAt(
      event('task_complete', 0, { turn_id: 'parent-turn', last_agent_message: 'inherited', duration_ms: 60_000 }),
      written(5),
    ),
  ]);
  const childMeta = readCodexSessionMeta(file);
  const child: CodexSubagentFile = {
    file,
    threadId: childId,
    parentThreadId: 'sess',
    agentPath: '/root/worker',
    openedAt: childMeta?.openedAt ?? null,
    startedAt: childMeta?.startedAt ?? null,
    threadSource: childMeta?.threadSource ?? null,
    backgroundReview: false,
  };
  const [turn] = readCodexSession(writeRollout(ordinaryTurn()), 'sess', { structuralChildren: [child] }).turns;
  assert.deepEqual(
    turn.agents.map((row) => [row.id, row.durationMs]),
    [[childId, 5]],
  );
});

test('a legacy guardian header keeps the background review label on its parent turn', () => {
  const child = structuralChild('sess', 'legacy-guardian-child', 4, 'completed', 'subagent');
  const [row] = readCodexSession(writeRollout(ordinaryTurn()), 'sess', {
    structuralChildren: [child],
  }).turns[0].agents;
  assert.equal(row.description, 'Background review');
});

test('header-only child status comes from the child tail', () => {
  for (const [lifecycle, expected] of [
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['interrupted', 'interrupted'],
    ['running', 'running'],
  ] as const) {
    const child = structuralChild('sess', `${lifecycle}-child`, 4, lifecycle);
    const [row] = readCodexSession(writeRollout(ordinaryTurn()), 'sess', {
      structuralChildren: [child],
    }).turns[0].agents;
    assert.equal(row.status, expected);
  }
});

test('a header-only child remains completed when its turn start is outside the tail', () => {
  const child = structuralChild('sess', 'large-child');
  const records = fs.readFileSync(child.file, 'utf8').trimEnd().split('\n');
  records.splice(-1, 0, JSON.stringify({ type: 'noise', payload: 'x'.repeat(300 * 1024) }));
  fs.writeFileSync(child.file, `${records.join('\n')}\n`);
  const [row] = readCodexSession(writeRollout(ordinaryTurn()), 'sess', {
    structuralChildren: [child],
  }).turns[0].agents;
  assert.equal(row.status, 'completed');
  assert.equal(row.durationMs, 8_000);
});

test('oversized terminal child records still settle header-only lifecycle', () => {
  for (const [kind, expected] of [
    ['task_complete', 'completed'],
    ['turn_aborted', 'interrupted'],
  ] as const) {
    const child = structuralChild('sess', `oversized-${kind}`, 4, 'running');
    const terminal =
      kind === 'task_complete'
        ? event(kind, 12, {
            turn_id: `${child.threadId}-turn`,
            last_agent_message: 'x'.repeat(300 * 1024),
          })
        : event(kind, 12, {
            turn_id: `${child.threadId}-turn`,
            reason: 'x'.repeat(300 * 1024),
          });
    assert.ok(Buffer.byteLength(JSON.stringify(terminal)) > 256 * 1024);
    fs.appendFileSync(child.file, `${JSON.stringify(terminal)}\n`);
    const [row] = readCodexSession(writeRollout(ordinaryTurn()), 'sess', {
      structuralChildren: [child],
    }).turns[0].agents;
    assert.equal(row.status, expected);
    assert.equal(row.durationMs, 8_000);
  }
});

test('cut-record recovery has a fixed byte budget', () => {
  const child = structuralChild('sess', 'bounded-child', 4, 'running');
  fs.appendFileSync(child.file, `${JSON.stringify({ type: 'noise', payload: 'x'.repeat(2 * 1024 * 1024) })}\n`);
  let calls = 0;
  let requestedBytes = 0;
  structuralAgentStatus(child, (_file, cursor, bytes) => {
    calls += 1;
    requestedBytes += bytes;
    return {
      lines: [],
      cursor: {
        revision: cursor.revision,
        end: Math.max(0, cursor.end - bytes),
        fragment: Buffer.alloc(0),
      },
    };
  });
  assert.equal(calls, 4);
  assert.equal(requestedBytes, 1024 * 1024);
});

test('an abort remains terminal when a header-only child reports a delayed completion', () => {
  const child = structuralChild('sess', 'aborted-child', 4, 'running');
  const aborted = event('turn_aborted', 12, {
    turn_id: `${child.threadId}-turn`,
    reason: 'x'.repeat(300 * 1024),
  });
  assert.ok(Buffer.byteLength(JSON.stringify(aborted)) > 256 * 1024);
  fs.appendFileSync(child.file, `${JSON.stringify(aborted)}\n`);
  fs.appendFileSync(
    child.file,
    `${JSON.stringify(
      event('task_complete', 14, {
        turn_id: `${child.threadId}-turn`,
        last_agent_message: 'late completion',
      }),
    )}\n`,
  );
  const [row] = readCodexSession(writeRollout(ordinaryTurn()), 'sess', {
    structuralChildren: [child],
  }).turns[0].agents;
  assert.equal(row.status, 'interrupted');
  assert.equal(row.durationMs, 8_000);
});

test('an older completion cannot close a newer header-only child turn', () => {
  const child = structuralChild('sess', 'restarted-child', 4, 'interrupted');
  fs.appendFileSync(
    child.file,
    `${JSON.stringify(
      event('task_started', 20, {
        turn_id: 'new-turn',
      }),
    )}\n`,
  );
  fs.appendFileSync(
    child.file,
    `${JSON.stringify(
      event('task_complete', 22, {
        turn_id: `${child.threadId}-turn`,
        last_agent_message: 'late completion',
      }),
    )}\n`,
  );
  const [row] = readCodexSession(writeRollout(ordinaryTurn()), 'sess', {
    structuralChildren: [child],
  }).turns[0].agents;
  assert.equal(row.status, 'running');
  assert.equal(row.durationMs, null);
});

test('the newest empty child turn keeps a header-only child running', () => {
  const child = structuralChild('sess', 'resumed-child');
  fs.appendFileSync(child.file, `${JSON.stringify(event('task_started', 20, { turn_id: 'new-turn' }))}\n`);
  const [row] = readCodexSession(writeRollout(ordinaryTurn()), 'sess', {
    structuralChildren: [child],
  }).turns[0].agents;
  assert.equal(row.status, 'running');
  assert.equal(row.durationMs, null);
});

test('retained turns refresh when only a structural child rollout completes', () => {
  const child = structuralChild('sess', 'retained-child', 4, 'running');
  const read = readCodexSession(writeRollout(ordinaryTurn()), 'sess', {
    structuralChildren: [child],
  });
  assert.equal(read.turns[0].agents[0].status, 'running');
  fs.appendFileSync(
    child.file,
    `${JSON.stringify(
      event('task_complete', 12, {
        turn_id: `${child.threadId}-turn`,
        last_agent_message: 'reviewed',
      }),
    )}\n`,
  );
  refreshCodexStructuralAgents(read.turns, 'sess', [child], (agent) =>
    agent.id === child.threadId
      ? readCodexAgentSpend(child.file)
      : { models: [], found: false, partial: false, effort: null },
  );
  assert.deepEqual(
    {
      status: read.turns[0].agents[0].status,
      spendFound: read.turns[0].agents[0].spendFound,
      model: read.turns[0].agents[0].spend[0]?.model,
    },
    { status: 'completed', spendFound: true, model: 'codex-auto-review' },
  );
});

test('parent-recorded children keep their identity while child tails settle stale open rows', () => {
  const current = namedStructuralChild('sess', 'current-child', '/root/worker');
  const currentRecords = ordinaryTurn();
  currentRecords.splice(
    5,
    0,
    ...currentSpawn('current-spawn', current.threadId),
    currentChildNotification(7, current.threadId, { completed: 'finished' }),
  );
  const currentRead = readCodexSession(writeRollout(currentRecords), 'sess', {
    structuralChildren: [current],
    agentSpendOf: (agent) =>
      agent.id === current.threadId
        ? readCodexAgentSpend(current.file)
        : { models: [], found: false, partial: false, effort: null },
  });
  const currentAgents = currentRead.turns[0].agents;
  assert.deepEqual(
    currentAgents.map((agent) => ({
      description: agent.description,
      status: agent.status,
      durationMs: agent.durationMs,
      spendFound: agent.spendFound,
      effort: agent.effort,
    })),
    [{ description: 'Laplace', status: 'completed', durationMs: 8_000, spendFound: true, effort: 'high' }],
  );
  const duration = toCard(currentRead.turns[0], true).agents[0].figures.find((figure) => figure.metric === 'duration');
  assert.equal(duration?.compactLabel, '8s');
  assert.equal(duration?.name, 'Ran for 8s');
  const retained = structuredClone(currentRead.turns);
  refreshCodexStructuralAgents(retained, 'sess', [current]);
  assert.equal(retained[0].agents[0].durationMs, 8_000);

  fs.appendFileSync(current.file, `${JSON.stringify(event('task_started', 20, { turn_id: 'resumed-turn' }))}\n`);
  refreshCodexStructuralAgents(retained, 'sess', [current]);
  assert.equal(retained[0].agents[0].status, 'completed');
  assert.equal(retained[0].agents[0].durationMs, null);
  assert.equal(
    toCard(retained[0], true).agents[0].figures.some((figure) => figure.metric === 'duration'),
    false,
  );

  fs.appendFileSync(current.file, `${JSON.stringify(event('task_complete', 24, { turn_id: 'resumed-turn' }))}\n`);
  refreshCodexStructuralAgents(retained, 'sess', [current]);
  assert.equal(retained[0].agents[0].durationMs, 20_000);

  const recorded = structuredClone(currentRead.turns);
  recorded[0].agents[0].durationMs = 3_000;
  recorded[0].agents[0].codexStructuralBase!.durationMs = 3_000;
  refreshCodexStructuralAgents(recorded, 'sess', [current]);
  assert.equal(recorded[0].agents[0].durationMs, 3_000);

  for (const incomplete of [
    structuralChild('sess', current.threadId, 4, 'running'),
    { ...current, startedAt: null },
    { ...current, startedAt: ms(25) },
  ]) {
    const [turn] = readCodexSession(writeRollout(currentRecords), 'sess', { structuralChildren: [incomplete] }).turns;
    assert.equal(turn.agents[0].status, 'completed');
    assert.equal(turn.agents[0].durationMs, null);
    assert.equal(
      toCard(turn, true).agents[0].figures.some((figure) => figure.metric === 'duration'),
      false,
    );
  }

  const legacy = structuralChild('sess', 'legacy-child');
  const legacyRecords = ordinaryTurn();
  legacyRecords.splice(
    5,
    0,
    item('function_call', 4, {
      name: 'spawn_agent',
      call_id: 'legacy-spawn',
      arguments: JSON.stringify({ task_name: 'review_sol' }),
    }),
    event('sub_agent_activity', 5, {
      event_id: 'legacy-spawn',
      agent_thread_id: legacy.threadId,
      agent_path: '/root/review_sol',
      kind: 'started',
    }),
  );
  const legacyAgents = readCodexSession(writeRollout(legacyRecords), 'sess', {
    structuralChildren: [legacy],
    agentSpendOf: (agent) =>
      agent.id === legacy.threadId
        ? readCodexAgentSpend(legacy.file)
        : { models: [], found: false, partial: false, effort: null },
  }).turns[0].agents;
  assert.deepEqual(
    legacyAgents.map((agent) => ({
      description: agent.description,
      status: agent.status,
      spendFound: agent.spendFound,
      effort: agent.effort,
    })),
    [{ description: 'review_sol', status: 'completed', spendFound: true, effort: 'medium' }],
  );
});

test('retained inferred Codex rows restore the spawn clock when child evidence changes', () => {
  const child = {
    ...structuralChild('sess', 'clock-child', 6, 'running', 'subagent'),
    agentPath: '/root/review_sol',
    backgroundReview: false,
  };
  const parent = writeRollout([
    meta(),
    event('task_started', 1, { turn_id: TURN }),
    turnContext(2, TURN, 'gpt-5.6-sol', 'high'),
    event('user_message', 3, { message: 'review' }),
    item('function_call', 4, {
      name: 'spawn_agent',
      call_id: 'clock-spawn',
      arguments: JSON.stringify({ task_name: 'review_sol' }),
    }),
    item('function_call_output', 5, {
      call_id: 'clock-spawn',
      output: JSON.stringify({ task_name: '/root/review_sol' }),
    }),
  ]);
  const replacement = { ...child, threadId: 'replacement-child', startedAt: ms(8) };
  const transitions: [CodexSubagentFile[], number][] = [
    [[{ ...child, startedAt: null }], ms(4)],
    [[], ms(4)],
    [[child, replacement], ms(4)],
    [[replacement], ms(8)],
  ];
  for (const serialized of [true, false]) {
    for (const [catalog, expected] of transitions) {
      let retained = readCodexSession(parent, 'sess', { structuralChildren: [child] }).turns;
      const since = (turns: typeof retained) => toCard(turns[0], true, ms(20), [], null, true).agents[0].since;
      assert.equal(retained[0].agents[0].codexInferredId, true);
      assert.equal(since(retained), ms(6));
      if (serialized) retained = structuredClone(retained);
      refreshCodexStructuralAgents(retained, 'sess', catalog);
      const fresh = readCodexSession(parent, 'sess', { structuralChildren: catalog }).turns;
      assert.equal(since(fresh), expected);
      assert.equal(since(retained), expected, `serialized: ${serialized}, children: ${catalog.length}`);
      if (expected === ms(8)) {
        if (serialized) retained = structuredClone(retained);
        refreshCodexStructuralAgents(retained, 'sess', []);
        assert.equal(since(retained), ms(4));
      }
    }
  }
});

test('retained parent-recorded children restore parent facts when child state changes', () => {
  const child = structuralChild('sess', 'reversible-child', 4, 'running');
  const records = ordinaryTurn();
  records.splice(
    5,
    0,
    item('function_call', 4, {
      name: 'spawn_agent',
      call_id: 'reversible-spawn',
      arguments: JSON.stringify({ task_name: 'review_sol' }),
    }),
    event('sub_agent_activity', 5, {
      event_id: 'reversible-spawn',
      agent_thread_id: child.threadId,
      agent_path: '/root/review_sol',
      kind: 'started',
    }),
  );
  const lookup = (agent: { id: string | null; status: string }) => {
    const open = agent.status === 'running' || agent.status === 'async_launched' || agent.status === 'launched';
    return agent.id === child.threadId && !open
      ? readCodexAgentSpend(child.file)
      : { models: [], found: false, partial: false, effort: null };
  };
  const read = readCodexSession(writeRollout(records), 'sess', {
    structuralChildren: [child],
    agentSpendOf: lookup,
  });
  assert.deepEqual(
    {
      description: read.turns[0].agents[0].description,
      status: read.turns[0].agents[0].status,
      spendFound: read.turns[0].agents[0].spendFound,
    },
    { description: 'review_sol', status: 'launched', spendFound: false },
  );

  fs.appendFileSync(
    child.file,
    `${JSON.stringify(
      event('task_complete', 12, {
        turn_id: `${child.threadId}-turn`,
        last_agent_message: 'reviewed',
      }),
    )}\n`,
  );
  refreshCodexStructuralAgents(read.turns, 'sess', [child], lookup);
  assert.deepEqual(
    {
      status: read.turns[0].agents[0].status,
      spendFound: read.turns[0].agents[0].spendFound,
    },
    { status: 'completed', spendFound: true },
  );

  fs.appendFileSync(
    child.file,
    `${JSON.stringify(
      event('task_started', 20, {
        turn_id: 'resumed-turn',
      }),
    )}\n`,
  );
  refreshCodexStructuralAgents(read.turns, 'sess', [child], lookup);
  assert.deepEqual(
    {
      status: read.turns[0].agents[0].status,
      spendFound: read.turns[0].agents[0].spendFound,
    },
    { status: 'launched', spendFound: false },
  );

  refreshCodexStructuralAgents(read.turns, 'sess', [], lookup);
  assert.deepEqual(
    read.turns[0].agents.map((agent) => ({
      description: agent.description,
      status: agent.status,
      spendFound: agent.spendFound,
      childSessionId: agent.childSessionId,
    })),
    [{ description: 'review_sol', status: 'launched', spendFound: false, childSessionId: undefined }],
  );
});

test('only direct structural children attach to the parent turn', () => {
  const direct = structuralChild('sess', 'direct-child');
  const grandchild = structuralChild(direct.threadId, 'grandchild');
  const agents = readCodexSession(writeRollout(ordinaryTurn()), 'sess', {
    structuralChildren: [direct, grandchild],
  }).turns[0].agents;
  assert.deepEqual(
    agents.map((agent) => agent.id),
    [direct.threadId],
  );
});

test('a structural child opened after an unterminated turn activity stays with that turn', () => {
  const first = 'unterminated-turn';
  const second = 'next-turn';
  const records = [
    meta({ id: 'sess' }),
    event('task_started', 1, { turn_id: first }),
    event('user_message', 2, { message: 'first' }),
    event('task_started', 10, { turn_id: second }),
    event('user_message', 11, { message: 'second' }),
    event('task_complete', 15, { turn_id: second, last_agent_message: 'done' }),
  ];
  const child = structuralChild('sess', 'between-turns-child', 6);
  const turns = readCodexSession(writeRollout(records), 'sess', {
    structuralChildren: [child],
  }).turns;
  assert.deepEqual(
    turns.find((turn) => turn.promptId === first)?.agents.map((agent) => agent.id),
    [child.threadId],
  );
  assert.deepEqual(turns.find((turn) => turn.promptId === second)?.agents, []);
});

test('semantic history attaches a structural child only to its matching older turn', () => {
  const older = 'older-turn';
  const newer = 'newer-turn';
  const records = [
    meta({ id: 'sess' }),
    event('task_started', 1, { turn_id: older }),
    event('user_message', 2, { message: 'older' }),
    event('task_complete', 8, { turn_id: older, last_agent_message: 'older done' }),
    event('task_started', 20, { turn_id: newer }),
    event('user_message', 21, { message: 'newer' }),
    event('task_complete', 25, { turn_id: newer, last_agent_message: 'newer done' }),
  ];
  const file = writeRollout(records);
  const child = structuralChild('sess', 'older-child', 4);
  const result = readCodexHistoryPage(
    file,
    'sess',
    null,
    {
      chunkBytes: fs.statSync(file).size,
      targetTurns: 2,
    },
    { structuralChildren: [child] },
  );
  assert.equal(result.kind, 'page');
  const turns = result.page?.turns ?? [];
  assert.deepEqual(
    turns.find((turn) => turn.promptId === older)?.agents.map((agent) => agent.id),
    [child.threadId],
  );
  assert.deepEqual(turns.find((turn) => turn.promptId === newer)?.agents, []);
});

test('semantic history does not attach a later child to its final unterminated turn', () => {
  const records = [
    meta({ id: 'sess' }),
    event('task_started', 1, { turn_id: 'completed-turn' }),
    event('user_message', 2, { message: 'completed' }),
    event('task_complete', 4, { turn_id: 'completed-turn', last_agent_message: 'done' }),
    event('task_started', 10, { turn_id: 'unterminated-turn' }),
    event('user_message', 11, { message: 'older' }),
    event('task_started', 20, { turn_id: 'open-turn' }),
    event('user_message', 21, { message: 'current' }),
  ];
  const file = writeRollout(records);
  const child = structuralChild('sess', 'later-child', 22);
  const result = readCodexHistoryPage(
    file,
    'sess',
    null,
    {
      chunkBytes: fs.statSync(file).size,
      targetTurns: 1,
    },
    { structuralChildren: [child] },
  );
  assert.equal(result.kind, 'page');
  const turns = result.page?.turns ?? [];
  assert.deepEqual(
    turns.map((turn) => turn.promptId),
    ['unterminated-turn'],
  );
  assert.deepEqual(
    turns.flatMap((turn) => turn.agents),
    [],
  );
});

test('a multi-agent spawn keeps its current identity, completion, and child spend', () => {
  const childId = 'current-child';
  const records = ordinaryTurn();
  records.splice(
    5,
    0,
    ...currentSpawn('current-spawn', childId),
    currentChildNotification(7, childId, { completed: 'finished' }),
  );
  const spend = [
    {
      model: 'gpt-5.6-sol',
      usage: { input: 1, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 2, output: 3, thinking: 1 },
    },
  ];
  const [parsed] = readCodexSession(writeRollout(records), 'sess', {
    agentSpendOf: (agent) => ({
      models: agent.id === childId ? spend : [],
      found: agent.id === childId,
      partial: false,
      effort: null,
    }),
  }).turns;
  assert.deepEqual(
    parsed.agents.map((agent) => ({
      id: agent.id,
      description: agent.description,
      status: agent.status,
      effort: agent.effort,
      spend: agent.spend,
    })),
    [{ id: childId, description: 'Laplace', status: 'completed', effort: 'high', spend }],
  );
  assert.equal(parsed.steps.find((step) => step.id === 'current-spawn')?.status, 'done');
  assert.deepEqual(
    parsed.failures.filter((failure) => failure.tool === 'spawn_agent'),
    [],
  );
});

test('a malformed current spawn output waits for its later CollabAgentToolCall identity', () => {
  const childId = 'fallback-child';
  const [call, completed] = currentSpawn('fallback-spawn', childId, 'Euler', false);
  const malformed = item('function_call_output', 5, { call_id: 'fallback-spawn', output: '{}' });
  const records = ordinaryTurn();
  records.splice(5, 0, call, malformed, completed, currentChildNotification(7, childId, { completed: 'finished' }));
  const spend = [
    {
      model: 'gpt-5.6-sol',
      usage: { input: 2, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 3, output: 5, thinking: 7 },
    },
  ];
  const options = {
    agentSpendOf: (agent) => ({
      models: agent.id === childId ? spend : [],
      found: agent.id === childId,
      partial: false,
      effort: null,
    }),
  } satisfies Parameters<typeof createCodexSessionReducer>[1];
  let reducer = createCodexSessionReducer('sess', options);
  for (const record of records) {
    reducer.pushLine(JSON.stringify(record));
    if (record === malformed) {
      reducer = createCodexSessionReducer('sess', options, null, reducer.snapshot());
    }
  }
  const [parsed] = reducer.finish().turns;
  assert.deepEqual(
    parsed.agents.map((agent) => ({
      id: agent.id,
      description: agent.description,
      status: agent.status,
      effort: agent.effort,
      spend: agent.spend,
    })),
    [{ id: childId, description: 'Euler', status: 'completed', effort: 'high', spend }],
  );
  assert.deepEqual(
    parsed.failures.filter((failure) => failure.tool === 'spawn_agent'),
    [],
  );
});

test('a multi-agent closed current spawn with malformed output retains only its public launch row', () => {
  const [call] = currentSpawn('closed-spawn', 'unused-child', 'Unused', false);
  const malformed = item('function_call_output', 5, { call_id: 'closed-spawn', output: '{}' });
  const records = ordinaryTurn();
  records.splice(5, 0, call, malformed);
  const reducer = createCodexSessionReducer('sess');
  for (const record of records) {
    reducer.pushLine(JSON.stringify(record));
  }
  const snapshot = reducer.snapshot();
  assert.equal(snapshot.currentSpawns.size, 0);
  assert.deepEqual(
    snapshot.turns[0].agents.map((agent) => ({
      id: agent.id,
      description: agent.description,
      status: agent.status,
      effort: agent.effort,
    })),
    [{ id: null, description: 'agent', status: 'launched', effort: 'medium' }],
  );
  const restored = createCodexSessionReducer('sess', {}, null, snapshot);
  assert.equal(restored.snapshot().currentSpawns.size, 0);
  assert.deepEqual(restored.read().turns, reducer.read().turns);
});

test('multi-agent notifications are strict and terminal state does not downgrade', () => {
  const childId = 'terminal-child';
  const records = ordinaryTurn();
  records.splice(
    5,
    0,
    ...currentSpawn('terminal-spawn', childId),
    message(
      'user',
      7,
      `<subagent_notification>${JSON.stringify({ agent_path: childId, status: { completed: 'ignored' } })}</subagent_notification>`,
      'input_text',
      ['user.text'],
    ),
    currentChildNotification(8, childId, { completed: 'finished' }),
    currentChildNotification(9, childId, 'shutdown'),
  );
  const [parsed] = readCodexSession(writeRollout(records), 'sess').turns;
  assert.equal(parsed.agents[0].status, 'completed');

  const malformed = ordinaryTurn();
  malformed.splice(
    5,
    0,
    ...currentSpawn('strict-spawn', 'strict-child'),
    message(
      'user',
      7,
      `<subagent_notification>${JSON.stringify({ agent_path: 'strict-child', status: { completed: 'ignored' } })}</subagent_notification>`,
      'input_text',
      ['user.text'],
    ),
    currentChildNotification(8, 'strict-child', 'shutdown'),
  );
  assert.equal(readCodexSession(writeRollout(malformed), 'sess').turns[0].agents[0].status, 'interrupted');

  for (const [status, expected] of [
    [{ errored: 'nope' }, 'failed'],
    ['shutdown', 'interrupted'],
  ] as const) {
    const terminal = ordinaryTurn();
    terminal.splice(
      5,
      0,
      ...currentSpawn(`terminal-${expected}`, `${expected}-child`),
      currentChildNotification(7, `${expected}-child`, status),
    );
    const [row] = readCodexSession(writeRollout(terminal), 'sess').turns[0].agents;
    assert.equal(row.status, expected);
  }
});

test('multi-agent fallback identity deduplicates successes and retains a real spawn failure', () => {
  const records: object[] = [
    meta(),
    event('task_started', 1, { turn_id: TURN }),
    turnContext(2, TURN, 'gpt-5.6-sol', 'high'),
    event('user_message', 3, { message: 'review' }),
  ];
  for (let index = 0; index < 12; index++) {
    const callId = `spawn-${index}`;
    const childId = `child-${index}`;
    records.push(
      ...currentSpawn(callId, childId, `Agent ${index}`, index !== 0),
      currentChildNotification(10 + index, childId, { completed: 'done' }),
    );
  }
  records.push(
    item('function_call', 30, { name: 'spawn_agent', namespace: 'multi_agent_v1', call_id: 'limit', arguments: '{}' }),
    item('function_call_output', 31, { call_id: 'limit', output: 'collab spawn failed: agent thread limit reached' }),
    event('task_complete', 32, { turn_id: TURN, last_agent_message: 'reviewed' }),
  );
  const file = writeRollout(records);
  const parsed = readCodexSession(file, 'sess');
  assert.equal(parsed.turns[0].agents.length, 12);
  assert.deepEqual(
    parsed.turns[0].agents.map((agent) => agent.id),
    Array.from({ length: 12 }, (_, index) => `child-${index}`),
  );
  assert.deepEqual(
    parsed.turns[0].failures.filter((failure) => failure.tool === 'spawn_agent'),
    [
      {
        tool: 'spawn_agent',
        message: 'collab spawn failed: agent thread limit reached',
      },
    ],
  );
  const page = readCodexHistoryPage(file, 'sess', null, { chunkBytes: fs.statSync(file).size, targetTurns: 1 });
  assert.equal(page.kind, 'page');
  assert.deepEqual(page.page?.turns, parsed.turns);
});

test('a compaction is reported with the context it stood at, and claims no summary of its own', () => {
  const records = ordinaryTurn();
  records.push({
    timestamp: at(9),
    type: 'compacted',
    payload: {
      message: '',
      replacement_history: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the parser' }] },
      ],
      window_number: 2,
    },
  });
  const { compactions } = readCodexSession(writeRollout(records), 'sess');
  assert.equal(compactions.length, 1);
  assert.equal(compactions[0].at, ms(9));
  assert.equal(compactions[0].contextBefore, 20003);
  assert.equal(compactions[0].model, 'gpt-5.6-sol');
  // Codex replaces the history with the user's own earlier prompts, so there is no summary
  // text to draw and the card must not invent one.
  assert.equal(compactions[0].summary, '');
});

test('a recent Codex compaction explains every priced exact request category', () => {
  const records = ordinaryTurn();
  records[0] = meta({ model_provider: 'openai' });
  records[2] = turnContext(2, TURN, 'gpt-6-astra', 'high');
  records.push(
    event('thread_settings_applied', 9, {
      thread_settings: { model_provider_id: 'openai', service_tier: 'standard' },
    }),
    {
      timestamp: at(10),
      type: 'compacted',
      payload: {
        message: '',
        replacement_history: [],
        window_number: 2,
        latest_token_usage_record: {
          usage: usage({
            input_tokens: 250_451,
            cached_input_tokens: 28_416,
            cache_write_input_tokens: 1_234,
            output_tokens: 7_591,
            reasoning_output_tokens: 0,
          }),
        },
      },
    },
    event('thread_settings_applied', 11, {
      thread_settings: { model: 'gpt-6-astra', model_provider_id: 'openai', service_tier: 'standard' },
    }),
  );
  const [compaction] = readCodexSession(writeRollout(records), 'sess').compactions;
  assert.deepEqual(compaction.usage, {
    requests: 1,
    input: 220_801,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheWrite30m: 1_234,
    cacheRead: 28_416,
    output: 7_591,
    thinking: 0,
  });
  assert.equal(compaction.contextBefore, 250_451);
  assert.deepEqual(
    {
      model: compaction.model,
      provider: compaction.provider,
      contextWindow: compaction.contextWindow,
      inferenceClass: compaction.inferenceClass,
      serviceTier: compaction.serviceTier,
    },
    {
      model: 'gpt-6-astra',
      provider: 'openai',
      contextWindow: 258400,
      inferenceClass: null,
      serviceTier: 'standard',
    },
  );
  const cost = toCompactionCard(compaction).chips.find((chip) => chip.label.startsWith('$'));
  assert.equal(cost?.label, '$2.63');
  assert.match(cost?.detail ?? '', /Exact request usage priced at the recorded model and provider context\./);
  assert.match(cost?.detail ?? '', /8k output\./);
  assert.match(cost?.detail ?? '', /30-minute cache writes: 1,234 tokens\./);
});

test('a Codex compaction takes its model from the settings record that follows it', () => {
  const records = [
    meta({ model_provider: 'openai' }),
    event('task_started', 1, { turn_id: TURN, model_context_window: 258400 }),
    turnContext(1, TURN, 'gpt-6-astra', 'high'),
    event('thread_settings_applied', 1, {
      thread_settings: { model: 'gpt-6-astra', model_provider_id: 'openai', service_tier: 'priority' },
    }),
    {
      timestamp: at(2),
      type: 'compacted',
      payload: {
        message: '',
        replacement_history: [],
        window_number: 2,
        latest_token_usage_record: {
          usage: usage({
            input_tokens: 152_584,
            cached_input_tokens: 12_160,
            output_tokens: 1_442,
          }),
        },
      },
    },
    event('thread_settings_applied', 3, {
      thread_settings: { model: 'gpt-5.6-sol', model_provider_id: 'openai', service_tier: 'default' },
    }),
  ];

  const reducer = createCodexSessionReducer('sess');
  for (const record of records.slice(0, 5)) {
    reducer.pushLine(JSON.stringify(record));
  }
  const [checkpoint] = reducer.read().compactions;
  assert.equal(checkpoint.contextBefore, 152_584);
  assert.deepEqual(checkpoint.usage, {
    requests: 1,
    input: 140_424,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheWrite30m: 0,
    cacheRead: 12_160,
    output: 1_442,
    thinking: 0,
  });
  assert.equal(checkpoint.model, null);
  assert.equal(
    toCompactionCard(checkpoint).chips.some((chip) => chip.label.startsWith('$')),
    false,
  );
  const resumed = createCodexSessionReducer('sess', {}, null, reducer.snapshot());
  resumed.pushLine(JSON.stringify(records[5]));
  const [compaction] = resumed.read().compactions;
  assert.equal(compaction.contextBefore, 152_584);
  assert.equal(compaction.model, 'gpt-5.6-sol');
  assert.equal(toCompactionCard(compaction).chips.find((chip) => chip.label.startsWith('$'))?.label, '$0.60');
});

test('a Codex checkpoint does not price a compaction from billing identity outside its tail', () => {
  const earlierSettings = event('thread_settings_applied', 1, {
    thread_settings: { model: 'gpt-6-astra', model_provider_id: 'openai', service_tier: 'priority' },
  });
  const compacted = {
    timestamp: at(2),
    type: 'compacted',
    payload: {
      message: '',
      replacement_history: [],
      window_number: 2,
      latest_token_usage_record: { usage: usage({ input_tokens: 152_584, output_tokens: 1_442 }) },
    },
  };
  const followingSettings = event('thread_settings_applied', 3, {
    thread_settings: { model_provider_id: 'openai' },
  });
  const line = (record: unknown, start: number) => {
    const text = JSON.stringify(record);
    return { text, start, end: start + text.length };
  };
  const checkpoint = createCodexSessionReducer('sess');
  checkpoint.pushLine(line(earlierSettings, 0));
  checkpoint.pushLine(line(compacted, 1_000));
  checkpoint.trimBefore(1_000);
  checkpoint.pushLine(line(followingSettings, 2_000));

  const oneShot = createCodexSessionReducer('sess');
  oneShot.pushLine(line(compacted, 1_000));
  oneShot.pushLine(line(followingSettings, 2_000));
  const [incrementalCompaction] = checkpoint.read().compactions;
  const [tailCompaction] = oneShot.read().compactions;
  assert.deepEqual(incrementalCompaction, tailCompaction);
  assert.equal(
    toCompactionCard(incrementalCompaction).chips.some((chip) => chip.label.startsWith('$')),
    false,
  );
});

test('partial settings update a Codex compaction once without taking a later model', () => {
  const reducer = createCodexSessionReducer('sess');
  for (const record of [
    meta({ model_provider: 'openai' }),
    event('task_started', 1, { turn_id: TURN, model_context_window: 258400 }),
    turnContext(1, TURN, 'gpt-5.6-sol', 'high'),
    event('thread_settings_applied', 1, {
      thread_settings: { model: 'gpt-5.6-sol', model_provider_id: 'openai', service_tier: 'priority' },
    }),
    {
      timestamp: at(2),
      type: 'compacted',
      payload: {
        message: '',
        replacement_history: [],
        window_number: 2,
        latest_token_usage_record: { usage: usage({ input_tokens: 152_584, output_tokens: 1_442 }) },
      },
    },
    event('thread_settings_applied', 3, {
      thread_settings: { model_provider_id: 'openai', service_tier: 'default' },
    }),
    event('thread_settings_applied', 4, {
      thread_settings: { model: 'gpt-6-astra', model_provider_id: 'openai', service_tier: 'priority' },
    }),
  ]) {
    reducer.pushLine(JSON.stringify(record));
  }

  const [compaction] = reducer.read().compactions;
  assert.deepEqual(
    [compaction.model, compaction.provider, compaction.serviceTier],
    ['gpt-5.6-sol', 'openai', 'default'],
  );
  assert.equal(toCompactionCard(compaction).chips.find((chip) => chip.label.startsWith('$'))?.label, '$0.64');
});

test('a later turn model is not assigned to an earlier Codex compaction', () => {
  for (const boundary of [
    event('task_complete', 3, { turn_id: TURN, last_agent_message: '' }),
    event('task_started', 3, { turn_id: 'next-turn', model_context_window: 258400 }),
  ]) {
    const reducer = createCodexSessionReducer('sess');
    for (const record of [
      meta({ model_provider: 'openai' }),
      event('task_started', 1, { turn_id: TURN, model_context_window: 258400 }),
      {
        timestamp: at(2),
        type: 'compacted',
        payload: {
          message: '',
          replacement_history: [],
          window_number: 2,
          latest_token_usage_record: { usage: usage({ input_tokens: 152_584, output_tokens: 1_442 }) },
        },
      },
      boundary,
      event('thread_settings_applied', 4, {
        thread_settings: { model: 'gpt-5.6-sol', model_provider_id: 'openai', service_tier: 'default' },
      }),
    ]) {
      reducer.pushLine(JSON.stringify(record));
    }

    const [compaction] = reducer.read().compactions;
    assert.equal(compaction.model, null);
    assert.equal(
      toCompactionCard(compaction).chips.some((chip) => chip.label.startsWith('$')),
      false,
    );
  }
});

test('an older Codex compaction never prices cumulative counters as request usage', () => {
  const records = ordinaryTurn();
  records.push({
    timestamp: at(9),
    type: 'compacted',
    payload: {
      message: '',
      replacement_history: [],
      window_number: 2,
      turn_token_usage: usage({ input_tokens: 999_999, cached_input_tokens: 900_000, output_tokens: 90_000 }),
      latest_token_usage_record: { usage: null },
    },
  });
  const [compaction] = readCodexSession(writeRollout(records), 'sess').compactions;
  assert.equal(compaction.usage, undefined);
  assert.equal(compaction.contextBefore, 20_003);
  assert.equal(
    toCompactionCard(compaction).chips.some((chip) => chip.label.startsWith('$')),
    false,
  );
});

test('a current Codex compaction keeps the prior level only on the boundary', () => {
  const records = ordinaryTurn();
  records.push({
    timestamp: at(9),
    type: 'compacted',
    payload: {
      message: '',
      replacement_history: [{ type: 'compaction', encrypted_content: 'opaque' }],
      window_id: 'window-2',
      previous_window_id: 'window-1',
      window_number: 2,
    },
  });
  records.push(tokens(10, {}));
  const reducer = createCodexSessionReducer('sess');
  for (const record of records) {
    reducer.pushLine(JSON.stringify(record));
  }

  const state = reducer.snapshot();
  assert.equal(state.compactions[0].contextBefore, 20003);
  assert.equal(state.compactions[0].contextAfter, 0);
  assert.equal(state.compactions[0].summary, '');
  assert.equal(state.lastContext, 0);
  assert.equal(state.lastContextSource, null);
});

test('automatic compaction inside a turn clears its old level until a later request records one', () => {
  const firstTurn = '01a032c9-1e07-78b2-ae0c-dc76f2dd7902';
  const secondTurn = '01a032c9-1e07-78b2-ae0c-dc76f2dd7903';
  const records = [
    meta(),
    event('task_started', 1, { turn_id: firstTurn, model_context_window: 258400 }),
    turnContext(2, firstTurn, 'gpt-5.6-sol', 'high'),
    event('user_message', 3, { message: 'keep working' }),
    tokens(4, { input_tokens: 190000, cached_input_tokens: 180000, output_tokens: 8000 }),
    {
      timestamp: at(5),
      type: 'compacted',
      payload: {
        message: '',
        replacement_history: [{ type: 'compaction', encrypted_content: 'opaque' }],
        window_number: 2,
      },
    },
    tokens(6, {}),
    event('task_complete', 7, { turn_id: firstTurn, last_agent_message: 'continued' }),
    event('task_started', 8, { turn_id: secondTurn, model_context_window: 258400 }),
    turnContext(9, secondTurn, 'gpt-5.6-sol', 'high'),
    event('user_message', 10, { message: 'finish it' }),
    tokens(11, { input_tokens: 321, cached_input_tokens: 300, output_tokens: 10 }),
    event('task_complete', 12, { turn_id: secondTurn, last_agent_message: 'done' }),
  ];
  const reducer = createCodexSessionReducer('sess');
  for (const record of records) {
    reducer.pushLine(JSON.stringify(record));
  }

  const read = reducer.read();
  assert.deepEqual(
    read.turns.map((turn) => turn.contextTokens),
    [0, 321],
  );
  assert.equal(reducer.snapshot().lastContext, 321);
  assert.equal(
    nextTurnBasisOf(read.turns[0], read.compactions[0]),
    null,
    'the unknown Codex replacement context retained the prior next-turn estimate',
  );
  const basis = nextTurnBasisOf(read.turns[1], read.compactions[0]);
  assert.deepEqual(
    basis && {
      tokens: basis.tokens,
      outputTokens: basis.outputTokens,
      lastRequestAt: basis.lastRequestAt,
      afterCompaction: basis.afterCompaction,
    },
    { tokens: 321, outputTokens: 10, lastRequestAt: ms(11), afterCompaction: false },
  );
});

test('consecutive Codex compactions do not reuse the first boundary level', () => {
  const records = ordinaryTurn();
  records.push(
    { timestamp: at(9), type: 'compacted', payload: { message: '', replacement_history: [], window_number: 2 } },
    { timestamp: at(10), type: 'compacted', payload: { message: '', replacement_history: [], window_number: 3 } },
  );
  const { compactions } = readCodexSession(writeRollout(records), 'sess');
  assert.deepEqual(
    compactions.map((item) => item.contextBefore),
    [20003, 0],
  );
});

test('a model named after compaction cannot restore its earlier request as current context', () => {
  const records = [
    meta(),
    event('task_started', 1, { turn_id: TURN, model_context_window: 258400 }),
    event('user_message', 2, { message: 'keep working' }),
    tokens(3, { input_tokens: 190000, cached_input_tokens: 180000, output_tokens: 8000 }),
    {
      timestamp: at(4),
      type: 'compacted',
      payload: {
        message: '',
        replacement_history: [{ type: 'compaction', encrypted_content: 'opaque' }],
        window_number: 2,
      },
    },
    turnContext(5, TURN, 'gpt-5.6-sol', 'high'),
  ];
  const reducer = createCodexSessionReducer('sess');
  for (const record of records) {
    reducer.pushLine(JSON.stringify(record));
  }

  const afterDelayedModel = reducer.read();
  assert.equal(afterDelayedModel.compactions[0].contextBefore, 190000);
  assert.equal(afterDelayedModel.turns[0].usage.requests, 1);
  assert.equal(afterDelayedModel.turns[0].contextTokens, 0);
  assert.equal(reducer.snapshot().lastContext, 0);

  reducer.pushLine(JSON.stringify(tokens(6, { input_tokens: 321, cached_input_tokens: 300, output_tokens: 10 })));
  assert.equal(reducer.read().turns[0].contextTokens, 321);
  assert.equal(reducer.snapshot().lastContext, 321);
});

test('compaction uses pending context from the preceding turn after the next turn starts', () => {
  const firstTurn = '01a032c9-1e07-78b2-ae0c-dc76f2dd7902';
  const secondTurn = '01a032c9-1e07-78b2-ae0c-dc76f2dd7903';
  const records = [
    meta(),
    event('task_started', 1, { turn_id: firstTurn, model_context_window: 258400 }),
    event('user_message', 2, { message: 'keep working' }),
    tokens(3, { input_tokens: 190000, cached_input_tokens: 180000, output_tokens: 8000 }),
    event('task_complete', 4, { turn_id: firstTurn, last_agent_message: 'continued' }),
    event('task_started', 5, { turn_id: secondTurn, model_context_window: 258400 }),
    {
      timestamp: at(6),
      type: 'compacted',
      payload: {
        message: '',
        replacement_history: [{ type: 'compaction', encrypted_content: 'opaque' }],
        window_number: 2,
      },
    },
    turnContext(7, firstTurn, 'gpt-5.6-sol', 'high'),
  ];
  const reducer = createCodexSessionReducer('sess');
  for (const record of records) {
    reducer.pushLine(JSON.stringify(record));
  }

  const read = reducer.read();
  assert.equal(read.compactions[0].contextBefore, 190000);
  assert.equal(read.turns.find((turn) => turn.promptId === firstTurn)?.usage.requests, 1);
  assert.equal(reducer.snapshot().lastContext, 0);
});

test('consecutive compactions do not reuse a request still waiting for its model', () => {
  const records = [
    meta(),
    event('task_started', 1, { turn_id: TURN, model_context_window: 258400 }),
    event('user_message', 2, { message: 'keep working' }),
    tokens(3, { input_tokens: 190000, cached_input_tokens: 180000, output_tokens: 8000 }),
    {
      timestamp: at(4),
      type: 'compacted',
      payload: {
        message: '',
        replacement_history: [{ type: 'compaction', encrypted_content: 'opaque-1' }],
        window_number: 2,
      },
    },
    {
      timestamp: at(5),
      type: 'compacted',
      payload: {
        message: '',
        replacement_history: [{ type: 'compaction', encrypted_content: 'opaque-2' }],
        window_number: 3,
      },
    },
    turnContext(6, TURN, 'gpt-5.6-sol', 'high'),
  ];
  const reducer = createCodexSessionReducer('sess');
  for (const record of records) {
    reducer.pushLine(JSON.stringify(record));
  }

  const read = reducer.read();
  assert.deepEqual(
    read.compactions.map((item) => item.contextBefore),
    [190000, 0],
  );
  assert.equal(read.turns[0].usage.requests, 1);
  assert.equal(read.turns[0].contextTokens, 0);
  assert.equal(reducer.snapshot().lastContext, 0);
});

// The session list. Membership is decided per file, from what that file recorded.
function sessionsRoot(files: { day: string; name: string; records: object[] }[]): string {
  const root = tempDir('codex-root-');
  for (const f of files) {
    const dir = path.join(root, ...f.day.split('/').filter((p) => p && p !== '.'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, f.name), f.records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  return root;
}

const ROLLOUT = (id: string) => `rollout-2026-08-25T12-00-00-${id}.jsonl`;
const UUID_A = '01a032c9-1a92-7931-845c-723117d24dbe';
const UUID_B = '01a032c9-8581-7942-9262-ab4289a674c4';
const UUID_C = '01a032c9-984d-7972-a0e5-abe29d0f50cf';
const UUID_D = '01a032c9-0004-7000-8000-000000000004';
const UUID_E = '01a032c9-0005-7000-8000-000000000005';
const UUID_F = '01a032c9-0006-7000-8000-000000000006';
const UUID_G = '01a032c9-0007-7000-8000-000000000007';
const UUID_H = '01a032c9-0008-7000-8000-000000000008';
const UUID_I = '01a032c9-0009-7000-8000-000000000009';

test('a Codex metadata identity with shell syntax never becomes a resume command', () => {
  const root = sessionsRoot([
    { day: '2026/08/25', name: ROLLOUT(UUID_A), records: [meta({ id: 'safe;calc', cwd: 'c:\\repo' })] },
  ]);
  const [session] = codexSessionFiles(root, ['c:\\repo']).sessions;
  assert.equal(session.sessionId, 'safe;calc');
  assert.equal(resumeCommand(session.agent, session.sessionId), null);
});

test('a thread Codex spawned for itself is an agent-run session', () => {
  const root = sessionsRoot([
    { day: '2026/08/25', name: ROLLOUT(UUID_A), records: [meta({ id: UUID_A, cwd: 'c:\\repo' })] },
    {
      day: '2026/08/25',
      name: ROLLOUT(UUID_B),
      records: [
        meta({
          id: UUID_B,
          cwd: 'c:\\repo',
          thread_source: 'subagent',
          agent_path: '/root/review_sol',
          agent_nickname: 'curie',
        }),
      ],
    },
  ]);
  const listing = codexSessionFiles(root, ['c:\\repo']);
  assert.deepEqual(listing.sessions.map((s) => s.sessionId).sort(), [UUID_A, UUID_B].sort());
  assert.equal(listing.sessions.find((session) => session.sessionId === UUID_B)?.agentRun, true);
  assert.equal(
    codexSubagentFor(listing.subagents, UUID_A, {
      id: UUID_B,
      name: 'review_sol',
      path: null,
      status: 'completed',
    })?.threadId,
    UUID_B,
  );
});

// Background review and a dispatched child carry the same structural metadata, but only
// the former names the automation source that stays out of the session list.
test('background review is omitted and a dispatched child stays visible', () => {
  const root = sessionsRoot([
    { day: '2026/08/25', name: ROLLOUT(UUID_A), records: [meta({ id: UUID_A })] },
    // The background reviewer's shape: its own thread_source value, a parent thread, and a
    // subagent source. The explicit automation source keeps it out of the session list.
    {
      day: '2026/08/25',
      name: ROLLOUT(UUID_B),
      records: [
        meta({
          id: UUID_B,
          thread_source: 'guardian_review',
          parent_thread_id: UUID_A,
          source: { subagent: { other: 'guardian' } },
        }),
      ],
    },
    // A spawned thread names its parent inside the source object instead.
    {
      day: '2026/08/25',
      name: ROLLOUT(UUID_C),
      records: [
        meta({
          id: UUID_C,
          thread_source: 'subagent',
          source: { subagent: { thread_spawn: { parent_thread_id: UUID_A, agent_path: '/root/review_sol' } } },
        }),
      ],
    },
    // The legacy guardian fixture uses the subagent thread source and a structured guardian subtype.

    {
      day: '2026/08/25',
      name: ROLLOUT(UUID_D),
      records: [
        meta({
          id: UUID_D,
          thread_source: 'subagent',
          parent_thread_id: UUID_A,
          source: { subagent: { other: 'guardian' } },
        }),
      ],
    },
    // An unknown structured subtype remains a visible child rather than being treated as
    // internal automation.
    {
      day: '2026/08/25',
      name: ROLLOUT(UUID_E),
      records: [
        meta({
          id: UUID_E,
          thread_source: 'subagent',
          parent_thread_id: UUID_A,
          source: { subagent: { other: 'indexer' } },
          agent_path: '/root/indexer',
        }),
      ],
    },
    // A guardian subtype on an unrelated future thread shape is not enough to hide it.
    {
      day: '2026/08/25',
      name: ROLLOUT(UUID_F),
      records: [
        meta({
          id: UUID_F,
          thread_source: 'realtime',
          parent_thread_id: UUID_A,
          source: { subagent: { other: 'guardian' } },
          agent_path: '/root/future',
        }),
      ],
    },
  ]);
  const listing = codexSessionFiles(root, ['c:\\repo']);
  assert.deepEqual(listing.sessions.map((s) => s.sessionId).sort(), [UUID_A, UUID_C, UUID_E, UUID_F].sort());
  assert.equal(listing.sessions.find((session) => session.sessionId === UUID_C)?.agentRun, true);
  assert.equal(listing.sessions.find((session) => session.sessionId === UUID_E)?.agentRun, true);
  // The walk still reports the omitted automation, because the head cache is trimmed
  // against the walk rather than the visible sessions.
  assert.equal(listing.walked.length, 6);
  assert.equal(listing.sources.length, 6);
  assert.deepEqual(
    listing.subagents
      .map((child) => ({
        threadId: child.threadId,
        parentThreadId: child.parentThreadId,
        agentPath: child.agentPath,
        openedAt: child.openedAt,
        threadSource: child.threadSource,
        backgroundReview: child.backgroundReview,
      }))
      .sort((left, right) => left.threadId.localeCompare(right.threadId)),
    [
      {
        threadId: UUID_D,
        parentThreadId: UUID_A,
        agentPath: null,
        openedAt: ms(0),
        threadSource: 'subagent',
        backgroundReview: true,
      },
      {
        threadId: UUID_E,
        parentThreadId: UUID_A,
        agentPath: '/root/indexer',
        openedAt: ms(0),
        threadSource: 'subagent',
        backgroundReview: false,
      },
      {
        threadId: UUID_F,
        parentThreadId: UUID_A,
        agentPath: '/root/future',
        openedAt: ms(0),
        threadSource: 'realtime',
        backgroundReview: false,
      },
      {
        threadId: UUID_B,
        parentThreadId: UUID_A,
        agentPath: null,
        openedAt: ms(0),
        threadSource: 'guardian_review',
        backgroundReview: true,
      },
      {
        threadId: UUID_C,
        parentThreadId: UUID_A,
        agentPath: '/root/review_sol',
        openedAt: ms(0),
        threadSource: 'subagent',
        backgroundReview: false,
      },
    ].sort((left, right) => left.threadId.localeCompare(right.threadId)),
  );
  assert.equal(
    codexSubagentFor(listing.subagents, UUID_A, { id: UUID_C, name: 'anything', path: null, status: 'completed' })
      ?.threadId,
    UUID_C,
  );
  assert.equal(
    codexSubagentFor(listing.subagents, UUID_A, { id: null, name: 'review_sol', path: null, status: 'completed' })
      ?.threadId,
    UUID_C,
  );
});

test('structural child markers classify agent runs and unknown user shapes stay ordinary', () => {
  const day = '2026/08/25';
  const one = (id: string, over: Record<string, unknown>) => ({
    day,
    name: ROLLOUT(id),
    records: [meta({ id, ...over })],
  });
  const root = sessionsRoot([
    // These fixtures identify editor and exec launch sources explicitly.
    one(UUID_A, { thread_source: 'user', source: 'vscode' }),
    one(UUID_B, { thread_source: 'user', source: 'exec' }),
    // A record without thread_source, parent metadata, or structured source retains ordinary-session classification.

    one(UUID_C, { thread_source: undefined, source: undefined }),
    // An unknown thread_source without structural child markers remains visible.
    one(UUID_D, { thread_source: 'realtime' }),
    // A source object that is not a subagent, and parent metadata that is null or empty,
    // exclude nothing.
    one(UUID_E, { source: { ide: 'vscode' }, parent_thread_id: null }),
    one(UUID_F, { thread_source: 'user', parent_thread_id: '' }),
    // A resumed fork is still the user's session.
    one(UUID_G, { thread_source: 'user', forked_from_id: UUID_A }),
    // A parent or a subagent source marks a run even with no thread_source at all.
    one(UUID_H, { thread_source: undefined, parent_thread_id: UUID_A }),
    one(UUID_I, { thread_source: undefined, source: { subagent: {} } }),
  ]);
  const found = new Map(codexSessionFiles(root, ['c:\\repo']).sessions.map((session) => [session.sessionId, session]));
  assert.deepEqual(
    [...found.keys()].sort(),
    [UUID_A, UUID_B, UUID_C, UUID_D, UUID_E, UUID_F, UUID_G, UUID_H, UUID_I].sort(),
  );
  assert.equal(found.get(UUID_A)?.agentRun, false);
  assert.equal(found.get(UUID_B)?.agentRun, true);
  assert.equal(found.get(UUID_D)?.agentRun, false);
  assert.equal(found.get(UUID_E)?.agentRun, false);
  assert.equal(found.get(UUID_F)?.agentRun, false);
  assert.equal(found.get(UUID_G)?.agentRun, false);
  assert.equal(found.get(UUID_H)?.agentRun, true);
  assert.equal(found.get(UUID_I)?.agentRun, true);
});

test('a headless Codex session stays visible and is marked as run by an agent', () => {
  const day = '2026/08/25';
  const root = sessionsRoot([
    { day, name: ROLLOUT(UUID_A), records: [meta({ id: UUID_A, source: 'vscode' })] },
    { day, name: ROLLOUT(UUID_B), records: [meta({ id: UUID_B, source: 'exec' })] },
  ]);
  const found = new Map(codexSessionFiles(root, ['c:\\repo']).sessions.map((session) => [session.sessionId, session]));
  assert.equal(found.get(UUID_A)?.agentRun, false);
  assert.equal(found.get(UUID_B)?.agentRun, true);
});

test('a spawned Codex agent stays visible and is marked as run by an agent', () => {
  const day = '2026/08/25';
  const root = sessionsRoot([
    { day, name: ROLLOUT(UUID_A), records: [meta({ id: UUID_A, source: 'vscode' })] },
    {
      day,
      name: ROLLOUT(UUID_B),
      records: [
        meta({
          id: UUID_B,
          thread_source: 'subagent',
          parent_thread_id: UUID_A,
          source: { subagent: { thread_spawn: { parent_thread_id: UUID_A } } },
        }),
      ],
    },
  ]);
  const found = new Map(codexSessionFiles(root, ['c:\\repo']).sessions.map((session) => [session.sessionId, session]));
  assert.equal(found.get(UUID_A)?.agentRun, false);
  assert.equal(found.get(UUID_B)?.agentRun, true);
});

test('a session belongs to the workspace its own record names, whatever day it was filed under', () => {
  const root = sessionsRoot([
    { day: '2026/04/19', name: ROLLOUT(UUID_A), records: [meta({ id: UUID_A, cwd: 'c:\\repo' })] },
    { day: '2026/08/25', name: ROLLOUT(UUID_B), records: [meta({ id: UUID_B, cwd: 'c:\\elsewhere' })] },
    { day: '2026/08/25', name: ROLLOUT(UUID_C), records: [meta({ id: UUID_C, cwd: 'c:\\repo\\extension' })] },
  ]);
  const found = codexSessionFiles(root, ['c:\\repo']).sessions;
  // The April session is kept, because the date a directory is named after says nothing
  // about which project the session in it belongs to.
  assert.deepEqual(found.map((s) => s.sessionId).sort(), [UUID_A, UUID_C].sort());
});

test('registered worktree roots admit sibling sessions and retain their cwd', () => {
  const root = sessionsRoot([
    { day: '2026/08/25', name: ROLLOUT(UUID_A), records: [meta({ id: UUID_A, cwd: 'c:\\repo' })] },
    { day: '2026/08/25', name: ROLLOUT(UUID_B), records: [meta({ id: UUID_B, cwd: 'd:\\trees\\topic' })] },
    { day: '2026/08/25', name: ROLLOUT(UUID_C), records: [meta({ id: UUID_C, cwd: 'd:\\other' })] },
  ]);
  const found = codexSessionFiles(root, ['c:\\repo', 'd:\\trees\\topic']).sessions;
  assert.deepEqual(
    found.map((session) => [session.sessionId, session.cwd]).sort(),
    [
      [UUID_A, 'c:\\repo'],
      [UUID_B, 'd:\\trees\\topic'],
    ].sort(),
  );
});

// The rollout walk admits year/month/day folders and one shard below them. It stops before a second shard level.

test('a rollout is found one directory deeper than Codex files them, and no deeper', () => {
  const day = ['2026', '08', '25'];
  const found = (...parts: string[]) =>
    codexSessionFiles(
      sessionsRoot([{ day: parts.join('/') || '.', name: ROLLOUT(UUID_A), records: [meta({ id: UUID_A })] }]),
      ['c:\\repo'],
    ).sessions.length;
  assert.equal(found(), 1, 'loose in the root');
  assert.equal(found(...day), 1, 'YYYY/MM/DD, which is where Codex writes today');
  assert.equal(found(...day, '14'), 1, 'one shard deeper than today, which must still be found');
  assert.equal(found(...day, '14', '30'), 0, 'past the limit, so the walk stops');
});

// What the caller caches is one opening record per rollout on the machine, because that is
// what deciding membership costs. So a listing has to report what it walked over as well as
// what it kept, and the cache is measured against the first of those and never the second.
test('a listing reports every rollout it walked, not only the ones it kept', () => {
  const root = sessionsRoot([
    { day: '2026/08/25', name: ROLLOUT(UUID_A), records: [meta({ id: UUID_A })] },
    { day: '2026/08/25', name: ROLLOUT(UUID_B), records: [meta({ id: UUID_B, cwd: 'c:\\elsewhere' })] },
    { day: '2026/08/25', name: ROLLOUT(UUID_C), records: [meta({ id: UUID_C, thread_source: 'subagent' })] },
  ]);
  const listing = codexSessionFiles(root, ['c:\\repo']);
  assert.deepEqual(
    listing.sessions.map((s) => s.sessionId).sort(),
    [UUID_A, UUID_C].sort(),
    'the user and dispatched sessions belong here',
  );
  assert.equal(listing.sessions.find((session) => session.sessionId === UUID_C)?.agentRun, true);
  assert.equal(listing.walked.length, 3, 'and all three had to be opened to find that out');
  // Even with no workspace open, so the caller can still trim a cache it filled earlier.
  assert.equal(codexSessionFiles(root, []).walked.length, 3);
});

test('a cached opening record is dropped only once its rollout is gone', () => {
  const walked = ['/x/a.jsonl', '/x/b.jsonl', '/x/c.jsonl'];
  // Trim cached openings against all walked files rather than only sessions admitted to the workspace.

  assert.deepEqual(staleMetas(['/x/a.jsonl', '/x/b.jsonl', '/x/c.jsonl'], walked), []);
  assert.deepEqual(staleMetas(['/x/a.jsonl', '/x/gone.jsonl'], walked), ['/x/gone.jsonl']);
  assert.deepEqual(staleMetas([], walked), []);
  // The sessions are a handful of what the walk saw, so measuring against them drops the rest.
  assert.deepEqual(staleMetas(walked, ['/x/a.jsonl']), ['/x/b.jsonl', '/x/c.jsonl']);
});

test('a rollout with nothing readable at its head is not claimed by any workspace', () => {
  const root = sessionsRoot([
    {
      day: '2026/08/25',
      name: ROLLOUT(UUID_A),
      records: [{ timestamp: at(0), type: 'event_msg', payload: { type: 'task_started', turn_id: TURN } }],
    },
  ]);
  assert.deepEqual(codexSessionFiles(root, ['c:\\repo']).sessions, []);
});

test('a rollout whose opening record grows into place is listed without rebuilding the cache', () => {
  const root = sessionsRoot([
    { day: '2026/08/25', name: ROLLOUT(UUID_A), records: [{ type: 'session_meta', payload: { id: UUID_A } }] },
  ]);
  const file = path.join(root, '2026', '08', '25', ROLLOUT(UUID_A));
  const opening = JSON.stringify(meta({ id: UUID_A }));
  const cut = Math.floor(opening.length / 2);
  fs.writeFileSync(file, opening.slice(0, cut));
  const fixedMtime = new Date('2026-08-25T12:00:00.000Z');
  fs.utimesSync(file, fixedMtime, fixedMtime);
  const cache = new CodexMetaCache();
  const list = () => codexSessionFiles(root, ['c:\\repo'], (rollout) => cache.get(rollout)).sessions;
  assert.deepEqual(list(), [], 'the incomplete opening record is not yet a session');
  fs.appendFileSync(file, opening.slice(cut) + '\n');
  fs.utimesSync(file, fixedMtime, fixedMtime);
  assert.deepEqual(
    list().map((session) => session.sessionId),
    [UUID_A],
    'growth retries the old miss even when the file timestamp did not move',
  );
});

test('an idle rollout reuses its stat until the watcher reports it or the stat ages out', () => {
  const root = sessionsRoot([{ day: '2026/08/25', name: ROLLOUT(UUID_A), records: [meta({ id: UUID_A })] }]);
  const file = path.join(root, '2026', '08', '25', ROLLOUT(UUID_A));
  const idle = new Date('2026-08-25T12:00:00.000Z');
  fs.utimesSync(file, idle, idle);
  let now = idle.getTime() + 24 * 60 * 60_000;
  const stats = new CodexStatCache(undefined, () => now);
  const identity = revisionOf(fs.statSync(file, { bigint: true }));
  const uncached = codexSessionFiles(root, ['c:\\repo']).sessions[0];
  const pair = [identity.dev, identity.ino];
  assert.deepEqual([uncached.dev, uncached.ino], pair);
  const size = () => {
    const session = codexSessionFiles(root, ['c:\\repo'], readCodexSessionMeta, (rollout) => stats.get(rollout))
      .sessions[0];
    assert.deepEqual([session.dev, session.ino], pair);
    return session.size;
  };
  const grow = () => {
    fs.appendFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } }) + '\n');
    fs.utimesSync(file, idle, idle);
    return fs.statSync(file).size;
  };
  size();
  const unreported = grow();
  assert.notEqual(size(), unreported, 'an idle rollout was statted again with no watcher event');
  stats.markChanged(path.dirname(file), path.basename(file));
  assert.equal(size(), unreported, 'a rollout the watcher reported kept its old size');
  const unnamed = grow();
  stats.markChanged(path.dirname(file), null);
  assert.equal(size(), unnamed, 'a watcher event without a file name kept the old size');
  const missed = grow();
  now += CODEX_STAT_REVALIDATE_MS;
  assert.equal(size(), missed, 'a missed watcher event held the old size past the age limit');
  now = idle.getTime() + 1_000;
  const active = grow();
  assert.equal(size(), active, 'an active rollout reused its stat');
});

test('a miss is retried when its opening line completes during the confirmation read', () => {
  const file = writeRollout([{ type: 'session_meta', payload: { id: UUID_A } }]);
  const opening = JSON.stringify(meta({ id: UUID_A })) + '\n';
  const cut = Math.floor(opening.length / 2);
  fs.writeFileSync(file, opening.slice(0, cut));
  let reads = 0;
  const cache = new CodexMetaCache((rollout) => {
    reads += 1;
    const result = readCodexSessionMeta(rollout);
    if (reads === 2) {
      fs.appendFileSync(rollout, opening.slice(cut));
    }
    return result;
  });
  assert.equal(cache.get(file), null);
  assert.equal(cache.get(file), null);
  assert.equal(
    cache.get(file)?.cwd,
    'c:\\repo',
    'the size before the failed read remains the retry marker after the line completes',
  );
});

test('a malformed rollout head is not read again while its file stays still', () => {
  const file = writeRollout([{ type: 'not_session_meta', payload: {} }]);
  let reads = 0;
  const cache = new CodexMetaCache((rollout) => {
    reads += 1;
    return readCodexSessionMeta(rollout);
  });
  assert.equal(cache.get(file), null);
  assert.equal(cache.get(file), null, 'an unmeasured miss gets one confirmation read');
  assert.equal(cache.get(file), null, 'a static malformed rollout is not read again after its confirmation read');
  assert.equal(reads, 2);
});

test('Codex metadata cache hydrates and snapshots only positive opening records', () => {
  const valid = writeRollout([meta()]);
  const invalid = writeRollout([{ type: 'not_session_meta' }]);
  const cache = new CodexMetaCache();
  cache.load([[valid, readCodexSessionMeta(valid)!]]);
  cache.get(invalid);
  cache.get(invalid);
  assert.deepEqual(cache.snapshot(), [[valid, readCodexSessionMeta(valid)]]);

  let reads = 0;
  const restored = new CodexMetaCache(() => {
    reads++;
    return null;
  });
  restored.load(cache.snapshot());
  assert.deepEqual(restored.get(valid), readCodexSessionMeta(valid));
  assert.equal(reads, 0, 'hydrated metadata should avoid a head read');
});

test('Codex metadata cache revisions move only with persistable entries', () => {
  const valid = writeRollout([meta()]);
  const invalid = writeRollout([{ type: 'not_session_meta' }]);
  const cache = new CodexMetaCache();
  cache.load([[valid, readCodexSessionMeta(valid)!]]);
  assert.equal(cache.revision, 0, 'loading the durable baseline is not a new change');
  cache.get(invalid);
  cache.get(invalid);
  assert.equal(cache.revision, 0, 'a retry marker is never persisted');
  assert.equal(cache.delete(valid), true);
  assert.equal(cache.revision, 1, 'removing a persisted entry changes the snapshot');
  assert.deepEqual(cache.get(valid), readCodexSessionMeta(valid));
  assert.equal(cache.revision, 2, 'reading a new positive entry changes the snapshot');
});

test('a cold opening pass reads up to its bound at once and never more', async () => {
  const opening = readCodexSessionMeta(writeRollout([meta()]))!;
  const files = Array.from({ length: 10 }, (_, index) => `rollout-${index}.jsonl`);
  const waiting: (() => void)[] = [];
  let open = 0;
  let most = 0;
  const cache = new CodexMetaCache(() => assert.fail('a file the pass read was read again on the main thread'));
  const done = cache.prime(
    files,
    (file) => {
      open += 1;
      most = Math.max(most, open);
      return new Promise((resolve) => {
        waiting.push(() => {
          open -= 1;
          resolve({ ...opening, sessionId: file });
        });
      });
    },
    3,
  );
  for (let settled = 0; settled < files.length; settled++) {
    await vi.waitFor(() => assert.equal(open, Math.min(3, files.length - settled), 'reads in flight'));
    waiting.shift()!();
  }
  await done;
  assert.equal(most, 3, 'the pass ran more reads at once than its bound');
  assert.deepEqual(
    files.map((file) => cache.get(file)?.sessionId),
    files,
  );
});

test('a cold opening pass settles after its last read, and the listing after it reads nothing', async () => {
  const root = sessionsRoot(
    [UUID_A, UUID_B, UUID_C].map((id) => ({ day: '2026/08/25', name: ROLLOUT(id), records: [meta({ id })] })),
  );
  const walked = rolloutFiles(root);
  const release = new Map<string, () => void>();
  let mainThreadReads = 0;
  const cache = new CodexMetaCache((file) => {
    mainThreadReads += 1;
    return readCodexSessionMeta(file);
  });
  let settled = false;
  const done = cache
    .prime(
      walked,
      (file, buf) => new Promise((resolve) => release.set(file, () => resolve(readCodexSessionMetaAsync(file, buf)))),
    )
    .then(() => {
      settled = true;
    });
  await vi.waitFor(() => assert.equal(release.size, walked.length));
  const [last, ...rest] = walked;
  for (const file of rest) {
    release.get(file)!();
  }
  await vi.waitFor(() => assert.equal(cache.snapshot().length, rest.length));
  assert.equal(settled, false, 'the pass settled while a read was still out');
  release.get(last)!();
  await done;
  const listed = codexSessionFiles(root, ['c:\\repo'], (file) => cache.get(file)).sessions;
  assert.deepEqual(listed.map((session) => session.sessionId).sort(), [UUID_A, UUID_B, UUID_C].sort());
  assert.equal(mainThreadReads, 0, 'the listing after the pass read an opening record itself');
});

test('a rollout the cold pass found no record in is read again on the main thread only after it grows', async () => {
  const valid = writeRollout([meta()]);
  const invalid = writeRollout([{ type: 'not_session_meta' }]);
  let mainThreadReads = 0;
  const cache = new CodexMetaCache((file) => {
    mainThreadReads += 1;
    return readCodexSessionMeta(file);
  });
  assert.equal(await cache.prime([valid, invalid]), true, 'the pass did not report the row it read');
  assert.equal(cache.get(invalid), null);
  assert.equal(cache.get(invalid), null);
  assert.equal(mainThreadReads, 0, 'the walk read again a rollout the pass had already read');
  assert.equal(cache.revision, 1, 'a retry marker moved the persisted revision');
  fs.appendFileSync(invalid, '{"type":"more"}\n');
  cache.get(invalid);
  assert.equal(mainThreadReads, 1, 'a rollout that grew after the pass was never read again');
});

test('a cold opening pass survives a read that rejects, and leaves that rollout for the walk', async () => {
  const valid = writeRollout([meta()]);
  const failing = writeRollout([meta({ id: UUID_B })], ROLLOUT(UUID_B));
  const cache = new CodexMetaCache(() => assert.fail('the walk read again a rollout the pass had already read'));
  const read = await cache.prime([valid, failing], (file, buf) =>
    file === failing ? Promise.reject(new Error('EBUSY')) : readCodexSessionMetaAsync(file, buf),
  );
  assert.equal(read, true);
  assert.deepEqual(cache.get(valid), readCodexSessionMeta(valid));
  assert.deepEqual([...cache.keys()], [valid], 'a refused read left an entry for the walk to trust');
});

test('a rollout whose cold read was refused appears in a later catalog while its size stays the same', async () => {
  const root = sessionsRoot(
    [UUID_A, UUID_B].map((id) => ({ day: '2026/08/25', name: ROLLOUT(id), records: [meta({ id })] })),
  );
  const walked = rolloutFiles(root);
  const held = walked.find((file) => file.includes(UUID_B))!;
  const cache = new CodexMetaCache();
  await cache.prime(walked, (file, buf) =>
    file === held ? Promise.reject(new Error('EBUSY')) : readCodexSessionMetaAsync(file, buf),
  );
  const size = fs.statSync(held).size;
  const catalog = () =>
    codexSessionFiles(root, ['c:\\repo'], (file) => cache.get(file))
      .sessions.map((session) => session.sessionId)
      .sort();
  catalog();
  assert.equal(fs.statSync(held).size, size);
  assert.deepEqual(catalog(), [UUID_A, UUID_B].sort(), 'a rollout the pass could not read left the rail');
});

test('a finished rollout whose head reads failed twice appears in a later catalog while its size stays the same', () => {
  const root = sessionsRoot(
    [UUID_A, UUID_B].map((id) => ({ day: '2026/08/25', name: ROLLOUT(id), records: [meta({ id })] })),
  );
  const held = rolloutFiles(root).find((file) => file.includes(UUID_B))!;
  // Another process holds the rollout open for a moment. The opens fail in the file system
  // itself, so the production reader meets the error.
  const nodeFs = createRequire(__filename)('node:fs') as typeof fs;
  const open = nodeFs.openSync;
  nodeFs.openSync = (file: fs.PathLike, ...rest: unknown[]) => {
    if (file === held) {
      throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${held}'`), { code: 'EBUSY' });
    }
    return (open as (...args: unknown[]) => number)(file, ...rest);
  };
  syncBuiltinESMExports();
  let clock = 0;
  const cache = new CodexMetaCache(undefined, undefined, () => clock);
  const catalog = () =>
    codexSessionFiles(root, ['c:\\repo'], (file) => cache.get(file))
      .sessions.map((session) => session.sessionId)
      .sort();
  try {
    assert.deepEqual(catalog(), [UUID_A]);
    clock = REFUSED_OPENING_FIRST_RETRY_MS;
    assert.deepEqual(catalog(), [UUID_A]);
  } finally {
    nodeFs.openSync = open;
    syncBuiltinESMExports();
  }
  clock += REFUSED_OPENING_RETRY_MS;
  assert.deepEqual(catalog(), [UUID_A, UUID_B].sort(), 'a rollout whose reads failed left the rail until it grew');
});

test('a rollout the file system keeps refusing is opened once per retry wait and appears at the first read after the refusals end', () => {
  const root = sessionsRoot(
    [UUID_A, UUID_B].map((id) => ({ day: '2026/08/25', name: ROLLOUT(id), records: [meta({ id })] })),
  );
  const held = rolloutFiles(root).find((file) => file.includes(UUID_B))!;
  const nodeFs = createRequire(__filename)('node:fs') as typeof fs;
  const open = nodeFs.openSync;
  let opens = 0;
  let refusing = true;
  nodeFs.openSync = (file: fs.PathLike, ...rest: unknown[]) => {
    if (file === held) {
      opens += 1;
      if (refusing) {
        throw Object.assign(new Error(`EPERM: operation not permitted, open '${held}'`), { code: 'EPERM' });
      }
    }
    return (open as (...args: unknown[]) => number)(file, ...rest);
  };
  syncBuiltinESMExports();
  let clock = 0;
  const cache = new CodexMetaCache(undefined, undefined, () => clock);
  const catalog = () =>
    codexSessionFiles(root, ['c:\\repo'], (file) => cache.get(file))
      .sessions.map((session) => session.sessionId)
      .sort();
  // Walks every tenth of a retry interval and once more just before `until`, each without the
  // held rollout, then sets the clock to `until`.
  const walkUntil = (until: number) => {
    for (; clock < until - 1; clock = Math.min(clock + REFUSED_OPENING_RETRY_MS / 10, until - 1)) {
      assert.deepEqual(catalog(), [UUID_A]);
    }
    assert.deepEqual(catalog(), [UUID_A]);
    clock = until;
  };
  try {
    assert.deepEqual(catalog(), [UUID_A]);
    walkUntil(REFUSED_OPENING_FIRST_RETRY_MS);
    assert.equal(opens, 1, 'a walk inside the first wait opened the refused rollout');
    assert.deepEqual(catalog(), [UUID_A]);
    assert.equal(opens, 2, 'the first wait ended without a read');
    walkUntil(REFUSED_OPENING_FIRST_RETRY_MS + REFUSED_OPENING_RETRY_MS);
    assert.equal(opens, 2, 'a walk inside the retry interval opened the refused rollout');
    assert.deepEqual(catalog(), [UUID_A]);
    assert.equal(opens, 3, 'the retry interval ended without a read');
    walkUntil(REFUSED_OPENING_FIRST_RETRY_MS + 2 * REFUSED_OPENING_RETRY_MS);
    assert.equal(opens, 3, 'a refused retry shortened the next wait');
    assert.deepEqual(catalog(), [UUID_A]);
    assert.equal(opens, 4);
    refusing = false;
    walkUntil(REFUSED_OPENING_FIRST_RETRY_MS + 3 * REFUSED_OPENING_RETRY_MS);
    assert.equal(opens, 4, 'a walk read the rollout before its retry was due');
    assert.deepEqual(catalog(), [UUID_A, UUID_B].sort(), 'a readable rollout stayed hidden past its retry');
  } finally {
    nodeFs.openSync = open;
    syncBuiltinESMExports();
  }
});

test('a refused rollout is read at the next walk when the clock steps back behind its last read', () => {
  const file = writeRollout([meta()]);
  let refusing = true;
  let reads = 0;
  let clock = 10 * REFUSED_OPENING_RETRY_MS;
  const cache = new CodexMetaCache(
    (rollout) => {
      reads += 1;
      return refusing ? undefined : readCodexSessionMeta(rollout);
    },
    undefined,
    () => clock,
  );
  assert.equal(cache.get(file), null);
  clock += REFUSED_OPENING_FIRST_RETRY_MS;
  assert.equal(cache.get(file), null);
  refusing = false;
  clock -= 60 * 60_000;
  assert.deepEqual(
    cache.get(file),
    readCodexSessionMeta(file),
    'a clock that stepped back kept a readable rollout hidden',
  );
  assert.equal(reads, 3);
});

test('a rollout refused after a read found no record in it is read again after the first wait', () => {
  const file = writeRollout([meta()]);
  const answers: (ReturnType<typeof readCodexSessionMeta> | undefined)[] = [
    null,
    undefined,
    readCodexSessionMeta(file),
  ];
  let reads = 0;
  let size = 10;
  let clock = 0;
  const cache = new CodexMetaCache(
    () => answers[reads++],
    () => size,
    () => clock,
  );
  assert.equal(cache.get(file), null);
  size = 20;
  assert.equal(cache.get(file), null);
  assert.equal(reads, 2, 'a rollout that grew after a read found no record was not read again');
  clock = REFUSED_OPENING_FIRST_RETRY_MS;
  assert.deepEqual(cache.get(file), answers[2], 'a refused read after a miss left the rollout waiting to grow');
  assert.equal(reads, 3);
});

test('a cold opening pass reads a rollout the walk found refused before or during the pass', async () => {
  const before = writeRollout([meta()]);
  const during = writeRollout([meta({ id: UUID_B })], ROLLOUT(UUID_B));
  let mainThreadReads = 0;
  const cache = new CodexMetaCache(
    () => {
      mainThreadReads += 1;
      return undefined;
    },
    undefined,
    () => 0,
  );
  assert.equal(cache.get(before), null);
  const release = new Map<string, () => void>();
  const done = cache.prime(
    [before, during],
    (file, buf) => new Promise((resolve) => release.set(file, () => resolve(readCodexSessionMetaAsync(file, buf)))),
  );
  await vi.waitFor(() => assert.equal(release.size, 2, 'the pass skipped a rollout the walk found refused'));
  assert.equal(cache.get(during), null);
  assert.equal(mainThreadReads, 2);
  for (const answer of release.values()) {
    answer();
  }
  assert.equal(await done, true);
  assert.deepEqual(cache.get(before), readCodexSessionMeta(before));
  assert.deepEqual(
    cache.get(during),
    readCodexSessionMeta(during),
    'a refusal during the pass outlived the pass answer',
  );
  assert.equal(mainThreadReads, 2, 'the walk read a rollout the pass had answered');
});

test('the opening reader answers null, not a refused read, for a rollout with no opening record', () => {
  const dir = tempDir('codex-opening-');
  const heads: Record<string, string> = {
    empty: '',
    'another record first':
      JSON.stringify({ timestamp: at(0), type: 'event_msg', payload: { type: 'session_meta' } }) + '\n',
  };
  for (const [name, head] of Object.entries(heads)) {
    const file = path.join(dir, `${name}.jsonl`);
    fs.writeFileSync(file, head);
    assert.strictEqual(readCodexOpening(file), null, `${name}: a completed read was taken for a refused one`);
  }
});

test('the cold pass walks the rollout tree once, and the listing lists from its walk', async () => {
  const root = sessionsRoot(
    [UUID_A, UUID_B].map((id) => ({ day: '2026/08/25', name: ROLLOUT(id), records: [meta({ id })] })),
  );
  const cache = new CodexMetaCache(() => assert.fail('the listing read an opening record the pass had read'));
  const pass = await coldOpeningPass(cache, root);
  assert.deepEqual(pass.walked, rolloutFiles(root));
  assert.equal(pass.read, true);
  // A root with nothing under it shows that the listing walked nothing of its own.
  const empty = tempDir('codex-empty-');
  const listed = codexSessionFiles(empty, ['c:\\repo'], (file) => cache.get(file), undefined, pass.walked);
  assert.deepEqual(listed.walked, pass.walked);
  assert.deepEqual(listed.sessions.map((session) => session.sessionId).sort(), [UUID_A, UUID_B].sort());
  assert.equal((await coldOpeningPass(cache, root)).read, false, 'a warm pass reported rows it did not read');
});

test('a valid opening record is read before any stat', () => {
  const file = writeRollout([meta()]);
  let stats = 0;
  const cache = new CodexMetaCache(readCodexSessionMeta, () => {
    stats += 1;
    return fs.statSync(file).size;
  });
  assert.equal(cache.get(file)?.cwd, 'c:\\repo');
  assert.equal(cache.get(file)?.cwd, 'c:\\repo');
  assert.equal(stats, 0, 'a valid opening record does not stat an unrelated rollout');
});

test('a turn that ran commands and recorded no patch may have changed something anyway', () => {
  const counts = { edits: 0, reads: 0, searches: 0, commands: 3, agents: 0, coordination: 0, web: 0, other: 0 };
  const file = { path: 'a', added: 1, removed: 0, isNew: false, edits: [] };
  assert.equal(mayHaveUnrecordedEdits({ agent: 'codex', toolCounts: counts, files: [] }), true);
  assert.equal(mayHaveUnrecordedEdits({ agent: 'codex', toolCounts: counts, files: [file] }), false);
  assert.equal(mayHaveUnrecordedEdits({ agent: 'codex', toolCounts: { ...counts, commands: 0 }, files: [] }), false);
  // The missing-patch warning applies to Codex turns. This Claude fixture must not receive that warning.

  assert.equal(mayHaveUnrecordedEdits({ agent: 'claude', toolCounts: counts, files: [] }), false);
});

// The session list reads Codex turn boundaries from task_started records.

test('a rollout reports the turns in a window, and whether the window reached its start', () => {
  const file = writeRollout([
    meta(),
    event('task_started', 1, { turn_id: 't1', model_context_window: 258400 }),
    event('user_message', 2, { message: 'first ask' }),
    event('task_complete', 3, { last_agent_message: 'Done.' }),
    event('task_started', 20, { turn_id: 't2', model_context_window: 258400 }),
    event('user_message', 21, { message: 'second ask' }),
    event('task_complete', 22, { last_agent_message: 'Done again.' }),
  ]);
  assert.deepEqual(readCodexTurnStarts(file), { starts: [ms(1), ms(20)], whole: true });

  // A window that opens part way through the first turn drops it and says the figure is not
  // a total. The window is measured to open inside the first prompt.
  const raw = fs.readFileSync(file, 'utf8');
  const cut = readCodexTurnStarts(file, raw.length - raw.indexOf('first ask') - 4);
  assert.equal(cut.whole, false);
  assert.deepEqual(cut.starts, [ms(20)]);

  // A readable rollout with no turns supplies an empty start list with complete coverage.
  assert.deepEqual(readCodexTurnStarts(writeRollout([meta()])), { starts: [], whole: true });

  // A turn that recorded nothing is not counted. Compacting and realtime mode can each open
  // and close a turn with no card, so counting one would leave an unread mark opening cannot
  // clear.
  assert.deepEqual(
    readCodexTurnStarts(
      writeRollout([
        meta(),
        event('task_started', 1, { turn_id: 't1' }),
        event('task_complete', 2, { last_agent_message: '' }),
        event('task_started', 5, { turn_id: 't2' }),
        event('user_message', 6, { message: 'a real ask' }),
        event('task_complete', 7, { last_agent_message: 'Done.' }),
      ]),
    ).starts,
    [ms(5)],
  );

  // A prompt that was only the editor state the extension wraps around one is not a prompt.
  // `codexPrompt` strips it and `worthDrawing` refuses what is left, so this must too.
  assert.deepEqual(
    readCodexTurnStarts(
      writeRollout([
        meta(),
        event('task_started', 1, { turn_id: 't1' }),
        event('user_message', 2, { message: ['# Open tabs', 'foo.ts', '## My request for Codex:', ''].join('\n') }),
        event('task_complete', 3, { last_agent_message: '' }),
      ]),
    ).starts,
    [],
  );

  // A turn with no prompt still counts when it did something: an answer, a tool call, or an
  // interruption. That is `worthDrawing`'s own list, read off the window.
  for (const did of [
    event('task_complete', 3, { last_agent_message: 'Done.' }),
    item('custom_tool_call', 3, { call_id: 'c1', name: 'shell' }),
    item('function_call', 3, { call_id: 'c1', name: 'shell' }),
    event('patch_apply_end', 3, { call_id: 'c1', success: true, changes: { 'c:\\repo\\a.ts': { type: 'update' } } }),
    event('turn_aborted', 3, { reason: 'interrupted' }),
  ]) {
    assert.deepEqual(
      readCodexTurnStarts(writeRollout([meta(), event('task_started', 1, { turn_id: 't1' }), did])).starts,
      [ms(1)],
      'a turn that did something was dropped: ' + JSON.stringify(did),
    );
  }

  assert.deepEqual(
    readCodexTurnStarts(
      writeRollout([
        meta(),
        event('task_started', 1, { turn_id: 't1' }),
        event('patch_apply_end', 2, { success: true, changes: {} }),
        event('task_complete', 3, { last_agent_message: '' }),
      ]),
    ).starts,
    [],
  );
  assert.deepEqual(
    readCodexTurnStarts(
      writeRollout([
        meta(),
        event('task_started', 1, { turn_id: 't1' }),
        event('patch_apply_end', 2, {
          success: true,
          changes: { [path.join(os.homedir(), '.codex', 'config.toml')]: { type: 'update' } },
        }),
        event('task_complete', 3, { last_agent_message: '' }),
      ]),
    ).starts,
    [],
  );
  assert.deepEqual(
    readCodexTurnStarts(
      writeRollout([
        meta(),
        event('task_started', 1, { turn_id: 't1' }),
        event('turn_aborted', 2, { reason: 'replaced' }),
        event('task_complete', 3, { last_agent_message: 'late completion' }),
      ]),
    ).starts,
    [],
  );

  // The turn running now has recorded nothing yet and is still a turn the reader has not
  // seen, so a start left open when the window ends is kept.
  assert.deepEqual(readCodexTurnStarts(writeRollout([meta(), event('task_started', 9, { turn_id: 't1' })])).starts, [
    ms(9),
  ]);

  // A start whose time will not parse is dropped rather than counted as the epoch, which
  // would sort as the oldest turn the session ever had.
  assert.deepEqual(
    readCodexTurnStarts(
      writeRollout([
        meta(),
        { timestamp: 'not a date', type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
        event('task_started', 9, { turn_id: 't2' }),
      ]),
    ).starts,
    [ms(9)],
  );

  // A file that is not there is silence, not an empty session.
  assert.deepEqual(readCodexTurnStarts(path.join(os.tmpdir(), 'no-such-rollout.jsonl')), { starts: [], whole: false });
});

test('a Codex glance grows backward when the newest turn starts before its first window', () => {
  const bytes = 128;
  const file = writeRollout([
    meta(),
    event('task_started', 7, { turn_id: 'long-turn' }),
    event('user_message', 8, { message: 'the only ask' }),
    event('task_complete', 9, { last_agent_message: 'x'.repeat(bytes * 5) }),
  ]);
  // The backward read reaches the long turn's start but leaves opening metadata unread. Report the start with incomplete file coverage.

  assert.deepEqual(
    readCodexTurnStarts(file, bytes),
    { starts: [ms(7)], whole: false },
    'the Codex glance did not find the turn start before its first window',
  );
});

// Codex names a thread from a summary of the session, after the session has run,
// and writes the name into one index beside the sessions tree rather than into the rollout.
// A rollout that will never be written to again therefore gains a name minutes later, and
// nothing about the rollout says so.
test('a Codex session takes up the name Codex gives it, whenever that lands', () => {
  const dir = tempDir('codex-index-');
  const index = path.join(dir, 'session_index.jsonl');
  const id = '01a0545e-d3bc-7bd2-8d95-381ee061a3fd';

  // No index on this machine yet is silence, not a failure, and the session keeps whatever
  // its rollout gave it.
  const before = readThreadNames(index, null);
  assert.deepEqual([...before.names], []);
  assert.equal(
    codexTitleFor(before.names, id, 'theres an Agent working status at the bottom'),
    'theres an Agent working status at the bottom',
  );

  // The name arrives, and the rollout is untouched.
  fs.writeFileSync(
    index,
    JSON.stringify({
      id,
      thread_name: 'Investigate Agent working status',
      updated_at: '2026-08-30T20:33:17Z',
    }) + '\n',
  );
  const named = readThreadNames(index, before);
  assert.equal(named.names.get(id), 'Investigate Agent working status');
  assert.equal(named.fullNames.get(id), 'Investigate Agent working status');

  fs.appendFileSync(index, JSON.stringify({ id, updated_at: '2026-08-30T20:34:00Z' }) + '\n');
  const unnamedRow = readThreadNames(index, named);
  assert.equal(unnamedRow.names.get(id), 'Investigate Agent working status');
  assert.equal(unnamedRow.fullNames.get(id), 'Investigate Agent working status');

  // And it outranks the first prompt, which stands in for a name rather than being one.
  assert.equal(
    codexTitleFor(named.names, id, 'theres an Agent working status at the bottom'),
    'Investigate Agent working status',
  );

  // A session the index says nothing about falls through to its prompt, and a session with
  // neither falls through to nothing, leaving the caller to name it after its id.
  assert.equal(codexTitleFor(named.names, 'unnamed', 'fix the parser'), 'fix the parser');
  assert.equal(codexTitleFor(named.names, 'unnamed', null), null);

  // Renaming appends rather than rewrites, so the last row for an id wins, and the change is
  // seen without anything else on the machine moving.
  fs.appendFileSync(index, JSON.stringify({ id, thread_name: 'Remove the working status' }) + '\n');
  const renamed = readThreadNames(index, unnamedRow);
  assert.equal(renamed.names.get(id), 'Remove the working status');
  assert.equal(renamed.fullNames.get(id), 'Remove the working status');

  fs.appendFileSync(index, JSON.stringify({ id, thread_name: '   ' }) + '\n');
  const cleared = readThreadNames(index, renamed);
  assert.equal(cleared.names.has(id), false);
  assert.equal(cleared.fullNames.has(id), false, 'a cleared index name leaves stale full detail text');

  // An index that has not moved is not read again: the answer already held comes back.
  assert.equal(readThreadNames(index, cleared), cleared);
});

test('the thread index survives whatever is written into it', () => {
  const rich = `\uE200visualize\uE202${JSON.stringify({ path: path.resolve('fixtures', 'rail.html') })}\uE201`;
  const names = parseThreadNames(
    [
      'not json at all',
      JSON.stringify({ id: 'a', thread_name: 'A plain name' }),
      // No name to take, so nothing is filed and the row before it stands.
      JSON.stringify({ id: 'a' }),
      JSON.stringify({ id: 'b', thread_name: '' }),
      // Drawn as text everywhere, so it arrives as one line.
      JSON.stringify({ id: 'c', thread_name: 'Two\nlines  and   gaps' }),
      JSON.stringify({ id: 'd', thread_name: 'x'.repeat(200) }),
      JSON.stringify({ id: 'e', thread_name: `Keep\n${rich}\nthis title` }),
      JSON.stringify({ id: 'f', thread_name: rich }),
      JSON.stringify({ id: 'g', thread_name: 'Superseded title' }),
      JSON.stringify({ id: 'g', thread_name: rich }),
      '',
    ].join('\n'),
  );
  assert.equal(names.get('a'), 'A plain name');
  assert.equal(names.has('b'), false);
  assert.equal(names.get('c'), 'Two lines and gaps');
  assert.equal(names.get('d')?.length, 60);
  assert.equal(names.get('e'), 'Keep this title');
  assert.equal(names.has('f'), false);
  assert.equal(names.has('g'), false);
  assert.equal(codexTitleFor(names, 'g', 'rollout prompt fallback'), 'rollout prompt fallback');
});

test('the thread index sits beside the sessions tree, wherever that is', () => {
  const previous = process.env.ARC_CODEX_ROOT;
  try {
    process.env.ARC_CODEX_ROOT = path.join('c:', 'elsewhere', 'sessions');
    assert.equal(codexSessionIndexPath(), path.join('c:', 'elsewhere', 'session_index.jsonl'));
    delete process.env.ARC_CODEX_ROOT;
    assert.equal(codexSessionIndexPath(), path.join(os.homedir(), '.codex', 'session_index.jsonl'));
  } finally {
    if (previous === undefined) {
      delete process.env.ARC_CODEX_ROOT;
    } else {
      process.env.ARC_CODEX_ROOT = previous;
    }
  }
});

// Retain the request timestamp and billing identity behind the current context level for next-turn pricing.

test('a Codex turn records the request that set its context level, and what it was billed under', () => {
  const file = writeRollout([
    meta(),
    {
      timestamp: at(1),
      type: 'event_msg',
      payload: {
        type: 'thread_settings_applied',
        thread_settings: { service_tier: 'priority', model_provider_id: 'openai' },
      },
    },
    event('task_started', 2, { turn_id: 't1' }),
    turnContext(2, 't1', 'gpt-6-astra', 'high'),
    event('user_message', 2, { message: 'do the thing' }),
    tokens(3, { input_tokens: 20, cached_input_tokens: 500_000, cache_write_input_tokens: 6_000, output_tokens: 40 }),
    event('task_complete', 4, { turn_id: 't1', last_agent_message: 'done' }),
  ]);
  const [turn] = readCodexSession(file, 'sess').turns;
  assert.ok(turn.contextRequest, 'the turn records nothing about the request behind its level');
  // The settings record supplies the priority service tier for the retained context request.

  assert.equal(turn.contextRequest.serviceTier, 'priority');
  assert.equal(turn.contextRequest.at, Date.parse(at(3)));
  assert.equal(turn.contextRequest.readBack, true);
  assert.equal(turn.contextRequest.outputTokens, 40);
});

// The shared model policy supplies request lifetimes when a rollout records no duration.
test('a Codex turn takes its cache lifetime from the model price row', () => {
  const lifetimeOf = (model: string) => {
    const file = writeRollout([
      meta(),
      event('task_started', 2, { turn_id: 't1' }),
      turnContext(2, 't1', model, 'high'),
      event('user_message', 2, { message: 'do the thing' }),
      tokens(3, { input_tokens: 20, cached_input_tokens: 500_000, cache_write_input_tokens: 6_000, output_tokens: 40 }),
      event('task_complete', 4, { turn_id: 't1', last_agent_message: 'done' }),
    ]);
    const [turn] = readCodexSession(file, 'sess').turns;
    assert.ok(turn.contextRequest, `no request was recorded behind the level on ${model}`);
    return turn.contextRequest.lifetime;
  };
  assert.equal(lifetimeOf('gpt-6-astra'), '30m');
  assert.equal(lifetimeOf('gpt-5.6-sol'), '30m');
  assert.equal(lifetimeOf('gpt-5.5'), '30m');
  assert.equal(lifetimeOf('gpt-5.5-2026-04-23'), '30m');
  assert.equal(lifetimeOf('gpt-5.4'), '5m');
});

test('a Codex model switch does not carry the earlier cache lifetime into a new tier', () => {
  const file = writeRollout([
    meta(),
    event('task_started', 2, { turn_id: 't1' }),
    turnContext(2, 't1', 'gpt-5.4', 'high'),
    event('user_message', 2, { message: 'first' }),
    tokens(3, { input_tokens: 20, cached_input_tokens: 500_000, cache_write_input_tokens: 6_000, output_tokens: 40 }),
    event('task_complete', 4, { turn_id: 't1', last_agent_message: 'done' }),
    event('task_started', 5, { turn_id: 't2' }),
    turnContext(5, 't2', 'gpt-5.5', 'high'),
    event('user_message', 5, { message: 'second' }),
    tokens(6, { input_tokens: 20, cached_input_tokens: 500_000, output_tokens: 40 }),
    event('task_complete', 7, { turn_id: 't2', last_agent_message: 'done' }),
  ]);
  const turns = readCodexSession(file, 'sess').turns;
  assert.equal(turns[1].contextRequest?.lifetime, '30m', 'the earlier five-minute lifetime replaced GPT-5.5 retention');
});

// Skill catalogs support root aliases with short paths and absolute paths without a roots table.

const PUBLISHED_ROOTS = [
  '### Skill roots',
  '- `r0` = `C:/Users/dev/.agents/skills`',
  '- `r1` = `C:/Users/dev/.codex/plugins/cache/openai-bundled`',
].join('\n');

const PUBLISHED_SKILLS = [
  '### Available skills',
  '- panel-mockup: Review the panel and draw a mockup of it. (file: r0/panel-mockup/SKILL.md)',
  '- polish: Tidy the wording of shipped text. (file: r0/polish/SKILL.md)',
].join('\n');

const skillCatalog = (second: number, ...sections: string[]) =>
  message(
    'developer',
    second,
    ['<skills_instructions>', '## Skills', ...sections, '</skills_instructions>'].join('\n'),
  );

// A turn asked something after the catalog arrived.
function codexSkillTurn(...records: object[]): object[] {
  return [
    meta(),
    skillCatalog(1, PUBLISHED_ROOTS, PUBLISHED_SKILLS),
    event('task_started', 2, { turn_id: TURN, model_context_window: 258400 }),
    turnContext(3, TURN, 'gpt-5.6-sol', 'high'),
    event('user_message', 4, { message: 'review the panel' }),
    ...records,
    event('task_complete', 20, { turn_id: TURN, last_agent_message: 'reviewed' }),
  ];
}

const READ_PATH = "'C:\\Users\\dev\\.agents\\skills\\panel-mockup\\SKILL.md'";
const READ_MOCKUP = `Get-Content -Raw ${READ_PATH}`;

test('a Codex command that read a published skill records a best-effort load', () => {
  const file = writeRollout(
    codexSkillTurn(
      item('custom_tool_call', 5, {
        name: 'exec',
        call_id: 'call_a',
        input: 'const r = await tools.shell_command({command:"read the skill"});',
      }),
      commandCompleted(6, READ_MOCKUP),
    ),
  );
  const [turn] = readCodexSession(file, 'sess').turns;
  assert.deepEqual(turn.skillUses, [
    {
      sourceId: 'exec-6',
      name: 'panel-mockup',
      description: 'Review the panel and draw a mockup of it.',
      fullDescription: 'Review the panel and draw a mockup of it.',
      path: 'C:/Users/dev/.agents/skills/panel-mockup/SKILL.md',
      at: ms(6),
      evidence: 'best-effort',
    },
  ]);
  assert.equal(turn.skillUseCount, 1);
  assert.equal(turn.toolCounts.commands, 1, 'the command keeps the count it already had');
  assert.deepEqual(turn.stepKinds, ['commands'], 'a skill read adds no step of its own');
});

test('one Codex command that read two published skills records both under one identity', () => {
  const file = writeRollout(
    codexSkillTurn(
      commandCompleted(6, `${READ_MOCKUP}; Get-Content -Raw 'C:/Users/dev/.agents/skills/polish/SKILL.md'`),
    ),
  );
  const [turn] = readCodexSession(file, 'sess').turns;
  assert.deepEqual(
    turn.skillUses.map((use) => [use.name, use.sourceId, use.at]),
    [
      ['panel-mockup', 'exec-6', ms(6)],
      ['polish', 'exec-6', ms(6)],
    ],
  );
  assert.equal(turn.skillUseCount, 2);
});

// A published description longer than the row's own cut, so the hover keeps a sentence the
// row itself never shows whole.
const LONG_DESCRIPTION =
  'Review the panel, draw a mockup for it, and check every candidate ' +
  'against real panel shots until the reviewer can point at the one version the team should ' +
  'ship to every reader on every platform.';

const SKILLS_WITH_LONG_DESCRIPTION = [
  '### Available skills',
  `- panel-mockup: ${LONG_DESCRIPTION} (file: r0/panel-mockup/SKILL.md)`,
].join('\n');

test('a published description longer than the row keeps its whole sentence in the hover', () => {
  const file = writeRollout([
    meta(),
    skillCatalog(1, PUBLISHED_ROOTS, SKILLS_WITH_LONG_DESCRIPTION),
    event('task_started', 2, { turn_id: TURN, model_context_window: 258400 }),
    turnContext(3, TURN, 'gpt-5.6-sol', 'high'),
    event('user_message', 4, { message: 'review the panel' }),
    item('custom_tool_call', 5, {
      name: 'exec',
      call_id: 'call_a',
      input: 'const r = await tools.shell_command({command:"read the skill"});',
    }),
    commandCompleted(6, READ_MOCKUP),
    event('task_complete', 20, { turn_id: TURN, last_agent_message: 'reviewed' }),
  ]);
  const [turn] = readCodexSession(file, 'sess').turns;
  const use = turn.skillUses.find((one) => one.name === 'panel-mockup');
  assert.equal(use?.fullDescription, LONG_DESCRIPTION, 'the hover lost characters the row itself never had room for');
  assert.equal(
    use?.description,
    shortenTo(LONG_DESCRIPTION, STEP_DETAIL_LIMIT, STEP_CUT),
    'the row kept the same cut it always drew',
  );
});

test('a published name with a namespace of its own keeps the whole name', () => {
  const file = writeRollout([
    meta(),
    skillCatalog(
      1,
      PUBLISHED_ROOTS,
      '### Available skills',
      '- computer-use:computer-use: Control Windows apps. (file: r1/computer-use/26.901/skills/computer-use/SKILL.md)',
    ),
    event('task_started', 2, { turn_id: TURN }),
    turnContext(3, TURN, 'gpt-5.6-sol', 'high'),
    event('user_message', 4, { message: 'drive the app' }),
    commandCompleted(
      6,
      "Get-Content -Raw 'C:\\Users\\dev\\.codex\\plugins\\cache\\openai-bundled\\computer-use\\26.901\\skills\\computer-use\\SKILL.md'",
    ),
    event('task_complete', 20, { turn_id: TURN, last_agent_message: 'done' }),
  ]);
  assert.deepEqual(
    readCodexSession(file, 'sess').turns[0].skillUses.map((use) => [use.name, use.path]),
    [
      [
        'computer-use:computer-use',
        'C:/Users/dev/.codex/plugins/cache/openai-bundled/computer-use/26.901/skills/computer-use/SKILL.md',
      ],
    ],
  );
});

test('a POSIX root and an absolute published path both resolve to the file that was read', () => {
  const posix = writeRollout([
    meta(),
    skillCatalog(
      1,
      '### Skill roots',
      '- `r0` = `/home/dev/.agents/skills`',
      '### Available skills',
      '- polish: Tidy the wording. (file: r0/polish/SKILL.md)',
    ),
    event('task_started', 2, { turn_id: TURN }),
    turnContext(3, TURN, 'gpt-5.6-sol', 'high'),
    event('user_message', 4, { message: 'clean it' }),
    commandCompleted(6, 'cat /home/dev/.agents/skills/polish/SKILL.md'),
    event('task_complete', 20, { turn_id: TURN, last_agent_message: 'done' }),
  ]);
  assert.deepEqual(
    readCodexSession(posix, 'sess').turns[0].skillUses.map((use) => use.path),
    ['/home/dev/.agents/skills/polish/SKILL.md'],
  );
  // An absolute-path catalog requires no roots table. Match drive letters without regard to case.

  const absolute = writeRollout([
    meta(),
    skillCatalog(
      1,
      '### Available skills',
      '- polish: Tidy the wording. (file: C:/Users/dev/.agents/skills/polish/SKILL.md)',
    ),
    event('task_started', 2, { turn_id: TURN }),
    turnContext(3, TURN, 'gpt-5.6-sol', 'high'),
    event('user_message', 4, { message: 'clean it' }),
    commandCompleted(6, "Get-Content -Raw 'c:\\users\\dev\\.agents\\skills\\polish\\SKILL.md'"),
    event('task_complete', 20, { turn_id: TURN, last_agent_message: 'done' }),
  ]);
  assert.deepEqual(
    readCodexSession(absolute, 'sess').turns[0].skillUses.map((use) => use.path),
    ['C:/Users/dev/.agents/skills/polish/SKILL.md'],
  );
});

test('a published description is cut at the bound a step detail uses', () => {
  // The published descriptions run to a paragraph each, and the row draws one line of one.
  const published = 'r'.repeat(STEP_DETAIL_LIMIT + 40);
  const file = writeRollout([
    meta(),
    skillCatalog(1, PUBLISHED_ROOTS, '### Available skills', `- polish: ${published} (file: r0/polish/SKILL.md)`),
    event('task_started', 2, { turn_id: TURN }),
    turnContext(3, TURN, 'gpt-5.6-sol', 'high'),
    event('user_message', 4, { message: 'clean it' }),
    commandCompleted(6, "Get-Content -Raw 'C:/Users/dev/.agents/skills/polish/SKILL.md'"),
    event('task_complete', 20, { turn_id: TURN, last_agent_message: 'done' }),
  ]);
  const [use] = readCodexSession(file, 'sess').turns[0].skillUses;
  assert.equal(use.description?.length, STEP_DETAIL_LIMIT);
  assert.equal(use.description?.endsWith(STEP_CUT), true);
});

test('only a completed command that named the file itself records a Codex skill load', () => {
  const skillUsesOf = (...records: object[]) =>
    readCodexSession(writeRollout(codexSkillTurn(...records)), 'sess').turns[0].skillUses;
  assert.deepEqual(skillUsesOf(), [], 'a catalog alone is not a load');
  assert.deepEqual(skillUsesOf(commandCompleted(6, READ_MOCKUP, 1)), [], 'a command that exited non-zero read nothing');
  assert.deepEqual(
    skillUsesOf(commandCompleted(6, READ_MOCKUP, 0, 'failed')),
    [],
    'a command the runtime called failed read nothing',
  );
  assert.deepEqual(
    skillUsesOf(
      item('custom_tool_call', 5, {
        name: 'exec',
        call_id: 'call_a',
        input:
          'const r = await tools.shell_command({command:"Get-Content C:/Users/dev/.agents/skills/panel-mockup/SKILL.md"});',
      }),
    ),
    [],
    'a command still running has completed nothing',
  );
  // A command naming a skill file does not establish a file load. Searches must not count as loads.
  assert.deepEqual(
    skillUsesOf(commandCompleted(6, `rg -n TODO ${READ_PATH}`)),
    [],
    'a search whose argument was the file read none of it',
  );
  assert.deepEqual(
    skillUsesOf(commandCompleted(6, `Select-String -LiteralPath ${READ_PATH} -Pattern 'worktree'`)),
    [],
    'a search under another name read none of it either',
  );
  assert.deepEqual(
    skillUsesOf(commandCompleted(6, `Get-FileHash ${READ_PATH}`)),
    [],
    'a hash of the file took none of its instructions',
  );
  assert.deepEqual(
    skillUsesOf(commandCompleted(6, `cat notes.txt & rg -n TODO ${READ_PATH}`)),
    [],
    'a reader of another file, joined on by a single ampersand, did not read this one',
  );
  const printed = 'C:\\Users\\dev\\.agents\\skills\\panel-mockup\\SKILL.md:1:# Panel mockup';
  assert.deepEqual(
    skillUsesOf(
      event('item_completed', 6, {
        item: {
          type: 'CommandExecution',
          id: 'exec-6',
          command: ['rg', '-n', 'mockup'],
          parsed_cmd: [{ type: 'unknown', cmd: 'rg -n mockup C:\\Users\\dev\\.agents\\skills' }],
          status: 'completed',
          exit_code: 0,
          stdout: printed,
          aggregated_output: printed,
        },
      }),
    ),
    [],
    'a search whose own output printed the path did not read it',
  );
  assert.deepEqual(
    skillUsesOf(commandCompleted(6, 'rg -n mockup C:\\Users\\dev\\.agents\\skills'), toolOutput(7, 'call_a', printed)),
    [],
    'a later output record naming the path is not a read of it',
  );
  assert.deepEqual(
    skillUsesOf(commandCompleted(6, "Get-Content -Raw 'C:/repo/docs/SKILL.md'")),
    [],
    'a file in no catalog is not a skill',
  );
  assert.deepEqual(
    readCodexSession(
      writeRollout([
        meta(),
        skillCatalog(1, PUBLISHED_ROOTS, PUBLISHED_SKILLS),
        event('task_started', 2, { turn_id: TURN }),
        turnContext(3, TURN, 'gpt-5.6-sol', 'high'),
        event('user_message', 4, { message: 'use the panel-mockup skill' }),
        event('task_complete', 20, { turn_id: TURN, last_agent_message: 'done' }),
      ]),
      'sess',
    ).turns[0].skillUses,
    [],
    'naming a skill in a prompt is not loading it',
  );
});

test('a command that searched one skill file and read another records only the read', () => {
  // Answering for the whole command loses one of the two: refusing it drops the read, and
  // taking it reports a search as a load. The answer is given where each file is named.
  const file = writeRollout(
    codexSkillTurn(
      commandCompleted(6, `rg -n TODO ${READ_PATH}; Get-Content -Raw 'C:/Users/dev/.agents/skills/polish/SKILL.md'`),
    ),
  );
  assert.deepEqual(
    readCodexSession(file, 'sess').turns[0].skillUses.map((use) => use.name),
    ['polish'],
  );
});

test('a reader called through its directory and its Windows suffix is still a read', () => {
  // Recognize Windows executable suffixes and quoted paths containing spaces as read commands.

  const loadedBy = (command: string) =>
    readCodexSession(writeRollout(codexSkillTurn(commandCompleted(6, command))), 'sess').turns[0].skillUses.map(
      (use) => use.name,
    );
  assert.deepEqual(loadedBy(`cat.exe ${READ_PATH}`), ['panel-mockup']);
  assert.deepEqual(loadedBy(`head.exe -100 ${READ_PATH}`), ['panel-mockup']);
  assert.deepEqual(loadedBy(`'C:\\Program Files\\Git\\usr\\bin\\cat.exe' ${READ_PATH}`), ['panel-mockup']);
});

test('a read the client itself resolved is a load, whatever ran it', () => {
  // A parsed read command supplies the resolved file independently of its command spelling.

  const file = writeRollout(
    codexSkillTurn(
      event('item_completed', 6, {
        item: {
          type: 'CommandExecution',
          id: 'exec-6',
          command: ['pwsh', '-Command', 'Show-SkillFile'],
          parsed_cmd: [
            {
              type: 'read',
              cmd: 'Show-SkillFile -Path panel-mockup',
              name: 'SKILL.md',
              path: 'C:/Users/dev/.agents/skills/panel-mockup/SKILL.md',
            },
          ],
          status: 'completed',
          exit_code: 0,
        },
      }),
    ),
  );
  assert.deepEqual(
    readCodexSession(file, 'sess').turns[0].skillUses.map((use) => use.name),
    ['panel-mockup'],
  );
});

test('a published path whose root the catalog never named resolves to nothing', () => {
  const file = writeRollout([
    meta(),
    skillCatalog(
      1,
      PUBLISHED_ROOTS,
      '### Available skills',
      '- stray: Somewhere else entirely. (file: r7/stray/SKILL.md)',
    ),
    event('task_started', 2, { turn_id: TURN }),
    turnContext(3, TURN, 'gpt-5.6-sol', 'high'),
    event('user_message', 4, { message: 'read it' }),
    commandCompleted(6, 'cat r7/stray/SKILL.md'),
    event('task_complete', 20, { turn_id: TURN, last_agent_message: 'done' }),
  ]);
  assert.deepEqual(readCodexSession(file, 'sess').turns[0].skillUses, []);
});

test('a Codex command read twice records one load, and the catalog survives the resume', () => {
  const records = codexSkillTurn(commandCompleted(6, READ_MOCKUP));
  const reducer = createCodexSessionReducer('sess', {}, readCodexSessionMeta(writeRollout(records)));
  for (const record of records.slice(0, 6)) {
    reducer.pushLine(JSON.stringify(record));
  }
  const resumed = createCodexSessionReducer('sess', {}, null, reducer.snapshot());
  // Replaying a completed command counts one load. Retain the skill catalog in parser state for subsequent turns.

  for (const record of records.slice(5)) {
    resumed.pushLine(JSON.stringify(record));
  }
  for (const record of [
    event('task_started', 21, { turn_id: 'second' }),
    turnContext(22, 'second', 'gpt-5.6-sol', 'high'),
    event('user_message', 23, { message: 'clean it' }),
    commandCompleted(24, "Get-Content -Raw 'C:/Users/dev/.agents/skills/polish/SKILL.md'"),
    event('task_complete', 25, { turn_id: 'second', last_agent_message: 'done' }),
  ]) {
    resumed.pushLine(JSON.stringify(record));
  }
  assert.deepEqual(
    resumed.read().turns.map((turn) => [turn.skillUseCount, turn.skillUses.map((use) => use.name)]),
    [
      [1, ['panel-mockup']],
      [1, ['polish']],
    ],
  );
});

// A bare structural child row, as `refreshCodexStructuralAgents` first sees it before a spend
// lookup fills it in: no count, no cost, no duration yet.
function structuralChildAgent(): TurnAgent {
  return {
    id: 'child',
    description: 'Fix child',
    agentType: null,
    model: null,
    effort: null,
    spend: [],
    spendFound: false,
    spendPartial: false,
    durationMs: null,
    tokens: null,
    toolUses: null,
    status: 'completed',
  };
}

function nativeCommitRecords(): object[] {
  return [
    meta(),
    event('task_started', 1, { turn_id: TURN }),
    turnContext(2, TURN, 'gpt-6.1-sol', 'high'),
    event('user_message', 3, { message: 'Fix the parser.' }),
    commandCompleted(5, 'git commit -m fix', 0, 'completed', 'printed', {
      stdout: '[main abc1234] Fix the parser\n 1 file changed, 1 insertion(+)',
      started_at_ms: ms(4),
      completed_at_ms: ms(5),
    }),
    commandCompleted(7, 'git commit -q -m quiet', 0, 'completed', 'quiet', {
      stdout: '',
      started_at_ms: ms(6),
      completed_at_ms: ms(7),
    }),
    event('task_complete', 8, { turn_id: TURN, last_agent_message: 'Finished.' }),
  ];
}

test('native Codex commit objects stay independent across reads of the same source', () => {
  const file = writeRollout(nativeCommitRecords());
  const read = codexAgentSpendReader(codexSpendIndex([]));
  const first = read(file);
  assert.deepEqual(
    first.commits?.map(({ sha, subject }) => [sha, subject]),
    [['abc1234', 'Fix the parser']],
  );
  const commitDir = first.commits![0].dir;
  const intentDir = first.commitIntents![0].dir;
  assert.ok(first.commitIntents!.some(({ from, to }) => from === ms(6) && to === ms(7)));
  first.commits![0].dir = 'C:/changed-commit';
  first.commitIntents![0].dir = 'C:/changed-intent';
  const again = read(file);
  assert.equal(again.commits![0].dir, commitDir);
  assert.equal(again.commitIntents![0].dir, intentDir);
});

test('an interrupted native Codex read attaches no commit rows or recovery intents', () => {
  const file = writeRollout(nativeCommitRecords());
  const [parent] = readCodexSession(writeRollout(ordinaryTurn()), 'parent').turns;
  parent.agents.push(structuralChildAgent());
  const nativeFs = createRequire(__filename)('node:fs') as typeof fs;
  const read = nativeFs.readSync;
  let scanned = '';
  let failures = 0;
  const spy = vi.spyOn(nativeFs, 'readSync').mockImplementation(((...args: unknown[]) => {
    const [, buffer, offset, length, position] = args as [number, Buffer, number, number, number | null];
    if (position === null && length === 64 * 1024) {
      if (scanned) {
        failures += 1;
        throw new Error('read interrupted');
      }
      const size = Reflect.apply(read, nativeFs, args) as number;
      scanned = buffer.subarray(offset, offset + size).toString('utf8');
      return size;
    }
    return Reflect.apply(read, nativeFs, args);
  }) as typeof read);
  syncBuiltinESMExports();
  try {
    const spend = readCodexAgentSpend(file);
    assert.equal(failures, 1);
    assert.ok(scanned.includes('[main abc1234] Fix the parser'));
    assert.ok(scanned.includes('git commit -q -m quiet'));
    assert.equal(spend.found, false);
    assert.equal(spend.partial, true);
    assert.equal(spend.artifacts, undefined);
    refreshCodexStructuralAgents([parent], 'parent', [], () => spend);
    assert.equal(parent.agents[0].spendFound, false);
    assert.equal(toCard(parent, true).commits.length, 0);
    assert.equal(parent.agents[0].commits, undefined);
    assert.equal(parent.agents[0].commitIntents, undefined);
    assert.equal(spend.commits, undefined);
    assert.equal(spend.commitIntents, undefined);
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
});

test('native Codex attachment preserves cached commit objects and clears refreshed empty details', () => {
  const file = writeRollout(nativeCommitRecords());
  const [parent] = readCodexSession(writeRollout(ordinaryTurn()), 'parent').turns;
  parent.agents.push(structuralChildAgent());
  const cache = new AgentSpendCache();
  const load = vi.fn<typeof readCodexAgentSpend>(readCodexAgentSpend);
  const lookup = () => readChildSpend(cache, file, 'completed', spendFileVersion(file), load, 'native', false, ms(30));
  refreshCodexStructuralAgents([parent], 'parent', [], lookup);
  const child = parent.agents[0];
  assert.equal(child.commits?.[0].sha, 'abc1234');
  const commitDir = child.commits![0].dir;
  const intentDir = child.commitIntents![0].dir;
  child.commits![0].dir = 'C:/changed-commit';
  child.commitIntents![0].dir = 'C:/changed-intent';
  refreshCodexStructuralAgents([parent], 'parent', [], lookup);
  assert.equal(load.mock.calls.length, 1);
  assert.equal(child.commits![0].dir, commitDir);
  assert.equal(child.commitIntents![0].dir, intentDir);
  const running = readChildSpend(cache, file, 'launched', spendFileVersion(file), load, 'native', false, ms(30));
  assert.equal(running.commits, undefined);
  assert.equal(running.commitIntents, undefined);
  assert.equal(running.artifacts, undefined);
  fs.writeFileSync(
    file,
    ordinaryTurn()
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  refreshCodexStructuralAgents([parent], 'parent', [], lookup);
  assert.equal(load.mock.calls.length, 3);
  assert.equal(child.commits, undefined);
  assert.equal(child.commitIntents, undefined);
  refreshCodexStructuralAgents([parent], 'parent', [], () => ({
    models: [],
    found: false,
    partial: false,
    effort: null,
  }));
  assert.equal(child.commits, undefined);
  assert.equal(child.commitIntents, undefined);
});

test('native Codex descendant commits stay owned by their direct source', () => {
  const fixture = nestedCodexCostFixture();
  const commit = commandCompleted(23, 'git commit -m nested', 0, 'completed', 'nested-commit', {
    stdout: '[main def5678] Nested fix',
    started_at_ms: ms(22),
    completed_at_ms: ms(23),
  });
  const records = fs.readFileSync(fixture.grandchild, 'utf8').trim().split('\n');
  records.splice(records.length - 1, 0, JSON.stringify(commit));
  fs.writeFileSync(fixture.grandchild, records.join('\n') + '\n');
  const read = codexAgentSpendReader(codexSpendIndex(fixture.children));
  assert.equal(read(fixture.child).commits, undefined);
  assert.equal(read(fixture.child).commitIntents, undefined);
  assert.deepEqual(read(fixture.child).artifacts?.commits, []);
  assert.equal(read(fixture.grandchild).commits?.[0].sha, 'def5678');
});

test('a Codex child row carries the files its own rollout records, and a cut-off rollout reads as partial', () => {
  const file = writeRollout(ordinaryTurn());
  const spend = readCodexAgentSpend(file);
  const [turn] = readCodexSession(file, 'sess').turns;
  turn.agents.push(structuralChildAgent());
  refreshCodexStructuralAgents([turn], 'parent', [], () => spend);
  const artifacts = turn.agents[0].artifacts;
  assert.deepEqual(
    [
      artifacts?.files.map((file) => file.path),
      childFileTotals(artifacts?.files ?? []).added,
      childFileTotals(artifacts?.files ?? []).removed,
      artifacts?.commits,
      artifacts?.complete,
    ],
    [['c:\\repo\\src\\a.ts'], 2, 1, [], true],
  );
  fs.appendFileSync(file, '{"timestamp":"2026-');
  assert.equal(readCodexAgentSpend(file).artifacts?.complete, false);
});

function turnWithToolCalls(count: number): object[] {
  const calls: object[] = [];
  for (let i = 0; i < count; i++) {
    const id = `call_${i}`;
    calls.push(item('custom_tool_call', 4 + i * 2, { name: 'run_step', call_id: id, input: `step ${i}` }));
    calls.push(toolOutput(5 + i * 2, id, 'done'));
  }
  const closeAt = 4 + count * 2;
  return [
    meta(),
    event('task_started', 1, { turn_id: TURN, model_context_window: 258400 }),
    turnContext(2, TURN, 'gpt-5.6-sol', 'high'),
    event('user_message', 3, { message: 'run the steps' }),
    ...calls,
    tokens(closeAt, { input_tokens: 2000, cached_input_tokens: 1000, output_tokens: 50, reasoning_output_tokens: 10 }),
    event('task_complete', closeAt + 1, { turn_id: TURN, last_agent_message: 'done', duration_ms: 1000 }),
  ];
}

test('a dispatched Codex row retains failed tools from its native descendants', () => {
  const failedTurn = (name: string) => {
    const records = turnWithToolCalls(1);
    records.splice(
      4,
      2,
      item('custom_tool_call', 4, { name, call_id: 'failed' }),
      toolOutput(5, 'failed', 'Script error: ReferenceError: missing value'),
    );
    (records[0] as any).payload.id = name;
    if (name === 'apply_patch') (records[0] as any).payload.parent_thread_id = 'exec';
    return writeRollout(records);
  };
  const files = [failedTurn('exec'), failedTurn('apply_patch')];
  const spend = readCodexDispatchedSpend(
    files,
    [
      {
        file: files[1],
        threadId: 'apply_patch',
        parentThreadId: 'exec',
        agentPath: '/root/apply_patch',
        openedAt: 0,
        startedAt: 0,
        threadSource: 'subagent',
        backgroundReview: false,
      },
    ],
    Date.now() + 6000,
  );
  assert.deepEqual(spend.artifacts?.failed, { count: 2, byTool: { exec: 1, apply_patch: 1 } });
  assert.equal(spend.toolUses, 2);
});

test("a Codex child row's tool count follows any newer read of its calls, on the stored value and the drawn row alike", () => {
  const file = writeRollout(turnWithToolCalls(1));
  const firstSpend = readCodexAgentSpend(file);
  const [turn] = readCodexSession(file, 'sess').turns;
  turn.agents.push(structuralChildAgent());
  refreshCodexStructuralAgents([turn], 'parent', [], () => firstSpend);
  assert.equal(turn.agents[0].toolUses, 1);
  assert.equal(toCard(turn, true).agents[0].hintDetail, '1 tools');

  fs.writeFileSync(
    file,
    turnWithToolCalls(3)
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  );
  const secondSpend = readCodexAgentSpend(file);
  refreshCodexStructuralAgents([turn], 'parent', [], () => secondSpend);
  assert.equal(turn.agents[0].toolUses, 3);
  assert.equal(toCard(turn, true).agents[0].hintDetail, '3 tools');
});

test('fresh direct Codex launches retain exact stdout identity after Activity trims', () => {
  const child = 'aaaaaaaa-1111-1111-1111-111111111111';
  const stdout = JSON.stringify({ type: 'thread.started', thread_id: child });
  for (const command of ['codex exec --json -', '"C:/Tools/codex.exe" exec --json -', '/usr/bin/codex exec --json -']) {
    const records = [
      meta(),
      event('task_started', 1, { turn_id: TURN }),
      turnContext(2, TURN, 'gpt-6-sol', 'high'),
      commandCompleted(3, command, 0, 'completed', 'direct-launch', { stdout, parsed_cmd: undefined }),
      ...Array.from({ length: TURN_STEP_LIMIT + 1 }, (_, index) =>
        item('function_call', index + 4, {
          name: 'exec_command',
          call_id: `later-${index}`,
          arguments: '{"cmd":"git status"}',
        }),
      ),
      event('task_complete', 500, { turn_id: TURN }),
    ];
    const file = writeRollout(records);
    assert.deepEqual(
      scanCodexDispatchReferences(file, 'parent').references.map((reference) => [reference.agent, reference.sessionId]),
      [['codex', child]],
    );
    assert.deepEqual(readCodexSession(file, 'parent').turns[0].dispatchToolUseIds, ['direct-launch']);
  }
  for (const [command, output] of [
    ['codex exec resume --json -', stdout],
    ['cat events.jsonl', stdout],
    ['codex exec --json - && python launch.py --arc-dispatch', stdout],
    ['codex exec --json -', stdout + '\n' + stdout],
    ['codex exec --json -', JSON.stringify({ item: JSON.parse(stdout) })],
    ['codex exec --json -', JSON.stringify(stdout)],
    ['codex exec --json -', '{"type":"thread.started","thread_id":"aaaaaaaa"}'],
  ]) {
    const file = writeRollout([
      meta(),
      event('task_started', 1, { turn_id: TURN }),
      turnContext(2, TURN, 'gpt-6-sol', 'high'),
      commandCompleted(3, command, 0, 'completed', 'rejected', { stdout: output }),
    ]);
    assert.deepEqual(scanCodexDispatchReferences(file, 'parent').references, [], command + output);
  }
  const stderrOnly = writeRollout([
    meta(),
    event('task_started', 1, { turn_id: TURN }),
    commandCompleted(3, 'codex exec --json -', 0, 'completed', 'stderr', { stdout: '', stderr: stdout }),
  ]);
  assert.deepEqual(scanCodexDispatchReferences(stderrOnly, 'parent').references, []);
});

test('completed nested Codex commits retain candidates across resumed reads', () => {
  const command = "& 'C:/tools/bash.exe' -c 'git -C C:/notes commit -m first; git -C C:/plans commit -q -m second'";
  const records = ordinaryTurn();
  records.splice(
    5,
    0,
    commandCompleted(5, command, 0, 'completed', 'nested', {
      stdout: '[main abc1234] First\n 1 file changed, 2 insertions(+)',
      started_at_ms: ms(3),
      completed_at_ms: ms(7),
    }),
  );
  const file = writeRollout(records);
  const fresh = readCodexSession(file, 'sess');
  assert.equal(fresh.turns[0].commits[0].dir, null);
  assert.deepEqual(fresh.turns[0].commits[0].candidates, { dirs: ['C:/repo', 'C:/notes', 'C:/plans'], complete: true });
  const initial = readCodexSessionIncremental(file, 'sess');
  fs.appendFileSync(file, `${JSON.stringify({ type: 'ignored', payload: 'resume' })}\n`);
  const resumed = readCodexSessionIncremental(file, 'sess', initial.checkpoint ?? undefined);
  assert.deepEqual(resumed.read?.turns[0].commits, fresh.turns[0].commits);
});

test('a read-only Bedrock request refreshes the context request clock without another cache write', () => {
  for (const model of [
    'openai.gpt-6.1-sol',
    'us.openai.gpt-6.1-sol',
    'global.openai.gpt-6.1-sol',
    'openai.gpt-6-luna',
  ]) {
    const records = ordinaryTurn();
    records[0] = meta({ model_provider: 'amazon-bedrock' });
    records[2] = turnContext(2, TURN, model, 'high');
    records[7] = tokens(7, { input_tokens: 100_000, cache_write_input_tokens: 100_000, output_tokens: 10 });
    records.splice(8, 0, tokens(240, { input_tokens: 100_000, cached_input_tokens: 100_000, output_tokens: 20 }));
    records[9] = event('task_complete', 241, { turn_id: TURN, last_agent_message: 'done' });
    const turn = readCodexSession(writeRollout(records), 'sess').turns[0];
    assert.equal(turn.contextRequest?.at, ms(240), model);
    assert.equal(turn.contextRequest?.lifetime, '30m', model);
    assert.equal(turn.contextRequest?.readBack, true, model);
    assert.equal(turn.usage.cacheWrite30m, 100_000, model);
  }
});

for (const [child, count, expected] of [
  [false, 33, 6.52286635],
  [true, 11, 2.56272115],
] as const) {
  test(`Bedrock Astra ${child ? 'native Plato' : 'parent'} preserves short bills and unknown expiry in saved readers`, () => {
    const file = writeRollout(bedrockAstraRecords(child));
    const id = child ? 'bedrock-astra-plato' : 'bedrock-astra-parent';
    const [turn] = readCodexSession(file, id).turns;
    assert.equal(turn.usage.requests, count);
    assert.equal(turn.contextRequest?.lifetime, null);
    assert.equal(turn.usageParts?.[0]?.contextBand, 'short');
    assert.equal(turn.usageParts?.[0]?.inferenceClass, 'in-region');
    assert.ok(Math.abs(turnCost(turn).dollars! - expected) < 1e-10);
    const indexed = indexSpendFile(undefined, file, 'workspace', createCodexUsageLineReducer, 1).record;
    const stale = {
      ...indexed,
      parserGeneration: 37,
      buckets: indexed.buckets.map((bucket) => ({ ...bucket, contextBand: null, inferenceClass: null })),
      lifetimeBuckets: (indexed.lifetimeBuckets ?? []).map((bucket) => ({
        ...bucket,
        contextBand: null,
        inferenceClass: null,
      })),
    };
    const before = revisionOf(fs.statSync(file, { bigint: true }));
    const rebuilt = indexSpendFile(stale, file, 'workspace', createCodexUsageLineReducer, 2);
    assert.equal(rebuilt.rebuilt, true);
    assert.equal(fs.statSync(file).size, before.size);
    assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
    assert.equal(rebuilt.record.buckets[0]?.contextBand, 'short');
    assert.equal(rebuilt.record.buckets[0]?.requests, count);
    assert.ok(Math.abs(publicProjectSpendPrice(rebuilt.record.buckets[0])!.dollars - expected) < 1e-10);
  });
}

test('Codex compaction billing enters session and turn totals once across response arrival and restore', () => {
  const exact = usage({
    input_tokens: 183791,
    cached_input_tokens: 174336,
    output_tokens: 4443,
    reasoning_output_tokens: 0,
  });
  const response = {
    thread_id: '01a032c9-1a92-7931-845c-723117d24dbe',
    turn_id: TURN,
    response_id: 'compaction-response',
    usage: exact,
  };
  const native = { type: 'token_usage_record', timestamp: at(8), payload: response };
  const compacted = {
    type: 'compacted',
    timestamp: at(9),
    payload: {
      latest_token_usage_record: response,
      compaction_response_id: response.response_id,
      replacement_history: [],
    },
  };
  const count = tokens(8, exact);
  const settings = event('thread_settings_applied', 10, {
    thread_settings: { model: 'gpt-5.6-sol', model_provider_id: 'openai', service_tier: 'standard' },
  });
  for (const order of [
    [native, compacted, settings],
    [native, count, compacted, settings],
    [compacted, native, settings, count],
    [count, native, compacted, settings],
    [compacted, settings, count, native],
    [count, compacted, settings, native],
  ]) {
    const records = [
      ...ordinaryTurn().slice(0, 8),
      ...order,
      tokens(11, { input_tokens: 30000, cached_input_tokens: 12000, output_tokens: 25 }),
      event('task_complete', 12, { turn_id: TURN, last_agent_message: 'Complete.' }),
    ];
    const file = writeRollout(records);
    const record = indexSpendFile(undefined, file, 'workspace', createCodexUsageLineReducer, 1, {
      maxMilliseconds: Infinity,
    }).record;
    const compactBuckets = record.lifetimeBuckets!.filter((bucket) => bucket.compactionUsage);
    assert.equal(
      compactBuckets.reduce((sum, bucket) => sum + bucket.requests, 0),
      1,
    );
    assert.equal(
      record.lifetimeBuckets!.reduce((sum, bucket) => sum + bucket.requests, 0),
      3,
    );
    const cost = publicProjectSpendPrice(compactBuckets[0])!.dollars;
    assert.ok(cost !== null && cost > 0);
    const projection = sessionCostProjection(
      record.lifetimeBuckets!.map((bucket) => sessionCostUsageOf({ bucket, role: 'main' })),
      false,
      { compactionCount: 1 },
    );
    assert.ok(
      projection.stats[0].detailList?.entries.some(
        (entry) => entry.label === '1 compaction' && entry.value === `$${cost.toFixed(2)}`,
      ),
    );
    const read = readCodexSession(file, 'session');
    assert.equal(read.compactions[0].responseId, response.response_id);
    const turn = read.turns[0];
    assert.equal(turn.usage.requests, 2);
    assert.ok(costDetail(turn).join(' ').includes('1 compaction'));
    const expected = record.lifetimeBuckets!.reduce(
      (sum, bucket) => sum + (publicProjectSpendPrice(bucket)?.dollars ?? 0),
      0,
    );
    assert.ok(Math.abs(turnCost(turn).dollars! - expected) < 1e-9);
    for (let seam = 1; seam < records.length; seam++) {
      const initial = createCodexUsageLineReducer();
      const events = records.slice(0, seam).flatMap((row) => initial.pushLine(JSON.stringify(row)));
      const partialFile = writeRollout(records.slice(0, seam));
      const partial = indexSpendFile(undefined, partialFile, 'workspace', createCodexUsageLineReducer, 1, {
        maxMilliseconds: Infinity,
      }).record;
      const storage = tempDir('compaction-seam-');
      saveSpendLedger(storage, 'workspace', [partial]);
      assert.equal(loadSpendLedger(storage, 'workspace').files.length, 1, `disk restore at ${seam}`);
      const resumed = createCodexUsageLineReducer(initial.snapshot());
      events.push(...records.slice(seam).flatMap((row) => resumed.pushLine(JSON.stringify(row))));
      const totals = events.reduce((sum, event) => sum + (event.usage.requests ?? 1), 0);
      assert.equal(totals, 3, `restore at ${seam}`);
    }
    const folder = tempDir('compaction-ledger-');
    saveSpendLedger(folder, 'workspace', [record]);
    assert.equal(
      (loadSpendLedger(folder, 'workspace').files[0].parserState as ReturnType<typeof emptyCodexUsageReducerState>)
        .recentRequestEvents.length,
      (record.parserState as ReturnType<typeof emptyCodexUsageReducerState>).recentRequestEvents.length,
    );
  }
});

test('Codex delayed-model compaction and identical ordinary counters bill each operation once', () => {
  const exact = usage({ input_tokens: 183791, cached_input_tokens: 174336, output_tokens: 4443 });
  const native = (id: string, second: number) => ({
    type: 'token_usage_record',
    timestamp: at(second),
    payload: { response_id: id, turn_id: TURN, usage: exact },
  });
  const compacted = {
    type: 'compacted',
    timestamp: at(10),
    payload: { latest_token_usage_record: { response_id: 'compact', usage: exact } },
  };
  const settings = event('thread_settings_applied', 12, {
    thread_settings: { model: 'gpt-6-astra', model_provider_id: 'openai' },
  });
  const context = { type: 'turn_context', timestamp: at(11), payload: { turn_id: TURN, model: 'gpt-5.6-sol' } };
  const distinct = event('token_count', 14, {
    info: {
      last_token_usage: exact,
      total_token_usage: usage({ input_tokens: 367582, cached_input_tokens: 348672, output_tokens: 8886 }),
    },
  });
  for (const order of [
    [tokens(9, exact), compacted, context, settings, native('compact', 13), distinct, native('ordinary', 15)],
    [compacted, settings, native('compact', 13), distinct, native('ordinary', 15), context],
    [compacted, settings, native('compact', 13), distinct, context, native('ordinary', 15)],
  ]) {
    const records = [
      ...ordinaryTurn()
        .slice(0, 8)
        .filter((row) => (row as { type: string }).type !== 'turn_context'),
      ...order,
      event('task_complete', 16, { turn_id: TURN }),
    ];
    const file = writeRollout(records);
    const record = indexSpendFile(undefined, file, 'workspace', createCodexUsageLineReducer, 1, {
      maxMilliseconds: Infinity,
    }).record;
    assert.equal(
      record.lifetimeBuckets!.reduce((sum, bucket) => sum + bucket.requests, 0),
      3,
    );
    assert.equal(
      record
        .lifetimeBuckets!.filter((bucket) => bucket.compactionUsage)
        .reduce((sum, bucket) => sum + bucket.requests, 0),
      1,
    );
    const turn = readCodexSession(file, 'session').turns[0];
    assert.equal(turn.usage.requests, 2);
    const dollars = record.lifetimeBuckets!.reduce(
      (sum, bucket) => sum + (publicProjectSpendPrice(bucket)?.dollars ?? 0),
      0,
    );
    assert.ok(Math.abs(turnCost(turn).dollars! - dollars) < 1e-9);
    assert.equal(turnCost(turn).partial, true);
  }
});

for (const delayedModel of [false, true]) {
  for (const ordinaryBefore of [false, true]) {
    for (const separateNative of ['absent', 'before', 'after']) {
      test(`Codex ordinary usage survives a compaction without a snapshot (${delayedModel ? 'pending' : 'emitted'}, ordinary ${ordinaryBefore ? 'before' : 'after'}, native compaction ${separateNative})`, () => {
        const exact = usage({ input_tokens: 183791, cached_input_tokens: 174336, output_tokens: 4443 });
        const native = (id: string, second: number) => ({
          type: 'token_usage_record',
          timestamp: at(second),
          payload: { response_id: id, turn_id: TURN, usage: exact },
        });
        const context = turnContext(delayedModel ? 10 : 2, TURN, 'gpt-5.6-sol', 'high');
        const records = [
          meta(),
          event('task_started', 1, { turn_id: TURN, model_context_window: 258400 }),
          ...(!delayedModel ? [context] : []),
          event('user_message', 3, { message: 'Keep both request costs.' }),
          tokens(4, exact),
          ...(ordinaryBefore ? [native('ordinary', 5)] : []),
          ...(separateNative === 'before' ? [native('compact', 5)] : []),
          {
            type: 'compacted',
            timestamp: at(6),
            payload: { latest_token_usage_record: { response_id: 'compact', usage: exact } },
          },
          event('thread_settings_applied', 7, {
            thread_settings: { model: 'gpt-6-astra', model_provider_id: 'openai' },
          }),
          ...(separateNative === 'after' ? [native('compact', 8)] : []),
          ...(!ordinaryBefore ? [native('ordinary', 9)] : []),
          ...(delayedModel ? [context] : []),
          event('task_complete', 11, { turn_id: TURN, last_agent_message: 'Both requests completed.' }),
        ];
        for (let seam = 1; seam <= records.length; seam++) {
          const file = writeRollout(records.slice(0, seam));
          const partial = indexSpendFile(undefined, file, 'workspace', createCodexUsageLineReducer, 1, {
            maxMilliseconds: Infinity,
          }).record;
          const storage = tempDir('compaction-collision-seam-');
          saveSpendLedger(storage, 'workspace', [partial]);
          const saved = loadSpendLedger(storage, 'workspace').files;
          assert.equal(saved.length, 1, `disk restore at ${seam}`);
          if (seam < records.length) {
            fs.appendFileSync(
              file,
              `${records
                .slice(seam)
                .map((row) => JSON.stringify(row))
                .join('\n')}\n`,
            );
          }
          const record = indexSpendFile(saved[0], file, 'workspace', createCodexUsageLineReducer, 2, {
            maxMilliseconds: Infinity,
          }).record;
          for (const buckets of [record.buckets, record.lifetimeBuckets!]) {
            const ordinary = buckets.filter((bucket) => !bucket.compactionUsage);
            const compactions = buckets.filter((bucket) => bucket.compactionUsage);
            assert.equal(
              ordinary.reduce((sum, bucket) => sum + bucket.requests, 0),
              1,
              `ordinary at ${seam}`,
            );
            assert.equal(
              compactions.reduce((sum, bucket) => sum + bucket.requests, 0),
              1,
              `compaction at ${seam}`,
            );
            assert.equal(
              ordinary.reduce((sum, bucket) => sum + bucket.usage.input, 0),
              9455,
            );
            assert.equal(
              ordinary.reduce((sum, bucket) => sum + bucket.usage.cacheRead, 0),
              174336,
            );
            assert.equal(
              ordinary.reduce((sum, bucket) => sum + bucket.usage.output, 0),
              4443,
            );
            assert.equal(ordinary[0].model, 'gpt-5.6-sol');
            assert.equal(compactions[0].model, 'gpt-6-astra');
          }
          const lifetimeCost = record.lifetimeBuckets!.reduce(
            (sum, bucket) => sum + publicProjectSpendPrice(bucket)!.dollars,
            0,
          );
          const datedCost = record.buckets.reduce((sum, bucket) => sum + publicProjectSpendPrice(bucket)!.dollars, 0);
          const projection = sessionCostProjection(
            record.lifetimeBuckets!.map((bucket) => sessionCostUsageOf({ bucket, role: 'main' })),
            false,
            { compactionCount: 1 },
          );
          const turn = readCodexSession(file, 'session').turns[0];
          assert.equal(turn.usage.requests, 1);
          assert.equal(turn.usage.input, 9455);
          assert.equal(turn.usage.cacheRead, 174336);
          assert.equal(turn.usage.output, 4443);
          assert.ok(Math.abs(datedCost - lifetimeCost) < 1e-9);
          assert.ok(Math.abs(projection.total.dollars! - lifetimeCost) < 1e-9);
          assert.ok(Math.abs(turnCost(turn).dollars! - lifetimeCost) < 1e-9);
          assert.equal(projection.total.partial, !ordinaryBefore);
          assert.equal(turnCost(turn).partial, !ordinaryBefore);
        }
      });
    }
  }
}

test('Codex compaction checkpoints retain turnless joins and pending response keys on disk', () => {
  for (const turnless of [false, true]) {
    const records = turnless ? ordinaryTurn().slice(0, 1) : ordinaryTurn().slice(0, 8);
    records.push({
      type: 'compacted',
      timestamp: at(9),
      payload: {
        latest_token_usage_record: { response_id: 'compact', usage: usage({ input_tokens: 3000, output_tokens: 30 }) },
      },
    });
    const file = writeRollout(records);
    const indexed = indexSpendFile(undefined, file, 'workspace', createCodexUsageLineReducer, 1, {
      maxMilliseconds: Infinity,
    }).record;
    const state = indexed.parserState as ReturnType<typeof emptyCodexUsageReducerState>;
    if (!turnless) {
      const held = state.recentRequestEvents.find((event) => event.compactionUsage)!;
      state.pendingRequests[TURN] = [held];
      state.pendingRequestKeys = [held.requestKey];
    }
    const storage = tempDir('compaction-pending-');
    saveSpendLedger(storage, 'workspace', [indexed]);
    assert.equal(loadSpendLedger(storage, 'workspace').files.length, 1);
  }
});

test('Codex compaction usage without settings or response identity keeps cost incomplete', () => {
  for (const normalUsage of [true, false]) {
    const records = ordinaryTurn()
      .slice(0, 8)
      .filter((record) => normalUsage || (record as { payload?: { type?: string } }).payload?.type !== 'token_count');
    records.push({
      type: 'compacted',
      timestamp: at(9),
      payload: {
        latest_token_usage_record: {
          usage: usage({ input_tokens: 3000, cached_input_tokens: 2000, output_tokens: 30 }),
        },
      },
    });
    records.push(
      event('thread_settings_applied', 10, { thread_settings: { model: 'gpt-6-astra', model_provider_id: 'openai' } }),
    );
    const file = writeRollout(records);
    const indexed = indexSpendFile(undefined, file, 'workspace', createCodexUsageLineReducer, 1, {
      maxMilliseconds: Infinity,
    }).record;
    const parts = indexed.lifetimeBuckets!.map((bucket) => sessionCostUsageOf({ bucket, role: 'main' }));
    const projection = sessionCostProjection(parts, false, { compactionCount: 1 });
    assert.equal(
      projection.stats[0]?.detailList?.entries.find((entry) => entry.label === '1 compaction')?.value,
      normalUsage ? 'cost unavailable' : undefined,
    );
    assert.equal(projection.total.partial, true);
    const read = readCodexSession(file, 'session');
    assert.ok(toCompactionCard(read.compactions[0]).chips.some((chip) => chip.label.startsWith('$')));
    if (normalUsage) {
      assert.equal(
        toCard(read.turns[0], false, Date.parse(at(11)))
          .chips.find((chip) => chip.metric === 'cost')
          ?.detailList?.entries.find((entry) => entry.label === '1 compaction')?.value,
        'cost unavailable',
      );
    }
  }
  for (const ending of [null, 'task_complete', 'turn_aborted']) {
    for (const identified of [true, false]) {
      const records = [
        ...ordinaryTurn().slice(0, 8),
        {
          type: 'compacted',
          timestamp: at(9),
          payload: {
            latest_token_usage_record: {
              ...(identified ? { response_id: 'compact' } : {}),
              usage: usage({ input_tokens: 3000, output_tokens: 30 }),
            },
          },
        },
      ];
      if (ending) records.push(event(ending, 10, { turn_id: TURN }));
      const file = writeRollout(records);
      const indexed = indexSpendFile(undefined, file, 'workspace', createCodexUsageLineReducer, 1, {
        maxMilliseconds: Infinity,
      }).record;
      const parts = indexed.lifetimeBuckets!.map((bucket) => sessionCostUsageOf({ bucket, role: 'main' }));
      assert.equal(sessionCostProjection(parts, false, { compactionCount: 1 }).total.partial, true);
      assert.equal(turnCost(readCodexSession(file, 'session').turns[0]).partial, true);
    }
  }
});

test('a delayed copied-turn date retracts identified Codex compaction billing after restore', () => {
  const response = {
    response_id: 'copied-compaction',
    usage: usage({ input_tokens: 183791, cached_input_tokens: 174336, output_tokens: 4443 }),
  };
  const records = [
    ...ordinaryTurn().slice(0, 8),
    { type: 'compacted', timestamp: at(9), payload: { latest_token_usage_record: response } },
    event('thread_settings_applied', 10, { thread_settings: { model: 'gpt-5.6-sol', model_provider_id: 'openai' } }),
  ];
  const reducer = createCodexUsageLineReducer();
  const events = records.flatMap((row) => reducer.pushLine(JSON.stringify(row)));
  assert.equal(
    events.filter((event) => event.compactionUsage).reduce((sum, event) => sum + (event.usage.requests ?? 1), 0),
    1,
  );
  const resumed = createCodexUsageLineReducer(reducer.snapshot());
  events.push(
    ...resumed.pushLine(
      JSON.stringify({
        type: 'turn_context',
        timestamp: at(11),
        payload: { turn_id: TURN, current_date: '2020-01-01' },
      }),
    ),
  );
  assert.equal(resumed.compactionCount(), 0);
  assert.equal(
    events.reduce((sum, event) => sum + (event.usage.requests ?? 1), 0),
    0,
  );
});

test('Codex provisional compaction associations preserve accounting across every disk seam', () => {
  const exact = usage({ input_tokens: 183791, cached_input_tokens: 174336, output_tokens: 4443, total_tokens: 188234 });
  const native = (id: string, second: number) => ({
    type: 'token_usage_record',
    timestamp: at(second),
    payload: { turn_id: TURN, response_id: id, usage: exact },
  });
  const count = (second: number, multiple: number, id?: string) =>
    event('token_count', second, {
      ...(id ? { response_id: id } : {}),
      info: {
        last_token_usage: exact,
        total_token_usage: Object.fromEntries(Object.entries(exact).map(([key, value]) => [key, value * multiple])),
      },
    });
  for (const pending of [false, true])
    for (const before of [false, true])
      for (const separate of ['absent', 'before', 'after'])
        for (const nativeFirst of [false, true])
          for (const missingSnapshot of [false, true])
            for (const lateSettings of [false, true]) {
              const context = turnContext(2, TURN, 'gpt-5.6-sol', 'high');
              const records: Array<{ type: string; timestamp: string; payload: Record<string, unknown> }> = [
                meta(),
                event('task_started', 1, { turn_id: TURN }),
                event('user_message', 1, { message: 'Check compaction accounting.' }),
                ...(!pending ? [context] : []),
                ...(before ? [count(3, 1)] : []),
                ...(separate === 'before' ? [native('compact', 4)] : []),
                {
                  type: 'compacted',
                  timestamp: at(5),
                  payload: { latest_token_usage_record: { response_id: 'compact', usage: exact } },
                },
                ...(!before ? [count(6, 1)] : []),
                event('thread_settings_applied', 7, {
                  thread_settings: { model: 'gpt-6-astra', model_provider_id: 'openai' },
                }),
                ...(separate === 'after' ? [native('compact', 8)] : []),
                ...(missingSnapshot
                  ? [native('ordinary', 9)]
                  : nativeFirst
                    ? [native('ordinary', 9), count(10, 2)]
                    : [count(10, 2), native('ordinary', 9)]),
                ...(pending ? [context] : []),
                event('task_complete', 12, { turn_id: TURN }),
              ];
              if (lateSettings) {
                const index = records.findIndex((row) => row.payload.type === 'thread_settings_applied');
                const [settings] = records.splice(index, 1);
                records.splice(records.length - 1, 0, settings);
              }
              const midnight = new Date(2026, 9, 9, 23, 59, 54).getTime();
              const dated = records.map((row, index) =>
                recordedAt(row, new Date(midnight + index * 1000).toISOString()),
              );
              const freshFile = writeRollout(dated);
              const fresh = indexSpendFile(undefined, freshFile, 'workspace', createCodexUsageLineReducer, 1, {
                maxMilliseconds: Infinity,
              }).record;
              const normal = fresh.lifetimeBuckets!.filter((bucket) => !bucket.compactionUsage);
              const compact = fresh.lifetimeBuckets!.filter((bucket) => bucket.compactionUsage);
              assert.equal(
                normal.reduce((sum, bucket) => sum + bucket.requests, 0),
                1,
              );
              assert.equal(
                normal.reduce((sum, bucket) => sum + bucket.usage.input, 0),
                9455,
              );
              assert.equal(
                normal.reduce((sum, bucket) => sum + bucket.usage.cacheRead, 0),
                174336,
              );
              assert.equal(
                normal.reduce((sum, bucket) => sum + bucket.usage.output, 0),
                4443,
              );
              assert.equal(
                compact.reduce((sum, bucket) => sum + bucket.requests, 0),
                1,
              );
              assert.equal(normal[0].model, 'gpt-5.6-sol');
              assert.equal(compact[0].model, 'gpt-6-astra');
              assert.equal(normal[0].requestCountExact, false);
              const projection = sessionCostProjection(
                fresh.lifetimeBuckets!.map((bucket) => sessionCostUsageOf({ bucket, role: 'main' })),
                false,
                { compactionCount: 1 },
              );
              const compactionCost = compact.reduce((sum, bucket) => sum + publicProjectSpendPrice(bucket)!.dollars, 0);
              assert.equal(
                projection.stats[0].detailList?.entries.find((entry) => entry.label === '1 compaction')?.value,
                `$${compactionCost.toFixed(2)}`,
              );
              const turn = readCodexSession(freshFile, 'session').turns[0];
              const cost = fresh.lifetimeBuckets!.reduce(
                (sum, bucket) => sum + publicProjectSpendPrice(bucket)!.dollars,
                0,
              );
              assert.equal(turn.usage.requests, 1);
              assert.ok(
                Math.abs(turnCost(turn).dollars! - cost) < 1e-9,
                JSON.stringify({
                  pending,
                  before,
                  separate,
                  nativeFirst,
                  missingSnapshot,
                  cost,
                  turnCost: turnCost(turn),
                  parts: turn.usageParts,
                }),
              );
              assert.equal(turnCost(turn).partial, true);
              assert.equal(projection.total.partial, true);
              assert.ok(Math.abs(projection.total.dollars! - cost) < 1e-9);
              for (let seam = 1; seam <= dated.length; seam++) {
                const file = writeRollout(dated.slice(0, seam));
                const partial = indexSpendFile(undefined, file, 'workspace', createCodexUsageLineReducer, 1, {
                  maxMilliseconds: Infinity,
                }).record;
                const storage = tempDir('provisional-ledger-');
                saveSpendLedger(storage, 'workspace', [partial]);
                const saved = loadSpendLedger(storage, 'workspace').files;
                assert.equal(saved.length, 1, `disk seam ${seam}`);
                fs.appendFileSync(
                  file,
                  dated
                    .slice(seam)
                    .map((row) => JSON.stringify(row) + '\n')
                    .join(''),
                );
                const resumed = indexSpendFile(saved[0], file, 'workspace', createCodexUsageLineReducer, 2, {
                  maxMilliseconds: Infinity,
                }).record;
                assert.deepEqual(resumed.buckets, fresh.buckets, `dated seam ${seam}`);
                assert.deepEqual(resumed.lifetimeBuckets, fresh.lifetimeBuckets, `lifetime seam ${seam}`);
                const state = resumed.parserState as ReturnType<typeof emptyCodexUsageReducerState>;
                assert.deepEqual(state.pendingRequestKeys, []);
                assert.deepEqual(state.pendingRequestSources, {});
                assert.deepEqual(state.pendingRequests, {});
              }
            }
});

test('Codex provisional associations preserve distinct equal-counter IDs and explicit compaction evidence', () => {
  const exact = usage({ input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 });
  const native = (id: string) => ({
    type: 'token_usage_record',
    timestamp: at(6),
    payload: { turn_id: TURN, response_id: id, usage: exact },
  });
  const count = (multiple: number, id?: string) =>
    event('token_count', 7, {
      ...(id ? { response_id: id } : {}),
      info: {
        last_token_usage: exact,
        total_token_usage: usage({
          input_tokens: 100 * multiple,
          cached_input_tokens: 40 * multiple,
          output_tokens: 10 * multiple,
        }),
      },
    });
  for (const explicit of [false, true])
    for (const nativesFirst of [false, true])
      for (const copiedAt of [0, 5, 7, 9]) {
        const start = [
          meta(),
          event('task_started', 1, { turn_id: TURN }),
          turnContext(2, TURN, 'gpt-5.6-sol', 'high'),
          count(1, explicit ? 'compact' : undefined),
          {
            type: 'compacted',
            timestamp: at(4),
            payload: { latest_token_usage_record: { response_id: 'compact', usage: exact } },
          },
          event('thread_settings_applied', 5, {
            thread_settings: { model: 'gpt-6-astra', model_provider_id: 'openai' },
          }),
        ];
        if (explicit) {
          const identified = createCodexUsageLineReducer();
          const observed = [...start, native('one'), native('two')].flatMap((row) =>
            identified.pushLine(JSON.stringify(row)),
          );
          assert.equal(
            observed.filter((row) => !row.compactionUsage).reduce((sum, row) => sum + (row.usage.requests ?? 1), 0),
            0,
          );
        }
        const ordinary = nativesFirst
          ? [
              native('one'),
              native('two'),
              count(2, explicit ? 'one' : undefined),
              count(3, explicit ? 'two' : undefined),
            ]
          : [
              native('one'),
              count(2, explicit ? 'one' : undefined),
              native('two'),
              count(3, explicit ? 'two' : undefined),
            ];
        const records: Array<{ type: string; timestamp: string; payload: Record<string, unknown> }> = [
          ...start,
          ...ordinary,
        ];
        if (copiedAt)
          records.splice(copiedAt, 0, {
            type: 'turn_context',
            timestamp: at(8),
            payload: { turn_id: TURN, current_date: '2020-01-01' },
          });
        const reducer = createCodexUsageLineReducer();
        const events = records.flatMap((row) => reducer.pushLine(JSON.stringify(row)));
        assert.equal(
          events.filter((row) => !row.compactionUsage).reduce((sum, row) => sum + (row.usage.requests ?? 1), 0),
          copiedAt ? 0 : 2,
        );
        assert.equal(
          events.filter((row) => row.compactionUsage).reduce((sum, row) => sum + (row.usage.requests ?? 1), 0),
          copiedAt ? 0 : 1,
        );
        if (explicit && !copiedAt)
          assert.equal(reducer.snapshot().recentRequestEvents.filter((row) => !row.compactionUsage).length, 2);
        const snapshot = reducer.snapshot();
        assert.equal(snapshot.compactionCount, copiedAt ? 0 : 1);
        assert.deepEqual(snapshot.pendingRequestKeys, []);
        for (let seam = 1; seam <= records.length; seam++) {
          const file = writeRollout(records.slice(0, seam));
          const partial = indexSpendFile(undefined, file, 'workspace', createCodexUsageLineReducer, 1, {
            maxMilliseconds: Infinity,
          }).record;
          const storage = tempDir('provisional-copy-seam-');
          saveSpendLedger(storage, 'workspace', [partial]);
          const saved = loadSpendLedger(storage, 'workspace').files;
          assert.equal(saved.length, 1);
          fs.appendFileSync(
            file,
            records
              .slice(seam)
              .map((row) => JSON.stringify(row) + '\n')
              .join(''),
          );
          const resumed = indexSpendFile(saved[0], file, 'workspace', createCodexUsageLineReducer, 2, {
            maxMilliseconds: Infinity,
          }).record;
          const fresh = indexSpendFile(undefined, file, 'workspace', createCodexUsageLineReducer, 2, {
            maxMilliseconds: Infinity,
          }).record;
          assert.deepEqual(resumed.buckets, fresh.buckets);
          assert.deepEqual(resumed.lifetimeBuckets, fresh.lifetimeBuckets);
          assert.deepEqual(
            (resumed.parserState as ReturnType<typeof emptyCodexUsageReducerState>).pendingRequestKeys,
            [],
          );
        }
        const repeated = reducer.pushLine(JSON.stringify(native('two')));
        assert.deepEqual(repeated, []);
      }
});

test('Codex provisional association eviction preserves partial coverage and bounded histories', () => {
  const exact = usage({ input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 });
  const reducer = createCodexUsageLineReducer();
  const records = [
    meta(),
    event('task_started', 1, { turn_id: TURN }),
    turnContext(2, TURN, 'gpt-5.6-sol', 'high'),
    tokens(3, exact),
    {
      type: 'compacted',
      timestamp: at(4),
      payload: { latest_token_usage_record: { response_id: 'compact', usage: exact } },
    },
    event('thread_settings_applied', 5, { thread_settings: { model: 'gpt-6-astra', model_provider_id: 'openai' } }),
  ];
  const events = records.flatMap((row) => reducer.pushLine(JSON.stringify(row)));
  for (let n = 1; n <= CODEX_USAGE_ASSOCIATION_LIMIT + 2; n++) {
    events.push(
      ...reducer.pushLine(
        JSON.stringify({
          type: 'token_usage_record',
          timestamp: at(6 + n),
          payload: { turn_id: TURN, response_id: `normal-${n}`, usage: exact },
        }),
      ),
    );
    events.push(
      ...reducer.pushLine(
        JSON.stringify(
          event('token_count', 6 + n, {
            info: {
              last_token_usage: exact,
              total_token_usage: usage({
                input_tokens: 100 * (n + 1),
                cached_input_tokens: 40 * (n + 1),
                output_tokens: 10 * (n + 1),
              }),
            },
          }),
        ),
      ),
    );
  }
  const state = reducer.snapshot();
  assert.equal(
    events.filter((row) => !row.compactionUsage).reduce((sum, row) => sum + (row.usage.requests ?? 1), 0),
    CODEX_USAGE_ASSOCIATION_LIMIT + 2,
  );
  assert.ok(events.some((row) => row.requestCountExact === false && !row.compactionUsage));
  assert.ok(state.recentResponseUsage.length <= CODEX_USAGE_ASSOCIATION_LIMIT);
  assert.ok(state.recentRequestEvents.length <= CODEX_USAGE_ASSOCIATION_LIMIT);
  assert.ok(state.compactionResponseIds.length <= CODEX_USAGE_ASSOCIATION_LIMIT);
  assert.ok(state.recentCompactions.length <= RETAINED_COMPACTIONS);
  const restored = createCodexUsageLineReducer(state);
  assert.deepEqual(restored.snapshot(), state);
});
