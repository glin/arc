import { test } from 'vitest';
import assert from 'node:assert';
import * as path from 'node:path';
import { ConfigWatches, type WatchKind } from './configwatch.ts';

interface Registration {
  base: string;
  pattern: string;
  listener: (kind: WatchKind, path: string) => void;
  disposed: boolean;
}

function harness(
  rules: path.PlatformPath,
  isDirectory: (target: string) => Promise<boolean> = async () => false,
  ignoreCase = rules === path.win32,
) {
  const registered: Registration[] = [];
  let invalidated = 0;
  const watches = new ConfigWatches({
    watch(base, pattern, listener) {
      const registration: Registration = { base, pattern, listener, disposed: false };
      registered.push(registration);
      return {
        dispose() {
          registration.disposed = true;
        },
      };
    },
    isDirectory,
    invalidate() {
      invalidated++;
    },
    path: rules,
    ignoreCase,
  });
  const live = () => registered.filter((registration) => !registration.disposed);
  const at = (base: string) => {
    const found = live().filter((registration) => registration.base === base);
    assert.equal(found.length, 1, `one live watch on ${base}`);
    return found[0];
  };
  return { watches, registered, live, at, invalidations: () => invalidated };
}

// Lets every pending existence check finish before the test reads the registrations.
const settle = () => new Promise((resolve) => setImmediate(resolve));

// The editor watches the base of a pattern recursively when the pattern holds `/` or `**`.
const recursive = (pattern: string) => pattern.includes('/') || pattern.includes('**');

test('each platform watches every ancestor up to its root with non-recursive patterns only', async () => {
  const cases = [
    {
      name: 'Linux',
      rules: path.posix,
      cwd: '/home/u/work/repo',
      existing: '/home/u/.claude',
      folders: ['/home/u/work/repo', '/home/u/work', '/home/u', '/home', '/'],
    },
    {
      name: 'macOS',
      rules: path.posix,
      cwd: '/Users/U/Work/Repo',
      existing: '/Users/U/.codex',
      folders: ['/Users/U/Work/Repo', '/Users/U/Work', '/Users/U', '/Users', '/'],
    },
    {
      name: 'Windows',
      rules: path.win32,
      cwd: 'C:\\Users\\U\\Repo',
      existing: 'C:\\Users\\U\\.claude',
      folders: ['C:\\Users\\U\\Repo', 'C:\\Users\\U', 'C:\\Users', 'C:\\'],
    },
    { name: 'Windows drive root', rules: path.win32, cwd: 'D:\\', existing: 'D:\\.codex', folders: ['D:\\'] },
    {
      name: 'UNC',
      rules: path.win32,
      cwd: '\\\\server\\share\\dir',
      existing: '\\\\server\\share\\.claude',
      folders: ['\\\\server\\share\\dir', '\\\\server\\share\\'],
    },
  ];
  for (const { name, rules, cwd, existing, folders } of cases) {
    const { watches, registered } = harness(rules, async (target) => target === existing);
    watches.update([cwd]);
    await settle();
    const folderWatches = registered.filter((registration) => registration.pattern === '{.claude,.codex}');
    assert.deepEqual(
      folderWatches.map((registration) => registration.base),
      folders,
      name,
    );
    const inner = registered.filter((registration) => registration.pattern !== '{.claude,.codex}');
    assert.deepEqual(
      inner.map((registration) => registration.base),
      [existing],
      name,
    );
    assert.deepEqual(
      registered.filter((registration) => recursive(registration.pattern)),
      [],
      name,
    );
  }
});

test('Windows folders compare without case and posix folders keep case', () => {
  const windows = harness(path.win32);
  windows.watches.update(['C:\\Work\\a', 'c:\\work\\b']);
  assert.deepEqual(
    windows.registered.map((registration) => registration.base),
    ['C:\\Work\\a', 'C:\\Work', 'C:\\', 'c:\\work\\b'],
  );
  const posix = harness(path.posix);
  posix.watches.update(['/Work/a', '/work/b']);
  assert.deepEqual(
    posix.registered.map((registration) => registration.base),
    ['/Work/a', '/Work', '/', '/work/b', '/work'],
  );
});

test('a configuration directory created after the first check gets its own watch', async () => {
  const existing = new Set<string>();
  const { watches, live, at, invalidations } = harness(path.posix, async (target) => existing.has(target));
  watches.update(['/repo']);
  await settle();
  assert.deepEqual(
    live().map((registration) => registration.base),
    ['/repo', '/'],
  );
  const folder = at('/repo');

  folder.listener('create', '/repo/unrelated');
  assert.equal(invalidations(), 0);

  existing.add('/repo/.claude');
  folder.listener('create', '/repo/.claude');
  assert.equal(invalidations(), 1);
  const settings = at('/repo/.claude');
  assert.equal(settings.pattern, 'settings*.json');

  settings.listener('change', '/repo/.claude/settings.json');
  settings.listener('create', '/repo/.claude/settings.local.json');
  settings.listener('delete', '/repo/.claude/settings.local.json');
  assert.equal(invalidations(), 4);

  folder.listener('change', '/repo/.claude');
  await settle();
  assert.equal(invalidations(), 4, 'a write inside a watched directory does not invalidate twice');

  existing.delete('/repo/.claude');
  folder.listener('delete', '/repo/.claude');
  assert.equal(invalidations(), 5);
  assert.equal(settings.disposed, true);

  folder.listener('change', '/repo/.claude');
  await settle();
  assert.equal(invalidations(), 5, 'a change on a missing directory does not invalidate');

  existing.add('/repo/.claude');
  folder.listener('change', '/repo/.claude');
  await settle();
  assert.equal(invalidations(), 6, 'a merged delete and create restores the watch');
  assert.equal(at('/repo/.claude').pattern, 'settings*.json');

  existing.add('/repo/.codex');
  folder.listener('create', '/repo/.codex');
  assert.equal(at('/repo/.codex').pattern, 'config.toml');
  assert.equal(invalidations(), 7);
});

test('a check that ends after its folder leaves or after disposal registers nothing', async () => {
  const pending = new Map<string, (found: boolean) => void>();
  const { watches, live } = harness(
    path.posix,
    (target) => new Promise<boolean>((resolve) => pending.set(target, resolve)),
  );
  watches.update(['/a']);
  watches.update(['/b']);
  pending.get('/a/.claude')!(true);
  pending.get('/.claude')!(true);
  await settle();
  assert.deepEqual(
    live().map((registration) => registration.base),
    ['/', '/b', '/.claude'],
  );

  watches.dispose();
  pending.get('/.codex')!(true);
  pending.get('/b/.codex')!(true);
  await settle();
  assert.deepEqual(live(), []);
});

test('a new working directory set keeps shared folders and disposal releases every watch', async () => {
  const { watches, registered, live } = harness(path.posix, async (target) => target === '/x/a/.codex');
  watches.update(['/x/a']);
  await settle();
  assert.deepEqual(
    live().map((registration) => registration.base),
    ['/x/a', '/x', '/', '/x/a/.codex'],
  );

  watches.update(['/x/b']);
  await settle();
  assert.deepEqual(
    registered.filter((registration) => registration.disposed).map((registration) => registration.base),
    ['/x/a', '/x/a/.codex'],
  );
  assert.deepEqual(
    live().map((registration) => registration.base),
    ['/x', '/', '/x/b'],
  );

  watches.dispose();
  assert.deepEqual(live(), []);
  const count = registered.length;
  watches.update(['/y']);
  await settle();
  assert.equal(registered.length, count);
});

test('configuration directory events compare without case on Windows and macOS only', () => {
  const cases = [
    {
      name: 'Windows',
      rules: path.win32,
      ignoreCase: true,
      folder: 'C:\\Repo',
      event: 'C:\\Repo\\.CLAUDE',
      inner: ['C:\\Repo\\.claude'],
    },
    {
      name: 'macOS',
      rules: path.posix,
      ignoreCase: true,
      folder: '/Users/U/Repo',
      event: '/Users/U/Repo/.Claude',
      inner: ['/Users/U/Repo/.claude'],
    },
    { name: 'Linux', rules: path.posix, ignoreCase: false, folder: '/repo', event: '/repo/.Claude', inner: [] },
  ];
  for (const { name, rules, ignoreCase, folder, event, inner } of cases) {
    const { watches, registered, at, invalidations } = harness(rules, undefined, ignoreCase);
    watches.update([folder]);
    at(folder).listener('create', event);
    assert.deepEqual(
      registered
        .filter((registration) => registration.pattern === 'settings*.json')
        .map((registration) => registration.base),
      inner,
      name,
    );
    assert.equal(invalidations(), inner.length, name);
  }
});

// Lets `turns` microtasks run, so an act after a check resolves lands at each point between the
// check ending and its result being used.
async function afterTurns(turns: number) {
  for (let turn = 0; turn < turns; turn++) await Promise.resolve();
}

test('a removal or disposal while a found result is in flight leaves no watch behind', async () => {
  const acts = {
    removal: (watches: ConfigWatches) => watches.update(['/b']),
    disposal: (watches: ConfigWatches) => watches.dispose(),
  };
  for (const [name, act] of Object.entries(acts)) {
    for (const recheck of [false, true]) {
      for (let turns = 0; turns < 8; turns++) {
        const label = `${name} ${recheck ? 'change check' : 'first check'} after ${turns} turns`;
        const pending = new Map<string, (found: boolean) => void>();
        const { watches, registered, at, invalidations } = harness(
          path.posix,
          (target) => new Promise<boolean>((resolve) => pending.set(target, resolve)),
        );
        watches.update(['/a']);
        if (recheck) {
          pending.get('/a/.claude')!(false);
          await settle();
          at('/a').listener('change', '/a/.claude');
        }
        pending.get('/a/.claude')!(true);
        await afterTurns(turns);
        act(watches);
        await settle();
        watches.dispose();
        assert.deepEqual(
          registered.filter((registration) => !registration.disposed).map((registration) => registration.base),
          [],
          label,
        );
        if (name === 'disposal') {
          const added = registered.some((registration) => registration.base === '/a/.claude');
          assert.equal(invalidations(), recheck && added ? 1 : 0, label);
        }
      }
    }
  }
});

test('a delete that arrives while a check is pending keeps the deleted directory unwatched', async () => {
  for (const recheck of [false, true]) {
    const label = recheck ? 'change check' : 'first check';
    const pending = new Map<string, (found: boolean) => void>();
    const { watches, live, at, invalidations } = harness(
      path.posix,
      (target) => new Promise<boolean>((resolve) => pending.set(target, resolve)),
    );
    watches.update(['/repo']);
    const folder = at('/repo');
    if (recheck) {
      pending.get('/repo/.claude')!(false);
      await settle();
      folder.listener('change', '/repo/.claude');
    }
    folder.listener('delete', '/repo/.claude');
    pending.get('/repo/.claude')!(true);
    await settle();
    assert.deepEqual(
      live().map((registration) => registration.base),
      ['/repo', '/'],
      label,
    );
    assert.equal(invalidations(), 1, label);
  }
});
