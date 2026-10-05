// Browser-safe rules for label identity and typed-name warnings.

export const LABEL_NAME_LIMIT = 40;
export const DRAFT_SESSION_PREFIX = 'draft:';

export const LABEL_NOTES = {
  comma: 'A comma in a name reads as two labels when a card is read out.',
  limit: `A name is cut to ${LABEL_NAME_LIMIT} characters. Two names that agree that far are one label.`,
} as const;

export type LabelNote = keyof typeof LABEL_NOTES;

// Labels use the reader's locale for case identity. Whitespace remains significant here;
// the editor owns trimming while a name is being entered.
export function labelKey(name: string): string {
  return name.toLocaleLowerCase();
}

export function labelTypedNotes(raw: string): LabelNote[] {
  const notes: LabelNote[] = [];
  if (raw.includes(',')) {
    notes.push('comma');
  }
  if (raw.trim().length > LABEL_NAME_LIMIT) {
    notes.push('limit');
  }
  return notes;
}

// A label's count as its checkbox is announced by.
//
// The row draws the count as a figure beside the name, and a figure read out after a name
// says nothing about what it counts, so the spoken form carries the noun. One is spelled as
// a word: the line is a sentence about the label rather than a tally, and a figure standing
// where a word fits reads as the start of a second one.
//
// Worded here rather than in the panel, which holds no rule that says when a count is plural.
// The View menu's label chips reword a count the Show switches lowered with the same rule.
//
// Exported because the filter box's suggestion rows draw the same count and are spoken the
// same way. One plural rule, so the editor and the box never say a count two ways.
export function sessionsCarrying(count: number): string {
  return count === 1 ? 'carried by one session' : `carried by ${count} sessions`;
}
