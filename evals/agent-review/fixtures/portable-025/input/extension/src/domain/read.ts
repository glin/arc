export const READ_LIMIT = 2000;

export interface ReadableTurn {
  key: string;
  sessionId: string;
  startedAt: number;
}

export function turnKey(turn: { sessionId: string; startedAt: number }): string {
  return `${turn.sessionId}:${turn.startedAt}`;
}

// Whether the reader has read a turn. Two ways in, and every reader of the read state goes
// through this one rule: the turn's own key is in the read set, or the turn started at or
// before its session's watermark.
//
// The watermark is what "mark the whole session read" writes, because the read set is
// keyed per turn and a session's older turns are usually not parsed. Marking only the turns
// on screen would leave a session that says it is read and goes unread again as soon as
// more of it is parsed, so the session carries a point in time instead and every turn at
// or before it counts as read.
//
// Both sides read this: `newBySession` below, and the panel's own copy in `SCRIPT`. A card
// that drew one state and reported another would be the failure, so neither may keep a rule
// of its own.
export function isTurnRead(
  card: ReadableTurn,
  read: ReadonlySet<string>,
  readTo: ReadonlyMap<string, number>,
  since = 0,
): boolean {
  if (read.has(card.key)) {
    return true;
  }
  const mark = readTo.get(card.sessionId) ?? since;
  return mark > 0 && card.startedAt <= mark;
}

export function canMarkRead(card: { kind: string; live?: boolean }): boolean {
  return card.kind === 'turn' && !card.live;
}

// The turns of each session that are new to the reader: unread, and newer than the newest
// read turn of that session. A reader who opened the newest turn and skipped middle ones
// has no new turns there, which is right: they have seen past them. A session none of
// whose turns was ever opened counts every turn, since nothing in it has been seen.
//
// This is the one rule for what counts as new: the rail's indicator reads it, and
// anything else that counts new turns must read it too, so two counts of the same thing
// cannot disagree. What has been read is `isTurnRead`'s answer rather than a lookup of its
// own, so the watermarks a session marked read wrote count here exactly as they do on
// the card: an older turn parsed after the reader marked the session is not new.
// Compactions are neither read nor counted: `canMarkRead` refuses them,
// and they are boundaries between turns rather than
// turns. The map holds an entry for every session with a turn in the cards, so a parsed
// session with nothing new answers 0 while one never parsed has no entry at all. Those are
// different answers: the second is not knowable, and the rail must not word it as a zero.
export function newBySession(
  cards: { key: string; sessionId: string; startedAt: number; kind: string }[],
  read: Iterable<string>,
  readTo: ReadonlyMap<string, number>,
  since = 0,
): Map<string, number> {
  const readSet = new Set(read);
  const newestRead = new Map<string, number>();
  // The floor is passed here for one rule everywhere rather than for an answer it changes.
  // A turn the floor reads started before it, and a turn this loop's boundary could skip
  // started after it, so no turn is ever on both sides and no drift of this argument goes
  // red. Taking it out would leave two readings of the read state one edit apart.
  for (const c of cards) {
    if (c.kind !== 'turn' || !isTurnRead(c, readSet, readTo, since)) {
      continue;
    }
    const best = newestRead.get(c.sessionId);
    if (best === undefined || c.startedAt > best) {
      newestRead.set(c.sessionId, c.startedAt);
    }
  }
  const counts = new Map<string, number>();
  for (const c of cards) {
    if (c.kind !== 'turn') {
      continue;
    }
    if (!counts.has(c.sessionId)) {
      counts.set(c.sessionId, 0);
    }
    if (isTurnRead(c, readSet, readTo, since)) {
      continue;
    }
    const boundary = newestRead.get(c.sessionId);
    if (boundary !== undefined && c.startedAt <= boundary) {
      continue;
    }
    counts.set(c.sessionId, (counts.get(c.sessionId) as number) + 1);
  }
  return counts;
}

export interface ReadState {
  read: readonly string[];
  readTo: Readonly<Record<string, number>>;
}

function readPrintWithout(session: string, state: ReadState): string {
  const prefix = `${session}:`;
  return JSON.stringify([
    [...state.read].filter((key) => key !== session && !key.startsWith(prefix)).sort(),
    Object.entries(state.readTo)
      .filter(([id]) => id !== session)
      .sort(([a], [b]) => a.localeCompare(b)),
  ]);
}

// Whether a saved read state moved one session's own marks and nothing else.
//
// Opening a card moves that card's watermark, and every other card keeps the count it had.
// The caller asks this to tell that save from one that changes what the rail says about the
// rest of the list.
export function readMovedOnlyFor(session: string | null, before: ReadState, after: ReadState): boolean {
  if (!session) {
    return false;
  }
  return readPrintWithout(session, before) === readPrintWithout(session, after);
}
