// Settings contributions and reader vocabulary.
import { test } from 'vitest';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { SECTION, SETTING_KEYS, settingName, settingDefault } from './settings.ts';
import { HISTORY_BUDGET_MAX_MIB, HISTORY_BUDGET_MIN_MIB } from './historypages.ts';
import {
  CARD_LAYOUTS,
  PROMPT_POSITIONS,
  TIMELINE_LAYOUT_WORDS,
  TIMELINE_LAYOUT_SETTINGS,
  saveTimelineLayout,
  type TimelineLayoutSetting,
} from './view/timeline-layout.ts';

test('agent processes keep a one-hour idle window by default', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
    contributes: { configuration: { properties: Record<string, Record<string, unknown>> } };
  };
  const contributed = manifest.contributes.configuration.properties['arc.agentIdleMinutes'];
  assert.equal(settingDefault('agentIdleMinutes'), 60);
  assert.equal(contributed.default, 60);
  assert.equal(contributed.minimum, 1);
});

// Setting keys and defaults must match package.json contributions.

test('every setting is contributed, with the default the code uses', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
    contributes: { configuration: { properties: Record<string, Record<string, unknown>> } };
  };
  const props = manifest.contributes.configuration.properties;

  assert.ok(SETTING_KEYS.length > 0, 'no settings to check');
  for (const key of SETTING_KEYS) {
    const name = settingName(key);
    assert.ok(props[name], `${name} is read in code but not contributed, so it can only ever be its default`);
    assert.ok(!props[name].markdownDeprecationMessage, `${name} is marked deprecated`);
    assert.deepEqual(
      props[name].default,
      settingDefault(key),
      `${name} is contributed as ${JSON.stringify(props[name].default)} but read as ${JSON.stringify(settingDefault(key))}`,
    );
    if (key === 'sessionCacheMiB') {
      assert.equal(props[name].minimum, HISTORY_BUDGET_MIN_MIB, `${name}'s contributed minimum drifted from the clamp`);
      assert.equal(props[name].maximum, HISTORY_BUDGET_MAX_MIB, `${name}'s contributed maximum drifted from the clamp`);
    }
  }

  // Every contributed setting must appear in SETTING_KEYS.

  const known = new Set(SETTING_KEYS.map(settingName));
  for (const name of Object.keys(props)) {
    assert.ok(known.has(name), `${name} is contributed but nothing reads it`);
  }
  assert.ok(
    Object.keys(props).some((n) => n.startsWith(`${SECTION}.`)),
    `nothing is contributed under ${SECTION}`,
  );
});

test('every public setting has a runtime reader', () => {
  const sources = fs
    .readdirSync(__dirname, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'));
  const read = new Set<string>();
  for (const source of sources) {
    const text = fs.readFileSync(path.join(__dirname, source.name), 'utf8');
    for (const match of text.matchAll(/\breadSetting\('([^']+)'\)/g)) {
      read.add(match[1]);
    }
  }
  assert.deepEqual(
    [...read].sort(),
    [...SETTING_KEYS].sort(),
    'the public settings and runtime readSetting calls differ',
  );
});

// Marketplace, settings, command categories, and the panel tab use the same product name.

test('the name the reader sees is the same everywhere it is written down', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
    displayName: string;
    contributes: {
      commands: { command: string; category?: string }[];
      configuration: { title: string };
      menus: { commandPalette?: { command: string; when?: string }[] };
    };
  };
  const NAME = 'Arc';
  assert.equal(manifest.displayName, NAME);
  assert.equal(manifest.contributes.configuration.title, NAME);
  // Visible command categories use the product name. Hidden commands can append words to distinguish them in Keyboard Shortcuts.

  const hiddenFromPalette = new Set(
    (manifest.contributes.menus.commandPalette ?? [])
      .filter((entry) => entry.when === 'false')
      .map((entry) => entry.command),
  );
  for (const command of manifest.contributes.commands) {
    if (command.category === undefined || command.category === NAME) {
      continue;
    }
    assert.ok(command.category.startsWith(`${NAME} `), `${command.command} is offered under some other category`);
    assert.ok(
      hiddenFromPalette.has(command.command),
      `${command.command} carries a category longer than 'Arc' but the palette can still show it`,
    );
  }
  // The panel tab title uses ARC_IDENTITY.productName.

  const panelHostSource = fs.readFileSync(path.join(__dirname, 'panelhost.ts'), 'utf8');
  assert.match(
    panelHostSource,
    /const PANEL_TITLE = ARC_IDENTITY\.productName;/,
    'the Arc tab is titled something other than the name the manifest gives',
  );
});

// Contributed Timeline layout choices must match the layout module.

test('the Timeline layout settings contribute the values the panel draws', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
    contributes: {
      configuration: {
        properties: Record<string, { enum?: string[]; enumItemLabels?: string[]; enumDescriptions?: string[] }>;
      };
    };
  };
  const props = manifest.contributes.configuration.properties;
  for (const [key, values] of [
    ['cardLayout', CARD_LAYOUTS],
    ['promptPosition', PROMPT_POSITIONS],
  ] as const) {
    const name = settingName(TIMELINE_LAYOUT_SETTINGS[key]);
    assert.deepEqual(props[name].enum, [...values], `${name} contributes values the panel does not draw`);
    // Settings labels and descriptions match the dialog labels and hints.

    const words = TIMELINE_LAYOUT_WORDS.values[key] as Record<string, string>;
    const explanations = TIMELINE_LAYOUT_WORDS.explanations[key] as Record<string, string>;
    assert.deepEqual(
      props[name].enumItemLabels,
      values.map((value) => words[value]),
      `${name} names its values in other words than the dialog`,
    );
    assert.deepEqual(
      props[name].enumDescriptions,
      values.map((value) => explanations[value]),
      `${name} explains its values in other words than the dialog`,
    );
  }
});

// Collect strings with their object paths. Array indices participate in the same traversal.

function readerWords(value: unknown, where: string, into: [string, string][]): void {
  if (typeof value === 'string') {
    into.push([where, value]);
    return;
  }
  if (value === null || typeof value !== 'object') {
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    readerWords(nested, `${where}.${key}`, into);
  }
}

// Read shipped host and browser modules. Exclude test sources and fixtures.

function shippedSources(dir: string, into: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      shippedSources(full, into);
      continue;
    }
    const name = entry.name;
    if (!name.endsWith('.ts') || name.endsWith('.d.ts') || name.includes('.test.') || name.includes('fixture')) {
      continue;
    }
    into.push(full);
  }
  return into;
}

// These property names identify element ids and classes.
const NAMES_AN_ELEMENT = new Set(['id', 'class', 'className', 'cls']);
const CLASS_LIST_CALLS = /^(add|remove|toggle|contains|replace)$/;
const SELECTOR_CALLS = /^(querySelector|querySelectorAll|closest|matches)$/;
// The first argument names an attribute. Later arguments contain its value.

const ATTRIBUTE_NAME_CALLS = /^(setAttribute|getAttribute|removeAttribute|hasAttribute)$/;

// This literal names a payload field rather than reader-facing text.

const NAMES_A_PAYLOAD_FIELD = new Set(['view/card-presentation.ts:chips']);

// Follow expressions that carry a value into its destination, including conditional classes and template fragments.

function crossable(node: ts.Node): boolean {
  return (
    ts.isConditionalExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    // An assignment is a slot rather than a step towards one, so the walk stops at it.
    (ts.isBinaryExpression(node) && node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) ||
    ts.isTemplateExpression(node) ||
    ts.isTemplateSpan(node) ||
    ts.isAsExpression(node) ||
    ts.isArrayLiteralExpression(node)
  );
}

// A local helper's parameter names identify arguments that hold element ids or classes.

function parameterNames(call: ts.CallExpression, source: ts.SourceFile): readonly ts.ParameterDeclaration[] | null {
  if (!ts.isIdentifier(call.expression)) {
    return null;
  }
  const wanted = call.expression.text;
  let found: readonly ts.ParameterDeclaration[] | null = null;
  const look = (node: ts.Node): void => {
    if (found) {
      return;
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === wanted) {
      found = node.parameters;
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === wanted &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      found = node.initializer.parameters;
    }
    node.forEachChild(look);
  };
  look(source);
  return found;
}

// Use syntax to distinguish identifiers, module paths, types, selectors, and classes from reader-facing copy.

function namesRatherThanSays(node: ts.Node, source: ts.SourceFile): boolean {
  const parent = node.parent;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isImportTypeNode(parent)) {
    return true;
  }
  if (ts.isLiteralTypeNode(parent)) {
    return true;
  }
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) {
    return true;
  }
  if ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) && parent.name === node) {
    return true;
  }
  // Follow the containing expressions to identify the destination of both direct and conditional values.

  let held: ts.Node = node;
  let above: ts.Node | undefined = node.parent;
  while (above && crossable(above)) {
    held = above;
    above = above.parent;
  }
  if (!above) {
    return false;
  }
  if (ts.isCallExpression(above)) {
    const at = above.arguments.indexOf(held as ts.Expression);
    if (at >= 0 && ts.isPropertyAccessExpression(above.expression)) {
      const method = above.expression.name.text;
      const target = above.expression.expression;
      // Selector calls identify selector arguments regardless of their spelling.

      if (SELECTOR_CALLS.test(method)) {
        return true;
      }
      if (CLASS_LIST_CALLS.test(method) && ts.isPropertyAccessExpression(target) && target.name.text === 'classList') {
        return true;
      }
      if (at === 0 && ATTRIBUTE_NAME_CALLS.test(method)) {
        return true;
      }
      // `setAttribute('class', busy ? 'chip busy' : 'chip')`, where the first argument names
      // the slot and the second one holds the class.
      const first = above.arguments[0];
      if (method === 'setAttribute' && at > 0 && ts.isStringLiteralLike(first) && first.text === 'class') {
        return true;
      }
    }
    // `el('span', 'chip busy', 'Cost')`, where the helper names its second slot a class.
    const named = at >= 0 ? parameterNames(above, source)?.[at]?.name : undefined;
    if (named && ts.isIdentifier(named) && NAMES_AN_ELEMENT.has(named.text)) {
      return true;
    }
  }
  // `{ class: 'chip busy' }`, `head.className = 'chip busy'`, and `const chipClass = 'chip'`.
  if (ts.isPropertyAssignment(above) && above.initializer === held) {
    const name = above.name;
    return (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && NAMES_AN_ELEMENT.has(name.text);
  }
  if (
    ts.isBinaryExpression(above) &&
    above.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(above.left)
  ) {
    return NAMES_AN_ELEMENT.has(above.left.name.text);
  }
  if (ts.isVariableDeclaration(above) && ts.isIdentifier(above.name)) {
    return /class(es)?$/i.test(above.name.text);
  }
  return false;
}

// Check the syntax of literals containing chip. Keep template fragments separate and report the literal's source line.

function sourceStrings(file: string, where: string, into: [string, string][]): void {
  readerStrings(fs.readFileSync(file, 'utf8'), file, where, into);
}

// Inspect source supplied in memory with the same traversal.
function readerStrings(code: string, file: string, where: string, into: [string, string][]): void {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    const literal =
      ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
    if (
      literal &&
      /\bchips?\b/i.test(node.text) &&
      !namesRatherThanSays(node, source) &&
      !NAMES_A_PAYLOAD_FIELD.has(`${where}:${node.text}`)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      into.push([`${where}:${line + 1}`, node.text]);
    }
    node.forEachChild(visit);
  };
  visit(source);
}

// Reader-facing copy names the figure or says Compact. Chip remains a code and developer-documentation term.

test('no word the reader reads says chip', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
    contributes: { configuration: { properties: Record<string, Record<string, unknown>> } };
  };
  const read: [string, string][] = [];
  for (const [name, property] of Object.entries(manifest.contributes.configuration.properties)) {
    for (const field of ['description', 'markdownDescription', 'enumDescriptions', 'enumItemLabels'] as const) {
      readerWords(property[field], `${name}.${field}`, read);
    }
  }
  assert.ok(read.length > 0, 'no contributed setting copy to read');
  readerWords(TIMELINE_LAYOUT_WORDS, 'the Timeline layout words', read);
  // Apply the vocabulary check to shipped source as well as contributed copy.

  const sources = shippedSources(__dirname);
  assert.ok(sources.length > 0, 'no shipped source to read');
  for (const file of sources) {
    sourceStrings(file, path.relative(__dirname, file).split(path.sep).join('/'), read);
  }
  for (const [where, text] of read) {
    assert.ok(!/\bchips?\b/i.test(text), `${where} says chip, a word the reader never reads: ${text}`);
  }
});

// Conditional classes remain classes. Copy beginning with a selector character remains reader-facing text.

test('the reader-word scan reads a literal by its slot and not by its spelling', () => {
  const read: [string, string][] = [];
  readerStrings(
    [
      "head.setAttribute('class', busy ? 'chip busy' : 'chip');",
      "const found = row.querySelector('.chip .name');",
      "note.textContent = '[chip]';",
    ].join('\n'),
    'slot-sample.ts',
    'slot-sample.ts',
    read,
  );
  assert.deepEqual(read, [['slot-sample.ts:3', '[chip]']]);
});

test('a layout press saves the setting its key names, and a refused save tells the reader which setting stayed as it was', async () => {
  const told: string[] = [];
  const saved: string[] = [];
  const save = async (setting: TimelineLayoutSetting, value: string) => {
    saved.push(`${settingName(setting)}=${value}`);
  };
  await saveTimelineLayout('cardLayout', 'two-columns', save, (message) => told.push(message));
  await saveTimelineLayout('promptPosition', 'below', save, (message) => told.push(message));
  assert.deepEqual(
    [saved, told],
    [[`${SECTION}.timeline.cardLayout=two-columns`, `${SECTION}.timeline.promptPosition=below`], []],
    'a layout press saved another setting, or a saved press told the reader something went wrong',
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  for (const setting of Object.values(TIMELINE_LAYOUT_SETTINGS)) {
    assert.ok(
      manifest.contributes.configuration.properties[settingName(setting)],
      `${setting} is no contributed setting`,
    );
  }
  await saveTimelineLayout(
    'promptPosition',
    'below',
    async () => {
      throw new Error('Unable to write into user settings');
    },
    (message) => told.push(message),
  );
  await saveTimelineLayout(
    'cardLayout',
    'compact',
    async () => {
      throw new Error('Unable to write into user settings');
    },
    (message) => told.push(message),
  );
  assert.deepEqual(told, [
    'Arc: The Prompt position setting did not change to Below the response. The timeline keeps its current layout.',
    'Arc: The Card layout setting did not change to Compact. The timeline keeps its current layout.',
  ]);
});
