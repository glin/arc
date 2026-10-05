import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const mod = await import(pathToFileURL(join(root, 'src', 'child-status.mjs')).href);
async function normal() { return mod.childRow({id:'c',lastEventAt:100},{modifiedAt:110}).showRunning; }
async function symptom() { const row=mod.childRow({id:'c',lastEventAt:100,processEndedAt:120},{modifiedAt:130}); return row.status==='finished'&&!row.showRunning; }
const normalPass = !!(await normal());
const symptomPass = !!(await symptom());
console.log(JSON.stringify({checks:[{id:'normal-001',role:'normal',pass:normalPass},{id:'symptom-001',role:'symptom',pass:symptomPass}]}));
