// Snapshot store and workspace cache behavior.
import { test, vi } from 'vitest';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempDir } from './temproot.ts';
import { writeFileAtomically } from './atomicfile.ts';
import {
  createWorkspaceCacheRoot,
  readManifest,
  isPathWithin,
  normalizedWorkspaceIdentity,
  sweepOldSessions,
  SNAPSHOT_KEEP_DAYS,
  pendingSessions,
  storeRoot,
  tabLabelMatchesTitle,
  fileDiffersOnDisk,
  workspaceCacheKey,
  WorkspaceCachePartition,
  reclaimFolderlessCaches,
  FOLDERLESS_OWNER_FILE,
  FOLDERLESS_CLEANUP_LIMITS,
  linuxCacheOwnerStatus,
  type CacheOwner,
} from './store.ts';

test('readManifest rejects malformed roots and nested values', () => {
  const dir = tempDir('manifest-');
  const file = path.join(dir, 'manifest.json');
  const valid = {
    sessionId: 'session',
    cwd: null,
    title: 'A session',
    files: [{ path: 'C:\\work\\file.ts', snapshot: 'C:\\store\\baseline', isNew: false }],
  };
  const write = (value: unknown) => fs.writeFileSync(file, JSON.stringify(value));

  write(valid);
  assert.deepEqual(readManifest(file), valid);

  for (const value of [
    null,
    [],
    { ...valid, sessionId: 42 },
    { ...valid, cwd: false },
    { ...valid, title: 42 },
    { ...valid, files: {} },
    { ...valid, files: [null] },
    { ...valid, files: [{ ...valid.files[0], path: '' }] },
    { ...valid, files: [{ ...valid.files[0], snapshot: 42 }] },
    { ...valid, files: [{ ...valid.files[0], isNew: 'false' }] },
  ]) {
    write(value);
    assert.equal(readManifest(file), null);
  }

  fs.writeFileSync(file, '{');
  assert.equal(readManifest(file), null);
});

// A session dir under the store root, aged by its trigger file, holding one file that either
// still differs from its snapshot or matches it.
function makeAgedSession(root: string, name: string, ageDays: number, differs: boolean): void {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'baseline'), { recursive: true });
  const live = path.join(tempDir('wk-'), 'f.txt');
  const snap = path.join(dir, 'baseline', 'k');
  fs.writeFileSync(snap, 'BASE');
  fs.writeFileSync(live, differs ? 'CHANGED' : 'BASE');
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ sessionId: name, cwd: null, files: [{ path: live, snapshot: snap, isNew: false }] }),
  );
  const trig = path.join(dir, 'trigger');
  fs.writeFileSync(trig, '1');
  const t = new Date(Date.now() - ageDays * 86400000);
  fs.utimesSync(trig, t, t);
}

test('sweepOldSessions drops a session past the age cut and keeps one inside it', () => {
  const root = tempDir('arc-');
  makeAgedSession(root, 'old', 30, false);
  makeAgedSession(root, 'recent', 1, false);

  const removed = sweepOldSessions(root, 14, Date.now());
  assert.deepEqual(removed, ['old']);
  assert.equal(fs.existsSync(path.join(root, 'old')), false);
  assert.ok(fs.existsSync(path.join(root, 'recent')));
  assert.deepEqual(sweepOldSessions(root, 0, Date.now()), []); // disabled

  // The default sweep uses SNAPSHOT_KEEP_DAYS.
  const byDefault = tempDir('arc-');
  makeAgedSession(byDefault, 'past', SNAPSHOT_KEEP_DAYS + 10, false);
  makeAgedSession(byDefault, 'inside', SNAPSHOT_KEEP_DAYS - 10, false);
  assert.deepEqual(sweepOldSessions(byDefault), ['past']);
});

test('age alone ends a session, because nothing marks its files kept or reverted any more', () => {
  // Age expiry removes a session even when its live files still differ from the snapshots.

  const root = tempDir('arc-');
  makeAgedSession(root, 'old-and-differing', 30, true);
  makeAgedSession(root, 'recent-and-differing', 1, true);

  assert.deepEqual(sweepOldSessions(root, 14, Date.now()), ['old-and-differing']);
  assert.equal(fs.existsSync(path.join(root, 'old-and-differing')), false);
  assert.ok(fs.existsSync(path.join(root, 'recent-and-differing')));
});

test('read-only Stops renew retention for changed and reverted useful stores', () => {
  const home = tempDir('stop-retention-');
  const root = path.join(home, 'snapshots');
  const work = tempDir('stop-work-');
  const file = path.join(work, 'file.txt');
  const hook = path.join(__dirname, '../../plugins/arc-hooks/scripts/stop-manifest.cjs');
  const capture = path.join(__dirname, '../../plugins/arc-hooks/scripts/pretooluse-snapshot.cjs');
  const env = { ...process.env, ARC_HOME: home, ARC_IGNORE_ROOTS: '' };
  for (const reverted of [false, true]) {
    const session = String(reverted);
    fs.writeFileSync(file, 'BASE');
    execFileSync(process.execPath, [capture], {
      env,
      input: JSON.stringify({ session_id: session, cwd: work, tool_name: 'Edit', tool_input: { file_path: file } }),
    });
    fs.writeFileSync(file, 'EDIT');
    const stop = () =>
      execFileSync(process.execPath, [hook], { env, input: JSON.stringify({ session_id: session, cwd: work }) });
    stop();
    if (reverted) {
      fs.writeFileSync(file, 'BASE');
      stop();
    }
    const dir = path.join(root, session);
    const trigger = path.join(dir, 'trigger');
    const old = new Date(Date.now() - (SNAPSHOT_KEEP_DAYS + 1) * 86400000);
    fs.utimesSync(trigger, old, old);
    stop();
    assert.ok(fs.statSync(trigger).mtimeMs > old.getTime());
    assert.deepEqual(sweepOldSessions(root), []);
    assert.ok(fs.existsSync(path.join(dir, 'baseline')));
    assert.equal(readManifest(path.join(dir, 'manifest.json'))?.files.length, reverted ? 0 : 1);
  }
});

test('fileDiffersOnDisk: size short-circuit, equal-size compare, deleted and missing-snapshot cases', () => {
  const dir = tempDir('fd-');
  const p = (name: string, content: string | Buffer) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, content);
    return f;
  };

  // Different sizes establish a difference without reading file contents.
  assert.equal(fileDiffersOnDisk({ path: p('l1', 'longer'), snapshot: p('s1', 'x'), isNew: false }), true);
  // Equal sizes still require a content comparison.
  assert.equal(fileDiffersOnDisk({ path: p('l2', 'abc'), snapshot: p('s2', 'abd'), isNew: false }), true);
  // Identical contents have no difference.
  assert.equal(fileDiffersOnDisk({ path: p('l3', 'same'), snapshot: p('s3', 'same'), isNew: false }), false);
  // Two empty files have no difference.
  assert.equal(fileDiffersOnDisk({ path: p('l4', ''), snapshot: p('s4', ''), isNew: false }), false);
  // A deleted live file has no current contents to compare.
  assert.equal(fileDiffersOnDisk({ path: path.join(dir, 'gone'), snapshot: p('s5', 'x'), isNew: false }), false);
  // A directory replacing the live file has no file contents to compare.
  const asDir = path.join(dir, 'now-a-dir');
  fs.mkdirSync(asDir);
  assert.equal(fileDiffersOnDisk({ path: asDir, snapshot: p('s5b', 'x'), isNew: false }), false);
  // A missing snapshot supplies an empty baseline.
  assert.equal(fileDiffersOnDisk({ path: p('l6', 'x'), snapshot: path.join(dir, 'nosnap'), isNew: true }), true);
  // A difference after the first read chunk must still be detected.
  const big = Buffer.alloc(3 * 1024 * 1024, 7);
  const bigLive = p('l7', big);
  big[big.length - 1] = 8;
  assert.equal(fileDiffersOnDisk({ path: bigLive, snapshot: p('s7', big), isNew: false }), true);
});

test('tabLabelMatchesTitle matches the dynamic file-count suffix VS Code adds', () => {
  const title = 'Agent changes: ppm2';
  assert.equal(tabLabelMatchesTitle(title, title), true); // exact
  assert.equal(tabLabelMatchesTitle('Agent changes: ppm2 (1 file)', title), true);
  assert.equal(tabLabelMatchesTitle('Agent changes: ppm2 (12 files)', title), true);
  assert.equal(tabLabelMatchesTitle('Agent changes: ppm2-feature (1 file)', title), false); // different session
  assert.equal(tabLabelMatchesTitle('Agent changes: other', title), false);
});

test('isPathWithin matches a cwd inside, equal to, but not a sibling-prefix of a folder', () => {
  // isPathWithin compares with the platform separator, so build paths with path.join
  // rather than hard-coding '/' (which fails on Windows).
  const j = (...seg: string[]) => path.join(path.sep, ...seg);
  assert.equal(isPathWithin(j('home', 'u', 'proj', 'src'), [j('home', 'u', 'proj')]), true);
  assert.equal(isPathWithin(j('home', 'u', 'proj'), [j('home', 'u', 'proj')]), true);
  assert.equal(isPathWithin(j('home', 'u', 'other'), [j('home', 'u', 'proj')]), false);
  assert.equal(isPathWithin(j('home', 'u', 'proj-2'), [j('home', 'u', 'proj')]), false); // sibling prefix, not nested
  assert.equal(isPathWithin(j('home', 'u', 'proj'), []), false);
  assert.equal(isPathWithin('', [j('home', 'u', 'proj')]), false);
  assert.equal(isPathWithin(j('a', 'b'), [j('x'), j('a')]), true); // matches second folder
});

test('pendingSessions returns only in-workspace sessions with pending files, narrowed to those files', () => {
  const root = tempDir('arc-');
  const ws = tempDir('ws-'); // the open workspace folder
  const other = tempDir('other-'); // a different project

  const mk = (
    name: string,
    cwd: string | null,
    fileDir: string,
    specs: { file: string; baseline: string; current: string }[],
  ) => {
    const dir = path.join(root, name);
    const baselineDir = path.join(dir, 'baseline');
    fs.mkdirSync(baselineDir, { recursive: true });
    const entries = specs.map((s, i) => {
      const snap = path.join(baselineDir, `snap${i}`);
      fs.writeFileSync(snap, s.baseline);
      const live = path.join(fileDir, s.file);
      fs.writeFileSync(live, s.current);
      return { path: live, snapshot: snap, isNew: false };
    });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ sessionId: name, cwd, files: entries }, null, 2),
    );
  };

  // Include only the changed file from the matching workspace session.
  mk('a', ws, ws, [
    { file: 'changed.txt', baseline: 'v1', current: 'v2' },
    { file: 'same.txt', baseline: 'k', current: 'k' },
  ]);
  mk('b', ws, ws, [{ file: 'b.txt', baseline: 'x', current: 'x' }]); // All files match their snapshots.
  mk('c', other, other, [{ file: 'c.txt', baseline: 'p', current: 'q' }]); // This session belongs to another workspace.
  mk('d', null, ws, [{ file: 'd.txt', baseline: 'p', current: 'q' }]); // The session has no working directory.

  const sessions = pendingSessions(root, [ws]);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].manifest.sessionId, 'a');
  assert.deepEqual(
    sessions[0].manifest.files.map((f) => path.basename(f.path)),
    ['changed.txt'],
  );

  assert.deepEqual(pendingSessions('/no/such/root', [ws]), []); // A missing store root yields no pending sessions.
});

test('ARC_HOME moves the store root, and snapshots sit below it', () => {
  const previousHome = process.env.ARC_HOME;
  const home = path.join(os.tmpdir(), 'arc-home-fixture');
  try {
    process.env.ARC_HOME = home;
    assert.equal(storeRoot(), path.join(home, 'snapshots'));
    delete process.env.ARC_HOME;
    assert.equal(storeRoot(), path.join(os.homedir(), '.arc', 'snapshots'));
  } finally {
    if (previousHome === undefined) {
      delete process.env.ARC_HOME;
    } else {
      process.env.ARC_HOME = previousHome;
    }
  }
});

// Workspace cache keys identify both the project spend index and derived session cache directories.

test('a workspace cache key keeps its exact value for a known identity', () => {
  assert.equal(
    workspaceCacheKey({ workspaceFile: null, folders: ['c:/work/repo'] }),
    '04a832f31447caa446b9726e4bd80f3e486611349bc482235d15eb6755f53a73',
  );
  assert.equal(
    workspaceCacheKey({ workspaceFile: 'c:/work/repo.code-workspace', folders: ['c:/work/a', 'c:/work/b'] }),
    '4eacfdfb1228c58516dcb5673856a4f34f14c6ff576dcc7f6bc2b437078cba08',
  );
});

test('equivalent workspace roots give one identity and one cache key', () => {
  // A lowercase drive letter names the same folder only where paths ignore case. Elsewhere
  // `C:` is an ordinary relative folder name, and `c:` is a different one.
  const drive = process.platform === 'win32' ? 'c:' : 'C:';
  const plain = normalizedWorkspaceIdentity([path.join('C:', 'Work', 'repo')]);
  const shaped = normalizedWorkspaceIdentity([
    path.join(drive, 'Work', 'repo') + path.sep,
    path.join('C:', 'Work', 'repo'),
  ]);
  assert.deepEqual(shaped, plain);
  assert.equal(workspaceCacheKey(shaped), workspaceCacheKey(plain));
  assert.notEqual(
    workspaceCacheKey(plain),
    workspaceCacheKey(normalizedWorkspaceIdentity([path.join('C:', 'Work', 'other')])),
  );
  assert.equal(workspaceCacheKey(normalizedWorkspaceIdentity([])), null);
});

test('a folderless window gets a fresh cache partition and a workspace reuses its own', () => {
  const root = tempDir('arc-cache-');
  try {
    const cache = path.join(root, 'cache');
    const first = createWorkspaceCacheRoot(cache, normalizedWorkspaceIdentity([]));
    const second = createWorkspaceCacheRoot(cache, normalizedWorkspaceIdentity([]));
    assert.notEqual(first, second, 'a folderless window must not reuse another window partition');
    assert.equal(fs.existsSync(cache), false, 'allocation must not create a cache directory');
    assert.ok(path.basename(first).startsWith('folderless-'));
    const identity = normalizedWorkspaceIdentity([path.join(root, 'repo')]);
    assert.equal(createWorkspaceCacheRoot(cache, identity), createWorkspaceCacheRoot(cache, identity));
    assert.equal(path.basename(createWorkspaceCacheRoot(cache, identity)), workspaceCacheKey(identity));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('folderless activations without writes leave no partitions and publish ownership before cache bytes', () => {
  const cache = path.join(tempDir('lazy-cache-'), 'cache');
  for (let i = 0; i < 100; i++) new WorkspaceCachePartition(cache, normalizedWorkspaceIdentity([])).close();
  assert.equal(fs.existsSync(cache), false);
  const first = new WorkspaceCachePartition(cache, normalizedWorkspaceIdentity([]));
  const second = new WorkspaceCachePartition(cache, normalizedWorkspaceIdentity([]));
  const fileOnly = new WorkspaceCachePartition(cache, { folders: [], workspaceFile: null });
  assert.notEqual(first.root, second.root);
  assert.notEqual(first.root, fileOnly.root);
  const write = (partition: WorkspaceCachePartition, flush = false) =>
    partition.write(() => {
      const owner = JSON.parse(fs.readFileSync(path.join(partition.root, FOLDERLESS_OWNER_FILE), 'utf8'));
      assert.equal(path.basename(partition.root), `folderless-${owner.generation}`);
      fs.writeFileSync(path.join(partition.root, 'data'), owner.generation);
    }, flush);
  write(first);
  write(second);
  assert.notEqual(
    fs.readFileSync(path.join(first.root, 'data'), 'utf8'),
    fs.readFileSync(path.join(second.root, 'data'), 'utf8'),
  );
  first.close(() => {
    assert.equal(
      first.write(() => assert.fail('new admission during flush')),
      false,
    );
    write(first, true);
  });
  assert.equal(
    first.write(() => assert.fail('closed admission')),
    false,
  );
  const old = first.root;
  first.resume();
  assert.notEqual(first.root, old);
  assert.equal(fs.existsSync(first.root), false);
  write(first);
  assert.ok(fs.existsSync(path.join(old, 'released.json')));
  first.close();
  second.close();
  fileOnly.close();
});

function ownedCacheFixture(cache: string, released = false): WorkspaceCachePartition {
  const partition = new WorkspaceCachePartition(cache, normalizedWorkspaceIdentity([]));
  partition.write(() => fs.writeFileSync(path.join(partition.root, 'data'), 'kept'));
  if (released) partition.close();
  return partition;
}

test('folderless cleanup preserves live, legacy, ambiguous, oversized and linked owners and shared caches', async () => {
  const cache = tempDir('retained-cache-');
  const active = ownedCacheFixture(cache);
  const uncertain = ownedCacheFixture(cache);
  const oversized = ownedCacheFixture(cache);
  fs.writeFileSync(
    path.join(oversized.root, FOLDERLESS_OWNER_FILE),
    'x'.repeat(FOLDERLESS_CLEANUP_LIMITS.ownerBytes + 1),
  );
  const invalid = ownedCacheFixture(cache);
  fs.writeFileSync(path.join(invalid.root, FOLDERLESS_OWNER_FILE), '{}');
  const legacy = path.join(cache, 'folderless-legacy');
  fs.mkdirSync(legacy);
  const missing = new WorkspaceCachePartition(cache, normalizedWorkspaceIdentity([]));
  fs.mkdirSync(missing.root);
  const hashed = createWorkspaceCacheRoot(cache, normalizedWorkspaceIdentity([cache]));
  fs.mkdirSync(hashed);
  fs.writeFileSync(path.join(cache, 'codex-openings.json'), 'shared');
  const stopped = ownedCacheFixture(cache, true);
  const linked = ownedCacheFixture(cache, true);
  const outside = tempDir('cache-link-target-');
  fs.writeFileSync(path.join(outside, 'precious'), 'kept');
  fs.symlinkSync(outside, path.join(linked.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const linkedWriter = ownedCacheFixture(cache);
  fs.symlinkSync(outside, path.join(linkedWriter.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(
    () =>
      linkedWriter.write(
        () => assert.fail('write through linked descendant'),
        false,
        path.join(linkedWriter.root, 'linked', 'data'),
      ),
    /linked folder or file/,
  );
  await reclaimFolderlessCaches(cache, {
    platform: 'linux',
    signal: new AbortController().signal,
    inspect: async (owner) => (owner.generation === path.basename(active.root).slice(11) ? 'live' : 'uncertain'),
  });
  assert.ok(fs.existsSync(stopped.root));
  for (const root of [
    active.root,
    uncertain.root,
    oversized.root,
    invalid.root,
    missing.root,
    legacy,
    hashed,
    linked.root,
  ])
    assert.ok(fs.existsSync(root), root);
  assert.equal(fs.readFileSync(path.join(outside, 'precious'), 'utf8'), 'kept');
  assert.equal(fs.readFileSync(path.join(cache, 'codex-openings.json'), 'utf8'), 'shared');
  for (const platform of ['win32', 'darwin'] as const) {
    const retained = ownedCacheFixture(cache, true);
    await reclaimFolderlessCaches(cache, {
      platform,
      signal: new AbortController().signal,
      inspect: async () => assert.fail('unsupported lifetime inspection'),
    });
    assert.ok(fs.existsSync(retained.root));
  }
});

test('Linux owner lifetime distinguishes live processes, stopped processes, reused PIDs and namespaces', async () => {
  const owner: CacheOwner = {
    version: 1,
    generation: 'fixture',
    pid: 7,
    platform: 'linux',
    lifetime: { boot: 'boot', namespace: 'pid:[1]', start: '90' },
  };
  const stat = (state: string, start: string) =>
    `7 (name with ) brackets) ${[state, ...Array(18).fill('0'), start].join(' ')}`;
  const observation = { boot: 'boot', namespace: 'pid:[1]', stat: stat('S', '90') };
  assert.equal(linuxCacheOwnerStatus(owner, observation), 'live');
  assert.equal(linuxCacheOwnerStatus(owner, { ...observation, stat: stat('Z', '90') }), 'abandoned');
  assert.equal(linuxCacheOwnerStatus(owner, { ...observation, stat: stat('S', '91') }), 'abandoned');
  assert.equal(linuxCacheOwnerStatus(owner, { ...observation, boot: 'another' }), 'uncertain');
  assert.equal(linuxCacheOwnerStatus(owner, { ...observation, namespace: 'pid:[2]' }), 'uncertain');
  assert.equal(linuxCacheOwnerStatus(owner, { ...observation, stat: '' }), 'uncertain');
  assert.equal(linuxCacheOwnerStatus({ ...owner, lifetime: null }, observation), 'uncertain');
  for (const platform of ['win32', 'darwin'] as const)
    assert.equal(linuxCacheOwnerStatus({ ...owner, platform }, observation), 'uncertain');
  const cache = tempDir('linux-lifetime-cache-');
  const old = ownedCacheFixture(cache);
  const live = ownedCacheFixture(cache);
  const mismatched = ownedCacheFixture(cache);
  const boot = '00000000-0000-0000-0000-000000000000';
  for (const partition of [old, live, mismatched]) {
    fs.writeFileSync(
      path.join(partition.root, FOLDERLESS_OWNER_FILE),
      JSON.stringify({
        ...owner,
        generation: partition === mismatched ? 'another-generation' : path.basename(partition.root).slice(11),
        lifetime: { ...owner.lifetime, boot, start: partition === live ? '91' : '90' },
      }),
    );
  }
  await reclaimFolderlessCaches(cache, {
    platform: 'linux',
    signal: new AbortController().signal,
    inspect: async (saved) => linuxCacheOwnerStatus(saved, { ...observation, boot, stat: stat('S', '91') }),
  });
  assert.ok(fs.existsSync(old.root));
  assert.ok(fs.existsSync(live.root));
  assert.ok(fs.existsSync(mismatched.root));
});

// Lost ownership must block the real atomic writer, which otherwise recreates parent folders.
test.each(['directory', 'missing', 'generation', 'pid', 'oversized'] as const)(
  'folderless ownership loss %s blocks later atomic writes and release',
  (loss) => {
    const cache = tempDir('lost-owner-cache-');
    const partition = ownedCacheFixture(cache);
    const file = path.join(partition.root, FOLDERLESS_OWNER_FILE);
    if (loss === 'directory') fs.renameSync(partition.root, `${partition.root}-saved`);
    else if (loss === 'missing') fs.unlinkSync(file);
    else if (loss === 'oversized') fs.writeFileSync(file, 'x'.repeat(FOLDERLESS_CLEANUP_LIMITS.ownerBytes + 1));
    else {
      const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (loss === 'generation') owner.generation = 'foreign';
      else owner.pid++;
      fs.writeFileSync(file, JSON.stringify(owner));
    }
    let writes = 0;
    const destination = path.join(partition.root, 'later.json');
    const write = () =>
      partition.write(() => {
        writes++;
        writeFileAtomically(destination, 'later');
      });
    assert.equal(write(), false, loss);
    partition.close(() => {
      assert.equal(
        partition.write(() => writeFileAtomically(destination, 'flush'), true),
        false,
        loss,
      );
    });
    assert.equal(writes, 0, loss);
    assert.equal(fs.existsSync(destination), false, loss);
    assert.equal(fs.existsSync(path.join(partition.root, 'released.json')), false, loss);
    if (loss === 'directory') assert.equal(fs.existsSync(partition.root), false);
  },
);

// A changed ancestor must never redirect deletion to unrelated same-named bytes.
test('folderless cleanup preserves unrelated bytes when an ancestor is replaced before unlink', async () => {
  const cache = tempDir('ancestor-cache-');
  const partition = ownedCacheFixture(cache, true);
  const outside = tempDir('ancestor-outside-');
  const precious = path.join(outside, 'data');
  fs.writeFileSync(precious, 'valuable unrelated bytes');
  const original = fs.promises.lstat;
  let dataStats = 0;
  let replaced = false;
  const replace = () => {
    fs.renameSync(partition.root, `${partition.root}-original`);
    fs.symlinkSync(outside, partition.root, process.platform === 'win32' ? 'junction' : 'dir');
    replaced = true;
  };
  const barrier = vi.spyOn(fs.promises, 'lstat').mockImplementation(async (...args: Parameters<typeof original>) => {
    const stat = await original(...args);
    if (String(args[0]) === path.join(partition.root, 'data') && ++dataStats === 2) replace();
    return stat;
  });
  try {
    await reclaimFolderlessCaches(cache, { platform: 'linux', signal: new AbortController().signal });
    // Retention performs no traversal. Exercise the external ancestor replacement directly.
    if (!replaced) replace();
    assert.equal(fs.readFileSync(precious, 'utf8'), 'valuable unrelated bytes');
    await Promise.all(
      [0, 1].map(() =>
        reclaimFolderlessCaches(cache, {
          platform: 'linux',
          signal: new AbortController().signal,
        }),
      ),
    );
    assert.equal(fs.readFileSync(precious, 'utf8'), 'valuable unrelated bytes');
    assert.equal(fs.readFileSync(path.join(`${partition.root}-original`, 'data'), 'utf8'), 'kept');
  } finally {
    barrier.mockRestore();
  }
});

// Namespace labels can match on different Linux machines sharing the same cache directory.
test('folderless cleanup preserves a live foreign Linux owner with a differing boot', async () => {
  const cache = tempDir('foreign-owner-cache-');
  const partition = ownedCacheFixture(cache);
  const owner: CacheOwner = {
    version: 1,
    generation: path.basename(partition.root).slice(11),
    pid: process.pid,
    platform: 'linux',
    lifetime: { boot: '00000000-0000-0000-0000-000000000000', namespace: 'pid:[1]', start: '90' },
  };
  fs.writeFileSync(path.join(partition.root, FOLDERLESS_OWNER_FILE), JSON.stringify(owner));
  const observed = {
    boot: '11111111-1111-1111-1111-111111111111',
    namespace: 'pid:[1]',
    stat: `${process.pid} (live) ${['S', ...Array(18).fill('0'), '90'].join(' ')}`,
  };
  await reclaimFolderlessCaches(cache, {
    platform: 'linux',
    signal: new AbortController().signal,
    inspect: async (saved) => linuxCacheOwnerStatus(saved, observed),
  });
  assert.equal(fs.readFileSync(path.join(partition.root, 'data'), 'utf8'), 'kept');
  assert.equal(linuxCacheOwnerStatus(owner, observed), 'uncertain');
});

// Measure actual calls and returned-handle work without relying on the production counter.
test('folderless cleanup independently measures zero filesystem work on every platform', async () => {
  const cache = tempDir('retained-scale-cache-');
  for (let i = 0; i < 300; i++) fs.mkdirSync(path.join(cache, `retained-${i}`));
  const stopped = ownedCacheFixture(cache, true);
  const tree = path.join(stopped.root, 'tree');
  fs.mkdirSync(tree);
  for (let i = 0; i < 250; i++) fs.writeFileSync(path.join(tree, String(i)), 'data');
  for (let i = 0; i < 20; i++) ownedCacheFixture(cache, true);
  for (const platform of ['linux', 'win32', 'darwin'] as const) {
    let actual = 0;
    const measured: { reported: number; actual: number }[] = [];
    const io = fs.promises as unknown as Record<string, (...args: any[]) => Promise<any>>;
    const saved = new Map<string, (...args: any[]) => Promise<any>>();
    for (const name of ['lstat', 'stat', 'open', 'opendir', 'unlink', 'rmdir', 'readlink', 'readdir', 'rm']) {
      const original = io[name];
      saved.set(name, original);
      io[name] = async (...args: any[]) => {
        actual++;
        const result = await original(...args);
        if (name === 'open' || name === 'opendir') {
          for (const method of ['read', 'close']) {
            const call = result[method].bind(result);
            result[method] = (...params: any[]) => {
              actual++;
              return call(...params);
            };
          }
        }
        return result;
      };
    }
    try {
      await reclaimFolderlessCaches(cache, {
        platform,
        signal: new AbortController().signal,
        inspect: async () => assert.fail('retention must not inspect processes'),
        onBatch: (reported) => {
          measured.push({ reported, actual });
          actual = 0;
        },
      });
      measured.push({ reported: 0, actual });
      assert.ok(
        measured.every((batch) => batch.actual === 0 && batch.reported === 0),
        JSON.stringify(measured),
      );
    } finally {
      for (const [name, original] of saved) io[name] = original;
    }
    assert.equal(fs.readdirSync(tree).length, 250);
    const cancelled = new AbortController();
    cancelled.abort();
    await reclaimFolderlessCaches(cache, { platform, signal: cancelled.signal });
    assert.ok(fs.existsSync(stopped.root));
  }
});

test('a linked cache root or partition is rejected before anything is written through it', () => {
  const root = tempDir('arc-cache-');
  try {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    const linkedCache = path.join(root, 'linked-cache');
    try {
      fs.symlinkSync(outside, linkedCache, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }
    assert.throws(
      () => createWorkspaceCacheRoot(linkedCache, normalizedWorkspaceIdentity([])),
      /linked folder or file/,
    );
    const cache = path.join(root, 'cache');
    const identity = normalizedWorkspaceIdentity([path.join(root, 'repo')]);
    const key = workspaceCacheKey(identity);
    assert.ok(key);
    fs.mkdirSync(cache, { recursive: true });
    fs.symlinkSync(outside, path.join(cache, key), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => createWorkspaceCacheRoot(cache, identity), /linked folder or file/);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
