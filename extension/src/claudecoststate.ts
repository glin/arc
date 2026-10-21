import fs from 'node:fs';
import { meterRead } from './readmeter';
import { createHash } from 'node:crypto';
import { normalizeModelIdentity } from './domain/model-identity';
import { BACKGROUND_SCAN_BYTES, BACKGROUND_SCAN_MILLISECONDS, retainedParserPayloadScan } from './parserstate';
import { insideClaudeRepeated } from './clauderepeated';
import { hasRequestContextPricing } from './pricing';
import { ExportLimitError } from './exportlimits';
import type {
  ProjectUsageBucket,
  SpendFileIndex,
  SpendIndexBudget,
  UsageCounts,
  UsageEvent,
  UsageLineReducer,
} from './projectspend';

export const CLAUDE_COST_STATE_SNAPSHOTS = 256;
export const CLAUDE_COST_STATE_MODELS = 32;
export const CLAUDE_COST_STATE_BYTES = 16 * 1024 * 1024;
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
type Counter = (typeof FIELDS)[number];
export type CostStateCounters = Partial<Record<Counter, number>>;
type Totals = Record<string, CostStateCounters>;
interface TierEvidence {
  at: number;
  tier: '5m' | '1h' | null;
}
type Tiers = Record<string, TierEvidence>;
type TierRequests = Record<string, TierEvidence & { model: string }>;
function replaceTierRequest(requests: TierRequests, event: UsageEvent): void {
  if (!event.model || !event.requestKey || event.compactionEstimate) return;
  delete requests[event.requestKey];
  const evidence = eventTier(event);
  if (evidence) requests[event.requestKey] = { ...evidence, model: normalizeModelIdentity(event.model) };
}
function combineTier(left: TierEvidence | undefined, right: TierEvidence): TierEvidence {
  if (!left) return right;
  if (left.at <= 0 || right.at <= 0) return { at: 0, tier: null };
  if (left.at !== right.at) return left.at > right.at ? left : right;
  return { at: left.at, tier: left.tier === right.tier ? left.tier : null };
}
function eventTier(event: UsageEvent): TierEvidence | undefined {
  if (event.compactionEstimate || (event.usage.requests ?? 1) < 0) return undefined;
  const hour = event.usage.cacheWrite1h > 0;
  const minute = event.usage.cacheWrite5m > 0;
  if (!hour && !minute) return undefined;
  return { at: event.timestamp, tier: hour === minute ? null : hour ? '1h' : '5m' };
}
export interface ClaudeCostSnapshot {
  id: string;
  offset: number;
  at: number | null;
  startTime: number;
  models: Totals;
  recorded: Totals;
  estimated: Totals;
  tiers: Record<string, '5m' | '1h'>;
  tierEvidence?: Tiers;
}
export interface ClaudeCostCapture {
  offset: number;
  at: number | null;
  snapshots: ClaudeCostSnapshot[];
  recorded: Totals;
  estimated: Totals;
  tiers: Record<string, '5m' | '1h'>;
  tierEvidence?: Tiers;
  tierRequests?: TierRequests;
  tierBytes?: number;
  reason?: string;
}
export interface CostStateDependency {
  file: string;
  size: number;
  mtimeMs: number;
  parserGeneration: number;
  accountingIdentity?: string | null;
}
export interface ClaudeCostSupplement {
  identity: string;
  dependencies: CostStateDependency[];
  snapshots: string[];
  lifetime: ProjectUsageBucket[];
  dated: ProjectUsageBucket[];
  lifetimeAllocations: Allocation[];
  datedAllocations: Allocation[];
}
export interface ClaudeCostProgress {
  identity: string;
  dependencies: CostStateDependency[];
  child: number;
  offset: number;
  pending: string;
  reducer?: unknown;
  recorded: Totals[];
  estimated: Totals[];
  activeRecorded: Totals[];
  activeEstimated: Totals[];
  totals: Totals;
  estimates: Totals;
  blocked: string[];
  activeBlocked: string[];
  tiers?: Tiers[];
  activeTiers?: Tiers[];
  activeTierRequests?: TierRequests;
  resourceBytes?: number;
  reason?: string;
}

const copy = <T>(value: T): T => structuredClone(value);
export function emptyClaudeCostCapture(): ClaudeCostCapture {
  return { offset: 0, at: null, snapshots: [], recorded: {}, estimated: {}, tiers: {} };
}
function counters(usage: UsageCounts): CostStateCounters {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite5m + usage.cacheWrite1h + (usage.cacheWrite30m ?? 0),
  };
}
function add(target: Totals, model: string, usage: CostStateCounters): void {
  const total = (target[model] ??= {});
  for (const field of FIELDS) total[field] = (total[field] ?? 0) + (usage[field] ?? 0);
}
export function noteClaudeCostEvent(state: ClaudeCostCapture, event: UsageEvent): void {
  if (state.reason || !event.model) return;
  const model = normalizeModelIdentity(event.model);
  if (
    !(model in state.recorded) &&
    !(model in state.estimated) &&
    new Set([...Object.keys(state.recorded), ...Object.keys(state.estimated)]).size >= CLAUDE_COST_STATE_MODELS
  ) {
    state.reason = 'recorded model limit';
    return;
  }
  add(event.compactionEstimate ? state.estimated : state.recorded, model, counters(event.usage));
  if (!event.compactionEstimate && event.requestKey) {
    if (eventTier(event)) {
      state.tierBytes = (state.tierBytes ?? 0) + event.requestKey.length * 64 + model.length * 64 + 4096;
      if (state.tierBytes > CLAUDE_COST_STATE_BYTES) {
        state.reason = 'working set limit';
        delete state.tierRequests;
        return;
      }
    }
    replaceTierRequest((state.tierRequests ??= {}), event);
  }
}

export function captureClaudeCostLine(state: ClaudeCostCapture, line: string, end?: number): void {
  state.offset = end ?? state.offset + Buffer.byteLength(line) + 1;
  if (state.reason) return;
  const clock = /"timestamp"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(line);
  if (clock) {
    try {
      const timestamp = (JSON.parse(line) as Record<string, unknown>).timestamp;
      const at = typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN;
      if (Number.isFinite(at) && at > 0) state.at = at;
    } catch {
      /* Invalid clocks do not replace the preceding valid clock. */
    }
  }
  if (!/"type"\s*:\s*"cost-state"/.test(line)) return;
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  if (
    record.type !== 'cost-state' ||
    typeof record.sessionId !== 'string' ||
    !record.sessionId ||
    !finite(record.startTime) ||
    !object(record.modelUsage)
  )
    return;
  const entries = Object.entries(record.modelUsage);
  if (!entries.length) return;
  if (entries.length > CLAUDE_COST_STATE_MODELS) {
    state.reason = 'raw model limit';
    return;
  }
  const models: Totals = {};
  for (const [model, value] of entries) {
    if (!model || !object(value)) return;
    const fields = {
      input: 'inputTokens',
      output: 'outputTokens',
      cacheRead: 'cacheReadInputTokens',
      cacheWrite: 'cacheCreationInputTokens',
    } as const;
    const usage: CostStateCounters = {};
    for (const field of FIELDS) {
      const count = value[fields[field]];
      if (count === undefined) continue;
      if (!finite(count) || !Number.isSafeInteger(count)) return;
      usage[field] = count;
    }
    for (const field of ['thinkingTokens', 'costUSD', 'webSearchRequests'])
      if (value[field] !== undefined && !finite(value[field])) return;
    if (
      value.thinkingTokens !== undefined &&
      typeof value.outputTokens === 'number' &&
      (value.thinkingTokens as number) > value.outputTokens
    )
      return;
    models[model] = usage;
  }
  if (record.totalCostUSD !== undefined && !finite(record.totalCostUSD)) return;
  state.tierEvidence = {};
  state.tiers = {};
  for (const evidence of Object.values(state.tierRequests ?? {}))
    state.tierEvidence[evidence.model] = combineTier(state.tierEvidence[evidence.model], evidence);
  for (const [model, evidence] of Object.entries(state.tierEvidence))
    if (evidence.tier) state.tiers[model] = evidence.tier;
  const previous = state.snapshots.at(-1);
  if (
    previous &&
    previous.startTime === record.startTime &&
    previous.at === state.at &&
    JSON.stringify([previous.models, previous.recorded, previous.estimated, previous.tiers, previous.tierEvidence]) ===
      JSON.stringify([models, state.recorded, state.estimated, state.tiers, state.tierEvidence ?? {}])
  )
    return;
  if (state.snapshots.length >= CLAUDE_COST_STATE_SNAPSHOTS) {
    state.reason = 'snapshot limit';
    return;
  }
  if (
    new Set([...state.snapshots.flatMap((snapshot) => Object.keys(snapshot.models)), ...Object.keys(models)]).size >
    CLAUDE_COST_STATE_MODELS
  ) {
    state.reason = 'raw model limit';
    return;
  }
  state.snapshots.push({
    id: `claude-cost-state:${record.sessionId}:${state.snapshots.length + 1}`,
    offset: state.offset,
    at: state.at,
    startTime: record.startTime,
    models,
    recorded: copy(state.recorded),
    estimated: copy(state.estimated),
    tiers: { ...state.tiers },
    tierEvidence: copy(state.tierEvidence ?? {}),
  });
}

export function costStateIdentity(dependencies: readonly CostStateDependency[]): string {
  return JSON.stringify(dependencies);
}
export function costStateDependency(file: SpendFileIndex, index = 0): CostStateDependency {
  return {
    file: file.file,
    size: file.size,
    mtimeMs: file.mtimeMs,
    parserGeneration: file.parserGeneration ?? 0,
    ...(index > 0
      ? {
          accountingIdentity: file.costStateSupplement
            ? createHash('sha256').update(file.costStateSupplement.identity).digest('hex')
            : null,
        }
      : {}),
  };
}
export function matchingCostSupplement(
  supplement: ClaudeCostSupplement | undefined,
  records: ReadonlyMap<string, SpendFileIndex>,
): supplement is ClaudeCostSupplement {
  const steps = matchingCostSupplementSteps(supplement, records);
  let result = steps.next();
  while (!result.done) result = steps.next();
  return result.value;
}

export function* matchingCostSupplementSteps(
  supplement: ClaudeCostSupplement | undefined,
  records: ReadonlyMap<string, SpendFileIndex>,
): Generator<void, boolean> {
  if (!supplement) return false;
  for (let index = 0; index < supplement.dependencies.length; index++) {
    yield;
    const dependency = supplement.dependencies[index];
    const file = records.get(dependency.file);
    if (
      !(
        file &&
        file.complete !== false &&
        !file.missingAt &&
        !file.trailing &&
        !file.trailingBytes &&
        JSON.stringify(costStateDependency(file, index)) === JSON.stringify(dependency)
      )
    )
      return false;
  }
  return true;
}

export interface Allocation {
  at: number | null;
  model: string;
  tier: '5m' | '1h' | null;
  usage: CostStateCounters;
}
function allocations(
  capture: ClaudeCostCapture,
  recorded: readonly Totals[],
  estimated: readonly Totals[],
  blocked: ReadonlySet<string>,
  lifetime: boolean,
  tiers: readonly Tiers[] = [],
): Allocation[] {
  const result: Allocation[] = [];
  const previous: Totals = {};
  const lineage = capture.snapshots[0]?.startTime;
  for (let cut = 0; cut < capture.snapshots.length; cut++) {
    const snapshot = capture.snapshots[cut];
    if (snapshot.startTime !== lineage) break;
    const aliases = new Map<string, string[]>();
    for (const raw of Object.keys(snapshot.models)) {
      const model = normalizeModelIdentity(raw);
      aliases.set(model, [...(aliases.get(model) ?? []), raw]);
    }
    for (const [model, raw] of aliases) {
      if (blocked.has(model) || raw.length !== 1) continue;
      const usage: CostStateCounters = {};
      for (const field of FIELDS) {
        const cli = snapshot.models[raw[0]][field];
        const basis = (snapshot.recorded[model]?.[field] ?? 0) + (recorded[cut]?.[model]?.[field] ?? 0);
        if (cli === undefined || basis > cli) continue;
        const gap = Math.max(
          0,
          cli -
            basis -
            (lifetime ? (snapshot.estimated[model]?.[field] ?? 0) + (estimated[cut]?.[model]?.[field] ?? 0) : 0),
        );
        const delta = gap - (previous[model]?.[field] ?? 0);
        if (delta > 0) usage[field] = delta;
        else if (delta < 0) {
          let removal = -delta;
          for (let index = result.length - 1; index >= 0 && removal > 0; index--) {
            const allocation = result[index];
            if (allocation.model !== model) continue;
            const removed = Math.min(removal, allocation.usage[field] ?? 0);
            allocation.usage[field] = (allocation.usage[field] ?? 0) - removed;
            removal -= removed;
          }
        }
        (previous[model] ??= {})[field] = gap;
      }
      const ownTier = snapshot.tierEvidence?.[model];
      const childTier = tiers[cut]?.[model];
      const latest = childTier ? combineTier(ownTier, childTier) : ownTier;
      result.push({ at: snapshot.at, model, tier: latest ? latest.tier : (snapshot.tiers[model] ?? '5m'), usage });
    }
  }
  return result.filter((item) => FIELDS.some((field) => (item.usage[field] ?? 0) > 0));
}
function materialize(values: readonly Allocation[], dated: boolean): ProjectUsageBucket[] {
  const buckets = values
    .filter((item) => !dated || item.at !== null)
    .map((item): ProjectUsageBucket => {
      const date = new Date(item.at ?? 0);
      const localDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      return {
        localDate,
        agent: 'claude',
        provider: null,
        model: item.model,
        contextWindow: null,
        contextBand: null,
        billingClass: 'unknown',
        inferenceClass: null,
        serviceTier: null,
        reportedCost: null,
        usageOrigin: 'claude-cost-state',
        requestCountExact: false,
        requests: 0,
        incomplete:
          hasRequestContextPricing(item.model, null) || (item.tier === null && (item.usage.cacheWrite ?? 0) > 0),
        usage: {
          requests: 0,
          input: item.usage.input ?? 0,
          output: item.usage.output ?? 0,
          thinking: 0,
          cacheRead: item.usage.cacheRead ?? 0,
          cacheWrite5m: item.tier !== '1h' ? (item.usage.cacheWrite ?? 0) : 0,
          cacheWrite1h: item.tier === '1h' ? (item.usage.cacheWrite ?? 0) : 0,
        },
      };
    });
  const grouped = new Map<string, ProjectUsageBucket>();
  for (const bucket of buckets) {
    const key = JSON.stringify([bucket.localDate, bucket.model, bucket.incomplete]);
    const previous = grouped.get(key);
    if (!previous) grouped.set(key, bucket);
    else
      for (const field of ['input', 'output', 'cacheRead', 'cacheWrite1h', 'cacheWrite5m'] as const)
        previous.usage[field] += bucket.usage[field];
  }
  return [...grouped.values()];
}
export function deriveClaudeCostSupplement(
  capture: ClaudeCostCapture,
  progress: ClaudeCostProgress,
): ClaudeCostSupplement {
  for (const snapshot of capture.snapshots) {
    const seen = new Set<string>();
    for (const raw of Object.keys(snapshot.models)) {
      const model = normalizeModelIdentity(raw);
      if (seen.has(model) && !progress.blocked.includes(model)) progress.blocked.push(model);
      seen.add(model);
    }
  }
  if (progress.dependencies.length > 1 && capture.snapshots.some((snapshot) => snapshot.at === null)) {
    for (const model of new Set(
      capture.snapshots.flatMap((snapshot) => Object.keys(snapshot.models).map(normalizeModelIdentity)),
    ))
      if (!progress.blocked.includes(model)) progress.blocked.push(model);
  }
  const lifetimeAllocations = allocations(
    capture,
    progress.recorded,
    progress.estimated,
    new Set(progress.blocked),
    true,
    progress.tiers,
  );
  const datedAllocations = allocations(
    capture,
    progress.recorded,
    progress.estimated,
    new Set(progress.blocked),
    false,
    progress.tiers,
  );
  return {
    identity: progress.identity,
    dependencies: progress.dependencies,
    snapshots: capture.snapshots.map((snapshot) => snapshot.id),
    lifetime: materialize(lifetimeAllocations, false),
    dated: materialize(datedAllocations, true),
    lifetimeAllocations,
    datedAllocations,
  };
}

function firstCut(cuts: readonly { at: number; index: number }[], at: number): number | undefined {
  let low = 0;
  let high = cuts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (cuts[middle].at < at) low = middle + 1;
    else high = middle;
  }
  return cuts[low]?.index;
}
function publishedTotals(file: SpendFileIndex, estimated: boolean): Totals {
  const totals: Totals = {};
  for (const bucket of file.lifetimeBuckets ?? []) {
    if (
      !bucket.model ||
      bucket.linkedSessionId ||
      bucket.linkedInvocationId ||
      !!bucket.compactionEstimate !== estimated
    )
      continue;
    add(totals, normalizeModelIdentity(bucket.model), counters(bucket.usage));
  }
  return totals;
}
function differentModels(left: Totals, right: Totals): string[] {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].filter((model) =>
    FIELDS.some((field) => (left[model]?.[field] ?? 0) !== (right[model]?.[field] ?? 0)),
  );
}

const admitted = new WeakSet<ClaudeCostProgress>();
const admissionScans = new WeakMap<ClaudeCostProgress, Generator<void, number>>();

export function reconcileClaudeCostState(
  capture: ClaudeCostCapture,
  dependencies: readonly SpendFileIndex[],
  factory: (state: unknown) => UsageLineReducer,
  restored?: ClaudeCostProgress,
  budget: SpendIndexBudget & { maxWorkingSetBytes?: number } = {},
): { progress: ClaudeCostProgress; supplement?: ClaudeCostSupplement; complete: boolean; invalidated?: boolean } {
  const clock = budget.now ?? Date.now;
  const records = new Map(dependencies.map((file) => [file.file, file]));
  const deadline = clock() + (budget.maxMilliseconds ?? BACKGROUND_SCAN_MILLISECONDS);
  let remaining = budget.maxBytes ?? BACKGROUND_SCAN_BYTES;
  const frozen = dependencies.map(costStateDependency);
  const identity = costStateIdentity(frozen);
  const progress: ClaudeCostProgress =
    restored?.identity === identity && restored.recorded.length === capture.snapshots.length
      ? restored
      : {
          identity,
          dependencies: frozen,
          child: 1,
          offset: 0,
          pending: '',
          recorded: capture.snapshots.map(() => ({})),
          estimated: capture.snapshots.map(() => ({})),
          activeRecorded: capture.snapshots.map(() => ({})),
          activeEstimated: capture.snapshots.map(() => ({})),
          totals: {},
          estimates: {},
          blocked: [],
          activeBlocked: [],
          tiers: capture.snapshots.map(() => ({})),
          activeTiers: capture.snapshots.map(() => ({})),
        };
  if (capture.reason) progress.reason = capture.reason;
  if (progress.reason) return { progress, complete: true };
  const maxWorkingSet = Math.min(CLAUDE_COST_STATE_BYTES, budget.maxWorkingSetBytes ?? CLAUDE_COST_STATE_BYTES);
  const withhold = () => {
    progress.reason = 'working set limit';
    delete progress.resourceBytes;
    admissionScans.delete(progress);
    delete progress.reducer;
    progress.pending = '';
    progress.offset = 0;
    progress.totals = {};
    progress.estimates = {};
    progress.activeRecorded = capture.snapshots.map(() => ({}));
    progress.activeEstimated = capture.snapshots.map(() => ({}));
    progress.activeTiers = capture.snapshots.map(() => ({}));
    delete progress.activeTierRequests;
    return { progress, complete: true };
  };
  // A slice that starts past its deadline still makes one admission step.
  // When admission is complete, the slice also makes one read, one buffered line, or one child completion.
  // Every later step checks the deadline first.
  let advanced = false;
  const expired = () => advanced && clock() >= deadline;
  if (remaining <= 0) return { progress, complete: false };
  if (!admitted.has(progress)) {
    const scan = admissionScans.get(progress) ?? retainedParserPayloadScan([progress, capture], maxWorkingSet / 4);
    admissionScans.set(progress, scan);
    let steps = 0;
    for (;;) {
      if ((steps > 0 && clock() >= deadline) || steps++ >= 8) return { progress, complete: false };
      const next = scan.next();
      if (!next.done) continue;
      admissionScans.delete(progress);
      progress.resourceBytes = Math.max(progress.resourceBytes ?? 0, next.value * 4 + 32768);
      if (progress.resourceBytes > maxWorkingSet) return withhold();
      admitted.add(progress);
      break;
    }
  }
  if ((progress.resourceBytes ?? 0) > maxWorkingSet) return withhold();
  progress.tiers ??= capture.snapshots.map(() => ({}));
  progress.activeTiers ??= capture.snapshots.map(() => ({}));
  const cuts = capture.snapshots
    .flatMap((snapshot, index) => (snapshot.at === null ? [] : [{ at: snapshot.at, index }]))
    .sort((a, b) => a.at - b.at || a.index - b.index);
  while (progress.child < dependencies.length && remaining > 0 && !expired()) {
    const file = dependencies[progress.child];
    if (file.complete === false || file.missingAt || file.trailing || file.trailingBytes)
      return { progress, complete: false };
    const childCapture = (file.parserState as { costState?: ClaudeCostCapture } | undefined)?.costState;
    if (childCapture?.snapshots.length && !matchingCostSupplement(file.costStateSupplement, records)) {
      if (file.costStateProgress?.reason) {
        progress.reason = 'native child accounting withheld';
        return { progress, complete: true };
      }
      return { progress, complete: false };
    }
    let fd: number;
    try {
      const stat = fs.statSync(file.file);
      if (stat.size !== file.size || stat.mtimeMs !== file.mtimeMs)
        return { progress, complete: false, invalidated: true };
      fd = fs.openSync(file.file, 'r');
    } catch {
      return { progress, complete: false, invalidated: true };
    }
    const reducer = factory(progress.reducer);
    try {
      while ((progress.offset < file.size || progress.pending) && remaining > 0 && !expired()) {
        const pendingBytes = Buffer.from(progress.pending, 'base64');
        // The slice parses buffered complete lines before its next read.
        // The buffer then holds at most one chunk and one partial record.
        // At the end of the file in an export, pending bytes without a newline still hold a complete last record.
        // The slice parses that record without a zero-byte read, so an expired slice makes it its one step.
        const exporting = budget.exportRecordBytes !== undefined;
        const buffered =
          pendingBytes.includes(10) || (exporting && progress.offset === file.size && pendingBytes.length > 0);
        const chunkBytes = buffered ? 0 : Math.min(64 * 1024, file.size - progress.offset, remaining);
        if (!buffered && (progress.resourceBytes ?? 0) + progress.pending.length * 8 + chunkBytes * 8 > maxWorkingSet)
          return withhold();
        const chunk = Buffer.allocUnsafe(chunkBytes);
        const read = buffered
          ? 0
          : meterRead(file.file, fs.readSync(fd, chunk, 0, chunk.length, progress.offset), progress.offset);
        if (!read && !progress.pending) break;
        if (!buffered) advanced = true;
        remaining -= read;
        progress.offset += read;
        if (budget.exportRecordBytes !== undefined) {
          let length = pendingBytes.length;
          for (let at = 0; at < read; at++) {
            if (chunk[at] === 10) length = 0;
            else if (++length > budget.exportRecordBytes)
              throw new ExportLimitError('record', budget.exportRecordBytes);
          }
        }
        const ended = exporting && progress.offset === file.size;
        const bytes = Buffer.concat([pendingBytes, chunk.subarray(0, read)]);
        // The pending bytes end where the read began, so `bytes` starts at this file offset.
        const base = progress.offset - bytes.length;
        let start = 0;
        // At the end of the file in an export, the end of the bytes also ends an unterminated last record.
        for (let end = 0; end <= bytes.length; end++) {
          if (end < bytes.length ? bytes[end] !== 10 : !ended || start === end) continue;
          if (expired()) break;
          advanced = true;
          // The parser's admission rule includes nested attachments and excludes ordinary tool results.
          // Charges cover retained objects, indexes, and checkpoint serialization copies.
          // The spend index records the byte ranges of repeated records, and a repeated record adds no cost.
          if (insideClaudeRepeated(file.claudeRepeated, base + start)) {
            start = end + 1;
            continue;
          }
          const line = bytes.subarray(start, end).toString('utf8');
          const retains = reducer.acceptsLine?.(line) ?? true;
          progress.resourceBytes =
            (progress.resourceBytes ?? 0) +
            (retains ? (end - start) * 64 + 4096 + capture.snapshots.length * 1024 : 128);
          if (progress.resourceBytes > maxWorkingSet) return withhold();
          for (const event of reducer.pushLine(line)) {
            if (!event.model || event.linkedSessionId || event.linkedInvocationId) continue;
            const model = normalizeModelIdentity(event.model);
            if (!(event.timestamp > 0) && !progress.activeBlocked.includes(model)) progress.activeBlocked.push(model);
            const usage = counters(event.usage);
            add(event.compactionEstimate ? progress.estimates : progress.totals, model, usage);
            const cut = firstCut(cuts, event.timestamp);
            replaceTierRequest((progress.activeTierRequests ??= {}), event);
            if (cut !== undefined)
              add((event.compactionEstimate ? progress.activeEstimated : progress.activeRecorded)[cut], model, usage);
          }
          start = end + 1;
        }
        progress.pending = bytes.subarray(start).toString('base64');
        progress.reducer = reducer.snapshot();
        if (
          Object.keys(progress.totals).length > CLAUDE_COST_STATE_MODELS ||
          Object.keys(progress.estimates).length > CLAUDE_COST_STATE_MODELS
        )
          return withhold();
      }
    } finally {
      fs.closeSync(fd);
    }
    if (progress.reason) return { progress, complete: true };
    if (progress.offset < file.size) return { progress, complete: false };
    if (progress.pending) return { progress, complete: false };
    const blocked = new Set([
      ...progress.blocked,
      ...progress.activeBlocked,
      ...differentModels(progress.totals, publishedTotals(file, false)),
      ...differentModels(progress.estimates, publishedTotals(file, true)),
    ]);
    progress.blocked = [...blocked];
    if (childCapture?.snapshots.length && file.costStateSupplement) {
      // Project subtraction includes the child's dated supplement.
      // Lifetime subtraction includes its estimates and lifetime supplement.
      const apply = (allocation: Allocation, target: Totals[], sign: number) => {
        if (allocation.at === null) {
          progress.blocked.push(allocation.model);
          return;
        }
        const cut = firstCut(cuts, allocation.at);
        if (cut !== undefined)
          add(
            target[cut],
            allocation.model,
            Object.fromEntries(FIELDS.map((field) => [field, sign * (allocation.usage[field] ?? 0)])),
          );
      };
      for (const allocation of file.costStateSupplement.datedAllocations) {
        apply(allocation, progress.activeRecorded, 1);
        apply(allocation, progress.activeEstimated, -1);
      }
      for (const allocation of file.costStateSupplement.lifetimeAllocations)
        apply(allocation, progress.activeEstimated, 1);
    }
    const recorded: Totals = {};
    const estimated: Totals = {};
    const tiers: Tiers = {};
    progress.activeTiers = capture.snapshots.map(() => ({}));
    for (const evidence of Object.values(progress.activeTierRequests ?? {})) {
      const cut = firstCut(cuts, evidence.at);
      if (cut !== undefined)
        progress.activeTiers[cut][evidence.model] = combineTier(progress.activeTiers[cut][evidence.model], evidence);
    }
    for (const cut of cuts) {
      for (const [model, evidence] of Object.entries(progress.activeTiers[cut.index]))
        tiers[model] = combineTier(tiers[model], evidence);
      for (const [model, evidence] of Object.entries(tiers))
        progress.tiers[cut.index][model] = combineTier(progress.tiers[cut.index][model], evidence);
      for (const [model, usage] of Object.entries(progress.activeRecorded[cut.index])) add(recorded, model, usage);
      for (const [model, usage] of Object.entries(progress.activeEstimated[cut.index])) add(estimated, model, usage);
      for (const [model, usage] of Object.entries(recorded)) add(progress.recorded[cut.index], model, usage);
      for (const [model, usage] of Object.entries(estimated)) add(progress.estimated[cut.index], model, usage);
    }
    progress.child++;
    advanced = true;
    progress.offset = 0;
    progress.pending = '';
    delete progress.reducer;
    progress.activeRecorded = capture.snapshots.map(() => ({}));
    progress.activeEstimated = capture.snapshots.map(() => ({}));
    progress.totals = {};
    progress.estimates = {};
    progress.activeBlocked = [];
    progress.activeTiers = capture.snapshots.map(() => ({}));
    delete progress.activeTierRequests;
  }
  const complete = progress.child === dependencies.length;
  if (complete)
    for (const file of dependencies) {
      try {
        const stat = fs.statSync(file.file);
        if (stat.size !== file.size || stat.mtimeMs !== file.mtimeMs)
          return { progress, complete: false, invalidated: true };
      } catch {
        return { progress, complete: false, invalidated: true };
      }
    }
  return { progress, complete, ...(complete ? { supplement: deriveClaudeCostSupplement(capture, progress) } : {}) };
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function validTotals(value: unknown, signed = false): boolean {
  return (
    object(value) &&
    Object.keys(value).length <= CLAUDE_COST_STATE_MODELS &&
    Object.values(value).every(
      (usage) =>
        object(usage) &&
        Object.keys(usage).every((field) => FIELDS.includes(field as Counter)) &&
        Object.values(usage).every((count) =>
          signed ? typeof count === 'number' && Number.isFinite(count) : finite(count),
        ),
    )
  );
}
function validTiers(value: unknown): boolean {
  return (
    object(value) &&
    Object.keys(value).length <= CLAUDE_COST_STATE_MODELS &&
    Object.values(value).every(
      (item) => object(item) && finite(item.at) && (item.tier === null || item.tier === '5m' || item.tier === '1h'),
    )
  );
}
function validTierRequests(value: unknown): boolean {
  if (!object(value) || Object.keys(value).length > CLAUDE_COST_STATE_BYTES / 4096) return false;
  let bytes = 0;
  for (const [key, item] of Object.entries(value)) {
    if (
      !object(item) ||
      typeof item.model !== 'string' ||
      !finite(item.at) ||
      (item.tier !== null && item.tier !== '5m' && item.tier !== '1h')
    )
      return false;
    bytes += key.length * 64 + item.model.length * 64 + 4096;
    if (bytes > CLAUDE_COST_STATE_BYTES) return false;
  }
  return true;
}
export function validClaudeCostCapture(value: unknown): value is ClaudeCostCapture {
  return (
    object(value) &&
    finite(value.offset) &&
    (value.at === null || finite(value.at)) &&
    (value.reason === undefined || typeof value.reason === 'string') &&
    validTotals(value.recorded) &&
    validTotals(value.estimated) &&
    (value.tierEvidence === undefined || validTiers(value.tierEvidence)) &&
    (value.tierRequests === undefined || validTierRequests(value.tierRequests)) &&
    (value.tierBytes === undefined ||
      (finite(value.tierBytes) && (value.tierBytes <= CLAUDE_COST_STATE_BYTES || typeof value.reason === 'string'))) &&
    object(value.tiers) &&
    Object.values(value.tiers).every((tier) => tier === '5m' || tier === '1h') &&
    Array.isArray(value.snapshots) &&
    value.snapshots.length <= CLAUDE_COST_STATE_SNAPSHOTS &&
    value.snapshots.every(
      (snapshot) =>
        object(snapshot) &&
        typeof snapshot.id === 'string' &&
        finite(snapshot.offset) &&
        (snapshot.at === null || finite(snapshot.at)) &&
        finite(snapshot.startTime) &&
        validTotals(snapshot.recorded) &&
        validTotals(snapshot.estimated) &&
        (snapshot.tierEvidence === undefined || validTiers(snapshot.tierEvidence)) &&
        object(snapshot.models) &&
        Object.keys(snapshot.models).length <= CLAUDE_COST_STATE_MODELS &&
        Object.values(snapshot.models).every((usage) => validTotals({ model: usage })) &&
        object(snapshot.tiers) &&
        Object.values(snapshot.tiers).every((tier) => tier === '5m' || tier === '1h'),
    )
  );
}
export function validCostStateDependencies(value: unknown): value is CostStateDependency[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (dependency) =>
        object(dependency) &&
        typeof dependency.file === 'string' &&
        finite(dependency.size) &&
        finite(dependency.mtimeMs) &&
        finite(dependency.parserGeneration) &&
        (dependency.accountingIdentity === undefined ||
          dependency.accountingIdentity === null ||
          typeof dependency.accountingIdentity === 'string'),
    ) &&
    new Set(value.map((dependency) => dependency.file)).size === value.length
  );
}
export function validCostStateAllocations(value: unknown): value is Allocation[] {
  return (
    Array.isArray(value) &&
    value.length <= CLAUDE_COST_STATE_SNAPSHOTS * CLAUDE_COST_STATE_MODELS &&
    value.every(
      (item) =>
        object(item) &&
        (item.at === null || finite(item.at)) &&
        typeof item.model === 'string' &&
        (item.tier === null || item.tier === '5m' || item.tier === '1h') &&
        validTotals({ model: item.usage }),
    )
  );
}

export function validCostStateMaterialization(supplement: ClaudeCostSupplement): boolean {
  const identity = (buckets: readonly ProjectUsageBucket[]) =>
    JSON.stringify(
      buckets
        .map((bucket) => [
          bucket.localDate,
          bucket.agent,
          bucket.provider,
          bucket.model,
          bucket.contextWindow,
          bucket.contextBand,
          bucket.billingClass,
          bucket.inferenceClass,
          bucket.serviceTier,
          bucket.reportedCost,
          bucket.usageOrigin,
          bucket.requestCountExact,
          bucket.requests,
          bucket.incomplete ?? false,
          bucket.usage.requests,
          bucket.usage.input,
          bucket.usage.output,
          bucket.usage.cacheRead,
          bucket.usage.cacheWrite1h,
          bucket.usage.cacheWrite5m,
          bucket.usage.cacheWrite30m ?? 0,
          bucket.usage.thinking,
        ])
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    );
  return (
    identity(supplement.lifetime) === identity(materialize(supplement.lifetimeAllocations, false)) &&
    identity(supplement.dated) === identity(materialize(supplement.datedAllocations, true))
  );
}
export function validClaudeCostProgress(value: unknown): value is ClaudeCostProgress {
  if (
    !object(value) ||
    (value.resourceBytes !== undefined &&
      (!finite(value.resourceBytes) || value.resourceBytes > CLAUDE_COST_STATE_BYTES)) ||
    (typeof value.pending === 'string' && value.pending.length * 8 > CLAUDE_COST_STATE_BYTES) ||
    !validCostStateDependencies(value.dependencies) ||
    value.identity !== costStateIdentity(value.dependencies) ||
    !Number.isInteger(value.child) ||
    (value.child as number) < 1 ||
    (value.child as number) > value.dependencies.length ||
    !finite(value.offset) ||
    typeof value.pending !== 'string' ||
    !validTotals(value.totals) ||
    !validTotals(value.estimates) ||
    !Array.isArray(value.blocked) ||
    !value.blocked.every((item) => typeof item === 'string') ||
    !Array.isArray(value.activeBlocked) ||
    !value.activeBlocked.every((item) => typeof item === 'string') ||
    (value.activeTierRequests !== undefined && !validTierRequests(value.activeTierRequests))
  )
    return false;
  for (const key of ['tiers', 'activeTiers']) {
    if (
      value[key] !== undefined &&
      (!Array.isArray(value[key]) ||
        (value[key] as unknown[]).length > CLAUDE_COST_STATE_SNAPSHOTS ||
        !(value[key] as unknown[]).every(validTiers))
    )
      return false;
  }
  const scan = retainedParserPayloadScan(value, CLAUDE_COST_STATE_BYTES / 4);
  let scanned = false;
  for (let steps = 0; steps < 128; steps++) {
    const next = scan.next();
    if (!next.done) continue;
    if (next.value * 4 > CLAUDE_COST_STATE_BYTES) return false;
    scanned = true;
    break;
  }
  if (!scanned) return false;
  const count = Array.isArray(value.recorded) ? value.recorded.length : -1;
  return ['recorded', 'estimated', 'activeRecorded', 'activeEstimated'].every(
    (key) =>
      Array.isArray(value[key]) &&
      (value[key] as unknown[]).length === count &&
      count <= CLAUDE_COST_STATE_SNAPSHOTS &&
      (value[key] as unknown[]).every((item) => validTotals(item, key.startsWith('active'))),
  );
}
