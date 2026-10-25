import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { suiteLanes } from './test-suite.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function integrationLanes(testRoot = root, browser = false) {
  return [...suiteLanes(testRoot, 'integration'), ...(browser ? suiteLanes(testRoot, 'browser') : [])];
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const { collectSuite } = await import('./test-suite.mjs');
  process.exitCode = (
    await collectSuite({
      mode: 'integration',
      lanes: [
        ...suiteLanes(root, 'integration'),
        ...(process.argv.includes('--browser') ? suiteLanes(root, 'browser') : []),
      ],
    })
  ).exitCode;
}
