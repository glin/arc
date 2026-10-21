import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'vitest';
import { tempDir } from './temproot.ts';
import {
  claudeCheckLaunch,
  codexCheckLaunch,
  finishCodexHome,
  prepareCodexHome,
  shouldWriteAccountBack,
} from '../scripts/demo-catalog-check.ts';

test('catalog check launches Codex in its own home, not the user Codex home', () => {
  const home = tempDir('catalog-check-codex-home-');
  const env = codexCheckLaunch(
    home,
    { PATH: '/bin', CODEX_HOME: '/personal', codex_home: '/personal-2' },
    { CODEX_HOME: '/launch' },
  );
  assert.deepEqual(
    Object.keys(env).filter((key) => key.toUpperCase() === 'CODEX_HOME'),
    ['CODEX_HOME'],
  );
  assert.equal(env.CODEX_HOME, home);
  assert.equal(env.PATH, '/bin');
});

test('catalog check Codex home lists only the account file and the launch points at it', () => {
  const personal = tempDir('catalog-check-personal-');
  fs.writeFileSync(path.join(personal, 'config.toml'), 'model = "personal"\n');
  fs.writeFileSync(path.join(personal, 'auth.json'), '{"token":"a"}');
  fs.mkdirSync(path.join(personal, 'sessions'));
  const prepared = prepareCodexHome({ CODEX_HOME: personal }, tempDir('catalog-check-root-'));
  assert.deepEqual(fs.readdirSync(prepared.home), ['auth.json']);
  assert.equal(fs.readFileSync(path.join(prepared.home, 'auth.json'), 'utf8'), '{"token":"a"}');
  const env = codexCheckLaunch(prepared.home, { CODEX_HOME: personal }, {});
  assert.equal(env.CODEX_HOME, prepared.home);
  assert.notEqual(prepared.home, personal);
  assert.deepEqual(finishCodexHome(prepared), []);
  assert.equal(fs.existsSync(prepared.home), false);
});

test('catalog check Codex home is empty and reports no copy when the account file is missing', () => {
  const personal = tempDir('catalog-check-personal-');
  fs.writeFileSync(path.join(personal, 'config.toml'), 'model = "personal"\n');
  const prepared = prepareCodexHome({ codex_home: personal }, tempDir('catalog-check-root-'));
  assert.deepEqual(fs.readdirSync(prepared.home), []);
  assert.equal(prepared.copied, null);
  assert.deepEqual(finishCodexHome(prepared), []);
});

test('catalog check saves a refreshed Codex account file only while the original is unchanged', () => {
  const copied = Buffer.from('old');
  const refreshed = Buffer.from('new');
  assert.equal(shouldWriteAccountBack(copied, refreshed, copied), true);
  assert.equal(shouldWriteAccountBack(copied, copied, copied), false);
  assert.equal(shouldWriteAccountBack(copied, refreshed, Buffer.from('owner')), false);
  assert.equal(shouldWriteAccountBack(copied, refreshed, null), false);
  assert.equal(shouldWriteAccountBack(copied, null, copied), false);
  assert.equal(shouldWriteAccountBack(null, refreshed, null), false);
});

test('catalog check writes a refreshed Codex account file back, and keeps an owner change', () => {
  for (const ownerChanged of [false, true]) {
    const personal = tempDir('catalog-check-personal-');
    fs.writeFileSync(path.join(personal, 'auth.json'), 'old');
    const prepared = prepareCodexHome({ CODEX_HOME: personal }, tempDir('catalog-check-root-'));
    fs.writeFileSync(path.join(prepared.home, 'auth.json'), 'refreshed');
    if (ownerChanged) fs.writeFileSync(path.join(personal, 'auth.json'), 'owner');
    assert.deepEqual(finishCodexHome(prepared), []);
    assert.equal(fs.readFileSync(path.join(personal, 'auth.json'), 'utf8'), ownerChanged ? 'owner' : 'refreshed');
    assert.equal(fs.existsSync(prepared.home), false);
  }
});

test('catalog check discards the private Codex account file when a signal stops Codex', () => {
  const personal = tempDir('catalog-check-personal-');
  fs.writeFileSync(path.join(personal, 'auth.json'), 'old');
  const prepared = prepareCodexHome({ CODEX_HOME: personal }, tempDir('catalog-check-root-'));
  fs.writeFileSync(path.join(prepared.home, 'auth.json'), '{"partial');
  assert.deepEqual(finishCodexHome(prepared, false), []);
  assert.equal(fs.readFileSync(path.join(personal, 'auth.json'), 'utf8'), 'old');
  assert.equal(fs.existsSync(prepared.home), false);
});

test('catalog check launches Claude without user settings or personal model and effort variables', () => {
  const inherited = {
    PATH: '/bin',
    ANTHROPIC_MODEL: 'haiku',
    anthropic_default_haiku_model: 'haiku',
    ANTHROPIC_DEFAULT_MODEL: 'haiku',
    ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: 'Personal',
    CLAUDE_EFFORT: 'high',
    Claude_Code_Effort_Level: 'high',
    CLAUDE_CODE_SESSION_ID: 'parent',
  };
  const launch = claudeCheckLaunch(tempDir('catalog-check-'), inherited, {
    ANTHROPIC_MODEL: 'opus',
  });
  const at = launch.args.indexOf('--setting-sources');
  assert.equal(launch.args[at + 1], 'project,local');
  assert.deepEqual(
    Object.keys(launch.env).filter((key) => /model|effort|session_id/i.test(key)),
    [],
  );
  assert.equal(launch.env.PATH, '/bin');
});
