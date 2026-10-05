import assert from 'node:assert';
import ts from 'typescript';

// Source-text assertions that hold in any formatter layout.
//
// A pattern is written against the source as it reads today. `sourceMatch` passes when the
// pattern matches that text, or when a layout-free reading of the pattern matches the
// layout-free reading of the source. `sourceDoesNotMatch` fails when either reading matches, so
// a forbidden call that the formatter wraps over several lines still trips it.
//
// The layout-free reading of a source keeps the exact text of every token, string, template,
// regular expression and comment. It drops whitespace between two tokens, except for one space
// between two word characters, and it drops a trailing comma before a closing bracket.

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
  // The last character written, kept apart because reading it back from the growing string
  // flattens that string on every piece and makes a large file cost quadratic time.
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

/** The layout-free reading of TypeScript source. Every token, string, template, regular
    expression and comment keeps its exact text. Whitespace between two pieces becomes one space
    when both sides are word characters and disappears otherwise. A comma directly before a
    closing bracket disappears. */
export function sourceLayout(source: string): string {
  return readLayout(source).text;
}

/** The source offset where `code` first starts at or after `from`, compared in the
    layout-free reading of both, or -1. A statement the formatter wraps over several lines is
    found by its one-line text. */
export function layoutIndexOf(source: string, code: string, from = 0): number {
  const { text, offsets } = readLayout(source);
  let start = 0;
  while (start < offsets.length && offsets[start] < from) start += 1;
  const found = text.indexOf(sourceLayout(code), start);
  return found === -1 ? -1 : offsets[found];
}

/** Each source text parsed once, because a test file reads the same source many times. */
const parsed = new Map<string, ts.SourceFile>();

/** The text of every node of TypeScript source that `select` accepts, in source order. A node
    inside an accepted node is still visited. */
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

/** Whether a node is a class member, or a statement directly inside the body of a function
    declared at the top of the file. */
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

/** The outermost node that holds offset `at`, counting its leading trivia, and that `select`
    accepts. */
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

/** The text of TypeScript source from offset `from` to the end of the class member that holds
    it. Outside a class, the text ends with the statement that holds `from` directly inside a
    function declared at the top of the file. It fails when `from` is -1 or nothing holds it, so
    a guard never reads an empty or runaway slice. */
export function memberFrom(source: string, from: number): string {
  assert.ok(from >= 0, 'The source lacks the marker, so the guard cannot read the member that holds it.');
  const member = holderOf(source, from, isMember, false);
  assert.ok(member !== undefined, `Nothing at offset ${from} is a member, so the guard cannot read one.`);
  return source.slice(from, member.end);
}

/** The text of TypeScript source from offset `from` to the end of the innermost statement that
    holds it. It fails when `from` is -1 or no statement holds it. */
export function statementFrom(source: string, from: number): string {
  assert.ok(from >= 0, 'The source lacks the marker, so the guard cannot read the statement that holds it.');
  const statement = holderOf(source, from, (node) => ts.isStatement(node) && !ts.isBlock(node), true);
  assert.ok(statement !== undefined, `Nothing at offset ${from} is a statement, so the guard cannot read one.`);
  return source.slice(from, statement.end);
}

/** The text of the first function, method, accessor, property or variable declared as `name`
    in TypeScript source. It fails when the source declares no such name, so a guard never
    reads an empty slice. */
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

/** The text of every call in TypeScript source whose callee reads `callee`, such as
    `readState.subscribe`, and whose first argument, when `first` is given, is that string. */
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

/** Whether a pattern reads line structure: `.` without the `s` flag, a `\n` or `\r` escape,
    a literal line break, or `^` and `$` under the `m` flag. The layout-free reading has no
    lines, so such a pattern has no layout-free form. */
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

/** The character a pattern matches literally at `at`, or undefined for a class, an anchor or
    any other construct. */
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

/** The layout-free form of a pattern. Whitespace written in the pattern, as spaces or as `\s`,
    becomes optional, except between two word characters, where the layout-free reading keeps
    one space. Whitespace inside a quoted string in the pattern stays exact, because a formatter
    never changes the inside of a string. */
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

/** Assert that TypeScript source text matches a pattern in any formatter layout. A pattern that
    reads line structure is matched only against the source as written. */
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

/** Assert that TypeScript source text matches a pattern in no formatter layout. The source as
    written and its layout-free reading must both miss the pattern. The layout-free reading is
    one line, so a pattern that reads line structure is stricter there than in the source. */
export function sourceDoesNotMatch(actual: string, expected: RegExp, message?: string | Error): void {
  const literal = stateless(expected);
  assert.doesNotMatch(actual, literal, message);
  const layout = sourceLayout(actual);
  if (layoutPattern(expected).test(layout)) {
    assert.fail(message ?? `The source matches ${expected} once its layout is set aside:\n${layout.slice(0, 2000)}`);
  }
}

/** One style rule of a stylesheet, with whitespace in one canonical shape. */
export interface CssRule {
  /** The enclosing at-rule preludes and parent selectors, outermost first. */
  conditions: string[];
  /** The selector list, for example `.chips, .sessionstats`. */
  selector: string;
  /** Each declaration as `property: value`, without the semicolon. */
  declarations: string[];
}

/** Whitespace brought to one shape outside CSS strings: one space between words, `, ` between
    list items and no space just inside parentheses. A selector gets one space around the `>`,
    `+` and `~` combinators outside parentheses. An at-rule prelude gets `: ` inside
    parentheses. A declaration gets `: ` after its property name. `!important` is written in
    lower case with one space before it. */
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

/** Every style rule of a stylesheet, with comments removed and whitespace in one canonical
    shape outside strings, so a rule reads the same however a formatter wraps or indents it. */
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

/** The declarations of every rule whose selector list is exactly `selector` and whose enclosing
    at-rules and parent selectors are exactly `conditions`. `.chips` never reads `.x .chips` or
    `.chips .warn`, and a top-level query never reads a rule inside `@media`. */
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

/** Each selector of a list, cut at the commas outside brackets and parentheses, so
    `:is(.a, .b) .c, .d` gives `:is(.a, .b) .c` and `.d`. */
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

/** The compound each selector of a list styles: the part after its last combinator, with the
    contents of every bracket and parenthesis taken out. `.a > .b:hover` gives `.b:hover`, and
    `.a :is(.b, .c)` gives `:is()`, so a subject written only inside a function reads as a
    compound that names nothing. */
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

/** Every word the TypeScript sources can write into a `class` or an `id`: each word of every
    string, and of every fixed piece of a template. A word that runs into a `${}` substitution,
    or ends in `-`, is a prefix, and stands for every name that starts with it. A value a source
    substitutes into a template, or writes where a class goes, adds each string its type can
    hold. A value whose type holds any string adds nothing, so `values` names a type alias whose
    strings join the set: the host types of fields the webview reads as plain strings, such as
    the turn status in `turn ${card.status}`. The set holds more words than the sources ever
    write as a class, and misses only a name built from a value whose type holds any string and
    that `values` leaves out. */
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

/** Whether an expression sits where a class goes: the value of a `class` or `className`
    property, the right side of a `className` assignment, or an argument to `classList.add`,
    `toggle` or `replace`. */
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

export function classWords(files: string[], values?: { file: string; type: string }): ClassWords {
  const words = new Set<string>();
  const prefixes = new Set<string>();
  const name = /^-?[_a-zA-Z][\w-]*$/;
  const program = ts.createProgram(values ? [...files, values.file] : files, CLASS_PROGRAM);
  const checker = program.getTypeChecker();
  // Each string a type can hold. `glued` is set when text follows the value with no space
  // between, so the value starts a longer name and stands as a prefix.
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

/** Whether a selector, or an at-rule and parent chain joined with it, names a class or an id
    that `classWords` found, as the whole name or after a prefix. */
export function namesClassWord(selector: string, found: ClassWords): boolean {
  return [...selector.matchAll(/[.#](-?[_a-zA-Z][\w-]*)/g)].some(
    ([, name]) => found.words.has(name) || found.prefixes.some((prefix) => name.startsWith(prefix)),
  );
}

/** Whether the compound a selector styles names no class and no id: a bare tag, `*`, or a
    compound whose only class sits inside `:is()` or `:where()`. */
export function bareSubject(selector: string): boolean {
  return !/[.#]/.test(cssSubjects(selector)[0] ?? '');
}
