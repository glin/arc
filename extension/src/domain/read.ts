export const READ_LIMIT = 2000;

export interface ReadableTurn {
  key: string;
  sessionId: string;
  startedAt: number;
  promptId?: string;
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
  agentRead: ReadonlyMap<string, string> = new Map(),
): boolean {
  if (read.has(card.key) || (card.promptId !== undefined && agentRead.get(card.key) === card.promptId)) {
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
  cards: (ReadableTurn & { kind: string })[],
  read: Iterable<string>,
  readTo: ReadonlyMap<string, number>,
  since = 0,
  agentRead: ReadonlyMap<string, string> = new Map(),
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
    if (isTurnRead(c, readSet, readTo, since, agentRead)) {
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

export interface AgentReadRecord {
  provider: 'claude' | 'codex';
  sessionId: string;
  source: string;
  scope: string;
  sourceRevision: string;
  promptId: string;
  startedAt: number;
}

export interface AgentReadSource {
  provider: AgentReadRecord['provider'];
  sessionId: string;
  source: string;
  scope: string;
  sourceRevision: string;
  // All identities at the supplied timestamps, including unfinished turns.
  identitiesComplete: boolean;
  turns: readonly { promptId: string; startedAt: number; finished: boolean }[];
}

export function validAgentReadRecord(value: unknown): value is AgentReadRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as AgentReadRecord;
  return (
    (r.provider === 'claude' || r.provider === 'codex') &&
    ['sessionId', 'source', 'scope', 'sourceRevision', 'promptId'].every((key) => {
      const text = r[key as 'sessionId'];
      return typeof text === 'string' && text.length > 0 && text.length <= 4096;
    }) &&
    Number.isFinite(r.startedAt) &&
    r.startedAt > 0
  );
}

export function agentReadIdentity(record: AgentReadRecord): string {
  return JSON.stringify([
    record.provider,
    record.sessionId,
    record.source,
    record.scope,
    record.sourceRevision,
    record.promptId,
    record.startedAt,
  ]);
}

export function normalizeAgentRead(raw: unknown): AgentReadRecord[] {
  if (!Array.isArray(raw)) return [];
  const records = new Map<string, AgentReadRecord>();
  for (const value of raw) {
    if (!validAgentReadRecord(value)) continue;
    const { provider, sessionId, source, scope, sourceRevision, promptId, startedAt } = value;
    const record = { provider, sessionId, source, scope, sourceRevision, promptId, startedAt };
    const identity = agentReadIdentity(record);
    records.delete(identity);
    records.set(identity, record);
  }
  return [...records.values()].slice(-READ_LIMIT);
}

export function currentAgentRead(record: AgentReadRecord, facts: AgentReadSource | null): boolean {
  if (!validAgentReadRecord(record) || !facts || !facts.identitiesComplete) return false;
  if (
    ['provider', 'sessionId', 'source', 'scope', 'sourceRevision'].some(
      (key) => record[key as 'source'] !== facts[key as 'source'],
    )
  )
    return false;
  const candidates = facts.turns.filter((turn) => turn.startedAt === record.startedAt);
  return candidates.length === 1 && candidates[0].finished && candidates[0].promptId === record.promptId;
}

export function projectAgentRead(
  records: readonly AgentReadRecord[],
  facts: (record: AgentReadRecord) => AgentReadSource | null,
): Map<string, string> {
  const projected = new Map<string, string>();
  const collisions = new Set<string>();
  for (const record of records) {
    if (!currentAgentRead(record, facts(record))) continue;
    const key = turnKey(record);
    const held = projected.get(key);
    if (held !== undefined && held !== record.promptId) collisions.add(key);
    projected.set(key, record.promptId);
  }
  for (const key of collisions) projected.delete(key);
  return projected;
}

export interface OrderedReadState {
  revision: number;
  read: string[];
  readTo: Record<string, number>;
  since: number;
  agentRead: AgentReadRecord[];
}

export type ReadOperation = {
  id: string;
  observedRevision: number;
} & (
  | { action: 'acknowledge'; records: AgentReadRecord[] }
  | { action: 'turn'; target: AgentReadRecord; read: boolean }
  | { action: 'session'; target: AgentReadRecord; read: boolean; newestAt: number }
  | { action: 'reset'; since: number }
  | { action: 'invalidate' }
);

export function reduceReadOperation(
  state: OrderedReadState,
  operation: ReadOperation,
  facts: (record: AgentReadRecord) => AgentReadSource | null,
): OrderedReadState | null {
  if (
    !Number.isSafeInteger(operation.observedRevision) ||
    operation.observedRevision < 0 ||
    operation.observedRevision > state.revision
  )
    return null;
  if (
    operation.action === 'acknowledge' &&
    (!operation.records.length || operation.records.some((record) => !currentAgentRead(record, facts(record))))
  )
    return null;
  if (
    (operation.action === 'turn' || operation.action === 'session') &&
    !currentAgentRead(operation.target, facts(operation.target))
  )
    return null;
  const next: OrderedReadState = {
    ...state,
    revision: state.revision + 1,
    read: [...state.read],
    readTo: { ...state.readTo },
    agentRead: normalizeAgentRead(state.agentRead),
  };
  switch (operation.action) {
    case 'acknowledge':
      next.agentRead = normalizeAgentRead([...next.agentRead, ...operation.records]);
      break;
    case 'turn': {
      const key = turnKey(operation.target);
      next.read = next.read.filter((one) => one !== key);
      if (operation.read) next.read = [...next.read, key].slice(-READ_LIMIT);
      else {
        const boundary = next.readTo[operation.target.sessionId] ?? next.since;
        if (operation.target.startedAt <= boundary)
          next.readTo[operation.target.sessionId] = operation.target.startedAt - 1;
        next.agentRead = next.agentRead.filter((one) => agentReadIdentity(one) !== agentReadIdentity(operation.target));
      }
      break;
    }
    case 'session': {
      const id = operation.target.sessionId;
      if (!Number.isFinite(operation.newestAt) || operation.newestAt < operation.target.startedAt) return null;
      next.readTo[id] = operation.read ? operation.newestAt : 0;
      if (!operation.read) {
        next.read = next.read.filter((key) => !key.startsWith(`${id}:`));
        next.agentRead = next.agentRead.filter((one) => one.sessionId !== id);
      }
      break;
    }
    case 'reset':
      if (!Number.isFinite(operation.since) || operation.since < 0) return null;
      next.read = [];
      next.readTo = {};
      next.agentRead = [];
      next.since = operation.since;
      break;
    case 'invalidate':
      next.agentRead = next.agentRead.filter((record) => currentAgentRead(record, facts(record)));
      break;
  }
  return next;
}

// Storage settles before accepted state changes or publication. Failed writes leave the accepted state intact.
export class OrderedReadOperations {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly results = new Map<string, { payload: string; result: Promise<{ revision: number } | null> }>();
  constructor(
    private state: OrderedReadState,
    private readonly limit = 256,
  ) {
    this.state = structuredClone(state);
    this.state.agentRead = normalizeAgentRead(this.state.agentRead);
  }
  snapshot(): OrderedReadState {
    return structuredClone(this.state);
  }
  run(
    operation: ReadOperation,
    facts: (record: AgentReadRecord) => AgentReadSource | null,
    persist: (state: OrderedReadState) => Promise<void>,
    publish: (state: OrderedReadState) => void,
  ): Promise<{ revision: number } | null> {
    const payload = JSON.stringify(operation);
    const held = this.results.get(operation.id);
    if (held)
      return held.payload === payload
        ? held.result
        : Promise.reject(new Error('The read operation ID names a different action.'));
    if (!operation.id || this.results.size >= this.limit)
      return Promise.reject(new Error('The read operation limit was reached.'));
    const result = this.tail.then(async () => {
      const next = reduceReadOperation(this.state, operation, facts);
      if (!next) return null;
      await persist(structuredClone(next));
      this.state = next;
      try {
        publish(this.snapshot());
      } catch {
        throw new ReadPublicationError();
      }
      return { revision: this.state.revision };
    });
    this.results.set(operation.id, { payload, result });
    this.tail = result.catch(() => {});
    return result;
  }
}

export class ReadPublicationError extends Error {
  constructor() {
    super('The saved read state could not be published.');
  }
}

export function preserveHostRead<
  T extends {
    read: string[];
    readTo: Record<string, number>;
    since: number;
    agentRead?: AgentReadRecord[];
    readRevision?: number;
  },
>(current: T, preferences: T): T {
  const next = { ...preferences, read: current.read, readTo: current.readTo, since: current.since };
  if (current.agentRead === undefined) delete next.agentRead;
  else next.agentRead = current.agentRead;
  if (current.readRevision === undefined) delete next.readRevision;
  else next.readRevision = current.readRevision;
  return next;
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
