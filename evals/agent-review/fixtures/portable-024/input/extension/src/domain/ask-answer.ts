export type AskPicked = Readonly<Record<string, readonly string[] | undefined>>;
export type AskWritten = Readonly<Record<string, string | undefined>>;
export interface CompletedQuestionAnswer {
  decision: 'answer';
  answers: Record<string, { labels: string[]; written: string }>;
}

export function questionAnswered(id: string, picked: AskPicked, written: AskWritten): boolean {
  const typed = written[id];
  if (typeof typed === 'string' && typed.trim()) {
    return true;
  }
  return (picked[id]?.length ?? 0) > 0;
}

export function completedQuestionAnswer(
  ids: readonly string[],
  picked: AskPicked,
  written: AskWritten = {},
): CompletedQuestionAnswer | null {
  const answers: CompletedQuestionAnswer['answers'] = {};
  for (const id of ids) {
    const labels = picked[id] ?? [];
    const typed = written[id];
    if (typeof typed === 'string' && typed.trim()) {
      if (labels.length > 0) {
        return null;
      }
      answers[id] = { labels: [], written: typed };
      continue;
    }
    if (labels.length === 0) {
      return null;
    }
    answers[id] = { labels: [...labels], written: '' };
  }
  return { decision: 'answer', answers };
}
