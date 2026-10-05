import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const mod = await import(pathToFileURL(join(root, 'src', 'panel-host.mjs')).href);
async function normal() { const p=new mod.PanelStartup(); const state=await p.begin(['repo'],async()=>['repo']); return !state.loading&&state.rootCount===1; }
async function symptom() { const p=new mod.PanelStartup(); const state=await p.begin([],async()=>[]); return !state.loading&&state.rootCount===0; }
const normalPass = !!(await normal());
const symptomPass = !!(await symptom());
console.log(JSON.stringify({checks:[{id:'normal-001',role:'normal',pass:normalPass},{id:'symptom-001',role:'symptom',pass:symptomPass}]}));
