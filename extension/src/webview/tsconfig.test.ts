import assert from 'node:assert';
import * as fs from 'node:fs';
import { tempDir } from '../temproot.ts';
import * as path from 'node:path';
import { test } from 'vitest';
import { browserGlobalViolations } from '../../scripts/check-webview-globals.ts';

function config(name: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8'));
}

test('the browser compiler has DOM types and a Node-global boundary', () => {
  const production = config('tsconfig.json');
  assert.deepEqual(production.compilerOptions.lib, ['ES2022', 'DOM', 'DOM.Iterable']);
  assert.deepEqual(production.compilerOptions.types, ['node', 'vite/client']);
  assert.deepEqual(browserGlobalViolations(__dirname), []);
});

test('the browser boundary finds Node-only globals in nested production modules', (t) => {
  const root = tempDir('arc-browser-boundary-');
  t.onTestFinished(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const nested = path.join(root, 'nested');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, 'unsafe.ts'), 'export {};\nclearImmediate(undefined);\nvoid exports;\ngc();\n');
  const found = browserGlobalViolations(root, path.join(__dirname, 'tsconfig.json'));
  assert.deepEqual(
    found.map((violation) => [violation.file, violation.line, violation.name]),
    [
      ['nested/unsafe.ts', 2, 'clearImmediate'],
      ['nested/unsafe.ts', 3, 'exports'],
      ['nested/unsafe.ts', 4, 'gc'],
    ],
  );
});

test('the browser boundary follows runtime imports outside the webview directory', (t) => {
  const sourceRoot = tempDir('arc-browser-import-');
  t.onTestFinished(() => {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  });
  const root = path.join(sourceRoot, 'webview');
  const shared = path.join(sourceRoot, 'view');
  fs.mkdirSync(root);
  fs.mkdirSync(shared);
  fs.writeFileSync(path.join(root, 'main.ts'), "import '../view/unsafe.ts';\nimport '../view/unsafe-script.js';\n");
  fs.writeFileSync(
    path.join(shared, 'unsafe.ts'),
    [
      'export const direct = process.env.NODE_ENV;',
      'export const throughGlobal = globalThis.process.env.NODE_ENV;',
      "export const throughElement = globalThis['process'].env.NODE_ENV;",
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(shared, 'unsafe-script.js'), 'export const cwd = process.cwd();\n');
  const found = browserGlobalViolations(root, path.join(__dirname, 'tsconfig.json'));
  assert.deepEqual(
    found.map((violation) => [violation.file, violation.line, violation.name]),
    [
      ['../view/unsafe.ts', 1, 'process'],
      ['../view/unsafe.ts', 2, 'process'],
      ['../view/unsafe.ts', 3, 'process'],
      ['../view/unsafe-script.js', 1, 'process'],
    ],
  );
});
