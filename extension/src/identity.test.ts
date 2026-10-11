import { test } from 'vitest';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { sourceDoesNotMatch, sourceMatch } from '../test/source-contract.ts';
import { ARC_IDENTITY, STORED_STATE_KEYS } from './identity.ts';

test('project setups have a versioned storage prefix and retain the legacy pin key', () => {
  assert.equal(STORED_STATE_KEYS.pinnedSetups, 'arc.pinnedSetups');
  assert.equal(STORED_STATE_KEYS.projectSetups, 'arc.projectSetups.v1:');
});

test('Arc identity names the product, extension, storage and package identifiers', () => {
  assert.deepEqual(ARC_IDENTITY, {
    productName: 'Arc',
    repositoryName: 'arc',
    publisher: 'glin',
    extensionName: 'arc',
    extensionId: 'glin.arc',
    commandPrefix: 'arc',
    settingsSection: 'arc',
    panelType: 'arc.panel',
    panelStateKey: 'arc.panelState',
    homeDirectory: '.arc',
    snapshotsDirectory: 'snapshots',
    environmentPrefix: 'ARC_',
    visualizationScheme: 'arc-visualization:',
    sessionScheme: 'arc-session:',
    cliPackageName: '@glin/arc',
    cliExecutable: 'arc-status',
    vsixFileName: 'arc.vsix',
    baselineScheme: 'arc-baseline',
    patchScheme: 'arc-patch',
  });
});

// A contributed command with no handler fails when the reader runs it, and a handler with no
// contribution never appears in the Command Palette.
test('every contributed command registers under its Arc id', () => {
  // Read from the syntax tree, so a registration the formatter wraps after its opening
  // parenthesis still counts.
  const registered = ['extension.ts', 'panelhost.ts'].flatMap((name) => {
    const file = ts.createSourceFile(name, fs.readFileSync(path.join(__dirname, name), 'utf8'), ts.ScriptTarget.Latest);
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
        const [first] = node.arguments;
        if (
          ts.isIdentifier(callee) &&
          /(?:reg|registerCommand)$/.test(callee.text) &&
          first &&
          ts.isStringLiteral(first)
        ) {
          found.push(first.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    return found;
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const contributed = manifest.contributes.commands.map((command: { command: string }) => command.command);
  assert.deepEqual([...registered].sort(), [...contributed].sort());
});

test('shipping sources take Arc identifiers from the identity contract', () => {
  const sourceRoot = __dirname;
  const exemptions = new Set(['identity.ts', 'domain/identity.ts']);
  const identifiers = [
    ARC_IDENTITY.extensionId,
    ARC_IDENTITY.panelType,
    ARC_IDENTITY.panelStateKey,
    ARC_IDENTITY.environmentPrefix,
    ARC_IDENTITY.visualizationScheme,
    ARC_IDENTITY.sessionScheme,
    ARC_IDENTITY.cliPackageName,
    ARC_IDENTITY.cliExecutable,
    ARC_IDENTITY.vsixFileName,
    ARC_IDENTITY.baselineScheme,
    ARC_IDENTITY.patchScheme,
  ];
  const sources: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        const relative = path.relative(sourceRoot, full).replaceAll(path.sep, '/');
        if (!exemptions.has(relative)) {
          sources.push(relative);
        }
      }
    }
  };
  visit(sourceRoot);

  // A panel template token, such as `__ARC_RAIL_WIDTH_DEFAULT__`, starts with two underscores
  // and the environment prefix. It names a value that `paneltext.ts` fills in, not an
  // environment variable, so it is removed before the check.
  const templateTokenStart = `__${ARC_IDENTITY.environmentPrefix}`;
  for (const source of sources) {
    const text = fs
      .readFileSync(path.join(sourceRoot, source), 'utf8')
      .replaceAll('ARC_IDENTITY', '')
      .replaceAll(templateTokenStart, '');
    for (const identifier of identifiers) {
      assert.ok(!text.includes(identifier), `${source} bypasses identity.ts with ${identifier}`);
    }
  }
});

test('Arc registers its own document providers', () => {
  const extensionSource = fs.readFileSync(path.join(__dirname, 'extension.ts'), 'utf8');
  const panelHostSource = fs.readFileSync(path.join(__dirname, 'panelhost.ts'), 'utf8');
  sourceMatch(extensionSource, /registerTextDocumentContentProvider\(SCHEME, provider\)/);
  sourceMatch(panelHostSource, /registerTextDocumentContentProvider\(PATCH_SCHEME,/);
});

test('Arc keeps persistent status and agent request actions in the Panel', () => {
  const extensionSource = fs.readFileSync(path.join(__dirname, 'extension.ts'), 'utf8');
  const manifest = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8');
  sourceDoesNotMatch(extensionSource, /createStatusBarItem/);
  sourceDoesNotMatch(extensionSource, /answerAgent/);
  assert.doesNotMatch(manifest, /answerAgent/);
});
