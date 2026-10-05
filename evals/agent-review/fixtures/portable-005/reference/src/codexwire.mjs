export function applyLimit(state, event) {
  const scope = event.kind === 'account' ? 'account' : event.limitName;
  if (typeof scope !== 'string' || !scope.trim()) return state;
  return { ...state, [scope.trim()]: event.percent };
}
