// The units a token count is said in, smallest first. Thousands are whole, because a tenth
// of a thousand tokens is noise. The larger units keep one decimal, so 1,500,000 reads 1.5M.
const TOKEN_UNITS = [
  { size: 1_000, suffix: 'k', decimals: 0 },
  { size: 1_000_000, suffix: 'M', decimals: 1 },
  { size: 1_000_000_000, suffix: 'B', decimals: 1 },
];

// A token count in the largest unit that holds it.
//
// The unit is picked after the rounding, not before it. A count that rounds up past a
// thousand of its own unit moves up a unit, so 999,900 reads 1M and never 1000k.
export function formatTokens(n: number): string {
  if (n < TOKEN_UNITS[0].size) {
    return `${n}`;
  }
  for (let i = 0; i < TOKEN_UNITS.length; i++) {
    const unit = TOKEN_UNITS[i];
    const value = Number((n / unit.size).toFixed(unit.decimals));
    if (value < 1000 || i === TOKEN_UNITS.length - 1) {
      return `${value}${unit.suffix}`;
    }
  }
  return `${n}`;
}

export function wholePercent(share: number): number {
  if (!(share > 0)) {
    return 0;
  }
  if (share >= 1) {
    return Math.round(share * 100);
  }
  return Math.min(99, Math.max(1, Math.round(share * 100)));
}
