// The CLI window suffix on a model id, such as `[1m]` on `opus[1m]` or on the
// `claude-opus-5-5[1m]` a model attachment records. A reply's API id never carries one.
export const WINDOW_SUFFIX = /\[[^\]]*\]$/;

// Claude families whose ordinary window is 1M on the Anthropic API.
// Only bare, versioned ids qualify. Deployment prefixes and snapshot dates stay exact.
export function hasNativeClaudeOneMillionWindow(id: string): boolean {
  if (snapshotDateOf(id) !== null) return false;
  const match = /^claude-(fable|sonnet|opus)-(\d+)(?:-(\d+))?$/.exec(id);
  if (!match) return false;
  const major = Number(match[2]);
  const minor = Number(match[3] ?? 0);
  return match[1] === 'opus' ? major > 4 || (major === 4 && minor >= 7) : major >= 5;
}

const DATE_SUFFIX = /-(\d{4}-\d{2}-\d{2}|\d{8})$/;

// The inference profile prefix Bedrock puts before a Claude model id, as in
// `global.anthropic.claude-opus-5-5[1m]`.
const BEDROCK_PREFIX = /^(?:[a-z-]+\.)?anthropic\./;

// Strips the CLI's window suffix and a dated snapshot tail so two spellings of the same
// priced model compare equal: the id a pick resolves to, and the id a transcript recorded.
// Claude's snapshot tail is eight digits; Codex's is a dashed calendar date. Left in, either
// tail would make one priced model's id fail to match its own recorded snapshot.
export function normalizeModelIdentity(id: string | null | undefined): string {
  return (id ?? '').toLowerCase().replace(WINDOW_SUFFIX, '').replace(DATE_SUFFIX, '').trim();
}

// The snapshot date an id ends in, digits only so a dashed Codex date and an eight-digit
// Claude date compare on the same footing. Null when the id names no dated snapshot, which
// leaves an alias like `opus` free to match any snapshot of the model it resolves to.
export function snapshotDateOf(id: string | null | undefined): string | null {
  const stripped = (id ?? '').toLowerCase().replace(WINDOW_SUFFIX, '').trim();
  const match = stripped.match(DATE_SUFFIX);
  return match ? match[1].replace(/-/g, '') : null;
}

// The window suffix an id ends in, lowercased, or '' for the model's ordinary window.
export function modelWindowOf(id: string | null | undefined): string {
  return (id ?? '').trim().toLowerCase().match(WINDOW_SUFFIX)?.[0] ?? '';
}

// Whether two ids name the same model, apart from its window and a Bedrock prefix. Two
// dated snapshots must name the same date. An undated id matches any snapshot.
export function sameModelIdentity(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = (a ?? '').trim().toLowerCase().replace(BEDROCK_PREFIX, '');
  const right = (b ?? '').trim().toLowerCase().replace(BEDROCK_PREFIX, '');
  const leftId = normalizeModelIdentity(left);
  if (!leftId || leftId !== normalizeModelIdentity(right)) {
    return false;
  }
  const leftDate = snapshotDateOf(left);
  const rightDate = snapshotDateOf(right);
  return leftDate === null || rightDate === null || leftDate === rightDate;
}
