import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const mod = await import(pathToFileURL(join(root, 'src', 'workspace-catalog.mjs')).href);
async function normal() { const c=new mod.WorkspaceCatalog(); const rows=await c.refresh(['a','b'],async f=>[f]); return rows.map(x=>x.path).join(',')==='a,b'; }
async function symptom() { const c=new mod.WorkspaceCatalog(); await c.refresh(['a','b'],async f=>[f]); const rows=await c.refresh(['a','b'],async f=>{if(f==='b')throw Error('offline');return ['a','a-worktree']}); return rows.some(x=>x.path==='a-worktree')&&rows.some(x=>x.path==='b'); }
const normalPass = !!(await normal());
const symptomPass = !!(await symptom());
console.log(JSON.stringify({checks:[{id:'normal-001',role:'normal',pass:normalPass},{id:'symptom-001',role:'symptom',pass:symptomPass}]}));
