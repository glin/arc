// Choose a filename-based badge beneath the reader's icon theme. Theme lookup failures leave this badge visible.
// Unknown extensions use a neutral badge with a truncated uppercase extension. Known entries provide labels and colors.

export interface FileIcon {
  label: string; // what the badge draws, up to four characters
  colour: string; // a CSS colour, or the empty string for the panel's neutral tone
}

// Use mid-tone colors for badges on light and dark themes.
const BLUE = '#4a9fe0';
const YELLOW = '#d6b33c';
const GREEN = '#5db56b';
const ORANGE = '#e08a4a';
const PURPLE = '#a98be0';
const RED = '#e06a5c';
const TEAL = '#43b0a3';
const PINK = '#dd7bb0';

// Use null-prototype tables so filenames such as `constructor` and `__proto__` cannot return inherited objects instead of icons.
function table(entries: Record<string, FileIcon>): Record<string, FileIcon> {
  return Object.assign(Object.create(null) as Record<string, FileIcon>, entries);
}

// Map extensions to short language or file-type labels.
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

// Match whole filenames before extensions, so `package.json` receives its NPM badge.
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

// Limit unknown extension labels to four characters so they do not displace filenames.
const MAX_LABEL = 4;

// Return a badge for every path. Names without an extension receive a neutral file mark.
export function iconFor(filePath: string): FileIcon {
  const base = (filePath.split(/[\\/]/).pop() || filePath).toLowerCase();
  const named = BY_NAME[base];
  if (named) {
    return named;
  }
  // Use the last dot in the basename. Unmapped dotfiles with no later dot have no extension.
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
