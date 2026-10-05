import { test } from 'vitest';
import assert from 'node:assert';
import * as fs from 'node:fs';
import { tempDir } from './temproot.ts';
import * as path from 'node:path';
import {
  ImportEdge,
  PROTOCOL_TYPE_EDGE_CEILING,
  PROTOCOL_TYPE_EDGE_SOURCE,
  inventorySourceTree,
  packageName,
  packageViolations,
  protocolTypeEdges,
  readImportEdges,
  readModuleReferences,
  runtimeImportCycles,
} from '../test/source-tree.ts';

function temporaryTree(): string {
  return tempDir('arc-source-tree-');
}

function write(root: string, name: string, text = ''): void {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test('source inventory finds nested components, tests, assets, and unsupported entries', () => {
  const root = temporaryTree();
  try {
    write(root, 'domain/model.ts');
    write(root, 'domain/model.test.ts');
    write(root, 'webview/page.ts');
    write(root, 'webview/panel.css');
    write(root, 'notes.txt');
    const tree = inventorySourceTree(root);
    assert.deepEqual(tree.components, ['domain/model.ts', 'webview/page.ts', 'webview/panel.css']);
    assert.deepEqual(tree.tests, ['domain/model.test.ts']);
    assert.deepEqual(tree.unsupported, ['notes.txt']);
    assert.deepEqual(tree.links, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a linked directory is reported by its own path and is not traversed', () => {
  const root = temporaryTree();
  const target = temporaryTree();
  const link = path.join(root, 'linked-dir');
  try {
    write(root, 'visible.ts');
    write(target, 'hidden.ts');
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    const tree = inventorySourceTree(root);
    assert.deepEqual(tree.components, ['visible.ts']);
    assert.deepEqual(tree.links, ['linked-dir']);
  } finally {
    try {
      fs.unlinkSync(link);
    } catch {
      /* the fixture did not reach link creation */
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('the AST reader handles imports, exports, require forms, and ignores comments and strings', () => {
  const refs = readModuleReferences(`
    // import { fake } from './comment'; require('./comment2');
    const text = "import('./string')";
    import type { Type } from './types';
    import { type Named, Value } from './mixed';
    export { type Other } from './other-types';
    export { Value as Again } from './values';
    import legacy = require('./legacy');
    const one = import('./dynamic');
    const two = require('./required');
  `);
  assert.deepEqual(
    refs.map((ref) => [ref.specifier, ref.typeOnly, ref.kind]),
    [
      ['./types', true, 'import'],
      ['./mixed', false, 'import'],
      ['./other-types', true, 'export'],
      ['./values', false, 'export'],
      ['./legacy', false, 'import-equals'],
      ['./dynamic', false, 'dynamic-import'],
      ['./required', false, 'require'],
    ],
  );
});

test('vscode exemptions are exact root-relative paths', () => {
  const root = temporaryTree();
  try {
    write(root, 'extension.ts', "import * as vscode from 'vscode';");
    write(root, 'nested/extension.ts', "import * as vscode from 'vscode';");
    const exempt = new Set(['extension.ts']);
    const offenders = inventorySourceTree(root)
      .components.filter((file) => file.endsWith('.ts'))
      .filter((file) => !exempt.has(file))
      .filter((file) =>
        readModuleReferences(fs.readFileSync(path.join(root, file), 'utf8'), file).some(
          (ref) => ref.specifier === 'vscode',
        ),
      );
    assert.deepEqual(offenders, ['nested/extension.ts']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function edge(from: string, to: string | null, specifier = to ?? ''): ImportEdge {
  return { from, to, specifier, typeOnly: false, kind: 'import' };
}

test('package rules accept every intended dependency direction', () => {
  const allowed = [
    edge('domain/a.ts', 'domain/b.ts'),
    edge('readers/shared/a.ts', 'domain/a.ts'),
    edge('readers/claude/a.ts', 'readers/shared/a.ts'),
    edge('runtime/codex/a.ts', 'runtime/shared/a.ts'),
    edge('view/a.ts', 'readers/codex/a.ts'),
    edge('webview/a.ts', 'view/a.ts'),
    edge('host/a.ts', 'runtime/claude/a.ts'),
    edge('host/a.ts', 'webview/protocol.ts'),
    edge('legacy.ts', 'webview/a.ts'),
  ];
  assert.deepEqual(packageViolations(allowed), []);
});

test('package rules reject reverse, cross-vendor, legacy, host-renderer, and Node edges', () => {
  const forbidden = [
    edge('domain/a.ts', 'view/a.ts'),
    edge('readers/shared/a.ts', 'readers/claude/a.ts'),
    edge('readers/claude/a.ts', 'readers/codex/a.ts'),
    edge('runtime/claude/a.ts', 'readers/shared/a.ts'),
    edge('webview/a.ts', 'runtime/shared/a.ts'),
    edge('view/a.ts', 'legacy.ts'),
    edge('host/a.ts', 'webview/cards.ts'),
    edge('view/a.ts', null, 'node:fs'),
  ];
  assert.deepEqual(
    packageViolations(forbidden).map((violation) => [violation.from, violation.toPackage]),
    [
      ['domain/a.ts', 'view'],
      ['readers/shared/a.ts', 'readers/claude'],
      ['readers/claude/a.ts', 'readers/codex'],
      ['runtime/claude/a.ts', 'readers/shared'],
      ['webview/a.ts', 'runtime/shared'],
      ['view/a.ts', 'legacy'],
      ['host/a.ts', 'webview'],
      ['view/a.ts', 'node'],
    ],
  );
});

test('the type-only allowance covers the protocol module alone', () => {
  const edges: ImportEdge[] = [
    { ...edge(PROTOCOL_TYPE_EDGE_SOURCE, 'agentwire.ts'), typeOnly: true },
    { ...edge(PROTOCOL_TYPE_EDGE_SOURCE, 'composerview.ts'), typeOnly: false },
    { ...edge('webview/cards.ts', 'agentwire.ts'), typeOnly: true },
    { ...edge(PROTOCOL_TYPE_EDGE_SOURCE, 'view/one.ts'), typeOnly: true },
  ];
  assert.deepEqual(
    protocolTypeEdges(edges).map((one) => one.to),
    ['agentwire.ts'],
  );
  assert.deepEqual(
    packageViolations(edges).map((one) => [one.from, one.toPackage]),
    [
      [PROTOCOL_TYPE_EDGE_SOURCE, 'legacy'],
      ['webview/cards.ts', 'legacy'],
    ],
  );
});

test('the protocol module holds to its counted type-only allowance', () => {
  const found = protocolTypeEdges(readImportEdges(__dirname))
    .map((one) => one.to)
    .sort();
  assert.equal(
    found.length,
    PROTOCOL_TYPE_EDGE_CEILING,
    `${PROTOCOL_TYPE_EDGE_SOURCE} names types in ${found.length} root modules, and the ceiling ` +
      `is ${PROTOCOL_TYPE_EDGE_CEILING}: ${found.join(', ')}. Lower the ceiling when a type ` +
      'moves out of a root module. Raising it needs the owner.',
  );
});

test('runtime cycles are reported while type-only cycles are excluded', () => {
  const runtime: ImportEdge[] = [edge('a.ts', 'b.ts'), edge('b.ts', 'a.ts')];
  assert.deepEqual(runtimeImportCycles(runtime), [{ paths: ['a.ts', 'b.ts', 'a.ts'] }]);
  const types: ImportEdge[] = [
    { ...edge('a.ts', 'b.ts'), typeOnly: true },
    { ...edge('b.ts', 'a.ts'), typeOnly: true },
  ];
  assert.deepEqual(runtimeImportCycles(types), []);
});

test('fixture imports remain visible in the recursive graph', () => {
  const root = temporaryTree();
  try {
    write(root, 'turnfixtures.ts');
    write(root, 'nested/production.ts', "import '../turnfixtures';");
    const edges = readImportEdges(root, inventorySourceTree(root));
    assert.equal(edges[0]?.to, 'turnfixtures.ts');
    assert.equal(edges[0]?.from, 'nested/production.ts');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('JavaScript imports participate in the package graph', () => {
  const root = temporaryTree();
  try {
    write(root, 'webview/page.ts', "import '../runtime/shared/process.ts';");
    write(root, 'runtime/shared/process.ts');
    const edges = readImportEdges(root, inventorySourceTree(root));
    assert.deepEqual(
      edges.map((item) => [item.from, item.to]),
      [['webview/page.ts', 'runtime/shared/process.ts']],
    );
    assert.deepEqual(
      packageViolations(edges).map((item) => [item.fromPackage, item.toPackage]),
      [['webview', 'runtime/shared']],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('planned package names use the deepest recognized package path', () => {
  assert.equal(packageName('readers/claude/read.ts'), 'readers/claude');
  assert.equal(packageName('runtime/codex/wire.ts'), 'runtime/codex');
  assert.equal(packageName('legacy.ts'), 'legacy');
  assert.equal(packageName('plugins/page.ts'), 'other');
  assert.equal(packageName('plugins/panel.css'), 'other');
});
