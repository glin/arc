import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const mod = await import(pathToFileURL(join(root, 'src', 'turn-reader.mjs')).href);
async function normal() { return mod.turnCards(['{"type":"text","value":"hello"}'])[0].text==='hello'; }
async function symptom() { try { const cards=mod.turnCards(['{"type":"text","value":7}','{"type":"text","value":"later"}']); return cards.at(-1)?.text==='later'; } catch(error) { if(error instanceof TypeError&&/trim/.test(error.message)) return false; throw error; } }
const normalPass = !!(await normal());
const symptomPass = !!(await symptom());
console.log(JSON.stringify({checks:[{id:'normal-001',role:'normal',pass:normalPass},{id:'symptom-001',role:'symptom',pass:symptomPass}]}));
