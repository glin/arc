import fs from "node:fs";
import path from "node:path";
import { scanLines } from "./agentspend.mjs";
import {
  codexRequestUsage,
  codexSessionsRoot,
  createCodexUsageLineReducer,
  readCodexSessionMeta,
  rolloutFiles
} from "./codex.mjs";
import { PROMOTIONS, quoteUsage } from "./pricing.mjs";
import {
  discoverClaudeSessionSpendSources,
  discoverCodexSessionSpendSources,
  spendFileIsClaudeChild
} from "./projectspend.mjs";
import {
  createClaudeUsageLineReducer,
  listSessionFiles,
  normalizeFsPath,
  projectsRoot,
  readClaudeChildSessionReferences,
  resolveClaudeDispatchReferences
} from "./transcript.mjs";
function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}
function inputTokens(request) {
  const usage = request.usage;
  return usage.input + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h + (usage.cacheWrite30m ?? 0) + (request.unclassifiedCacheWrite ?? 0);
}
function summarizeRequests(requests) {
  const count = requests.length;
  const summary = { requests: count, pricedRequests: 0, unpricedRequests: 0 };
  if (!count) return summary;
  const requestCountExact = requests.every((request) => request.requestCountExact !== false);
  const contextExact = requestCountExact && requests.every((request) => !request.incomplete);
  const costs = requests.map(
    (request) => request.incomplete || (request.unclassifiedCacheWrite ?? 0) > 0 && typeof request.reportedCost !== "number" ? null : quoteUsage({
      usage: request.usage,
      model: request.model,
      provider: request.provider,
      contextWindow: request.contextWindow,
      requestTokens: inputTokens(request),
      inferenceClass: request.inferenceClass,
      serviceTier: request.serviceTier,
      reportedCost: request.reportedCost
    })
  );
  const priced = costs.filter((quote) => quote !== null);
  const total = priced.reduce((sum, quote) => sum + quote.cost, 0);
  const allPriced = priced.length === count;
  const contexts = requests.map(inputTokens);
  const fifths = [];
  for (let index = 0; index < Math.min(5, count); index++) {
    const start = Math.floor(index * count / Math.min(5, count));
    const end = Math.floor((index + 1) * count / Math.min(5, count));
    const part = costs.slice(start, end);
    fifths.push(
      requestCountExact && part.every((quote) => quote !== null) ? round(part.reduce((sum, quote) => sum + quote.cost, 0) / part.length, 4) : null
    );
  }
  const readCost = costs.reduce((sum, quote, index) => {
    if (!quote?.rate) return sum;
    const rate = quote.rate.cacheRead ?? quote.rate.input * 0.1;
    return sum + requests[index].usage.cacheRead * rate / 1e6;
  }, 0);
  const models = /* @__PURE__ */ new Set();
  const unpricedModels = /* @__PURE__ */ new Set();
  for (let index = 0; index < count; index++) {
    const model = requests[index].model;
    if (model) models.add(model);
    if (!costs[index]) unpricedModels.add(model ?? "unknown");
  }
  return {
    requests: count,
    pricedRequests: priced.length,
    unpricedRequests: count - priced.length,
    ...requestCountExact ? {} : { requestCountExact: false },
    costUsd: allPriced ? round(total, 4) : null,
    pricedCostUsd: round(total, 4),
    costPerRequest: allPriced && requestCountExact ? round(total / count, 4) : null,
    costPerRequestByFifth: fifths,
    contextMean: contextExact ? Math.round(contexts.reduce((sum, value) => sum + value, 0) / count) : null,
    contextMax: contextExact ? contexts.reduce((max, value) => Math.max(max, value), 0) : null,
    contextFirst: contextExact ? contexts[0] : null,
    uncachedInputTokens: requests.reduce((sum, request) => sum + request.usage.input, 0),
    cachedInputTokens: requests.reduce((sum, request) => sum + request.usage.cacheRead, 0),
    cacheWriteInputTokens: requests.reduce(
      (sum, request) => sum + request.usage.cacheWrite5m + request.usage.cacheWrite1h + (request.usage.cacheWrite30m ?? 0) + (request.unclassifiedCacheWrite ?? 0),
      0
    ),
    outputTokens: requests.reduce((sum, request) => sum + request.usage.output, 0),
    reasoningOutputTokens: requests.reduce((sum, request) => sum + request.usage.thinking, 0),
    cacheReadShareOfCost: allPriced && priced.every((quote) => quote.rate !== null) && total > 0 ? round(readCost / total, 3) : null,
    toolCalls: requests.reduce((sum, request) => sum + request.toolCalls, 0),
    requestsWithTwoOrMoreTools: requests.filter((request) => request.toolCalls >= 2).length,
    models: [...models].sort(),
    unpricedModels: [...unpricedModels].sort()
  };
}
function windowTime(value, name) {
  if (value === void 0) return null;
  if (typeof value === "string") {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
    if (!match) throw new Error(`Invalid ${name} time: ${value}`);
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6] ?? 0);
    const offsetHour = Number(match[8] ?? 0);
    const offsetMinute = Number(match[9] ?? 0);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
      throw new Error(`Invalid ${name} time: ${value}`);
    }
  }
  const parsed = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${name} time: ${value}`);
  }
  return parsed;
}
function sessionCostReport(file, options = {}) {
  const since = windowTime(options.since, "since");
  const until = windowTime(options.until, "until");
  if (since !== null && until !== null && until < since) throw new Error("Until must be at or after since");
  const sources = sessionSources(file, options.roots);
  const inWindow = (request) => (since === null || request.timestamp >= since) && (until === null || request.timestamp < until);
  const requestsFor = (source) => (source.requests ?? readSessionRequests(source.file, source.kind, source.invocationId)).filter(inWindow);
  const parent = sources[0];
  const parentRequests = requestsFor(parent);
  const children = sources.slice(1).map((source) => ({ source, requests: requestsFor(source) }));
  const firstRequestTime = (requests) => requests.reduce((first, request) => Math.min(first, request.timestamp), Infinity);
  const retained = children.filter(({ requests }) => since === null && until === null || requests.length > 0).sort((left, right) => firstRequestTime(left.requests) - firstRequestTime(right.requests));
  const all = [...parentRequests, ...retained.flatMap(({ requests }) => requests)].sort(
    (left, right) => left.timestamp - right.timestamp
  );
  const sol = PROMOTIONS.find(({ pattern }) => pattern.test("gpt-5.6-sol"))?.promo;
  return {
    source: { kind: parent.kind, file: parent.file, sessionId: parent.sessionId },
    ...since !== null || until !== null ? {
      window: {
        since: since === null ? null : new Date(since).toISOString(),
        until: until === null ? null : new Date(until).toISOString()
      }
    } : {},
    parent: summarizeRequests(parentRequests),
    children: retained.map(({ source, requests }) => ({
      kind: source.kind,
      file: source.file,
      sessionId: source.sessionId,
      ...source.agent ? { agent: source.agent } : {},
      ...source.invocationId ? { invocationId: source.invocationId } : {},
      ...summarizeRequests(requests)
    })),
    combined: summarizeRequests(all),
    rateNote: `List-price estimate, not a subscription charge.${sol ? ` GPT-5.6 Sol uses its promotional rate through ${sol.until}.` : ""}`
  };
}
function projectStore(roots) {
  return roots.projects ?? projectsRoot();
}
function codexStore(roots) {
  return roots.codexSessions ?? codexSessionsRoot();
}
function findSessionTranscript(target, roots = {}) {
  const direct = path.resolve(target);
  if (fs.existsSync(direct)) {
    if (!fs.statSync(direct).isFile()) {
      throw new Error(`Transcript is not a file: ${direct}`);
    }
    return direct;
  }
  const matches = [];
  try {
    for (const project of fs.readdirSync(projectStore(roots), { withFileTypes: true })) {
      if (project.isDirectory()) {
        const candidate = path.join(projectStore(roots), project.name, `${target}.jsonl`);
        if (fs.existsSync(candidate)) matches.push(candidate);
      }
    }
  } catch {
  }
  for (const file of rolloutFiles(codexStore(roots))) {
    if (path.basename(file).endsWith(`-${target}.jsonl`)) matches.push(file);
  }
  if (matches.length === 0) throw new Error(`No transcript found for ${target}`);
  if (matches.length > 1) throw new Error(`More than one transcript matched ${target}: ${matches.join(", ")}`);
  return matches[0];
}
function isCodex(file) {
  return /^rollout-.*\.jsonl$/.test(path.basename(file)) || readCodexSessionMeta(file) !== null;
}
function claudeSourceId(file) {
  return path.basename(file, ".jsonl").replace(/^agent-/, "");
}
function claudeToolIds(line) {
  if (!line.includes('"tool_use"') || !line.includes('"assistant"')) return null;
  try {
    const record = JSON.parse(line);
    if (record.type !== "assistant") return null;
    const ids = record.message?.content?.filter((item) => item.type === "tool_use" && item.id).map((item) => item.id) ?? [];
    if (!ids.length) return null;
    const at = Date.parse(record.timestamp ?? "");
    return {
      key: `claude:${record.message?.id || record.uuid || `${Number.isNaN(at) ? "" : at}:${record.message?.model ?? ""}`}`,
      ids
    };
  } catch {
    return null;
  }
}
function codexToolCall(line) {
  if (!/"(?:custom_tool_call|function_call|web_search_call)"/.test(line)) return null;
  try {
    const record = JSON.parse(line);
    const kind = record.type === "event_msg" || record.type === "response_item" ? record.payload?.type : record.type;
    return kind === "custom_tool_call" || kind === "function_call" || kind === "web_search_call" ? {
      id: record.payload?.call_id ?? record.payload?.id ?? line,
      timestamp: Date.parse(record.timestamp ?? "") || 0
    } : null;
  } catch {
    return null;
  }
}
function codexSnapshotRecord(line) {
  if (!/"(?:compacted|task_started|token_count)"/.test(line)) return null;
  try {
    const record = JSON.parse(line);
    const kind = record.type === "event_msg" ? record.payload?.type : record.type;
    if (kind !== "token_count") return kind ? { kind, zeroUsage: false } : null;
    const usage = record.payload?.info?.last_token_usage;
    const zeroUsage = usage?.input_tokens === 0 && usage.output_tokens === 0 && usage.total_tokens === 0 && ["cached_input_tokens", "cache_write_input_tokens", "reasoning_output_tokens"].every(
      (field) => usage[field] === void 0 || usage[field] === 0
    );
    return { kind, zeroUsage };
  } catch {
    return null;
  }
}
function usageSignature(usage) {
  return [usage.input, usage.cacheRead, usage.cacheWrite30m ?? 0, usage.output, usage.thinking].join(":");
}
function readSessionRequests(file, role = isCodex(file) ? "codex" : "claude", invocationId) {
  const codex = role === "codex" || role === "codex-thread" || role === "claude-print" || role === "claude" && isCodex(file);
  const reducer = codex ? createCodexUsageLineReducer() : createClaudeUsageLineReducer(void 0, {
    childTranscript: role === "claude-subagent" || spendFileIsClaudeChild(file)
  });
  const ordered = /* @__PURE__ */ new Map();
  const toolIds = /* @__PURE__ */ new Map();
  const codexTools = /* @__PURE__ */ new Map();
  const compactionPlaceholders = /* @__PURE__ */ new Set();
  const billingRecords = /* @__PURE__ */ new Map();
  const snapshotPositions = /* @__PURE__ */ new Map();
  let pendingCompactionResponseId = null;
  let afterCompaction = false;
  let position = 0;
  const consumeCodexTools = (event, previous = 0) => {
    if (!codex || event.linkedInvocationId) return previous;
    const turnId = /^codex:([^:]+):/.exec(event.requestKey)?.[1];
    const pending = turnId ? codexTools.get(turnId) : void 0;
    let toolCalls = previous;
    for (const [id, timestamp] of pending ?? []) {
      if (event.timestamp > 0 && timestamp > event.timestamp) continue;
      toolCalls++;
      pending?.delete(id);
    }
    return toolCalls;
  };
  const complete = scanLines(file, (line) => {
    if (!line) return;
    position++;
    if (codex && line.includes("token_usage_record")) {
      try {
        const raw = JSON.parse(line);
        if (raw.type === "token_usage_record" && raw.payload?.response_id) {
          const usage = codexRequestUsage(raw.payload.usage);
          const state = reducer.snapshot();
          const turnId = raw.payload.turn_id ?? state.currentTurnId;
          if (usage && turnId && !state.currentTurnCopied && !state.foreignSessionMeta && usage.input + usage.cacheRead + (usage.cacheWrite30m ?? 0) + usage.output + usage.thinking > 0) {
            const model = state.turnModels[turnId] ?? null;
            const provider = state.provider;
            const billed = {
              timestamp: Date.parse(raw.timestamp ?? "") || 0,
              agent: "codex",
              provider,
              model,
              contextWindow: state.turnWindows[turnId] ?? null,
              contextBand: null,
              billingClass: provider && provider !== "openai" ? "metered" : state.planType ? "subscription" : state.planKnown ? "metered" : "unknown",
              inferenceClass: null,
              serviceTier: state.serviceTier,
              reportedCost: null,
              usage,
              requestKey: `codex-billing:${raw.payload.response_id}`,
              toolCalls: 0
            };
            billed.toolCalls = consumeCodexTools({ ...billed, requestKey: `codex:${turnId}:billing` });
            billingRecords.set(raw.payload.response_id, {
              turnId,
              request: billed,
              position
            });
          }
        }
      } catch {
      }
    }
    if (codex && line.includes("compacted")) {
      try {
        const raw = JSON.parse(line);
        if (raw.type === "compacted") pendingCompactionResponseId = raw.payload?.compaction_response_id ?? null;
      } catch {
      }
    }
    if (codex && pendingCompactionResponseId && line.includes("thread_settings_applied")) {
      try {
        const raw = JSON.parse(line);
        if (raw.type === "event_msg" && raw.payload?.type === "thread_settings_applied") {
          const billed = billingRecords.get(pendingCompactionResponseId);
          const settings = raw.payload?.thread_settings;
          if (billed) {
            billed.request.model = settings?.model ?? settings?.model_id ?? billed.request.model;
            billed.request.provider = settings?.model_provider_id ?? billed.request.provider;
            billed.request.serviceTier = settings?.service_tier ?? billed.request.serviceTier;
          }
          pendingCompactionResponseId = null;
        }
      } catch {
      }
    }
    const record = codex ? codexSnapshotRecord(line) : null;
    if (record?.kind === "task_started" || record?.kind === "task_complete" || record?.kind === "turn_aborted") {
      pendingCompactionResponseId = null;
    }
    if (record?.kind === "compacted") afterCompaction = true;
    const placeholder = afterCompaction && record?.kind === "token_count" && record.zeroUsage;
    const pendingBefore = placeholder ? new Set(reducer.pendingRequestKeys()) : null;
    const claudeTools = codex ? null : claudeToolIds(line);
    if (claudeTools) {
      const held = toolIds.get(claudeTools.key) ?? /* @__PURE__ */ new Set();
      for (const id of claudeTools.ids) held.add(id);
      toolIds.set(claudeTools.key, held);
    }
    const codexTool = codex ? codexToolCall(line) : null;
    if (codexTool) {
      const turnId = reducer.currentToolTurnId();
      if (turnId) {
        const held = codexTools.get(turnId) ?? /* @__PURE__ */ new Map();
        held.set(codexTool.id, codexTool.timestamp);
        codexTools.set(turnId, held);
      }
    }
    const priorRequestNumber = codex && record?.kind === "token_count" ? reducer.snapshot().requestNumber : null;
    const events = reducer.pushLine(line);
    if (codex && record?.kind === "token_count") {
      const state = reducer.snapshot();
      if (state.requestNumber !== priorRequestNumber) {
        const key = events.find((event) => event.agent === "codex")?.requestKey ?? state.pendingRequestKeys.at(-1);
        if (key) snapshotPositions.set(key, position);
      }
    }
    if (placeholder) {
      for (const key of reducer.pendingRequestKeys()) {
        if (!pendingBefore?.has(key)) compactionPlaceholders.add(key);
      }
      for (const event of events) {
        if (event.agent === "codex" && !pendingBefore?.has(event.requestKey))
          compactionPlaceholders.add(event.requestKey);
      }
    }
    if (record?.kind === "token_count" || record?.kind === "task_started") afterCompaction = false;
    if (codex && line.includes("token_count")) {
      for (const key of reducer.pendingRequestKeys())
        if (!ordered.has(key)) ordered.set(key, null);
    }
    for (const event of events) {
      if (event.compactionEstimate || !event.requestKey) continue;
      if ((event.usage.requests ?? 1) < 0) {
        ordered.set(event.requestKey, null);
        continue;
      }
      const previous = ordered.get(event.requestKey);
      ordered.set(event.requestKey, {
        ...event,
        toolCalls: consumeCodexTools(event, previous?.toolCalls ?? 0)
      });
    }
  });
  if (!complete) throw new Error(`Cannot read transcript: ${file}`);
  if (codex) {
    const state = reducer.snapshot();
    for (const [id, billed] of billingRecords) {
      if (state.copiedTurnIds[billed.turnId]) {
        billingRecords.delete(id);
        continue;
      }
      billed.request.model ??= state.turnModels[billed.turnId] ?? null;
      billed.request.contextWindow ??= state.turnWindows[billed.turnId] ?? null;
    }
    for (const events of Object.values(state.pendingRequests)) {
      for (const event of events) {
        ordered.set(event.requestKey, { ...event, incomplete: true, toolCalls: consumeCodexTools(event) });
      }
    }
  }
  const requests = [...ordered.values()].filter((request) => request !== null).filter((request) => !compactionPlaceholders.has(request.requestKey)).filter(
    (request) => !codex || request.linkedInvocationId || request.incomplete || request.usage.input + request.usage.cacheRead + request.usage.cacheWrite5m + request.usage.cacheWrite1h + (request.usage.cacheWrite30m ?? 0) + request.usage.output + request.usage.thinking > 0
  ).filter(
    (request) => invocationId === "*" || (role === "claude-print" ? request.linkedInvocationId === invocationId : !request.linkedInvocationId)
  ).map((request) => ({
    ...request,
    toolCalls: codex ? request.toolCalls : toolIds.get(request.requestKey)?.size ?? 0
  }));
  if (!codex || !billingRecords.size) return requests;
  const snapshotsByTurn = /* @__PURE__ */ new Map();
  for (const request of requests) {
    if (request.agent !== "codex") continue;
    const turnId = /^codex:([^:]+):/.exec(request.requestKey)?.[1];
    if (!turnId) continue;
    const byUsage = snapshotsByTurn.get(turnId) ?? /* @__PURE__ */ new Map();
    snapshotsByTurn.set(turnId, byUsage);
    const signature = request.incomplete ? "incomplete" : usageSignature(request.usage);
    const queue = byUsage.get(signature) ?? { items: [], next: 0 };
    queue.items.push(request);
    byUsage.set(signature, queue);
  }
  const matched = /* @__PURE__ */ new Set();
  const replaced = /* @__PURE__ */ new Set();
  for (const { turnId, request: billed, position: billingPosition } of billingRecords.values()) {
    const byUsage = snapshotsByTurn.get(turnId);
    const exact = byUsage?.get(usageSignature(billed.usage));
    const incomplete = byUsage?.get("incomplete");
    const eligible = (queue) => {
      if (!queue) return void 0;
      while (queue.next < queue.items.length) {
        const candidate = queue.items[queue.next];
        if ((snapshotPositions.get(candidate.requestKey) ?? 0) >= billingPosition) return candidate;
        queue.next++;
      }
      return void 0;
    };
    const exactCandidate = eligible(exact);
    const incompleteCandidate = eligible(incomplete);
    const match = exactCandidate && incompleteCandidate ? (snapshotPositions.get(exactCandidate.requestKey) ?? 0) < (snapshotPositions.get(incompleteCandidate.requestKey) ?? 0) ? exactCandidate : incompleteCandidate : exactCandidate ?? incompleteCandidate;
    if (match) {
      const queue = match === exactCandidate ? exact : incomplete;
      if (queue) queue.next++;
      matched.add(match.requestKey);
      if (match.incomplete) {
        replaced.add(match.requestKey);
        billed.toolCalls += match.toolCalls;
        requests.push(billed);
      } else {
        match.toolCalls += billed.toolCalls;
      }
    } else requests.push(billed);
  }
  return requests.filter((request) => !replaced.has(request.requestKey)).sort((left, right) => left.timestamp - right.timestamp);
}
function sessionSources(file, roots = {}) {
  const absolute = path.resolve(file);
  if (isCodex(absolute)) {
    const parent = readCodexSessionMeta(absolute);
    if (!parent?.sessionId) throw new Error(`No Codex session id in ${absolute}`);
    const children = rolloutFiles(codexStore(roots)).flatMap((candidate) => {
      const meta = readCodexSessionMeta(candidate);
      return meta?.sessionId && meta.parentThreadId ? [{ file: candidate, threadId: meta.sessionId, parentThreadId: meta.parentThreadId }] : [];
    });
    const sources2 = discoverCodexSessionSpendSources(
      [{ sessionId: parent.sessionId, file: absolute }],
      children
    ).map((source) => {
      const meta = source.primary ? parent : readCodexSessionMeta(source.file);
      return {
        kind: source.primary ? "codex" : "codex-thread",
        file: source.file,
        sessionId: meta?.sessionId ?? parent.sessionId,
        ...meta?.agentPath || meta?.subagentKind ? { agent: meta.agentPath ?? meta.subagentKind ?? void 0 } : {}
      };
    });
    for (const source of [...sources2]) {
      const requests = readSessionRequests(source.file, source.kind, "*");
      source.requests = [];
      const printRequests = /* @__PURE__ */ new Map();
      for (const request of requests) {
        if (!request.linkedInvocationId) {
          source.requests.push(request);
          continue;
        }
        const held = printRequests.get(request.linkedInvocationId) ?? [];
        held.push(request);
        printRequests.set(request.linkedInvocationId, held);
      }
      for (const [invocationId, linked] of printRequests) {
        sources2.push({
          kind: "claude-print",
          file: source.file,
          sessionId: linked[0].linkedSessionId ?? source.sessionId,
          invocationId,
          requests: linked
        });
      }
    }
    return sources2;
  }
  const parentId = claudeSourceId(absolute);
  let catalog = null;
  const dispatchCatalog = () => {
    if (catalog) return catalog;
    let directories = [];
    try {
      directories = fs.readdirSync(projectStore(roots), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(projectStore(roots), entry.name));
    } catch {
    }
    const local = spendFileIsClaudeChild(absolute) ? path.dirname(path.dirname(path.dirname(absolute))) : path.dirname(absolute);
    const known = new Set(directories.map((directory) => normalizeFsPath(path.resolve(directory))));
    if (!known.has(normalizeFsPath(path.resolve(local)))) directories.push(local);
    catalog = directories.flatMap(listSessionFiles);
    return catalog;
  };
  const sources = [];
  const seen = /* @__PURE__ */ new Set();
  const add = (source) => {
    const key = source.file.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    sources.push(source);
  };
  add({ kind: spendFileIsClaudeChild(absolute) ? "claude-subagent" : "claude", file: absolute, sessionId: parentId });
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index];
    if (source.kind !== "claude-subagent") {
      for (const child of discoverClaudeSessionSpendSources([{ file: source.file, sessionId: source.sessionId }])) {
        if (!child.primary)
          add({
            kind: "claude-subagent",
            file: child.file,
            sessionId: claudeSourceId(child.file)
          });
      }
    }
    const references = readClaudeChildSessionReferences({
      file: source.file,
      sessionId: source.sessionId,
      childTranscript: source.kind === "claude-subagent"
    });
    const resolved = references.some((reference) => reference.kind === "dispatch") ? resolveClaudeDispatchReferences(references, dispatchCatalog()) : references;
    for (const reference of resolved) {
      const childFile = reference.file;
      if (!childFile || !fs.existsSync(childFile)) continue;
      add({
        kind: reference.kind === "dispatch" ? "claude-session" : "claude-subagent",
        file: childFile,
        sessionId: claudeSourceId(childFile)
      });
    }
  }
  return sources;
}
export {
  findSessionTranscript,
  readSessionRequests,
  sessionCostReport,
  sessionSources,
  summarizeRequests
};
