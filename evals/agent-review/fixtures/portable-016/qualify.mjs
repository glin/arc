import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const mod = await import(pathToFileURL(join(root, 'src', 'stylesheet-scan.mjs')).href);
async function normal() { return mod.stylesheetIsRelative(root,'relative.css'); }
async function symptom() { return !(await mod.stylesheetIsRelative(root,'panel.css')); }
const normalPass = !!(await normal());
const symptomPass = !!(await symptom());
console.log(JSON.stringify({checks:[{id:'normal-001',role:'normal',pass:normalPass},{id:'symptom-001',role:'symptom',pass:symptomPass}]}));
