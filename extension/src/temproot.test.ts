// Test temporary-directory configuration.
import { test } from 'vitest';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inventorySourceTree } from '../test/source-tree.ts';
import { RUN_TEMP } from '../test/temp-run.ts';

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
