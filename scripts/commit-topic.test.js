// @module-tag subprocess
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
const entry = path.join(__dirname, 'commit-topic.mjs');
let root;
const git = (...args) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const guarded = (topic, ...args) =>
  spawnSync(process.execPath, [entry, topic, '--', ...args], { cwd: root, env, encoding: 'utf8' });
const state = () => ({ head: git('rev-parse', 'HEAD'), index: fs.readFileSync(path.join(root, '.git', 'index')) });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-commit-topic-'));
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', path.join(root, 'hooks'));
  fs.writeFileSync(path.join(root, 'source.txt'), 'base');
  git('add', 'source.txt');
  git('commit', '-m', 'base');
  fs.writeFileSync(path.join(root, 'source.txt'), 'candidate');
  git('add', 'source.txt');
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('source main refuses both assigned topics and an assignment to main without changing HEAD or the index', () => {
  const before = state();
  assert.equal(guarded('topic', '-m', 'refused').status, 1);
  assert.equal(guarded('main', '-m', 'refused').status, 1);
  assert.deepEqual(state(), before);
});

test('mismatched and detached checkouts refuse commits without changing HEAD or the index', () => {
  git('switch', '-c', 'topic');
  const before = state();
  assert.equal(guarded('other', '-m', 'refused').status, 1);
  assert.equal(guarded('main', '-m', 'refused').status, 1);
  assert.deepEqual(state(), before);
  git('switch', '--detach');
  assert.equal(guarded('topic', '-m', 'refused').status, 1);
  assert.deepEqual(state(), before);
});

test('assigned topics preserve literal commit arguments, accept corrections, and deliver through a fast-forward', () => {
  git('switch', '-c', 'topic');
  const message = 'test(workflow): literal "quotes" `ticks` $(echo changed) & spaces';
  const result = guarded('topic', '-m', message, '--', 'source.txt');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(git('log', '-1', '--format=%s'), message);
  assert.equal(guarded('topic', '--allow-empty', '-m', 'test(workflow): correction').status, 0);
  const candidate = git('rev-parse', 'HEAD');
  git('switch', 'main');
  git('merge', '--ff-only', 'topic');
  assert.equal(git('rev-parse', 'HEAD'), candidate);
});

test('commit failures retain the Git exit status and normal quality hooks', () => {
  git('switch', '-c', 'topic');
  const hooks = path.join(root, 'hooks');
  fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const before = state();
  assert.equal(guarded('topic', '-m', 'refused by hook').status, 1);
  assert.equal(git('rev-parse', 'HEAD'), before.head);
  fs.unlinkSync(path.join(hooks, 'pre-commit'));
  assert.equal(guarded('topic', '--invalid-commit-option').status, 129);
  assert.equal(git('rev-parse', 'HEAD'), before.head);
});

test('Git checkout and index environment overrides refuse commits', () => {
  git('switch', '-c', 'topic');
  const before = state();
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) {
    const result = spawnSync(process.execPath, [entry, 'topic', '--', '-m', 'refused'], {
      cwd: root,
      env: { ...env, [key]: path.join(root, '.git') },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`Unset ${key}`));
    assert.deepEqual(state(), before);
  }
});
