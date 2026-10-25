import checks from './typecheck-parallel.js';

export async function runLanes(lanes, runChecks = checks.runChecks, observation = null, options = {}) {
  for (const phase of ['queue', 'build', 'execution', 'cleanup']) {
    observation?.unavailable(
      phase,
      'Delegated commands contain their own intervals. Stage wall times include nested work.',
    );
  }
  let result = null;
  const failedLabels = [];
  try {
    for (const lane of lanes) {
      if (options.signal?.aborted) {
        failedLabels.push(lane.label);
        options.onCancelled?.(lane);
        continue;
      }
      const phase = `stage:${lane.label}`;
      observation?.begin(phase, { command: lane.args, cwd: lane.cwd });
      const observed = observation
        ? {
            ...lane,
            env: { ...observation.childEnvironment(), ...lane.env },
            observe: (detail) => observation.event(phase, 'child-result', detail),
          }
        : lane;
      const failed = await runChecks([observed], { ...options, stream: true });
      observation?.end(phase, { failed: failed.length > 0 });
      failedLabels.push(...failed);
    }
    return (result = failedLabels);
  } finally {
    observation?.finish({
      exitCode: result ? (result.length ? 1 : 0) : null,
      outcome: result ? (result.length ? 'failure' : 'success') : 'incomplete',
    });
  }
}
