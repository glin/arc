// Decides what the session-list loading line publishes, and writes each change of the line to the diagnostics log.
// The line stays hidden for the scope roots that completed it, across later refresh generations. Background work after that
// point keeps running and only writes a log line when its blocking reason changes. Each repository scope decision is logged here too.
import { createHash } from 'node:crypto';
import type { RepositoryScopeDecision } from './repositoryscope';

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

// The most lines one host writes for the loading line, in four budgets. Changes of the line, holds and releases share one budget.
// Withheld background work, blocking reasons of a shown line, and repository scope decisions each have their own, so none of them
// silences a later change of the line. The last allowed line of each says the limit was reached.
export const SESSION_LOADING_LOG_LIMITS = { line: 400, withheld: 400, blocked: 400, scope: 200 };

// The most roots one scope decision names in each of its added, removed, and restored lists. Each list also carries its full count.
const SCOPE_ROOTS_NAMED = 5;

type LogBudget = keyof typeof SESSION_LOADING_LOG_LIMITS;

export class SessionLoadingLine {
  // The scope roots whose completed list holds the line hidden, or null before the first completion.
  private heldScope: string | null = null;
  private heldRoots: Set<string> | null = null;
  // Whether the last published state showed the line. The panel starts with the line hidden.
  private shown = false;
  // The last withheld reason logged for each post path since the line was held.
  private withheld = new Map<SessionLoadingPath, SessionLoadingReason>();
  // Withheld states of each post path since its last withheld line, which its next withheld line reports.
  private repeats = new Map<SessionLoadingPath, number>();
  // The last blocking reason logged for each post path since the line was shown, and the repeats since that path's last line.
  private blocked = new Map<SessionLoadingPath, SessionLoadingReason>();
  private blockedRepeats = new Map<SessionLoadingPath, number>();
  private written: Record<LogBudget, number> = { line: 0, withheld: 0, blocked: 0, scope: 0 };
  private readonly limits: Record<LogBudget, number>;

  constructor(
    private readonly write: (event: string, record: Record<string, unknown>) => void,
    limits: Partial<Record<LogBudget, number>> = {},
  ) {
    this.limits = { ...SESSION_LOADING_LOG_LIMITS, ...limits };
  }

  // Whether the hold covers a scope: the held scope itself, or a scope whose every root the held scope holds. Removing roots needs
  // no new loading, so a smaller scope stays held. A scope with no roots is never held.
  held(scope: string): boolean {
    if (this.heldScope === null) return false;
    if (this.heldScope === scope) return true;
    const roots = rootsOf(scope);
    const heldRoots = this.heldRoots;
    return heldRoots !== null && roots !== null && roots.length > 0 && roots.every((root) => heldRoots.has(root));
  }

  // Holds the line hidden for a scope once its session list completes. A later completion of a scope the hold covers changes nothing,
  // so the held roots stay those of the first completion until a release.
  hold(scope: string, generation: number, path: SessionLoadingPath): void {
    if (this.held(scope)) return;
    this.heldScope = scope;
    const roots = rootsOf(scope);
    this.heldRoots = roots ? new Set(roots) : null;
    this.withheld.clear();
    this.repeats.clear();
    this.log('line', 'sessionLoadingHeld', { generation, path, ...scopeOf(scope) });
  }

  // Ends the hold, so loading for new scope roots shows again.
  release(cause: string): void {
    if (this.heldScope === null) return;
    const scope = this.heldScope;
    this.heldScope = null;
    this.heldRoots = null;
    this.withheld.clear();
    this.repeats.clear();
    this.log('line', 'sessionLoadingReleased', { cause, ...scopeOf(scope) });
  }

  // Keeps the hold for new scope roots that it covers, and releases it when they add a root outside the held scope.
  rescope(scope: string | null, cause: string): void {
    if (this.heldScope === null) return;
    if (scope === null || !this.held(scope)) {
      this.release(cause);
      return;
    }
    const next = scopeOf(scope);
    this.log('line', 'sessionLoadingKept', {
      cause,
      ...scopeOf(this.heldScope),
      nextRoots: next.roots,
      nextScope: next.scope,
    });
  }

  // Records what the repository scope did with one Git answer.
  scopeDecision(decision: RepositoryScopeDecision): void {
    const previous = new Set(decision.previous);
    const answered = new Set(decision.answered);
    const before = scopeOf(JSON.stringify(decision.previous));
    const after = scopeOf(JSON.stringify(decision.applied));
    this.log('scope', 'repositoryScopeDecision', {
      decision: decision.decision,
      oldRoots: before.roots,
      newRoots: after.roots,
      answeredRoots: decision.answered.length,
      ...named(
        'added',
        decision.answered.filter((root) => !previous.has(root)),
      ),
      ...named(
        'removed',
        decision.previous.filter((root) => !answered.has(root)),
      ),
      ...(decision.restored.length ? named('restored', decision.restored) : {}),
      stdoutLength: decision.stdoutLength,
      ...(decision.failed ? { failed: decision.failed } : {}),
      oldScope: before.scope,
      newScope: after.scope,
      answeredScope: scopeOf(JSON.stringify(decision.answered)).scope,
    });
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
    if (stamp.complete || stamp.failed) {
      this.publish(false, path, stamp, scope, null);
      return stamp;
    }
    const found = blocker();
    if (this.shown) this.block(path, stamp, scope, found);
    else this.publish(true, path, stamp, scope, found);
    return stamp;
  }

  // Records the blocking reason of a post that keeps the line shown. It writes only when the path's reason changes, so a line that
  // stays up names what keeps it up without a line for each post.
  private block(
    path: SessionLoadingPath,
    stamp: SessionLoadingStamp,
    scope: string,
    found: SessionLoadingBlocker,
  ): void {
    if (this.blocked.get(path) === found.reason) {
      this.blockedRepeats.set(path, (this.blockedRepeats.get(path) ?? 0) + 1);
      return;
    }
    this.blocked.set(path, found.reason);
    this.log('blocked', 'sessionLoadingBlocked', {
      ...this.describe(path, stamp, scope, found),
      repeats: this.blockedRepeats.get(path) ?? 0,
    });
    this.blockedRepeats.set(path, 0);
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
    found: SessionLoadingBlocker | null,
  ): void {
    if (visible === this.shown) return;
    this.shown = visible;
    this.blocked.clear();
    this.blockedRepeats.clear();
    if (found) this.blocked.set(path, found.reason);
    this.log('line', 'sessionLoadingLine', {
      visible,
      ...this.describe(path, stamp, scope, found),
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

// The roots of a scope key, or null for a key that is not a root list.
function rootsOf(scope: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(scope);
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
}

// The number of scope roots and a short hash of their key, so log lines from different scopes stay apart.
function scopeOf(scope: string): { roots: number; scope: string } {
  return { roots: rootsOf(scope)?.length ?? 0, scope: createHash('sha256').update(scope).digest('hex').slice(0, 8) };
}

// The first roots of a list and its full count.
function named(key: string, roots: string[]): Record<string, unknown> {
  return { [key]: roots.slice(0, SCOPE_ROOTS_NAMED), [key + 'Count']: roots.length };
}
