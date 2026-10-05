import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const mod = await import(pathToFileURL(join(root, 'src', 'panel-registry.mjs')).href);
async function normal() { const r=new mod.PanelRegistry(); const h=r.open('one'); r.handoff({hostId:'one',text:'quote'}); return h.drafts.length===1; }
async function symptom() { const r=new mod.PanelRegistry(); const a=r.open('one'),b=r.open('two'); r.handoff({hostId:'one',text:'quote'}); return a.drafts.length===1&&b.drafts.length===0; }
const normalPass = !!(await normal());
const symptomPass = !!(await symptom());
console.log(JSON.stringify({checks:[{id:'normal-001',role:'normal',pass:normalPass},{id:'symptom-001',role:'symptom',pass:symptomPass}]}));
