import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const mod = await import(pathToFileURL(join(root, 'src', 'window-discovery.mjs')).href);
async function normal() { const rows=await mod.discoverWindows([{id:'one',folders:['a']}],async()=>['a-worktree']); return rows[0].roots.includes('a-worktree'); }
async function symptom() { const windows=[{id:'one',folders:['a','b']}]; const retained=rows=>rows[0].roots.includes('a')&&rows[0].roots.includes('a-worktree')&&rows[0].roots.includes('b'); const rejected=await mod.discoverWindows(windows,async f=>{if(f==='b')throw Error('offline');return ['a-worktree']}); if(!retained(rejected))return false; try { const thrown=await mod.discoverWindows(windows,f=>{if(f==='b')throw Error('offline');return ['a-worktree']}); return retained(thrown); } catch { return false; } }
const normalPass = !!(await normal());
const symptomPass = !!(await symptom());
console.log(JSON.stringify({checks:[{id:'normal-001',role:'normal',pass:normalPass},{id:'symptom-001',role:'symptom',pass:symptomPass}]}));
