import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionCostReport } from './src/sessioncost.mjs';

const file = resolve(fileURLToPath(new URL('.', import.meta.url)), process.argv[2] ?? 'samples/ordinary.jsonl');
readFileSync(file);
console.log(JSON.stringify(sessionCostReport(file), null, 2));
