import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const mod = await import(pathToFileURL(join(root, 'src', 'spend-watcher.mjs')).href);
async function normal() { return mod.watchSpend([{path:'a',size:1,modifiedAt:1},{path:'a',size:2,modifiedAt:2}]).length===2; }
async function symptom() { const f={path:'a',size:1,modifiedAt:1}; return mod.watchSpend(Array.from({length:20},()=>f)).length===1; }
const normalPass = !!(await normal());
const symptomPass = !!(await symptom());
console.log(JSON.stringify({checks:[{id:'normal-001',role:'normal',pass:normalPass},{id:'symptom-001',role:'symptom',pass:symptomPass}]}));
