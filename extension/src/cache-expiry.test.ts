import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  CacheExpiryScan,
  cacheExpiryInputCost,
  cacheExpiryInputUsage,
  classifyCacheExpiry,
  PROJECT_SPEND_PARSER_GENERATION,
  emptyCacheExpiryLedger,
  indexSpendFile,
  loadSpendLedger,
  publicProjectSpendPrice,
  requestCacheLifetime,
  saveSpendLedger,
  sessionCacheFactsBySession,
  type CacheExpiryCarry,
  type CacheExpiryFacts,
  type ProjectUsageBucket,
  type SpendFileIndex,
  type UsageEvent,
  type UsageReducerFactory,
} from './projectspend.ts';
import { createClaudeUsageLineReducer, readClaudeAgentSpend, type ClaudeUsageReducerState } from './transcript.ts';
import { createCodexUsageLineReducer, type CodexUsageReducerState } from './codex.ts';
import { RETAINED_COMPACTIONS } from './parserstate.ts';
import { tempDir } from './temproot.ts';
import { sessionCacheExpiryStats } from './turncard.ts';

const dir = () => tempDir('cache-expiry-');

const MINUTE = 60_000;
const BASE = Date.parse('2026-09-01T09:00:00.000Z');
const at = (minutes: number) => new Date(BASE + minutes * MINUTE).toISOString();

// ## Claude records
//
// A prompt the reader typed, one billed response, and a compaction summary, each in the shape
// Claude Code writes it. Only the fields the usage reducer reads are filled.

const claudePrompt = (minutes: number, id: string) =>
  JSON.stringify({
    type: 'user',
    uuid: `u-${id}`,
    timestamp: at(minutes),
    message: { role: 'user', content: `prompt ${id}` },
  });

const claudeToolResult = (minutes: number, id: string) =>
  JSON.stringify({
    type: 'user',
    uuid: `r-${id}`,
    timestamp: at(minutes),
    toolUseResult: { stdout: 'ok' },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t-${id}`, content: 'ok' }] },
  });

const claudeCompaction = (minutes: number, id: string) =>
  JSON.stringify({
    type: 'user',
    uuid: `c-${id}`,
    timestamp: at(minutes),
    isCompactSummary: true,
    message: { role: 'user', content: 'compacted summary' },
  });

interface ClaudeResponse {
  id: string;
  model?: string;
  input?: number;
  read?: number;
  write5m?: number;
  write1h?: number;
  unsplitWrite?: number;
  tier?: string;
  cost?: number;
}

const claudeResponse = (minutes: number, response: ClaudeResponse) =>
  JSON.stringify({
    type: 'assistant',
    uuid: `a-${response.id}`,
    timestamp: at(minutes),
    message: {
      id: response.id,
      model: response.model ?? 'claude-sonnet-5',
      usage: {
        input_tokens: response.input ?? 0,
        cache_read_input_tokens: response.read ?? 0,
        ...(response.unsplitWrite === undefined ? {} : { cache_creation_input_tokens: response.unsplitWrite }),
        ...(response.write5m || response.write1h
          ? {
              cache_creation: {
                ...(response.write5m ? { ephemeral_5m_input_tokens: response.write5m } : {}),
                ...(response.write1h ? { ephemeral_1h_input_tokens: response.write1h } : {}),
              },
            }
          : {}),
        output_tokens: 5,
        ...(response.tier ? { service_tier: response.tier } : {}),
        ...(response.cost === undefined ? {} : { cost_usd: response.cost }),
      },
    },
  });

// ## Codex records

const CODEX_COUNTS = {
  input_tokens: 0,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
  total_tokens: 0,
};

const codexMeta = (provider = 'openai') =>
  JSON.stringify({
    timestamp: at(0),
    type: 'session_meta',
    payload: { session_id: 'codex-session', id: 'codex-session', cwd: 'c:\\repo', model_provider: provider },
  });

const codexTaskStarted = (minutes: number, turnId: string) =>
  JSON.stringify({
    timestamp: at(minutes),
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: turnId, model_context_window: 272_000 },
  });

const codexTurnContext = (minutes: number, turnId: string, model: string, effort?: string) =>
  JSON.stringify({
    timestamp: at(minutes),
    type: 'turn_context',
    payload: { turn_id: turnId, cwd: 'c:\\repo', model, ...(effort ? { effort } : {}) },
  });

const codexTokens = (minutes: number, counts: Record<string, number>, total = counts) =>
  JSON.stringify({
    timestamp: at(minutes),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        model_context_window: 272_000,
        last_token_usage: { ...CODEX_COUNTS, ...counts },
        total_token_usage: { ...CODEX_COUNTS, ...total },
      },
    },
  });

const codexCompacted = (minutes: number) =>
  JSON.stringify({
    timestamp: at(minutes),
    type: 'compacted',
    payload: { type: 'compacted' },
  });

const codexSettings = (minutes: number, serviceTier: string) =>
  JSON.stringify({
    timestamp: at(minutes),
    type: 'thread_settings_applied',
    payload: { thread_settings: { service_tier: serviceTier } },
  });

const claudeReducer: UsageReducerFactory<ClaudeUsageReducerState> = (state) => createClaudeUsageLineReducer(state);
const codexReducer: UsageReducerFactory<CodexUsageReducerState> = (state) => createCodexUsageLineReducer(state);

function indexed<State>(
  lines: readonly string[],
  makeReducer: UsageReducerFactory<State>,
  previous?: SpendFileIndex,
  budget = {},
): SpendFileIndex {
  const folder = dir();
  const file = path.join(folder, 'source.jsonl');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return indexSpendFile(previous, file, 'w', makeReducer, Date.now(), budget).record;
}

function facts(record: SpendFileIndex): CacheExpiryFacts {
  assert.ok(record.cacheExpiry, 'the source recorded a derived cache-expiry ledger');
  return record.cacheExpiry.facts;
}

// A one-line reading of a source's cache-expiry answer, so a failure names the whole shape
// instead of one field of it.
function summary(record: SpendFileIndex): Record<string, unknown> {
  const result = facts(record);
  return {
    counts: result.counts,
    excluded: result.excluded,
    unavailable: result.unavailable,
    longestGapMs: result.longestGapMs,
    truncated: result.truncated,
  };
}

const NOTHING = {
  counts: { '5m': 0, '30m': 0, '1h': 0 },
  excluded: 0,
  unavailable: 0,
  longestGapMs: null,
  truncated: false,
};

// A new prompt after the cache lifetime records an idle return with cold input.

test('a 30-minute cache crossed by a 31-minute gap reports one exact return', () => {
  const record = indexed(
    [
      codexMeta(),
      codexTaskStarted(1, 'turn-a'),
      codexTurnContext(1, 'turn-a', 'gpt-5.6-sol'),
      codexTokens(2, { input_tokens: 5_000, cache_write_input_tokens: 5_000, total_tokens: 5_000 }),
      codexTaskStarted(33, 'turn-b'),
      codexTurnContext(33, 'turn-b', 'gpt-5.6-sol'),
      codexTokens(33, { input_tokens: 6_000, total_tokens: 11_000 }),
    ],
    codexReducer,
  );

  assert.deepEqual(summary(record), {
    counts: { '5m': 0, '30m': 1, '1h': 0 },
    excluded: 0,
    unavailable: 0,
    longestGapMs: 31 * MINUTE,
    truncated: false,
  });
  const [returned] = facts(record).returns;
  assert.equal(returned.lifetime, '30m');
  assert.equal(returned.request.usage.input, 6_000);
});

test('a 30-minute cache crossed by only 29 minutes reports nothing at all', () => {
  const record = indexed(
    [
      codexMeta(),
      codexTaskStarted(1, 'turn-a'),
      codexTurnContext(1, 'turn-a', 'gpt-5.6-sol'),
      codexTokens(2, { input_tokens: 5_000, cache_write_input_tokens: 5_000, total_tokens: 5_000 }),
      codexTaskStarted(31, 'turn-b'),
      codexTurnContext(31, 'turn-b', 'gpt-5.6-sol'),
      codexTokens(31, { input_tokens: 6_000, total_tokens: 11_000 }),
    ],
    codexReducer,
  );

  assert.deepEqual(summary(record), NOTHING);
});

test('a Claude 5-minute write and a Claude 1-hour write each report their own lifetime', () => {
  const short = indexed(
    [
      claudePrompt(0, 'p1'),
      claudeResponse(1, { id: 'm1', input: 100, write5m: 4_000 }),
      claudePrompt(8, 'p2'),
      claudeResponse(8, { id: 'm2', input: 5_000, write5m: 1_000 }),
    ],
    claudeReducer,
  );
  assert.deepEqual(summary(short), {
    counts: { '5m': 1, '30m': 0, '1h': 0 },
    excluded: 0,
    unavailable: 0,
    longestGapMs: 7 * MINUTE,
    truncated: false,
  });

  const long = indexed(
    [
      claudePrompt(0, 'p1'),
      claudeResponse(1, { id: 'm1', input: 100, write1h: 4_000 }),
      claudePrompt(62, 'p2'),
      claudeResponse(62, { id: 'm2', input: 5_000, write1h: 1_000 }),
    ],
    claudeReducer,
  );
  assert.deepEqual(summary(long), {
    counts: { '5m': 0, '30m': 0, '1h': 1 },
    excluded: 0,
    unavailable: 0,
    longestGapMs: 61 * MINUTE,
    truncated: false,
  });
});

test('a 1-hour cache returned to after 59 minutes reports nothing', () => {
  const record = indexed(
    [
      claudePrompt(0, 'p1'),
      claudeResponse(1, { id: 'm1', input: 100, write1h: 4_000 }),
      claudePrompt(60, 'p2'),
      claudeResponse(60, { id: 'm2', input: 5_000, write1h: 1_000 }),
    ],
    claudeReducer,
  );

  assert.deepEqual(summary(record), NOTHING);
});

// ## What must never count
//
// These lifetime-crossing gaps do not represent idle returns to a new visible turn.

test('a long tool execution inside one visible turn is not an idle return', () => {
  const record = indexed(
    [
      claudePrompt(0, 'p1'),
      claudeResponse(1, { id: 'm1', input: 100, write1h: 4_000 }),
      claudeToolResult(70, 'r1'),
      claudeResponse(75, { id: 'm2', input: 5_000, write1h: 1_000 }),
    ],
    claudeReducer,
  );

  assert.deepEqual(summary(record), NOTHING);
});

test('several requests inside one visible turn never compare against each other', () => {
  const record = indexed(
    [
      codexMeta(),
      codexTaskStarted(1, 'turn-a'),
      codexTurnContext(1, 'turn-a', 'gpt-5.6-sol'),
      codexTokens(2, { input_tokens: 5_000, cache_write_input_tokens: 5_000, total_tokens: 5_000 }),
      codexTokens(40, { input_tokens: 6_000, total_tokens: 11_000 }),
      codexTokens(90, { input_tokens: 7_000, total_tokens: 18_000 }),
    ],
    codexReducer,
  );

  assert.deepEqual(summary(record), NOTHING);
});

test('a compaction between the two requests is excluded, not counted as an idle return', () => {
  const record = indexed(
    [
      claudePrompt(0, 'p1'),
      claudeResponse(1, { id: 'm1', input: 100, write1h: 4_000 }),
      claudeCompaction(30, 'c1'),
      claudePrompt(62, 'p2'),
      claudeResponse(62, { id: 'm2', input: 5_000, write1h: 1_000 }),
    ],
    claudeReducer,
  );

  assert.deepEqual(summary(record), { ...NOTHING, excluded: 1 });
});

test('a model change between the two requests is excluded', () => {
  const record = indexed(
    [
      claudePrompt(0, 'p1'),
      claudeResponse(1, { id: 'm1', model: 'claude-sonnet-5', input: 100, write1h: 4_000 }),
      claudePrompt(62, 'p2'),
      claudeResponse(62, { id: 'm2', model: 'claude-opus-5', input: 5_000, write1h: 1_000 }),
    ],
    claudeReducer,
  );

  assert.deepEqual(summary(record), { ...NOTHING, excluded: 1 });
});

test('a service-tier change between the two requests is excluded', () => {
  const record = indexed(
    [
      claudePrompt(0, 'p1'),
      claudeResponse(1, { id: 'm1', input: 100, write1h: 4_000, tier: 'standard' }),
      claudePrompt(62, 'p2'),
      claudeResponse(62, { id: 'm2', input: 5_000, write1h: 1_000, tier: 'priority' }),
    ],
    claudeReducer,
  );

  assert.deepEqual(summary(record), { ...NOTHING, excluded: 1 });
});

test('a provider change between the two requests is excluded', () => {
  const record = indexed(
    [
      codexMeta('openai'),
      codexTaskStarted(1, 'turn-a'),
      codexTurnContext(1, 'turn-a', 'gpt-5.6-sol'),
      codexTokens(2, { input_tokens: 5_000, cache_write_input_tokens: 5_000, total_tokens: 5_000 }),
      JSON.stringify({
        timestamp: at(32),
        type: 'thread_settings_applied',
        payload: { thread_settings: { model_provider_id: 'amazon-bedrock' } },
      }),
      codexTaskStarted(33, 'turn-b'),
      codexTurnContext(33, 'turn-b', 'gpt-5.6-sol'),
      codexTokens(33, { input_tokens: 6_000, total_tokens: 11_000 }),
    ],
    codexReducer,
  );

  assert.deepEqual(summary(record), { ...NOTHING, excluded: 1 });
});

test('an unknown lifetime on the earlier request stays unavailable rather than zero', () => {
  const record = indexed(
    [
      claudePrompt(0, 'p1'),
      // A response that only read a cache names no lifetime, and no Claude price row carries
      // one either. The record cannot say when that cache would have expired.
      claudeResponse(1, { id: 'm1', input: 0, read: 4_000 }),
      claudePrompt(62, 'p2'),
      claudeResponse(62, { id: 'm2', input: 5_000, write1h: 1_000 }),
    ],
    claudeReducer,
  );

  assert.deepEqual(summary(record), { ...NOTHING, unavailable: 1 });
});

test('delayed Codex turn contexts keep their effort changes on the requests they release', () => {
  const record = indexed(
    [
      codexMeta(),
      codexTaskStarted(1, 'turn-a'),
      codexTokens(2, { input_tokens: 5_000, cache_write_input_tokens: 5_000, total_tokens: 5_000 }),
      codexTurnContext(3, 'turn-a', 'gpt-5.6-sol', 'high'),
      codexTaskStarted(34, 'turn-b'),
      codexTokens(34, { input_tokens: 6_000, total_tokens: 11_000 }),
      codexTurnContext(35, 'turn-b', 'gpt-5.6-sol', 'xhigh'),
    ],
    codexReducer,
  );

  assert.deepEqual(summary(record), { ...NOTHING, excluded: 1 });
});

test('requests under no recorded prompt stay unavailable rather than counting as one turn', () => {
  // A transcript whose typed prompts sit outside the scanned bytes still bills requests. Two
  // requests with no visible turn are not evidence that they shared one.
  const record = indexed(
    [
      claudeResponse(1, { id: 'm1', input: 100, write1h: 4_000 }),
      claudeResponse(62, { id: 'm2', input: 5_000, write1h: 1_000 }),
    ],
    claudeReducer,
  );

  assert.deepEqual(summary(record), { ...NOTHING, unavailable: 1 });
});

test('a request whose usage the record does not carry stays unavailable', () => {
  const record = indexed(
    [
      codexMeta(),
      codexTaskStarted(1, 'turn-a'),
      codexTurnContext(1, 'turn-a', 'gpt-5.6-sol'),
      codexTokens(2, { input_tokens: 5_000, cache_write_input_tokens: 5_000, total_tokens: 5_000 }),
      codexTaskStarted(33, 'turn-b'),
      codexTurnContext(33, 'turn-b', 'gpt-5.6-sol'),
      JSON.stringify({
        timestamp: at(33),
        type: 'event_msg',
        payload: { type: 'token_count', info: { model_context_window: 272_000 } },
      }),
    ],
    codexReducer,
  );

  assert.deepEqual(summary(record), { ...NOTHING, unavailable: 1 });
});

test('a fully warm return after the lifetime counts as nothing in every category', () => {
  const record = indexed(
    [
      codexMeta(),
      codexTaskStarted(1, 'turn-a'),
      codexTurnContext(1, 'turn-a', 'gpt-5.6-sol'),
      codexTokens(2, { input_tokens: 5_000, cache_write_input_tokens: 5_000, total_tokens: 5_000 }),
      codexTaskStarted(33, 'turn-b'),
      codexTurnContext(33, 'turn-b', 'gpt-5.6-sol'),
      codexTokens(33, { input_tokens: 6_000, cached_input_tokens: 6_000, total_tokens: 11_000 }),
    ],
    codexReducer,
  );

  assert.deepEqual(summary(record), NOTHING);
});

test('a partly warm return keeps its own categories and attributes only its cold input', () => {
  const record = indexed(
    [
      codexMeta(),
      codexTaskStarted(1, 'turn-a'),
      codexTurnContext(1, 'turn-a', 'gpt-5.6-sol'),
      codexTokens(2, { input_tokens: 5_000, cache_write_input_tokens: 5_000, total_tokens: 5_000 }),
      codexTaskStarted(33, 'turn-b'),
      codexTurnContext(33, 'turn-b', 'gpt-5.6-sol'),
      codexTokens(33, { input_tokens: 6_000, cached_input_tokens: 4_000, total_tokens: 11_000 }),
    ],
    codexReducer,
  );

  const result = facts(record);
  assert.deepEqual(result.counts, { '5m': 0, '30m': 1, '1h': 0 });
  const [returned] = result.returns;
  assert.equal(returned.request.usage.input, 2_000);
  assert.equal(returned.request.usage.cacheRead, 4_000, 'the observed warm half is retained');
  assert.equal(
    cacheExpiryInputUsage(returned.request).usage.cacheRead,
    0,
    'the warm half never reaches the attributed input figure',
  );
  assert.equal(cacheExpiryInputUsage(returned.request).usage.input, 2_000);
});

// ## Recording the same request twice

test('a Claude response written as several records counts one return, not several', () => {
  const record = indexed(
    [
      claudePrompt(0, 'p1'),
      claudeResponse(1, { id: 'm1', input: 100, write1h: 4_000 }),
      claudePrompt(62, 'p2'),
      claudeResponse(62, { id: 'm2', input: 5_000, write1h: 1_000 }),
      claudeResponse(62, { id: 'm2', input: 5_000, write1h: 1_000 }),
      claudeResponse(63, { id: 'm2', input: 5_000, write1h: 1_000 }),
    ],
    claudeReducer,
  );

  assert.deepEqual(summary(record), {
    counts: { '5m': 0, '30m': 0, '1h': 1 },
    excluded: 0,
    unavailable: 0,
    longestGapMs: 61 * MINUTE,
    truncated: false,
  });
});

test('a repeated Codex usage snapshot counts one return, not two', () => {
  const cold = { input_tokens: 6_000, total_tokens: 11_000 };
  const record = indexed(
    [
      codexMeta(),
      codexTaskStarted(1, 'turn-a'),
      codexTurnContext(1, 'turn-a', 'gpt-5.6-sol'),
      codexTokens(2, { input_tokens: 5_000, cache_write_input_tokens: 5_000, total_tokens: 5_000 }),
      codexTaskStarted(33, 'turn-b'),
      codexTurnContext(33, 'turn-b', 'gpt-5.6-sol'),
      codexTokens(33, cold),
      codexTokens(34, cold),
    ],
    codexReducer,
  );

  assert.deepEqual(summary(record), {
    counts: { '5m': 0, '30m': 1, '1h': 0 },
    excluded: 0,
    unavailable: 0,
    longestGapMs: 31 * MINUTE,
    truncated: false,
  });
});

// ## Reading the same bytes in pieces

test('an incremental rescan gives the same answer as one whole scan', () => {
  const lines = [
    claudePrompt(0, 'p1'),
    claudeResponse(1, { id: 'm1', input: 100, write1h: 4_000 }),
    claudePrompt(62, 'p2'),
    claudeResponse(62, { id: 'm2', input: 5_000, write1h: 1_000 }),
    claudePrompt(130, 'p3'),
    claudeResponse(130, { id: 'm3', input: 7_000, write1h: 1_000 }),
  ];
  const whole = indexed(lines, claudeReducer);

  const folder = dir();
  const file = path.join(folder, 'source.jsonl');
  let previous: SpendFileIndex | undefined;
  for (let held = 1; held <= lines.length; held++) {
    fs.writeFileSync(file, `${lines.slice(0, held).join('\n')}\n`);
    previous = indexSpendFile(previous, file, 'w', claudeReducer, Date.now() + held).record;
  }

  assert.deepEqual(summary(previous!), summary(whole));
  assert.deepEqual(
    previous!.cacheExpiry!.facts.returns.map((item) => item.gapMs),
    whole.cacheExpiry!.facts.returns.map((item) => item.gapMs),
  );
});

test('a byte-budgeted scan resumed across a line boundary gives the same answer', () => {
  const lines = [
    claudePrompt(0, 'p1'),
    claudeResponse(1, { id: 'm1', input: 100, write1h: 4_000 }),
    claudePrompt(62, 'p2'),
    claudeResponse(62, { id: 'm2', input: 5_000, write1h: 1_000 }),
  ];
  const whole = indexed(lines, claudeReducer);

  const folder = dir();
  const file = path.join(folder, 'source.jsonl');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  let record = indexSpendFile(undefined, file, 'w', claudeReducer, Date.now(), { maxBytes: 64 }).record;
  let guard = 0;
  while (record.complete === false && guard++ < 200) {
    record = indexSpendFile(record, file, 'w', claudeReducer, Date.now(), { maxBytes: 64 }).record;
  }

  assert.equal(record.complete, true);
  assert.deepEqual(summary(record), summary(whole));
});

// Retained compaction usage and context facts.

test('a compaction retains its recorded time, both context sizes, and its later requests', () => {
  const record = indexed(
    [
      claudePrompt(0, 'p1'),
      claudeResponse(1, { id: 'm1', input: 100, read: 40_000, write1h: 4_000 }),
      claudeCompaction(10, 'c1'),
      claudePrompt(11, 'p2'),
      claudeResponse(11, { id: 'm2', input: 9_000, write1h: 1_000 }),
      claudeResponse(12, { id: 'm3', input: 200, read: 10_000 }),
    ],
    claudeReducer,
  );

  assert.deepEqual(record.cacheExpiry!.compactions, [
    {
      ordinal: 1,
      at: Date.parse(at(10)),
      trigger: null,
      contextBefore: 44_100,
      contextAfter: 10_000,
      requestsAfter: 2,
      firstRequestAfter: record.cacheExpiry!.compactions[0].firstRequestAfter,
      // A Claude compaction summary bills no request of its own.
      requestUsage: null,
      requestModel: null,
      requestProvider: null,
      requestServiceTier: null,
      requestContextWindow: null,
    },
  ]);
  assert.equal(record.cacheExpiry!.compactions[0].firstRequestAfter!.usage.input, 9_000);
});

test('a Codex compaction is dated from its own record', () => {
  const record = indexed(
    [
      codexMeta(),
      codexTaskStarted(1, 'turn-a'),
      codexTurnContext(1, 'turn-a', 'gpt-5.6-sol'),
      codexTokens(2, { input_tokens: 5_000, cache_write_input_tokens: 5_000, total_tokens: 5_000 }),
      codexCompacted(6),
      codexTaskStarted(7, 'turn-b'),
      codexTurnContext(7, 'turn-b', 'gpt-5.6-sol'),
      codexTokens(7, { input_tokens: 900, total_tokens: 5_900 }),
    ],
    codexReducer,
  );

  assert.equal(record.compactionCount, 1);
  assert.deepEqual(
    record.cacheExpiry!.compactions.map((item) => [item.ordinal, item.at, item.contextBefore, item.contextAfter]),
    [[1, Date.parse(at(6)), 5_000, 900]],
  );
});

test('a compaction that ends a session still keeps its time and the context before it', () => {
  const record = indexed(
    [
      claudePrompt(0, 'p1'),
      claudeResponse(1, { id: 'm1', input: 100, read: 40_000, write1h: 4_000 }),
      claudeCompaction(10, 'c1'),
    ],
    claudeReducer,
  );

  assert.equal(record.compactionCount, 1);
  assert.deepEqual(record.cacheExpiry!.compactions, [
    {
      ordinal: 1,
      at: Date.parse(at(10)),
      trigger: null,
      contextBefore: 44_100,
      contextAfter: null,
      requestsAfter: 0,
      firstRequestAfter: null,
      requestUsage: null,
      requestModel: null,
      requestProvider: null,
      requestServiceTier: null,
      requestContextWindow: null,
    },
  ]);
});

test('incomplete post-compaction usage stays unavailable through reduction and scan', () => {
  const lines = [
    codexMeta(),
    codexTaskStarted(1, 'turn-a'),
    codexTurnContext(1, 'turn-a', 'gpt-5.6-sol'),
    codexTokens(2, { input_tokens: 5_000, cache_write_input_tokens: 5_000, total_tokens: 5_000 }),
    codexCompacted(6),
    codexTaskStarted(7, 'turn-b'),
    codexTurnContext(7, 'turn-b', 'gpt-5.6-sol'),
    JSON.stringify({
      timestamp: at(7),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { model_context_window: 272_000 },
      },
    }),
  ];
  const reducer = createCodexUsageLineReducer();
  const events = lines.flatMap((line) => reducer.pushLine(line));
  assert.equal(events.at(-1)?.incomplete, true, 'the missing request usage was reduced as a complete zero');

  const fact = indexed(lines, codexReducer).cacheExpiry!.compactions[0];
  assert.equal(fact.contextAfter, null, 'the incomplete request became a zero-token context');
  assert.equal(fact.firstRequestAfter?.incomplete, true);
});

test('a request after a session-ending compaction completes that same fact, not a second one', () => {
  const lines = [
    claudePrompt(0, 'p1'),
    claudeResponse(1, { id: 'm1', input: 100, read: 40_000, write1h: 4_000 }),
    claudeCompaction(10, 'c1'),
  ];
  const folder = dir();
  const file = path.join(folder, 'source.jsonl');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const trailing = indexSpendFile(undefined, file, 'w', claudeReducer, Date.now()).record;
  assert.equal(trailing.cacheExpiry!.compactions.length, 1);

  fs.writeFileSync(
    file,
    `${[...lines, claudePrompt(11, 'p2'), claudeResponse(11, { id: 'm2', input: 9_000, write1h: 1_000 })].join('\n')}\n`,
  );
  const grown = indexSpendFile(trailing, file, 'w', claudeReducer, Date.now() + 1).record;

  assert.equal(grown.cacheExpiry!.compactions.length, 1, 'the request completed the open fact');
  assert.deepEqual(
    [
      grown.cacheExpiry!.compactions[0].contextBefore,
      grown.cacheExpiry!.compactions[0].contextAfter,
      grown.cacheExpiry!.compactions[0].requestsAfter,
    ],
    [44_100, 10_000, 1],
  );
});

// ## Abandoned and replayed compactions
//
// Claude Code can write a compaction that the session then leaves: the next prompt names a
// record from before the compaction as its parent. It can also replay a stretch of the file with
// the same record ids.

const linked = (line: string, parentUuid: string | null) => JSON.stringify({ ...JSON.parse(line), parentUuid });

const claudeCompactCommand = (minutes: number, id: string) =>
  JSON.stringify({ ...JSON.parse(claudePrompt(minutes, id)), message: { role: 'user', content: '/compact' } });

// A manual compaction as Claude Code writes it. The boundary links back only through
// `logicalParentUuid`, and the summary names the boundary.
const claudeLinkedCompaction = (minutes: number, id: string, logicalParentUuid: string) => [
  JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    uuid: `b-${id}`,
    parentUuid: null,
    logicalParentUuid,
    timestamp: at(minutes),
    compactMetadata: { trigger: 'manual', preTokens: 40_000, postTokens: 2_000, durationMs: 30_000 },
  }),
  linked(claudeCompaction(minutes, id), `b-${id}`),
];

const SIXTEEN_HOURS = 16 * 60;

// Compaction A is kept. Compaction B is abandoned: the prompt 16 hours later names the last
// answer before B's command. A stretch holding compaction A then replays with the same ids, and
// compaction C is kept.
function abandonedCompactionLines(): string[] {
  return [
    claudePrompt(0, 'p1'),
    linked(claudeResponse(1, { id: 'm1', input: 100, read: 40_000, write1h: 4_000 }), 'u-p1'),
    ...claudeLinkedCompaction(10, 'A', 'a-m1'),
    linked(claudePrompt(11, 'p2'), 'c-A'),
    linked(claudeResponse(11, { id: 'm2', input: 2, write1h: 20_000 }), 'u-p2'),
    linked(claudePrompt(20, 'p3'), 'a-m2'),
    linked(claudeResponse(20, { id: 'm3', input: 2, read: 20_000, write1h: 1_000 }), 'u-p3'),
    linked(claudeCompactCommand(30, 'compact-b'), 'a-m3'),
    ...claudeLinkedCompaction(31, 'B', 'u-compact-b'),
    linked(claudePrompt(30 + SIXTEEN_HOURS, 'p4'), 'a-m3'),
    linked(claudeResponse(30 + SIXTEEN_HOURS, { id: 'm4', input: 2, read: 1_000, write1h: 21_000 }), 'u-p4'),
    ...claudeLinkedCompaction(10, 'A', 'a-m1'),
    linked(claudeResponse(11, { id: 'm2', input: 2, write1h: 20_000 }), 'u-p2'),
    linked(claudePrompt(1_000, 'p5'), 'a-m4'),
    linked(claudeResponse(1_000, { id: 'm5', input: 2, read: 22_000, write1h: 500 }), 'u-p5'),
    ...claudeLinkedCompaction(1_080, 'C', 'a-m5'),
    linked(claudePrompt(1_081, 'p6'), 'c-C'),
    linked(claudeResponse(1_081, { id: 'm6', input: 2, write1h: 25_000 }), 'u-p6'),
  ];
}

test('an abandoned compaction before a 16-hour gap leaves that gap counted as one cache expiry', () => {
  const record = indexed(abandonedCompactionLines(), claudeReducer);

  assert.equal(record.compactionCount, 2, 'compaction B was abandoned and compaction A was replayed');
  assert.deepEqual(summary(record), {
    counts: { '5m': 0, '30m': 0, '1h': 1 },
    excluded: 1,
    unavailable: 0,
    longestGapMs: 970 * MINUTE,
    truncated: false,
  });
  assert.deepEqual(
    record.cacheExpiry!.facts.returns.map((item) => [item.lifetime, item.gapMs, item.request.usage.cacheWrite1h]),
    [['1h', 970 * MINUTE, 21_000]],
  );
  assert.deepEqual(
    record.cacheExpiry!.compactions.map((item) => [
      item.ordinal,
      item.at,
      item.contextBefore,
      item.contextAfter,
      item.requestsAfter,
    ]),
    [
      [1, Date.parse(at(10)), 44_100, 20_002, 4],
      [2, Date.parse(at(1_080)), 22_502, 25_002, 1],
    ],
  );
  assert.deepEqual(
    sessionCacheExpiryStats(facts(record)).map((stat) => stat.label),
    ['1 cache expiry'],
  );
});

test('an abandoned compaction still bills the request that wrote its summary', () => {
  const reducer = createClaudeUsageLineReducer();
  const estimates = abandonedCompactionLines()
    .flatMap((line) => reducer.pushLine(line))
    .filter((event) => event.compactionEstimate);

  const abandoned = estimates.filter((event) => event.timestamp === Date.parse(at(31)));
  assert.equal(abandoned.length, 1, 'the summary request for compaction B left the totals');
  assert.ok(abandoned[0].usage.output > 0);
});

test('a slice that ends between an abandoned summary and the prompt that leaves it gives the whole-scan answer', () => {
  const lines = abandonedCompactionLines();
  const whole = indexed(lines, claudeReducer);
  const folder = dir();
  const file = path.join(folder, 'source.jsonl');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const summaryLine = lines.indexOf(linked(claudeCompaction(31, 'B'), 'b-B'));
  const firstBytes = Buffer.byteLength(`${lines.slice(0, summaryLine + 1).join('\n')}\n`);

  const first = indexSpendFile(undefined, file, 'w', claudeReducer, Date.now(), { maxBytes: firstBytes }).record;
  assert.equal(first.offset, firstBytes, 'the first slice ended after compaction B');
  assert.equal(first.compactionCount, 2, 'compaction B counts until a later record leaves it');
  const rest = indexSpendFile(first, file, 'w', claudeReducer, Date.now() + 1, { maxBytes: 1 << 20 }).record;

  assert.equal(rest.complete, true);
  assert.equal(rest.compactionCount, 2);
  assert.deepEqual(summary(rest), summary(whole));
  assert.deepEqual(rest.cacheExpiry!.compactions, whole.cacheExpiry!.compactions);
});

test('a kept compaction stays counted without parent links and across linked attachment lines', () => {
  const unlinked = [
    claudePrompt(0, 'p1'),
    claudeResponse(1, { id: 'm1', input: 100, write1h: 4_000 }),
    claudeCompaction(10, 'c1'),
    claudePrompt(11, 'p2'),
    claudeResponse(11, { id: 'm2', input: 2, write1h: 2_000 }),
  ];
  assert.equal(indexed(unlinked, claudeReducer).compactionCount, 1);

  const attached = [
    claudePrompt(0, 'p1'),
    linked(claudeResponse(1, { id: 'm1', input: 100, write1h: 4_000 }), 'u-p1'),
    ...claudeLinkedCompaction(10, 'A', 'a-m1'),
    JSON.stringify({
      type: 'attachment',
      uuid: 'att-1',
      parentUuid: 'c-A',
      timestamp: at(10),
      attachment: { type: 'deferred_tools_delta', addedNames: [], removedNames: [] },
    }),
    JSON.stringify({
      type: 'system',
      subtype: 'local_command',
      uuid: 'sys-1',
      parentUuid: 'att-1',
      timestamp: at(10),
      content: '<local-command-stdout>Compacted</local-command-stdout>',
    }),
    linked(claudePrompt(11, 'p2'), 'sys-1'),
    linked(claudeResponse(11, { id: 'm2', input: 2, write1h: 2_000 }), 'u-p2'),
  ];
  assert.equal(indexed(attached, claudeReducer).compactionCount, 1);
});

test('revoking a compaction from a full retained list leaves a state that loads again', () => {
  const lines = [claudePrompt(0, 'p0'), linked(claudeResponse(1, { id: 'm0', input: 100, write1h: 4_000 }), 'u-p0')];
  let parent = 'a-m0';
  for (let n = 1; n <= RETAINED_COMPACTIONS; n++) {
    const minute = n * 10;
    lines.push(
      ...claudeLinkedCompaction(minute, `k${n}`, parent),
      linked(claudePrompt(minute + 1, `p${n}`), `c-k${n}`),
      linked(claudeResponse(minute + 1, { id: `m${n}`, input: 2, write1h: 2_000 }), `u-p${n}`),
    );
    parent = `a-m${n}`;
  }
  const last = (RETAINED_COMPACTIONS + 1) * 10;
  lines.push(...claudeLinkedCompaction(last, 'gone', parent), linked(claudePrompt(last + 1, 'back'), parent));
  const record = indexed(lines, claudeReducer);

  assert.equal(record.compactionCount, RETAINED_COMPACTIONS);
  assert.deepEqual(
    (record.parserState as ClaudeUsageReducerState).recentCompactions.map((item) => item.ordinal),
    Array.from({ length: RETAINED_COMPACTIONS }, (_, index) => index + 1),
  );
  const storage = dir();
  saveSpendLedger(storage, 'w', [record]);
  assert.equal(loadSpendLedger(storage, 'w').files.length, 1, 'the saved state survived its own validation');
});

test('a replayed compaction counts once, and a replayed abandoned compaction never counts', () => {
  const opening = [claudePrompt(0, 'p1'), linked(claudeResponse(1, { id: 'm1', input: 100, write1h: 4_000 }), 'u-p1')];
  const kept = [
    ...opening,
    ...claudeLinkedCompaction(10, 'A', 'a-m1'),
    linked(claudePrompt(11, 'p2'), 'c-A'),
    linked(claudeResponse(11, { id: 'm2', input: 2, write1h: 2_000 }), 'u-p2'),
    ...claudeLinkedCompaction(10, 'A', 'a-m1'),
  ];
  assert.equal(indexed(kept, claudeReducer).compactionCount, 1);
  const reducer = createClaudeUsageLineReducer();
  assert.equal(kept.flatMap((line) => reducer.pushLine(line)).filter((event) => event.compactionEstimate).length, 1);

  const abandoned = [
    ...opening,
    ...claudeLinkedCompaction(10, 'B', 'a-m1'),
    linked(claudePrompt(11, 'p2'), 'a-m1'),
    linked(claudeResponse(11, { id: 'm2', input: 2, write1h: 2_000 }), 'u-p2'),
    ...claudeLinkedCompaction(10, 'B', 'a-m1'),
  ];
  assert.equal(indexed(abandoned, claudeReducer).compactionCount, 0);
});

const opening = () => [
  claudePrompt(0, 'p1'),
  linked(claudeResponse(1, { id: 'm1', input: 100, read: 40_000, write1h: 4_000 }), 'u-p1'),
];

const nextResponse = (minutes: number, id: string, parent: string) =>
  linked(claudeResponse(minutes, { id, input: 2, write1h: 2_000 }), parent);

test('a replayed record between a summary and the prompt after it never decides the compaction', () => {
  const [prompt, answer] = opening();
  const compaction = claudeLinkedCompaction(10, 'A', 'a-m1');
  const replayedAnswer = [
    prompt,
    answer,
    ...compaction,
    answer,
    linked(claudePrompt(11, 'p2'), 'c-A'),
    nextResponse(11, 'm2', 'u-p2'),
  ];
  assert.equal(indexed(replayedAnswer, claudeReducer).compactionCount, 1, 'a replayed answer revoked the compaction');

  const replayedPrompt = [
    prompt,
    answer,
    ...compaction,
    prompt,
    linked(claudePrompt(11, 'p2'), 'a-m1'),
    nextResponse(11, 'm2', 'u-p2'),
  ];
  assert.equal(indexed(replayedPrompt, claudeReducer).compactionCount, 0, 'a replayed prompt kept the compaction');

  // The replayed answer is older than the retained ids, so only its request key shows it was read.
  const early = [prompt, answer];
  let parent = 'a-m1';
  for (let n = 2; n <= 6; n++) {
    early.push(linked(claudePrompt(n * 2, `p${n}`), parent), nextResponse(n * 2 + 1, `m${n}`, `u-p${n}`));
    parent = `a-m${n}`;
  }
  early.push(
    ...claudeLinkedCompaction(30, 'B', parent),
    answer,
    linked(claudePrompt(31, 'q'), parent),
    nextResponse(31, 'mq', 'u-q'),
  );
  assert.equal(indexed(early, claudeReducer).compactionCount, 0, 'a replayed early answer kept the compaction');
});

test('a billed answer decides a compaction, and a synthetic answer does not', () => {
  const compaction = [...opening(), ...claudeLinkedCompaction(10, 'A', 'a-m1')];
  assert.equal(indexed([...compaction, nextResponse(11, 'm2', 'a-m1')], claudeReducer).compactionCount, 0);
  assert.equal(indexed([...compaction, nextResponse(11, 'm2', 'c-A')], claudeReducer).compactionCount, 1);

  const synthetic = linked(claudeResponse(10, { id: 'syn', model: '<synthetic>', input: 1 }), 'a-m1');
  const lines = [...compaction, synthetic, linked(claudePrompt(11, 'p2'), 'c-A'), nextResponse(11, 'm2', 'u-p2')];
  assert.equal(indexed(lines, claudeReducer).compactionCount, 1, 'a synthetic answer revoked the compaction');
});

// The earlier compaction stays counted. The later one froze the same parents, because no answer
// or prompt sits between them, so a prompt that names a record from before both revokes it.
test('two compactions before one deciding prompt keep the earlier one counted', () => {
  const both = [...opening(), ...claudeLinkedCompaction(10, 'A', 'a-m1'), ...claudeLinkedCompaction(12, 'B', 'c-A')];
  const left = indexed(
    [...both, linked(claudePrompt(13, 'p2'), 'a-m1'), nextResponse(13, 'm2', 'u-p2')],
    claudeReducer,
  );
  assert.equal(left.compactionCount, 1);
  assert.deepEqual(
    (left.parserState as ClaudeUsageReducerState).recentCompactions.map((item) => item.at),
    [Date.parse(at(10))],
  );
  const kept = indexed([...both, linked(claudePrompt(13, 'p2'), 'c-B'), nextResponse(13, 'm2', 'u-p2')], claudeReducer);
  assert.equal(kept.compactionCount, 2);
});

test('a summary that a prompt leaves before its boundary arrives still bills its request', () => {
  const [boundary, summaryLine] = claudeLinkedCompaction(10, 'A', 'a-m1');
  const folder = dir();
  for (const [parent, count] of [
    ['a-m1', 0],
    ['c-A', 1],
  ] as const) {
    const lines = [
      ...opening(),
      summaryLine,
      linked(claudePrompt(10, 'p2'), parent),
      boundary,
      nextResponse(11, 'm2', 'u-p2'),
    ];
    const reducer = createClaudeUsageLineReducer();
    const estimates = lines.flatMap((line) => reducer.pushLine(line)).filter((event) => event.compactionEstimate);
    assert.equal(reducer.compactionCount(), count);
    assert.equal(estimates.length, 1, `the summary request left the totals when the prompt named ${parent}`);
    const file = path.join(folder, `${parent}.jsonl`);
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    const own = readClaudeAgentSpend(file, [], false)
      .models.flatMap((model) => model.usageParts ?? [])
      .filter((part) => part.compactionEstimate);
    assert.deepEqual(
      own.map((part) => part.usage),
      estimates.map((event) => event.usage),
      'the own-spend read and the usage reducer price the summary request differently',
    );
  }
});

test('a slice that ends after a summary at full retention keeps every reached compaction fact', () => {
  const lines = [claudePrompt(0, 'p0'), linked(claudeResponse(1, { id: 'm0', input: 100, write1h: 4_000 }), 'u-p0')];
  let parent = 'a-m0';
  for (let n = 1; n <= RETAINED_COMPACTIONS; n++) {
    const minute = n * 10;
    lines.push(
      ...claudeLinkedCompaction(minute, `k${n}`, parent),
      linked(claudePrompt(minute + 1, `p${n}`), `c-k${n}`),
      nextResponse(minute + 1, `m${n}`, `u-p${n}`),
    );
    parent = `a-m${n}`;
  }
  const last = (RETAINED_COMPACTIONS + 1) * 10;
  lines.push(...claudeLinkedCompaction(last, 'gone', parent));
  const firstBytes = Buffer.byteLength(`${lines.join('\n')}\n`);
  lines.push(linked(claudePrompt(last + 1, 'back'), parent), nextResponse(last + 1, 'mb', 'u-back'));
  const whole = indexed(lines, claudeReducer);
  const folder = dir();
  const file = path.join(folder, 'source.jsonl');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);

  const first = indexSpendFile(undefined, file, 'w', claudeReducer, Date.now(), { maxBytes: firstBytes }).record;
  assert.equal(first.offset, firstBytes, 'the first slice ended after the last summary');
  const storage = dir();
  saveSpendLedger(storage, 'w', [first]);
  const [saved] = loadSpendLedger(storage, 'w').files;
  assert.ok(saved, 'the saved slice survived its own validation');
  const rest = indexSpendFile(saved, file, 'w', claudeReducer, Date.now() + 1, { maxBytes: 1 << 20 }).record;

  assert.equal(rest.compactionCount, RETAINED_COMPACTIONS);
  assert.equal(whole.cacheExpiry!.compactions.length, RETAINED_COMPACTIONS);
  assert.deepEqual(rest.cacheExpiry, whole.cacheExpiry);
});

test('a compaction with no usable clock never shifts another compaction time onto itself', () => {
  const undated = JSON.stringify({
    type: 'user',
    uuid: 'c-undated',
    isCompactSummary: true,
    message: { role: 'user', content: 'compacted summary' },
  });
  const record = indexed(
    [
      claudePrompt(0, 'p1'),
      claudeResponse(1, { id: 'm1', input: 100, write1h: 4_000 }),
      claudeCompaction(10, 'c1'),
      claudePrompt(11, 'p2'),
      claudeResponse(11, { id: 'm2', input: 900, write1h: 100 }),
      undated,
      claudePrompt(12, 'p3'),
      claudeResponse(12, { id: 'm3', input: 800, write1h: 100 }),
      claudeCompaction(13, 'c3'),
      claudePrompt(14, 'p4'),
      claudeResponse(14, { id: 'm4', input: 700, write1h: 100 }),
    ],
    claudeReducer,
  );

  assert.equal(record.compactionCount, 3);
  assert.deepEqual(
    record.cacheExpiry!.compactions.map((item) => [item.ordinal, item.at]),
    [
      [1, Date.parse(at(10))],
      [2, null],
      [3, Date.parse(at(13))],
    ],
  );
});

test('a Codex compaction retains the compaction request usage its record carries', () => {
  const record = indexed(
    [
      codexMeta(),
      codexTaskStarted(1, 'turn-a'),
      codexTurnContext(1, 'turn-a', 'gpt-5.6-sol'),
      codexTokens(2, { input_tokens: 5_000, cache_write_input_tokens: 5_000, total_tokens: 5_000 }),
      JSON.stringify({
        timestamp: at(6),
        type: 'compacted',
        payload: {
          type: 'compacted',
          latest_token_usage_record: {
            usage: {
              ...CODEX_COUNTS,
              input_tokens: 30_000,
              cache_write_input_tokens: 30_000,
              output_tokens: 400,
              total_tokens: 30_400,
            },
          },
        },
      }),
      codexTaskStarted(7, 'turn-b'),
      codexTurnContext(7, 'turn-b', 'gpt-5.6-sol'),
      codexTokens(7, { input_tokens: 900, total_tokens: 5_900 }),
    ],
    codexReducer,
  );

  const [compaction] = record.cacheExpiry!.compactions;
  assert.equal(compaction.requestUsage!.cacheWrite30m, 30_000);
  assert.equal(compaction.requestUsage!.output, 400);
  assert.equal(compaction.requestModel, 'gpt-5.6-sol');
  assert.equal(compaction.requestContextWindow, 272_000);
});

test('a compaction takes the billing identity from the settings record that follows it', () => {
  // The compaction runs before any turn context names a model, and the rollout names the
  // identity that billed it in the next settings record. Without that, the retained usage
  // has no model and cannot be priced at all.
  const record = indexed(
    [
      codexMeta(),
      codexTaskStarted(1, 'turn-a'),
      JSON.stringify({
        timestamp: at(2),
        type: 'compacted',
        payload: {
          type: 'compacted',
          latest_token_usage_record: {
            usage: { ...CODEX_COUNTS, input_tokens: 20_000, cache_write_input_tokens: 20_000, total_tokens: 20_000 },
          },
        },
      }),
      JSON.stringify({
        timestamp: at(2),
        type: 'thread_settings_applied',
        payload: { thread_settings: { model: 'gpt-5.6-terra', model_provider_id: 'openai', service_tier: 'priority' } },
      }),
      codexTurnContext(3, 'turn-a', 'gpt-5.6-sol'),
      codexTokens(3, { input_tokens: 900, total_tokens: 20_900 }),
    ],
    codexReducer,
  );

  const [compaction] = record.cacheExpiry!.compactions;
  assert.deepEqual(
    [compaction.requestModel, compaction.requestProvider, compaction.requestServiceTier],
    ['gpt-5.6-terra', 'openai', 'priority'],
  );
});

test('a settings record after the compaction turn closed names a different request', () => {
  const record = indexed(
    [
      codexMeta(),
      codexTaskStarted(1, 'turn-a'),
      JSON.stringify({
        timestamp: at(2),
        type: 'compacted',
        payload: {
          type: 'compacted',
          latest_token_usage_record: {
            usage: { ...CODEX_COUNTS, input_tokens: 20_000, cache_write_input_tokens: 20_000, total_tokens: 20_000 },
          },
        },
      }),
      JSON.stringify({ timestamp: at(3), type: 'event_msg', payload: { type: 'task_complete' } }),
      JSON.stringify({
        timestamp: at(4),
        type: 'thread_settings_applied',
        payload: { thread_settings: { model: 'gpt-5.6-terra', model_provider_id: 'openai', service_tier: 'priority' } },
      }),
    ],
    codexReducer,
  );

  const [compaction] = record.cacheExpiry!.compactions;
  assert.equal(compaction.requestUsage!.cacheWrite30m, 20_000, 'the usage it did record is kept');
  assert.equal(compaction.requestModel, null, 'no model is claimed from a later request');
});

test('a request released after a later one never measures the next gap from itself', () => {
  // Codex holds a request until a record names its model. The release arrives after requests
  // that ran later, so its own clock puts it behind the one already carried.
  const scan = new CacheExpiryScan();
  const base = {
    agent: 'codex',
    provider: 'openai',
    model: 'gpt-5.6-sol',
    contextWindow: 272_000,
    contextBand: null,
    billingClass: 'metered' as const,
    inferenceClass: null,
    serviceTier: null,
    reportedCost: null,
    cacheLifetime: null,
    compactionsBefore: 0,
    usage: {
      requests: 1,
      input: 1_000,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      cacheWrite30m: 10,
      cacheRead: 0,
      output: 1,
      thinking: 0,
    },
  };
  scan.push({ ...base, timestamp: BASE + 60 * MINUTE, visibleTurnId: 'codex-turn:b', requestKey: 'b' });
  scan.push({ ...base, timestamp: BASE + 1 * MINUTE, visibleTurnId: 'codex-turn:a', requestKey: 'a' });
  scan.push({ ...base, timestamp: BASE + 62 * MINUTE, visibleTurnId: 'codex-turn:c', requestKey: 'c' });

  const ledger = scan.ledger([]);
  assert.deepEqual(
    ledger.facts.counts,
    { '5m': 0, '30m': 0, '1h': 0 },
    'the two-minute gap from the newest request is what the next comparison sees',
  );
  assert.equal(ledger.facts.unavailable, 1, 'the out-of-order release is the one pair that cannot be judged');
});

// ## The persisted schema

test('a ledger written by an older parser generation rebuilds instead of loading', () => {
  const lines = [
    claudePrompt(0, 'p1'),
    claudeResponse(1, { id: 'm1', input: 100, write1h: 4_000 }),
    claudePrompt(62, 'p2'),
    claudeResponse(62, { id: 'm2', input: 5_000, write1h: 1_000 }),
  ];
  const folder = dir();
  const file = path.join(folder, 'source.jsonl');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const current = indexSpendFile(undefined, file, 'w', claudeReducer, Date.now()).record;

  // Use the preceding parser generation to check invalidation independently of its current value.

  const stale: SpendFileIndex = {
    ...current,
    parserGeneration: PROJECT_SPEND_PARSER_GENERATION - 1,
    cacheExpiry: undefined,
  };
  const rebuilt = indexSpendFile(stale, file, 'w', claudeReducer, Date.now() + 1);

  assert.equal(rebuilt.rebuilt, true);
  assert.deepEqual(summary(rebuilt.record), summary(current));
});

test('a saved ledger carrying the derived facts loads again unchanged', () => {
  // A rejected record discards the whole saved ledger and rebuilds every source from its
  // bytes. The derived shape therefore has to survive its own validation.
  const record = indexed(
    [
      claudePrompt(0, 'p1'),
      claudeResponse(1, { id: 'm1', input: 100, read: 40_000, write1h: 4_000 }),
      claudeCompaction(10, 'c1'),
      claudePrompt(80, 'p2'),
      claudeResponse(80, { id: 'm2', input: 5_000, write1h: 1_000 }),
      claudePrompt(200, 'p3'),
      claudeResponse(200, { id: 'm3', input: 7_000, write1h: 1_000 }),
    ],
    claudeReducer,
  );
  assert.equal(record.cacheExpiry!.facts.counts['1h'], 1);
  assert.equal(record.cacheExpiry!.compactions.length, 1);

  const storage = dir();
  saveSpendLedger(storage, 'w', [record]);
  const loaded = loadSpendLedger(storage, 'w');

  assert.equal(loaded.files.length, 1, 'the saved ledger survived its own validation');
  assert.deepEqual(loaded.files[0].cacheExpiry, record.cacheExpiry);
  assert.deepEqual(loaded.completeFiles[0].cacheExpiry, record.cacheExpiry);
});

test('a saved ledger whose derived counts contradict its retained returns is rebuilt', () => {
  const record = indexed(
    [
      claudePrompt(0, 'p1'),
      claudeResponse(1, { id: 'm1', input: 100, write1h: 4_000 }),
      claudePrompt(80, 'p2'),
      claudeResponse(80, { id: 'm2', input: 5_000, write1h: 1_000 }),
    ],
    claudeReducer,
  );
  const broken: SpendFileIndex = {
    ...record,
    cacheExpiry: {
      ...record.cacheExpiry!,
      facts: { ...record.cacheExpiry!.facts, counts: { '5m': 0, '30m': 0, '1h': 0 } },
    },
  };

  const storage = dir();
  saveSpendLedger(storage, 'w', [broken]);
  assert.deepEqual(
    loadSpendLedger(storage, 'w').files,
    [],
    'a ledger that reports no return while retaining one is not a scan that ran',
  );
});

test('a saved ledger that counts a compaction it did not retain is rebuilt', () => {
  const record = indexed(
    [
      claudePrompt(0, 'p1'),
      claudeResponse(1, { id: 'm1', input: 100, write1h: 4_000 }),
      claudeCompaction(10, 'c1'),
      claudePrompt(80, 'p2'),
      claudeResponse(80, { id: 'm2', input: 5_000, write1h: 1_000 }),
    ],
    claudeReducer,
  );
  const state = record.parserState as ClaudeUsageReducerState;
  assert.equal(state.compactionCount, 1);
  assert.equal(state.recentCompactions.length, 1, 'the reducer retained the compaction it counted');

  const broken: SpendFileIndex = { ...record, parserState: { ...state, recentCompactions: [] } };

  const storage = dir();
  saveSpendLedger(storage, 'w', [broken]);
  assert.deepEqual(
    loadSpendLedger(storage, 'w').files,
    [],
    'a state that counts a compaction it did not keep would resume with evidence it never had',
  );
});

test('a saved Codex ledger waiting on a compaction that billed nothing is rebuilt', () => {
  const record = indexed(
    [
      codexMeta(),
      codexTaskStarted(1, 'turn-a'),
      codexTurnContext(1, 'turn-a', 'gpt-5.6-sol'),
      codexTokens(2, { input_tokens: 5_000, cache_write_input_tokens: 5_000, total_tokens: 5_000 }),
      JSON.stringify({
        timestamp: at(6),
        type: 'compacted',
        payload: {
          type: 'compacted',
          latest_token_usage_record: {
            usage: {
              ...CODEX_COUNTS,
              input_tokens: 30_000,
              cache_write_input_tokens: 30_000,
              total_tokens: 30_000,
            },
          },
        },
      }),
    ],
    codexReducer,
  );
  const state = record.parserState as CodexUsageReducerState;
  assert.equal(state.pendingCompactionBilling, 1, 'the compaction billed a request of its own');

  const broken: SpendFileIndex = {
    ...record,
    parserState: {
      ...state,
      recentCompactions: state.recentCompactions.map((item) => ({ ...item, requestUsage: null })),
    },
  };

  const storage = dir();
  saveSpendLedger(storage, 'w', [broken]);
  assert.deepEqual(
    loadSpendLedger(storage, 'w').files,
    [],
    'a marker on a compaction that billed nothing would take a later request identity',
  );

  const stale: SpendFileIndex = {
    ...record,
    parserState: { ...state, pendingCompactionBilling: state.compactionCount + 1 },
  };
  const other = dir();
  saveSpendLedger(other, 'w', [stale]);
  assert.deepEqual(
    loadSpendLedger(other, 'w').files,
    [],
    'a marker naming a compaction the state never counted has no request to identify',
  );
});

test('a saved Codex ledger waiting on a compaction a later one replaced is rebuilt', () => {
  const billed = (minutes: number, input: number) =>
    JSON.stringify({
      timestamp: at(minutes),
      type: 'compacted',
      payload: {
        type: 'compacted',
        latest_token_usage_record: {
          usage: {
            ...CODEX_COUNTS,
            input_tokens: input,
            cache_write_input_tokens: input,
            total_tokens: input,
          },
        },
      },
    });
  const record = indexed(
    [
      codexMeta(),
      codexTaskStarted(1, 'turn-a'),
      codexTurnContext(1, 'turn-a', 'gpt-5.6-sol'),
      codexTokens(2, { input_tokens: 5_000, cache_write_input_tokens: 5_000, total_tokens: 5_000 }),
      billed(6, 30_000),
      codexTaskStarted(7, 'turn-b'),
      codexTurnContext(7, 'turn-b', 'gpt-5.6-sol'),
      codexTokens(8, { input_tokens: 900, total_tokens: 5_900 }),
      billed(12, 40_000),
    ],
    codexReducer,
  );
  const state = record.parserState as CodexUsageReducerState;
  assert.equal(state.compactionCount, 2);
  assert.equal(state.pendingCompactionBilling, 2, 'the newer compaction holds the marker');
  assert.ok(
    state.recentCompactions.every((item) => item.requestUsage !== null),
    'both compactions billed a request of their own',
  );

  const broken: SpendFileIndex = { ...record, parserState: { ...state, pendingCompactionBilling: 1 } };

  const storage = dir();
  saveSpendLedger(storage, 'w', [broken]);
  assert.deepEqual(
    loadSpendLedger(storage, 'w').files,
    [],
    'the next settings record would name the older compaction, not the request that billed it',
  );
});

// ## The selector beside the turn stats

test('session cache facts come only from one complete primary source', () => {
  const ready = indexed(
    [
      claudePrompt(0, 'p1'),
      claudeResponse(1, { id: 'm1', input: 100, write1h: 4_000 }),
      claudePrompt(62, 'p2'),
      claudeResponse(62, { id: 'm2', input: 5_000, write1h: 1_000 }),
    ],
    claudeReducer,
  );
  const child = indexed(
    [claudePrompt(0, 'q1'), claudeResponse(1, { id: 'n1', input: 100, write1h: 4_000 })],
    claudeReducer,
  );
  const unfinished: SpendFileIndex = { ...ready, file: 'unfinished', complete: false, scanOffset: 0 };

  const answered = sessionCacheFactsBySession(
    [ready, child, unfinished],
    [
      { sessionId: 'ready', file: ready.file, primary: true },
      { sessionId: 'ready', file: child.file, primary: false },
      { sessionId: 'waiting', file: 'unfinished', primary: true },
    ],
  );

  assert.deepEqual(Object.keys(answered), ['ready']);
  assert.deepEqual(answered.ready.expiry.counts, { '5m': 0, '30m': 0, '1h': 1 });

  const legacy: SpendFileIndex = { ...ready, cacheExpiry: undefined };
  assert.deepEqual(
    sessionCacheFactsBySession([legacy], [{ sessionId: 'legacy', file: legacy.file, primary: true }]),
    {},
  );
});

// ## The classifier on its own
//
// Every gate the indexed answer rests on, read one at a time.

const carry = (over: Partial<CacheExpiryCarry> = {}): CacheExpiryCarry => ({
  requestKey: 'k',
  timestamp: BASE,
  visibleTurnId: 'turn-a',
  lifetime: '30m',
  model: 'gpt-5.6-sol',
  provider: 'openai',
  serviceTier: null,
  inferenceClass: null,
  compactionsBefore: 0,
  inputTokens: 1_000,
  incomplete: false,
  ...over,
});

const cold = {
  requests: 1,
  input: 100,
  cacheWrite1h: 0,
  cacheWrite5m: 0,
  cacheWrite30m: 0,
  cacheRead: 0,
  output: 0,
  thinking: 0,
};

test('the classifier answers each required condition on its own', () => {
  const later = (minutes: number, over: Partial<CacheExpiryCarry> = {}) =>
    carry({ requestKey: 'k2', visibleTurnId: 'turn-b', timestamp: BASE + minutes * MINUTE, ...over });

  assert.deepEqual(classifyCacheExpiry(carry(), later(31), cold), {
    kind: 'return',
    lifetime: '30m',
    gapMs: 31 * MINUTE,
  });
  assert.deepEqual(classifyCacheExpiry(carry(), later(30), cold), {
    kind: 'return',
    lifetime: '30m',
    gapMs: 30 * MINUTE,
  });
  assert.deepEqual(classifyCacheExpiry(carry(), later(29), cold), { kind: 'none' });
  assert.deepEqual(classifyCacheExpiry(carry(), later(31, { visibleTurnId: 'turn-a' }), cold), { kind: 'none' });
  assert.deepEqual(classifyCacheExpiry(carry({ visibleTurnId: null }), later(31), cold), { kind: 'unavailable' });
  assert.deepEqual(classifyCacheExpiry(carry({ lifetime: null }), later(31), cold), { kind: 'unavailable' });
  assert.deepEqual(classifyCacheExpiry(carry({ timestamp: 0 }), later(31), cold), { kind: 'unavailable' });
  assert.deepEqual(classifyCacheExpiry(carry({ incomplete: true }), later(31), cold), { kind: 'unavailable' });
  assert.deepEqual(classifyCacheExpiry(carry(), later(31, { incomplete: true }), cold), { kind: 'unavailable' });
  assert.deepEqual(
    classifyCacheExpiry(carry({ timestamp: BASE + 60 * MINUTE }), later(31), cold),
    { kind: 'unavailable' },
    'a later request recorded before its predecessor establishes no order',
  );
  assert.deepEqual(classifyCacheExpiry(carry(), later(31, { compactionsBefore: 1 }), cold), { kind: 'excluded' });
  assert.deepEqual(classifyCacheExpiry(carry(), later(31, { model: 'gpt-5.6-terra' }), cold), { kind: 'excluded' });
  assert.deepEqual(classifyCacheExpiry(carry(), later(31, { provider: 'amazon-bedrock' }), cold), { kind: 'excluded' });
  assert.deepEqual(classifyCacheExpiry(carry(), later(31, { serviceTier: 'priority' }), cold), { kind: 'excluded' });
  assert.deepEqual(classifyCacheExpiry(carry(), later(31, { inferenceClass: 'global' }), cold), { kind: 'excluded' });
  assert.deepEqual(classifyCacheExpiry(carry({ effort: 'high' }), later(31, { effort: 'xhigh' }), cold), {
    kind: 'excluded',
  });
  assert.deepEqual(classifyCacheExpiry(carry({ toolListVersion: 1 }), later(31, { toolListVersion: 2 }), cold), {
    kind: 'excluded',
  });
  assert.deepEqual(classifyCacheExpiry(carry(), later(31), { ...cold, input: 0, cacheRead: 100 }), { kind: 'none' });
});

test('Claude request identity and compaction trigger survive the incremental reducer', () => {
  const reducer = createClaudeUsageLineReducer();
  reducer.pushLine(claudePrompt(0, 'first'));
  reducer.pushLine(
    JSON.stringify({
      type: 'attachment',
      attachment: {
        type: 'deferred_tools_delta',
        addedNames: ['Read'],
        removedNames: [],
      },
    }),
  );
  const first = reducer.pushLine(
    JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      timestamp: at(1),
      effort: 'high',
      message: {
        id: 'm1',
        model: 'claude-sonnet-5',
        usage: {
          input_tokens: 10,
          output_tokens: 1,
          cache_creation: { ephemeral_1h_input_tokens: 100 },
        },
      },
    }),
  )[0];
  reducer.pushLine(
    JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      timestamp: at(2),
      compactMetadata: { trigger: 'manual' },
    }),
  );
  reducer.pushLine(JSON.stringify({ type: 'user', isCompactSummary: true, timestamp: at(2) }));
  assert.equal(first.effort, 'high');
  assert.equal(first.toolListVersion, 1);
  assert.equal(reducer.recentCompactions()[0].trigger, 'manual');
});

test('Codex request identity records reasoning effort and its tool-list limit', () => {
  const reducer = createCodexUsageLineReducer();
  reducer.pushLine(
    JSON.stringify({
      type: 'thread_settings_applied',
      timestamp: at(0),
      payload: {
        thread_settings: { model: 'gpt-5.6-sol', model_provider_id: 'openai', reasoning_effort: 'xhigh' },
      },
    }),
  );
  reducer.pushLine(
    JSON.stringify({
      type: 'event_msg',
      timestamp: at(1),
      payload: {
        type: 'task_started',
        turn_id: 'turn-1',
        model_context_window: 272000,
      },
    }),
  );
  reducer.pushLine(
    JSON.stringify({
      type: 'turn_context',
      timestamp: at(1),
      payload: {
        turn_id: 'turn-1',
        model: 'gpt-5.6-sol',
      },
    }),
  );
  const event = reducer.pushLine(
    JSON.stringify({
      type: 'event_msg',
      timestamp: at(2),
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 0,
            output_tokens: 1,
          },
        },
      },
    }),
  )[0];
  assert.equal(event.effort, 'xhigh');
  assert.equal(event.toolListVersion, null);
});

test('the recorded lifetime outranks the model row, and the row answers where the record is silent', () => {
  assert.equal(requestCacheLifetime('5m', 'gpt-5.6-sol', 'openai'), '5m');
  assert.equal(requestCacheLifetime(null, 'gpt-5.6-sol', 'openai'), '30m');
  assert.equal(requestCacheLifetime(null, 'gpt-6-sol', 'openai'), '30m');
  assert.equal(requestCacheLifetime(null, 'gpt-6-luna', 'openai'), '30m');
  assert.equal(requestCacheLifetime(undefined, 'claude-sonnet-5', null), null);
});

// ## The attributed input figure

const priced = (over: Partial<ProjectUsageBucket> = {}): ProjectUsageBucket => ({
  localDate: '2026-09-01',
  agent: 'codex',
  provider: 'openai',
  model: 'gpt-5.6-sol',
  contextWindow: 272_000,
  contextBand: 'short',
  billingClass: 'metered',
  inferenceClass: null,
  serviceTier: null,
  reportedCost: null,
  requests: 1,
  usage: {
    requests: 1,
    input: 1_000_000,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheWrite30m: 0,
    cacheRead: 1_000_000,
    output: 1_000_000,
    thinking: 0,
  },
  ...over,
});

const pricer = (bucket: ProjectUsageBucket) => publicProjectSpendPrice(bucket);

test('the attributed figure prices the cold input alone and calls a reported row unknown', () => {
  const warm: CacheExpiryFacts = {
    counts: { '5m': 0, '30m': 1, '1h': 0 },
    returns: [{ lifetime: '30m', gapMs: 31 * MINUTE, request: priced() }],
    truncated: false,
    longestGapMs: 31 * MINUTE,
    excluded: 0,
    unavailable: 0,
  };
  const exact = cacheExpiryInputCost(warm, pricer);
  assert.equal(exact.status, 'exact');
  // One million input tokens of gpt-5.6-sol at its $4 rate. The cache read and the answer
  // beside them are observed and never attributed to the expiry.
  assert.equal(exact.dollars, 4);

  const reported: CacheExpiryFacts = {
    ...warm,
    returns: [{ lifetime: '30m', gapMs: 31 * MINUTE, request: priced({ reportedCost: 9 }) }],
  };
  assert.deepEqual(cacheExpiryInputCost(reported, pricer), { dollars: null, status: 'unknown' });

  const truncated: CacheExpiryFacts = { ...warm, truncated: true, counts: { '5m': 0, '30m': 40, '1h': 0 } };
  assert.deepEqual(cacheExpiryInputCost(truncated, pricer), { dollars: 4, status: 'atLeast' });

  const none: CacheExpiryFacts = {
    counts: { '5m': 0, '30m': 0, '1h': 0 },
    returns: [],
    truncated: false,
    longestGapMs: null,
    excluded: 0,
    unavailable: 0,
  };
  assert.deepEqual(cacheExpiryInputCost(none, pricer), { dollars: 0, status: 'exact' });
});

// ## Bounded storage

test('the retained return list stops growing while its counts stay exact', () => {
  const scan = new CacheExpiryScan(emptyCacheExpiryLedger());
  const request = (index: number): UsageEvent => ({
    timestamp: BASE + index * 61 * MINUTE,
    agent: 'claude',
    provider: null,
    model: 'claude-sonnet-5',
    contextWindow: null,
    contextBand: null,
    billingClass: 'unknown',
    inferenceClass: null,
    serviceTier: null,
    reportedCost: null,
    visibleTurnId: `claude-turn:${index}`,
    cacheLifetime: '1h',
    compactionsBefore: 0,
    usage: {
      requests: 1,
      input: 1_000,
      cacheWrite1h: 10,
      cacheWrite5m: 0,
      cacheWrite30m: 0,
      cacheRead: 0,
      output: 1,
      thinking: 0,
    },
    requestKey: `claude:m${index}`,
  });
  for (let index = 0; index < 50; index++) {
    scan.push(request(index));
  }

  const ledger = scan.ledger([]);
  assert.equal(ledger.facts.counts['1h'], 49);
  assert.equal(ledger.facts.returns.length, 32);
  assert.equal(ledger.facts.truncated, true);
  assert.equal(JSON.stringify(ledger).length < 60_000, true, 'the saved ledger stays bounded');
});

test('delegated work never joins the primary session order', () => {
  const scan = new CacheExpiryScan();
  const base = {
    agent: 'claude',
    provider: null,
    model: 'claude-sonnet-5',
    contextWindow: null,
    contextBand: null,
    billingClass: 'unknown' as const,
    inferenceClass: null,
    serviceTier: null,
    reportedCost: null,
    cacheLifetime: '1h' as const,
    compactionsBefore: 0,
    usage: {
      requests: 1,
      input: 1_000,
      cacheWrite1h: 10,
      cacheWrite5m: 0,
      cacheWrite30m: 0,
      cacheRead: 0,
      output: 1,
      thinking: 0,
    },
  };
  scan.push({ ...base, timestamp: BASE, visibleTurnId: 'claude-turn:1', requestKey: 'a' });
  scan.push({
    ...base,
    timestamp: BASE + 90 * MINUTE,
    visibleTurnId: 'claude-turn:2',
    requestKey: 'b',
    linkedSessionId: 'child',
  });
  scan.push({
    ...base,
    timestamp: BASE + 91 * MINUTE,
    visibleTurnId: 'claude-turn:2',
    requestKey: 'c',
    linkedInvocationId: 'shell',
  });
  scan.push({ ...base, timestamp: BASE + 92 * MINUTE, visibleTurnId: 'claude-turn:2', requestKey: 'd' });

  const ledger = scan.ledger([]);
  assert.equal(ledger.facts.counts['1h'], 1, 'the two primary requests are the only pair compared');
  assert.equal(ledger.facts.returns[0].gapMs, 92 * MINUTE);
});

test('a rewritten request revises what it replaced instead of opening a second comparison', () => {
  const scan = new CacheExpiryScan();
  const base = {
    agent: 'claude',
    provider: null,
    model: 'claude-sonnet-5',
    contextWindow: null,
    contextBand: null,
    billingClass: 'unknown' as const,
    inferenceClass: null,
    serviceTier: null,
    reportedCost: null,
    cacheLifetime: '1h' as const,
    compactionsBefore: 0,
  };
  const counts = (output: number) => ({
    requests: 1,
    input: 1_000,
    cacheWrite1h: 10,
    cacheWrite5m: 0,
    cacheWrite30m: 0,
    cacheRead: 0,
    output,
    thinking: 0,
  });
  scan.push({ ...base, timestamp: BASE, visibleTurnId: 'claude-turn:1', requestKey: 'a', usage: counts(1) });
  scan.push({
    ...base,
    timestamp: BASE + 90 * MINUTE,
    visibleTurnId: 'claude-turn:2',
    requestKey: 'b',
    usage: counts(1),
  });
  // The reducer pairs a removal with the replacement that supersedes it. The removal carries a
  // negative request count, and the replacement repeats the key it revises.
  scan.push({
    ...base,
    timestamp: BASE + 90 * MINUTE,
    visibleTurnId: 'claude-turn:2',
    requestKey: 'b',
    usage: { ...counts(-1), requests: -1 },
  });
  scan.push({
    ...base,
    timestamp: BASE + 90 * MINUTE,
    visibleTurnId: 'claude-turn:2',
    requestKey: 'b',
    usage: counts(9),
  });

  const ledger = scan.ledger([]);
  assert.equal(ledger.facts.counts['1h'], 1, 'the revision is the same request, not a second one');
  assert.equal(ledger.facts.unavailable, 0);
  assert.equal(ledger.facts.returns.length, 1);
  assert.equal(ledger.facts.returns[0].request.usage.output, 9, 'the recorded row follows the revision');
});

test('a removal of an earlier request never becomes a request of its own', () => {
  const scan = new CacheExpiryScan();
  const base = {
    agent: 'claude',
    provider: null,
    model: 'claude-sonnet-5',
    contextWindow: null,
    contextBand: null,
    billingClass: 'unknown' as const,
    inferenceClass: null,
    serviceTier: null,
    reportedCost: null,
    cacheLifetime: '1h' as const,
    compactionsBefore: 0,
  };
  const counts = (sign: number) => ({
    requests: sign,
    input: sign * 1_000,
    cacheWrite1h: sign * 10,
    cacheWrite5m: 0,
    cacheWrite30m: 0,
    cacheRead: 0,
    output: sign,
    thinking: 0,
  });
  scan.push({ ...base, timestamp: BASE, visibleTurnId: 'claude-turn:1', requestKey: 'a', usage: counts(1) });
  scan.push({
    ...base,
    timestamp: BASE + 90 * MINUTE,
    visibleTurnId: 'claude-turn:2',
    requestKey: 'b',
    usage: counts(1),
  });
  // A revision of a request that is no longer the newest one. Its removal carries the older
  // request's own clock, so reading it as a request would put the order backwards.
  scan.push({ ...base, timestamp: BASE, visibleTurnId: 'claude-turn:1', requestKey: 'a', usage: counts(-1) });

  const ledger = scan.ledger([]);
  assert.equal(ledger.facts.counts['1h'], 1);
  assert.equal(ledger.facts.unavailable, 0, 'a removal opens no comparison at all');
});

test('a settings record that changes only the service tier still splits the pair', () => {
  const record = indexed(
    [
      codexMeta(),
      codexSettings(0, 'standard'),
      codexTaskStarted(1, 'turn-a'),
      codexTurnContext(1, 'turn-a', 'gpt-5.6-sol'),
      codexTokens(2, { input_tokens: 5_000, cache_write_input_tokens: 5_000, total_tokens: 5_000 }),
      codexSettings(32, 'priority'),
      codexTaskStarted(33, 'turn-b'),
      codexTurnContext(33, 'turn-b', 'gpt-5.6-sol'),
      codexTokens(33, { input_tokens: 6_000, total_tokens: 11_000 }),
    ],
    codexReducer,
  );

  assert.deepEqual(summary(record), { ...NOTHING, excluded: 1 });
});

test('supported Codex visible-turn returns use nominal lifetime rather than the early forward boundary', () => {
  for (const [provider, model] of [
    ['amazon-bedrock', 'openai.gpt-6.1-sol'],
    ['amazon-bedrock', 'us.openai.gpt-6.1-sol'],
    ['amazon-bedrock', 'global.openai.gpt-6.1-sol'],
    ['amazon-bedrock', 'openai.gpt-6-luna'],
    ['amazon-bedrock', 'openai.gpt-6-sol'],
    ['openai', 'gpt-5.5'],
    ['openai', 'gpt-5.5-2026-04-23'],
  ]) {
    for (const [gap, returns] of [
      [4, 0],
      [29, 0],
      [30, 1],
      [31, 1],
    ]) {
      const record = indexed(
        [
          codexMeta(provider),
          codexTaskStarted(1, 'turn-a'),
          codexTurnContext(1, 'turn-a', model),
          codexTokens(2, { input_tokens: 5_000, cache_write_input_tokens: 5_000, total_tokens: 5_000 }),
          codexTaskStarted(2 + gap, 'turn-b'),
          codexTurnContext(2 + gap, 'turn-b', model),
          codexTokens(2 + gap, { input_tokens: 6_000, total_tokens: 11_000 }),
        ],
        codexReducer,
      );
      assert.equal(facts(record).counts['30m'], returns, `${model} gap ${gap}`);
      assert.equal(facts(record).unavailable, 0, model);
      assert.equal(facts(record).excluded, 0, model);
    }
  }
});
