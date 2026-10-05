import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const mod = await import(pathToFileURL(join(root, 'src', 'usage-popover.mjs')).href);
async function normal() { const view=mod.usagePopover({inputTokens:800,outputTokens:200,requests:1}); return view.total===1000&&view.detail.includes('1,000 tokens'); }
async function symptom() { const view=mod.usagePopover({inputTokens:800,outputTokens:200,requests:40}); return view.detail.includes('40 requests'); }
const normalPass = !!(await normal());
const symptomPass = !!(await symptom());
console.log(JSON.stringify({checks:[{id:'normal-001',role:'normal',pass:normalPass},{id:'symptom-001',role:'symptom',pass:symptomPass}]}));
