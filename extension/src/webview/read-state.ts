import { canMarkRead, isTurnRead, READ_LIMIT, type ReadableTurn, type ReaderReadEvent } from '../domain/read.ts';

const READER_PENDING_LIMIT = 256;

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
  pageId?: string;
  initial: { read?: unknown; readTo?: unknown; since?: unknown };
  open: Set<string>;
  cards(): readonly ReadCard[];
  newestTurnAt(sessionId: string): number | null;
  save(): void;
  operate?(operation: ReaderReadEvent): void;
  refreshSelection(): void;
}

export interface ReadStateOwner {
  readonly pageId: string;
  admit(id: string, admitted: boolean): void;
  dispose(): void;
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
  const tab =
    options.pageId ??
    Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
  let sequence = 0;
  const events: ReaderReadEvent[] = [];
  let retry: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const send = () => {
    if (disposed || !events.length) return;
    retry = setTimeout(send, 500);
    options.operate?.(structuredClone(events[0]));
  };
  const pendingMarks = new Map<string, ReadCard>();
  const pendingUnread = new Map<string, ReadCard>();
  const pendingUnreadSessions = new Set<string>();
  const pendingReadSessions = new Map<string, number>();
  const identity = (card: Pick<ReadCard, 'sessionId' | 'startedAt' | 'promptId'>) =>
    JSON.stringify([card.sessionId, card.startedAt, card.promptId]);
  const operate = (
    action:
      | Omit<Extract<ReaderReadEvent, { action: 'turn' }>, 'id' | 'observedRevision'>
      | Omit<Extract<ReaderReadEvent, { action: 'session' }>, 'id' | 'observedRevision'>,
  ) => {
    if (!options.operate || revision < 0) return false;
    if (events.length >= READER_PENDING_LIMIT || disposed) return true;
    events.push(structuredClone({ ...action, id: `${tab}:${++sequence}`, observedRevision: Math.max(0, revision) }));
    if (events.length === 1) send();
    return true;
  };

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

  const mark = (key: string, explicit = false): boolean => {
    if (options.operate && revision >= 0 && (events.length >= READER_PENDING_LIMIT || disposed)) return false;
    const card = options.cards().find((one) => one.key === key);
    if (card && options.operate && revision >= 0) {
      const id = identity(card);
      const removing = pendingUnread.has(id) || pendingUnreadSessions.has(card.sessionId);
      if (!explicit && card.startedAt <= (pendingReadSessions.get(card.sessionId) ?? 0)) return false;
      const transporting = events.some(
        (event) => event.action === 'turn' && event.read && identity(event.target) === id,
      );
      if (
        (!explicit && removing) ||
        (isTurnRead(card, read, readTo, since) && !removing) ||
        (pendingMarks.has(id) && (!explicit || transporting))
      )
        return false;
      if (explicit) {
        pendingUnread.delete(id);
        pendingUnreadSessions.delete(card.sessionId);
      }
      pendingMarks.set(id, card);
    }
    if (
      card &&
      operate({
        action: 'turn',
        target: { sessionId: card.sessionId, startedAt: card.startedAt, promptId: card.promptId },
        read: true,
      })
    )
      return true;
    const changed = add(key);
    if (changed) {
      options.save();
      notify();
    }
    return changed;
  };

  const unmark = (card: ReadCard) => {
    if (options.operate && revision >= 0 && (events.length >= READER_PENDING_LIMIT || disposed)) return;
    if (options.operate && revision >= 0) {
      pendingMarks.delete(identity(card));
      pendingUnread.set(identity(card), card);
    }
    const shut = options.open.delete(card.key);
    if (shut) options.refreshSelection();
    if (shut && options.operate && revision >= 0) options.save();
    if (
      operate({
        action: 'turn',
        target: { sessionId: card.sessionId, startedAt: card.startedAt, promptId: card.promptId },
        read: false,
      })
    )
      return;
    let changed = read.delete(card.key) || shut;
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
    pageId: tab,
    admit(id, admitted) {
      if (!admitted || events[0]?.id !== id || disposed) return;
      clearTimeout(retry);
      retry = undefined;
      events.shift();
      if (events.length) send();
    },
    dispose() {
      disposed = true;
      clearTimeout(retry);
      retry = undefined;
      events.length = 0;
    },
    synchronize(state) {
      if (!Number.isSafeInteger(state.revision) || state.revision < 0 || state.revision < revision) return false;
      if (
        state.revision === revision &&
        (JSON.stringify([...read]) !== JSON.stringify(state.read) ||
          JSON.stringify(Object.fromEntries(readTo)) !== JSON.stringify(state.readTo) ||
          since !== state.since)
      )
        return false;
      if (state.revision === revision && JSON.stringify([...agentRead]) === JSON.stringify(state.agentRead))
        return false;
      read.clear();
      for (const key of state.read.slice(-READ_LIMIT)) read.add(key);
      readTo.clear();
      for (const [id, at] of Object.entries(state.readTo)) readTo.set(id, at);
      since = state.since;
      agentRead.clear();
      for (const [key, promptId] of state.agentRead) agentRead.set(key, promptId);
      revision = state.revision;
      for (const [id, card] of pendingMarks) if (isTurnRead(card, read, readTo, since)) pendingMarks.delete(id);
      for (const [id, card] of pendingUnread) if (!owner.isRead(card)) pendingUnread.delete(id);
      for (const id of pendingUnreadSessions) {
        if (
          readTo.get(id) === 0 &&
          ![...read].some((key) => key.startsWith(`${id}:`)) &&
          !options.cards().some((card) => card.sessionId === id && owner.isRead(card))
        )
          pendingUnreadSessions.delete(id);
      }
      for (const [id, at] of pendingReadSessions) if ((readTo.get(id) ?? since) >= at) pendingReadSessions.delete(id);
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
      if (options.operate && revision >= 0) {
        let changed = false;
        for (const key of keys) if (mark(key)) changed = true;
        return changed;
      }
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
        unmark(card);
      } else {
        mark(card.key, true);
      }
    },
    set(key, value) {
      const card = options.cards().find((candidate) => candidate.key === key);
      if (card && options.operate && revision >= 0) {
        if (value) {
          mark(key, true);
        } else unmark(card);
        return;
      }
      if (!card || owner.isRead(card) === value) {
        return;
      }
      owner.toggle(card);
    },
    setSession(sessionId, value) {
      if (options.operate && revision >= 0 && (events.length >= READER_PENDING_LIMIT || disposed)) return;
      const cards = options.cards().filter((card) => card.kind === 'turn' && card.sessionId === sessionId);
      const newest = options.newestTurnAt(sessionId);
      const target = cards.at(0);
      if (!value && options.operate && revision >= 0) {
        pendingReadSessions.delete(sessionId);
        pendingUnreadSessions.add(sessionId);
        for (const card of cards) pendingMarks.delete(identity(card));
        let shut = false;
        for (const key of [...options.open]) {
          if (key.startsWith(`${sessionId}:`)) {
            options.open.delete(key);
            shut = true;
          }
        }
        if (shut) {
          options.refreshSelection();
          options.save();
        }
      }
      if (value) {
        pendingUnreadSessions.delete(sessionId);
        if (newest !== null && options.operate && revision >= 0) pendingReadSessions.set(sessionId, newest);
      }
      if (
        newest !== null &&
        operate({
          action: 'session',
          target: { sessionId, startedAt: target?.startedAt ?? newest, promptId: target?.promptId },
          newestAt: newest,
          read: value,
        })
      )
        return;
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
