// A small badge for each file row, so a list of filenames can be read at a glance.
//
// This is the floor the reader's own icon theme is drawn in front of, and it answers from
// the filename alone. It exists because nothing tells a webview which icon the explorer
// draws for a path: `icontheme.ts` works that out by rebuilding the editor's own lookup, and
// every step of that can come up empty, so something has to be under it.
//
// An unknown type is not a gap. Its own extension is the badge, in the panel's neutral
// colour, so a file the table has never heard of still reads as what it is. The table only
// adds a colour, and a shorter name where the extension is not the clearest label.

export interface FileIcon {
  label: string; // what the badge draws, up to four characters
  colour: string; // a CSS colour, or the empty string for the panel's neutral tone
}

// Mid-tone colours, because the panel is read on a light theme and a dark one and each of
// these has to stay legible on both. They follow the language's own familiar colour where
// there is one.
const BLUE = '#4a9fe0';
const YELLOW = '#d6b33c';
const GREEN = '#5db56b';
const ORANGE = '#e08a4a';
const PURPLE = '#a98be0';
const RED = '#e06a5c';
const TEAL = '#43b0a3';
const PINK = '#dd7bb0';

// A table with nothing behind it. Both of these are asked about with a piece of a filename,
// and on a plain object a file called `constructor` answers with the `Object` constructor
// and one called `__proto__` with `Object.prototype`. Both are truthy, so both would be
// handed back where an icon is expected, and the row would draw the word `undefined`.
function table(entries: Record<string, FileIcon>): Record<string, FileIcon> {
  return Object.assign(Object.create(null) as Record<string, FileIcon>, entries);
}

// By extension. The label is the extension itself wherever that is the clearest thing to
// draw, and something shorter or more familiar where it is not.
const BY_EXTENSION: Record<string, FileIcon> = table({
  ts: { label: 'TS', colour: BLUE },
  tsx: { label: 'TSX', colour: BLUE },
  mts: { label: 'TS', colour: BLUE },
  cts: { label: 'TS', colour: BLUE },
  js: { label: 'JS', colour: YELLOW },
  mjs: { label: 'JS', colour: YELLOW },
  cjs: { label: 'JS', colour: YELLOW },
  jsx: { label: 'JSX', colour: YELLOW },
  json: { label: '{ }', colour: YELLOW },
  jsonc: { label: '{ }', colour: YELLOW },
  md: { label: 'MD', colour: BLUE },
  markdown: { label: 'MD', colour: BLUE },
  mdx: { label: 'MDX', colour: BLUE },
  html: { label: '< >', colour: ORANGE },
  htm: { label: '< >', colour: ORANGE },
  xml: { label: 'XML', colour: ORANGE },
  svg: { label: 'SVG', colour: ORANGE },
  css: { label: 'CSS', colour: BLUE },
  scss: { label: 'SASS', colour: PINK },
  sass: { label: 'SASS', colour: PINK },
  less: { label: 'LESS', colour: BLUE },
  py: { label: 'PY', colour: BLUE },
  rb: { label: 'RB', colour: RED },
  go: { label: 'GO', colour: TEAL },
  rs: { label: 'RS', colour: ORANGE },
  java: { label: 'JAVA', colour: RED },
  kt: { label: 'KT', colour: PURPLE },
  swift: { label: 'SWFT', colour: ORANGE },
  c: { label: 'C', colour: BLUE },
  h: { label: 'H', colour: BLUE },
  cpp: { label: 'C++', colour: BLUE },
  cc: { label: 'C++', colour: BLUE },
  hpp: { label: 'H++', colour: BLUE },
  cs: { label: 'C#', colour: PURPLE },
  php: { label: 'PHP', colour: PURPLE },
  lua: { label: 'LUA', colour: BLUE },
  r: { label: 'R', colour: BLUE },
  sh: { label: 'SH', colour: GREEN },
  bash: { label: 'SH', colour: GREEN },
  zsh: { label: 'SH', colour: GREEN },
  ps1: { label: 'PS1', colour: BLUE },
  psm1: { label: 'PS1', colour: BLUE },
  bat: { label: 'BAT', colour: GREEN },
  cmd: { label: 'CMD', colour: GREEN },
  yml: { label: 'YML', colour: PURPLE },
  yaml: { label: 'YML', colour: PURPLE },
  toml: { label: 'TOML', colour: '' },
  ini: { label: 'INI', colour: '' },
  cfg: { label: 'CFG', colour: '' },
  conf: { label: 'CONF', colour: '' },
  env: { label: 'ENV', colour: '' },
  sql: { label: 'SQL', colour: TEAL },
  csv: { label: 'CSV', colour: GREEN },
  txt: { label: 'TXT', colour: '' },
  log: { label: 'LOG', colour: '' },
  pdf: { label: 'PDF', colour: RED },
  png: { label: 'IMG', colour: PURPLE },
  jpg: { label: 'IMG', colour: PURPLE },
  jpeg: { label: 'IMG', colour: PURPLE },
  gif: { label: 'IMG', colour: PURPLE },
  webp: { label: 'IMG', colour: PURPLE },
  ico: { label: 'IMG', colour: PURPLE },
  zip: { label: 'ZIP', colour: '' },
  gz: { label: 'ZIP', colour: '' },
  tar: { label: 'ZIP', colour: '' },
  vsix: { label: 'ZIP', colour: '' },
  vue: { label: 'VUE', colour: GREEN },
  svelte: { label: 'SVLT', colour: ORANGE },
});

// By whole filename, for the files that carry their meaning in the name rather than in an
// extension. Checked before the extension, so `package.json` is not just another `{ }`.
const BY_NAME: Record<string, FileIcon> = table({
  'package.json': { label: 'NPM', colour: RED },
  'package-lock.json': { label: 'LOCK', colour: RED },
  'tsconfig.json': { label: 'TS', colour: BLUE },
  dockerfile: { label: 'DOCK', colour: BLUE },
  makefile: { label: 'MAKE', colour: ORANGE },
  '.gitignore': { label: 'GIT', colour: ORANGE },
  '.gitattributes': { label: 'GIT', colour: ORANGE },
  license: { label: 'LIC', colour: '' },
  '.npmrc': { label: 'NPM', colour: RED },
});

// The longest badge the row has room for. An unknown extension longer than this is cut
// rather than pushing the filename out of the row.
const MAX_LABEL = 4;

// The badge for one path. Never fails and never returns nothing: a name with no extension
// at all still gets the panel's neutral file mark.
export function iconFor(filePath: string): FileIcon {
  const base = (filePath.split(/[\\/]/).pop() || filePath).toLowerCase();
  const named = BY_NAME[base];
  if (named) {
    return named;
  }
  // The last dot only. A name like `pricing.test.ts` is a TypeScript file, and a dotfile
  // such as `.gitignore` has no extension at all rather than an extension of `gitignore`.
  const dot = base.lastIndexOf('.');
  const extension = dot > 0 ? base.slice(dot + 1) : '';
  if (!extension) {
    return { label: '•', colour: '' };
  }
  const known = BY_EXTENSION[extension];
  if (known) {
    return known;
  }
  return { label: extension.slice(0, MAX_LABEL).toUpperCase(), colour: '' };
}
