const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const repositoryRoot = path.join(__dirname, '..');
const ROOT_TEST_DIRECTORIES = ['plugins', 'scripts', 'test'];
// Files that reach child_process and carry no subprocess tag. Each entry names the reason.
const UNTAGGED_PROCESS_FILES = {
  'test/hooks-smoke.test.js': 'The test:smoke lane runs it. Both root lanes exclude it.',
};

let lane;
beforeAll(async () => {
  lane = await import(pathToFileURL(path.join(__dirname, 'test-subprocess.mjs')).href);
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
    for (const file of ['scripts/test-subprocess.mjs', 'extension/test.mjs', 'scripts/isolated-editor.mjs']) {
      write(file, fs.readFileSync(path.join(repositoryRoot, file), 'utf8'));
    }
    write(
      'extension/test/browserlock.mjs',
      'export async function acquireBrowserLock(){return {release(){}}} export function forwardSignalToChildAndRelease(){return ()=>{}}',
    );
    write(
      'extension/test/browserchannels.mjs',
      'export async function launchAnyBrowser(){throw Error("unexpected browser")}',
    );
    write('extension/src/example.test.ts', '');
    write('node_modules/vitest/vitest.mjs', 'console.log("subprocess entry reached");process.exitCode=7;');
    fs.symlinkSync(physical, linked, 'junction');
    for (const { file, args, status, output } of [
      { file: 'scripts/test-subprocess.mjs', args: [], status: 7, output: /subprocess entry reached/ },
      { file: 'extension/test.mjs', args: ['invalid-mode'], status: 1, output: /Unknown test mode/ },
      { file: 'scripts/isolated-editor.mjs', args: ['invalid-command'], status: 2, output: /Choose a command/ },
    ]) {
      const result = spawnSync(process.execPath, [path.join(linked, file), ...args], { encoding: 'utf8' });
      assert.ifError(result.error);
      assert.equal(result.status, status, `${file}\n${result.stdout}${result.stderr}`);
      assert.match(result.stdout + result.stderr, output);
      const imported = spawnSync(process.execPath, ['--input-type=module', '-'], {
        input: `await import(${JSON.stringify(pathToFileURL(path.join(linked, file)).href)});console.log('import only');`,
        encoding: 'utf8',
      });
      assert.ifError(imported.error);
      assert.equal(imported.status, 0, imported.stderr);
      assert.equal(imported.stdout.trim(), 'import only');
    }
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
  assert.match(scripts['test:unit'], /npm run test:root && npm run test:subprocess /);
});

test('the GitHub workflow runs both root lanes', () => {
  const workflow = fs.readFileSync(path.join(repositoryRoot, '.github', 'workflows', 'tests.yml'), 'utf8');
  const commands = [...workflow.matchAll(/^\s*run:\s*(\S.*)$/gm)].map((match) => match[1].trim());
  assert.ok(commands.includes('npm run test:root'), 'The workflow must run test:root.');
  assert.ok(commands.includes('npm run test:subprocess'), 'The workflow must run test:subprocess.');
});

test('the subprocess lane takes its own machine-wide lock around Vitest and releases it with the status', async () => {
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
