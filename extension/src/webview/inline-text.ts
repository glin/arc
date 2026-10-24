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

// Appends a name as text with a line break opportunity after each path separator that has a
// word on both sides, so a path wraps between its folders and `/review` stays whole.
export function appendNameText(document: Document, parent: Node, text: string): void {
  text.split(/(?<=\S[/\\])(?=\S)/).forEach((part, index) => {
    if (index > 0) parent.appendChild(document.createElement('wbr'));
    parent.appendChild(document.createTextNode(part));
  });
}
