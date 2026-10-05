const OPEN = "<send_user_message_question_reply>";
const CLOSE = "</send_user_message_question_reply>";
const ASYNC_TOOL = "request_user_input_async";
function asyncQuestionId(itemId, index) {
  return JSON.stringify([ASYNC_TOOL, itemId, index]);
}
function asyncQuestionItem(questionItemId) {
  let parsed;
  try {
    parsed = JSON.parse(questionItemId);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== ASYNC_TOOL) {
    return null;
  }
  const [, itemId, index] = parsed;
  return typeof itemId === "string" && itemId && typeof index === "number" ? itemId : null;
}
function buildQuestionReply(replies) {
  return OPEN + JSON.stringify(replies.map(({ questionItemId, question, answer }) => ({ questionItemId, question, answer }))) + CLOSE;
}
function parseQuestionReply(text) {
  const body = text.trim();
  if (!body.startsWith(OPEN) || !body.endsWith(CLOSE)) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(body.slice(OPEN.length, body.length - CLOSE.length));
  } catch {
    return null;
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const replies = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      return null;
    }
    const { questionItemId, question, answer } = entry;
    if (typeof questionItemId !== "string" || typeof question !== "string" || typeof answer !== "string") {
      return null;
    }
    replies.push({ questionItemId, question, answer });
  }
  return replies.length ? replies : null;
}
export {
  asyncQuestionId,
  asyncQuestionItem,
  buildQuestionReply,
  parseQuestionReply
};
