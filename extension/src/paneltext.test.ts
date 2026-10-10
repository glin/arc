// Panel text token replacement.
import { test } from 'vitest';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fillPanelText, panelTokens } from './paneltext.ts';
import { CARD_ACTIONS } from './view/card-words.ts';

test('the commit link has an accessible name in the shared word table', () => {
  assert.equal(CARD_ACTIONS.openCommit, 'Open this commit');
});

test('a token is replaced by the value named beside it, everywhere it appears', () => {
  const filled = fillPanelText(
    '#rail { flex: 0 0 __ARC_RAIL_WIDTH_DEFAULT__px; min-width: __ARC_RAIL_WIDTH_DEFAULT__px; }',
    { RAIL_WIDTH_DEFAULT: '280' },
  );
  assert.equal(filled, '#rail { flex: 0 0 280px; min-width: 280px; }');
});

test('two tokens on one line are told apart rather than run together', () => {
  // Each token ends at its first closing double underscore.

  const filled = fillPanelText('const a = __ARC_ONE__, b = __ARC_TWO__;', { ONE: '1', TWO: '2' });
  assert.equal(filled, 'const a = 1, b = 2;');
});

test('a value that is itself a table arrives as written, not flattened', () => {
  // Replacement text must retain literal dollar signs, quotes, braces, and commas.

  const table = JSON.stringify({ open: '$&', shut: "it's" });
  const filled = fillPanelText('const SECTIONS = __ARC_TURN_MENU_SECTIONS__;', { TURN_MENU_SECTIONS: table });
  assert.equal(filled, `const SECTIONS = ${table};`);
});

test('a token with no value throws and names the token, rather than reaching the page', () => {
  // Reject unfilled tokens before the panel loads.

  assert.throws(
    () => fillPanelText('const READ_LIMIT = __ARC_READ_LIMIT__;', { RAIL_WIDTH_MIN: '200' }),
    /__ARC_READ_LIMIT__ has no value.*READ_LIMIT/s,
  );
});

test('an empty value fills, so a legitimately empty table is not read as a missing one', () => {
  // An empty string is a value. Only undefined indicates a missing value.

  assert.equal(fillPanelText('x = __ARC_NOTHING__;', { NOTHING: '' }), 'x = ;');
});

test('text with no token is handed back unchanged', () => {
  const css = '#rail { flex: 0 0 280px; }\n.card { color: red; }\n';
  assert.equal(fillPanelText(css, {}), css);
});

test('only the full marker is a token, so ordinary words in the page are left alone', () => {
  // Ordinary identifiers and class names do not match the complete token marker.

  const text = '__ARC__ _ARC_X_ __arc_x__ ARC_X __ARC_X_ RAIL_WIDTH_MIN el__mod';
  assert.deepEqual(panelTokens(text), []);
  assert.equal(fillPanelText(text, { X: 'no' }), text);
});

test('the tokens a file asks for are listed once each, however often they appear', () => {
  const text = '__ARC_ONE__ __ARC_TWO__ __ARC_ONE__';
  assert.deepEqual(panelTokens(text), ['ONE', 'TWO']);
});

test('the token pattern is reusable, so a second call sees what the first one saw', () => {
  // Repeated calls must return the same result despite the global regex state.

  const text = 'a __ARC_ONE__ b';
  assert.deepEqual(panelTokens(text), ['ONE']);
  assert.deepEqual(panelTokens(text), ['ONE']);
  assert.equal(fillPanelText(text, { ONE: '1' }), 'a 1 b');
  assert.equal(fillPanelText(text, { ONE: '1' }), 'a 1 b');
});

// Every `h('input', {...})` block in the panel's sources, read across lines.
function inputBlocks(source: string): string[] {
  const blocks: string[] = [];
  for (const start of source.matchAll(/h\(\s*'input',\s*\{/g)) {
    let depth = 1;
    let at = start.index + start[0].length;
    for (; at < source.length && depth > 0; at++) {
      depth += source[at] === '{' ? 1 : source[at] === '}' ? -1 : 0;
    }
    blocks.push(source.slice(start.index, at));
  }
  return blocks;
}

// A block is allowed when it draws only checkboxes or radios, or is the rail filter box, which owns its own cross.
function textInputBlocks(source: string): string[] {
  return inputBlocks(source).filter((block) => {
    if (/class:\s*'railfilter'/.test(block)) {
      return false;
    }
    // Read every `type:` in the block, so a later one cannot hide behind an earlier checkbox.
    const literals = [...block.matchAll(/\btype:\s*([^,}\n]+)/g)].flatMap((type) =>
      [...type[1].matchAll(/'([^']*)'/g)].map((match) => match[1]),
    );
    return !literals.length || literals.some((literal) => literal !== 'checkbox' && literal !== 'radio');
  });
}

test('a single-line text box is drawn by the shared text field, wherever its type sits in the block', () => {
  const planted = [
    "h('input', {",
    "  id: 'x',",
    '  class: "labelfind",',
    "  'data-control': 'planted',",
    "  type: 'text',",
    '}),',
  ].join('\n');
  assert.equal(textInputBlocks(planted).length, 1);
  const twoTypes = ["h('input', {", "  type: 'checkbox',", '  checked,', "  type: 'text',", '}),'].join('\n');
  assert.equal(textInputBlocks(twoTypes).length, 1);
  assert.equal(textInputBlocks("h('input', { type: question.multi ? 'checkbox' : 'radio', checked })").length, 0);
  const dir = path.join(__dirname, 'webview');
  const offenders: string[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts') || file === 'text-field.ts') {
      continue;
    }
    for (const block of textInputBlocks(fs.readFileSync(path.join(dir, file), 'utf8'))) {
      offenders.push(`${file}: ${block.split('\n')[0]}`);
    }
  }
  assert.deepEqual(offenders, [], 'draw a single-line text box with textField from webview/text-field.ts');
});
