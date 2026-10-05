import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

export interface BrowserGlobalViolation {
  file: string;
  line: number;
  name: string;
}

function isProductionSource(file: string): boolean {
  const name = path.basename(file);
  return (
    /\.(?:[cm]?[jt]s|[jt]sx)$/.test(name) &&
    !/\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/.test(name) &&
    !/\.d\.[cm]?ts$/.test(name)
  );
}

export function productionFiles(root: string): string[] {
  const files: string[] = [];
  function visit(directory: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(file);
      } else if (entry.isFile() && isProductionSource(file)) {
        files.push(file);
      }
    }
  }
  visit(root);
  return files;
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

function runtimeSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  function add(node: ts.Expression | undefined): void {
    if (node && ts.isStringLiteralLike(node)) {
      specifiers.push(node.text);
    }
  }
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      if (!importIsTypeOnly(node)) {
        add(node.moduleSpecifier);
      }
    } else if (ts.isExportDeclaration(node)) {
      if (!exportIsTypeOnly(node)) {
        add(node.moduleSpecifier);
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')
      ) {
        add(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return specifiers;
}

function isWithin(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function browserRuntimeFiles(entries: string[], sourceRoot: string, options: ts.CompilerOptions): string[] {
  const files = new Set(entries.map((file) => path.resolve(file)));
  const pending = [...files];
  while (pending.length) {
    const file = pending.pop()!;
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      options.target ?? ts.ScriptTarget.ES2022,
      true,
      file.endsWith('x') ? ts.ScriptKind.TSX : undefined,
    );
    for (const specifier of runtimeSpecifiers(source)) {
      const resolved = ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule?.resolvedFileName;
      if (!resolved) {
        continue;
      }
      const dependency = path.resolve(resolved);
      if (!isWithin(sourceRoot, dependency) || !isProductionSource(dependency) || files.has(dependency)) {
        continue;
      }
      files.add(dependency);
      pending.push(dependency);
    }
  }
  return [...files];
}

function fromNodeTypes(file: string): boolean {
  return file.split(path.sep).join('/').includes('/node_modules/@types/node/');
}

export function browserGlobalViolations(
  root: string,
  configFile = path.join(root, 'tsconfig.json'),
): BrowserGlobalViolation[] {
  const loaded = ts.readConfigFile(configFile, ts.sys.readFile);
  if (loaded.error) {
    throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'));
  }
  const configured = ts.parseJsonConfigFileContent(loaded.config, ts.sys, path.dirname(configFile));
  const options = { ...configured.options, allowJs: true, checkJs: false };
  const files = browserRuntimeFiles(productionFiles(root), path.dirname(root), options);
  const program = ts.createProgram(files, options);
  const checker = program.getTypeChecker();
  const violations: BrowserGlobalViolation[] = [];
  for (const file of files) {
    const parsed = program.getSourceFile(file);
    if (!parsed) {
      throw new Error(`TypeScript did not load browser source ${file}`);
    }
    const sourceFile = parsed;
    function unaliasedSymbol(node: ts.Node): ts.Symbol | undefined {
      let symbol = checker.getSymbolAtLocation(node);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
        symbol = checker.getAliasedSymbol(symbol);
      }
      return symbol;
    }
    function nodeOnly(symbol: ts.Symbol | undefined): boolean {
      const declarations = symbol?.getDeclarations() ?? [];
      const nodeDeclarations = declarations.filter((declaration) =>
        fromNodeTypes(declaration.getSourceFile().fileName),
      );
      const browserDeclarations = declarations.filter(
        (declaration) => !fromNodeTypes(declaration.getSourceFile().fileName),
      );
      return nodeDeclarations.length > 0 && browserDeclarations.length === 0;
    }
    function expressionIsNodeOnly(node: ts.Expression): boolean {
      if (ts.isPropertyAccessExpression(node)) {
        return nodeOnly(unaliasedSymbol(node.name));
      }
      if (
        ts.isElementAccessExpression(node) &&
        node.argumentExpression &&
        ts.isStringLiteralLike(node.argumentExpression)
      ) {
        return nodeOnly(
          checker.getPropertyOfType(checker.getTypeAtLocation(node.expression), node.argumentExpression.text),
        );
      }
      return nodeOnly(unaliasedSymbol(node));
    }
    function report(node: ts.Node, name: string): void {
      violations.push({
        file: path.relative(root, file).split(path.sep).join('/'),
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        name,
      });
    }
    function visit(node: ts.Node): void {
      if (ts.isIdentifier(node)) {
        if (nodeOnly(unaliasedSymbol(node))) {
          const receiver =
            ts.isPropertyAccessExpression(node.parent) && node.parent.name === node
              ? node.parent.expression
              : undefined;
          if (!receiver || !expressionIsNodeOnly(receiver)) {
            report(node, node.text);
          }
        }
      } else if (
        ts.isElementAccessExpression(node) &&
        node.argumentExpression &&
        ts.isStringLiteralLike(node.argumentExpression)
      ) {
        const symbol = checker.getPropertyOfType(
          checker.getTypeAtLocation(node.expression),
          node.argumentExpression.text,
        );
        if (nodeOnly(symbol) && !expressionIsNodeOnly(node.expression)) {
          report(node.argumentExpression, node.argumentExpression.text);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
  return violations;
}

const scriptPath = path.resolve(__filename);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const root = path.resolve(path.dirname(scriptPath), '..', 'src', 'webview');
  const violations = browserGlobalViolations(root);
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line}: browser code uses Node global ${violation.name}`);
  }
  if (violations.length) {
    process.exitCode = 1;
  }
}
