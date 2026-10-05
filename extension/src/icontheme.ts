// Normalize file-icon themes, resolve path icons, and generate font rules for the panel.
// The caller supplies theme data, language contributions, file checks, and webview URI conversion.
// Unresolved icons leave the filename badge available to the renderer.

// Language contribution fields used to match filenames and extensions.
export interface LanguageContribution {
  id?: string;
  extensions?: string[];
  filenames?: string[];
}

// Filename and extension mappings used to resolve theme languageIds.
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
  size: string; // Accepted theme size, such as '150%'. Empty when the size exceeds the limit.
}

// A decoded font glyph. Image icons use `ImageIcon`.
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

// Filename, extension, language, and default mappings for a base or light-theme layer.
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

// Read a key from the null-prototype maps without inherited constructor or __proto__ entries.
function lookup<T>(map: Record<string, T>, key: string): T | null {
  return key ? map[key] || null : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

// Copy nonempty string mappings into a null-prototype object.
// Normalize filename and extension keys to lowercase. Preserve language ID case.
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

// Keep the first language contribution for each lowercased filename or extension.
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

// Decode a backslash followed by one to six hexadecimal digits as one Unicode code point.
// Accept an already decoded single character. Return empty for unsupported values.
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

// Accept positive font sizes up to 300%, 3em, 3rem, or 32px/pt.
// Reject other units and values to prevent a theme glyph from covering the filename.
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

// Normalize icon definitions, mappings, and fonts. Return null for non-object input.
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

// Match compound extensions longest first: a.test.ts tries test.ts before ts.
// A leading dot also supplies an extension, so .gitignore tries gitignore.
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

// Resolve a layer by filename, then compound extension, then language ID.
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

// Resolve a path icon, including light-theme overrides when `light` is true.
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
  // Prefer light-layer mappings, then base mappings, then light and base defaults.
  const key =
    (light ? keyIn(theme.light, name, extensions, language) : '') ||
    keyIn(theme.base, name, extensions, language) ||
    (light && theme.light ? theme.light.file : '') ||
    theme.base.file;
  return key ? lookup(theme.definitions, key) : null;
}

// Select the named font, falling back to the first declared font.
export function fontFor(theme: IconTheme, icon: GlyphIcon): ThemeFont | null {
  if (!theme.fonts.length) {
    return null;
  }
  if (!icon.fontId) {
    return theme.fonts[0];
  }
  return theme.fonts.find((font) => font.id === icon.fontId) || theme.fonts[0];
}

// Keep fonts with at least one source accepted by `exists`.
// The callback receives paths relative to the theme JSON folder. Callback errors reject that source.
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

// Build a CSS family name from the font index and sanitized ID.
// The index separates IDs that sanitize to the same string.
export function familyFor(theme: IconTheme, font: ThemeFont): string {
  const index = theme.fonts.indexOf(font);
  const cleaned = font.id.replace(/[^a-zA-Z0-9_-]/g, '');
  return `arc-icon-${Math.max(0, index)}${cleaned ? `-${cleaned}` : ''}`;
}

// Generate font-face rules using caller-provided URIs for relative theme paths.
// Skip empty or failed URI conversions. Encode CSS delimiters and whitespace, and validate remaining CSS values.
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
      // Encode apostrophes and parentheses explicitly because encodeURIComponent leaves them unchanged.
      // Encode other matched delimiters and whitespace with encodeURIComponent.
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
