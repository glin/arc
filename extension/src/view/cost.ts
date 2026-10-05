// Browser-safe money wording for a cost estimate.

// Show values below one cent as <$0.01. Round values of at least ten dollars to whole dollars.
export function formatCost(dollars: number | null): string | null {
  if (dollars == null || dollars <= 0) {
    return null;
  }
  if (dollars < 0.01) {
    return '<$0.01';
  }
  if (dollars < 10) {
    return `$${dollars.toFixed(2)}`;
  }
  return `$${Math.round(dollars)}`;
}
