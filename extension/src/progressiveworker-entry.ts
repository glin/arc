import * as fs from 'node:fs';
import { readCodexContext } from './codexcontext';
import { randomUUID } from 'node:crypto';
import {
  beginForwardSessionRecovery,
  ForwardRecoveryLimit,
  type ForwardReadOptions,
  type ForwardRecoveryControl,
  type IncrementalSessionResult,
} from './history';
import { parentPort } from 'node:worker_threads';
import { getHeapStatistics } from 'node:v8';
import { closeReadWindow, openReadWindow } from './readmeter';
import {
  readClaudeHistoryPageAsync,
  readClaudeSessionIncrementalAsync,
  type ClaudeForwardCheckpoint,
  type ClaudeHistoryCursor,
} from './claudehistory';
import {
  readCodexHistoryPageAsync,
  readCodexSessionIncrementalAsync,
  type CodexForwardCheckpoint,
  type CodexHistoryCursor,
} from './codexhistory';
import {
  codexStructuralAgentIds,
  codexSubagentFor,
  discoverCodexNewestTurn,
  codexAgentSpendReader,
  codexAgentSpendVersion,
  codexSpendIndex,
  readCodexDispatchedSpendQuantum,
  retainCodexDispatchSpend,
  retainCodexDispatchSpendRoots,
  type CodexDispatchSpendEntry,
  scanForCodexPerson,
  type CodexPersonScan,
  readCodexSessionActivity,
  createCodexSessionReducer,
  codexSessionLineMayAffectRead,
  readCodexSessionTitlePair,
  readCodexTurnStarts,
  refreshCodexStructuralAgents,
  scanCodexDispatchReferencesAsync,
} from './codex';
import {
  adoptClaudeRepeatedMap,
  blankClaudeRepeated,
  onClaudeRepeatedCoverage,
  type ClaudeRepeatedHeldMap,
} from './clauderepeated';
import { historyPageBytes } from './historypages';
import { applyHiddenTurnFields, hiddenTurnFields } from './parserstate';
import {
  agentSpendDependencyKey,
  ClaudeChildSessionCache,
  childSpendVersion,
  claudeAgentSpendVersion,
  claudeChildFileFor,
  claudeSubagentMetaReader,
  discoverClaudeChildSessions,
  discoverClaudeNewestTurn,
  normalizeFsPath,
  readClaudeAgentSpend,
  resolveClaudeDispatchReferences,
  scanClaudeRelationshipQuantum,
  readSessionMeta,
  createClaudeSessionReducer,
  claudeSessionLineMayAffectRead,
  readSessionTurnStarts,
  refreshClaudeAgentFacts,
  scanForAgentRun,
  scanForPerson,
  tailOf,
  withClaudeRepeated,
  revisionOf as fileRevisionOf,
  type FileRevision,
  relationshipStamp,
  sameRelationshipStamp,
  RELATIONSHIP_QUANTUM_BYTES,
  RELATIONSHIP_RESERVE_BYTES,
  RELATIONSHIP_SLICE_MS,
  type PersonScan,
} from './transcript';
import {
  CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
  limitCodexDispatchCursors,
  needsAgentRunScan,
  onlyGrew,
  scanKeptThroughGrowth,
  type ClaudeChildReferenceCacheEntry,
} from './derivedcache';
import {
  AgentSpendCache,
  readChildSpend,
  childSpendRevisionKey,
  type AgentSpend,
  type AgentSessionTargetLookup,
  type AgentSpendLookup,
  type AgentSpendRef,
} from './agentspend';
import type {
  ProgressiveCheckpoint,
  ProgressiveRequest,
  ProgressiveResult,
  ProgressiveValue,
  DiscoveryCheckpoint,
  DiscoveryCharges,
} from './progressiveworker';
import type { DispatchSessionFacts, WorkerWindowRead } from './progressiveworker';
import { progressiveTurns, workerErrorIdentity } from './progressiveworker';
import { TURN_QUIET_MS, statusOf } from './turncard';

const agentSpends = new AgentSpendCache();
const claudeChildSessions = new ClaudeChildSessionCache();
const claudeChildReferences = new Map<string, ClaudeChildReferenceCacheEntry>();
// Cached subagent revisions invalidate the dispatched session's spend.
// Claude retains its append scan for reader input.
// Codex retains its prompt cursor across quiet reads to correct copied-turn classification.
const dispatchFacts = new Map<
  string,
  {
    revision: FileRevision;
    tree: string;
    facts: DispatchSessionFacts;
    refreshAt: number;
    person?: PersonScan;
    codexPerson?: CodexPersonScan;
    codexDependencies?: string[];
    sourceGeneration?: number;
    spendPending?: boolean;
  }
>();
const DISPATCH_METADATA_BYTES = 256 * 1024;
export const CODEX_DISPATCH_REQUEST_BYTES = 8 * 1024 * 1024;
let discoveryEpoch: DiscoveryCheckpoint | null = null;
const admittedCompletions = new Set<string>();
const epochChildSessions = new Map<string, import('./transcript').ClaudeChildSessionFile | null>();
let discoveryPosition = 0;
let metadataRecovery: {
  file: string;
  sessionId: string;
  work: ForwardReadOptions & { recovery: ForwardRecoveryControl };
  scan: Generator<void, IncrementalSessionResult<unknown>>;
} | null = null;

function dispatchActivity(
  file: string,
  sessionId: string,
  revision: FileRevision,
  now: number,
  agent: 'claude' | 'codex',
): {
  activeUntil: number;
  unfinished: boolean;
} {
  const outcome =
    agent === 'codex'
      ? readCodexSessionActivity(file, DISPATCH_METADATA_BYTES).outcome
      : readSessionMeta(file, DISPATCH_METADATA_BYTES, sessionId, true).outcome;
  if (outcome === null) {
    return { activeUntil: revision.mtimeMs + TURN_QUIET_MS, unfinished: true };
  }
  const endedAt = outcome.endedAt > 0 ? outcome.endedAt : revision.mtimeMs;
  return {
    activeUntil: statusOf({ ...outcome, endedAt }, true, now) === 'running' ? endedAt + TURN_QUIET_MS : 0,
    unfinished: !outcome.finished,
  };
}

function revisionOf(file: string): FileRevision | null {
  try {
    return fileRevisionOf(fs.statSync(file, { bigint: true }));
  } catch {
    return null;
  }
}

function missingFile(file: string): boolean {
  try {
    fs.statSync(file);
    return false;
  } catch (error) {
    return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
  }
}

function sameRevision(left: FileRevision | null, right: FileRevision | null): boolean {
  return (
    !!left &&
    !!right &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

// Accepted evidence at the current end permits reuse after heavy cursor state is evicted.
function qualifiedRelationships(
  held: ClaudeChildReferenceCacheEntry | undefined,
  parent: { agent: string; sessionId: string; childTranscript?: boolean },
  revision: import('./transcript').RelationshipStamp,
): boolean {
  if (!revision) return false;
  const evidence = held?.claudeCursor?.evidence ?? held?.cursor?.evidence ?? held?.evidence;
  return (
    !!evidence &&
    sameRelationshipStamp(evidence.accepted, revision) &&
    !evidence.validation &&
    held?.parserVersion === CLAUDE_CHILD_REFERENCE_PARSER_VERSION &&
    held.source === parent.agent &&
    held.sessionId === parent.sessionId &&
    held.childTranscript === (parent.childTranscript === true) &&
    sameRevision(held, revision)
  );
}

function unchangedFinished(
  held: ClaudeChildReferenceCacheEntry | undefined,
  parent: { agent: string; sessionId: string; childTranscript?: boolean },
  revision: import('./transcript').RelationshipStamp,
): boolean {
  const evidence = held?.claudeCursor?.evidence ?? held?.cursor?.evidence ?? held?.evidence;
  return (
    qualifiedRelationships(held, parent, revision) &&
    !!held &&
    (held.complete === true || (held.source === 'codex' && held.visitedEof === true)) &&
    (held.claudeCursor?.offset ?? held.cursor?.offset ?? evidence!.offset) === revision.size
  );
}

function revive(checkpoint: ProgressiveCheckpoint | undefined): ProgressiveCheckpoint | undefined {
  if (!checkpoint) {
    return undefined;
  }
  checkpoint.lineFragment = Buffer.from(checkpoint.lineFragment);
  if (checkpoint.skippedFragment) checkpoint.skippedFragment = Buffer.from(checkpoint.skippedFragment);
  checkpoint.contentAnchor.bytes = Buffer.from(checkpoint.contentAnchor.bytes);
  return checkpoint;
}

async function execute(
  request: ProgressiveRequest,
  signal: AbortSignal,
  acknowledge?: (value: ProgressiveValue) => void,
): Promise<ProgressiveValue> {
  if (request.kind === 'codex-context') {
    const revision = revisionOf(request.session.file);
    return {
      kind: 'codex-context',
      estimate: revision
        ? await readCodexContext(request.session.file, request.session.sessionId, revision, signal)
        : null,
    };
  }
  if (request.kind === 'commit-repositories') return executeCommitRepositories(request, signal);
  if (request.kind === 'metadata-recovery') {
    if (metadataRecovery && !request.eligible.includes(metadataRecovery.sessionId)) metadataRecovery = null;
    if (metadataRecovery && metadataRecovery.sessionId !== request.session.sessionId) {
      return { kind: 'stale' };
    }
    if (!metadataRecovery || metadataRecovery.file !== request.session.file) {
      const session = request.session;
      const control: ForwardRecoveryControl = {
        through: 0,
        readBytes: 0,
        retainedCharge: 0,
        retainedLimit: request.retainedBytes ?? 64 * 1024 * 1024,
        recordLimit: request.recordBytes ?? 16 * 1024 * 1024,
        reduceAbove: request.reduceAboveBytes ?? 1024 * 1024,
        accepts: session.agent === 'codex' ? codexSessionLineMayAffectRead : claudeSessionLineMayAffectRead,
        fragments: [],
        fragmentBytes: 0,
      };
      const work = { recovery: control, signal, chunkBytes: 256 * 1024 };
      metadataRecovery = {
        file: session.file,
        sessionId: session.sessionId,
        work,
        scan: beginForwardSessionRecovery<unknown>(
          session.file,
          session.agent,
          session.sessionId,
          () =>
            session.agent === 'codex'
              ? createCodexSessionReducer(session.sessionId, { maxTurns: 40 }, request.opening ?? null)
              : createClaudeSessionReducer(
                  session.sessionId,
                  withClaudeRepeated(session.file, { maxTurns: 40, childTranscript: session.childTranscript }),
                ),
          work,
        ),
      };
    }
    const active = metadataRecovery;
    active.work.signal = signal;
    const before = active.work.recovery.readBytes;
    const limit = Math.max(1, Math.min(request.sliceBytes, 16 * 1024 * 1024));
    try {
      while (active.work.recovery.readBytes - before < limit) {
        active.work.chunkBytes = Math.min(256 * 1024, limit - (active.work.recovery.readBytes - before));
        const next = active.scan.next();
        if (next.done) {
          metadataRecovery = null;
          return next.value.read
            ? {
                kind: 'metadata-recovery',
                status: 'complete',
                read: next.value.read,
                readBytes: next.value.readBytes - before,
                through: active.work.recovery.through,
              }
            : { kind: 'stale' };
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (signal.aborted) {
          metadataRecovery = null;
          return { kind: 'stale' };
        }
      }
      return {
        kind: 'metadata-recovery',
        status: 'pending',
        readBytes: active.work.recovery.readBytes - before,
        through: active.work.recovery.through,
      };
    } catch (error) {
      metadataRecovery = null;
      if (!(error instanceof ForwardRecoveryLimit)) throw error;
      return {
        kind: 'metadata-recovery',
        status: 'exhausted',
        readBytes: active.work.recovery.readBytes - before,
        through: active.work.recovery.through,
      };
    }
  }
  if (request.kind === 'claude-children') {
    for (const [file, entry] of request.referenceEntries ?? []) {
      const key = normalizeFsPath(file);
      if (!claudeChildReferences.has(key)) {
        claudeChildReferences.set(key, entry);
      }
    }
    const scope = JSON.stringify(request.repositoryRoots);
    const heldEpoch = discoveryEpoch;
    if (
      request.discovery &&
      request.discovery.parserVersion === CLAUDE_CHILD_REFERENCE_PARSER_VERSION &&
      JSON.stringify(request.discovery.repositoryRoots) === scope &&
      (!discoveryEpoch ||
        (request.discovery.epoch === discoveryEpoch.epoch && request.discovery.sequence >= discoveryEpoch.sequence))
    )
      discoveryEpoch = request.discovery;
    if (!discoveryEpoch || JSON.stringify(discoveryEpoch.repositoryRoots) !== scope) {
      discoveryEpoch = {
        epoch: randomUUID(),
        parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
        parents: request.parents,
        catalog: request.catalog ?? request.parents,
        repositoryRoots: request.repositoryRoots,
        completed: [],
        position: discoveryPosition,
        sequence: 0,
      };
    }
    const epoch = discoveryEpoch;
    // A new worker checks saved completions as their sources become reachable.
    const seeding = heldEpoch?.epoch !== epoch.epoch;
    if (seeding) {
      admittedCompletions.clear();
      epochChildSessions.clear();
    }
    const completed = new Set(epoch.completed);
    const completionChanges = new Map<string, boolean>();
    const charges: DiscoveryCharges = {
      readBytes: 0,
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
    };
    // A parent check is one stat of a candidate source, so it reads no bytes.
    const parentCheck = <T>(check: () => T): T => {
      const startedAt = performance.now();
      try {
        return check();
      } finally {
        charges.parentChecks++;
        charges.parentCheckMs += performance.now() - startedAt;
      }
    };
    const parentStamps = new Map<string, import('./transcript').RelationshipStamp | null>();
    const checkParent = (file: string) => {
      const key = normalizeFsPath(file);
      if (parentStamps.has(key)) return parentStamps.get(key)!;
      const stamp = parentCheck(() => {
        try {
          return relationshipStamp(fs.statSync(file, { bigint: true }));
        } catch {
          return null;
        }
      });
      parentStamps.set(key, stamp);
      return stamp;
    };
    const checkMissing = (file: string) => parentCheck(() => missingFile(file));
    let continuation = false;
    let incomplete = false;
    let admitting = seeding;
    const candidates = new Map<string, import('./transcript').SessionFile>();
    // Each epoch retains admitted child metadata. The charge covers newly resolved child heads.
    const walk = () => {
      candidates.clear();
      const reads = openReadWindow();
      try {
        return discoverClaudeChildSessions(
          epoch.parents,
          epoch.repositoryRoots,
          (parent) => {
            const key = normalizeFsPath(parent.file);
            candidates.set(key, parent);
            const entry = claudeChildReferences.get(key);
            if (!entry) {
              if (!admittedCompletions.has(key) && completed.delete(key)) completionChanges.set(key, false);
              return [];
            }
            // Saved completions require admission when an ancestor first exposes their source.
            if (completed.has(key) && !admittedCompletions.has(key)) {
              const revision = checkParent(parent.file);
              if (revision && unchangedFinished(entry, parent, revision)) admittedCompletions.add(key);
              else {
                completed.delete(key);
                completionChanges.set(key, false);
                claudeChildReferences.set(key, {
                  ...entry,
                  complete: false,
                  relationshipComplete: false,
                  visitedEof: false,
                });
              }
            }
            // Completed cuts stay fixed for this epoch. Later writes enter the next refresh.
            if (!admitting && completed.has(key)) return entry.references;
            // Unfinished Claude sources expose no edges until their scanner qualifies the cut.
            if (!admitting) return parent.agent === 'codex' ? entry.references : [];
            const current = checkParent(parent.file)!;
            return (
              parent.agent === 'codex'
                ? entry.parserVersion === CLAUDE_CHILD_REFERENCE_PARSER_VERSION &&
                  entry.source === 'codex' &&
                  entry.sessionId === parent.sessionId &&
                  entry.childTranscript === (parent.childTranscript === true) &&
                  !!(entry.cursor?.evidence ?? entry.evidence) &&
                  onlyGrew(entry, current)
                : unchangedFinished(entry, parent, current)
            )
              ? entry.references
              : [];
          },
          {
            read(reference, roots) {
              const key = normalizeFsPath(reference.file);
              if (!epochChildSessions.has(key)) epochChildSessions.set(key, claudeChildSessions.read(reference, roots));
              const child = epochChildSessions.get(key);
              return child
                ? { ...child, parentSessionId: reference.parentSessionId, toolUseIds: [...reference.toolUseIds] }
                : null;
            },
          },
        );
      } catch {
        incomplete = true;
        return { references: [], children: [] };
      } finally {
        const tally = closeReadWindow(reads);
        charges.childHeadFiles += tally.files;
        charges.childHeadBytes += tally.bytes;
        charges.childHeadMs += tally.ms;
      }
    };
    // A delta without a source carries completion changes alone, such as the seed's.
    const pending = (source?: string, delta = source !== undefined) => {
      epoch.sequence++;
      // Request boundaries return whole checkpoints. Quanta reuse the host's frozen header.
      if (delta) {
        const value = {
          kind: 'claude-children-delta' as const,
          referenceEntries: source
            ? [[source, claudeChildReferences.get(source)!] as [string, ClaudeChildReferenceCacheEntry]]
            : [],
          checkpoint: header,
          epoch: epoch.epoch!,
          parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
          sequence: epoch.sequence,
          position: epoch.position,
          protectedFile: epoch.protectedFile,
          completed: [...completionChanges],
          continuation: true as const,
          charges,
        };
        header = undefined;
        completionChanges.clear();
        return value;
      }
      const entries = limitCodexDispatchCursors(claudeChildReferences);
      claudeChildReferences.clear();
      for (const [file, entry] of entries) claudeChildReferences.set(file, entry);
      for (const [file, entry] of entries) if (!entry.complete && !entry.visitedEof) completed.delete(file);
      epoch.completed = [...completed];
      return {
        kind: 'claude-children-progress' as const,
        referenceEntries: entries,
        checkpoint: epoch,
        continuation: true as const,
        charges,
      };
    };
    let found = walk();
    if (epoch.protectedFile && !candidates.has(epoch.protectedFile)) {
      const held = claudeChildReferences.get(epoch.protectedFile);
      // Pending parent validation hides ownership edges while the child still needs parsing.
      if (held?.source === 'claude' && held.childTranscript)
        candidates.set(epoch.protectedFile, {
          file: epoch.protectedFile,
          sessionId: held.sessionId,
          agent: held.source,
          childTranscript: held.childTranscript,
          mtimeMs: held.mtimeMs,
          size: held.size,
          dev: held.dev,
          ino: held.ino,
        });
      else delete epoch.protectedFile;
    }
    if (epoch.protectedFile && completed.has(epoch.protectedFile)) delete epoch.protectedFile;
    // Scanners capture their own revision. Admission shares one source observation before the publication walk.
    const seedMissing = new Set<string>();
    if (seeding) {
      let checked = 0;
      for (const [key, parent] of candidates) {
        if (++checked % 256 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (signal.aborted) break;
        }
        const revision = checkParent(parent.file);
        if (!revision) seedMissing.add(key);
        if (revision && unchangedFinished(claudeChildReferences.get(key), parent, revision)) {
          charges.hits++;
          if (!completed.has(key)) completionChanges.set(key, true);
          completed.add(key);
          admittedCompletions.add(key);
          if (epoch.protectedFile === key) delete epoch.protectedFile;
        } else {
          if (completed.delete(key)) completionChanges.set(key, false);
          const entry = claudeChildReferences.get(key);
          if (entry)
            claudeChildReferences.set(key, {
              ...entry,
              complete: false,
              relationshipComplete: false,
              visitedEof: false,
            });
        }
      }
      epoch.completed = [...completed];
    }
    admitting = false;
    let header = request.discovery?.epoch === epoch.epoch ? undefined : { ...epoch, completed: [...completed] };
    if (signal.aborted) return pending();
    // The seeded count reaches the host at once, whatever agent the remaining sources belong to.
    if (completionChanges.size) acknowledge?.(pending(undefined, true));
    const requestBytes = Math.min(request.discoveryBytes ?? CODEX_DISPATCH_REQUEST_BYTES, CODEX_DISPATCH_REQUEST_BYTES);
    const quantumBytes = Math.min(request.quantumBytes ?? RELATIONSHIP_QUANTUM_BYTES, RELATIONSHIP_QUANTUM_BYTES);
    const pendingCharge = (entry: ClaudeChildReferenceCacheEntry | undefined) =>
      entry?.claudeCursor && entry.claudeCursor.offset < entry.claudeCursor.target
        ? Buffer.byteLength(JSON.stringify(entry.claudeCursor))
        : 0;
    let pendingBytes = [...claudeChildReferences.values()].reduce((sum, entry) => sum + pendingCharge(entry), 0);
    const rows = [...candidates];
    const start = epoch.position % Math.max(1, rows.length);
    const ordered = [...rows.slice(start), ...rows.slice(0, start)];
    for (const [key, parent] of ordered) {
      if (completed.has(key) || (epoch.protectedFile && key !== epoch.protectedFile)) continue;
      epoch.position = (rows.findIndex(([file]) => file === key) + 1) % Math.max(1, rows.length);
      const revision = seedMissing.delete(key) ? null : checkParent(parent.file);
      if (!revision) {
        if (checkMissing(parent.file)) {
          completed.add(key);
          admittedCompletions.add(key);
          completionChanges.set(key, true);
          claudeChildReferences.delete(key);
          epochChildSessions.set(key, null);
          dispatchFacts.delete(parent.file);
          if (epoch.protectedFile === key) delete epoch.protectedFile;
          continue;
        }
        incomplete = true;
        continue;
      }
      const held = claudeChildReferences.get(key);
      const identity =
        held?.parserVersion === CLAUDE_CHILD_REFERENCE_PARSER_VERSION &&
        held.source === parent.agent &&
        held.sessionId === parent.sessionId &&
        held.childTranscript === (parent.childTranscript === true);
      if (unchangedFinished(held, parent, revision)) {
        charges.hits++;
        completed.add(key);
        admittedCompletions.add(key);
        completionChanges.set(key, true);
        continue;
      }
      const allowance = Math.min(
        parent.agent === 'codex' ? requestBytes : quantumBytes,
        requestBytes - charges.readBytes,
      );
      if (allowance <= RELATIONSHIP_RESERVE_BYTES || charges.quanta >= 8 || signal.aborted) {
        if (parent.agent === 'codex' && !signal.aborted) {
          epoch.position = rows.findIndex(([file]) => file === key);
          continuation = true;
          break;
        }
        return pending();
      }
      const readsBefore = charges.readBytes;
      const startedAt = performance.now();
      try {
        let references: import('./transcript').ClaudeChildSessionReference[];
        let complete: boolean;
        let qualified: boolean;
        let cursor: import('./codex').CodexDispatchCursor | undefined;
        let claudeCursor: import('./transcript').ClaudeRelationshipCursor | undefined;
        let reset = !identity || (!!held && !(held.claudeCursor?.evidence ?? held.cursor?.evidence));
        if (parent.agent === 'codex') {
          const scan = await scanCodexDispatchReferencesAsync(
            parent.file,
            parent.sessionId,
            identity ? (held?.cursor ?? null) : null,
            allowance,
            () => signal.aborted,
            charges,
          );
          cursor = scan.cursor;
          complete = scan.complete;
          qualified = scan.qualified && !scan.reset;
          reset ||= scan.reset;
          references = scan.qualified
            ? scan.references
            : [
                ...(identity && held && !scan.reset
                  ? (held.pendingReferences ?? held.references).filter(
                      (reference) =>
                        !reference.toolUseIds.some((id) => scan.retractedToolUseIds.has(id)) &&
                        !scan.references.some((scanned) =>
                          scanned.toolUseIds.some((id) => reference.toolUseIds.includes(id)),
                        ),
                    )
                  : []),
                ...scan.references,
              ];
          reset ||=
            !!held?.cursor &&
            (cursor.dev !== held.cursor.dev || cursor.ino !== held.cursor.ino || cursor.offset < held.cursor.offset);
        } else {
          const scan = await scanClaudeRelationshipQuantum(
            parent,
            identity ? held?.claudeCursor : undefined,
            allowance,
            signal,
            charges,
          );
          claudeCursor = scan.cursor;
          complete = scan.complete;
          qualified = scan.qualified && !scan.reset;
          references = scan.references;
          reset ||= scan.reset;
        }
        charges.resets += Number(reset && !!held);
        const compatible = identity && held && !reset;
        const scanRevision = claudeCursor?.revision ?? {
          size: cursor!.size,
          mtimeMs: cursor!.mtimeMs,
          dev: cursor!.dev,
          ino: cursor!.ino,
        };
        const evidence = claudeCursor?.evidence ?? cursor!.evidence;
        const reachedTarget = cursor ? cursor.offset === cursor.target : claudeCursor!.offset === claudeCursor!.target;
        const accepted =
          qualified &&
          (complete || (parent.agent === 'claude' && reachedTarget && claudeCursor!.offset === scanRevision.size));
        const finished = qualified && reachedTarget && (claudeCursor?.offset ?? cursor!.offset) === scanRevision.size;
        claudeChildReferences.set(key, {
          sourceGeneration: (held?.sourceGeneration ?? 0) + Number(reset || !held),
          sequence: (held?.sequence ?? 0) + 1,
          parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
          source: parent.agent,
          ...scanRevision,
          sessionId: parent.sessionId,
          childTranscript: parent.childTranscript === true,
          complete: accepted,
          visitedEof: qualified && reachedTarget,
          cursor,
          claudeCursor,
          references:
            qualified && (complete || reachedTarget || parent.agent === 'codex')
              ? references
              : compatible
                ? held.references
                : [],
          pendingReferences: accepted ? undefined : references,
          relationshipComplete: accepted,
          appliedCut:
            qualified && (complete || reachedTarget)
              ? (claudeCursor?.applied ??
                (cursor!.terminalApplied
                  ? cursor!.offset
                  : (cursor!.fragmentStart ?? cursor!.offset - Buffer.byteLength(cursor!.fragment, 'base64'))))
              : compatible
                ? held.appliedCut
                : undefined,
          validatedRevision:
            qualified && (complete || reachedTarget)
              ? evidence!.accepted!
              : compatible
                ? held.validatedRevision
                : undefined,
          ...(reset && held ? { resetReason: 'source generation changed' } : {}),
        });
        if (reset) dispatchFacts.delete(parent.file);
        pendingBytes += pendingCharge(claudeChildReferences.get(key)) - pendingCharge(held);
        if (!reachedTarget && claudeCursor && pendingBytes > 64 * 1024 * 1024) epoch.protectedFile ??= key;
        if (finished || parent.agent === 'codex') {
          completed.add(key);
          admittedCompletions.add(key);
          completionChanges.set(key, true);
        }
        const childCut = epochChildSessions.get(key);
        if (childCut && !sameRevision({ ...childCut, dev: childCut.dev ?? '', ino: childCut.ino ?? '' }, scanRevision))
          epochChildSessions.delete(key);
        if (qualified && reachedTarget && epoch.protectedFile === key) delete epoch.protectedFile;
        if (
          !reachedTarget &&
          claudeCursor &&
          (claudeCursor.fragmentBytes > 256 * 1024 ||
            Buffer.byteLength(JSON.stringify(claudeCursor.state)) > 8 * 1024 * 1024)
        )
          epoch.protectedFile = key;
        if (epoch.protectedFile === key && !reachedTarget) {
          completed.delete(key);
          completionChanges.set(key, false);
        }
        continuation ||= !finished;
        if (!finished && parent.agent === 'claude') {
          completed.delete(key);
          completionChanges.set(key, false);
        }
        if (charges.readBytes > readsBefore || performance.now() - startedAt >= RELATIONSHIP_SLICE_MS) {
          charges.quanta++;
          acknowledge?.(pending(key));
        }
      } catch (error) {
        if (charges.readBytes > readsBefore || performance.now() - startedAt >= RELATIONSHIP_SLICE_MS) charges.quanta++;
        incomplete = true;
        claudeChildReferences.set(key, {
          ...(held ?? { ...revision, references: [] }),
          parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
          source: parent.agent,
          sessionId: parent.sessionId,
          childTranscript: parent.childTranscript === true,
          complete: false,
          relationshipComplete: false,
          resetReason: error instanceof Error ? error.message : 'Source unavailable',
        });
        completed.delete(key);
        completionChanges.set(key, false);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    parentStamps.clear();
    found = walk();
    if (incomplete || [...candidates].some(([key, parent]) => parent.agent === 'claude' && !completed.has(key)))
      return pending();
    for (const [file] of candidates) {
      if (completed.has(file)) continue;
      const entry = claudeChildReferences.get(file);
      if (!entry) {
        continuation ||= !checkMissing(file);
        continue;
      }
      const current = checkParent(file);
      if (!current || !unchangedFinished(entry, candidates.get(file)!, current)) {
        completed.delete(file);
        completionChanges.set(file, false);
        claudeChildReferences.set(file, { ...entry, complete: false, relationshipComplete: false });
        continuation = true;
        if (candidates.get(file)!.agent === 'claude') return pending();
      }
    }

    for (const file of [...claudeChildReferences.keys()]) if (!candidates.has(file)) claudeChildReferences.delete(file);
    const boundedEntries = limitCodexDispatchCursors(claudeChildReferences);
    for (const [file, entry] of boundedEntries) if (!entry.complete && !entry.visitedEof) completed.delete(file);
    claudeChildReferences.clear();
    for (const [file, entry] of boundedEntries) claudeChildReferences.set(file, entry);
    const parentKeys = (parents: typeof epoch.parents) =>
      JSON.stringify(
        parents.map(({ file, sessionId, agent, childTranscript }) => ({ file, sessionId, agent, childTranscript })),
      );
    continuation ||= parentKeys(epoch.parents) !== parentKeys(request.parents);
    discoveryPosition = epoch.position;
    discoveryEpoch = null;
    const references = resolveClaudeDispatchReferences(found.references, epoch.catalog);
    retainCodexDispatchSpendRoots(new Set(references.flatMap((reference) => (reference.file ? [reference.file] : []))));
    const dispatched: DispatchSessionFacts[] = [];
    const seen = new Set<string>();
    // Each request caps Codex spend reads independently of relationship discovery.
    const dispatchBudget = { bytes: CODEX_DISPATCH_REQUEST_BYTES, deadline: performance.now() + RELATIONSHIP_SLICE_MS };
    const dispatchReads = openReadWindow();
    try {
      const subagentMetas = claudeSubagentMetaReader();
      for (const reference of references) {
        if (reference.kind !== 'dispatch' || !reference.file || seen.has(reference.sessionId)) {
          continue;
        }
        seen.add(reference.sessionId);
        charges.dispatchSpendVisits++;
        const revision = revisionOf(reference.file);
        if (!revision) {
          continue;
        }
        const heldValue = dispatchFacts.get(reference.file);
        const sourceGeneration = claudeChildReferences.get(normalizeFsPath(reference.file))?.sourceGeneration;
        const held =
          heldValue &&
          heldValue.sourceGeneration === sourceGeneration &&
          onlyGrew(heldValue.revision, revision) &&
          (heldValue.revision.size < revision.size || sameRevision(heldValue.revision, revision))
            ? heldValue
            : undefined;
        const now = Date.now();
        let codexDependencies = held?.codexDependencies ?? [reference.file];
        const sourceFile = reference.file;
        const codexVersion = () =>
          codexAgentSpendVersion(
            sourceFile,
            codexSpendIndex(request.codexChildren ?? []),
            reference.sessionId,
            codexDependencies,
          );
        const tree =
          reference.agent === 'codex'
            ? childSpendRevisionKey('completed', codexVersion(), now)
            : claudeAgentSpendVersion(reference.file, false, subagentMetas);
        if (
          held &&
          sameRevision(held.revision, revision) &&
          held.tree === tree &&
          !held.spendPending &&
          now < held.refreshAt &&
          (!held.codexPerson || held.codexPerson.bytes >= revision.size)
        ) {
          dispatched.push(held.facts);
          continue;
        }
        charges.dispatchSpendRereads++;
        const previousPerson =
          held &&
          held.revision.dev === revision.dev &&
          held.revision.ino === revision.ino &&
          (held.revision.size < revision.size || sameRevision(held.revision, revision))
            ? held.codexPerson
            : undefined;
        const previousBytes = previousPerson?.bytes ?? 0;
        const codexPerson =
          reference.agent === 'codex'
            ? scanForCodexPerson(reference.file, revision.size, previousPerson, reference.sessionId)
            : undefined;
        if (!sameRevision(revision, revisionOf(reference.file))) {
          charges.dispatchRetries++;
          continuation = true;
          const compatible = held && onlyGrew(held.revision, revisionOf(reference.file));
          dispatched.push(
            compatible
              ? { ...held.facts, spend: { ...held.facts.spend, partial: true } }
              : {
                  sessionId: reference.sessionId,
                  revision,
                  refreshAt: now,
                  startedAt: null,
                  endedAt: null,
                  toolUses: 0,
                  person: false,
                  spend: { models: [], found: false, partial: true, effort: null },
                },
          );
          dispatchFacts.delete(reference.file);
          continue;
        }
        continuation ||= !!codexPerson && codexPerson.bytes < revision.size && codexPerson.bytes > previousBytes;
        const completion = codexPerson?.dispatchCompletion;
        const completed =
          codexPerson?.bytes === revision.size &&
          codexPerson.fragment.length === 0 &&
          completion?.terminal !== null &&
          !!completion?.terminal &&
          !completion.invalid &&
          !completion.skipping;
        const activity =
          reference.agent === 'codex'
            ? { activeUntil: completed ? 0 : revision.mtimeMs + TURN_QUIET_MS, unfinished: !completed }
            : dispatchActivity(reference.file, reference.sessionId, revision, now, reference.agent);
        const refreshAt = activity.activeUntil;
        const active = now < refreshAt;
        let spendPending = false;
        const spend: AgentSpend = active
          ? { models: [], found: false, partial: false, effort: null }
          : reference.agent === 'codex'
            ? (() => {
                const result = readCodexDispatchedSpendQuantum(
                  reference.file,
                  request.codexChildren ?? [],
                  now,
                  dispatchBudget,
                  (files) => {
                    codexDependencies = files;
                  },
                  (file, entry) => parentPort?.postMessage({ dispatchSpend: [file, entry] }),
                  (event) => charges[event]++,
                );
                spendPending = result.pending;
                continuation ||= result.pending;
                return result.spend;
              })()
            : readClaudeAgentSpend(reference.file, request.repositoryRoots, false, subagentMetas);
        if (!active && activity.unfinished) {
          spend.unfinished = true;
          if (spend.artifacts) {
            spend.artifacts.complete = false;
          }
        }
        // Claude scans active appends. Codex retains its bounded prompt cursor across quiet
        // reads because a cached spend can precede delayed copied-turn context.
        const scan =
          active && reference.agent === 'claude'
            ? scanForPerson(reference.file, revision.size, held?.person, held ? held.revision.size : revision.size)
            : undefined;
        const person =
          reference.agent === 'codex'
            ? codexPerson && codexPerson.bytes >= revision.size
              ? codexPerson.person
              : spend.person === true || codexPerson?.person === true
            : held?.facts.person === true || (scan ? scan.person : spend.person === true);
        if (!sameRevision(revision, revisionOf(reference.file))) {
          charges.dispatchRetries++;
          continuation = true;
          const compatible = held && onlyGrew(held.revision, revisionOf(reference.file));
          dispatched.push(
            compatible
              ? { ...held.facts, spend: { ...held.facts.spend, partial: true } }
              : {
                  sessionId: reference.sessionId,
                  revision,
                  refreshAt: now,
                  startedAt: null,
                  endedAt: null,
                  toolUses: 0,
                  person: false,
                  spend: { models: [], found: false, partial: true, effort: null },
                },
          );
          dispatchFacts.delete(reference.file);
          continue;
        }
        const collectedTree =
          reference.agent === 'codex'
            ? childSpendRevisionKey('completed', codexVersion(), now)
            : claudeAgentSpendVersion(reference.file, false, subagentMetas);
        if (collectedTree !== tree) {
          charges.dispatchRetries++;
          continuation = true;
          spend.partial = true;
          if (spend.artifacts) spend.artifacts.complete = false;
        }
        const facts: DispatchSessionFacts = {
          sessionId: reference.sessionId,
          refreshAt: active ? refreshAt : null,
          revision,
          spend,
          startedAt: spend.startedAt ?? null,
          endedAt: spend.endedAt ?? null,
          toolUses: spend.toolUses ?? 0,
          person,
        };
        dispatchFacts.set(reference.file, {
          sourceGeneration,
          spendPending,
          revision,
          tree: reference.agent === 'codex' ? childSpendRevisionKey('completed', codexVersion(), now) : tree,
          codexDependencies,
          facts,
          refreshAt: active ? refreshAt : Number.POSITIVE_INFINITY,
          person: scan,
          codexPerson,
        });
        dispatched.push(facts);
      }
    } finally {
      const dispatchTally = closeReadWindow(dispatchReads);
      charges.dispatchSpendFiles += dispatchTally.files;
      charges.dispatchSpendBytes += dispatchTally.bytes;
      charges.dispatchSpendMs += dispatchTally.ms;
    }
    const currentFiles = new Set(
      references.flatMap((reference) => (reference.kind === 'dispatch' && reference.file ? [reference.file] : [])),
    );
    for (const file of dispatchFacts.keys()) {
      if (!currentFiles.has(file)) {
        dispatchFacts.delete(file);
      }
    }
    return {
      kind: 'claude-children',
      checkpoint: { ...epoch, completed: [...completed], sequence: epoch.sequence + 1 },
      ...found,
      references,
      dispatchFacts: dispatched,
      referenceEntries: [...claudeChildReferences],
      complete: true,
      continuation,
      charges,
      roots: epoch.parents,
      scope: epoch.repositoryRoots,
    };
  }
  if (request.kind === 'starts') {
    const starts =
      request.session.agent === 'claude'
        ? readSessionTurnStarts(request.session.file, undefined, request.session.childTranscript === true)
        : readCodexTurnStarts(request.session.file);
    return needsAgentRunScan(request.session)
      ? {
          kind: 'starts',
          starts,
          agentRunScan: scanForAgentRun(request.session.file, request.session.size, request.agentRunScan),
        }
      : { kind: 'starts', starts };
  }
  if (request.kind === 'metadata') {
    const session = request.session;
    const tailBytes = request.tailBytes ?? 256 * 1024;
    const meta =
      session.agent === 'claude'
        ? readSessionMeta(session.file, tailBytes, session.sessionId, session.childTranscript === true)
        : readCodexSessionActivity(session.file, tailBytes, {
            sessionId: session.sessionId,
            meta: request.opening ?? null,
          });
    const title = session.agent === 'codex' ? readCodexSessionTitlePair(session.file) : null;
    // A Claude tail with no recorded title leaves the first prompt to a read of the head,
    // which `metadataReadBudget` charges for.
    const claude = session.agent === 'claude' ? (meta as ReturnType<typeof readSessionMeta>) : null;
    const label = title?.short || claude?.title || '';
    return {
      kind: 'metadata',
      coverage: meta.coverage,
      entry: {
        sourceIdentity: { dev: session.dev ?? -1, ino: session.ino ?? -1 },
        mtimeMs: session.mtimeMs,
        size: session.size,
        label,
        fullLabel: title?.full || claude?.fullTitle || '',
        activityMs: meta.activityMs,
        agentRun: session.agentRun === true || claude?.agentRun === true,
        outcome: meta.outcome,
        stats: meta.stats ?? null,
        ...(claude?.backgroundCommands ? { backgroundCommands: claude.backgroundCommands } : {}),
        foldedLabel: label.toLocaleLowerCase(),
        ...(claude?.title && claude.titleSource ? { nameSource: claude.titleSource } : {}),
        ...(claude?.title && claude.titleSource && claude.titleAt !== undefined ? { nameAt: claude.titleAt } : {}),
        ...(claude?.headKey ? { headKey: claude.headKey } : {}),
        ...(claude?.withdrawnPrompt ? { withdrawnPrompt: true } : {}),
      },
    };
  }
  const {
    session,
    folders,
    children,
    claudeChildren = [],
    claudeChildReferences: references = [],
    maxTurns,
    tailBytes,
  } = request.input;
  const claudeChildFor = (agent: AgentSpendRef) =>
    agent.toolUseId
      ? claudeChildren.find(
          (candidate) =>
            candidate.parentSessionId === session.sessionId &&
            candidate.sessionId === agent.id &&
            candidate.toolUseIds.includes(agent.toolUseId as string),
        )
      : undefined;
  const versions = new Map<string, string>();
  const codexIndex = session.agent === 'codex' ? codexSpendIndex(children) : null;
  const readCodexSpend = codexIndex ? codexAgentSpendReader(codexIndex) : null;
  const subagentMetas = claudeSubagentMetaReader();
  const agentFile = (agent: AgentSpendRef) =>
    session.agent === 'claude'
      ? claudeChildFileFor(references, session, agent, subagentMetas)
      : (codexSubagentFor(children, session.sessionId, agent)?.file ?? null);
  const versionOf = (file: string): string => {
    let version = versions.get(file);
    if (version === undefined) {
      version =
        session.agent === 'codex'
          ? codexAgentSpendVersion(file, codexIndex!, undefined, undefined, session.file)
          : childSpendVersion(session.agent, file, subagentMetas);
      versions.set(file, version);
    }
    return version;
  };
  const structuralKey = (
    session.agent === 'codex'
      ? children
          .filter((child) => child.parentThreadId === session.sessionId)
          .map(
            (child) =>
              `${child.threadId}:${child.openedAt ?? ''}:${child.threadSource ?? ''}:${child.backgroundReview}:${child.file}`,
          )
      : references
          .filter((child) => child.parentSessionId === session.sessionId)
          .map((child) => `${child.sessionId}:${[...child.toolUseIds].sort().join(',')}:${child.file}`)
          .concat(
            claudeChildren
              .filter((child) => child.parentSessionId === session.sessionId)
              .map((child) => `target:${child.sessionId}:${child.file}`),
          )
  )
    .sort()
    .join('\n');
  const claudeSpendParseKey = session.agent === 'claude' ? folders.map(normalizeFsPath).sort().join('\n') : '';
  // Use one clock reading for child spend and its dependency key.
  const spendNow = request.input.spendNow ?? Date.now();
  const agentSpendOf: AgentSpendLookup = (agent) => {
    const file = agentFile(agent);
    if (!file) {
      return { models: [], found: false, partial: false, effort: null };
    }
    return session.agent === 'claude'
      ? readChildSpend(
          agentSpends,
          file,
          agent.status,
          versionOf(file),
          (source) => readClaudeAgentSpend(source, folders, true, subagentMetas),
          claudeSpendParseKey,
          true,
          spendNow,
        )
      : readChildSpend(
          agentSpends,
          file,
          agent.status,
          versionOf(file),
          readCodexSpend!,
          versionOf(file)
            .split('\n')
            .filter((line) => line.startsWith('[') || line.startsWith('source:'))
            .join('\n'),
          true,
          spendNow,
        );
  };
  const agentSessionTargetOf: AgentSessionTargetLookup = (agent) => {
    if (session.agent !== 'claude' || !agent.id || !agent.toolUseId || !/^[A-Za-z0-9-]+$/.test(agent.id)) {
      return null;
    }
    const child = claudeChildFor(agent);
    return child?.sessionId ?? null;
  };
  const options = {
    maxTurns,
    tailBytes,
    folders,
    agentSpendOf,
    agentSessionTargetOf,
    childTranscript: session.childTranscript === true,
    structuralChildren: children,
  };
  if (request.kind === 'retained') {
    request.pages
      .flatMap((page) => page.turns)
      .forEach((turn, index) => applyHiddenTurnFields(turn, request.hidden?.[index], session.agent === 'codex'));
    return {
      kind: 'retained',
      pages: request.pages.map((page) => {
        if (session.agent === 'codex') {
          refreshCodexStructuralAgents(
            page.turns,
            session.sessionId,
            options.structuralChildren,
            agentSpendOf,
            request.structuralAgentIds,
          );
        } else {
          refreshClaudeAgentFacts(page.turns, agentSpendOf, agentSessionTargetOf);
        }
        return { ...page, bytes: historyPageBytes(page) };
      }),
    };
  }
  if (request.kind === 'page') {
    if (request.cursor) {
      request.cursor.fragment = Buffer.from(request.cursor.fragment);
    }
    const result =
      session.agent === 'claude'
        ? await readClaudeHistoryPageAsync(
            session.file,
            session.sessionId,
            request.cursor as ClaudeHistoryCursor | null,
            { signal, targetTurns: 20 },
            options,
          )
        : await readCodexHistoryPageAsync(
            session.file,
            session.sessionId,
            request.cursor as CodexHistoryCursor | null,
            { signal, targetTurns: 20 },
            options,
          );
    return {
      kind: 'page',
      recoveryBytes: result.kind === 'page' ? (result.page.recoveryBytes ?? 0) : 0,
      page:
        result.kind === 'page'
          ? {
              kind: 'page',
              turns: result.page.turns,
              compactions: result.page.compactions,
              cursor: result.page.nextOlderCursor,
              ownedRange: result.page.ownedRange,
              openRange: result.openRange,
            }
          : result.kind === 'stale'
            ? { kind: 'stale' }
            : { kind: 'failed' },
    };
  }
  const checkpoint = revive(request.checkpoint);
  let recoveryBytes = 0;
  const read = async (bytes: number, held = checkpoint) => {
    const result = await (session.agent === 'claude'
      ? readClaudeSessionIncrementalAsync(
          session.file,
          session.sessionId,
          held as ClaudeForwardCheckpoint | undefined,
          { ...options, tailBytes: bytes },
          { signal },
        )
      : readCodexSessionIncrementalAsync(
          session.file,
          session.sessionId,
          held as CodexForwardCheckpoint | undefined,
          { ...options, tailBytes: bytes },
          { signal },
        ));
    recoveryBytes += 'recoveryBytes' in result ? Number(result.recoveryBytes) : 0;
    return result;
  };
  const retainedBytes = checkpoint
    ? Math.max(tailBytes, Number(JSON.parse(checkpoint.parserKey).tailBytes) || tailBytes)
    : tailBytes;
  let result = await read(retainedBytes);
  if (!result.read) {
    return { kind: 'stale', recoveryBytes };
  }
  let appendFrom = result.appendFrom;
  const initialRevision = result.checkpoint.revision;
  if (!result.read.turns.length && result.checkpoint.coveredFrom > 0) {
    const tail = tailOf(session.file, tailBytes, true);
    if (session.agent === 'claude') {
      tail.lines = blankClaudeRepeated(session.file, tail.lines, tail.offset ?? 0, Number.MAX_SAFE_INTEGER);
    }
    if (tail.cursor) {
      if (session.agent === 'claude' && session.childTranscript) {
        result = await read(session.size, undefined);
      } else {
        const discovered =
          session.agent === 'claude'
            ? await discoverClaudeNewestTurn(session.file, tail.cursor, { signal, chunkBytes: 256 * 1024 }, tail.lines)
            : await discoverCodexNewestTurn(session.file, tail.cursor, undefined, { signal, chunkBytes: 256 * 1024 });
        if (discovered.kind === 'cancelled' || discovered.kind === 'stale') {
          return { kind: 'stale', recoveryBytes };
        }
        const bytes = discovered.kind === 'found' ? discovered.readBytes : session.size;
        result = await read(bytes, undefined);
      }
      appendFrom =
        appendFrom && result.checkpoint && sameRevision(initialRevision, result.checkpoint.revision)
          ? appendFrom
          : null;
    }
  }
  if (!result.read) {
    return { kind: 'stale', recoveryBytes };
  }
  const codexChildFiles =
    session.agent === 'codex'
      ? children.filter((child) => child.parentThreadId === session.sessionId).map((child) => child.file)
      : [];
  return {
    kind: 'window',
    read: result.read,
    checkpoint: result.checkpoint,
    reset: result.kind === 'reset',
    appendFrom,
    readBytes: result.readBytes,
    recoveryBytes,
    recoveryPending: 'recoveryPending' in result && result.recoveryPending === true,
    agentKey: agentSpendDependencyKey(
      result.read.turns,
      agentFile,
      versionOf,
      structuralKey,
      codexChildFiles,
      spendNow,
    ),
    structuralKey,
    structuralAgentIds: session.agent === 'codex' ? codexStructuralAgentIds(result.read.turns) : undefined,
    retainedBytes: Buffer.byteLength(JSON.stringify([result.read, result.checkpoint])),
    checkpointBytes: Buffer.byteLength(JSON.stringify(result.checkpoint)),
  };
}

const requests = new Map<number, AbortController>();
// Window read lifecycles in this worker. Times use this worker's monotonic clock, so only their differences leave it.
// Overlap counts name other work that ran on this thread during the read, not the time that work took.
const WINDOW_READS = 8;
type RequestKind = ProgressiveRequest['kind'];
const activeKinds: Partial<Record<RequestKind, number>> = {};
const windowReads = new Map<
  number,
  {
    receivedAt: number;
    enteredAt: number | null;
    completedAt: number | null;
    report: Omit<WorkerWindowRead, 'enterMs' | 'readMs' | 'replyMs'>;
  }
>();
function countKind(counts: Partial<Record<RequestKind, number>>, kind: RequestKind): void {
  counts[kind] = (counts[kind] ?? 0) + 1;
}
function noteBackground(field: 'discoveryProgress' | 'repeatedCoverage'): void {
  for (const read of windowReads.values()) read.report.during[field]++;
}
function windowReadReport(id: number): WorkerWindowRead | undefined {
  const read = windowReads.get(id);
  if (!read) return undefined;
  const now = performance.now();
  return {
    ...read.report,
    enterMs: read.enteredAt === null ? null : read.enteredAt - read.receivedAt,
    readMs: read.enteredAt === null || read.completedAt === null ? null : read.completedAt - read.enteredAt,
    replyMs: now - (read.completedAt ?? read.enteredAt ?? read.receivedAt),
  };
}

function workerMemory(): import('./progressiveworker').WorkerMemory {
  const heap = getHeapStatistics();
  return {
    heapUsed: heap.used_heap_size,
    heapTotal: heap.total_heap_size,
    heapLimit: heap.heap_size_limit,
    external: heap.external_memory,
  };
}
let commitParentCursor: import('./codexhistory').CommitRepositoryCursor | null = null;
// Children of one parent share the parent cursor and keep their own child cursors. Visible sessions on sibling
// children therefore resume their own scans when their requests alternate. Map order is least recently used first.
const COMMIT_CHILD_CURSORS = 8;
const commitChildCursors = new Map<
  string,
  { cursor: import('./codexhistory').CommitRepositoryCursor; token: string }
>();
let commitCursorSequence = 0;

async function executeCommitRepositories(
  request: Extract<ProgressiveRequest, { kind: 'commit-repositories' }>,
  signal: AbortSignal,
): Promise<ProgressiveValue> {
  const {
    createCommitRepositoryCursor,
    scanCommitRepositorySource,
    commitRepositoryTargets,
    commitSourceRevision,
    COMMIT_REPOSITORY_PARSER_VERSION,
    COMMIT_REPOSITORY_REQUEST_BYTES,
  } = await import('./codexhistory.js');
  const { commitRepositorySourceKey } = await import('./progressiveworker.js');
  const key = commitRepositorySourceKey;
  // A copy holds only the bytes of each buffer view, not the read chunk behind the view.
  const clone = (
    cursor: import('./codexhistory').CommitRepositoryCursor,
  ): import('./codexhistory').CommitRepositoryCursor => {
    const { fragment, queue, head, anchor, ...rest } = cursor;
    return {
      ...structuredClone(rest),
      fragment: Buffer.from(fragment),
      queue: Buffer.from(queue),
      head: Buffer.from(head),
      anchor: Buffer.from(anchor),
    };
  };
  const parent =
    commitParentCursor && key(commitParentCursor.source) === key(request.parent)
      ? clone(commitParentCursor)
      : createCommitRepositoryCursor(request.parent, null);
  // One entry serves each child file and parent pair. It resumes only for its token and the same child revision.
  const childKey = JSON.stringify([request.child.file, request.child.sessionId, request.parent.sessionId]);
  const held = commitChildCursors.get(childKey);
  const child =
    held && request.token === held.token && key(held.cursor.source) === key(request.child)
      ? clone(held.cursor)
      : createCommitRepositoryCursor(
          request.child,
          request.parent.sessionId,
          request.commits.flatMap((commit) => commit.dirs),
        );
  let status: import('./codexhistory').CommitRepositoryReply['status'] = 'pending';
  const charges = { parent: 0, child: 0 };
  if (
    request.parserVersion !== COMMIT_REPOSITORY_PARSER_VERSION ||
    request.parentBytes + request.childBytes > COMMIT_REPOSITORY_REQUEST_BYTES ||
    request.parentBytes < 0 ||
    request.childBytes < 0
  )
    status = 'stale';
  else {
    const scanParent = parent.complete
      ? { status: 'complete' as const, readBytes: 0 }
      : request.parentBytes > 0
        ? await scanCommitRepositorySource(parent, request.parentBytes, signal)
        : { status: 'exhausted' as const, readBytes: 0 };
    charges.parent = scanParent.readBytes;
    const scanChild =
      request.childBytes > 0
        ? await scanCommitRepositorySource(child, request.childBytes, signal)
        : { status: 'exhausted' as const, readBytes: 0 };
    charges.child = scanChild.readBytes;
    status = signal.aborted
      ? 'cancelled'
      : [scanParent.status, scanChild.status].includes('stale')
        ? 'stale'
        : [scanParent.status, scanChild.status].includes('exhausted')
          ? 'exhausted'
          : parent.complete && child.complete
            ? 'complete'
            : 'pending';
  }
  if (!commitSourceRevision(request.parent) || !commitSourceRevision(request.child)) status = 'stale';
  const targets = status === 'complete' ? commitRepositoryTargets(parent, child, request.commits) : [];
  const token = status === 'pending' || status === 'complete' ? `${++commitCursorSequence}` : null;
  if (status === 'pending' || status === 'complete') commitParentCursor = parent;
  // A cancelled request keeps the entry, so the retry with the same token resumes where the last pending reply stopped.
  if (status !== 'cancelled') commitChildCursors.delete(childKey);
  if (status === 'pending' && token) {
    commitChildCursors.set(childKey, { cursor: clone(child), token });
    for (const oldest of commitChildCursors.keys()) {
      if (commitChildCursors.size <= COMMIT_CHILD_CURSORS) break;
      commitChildCursors.delete(oldest);
    }
  }
  return {
    kind: 'commit-repositories',
    status,
    token,
    parent: request.parent,
    child: request.child,
    parserVersion: request.parserVersion,
    readBytes: charges,
    covered: { parent: [0, parent.through], child: [0, child.through] },
    targets,
  };
}
async function handleMessage(message: {
  id: number;
  generation: number;
  request: ProgressiveRequest;
  cancel?: number;
}): Promise<void> {
  if (message.cancel !== undefined) {
    requests.get(message.cancel)?.abort();
    return;
  }
  const controller = new AbortController();
  requests.set(message.id, controller);
  const kind = message.request.kind;
  for (const read of windowReads.values()) countKind(read.report.during.received, kind);
  if (kind === 'window' && windowReads.size < WINDOW_READS) {
    windowReads.set(message.id, {
      receivedAt: performance.now(),
      enteredAt: null,
      completedAt: null,
      report: {
        atReceipt: { ...activeKinds },
        discoveryWaiting: !!waitingDiscovery,
        during: { received: {}, finished: {}, discoveryProgress: 0, repeatedCoverage: 0 },
      },
    });
  }
  countKind(activeKinds, kind);
  try {
    const request = message.request;
    if (request.kind === 'commit-repositories') {
      const value = await executeCommitRepositories(request, controller.signal);
      if (!controller.signal.aborted)
        parentPort?.postMessage({
          id: message.id,
          result: { generation: message.generation, revision: request.parent.revision, value },
        });
      return;
    }
    if (request.kind === 'claude-children') {
      const value = await execute(request, controller.signal, (value) => {
        noteBackground('discoveryProgress');
        if (!controller.signal.aborted)
          parentPort?.postMessage({
            id: message.id,
            progress: true,
            result: { generation: message.generation, revision: null, value, workerMemory: workerMemory() },
          });
      });
      if (!controller.signal.aborted) {
        parentPort?.postMessage({
          id: message.id,
          result: { generation: message.generation, revision: null, value, workerMemory: workerMemory() },
        });
      }
      return;
    }
    const file = 'session' in request ? request.session.file : request.input.session.file;
    const requested = 'session' in request ? request.session : request.input.session;
    const before = revisionOf(file);
    if (!before) {
      if (request.kind === 'metadata-recovery' && metadataRecovery?.sessionId === requested.sessionId) {
        metadataRecovery = null;
      }
      parentPort?.postMessage({
        id: message.id,
        result: {
          generation: message.generation,
          revision: before,
          value: { kind: 'stale' },
        },
        windowRead: windowReadReport(message.id),
      });
      return;
    }
    // Read catalog metadata against the revision present when the worker starts.
    // An active session can append after listing.
    // History windows and pages require the exact requested revision.
    const metadataRequest =
      request.kind === 'metadata' ? { ...request, session: { ...request.session, ...before } } : null;
    if (
      !metadataRequest &&
      (before.size !== requested.size ||
        before.mtimeMs !== requested.mtimeMs ||
        ('dev' in requested && requested.dev !== before.dev) ||
        ('ino' in requested && requested.ino !== before.ino))
    ) {
      if (request.kind === 'metadata-recovery' && metadataRecovery?.sessionId === requested.sessionId) {
        metadataRecovery = null;
      }
      parentPort?.postMessage({
        id: message.id,
        result: {
          generation: message.generation,
          revision: before,
          value: { kind: 'stale' },
        },
        windowRead: windowReadReport(message.id),
      });
      return;
    }
    const read = windowReads.get(message.id);
    if (read) read.enteredAt = performance.now();
    // Every window read signals its start, including one past the lifecycle bound.
    if (kind === 'window') parentPort?.postMessage({ id: message.id, windowEntered: true });
    const value = await execute(metadataRequest ?? request, controller.signal);
    if (read) read.completedAt = performance.now();
    const after = revisionOf(file);
    const stable = sameRevision(before, after);
    const stableWindow = value.kind !== 'window' || sameRevision(value.checkpoint.revision, before);
    const kept = stable ? undefined : scanKeptThroughGrowth(value, before, after);
    const metadataPrefix = value.kind === 'metadata' && after && after.size > before.size && onlyGrew(before, after);
    const result: ProgressiveResult = {
      generation: message.generation,
      revision: metadataPrefix ? before : after,
      value:
        (stable && stableWindow) || metadataPrefix
          ? value
          : kept
            ? {
                kind: 'stale',
                agentRunScan: kept,
                recoveryBytes: 'recoveryBytes' in value ? value.recoveryBytes : undefined,
              }
            : { kind: 'stale', recoveryBytes: 'recoveryBytes' in value ? value.recoveryBytes : undefined },
    };
    if (!controller.signal.aborted) {
      if (request.kind === 'metadata-recovery' && result.value.kind === 'stale') metadataRecovery = null;
      parentPort?.postMessage({
        id: message.id,
        result,
        hidden: {
          turns: progressiveTurns(result.value).map(hiddenTurnFields),
          redefinesDetail: requested.agent === 'codex',
        },
        windowRead: windowReadReport(message.id),
      });
    }
  } catch (error) {
    if (
      message.request.kind === 'metadata-recovery' &&
      metadataRecovery?.sessionId === message.request.session.sessionId
    ) {
      metadataRecovery = null;
    }
    if (!controller.signal.aborted)
      parentPort?.postMessage({
        id: message.id,
        error: workerErrorIdentity(error),
        windowRead: windowReadReport(message.id),
      });
  } finally {
    requests.delete(message.id);
    windowReads.delete(message.id);
    if (activeKinds[kind]! > 1) activeKinds[kind]!--;
    else delete activeKinds[kind];
    for (const read of windowReads.values()) countKind(read.report.during.finished, kind);
  }
}

type WorkerMessage = {
  id: number;
  generation: number;
  request: ProgressiveRequest;
  cancel?: number;
  metadataEligible?: string[];
};
let activeDiscovery = false;
let waitingDiscovery: WorkerMessage | undefined;
function runDiscovery(message: WorkerMessage): void {
  activeDiscovery = true;
  void handleMessage(message).finally(() => {
    if (!waitingDiscovery) {
      activeDiscovery = false;
      return;
    }
    setImmediate(() => {
      const waiting = waitingDiscovery;
      waitingDiscovery = undefined;
      activeDiscovery = false;
      if (waiting) runDiscovery(waiting);
    });
  });
}
// Bounded reads skip the records that the repeated-record map does not reach yet, and request background
// completion of the map. When a map reaches the end of its file, the host reads that file again and draws once.
onClaudeRepeatedCoverage((file) => {
  dispatchFacts.delete(file);
  noteBackground('repeatedCoverage');
  parentPort?.postMessage({ repeatedCoverage: file });
});
parentPort?.on(
  'message',
  (message: {
    id: number;
    generation: number;
    request: ProgressiveRequest;
    cancel?: number;
    metadataEligible?: string[];
    dispatchSpendEntries?: Array<[string, CodexDispatchSpendEntry]>;
    repeated?: { file: string; map: ClaudeRepeatedHeldMap };
  }) => {
    if (message.dispatchSpendEntries) {
      for (const [file, entry] of message.dispatchSpendEntries) retainCodexDispatchSpend(file, entry);
      return;
    }
    if (message.repeated) adoptClaudeRepeatedMap(message.repeated.file, message.repeated.map);
    if (message.metadataEligible) {
      if (metadataRecovery && !message.metadataEligible.includes(metadataRecovery.sessionId)) metadataRecovery = null;
      return;
    }
    if (message.cancel !== undefined) {
      if (waitingDiscovery?.id === message.cancel) {
        parentPort?.postMessage({ id: waitingDiscovery.id });
        waitingDiscovery = undefined;
      }
      void handleMessage({ ...message });
      return;
    }
    if (message.request.kind === 'claude-children') {
      if (activeDiscovery) {
        if (waitingDiscovery) parentPort?.postMessage({ id: waitingDiscovery.id });
        waitingDiscovery = message;
      } else runDiscovery(message);
      return;
    }
    void handleMessage(message);
  },
);
