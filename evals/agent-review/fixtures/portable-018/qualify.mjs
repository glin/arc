import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const mod = await import(pathToFileURL(join(root, 'src', 'draft-inbox.mjs')).href);
async function normal() { const made=[]; const inbox=new mod.DraftInbox([{sessionId:'a',windowId:'one',createDraft:t=>made.push(t)}]); return inbox.send({sessionId:'a',windowId:'one'},'quote')&&made.length===1; }
async function symptom() { const made=[]; const inbox=new mod.DraftInbox(['one','two'].map(windowId=>({sessionId:'a',windowId,createDraft:t=>made.push([windowId,t])}))); return inbox.send({sessionId:'a',windowId:'two'},'quote')&&made.length===1&&made[0][0]==='two'; }
const normalPass = !!(await normal());
const symptomPass = !!(await symptom());
console.log(JSON.stringify({checks:[{id:'normal-001',role:'normal',pass:normalPass},{id:'symptom-001',role:'symptom',pass:symptomPass}]}));
