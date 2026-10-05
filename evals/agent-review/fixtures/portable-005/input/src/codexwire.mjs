export function applyLimit(state, event) {
  const scope = event.kind === 'account' ? 'account' : (typeof event.limitName === 'string' ? event.limitName.trim() : '');
  return { ...state, [scope || 'account']: event.percent };
}
