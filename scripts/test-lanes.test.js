const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { testFiles, classification, caseBudget } = require('./test-classification.js');
const { runChecks } = require('./typecheck-parallel.js');

const repositoryRoot = path.join(__dirname, '..');
const ROOT_TEST_DIRECTORIES = ['plugins', 'scripts', 'test'];
// Files that reach child_process and carry no subprocess tag. Each entry names the reason.
const UNTAGGED_PROCESS_FILES = {
  'test/hooks-smoke.test.js': 'The test:smoke lane runs it. Both root lanes exclude it.',
};

let lane;
let defaults;
let units;
let integration;
let suite;
let acceptance;
beforeAll(async () => {
  lane = await import(pathToFileURL(path.join(__dirname, 'test-subprocess.mjs')).href);
  defaults = await import(pathToFileURL(path.join(__dirname, 'test-default.mjs')).href);
  units = await import(pathToFileURL(path.join(__dirname, 'test-unit.mjs')).href);
  integration = await import(pathToFileURL(path.join(__dirname, 'test-integration.mjs')).href);
  suite = await import('./test-suite.mjs');
  acceptance = await import('./verify-landing.mjs');
});

function rootTestFiles(directory = '') {
  const files = [];
  const absolute = path.join(repositoryRoot, directory);
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const relative = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || (directory === '' && !ROOT_TEST_DIRECTORIES.includes(entry.name))) continue;
      files.push(...rootTestFiles(relative));
    } else if (entry.name.endsWith('.test.js')) {
      files.push(relative);
    }
  }
  return files.sort();
}

function importsChildProcess(text) {
  return /(?:require\(|import\(|from\s+)\s*['"](?:node:)?child_process['"]/.test(text);
}

function reachesChildProcess(file, visited = new Set()) {
  if (visited.has(file)) return false;
  visited.add(file);
  const text = fs.readFileSync(file, 'utf8');
  if (importsChildProcess(text)) return true;
  for (const match of text.matchAll(/(?:require\(|import\(|from\s+)\s*['"](\.[^'"]+)['"]/g)) {
    const base = path.resolve(path.dirname(file), match[1]);
    if (base.split(path.sep).includes('node_modules')) continue;
    const dependency = [base, `${base}.js`, `${base}.mjs`, path.join(base, 'index.js')].find(
      (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
    );
    if (dependency && reachesChildProcess(dependency, visited)) return true;
  }
  return false;
}

function hasSubprocessTag(text) {
  return /\/\/\s*@module-tag\s+subprocess\b/.test(text) || /tags:\s*\[\s*'subprocess'/.test(text);
}

function readScripts() {
  return JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')).scripts;
}

function excludesOf(command) {
  return [...command.matchAll(/--exclude[= ]\s*(\S+)/g)].map((match) => match[1]);
}

test('every root test file that reaches child_process carries the subprocess tag or is listed with a reason', () => {
  const untagged = [];
  for (const file of rootTestFiles()) {
    const text = fs.readFileSync(path.join(repositoryRoot, file), 'utf8');
    if (
      reachesChildProcess(path.join(repositoryRoot, file)) &&
      !hasSubprocessTag(text) &&
      !(file in UNTAGGED_PROCESS_FILES)
    )
      untagged.push(file);
  }
  assert.deepEqual(
    untagged,
    [],
    'Tag these files subprocess, or list them in UNTAGGED_PROCESS_FILES with a reason, so test:root stays free of process starts.',
  );
});

test('command entry points run through a linked checkout', { tags: ['subprocess'] }, async () => {
  // Fixture runs start in this run's temporary directory, so their suite locks never meet a real run.
  vi.stubEnv('ARC_TEST_MEMORY_FLOOR_GB', '0');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-entry-'));
  const linked = path.join(root, 'linked');
  const physical = path.join(root, 'physical');
  const write = (file, text) => {
    const target = path.join(physical, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  try {
    for (const file of [
      'scripts/test-subprocess.mjs',
      'scripts/test-default.mjs',
      'scripts/test-suite.mjs',
      'scripts/test-reporter.mjs',
      'scripts/test-lanes.mjs',
      'scripts/verify-landing.mjs',
      'scripts/test-unit.mjs',
      'scripts/test-integration.mjs',
      'extension/test.mjs',
      'extension/test/observations.mjs',
      'extension/test/machineload.mjs',
      'scripts/isolated-editor.mjs',
      'evals/agent-review/cli.mjs',
    ]) {
      write(file, fs.readFileSync(path.join(repositoryRoot, file), 'utf8'));
    }
    write(
      'extension/test/browserlock.mjs',
      'export async function acquireBrowserLock({observation}={}){observation?.begin("queue");observation?.end("queue");return {release(){return true}}} export function forwardSignalToChildAndRelease(){return ()=>{}}',
    );
    write(
      'extension/test/browserchannels.mjs',
      'export function processExists(){return true} export async function launchAnyBrowser(){throw Error("unexpected browser")} export async function acquireBrowserSlot(){throw Error("unexpected slot")}',
    );
    write('extension/src/example.test.ts', '');
    write('extension/src/example.browser.test.ts', '');
    write('extension/node_modules/vitest/vitest.mjs', 'console.log("Node child selected");process.stdin.resume();');
    for (const file of [
      'node_modules/oxfmt/bin/oxfmt',
      'node_modules/oxlint/bin/oxlint',
      'node_modules/stylelint/bin/stylelint.mjs',
      'extension/node_modules/typescript/bin/tsc',
      'cli/node_modules/typescript/bin/tsc',
      'cli/node_modules/vitest/vitest.mjs',
      'cli/build.mjs',
    ])
      write(file, '');
    write('node_modules/vitest/vitest.mjs', 'console.log("subprocess entry reached");process.exitCode=7;');
    write(
      'scripts/typecheck-parallel.js',
      'module.exports = {runChecks: async ([lane], options) => { console.log(lane.label); const status = ["format", "root-units", "root-subprocess", "browser"].includes(lane.label) ? 1 : 0; options?.onResult?.({status}); return status ? [lane.label] : []; }};',
    );
    write(
      'scripts/import-only.cjs',
      fs.readFileSync(path.join(repositoryRoot, 'scripts/typecheck-parallel.js'), 'utf8'),
    );
    const importOnly = spawnSync(
      process.execPath,
      ['-e', `require(${JSON.stringify(path.join(physical, 'scripts/import-only.cjs'))})`],
      { encoding: 'utf8' },
    );
    assert.equal(importOnly.status, 0, importOnly.stderr);
    write(
      'catalog/fixture-case.json',
      JSON.stringify({
        schema: 'arc-review-case-v1',
        id: 'fixture-case',
        source_kind: 'accepted_review',
        family: 'fixture-family',
        case_revision: 1,
        key_revision: 1,
        source: { base: 'a'.repeat(40), candidate: 'b'.repeat(40), correction: 'c'.repeat(40) },
        key_state: 'historical-partial',
        historical_context: { original_prompt: null, plan: null },
        fixture_paths: ['fixture.txt'],
        keys: [
          {
            id: 'defect-a',
            severity: 'high',
            summary: 'Candidate contains a visible defect.',
            paths: ['fixture.txt'],
            evidence: {
              scope: 'Visible fixture defect',
              reach: 'candidate',
              mode: 'review',
              disposition: 'accepted',
              source: 'fixture correction commit',
              sha256: 'b'.repeat(64),
              source_attempt_identity: 'unresolved',
              exclude_attempt_ids: [],
            },
          },
        ],
      }),
    );
    write('cache/evidence.json', '{}');
    fs.symlinkSync(physical, linked, 'junction');
    for (const { file, args, status, output } of [
      { file: 'scripts/test-subprocess.mjs', args: [], status: 7, output: /subprocess entry reached/ },
      { file: 'scripts/test-default.mjs', args: [], status: 1, output: /format/ },
      { file: 'scripts/test-unit.mjs', args: [], status: 1, output: /root-units/ },
      { file: 'scripts/test-integration.mjs', args: [], status: 1, output: /root-subprocess/ },
      { file: 'scripts/test-suite.mjs', args: ['all'], status: 1, output: /browser: failed/ },
      { file: 'extension/test.mjs', args: ['invalid-mode'], status: 1, output: /Unknown test mode/ },
      { file: 'scripts/isolated-editor.mjs', args: ['invalid-command'], status: 2, output: /Choose a command/ },
    ]) {
      const timings = path.join(root, 'timings', path.basename(file));
      const env = {
        ...process.env,
        ARC_TEST_REPORT_DIR: path.join(root, 'reports', path.basename(file)),
        ARC_TEST_OBSERVATIONS_DIR: timings,
        ARC_TEST_OBSERVATION_RUN_ID: 'linked-parent',
      };
      const result = spawnSync(process.execPath, [path.join(linked, file), ...args], { encoding: 'utf8', env });
      assert.ifError(result.error);
      assert.equal(result.status, status, `${file}\n${result.stdout}${result.stderr}`);
      assert.match(result.stdout + result.stderr, output);
      if (file === 'scripts/test-suite.mjs') {
        const report = JSON.parse(fs.readFileSync(path.join(env.ARC_TEST_REPORT_DIR, 'suite.json')));
        assert.equal(report.categories[0].status, 'failed');
        assert.equal(report.categories[1].status, 'passed');
        assert.equal(report.categories.at(-1).status, 'failed');
        assert.equal(report.exitCode, 1);
      }
      const recorded = fs.existsSync(timings) ? fs.readdirSync(timings) : [];
      if (file === 'scripts/test-subprocess.mjs') {
        assert.equal(recorded.length, 1);
        const events = fs
          .readFileSync(path.join(timings, recorded[0]), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        const terminal = events.at(-1);
        assert.equal(terminal.event, 'result');
        assert.equal(terminal.exitCode, 7);
        assert.equal(terminal.parentRunId, 'linked-parent');
        assert.equal(terminal.complete, true);
        assert.equal(terminal.capacity, null);
        assert.equal(terminal.intervals.queue.durationMs, null);
        assert.ok(events.every((event) => !Object.hasOwn(event, 'released')));
        assert.ok(terminal.intervals.execution.durationMs >= 0);
        assert.match(result.stdout, /Test timings: .*\.jsonl/);
      }
      const imported = spawnSync(process.execPath, ['--input-type=module', '-'], {
        input: `await import(${JSON.stringify(pathToFileURL(path.join(linked, file)).href)});console.log('import only');`,
        encoding: 'utf8',
        env,
      });
      assert.ifError(imported.error);
      assert.equal(imported.status, 0, imported.stderr);
      assert.equal(imported.stdout.trim(), 'import only');
      assert.deepEqual(
        fs.existsSync(timings) ? fs.readdirSync(timings) : [],
        recorded,
        'Importing a linked command must create no timing run.',
      );
    }
    write(
      'extension/test/browserlock.mjs',
      fs.readFileSync(path.join(repositoryRoot, 'extension/test/browserlock.mjs'), 'utf8'),
    );
    // The test kills this run while it holds the suite lock, and the fixture reports every PID alive.
    // Its own temporary directory keeps that lock away from the later fixture runs.
    const killedTemp = path.join(root, 'killed-temp');
    fs.mkdirSync(killedTemp);
    const full = spawn(process.execPath, [path.join(linked, 'extension/test.mjs'), 'full'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10_000,
      env: { ...process.env, TEMP: killedTemp, TMP: killedTemp, TMPDIR: killedTemp },
    });
    let fullOutput = '';
    const fullResult = await new Promise((resolve, reject) => {
      full.once('error', reject);
      full.stdout.on('data', (chunk) => {
        fullOutput += chunk;
        if (fullOutput.includes('Node child selected')) full.kill('SIGTERM');
      });
      full.stderr.on('data', (chunk) => {
        fullOutput += chunk;
      });
      full.once('close', (code, signal) => resolve({ code, signal }));
    });
    assert.ok(fullResult.code !== 0 || fullResult.signal);
    assert.match(fullOutput, /Node child selected/);
    assert.doesNotMatch(fullOutput, /Browser lane|unexpected browser/);
    write('extension/node_modules/vitest/vitest.mjs', 'process.exit(143);');
    const nestedCancellation = spawnSync(process.execPath, [path.join(linked, 'extension/test.mjs'), 'full'], {
      encoding: 'utf8',
    });
    assert.equal(nestedCancellation.status, 143);
    // Full mode over both lanes waits for the suite lock and for free memory. A named file in one lane waits for neither.
    const loadTemp = path.join(root, 'load-temp');
    fs.mkdirSync(loadTemp);
    const loadEnv = (extra) => {
      const env = { ...process.env, TEMP: loadTemp, TMP: loadTemp, TMPDIR: loadTemp, ...extra };
      env.ARC_TEST_LOAD_DEADLINE_MINUTES = '0.001';
      delete env.ARC_TEST_SUITE_HOLDER;
      return env;
    };
    const fullRun = (args, extra) =>
      spawnSync(process.execPath, [path.join(linked, 'extension/test.mjs'), 'full', ...args], {
        encoding: 'utf8',
        env: loadEnv(extra),
      });
    const starvedFull = fullRun([], { ARC_TEST_MEMORY_FLOOR_GB: '100000' });
    assert.equal(starvedFull.status, 76, starvedFull.stdout + starvedFull.stderr);
    assert.doesNotMatch(starvedFull.stdout, /Node lane:/);
    const suiteLock = path.join(loadTemp, 'arc-test-suite.lock');
    fs.writeFileSync(suiteLock, JSON.stringify({ pid: process.pid, startedAt: 'earlier', command: 'holder' }));
    const heldFull = fullRun([], { ARC_TEST_MEMORY_FLOOR_GB: '0' });
    assert.equal(heldFull.status, 75, heldFull.stdout + heldFull.stderr);
    assert.match(heldFull.stderr, /The holder was PID \d+, started earlier, running holder\./);
    const namedNode = fullRun(['src/example.test.ts'], { ARC_TEST_MEMORY_FLOOR_GB: '0' });
    assert.equal(namedNode.status, 143, namedNode.stdout + namedNode.stderr);
    fs.rmSync(suiteLock);
    assert.doesNotMatch(nestedCancellation.stdout + nestedCancellation.stderr, /Browser lane|unexpected browser/);
    write(
      'scripts/typecheck-parallel.js',
      `const fs=require('node:fs');module.exports={runChecks:async ([lane],options)=>{
      const output=lane.args.find(arg=>arg.startsWith('--outputFile='));
      if(output)fs.writeFileSync(output.slice('--outputFile='.length),JSON.stringify({arcFailureAccounting:2,closureComplete:true,testResults:[],unhandledErrors:[]}));
      options.onResult({status:0});return [];
    }};`,
    );
    const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
    const git = (...args) => {
      const result = spawnSync('git', ['-C', physical, ...args], { encoding: 'utf8', env: gitEnv });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git('init');
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'core.hooksPath=',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'fixture',
    );
    const base = git('rev-parse', 'HEAD');
    const landingDirectory = path.join(root, 'landing-report');
    const verifyArgs = [
      path.join(physical, 'scripts/verify-landing.mjs'),
      '--base',
      base,
      '--report-dir',
      landingDirectory,
    ];
    const starvedLanding = spawnSync(
      process.execPath,
      [...verifyArgs.slice(0, -1), path.join(root, 'starved-landing')],
      { encoding: 'utf8', env: loadEnv({ ARC_TEST_MEMORY_FLOOR_GB: '100000' }) },
    );
    assert.equal(starvedLanding.status, 76, starvedLanding.stdout + starvedLanding.stderr);
    const accepted = spawnSync(process.execPath, verifyArgs, { encoding: 'utf8' });
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(landingDirectory, 'suite.json'))).exitCode, 0);
    const reused = spawnSync(process.execPath, verifyArgs, { encoding: 'utf8' });
    assert.equal(reused.status, 0, reused.stderr);
    assert.doesNotMatch(reused.stdout, /Test report:/);
    const suiteFile = path.join(landingDirectory, 'suite.json');
    const originalReport = fs.readFileSync(suiteFile);
    const editedReport = JSON.parse(originalReport);
    editedReport.command.push('--altered');
    fs.writeFileSync(suiteFile, JSON.stringify(editedReport));
    const altered = spawnSync(process.execPath, verifyArgs, { encoding: 'utf8' });
    fs.writeFileSync(suiteFile, originalReport);
    assert.equal(altered.status, 1, 'Changed passing reports must refuse reuse.');
    assert.match(altered.stdout, /Collection receipt/);
    const receiptFile = path.join(landingDirectory, 'collection-receipt.json');
    const originalReceipt = fs.readFileSync(receiptFile);
    editedReport.categories[0].command.push('--altered');
    fs.writeFileSync(suiteFile, JSON.stringify(editedReport));
    fs.writeFileSync(receiptFile, JSON.stringify({ schema: 1, reportHash: suite.hash(fs.readFileSync(suiteFile)) }));
    const wrongCommand = spawnSync(process.execPath, verifyArgs, { encoding: 'utf8' });
    fs.writeFileSync(suiteFile, originalReport);
    fs.writeFileSync(receiptFile, originalReceipt);
    assert.equal(wrongCommand.status, 1);
    assert.match(wrongCommand.stdout, /Category command identity/);
    const trackedSource = path.join(physical, 'extension/src/example.test.ts');
    const sourceBefore = fs.readFileSync(trackedSource);
    fs.writeFileSync(trackedSource, 'dirty candidate');
    const refused = spawnSync(process.execPath, verifyArgs, { encoding: 'utf8' });
    fs.writeFileSync(trackedSource, sourceBefore);
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, /clean tracked candidate/);
    const review = spawnSync(
      process.execPath,
      [
        path.join(linked, 'evals/agent-review/cli.mjs'),
        'validate',
        '--cache',
        path.join(physical, 'cache'),
        '--catalog',
        path.join(physical, 'catalog'),
      ],
      { encoding: 'utf8' },
    );
    assert.ifError(review.error);
    assert.equal(review.status, 1, 'Linked review validation must reject the invalid cache.');
    assert.equal(review.stdout, '');
    assert.equal(review.stderr, 'cache schema\n');
  } finally {
    vi.unstubAllEnvs();
    if (fs.existsSync(linked)) fs.unlinkSync(linked);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('every untagged process file is still listed for a reason', () => {
  for (const [file, reason] of Object.entries(UNTAGGED_PROCESS_FILES)) {
    assert.ok(reason.length > 0, file);
    const text = fs.readFileSync(path.join(repositoryRoot, file), 'utf8');
    assert.ok(importsChildProcess(text) && !hasSubprocessTag(text), `${file} no longer needs its entry.`);
  }
});

test('process discovery follows unnamed relative helpers through another helper', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-helper-discovery-'));
  try {
    fs.writeFileSync(path.join(root, 'ordinary.test.js'), "require('./ordinary.js');");
    fs.writeFileSync(path.join(root, 'ordinary.js'), "require('./another.js');");
    fs.writeFileSync(path.join(root, 'another.js'), "require('node:child_process').spawn('node');");
    assert.equal(reachesChildProcess(path.join(root, 'ordinary.test.js')), true);
    fs.writeFileSync(path.join(root, 'another.js'), "require('./ordinary.js');");
    assert.equal(reachesChildProcess(path.join(root, 'ordinary.test.js')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('test:root and test:subprocess together select every root test file', () => {
  const scripts = readScripts();
  const config = fs.readFileSync(path.join(repositoryRoot, 'vitest.config.mts'), 'utf8');
  const includes = [...config.matchAll(/'([^']*\*\.test\.js)'/g)].map((match) => match[1]);
  assert.deepEqual(
    includes.map((pattern) => pattern.split('/')[0]).sort(),
    ROOT_TEST_DIRECTORIES,
    'The guard scans the directories that vitest.config.mts includes.',
  );

  assert.match(scripts['test:root'], /--tags-filter="!subprocess"/);
  assert.match(scripts['test:root'], /^vitest run /);
  assert.equal(scripts['test:subprocess'], 'node scripts/test-subprocess.mjs');
  const laneArgs = lane.subprocessVitestArgs(repositoryRoot);
  assert.ok(laneArgs.includes('--tags-filter=subprocess'));
  assert.ok(laneArgs.includes('run'));
  assert.ok(laneArgs.includes('--maxWorkers=1'));
  assert.ok(laneArgs.includes(`--maxConcurrency=${lane.SUBPROCESS_CONCURRENCY}`));

  // Both lanes leave out the same files, and the smoke lane runs them.
  const excluded = excludesOf(scripts['test:root']);
  assert.deepEqual(excluded, [lane.SMOKE_TEST_FILE]);
  assert.deepEqual(
    laneArgs.flatMap((arg, index) => (laneArgs[index - 1] === '--exclude' ? [arg] : [])),
    excluded,
  );
  assert.equal(scripts['test:smoke'], 'node scripts/test-suite.mjs smoke');
  assert.equal(scripts['test:unit'], 'node scripts/test-unit.mjs');
});

test('both GitHub workflows retain complete categories', () => {
  const workflow = fs.readFileSync(path.join(repositoryRoot, '.github', 'workflows', 'tests.yml'), 'utf8');
  const commands = [...workflow.matchAll(/^\s*run:\s*(\S.*)$/gm)].map((match) => match[1].trim());
  assert.ok(commands.includes('npm run test:unit'), 'The workflow must run test:unit.');
  assert.ok(commands.includes('npm run test:integration'), 'The workflow must run test:integration.');
  assert.match(workflow, /node scripts\/test-suite.mjs browser/);
  const candidate = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/vsix-candidate.yml'), 'utf8');
  assert.match(candidate, /^\s*- run: npm run test:all\s*$/m);
  for (const file of [workflow, candidate])
    assert.match(file, /^env:\n {2}ARC_TEST_MEMORY_FLOOR_GB: '0'$/m, 'CI runners must not wait for free memory.');
});

test('the default runs direct units and the complete command adds every integration category', () => {
  const scripts = readScripts();
  assert.equal(scripts.test, 'node scripts/test-default.mjs');
  assert.deepEqual(
    defaults.defaultLanes(repositoryRoot).map((entry) => entry.id),
    [
      'format',
      'lint-js',
      'lint-css',
      'webview-globals',
      'extension-tsc',
      'webview-tsc',
      'cli-tsc',
      'root-units',
      'extension-units',
      'cli-units',
    ],
  );
  const lanes = units.unitLanes(repositoryRoot);
  assert.equal(lanes.length, 3);
  assert.ok(lanes.every((entry) => entry.args.includes('--tags-filter=!subprocess')));
  assert.deepEqual(lanes[0].args.slice(2), ['--exclude', lane.SMOKE_TEST_FILE, '--tags-filter=!subprocess']);
  assert.match(lanes[1].args[0], /extension[\\/]test[.]mjs$/);
  assert.equal(lanes[1].args[1], 'node');
  assert.deepEqual(lanes[2].args.slice(2), ['--tags-filter=!subprocess', '--exclude', 'test/smoke.bundled-*.test.mjs']);
  assert.equal(scripts['test:integration'], 'node scripts/test-integration.mjs');
  assert.equal(scripts['test:browser'], 'node extension/test.mjs browser');
  assert.equal(scripts['test:all'], 'node scripts/test-suite.mjs all');
  const groups = integration.integrationLanes(repositoryRoot, true, 'npm-cli.js');
  assert.deepEqual(
    groups.map((entry) => entry.id),
    ['root-subprocess', 'extension-integration', 'panel-mockup', 'hook-smoke', 'cli-build', 'cli-smoke', 'browser'],
  );
  assert.deepEqual(integration.integrationLanes(repositoryRoot, false, 'npm-cli.js'), groups.slice(0, -1));
  const extension = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'extension/package.json'))).scripts;
  assert.equal(extension['test:integration'], 'node test.mjs node --tags-filter=subprocess');
  const cli = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'cli/package.json'))).scripts;
  assert.equal(cli['test:unit'], 'vitest run --tags-filter=!subprocess --exclude "test/smoke.bundled-*.test.mjs"');
  assert.equal(cli['test:smoke'], 'node ../scripts/test-suite.mjs cli-smoke');
});

test('stages run sequentially and retain failures around a passing stage', async () => {
  const started = [];
  let finish;
  const first = new Promise((resolve) => {
    finish = resolve;
  });
  const pending = defaults.runLanes([{ label: 'first' }, { label: 'second' }, { label: 'third' }], async ([entry]) => {
    started.push(entry.label);
    if (entry.label === 'first') await first;
    return entry.label === 'second' ? [] : [entry.label];
  });
  assert.deepEqual(started, ['first']);
  finish();
  assert.deepEqual(await pending, ['first', 'third']);
  assert.deepEqual(started, ['first', 'second', 'third']);
});

test.each(['default', 'unit', 'integration'])('%s lanes publish child output before close', async (wrapper) => {
  const output = [];
  const errors = [];
  const children = [];
  const started = [];
  const selected =
    wrapper === 'default'
      ? defaults.defaultLanes(repositoryRoot)
      : wrapper === 'unit'
        ? units.unitLanes(repositoryRoot)
        : integration.integrationLanes(repositoryRoot, true, 'npm-cli.js');
  const run = (entries, options, write, writeError) =>
    runChecks(entries, {
      ...options,
      spawnFn: (_command, args) => {
        started.push(args);
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        children.push(child);
        return child;
      },
      write,
      writeError,
      log: () => {},
      logError: () => {},
    });
  const pending = defaults.runLanes(selected, (entries, options) =>
    run(
      entries,
      options,
      (chunk) => output.push(chunk),
      (chunk) => errors.push(chunk),
    ),
  );
  assert.equal(children.length, 1);
  const active = started.length;
  children[0].stdout.emit('data', Buffer.from('waiting for subprocess lock\n'));
  children[0].stderr.emit('data', Buffer.from('child progress\n'));
  assert.equal(Buffer.concat(output).toString(), 'waiting for subprocess lock\n');
  assert.equal(Buffer.concat(errors).toString(), 'child progress\n');
  assert.equal(started.length, active);
  children[0].emit('close', 7);
  for (let index = 1; index < selected.length; index++) {
    await vi.waitFor(() => assert.ok(children[index]));
    children[index].emit('close', 0);
  }
  assert.deepEqual(await pending, [selected[0].label]);
  assert.ok(started.length >= active);
  assert.equal(Buffer.concat(output).toString(), 'waiting for subprocess lock\n');
  assert.equal(Buffer.concat(errors).toString(), 'child progress\n');
});

test('expensive tests retain admitted boundaries and repetition budgets', () => {
  const admission = JSON.parse(fs.readFileSync(path.join(__dirname, 'test-admission.json'), 'utf8'));
  const found = {};
  for (const file of testFiles(repositoryRoot)) {
    const source = fs.readFileSync(path.join(repositoryRoot, file), 'utf8');
    if (!Object.values(classification(file, source)).some(Boolean)) continue;
    assert.ok(admission[file]?.reason, `${file}: name the external failure boundary in scripts/test-admission.json.`);
    found[file] = { reason: admission[file].reason, ...caseBudget(file, source) };
  }
  assert.deepEqual(found, admission, 'Added expensive cases and expanded matrices need an explicit admission change.');
});

test('admission detects build aliases, process helpers, added cases, and selected matrix growth', () => {
  for (const source of [
    "import { build as bundle } from 'esbuild'; test('bundle', () => bundle({}));",
    "const { build: bundle } = require('esbuild'); test('bundle', () => bundle({}));",
    "const bundler = await import('esbuild'); test('bundle', () => bundler.build({}));",
  ])
    assert.equal(classification('ordinary.test.ts', source).build, true);
  assert.equal(classification('ordinary.test.ts', "test('child', () => spawnCli('node'));").process, true);
  assert.equal(classification('ordinary.test.js', "test('child', () => runChecks([]));").process, true);
  assert.notDeepEqual(caseBudget('ordinary.ts', ''), caseBudget('ordinary.ts', "test('another', () => {});"));
  for (const [file, needle, replacement] of [
    [
      'extension/src/packaging.test.ts',
      "{ command: '/bin/sh', args: ['-c'] }",
      "{ command: '/bin/sh', args: ['-c'] }, { command: '/bin/sh', args: ['-c'] }",
    ],
    [
      'scripts/editor-cli.test.js',
      "{ ARC_TEST_HTTP_FAILURE: 'api.github' },",
      "{ ARC_TEST_HTTP_FAILURE: 'api.github' }, { ARC_TEST_HTTP_FAILURE: 'api.github' },",
    ],
  ]) {
    const source = fs.readFileSync(path.join(repositoryRoot, file), 'utf8');
    assert.ok(source.includes(needle), file);
    assert.notDeepEqual(caseBudget(file, source), caseBudget(file, source.replace(needle, replacement)));
  }
});

test('unit discovery defers worker bundle builds until admitted execution', () => {
  const ts = require('../extension/node_modules/typescript');
  for (const file of ['progressiveworker.test.ts', 'startup.test.ts', 'panel.webview.test.ts']) {
    const source = fs.readFileSync(path.join(repositoryRoot, 'extension/src', file), 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const eager = [];
    function visit(node, inFunction = false) {
      inFunction ||= ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node);
      if (!inFunction && ts.isCallExpression(node) && /(?:^|[.])buildSync$/.test(node.expression.getText(ast)))
        eager.push(node.expression.getText(ast));
      ts.forEachChild(node, (child) => visit(child, inFunction));
    }
    visit(ast);
    assert.deepEqual(eager, [], file);
  }
  const codex = fs.readFileSync(path.join(repositoryRoot, 'extension/src/codex.test.ts'), 'utf8');
  assert.match(codex, /describe\('recreated worktree ownership',\s*\{ tags: \['subprocess'\]/);
});

test('real window-channel and native background fixtures execute in integration', () => {
  const ts = require('../extension/node_modules/typescript');
  for (const [file, helper] of [
    ['extension/src/sessionrequests.test.ts', /\bfixture\(|new (?:WindowChannel|WindowsPipeServer)\(/],
    ['extension/src/sessiondiscovery.test.ts', /\bfixture\(|new WindowChannel\(/],
    ['extension/src/sessionwrites.test.ts', /\bfixture\(/],
    ['extension/src/windowpipe.test.ts', /\bfixture\(/],
    ['cli/test/run.test.ts', /\bbackgroundFixture\(|absent-provider/],
    ['extension/src/agenthost.test.ts', /\bspawnCli\(/],
    ['extension/src/claudeplugin.test.ts', /\.installCommands\(|\bresolveToolRuntime\(/],
    ['extension/src/panel-shots.test.ts', /ONE_PIXEL_PNG/],
    ['cli/test/manage.test.ts', /\bhost\(|new WindowChannel\(/],
    ['cli/test/smoke.test.mjs', /\brunSkillCommand\(/],
  ]) {
    const source = fs.readFileSync(path.join(repositoryRoot, file), 'utf8');
    if (/^\/\/ @module-tag subprocess/m.test(source)) continue;
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isCallExpression(node) && /^test(?:\.|$)/.test(node.expression.getText(ast))) {
        const callback = node.arguments.find((arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
        if (callback && helper.test(callback.getText(ast))) {
          assert.ok(
            node.arguments.some(
              (arg) => ts.isObjectLiteralExpression(arg) && /tags:\s*\[\s*'subprocess'/.test(arg.getText(ast)),
            ),
            `${file}: ${node.arguments[0].getText(ast)}`,
          );
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
});

test('independent subprocess launches start while earlier children remain pending and retain their statuses', async () => {
  const events = [];
  const children = [];
  const admission = Promise.withResolvers();
  const options = {
    testRoot: repositoryRoot,
    acquireLock: () => admission.promise,
    spawn: (command, args) => {
      events.push(['spawned', args.at(-1)]);
      const child = new EventEmitter();
      children.push(child);
      return child;
    },
  };
  const requests = [
    lane.runSubprocessLane(['scripts/first.test.js'], options),
    lane.runSubprocessLane(['scripts/second.test.js'], options),
  ];
  let statuses;
  try {
    assert.deepEqual(events, [
      ['spawned', 'scripts/first.test.js'],
      ['spawned', 'scripts/second.test.js'],
    ]);
  } finally {
    admission.resolve({ release: () => true });
    await Promise.resolve();
    children.forEach((child, index) => child.emit('close', index === 0 ? 7 : 0));
    statuses = await Promise.all(requests);
  }
  assert.deepEqual(statuses, [7, 0]);
});

function collectionFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-collection-'));
  const emitter = new EventEmitter();
  const identity = { candidate: 'b'.repeat(40), treeHash: 'c'.repeat(64), clean: true };
  const environment = { hash: 'd'.repeat(64) };
  const options = {
    cwd: directory,
    base: 'a'.repeat(40),
    reportDir: path.join(directory, 'report'),
    identify: () => ({ ...identity }),
    environmentFor: () => environment,
    observationFactory: () => null,
    processEmitter: emitter,
    machineLoad: false,
  };
  const lanes = ['first', 'middle', 'last'].map((id) => ({
    id,
    label: id,
    cwd: directory,
    args: ['-e', id],
    package: 'root',
  }));
  return { directory, emitter, identity, environment, options, lanes };
}

// These cases exercise failure collection and admission boundaries without starting test workers.
test('collection reports independent failures, setup blocking, cancellation, and original output', async () => {
  const fixture = collectionFixture();
  const { directory, emitter, options, lanes } = fixture;
  const launched = [];
  const output = [];
  try {
    const report = await suite.collectSuite({
      ...options,
      lanes,
      runChecks: (entries, settings) =>
        runChecks(entries, {
          ...settings,
          log: () => {},
          logError: () => {},
          write: (chunk) => output.push(String(chunk)),
          writeError: (chunk) => output.push(String(chunk)),
          spawnFn: (_command, args) => {
            launched.push(args[1]);
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            queueMicrotask(() => {
              child.stdout.emit('data', Buffer.from(args[1] + ' progress'));
              assert.ok(output.includes(args[1] + ' progress'), 'Output must stream before close.');
              child.emit('close', args[1] === 'middle' ? 0 : 7);
            });
            return child;
          },
        }),
    });
    assert.equal(report.exitCode, 1);
    assert.deepEqual(launched, ['first', 'middle', 'last']);
    assert.deepEqual(
      report.categories.map((row) => row.status),
      ['failed', 'passed', 'failed'],
    );
    assert.equal(report.categories.flatMap((row) => row.failures).length, 2);
    assert.equal(fs.readFileSync(report.categories[2].log, 'utf8'), 'last progress');
    assert.equal(emitter.listenerCount('SIGTERM'), 0);

    const blocked = await suite.collectSuite({
      ...options,
      reportDir: path.join(directory, 'blocked'),
      lanes: [{ ...lanes[0], id: 'cli-build' }, { ...lanes[1], requiresBuild: true }, lanes[2]],
      runChecks: async ([entry], settings) => {
        settings.onResult({ status: entry.id === 'cli-build' ? 1 : 0 });
        return entry.id === 'cli-build' ? [entry.id] : [];
      },
    });
    assert.deepEqual(
      blocked.categories.map((row) => row.status),
      ['failed', 'blocked', 'passed'],
    );

    const cancelled = await suite.collectSuite({
      ...options,
      reportDir: path.join(directory, 'cancelled'),
      lanes,
      runChecks: (entries, settings) =>
        runChecks(entries, {
          ...settings,
          log: () => {},
          logError: () => {},
          spawnFn: () => {
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.kill = () => {
              child.emit('close', null, 'SIGTERM');
            };
            queueMicrotask(() => emitter.emit('SIGTERM'));
            return child;
          },
        }),
    });
    assert.equal(cancelled.exitCode, 1);
    assert.deepEqual(
      cancelled.categories.map((row) => row.status),
      ['cancelled', 'cancelled', 'cancelled'],
    );
    assert.equal(emitter.listenerCount('SIGTERM'), 0);

    const missing = await suite.collectSuite({
      ...options,
      reportDir: path.join(directory, 'missing'),
      lanes,
      runChecks: (entries, settings) =>
        runChecks(entries, {
          ...settings,
          log: () => {},
          logError: () => {},
          spawnFn: () => {
            throw Error('missing executable');
          },
        }),
    });
    assert.deepEqual(
      missing.categories.map((row) => row.status),
      ['blocked', 'blocked', 'blocked'],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function acceptanceFixture() {
  const fixture = collectionFixture();
  const { directory, identity, environment } = fixture;
  const categories = ['first', 'middle', 'last'].map((id) => {
    const log = path.join(directory, id + '.log');
    fs.writeFileSync(log, id);
    return {
      id,
      command: [process.execPath, '-e', id],
      cwd: directory,
      sourceStart: { ...identity },
      sourceEnd: { ...identity },
      status: id === 'middle' ? 'passed' : 'failed',
      exitCode: id === 'middle' ? 0 : 1,
      log,
      logHash: suite.hash(fs.readFileSync(log)),
      testsHash: null,
      failures: id === 'middle' ? [] : [suite.categoryFailure({ id, log, exitCode: 1 }, directory)],
    };
  });
  const report = {
    schema: 1,
    mode: 'all',
    base: 'a'.repeat(40),
    checkout: directory,
    start: { ...identity },
    end: { ...identity },
    environment,
    environmentEnd: environment,
    selected: categories.map((row) => row.id),
    categories,
    exitCode: 1,
  };
  const reportHash = suite.hash(JSON.stringify(report));
  const base = {
    ...report,
    categories: structuredClone(report.categories),
    start: { ...identity, candidate: report.base },
    end: { ...identity, candidate: report.base },
  };
  for (const row of base.categories) {
    row.sourceStart = { ...row.sourceStart, candidate: report.base };
    row.sourceEnd = { ...row.sourceEnd, candidate: report.base };
  }
  const baseFile = path.join(directory, 'base.json');
  fs.writeFileSync(baseFile, JSON.stringify(base));
  const policy = {
    authority: 'owner-authorized-unrelated-failures',
    candidate: identity.candidate,
    base: report.base,
    reportHash,
    affectedChecks: ['middle'],
    dispositions: categories.flatMap((row) =>
      row.failures.map((failure) => ({
        failure: failure.id,
        classification: 'base-existing',
        explanation: 'Matching named comparison reproduces the same failure.',
        reviewedBy: 'fixture-reviewer',
        evidence: { path: baseFile, sha256: suite.hash(fs.readFileSync(baseFile)) },
      })),
    ),
  };
  const input = {
    report,
    reportHash,
    policy,
    current: identity,
    base: report.base,
    expectedCategories: report.selected,
    expectedLanes: fixture.lanes,
    environment,
  };
  return { ...fixture, input, baseFile };
}

test('acceptance retains failed truth for matching unrelated failures and explicit blocked categories', () => {
  const fixture = acceptanceFixture();
  try {
    const decision = acceptance.validateAcceptance(fixture.input);
    assert.equal(decision.accepted, true);
    assert.equal(decision.suiteExitCode, 1);
    const { report, policy } = fixture.input;
    report.categories[0].status = 'blocked';
    const base = JSON.parse(fs.readFileSync(fixture.baseFile));
    base.categories[0].status = 'blocked';
    fs.writeFileSync(fixture.baseFile, JSON.stringify(base));
    for (const row of policy.dispositions) row.evidence.sha256 = suite.hash(fs.readFileSync(fixture.baseFile));
    assert.throws(() => acceptance.validateAcceptance(fixture.input), /concrete test or static diagnostics/);
    report.categories = report.categories.filter((row) => row.id === 'middle');
    report.selected = ['middle'];
    report.exitCode = 0;
    fixture.input.expectedCategories = ['middle'];
    fixture.input.expectedLanes = [fixture.lanes[1]];
    fixture.input.policy = null;
    assert.equal(acceptance.validateAcceptance(fixture.input).accepted, true);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test.each([
  [
    'related failure',
    (input) => {
      input.policy.dispositions[0].classification = 'related';
    },
    /unrelated disposition/,
  ],
  [
    'uncertain failure',
    (input) => {
      input.policy.dispositions[0].classification = 'uncertain';
    },
    /unrelated disposition/,
  ],
  [
    'omitted failure',
    (input) => {
      input.policy.dispositions.pop();
    },
    /exactly one disposition/,
  ],
  [
    'unknown failure',
    (input) => {
      input.policy.dispositions[0].failure = 'unknown';
    },
    /unrelated disposition/,
  ],
  [
    'missing category',
    (input) => {
      input.report.categories.pop();
    },
    /category results/,
  ],
  [
    'failed affected check',
    (input) => {
      input.policy.affectedChecks = ['first'];
    },
    /Affected check did not pass/,
  ],
  [
    'blocked affected check',
    (input) => {
      input.report.categories[0].status = 'blocked';
      input.policy.affectedChecks = ['first'];
    },
    /Affected check did not pass/,
  ],
  [
    'dirty sources',
    (input) => {
      input.current.clean = false;
    },
    /clean tracked candidate/,
  ],
  [
    'dirty execution',
    (input) => {
      input.report.start.clean = false;
    },
    /clean tracked candidate/,
  ],
  [
    'changed tracked content',
    (input) => {
      input.current.treeHash = 'e'.repeat(64);
    },
    /tracked content changed/,
  ],
  [
    'stale candidate',
    (input) => {
      input.current.candidate = 'e'.repeat(40);
    },
    /Candidate or tracked content/,
  ],
  [
    'changed base',
    (input) => {
      input.base = 'e'.repeat(40);
    },
    /Integration base changed/,
  ],
  [
    'altered report',
    (input) => {
      input.reportHash = 'e'.repeat(64);
    },
    /Policy does not match/,
  ],
  [
    'altered evidence',
    (input) => {
      input.policy.dispositions[0].evidence.sha256 = 'e'.repeat(64);
    },
    /Evidence changed/,
  ],
  [
    'altered log',
    (input) => {
      fs.appendFileSync(input.report.categories[0].log, 'changed');
    },
    /Category log changed/,
  ],
  [
    'cancelled coverage',
    (input) => {
      input.report.categories[0].status = 'cancelled';
    },
    /Cancelled coverage/,
  ],
  [
    'changed environment',
    (input) => {
      input.environment = { hash: 'e'.repeat(64) };
    },
    /environment changed/,
  ],
  [
    'missing policy',
    (input) => {
      input.policy = null;
    },
    /explicit owner-authorized/,
  ],
  [
    'missing affected checks',
    (input) => {
      input.policy.affectedChecks = [];
    },
    /requires affected checks/,
  ],
])('acceptance refuses %s', (_name, change, expected) => {
  const fixture = acceptanceFixture();
  try {
    change(fixture.input);
    assert.throws(() => acceptance.validateAcceptance(fixture.input), expected);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('CI continues independent categories after unit and browser setup failures and stops after cancellation', async () => {
  const workflow = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/tests.yml'), 'utf8');
  const steps = workflow.split(/^      - /m).slice(1);
  const unitsStep = steps.find((step) => step.startsWith('name: Direct unit tests'));
  const integrationStep = steps.find((step) => step.startsWith('name: Integration and smoke tests'));
  const admits = (step, cancelled) => {
    const condition = step.match(/if: (.*)/)[1].trim();
    assert.equal(condition, '${{ !cancelled() }}');
    return !cancelled;
  };
  assert.ok(admits(unitsStep, false));
  assert.ok(admits(integrationStep, false));
  assert.equal(admits(unitsStep, true), false);
  assert.equal(admits(integrationStep, true), false);
  assert.ok(
    integrationStep.includes(
      "ARC_TEST_BROWSER_SETUP_FAILED: ${{ steps.browser-setup.outcome != 'success' && '1' || '' }}",
    ),
  );
  const fixture = collectionFixture();
  try {
    vi.stubEnv('ARC_TEST_BROWSER_SETUP_FAILED', '1');
    const launched = [];
    const lanes = [
      ...suite.suiteLanes(fixture.directory, 'unit'),
      ...suite.suiteLanes(fixture.directory, 'integration'),
    ];
    for (const lane of lanes) {
      if (lane.args[0].startsWith('-')) continue;
      fs.mkdirSync(path.dirname(lane.args[0]), { recursive: true });
      fs.writeFileSync(lane.args[0], '');
    }
    const report = await suite.collectSuite({
      ...fixture.options,
      lanes,
      runChecks: async ([lane], settings) => {
        launched.push(lane.id);
        const output = lane.args.find((arg) => arg.startsWith('--outputFile='));
        if (output)
          fs.writeFileSync(
            output.slice('--outputFile='.length),
            JSON.stringify({ arcFailureAccounting: 2, closureComplete: true, testResults: [], unhandledErrors: [] }),
          );
        settings.onResult({ status: lane.id === 'root-units' ? 1 : 0 });
        return lane.id === 'root-units' ? [lane.id] : [];
      },
    });
    assert.equal(report.exitCode, 1);
    assert.equal(report.categories.find((row) => row.id === 'panel-mockup').status, 'blocked');
    assert.ok(launched.includes('extension-units'));
    assert.ok(launched.includes('root-subprocess'));
    assert.ok(launched.includes('cli-smoke'));
    assert.equal(launched.includes('panel-mockup'), false);
    const candidate = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/vsix-candidate.yml'), 'utf8');
    assert.doesNotMatch(candidate, /continue-on-error/);
    assert.match(candidate, /needs: package/);
    const packageStep = candidate
      .split(/^      - /m)
      .find((step) => step.startsWith('run: npm --prefix extension run package'));
    assert.doesNotMatch(packageStep, /if:/);
  } finally {
    vi.unstubAllEnvs();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('acceptance requires named affected tests to pass within a category with unrelated failures', () => {
  const fixture = acceptanceFixture();
  try {
    const { report, policy } = fixture.input;
    const category = report.categories[0];
    category.tests = path.join(fixture.directory, 'named.tests.json');
    fs.writeFileSync(
      category.tests,
      JSON.stringify({
        arcFailureAccounting: 2,
        closureComplete: true,
        testResults: [
          {
            name: path.join(fixture.directory, 'sample.test.js'),
            status: 'failed',
            assertionResults: [
              { fullName: 'affected contract', status: 'passed', failureMessages: [] },
              { fullName: 'existing unrelated failure', status: 'failed', failureMessages: ['same failure'] },
            ],
          },
        ],
      }),
    );
    category.testsHash = suite.hash(fs.readFileSync(category.tests));
    category.failures = suite.failedTests(category.tests, category.id, fixture.directory);
    const base = JSON.parse(fs.readFileSync(fixture.baseFile));
    base.categories[0] = {
      ...category,
      sourceStart: { ...category.sourceStart, candidate: report.base },
      sourceEnd: { ...category.sourceEnd, candidate: report.base },
    };
    fs.writeFileSync(fixture.baseFile, JSON.stringify(base));
    policy.dispositions[0].failure = category.failures[0].id;
    for (const row of policy.dispositions) row.evidence.sha256 = suite.hash(fs.readFileSync(fixture.baseFile));
    policy.affectedChecks = [{ category: category.id, file: 'sample.test.js', name: 'affected contract' }];
    assert.equal(acceptance.validateAcceptance(fixture.input).suiteExitCode, 1);
    policy.affectedChecks[0].name = 'existing unrelated failure';
    assert.throws(() => acceptance.validateAcceptance(fixture.input), /Affected check did not pass/);
    policy.affectedChecks[0].name = 'unexecuted affected test';
    assert.throws(() => acceptance.validateAcceptance(fixture.input), /Affected check did not pass/);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('infrastructure dispositions require concrete unchanged evidence and affected-check independence', () => {
  const fixture = acceptanceFixture();
  try {
    const { input } = fixture;
    for (const row of input.policy.dispositions) {
      const category = input.report.categories.find((category) =>
        category.failures.some((failure) => failure.id === row.failure),
      );
      const evidence = {
        candidate: input.current.candidate,
        base: input.base,
        reportHash: input.reportHash,
        failure: row.failure,
        cause: 'The owned fixture lacks an external executable.',
        independence: 'The passed affected check starts no external executable.',
        artifacts: [{ path: category.log, sha256: category.logHash }],
      };
      const file = path.join(fixture.directory, category.id + '.infrastructure.json');
      fs.writeFileSync(file, JSON.stringify(evidence));
      row.classification = 'unrelated-infrastructure';
      row.evidence = { path: file, sha256: suite.hash(fs.readFileSync(file)) };
    }
    assert.equal(acceptance.validateAcceptance(input).suiteExitCode, 1);
    input.report.categories[0].status = 'blocked';
    assert.equal(acceptance.validateAcceptance(input).accepted, true);
    const row = input.policy.dispositions[0];
    const evidence = JSON.parse(fs.readFileSync(row.evidence.path));
    evidence.independence = '';
    fs.writeFileSync(row.evidence.path, JSON.stringify(evidence));
    row.evidence.sha256 = suite.hash(fs.readFileSync(row.evidence.path));
    assert.throws(() => acceptance.validateAcceptance(input), /affected-check independence/);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

// These fixtures exercise independent acceptance failures without starting workers.
test('interrupted collection refuses stale category results before launching', async () => {
  const fixture = collectionFixture();
  try {
    fs.mkdirSync(fixture.options.reportDir);
    fs.writeFileSync(path.join(fixture.options.reportDir, 'first.tests.json'), '{"testResults":[]}');
    let launched = false;
    await assert.rejects(
      suite.collectSuite({
        ...fixture.options,
        lanes: fixture.lanes,
        runChecks: async () => {
          launched = true;
          return ['first'];
        },
      }),
      /fresh|empty/,
    );
    assert.equal(launched, false);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('failed assertions retain independent file errors and unhandled errors', () => {
  const fixture = collectionFixture();
  try {
    const file = path.join(fixture.directory, 'tests.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        arcFailureAccounting: 2,
        closureComplete: true,
        unhandledErrors: ['new unhandled rejection'],
        testResults: [
          {
            name: 'sample.test.js',
            status: 'failed',
            message: 'new teardown failure',
            fileErrors: [
              { name: '<module>', detail: 'new teardown failure' },
              { name: 'nested suite', detail: 'another hook failure' },
            ],
            assertionResults: [
              { fullName: 'existing assertion', status: 'failed', failureMessages: ['existing failure'] },
            ],
          },
        ],
      }),
    );
    assert.deepEqual(
      suite.failedTests(file, 'first', fixture.directory).map((row) => row.detail),
      ['existing failure', 'new teardown failure', 'another hook failure', 'new unhandled rejection'],
    );
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('equal static exit codes do not reproduce different diagnostics', async () => {
  const fixture = collectionFixture();
  try {
    const reports = [];
    for (const diagnostic of ['old.ts(1): error TS1: old failure', 'new.ts(2): error TS2: new failure']) {
      reports.push(
        await suite.collectSuite({
          ...fixture.options,
          reportDir: path.join(fixture.directory, String(reports.length)),
          lanes: [fixture.lanes[0]],
          runChecks: async ([entry], options) => {
            options.onOutput(entry, diagnostic);
            options.onResult({ status: 2 });
            return [entry.id];
          },
        }),
      );
    }
    assert.notEqual(reports[0].categories[0].failures[0].id, reports[1].categories[0].failures[0].id);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
  const acceptanceCase = acceptanceFixture();
  try {
    const category = acceptanceCase.input.report.categories[0];
    category.log = path.join(acceptanceCase.directory, 'candidate-first.log');
    fs.writeFileSync(category.log, 'new.ts(2): error TS2: new failure');
    category.logHash = suite.hash(fs.readFileSync(category.log));
    category.failures = [suite.categoryFailure(category, acceptanceCase.directory)];
    acceptanceCase.input.policy.dispositions[0].failure = category.failures[0].id;
    assert.throws(() => acceptance.validateAcceptance(acceptanceCase.input), /Base comparison does not reproduce/);
  } finally {
    fs.rmSync(acceptanceCase.directory, { recursive: true, force: true });
  }
});

test('child-origin cancellation stops later collector categories', async () => {
  const fixture = collectionFixture();
  try {
    const launched = [];
    const report = await suite.collectSuite({
      ...fixture.options,
      lanes: fixture.lanes,
      runChecks: async ([entry], options) => {
        launched.push(entry.id);
        options.onResult({ status: 1, signal: 'SIGTERM' });
        return [entry.id];
      },
    });
    assert.deepEqual(launched, ['first']);
    assert.deepEqual(
      report.categories.map((row) => row.status),
      ['cancelled', 'cancelled', 'cancelled'],
    );
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('opposite results with the same affected test name cannot pass acceptance', () => {
  const fixture = acceptanceFixture();
  try {
    const category = fixture.input.report.categories[1];
    category.tests = path.join(fixture.directory, 'duplicate.json');
    fs.writeFileSync(
      category.tests,
      JSON.stringify({
        arcFailureAccounting: 2,
        closureComplete: true,
        testResults: [
          {
            name: path.join(fixture.directory, 'duplicate.test.js'),
            assertionResults: [
              { fullName: 'affected', status: 'passed' },
              { fullName: 'affected', status: 'failed', failureMessages: ['regression'] },
            ],
          },
        ],
      }),
    );
    category.testsHash = suite.hash(fs.readFileSync(category.tests));
    category.failures = suite.failedTests(category.tests, category.id, fixture.directory);
    category.status = 'failed';
    category.exitCode = 1;
    const base = JSON.parse(fs.readFileSync(fixture.baseFile));
    base.categories[1] = {
      ...category,
      sourceStart: { ...category.sourceStart, candidate: fixture.input.base },
      sourceEnd: { ...category.sourceEnd, candidate: fixture.input.base },
    };
    fs.writeFileSync(fixture.baseFile, JSON.stringify(base));
    fixture.input.policy.dispositions.push({
      ...fixture.input.policy.dispositions[0],
      failure: category.failures[0].id,
    });
    for (const disposition of fixture.input.policy.dispositions)
      disposition.evidence.sha256 = suite.hash(fs.readFileSync(fixture.baseFile));
    fixture.input.policy.affectedChecks = [{ category: category.id, file: 'duplicate.test.js', name: 'affected' }];
    assert.throws(() => acceptance.validateAcceptance(fixture.input), /Affected check did not pass/);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('collector timing accounts for every required phase', async () => {
  const fixture = collectionFixture();
  const observations = await import('../extension/test/observations.mjs');
  const events = [];
  try {
    await suite.collectSuite({
      ...fixture.options,
      lanes: fixture.lanes,
      observationFactory: () =>
        observations.createTestObservation({
          cwd: fixture.directory,
          identity: {},
          env: {},
          append: (line) => events.push(JSON.parse(line)),
          announce: () => {},
          processEmitter: fixture.emitter,
        }),
      runChecks: async (_entries, options) => {
        options.onResult({ status: 0 });
        return [];
      },
    });
    assert.equal(events.at(-1).complete, true);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('complete subprocess selection uses the admission argument owner', () => {
  const entry = suite.suiteLanes(repositoryRoot).find((row) => row.id === 'root-subprocess');
  assert.deepEqual(entry.args, lane.subprocessVitestArgs(repositoryRoot));
});

test(
  'installed Vitest retains assertions, multiple hook errors, and unhandled errors together',
  { tags: ['subprocess'] },
  () => {
    const fixture = collectionFixture();
    try {
      fs.writeFileSync(
        path.join(fixture.directory, 'vitest.config.mjs'),
        'export default {test:{globals:true,include:["symptom.test.js"],globalSetup:["./setup.mjs"]}};',
      );
      fs.writeFileSync(
        path.join(fixture.directory, 'setup.mjs'),
        'export default function(project){const close=project.close.bind(project);project.close=async()=>{await close();throw Error("independent project closure failure")}}',
      );
      fs.writeFileSync(
        path.join(fixture.directory, 'symptom.test.js'),
        `
      test('existing assertion',()=>{throw Error('existing assertion failure')});
      afterAll(()=>{throw Error('new teardown failure')});
      describe('second',()=>{afterAll(()=>{throw Error('second teardown failure')});test('passes',()=>{})});
      describe('nested',()=>{afterAll(()=>{throw Error('nested teardown failure')});test('passes',()=>{})});
      test('unhandled',()=>{process.emit('unhandledRejection',new Error('new unhandled failure'),Promise.resolve())});
    `,
      );
      const tests = path.join(fixture.directory, 'results.json');
      const result = spawnSync(
        process.execPath,
        [
          path.join(repositoryRoot, 'node_modules/vitest/vitest.mjs'),
          'run',
          '--root',
          fixture.directory,
          '--config',
          path.join(fixture.directory, 'vitest.config.mjs'),
          '--reporter',
          path.join(repositoryRoot, 'scripts/test-reporter.mjs'),
        ],
        { encoding: 'utf8', env: { ...process.env, ARC_TEST_RESULTS_FILE: tests }, timeout: 20000 },
      );
      assert.ifError(result.error);
      assert.notEqual(result.status, 0);
      const failures = suite.failedTests(tests, 'first', fixture.directory);
      for (const detail of [
        'existing assertion failure',
        'new teardown failure',
        'second teardown failure',
        'nested teardown failure',
        'new unhandled failure',
        'independent project closure failure',
      ])
        assert.ok(
          failures.some((row) => row.detail.includes(detail)),
          detail + '\n' + JSON.stringify(failures, null, 2) + '\n' + result.stdout + result.stderr,
        );
      assert.equal(JSON.parse(fs.readFileSync(tests)).arcFailureAccounting, 2);
    } finally {
      fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
  },
);

// Two native runs distinguish a passing test run from an already failing test run at global teardown.
test('global teardown failures require their own landing dispositions', { tags: ['subprocess'] }, async () => {
  for (const assertionFails of [false, true]) {
    const fixture = collectionFixture();
    try {
      fs.writeFileSync(
        path.join(fixture.directory, 'vitest.config.mjs'),
        'export default {test:{globals:true,include:["symptom.test.js"],globalSetup:["./setup.mjs"]}};',
      );
      fs.writeFileSync(
        path.join(fixture.directory, 'setup.mjs'),
        'export default function(){return ()=>{throw Error("independent global teardown failure")}}',
      );
      fs.writeFileSync(
        path.join(fixture.directory, 'symptom.test.js'),
        assertionFails
          ? 'test("passes",()=>{});test("existing assertion",()=>{throw Error("existing assertion failure")})'
          : 'test("passes",()=>{})',
      );
      const lanes = [
        {
          ...fixture.lanes[0],
          vitest: true,
          args: [
            path.join(repositoryRoot, 'node_modules/vitest/vitest.mjs'),
            'run',
            '--config',
            path.join(fixture.directory, 'vitest.config.mjs'),
          ],
        },
      ];
      const report = await suite.collectSuite({ ...fixture.options, lanes });
      const category = report.categories[0];
      assert.equal(category.status, 'failed', fs.readFileSync(category.log, 'utf8'));
      assert.equal(category.diagnosticsComplete, true);
      const teardown = category.failures.filter((row) => row.detail.includes('independent global teardown failure'));
      assert.equal(teardown.length, 1);
      assert.equal(category.failures.length, assertionFails ? 2 : 1);
      const input = {
        report,
        reportHash: suite.hash(JSON.stringify(report)),
        current: fixture.identity,
        base: fixture.options.base,
        expectedCategories: ['first'],
        expectedLanes: lanes,
        environment: fixture.environment,
      };
      assert.throws(() => acceptance.validateAcceptance(input), /explicit owner-authorized dispositions/);
      if (assertionFails) {
        const original = category.failures.find((row) => row !== teardown[0]);
        input.policy = {
          authority: 'owner-authorized-unrelated-failures',
          candidate: fixture.identity.candidate,
          base: input.base,
          reportHash: input.reportHash,
          affectedChecks: [{ category: 'first', file: 'symptom.test.js', name: 'passes' }],
          dispositions: [{ failure: original.id }],
        };
        assert.throws(() => acceptance.validateAcceptance(input), /exactly one disposition/);
      }
    } finally {
      fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
  }
});

// A lingering handle reaches Vitest's process timeout after all assertions and close promises settle.
test('process closure timeouts retain failures and refuse landing', { tags: ['subprocess'] }, async () => {
  const fixture = collectionFixture();
  try {
    fs.writeFileSync(
      path.join(fixture.directory, 'vitest.config.mjs'),
      'export default {test:{globals:true,teardownTimeout:10,include:["symptom.test.js"],globalSetup:["./setup.mjs"]}};',
    );
    fs.writeFileSync(
      path.join(fixture.directory, 'setup.mjs'),
      'export default function(){setInterval(()=>{},100000)}',
    );
    fs.writeFileSync(path.join(fixture.directory, 'symptom.test.js'), 'test("passes",()=>{})');
    const lanes = [
      {
        ...fixture.lanes[0],
        vitest: true,
        args: [
          path.join(repositoryRoot, 'node_modules/vitest/vitest.mjs'),
          'run',
          '--config',
          path.join(fixture.directory, 'vitest.config.mjs'),
        ],
      },
    ];
    const report = await suite.collectSuite({ ...fixture.options, lanes });
    assert.equal(report.categories[0].status, 'failed');
    assert.equal(report.categories[0].diagnosticsComplete, false);
    assert.match(report.categories[0].failures[0].detail, /process closure timed out/);
    assert.throws(
      () =>
        acceptance.validateAcceptance({
          report,
          current: fixture.identity,
          base: fixture.options.base,
          expectedCategories: ['first'],
          expectedLanes: lanes,
          environment: fixture.environment,
        }),
      /complete test diagnostics/,
    );
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('landing refuses reports finalized before process closure even when assertions passed', () => {
  const fixture = acceptanceFixture();
  try {
    const { input } = fixture;
    input.report.categories = [input.report.categories[1]];
    input.report.selected = ['middle'];
    input.report.exitCode = 0;
    input.expectedCategories = ['middle'];
    input.expectedLanes = [fixture.lanes[1]];
    input.policy = null;
    const category = input.report.categories[0];
    category.tests = path.join(fixture.directory, 'middle.tests.json');
    for (const diagnostics of [
      { arcFailureAccounting: 1, testResults: [] },
      { arcFailureAccounting: 2, closureComplete: false, testResults: [] },
    ]) {
      fs.writeFileSync(category.tests, JSON.stringify(diagnostics));
      category.testsHash = suite.hash(fs.readFileSync(category.tests));
      assert.throws(() => acceptance.validateAcceptance(input), /complete test diagnostics/);
    }
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

const DEAD_PID = 4_000_001;

// Each poll waits for the test to advance the injected clock, so lock and memory waits take no real time.
function suiteLoadFixture(
  directory,
  pid,
  { free = () => 8 * 1024 ** 3, env = {}, now = Date.now, isProcessAlive = (candidate) => candidate !== DEAD_PID } = {},
) {
  const logs = [];
  const polls = [];
  const state = { clock: 0 };
  return {
    logs,
    polls,
    async tick(milliseconds = 10_000) {
      await vi.waitFor(() => assert.ok(polls.length));
      state.clock += milliseconds;
      polls.shift()();
    },
    machineLoad: {
      lockPath: path.join(directory, 'arc-test-suite.lock'),
      pid,
      command: `fixture run ${pid}`,
      env,
      log: (line) => logs.push(line),
      readFree: free,
      isProcessAlive,
      now,
      processEmitter: new EventEmitter(),
      monotonicNow: () => state.clock,
      waitForPoll: () => new Promise((resolve) => polls.push(resolve)),
      staleAfterMs: Infinity,
      scheduleHeartbeat: () => null,
      cancelHeartbeat: () => {},
    },
  };
}

const passingLanes =
  (launched, owner = '') =>
  async ([lane], settings) => {
    launched.push(`${owner}${lane.id}`);
    settings.onResult({ status: 0 });
    return [];
  };

test('a second multi-lane suite waits for the first and names its holder every 30 seconds', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const fixture = collectionFixture();
  // Both collections run in one process and share its environment, so the holder marker cannot admit the second.
  const first = suiteLoadFixture(fixture.directory, 1001);
  const second = suiteLoadFixture(fixture.directory, 1001, { env: first.machineLoad.env });
  const launched = [];
  let finishFirst;
  const firstLane = new Promise((resolve) => {
    finishFirst = resolve;
  });
  const lanes = (owner) => async (entries, settings) => {
    if (owner === 'a:' && entries[0].id === 'first') {
      launched.push('a:first');
      await firstLane;
      settings.onResult({ status: 0 });
      return [];
    }
    return passingLanes(launched, owner)(entries, settings);
  };
  try {
    const running = suite.collectSuite({
      ...fixture.options,
      lanes: fixture.lanes,
      machineLoad: first.machineLoad,
      runChecks: lanes('a:'),
    });
    await vi.waitFor(() => assert.deepEqual(launched, ['a:first']));
    const waiting = suite.collectSuite({
      ...fixture.options,
      reportDir: path.join(fixture.directory, 'second'),
      lanes: fixture.lanes,
      machineLoad: second.machineLoad,
      runChecks: lanes('b:'),
    });
    await vi.waitFor(() => assert.equal(second.polls.length, 1));
    assert.match(
      second.logs[0],
      /^The test suite waits for another run on this machine: PID 1001, started \S+, running fixture run 1001\. 0 ahead in the queue\. Waited 0 s of 40 min\.$/,
    );
    await second.tick();
    await second.tick();
    await second.tick();
    await vi.waitFor(() => assert.equal(second.polls.length, 1));
    assert.equal(second.logs.length, 2);
    assert.match(second.logs[1], /PID 1001, .*Waited 30 s of 40 min\.$/);
    assert.deepEqual(launched, ['a:first']);
    finishFirst();
    assert.equal((await running).exitCode, 0);
    await second.tick();
    assert.equal((await waiting).exitCode, 0);
    assert.deepEqual(launched, ['a:first', 'a:middle', 'a:last', 'b:first', 'b:middle', 'b:last']);
    assert.equal(fs.existsSync(first.machineLoad.lockPath), false);
  } finally {
    finishFirst();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

function queueTickets(lockPath) {
  const queue = `${lockPath}.queue`;
  return fs.existsSync(queue) ? fs.readdirSync(queue).filter((name) => name.endsWith('.json')) : [];
}

test('suites waiting for the machine lock start in arrival order', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const fixture = collectionFixture();
  // The older run has the larger PID, so only its earlier start can put it first.
  const older = suiteLoadFixture(fixture.directory, 1003, { now: () => 1_000 });
  const younger = suiteLoadFixture(fixture.directory, 1002, { now: () => 2_000 });
  const { lockPath } = older.machineLoad;
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 1001, startedAt: 'earlier', command: 'holder' }));
  const launched = [];
  const collect = (load, owner) =>
    suite.collectSuite({
      ...fixture.options,
      reportDir: path.join(fixture.directory, owner),
      lanes: fixture.lanes,
      machineLoad: load.machineLoad,
      runChecks: passingLanes(launched, `${owner}:`),
    });
  try {
    const first = collect(older, 'older');
    await vi.waitFor(() => assert.equal(older.polls.length, 1));
    const second = collect(younger, 'younger');
    await vi.waitFor(() => assert.equal(younger.polls.length, 1));
    assert.match(
      younger.logs[0],
      /^The test suite waits for another run on this machine: PID 1001, started earlier, running holder\. 1 ahead in the queue\. Waited 0 s of 40 min\.$/,
    );
    fs.rmSync(lockPath);
    // The younger run polls first after the release, and it must leave the lock to the older run.
    await younger.tick();
    await vi.waitFor(() => assert.ok(younger.polls.length === 1 || launched.length));
    assert.deepEqual(launched, []);
    await older.tick();
    assert.equal((await first).exitCode, 0);
    await younger.tick();
    assert.equal((await second).exitCode, 0);
    assert.deepEqual(launched, [
      'older:first',
      'older:middle',
      'older:last',
      'younger:first',
      'younger:middle',
      'younger:last',
    ]);
    assert.deepEqual(queueTickets(lockPath), []);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('a waiting suite skips and removes the queue ticket of a run that ended', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const fixture = collectionFixture();
  const living = new Set([1001, 1004, 1005]);
  const isProcessAlive = (pid) => living.has(pid);
  const ended = suiteLoadFixture(fixture.directory, 1004, { now: () => 1_000, isProcessAlive });
  const waiting = suiteLoadFixture(fixture.directory, 1005, { now: () => 2_000, isProcessAlive });
  const { lockPath } = waiting.machineLoad;
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 1001, startedAt: 'earlier', command: 'holder' }));
  const launched = [];
  try {
    suite.collectSuite({
      ...fixture.options,
      reportDir: path.join(fixture.directory, 'ended'),
      lanes: fixture.lanes,
      machineLoad: ended.machineLoad,
      runChecks: passingLanes(launched, 'ended:'),
    });
    await vi.waitFor(() => assert.equal(ended.polls.length, 1));
    const pending = suite.collectSuite({
      ...fixture.options,
      lanes: fixture.lanes,
      machineLoad: waiting.machineLoad,
      runChecks: passingLanes(launched),
    });
    await vi.waitFor(() => assert.equal(waiting.polls.length, 1));
    assert.equal(queueTickets(lockPath).length, 2);
    living.delete(1004);
    fs.rmSync(lockPath);
    await waiting.tick();
    assert.equal((await pending).exitCode, 0);
    assert.deepEqual(launched, ['first', 'middle', 'last']);
    assert.deepEqual(queueTickets(lockPath), []);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('a suite that gives up waiting for the machine lock leaves no queue ticket', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const fixture = collectionFixture();
  const waiting = suiteLoadFixture(fixture.directory, 1006, { env: { ARC_TEST_LOAD_DEADLINE_MINUTES: '1' } });
  const { lockPath } = waiting.machineLoad;
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 1001, startedAt: 'earlier', command: 'holder' }));
  const launched = [];
  try {
    const status = suite.runSuiteCommand({
      ...fixture.options,
      lanes: fixture.lanes,
      machineLoad: waiting.machineLoad,
      runChecks: passingLanes(launched),
    });
    await vi.waitFor(() => assert.equal(waiting.polls.length, 1));
    assert.equal(queueTickets(lockPath).length, 1);
    await waiting.tick(60_000);
    assert.equal(await status, 75);
    assert.deepEqual(launched, []);
    assert.deepEqual(queueTickets(lockPath), []);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('a suite under the memory floor waits before each lane and gives up with its own exit status', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const errors = [];
  vi.spyOn(console, 'error').mockImplementation((line) => errors.push(line));
  const fixture = collectionFixture();
  const events = [];
  const readings = [2, 2, 2, 2];
  const load = suiteLoadFixture(fixture.directory, 1001, {
    free: () => {
      const gigabytes = readings.shift() ?? 8;
      events.push(`read ${gigabytes}`);
      return gigabytes * 1024 ** 3;
    },
  });
  try {
    const pending = suite.collectSuite({
      ...fixture.options,
      lanes: fixture.lanes,
      machineLoad: load.machineLoad,
      runChecks: passingLanes(events, 'launch '),
    });
    for (let poll = 0; poll < 4; poll++) await load.tick();
    assert.equal((await pending).exitCode, 0);
    assert.deepEqual(events, [
      ...Array(4).fill('read 2'),
      'read 8',
      'launch first',
      'read 8',
      'launch middle',
      'read 8',
      'launch last',
    ]);
    assert.deepEqual(load.logs, [
      'The first lane waits for free memory: 2.0 GB free, floor 6.0 GB. Waited 0 s of 40 min.',
      'The first lane waits for free memory: 2.0 GB free, floor 6.0 GB. Waited 30 s of 40 min.',
      'Free memory is 8.0 GB. The first lane starts after 40 s.',
    ]);

    const starved = suiteLoadFixture(fixture.directory, 1002, {
      free: () => 1024 ** 3,
      env: { ARC_TEST_LOAD_DEADLINE_MINUTES: '1' },
    });
    const launched = [];
    const status = suite.runSuiteCommand({
      ...fixture.options,
      reportDir: path.join(fixture.directory, 'starved'),
      lanes: fixture.lanes,
      machineLoad: starved.machineLoad,
      runChecks: passingLanes(launched),
    });
    await starved.tick(60_000);
    assert.equal(await status, 76);
    assert.deepEqual(launched, []);
    assert.match(
      errors[0],
      /^The first lane did not start, because free memory stayed under the 6\.0 GB floor for 1 min\./,
    );
    const report = JSON.parse(fs.readFileSync(path.join(fixture.directory, 'starved', 'suite.json')));
    assert.deepEqual(
      report.categories.map((row) => row.status),
      ['blocked', 'cancelled', 'cancelled'],
    );
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('the suite lock recovers from a dead holder, admits nested and single-lane runs, and times out with its own status', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const errors = [];
  vi.spyOn(console, 'error').mockImplementation((line) => errors.push(line));
  const fixture = collectionFixture();
  const load = suiteLoadFixture(fixture.directory, 1002);
  const { lockPath } = load.machineLoad;
  const hold = (pid) =>
    fs.writeFileSync(lockPath, JSON.stringify({ pid, cwd: '/other', startedAt: 'earlier', command: 'other suite' }));
  const launched = [];
  const run = (name, machineLoad, lanes = fixture.lanes) =>
    suite.runSuiteCommand({
      ...fixture.options,
      reportDir: path.join(fixture.directory, name),
      lanes,
      machineLoad,
      runChecks: passingLanes(launched, `${name}:`),
    });
  try {
    hold(DEAD_PID);
    assert.equal(await run('dead', load.machineLoad), 0);
    assert.deepEqual(load.logs, []);
    assert.equal(fs.existsSync(lockPath), false);

    hold(2002);
    assert.equal(await run('nested', { ...load.machineLoad, env: { ARC_TEST_SUITE_HOLDER: '2002' } }), 0);
    assert.equal(await run('single', load.machineLoad, [fixture.lanes[0]]), 0);
    assert.equal(JSON.parse(fs.readFileSync(lockPath)).pid, 2002);
    assert.equal(launched.length, 7);

    // A live marker that does not own the lock admits nothing.
    const timedOut = run('timeout', {
      ...load.machineLoad,
      env: { ARC_TEST_LOAD_DEADLINE_MINUTES: '1', ARC_TEST_SUITE_HOLDER: '3003' },
    });
    await load.tick(60_000);
    assert.equal(await timedOut, 75);
    assert.equal(launched.length, 7);
    assert.match(
      errors.at(-1),
      /held the machine suite lock for 1 min.*The holder was PID 2002, started earlier, running other suite\./,
    );
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('lanes run at most four Vitest workers whatever the caller asks', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubEnv('VITEST_MAX_WORKERS', '8');
  const seen = [];
  try {
    await defaults.runLanes(
      [
        { label: 'wide', args: ['vitest.mjs', 'run', '--maxWorkers=8'] },
        { label: 'narrow', args: ['vitest.mjs', 'run', '--maxWorkers', '2'], env: { VITEST_MAX_WORKERS: '3' } },
      ],
      async ([lane]) => {
        seen.push([lane.args, lane.env?.VITEST_MAX_WORKERS]);
        return [];
      },
    );
    assert.deepEqual(seen, [
      [['vitest.mjs', 'run', '--maxWorkers=4'], '4'],
      [['vitest.mjs', 'run', '--maxWorkers', '2'], '3'],
    ]);
    const spawned = [];
    const status = await lane.runSubprocessLane(['--maxWorkers=8'], {
      testRoot: repositoryRoot,
      spawn: (_command, args, options) => {
        spawned.push({ args, workers: options.env?.VITEST_MAX_WORKERS });
        const child = new EventEmitter();
        queueMicrotask(() => child.emit('close', 0));
        return child;
      },
    });
    assert.equal(status, 0);
    assert.ok(spawned[0].args.includes('--maxWorkers=4') && !spawned[0].args.includes('--maxWorkers=8'));
    assert.equal(spawned[0].workers, '4');
  } finally {
    vi.unstubAllEnvs();
  }
});

test('every Vitest configuration runs at most four workers', () => {
  const configs = [];
  const walk = (directory, depth) => {
    for (const entry of fs.readdirSync(path.join(repositoryRoot, directory), { withFileTypes: true })) {
      const relative = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth < 3 && !['node_modules', '.git', 'worktrees', 'dist', 'out'].includes(entry.name))
          walk(relative, depth + 1);
      } else if (/^vitest\.config\.[cm]?[jt]s$/.test(entry.name)) configs.push(relative);
    }
  };
  walk('', 0);
  assert.ok(configs.length >= 4, configs.join(', '));
  for (const config of configs) {
    const workers = /\bmaxWorkers:\s*(\d+)/.exec(fs.readFileSync(path.join(repositoryRoot, config), 'utf8'));
    assert.ok(workers && Number(workers[1]) <= 4, `${config} must set maxWorkers to at most 4.`);
  }
});
