import { GuardedAttempt } from '../src/agentwire.ts';
import {
  GuardedSends,
  runGuardedSend,
  type GuardedOwner,
  type GuardedSendRequest,
  type GuardedTargetFacts,
} from '../src/sessionwrites.ts';

// These guards catch guarded sends that reach a child they must not reach, with fake children and no provider startup.
export class GuardChild {
  readonly key = 'worker-key';
  agent = 'claude';
  idle: string | null = null;
  turnEnds = 0;
  attempts: string[] = [];
  guardedTurnEnds() {
    return this.turnEnds;
  }
  // The local submission number the child assigns to its next prompt.
  submission = 7;
  guardedPrompt(text: string, clientUuid: string, onSubmitted?: (turnId: number) => void) {
    this.attempts.push(text);
    onSubmitted?.(this.submission);
    return new GuardedAttempt(clientUuid);
  }
  sessionId = 'worker';
  exited = false;
  lastError: string | null = null;
  state() {
    return { sessionId: this.sessionId, exited: this.exited, lastError: this.lastError };
  }
  guardedIdle() {
    return this.idle;
  }
}

export function guardFixture() {
  const child = new GuardChild();
  const policy = new GuardedSends<GuardChild>('window', (owner) => port.live(owner));
  const coordinator = { provider: 'claude' as const, id: 'coordinator' };
  policy.recordStart({
    requester: coordinator,
    activation: 'window',
    worker: 'worker',
    child,
  });
  const facts: GuardedTargetFacts = {
    current: true,
    archived: false,
    scope: 'scope',
    sourceRevision: 'revision-1',
    latestTurn: 'turn-1',
    queued: 0,
    pendingSubmissions: 0,
    pendingControls: 0,
    background: false,
    writerConflict: false,
  };
  policy.facts = () => facts;
  const writes: GuardedAttempt[] = [];
  const port = {
    alive: true,
    retained: child as GuardChild | null,
    leased: true,
    live: (_owner: GuardedOwner<GuardChild>) => (port.alive ? port.retained : null),
    withLease: async <T>(_child: GuardChild, work: () => Promise<T>) => (port.leased ? work() : null),
    write: (_child: GuardChild, _text: string) => {
      const attempt = new GuardedAttempt(`uuid-${writes.length}`);
      attempt.markWritten();
      writes.push(attempt);
      return attempt;
    },
  };
  let serial = 0;
  const send = (changes: Partial<GuardedSendRequest> = {}) =>
    runGuardedSend(
      policy,
      {
        requestId: `window:${++serial}`,
        activation: 'window',
        sessionId: 'worker',
        prompt: 'Apply the accepted corrections.',
        observation: policy.observe('worker', coordinator, facts) ?? '',
        requester: coordinator,
        ...changes,
      },
      port,
    );
  return { policy, child, coordinator, facts, writes, port, send };
}

export function guardedRequest(observation: string, requester: { provider: 'claude'; id: string }): GuardedSendRequest {
  return {
    requestId: 'window:check',
    activation: 'window',
    sessionId: 'worker',
    prompt: 'Next.',
    observation,
    requester,
  };
}
