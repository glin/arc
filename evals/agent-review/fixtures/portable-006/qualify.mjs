import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const mod = await import(pathToFileURL(join(root, 'src', 'session-cards.mjs')).href);
async function normal() { const cards=mod.sessionCards([{id:'one',startedAt:0,endedAt:5},{id:'two',startedAt:10,endedAt:15}],[{id:'child',startedAt:2}]); return cards[0].childIds[0]==='child'&&cards[1].delegatedCount===0; }
async function symptom() { const cards=mod.sessionCards([{id:'one',startedAt:0,endedAt:5,endSource:'inferred'},{id:'two',startedAt:10,endedAt:15}],[{id:'child',startedAt:7}]); return cards[0].childIds[0]==='child'&&cards[1].delegatedCount===0; }
const normalPass = !!(await normal());
const symptomPass = !!(await symptom());
console.log(JSON.stringify({checks:[{id:'normal-001',role:'normal',pass:normalPass},{id:'symptom-001',role:'symptom',pass:symptomPass}]}));
