import type { NativeEvent } from './agentwire';

export const COMPACT_LIMITS = { records: 256, admissionMs: 15 * 60_000, retentionMs: 60 * 60_000 } as const;
export interface CompactPayload {
  requestId: string;
  window: string;
  self: true;
  afterTurn: true;
}
export type CompactState = 'queued' | 'started' | 'completed' | 'cancelled' | 'refused' | 'failed' | 'uncertain';
export interface CompactBinding {
  activation: string;
  provider: 'claude' | 'codex';
  sessionId: string;
  childGeneration: number;
  turn: string;
  submissionId: string;
  readerRevision: number;
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
}
interface Assignment {
  payload: CompactPayload;
  binding: Readonly<CompactBinding>;
  toolId: string;
  deadline: number;
  toolSucceeded: boolean;
  turnSucceeded: boolean;
  finalRetained: boolean;
  submitted: boolean;
  delivering: boolean;
  terminalAt: number | null;
  observation: CompactObservation;
  operation?: NativeCompactOperation;
}
interface Call {
  payload: CompactPayload;
  binding: Readonly<CompactBinding>;
  toolId: string;
}

export function validCompactPayload(input: unknown): input is CompactPayload {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  return (
    Object.keys(value).sort().join(',') === 'afterTurn,requestId,self,window' &&
    value.self === true &&
    value.afterTurn === true &&
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

// Exact literal commands exclude shell composition and inherited selectors.
export function compactCommandPayload(command: string): CompactPayload | null {
  const wrapped = POWERSHELL_WRAPPER.exec(command);
  const literal = wrapped ? (wrapped[1] ?? wrapped[2]) : command;
  const match =
    /^arc compact request --self --after-turn --request-id ([a-f0-9]{24}:[a-f0-9-]{36}) --window ([a-f0-9]{24}) --json$/.exec(
      literal,
    );
  if (!match) return null;
  const payload = { requestId: match[1], window: match[2], self: true as const, afterTurn: true as const };
  return validCompactPayload(payload) ? payload : null;
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

function payloadKey(payload: CompactPayload): string {
  return JSON.stringify([payload.requestId, payload.window, payload.self, payload.afterTurn]);
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
  // Request IDs admitted in this activation. Each admission consumes a recorded call, so seenCalls bounds this set.
  private consumed = new Set<string>();
  // The assignment whose provider command is being written. The adapter emits its submission
  // event synchronously after the write callback, and that event names the operation's generation.
  private claiming: Assignment | null = null;
  private disposed = false;
  constructor(
    private readonly activation: string,
    private readonly now = Date.now,
    private readonly capacity: number = COMPACT_LIMITS.records,
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
        event.foreground &&
        payload?.window === this.activation &&
        !this.seenCalls.has(key) &&
        this.seenCalls.size < this.capacity &&
        ![...this.assignments.values()].some((a) => sameBinding(a.binding, binding) && a.toolId === event.toolId)
      ) {
        this.seenCalls.add(key);
        this.calls.set(key, { payload, binding: Object.freeze({ ...binding }), toolId: event.toolId });
      }
    }
    if (event.kind === 'toolEnd') this.calls.delete(key);
    if (event.kind === 'rootEnd') {
      for (const [id, call] of this.calls) if (sameBinding(call.binding, binding)) this.calls.delete(id);
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
        if (!event.success || !assignment.toolSucceeded || !finalRetained)
          this.change(assignment, 'failed', 'The requesting turn or its saved response is unavailable.');
      }
    }
  }

  // Routes native compaction evidence to the one operation whose submission generation it names.
  // It never changes an unsubmitted assignment or another submitted operation.
  observeSubmitted(event: NativeEvent, childGeneration: number): void {
    const owns = (assignment: Assignment) =>
      assignment.submitted &&
      assignment.binding.provider === event.provider &&
      assignment.binding.sessionId === event.sessionId &&
      assignment.binding.childGeneration === childGeneration;
    if (event.generation === null) return;
    if (event.kind === 'submission') {
      const claiming = this.claiming;
      if (!claiming || !owns(claiming)) return;
      this.claiming = null;
      if (event.text === '/compact' && claiming.operation) claiming.operation.generation = event.generation;
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
          .filter((a) => !a.submitted && a.observation.state === 'queued')
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
          !a.delivering &&
          a.observation.state === 'queued' &&
          a.toolSucceeded &&
          a.turnSucceeded &&
          a.finalRetained,
      )
      .map(([id, a]) => ({ id, binding: a.binding }));
  }

  ready(payload: CompactPayload): boolean {
    return !this.disposed && [...this.calls.values()].some((call) => payloadKey(call.payload) === payloadKey(payload));
  }

  admit(
    payload: CompactPayload,
    eligible: (binding: Readonly<CompactBinding>) => boolean,
  ): Readonly<CompactObservation> {
    this.prune();
    const live = [...this.calls].find(([, call]) => payloadKey(call.payload) === payloadKey(payload));
    const existing = this.assignments.get(payload.requestId);
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
    if (!live || !eligible(live[1].binding))
      throw new Error('The live requesting tool is unavailable, or the session has asks or queued reader input.');
    const [key, call] = live;
    if (
      [...this.assignments.values()].some(
        (a) =>
          a.binding.sessionId === call.binding.sessionId &&
          a.binding.childGeneration === call.binding.childGeneration &&
          a.binding.turn === call.binding.turn &&
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
    });
    this.assignments.set(payload.requestId, {
      payload: { ...payload },
      binding: call.binding,
      toolId: call.toolId,
      deadline: this.now() + COMPACT_LIMITS.admissionMs,
      toolSucceeded: false,
      turnSucceeded: false,
      finalRetained: false,
      submitted: false,
      delivering: false,
      terminalAt: null,
      observation: { ...acknowledgement },
    });
    return { ...acknowledgement };
  }

  status(id: string): CompactObservation | null {
    this.prune();
    const assignment = this.assignments.get(id);
    return assignment ? { ...assignment.observation } : null;
  }

  // Cancels unsubmitted assignments that match. Live calls that match also lose their authority unless keepCalls is set.
  invalidate(predicate: (binding: Readonly<CompactBinding>) => boolean, reason: string, keepCalls = false): void {
    if (!keepCalls) for (const [key, call] of this.calls) if (predicate(call.binding)) this.calls.delete(key);
    for (const assignment of this.assignments.values())
      if (!assignment.submitted && assignment.observation.state === 'queued' && predicate(assignment.binding))
        this.change(assignment, 'cancelled', reason);
  }

  dispose(): void {
    this.invalidate(() => true, 'The Arc window closed before compaction started.');
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
    // only means the session is not ready yet, or the deadline passed and prune reports expiry.
    const check = () =>
      !this.disposed &&
      !assignment.submitted &&
      assignment.observation.state === 'queued' &&
      this.now() < assignment.deadline &&
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
      } else if (assignment.submitted && state === 'uncertain')
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
    if (!assignment?.submitted || !sameBinding(assignment.binding, binding)) return;
    const previous = assignment.observation.state;
    if (previous === state) return;
    if (previous === 'completed' || previous === 'failed') {
      if (state !== 'started') this.change(assignment, 'uncertain', 'Native compaction outcomes conflict.');
      return;
    }
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
  }
  private prune(): void {
    for (const [id, assignment] of this.assignments) {
      if (!assignment.submitted && assignment.observation.state === 'queued' && this.now() >= assignment.deadline)
        this.change(assignment, 'cancelled', 'The compaction request expired before it started.');
      if (assignment.terminalAt !== null && this.now() - assignment.terminalAt >= COMPACT_LIMITS.retentionMs)
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
  compact(beforeWrite: () => void): Promise<unknown>;
}

export interface CompactHostPort<C extends CompactChild> {
  find(provider: 'claude' | 'codex', sessionId: string): C | null;
  // Runs work under an activity lease on this exact child. It resolves null without opening a missing child.
  withActivity(child: C, work: (live: C) => Promise<void>): Promise<unknown>;
  // Names queued reader prompts or a clear in progress as pending, and a session outside the panel's scope as absent.
  // Unavailable membership blocks delivery without cancelling the assignment.
  readerWork(sessionId: string): 'none' | 'pending' | 'absent' | 'unknown';
}

interface Submission {
  sessionId: string | null;
  revision: number;
}

const SUBMISSIONS_PER_CHILD = 32;

// Joins host observations to deferred assignments for one window activation.
// The reader revision advances synchronously at each reader action and cancels unsubmitted work.
export class CompactHost<C extends CompactChild> {
  readonly requests: CompactRequests;
  private readonly revisions = new Map<string, number>();
  private readonly generations = new WeakMap<C, number>();
  private readonly children = new Map<string, C>();
  private readonly submissions = new WeakMap<C, Map<number, Submission>>();
  private readonly replies = new WeakMap<C, Set<number>>();
  private readonly endings = new WeakMap<C, Map<number, { binding: CompactBinding; event: NativeEvent }>>();
  private generation = 0;
  // True from a scope change until the panel's session rows reflect the new scope.
  private settling = false;
  private disposed = false;

  constructor(
    private readonly activation: string,
    private readonly port: CompactHostPort<C>,
    now: () => number = Date.now,
  ) {
    this.requests = new CompactRequests(activation, now);
  }

  // An answer can approve the requesting command inside its own turn, so it keeps the reader
  // revision and live calls. It still cancels admitted work that has not been submitted.
  readerAction(sessionId: string, answer = false): void {
    if (!answer) this.revisions.set(sessionId, this.revision(sessionId) + 1);
    this.requests.invalidate(
      (binding) => binding.sessionId === sessionId,
      'The reader acted in this session before compaction started.',
      answer,
    );
  }

  // Known directories outside a ready scope cancel assignments before any rows refresh.
  // Delivery still waits until the session rows reflect the scope.
  scopeChanged(outOfScope: ReadonlySet<string> = new Set()): void {
    this.settling = true;
    this.requests.invalidate(
      (binding) => outOfScope.has(binding.sessionId),
      "The session left this window's scope before compaction started.",
    );
  }

  // Runs after each full rows refresh. A session that left the panel's scope cancels its unsubmitted
  // work, also when the scope later returns it. Work that waited on the scope change drains.
  sessionsRefreshed(): void {
    if (this.disposed) return;
    this.settling = false;
    this.requests.invalidate(
      (binding) => this.port.readerWork(binding.sessionId) === 'absent',
      "The session left this window's scope before compaction started.",
    );
    for (const sessionId of this.requests.waitingSessions()) void this.drain(sessionId);
  }

  // Records the reader revision of a prompt the child accepted for writing.
  submitted(child: C, turnId: number): void {
    if (this.disposed) return;
    const sessionId = child.state().sessionId;
    const book = this.submissions.get(child) ?? new Map<number, Submission>();
    this.submissions.set(child, book);
    book.set(turnId, {
      sessionId,
      revision: sessionId ? this.revision(sessionId) : 0,
    });
    if (book.size > SUBMISSIONS_PER_CHILD) book.delete(book.keys().next().value!);
    this.generationOf(child);
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
    const binding = this.binding(child, event, turnId);
    if (!binding || turnId === undefined) return;
    const replies = this.replies.get(child) ?? new Set<number>();
    this.replies.set(child, replies);
    if (event.kind === 'rootEnd') {
      // A root success waits until the panel saves the final response for the reader.
      if (replies.has(turnId)) this.requests.observe(binding, event, true);
      else {
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

  replyRetained(child: C, turnId: number): void {
    if (this.disposed) return;
    const replies = this.replies.get(child) ?? new Set<number>();
    this.replies.set(child, replies);
    replies.add(turnId);
    if (replies.size > SUBMISSIONS_PER_CHILD) replies.delete(replies.values().next().value!);
    const endings = this.endings.get(child);
    const ending = endings?.get(turnId);
    if (!ending) return;
    endings!.delete(turnId);
    this.requests.observe(ending.binding, ending.event, true);
  }

  // A child turn ended. Root endings still waiting for a saved response fail.
  turnEnded(child: C): void {
    const endings = this.endings.get(child);
    if (!endings) return;
    this.endings.delete(child);
    for (const ending of endings.values()) this.requests.observe(ending.binding, ending.event, false);
  }

  childGone(key: string): void {
    const child = this.children.get(key);
    if (!child) return;
    this.children.delete(key);
    const generation = this.generations.get(child);
    this.requests.invalidate(
      (binding) => binding.childGeneration === generation,
      'The agent process ended before compaction started.',
    );
  }

  sessionMoved(previous: string): void {
    this.requests.invalidate(
      (binding) => binding.sessionId === previous,
      'The session changed before compaction started.',
    );
  }

  async drain(sessionId: string): Promise<void> {
    if (this.settling) return;
    for (const { id, binding } of this.requests.deliverable(sessionId)) {
      const child = this.current(binding);
      if (!child) {
        this.requests.invalidate(
          (current) => current.childGeneration === binding.childGeneration && current.sessionId === binding.sessionId,
          'The session or its agent process changed before compaction started.',
        );
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
  }

  handle(request: { method: string; params: object }): unknown {
    const params = request.params as Record<string, unknown>;
    if (request.method === 'compact-status')
      return (
        this.requests.status(String(params.requestId)) ?? {
          requestId: params.requestId,
          state: 'unavailable',
        }
      );
    if (request.method === 'compact-ready')
      return {
        ready: validCompactPayload(params) && this.requests.ready(params),
      };
    try {
      if (request.method !== 'compact-request' || !validCompactPayload(params))
        throw new Error('This compaction request is unavailable in this Arc window.');
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
    this.requests.dispose();
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
      !submission ||
      !turn ||
      child.state().sessionId !== event.sessionId ||
      (submission.sessionId !== null && submission.sessionId !== event.sessionId)
    )
      return null;
    return {
      activation: this.activation,
      provider,
      sessionId: event.sessionId,
      childGeneration: this.generationOf(child),
      turn,
      submissionId: String(turnId),
      readerRevision: submission.revision,
    };
  }

  // Asks and queued reader input, including a queued `/compact`, block admission and delivery.
  // Admission runs while the requesting tool keeps the child busy. Delivery needs an idle,
  // ready child. The provider write callback runs after the child's own command bookkeeping
  // marks it busy, so that check omits the busy flag. Delivery also waits while an earlier
  // compaction of the child has no answer or no ended turn, so its late turn has one owner.
  private eligible(binding: Readonly<CompactBinding>, mode: 'admit' | 'deliver' | 'write'): boolean {
    const child = this.current(binding);
    if (!child) return false;
    const state = child.state();
    if (state.asks.length > 0 || this.port.readerWork(binding.sessionId) !== 'none') return false;
    if (mode === 'admit') return true;
    if (this.settling || !state.ready || child.compactionUnresolved()) return false;
    return mode === 'write' || !state.busy;
  }

  // Resolves the exact retained child while the binding can still become deliverable.
  private current(binding: Readonly<CompactBinding>): C | null {
    if (this.disposed || this.revision(binding.sessionId) !== binding.readerRevision) return null;
    if (this.port.readerWork(binding.sessionId) === 'absent') return null;
    const child = this.port.find(binding.provider, binding.sessionId);
    if (!child || this.generations.get(child) !== binding.childGeneration) return null;
    const state = child.state();
    return state.exited || state.sessionId !== binding.sessionId ? null : child;
  }
}
