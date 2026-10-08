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
