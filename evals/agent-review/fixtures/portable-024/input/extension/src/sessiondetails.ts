export function drawnSessionCards<T extends { sessionId: string }>(cards: readonly T[], showing: string | null): T[] {
  return showing ? cards.filter((card) => card.sessionId === showing) : cards.slice();
}
