import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
const rail = await import(pathToFileURL(join(root, 'src/domain/rail-filters.mjs')).href);
const active = rail.RAIL_LENS_WORDS.active;
const unread = rail.RAIL_LENS_WORDS.unread;
const checks = [
  { id: 'ordinary-query', role: 'normal', pass: rail.withRailLens('label:"release 0.4" cost:>5', 'active') === `${active} label:"release 0.4" cost:>5` },
  { id: 'typed-unread', role: 'symptom', pass: rail.railQueryLenses(rail.withRailLens('is:unread label:ui', 'input')).join(',') === 'input' },
  { id: 'complete-unread', role: 'symptom', pass: rail.railQueryLenses(rail.withRailLens(`${unread} label:ui`, 'input')).join(',') === 'input' },
];
console.log(JSON.stringify({ checks }));
