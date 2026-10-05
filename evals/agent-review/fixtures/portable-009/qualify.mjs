import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const mod = await import(pathToFileURL(join(root, 'src', 'timeline-host.mjs')).href);
async function normal() { const h=new mod.TimelineHost(); h.childRecordsChanged([{turnId:'a'}]); return (await h.openOlderPage(async()=>[{id:'a'}]))[0].childCount===1; }
async function symptom() { const h=new mod.TimelineHost(); let release; const pending=h.openOlderPage(()=>new Promise(r=>{release=r})); h.childRecordsChanged([{turnId:'a'}]); release([{id:'a'}]); return (await pending)[0].childCount===1; }
const normalPass = !!(await normal());
const symptomPass = !!(await symptom());
console.log(JSON.stringify({checks:[{id:'normal-001',role:'normal',pass:normalPass},{id:'symptom-001',role:'symptom',pass:symptomPass}]}));
