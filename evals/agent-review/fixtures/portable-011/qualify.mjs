import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const mod = await import(pathToFileURL(join(root, 'src', 'rail-message.mjs')).href);
async function normal() { const r=mod.prepareRailMessage([{label:'a'}],100); return r.accepted&&r.payload.includes('rail'); }
async function symptom() { const r=mod.prepareRailMessage([{label:'x'.repeat(200)},...Array.from({length:20},()=>({label:'a'}))],100); return !r.accepted; }
const normalPass = !!(await normal());
const symptomPass = !!(await symptom());
console.log(JSON.stringify({checks:[{id:'normal-001',role:'normal',pass:normalPass},{id:'symptom-001',role:'symptom',pass:symptomPass}]}));
