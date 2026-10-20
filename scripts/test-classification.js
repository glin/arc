const fs = require('node:fs');
const path = require('node:path');
const ts = require('../extension/node_modules/typescript');
const { createHash } = require('node:crypto');

function testFiles(root) {
  const result = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const name = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') visit(name);
      else if (entry.isFile() && /\.test\.(js|mjs|ts)$/.test(name)) result.push(name);
    }
  }
  for (const directory of ['plugins', 'scripts', 'test', 'extension/src', 'cli/test']) visit(directory);
  return result.sort();
}

function hasSubprocessTag(source) {
  return /\/\/\s*@module-tag\s+subprocess\b/.test(source) || /tags:\s*\[\s*['"]subprocess['"]/.test(source);
}

function importsBuild(file, source) {
  if (!/['"]esbuild['"]/.test(source)) return false;
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const names = new Set();
  const namespaces = new Set();
  function binding(name) {
    if (ts.isIdentifier(name)) namespaces.add(name.text);
    else if (ts.isObjectBindingPattern(name))
      for (const item of name.elements)
        if (/^(?:build|buildSync|context)$/.test((item.propertyName ?? item.name).getText(ast)))
          names.add(item.name.getText(ast));
  }
  function imports(node) {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === 'esbuild') {
      const clause = node.importClause;
      if (clause?.name) namespaces.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      else if (bindings)
        for (const item of bindings.elements)
          if (/^(?:build|buildSync|context)$/.test((item.propertyName ?? item.name).text)) names.add(item.name.text);
    }
    if (ts.isVariableDeclaration(node) && node.initializer && /['"]esbuild['"]/.test(node.initializer.getText(ast)))
      binding(node.name);
    ts.forEachChild(node, imports);
  }
  imports(ast);
  let found = false;
  function calls(node) {
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (ts.isIdentifier(expr) && names.has(expr.text)) found = true;
      else if (
        ts.isPropertyAccessExpression(expr) &&
        namespaces.has(expr.expression.getText(ast)) &&
        /^(?:build|buildSync|context)$/.test(expr.name.text)
      )
        found = true;
    }
    ts.forEachChild(node, calls);
  }
  calls(ast);
  return found;
}

function classification(file, source) {
  const browser =
    /(?:\.browser|\.layout(?:\.[^.]+)?)\.test\.ts$/.test(file) ||
    /\b(?:browserOrNone|launchAnyBrowser)\s*\(/.test(source);
  const process =
    /(?:require\(|import\(|from\s+)\s*['"](?:node:)?child_process['"]/.test(source) ||
    hasSubprocessTag(source) ||
    /\b(?:runChecks|runSubprocessLane|spawnCli|createWindowFixtures|backgroundFixture|WindowChannel|writeLosslessWebp|shoot)\s*\(/.test(
      source,
    );
  const build =
    /\b(?:buildSync|browserBundle|exportBrowserAssets|pageHtml)\s*\(/.test(source) || importsBuild(file, source);
  const worker =
    /new\s+(?:Worker|ProgressiveWorker)\s*\(/.test(source) || /['"](?:node:)?worker_threads['"]/.test(source);
  return { browser, process, build, worker };
}

function caseSignatures(file, source) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const cases = [];
  function visit(node, loops) {
    if (ts.isForOfStatement(node))
      loops = [...loops, node.initializer.getText(ast) + ' of ' + node.expression.getText(ast)];
    else if (ts.isForStatement(node))
      loops = [...loops, node.initializer?.getText(ast) + ' ' + node.condition?.getText(ast)];
    if (
      ts.isCallExpression(node) &&
      /^(?:test|it)(?:\.|$)/.test(node.expression.getText(ast)) &&
      node.arguments.some((arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))
    ) {
      const title = node.arguments.find(
        (arg) => ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg) || ts.isTemplateExpression(arg),
      );
      cases.push([...loops, node.expression.getText(ast), title?.getText(ast)].join(' | ').replace(/\s+/g, ' '));
    }
    ts.forEachChild(node, (child) => visit(child, loops));
  }
  visit(ast, []);
  return cases.sort();
}

function caseBudget(file, source) {
  const cases = caseSignatures(file, source);
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const initializers = new Map();
  const repetitions = [];
  function readRepetitions(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      initializers.set(node.name.text, node.initializer.getText(ast).replace(/\s+/g, ' '));
    if (ts.isForOfStatement(node) || ts.isForInStatement(node)) repetitions.push(node.expression.getText(ast));
    else if (ts.isForStatement(node))
      repetitions.push(
        [node.initializer, node.condition, node.incrementor].map((part) => part?.getText(ast)).join(' '),
      );
    else if (ts.isWhileStatement(node) || ts.isDoStatement(node)) repetitions.push(node.expression.getText(ast));
    else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['each', 'for', 'forEach', 'map', 'flatMap', 'reduce', 'repeat', 'from'].includes(node.expression.name.text)
    )
      repetitions.push(
        node.expression.getText(ast) +
          '(' +
          node.arguments
            .filter((arg) => !ts.isArrowFunction(arg) && !ts.isFunctionExpression(arg))
            .map((arg) => arg.getText(ast))
            .join(',') +
          ')',
      );
    ts.forEachChild(node, readRepetitions);
  }
  readRepetitions(ast);
  function dependencies(expression, seen = new Set()) {
    const found = [];
    for (const [name] of expression.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
      if (!initializers.has(name) || seen.has(name)) continue;
      seen.add(name);
      const value = initializers.get(name);
      found.push(name + '=' + value, ...dependencies(value, seen));
    }
    return found;
  }
  const matrices = repetitions.map((entry) => [entry.replace(/\s+/g, ' '), ...dependencies(entry)]).sort();
  return { cases: cases.length, matricesSha256: createHash('sha256').update(JSON.stringify(matrices)).digest('hex') };
}

module.exports = { testFiles, classification, hasSubprocessTag, caseSignatures, caseBudget };
