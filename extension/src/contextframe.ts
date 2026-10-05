export const CONTEXT_FRAME_BYTES = 2_097_152;
export const CONTEXT_PREFIX_BYTES = 4_096;
export const CONTEXT_PENDING_LIMIT = 32;
export const CONTEXT_DEADLINE_MS = 5_000;

// Reads envelope strings without constructing the response body. A partial prefix returns no identity.
export function contextFrameId(text: string): string | null {
  let at = 0;
  let type: string | null = null;
  let id: string | null = null;
  const whitespace = () => {
    while (/\s/.test(text[at] ?? '') && at < text.length) at++;
  };
  const string = (keep: boolean): string | null => {
    if (text[at++] !== '"') throw new Error('string');
    let result = '';
    for (; at < text.length;) {
      let c = text[at++];
      if (c === '"') return keep ? result : null;
      if (c === '\\') {
        const escape = text[at++];
        if (escape === 'u') {
          const hex = text.slice(at, at + 4);
          if (!/^[\da-f]{4}$/i.test(hex)) throw new Error('escape');
          c = String.fromCharCode(parseInt(hex, 16));
          at += 4;
        } else {
          const escapes: Record<string, string> = {
            '"': '"',
            '\\': '\\',
            '/': '/',
            b: '\b',
            f: '\f',
            n: '\n',
            r: '\r',
            t: '\t',
          };
          if (!Object.hasOwn(escapes, escape)) throw new Error('escape');
          c = escapes[escape];
        }
      }
      if (keep) {
        result += c;
        if (result.length > 512) throw new Error('length');
      }
    }
    throw new Error('partial');
  };
  const value = (path: string, depth: number): void => {
    if (depth > 64) throw new Error('depth');
    whitespace();
    const c = text[at];
    if (c === '"') {
      const token = string(path === 'type' || path === 'response.request_id');
      if (path === 'type') type = token;
      if (path === 'response.request_id') id = token;
      if (type === 'control_response' && id) throw new Error('found');
      return;
    }
    if (c === '{' || c === '[') {
      const object = c === '{';
      at++;
      whitespace();
      if (text[at] === (object ? '}' : ']')) {
        at++;
        return;
      }
      for (;;) {
        whitespace();
        let child = '';
        if (object) {
          const key = string(depth < 2);
          whitespace();
          if (text[at++] !== ':') throw new Error('colon');
          child = depth === 0 ? (key ?? '') : path === 'response' ? `response.${key}` : '';
        }
        value(child, depth + 1);
        whitespace();
        if (text[at] === (object ? '}' : ']')) {
          at++;
          return;
        }
        if (text[at++] !== ',') throw new Error('partial');
      }
    }
    const start = at;
    while (at < text.length && !/[\s,}\]]/.test(text[at])) at++;
    if (at === start || at === text.length) throw new Error('partial');
  };
  try {
    value('', 0);
  } catch {
    /* A found envelope or an incomplete prefix ends the scan. */
  }
  return type === 'control_response' ? id : null;
}

export interface ContextFrameGate {
  identify(text: string): string | null;
  overflow(id: string): void;
}
