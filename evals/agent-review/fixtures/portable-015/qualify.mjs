import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const mod = await import(pathToFileURL(join(root, 'src', 'cost-detail.mjs')).href);
async function normal() { const rows=mod.turnCostDetail({own:1,delegated:1,tool:1}); return rows.map(x=>x.id).join(',')===mod.categoryOrder.join(','); }
async function symptom() { const rows=mod.turnCostDetail({own:1,delegated:8,tool:3}); return rows.map(x=>x.id).join(',')===mod.categoryOrder.join(','); }
const normalPass = !!(await normal());
const symptomPass = !!(await symptom());
console.log(JSON.stringify({checks:[{id:'normal-001',role:'normal',pass:normalPass},{id:'symptom-001',role:'symptom',pass:symptomPass}]}));
