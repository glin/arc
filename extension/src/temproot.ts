// Test scratch directory helpers.
// Scratch directories normally stay beneath the suite root and leave with the run.
// Private socket directories use an explicit root and local cleanup after their listeners settle.
import { afterAll } from 'vitest';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { removeTree } from '../test/temp-run.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-test-'));

afterAll(() => removeTree(root));

export interface TempDirectoryFiles {
  mkdtempSync: (prefix: string) => string;
  lstatSync: (directory: string) => Pick<fs.Stats, 'dev' | 'ino' | 'isDirectory' | 'isSymbolicLink'>;
  chmodSync: (directory: string, mode: number) => void;
  rmdirSync: (directory: string) => void;
}

// Returns a fresh directory. Explicit roots require local cleanup ownership.
export function tempDir(
  prefix: string,
  privateDirectory?: { root: string; cleanup: (() => unknown)[]; files?: TempDirectoryFiles },
): string {
  if (!privateDirectory) return fs.mkdtempSync(path.join(root, prefix));
  const files = privateDirectory.files ?? fs;
  const directory = files.mkdtempSync(path.posix.join(privateDirectory.root, prefix));
  let identity: ReturnType<typeof files.lstatSync> | undefined;
  privateDirectory.cleanup.push(() => {
    const current = files.lstatSync(directory);
    assert.ok(
      identity &&
        current.isDirectory() &&
        !current.isSymbolicLink() &&
        current.dev === identity.dev &&
        current.ino === identity.ino,
      `Private temporary directory ownership changed: ${directory}`,
    );
    // Server closure removes its socket. An occupied directory remains intact.
    files.rmdirSync(directory);
  });
  identity = files.lstatSync(directory);
  assert.ok(identity.isDirectory() && !identity.isSymbolicLink(), 'Private temporary allocation is not a directory');
  files.chmodSync(directory, 0o700);
  return directory;
}
