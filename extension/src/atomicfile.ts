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
  if (now - Number(parts[3]) < TEMPORARY_GRACE_MILLISECONDS) {
    return false;
  }
  return !running(Number(parts[2]));
}

function processIsRunning(pid: number): boolean {
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

// Writes synchronously through the rename so writes in this process cannot interleave.
// Other editor windows use separate temporaries. Cleanup retains their temporaries while their processes run.
// `replace` lets a caller supply the rename operation.
// A caller with a shared, populated directory can disable leftover scans. The current temporary still closes with each write.
export function writeFileAtomically(
  target: string,
  text: string,
  replace: (temporary: string, target: string) => void = fs.renameSync,
  mode?: number,
  cleanup = true,
): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Remove leftovers before writing. A previous temporary from this process can have the same name as the new one.
  if (cleanup) removeStaleTemporaries(target);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { encoding: 'utf8', mode });
    replace(temporary, target);
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

function writeAll(descriptor: number, text: string): void {
  const bytes = Buffer.from(text, 'utf8');
  for (let at = 0; at < bytes.length;) {
    at += fs.writeSync(descriptor, bytes, at, bytes.length - at);
  }
}
