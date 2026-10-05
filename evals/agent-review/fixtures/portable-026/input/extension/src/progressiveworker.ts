import { Worker } from 'node:worker_threads';
import { brotliDecompressSync } from 'node:zlib';
import type { CodexSessionMeta, CodexSubagentFile } from './codex';
import type { ClaudeChildReferenceCacheEntry, DerivedTitleEntry } from './derivedcache';
import { HEAD_KEY_BYTES, SESSION_HEAD_BYTES } from './transcript';
import type { ClaudeForwardCheckpoint, ClaudeHistoryCursor } from './claudehistory';
import type { CodexForwardCheckpoint, CodexHistoryCursor } from './codexhistory';
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

// What one metadata read costs the shared budget, from the size the catalog listed. The
// worker stats the file again before it reads, so a session that grew past a window edge
// between the listing and the read takes more bytes than this charged, and the aggregate
// can pass the budget by that much. The budget bounds the corpus the first rail admits, not
// the bytes the disk serves. The charge is not clamped to the listed size, because a read
// cut short at a stale edge answers facts for a window that is no longer the file's end.
export function metadataReadBudget(session: Pick<SessionFile, 'agent' | 'size'>, tailBytes = 256 * 1024): number {
  return (
    Math.min(session.size, tailBytes) +
    (session.agent === 'codex' ? Math.min(session.size, 512 * 1024) : 0) +
    (session.agent === 'claude' && session.size > tailBytes ? SESSION_HEAD_BYTES : 0)
  );
}

// The head bytes the budget above charged that the read did not take. A Claude read looks
// for a first prompt in the head only when its tail window carries no title, and no read can
// say which case it is before it runs: the budget therefore charges the larger head so a
// session can never read past it. A read that answered with a recorded title took the short
// window that fingerprints the file instead, so the rest goes back and the first rail reaches
// further down the list.
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
  // The clock reading that decides whether a running child is quiet, when the host stores a key
  // it built before the trip. The worker reads the clock once per request otherwise.
  spendNow?: number;
}
export interface DispatchSessionFacts {
  sessionId: string;
  revision: FileRevision;
  spend: import('./agentspend').AgentSpend;
  startedAt: number | null;
  endedAt: number | null;
  toolUses: number;
  // Whether the session's own transcript holds a sign that only a person leaves, from
  // `scanForPerson` in transcript.ts.
  person: boolean;
}
export type ProgressiveRequest =
  | {
      kind: 'claude-children';
      parents: SessionFile[];
      catalog?: SessionFile[];
      codexChildren?: import('./codex').CodexSubagentFile[];
      repositoryRoots: string[];
      referenceEntries?: Array<[string, ClaudeChildReferenceCacheEntry]>;
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
    }
  | { kind: 'starts'; session: SessionFile; agentRunScan?: AgentRunScan }
  | { kind: 'window'; input: ProgressiveInput; checkpoint?: ProgressiveCheckpoint }
  | { kind: 'retained'; input: ProgressiveInput; pages: HistoryPage[]; structuralAgentIds?: readonly string[] }
  | { kind: 'page'; input: ProgressiveInput; cursor: ProgressiveCursor | null };
export type ProgressiveValue =
  | {
      kind: 'claude-children';
      references: ClaudeChildSessionReference[];
      children: ClaudeChildSessionFile[];
      referenceEntries: Array<[string, ClaudeChildReferenceCacheEntry]>;
      dispatchFacts: DispatchSessionFacts[];
      complete: boolean;
      continuation: boolean;
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

/** One execution boundary. The provider owns checkpoints and admitted pages. */
export class ProgressiveWorker {
  private worker: Worker | null = null;
  private nextId = 0;
  private pending = new Map<
    number,
    {
      resolve(value: ProgressiveResult | null): void;
      reject(error: Error): void;
      dispose(): void;
    }
  >();

  constructor(private readonly source?: string) {}

  retainMetadataRecovery(sessionIds: string[]): void {
    this.worker?.postMessage({ metadataEligible: sessionIds });
  }

  run(request: ProgressiveRequest, generation: number, signal: AbortSignal): Promise<ProgressiveResult | null> {
    if (signal.aborted) {
      return Promise.resolve(null);
    }
    if (!this.worker) {
      const source =
        this.source ?? brotliDecompressSync(Buffer.from(PROGRESSIVE_WORKER_BROTLI, 'base64')).toString('utf8');
      const worker = new Worker(source, { eval: true });
      this.worker = worker;
      worker.on('message', (message: { id: number; result?: ProgressiveResult; error?: string }) => {
        const held = this.pending.get(message.id);
        if (!held) {
          return;
        }
        this.pending.delete(message.id);
        held.dispose();
        if (message.error) {
          held.reject(new Error(message.error));
        } else {
          held.resolve(message.result ?? null);
        }
      });
      worker.on('error', (error) => {
        if (this.worker !== worker) {
          return;
        }
        for (const held of this.pending.values()) {
          held.dispose();
          held.reject(error);
        }
        this.pending.clear();
        if (this.worker === worker) {
          this.worker = null;
        }
      });
      worker.on('exit', () => {
        if (this.worker !== worker) {
          return;
        }
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
        if (!this.pending.size) {
          this.stop();
        }
      };
      signal.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { resolve, reject, dispose: () => signal.removeEventListener('abort', abort) });
      this.worker!.postMessage({ id, generation, request });
    });
  }

  stop(): void {
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
