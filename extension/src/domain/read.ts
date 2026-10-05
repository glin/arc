export const READ_LIMIT = 2000;

export interface ReadableTurn {
  key: string;
  sessionId: string;
  startedAt: number;
}

export function turnKey(turn: { sessionId: string; startedAt: number }): string {
  return `${turn.sessionId}:${turn.startedAt}`;
}

// A saved turn key marks that turn read. Otherwise its start time must not exceed the session watermark.
// The fallback boundary applies only when the session has no watermark.
// A watermark also covers older turns that the panel has not loaded.
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

// Counts unread turns newer than the latest read turn in each session.
// Compaction boundaries do not count. A parsed session with no new turns has an explicit zero.
export function newBySession(
  cards: { key: string; sessionId: string; startedAt: number; kind: string }[],
  read: Iterable<string>,
  readTo: ReadonlyMap<string, number>,
  since = 0,
): Map<string, number> {
  const readSet = new Set(read);
  const newestRead = new Map<string, number>();
  // Use the same read rule when locating the latest read turn.
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
// Reports whether read marks changed only for the selected session.
export function readMovedOnlyFor(session: string | null, before: ReadState, after: ReadState): boolean {
  if (!session) {
    return false;
  }
  return readPrintWithout(session, before) === readPrintWithout(session, after);
}
