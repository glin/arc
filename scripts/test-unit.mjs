import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLanes } from './test-default.mjs';
import { createTestObservation } from '../extension/test/observations.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function unitLanes(testRoot = root) {
  const vitest = (directory) => join(testRoot, directory, 'node_modules/vitest/vitest.mjs');
  return [
    {
      label: 'root units',
      cwd: testRoot,
      args: [vitest(''), 'run', '--exclude', 'test/hooks-smoke.test.js', '--tags-filter=!subprocess'],
    },
    {
      label: 'extension units',
      cwd: testRoot,
      args: [join(testRoot, 'extension/test.mjs'), 'node', '--tags-filter=!subprocess'],
    },
    {
      label: 'CLI units',
      cwd: join(testRoot, 'cli'),
      args: [vitest('cli'), 'run', '--tags-filter=!subprocess', '--exclude', 'test/smoke.bundled-*.test.mjs'],
    },
  ];
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  process.exitCode = (await runLanes(unitLanes(), undefined, createTestObservation({ lane: 'units', cwd: root })))
    .length
    ? 1
    : 0;
}
