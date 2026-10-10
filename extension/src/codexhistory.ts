import {
  codexDispatchCursor,
  codexDispatchRecord,
  codexCommitRepositoryPairs,
  completedCommand,
  completedFileChange,
  codexChangePaths,
  openingRecordOf,
  recordedDatePredatesOpening,
  parseRecord,
  CODEX_COMMIT_REPOSITORY_PARSER_VERSION,
  type CodexDispatchCursor,
  CodexReadOptions,
  CodexSessionMeta,
  CodexSessionParserState,
  codexSessionLineMayAffectRead,
  createCodexSessionReducer,
  createCodexUsageLineReducer,
  emptyCodexUsageReducerState,
  readCodexSessionMeta,
} from './codex';
import * as fs from 'node:fs';
import { revisionOf } from './transcript';
import {
  normalizeSessionTitle,
  normalizeFsPath,
  ownershipMutationPaths,
  recordCommits,
  sameCommitSha,
  worktreeRelationships,
  type FileRevision,
  readPreviousLines,
  type BackwardLineCursor,
  type WorktreeRelationship,
} from './transcript';
import {
  ForwardParserCheckpoint,
  IncrementalSessionResult,
  SemanticHistoryOptions,
  SemanticEvidenceClaim,
  SemanticHistoryResult,
  SemanticSourceAdapter,
  SourceHistoryCursor,
  readForwardSession,
  readForwardSessionAsync,
  ForwardReadOptions,
  readSemanticHistoryPage,
  readSemanticHistoryPageAsync,
} from './history';
import { BACKGROUND_SCAN_BYTES, BACKGROUND_SCAN_MILLISECONDS } from './parserstate';

interface CodexBackwardState {
  meta: CodexSessionMeta | null;
  copiedTurnIds: string[];
  copiedTurnRanges: Array<{ id: string; start: number; end: number } | null>;
  resolvedLegacyRanges: string[];
  evidenceTurnOffsets: Record<string, number>;
  evidenceReachedBeginning: boolean;
}

export type CodexForwardCheckpoint = ForwardParserCheckpoint<CodexSessionParserState> & {
  modelRecovery?: CodexModelRecovery;
};
interface CodexModelRecovery {
  boundary: number;
  cursor: BackwardLineCursor;
  status: 'pending' | 'complete';
  model: string | null;
  candidate: { text: string; turnId: string | null } | null;
  ownershipTurnId?: string;
  admittedModel?: string;
}
export type CodexHistoryCursor = SourceHistoryCursor<CodexBackwardState>;
export type CodexHistoryPageResult = SemanticHistoryResult<CodexBackwardState>;

const DEFAULT_TAIL_BYTES = 4 * 1024 * 1024;
const EVIDENCE_TURN_LIMIT = 64;

export const COMMIT_REPOSITORY_PARSER_VERSION = CODEX_COMMIT_REPOSITORY_PARSER_VERSION;
export const COMMIT_REPOSITORY_REQUEST_BYTES = 1024 * 1024;
export const COMMIT_REPOSITORY_SOURCE_BYTES = 64 * 1024 * 1024;
export const COMMIT_REPOSITORY_RECORD_BYTES = 4 * 1024 * 1024;
export const COMMIT_REPOSITORY_FACT_LIMIT = 256;

export interface CommitRepositorySource {
  file: string;
  sessionId: string;
  revision: FileRevision;
}
export interface CommitRepositoryRequest {
  parent: CommitRepositorySource;
  child: CommitRepositorySource;
  commits: Array<{ sha: string; at: number; evidenceAt: number; dirs: string[]; turnId: string }>;
  parentBytes: number;
  childBytes: number;
  token: string | null;
  parserVersion: number;
}
interface OwnershipFact {
  offset: number;
  turnId: string | null;
  occurrence: number;
  classified: boolean;
  copied: boolean;
  pendingOwnership: boolean;
  start: number | null;
  end: number | null;
  relationships: WorktreeRelationship[];
  mutations: (string | null)[];
  pairs: Array<{ sha: string; dir: string }>;
  commits: string[];
}
export interface CommitRepositoryCursor {
  source: CommitRepositorySource;
  parentSessionId: string | null;
  offset: number;
  through: number;
  fragment: Buffer;
  queue: Buffer;
  provenance: CodexDispatchCursor;
  facts: OwnershipFact[];
  opening: boolean;
  physicalOpeningAt: number | null;
  incomplete: boolean;
  exhausted: boolean;
  complete: boolean;
  head: Buffer;
  anchor: Buffer;
  readBytes: number;
  neededDirs: string[];
}
export interface CommitRepositoryReply {
  status: 'pending' | 'complete' | 'exhausted' | 'stale' | 'cancelled';
  token: string | null;
  parent: CommitRepositorySource;
  child: CommitRepositorySource;
  parserVersion: number;
  readBytes: { parent: number; child: number };
  covered: { parent: [number, number]; child: [number, number] };
  targets: Array<{ sha: string; dirs: string[]; occurrence: string }>;
}

export function commitRepositoryOccurrence(commit: CommitRepositoryRequest['commits'][number]): string {
  return JSON.stringify([commit.turnId, commit.at, commit.evidenceAt, commit.sha, commit.dirs]);
}

export function commitSourceRevision(source: CommitRepositorySource): boolean {
  try {
    const stat = revisionOf(fs.statSync(source.file, { bigint: true }));
    return Object.entries(source.revision).every(([key, value]) => stat[key as keyof typeof stat] === value);
  } catch {
    return false;
  }
}

export function createCommitRepositoryCursor(
  source: CommitRepositorySource,
  parentSessionId: string | null,
  neededDirs: string[] = [],
): CommitRepositoryCursor {
  return {
    source,
    parentSessionId,
    offset: 0,
    through: 0,
    fragment: Buffer.alloc(0),
    queue: Buffer.alloc(0),
    provenance: codexDispatchCursor('', source.revision.dev, source.revision.ino, source.sessionId),
    facts: [],
    opening: false,
    physicalOpeningAt: null,
    incomplete: false,
    exhausted: false,
    complete: false,
    head: Buffer.alloc(0),
    anchor: Buffer.alloc(0),
    readBytes: 0,
    neededDirs,
  };
}

function ownershipRecord(cursor: CommitRepositoryCursor, line: string): void {
  if (!cursor.opening) {
    const opening = openingRecordOf(line);
    cursor.opening =
      opening?.sessionId === cursor.source.sessionId &&
      (cursor.parentSessionId === null || opening?.parentThreadId === cursor.parentSessionId);
    if (!cursor.opening) cursor.incomplete = true;
    else cursor.physicalOpeningAt = opening?.startedAt ?? null;
  }
  const pendingBefore = cursor.provenance.pendingOwnershipTurnIds;
  codexDispatchRecord(cursor.provenance, line, cursor.source.sessionId, new Set());
  cursor.provenance.candidates = [];
  const record = parseRecord(line);
  if (!record) {
    cursor.incomplete = true;
    return;
  }
  if (
    record.kind === 'token_usage_record' &&
    typeof record.payload.turn_id === 'string' &&
    pendingBefore.includes(record.payload.turn_id) &&
    !cursor.provenance.pendingOwnershipTurnIds.includes(record.payload.turn_id)
  ) {
    for (const fact of cursor.facts) {
      if (fact.turnId !== record.payload.turn_id || !fact.pendingOwnership) continue;
      fact.classified = true;
      fact.copied = false;
      fact.pendingOwnership = false;
    }
  }
  if (record.kind === 'turn_context' && record.payload.turn_id === cursor.provenance.lastTurnId) {
    for (const fact of cursor.facts) {
      if (fact.occurrence !== cursor.provenance.lastOccurrence) continue;
      fact.classified ||= cursor.provenance.currentTurnClassified;
      fact.copied ||=
        cursor.provenance.currentTurnCopied ||
        recordedDatePredatesOpening(record.payload.current_date, cursor.provenance);
      if (
        pendingBefore.includes(fact.turnId ?? '') &&
        !cursor.provenance.pendingOwnershipTurnIds.includes(fact.turnId ?? '')
      )
        fact.pendingOwnership = false;
    }
  }
  const fileChange = record.kind === 'item_completed' ? completedFileChange(record.payload) : null;
  const patch = record.kind === 'patch_apply_end' && record.payload.success !== false;
  if (record.kind !== 'item_completed' && !patch) return;
  const item = patch ? record.payload : (record.payload.item as Record<string, unknown> | undefined);
  if (!item || (!patch && !fileChange && item.type !== 'CommandExecution')) return;
  const command = !patch && !fileChange ? completedCommand(record.payload) : null;
  const relationships = command && !command.failed ? (worktreeRelationships(command.command, command.shell) ?? []) : [];
  const raw = [item.command, ...(Array.isArray(item.parsed_cmd) ? item.parsed_cmd.map((entry) => entry?.cmd) : [])]
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value): value is string => typeof value === 'string');
  const changes = patch ? record.payload.changes : fileChange?.status === 'done' ? fileChange.changes : null;
  const mutations =
    patch || fileChange
      ? codexChangePaths(changes).map((target) =>
          /^(?:[a-z]:[\\/]|\/|\\\\[^\\/]+[\\/][^\\/]+)/i.test(target) ? normalizeFsPath(target) : null,
        )
      : command
        ? ownershipMutationPaths(command.command, command.cwd, command.shell)
        : raw.some((text) => ownershipMutationPaths(text, null).length > 0)
          ? [null]
          : [];
  const pairs =
    cursor.parentSessionId !== null && command && !command.failed
      ? (codexCommitRepositoryPairs(command.stdout) ?? [])
      : [];
  const printed: { commits: import('./transcript').TurnCommit[] } = { commits: [] };
  if (cursor.parentSessionId !== null && command && !command.failed)
    recordCommits(printed, command.stdout, command.completedAt ?? record.at, 'unreadable');
  if (!relationships.length && !mutations.length && !pairs.length && !printed.commits.length) return;
  const duration = item.duration as { secs?: unknown; nanos?: unknown } | undefined;
  const durationMs =
    typeof duration?.secs === 'number' && typeof duration.nanos === 'number'
      ? duration.secs * 1000 + duration.nanos / 1_000_000
      : null;
  const completedAt =
    typeof item.completed_at_ms === 'number' && Number.isFinite(item.completed_at_ms) ? item.completed_at_ms : null;
  const startedAt =
    typeof item.started_at_ms === 'number' && Number.isFinite(item.started_at_ms) ? item.started_at_ms : null;
  const end = command?.completedAt ?? completedAt ?? (record.at > 0 ? record.at : null);
  const start =
    command?.startedAt ??
    startedAt ??
    (end !== null && durationMs !== null && durationMs >= 0 ? end - durationMs : null);
  if (
    cursor.facts.length >= COMMIT_REPOSITORY_FACT_LIMIT ||
    cursor.facts.reduce(
      (total, fact) => total + fact.relationships.length + fact.pairs.length + fact.commits.length,
      0,
    ) +
      relationships.length +
      pairs.length +
      printed.commits.length >
      33
  ) {
    cursor.exhausted = true;
    return;
  }
  cursor.facts.push({
    offset: cursor.through,
    turnId: cursor.provenance.currentTurnId,
    occurrence: cursor.provenance.currentOccurrence,
    classified: cursor.provenance.currentTurnClassified && cursor.provenance.currentTurnId !== null,
    copied: cursor.provenance.currentTurnCopied,
    pendingOwnership:
      !cursor.provenance.currentTurnRepeated &&
      cursor.provenance.pendingOwnershipTurnIds.includes(cursor.provenance.currentTurnId ?? ''),
    start,
    end,
    relationships,
    mutations,
    pairs,
    commits: printed.commits.map((commit) => commit.printedSha ?? commit.sha),
  });
}

// The cursor keeps bytes until a complete UTF-8 record can be classified.
export async function scanCommitRepositorySource(
  cursor: CommitRepositoryCursor,
  allowance: number,
  signal?: AbortSignal,
  now: () => number = Date.now,
): Promise<{ status: CommitRepositoryReply['status']; readBytes: number }> {
  const started = now();
  let charged = 0;
  if (!commitSourceRevision(cursor.source)) return { status: 'stale', readBytes: charged };
  const fd = fs.openSync(cursor.source.file, 'r');
  const read = (position: number, size: number): Buffer | null => {
    if (size > allowance - charged) return null;
    const buffer = Buffer.allocUnsafe(size);
    const count = fs.readSync(fd, buffer, 0, size, position);
    charged += count;
    cursor.readBytes += count;
    return buffer.subarray(0, count);
  };
  try {
    if (cursor.offset > 0) {
      const head = read(0, cursor.head.length);
      const anchor = read(cursor.offset - cursor.anchor.length, cursor.anchor.length);
      // The host admits less than these checks only after earlier requests spend the source's lifetime allowance.
      // A pending reply would return the same admission, and the host would repeat the request without progress.
      if (!head || !anchor) return { status: 'exhausted', readBytes: charged };
      if (!head.equals(cursor.head) || !anchor.equals(cursor.anchor)) return { status: 'stale', readBytes: charged };
    }
    while (!cursor.exhausted) {
      if (signal?.aborted) break;
      const newline = cursor.queue.indexOf(10);
      if (newline >= 0) {
        if (cursor.fragment.length + newline > COMMIT_REPOSITORY_RECORD_BYTES) {
          cursor.exhausted = true;
          break;
        }
        const record = Buffer.concat([cursor.fragment, cursor.queue.subarray(0, newline)]);
        ownershipRecord(cursor, record.toString('utf8').replace(/\r$/, ''));
        cursor.through += record.length + 1;
        cursor.fragment = Buffer.alloc(0);
        cursor.queue = cursor.queue.subarray(newline + 1);
        if (now() - started >= 15 && (cursor.queue.length > 0 || cursor.offset < cursor.source.revision.size)) break;
        continue;
      }
      if (cursor.queue.length) {
        if (cursor.fragment.length + cursor.queue.length > COMMIT_REPOSITORY_RECORD_BYTES) {
          cursor.exhausted = true;
          break;
        }
        cursor.fragment = Buffer.concat([cursor.fragment, cursor.queue]);
        cursor.queue = Buffer.alloc(0);
      }
      if (cursor.offset === cursor.source.revision.size) {
        if (cursor.fragment.length) {
          ownershipRecord(cursor, cursor.fragment.toString('utf8'));
          cursor.through += cursor.fragment.length;
          cursor.fragment = Buffer.alloc(0);
        }
        cursor.complete =
          !cursor.incomplete &&
          cursor.opening &&
          cursor.facts.every((fact) => !fact.pendingOwnership && (fact.classified || fact.copied));
        break;
      }
      const size = Math.min(256 * 1024, cursor.source.revision.size - cursor.offset, allowance - charged);
      if (size <= 0) break;
      const bytes = read(cursor.offset, size);
      if (!bytes?.length) {
        cursor.incomplete = true;
        break;
      }
      cursor.offset += bytes.length;
      if (cursor.head.length < 256) cursor.head = Buffer.concat([cursor.head, bytes]).subarray(0, 256);
      cursor.anchor = Buffer.concat([cursor.anchor, bytes]).subarray(-4096);
      cursor.queue = bytes;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } finally {
    fs.closeSync(fd);
  }
  if (signal?.aborted) return { status: 'cancelled', readBytes: charged };
  if (!commitSourceRevision(cursor.source)) return { status: 'stale', readBytes: charged };
  return {
    status:
      cursor.exhausted ||
      (cursor.offset === cursor.source.revision.size &&
        !cursor.queue.length &&
        !cursor.fragment.length &&
        !cursor.complete)
        ? 'exhausted'
        : cursor.complete
          ? 'complete'
          : 'pending',
    readBytes: charged,
  };
}

function affectsOwnership(target: string | null, dir: string): boolean {
  if (target === null) return true;
  const path = normalizeFsPath(target).replace(/\/$/, '');
  const wanted = normalizeFsPath(dir).replace(/\/$/, '');
  return (
    path === wanted || wanted.startsWith(path + '/') || path === wanted + '/.git' || path.startsWith(wanted + '/.git/')
  );
}

export function commitRepositoryTargets(
  parent: CommitRepositoryCursor,
  child: CommitRepositoryCursor,
  commits: CommitRepositoryRequest['commits'],
): CommitRepositoryReply['targets'] {
  if (!parent.complete || !child.complete || parent.exhausted || child.exhausted) return [];
  const own = (fact: OwnershipFact) => fact.classified && !fact.copied;
  const targets: CommitRepositoryReply['targets'] = [];
  for (const commit of commits) {
    const executions = child.facts.filter(
      (fact) =>
        own(fact) &&
        fact.turnId === commit.turnId &&
        fact.end !== null &&
        fact.end <= commit.at &&
        fact.commits.some((sha) => sameCommitSha(sha, commit.sha)),
    );
    if (executions.length !== 1) continue;
    const execution = executions[0];
    if (
      execution.start === null ||
      execution.end === null ||
      execution.start > execution.end ||
      (child.physicalOpeningAt !== null && execution.start < child.physicalOpeningAt)
    )
      continue;
    const through = Math.max(commit.at, commit.evidenceAt);
    const pairs = child.facts
      .filter((fact) => own(fact) && fact.turnId === commit.turnId)
      .flatMap((fact) =>
        fact.pairs
          .filter((pair) => pair.sha === commit.sha && fact.end !== null && fact.end <= through)
          .map((pair) => ({ pair, fact })),
      );
    const dirs = new Set<string>();
    let complete = commit.dirs.length > 0 && commit.dirs.length <= 33;
    for (const dir of commit.dirs) {
      const paired = pairs.filter(({ pair }) => normalizeFsPath(pair.dir) === normalizeFsPath(dir));
      if (
        !paired.length ||
        paired.some(
          ({ fact }) =>
            fact.start === null ||
            fact.end === null ||
            fact.start > fact.end ||
            (child.physicalOpeningAt !== null && fact.start < child.physicalOpeningAt),
        )
      ) {
        complete = false;
        break;
      }
      const creations = parent.facts
        .filter(own)
        .flatMap((fact) =>
          fact.relationships
            .filter((relationship) => normalizeFsPath(relationship.dir) === normalizeFsPath(dir))
            .map((relationship) => ({ relationship, fact })),
        );
      if (creations.length !== 1) {
        complete = false;
        break;
      }
      const creation = creations[0];
      if (
        creation.fact.start === null ||
        creation.fact.end === null ||
        creation.fact.start > creation.fact.end ||
        creation.fact.end >= execution.start
      ) {
        complete = false;
        break;
      }
      const parentChanged = parent.facts
        .filter(own)
        .some(
          (fact) =>
            fact !== creation.fact &&
            fact.mutations.some(
              (target) => affectsOwnership(target, dir) || affectsOwnership(target, creation.relationship.repository),
            ) &&
            (fact.start === null ||
              fact.end === null ||
              fact.start > fact.end ||
              (fact.start <= commit.at && fact.end >= creation.fact.start!)),
        );
      const childChanged = child.facts
        .filter(own)
        .some(
          (fact) =>
            fact.mutations.some(
              (target) => affectsOwnership(target, dir) || affectsOwnership(target, creation.relationship.repository),
            ) &&
            (fact.start === null || fact.end === null || fact.start > fact.end || fact.start <= through),
        );
      if (parentChanged || childChanged) {
        complete = false;
        break;
      }
      dirs.add(creation.relationship.repository);
    }
    if (complete) targets.push({ sha: commit.sha, dirs: [...dirs], occurrence: commitRepositoryOccurrence(commit) });
  }
  return targets;
}

function codexParserKey(opts: CodexReadOptions): string {
  return JSON.stringify({
    version: 11,
    tailBytes: opts.tailBytes ?? DEFAULT_TAIL_BYTES,
    maxTurns: opts.maxTurns ?? 40,
    sessionTitle: normalizeSessionTitle(opts.sessionTitle),
  });
}

export function readCodexSessionIncremental(
  file: string,
  sessionId: string,
  checkpoint?: CodexForwardCheckpoint,
  opts: CodexReadOptions = {},
): IncrementalSessionResult<CodexSessionParserState> {
  let meta: CodexSessionMeta | null | undefined;
  const result = readForwardSession(
    file,
    'codex',
    sessionId,
    (restored) => {
      if (!restored && meta === undefined) {
        meta = readCodexSessionMeta(file);
      }
      return createCodexSessionReducer(sessionId, opts, restored ? null : (meta ?? null), restored);
    },
    checkpoint,
    undefined,
    codexParserKey(opts),
    opts.tailBytes ?? DEFAULT_TAIL_BYTES,
  );
  return result;
}

export async function readCodexSessionIncrementalAsync(
  file: string,
  sessionId: string,
  checkpoint?: CodexForwardCheckpoint,
  opts: CodexReadOptions = {},
  work: ForwardReadOptions & {
    modelBudget?: { maxBytes?: number; maxMilliseconds?: number; clock?: () => number };
  } = {},
): Promise<IncrementalSessionResult<CodexSessionParserState> & { recoveryBytes?: number; recoveryPending?: boolean }> {
  let meta: CodexSessionMeta | null | undefined;
  const result = await readForwardSessionAsync(
    file,
    'codex',
    sessionId,
    (restored) => {
      if (!restored && meta === undefined) {
        meta = readCodexSessionMeta(file);
      }
      return createCodexSessionReducer(sessionId, opts, restored ? null : (meta ?? null), restored);
    },
    checkpoint,
    undefined,
    codexParserKey(opts),
    opts.tailBytes ?? DEFAULT_TAIL_BYTES,
    work,
  );
  if (!result.read) return result;
  const next = result.checkpoint as CodexForwardCheckpoint;
  const newest = result.read.turns.at(-1);
  if (!newest?.interrupted || newest.model || result.read.lastReportedModel) return result;
  const previous = checkpoint?.modelRecovery;
  const sameIdentity =
    previous &&
    next.revision.dev === previous.cursor.revision.dev &&
    next.revision.ino === previous.cursor.revision.ino;
  const compatible =
    previous &&
    sameIdentity &&
    result.kind !== 'reset' &&
    ((next.revision.size === previous.cursor.revision.size &&
      next.revision.mtimeMs === previous.cursor.revision.mtimeMs) ||
      (result.kind === 'appended' &&
        next.reducedFrom === previous.boundary &&
        result.appendFrom?.size === previous.cursor.revision.size &&
        result.appendFrom?.mtimeMs === previous.cursor.revision.mtimeMs));
  const boundary = next.reducedFrom ?? next.coveredFrom;
  const fragment = next.skippedFragment ?? Buffer.alloc(0);
  const recovery: CodexModelRecovery =
    compatible && previous
      ? {
          ...previous,
          cursor: { ...previous.cursor, revision: next.revision, fragment: Buffer.from(previous.cursor.fragment) },
        }
      : {
          boundary,
          cursor: {
            revision: next.revision,
            end: boundary,
            fragment: Buffer.from(fragment.subarray(0, 256 * 1024)),
            discardedFragment: fragment.length > 256 * 1024,
          },
          status: boundary === 0 ? 'complete' : 'pending',
          model: null,
          candidate: null,
        };
  const clock = work.modelBudget?.clock ?? (() => performance.now());
  const deadline = clock() + (work.modelBudget?.maxMilliseconds ?? BACKGROUND_SCAN_MILLISECONDS);
  const maxBytes = Math.max(1, work.modelBudget?.maxBytes ?? BACKGROUND_SCAN_BYTES);
  let recoveryBytes = 0;
  while (recovery.status === 'pending' && recovery.cursor.end > 0 && recoveryBytes < maxBytes && clock() < deadline) {
    if (work.signal?.aborted)
      return { kind: 'cancelled', read: null, checkpoint: null, readBytes: result.readBytes, recoveryBytes };
    const before = recovery.cursor.end;
    const batch = readPreviousLines(
      file,
      recovery.cursor,
      Math.min(256 * 1024, maxBytes - recoveryBytes),
      undefined,
      256 * 1024,
    );
    if (!batch) return { kind: 'stale', read: null, checkpoint: null, readBytes: result.readBytes, recoveryBytes };
    recoveryBytes += before - batch.cursor.end;
    recovery.cursor = batch.cursor;
    for (const line of batch.lines) {
      if (line.oversized) {
        const outerKind =
          /^\s*\{\s*"type"\s*:\s*"([^"]+)"/.exec(line.text)?.[1] ??
          /"type"\s*:\s*"([^"]+)"\s*,\s*"payload"\s*:/.exec(line.text)?.[1];
        const kind =
          outerKind === 'event_msg' ? /"payload"\s*:\s*\{\s*"type"\s*:\s*"([^"]+)"/.exec(line.text)?.[1] : outerKind;
        if (
          !kind ||
          (!recovery.admittedModel && (kind === 'turn_context' || kind === 'thread_settings_applied')) ||
          kind === 'task_started' ||
          kind === 'session_meta'
        ) {
          recovery.status = 'complete';
          recovery.candidate = null;
          recovery.admittedModel = undefined;
          break;
        }
        continue;
      }
      const record = parseRecord(line.text);
      if (!record) continue;
      if (recovery.admittedModel) {
        if (record.kind === 'task_started' && record.payload.turn_id === recovery.ownershipTurnId) {
          recovery.status = 'complete';
          recovery.admittedModel = undefined;
          break;
        }
        if (record.kind === 'session_meta') {
          meta ??= readCodexSessionMeta(file);
          if ((record.payload.id ?? record.payload.session_id) === meta?.sessionId)
            recovery.model = recovery.admittedModel;
          recovery.status = 'complete';
          break;
        }
        continue;
      }
      if (!recovery.candidate && (record.kind === 'turn_context' || record.kind === 'thread_settings_applied')) {
        const settings = record.kind === 'turn_context' ? record.payload : record.payload.thread_settings;
        if (
          settings &&
          typeof settings === 'object' &&
          (('model' in settings && typeof settings.model === 'string' && settings.model.length > 0) ||
            ('model_id' in settings && typeof settings.model_id === 'string' && settings.model_id.length > 0))
        )
          recovery.candidate = {
            text: line.text,
            turnId:
              record.kind === 'turn_context' && typeof record.payload.turn_id === 'string'
                ? record.payload.turn_id
                : null,
          };
      } else if (recovery.candidate && record.kind === 'task_started') {
        if (recovery.candidate.turnId !== null && record.payload.turn_id !== recovery.candidate.turnId) {
          recovery.status = 'complete';
          break;
        }
        meta ??= readCodexSessionMeta(file);
        const reducer = createCodexSessionReducer(sessionId, { maxTurns: 1 }, meta ?? null);
        reducer.pushLine(line.text);
        reducer.pushLine(recovery.candidate.text);
        const admitted = reducer.finish().lastReportedModel;
        if (admitted) {
          recovery.admittedModel = admitted;
          recovery.ownershipTurnId = typeof record.payload.turn_id === 'string' ? record.payload.turn_id : undefined;
          recovery.candidate = null;
          continue;
        }
        if (
          reducer.snapshot().usageState.pendingOwnership[record.payload.turn_id as string] ||
          !reducer.snapshot().usageState.currentTurnCopied
        ) {
          recovery.status = 'complete';
          break;
        }
        recovery.candidate = null;
      } else if (record.kind === 'session_meta') {
        meta ??= readCodexSessionMeta(file);
        if (
          recovery.candidate?.turnId === null &&
          (record.payload.id ?? record.payload.session_id) === meta?.sessionId
        ) {
          const reducer = createCodexSessionReducer(sessionId, { maxTurns: 1 }, meta ?? null);
          reducer.pushLine(line.text);
          reducer.pushLine(recovery.candidate.text);
          recovery.model = reducer.finish().lastReportedModel ?? null;
        }
        recovery.status = 'complete';
        break;
      }
    }
  }
  if (work.signal?.aborted)
    return { kind: 'cancelled', read: null, checkpoint: null, readBytes: result.readBytes, recoveryBytes };
  if (recovery.cursor.end === 0 && recovery.status === 'pending') {
    if (recovery.admittedModel) recovery.model = recovery.admittedModel;
    recovery.status = 'complete';
  }
  if (recovery.status === 'complete') {
    recovery.cursor.fragment = Buffer.alloc(0);
    recovery.candidate = null;
  }
  next.modelRecovery = recovery;
  next.skippedFragment = Buffer.alloc(0);
  result.read.lastReportedModel = recovery.model;
  return { ...result, recoveryBytes, recoveryPending: recovery.status === 'pending' };
}

function codexAdapter(
  sessionId: string,
  opts: CodexReadOptions,
  initialMeta: CodexSessionMeta | null | undefined,
  targetTurns: number,
): SemanticSourceAdapter<CodexBackwardState> {
  return {
    source: 'codex',
    initialState: (file) => ({
      meta:
        opts.capturedOpening !== undefined
          ? opts.capturedOpening
          : initialMeta === undefined
            ? readCodexSessionMeta(file)
            : initialMeta,
      copiedTurnIds: [],
      copiedTurnRanges: [],
      resolvedLegacyRanges: [],
      evidenceTurnOffsets: {},
      evidenceReachedBeginning: false,
    }),
    accepts: (record) => codexSessionLineMayAffectRead(record.text),
    parse: (records, backward) => {
      const reducer = createCodexSessionReducer(
        sessionId,
        { ...opts, maxTurns: Number.MAX_SAFE_INTEGER },
        backward.meta,
      );
      const classifier = createCodexUsageLineReducer(
        emptyCodexUsageReducerState(
          backward.meta?.modelProvider ?? null,
          backward.meta?.replayBoundaryAt ?? null,
          backward.meta?.sessionId ?? null,
          backward.meta?.agentPath ?? null,
          backward.meta?.nativeSpawnedAt ?? null,
        ),
      );
      for (const record of records) {
        reducer.pushLine(record);
        classifier.pushLine(record.text);
      }
      const snapshot = reducer.snapshot();
      const localCopied = Object.keys(classifier.snapshot().datedCopiedTurnIds);
      const copied = backward.copiedTurnIds.map((id, index) => ({
        id,
        range: backward.copiedTurnRanges[index] ?? null,
      }));
      for (const id of localCopied) {
        if (!copied.some((entry) => entry.id === id)) {
          copied.push({ id, range: null });
        }
      }
      const turns = reducer.completedTurns();
      const removed = new Set<number>();
      const copiedTurnRanges: CodexBackwardState['copiedTurnRanges'] = [];
      for (const copiedTurn of copied) {
        let match = -1;
        if (copiedTurn.range) {
          match = turns.findIndex(
            (turn, index) =>
              !removed.has(index) && turn.start === copiedTurn.range!.start && turn.end === copiedTurn.range!.end,
          );
        } else {
          for (let index = turns.length - 1; index >= 0; index--) {
            if (!removed.has(index) && turns[index].turn.promptId === copiedTurn.id) {
              match = index;
              break;
            }
          }
        }
        if (match >= 0) {
          removed.add(match);
          copiedTurnRanges.push({ id: copiedTurn.id, start: turns[match].start, end: turns[match].end });
        } else {
          copiedTurnRanges.push(copiedTurn.range);
        }
      }
      const visibleTurns = turns.filter((_turn, index) => !removed.has(index));
      const remainingPending = new Map<string, number>();
      for (const id of snapshot.pendingClassification) {
        remainingPending.set(id, (remainingPending.get(id) ?? 0) + 1);
      }
      const pendingIndexes = new Set<number>();
      for (let index = visibleTurns.length - 1; index >= 0; index--) {
        const id = visibleTurns[index].turn.promptId;
        const remaining = remainingPending.get(id) ?? 0;
        if (remaining <= 0) {
          continue;
        }
        pendingIndexes.add(index);
        remainingPending.set(id, remaining - 1);
      }
      const resolved = new Set(backward.resolvedLegacyRanges);
      const olderEvidence: SemanticEvidenceClaim[] =
        visibleTurns.length >= targetTurns + 1
          ? [...pendingIndexes]
              .map((index) => ({
                key: `${visibleTurns[index].start}:${visibleTurns[index].end}`,
                value: visibleTurns[index].turn.promptId,
              }))
              .filter((claim) => claim.value.length > 0)
              .filter((claim) => !resolved.has(claim.key))
          : [];
      const oldestPendingIndex = pendingIndexes.size ? Math.min(...pendingIndexes) : -1;
      const openRange = reducer.openRange();
      const candidate = opts.captureSessionText && openRange ? (reducer.read().turns.at(-1) ?? null) : null;
      const unfinished = candidate?.promptId === snapshot.open?.promptId ? candidate : null;
      return {
        turns: visibleTurns,
        compactions: reducer.completedCompactions(),
        openRange,
        ...(opts.captureSessionText
          ? { unfinished: unfinished && openRange ? { turn: unfinished, ...openRange } : null }
          : {}),
        adapterState: {
          meta: backward.meta,
          copiedTurnIds: copied.map((entry) => entry.id),
          copiedTurnRanges,
          resolvedLegacyRanges: backward.resolvedLegacyRanges,
          evidenceTurnOffsets: backward.evidenceTurnOffsets ?? {},
          evidenceReachedBeginning: backward.evidenceReachedBeginning ?? false,
        },
        olderEvidence,
        deferOlderEvidence:
          olderEvidence.length > 0 && oldestPendingIndex === 0 && olderEvidence.length < EVIDENCE_TURN_LIMIT,
      };
    },
    scanOlderEvidence: (records, claims, backward, atBeginning) => {
      const found = new Set<string>();
      const evidenceTurnOffsets = { ...(backward.evidenceTurnOffsets ?? {}) };
      let trackedTurns = Object.keys(evidenceTurnOffsets).length;
      for (const claim of claims) {
        if (Object.hasOwn(evidenceTurnOffsets, claim.value) || trackedTurns >= EVIDENCE_TURN_LIMIT) {
          continue;
        }
        evidenceTurnOffsets[claim.value] = Number.MAX_SAFE_INTEGER;
        trackedTurns++;
      }
      for (const record of records) {
        if (record.text.indexOf('task_started') < 0) {
          continue;
        }
        try {
          const parsed = JSON.parse(record.text) as { type?: unknown; payload?: Record<string, unknown> };
          const payload = parsed.payload;
          if (!payload || (parsed.type !== 'event_msg' && parsed.type !== 'task_started')) {
            continue;
          }
          const kind = parsed.type === 'event_msg' ? payload.type : parsed.type;
          if (kind === 'task_started' && typeof payload.turn_id === 'string' && payload.turn_id.length > 0) {
            const id = payload.turn_id;
            found.add(id);
            if (Object.hasOwn(evidenceTurnOffsets, id)) {
              evidenceTurnOffsets[id] = Math.min(evidenceTurnOffsets[id], record.start);
            } else if (trackedTurns < EVIDENCE_TURN_LIMIT) {
              evidenceTurnOffsets[id] = record.start;
              trackedTurns++;
            }
          }
        } catch {
          /* malformed records do not classify a turn */
        }
      }
      const copiedTurnIds = [...backward.copiedTurnIds];
      const copiedTurnRanges = [...backward.copiedTurnRanges];
      const resolvedLegacyRanges = [...backward.resolvedLegacyRanges];
      const remaining: SemanticEvidenceClaim[] = [];
      for (const claim of claims) {
        const separator = claim.key.indexOf(':');
        const start = Number(claim.key.slice(0, separator));
        const end = Number(claim.key.slice(separator + 1));
        const earlierOffset = evidenceTurnOffsets[claim.value];
        if (
          found.has(claim.value) ||
          (Number.isFinite(start) && earlierOffset !== undefined && earlierOffset < start)
        ) {
          copiedTurnIds.push(claim.value);
          copiedTurnRanges.push(
            Number.isFinite(start) && Number.isFinite(end) ? { id: claim.value, start, end } : null,
          );
          resolvedLegacyRanges.push(claim.key);
        } else if (atBeginning || (backward.evidenceReachedBeginning && earlierOffset === start)) {
          resolvedLegacyRanges.push(claim.key);
        } else {
          remaining.push(claim);
        }
      }
      return {
        adapterState: {
          meta: backward.meta,
          copiedTurnIds,
          copiedTurnRanges,
          resolvedLegacyRanges,
          evidenceTurnOffsets,
          evidenceReachedBeginning: backward.evidenceReachedBeginning || atBeginning,
        },
        remaining,
      };
    },
    stateForOlder: (parsed, pageStart) => {
      const copiedTurnIds: string[] = [];
      const copiedTurnRanges: CodexBackwardState['copiedTurnRanges'] = [];
      for (let index = 0; index < parsed.adapterState.copiedTurnIds.length; index++) {
        const range = parsed.adapterState.copiedTurnRanges[index] ?? null;
        if (range && range.start >= pageStart) {
          continue;
        }
        copiedTurnIds.push(parsed.adapterState.copiedTurnIds[index]);
        copiedTurnRanges.push(null);
      }
      const resolvedLegacyRanges = parsed.adapterState.resolvedLegacyRanges.filter((key) => {
        const start = Number(key.slice(0, key.indexOf(':')));
        return Number.isFinite(start) && start < pageStart;
      });
      const evidenceTurnOffsets = Object.fromEntries(
        Object.entries(parsed.adapterState.evidenceTurnOffsets ?? {}).filter(([, start]) => start < pageStart),
      );
      return {
        meta: parsed.adapterState.meta,
        copiedTurnIds,
        copiedTurnRanges,
        resolvedLegacyRanges,
        evidenceTurnOffsets,
        evidenceReachedBeginning: parsed.adapterState.evidenceReachedBeginning ?? false,
      };
    },
  };
}

function cursorMetaForSession(
  cursor: CodexHistoryCursor | null,
  sessionId: string,
  exportLimits: SemanticHistoryOptions['exportLimits'],
): CodexSessionMeta | null | undefined {
  return cursor?.source === 'codex' &&
    cursor.sessionId === sessionId &&
    JSON.stringify(cursor.exportLimits) === JSON.stringify(exportLimits)
    ? cursor.adapterState.meta
    : undefined;
}

export function readCodexHistoryPage(
  file: string,
  sessionId: string,
  cursor: CodexHistoryCursor | null = null,
  options: SemanticHistoryOptions = {},
  readOptions: CodexReadOptions = {},
): CodexHistoryPageResult {
  return readSemanticHistoryPage(
    file,
    sessionId,
    codexAdapter(
      sessionId,
      options.exportLimits
        ? { ...readOptions, captureSessionText: true, exportTurnBytes: options.exportLimits.turnBytes }
        : readOptions,
      cursorMetaForSession(cursor, sessionId, options.exportLimits),
      options.exportLimits ? 1 : Math.max(1, options.targetTurns ?? 20),
    ),
    cursor,
    options,
  );
}

export function readCodexHistoryPageAsync(
  file: string,
  sessionId: string,
  cursor: CodexHistoryCursor | null = null,
  options: SemanticHistoryOptions = {},
  readOptions: CodexReadOptions = {},
): Promise<CodexHistoryPageResult> {
  return readSemanticHistoryPageAsync(
    file,
    sessionId,
    codexAdapter(
      sessionId,
      options.exportLimits
        ? { ...readOptions, captureSessionText: true, exportTurnBytes: options.exportLimits.turnBytes }
        : readOptions,
      cursorMetaForSession(cursor, sessionId, options.exportLimits),
      options.exportLimits ? 1 : Math.max(1, options.targetTurns ?? 20),
    ),
    cursor,
    options,
  );
}
