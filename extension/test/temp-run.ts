// Vitest global setup gives each run a temporary directory before workers start.
// TEMP, TMP, and TMPDIR point to it until teardown restores them and removes the directory.
// The next run retries cleanup of abandoned directories whose owner processes have exited.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Environment key for the machine temporary directory. Cross-run coordination files stay there.
export const MACHINE_TEMP = 'ARC_TEST_MACHINE_TEMP';
// Environment key for this run's temporary directory.
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

// Unlink symbolic links and junctions before deleting the directory tree.
// Their targets remain outside the deletion.
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
      // Retry failed abandoned-directory cleanup on a later run.
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
