import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { LauncherRequest } from './view/launcher';
import type { SessionListingRow } from './sessionreads';
import type { GuardedAttempt, GuardedReceipt } from './agentwire';
import {
  currentAgentRead,
  normalizeAgentRead,
  OrderedReadOperations,
  ReadPublicationError,
  type OrderedReadState,
  type AgentReadRecord,
  type AgentReadSource,
} from './domain/read.ts';

export interface SessionWriteParams {
  sessionId?: string;
  turns?: number;
  setup?: LauncherRequest;
  prompt?: string;
  name?: string;
  labels?: string[];
  pinned?: boolean;
  agentRun?: boolean;
  action?: 'label-add' | 'label-remove' | 'pin' | 'unpin' | 'archive' | 'unarchive';
  dryRun?: boolean;
  force?: boolean;
  // A sessions listing page. The host signs the cursor, and the CLI passes it through unread.
  query?: string;
  cursor?: string;
  limit?: number;
  // A guarded follow-up names the observation that its prompt continues.
  observation?: string;
}

// An opaque observation is base64url text with one dot. The host signs it, and the CLI passes it through unread.
export const SESSION_OBSERVATION = /^[A-Za-z0-9_-]{1,900}\.[A-Za-z0-9_-]{43}$/;
export const READ_OBSERVATION_BYTES = 12 * 1024;
export const READ_OBSERVATION = /^[A-Za-z0-9_-]{1,12200}\.[A-Za-z0-9_-]{43}$/;

export function validSessionWrite(method: string, params: Record<string, unknown>): boolean {
  const text = (value: unknown, limit: number) => typeof value === 'string' && value.length <= limit;
  const labels = (value: unknown) => Array.isArray(value) && value.length <= 20 && value.every((one) => text(one, 200));
  if (method === 'setups') return Object.keys(params).length === 0;
  if (method === 'read')
    return (
      Object.keys(params).sort().join(',') === 'dryRun,observation,sessionId' &&
      text(params.sessionId, 256) &&
      !!params.sessionId &&
      typeof params.dryRun === 'boolean' &&
      typeof params.observation === 'string' &&
      READ_OBSERVATION.test(params.observation)
    );
  if (method === 'send')
    return (
      Object.keys(params).sort().join(',') === 'observation,prompt,sessionId' &&
      text(params.sessionId, 256) &&
      !!params.sessionId &&
      text(params.prompt, 48 * 1024) &&
      typeof params.observation === 'string' &&
      SESSION_OBSERVATION.test(params.observation)
    );
  if (method === 'start') {
    const setup = params.setup as Record<string, unknown> | undefined;
    const fields = ['setup', 'prompt', 'name', 'labels', 'pinned', 'agentRun'];
    return (
      Object.keys(params).every((key) => fields.includes(key)) &&
      text(params.prompt, 48 * 1024) &&
      typeof params.agentRun === 'boolean' &&
      (params.name === undefined || text(params.name, 200)) &&
      (params.labels === undefined || labels(params.labels)) &&
      (params.pinned === undefined || typeof params.pinned === 'boolean') &&
      !!setup &&
      !Array.isArray(setup) &&
      (setup.kind === 'row'
        ? Object.keys(setup).sort().join(',') === 'key,kind' && text(setup.key, 200)
        : setup.kind === 'custom' &&
          Object.keys(setup).sort().join(',') === 'agent,effort,kind,model,permissionMode' &&
          ['agent', 'model', 'effort', 'permissionMode'].every((key) => text(setup[key], 200)))
    );
  }
  if (method !== 'curate') return false;
  return (
    Object.keys(params).every((key) => ['sessionId', 'action', 'labels', 'dryRun', 'force'].includes(key)) &&
    text(params.sessionId, 256) &&
    !!params.sessionId &&
    ['label-add', 'label-remove', 'pin', 'unpin', 'archive', 'unarchive'].includes(params.action as string) &&
    typeof params.dryRun === 'boolean' &&
    typeof params.force === 'boolean' &&
    (params.labels === undefined || labels(params.labels)) &&
    (!(params.action as string).startsWith('label-') || labels(params.labels))
  );
}

// The canonical binding of a write request. A send binds the requester with its provider, the activation,
// the target, the observation, and the exact prompt text. The start association is the requester and target
// pair within one activation, so equal bindings always name the same association.
export function sessionWriteBinding(
  activation: string,
  method: string,
  params: SessionWriteParams,
  requester: string | null,
  requesterProvider: RequesterProvider | null,
): unknown {
  return { activation, method, params, requester, requesterProvider };
}

// Retention never evicts an admitted ID. New guarded sends reserve lifetime capacity before their handlers run.
// Refused sends move to a separate table, so they keep their bindings without filling the shared result table.
export class SessionWriteRequests {
  private readonly results = new Map<string, { payload: string; result: Promise<unknown> }>();
  private readonly refusals = new Map<string, { payload: string; result: unknown }>();
  private guardedAdmissions = 0;
  constructor(
    private readonly windowId: string,
    private readonly limit = 256,
    private readonly guardedLimit = limit,
  ) {}
  run(id: string, payload: unknown, apply: () => unknown | Promise<unknown>): Promise<unknown> {
    return this.runBound(id, payload, apply, false);
  }

  private runBound(
    id: string,
    payload: unknown,
    apply: () => unknown | Promise<unknown>,
    guarded: boolean,
  ): Promise<unknown> {
    if (!id.startsWith(this.windowId + ':'))
      return Promise.reject(new Error('The request outcome belongs to another Arc activation and is unknown.'));
    const hash = this.hash(payload);
    const refused = this.refusals.get(id);
    if (refused)
      return refused.payload === hash
        ? Promise.resolve(refused.result)
        : Promise.reject(new Error('The request ID already names a different request.'));
    const held = this.results.get(id);
    if (held)
      return held.payload === hash
        ? held.result
        : Promise.reject(new Error('The request ID already names a different request.'));
    if (this.results.size >= this.limit || (guarded && this.guardedAdmissions >= this.guardedLimit))
      return Promise.reject(new Error('This Arc window has reached its session-write request limit.'));
    if (guarded) this.guardedAdmissions += 1;
    const result = Promise.resolve().then(apply);
    this.results.set(id, { payload: hash, result });
    return result;
  }

  // Runs a guarded send. Its guarded rejection allowlist is empty, so a refused result never follows attempted input.
  runGuarded(id: string, payload: unknown, apply: () => GuardedSendResult | Promise<GuardedSendResult>) {
    return this.runBound(id, payload, apply, true).then((result) => {
      const held = this.results.get(id);
      if ((result as GuardedSendResult).status === 'refused' && held) {
        this.results.delete(id);
        this.refusals.set(id, { payload: held.payload, result });
      }
      return result;
    });
  }

  private hash(payload: unknown): string {
    return createHash('sha256')
      .update(
        JSON.stringify(payload, (_key, value) =>
          value && typeof value === 'object' && !Array.isArray(value)
            ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
            : value,
        ),
      )
      .digest('hex');
  }
}

// Current no-turn rows use the same archive checks as completed turns.
// Rows listed as subagents or background refuse archive even with force. The listing reports them while Arc has
// no end record for that work. The CLI reports idle while that work runs, so archive retirement can end the
// process that holds it.
// Known running or Needs input evidence admits a forced archive whatever the transcript facts say.
// Force also admits a session whose state is unavailable, as archiving from the rail does.
// Archive keeps the current turn and open asks, and retirement waits for both to settle.
export function archiveRefusal(row: SessionListingRow, force: boolean): string | null {
  if (row.runStatus === 'subagents' || row.runStatus === 'background')
    return 'Arc cannot tell whether background work in the session ended, and archive can end it.';
  if (['running', 'waiting'].includes(row.runStatus) || ['running', 'input'].includes(row.attention))
    return force ? null : 'The session is running or needs input. Use --force to archive it.';
  if (row.facts !== 'current' || row.attention === 'unknown' || row.runStatus === 'unknown')
    return force ? null : 'The session state is unavailable. Show Arc and retry.';
  if (row.attention === 'unread' && !force) return 'The completed session is unread. Use --force to archive it.';
  return null;
}

export type RequesterProvider = 'claude' | 'codex';

// Trusted attribution within the authenticated local channel. It is not cryptographic proof of the caller.
export interface RequesterIdentity {
  provider: RequesterProvider;
  id: string;
}

export interface ReadObservationFacts {
  records: AgentReadRecord[];
  projection: string;
}

export interface ReadWriteResult {
  version: 1;
  status: 'applied' | 'dry-run' | 'refused' | 'unknown';
  requestId: string;
  sessionId: string;
  requester: RequesterIdentity | null;
  marked: { promptId: string; startedAt: number }[];
  reason: string;
}

// Read receipts authorize delivered completed identities independently of send ownership.
export class SessionReadObservations {
  constructor(
    private readonly activation: string,
    private readonly secret = randomBytes(32),
  ) {}
  observe(requester: RequesterIdentity | null, facts: ReadObservationFacts): string | null {
    if (
      !requester ||
      !facts.records.length ||
      facts.records.length > 20 ||
      normalizeAgentRead(facts.records).length !== facts.records.length
    )
      return null;
    const first = facts.records[0];
    if (
      facts.records.some((record) =>
        ['provider', 'sessionId', 'source', 'scope', 'sourceRevision'].some(
          (key) => record[key as 'source'] !== first[key as 'source'],
        ),
      )
    )
      return null;
    const body = Buffer.from(JSON.stringify({ version: 1, activation: this.activation, requester, ...facts })).toString(
      'base64url',
    );
    const token = `${body}.${createHmac('sha256', this.secret).update(body).digest('base64url')}`;
    return READ_OBSERVATION.test(token) &&
      Buffer.byteLength(JSON.stringify({ readObservation: token })) <= READ_OBSERVATION_BYTES
      ? token
      : null;
  }
  admit(
    observation: string,
    requester: RequesterIdentity | null,
    sessionId: string,
    facts: (record: AgentReadRecord) => AgentReadSource | null,
  ): AgentReadRecord[] | null {
    if (!requester || !READ_OBSERVATION.test(observation)) return null;
    const [body, signature] = observation.split('.');
    const expected = createHmac('sha256', this.secret).update(body).digest();
    const supplied = Buffer.from(signature, 'base64url');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
    try {
      const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (
        parsed.version !== 1 ||
        parsed.activation !== this.activation ||
        parsed.requester?.provider !== requester.provider ||
        parsed.requester?.id !== requester.id ||
        typeof parsed.projection !== 'string'
      )
        return null;
      const records = normalizeAgentRead(parsed.records);
      if (
        !records.length ||
        records.length !== parsed.records.length ||
        records.some((record) => record.sessionId !== sessionId || !currentAgentRead(record, facts(record)))
      )
        return null;
      return records;
    } catch {
      return null;
    }
  }
}

export async function runSessionRead(
  request: {
    requestId: string;
    sessionId: string;
    observation: string;
    requester: RequesterIdentity | null;
    dryRun: boolean;
  },
  observations: SessionReadObservations,
  operations: OrderedReadOperations,
  facts: (record: AgentReadRecord) => AgentReadSource | null,
  persist: (state: OrderedReadState) => Promise<void>,
  publish: (state: OrderedReadState) => void,
): Promise<ReadWriteResult> {
  const base = {
    version: 1 as const,
    requestId: request.requestId,
    sessionId: request.sessionId,
    requester: request.requester,
    marked: [] as { promptId: string; startedAt: number }[],
  };
  const records = observations.admit(request.observation, request.requester, request.sessionId, facts);
  if (!records)
    return {
      ...base,
      status: 'refused',
      reason: 'The read observation is stale or unavailable. Read the session again.',
    };
  if (request.dryRun)
    return {
      ...base,
      status: 'dry-run',
      marked: records.map(({ promptId, startedAt }) => ({ promptId, startedAt })),
      reason: 'The completed turns can be marked read. No state was saved.',
    };
  try {
    const accepted = await operations.run(
      { id: request.requestId, observedRevision: operations.snapshot().revision, action: 'acknowledge', records },
      facts,
      persist,
      publish,
    );
    if (!accepted)
      return { ...base, status: 'refused', reason: 'The session changed before marking read. Read the session again.' };
    return {
      ...base,
      status: 'applied',
      marked: records.map(({ promptId, startedAt }) => ({ promptId, startedAt })),
      reason: 'The delivered completed turns are marked read.',
    };
  } catch (error) {
    if (error instanceof ReadPublicationError)
      return {
        ...base,
        status: 'unknown',
        reason: 'The read state was saved, but its publication is unknown. Preserve this request ID.',
      };
    return { ...base, status: 'refused', reason: 'Arc could not save the read state. No read change was published.' };
  }
}

export const GUARDED_SEND_REASONS = {
  ownership: 'Arc cannot send because it no longer owns this session’s input. No prompt was sent.',
  changed: 'The session changed outside the work Arc tracked. No prompt was sent.',
  unrelated: 'The requesting session did not start this session in this Arc window. No prompt was sent.',
  requester:
    'Arc cannot tell which session is asking. Run send from one Claude Code or Codex session. No prompt was sent.',
  prompt: 'Supply a nonempty prompt without a prompt-box command. No prompt was sent.',
  stale: 'The observation is stale. Read the session again and prepare a new follow-up. No prompt was sent.',
  unsettled: 'An earlier follow-up to this session is still unsettled. No prompt was sent.',
  blocked:
    'An earlier follow-up to this session has an unknown outcome. Arc sends no more follow-ups until the reader directs this session in the panel. No prompt was sent.',
  busy: 'The session is running or needs input. No prompt was sent.',
  unavailable: 'The session state is unavailable. Show Arc and retry. No prompt was sent.',
  accepted: 'The session received the prompt. This does not confirm that its work succeeded.',
  unknown: 'Delivery is unknown. Arc will not resend this prompt.',
} as const;

// The retained child as the policy reads it. `AgentSession` implements it.
export interface GuardedChild {
  readonly key: string;
  state(): { sessionId: string | null; exited: boolean; lastError: string | null };
  guardedIdle(): string | null;
  // How many turns this child has ended. Source growth with a new turn end is tracked work, not an outside change.
  guardedTurnEnds(): number;
}

// The start association. The host records it during the start operation, before it saves session metadata.
export interface GuardedOwner<C extends GuardedChild = GuardedChild> {
  requester: RequesterIdentity;
  activation: string;
  worker: string;
  child: C;
}

// Start context port. The host carries it through draft delivery for a channel start.
export interface GuardedStartContext {
  requestId: string;
  requester: RequesterIdentity | null;
}

// The facts a session read binds into an observation.
export interface GuardedObservationFacts {
  scope: string | null;
  sourceRevision: string | null;
  latestTurn: string | null;
}

// Read facts port. The host reports these for one target at admission. Facts it cannot establish refuse.
export interface GuardedTargetFacts extends GuardedObservationFacts {
  current: boolean;
  archived: boolean;
  queued: number;
  pendingSubmissions: number;
  pendingControls: number;
  // Known background work. Null means the host cannot tell.
  background: boolean | null;
  writerConflict: boolean;
}

export type GuardedFactsPort = (sessionId: string) => GuardedTargetFacts | null;

export interface GuardedSendRequest {
  requestId: string;
  activation: string;
  sessionId: string;
  prompt: string;
  observation: string;
  requester: RequesterIdentity | null;
}

export interface GuardedSendResult {
  version: 1;
  status: 'accepted' | 'refused' | 'unknown';
  requestId: string;
  payloadSha256: string;
  nativeTurnId: string | null;
  reason: string;
}

// Delivery-mode port. The host supplies the live writer, the activity lease, and the input write.
export interface GuardedDeliveryPort<C extends GuardedChild> {
  // The recorded child while it is still the live writer for its session, otherwise null.
  live(owner: GuardedOwner<C>): C | null;
  // Holds the child's activity lease for the work. Null means the child retired before the lease.
  withLease<T>(child: C, work: () => Promise<T>): Promise<T | null>;
  write(child: C, text: string): GuardedAttempt;
}

interface Observation {
  activation: string;
  worker: string;
  assignment: number;
  steering: number;
  source: string;
  turn: string;
  scope: string;
  // Tracked work on the worker: its child's turn ends plus accepted guarded deliveries.
  tracked: number;
  nonce: string;
}

interface WorkerRecord<C extends GuardedChild> {
  owner: GuardedOwner<C>;
  assignment: number;
  attempt: 'none' | 'unsettled' | 'blocked';
  delivered: number;
  conflict: boolean;
  consumed: Set<string>;
}

const digest = (value: string | null) =>
  value === null ? '' : createHash('sha256').update(value).digest('base64url').slice(0, 22);

export function guardedPromptRefusal(text: string): boolean {
  return !text.trim() || text.trimStart().startsWith('/');
}

function sameRequester(a: RequesterIdentity, b: RequesterIdentity): boolean {
  return a.provider === b.provider && a.id === b.id;
}

// Ownership, assignment revisions, and retained attempts for guarded follow-ups in one activation.
// Every decision here is synchronous, so admission and the input write share one turn of the event loop.
export class GuardedSends<C extends GuardedChild = GuardedChild> {
  private readonly secret = randomBytes(32);
  private readonly workers = new Map<string, WorkerRecord<C>>();
  // A coordinator's steering revision. Reader input to a coordinator invalidates observations for its workers.
  private readonly steering = new Map<string, number>();
  facts: GuardedFactsPort | null = null;

  constructor(
    readonly activation: string,
    private readonly live: (owner: GuardedOwner<C>) => C | null,
  ) {}

  // Labels, parent links, and supplied IDs never create an association. Only a recorded start does.
  recordStart(owner: GuardedOwner<C>): boolean {
    if (owner.activation !== this.activation || !owner.worker || this.workers.has(owner.worker)) return false;
    this.workers.set(owner.worker, {
      owner,
      assignment: 0,
      attempt: 'none',
      delivered: 0,
      conflict: false,
      consumed: new Set(),
    });
    return true;
  }

  owner(sessionId: string): GuardedOwner<C> | null {
    return this.workers.get(sessionId)?.owner ?? null;
  }

  // Reader intervention port for accepted input. The host calls it once it knows it accepted directing input,
  // before any provider operation. It is the only place that clears the block an unknown attempt left.
  intervene(sessionId: string): void {
    this.invalidate(sessionId);
    const worker = this.workers.get(sessionId);
    if (worker?.attempt === 'blocked') worker.attempt = 'none';
  }

  // Directing reader input to a worker advances its assignment, and input to a coordinator advances its steering.
  // Either change makes every earlier observation stale. It can run before the input is known to be accepted.
  invalidate(sessionId: string): void {
    const worker = this.workers.get(sessionId);
    if (worker) worker.assignment += 1;
    for (const one of this.workers.values())
      if (one.owner.requester.id === sessionId) {
        this.steering.set(sessionId, (this.steering.get(sessionId) ?? 0) + 1);
        break;
      }
  }

  // An observed writer-lock failure refuses every later guarded send to that worker in this activation.
  noteWriterConflict(sessionId: string): void {
    const worker = this.workers.get(sessionId);
    if (worker) worker.conflict = true;
  }

  // Signs the read facts for the owning requester. Any other requester receives no observation.
  observe(sessionId: string, requester: RequesterIdentity | null, facts: GuardedObservationFacts): string | null {
    const worker = this.workers.get(sessionId);
    if (!worker || !requester || !sameRequester(worker.owner.requester, requester)) return null;
    const child = this.live(worker.owner);
    const state = child?.state();
    if (child !== worker.owner.child || !state || state.exited || state.sessionId !== sessionId) return null;
    if (facts.scope === null || facts.sourceRevision === null) return null;
    const observation: Observation = {
      activation: this.activation,
      worker: sessionId,
      assignment: worker.assignment,
      steering: this.steering.get(worker.owner.requester.id) ?? 0,
      source: facts.sourceRevision,
      turn: digest(facts.latestTurn),
      scope: digest(facts.scope),
      tracked: this.tracked(worker),
      nonce: randomBytes(12).toString('base64url'),
    };
    const body = Buffer.from(JSON.stringify(observation)).toString('base64url');
    return `${body}.${this.sign(body)}`;
  }

  private tracked(worker: WorkerRecord<C>): number {
    return worker.delivered + worker.owner.child.guardedTurnEnds();
  }

  private sign(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }

  private read(text: string): Observation | null {
    const [body, signature] = text.split('.');
    if (!body || !signature) return null;
    const expected = Buffer.from(this.sign(body));
    const supplied = Buffer.from(signature);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
    try {
      return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Observation;
    } catch {
      return null;
    }
  }

  // Checks that need no live facts. The host runs them before it takes the activity lease.
  precheck(request: GuardedSendRequest): string | null {
    if (guardedPromptRefusal(request.prompt)) return GUARDED_SEND_REASONS.prompt;
    if (!request.requester) return GUARDED_SEND_REASONS.requester;
    const worker = this.workers.get(request.sessionId);
    if (request.activation !== this.activation || !worker || !sameRequester(worker.owner.requester, request.requester))
      return GUARDED_SEND_REASONS.unrelated;
    if (worker.conflict) return GUARDED_SEND_REASONS.ownership;
    const observation = this.read(request.observation);
    if (
      !observation ||
      observation.activation !== this.activation ||
      observation.worker !== request.sessionId ||
      worker.consumed.has(observation.nonce) ||
      observation.assignment !== worker.assignment ||
      observation.steering !== (this.steering.get(worker.owner.requester.id) ?? 0)
    )
      return GUARDED_SEND_REASONS.stale;
    if (worker.attempt === 'unsettled') return GUARDED_SEND_REASONS.unsettled;
    if (worker.attempt === 'blocked') return GUARDED_SEND_REASONS.blocked;
    return null;
  }

  // The final admission check. On success it marks the attempt unsettled, so the caller writes the input
  // before it yields. The observation stays unconsumed until the input write.
  admit(request: GuardedSendRequest, child: C | null, facts: GuardedTargetFacts | null): string | null {
    const early = this.precheck(request);
    if (early) return early;
    const worker = this.workers.get(request.sessionId)!;
    const state = child?.state();
    if (!child || child !== worker.owner.child || !state || state.exited || state.sessionId !== request.sessionId)
      return GUARDED_SEND_REASONS.ownership;
    if (facts?.writerConflict) {
      worker.conflict = true;
      return GUARDED_SEND_REASONS.ownership;
    }
    if (!facts || !facts.current || facts.archived) return GUARDED_SEND_REASONS.unavailable;
    const observation = this.read(request.observation)!;
    // Exact revision equality. Unlike ordinary source admission, any growth since the read refuses.
    if (facts.sourceRevision === null || facts.scope === null) return GUARDED_SEND_REASONS.unavailable;
    if (observation.scope !== digest(facts.scope)) return GUARDED_SEND_REASONS.changed;
    const moved = facts.sourceRevision !== observation.source || observation.turn !== digest(facts.latestTurn);
    // Growth after a turn end or an accepted delivery that Arc tracked makes the observation stale.
    if (moved && observation.tracked !== this.tracked(worker)) return GUARDED_SEND_REASONS.stale;
    const idle = child.guardedIdle();
    const busy =
      idle !== 'unavailable' &&
      (idle === 'busy' ||
        facts.queued > 0 ||
        facts.pendingSubmissions > 0 ||
        facts.pendingControls > 0 ||
        facts.background === true);
    // Any known busy state reports busy ahead of the changed reason.
    if (moved && !busy) return GUARDED_SEND_REASONS.changed;
    if (idle === 'unavailable') return GUARDED_SEND_REASONS.ownership;
    if (busy) return GUARDED_SEND_REASONS.busy;
    if (idle !== null || facts.background !== false) return GUARDED_SEND_REASONS.unavailable;
    worker.attempt = 'unsettled';
    return null;
  }

  // The host consumes the observation when it attempts input. A refusal before the write leaves it usable.
  attempted(request: GuardedSendRequest): void {
    const observation = this.read(request.observation);
    if (observation) this.workers.get(request.sessionId)?.consumed.add(observation.nonce);
  }

  // Host-owned settlement. An unknown outcome blocks guarded sends to the worker until reader input.
  // A shared turn also invalidates the assignment, because the input joined work Arc did not admit.
  settle(sessionId: string, receipt: GuardedReceipt): void {
    const worker = this.workers.get(sessionId);
    if (!worker) return;
    worker.attempt = receipt.outcome === 'unknown' ? 'blocked' : 'none';
    if (receipt.outcome === 'accepted') worker.delivered += 1;
    if (receipt.sharedTurn) worker.assignment += 1;
  }
}

export function payloadSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// Runs one guarded send. It never reopens, resumes, or forks a session, and it never resends.
export async function runGuardedSend<C extends GuardedChild>(
  policy: GuardedSends<C>,
  request: GuardedSendRequest,
  port: GuardedDeliveryPort<C>,
): Promise<GuardedSendResult> {
  const result = (status: GuardedSendResult['status'], reason: string, nativeTurnId: string | null = null) => ({
    version: 1 as const,
    status,
    requestId: request.requestId,
    payloadSha256: payloadSha256(request.prompt),
    nativeTurnId,
    reason,
  });
  const early = policy.precheck(request);
  if (early) return result('refused', early);
  const owner = policy.owner(request.sessionId)!;
  const child = port.live(owner);
  if (!child || child !== owner.child) return result('refused', GUARDED_SEND_REASONS.ownership);
  const held: { attempt: GuardedAttempt | null; refusal: string | null } = { attempt: null, refusal: null };
  try {
    // The lease covers only the final admission and the input write.
    const leased = await port.withLease(child, async () => {
      held.refusal = policy.admit(request, port.live(owner), policy.facts?.(request.sessionId) ?? null);
      if (held.refusal) return true;
      held.attempt = port.write(child, request.prompt);
      void held.attempt.written.then(() => policy.attempted(request));
      await Promise.race([held.attempt.written, held.attempt.receipt]);
      return true;
    });
    if (leased === null && !held.attempt) held.refusal = GUARDED_SEND_REASONS.ownership;
  } catch (error) {
    if (held.attempt) held.attempt.settle({ outcome: 'unknown', nativeTurnId: null, reason: (error as Error).message });
    else held.refusal ??= GUARDED_SEND_REASONS.unavailable;
  }
  if (held.refusal || !held.attempt) return result('refused', held.refusal ?? GUARDED_SEND_REASONS.unavailable);
  const receipt = await held.attempt.receipt;
  policy.settle(request.sessionId, receipt);
  if (receipt.outcome === 'accepted') return result('accepted', GUARDED_SEND_REASONS.accepted, receipt.nativeTurnId);
  const reason = sentence(receipt.reason);
  if (receipt.outcome === 'refused')
    return result('refused', NOT_SENT.test(reason) ? reason : `${reason} No prompt was sent.`.trim());
  return result('unknown', `${reason} ${GUARDED_SEND_REASONS.unknown}`.trim(), receipt.nativeTurnId);
}

const NOT_SENT = /\b(?:prompt was not sent|No prompt was sent)\b/i;

// Receipt reasons can carry provider error text, which starts lowercase and has no final stop.
export function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const capital = trimmed[0].toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

// A guarded result for a request that never reached the policy, such as a send to a window without a handler.
export function guardedRefusal(requestId: string, prompt: string, reason: string): GuardedSendResult {
  return { version: 1, status: 'refused', requestId, payloadSha256: payloadSha256(prompt), nativeTurnId: null, reason };
}

// The attribution fields a channel request carries. The requester names a provider only when the CLI sent one.
export interface AttributedRequest {
  id: string;
  requester: string | null;
  requesterProvider?: RequesterProvider;
  params: SessionWriteParams;
}

export function requesterOf(request: Omit<AttributedRequest, 'id' | 'params'>): RequesterIdentity | null {
  return request.requester && request.requesterProvider
    ? { provider: request.requesterProvider, id: request.requester }
    : null;
}

// Start context port. A start without the requester's provider carries no requester, so it records no ownership.
export function guardedStartContext(request: AttributedRequest): GuardedStartContext {
  return { requestId: request.id, requester: requesterOf(request) };
}

// Records ownership only when the fresh child started for this request is the child that took its first prompt.
export function recordGuardedStart<C extends GuardedChild>(
  policy: GuardedSends<C>,
  start: GuardedStartContext | undefined,
  fresh: C,
  prompted: C | null,
): boolean {
  const worker = fresh.state().sessionId;
  if (!start?.requester || !worker || prompted !== fresh) return false;
  return policy.recordStart({ requester: start.requester, activation: policy.activation, worker, child: fresh });
}

// The panel host ports, bound to the one policy instance of an activation. `extension.ts` assigns them
// to the panel host beside its other callbacks.
export interface GuardedPanelPorts {
  // Read facts port. Signs the facts of a current session read for the requester that started the session.
  guardedObservation(request: AttributedRequest, facts: GuardedObservationFacts): string | null;
  // Read facts port. Installs the target facts the policy reads at admission.
  installGuardedFacts(port: GuardedFactsPort | null): void;
  // Reader intervention port. The panel host calls it when directing input arrives, before it knows whether it
  // accepts the input. It makes earlier observations stale and keeps the unknown-delivery block.
  onReaderInput(sessionId: string): void;
  // Reader intervention port. The panel host calls it once it accepted directing input. It also clears the block.
  onReaderDirected(sessionId: string): void;
}

export function guardedPanelPorts<C extends GuardedChild>(policy: GuardedSends<C>): GuardedPanelPorts {
  return {
    guardedObservation: (request, facts) => policy.observe(request.params.sessionId ?? '', requesterOf(request), facts),
    installGuardedFacts: (port) => {
      policy.facts = port;
    },
    onReaderInput: (sessionId) => policy.invalidate(sessionId),
    onReaderDirected: (sessionId) => policy.intervene(sessionId),
  };
}

// Adds work outside the panel to its target facts. A deferred self-compaction that waits for the session counts as a
// pending control, so a follow-up never runs on the context the session asked to shrink.
export function guardedFactsWithCompaction(
  panelFacts: GuardedFactsPort,
  compactionWaiting: (sessionId: string) => boolean,
): GuardedFactsPort {
  return (sessionId) => {
    const facts = panelFacts(sessionId);
    return facts && compactionWaiting(sessionId) ? { ...facts, pendingControls: facts.pendingControls + 1 } : facts;
  };
}

type ReaderCallback = ((...args: any[]) => unknown) | null;

// The panel host callbacks that carry directing reader input, each with the argument that holds its session.
// A guarded delivery through `onSendPrompt` carries a sixth argument and is not reader input.
export const READER_DIRECTING_CALLBACKS = {
  onSendPrompt: (args: unknown[]) => (args[5] === undefined ? args[1] : null),
  onCompact: (args: unknown[]) => args[1],
  onClear: (args: unknown[]) => args[1],
  onStopTurn: (args: unknown[]) => args[1],
  onAnswerAsk: (args: unknown[]) => args[0],
} as const;

// Wraps each assigned directing callback so earlier observations become stale before the callback runs, even when
// the callback then rejects the input. It never clears the unknown-delivery block. Only `onReaderDirected` does.
export function interveneOnReaderInput(
  panel: { -readonly [K in keyof typeof READER_DIRECTING_CALLBACKS]: ReaderCallback },
  policy: { invalidate(sessionId: string): void },
): void {
  for (const name of Object.keys(READER_DIRECTING_CALLBACKS) as (keyof typeof READER_DIRECTING_CALLBACKS)[]) {
    const callback = panel[name];
    if (!callback) continue;
    const session = READER_DIRECTING_CALLBACKS[name];
    panel[name] = (...args: unknown[]) => {
      const id = session(args);
      if (typeof id === 'string') policy.invalidate(id);
      return callback(...args);
    };
  }
}

// The live child as the delivery port reads it. `AgentSession` implements it.
export interface GuardedWriter extends GuardedChild {
  readonly agent: string;
  guardedPrompt(text: string, clientUuid: string, onSubmitted?: (turnId: number) => void): GuardedAttempt;
}

// Delivery-mode port over the host's retained children. It never opens a child.
export function guardedDeliveryPort<C extends GuardedWriter>(
  policy: GuardedSends<C>,
  host: {
    find(agent: C['agent'], sessionId: string): C | null;
    withActivity<T>(key: string, work: (live: C) => Promise<T>): Promise<T | null>;
  },
  writerFailure: (error: unknown) => boolean,
  clientUuid: () => string,
  // Registers the submission the way ordinary delivery does, so work the guarded turn requests can bind to it.
  submitted?: (child: C, turnId: number) => void,
): GuardedDeliveryPort<C> {
  return {
    live: (owner) => {
      const live = host.find(owner.child.agent, owner.worker);
      if (live === owner.child && writerFailure(live.state().lastError)) policy.noteWriterConflict(owner.worker);
      return live === owner.child ? live : null;
    },
    withLease: (child, work) =>
      host.withActivity(child.key, (live) => (live === child ? work() : Promise.resolve(null))),
    write: (child, text) => {
      const sessionId = child.state().sessionId;
      const owner = sessionId ? policy.owner(sessionId) : null;
      const attempt = child.guardedPrompt(text, clientUuid(), (turnId) => submitted?.(child, turnId));
      // The receipt retains this attempt's diagnostic before reader input clears the child's error.
      // Its child can retire before settlement, so classification never looks up the current live child.
      void attempt.receipt.then((receipt) => {
        if (owner?.child === child && receipt.outcome !== 'accepted' && writerFailure(receipt.reason))
          policy.noteWriterConflict(owner.worker);
      });
      return attempt;
    },
  };
}

// The guarded mode of `onSendPrompt` takes the request without its text, which travels as the prompt.
export type GuardedDelivery = Omit<GuardedSendRequest, 'prompt'>;

export type GuardedPromptSender = (
  agent: string,
  sessionId: string,
  cwd: string | null,
  prompt: { text: string; assets: [] },
  onSubmitted: undefined,
  guarded: GuardedDelivery,
) => Promise<{ guarded?: GuardedSendResult }>;

// The channel's guarded handler. It delivers through the guarded mode of `onSendPrompt`, the one delivery path.
export async function guardedChannelSend<C extends GuardedWriter>(
  policy: GuardedSends<C>,
  request: AttributedRequest,
  send: GuardedPromptSender,
): Promise<GuardedSendResult> {
  const sessionId = request.params.sessionId ?? '';
  const prompt = request.params.prompt ?? '';
  const delivered = await send(
    policy.owner(sessionId)?.child.agent ?? '',
    sessionId,
    null,
    { text: prompt, assets: [] },
    undefined,
    {
      requestId: request.id,
      activation: policy.activation,
      sessionId,
      observation: request.params.observation ?? '',
      requester: requesterOf(request),
    },
  );
  return delivered.guarded ?? guardedRefusal(request.id, prompt, GUARDED_SEND_REASONS.unavailable);
}
