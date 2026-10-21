const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
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
let browserLock;
beforeAll(async () => {
  lane = await import(pathToFileURL(path.join(__dirname, 'test-subprocess.mjs')).href);
  defaults = await import(pathToFileURL(path.join(__dirname, 'test-default.mjs')).href);
  units = await import(pathToFileURL(path.join(__dirname, 'test-unit.mjs')).href);
  integration = await import(pathToFileURL(path.join(__dirname, 'test-integration.mjs')).href);
  browserLock = await import('../extension/test/browserlock.mjs');
});

function admissionFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-subprocess-admission-'));
  return {
    root,
    lockPath: path.join(root, 'legacy.lock'),
    slotRootPath: path.join(root, 'slots'),
    legacyOptions: { scheduleHeartbeat: () => null, cancelHeartbeat: () => {} },
    slotOptions: { isProcessAlive: () => true },
  };
}

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

test('command entry points run through a linked checkout', { tags: ['subprocess'] }, () => {
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
      'scripts/test-unit.mjs',
      'scripts/test-integration.mjs',
      'extension/test.mjs',
      'extension/test/observations.mjs',
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
      'export async function launchAnyBrowser(){throw Error("unexpected browser")} export async function acquireBrowserSlot(){throw Error("unexpected slot")}',
    );
    write('extension/src/example.test.ts', '');
    write('node_modules/vitest/vitest.mjs', 'console.log("subprocess entry reached");process.exitCode=7;');
    write(
      'scripts/typecheck-parallel.js',
      'module.exports = {runChecks: async ([lane]) => { console.log(lane.label); return [lane.label]; }};',
    );
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
      { file: 'scripts/test-default.mjs', args: [], status: 1, output: /format:check/ },
      { file: 'scripts/test-unit.mjs', args: [], status: 1, output: /root units/ },
      { file: 'scripts/test-integration.mjs', args: [], status: 1, output: /root subprocess/ },
      { file: 'extension/test.mjs', args: ['invalid-mode'], status: 1, output: /Unknown test mode/ },
      { file: 'scripts/isolated-editor.mjs', args: ['invalid-command'], status: 2, output: /Choose a command/ },
    ]) {
      const timings = path.join(root, 'timings', path.basename(file));
      const env = { ...process.env, ARC_TEST_OBSERVATIONS_DIR: timings, ARC_TEST_OBSERVATION_RUN_ID: 'linked-parent' };
      const result = spawnSync(process.execPath, [path.join(linked, file), ...args], { encoding: 'utf8', env });
      assert.ifError(result.error);
      assert.equal(result.status, status, `${file}\n${result.stdout}${result.stderr}`);
      assert.match(result.stdout + result.stderr, output);
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
  assert.match(scripts['test:smoke'], new RegExp(`vitest run ${lane.SMOKE_TEST_FILE.replace(/\./g, '\\.')}`));
  assert.equal(scripts['test:unit'], 'node scripts/test-unit.mjs');
});

test('both GitHub workflows retain complete categories', () => {
  const workflow = fs.readFileSync(path.join(repositoryRoot, '.github', 'workflows', 'tests.yml'), 'utf8');
  const commands = [...workflow.matchAll(/^\s*run:\s*(\S.*)$/gm)].map((match) => match[1].trim());
  assert.ok(commands.includes('npm run test:unit'), 'The workflow must run test:unit.');
  assert.ok(commands.includes('npm run test:integration'), 'The workflow must run test:integration.');
  assert.match(workflow, /npm --prefix extension run test:browser/);
  const candidate = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/vsix-candidate.yml'), 'utf8');
  assert.match(candidate, /^\s*- run: npm run test:all\s*$/m);
});

test('the default runs direct units and the complete command adds every integration category', () => {
  const scripts = readScripts();
  assert.equal(scripts.test, 'node scripts/test-default.mjs');
  assert.deepEqual(
    defaults.defaultLanes(repositoryRoot, 'npm-cli.js').map((entry) => entry.args),
    [
      ['npm-cli.js', 'run', 'format:check'],
      ['npm-cli.js', 'run', 'lint'],
      ['npm-cli.js', 'run', 'typecheck'],
      ['npm-cli.js', 'run', 'test:unit'],
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
  assert.equal(scripts['test:all'], 'npm test && node scripts/test-integration.mjs --browser');
  const groups = integration.integrationLanes(repositoryRoot, true, 'npm-cli.js');
  assert.deepEqual(
    groups.map((entry) => entry.args),
    [
      ['npm-cli.js', 'run', 'test:subprocess'],
      ['npm-cli.js', '--prefix', 'extension', 'run', 'test:integration'],
      ['npm-cli.js', 'run', 'test:panel-mockup'],
      ['npm-cli.js', 'run', 'test:smoke'],
      ['npm-cli.js', 'run', 'test:browser'],
    ],
  );
  assert.deepEqual(integration.integrationLanes(repositoryRoot, false, 'npm-cli.js'), groups.slice(0, -1));
  const extension = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'extension/package.json'))).scripts;
  assert.equal(extension['test:integration'], 'node test.mjs node --tags-filter=subprocess');
  const cli = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'cli/package.json'))).scripts;
  assert.equal(cli['test:unit'], 'vitest run --tags-filter=!subprocess --exclude "test/smoke.bundled-*.test.mjs"');
  assert.equal(cli['test:smoke'], 'npm run build && vitest run --tags-filter=subprocess');
});

test('stages run sequentially and stop after a failure', async () => {
  const started = [];
  let finish;
  const first = new Promise((resolve) => {
    finish = resolve;
  });
  const pending = defaults.runLanes([{ label: 'first' }, { label: 'second' }, { label: 'third' }], async ([entry]) => {
    started.push(entry.label);
    if (entry.label === 'first') await first;
    return entry.label === 'second' ? ['second'] : [];
  });
  assert.deepEqual(started, ['first']);
  finish();
  assert.deepEqual(await pending, ['second']);
  assert.deepEqual(started, ['first', 'second']);
});

test.each(['default', 'unit', 'integration'])('%s lanes publish child output before close', async (wrapper) => {
  const output = [];
  const errors = [];
  const children = [];
  const started = [];
  const selected =
    wrapper === 'default'
      ? defaults.defaultLanes(repositoryRoot, 'npm-cli.js').slice(-1)
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
        if (args.includes('test:unit')) {
          defaults
            .runLanes(units.unitLanes(repositoryRoot), (nested, nestedOptions) =>
              run(
                nested,
                nestedOptions,
                (chunk) => child.stdout.emit('data', chunk),
                (chunk) => child.stderr.emit('data', chunk),
              ),
            )
            .then((failed) => child.emit('close', failed.length ? 1 : 0));
        } else children.push(child);
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
  assert.deepEqual(await pending, [selected[0].label]);
  assert.equal(started.length, active);
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

test('the subprocess lane holds a machine-wide place around Vitest and releases it with the status', async () => {
  const events = [];
  const child = new EventEmitter();
  const code = await lane.runSubprocessLane(['scripts/example.test.js'], {
    testRoot: repositoryRoot,
    acquireLock: async (options) => {
      events.push(['acquired', options.lockPath, options.deadlineMs, options.label]);
      return {
        release() {
          events.push(['released']);
          return true;
        },
      };
    },
    spawn: (command, args) => {
      events.push(['spawned', args.at(-1)]);
      queueMicrotask(() => child.emit('close', 7));
      return child;
    },
  });
  assert.equal(code, 7);
  assert.deepEqual(events, [
    ['acquired', lane.SUBPROCESS_LOCK_PATH, lane.SUBPROCESS_LOCK_DEADLINE_MS, 'subprocess'],
    ['spawned', 'scripts/example.test.js'],
    ['released'],
  ]);
  assert.ok(
    lane.SUBPROCESS_LOCK_DEADLINE_MS >= 3 * 60 * 60_000,
    'A queue of lanes on a loaded machine waits for hours.',
  );
  assert.notEqual(lane.SUBPROCESS_LOCK_PATH, path.join(os.tmpdir(), 'arc-browser-tests.lock'));
});

test('three subprocess lanes enter and a fourth waits without replacing live owners', async () => {
  assert.equal(lane.SUBPROCESS_LANE_COUNT, 3);
  const fixture = admissionFixture();
  const permits = [];
  let clock = 0;
  let polls = 0;
  try {
    for (let index = 0; index < 3; index++) permits.push(await lane.acquireSubprocessSlot(fixture));
    const legacyText = fs.readFileSync(fixture.lockPath, 'utf8');
    const lastOwner = fs.readFileSync(path.join(fixture.slotRootPath, 'slot-2', 'owner.json'), 'utf8');
    permits.push(
      await lane.acquireSubprocessSlot({
        ...fixture,
        monotonicNow: () => clock,
        waitForPoll: async (milliseconds) => {
          polls++;
          assert.equal(fs.readFileSync(fixture.lockPath, 'utf8'), legacyText);
          assert.equal(fs.readFileSync(path.join(fixture.slotRootPath, 'slot-2', 'owner.json'), 'utf8'), lastOwner);
          permits[1].release();
          clock += milliseconds;
        },
      }),
    );
    assert.equal(polls, 1);
    assert.equal(permits[3].index, 1);
  } finally {
    for (const permit of permits) permit.release();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('an owned legacy entry point consumes one place alongside two new subprocess lanes', async () => {
  const fixture = admissionFixture();
  const permits = [];
  let polls = 0;
  try {
    permits.push(await browserLock.acquireBrowserLock({ ...fixture.legacyOptions, lockPath: fixture.lockPath }));
    permits.push(await lane.acquireSubprocessSlot(fixture), await lane.acquireSubprocessSlot(fixture));
    permits.push(
      await lane.acquireSubprocessSlot({
        ...fixture,
        waitForPoll: async () => {
          polls++;
          permits[0].release();
        },
      }),
    );
    assert.equal(polls, 1);
    assert.equal(permits[3].index, undefined);
    assert.equal(fs.existsSync(fixture.lockPath), true);
  } finally {
    for (const permit of permits) permit.release();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a subprocess counted place recovers a dead owner without retiring an existing legacy lock', async () => {
  const fixture = admissionFixture();
  const legacyText = JSON.stringify({ pid: 12345, cwd: '/legacy', startedAt: 'earlier' });
  fs.writeFileSync(fixture.lockPath, legacyText);
  const slot = path.join(fixture.slotRootPath, 'slot-1');
  fs.mkdirSync(slot, { recursive: true });
  fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ pid: 23456, token: 'dead' }));
  let permit;
  try {
    permit = await lane.acquireSubprocessSlot({
      ...fixture,
      legacyOptions: { ...fixture.legacyOptions, isProcessAlive: () => false },
      slotOptions: { isProcessAlive: () => false },
    });
    assert.equal(permit.index, 1);
    assert.equal(fs.readFileSync(fixture.lockPath, 'utf8'), legacyText);
    assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'), 'utf8')).pid, process.pid);
  } finally {
    permit?.release();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test.each(['publication', 'claim'])('subprocess admission preserves an ambiguous counted %s', async (state) => {
  const fixture = admissionFixture();
  const permits = [];
  const slot = path.join(fixture.slotRootPath, 'slot-2');
  try {
    permits.push(await lane.acquireSubprocessSlot(fixture), await lane.acquireSubprocessSlot(fixture));
    fs.mkdirSync(slot);
    if (state === 'claim') {
      fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ pid: 1300, token: 'dead' }));
      fs.mkdirSync(path.join(slot, '.claim-stale-dead'));
    }
    const before = fs.readdirSync(slot);
    await assert.rejects(
      lane.acquireSubprocessSlot({
        ...fixture,
        deadlineMs: 0,
        slotOptions: { now: () => Date.now() + 10_000, isProcessAlive: (pid) => pid !== 1300 },
      }),
      /Timed out waiting for one of 3 subprocess test places/,
    );
    assert.deepEqual(fs.readdirSync(slot), before);
    if (state === 'claim')
      assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'), 'utf8')).token, 'dead');
  } finally {
    for (const permit of permits) permit.release();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test.each(['live', 'dead', 'incomplete'])(
  'a full subprocess pool preserves a %s legacy lock through the monotonic deadline',
  async (owner) => {
    const fixture = admissionFixture();
    const permits = [];
    let clock = 0;
    const waits = [];
    try {
      const legacyText = owner === 'incomplete' ? '' : JSON.stringify({ pid: 12345 });
      fs.writeFileSync(fixture.lockPath, legacyText);
      for (let index = 0; index < 2; index++) permits.push(await lane.acquireSubprocessSlot(fixture));
      await assert.rejects(
        lane.acquireSubprocessSlot({
          ...fixture,
          deadlineMs: 750,
          monotonicNow: () => clock,
          legacyOptions: { ...fixture.legacyOptions, isProcessAlive: () => owner === 'live' },
          waitForPoll: async (milliseconds) => {
            waits.push(milliseconds);
            clock += milliseconds;
          },
        }),
        /Timed out waiting for one of 3 subprocess test places/,
      );
      assert.deepEqual(waits, [500, 250]);
      assert.equal(fs.readFileSync(fixture.lockPath, 'utf8'), legacyText);
    } finally {
      for (const permit of permits) permit.release();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  },
);

test.each(['legacy', 'counted', 'legacy-replaced', 'counted-replaced', 'timeout', 'cancelled'])(
  'combined subprocess admission retains one queue interval and resource events for %s',
  async (mode) => {
    const fixture = admissionFixture();
    const permits = [];
    const events = [];
    let clock = 0;
    const observation = {
      begin: (phase, detail) => events.push(['begin', phase, detail]),
      end: (phase, detail) => events.push(['end', phase, detail]),
      event: (phase, event, detail) => events.push([event, phase, detail]),
    };
    try {
      const waiting = mode === 'timeout' || mode === 'cancelled';
      const counted = mode.startsWith('counted');
      const occupied = waiting ? 3 : counted ? 1 : 0;
      for (let index = 0; index < occupied; index++) permits.push(await lane.acquireSubprocessSlot(fixture));
      const acquire = lane.acquireSubprocessSlot({
        ...fixture,
        observation,
        monotonicNow: () => clock,
        now: () => 1_700_000_000_000 + clock,
        deadlineMs: 750,
        waitForPoll: async (milliseconds) => {
          if (mode === 'cancelled') throw new Error('Admission cancelled');
          clock += milliseconds;
        },
      });
      if (waiting) {
        await assert.rejects(acquire, mode === 'cancelled' ? /Admission cancelled/ : /Timed out/);
        const holderEvents = events.filter(([event]) => event === 'holders');
        assert.equal(holderEvents.length, 1);
        assert.equal(holderEvents[0][2].holders.length, 3);
        assert.equal(holderEvents[0][2].queuePosition, null);
        assert.ok(holderEvents[0][2].holders.every(({ owner }) => owner.pid === process.pid));
        assert.equal(events.filter(([event]) => event === 'acquired' || event === 'release').length, 0);
        assert.match(events.find(([event]) => event === 'end')[2].error, /cancelled|Timed out/);
      } else {
        const permit = await acquire;
        permits.push(permit);
        if (mode.endsWith('replaced')) {
          if (counted)
            fs.writeFileSync(
              path.join(fixture.slotRootPath, 'slot-1', 'owner.json'),
              JSON.stringify({ pid: process.pid, token: 'replacement' }),
            );
          else fs.writeFileSync(fixture.lockPath, JSON.stringify({ pid: process.pid + 1 }));
        }
        assert.equal(permit.release(), !mode.endsWith('replaced'));
        assert.equal(permit.release(), false);
        const resources = events.filter(([, phase]) => phase === 'resource');
        assert.deepEqual(
          resources.map(([event]) => event),
          ['acquired', 'release'],
        );
        assert.equal(resources[1][2].released, !mode.endsWith('replaced'));
        assert.equal(resources[1][2].heldMs, 0);
        assert.equal(
          counted ? resources[0][2].rootPath : resources[0][2].lockPath,
          counted ? fixture.slotRootPath : fixture.lockPath,
        );
      }
      assert.deepEqual(
        events
          .filter(([, phase]) => phase === 'queue')
          .filter(([event]) => event === 'begin' || event === 'end')
          .map(([event]) => event),
        ['begin', 'end'],
      );
    } finally {
      for (const permit of permits) permit.release();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  },
);
