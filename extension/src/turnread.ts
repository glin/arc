// Tracks read state, unread counts, and retained transcript tails.
// `turnview.ts` re-exports these helpers for existing callers.

import * as fs from 'node:fs';
import { meterRead } from './readmeter';
import * as crypto from 'node:crypto';
import { TurnStarts } from './transcript';
import type { Compaction, Turn } from './transcript';
import { isTurnRead, newBySession, turnKey, type ReadableTurn } from './domain/read.ts';

export { canMarkRead, isTurnRead, newBySession, READ_LIMIT, turnKey } from './domain/read.ts';

// Keys parsed transcript windows by file revision, parser bounds, and workspace folders.
// Selection is excluded because it affects backward discovery only for an empty window.
export function transcriptReadCacheKey(
  revision: { size: number; mtimeMs: number },
  maxTurns: number,
  tailBytes: number,
  folders: readonly string[],
): string {
  return `${revision.size}:${revision.mtimeMs}:${maxTurns}:${tailBytes}:${folders.join('\n')}`;
}

// Unselected reads skip backward-discovery cursor lookup. A complete turn remains reusable after selection because adapters create cursors only for windows without turn boundaries.
// Selected reads remain reusable whether or not discovery found a cursor.
export function cachedReadCanServeDiscovery(preparedForDiscovery: boolean, turnCount: number): boolean {
  return preparedForDiscovery || turnCount > 0;
}

// Finds the latest turn start per session.
// A global latest turn would incorrectly stop other sessions' running durations.
export function newestPerSession(turns: readonly { sessionId: string; startedAt: number }[]): Map<string, number> {
  const newest = new Map<string, number>();
  for (const t of turns) {
    const best = newest.get(t.sessionId);
    if (best === undefined || t.startedAt > best) {
      newest.set(t.sessionId, t.startedAt);
    }
  }
  return newest;
}

export interface CurrentSessionRecords {
  newestTurns: Map<string, Turn>;
  newestCompactions: Map<string, Compaction>;
}

// Selects each session's newest turn and compaction for prompt box context and next-turn cost.
// Worker source order does not determine the newest clock.
export function currentRecordsBySession(
  turns: readonly Turn[],
  compactions: readonly Compaction[],
): CurrentSessionRecords {
  const newestTurns = new Map<string, Turn>();
  const newestCompactions = new Map<string, Compaction>();
  const newestTurnAt = newestPerSession(turns);
  for (const turn of turns) {
    if (!newestTurns.has(turn.sessionId) && newestTurnAt.get(turn.sessionId) === turn.startedAt) {
      newestTurns.set(turn.sessionId, turn);
    }
  }
  for (const compaction of compactions) {
    const held = newestCompactions.get(compaction.sessionId);
    if (!held || compaction.at > held.at) {
      newestCompactions.set(compaction.sessionId, compaction);
    }
  }
  return { newestTurns, newestCompactions };
}

// A session's unread count. `atLeast` marks a known minimum rather than a complete count.
export interface NewCount {
  count: number;
  atLeast: boolean;
}

// Combines parsed unread counts with bounded turn-start windows and complete mapped identities.
// Window starts use the same read keys as parsed turns.
// A whole-file window gives a complete count.
// A partial window with a read turn also gives a complete count if file order follows turn timestamps.
// A partial window without a read turn gives a known minimum.
// Claude replayed turns can break timestamp order and undercount a resumed session.
// The window alone cannot detect a replay block outside its bounds.
export function newCounts(
  parsed: (ReadableTurn & { kind: string })[],
  windows: ReadonlyMap<string, TurnStarts>,
  read: Iterable<string>,
  readTo: ReadonlyMap<string, number>,
  since = 0,
  agentRead: ReadonlyMap<string, string> = new Map(),
  mappedWindows: ReadonlyMap<string, readonly (ReadableTurn & { kind: string; finished?: boolean })[]> = new Map(),
): Map<string, NewCount> {
  const readSet = new Set(read);
  const out = new Map<string, NewCount>();
  for (const [id, count] of newBySession(parsed, readSet, readTo, since, agentRead)) {
    const session = parsed.filter((turn) => turn.sessionId === id && turn.kind === 'turn');
    const acknowledged = session.some(
      (turn) => turn.promptId !== undefined && agentRead.get(turn.key) === turn.promptId,
    );
    const readerBoundary = session.some((turn) => isTurnRead(turn, readSet, readTo, since));
    out.set(id, { count, atLeast: acknowledged && windows.get(id)?.whole === false && !readerBoundary });
  }
  for (const [id, window] of windows) {
    // No turn starts provide no count. Do not treat an unreadable boundary as zero.
    if (!window.starts.length) {
      continue;
    }
    const starts = window.starts.map((startedAt) => ({
      key: turnKey({ sessionId: id, startedAt }),
      sessionId: id,
      startedAt,
      kind: 'turn',
    }));
    const mapped = mappedWindows.get(id);
    const mappedByKey = new Map(mapped?.map((turn) => [turn.key, turn]));
    const promptIds = new Set(mapped?.map((turn) => turn.promptId));
    const mappedComplete =
      mapped &&
      mapped.length === starts.length &&
      mappedByKey.size === starts.length &&
      promptIds.size === starts.length &&
      starts.every((one) => {
        const other = mappedByKey.get(one.key);
        return (
          other?.sessionId === id &&
          other.startedAt === one.startedAt &&
          other.kind === 'turn' &&
          typeof other.finished === 'boolean' &&
          typeof other.promptId === 'string' &&
          other.promptId.length > 0
        );
      });
    const session = parsed.filter((turn) => turn.sessionId === id && turn.kind === 'turn');
    if (
      out.has(id) &&
      !session.some((turn) => turn.promptId !== undefined && agentRead.get(turn.key) === turn.promptId)
    )
      continue;
    const refs: (ReadableTurn & { kind: string })[] = mappedComplete
      ? mapped.map((turn) => ({ ...turn, promptId: turn.finished ? turn.promptId : undefined }))
      : starts;
    if (out.has(id)) {
      const positions = new Map(refs.map((turn, index) => [turn.key, index]));
      for (const turn of session) {
        const held = positions.get(turn.key);
        if (held === undefined) {
          positions.set(turn.key, refs.length);
          refs.push(turn);
        } else if (refs[held].promptId !== turn.promptId) refs[held] = { ...turn, promptId: undefined };
      }
    }
    // Incomplete mappings keep timestamp evidence but cannot subtract an agent acknowledgment.
    const count = newBySession(refs, readSet, readTo, since, mappedComplete ? agentRead : new Map()).get(id) ?? 0;
    const anyRead = refs.some((r) => isTurnRead(r, readSet, readTo, since));
    out.set(id, { count, atLeast: !window.whole && !anyRead });
  }
  return out;
}

// Returns newest known turn starts from parsed sessions and fallback windows.
// Session read actions use these timestamps as watermarks.
// A fallback window contributes only its newest contained start.
export function newestTurnStarts(
  parsed: { sessionId: string; startedAt: number }[],
  windows: ReadonlyMap<string, TurnStarts>,
): Map<string, number> {
  const out = newestPerSession(parsed);
  for (const [id, window] of windows) {
    if (out.has(id) || !window.starts.length) {
      continue;
    }
    out.set(id, Math.max(...window.starts));
  }
  return out;
}

// `historypages.ts` reads disjoint older pages through a per-session cursor.
// This module retains the ordinary parse window and keeps displayed turns inside it as the transcript grows.

export interface RetainedTail {
  identity: string;
  size: number;
  bytes: number;
  maxTurns: number;
  turnKeys: string[];
  fingerprint: string;
}

export interface NewestTurnRecoverySession {
  file: string;
  sessionId: string;
}

// A backward read that began while a turn was running must survive the append that finishes
// the turn. The file revision changes at that point, so this identity is kept separately from
// both the in-flight read and its revision-bound result. It is released only after the current
// file has produced a retained turn range.
export class NewestTurnRecovery {
  private readonly sessions = new Map<string, string>();

  remember(session: NewestTurnRecoverySession): void {
    this.sessions.set(session.file, session.sessionId);
  }

  has(session: NewestTurnRecoverySession): boolean {
    return this.sessions.get(session.file) === session.sessionId;
  }

  sessionIds(sessions: readonly NewestTurnRecoverySession[]): Set<string> {
    return new Set(sessions.filter((session) => this.has(session)).map((session) => session.sessionId));
  }

  release(session: NewestTurnRecoverySession): void {
    if (this.has(session)) {
      this.sessions.delete(session.file);
    }
  }

  retainOnly(sessions: readonly NewestTurnRecoverySession[]): void {
    const present = new Map(sessions.map((session) => [session.file, session.sessionId]));
    for (const [file, sessionId] of this.sessions) {
      if (present.get(file) !== sessionId) {
        this.sessions.delete(file);
      }
    }
  }
}

// Whether a retained range still carries a new turn. The keys use `turnKey`'s stable spelling,
// so they can be compared with the read set and watermarks without parsing the transcript again.
// An invalid key keeps the range: discarding the only known boundary would hide the turn.
export function retainedTailHasNewTurn(
  previous: RetainedTail,
  sessionId: string,
  read: Iterable<string>,
  readTo: ReadonlyMap<string, number>,
  since = 0,
): boolean {
  const prefix = `${sessionId}:`;
  const refs: { key: string; sessionId: string; startedAt: number; kind: string }[] = [];
  for (const key of previous.turnKeys) {
    const startedAt = key.startsWith(prefix) ? Number(key.slice(prefix.length)) : NaN;
    if (!Number.isFinite(startedAt)) {
      return true;
    }
    refs.push({ key, sessionId, startedAt, kind: 'turn' });
  }
  return (newBySession(refs, read, readTo, since).get(sessionId) ?? 0) > 0;
}

export function newestTurnDiscoveryOrder<T extends { sessionId: string }>(
  sessions: readonly T[],
  showing: string | null,
  pinned: ReadonlySet<string>,
  active: ReadonlySet<string> = new Set(),
): T[] {
  return [
    ...sessions.filter((session) => session.sessionId === showing),
    ...sessions.filter((session) => session.sessionId !== showing && pinned.has(session.sessionId)),
    ...sessions.filter(
      (session) => session.sessionId !== showing && !pinned.has(session.sessionId) && active.has(session.sessionId),
    ),
  ];
}

// Retains a recovered tail for the shown session, active work, unread turns, or continuing recovery.
export function retainsNewestTurnTail(
  sessionId: string,
  showing: string | null,
  active: boolean,
  unread = false,
  recovered = false,
): boolean {
  return sessionId === showing || active || unread || recovered;
}

const RETAINED_FINGERPRINT_CHUNK_BYTES = 64 * 1024;

// Hashes the complete retained byte range in bounded chunks.
// Changed bytes alter the digest even when path, session id, and size stay unchanged.
// The selected session alone requires this validation read.
export function retainedRangeFingerprint(file: string, start: number, end: number): string | null {
  if (start < 0 || end < start) {
    return null;
  }
  let fd = -1;
  try {
    fd = fs.openSync(file, 'r');
    const hash = crypto.createHash('sha256');
    hash.update(`${start}:${end}:`);
    const buffer = Buffer.allocUnsafe(Math.min(RETAINED_FINGERPRINT_CHUNK_BYTES, Math.max(1, end - start)));
    for (let position = start; position < end; position += buffer.length) {
      const length = Math.min(buffer.length, end - position);
      const read = meterRead(file, fs.readSync(fd, buffer, 0, length, position));
      if (read !== length) {
        return null;
      }
      hash.update(buffer.subarray(0, read));
    }
    return hash.digest('hex');
  } catch {
    return null;
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

// Retained positions and turn keys belong to one file generation.
// Compare session identity, the complete retained-range fingerprint, and nondecreasing size.
export function matchingRetainedTail(
  identity: string,
  size: number,
  fingerprint: string | null,
  previous?: RetainedTail,
): RetainedTail | undefined {
  return previous && previous.identity === identity && size >= previous.size && fingerprint === previous.fingerprint
    ? previous
    : undefined;
}

// Keeps the tail start fixed as an append-only transcript grows.
// Returning to the base tail can remove displayed turns.
// A missing prior range or truncation returns the base tail size.
export function retainedTailBytes(base: number, size: number, previous?: RetainedTail): number {
  if (!previous || size < previous.size) {
    return base;
  }
  return Math.max(base, previous.bytes + size - previous.size);
}

// Increase the parser limit for retained turn keys absent from the current parse.
// The caller reparses until every retained key is present.
// The previous limit and current setting remain the minimum.
export function retainedTurnLimit(base: number, currentKeys: readonly string[], previous?: RetainedTail): number {
  if (!previous) {
    return base;
  }
  const current = new Set(currentKeys);
  const missing = previous.turnKeys.filter((key) => !current.has(key)).length;
  return Math.max(base, previous.maxTurns) + missing;
}
