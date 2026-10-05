// The reply envelope Codex clients use to answer a question the model asked with
// `request_user_input_async`. The answer travels as an ordinary user message whose whole
// text is the opening tag, a JSON array of answers, and the closing tag. A client that
// finds such a message in the thread takes each entry as the answer to the question it
// names, which is how an answer given on one client closes the question on every other.

const OPEN = '<send_user_message_question_reply>';
const CLOSE = '</send_user_message_question_reply>';
const ASYNC_TOOL = 'request_user_input_async';

// One answered question. `questionItemId` is the id `asyncQuestionId` builds, `question`
// is the title the model asked, and `answer` is what the reader said.
export interface QuestionReply {
  questionItemId: string;
  question: string;
  answer: string;
}

// An async question carries no id of its own. Codex clients name it by the item that
// carried it and its place in that item's list, written as the JSON text of
// `["request_user_input_async", itemId, index]`.
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

// The answers in a message that is only a reply envelope. Surrounding whitespace is
// allowed, and so is a single answer object without the array. Any other text before or
// after the envelope makes the message ordinary text, and the result is null.
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
