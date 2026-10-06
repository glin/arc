import { test, vi } from 'vitest';
import assert from 'node:assert';
import type { GitRunner } from './gitcommits.ts';
import {
  parseWorktreeRoots,
  RepositoryScope,
  REPOSITORY_SCOPE_CONFIRM_MS,
  REPOSITORY_SCOPE_FAILED_RECHECKS,
  REPOSITORY_SCOPE_REFRESH_MS,
  type RepositoryScopeDecision,
} from './repositoryscope.ts';

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

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    phase = 1;
    now += REPOSITORY_SCOPE_REFRESH_MS;
    scope.snapshot(['/a', '/b']);
    await settle();
    // The removal of /b-old waits for a second answer, while the new root applies at once.
    assert.deepEqual(scope.snapshot(['/a', '/b']).roots, ['/a', '/a-old', '/b', '/b-new', '/b-old']);
    await vi.advanceTimersByTimeAsync(REPOSITORY_SCOPE_CONFIRM_MS);
    await settle();
    assert.deepEqual(scope.snapshot(['/a', '/b']).roots, ['/a', '/a-old', '/b', '/b-new']);
  } finally {
    vi.useRealTimers();
  }
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
  const outputs = [
    'worktree /repo\0\0worktree /old\0\0',
    'worktree /repo\0\0worktree /new\0\0',
    'worktree /repo\0\0worktree /new\0\0',
  ];
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

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    now += REPOSITORY_SCOPE_REFRESH_MS;
    scope.snapshot(['/repo']);
    await settle();
    assert.deepEqual(scope.snapshot(['/repo']), {
      ready: true,
      revision: 2,
      roots: ['/new', '/old', '/repo'],
    });
    assert.equal(changed, 2);
    await vi.advanceTimersByTimeAsync(REPOSITORY_SCOPE_CONFIRM_MS);
    await settle();
    assert.deepEqual(scope.snapshot(['/repo']), {
      ready: true,
      revision: 3,
      roots: ['/new', '/repo'],
    });
    assert.equal(changed, 3);
  } finally {
    vi.useRealTimers();
  }
});

const porcelain = (roots: string[]) => roots.map((root) => `worktree ${root}\0HEAD a\0`).join('\0') + '\0';

// A scope over one repository whose Git answers come from a script. Each answer lists the main checkout and the named worktrees,
// and null stands for a failed Git read. The scope asks Git again only through its own timers. With a second script, the workspace
// also opens the folder /z, whose answers list /z and the named worktrees, and whose Git read fails once its script runs out.
function scriptedScope(answers: (string[] | null)[], other?: (string[] | null)[]) {
  let now = 0;
  const calls: number[] = [];
  const folders = other ? ['/repo', '/z'] : ['/repo'];
  const runner: GitRunner = {
    run: async (folder) => {
      if (folder === '/z') {
        const next = other?.shift();
        return next ? porcelain(['/z', ...next]) : null;
      }
      calls.push(now);
      const next = answers.shift();
      if (next === undefined) throw new Error('Git was asked more often than the script allows');
      return next === null ? null : porcelain(['/repo', ...next]);
    },
  };
  const decisions: RepositoryScopeDecision[] = [];
  let changed = 0;
  const scope = new RepositoryScope(
    runner,
    () => {
      changed++;
    },
    () => now,
    (decision) => decisions.push(decision),
  );
  return {
    scope,
    calls,
    decisions,
    changed: () => changed,
    roots: () => scope.snapshot(folders).roots,
    // Lets the regular refresh interval pass, then lets the answer it asks for arrive.
    interval: async () => {
      now += REPOSITORY_SCOPE_REFRESH_MS;
      scope.snapshot(folders);
      await settle();
    },
    // Lets the confirmation delay pass without any snapshot, then lets the answer it asks for arrive.
    confirmation: async () => {
      now += REPOSITORY_SCOPE_CONFIRM_MS;
      await vi.advanceTimersByTimeAsync(REPOSITORY_SCOPE_CONFIRM_MS);
      await settle();
    },
  };
}

async function withScopeTimers(run: () => Promise<void>): Promise<void> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    await run();
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
}

const ALL = ['/trees/a', '/trees/b', '/trees/c'];

test('a short worktree list that the next answer restores changes nothing', () =>
  withScopeTimers(async () => {
    const git = scriptedScope([ALL, [], ALL]);
    git.scope.snapshot(['/repo']);
    await settle();
    assert.deepEqual(git.roots(), ['/repo', ...ALL]);
    assert.equal(git.changed(), 1);

    await git.interval();
    assert.deepEqual(git.roots(), ['/repo', ...ALL], 'one short answer removed worktrees');
    assert.equal(git.changed(), 1, 'one short answer announced a scope change');

    await git.confirmation();
    assert.equal(git.calls.length, 3, 'the scope did not ask Git again within the confirmation delay');
    assert.deepEqual(git.roots(), ['/repo', ...ALL]);
    assert.equal(git.changed(), 1, 'the restoring answer announced a scope change');
    assert.deepEqual(
      git.decisions.map(({ decision }) => decision),
      ['accepted', 'held for confirmation', 'discarded'],
    );
    const held = git.decisions[1];
    assert.deepEqual([held.previous.length, held.answered, held.applied.length], [4, ['/repo'], 4]);
    assert.ok(held.stdoutLength > 0);
    assert.deepEqual(git.decisions[2].restored, ALL);
  }));

test('a second answer confirms only the held worktrees it also removes, and holds the ones it newly removes', () =>
  withScopeTimers(async () => {
    // A real worktree removal holds /trees/b and /trees/c, then a short answer lists only the main checkout.
    const git = scriptedScope([ALL, ['/trees/a'], [], []]);
    git.scope.snapshot(['/repo']);
    await settle();
    await git.interval();
    assert.deepEqual(git.roots(), ['/repo', ...ALL]);
    await git.confirmation();
    assert.deepEqual(
      git.roots(),
      ['/repo', '/trees/a'],
      'one answer removed a worktree that no earlier answer removed',
    );
    assert.equal(git.changed(), 2);
    await git.confirmation();
    assert.deepEqual(git.roots(), ['/repo']);
    assert.equal(git.changed(), 3);
    assert.deepEqual(
      git.decisions.map(({ decision }) => decision),
      ['accepted', 'held for confirmation', 'confirmed', 'confirmed'],
    );
    // Confirmation leaves no timer behind, so the next Git read waits for the regular interval.
    await git.confirmation();
    assert.equal(git.calls.length, 4);
  }));

test('an answer that lists part of a held removal again names the restored worktrees', () =>
  withScopeTimers(async () => {
    const git = scriptedScope([ALL, [], ['/trees/a']]);
    git.scope.snapshot(['/repo']);
    await settle();
    await git.interval();
    await git.confirmation();
    assert.deepEqual(git.roots(), ['/repo', '/trees/a']);
    assert.deepEqual(
      git.decisions.map(({ decision }) => decision),
      ['accepted', 'held for confirmation', 'confirmed'],
    );
    assert.deepEqual(git.decisions[2].restored, ['/trees/a'], 'a partial restore named no restored worktree');
    await git.confirmation();
    assert.equal(git.calls.length, 3);
  }));

test('failed Git reads during a held removal ask again soon only a few times', () =>
  withScopeTimers(async () => {
    const git = scriptedScope([ALL, [], null, null, null, null, []]);
    git.scope.snapshot(['/repo']);
    await settle();
    await git.interval();
    for (let index = 0; index < REPOSITORY_SCOPE_FAILED_RECHECKS + 2; index++) await git.confirmation();
    assert.equal(
      git.calls.length,
      3 + REPOSITORY_SCOPE_FAILED_RECHECKS,
      'failed reads kept asking Git at the confirmation delay',
    );
    assert.deepEqual(git.roots(), ['/repo', ...ALL]);
    assert.deepEqual(
      git.decisions.map(({ decision }) => decision),
      ['accepted', 'held for confirmation', 'held after failed reads'],
      'the end of the quick rechecks wrote no record',
    );
    // The regular interval still asks, and its answer confirms the removal.
    await git.interval();
    assert.deepEqual(git.roots(), ['/repo']);
  }));

test('a folder whose Git read always fails does not keep a held removal for another folder', () =>
  withScopeTimers(async () => {
    // /z is not a Git repository, so every read of it fails.
    const git = scriptedScope([ALL, [], ALL, []], []);
    git.scope.snapshot(['/repo', '/z']);
    await settle();
    const everything = ['/repo', ...ALL, '/z'];
    assert.deepEqual(git.roots(), everything);
    await git.interval();
    assert.deepEqual(git.roots(), everything);
    await git.confirmation();
    assert.equal(git.decisions.at(-1)?.decision, 'discarded', 'the full answer left the removal held');
    assert.deepEqual(git.decisions.at(-1)?.restored, ALL);
    await git.interval();
    assert.deepEqual(git.roots(), everything, 'one short answer removed worktrees');
    assert.deepEqual(
      git.decisions.map(({ decision }) => decision),
      ['accepted', 'held for confirmation', 'discarded', 'held for confirmation'],
    );
  }));

test('a failed read keeps the held roots of its folder and names none of them restored', () =>
  withScopeTimers(async () => {
    // /z's answer removes /z/t, then /z's read fails while /repo's answer newly removes /trees/c.
    const git = scriptedScope([ALL, ALL, ['/trees/a', '/trees/b'], ['/trees/a', '/trees/b']], [['/z/t'], [], null, []]);
    git.scope.snapshot(['/repo', '/z']);
    await settle();
    await git.interval();
    await git.confirmation();
    const third = git.decisions[2];
    assert.equal(third.decision, 'held for confirmation');
    assert.deepEqual(third.restored, [], 'a root of a failed folder was named restored');
    assert.deepEqual(git.roots(), ['/repo', ...ALL, '/z', '/z/t']);
    await git.confirmation();
    assert.deepEqual(
      git.roots(),
      ['/repo', '/trees/a', '/trees/b', '/z'],
      'the root held for the failed folder stayed after two answers',
    );
  }));

test('closing the scope or changing folders during a held removal stops its recheck', () =>
  withScopeTimers(async () => {
    const closed = scriptedScope([ALL, []]);
    closed.scope.snapshot(['/repo']);
    await settle();
    await closed.interval();
    assert.equal(vi.getTimerCount(), 1);
    closed.scope.dispose();
    assert.equal(vi.getTimerCount(), 0, 'closing the scope left its recheck');
    await closed.confirmation();
    assert.equal(closed.calls.length, 2);

    const moved = scriptedScope([ALL, [], ['/trees/a']]);
    moved.scope.snapshot(['/repo']);
    await settle();
    await moved.interval();
    moved.scope.snapshot(['/other']);
    assert.equal(vi.getTimerCount(), 0, 'a folder change left the recheck');
    await settle();
    await moved.confirmation();
    assert.equal(moved.calls.length, 3);
    assert.equal(moved.decisions.at(-1)?.decision, 'accepted');
  }));

test('a failed Git read neither confirms nor discards a held removal', () =>
  withScopeTimers(async () => {
    const git = scriptedScope([ALL, [], null, []]);
    git.scope.snapshot(['/repo']);
    await settle();
    await git.interval();
    await git.confirmation();
    assert.deepEqual(git.roots(), ['/repo', ...ALL], 'a failed read confirmed the removal');
    assert.equal(git.decisions.length, 2, 'a failed read decided the held removal');
    await git.confirmation();
    assert.deepEqual(git.roots(), ['/repo']);
    assert.deepEqual(
      git.decisions.map(({ decision }) => decision),
      ['accepted', 'held for confirmation', 'confirmed'],
    );
  }));

test('an answer that adds worktrees applies at once', () =>
  withScopeTimers(async () => {
    const git = scriptedScope([['/trees/a'], ['/trees/a', '/trees/b']]);
    git.scope.snapshot(['/repo']);
    await settle();
    await git.interval();
    assert.deepEqual(git.roots(), ['/repo', '/trees/a', '/trees/b']);
    assert.equal(git.changed(), 2);
    assert.deepEqual(
      git.decisions.map(({ decision }) => decision),
      ['accepted', 'accepted'],
    );
  }));
