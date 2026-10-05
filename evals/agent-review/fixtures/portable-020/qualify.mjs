import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const mod = await import(pathToFileURL(join(root, 'src', 'stylesheet-scan.mjs')).href);
async function normal() { return mod.checkPanelCss(root,'panel.css'); }
async function symptom() { return !mod.checkSnippet('.badge { FONT-SIZE: 10PX; line-height: 40q; }'); }
const normalPass = !!(await normal());
const symptomPass = !!(await symptom());
console.log(JSON.stringify({checks:[{id:'normal-001',role:'normal',pass:normalPass},{id:'symptom-001',role:'symptom',pass:symptomPass}]}));
