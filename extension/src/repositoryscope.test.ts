import { test } from 'vitest';
import assert from 'node:assert';
import type { GitRunner } from './gitcommits.ts';
import { parseWorktreeRoots, RepositoryScope, REPOSITORY_SCOPE_REFRESH_MS } from './repositoryscope.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('worktree porcelain keeps paths verbatim across platforms', () => {
  const output = [
    'worktree C:/Users/dev/work/main',
    'HEAD abc',
    'branch refs/heads/main',
    '',
    'worktree /home/dev/a tree',
    'HEAD def',
    'detached',
    '',
  ].join('\0');
  assert.deepEqual(parseWorktreeRoots(output), ['C:/Users/dev/work/main', '/home/dev/a tree']);
  assert.deepEqual(parseWorktreeRoots(null), []);
});

test('an empty workspace is immediately ready', () => {
  let calls = 0;
  const scope = new RepositoryScope(
    {
      run: async () => {
        calls++;
        return null;
      },
    },
    () => {},
  );
  assert.deepEqual(scope.snapshot([]), { ready: true, revision: 0, roots: [] });
  assert.equal(calls, 0);
});

test('the POSIX filesystem root remains a scope root', async () => {
  const scope = new RepositoryScope({ run: async () => 'worktree /\0\0' }, () => {});
  assert.deepEqual(scope.snapshot(['/']), { ready: false, revision: 0, roots: ['/'] });
  await settle();
  assert.deepEqual(scope.snapshot(['/']), { ready: true, revision: 0, roots: ['/'] });
});

test('repository scope coalesces reads and publishes registered worktrees', async () => {
  const answer = deferred<string | null>();
  const calls: { dir: string; args: string[] }[] = [];
  const runner: GitRunner = {
    run: (dir, args) => {
      calls.push({ dir, args });
      return answer.promise;
    },
  };
  let changed = 0;
  const scope = new RepositoryScope(
    runner,
    () => {
      changed++;
    },
    () => 10,
  );

  assert.deepEqual(scope.snapshot(['C:\\repo']), {
    ready: false,
    revision: 0,
    roots: ['C:\\repo'],
  });
  scope.snapshot(['C:\\repo']);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    dir: 'C:\\repo',
    args: ['worktree', 'list', '--porcelain', '-z'],
  });

  answer.resolve('worktree C:/repo\0HEAD a\0\0worktree D:/trees/topic name\0HEAD b\0\0');
  await settle();
  assert.deepEqual(scope.snapshot(['C:\\repo']), {
    ready: true,
    revision: 1,
    roots: ['C:\\repo', 'D:/trees/topic name'],
  });
  assert.equal(changed, 1);
});

test('a stale answer cannot replace the scope for new workspace folders', async () => {
  const first = deferred<string | null>();
  const second = deferred<string | null>();
  const runner: GitRunner = {
    run: (dir) => (dir === '/one' ? first.promise : second.promise),
  };
  let changed = 0;
  const scope = new RepositoryScope(
    runner,
    () => {
      changed++;
    },
    () => 10,
  );
  scope.snapshot(['/one']);
  assert.equal(scope.snapshot(['/two']).ready, false);

  first.resolve('worktree /one\0\0worktree /one-linked\0\0');
  await settle();
  assert.equal(scope.snapshot(['/two']).ready, false);

  second.resolve('worktree /two\0\0worktree /two-linked\0\0');
  await settle();
  assert.deepEqual(scope.snapshot(['/two']), {
    ready: true,
    revision: 1,
    roots: ['/two', '/two-linked'],
  });
  assert.equal(changed, 1);
});

test('a failed topology refresh retains the last complete roots', async () => {
  let now = 0;
  const answers = [
    Promise.resolve<string | null>('worktree /repo\0\0worktree /linked\0\0'),
    Promise.resolve<string | null>(null),
  ];
  const runner: GitRunner = { run: () => answers.shift()! };
  let changed = 0;
  const scope = new RepositoryScope(
    runner,
    () => {
      changed++;
    },
    () => now,
  );
  scope.snapshot(['/repo']);
  await settle();
  assert.deepEqual(scope.snapshot(['/repo']).roots, ['/linked', '/repo']);

  now += REPOSITORY_SCOPE_REFRESH_MS;
  scope.snapshot(['/repo']);
  await settle();
  assert.deepEqual(scope.snapshot(['/repo']).roots, ['/linked', '/repo']);
  assert.equal(changed, 1);
});

test('one failed folder does not freeze another folder topology', async () => {
  let now = 0;
  let phase = 0;
  const runner: GitRunner = {
    run: async (folder) => {
      if (phase === 0) {
        return folder === '/a' ? 'worktree /a\0\0worktree /a-old\0\0' : 'worktree /b\0\0worktree /b-old\0\0';
      }
      return folder === '/a' ? null : 'worktree /b\0\0worktree /b-new\0\0';
    },
  };
  const scope = new RepositoryScope(
    runner,
    () => {},
    () => now,
  );
  scope.snapshot(['/a', '/b']);
  await settle();
  assert.deepEqual(scope.snapshot(['/a', '/b']).roots, ['/a', '/a-old', '/b', '/b-old']);

  phase = 1;
  now += REPOSITORY_SCOPE_REFRESH_MS;
  scope.snapshot(['/a', '/b']);
  await settle();
  assert.deepEqual(scope.snapshot(['/a', '/b']).roots, ['/a', '/a-old', '/b', '/b-new']);
});

test('changing open folders retains successful roots only for folders still open', async () => {
  let phase = 0;
  const runner: GitRunner = {
    run: async (folder) => {
      if (phase === 0) {
        return `worktree ${folder}\0\0worktree ${folder}-linked\0\0`;
      }
      return folder === '/a' ? null : `worktree ${folder}\0\0worktree ${folder}-linked\0\0`;
    },
  };
  const scope = new RepositoryScope(runner, () => {});
  scope.snapshot(['/a']);
  await settle();
  assert.deepEqual(scope.snapshot(['/a']).roots, ['/a', '/a-linked']);

  phase = 1;
  assert.equal(scope.snapshot(['/a', '/b']).ready, false);
  await settle();
  assert.deepEqual(scope.snapshot(['/a', '/b']).roots, ['/a', '/a-linked', '/b', '/b-linked']);

  assert.equal(scope.snapshot(['/b']).ready, false);
  await settle();
  assert.deepEqual(scope.snapshot(['/b']).roots, ['/b', '/b-linked']);
});

test('a failed initial lookup settles on the literal workspace folder', async () => {
  const runner: GitRunner = { run: async () => null };
  let changed = 0;
  const scope = new RepositoryScope(runner, () => {
    changed++;
  });
  assert.equal(scope.snapshot(['/plain-folder']).ready, false);
  await settle();
  assert.deepEqual(scope.snapshot(['/plain-folder']), {
    ready: true,
    revision: 0,
    roots: ['/plain-folder'],
  });
  assert.equal(changed, 1);
});

test('a later topology change advances the catalog revision', async () => {
  let now = 0;
  const outputs = ['worktree /repo\0\0worktree /old\0\0', 'worktree /repo\0\0worktree /new\0\0'];
  const runner: GitRunner = { run: async () => outputs.shift() ?? null };
  let changed = 0;
  const scope = new RepositoryScope(
    runner,
    () => {
      changed++;
    },
    () => now,
  );
  scope.snapshot(['/repo']);
  await settle();
  assert.equal(scope.snapshot(['/repo']).revision, 1);

  now += REPOSITORY_SCOPE_REFRESH_MS;
  scope.snapshot(['/repo']);
  await settle();
  assert.deepEqual(scope.snapshot(['/repo']), {
    ready: true,
    revision: 2,
    roots: ['/new', '/repo'],
  });
  assert.equal(changed, 2);
});
