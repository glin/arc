import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  lstatSync,
  readlinkSync,
  readdirSync,
} from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runLanes } from './test-lanes.mjs';
import { subprocessVitestArgs } from './test-subprocess.mjs';
import { createTestObservation } from '../extension/test/observations.mjs';
import { holdMachineLoad, MachineLoadTimeout, MEMORY_TIMEOUT_EXIT } from '../extension/test/machineload.mjs';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export function npmCli() {
  if (process.env.npm_execpath && existsSync(process.env.npm_execpath)) return process.env.npm_execpath;
  const candidates = [
    join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ];
  for (const directory of (process.env.PATH ?? process.env.Path ?? '').split(delimiter)) {
    const launcher = join(directory, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    if (!existsSync(launcher)) continue;
    const resolved = realpathSync(launcher);
    if (resolved.endsWith('npm-cli.js')) candidates.push(resolved);
    else candidates.push(join(dirname(resolved), 'node_modules/npm/bin/npm-cli.js'));
  }
  return candidates.find(existsSync) ?? null;
}
export const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))),
  }).trim();

export function trackedIdentity(cwd) {
  try {
    const files = git(cwd, 'ls-files', '-z').split('\0').filter(Boolean);
    const content = files.map((file) => {
      const path = join(cwd, file);
      return [
        file,
        existsSync(path) ? hash(lstatSync(path).isSymbolicLink() ? readlinkSync(path) : readFileSync(path)) : null,
      ];
    });
    return {
      candidate: git(cwd, 'rev-parse', 'HEAD'),
      treeHash: hash(JSON.stringify(content)),
      clean: git(cwd, 'status', '--porcelain', '--untracked-files=no') === '',
    };
  } catch (error) {
    return { candidate: null, treeHash: null, clean: false, error: error.message };
  }
}

export function environmentIdentity(cwd) {
  const files = [
    'package-lock.json',
    'extension/package-lock.json',
    'cli/package-lock.json',
    '.oxfmtrc.mjs',
    '.oxlintrc.jsonc',
    '.stylelintrc.cjs',
    'vitest.config.mts',
    'extension/vitest.config.ts',
    'cli/vitest.config.ts',
    'extension/tsconfig.json',
    'extension/src/webview/tsconfig.json',
    'cli/tsconfig.json',
    '.claude/skills/panel-mockup/vitest.config.mts',
  ];
  const configuration = Object.fromEntries(
    files.map((file) => [file, existsSync(join(cwd, file)) ? hash(readFileSync(join(cwd, file))) : null]),
  );
  const dependencies = Object.fromEntries(
    ['', 'extension', 'cli'].map((directory) => {
      const file = join(cwd, directory, 'node_modules/.package-lock.json');
      return [directory || 'root', existsSync(file) ? hash(readFileSync(file)) : null];
    }),
  );
  const environment = Object.fromEntries(
    Object.entries(process.env)
      .filter(([key]) =>
        /^(CI|NODE_OPTIONS|VITEST_MAX_WORKERS|PLAYWRIGHT_BROWSERS_PATH|ARC_TEST_BROWSER_ARGS|ARC_TEST_.*SETUP_FAILED)$/.test(
          key,
        ),
      )
      .sort(),
  );
  const identity = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    configuration,
    dependencies,
    environment,
    npm: npmCli() ? { path: npmCli(), hash: hash(readFileSync(npmCli())) } : null,
  };
  return { ...identity, hash: hash(JSON.stringify(identity)) };
}

export function suiteLanes(cwd = root, mode = 'all') {
  const node = (id, directory, args, extra = {}) => ({
    id,
    label: id,
    cwd: join(cwd, directory),
    args,
    package: directory || 'root',
    ...extra,
  });
  const tool = (directory, name, entry) => join(cwd, directory, 'node_modules', name, entry);
  const vitest = (id, directory, args, extra) =>
    node(id, directory, [tool(directory, 'vitest', 'vitest.mjs'), 'run', ...args], { vitest: true, ...extra });
  const compiler = (id, directory, config) =>
    node(id, directory, [tool(directory, 'typescript', 'bin/tsc'), '--noEmit', '-p', config]);
  const statics = [
    node('format', '', [
      tool('', 'oxfmt', 'bin/oxfmt'),
      '--config',
      '.oxfmtrc.mjs',
      '--disable-nested-config',
      '--check',
    ]),
    node('lint-js', '', [tool('', 'oxlint', 'bin/oxlint'), '--disable-nested-config', '--deny-warnings']),
    node('lint-css', '', [
      tool('', 'stylelint', 'bin/stylelint.mjs'),
      '--config',
      '.stylelintrc.cjs',
      '--max-warnings',
      '0',
      'extension/src/webview/*.css',
    ]),
    node('webview-globals', 'extension', ['--import', 'tsx', 'scripts/check-webview-globals.ts']),
    compiler('extension-tsc', 'extension', 'tsconfig.json'),
    compiler('webview-tsc', 'extension', 'src/webview/tsconfig.json'),
    compiler('cli-tsc', 'cli', 'tsconfig.json'),
  ];
  const units = [
    vitest('root-units', '', ['--exclude', 'test/hooks-smoke.test.js', '--tags-filter=!subprocess']),
    node('extension-units', 'extension', [join(cwd, 'extension/test.mjs'), 'node', '--tags-filter=!subprocess'], {
      vitest: true,
    }),
    vitest('cli-units', 'cli', ['--tags-filter=!subprocess', '--exclude', 'test/smoke.bundled-*.test.mjs']),
  ];
  const integration = [
    node('root-subprocess', '', subprocessVitestArgs(cwd), { vitest: true, system: true }),
    node('extension-integration', 'extension', [join(cwd, 'extension/test.mjs'), 'node', '--tags-filter=subprocess'], {
      vitest: true,
    }),
    vitest('panel-mockup', '', ['--config', '.claude/skills/panel-mockup/vitest.config.mts'], {
      browser: true,
      system: true,
    }),
    vitest('hook-smoke', '', ['test/hooks-smoke.test.js'], { system: true }),
    node('cli-build', 'cli', [join(cwd, 'cli/build.mjs')]),
    vitest('cli-smoke', 'cli', ['--tags-filter=subprocess'], { requiresBuild: true }),
  ];
  const browser = [
    node(
      'browser',
      'extension',
      [
        join(cwd, 'extension/test.mjs'),
        'browser',
        ...(mode === 'browser' ? (process.env.ARC_TEST_BROWSER_ARGS?.split(' ').filter(Boolean) ?? []) : []),
      ],
      { browser: true, vitest: true },
    ),
  ];
  const groups = {
    all: [...statics, ...units, ...integration, ...browser],
    default: [...statics, ...units],
    checks: statics,
    unit: units,
    integration,
    browser,
    lint: statics.slice(1, 3),
    typecheck: statics.slice(3),
    'extension-typecheck': statics.slice(3, 6),
    smoke: integration.slice(3),
    'cli-test': [statics.at(-1), units.at(-1), ...integration.slice(4)],
    'cli-smoke': integration.slice(4),
  };
  if (!groups[mode]) throw Error(`Unknown test category selection: ${mode}`);
  return groups[mode];
}

export function failedTests(file, category, cwd = root) {
  if (!existsSync(file)) return [];
  const report = JSON.parse(readFileSync(file, 'utf8'));
  const failures = (report.testResults ?? []).flatMap((suite) => {
    const failures = (suite.assertionResults ?? [])
      .filter((test) => test.status === 'failed')
      .map((test) => ({
        file: suite.name,
        name: test.fullName ?? [...(test.ancestorTitles ?? []), test.title].join(' '),
        detail: (test.failureMessages ?? []).join('\n'),
      }));
    if (suite.fileErrors?.length) failures.push(...suite.fileErrors.map((error) => ({ file: suite.name, ...error })));
    else if (suite.message) failures.push({ file: suite.name, name: '<collection>', detail: suite.message });
    else if (!failures.length && suite.status === 'failed')
      failures.push({ file: suite.name, name: '<collection>', detail: suite.message ?? 'Test collection failed.' });
    return failures;
  });
  failures.push(...(report.unhandledErrors ?? []).map((detail) => ({ file: null, name: '<unhandled>', detail })));
  failures.push(...(report.lifecycleErrors ?? []).map((detail) => ({ file: null, name: '<closure>', detail })));
  return failures.map((failure) => {
    if (failure.file) failure.file = failure.file.replaceAll('\\', '/').replace(cwd.replaceAll('\\', '/') + '/', '');
    failure.detail = normalizeDiagnostic(failure.detail, cwd);
    return { ...failure, id: `${category}:${hash(JSON.stringify(failure))}` };
  });
}

export function completeTestDiagnostics(report) {
  return report?.arcFailureAccounting === 2 && report.closureComplete === true;
}

function normalizeDiagnostic(text, cwd) {
  return String(text)
    .replaceAll(cwd, '<checkout>')
    .replaceAll(cwd.replaceAll('\\', '/'), '<checkout>')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replaceAll('\r\n', '\n')
    .trim();
}

export function categoryFailure(category, cwd) {
  const detail =
    normalizeDiagnostic(category.reason ?? readFileSync(category.log, 'utf8'), cwd) ||
    `Command exited ${category.exitCode}`;
  const diagnosticHash = hash(detail);
  return { id: `${category.id}:<category>:${diagnosticHash}`, file: null, name: null, detail, diagnosticHash };
}

export function laneCommand(lane, tests) {
  return [
    process.execPath,
    ...lane.args,
    ...(lane.vitest
      ? ['--reporter=default', `--reporter=${join(root, 'scripts/test-reporter.mjs')}`, `--outputFile=${tests}`]
      : []),
  ];
}

// A run of more than one lane holds the machine suite lock and waits for free memory before each lane.
// machineLoad carries injected lock and memory options, and false disables the guard.
export async function collectSuite({ machineLoad = {}, ...options } = {}) {
  const lanes = options.lanes ?? suiteLanes(options.cwd ?? root, options.mode ?? 'all');
  return holdMachineLoad(
    (beforeLane) => collectLanes({ ...options, lanes, beforeLane }),
    lanes.length > 1 ? machineLoad : false,
  );
}

// Return the exit status for a command entry point, including the named machine load timeouts.
export async function runSuiteCommand(options) {
  try {
    return (await collectSuite(options)).exitCode;
  } catch (error) {
    console.error(error.message);
    return error.exitCode ?? 1;
  }
}

async function collectLanes({
  cwd = root,
  mode = 'all',
  reportDir,
  base = null,
  lanes,
  runChecks,
  processEmitter = process,
  identify = trackedIdentity,
  environmentFor = environmentIdentity,
  observationFactory = createTestObservation,
  beforeLane,
}) {
  reportDir ??= process.env.ARC_TEST_REPORT_DIR;
  if (reportDir) {
    reportDir = resolve(reportDir);
    mkdirSync(reportDir, { recursive: true });
  } else {
    const directory = join(homedir(), '.arc/test-results');
    mkdirSync(directory, { recursive: true });
    reportDir = mkdtempSync(join(directory, 'run-'));
  }
  if (readdirSync(reportDir).length) throw Error(`Test collection requires a fresh empty directory: ${reportDir}`);
  writeFileSync(join(reportDir, 'collection-start.json'), JSON.stringify({ pid: process.pid, command: process.argv }), {
    flag: 'wx',
  });
  const start = identify(cwd);
  const environment = environmentFor(cwd);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) processEmitter.on(signal, cancel);
  const categories = [];
  let memoryTimeout = null;
  const observation = observationFactory({ lane: mode, cwd });
  for (const phase of ['queue', 'build', 'execution', 'cleanup'])
    observation?.unavailable(
      phase,
      'Delegated commands contain their own intervals. Stage wall times include nested work.',
    );
  try {
    for (const lane of lanes) {
      const log = join(reportDir, `${lane.id}.log`);
      const tests = join(reportDir, `${lane.id}.tests.json`);
      const category = {
        id: lane.id,
        command: laneCommand(lane, tests),
        cwd: lane.cwd,
        status: null,
        exitCode: null,
        signal: null,
        log,
        tests: lane.vitest ? tests : null,
        failures: [],
        sourceStart: identify(cwd),
      };
      categories.push(category);
      writeFileSync(log, '');
      const setupFailed = process.env[`ARC_TEST_${lane.package.toUpperCase()}_SETUP_FAILED`] === '1';
      const missingTool = lane.args[0] && !lane.args[0].startsWith('-') && !existsSync(lane.args[0]);
      const blocked = setupFailed
        ? `${lane.package} dependency installation failed`
        : lane.browser && process.env.ARC_TEST_BROWSER_SETUP_FAILED === '1'
          ? 'Browser installation failed'
          : lane.system && process.env.ARC_TEST_SYSTEM_SETUP_FAILED === '1'
            ? 'System tool installation failed'
            : lane.requiresBuild && categories.find((row) => row.id === 'cli-build')?.status !== 'passed'
              ? 'CLI build did not pass'
              : missingTool
                ? `Executable is unavailable: ${lane.args[0]}`
                : null;
      let memoryBlocked = false;
      if (!controller.signal.aborted && !blocked) {
        try {
          await beforeLane(`The ${lane.id} lane`, controller.signal);
        } catch (error) {
          if (!(error instanceof MachineLoadTimeout)) throw error;
          memoryTimeout = error;
          memoryBlocked = true;
          console.error(error.message);
          controller.abort();
        }
      }
      if (controller.signal.aborted || blocked) {
        category.status = memoryBlocked || !controller.signal.aborted ? 'blocked' : 'cancelled';
        category.reason = memoryBlocked ? memoryTimeout.message : (blocked ?? 'Collection cancelled');
        appendFileSync(log, `${category.reason}\n`);
      } else {
        const args = category.command.slice(1);
        let outcome;
        category.command = [process.execPath, ...args];
        observation?.begin(`stage:${lane.id}`);
        const env = {
          ...(observation?.childEnvironment() ?? process.env),
          ...(npmCli() ? { npm_execpath: npmCli(), npm_node_execpath: process.execPath } : {}),
          ...(lane.vitest ? { ARC_TEST_RESULTS_FILE: tests } : {}),
        };
        delete env.ARC_TEST_REPORT_DIR;
        await runLanes([{ ...lane, args, env }], runChecks, null, {
          signal: controller.signal,
          onOutput: (_check, chunk) => appendFileSync(log, chunk),
          onResult: (result) => {
            outcome = result;
            if (result.signal || [129, 130, 143].includes(result.status)) controller.abort();
          },
        });
        observation?.end(`stage:${lane.id}`);
        category.exitCode = outcome?.status ?? 1;
        category.signal = outcome?.signal ?? null;
        category.reason = outcome?.error ?? null;
        category.status =
          controller.signal.aborted || category.signal
            ? 'cancelled'
            : outcome?.error
              ? 'blocked'
              : category.exitCode === 0
                ? 'passed'
                : 'failed';
        if (lane.vitest && category.status === 'passed' && !existsSync(tests)) {
          category.status = 'blocked';
          category.reason = 'Test results are unavailable.';
        }
        try {
          category.failures = failedTests(tests, lane.id, cwd);
          const testReport = lane.vitest && existsSync(tests) ? JSON.parse(readFileSync(tests)) : null;
          category.diagnosticsComplete = !lane.vitest || completeTestDiagnostics(testReport);
          if (testReport?.reason === 'interrupted') {
            controller.abort();
            category.status = 'cancelled';
          } else if (category.status === 'passed' && category.failures.length) category.status = 'failed';
          if (lane.vitest && !category.diagnosticsComplete && category.status === 'passed') {
            category.status = 'blocked';
            category.reason = 'Complete test diagnostics are unavailable.';
          }
        } catch (error) {
          if (category.status !== 'cancelled') category.status = 'failed';
          category.reason = error.message;
        }
      }
      if (category.status !== 'passed' && !category.failures.length)
        category.failures.push(categoryFailure(category, cwd));
      category.logHash = hash(readFileSync(log));
      category.testsHash = existsSync(tests) ? hash(readFileSync(tests)) : null;
      category.sourceEnd = identify(cwd);
      console.log(`${category.id}: ${category.status} (${log})`);
    }
  } finally {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) processEmitter.off(signal, cancel);
  }
  const end = identify(cwd);
  const exitCode = memoryTimeout
    ? MEMORY_TIMEOUT_EXIT
    : !controller.signal.aborted &&
        categories.every((category) => category.status === 'passed') &&
        categories.every(
          (category) =>
            category.sourceStart.treeHash === start.treeHash &&
            category.sourceEnd.treeHash === start.treeHash &&
            category.sourceStart.candidate === start.candidate &&
            category.sourceEnd.candidate === start.candidate,
        ) &&
        start.treeHash === end.treeHash &&
        start.candidate === end.candidate
      ? 0
      : 1;
  const report = {
    schema: 1,
    mode,
    selected: lanes.map((lane) => lane.id),
    command: process.argv,
    checkout: realpathSync(cwd),
    base,
    start,
    end,
    environment,
    environmentEnd: environmentFor(cwd),
    categories,
    exitCode,
  };
  const content = JSON.stringify(report, null, 2) + '\n';
  writeFileSync(join(reportDir, 'suite.json'), content, { flag: 'wx' });
  writeFileSync(
    join(reportDir, 'collection-receipt.json'),
    JSON.stringify({ schema: 1, reportHash: hash(content) }) + '\n',
    { flag: 'wx' },
  );
  observation?.finish({
    exitCode,
    outcome: controller.signal.aborted ? 'cancelled' : exitCode ? 'failure' : 'success',
  });
  console.log(`Test report: ${join(reportDir, 'suite.json')}`);
  return { ...report, reportDir };
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const [mode = 'all', ...args] = process.argv.slice(2);
  const reportIndex = args.indexOf('--report-dir');
  process.exitCode = await runSuiteCommand({ mode, reportDir: reportIndex < 0 ? undefined : args[reportIndex + 1] });
}
