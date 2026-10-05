export function attachChildren(turns, children) {
  return turns.map((turn, index) => ({
    ...turn,
    children: children.filter((child) => child.startedAt >= turn.startedAt && child.startedAt < (turn.endSource === 'inferred' ? turns[index + 1]?.startedAt ?? Infinity : turn.endedAt ?? turns[index + 1]?.startedAt ?? Infinity)),
  }));
}
