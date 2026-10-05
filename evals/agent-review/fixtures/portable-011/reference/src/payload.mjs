export function railRowsWithinLimit(rows, limit) {
  return rows.every(row => Buffer.byteLength(JSON.stringify(row)) <= limit);
}
