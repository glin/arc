import { shortenTo } from './domain/text.ts';
import { formatWhen } from './turnformat';
import type { CommentPart, TurnComment } from './view/comments.ts';
import { COMMENT_CUT, commentableMessageId, commentsFor, commentsOn } from './view/comments.ts';

export {
  answerPart,
  blockOfQuote,
  COMMENT_ACTIONS,
  COMMENT_CUT,
  commentsFor,
  commentsOn,
  firstCellOf,
  laterPromptPart,
  markName,
  noteName,
  NOTE_NAME_LIMIT,
  saidPart,
  withoutMarker,
  withoutMarkers,
  type CommentPart,
  type TurnComment,
} from './view/comments.ts';

export function asQuote(text: string): string {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''));
  while (lines.length && !lines[0]) {
    lines.shift();
  }
  while (lines.length && !lines[lines.length - 1]) {
    lines.pop();
  }
  return lines.map((line) => (line ? `> ${line}` : '>')).join('\n');
}

export const COMMENT_LIMIT = 200;
export const COMMENT_TEXT_LIMIT = 6000;
export const COMMENT_LINE_LIMIT = 2000;

const ANSWER_PART = /^answer:\d{1,4}$/;
const LATER_PROMPT_PART = /^prompt:\d{1,4}$/;

function commentPart(value: unknown): CommentPart {
  if (value === 'prompt' || value === 'summary') {
    return value;
  }
  if (typeof value === 'string' && ANSWER_PART.test(value)) {
    return value as CommentPart;
  }
  if (typeof value === 'string' && LATER_PROMPT_PART.test(value)) {
    return value as CommentPart;
  }
  if (typeof value === 'string' && value.startsWith('said:') && commentableMessageId(value.slice(5))) {
    return value as CommentPart;
  }
  return 'summary';
}

function normalizeComment(raw: unknown): TurnComment | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const source = raw as Record<string, unknown>;
  const text = (value: unknown, limit: number): string =>
    typeof value === 'string' ? shortenTo(value, limit, COMMENT_CUT) : '';
  const number = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const id = text(source.id, COMMENT_LINE_LIMIT);
  const sessionId = text(source.sessionId, COMMENT_LINE_LIMIT);
  const key = text(source.turnKey, COMMENT_LINE_LIMIT);
  const note = text(source.note, COMMENT_TEXT_LIMIT).trim();
  const at = number(source.at);
  const turnAt = number(source.turnAt);
  if (!id || !sessionId || !key || !note || at === null || turnAt === null) {
    return null;
  }
  return {
    id,
    sessionId,
    turnKey: key,
    part: commentPart(source.part),
    quote: text(source.quote, COMMENT_TEXT_LIMIT),
    offset:
      typeof source.offset === 'number' && Number.isFinite(source.offset) && source.offset >= 0
        ? Math.trunc(source.offset)
        : undefined,
    note,
    headline: text(source.headline, COMMENT_LINE_LIMIT),
    sessionTitle: text(source.sessionTitle, COMMENT_LINE_LIMIT),
    turnAt,
    at,
  };
}

export function normalizeComments(raw: unknown): TurnComment[] {
  const kept: TurnComment[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const comment = normalizeComment(item);
      if (comment) {
        kept.push(comment);
      }
    }
  }
  return kept.slice(Math.max(0, kept.length - COMMENT_LIMIT));
}

export type CommentOp =
  | { op: 'write'; note: unknown }
  | { op: 'delete'; id: string }
  | { op: 'clear'; sessionId: string };

export function applyComment(held: readonly TurnComment[], op: unknown): TurnComment[] {
  if (!op || typeof op !== 'object') {
    return [...held];
  }
  const move = op as { op?: unknown; note?: unknown; id?: unknown; sessionId?: unknown };
  if (move.op === 'clear') {
    const sessionId = typeof move.sessionId === 'string' ? move.sessionId : '';
    return sessionId ? normalizeComments(held.filter((comment) => comment.sessionId !== sessionId)) : [...held];
  }
  if (move.op === 'delete') {
    const id = typeof move.id === 'string' ? move.id : '';
    return id ? normalizeComments(held.filter((comment) => comment.id !== id)) : [...held];
  }
  if (move.op !== 'write') {
    return [...held];
  }
  const [comment] = normalizeComments([move.note]);
  if (!comment) {
    return [...held];
  }
  const index = held.findIndex((candidate) => candidate.id === comment.id);
  const next = [...held];
  if (index < 0) {
    next.push(comment);
  } else {
    next[index] = comment;
  }
  return normalizeComments(next);
}

export type QuoteStanding = 'standing' | 'moved' | 'unknown';
const flattened = (text: string): string => text.replace(/\s+/g, ' ').trim();

export function commentAnchorText(
  card: {
    prompt: string;
    delegation?: string;
    summary: string;
    earlierAnswers: { summary: string }[];
    laterPrompts: { text: string }[];
    saidMessages?: { id: string; text: string }[];
  },
  part: CommentPart,
): string | null {
  if (part === 'prompt') {
    return card.prompt || card.delegation || null;
  }
  if (part === 'summary') {
    return card.summary || null;
  }
  if (part.startsWith('prompt:')) {
    return card.laterPrompts[Number(part.slice('prompt:'.length))]?.text || null;
  }
  if (part.startsWith('said:')) {
    const id = part.slice('said:'.length);
    return (card.saidMessages || []).find((message) => message.id === id)?.text || null;
  }
  return card.earlierAnswers[Number(part.slice('answer:'.length))]?.summary || null;
}

export function quoteStanding(quote: string, text: string | null): QuoteStanding {
  if (text === null) {
    return 'unknown';
  }
  const uncut = quote.endsWith(COMMENT_CUT) ? quote.slice(0, -COMMENT_CUT.length) : quote;
  const wanted = flattened(uncut);
  if (!wanted) {
    return 'unknown';
  }
  return flattened(text).includes(wanted) ? 'standing' : 'moved';
}

export function emitComments(comments: readonly TurnComment[], sessionId: string, now: number = Date.now()): string {
  const mine = commentsFor(comments, sessionId).sort((one, other) => one.at - other.at);
  if (!mine.length) {
    return '';
  }
  const byTurn = new Map<string, TurnComment[]>();
  for (const comment of mine) {
    const held = byTurn.get(comment.turnKey);
    if (held) {
      held.push(comment);
    } else {
      byTurn.set(comment.turnKey, [comment]);
    }
  }
  const groups = [...byTurn.values()].sort((one, other) => other[0].turnAt - one[0].turnAt);
  const blocks: string[] = [];
  for (const group of groups) {
    blocks.push(...turnBlock(group, now));
  }
  return blocks.join('\n\n');
}

export function emitTurnComments(
  comments: readonly TurnComment[],
  key: string,
  sessionId: string,
  now: number = Date.now(),
): string {
  const mine = commentsOn(comments, key, sessionId)
    .slice()
    .sort((one, other) => one.at - other.at);
  return mine.length ? turnBlock(mine, now).join('\n\n') : '';
}

// A generated block is told from a prompt by its first heading, not by a title: the title
// line this rule once read is gone, so the bold turn heading and the blank line under it are
// what is left to agree on. This is looser than the rule it replaces. It still rejects a
// prompt with no heading under its first line, and a prompt whose first line is bold but
// carries no parenthesized tail, such as `**Blocker**: it drops CRLF`.
//
// A turn with no headline heads itself `**<time>**`, which this rule does not match. That
// turn comes from a send that carried comments and no prompt, so the case is rare. The walk
// offers that document back as a prompt, the same direction the rule already takes for a
// session retitled after its comments went out.
const TURN_HEADING = /^\*\*.+\*\* \(.+\)$/;

export function looksLikeComments(text: string): boolean {
  const opening = text.indexOf('\n\n');
  if (opening === -1) {
    return false;
  }
  return TURN_HEADING.test(text.slice(0, opening));
}

function turnBlock(group: readonly TurnComment[], now: number): string[] {
  const newest = group[group.length - 1];
  const when = formatWhen(newest.turnAt, now);
  const blocks = [newest.headline ? `**${newest.headline}** (${when})` : `**${when}**`];
  for (const comment of group) {
    const quoted = asQuote(comment.quote);
    if (quoted) {
      blocks.push(quoted);
    }
    blocks.push(comment.note);
  }
  return blocks;
}
