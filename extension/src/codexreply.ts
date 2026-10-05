// Codex clients answer request_user_input_async questions through an ordinary user message.
// Its reply envelope contains an opening tag, a JSON array of answers, and a closing tag.
// Each answer names its question, so other clients can close that question too.

const OPEN = '<send_user_message_question_reply>';
const CLOSE = '</send_user_message_question_reply>';
const ASYNC_TOOL = 'request_user_input_async';

// One answered question. questionItemId identifies it, question holds its title, and answer holds the reader's response.
export interface QuestionReply {
  questionItemId: string;
  question: string;
  answer: string;
}

// Codex clients identify an async question by its item id and index in that item's question list.
// The id is the JSON text of ["request_user_input_async", itemId, index].
export function asyncQuestionId(itemId: string, index: number): string {
  return JSON.stringify([ASYNC_TOOL, itemId, index]);
}

// The item id inside a question id, or null when the text is not one.
export function asyncQuestionItem(questionItemId: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(questionItemId);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== ASYNC_TOOL) {
    return null;
  }
  const [, itemId, index] = parsed;
  return typeof itemId === 'string' && itemId && typeof index === 'number' ? itemId : null;
}

export function buildQuestionReply(replies: QuestionReply[]): string {
  return (
    OPEN +
    JSON.stringify(replies.map(({ questionItemId, question, answer }) => ({ questionItemId, question, answer }))) +
    CLOSE
  );
}

// Parses a reply envelope with optional surrounding whitespace.
// The body accepts an answer array or a single answer object.
// Other surrounding text, malformed JSON, or invalid entries return null.
export function parseQuestionReply(text: string): QuestionReply[] | null {
  const body = text.trim();
  if (!body.startsWith(OPEN) || !body.endsWith(CLOSE)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(OPEN.length, body.length - CLOSE.length));
  } catch {
    return null;
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const replies: QuestionReply[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) {
      return null;
    }
    const { questionItemId, question, answer } = entry as Record<string, unknown>;
    if (typeof questionItemId !== 'string' || typeof question !== 'string' || typeof answer !== 'string') {
      return null;
    }
    replies.push({ questionItemId, question, answer });
  }
  return replies.length ? replies : null;
}
