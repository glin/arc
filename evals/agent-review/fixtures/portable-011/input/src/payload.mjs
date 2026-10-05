export function railRowsWithinLimit(rows, limit) {
  const bytes = rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0);
  return rows.length === 0 || bytes / rows.length <= limit;
}
