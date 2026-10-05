import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const mod = await import(pathToFileURL(join(root, 'src', 'usage-dashboard.mjs')).href);
async function normal() { const d=new mod.UsageDashboard(); d.receive({scope:'account',payload:{rateLimits:{utilization:31}}}); d.receive({scope:'model',payload:{rateLimits:{limitName:'Sol',utilization:2}}}); return d.accountPercent()===31&&d.scopes.Sol===2; }
async function symptom() { const d=new mod.UsageDashboard(); d.receive({scope:'account',payload:{rateLimits:{utilization:31}}}); d.receive({scope:'model',payload:{rateLimits:{limitName:null,utilization:0}}}); return d.accountPercent()===31; }
const normalPass = !!(await normal());
const symptomPass = !!(await symptom());
console.log(JSON.stringify({checks:[{id:'normal-001',role:'normal',pass:normalPass},{id:'symptom-001',role:'symptom',pass:symptomPass}]}));
