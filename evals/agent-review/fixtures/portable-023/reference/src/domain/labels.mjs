const LABEL_NAME_LIMIT = 40;
const DRAFT_SESSION_PREFIX = "draft:";
const LABEL_NOTES = {
  comma: "A comma in a name reads as two labels when a card is read out.",
  limit: `A name is cut to ${LABEL_NAME_LIMIT} characters. Two names that agree that far are one label.`
};
function labelKey(name) {
  return name.toLocaleLowerCase();
}
function labelTypedNotes(raw) {
  const notes = [];
  if (raw.includes(",")) {
    notes.push("comma");
  }
  if (raw.trim().length > LABEL_NAME_LIMIT) {
    notes.push("limit");
  }
  return notes;
}
function sessionsCarrying(count) {
  return count === 1 ? "carried by one session" : `carried by ${count} sessions`;
}
export {
  DRAFT_SESSION_PREFIX,
  LABEL_NAME_LIMIT,
  LABEL_NOTES,
  labelKey,
  labelTypedNotes,
  sessionsCarrying
};
