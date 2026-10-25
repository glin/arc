// Measures the session list publication path over a large list without a host, an editor or a clock.
// One tick is one host update cycle: the input gate, the payload build, the row delta encoding and the
// serialized size of what a panel would receive. The fixture changes one running session per tick, the
// way a transcript append changes one session in the owner's window.
// Counts and bytes are exact. Wall times include whatever else the machine runs and are reported, never compared.

import { railInputKey, railPayload, sameRailInputs, type PayloadSessionRow, type RailPayloadInput } from './payload';
import { serializedMessageBytes } from './performancediagnostics';
import type { SessionCostTotal, SessionStatChip } from './turncard';
import type { RailCacheMark, UnsentInput } from './turnrail';
import type { NewCount } from './turnread';
import type { RailStatus } from './view/rail';
import { RowDeltaSender } from './webview/row-deltas';

export interface RailPublicationOptions {
  // Listed sessions.
  rows: number;
  // Sessions that keep running. Each tick changes one of them.
  running: number;
  // Host update cycles to simulate.
  ticks: number;
  // Simulated milliseconds between cycles.
  tickMs: number;
  // Simulated clock at the first cycle.
  startAt?: number;
}

export interface RailPublicationPostCounts {
  count: number;
  bytes: number;
  maximumBytes: number;
}

export interface RailPublicationReport {
  options: Required<RailPublicationOptions>;
  // Ticks whose inputs the gate called changed, and ticks it skipped.
  gatePassed: number;
  gateSkipped: number;
  whole: RailPublicationPostCounts;
  delta: RailPublicationPostCounts;
  wholeReasons: Record<string, number>;
  // Rows carried across every post, and the bytes of the first complete list.
  rowsSent: number;
  snapshotBytes: number;
  // Bytes a panel receives per simulated minute.
  bytesPerMinute: number;
  // Wall milliseconds spent in each step over the whole run. Machine dependent.
  wallMs: { key: number; payload: number; encode: number; serialize: number };
}

const DEFAULTS: Required<RailPublicationOptions> = {
  rows: 3675,
  running: 6,
  ticks: 200,
  tickMs: 2900,
  startAt: Date.UTC(2026, 9, 25, 18, 0, 0),
};

const TOPICS = ['session list', 'cost report', 'startup', 'review', 'docs', 'installer', 'watcher', 'cache'];

function sessionId(index: number): string {
  return `session-${index.toString().padStart(5, '0')}`;
}

function costChip(dollars: number): SessionStatChip {
  const label = `$${dollars.toFixed(2)}`;
  return {
    kind: 'plain',
    metric: 'cost',
    label,
    detail: `${label} across the whole session`,
    compactLabel: label,
    dollars,
  };
}

function turnsChip(turns: number): SessionStatChip {
  return {
    kind: 'plain',
    metric: 'turns',
    label: `${turns} turns`,
    detail: `${turns} turns`,
    compactLabel: `${turns}`,
  };
}

interface Fixture {
  input: RailPayloadInput;
  costs: Map<string, number>;
  turns: Map<string, number>;
}

function fixture(options: Required<RailPublicationOptions>): Fixture {
  const sessions: PayloadSessionRow[] = [];
  const counts = new Map<string, NewCount>();
  const newest = new Map<string, number>();
  const statuses = new Map<string, RailStatus>();
  const runningSince = new Map<string, number>();
  const openChildren = new Map<string, number>();
  const hidden = new Set<string>();
  const pinnedTop = new Set<string>();
  const unsent = new Map<string, UnsentInput>();
  const metadataStats: Record<string, SessionStatChip[]> = {};
  const lifetimeStats: Record<string, SessionStatChip[]> = {};
  const lifetimeCosts: Record<string, SessionCostTotal> = {};
  const labels: Record<string, string[]> = {};
  const caches: Record<string, RailCacheMark | null> = {};
  const costs = new Map<string, number>();
  const turns = new Map<string, number>();
  for (let index = 0; index < options.rows; index++) {
    const id = sessionId(index);
    const at = options.startAt - index * 7 * 60_000;
    const running = index < options.running;
    sessions.push({
      id,
      persisted: true,
      label: `Investigate ${TOPICS[index % TOPICS.length]} behaviour in the ${index % 13} case`,
      agent: index % 5 === 0 ? 'codex' : 'claude',
      when: new Date(at).toISOString(),
      at,
      relative: running ? 'now' : `${index}m ago`,
      agentRun: index % 7 === 0 ? true : null,
    });
    counts.set(id, { count: index % 3, atLeast: false });
    newest.set(id, at);
    statuses.set(id, running ? 'running' : index % 11 === 0 ? 'failed' : 'done');
    if (running) {
      runningSince.set(id, options.startAt - 60_000);
      openChildren.set(id, 1);
      caches[id] = { expiresAt: options.startAt + 5 * 60_000, nearlyGoneAt: null };
    }
    if (index % 7 === 3) hidden.add(id);
    if (index % 120 === 1) pinnedTop.add(id);
    if (index % 50 === 2) unsent.set(id, { prompt: true, comments: 0 });
    const dollars = (index % 40) / 4 + 0.25;
    const turnCount = (index % 30) + 1;
    costs.set(id, dollars);
    turns.set(id, turnCount);
    metadataStats[id] = [turnsChip(turnCount)];
    lifetimeStats[id] = [costChip(dollars)];
    lifetimeCosts[id] = { dollars, partial: false };
    if (index % 9 === 0) labels[id] = [TOPICS[index % TOPICS.length]];
  }
  const input: RailPayloadInput = {
    sessions,
    counts,
    newest,
    statuses,
    runningSince,
    openChildren,
    backgroundCommands: new Map(),
    hidden,
    showing: sessionId(0),
    pinnedTop,
    unsent,
    parsedStats: {},
    metadataStats,
    lifetimeStats,
    lifetimeCosts,
    lifetimeCacheExpiry: {},
    labels,
    caches,
    views: [],
    railFilters: [],
    now: options.startAt,
  };
  return { input, costs, turns };
}

// One running session finished a turn: its newest turn, turn count and cost move, and the figure
// records are replaced the way the host replaces them after a spend read.
function advance(held: Fixture, tick: number, now: number, running: number): RailPayloadInput {
  if (running === 0) {
    held.input = { ...held.input, now };
    return held.input;
  }
  const id = sessionId(tick % running);
  const dollars = (held.costs.get(id) ?? 0) + 0.03;
  const turnCount = (held.turns.get(id) ?? 0) + 1;
  held.costs.set(id, dollars);
  held.turns.set(id, turnCount);
  const newest = new Map(held.input.newest);
  newest.set(id, now);
  const input: RailPayloadInput = {
    ...held.input,
    newest,
    metadataStats: { ...held.input.metadataStats, [id]: [turnsChip(turnCount)] },
    lifetimeStats: { ...held.input.lifetimeStats, [id]: [costChip(dollars)] },
    lifetimeCosts: { ...held.input.lifetimeCosts, [id]: { dollars, partial: false } },
    now,
  };
  held.input = input;
  return input;
}

function post(counts: RailPublicationPostCounts, bytes: number): void {
  counts.count++;
  counts.bytes += bytes;
  counts.maximumBytes = Math.max(counts.maximumBytes, bytes);
}

export function measureRailPublication(given: Partial<RailPublicationOptions> = {}): RailPublicationReport {
  const options = { ...DEFAULTS, ...given };
  const held = fixture(options);
  const sender = new RowDeltaSender();
  const globals = { day: new Date(options.startAt).toDateString(), scope: ['C:/work/arc'], folders: 'C:/work/arc' };
  const report: RailPublicationReport = {
    options,
    gatePassed: 0,
    gateSkipped: 0,
    whole: { count: 0, bytes: 0, maximumBytes: 0 },
    delta: { count: 0, bytes: 0, maximumBytes: 0 },
    wholeReasons: {},
    rowsSent: 0,
    snapshotBytes: 0,
    bytesPerMinute: 0,
    wallMs: { key: 0, payload: 0, encode: 0, serialize: 0 },
  };
  let lastKey: ReturnType<typeof railInputKey> | null = null;
  for (let tick = 0; tick < options.ticks; tick++) {
    const now = options.startAt + tick * options.tickMs;
    const input = tick === 0 ? held.input : advance(held, tick, now, options.running);
    const keyStarted = performance.now();
    const key = railInputKey(input);
    report.wallMs.key += performance.now() - keyStarted;
    if (sameRailInputs(lastKey, key)) {
      report.gateSkipped++;
      continue;
    }
    lastKey = key;
    report.gatePassed++;
    const payloadStarted = performance.now();
    const payload = railPayload(input);
    report.wallMs.payload += performance.now() - payloadStarted;
    const message = {
      type: 'rail',
      ...payload,
      sessionAdoptions: {},
      hidden: [...input.hidden],
      pinnedTop: [...input.pinnedTop],
    };
    const encodeStarted = performance.now();
    const encoded = sender.encode(message, globals);
    report.wallMs.encode += performance.now() - encodeStarted;
    const serializeStarted = performance.now();
    const bytes = serializedMessageBytes(encoded) ?? 0;
    report.wallMs.serialize += performance.now() - serializeStarted;
    const encoding = sender.lastEncoding;
    if (!encoding) continue;
    post(encoding.whole ? report.whole : report.delta, bytes);
    if (encoding.reason !== null)
      report.wholeReasons[encoding.reason] = (report.wholeReasons[encoding.reason] ?? 0) + 1;
    report.rowsSent += encoding.rowsSent;
    if (tick === 0) report.snapshotBytes = bytes;
  }
  const minutes = (options.ticks * options.tickMs) / 60_000;
  report.bytesPerMinute = minutes > 0 ? Math.round((report.whole.bytes + report.delta.bytes) / minutes) : 0;
  for (const step of Object.keys(report.wallMs) as (keyof RailPublicationReport['wallMs'])[]) {
    report.wallMs[step] = Math.round(report.wallMs[step] * 10) / 10;
  }
  return report;
}
