import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const mod = await import(pathToFileURL(join(root, 'src', 'spend-watcher.mjs')).href);
async function normal() { return mod.scanNotices([{path:'a',bytes:1,modifiedAt:1},{path:'a',bytes:2,modifiedAt:2}]).length===2; }
async function symptom() { const f={path:'a',bytes:1,modifiedAt:1}; return mod.scanNotices([f,f,{path:'b',bytes:1,modifiedAt:1}]).join(',')==='a,b'; }
const normalPass = !!(await normal());
const symptomPass = !!(await symptom());
console.log(JSON.stringify({checks:[{id:'normal-001',role:'normal',pass:normalPass},{id:'symptom-001',role:'symptom',pass:symptomPass}]}));
