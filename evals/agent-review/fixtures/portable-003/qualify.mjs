import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const mod = await import(pathToFileURL(join(root, 'src', 'session-source.mjs')).href);
async function normal() { return mod.sessionSources(['/repo/'],['/repo/feature/']).map(x=>x.path).join(',')==='/repo,/repo/feature'; }
async function symptom() { return mod.sessionSources(['/'],['/tmp/worktree/']).some(x=>x.path==='/'); }
const normalPass = !!(await normal());
const symptomPass = !!(await symptom());
console.log(JSON.stringify({checks:[{id:'normal-001',role:'normal',pass:normalPass},{id:'symptom-001',role:'symptom',pass:symptomPass}]}));
