import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { suiteLanes } from './test-suite.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function unitLanes(testRoot = root) {
  return suiteLanes(testRoot, 'unit');
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const { collectSuite } = await import('./test-suite.mjs');
  process.exitCode = (await collectSuite({ mode: 'unit' })).exitCode;
}
