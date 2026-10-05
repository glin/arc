import { test } from 'vitest';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { countFixedWaits } from '../test/fixed-waits.ts';
import { repoTestFiles } from '../test/source-tree.ts';
import { tempDir } from './temproot.ts';

const ALLOWED_FIXED_WAITS: Record<string, number> = {
  // The disposal race settles a Promise.race with a real 10ms timeout. It has no state to poll.
  'extension/src/agenthost.test.ts': 1,
};

test('no test file sleeps a fixed amount of time beyond its allowed count', () => {
  const repoRoot = path.join(__dirname, '..', '..');
  const files = repoTestFiles(repoRoot);
  const counts = new Map<string, number>();
  for (const [repoRelativePath, absolutePath] of files) {
    // Fixture source covers parser branches. Scanning it as test code would count those fixtures.
    if (repoRelativePath === 'extension/src/test-waits.test.ts') continue;
    counts.set(repoRelativePath, countFixedWaits(fs.readFileSync(absolutePath, 'utf8'), absolutePath));
  }
  const offenders: string[] = [];
  for (const [file, count] of counts) {
    const allowed = ALLOWED_FIXED_WAITS[file] ?? 0;
    if (count > allowed) {
      offenders.push(
        `${file}: found ${count} fixed wait(s), allowed ${allowed}. Poll for the state the test needs instead of sleeping.`,
      );
    } else if (count < allowed) {
      offenders.push(
        `${file}: found ${count} fixed wait(s), allowed ${allowed}. Lower the entry in extension/src/test-waits.test.ts to ${count}.`,
      );
    }
  }
  for (const file of Object.keys(ALLOWED_FIXED_WAITS)) {
    if (!counts.has(file))
      offenders.push(
        `${file}: has an allowlist entry but no longer exists in the scanned lanes. Remove the entry from extension/src/test-waits.test.ts.`,
      );
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

function countMismatches(cases: Array<[string, string, number]>): string[] {
  return cases
    .map(([name, source, expected]) => ({ name, expected, actual: countFixedWaits(source) }))
    .filter(({ expected, actual }) => expected !== actual)
    .map(({ name, expected, actual }) => `${name}: expected ${expected} fixed wait(s), got ${actual}`);
}

test('the fixed-wait checker counts direct waits through each supported binding branch', () => {
  const mismatches = countMismatches([
    ['page method', 'await page.waitForTimeout(200);', 1],
    ['promise settler', 'await new Promise((resolve) => setTimeout(resolve, 80));', 1],
    ['window settler', 'await new Promise((resolve) => window.setTimeout(resolve, 80));', 1],
    ['globalThis settler', 'await new Promise((resolve) => globalThis.setTimeout(resolve, 80));', 1],
    ['named timer import', "import { setTimeout } from 'node:timers/promises';\nawait setTimeout(50);", 1],
    ['renamed timer import', "import { setTimeout as sleep } from 'node:timers/promises';\nawait sleep(50);", 1],
    ['namespace timer import', "import * as timers from 'node:timers/promises';\nawait timers.setTimeout(50);", 1],
  ]);
  assert.deepEqual(mismatches, [], mismatches.join('\n'));
});

test('the fixed-wait checker follows supported expression wrappers', () => {
  const mismatches = countMismatches([
    ['cast settler', 'await new Promise((resolve) => setTimeout(resolve as () => void, 50));', 1],
    ['wrapped settler call', 'await new Promise((resolve) => setTimeout((() => resolve())!, 50));', 1],
    [
      'parenthesized imported timer',
      "import { setTimeout as sleep } from 'node:timers/promises';\nawait (sleep(5));",
      1,
    ],
  ]);
  assert.deepEqual(mismatches, [], mismatches.join('\n'));
});

test('the fixed-wait checker counts helper callers and exported helper definitions', () => {
  const mismatches = countMismatches([
    [
      'local helper callers',
      'const wait = (ms) => new Promise((r) => setTimeout(r, ms));\nawait wait(10);\nawait wait(20);',
      2,
    ],
    ['exported helper definition', 'export const wait = (ms) => new Promise((r) => setTimeout(r, ms));', 1],
    [
      'imported timer helper caller',
      "import { setTimeout as delay } from 'node:timers/promises';\nconst sleep = (ms) => delay(ms);\nawait sleep(5);",
      1,
    ],
  ]);
  assert.deepEqual(mismatches, [], mismatches.join('\n'));
});

test('the fixed-wait checker keeps allowed timer branches out of the count', () => {
  const mismatches = countMismatches([
    ['timer that performs work', 'setTimeout(() => { doWork(); }, 500);', 0],
    ['setter-like callback outside a promise', 'const resolve = run;\nsetTimeout(resolve, 500);', 0],
    ['zero-delay promise settler', 'await new Promise((r) => setTimeout(r, 0));', 0],
    ['missing-delay promise settler', 'await new Promise((r) => setTimeout(r));', 0],
    ['zero-delay imported timer', "import { setTimeout } from 'node:timers/promises';\nawait setTimeout(0);", 0],
  ]);
  assert.deepEqual(mismatches, [], mismatches.join('\n'));
});

test('the fixed-wait checker parses page code in plain strings and each template branch', () => {
  const mismatches = countMismatches([
    ['plain string', "await page.addInitScript('new Promise((r) => setTimeout(r, 100))');", 1],
    ['template without substitution', 'await page.evaluate(`new Promise((r) => setTimeout(r, 100))`);', 1],
    ['template with substitution', 'await page.evaluate(`new Promise((r) => setTimeout(r, ${SETTLED}))`);', 1],
  ]);
  assert.deepEqual(mismatches, [], mismatches.join('\n'));
});

test('repoTestFiles scans a non-test support module in every helper-holding lane', () => {
  const repoRoot = tempDir('wait-guard-lanes-');
  for (const dir of ['extension/src', 'extension/test', 'plugins/arc-hooks/scripts', 'scripts', 'test', 'cli/test']) {
    fs.mkdirSync(path.join(repoRoot, ...dir.split('/')), { recursive: true });
  }
  fs.writeFileSync(path.join(repoRoot, 'cli', 'test', 'wait-helper.ts'), 'export const wait = () => {};\n');
  fs.writeFileSync(path.join(repoRoot, 'test', 'wait-helper.js'), 'module.exports.wait = () => {};\n');
  fs.writeFileSync(path.join(repoRoot, 'extension', 'test', 'wait-helper.ts'), 'export const wait = () => {};\n');
  const files = repoTestFiles(repoRoot);
  assert.ok(files.has('cli/test/wait-helper.ts'), 'a cli/test support module was not scanned');
  assert.ok(files.has('test/wait-helper.js'), 'a repository-root test support module was not scanned');
  assert.ok(files.has('extension/test/wait-helper.ts'), 'an extension/test support module was not scanned');
});
