// extension/src/turnread.ts
//
// Which turns the reader has seen: the read set, the watermarks, the new counts and how far back the list reaches.
//
// Split out of turnview.ts, which was 3,965 lines of pure functions with no shared state and
// no seam anyone could find. Nothing here was edited on the way: every declaration is the one
// that was there, in the order it was in. turnview.ts re-exports this module, so an import
// written against it still resolves.

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { TurnStarts } from './transcript';
import type { Compaction, Turn } from './transcript';
import { isTurnRead, newBySession, turnKey } from './domain/read.ts';

export { canMarkRead, isTurnRead, newBySession, READ_LIMIT, turnKey } from './domain/read.ts';

// What identifies a turn: the session it is in and the moment it started. Neither
// moves as the turn grows, which is why the read state is keyed on it and why a card
// opened while its turn was still running stays marked read once the turn ends.
//
// Named here because two callers build it. The card takes it in `toCard`, and the count of
// what is new builds one for every turn the panel parsed, which is more turns than it
// draws: a session the reader is not looking at gets as little as one card out of the
// list budget, and counting over the cards counted twelve unread turns as one.
// The parsed shape of one transcript window. Selection is deliberately absent: choosing a
// session changes how an empty tail is prepared for backward discovery, but it does not
// change the turns parsed from a window that already contains a complete turn.
export function transcriptReadCacheKey(
  revision: { size: number; mtimeMs: number },
  maxTurns: number,
  tailBytes: number,
  folders: readonly string[],
): string {
  return `${revision.size}:${revision.mtimeMs}:${maxTurns}:${tailBytes}:${folders.join('\n')}`;
}

// An unselected read does not ask the source adapter for a backward-discovery cursor. It can
// still be selected without another parse when it found a complete turn, since adapters only
// create that cursor for a window with no turn boundary. A read already made for the selected
// session is reusable either way, including after discovery found that no cursor is needed.
export function cachedReadCanServeDiscovery(preparedForDiscovery: boolean, turnCount: number): boolean {
  return preparedForDiscovery || turnCount > 0;
}

// When each session last started a turn. "Running" is a fact about a session, not about
// the merged list: two agents in one repo each have their own running turn, and reading it
// off the merged list draws the one that started earlier as stopped, with a frozen
// duration.
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

// The Composer's context and next-turn figure both come from these records. The worker may
// return turns in either source order, so each session selects its newest identity by clock.
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

// What the rail knows about how much is new in one session.
//
// `atLeast` says the figure is a floor rather than a total. Every reader of a count carries
// this beside it, because a count taken from part of a session and drawn as the whole
// of it is wrong in the direction that reads as right.
export interface NewCount {
  count: number;
  atLeast: boolean;
}

// How much is new in each session, over the ones parsed and the ones only glanced at.
//
// The panel parses a handful of sessions and lists every one in the workspace, so most
// rail cards had no count at all and could draw no unread mark: with the default of three
// parsed, 26 of this workspace's 29 sessions were silent whatever was waiting in them.
// A glance is the fallback: the turn starts in a window off the end of the file, which is
// cheap enough to take for every listed session.
//
// A parsed session keeps its real count and is never routed through its window. The
// window is a fallback for what was not parsed, never a replacement for what was, and a
// session with both would otherwise answer twice.
//
// The rule for what counts as new is `newBySession`'s, and this feeds it rather than
// restating it: the window's turn starts are made into the same refs a parsed turn produces,
// through `turnKey`, so a turn read while it was parsed stays read once it is only glanced
// at.
//
// **When the figure is exact, and when it is a floor.** A window that reached the start of
// the file has nothing outside it and is always a total. Otherwise the rule rests on a file
// being written in order, so that everything outside the window is older than everything
// inside it. `newBySession` counts only turns newer than the newest read one, so if anything
// in the window has been read, every turn outside it sits below that boundary and cannot be
// new: the figure is a total. If nothing in the window has been read there is no boundary,
// every unread turn counts, and the ones outside the window would have counted too: the
// figure is a floor.
//
// **A transcript is not always written in order, and this is where the rule fails.** Claude
// Code replays earlier session into the same file when a session is resumed after a
// compaction, timestamps and all, so old turns land after newer ones. A window then holds
// replayed old turns while genuinely newer ones sit outside it, and a read turn inside gives
// a total that understates. Measured over the transcripts on this machine: of the 157 files
// larger than the window whose window holds some but not all of their turn starts, 3 are
// written out of order this way.
//
// It is left as a total rather than hedged. Wording every partial window as a floor would
// hedge 21 of this workspace's 49 sessions to catch 3 in 157, and "at least 5 new" over
// a session where 5 is right is its own kind of wrong. The failure is an undercount on a
// resumed session, which still draws the mark and still sends the reader to look. There
// is no cheap signal for it: the replayed block sits wholly outside the window, so the
// window's own starts are in order in all three of the files measured.
export function newCounts(
  parsed: { key: string; sessionId: string; startedAt: number; kind: string }[],
  windows: ReadonlyMap<string, TurnStarts>,
  read: Iterable<string>,
  readTo: ReadonlyMap<string, number>,
  since = 0,
): Map<string, NewCount> {
  const readSet = new Set(read);
  const out = new Map<string, NewCount>();
  for (const [id, count] of newBySession(parsed, readSet, readTo, since)) {
    out.set(id, { count, atLeast: false });
  }
  for (const [id, window] of windows) {
    if (out.has(id)) {
      continue;
    }
    // A window that found no turn start says nothing, exactly as a session nobody
    // glanced at does. Zero would be a claim the window cannot support.
    if (!window.starts.length) {
      continue;
    }
    const refs = window.starts.map((startedAt) => ({
      key: turnKey({ sessionId: id, startedAt }),
      sessionId: id,
      startedAt,
      kind: 'turn',
    }));
    const count = newBySession(refs, readSet, readTo, since).get(id) ?? 0;
    const anyRead = refs.some((r) => isTurnRead(r, readSet, readTo, since));
    out.set(id, { count, atLeast: !window.whole && !anyRead });
  }
  return out;
}

// When each session's newest turn began, over the ones parsed and the ones only
// glanced at. The watermark that marking a session read writes, and what decides
// whether a rail card offers that entry at all.
//
// Taken over the same two sources `newCounts` reads, and it has to be: a card that showed a
// count with no watermark behind it would wear a mark the reader has no way to clear, and one
// with a watermark behind no count would offer a press that changes nothing on screen. A
// window is the end of a file, so the newest start it holds is the newest start the file
// holds, whatever the window missed further back.
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

// Reading further back on demand is `historypages.ts`, which walks disjoint older pages
// through a per-session cursor. What stays here is the retained tail: the bounded
// window the ordinary parse reads, and the rules that keep a turn already on screen inside
// it while its transcript grows.

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

// A recovered newest-turn range stays in use while the reader can see it, while the agent is
// still extending that turn, or while the turn remains new. Once none is true, the ordinary
// bounded tail is enough.
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

// A content identity for the complete range a selected session has retained. An append
// leaves every old byte in place, while any restored or replaced byte changes the digest even
// when the path, session id and size stay the same. Chunks bound temporary memory; the selected
// session alone pays this validation read.
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
      const read = fs.readSync(fd, buffer, 0, length, position);
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

// Retained byte positions and turn keys belong to one exact file generation. A logical session
// id catches a different rollout at the same path; the sampled range catches the same session
// restored or replaced in place. Size going backwards is the remaining truncation case.
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

// Keep the beginning of a tail window fixed as an append-only transcript grows. A selected
// session may already have shown turns from that window, so returning to the base tail
// on the next append would make those turns disappear. A different session or a truncation
// starts over because the byte positions no longer name the same records.
export function retainedTailBytes(base: number, size: number, previous?: RetainedTail): number {
  if (!previous || size < previous.size) {
    return base;
  }
  return Math.max(base, previous.bytes + size - previous.size);
}

// Keep every previously shown turn inside the selected session's parser limit. The
// first parse after an append can reveal that new turns displaced old ones at the limit;
// each missing key adds one place, and the caller parses again until no old key is missing.
// A setting raised by the reader remains the floor throughout.
export function retainedTurnLimit(base: number, currentKeys: readonly string[], previous?: RetainedTail): number {
  if (!previous) {
    return base;
  }
  const current = new Set(currentKeys);
  const missing = previous.turnKeys.filter((key) => !current.has(key)).length;
  return Math.max(base, previous.maxTurns) + missing;
}
