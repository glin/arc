export function childState(child, fileModifiedAt) {
  if (child.processEndedAt != null) return 'finished';
  return fileModifiedAt - child.lastEventAt < 30_000 ? 'running' : 'unknown';
}
