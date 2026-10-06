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
  readCodexDispatchedSpend,
  scanForCodexPerson,
  type CodexPersonScan,
  readCodexSessionActivity,
  createCodexSessionReducer,
  codexSessionLineMayAffectRead,
  readCodexSessionTitlePair,
  readCodexTurnStarts,
  refreshCodexStructuralAgents,
  scanCodexDispatchReferences,
} from './codex';
import { historyPageBytes } from './historypages';
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
  type FileRevision,
  type PersonScan,
  type Turn,
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
import type { DispatchSessionFacts } from './progressiveworker';
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
  }
>();
const DISPATCH_METADATA_BYTES = 256 * 1024;
export const CODEX_DISPATCH_REQUEST_BYTES = 8 * 1024 * 1024;
let discoveryEpoch: DiscoveryCheckpoint | null = null;
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
    const { size, mtimeMs, dev, ino } = fs.statSync(file);
    return { size, mtimeMs, dev, ino };
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

function revive(checkpoint: ProgressiveCheckpoint | undefined): ProgressiveCheckpoint | undefined {
  if (!checkpoint) {
    return undefined;
  }
  checkpoint.lineFragment = Buffer.from(checkpoint.lineFragment);
  if (checkpoint.skippedFragment) checkpoint.skippedFragment = Buffer.from(checkpoint.skippedFragment);
  checkpoint.contentAnchor.bytes = Buffer.from(checkpoint.contentAnchor.bytes);
  return checkpoint;
}

export function exposeClaudeAgentRelationshipIds(turns: Turn[]): void {
  for (const turn of turns) {
    turn.agents = turn.agents.map((agent) => (agent.toolUseId ? { ...agent, toolUseId: agent.toolUseId } : agent));
  }
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
              : createClaudeSessionReducer(session.sessionId, {
                  maxTurns: 40,
                  childTranscript: session.childTranscript,
                }),
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
    const completed = new Set(epoch.completed);
    const completionChanges = new Map<string, boolean>();
    let header = request.discovery?.epoch === epoch.epoch ? undefined : { ...epoch, completed: [...completed] };
    const charges: DiscoveryCharges = { readBytes: 0, hits: 0, resets: 0, quanta: 0, dispatchRetries: 0 };
    let continuation = false;
    let incomplete = false;
    const candidates = new Map<string, import('./transcript').SessionFile>();
    const walk = () => {
      candidates.clear();
      try {
        return discoverClaudeChildSessions(
          epoch.parents,
          epoch.repositoryRoots,
          (parent) => {
            const key = normalizeFsPath(parent.file);
            candidates.set(key, parent);
            const entry = claudeChildReferences.get(key);
            return entry?.complete === true || entry?.source === 'codex' ? entry.references : [];
          },
          claudeChildSessions,
        );
      } catch {
        incomplete = true;
        return { references: [], children: [] };
      }
    };
    const pending = (source?: string) => {
      epoch.sequence++;
      // Request boundaries return whole checkpoints. Quanta reuse the host's frozen header.
      if (source) {
        const value = {
          kind: 'claude-children-delta' as const,
          referenceEntries: [[source, claudeChildReferences.get(source)!] as [string, ClaudeChildReferenceCacheEntry]],
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
      epoch.completed = [...completed];
      return {
        kind: 'claude-children-progress' as const,
        referenceEntries: limitCodexDispatchCursors(claudeChildReferences),
        checkpoint: epoch,
        continuation: true as const,
        charges,
      };
    };
    let found = walk();
    if (epoch.protectedFile && !candidates.has(epoch.protectedFile)) delete epoch.protectedFile;
    const requestBytes = Math.min(request.discoveryBytes ?? CODEX_DISPATCH_REQUEST_BYTES, CODEX_DISPATCH_REQUEST_BYTES);
    const quantumBytes = Math.min(request.quantumBytes ?? 1024 * 1024, 1024 * 1024);
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
      const revision = revisionOf(parent.file);
      if (!revision) {
        if (missingFile(parent.file)) {
          completed.add(key);
          completionChanges.set(key, true);
          claudeChildReferences.delete(key);
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
      if (
        identity &&
        held &&
        sameRevision(held, revision) &&
        (held.complete === true || (held.source === 'codex' && held.visitedEof === true))
      ) {
        charges.hits++;
        completed.add(key);
        completionChanges.set(key, true);
        continue;
      }
      const allowance = Math.min(
        parent.agent === 'codex' ? requestBytes : quantumBytes,
        requestBytes - charges.readBytes,
      );
      if (allowance <= (parent.agent === 'codex' ? 8192 : 16384) || signal.aborted) {
        if (parent.agent === 'codex' && !signal.aborted) {
          epoch.position = rows.findIndex(([file]) => file === key);
          continuation = true;
          break;
        }
        return pending();
      }
      try {
        let references: import('./transcript').ClaudeChildSessionReference[];
        let complete: boolean;
        let cursor: import('./codex').CodexDispatchCursor | undefined;
        let claudeCursor: import('./transcript').ClaudeRelationshipCursor | undefined;
        let reset = !identity;
        let readBytes: number;
        if (parent.agent === 'codex') {
          const scan = scanCodexDispatchReferences(
            parent.file,
            parent.sessionId,
            identity ? (held?.cursor ?? null) : null,
            allowance,
            () => signal.aborted,
          );
          cursor = scan.cursor;
          complete = scan.complete;
          references = scan.complete
            ? scan.references
            : [
                ...(identity && held
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
          readBytes = scan.readBytes;
          reset ||=
            !!held?.cursor &&
            (cursor.dev !== held.cursor.dev || cursor.ino !== held.cursor.ino || cursor.offset < held.cursor.offset);
        } else {
          const scan = await scanClaudeRelationshipQuantum(
            parent,
            identity ? held?.claudeCursor : undefined,
            allowance,
            signal,
          );
          claudeCursor = scan.cursor;
          complete = scan.complete;
          references = scan.references;
          readBytes = scan.readBytes;
          reset ||= scan.reset;
        }
        charges.readBytes += readBytes;
        charges.quanta++;
        charges.resets += Number(reset && !!held);
        const compatible = identity && held && onlyGrew(held, revision) && !reset;
        const reachedTarget = cursor ? cursor.offset === revision.size : claudeCursor!.offset === claudeCursor!.target;
        const accepted = complete || reachedTarget || (compatible && held.complete === true);
        claudeChildReferences.set(key, {
          sourceGeneration: (held?.sourceGeneration ?? 0) + Number(reset || !held),
          sequence: (held?.sequence ?? 0) + 1,
          parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
          source: parent.agent,
          ...revision,
          // A Codex scan that reaches the end of the file describes the current revision. The stored size then matches the next
          // stat, so a parent that stops growing lets discovery settle.
          size:
            complete && claudeCursor
              ? claudeCursor.target
              : compatible && !(cursor && reachedTarget)
                ? held.size
                : revision.size,
          mtimeMs:
            complete || (cursor && reachedTarget) ? revision.mtimeMs : compatible ? held.mtimeMs : revision.mtimeMs,
          sessionId: parent.sessionId,
          childTranscript: parent.childTranscript === true,
          complete: parent.agent === 'codex' ? complete : accepted,
          visitedEof: reachedTarget,
          cursor,
          claudeCursor,
          references:
            parent.agent === 'codex' || complete || reachedTarget ? references : compatible ? held.references : [],
          pendingReferences: complete ? undefined : references,
          relationshipComplete: complete,
          appliedCut:
            complete || reachedTarget
              ? (claudeCursor?.applied ??
                (cursor!.terminalApplied
                  ? cursor!.offset
                  : (cursor!.fragmentStart ?? cursor!.offset - Buffer.byteLength(cursor!.fragment, 'base64'))))
              : compatible
                ? held.appliedCut
                : undefined,
          validatedRevision: revision,
          ...(reset && held ? { resetReason: 'source generation changed' } : {}),
        });
        if (reset) dispatchFacts.delete(parent.file);
        pendingBytes += pendingCharge(claudeChildReferences.get(key)) - pendingCharge(held);
        if (!reachedTarget && claudeCursor && pendingBytes > 64 * 1024 * 1024) epoch.protectedFile ??= key;
        if (accepted || parent.agent === 'codex') {
          completed.add(key);
          completionChanges.set(key, true);
        }
        if (reachedTarget && epoch.protectedFile === key) delete epoch.protectedFile;
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
        continuation ||= !reachedTarget;
        if (parent.agent === 'claude') acknowledge?.(pending(key));
      } catch (error) {
        incomplete = true;
        claudeChildReferences.set(key, {
          ...(held ?? { ...revision, references: [] }),
          parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
          source: parent.agent,
          sessionId: parent.sessionId,
          childTranscript: parent.childTranscript === true,
          complete: false,
          resetReason: error instanceof Error ? error.message : 'Source unavailable',
        });
        completed.delete(key);
        completionChanges.set(key, false);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    found = walk();
    if (incomplete || [...candidates].some(([key, parent]) => parent.agent === 'claude' && !completed.has(key)))
      return pending();
    for (const [file] of candidates) {
      const entry = claudeChildReferences.get(file);
      if (!entry) {
        continuation ||= !missingFile(file);
        continue;
      }
      const current = revisionOf(file);
      if (!onlyGrew(entry, current) || (current!.size === entry.size && current!.mtimeMs !== entry.mtimeMs)) {
        completed.delete(file);
        claudeChildReferences.set(file, {
          ...entry,
          complete: false,
          references: [],
          claudeCursor: undefined,
          cursor: undefined,
          sourceGeneration: (entry.sourceGeneration ?? 0) + 1,
          sequence: (entry.sequence ?? 0) + 1,
        });
        dispatchFacts.delete(candidates.get(file)!.file);
        return pending();
      }
      if (entry.source === 'claude' && entry.claudeCursor && !sameRevision(entry.validatedRevision ?? entry, current)) {
        if (requestBytes - charges.readBytes < 16384) return pending();
        const parent = candidates.get(file)!;
        try {
          const validated = await scanClaudeRelationshipQuantum(parent, entry.claudeCursor, 16384, signal);
          charges.readBytes += validated.readBytes;
          if (validated.reset) {
            charges.resets++;
            completed.delete(file);
            claudeChildReferences.set(file, {
              ...entry,
              complete: false,
              references: [],
              claudeCursor: validated.cursor,
              sourceGeneration: (entry.sourceGeneration ?? 0) + 1,
              sequence: (entry.sequence ?? 0) + 1,
            });
            dispatchFacts.delete(parent.file);
            return pending();
          }
          claudeChildReferences.set(file, { ...entry, claudeCursor: validated.cursor, validatedRevision: current! });
        } catch {
          completed.delete(file);
          return pending();
        }
      }
      continuation ||= !sameRevision(entry, current);
    }
    for (const file of [...claudeChildReferences.keys()]) if (!candidates.has(file)) claudeChildReferences.delete(file);
    const boundedEntries = limitCodexDispatchCursors(claudeChildReferences);
    claudeChildReferences.clear();
    for (const [file, entry] of boundedEntries) claudeChildReferences.set(file, entry);
    continuation ||= JSON.stringify(epoch.parents) !== JSON.stringify(request.parents);
    discoveryPosition = epoch.position;
    discoveryEpoch = null;
    const references = resolveClaudeDispatchReferences(found.references, epoch.catalog);
    const dispatched: DispatchSessionFacts[] = [];
    const seen = new Set<string>();
    const subagentMetas = claudeSubagentMetaReader();
    for (const reference of references) {
      if (reference.kind !== 'dispatch' || !reference.file || seen.has(reference.sessionId)) {
        continue;
      }
      seen.add(reference.sessionId);
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
        now < held.refreshAt &&
        (!held.codexPerson || held.codexPerson.bytes >= revision.size)
      ) {
        dispatched.push(held.facts);
        continue;
      }
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
      const spend: AgentSpend = active
        ? { models: [], found: false, partial: false, effort: null }
        : reference.agent === 'codex'
          ? readCodexDispatchedSpend([reference.file], request.codexChildren ?? [], now, (files) => {
              codexDependencies = files;
            })
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
        sourceIdentity: { dev: revisionOf(session.file)?.dev ?? -1, ino: revisionOf(session.file)?.ino ?? -1 },
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
          exposeClaudeAgentRelationshipIds(page.turns);
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
    if (session.agent === 'claude' && result.kind === 'page') {
      exposeClaudeAgentRelationshipIds(result.page.turns);
    }
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
    if (tail.cursor) {
      if (session.agent === 'claude' && session.childTranscript) {
        result = await read(session.size, undefined);
      } else {
        const discovered =
          session.agent === 'claude'
            ? await discoverClaudeNewestTurn(session.file, tail.cursor, { signal, chunkBytes: 256 * 1024 })
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
  if (session.agent === 'claude') {
    exposeClaudeAgentRelationshipIds(result.read.turns);
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
    ...(session.agent === 'claude'
      ? {
          recoveryBytes,
          recoveryPending: 'recoveryPending' in result && result.recoveryPending === true,
        }
      : {}),
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
let commitParentCursor: import('./codexhistory').CommitRepositoryCursor | null = null;
let commitChildCursor: import('./codexhistory').CommitRepositoryCursor | null = null;
let commitCursorToken: string | null = null;
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
  const clone = (cursor: import('./codexhistory').CommitRepositoryCursor) => {
    const copy = structuredClone(cursor);
    copy.fragment = Buffer.from(copy.fragment);
    copy.queue = Buffer.from(copy.queue);
    copy.head = Buffer.from(copy.head);
    copy.anchor = Buffer.from(copy.anchor);
    return copy;
  };
  const parent =
    commitParentCursor && key(commitParentCursor.source) === key(request.parent)
      ? clone(commitParentCursor)
      : createCommitRepositoryCursor(request.parent, null);
  const child =
    commitChildCursor &&
    key(commitChildCursor.source) === key(request.child) &&
    commitChildCursor.parentSessionId === request.parent.sessionId &&
    request.token === commitCursorToken
      ? clone(commitChildCursor)
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
  if (status === 'pending' || status === 'complete') {
    commitParentCursor = parent;
    commitChildCursor = status === 'pending' ? child : null;
    commitCursorToken = `${++commitCursorSequence}`;
  }
  return {
    kind: 'commit-repositories',
    status,
    token: status === 'pending' || status === 'complete' ? commitCursorToken : null,
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
        if (!controller.signal.aborted)
          parentPort?.postMessage({
            id: message.id,
            progress: true,
            result: { generation: message.generation, revision: null, value },
          });
      });
      if (!controller.signal.aborted) {
        parentPort?.postMessage({ id: message.id, result: { generation: message.generation, revision: null, value } });
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
      });
      return;
    }
    // Read catalog metadata against the revision present when the worker starts.
    // An active session can append after listing.
    // History windows and pages require the exact requested revision.
    const metadataRequest =
      request.kind === 'metadata'
        ? { ...request, session: { ...request.session, size: before.size, mtimeMs: before.mtimeMs } }
        : null;
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
      });
      return;
    }
    const value = await execute(metadataRequest ?? request, controller.signal);
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
      parentPort?.postMessage({ id: message.id, result });
    }
  } catch (error) {
    if (
      message.request.kind === 'metadata-recovery' &&
      metadataRecovery?.sessionId === message.request.session.sessionId
    ) {
      metadataRecovery = null;
    }
    parentPort?.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
  } finally {
    requests.delete(message.id);
  }
}

parentPort?.on(
  'message',
  (message: {
    id: number;
    generation: number;
    request: ProgressiveRequest;
    cancel?: number;
    metadataEligible?: string[];
  }) => {
    if (message.metadataEligible) {
      if (metadataRecovery && !message.metadataEligible.includes(metadataRecovery.sessionId)) metadataRecovery = null;
      return;
    }
    void handleMessage(message);
  },
);
