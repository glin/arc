const order = ['own','delegated','tool'];
export function costRows(costs) {
  return order.map(kind => ({kind, dollars: costs[kind] ?? 0}));
}
