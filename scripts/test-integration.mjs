import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLanes } from './test-default.mjs';
import { createTestObservation } from '../extension/test/observations.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function integrationLanes(testRoot = root, browser = false, npm = process.env.npm_execpath) {
  const lane = (label, args) => ({ label, cwd: testRoot, args: [npm, ...args] });
  return [
    lane('root subprocess', ['run', 'test:subprocess']),
    lane('extension integration', ['--prefix', 'extension', 'run', 'test:integration']),
    lane('panel mockup', ['run', 'test:panel-mockup']),
    lane('hook and CLI smoke', ['run', 'test:smoke']),
    ...(browser ? [lane('browser', ['run', 'test:browser'])] : []),
  ];
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  process.exitCode = (
    await runLanes(
      integrationLanes(root, process.argv.includes('--browser')),
      undefined,
      createTestObservation({ lane: 'integration', cwd: root }),
    )
  ).length
    ? 1
    : 0;
}
