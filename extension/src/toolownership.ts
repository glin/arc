import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export function canonicalToolPath(value: string, platform = process.platform): string {
  let current = path.resolve(value);
  const tail: string[] = [];
  for (;;) {
    try {
      current = path.join(fs.realpathSync.native(current), ...tail.reverse());
      return platform === 'win32' ? current.toLowerCase() : current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

// Existing redirects never establish permission to write through their targets.
export function admitToolPath(value: string): string {
  if (!path.isAbsolute(value)) throw new Error('Arc setup needs an absolute installation folder.');
  for (let folder = path.normalize(value); ; folder = path.dirname(folder)) {
    try {
      const stat = fs.lstatSync(folder);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error(`Arc setup cannot use the redirected or non-directory folder ${folder}.`);
      if (process.platform !== 'win32' && stat.uid !== process.getuid?.() && folder === value)
        throw new Error(`Arc setup cannot write to another user's folder ${folder}.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (path.dirname(folder) === folder) break;
  }
  return canonicalToolPath(value);
}

export function acquireToolLock(
  file: string,
  purpose?: 'collection',
): { file: string; token: string; release(): void } {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = randomUUID();
  const owner = JSON.stringify(purpose ? { token, pid: process.pid, purpose } : { token, pid: process.pid });
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(
        `Another Arc setup owns ${file}. Close its processes before resolving retained ownership manually.`,
        {
          cause: error,
        },
      );
    throw error;
  }
  try {
    fs.writeFileSync(fd, owner);
  } finally {
    fs.closeSync(fd);
  }
  return {
    file,
    token,
    release: () => {
      try {
        if (fs.readFileSync(file, 'utf8') === owner) fs.unlinkSync(file);
      } catch {
        /* Preserve uncertain ownership. */
      }
    },
  };
}

export function waitForToolLock(file: string, signal: AbortSignal): Promise<ReturnType<typeof acquireToolLock>>;
export function waitForToolLock(
  file: string,
  signal: AbortSignal,
  ready: () => string | undefined,
): Promise<ReturnType<typeof acquireToolLock> | string>;
export function waitForToolLock(
  file: string,
  signal: AbortSignal,
  ready?: () => string | undefined,
): Promise<ReturnType<typeof acquireToolLock> | string> {
  return new Promise((resolve, reject) => {
    let watcher: fs.FSWatcher | undefined;
    let retry: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (error?: unknown, result?: ReturnType<typeof acquireToolLock> | string) => {
      if (settled) return;
      settled = true;
      watcher?.close();
      clearInterval(retry);
      clearTimeout(deadline);
      signal.removeEventListener('abort', canceled);
      if (result) resolve(result);
      else reject(error);
    };
    const canceled = () => finish(new Error('Arc setup was canceled.'));
    const attempt = () => {
      if (settled) return;
      if (signal.aborted) return canceled();
      try {
        const directory = ready?.();
        if (directory) return finish(undefined, directory);
      } catch (error) {
        return finish(error);
      }
      try {
        finish(undefined, acquireToolLock(file));
      } catch (error) {
        if ((error as Error & { cause?: NodeJS.ErrnoException }).cause?.code !== 'EEXIST') return finish(error);
        if (removeAbandonedCollectionLock(file)) attempt();
      }
    };
    signal.addEventListener('abort', canceled, { once: true });
    attempt();
    if (settled) return;
    retry = setInterval(attempt, 250);
    deadline = setTimeout(
      () =>
        finish(
          new Error(
            `Arc cannot prepare its commands while ${file} remains owned. Close related Claude processes before resolving ownership manually.`,
          ),
        ),
      30_000,
    );
    try {
      watcher = fs.watch(path.dirname(file), attempt);
      watcher.on('error', () => watcher?.close());
      attempt();
    } catch {
      // Condition checks continue when filesystem notifications are unavailable.
    }
  });
}

function processGone(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

// Returns the lock owner, or undefined while the lock is absent or its owner is not yet written.
function toolLockOwner(
  file: string,
): { text: string; owner: { pid?: unknown; purpose?: unknown; token?: unknown } } | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const owner = JSON.parse(text) as unknown;
    return owner && typeof owner === 'object' ? { text, owner } : undefined;
  } catch {
    return undefined;
  }
}

const LOCK_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Collection never retains ownership, so a collection lock whose process ended has no holder.
// A marker named for the dead owner's token admits one recovery at a time. The holder rereads the lock after it creates
// the marker, so a recovery that follows another one finds the new lock and leaves it.
export function removeAbandonedCollectionLock(file: string): boolean {
  let marker: string | undefined;
  try {
    const held = toolLockOwner(file);
    if (held?.owner.purpose !== 'collection' || !processGone(held.owner.pid)) return false;
    const token = held.owner.token;
    if (typeof token !== 'string' || !LOCK_TOKEN.test(token)) return false;
    fs.closeSync(fs.openSync(`${file}.${token}.recovering`, 'wx', 0o600));
    marker = `${file}.${token}.recovering`;
    if (fs.readFileSync(file, 'utf8') !== held.text) return false;
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  } finally {
    try {
      if (marker) fs.unlinkSync(marker);
    } catch {
      // A marker that remains admits no recovery of a lock that no longer exists.
    }
  }
}

// Release collection holds the lock briefly, so setup waits for it and still refuses any other owner at once.
// A lock without a written owner is waited for, because its creator writes the owner right after it creates the file.
export async function acquireToolLockAfterCollection(
  file: string,
  signal: AbortSignal,
): Promise<ReturnType<typeof acquireToolLock>> {
  let refusal: Error;
  try {
    return acquireToolLock(file);
  } catch (error) {
    if ((error as Error & { cause?: NodeJS.ErrnoException }).cause?.code !== 'EEXIST') throw error;
    refusal = error as Error;
  }
  // A complete owner other than collection, or an unreadable lock, refuses setup at once.
  const refuse = () => {
    let held: ReturnType<typeof toolLockOwner>;
    try {
      held = toolLockOwner(file);
    } catch {
      throw refusal;
    }
    if (held !== undefined && held.owner.purpose !== 'collection') throw refusal;
    return undefined;
  };
  refuse();
  const result = await waitForToolLock(file, signal, refuse);
  return result as ReturnType<typeof acquireToolLock>;
}

export function retainedToolOwnership(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error);
    if ('retainOwnership' in error && error.retainOwnership === true) return true;
    error = 'cause' in error ? error.cause : undefined;
  }
  return false;
}
