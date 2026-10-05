import * as fs from 'node:fs';
import * as path from 'node:path';

// A save writes a uniquely named temporary and renames it over the target, so a reader never
// sees a half-written file. A failure between the two leaves the temporary behind, and a hard
// kill leaves one that no `finally` will ever reach. A later save removes one only when it can
// say that the writer is gone: the name carries this process's own id, or it names a process
// that is no longer running and it is older than the grace period.
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
    // A process this one may not signal still exists.
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
      /* another writer took it first */
    }
  }
}

// A write runs to its rename without yielding, so two writes in this process cannot interleave.
// Two editor windows on one store can still write at the same moment. Each writes its own
// temporary and renames it, and the sweep leaves the other window's temporary alone while that
// window is running. `replace` is the seam the tests use to fail the rename.
export function writeFileAtomically(
  target: string,
  text: string,
  replace: (temporary: string, target: string) => void = fs.renameSync,
): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // The sweep runs before the write, because a leftover of this process can carry the name this
  // write is about to take. Sweeping afterwards would remove the file this write just made.
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
      /* the rename already took it */
    }
  }
}
