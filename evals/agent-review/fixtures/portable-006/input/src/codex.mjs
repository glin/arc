export function attachChildren(turns, children) {
  return turns.map((turn, index) => ({
    ...turn,
    children: children.filter((child) => child.startedAt >= turn.startedAt && child.startedAt < (turn.endedAt ?? Infinity) && child.startedAt < (turns[index + 1]?.startedAt ?? Infinity)),
  }));
}
