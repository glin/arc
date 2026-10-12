import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import {
  readCodexSession,
  readCodexSessionMeta,
  CODEX_OPENING_BYTES,
  createCodexSessionReducer,
  openingRecordOf,
} from './codex.ts';
import {
  readSession,
  readSessionCwd,
  isInside,
  sameSessionRevision,
  revisionOf,
  supportedFileIdentity,
  createClaudeSessionReducer,
  type SessionFile,
  type Turn,
  type TurnOutcome,
  type FileRevision,
} from './transcript.ts';
import type { RailStatus, SessionParentEdge } from './turnrail.ts';
import { liveBackgroundCommands, sessionStatusOf } from './turnrail.ts';
import type { SessionStatus } from './domain/session-query.ts';
import { railStatusRuns } from './domain/session-query.ts';
import { onlyGrew } from './derivedcache.ts';
import { READ_OBSERVATION_BYTES, type ReadObservationFacts } from './sessionwrites.ts';
import { READ_LIMIT, type AgentReadSource } from './domain/read.ts';
import { createClaudeRepeatedFilter } from './clauderepeated.ts';
import { meterRead } from './readmeter.ts';

export const SESSION_READ_LIMITS = { turns: 20, bytes: 512 * 1024, outputBytes: 48 * 1024 } as const;
export type SessionAttention = Extract<SessionStatus, 'input' | 'unread' | 'running'> | 'idle' | 'unknown';

// A paged row names each field that its cap shortened or emptied.
export type SessionTruncatedField = 'id' | 'path' | 'name' | 'setup.model' | 'setup.effort' | 'labels' | 'parent.id';

// The host projection omits source, path, ambiguous, and truncated. The page builder fills them.
export interface SessionListingRow {
  source?: string;
  id: string | null;
  provider: SessionFile['agent'];
  path?: string | null;
  ambiguous?: boolean;
  name: string | null;
  setup: { model: string | null; effort: string | null; source: 'recorded' | 'unavailable' };
  labels: { name: string; source: 'reader' }[] | null;
  pinned: boolean;
  archived: boolean;
  runStatus: RailStatus | 'none' | 'unknown';
  attention: SessionAttention;
  lastActivity: number | null;
  parent: { id: string | null; relation: SessionParentEdge['relation'] | 'reader' } | null;
  agentRun: boolean | null;
  facts: 'current' | 'stale' | 'unparsed';
  truncated?: SessionTruncatedField[];
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
// A finished turn reads subagents while a background subagent it launched has no close record. The panel also
// requires a fresh child transcript, which this read never opens. It reads background while a background command
// has no end record and is younger than the panel's command cap. Subagents take precedence over background, as in
// the panel. A closed child reopens only on later work in its own transcript, so a finished turn whose remaining
// records are only closed children or commands past the cap reads unknown.
export function sessionReadStatus(
  id: string,
  outcome: TurnOutcome | null | undefined,
  running: boolean,
  waiting: boolean,
  since: number | undefined,
  exited: number | undefined,
  source: { unchanged: boolean; mtimeMs: number },
  backgroundCommands?: readonly import('./transcript').BackgroundCommand[],
): RailStatus | undefined {
  const boundary =
    since ??
    outcome?.startedAt ??
    backgroundCommands?.reduce<number | undefined>(
      (earliest, command) => (earliest === undefined ? command.startedAt : Math.min(earliest, command.startedAt)),
      undefined,
    );
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
  const closed = new Set(
    (observedOutcome?.closedChildren ?? []).map((child) => (typeof child === 'string' ? child : child.id)),
  );
  const openChildren =
    observedOutcome && observedOutcome.processEndedAt === undefined
      ? new Set((observedOutcome.openChildren ?? []).filter((child) => !closed.has(child))).size
      : 0;
  const now = Date.now();
  const statuses = sessionStatusOf(
    !outcome && ended
      ? [{ sessionId: id, kind: 'turn', startedAt: boundary, processEndedAt: exited, status: 'stopped' }]
      : [],
    active ? new Set([id]) : new Set(),
    observedOutcome ? new Map([[id, observedOutcome]]) : new Map(),
    now,
    waiting ? new Set([id]) : new Set(),
    since !== undefined ? new Map([[id, since]]) : new Map(),
    new Map([[id, openChildren]]),
    liveBackgroundCommands(new Map([[id, observedOutcome ?? null]]), new Map(), now),
  );
  const status = statuses.get(id);
  if (!outcome && !ended && !running && !waiting && backgroundCommands?.length) return 'background';
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

// A page holds at most rows sessions. The default request limit is the same value.
export const SESSION_PAGE_LIMITS = { rows: 128, fieldBytes: 4 * 1024, cursorLength: 512 } as const;

export const SESSION_PAGE_ERRORS = {
  cursor: 'The session cursor is invalid or expired. Restart the listing without --cursor.',
  scope: 'The repository scope changed. Restart the listing without --cursor.',
  catalog: 'The session catalog is unavailable for this repository scope. Open Arc and retry.',
  window: 'The window metadata leaves no room for one session row. Open fewer or shorter workspace folders and retry.',
  limit: 'Limit must be between 1 and 128.',
} as const;

const SESSION_PAGE_NOTES = {
  unavailable: 'The session catalog is unavailable for this repository scope.',
  incomplete:
    'The session listing is incomplete. Discovery was incomplete, or Arc could not confirm that sessions before the cursor stayed unchanged.',
  stale: 'Some pages of this listing were read while session facts were not current.',
  facts: 'Some session facts are stale or unparsed. Unknown values remain unavailable.',
  attention: 'Live attention is unknown when the panel is hidden or its facts are unavailable.',
  ambiguous: 'Some session IDs belong to more than one transcript. Use source or path to tell those rows apart.',
  truncated: 'Some fields exceed the field limit. Each row lists its shortened or omitted fields in truncated.',
} as const;

const TRUNCATED_ORDER: readonly SessionTruncatedField[] = [
  'id',
  'path',
  'name',
  'setup.model',
  'setup.effort',
  'labels',
  'parent.id',
];
const DIGEST = /^[A-Za-z0-9_-]{43}$/;
const CURSOR = /^[A-Za-z0-9_-]+$/;
const TAG_BYTES = 32;

export type SessionPageRow = SessionListingRow & {
  source: string;
  path: string | null;
  ambiguous: boolean;
  truncated: SessionTruncatedField[];
};

export interface SessionPageSource<T extends SessionFile = SessionFile> {
  source: string;
  session: T;
  dev: string | null;
  ino: string | null;
  // The serialized [source, dev, ino] prefix tuple, so a cached source list serializes each tuple once.
  tuple: string;
  ambiguous: boolean;
}

export interface SessionCursorBody {
  version: 1;
  scope: string;
  last: string;
  prefix: string;
  coverage: boolean;
  fresh: boolean;
}

export type SessionCursorCheck = { status: 'valid'; body: SessionCursorBody } | { status: 'refused' | 'scope' };

export interface SessionPage {
  version: 1;
  requester: string | null;
  sessions: SessionPageRow[];
  complete: boolean;
  notes: string[];
  next: string | null;
  coverage: 'complete' | 'incomplete' | 'unavailable';
  freshness: 'current' | 'stale';
}

export interface SessionPageRequest<T extends SessionFile> {
  // Sorted by source key, as sessionPageSources returns them.
  sources: readonly SessionPageSource<T>[];
  cursor: SessionCursorBody | null;
  limit: number;
  replyBytes?: number;
  catalog: 'complete' | 'incomplete' | 'unavailable';
  // True when the panel is visible and the host's fresh expression holds for this page.
  fresh: boolean;
  scope: string;
  secret: Buffer;
  requester: string | null;
  // Runs for each served source and for at most one source that did not fit.
  project: (source: SessionPageSource<T>) => { row: SessionListingRow; current: boolean };
}

const digest = (text: string) => crypto.createHash('sha256').update(text).digest('base64url');

export function sessionSourceKey(provider: SessionFile['agent'], sessionId: string, file: string): string {
  return digest(`${provider}\0${sessionId}\0${file}`);
}

export function sessionScopeDigest(scopeKey: string): string {
  return digest(scopeKey);
}

const identityText = (value: number | string | undefined) => (value === undefined ? null : String(value));

// Catalog membership under one scope: each accepted file with its device and inode. Size, modification time, and catalog order
// stay out, so an append or an activity reorder keeps the same membership. An added, removed, or replaced file changes it.
export function sessionCatalogMembership(
  scope: string,
  sessions: readonly Pick<SessionFile, 'file' | 'dev' | 'ino'>[],
): string {
  const members = sessions.map(({ file, dev, ino }) => JSON.stringify([file, identityText(dev), identityText(ino)]));
  return JSON.stringify([scope, members.sort()]);
}

// The membership a complete discovery reply proves for a published catalog, or undefined when the reply did not answer each file
// at its current device and inode, or when the reply also answered a removed file. Growth keeps the answered identity.
export function sessionDiscoveryMembership(
  scope: string,
  catalog: readonly SessionFile[],
  answered: ReadonlyMap<string, SessionFile>,
): string | undefined {
  const proven =
    answered.size === new Set(catalog.map((source) => source.file)).size &&
    catalog.every((source) => {
      const reply = answered.get(source.file);
      return (
        !!reply &&
        identityText(reply.dev) === identityText(source.dev) &&
        identityText(reply.ino) === identityText(source.ino)
      );
    });
  return proven ? sessionCatalogMembership(scope, catalog) : undefined;
}

// Keys order the sources by ordinal comparison. A repeated provider, ID, and file is one source.
// A source has physical identity only when supportedFileIdentity holds, which requires a positive inode.
export function sessionPageSources<T extends SessionFile>(sessions: readonly T[]): SessionPageSource<T>[] {
  const keyed = new Map<string, SessionPageSource<T>>();
  for (const session of sessions) {
    const source = sessionSourceKey(session.agent, session.sessionId, session.file);
    if (keyed.has(source)) continue;
    const identified = supportedFileIdentity(session);
    const dev = identified ? String(session.dev) : null;
    const ino = identified ? String(session.ino) : null;
    keyed.set(source, {
      source,
      session,
      dev,
      ino,
      tuple: JSON.stringify([source, dev, ino]) + '\n',
      ambiguous: false,
    });
  }
  const sorted = [...keyed.values()].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  const ids = new Map<string, number>();
  for (const entry of sorted) ids.set(entry.session.sessionId, (ids.get(entry.session.sessionId) ?? 0) + 1);
  for (const entry of sorted) entry.ambiguous = ids.get(entry.session.sessionId)! > 1;
  return sorted;
}

const cursorTag = (secret: Buffer, body: Buffer) => crypto.createHmac('sha256', secret).update(body).digest();

export function encodeSessionCursor(body: SessionCursorBody, secret: Buffer): string {
  if (![body.scope, body.last, body.prefix].every((value) => DIGEST.test(value)))
    throw new Error('Invalid session cursor body.');
  const { version, scope, last, prefix, coverage, fresh } = body;
  const bytes = Buffer.from(JSON.stringify({ version, scope, last, prefix, coverage, fresh }));
  const cursor = Buffer.concat([cursorTag(secret, bytes), bytes]).toString('base64url');
  if (cursor.length > SESSION_PAGE_LIMITS.cursorLength) throw new Error('Invalid session cursor body.');
  return cursor;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Every failure before the scope comparison has one outcome, so a caller cannot tell which step refused.
export function readSessionCursor(cursor: unknown, secret: Buffer, scope: string): SessionCursorCheck {
  const refused = { status: 'refused' } as const;
  if (typeof cursor !== 'string' || cursor.length > SESSION_PAGE_LIMITS.cursorLength || !CURSOR.test(cursor))
    return refused;
  const bytes = Buffer.from(cursor, 'base64url');
  if (bytes.length <= TAG_BYTES || bytes.toString('base64url') !== cursor) return refused;
  const body = bytes.subarray(TAG_BYTES);
  if (!crypto.timingSafeEqual(bytes.subarray(0, TAG_BYTES), cursorTag(secret, body))) return refused;
  let value: unknown;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch {
    return refused;
  }
  if (
    !record(value) ||
    Object.keys(value).sort().join(',') !== 'coverage,fresh,last,prefix,scope,version' ||
    value.version !== 1 ||
    ![value.scope, value.last, value.prefix].every((field) => typeof field === 'string' && DIGEST.test(field)) ||
    typeof value.coverage !== 'boolean' ||
    typeof value.fresh !== 'boolean'
  )
    return refused;
  if (value.scope !== scope) return { status: 'scope' };
  return { status: 'valid', body: value as unknown as SessionCursorBody };
}

const fieldBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

// The cut falls on a code-point boundary and keeps the serialized name within its cap.
function capName(name: string): string {
  let bytes = 2;
  let end = 0;
  for (const point of name) {
    const size = fieldBytes(point) - 2;
    if (bytes + size > SESSION_PAGE_LIMITS.fieldBytes) break;
    bytes += size;
    end += point.length;
  }
  return name.slice(0, end);
}

// Identity comes from the source. Facts come from the projected row.
function cappedRow(entry: SessionPageSource, row: SessionListingRow): SessionPageRow {
  const truncated = new Set<SessionTruncatedField>();
  const cap = <V>(field: SessionTruncatedField, value: V | null): V | null => {
    if (value === null || fieldBytes(value) <= SESSION_PAGE_LIMITS.fieldBytes) return value;
    truncated.add(field);
    return null;
  };
  let name = row.name;
  if (name !== null && fieldBytes(name) > SESSION_PAGE_LIMITS.fieldBytes) {
    name = capName(name);
    truncated.add('name');
  }
  const { session } = entry;
  return {
    source: entry.source,
    id: cap('id', session.sessionId),
    provider: session.agent,
    path: cap('path', session.file),
    ambiguous: entry.ambiguous,
    name,
    setup: {
      model: cap('setup.model', row.setup.model),
      effort: cap('setup.effort', row.setup.effort),
      source: row.setup.source,
    },
    labels: cap('labels', row.labels),
    pinned: row.pinned,
    archived: row.archived,
    runStatus: row.runStatus,
    attention: row.attention,
    lastActivity: row.lastActivity,
    parent: row.parent && { id: cap('parent.id', row.parent.id), relation: row.parent.relation },
    agentRun: row.agentRun,
    facts: row.facts,
    truncated: TRUNCATED_ORDER.filter((field) => truncated.has(field)),
  };
}

// The minimal row keeps the source key, the provider, and the fixed-size facts.
function minimalRow(row: SessionPageRow): SessionPageRow {
  const truncated = new Set(row.truncated);
  const drop = (field: SessionTruncatedField, value: unknown): null => {
    if (value !== null) truncated.add(field);
    return null;
  };
  return {
    ...row,
    id: drop('id', row.id),
    path: drop('path', row.path),
    name: drop('name', row.name),
    setup: {
      model: drop('setup.model', row.setup.model),
      effort: drop('setup.effort', row.setup.effort),
      source: row.setup.source,
    },
    labels: drop('labels', row.labels),
    parent: row.parent && { id: drop('parent.id', row.parent.id), relation: row.parent.relation },
    truncated: TRUNCATED_ORDER.filter((field) => truncated.has(field)),
  };
}

function pageNotes(rows: readonly SessionPageRow[], coverage: SessionPage['coverage'], fresh: boolean): string[] {
  const notes: string[] = [];
  if (coverage !== 'complete') notes.push(SESSION_PAGE_NOTES[coverage]);
  if (!fresh) notes.push(SESSION_PAGE_NOTES.stale);
  if (rows.some((row) => row.facts !== 'current')) notes.push(SESSION_PAGE_NOTES.facts);
  if (rows.some((row) => row.attention === 'unknown')) notes.push(SESSION_PAGE_NOTES.attention);
  if (rows.some((row) => row.ambiguous)) notes.push(SESSION_PAGE_NOTES.ambiguous);
  if (rows.some((row) => row.truncated.length)) notes.push(SESSION_PAGE_NOTES.truncated);
  return notes;
}

interface PageState {
  hash: crypto.Hash;
  identified: boolean;
  fresh: boolean;
}

// The prefix digest covers [source, dev, ino] for each source through the cursor's last key.
// Size and modification time stay out of the tuple, so appends keep the digest.
function extendPrefix(state: PageState, entry: SessionPageSource): PageState {
  state.hash.update(entry.tuple);
  state.identified &&= entry.dev !== null && entry.ino !== null;
  return state;
}

// A page serves the sources after the cursor in key order. The builder measures each candidate reply with its own next cursor and notes.
export function sessionListingPage<T extends SessionFile>(request: SessionPageRequest<T>): SessionPage {
  const { sources, cursor, limit, catalog, scope, secret, requester } = request;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SESSION_PAGE_LIMITS.rows)
    throw new Error(SESSION_PAGE_ERRORS.limit);
  if (cursor && catalog === 'unavailable') throw new Error(SESSION_PAGE_ERRORS.catalog);
  const budget = Math.min(SESSION_READ_LIMITS.outputBytes, request.replyBytes ?? Infinity);
  let start = 0;
  if (cursor) {
    let high = sources.length;
    while (start < high) {
      const middle = (start + high) >>> 1;
      if (sources[middle].source > cursor.last) high = middle;
      else start = middle + 1;
    }
  }
  let state: PageState = { hash: crypto.createHash('sha256'), identified: true, fresh: request.fresh };
  for (let index = 0; index < start; index++) extendPrefix(state, sources[index]);
  const covered =
    catalog === 'complete' &&
    (!cursor || (cursor.coverage && state.identified && state.hash.copy().digest('base64url') === cursor.prefix));
  if (cursor) state.fresh &&= cursor.fresh;
  const page: SessionPageRow[] = [];
  const assemble = (end: number, at: PageState): SessionPage => {
    const more = end < sources.length;
    const kept = covered && (!more || at.identified);
    const next = more
      ? encodeSessionCursor(
          {
            version: 1,
            scope,
            last: sources[end - 1].source,
            prefix: at.hash.copy().digest('base64url'),
            coverage: kept,
            fresh: at.fresh,
          },
          secret,
        )
      : null;
    const coverage = catalog === 'unavailable' ? 'unavailable' : kept ? 'complete' : 'incomplete';
    return {
      version: 1,
      requester,
      sessions: page,
      complete: next === null && coverage === 'complete' && at.fresh,
      notes: pageNotes(page, coverage, at.fresh),
      next,
      coverage,
      freshness: at.fresh ? 'current' : 'stale',
    };
  };
  let rowBytes = 0;
  const measure = (row: SessionPageRow, end: number, at: PageState) => {
    page.push(row);
    const bytes = fieldBytes(row);
    const reply = assemble(end, at);
    if (fieldBytes({ ...reply, sessions: [] }) + rowBytes + bytes + page.length - 1 <= budget) return { reply, bytes };
    page.pop();
    return null;
  };
  let result: SessionPage | null = null;
  for (let index = start; index < sources.length && page.length < limit; index++) {
    const entry = sources[index];
    const projected = request.project(entry);
    const candidate = extendPrefix(
      { hash: state.hash.copy(), identified: state.identified, fresh: state.fresh && projected.current },
      entry,
    );
    const row = cappedRow(entry, projected.row);
    let accepted = measure(row, index + 1, candidate);
    if (!accepted && page.length) break;
    accepted ??= measure(minimalRow(row), index + 1, candidate);
    if (!accepted) throw new Error(SESSION_PAGE_ERRORS.window);
    result = accepted.reply;
    rowBytes += accepted.bytes;
    state = candidate;
  }
  if (result) return result;
  const empty = assemble(start, state);
  if (fieldBytes(empty) > budget) throw new Error(SESSION_PAGE_ERRORS.window);
  return empty;
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

// The exact physical revision a guarded follow-up binds: device, inode, size, write time, and change time.
// Unlike `sessionSourceAdmitted`, it gives append growth no allowance. Null means the source is unreadable.
export function guardedSourceRevision(file: string): string | null {
  return revision(file);
}

// Canonical physical path and file identity remain stable across appends, but change on replacement.
export function guardedSourceIdentity(source: Pick<SessionFile, 'file' | 'agent' | 'sessionId'>): string | null {
  try {
    const stat = revisionOf(fs.statSync(source.file, { bigint: true }));
    if (!supportedFileIdentity(stat)) return null;
    return digest(
      JSON.stringify([source.agent, source.sessionId, fs.realpathSync.native(source.file), stat.dev, stat.ino]),
    );
  } catch {
    return null;
  }
}

export const AGENT_SOURCE_LIMITS = {
  bytes: 8 * 1024 * 1024,
  chunkBytes: 256 * 1024,
  sources: 32,
  identities: READ_LIMIT,
} as const;

// Restored acknowledgments resolve through an independent exact read, never a selected-session cache.
// Large sources and discarded identities retain uncertain coverage and admit no agent keys.
export class AgentReadSources {
  private readonly held = new Map<string, AgentReadSource>();

  resolve(
    source: SessionFile,
    scope: () => string | null,
    roots: readonly string[],
    expectedRevision?: string,
  ): AgentReadSource | null {
    const beforeScope = scope();
    const before = guardedSourceRevision(source.file);
    const identity = guardedSourceIdentity(source);
    if (beforeScope === null || before === null || identity === null) return null;
    const key = sessionSourceKey(source.agent, source.sessionId, source.file);
    const cached = this.held.get(key);
    if (cached && (cached.sourceRevision !== before || cached.source !== identity || cached.scope !== beforeScope))
      this.held.delete(key);
    if (expectedRevision !== undefined && expectedRevision !== before) return null;
    const [dev, ino, size, mtimeMs] = JSON.parse(before) as [string, string, number, number];
    if (
      size !== source.size ||
      mtimeMs !== source.mtimeMs ||
      (source.dev !== undefined && dev !== source.dev) ||
      (source.ino !== undefined && ino !== source.ino)
    )
      return null;
    const cwd = source.agent === 'codex' ? readCodexSessionMeta(source.file)?.cwd : readSessionCwd(source.file);
    if (!cwd || !isInside(cwd, [...roots])) return null;
    const current = () =>
      scope() === beforeScope &&
      guardedSourceRevision(source.file) === before &&
      guardedSourceIdentity(source) === identity;
    if (this.held.has(key)) {
      if (!current()) return null;
      this.held.delete(key);
      this.held.set(key, cached!);
      return cached!;
    }
    const facts: AgentReadSource = {
      provider: source.agent,
      sessionId: source.sessionId,
      source: identity,
      scope: beforeScope,
      sourceRevision: before,
      identitiesComplete: false,
      historyComplete: false,
      turns: [],
    };
    if (size <= AGENT_SOURCE_LIMITS.bytes - CODEX_OPENING_BYTES) {
      let fd = -1;
      try {
        fd = fs.openSync(source.file, 'r');
        const body = Buffer.allocUnsafe(size);
        let offset = 0;
        while (offset < size) {
          const length = Math.min(AGENT_SOURCE_LIMITS.chunkBytes, size - offset);
          const count = meterRead(source.file, fs.readSync(fd, body, offset, length, offset), offset);
          if (!count) return null;
          offset += count;
        }
        const lines = body.toString('utf8').split('\n');
        const reducer =
          source.agent === 'codex'
            ? createCodexSessionReducer(
                source.sessionId,
                { maxTurns: AGENT_SOURCE_LIMITS.identities, turnsOnly: true },
                openingRecordOf(lines[0]),
              )
            : createClaudeSessionReducer(source.sessionId, {
                maxTurns: AGENT_SOURCE_LIMITS.identities,
                turnsOnly: true,
                childTranscript: source.childTranscript === true,
              });
        const repeated = source.agent === 'claude' ? createClaudeRepeatedFilter() : () => false;
        for (const line of lines) if (!repeated(line)) reducer.pushLine(line);
        const read = reducer.finish(offset);
        facts.identitiesComplete = !read.turnLimitReached;
        facts.historyComplete = !read.turnLimitReached;
        facts.turns = read.turns.map(({ promptId, startedAt, finished, endedAt }) => ({
          promptId,
          startedAt,
          finished: finished && Number.isFinite(endedAt) && endedAt > 0,
        }));
        if (
          facts.turns.some(
            (turn) =>
              typeof turn.promptId !== 'string' || turn.promptId.length > 4096 || !Number.isFinite(turn.startedAt),
          )
        ) {
          facts.identitiesComplete = false;
          facts.historyComplete = false;
          facts.turns = [];
        }
      } catch {
        return null;
      } finally {
        if (fd >= 0) fs.closeSync(fd);
      }
    }
    if (!current()) return null;
    facts.turns = Object.freeze(facts.turns.map((turn) => Object.freeze(turn)));
    Object.freeze(facts);
    this.held.set(key, facts);
    while (
      this.held.size > AGENT_SOURCE_LIMITS.sources ||
      [...this.held.values()].reduce((count, one) => count + one.turns.length, 0) > AGENT_SOURCE_LIMITS.identities
    )
      this.held.delete(this.held.keys().next().value!);
    return facts;
  }

  clear(): void {
    this.held.clear();
  }
}

// The source comes from the window's catalog. A requester never supplies a file path.
// `observe` receives the checked revision of a current read. Its observation joins the reply only when it returns one
// and the reply still holds the latest turn the observation names.
export function boundedSessionRead(
  source: SessionFile,
  turns: number,
  scope: () => string | null,
  requester: string | null,
  roots: readonly string[],
  observe?: (facts: { scope: string; sourceRevision: string; latestTurn: string | null }) => string | null,
  observeRead?: (facts: ReadObservationFacts) => string | null,
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
          boundedRepeated: true,
        });
  if (beforeScope !== scope() || before !== revision(source.file)) {
    result.state = 'stale';
    result.notes.push('The session or repository scope changed during the read. Retry the command.');
    return result;
  }
  result.state = read.turns.length ? 'current' : 'unparsed';
  result.partial = read.readBytes < source.size || read.turnLimitReached;
  const latest = read.turns.at(-1);
  const observation =
    observe && result.state === 'current' && latest
      ? observe({ scope: beforeScope, sourceRevision: before, latestTurn: latest.promptId ?? null })
      : null;
  // The response limit below reserves room for the observation.
  const reserved =
    (observation ? Buffer.byteLength(JSON.stringify({ observation })) : 0) + (observeRead ? READ_OBSERVATION_BYTES : 0);
  for (const turn of [...read.turns].reverse()) {
    const { promptId, startedAt, endedAt, prompt, summary, model, effort, finished, interrupted, error } = turn;
    result.turns.push({ promptId, startedAt, endedAt, prompt, summary, model, effort, finished, interrupted, error });
    if (Buffer.byteLength(JSON.stringify(result)) + reserved > SESSION_READ_LIMITS.outputBytes - 512) {
      result.turns.pop();
      result.partial = true;
      result.notes.push('The response limit excluded this turn and older turns.');
      break;
    }
  }
  // An observation authorizes a continuation only from facts the reply delivers, so it needs the latest turn.
  if (observation && result.turns.length && result.turns[0].promptId === latest!.promptId)
    Object.assign(result, { observation });
  if (observeRead && result.state === 'current') {
    const identity = guardedSourceIdentity(source);
    const records = (identity === null ? [] : result.turns)
      .filter((turn) => turn.finished && Number.isFinite(turn.endedAt) && turn.promptId)
      .map((turn) => ({
        provider: source.agent,
        sessionId: source.sessionId,
        source: identity!,
        scope: beforeScope,
        sourceRevision: before,
        promptId: turn.promptId,
        startedAt: turn.startedAt,
      }));
    const readObservation = records.length
      ? observeRead({ records, projection: digest(JSON.stringify(result.turns)) })
      : null;
    if (readObservation && Buffer.byteLength(JSON.stringify({ readObservation })) <= READ_OBSERVATION_BYTES)
      Object.assign(result, { readObservation });
    else result.notes.push('Acknowledgment is unavailable for this bounded reply.');
  }
  if (result.partial) result.notes.push('The bounded read does not establish complete session history.');

  if (result.state === 'unparsed')
    result.notes.push('No turns were parsed in the bounded window. This does not establish an empty session.');
  return result;
}
