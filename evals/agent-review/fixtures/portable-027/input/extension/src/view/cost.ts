// Browser-safe money wording for a cost estimate.

// Below a cent, the exact figure says nothing; past ten dollars, the cents do not either.
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
