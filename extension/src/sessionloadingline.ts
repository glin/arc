// Decides what the session-list loading line publishes, and writes each change of the line to the diagnostics log.
// The line stays hidden for the scope roots that completed it, across later refresh generations. Background work after that
// point keeps running and only writes a log line when its blocking reason changes.
import { createHash } from 'node:crypto';

// The post that carries a loading state to the panel.
export type SessionLoadingPath = 'discovery progress' | 'render' | 'selection' | 'session loading' | 'failure';

// The first check that keeps the session list loading, in the order the host applies its checks. A discovery reply names the
// discovery state it reports: a pending pass, or a complete reply that asks for no further pass and leaves the list to the render.
export type SessionLoadingReason =
  | 'failure'
  | 'catalog missing'
  | 'discovery pending'
  | 'discovery complete'
  | 'revision changed'
  | 'label missing'
  | 'starts missing'
  | 'enrichment needed'
  | 'newest turn loading';

export interface SessionLoadingBlocker {
  reason: SessionLoadingReason;
  file?: string;
}

export interface SessionLoadingStamp {
  generation: number;
  complete: boolean;
  failed?: boolean;
  completed?: number;
  known?: number;
}

// The most lines one host writes for the loading line, in two budgets. Changes of the line, holds and releases share one budget.
// Withheld background work has its own, so it never silences a later change. The last allowed line of each says the limit was reached.
export const SESSION_LOADING_LOG_LIMITS = { line: 400, withheld: 400 };

type LogBudget = keyof typeof SESSION_LOADING_LOG_LIMITS;

export class SessionLoadingLine {
  // The scope roots whose completed list holds the line hidden, or null before the first completion.
  private heldScope: string | null = null;
  // Whether the last published state showed the line. The panel starts with the line hidden.
  private shown = false;
  // The last withheld reason logged for each post path since the line was held.
  private withheld = new Map<SessionLoadingPath, SessionLoadingReason>();
  // Withheld states of each post path since its last withheld line, which its next withheld line reports.
  private repeats = new Map<SessionLoadingPath, number>();
  private written: Record<LogBudget, number> = { line: 0, withheld: 0 };

  constructor(
    private readonly write: (event: string, record: Record<string, unknown>) => void,
    private readonly limits: Record<LogBudget, number> = SESSION_LOADING_LOG_LIMITS,
  ) {}

  held(scope: string): boolean {
    return this.heldScope === scope;
  }

  // Holds the line hidden for a scope once its session list completes. A later completion of the same scope changes nothing.
  hold(scope: string, generation: number, path: SessionLoadingPath): void {
    if (this.heldScope === scope) return;
    this.heldScope = scope;
    this.withheld.clear();
    this.repeats.clear();
    this.log('line', 'sessionLoadingHeld', { generation, path, ...scopeOf(scope) });
  }

  // Ends the hold, so loading for new scope roots shows again.
  release(cause: string): void {
    if (this.heldScope === null) return;
    const scope = this.heldScope;
    this.heldScope = null;
    this.withheld.clear();
    this.repeats.clear();
    this.log('line', 'sessionLoadingReleased', { cause, ...scopeOf(scope) });
  }

  // Returns the state to publish for one post. A held scope marks a pending state held, so the panel hides the line while the state
  // keeps its own completion. The pending state is logged as withheld.
  present<T extends SessionLoadingStamp>(
    path: SessionLoadingPath,
    stamp: T,
    scope: string,
    blocker: () => SessionLoadingBlocker,
  ): T | (T & { held: true }) {
    if (this.held(scope)) {
      if (stamp.complete) {
        this.publish(false, path, stamp, scope, null);
        return stamp;
      }
      this.withhold(path, stamp, scope, blocker);
      this.publish(false, path, stamp, scope, null);
      return { ...stamp, held: true };
    }
    const visible = !stamp.complete && !stamp.failed;
    this.publish(visible, path, stamp, scope, visible ? blocker : null);
    return stamp;
  }

  // Records a pending state that a held scope keeps off the line. It writes only when the path's reason changes, and it reads a
  // stamp given as a function only for a line it writes.
  withhold(
    path: SessionLoadingPath,
    stamp: SessionLoadingStamp | (() => SessionLoadingStamp),
    scope: string,
    blocker: () => SessionLoadingBlocker,
  ): void {
    const found = blocker();
    if (this.withheld.get(path) === found.reason) {
      this.repeats.set(path, (this.repeats.get(path) ?? 0) + 1);
      return;
    }
    this.withheld.set(path, found.reason);
    const read = typeof stamp === 'function' ? stamp() : stamp;
    this.log('withheld', 'sessionLoadingWithheld', {
      ...this.describe(path, read, scope, found),
      repeats: this.repeats.get(path) ?? 0,
    });
    this.repeats.set(path, 0);
  }

  private publish(
    visible: boolean,
    path: SessionLoadingPath,
    stamp: SessionLoadingStamp,
    scope: string,
    blocker: (() => SessionLoadingBlocker) | null,
  ): void {
    if (visible === this.shown) return;
    this.shown = visible;
    this.log('line', 'sessionLoadingLine', {
      visible,
      ...this.describe(path, stamp, scope, blocker ? blocker() : null),
      ...(this.heldScope !== null ? { held: true } : {}),
    });
  }

  private describe(
    path: SessionLoadingPath,
    stamp: SessionLoadingStamp,
    scope: string,
    found: SessionLoadingBlocker | null,
  ) {
    return {
      generation: stamp.generation,
      path,
      ...scopeOf(scope),
      ...(stamp.known !== undefined ? { completed: stamp.completed ?? 0, known: stamp.known } : {}),
      ...(found ? { reason: found.reason } : {}),
      ...(found?.file ? { file: found.file } : {}),
    };
  }

  private log(budget: LogBudget, event: string, record: Record<string, unknown>): void {
    if (this.written[budget] >= this.limits[budget]) return;
    this.written[budget]++;
    this.write(event, this.written[budget] === this.limits[budget] ? { ...record, limitReached: true } : record);
  }
}

// The number of scope roots and a short hash of their key, so log lines from different scopes stay apart.
function scopeOf(scope: string): { roots: number; scope: string } {
  let roots = 0;
  try {
    const parsed: unknown = JSON.parse(scope);
    if (Array.isArray(parsed)) roots = parsed.length;
  } catch {
    // A key that is not a root list still gets its hash.
  }
  return { roots, scope: createHash('sha256').update(scope).digest('hex').slice(0, 8) };
}
