import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import checks from './typecheck-parallel.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function defaultLanes(testRoot = root, npm = process.env.npm_execpath) {
  return ['format:check', 'lint', 'typecheck', 'test:unit'].map((script) => ({
    label: script,
    cwd: testRoot,
    args: [npm, 'run', script],
  }));
}

export async function runLanes(lanes, runChecks = checks.runChecks) {
  for (const lane of lanes) {
    const failed = await runChecks([lane], { stream: true });
    if (failed.length) return failed;
  }
  return [];
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  process.exitCode = (await runLanes(defaultLanes())).length ? 1 : 0;
}
