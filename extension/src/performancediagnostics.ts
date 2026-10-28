import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { ARC_IDENTITY } from './identity';

export const PERFORMANCE_DIAGNOSTICS_SCHEMA_VERSION = 6;

const MESSAGE_BYTE_BUDGETS: Readonly<Record<string, number>> = {
  render: 250_000,
  rail: 1_100_000,
  // A query context lists every scoped session, like a complete session list.
  queryContext: 1_100_000,
};

export interface OperationCounts {
  count: number;
  totalDurationMs: number;
  maximumDurationMs: number;
  lastDurationMs: number;
}

export interface MessageCounts {
  count: number;
  serializedBytes: number;
  maximumSerializedBytes: number;
  unavailableByteCount: number;
}

export interface WatcherOperation {
  id: number;
  reason: string;
  eventCount: number;
  distinctPathCount: number;
  waitMs: number;
  maximumWaitFired: boolean;
  decision: 'broad' | 'targeted';
  // Why a broad decision walked. Empty for a targeted decision.
  broadReasons: string[];
  durationMs: number;
}

// Decisions since activation. A broad decision with two causes counts under both causes and once as broad.
// `unknownPathShapes` and `unknownPathExtensions` count each path that decided `unknownPath`, so a decision with two
// such paths counts twice in each. Neither keeps the path. `walkListedPaths` counts each path that a targeted decision
// admitted because the last walk listed it and the held catalog did not.
export interface WatcherDecisionCounts {
  targeted: number;
  broad: number;
  walkListedPaths: number;
  broadReasons: Record<string, number>;
  unknownPathShapes: Record<string, number>;
  unknownPathExtensions: Record<string, number>;
}

// Row-carrying posts of one message kind, split by whether the panel received a snapshot or a delta.
export interface RowPostCounts {
  whole: MessageCounts;
  delta: MessageCounts;
  wholeReasons: Record<string, number>;
  // Rows described by the last post to any panel, and rows carried across every post.
  rowsHeld: number;
  rowsSent: number;
}

// What one row-carrying post encoded. The sender supplies it, so the counter measures nothing itself.
export interface RowPostEncoding {
  whole: boolean;
  reason: string | null;
  rowsHeld: number;
  rowsSent: number;
}

export interface LedgerSaveOperation {
  id: number;
  reason: 'quiet' | 'maximum' | 'flush' | 'retry';
  durationMs: number;
  succeeded: boolean;
}

export interface PerformanceCounterSnapshot {
  discovery: import('./progressiveworker').DiscoveryCharges & { continuations: number; publications: number };
  sourceId: string;
  startedAt: string;
  captureCount: number;
  refreshes: Record<string, OperationCounts>;
  refreshStages: Record<RefreshStage, number>;
  messages: Record<string, MessageCounts>;
  panelPosts: Record<string, Record<string, MessageCounts>>;
  panelMessages: Record<string, OperationCounts>;
  panelReplies: Record<string, Record<string, OperationCounts>>;
  watcherOperationCount: number;
  watcherDecisions: WatcherDecisionCounts;
  rowPosts: Record<string, RowPostCounts>;
  rowsGapCount: number;
  // Named host operations since activation, by count. Each name is one derivation or file check the host repeats.
  work: Record<string, number>;
  ledgerSaveCount: number;
  lastWatcherOperation: WatcherOperation | null;
  lastLedgerSave: LedgerSaveOperation | null;
  startup?: { id: number; milestones: Partial<Record<StartupMilestone, number>> };
  // Dispatched spend by root session ID, summed over complete discovery replies. The roots with the most bytes keep
  // their own record, and `other` sums the rest with their count, so the snapshot stays within a fixed size.
  dispatchRoots: Record<string, DispatchRootRecord>;
}

type DispatchRootCharges = import('./progressiveworker').DispatchRootCharges;
export type DispatchRootRecord =
  | DispatchRootCharges
  | (Omit<DispatchRootCharges, 'agent' | 'size'> & { roots: number });
export const DISPATCH_ROOT_RECORDS = 20;

export type StartupMilestone = 'shellReady' | 'catalogReady' | 'railReady' | 'firstCard' | 'completeRender';

// Catalog refresh stages include started work, coalesced requests, unchanged content, posted renders, and deadline abandonment.
export type RefreshStage = 'started' | 'coalesced' | 'unchanged' | 'rendered' | 'abandoned';

function operationCounts(): OperationCounts {
  return { count: 0, totalDurationMs: 0, maximumDurationMs: 0, lastDurationMs: 0 };
}

function messageCounts(): MessageCounts {
  return { count: 0, serializedBytes: 0, maximumSerializedBytes: 0, unavailableByteCount: 0 };
}

function recordMessageCount(counts: MessageCounts, serializedBytes: number | null): void {
  counts.count++;
  if (serializedBytes === null) {
    counts.unavailableByteCount++;
  } else {
    counts.serializedBytes += serializedBytes;
    counts.maximumSerializedBytes = Math.max(counts.maximumSerializedBytes, serializedBytes);
  }
}

function rowPostCounts(): RowPostCounts {
  return { whole: messageCounts(), delta: messageCounts(), wholeReasons: {}, rowsHeld: 0, rowsSent: 0 };
}

function sortedRecord<T>(entries: Iterable<[string, T]>, copy: (value: T) => T): Record<string, T> {
  return Object.fromEntries(
    [...entries].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, copy(value)]),
  );
}

function rowPostSnapshot(counts: RowPostCounts): RowPostCounts {
  return {
    whole: { ...counts.whole },
    delta: { ...counts.delta },
    wholeReasons: { ...counts.wholeReasons },
    rowsHeld: counts.rowsHeld,
    rowsSent: counts.rowsSent,
  };
}

function messageCountSnapshot(counts: Map<string, MessageCounts>): Record<string, MessageCounts> {
  return Object.fromEntries(
    [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([type, value]) => [type, { ...value }]),
  );
}

function finiteDuration(durationMs: number): number {
  return Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
}

// Measure serialized message bytes. The host calls this after posting a budgeted message.
export function serializedMessageBytes(message: unknown): number | null {
  try {
    const text = JSON.stringify(message);
    return text === undefined ? null : Buffer.byteLength(text, 'utf8');
  } catch {
    return null;
  }
}

export function messageByteBudget(type: string): number | null {
  return MESSAGE_BYTE_BUDGETS[type] ?? null;
}

// Receive operation facts from the counters without additional measurement.
export interface PerformanceEventSink {
  // Counters check this before building detailed event records to avoid work when logging is disabled.
  enabled(): boolean;
  emit(event: string, record: Record<string, unknown>): void;
}

// Default sink disables detailed events and ignores emitted startup milestones.
const UNWATCHED: PerformanceEventSink = { enabled: () => false, emit: () => {} };

type DiscoveryCharges = import('./progressiveworker').DiscoveryCharges;

// A record over every charge field fails typecheck when a field is missing, so no charge goes unsummed.
const DISCOVERY_CHARGE_FIELDS: { readonly [K in keyof DiscoveryCharges]-?: true } = {
  readBytes: true,
  receiptEntries: true,
  receiptChecks: true,
  receiptBytes: true,
  revalidationBytes: true,
  hits: true,
  resets: true,
  quanta: true,
  dispatchRetries: true,
  parentChecks: true,
  parentCheckMs: true,
  childHeadFiles: true,
  childHeadBytes: true,
  childHeadMs: true,
  dispatchSpendVisits: true,
  dispatchSpendRereads: true,
  dispatchSpendFiles: true,
  dispatchSpendBytes: true,
  dispatchSpendMs: true,
  dispatchSpendAggregateStarts: true,
  dispatchSpendAggregateCompletions: true,
  dispatchSpendRelationshipInvalidations: true,
  dispatchSpendConsumedSourceInvalidations: true,
  dispatchSpendSourceRestarts: true,
  dispatchSpendParserAdvancements: true,
  dispatchSpendRootWaits: true,
  dispatchSpendAggregateExhaustedBytes: true,
  dispatchSpendAggregateExhaustedTime: true,
  dispatchSpendAggregateExhaustedSource: true,
  dispatchPersonBytes: true,
  dispatchAggregateBytes: true,
  dispatchClaudeSpendBytes: true,
  dispatchAggregateRemainingBytes: true,
  dispatchAggregateRemainingMs: true,
  dispatchSpendRootRestarts: true,
  passMs: true,
  transcriptPassEnds: true,
  receiptPassEnds: true,
  otherPassEnds: true,
};
const DISCOVERY_CHARGE_KEYS = Object.keys(DISCOVERY_CHARGE_FIELDS) as (keyof DiscoveryCharges)[];
const DISPATCH_ROOT_SUMS = ['passes', 'bytes', 'rereads', 'rootWaits', 'restarts', 'remainingBytes'] as const;

// The roots with the most bytes keep their records. The rest fold into `other`.
function dispatchRootSnapshot(roots: ReadonlyMap<string, DispatchRootCharges>): Record<string, DispatchRootRecord> {
  const ranked = [...roots].sort(([a, left], [b, right]) => right.bytes - left.bytes || a.localeCompare(b));
  const records: Record<string, DispatchRootRecord> = Object.fromEntries(
    ranked.slice(0, DISPATCH_ROOT_RECORDS).map(([sessionId, root]) => [sessionId, { ...root }]),
  );
  const rest = ranked.slice(DISPATCH_ROOT_RECORDS);
  if (rest.length) {
    const other = { roots: rest.length, passes: 0, bytes: 0, rereads: 0, rootWaits: 0, restarts: 0, remainingBytes: 0 };
    for (const [, root] of rest) for (const key of DISPATCH_ROOT_SUMS) other[key] += root[key];
    records.other = other;
  }
  return records;
}

export class PanelPerformanceCounters {
  readonly sourceId: string;
  private readonly sink: PerformanceEventSink;
  private readonly startedAt: string;
  private captureCount = 0;
  private discovery = {
    readBytes: 0,
    receiptEntries: 0,
    receiptChecks: 0,
    receiptBytes: 0,
    revalidationBytes: 0,
    hits: 0,
    resets: 0,
    quanta: 0,
    dispatchRetries: 0,
    parentChecks: 0,
    parentCheckMs: 0,
    childHeadFiles: 0,
    childHeadBytes: 0,
    childHeadMs: 0,
    dispatchSpendVisits: 0,
    dispatchSpendRereads: 0,
    dispatchSpendFiles: 0,
    dispatchSpendBytes: 0,
    dispatchSpendMs: 0,
    dispatchSpendAggregateStarts: 0,
    dispatchSpendAggregateCompletions: 0,
    dispatchSpendRelationshipInvalidations: 0,
    dispatchSpendConsumedSourceInvalidations: 0,
    dispatchSpendSourceRestarts: 0,
    dispatchSpendParserAdvancements: 0,
    dispatchSpendRootWaits: 0,
    dispatchSpendAggregateExhaustedBytes: 0,
    dispatchSpendAggregateExhaustedTime: 0,
    dispatchSpendAggregateExhaustedSource: 0,
    dispatchPersonBytes: 0,
    dispatchAggregateBytes: 0,
    dispatchClaudeSpendBytes: 0,
    dispatchAggregateRemainingBytes: 0,
    dispatchAggregateRemainingMs: 0,
    dispatchSpendRootRestarts: 0,
    passMs: 0,
    transcriptPassEnds: 0,
    receiptPassEnds: 0,
    otherPassEnds: 0,
    continuations: 0,
    publications: 0,
  };
  // A complete reply that still asks for another pass counts as a continuation, so back-to-back passes show in the record.
  recordDiscovery(
    charges: import('./progressiveworker').DiscoveryCharges | undefined,
    reply: { complete: boolean; continuation: boolean },
    dispatchRoots?: Record<string, DispatchRootCharges>,
  ): void {
    if (charges) for (const key of DISCOVERY_CHARGE_KEYS) this.discovery[key] += charges[key] ?? 0;
    this.discovery[reply.complete && !reply.continuation ? 'publications' : 'continuations']++;
    for (const [sessionId, root] of Object.entries(dispatchRoots ?? {})) {
      const held = this.dispatchRoots.get(sessionId);
      if (!held) {
        this.dispatchRoots.set(sessionId, { ...root });
        continue;
      }
      for (const key of DISPATCH_ROOT_SUMS) held[key] += root[key];
      held.agent = root.agent;
      if (root.size !== null) held.size = root.size;
    }
  }
  private readonly dispatchRoots = new Map<string, DispatchRootCharges>();
  private watcherOperationCount = 0;
  private readonly watcherDecisions: WatcherDecisionCounts = {
    targeted: 0,
    broad: 0,
    walkListedPaths: 0,
    broadReasons: {},
    unknownPathShapes: {},
    unknownPathExtensions: {},
  };
  private readonly rowPosts = new Map<string, RowPostCounts>();
  private rowsGapCount = 0;
  private readonly work = new Map<string, number>();
  private ledgerSaveCount = 0;
  private readonly refreshes = new Map<string, OperationCounts>();
  private readonly refreshStages: Record<RefreshStage, number> = {
    started: 0,
    coalesced: 0,
    unchanged: 0,
    rendered: 0,
    abandoned: 0,
  };
  private readonly messages = new Map<string, MessageCounts>();
  private nextPanelId = 0;
  private readonly panelIds = new WeakMap<object, string>();
  private readonly panelPosts = new Map<string, Map<string, MessageCounts>>();
  private readonly panelMessages = new Map<string, OperationCounts>();
  private readonly panelReplies = new Map<string, Map<string, OperationCounts>>();
  private lastWatcherOperation: WatcherOperation | null = null;
  private lastLedgerSave: LedgerSaveOperation | null = null;
  private startup: { id: number; milestones: Partial<Record<StartupMilestone, number>> } | null = null;

  constructor(
    startedAt = Date.now(),
    sourceIdOrSink: string | PerformanceEventSink = randomUUID(),
    sink: PerformanceEventSink = UNWATCHED,
  ) {
    this.sourceId = typeof sourceIdOrSink === 'string' ? sourceIdOrSink : randomUUID();
    this.sink = typeof sourceIdOrSink === 'string' ? sink : sourceIdOrSink;
    this.startedAt = new Date(startedAt).toISOString();
  }

  recordCapture(): void {
    this.captureCount++;
  }

  recordStartup(milestone: StartupMilestone, at: number): void {
    this.startup ??= { id: 1, milestones: {} };
    // Retain the first occurrence of each startup milestone.
    if (this.startup.milestones[milestone] !== undefined) {
      return;
    }
    this.startup.milestones[milestone] = finiteDuration(at);
    // Emit startup milestones even when detailed events are disabled, so the sink can retain startup history.
    this.sink.emit('startup', { milestone, elapsedMs: Math.round(finiteDuration(at)) });
  }

  recordRefresh(reason: string, durationMs: number): void {
    const duration = finiteDuration(durationMs);
    const current = this.refreshes.get(reason) ?? operationCounts();
    current.count++;
    current.totalDurationMs += duration;
    current.maximumDurationMs = Math.max(current.maximumDurationMs, duration);
    current.lastDurationMs = duration;
    this.refreshes.set(reason, current);
    if (this.sink.enabled()) {
      this.sink.emit('refresh', { reason, durationMs: Math.round(duration) });
    }
  }

  recordRefreshStage(stage: RefreshStage): void {
    this.refreshStages[stage]++;
  }

  registerPanel(panel: object): string {
    return this.panelId(panel);
  }

  releasePanel(panel: object): void {
    const panelId = this.panelIds.get(panel);
    if (!panelId) {
      return;
    }
    this.panelIds.delete(panel);
    this.panelPosts.delete(panelId);
    this.panelReplies.delete(panelId);
  }

  recordMessage(type: string, serializedBytes: number | null, panel?: object): void {
    const current = this.messages.get(type) ?? messageCounts();
    recordMessageCount(current, serializedBytes);
    this.messages.set(type, current);
    // The host passes null for unbudgeted messages to avoid measuring their serialized size.
    if (this.sink.enabled()) {
      this.sink.emit('message', { kind: type, bytes: serializedBytes });
    }
    if (!panel) {
      return;
    }
    const panelId = this.panelId(panel);
    const posts = this.panelPosts.get(panelId) ?? new Map<string, MessageCounts>();
    const panelCount = posts.get(type) ?? messageCounts();
    recordMessageCount(panelCount, serializedBytes);
    posts.set(type, panelCount);
    this.panelPosts.set(panelId, posts);
  }

  recordPanelMessage(type: string, durationMs: number, panel?: object): void {
    const duration = finiteDuration(durationMs);
    const current = this.panelMessages.get(type) ?? operationCounts();
    current.count++;
    current.totalDurationMs += duration;
    current.maximumDurationMs = Math.max(current.maximumDurationMs, duration);
    current.lastDurationMs = duration;
    this.panelMessages.set(type, current);
    if (!panel) {
      return;
    }
    const replies = this.panelReplies.get(this.panelId(panel))!;
    const reply = replies.get(type) ?? operationCounts();
    reply.count++;
    reply.totalDurationMs += duration;
    reply.maximumDurationMs = Math.max(reply.maximumDurationMs, duration);
    reply.lastDurationMs = duration;
    replies.set(type, reply);
  }

  // A row-carrying post, after the sender encoded it. Bytes are the posted message's serialized size.
  recordRowPost(type: string, encoding: RowPostEncoding, serializedBytes: number | null): void {
    const current = this.rowPosts.get(type) ?? rowPostCounts();
    recordMessageCount(encoding.whole ? current.whole : current.delta, serializedBytes);
    if (encoding.reason !== null) {
      current.wholeReasons[encoding.reason] = (current.wholeReasons[encoding.reason] ?? 0) + 1;
    }
    current.rowsHeld = encoding.rowsHeld;
    current.rowsSent += encoding.rowsSent;
    this.rowPosts.set(type, current);
    if (this.sink.enabled()) {
      this.sink.emit('rowPost', { kind: type, ...encoding, bytes: serializedBytes });
    }
  }

  // The panel lost a delta and asked for a snapshot.
  recordRowsGap(): void {
    this.rowsGapCount++;
  }

  // One named host operation ran. The count is the measurement, so no clock is read.
  recordWork(name: string, count = 1): void {
    this.work.set(name, (this.work.get(name) ?? 0) + count);
  }

  // `unknownPaths` holds the shape and extension of each path that decided `unknownPath`. `walkListedPaths` counts the
  // paths that the decision admitted from the last walk.
  recordWatcherOperation(
    operation: Omit<WatcherOperation, 'id'>,
    unknownPaths: readonly { shape: string; extension: string }[] = [],
    walkListedPaths = 0,
  ): void {
    this.watcherOperationCount++;
    this.watcherDecisions[operation.decision]++;
    this.watcherDecisions.walkListedPaths += walkListedPaths;
    for (const reason of operation.broadReasons) {
      this.watcherDecisions.broadReasons[reason] = (this.watcherDecisions.broadReasons[reason] ?? 0) + 1;
    }
    const { unknownPathShapes: shapes, unknownPathExtensions: extensions } = this.watcherDecisions;
    for (const { shape, extension } of unknownPaths) {
      shapes[shape] = (shapes[shape] ?? 0) + 1;
      extensions[extension] = (extensions[extension] ?? 0) + 1;
    }
    this.lastWatcherOperation = { id: this.watcherOperationCount, ...operation };
    if (this.sink.enabled()) {
      this.sink.emit('watcher', { ...this.lastWatcherOperation, durationMs: Math.round(operation.durationMs) });
    }
  }

  recordLedgerSave(operation: Omit<LedgerSaveOperation, 'id'>): void {
    this.ledgerSaveCount++;
    this.lastLedgerSave = { id: this.ledgerSaveCount, ...operation };
  }

  snapshot(): PerformanceCounterSnapshot {
    return {
      discovery: { ...this.discovery },
      sourceId: this.sourceId,
      startedAt: this.startedAt,
      captureCount: this.captureCount,
      refreshes: Object.fromEntries(
        [...this.refreshes].sort(([a], [b]) => a.localeCompare(b)).map(([reason, counts]) => [reason, { ...counts }]),
      ),
      refreshStages: { ...this.refreshStages },
      messages: messageCountSnapshot(this.messages),
      panelPosts: Object.fromEntries(
        [...this.panelPosts]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([panel, posts]) => [panel, messageCountSnapshot(posts)]),
      ),
      panelMessages: Object.fromEntries(
        [...this.panelMessages].sort(([a], [b]) => a.localeCompare(b)).map(([type, counts]) => [type, { ...counts }]),
      ),
      panelReplies: Object.fromEntries(
        [...this.panelReplies]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([panel, replies]) => [
            panel,
            Object.fromEntries(
              [...replies].sort(([a], [b]) => a.localeCompare(b)).map(([type, counts]) => [type, { ...counts }]),
            ),
          ]),
      ),
      watcherOperationCount: this.watcherOperationCount,
      watcherDecisions: {
        targeted: this.watcherDecisions.targeted,
        broad: this.watcherDecisions.broad,
        walkListedPaths: this.watcherDecisions.walkListedPaths,
        broadReasons: { ...this.watcherDecisions.broadReasons },
        unknownPathShapes: { ...this.watcherDecisions.unknownPathShapes },
        unknownPathExtensions: { ...this.watcherDecisions.unknownPathExtensions },
      },
      rowPosts: sortedRecord(this.rowPosts, rowPostSnapshot),
      rowsGapCount: this.rowsGapCount,
      work: sortedRecord(this.work, (count) => count),
      ledgerSaveCount: this.ledgerSaveCount,
      lastWatcherOperation: this.lastWatcherOperation
        ? { ...this.lastWatcherOperation, broadReasons: [...this.lastWatcherOperation.broadReasons] }
        : null,
      lastLedgerSave: this.lastLedgerSave ? { ...this.lastLedgerSave } : null,
      ...(this.startup ? { startup: { id: this.startup.id, milestones: { ...this.startup.milestones } } } : {}),
      dispatchRoots: dispatchRootSnapshot(this.dispatchRoots),
    };
  }

  discoverySnapshot(): PerformanceCounterSnapshot['discovery'] {
    return { ...this.discovery };
  }

  private panelId(panel: object): string {
    const existing = this.panelIds.get(panel);
    if (existing) {
      return existing;
    }
    const panelId = `panel-${++this.nextPanelId}`;
    this.panelIds.set(panel, panelId);
    this.panelPosts.set(panelId, new Map());
    this.panelReplies.set(panelId, new Map());
    return panelId;
  }
}

export interface PerformanceDiagnosticState {
  panel: {
    hostCount: number;
    visibleHostCount: number | { unavailable: string };
    editorPanelOpen: boolean;
    polling: boolean;
    watching: boolean;
    hasSelection: boolean;
    activeChildCount: number;
  };
  rail: {
    listedSessionCount: number | { unavailable: string };
    parsedSessionCount: number;
    rowCount: number;
    pinCount: number;
    archiveCount: number;
    messageType: 'render' | 'rail' | null;
    messageSerializedBytes: number | null;
  };
  cacheBytes: {
    parsedTails: number;
    retainedTails: number;
    olderHistory: number;
    patches: number;
  };
  watcher: {
    pending: boolean;
    queuedEventCount: number;
    distinctPathCount: number;
    broadRequired: boolean;
    oldestPendingWakeAgeMs: number | null;
  };
  ledger: {
    revision: number;
    rebuilding: boolean;
    sourceCount: number;
    completeDisplaySourceCount: number;
    queuedSourceCount: number;
    savePending: boolean;
    oldestPendingCheckpointAgeMs: number | null;
  };
  counters: PerformanceCounterSnapshot;
}

export function projectPerformanceDiagnostics(state: PerformanceDiagnosticState, capturedAt = Date.now()): unknown {
  return {
    schemaVersion: PERFORMANCE_DIAGNOSTICS_SCHEMA_VERSION,
    capturedAt: new Date(capturedAt).toISOString(),
    panel: {
      hostCount: state.panel.hostCount,
      visibleHostCount:
        typeof state.panel.visibleHostCount === 'number'
          ? state.panel.visibleHostCount
          : { unavailable: state.panel.visibleHostCount.unavailable },
      editorPanelOpen: state.panel.editorPanelOpen,
      polling: state.panel.polling,
      watching: state.panel.watching,
      hasSelection: state.panel.hasSelection,
      activeChildCount: state.panel.activeChildCount,
    },
    rail: {
      listedSessionCount:
        typeof state.rail.listedSessionCount === 'number'
          ? state.rail.listedSessionCount
          : { unavailable: state.rail.listedSessionCount.unavailable },
      parsedSessionCount: state.rail.parsedSessionCount,
      rowCount: state.rail.rowCount,
      pinCount: state.rail.pinCount,
      archiveCount: state.rail.archiveCount,
      messageType: state.rail.messageType,
      messageSerializedBytes: state.rail.messageSerializedBytes,
    },
    cacheBytes: {
      parsedTails: state.cacheBytes.parsedTails,
      retainedTails: state.cacheBytes.retainedTails,
      olderHistory: state.cacheBytes.olderHistory,
      patches: state.cacheBytes.patches,
    },
    watcher: {
      pending: state.watcher.pending,
      queuedEventCount: state.watcher.queuedEventCount,
      distinctPathCount: state.watcher.distinctPathCount,
      broadRequired: state.watcher.broadRequired,
      oldestPendingWakeAgeMs: state.watcher.oldestPendingWakeAgeMs,
    },
    ledger: {
      revision: state.ledger.revision,
      rebuilding: state.ledger.rebuilding,
      sourceCount: state.ledger.sourceCount,
      completeDisplaySourceCount: state.ledger.completeDisplaySourceCount,
      queuedSourceCount: state.ledger.queuedSourceCount,
      savePending: state.ledger.savePending,
      oldestPendingCheckpointAgeMs: state.ledger.oldestPendingCheckpointAgeMs,
    },
    counters: {
      sourceId: state.counters.sourceId,
      startedAt: state.counters.startedAt,
      captureCount: state.counters.captureCount,
      refreshes: Object.fromEntries(
        Object.entries(state.counters.refreshes).map(([reason, counts]) => [reason, { ...counts }]),
      ),
      refreshStages: { ...state.counters.refreshStages },
      discovery: { ...state.counters.discovery },
      messages: Object.fromEntries(
        Object.entries(state.counters.messages).map(([type, counts]) => [type, { ...counts }]),
      ),
      panelPosts: Object.fromEntries(
        Object.entries(state.counters.panelPosts).map(([panel, posts]) => [
          panel,
          Object.fromEntries(Object.entries(posts).map(([type, counts]) => [type, { ...counts }])),
        ]),
      ),
      panelMessages: Object.fromEntries(
        Object.entries(state.counters.panelMessages).map(([type, counts]) => [type, { ...counts }]),
      ),
      panelReplies: Object.fromEntries(
        Object.entries(state.counters.panelReplies).map(([panel, replies]) => [
          panel,
          Object.fromEntries(Object.entries(replies).map(([type, counts]) => [type, { ...counts }])),
        ]),
      ),
      watcherOperationCount: state.counters.watcherOperationCount,
      watcherDecisions: {
        targeted: state.counters.watcherDecisions.targeted,
        broad: state.counters.watcherDecisions.broad,
        walkListedPaths: state.counters.watcherDecisions.walkListedPaths,
        broadReasons: { ...state.counters.watcherDecisions.broadReasons },
        unknownPathShapes: { ...state.counters.watcherDecisions.unknownPathShapes },
        unknownPathExtensions: { ...state.counters.watcherDecisions.unknownPathExtensions },
      },
      rowPosts: Object.fromEntries(
        Object.entries(state.counters.rowPosts).map(([type, counts]) => [type, rowPostSnapshot(counts)]),
      ),
      rowsGapCount: state.counters.rowsGapCount,
      work: { ...state.counters.work },
      ledgerSaveCount: state.counters.ledgerSaveCount,
      lastWatcherOperation: state.counters.lastWatcherOperation
        ? {
            ...state.counters.lastWatcherOperation,
            broadReasons: [...state.counters.lastWatcherOperation.broadReasons],
          }
        : null,
      lastLedgerSave: state.counters.lastLedgerSave ? { ...state.counters.lastLedgerSave } : null,
      ...(state.counters.startup
        ? { startup: { id: state.counters.startup.id, milestones: { ...state.counters.startup.milestones } } }
        : {}),
      dispatchRoots: Object.fromEntries(
        Object.entries(state.counters.dispatchRoots).map(([sessionId, root]) => [sessionId, { ...root }]),
      ),
    },
    redaction: {
      paths: 'omitted',
      content:
        'Prompt text, transcript records, tool input, drafts, comments, environment values, command lines, and credentials are omitted.',
    },
  };
}

// Environment variable for the capture directory. Each capture writes a separate timestamped file.
export const PERFORMANCE_DIAGNOSTICS_DIRECTORY_VARIABLE = `${ARC_IDENTITY.environmentPrefix}PERF_OUT_DIR`;

export function performanceDiagnosticsFileName(capturedAt: number): string {
  return `arc-performance-${new Date(capturedAt).toISOString().replace(/[:.]/g, '-')}.json`;
}

export type PerformanceDiagnosticsDestination =
  // An argument names the destination file. The variable selects a timestamped file in its directory.
  // Successful variable-selected captures announce their destination.
  | { kind: 'file'; file: string; source: 'argument' | 'variable' }
  | { kind: 'ask'; suggested: string | null }
  | { kind: 'refuse'; given: string };

export interface PerformanceDiagnosticsTarget {
  target?: string | null;
  environment?: Record<string, string | undefined>;
  workspaceFolder?: string | null;
  capturedAt: number;
}

// Resolve relative paths against the open folder. Refuse them when no folder is open.
function against(folder: string | null, given: string): string | null {
  if (path.isAbsolute(given)) {
    return path.normalize(given);
  }
  return folder ? path.resolve(folder, given) : null;
}

// An explicit file takes precedence over the environment directory. With neither, the reader selects a file.
export function performanceDiagnosticsDestination(
  request: PerformanceDiagnosticsTarget,
): PerformanceDiagnosticsDestination {
  const folder = request.workspaceFolder ?? null;
  const named = (request.target ?? '').trim();
  if (named) {
    const file = against(folder, named);
    return file ? { kind: 'file', file, source: 'argument' } : { kind: 'refuse', given: named };
  }
  const directory = (request.environment?.[PERFORMANCE_DIAGNOSTICS_DIRECTORY_VARIABLE] ?? '').trim();
  if (directory) {
    const root = against(folder, directory);
    if (!root) {
      return { kind: 'refuse', given: directory };
    }
    return {
      kind: 'file',
      file: path.join(root, performanceDiagnosticsFileName(request.capturedAt)),
      source: 'variable',
    };
  }
  const suggested = folder ? path.join(folder, performanceDiagnosticsFileName(request.capturedAt)) : null;
  return { kind: 'ask', suggested };
}

// Failure details include the reader's message and the destination and reason supplied to diagnostic logging.
export interface PerformanceDiagnosticsFailure {
  file: string | null;
  reason: string;
  message: string;
}

export interface PerformanceDiagnosticsSave extends PerformanceDiagnosticsTarget {
  snapshot: unknown;
  ask(suggested: string | null): Promise<string | null>;
  write(file: string, contents: string): Promise<void>;
  report(failure: PerformanceDiagnosticsFailure): void;
  announce(file: string): void;
}

// Return the written path, or null when the dialog closes, the destination is refused, or writing fails.
// Refused destinations and write failures are reported. Closing the dialog leaves no failure report.
// Successful variable-selected captures announce the written path.
export async function savePerformanceDiagnosticsSnapshot(request: PerformanceDiagnosticsSave): Promise<string | null> {
  const destination = performanceDiagnosticsDestination(request);
  if (destination.kind === 'refuse') {
    request.report({
      file: null,
      reason: `a relative destination needs an open folder to be read against: ${destination.given}`,
      message: `Arc cannot save performance diagnostics to ${destination.given}. Open a folder first, or give the full path.`,
    });
    return null;
  }
  const file = destination.kind === 'file' ? destination.file : await request.ask(destination.suggested);
  if (!file) {
    return null;
  }
  try {
    await request.write(file, `${JSON.stringify(request.snapshot, null, 2)}\n`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    request.report({
      file,
      reason,
      message: `Arc could not save performance diagnostics to ${file}. ${reason}`,
    });
    return null;
  }
  if (destination.kind === 'file' && destination.source === 'variable') {
    request.announce(file);
  }
  return file;
}
