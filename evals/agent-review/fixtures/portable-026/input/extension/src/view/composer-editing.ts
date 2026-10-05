import { shortenTo } from '../domain/text.ts';

export const HISTORY_SAID_CHARS = 120;

export function historySaid(at: number, count: number, text: string, moved: boolean): string {
  if (!moved) {
    return 'No earlier prompt.';
  }
  if (at < 1) {
    return text.trim() ? 'Back to the prompt you were writing.' : 'Back to an empty box.';
  }
  const opening = shortenTo(text.split('\n')[0].trim(), HISTORY_SAID_CHARS, '\u2026');
  return `Earlier prompt ${at} of ${count}. ${opening}`;
}
