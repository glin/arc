import type { ComponentChild } from 'preact';

// Joins semantic siblings without changing their structure. Callers decide which parts belong
// together, so this does not inspect nested content or invent a wrapper around it. The
// separator defaults to a plain space, which is how most compound text reads, but a caller
// whose parts read as a list rather than as running prose passes its own, such as a comma, so
// the mark is a literal DOM text node and never a styled span a reader could copy the wrong
// tone from.
export function inlineText(parts: readonly ComponentChild[], separator: ComponentChild = ' '): ComponentChild[] {
  const children: ComponentChild[] = [];
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
