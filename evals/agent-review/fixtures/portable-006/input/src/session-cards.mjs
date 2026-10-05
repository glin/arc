import { attachChildren } from './codex.mjs';
export function sessionCards(turns, children) {
  return attachChildren(turns, children).map(turn => ({
    id: turn.id,
    startedAt: turn.startedAt,
    delegatedCount: turn.children.length,
    childIds: turn.children.map(child => child.id),
  }));
}
