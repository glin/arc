// Test scratch directory helpers.
// Test-only scratch directories. Every directory sits under one root per test file, and the
// file removes its root when its suite ends. The root sits in the run directory that
// extension/test/temp-run.ts creates, so a worker that dies first leaves its root for the
// run teardown to remove.
import { afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { removeTree } from '../test/temp-run.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-test-'));

afterAll(() => removeTree(root));

// Returns a fresh directory named after the prefix its caller passes.
export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(root, prefix));
}
