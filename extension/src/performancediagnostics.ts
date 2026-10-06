import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { ARC_IDENTITY } from './identity';

export const PERFORMANCE_DIAGNOSTICS_SCHEMA_VERSION = 5;

const MESSAGE_BYTE_BUDGETS: Readonly<Record<string, number>> = {
  render: 250_000,
  rail: 1_100_000,
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
  durationMs: number;
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
  ledgerSaveCount: number;
  lastWatcherOperation: WatcherOperation | null;
  lastLedgerSave: LedgerSaveOperation | null;
  startup?: { id: number; milestones: Partial<Record<StartupMilestone, number>> };
}

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

export class PanelPerformanceCounters {
  readonly sourceId: string;
  private readonly sink: PerformanceEventSink;
  private readonly startedAt: string;
  private captureCount = 0;
  private discovery = {
    readBytes: 0,
    hits: 0,
    resets: 0,
    quanta: 0,
    dispatchRetries: 0,
    continuations: 0,
    publications: 0,
  };
  // A complete reply that still asks for another pass counts as a continuation, so back-to-back passes show in the record.
  recordDiscovery(
    charges: import('./progressiveworker').DiscoveryCharges | undefined,
    reply: { complete: boolean; continuation: boolean },
  ): void {
    if (charges)
      for (const key of ['readBytes', 'hits', 'resets', 'quanta', 'dispatchRetries'] as const)
        this.discovery[key] += charges[key];
    this.discovery[reply.complete && !reply.continuation ? 'publications' : 'continuations']++;
  }
  private watcherOperationCount = 0;
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

  recordWatcherOperation(operation: Omit<WatcherOperation, 'id'>): void {
    this.watcherOperationCount++;
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
      ledgerSaveCount: this.ledgerSaveCount,
      lastWatcherOperation: this.lastWatcherOperation ? { ...this.lastWatcherOperation } : null,
      lastLedgerSave: this.lastLedgerSave ? { ...this.lastLedgerSave } : null,
      ...(this.startup ? { startup: { id: this.startup.id, milestones: { ...this.startup.milestones } } } : {}),
    };
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
      ledgerSaveCount: state.counters.ledgerSaveCount,
      lastWatcherOperation: state.counters.lastWatcherOperation ? { ...state.counters.lastWatcherOperation } : null,
      lastLedgerSave: state.counters.lastLedgerSave ? { ...state.counters.lastLedgerSave } : null,
      ...(state.counters.startup
        ? { startup: { id: state.counters.startup.id, milestones: { ...state.counters.startup.milestones } } }
        : {}),
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
