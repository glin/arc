import assert from 'node:assert';
import ts from 'typescript';

// Source-text assertions accept formatter changes to whitespace and trailing commas.
// sourceMatch accepts literal or normalized matches unless the pattern reads line structure.
// sourceDoesNotMatch rejects either form.
// Normalization preserves tokens, literals, and comments. It removes trailing commas before closing brackets.
// Inter-token whitespace becomes one space between word characters and disappears otherwise.

const WORD = /^[\p{ID_Continue}$]$/u;
const CLOSERS = new Set([
  ts.SyntaxKind.CloseParenToken,
  ts.SyntaxKind.CloseBracketToken,
  ts.SyntaxKind.CloseBraceToken,
  // The end of a type-argument or type-parameter list, which a formatter also wraps with a
  // trailing comma.
  ts.SyntaxKind.GreaterThanToken,
]);
const layouts = new Map<string, Layout>();

function isWord(character: string | undefined): boolean {
  return character !== undefined && WORD.test(character);
}

function tokenSpans(source: string): { start: number; end: number; kind: ts.SyntaxKind }[] {
  const file = ts.createSourceFile('contract.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const spans: { start: number; end: number; kind: ts.SyntaxKind }[] = [];
  const visit = (node: ts.Node): void => {
    // A JSDoc block is a comment, and the gap reader copies comments whole.
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(file);
    if (children.length) {
      for (const child of children) visit(child);
      return;
    }
    const start = node.getStart(file);
    if (node.end > start) spans.push({ start, end: node.end, kind: node.kind });
  };
  visit(file);
  return spans;
}

interface Layout {
  text: string;
  /** The source offset of each character of `text`. */
  offsets: number[];
}

function readLayout(source: string): Layout {
  const cached = layouts.get(source);
  if (cached !== undefined) return cached;
  let text = '';
  const offsets: number[] = [];
  // Cache the last character to avoid repeatedly flattening the growing string.
  let last = '';
  let space = false;
  let comma = -1;
  const write = (piece: string, at: number): void => {
    text += piece;
    for (let index = 0; index < piece.length; index += 1) offsets.push(at + index);
  };
  const put = (piece: string, at: number): void => {
    if (comma !== -1) {
      write(',', comma);
      last = ',';
      comma = -1;
    }
    if (space && isWord(last) && isWord(piece[0])) {
      text += ' ';
      offsets.push(at);
    }
    write(piece, at);
    last = piece.at(-1) ?? last;
    space = false;
  };
  const gap = (from: number, to: number): void => {
    let at = from;
    while (at < to) {
      if (/\s/.test(source[at])) {
        space = true;
        at += 1;
      } else if (source.startsWith('//', at)) {
        const end = source.indexOf('\n', at);
        const stop = end === -1 || end > to ? to : end;
        put(source.slice(at, stop), at);
        space = true;
        at = stop;
      } else if (source.startsWith('/*', at)) {
        const end = source.indexOf('*/', at + 2);
        const stop = end === -1 || end + 2 > to ? to : end + 2;
        put(source.slice(at, stop), at);
        at = stop;
      } else {
        // Not trivia, so the parser skipped it. Copy it unchanged.
        put(source[at], at);
        at += 1;
      }
    }
  };
  let end = 0;
  for (const span of tokenSpans(source)) {
    gap(end, span.start);
    if (comma !== -1 && CLOSERS.has(span.kind)) comma = -1;
    if (span.kind === ts.SyntaxKind.CommaToken) {
      if (comma !== -1) {
        write(',', comma);
        last = ',';
      }
      comma = span.start;
      space = false;
    } else put(source.slice(span.start, span.end), span.start);
    end = span.end;
  }
  gap(end, source.length);
  if (comma !== -1) write(',', comma);
  const layout = { text, offsets };
  layouts.set(source, layout);
  return layout;
}

/** Normalizes TypeScript whitespace and trailing commas while preserving token and comment text.
 * Whitespace becomes one space between word characters and disappears otherwise.
 * Commas before closing brackets disappear. */
export function sourceLayout(source: string): string {
  return readLayout(source).text;
}

/** Finds the first normalized code match at or after `from` and returns its source offset, or -1. */
export function layoutIndexOf(source: string, code: string, from = 0): number {
  const { text, offsets } = readLayout(source);
  let start = 0;
  while (start < offsets.length && offsets[start] < from) start += 1;
  const found = text.indexOf(sourceLayout(code), start);
  return found === -1 ? -1 : offsets[found];
}

/** Caches parsed source across repeated queries. */
const parsed = new Map<string, ts.SourceFile>();

/** Returns accepted nodes in source order, including accepted descendants of accepted nodes. */
export function sourceNodes(source: string, select: (node: ts.Node) => boolean): string[] {
  const file = parse(source);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (select(node)) found.push(node.getText(file));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function parse(source: string): ts.SourceFile {
  const file =
    parsed.get(source) ?? ts.createSourceFile('contract.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  parsed.set(source, file);
  return file;
}

/** Identifies class elements or direct body statements of top-level function declarations. */
function isMember(node: ts.Node): boolean {
  if (ts.isClassElement(node)) return ts.isClassLike(node.parent);
  const body = node.parent;
  return (
    ts.isStatement(node) &&
    body !== undefined &&
    ts.isBlock(body) &&
    ts.isFunctionDeclaration(body.parent) &&
    ts.isSourceFile(body.parent.parent)
  );
}

/** Finds an accepted node containing `at`, including leading trivia. `innermost` selects the deepest match instead of the outermost. */
function holderOf(source: string, at: number, select: (node: ts.Node) => boolean, innermost: boolean) {
  const file = parse(source);
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (at < node.getFullStart() || at >= node.end || (found && !innermost)) return;
    if (select(node)) found = node;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Returns source from `from` through its containing class element or direct body statement of a top-level function.
 * Fails for a missing offset or containing element. */
export function memberFrom(source: string, from: number): string {
  assert.ok(from >= 0, 'The source lacks the marker, so the guard cannot read the member that holds it.');
  const member = holderOf(source, from, isMember, false);
  assert.ok(member !== undefined, `Nothing at offset ${from} is a member, so the guard cannot read one.`);
  return source.slice(from, member.end);
}

/** Returns source from `from` through the innermost containing non-block statement. Fails for a missing offset or statement. */
export function statementFrom(source: string, from: number): string {
  assert.ok(from >= 0, 'The source lacks the marker, so the guard cannot read the statement that holds it.');
  const statement = holderOf(source, from, (node) => ts.isStatement(node) && !ts.isBlock(node), true);
  assert.ok(statement !== undefined, `Nothing at offset ${from} is a statement, so the guard cannot read one.`);
  return source.slice(from, statement.end);
}

/** Returns the first function, method, accessor, property, or variable declaration named `name`. Fails when no declaration matches. */
export function declarationSource(source: string, name: string): string {
  const [found] = sourceNodes(
    source,
    (node) =>
      (ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isPropertyAssignment(node) ||
        ts.isVariableDeclaration(node)) &&
      node.name !== undefined &&
      (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      node.name.text === name,
  );
  assert.ok(found !== undefined, `The source declares no "${name}", so the guard cannot read it.`);
  return found;
}

/** Returns calls whose callee text matches `callee`. If supplied, `first` must match the first argument's string value. */
export function callSources(source: string, callee: string, first?: string): string[] {
  return sourceNodes(
    source,
    (node) =>
      ts.isCallExpression(node) &&
      node.expression.getText() === callee &&
      (first === undefined ||
        (node.arguments[0] !== undefined &&
          ts.isStringLiteralLike(node.arguments[0]) &&
          node.arguments[0].text === first)),
  );
}

/** Detects newline escapes, literal line breaks, dots without `s`, and line anchors under `m`.
 * sourceMatch excludes these patterns from normalized matching. */
export function readsLines(pattern: RegExp): boolean {
  const source = pattern.source;
  let inClass = false;
  for (let at = 0; at < source.length; at += 1) {
    const character = source[at];
    if (character === '\\') {
      if (source[at + 1] === 'n' || source[at + 1] === 'r') return true;
      at += 1;
    } else if (character === '\n' || character === '\r') return true;
    else if (inClass) {
      if (character === ']') inClass = false;
    } else if (character === '[') {
      inClass = true;
      if (source[at + 1] === ']') at += 1;
    } else if (character === '.' && !pattern.flags.includes('s')) return true;
    else if ((character === '^' || character === '$') && pattern.flags.includes('m')) return true;
  }
  return false;
}

/** Returns the literal character at a pattern offset, or undefined for classes, anchors, and other constructs. */
function literalAt(source: string, at: number): string | undefined {
  const character = source[at];
  if (character === '\\') return /[^\w\s]/.test(source[at + 1] ?? 'a') ? source[at + 1] : undefined;
  return character !== undefined && !'()[]{}|^$.*+?\\'.includes(character) ? character : undefined;
}

function quantifierAt(source: string, at: number): string {
  const brace = /^\{\d+(?:,\d*)?\}/.exec(source.slice(at));
  if (brace) return brace[0];
  return '*+?'.includes(source[at] ?? '\0') ? source[at] : '';
}

/** Normalizes pattern whitespace outside quoted strings.
 * Whitespace becomes optional except between word characters, where required whitespace becomes one space.
 * Quoted-string whitespace stays exact. */
export function layoutPattern(pattern: RegExp): RegExp {
  const source = pattern.source;
  let text = '';
  let quote = '';
  let before: string | undefined;
  for (let at = 0; at < source.length;) {
    const character = source[at];
    const whitespace = !quote && (character === ' ' || character === '\t' || source.startsWith('\\s', at));
    if (whitespace) {
      let required = false;
      while (at < source.length && (source[at] === ' ' || source[at] === '\t' || source.startsWith('\\s', at))) {
        at += source[at] === '\\' ? 2 : 1;
        const quantifier = quantifierAt(source, at);
        at += quantifier.length;
        if (quantifier === '' || quantifier === '+' || /^\{[1-9]/.test(quantifier)) required = true;
      }
      const between = isWord(before) && isWord(literalAt(source, at));
      text += between ? (required ? ' ' : ' ?') : '\\s*';
      before = undefined;
      continue;
    }
    if (character === '\\') {
      const escaped = source[at + 1] ?? '';
      text += character + escaped;
      before = literalAt(source, at);
      at += 2;
      continue;
    }
    if (character === '[' && !quote) {
      let end = at + 1;
      if (source[end] === '^') end += 1;
      if (source[end] === ']') end += 1;
      while (end < source.length && source[end] !== ']') end += source[end] === '\\' ? 2 : 1;
      text += source.slice(at, end + 1);
      before = undefined;
      at = end + 1;
      continue;
    }
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === "'" || character === '"' || character === '`') quote = character;
    text += character;
    before = literalAt(source, at);
    at += 1;
  }
  return new RegExp(text, pattern.flags.replace(/[gy]/g, ''));
}

function stateless(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
}

/** Asserts a literal or normalized source match. Patterns that read line structure receive only a literal check. */
export function sourceMatch(actual: string, expected: RegExp, message?: string | Error): void {
  const literal = stateless(expected);
  if (literal.test(actual)) return;
  if (!readsLines(expected) && layoutPattern(expected).test(sourceLayout(actual))) return;
  assert.match(
    actual,
    literal,
    message ??
      (readsLines(expected)
        ? `The source does not match ${expected}. The pattern reads line breaks, so only the source as written can match it.`
        : undefined),
  );
}

/** Rejects both literal and normalized source matches.
 * The normalized form removes source line breaks even when the pattern reads line structure. */
export function sourceDoesNotMatch(actual: string, expected: RegExp, message?: string | Error): void {
  const literal = stateless(expected);
  assert.doesNotMatch(actual, literal, message);
  const layout = sourceLayout(actual);
  if (layoutPattern(expected).test(layout)) {
    assert.fail(message ?? `The source matches ${expected} once its layout is set aside:\n${layout.slice(0, 2000)}`);
  }
}

/** A CSS rule with normalized whitespace. */
export interface CssRule {
  /** The enclosing at-rule preludes and parent selectors, outermost first. */
  conditions: string[];
  /** The selector list, for example `.chips, .sessionstats`. */
  selector: string;
  /** Each declaration as `property: value`, without the semicolon. */
  declarations: string[];
}

/** Normalizes whitespace outside CSS strings and spaces around commas and selector combinators.
 * Parentheses have no inner padding. Prelude colons receive a following space.
 * Declarations receive a space after the first colon. `!important` becomes lowercase with a preceding space. */
function canonicalCss(text: string, kind: 'selector' | 'prelude' | 'declaration'): string {
  const parts = text.trim().split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/);
  const result = parts
    .map((part, index) => {
      if (index % 2) return part;
      const spaced = part
        .replace(/\s+/g, ' ')
        .replace(/ ?, ?/g, ', ')
        .replace(/\( /g, '(')
        .replace(/ \)/g, ')')
        .replace(/ ?! ?important/gi, ' !important');
      if (kind === 'selector') return spaced.replace(/ ?([>+~]) ?(?=[^)]*(?:\(|$))/g, ' $1 ');
      if (kind === 'prelude') return spaced.replace(/ ?: ?(?=[^()]*\))/g, ': ');
      return spaced;
    })
    .join('');
  if (kind !== 'declaration') return result;
  const colon = result.indexOf(':');
  return colon === -1 ? result : `${result.slice(0, colon).trim()}: ${result.slice(colon + 1).trim()}`;
}

/** Returns stylesheet rules with comments removed and whitespace normalized outside strings. */
export function cssContract(source: string): CssRule[] {
  const rules: CssRule[] = [];
  const frames: { prelude: string; rule?: CssRule }[] = [];
  let buffer = '';
  const flushDeclaration = (): void => {
    const rule = frames.at(-1)?.rule;
    const text = buffer.trim();
    if (rule && text) rule.declarations.push(canonicalCss(text, 'declaration'));
    buffer = '';
  };
  for (let at = 0; at < source.length; at += 1) {
    const character = source[at];
    if (source.startsWith('/*', at)) {
      const end = source.indexOf('*/', at + 2);
      at = end === -1 ? source.length : end + 1;
      buffer += ' ';
    } else if (character === '"' || character === "'") {
      let end = at + 1;
      while (end < source.length && source[end] !== character) end += source[end] === '\\' ? 2 : 1;
      buffer += source.slice(at, end + 1);
      at = end;
    } else if (character === '{') {
      const prelude = canonicalCss(buffer, buffer.trim().startsWith('@') ? 'prelude' : 'selector');
      buffer = '';
      if (prelude.startsWith('@')) frames.push({ prelude });
      else {
        const rule = { conditions: frames.map((frame) => frame.prelude), selector: prelude, declarations: [] };
        rules.push(rule);
        frames.push({ prelude, rule });
      }
    } else if (character === ';') {
      if (frames.at(-1)?.rule) flushDeclaration();
      else buffer = '';
    } else if (character === '}') {
      flushDeclaration();
      frames.pop();
    } else buffer += character;
  }
  return rules;
}

/** Returns declarations matching the complete selector list and enclosing condition chain.
 * `.chips` excludes `.x .chips` and `.chips .warn`. Top-level queries exclude rules inside `@media`. */
export function cssDeclarations(source: string, selector: string, conditions: string[] = []): string[] {
  const wanted = canonicalCss(selector, 'selector');
  const within = conditions.map((condition) =>
    canonicalCss(condition, condition.trim().startsWith('@') ? 'prelude' : 'selector'),
  );
  return cssContract(source)
    .filter(
      (rule) =>
        rule.selector === wanted &&
        rule.conditions.length === within.length &&
        rule.conditions.every((condition, index) => condition === within[index]),
    )
    .flatMap((rule) => rule.declarations);
}

/** Splits a selector list at commas outside brackets and parentheses. */
export function cssSelectors(list: string): string[] {
  const parts = [''];
  let depth = 0;
  for (const character of list) {
    if (character === '(' || character === '[') depth += 1;
    if (character === ')' || character === ']') depth -= 1;
    if (character === ',' && depth === 0) parts.push('');
    else parts[parts.length - 1] += character;
  }
  return parts.map((part) => part.trim());
}

/** Returns each selector's final compound without bracket or parenthesis contents.
 * `.a > .b:hover` gives `.b:hover`. `.a :is(.b, .c)` gives `:is()`. */
export function cssSubjects(list: string): string[] {
  return cssSelectors(list).map((selector) => {
    let flat = '';
    let depth = 0;
    for (const character of selector) {
      if (character === ')' || character === ']') depth -= 1;
      if (depth === 0) flat += character;
      if (character === '(' || character === '[') depth += 1;
    }
    return flat.split(/[\s>+~]+/).at(-1) ?? '';
  });
}

/** Candidate class and ID names, including prefixes for names completed by substitutions. */
export interface ClassWords {
  words: Set<string>;
  prefixes: string[];
}

const CLASS_PROGRAM: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  types: [],
  strict: true,
  skipLibCheck: true,
  allowImportingTsExtensions: true,
  noEmit: true,
};

/** Identifies class and className property values, className assignment values, and arguments to classList.add, toggle, or replace. */
function writesClass(node: ts.Node): node is ts.Expression {
  const parent = node.parent;
  if (!parent) return false;
  const named = (name: ts.Node): boolean =>
    (ts.isIdentifier(name) || ts.isStringLiteral(name)) && (name.text === 'class' || name.text === 'className');
  if (ts.isPropertyAssignment(parent)) return parent.initializer === node && named(parent.name);
  if (ts.isBinaryExpression(parent)) {
    return (
      parent.right === node &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(parent.left) &&
      named(parent.left.name)
    );
  }
  if (ts.isCallExpression(parent) && parent.arguments.includes(node as ts.Expression)) {
    const callee = parent.expression;
    return (
      ts.isPropertyAccessExpression(callee) &&
      ['add', 'toggle', 'replace'].includes(callee.name.text) &&
      ts.isPropertyAccessExpression(callee.expression) &&
      callee.expression.name.text === 'classList'
    );
  }
  return false;
}

/** Collects candidate names from string literals, fixed template text, and string-literal types in templates and class assignments.
 * Trailing hyphens and adjacent substitutions identify prefixes. General string types contribute no candidates.
 * `values` adds a named string-union alias for fields with general string types. */
export function classWords(files: string[], values?: { file: string; type: string }): ClassWords {
  const words = new Set<string>();
  const prefixes = new Set<string>();
  const name = /^-?[_a-zA-Z][\w-]*$/;
  const program = ts.createProgram(values ? [...files, values.file] : files, CLASS_PROGRAM);
  const checker = program.getTypeChecker();
  // Add string-literal type members. Adjacent suffix text makes the last word a prefix.
  const addType = (type: ts.Type, glued: boolean): void => {
    for (const member of type.isUnion() ? type.types : [type]) {
      if (!member.isStringLiteral()) continue;
      const pieces = member.value.split(/\s+/).filter((word) => name.test(word));
      pieces.forEach((word, at) => (glued && at === pieces.length - 1 ? prefixes : words).add(word));
    }
  };
  for (const file of files) {
    const source = program.getSourceFile(file);
    if (!source) throw new Error(`classWords cannot read ${file}`);
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateLiteralToken(node)) {
        const text = node.text;
        const pieces = text.split(/\s+/).filter((word) => name.test(word));
        const substituted = ts.isTemplateHead(node) || ts.isTemplateMiddle(node);
        pieces.forEach((word, at) => {
          if (word.endsWith('-') || (substituted && at === pieces.length - 1 && !/\s$/.test(text))) {
            prefixes.add(word);
          } else {
            words.add(word);
          }
        });
      }
      if (ts.isTemplateSpan(node)) addType(checker.getTypeAtLocation(node.expression), /^\S/.test(node.literal.text));
      if (writesClass(node)) addType(checker.getTypeAtLocation(node), false);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  if (values) {
    const alias = program
      .getSourceFile(values.file)
      ?.statements.find((node) => ts.isTypeAliasDeclaration(node) && node.name.text === values.type);
    if (!alias) throw new Error(`classWords cannot find the type ${values.type} in ${values.file}`);
    const type = checker.getTypeAtLocation((alias as ts.TypeAliasDeclaration).name);
    if (!type.isUnion() || !type.types.every((member) => member.isStringLiteral())) {
      throw new Error(`${values.type} in ${values.file} must be a union of strings`);
    }
    addType(type, false);
  }
  return { words, prefixes: [...prefixes].sort() };
}

/** Checks whether a selector names a collected class or ID, including prefix matches. */
export function namesClassWord(selector: string, found: ClassWords): boolean {
  return [...selector.matchAll(/[.#](-?[_a-zA-Z][\w-]*)/g)].some(
    ([, name]) => found.words.has(name) || found.prefixes.some((prefix) => name.startsWith(prefix)),
  );
}

/** Checks whether the first selector's final compound has no class or ID outside brackets and parentheses. */
export function bareSubject(selector: string): boolean {
  return !/[.#]/.test(cssSubjects(selector)[0] ?? '');
}
