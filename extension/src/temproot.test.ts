// Test temporary-directory configuration.
import { test } from 'vitest';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inventorySourceTree } from '../test/source-tree.ts';
import setup, { MACHINE_TEMP, RUN_TEMP } from '../test/temp-run.ts';
import { tempDir } from './temproot.ts';

const REPOSITORY = path.join(__dirname, '..', '..');

test('tests make scratch directories through temproot.ts, which removes them after the run', () => {
  const tree = inventorySourceTree(__dirname);
  const offenders = tree.tests.filter(
    (file) =>
      file !== 'temproot.test.ts' &&
      /\bmkdtemp(?:Sync)?\s*\(/.test(fs.readFileSync(path.join(__dirname, file), 'utf8')),
  );
  assert.deepEqual(offenders, [], `${offenders.join(', ')} calls mkdtemp directly. Use tempDir from temproot.ts.`);
});

test('every Vitest config in the repository runs inside its own temporary directory', { tags: ['subprocess'] }, () => {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: REPOSITORY,
    encoding: 'utf8',
  }).split('\n');
  const configs = files.filter((file) => /(^|\/)vitest\.config\.[cm]?[jt]s$/.test(file));
  assert.ok(configs.includes('extension/vitest.config.ts'), `no Vitest config found in ${configs.join(', ')}`);
  const offenders = configs.filter(
    (file) => !/globalSetup:.*temp-run\.ts/.test(fs.readFileSync(path.join(REPOSITORY, file), 'utf8')),
  );
  assert.deepEqual(offenders, [], `${offenders.join(', ')} must list extension/test/temp-run.ts in globalSetup`);
});

test('a test worker writes its temporary files inside the run directory', () => {
  const runTemp = process.env[RUN_TEMP];
  assert.ok(runTemp && fs.statSync(runTemp).isDirectory(), `${RUN_TEMP} does not name a directory`);
  assert.equal(os.tmpdir(), runTemp);
});

test('temporary-directory timing retains environment redirection and restoration', async () => {
  const root = tempDir('timing-environment-');
  const keys = [
    'ARC_TEST_OBSERVATIONS_DIR',
    'ARC_TEST_OBSERVATION_RUN_ID',
    MACHINE_TEMP,
    RUN_TEMP,
    'TEMP',
    'TMP',
    'TMPDIR',
  ];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  const artifacts = path.join(root, 'observations');
  let teardown: (() => void) | undefined;
  try {
    Object.assign(process.env, {
      ARC_TEST_OBSERVATIONS_DIR: artifacts,
      ARC_TEST_OBSERVATION_RUN_ID: 'outer',
      [MACHINE_TEMP]: root,
    });
    teardown = await setup();
    const redirected = process.env[RUN_TEMP];
    assert.ok(redirected);
    teardown();
    teardown = undefined;
    const events = fs
      .readFileSync(path.join(artifacts, fs.readdirSync(artifacts)[0]), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const prepared = events.find((event) => event.phase === 'prepare' && event.event === 'end');
    assert.equal(prepared.machineTemp, root);
    assert.equal(prepared.runTemp, redirected);
    for (const key of ['TEMP', 'TMP', 'TMPDIR']) assert.equal(prepared.coordination.variables[key], redirected);
    const cleanup = events.find((event) => event.phase === 'cleanup' && event.event === 'end');
    for (const key of ['TEMP', 'TMP', 'TMPDIR'])
      assert.equal(cleanup.coordination.variables[key], saved.get(key) ?? null);
    assert.equal(events[0].parentRunId, 'outer');
    assert.equal(events.at(-1).outcome, 'success');
    assert.equal(fs.existsSync(redirected), false);
  } finally {
    teardown?.();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
