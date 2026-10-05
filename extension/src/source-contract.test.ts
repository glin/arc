import { test } from 'vitest';
import assert from 'node:assert';
import {
  callSources,
  cssContract,
  cssDeclarations,
  declarationSource,
  layoutIndexOf,
  memberFrom,
  readsLines,
  sourceDoesNotMatch,
  sourceLayout,
  sourceMatch,
  statementFrom,
} from '../test/source-contract.ts';

const WRAPPED_CALL = [
  'stop(',
  '  busyInSession(',
  '    host.states(),',
  '    agent,',
  '    sessionId,',
  '  ),',
  ');',
].join('\n');

test('a call the formatter wraps with trailing commas still matches its one-line pattern', () => {
  sourceMatch(WRAPPED_CALL, /busyInSession\(host\.states\(\), agent, sessionId\)/);
  sourceMatch('const x =\n  1;', /const x = 1;/);
  assert.throws(() => sourceMatch(WRAPPED_CALL, /busyInSession\(host\.states\(\), sessionId\)/));
});

test('a forbidden call fails a negative guard in any layout', () => {
  assert.throws(
    () => sourceDoesNotMatch(WRAPPED_CALL, /busyInSession\(host\.states\(\), agent, sessionId\)/),
    /once its layout is set aside/,
  );
  assert.throws(() =>
    sourceDoesNotMatch(
      'busyInSession(host.states(), agent, sessionId)',
      /busyInSession\(host\.states\(\), agent, sessionId\)/,
    ),
  );
  sourceDoesNotMatch(WRAPPED_CALL, /busyInSession\(host\.states\(\), agent\)/);
});

test('a same-line guard never reaches across a line break', () => {
  const union = [
    'type Message =',
    "  | { type: 'sendPrompt'; text: string }",
    "  | { type: 'other'; session: string };",
  ].join('\n');
  const pattern = /type: 'sendPrompt';[^\n]*session: string/;
  assert.equal(readsLines(pattern), true);
  assert.throws(() => sourceMatch(union, pattern), /reads line breaks/);
  sourceMatch("  | { type: 'sendPrompt'; session: string; text: string }", pattern);
  assert.throws(() => sourceMatch('a(\n  b)', /a\(.*b\)/));
  assert.throws(() => sourceMatch('first\n  b(\n  x,\n)', /^b\(x\)$/m));
  sourceMatch('first\nb(x)', /^b\(x\)$/m);
  assert.equal(readsLines(/a[.]b/), false);
  assert.equal(readsLines(/a.b/s), false);
});

test('the layout-free reading keeps strings, templates, regular expressions and comments exact', () => {
  const source = [
    'const t = `a ${x} b    c`;',
    'const r = /https?:\\/\\//; const after = 1;',
    "const s = 'x   y'; // keep   this",
    'call(/* one , */ a, b ,)',
  ].join('\n');
  const layout = sourceLayout(source);
  assert.ok(layout.includes('`a ${x} b    c`'), layout);
  assert.ok(layout.includes('/https?:\\/\\//;const after=1;'), layout);
  assert.ok(layout.includes("'x   y';// keep   this"), layout);
  assert.ok(layout.includes('call(/* one , */a,b)'), layout);
  assert.throws(() => sourceMatch(source, /b c/));
  sourceMatch(source, /const after = 1/);
  assert.throws(() => sourceMatch('`aria-label="Stop\n     session"`', /aria-label="Stop session"/));
});

test('words stay apart in the layout-free reading', () => {
  assert.equal(sourceLayout('export  const\n  value = await   run( x )'), 'export const value=await run(x)');
  assert.throws(() => sourceMatch('const x = 1', /constx/));
  assert.throws(() => sourceMatch('return value', /returnvalue/));
});

const STYLES = [
  '/* .chips { color: red; } */',
  '.chips {',
  '  color: var(--idle);',
  "  content: 'a   b';",
  '}',
  '.x .chips { color: var(--nested); }',
  '.chips .warn { color: var(--warn); }',
  '.chips,',
  '.sessionstats {',
  '  gap: 0.2em;',
  '}',
  '@media (max-width:400px) {',
  '  #rail,',
  '  #railsash {',
  '    display:   none !important;',
  '  }',
  '}',
].join('\n');

test('a CSS rule is read by its exact selector list and its enclosing at-rules', () => {
  assert.deepEqual(cssDeclarations(STYLES, '.chips'), ['color: var(--idle)', "content: 'a   b'"]);
  assert.deepEqual(cssDeclarations(STYLES, '.x  .chips'), ['color: var(--nested)']);
  assert.deepEqual(cssDeclarations(STYLES, '.chips .warn'), ['color: var(--warn)']);
  assert.deepEqual(cssDeclarations(STYLES, '.chips, .sessionstats'), ['gap: 0.2em']);
  assert.deepEqual(cssDeclarations(STYLES, '#rail, #railsash'), []);
  assert.deepEqual(cssDeclarations(STYLES, '#rail, #railsash', ['@media (max-width: 400px)']), [
    'display: none !important',
  ]);
  assert.equal(cssContract(STYLES).length, 5, 'a commented-out rule was read as a rule');
});

test('a type-argument list the formatter wraps with a trailing comma still matches its one-line pattern', () => {
  const wrapped = ['const books = new Map<', '  string,', '  number,', '>();'].join('\n');
  sourceMatch(wrapped, /new Map<string, number>\(\)/);
});

const HOST = [
  'class Host {',
  '  private sendPrompt(',
  '    text: string,',
  '    session: string,',
  '  ): void {',
  '    this.post(text);',
  '  }',
  '  private send(): void {}',
  '}',
  "reg('arc.one', () => 1);",
  "reg('arc.two', () => 2);",
].join('\n');

test('a declaration is read whole in any layout, and a name the source lacks fails', () => {
  assert.match(declarationSource(HOST, 'sendPrompt'), /^private sendPrompt\([\s\S]*this\.post\(text\);\s*\}$/);
  assert.equal(declarationSource(HOST, 'send'), 'private send(): void {}');
  assert.throws(() => declarationSource(HOST, 'sendPromptly'), /declares no "sendPromptly"/);
});

test('a call is read whole by its callee and its first argument', () => {
  assert.deepEqual(callSources(HOST, 'reg', 'arc.two'), ["reg('arc.two', () => 2)"]);
  assert.deepEqual(callSources(HOST, 'reg', 'arc.three'), []);
  assert.deepEqual(callSources(HOST, 'this.post'), ['this.post(text)']);
});

const ACTIVATE = [
  'export function activate(): void {',
  '  const setModelFor = async (model: string) => {',
  '    if (model) {',
  '      apply(model);',
  '    }',
  '  };',
  '  panel.onModel = setModelFor;',
  '}',
].join('\n');

test('a member is read from a marker to its own end, in a class or a top-level function', () => {
  assert.equal(memberFrom(HOST, HOST.indexOf('this.post')), 'this.post(text);\n  }');
  assert.equal(memberFrom(HOST, HOST.indexOf('  private send(')), '  private send(): void {}');
  assert.equal(memberFrom(ACTIVATE, ACTIVATE.indexOf('apply(')), 'apply(model);\n    }\n  };');
  assert.throws(() => memberFrom(HOST, -1), /lacks the marker/);
  assert.throws(() => memberFrom(HOST, HOST.indexOf("reg('arc.one'")), /is a member/);
});

test('a statement is read from a marker to the end of the innermost statement', () => {
  assert.equal(statementFrom(ACTIVATE, ACTIVATE.indexOf('if (model)')), 'if (model) {\n      apply(model);\n    }');
  assert.equal(statementFrom(HOST, HOST.indexOf("reg('arc.two'")), "reg('arc.two', () => 2);");
  assert.throws(() => statementFrom(HOST, -1), /lacks the marker/);
  const trailing = "reg('arc.one', () => 1);\n// the end";
  assert.throws(() => statementFrom(trailing, trailing.indexOf('// the end')), /is a statement/);
});

test('code is found by its one-line text in any layout, at its offset in the source', () => {
  const at = layoutIndexOf(WRAPPED_CALL, 'busyInSession(host.states(), agent, sessionId)');
  assert.equal(at, WRAPPED_CALL.indexOf('busyInSession('));
  assert.equal(layoutIndexOf(WRAPPED_CALL, 'agent,', at), WRAPPED_CALL.indexOf('agent,'));
  assert.equal(layoutIndexOf(WRAPPED_CALL, 'host.states()', WRAPPED_CALL.indexOf('agent')), -1);
  assert.equal(layoutIndexOf(WRAPPED_CALL, 'busyInSession(agent'), -1);
});

test('a match that starts at a moved comma or next to an inserted space reports its source offset', () => {
  // The reading writes a comma when the next token arrives, at the offset where the comma stood.
  const comma = WRAPPED_CALL.indexOf(',\n    agent');
  assert.equal(layoutIndexOf(WRAPPED_CALL, ', agent'), comma);
  assert.equal(layoutIndexOf(WRAPPED_CALL, ', agent', comma), comma);
  assert.equal(layoutIndexOf(WRAPPED_CALL, ', agent', comma + 1), -1);
  // Two words on separate lines read as one space, which stands at the offset of the second word.
  const split = 'export\n  const value = 1;';
  assert.equal(layoutIndexOf(split, 'export const value'), 0);
  assert.equal(layoutIndexOf(split, 'const value = 1;', 1), split.indexOf('const'));
  assert.equal(layoutIndexOf(split, 'value = 1;'), split.indexOf('value'));
  assert.equal(layoutIndexOf(split, 'export const', 1), -1);
});
