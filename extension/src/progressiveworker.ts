import { Worker } from 'node:worker_threads';
import { CODEX_META_VERSION } from './codexopenings';
import { brotliDecompressSync } from 'node:zlib';
import { CODEX_TITLE_BYTES, type CodexSessionMeta, type CodexSubagentFile } from './codex';
import type { ClaudeChildReferenceCacheEntry, DerivedTitleEntry } from './derivedcache';
import { HEAD_KEY_BYTES, SESSION_HEAD_BYTES } from './transcript';
import { heldClaudeRepeatedMap } from './clauderepeated';
import type { ClaudeForwardCheckpoint, ClaudeHistoryCursor } from './claudehistory';
import type { CodexForwardCheckpoint, CodexHistoryCursor } from './codexhistory';
import {
  COMMIT_REPOSITORY_REQUEST_BYTES,
  COMMIT_REPOSITORY_SOURCE_BYTES,
  type CommitRepositoryRequest,
  type CommitRepositoryReply,
  type CommitRepositorySource,
} from './codexhistory';
import type {
  AgentRunScan,
  ClaudeChildSessionFile,
  ClaudeChildSessionReference,
  FileRevision,
  SessionFile,
  SessionRead,
  Turn,
  TurnStarts,
} from './transcript';
import type { HistoryPage, HistoryPageOutcome } from './historypages';
import { applyHiddenTurnFields, hiddenTurnFields, type HiddenTurnFields } from './parserstate';

declare const PROGRESSIVE_WORKER_BROTLI: string;

export const INITIAL_RAIL_READ_BYTES = 64 * 1024 * 1024;
export const RAIL_ENRICHMENT_READ_BYTES = 16 * 1024 * 1024;

export function commitRepositorySourceKey(source: CommitRepositorySource): string {
  const { dev, ino, size, mtimeMs } = source.revision;
  return JSON.stringify([source.file, source.sessionId, dev, ino, size, mtimeMs]);
}

// The lifetime allowance of a physical source revision counts the bytes of accepted replies and the full
// admission of every other request. A worker that dies mid-read therefore still spends its admission.
export class CommitRepositoryReservations {
  private readonly reserved = new Map<string, number>();
  private readonly active = new Map<string, Promise<void>>();

  private static key(source: CommitRepositorySource): string {
    const { dev, ino, size, mtimeMs } = source.revision;
    return JSON.stringify([dev, ino, size, mtimeMs]);
  }

  reserve(parent: CommitRepositorySource, child: CommitRepositorySource): { parentBytes: number; childBytes: number } {
    const reserve = (source: CommitRepositorySource, bytes: number) => {
      const key = CommitRepositoryReservations.key(source);
      const held = this.reserved.get(key) ?? 0;
      const admitted = Math.min(bytes, COMMIT_REPOSITORY_SOURCE_BYTES - held);
      this.reserved.set(key, held + admitted);
      return admitted;
    };
    return {
      parentBytes: reserve(parent, COMMIT_REPOSITORY_REQUEST_BYTES / 2),
      childBytes: reserve(child, COMMIT_REPOSITORY_REQUEST_BYTES / 2),
    };
  }

  // Replace the admission of an accepted reply with the bytes its worker read.
  settle(
    parent: CommitRepositorySource,
    child: CommitRepositorySource,
    allowance: { parentBytes: number; childBytes: number },
    readBytes: { parent: number; child: number },
  ): void {
    const settle = (source: CommitRepositorySource, admitted: number, read: number) => {
      const key = CommitRepositoryReservations.key(source);
      this.reserved.set(key, (this.reserved.get(key) ?? 0) - admitted + Math.min(read, admitted));
    };
    settle(parent, allowance.parentBytes, readBytes.parent);
    settle(child, allowance.childBytes, readBytes.child);
  }

  // Wait until no request holds the parent or child revision, then hold both until `release`.
  // Reservations count outstanding admissions as spent, so a concurrent request would receive a short admission.
  // Returns null when the signal aborts before both revisions are free.
  async hold(
    parent: CommitRepositorySource,
    child: CommitRepositorySource,
    signal: AbortSignal,
  ): Promise<(() => void) | null> {
    const keys = [...new Set([parent, child].map(CommitRepositoryReservations.key))];
    for (;;) {
      if (signal.aborted) return null;
      const busy = keys.flatMap((key) => this.active.get(key) ?? []);
      if (!busy.length) break;
      let stop = () => {};
      const aborted = new Promise<void>((resolve) => {
        stop = resolve;
        signal.addEventListener('abort', stop, { once: true });
      });
      await Promise.race([Promise.all(busy), aborted]);
      signal.removeEventListener('abort', stop);
    }
    let release = () => {};
    const done = new Promise<void>((resolve) => (release = resolve));
    for (const key of keys) this.active.set(key, done);
    return () => {
      for (const key of keys) if (this.active.get(key) === done) this.active.delete(key);
      release();
    };
  }

  bytes(source: CommitRepositorySource): number {
    return this.reserved.get(CommitRepositoryReservations.key(source)) ?? 0;
  }
}

// Charge the metadata budget from the catalog's listed file size.
// The worker checks the revision again before reading.
// Growth after listing can increase the read beyond the charge.
// This budget limits catalog admission, not total disk bytes.
// Reads use the current revision so the tail includes its latest records.
export function metadataReadBudget(session: Pick<SessionFile, 'agent' | 'size'>, tailBytes = 256 * 1024): number {
  return (
    Math.min(session.size, tailBytes) +
    (session.agent === 'codex' ? Math.min(session.size, CODEX_TITLE_BYTES) : 0) +
    (session.agent === 'claude' && session.size > tailBytes ? SESSION_HEAD_BYTES : 0)
  );
}

// Return unused Claude head bytes to the metadata budget.
// Recorded titles need only a head fingerprint, rather than the first-prompt window.
// The budget reserves the larger window until the read identifies the title source.
export function unreadHeadBytes(
  session: Pick<SessionFile, 'agent' | 'size'>,
  entry: Pick<DerivedTitleEntry, 'nameSource'>,
  tailBytes = 256 * 1024,
): number {
  const recorded = entry.nameSource === 'custom' || entry.nameSource === 'generated';
  if (!recorded || session.agent !== 'claude' || session.size <= tailBytes) {
    return 0;
  }
  return SESSION_HEAD_BYTES - HEAD_KEY_BYTES;
}

export type ProgressiveCheckpoint = ClaudeForwardCheckpoint | CodexForwardCheckpoint;
export type ProgressiveCursor = ClaudeHistoryCursor | CodexHistoryCursor;
export interface ProgressiveInput {
  session: SessionFile;
  folders: string[];
  children: CodexSubagentFile[];
  claudeChildren?: ClaudeChildSessionFile[];
  claudeChildReferences?: ClaudeChildSessionReference[];
  maxTurns: number;
  tailBytes: number;
  // Host-supplied clock for child activity and its cache key.
  // The worker otherwise reads the clock once per request.
  spendNow?: number;
}
export interface DispatchSessionFacts {
  sessionId: string;
  refreshAt: number | null;
  revision: FileRevision;
  spend: import('./agentspend').AgentSpend;
  startedAt: number | null;
  endedAt: number | null;
  toolUses: number;
  // Whether the session's own records establish reader input.
  person: boolean;
}
export interface DiscoveryCheckpoint {
  compatibility?: string;
  spendSources?: {
    claude: import('./projectspend').SessionSpendSource[];
    codex: { file: string }[];
    children: CodexSubagentFile[];
  };
  epoch?: string;
  parserVersion?: number;
  parents: SessionFile[];
  catalog: SessionFile[];
  repositoryRoots: string[];
  completed: string[];
  position: number;
  sequence: number;
  protectedFile?: string;
}

const DISCOVERY_ENVELOPE_VERSION = 1;
// Bump when persisted membership or spend-source admission changes.
const DISCOVERY_ADMISSION_VERSION = 2;

export function discoveryCompatibility(relationshipVersion: number): string {
  return JSON.stringify([
    DISCOVERY_ENVELOPE_VERSION,
    relationshipVersion,
    DISCOVERY_ADMISSION_VERSION,
    CODEX_META_VERSION,
  ]);
}

export function compatibleDiscovery(
  value: DiscoveryCheckpoint | undefined,
  relationshipVersion: number,
  roots?: readonly string[],
): boolean {
  return (
    !!value &&
    value.compatibility === discoveryCompatibility(relationshipVersion) &&
    value.parserVersion === relationshipVersion &&
    (roots === undefined || JSON.stringify(value.repositoryRoots) === JSON.stringify(roots))
  );
}
// Validates persisted scheduling before a reader exposes catalog or spend-source fields.
export function validDiscoveryCheckpoint(value: unknown): value is DiscoveryCheckpoint {
  const record = (row: unknown): row is Record<string, any> => !!row && typeof row === 'object' && !Array.isArray(row);
  const nonEmptyText = (row: unknown): row is string => typeof row === 'string' && row.length > 0;
  const fileName = nonEmptyText;
  const nonNegative = (row: unknown): row is number => typeof row === 'number' && Number.isFinite(row) && row >= 0;
  return (
    record(value) &&
    (value.epoch === undefined || nonEmptyText(value.epoch)) &&
    (value.parserVersion === undefined || nonNegative(value.parserVersion)) &&
    (value.spendSources === undefined ||
      (record(value.spendSources) &&
        Array.isArray(value.spendSources.claude) &&
        value.spendSources.claude.every(
          (source: unknown) =>
            record(source) &&
            fileName(source.file) &&
            nonEmptyText(source.sessionId) &&
            (source.primary === undefined || typeof source.primary === 'boolean') &&
            (source.nativeParentFile === undefined || fileName(source.nativeParentFile)) &&
            (source.dispatchedFrom === undefined || nonEmptyText(source.dispatchedFrom)),
        ) &&
        Array.isArray(value.spendSources.codex) &&
        value.spendSources.codex.every((source: unknown) => record(source) && fileName(source.file)) &&
        Array.isArray(value.spendSources.children) &&
        value.spendSources.children.every(
          (child: unknown) =>
            record(child) &&
            fileName(child.file) &&
            nonEmptyText(child.threadId) &&
            (child.parentThreadId === null || nonEmptyText(child.parentThreadId)) &&
            (child.agentPath === null || typeof child.agentPath === 'string') &&
            (child.openedAt === null || nonNegative(child.openedAt)) &&
            (child.startedAt === null || nonNegative(child.startedAt)) &&
            (child.threadSource === null || typeof child.threadSource === 'string') &&
            typeof child.backgroundReview === 'boolean',
        ))) &&
    Array.isArray(value.parents) &&
    Array.isArray(value.catalog) &&
    Array.isArray(value.repositoryRoots) &&
    value.repositoryRoots.every(fileName) &&
    Array.isArray(value.completed) &&
    value.completed.every(fileName) &&
    nonNegative(value.position) &&
    nonNegative(value.sequence) &&
    (value.protectedFile === undefined || fileName(value.protectedFile)) &&
    [...value.parents, ...value.catalog].every(
      (row: unknown) =>
        record(row) &&
        fileName(row.file) &&
        nonEmptyText(row.sessionId) &&
        (row.agent === 'claude' || row.agent === 'codex') &&
        nonNegative(row.size) &&
        nonNegative(row.mtimeMs),
    )
  );
}

// `readBytes` counts transcript and receipt relationship bytes. Receipt bytes also have a separate subtotal.
// `revalidationBytes` is the subtotal that re-hashes a transcript prefix an earlier scan read.
// A parent check counts every stat of a candidate source. A file count names each file once per measured pass.
// The dispatch visit count includes sessions whose held facts read nothing. The reread count excludes them.
// Times are wall milliseconds.
export interface DiscoveryCharges extends Record<import('./codex').CodexDispatchSpendProgress, number> {
  readBytes: number;
  receiptEntries?: number;
  receiptChecks?: number;
  receiptBytes?: number;
  revalidationBytes?: number;
  hits: number;
  resets: number;
  quanta: number;
  dispatchRetries: number;
  parentChecks: number;
  parentCheckMs: number;
  childHeadFiles: number;
  childHeadBytes: number;
  childHeadMs: number;
  dispatchSpendVisits: number;
  dispatchSpendRereads: number;
  dispatchSpendFiles: number;
  dispatchSpendBytes: number;
  dispatchSpendMs: number;
  // The dispatched window's bytes by reader. Its other reads, such as subagent metadata, make up the rest of dispatchSpendBytes.
  dispatchPersonBytes: number;
  dispatchAggregateBytes: number;
  dispatchClaudeSpendBytes: number;
  // The pass budget left after each Codex aggregate that read and stopped unfinished, summed over the stops in the exhaustion fields.
  dispatchAggregateRemainingBytes: number;
  dispatchAggregateRemainingMs: number;
  // The worker's time for the request, and the read whose limit ended a pass before the dispatched window.
  passMs: number;
  transcriptPassEnds: number;
  receiptPassEnds: number;
  otherPassEnds: number;
}
// One verified child transcript whose recorded edits a file action needs.
// The revision is the child's spend file version, the same revision its summary figures carry.
// A Codex source also names the thread and parent thread its catalog entry proved, which the opening record read must repeat.
export type ChildEditSource =
  | { agent: 'claude'; file: string; revision: string }
  | { agent: 'codex'; file: string; revision: string; threadId: string; parentThreadId: string | null };

// One requested file's recorded edits in a child transcript, in record order, keyed as the child summary keys its files.
// The span covers the child turns that edited the file.
export interface ChildFileEdits {
  key: string;
  edits: import('./transcript').EditRecord[];
  startedAt?: number;
  endedAt?: number;
}

// The largest child transcript a file action reads, the same bound as one whole-file rail read.
export const CHILD_EDIT_READ_BYTES = INITIAL_RAIL_READ_BYTES;

export type ProgressiveRequest =
  | { kind: 'codex-context'; session: SessionFile }
  | { kind: 'child-file-edits'; source: ChildEditSource; keys: string[]; folders: string[] }
  | ({ kind: 'commit-repositories' } & CommitRepositoryRequest)
  | {
      kind: 'claude-children';
      parents: SessionFile[];
      catalog?: SessionFile[];
      codexChildren?: import('./codex').CodexSubagentFile[];
      repositoryRoots: string[];
      referenceEntries?: Array<[string, ClaudeChildReferenceCacheEntry]>;
      discovery?: DiscoveryCheckpoint;
      discoveryBytes?: number;
      quantumBytes?: number;
    }
  | { kind: 'metadata'; session: SessionFile; opening?: CodexSessionMeta | null; tailBytes?: number }
  | {
      kind: 'metadata-recovery';
      session: SessionFile;
      opening?: CodexSessionMeta | null;
      sliceBytes: number;
      eligible: string[];
      retainedBytes?: number;
      recordBytes?: number;
      reduceAboveBytes?: number;
    }
  | { kind: 'starts'; session: SessionFile; agentRunScan?: AgentRunScan }
  | { kind: 'window'; input: ProgressiveInput; checkpoint?: ProgressiveCheckpoint }
  | {
      kind: 'retained';
      input: ProgressiveInput;
      pages: HistoryPage[];
      structuralAgentIds?: readonly string[];
      hidden?: HiddenTurnFields[];
      // True when the last page is the newest window, so no later turn follows its last turn.
      endsAtNewest?: boolean;
    }
  | { kind: 'page'; input: ProgressiveInput; cursor: ProgressiveCursor | null };
export type ProgressiveValue =
  | { kind: 'codex-context'; estimate: import('./codexcontext').CodexContextResult | null }
  | {
      kind: 'child-file-edits';
      // `stale` means the child transcript changed from the requested revision before or during the read,
      // or a Codex record names a thread or parent other than the requested ones. `unreadable` means the read failed partway.
      status: 'complete' | 'stale' | 'too-large' | 'unreadable' | 'cancelled';
      source: ChildEditSource;
      files: ChildFileEdits[];
    }
  | ({ kind: 'commit-repositories' } & CommitRepositoryReply)
  | {
      kind: 'claude-children';
      compatibility?: string;
      references: ClaudeChildSessionReference[];
      children: ClaudeChildSessionFile[];
      referenceEntries: Array<[string, ClaudeChildReferenceCacheEntry]>;
      dispatchFacts: DispatchSessionFacts[];
      complete: boolean;
      continuation: boolean;
      charges?: DiscoveryCharges;
      roots?: SessionFile[];
      scope?: string[];
      checkpoint?: DiscoveryCheckpoint;
    }
  | {
      kind: 'claude-children-delta';
      referenceEntries: Array<[string, ClaudeChildReferenceCacheEntry]>;
      checkpoint?: DiscoveryCheckpoint;
      epoch: string;
      parserVersion: number;
      sequence: number;
      position: number;
      protectedFile?: string;
      completed: Array<[string, boolean]>;
      continuation: true;
      charges: DiscoveryCharges;
    }
  | {
      kind: 'claude-children-progress';
      referenceEntries: Array<[string, ClaudeChildReferenceCacheEntry]>;
      checkpoint: DiscoveryCheckpoint;
      continuation: true;
      charges: DiscoveryCharges;
    }
  | { kind: 'metadata'; entry: DerivedTitleEntry; coverage?: import('./transcript').MetadataCoverage }
  | {
      kind: 'metadata-recovery';
      status: 'pending' | 'complete' | 'exhausted';
      readBytes: number;
      through: number;
      read?: SessionRead;
      reset?: boolean;
    }
  | { kind: 'starts'; starts: TurnStarts; agentRunScan?: AgentRunScan }
  | {
      kind: 'window';
      read: SessionRead;
      checkpoint: ProgressiveCheckpoint;
      reset: boolean;
      appendFrom: FileRevision | null;
      readBytes: number;
      recoveryBytes?: number;
      recoveryPending?: boolean;
      retainedBytes: number;
      checkpointBytes: number;
      agentKey: string;
      structuralKey: string;
      structuralAgentIds?: readonly string[];
    }
  | { kind: 'page'; page: HistoryPageOutcome<ProgressiveCursor>; recoveryBytes?: number }
  | { kind: 'retained'; pages: HistoryPage[] }
  // `unread` marks a request the worker refused before it opened the source.
  | { kind: 'stale'; agentRunScan?: AgentRunScan; recoveryBytes?: number; unread?: true };
export interface ProgressiveResult {
  generation: number;
  revision: FileRevision | null;
  value: ProgressiveValue;
  workerMemory?: WorkerMemory;
}

export interface WorkerMemory {
  heapUsed: number;
  heapTotal: number;
  heapLimit: number;
  external: number;
}

// Result order also indexes the hidden activity fields carried beside structured-cloned turns.
export function progressiveTurns(value: ProgressiveValue): readonly Turn[] {
  if (value.kind === 'window') return value.read.turns;
  if (value.kind === 'metadata-recovery') return value.read?.turns ?? [];
  if (value.kind === 'page' && value.page.kind === 'page') return value.page.turns;
  if (value.kind === 'retained') return value.pages.flatMap((page) => page.turns);
  return [];
}

export function sameProgressiveRevision(
  left: FileRevision,
  right: Pick<SessionFile, 'mtimeMs' | 'size'> & Partial<Pick<FileRevision, 'dev' | 'ino'>>,
): boolean {
  return (
    left.mtimeMs === right.mtimeMs &&
    left.size === right.size &&
    (right.dev === undefined || left.dev === right.dev) &&
    (right.ino === undefined || left.ino === right.ino)
  );
}

export function acceptsProgressiveResult(
  result: ProgressiveResult,
  generation: number,
  revision: Pick<SessionFile, 'mtimeMs' | 'size'> & Partial<Pick<FileRevision, 'dev' | 'ino'>>,
): boolean {
  return (
    result.generation === generation && result.revision !== null && sameProgressiveRevision(result.revision, revision)
  );
}

export function preservesLoadedHistory(previousRevision: FileRevision, result: ProgressiveResult): boolean {
  return (
    result.revision !== null &&
    result.value.kind === 'window' &&
    (sameProgressiveRevision(result.revision, previousRevision) ||
      (result.value.appendFrom !== null && sameProgressiveRevision(result.value.appendFrom, previousRevision)))
  );
}

export interface WorkerFailure {
  role: 'session-reader';
  threadId: number | null;
  reason: 'request' | 'error' | 'exit';
  name: string;
  code: string | null;
  exitCode: number | null;
  pendingCount: number;
  active: WorkerRequestObservation[];
  memory: {
    scope: 'session-reader worker thread';
    threadId: number | null;
    requestId: number | null;
    observed: WorkerMemory | null;
    ageSinceReceiptMs: number | null;
  };
}

interface WorkerRequestObservation {
  id: number;
  generation: number;
  kind: ProgressiveRequest['kind'];
  ageMs: number;
  status: 'pending';
  // Window requests only. Host milliseconds from the request until the worker's start acknowledgment arrived.
  enteredAfterMs?: number | null;
}

// Durations on the worker thread's monotonic clock. `enterMs` runs from receipt to the read start, including the revision check.
// `readMs` is the wall interval of the read. Work counted in `during` interleaves with it, so it is not the read's own CPU time.
// `replyMs` runs from the last earlier stage to the reply post and excludes structured cloning.
export interface WorkerWindowRead {
  enterMs: number | null;
  readMs: number | null;
  replyMs: number;
  // Other requests in progress on the worker when the read arrived, by kind.
  atReceipt: Partial<Record<ProgressiveRequest['kind'], number>>;
  discoveryWaiting: boolean;
  // Counts of other worker events between receipt and reply.
  during: {
    received: Partial<Record<ProgressiveRequest['kind'], number>>;
    finished: Partial<Record<ProgressiveRequest['kind'], number>>;
    discoveryProgress: number;
    repeatedCoverage: number;
  };
}

export interface WindowReadObservation {
  id: number;
  generation: number;
  agent: SessionFile['agent'];
  outcome: 'window' | 'stale' | 'error' | 'superseded' | 'cancelled' | 'stopped' | 'failed';
  // Host milliseconds from the request until its settlement. Host and worker clocks share no origin, so only durations leave either side.
  hostMs: number;
  enteredAfterMs: number | null;
  worker: WorkerWindowRead | null;
}

const RECENT_WINDOW_READS = 4;

export function workerErrorIdentity(error: unknown): { name: string; code: string | null } {
  const value = error && typeof error === 'object' ? (error as { name?: unknown; code?: unknown }) : {};
  const identifier = (part: unknown) =>
    typeof part === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(part) ? part : null;
  return { name: identifier(value.name) ?? 'Error', code: identifier(value.code) };
}

/** One execution boundary. The provider owns checkpoints and admitted pages. */
export class ProgressiveWorker {
  readonly transport = { requests: 0, replies: 0, postMs: 0, jsonMs: 0, requestJsonBytes: 0, replyJsonBytes: 0 };
  private worker: Worker | null = null;
  private dispatchSpends = new Map<string, { entry: import('./codex').CodexDispatchSpendEntry; bytes: number }>();
  private dispatchSpendBytes = 0;
  private dispatchSeedThread: number | null = null;
  private nextId = 0;
  private discoveryActive = false;
  private discoveryWaiter?: { start(): void; cancel(): void };
  private state: 'idle' | 'running' | 'cancelled' | 'failed' = 'idle';
  private lastFailure: WorkerFailure | null = null;
  private workerMemory: WorkerMemory | null = null;
  private workerMemoryAt = 0;
  private workerThreadId: number | null = null;
  private workerMemoryThreadId: number | null = null;
  private workerMemoryRequestId: number | null = null;
  private recentWindows: WindowReadObservation[] = [];
  private pending = new Map<
    number,
    {
      generation: number;
      kind: ProgressiveRequest['kind'];
      started: number;
      window?: { agent: SessionFile['agent']; entered: number | null };
      resolve(value: ProgressiveResult | null): void;
      reject(error: Error): void;
      dispose(): void;
      progress?(value: ProgressiveResult): void;
    }
  >();

  constructor(
    private readonly source?: string,
    private readonly measureJson: () => boolean = () => false,
    // Hears each file whose repeated-record map in the worker reaches the end of the file.
    private readonly onRepeatedCoverage?: (file: string) => void,
    private readonly onFailure?: (failure: WorkerFailure) => void,
  ) {}

  snapshot(): {
    role: 'session-reader';
    threadId: number | null;
    state: 'idle' | 'running' | 'cancelled' | 'failed';
    pendingCount: number;
    waitingDiscovery: boolean;
    active: WorkerRequestObservation[];
    recentWindows: WindowReadObservation[];
    lastFailure: WorkerFailure | null;
    memory: WorkerFailure['memory'];
  } {
    const active: WorkerRequestObservation[] = [];
    const now = performance.now();
    for (const [id, held] of this.pending) {
      active.push({
        id,
        generation: held.generation,
        kind: held.kind,
        ageMs: Math.max(0, now - held.started),
        status: 'pending',
        ...(held.window
          ? { enteredAfterMs: held.window.entered === null ? null : held.window.entered - held.started }
          : {}),
      });
      if (active.length === 8) break;
    }
    return {
      role: 'session-reader',
      threadId: this.worker ? this.workerThreadId : null,
      state: this.state,
      pendingCount: this.pending.size,
      waitingDiscovery: !!this.discoveryWaiter,
      active,
      recentWindows: [...this.recentWindows],
      lastFailure: this.lastFailure,
      memory: {
        scope: 'session-reader worker thread',
        threadId: this.workerMemoryThreadId,
        requestId: this.workerMemoryRequestId,
        observed: this.workerMemory,
        ageSinceReceiptMs: this.workerMemory ? Math.max(0, now - this.workerMemoryAt) : null,
      },
    };
  }

  private settleWindow(
    id: number,
    held: { generation: number; started: number; window?: { agent: SessionFile['agent']; entered: number | null } },
    outcome: WindowReadObservation['outcome'],
    worker: WorkerWindowRead | null = null,
  ): void {
    if (!held.window) return;
    this.recentWindows.push({
      id,
      generation: held.generation,
      agent: held.window.agent,
      outcome,
      hostMs: performance.now() - held.started,
      enteredAfterMs: held.window.entered === null ? null : held.window.entered - held.started,
      worker,
    });
    if (this.recentWindows.length > RECENT_WINDOW_READS) this.recentWindows.shift();
  }

  private failure(reason: WorkerFailure['reason'], error: unknown, exitCode: number | null = null): WorkerFailure {
    const { role, threadId, active, pendingCount, memory } = this.snapshot();
    const failure = { role, threadId, reason, ...workerErrorIdentity(error), exitCode, active, pendingCount, memory };
    this.lastFailure = failure;
    this.onFailure?.(failure);
    return failure;
  }

  private countTransport(value: unknown, reply: boolean): void {
    this.transport[reply ? 'replies' : 'requests']++;
    if (!this.measureJson()) return;
    const started = performance.now();
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    this.transport.jsonMs += performance.now() - started;
    this.transport[reply ? 'replyJsonBytes' : 'requestJsonBytes'] += bytes;
  }

  retainMetadataRecovery(sessionIds: string[]): void {
    this.worker?.postMessage({ metadataEligible: sessionIds });
  }

  run(
    request: ProgressiveRequest,
    generation: number,
    signal: AbortSignal,
    progress?: (value: ProgressiveResult) => void,
  ): Promise<ProgressiveResult | null> {
    if (request.kind !== 'claude-children') return this.runAdmitted(request, generation, signal, progress);
    if (signal.aborted) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const start = () => {
        signal.removeEventListener('abort', cancel);
        this.discoveryActive = true;
        void this.runAdmitted(request, generation, signal, progress)
          .then(resolve, reject)
          .finally(() => {
            this.discoveryActive = false;
            const waiting = this.discoveryWaiter;
            this.discoveryWaiter = undefined;
            waiting?.start();
          });
      };
      const cancel = () => {
        signal.removeEventListener('abort', cancel);
        if (this.discoveryWaiter === waiting) this.discoveryWaiter = undefined;
        resolve(null);
      };
      const waiting = { start, cancel };
      if (this.discoveryActive) {
        this.discoveryWaiter?.cancel();
        this.discoveryWaiter = waiting;
        signal.addEventListener('abort', cancel, { once: true });
      } else start();
    });
  }

  private runAdmitted(
    request: ProgressiveRequest,
    generation: number,
    signal: AbortSignal,
    progress?: (value: ProgressiveResult) => void,
  ): Promise<ProgressiveResult | null> {
    if (signal.aborted) {
      return Promise.resolve(null);
    }
    if (!this.worker) {
      let worker: Worker;
      try {
        const source =
          this.source ?? brotliDecompressSync(Buffer.from(PROGRESSIVE_WORKER_BROTLI, 'base64')).toString('utf8');
        worker = new Worker(source, { eval: true, name: 'arc-session-reader' });
      } catch (error) {
        this.state = 'failed';
        this.failure('error', error);
        return Promise.reject(error);
      }
      this.worker = worker;
      this.workerThreadId = worker.threadId;
      this.workerMemory = null;
      this.workerMemoryThreadId = null;
      this.workerMemoryRequestId = null;
      this.state = 'running';
      let terminalFailure: WorkerFailure | null = null;
      worker.on(
        'message',
        (message: {
          id: number;
          result?: ProgressiveResult;
          hidden?: { turns: HiddenTurnFields[]; redefinesDetail: boolean };
          error?: { name: string; code: string | null };
          progress?: boolean;
          windowEntered?: boolean;
          windowRead?: WorkerWindowRead;
          repeatedCoverage?: string;
          dispatchSpend?: [string, import('./codex').CodexDispatchSpendEntry];
        }) => {
          if (message.dispatchSpend) {
            if (this.worker !== worker) return;
            const [file, entry] = message.dispatchSpend;
            const bytes = Buffer.byteLength(JSON.stringify(entry));
            this.dispatchSpendBytes -= this.dispatchSpends.get(file)?.bytes ?? 0;
            this.dispatchSpends.delete(file);
            if (bytes <= 32 * 1024 * 1024) {
              this.dispatchSpends.set(file, { entry, bytes });
              this.dispatchSpendBytes += bytes;
            }
            while (this.dispatchSpendBytes > 32 * 1024 * 1024 || this.dispatchSpends.size > 200) {
              const oldest = this.dispatchSpends.keys().next().value!;
              this.dispatchSpendBytes -= this.dispatchSpends.get(oldest)!.bytes;
              this.dispatchSpends.delete(oldest);
            }
            return;
          }
          if (message.repeatedCoverage !== undefined) {
            if (this.worker === worker) this.onRepeatedCoverage?.(message.repeatedCoverage);
            return;
          }
          const held = this.pending.get(message.id);
          if (!held || this.worker !== worker) {
            return;
          }
          if (message.windowEntered) {
            if (held.window) held.window.entered = performance.now();
            return;
          }
          if (message.result && message.result.generation !== held.generation) {
            if (!message.progress) {
              this.settleWindow(message.id, held, 'superseded', message.windowRead);
              this.pending.delete(message.id);
              held.dispose();
              held.resolve(null);
            }
            return;
          }
          this.countTransport(message, true);
          const memory = message.result?.workerMemory;
          if (memory) {
            this.workerMemory = {
              heapUsed: memory.heapUsed,
              heapTotal: memory.heapTotal,
              heapLimit: memory.heapLimit,
              external: memory.external,
            };
            this.workerMemoryAt = performance.now();
            this.workerMemoryThreadId = this.workerThreadId;
            this.workerMemoryRequestId = message.id;
          }
          if (message.progress) {
            if (message.result) held.progress?.(message.result);
            return;
          }
          if (message.error) this.failure('request', message.error);
          this.settleWindow(
            message.id,
            held,
            message.error ? 'error' : message.result?.value.kind === 'window' ? 'window' : 'stale',
            message.windowRead,
          );
          this.pending.delete(message.id);
          held.dispose();
          if (message.error) {
            held.reject(Object.assign(new Error('Session reading failed.'), workerErrorIdentity(message.error)));
          } else {
            if (message.result && message.hidden) {
              const hidden = message.hidden;
              progressiveTurns(message.result.value).forEach((turn, index) =>
                applyHiddenTurnFields(turn, hidden.turns[index], hidden.redefinesDetail),
              );
            }
            held.resolve(message.result ?? null);
          }
        },
      );
      worker.on('error', (error) => {
        if (this.worker !== worker) {
          return;
        }
        this.state = 'failed';
        terminalFailure = this.failure('error', error);
        for (const [id, held] of this.pending) {
          this.settleWindow(id, held, 'failed');
          held.dispose();
          held.reject(error);
        }
        this.pending.clear();
        if (this.worker === worker) {
          this.worker = null;
        }
      });
      worker.on('exit', (exitCode) => {
        if (terminalFailure) {
          terminalFailure.exitCode = exitCode;
          this.onFailure?.(terminalFailure);
          return;
        }
        if (this.worker !== worker) {
          return;
        }
        if (exitCode !== 0 || this.pending.size) {
          this.state = 'failed';
          this.failure('exit', { name: 'WorkerExit' }, exitCode);
        } else this.state = 'idle';
        this.worker = null;
        for (const [id, held] of this.pending) {
          this.settleWindow(id, held, 'failed');
          held.dispose();
          held.resolve(null);
        }
        this.pending.clear();
      });
    }
    if (this.dispatchSpends.size && this.worker && this.worker.threadId !== this.dispatchSeedThread) {
      this.worker.postMessage({
        dispatchSpendEntries: [...this.dispatchSpends].map(([file, held]) => [file, held.entry]),
      });
    }
    this.dispatchSeedThread = this.worker?.threadId ?? null;
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const abort = () => {
        const held = this.pending.get(id);
        if (!held) {
          return;
        }
        this.settleWindow(id, held, 'cancelled');
        this.pending.delete(id);
        held.dispose();
        held.resolve(null);
        this.worker?.postMessage({ cancel: id });
        if (!this.pending.size && !this.discoveryWaiter) {
          this.stop();
        }
      };
      signal.addEventListener('abort', abort, { once: true });
      this.pending.set(id, {
        generation,
        kind: request.kind,
        started: performance.now(),
        ...(request.kind === 'window' ? { window: { agent: request.input.session.agent, entered: null } } : {}),
        resolve,
        reject,
        progress,
        dispose: () => signal.removeEventListener('abort', abort),
      });
      // The worker starts from the repeated-record map this process holds for a Claude transcript, so its
      // bounded reads skip repeated records without reading the file again.
      const session = 'session' in request ? request.session : 'input' in request ? request.input.session : null;
      const map = session?.agent === 'claude' ? heldClaudeRepeatedMap(session.file) : null;
      const repeated = map && session ? { file: session.file, map } : undefined;
      const transported =
        request.kind === 'retained'
          ? { ...request, hidden: request.pages.flatMap((page) => page.turns).map(hiddenTurnFields) }
          : request;
      const message = { id, generation, request: transported, repeated };
      this.countTransport(message, false);
      const started = performance.now();
      try {
        this.worker!.postMessage(message);
      } catch (error) {
        this.failure('request', error);
        const held = this.pending.get(id);
        if (held) this.settleWindow(id, held, 'failed');
        this.pending.delete(id);
        signal.removeEventListener('abort', abort);
        reject(error);
      }
      this.transport.postMs += performance.now() - started;
    });
  }

  stop(): void {
    this.state = 'cancelled';
    this.discoveryWaiter?.cancel();
    this.discoveryWaiter = undefined;
    const worker = this.worker;
    this.worker = null;
    void worker?.terminate();
    for (const [id, held] of this.pending) {
      this.settleWindow(id, held, 'stopped');
      held.dispose();
      held.resolve(null);
    }
    this.pending.clear();
  }
}
