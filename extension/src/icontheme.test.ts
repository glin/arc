// extension/src/icontheme.test.ts
import { test } from 'vitest';
import assert from 'node:assert';
import {
  buildLanguageTable,
  parseIconTheme,
  resolveIcon,
  fontFor,
  usableFonts,
  familyFor,
  fontFaceRules,
  GlyphIcon,
  ImageIcon,
  IconTheme,
  LanguageTable,
  ThemeFont,
} from './icontheme.ts';

// Fixtures in the shape of the real files, cut down to what the rules turn on. The escape
// in `fontCharacter` is written the way the theme file writes it: a backslash and four hex
// digits, five characters, which is what `JSON.parse` hands back.
const SETI_SHAPED = {
  information_for_contributors: ['A fixture in the shape of the real theme.'],
  fonts: [
    {
      id: 'seti',
      src: [{ path: './seti.woff', format: 'woff' }],
      weight: 'normal',
      style: 'normal',
      size: '150%',
    },
  ],
  iconDefinitions: {
    _default: { fontCharacter: '\\E023', fontColor: '#d4d7d6' },
    _typescript: { fontCharacter: '\\E099', fontColor: '#519aba' },
    _typescript_light: { fontCharacter: '\\E099', fontColor: '#498ba7' },
    _typescript_1: { fontCharacter: '\\E09A', fontColor: '#cbcb41' },
    _javascript: { fontCharacter: '\\E060', fontColor: '#cbcb41' },
    _markdown: { fontCharacter: '\\E0A0', fontColor: '#519aba' },
    _json: { fontCharacter: '\\E062', fontColor: '#cbcb41' },
    _info: { fontCharacter: '\\E043', fontColor: '#519aba' },
    _git: { fontCharacter: '\\E01F', fontColor: '#41535b' },
    _image: { fontCharacter: '\\E036', fontColor: '#a074c4' },
  },
  file: '_default',
  // Neither `ts` nor `md` nor `json` is here, exactly as in the real file. `PNG` is
  // upper-case to show a theme is free to write its keys in any case.
  fileExtensions: {
    'test.ts': '_typescript_1',
    js: '_javascript',
    'test.js': '_typescript_1',
    gitignore: '_git',
    PNG: '_image',
  },
  fileNames: { readme: '_info', 'readme.md': '_info' },
  languageIds: { typescript: '_typescript', javascript: '_javascript', markdown: '_markdown', json: '_json' },
  light: { languageIds: { typescript: '_typescript_light' } },
  version: 'a commit of the theme this was cut down from',
};

// An image theme, in the shape of the built-in one that ships beside Seti: every definition
// is a file to draw, and its `light` block swaps the default for a paler one.
const IMAGE_SHAPED = {
  iconDefinitions: {
    _file_dark: { iconPath: './images/document-dark.svg' },
    _file_light: { iconPath: './images/document-light.svg' },
  },
  file: '_file_dark',
  fileExtensions: {},
  fileNames: {},
  languageIds: {},
  light: { file: '_file_light', fileExtensions: {}, fileNames: {}, languageIds: {} },
  highContrast: {},
};

// In the shape of `contributes.languages` in a real extension manifest.
const CONTRIBUTIONS = [
  { id: 'typescript', extensions: ['.ts', '.cts', '.mts'], aliases: ['TypeScript'] },
  { id: 'javascript', extensions: ['.js', '.es6', '.mjs', '.cjs', '.pac'], filenames: ['jakefile'] },
  { id: 'markdown', extensions: ['.md', '.markdown'] },
  { id: 'json', extensions: ['.json'], filenames: ['settings.json'] },
  { id: 'dockerfile', filenames: ['Dockerfile', 'Containerfile'] },
];

function seti(): IconTheme {
  const theme = parseIconTheme(JSON.parse(JSON.stringify(SETI_SHAPED)));
  assert.ok(theme, 'the fixture theme did not parse');
  return theme;
}

const LANGUAGES: LanguageTable = buildLanguageTable(CONTRIBUTIONS);

// The fixture theme with one part of it swapped out, so a rule can be read on its own.
function themeWith(changes: Record<string, unknown>): IconTheme {
  const theme = parseIconTheme({ ...JSON.parse(JSON.stringify(SETI_SHAPED)), ...changes });
  assert.ok(theme, 'the fixture theme did not parse');
  return theme;
}

function glyphFor(theme: IconTheme, filePath: string, light = false): GlyphIcon {
  const icon = resolveIcon(theme, LANGUAGES, filePath, light);
  assert.ok(icon, `nothing resolved for ${filePath}`);
  assert.equal(icon.kind, 'glyph', `${filePath} resolved to an image, not a glyph`);
  return icon as GlyphIcon;
}

// Every glyph here is a private-use character that prints as nothing, so the codepoint is
// what a failure has to name or it reads as one empty string against another.
function codeOf(theme: IconTheme, filePath: string, light = false): string {
  const character = glyphFor(theme, filePath, light).character;
  return `U+${character.codePointAt(0)?.toString(16).toUpperCase()} (${character.length} chars)`;
}

function code(point: number): string {
  return `U+${point.toString(16).toUpperCase()} (1 chars)`;
}

test('a whole filename is asked about before anything else', () => {
  // `readme.md` is in `fileNames` and `md` reaches markdown through a language id. The
  // filename has to win, or every README in the panel draws as a plain markdown file.
  assert.equal(codeOf(seti(), 'docs/README.md'), code(0xe043), 'README.md is not taking its own entry');
});

test('the longest extension a filename ends in wins', () => {
  const theme = seti();
  // Both `test.js` and `js` are in the theme, so a shortest-first walk would answer with
  // the plain JavaScript icon and nothing else would show it.
  assert.equal(codeOf(theme, 'src/app.test.js'), code(0xe09a), 'app.test.js took the plain js entry');
  assert.equal(codeOf(theme, 'src/app.js'), code(0xe060), 'app.js took something other than the js entry');
  assert.equal(
    codeOf(theme, 'extension/src/pricing.test.ts'),
    code(0xe09a),
    'pricing.test.ts missed the test.ts entry',
  );
});

test('a language id answers for the extensions the theme never lists', () => {
  // This is the case `.ts` actually takes: the real theme has no `fileExtensions` entry for
  // it at all, so without the language table a TypeScript file draws the default icon.
  const theme = seti();
  assert.equal(
    codeOf(theme, 'extension/src/store.ts'),
    code(0xe099),
    'a .ts file did not reach TypeScript through its language',
  );
  assert.equal(
    codeOf(theme, 'docs/architecture.md'),
    code(0xe0a0),
    'a .md file did not reach markdown through its language',
  );
  assert.equal(
    codeOf(theme, 'C:\\work\\package.json'),
    code(0xe062),
    'a .json file did not reach json through its language',
  );
});

test('a file the theme has never heard of takes its default', () => {
  assert.equal(codeOf(seti(), 'notes.qqq'), code(0xe023), 'an unknown extension did not fall to the default');
  // A name with no extension at all, and no entry under that name either.
  assert.equal(codeOf(seti(), 'Makefile'), code(0xe023), 'a name with no extension did not fall to the default');
});

test('a name with no extension can still be known by its name', () => {
  assert.equal(codeOf(seti(), 'README'), code(0xe043), 'README is not taking its own entry');
});

test('a dotfile is read as an extension, the way the editor reads it', () => {
  assert.equal(codeOf(seti(), '.gitignore'), code(0xe01f), '.gitignore was not read as an extension of gitignore');
});

test('neither the name nor the extension is matched by case', () => {
  const theme = seti();
  assert.equal(codeOf(theme, 'Docs/ReadMe.MD'), code(0xe043), 'a filename entry was matched by case');
  assert.equal(codeOf(theme, 'SRC/Store.TS'), code(0xe099), 'an extension was matched by case');
  // The theme wrote this key upper-case, so the answer has to survive that too.
  assert.equal(codeOf(theme, 'media/Shot.png'), code(0xe036), 'a theme key written upper-case was never matched');
});

test('a light colour theme changes the answer and a dark one leaves it alone', () => {
  const theme = seti();
  assert.equal(glyphFor(theme, 'src/store.ts', false).colour, '#519aba');
  assert.equal(glyphFor(theme, 'src/store.ts', true).colour, '#498ba7');
  // A file the light block says nothing about falls through to the base layer under both.
  assert.equal(glyphFor(theme, 'src/app.js', true).colour, glyphFor(theme, 'src/app.js', false).colour);
});

test('a theme that maps nothing resolves nothing', () => {
  const empty = parseIconTheme({ iconDefinitions: { _a: { fontCharacter: '\\E001' } } });
  assert.ok(empty);
  assert.equal(resolveIcon(empty, LANGUAGES, 'src/store.ts', false), null);
  // And a document that is not a theme at all.
  assert.equal(parseIconTheme('not a theme'), null);
  assert.equal(parseIconTheme(null), null);
  assert.equal(parseIconTheme([1, 2, 3]), null);
  assert.equal(resolveIcon(null, LANGUAGES, 'src/store.ts', false), null);
});

test('a font character is one real character, not the escape the file spells it with', () => {
  const icon = glyphFor(seti(), 'src/store.ts');
  assert.equal(icon.character.length, 1, `the escape was left as ${JSON.stringify(icon.character)}`);
  assert.equal(icon.character.codePointAt(0), 0xe099);
  assert.equal(icon.fontId, '');
});

test('an image theme hands back the file to draw, not a glyph', () => {
  const theme = parseIconTheme(IMAGE_SHAPED);
  assert.ok(theme);
  const dark = resolveIcon(theme, LANGUAGES, 'src/store.ts', false) as ImageIcon;
  assert.equal(dark.kind, 'image');
  // The leading `./` is dropped, so the caller can join it onto the theme's own folder.
  assert.equal(dark.path, 'images/document-dark.svg');
  const light = resolveIcon(theme, LANGUAGES, 'src/store.ts', true) as ImageIcon;
  assert.equal(light.path, 'images/document-light.svg');
  assert.equal(theme.fonts.length, 0);
});

test('a glyph is drawn in the font the theme declares for it', () => {
  const theme = seti();
  const icon = glyphFor(theme, 'src/store.ts');
  assert.equal(fontFor(theme, icon)?.id, 'seti');
  assert.equal(fontFor(theme, icon)?.size, '150%');
  // A definition naming a font the theme never declared still draws in a real font, because
  // a glyph with none behind it is an empty box.
  assert.equal(fontFor(theme, { ...icon, fontId: 'nothing-like-it' })?.id, 'seti');
  assert.equal(fontFor({ ...theme, fonts: [] }, icon), null);
});

test('the language table strips the dot and keeps the first claim on a name', () => {
  const table = buildLanguageTable([
    { id: 'typescript', extensions: ['.ts', '.MTS'] },
    { id: 'something-else', extensions: ['.ts'] },
    { id: 'dockerfile', filenames: ['Dockerfile'] },
    { id: '', extensions: ['.nameless'] },
    { extensions: ['.idless'] },
  ]);
  assert.equal(table.byExtension.ts, 'typescript');
  assert.equal(table.byExtension.mts, 'typescript');
  assert.equal(table.byFilename.dockerfile, 'dockerfile');
  assert.equal(table.byExtension.nameless, undefined);
  assert.equal(table.byExtension.idless, undefined);
});

test('a language id is matched in the case its own extension declares it', () => {
  // The editor keys `languageIds` exactly, and an id is written one way only: it comes off
  // an extension manifest on both sides. Lower-casing one side and not the other leaves any
  // id carrying an upper-case letter unable to match anything, ever.
  const theme = themeWith({ languageIds: { ...SETI_SHAPED.languageIds, ObjectPascal: '_info' } });
  const languages = buildLanguageTable([{ id: 'ObjectPascal', extensions: ['.pas'] }]);
  const icon = resolveIcon(theme, languages, 'src/unit.pas', false) as GlyphIcon;
  assert.equal(icon?.kind, 'glyph', 'a language id with an upper-case letter resolved nothing');
  assert.equal(icon.character.codePointAt(0), 0xe043, 'a language id was matched in the wrong case');
});

test('a font character that is not one character resolves nothing', () => {
  // The field names one glyph out of a font. A whole word drawn in its place runs across the
  // filename beside it, so it falls through and the row keeps its lettered badge instead.
  const words = themeWith({ iconDefinitions: { _default: { fontCharacter: 'hello', fontColor: '#d4d7d6' } } });
  assert.equal(resolveIcon(words, LANGUAGES, 'notes.qqq', false), null, 'a whole word was taken as the icon glyph');
  // An escape naming no character there is falls through as well.
  const past = themeWith({ iconDefinitions: { _default: { fontCharacter: '\\110000' } } });
  assert.equal(
    resolveIcon(past, LANGUAGES, 'notes.qqq', false),
    null,
    'an escape past the last codepoint was drawn as itself',
  );
  // A theme that writes the character itself, which `JSON.parse` hands back already resolved,
  // is still a font character and still draws.
  const literal = themeWith({ iconDefinitions: { _default: { fontCharacter: '\u{1f5ce}' } } });
  const icon = resolveIcon(literal, LANGUAGES, 'notes.qqq', false) as GlyphIcon;
  assert.equal(icon?.kind, 'glyph', 'a theme writing the character itself resolved nothing');
  assert.equal(icon.character.codePointAt(0), 0x1f5ce);
  // And a definition whose glyph is refused still draws the image beside it, when it has one.
  const both = themeWith({ iconDefinitions: { _default: { fontCharacter: 'hello', iconPath: './images/file.svg' } } });
  assert.deepEqual(resolveIcon(both, LANGUAGES, 'notes.qqq', false), { kind: 'image', path: 'images/file.svg' });
});

test('a font size the row cannot hold is refused, and one it can is kept', () => {
  // The size lands on the glyph in a fixed column beside the filename, and nothing clips
  // that column, so an unbounded size paints one glyph across the whole panel.
  const sizeOf = (size: unknown) => themeWith({ fonts: [{ ...SETI_SHAPED.fonts[0], size }] }).fonts[0].size;
  assert.equal(sizeOf('150%'), '150%', 'the size the default theme actually asks for was refused');
  assert.equal(sizeOf('300%'), '300%');
  assert.equal(sizeOf('301%'), '');
  assert.equal(sizeOf('32px'), '32px');
  assert.equal(sizeOf('33px'), '');
  assert.equal(sizeOf('4000px'), '', 'a theme can paint one glyph across the panel');
  assert.equal(sizeOf('3em'), '3em');
  assert.equal(sizeOf('3.5em'), '');
  assert.equal(sizeOf('0%'), '', 'a glyph asked for at no size at all draws as nothing');
  assert.equal(sizeOf('150'), '', 'a number with no unit is not a size');
  assert.equal(sizeOf('calc(100% + 4000px)'), '');
  assert.equal(sizeOf('150%; position: fixed; inset: 0'), '');
  assert.equal(sizeOf(42), '', 'a size that is not a string at all');
});

test('a font whose files have all gone is dropped, so the row gets its badge back', () => {
  // Nothing else stats a theme's font files. This is not one row either: the theme's default
  // entry answers for every file it does not otherwise know, so every row goes through the
  // glyph path and one missing file empties the whole column.
  const theme = seti();
  const icon = glyphFor(theme, 'src/store.ts');
  assert.equal(
    usableFonts(theme.fonts, () => true).length,
    1,
    'a font whose file is where the theme said it was was dropped',
  );
  const gone: IconTheme = { ...theme, fonts: usableFonts(theme.fonts, () => false) };
  assert.deepEqual(gone.fonts, [], 'a font with no file behind it survived');
  assert.equal(fontFor(gone, icon), null, 'a glyph still asks for a font whose file has gone');
  assert.deepEqual(
    fontFaceRules(gone, () => 'https://host.invalid/x.woff'),
    [],
    'a rule was written for a font with no file behind it',
  );
  // One file gone out of two leaves the font standing on the one that is there.
  const two: ThemeFont[] = [
    {
      id: 'seti',
      src: [
        { path: 'gone.woff2', format: 'woff2' },
        { path: 'seti.woff', format: 'woff' },
      ],
      weight: '',
      style: '',
      size: '',
    },
  ];
  assert.deepEqual(usableFonts(two, (p) => p === 'seti.woff')[0].src, [{ path: 'seti.woff', format: 'woff' }]);
  // A check that cannot answer counts as gone, since the panel draws either way.
  assert.deepEqual(
    usableFonts(theme.fonts, () => {
      throw new Error('unreadable');
    }),
    [],
  );
});

test("a font family name is the panel's own, whatever the theme called its font", () => {
  // The id is a string out of someone else's JSON, and it is written into a stylesheet as
  // text. Handed over as it stands, an id holding a quote and a brace closes the rule and
  // opens one of its own.
  const theme = themeWith({
    fonts: [
      { id: 'a"; } * { display: none } @font-face { font-family: "b', src: [{ path: 'a.woff' }] },
      { id: 'séti (2);', src: [{ path: 'b.woff' }] },
      { id: '', src: [{ path: 'c.woff' }] },
      { id: '!!!', src: [{ path: 'd.woff' }] },
    ],
  });
  assert.equal(theme.fonts.length, 4, 'the fixture lost a font before the rule was reached');
  const families = theme.fonts.map((font) => familyFor(theme, font));
  for (const family of families) {
    assert.match(
      family,
      /^arc-icon-\d+(-[a-zA-Z0-9_-]+)?$/,
      `a family name of "${family}" carries something a family name may not hold`,
    );
  }
  // Two ids that clean down to the same thing, or to nothing, still name two different fonts.
  assert.equal(new Set(families).size, families.length, 'two fonts came out sharing one family name');
});

test('an address that could close the rule early is encoded, and still names its own file', () => {
  // A space in a folder name is ordinary on Windows, so the address is encoded rather than
  // stripped: deleting the space would quietly name a different file.
  const hostile = 'https://host.invalid/a"b\'c(d)e\\f g\nh/seti.woff';
  const rules = fontFaceRules(seti(), () => hostile);
  assert.equal(rules.length, 1, 'the fixture theme wrote no rule to read');
  const address = /url\("([^"]*)"\)/.exec(rules[0]);
  assert.ok(address, `the rule carries no one quoted address: ${rules[0]}`);
  assert.doesNotMatch(
    address[1],
    /["'()\\\s]/,
    `the address carries something that closes the rule early: ${address[1]}`,
  );
  assert.equal(decodeURIComponent(address[1]), hostile, 'the address no longer names the file the theme asked for');
});

test('what the panel installs is one well-formed font-face rule and nothing else', () => {
  // Every value in it comes out of someone else's JSON and lands in a stylesheet as text.
  // Read whole rather than a value at a time: a rule that parses as two rules is how a theme
  // gets to write CSS of its own, and no single-value check sees it.
  const theme = themeWith({
    fonts: [
      {
        id: 'seti',
        src: [
          { path: 'seti.woff', format: 'woff' },
          { path: 'seti.ttf', format: 'true type' },
        ],
        weight: 'normal',
        style: 'italic; position: fixed',
        size: '150%',
      },
    ],
  });
  const rules = fontFaceRules(theme, (p) => `https://host.invalid/${p}`);
  assert.equal(rules.length, 1);
  assert.match(
    rules[0],
    new RegExp(
      '^@font-face \\{ font-family: "arc-icon-0-seti"; ' +
        'src: url\\("[^"\'()\\\\\\s]+"\\)( format\\("[a-zA-Z0-9-]+"\\))?' +
        '(, url\\("[^"\'()\\\\\\s]+"\\)( format\\("[a-zA-Z0-9-]+"\\))?)*;' +
        '( font-weight: [a-zA-Z0-9 ]+;)?( font-style: [a-zA-Z0-9 ]+;)? \\}$',
    ),
    `the rule is not one well-formed @font-face: ${rules[0]}`,
  );
  // A format and a style the shape above would not have accepted are left out, not written.
  assert.doesNotMatch(rules[0], /true type/, 'a format with a space in it was written into the rule');
  assert.doesNotMatch(rules[0], /position/, 'a style carrying a declaration of its own was written into the rule');
  assert.match(rules[0], / font-weight: normal;/, 'an ordinary weight was dropped');
});

test('a file named after something on the object prototype resolves like any other', () => {
  // Every one of these maps is built from someone else's JSON. On a plain object
  // `constructor` answers with a function, which reaches the definitions as a key that is
  // not a string and leaves the row with no icon at all rather than the default one.
  const theme = seti();
  assert.equal(
    codeOf(theme, 'constructor'),
    code(0xe023),
    'a file called constructor found something the theme never held',
  );
  assert.equal(
    codeOf(theme, 'src/notes.toString'),
    code(0xe023),
    'an extension called toString found something the theme never held',
  );
  // And on the write side: `__proto__` on a plain object sets the prototype instead of a
  // key, so the language it was given is silently thrown away.
  const table = buildLanguageTable([{ id: 'proto-lang', filenames: ['__proto__'], extensions: ['.__proto__'] }]);
  assert.equal(table.byFilename['__proto__'], 'proto-lang', 'a language declared for __proto__ was dropped');
  assert.equal(table.byExtension['__proto__'], 'proto-lang', 'an extension of __proto__ was dropped');
  assert.equal(table.byExtension.constructor, undefined, 'the language table answers for a name it never held');
});
