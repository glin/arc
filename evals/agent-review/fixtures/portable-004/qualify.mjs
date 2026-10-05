import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const mod = await import(pathToFileURL(join(root, 'src', 'resume-session.mjs')).href);
async function normal() { const h=new mod.ResumeSession(); await h.update('x',async()=>({cwd:'/repo',bytes:1})); return h.command('x').cwd==='/repo'; }
async function symptom() { const h=new mod.ResumeSession(); await h.update('x',async()=>({cwd:'/repo',bytes:1})); await h.update('x',async()=>{throw Error('read')}); return h.command('x')?.cwd==='/repo'; }
const normalPass = !!(await normal());
const symptomPass = !!(await symptom());
console.log(JSON.stringify({checks:[{id:'normal-001',role:'normal',pass:normalPass},{id:'symptom-001',role:'symptom',pass:symptomPass}]}));
