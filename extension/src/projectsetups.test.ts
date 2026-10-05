import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  ProjectSetupStore,
  SetupProjects,
  normalizeProjectPath,
  normalizeProjectSetups,
  projectSetupKey,
} from './projectsetups';
import { nodeGitRunner } from './gitcommits';
import { STORED_STATE_KEYS } from './identity';
import { tempDir } from './temproot';

const profile = (model: string) => ({
  agent: 'claude' as const,
  model,
  effort: '',
  permissionMode: '',
  source: 'recent' as const,
});
const pin = (model: string, id = model) => ({ id, ...profile(model) });

function fixture() {
  const saved = new Map<string, unknown>([[STORED_STATE_KEYS.pinnedSetups, [pin('legacy', 'kept-id')]]]);
  let fail = false;
  const store = new ProjectSetupStore({
    get: (key) => saved.get(key),
    update: async (key, value) => {
      if (fail) throw new Error('storage refused');
      saved.set(key, structuredClone(value));
    },
  });
  return {
    saved,
    store,
    fail: (value: boolean) => {
      fail = value;
    },
  };
}

test('reopening two projects keeps apply and unpin values in their own lists', async () => {
  const f = fixture();
  await f.store.read('A');
  await f.store.read('B');
  await f.store.pins('A', [pin('A')]);
  await f.store.pins('B', [pin('B')]);
  assert.equal((await f.store.read('A')).pins[0].model, 'A');
  assert.equal((await f.store.read('B')).pins[0].model, 'B');
  await f.store.pins('A', []);
  assert.deepEqual((await f.store.read('A')).pins, []);
  assert.equal((await f.store.read('B')).pins[0].model, 'B');
});

test('migration preserves legacy IDs and order once, including intentional empty and invalid entries', async () => {
  const f = fixture();
  f.saved.set(STORED_STATE_KEYS.pinnedSetups, [pin('old', 'first'), pin('retired', 'second')]);
  assert.deepEqual(
    (await f.store.read('A')).pins.map((one) => one.id),
    ['first', 'second'],
  );
  await f.store.pins('A', []);
  f.saved.set(STORED_STATE_KEYS.pinnedSetups, [pin('new')]);
  assert.deepEqual((await f.store.read('A')).pins, []);
  assert.equal((await f.store.read('B')).pins[0].model, 'new');
  f.saved.set(projectSetupKey('invalid'), null);
  assert.deepEqual((await f.store.read('invalid')).pins, []);
  assert.equal((f.saved.get(STORED_STATE_KEYS.pinnedSetups) as unknown[]).length, 1);
});

test('failed migration retries and folderless windows never create entries or import pins', async () => {
  const f = fixture();
  f.fail(true);
  await assert.rejects(f.store.read('A'), /storage refused/);
  assert.equal(f.saved.has(projectSetupKey('A')), false);
  f.fail(false);
  assert.equal((await f.store.read('A')).pins[0].id, 'kept-id');
  const before = f.saved.size;
  assert.deepEqual(await f.store.read(null), { version: 1, pins: [], recents: [] });
  await f.store.accept(null, profile('no-folder'));
  await assert.rejects(f.store.pins(null, []), /Saved setups are unavailable/);
  assert.equal(f.saved.size, before);
});

test('late draft acceptance and pin persistence retain separate project recents and pins', async () => {
  const f = fixture();
  const destination = 'A';
  await f.store.accept('B', profile('B'));
  await Promise.all([f.store.pins(destination, [pin('pinned')]), f.store.accept(destination, profile('accepted'))]);
  const a = await f.store.read('A');
  assert.equal(a.recents[0].model, 'accepted');
  assert.equal(a.pins[0].model, 'pinned');
  assert.equal((await f.store.read('B')).recents[0].model, 'B');
});

test('normalization rejects invalid profiles without removing unavailable pinned values', () => {
  const entry = normalizeProjectSetups({
    pins: [pin('retired'), { id: 'bad' }],
    recents: [profile('good'), { agent: 'bad' }, profile('good')],
  });
  assert.equal(entry.pins[0].model, 'retired');
  assert.deepEqual(entry.recents, [profile('good')]);
  assert.equal(normalizeProjectPath('C:\\Repo\\.git\\'), 'c:/repo/.git');
  assert.equal(normalizeProjectPath('c:/REPO/.git'), 'c:/repo/.git');
  assert.equal(normalizeProjectPath('/Repo/.git/'), '/Repo/.git');
  assert.notEqual(normalizeProjectPath('/Repo'), normalizeProjectPath('/repo'));
});

test('identity errors retain successful identity and never seed a transient fallback', async () => {
  let answer = { stdout: null as string | null, outsideGit: false };
  const identities = new SetupProjects(
    { run: async () => null, identity: async () => answer },
    async (folder) => folder,
  );
  assert.equal(await identities.resolve('C:/repo'), null);
  answer = { stdout: 'C:/repo/.git\nC:/repo/.git\nC:/repo\n', outsideGit: false };
  assert.equal(await identities.resolve('C:/repo'), 'git:c:/repo/.git');
  answer = { stdout: null, outsideGit: false };
  assert.equal(await identities.resolve('C:/repo'), 'git:c:/repo/.git');
  assert.equal(await identities.resolve('C:/unknown'), null);
  answer = { stdout: null, outsideGit: true };
  assert.equal(await identities.resolve('C:/outside'), 'folder:c:/outside');
  assert.equal(await identities.resolve(null), null);
  answer = { stdout: '/Repo/.git\n/Repo/.git\n/Repo\n', outsideGit: false };
  assert.equal(await identities.resolve('/Repo/subdirectory'), 'git:/Repo/.git');
  answer = { stdout: '/repo/.git\n/repo/.git\n/repo\n', outsideGit: false };
  assert.equal(await identities.resolve('/repo'), 'git:/repo/.git');
});

test('a checkout, linked worktree, subdirectory and canonical alias share identity while clones differ', async () => {
  const root = tempDir('setup-projects-');
  const main = path.join(root, 'main');
  const linked = path.join(root, 'linked');
  const separate = path.join(root, 'separate');
  mkdirSync(main);
  const git = (folder: string, args: string[]) => execFileSync('git', ['-C', folder, ...args], { windowsHide: true });
  git(main, ['init', '-q']);
  git(main, [
    '-c',
    'user.name=Setup Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--allow-empty',
    '-qm',
    'initial',
  ]);
  git(main, ['worktree', 'add', '-q', '-b', 'linked', linked]);
  const subdirectory = path.join(main, 'subdirectory');
  mkdirSync(subdirectory);
  mkdirSync(separate);
  git(separate, ['init', '-q']);
  const identities = new SetupProjects(nodeGitRunner());
  const mainIdentity = await identities.resolve(main);
  assert.ok(mainIdentity?.startsWith('git:'));
  assert.equal(await identities.resolve(linked), mainIdentity);
  renameSync(path.join(linked, '.git'), path.join(linked, '.git-saved'));
  writeFileSync(path.join(linked, '.git'), 'gitdir: missing-git-directory\n');
  assert.equal(await identities.resolve(linked), mainIdentity, 'an invalid Git directory replaced the known project');
  assert.equal(await new SetupProjects(nodeGitRunner()).resolve(linked), null);
  assert.equal(await identities.resolve(subdirectory), mainIdentity);
  assert.equal(await identities.resolve(path.join(main, 'subdirectory', '..')), mainIdentity);
  assert.notEqual(await identities.resolve(separate), mainIdentity);
  assert.ok((await identities.resolve(root))?.startsWith('folder:'));
});
