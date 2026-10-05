import { shortenTo } from '../domain/text.ts';

export const COMMENT_ACTIONS = {
  write: 'Comment',
  writeKey: 'c',
  writeName: 'Comment. The keyboard shortcut is c',
  editor: 'Your comment',
  editorHint: 'What to send back about this',
  save: 'Save',
  cancel: 'Cancel',
  editorKeys: 'Enter saves, Shift and Enter for a new line',
  cancelKey: 'Escape gives up',
  edit: 'Edit this comment',
  delete: 'Delete this comment',
  markOne: 'comment on this line',
  markMany: 'comments on this line',
  offLineOne: 'comment not on any line',
  offLineMany: 'comments not on any line',
} as const;

export type CommentPart = 'prompt' | 'summary' | `answer:${number}` | `prompt:${number}` | `said:${string}`;

export interface TurnComment {
  id: string;
  sessionId: string;
  turnKey: string;
  part: CommentPart;
  quote: string;
  offset?: number;
  note: string;
  headline: string;
  sessionTitle: string;
  turnAt: number;
  at: number;
}

export const COMMENT_CUT = '…';
export const NOTE_NAME_LIMIT = 60;

export function answerPart(index: number): CommentPart {
  return `answer:${Math.max(0, Math.trunc(index))}`;
}

// Commentable message ids contain one to 200 non-whitespace characters.
export function commentableMessageId(id: string | undefined): id is string {
  return !!id && /^\S{1,200}$/.test(id);
}

// Use the message id as the comment part. Activity filtering changes row positions without changing message identity.
export function saidPart(id: string): CommentPart {
  return `said:${id}`;
}

export function laterPromptPart(index: number): CommentPart {
  return `prompt:${Math.max(0, Math.trunc(index))}`;
}

export function commentsOn(comments: readonly TurnComment[], turnKey: string, sessionId: string): TurnComment[] {
  return comments.filter((comment) => comment.turnKey === turnKey && comment.sessionId === sessionId);
}

export function commentsFor(comments: readonly TurnComment[], sessionId: string): TurnComment[] {
  return comments.filter((comment) => comment.sessionId === sessionId);
}

export function noteName(comment: { note?: string }): string {
  const words = (comment.note || '').replace(/\s+/g, ' ').trim();
  return shortenTo(words, NOTE_NAME_LIMIT, COMMENT_CUT);
}

export function markName(count: number, line: string): string {
  const words = shortenTo((line || '').replace(/\s+/g, ' ').trim(), NOTE_NAME_LIMIT, COMMENT_CUT);
  if (!words) {
    return `${count} ${count === 1 ? COMMENT_ACTIONS.offLineOne : COMMENT_ACTIONS.offLineMany}`;
  }
  return `${count} ${count === 1 ? COMMENT_ACTIONS.markOne : COMMENT_ACTIONS.markMany}: ${words}`;
}

export function withoutMarker(line: string): string {
  return line.replace(/^(?:[-*+] |\d+\. |#{1,6} |> )+/, '');
}

export function withoutMarkers(quote: string): string {
  return quote
    .split('\n')
    .map((line) => withoutMarker(line.replace(/^\s+/, '')))
    .join('\n');
}

export function firstCellOf(line: string): string {
  if (!line.startsWith('| ') || !line.endsWith(' |')) {
    return '';
  }
  const cells = line.slice(2, -2).split(' | ');
  return cells.length > 1 ? cells[0] : '';
}

function flattened(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function startsIn(block: string, next: string, quote: string): boolean {
  if (!next) {
    return false;
  }
  for (let take = Math.min(block.length, quote.length); take > 0; take -= 1) {
    if (quote[take] !== ' ') {
      continue;
    }
    const from = block.length - take;
    if (from > 0 && block[from - 1] !== ' ') {
      continue;
    }
    if (!quote.startsWith(block.slice(from))) {
      continue;
    }
    const rest = quote.slice(take + 1);
    if (rest && (next.startsWith(rest) || rest.startsWith(next))) {
      return true;
    }
  }
  return false;
}

function wordCharacter(value: string | undefined): boolean {
  return !!value && /\w/.test(value);
}

function matchingOffsets(text: string, wanted: string): number[] {
  const matches: number[] = [];
  for (let from = text.indexOf(wanted); from >= 0; from = text.indexOf(wanted, from + 1)) {
    const before = text[from - 1];
    const after = text[from + wanted.length];
    if (
      (!wordCharacter(wanted[0]) || !wordCharacter(before)) &&
      (!wordCharacter(wanted[wanted.length - 1]) || !wordCharacter(after))
    ) {
      matches.push(from);
    }
  }
  return matches;
}

function matchIn(flat: readonly string[], want: string, contains: boolean, offset?: number): number {
  const beginnings: number[] = [];
  let beginning = 0;
  for (const line of flat) {
    beginnings.push(beginning);
    beginning += line.length + 1;
  }
  let closest: { index: number; distance: number } | null = null;
  for (let index = 0; index < flat.length; index += 1) {
    if (flat[index] !== want) {
      continue;
    }
    if (offset === undefined) {
      return index;
    }
    const distance = Math.abs(beginnings[index] - offset);
    if (!closest || distance < closest.distance) {
      closest = { index, distance };
    }
  }
  if (closest) {
    return closest.index;
  }
  if (contains) {
    for (let index = 0; index < flat.length; index += 1) {
      for (const at of matchingOffsets(flat[index], want)) {
        if (offset === undefined) {
          return index;
        }
        const distance = Math.abs(beginnings[index] + at - offset);
        if (!closest || distance < closest.distance) {
          closest = { index, distance };
        }
      }
    }
  }
  if (closest) {
    return closest.index;
  }
  for (let index = 0; index < flat.length; index += 1) {
    if (startsIn(flat[index], flat[index + 1] || '', want)) {
      return index;
    }
  }
  return -1;
}

// The headings over opening input. After the response one is drawn text, and a comment on it
// is stored under `summary`.
export const PROMPT_HEADINGS = ['You asked', 'Assigned task'] as const;

// Whether a stored quote reads as words of the prompt heading.
export function quotesPromptHeading(quote: string): boolean {
  return blockOfQuote(PROMPT_HEADINGS, quote) >= 0;
}

export function blockOfQuote(blocks: readonly string[], quote: string, offset?: number): number {
  const cut = quote.endsWith(COMMENT_CUT) ? quote.slice(0, -COMMENT_CUT.length) : quote;
  const want = flattened(cut);
  if (!want) {
    return -1;
  }
  const flat = blocks.map(flattened);
  const found = matchIn(flat, want, true, offset);
  if (found >= 0) {
    return found;
  }
  const bare = flattened(withoutMarkers(cut));
  if (bare !== want) {
    const stripped = matchIn(flat, bare, false, offset);
    if (stripped >= 0) {
      return stripped;
    }
  }
  const cell = firstCellOf(want);
  return cell ? flat.indexOf(cell) : -1;
}

export function quoteSpan(text: string, quote: string, offset?: number): { from: number; to: number } | null {
  const matches = matchingOffsets(text, quote);
  if (matches.length) {
    const from =
      offset === undefined
        ? matches[0]
        : matches.reduce((best, candidate) =>
            Math.abs(candidate - offset) < Math.abs(best - offset) ? candidate : best,
          );
    return { from, to: from + quote.length };
  }
  for (let take = Math.min(text.length, quote.length); take > 0; take -= 1) {
    if (quote[take] !== ' ') {
      continue;
    }
    const from = text.length - take;
    if (from > 0 && text[from - 1] !== ' ') {
      continue;
    }
    if (quote.startsWith(text.slice(from))) {
      return { from, to: text.length };
    }
  }
  return null;
}
