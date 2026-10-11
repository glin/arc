export interface FileCitationDestination {
  kind: 'fileCitation';
  path: string;
}

// Citation paths name literal files, including percent signs and location-like suffixes.
export function nativeCitationPath(written: string, platform: string): string | null {
  if (!written || /[\u0000-\u001f\u007f]/.test(written)) return null;
  if (platform === 'win32') return /^[a-z]:[\\/]/i.test(written) ? written : null;
  if (platform === 'linux' || platform === 'darwin')
    return written.startsWith('/') && !written.startsWith('//') ? written : null;
  return null;
}

export interface AssistantDirective {
  raw: string;
  name: string;
  attributes: Map<string, string>;
}

// Mask complete interiors before Markdown splits tables or matches emphasis delimiters.
// Invalid enclosing candidates consume their quoted or nested body without admitting inner actions.
export function maskedCitationSource(source: string, visit: (consume: (start: number) => number) => void) {
  const scanner = citationScanner(source.length);
  const reserved = new Set([...source.matchAll(/\uE000[0-9a-f]{8}\uE001/g)].map((match) => match[0]));
  const directives = new Map<string, { raw: string; directive: AssistantDirective | null }>();
  const chunks: string[] = [];
  let cursor = 0;
  let serial = 0;
  const consume = (start: number): number => {
    if (start < cursor) return cursor;
    const name = /^:+[a-z][a-z0-9_-]*[ \t]*\{/i.exec(source.slice(start));
    if (!name) return start;
    const parsed = scanner.scan(source.slice(start));
    let end = parsed?.name ? start + parsed.raw.length : start + name[0].length;
    if (!parsed?.name) {
      let quote = '';
      let depth = 1;
      for (; end < source.length; end += 1) {
        const character = source[end];
        if (quote) {
          if (character === quote) quote = '';
        } else if (character === '"' || character === "'") quote = character;
        else if (character === '{') depth += 1;
        else if (character === '}' && --depth === 0) {
          end += 1;
          break;
        }
      }
    }
    let slashes = 0;
    for (let offset = start - 1; offset >= 0 && source[offset] === '\\'; offset -= 1) slashes += 1;
    let marker: string;
    do {
      marker = `\uE000${(serial++).toString(16).padStart(8, '0')}\uE001`;
    } while (reserved.has(marker));
    directives.set(marker, { raw: source.slice(start, end), directive: slashes % 2 ? null : parsed });
    chunks.push(source.slice(cursor, start), marker);
    cursor = end;
    return end;
  };
  if (source.includes(':')) visit(consume);
  chunks.push(source.slice(cursor));
  return { text: chunks.join(''), directives };
}

// One allowance covers every candidate and both quotation modes in a response snapshot.
export function citationScanner(length: number) {
  const limit = length * 4;
  let inspected = 0;
  const parse = (source: string, escaped: boolean): AssistantDirective | null => {
    let offset = 0;
    const read = (): string => {
      if (offset >= source.length || inspected >= limit) return '';
      inspected += 1;
      return source[offset++];
    };
    let character = read();
    let colons = 0;
    while (character === ':') {
      colons += 1;
      character = read();
    }
    if (colons > 3) return { raw: source.slice(0, colons), name: '', attributes: new Map() };
    if (colons < 1 || !/[a-z]/i.test(character)) return null;
    let name = '';
    while (character && /[a-z0-9_-]/i.test(character)) {
      name += character;
      character = read();
    }
    if (character !== '{') return null;
    character = read();
    const attributes = new Map<string, string>();
    while (character) {
      while (character === ' ' || character === '\t') character = read();
      if (character === '}') return { raw: source.slice(0, offset), name, attributes };
      let key = '';
      while (character && /[a-z0-9_-]/i.test(character)) {
        key += character;
        character = read();
      }
      if (!key || attributes.has(key)) return null;
      while (character === ' ' || character === '\t') character = read();
      if (character !== '=') return null;
      character = read();
      while (character === ' ' || character === '\t') character = read();
      let value = '';
      if (character === '"' || character === "'") {
        const delimiter = character;
        character = read();
        while (character && character !== delimiter) {
          if (character === '\n' || character === '\r') return null;
          if (escaped && character === '\\') {
            const next = read();
            if (next === '\n' || next === '\r' || !next) return null;
            if (next === delimiter) {
              value += next;
              character = read();
            } else {
              value += '\\';
              character = next;
            }
          } else {
            value += character;
            character = read();
          }
        }
        if (character !== delimiter) return null;
        character = read();
      } else {
        while (character && !/[ \t}\n\r]/.test(character)) {
          value += character;
          character = read();
        }
        if (!value) return null;
      }
      attributes.set(key, value);
    }
    return null;
  };
  return {
    scan(source: string): AssistantDirective | null {
      if (inspected >= limit || !source.length) return null;
      inspected += 1;
      if (source[0] !== ':') return null;
      return parse(source, false) ?? parse(source, true);
    },
    get inspected() {
      return inspected;
    },
    get exhausted() {
      return inspected >= limit;
    },
  };
}
