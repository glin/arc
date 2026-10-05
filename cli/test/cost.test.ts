import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { test, vi } from 'vitest';
import { runCost } from '../src/cost.ts';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-cost-cli-'));
  const projects = path.join(root, 'projects');
  const codex = path.join(root, 'sessions');
  const file = path.join(projects, 'sample', 'session-1.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(codex, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-26T00:00:01Z',
      message: {
        id: 'request-1',
        model: 'claude-opus-5',
        role: 'assistant',
        content: [],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }) + '\n',
  );
  return { root, projects, codex, file };
}

function sourceOnlyParity(file: string, flags: string[] = []): void {
  const ordinary = JSON.parse(runCost([file, ...flags]));
  const direct = JSON.parse(runCost([file, ...flags, '--source-only']));
  assert.deepEqual(direct.parent, ordinary.parent);
  assert.deepEqual(direct.children, []);
  assert.deepEqual(direct.combined, direct.parent);
  for (const key of ['source', 'window', 'byToolKind', 'untilText', 'parentWindow'])
    assert.deepEqual(direct[key], ordinary[key]);
  assert.equal('modelCosts' in ordinary.parent, false);
  const detail = JSON.parse(runCost([file, ...flags, '--source-only', '--by-model']));
  const { modelCosts, ...parent } = detail.parent;
  assert.deepEqual(parent, ordinary.parent);
  assert.equal(Array.isArray(modelCosts), true);
  assert.deepEqual(detail.children, []);
  assert.deepEqual(detail.combined, parent);
  for (const key of ['source', 'window', 'byToolKind', 'untilText', 'parentWindow'])
    assert.deepEqual(detail[key], ordinary[key]);
}

test('cost attributes a delayed native child once through colliding parent session ids', () => {
  const { root, projects, codex } = fixture();
  try {
    const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
    const counts = {
      input_tokens: 1000,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 100,
      reasoning_output_tokens: 0,
      total_tokens: 1100,
    };
    const parent = path.join(codex, 'rollout-parent.jsonl');
    const child = path.join(codex, 'rollout-child.jsonl');
    fs.writeFileSync(
      parent,
      JSON.stringify({
        type: 'session_meta',
        timestamp: at(0),
        payload: {
          id: 'native-parent',
          session_id: 'native-parent',
          cwd: root,
          source: 'cli',
          model_provider: 'openai',
        },
      }) + '\n',
    );
    const records = [
      {
        type: 'session_meta',
        timestamp: at(10),
        payload: {
          id: 'native-child',
          session_id: 'native-parent',
          parent_thread_id: 'native-parent',
          timestamp: at(0),
          cwd: root,
          model_provider: 'openai',
          thread_source: 'subagent',
          source: { subagent: { thread_spawn: { parent_thread_id: 'native-parent' } } },
        },
      },
      {
        type: 'event_msg',
        timestamp: at(11),
        payload: { type: 'task_started', turn_id: 'own', started_at: Date.parse(at(1)) / 1000 },
      },
      { type: 'turn_context', timestamp: at(12), payload: { turn_id: 'own', model: 'gpt-6-astra', effort: 'high' } },
      {
        type: 'token_usage_record',
        timestamp: at(13),
        payload: {
          turn_id: 'own',
          thread_id: 'native-child',
          session_id: 'native-parent',
          response_id: 'response',
          usage: counts,
          thread_token_usage: counts,
          turn_token_usage: counts,
        },
      },
      {
        type: 'event_msg',
        timestamp: at(14),
        payload: { type: 'token_count', info: { last_token_usage: counts, total_token_usage: counts } },
      },
    ];
    fs.writeFileSync(child, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    const roots = ['--projects', projects, '--codex-sessions', codex];
    const direct = JSON.parse(runCost([child, '--source-only', '--by-model', ...roots]));
    assert.equal(direct.parent.requests, 1);
    assert.equal(direct.parent.modelCosts[0].model, 'gpt-6-astra');
    assert.equal(direct.parent.costUsd, 0.015);
    assert.deepEqual(direct.children, []);
    const combined = JSON.parse(runCost([parent, '--by-model', ...roots]));
    assert.equal(combined.children.length, 1);
    assert.equal(combined.children[0].sessionId, 'native-child');
    assert.equal(combined.combined.requests, 1);
    assert.equal(combined.combined.costUsd, direct.parent.costUsd);
    const [opening, start, context, bill, snapshot] = records;
    opening.payload.timestamp = new Date(Date.parse(at(0)) + 750).toISOString();
    start.payload.started_at = Date.parse(at(0)) / 1000;
    const original = [
      opening,
      start,
      context,
      snapshot,
      { type: 'event_msg', timestamp: at(18), payload: { type: 'task_complete', turn_id: 'own' } },
    ];
    const scenarios = [
      {
        tail: [
          { ...start, timestamp: at(19) },
          { ...bill, timestamp: at(20) },
        ],
        cost: 0.015,
        coverage: 'recorded-reconciled',
      },
      {
        tail: Array.from({ length: 64 }, (_, index) => ({
          type: 'event_msg',
          timestamp: at(21 + index),
          payload: { type: 'task_started', turn_id: `later-${index}`, started_at: Date.parse(at(21 + index)) / 1000 },
        })),
        cost: null,
        coverage: 'legacy-snapshots',
      },
    ];
    for (const scenario of scenarios) {
      fs.writeFileSync(
        child,
        [...original, ...scenario.tail].map((record) => JSON.stringify(record)).join('\n') + '\n',
      );
      const report = JSON.parse(runCost([child, '--source-only', '--by-model', ...roots])).parent;
      assert.equal(report.requests, 1);
      assert.equal(report.costUsd, scenario.cost);
      assert.equal(report.coverage, scenario.coverage);
      assert.deepEqual(report.models, ['gpt-6-astra']);
    }
    const print = {
      type: 'event_msg',
      timestamp: at(17),
      payload: {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          id: 'print',
          command: ['claude', '-p', 'review', '--output-format', 'json'],
          parsed_cmd: [{ type: 'unknown', cmd: 'claude -p review --output-format json' }],
          status: 'completed',
          exit_code: 0,
          stdout: JSON.stringify({
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
          }),
        },
      },
    };
    for (const beforeBill of [true, false]) {
      const ordered = beforeBill
        ? [...original, print, print, { ...bill, timestamp: at(20) }]
        : [...original, { ...bill, timestamp: at(20) }, print, print];
      fs.writeFileSync(child, ordered.map((record) => JSON.stringify(record)).join('\n') + '\n');
      const report = JSON.parse(runCost([child, '--by-model', ...roots]));
      assert.equal(report.children.length, 1);
      assert.equal(report.children[0].sessionId, 'printed');
      assert.equal(report.children[0].costUsd, 0.01);
      assert.equal(report.combined.requests, 2);
      assert.equal(report.combined.costUsd, 0.025);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cost resolves an id with explicit roots and prints the versioned JSON report by default', () => {
  const { root, projects, codex, file } = fixture();
  try {
    const report = JSON.parse(runCost(['session-1', '--projects', projects, '--codex-sessions', codex]));
    assert.equal(report.schemaVersion, 2);
    assert.equal(typeof report.buildCommit, 'string');
    assert.equal(report.source.file, file);
    assert.equal(report.parent.requests, 1);
    assert.deepEqual(report.parent.models, ['claude-opus-5']);
    assert.equal(report.combined.requests, 1);
    sourceOnlyParity(file, ['--projects', projects, '--codex-sessions', codex]);
    sourceOnlyParity(path.relative(process.cwd(), file), ['--projects', projects, '--codex-sessions', codex]);
    assert.throws(
      () => runCost(['session-1', '--source-only', '--projects', projects, '--codex-sessions', codex]),
      /requires an existing transcript file path/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cost JSON exposes reconciled recorded totals and retains empty windows with missing bills', () => {
  const { root, projects, codex } = fixture();
  const file = path.join(codex, 'rollout-2026-09-26T00-00-00-child.jsonl');
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = (multiple: number) => ({
    input_tokens: 1000 * multiple,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 100 * multiple,
    reasoning_output_tokens: 0,
    total_tokens: 1100 * multiple,
  });
  const records = [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'child', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'turn-1' } },
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'turn-1', model: 'gpt-6-sol' } },
    {
      type: 'token_usage_record',
      timestamp: at(3),
      payload: {
        thread_id: 'child',
        session_id: 'root-parent',
        turn_id: 'turn-1',
        response_id: 'one',
        usage: usage(1),
        thread_token_usage: usage(1),
        turn_token_usage: usage(1),
      },
    },
    {
      type: 'event_msg',
      timestamp: at(4),
      payload: { type: 'token_count', info: { last_token_usage: usage(1), total_token_usage: usage(1) } },
    },
  ];
  const flags = ['--projects', projects, '--codex-sessions', codex, '--by-model', '--source-only'];
  try {
    fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    const report = JSON.parse(runCost([file, ...flags]));
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.parent.coverage, 'recorded-reconciled');
    assert.equal(report.parent.costUsd, 0.003);
    assert.equal(report.parent.pricedCostUsd, 0.003);
    assert.equal('requestCountExact' in report.parent, false);
    assert.equal(report.parent.modelCosts[0].costUsd, 0.003);
    assert.equal(report.combined.costUsd, 0.003);
    assert.equal(report.parent.toolCalls, null);
    fs.appendFileSync(
      file,
      JSON.stringify({
        type: 'event_msg',
        timestamp: at(8),
        payload: {
          type: 'token_count',
          info: { last_token_usage: usage(1), total_token_usage: usage(2) },
        },
      }) + '\n',
    );
    const gap = JSON.parse(runCost([file, ...flags, '--since', at(5), '--until', at(6)]));
    assert.equal(gap.parent.coverage, 'recorded-gaps');
    assert.equal(gap.parent.requests, 0);
    assert.equal(gap.parent.costUsd, null);
    assert.equal(gap.parent.requestCountExact, false);
    assert.equal(gap.combined.costUsd, null);
    assert.equal(gap.combined.coverage, 'recorded-gaps');
    const bill = (response_id: string, second: number, multiple: number) => ({
      type: 'token_usage_record',
      timestamp: at(second),
      payload: {
        thread_id: 'child',
        turn_id: 'turn-1',
        response_id,
        usage: usage(1),
        thread_token_usage: usage(multiple),
        turn_token_usage: usage(multiple),
      },
    });
    const snapshot = (second: number, multiple: number) => ({
      type: 'event_msg',
      timestamp: at(second),
      payload: { type: 'token_count', info: { last_token_usage: usage(1), total_token_usage: usage(multiple) } },
    });
    fs.writeFileSync(
      file,
      [
        ...records.slice(0, 3),
        bill('one', 3, 1),
        snapshot(4, 1),
        bill('two', 5, 2),
        snapshot(7, 1.5),
        bill('three', 8, 3),
        snapshot(9, 3),
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    const unresolved = JSON.parse(runCost([file, ...flags, '--since', at(8), '--until', at(10)]));
    assert.equal(unresolved.parent.coverage, 'billed-with-unknown-coverage');
    assert.equal(unresolved.parent.costUsd, null);
    assert.equal(unresolved.parent.pricedCostUsd, 0.003);
    assert.equal(unresolved.parent.requestCountExact, false);
    assert.equal(unresolved.parent.modelCosts[0].costUsd, null);
    assert.equal(unresolved.combined.costUsd, null);
    fs.writeFileSync(
      file,
      [
        ...records.slice(0, 3),
        bill('one', 3, 1),
        snapshot(4, 1),
        bill('two', 5, 2),
        snapshot(7, 1),
        bill('restart', 8, 1),
        snapshot(9, 1),
        bill('next', 12, 2),
        snapshot(13, 2),
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    const reset = JSON.parse(runCost([file, ...flags, '--since', at(7), '--until', at(8)]));
    assert.equal(reset.parent.requests, 0);
    assert.equal(reset.parent.coverage, 'billed-with-unknown-coverage');
    assert.equal(reset.parent.costUsd, null);
    assert.equal(reset.parent.requestCountExact, false);
    assert.equal(reset.combined.costUsd, null);
    const recovery = JSON.parse(runCost([file, ...flags, '--since', at(12), '--until', at(14)]));
    assert.equal(recovery.parent.coverage, 'recorded-reconciled');
    assert.equal(recovery.parent.costUsd, 0.003);
    assert.equal(recovery.parent.modelCosts[0].costUsd, 0.003);
    assert.equal(recovery.combined.costUsd, 0.003);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cost selects the explicit Codex sessions root over the environment root', () => {
  const { root, projects, codex } = fixture();
  const environmentRoot = path.join(root, 'environment-sessions');
  const relativeFile = path.join('2026', '09', '26', 'rollout-2026-09-26T00-00-00-codex-session.jsonl');
  const explicitFile = path.join(codex, relativeFile);
  const environmentFile = path.join(environmentRoot, relativeFile);
  const previousCodex = process.env.ARC_CODEX_ROOT;
  const records = [
    { type: 'session_meta', timestamp: '2026-09-26T00:00:00Z', payload: { id: 'codex-session', source: 'cli' } },
    { type: 'event_msg', timestamp: '2026-09-26T00:00:01Z', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { type: 'turn_context', timestamp: '2026-09-26T00:00:02Z', payload: { turn_id: 'turn-1', model: 'gpt-6-sol' } },
    {
      type: 'event_msg',
      timestamp: '2026-09-26T00:00:03Z',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2, total_tokens: 12 },
          total_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2, total_tokens: 12 },
        },
      },
    },
  ];
  fs.mkdirSync(path.dirname(explicitFile), { recursive: true });
  fs.mkdirSync(path.dirname(environmentFile), { recursive: true });
  fs.writeFileSync(explicitFile, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  fs.writeFileSync(environmentFile, JSON.stringify(records[0]) + '\n');
  process.env.ARC_CODEX_ROOT = environmentRoot;
  try {
    const report = JSON.parse(runCost(['codex-session', '--projects', projects, '--codex-sessions', codex]));
    assert.equal(report.source.file, explicitFile);
    assert.equal(report.parent.requests, 1);
    assert.deepEqual(report.parent.models, ['gpt-6-sol']);
  } finally {
    if (previousCodex === undefined) delete process.env.ARC_CODEX_ROOT;
    else process.env.ARC_CODEX_ROOT = previousCodex;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cost prices recorded Bedrock GPT-6.1 Sol requests and cache categories', () => {
  for (const [model, expected] of [
    ['openai.gpt-6.1-sol', 1.76],
    ['us.openai.gpt-6.1-sol', 1.76],
    ['global.openai.gpt-6.1-sol', 1.6],
  ] as const) {
    const { root, projects, codex } = fixture();
    try {
      const file = path.join(codex, '2026', '10', '01', 'rollout-2026-10-01T00-00-00-bedrock-sol.jsonl');
      const records = [
        {
          type: 'session_meta',
          timestamp: '2026-10-01T00:00:00Z',
          payload: { id: 'bedrock-sol', source: 'cli', model_provider: 'amazon-bedrock' },
        },
        {
          type: 'event_msg',
          timestamp: '2026-10-01T00:00:01Z',
          payload: { type: 'task_started', turn_id: 'first' },
        },
        {
          type: 'turn_context',
          timestamp: '2026-10-01T00:00:02Z',
          payload: { turn_id: 'first', model },
        },
        ...[220_000, 220_000, 320_000].map((input, index) => ({
          type: 'token_usage_record',
          timestamp: `2026-10-01T00:00:0${index + 3}Z`,
          payload: {
            response_id: `bedrock-${index}`,
            turn_id: 'first',
            usage: {
              input_tokens: input,
              cached_input_tokens: index === 2 ? 150_000 : 100_000,
              cache_write_input_tokens: 20_000,
              output_tokens: 10_000,
              reasoning_output_tokens: 0,
              total_tokens: input + 10_000,
            },
          },
        })),
        {
          type: 'event_msg',
          timestamp: '2026-10-01T00:00:06Z',
          payload: { type: 'task_complete', turn_id: 'first', last_agent_message: 'done' },
        },
      ];
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
      const report = JSON.parse(runCost(['bedrock-sol', '--projects', projects, '--codex-sessions', codex]));
      assert.equal(report.parent.requests, 3);
      assert.deepEqual(report.parent.models, [model]);
      assert.ok(Math.abs(report.parent.pricedCostUsd - expected) < 1e-12);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('cost JSON separates identified Codex bills from anonymous snapshots', () => {
  const { root, projects, codex } = fixture();
  const file = path.join(codex, '2026', '09', '26', 'rollout-2026-09-26T00-00-00-billed.jsonl');
  const usage = {
    input_tokens: 100_000,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: 100_002,
  };
  const records = [
    {
      type: 'session_meta',
      timestamp: '2026-09-26T00:00:00Z',
      payload: { id: 'billed', source: 'cli', model_provider: 'openai' },
    },
    { type: 'event_msg', timestamp: '2026-09-26T00:00:01Z', payload: { type: 'task_started', turn_id: 'first' } },
    { type: 'turn_context', timestamp: '2026-09-26T00:00:02Z', payload: { turn_id: 'first', model: 'gpt-6-sol' } },
    {
      type: 'token_usage_record',
      timestamp: '2026-09-26T00:00:03Z',
      payload: { response_id: 'one', turn_id: 'first', usage },
    },
    {
      type: 'event_msg',
      timestamp: '2026-09-26T00:00:04Z',
      payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } },
    },
  ];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const child = path.join(codex, '2026', '09', '26', 'rollout-2026-09-26T00-00-00-legacy-child.jsonl');
  fs.writeFileSync(
    child,
    [
      {
        type: 'session_meta',
        timestamp: '2026-09-26T00:00:00Z',
        payload: {
          id: 'legacy-child',
          parent_thread_id: 'billed',
          source: { subagent: { thread_spawn: { agent_path: '/root/legacy' } } },
          model_provider: 'openai',
        },
      },
      {
        type: 'event_msg',
        timestamp: '2026-09-26T00:00:01Z',
        payload: { type: 'task_started', turn_id: 'child-turn' },
      },
      {
        type: 'turn_context',
        timestamp: '2026-09-26T00:00:02Z',
        payload: { turn_id: 'child-turn', model: 'gpt-6-sol' },
      },
      {
        type: 'event_msg',
        timestamp: '2026-09-26T00:00:03Z',
        payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  try {
    const report = JSON.parse(runCost(['billed', '--projects', projects, '--codex-sessions', codex]));
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.parent.requests, 1);
    assert.equal(report.parent.snapshotEvidence.count, 1);
    assert.equal(report.parent.coverage, 'billed-with-unknown-coverage');
    assert.equal(report.parent.cacheExpiry.coverage, 'unknown-request-coverage');
    assert.equal(report.parent.cacheExpiry.inputCostAfterExpiryUsd, null);
    assert.equal(report.parent.costUsd, null);
    assert.ok(report.parent.pricedCostUsd > 0);
    sourceOnlyParity(file, ['--projects', projects, '--codex-sessions', codex]);
    const detail = JSON.parse(runCost([file, '--projects', projects, '--codex-sessions', codex, '--by-model']));
    assert.equal(detail.parent.modelCosts[0].coverage, 'billed-with-unknown-coverage');
    assert.equal(detail.children[0].modelCosts[0].coverage, 'legacy-snapshots');
    assert.equal(detail.children[0].modelCosts[0].estimatedCostUsd, detail.children[0].estimatedCostUsd);
    assert.equal('modelCosts' in detail.combined, false);
    assert.equal(report.parent.costPerRequest, null);
    assert.equal(report.children[0].coverage, 'legacy-snapshots');
    assert.equal(report.children[0].pricedCostUsd, 0);
    assert.ok(report.children[0].estimatedCostUsd > 0);
    assert.equal(report.combined.coverage, 'billed-with-unknown-coverage');
    assert.equal(report.combined.pricedCostUsd, report.parent.pricedCostUsd);
    assert.equal(report.combined.estimatedCostUsd, report.children[0].estimatedCostUsd);
    assert.equal(report.combined.costUsd, null);
    assert.equal(report.combined.toolCalls, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cost groups empty compaction and absent model identities in one null row', () => {
  const { root, projects, codex } = fixture();
  const file = path.join(codex, 'rollout-2026-09-26T00-00-00-empty-model.jsonl');
  const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString();
  const usage = (input: number) => ({
    input_tokens: input,
    cached_input_tokens: 2,
    cache_write_input_tokens: 3,
    output_tokens: 4,
    reasoning_output_tokens: 1,
    total_tokens: input + 4,
  });
  const records = [
    { type: 'session_meta', timestamp: at(0), payload: { id: 'empty-model', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'compaction' } },
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'compaction', model: 'gpt-6-sol' } },
    {
      type: 'token_usage_record',
      timestamp: at(3),
      payload: { response_id: 'compact-bill', turn_id: 'compaction', usage: usage(10) },
    },
    { type: 'compacted', timestamp: at(4), payload: { compaction_response_id: 'compact-bill' } },
    {
      type: 'event_msg',
      timestamp: at(5),
      payload: { type: 'thread_settings_applied', thread_settings: { model: '' } },
    },
    { type: 'event_msg', timestamp: at(6), payload: { type: 'task_complete' } },
    { type: 'event_msg', timestamp: at(7), payload: { type: 'task_started', turn_id: 'absent' } },
    {
      type: 'token_usage_record',
      timestamp: at(8),
      payload: { response_id: 'absent-bill', turn_id: 'absent', usage: usage(20) },
    },
    { type: 'event_msg', timestamp: at(9), payload: { type: 'task_complete' } },
    { type: 'event_msg', timestamp: at(10), payload: { type: 'task_started', turn_id: 'unknown' } },
    { type: 'turn_context', timestamp: at(11), payload: { turn_id: 'unknown', model: 'future-model' } },
    {
      type: 'token_usage_record',
      timestamp: at(12),
      payload: { response_id: 'unknown-bill', turn_id: 'unknown', usage: usage(30) },
    },
    { type: 'event_msg', timestamp: at(13), payload: { type: 'task_complete' } },
    { type: 'event_msg', timestamp: at(14), payload: { type: 'task_started', turn_id: 'priced' } },
    { type: 'turn_context', timestamp: at(15), payload: { turn_id: 'priced', model: 'gpt-6-sol' } },
    {
      type: 'token_usage_record',
      timestamp: at(16),
      payload: { response_id: 'priced-bill', turn_id: 'priced', usage: usage(40) },
    },
  ];
  try {
    fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    const flags = [file, '--projects', projects, '--codex-sessions', codex];
    const ordinary = JSON.parse(runCost(flags));
    assert.deepEqual(ordinary.parent.models, ['future-model', 'gpt-6-sol']);
    assert.deepEqual(ordinary.parent.unpricedModels, ['', 'future-model', 'unknown']);
    sourceOnlyParity(file, flags.slice(1));
    const detail = JSON.parse(runCost([...flags, '--source-only', '--by-model']));
    const { modelCosts, ...parent } = detail.parent;
    assert.deepEqual(parent, ordinary.parent);
    assert.deepEqual(
      modelCosts.map((row: { model: string | null }) => row.model),
      [null, 'future-model', 'gpt-6-sol'],
    );
    assert.equal(modelCosts[0].requests, 2);
    assert.equal(modelCosts[0].unpricedRequests, 2);
    assert.equal(modelCosts[0].uncachedInputTokens, 20);
    assert.equal(modelCosts[0].cachedInputTokens, 4);
    assert.equal(modelCosts[0].cacheWriteInputTokens, 6);
    assert.equal(modelCosts[0].outputTokens, 8);
    assert.equal(modelCosts[0].reasoningOutputTokens, 2);
    assert.equal(modelCosts[0].costUsd, null);
    assert.equal(modelCosts[0].pricedCostUsd, 0);
    for (const key of [
      'requests',
      'pricedRequests',
      'unpricedRequests',
      'uncachedInputTokens',
      'cachedInputTokens',
      'cacheWriteInputTokens',
      'outputTokens',
      'reasoningOutputTokens',
      'pricedCostUsd',
    ])
      assert.equal(
        modelCosts.reduce((sum: number, row: Record<string, number>) => sum + row[key], 0),
        parent[key],
      );
    assert.ok(parent.pricedCostUsd > 0);
    assert.ok(
      modelCosts.every(
        (row: { coverage: string; costUsd: null }) => row.coverage === parent.coverage && row.costUsd === null,
      ),
    );
    assert.deepEqual(detail.children, []);
    assert.equal('modelCosts' in detail.combined, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cost reads environment roots and applies an exclusive until time', () => {
  const { root, projects, codex } = fixture();
  const previousProjects = process.env.ARC_PROJECTS_ROOT;
  const previousCodex = process.env.ARC_CODEX_ROOT;
  process.env.ARC_PROJECTS_ROOT = projects;
  process.env.ARC_CODEX_ROOT = codex;
  try {
    const report = JSON.parse(runCost(['session-1', '--until', '2026-09-26T00:00:01Z', '--json']));
    assert.equal(report.parent.requests, 0);
    assert.equal(report.window.until, '2026-09-26T00:00:01.000Z');
  } finally {
    if (previousProjects === undefined) delete process.env.ARC_PROJECTS_ROOT;
    else process.env.ARC_PROJECTS_ROOT = previousProjects;
    if (previousCodex === undefined) delete process.env.ARC_CODEX_ROOT;
    else process.env.ARC_CODEX_ROOT = previousCodex;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cost rejects missing targets, bad times, and ambiguous ids', () => {
  const { root, projects, codex, file } = fixture();
  try {
    const flags = ['--projects', projects, '--codex-sessions', codex];
    assert.throws(() => runCost(['missing', ...flags]), /No transcript found/);
    assert.throws(() => runCost([file, '--since', 'yesterday', ...flags]), /Invalid since time/);
    assert.throws(() => runCost([file, '--unexpected', ...flags]), /Unknown cost option/);
    const second = path.join(projects, 'other', 'session-1.jsonl');
    fs.mkdirSync(path.dirname(second), { recursive: true });
    fs.copyFileSync(file, second);
    assert.throws(() => runCost(['session-1', ...flags]), /More than one transcript matched/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cost attributes failed tools and launch windows to the requests that made them', () => {
  const { root, file } = fixture();
  try {
    const at = (minute: number) => new Date(Date.UTC(2026, 8, 26, 0, minute)).toISOString();
    const usage = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    fs.writeFileSync(
      file,
      [
        { type: 'user', timestamp: at(0), message: { content: 'start' } },
        {
          type: 'assistant',
          timestamp: at(1),
          message: {
            id: 'first',
            model: 'claude-opus-5',
            usage,
            content: [
              { type: 'tool_use', id: 'git-call', name: 'Bash', input: { command: 'cd repo && MSG="a b" git status' } },
              { type: 'tool_use', id: 'agent-call', name: 'Agent', input: { prompt: 'review' } },
            ],
          },
        },
        {
          type: 'user',
          timestamp: at(2),
          toolUseResult: { agentId: 'a1' },
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'git-call', is_error: true, content: 'failed' },
              { type: 'tool_result', tool_use_id: 'agent-call', content: 'agentId: a1' },
            ],
          },
        },
        {
          type: 'assistant',
          timestamp: at(3),
          message: {
            id: 'second',
            model: 'claude-opus-5',
            usage,
            content: [
              { type: 'tool_use', id: 'finding-call', name: 'Agent', input: { message: 'FINDING in handback' } },
            ],
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    const report = JSON.parse(
      runCost([file, '--by-tool-kind', '--until-text', 'FINDING', '--window-agent', 'a1', '--until', at(4)]),
    );
    assert.equal(report.parent.failedToolCalls, 1);
    assert.equal(report.parent.failedToolCallRequests, 1);
    assert.ok(report.parent.failedToolCallCostUsd > 0);
    assert.equal(report.byToolKind.rows.find((row: { kind: string }) => row.kind === 'git').requests, 1);
    assert.equal(report.byToolKind.rows.find((row: { kind: string }) => row.kind === 'subagent launch').requests, 1);
    assert.equal(report.untilText.matched, true);
    assert.equal(report.untilText.byToolKind.rows.length, 1);
    assert.equal(report.parentWindow.requests, 2);
    assert.equal(report.parentWindow.contextAtStart, 100);
    assert.equal(report.parentWindow.contextAtPeak, 100);
    const exclusive = JSON.parse(runCost([file, '--window-agent', 'a1', '--until', at(3)]));
    assert.equal(exclusive.parent.requests, 1);
    assert.equal(exclusive.parentWindow.requests, 2);
    for (let mask = 0; mask < 32; mask++) {
      if (mask & 8 && !(mask & 4)) continue;
      const flags = [
        ...(mask & 1 ? ['--since', at(1)] : []),
        ...(mask & 2 ? ['--until', at(3)] : []),
        ...(mask & 4 ? ['--by-tool-kind'] : []),
        ...(mask & 8 ? ['--until-text', 'FINDING'] : []),
        ...(mask & 16 ? ['--window-agent', 'a1'] : []),
      ];
      sourceOnlyParity(file, flags);
    }
    assert.throws(() => runCost([file, '--source-only', '--until-text', 'finding']), /requires --by-tool-kind/);
    assert.throws(() => runCost([file, '--source-only', '--window-agent', 'missing']), /No Agent launch found/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('until-text accepts Python global case, multiline, and dotall flags', () => {
  const { root, file } = fixture();
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    record.message.content = [{ type: 'text', text: 'noise\nFound\na bug' }];
    fs.writeFileSync(file, JSON.stringify(record) + '\n');
    const report = JSON.parse(runCost([file, '--by-tool-kind', '--until-text', '(?ims)^found.a bug']));
    assert.equal(report.untilText.matched, true);
    assert.throws(() => runCost([file, '--by-tool-kind', '--until-text', '(?x)found']), /Invalid --until-text pattern/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cost JSON uses the Python context mean for an even tie', () => {
  const { root, file } = fixture();
  try {
    const first = JSON.parse(fs.readFileSync(file, 'utf8'));
    first.message.usage.input_tokens = 29_324;
    const second = {
      ...first,
      timestamp: '2026-09-26T00:00:02Z',
      message: { ...first.message, id: 'request-2', usage: { ...first.message.usage, input_tokens: 29_325 } },
    };
    fs.writeFileSync(file, [first, second].map((record) => JSON.stringify(record)).join('\n') + '\n');
    const report = JSON.parse(runCost([file]));
    assert.equal(report.parent.contextMean, 29_324);
    assert.equal(report.combined.contextMean, 29_324);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.each(
  [
    ['openai', 'gpt-6.1-sol', 1],
    ['amazon-bedrock', 'openai.gpt-6.1-sol', 1.1],
    ['amazon-bedrock', 'us.openai.gpt-6.1-sol', 1.1],
    ['amazon-bedrock', 'global.openai.gpt-6.1-sol', 1],
  ].flatMap(([provider, model, multiplier]) =>
    [
      [0, 40_000, 0.16],
      [40_000, 0, 0.064],
      [20_000, 20_000, 0.112],
    ].map(([read, written, cost]) => ({ provider, model, read, written, cost: cost * Number(multiplier) })),
  ),
)(
  'cost reports generic cache lifetime for $model with $read reads and $written writes',
  ({ provider, model, read, written, cost }) => {
    const { root, projects, codex } = fixture();
    const file = path.join(codex, 'rollout-session.jsonl');
    try {
      const records: object[] = [
        {
          type: 'session_meta',
          timestamp: '2026-09-30T10:00:00Z',
          payload: { id: 'session', source: 'cli', model_provider: provider },
        },
      ];
      for (const [index, timestamp, input, cached, write] of [
        [0, '2026-09-30T10:00:00Z', 40_000, read, written],
        [1, '2026-09-30T11:01:00Z', 30_000, 0, 0],
      ]) {
        const turn = `turn-${index}`;
        records.push(
          { type: 'turn_context', timestamp, payload: { turn_id: turn, model } },
          {
            type: 'token_usage_record',
            timestamp,
            payload: {
              turn_id: turn,
              response_id: `response-${index}`,
              usage: {
                input_tokens: input,
                cached_input_tokens: cached,
                cache_write_input_tokens: write,
                output_tokens: 0,
                reasoning_output_tokens: 0,
              },
            },
          },
        );
      }
      fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
      const report = JSON.parse(runCost([file, '--projects', projects, '--codex-sessions', codex]));
      assert.equal(report.parent.pricedRequests, 2);
      assert.equal(report.parent.uncachedInputTokens, 30_000);
      assert.equal(report.parent.cachedInputTokens, read);
      assert.equal(report.parent.cacheWriteInputTokens, written);
      assert.equal(report.parent.pricedCostUsd, Number(cost.toFixed(4)));
      assert.equal(report.parent.costUsd, null);
      assert.equal(report.parent.cacheExpiry.returns, 1);
      assert.equal(report.parent.cacheExpiry.unavailableLifetime, 0);
      assert.equal(report.parent.cacheExpiry.byLifetime['30m'], 1);
      assert.equal(report.parent.cacheExpiry.coverage, 'unknown-request-coverage');
      assert.equal(report.parent.cacheExpiry.inputCostAfterExpiryUsd, null);
      assert.deepEqual(report.combined.cacheExpiry, report.parent.cacheExpiry);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test.each(['5m', '1h'])(
  'cost reports fast-mode gaps and explicit %s cache expiry from adjacent priced requests',
  (lifetime) => {
    const { root, file } = fixture();
    try {
      const usage = (speed: string) => ({
        input_tokens: 100,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation: {
          ephemeral_5m_input_tokens: lifetime === '5m' ? 50 : 0,
          ephemeral_1h_input_tokens: lifetime === '1h' ? 50 : 0,
        },
        speed,
      });
      fs.writeFileSync(
        file,
        [
          { type: 'user', timestamp: '2026-09-26T00:00:00Z', message: { content: 'first' } },
          {
            type: 'assistant',
            timestamp: '2026-09-26T00:00:01Z',
            message: { id: 'one', model: 'claude-opus-5', usage: usage('standard'), content: [] },
          },
          { type: 'user', timestamp: '2026-09-26T01:01:00Z', message: { content: 'second' } },
          {
            type: 'assistant',
            timestamp: '2026-09-26T01:01:01Z',
            message: { id: 'two', model: 'claude-opus-5', usage: usage('standard'), content: [] },
          },
          {
            type: 'assistant',
            timestamp: '2026-09-26T01:01:02Z',
            message: { id: 'three', model: 'claude-opus-5', usage: usage('priority'), content: [] },
          },
        ]
          .map((record) => JSON.stringify(record))
          .join('\n') + '\n',
      );
      const report = JSON.parse(runCost([file]));
      assert.equal(report.parent.fastModeUnpricedRequests, 1);
      assert.equal(report.parent.cacheExpiry.returns, 1);
      assert.equal(report.parent.cacheExpiry.coverage, 'complete');
      assert.ok(report.parent.cacheExpiry.inputCostAfterExpiryUsd > 0);
      assert.equal(report.parent.cacheExpiry.byLifetime[lifetime], 1);
      assert.equal(report.combined.cacheExpiry.returns, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test('cost keeps Codex tool failures without assigning their cost to a request', () => {
  const { root, codex } = fixture();
  const file = path.join(codex, '2026', '09', '26', 'rollout-2026-09-26T00-00-00-failed.jsonl');
  const child = path.join(codex, '2026', '09', '26', 'rollout-2026-09-26T00-00-00-failed-child.jsonl');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        { type: 'session_meta', timestamp: '2026-09-26T00:00:00Z', payload: { id: 'failed', source: 'cli' } },
        {
          type: 'event_msg',
          timestamp: '2026-09-26T00:00:02Z',
          payload: { type: 'item_completed', item: { type: 'CommandExecution', status: 'failed' } },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    fs.writeFileSync(
      child,
      [
        {
          type: 'session_meta',
          timestamp: '2026-09-26T00:00:00Z',
          payload: {
            id: 'failed-child',
            parent_thread_id: 'failed',
            source: { subagent: { thread_spawn: { parent_thread_id: 'failed', agent_path: '/root/failed-child' } } },
          },
        },
        {
          type: 'event_msg',
          timestamp: '2026-09-26T00:00:02Z',
          payload: { type: 'item_completed', item: { type: 'McpToolCall', status: 'failed' } },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    const report = JSON.parse(
      runCost([file, '--codex-sessions', codex, '--since', '2026-09-26T00:00:01Z', '--until', '2026-09-26T00:00:03Z']),
    );
    assert.equal(report.parent.requests, 0);
    assert.equal(report.parent.failedToolCalls, 1);
    assert.equal(report.parent.failedToolCallRequests, 0);
    assert.equal(report.parent.failedToolCallCostUsd, null);
    assert.equal(report.children.length, 1);
    assert.equal(report.children[0].requests, 0);
    assert.equal(report.children[0].failedToolCalls, 1);
    assert.equal(report.combined.failedToolCalls, 2);
    assert.equal(report.combined.failedToolCallCostUsd, null);
    sourceOnlyParity(file, [
      '--codex-sessions',
      codex,
      '--since',
      '2026-09-26T00:00:01Z',
      '--until',
      '2026-09-26T00:00:03Z',
    ]);
    const direct = JSON.parse(
      runCost([
        file,
        '--source-only',
        '--by-model',
        '--codex-sessions',
        codex,
        '--since',
        '2026-09-26T00:00:01Z',
        '--until',
        '2026-09-26T00:00:03Z',
      ]),
    );
    assert.equal(direct.parent.failedToolCalls, 1);
    assert.equal(direct.parent.failedToolCallRequests, 0);
    assert.equal(direct.parent.failedToolCallCostUsd, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cost resolves an Agent launch from subagent metadata when its result has no id', () => {
  const { root, file } = fixture();
  try {
    const meta = path.join(path.dirname(file), 'session-1', 'subagents', 'agent-fallback.meta.json');
    fs.mkdirSync(path.dirname(meta), { recursive: true });
    fs.writeFileSync(meta, JSON.stringify({ toolUseId: 'launch-call' }));
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-09-26T00:00:01Z',
        message: {
          id: 'launch',
          model: 'claude-opus-5',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'launch-call', name: 'Agent', input: { prompt: 'review' } }],
          usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      }) + '\n',
    );
    const report = JSON.parse(runCost([file, '--window-agent', 'fallback']));
    assert.equal(report.parentWindow.agentIdStartRequest, 'launch');
    assert.equal(report.parentWindow.requests, 1);
    sourceOnlyParity(file, [
      '--window-agent',
      'fallback',
      '--by-tool-kind',
      '--until-text',
      'never',
      '--since',
      '2026-09-26T00:00:01Z',
      '--until',
      '2026-09-26T00:00:01Z',
    ]);
    const nativeFs = createRequire(import.meta.url)('node:fs');
    const enumeration = vi.spyOn(nativeFs, 'readdirSync').mockImplementation(() => {
      throw new Error('Unexpected directory enumeration');
    });
    const reads = vi.spyOn(nativeFs, 'readFileSync');
    const opens = vi.spyOn(nativeFs, 'openSync');
    syncBuiltinESMExports();
    try {
      const direct = JSON.parse(runCost([file, '--source-only', '--by-model', '--window-agent', 'fallback']));
      assert.equal(direct.parentWindow.agentIdStartRequest, 'launch');
      assert.equal(enumeration.mock.calls.length, 0);
      assert.deepEqual(
        reads.mock.calls.map(([path]) => String(path)),
        [meta],
      );
      assert.ok(opens.mock.calls.every(([path]) => [file, meta].includes(String(path))));
    } finally {
      enumeration.mockRestore();
      reads.mockRestore();
      opens.mockRestore();
      syncBuiltinESMExports();
    }
    assert.throws(() => runCost([file, '--window-agent', 'missing']), /No Agent launch found/);
    assert.throws(() => runCost([file, '--until-text', 'finding']), /requires --by-tool-kind/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('window-agent uses structured launch identity before metadata and quoted text', () => {
  const { root, file } = fixture();
  try {
    const usage = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const launch = (id: string, call: string, minute: number) => ({
      type: 'assistant',
      timestamp: `2026-09-26T00:0${minute}:00Z`,
      message: {
        id,
        model: 'claude-opus-5',
        usage,
        content: [{ type: 'tool_use', id: call, name: 'Agent', input: { prompt: id } }],
      },
    });
    fs.writeFileSync(
      file,
      [
        launch('quoted', 'quoted-call', 1),
        {
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'quoted-call', content: 'agentId: target\nagentId: fallback' },
            ],
          },
        },
        launch('structured', 'structured-call', 2),
        {
          type: 'user',
          toolUseResult: { agentId: 'target' },
          message: { content: [{ type: 'tool_result', tool_use_id: 'structured-call', content: 'done' }] },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    const meta = path.join(path.dirname(file), 'session-1', 'subagents', 'agent-target.meta.json');
    fs.mkdirSync(path.dirname(meta), { recursive: true });
    fs.writeFileSync(meta, JSON.stringify({ toolUseId: 'quoted-call' }));
    const report = JSON.parse(runCost([file, '--window-agent', 'target']));
    assert.equal(report.parentWindow.agentIdStartRequest, 'structured');
    fs.writeFileSync(
      path.join(path.dirname(meta), 'agent-fallback.meta.json'),
      JSON.stringify({ toolUseId: 'structured-call' }),
    );
    const fallback = JSON.parse(runCost([file, '--window-agent', 'fallback']));
    assert.equal(fallback.parentWindow.agentIdStartRequest, 'structured');
    sourceOnlyParity(file, ['--window-agent', 'target']);
    sourceOnlyParity(file, ['--window-agent', 'fallback']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tool-kind classification keeps redirected cat and its heredoc opening line', () => {
  const { root, file } = fixture();
  try {
    const usage = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    fs.writeFileSync(
      file,
      [
        {
          type: 'assistant',
          timestamp: '2026-09-26T00:00:01Z',
          message: {
            id: 'write',
            model: 'claude-opus-5',
            usage,
            content: [
              {
                type: 'tool_use',
                id: 'write-call',
                name: 'Bash',
                input: { command: "cat <<'EOF' > output.txt\nhello\nEOF" },
              },
            ],
          },
        },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'write-call', content: 'done' }] } },
        {
          type: 'assistant',
          timestamp: '2026-09-26T00:00:02Z',
          message: { id: 'next', model: 'claude-opus-5', usage, content: [] },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    const report = JSON.parse(runCost([file, '--by-tool-kind']));
    assert.equal(report.byToolKind.rows.find((row: { kind: string }) => row.kind === 'other').requests, 1);
    assert.equal(
      report.byToolKind.rows.find((row: { kind: string }) => row.kind === 'file read'),
      undefined,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
