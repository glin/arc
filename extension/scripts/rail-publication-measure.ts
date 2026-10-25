// Prints the session list publication measurement as JSON.
// Run from `extension`: `npx tsx scripts/rail-publication-measure.ts [rows] [running] [ticks] [tickMs]`.

import { measureRailPublication } from '../src/railpublication-measure';

const [rows, running, ticks, tickMs] = process.argv.slice(2).map((value) => Number.parseInt(value, 10));
const report = measureRailPublication({
  ...(Number.isFinite(rows) ? { rows } : {}),
  ...(Number.isFinite(running) ? { running } : {}),
  ...(Number.isFinite(ticks) ? { ticks } : {}),
  ...(Number.isFinite(tickMs) ? { tickMs } : {}),
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
