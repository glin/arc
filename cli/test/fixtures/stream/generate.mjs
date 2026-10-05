// Synthetic stream records and independently calculated expected values.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const session = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const id = (prefix, n) => `${prefix}_${String(n).padStart(20, '0')}`;
const at = (seconds) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
const opus = 'claude-opus-5-5';
const sonnet = 'claude-sonnet-5';
const unknown = 'claude-unknown-9';

function request(n, seconds, model, input, write5m, read, output, options = {}) {
  const usage = {
    input_tokens: input,
    cache_creation_input_tokens: write5m + (options.write1h ?? 0),
    cache_read_input_tokens: read,
    cache_creation: {
      ephemeral_5m_input_tokens: write5m,
      ephemeral_1h_input_tokens: options.write1h ?? 0,
    },
    output_tokens: output,
  };
  const content = options.tool ? [{ type: 'tool_use', id: id('toolu', n), name: options.tool }] : [];
  if (options.thinking) content.push({ type: 'thinking', thinking: '', signature: '' });
  return {
    type: 'assistant',
    timestamp: at(seconds),
    parent_tool_use_id: options.parent ?? null,
    message: { id: id('msg', options.message ?? n), model, usage, content },
  };
}

function visibleTurn(n, seconds) {
  return { type: 'user', timestamp: at(seconds), message: { id: id('msg', n), role: 'user', content: [] } };
}

function result(cost, options = {}) {
  return {
    type: 'result',
    subtype: options.error ? 'error_during_execution' : 'success',
    is_error: options.error ?? false,
    num_turns: options.turns ?? 1,
    duration_ms: options.duration ?? 1000,
    duration_api_ms: options.apiDuration ?? 900,
    ttft_ms: options.ttft ?? 100,
    total_cost_usd: cost,
    permission_denials: options.denials ?? [],
    modelUsage: options.modelUsage ?? {},
    terminal_reason: options.error ? 'error' : 'completed',
    ...(options.subagents ? { subagent_stats: options.subagents } : {}),
    ...(options.error ? { api_error_status: 'rate_limit_error', terminal_reason: 'error' } : {}),
  };
}

function put(name, n, records, expected, jsonl = false) {
  const init = { type: 'system', subtype: 'init', session_id: session(n), model: opus, tools: ['Read', 'Grep', 'Bash'] };
  const costs = {
    'one-request': [0.0008], 'five-requests': [0.37184], 'five-requests-jsonl': [0.37184],
    'repeated-chunks': [0.0008], 'last-result': [0.0008], 'unknown-model': [0.0008, 0],
    'bedrock-regional': [0.008], 'bedrock-global': [0.008], 'bedrock-ambiguous': [0.016],
    'one-hour-write': [0.008], 'expired-cache': [0.01], 'same-turn-gap': [0.01],
    'cache-write-warning': [6], subagent: [0.0016], 'denied-error': [0.0008], 'no-input': [0.001],
  }[name];
  const byModel = {};
  for (const record of records.filter((item) => item.type === 'assistant')) {
    const model = name === 'bedrock-regional' ? 'us.anthropic.claude-opus-5-5[1m]'
      : name === 'bedrock-global' ? 'global.anthropic.claude-opus-5-5[1m]' : record.message.model;
    const usage = record.message.usage;
    const item = byModel[model] ??= { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: costs[Object.keys(byModel).length] };
    if (record.message.id === id('msg', 7) && item.outputTokens > 0) continue;
    item.inputTokens += usage.input_tokens;
    item.outputTokens += usage.output_tokens;
    item.cacheReadInputTokens += usage.cache_read_input_tokens;
    item.cacheCreationInputTokens += usage.cache_creation_input_tokens;
  }
  if (name === 'bedrock-ambiguous') {
    const usage = byModel[opus];
    delete byModel[opus];
    byModel['us.anthropic.claude-opus-5-5[1m]'] = { ...usage, inputTokens: 1000, outputTokens: 200, costUSD: 0.008 };
    byModel['global.anthropic.claude-opus-5-5[1m]'] = { ...usage, inputTokens: 1000, outputTokens: 200, costUSD: 0.008 };
  }
  if (name === 'five-requests' || name === 'five-requests-jsonl') byModel[opus].thinkingTokens = 1600;
  for (const record of records.filter((item) => item.type === 'result')) record.modelUsage = byModel;
  const messages = [init, ...records];
  writeFileSync(join(directory, `${name}.${jsonl ? 'jsonl' : 'json'}`), jsonl ? messages.map(JSON.stringify).join('\n') + '\n' : JSON.stringify(messages, null, 2) + '\n');
  const requests = records.filter((item) => item.type === 'assistant')
    .filter((item, index, all) => all.findIndex((candidate) => candidate.message.id === item.message.id) === index);
  const rates = { [opus]: { uncached: 4, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2, output: 20 }, [sonnet]: { uncached: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1, output: 10 } };
  const emptyInput = () => ({ uncached: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, total: 0 });
  const addInput = (input, usage) => {
    input.uncached += usage.input_tokens;
    input.cacheWrite5m += usage.cache_creation.ephemeral_5m_input_tokens;
    input.cacheWrite1h += usage.cache_creation.ephemeral_1h_input_tokens;
    input.cacheRead += usage.cache_read_input_tokens;
    input.total = input.uncached + input.cacheWrite5m + input.cacheWrite1h + input.cacheRead;
  };
  const scope = (scopeRequests, scopeExpected = {}, child = false) => {
    const inputTokens = emptyInput();
    const tools = {};
    let outputTokens = 0;
    const contexts = [];
    const grouped = new Map();
    for (const item of scopeRequests) {
      const usage = item.message.usage;
      addInput(inputTokens, usage);
      outputTokens += usage.output_tokens;
      contexts.push(usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens);
      for (const block of item.message.content) if (block.type === 'tool_use') tools[block.name] = (tools[block.name] ?? 0) + 1;
      const model = item.message.model;
      const group = grouped.get(model) ?? { requests: 0, inputTokens: emptyInput(), outputTokens: 0 };
      group.requests++;
      addInput(group.inputTokens, usage);
      group.outputTokens += usage.output_tokens;
      grouped.set(model, group);
    }
    let models = [...grouped].map(([canonical, group]) => {
      const profile = name === 'bedrock-regional' ? 'us.anthropic.claude-opus-5-5[1m]'
        : name === 'bedrock-global' ? 'global.anthropic.claude-opus-5-5[1m]' : canonical;
      const multiplier = name === 'bedrock-regional' ? 1.1 : 1;
      const priced = Boolean(rates[canonical]) && name !== 'bedrock-ambiguous';
      const includesAllModelRequests = requests.filter((item) => item.message.model === canonical).length === group.requests;
      const model = { id: profile, canonical, requests: group.requests, inputTokens: group.inputTokens,
        outputTokens: group.outputTokens, reasoningOutputTokens: canonical === opus && name.startsWith('five-requests') ? 1600 : 0,
        costUsd: null, clientCostUsd: includesAllModelRequests ? byModel[profile]?.costUSD ?? null : null,
        priceMultiplier: priced ? multiplier : null,
        priced, contextWindow: priced ? 1000000 : null };
      if (priced) {
        const rate = rates[canonical];
        model.costByType = {
          uncached: group.inputTokens.uncached * rate.uncached * multiplier / 1e6,
          cacheWrite5m: group.inputTokens.cacheWrite5m * rate.cacheWrite5m * multiplier / 1e6,
          cacheWrite1h: group.inputTokens.cacheWrite1h * rate.cacheWrite1h * multiplier / 1e6,
          cacheRead: group.inputTokens.cacheRead * rate.cacheRead * multiplier / 1e6,
          output: group.outputTokens * rate.output * multiplier / 1e6,
        };
        model.costUsd = Object.values(model.costByType).reduce((sum, value) => sum + value, 0);
      }
      return model;
    });
    if (name === 'bedrock-ambiguous') {
      models = Object.entries(byModel).map(([profile, usage]) => ({
        id: profile, canonical: opus, requests: 1,
        inputTokens: { uncached: usage.inputTokens, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, total: usage.inputTokens },
        outputTokens: usage.outputTokens, reasoningOutputTokens: 0,
        costUsd: null, clientCostUsd: usage.costUSD,
        priceMultiplier: profile.startsWith('global.') ? 1 : 1.1,
        priced: false, contextWindow: 1000000,
      }));
    }
    const costUsd = models.some((model) => !model.priced) ? null : models.reduce((sum, model) => sum + model.costUsd, 0);
    if (scopeExpected.cost_usd !== undefined &&
        (costUsd === null ? scopeExpected.cost_usd !== null : Math.abs(costUsd - scopeExpected.cost_usd) > 1e-9)) {
      throw new Error(`${name}: hand-calculated cost differs from the fixed rate table`);
    }
    const writeUsd = models.filter((model) => model.priced).reduce((sum, model) => sum + model.costByType.cacheWrite5m + model.costByType.cacheWrite1h, 0);
    const total = scopeRequests.length;
    return {
      requests: total, subagentRequests: child ? total : scopeRequests.filter((item) => item.parent_tool_use_id !== null).length,
      toolCalls: Object.values(tools).reduce((sum, count) => sum + count, 0), tools,
      costUsd: scopeExpected.cost_usd ?? costUsd, inputTokens, outputTokens,
      reasoningOutputTokens: models.reduce((sum, model) => sum + model.reasoningOutputTokens, 0),
      avgInputPerRequest: total ? inputTokens.total / total : null,
      cacheReadShare: inputTokens.total ? inputTokens.cacheRead / inputTokens.total : null,
      contextFirst: contexts[0] ?? null, contextMax: contexts.length ? Math.max(...contexts) : null,
      cache: { writeShare: inputTokens.total ? (inputTokens.cacheWrite5m + inputTokens.cacheWrite1h) / inputTokens.total : null,
        writeUsd, writeWarning: scopeExpected.write_warning ?? false,
        expiryReturns: scopeExpected.cache?.expiries ?? null,
        returnInputTokens: scopeExpected.cache?.rebuild_tokens ?? null,
        returnInputUsd: scopeExpected.cache?.rebuild_usd ?? null,
        longestExpiryGapSeconds: scopeExpected.cache?.gap_seconds ?? null },
      models,
    };
  };
  const parentRequests = requests.filter((item) => item.parent_tool_use_id === null);
  const childRequests = requests.filter((item) => item.parent_tool_use_id !== null);
  const summary = scope(parentRequests, expected);
  const children = [...new Set(childRequests.map((item) => item.parent_tool_use_id))]
    .map((parentToolUseId) => ({ parentToolUseId, ...scope(childRequests.filter((item) => item.parent_tool_use_id === parentToolUseId), {}, true) }));
  const combined = scope(requests, { ...expected, cost_usd: name === 'subagent' ? 0.0016 : expected.cost_usd });
  const run = {
    turns: records.filter((item) => item.type === 'result').at(-1)?.num_turns,
    durationMs: records.filter((item) => item.type === 'result').at(-1)?.duration_ms,
    durationApiMs: records.filter((item) => item.type === 'result').at(-1)?.duration_api_ms,
    ttftMs: records.filter((item) => item.type === 'result').at(-1)?.ttft_ms,
    isError: records.filter((item) => item.type === 'result').at(-1)?.is_error,
    error: null,
    denials: {},
    subagents: { spawned: 0, completed: 0, failed: 0, byType: {} },
    ...(expected.run ?? {}),
  };
  if ('client_cost_usd' in run) { run.clientCostUsd = run.client_cost_usd; delete run.client_cost_usd; }
  if ('duration_ms' in run) { run.durationMs = run.duration_ms; delete run.duration_ms; }
  if ('is_error' in run) { run.isError = run.is_error; delete run.is_error; }
  const output = { schemaVersion: 1, source: { kind: 'claude-stream', sessionId: session(n) }, parent: summary, children, combined, run };
  writeFileSync(join(directory, `${name}.expected.json`), JSON.stringify(output, null, 2) + '\n');
}

// Opus: $4 input, $5 five-minute write, $8 one-hour write, $0.20 read, $20 output per million.
put('one-request', 1, [request(1, 1, opus, 100, 0, 0, 20, { tool: 'Read' }), result(0.0008)], {
  requests: 1, tool_calls: 1, tools: { Read: 1 }, cost_usd: 0.0008,
  input_tokens: { uncached: 100, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, total: 100 },
  output_tokens: 20, run: { turns: 1, client_cost_usd: 0.0008 },
});

const five = [
  request(2, 2, opus, 2, 50000, 0, 400, { tool: 'Grep' }),
  request(3, 5, opus, 2, 0, 80000, 500, { tool: 'Bash' }),
  request(4, 8, opus, 2, 0, 80000, 500, { tool: 'Read' }),
  request(5, 11, opus, 2, 0, 80000, 600, { tool: 'Grep' }),
  request(6, 14, opus, 2, 0, 89000, 800, { tool: 'Grep' }),
];
const fiveExpected = {
  requests: 5, tool_calls: 5, tools: { Grep: 3, Bash: 1, Read: 1 }, cost_usd: 0.37184,
  input_tokens: { uncached: 10, cache_write_5m: 50000, cache_write_1h: 0, cache_read: 329000, total: 379010 },
  output_tokens: 2800, reasoning_output_tokens: 1600, cache_read_share: 329000 / 379010, write_warning: false,
  run: { turns: 5, client_cost_usd: 0.37184 },
};
put('five-requests', 2, [...five, result(0.37184, { turns: 5 })], fiveExpected);
put('five-requests-jsonl', 12, [...five, result(0.37184, { turns: 5 })], fiveExpected, true);

put('repeated-chunks', 3, [request(7, 1, opus, 100, 0, 0, 20, { message: 7, tool: 'Read' }), request(8, 2, opus, 100, 0, 0, 20, { message: 7 }), result(0.0008)], {
  requests: 1, tool_calls: 1, tools: { Read: 1 }, cost_usd: 0.0008,
  input_tokens: { uncached: 100, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, total: 100 },
  output_tokens: 20, run: { client_cost_usd: 0.0008 },
});

put('last-result', 4, [request(9, 1, opus, 100, 0, 0, 20), result(0.0001, { turns: 1, duration: 200 }), result(0.0008, { turns: 2, duration: 2000 })], {
  requests: 1, cost_usd: 0.0008, run: { turns: 2, duration_ms: 2000, client_cost_usd: 0.0008 },
});

put('unknown-model', 5, [request(10, 1, opus, 100, 0, 0, 20), request(11, 2, unknown, 100, 0, 0, 20), result(0.0008)], {
  requests: 2, cost_usd: null, input_tokens: { uncached: 200, total: 200 }, output_tokens: 40,
  run: { client_cost_usd: 0.0008 },
});

// The assistant names a canonical model. A single recorded profile resolves its inference class.
put('bedrock-regional', 6, [request(12, 1, opus, 1000, 0, 0, 200), result(0.008)], {
  requests: 1, cost_usd: 0.0088,
  models: [{ id: 'us.anthropic.claude-opus-5-5[1m]', canonical: opus, costUsd: 0.0088, clientCostUsd: 0.008, priceMultiplier: 1.1 }],
  run: { client_cost_usd: 0.008 },
});
put('bedrock-global', 13, [request(13, 1, opus, 1000, 0, 0, 200), result(0.008)], {
  requests: 1, cost_usd: 0.008,
  models: [{ id: 'global.anthropic.claude-opus-5-5[1m]', canonical: opus, costUsd: 0.008, clientCostUsd: 0.008, priceMultiplier: 1 }],
  run: { client_cost_usd: 0.008 },
});
put('bedrock-ambiguous', 14, [request(21, 1, opus, 1000, 0, 0, 200), request(22, 2, opus, 1000, 0, 0, 200), result(0.016)], {
  requests: 2, cost_usd: null, run: { client_cost_usd: 0.016 },
});

put('one-hour-write', 7, [request(14, 1, opus, 0, 0, 0, 0, { write1h: 1000 }), result(0.008)], {
  requests: 1, cost_usd: 0.008,
  input_tokens: { uncached: 0, cache_write_5m: 0, cache_write_1h: 1000, cache_read: 0, total: 1000 },
  run: { client_cost_usd: 0.008 },
});

put('expired-cache', 8, [visibleTurn(31, 0), request(15, 1, opus, 0, 1000, 0, 0), visibleTurn(32, 309), request(16, 310, opus, 0, 1000, 0, 0), result(0.01)], {
  requests: 2, cost_usd: 0.01, cache: { expiries: 1, rebuild_tokens: 1000, rebuild_usd: 0.005, gap_seconds: 309 },
  run: { client_cost_usd: 0.01 },
});
put('same-turn-gap', 15, [visibleTurn(33, 0), request(23, 1, opus, 0, 1000, 0, 0), request(24, 310, opus, 0, 1000, 0, 0), result(0.01)], {
  requests: 2, cost_usd: 0.01, cache: { expiries: 0, rebuild_tokens: 0, rebuild_usd: 0 },
  run: { client_cost_usd: 0.01 },
});

put('cache-write-warning', 16, [
  request(25, 1, opus, 0, 240000, 0, 0), request(26, 2, opus, 0, 240000, 0, 0),
  request(27, 3, opus, 0, 240000, 0, 0), request(28, 4, opus, 0, 240000, 0, 0),
  request(29, 5, opus, 0, 240000, 0, 0), result(6),
], {
  requests: 5, cost_usd: 6, write_warning: true, run: { client_cost_usd: 6 },
});

put('subagent', 9, [request(17, 1, opus, 100, 0, 0, 20, { tool: 'Read' }), request(18, 2, opus, 100, 0, 0, 20, { parent: id('toolu', 17), tool: 'Grep' }), result(0.0016, { subagents: { spawned: 1, completed: 1, failed: 0, byType: {} } })], {
  requests: 1, subagent_requests: 0, tool_calls: 1, tools: { Read: 1 }, cost_usd: 0.0008,
  children: [{ parentToolUseId: id('toolu', 17), requests: 1, toolCalls: 1, tools: { Grep: 1 }, costUsd: 0.0008 }],
  combined: { requests: 2, subagentRequests: 1, toolCalls: 2, tools: { Read: 1, Grep: 1 }, costUsd: 0.0016 },
  run: { client_cost_usd: 0.0016, subagents: { spawned: 1, completed: 1, failed: 0, byType: {} } },
});

put('denied-error', 10, [request(19, 1, opus, 100, 0, 0, 20, { tool: 'Bash' }), result(0.0008, { error: true, denials: [{ tool_name: 'Bash' }] })], {
  requests: 1, tool_calls: 1, tools: { Bash: 1 }, cost_usd: 0.0008,
  run: { is_error: true, error: { status: 'rate_limit_error', terminalReason: 'error' }, denials: { Bash: 1 }, client_cost_usd: 0.0008 },
});

put('no-input', 11, [request(20, 1, sonnet, 0, 0, 0, 100), result(0.001)], {
  requests: 1, cost_usd: 0.001, input_tokens: { uncached: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, total: 0 },
  output_tokens: 100, cache_read_share: null, run: { client_cost_usd: 0.001 },
});
