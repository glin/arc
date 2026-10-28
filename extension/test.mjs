import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchAnyBrowser } from './test/browserchannels.mjs';
import { acquireBrowserLock, forwardSignalToChildAndRelease } from './test/browserlock.mjs';
import {
  clampWorkerArgs,
  clampWorkerEnvironment,
  hasWorkerFlag,
  holdMachineLoad,
  MachineLoadTimeout,
  MAX_VITEST_WORKERS,
} from './test/machineload.mjs';
import { createTestObservation } from './test/observations.mjs';

// Default injected runners acquire no machine lock. The CLI entry point supplies the real acquireBrowserLock.
async function noopAcquireLock() {
  return { release: () => true };
}

const root = dirname(fileURLToPath(import.meta.url));
const modes = new Set(['full', 'node', 'browser']);
// Cap lane workers explicitly instead of using Vitest's core-count default.
// VITEST_MAX_WORKERS and a caller's --maxWorkers can lower a lane below the cap, never raise it above.
function laneWorkers() {
  return Math.min(MAX_VITEST_WORKERS, Number.parseInt(process.env.VITEST_MAX_WORKERS) || MAX_VITEST_WORKERS);
}

// Spawn options keep inheriting the parent environment unless the observation or the worker cap changes it.
function childEnvironment(observation) {
  const env = clampWorkerEnvironment(observation?.childEnvironment() ?? process.env);
  return env === process.env ? {} : { env };
}

// Vitest flags with required values. The installed cliOptionsConfig marks required arguments with angle brackets.
// The runner keeps separate following tokens out of optional-value flags.
// scripts/extension-test-runner.test.js compares this set with the installed table.
export const VALUE_FLAGS = new Set([
  '--root',
  '-r',
  '--config',
  '-c',
  '--testNamePattern',
  '-t',
  '--dir',
  '--reporters',
  '--reporter',
  '--outputFile',
  '--mode',
  '--pool',
  '--execArgv',
  '--vmMemoryLimit',
  '--maxWorkers',
  '--environment',
  '--shard',
  '--sequence',
  '--testTimeout',
  '--hookTimeout',
  '--bail',
  '--retry',
  '--diff',
  '--exclude',
  '--browser',
  '--project',
  '--slowTestThreshold',
  '--teardownTimeout',
  '--maxConcurrency',
  '--attachmentsDir',
  '--configLoader',
  '--tagsFilter',
  '--experimental',
]);

export function discoverTestFiles(directory, relativeTo = root) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...discoverTestFiles(file, relativeTo));
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      files.push(relative(relativeTo, file).split(sep).join('/'));
    }
  }
  return files.sort();
}

export function isBrowserTest(file) {
  if (file.endsWith('.browser.test.ts')) return true;
  const segments = file.split('/').pop().split('.');
  return segments.includes('layout') && file.endsWith('.test.ts');
}

export function selectTestFiles(files, mode) {
  if (!modes.has(mode)) {
    throw new Error(`Unknown test mode "${mode}". Expected full, node, or browser.`);
  }
  return mode === 'node'
    ? files.filter((file) => !isBrowserTest(file))
    : mode === 'browser'
      ? files.filter(isBrowserTest)
      : files;
}

function laneLabel(mode) {
  return mode === 'node' ? 'Node' : 'Browser';
}

// Select the full lane file list before applying requested filenames.
function selectForLane(mode, testRoot) {
  return selectTestFiles(discoverTestFiles(join(testRoot, 'src'), testRoot), mode);
}

// Report the selected file count after named-file filtering, including runs that skip Vitest.
function reportSelection(mode, selected) {
  console.log(`${laneLabel(mode)} lane: ${selected.length} file${selected.length === 1 ? '' : 's'} selected`);
}

// Separate requested files from Vitest flags. Required-value flags consume the next token only when it does not start with a hyphen.
// Other flags leave the next token for file selection.
function partitionArgs(args) {
  const passthrough = [];
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('-')) {
      passthrough.push(arg);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('-') && VALUE_FLAGS.has(arg)) {
        passthrough.push(next);
        i++;
      }
      continue;
    }
    files.push(arg);
  }
  return { passthrough, files };
}

// Resolve requested files relative to extension/ or the current directory.
function resolveRequestedFile(fileArg, allFiles, testRoot) {
  const candidates = new Set([resolve(testRoot, fileArg), resolve(process.cwd(), fileArg)]);
  return allFiles.find((file) => candidates.has(resolve(testRoot, file))) ?? null;
}

// Keep requested files in lane order. Reject names outside the lane instead of running its full file list.
function narrowSelection(fileArgs, selected, testRoot, mode) {
  const allFiles = discoverTestFiles(join(testRoot, 'src'), testRoot);
  const requested = new Set();
  for (const fileArg of fileArgs) {
    const match = resolveRequestedFile(fileArg, allFiles, testRoot);
    if (!match) {
      throw new Error(`No test file matches "${fileArg}".`);
    }
    if (!selected.includes(match)) {
      throw new Error(
        `"${fileArg}" is not a ${mode} lane test file. Run without file arguments to run the whole lane.`,
      );
    }
    requested.add(match);
  }
  return selected.filter((file) => requested.has(file));
}

// List files before flags because Vitest optional-value flags can consume following filenames.
function vitestArgs(mode, extraArgs, selected, testRoot) {
  return [
    join(testRoot, 'node_modules', 'vitest', 'vitest.mjs'),
    'run',
    '--fileParallelism',
    ...(hasWorkerFlag(extraArgs) ? [] : [`--maxWorkers=${laneWorkers()}`]),
    ...selected,
    ...clampWorkerArgs(extraArgs),
  ];
}

function spawnLane(mode, selected, extraArgs, testRoot, spawn, observation, onCancelled) {
  observation?.begin('execution', { boundary: 'Vitest child lifetime, including collection, builds and teardown' });
  const result = spawn(process.execPath, vitestArgs(mode, extraArgs, selected, testRoot), {
    cwd: testRoot,
    stdio: 'inherit',
    ...childEnvironment(observation),
  });
  observation?.event('execution', 'child-start', { childPid: result.pid ?? null });
  observation?.end('execution', {
    exitCode: result.status ?? null,
    signal: result.signal ?? null,
    error: result.error?.message ?? null,
  });
  if (result.signal || [129, 130, 143].includes(result.status))
    onCancelled?.(result.signal ?? { 129: 'SIGHUP', 130: 'SIGINT', 143: 'SIGTERM' }[result.status]);
  if (result.error) {
    console.error(`Could not start Vitest: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

async function spawnBrowserLane(
  selected,
  extraArgs,
  testRoot,
  spawnChild,
  lock,
  observation,
  mode = 'browser',
  onCancelled,
) {
  observation?.begin('execution', { boundary: 'Vitest child lifetime, including collection, builds and teardown' });
  const result = spawnChild(process.execPath, vitestArgs(mode, extraArgs, selected, testRoot), {
    cwd: testRoot,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
    ...childEnvironment(observation),
  });
  result.arcProcessGroup = process.platform !== 'win32';
  observation?.event('execution', 'child-start', { childPid: result.pid ?? null });
  if (typeof result?.once !== 'function') {
    if (result.signal || [129, 130, 143].includes(result.status))
      onCancelled?.(result.signal ?? { 129: 'SIGHUP', 130: 'SIGINT', 143: 'SIGTERM' }[result.status]);
    observation?.end('execution', {
      exitCode: result.status ?? null,
      signal: result.signal ?? null,
      error: result.error?.message ?? null,
    });
    if (result.error) {
      console.error(`Could not start Vitest: ${result.error.message}`);
      return 1;
    }
    return result.status ?? 1;
  }
  // Forward signals only while the child runs, then remove its handlers.
  const detachSignalForwarding = forwardSignalToChildAndRelease(result, lock, { observation });
  try {
    return await new Promise((resolveStatus) => {
      let settled = false;
      result.once('error', (error) => {
        if (settled) return;
        settled = true;
        observation?.end('execution', { exitCode: null, error: error.message });
        console.error(`Could not start Vitest: ${error.message}`);
        resolveStatus(1);
      });
      result.once('close', (status, signal) => {
        if (settled) return;
        settled = true;
        observation?.end('execution', { exitCode: status, signal: signal ?? null });
        if (signal || [129, 130, 143].includes(status))
          onCancelled?.(signal ?? { 129: 'SIGHUP', 130: 'SIGINT', 143: 'SIGTERM' }[status]);
        resolveStatus(status ?? 1);
      });
    });
  } finally {
    detachSignalForwarding();
  }
}

export async function runNodeLane(
  extraArgs,
  { testRoot = root, spawn: spawnChild = spawn, observationFactory, onCancelled } = {},
) {
  const observation = observationFactory?.('node', testRoot, extraArgs);
  observation?.unavailable('queue', 'The Node lane takes no machine resource.');
  observation?.unavailable('build', 'Builds inside Vitest are not separate launcher intervals.');
  observation?.unavailable('cleanup', 'Vitest teardown is included in its child lifetime.');
  let status = null;
  try {
    const { passthrough, files } = partitionArgs(extraArgs);
    let selected = selectForLane('node', testRoot);
    if (files.length) selected = narrowSelection(files, selected, testRoot, 'node');
    reportSelection('node', selected);
    if (!selected.length) throw Error('No test files selected for node mode.');
    status = await spawnBrowserLane(
      selected,
      passthrough,
      testRoot,
      spawnChild,
      null,
      observation,
      'node',
      onCancelled,
    );
    return status;
  } catch (error) {
    console.error(error.message);
    return (status = 1);
  } finally {
    observation?.finish({ exitCode: status, outcome: status === 0 ? 'success' : 'failure' });
  }
}

export function runTestMode(
  mode,
  extraArgs,
  { testRoot = root, spawn = spawnSync, observationFactory, onCancelled } = {},
) {
  const observation = observationFactory?.(mode, testRoot, extraArgs);
  observation?.unavailable('queue', 'The Node lane takes no machine resource.');
  observation?.unavailable('build', 'Builds inside Vitest are not separate launcher intervals.');
  observation?.unavailable('cleanup', 'Vitest teardown is included in its child lifetime.');
  let status = null;
  try {
    let selected;
    try {
      selected = selectForLane(mode, testRoot);
    } catch (error) {
      console.error(error.message);
      return (status = 1);
    }
    const { passthrough, files } = partitionArgs(extraArgs);
    if (files.length > 0) {
      try {
        selected = narrowSelection(files, selected, testRoot, mode);
      } catch (error) {
        console.error(error.message);
        return (status = 1);
      }
    }
    reportSelection(mode, selected);
    if (selected.length === 0) {
      console.error(`No test files selected for ${mode} mode.`);
      return (status = 1);
    }
    return (status = spawnLane(mode, selected, passthrough, testRoot, spawn, observation, onCancelled));
  } finally {
    observation?.finish({
      exitCode: status,
      outcome: status === null ? 'incomplete' : status === 0 ? 'success' : 'failure',
    });
  }
}

// Detect the browser using the test fixture's channel order. Download no browser.
export async function detectBrowser(_testRoot = root, observation = null) {
  const result = await launchAnyBrowser({ observationParent: observation });
  if (!result) {
    return null;
  }
  await result.browser.close();
  return result.channel ?? 'bundled Chromium';
}

export async function runBrowserLane(
  extraArgs,
  {
    testRoot = root,
    spawn: spawnChild = spawn,
    detectBrowser: detect = detectBrowser,
    acquireLock = noopAcquireLock,
    observationFactory,
    onCancelled,
  } = {},
) {
  const observation = observationFactory?.('browser', testRoot, extraArgs);
  observation?.unavailable('build', 'Builds inside Vitest are not separate launcher intervals.');
  let status = null;
  let lock = null;
  let failure = null;
  try {
    let selected;
    try {
      selected = selectForLane('browser', testRoot);
    } catch (error) {
      console.error(error.message);
      return (status = 1);
    }
    const { passthrough, files } = partitionArgs(extraArgs);
    if (files.length > 0) {
      try {
        selected = narrowSelection(files, selected, testRoot, 'browser');
      } catch (error) {
        console.error(error.message);
        return (status = 1);
      }
    }
    reportSelection('browser', selected);
    if (selected.length === 0) {
      console.error('No test files selected for browser mode.');
      return (status = 1);
    }
    // Acquire the machine-wide browser-lane lock before detection so waiting sessions launch no detection browser.
    // Release it on every exit, including failed browser detection.
    lock = await acquireLock({ cwd: testRoot, observation });
    try {
      observation?.begin('detection');
      const browserName = await detect(testRoot, observation);
      observation?.end('detection', { browser: browserName });
      if (!browserName) {
        console.error('Browser tests cannot run: no supported browser is available.');
        observation?.unavailable('execution', 'No supported browser is available.');
        return (status = 1);
      }
      console.log(`Browser executable: ${browserName}`);
      return (status = await spawnBrowserLane(
        selected,
        passthrough,
        testRoot,
        spawnChild,
        lock,
        observation,
        'browser',
        onCancelled,
      ));
    } finally {
      observation?.begin('cleanup');
      const released = lock.release();
      observation?.end('cleanup', { released, descendants: 'unobserved' });
    }
  } catch (error) {
    failure = error.message;
    throw error;
  } finally {
    if (!lock) {
      observation?.unavailable('execution', 'No browser lane child was started.');
      observation?.unavailable('cleanup', 'No acquired lock or child.');
    }
    observation?.finish({
      exitCode: status,
      outcome: status === 0 ? 'success' : failure ? 'failure' : status === null ? 'incomplete' : 'failure',
      reason: failure,
    });
  }
}

// Partition requested files by lane for full mode. Reject names that match no test file.
function splitFilesByLane(fileArgs, testRoot) {
  const allFiles = discoverTestFiles(join(testRoot, 'src'), testRoot);
  const byLane = { node: [], browser: [] };
  for (const fileArg of fileArgs) {
    const match = resolveRequestedFile(fileArg, allFiles, testRoot);
    if (!match) {
      throw new Error(`No test file matches "${fileArg}".`);
    }
    byLane[isBrowserTest(match) ? 'browser' : 'node'].push(fileArg);
  }
  return byLane;
}

export async function runFull(extraArgs, opts = {}) {
  let cancelled = false;
  const onCancelled = opts.onCancelled;
  opts = {
    ...opts,
    onCancelled: (signal) => {
      cancelled = true;
      opts.onSignal?.(signal);
      onCancelled?.(signal);
    },
  };
  const testRoot = opts.testRoot ?? root;
  const runNode = opts.asyncNode ? (args) => runNodeLane(args, opts) : (args) => runTestMode('node', args, opts);
  const { passthrough, files } = partitionArgs(extraArgs);
  // Without a machine load guard, the first lane starts in the same tick, as callers that emit child events at once expect.
  const { beforeLane } = opts;
  if (files.length === 0) {
    if (beforeLane) await beforeLane('The extension Node lane');
    const nodeStatus = await runNode(extraArgs);
    if (cancelled) return nodeStatus || 1;
    if (beforeLane) await beforeLane('The extension browser lane');
    const browserStatus = await runBrowserLane(extraArgs, opts);
    return nodeStatus !== 0 ? nodeStatus : browserStatus;
  }
  let byLane;
  try {
    byLane = splitFilesByLane(files, testRoot);
  } catch (error) {
    console.error(error.message);
    return 1;
  }
  let nodeStatus = 0;
  if (byLane.node.length > 0) {
    if (beforeLane) await beforeLane('The extension Node lane');
    nodeStatus = await runNode([...passthrough, ...byLane.node]);
    if (cancelled) return nodeStatus || 1;
  } else {
    console.log('Node lane skipped: no named file belongs to it.');
  }
  let browserStatus = 0;
  if (byLane.browser.length > 0) {
    if (beforeLane) await beforeLane('The extension browser lane');
    browserStatus = await runBrowserLane([...passthrough, ...byLane.browser], opts);
  } else {
    console.log('Browser lane skipped: no named file belongs to it.');
  }
  return nodeStatus !== 0 ? nodeStatus : browserStatus;
}

// Named files that all belong to one lane run that lane alone, like a single lane started by hand.
// A name that matches no file runs no lane, and runFull reports it.
function fullRunsBothLanes(extraArgs, testRoot = root) {
  const { files } = partitionArgs(extraArgs);
  if (!files.length) return true;
  try {
    const byLane = splitFilesByLane(files, testRoot);
    return byLane.node.length > 0 && byLane.browser.length > 0;
  } catch {
    return false;
  }
}

export async function main(argv = process.argv.slice(2), { machineLoad = {} } = {}) {
  const [mode = 'full', ...extraArgs] = argv;
  const opts = {
    asyncNode: true,
    onCancelled: (signal) => {
      process.exitCode = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }[signal] ?? 1;
    },
    acquireLock: acquireBrowserLock,
    observationFactory: (lane, cwd, args) =>
      createTestObservation({
        lane: `extension ${lane}`,
        cwd,
        command: [process.execPath, join(root, 'test.mjs'), lane, ...args],
        workerCap: laneWorkers(),
        capacity: lane === 'browser' ? 1 : null,
      }),
  };
  if (mode === 'full' && !fullRunsBothLanes(extraArgs)) return runFull(extraArgs, opts);
  if (mode === 'full') {
    // A full run of both lanes holds the machine suite lock and waits for free memory before each lane.
    try {
      return await holdMachineLoad((beforeLane) => runFull(extraArgs, { ...opts, beforeLane }), machineLoad);
    } catch (error) {
      if (!(error instanceof MachineLoadTimeout)) throw error;
      console.error(error.message);
      return error.exitCode;
    }
  }
  if (mode === 'browser') {
    return runBrowserLane(extraArgs, opts);
  }
  return mode === 'node' ? runNodeLane(extraArgs, opts) : runTestMode(mode, extraArgs, opts);
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main()
    .then((code) => {
      process.exitCode ||= code;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
