import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const mod = await import(pathToFileURL(join(root, 'src', 'diagnostics-store.mjs')).href);
async function normal() { const d=new mod.DiagnosticsStore(); d.accept({kind:'render',milliseconds:4}); return d.exportText().includes('render'); }
async function symptom() { const d=new mod.DiagnosticsStore(); d.accept({kind:'private prompt text',milliseconds:4}); return !d.exportText().includes('private prompt text'); }
const normalPass = !!(await normal());
const symptomPass = !!(await symptom());
console.log(JSON.stringify({checks:[{id:'normal-001',role:'normal',pass:normalPass},{id:'symptom-001',role:'symptom',pass:symptomPass}]}));
