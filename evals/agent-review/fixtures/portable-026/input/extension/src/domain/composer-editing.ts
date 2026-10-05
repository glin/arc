export interface HistoryPress {
  at: number;
  take: boolean;
}

export interface PromptToken {
  prefix: '/' | '$';
  typed: string;
  start: number;
  end: number;
}

export interface PathToken {
  typed: string;
  start: number;
  end: number;
}

export const UNDO_GAP = 500;
export const UNDO_DEPTH = 200;
export const PATH_COMPLETION_DEBOUNCE_MS = 150;

export interface TextEdit {
  kind: string;
  at: number;
  tip: number;
  removed: string;
  added: string;
  solo: boolean;
  ends: boolean;
}

export interface UndoStep {
  text: string;
  start: number;
  end: number;
  edit: TextEdit;
}

export interface UndoStack {
  done: UndoStep[];
  undone: UndoStep[];
  at: number;
}

interface KeyIntent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export function textEdit(before: string, after: string, caret: number): TextEdit {
  const max = Math.min(before.length, after.length);
  let head = 0;
  while (head < max && before.charCodeAt(head) === after.charCodeAt(head)) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < max - head &&
    before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)
  ) {
    tail += 1;
  }
  const removed = before.slice(head, before.length - tail);
  const added = after.slice(head, after.length - tail);
  let kind = 'other';
  if (added && !removed) {
    kind = 'insert';
  } else if (removed && !added) {
    kind = 'delete';
  }
  const from = kind === 'insert' ? caret - added.length : kind === 'delete' ? caret : -1;
  const at =
    from >= 0 &&
    from <= before.length &&
    from !== head &&
    before.slice(0, from) + added + before.slice(from + removed.length) === after
      ? from
      : head;
  const one = kind === 'insert' ? added : removed;
  const single = Array.from(one).length === 1;
  return {
    kind,
    at,
    tip: kind === 'insert' ? at + added.length : at,
    removed,
    added,
    solo: !single,
    ends: !single || /\s/.test(one),
  };
}

export function undoJoins(last: TextEdit | null | undefined, edit: TextEdit, gap: number): boolean {
  if (!last || gap > UNDO_GAP || edit.kind === 'other' || last.kind !== edit.kind) {
    return false;
  }
  if (last.ends || edit.solo) {
    return false;
  }
  if (edit.kind === 'insert') {
    return edit.at === last.tip;
  }
  return edit.at === last.tip || edit.at + edit.removed.length === last.tip;
}

export function undoStart(text: string, start: number, end: number): UndoStack {
  const edit = { kind: 'other', at: 0, tip: 0, removed: '', added: '', solo: true, ends: true };
  return { done: [{ text, start, end, edit }], undone: [], at: 0 };
}

export function undoRecord(stack: UndoStack, text: string, start: number, end: number, now: number): void {
  const last = stack.done[stack.done.length - 1];
  if (last?.text === text) {
    return;
  }
  const edit = textEdit(last?.text ?? '', text, start);
  const step = { text, start, end, edit };
  stack.undone.length = 0;
  if (undoJoins(last?.edit, edit, now - stack.at)) {
    stack.done[stack.done.length - 1] = step;
  } else {
    stack.done.push(step);
    if (stack.done.length > UNDO_DEPTH) {
      stack.done.shift();
    }
  }
  stack.at = now;
}

export function undoBreak(stack: UndoStack): void {
  stack.at = 0;
}

export function undoTake(stack: UndoStack, back: boolean): UndoStep | null {
  if (back) {
    if (stack.done.length < 2) {
      return null;
    }
    stack.undone.push(stack.done.pop()!);
  } else {
    const step = stack.undone.pop();
    if (!step) {
      return null;
    }
    stack.done.push(step);
  }
  stack.at = 0;
  return stack.done[stack.done.length - 1] ?? null;
}

export function undoIntent(event: KeyIntent | null): '' | 'undo' | 'redo' {
  if (!event || !(event.ctrlKey || event.metaKey) || event.altKey) {
    return '';
  }
  const key = event.key.toLowerCase();
  if (key === 'z') {
    return event.shiftKey ? 'redo' : 'undo';
  }
  if (key === 'y' && !event.shiftKey) {
    return 'redo';
  }
  return '';
}

export function lineRange(text: string, caret: number, cut: boolean): { start: number; end: number } {
  const start = caret === 0 ? 0 : text.lastIndexOf('\n', caret - 1) + 1;
  const stop = text.indexOf('\n', caret);
  if (stop !== -1) {
    return { start, end: stop + 1 };
  }
  return { start: cut && start !== 0 ? start - 1 : start, end: text.length };
}

export function lineIntent(event: KeyIntent | null): '' | 'cut' | 'copy' {
  if (!event || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) {
    return '';
  }
  const key = event.key.toLowerCase();
  if (key === 'x') {
    return 'cut';
  }
  if (key === 'c') {
    return 'copy';
  }
  return '';
}

export function historyPress(
  count: number,
  at: number,
  back: boolean,
  caret: number,
  selecting: boolean,
): HistoryPress {
  if (selecting) {
    return { at, take: false };
  }
  if (at > 0) {
    if (back) {
      return { at: Math.min(at + 1, count), take: true };
    }
    return { at: at - 1, take: true };
  }
  if (!back || count < 1 || caret > 0) {
    return { at, take: false };
  }
  return { at: 1, take: true };
}

// Every character that ends a line for `.` in a pattern. Refusing all of them before the
// match leaves `.*` nothing to stop on, so a long run of spaces cannot make the match slow.
// `clearRequest` in composerview.ts applies the same gate to Codex `/new` and imports this
// constant rather than keeping a second copy.
export const LINE_BREAK = /[\r\n\u2028\u2029]/;

// Codex app-server runs no slash commands, so a typed `/rename` renames the session through
// the same request as the rail's rename control. The name is the trimmed rest of the line, as
// for `/new`. A bare `/rename` answers an empty name, which the rename refuses with a message.
// Claude answers null, because the Claude CLI runs `/rename` itself.
//
// The host and the webview Composer both call this one function, so a typed `/rename` reaches
// the model as a prompt only when neither side recognizes it as the native control.
export function renameRequest(agent: string, text: string): string | null {
  const trimmed = text.trim();
  if (agent !== 'codex' || LINE_BREAK.test(trimmed)) {
    return null;
  }
  const matched = /^\/rename(?:[ \t]+(.*))?$/i.exec(trimmed);
  return matched ? (matched[1] ?? '').trim() : null;
}

export function promptToken(agent: string, text: string, caret: number): PromptToken | null {
  const at = Math.max(0, Math.min(caret, text.length));
  let start = at;
  while (start > 0 && !/\s/.test(text[start - 1])) {
    start -= 1;
  }
  let end = at;
  while (end < text.length && !/\s/.test(text[end])) {
    end += 1;
  }
  const prefix = text[start];
  if (prefix !== '/' && (prefix !== '$' || agent !== 'codex')) {
    return null;
  }
  return { prefix, typed: text.slice(start + 1, end), start, end };
}

// A path is completed only at the end of the word the reader is writing. Quotes keep a
// path with spaces together, but are deliberately left outside the replacement range.
export function pathToken(text: string, caret: number): PathToken | null {
  const at = Math.max(0, Math.min(caret, text.length));
  for (const quote of ['"', "'", '`']) {
    const closing = text[at - 1] === quote ? at - 1 : at;
    const opening = text.lastIndexOf(quote, closing - 1);
    if (opening >= 0 && (opening === 0 || /\s/.test(text[opening - 1]))) {
      const paired = text.indexOf(quote, opening + 1);
      const end = paired === -1 ? at : paired;
      if ((paired === -1 || at === paired || at === paired + 1) && end >= opening + 1) {
        const typed = text.slice(opening + 1, end);
        const rooted = /^(~[\\/]|\.[\\/]|\.\.[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(typed);
        if (typed && (rooted || /[\\/]/.test(typed))) {
          return { typed, start: opening + 1, end };
        }
      }
    }
  }
  let start = at;
  while (start > 0 && !/\s/.test(text[start - 1])) {
    start -= 1;
  }
  let end = at;
  while (end < text.length && !/\s/.test(text[end])) {
    end += 1;
  }
  if (at !== end) {
    return null;
  }
  const typed = text.slice(start, end);
  if (!typed) {
    return null;
  }
  const rooted = /^(~[\\/]|\.[\\/]|\.\.[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(typed);
  return rooted || /[\\/]/.test(typed) ? { typed, start, end } : null;
}

export function matchCommandNames(names: readonly string[], typed: string): string[] {
  const needle = typed.trim().toLowerCase();
  if (!needle) {
    return [...names];
  }
  const starts: string[] = [];
  const contains: string[] = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    if (lower.startsWith(needle)) {
      starts.push(name);
    } else if (lower.includes(needle)) {
      contains.push(name);
    }
  }
  return [...starts, ...contains];
}

// The key chord that sends the composer from anywhere in the panel.
//
// A reader who comments on several turns leaves focus on the cards, not in the box. Plain
// Enter reaches the box alone, so a comment-only prompt had no key at all. The modifier
// follows the platform the same way `newSessionShortcut` does. Each platform rejects the
// other one's modifier, so a Mac reader cannot send with Ctrl by accident.
function macPlatform(platform: string): boolean {
  return /^Mac/.test(platform || '');
}

export function sendChordLabel(platform: string): string {
  return macPlatform(platform) ? 'Command and Enter' : 'Ctrl and Enter';
}

export function sendChordKeyshortcut(platform: string): string {
  return macPlatform(platform) ? 'Meta+Enter' : 'Control+Enter';
}

// What the send control adds to its spoken name. The host view words the rest of that name,
// but it has no browser to ask for a platform, so this one sentence is worded here.
export function sendChordSentence(platform: string): string {
  return `${sendChordLabel(platform)} sends from anywhere in the panel.`;
}

export function isSendChord(event: KeyIntent | null, platform: string): boolean {
  if (!event || event.key !== 'Enter' || event.altKey || event.shiftKey) {
    return false;
  }
  return macPlatform(platform) ? Boolean(event.metaKey) && !event.ctrlKey : Boolean(event.ctrlKey) && !event.metaKey;
}
