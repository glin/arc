// Measures the session list publication path over a large list without a host, an editor or a clock.
// One tick is one host update cycle: the input gate, the payload build, the row delta encoding and the
// serialized size of what a panel would receive. The fixture changes one running session per tick, the
// way a transcript append changes one session in a reader's window.
// Each post is weighed whole and by top-level field. The query context lists every session's identity and,
// in its revision, every session file with its device and inode, the way the host builds it. It travels in its own
// message when the panel's last context differs, and its bytes count toward the tick that posts it.
// Counts and bytes are exact for the generated fixture, whose rows carry one short label and two figures,
// so a real list of the same length serializes larger. Wall times include whatever else the machine runs
// and are reported, never compared.

import { sameSessionQueryContext, type SessionQueryContext } from './domain/session-query';
import {
  messageFieldBytes,
  railInputKey,
  railMessage,
  railPayload,
  sameRailInputs,
  type PayloadSessionRow,
  type RailPayloadInput,
} from './payload';
import { serializedMessageBytes } from './performancediagnostics';
import { sessionCatalogMembership } from './sessionreads';
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
  // Query context messages, posted beside the session list messages.
  queryContext: RailPublicationPostCounts;
  wholeReasons: Record<string, number>;
  // Rows carried across every post, and the bytes of the first complete list.
  rowsSent: number;
  snapshotBytes: number;
  // Bytes of each top-level field in the first complete list and in the largest delta post.
  fields: Record<string, { snapshot: number; delta: number }>;
  // The largest bytes posted in one tick after the first, every message included, as a share of the first complete list.
  tickShare: number;
  // Bytes a panel receives per simulated minute.
  bytesPerMinute: number;
  // Wall milliseconds spent in each step over the whole run. Machine dependent.
  wallMs: { key: number; payload: number; encode: number; serialize: number };
}

// A chosen large list: thousands of listed sessions, a few running, and a tick every few seconds.
const DEFAULTS: Required<RailPublicationOptions> = {
  rows: 3675,
  running: 6,
  ticks: 200,
  tickMs: 2900,
  startAt: Date.UTC(2026, 9, 25, 18, 0, 0),
};

const TOPICS = ['session list', 'cost report', 'startup', 'review', 'docs', 'installer', 'watcher', 'cache'];

// Native session IDs are UUIDs, and the query context carries each one.
function sessionId(index: number): string {
  return `5e55${index.toString(16).padStart(4, '0')}-0000-4000-8000-${index.toString().padStart(12, '0')}`;
}

function sessionFile(index: number, agent: string): string {
  return agent === 'codex'
    ? `C:/Users/reader/.codex/sessions/2026/10/25/rollout-2026-10-25T18-00-00-${sessionId(index)}.jsonl`
    : `C:/Users/reader/.claude/projects/C--work-arc/${sessionId(index)}.jsonl`;
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
  queryContext: SessionQueryContext;
  costs: Map<string, number>;
  turns: Map<string, number>;
}

const SCOPE = JSON.stringify(['C:/work/arc']);

// The context `sessionQueryContext` in `panelhost.ts` builds for a complete discovery: every scoped identity, and a revision
// that holds the discovery membership and the catalog membership.
function queryContext(sessions: readonly PayloadSessionRow[]): SessionQueryContext {
  const files = sessions.map((session, index) => ({
    file: sessionFile(index, session.agent),
    dev: 2_861_532_127,
    ino: 1_125_899_907_000_000 + index,
  }));
  const membership = sessionCatalogMembership(SCOPE, files);
  return {
    identities: sessions.map(({ id, agent }) => ({ sessionId: id, agent })),
    coverage: 'complete',
    scope: SCOPE,
    revision: JSON.stringify([membership, membership]),
  };
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
  return { input, queryContext: queryContext(sessions), costs, turns };
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
  // A refresh publishes a new catalog array, so the host builds a new context object with the same contents.
  held.queryContext = { ...held.queryContext };
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
    queryContext: { count: 0, bytes: 0, maximumBytes: 0 },
    wholeReasons: {},
    rowsSent: 0,
    snapshotBytes: 0,
    fields: {},
    tickShare: 0,
    bytesPerMinute: 0,
    wallMs: { key: 0, payload: 0, encode: 0, serialize: 0 },
  };
  let lastKey: ReturnType<typeof railInputKey> | null = null;
  let largestTick = 0;
  let contextSent: SessionQueryContext | undefined;
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
    let contextBytes = 0;
    if (!contextSent || !sameSessionQueryContext(contextSent, held.queryContext)) {
      contextSent = held.queryContext;
      contextBytes = serializedMessageBytes({ type: 'queryContext', queryContext: held.queryContext }) ?? 0;
      post(report.queryContext, contextBytes);
    }
    const payloadStarted = performance.now();
    const payload = railPayload(input);
    report.wallMs.payload += performance.now() - payloadStarted;
    const message = railMessage(payload, {
      sessionAdoptions: [],
      hidden: [...input.hidden],
      pinnedTop: [...input.pinnedTop],
    });
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
    else largestTick = Math.max(largestTick, bytes + contextBytes);
    for (const { field, bytes: fieldBytes } of messageFieldBytes(encoded)) {
      const entry = (report.fields[field] ??= { snapshot: 0, delta: 0 });
      if (tick === 0) entry.snapshot = fieldBytes;
      else if (!encoding.whole) entry.delta = Math.max(entry.delta, fieldBytes);
    }
  }
  report.tickShare = report.snapshotBytes > 0 ? largestTick / report.snapshotBytes : 0;
  const minutes = (options.ticks * options.tickMs) / 60_000;
  const posted = report.whole.bytes + report.delta.bytes + report.queryContext.bytes;
  report.bytesPerMinute = minutes > 0 ? Math.round(posted / minutes) : 0;
  for (const step of Object.keys(report.wallMs) as (keyof RailPublicationReport['wallMs'])[]) {
    report.wallMs[step] = Math.round(report.wallMs[step] * 10) / 10;
  }
  return report;
}
