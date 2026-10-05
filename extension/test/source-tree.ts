import * as fs from 'node:fs';
import { builtinModules } from 'node:module';
import * as path from 'node:path';
import ts from 'typescript';

export type SourceEntryKind = 'component' | 'test' | 'unsupported' | 'link';

export interface SourceEntry {
  relativePath: string;
  kind: SourceEntryKind;
}

export interface SourceInventory {
  root: string;
  entries: SourceEntry[];
  components: string[];
  tests: string[];
  unsupported: string[];
  links: string[];
}

function slash(name: string): string {
  return name.split(path.sep).join('/');
}

function entryKind(name: string): SourceEntryKind {
  if (name.endsWith('.test.ts')) {
    return 'test';
  }
  if (name.endsWith('.ts') || name.endsWith('.js') || name.endsWith('.css') || name === 'tsconfig.json') {
    return 'component';
  }
  return 'unsupported';
}

/** Walks directory entries without following symbolic links or junctions within the tree. */
export function inventorySourceTree(root: string): SourceInventory {
  const absoluteRoot = path.resolve(root);
  const entries: SourceEntry[] = [];

  function visit(directory: string, prefix: string): void {
    const children = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      const relativePath = slash(prefix ? path.join(prefix, child.name) : child.name);
      const fullPath = path.join(directory, child.name);
      let linked = child.isSymbolicLink();
      if (!linked) {
        try {
          linked = fs.lstatSync(fullPath).isSymbolicLink();
        } catch {
          entries.push({ relativePath, kind: 'unsupported' });
          continue;
        }
      }
      if (linked) {
        entries.push({ relativePath, kind: 'link' });
        continue;
      }
      if (child.isDirectory()) {
        visit(fullPath, relativePath);
        continue;
      }
      if (child.isFile()) {
        entries.push({ relativePath, kind: entryKind(child.name) });
        continue;
      }
      entries.push({ relativePath, kind: 'unsupported' });
    }
  }

  visit(absoluteRoot, '');
  entries.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  return {
    root: absoluteRoot,
    entries,
    components: entries.filter((entry) => entry.kind === 'component').map((entry) => entry.relativePath),
    tests: entries.filter((entry) => entry.kind === 'test').map((entry) => entry.relativePath),
    unsupported: entries.filter((entry) => entry.kind === 'unsupported').map((entry) => entry.relativePath),
    links: entries.filter((entry) => entry.kind === 'link').map((entry) => entry.relativePath),
  };
}

// Collect test files from the extension, root, and CLI lanes.
// Include helpers in extension/test, test, and cli/test so shared waits and theme assignments also receive checks.
export function repoTestFiles(repoRoot: string): Map<string, string> {
  const files = new Map<string, string>(); // repository-relative path -> absolute path
  const lanes: Array<{ dir: string; prefix: string; suffixes: string[] }> = [
    { dir: path.join(repoRoot, 'extension', 'src'), prefix: 'extension/src', suffixes: ['.test.ts'] },
    { dir: path.join(repoRoot, 'extension', 'test'), prefix: 'extension/test', suffixes: ['.ts'] },
    {
      dir: path.join(repoRoot, 'plugins', 'arc-hooks', 'scripts'),
      prefix: 'plugins/arc-hooks/scripts',
      suffixes: ['.test.js'],
    },
    { dir: path.join(repoRoot, 'scripts'), prefix: 'scripts', suffixes: ['.test.js'] },
    { dir: path.join(repoRoot, 'test'), prefix: 'test', suffixes: ['.js'] },
    { dir: path.join(repoRoot, 'cli', 'test'), prefix: 'cli/test', suffixes: ['.ts', '.mjs'] },
  ];
  for (const lane of lanes) {
    const tree = inventorySourceTree(lane.dir);
    for (const entry of tree.entries) {
      if (lane.suffixes.some((suffix) => entry.relativePath.endsWith(suffix))) {
        files.set(`${lane.prefix}/${entry.relativePath}`, path.join(lane.dir, entry.relativePath));
      }
    }
  }
  return files;
}

export interface ModuleReference {
  specifier: string;
  typeOnly: boolean;
  kind: 'import' | 'export' | 'import-equals' | 'dynamic-import' | 'require';
}

function stringLiteral(node: ts.Node | undefined): string | null {
  return node && ts.isStringLiteralLike(node) ? node.text : null;
}

function importIsTypeOnly(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) {
    return false;
  }
  if (clause.isTypeOnly) {
    return true;
  }
  if (!clause.namedBindings || ts.isNamespaceImport(clause.namedBindings)) {
    return false;
  }
  return (
    clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((element) => element.isTypeOnly)
  );
}

function exportIsTypeOnly(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) {
    return true;
  }
  if (!node.exportClause || !ts.isNamedExports(node.exportClause)) {
    return false;
  }
  return node.exportClause.elements.length > 0 && node.exportClause.elements.every((element) => element.isTypeOnly);
}

/** Read module references with TypeScript syntax awareness, including type-only metadata. */
export function readModuleReferences(source: string, fileName = 'source.ts'): ModuleReference[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );
  const references: ModuleReference[] = [];
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      const specifier = stringLiteral(node.moduleSpecifier);
      if (specifier) {
        references.push({ specifier, typeOnly: importIsTypeOnly(node), kind: 'import' });
      }
    } else if (ts.isExportDeclaration(node)) {
      const specifier = stringLiteral(node.moduleSpecifier);
      if (specifier) {
        references.push({ specifier, typeOnly: exportIsTypeOnly(node), kind: 'export' });
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      const expression = ts.isExternalModuleReference(reference) ? reference.expression : undefined;
      const specifier = stringLiteral(expression);
      if (specifier) {
        references.push({ specifier, typeOnly: node.isTypeOnly, kind: 'import-equals' });
      }
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const specifier = stringLiteral(node.arguments[0]);
      if (specifier && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        references.push({ specifier, typeOnly: false, kind: 'dynamic-import' });
      } else if (specifier && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        references.push({ specifier, typeOnly: false, kind: 'require' });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return references;
}

export interface ImportEdge extends ModuleReference {
  from: string;
  to: string | null;
}

function resolveImport(root: string, from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) {
    return null;
  }
  const fromFile = path.join(root, from);
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.js`,
    `${base}.css`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.js'),
    path.join(base, 'index.css'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) {
        return slash(path.relative(root, candidate));
      }
    } catch {
      // An unresolved local reference is still useful to the external-import guard.
    }
  }
  return null;
}

export function readImportEdges(root: string, inventory = inventorySourceTree(root)): ImportEdge[] {
  const edges: ImportEdge[] = [];
  for (const from of inventory.components.filter((name) => name.endsWith('.ts') || name.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(root, from), 'utf8');
    for (const reference of readModuleReferences(source, from)) {
      edges.push({ ...reference, from, to: resolveImport(root, from, reference.specifier) });
    }
  }
  return edges;
}

export function packageName(relativePath: string): string {
  const parts = relativePath.split('/');
  if (parts.length === 1) {
    return 'legacy';
  }
  if (parts[0] === 'domain') {
    return 'domain';
  }
  if (parts[0] === 'view') {
    return 'view';
  }
  if (parts[0] === 'host') {
    return 'host';
  }
  if (parts[0] === 'webview') {
    return 'webview';
  }
  if (parts[0] === 'readers' && parts[1] === 'shared') {
    return 'readers/shared';
  }
  if (parts[0] === 'readers' && (parts[1] === 'claude' || parts[1] === 'codex')) {
    return `readers/${parts[1]}`;
  }
  if (parts[0] === 'runtime' && parts[1] === 'shared') {
    return 'runtime/shared';
  }
  if (parts[0] === 'runtime' && (parts[1] === 'claude' || parts[1] === 'codex')) {
    return `runtime/${parts[1]}`;
  }
  return 'other';
}

const READERS = new Set(['readers/shared', 'readers/claude', 'readers/codex']);
const RUNTIMES = new Set(['runtime/shared', 'runtime/claude', 'runtime/codex']);
const BROWSER_SAFE = new Set(['domain', 'view', 'webview']);
const NODE_MODULES = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

// webview/protocol.ts can import root-module types, which disappear before browser execution.
// Runtime imports from webview to root modules remain forbidden.
// source-tree.test.ts requires the allowed edge count to equal the ceiling.
// Lower the ceiling when removing an edge. Review any increase.
export const PROTOCOL_TYPE_EDGE_SOURCE = 'webview/protocol.ts';
export const PROTOCOL_TYPE_EDGE_CEILING = 1;

/** The allowed type-only edges from the protocol module to root modules. */
export function protocolTypeEdges(edges: ImportEdge[]): ImportEdge[] {
  return edges.filter(
    (edge) =>
      edge.typeOnly && edge.from === PROTOCOL_TYPE_EDGE_SOURCE && edge.to !== null && packageName(edge.to) === 'legacy',
  );
}

function packageAllowed(from: string, to: string, target: string): boolean {
  if (from === 'legacy' || from === to) {
    return true;
  }
  if (from === 'host') {
    return to !== 'other' && (to !== 'webview' || target === 'webview/protocol.ts');
  }
  if (from === 'other') {
    return false;
  }
  if (from === 'domain') {
    return to === 'domain';
  }
  if (from === 'readers/shared') {
    return to === 'domain' || to === 'readers/shared';
  }
  if (READERS.has(from)) {
    return to === 'domain' || to === 'readers/shared' || to === from;
  }
  if (from === 'runtime/shared') {
    return to === 'domain' || to === 'runtime/shared';
  }
  if (RUNTIMES.has(from)) {
    return to === 'domain' || to === 'runtime/shared' || to === from;
  }
  if (from === 'view') {
    return to === 'domain' || READERS.has(to) || to === 'view';
  }
  if (from === 'webview') {
    return to === 'domain' || to === 'view' || to === 'webview';
  }
  return true;
}

export interface PackageViolation extends ImportEdge {
  fromPackage: string;
  toPackage: string;
}

export function packageViolations(edges: ImportEdge[]): PackageViolation[] {
  const allowed = new Set(protocolTypeEdges(edges));
  return edges.flatMap((edge) => {
    const fromPackage = packageName(edge.from);
    if (!edge.to) {
      return BROWSER_SAFE.has(fromPackage) && NODE_MODULES.has(edge.specifier)
        ? [{ ...edge, fromPackage, toPackage: 'node' }]
        : [];
    }
    const toPackage = packageName(edge.to);
    if (allowed.has(edge)) {
      return [];
    }
    return packageAllowed(fromPackage, toPackage, edge.to) ? [] : [{ ...edge, fromPackage, toPackage }];
  });
}

export interface ImportCycle {
  paths: string[];
}

export function runtimeImportCycles(edges: ImportEdge[]): ImportCycle[] {
  const graph = new Map<string, string[]>();
  for (const edge of edges) {
    if (!edge.typeOnly && edge.to) graph.set(edge.from, [...(graph.get(edge.from) ?? []), edge.to]);
  }
  const cycles: ImportCycle[] = [];
  const seen = new Set<string>();
  for (const start of graph.keys()) {
    const walk = (current: string, trail: string[], active: Set<string>): void => {
      for (const next of graph.get(current) ?? []) {
        const at = trail.indexOf(next);
        if (at >= 0) {
          const cycle = trail.slice(at);
          const key = [...cycle].sort().join('|');
          if (!seen.has(key)) {
            seen.add(key);
            cycles.push({ paths: [...cycle, next] });
          }
        } else if (!active.has(next)) {
          active.add(next);
          walk(next, [...trail, next], active);
          active.delete(next);
        }
      }
    };
    walk(start, [start], new Set([start]));
  }
  return cycles.sort((a, b) => {
    const left = a.paths.join('|');
    const right = b.paths.join('|');
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
