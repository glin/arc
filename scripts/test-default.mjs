import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import checks from './typecheck-parallel.js';
import { createTestObservation } from '../extension/test/observations.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function defaultLanes(testRoot = root, npm = process.env.npm_execpath) {
  return ['format:check', 'lint', 'typecheck', 'test:unit'].map((script) => ({
    label: script,
    cwd: testRoot,
    args: [npm, 'run', script],
  }));
}

export async function runLanes(lanes, runChecks = checks.runChecks, observation = null) {
  for (const phase of ['queue', 'build', 'execution', 'cleanup']) {
    observation?.unavailable(
      phase,
      'Delegated commands contain their own intervals. Stage wall times include nested work.',
    );
  }
  let result = null;
  try {
    for (const lane of lanes) {
      const phase = `stage:${lane.label}`;
      observation?.begin(phase, { command: lane.args, cwd: lane.cwd });
      const observed = observation
        ? {
            ...lane,
            env: observation.childEnvironment(),
            observe: (detail) => observation.event(phase, 'child-result', detail),
          }
        : lane;
      const failed = await runChecks([observed], { stream: true });
      observation?.end(phase, { failed: failed.length > 0 });
      if (failed.length) return (result = failed);
    }
    return (result = []);
  } finally {
    observation?.finish({
      exitCode: result ? (result.length ? 1 : 0) : null,
      outcome: result ? (result.length ? 'failure' : 'success') : 'incomplete',
    });
  }
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  process.exitCode = (await runLanes(defaultLanes(), undefined, createTestObservation({ lane: 'default', cwd: root })))
    .length
    ? 1
    : 0;
}
