import { spawn, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchAnyBrowser } from './test/browserchannels.mjs';
import { acquireBrowserLock, forwardSignalToChildAndRelease } from './test/browserlock.mjs';

// Default injected runners acquire no machine lock. The CLI entry point supplies the real acquireBrowserLock.
async function noopAcquireLock() {
  return { release: () => true };
}

const root = dirname(fileURLToPath(import.meta.url));
const modes = new Set(['full', 'node', 'browser']);
// Cap lane workers explicitly instead of using Vitest's core-count default.
const LANE_WORKERS = {
  node: 8,
  browser: 4,
};

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
  const workers = process.env.VITEST_MAX_WORKERS || LANE_WORKERS[mode];
  return [
    join(testRoot, 'node_modules', 'vitest', 'vitest.mjs'),
    'run',
    '--fileParallelism',
    `--maxWorkers=${workers}`,
    ...selected,
    ...extraArgs,
  ];
}

function spawnLane(mode, selected, extraArgs, testRoot, spawn) {
  const result = spawn(process.execPath, vitestArgs(mode, extraArgs, selected, testRoot), {
    cwd: testRoot,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`Could not start Vitest: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

async function spawnBrowserLane(selected, extraArgs, testRoot, spawnChild, lock) {
  const result = spawnChild(process.execPath, vitestArgs('browser', extraArgs, selected, testRoot), {
    cwd: testRoot,
    stdio: 'inherit',
  });
  if (typeof result?.once !== 'function') {
    if (result.error) {
      console.error(`Could not start Vitest: ${result.error.message}`);
      return 1;
    }
    return result.status ?? 1;
  }
  // Forward signals only while the child runs, then remove its handlers.
  const detachSignalForwarding = forwardSignalToChildAndRelease(result, lock);
  try {
    return await new Promise((resolveStatus) => {
      let settled = false;
      result.once('error', (error) => {
        if (settled) return;
        settled = true;
        console.error(`Could not start Vitest: ${error.message}`);
        resolveStatus(1);
      });
      result.once('close', (status) => {
        if (settled) return;
        settled = true;
        resolveStatus(status ?? 1);
      });
    });
  } finally {
    detachSignalForwarding();
  }
}

export function runTestMode(mode, extraArgs, { testRoot = root, spawn = spawnSync } = {}) {
  let selected;
  try {
    selected = selectForLane(mode, testRoot);
  } catch (error) {
    console.error(error.message);
    return 1;
  }
  const { passthrough, files } = partitionArgs(extraArgs);
  if (files.length > 0) {
    try {
      selected = narrowSelection(files, selected, testRoot, mode);
    } catch (error) {
      console.error(error.message);
      return 1;
    }
  }
  reportSelection(mode, selected);
  if (selected.length === 0) {
    console.error(`No test files selected for ${mode} mode.`);
    return 1;
  }
  return spawnLane(mode, selected, passthrough, testRoot, spawn);
}

// Detect the browser using the test fixture's channel order. Download no browser.
export async function detectBrowser(_testRoot = root) {
  const result = await launchAnyBrowser();
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
  } = {},
) {
  let selected;
  try {
    selected = selectForLane('browser', testRoot);
  } catch (error) {
    console.error(error.message);
    return 1;
  }
  const { passthrough, files } = partitionArgs(extraArgs);
  if (files.length > 0) {
    try {
      selected = narrowSelection(files, selected, testRoot, 'browser');
    } catch (error) {
      console.error(error.message);
      return 1;
    }
  }
  reportSelection('browser', selected);
  if (selected.length === 0) {
    console.error('No test files selected for browser mode.');
    return 1;
  }
  // Acquire the machine-wide browser-lane lock before detection so waiting sessions launch no detection browser.
  // Release it on every exit, including failed browser detection.
  const lock = await acquireLock({ cwd: testRoot });
  try {
    const browserName = await detect(testRoot);
    if (!browserName) {
      console.error('Browser tests cannot run: no supported browser is available.');
      return 1;
    }
    console.log(`Browser executable: ${browserName}`);
    return await spawnBrowserLane(selected, passthrough, testRoot, spawnChild, lock);
  } finally {
    lock.release();
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
  const testRoot = opts.testRoot ?? root;
  const { passthrough, files } = partitionArgs(extraArgs);
  if (files.length === 0) {
    const nodeStatus = runTestMode('node', extraArgs, opts);
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
    nodeStatus = runTestMode('node', [...passthrough, ...byLane.node], opts);
  } else {
    console.log('Node lane skipped: no named file belongs to it.');
  }
  let browserStatus = 0;
  if (byLane.browser.length > 0) {
    browserStatus = await runBrowserLane([...passthrough, ...byLane.browser], opts);
  } else {
    console.log('Browser lane skipped: no named file belongs to it.');
  }
  return nodeStatus !== 0 ? nodeStatus : browserStatus;
}

export async function main(argv = process.argv.slice(2)) {
  const [mode = 'full', ...extraArgs] = argv;
  const opts = { acquireLock: acquireBrowserLock };
  if (mode === 'full') {
    return runFull(extraArgs, opts);
  }
  if (mode === 'browser') {
    return runBrowserLane(extraArgs, opts);
  }
  return runTestMode(mode, extraArgs, opts);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
