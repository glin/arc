// Sums panel usage metrics across every window and day, and lists the top committed queries. It also lists the known
// View menu values that no file counts. Arc records the metrics only while `panel-usage` exists in the Arc home folder.
// Run: node extension/scripts/panel-usage-summary.mjs [--json]
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const source = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const TOP_QUERIES = 30;

// The panel's own lists supply the known View menu values, so no separate catalog drifts.
async function knownViewKeys() {
  const built = buildSync({
    stdin: {
      contents: [
        "export { RAIL_SORTS } from './domain/rail-sort.ts';",
        "export { RAIL_ACTIVE_WINDOWS, RAIL_LENSES } from './domain/rail-filters.ts';",
        "export { RAIL_GROUP_BY, RAIL_DENSITIES } from './view/rail.ts';",
      ].join('\n'),
      resolveDir: source,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const known = await import(
    `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
  );
  return [
    ...['all', ...known.RAIL_LENSES].map((value) => `view:lens=${value}`),
    ...known.RAIL_SORTS.map((value) => `view:sort=${value}`),
    ...known.RAIL_GROUP_BY.map((value) => `view:group=${value}`),
    ...known.RAIL_DENSITIES.map((value) => `view:rows=${value}`),
    ...known.RAIL_ACTIVE_WINDOWS.map((value) => `view:window=${value}`),
    ...['all', 'saved'].map((value) => `view:filter=${value}`),
  ];
}

// Totals live in Maps, so a query such as `constructor` or `__proto__` adds up like any other.
function add(into, from) {
  for (const [key, value] of Object.entries(from ?? {}))
    if (typeof value === 'number') into.set(key, (into.get(key) ?? 0) + value);
}

const home = process.env.ARC_HOME || path.join(os.homedir(), '.arc');
const directory = path.join(home, 'panel-usage');
if (!fs.existsSync(directory)) {
  console.error(`No panel usage metrics at ${directory}. Create the folder to start recording.`);
  process.exit(1);
}
const counts = new Map();
const queries = new Map();
let other = 0;
const days = [];
let files = 0;
for (const day of fs.readdirSync(directory).sort()) {
  const folder = path.join(directory, day);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !fs.statSync(folder).isDirectory()) continue;
  days.push(day);
  for (const name of fs.readdirSync(folder).filter((one) => one.endsWith('.json'))) {
    try {
      const file = JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8'));
      add(counts, file.counts);
      add(queries, file.queries);
      other += typeof file.other === 'number' ? file.other : 0;
      files += 1;
    } catch {
      console.error(`Skipped unreadable ${path.join(folder, name)}`);
    }
  }
}
const sorted = (totals) => [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
const unused = (await knownViewKeys()).filter((key) => !counts.get(key));
const summary = {
  directory,
  days: days.length ? { first: days[0], last: days.at(-1), count: days.length } : null,
  files,
  counts: Object.fromEntries(sorted(counts)),
  topQueries: Object.fromEntries(sorted(queries).slice(0, TOP_QUERIES)),
  otherQueries: other,
  unusedViewValues: unused,
};
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(
    `${directory}: ${files} files over ${days.length} days${days.length ? ` (${days[0]} to ${days.at(-1)})` : ''}`,
  );
  console.log('\nCounts');
  for (const [key, value] of sorted(counts)) console.log(`${String(value).padStart(7)}  ${key}`);
  console.log(`\nTop queries${other ? ` (${other} more past the per-file limit)` : ''}`);
  for (const [query, value] of sorted(queries).slice(0, TOP_QUERIES))
    console.log(`${String(value).padStart(7)}  ${query}`);
  console.log('\nView menu values with no count');
  for (const key of unused) console.log(`         ${key}`);
}
