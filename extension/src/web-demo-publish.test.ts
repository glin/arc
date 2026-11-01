import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'vitest';
import { tempDir } from './temproot.ts';
import { gitEnvironment, publish, type PublishOptions, type PublishResult } from '../scripts/web-demo-publish.ts';

const SUBPROCESS = { tags: ['subprocess'] };
const SITE = { 'index.html': 'new page\n', 'assets/panel.js': 'panel\n' };

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
    input,
    env: gitEnvironment(),
  }).trim();
}

function bytes(cwd: string, args: string[]): Buffer {
  return execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', env: gitEnvironment() });
}

function ref(cwd: string, name: string): string | null {
  try {
    return git(cwd, ['rev-parse', '--verify', '--quiet', name]);
  } catch {
    return null;
  }
}

interface Fixture {
  directory: string;
  checkout: string;
  remote: string;
  tip: string;
  head: string;
}

let template: (Omit<Fixture, 'directory' | 'checkout' | 'remote'> & { directory: string }) | undefined;

// A checkout with a bare remote named arc that holds main and a one-commit gh-pages.
// Each test copies one template, because every Git process start is slow on Windows.
// The remote URL is relative, so it names the copy's own remote.
function fixture(): Fixture {
  if (!template) {
    const directory = tempDir('web-demo-publish-template-');
    const remote = path.join(directory, 'remote.git');
    const checkout = path.join(directory, 'checkout');
    fs.mkdirSync(remote);
    fs.mkdirSync(checkout);
    git(remote, ['init', '-q', '--bare']);
    git(checkout, ['init', '-q', '-b', 'main']);
    git(checkout, ['config', 'user.name', 'Fixture']);
    git(checkout, ['config', 'user.email', 'fixture@example.invalid']);
    git(checkout, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(checkout, 'source.txt'), 'source\n');
    git(checkout, ['add', 'source.txt']);
    git(checkout, ['commit', '-q', '-m', 'Source']);
    git(checkout, ['remote', 'add', 'arc', '../remote.git']);
    git(checkout, ['push', '-q', 'arc', 'main:main']);
    const page = git(checkout, ['hash-object', '-w', '--stdin'], 'old page\n');
    const empty = git(checkout, ['hash-object', '-w', '--stdin'], '');
    const tree = git(checkout, ['mktree'], `100644 blob ${page}\tindex.html\n100644 blob ${empty}\t.nojekyll\n`);
    const tip = git(checkout, ['commit-tree', tree, '-m', 'docs(demo): first']);
    git(checkout, ['push', '-q', 'arc', `${tip}:refs/heads/gh-pages`]);
    fs.writeFileSync(path.join(checkout, 'notes.txt'), 'untracked\n');
    template = { directory, tip, head: git(checkout, ['rev-parse', 'HEAD']) };
  }
  const directory = tempDir('web-demo-publish-');
  fs.cpSync(template.directory, directory, { recursive: true });
  return {
    directory,
    checkout: path.join(directory, 'checkout'),
    remote: path.join(directory, 'remote.git'),
    tip: template.tip,
    head: template.head,
  };
}

function writeSite(files: Record<string, string>): (site: string) => void {
  return (site) => {
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(site, name)), { recursive: true });
      fs.writeFileSync(path.join(site, name), content);
    }
  };
}

function run(f: Fixture, options: Partial<PublishOptions> = {}): PublishResult {
  return publish({
    root: f.checkout,
    remote: 'arc',
    message: 'publish the fixture',
    push: false,
    build: writeSite(SITE),
    ...options,
  });
}

function published(result: PublishResult): string {
  assert.equal(result.unchanged, false);
  return result.commit;
}

test('the commit has the remote tip as its one parent and holds the site and .nojekyll', SUBPROCESS, () => {
  const f = fixture();
  let site = '';
  const commit = published(
    run(f, {
      build: (folder) => {
        site = folder;
        writeSite(SITE)(folder);
      },
    }),
  );
  assert.equal(git(f.checkout, ['rev-list', '--parents', '-n', '1', commit]), `${commit} ${f.tip}`);
  assert.deepEqual(git(f.checkout, ['ls-tree', '-r', '--name-only', commit]).split('\n'), [
    '.nojekyll',
    'assets/panel.js',
    'index.html',
  ]);
  assert.equal(git(f.checkout, ['show', `${commit}:index.html`]), 'new page');
  assert.equal(git(f.checkout, ['cat-file', '-s', `${commit}:.nojekyll`]), '0');
  assert.equal(ref(f.checkout, 'refs/heads/gh-pages'), commit);
  assert.equal(fs.existsSync(path.dirname(site)), false);
});

test('the commit message has the subject and the full source SHA trailer', SUBPROCESS, () => {
  const f = fixture();
  const result = run(f);
  assert.equal(result.source, f.head);
  assert.equal(
    git(f.checkout, ['log', '-1', '--format=%B', published(result)]),
    `docs(demo): publish the fixture\n\nSource: ${f.head}`,
  );
  assert.equal(git(f.checkout, ['log', '-1', '--format=%(trailers:key=Source,valueonly)', published(result)]), f.head);
});

test('a publish leaves the real index and the working tree unchanged', SUBPROCESS, () => {
  const f = fixture();
  const indexFile = path.join(f.checkout, '.git', 'index');
  // A new modification time with the same content makes the index stale, so a status that refreshes it rewrites it.
  const stale = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(path.join(f.checkout, 'source.txt'), stale, stale);
  const index = fs.readFileSync(indexFile);
  published(run(f));
  assert.deepEqual(fs.readFileSync(indexFile), index);
  assert.equal(git(f.checkout, ['--no-optional-locks', 'status', '--porcelain=v1']), '?? notes.txt');
  assert.deepEqual(fs.readdirSync(f.checkout).sort(), ['.git', 'notes.txt', 'source.txt']);
  assert.equal(fs.readFileSync(path.join(f.checkout, 'source.txt'), 'utf8'), 'source\n');
});

test('the commit stores the built bytes with core.autocrlf set', SUBPROCESS, () => {
  const f = fixture();
  git(f.checkout, ['config', 'core.autocrlf', 'true']);
  const page = 'line one\r\nline two\r\n';
  const commit = published(run(f, { build: writeSite({ 'index.html': page }) }));
  assert.deepEqual(bytes(f.checkout, ['cat-file', '-p', `${commit}:index.html`]), Buffer.from(page));
});

test('an unchanged site stops with no commit', SUBPROCESS, () => {
  const f = fixture();
  const result = run(f, { build: writeSite({ 'index.html': 'old page\n' }) });
  assert.deepEqual(result, { unchanged: true, source: f.head });
  assert.equal(ref(f.checkout, 'refs/heads/gh-pages'), null);
});

test.each([
  [
    'a tracked change',
    (f: Fixture) => fs.writeFileSync(path.join(f.checkout, 'source.txt'), 'edited source\n'),
    /Tracked files differ/,
  ],
  [
    'a HEAD that the remote main lacks',
    (f: Fixture) => git(f.checkout, ['commit', '-q', '--allow-empty', '-m', 'Unpushed']),
    /arc\/main does not hold HEAD/,
  ],
] as const)('%s stops before the build and before any commit', SUBPROCESS, (_name, change, error) => {
  const f = fixture();
  change(f);
  let built = false;
  assert.throws(
    () =>
      run(f, {
        build: () => {
          built = true;
        },
      }),
    error,
  );
  assert.equal(built, false);
  assert.equal(ref(f.checkout, 'refs/heads/gh-pages'), null);
  assert.equal(ref(f.remote, 'refs/heads/gh-pages'), f.tip);
});

test.each([
  ['a tracked edit', (f: Fixture) => fs.writeFileSync(path.join(f.checkout, 'source.txt'), 'edited source\n')],
  ['a new commit', (f: Fixture) => git(f.checkout, ['commit', '-q', '--allow-empty', '-m', 'During the build'])],
] as const)('%s during the build stops before any commit', SUBPROCESS, (_name, change) => {
  const f = fixture();
  let site = '';
  assert.throws(
    () =>
      run(f, {
        build: (folder) => {
          site = folder;
          writeSite(SITE)(folder);
          change(f);
        },
      }),
    /The checkout changed during the build/,
  );
  assert.equal(ref(f.checkout, 'refs/heads/gh-pages'), null);
  assert.equal(fs.existsSync(path.dirname(site)), false);
});

test('inherited GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE do not move the commit', SUBPROCESS, () => {
  const f = fixture();
  const decoy = path.join(f.directory, 'decoy');
  fs.mkdirSync(decoy);
  git(decoy, ['init', '-q', '-b', 'main']);
  const strayIndex = path.join(f.directory, 'stray-index');
  const saved = {
    GIT_DIR: process.env.GIT_DIR,
    GIT_WORK_TREE: process.env.GIT_WORK_TREE,
    GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
  };
  let result: PublishResult;
  try {
    process.env.GIT_DIR = path.join(decoy, '.git');
    process.env.GIT_WORK_TREE = decoy;
    process.env.GIT_INDEX_FILE = strayIndex;
    result = run(f);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.equal(ref(f.checkout, 'refs/heads/gh-pages'), published(result));
  assert.equal(ref(decoy, 'refs/heads/gh-pages'), null);
  assert.equal(fs.existsSync(strayIndex), false);
});

test('local gh-pages with unpushed work stops, and the branch keeps its commit', SUBPROCESS, () => {
  const f = fixture();
  const local = git(f.checkout, ['commit-tree', `${f.tip}^{tree}`, '-p', f.tip, '-m', 'Unpushed page']);
  git(f.checkout, ['update-ref', 'refs/heads/gh-pages', local]);
  assert.throws(() => run(f), /Local gh-pages holds commits that arc\/gh-pages lacks/);
  assert.equal(ref(f.checkout, 'refs/heads/gh-pages'), local);
});

test('gh-pages checked out in a worktree stops, and the branch keeps its commit', SUBPROCESS, () => {
  const f = fixture();
  git(f.checkout, ['branch', 'gh-pages', f.tip]);
  git(f.checkout, ['worktree', 'add', '-q', path.join(f.directory, 'pages'), 'gh-pages']);
  assert.throws(() => run(f), /A worktree has gh-pages checked out/);
  assert.equal(ref(f.checkout, 'refs/heads/gh-pages'), f.tip);
});

test.each([false, true])('with push %s the remote gh-pages matches the request', SUBPROCESS, (push) => {
  const f = fixture();
  git(f.checkout, ['branch', 'gh-pages', f.tip]);
  const result = run(f, { push });
  const commit = published(result);
  assert.equal(ref(f.checkout, 'refs/heads/gh-pages'), commit);
  assert.equal(ref(f.remote, 'refs/heads/gh-pages'), push ? commit : f.tip);
  assert.deepEqual(
    {
      pushed: result.unchanged ? null : result.pushed,
      command: result.unchanged ? null : result.pushCommand,
    },
    { pushed: push, command: 'git push arc gh-pages:gh-pages' },
  );
});

test('gitEnvironment drops inherited GIT_ keys in any case and keeps the extra keys', () => {
  assert.deepEqual(
    gitEnvironment(
      { Git_Dir: 'dir', git_index_file: 'index', GIT_WORK_TREE: 'tree', PATH: 'bin' },
      { GIT_INDEX_FILE: 'own' },
    ),
    { PATH: 'bin', GIT_INDEX_FILE: 'own' },
  );
});
