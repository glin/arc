import ts from 'typescript';

const TIMER_TEXT = /setTimeout|waitForTimeout/;
const SCANNED_TEXT = /setTimeout|waitForTimeout|timers\/promises/;

function scriptKindFor(fileName: string): ts.ScriptKind {
  return fileName.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
}

interface PromiseTimerBinding {
  names: Set<string>;
  namespaces: Set<string>;
}

function promiseTimerBindings(file: ts.SourceFile): PromiseTimerBinding {
  const names = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteralLike(specifier) || !/^(node:)?timers\/promises$/.test(specifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    } else if (ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === 'setTimeout') names.add(element.name.text);
      }
    }
  }
  return { names, namespaces };
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function soleStatementCall(block: ts.Block): ts.CallExpression | undefined {
  if (block.statements.length !== 1) return undefined;
  const statement = block.statements[0];
  const expression = ts.isExpressionStatement(statement)
    ? statement.expression
    : ts.isReturnStatement(statement)
      ? statement.expression
      : undefined;
  const inner = expression && unwrapExpression(expression);
  return inner && ts.isCallExpression(inner) ? inner : undefined;
}

function isZeroOrMissingDelay(delay: ts.Expression | undefined): boolean {
  if (!delay) return true;
  const inner = unwrapExpression(delay);
  return ts.isNumericLiteral(inner) && Number(inner.text) === 0;
}

function enclosingSettlerName(node: ts.Node): string | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isArrowFunction(current) && !ts.isFunctionExpression(current)) continue;
    const owner = current.parent;
    if (
      ts.isNewExpression(owner) &&
      ts.isIdentifier(owner.expression) &&
      owner.expression.text === 'Promise' &&
      owner.arguments?.[0] === current
    ) {
      const first = current.parameters[0];
      return first && ts.isIdentifier(first.name) ? first.name.text : undefined;
    }
  }
  return undefined;
}

function settlesItsPromise(node: ts.CallExpression): boolean {
  const settler = enclosingSettlerName(node);
  if (!settler || !node.arguments[0]) return false;
  const callback = unwrapExpression(node.arguments[0]);
  if (ts.isIdentifier(callback)) return callback.text === settler;
  if (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) {
    const body = callback.body;
    const call = ts.isBlock(body)
      ? soleStatementCall(body)
      : (() => {
          const inner = unwrapExpression(body);
          return ts.isCallExpression(inner) ? inner : undefined;
        })();
    return !!call && ts.isIdentifier(call.expression) && call.expression.text === settler;
  }
  return false;
}

function isWaitForTimeoutCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  return ts.isIdentifier(callee)
    ? callee.text === 'waitForTimeout'
    : ts.isPropertyAccessExpression(callee) && callee.name.text === 'waitForTimeout';
}

function isGlobalSetTimeout(callee: ts.Expression, bindings: PromiseTimerBinding): boolean {
  if (ts.isIdentifier(callee)) return callee.text === 'setTimeout' && !bindings.names.has('setTimeout');
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'setTimeout' &&
    ts.isIdentifier(callee.expression) &&
    (callee.expression.text === 'window' || callee.expression.text === 'globalThis')
  );
}

function isSettlingTimeoutCall(node: ts.CallExpression, bindings: PromiseTimerBinding): boolean {
  return (
    isGlobalSetTimeout(node.expression, bindings) && !isZeroOrMissingDelay(node.arguments[1]) && settlesItsPromise(node)
  );
}

function isPromiseTimerSleep(node: ts.CallExpression, bindings: PromiseTimerBinding): boolean {
  const callee = node.expression;
  const boundCall =
    (ts.isIdentifier(callee) && bindings.names.has(callee.text)) ||
    (ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      bindings.namespaces.has(callee.expression.text) &&
      callee.name.text === 'setTimeout');
  return boundCall && !isZeroOrMissingDelay(node.arguments[0]);
}

function isDirectWaitCall(node: ts.CallExpression, bindings: PromiseTimerBinding): boolean {
  return isWaitForTimeoutCall(node) || isSettlingTimeoutCall(node, bindings) || isPromiseTimerSleep(node, bindings);
}

function collectWaitCalls(node: ts.Node, bindings: PromiseTimerBinding, out: ts.CallExpression[]): void {
  if (ts.isCallExpression(node) && isDirectWaitCall(node, bindings)) {
    out.push(node);
    return;
  }
  ts.forEachChild(node, (child) => collectWaitCalls(child, bindings, out));
}

function soleBodyExpression(
  fn: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
): ts.Expression | undefined {
  const body = fn.body;
  if (!body) return undefined;
  if (!ts.isBlock(body)) return body;
  if (body.statements.length !== 1) return undefined;
  const statement = body.statements[0];
  return ts.isReturnStatement(statement) || ts.isExpressionStatement(statement) ? statement.expression : undefined;
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    !!ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  );
}

interface WaitHelper {
  name: string;
  exported: boolean;
}
interface WaitHelpers {
  helpers: WaitHelper[];
  templates: Set<ts.CallExpression>;
}

function findWaitHelpers(file: ts.SourceFile, bindings: PromiseTimerBinding): WaitHelpers {
  const helpers: WaitHelper[] = [];
  const templates = new Set<ts.CallExpression>();
  function consider(
    name: string,
    fn: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
    exported: boolean,
  ): void {
    const expression = soleBodyExpression(fn);
    if (!expression) return;
    const calls: ts.CallExpression[] = [];
    collectWaitCalls(expression, bindings, calls);
    if (calls.length === 1) {
      helpers.push({ name, exported });
      templates.add(calls[0]);
    }
  }
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = unwrapExpression(node.initializer);
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
        const statement = node.parent.parent;
        consider(node.name.text, initializer, ts.isVariableStatement(statement) && hasExportModifier(statement));
      }
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      consider(node.name.text, node, hasExportModifier(node));
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return { helpers, templates };
}

function isDeclaredName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isVariableDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isPropertyAccessExpression(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent)) &&
    parent.name === node
  );
}

function templateText(node: ts.TemplateExpression): string {
  return (
    node.head.text + node.templateSpans.map((span, index) => `__substitution${index}${span.literal.text}`).join('')
  );
}

/** Counts fixed waits in TypeScript, JavaScript, and embedded page-code strings. */
export function countFixedWaits(source: string, fileName = 'inline.ts'): number {
  if (!SCANNED_TEXT.test(source)) return 0;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
  const bindings = promiseTimerBindings(file);
  const { helpers, templates } = findWaitHelpers(file, bindings);
  const helperNames = new Set(helpers.map((helper) => helper.name));
  const calledHelpers = new Set<string>();
  const helpersUsedAsValues = new Set<string>();
  let count = 0;
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      if (!templates.has(node) && isDirectWaitCall(node, bindings)) count += 1;
    } else if (ts.isIdentifier(node) && helperNames.has(node.text) && !isDeclaredName(node)) {
      const parent = node.parent;
      if (ts.isCallExpression(parent) && parent.expression === node) {
        calledHelpers.add(node.text);
        count += 1;
      } else {
        helpersUsedAsValues.add(node.text);
      }
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (TIMER_TEXT.test(node.text)) count += countFixedWaits(node.text);
    } else if (ts.isTemplateExpression(node)) {
      const text = templateText(node);
      if (TIMER_TEXT.test(text)) count += countFixedWaits(text);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  for (const helper of helpers) {
    if (helper.exported || helpersUsedAsValues.has(helper.name) || !calledHelpers.has(helper.name)) count += 1;
  }
  return count;
}
