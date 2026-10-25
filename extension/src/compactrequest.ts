import { createHash, randomUUID } from 'node:crypto';
import type { GuardedAttempt, NativeEvent, WireEvent } from './agentwire';

export const COMPACT_LIMITS = { records: 256, retentionMs: 60 * 60_000 } as const;
export interface CompactPayload {
  requestId: string;
  window: string;
  self: true;
  afterTurn: true;
  continuation?: { text: string; sha256: string };
}
export type CompactCommand = Omit<CompactPayload, 'continuation'> & { continuation?: { sha256: string } };
export const CONTINUATION_LIMITS = { bytes: 8192 } as const;
export interface ContinuationObservation {
  state: 'waiting' | 'preparing' | 'attempting' | 'accepted' | 'cancelled' | 'refused' | 'uncertain';
  sequence: number;
  text: string;
  sha256: string;
  reason: string;
  write: 'not-written' | 'unknown' | 'accepted';
  nativeTurnId: string | null;
}
export interface CompactReceipt {
  version: 1;
  owner: string;
  admittedAt: number;
  terminalAt: number | null;
  binding: CompactBinding;
  observation: CompactObservation;
}
export interface CompactPersistence {
  reserve(receipt: CompactReceipt): Promise<void>;
  save(receipt: CompactReceipt): Promise<void>;
  read(id: string): CompactReceipt | null;
  ended(owner: string): boolean;
  release(): void;
}
export function validContinuation(text: unknown, sha256: unknown): text is string {
  return (
    typeof text === 'string' &&
    typeof sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(sha256) &&
    Buffer.byteLength(text) <= CONTINUATION_LIMITS.bytes &&
    text.trim().length > 0 &&
    !text.includes('\0') &&
    !text.startsWith('\uFEFF') &&
    !text.trimStart().startsWith('/') &&
    Buffer.from(text).toString('utf8') === text &&
    createHash('sha256').update(text).digest('hex') === sha256
  );
}
export function validContinuationPath(file: string, platform = process.platform): boolean {
  if (file.length > 1024) return false;
  const prefix = platform === 'win32' ? /^[A-Za-z]:\// : /^\//;
  if (!prefix.test(file)) return false;
  const relative = file.replace(prefix, '');
  return (
    /^[A-Za-z0-9 _.()/-]+$/.test(relative) &&
    relative.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
}
// Why `compact-ready` holds no live call for a payload. Only `not-observed` can still change.
export type CompactRejection = 'not-observed' | 'reader-acted' | 'request-used' | 'capacity' | 'withdrawn';
export const COMPACT_REJECTIONS: Record<CompactRejection, string> = {
  'not-observed':
    'Arc has not seen this command run in the session yet. No compaction was queued. Run arc compact request as its own command, with no chain, pipe or substitution.',
  'reader-acted': 'The reader acted in this session after the command. No compaction was queued.',
  'request-used': 'This request ID was already used in this Arc window. No compaction was queued.',
  capacity: 'Too many compaction requests are active in this Arc window. No compaction was queued.',
  withdrawn: 'The session changed or closed before Arc could accept the request. No compaction was queued.',
};
// Why an admitted request stopped before Arc sent it. Each change that ends a request names itself.
export type CompactLoss = 'reader' | 'scope' | 'authority' | 'replaced' | 'exited';
export const COMPACT_LOSSES: Record<CompactLoss, string> = {
  reader: 'The reader acted in this session before compaction started.',
  scope: "The session left this window's scope before compaction started.",
  authority: "The session's source, folder or setup changed before compaction started.",
  replaced: 'The agent process was replaced before compaction started.',
  exited: 'The agent process exited or moved to another session before compaction started.',
};
// Why `compact-cancel` cancelled nothing. Only `not-observed` can still change.
export type CompactCancelRefusal = 'not-observed' | 'unknown' | 'other-session' | 'delivered';
export const COMPACT_CANCEL_REFUSALS: Record<CompactCancelRefusal, string> = {
  'not-observed':
    'Arc has not seen this command run in a session yet. Nothing was cancelled. Run arc compact cancel as its own command, with no chain, pipe or substitution.',
  unknown: 'This Arc window holds no compaction request with this ID. Nothing was cancelled.',
  'other-session': 'Another session made this compaction request. Nothing was cancelled.',
  delivered: 'Arc already sent this compaction to the agent. Nothing was cancelled.',
};
export const COMPACT_CANCELLED = 'The requesting agent cancelled this request before compaction started.';
// The line Arc appends to reader text it delivers while the session holds a carried request.
export function compactCarryLine(requestId: string): string {
  return `Arc: compaction request ${requestId} runs after this turn. Run arc compact cancel to drop it.`;
}
// How a reader instruction treats an admitted request. A plain message or queued prompt carries it to the turn
// that answers it, and a queue change keeps it. Stop, setting picks, compact, a slash command and answers cancel it.
export function readerCarry(type: string, text?: string): 'send' | 'queue' | null {
  if (type === 'sendPrompt') return text?.trimStart().startsWith('/') ? null : 'send';
  return type === 'dequeue' || type === 'acceptQueuedEdit' ? 'queue' : null;
}
export interface CompactCancelPayload {
  requestId: string;
  window: string;
  self: true;
}
export type CompactReadiness = { ready: true } | { ready: false; code: CompactRejection; reason: string };
export type CompactState = 'queued' | 'started' | 'completed' | 'cancelled' | 'refused' | 'failed' | 'uncertain';
export interface CompactBinding {
  activation: string;
  provider: 'claude' | 'codex';
  sessionId: string;
  childGeneration: number;
  turn: string;
  submissionId: string;
  readerRevision: number;
  assignmentId?: string;
  authority?: string;
  sourceIdentity?: string;
}
export interface CompactObservation {
  requestId: string;
  admission: 'queued';
  state: CompactState;
  sequence: number;
  reason: string;
  provider: 'claude' | 'codex';
  sessionId: string;
  childGeneration: number;
  turn: string;
  toolId: string;
  submissionId: string;
  readerRevision: number;
  originWindow?: string;
  servedByWindow?: string;
  continuation?: ContinuationObservation;
  compactGeneration?: number;
}
interface Assignment {
  payload: CompactPayload;
  binding: Readonly<CompactBinding>;
  toolId: string;
  toolSucceeded: boolean;
  turnSucceeded: boolean;
  finalRetained: boolean;
  submitted: boolean;
  delivering: boolean;
  terminalAt: number | null;
  observation: CompactObservation;
  operation?: NativeCompactOperation;
  admittedAt: number;
  persisted: boolean;
  possibleWrite?: boolean;
  retired?: boolean;
  // Set while a reader message waits for the turn that answers it. Holds the host turns that message started or joined.
  carry?: Set<string>;
}
interface Call {
  turnSucceeded: boolean;
  finalRetained: boolean;
  payload: CompactCommand;
  binding: Readonly<CompactBinding>;
  toolId: string;
}

export function validCompactPayload(input: unknown): input is CompactPayload {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  return (
    Object.keys(value).sort().join(',') ===
      (value.continuation === undefined
        ? 'afterTurn,requestId,self,window'
        : 'afterTurn,continuation,requestId,self,window') &&
    (value.continuation === undefined ||
      (!!value.continuation &&
        typeof value.continuation === 'object' &&
        Object.keys(value.continuation).sort().join(',') === 'sha256,text' &&
        validContinuation(
          (value.continuation as { text: unknown }).text,
          (value.continuation as { sha256: unknown }).sha256,
        ))) &&
    value.self === true &&
    value.afterTurn === true &&
    typeof value.window === 'string' &&
    /^[a-f0-9]{24}$/.test(value.window) &&
    typeof value.requestId === 'string' &&
    new RegExp('^' + value.window + ':[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$').test(value.requestId)
  );
}

export function validCompactCancel(input: unknown): input is CompactCancelPayload {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  return (
    Object.keys(value).sort().join(',') === 'requestId,self,window' &&
    value.self === true &&
    typeof value.window === 'string' &&
    /^[a-f0-9]{24}$/.test(value.window) &&
    typeof value.requestId === 'string' &&
    new RegExp('^' + value.window + ':[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$').test(value.requestId)
  );
}

// Codex on Windows reports a shell command inside its own PowerShell wrapper. The executable is
// quoted with an optional drive path, or bare. The path holds only letters, digits, spaces, backslashes
// and `_.()-`, so it cannot carry a substitution, a quote or a command separator. `-NoProfile` is
// optional. The script sits in single quotes, or in double quotes when it holds a single quote. No other
// flag or argument is admitted.
const POWERSHELL_WRAPPER =
  /^(?:"(?:[A-Za-z]:[A-Za-z0-9 _.()\\-]*\\)?(?:powershell|pwsh)\.exe"|(?:powershell|pwsh)\.exe)(?: -NoProfile)? -Command (?:"([^"\r\n]*)"|'([^'\r\n]*)')$/;

// Codex quotes one /bin/sh script. The inner grammar excludes expansion and escape characters.
const POSIX_WRAPPER = /^\/bin\/sh -c (?:"([^"\r\n]*)"|'([^'\r\n]*)')$/;

// Exact literal commands exclude shell composition and inherited selectors.
export function compactCommandPayload(command: string): CompactCommand | null {
  if (/[\r\n\u2028\u2029]/.test(command)) return null;
  const wrapped = POWERSHELL_WRAPPER.exec(command) ?? POSIX_WRAPPER.exec(command);
  const literal = wrapped ? (wrapped[1] ?? wrapped[2]) : command;
  const match =
    /^arc compact request --self --after-turn(?: --continuation-file '([^'\r\n]+)' --continuation-sha256 ([a-f0-9]{64}))? --request-id ([a-f0-9]{24}:[a-f0-9-]{36}) --window ([a-f0-9]{24}) --json$/.exec(
      literal,
    );
  if (!match) return null;
  const payload = { requestId: match[3], window: match[4], self: true as const, afterTurn: true as const };
  if (!validCompactPayload(payload) || (match[1] && !validContinuationPath(match[1]))) return null;
  return match[1] ? { ...payload, continuation: { sha256: match[2] } } : payload;
}

// The cancel command takes the same wrappers as the request command, and the same exact literal form.
export function compactCancelPayload(command: string): CompactCancelPayload | null {
  if (/[\r\n\u2028\u2029]/.test(command)) return null;
  const wrapped = POWERSHELL_WRAPPER.exec(command) ?? POSIX_WRAPPER.exec(command);
  const literal = wrapped ? (wrapped[1] ?? wrapped[2]) : command;
  const match =
    /^arc compact cancel --self --request-id ([a-f0-9]{24}:[a-f0-9-]{36}) --window ([a-f0-9]{24}) --json$/.exec(
      literal,
    );
  if (!match) return null;
  const payload = { requestId: match[1], window: match[2], self: true as const };
  return validCompactCancel(payload) ? payload : null;
}

function sameBinding(a: CompactBinding, b: CompactBinding): boolean {
  return (
    a.activation === b.activation &&
    a.provider === b.provider &&
    a.sessionId === b.sessionId &&
    a.childGeneration === b.childGeneration &&
    a.turn === b.turn &&
    a.submissionId === b.submissionId &&
    a.readerRevision === b.readerRevision
  );
}

function payloadKey(payload: CompactCommand): string {
  return JSON.stringify([
    payload.requestId,
    payload.window,
    payload.self,
    payload.afterTurn,
    payload.continuation?.sha256,
  ]);
}

function eventMatches(binding: CompactBinding, event: NativeEvent): boolean {
  return (
    event.provider === binding.provider &&
    event.sessionId === binding.sessionId &&
    (event.provider === 'codex' ? event.turnId === binding.turn : String(event.generation) === binding.turn)
  );
}

export interface CompactDelivery {
  // False while the child is busy, asks, or holds reader work. The assignment then keeps waiting.
  eligible(binding: Readonly<CompactBinding>): boolean;
  // The retained adapter invokes beforeWrite synchronously at its provider write boundary.
  submit(binding: Readonly<CompactBinding>, beforeWrite: () => void): Promise<unknown>;
}

// Thrown at the provider write boundary when the session is not ready yet. No provider input is written.
class NotReady extends Error {}

export class CompactRequests {
  private calls = new Map<string, Call>();
  private assignments = new Map<string, Assignment>();
  private seenCalls = new Set<string>();
  // Replay identities remain until this window closes, independently of active capacity.
  private consumed = new Set<string>();
  // The assignment whose provider command is being written. The adapter emits its submission
  // event synchronously after the write callback, and that event names the operation's generation.
  private claiming: Assignment | null = null;
  private disposed = false;
  private readonly rejections = new Map<string, CompactRejection>();
  private readonly admissions = new Map<string, Promise<Readonly<CompactObservation>>>();
  constructor(
    private readonly activation: string,
    private readonly now = Date.now,
    private readonly capacity: number = COMPACT_LIMITS.records,
    private readonly persistence?: CompactPersistence,
  ) {}

  observe(binding: CompactBinding, event: NativeEvent, finalRetained = false): void {
    if (
      binding.activation !== this.activation ||
      event.provider !== binding.provider ||
      event.sessionId !== binding.sessionId
    )
      return;
    if (this.disposed || !eventMatches(binding, event)) return;
    const key = `${binding.provider}:${binding.sessionId}:${binding.childGeneration}:${binding.turn}:${event.kind === 'toolStart' || event.kind === 'toolEnd' ? event.toolId : ''}`;
    if (event.kind === 'toolStart') {
      const payload = compactCommandPayload(event.command);
      if (
        event.initiating &&
        payload?.window === this.activation &&
        !this.seenCalls.has(key) &&
        ![...this.assignments.values()].some((a) => sameBinding(a.binding, binding) && a.toolId === event.toolId)
      ) {
        this.seenCalls.add(key);
        if (this.calls.size < this.capacity)
          this.calls.set(key, {
            payload,
            binding: Object.freeze({ ...binding }),
            toolId: event.toolId,
            turnSucceeded: false,
            finalRetained: false,
          });
        else this.rejectPayload(payload, 'capacity');
      }
    }
    if (event.kind === 'toolEnd') this.calls.delete(key);
    if (event.kind === 'rootEnd') {
      for (const [id, call] of this.calls)
        if (sameBinding(call.binding, binding)) {
          if (!event.success) {
            this.calls.delete(id);
            this.rejectPayload(call.payload, 'withdrawn');
            continue;
          }
          call.turnSucceeded = event.success;
          call.finalRetained = finalRetained;
        }
    }
    for (const assignment of this.assignments.values()) {
      if (
        !sameBinding(assignment.binding, binding) ||
        assignment.submitted ||
        assignment.observation.state !== 'queued'
      )
        continue;
      if (event.kind === 'toolEnd' && event.toolId === assignment.toolId) {
        assignment.toolSucceeded = event.success;
        if (!event.success) this.change(assignment, 'failed', 'The requesting tool did not finish successfully.');
      }
      if (event.kind === 'rootEnd') {
        assignment.turnSucceeded = event.success;
        assignment.finalRetained = finalRetained;
        if (!event.success || !finalRetained)
          this.change(assignment, 'failed', 'The requesting turn or its saved response is unavailable.');
      }
    }
  }

  // Routes native compaction evidence to the one operation whose submission generation it names.
  // It never changes an unsubmitted assignment or another submitted operation.
  observeSubmitted(event: NativeEvent, childGeneration: number): void {
    const owns = (assignment: Assignment) =>
      assignment.submitted &&
      !assignment.retired &&
      assignment.binding.provider === event.provider &&
      assignment.binding.sessionId === event.sessionId &&
      assignment.binding.childGeneration === childGeneration;
    if (event.generation === null) return;
    if (event.kind === 'submission') {
      const claiming = this.claiming;
      if (!claiming || !owns(claiming)) return;
      this.claiming = null;
      if (event.text === '/compact' && claiming.operation) claiming.operation.generation = event.generation;
      if (claiming.observation.continuation) {
        claiming.observation = { ...claiming.observation, compactGeneration: event.generation };
        void this.persist(claiming).catch(() => {});
      }
      return;
    }
    if (event.kind !== 'compact') return;
    for (const assignment of this.assignments.values())
      if (owns(assignment) && assignment.operation?.generation === event.generation) {
        assignment.operation.observe(event);
        return;
      }
  }

  // Lists sessions that hold unsubmitted queued assignments.
  waitingSessions(): string[] {
    return [
      ...new Set(
        [...this.assignments.values()]
          .filter((a) => (!a.submitted && a.observation.state === 'queued') || this.continuationPending(a))
          .map((a) => a.binding.sessionId),
      ),
    ];
  }

  // Lists queued assignments whose requesting tool, exact turn and retained final response all succeeded.
  deliverable(sessionId: string): { id: string; binding: Readonly<CompactBinding> }[] {
    this.prune();
    return [...this.assignments]
      .filter(
        ([, a]) =>
          a.binding.sessionId === sessionId &&
          !a.submitted &&
          a.persisted &&
          !a.delivering &&
          a.observation.state === 'queued' &&
          a.toolSucceeded &&
          a.turnSucceeded &&
          a.finalRetained,
      )
      .map(([id, a]) => ({ id, binding: a.binding }));
  }

  // Whether an unsubmitted operation still waits for its final response.
  awaitsReply(predicate: (binding: Readonly<CompactBinding>) => boolean): boolean {
    return (
      [...this.calls.values()].some((call) => !call.finalRetained && predicate(call.binding)) ||
      [...this.assignments.values()].some(
        (a) => !a.submitted && a.observation.state === 'queued' && !a.finalRetained && predicate(a.binding),
      )
    );
  }

  readiness(payload: CompactPayload): CompactReadiness {
    const refuse = (code: CompactRejection): CompactReadiness => ({
      ready: false,
      code,
      reason: COMPACT_REJECTIONS[code],
    });
    if (this.disposed) return refuse('not-observed');
    const live = [...this.calls.values()].find((call) => payloadKey(call.payload) === payloadKey(payload));
    if (this.consumed.has(payload.requestId)) return refuse('request-used');
    if (live) return { ready: true };
    return refuse(this.rejections.get(payloadKey(payload)) ?? 'not-observed');
  }

  ready(payload: CompactPayload): boolean {
    return this.readiness(payload).ready;
  }

  // Keeps why an exact request command gained no live call, so readiness reports the reason.
  reject(command: string, code: CompactRejection): void {
    const payload = compactCommandPayload(command);
    if (payload && payload.window === this.activation) this.rejectPayload(payload, code);
  }

  private rejectPayload(payload: CompactCommand, code: CompactRejection): void {
    this.rejections.delete(payloadKey(payload));
    this.rejections.set(payloadKey(payload), code);
    if (this.rejections.size > this.capacity) this.rejections.delete(this.rejections.keys().next().value!);
  }

  admit(
    payload: CompactPayload,
    eligible: (binding: Readonly<CompactBinding>) => boolean,
  ): Readonly<CompactObservation> {
    this.prune();
    const live = [...this.calls].find(([, call]) => payloadKey(call.payload) === payloadKey(payload));
    const existing = this.assignments.get(payload.requestId);
    this.reclaim();
    if (existing && payloadKey(existing.payload) !== payloadKey(payload))
      throw new Error('This compaction request ID has different arguments.');
    if (this.consumed.has(payload.requestId)) {
      // A copied payload in another live tool call consumes that call and gets no assignment.
      if (live) {
        this.calls.delete(live[0]);
        throw new Error('This compaction request ID was already used in this Arc window.');
      }
      if (existing) return { ...existing.observation };
      throw new Error('This compaction request ID was already used in this Arc window.');
    }
    if (
      this.disposed ||
      !validCompactPayload(payload) ||
      payload.window !== this.activation ||
      this.assignments.size >= this.capacity
    )
      throw new Error('This compaction request is unavailable in this Arc window.');
    if (!live) {
      const readiness = this.readiness(payload);
      throw new Error(readiness.ready ? COMPACT_REJECTIONS['not-observed'] : readiness.reason);
    }
    const [key, call] = live;
    if (!eligible(call.binding))
      throw new Error('The session has an open question or queued reader input. No compaction was queued.');
    if (payload.continuation && (!this.persistence || !call.binding.authority || !call.binding.assignmentId))
      throw new Error('This continuation cannot be saved for the session.');
    if (
      [...this.assignments.values()].some(
        (a) =>
          a.binding.sessionId === call.binding.sessionId &&
          a.binding.childGeneration === call.binding.childGeneration &&
          a.binding.turn === call.binding.turn &&
          (call.binding.provider === 'codex' || a.binding.submissionId === call.binding.submissionId) &&
          ['queued', 'started', 'uncertain'].includes(a.observation.state),
      )
    )
      throw new Error('This turn already has a pending compaction request.');
    this.calls.delete(key);
    this.consumed.add(payload.requestId);
    const acknowledgement = Object.freeze({
      requestId: payload.requestId,
      admission: 'queued' as const,
      state: 'queued' as const,
      sequence: 1,
      reason: '',
      provider: call.binding.provider,
      sessionId: call.binding.sessionId,
      childGeneration: call.binding.childGeneration,
      turn: call.binding.turn,
      toolId: call.toolId,
      submissionId: call.binding.submissionId,
      readerRevision: call.binding.readerRevision,
      ...(payload.continuation
        ? {
            originWindow: this.activation,
            continuation: {
              ...payload.continuation,
              state: 'waiting' as const,
              sequence: 1,
              reason: '',
              write: 'not-written' as const,
              nativeTurnId: null,
            },
          }
        : {}),
    });
    this.assignments.set(payload.requestId, {
      payload: { ...payload },
      binding: call.binding,
      toolId: call.toolId,
      toolSucceeded: false,
      turnSucceeded: call.turnSucceeded,
      finalRetained: call.finalRetained,
      submitted: false,
      delivering: false,
      terminalAt: null,
      observation: { ...acknowledgement },
      admittedAt: this.now(),
      persisted: !payload.continuation,
    });
    return { ...acknowledgement };
  }

  admitSaved(
    payload: CompactPayload,
    eligible: (binding: Readonly<CompactBinding>) => boolean,
  ): Promise<Readonly<CompactObservation>> {
    const pending = this.admissions.get(payload.requestId);
    if (pending) {
      const assignment = this.assignments.get(payload.requestId);
      return assignment && payloadKey(assignment.payload) === payloadKey(payload)
        ? pending
        : Promise.reject(new Error('This compaction request ID has different arguments.'));
    }
    let observation: Readonly<CompactObservation>;
    try {
      observation = this.admit(payload, eligible);
    } catch (error) {
      return Promise.reject(error);
    }
    const assignment = this.assignments.get(payload.requestId)!;
    if (assignment.persisted || assignment.observation.continuation?.state !== 'waiting')
      return Promise.resolve(observation);
    const result = (async () => {
      try {
        await this.persistence!.reserve(this.receipt(assignment));
        if (!this.readyAssignment(assignment) || !eligible(assignment.binding)) {
          this.cancelContinuation(assignment, 'The requesting session changed before admission settled.');
          this.change(assignment, 'cancelled', 'The requesting session changed before admission settled.');
        } else assignment.persisted = true;
        await this.persist(assignment);
        return this.status(payload.requestId)!;
      } catch {
        this.cancelContinuation(assignment, 'The continuation could not be saved.');
        this.change(assignment, 'refused', 'The continuation could not be saved.');
        return this.status(payload.requestId)!;
      }
    })();
    this.admissions.set(payload.requestId, result);
    void result.then(
      () => this.admissions.delete(payload.requestId),
      () => this.admissions.delete(payload.requestId),
    );
    return result;
  }

  private readyAssignment(assignment: Assignment): boolean {
    return !this.disposed && assignment.observation.state === 'queued';
  }

  private continuationPending(assignment: Assignment): boolean {
    return (
      !!assignment.observation.continuation &&
      ['waiting', 'preparing', 'attempting'].includes(assignment.observation.continuation.state)
    );
  }

  continuationDeliverable(sessionId: string): { id: string; binding: Readonly<CompactBinding> }[] {
    this.prune();
    return [...this.assignments]
      .filter(
        ([, a]) =>
          a.binding.sessionId === sessionId &&
          a.persisted &&
          a.submitted &&
          !a.delivering &&
          a.observation.state === 'completed' &&
          a.observation.continuation?.state === 'waiting',
      )
      .map(([id, a]) => ({ id, binding: a.binding }));
  }

  async continue(
    id: string,
    delivery: {
      eligible(binding: Readonly<CompactBinding>, writing: boolean): boolean;
      submit(text: string, beforeWrite: () => void): GuardedAttempt;
    },
  ): Promise<void> {
    const assignment = this.assignments.get(id);
    if (
      !assignment ||
      assignment.delivering ||
      assignment.observation.state !== 'completed' ||
      assignment.observation.continuation?.state !== 'waiting' ||
      !assignment.persisted
    )
      return;
    const check = (writing: boolean) =>
      !this.disposed &&
      assignment.observation.state === 'completed' &&
      this.continuationPending(assignment) &&
      delivery.eligible(assignment.binding, writing);
    if (!check(false)) return;
    assignment.delivering = true;
    let entered = false;
    let cancelled = false;
    try {
      this.continuationChange(assignment, 'preparing');
      await this.persist(assignment);
      if (!check(false)) {
        this.cancelContinuation(assignment, 'The session changed before continuation.');
        return;
      }
      this.continuationChange(assignment, 'attempting', '', 'unknown');
      await this.persist(assignment);
      if (!check(false)) {
        this.cancelContinuation(assignment, 'The session changed before continuation.');
        return;
      }
      const attempt = delivery.submit(assignment.observation.continuation.text, () => {
        if (!check(true)) {
          cancelled = true;
          throw new NotReady('The session changed before continuation.');
        }
        // Passing the callback enters the protocol-write boundary. A throwing write is still uncertain.
        entered = true;
        assignment.possibleWrite = true;
      });
      const receipt = await attempt.receipt;
      if (assignment.retired) this.cancelContinuation(assignment, 'The agent process ended during continuation.');
      else if (cancelled || !entered)
        this.cancelContinuation(assignment, receipt.reason || 'The continuation was not written.');
      else
        this.continuationChange(
          assignment,
          receipt.outcome === 'accepted' && !receipt.sharedTurn ? 'accepted' : 'uncertain',
          receipt.reason,
          receipt.outcome === 'accepted' && !receipt.sharedTurn ? 'accepted' : 'unknown',
          receipt.nativeTurnId,
        );
    } catch (error) {
      this.continuationChange(
        assignment,
        entered ? 'uncertain' : 'cancelled',
        error instanceof Error ? error.message : 'Continuation is unavailable.',
        entered ? 'unknown' : 'not-written',
      );
    } finally {
      // Failure after a possible write leaves durable attempting and never permits a second input.
      try {
        await this.persist(assignment);
      } catch {
        if (entered)
          this.continuationChange(assignment, 'uncertain', 'Continuation delivery could not be saved.', 'unknown');
      }
      assignment.delivering = false;
    }
  }

  private receipt(assignment: Assignment): CompactReceipt {
    return structuredClone({
      version: 1,
      owner: this.activation,
      admittedAt: assignment.admittedAt,
      terminalAt: assignment.terminalAt,
      binding: assignment.binding,
      observation: assignment.observation,
    });
  }
  private persist(assignment: Assignment): Promise<void> {
    return this.persistence!.save(this.receipt(assignment));
  }
  private continuationChange(
    assignment: Assignment,
    state: ContinuationObservation['state'],
    reason = '',
    write?: ContinuationObservation['write'],
    nativeTurnId: string | null = null,
  ): void {
    const held = assignment.observation.continuation;
    if (!held) return;
    assignment.observation = {
      ...assignment.observation,
      continuation: { ...held, state, sequence: held.sequence + 1, reason, write: write ?? held.write, nativeTurnId },
    };
    if (!this.continuationPending(assignment)) assignment.terminalAt = this.now();
  }
  private cancelContinuation(assignment: Assignment, reason: string): void {
    if (!this.continuationPending(assignment)) return;
    this.continuationChange(
      assignment,
      assignment.possibleWrite ? 'uncertain' : 'cancelled',
      reason,
      assignment.possibleWrite ? 'unknown' : 'not-written',
    );
  }

  status(id: string): CompactObservation | null {
    const assignment = this.assignments.get(id);
    if (
      !assignment ||
      (assignment.terminalAt !== null && this.now() - assignment.terminalAt >= COMPACT_LIMITS.retentionMs)
    )
      return null;
    return structuredClone(assignment.observation);
  }

  // Cancels unsubmitted assignments that match. Live calls that match also lose their authority unless keepCalls is set.
  invalidate(
    predicate: (binding: Readonly<CompactBinding>) => boolean,
    reason: string,
    keepCalls = false,
    code?: CompactRejection,
    retire = false,
    keep: ReadonlySet<string> = new Set(),
  ): void {
    if (!keepCalls)
      for (const [key, call] of this.calls)
        if (predicate(call.binding)) {
          this.calls.delete(key);
          this.rejectPayload(call.payload, code ?? 'withdrawn');
        }
    for (const [id, assignment] of this.assignments) {
      if (keep.has(id) || !predicate(assignment.binding)) continue;
      const previous = assignment.observation;
      if (retire && assignment.submitted) assignment.retired = true;
      if (retire && assignment.submitted && ['started', 'uncertain'].includes(assignment.observation.state)) {
        this.cancelContinuation(assignment, reason);
        this.change(assignment, 'uncertain', 'The agent process ended. The compaction outcome is unknown.');
        assignment.terminalAt = this.now();
        if (assignment.persisted && assignment.observation.continuation) void this.persist(assignment).catch(() => {});
        continue;
      }
      this.cancelContinuation(assignment, reason);
      if (!assignment.submitted && assignment.observation.state === 'queued')
        this.change(assignment, 'cancelled', reason);
      else if (assignment.persisted && assignment.observation !== previous)
        void this.persist(assignment).catch(() => {});
    }
  }

  // Lists the unsubmitted queued assignments of a session. A reader message carries each one.
  carriable(sessionId: string): { id: string; binding: Readonly<CompactBinding>; carry: Set<string> | null }[] {
    return [...this.assignments]
      .filter(([, a]) => a.binding.sessionId === sessionId && !a.submitted && a.observation.state === 'queued')
      .map(([id, a]) => ({ id, binding: a.binding, carry: a.carry ?? null }));
  }

  // Holds an assignment until Arc observes the turn that answers the reader message.
  hold(id: string): void {
    const assignment = this.assignments.get(id);
    if (assignment) assignment.carry ??= new Set();
  }

  // Records a host turn that a held reader message started or joined.
  noteTurn(sessionId: string, turn: string): void {
    for (const assignment of this.assignments.values())
      if (assignment.binding.sessionId === sessionId && assignment.carry) assignment.carry.add(turn);
  }

  // Moves an unsubmitted assignment to a new binding and ends its hold. A new turn must succeed and save its own response.
  rebind(id: string, binding: Readonly<CompactBinding>): void {
    const assignment = this.assignments.get(id);
    if (!assignment || assignment.submitted || assignment.observation.state !== 'queued') return;
    if (assignment.binding.turn !== binding.turn || assignment.binding.submissionId !== binding.submissionId) {
      assignment.turnSucceeded = false;
      assignment.finalRetained = false;
    }
    assignment.binding = Object.freeze({ ...binding });
    assignment.carry = undefined;
    assignment.observation = {
      ...assignment.observation,
      turn: binding.turn,
      submissionId: binding.submissionId,
      readerRevision: binding.readerRevision,
    };
    if (assignment.persisted && assignment.observation.continuation) void this.persist(assignment).catch(() => {});
  }

  // Names the newest held request of a session, for the line Arc appends to the reader text it delivers.
  carried(sessionId: string): string | null {
    let held: Assignment | null = null;
    for (const assignment of this.assignments.values())
      if (
        assignment.binding.sessionId === sessionId &&
        assignment.carry &&
        !assignment.submitted &&
        assignment.observation.state === 'queued' &&
        (!held || assignment.admittedAt >= held.admittedAt)
      )
        held = assignment;
    return held?.payload.requestId ?? null;
  }

  // Cancels an unsubmitted request for the session that made it. Callers are the sessions whose live
  // tool calls run the exact cancel command for this request ID.
  cancel(
    requestId: string,
    callers: readonly { provider: 'claude' | 'codex'; sessionId: string }[],
  ): CompactObservation | { requestId: string; state: 'refused'; code: CompactCancelRefusal; reason: string } {
    const refuse = (code: CompactCancelRefusal) => ({
      requestId,
      state: 'refused' as const,
      code,
      reason: COMPACT_CANCEL_REFUSALS[code],
    });
    if (!callers.length) return refuse('not-observed');
    this.prune();
    const assignment = this.assignments.get(requestId);
    if (!assignment) return refuse('unknown');
    if (
      !callers.some(
        (caller) =>
          caller.provider === assignment.binding.provider && caller.sessionId === assignment.binding.sessionId,
      )
    )
      return refuse('other-session');
    if (assignment.submitted) return refuse('delivered');
    // A delivery that waits on the activity lease rechecks the state at its write boundary and writes nothing.
    if (assignment.observation.state === 'queued') this.change(assignment, 'cancelled', COMPACT_CANCELLED);
    return structuredClone(assignment.observation);
  }

  dispose(): void {
    this.invalidate(() => true, 'The Arc window closed before compaction started.', false, undefined, true);
    this.disposed = true;
    this.calls.clear();
  }

  async deliver(id: string, delivery: CompactDelivery): Promise<void> {
    this.prune();
    const assignment = this.assignments.get(id);
    if (
      !assignment ||
      assignment.submitted ||
      assignment.delivering ||
      assignment.observation.state !== 'queued' ||
      !assignment.toolSucceeded ||
      !assignment.turnSucceeded ||
      !assignment.finalRetained
    )
      return;
    // Reader actions, child changes and scope changes cancel through invalidate. A failed check here
    // only means the session is not ready yet.
    const check = () =>
      !this.disposed &&
      !assignment.submitted &&
      assignment.observation.state === 'queued' &&
      delivery.eligible(assignment.binding);
    if (!check()) {
      this.prune();
      return;
    }
    assignment.delivering = true;
    try {
      await delivery.submit(assignment.binding, () => {
        if (!check()) throw new NotReady('The session was not ready for compaction.');
        assignment.submitted = true;
        assignment.operation = new NativeCompactOperation(assignment.binding, (state, reason) =>
          this.nativeOutcome(id, bindingCopy(assignment.binding), state, reason),
        );
        this.claiming = assignment;
        this.change(assignment, 'uncertain', 'Compaction was submitted. Its native outcome is pending.');
      });
    } catch (error) {
      this.prune();
      const state = assignment.observation.state as CompactState;
      if (!assignment.submitted && state === 'queued') {
        if (!(error instanceof NotReady))
          this.change(assignment, 'refused', error instanceof Error ? error.message : 'Compaction was refused.');
      } else if (assignment.submitted && !assignment.retired && state === 'uncertain')
        this.change(
          assignment,
          'uncertain',
          'The compaction outcome is unavailable. Observe this request without retrying.',
        );
    } finally {
      assignment.delivering = false;
      if (this.claiming === assignment) this.claiming = null;
    }
  }

  nativeOutcome(
    id: string,
    binding: CompactBinding,
    state: 'started' | 'completed' | 'failed' | 'uncertain',
    reason = '',
  ): void {
    const assignment = this.assignments.get(id);
    if (!assignment?.submitted || assignment.retired || !sameBinding(assignment.binding, binding)) return;
    const previous = assignment.observation.state;
    if (previous === state) return;
    if (previous === 'completed' || previous === 'failed') {
      if (state !== 'started') {
        this.cancelContinuation(assignment, 'Native compaction outcomes conflict.');
        this.change(assignment, 'uncertain', 'Native compaction outcomes conflict.');
      }
      return;
    }
    if (state === 'failed' || state === 'uncertain')
      this.cancelContinuation(assignment, 'Native compaction did not complete conclusively.');
    this.change(assignment, state, reason);
  }

  private change(assignment: Assignment, state: CompactState, reason: string): void {
    assignment.observation = {
      ...assignment.observation,
      state,
      reason,
      sequence: assignment.observation.sequence + 1,
    };
    assignment.terminalAt = ['completed', 'cancelled', 'refused', 'failed'].includes(state) ? this.now() : null;
    if (state !== 'completed' && ['cancelled', 'refused', 'failed'].includes(state))
      this.cancelContinuation(assignment, reason);
    if (this.continuationPending(assignment)) assignment.terminalAt = null;
    if (assignment.persisted && assignment.observation.continuation) void this.persist(assignment).catch(() => {});
  }
  private prune(): void {
    for (const [id, assignment] of this.assignments)
      if (
        assignment.terminalAt !== null &&
        (!assignment.delivering || assignment.retired) &&
        this.now() - assignment.terminalAt >= COMPACT_LIMITS.retentionMs
      )
        this.assignments.delete(id);
  }

  private reclaim(): void {
    const terminal = [...this.assignments]
      .filter(
        ([, a]) =>
          a.terminalAt !== null &&
          (!a.delivering || a.retired) &&
          (!a.possibleWrite || a.observation.continuation?.state === 'accepted'),
      )
      .sort((a, b) => a[1].terminalAt! - b[1].terminalAt!);
    for (const [id] of terminal) {
      if (this.assignments.size < this.capacity) break;
      this.assignments.delete(id);
    }
  }
}

function bindingCopy(binding: Readonly<CompactBinding>): CompactBinding {
  return { ...binding };
}

// One submitted command owns this evidence join. It never sends provider input.
// CompactRequests sets the submission generation and routes only evidence that names it.
class NativeCompactOperation {
  generation: number | null = null;
  private turn: string | null = null;
  private item: string | null = null;
  private itemCompleted = false;
  private terminal: NativeEvent | null = null;
  private compactSuccess = false;
  private manualBoundary = false;
  private conflictingRefusal = false;
  constructor(
    private readonly binding: Readonly<CompactBinding>,
    private readonly report: (state: 'started' | 'completed' | 'failed' | 'uncertain', reason?: string) => void,
  ) {}
  observe(event: NativeEvent): void {
    if (
      event.provider !== this.binding.provider ||
      event.sessionId !== this.binding.sessionId ||
      event.kind !== 'compact' ||
      this.generation === null ||
      event.generation !== this.generation
    )
      return;
    if (event.provider === 'claude') {
      if (event.stage === 'status') {
        if (event.evidence.status === 'compacting') this.report('started');
        if (event.evidence.compact_result === 'success') this.compactSuccess = true;
        else if (typeof event.evidence.compact_result === 'string')
          this.report('failed', 'The agent did not compact the session.');
      }
      if (
        event.stage === 'boundary' &&
        (event.evidence.compact_metadata as { trigger?: string } | undefined)?.trigger === 'manual'
      )
        this.manualBoundary = true;
      if (event.stage === 'turnEnd') this.terminal = event;
      if (this.terminal) {
        if (this.terminal.evidence.subtype !== 'success' || this.terminal.evidence.is_error !== false)
          this.report('failed', 'The agent did not compact the session.');
        else if (this.compactSuccess && this.manualBoundary) this.report('completed');
      }
      return;
    }
    if (event.stage === 'refused') {
      if (this.turn !== null) {
        this.conflictingRefusal = true;
        this.report('uncertain', 'The agent reported both a compaction turn and a refusal.');
      } else this.report('failed', 'The agent refused the compaction request.');
      return;
    }
    if (this.conflictingRefusal) return;
    if (event.stage === 'accepted') {
      this.report('started');
      return;
    }
    if (event.stage === 'turnStart' && event.turnId && event.turnId !== this.binding.turn && this.turn === null) {
      this.turn = event.turnId;
      this.report('started');
    }
    if (!this.turn || event.turnId !== this.turn) return;
    const item = event.evidence.item as { id?: string } | undefined;
    if (event.stage === 'itemStart' && item?.id && this.item === null) this.item = item.id;
    if (event.stage === 'itemEnd' && item?.id === this.item && this.item !== null) this.itemCompleted = true;
    if (event.stage === 'turnEnd') this.terminal = event;
    if (this.terminal) {
      const turn = this.terminal.evidence.turn as { status?: string } | undefined;
      if (turn?.status !== 'completed') this.report('failed', 'The native compaction failed or was interrupted.');
      else if (this.itemCompleted) this.report('completed');
    }
  }
}

export interface CompactChild {
  readonly key: string;
  readonly agent: string;
  state(): {
    sessionId: string | null;
    busy: boolean;
    asks: readonly unknown[];
    ready: boolean;
    exited: boolean;
  };
  // True while an earlier compaction request of this child can still start or finish a turn.
  compactionUnresolved(): boolean;
  // True for a turn Claude started by itself, such as one a background task notice woke.
  startedByAgent?(turnId: number): boolean;
  // The live shared Claude owner of this submission, including a joined prompt awaiting preparation settlement.
  readerTurnOwner?(submittedTurnId: number): number | undefined;
  compact(beforeWrite: () => void): Promise<unknown>;
  guardedIdle?(): string | null;
  guardedPrompt?(
    text: string,
    uuid: string,
    onSubmitted: (turn: number) => void,
    beforeWrite: () => void,
  ): GuardedAttempt;
}

export interface CompactHostPort<C extends CompactChild> {
  find(provider: 'claude' | 'codex', sessionId: string): C | null;
  // Runs work under an activity lease on this exact child. It resolves null without opening a missing child.
  withActivity(child: C, work: (live: C) => Promise<void>): Promise<unknown>;
  // Names queued reader prompts or a clear in progress as pending, and a session outside the panel's scope as absent.
  // Unavailable membership blocks delivery without cancelling the assignment.
  readerWork(sessionId: string): 'none' | 'pending' | 'absent' | 'unknown';
  // Stable physical source, current scope, cwd and effective setup. Null means authority is unknown.
  authority?(provider: 'claude' | 'codex', sessionId: string): string | null;
  source?(provider: 'claude' | 'codex', sessionId: string): string | null;
  continuationWork?(sessionId: string): 'none' | 'pending' | 'absent' | 'unknown';
}

interface Submission {
  sessionId: string | null;
}

const SUBMISSIONS_PER_CHILD = 32;

// Joins host observations to deferred assignments for one window activation.
// The reader revision advances synchronously at each reader action. A reader message carries unsubmitted work
// to the turn that answers it, and every other reader action cancels it.
export class CompactHost<C extends CompactChild> {
  readonly requests: CompactRequests;
  private readonly revisions = new Map<string, number>();
  private readonly generations = new WeakMap<C, number>();
  private readonly children = new Map<string, C>();
  private readonly submissions = new WeakMap<C, Map<number, Submission>>();
  private readonly bindings = new WeakMap<C, Map<string, CompactBinding>>();
  private readonly replies = new WeakMap<C, Set<number>>();
  private readonly endings = new WeakMap<C, Map<number, { binding: CompactBinding; event: NativeEvent }>>();
  private readonly observations = new WeakMap<
    NativeEvent,
    Pick<CompactBinding, 'childGeneration' | 'readerRevision' | 'authority' | 'sourceIdentity'>
  >();
  private generation = 0;
  // Live cancel command calls, keyed by child, session and tool call, with the child that runs each one.
  private readonly cancels = new Map<
    string,
    { requestId: string; provider: 'claude' | 'codex'; sessionId: string; child: C }
  >();
  // True from a scope change until the panel's session rows reflect the new scope.
  private settling = false;
  private disposed = false;

  constructor(
    private readonly activation: string,
    private readonly port: CompactHostPort<C>,
    now: () => number = Date.now,
    private readonly persistence?: CompactPersistence,
  ) {
    this.requests = new CompactRequests(activation, now, COMPACT_LIMITS.records, persistence);
  }

  // An answer can approve the requesting command inside its own turn, so it keeps the reader
  // revision and live calls. It still cancels admitted work that has not been submitted.
  // A reader message holds admitted work until its answering turn rebinds it. A queue change keeps
  // the work on its turn under the new revision. Live request calls lose their authority either way.
  readerAction(sessionId: string, answer = false, carry: 'send' | 'queue' | null = null): void {
    if (!answer) this.revisions.set(sessionId, this.revision(sessionId) + 1);
    const kept = new Set<string>();
    if (carry && !answer)
      for (const held of this.requests.carriable(sessionId)) {
        kept.add(held.id);
        if (carry === 'send') this.requests.hold(held.id);
        else if (!held.carry) this.rebind(held.id, held.binding, { readerRevision: this.revision(sessionId) });
      }
    this.requests.invalidate(
      (binding) => binding.sessionId === sessionId,
      COMPACT_LOSSES.reader,
      answer,
      'reader-acted',
      false,
      kept,
    );
  }

  // A reader message that never reached the agent leaves held work on its own turn under the new revision.
  unsent(child: C): void {
    const sessionId = child.state().sessionId;
    if (!sessionId || this.disposed) return;
    for (const held of this.requests.carriable(sessionId))
      if (held.carry) this.rebind(held.id, held.binding, { readerRevision: this.revision(sessionId) });
  }

  // Names the request Arc reports in reader text delivered to the session, while one is held.
  carriedLine(sessionId: string): string | null {
    const id = this.disposed ? null : this.requests.carried(sessionId);
    return id ? compactCarryLine(id) : null;
  }

  archived(sessionIds: ReadonlySet<string>): void {
    this.requests.invalidate(
      (binding) => sessionIds.has(binding.sessionId),
      'The session was archived before continuation.',
    );
  }

  // Known directories outside a ready scope cancel assignments before any rows refresh.
  // Delivery still waits until the session rows reflect the scope.
  scopeChanged(outOfScope: ReadonlySet<string> = new Set()): void {
    this.settling = true;
    this.requests.invalidate((binding) => outOfScope.has(binding.sessionId), COMPACT_LOSSES.scope);
  }

  // Runs after each full rows refresh. A session that left the panel's scope cancels its unsubmitted
  // work, also when the scope later returns it. Work that waited on the scope change drains.
  sessionsRefreshed(): void {
    if (this.disposed) return;
    this.settling = false;
    this.requests.invalidate((binding) => this.port.readerWork(binding.sessionId) === 'absent', COMPACT_LOSSES.scope);
    for (const sessionId of this.requests.waitingSessions()) void this.drain(sessionId);
  }

  // Retains the session identity of an Arc submission without requiring one for native turns.
  submitted(
    child: C,
    turnId: number,
    origin: 'reader' | 'followup' | 'continuation' = 'reader',
    _operationId?: string,
  ): void {
    if (this.disposed) return;
    const book = this.submissions.get(child) ?? new Map<number, Submission>();
    this.submissions.set(child, book);
    book.set(turnId, { sessionId: child.state().sessionId });
    if (book.size > SUBMISSIONS_PER_CHILD) book.delete(book.keys().next().value!);
    this.generationOf(child);
    const sessionId = child.state().sessionId;
    if (origin === 'reader' && sessionId) this.requests.noteTurn(sessionId, String(turnId));
  }

  // Joined reader input uses the same live response owner.
  read(child: C, turnId: number): void {
    const submission = this.submissions.get(child)?.get(turnId);
    const owner = child.readerTurnOwner?.(turnId);
    if (submission && owner !== undefined) this.submissions.get(child)!.set(owner, submission);
    const sessionId = child.state().sessionId;
    if (owner !== undefined && sessionId && !this.disposed) this.requests.noteTurn(sessionId, String(owner));
  }

  // Freezes command context at arrival, before an early native turn has a response owner.
  observeNative(child: C, event: NativeEvent): void {
    if (this.disposed || event.kind !== 'toolStart' || !event.initiating || !compactCommandPayload(event.command))
      return;
    this.observations.set(event, {
      childGeneration: this.generationOf(child),
      readerRevision: this.revision(event.sessionId),
      authority: this.port.authority?.(event.provider, event.sessionId) ?? undefined,
      sourceIdentity: (this.port.source ?? this.port.authority)?.(event.provider, event.sessionId) ?? undefined,
    });
  }

  native(child: C, event: NativeEvent, turnId: number | undefined): void {
    if (this.disposed) return;
    if (event.kind === 'submission' || event.kind === 'compact') {
      const generation = this.generations.get(child);
      if (generation !== undefined) this.requests.observeSubmitted(event, generation);
      // A terminal turn or an unbound RPC refusal releases the adapter's unanswered receipt.
      if (event.kind === 'compact' && (event.stage === 'turnEnd' || event.stage === 'refused'))
        queueMicrotask(() => void this.drain(event.sessionId));
      return;
    }
    if (event.kind === 'wake' || event.kind === 'launch' || event.kind === 'background') return;
    if (event.kind === 'toolStart' || event.kind === 'toolEnd') this.observeCancel(child, event);
    if (turnId !== undefined) this.carryTo(child, event, turnId);
    const binding = this.binding(child, event, turnId);
    if (event.kind === 'toolStart' && (!binding || !event.initiating)) this.requests.reject(event.command, 'withdrawn');
    if (!binding || turnId === undefined) return;
    const replies = this.replies.get(child) ?? new Set<number>();
    this.replies.set(child, replies);
    if (event.kind === 'rootEnd') {
      // A root success waits until the panel saves the final response for the reader.
      if (replies.has(turnId)) this.requests.observe(binding, event, true);
      else if (!child.startedByAgent?.(turnId) || this.awaitsRecordedReply(child, turnId)) {
        const endings = this.endings.get(child) ?? new Map<number, { binding: CompactBinding; event: NativeEvent }>();
        this.endings.set(child, endings);
        endings.set(turnId, { binding, event });
      }
      return;
    }
    // Only a response saved after the last tool settled counts as the final response.
    replies.delete(turnId);
    this.requests.observe(binding, event);
  }

  // Rebinds held work to the first event of the turn that answers its reader message. That turn is a host
  // turn the message started or joined, or the held turn under a newer Claude prompt generation.
  private carryTo(child: C, event: NativeEvent, turnId: number): void {
    if (event.kind !== 'toolStart' && event.kind !== 'toolEnd' && event.kind !== 'rootEnd') return;
    const generation = this.generations.get(child);
    const turn =
      child.agent === 'claude' ? (event.generation === null ? null : String(event.generation)) : event.turnId;
    const state = child.state();
    if (generation === undefined || !turn || state.exited || state.sessionId !== event.sessionId) return;
    const submission = String(turnId);
    for (const held of this.requests.carriable(event.sessionId)) {
      const binding = held.binding;
      if (
        !held.carry ||
        binding.childGeneration !== generation ||
        binding.provider !== event.provider ||
        (binding.turn === turn && binding.submissionId === submission) ||
        (!held.carry.has(submission) && binding.submissionId !== submission)
      )
        continue;
      this.rebind(held.id, binding, { turn, submissionId: submission, readerRevision: this.revision(event.sessionId) });
    }
  }

  // Moves held work and the child's turn book to a changed binding, so later events of that turn find it.
  private rebind(id: string, binding: Readonly<CompactBinding>, change: Partial<CompactBinding>): void {
    const next: CompactBinding = { ...binding, ...change };
    if (binding.assignmentId) next.assignmentId = `${next.childGeneration}:${next.turn}:${next.submissionId}`;
    for (const child of this.children.values()) {
      if (this.generations.get(child) !== binding.childGeneration) continue;
      const book = this.bindings.get(child) ?? new Map<string, CompactBinding>();
      this.bindings.set(child, book);
      for (const [key, known] of book) if (sameBinding(known, binding)) book.set(key, { ...next });
      book.set(`${next.submissionId}:${next.turn}`, { ...next });
    }
    this.requests.rebind(id, next);
  }

  // Holds each live root tool call that runs the exact cancel command, with the session that runs it.
  private observeCancel(child: C, event: NativeEvent & { kind: 'toolStart' | 'toolEnd' }): void {
    const key = `${child.key}\0${event.provider}\0${event.sessionId}\0${event.toolId}`;
    if (event.kind === 'toolEnd') {
      this.cancels.delete(key);
      return;
    }
    const payload = compactCancelPayload(event.command);
    const state = child.state();
    if (
      !payload ||
      !event.initiating ||
      payload.window !== this.activation ||
      child.agent !== event.provider ||
      state.exited ||
      state.sessionId !== event.sessionId
    )
      return;
    this.cancels.delete(key);
    this.cancels.set(key, {
      requestId: payload.requestId,
      provider: event.provider,
      sessionId: event.sessionId,
      child,
    });
    if (this.cancels.size > COMPACT_LIMITS.records) this.cancels.delete(this.cancels.keys().next().value!);
  }

  replyRetained(child: C, turnId: number): void {
    if (this.disposed) return;
    const replies = this.replies.get(child) ?? new Set<number>();
    this.replies.set(child, replies);
    replies.add(turnId);
    for (const reply of replies) {
      if (replies.size <= SUBMISSIONS_PER_CHILD) break;
      if (!this.awaitsRecordedReply(child, reply)) replies.delete(reply);
    }
    const endings = this.endings.get(child);
    const ending = endings?.get(turnId);
    if (!ending) return;
    endings!.delete(turnId);
    this.requests.observe(ending.binding, ending.event, true);
  }

  // Whether an admitted request of this turn still waits for the panel to hold its final response.
  awaitsRecordedReply(child: C, turnId: number): boolean {
    if (this.disposed || !this.generations.has(child)) return false;
    const generation = this.generations.get(child);
    return this.requests.awaitsReply(
      (binding) => binding.childGeneration === generation && binding.submissionId === String(turnId),
    );
  }

  // A child turn ended. Root endings still waiting for a saved response fail, except the successful
  // ending of a provider-originated turn. Its response waits for the recorded turn.
  turnEnded(child: C): void {
    const endings = this.endings.get(child);
    if (!endings) return;
    for (const [turnId, ending] of endings) {
      if (ending.event.kind === 'rootEnd' && ending.event.success && child.startedByAgent?.(turnId)) continue;
      endings.delete(turnId);
      this.requests.observe(ending.binding, ending.event, false);
    }
  }

  childGone(key: string): void {
    const child = this.children.get(key);
    for (const [id, call] of this.cancels)
      if (call.child.key === key && (!child || call.child === child)) this.cancels.delete(id);
    if (!child) return;
    this.children.delete(key);
    const generation = this.generations.get(child);
    this.requests.invalidate(
      (binding) => binding.childGeneration === generation,
      'The agent process ended before compaction started.',
      false,
      undefined,
      true,
    );
  }

  sessionMoved(previous: string): void {
    for (const [id, call] of this.cancels) if (call.sessionId === previous) this.cancels.delete(id);
    this.requests.invalidate(
      (binding) => binding.sessionId === previous,
      'The session changed before compaction started.',
    );
  }

  async drain(sessionId: string): Promise<void> {
    if (this.settling) return;
    for (const { id, binding } of this.requests.deliverable(sessionId)) {
      const child = this.resolve(binding);
      // A newer reader revision means a carried request waits for the turn that answers the reader's message.
      // Every other reader action already cancelled it.
      if (child === 'reader') continue;
      if (typeof child === 'string') {
        this.requests.invalidate((current) => current === binding, COMPACT_LOSSES[child]);
        continue;
      }
      if (!this.eligible(binding, 'deliver')) continue;
      let writing = false;
      const result = await this.port.withActivity(child, async (live) => {
        if (live !== child) return;
        await this.requests.deliver(id, {
          eligible: (current) => this.eligible(current, writing ? 'write' : 'deliver'),
          submit: (_current, beforeWrite) => {
            writing = true;
            return live.compact(beforeWrite);
          },
        });
      });
      if (result === null)
        this.requests.invalidate(
          (current) => current.childGeneration === binding.childGeneration,
          'The agent process ended before compaction started.',
        );
    }
    for (const { id, binding } of this.requests.continuationDeliverable(sessionId)) {
      const child = this.current(binding);
      if (!child) {
        this.requests.invalidate((current) => current === binding, 'The continuation session changed.');
        continue;
      }
      if (!child.guardedPrompt || child.guardedIdle?.() !== null) continue;
      await this.port.withActivity(child, async (live) => {
        if (live !== child) return;
        await this.requests.continue(id, {
          eligible: (current, writing) =>
            this.eligible(current, writing ? 'write' : 'deliver') &&
            (!this.port.continuationWork || this.port.continuationWork(sessionId) === 'none') &&
            (writing || live.guardedIdle?.() === null),
          submit: (text, beforeWrite) =>
            live.guardedPrompt!(
              text,
              randomUUID(),
              (turn) => this.submitted(live, turn, 'continuation', binding.assignmentId),
              beforeWrite,
            ),
        });
      });
    }
  }

  handle(request: { method: string; params: object }): unknown {
    const params = request.params as Record<string, unknown>;
    if (request.method === 'compact-status') {
      const current = this.requests.status(String(params.requestId));
      if (current && !current.continuation) return current;
      const saved = this.persistence?.read(String(params.requestId));
      const source =
        saved && (this.port.source ?? this.port.authority)?.(saved.binding.provider, saved.binding.sessionId);
      if (saved && source && source === saved.binding.sourceIdentity) {
        const observation = current ?? structuredClone(saved.observation);
        const continuation = observation.continuation!;
        if (
          this.persistence!.ended(saved.owner) &&
          ['waiting', 'preparing', 'attempting'].includes(continuation.state)
        ) {
          continuation.state = continuation.state === 'attempting' ? 'uncertain' : 'cancelled';
          continuation.write = continuation.state === 'uncertain' ? 'unknown' : 'not-written';
          continuation.reason = 'The originating window ended. Continuation will not restart.';
          continuation.sequence++;
        }
        return { ...observation, servedByWindow: this.activation };
      }
      return {
        requestId: params.requestId,
        state: 'unavailable',
      };
    }
    if (request.method === 'compact-cancel') {
      if (!validCompactCancel(params) || params.window !== this.activation)
        return {
          requestId: params.requestId,
          state: 'refused',
          code: 'unknown',
          reason: COMPACT_CANCEL_REFUSALS.unknown,
        };
      return this.requests.cancel(
        params.requestId,
        [...this.cancels.values()].filter((call) => {
          if (call.requestId !== params.requestId) return false;
          const state = call.child.state();
          return (
            this.port.find(call.provider, call.sessionId) === call.child &&
            !state.exited &&
            state.sessionId === call.sessionId
          );
        }),
      );
    }
    if (request.method === 'compact-ready')
      return validCompactPayload(params)
        ? this.requests.readiness(params)
        : { ready: false, code: 'not-observed', reason: COMPACT_REJECTIONS['not-observed'] };
    try {
      if (request.method !== 'compact-request' || !validCompactPayload(params))
        throw new Error('This compaction request is unavailable in this Arc window.');
      if (params.continuation)
        return this.requests
          .admitSaved(params, (binding) => this.eligible(binding, 'admit'))
          .catch((error: unknown) => ({
            requestId: params.requestId,
            state: 'refused',
            reason: error instanceof Error ? error.message : 'Compaction was refused.',
          }));
      return this.requests.admit(params, (binding) => this.eligible(binding, 'admit'));
    } catch (error) {
      return {
        requestId: params.requestId,
        state: 'refused',
        reason: error instanceof Error ? error.message : 'Compaction was refused.',
      };
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancels.clear();
    this.requests.dispose();
    this.persistence?.release();
  }

  private revision(sessionId: string): number {
    return this.revisions.get(sessionId) ?? 0;
  }

  private generationOf(child: C): number {
    let generation = this.generations.get(child);
    if (generation === undefined) {
      generation = ++this.generation;
      this.generations.set(child, generation);
    }
    if (this.children.has(child.key) && this.children.get(child.key) !== child) this.childGone(child.key);
    this.children.set(child.key, child);
    return generation;
  }

  private binding(child: C, event: NativeEvent, turnId: number | undefined): CompactBinding | null {
    const provider = child.agent;
    if (turnId === undefined || (provider !== 'claude' && provider !== 'codex') || event.provider !== provider)
      return null;
    const submission = this.submissions.get(child)?.get(turnId);
    const turn = provider === 'claude' ? (event.generation === null ? null : String(event.generation)) : event.turnId;
    if (
      !turn ||
      child.state().exited ||
      child.state().sessionId !== event.sessionId ||
      (submission?.sessionId != null && submission.sessionId !== event.sessionId)
    )
      return null;
    const book = this.bindings.get(child) ?? new Map<string, CompactBinding>();
    this.bindings.set(child, book);
    const key = `${turnId}:${turn}`;
    const known = book.get(key);
    if (event.kind !== 'toolStart' || !event.initiating || !compactCommandPayload(event.command)) return known ?? null;
    const generation = this.generationOf(child);
    const binding: CompactBinding = {
      activation: this.activation,
      provider,
      sessionId: event.sessionId,
      childGeneration: generation,
      turn,
      submissionId: String(turnId),
      readerRevision: this.revision(event.sessionId),
      assignmentId: `${generation}:${turn}:${turnId}`,
      ...(this.port.authority ? { authority: this.port.authority(provider, event.sessionId) ?? undefined } : {}),
      ...((this.port.source ?? this.port.authority)
        ? { sourceIdentity: (this.port.source ?? this.port.authority)!(provider, event.sessionId) ?? undefined }
        : {}),
    };
    Object.assign(binding, this.observations.get(event));
    book.set(key, binding);
    return binding;
  }

  // Asks and queued reader input, including a queued `/compact`, block admission and delivery.
  // Admission runs while the requesting tool keeps the child busy. Delivery needs an idle,
  // ready child. The provider write callback runs after the child's own command bookkeeping
  // marks it busy, so that check omits the busy flag. Delivery also waits while an earlier
  // compaction of the child has no answer or no ended turn, so its late turn has one owner.
  private eligible(binding: Readonly<CompactBinding>, mode: 'admit' | 'deliver' | 'write'): boolean {
    const child = this.current(binding);
    if (!child) return false;
    if (binding.authority && this.port.authority?.(binding.provider, binding.sessionId) !== binding.authority)
      return false;
    const state = child.state();
    if (state.asks.length > 0 || this.port.readerWork(binding.sessionId) !== 'none') return false;
    if (mode === 'admit') return true;
    if (this.settling || !state.ready || child.compactionUnresolved()) return false;
    return mode === 'write' || !state.busy;
  }

  // Resolves the exact retained child while the binding can still become deliverable.
  private current(binding: Readonly<CompactBinding>): C | null {
    const resolved = this.resolve(binding);
    return typeof resolved === 'string' ? null : resolved;
  }

  // Resolves the exact retained child, or names the first change that ended the binding.
  private resolve(binding: Readonly<CompactBinding>): C | CompactLoss {
    if (this.disposed) return 'exited';
    if (this.revision(binding.sessionId) !== binding.readerRevision) return 'reader';
    if (this.port.readerWork(binding.sessionId) === 'absent') return 'scope';
    const authority = this.port.authority?.(binding.provider, binding.sessionId);
    if (binding.authority && authority && authority !== binding.authority) return 'authority';
    const child = this.port.find(binding.provider, binding.sessionId);
    if (!child) return 'exited';
    if (this.generations.get(child) !== binding.childGeneration) return 'replaced';
    const state = child.state();
    return state.exited || state.sessionId !== binding.sessionId ? 'exited' : child;
  }
}

// The panel calls that hold a final response for the compaction its turn requested.
export interface ReplyHolder {
  noteRecordedReply(
    session: string,
    sourceId: string,
    text: string,
    saved: () => void,
    wanted: () => boolean,
    identity?: { provider: 'claude' | 'codex'; nativeTurnId?: string; ownerTurnId?: number },
  ): void;
  noteCompletedReply(session: string, text: string, sourceId?: string, turnId?: number, saved?: () => void): void;
  settleRecordedReplies(): void;
}

// Sends a reader prompt and retains its live session and shared response owner.
export function promptAsReader<C extends CompactChild>(
  compaction: CompactHost<C> | null,
  child: C,
  send: (onSubmitted: (turnId: number) => void, onReceived: (turnId: number) => void) => Promise<number>,
  onSubmitted?: (turnId: number) => void,
): Promise<number> {
  return send(
    (turnId) => {
      compaction?.submitted(child, turnId);
      onSubmitted?.(turnId);
    },
    (turnId) => compaction?.read(child, turnId),
  ).catch((error: unknown) => {
    compaction?.unsent(child);
    throw error;
  });
}

// Returns the prompt the agent receives. While the session holds a carried request, its text ends with Arc's line.
// The reader's draft and queue keep the original prompt.
export function readerPrompt<P extends { text: string }>(
  compaction: { carriedLine(sessionId: string): string | null } | null | undefined,
  sessionId: string,
  prompt: P,
): P {
  const line = compaction?.carriedLine(sessionId);
  return line ? { ...prompt, text: prompt.text ? `${prompt.text}\n\n${line}` : line } : prompt;
}

// Routes the child events that self-compaction reads. Returns true when the event needs no other
// handling. A provider-originated turn has no response card, so its final response waits for a
// recorded turn while a compaction request of that turn waits for it.
export function routeCompactionEvent<C extends CompactChild>(
  compaction: CompactHost<C> | null,
  replies: ReplyHolder,
  child: C | null,
  event: WireEvent,
  turnId: number | undefined,
): boolean {
  if (event.kind === 'native') {
    if (child) compaction?.native(child, event.event, turnId);
    return true;
  }
  if (event.kind === 'text') {
    const where = child?.state().sessionId;
    if (!child || !where) return true;
    if (turnId !== undefined && child.startedByAgent?.(turnId)) {
      if (compaction?.awaitsRecordedReply(child, turnId))
        replies.noteRecordedReply(
          where,
          event.sourceId ?? '',
          event.text,
          () => compaction.replyRetained(child, turnId),
          () => compaction.awaitsRecordedReply(child, turnId),
          {
            provider: child.agent as 'claude' | 'codex',
            ownerTurnId: turnId,
            ...(child.agent === 'codex' && event.nativeTurnId ? { nativeTurnId: event.nativeTurnId } : {}),
          },
        );
    } else
      replies.noteCompletedReply(where, event.text, event.sourceId, turnId, () => {
        if (turnId !== undefined) compaction?.replyRetained(child, turnId);
      });
    return true;
  }
  // The transcript can record the final response after its text event.
  if (event.kind === 'turnEnd') replies.settleRecordedReplies();
  return false;
}
