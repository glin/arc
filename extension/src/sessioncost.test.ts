import { bedrockAstraRecords } from './turnfixtures';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { test, vi } from 'vitest';
import { tempDir } from './temproot';
import * as projectSpend from './projectspend';
import * as codexReader from './codex';
import {
  findSessionTranscript,
  readSessionRequests,
  sessionCostReport,
  sessionSources,
  summarizeRequests,
  type SessionRequest,
} from './sessioncost';

function directory(): string {
  return tempDir('session-cost-');
}

function write(file: string, records: object[]): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  return file;
}

function claudeRequest(id: string, output: number, tools: string[] = [], model = 'claude-opus-5'): object {
  return {
    type: 'assistant',
    timestamp: '2026-09-26T00:00:01Z',
    message: {
      id,
      role: 'assistant',
      model,
      content: tools.map((tool) => ({ type: 'tool_use', id: tool, name: 'Bash', input: { command: 'pwd' } })),
      usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  };
}

function pricedRequest(model: string | null, input: number, options: Partial<SessionRequest> = {}): SessionRequest {
  return {
    timestamp: Date.parse('2026-09-26T00:00:01Z'),
    agent: model?.startsWith('claude-') ? 'claude' : 'codex',
    provider: model?.startsWith('claude-') ? null : 'openai',
    model,
    contextWindow: null,
    contextBand: null,
    billingClass: 'unknown',
    inferenceClass: null,
    serviceTier: null,
    reportedCost: null,
    usage: {
      requests: 1,
      input,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheWrite30m: 0,
      output: 0,
      thinking: 0,
    },
    requestKey: `request-${input}`,
    toolCalls: 0,
    ...options,
  };
}

function cumulativeCostFixture(id = 'parent', model = 'gpt-6-sol') {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = (multiple = 1) => ({
    input_tokens: 1000 * multiple,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 100 * multiple,
    reasoning_output_tokens: 0,
    total_tokens: 1100 * multiple,
  });
  const bill = (response: string, second: number, multiple: number, turnId = 'turn-1') => ({
    type: 'token_usage_record',
    timestamp: at(second),
    payload: {
      thread_id: id,
      session_id: 'root-parent',
      turn_id: turnId,
      response_id: response,
      usage: usage(),
      thread_token_usage: usage(multiple),
      turn_token_usage: usage(multiple),
    },
  });
  const snapshot = (second: number, multiple: number, last = usage()) => ({
    type: 'event_msg',
    timestamp: at(second),
    payload: {
      type: 'token_count',
      info: { last_token_usage: last, total_token_usage: usage(multiple) },
    },
  });
  const start = [
    { type: 'session_meta', timestamp: at(0), payload: { id, source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'turn-1' } },
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'turn-1', model } },
  ];
  const save = (records: object[]) => write(path.join(directory(), `rollout-2026-09-26T00-00-00-${id}.jsonl`), records);
  return { at, usage, bill, snapshot, start, save };
}

test('cumulative evidence reconciles distinct equal responses and delayed snapshots in the billing window', () => {
  const f = cumulativeCostFixture('child');
  const duplicate = f.bill('one', 8, 1);
  const file = f.save([
    ...f.start,
    f.bill('one', 3, 1),
    f.bill('two', 4, 2),
    f.snapshot(7, 1),
    duplicate,
    f.snapshot(9, 2),
  ]);
  const report = sessionCostReport(file, { since: f.at(3), until: f.at(5), byModel: true, sourceOnly: true });
  assert.equal(report.parent.requests, 2);
  assert.equal(report.parent.coverage, 'recorded-reconciled');
  assert.equal(report.parent.requestCountExact, undefined);
  assert.equal(report.parent.costUsd, 0.006);
  assert.equal(report.parent.pricedCostUsd, 0.006);
  assert.equal(report.parent.modelCosts![0].costUsd, 0.006);
  assert.equal(report.combined.costUsd, 0.006);
  assert.equal(report.parent.toolCalls, null);
  assert.equal(report.parent.requestsWithTwoOrMoreTools, null);
  assert.equal(report.parent.cacheExpiry!.coverage, 'unknown-request-coverage');
  const later = sessionCostReport(file, { since: f.at(6), until: f.at(10), sourceOnly: true }).parent;
  assert.equal(later.requests, 0);
  assert.equal(later.costUsd, undefined);
  assert.equal(later.requestCountExact, undefined);
});

test('a native child report keeps its own Astra bill behind a delayed opening and excludes inherited and repeated work', () => {
  const f = cumulativeCostFixture('native-child', 'gpt-6-astra');
  const opening = {
    type: 'session_meta',
    timestamp: f.at(10),
    payload: {
      id: 'native-child',
      session_id: 'root-parent',
      parent_thread_id: 'root-parent',
      timestamp: f.at(0),
      thread_source: 'subagent',
      source: { subagent: { thread_spawn: { parent_thread_id: 'root-parent' } } },
      model_provider: 'openai',
    },
  };
  const start = {
    type: 'event_msg',
    timestamp: f.at(11),
    payload: { type: 'task_started', turn_id: 'turn-1', started_at: Date.parse(f.at(1)) / 1000 },
  };
  const inherited = [
    { ...start, payload: { ...start.payload, turn_id: 'inherited', started_at: Date.parse(f.at(-10)) / 1000 } },
    { type: 'turn_context', timestamp: f.at(11), payload: { turn_id: 'inherited', model: 'gpt-6-sol' } },
    f.bill('inherited-bill', 11, 1, 'inherited'),
    f.snapshot(11, 1),
  ];
  const context = {
    type: 'turn_context',
    timestamp: f.at(12),
    payload: { turn_id: 'turn-1', model: 'gpt-6-astra', effort: 'high' },
  };
  const file = f.save([
    opening,
    ...inherited,
    start,
    context,
    f.bill('own', 13, 1),
    f.snapshot(14, 1),
    f.bill('own', 15, 1),
    f.snapshot(16, 1),
    start,
    context,
    f.bill('repeated', 17, 2),
    f.snapshot(18, 2),
  ]);
  const report = sessionCostReport(file, { sourceOnly: true, byModel: true });
  assert.equal(report.parent.requests, 1);
  assert.deepEqual(report.parent.models, ['gpt-6-astra']);
  assert.equal(report.parent.coverage, 'recorded-reconciled');
  assert.equal(report.parent.costUsd, 0.015);
  assert.deepEqual(report.children, []);
});

test('rounded native starts require the exact child bill and retain unknown full cost without confirmation', () => {
  for (const rounding of [0, 750]) {
    for (const thread of ['native-rounded', 'root-parent', 'foreign', null]) {
      const f = cumulativeCostFixture('native-rounded', 'gpt-6-astra');
      const opening = {
        type: 'session_meta',
        timestamp: f.at(10),
        payload: {
          id: 'native-rounded',
          session_id: 'root-parent',
          parent_thread_id: 'root-parent',
          timestamp: new Date(Date.parse(f.at(0)) + rounding).toISOString(),
          model_provider: 'openai',
          thread_source: 'subagent',
          source: { subagent: { thread_spawn: { parent_thread_id: 'root-parent' } } },
        },
      };
      const start = {
        type: 'event_msg',
        timestamp: f.at(11),
        payload: { type: 'task_started', turn_id: 'turn-1', started_at: Date.parse(f.at(0)) / 1000 },
      };
      const context = {
        type: 'turn_context',
        timestamp: f.at(12),
        payload: { turn_id: 'turn-1', model: 'gpt-6-astra', effort: 'high' },
      };
      const bill = f.bill('rounded', 14, 1);
      const file = f.save([
        opening,
        start,
        context,
        f.snapshot(13, 1),
        ...(thread ? [{ ...bill, payload: { ...bill.payload, thread_id: thread } }] : []),
      ]);
      const report = sessionCostReport(file, { sourceOnly: true, byModel: true }).parent;
      assert.equal(report.requests, 1, String(thread));
      if (thread === 'native-rounded') {
        assert.equal(report.costUsd, 0.015);
        assert.equal(report.coverage, 'recorded-reconciled');
      } else {
        assert.equal(report.costUsd, null, String(thread));
        assert.equal(report.pricedCostUsd, 0, String(thread));
      }
    }
  }
});

test('rounded native reports preserve original usage across repeated confirmation and distinct-turn eviction', () => {
  const f = cumulativeCostFixture('native-rounded', 'gpt-6-astra');
  const opening = {
    type: 'session_meta',
    timestamp: f.at(10),
    payload: {
      id: 'native-rounded',
      session_id: 'root-parent',
      parent_thread_id: 'root-parent',
      timestamp: new Date(Date.parse(f.at(0)) + 750).toISOString(),
      model_provider: 'openai',
      thread_source: 'subagent',
      source: { subagent: { thread_spawn: { parent_thread_id: 'root-parent' } } },
    },
  };
  const start = {
    type: 'event_msg',
    timestamp: f.at(11),
    payload: { type: 'task_started', turn_id: 'turn-1', started_at: Date.parse(f.at(0)) / 1000 },
  };
  const context = {
    type: 'turn_context',
    timestamp: f.at(12),
    payload: { turn_id: 'turn-1', model: 'gpt-6-astra', effort: 'high' },
  };
  const original = [
    opening,
    start,
    context,
    f.snapshot(13, 1),
    { type: 'event_msg', timestamp: f.at(18), payload: { type: 'task_complete', turn_id: 'turn-1' } },
  ];
  const repeated = { ...start, timestamp: f.at(19) };
  for (const replayUsage of [false, true]) {
    const file = f.save([
      ...original,
      repeated,
      ...(replayUsage ? [f.snapshot(19, 9)] : []),
      f.bill('own', 20, 1),
      f.bill('repeated', 21, 2),
      f.snapshot(22, 2),
    ]);
    const requests = readSessionRequests(file);
    assert.equal(requests.filter((request) => request.billingRecord).length, 1);
    const report = sessionCostReport(file, { sourceOnly: true, byModel: true }).parent;
    assert.equal(report.requests, 1);
    assert.equal(report.costUsd, 0.015);
    assert.equal(report.coverage, 'recorded-reconciled');
    assert.deepEqual(report.models, ['gpt-6-astra']);
  }
  for (const laterTurns of [0, 64, 65]) {
    const file = f.save([
      ...original,
      ...Array.from({ length: laterTurns }, (_, index) => ({
        type: 'event_msg',
        timestamp: f.at(21 + index),
        payload: { type: 'task_started', turn_id: `later-${index}`, started_at: Date.parse(f.at(21 + index)) / 1000 },
      })),
    ]);
    assert.equal(readSessionRequests(file).filter((request) => !request.evidenceOnly).length, 1);
    const report = sessionCostReport(file, { sourceOnly: true, byModel: true }).parent;
    assert.equal(report.requests, 1);
    assert.equal(report.costUsd, null);
    assert.equal(report.pricedCostUsd, 0);
    assert.equal(report.coverage, 'legacy-snapshots');
    assert.equal(report.cacheExpiry?.coverage, 'unknown-request-coverage');
  }
  const result = {
    type: 'result',
    session_id: 'printed',
    total_cost_usd: 0.01,
    duration_ms: 100,
    is_error: false,
    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: {
      'claude-haiku-4-5': {
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
    },
  };
  const print = {
    type: 'event_msg',
    timestamp: f.at(17),
    payload: {
      type: 'item_completed',
      item: {
        type: 'CommandExecution',
        id: 'print',
        command: ['claude', '-p', 'review', '--output-format', 'json'],
        parsed_cmd: [{ type: 'unknown', cmd: 'claude -p review --output-format json' }],
        status: 'completed',
        exit_code: 0,
        stdout: JSON.stringify(result),
      },
    },
  };
  for (const thread of ['native-rounded', 'root-parent', 'foreign', null]) {
    const file = f.save([
      ...original,
      print,
      print,
      ...(thread ? [{ ...f.bill('own', 20, 1), payload: { ...f.bill('own', 20, 1).payload, thread_id: thread } }] : []),
    ]);
    const requests = readSessionRequests(file, 'claude-print', 'print:printed').filter(
      (request) => request.agent === 'claude',
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].incomplete ?? false, thread !== 'native-rounded');
    const summary = summarizeRequests(requests);
    assert.equal(summary.costUsd, thread === 'native-rounded' ? 0.01 : null);
    assert.equal(summary.pricedCostUsd, thread === 'native-rounded' ? 0.01 : 0);
  }
});

test('a removed bill prevents a numeric total and invalidates an empty window before the revealing snapshot', () => {
  const f = cumulativeCostFixture();
  const file = f.save([...f.start, f.bill('one', 3, 1), f.snapshot(4, 1), f.snapshot(8, 2)]);
  const report = sessionCostReport(file, { since: f.at(5), until: f.at(6), byModel: true, sourceOnly: true });
  assert.equal(report.parent.requests, 0);
  assert.equal(report.parent.coverage, 'recorded-gaps');
  assert.equal(report.parent.costUsd, null);
  assert.equal(report.parent.requestCountExact, false);
  assert.equal(report.combined.coverage, 'recorded-gaps');
  const whole = sessionCostReport(file, { byModel: true, sourceOnly: true }).parent;
  assert.equal(whole.requests, 1);
  assert.equal(whole.pricedCostUsd, 0.003);
  assert.equal(whole.modelCosts![0].costUsd, null);
});

test('a cumulative jump detects missing usage even when every remaining bill has a matching snapshot', () => {
  const f = cumulativeCostFixture();
  const file = f.save([...f.start, f.bill('one', 3, 1), f.snapshot(4, 1), f.bill('three', 8, 3), f.snapshot(9, 3)]);
  const summary = sessionCostReport(file, { since: f.at(5), until: f.at(6), sourceOnly: true }).parent;
  assert.equal(summary.coverage, 'recorded-gaps');
  assert.equal(summary.requests, 0);
  assert.equal(summary.costUsd, null);
  const before = sessionCostReport(file, {
    until: new Date(Date.parse(f.at(3)) + 1).toISOString(),
    sourceOnly: true,
  }).parent;
  assert.equal(before.coverage, 'recorded-reconciled');
  assert.equal(before.costUsd, 0.003);
});

test('a contradictory complete revision removes its quote even when the revision falls outside the window', () => {
  const f = cumulativeCostFixture();
  const revision = f.bill('one', 12, 1);
  revision.payload.usage = f.usage(2);
  const file = f.save([...f.start, f.bill('one', 3, 1), f.snapshot(4, 1), revision]);
  const summary = sessionCostReport(file, { since: f.at(3), until: f.at(5), byModel: true, sourceOnly: true }).parent;
  assert.equal(summary.requests, 1);
  assert.equal(summary.pricedRequests, 0);
  assert.equal(summary.pricedCostUsd, 0);
  assert.equal(summary.costUsd, null);
  assert.equal(summary.coverage, 'billed-with-unknown-coverage');
  assert.equal(summary.modelCosts![0].costUsd, null);
});

test('a partial bill receives complete cumulative evidence without moving its charging boundary', () => {
  const f = cumulativeCostFixture();
  const partial = {
    type: 'token_usage_record',
    timestamp: f.at(3),
    payload: {
      response_id: 'one',
      turn_id: 'turn-1',
      thread_id: 'parent',
      usage: { input_tokens: 1000 },
    },
  };
  const file = f.save([...f.start, partial, f.snapshot(4, 1), f.bill('one', 9, 1)]);
  const summary = sessionCostReport(file, { since: f.at(3), until: f.at(5), sourceOnly: true }).parent;
  assert.equal(summary.requests, 1);
  assert.equal(summary.coverage, 'recorded-reconciled');
  assert.equal(summary.costUsd, 0.003);
});

test('missing ownership or cumulative counters preserve unknown coverage and the priced subtotal', () => {
  const f = cumulativeCostFixture();
  for (const field of ['thread_id', 'thread_token_usage', 'turn_token_usage'] as const) {
    const bill = f.bill('one', 3, 1);
    const { [field]: omitted, ...payload } = bill.payload;
    assert.ok(omitted);
    const summary = sessionCostReport(f.save([...f.start, { ...bill, payload }, f.snapshot(4, 1)]), {
      sourceOnly: true,
    }).parent;
    assert.equal(summary.coverage, 'billed-with-unknown-coverage');
    assert.equal(summary.costUsd, null);
    assert.equal(summary.pricedCostUsd, 0.003);
  }
});

test('a foreign billing thread cannot establish reconciled source coverage', () => {
  const f = cumulativeCostFixture();
  const bill = f.bill('one', 3, 1);
  bill.payload.thread_id = 'foreign';
  const summary = sessionCostReport(f.save([...f.start, bill, f.snapshot(4, 1)]), { sourceOnly: true }).parent;
  assert.equal(summary.coverage, 'billed-with-unknown-coverage');
  assert.equal(summary.costUsd, null);
  assert.equal(summary.pricedCostUsd ?? 0, 0);
  assert.equal(summary.pricedRequests, 0);
  assert.equal(summary.requests, 0);
  const foreign = f.bill('foreign-response', 8, 2);
  foreign.payload.thread_id = 'foreign';
  const mixed = sessionCostReport(
    f.save([...f.start, f.bill('one', 3, 1), f.snapshot(4, 1), foreign, f.snapshot(9, 2)]),
    {
      sourceOnly: true,
      byModel: true,
    },
  ).parent;
  assert.equal(mixed.coverage, 'billed-with-unknown-coverage');
  assert.equal(mixed.costUsd, null);
  assert.equal(mixed.pricedCostUsd, 0.003);
  assert.equal(mixed.requests, 1);
  assert.equal(mixed.modelCosts![0].pricedCostUsd, 0.003);
});

test('copied parent metadata does not invalidate the child source cumulative evidence', () => {
  const f = cumulativeCostFixture('child');
  const file = f.save([
    f.start[0],
    { type: 'session_meta', timestamp: f.at(0), payload: { id: 'root-parent', timestamp: f.at(-60) } },
    { ...f.start[1], payload: { ...f.start[1].payload, started_at: Date.parse(f.at(1)) } },
    f.start[2],
    f.bill('one', 3, 1),
    f.snapshot(4, 1),
  ]);
  const summary = sessionCostReport(file, { sourceOnly: true }).parent;
  assert.equal(summary.coverage, 'recorded-reconciled');
  assert.equal(summary.costUsd, 0.003);
});

test('compaction and counter resets preserve earlier reconciled windows and retain later empty uncertainty', () => {
  const f = cumulativeCostFixture();
  const compacted = { type: 'compacted', timestamp: f.at(6), payload: {} };
  for (const boundary of [compacted, f.bill('reset', 6, 1)]) {
    const file = f.save([...f.start, f.bill('one', 3, 1), f.snapshot(4, 1), boundary, f.snapshot(7, 1)]);
    const earlier = sessionCostReport(file, { since: f.at(3), until: f.at(5), sourceOnly: true }).parent;
    assert.equal(earlier.coverage, 'recorded-reconciled');
    assert.equal(earlier.costUsd, 0.003);
    const later = sessionCostReport(file, { since: f.at(8), until: f.at(9), sourceOnly: true }).parent;
    assert.equal(later.requests, 0);
    assert.equal(later.costUsd, null);
    assert.equal(later.requestCountExact, false);
    assert.equal(later.coverage, 'billed-with-unknown-coverage');
  }
  const file = f.save([
    ...f.start,
    f.bill('one', 3, 1),
    f.snapshot(4, 1),
    compacted,
    f.bill('two', 8, 2),
    f.snapshot(9, 2),
  ]);
  const earlier = sessionCostReport(file, { since: f.at(3), until: f.at(5), sourceOnly: true }).parent;
  assert.equal(earlier.coverage, 'recorded-reconciled');
  assert.equal(earlier.costUsd, 0.003);
  const tied = f.save([
    ...f.start,
    f.bill('one', 3, 1),
    f.snapshot(4, 1),
    { type: 'compacted', timestamp: f.at(8), payload: {} },
    f.bill('restart', 8, 1),
    f.snapshot(9, 1),
  ]);
  const excludedBoundary = sessionCostReport(tied, { since: f.at(3), until: f.at(8), sourceOnly: true }).parent;
  assert.equal(excludedBoundary.coverage, 'recorded-reconciled');
  assert.equal(excludedBoundary.costUsd, 0.003);
  const includedBoundary = sessionCostReport(tied, { since: f.at(8), until: f.at(9), sourceOnly: true }).parent;
  assert.equal(includedBoundary.costUsd, null);
});

test('an explicit baseline after compaction or reset closes prior uncertainty for the restarted window', () => {
  const f = cumulativeCostFixture();
  for (const scenario of [
    { unknown: f.bill('reset', 6, 1), compacted: 8, restart: 10 },
    { unknown: f.snapshot(6, 0), compacted: 8, restart: 10 },
    { unknown: f.snapshot(6, 0), compacted: 6, restart: 6 },
    { unknown: f.snapshot(6, 0), compacted: null, restart: 10 },
  ]) {
    const file = f.save([
      ...f.start,
      f.bill('one', 3, 1),
      f.snapshot(4, 1),
      scenario.unknown,
      ...(scenario.compacted === null ? [] : [{ type: 'compacted', timestamp: f.at(scenario.compacted), payload: {} }]),
      f.bill('restart', scenario.restart, 1),
      f.snapshot(scenario.restart + 1, 1),
      f.bill('next', 12, 2),
      f.snapshot(13, 2),
    ]);
    const before = sessionCostReport(file, { since: f.at(6), until: f.at(7), sourceOnly: true }).parent;
    assert.equal(before.coverage, 'billed-with-unknown-coverage');
    assert.equal(before.costUsd, null);
    const since = Math.max(8, scenario.restart);
    const after = sessionCostReport(file, { since: f.at(since), until: f.at(14), sourceOnly: true }).parent;
    assert.equal(after.coverage, 'recorded-reconciled', JSON.stringify(scenario));
    assert.equal(after.costUsd, scenario.restart < since ? 0.003 : 0.006);
    assert.equal(after.requests, scenario.restart < since ? 1 : 2);
    assert.equal(after.requestCountExact, undefined);
  }
});

test('truncated metadata between valid bills preserves the usable cost report', () => {
  const f = cumulativeCostFixture();
  const file = f.save([...f.start, f.bill('one', 3, 1), f.snapshot(4, 1)]);
  fs.appendFileSync(file, '{"type":"session_meta","payload":\n');
  fs.appendFileSync(file, [f.bill('two', 8, 2), f.snapshot(9, 2)].map((row) => JSON.stringify(row)).join('\n') + '\n');
  const summary = sessionCostReport(file, { sourceOnly: true }).parent;
  assert.equal(summary.coverage, 'recorded-reconciled');
  assert.equal(summary.costUsd, 0.006);
  assert.equal(summary.requests, 2);
});

test('an unmatched cumulative-only snapshot survives zero emitted request usage', () => {
  const f = cumulativeCostFixture();
  const file = f.save([...f.start, f.bill('one', 3, 1), f.snapshot(4, 1), f.snapshot(8, 2, f.usage(0))]);
  const summary = sessionCostReport(file, { since: f.at(5), until: f.at(6), sourceOnly: true }).parent;
  assert.equal(summary.requests, 0);
  assert.equal(summary.coverage, 'recorded-gaps');
  assert.equal(summary.costUsd, null);
  const anonymous = f.save([...f.start, f.snapshot(8, 2, f.usage(0))]);
  assert.equal(sessionCostReport(anonymous, { sourceOnly: true }).parent.coverage, 'unknown-request-coverage');
});

test('unsupported rates retain reconciled recorded identity with unavailable cost', () => {
  const f = cumulativeCostFixture('parent', 'future-model');
  const summary = sessionCostReport(f.save([...f.start, f.bill('one', 3, 1), f.snapshot(4, 1)]), {
    sourceOnly: true,
    byModel: true,
  }).parent;
  assert.equal(summary.coverage, 'recorded-reconciled');
  assert.equal(summary.requestCountExact, undefined);
  assert.equal(summary.costUsd, null);
  assert.equal(summary.pricedCostUsd, 0);
  assert.equal(summary.unpricedRequests, 1);
  assert.equal(summary.modelCosts![0].costUsd, null);
});

test('a snapshot counter reset keeps earlier costs and marks later empty windows unknown', () => {
  const f = cumulativeCostFixture();
  const file = f.save([...f.start, f.bill('one', 3, 1), f.snapshot(4, 1), f.snapshot(6, 0)]);
  const earlier = sessionCostReport(file, { until: f.at(5), sourceOnly: true }).parent;
  assert.equal(earlier.costUsd, 0.003);
  const later = sessionCostReport(file, { since: f.at(8), until: f.at(9), sourceOnly: true }).parent;
  assert.equal(later.costUsd, null);
  assert.equal(later.coverage, 'billed-with-unknown-coverage');
  for (const intermediate of [[], [f.snapshot(6, 2)]]) {
    const repeated = f.save([
      ...f.start,
      f.bill('one', 3, 1),
      f.snapshot(4, 1),
      f.bill('two', 5, 2),
      ...intermediate,
      f.snapshot(7, 1),
      f.bill('three', 8, 3),
      f.snapshot(9, 3),
    ]);
    const afterReset = sessionCostReport(repeated, { since: f.at(8), until: f.at(10), sourceOnly: true }).parent;
    assert.equal(afterReset.costUsd, null);
    assert.equal(afterReset.coverage, 'billed-with-unknown-coverage');
    assert.equal(afterReset.pricedCostUsd, 0.003);
  }
});

test('backward clocks include the preceding anchor boundary in a cumulative-gap window', () => {
  const f = cumulativeCostFixture();
  const file = f.save([...f.start, f.bill('one', 8, 1), f.snapshot(8, 1), f.bill('three', 4, 3), f.snapshot(4, 3)]);
  const summary = sessionCostReport(file, { since: f.at(8), until: f.at(9), sourceOnly: true }).parent;
  assert.equal(summary.coverage, 'recorded-gaps');
  assert.equal(summary.costUsd, null);
});

test('advancing snapshots below pending billing counters retain later uncertainty', () => {
  const f = cumulativeCostFixture();
  for (const multiple of [1.5, 2]) {
    const file = f.save([
      ...f.start,
      f.bill('one', 3, 1),
      f.snapshot(4, 1),
      f.bill('two', 5, 2),
      ...(multiple === 2 ? [f.bill('three', 6, 3)] : []),
      f.snapshot(7, multiple),
      ...(multiple === 2 ? [] : [f.bill('three', 8, 3)]),
      f.snapshot(9, 3),
    ]);
    const summary = sessionCostReport(file, {
      since: f.at(8),
      until: f.at(10),
      byModel: true,
      sourceOnly: true,
    }).parent;
    assert.equal(summary.costUsd, multiple === 2 ? undefined : null);
    if (multiple !== 2) {
      assert.equal(summary.coverage, 'billed-with-unknown-coverage');
      assert.equal(summary.requestCountExact, false);
      assert.equal(summary.pricedCostUsd, 0.003);
      assert.equal(summary.modelCosts![0].costUsd, null);
    } else {
      const whole = sessionCostReport(file, { byModel: true, sourceOnly: true }).parent;
      assert.equal(whole.costUsd, 0.009);
      assert.equal(whole.coverage, 'recorded-reconciled');
      assert.equal(whole.modelCosts![0].costUsd, 0.009);
    }
  }
});

test('a repaired cumulative bill progresses at its accepted arrival without charging twice', () => {
  const f = cumulativeCostFixture();
  const partial = {
    type: 'token_usage_record',
    timestamp: f.at(4),
    payload: {
      response_id: 'two',
      turn_id: 'turn-1',
      thread_id: 'parent',
      usage: { input_tokens: 1000 },
    },
  };
  const file = f.save([
    ...f.start,
    f.bill('one', 3, 1),
    partial,
    f.snapshot(5, 1),
    f.bill('two', 6, 2),
    f.snapshot(7, 1),
    f.bill('three', 8, 3),
    f.snapshot(9, 3),
  ]);
  const later = sessionCostReport(file, { since: f.at(8), until: f.at(10), byModel: true, sourceOnly: true }).parent;
  assert.equal(later.costUsd, null);
  assert.equal(later.coverage, 'billed-with-unknown-coverage');
  assert.equal(later.pricedCostUsd, 0.003);
  assert.equal(later.requestCountExact, false);
  assert.equal(later.modelCosts![0].costUsd, null);
  const threadRevision = {
    ...partial,
    timestamp: f.at(6),
    payload: { ...partial.payload, thread_token_usage: f.usage(2) },
  };
  const turnRevision = {
    ...partial,
    timestamp: f.at(10),
    payload: { ...partial.payload, turn_token_usage: f.usage(2) },
  };
  const usageRevision = { ...partial, timestamp: f.at(11), payload: { ...partial.payload, usage: f.usage() } };
  const split = f.save([
    ...f.start,
    f.bill('one', 3, 1),
    partial,
    f.snapshot(5, 1),
    threadRevision,
    f.snapshot(7, 1),
    turnRevision,
    usageRevision,
    f.bill('three', 12, 3),
    f.snapshot(13, 3),
  ]);
  const afterSplit = sessionCostReport(split, { since: f.at(12), until: f.at(14), sourceOnly: true }).parent;
  assert.equal(afterSplit.costUsd, null);
  assert.equal(afterSplit.pricedCostUsd, 0.003);
  const charged = sessionCostReport(split, { since: f.at(4), until: f.at(5), sourceOnly: true }).parent;
  assert.equal(charged.requests, 1);
  assert.equal(charged.pricedCostUsd, 0.003);
  const duplicate = f.save([
    ...f.start,
    f.bill('one', 3, 1),
    f.snapshot(5, 1),
    f.bill('one', 6, 1),
    f.snapshot(7, 1),
    f.bill('two', 8, 2),
    f.snapshot(9, 2),
  ]);
  assert.equal(sessionCostReport(duplicate, { sourceOnly: true }).parent.costUsd, 0.006);
});

test('backward restart clocks preserve both boundaries and empty uncertain windows', () => {
  const f = cumulativeCostFixture();
  for (const priorReset of [false, true]) {
    const file = f.save([
      ...f.start,
      f.bill('one', 3, 1),
      f.snapshot(4, 1),
      ...(priorReset ? [f.snapshot(8, 0)] : []),
      { type: 'compacted', timestamp: f.at(8), payload: {} },
      f.bill('restart', 6, 1),
      f.snapshot(9, 1),
      f.bill('next', 12, 2),
      f.snapshot(13, 2),
    ]);
    for (const since of [6, 7, 8]) {
      const summary = sessionCostReport(file, {
        since: f.at(since),
        until: f.at(since + 1),
        byModel: true,
        sourceOnly: true,
      }).parent;
      assert.equal(summary.costUsd, null);
      assert.equal(summary.coverage, 'billed-with-unknown-coverage');
      assert.equal(summary.requestCountExact, false);
      if (since === 6) {
        assert.equal(summary.pricedCostUsd, 0.003);
        assert.equal(summary.modelCosts![0].costUsd, null);
      } else assert.equal(summary.requests, 0);
    }
    assert.equal(sessionCostReport(file, { since: f.at(3), until: f.at(5), sourceOnly: true }).parent.costUsd, 0.003);
    assert.equal(sessionCostReport(file, { since: f.at(12), until: f.at(14), sourceOnly: true }).parent.costUsd, 0.003);
  }
});

test('an incompatible future baseline preserves reset uncertainty and later recovery', () => {
  const f = cumulativeCostFixture();
  const file = f.save([
    ...f.start,
    f.bill('one', 3, 1),
    f.snapshot(4, 1),
    f.bill('two', 5, 2),
    f.snapshot(7, 1),
    f.bill('restart', 8, 1),
    f.snapshot(9, 1),
    f.bill('next', 12, 2),
    f.snapshot(13, 2),
  ]);
  const empty = sessionCostReport(file, { since: f.at(7), until: f.at(8), byModel: true, sourceOnly: true });
  assert.equal(empty.parent.coverage, 'billed-with-unknown-coverage');
  assert.equal(empty.parent.costUsd, null);
  assert.equal(empty.parent.requestCountExact, false);
  assert.equal(empty.combined.costUsd, null);
  assert.equal(sessionCostReport(file, { since: f.at(3), until: f.at(5), sourceOnly: true }).parent.costUsd, 0.003);
  const recovered = sessionCostReport(file, { since: f.at(12), until: f.at(14), byModel: true, sourceOnly: true });
  assert.equal(recovered.parent.coverage, 'recorded-reconciled');
  assert.equal(recovered.parent.costUsd, 0.003);
  assert.equal(recovered.parent.requestCountExact, undefined);
  assert.equal(recovered.parent.modelCosts![0].costUsd, 0.003);
  assert.equal(recovered.combined.costUsd, 0.003);
});

test('delayed restart snapshots recover after billing advances without consuming a rejected future match', () => {
  const f = cumulativeCostFixture();
  for (const resetToZero of [true, false]) {
    for (const restartSecond of [8, 7, 6]) {
      for (const early of [false, true]) {
        for (const duplicate of [false, true]) {
          const restart = f.snapshot(resetToZero ? 13 : 11, 1);
          const file = f.save([
            ...f.start,
            f.bill('one', 3, 1),
            f.snapshot(4, 1),
            f.bill('two', 5, 2),
            f.snapshot(7, resetToZero ? 0 : 1, resetToZero ? f.usage(0) : f.usage()),
            f.bill('restart', restartSecond, 1),
            ...(early ? [restart, ...(duplicate ? [restart] : [])] : []),
            f.bill('next', resetToZero ? 12 : 10, 2),
            ...(early ? [] : [restart, ...(duplicate ? [restart] : [])]),
            f.snapshot(resetToZero ? 14 : 12, 2),
            ...(resetToZero ? [] : [f.bill('third', 14, 3), f.snapshot(15, 3)]),
          ]);
          const report = sessionCostReport(file, {
            since: f.at(resetToZero ? 12 : 14),
            until: f.at(resetToZero ? 15 : 16),
            byModel: true,
            sourceOnly: true,
          });
          for (const summary of [report.parent, report.combined, report.parent.modelCosts![0]]) {
            assert.equal(
              summary.coverage,
              'recorded-reconciled',
              JSON.stringify({ resetToZero, restartSecond, early, duplicate }),
            );
            assert.equal(summary.requestCountExact, undefined);
            assert.equal(summary.costUsd, 0.003);
            assert.equal(summary.pricedCostUsd, 0.003);
            assert.equal(summary.requests, 1);
          }
        }
      }
    }
  }
});

test('compatible snapshots before their bills preserve cumulative progression', () => {
  const f = cumulativeCostFixture();
  const file = f.save([
    ...f.start,
    f.snapshot(3, 1),
    f.bill('one', 4, 1),
    f.snapshot(5, 2),
    f.bill('two', 6, 2),
    f.snapshot(7, 0, f.usage(0)),
    f.snapshot(9, 1),
    f.bill('restart', 8, 1),
    f.snapshot(11, 2),
    f.bill('next', 12, 2),
  ]);
  for (const [since, until, cost] of [
    [4, 7, 0.006],
    [12, 14, 0.003],
  ]) {
    const report = sessionCostReport(file, { since: f.at(since), until: f.at(until), byModel: true, sourceOnly: true });
    assert.equal(report.parent.costUsd, cost);
    assert.equal(report.parent.requestCountExact, undefined);
    assert.equal(report.parent.coverage, 'recorded-reconciled');
    assert.equal(report.parent.modelCosts![0].costUsd, cost);
    assert.equal(report.combined.costUsd, cost);
  }
});

test('an unchanged delayed snapshot cannot invent a reset while billing is ahead', () => {
  const f = cumulativeCostFixture();
  for (const duplicate of [[], [f.snapshot(6, 1)]]) {
    const file = f.save([
      ...f.start,
      f.bill('one', 3, 1),
      f.bill('two', 4, 2),
      f.snapshot(5, 1),
      ...duplicate,
      f.snapshot(7, 2),
      f.bill('three', 9, 3),
      f.snapshot(10, 3),
    ]);
    const report = sessionCostReport(file, { since: f.at(9), until: f.at(11), byModel: true, sourceOnly: true });
    assert.equal(report.parent.coverage, 'recorded-reconciled');
    assert.equal(report.parent.costUsd, 0.003);
    assert.equal(report.parent.modelCosts![0].costUsd, 0.003);
    assert.equal(report.combined.costUsd, 0.003);
  }
});

test('a usage-only repair cannot replay inherited cumulative fields after compaction', () => {
  const f = cumulativeCostFixture();
  const partial = f.bill('two', 5, 2);
  const repair = {
    type: 'token_usage_record',
    timestamp: f.at(11),
    payload: {
      thread_id: 'parent',
      turn_id: 'turn-1',
      response_id: 'two',
      usage: f.usage(),
    },
  };
  for (const beforeCompaction of [false, true]) {
    const file = f.save([
      ...f.start,
      f.bill('one', 3, 1),
      f.snapshot(4, 1),
      { ...partial, payload: { ...partial.payload, usage: { input_tokens: 1000 } } },
      f.snapshot(6, 2),
      ...(beforeCompaction ? [repair] : []),
      { type: 'compacted', timestamp: f.at(8), payload: {} },
      f.bill('restart', 9, 1),
      f.snapshot(10, 1),
      ...(beforeCompaction ? [] : [repair]),
      f.snapshot(12, 1),
      f.bill('next', 13, 2),
      f.snapshot(14, 2),
    ]);
    const charged = sessionCostReport(file, { since: f.at(5), until: f.at(6), sourceOnly: true }).parent;
    assert.equal(charged.requests, 1);
    assert.equal(charged.costUsd, 0.003);
    for (const [since, until] of [
      [9, 11],
      [12, 15],
    ]) {
      const report = sessionCostReport(file, {
        since: f.at(since),
        until: f.at(until),
        byModel: true,
        sourceOnly: true,
      });
      assert.equal(report.parent.coverage, 'recorded-reconciled');
      assert.equal(report.parent.costUsd, 0.003);
      assert.equal(report.parent.requestCountExact, undefined);
      assert.equal(report.parent.modelCosts![0].costUsd, 0.003);
      assert.equal(report.combined.costUsd, 0.003);
    }
  }
});

test('a child with only an intersecting unknown interval remains in the combined report', () => {
  const root = directory();
  const parentFixture = cumulativeCostFixture();
  const childFixture = cumulativeCostFixture('child');
  const parent = write(path.join(root, 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    ...parentFixture.start,
    parentFixture.bill('parent-one', 3, 1),
    parentFixture.snapshot(4, 1),
  ]);
  write(path.join(root, 'rollout-2026-09-26T00-00-00-child.jsonl'), [
    { ...childFixture.start[0], payload: { ...childFixture.start[0].payload, parent_thread_id: 'parent' } },
    ...childFixture.start.slice(1),
    childFixture.bill('child-one', 3, 1),
    childFixture.snapshot(4, 1),
    { type: 'compacted', timestamp: childFixture.at(6), payload: {} },
  ]);
  const report = sessionCostReport(parent, {
    since: parentFixture.at(8),
    until: parentFixture.at(9),
    roots: { codexSessions: root, projects: root },
  });
  assert.equal(report.parent.costUsd, undefined);
  assert.equal(report.children.length, 1);
  assert.equal(report.children[0].requests, 0);
  assert.equal(report.children[0].coverage, 'billed-with-unknown-coverage');
  assert.equal(report.combined.costUsd, null);
  assert.equal(report.combined.requestCountExact, false);
});

test('a repeated parent request counts once and keeps its first usage', () => {
  const file = write(path.join(directory(), 'parent.jsonl'), [
    claudeRequest('request-1', 4, ['tool-1']),
    claudeRequest('request-1', 40, ['tool-1', 'tool-2']),
  ]);
  const requests = readSessionRequests(file);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].usage.output, 4);
  assert.equal(requests[0].toolCalls, 2);
});

test('Codex billing records count unique requests alongside matching token snapshots', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = (input: number, output: number) => ({
    input_tokens: input,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  });
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'turn-1' } },
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'turn-1', model: 'gpt-5.6-terra' } },
    {
      type: 'token_usage_record',
      timestamp: at(3),
      payload: { response_id: 'ordinary', turn_id: 'turn-1', usage: usage(10, 2) },
    },
    {
      type: 'event_msg',
      timestamp: at(4),
      payload: { type: 'token_count', info: { last_token_usage: usage(10, 2), total_token_usage: usage(10, 2) } },
    },
    {
      type: 'token_usage_record',
      timestamp: at(4),
      payload: { response_id: 'same-usage', turn_id: 'turn-1', usage: usage(10, 2) },
    },
    {
      type: 'token_usage_record',
      timestamp: at(5),
      payload: { response_id: 'compaction', turn_id: 'turn-1', usage: usage(168_565, 200) },
    },
    {
      type: 'token_usage_record',
      timestamp: at(5),
      payload: { response_id: 'compaction', turn_id: 'turn-1', usage: usage(168_565, 200) },
    },
    {
      type: 'compacted',
      timestamp: at(6),
      payload: { compaction_response_id: 'compaction', latest_token_usage_record: { usage: usage(168_565, 200) } },
    },
    {
      type: 'event_msg',
      timestamp: at(6),
      payload: {
        type: 'thread_settings_applied',
        thread_settings: { model: 'gpt-6-sol', model_provider_id: 'openai' },
      },
    },
    {
      type: 'event_msg',
      timestamp: at(7),
      payload: { type: 'token_count', info: { last_token_usage: usage(0, 0), total_token_usage: usage(10, 2) } },
    },
    {
      type: 'token_usage_record',
      timestamp: at(8),
      payload: { response_id: 'unmatched', turn_id: 'turn-1', usage: usage(20, 3) },
    },
  ]);
  const report = sessionCostReport(file);
  assert.equal(report.parent.requests, 4);
  assert.equal(report.parent.uncachedInputTokens, 168_605);
  assert.deepEqual(report.parent.models, ['gpt-5.6-terra', 'gpt-6-sol']);
  assert.equal(report.parent.coverage, 'billed-with-unknown-coverage');
  assert.equal(report.parent.costUsd, null);
  assert.equal(report.parent.snapshotEvidence?.count, 1);
});

test('a delayed copied-turn date removes billing usage from the session report', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: 12,
  };
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'copied' } },
    {
      type: 'token_usage_record',
      timestamp: at(2),
      payload: { response_id: 'copied-response', turn_id: 'copied', usage },
    },
    { type: 'event_msg', timestamp: at(3), payload: { type: 'task_started', turn_id: 'current' } },
    {
      type: 'turn_context',
      timestamp: at(4),
      payload: { turn_id: 'copied', model: 'gpt-6-sol', current_date: '2026-08-24' },
    },
  ]);
  assert.equal(sessionCostReport(file).parent.requests, 0);
});

test('a delayed copied-turn date removes an earlier failed tool from the report', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'copied' } },
    {
      type: 'event_msg',
      timestamp: at(2),
      payload: { type: 'item_completed', item: { type: 'CommandExecution', status: 'failed' } },
    },
    { type: 'event_msg', timestamp: at(3), payload: { type: 'task_started', turn_id: 'current' } },
    {
      type: 'turn_context',
      timestamp: at(4),
      payload: { turn_id: 'copied', model: 'gpt-6-sol', current_date: '2026-08-24' },
    },
  ]);
  const report = sessionCostReport(file);
  assert.equal(report.parent.failedToolCalls, 0);
  assert.equal(report.combined.failedToolCalls, 0);
});

test('a later turn setting does not change a preceding compaction response', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: 12,
  };
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'first' } },
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'first', model: 'gpt-6-sol' } },
    { type: 'token_usage_record', timestamp: at(3), payload: { response_id: 'compact', turn_id: 'first', usage } },
    {
      type: 'compacted',
      timestamp: at(4),
      payload: { compaction_response_id: 'compact', latest_token_usage_record: { usage } },
    },
    { type: 'event_msg', timestamp: at(5), payload: { type: 'task_complete' } },
    { type: 'event_msg', timestamp: at(6), payload: { type: 'task_started', turn_id: 'second' } },
    {
      type: 'event_msg',
      timestamp: at(7),
      payload: {
        type: 'thread_settings_applied',
        thread_settings: { model: 'gpt-5.6-terra', model_provider_id: 'amazon-bedrock', service_tier: 'priority' },
      },
    },
  ]);
  const request = readSessionRequests(file)[0];
  assert.deepEqual([request.model, request.provider, request.serviceTier], ['gpt-6-sol', 'openai', null]);
});

test('billing usage receives delayed model metadata and retains pending tools', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: 12,
  };
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'first' } },
    { type: 'response_item', timestamp: at(2), payload: { type: 'custom_tool_call', call_id: 'call-a' } },
    { type: 'token_usage_record', timestamp: at(3), payload: { response_id: 'response-a', turn_id: 'first', usage } },
    { type: 'turn_context', timestamp: at(4), payload: { turn_id: 'first', model: 'gpt-6-sol' } },
  ]);
  assert.deepEqual(
    readSessionRequests(file)
      .filter((request) => !request.coverageDefect)
      .map((request) => [request.model, request.toolCalls]),
    [['gpt-6-sol', 1]],
  );
  assert.equal(sessionCostReport(file).parent.pricedRequests, 1);
});

test('equal billing usage on separate responses does not merge across a preceding snapshot', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: 12,
  };
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'first' } },
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'first', model: 'gpt-6-sol' } },
    {
      type: 'event_msg',
      timestamp: at(3),
      payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } },
    },
    {
      type: 'token_usage_record',
      timestamp: at(4),
      payload: { response_id: 'later-response', turn_id: 'first', usage },
    },
  ]);
  const summary = sessionCostReport(file).parent;
  assert.equal(summary.requests, 1);
  assert.equal(summary.snapshotEvidence?.count, 1);
  assert.equal(summary.costUsd, null);
});

test('one bill and a later equal snapshot retain separate evidence without inventing a second bill', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: 12,
  };
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'first' } },
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'first', model: 'gpt-6-sol' } },
    { type: 'token_usage_record', timestamp: at(3), payload: { response_id: 'bill', turn_id: 'first', usage } },
    {
      type: 'event_msg',
      timestamp: at(4),
      payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } },
    },
  ]);
  const report = sessionCostReport(file);
  assert.deepEqual(
    [report.parent.requests, report.parent.snapshotEvidence?.count, report.parent.uncachedInputTokens],
    [1, 1, 10],
  );
  assert.equal(report.parent.coverage, 'billed-with-unknown-coverage');
  assert.equal(report.parent.costUsd, null);
  assert.equal(report.parent.pricedRequests, 1);
  assert.equal(report.parent.costPerRequest, null);
  assert.equal(report.parent.requestsWithTwoOrMoreTools, null);
  const beforeSnapshot = sessionCostReport(file, { until: at(4) }).parent;
  assert.deepEqual([beforeSnapshot.requests, beforeSnapshot.snapshotEvidence], [1, undefined]);
  const afterBill = sessionCostReport(file, { since: at(4) }).parent;
  assert.deepEqual([afterBill.requests, afterBill.snapshotEvidence?.count], [0, 1]);
  assert.equal(afterBill.coverage, 'billed-with-unknown-coverage');
  assert.equal(afterBill.toolCalls, null);
});

test('two bills before two snapshots price only the two identified responses', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: 12,
  };
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'first' } },
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'first', model: 'gpt-6-sol' } },
    { type: 'token_usage_record', timestamp: at(3), payload: { response_id: 'one', turn_id: 'first', usage } },
    { type: 'token_usage_record', timestamp: at(4), payload: { response_id: 'two', turn_id: 'first', usage } },
    {
      type: 'event_msg',
      timestamp: at(5),
      payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } },
    },
    {
      type: 'event_msg',
      timestamp: at(6),
      payload: {
        type: 'token_count',
        info: { last_token_usage: usage, total_token_usage: { ...usage, input_tokens: 20 } },
      },
    },
  ]);
  const summary = sessionCostReport(file).parent;
  assert.deepEqual([summary.requests, summary.snapshotEvidence?.count, summary.uncachedInputTokens], [2, 2, 20]);
  assert.equal(summary.costUsd, null);
});

test('a partial billed response stays unpriced', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'first' } },
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'first', model: 'gpt-6-sol' } },
    {
      type: 'token_usage_record',
      timestamp: at(3),
      payload: { response_id: 'partial', turn_id: 'first', usage: { input_tokens: 10, output_tokens: 2 } },
    },
  ]);
  const summary = sessionCostReport(file).parent;
  assert.deepEqual(
    [summary.requests, summary.pricedRequests, summary.unpricedRequests, summary.pricedCostUsd],
    [1, 0, 1, 0],
  );
  assert.equal(summary.costUsd, null);
  assert.equal(summary.uncachedInputTokens, 10);
  assert.equal(summary.outputTokens, 2);
});

test('a complete revision repairs a partial bill, while malformed counters remain unpriced', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const records: object[] = [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'first' } },
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'first', model: 'gpt-6-sol' } },
    {
      type: 'token_usage_record',
      timestamp: at(3),
      payload: { response_id: 'bill', turn_id: 'first', usage: { input_tokens: 10, output_tokens: 2 } },
    },
  ];
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), records);
  assert.equal(sessionCostReport(file, { sourceOnly: true }).parent.unpricedRequests, 1);
  records.push({
    type: 'token_usage_record',
    timestamp: at(4),
    payload: {
      response_id: 'bill',
      turn_id: 'first',
      usage: {
        input_tokens: 10,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 2,
        reasoning_output_tokens: 0,
      },
    },
  });
  write(file, records);
  assert.deepEqual(
    [
      sessionCostReport(file, { sourceOnly: true }).parent.pricedRequests,
      sessionCostReport(file, { sourceOnly: true }).parent.uncachedInputTokens,
    ],
    [1, 10],
  );
  records.push({
    type: 'token_usage_record',
    timestamp: at(5),
    payload: {
      response_id: 'bad',
      turn_id: 'first',
      usage: {
        input_tokens: 10,
        cached_input_tokens: 11,
        cache_write_input_tokens: 0,
        output_tokens: 2,
        reasoning_output_tokens: 0,
      },
    },
  });
  write(file, records);
  assert.deepEqual(
    [
      sessionCostReport(file, { sourceOnly: true }).parent.pricedRequests,
      sessionCostReport(file, { sourceOnly: true }).parent.unpricedRequests,
    ],
    [1, 1],
  );
});

test('a duplicate bill leaves later response tools pending', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
  };
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'first' } },
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'first', model: 'gpt-6-sol' } },
    { type: 'token_usage_record', timestamp: at(3), payload: { response_id: 'one', turn_id: 'first', usage } },
    { type: 'response_item', timestamp: at(4), payload: { type: 'custom_tool_call', call_id: 'later-tool' } },
    { type: 'token_usage_record', timestamp: at(5), payload: { response_id: 'one', turn_id: 'first', usage } },
    { type: 'token_usage_record', timestamp: at(6), payload: { response_id: 'two', turn_id: 'first', usage } },
  ]);
  assert.deepEqual(
    readSessionRequests(file)
      .filter((request) => request.billingRecord)
      .map((request) => request.toolCalls),
    [0, 1],
  );
});

test('a Codex child with only a tool call retains its unattributed tool evidence', () => {
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-child.jsonl'), [
    {
      type: 'session_meta',
      timestamp: '2026-09-26T00:00:00Z',
      payload: { id: 'child', source: 'cli', model_provider: 'openai' },
    },
    { type: 'event_msg', timestamp: '2026-09-26T00:00:01Z', payload: { type: 'task_started', turn_id: 'first' } },
    {
      type: 'response_item',
      timestamp: '2026-09-26T00:00:02Z',
      payload: { type: 'custom_tool_call', call_id: 'tool' },
    },
  ]);
  const summary = sessionCostReport(file).parent;
  assert.equal(summary.requests, 0);
  assert.equal(summary.unattributedToolCalls, 1);
  assert.equal(summary.toolCalls, null);
});

test('a partial token snapshot and its billing record count one request', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: 12,
  };
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'first' } },
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'first', model: 'gpt-6-sol' } },
    { type: 'token_usage_record', timestamp: at(3), payload: { response_id: 'response-a', turn_id: 'first', usage } },
    { type: 'event_msg', timestamp: at(4), payload: { type: 'token_count', info: { total_token_usage: usage } } },
  ]);
  const report = sessionCostReport(file);
  assert.equal(report.parent.requests, 1);
  assert.equal(report.parent.uncachedInputTokens, 10);
  assert.equal(report.parent.unpricedRequests, 0);
});

test('a Codex compaction zero-token snapshot without model metadata is not an unpriced request', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = (input: number, output: number) => ({
    input_tokens: input,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  });
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'turn-1' } },
    { type: 'token_usage_record', timestamp: at(2), payload: { usage: usage(168_565, 200) } },
    { type: 'compacted', timestamp: at(3), payload: { latest_token_usage_record: { usage: usage(168_565, 200) } } },
    {
      type: 'event_msg',
      timestamp: at(4),
      payload: { type: 'token_count', info: { last_token_usage: usage(0, 0), total_token_usage: usage(0, 0) } },
    },
  ]);
  assert.deepEqual(
    readSessionRequests(file).filter((request) => !request.coverageDefect),
    [],
  );
  assert.equal(sessionCostReport(file).parent.requests, 0);
  fs.appendFileSync(
    file,
    JSON.stringify({
      type: 'event_msg',
      timestamp: at(5),
      payload: { type: 'token_count', info: { total_token_usage: usage(10, 2) } },
    }) + '\n',
  );
  const summary = sessionCostReport(file).parent;
  assert.equal(summary.requests, 1);
  assert.equal(summary.unpricedRequests, 1);
  assert.equal(summary.costUsd, null);
});

test('a compaction snapshot retains 64 requests awaiting model metadata', () => {
  const at = (millisecond: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, 0, millisecond)).toISOString();
  const usage = (input: number, output = 2) => ({
    input_tokens: input,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  });
  const records: object[] = [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'turn-1' } },
  ];
  for (let index = 0; index < 64; index++) {
    records.push({
      type: 'event_msg',
      timestamp: at(index + 2),
      payload: {
        type: 'token_count',
        info: { last_token_usage: usage(10), total_token_usage: usage((index + 1) * 10, (index + 1) * 2) },
      },
    });
  }
  records.push(
    { type: 'compacted', timestamp: at(66), payload: {} },
    {
      type: 'event_msg',
      timestamp: at(67),
      payload: { type: 'token_count', info: { last_token_usage: usage(0, 0), total_token_usage: usage(640, 128) } },
    },
  );
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), records);
  const requests = readSessionRequests(file);
  assert.equal(requests.filter((request) => !request.coverageDefect).length, 64);
  assert.equal(requests[0].usage.input, 10);
  assert.equal(sessionCostReport(file).parent.requests, 64);
});

test('old copied turns lose both billed and snapshot usage while a replay keeps its original bill', () => {
  const at = (n: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, 0, n)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: 12,
  };
  const records: object[] = [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
  ];
  for (const id of ['original', 'copied']) {
    records.push(
      { type: 'event_msg', timestamp: at(records.length), payload: { type: 'task_started', turn_id: id } },
      { type: 'turn_context', timestamp: at(records.length + 1), payload: { turn_id: id, model: 'gpt-6-sol' } },
      {
        type: 'token_usage_record',
        timestamp: at(records.length + 2),
        payload: { response_id: id, turn_id: id, usage },
      },
      {
        type: 'event_msg',
        timestamp: at(records.length + 3),
        payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } },
      },
    );
  }
  for (let index = 0; index < 65; index++) {
    records.push({
      type: 'event_msg',
      timestamp: at(records.length),
      payload: { type: 'task_started', turn_id: `later-${index}` },
    });
  }
  records.push(
    {
      type: 'turn_context',
      timestamp: at(500),
      payload: { turn_id: 'copied', model: 'gpt-6-sol', current_date: '2026-08-24' },
    },
    { type: 'event_msg', timestamp: at(501), payload: { type: 'task_started', turn_id: 'original' } },
    { type: 'turn_context', timestamp: at(501), payload: { turn_id: 'original', model: 'gpt-5.6-terra' } },
    { type: 'token_usage_record', timestamp: at(502), payload: { response_id: 'replay', turn_id: 'original', usage } },
    {
      type: 'event_msg',
      timestamp: at(503),
      payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } },
    },
  );
  const requests = readSessionRequests(
    write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), records),
  );
  assert.deepEqual(
    requests.filter((request) => !request.evidenceOnly).map((request) => request.requestKey),
    ['codex-billing:original'],
  );
  assert.equal(requests.find((request) => request.billingRecord)?.model, 'gpt-6-sol');
});

test('replayed model metadata cannot price an original bill without a model', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
  };
  const records: object[] = [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'original' } },
    {
      type: 'token_usage_record',
      timestamp: at(2),
      payload: { response_id: 'original-response', turn_id: 'original', usage },
    },
  ];
  for (let index = 0; index < 65; index++)
    records.push({
      type: 'event_msg',
      timestamp: at(index + 3),
      payload: { type: 'task_started', turn_id: `later-${index}` },
    });
  records.push(
    { type: 'event_msg', timestamp: at(68), payload: { type: 'task_started', turn_id: 'original' } },
    { type: 'turn_context', timestamp: at(69), payload: { turn_id: 'original', model: 'gpt-6-astra' } },
    {
      type: 'token_usage_record',
      timestamp: at(70),
      payload: { response_id: 'replayed-response', turn_id: 'original', usage },
    },
  );
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), records);
  const requests = readSessionRequests(file).filter((request) => request.billingRecord);
  assert.deepEqual(
    requests.map((request) => [request.requestKey, request.model]),
    [['codex-billing:original-response', null]],
  );
  const summary = sessionCostReport(file).parent;
  assert.equal(summary.unpricedRequests, 1);
  assert.equal(summary.costUsd, null);
});

test('original turn metadata prices its bill while another turn replays', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
  };
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'original' } },
    {
      type: 'token_usage_record',
      timestamp: at(2),
      payload: { response_id: 'original-bill', turn_id: 'original', usage },
    },
    { type: 'event_msg', timestamp: at(3), payload: { type: 'task_started', turn_id: 'other' } },
    { type: 'event_msg', timestamp: at(4), payload: { type: 'task_started', turn_id: 'other' } },
    { type: 'turn_context', timestamp: at(5), payload: { turn_id: 'original', model: 'gpt-6-sol' } },
  ]);
  const requests = readSessionRequests(file).filter((request) => request.billingRecord);
  assert.deepEqual(
    requests.map((request) => [request.requestKey, request.model]),
    [['codex-billing:original-bill', 'gpt-6-sol']],
  );
  assert.equal(sessionCostReport(file).parent.unpricedRequests, 0);
});

test('replayed turn metadata cannot price its original bill after another turn starts', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
  };
  const records: object[] = [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'original' } },
    {
      type: 'token_usage_record',
      timestamp: at(2),
      payload: { response_id: 'original-bill', turn_id: 'original', usage },
    },
  ];
  for (let index = 0; index < 65; index++)
    records.push({
      type: 'event_msg',
      timestamp: at(index + 3),
      payload: { type: 'task_started', turn_id: `later-${index}` },
    });
  records.push(
    { type: 'event_msg', timestamp: at(68), payload: { type: 'task_started', turn_id: 'original' } },
    { type: 'event_msg', timestamp: at(69), payload: { type: 'task_started', turn_id: 'next' } },
    { type: 'turn_context', timestamp: at(70), payload: { turn_id: 'original', model: 'gpt-6-astra' } },
  );
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), records);
  assert.deepEqual(
    readSessionRequests(file)
      .filter((request) => request.billingRecord)
      .map((request) => [request.requestKey, request.model]),
    [['codex-billing:original-bill', null]],
  );
  assert.equal(sessionCostReport(file).parent.unpricedRequests, 1);
});

test('replayed context cannot price an earlier anonymous snapshot after another turn starts', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2, total_tokens: 12 };
  const records: object[] = [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'original' } },
    {
      type: 'event_msg',
      timestamp: at(2),
      payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } },
    },
  ];
  for (let index = 0; index < 65; index++)
    records.push({
      type: 'event_msg',
      timestamp: at(index + 3),
      payload: { type: 'task_started', turn_id: `later-${index}` },
    });
  records.push(
    { type: 'event_msg', timestamp: at(68), payload: { type: 'task_started', turn_id: 'original' } },
    { type: 'event_msg', timestamp: at(69), payload: { type: 'task_started', turn_id: 'next' } },
    { type: 'turn_context', timestamp: at(70), payload: { turn_id: 'original', model: 'gpt-6-astra' } },
  );
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), records);
  assert.deepEqual(
    readSessionRequests(file).map((request) => request.model),
    [null],
  );
  assert.equal(sessionCostReport(file).parent.unpricedRequests, 1);
});

test('replayed context does not release an anonymous original snapshot at its new model', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2, total_tokens: 12 };
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'original' } },
    {
      type: 'event_msg',
      timestamp: at(2),
      payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } },
    },
    { type: 'event_msg', timestamp: at(3), payload: { type: 'task_started', turn_id: 'original' } },
    { type: 'event_msg', timestamp: at(4), payload: { type: 'task_started', turn_id: 'next' } },
    { type: 'turn_context', timestamp: at(5), payload: { turn_id: 'original', model: 'gpt-6-astra' } },
  ]);
  assert.deepEqual(
    readSessionRequests(file).map((request) => request.model),
    [null],
  );
});

test('replayed Codex snapshot and failed completion do not add usage or failures after 65 turns', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2, total_tokens: 12 };
  const records: object[] = [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'original' } },
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'original', model: 'gpt-6-sol' } },
    { type: 'response_item', timestamp: at(2), payload: { type: 'custom_tool_call', call_id: 'original-tool' } },
    {
      type: 'event_msg',
      timestamp: at(3),
      payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } },
    },
    {
      type: 'event_msg',
      timestamp: at(4),
      payload: { type: 'item_completed', item: { type: 'CommandExecution', status: 'failed' } },
    },
  ];
  for (let index = 0; index < 65; index++)
    records.push({
      type: 'event_msg',
      timestamp: at(index + 5),
      payload: { type: 'task_started', turn_id: `later-${index}` },
    });
  records.push(
    { type: 'event_msg', timestamp: at(70), payload: { type: 'task_started', turn_id: 'original' } },
    { type: 'turn_context', timestamp: at(71), payload: { turn_id: 'original', model: 'gpt-6-sol' } },
    { type: 'response_item', timestamp: at(71), payload: { type: 'custom_tool_call', call_id: 'original-tool' } },
    {
      type: 'event_msg',
      timestamp: at(72),
      payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } },
    },
    {
      type: 'event_msg',
      timestamp: at(73),
      payload: { type: 'item_completed', item: { type: 'CommandExecution', status: 'failed' } },
    },
  );
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), records);
  assert.equal(readSessionRequests(file).length, 1);
  const summary = sessionCostReport(file).parent;
  assert.equal(summary.failedToolCalls, 1);
  assert.equal(summary.unattributedToolCalls, undefined);
});

test('a large Codex failure history remains reportable', () => {
  const file = path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl');
  const failure = JSON.stringify({
    type: 'event_msg',
    timestamp: '2026-09-26T00:00:03Z',
    payload: { type: 'item_completed', item: { type: 'CommandExecution', status: 'failed' } },
  });
  fs.writeFileSync(
    file,
    [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-09-26T00:00:00Z',
        payload: { id: 'parent', source: 'cli', model_provider: 'openai' },
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-09-26T00:00:01Z',
        payload: { type: 'task_started', turn_id: 'turn' },
      }),
      failure.repeat(130_000).replaceAll('}{', '}\n{'),
    ].join('\n') + '\n',
  );
  assert.equal(sessionCostReport(file).parent.failedToolCalls, 130_000);
}, 30_000);

test('billing identity survives a duplicate across a snapshot and delayed metadata after 65 turns', () => {
  const at = (n: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, 0, n)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: 12,
  };
  const records: object[] = [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'first' } },
    { type: 'response_item', timestamp: at(2), payload: { type: 'custom_tool_call', call_id: 'tool' } },
    { type: 'token_usage_record', timestamp: at(3), payload: { response_id: 'same', turn_id: 'first', usage } },
    {
      type: 'event_msg',
      timestamp: at(4),
      payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } },
    },
    { type: 'token_usage_record', timestamp: at(5), payload: { response_id: 'same', turn_id: 'first', usage } },
  ];
  for (let index = 0; index < 65; index++)
    records.push({
      type: 'event_msg',
      timestamp: at(index + 6),
      payload: { type: 'task_started', turn_id: `later-${index}` },
    });
  records.push({ type: 'turn_context', timestamp: at(100), payload: { turn_id: 'first', model: 'gpt-6-sol' } });
  const requests = readSessionRequests(
    write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), records),
  );
  assert.deepEqual(
    requests
      .filter((request) => !request.evidenceOnly)
      .map((request) => [request.model, request.toolCalls, request.usage.input]),
    [['gpt-6-sol', 1, 10]],
  );
});

test('a later equal snapshot cannot absorb a bill across another billing boundary', () => {
  const at = (n: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, n)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: 12,
  };
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'first' } },
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'first', model: 'gpt-6-sol' } },
    { type: 'token_usage_record', timestamp: at(3), payload: { response_id: 'first', turn_id: 'first', usage } },
    {
      type: 'token_usage_record',
      timestamp: at(4),
      payload: { response_id: 'second', turn_id: 'first', usage: { ...usage, output_tokens: 3 } },
    },
    {
      type: 'event_msg',
      timestamp: at(5),
      payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } },
    },
  ]);
  const summary = sessionCostReport(file).parent;
  assert.equal(summary.requests, 2);
  assert.equal(summary.snapshotEvidence?.count, 1);
});

test('a populated partial snapshot pairs with billing and retains corrected billing metadata', () => {
  const at = (n: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, n)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: 12,
  };
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'first' } },
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'first', model: 'gpt-5.6-terra' } },
    { type: 'token_usage_record', timestamp: at(3), payload: { response_id: 'bill', turn_id: 'first', usage } },
    { type: 'compacted', timestamp: at(4), payload: { compaction_response_id: 'bill' } },
    {
      type: 'event_msg',
      timestamp: at(5),
      payload: {
        type: 'thread_settings_applied',
        thread_settings: { model: 'gpt-6-sol', model_provider_id: 'openai', service_tier: 'priority' },
      },
    },
    {
      type: 'event_msg',
      timestamp: at(6),
      payload: { type: 'token_count', info: { last_token_usage: { output_tokens: 2 }, total_token_usage: usage } },
    },
  ]);
  const requests = readSessionRequests(file);
  assert.deepEqual(
    requests
      .filter((request) => !request.evidenceOnly)
      .map((request) => [request.model, request.serviceTier, request.usage.input]),
    [['gpt-6-sol', 'priority', 10]],
  );
});

test('a closing event prevents later settings from repricing a compaction bill', () => {
  const at = (n: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, n)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: 12,
  };
  for (const close of ['task_complete', 'turn_aborted']) {
    const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
      { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
      { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'first' } },
      { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'first', model: 'gpt-6-sol' } },
      { type: 'token_usage_record', timestamp: at(3), payload: { response_id: 'bill', turn_id: 'first', usage } },
      { type: 'compacted', timestamp: at(4), payload: { compaction_response_id: 'bill' } },
      { type: 'event_msg', timestamp: at(5), payload: { type: close } },
      {
        type: 'event_msg',
        timestamp: at(6),
        payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-5.6-terra' } },
      },
    ]);
    assert.equal(readSessionRequests(file)[0].model, 'gpt-6-sol');
  }
});

test('the last of 65 pending snapshots retains its own pairing position', () => {
  const at = (n: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, 0, n)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: 12,
  };
  const records: object[] = [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'first' } },
  ];
  for (let index = 0; index < 64; index++) {
    records.push({
      type: 'event_msg',
      timestamp: at(index + 2),
      payload: {
        type: 'token_count',
        info: { last_token_usage: usage, total_token_usage: { ...usage, input_tokens: (index + 1) * 10 } },
      },
    });
  }
  records.push(
    { type: 'token_usage_record', timestamp: at(67), payload: { response_id: 'bill', turn_id: 'first', usage } },
    {
      type: 'event_msg',
      timestamp: at(68),
      payload: {
        type: 'token_count',
        info: { last_token_usage: usage, total_token_usage: { ...usage, input_tokens: 650 } },
      },
    },
    { type: 'turn_context', timestamp: at(69), payload: { turn_id: 'first', model: 'gpt-6-sol' } },
  );
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), records);
  const requests = readSessionRequests(file);
  assert.equal(requests.filter((request) => !request.coverageDefect).length, 66);
  assert.ok(requests.some((request) => request.requestKey === `codex:first:${Date.parse(at(2))}:1`));
  assert.ok(
    requests.some((request) => request.requestKey === `codex:first:${Date.parse(at(68))}:65` && request.evidenceOnly),
  );
});

test('a report filters request clocks and omits children outside the window', () => {
  const root = directory();
  const parent = write(path.join(root, 'parent.jsonl'), [
    { ...claudeRequest('since', 2), timestamp: '2026-09-26T00:00:01Z' },
    { ...claudeRequest('until', 2), timestamp: '2026-09-26T00:00:03Z' },
  ]);
  write(path.join(root, 'parent', 'subagents', 'agent-second.jsonl'), [
    { ...claudeRequest('child-second', 2), timestamp: '2026-09-26T00:00:02Z' },
  ]);
  write(path.join(root, 'parent', 'subagents', 'agent-first.jsonl'), [
    { ...claudeRequest('child-first', 2), timestamp: '2026-09-26T00:00:01Z' },
  ]);
  write(path.join(root, 'parent', 'subagents', 'agent-late.jsonl'), [
    { ...claudeRequest('child-late', 2), timestamp: '2026-09-26T00:00:03Z' },
  ]);
  const report = sessionCostReport(parent, { since: '2026-09-25T19:00:01-05:00', until: '2026-09-26T00:00:03Z' });
  assert.deepEqual(report.window, { since: '2026-09-26T00:00:01.000Z', until: '2026-09-26T00:00:03.000Z' });
  assert.equal(report.parent.requests, 1);
  assert.deepEqual(
    report.children.map((child) => child.sessionId),
    ['first', 'second'],
  );
  assert.equal(report.combined.requests, 3);
  assert.match(report.rateNote, /promotional rate through \d{4}-\d{2}-\d{2}/);
  const empty = sessionCostReport(parent, { since: '2026-09-27T00:00:00Z' });
  assert.equal(empty.parent.requests, 0);
  assert.equal(empty.parent.pricedRequests, 0);
  assert.equal(empty.parent.unpricedRequests, 0);
  assert.deepEqual(empty.children, []);
  assert.deepEqual(empty.combined, empty.parent);
});

test('a report rejects impossible ISO window dates, times, and offsets', () => {
  const file = write(path.join(directory(), 'parent.jsonl'), [claudeRequest('one', 2)]);
  for (const since of ['2026-02-30T00:00:00Z', '2026-09-26T25:00:00Z', '2026-09-26T00:00:00+24:00']) {
    assert.throws(() => sessionCostReport(file, { since }), /Invalid since time/);
  }
});

test('until-text Python absolute anchors ignore inner lines and trailing newlines', () => {
  const textRequest = (id: string, second: number, text: string) => ({
    type: 'assistant',
    timestamp: new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString(),
    message: {
      id,
      role: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 10, output_tokens: 2 },
    },
  });
  const file = write(path.join(directory(), 'parent.jsonl'), [
    textRequest('inner', 1, 'Before\nFound\n'),
    textRequest('start', 2, 'Found\n'),
    textRequest('end', 3, 'Before\nFound'),
    textRequest('both', 4, 'Found'),
  ]);
  const start = sessionCostReport(file, { byToolKind: true, untilText: '(?i)\\Afound' });
  const end = sessionCostReport(file, { byToolKind: true, untilText: '(?i)found\\Z' });
  assert.equal(start.untilText?.matched, true);
  assert.equal(end.untilText?.matched, true);
  assert.equal(start.untilText?.byToolKind.rows[0]?.requests, 1);
  assert.equal(end.untilText?.byToolKind.rows[0]?.requests, 2);
});

test('request prices use the request context band, regional rate, and service tier', () => {
  const short = summarizeRequests([pricedRequest('gpt-5.6-terra', 272_000)]);
  const long = summarizeRequests([pricedRequest('gpt-5.6-terra', 272_001)]);
  assert.equal(short.costUsd, 0.544);
  assert.equal(long.costUsd, 1.088);
  const regional = summarizeRequests([pricedRequest('claude-opus-5', 1_000, { inferenceClass: 'in-region' })]);
  assert.equal(regional.costUsd, 0.0055);
  const fast = summarizeRequests([pricedRequest('claude-opus-5-5', 1_000, { serviceTier: 'fast' })]);
  assert.equal(fast.costUsd, 0.008);
  const priority = summarizeRequests([pricedRequest('gpt-5.6-terra', 1_000, { serviceTier: 'priority' })]);
  assert.equal(priority.costUsd, null);
  assert.deepEqual(priority.unpricedModels, []);
});

test('model costs reconcile individual request quotes across providers, tiers, and context bands', () => {
  const requests = [
    pricedRequest('gpt-5.6-terra', 272_000),
    pricedRequest('gpt-5.6-terra', 272_001),
    pricedRequest('gpt-6.1-sol', 100_000),
    pricedRequest('gpt-6.1-sol', 100_000, { serviceTier: 'fast' }),
    pricedRequest('gpt-6.1-sol', 100_000, { serviceTier: 'flex' }),
    pricedRequest('claude-opus-5', 1_000, { inferenceClass: 'in-region' }),
    pricedRequest('claude-opus-5-5', 1_000, { serviceTier: 'fast' }),
    pricedRequest('us.openai.gpt-6.1-sol', 100_000, { provider: 'amazon-bedrock' }),
    pricedRequest('global.openai.gpt-6.1-sol', 100_000, { provider: 'amazon-bedrock' }),
    pricedRequest('gpt-6.1-sol', 100_000, { provider: 'amazon-bedrock', serviceTier: 'fast' }),
    pricedRequest(null, 30, {
      reportedCost: 0.12,
      unclassifiedCacheWrite: 13,
      usage: {
        requests: 1,
        input: 30,
        cacheRead: 17,
        cacheWrite5m: 3,
        cacheWrite1h: 5,
        cacheWrite30m: 7,
        output: 11,
        thinking: 2,
      },
    }),
    pricedRequest('future-model', 40),
  ];
  const plain = summarizeRequests(requests);
  const detail = summarizeRequests(requests, undefined, true);
  const { modelCosts, ...withoutModels } = detail;
  assert.deepEqual(withoutModels, plain);
  assert.deepEqual(plain.models, detail.models);
  assert.equal(modelCosts![0].model, null);
  for (const row of modelCosts!) {
    const expected = summarizeRequests(requests.filter((request) => request.model === row.model));
    assert.equal(row.costUsd, expected.costUsd);
    assert.equal(row.pricedCostUsd, expected.pricedCostUsd);
    assert.equal(row.requests, expected.requests);
    assert.equal(row.unpricedRequests, expected.unpricedRequests);
    assert.equal(row.outputTokens, expected.outputTokens);
    assert.equal(row.reasoningOutputTokens, expected.reasoningOutputTokens);
    assert.deepEqual(
      Object.keys(row).sort(),
      [
        'model',
        'requests',
        'pricedRequests',
        'unpricedRequests',
        'costUsd',
        'pricedCostUsd',
        'uncachedInputTokens',
        'cachedInputTokens',
        'cacheWriteInputTokens',
        'outputTokens',
        'reasoningOutputTokens',
      ].sort(),
    );
  }
  for (const key of [
    'requests',
    'pricedRequests',
    'unpricedRequests',
    'uncachedInputTokens',
    'cachedInputTokens',
    'cacheWriteInputTokens',
    'outputTokens',
    'reasoningOutputTokens',
  ] as const)
    assert.equal(
      modelCosts!.reduce((sum, row) => sum + (row[key] ?? 0), 0),
      detail[key],
    );
  assert.ok(Math.abs(modelCosts!.reduce((sum, row) => sum + row.pricedCostUsd!, 0) - detail.pricedCostUsd!) < 1e-12);
  assert.equal(modelCosts!.find((row) => row.model === 'gpt-5.6-terra')!.pricedCostUsd, 1.632);
  assert.equal(modelCosts!.find((row) => row.model === 'gpt-6.1-sol')!.pricedCostUsd, 0.7);
  assert.equal(modelCosts!.find((row) => row.model === null)!.pricedCostUsd, 0.12);
  assert.equal(modelCosts!.find((row) => row.model === 'future-model')!.costUsd, null);
});

test('model costs retain source uncertainty, partial counters, estimates, and unattributable evidence', () => {
  const rows = [
    pricedRequest('claude-opus-5', 1_000),
    pricedRequest('gpt-6-sol', 2_000, { billingRecord: true }),
    pricedRequest('legacy-model', 3_000, { legacySnapshot: true, reportedCost: 0.2 }),
    pricedRequest(null, 4_000, { incomplete: true }),
    pricedRequest('evidence-model', 5_000, { evidenceOnly: true, billedCoverage: true }),
    pricedRequest(null, 0, { evidenceOnly: true, toolOnly: true, toolCalls: 2 }),
  ];
  const summary = summarizeRequests(rows, undefined, true);
  assert.equal(summary.snapshotEvidence?.inputTokens, 5_000);
  assert.equal(summary.unattributedToolCalls, 2);
  assert.equal(summary.modelCosts!.length, 4);
  assert.equal(
    summary.modelCosts!.reduce((sum, row) => sum + row.requests, 0),
    summary.requests,
  );
  assert.equal(
    summary.modelCosts!.reduce((sum, row) => sum + row.uncachedInputTokens!, 0),
    summary.uncachedInputTokens,
  );
  assert.ok(
    Math.abs(summary.modelCosts!.reduce((sum, row) => sum + row.pricedCostUsd!, 0) - summary.pricedCostUsd!) < 1e-12,
  );
  assert.equal(
    summary.modelCosts!.reduce((sum, row) => sum + (row.estimatedCostUsd ?? 0), 0),
    summary.estimatedCostUsd,
  );
  for (const row of summary.modelCosts!) {
    assert.equal(row.requestCountExact, false);
    assert.equal(row.coverage, 'billed-with-unknown-coverage');
    assert.equal(row.costUsd, null);
  }
  assert.equal(summary.modelCosts![0].unpricedRequests, 1);
  const legacy = summarizeRequests(
    rows.filter((row) => row.legacySnapshot || row.model === 'claude-opus-5'),
    undefined,
    true,
  );
  assert.equal(legacy.modelCosts![0].coverage, 'legacy-snapshots');
  assert.equal(legacy.modelCosts![0].costUsd, null);
  assert.deepEqual(summarizeRequests([rows[4]], undefined, true).modelCosts, []);
  assert.deepEqual(summarizeRequests([], undefined, true).modelCosts, []);
});

test('model costs add unrounded request amounts before rounding public subtotals', () => {
  const same = summarizeRequests(
    [
      pricedRequest('reported-model', 0, { reportedCost: 0.00004 }),
      pricedRequest('reported-model', 0, { reportedCost: 0.00004 }),
    ],
    undefined,
    true,
  );
  assert.equal(same.costUsd, 0.0001);
  assert.equal(same.modelCosts![0].costUsd, 0.0001);
  const separate = summarizeRequests(
    [pricedRequest(null, 0, { reportedCost: 0.00004 }), pricedRequest('reported-model', 0, { reportedCost: 0.00004 })],
    undefined,
    true,
  );
  assert.equal(separate.costUsd, 0.0001);
  assert.equal(
    separate.modelCosts!.reduce((sum, row) => sum + row.costUsd!, 0),
    0,
  );
});

test('model rows keep absent identity distinct and normalized missing counters equal to explicit zero', () => {
  const file = write(path.join(directory(), 'parent.jsonl'), [
    { type: 'assistant', timestamp: '2026-09-26T00:00:01Z', message: { id: 'missing', usage: { input_tokens: 10 } } },
    {
      type: 'assistant',
      timestamp: '2026-09-26T00:00:02Z',
      message: { id: 'zero', model: 'future-model', usage: { input_tokens: 10, output_tokens: 0, thinking_tokens: 0 } },
    },
  ]);
  const summary = sessionCostReport(file, { sourceOnly: true, byModel: true }).parent;
  assert.deepEqual(summary.models, ['future-model']);
  assert.deepEqual(
    summary.modelCosts!.map((row) => [row.model, row.outputTokens, row.reasoningOutputTokens]),
    [
      [null, 0, 0],
      ['future-model', 0, 0],
    ],
  );
  assert.equal(summary.unpricedRequests, 2);
  const bedrockRecords = fs
    .readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', 'bedrock-tool-calls.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  for (const [profile, expected] of [
    ['us.', 0.1744],
    ['global.', 0.1585],
  ] as const) {
    const text = JSON.stringify(bedrockRecords).replaceAll('us.anthropic.', `${profile}anthropic.`);
    const bedrock = write(path.join(directory(), 'bedrock.jsonl'), JSON.parse(text));
    const report = sessionCostReport(bedrock, { sourceOnly: true, byModel: true });
    assert.equal(report.parent.modelCosts![0].model, 'claude-opus-5-5');
    assert.equal(report.parent.modelCosts![0].pricedCostUsd, expected);
    assert.equal(report.parent.pricedCostUsd, expected);
    assert.equal(report.parent.modelCosts![0].requests, report.parent.requests);
  }
});

test('missing speed rate is separate from a missing model rate', () => {
  const fast = summarizeRequests([
    pricedRequest('claude-opus-4-7', 1_000, { serviceTier: 'fast', recordedSpeed: 'fast' }),
  ]);
  assert.equal(fast.fastModeUnpricedRequests, 1);
  assert.deepEqual(fast.unpricedModels, []);
  const priority = summarizeRequests([
    pricedRequest('claude-opus-5', 1_000, { serviceTier: 'priority', recordedSpeed: 'standard' }),
  ]);
  assert.equal(priority.fastModeUnpricedRequests, 0);
  assert.deepEqual(priority.unpricedModels, []);
  const file = write(path.join(directory(), 'parent.jsonl'), [
    {
      type: 'assistant',
      timestamp: '2026-09-26T00:00:01Z',
      message: {
        id: 'standard-priority',
        model: 'claude-opus-4-7',
        content: [],
        usage: {
          input_tokens: 1_000,
          output_tokens: 2,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          speed: 'standard',
          service_tier: 'priority',
        },
      },
    },
  ]);
  assert.equal(sessionCostReport(file).parent.fastModeUnpricedRequests, 0);
});

test('a cumulative Claude child uses the speed on its final usage record', () => {
  const child = write(path.join(directory(), 'agent-child.jsonl'), [
    {
      type: 'assistant',
      timestamp: '2026-09-26T00:00:01Z',
      message: {
        id: 'one',
        model: 'claude-opus-4-7',
        content: [],
        usage: { input_tokens: 1_000, output_tokens: 2, speed: 'standard' },
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-09-26T00:00:02Z',
      message: {
        id: 'one',
        model: 'claude-opus-4-7',
        content: [],
        usage: { input_tokens: 2_000, output_tokens: 4, speed: 'fast' },
      },
    },
  ]);
  const report = summarizeRequests(readSessionRequests(child, 'claude-subagent'));
  assert.equal(report.unpricedRequests, 1);
  assert.equal(report.fastModeUnpricedRequests, 1);
});

test('context mean rounds a half value to the nearest even integer', () => {
  const summary = summarizeRequests([pricedRequest('claude-opus-5', 29_324), pricedRequest('claude-opus-5', 29_325)]);
  assert.equal(summary.contextMean, 29_324);
});

test('combined failure diagnostics retain attributed Claude calls beside Codex failures', () => {
  const claude = pricedRequest('claude-opus-5', 1_000, { failedToolCalls: 1 });
  const codex = pricedRequest('gpt-6-sol', 1_000);
  const summary = summarizeRequests([claude, codex], 1);
  assert.equal(summary.failedToolCalls, 2);
  assert.equal(summary.failedToolCallRequests, 1);
  assert.equal(summary.failedToolCallCostUsd, null);
});

test('a sidechain response does not consume the next parent request tool result', () => {
  const first = claudeRequest('first', 2, ['read-call']);
  const sidechain = { ...claudeRequest('sidechain', 2), isSidechain: true };
  const next = { ...claudeRequest('next', 2), timestamp: '2026-09-26T00:00:03Z' };
  const file = write(path.join(directory(), 'parent.jsonl'), [
    first,
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read-call', content: 'text' }] } },
    sidechain,
    next,
  ]);
  const requests = readSessionRequests(file);
  assert.deepEqual(
    requests.map((request) => request.toolKinds),
    [[], ['other']],
  );
});

test('partial summaries retain known cost and mark unknown models', () => {
  const known = pricedRequest('claude-opus-5', 1_000, {
    usage: {
      requests: 1,
      input: 1_000,
      cacheRead: 1_000,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheWrite30m: 0,
      output: 100,
      thinking: 40,
    },
    toolCalls: 2,
  });
  const unknown = pricedRequest('future-model', 500);
  const summary = summarizeRequests([known, unknown]);
  assert.equal(summary.requests, 2);
  assert.equal(summary.pricedRequests, 1);
  assert.equal(summary.unpricedRequests, 1);
  assert.equal(summary.costUsd, null);
  assert.equal(summary.pricedCostUsd, 0.008);
  assert.deepEqual(summary.costPerRequestByFifth, [0.008, null]);
  assert.equal(summary.contextMean, 1_250);
  assert.equal(summary.contextMax, 2_000);
  assert.equal(summary.contextFirst, 2_000);
  assert.equal(summary.toolCalls, 2);
  assert.equal(summary.requestsWithTwoOrMoreTools, 1);
  assert.deepEqual(summary.models, ['claude-opus-5', 'future-model']);
  assert.deepEqual(summary.unpricedModels, ['future-model']);
  assert.equal(summary.cacheReadShareOfCost, null);
  assert.equal(summarizeRequests([known]).cacheReadShareOfCost, 0.063);
});

test('combined coverage retains billed and legacy source evidence', () => {
  const claude = pricedRequest('claude-opus-5', 1_000);
  const bill = pricedRequest('gpt-6-sol', 1_000, { billingRecord: true });
  const snapshot = pricedRequest('gpt-6-sol', 1_000, { evidenceOnly: true, billedCoverage: true, toolCalls: 2 });
  const legacy = pricedRequest('gpt-6-sol', 1_000, { legacySnapshot: true });
  const mixed = summarizeRequests([bill, legacy]);
  assert.equal(mixed.coverage, 'billed-with-unknown-coverage');
  assert.equal(mixed.pricedCostUsd, summarizeRequests([bill]).pricedCostUsd);
  assert.equal(mixed.estimatedCostUsd, summarizeRequests([legacy]).estimatedCostUsd);
  assert.equal(mixed.toolCalls, null);
  assert.equal(mixed.requestsWithTwoOrMoreTools, null);
  const evidence = summarizeRequests([snapshot, claude]);
  assert.equal(evidence.coverage, 'billed-with-unknown-coverage');
  assert.equal(evidence.costUsd, null);
  assert.equal(evidence.requestCountExact, false);
  assert.equal(evidence.toolCalls, null);
  assert.equal(evidence.cacheReadShareOfCost, null);
  assert.equal(summarizeRequests([legacy, claude]).coverage, 'legacy-snapshots');
});

test('a growing child request keeps its final usage and unique tools', () => {
  const file = write(path.join(directory(), 'subagents', 'agent-child.jsonl'), [
    claudeRequest('request-1', 4, ['tool-1']),
    claudeRequest('request-1', 40, ['tool-1', 'tool-2']),
  ]);
  const requests = readSessionRequests(file, 'claude-subagent');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].usage.output, 40);
  assert.equal(requests[0].toolCalls, 2);
});

test('synthetic records never become requests', () => {
  const file = write(path.join(directory(), 'parent.jsonl'), [
    claudeRequest('synthetic', 8, [], '<synthetic>'),
    claudeRequest('real', 9),
  ]);
  assert.deepEqual(
    readSessionRequests(file).map((request) => request.requestKey),
    ['claude:real'],
  );
});

test('Codex tool calls belong to the request that records their usage', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const event = (kind: string, second: number, payload: object = {}) => ({
    type: 'event_msg',
    timestamp: at(second),
    payload: { type: kind, ...payload },
  });
  const item = (second: number, call: string) => ({
    type: 'response_item',
    timestamp: at(second),
    payload: { type: 'custom_tool_call', name: 'exec', call_id: call, input: '{}' },
  });
  const usage = (input: number) => ({
    input_tokens: input,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: input + 2,
  });
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    event('task_started', 1, { turn_id: 'turn-1' }),
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'turn-1', model: 'gpt-6-sol', effort: 'low' } },
    item(3, 'call-a'),
    item(4, 'call-b'),
    event('token_count', 5, {
      info: { last_token_usage: usage(10), total_token_usage: usage(10), model_context_window: 258400 },
    }),
    item(6, 'call-c'),
    event('token_count', 7, {
      info: { last_token_usage: usage(20), total_token_usage: usage(30), model_context_window: 258400 },
    }),
  ]);
  assert.deepEqual(
    readSessionRequests(file).map((request) => request.toolCalls),
    [2, 1],
  );
});

test('a delayed Codex context keeps tools with their original turn', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const event = (kind: string, second: number, payload: object = {}) => ({
    type: 'event_msg',
    timestamp: at(second),
    payload: { type: kind, ...payload },
  });
  const usage = (input: number) => ({
    input_tokens: input,
    cached_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: input + 2,
  });
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    event('task_started', 1, { turn_id: 'first' }),
    { type: 'response_item', timestamp: at(2), payload: { type: 'custom_tool_call', call_id: 'first-tool' } },
    event('token_count', 3, { info: { last_token_usage: usage(10), total_token_usage: usage(10) } }),
    event('task_complete', 4),
    event('task_started', 5, { turn_id: 'second' }),
    { type: 'response_item', timestamp: at(6), payload: { type: 'custom_tool_call', call_id: 'second-tool' } },
    { type: 'turn_context', timestamp: at(7), payload: { turn_id: 'first', model: 'gpt-6-sol' } },
    event('token_count', 8, { info: { last_token_usage: usage(20), total_token_usage: usage(30) } }),
    { type: 'turn_context', timestamp: at(9), payload: { turn_id: 'second', model: 'gpt-6-sol' } },
  ]);
  assert.deepEqual(
    readSessionRequests(file).map((request) => request.toolCalls),
    [1, 1],
  );
});

test('a Codex request without final context keeps its usage as unpriced', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: 12,
  };
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'first' } },
    {
      type: 'event_msg',
      timestamp: at(2),
      payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } },
    },
  ]);
  assert.deepEqual(
    readSessionRequests(file).map((request) => [request.model, request.usage.input, request.incomplete]),
    [[null, 10, true]],
  );
});

test('a Codex token count without last usage remains an unpriced incomplete request', () => {
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    {
      type: 'session_meta',
      timestamp: '2026-09-26T00:00:00Z',
      payload: { id: 'parent', source: 'cli', model_provider: 'openai' },
    },
    { type: 'event_msg', timestamp: '2026-09-26T00:00:01Z', payload: { type: 'task_started', turn_id: 'first' } },
    { type: 'turn_context', timestamp: '2026-09-26T00:00:02Z', payload: { turn_id: 'first', model: 'gpt-6-sol' } },
    {
      type: 'event_msg',
      timestamp: '2026-09-26T00:00:03Z',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 2 } } },
    },
  ]);
  const requests = readSessionRequests(file);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].incomplete, true);
  const report = sessionCostReport(file);
  const summary = report.parent;
  assert.equal(summary.requests, 1);
  assert.equal(summary.unpricedRequests, 1);
  assert.equal(summary.costUsd, null);
  assert.equal(summary.requestCountExact, false);
  assert.deepEqual([summary.contextFirst, summary.contextMean, summary.contextMax], [null, null, null]);
  assert.equal(report.combined.requests, 1);
  assert.deepEqual(
    [report.combined.contextFirst, report.combined.contextMean, report.combined.contextMax],
    [null, null, null],
  );
});

test('unresolved Codex requests retain source order and count each tool once', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = (input: number) => ({
    input_tokens: input,
    cached_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: input + 2,
  });
  const event = (kind: string, second: number, payload: object = {}) => ({
    type: 'event_msg',
    timestamp: at(second),
    payload: { type: kind, ...payload },
  });
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    event('task_started', 1, { turn_id: 'first' }),
    { type: 'response_item', timestamp: at(2), payload: { type: 'custom_tool_call', call_id: 'first-tool' } },
    event('token_count', 3, { info: { last_token_usage: usage(10), total_token_usage: usage(10) } }),
    event('task_complete', 4),
    event('task_started', 5, { turn_id: 'second' }),
    { type: 'response_item', timestamp: at(6), payload: { type: 'custom_tool_call', call_id: 'second-tool' } },
    event('token_count', 7, { info: { last_token_usage: usage(20), total_token_usage: usage(30) } }),
    { type: 'turn_context', timestamp: at(8), payload: { turn_id: 'second', model: 'gpt-6-sol' } },
    event('task_started', 9, { turn_id: 'third' }),
    { type: 'response_item', timestamp: at(10), payload: { type: 'custom_tool_call', call_id: 'third-a' } },
    event('token_count', 11, { info: { last_token_usage: usage(30), total_token_usage: usage(60) } }),
    { type: 'response_item', timestamp: at(12), payload: { type: 'custom_tool_call', call_id: 'third-b' } },
    event('token_count', 13, { info: { last_token_usage: usage(40), total_token_usage: usage(100) } }),
  ]);
  assert.deepEqual(
    readSessionRequests(file).map((request) => [request.requestKey.split(':')[1], request.toolCalls]),
    [
      ['first', 1],
      ['second', 1],
      ['third', 1],
      ['third', 1],
    ],
  );
});

test('replayed Codex tools do not join later request counts', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const event = (kind: string, second: number, payload: object = {}) => ({
    type: 'event_msg',
    timestamp: at(second),
    payload: { type: kind, ...payload },
  });
  const usage = (input: number) => ({
    input_tokens: input,
    cached_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: input + 2,
  });
  const tool = (second: number, id: string) => ({
    type: 'response_item',
    timestamp: at(second),
    payload: { type: 'custom_tool_call', call_id: id },
  });
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    event('task_started', 1, { turn_id: 'first' }),
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'first', model: 'gpt-6-sol' } },
    tool(3, 'owned'),
    event('token_count', 4, { info: { last_token_usage: usage(10), total_token_usage: usage(10) } }),
    event('task_complete', 5),
    event('task_started', 6, { turn_id: 'first' }),
    tool(7, 'replayed'),
    event('task_complete', 8),
    event('task_started', 9, { turn_id: 'second' }),
    { type: 'turn_context', timestamp: at(10), payload: { turn_id: 'second', model: 'gpt-6-sol' } },
    tool(11, 'later'),
    event('token_count', 12, { info: { last_token_usage: usage(20), total_token_usage: usage(30) } }),
  ]);
  assert.deepEqual(
    readSessionRequests(file).map((request) => request.toolCalls),
    [1, 1],
  );
});

test('a Codex child two levels below its parent is discovered', () => {
  const root = directory();
  const sessions = path.join(root, 'sessions');
  const rollout = (id: string, parent?: string, agent?: string) =>
    write(path.join(sessions, '2026', '09', '26', `rollout-2026-09-26T00-00-00-${id}.jsonl`), [
      {
        type: 'session_meta',
        timestamp: '2026-09-26T00:00:00Z',
        payload: {
          id,
          cwd: root,
          model_provider: 'openai',
          ...(parent
            ? { parent_thread_id: parent, source: { subagent: { thread_spawn: { agent_path: agent } } } }
            : { source: 'cli' }),
        },
      },
    ]);
  const parent = rollout('parent');
  rollout('child', 'parent', '/root/child');
  rollout('grandchild', 'child', '/root/child/grandchild');
  const sources = sessionSources(parent, { codexSessions: sessions });
  assert.deepEqual(
    sources.map((source) => source.sessionId),
    ['parent', 'child', 'grandchild'],
  );
  assert.deepEqual(
    sources.map((source) => source.kind),
    ['codex', 'codex-thread', 'codex-thread'],
  );
  assert.equal(sources[2].agent, '/root/child/grandchild');
});

test('the public Codex cost sources include one Claude session launched by a shell receipt', () => {
  const root = directory();
  const sessions = path.join(root, 'sessions');
  const projects = path.join(root, 'projects');
  const childId = '5a7b07c1-bfcf-4d96-9eb2-8ef1fb609881';
  const parent = write(path.join(sessions, 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: '2026-09-26T00:00:00Z', payload: { id: 'parent', source: 'cli', cwd: root } },
    { type: 'event_msg', timestamp: '2026-09-26T00:00:01Z', payload: { type: 'task_started', turn_id: 'launch' } },
    { type: 'turn_context', timestamp: '2026-09-26T00:00:02Z', payload: { turn_id: 'launch', model: 'gpt-6-sol' } },
    {
      type: 'event_msg',
      timestamp: '2026-09-26T00:00:03Z',
      payload: {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          id: 'exec-launch',
          status: 'completed',
          exit_code: 0,
          parsed_cmd: [{ type: 'unknown', cmd: 'python dispatch.py --runner claude --arc-dispatch' }],
          stdout: `ARC_DISPATCH_SESSION={"agent":"claude","session_id":"${childId}"}`,
        },
      },
    },
  ]);
  write(path.join(projects, 'project', `${childId}.jsonl`), [claudeRequest('child-usage', 7)]);
  write(path.join(projects, 'project', childId, 'subagents', 'agent-nested.jsonl'), [claudeRequest('nested-usage', 3)]);
  const roots = { codexSessions: sessions, projects };
  assert.deepEqual(
    sessionSources(parent, roots).map(({ kind, sessionId }) => [kind, sessionId]),
    [
      ['codex', 'parent'],
      ['claude-session', childId],
      ['claude-subagent', 'nested'],
    ],
  );
  const report = sessionCostReport(parent, { roots });
  assert.equal(report.children.length, 2);
  assert.deepEqual(report.children.map((child) => child.outputTokens).sort(), [3, 7]);
});

test('a Codex session reports a linked multi-request Claude print result without per-request context', () => {
  const root = directory();
  const sessions = path.join(root, 'sessions');
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const file = write(path.join(sessions, '2026', '09', '26', 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    {
      type: 'session_meta',
      timestamp: at(0),
      payload: { id: 'parent', source: 'cli', cwd: root, model_provider: 'openai' },
    },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'turn-1' } },
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'turn-1', model: 'gpt-6-sol' } },
    {
      type: 'token_usage_record',
      timestamp: at(2),
      payload: {
        response_id: 'outside-window',
        turn_id: 'turn-1',
        usage: {
          input_tokens: 100_000,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 2,
          reasoning_output_tokens: 0,
        },
      },
    },
    {
      type: 'event_msg',
      timestamp: at(3),
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 100_000, cached_input_tokens: 0, output_tokens: 2, total_tokens: 100_002 },
          total_token_usage: { input_tokens: 100_000, cached_input_tokens: 0, output_tokens: 2, total_tokens: 100_002 },
        },
      },
    },
    {
      type: 'event_msg',
      timestamp: at(4),
      payload: {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          id: 'exec-1',
          command: ['claude', '-p', 'review', '--output-format', 'json'],
          parsed_cmd: [{ type: 'unknown', cmd: 'claude -p review --output-format json' }],
          status: 'completed',
          exit_code: 0,
          stdout: JSON.stringify({
            type: 'result',
            session_id: 'printed',
            num_turns: 2,
            total_cost_usd: 0.01,
            duration_ms: 100,
            is_error: false,
            usage: {
              input_tokens: 199_950,
              output_tokens: 2,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 50,
            },
            modelUsage: {
              'claude-haiku-4-5': {
                inputTokens: 199_950,
                outputTokens: 2,
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 50,
                thinkingTokens: 0,
                costUSD: 0.01,
                contextWindow: 200_000,
                canonicalModel: 'claude-haiku-4-5',
                costBasis: 'list',
              },
            },
          }),
        },
      },
    },
  ]);
  const sources = sessionSources(file, { codexSessions: sessions });
  assert.deepEqual(
    sources.map((source) => source.kind),
    ['codex', 'claude-print'],
  );
  assert.equal(sources[1].sessionId, 'printed');
  assert.equal(sources[0].requests?.filter((request) => !request.coverageDefect).length, 2);
  const windowed = sessionCostReport(file, { since: at(3), until: at(5), roots: { codexSessions: sessions } });
  assert.equal(windowed.parent.coverage, 'billed-with-unknown-coverage');
  assert.equal(windowed.children[0].pricedRequests, 1);
  assert.equal(windowed.combined.coverage, 'billed-with-unknown-coverage');
  assert.equal(windowed.combined.costUsd, null);
  assert.equal(windowed.combined.pricedCostUsd, windowed.children[0].pricedCostUsd);
  assert.equal(windowed.combined.requestCountExact, false);
  assert.equal(sources[1].requests?.length, 1);
  const report = sessionCostReport(file, { roots: { codexSessions: sessions } });
  for (const window of [{}, { since: at(3), until: at(5) }]) {
    const ordinary = sessionCostReport(file, { ...window, roots: { codexSessions: sessions }, byModel: true });
    const direct = sessionCostReport(file, {
      ...window,
      roots: { codexSessions: sessions },
      sourceOnly: true,
      byModel: true,
    });
    assert.deepEqual(direct.parent, ordinary.parent);
    assert.deepEqual(direct.children, []);
    const { modelCosts, ...parent } = direct.parent;
    assert.deepEqual(direct.combined, parent);
    assert.equal(modelCosts!.length, direct.parent.requests ? 1 : 0);
    assert.equal('modelCosts' in direct.combined, false);
  }
  assert.equal(report.parent.contextFirst, null);
  assert.equal(report.parent.requestCountExact, false);
  assert.deepEqual(
    [report.children[0].contextFirst, report.children[0].contextMean, report.children[0].contextMax],
    [null, null, null],
  );
  assert.equal(report.children[0].uncachedInputTokens, 199_950);
  assert.equal(report.children[0].cacheWriteInputTokens, 50);
  assert.equal(report.children[0].requestCountExact, false);
  assert.equal(report.children[0].costUsd, 0.01);
  assert.equal(report.children[0].costPerRequest, null);
  assert.deepEqual(report.children[0].costPerRequestByFifth, [null]);
  assert.equal(report.combined.requestCountExact, false);
  assert.equal(report.combined.requests, 2);
  assert.equal(report.combined.uncachedInputTokens, 299_950);
  assert.equal(report.combined.costUsd, null);
  assert.deepEqual(
    [report.combined.contextFirst, report.combined.contextMean, report.combined.contextMax],
    [null, null, null],
  );
});

test('a completed Claude print result replaces its incomplete request', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const completed = (second: number, stdout: string) => ({
    type: 'event_msg',
    timestamp: at(second),
    payload: {
      type: 'item_completed',
      item: {
        type: 'CommandExecution',
        id: 'exec-1',
        command: ['claude', '-p', 'review', '--output-format', 'json'],
        parsed_cmd: [{ type: 'unknown', cmd: 'claude -p review --output-format json' }],
        status: 'completed',
        exit_code: 0,
        stdout,
      },
    },
  });
  const result = JSON.stringify({
    type: 'result',
    session_id: 'printed',
    total_cost_usd: 0.01,
    duration_ms: 100,
    is_error: false,
    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: {
      'claude-haiku-4-5': {
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
    },
  });
  const file = write(path.join(directory(), 'rollout-2026-09-26T00-00-00-parent.jsonl'), [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'turn-1' } },
    completed(2, '{"type":"result","session_id":'),
    completed(3, result),
  ]);
  const requests = readSessionRequests(file);
  assert.deepEqual(requests, []);
  assert.deepEqual(
    readSessionRequests(file, 'claude-print', 'exec-1:printed').map((request) => [
      request.incomplete ?? false,
      request.linkedSessionId,
    ]),
    [[false, 'printed']],
  );
});

test('a direct Claude child path keeps its child identity and role', () => {
  const file = write(path.join(directory(), 'subagents', 'agent-child.jsonl'), [claudeRequest('one', 2)]);
  assert.deepEqual(
    sessionSources(file).map(({ kind, sessionId }) => [kind, sessionId]),
    [['claude-subagent', 'child']],
  );
});

test('source-only parent and child reads retain source model costs without discovering descendants', () => {
  const root = directory();
  const parent = write(path.join(root, 'parent.jsonl'), [
    { ...claudeRequest('later', 40_000), timestamp: '2026-09-26T00:00:02Z' },
    claudeRequest('parent', 2),
  ]);
  const child = write(path.join(root, 'parent', 'subagents', 'agent-child.jsonl'), [claudeRequest('child', 4)]);
  write(path.join(path.dirname(child), 'agent-grandchild.jsonl'), [claudeRequest('grandchild', 8)]);
  const ordinary = sessionCostReport(parent, { byModel: true });
  assert.equal(ordinary.children.length, 2);
  assert.equal(ordinary.parent.modelCosts![0].outputTokens, 40_002);
  assert.equal(ordinary.children.find((source) => source.sessionId === 'child')!.modelCosts![0].outputTokens, 4);
  assert.equal('modelCosts' in ordinary.combined, false);
  for (const file of [parent, child]) {
    const plain = sessionCostReport(file);
    const direct = sessionCostReport(file, { sourceOnly: true });
    assert.deepEqual(direct.parent, plain.parent);
    assert.deepEqual(direct.children, []);
    assert.deepEqual(direct.combined, direct.parent);
  }
});

test('repeated source-only calls read only the selected source and bypass catalogs and discovery', () => {
  const root = directory();
  const projects = path.join(root, 'projects');
  const sessions = path.join(root, 'sessions');
  const claude = write(path.join(projects, 'sample', 'parent.jsonl'), [claudeRequest('parent', 2)]);
  const codex = write(path.join(sessions, 'rollout-parent.jsonl'), [
    { type: 'session_meta', timestamp: '2026-09-26T00:00:00Z', payload: { id: 'parent', source: 'cli' } },
  ]);
  for (let index = 0; index < 100; index++) {
    write(path.join(projects, 'other', `unused-${index}.jsonl`), [claudeRequest('unused', 100)]);
    write(path.join(sessions, `rollout-unused-${index}.jsonl`), [
      { type: 'session_meta', payload: { id: `unused-${index}`, source: 'cli' } },
    ]);
  }
  const nativeFs = createRequire(__filename)('node:fs') as typeof fs;
  const enumerate = vi.spyOn(nativeFs, 'readdirSync').mockImplementation(() => {
    throw new Error('Unexpected directory enumeration');
  });
  const open = vi.spyOn(nativeFs, 'openSync');
  const claudeDiscovery = vi.spyOn(projectSpend, 'discoverClaudeSessionSpendSources').mockImplementation(() => {
    throw new Error('Unexpected Claude discovery');
  });
  const codexDiscovery = vi.spyOn(codexReader, 'scanCodexDispatchReferences').mockImplementation(() => {
    throw new Error('Unexpected Codex discovery');
  });
  syncBuiltinESMExports();
  try {
    const reads: number[] = [];
    for (let repeat = 0; repeat < 3; repeat++) {
      const start = open.mock.calls.length;
      for (const file of [claude, codex]) {
        assert.equal(findSessionTranscript(file, { projects, codexSessions: sessions }, true), file);
        assert.deepEqual(
          sessionCostReport(file, { roots: { projects, codexSessions: sessions }, sourceOnly: true }).children,
          [],
        );
      }
      reads.push(open.mock.calls.length - start);
    }
    assert.equal(enumerate.mock.calls.length, 0);
    assert.equal(claudeDiscovery.mock.calls.length, 0);
    assert.equal(codexDiscovery.mock.calls.length, 0);
    assert.ok(open.mock.calls.every(([file]) => [claude, codex].includes(String(file))));
    assert.ok(reads[0] > 0 && reads.every((count) => count === reads[0]), JSON.stringify(reads));
    console.log(`Source-only repeated reads: ${JSON.stringify(reads)}, unrelated transcripts: 200, enumerations: 0.`);
    assert.throws(
      () => findSessionTranscript('parent', { projects, codexSessions: sessions }, true),
      /requires an existing transcript file path/,
    );
    assert.throws(
      () => findSessionTranscript(path.join(root, 'missing.jsonl'), {}, true),
      /requires an existing transcript file path/,
    );
    assert.throws(() => findSessionTranscript(root, {}, true), /not a file/);
  } finally {
    enumerate.mockRestore();
    open.mockRestore();
    claudeDiscovery.mockRestore();
    codexDiscovery.mockRestore();
    syncBuiltinESMExports();
  }
});

test('an explicitly supplied Claude child role works for a copied file', () => {
  const file = write(path.join(directory(), 'copy.jsonl'), [
    { ...claudeRequest('one', 2), isSidechain: true },
    { ...claudeRequest('one', 9), isSidechain: true },
  ]);
  assert.equal(readSessionRequests(file, 'claude-subagent')[0].usage.output, 9);
});

test('an opening Codex record identifies a copied rollout', () => {
  const file = write(path.join(directory(), 'copy.jsonl'), [
    { type: 'session_meta', timestamp: '2026-09-26T00:00:00Z', payload: { id: 'copied', source: 'cli' } },
  ]);
  assert.deepEqual(
    sessionSources(file).map(({ kind, sessionId }) => [kind, sessionId]),
    [['codex', 'copied']],
  );
});

test('a dispatched Claude session and its child join the source tree', () => {
  const root = directory();
  const parent = write(path.join(root, 'parent.jsonl'), [
    {
      type: 'assistant',
      timestamp: '2026-09-26T00:00:01Z',
      message: {
        id: 'launch',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'tool_use', id: 'tool-launch', name: 'Bash', input: { command: 'claude --bg -p task' } }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    {
      type: 'user',
      timestamp: '2026-09-26T00:00:02Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-launch', content: 'Session started: child' }],
      },
      toolUseResult: { stdout: '{"type":"result","session_id":"abcdef12"}' },
    },
  ]);
  write(path.join(root, 'abcdef12.jsonl'), [
    claudeRequest('child-request', 2, ['nested-launch']),
    {
      type: 'assistant',
      timestamp: '2026-09-26T00:00:03Z',
      message: {
        id: 'nested-launch',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'tool_use', id: 'nested-launch', name: 'Bash', input: { command: 'claude --bg -p nested' } }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    {
      type: 'user',
      timestamp: '2026-09-26T00:00:04Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'nested-launch', content: 'nested' }] },
      toolUseResult: { stdout: '{"type":"result","session_id":"abcdef34"}' },
    },
  ]);
  write(path.join(root, 'abcdef12', 'subagents', 'agent-nested.jsonl'), [claudeRequest('subagent', 3)]);
  write(path.join(root, 'abcdef34.jsonl'), [claudeRequest('grandchild', 4)]);
  const sources = sessionSources(parent);
  assert.deepEqual(
    sources.map(({ kind, sessionId }) => [kind, sessionId]),
    [
      ['claude', 'parent'],
      ['claude-session', 'abcdef12'],
      ['claude-subagent', 'nested'],
      ['claude-session', 'abcdef34'],
    ],
  );
});

test('a dispatched Claude session in another project includes its descendants', () => {
  const root = directory();
  const projects = path.join(root, 'projects');
  const parent = write(path.join(projects, 'project-a', 'parent.jsonl'), [
    {
      type: 'assistant',
      timestamp: '2026-09-26T00:00:01Z',
      message: {
        id: 'launch',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'tool_use', id: 'launch-tool', name: 'Bash', input: { command: 'claude --bg -p task' } }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    {
      type: 'user',
      timestamp: '2026-09-26T00:00:02Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'launch-tool', content: 'child' }] },
      toolUseResult: { stdout: '{"type":"result","session_id":"abcdef12"}' },
    },
  ]);
  write(path.join(projects, 'project-b', 'abcdef12.jsonl'), [claudeRequest('child', 2)]);
  write(path.join(projects, 'project-b', 'abcdef12', 'subagents', 'agent-grandchild.jsonl'), [
    claudeRequest('grandchild', 3),
  ]);
  const codexSessions = path.join(root, 'unused-codex');
  write(path.join(codexSessions, 'rollout-unused.jsonl'), [
    { type: 'session_meta', payload: { id: 'unused', source: 'exec' } },
  ]);
  const nativeFs = createRequire(__filename)('node:fs') as typeof fs;
  const reads = vi.spyOn(nativeFs, 'readdirSync');
  syncBuiltinESMExports();
  try {
    assert.deepEqual(
      sessionSources(parent, { projects, codexSessions }).map(({ kind, sessionId }) => [kind, sessionId]),
      [
        ['claude', 'parent'],
        ['claude-session', 'abcdef12'],
        ['claude-subagent', 'grandchild'],
      ],
    );
    assert.equal(reads.mock.calls.filter(([file]) => String(file) === codexSessions).length, 0);
  } finally {
    reads.mockRestore();
    syncBuiltinESMExports();
  }
});

test('a Codex-only dispatch includes overlapping native children without reading Claude projects', () => {
  const root = directory();
  const projects = path.join(root, 'unused-claude');
  const codexSessions = path.join(root, 'sessions');
  const ids = ['aaaaaaaa', 'bbbbbbbb', 'cccccccc'].map((prefix) => `${prefix}-1111-1111-1111-111111111111`);
  const files = ids.map((id, index) =>
    write(path.join(codexSessions, `rollout-2026-09-26T00-00-00-${id}.jsonl`), [
      {
        type: 'session_meta',
        timestamp: '2026-09-26T00:00:00Z',
        payload: { id, cwd: root, source: 'exec', ...(index === 2 ? { parent_thread_id: ids[1] } : {}) },
      },
      { type: 'event_msg', timestamp: '2026-09-26T00:00:01Z', payload: { type: 'task_started', turn_id: id } },
      { type: 'turn_context', timestamp: '2026-09-26T00:00:02Z', payload: { turn_id: id, model: 'gpt-6-sol' } },
      ...(index < 2
        ? [
            {
              type: 'event_msg',
              timestamp: '2026-09-26T00:00:03Z',
              payload: {
                type: 'item_completed',
                item: {
                  type: 'CommandExecution',
                  id: 'launch',
                  parsed_cmd: [{ cmd: 'python launch.py --arc-dispatch' }],
                  stdout: `ARC_DISPATCH_SESSION=${JSON.stringify({ agent: 'codex', session_id: ids[index + 1] })}`,
                },
              },
            },
          ]
        : []),
    ]),
  );
  write(path.join(projects, 'project', 'unused.jsonl'), [claudeRequest('unused', 1)]);
  const nativeFs = createRequire(__filename)('node:fs') as typeof fs;
  const reads = vi.spyOn(nativeFs, 'readdirSync');
  syncBuiltinESMExports();
  try {
    assert.deepEqual(
      sessionSources(files[0], { projects, codexSessions }).map((source) => source.sessionId),
      ids,
    );
    assert.equal(reads.mock.calls.filter(([file]) => String(file) === projects).length, 0);
  } finally {
    reads.mockRestore();
    syncBuiltinESMExports();
  }
});

test('a same-project dispatch resolves with relative and differently cased project roots', () => {
  const projects = path.join(directory(), 'projects');
  const project = path.join(projects, 'project-a');
  const parent = write(path.join(project, 'parent.jsonl'), [
    {
      type: 'assistant',
      timestamp: '2026-09-26T00:00:01Z',
      message: {
        id: 'launch',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'tool_use', id: 'launch-tool', name: 'Bash', input: { command: 'claude --bg -p task' } }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    {
      type: 'user',
      timestamp: '2026-09-26T00:00:02Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'launch-tool', content: 'child' }] },
      toolUseResult: { stdout: '{"type":"result","session_id":"abcdef12"}' },
    },
  ]);
  write(path.join(project, 'abcdef12.jsonl'), [claudeRequest('child', 2)]);
  write(path.join(project, 'abcdef12', 'subagents', 'agent-grandchild.jsonl'), [claudeRequest('grandchild', 3)]);
  const ids = (root: string) => sessionSources(parent, { projects: root }).map((source) => source.sessionId);
  const expected = ['parent', 'abcdef12', 'grandchild'];
  assert.deepEqual(ids(projects), expected);
  assert.deepEqual(ids(path.relative(process.cwd(), projects)), expected);
  if (process.platform === 'win32') assert.deepEqual(ids(projects.toUpperCase()), expected);
});

test('an unknown id reports no transcript', () => {
  const root = directory();
  assert.throws(
    () =>
      findSessionTranscript('absent', {
        projects: path.join(root, 'projects'),
        codexSessions: path.join(root, 'sessions'),
      }),
    /No transcript found for absent/,
  );
});

test('an id matching two stores reports both paths', () => {
  const root = directory();
  const projects = path.join(root, 'projects');
  const sessions = path.join(root, 'sessions');
  const claude = write(path.join(projects, 'project-a', 'same.jsonl'), [{}]);
  const codex = write(path.join(sessions, '2026', '09', '26', 'rollout-2026-09-26T00-00-00-same.jsonl'), [{}]);
  assert.throws(
    () => findSessionTranscript('same', { projects, codexSessions: sessions }),
    (error: Error) => error.message.includes(claude) && error.message.includes(codex),
  );
});

test('mixed dispatched source chains include Codex native descendants once from either parent agent', () => {
  for (const parentAgent of ['claude', 'codex']) {
    const root = directory();
    const projects = path.join(root, 'projects');
    const sessions = path.join(root, 'sessions');
    const parentId = 'bbbbbbbb-1111-1111-1111-111111111111';
    const childId = 'aaaaaaaa-1111-1111-1111-111111111111';
    const claudeId = 'cccccccc-1111-1111-1111-111111111111';
    const receipt = (agent: string, sessionId: string) =>
      `ARC_DISPATCH_SESSION=${JSON.stringify({ agent, session_id: sessionId })}`;
    const command = (stdout: string) => ({
      type: 'event_msg',
      timestamp: '2026-09-26T00:00:03Z',
      payload: {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          id: 'launch',
          parsed_cmd: [{ cmd: 'python launch.py --arc-dispatch' }],
          stdout,
        },
      },
    });
    const rollout = (id: string, parent: string | null, output: number, stdout?: string) =>
      write(path.join(sessions, `rollout-2026-09-26T00-00-00-${id}.jsonl`), [
        {
          type: 'session_meta',
          timestamp: '2026-09-26T00:00:00Z',
          payload: {
            id,
            cwd: root,
            source: 'exec',
            model_provider: 'openai',
            ...(parent ? { parent_thread_id: parent } : {}),
          },
        },
        { type: 'event_msg', timestamp: '2026-09-26T00:00:01Z', payload: { type: 'task_started', turn_id: id } },
        { type: 'turn_context', timestamp: '2026-09-26T00:00:02Z', payload: { turn_id: id, model: 'gpt-6-sol' } },
        ...(stdout ? [command(stdout)] : []),
        {
          type: 'event_msg',
          timestamp: '2026-09-26T00:00:04Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: { input_tokens: 10, output_tokens: output, total_tokens: 10 + output },
              total_token_usage: { input_tokens: 10, output_tokens: output, total_tokens: 10 + output },
              model_context_window: 258400,
            },
          },
        },
        { type: 'event_msg', timestamp: '2026-09-26T00:00:05Z', payload: { type: 'task_complete', turn_id: id } },
      ]);
    const claude = (id: string, targetAgent: string, targetId: string) =>
      write(path.join(projects, 'project', `${id}.jsonl`), [
        { type: 'user', cwd: root, message: { role: 'user', content: 'work' } },
        claudeRequest(id, 7),
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 'launch', name: 'Bash', input: { command: 'python launch.py --arc-dispatch' } },
            ],
          },
        },
        {
          type: 'user',
          toolUseResult: { stdout: receipt(targetAgent, targetId) },
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'launch', content: receipt(targetAgent, targetId) }],
          },
        },
      ]);
    const parent =
      parentAgent === 'codex'
        ? rollout(parentId, null, 2, receipt('codex', childId))
        : claude(parentId, 'codex', childId);
    rollout(childId, null, 3, receipt('claude', claudeId));
    rollout('native', childId, 5);
    claude(claudeId, parentAgent, parentId);
    const roots = { projects, codexSessions: sessions };
    const sources = sessionSources(parent, roots);
    assert.deepEqual(
      new Set(sources.map((source) => source.sessionId)),
      new Set([parentId, childId, 'native', claudeId]),
    );
    assert.equal(sources.length, 4);
    assert.equal(sources.find((source) => source.sessionId === childId)?.kind, 'codex-thread');
    assert.equal(sessionCostReport(parent, { roots }).combined.outputTokens, parentAgent === 'codex' ? 17 : 22);
  }
});

test('native CLI source collection visits each source once across a chain and siblings', () => {
  const root = directory();
  const sessions = path.join(root, 'sessions');
  const files = Array.from({ length: 16 }, (_, index) =>
    write(path.join(sessions, `rollout-2026-09-26T00-00-00-${index}.jsonl`), [
      {
        type: 'session_meta',
        timestamp: '2026-09-26T00:00:00Z',
        payload: {
          id: String(index),
          cwd: root,
          source: 'exec',
          ...(index ? { parent_thread_id: String(index < 8 ? index - 1 : 3) } : {}),
        },
      },
    ]),
  );
  const realpath = fs.realpathSync;
  let calls = 0;
  fs.realpathSync = Object.assign(
    ((...args: Parameters<typeof realpath>) => {
      calls++;
      return (realpath as any)(...args);
    }) as typeof realpath,
    { native: realpath.native },
  );
  try {
    const sources = sessionSources(files[0], { codexSessions: sessions });
    assert.equal(sources.length, files.length);
    assert.ok(calls <= files.length * 2, `${calls} canonical lookups for ${files.length} sources`);
  } finally {
    fs.realpathSync = realpath;
  }
});

test('Bedrock cache expiry uses documented duration for write-only, read-only and mixed usage without inventing request coverage', () => {
  for (const first of [
    { input_tokens: 1000, cache_write_input_tokens: 1000, output_tokens: 10 },
    { input_tokens: 1000, cached_input_tokens: 1000, output_tokens: 10 },
    { input_tokens: 1000, cached_input_tokens: 500, cache_write_input_tokens: 500, output_tokens: 10 },
  ]) {
    for (const model of [
      'openai.gpt-6.1-sol',
      'us.openai.gpt-6.1-sol',
      'global.openai.gpt-6.1-sol',
      'openai.gpt-6-luna',
    ]) {
      const f = cumulativeCostFixture('bedrock-expiry', model);
      const file = f.save([
        { ...f.start[0], payload: { id: 'bedrock-expiry', cwd: directory(), model_provider: 'amazon-bedrock' } },
        ...f.start.slice(1),
        { type: 'event_msg', timestamp: f.at(3), payload: { type: 'user_message', message: 'first prompt' } },
        { type: 'event_msg', timestamp: f.at(3), payload: { type: 'token_count', info: { last_token_usage: first } } },
        { type: 'event_msg', timestamp: f.at(4), payload: { type: 'task_complete', turn_id: 'turn-1' } },
        { type: 'event_msg', timestamp: f.at(1863), payload: { type: 'task_started', turn_id: 'turn-2' } },
        { type: 'turn_context', timestamp: f.at(1863), payload: { turn_id: 'turn-2', model } },
        { type: 'event_msg', timestamp: f.at(1863), payload: { type: 'user_message', message: 'second prompt' } },
        {
          type: 'event_msg',
          timestamp: f.at(1863),
          payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1000, output_tokens: 10 } } },
        },
      ]);
      const report = sessionCostReport(file, { sourceOnly: true }).parent;
      assert.equal(report.cacheExpiry?.byLifetime['30m'], 1, model);
      assert.equal(report.cacheExpiry?.byBoundary.afterAUserTurn, 1, model);
      assert.equal(report.cacheExpiry?.unavailableLifetime, 0, model);
      assert.equal(report.cacheExpiry?.coverage, 'unknown-request-coverage');
      assert.equal(report.cacheExpiry?.inputCostAfterExpiryUsd, null);
      assert.equal(report.requests, 2);
    }
  }
});

test('Bedrock Astra parent and native Plato each price their own requests exactly once', () => {
  const root = directory();
  const sessions = path.join(root, 'sessions');
  const parent = write(path.join(sessions, 'rollout-bedrock-astra-parent.jsonl'), bedrockAstraRecords());
  write(path.join(sessions, 'rollout-bedrock-astra-plato.jsonl'), bedrockAstraRecords(true));
  const report = sessionCostReport(parent, {
    roots: { codexSessions: sessions, projects: path.join(root, 'projects') },
    byModel: true,
  });
  assert.equal(report.children.length, 1);
  for (const [row, count, cost, quantities] of [
    [report.parent, 33, 6.5229, [1386, 2_854_856, 195_229, 12_416]],
    [report.children[0], 11, 2.5627, [462, 678_914, 100_169, 7882]],
    [report.combined, 44, 9.0856, [1848, 3_533_770, 295_398, 20_298]],
  ] as const) {
    assert.equal(row.requests, count);
    assert.equal(row.pricedRequests, count);
    assert.equal(row.unpricedRequests, 0);
    assert.ok(row.costUsd !== null && Math.abs(row.costUsd! - cost) < 1e-10);
    assert.deepEqual(
      [row.uncachedInputTokens, row.cachedInputTokens, row.cacheWriteInputTokens, row.outputTokens],
      quantities,
    );
  }
});
