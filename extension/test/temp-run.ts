// Vitest global setup for every Vitest config in the repository. It gives each run one
// directory and points TEMP, TMP and TMPDIR at it before any worker starts. Every scratch
// file that a test, a child process or a browser writes to the temporary directory lands
// inside it, and teardown removes it. Every run directory sits in one shared parent. A run
// that dies before its teardown leaves its directory there, and the next run removes it once
// its owner process has exited.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// The machine temporary directory as it was before the run moved TEMP. Files that coordinate
// runs across the machine, such as the browser slots, stay there.
export const MACHINE_TEMP = 'ARC_TEST_MACHINE_TEMP';
// The directory this run moved TEMP to.
export const RUN_TEMP = 'ARC_TEST_RUN_TEMP';
const RUNS = 'arc-test-runs';
const MOVED = ['TEMP', 'TMP', 'TMPDIR', MACHINE_TEMP, RUN_TEMP];

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function unlinkLinks(directory: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  for (const name of names) {
    const entry = path.join(directory, name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(entry);
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    if (stat.isDirectory()) unlinkLinks(entry);
    else if (stat.isSymbolicLink()) {
      try {
        fs.unlinkSync(entry);
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
  }
}

// Removes a directory tree. It removes every symbolic link and junction inside the tree
// first, so the recursive delete that follows never reaches files outside the tree.
export function removeTree(directory: string): void {
  unlinkLinks(directory);
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
}

async function removeAbandoned(runs: string): Promise<void> {
  // Dynamic import because this file compiles as CommonJS and browserchannels.mjs is an ES module.
  const { processExists } = await import('./browserchannels.mjs');
  for (const name of fs.readdirSync(runs)) {
    const owner = /^(\d+)-/.exec(name);
    if (!owner || processExists(Number(owner[1]))) continue;
    try {
      removeTree(path.join(runs, name));
    } catch {
      // A file in the abandoned directory is still open. A later run removes it.
    }
  }
}

export default async function setup(): Promise<() => void> {
  const saved = new Map(MOVED.map((name) => [name, process.env[name]]));
  const machineTemp = process.env[MACHINE_TEMP] || os.tmpdir();
  const runs = path.join(machineTemp, RUNS);
  fs.mkdirSync(runs, { recursive: true });
  await removeAbandoned(runs);
  const runTemp = fs.mkdtempSync(path.join(runs, `${process.pid}-`));
  Object.assign(process.env, {
    TEMP: runTemp,
    TMP: runTemp,
    TMPDIR: runTemp,
    [MACHINE_TEMP]: machineTemp,
    [RUN_TEMP]: runTemp,
  });
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    removeTree(runTemp);
  };
}
