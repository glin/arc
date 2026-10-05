// The reader's own file icons, taken from the icon theme the editor draws its explorer
// with, so a file row in the panel and the same file in the tree look alike.
//
// Plain data in, plain data out: a theme document and a table of languages go in, and one
// path's icon and the `@font-face` rules that draw it come out. Everything that has to ask
// the editor is passed in as a function, so the mapping and the sanitizing that make this
// safe are testable. Only finding the theme extension and reading its JSON needs `vscode`,
// and that half lives in `panelhost.ts`.
//
// Nothing here throws and nothing here has to succeed. A theme that cannot be understood
// resolves nothing, and the row keeps the lettered badge `fileicons.ts` works out from the
// filename.

// One language as an extension declares it, cut down to the fields that decide which
// language a filename belongs to.
export interface LanguageContribution {
  id?: string;
  extensions?: string[];
  filenames?: string[];
}

// Which language a filename belongs to. This is not a convenience: Seti, the default theme,
// carries no `fileExtensions` entry for `ts`, `md`, `json` or `py`, and reaches every one of
// them through a language id. Without this table the theme answers nothing for most of the
// files a turn touches.
export interface LanguageTable {
  byExtension: Record<string, string>; // 'ts' -> 'typescript'
  byFilename: Record<string, string>; // 'dockerfile' -> 'dockerfile'
}

// A font the theme declares, and where its files sit relative to the theme JSON.
export interface ThemeFont {
  id: string;
  src: { path: string; format: string }[];
  weight: string;
  style: string;
  size: string; // as the theme writes it, such as '150%', or empty when it asked for
  // something the row cannot hold
}

// One icon, already told apart: a character out of an icon font, or a file to draw.
export interface GlyphIcon {
  kind: 'glyph';
  character: string; // one real character
  fontId: string; // empty when the definition names no font
  colour: string; // empty when the definition names no colour
}

export interface ImageIcon {
  kind: 'image';
  path: string; // relative to the folder the theme JSON sits in
}

export type ThemeIcon = GlyphIcon | ImageIcon;

// The three lookups and the default, as one layer. A theme has a base layer and may have a
// second one that only applies under a light colour theme.
export interface IconMaps {
  file: string;
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
  languageIds: Record<string, string>;
}

export interface IconTheme {
  definitions: Record<string, ThemeIcon>;
  base: IconMaps;
  light: IconMaps | null;
  fonts: ThemeFont[];
}

// A key read off one of the maps below. Every one of them is built with no prototype, which
// is what keeps a file named `constructor` or `__proto__` from finding something the object
// never held: a plain object answers both, one with a function and one with itself.
function lookup<T>(map: Record<string, T>, key: string): T | null {
  return key ? map[key] || null : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

// A map of string to string on a bare object. `lowerCaseKeys` follows the editor, which
// matches a filename and an extension without regard to case, since a path is written in
// whatever case the disk holds it, but keys `languageIds` exactly: both sides of that
// lookup are ids out of an extension manifest, and an id is written one way only.
function stringMap(value: unknown, lowerCaseKeys: boolean): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  const source = asObject(value);
  if (!source) {
    return out;
  }
  for (const key of Object.keys(source)) {
    const target = source[key];
    if (typeof target === 'string' && target) {
      out[lowerCaseKeys ? key.toLowerCase() : key] = target;
    }
  }
  return out;
}

// The first extension to claim a name keeps it. The editor loads its own extensions before
// the ones the reader installed, so the built-in definition is the one the icon theme was
// written against, and a later extension that also claims `.ts` cannot move every
// TypeScript row onto whatever icon it prefers.
export function buildLanguageTable(contributions: LanguageContribution[]): LanguageTable {
  const byExtension: Record<string, string> = Object.create(null);
  const byFilename: Record<string, string> = Object.create(null);
  for (const language of Array.isArray(contributions) ? contributions : []) {
    const entry = asObject(language);
    const id = entry && typeof entry.id === 'string' ? entry.id : '';
    if (!entry || !id) {
      continue;
    }
    for (const raw of asStrings(entry.extensions)) {
      const key = raw.replace(/^\./, '').toLowerCase();
      if (key && !(key in byExtension)) {
        byExtension[key] = id;
      }
    }
    for (const raw of asStrings(entry.filenames)) {
      const key = raw.toLowerCase();
      if (key && !(key in byFilename)) {
        byFilename[key] = id;
      }
    }
  }
  return { byExtension, byFilename };
}

// `"\\E099"` in a theme file is a backslash and four hex digits, five characters, and not an
// escape the JSON parser resolved. It is turned into the one character it names here, once,
// rather than at every draw. A theme that writes the character itself is taken as it is.
//
// Anything else resolves nothing, and the row keeps its badge. What the field names is one
// glyph out of a font, so a longer string is not a glyph at all: drawn as it stands it runs
// across the filename beside it and takes the rest of the row with it.
function fontCharacter(raw: string): string {
  const hex = /^\\([0-9a-fA-F]{1,6})$/.exec(raw);
  if (hex) {
    const code = parseInt(hex[1], 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : '';
  }
  return Array.from(raw).length === 1 ? raw : '';
}

function asIcon(value: unknown): ThemeIcon | null {
  const definition = asObject(value);
  if (!definition) {
    return null;
  }
  const character = typeof definition.fontCharacter === 'string' ? fontCharacter(definition.fontCharacter) : '';
  if (character) {
    return {
      kind: 'glyph',
      character,
      fontId: typeof definition.fontId === 'string' ? definition.fontId : '',
      colour: typeof definition.fontColor === 'string' ? definition.fontColor : '',
    };
  }
  const image = typeof definition.iconPath === 'string' ? definition.iconPath.replace(/^\.\//, '') : '';
  return image ? { kind: 'image', path: image } : null;
}

function asMaps(document: Record<string, unknown>): IconMaps {
  return {
    file: typeof document.file === 'string' ? document.file : '',
    fileNames: stringMap(document.fileNames, true),
    fileExtensions: stringMap(document.fileExtensions, true),
    languageIds: stringMap(document.languageIds, false),
  };
}

// The size a glyph is drawn at, when the theme asks for one the row can hold. The icon sits
// in a fixed column beside a filename, and the panel puts no ceiling on that column, so a
// theme asking for `4000px` would paint one glyph across the whole panel. These are about
// three times the row's own text, which is as large as an icon in front of a filename can
// usefully be. A size that is refused leaves the glyph at the panel's own size, which is
// legible; clipping the column instead would cut a legitimately tall glyph in half.
function fontSize(raw: string): string {
  const size = raw.trim();
  const parsed = /^(\d{1,4}(?:\.\d+)?)(%|px|pt|em|rem)$/.exec(size);
  if (!parsed) {
    return '';
  }
  const value = Number(parsed[1]);
  const limit = parsed[2] === '%' ? 300 : parsed[2] === 'em' || parsed[2] === 'rem' ? 3 : 32;
  return value > 0 && value <= limit ? size : '';
}

function asFonts(value: unknown): ThemeFont[] {
  const fonts: ThemeFont[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const font = asObject(entry);
    if (!font) {
      continue;
    }
    const src: { path: string; format: string }[] = [];
    for (const item of Array.isArray(font.src) ? font.src : []) {
      const source = asObject(item);
      const file = source && typeof source.path === 'string' ? source.path.replace(/^\.\//, '') : '';
      if (!source || !file) {
        continue;
      }
      src.push({ path: file, format: typeof source.format === 'string' ? source.format : '' });
    }
    if (!src.length) {
      continue;
    }
    fonts.push({
      id: typeof font.id === 'string' ? font.id : '',
      src,
      weight: typeof font.weight === 'string' ? font.weight : '',
      style: typeof font.style === 'string' ? font.style : '',
      size: typeof font.size === 'string' ? fontSize(font.size) : '',
    });
  }
  return fonts;
}

// A theme document normalized into something with no surprises left in it. Returns null when
// the file is not a JSON object at all, which is as far as this can tell that a theme is
// unusable: a document that parses but maps nothing simply resolves nothing.
export function parseIconTheme(json: unknown): IconTheme | null {
  const document = asObject(json);
  if (!document) {
    return null;
  }
  const definitions: Record<string, ThemeIcon> = Object.create(null);
  const raw = asObject(document.iconDefinitions);
  for (const key of raw ? Object.keys(raw) : []) {
    const icon = asIcon((raw as Record<string, unknown>)[key]);
    if (icon) {
      definitions[key] = icon;
    }
  }
  const light = asObject(document.light);
  return {
    definitions,
    base: asMaps(document),
    light: light ? asMaps(light) : null,
    fonts: asFonts(document.fonts),
  };
}

// Every extension a filename ends in, longest first. A theme carries both `test.ts` and `ts`
// and the longer one is the more specific answer, so `a.test.ts` asks for `test.ts` before
// `ts`. A dotfile such as `.gitignore` asks for `gitignore`, which is how the editor reads
// it too.
function extensionCandidates(name: string): string[] {
  const parts = name.split('.');
  const candidates: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    candidates.push(parts.slice(i).join('.'));
  }
  return candidates;
}

function languageOf(languages: LanguageTable | null, name: string, extensions: string[]): string {
  if (!languages) {
    return '';
  }
  const named = lookup(languages.byFilename, name);
  if (named) {
    return named;
  }
  for (const extension of extensions) {
    const found = lookup(languages.byExtension, extension);
    if (found) {
      return found;
    }
  }
  return '';
}

// One layer's answer, in the editor's own order: the whole filename, then the extension,
// then the language the filename belongs to.
function keyIn(maps: IconMaps | null, name: string, extensions: string[], language: string): string {
  if (!maps) {
    return '';
  }
  const named = lookup(maps.fileNames, name);
  if (named) {
    return named;
  }
  for (const extension of extensions) {
    const found = lookup(maps.fileExtensions, extension);
    if (found) {
      return found;
    }
  }
  return lookup(maps.languageIds, language) || '';
}

// The theme's icon for one path, or null when it has none. `light` says whether the reader's
// colour theme is a light one, because the theme's `light` block only applies then.
export function resolveIcon(
  theme: IconTheme | null,
  languages: LanguageTable | null,
  filePath: string,
  light: boolean,
): ThemeIcon | null {
  if (!theme || !filePath) {
    return null;
  }
  const name = (filePath.split(/[\\/]/).pop() || filePath).toLowerCase();
  if (!name) {
    return null;
  }
  const extensions = extensionCandidates(name);
  const language = languageOf(languages, name, extensions);
  // Under a light colour theme the whole `light` block goes in front of the base one, which
  // is what the editor does: every rule it holds outranks every rule below it, whichever of
  // the three maps each came from. The two defaults are the last resort, in the same order.
  const key =
    (light ? keyIn(theme.light, name, extensions, language) : '') ||
    keyIn(theme.base, name, extensions, language) ||
    (light && theme.light ? theme.light.file : '') ||
    theme.base.file;
  return key ? lookup(theme.definitions, key) : null;
}

// Which declared font a glyph is drawn in. A definition that names none takes the first the
// theme declares, and so does one naming a font the theme never declared: a glyph with no
// font behind it draws as an empty box, and the theme's own font is a better guess than that.
export function fontFor(theme: IconTheme, icon: GlyphIcon): ThemeFont | null {
  if (!theme.fonts.length) {
    return null;
  }
  if (!icon.fontId) {
    return theme.fonts[0];
  }
  return theme.fonts.find((font) => font.id === icon.fontId) || theme.fonts[0];
}

// The declared fonts, less the ones there is nothing behind. `exists` answers for one file,
// by the path the theme wrote, relative to the folder its JSON sits in.
//
// A theme names its font files and nothing checks them, so a font file that has gone leaves
// every glyph drawing as an empty box. That is not one row: the theme's default `file` entry
// answers for everything it does not otherwise know, so every row goes through the glyph
// path and one missing file empties the whole column. Dropping the font instead leaves
// `fontFor` with nothing, and the row keeps the lettered badge.
export function usableFonts(fonts: ThemeFont[], exists: (path: string) => boolean): ThemeFont[] {
  const usable: ThemeFont[] = [];
  for (const font of fonts) {
    const src = font.src.filter((source) => {
      try {
        return exists(source.path);
      } catch {
        return false;
      }
    });
    if (src.length) {
      usable.push({ ...font, src });
    }
  }
  return usable;
}

// A CSS family name of the panel's own. The theme's font id is not one, and is not under
// this extension's control: it is whatever string someone else's JSON holds, and it is
// written into a stylesheet as text, so only what a family name may safely hold survives.
// The index keeps two fonts apart when both ids clean down to the same thing, or to nothing.
export function familyFor(theme: IconTheme, font: ThemeFont): string {
  const index = theme.fonts.indexOf(font);
  const cleaned = font.id.replace(/[^a-zA-Z0-9_-]/g, '');
  return `arc-icon-${Math.max(0, index)}${cleaned ? `-${cleaned}` : ''}`;
}

// The `@font-face` rules the panel needs, as text. `uriFor` turns one path, relative to the
// folder the theme JSON sits in, into an address the panel may fetch; that is the only part
// of this the editor has to answer, and a path it will not answer for is left out.
//
// Every value here comes out of someone else's JSON and lands in a stylesheet as text, so
// each one is either gated on the shape it has to have or encoded. The address is encoded
// rather than dropped: a folder with a space in its name is ordinary on Windows, and
// deleting the space would quietly name a different file.
export function fontFaceRules(theme: IconTheme, uriFor: (path: string) => string): string[] {
  const rules: string[] = [];
  for (const font of theme.fonts) {
    const sources: string[] = [];
    for (const source of font.src) {
      let uri: string;
      try {
        uri = uriFor(source.path);
      } catch {
        continue;
      }
      if (!uri) {
        continue;
      }
      // `encodeURIComponent` leaves an apostrophe and a bracket alone, and those are three of
      // the five characters this is here to take out, so they are written out by hand. It is
      // still what encodes the rest, because a space may be a non-breaking one and only it
      // knows how many bytes that is.
      const address = uri.replace(/["'()\\\s]/g, (c) =>
        c === "'" ? '%27' : c === '(' ? '%28' : c === ')' ? '%29' : encodeURIComponent(c),
      );
      const format = /^[a-zA-Z0-9-]+$/.test(source.format) ? ` format("${source.format}")` : '';
      sources.push(`url("${address}")${format}`);
    }
    if (!sources.length) {
      continue;
    }
    const weight = /^[a-zA-Z0-9 ]+$/.test(font.weight) ? ` font-weight: ${font.weight};` : '';
    const style = /^[a-zA-Z0-9 ]+$/.test(font.style) ? ` font-style: ${font.style};` : '';
    rules.push(`@font-face { font-family: "${familyFor(theme, font)}"; src: ${sources.join(', ')};${weight}${style} }`);
  }
  return rules;
}
