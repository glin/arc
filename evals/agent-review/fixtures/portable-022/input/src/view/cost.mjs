function formatCost(dollars) {
  if (dollars == null || dollars <= 0) {
    return null;
  }
  if (dollars < 0.01) {
    return "<$0.01";
  }
  if (dollars < 10) {
    return `$${dollars.toFixed(2)}`;
  }
  return `$${Math.round(dollars)}`;
}
export {
  formatCost
};
