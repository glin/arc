import type { ComponentChild } from 'preact';

// Joins supplied siblings with the chosen separator and no wrapper. The default separator is a space.
// Callers choose other separators, such as commas, when the text forms a list.
export function inlineText<T extends ComponentChild | Node>(
  parts: readonly T[],
  separator: T | string = ' ',
): (T | string)[] {
  const children: (T | string)[] = [];
  for (const part of parts) {
    if (part === null || part === undefined || typeof part === 'boolean') {
      continue;
    }
    if (children.length) {
      children.push(separator);
    }
    children.push(part);
  }
  return children;
}
