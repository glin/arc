import fs from 'node:fs';
import * as path from 'node:path';

// A save replaces its target through a uniquely named temporary file.
// Cleanup removes this process's leftover temporaries immediately. Other writers' temporaries require a stopped process and this grace period.
export const TEMPORARY_GRACE_MILLISECONDS = 60_000;
const TEMPORARY_NAME = /^(.+)\.(\d+)\.(\d+)\.tmp$/;

export function temporaryIsStale(
  name: string,
  targetName: string,
  ownPid: number,
  now: number,
  running: (pid: number) => boolean,
): boolean {
  const parts = TEMPORARY_NAME.exec(name);
  if (!parts || parts[1] !== targetName) {
    return false;
  }
  if (Number(parts[2]) === ownPid) {
    return true;
  }
  return temporaryWriterGone(Number(parts[2]), Number(parts[3]), now, running);
}

// A temporary of another writer is stale once the grace period passed and its process stopped.
export function temporaryWriterGone(
  pid: number,
  writtenAt: number,
  now: number,
  running: (pid: number) => boolean,
): boolean {
  if (now - writtenAt < TEMPORARY_GRACE_MILLISECONDS) {
    return false;
  }
  return !running(pid);
}

export function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM indicates an existing process that this process cannot signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function removeStaleTemporaries(target: string): void {
  const directory = path.dirname(target);
  const targetName = path.basename(target);
  const now = Date.now();
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names) {
    if (!temporaryIsStale(name, targetName, process.pid, now, processIsRunning)) {
      continue;
    }
    try {
      fs.unlinkSync(path.join(directory, name));
    } catch {
      // Leave a temporary that cannot be removed.
    }
  }
}

export interface ReplacementPolicy {
  windowMs?: number;
  now?: () => number;
  pause?: (milliseconds: number) => void;
}

// Retry only replacement and reuse the same temporary file between attempts.
// Callers that hold a write lock retain it during retries.
export function retryingReplace({
  windowMs = 2000,
  now = () => performance.now(),
  pause = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds),
}: ReplacementPolicy = {}): (temporary: string, target: string) => void {
  return (temporary, target) => {
    const deadline = now() + windowMs;
    let delay = 10;
    while (true) {
      try {
        fs.renameSync(temporary, target);
        return;
      } catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException)?.code ?? '')) throw error;
        const remaining = deadline - now();
        if (remaining <= 0) throw error;
        pause(Math.min(delay, remaining));
        delay = Math.min(100, delay * 2);
      }
    }
  };
}

// Writes synchronously through the rename so writes in this process cannot interleave.
// Other editor windows use separate temporaries. Cleanup retains their temporaries while their processes run.
// `replace` lets a caller supply the rename operation.
// A caller with a shared, populated directory can disable leftover scans. The current temporary still closes with each write.
// `writerToken` replaces the process ID in the temporary name, so a caller with several writers in one process can tell
// its own temporaries from another writer's. Leftover scans do not recognize such a name.
// `flush` syncs the temporary before the rename and the directory after it, for a file whose readers delete its sources.
export function writeFileAtomically(
  target: string,
  text: string,
  replace: (temporary: string, target: string) => void = fs.renameSync,
  mode?: number,
  cleanup = true,
  writerToken?: string,
  flush = false,
): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Remove leftovers before writing. A previous temporary from this process can have the same name as the new one.
  if (cleanup) removeStaleTemporaries(target);
  const temporary = `${target}.${writerToken ?? process.pid}.${Date.now()}.tmp`;
  try {
    if (flush) {
      const descriptor = fs.openSync(temporary, 'w', mode);
      try {
        writeAll(descriptor, text);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
    } else {
      fs.writeFileSync(temporary, text, { encoding: 'utf8', mode });
    }
    replace(temporary, target);
    if (flush) syncDirectory(path.dirname(target));
  } finally {
    // The rename takes the temporary when it succeeds. This removes what a failure left.
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The temporary is absent or cannot be removed.
    }
  }
}

// A streamed write holds at most this many UTF-16 code units before it writes them, so one write
// holds at most 192 KiB of UTF-8.
export const STREAMED_WRITE_UNITS = 64 * 1024;

// Writes the text that `produce` passes to `write`, in order, with the replacement rules of
// `writeFileAtomically`. The whole text never exists as one string: pieces collect into batches of
// at most `STREAMED_WRITE_UNITS` code units, and a longer piece is written in slices of at most
// that size.
export function writeFileStreamAtomically(
  target: string,
  produce: (write: (text: string) => void) => void,
  replace: (temporary: string, target: string) => void = fs.renameSync,
  mode?: number,
  cleanup = true,
): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (cleanup) removeStaleTemporaries(target);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    const descriptor = fs.openSync(temporary, 'w', mode);
    try {
      let batch: string[] = [];
      let units = 0;
      const flush = () => {
        if (units === 0) return;
        writeAll(descriptor, batch.length === 1 ? batch[0] : batch.join(''));
        batch = [];
        units = 0;
      };
      produce((text) => {
        if (units + text.length > STREAMED_WRITE_UNITS) flush();
        if (text.length <= STREAMED_WRITE_UNITS) {
          batch.push(text);
          units += text.length;
          return;
        }
        for (let start = 0; start < text.length;) {
          let end = Math.min(text.length, start + STREAMED_WRITE_UNITS);
          // A slice never ends between the two halves of a surrogate pair.
          const last = text.charCodeAt(end - 1);
          if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
          writeAll(descriptor, text.slice(start, end));
          start = end;
        }
      });
      flush();
    } finally {
      fs.closeSync(descriptor);
    }
    replace(temporary, target);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The temporary is absent or cannot be removed.
    }
  }
}

// Windows has no directory sync, so a directory that cannot be synced stays as the rename left it.
function syncDirectory(directory: string): void {
  try {
    const descriptor = fs.openSync(directory, 'r');
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    // The rename stays durable as far as this platform allows.
  }
}

function writeAll(descriptor: number, text: string): void {
  const bytes = Buffer.from(text, 'utf8');
  for (let at = 0; at < bytes.length;) {
    at += fs.writeSync(descriptor, bytes, at, bytes.length - at);
  }
}
