// @module-tag subprocess
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
  assert.deepEqual(sourceIdentity(root, expected, 'false'), { sourceCommit: expected, dirty: false });
  assert.throws(() => sourceIdentity(root, expected, 'true'), /conflicts with the source checkout state/);
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
  assert.deepEqual(sourceIdentity(archive, supplied, 'true'), { sourceCommit: supplied, dirty: true });
  assert.deepEqual(sourceIdentity(archive, supplied, 'false'), { sourceCommit: supplied, dirty: false });
  assert.throws(() => sourceIdentity(archive, undefined, 'true'), /requires ARC_SOURCE_COMMIT/);
  assert.throws(() => sourceIdentity(archive, supplied, 'unknown'), /true or false/);
  for (const invalid of ['', 'HEAD', 'a'.repeat(39), 'g'.repeat(40), supplied + '\n']) {
    assert.throws(() => sourceIdentity(archive, invalid), /full forty-character hexadecimal source revision/);
  }
  assert.throws(() => sourceIdentity(root, supplied), /conflicts with the source checkout revision/);
});

// This build crosses the installer's environment clearing and the staged tree's missing Git metadata.
test('staged local builds retain the selected commit and tracked dirty state', async () => {
  const driver = await import('./test-installer.mjs');
  const checkout = fixture();
  const run = driver.createSandbox();
  try {
    const identityModule = require('node:url').pathToFileURL(path.join(__dirname, 'source-identity.mjs')).href;
    fs.writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ scripts: { build: 'node build.mjs' } }));
    const build = path.join(checkout, 'build.mjs');
    fs.writeFileSync(
      build,
      `import {sourceIdentity} from ${JSON.stringify(identityModule)}; console.log(JSON.stringify(sourceIdentity(import.meta.dirname)));`,
    );
    git(checkout, 'add', '.');
    commit(checkout);
    const expected = git(checkout, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(checkout, 'untracked.txt'), 'private fixture');
    for (const dirty of [false, true]) {
      if (dirty) fs.appendFileSync(build, '\n// Changed source fixture.\n');
      const source = driver.stageSource(run, checkout);
      assert.equal(fs.existsSync(path.join(source, '.git')), false);
      assert.equal(fs.existsSync(path.join(source, 'untracked.txt')), false);
      await driver.npmWrapper(run);
      const text = await driver.execute(
        run,
        driver.bashExecutable(),
        [
          '-c',
          'env -u ARC_SOURCE_COMMIT -u ARC_SOURCE_DIRTY npm run build; status=$?; echo "npm notice fixture trailing stderr" >&2; exit "$status"',
        ],
        { cwd: source },
      );
      assert.ok(text.includes('npm notice fixture trailing stderr'), text);
      const identities = text.split('\n').filter((line) => line.startsWith('{"sourceCommit":'));
      assert.equal(identities.length, 1, text);
      assert.deepEqual(JSON.parse(identities[0]), { sourceCommit: expected, dirty });
    }
    fs.unlinkSync(build);
    const source = driver.stageSource(run, checkout, { include: ['untracked.txt'] });
    assert.equal(fs.existsSync(path.join(source, 'build.mjs')), false);
    assert.equal(fs.readFileSync(path.join(source, 'untracked.txt'), 'utf8'), 'private fixture');
    driver.stageSource(run, checkout, { baseline: expected });
    assert.equal(fs.existsSync(path.join(source, 'build.mjs')), true);
    assert.equal(fs.existsSync(path.join(source, 'untracked.txt')), false);
  } finally {
    driver.cleanupSandbox(run, { list: () => [] });
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});

test('unreadable checkout identity remains unavailable and refuses an unchecked override', async () => {
  const { sourceIdentity } = await import('./source-identity.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-source-unavailable-'));
  fs.mkdirSync(path.join(root, '.git'));
  assert.deepEqual(sourceIdentity(root), { sourceCommit: null, dirty: null });
  assert.throws(() => sourceIdentity(root, 'a'.repeat(40)), /Cannot check ARC_SOURCE_COMMIT/);
});
