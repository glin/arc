// The one name each Claude session carries on every surface: the rail card, the session
// heading, compaction cards, the live card, and search.
//
// A session's name has three sources. `custom` is the newest `custom-title` record, which
// the owner writes by renaming the session in Arc, with `/rename`, or with `claude --name`.
// `generated` is the newest `ai-title` record, which the CLI writes. `prompt` is the first
// thing the user typed. Each refresh reads some of them through windows of different sizes,
// so two refreshes can see different sources. The held name never moves down the ranking,
// and a `prompt` name never changes, so a refresh that saw less than the one before it
// draws the same name.

export type SessionNameSource = 'custom' | 'generated' | 'prompt';

export interface SessionName {
  label: string;
  fullLabel: string;
  source: SessionNameSource;
  // The byte offset of the record the name came from, when the read knew it. A prompt name
  // answers 0.
  at?: number;
}

// Which transcript a read saw. `size` is the size the read measured for itself, and a read
// that measured none leaves it out rather than copying a size from an older listing. A parse
// of a window of records measures neither the end of the file nor its head, so it names its
// transcript by number alone. `headKey` is the fingerprint of the first record, which only a
// read that held the head can give. `ino` is the file system's own number for the file, which
// an append keeps and a new file at the same path does not.
export interface SessionFileIdentity {
  size?: number;
  headKey?: string;
  ino?: number;
}

// The identity of the file a reader just looked at. A host that answers no number for the
// file leaves `ino` out, and the size and the fingerprint answer on their own.
export function transcriptIdentity(measured: { size?: number; ino?: number }, headKey?: string): SessionFileIdentity {
  return {
    ...(measured.size === undefined ? {} : { size: measured.size }),
    ...(headKey === undefined ? {} : { headKey }),
    ...(measured.ino !== undefined && measured.ino > 0 ? { ino: measured.ino } : {}),
  };
}

const RANK: Record<SessionNameSource, number> = { prompt: 0, generated: 1, custom: 2 };

// The name to hold after one more source reported. An update from a lower rank is ignored.
// Within a rank the record further into the file wins, whatever order the reads arrived in.
// A `prompt` name never changes, because the first prompt of a file is always the same.
// An update whose read did not know where its record sits never replaces a held name of
// its own rank.
export function resolveSessionName(
  held: SessionName | null | undefined,
  update: SessionName | null | undefined,
): SessionName | null {
  if (!update || !update.label) {
    return held ?? null;
  }
  if (!held) {
    return update;
  }
  const step = RANK[update.source] - RANK[held.source];
  if (step > 0) {
    return update;
  }
  if (step < 0 || held.source === 'prompt' || update.at === undefined) {
    return held;
  }
  return held.at === undefined || update.at > held.at ? update : held;
}

// Whether a read saw another transcript than the one a name was held for. Another file
// number at the same path is the plainest answer, and it holds for a replacement that grew.
// A changed first record says the same where the two reads both fingerprinted the head. A
// smaller size answers only where no file number does: two reads of one file measure it at
// different moments, and the later report can carry the earlier measurement, so a size that
// fell over a file both reads name by the same number says nothing about which file it is.
export function replacedTranscript(held: SessionFileIdentity, next: SessionFileIdentity): boolean {
  const named = held.ino !== undefined && next.ino !== undefined;
  if (named) {
    if (held.ino !== next.ino) {
      return true;
    }
  }
  if (held.headKey !== undefined && next.headKey !== undefined && held.headKey !== next.headKey) {
    return true;
  }
  return !named && held.size !== undefined && next.size !== undefined && next.size < held.size;
}

// The name a stored metadata entry holds, or null when the entry has no Claude name.
export function storedSessionName(
  entry: { label: string; fullLabel: string; nameSource?: SessionNameSource; nameAt?: number } | undefined,
): SessionName | null {
  if (!entry?.nameSource || !entry.label) {
    return null;
  }
  return {
    label: entry.label,
    fullLabel: entry.fullLabel || entry.label,
    source: entry.nameSource,
    ...(entry.nameAt === undefined ? {} : { at: entry.nameAt }),
  };
}

// The name one parsed turn carries, or null when its read found no title record.
export function parsedSessionName(turn: {
  sessionTitle: string | null;
  sessionFullTitle?: string | null;
  sessionTitleSource?: 'custom' | 'generated';
  sessionTitleAt?: number;
}): SessionName | null {
  if (!turn.sessionTitle || !turn.sessionTitleSource) {
    return null;
  }
  return {
    label: turn.sessionTitle,
    fullLabel: turn.sessionFullTitle || turn.sessionTitle,
    source: turn.sessionTitleSource,
    ...(turn.sessionTitleAt === undefined ? {} : { at: turn.sessionTitleAt }),
  };
}

// The label a surface draws for a session, with a placeholder while no source has a name.
export function sessionLabelOf(
  name: SessionName | null | undefined,
  sessionId: string,
): { label: string; fullLabel: string } {
  const label = name?.label || `Session ${sessionId.slice(0, 8)}`;
  return { label, fullLabel: name?.fullLabel || label };
}

function sameName(a: SessionName | null | undefined, b: SessionName | null | undefined): boolean {
  return (
    (a ?? null) === (b ?? null) ||
    (!!a && !!b && a.label === b.label && a.fullLabel === b.fullLabel && a.source === b.source && a.at === b.at)
  );
}

// The held name of every Claude session the panel has seen. Each source reports once, when
// its read arrives. Every surface reads the held name and never reports while drawing.
export class SessionNames {
  private held = new Map<string, SessionName>();
  private files = new Map<string, SessionFileIdentity>();

  // One read reported. A read that names its file drops a name held for another transcript
  // at that path before the update is weighed. Answers whether the held name changed.
  observe(sessionId: string, update: SessionName | null | undefined, file?: SessionFileIdentity): boolean {
    const before = this.held.get(sessionId) ?? null;
    let held = before;
    if (file) {
      const seen = this.files.get(sessionId);
      const replaced = !!seen && replacedTranscript(seen, file);
      if (replaced) {
        held = null;
      }
      // A read that answered less than the one before it keeps what the earlier read of the
      // same transcript knew, so the next read that carries a fingerprint or a file number
      // still has something to compare against. A transcript already known to be another one
      // starts from its own.
      this.files.set(sessionId, replaced || !seen ? file : { ...seen, ...file });
    }
    const next = resolveSessionName(held, update);
    if (next) {
      this.held.set(sessionId, next);
    } else {
      this.held.delete(sessionId);
    }
    return !sameName(before, next);
  }

  get(sessionId: string): SessionName | null {
    return this.held.get(sessionId) ?? null;
  }

  // The parsed turns of one read, each with the transcript they were read from. Answers the
  // sessions whose held name changed. The identity travels with the update because the
  // transcript at a path can be replaced between this read and the next one: without it a
  // name parsed from the old file outranks everything the new file says, and the stored
  // entry of the new transcript keeps it across a restart.
  observeTurns(
    turns: Iterable<{ sessionId: string } & Parameters<typeof parsedSessionName>[0]>,
    fileOf?: (sessionId: string) => SessionFileIdentity | undefined,
  ): Set<string> {
    const changed = new Set<string>();
    for (const turn of turns) {
      const update = parsedSessionName(turn);
      // Asked for only where a turn has a name to weigh. Answering it costs the caller a
      // look at the file, and a read over a window of turns holds many turns of one session.
      if (this.observe(turn.sessionId, update, update ? fileOf?.(turn.sessionId) : undefined)) {
        changed.add(turn.sessionId);
      }
    }
    return changed;
  }
}
