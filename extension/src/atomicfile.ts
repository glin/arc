import * as fs from 'node:fs';
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
export function writeFileAtomically(
  target: string,
  text: string,
  replace: (temporary: string, target: string) => void = fs.renameSync,
): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Remove leftovers before writing. A previous temporary from this process can have the same name as the new one.
  removeStaleTemporaries(target);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, 'utf8');
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
