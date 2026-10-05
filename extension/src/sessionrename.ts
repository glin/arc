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
