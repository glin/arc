import * as fs from 'node:fs';
import { readCodexSession, readCodexSessionMeta, CODEX_OPENING_BYTES } from './codex.ts';
import {
  readSession,
  readSessionCwd,
  isInside,
  sameSessionRevision,
  revisionOf,
  supportedFileIdentity,
  type SessionFile,
  type Turn,
  type TurnOutcome,
  type FileRevision,
} from './transcript.ts';
import type { RailStatus, SessionParentEdge } from './turnrail.ts';
import { sessionStatusOf } from './turnrail.ts';
import type { SessionStatus } from './domain/session-query.ts';
import { railStatusRuns } from './domain/session-query.ts';
import { onlyGrew } from './derivedcache.ts';

export const SESSION_READ_LIMITS = { turns: 20, bytes: 512 * 1024, outputBytes: 48 * 1024, sessions: 128 } as const;
export type SessionAttention = Extract<SessionStatus, 'input' | 'unread' | 'running'> | 'idle' | 'unknown';

export interface SessionListingRow {
  id: string;
  provider: SessionFile['agent'];
  name: string;
  setup: { model: string | null; effort: string | null; source: 'recorded' | 'unavailable' };
  labels: { name: string; source: 'reader' }[];
  pinned: boolean;
  archived: boolean;
  runStatus: RailStatus | 'none' | 'unknown';
  attention: SessionAttention;
  lastActivity: number | null;
  parent: { id: string; relation: SessionParentEdge['relation'] | 'reader' } | null;
  agentRun: boolean | null;
  facts: 'current' | 'stale' | 'unparsed';
}

export interface HostedSessionObservation {
  key: string;
  token: number;
  busy: boolean;
  exited: boolean;
}

export interface SessionRunWitness {
  token: number;
  startedAt?: number;
  source?: { file: string; revision: FileRevision };
  exit?: { at: number; revision: FileRevision };
  exitObserved?: boolean;
}

// Accepted physical identity permits growth before the first busy publication.
export function sessionSourceAdmitted(source: SessionFile, revision: FileRevision): boolean {
  if (
    !Number.isSafeInteger(source.size) ||
    source.size < 0 ||
    !Number.isFinite(source.mtimeMs) ||
    source.mtimeMs < 0 ||
    [source.dev, source.ino, revision.dev, revision.ino].some(
      (id) => typeof id === 'string' && !/^(0|[1-9][0-9]*)$/.test(id),
    ) ||
    !Number.isSafeInteger(revision.size) ||
    revision.size < 0 ||
    !Number.isFinite(revision.mtimeMs) ||
    revision.mtimeMs < 0 ||
    (source.dev !== undefined && source.dev !== revision.dev) ||
    (source.ino !== undefined && source.ino !== revision.ino)
  )
    return false;
  const supported = supportedFileIdentity(source) && supportedFileIdentity(revision);
  return supported
    ? onlyGrew({ ...source, dev: source.dev!, ino: source.ino! }, revision)
    : sameSessionRevision(source, revision);
}

// Busy periods share one process lifetime. Only a different instance token replaces ownership.
export function observeSessionRun(
  previous: SessionRunWitness | undefined,
  observation: HostedSessionObservation,
  source: { file: string; revision: FileRevision } | undefined,
  now: number,
): SessionRunWitness {
  const witness = previous?.token === observation.token ? previous : { token: observation.token };
  if (!observation.busy || observation.exited || witness.exitObserved || !Number.isFinite(now) || now <= 0)
    return witness;
  return { ...witness, startedAt: witness.startedAt ?? now, source: witness.source ?? source };
}

// The first exit keeps its revision even when a later catalog accepts changed bytes.
export function observeSessionExit(
  witness: SessionRunWitness,
  revision: FileRevision | undefined,
  now: number,
): SessionRunWitness {
  if (witness.exitObserved) return witness;
  const owned = witness.source?.revision;
  const valid =
    witness.startedAt !== undefined &&
    witness.startedAt > 0 &&
    Number.isFinite(now) &&
    now >= witness.startedAt &&
    owned !== undefined &&
    revision !== undefined &&
    Number.isSafeInteger(revision.size) &&
    revision.size >= 0 &&
    Number.isFinite(revision.mtimeMs) &&
    revision.mtimeMs >= 0 &&
    revision.mtimeMs <= now &&
    owned.dev === revision.dev &&
    owned.ino === revision.ino;
  return { ...witness, exitObserved: true, exit: valid ? { at: now, revision } : undefined };
}

export function sessionExitMatches(
  witness: SessionRunWitness | undefined,
  file: string,
  revision: FileRevision,
  held?: FileRevision,
): boolean {
  const exit = witness?.exit;
  return (
    witness?.source?.file === file &&
    exit !== undefined &&
    exit.revision.size === revision.size &&
    exit.revision.mtimeMs === revision.mtimeMs &&
    exit.revision.dev === revision.dev &&
    exit.revision.ino === revision.ino &&
    (!held || (held.dev === revision.dev && held.ino === revision.ino))
  );
}

// Programmatic status uses held outcomes and native facts without reopening child transcripts.
export function sessionReadStatus(
  id: string,
  outcome: TurnOutcome | null | undefined,
  running: boolean,
  waiting: boolean,
  since: number | undefined,
  exited: number | undefined,
  source: { unchanged: boolean; mtimeMs: number },
): RailStatus | undefined {
  const boundary = since ?? outcome?.startedAt;
  const ended =
    exited !== undefined &&
    boundary !== undefined &&
    boundary > 0 &&
    exited >= boundary &&
    (outcome?.startedAt === undefined || exited >= outcome.startedAt) &&
    source.unchanged &&
    source.mtimeMs >= 0 &&
    source.mtimeMs <= exited;
  const active = running && !ended;
  const observedOutcome = outcome && ended ? { ...outcome, processEndedAt: exited } : outcome;
  const statuses = sessionStatusOf(
    !outcome && ended
      ? [{ sessionId: id, kind: 'turn', startedAt: boundary, processEndedAt: exited, status: 'stopped' }]
      : [],
    active ? new Set([id]) : new Set(),
    observedOutcome ? new Map([[id, observedOutcome]]) : new Map(),
    Date.now(),
    waiting ? new Set([id]) : new Set(),
    since !== undefined ? new Map([[id, since]]) : new Map(),
  );
  const status = statuses.get(id);
  if (status === 'running' && !active) return undefined;
  if (
    status === 'done' &&
    observedOutcome?.processEndedAt === undefined &&
    (outcome?.openChildren?.length || outcome?.closedChildren?.length || outcome?.backgroundCommands?.length)
  )
    return undefined;
  return status;
}

export function sessionAttention(
  visible: boolean,
  status: RailStatus | 'none' | undefined,
  unread: boolean | null,
): SessionAttention {
  if (!visible) return 'unknown';
  if (status === 'waiting') return 'input';
  if (status !== 'none' && railStatusRuns(status)) return 'running';
  if (unread === true) return 'unread';
  return status !== undefined && unread !== null ? 'idle' : 'unknown';
}

export function boundedSessionListing(rows: SessionListingRow[], complete: boolean, requester: string | null) {
  const result = { version: 1, requester, sessions: [] as SessionListingRow[], complete, notes: [] as string[] };
  for (const row of rows) {
    if (result.sessions.length >= SESSION_READ_LIMITS.sessions) {
      result.complete = false;
      break;
    }
    result.sessions.push(row);
    if (Buffer.byteLength(JSON.stringify(result)) > SESSION_READ_LIMITS.outputBytes - 512) {
      result.sessions.pop();
      result.complete = false;
      break;
    }
  }
  if (!result.complete)
    result.notes.push('The session listing is incomplete. Discovery or the response limit excluded sessions.');
  if (rows.some((row) => row.facts !== 'current'))
    result.notes.push('Some session facts are stale or unparsed. Unknown values remain unavailable.');
  if (rows.some((row) => row.attention === 'unknown'))
    result.notes.push('Live attention is unknown when the panel is hidden or its facts are unavailable.');
  return result;
}

export type SessionTurn = Pick<
  Turn,
  | 'promptId'
  | 'startedAt'
  | 'endedAt'
  | 'prompt'
  | 'summary'
  | 'model'
  | 'effort'
  | 'finished'
  | 'interrupted'
  | 'error'
>;

function revision(file: string): string | null {
  try {
    const stat = fs.statSync(file, { bigint: true });
    const snapshot = revisionOf(stat);
    return JSON.stringify([snapshot.dev, snapshot.ino, snapshot.size, snapshot.mtimeMs, stat.ctimeNs.toString()]);
  } catch {
    return null;
  }
}

// The source comes from the window's catalog. A requester never supplies a file path.
export function boundedSessionRead(
  source: SessionFile,
  turns: number,
  scope: () => string | null,
  requester: string | null,
  roots: readonly string[],
) {
  if (!Number.isSafeInteger(turns) || turns < 1 || turns > SESSION_READ_LIMITS.turns)
    throw new Error('Turns must be between 1 and 20.');
  const beforeScope = scope();
  const before = revision(source.file);
  const result = {
    version: 1,
    requester,
    id: source.sessionId,
    provider: source.agent,
    state: 'unparsed' as 'current' | 'stale' | 'unparsed',
    turns: [] as SessionTurn[],
    partial: false,
    readByteLimit: SESSION_READ_LIMITS.bytes,
    notes: [] as string[],
  };
  if (beforeScope === null || before === null) {
    result.state = 'stale';
    result.notes.push('The session source or repository scope is unavailable.');
    return result;
  }
  const [dev, ino, size, mtimeMs] = JSON.parse(before) as [FileRevision['dev'], FileRevision['ino'], number, number];
  const cwd = source.agent === 'codex' ? readCodexSessionMeta(source.file)?.cwd : readSessionCwd(source.file);
  if (
    size !== source.size ||
    mtimeMs !== source.mtimeMs ||
    (source.dev !== undefined && dev !== source.dev) ||
    (source.ino !== undefined && ino !== source.ino) ||
    !cwd ||
    !isInside(cwd, [...roots])
  ) {
    result.state = 'stale';
    result.notes.push('The session source no longer matches this repository scope. Retry the command.');
    return result;
  }
  const read =
    source.agent === 'codex'
      ? readCodexSession(source.file, source.sessionId, {
          tailBytes: SESSION_READ_LIMITS.bytes - 2 * CODEX_OPENING_BYTES,
          maxTurns: turns,
          turnsOnly: true,
        })
      : readSession(source.file, source.sessionId, {
          tailBytes: SESSION_READ_LIMITS.bytes - 64 * 1024,
          maxTurns: turns,
          childTranscript: source.childTranscript === true,
          turnsOnly: true,
        });
  if (beforeScope !== scope() || before !== revision(source.file)) {
    result.state = 'stale';
    result.notes.push('The session or repository scope changed during the read. Retry the command.');
    return result;
  }
  result.state = read.turns.length ? 'current' : 'unparsed';
  result.partial = read.readBytes < source.size || read.turnLimitReached;
  for (const turn of [...read.turns].reverse()) {
    const { promptId, startedAt, endedAt, prompt, summary, model, effort, finished, interrupted, error } = turn;
    result.turns.push({ promptId, startedAt, endedAt, prompt, summary, model, effort, finished, interrupted, error });
    if (Buffer.byteLength(JSON.stringify(result)) > SESSION_READ_LIMITS.outputBytes - 512) {
      result.turns.pop();
      result.partial = true;
      result.notes.push('The response limit excluded this turn and older turns.');
      break;
    }
  }
  if (result.partial) result.notes.push('The bounded read does not establish complete session history.');
  if (result.state === 'unparsed')
    result.notes.push('No turns were parsed in the bounded window. This does not establish an empty session.');
  return result;
}
