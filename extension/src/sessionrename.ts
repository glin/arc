import { cleanName } from './domain/text.ts';

// Session names are cleaned once before either provider call.
// This limit caps the cleaned value sent to the provider.
export const SESSION_NAME_LIMIT = 200;

// The name to send, or null when nothing visible remains. A null answer sends nothing,
// because neither agent names a session from an empty name.
export function sessionRenameTitle(raw: unknown): string | null {
  return cleanName(raw, SESSION_NAME_LIMIT) || null;
}

export interface SessionRenameResult {
  title: string;
  error: string;
}

const NOT_RENAMED = 'The session was not renamed.';

// The message that opens the panel's rename editor. It carries the full name, not the
// shorter one the grouping heading over several sessions draws, so the reader edits the
// name the agent saved.
export function sessionRenameOpening(
  session: string,
  named: { label: string; fullLabel: string },
): {
  type: 'openSessionRename';
  session: string;
  title: string;
} {
  return { type: 'openSessionRename', session, title: named.fullLabel };
}

// Answer every panel rename request. The editor remains read-only until an answer arrives.
// Return its request id so an editor awaiting a later rename of the same session ignores this answer.
export async function answerSessionRename(
  ask: { session: string; request: number; title: string },
  rename: () => Promise<SessionRenameResult>,
  send: (message: {
    type: 'sessionRenameResult';
    session: string;
    request: number;
    title: string;
    error: string;
  }) => unknown,
): Promise<void> {
  let result: SessionRenameResult;
  try {
    result = await rename();
  } catch {
    result = { title: ask.title, error: NOT_RENAMED };
  }
  await send({ type: 'sessionRenameResult', session: ask.session, request: ask.request, ...result });
}

// One rename request from the panel. A failure answers the text the reader typed, so the
// editor keeps it. Success answers the cleaned name the provider saved.
export async function requestSessionRename(
  rawTitle: string,
  persisted: boolean,
  rename: (title: string) => Promise<void>,
): Promise<SessionRenameResult> {
  const title = sessionRenameTitle(rawTitle);
  if (!title) {
    return { title: rawTitle, error: 'Enter a name.' };
  }
  if (!persisted) {
    return { title: rawTitle, error: 'This session is no longer available.' };
  }
  try {
    await rename(title);
    return { title, error: '' };
  } catch (error) {
    return { title: rawTitle, error: (error as Error).message || NOT_RENAMED };
  }
}

export const CLAUDE_RENAME_CHECKS = 6;
export const CLAUDE_RENAME_CHECK_MS = 50;

// Claude Code can report success without saving a rename. Confirmation requires the saved
// title file to hold the requested name within a fixed number of checks.
export async function confirmClaudeRename(
  requested: string,
  readTitle: () => string | null,
  options: { attempts?: number; pause?: () => Promise<void> } = {},
): Promise<void> {
  const attempts = options.attempts ?? CLAUDE_RENAME_CHECKS;
  const pause = options.pause ?? (() => new Promise<void>((resolve) => setTimeout(resolve, CLAUDE_RENAME_CHECK_MS)));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (readTitle() === requested) {
      return;
    }
    if (attempt + 1 < attempts) {
      await pause();
    }
  }
  throw new Error('Claude Code did not save the new session name.');
}

export function emptyCodexRollout(error: unknown, sessionId: string): boolean {
  const message = error instanceof Error ? error.message : '';
  return (
    message.startsWith('failed to set thread name:') &&
    message.includes(`failed to update thread metadata ${sessionId}:`) &&
    message.includes(': rollout at ') &&
    message.endsWith(`-${sessionId}.jsonl is empty`)
  );
}

export interface InitialSessionName {
  provider: 'codex';
  session: string;
  activation: string;
  cwd: string;
  requested: string;
  revision: string;
  state: 'pending' | 'saved' | 'failed' | 'cancelled' | 'uncertain';
  attempts: number;
  possibleWrite: boolean;
  error?: string;
}

export interface InitialNameReadiness {
  evidence: string;
  source: string;
  title?: string;
  current: boolean;
}

export interface InitialNameSubscription {
  current(): InitialNameReadiness;
  dispose(): void;
}

export class InitialNameCancelled extends Error {
  constructor() {
    super('The initial session name was cancelled.');
  }
}

export class SessionNameUncertain extends Error {}

export function normalizeInitialSessionNames(raw: unknown, limit: number): Record<string, InitialSessionName> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const entries: [string, InitialSessionName][] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue;
    const item = value as InitialSessionName;
    if (
      item.provider !== 'codex' ||
      key !== item.session ||
      !['activation', 'cwd', 'revision'].every(
        (field) =>
          typeof item[field as keyof InitialSessionName] === 'string' && item[field as keyof InitialSessionName],
      ) ||
      !sessionRenameTitle(item.requested) ||
      item.requested !== sessionRenameTitle(item.requested) ||
      !['pending', 'saved', 'failed', 'cancelled', 'uncertain'].includes(item.state) ||
      !Number.isInteger(item.attempts) ||
      item.attempts < 0 ||
      item.attempts > 40 ||
      typeof item.possibleWrite !== 'boolean'
    )
      continue;
    entries.push([
      key,
      {
        provider: 'codex',
        session: key,
        activation: item.activation,
        cwd: item.cwd,
        requested: item.requested,
        revision: item.revision,
        state: item.state,
        attempts: item.attempts,
        possibleWrite: item.possibleWrite,
        ...(typeof item.error === 'string' ? { error: item.error.slice(0, 4096) } : {}),
      },
    ]);
  }
  return Object.fromEntries(entries.slice(-limit));
}

// A saved possible write survives loss of the activation without granting another write.
export function restoreInitialSessionNames(book: Record<string, InitialSessionName>): void {
  for (const item of Object.values(book)) {
    if (item.state === 'pending') item.state = item.possibleWrite ? 'uncertain' : 'cancelled';
  }
}

// One activation owns each operation. Readiness changes never duplicate an in-flight request.
export class InitialNameOperation {
  private subscription: InitialNameSubscription | null = null;
  private running = false;
  private stopped = false;
  private evidence = '';
  private source = '';
  private first = true;

  constructor(
    private readonly read: () => InitialSessionName,
    private readonly persist: () => Promise<void>,
    private readonly valid: () => boolean,
    private readonly rename: (current: () => boolean) => Promise<void>,
  ) {}

  start(subscribe: (wake: () => void) => InitialNameSubscription): void {
    this.subscription = subscribe(() => {
      void this.wake();
    });
    void this.wake();
  }

  cancel(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.subscription?.dispose();
    const item = this.read();
    if (item.state === 'pending') {
      item.state = item.possibleWrite ? 'uncertain' : 'cancelled';
      void this.persist().catch(() => {});
    }
  }

  changed(): void {
    if (!this.current()) this.cancel();
    else void this.wake();
  }

  private current = (): boolean =>
    !this.stopped &&
    this.valid() &&
    this.read().state === 'pending' &&
    (!this.subscription ||
      (this.subscription.current().current && (!this.source || this.subscription.current().source === this.source)));

  private writable = (): boolean => this.current() && !this.subscription?.current().title;

  private async finishUnsent(): Promise<void> {
    const item = this.read();
    item.possibleWrite = false;
    const saved = this.current() && this.subscription?.current().title === item.requested;
    await this.finish(saved ? 'saved' : 'cancelled');
  }

  private async finish(state: InitialSessionName['state'], error?: string): Promise<void> {
    const item = this.read();
    item.state = state;
    if (error) item.error = error;
    this.stopped = true;
    this.subscription?.dispose();
    await this.persist();
  }

  private async wake(): Promise<void> {
    if (this.running || this.stopped || !this.subscription) return;
    this.running = true;
    try {
      while (this.current()) {
        const ready = this.subscription.current();
        if (!ready.current || (this.source && ready.source !== this.source)) {
          this.cancel();
          return;
        }
        if (ready.source) this.source = ready.source;
        const item = this.read();
        if (ready.title) {
          await this.finish(ready.title === item.requested ? 'saved' : 'cancelled');
          return;
        }
        if (item.attempts >= 40) {
          await this.finish('failed', 'Codex did not save the initial session name.');
          return;
        }
        if (!this.first && (!ready.evidence || ready.evidence === this.evidence)) return;
        this.first = false;
        this.evidence = ready.evidence;
        item.attempts++;
        item.possibleWrite = true;
        await this.persist();
        if (!this.writable()) {
          await this.finishUnsent();
          return;
        }
        try {
          await this.rename(this.writable);
        } catch (error) {
          if (error instanceof InitialNameCancelled) {
            await this.finishUnsent();
            return;
          }
          if (emptyCodexRollout(error, item.session)) {
            this.read().possibleWrite = false;
            await this.persist();
            if (!this.current()) {
              await this.finish('cancelled');
              return;
            }
            continue;
          }
          const message = error instanceof Error ? error.message : String(error);
          // Lost control replies leave the saved-name outcome unknown.
          await this.finish(
            error instanceof SessionNameUncertain ||
              /timeout|timed out|did not answer|closed|stopped|disconnected|exit/i.test(message)
              ? 'uncertain'
              : 'failed',
            message,
          );
          return;
        }
        this.read().possibleWrite = false;
        await this.finish(this.current() ? 'saved' : 'cancelled');
        return;
      }
      this.cancel();
    } catch {
      const item = this.read();
      item.state = 'uncertain';
      this.stopped = true;
      this.subscription?.dispose();
    } finally {
      this.running = false;
    }
  }
}
