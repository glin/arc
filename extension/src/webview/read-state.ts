import { canMarkRead, isTurnRead, READ_LIMIT, type ReadableTurn } from '../domain/read.ts';

export interface ReadCard extends ReadableTurn {
  kind: string;
  live?: boolean;
}

export interface ReadStateSnapshot {
  read: ReadonlySet<string>;
  readTo: ReadonlyMap<string, number>;
  since: number;
  revision: number;
  agentRead: ReadonlyMap<string, string>;
}

export interface ReadStateOptions {
  initial: { read?: unknown; readTo?: unknown; since?: unknown };
  open: Set<string>;
  cards(): readonly ReadCard[];
  newestTurnAt(sessionId: string): number | null;
  save(): void;
  refreshSelection(): void;
}

export interface ReadStateOwner {
  synchronize(state: {
    revision: number;
    read: readonly string[];
    readTo: Readonly<Record<string, number>>;
    since: number;
    agentRead: readonly (readonly [string, string])[];
  }): boolean;
  snapshot(): ReadStateSnapshot;
  subscribe(listener: () => void): () => void;
  isRead(card: ReadCard): boolean;
  canMark(card: ReadCard): boolean;
  mark(key: string): boolean;
  markMany(keys: readonly string[]): boolean;
  toggle(card: ReadCard): void;
  set(key: string, value: boolean): void;
  setSession(sessionId: string, value: boolean): void;
  reset(since: number): void;
}

export function createReadState(options: ReadStateOptions): ReadStateOwner {
  const read = new Set(
    Array.isArray(options.initial.read)
      ? options.initial.read.filter((value): value is string => typeof value === 'string')
      : [],
  );
  const source =
    options.initial.readTo && typeof options.initial.readTo === 'object'
      ? (options.initial.readTo as Record<string, unknown>)
      : {};
  const readTo = new Map<string, number>(
    Object.entries(source).filter(
      (entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]),
    ),
  );
  let since = typeof options.initial.since === 'number' ? options.initial.since : 0;
  let revision = -1;
  const agentRead = new Map<string, string>();
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const add = (key: string): boolean => {
    const known = read.delete(key);
    read.add(key);
    if (known) {
      return false;
    }
    while (read.size > READ_LIMIT) {
      read.delete(read.values().next().value as string);
    }
    return true;
  };

  const watermark = (sessionId: string, at: number) => {
    readTo.delete(sessionId);
    readTo.set(sessionId, at);
  };

  const mark = (key: string): boolean => {
    const changed = add(key);
    if (changed) {
      options.save();
      notify();
    }
    return changed;
  };

  const unmark = (card: ReadCard) => {
    let changed = read.delete(card.key);
    const boundary = readTo.get(card.sessionId) ?? since;
    if (boundary > 0 && card.startedAt <= boundary) {
      watermark(card.sessionId, card.startedAt - 1);
      changed = true;
    }
    if (changed) {
      options.save();
      notify();
    }
  };

  const owner: ReadStateOwner = {
    synchronize(state) {
      if (!Number.isSafeInteger(state.revision) || state.revision < 0 || state.revision <= revision) return false;
      read.clear();
      for (const key of state.read.slice(-READ_LIMIT)) read.add(key);
      readTo.clear();
      for (const [id, at] of Object.entries(state.readTo)) readTo.set(id, at);
      since = state.since;
      agentRead.clear();
      for (const [key, promptId] of state.agentRead) agentRead.set(key, promptId);
      revision = state.revision;
      notify();
      return true;
    },
    snapshot() {
      return { read, readTo, since, revision, agentRead };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isRead(card) {
      return isTurnRead(card, read, readTo, since, agentRead);
    },
    canMark(card) {
      return canMarkRead(card);
    },
    mark,
    markMany(keys) {
      let changed = false;
      for (const key of keys) {
        if (add(key)) {
          changed = true;
        }
      }
      if (changed) {
        options.save();
        notify();
      }
      return changed;
    },
    toggle(card) {
      if (owner.isRead(card)) {
        options.open.delete(card.key);
        unmark(card);
        options.refreshSelection();
      } else {
        mark(card.key);
      }
    },
    set(key, value) {
      const card = options.cards().find((candidate) => candidate.key === key);
      if (!card || owner.isRead(card) === value) {
        return;
      }
      owner.toggle(card);
    },
    setSession(sessionId, value) {
      const cards = options.cards().filter((card) => card.kind === 'turn' && card.sessionId === sessionId);
      if (value) {
        const newest = options.newestTurnAt(sessionId);
        if (newest === null) {
          return;
        }
        let changed = false;
        for (const card of cards) {
          if (canMarkRead(card) && add(card.key)) {
            changed = true;
          }
        }
        if (readTo.get(sessionId) !== newest) {
          watermark(sessionId, newest);
          changed = true;
        }
        if (!changed) {
          return;
        }
      } else {
        let changed = readTo.get(sessionId) !== 0;
        watermark(sessionId, 0);
        const prefix = `${sessionId}:`;
        for (const key of [...read]) {
          if (key.startsWith(prefix) && read.delete(key)) {
            changed = true;
          }
        }
        let shut = false;
        for (const key of [...options.open]) {
          if (key.startsWith(prefix)) {
            options.open.delete(key);
            changed = true;
            shut = true;
          }
        }
        if (!changed) {
          return;
        }
        if (shut) {
          options.refreshSelection();
        }
      }
      options.save();
      notify();
    },
    reset(nextSince) {
      read.clear();
      readTo.clear();
      since = Number.isFinite(nextSince) ? nextSince : 0;
      notify();
    },
  };
  return owner;
}
