import type { WireEvent, NativeEvent } from './agentwire';
import type { DispatchLaunch, DispatchEvent } from './dispatchreceipts';
import { DispatchReceipts } from './dispatchreceipts';
import { payloadSha256 } from './sessionwrites';

export interface DispatchChild {
  key: string;
  agent: string;
  state(): { sessionId: string | null; exited: boolean };
  dispatchRootActive?(submission: number): boolean;
}
export interface SavedDispatchResponse {
  text: string;
  prompt: string;
  promptId: string;
  responseIds: string[];
  finished: boolean;
  failed: boolean;
}
interface Assignment {
  launch: DispatchLaunch;
  child: DispatchChild;
  submission: number | null;
  session: string | null;
  nativeTurn: string | null;
  blocks: Map<string, string>;
  ending: Extract<NativeEvent, { kind: 'rootEnd' }> | null;
  terminal: boolean;
  observation: string;
}

// Observes the owning child. No operation starts, resumes, or replaces an agent.
export class HostedDispatch {
  private readonly assignments = new Map<string, Assignment>();
  private readonly listeners = new Map<string, Set<(event: DispatchEvent) => void>>();
  constructor(
    readonly receipts: DispatchReceipts,
    private readonly saved: (
      provider: string,
      session: string,
      nativeTurn: string | null,
    ) => SavedDispatchResponse | null,
  ) {}
  register(launchId: string, child: DispatchChild): void {
    const launch = this.receipts.launch(launchId);
    if (this.assignments.has(launchId)) throw new Error('This dispatch launch already has a worker.');
    this.assignments.set(launchId, {
      launch,
      child,
      submission: null,
      session: null,
      nativeTurn: null,
      blocks: new Map(),
      ending: null,
      terminal: false,
      observation: '',
    });
  }
  submitted(launchId: string, submission: number): void {
    const assignment = this.assignments.get(launchId)!;
    if (assignment.submission !== null && assignment.submission !== submission)
      throw new Error('The accepted dispatch submission cannot change.');
    assignment.submission = submission;
  }
  accepted(launchId: string, nativeTurn: string | null): void {
    const assignment = this.assignments.get(launchId)!;
    const session = assignment.child.state().sessionId;
    if (!session || assignment.submission === null || !nativeTurn) return;
    if (assignment.nativeTurn && assignment.nativeTurn !== nativeTurn)
      throw new Error('The dispatch root turn cannot change.');
    assignment.session = session;
    assignment.nativeTurn = nativeTurn;
    this.receipts.bind(launchId, {
      provider: assignment.child.agent as 'claude' | 'codex',
      sessionId: session,
      submissionId: assignment.submission,
      nativeTurnId: nativeTurn,
    });
  }
  observe(child: DispatchChild, event: WireEvent, submission: number | undefined): void {
    for (const assignment of this.assignments.values()) {
      if (assignment.child !== child || assignment.terminal) continue;
      if (event.kind === 'ask' && assignment.submission !== null && child.dispatchRootActive?.(assignment.submission)) {
        this.publish(
          assignment,
          { outcome: 'needs-input', availability: 'unavailable', nativeEnding: null, askId: event.ask.id },
          null,
        );
        continue;
      }
      if (submission === undefined || submission !== assignment.submission) continue;
      const session = child.state().sessionId;
      if (!session || (assignment.session && assignment.session !== session)) continue;
      assignment.session = session;
      if (event.kind === 'text') {
        assignment.blocks.clear();
        assignment.blocks.set(event.sourceId ?? '', event.text);
      }
      if (event.kind === 'native' && event.event.kind === 'rootEnd') {
        const native = event.event;
        if (native.sessionId !== session || native.provider !== child.agent) continue;
        const turn =
          child.agent === 'codex' ? native.turnId : native.generation === null ? null : String(native.generation);
        if (!turn || (assignment.nativeTurn && assignment.nativeTurn !== turn)) continue;
        assignment.nativeTurn = turn;
        assignment.ending = native;
        this.receipts.bind(assignment.launch.launchId, {
          provider: native.provider,
          sessionId: session,
          submissionId: submission,
          nativeTurnId: turn,
        });
        this.reconcile(assignment);
      }
      if (event.kind === 'turnEnd' && !assignment.ending) {
        this.publish(
          assignment,
          {
            outcome:
              event.outcome.status === 'error'
                ? 'failed'
                : event.outcome.status === 'interrupted'
                  ? 'interrupted'
                  : 'unknown',
            availability: 'unavailable',
            nativeEnding: null,
            askId: null,
          },
          null,
        );
        assignment.terminal = true;
      }
    }
  }
  exited(child: DispatchChild): void {
    for (const assignment of this.assignments.values())
      if (assignment.child === child && !assignment.terminal) {
        if (assignment.ending) this.reconcile(assignment);
        else {
          this.publish(
            assignment,
            { outcome: 'unknown', availability: 'unavailable', nativeEnding: null, askId: null },
            null,
          );
          assignment.terminal = true;
        }
      }
  }
  reconcileAll(): void {
    for (const assignment of this.assignments.values())
      if (!assignment.terminal && assignment.ending) this.reconcile(assignment);
  }
  private reconcile(assignment: Assignment): void {
    const ending = assignment.ending!;
    const saved = assignment.session
      ? this.saved(assignment.child.agent, assignment.session, assignment.nativeTurn)
      : null;
    const text = [...assignment.blocks.values()].join('\n\n');
    const nativeEnding = {
      provider: ending.provider,
      sessionId: ending.sessionId,
      turnId: ending.turnId,
      generation: ending.generation,
      success: ending.success,
      evidenceSha256: payloadSha256(JSON.stringify(ending.evidence)),
    };
    const consistent =
      saved &&
      (saved.finished || saved.failed) &&
      payloadSha256(saved.prompt) === assignment.launch.promptSha256 &&
      saved.text === text &&
      (assignment.child.agent !== 'codex' || saved.promptId === assignment.nativeTurn) &&
      (assignment.child.agent === 'codex' ||
        [...assignment.blocks.keys()].every((id) => saved.responseIds.includes(id))) &&
      (!ending.success || !saved.failed);
    this.publish(
      assignment,
      {
        outcome: ending.success ? 'succeeded' : 'failed',
        availability: consistent ? 'available' : 'pending',
        nativeEnding,
        askId: null,
      },
      consistent ? text : null,
    );
    if (consistent) assignment.terminal = true;
  }
  private publish(
    assignment: Assignment,
    input: Omit<DispatchEvent, 'launchId' | 'eventId' | 'assignment' | 'report'>,
    text: string | null,
  ): void {
    const observation = JSON.stringify([input, text]);
    if (observation === assignment.observation) return;
    const event = this.receipts.publish(assignment.launch.launchId, input, text);
    assignment.observation = observation;
    for (const listener of this.listeners.get(assignment.launch.launchId) ?? []) listener(event);
  }
  wait(launchId: string, deadlineMs: number, signal: AbortSignal): Promise<unknown> {
    const launch = this.receipts.launch(launchId);
    if (launch.completion !== 'wait') throw new Error('This dispatch launch did not select waited completion.');
    this.reconcileAll();
    const last = this.receipts.status(launchId).events.at(-1);
    if (last && last.availability !== 'pending')
      return Promise.resolve({ launchId, state: 'observed', eventId: last.eventId, outcome: last.outcome });
    return new Promise((resolve) => {
      const finish = (reply: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', disconnected);
        listeners.delete(changed);
        if (!listeners.size) this.listeners.delete(launchId);
        resolve(reply);
      };
      const changed = (event: DispatchEvent) => {
        if (event.availability !== 'pending')
          finish({ launchId, state: 'observed', eventId: event.eventId, outcome: event.outcome });
      };
      const disconnected = () =>
        finish({
          launchId,
          state: 'uncertain',
          reason: 'The wait disconnected. Read dispatch status or recover this receipt.',
        });
      const listeners = this.listeners.get(launchId) ?? new Set();
      this.listeners.set(launchId, listeners);
      listeners.add(changed);
      const timer = setTimeout(
        () =>
          finish({
            launchId,
            state: 'deadline',
            reason: 'The wait deadline ended. Read dispatch status or recover this receipt.',
          }),
        deadlineMs,
      );
      signal.addEventListener('abort', disconnected, { once: true });
      if (signal.aborted) disconnected();
    });
  }
}
