import { Worker } from 'node:worker_threads';
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
  TurnStarts,
} from './transcript';
import type { HistoryPage, HistoryPageOutcome } from './historypages';

declare const PROGRESSIVE_WORKER_BROTLI: string;

export const INITIAL_RAIL_READ_BYTES = 64 * 1024 * 1024;
export const RAIL_ENRICHMENT_READ_BYTES = 16 * 1024 * 1024;

export function commitRepositorySourceKey(source: CommitRepositorySource): string {
  const { dev, ino, size, mtimeMs } = source.revision;
  return JSON.stringify([source.file, source.sessionId, dev, ino, size, mtimeMs]);
}

export class CommitRepositoryReservations {
  private readonly reserved = new Map<string, number>();

  reserve(
    parent: CommitRepositorySource,
    child: CommitRepositorySource,
    parentComplete = false,
  ): { parentBytes: number; childBytes: number } {
    const reserve = (source: CommitRepositorySource, bytes: number) => {
      const { dev, ino, size, mtimeMs } = source.revision;
      const key = JSON.stringify([dev, ino, size, mtimeMs]);
      const held = this.reserved.get(key) ?? 0;
      const admitted = Math.min(bytes, COMMIT_REPOSITORY_SOURCE_BYTES - held);
      this.reserved.set(key, held + admitted);
      return admitted;
    };
    return {
      parentBytes: reserve(parent, parentComplete ? 0 : COMMIT_REPOSITORY_REQUEST_BYTES / 2),
      childBytes: reserve(child, COMMIT_REPOSITORY_REQUEST_BYTES / 2),
    };
  }

  bytes(source: CommitRepositorySource): number {
    const { dev, ino, size, mtimeMs } = source.revision;
    return this.reserved.get(JSON.stringify([dev, ino, size, mtimeMs])) ?? 0;
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
// `readBytes` counts relationship scan bytes and bounds each request, so the other relationship file work has its own fields.
// A parent check counts every stat of a candidate source. A file count names each file once per measured pass.
// The dispatch visit count includes sessions whose held facts read nothing. The reread count excludes them.
// Times are wall milliseconds.
export interface DiscoveryCharges {
  readBytes: number;
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
}
export type ProgressiveRequest =
  | { kind: 'codex-context'; session: SessionFile }
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
  | { kind: 'retained'; input: ProgressiveInput; pages: HistoryPage[]; structuralAgentIds?: readonly string[] }
  | { kind: 'page'; input: ProgressiveInput; cursor: ProgressiveCursor | null };
export type ProgressiveValue =
  | { kind: 'codex-context'; estimate: import('./codexcontext').CodexContextResult | null }
  | ({ kind: 'commit-repositories' } & CommitRepositoryReply)
  | {
      kind: 'claude-children';
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
  | { kind: 'stale'; agentRunScan?: AgentRunScan; recoveryBytes?: number };
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
}

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
  private pending = new Map<
    number,
    {
      generation: number;
      kind: ProgressiveRequest['kind'];
      started: number;
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
          error?: { name: string; code: string | null };
          progress?: boolean;
          repeatedCoverage?: string;
        }) => {
          if (message.repeatedCoverage !== undefined) {
            if (this.worker === worker) this.onRepeatedCoverage?.(message.repeatedCoverage);
            return;
          }
          const held = this.pending.get(message.id);
          if (!held || this.worker !== worker) {
            return;
          }
          if (message.result && message.result.generation !== held.generation) {
            if (!message.progress) {
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
          this.pending.delete(message.id);
          held.dispose();
          if (message.error) {
            held.reject(Object.assign(new Error('Session reading failed.'), workerErrorIdentity(message.error)));
          } else {
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
        for (const held of this.pending.values()) {
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
        for (const held of this.pending.values()) {
          held.dispose();
          held.resolve(null);
        }
        this.pending.clear();
      });
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const abort = () => {
        const held = this.pending.get(id);
        if (!held) {
          return;
        }
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
      const message = { id, generation, request, repeated };
      this.countTransport(message, false);
      const started = performance.now();
      try {
        this.worker!.postMessage(message);
      } catch (error) {
        this.failure('request', error);
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
    for (const held of this.pending.values()) {
      held.dispose();
      held.resolve(null);
    }
    this.pending.clear();
  }
}
