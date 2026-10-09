// Claude session surfaces share one name: the session list card, heading, compaction cards, live card, and search.
// `custom` comes from the newest `custom-title` record. Arc renames, `/rename`, and `claude --name` write that record.
// `generated` comes from the newest CLI `ai-title` record. `prompt` comes from the first user prompt.
// Different read windows find different sources. Held names never fall to a lower rank.
// A paired CLI answer releases a held prompt name. Other prompt names stay fixed.
// A refresh with fewer sources preserves the held name.

export type SessionNameSource = 'custom' | 'generated' | 'prompt';

export interface SessionName {
  label: string;
  fullLabel: string;
  source: SessionNameSource;
  // The byte offset of the record the name came from, when the read knew it. A prompt name
  // has offset 0.
  at?: number;
}

// Identifies the transcript used by a read. `size` is the measured file size.
// A read without a size measurement omits it instead of copying an older listing's size.
// A record-window parse measures neither the file end nor its head.
// It identifies the transcript by inode alone. `headKey` fingerprints the first record.
// Only a read containing the head supplies `headKey`. `ino` is the filesystem inode.
// Appends retain the inode. Replacements can change it.
export interface SessionFileIdentity {
  size?: number;
  headKey?: string;
  dev?: number | string;
  ino?: number | string;
}

// Builds the measured file identity. A missing or nonpositive inode is omitted.
// Size and head fingerprint remain available without an inode.
export function transcriptIdentity(
  measured: { size?: number; dev?: number | string; ino?: number | string },
  headKey?: string,
): SessionFileIdentity {
  return {
    ...(measured.size === undefined ? {} : { size: measured.size }),
    ...(headKey === undefined ? {} : { headKey }),
    ...(measured.dev === undefined ? {} : { dev: measured.dev }),
    ...(typeof measured.ino === 'string'
      ? /^[1-9][0-9]*$/.test(measured.ino)
        ? { ino: measured.ino }
        : {}
      : Number.isSafeInteger(measured.ino) && measured.ino! > 0
        ? { ino: measured.ino }
        : {}),
  };
}

const RANK: Record<SessionNameSource, number> = { prompt: 0, generated: 1, custom: 2 };

// Returns the held name after an update. Lower-ranked updates are ignored.
// Within one rank, the later record wins regardless of read arrival order.
// A held `prompt` name never changes.
// An update without a record offset never replaces a held name of the same rank.
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

// Detects transcript replacement. Different inodes identify different files at the same path,
// including a larger replacement. A changed head fingerprint also identifies replacement.
// Fingerprints are compared only when both reads supplied them.
// A smaller size identifies replacement only when both reads lack a shared inode comparison.
// Read results can arrive out of order, so a smaller size with the same inode
// does not identify replacement.
export function replacedTranscript(held: SessionFileIdentity, next: SessionFileIdentity): boolean {
  const named = held.ino !== undefined && next.ino !== undefined;
  if (named) {
    if (held.ino !== next.ino || (held.dev !== undefined && next.dev !== undefined && held.dev !== next.dev)) {
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

// Holds names for Claude sessions seen by the panel. Each completed read reports its source.
// Every surface reads the held name without reporting updates while drawing.
export class SessionNames {
  private held = new Map<string, SessionName>();
  private files = new Map<string, SessionFileIdentity>();

  // Applies one read result. A changed file identity clears the old name before ranking the update.
  // Returns whether the held name changed.
  observe(
    sessionId: string,
    update: SessionName | null | undefined,
    file?: SessionFileIdentity,
    withdrawnPrompt = false,
  ): boolean {
    const before = this.held.get(sessionId) ?? null;
    let held = before;
    if (withdrawnPrompt && held?.source === 'prompt') held = null;
    if (file) {
      const seen = this.files.get(sessionId);
      const replaced = !!seen && replacedTranscript(seen, file);
      if (replaced) {
        held = null;
      }
      // Incomplete identity updates retain the earlier fields for the same transcript.
      // Later fingerprints and inodes remain comparable with those fields.
      // A replaced transcript starts with the new identity alone.
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

  // Applies names from parsed turns and returns the sessions whose held names changed.
  // Each update carries its transcript identity because files can change between reads.
  // Without identity, a title from the old file can outrank the replacement's names.
  // Stored metadata can then preserve the old title across restarts.
  observeTurns(
    turns: Iterable<{ sessionId: string } & Parameters<typeof parsedSessionName>[0]>,
    fileOf?: (sessionId: string) => SessionFileIdentity | undefined,
  ): Set<string> {
    const changed = new Set<string>();
    for (const turn of turns) {
      const update = parsedSessionName(turn);
      // Look up identity only for turns with a title. The lookup reads the file,
      // and one window can contain many turns from that session.
      if (this.observe(turn.sessionId, update, update ? fileOf?.(turn.sessionId) : undefined)) {
        changed.add(turn.sessionId);
      }
    }
    return changed;
  }
}
