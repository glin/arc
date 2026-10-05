export function childState(child, fileModifiedAt) {
  if (fileModifiedAt > (child.processEndedAt ?? 0)) return 'running';
  if (child.processEndedAt != null) return 'finished';
  return fileModifiedAt - child.lastEventAt < 30_000 ? 'running' : 'unknown';
}
