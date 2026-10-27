import type { CodexSubagentFile } from './codex';
import type { ClaudeChildSessionFile, ClaudeChildSessionReference } from './transcript';

// A window carries its own descendants, including nested and cross-agent launches.
export function selectedDependencies(
  sessionId: string,
  children: readonly CodexSubagentFile[],
  claudeChildren: readonly ClaudeChildSessionFile[],
  claudeChildReferences: readonly ClaudeChildSessionReference[],
) {
  const edges = new Map<string, string[]>();
  const add = (parent: string | null, child: string) => {
    if (!parent) return;
    const held = edges.get(parent) ?? [];
    held.push(child);
    edges.set(parent, held);
  };
  for (const child of children) add(child.parentThreadId, child.threadId);
  for (const child of claudeChildren) add(child.parentSessionId, child.sessionId);
  for (const child of claudeChildReferences) add(child.parentSessionId, child.sessionId);
  const own = new Set([sessionId]);
  for (const id of own) for (const child of edges.get(id) ?? []) own.add(child);
  return {
    children: children.filter((child) => own.has(child.threadId)),
    claudeChildren: claudeChildren.filter((child) => own.has(child.sessionId)),
    claudeChildReferences: claudeChildReferences.filter((child) => own.has(child.parentSessionId)),
  };
}

// Key a Claude session's child relationships without file revisions. The host and the worker build this one key for a window
// read and compare it. Dispatched sessions are not part of the key, and a window read never resolves them.
export function claudeRelationshipKey(
  sessionId: string,
  references: readonly ClaudeChildSessionReference[],
  claudeChildren: readonly ClaudeChildSessionFile[],
): string {
  return references
    .flatMap((child) => (child.kind === 'dispatch' || child.parentSessionId !== sessionId ? [] : [child]))
    .map((child) => `${child.sessionId}:${[...child.toolUseIds].sort().join(',')}:${child.file}`)
    .concat(
      claudeChildren
        .filter((child) => child.parentSessionId === sessionId)
        .map((child) => `target:${child.sessionId}:${child.file}`),
    )
    .sort()
    .join('\n');
}
