import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
export { runLanes } from './test-lanes.mjs';
import { suiteLanes } from './test-suite.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function defaultLanes(testRoot = root) {
  return suiteLanes(testRoot, 'default');
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const { collectSuite } = await import('./test-suite.mjs');
  process.exitCode = (await collectSuite({ mode: 'default' })).exitCode;
}
