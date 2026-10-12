// Ordered panel filter assignments retain their save barrier after an uncertain outcome.
export const FILTER_LIMITS = { transportMs: 35_000, operationMs: 30_000, readyMs: 15_000, persistMs: 10_000 } as const;
export interface FilterContext {
  deadline: number;
  signal: AbortSignal;
}
export interface FilterOperation {
  context: FilterContext;
  current(): boolean;
  cancel(): void;
  panelApplied(): boolean;
}
export class SessionFilterRequests {
  private tail: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private readonly cancellations = new Set<() => void>();
  reset(work: () => Promise<void>): Promise<void> {
    for (const cancel of this.cancellations) cancel();
    const reset = this.tail.then(work, work);
    this.tail = reset.catch(() => {});
    return reset;
  }
  run(
    context: FilterContext,
    ready: (operation: FilterOperation) => Promise<void>,
    apply: (operation: FilterOperation) => Promise<void>,
  ): Promise<unknown> {
    let attempted = false;
    let finished = false;
    let expired = false;
    let deadline = context.deadline;
    let complete!: (result: unknown) => void;
    let releaseCancelled!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      releaseCancelled = resolve;
    });
    const result = new Promise((resolve) => {
      complete = resolve;
    });
    const settle = (status: string, reason?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      context.signal.removeEventListener('abort', cancelled);
      this.cancellations.delete(cancelled);
      complete({ version: 1, status, ...(reason ? { reason } : {}) });
    };
    const cancelled = () => {
      expired = true;
      releaseCancelled();
      settle(
        attempted ? 'unknown' : 'failed',
        attempted ? 'The filter outcome is unknown. Read the panel before retrying.' : 'The filter was not applied.',
      );
    };
    let timer = setTimeout(cancelled, Math.max(0, context.deadline - Date.now()));
    context.signal.addEventListener('abort', cancelled, { once: true });
    this.cancellations.add(cancelled);
    const current = () => !expired && !this.disposed && !context.signal.aborted && Date.now() < deadline;
    const operation: FilterOperation = {
      context,
      current,
      cancel: cancelled,
      panelApplied: () => {
        if (!current()) return false;
        deadline = Math.min(context.deadline, Date.now() + FILTER_LIMITS.persistMs);
        clearTimeout(timer);
        timer = setTimeout(cancelled, Math.max(0, deadline - Date.now()));
        return true;
      },
    };
    const execute = async () => {
      if (!current()) {
        cancelled();
        return;
      }
      let readyTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Cancellation releases readiness. Application waits keep their storage settlement barrier.
        await Promise.race([
          ready(operation),
          cancellation,
          new Promise<never>((_, reject) => {
            readyTimer = setTimeout(
              () => reject(new Error('The panel did not become ready.')),
              Math.max(0, Math.min(FILTER_LIMITS.readyMs, context.deadline - Date.now())),
            );
          }),
        ]);
        clearTimeout(readyTimer);
        if (!current()) {
          cancelled();
          return;
        }
        attempted = true;
        await apply(operation);
        if (current()) settle('applied');
        else cancelled();
      } catch (error) {
        if (!current()) cancelled();
        else settle('failed', error instanceof Error ? error.message : 'The filter was not applied.');
      } finally {
        clearTimeout(readyTimer);
      }
    };
    this.tail = this.tail.then(execute, execute);
    return result;
  }
  dispose(): void {
    this.disposed = true;
    for (const cancel of this.cancellations) cancel();
  }
}
