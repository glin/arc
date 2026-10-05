import { spawn, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchAnyBrowser } from './test/browserchannels.mjs';
import { acquireBrowserLock, forwardSignalToChildAndRelease } from './test/browserlock.mjs';

// runBrowserLane and runFull take no lock by default, so a caller that does not pass one, such
// as a test that stubs spawn and detectBrowser, can never reach the real machine-wide lock by
// accident. Only the CLI entry point below binds the real acquireBrowserLock.
async function noopAcquireLock() {
  return { release: () => true };
}

const root = dirname(fileURLToPath(import.meta.url));
const modes = new Set(['full', 'node', 'browser']);
// Vitest's own default worker count scales with the machine's core count, which a shared
// runner or a laptop under other load does not have to spare. Each lane states its own cap
// instead of accepting that default.
const LANE_ARGS = {
  node: ['--fileParallelism', '--maxWorkers=8'],
  browser: ['--fileParallelism', '--maxWorkers=4'],
};

// Flags that take a required value in Vitest's own CLI table (`cliOptionsConfig` in
// node_modules/vitest/dist/chunks/cac-*.js, where each entry lists an `argument` wrapped in
// angle brackets for a required value). Every other flag is boolean or takes an optional
// value that a bare following token never supplies, so its value never travels with it.
// `scripts/extension-test-runner.test.js` reads the installed table and fails when this list
// drifts from it.
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

// Selects a lane's full file list, before a named-file argument can narrow it further.
function selectForLane(mode, testRoot) {
  return selectTestFiles(discoverTestFiles(join(testRoot, 'src'), testRoot), mode);
}

// Reports the file count actually selected, so both a standalone lane script and full mode
// print the same line whether or not the lane goes on to spawn Vitest. Printed after a named
// file argument has narrowed the lane, so `browser <one file>` reports 1 file, not the lane.
function reportSelection(mode, selected) {
  console.log(`${laneLabel(mode)} lane: ${selected.length} file${selected.length === 1 ? '' : 's'} selected`);
}

// Splits the arguments after the mode into Vitest option flags and requested test files, so a
// named file can narrow a lane's selection while an option and its value still reach Vitest.
// An argument that starts with "-" is a flag. A flag that is one of Vitest's own required-value
// flags always takes the next token as its value, even when that token also looks like a test
// file, because Vitest itself would read it the same way. Any other flag never takes the next
// token, so a named file after it still reaches `files` on the next loop turn.
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

// Resolves a requested file against the full file list. A caller can name a file relative to
// extension/, the way the lane lists its own files, or relative to the current directory, the
// way it reads from the repository root, so both resolutions are tried.
function resolveRequestedFile(fileArg, allFiles, testRoot) {
  const candidates = new Set([resolve(testRoot, fileArg), resolve(process.cwd(), fileArg)]);
  return allFiles.find((file) => candidates.has(resolve(testRoot, file))) ?? null;
}

// Narrows a lane's selection to the named files, in the lane's own order. Fails with a clear
// message instead of falling back to the whole lane when a name does not resolve to a file in
// this lane.
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

// Lists selected files before the forwarded flags. Vitest's own CLI parser reads a boolean
// flag with an optional value, such as --update, as greedily as our own partitionArgs used
// to: a file token right after one is read as its value unless nothing follows the flag.
function vitestArgs(mode, extraArgs, selected, testRoot) {
  return [join(testRoot, 'node_modules', 'vitest', 'vitest.mjs'), 'run', ...LANE_ARGS[mode], ...selected, ...extraArgs];
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
  // Held only around the child's own lifetime, so a signal delivered before or after this lane
  // runs never reaches a handler with no child to forward it to.
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

// Tries the same browsers the layout and browser test files try, in the same order, and
// reports which one a Vitest worker would actually get. Nothing is downloaded here.
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
  // One lock file in the system temporary directory bounds the whole machine to one browser
  // lane at a time, because a single run already spends its own --maxWorkers=4 worth of
  // headless browsers. Acquired before detection, so a session waiting for the lock never also
  // launches a detection browser outside the limit the lock exists to enforce. The finally below
  // covers every exit path, including the no-browser skip.
  const lock = await acquireLock({ cwd: testRoot });
  try {
    const browserName = await detect(testRoot);
    if (!browserName) {
      console.log('Browser lane skipped: no browser found.');
      return 0;
    }
    console.log(`Browser executable: ${browserName}`);
    return await spawnBrowserLane(selected, passthrough, testRoot, spawnChild, lock);
  } finally {
    lock.release();
  }
}

// Sorts named files into the lane each one belongs to, so full mode can give each lane only
// its own files instead of handing every named file to both. Fails with a clear message
// naming the file instead of silently dropping it when a name matches no test file at all.
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
