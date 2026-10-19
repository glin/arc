const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
const git = (root, ...args) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root) =>
  git(
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--allow-empty',
    '-m',
    'fixture',
  );
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-source-identity-'));
  git(root, 'init');
  commit(root);
  return root;
};

let sourceIdentity;
let root;
let expected;
let worktree;

beforeAll(async () => {
  ({ sourceIdentity } = await import('./source-identity.mjs'));
  root = fixture();
  expected = git(root, 'rev-parse', 'HEAD');
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-source-worktree-'));
  git(root, 'worktree', 'add', '--detach', worktree, expected);
});

test('source identity follows the clean physical checkout', () => {
  assert.deepEqual(sourceIdentity(root), { sourceCommit: expected, dirty: false });
});

test('source identity includes untracked checkout changes and accepts the matching uppercase revision', () => {
  fs.writeFileSync(path.join(root, 'changed'), 'source');
  try {
    assert.deepEqual(sourceIdentity(root, expected.toUpperCase()), { sourceCommit: expected, dirty: true });
  } finally {
    fs.unlinkSync(path.join(root, 'changed'));
  }
});

test('source identity follows a linked worktree root', () => {
  assert.ok(fs.statSync(path.join(worktree, '.git')).isFile());
  assert.deepEqual(sourceIdentity(worktree), { sourceCommit: expected, dirty: false });
});

test('source identity resolves a physical link to a worktree', () => {
  const link = path.join(os.tmpdir(), 'source-worktree-link');
  fs.symlinkSync(worktree, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(sourceIdentity(link), { sourceCommit: expected, dirty: false });
});

test('archive identity ignores an enclosing repository and validates explicit revisions', () => {
  const archive = path.join(root, 'archive');
  fs.mkdirSync(archive);
  const supplied = 'a'.repeat(40);
  assert.deepEqual(sourceIdentity(archive), { sourceCommit: null, dirty: null });
  assert.deepEqual(sourceIdentity(archive, supplied), { sourceCommit: supplied, dirty: null });
  for (const invalid of ['', 'HEAD', 'a'.repeat(39), 'g'.repeat(40), supplied + '\n']) {
    assert.throws(() => sourceIdentity(archive, invalid), /full forty-character hexadecimal source revision/);
  }
  assert.throws(() => sourceIdentity(root, supplied), /conflicts with the source checkout revision/);
});

test('unreadable checkout identity remains unavailable and refuses an unchecked override', async () => {
  const { sourceIdentity } = await import('./source-identity.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-source-unavailable-'));
  fs.mkdirSync(path.join(root, '.git'));
  assert.deepEqual(sourceIdentity(root), { sourceCommit: null, dirty: null });
  assert.throws(() => sourceIdentity(root, 'a'.repeat(40)), /Cannot check ARC_SOURCE_COMMIT/);
});
