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
  // Identity coverage does not establish that a delivered window contains all history.
  historyComplete?: boolean;
  turns: readonly AgentReadTurnIdentity[];
}

export interface AgentReadTurnIdentity {
  promptId: string;
  startedAt: number;
  finished: boolean;
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
  return currentReadIdentity(record, facts, true);
}

function currentReadIdentity(
  record: AgentReadRecord,
  facts: AgentReadSource | null,
  requireFinished: boolean,
): boolean {
  if (!validAgentReadRecord(record) || !facts || !facts.identitiesComplete) return false;
  if (
    ['provider', 'sessionId', 'source', 'scope', 'sourceRevision'].some(
      (key) => record[key as 'source'] !== facts[key as 'source'],
    )
  )
    return false;
  const candidates = facts.turns.filter((turn) => turn.startedAt === record.startedAt);
  return (
    candidates.length === 1 &&
    (!requireFinished || candidates[0].finished) &&
    candidates[0].promptId === record.promptId &&
    facts.turns.filter((turn) => turn.promptId === record.promptId).length === 1
  );
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

export type ReaderReadTarget = { sessionId: string; startedAt: number; promptId?: string };

export type ReadOperation = {
  id: string;
  namespace?: 'browser' | 'cli' | 'host';
  observedRevision: number;
} & (
  | { action: 'acknowledge'; records: AgentReadRecord[] }
  | { action: 'turn'; target: ReaderReadTarget; read: boolean }
  | { action: 'session'; target: ReaderReadTarget; read: boolean; newestAt: number }
  | { action: 'reset'; since: number }
  | { action: 'invalidate' }
);

export type ReaderReadAdmission = (operation: Extract<ReadOperation, { action: 'turn' | 'session' }>) => boolean;

export type ReaderReadEvent = Exclude<ReadOperation, { action: 'acknowledge' }> & {
  namespace?: 'browser' | 'host';
};

function currentReaderRead(
  target: ReaderReadTarget,
  facts: (record: AgentReadRecord) => AgentReadSource | null,
): boolean {
  if (!validAgentReadRecord(target)) return false;
  const source = facts(target);
  if (!source) return false;
  // Reader actions admit unfinished identities. Agent acknowledgments still require completion.
  return currentReadIdentity(target, source, false);
}

function knownAgentReadRemoval(record: AgentReadRecord, source: AgentReadSource | null): boolean {
  if (!source) return false;
  const sameBinding = ['provider', 'sessionId', 'source', 'scope', 'sourceRevision'].every(
    (key) => record[key as 'source'] === source[key as 'source'],
  );
  return !sameBinding || (source.identitiesComplete && !currentAgentRead(record, source));
}

export function reduceReadOperation(
  state: OrderedReadState,
  operation: ReadOperation,
  facts: (record: AgentReadRecord) => AgentReadSource | null,
  admitReader: ReaderReadAdmission = (operation) => currentReaderRead(operation.target, facts),
): OrderedReadState | null {
  if (
    !Number.isSafeInteger(operation.observedRevision) ||
    operation.observedRevision < 0 ||
    operation.observedRevision > state.revision ||
    !Number.isSafeInteger(state.revision + 1)
  )
    return null;
  if (
    operation.action === 'acknowledge' &&
    (!operation.records.length || operation.records.some((record) => !currentAgentRead(record, facts(record))))
  )
    return null;
  if (
    (operation.action === 'turn' || operation.action === 'session') &&
    (!Number.isFinite(operation.target.startedAt) ||
      operation.target.startedAt <= 0 ||
      !operation.target.sessionId ||
      typeof operation.read !== 'boolean' ||
      !admitReader(operation))
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
        next.agentRead = next.agentRead.filter(
          (one) =>
            one.sessionId !== operation.target.sessionId ||
            one.startedAt !== operation.target.startedAt ||
            one.promptId !== operation.target.promptId ||
            (validAgentReadRecord(operation.target) &&
              agentReadIdentity(one) !== agentReadIdentity(operation.target)) ||
            !currentAgentRead(one, facts(one)),
        );
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
      next.agentRead = next.agentRead.filter((record) => !knownAgentReadRemoval(record, facts(record)));
      break;
  }
  return next;
}

// Storage settles before accepted state changes or publication. Failed writes leave the accepted state intact.
export class OrderedReadOperations {
  private tail: Promise<unknown> = Promise.resolve();
  private unsettled = false;
  private pending = 0;
  private readonly results = new Map<string, { payload: string; result: Promise<{ revision: number } | null> }>();
  constructor(
    private state: OrderedReadState,
    private readonly limit = 256,
    private readonly current?: () => OrderedReadState,
  ) {
    this.state = structuredClone(state);
    this.state.agentRead = normalizeAgentRead(this.state.agentRead);
  }
  snapshot(): OrderedReadState {
    return structuredClone(this.current?.() ?? this.state);
  }
  serialize<T>(operation: () => Promise<T>, admitted?: () => void): Promise<T> {
    if (this.pending >= this.limit) return Promise.reject(new Error('The read save limit was reached.'));
    admitted?.();
    this.pending++;
    const result = this.tail.then(async () => {
      try {
        if (this.unsettled) throw new ReadPersistenceUnknownError();
        return await operation();
      } catch (error) {
        if (error instanceof ReadPersistenceUnknownError) this.unsettled = true;
        throw error;
      } finally {
        this.pending--;
      }
    });
    this.tail = result.catch(() => {});
    return result;
  }
  run(
    operation: ReadOperation,
    facts: (record: AgentReadRecord) => AgentReadSource | null,
    persist: (state: OrderedReadState) => Promise<ReadStorageSettlement | void>,
    publish: (state: OrderedReadState) => void | Promise<void>,
    admitReader?: ReaderReadAdmission,
  ): Promise<{ revision: number } | null> {
    const payload = JSON.stringify(operation);
    const identity = JSON.stringify([operation.namespace ?? 'host', operation.id]);
    const held = this.results.get(identity);
    if (held)
      return held.payload === payload
        ? held.result
        : Promise.reject(new Error('The read operation ID names a different action.'));
    if (!operation.id || operation.id.length > 512 || payload.length > 512 * 1024 || this.results.size >= this.limit)
      return Promise.reject(new Error('The read operation limit was reached.'));
    const admitted = structuredClone(operation);
    const result = this.serialize(async () => {
      const next = reduceReadOperation(this.snapshot(), admitted, facts, admitReader);
      if (!next) return null;
      checkReadStorageSettlement(await persist(structuredClone(next)));
      this.state = next;
      try {
        await publish(this.snapshot());
      } catch {
        throw new ReadPublicationError();
      }
      return { revision: this.state.revision };
    });
    this.results.set(identity, { payload, result });
    return result;
  }
}

export type ReadStorageSettlement = { status: 'saved' | 'failed' | 'unknown' };

export class ReadPersistenceUnknownError extends Error {
  constructor() {
    super('The read state save has an unknown outcome. Preserve this request ID.');
  }
}

function checkReadStorageSettlement(settlement: ReadStorageSettlement | void): void {
  if (settlement?.status === 'unknown') throw new ReadPersistenceUnknownError();
  if (settlement?.status === 'failed') throw new Error('The read state could not be saved.');
}

export interface HostReadState {
  read: string[];
  readTo: Record<string, number>;
  since: number;
  agentRead?: AgentReadRecord[];
  readRevision?: number;
}

function orderedHostRead(state: HostReadState): OrderedReadState {
  return {
    revision: state.readRevision ?? 0,
    read: state.read,
    readTo: state.readTo,
    since: state.since,
    agentRead: normalizeAgentRead(state.agentRead),
  };
}

// All writers share one barrier. Storage receives a copy and acceptance follows settled success.
export class HostReadPersistence<T extends HostReadState> {
  readonly operations: OrderedReadOperations;
  private state: T;
  constructor(
    initial: T,
    private readonly persist: (state: T) => Promise<ReadStorageSettlement | void>,
    private readonly publish: (state: T) => void | Promise<void>,
    limit = 256,
  ) {
    this.state = structuredClone(initial);
    this.operations = new OrderedReadOperations(orderedHostRead(this.state), limit, () => orderedHostRead(this.state));
  }
  snapshot(): T {
    return structuredClone(this.state);
  }
  read(
    operation: ReadOperation,
    facts: (record: AgentReadRecord) => AgentReadSource | null,
    admitReader?: ReaderReadAdmission,
    preferences?: (current: T) => T,
  ): Promise<{ revision: number } | null> {
    return this.operations.run(
      operation,
      facts,
      (read) => this.persistRead(read, preferences),
      () => this.publishAccepted(),
      admitReader,
    );
  }
  // Ordinary host and page events share storage ordering without retaining historical outcomes.
  readerEvent(
    operation: ReaderReadEvent,
    facts: (record: AgentReadRecord) => AgentReadSource | null,
    admitReader?: ReaderReadAdmission,
    preferences?: (current: T) => T,
    admitted?: () => void,
  ): Promise<{ revision: number } | null> {
    const payload = JSON.stringify(operation);
    if (!operation.id || operation.id.length > 512 || payload.length > 512 * 1024)
      return Promise.reject(new Error('The read operation limit was reached.'));
    const event = structuredClone(operation);
    return this.operations.serialize(async () => {
      const next = reduceReadOperation(this.operations.snapshot(), event, facts, admitReader);
      if (!next) return null;
      await this.persistRead(next, preferences);
      try {
        await this.publishAccepted();
      } catch {
        throw new ReadPublicationError();
      }
      return { revision: next.revision };
    }, admitted);
  }
  // Supply these callbacks only to this owner's ordered operations.
  async persistRead(read: OrderedReadState, preferences?: (current: T) => T): Promise<void> {
    const next = {
      ...(preferences ? preferences(this.snapshot()) : this.snapshot()),
      read: read.read,
      readTo: read.readTo,
      since: read.since,
      agentRead: read.agentRead,
      readRevision: read.revision,
    };
    checkReadStorageSettlement(await this.persist(structuredClone(next)));
    this.state = structuredClone(next);
  }
  publishAccepted(): void | Promise<void> {
    return this.publish(this.snapshot());
  }
  savePreferences(preferences: T): Promise<void> {
    const admitted = structuredClone(preferences);
    return this.saveHost((current) => preserveHostRead(current, admitted));
  }
  saveHost(update: (current: T) => T): Promise<void> {
    return this.operations.serialize(async () => {
      const next = structuredClone(update(this.snapshot()));
      if (JSON.stringify(orderedHostRead(next)) !== JSON.stringify(orderedHostRead(this.state)))
        throw new Error('Read changes require a read action.');
      checkReadStorageSettlement(await this.persist(structuredClone(next)));
      this.state = structuredClone(next);
      try {
        await this.publish(this.snapshot());
      } catch {
        throw new ReadPublicationError();
      }
    });
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
