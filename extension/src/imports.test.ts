import { test } from 'vitest';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import {
  inventorySourceTree,
  packageName,
  packageViolations,
  readImportEdges,
  readModuleReferences,
  runtimeImportCycles,
} from '../test/source-tree.ts';

const MAY_IMPORT_VSCODE = new Set(['extension.ts', 'panelhost.ts', 'uris.ts', 'config.ts']);
const TEST_ONLY_COMPONENTS = new Set(['panelfixture.ts', 'temproot.ts', 'turnfixtures.ts']);

function inventory() {
  return inventorySourceTree(__dirname);
}

test('only the exact root-relative vscode exemptions may import vscode', () => {
  const tree = inventory();
  const offenders: string[] = [];
  for (const file of tree.components.filter((name) => name.endsWith('.ts'))) {
    if (MAY_IMPORT_VSCODE.has(file)) continue;
    const refs = readModuleReferences(fs.readFileSync(path.join(__dirname, file), 'utf8'), file);
    if (refs.some((ref) => ref.specifier === 'vscode')) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `${offenders.join(', ')} imports vscode outside the exact exemptions`);
  for (const exempt of MAY_IMPORT_VSCODE) {
    assert.ok(tree.components.includes(exempt), `${exempt} is exempt but no longer exists`);
  }
});

test('production code does not import test support', () => {
  const tree = inventory();
  const edges = readImportEdges(__dirname, tree);
  const offenders = edges.filter(
    (edge) =>
      !edge.from.endsWith('.test.ts') &&
      !TEST_ONLY_COMPONENTS.has(edge.from) &&
      (edge.to?.startsWith('../') || (edge.to && (TEST_ONLY_COMPONENTS.has(edge.to) || tree.tests.includes(edge.to)))),
  );
  assert.deepEqual(offenders, [], offenders.map((edge) => `${edge.from} -> ${edge.to}`).join('\n'));
});

test('planned package dependencies follow their direction rules', () => {
  const tree = inventory();
  const unrecognized = tree.components.filter((file) => packageName(file) === 'other');
  assert.deepEqual(unrecognized, [], `source folders without a package rule: ${unrecognized.join(', ')}`);
  const violations = packageViolations(readImportEdges(__dirname, tree));
  assert.deepEqual(
    violations,
    [],
    violations.map((edge) => `${edge.from} (${edge.fromPackage}) -> ${edge.to} (${edge.toPackage})`).join('\n'),
  );
});

test('production imports have no runtime cycles', () => {
  const cycles = runtimeImportCycles(readImportEdges(__dirname, inventory()));
  assert.deepEqual(cycles, [], cycles.map((cycle) => cycle.paths.join(' -> ')).join('\n'));
});

test('root files are the explicit legacy package', () => {
  assert.equal(packageName('extension.ts'), 'legacy');
  assert.equal(packageName('readers/shared/jsonl.ts'), 'readers/shared');
});

test('rail prerequisite rules have one browser-safe owner', () => {
  const read = (file: string): string => fs.readFileSync(path.join(__dirname, file), 'utf8');
  const panel = read('webview/panel.ts');
  const rail = read('webview/rail.ts');
  const turnlabels = read('turnlabels.ts');
  const turnrail = read('turnrail.ts');
  const turnsearch = read('turnsearch.ts');
  const turnformat = read('turnformat.ts');

  for (const owner of [
    '../domain/labels.ts',
    '../domain/session-query.ts',
    '../view/session-query.ts',
    // The rows reach the age formatters through `railAgeFormat` in view/rail.ts, and the
    // redeclaration check below still holds formatRelative to its one owner.
    '../view/rail.ts',
  ]) {
    assert.match(
      rail,
      new RegExp(`from ['"]${owner.replace(/[.]/g, '\\.')}['"]`),
      `webview/rail.ts must import ${owner}`,
    );
  }
  for (const name of [
    'clampRailWidth',
    'formatRelative',
    'labelKey',
    'labelSuggestions',
    'labelTypedNotes',
    'matchSessions',
    'parseSessionQuery',
    'queryToken',
    'quoteQueryValue',
    'railBuckets',
    'railCardName',
    'railTimeSlot',
    'replaceToken',
    'sessionCount',
    'whereNote',
    'withWhere',
  ]) {
    for (const source of [panel, rail]) {
      assert.doesNotMatch(
        source,
        new RegExp(`function\\s+${name}\\s*\\(`),
        `a browser owner must not redeclare shared rule ${name}`,
      );
    }
  }

  assert.match(turnlabels, /from ['"]\.\/domain\/labels\.ts['"]/);
  assert.doesNotMatch(turnlabels, /export function (labelKey|labelTypedNotes)\s*\(/);
  assert.match(turnrail, /from ['"]\.\/view\/rail\.ts['"]/);
  assert.doesNotMatch(
    turnrail,
    /export function (clampRailWidth|railBuckets|railCardName|railTimeSlot|sessionCount)\s*\(/,
  );
  assert.match(turnsearch, /from ['"]\.\/domain\/session-query\.ts['"]/);
  assert.match(turnsearch, /from ['"]\.\/view\/session-query\.ts['"]/);
  assert.doesNotMatch(
    turnsearch,
    /export function (labelSuggestions|matchSessions|parseSessionQuery|queryToken|quoteQueryValue|replaceToken|whereNote|withWhere)\s*\(/,
  );
  assert.match(turnformat, /from ['"]\.\/view\/time\.ts['"]/);
  assert.doesNotMatch(turnformat, /export function (formatCompactRelative|formatRelative)\s*\(/);
});

test('Project cost native controls stay inside its Preact renderer', () => {
  const nativeControls = new Set(['button', 'input', 'select', 'textarea']);
  const offenders: string[] = [];
  const isDocument = (expression: ts.Expression): boolean =>
    (ts.isIdentifier(expression) && expression.text === 'document') ||
    (ts.isPropertyAccessExpression(expression) &&
      expression.name.text === 'document' &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === 'options');
  for (const name of ['webview/panel.ts', 'webview/chrome.ts', 'webview/projectspend.ts']) {
    const source = ts.createSourceFile(
      name,
      fs.readFileSync(path.join(__dirname, name), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node, projectSpendOwner: boolean): void => {
      const owner =
        projectSpendOwner ||
        (ts.isFunctionDeclaration(node) && !!node.name && node.name.text.toLowerCase().includes('projectspend'));
      if (
        owner &&
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        isDocument(node.expression.expression) &&
        node.expression.name.text === 'createElement' &&
        ts.isStringLiteral(node.arguments[0]) &&
        nativeControls.has(node.arguments[0].text)
      ) {
        offenders.push(`${name}:${node.getStart(source)}`);
      }
      ts.forEachChild(node, (child) => visit(child, owner));
    };
    visit(source, false);
  }
  assert.deepEqual(offenders, [], `${offenders.join(', ')} creates a Project cost control outside Preact`);
});
