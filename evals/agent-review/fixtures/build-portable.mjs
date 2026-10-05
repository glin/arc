import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cases = [];
function add(x) { cases.push(x); }
const sha = (s) => createHash('sha256').update(s).digest('hex');
function diff(before, after, path) {
  const a = before ? before.trimEnd().split('\n') : [];
  const b = after.trimEnd().split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const from = Math.max(0, start - 3), toA = Math.min(a.length, endA + 3), toB = Math.min(b.length, endB + 3);
  return `diff --git a/src/${path} b/src/${path}\n--- ${before ? `a/src/${path}` : '/dev/null'}\n+++ b/src/${path}\n@@ -${a.length ? from + 1 : 0},${toA - from} +${from + 1},${toB - from} @@\n` +
    a.slice(from, start).map((v) => ` ${v}\n`).join('') +
    a.slice(start, endA).map((v) => `-${v}\n`).join('') +
    b.slice(start, endB).map((v) => `+${v}\n`).join('') +
    a.slice(endA, toA).map((v) => ` ${v}\n`).join('');
}
function caseData(id, family, split, title, reference, severity, summary, scenario, before, candidate, corrected, normal, symptom, audit) {
  add({id, family, split, title, reference, severity, summary, scenario, before, candidate, corrected, normal, symptom, audit});
}

caseData(1, 'repository-discovery', 'development', 'Empty workspace readiness', 'extension/src/repositoryscope.ts @ a0abf6e', 'medium', 'An empty workspace never reaches the ready state.', 'Open a window with no folders and wait for its first repository snapshot.', String.raw`
export class RepositoryScope {
  constructor() { this.roots = []; this.ready = false; }
  async refresh(folders, lookup) {
    this.roots = (await Promise.all(folders.map(lookup))).flat();
    this.ready = true;
    return this.roots;
  }
  snapshot() { return { ready: this.ready, roots: this.roots }; }
}
`, String.raw`
export class RepositoryScope {
  constructor() { this.roots = []; this.ready = false; this.folderKey = ''; }
  async refresh(folders, lookup) {
    const key = folders.join('|');
    if (key === this.folderKey) return this.roots;
    this.folderKey = key;
    this.roots = (await Promise.all(folders.map(lookup))).flat();
    this.ready = true;
    return this.roots;
  }
  snapshot() { return { ready: this.ready, roots: this.roots }; }
}
`, String.raw`
export class RepositoryScope {
  constructor() { this.roots = []; this.ready = false; this.folderKey = null; }
  async refresh(folders, lookup) {
    const key = folders.join('|');
    if (key === this.folderKey) return this.roots;
    this.folderKey = key;
    this.roots = (await Promise.all(folders.map(lookup))).flat();
    this.ready = true;
    return this.roots;
  }
  snapshot() { return { ready: this.ready, roots: this.roots }; }
}
`, `const s = new mod.RepositoryScope(); await s.refresh(['repo'], async () => ['repo']); return s.snapshot().ready && s.snapshot().roots[0] === 'repo';`, `const s = new mod.RepositoryScope(); await s.refresh([], async () => []); return s.snapshot().ready && s.snapshot().roots.length === 0;`, 'Adapted state machine. It checks initial empty and populated windows, not real VS Code startup.');

caseData(2, 'repository-discovery', 'development', 'Partial folder lookup failure', 'extension/src/repositoryscope.ts @ a0abf6e', 'medium', 'One failed folder lookup freezes successful topology changes.', 'Two workspace folders are open. One lookup fails after the other gains a worktree.', String.raw`
export class RepositoryScope {
  constructor() { this.byFolder = new Map(); }
  async refresh(folders, lookup) {
    const results = await Promise.allSettled(folders.map(lookup));
    for (let i = 0; i < folders.length; i++) {
      if (results[i].status === 'fulfilled') this.byFolder.set(folders[i], results[i].value);
    }
    return [...this.byFolder.values()].flat();
  }
}
`, String.raw`
export class RepositoryScope {
  constructor() { this.byFolder = new Map(); }
  async refresh(folders, lookup) {
    const results = await Promise.allSettled(folders.map(lookup));
    if (results.some((result) => result.status === 'rejected')) return [...this.byFolder.values()].flat();
    for (let i = 0; i < folders.length; i++) {
      if (results[i].status === 'fulfilled') this.byFolder.set(folders[i], results[i].value);
    }
    return [...this.byFolder.values()].flat();
  }
}
`, String.raw`
export class RepositoryScope {
  constructor() { this.byFolder = new Map(); }
  async refresh(folders, lookup) {
    const results = await Promise.allSettled(folders.map(lookup));
    for (let i = 0; i < folders.length; i++) {
      if (results[i].status === 'fulfilled') this.byFolder.set(folders[i], results[i].value);
    }
    return [...this.byFolder.values()].flat();
  }
}
`, `const s = new mod.RepositoryScope(); const roots = await s.refresh(['a','b'], async f => [f]); return roots.join(',') === 'a,b';`, `const s = new mod.RepositoryScope(); await s.refresh(['a','b'], async f => [f]); const roots = await s.refresh(['a','b'], async f => { if (f === 'b') throw Error('offline'); return ['a','a-worktree']; }); return roots.includes('a-worktree') && roots.includes('b');`, 'Adapted two-folder topology. It checks retention of the failed folder and progress of the successful folder.');

caseData(3, 'repository-discovery', 'development', 'POSIX root normalization', 'extension/src/repositoryscope.ts @ a0abf6e', 'low', 'The filesystem root disappears from the workspace root set.', 'Open the POSIX filesystem root as a workspace folder.', String.raw`
export function uniqueRoots(folders) {
  const keys = folders.map((folder) => folder.replace(/\/$/, ''));
  return [...new Set(keys.filter(Boolean))];
}
`, String.raw`
export function uniqueRoots(folders) {
  const keys = folders.map((folder) => folder.replace(/\/$/, ''));
  return [...new Set(keys.filter(Boolean))];
}
export function repositoryRoots(folders, worktrees) {
  return uniqueRoots([...folders, ...worktrees]);
}
`, String.raw`
export function uniqueRoots(folders) {
  const keys = folders.map((folder) => folder === '/' ? '/' : folder.replace(/\/$/, ''));
  return [...new Set(keys.filter(Boolean))];
}
export function repositoryRoots(folders, worktrees) {
  return uniqueRoots([...folders, ...worktrees]);
}
`, `return mod.repositoryRoots(['/repo/'], ['/repo/feature/']).join(',') === '/repo,/repo/feature';`, `return mod.repositoryRoots(['/'], ['/tmp/worktree/']).includes('/');`, 'Adapted path normalization. It checks a POSIX root and ordinary folder deduplication.');

caseData(4, 'repository-discovery', 'development', 'Recorded cwd survives later read failure', 'extension/src/timeline.ts @ a0abf6e', 'medium', 'A failed transcript reread erases a known session directory.', 'A growing transcript reread fails after its first valid cwd was stored.', String.raw`
export class SessionIndex {
  constructor() { this.sessions = new Map(); }
  async update(id, read) {
    const record = await read();
    this.sessions.set(id, { cwd: record.cwd, bytes: record.bytes });
    return this.sessions.get(id);
  }
}
`, String.raw`
export class SessionIndex {
  constructor() { this.sessions = new Map(); }
  async update(id, read) {
    let record;
    try { record = await read(); } catch { record = { cwd: null, bytes: 0 }; }
    this.sessions.set(id, { cwd: record.cwd, bytes: record.bytes });
    return this.sessions.get(id);
  }
}
`, String.raw`
export class SessionIndex {
  constructor() { this.sessions = new Map(); }
  async update(id, read) {
    let record;
    try { record = await read(); } catch { return this.sessions.get(id) ?? null; }
    this.sessions.set(id, { cwd: record.cwd, bytes: record.bytes });
    return this.sessions.get(id);
  }
}
`, `const s = new mod.SessionIndex(); return (await s.update('x', async () => ({cwd:'/repo',bytes:1}))).cwd === '/repo';`, `const s = new mod.SessionIndex(); await s.update('x', async () => ({cwd:'/repo',bytes:1})); return (await s.update('x', async () => { throw Error('read'); })).cwd === '/repo';`, 'Adapted cache update. It checks an already known cwd through a transient read failure.');

caseData(5, 'usage-identity', 'development', 'Unnamed model limit overwrites account usage', 'extension/src/codexwire.ts @ 692cd7a', 'medium', 'A model-specific notification with no valid name overwrites account usage.', 'Account usage is 31 percent. A malformed named-model notification reports zero percent on the same clock.', String.raw`
export function applyLimit(state, event) {
  const scope = event.kind === 'account' ? 'account' : event.limitName;
  if (typeof scope !== 'string' || !scope.trim()) return state;
  return { ...state, [scope.trim()]: event.percent };
}
`, String.raw`
export function applyLimit(state, event) {
  const scope = event.kind === 'account' ? 'account' : (typeof event.limitName === 'string' ? event.limitName.trim() : '');
  return { ...state, [scope || 'account']: event.percent };
}
`, String.raw`
export function applyLimit(state, event) {
  const scope = event.kind === 'account' ? 'account' : event.limitName;
  if (typeof scope !== 'string' || !scope.trim()) return state;
  return { ...state, [scope.trim()]: event.percent };
}
`, `let s = mod.applyLimit({}, {kind:'account',percent:31}); s = mod.applyLimit(s,{kind:'model',limitName:'Sol',percent:2}); return s.account === 31 && s.Sol === 2;`, `let s = mod.applyLimit({}, {kind:'account',percent:31}); s = mod.applyLimit(s,{kind:'model',limitName:null,percent:0}); return s.account === 31;`, 'Adapted identity reducer. It tests account and named-model separation plus a malformed name.');

caseData(6, 'transcript-lifecycle', 'development', 'Child lost at next turn boundary', 'extension/src/codex.ts @ 1ca992c', 'high', 'A child of an unterminated turn disappears when another turn begins.', 'A child starts after a parent turn receives a stale inferred end. A later turn starts.', String.raw`
export function attachChildren(turns, children) {
  return turns.map((turn, index) => ({
    ...turn,
    children: children.filter((child) => child.startedAt >= turn.startedAt && child.startedAt < (turn.endSource === 'inferred' ? turns[index + 1]?.startedAt ?? Infinity : turn.endedAt ?? turns[index + 1]?.startedAt ?? Infinity)),
  }));
}
`, String.raw`
export function attachChildren(turns, children) {
  return turns.map((turn, index) => ({
    ...turn,
    children: children.filter((child) => child.startedAt >= turn.startedAt && child.startedAt < (turn.endedAt ?? Infinity) && child.startedAt < (turns[index + 1]?.startedAt ?? Infinity)),
  }));
}
`, String.raw`
export function attachChildren(turns, children) {
  return turns.map((turn, index) => ({
    ...turn,
    children: children.filter((child) => child.startedAt >= turn.startedAt && child.startedAt < (turn.endSource === 'inferred' ? turns[index + 1]?.startedAt ?? Infinity : turn.endedAt ?? turns[index + 1]?.startedAt ?? Infinity)),
  }));
}
`, `const t = mod.attachChildren([{startedAt:0,endedAt:5},{startedAt:10,endedAt:15}],[{startedAt:2}]); return t[0].children.length === 1 && t[1].children.length === 0;`, `const t = mod.attachChildren([{startedAt:0,endedAt:5,endSource:'inferred'},{startedAt:10,endedAt:15}],[{startedAt:7}]); return t[0].children.length === 1;`, 'Adapted containment projection. It checks an inferred parent end and one subsequent turn.');
cases.find((item) => item.id === 6).revision = 2;

caseData(7, 'transcript-lifecycle', 'development', 'Finished child resurrected by trailing write', 'extension/src/claudehistory.ts @ 8195ad2', 'high', 'A trailing transcript write makes a finished child appear live.', 'A child has a durable process end and a later filesystem modification time.', String.raw`
export function childState(child, fileModifiedAt) {
  if (child.processEndedAt != null) return 'finished';
  return fileModifiedAt - child.lastEventAt < 30_000 ? 'running' : 'unknown';
}
`, String.raw`
export function childState(child, fileModifiedAt) {
  if (fileModifiedAt > (child.processEndedAt ?? 0)) return 'running';
  if (child.processEndedAt != null) return 'finished';
  return fileModifiedAt - child.lastEventAt < 30_000 ? 'running' : 'unknown';
}
`, String.raw`
export function childState(child, fileModifiedAt) {
  if (child.processEndedAt != null) return 'finished';
  return fileModifiedAt - child.lastEventAt < 30_000 ? 'running' : 'unknown';
}
`, `return mod.childState({lastEventAt:100},110) === 'running';`, `return mod.childState({lastEventAt:100,processEndedAt:120},130) === 'finished';`, 'Adapted lifecycle reducer. It checks durable end precedence over file activity.');

caseData(8, 'transcript-parsing', 'development', 'Malformed text block aborts parsing', 'extension/src/transcript.ts @ 141b708', 'medium', 'One malformed text block aborts the whole transcript parse.', 'A transcript contains a malformed text block followed by a valid response.', String.raw`
export function parseTranscript(lines) {
  const text = [];
  for (const line of lines) {
    const event = JSON.parse(line);
    if (event.type === 'text') text.push(String(event.value ?? ''));
  }
  return text;
}
`, String.raw`
export function parseTranscript(lines) {
  const text = [];
  for (const line of lines) {
    const event = JSON.parse(line);
    if (event.type === 'text') text.push(event.value.trim());
  }
  return text;
}
`, String.raw`
export function parseTranscript(lines) {
  const text = [];
  for (const line of lines) {
    const event = JSON.parse(line);
    if (event.type === 'text') text.push(String(event.value ?? ''));
  }
  return text;
}
`, `return mod.parseTranscript(['{"type":"text","value":"hello"}'])[0] === 'hello';`, `try { const v = mod.parseTranscript(['{"type":"text","value":7}','{"type":"text","value":"later"}']); return v.at(-1) === 'later'; } catch (error) { if (error instanceof TypeError && /trim/.test(error.message)) return false; throw error; }`, 'Adapted parser slice. It checks continuation after a non-string block, not full transcript fidelity.');

caseData(9, 'async-refresh', 'development', 'Late page read overwrites newer child state', 'extension/src/timeline.ts @ 1ca992c', 'medium', 'A late page read restores a stale child list.', 'A child appears while an older-history page is in flight.', String.raw`
export class HistoryView {
  constructor() { this.children = []; this.page = []; this.revision = 0; }
  updateChildren(children) { this.children = children; this.revision++; }
  async loadPage(read) {
    const page = await read();
    this.page = page.map(turn => ({...turn, children: this.children.filter(child => child.turnId === turn.id)}));
    return this.page;
  }
}
`, String.raw`
export class HistoryView {
  constructor() { this.children = []; this.page = []; this.revision = 0; }
  updateChildren(children) { this.children = children; this.revision++; }
  async loadPage(read) {
    const children = this.children;
    const page = await read();
    this.page = page.map(turn => ({...turn, children: children.filter(child => child.turnId === turn.id)}));
    return this.page;
  }
}
`, String.raw`
export class HistoryView {
  constructor() { this.children = []; this.page = []; this.revision = 0; }
  updateChildren(children) { this.children = children; this.revision++; }
  async loadPage(read) {
    const page = await read();
    this.page = page.map(turn => ({...turn, children: this.children.filter(child => child.turnId === turn.id)}));
    return this.page;
  }
}
`, `const v = new mod.HistoryView(); v.updateChildren([{turnId:'a'}]); return (await v.loadPage(async()=>[{id:'a'}]))[0].children.length === 1;`, `const v = new mod.HistoryView(); let release; const pending = v.loadPage(()=>new Promise(r=>{release=r})); v.updateChildren([{turnId:'a'}]); release([{id:'a'}]); return (await pending)[0].children.length === 1;`, 'Adapted page admission. It checks a child-list change during the read await.');

caseData(10, 'interaction-routing', 'development', 'Selected text creates duplicate drafts', 'extension/src/timeline.ts @ e86a7f7', 'medium', 'One selected-text command creates a draft in every open panel.', 'Two panel hosts are open when the reader sends one selected-text handoff.', String.raw`
export function sendSelectedText(hosts, source, text) {
  const host = hosts.find(host => host.id === source);
  if (host) host.createDraft(text);
}
`, String.raw`
export function sendSelectedText(hosts, source, text) {
  for (const host of hosts) host.createDraft(text);
}
`, String.raw`
export function sendSelectedText(hosts, source, text) {
  const host = hosts.find(host => host.id === source);
  if (host) host.createDraft(text);
}
`, `const made=[]; mod.sendSelectedText([{id:'a',createDraft:t=>made.push(t)}],'a','quote'); return made.length===1;`, `const made=[]; const hosts=['a','b'].map(id=>({id,createDraft:t=>made.push([id,t])})); mod.sendSelectedText(hosts,'a','quote'); return made.length===1 && made[0][0]==='a';`, 'Adapted host routing. It checks two open hosts and the selected source host.');

caseData(11, 'payload-limits', 'development', 'Rail row ceiling uses average size', 'extension/src/payload.ts @ 3f8ca50', 'medium', 'An oversized rail row passes when small rows dilute its average.', 'One rail row exceeds the serialized byte ceiling while many small rows stay below it.', String.raw`
export function railRowsWithinLimit(rows, limit) {
  return rows.every(row => Buffer.byteLength(JSON.stringify(row)) <= limit);
}
`, String.raw`
export function railRowsWithinLimit(rows, limit) {
  const bytes = rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0);
  return rows.length === 0 || bytes / rows.length <= limit;
}
`, String.raw`
export function railRowsWithinLimit(rows, limit) {
  return rows.every(row => Buffer.byteLength(JSON.stringify(row)) <= limit);
}
`, `return mod.railRowsWithinLimit([{label:'a'},{label:'b'}],100);`, `return !mod.railRowsWithinLimit([{label:'x'.repeat(200)},...Array.from({length:20},()=>({label:'a'}))],100);`, 'Adapted payload guard. It checks the maximum serialized row against a fixed limit.');

caseData(12, 'diagnostics-privacy', 'development', 'Panel diagnostic accepts arbitrary key', 'extension/src/webview/protocol.ts @ 3f8ca50', 'high', 'Malformed panel text enters exported diagnostics as a key.', 'A panel message supplies reader-owned text where a timing category belongs.', String.raw`
const timingKinds = new Set(['render','message','layout']);
export function timingRecord(message) {
  if (!timingKinds.has(message.kind)) return null;
  if (!Number.isFinite(message.milliseconds)) return null;
  return { [message.kind]: message.milliseconds };
}
`, String.raw`
const timingKinds = new Set(['render','message','layout']);
export function timingRecord(message) {
  if (typeof message.kind !== 'string') return null;
  if (!Number.isFinite(message.milliseconds)) return null;
  return { [message.kind]: message.milliseconds };
}
`, String.raw`
const timingKinds = new Set(['render','message','layout']);
export function timingRecord(message) {
  if (!timingKinds.has(message.kind)) return null;
  if (!Number.isFinite(message.milliseconds)) return null;
  return { [message.kind]: message.milliseconds };
}
`, `return mod.timingRecord({kind:'render',milliseconds:4}).render===4;`, `return mod.timingRecord({kind:'private prompt text',milliseconds:4})===null;`, 'Adapted protocol validation. It checks the closed timing vocabulary, not actual file persistence.');

caseData(13, 'usage-formatting', 'holdout', 'Request scale omitted from exact usage detail', 'extension/src/view/stat-detail.ts @ fd9c142', 'medium', 'Exact usage detail hides the request count behind an aggregate token figure.', 'A session has many tiny requests with the same total tokens as one large request.', String.raw`
export function usageDetail(usage) {
  const total = usage.inputTokens + usage.outputTokens;
  return total.toLocaleString() + ' tokens across ' + usage.requests + ' requests';
}
`, String.raw`
export function usageDetail(usage) {
  const total = usage.inputTokens + usage.outputTokens;
  return total.toLocaleString() + ' tokens';
}
`, String.raw`
export function usageDetail(usage) {
  const total = usage.inputTokens + usage.outputTokens;
  return total.toLocaleString() + ' tokens across ' + usage.requests + ' requests';
}
`, `return mod.usageDetail({inputTokens:800,outputTokens:200,requests:1}).includes('1,000 tokens');`, `return mod.usageDetail({inputTokens:800,outputTokens:200,requests:40}).includes('40 requests');`, 'Adapted formatter contract. It checks count visibility, not visual rendering.');

function cleanData(id, family, split, title, reference, before, candidate, normal, symptom, audit, revision = 1) {
  add({ id, family, split, title, reference, before, candidate, corrected: candidate, normal, symptom, audit, kind: 'clean', revision });
}

cleanData(17, 'repository-discovery', 'development', 'Workspace root set with partial lookup', 'extension/src/repositoryscope.ts', String.raw`
export function workspaceRoots(folders) { return [...new Set(folders)]; }
`, String.raw`
export async function workspaceRoots(folders, lookup) {
  const found = await Promise.allSettled(folders.map(folder => Promise.resolve().then(() => lookup(folder))));
  const roots = new Set(folders);
  for (const result of found) {
    if (result.status === 'fulfilled') for (const path of result.value) roots.add(path);
  }
  return [...roots];
}
`, `const r=await mod.workspaceRoots(['a'],async()=>['a-worktree']); return r.includes('a')&&r.includes('a-worktree');`, `const r=await mod.workspaceRoots(['a','b'],f=>{if(f==='b')throw Error('offline');return ['a-worktree']}); return r.includes('a-worktree')&&r.includes('b');`, 'Bounded audit of folder retention, successful lookup, and partial failure. It excludes asynchronous refresh races.', 2);

cleanData(18, 'interaction-routing', 'development', 'Selected-text draft routed to one matching host', 'extension/src/timeline.ts', String.raw`
export function routeDraft(hosts, source, text) { return false; }
`, String.raw`
export function routeDraft(hosts, source, text) {
  const target = hosts.find(host => host.sessionId === source.sessionId && host.windowId === source.windowId);
  if (!target || !text.trim()) return false;
  target.createDraft(text);
  return true;
}
`, `const made=[]; const ok=mod.routeDraft([{sessionId:'a',windowId:'one',createDraft:t=>made.push(t)}],{sessionId:'a',windowId:'one'},'quote'); return ok&&made.length===1;`, `const made=[]; const hosts=['one','two'].map(windowId=>({sessionId:'a',windowId,createDraft:t=>made.push([windowId,t])})); const ok=mod.routeDraft(hosts,{sessionId:'a',windowId:'two'},'quote'); const missing=mod.routeDraft(hosts,{sessionId:'missing',windowId:'two'},'quote'); return ok&&!missing&&made.length===1&&made[0][0]==='two';`, 'Bounded audit of host identity, no matching destination, and duplicate session IDs in separate windows.');

cleanData(19, 'spend-refresh', 'holdout', 'Spend refresh coalesces identical file facts', 'extension/src/projectspend.ts', String.raw`
export class SpendRefresher { constructor(scan) { this.scan=scan; } notify(file) { this.scan(file); } }
`, String.raw`
export class SpendRefresher {
  constructor(scan) { this.scan=scan; this.known=new Map(); }
  notify(file) {
    const signature=file.bytes + ':' + file.modifiedAt;
    if (this.known.get(file.path)===signature) return false;
    this.known.set(file.path,signature);
    this.scan(file);
    return true;
  }
}
`, `let count=0; const r=new mod.SpendRefresher(()=>count++); return r.notify({path:'a',bytes:1,modifiedAt:1})&&r.notify({path:'a',bytes:2,modifiedAt:2})&&count===2;`, `let count=0; const r=new mod.SpendRefresher(()=>count++); const f={path:'a',bytes:1,modifiedAt:1}; r.notify(f); const skipped=!r.notify(f); r.notify({path:'b',bytes:1,modifiedAt:1}); return skipped&&count===2;`, 'Bounded audit of unchanged notifications and independent files. It excludes parser cost after an actual file change.');

cleanData(20, 'style-guard', 'holdout', 'Relative text sizing guard', 'extension/src/timeline.webview.test.ts', String.raw`
export function textSizesAreRelative(css) { return true; }
`, String.raw`
export function textSizesAreRelative(css) {
  const declarations=[...css.matchAll(/(?:font-size|line-height)\s*:\s*([^;}]+)/gi)];
  return declarations.every(([,value]) => !/\d+(?:\.\d+)?\s*(?:px|pt|pc|in|cm|mm|q)\b/i.test(value));
}
`, `return mod.textSizesAreRelative('.badge { font-size: .9em; line-height: 1.3; }');`, `return ['px','pt','pc','in','cm','mm','q'].every(unit => !mod.textSizesAreRelative('.badge { FONT-SIZE: 10' + unit.toUpperCase() + '; }') && !mod.textSizesAreRelative('.badge { line-height: 40' + unit + '; }'));`, 'Bounded audit of static font-size and line-height declarations across CSS absolute units. It excludes CSS custom properties and browser layout.');

const prompts = {
  'repository-discovery': 'Review the proposed workspace discovery change. Session roots must remain complete and current across foldered and folderless windows, on all supported platforms.',
  'usage-identity': 'Review the proposed account-usage projection. Account-wide readings and model-specific readings must keep their distinct identities.',
  'transcript-lifecycle': 'Review the proposed child-session projection. A child must remain attached to its owning turn, and durable process completion must govern its live state.',
  'transcript-parsing': 'Review the transcript parser change. Valid records after a malformed content block must remain available to the reader.',
  'async-refresh': 'Review the proposed history-page refresh. A page read must present the latest admitted child records when it completes.',
  'interaction-routing': 'Review the selected-text handoff change. One command must create at most one destination draft in the intended panel.',
  'payload-limits': 'Review the proposed rail payload guard. Every serialized row must remain within the configured byte ceiling.',
  'diagnostics-privacy': 'Review the timing-message projection. Persisted diagnostics must contain only known timing categories and numeric measurements.',
  'usage-formatting': 'Review the usage-detail formatter. Exact detail must communicate token amounts and the number of requests represented.',
  'spend-refresh': 'Review the spend refresh change. Repeated watcher notices for unchanged file facts must avoid redundant scans.',
  'cost-order-contract': 'Review the cost category projection. Display order must follow the canonical category sequence for any category amounts.',
  'style-guard': 'Review the text-sizing guard. Font and line-height declarations must reject absolute units under CSS syntax rules.'
};
const casePrompts = {
  6: 'Review the proposed child-session projection. A child belongs to a turn when it starts at or after that turn starts and before the next turn starts. An inferred endedAt is a display estimate, not a child ownership boundary. Durable process completion must govern the child live state.',
  17: 'Review the proposed workspace-root union. The caller supplies canonical folder paths. Successful lookups add registered worktrees. A failed lookup must retain its folder path. This case covers one refresh call.',
  18: 'Review the proposed selected-text routing helper. A destination host is identified by session ID and window ID. The helper handles nonempty text and matching or missing hosts.',
  19: 'Review the proposed spend watcher reducer. The caller treats path, byte size, and modification time as the complete file-change signature. Identical notices must avoid repeated scans.',
  20: 'Review the proposed text-sizing guard for plain, comment-free CSS declarations. The scope covers static font-size and line-height values, including mixed-case spelling. Custom properties are outside this audit.'
};
const sourceNames = {
  1:'repositoryscope.mjs',2:'repositoryscope.mjs',3:'repositoryscope.mjs',4:'timeline.mjs',
  5:'codexwire.mjs',6:'codex.mjs',7:'claudehistory.mjs',8:'transcript.mjs',
  9:'timeline.mjs',10:'timeline.mjs',11:'payload.mjs',12:'protocol.mjs',
  13:'stat-detail.mjs',14:'projectspend.mjs',15:'turncard.mjs',16:'style-guard.mjs',
  17:'repositoryscope.mjs',18:'timeline.mjs',19:'projectspend.mjs',20:'style-guard.mjs'
};
const contextNames = {
  1:'panel-host.mjs',2:'workspace-catalog.mjs',3:'session-source.mjs',4:'resume-session.mjs',
  5:'usage-dashboard.mjs',6:'session-cards.mjs',7:'child-status.mjs',8:'turn-reader.mjs',
  9:'timeline-host.mjs',10:'panel-registry.mjs',11:'rail-message.mjs',12:'diagnostics-store.mjs',
  13:'usage-popover.mjs',14:'spend-watcher.mjs',15:'cost-detail.mjs',16:'stylesheet-scan.mjs',
  17:'window-discovery.mjs',18:'draft-inbox.mjs',19:'spend-watcher.mjs',20:'stylesheet-scan.mjs'
};

const contexts = {
  1: {
    source: String.raw`import { RepositoryScope } from './module.mjs';
export class PanelStartup {
  constructor() { this.scope = new RepositoryScope(); }
  async begin(folders, lookup) {
    await this.scope.refresh(folders, lookup);
    const snapshot = this.scope.snapshot();
    return {loading: !snapshot.ready, rootCount: snapshot.roots.length};
  }
}`,
    normal: `const p=new mod.PanelStartup(); const state=await p.begin(['repo'],async()=>['repo']); return !state.loading&&state.rootCount===1;`,
    symptom: `const p=new mod.PanelStartup(); const state=await p.begin([],async()=>[]); return !state.loading&&state.rootCount===0;`
  },
  2: {
    source: String.raw`import { RepositoryScope } from './module.mjs';
export class WorkspaceCatalog {
  constructor() { this.scope = new RepositoryScope(); this.visible = []; }
  async refresh(folders, lookup) {
    const roots = await this.scope.refresh(folders, lookup);
    this.visible = roots.map(path => ({path, discoverable: true}));
    return this.visible;
  }
}`,
    normal: `const c=new mod.WorkspaceCatalog(); const rows=await c.refresh(['a','b'],async f=>[f]); return rows.map(x=>x.path).join(',')==='a,b';`,
    symptom: `const c=new mod.WorkspaceCatalog(); await c.refresh(['a','b'],async f=>[f]); const rows=await c.refresh(['a','b'],async f=>{if(f==='b')throw Error('offline');return ['a','a-worktree']}); return rows.some(x=>x.path==='a-worktree')&&rows.some(x=>x.path==='b');`
  },
  3: {
    source: String.raw`import { repositoryRoots } from './module.mjs';
export function sessionSources(folders, worktrees) {
  return repositoryRoots(folders, worktrees).map(path=>({path,scan:true}));
}`,
    normal: `return mod.sessionSources(['/repo/'],['/repo/feature/']).map(x=>x.path).join(',')==='/repo,/repo/feature';`,
    symptom: `return mod.sessionSources(['/'],['/tmp/worktree/']).some(x=>x.path==='/');`
  },
  4: {
    source: String.raw`import { SessionIndex } from './module.mjs';
export class ResumeSession {
  constructor() { this.index=new SessionIndex(); }
  async update(id,read) { return this.index.update(id,read); }
  command(id) {
    const cwd=this.index.sessions.get(id)?.cwd;
    return cwd ? {cwd,args:['resume',id]} : null;
  }
}`,
    normal: `const h=new mod.ResumeSession(); await h.update('x',async()=>({cwd:'/repo',bytes:1})); return h.command('x').cwd==='/repo';`,
    symptom: `const h=new mod.ResumeSession(); await h.update('x',async()=>({cwd:'/repo',bytes:1})); await h.update('x',async()=>{throw Error('read')}); return h.command('x')?.cwd==='/repo';`
  },
  5: {
    source: String.raw`import { applyLimit } from './module.mjs';
export class UsageDashboard {
  constructor() { this.scopes = {}; }
  receive(notification) {
    const limits = notification.payload?.rateLimits;
    if (!limits || !Number.isFinite(limits.utilization)) return this.scopes;
    this.scopes = applyLimit(this.scopes, {
      kind: notification.scope,
      limitName: limits.limitName,
      percent: limits.utilization,
    });
    return this.scopes;
  }
  accountPercent() { return this.scopes.account ?? null; }
}`,
    normal: `const d=new mod.UsageDashboard(); d.receive({scope:'account',payload:{rateLimits:{utilization:31}}}); d.receive({scope:'model',payload:{rateLimits:{limitName:'Sol',utilization:2}}}); return d.accountPercent()===31&&d.scopes.Sol===2;`,
    symptom: `const d=new mod.UsageDashboard(); d.receive({scope:'account',payload:{rateLimits:{utilization:31}}}); d.receive({scope:'model',payload:{rateLimits:{limitName:null,utilization:0}}}); return d.accountPercent()===31;`
  },
  6: {
    source: String.raw`import { attachChildren } from './module.mjs';
export function sessionCards(turns, children) {
  return attachChildren(turns, children).map(turn => ({
    id: turn.id,
    startedAt: turn.startedAt,
    delegatedCount: turn.children.length,
    childIds: turn.children.map(child => child.id),
  }));
}`,
    normal: `const cards=mod.sessionCards([{id:'one',startedAt:0,endedAt:5},{id:'two',startedAt:10,endedAt:15}],[{id:'child',startedAt:2}]); return cards[0].childIds[0]==='child'&&cards[1].delegatedCount===0;`,
    symptom: `const cards=mod.sessionCards([{id:'one',startedAt:0,endedAt:5,endSource:'inferred'},{id:'two',startedAt:10,endedAt:15}],[{id:'child',startedAt:7}]); return cards[0].childIds[0]==='child'&&cards[1].delegatedCount===0;`
  },
  7: {
    source: String.raw`import { childState } from './module.mjs';
export function childRow(child,file) {
  const state=childState(child,file.modifiedAt);
  return {id:child.id,status:state,showRunning:state==='running'};
}`,
    normal: `return mod.childRow({id:'c',lastEventAt:100},{modifiedAt:110}).showRunning;`,
    symptom: `const row=mod.childRow({id:'c',lastEventAt:100,processEndedAt:120},{modifiedAt:130}); return row.status==='finished'&&!row.showRunning;`
  },
  8: {
    source: String.raw`import { parseTranscript } from './module.mjs';
export function turnCards(lines) {
  return parseTranscript(lines).map((text,index)=>({id:index,text}));
}`,
    normal: `return mod.turnCards(['{"type":"text","value":"hello"}'])[0].text==='hello';`,
    symptom: `try { const cards=mod.turnCards(['{"type":"text","value":7}','{"type":"text","value":"later"}']); return cards.at(-1)?.text==='later'; } catch(error) { if(error instanceof TypeError&&/trim/.test(error.message)) return false; throw error; }`
  },
  9: {
    source: String.raw`import { HistoryView } from './module.mjs';
export class TimelineHost {
  constructor() { this.history = new HistoryView(); this.selected = []; }
  childRecordsChanged(children) { this.history.updateChildren(children); }
  async openOlderPage(read) {
    this.selected = await this.history.loadPage(read);
    return this.selected.map(turn => ({id:turn.id, childCount:turn.children.length}));
  }
}`,
    normal: `const h=new mod.TimelineHost(); h.childRecordsChanged([{turnId:'a'}]); return (await h.openOlderPage(async()=>[{id:'a'}]))[0].childCount===1;`,
    symptom: `const h=new mod.TimelineHost(); let release; const pending=h.openOlderPage(()=>new Promise(r=>{release=r})); h.childRecordsChanged([{turnId:'a'}]); release([{id:'a'}]); return (await pending)[0].childCount===1;`
  },
  10: {
    source: String.raw`import { sendSelectedText } from './module.mjs';
export class PanelRegistry {
  constructor() { this.hosts = []; }
  open(id) { const host={id,drafts:[],createDraft(text){this.drafts.push(text)}}; this.hosts.push(host); return host; }
  handoff(selection) {
    if (!selection.text.trim()) return;
    sendSelectedText(this.hosts, selection.hostId, selection.text);
  }
}`,
    normal: `const r=new mod.PanelRegistry(); const h=r.open('one'); r.handoff({hostId:'one',text:'quote'}); return h.drafts.length===1;`,
    symptom: `const r=new mod.PanelRegistry(); const a=r.open('one'),b=r.open('two'); r.handoff({hostId:'one',text:'quote'}); return a.drafts.length===1&&b.drafts.length===0;`
  },
  11: {
    source: String.raw`import { railRowsWithinLimit } from './module.mjs';
export function prepareRailMessage(rows, limit) {
  const payload={type:'rail',rows};
  if (!railRowsWithinLimit(payload.rows,limit)) return {accepted:false,payload:null};
  return {accepted:true,payload:JSON.stringify(payload)};
}`,
    normal: `const r=mod.prepareRailMessage([{label:'a'}],100); return r.accepted&&r.payload.includes('rail');`,
    symptom: `const r=mod.prepareRailMessage([{label:'x'.repeat(200)},...Array.from({length:20},()=>({label:'a'}))],100); return !r.accepted;`
  },
  12: {
    source: String.raw`import { timingRecord } from './module.mjs';
export class DiagnosticsStore {
  constructor() { this.rows=[]; }
  accept(message) {
    const row=timingRecord(message);
    if (row) this.rows.push(row);
  }
  exportText() { return this.rows.map(row=>JSON.stringify(row)).join('\n'); }
}`,
    normal: `const d=new mod.DiagnosticsStore(); d.accept({kind:'render',milliseconds:4}); return d.exportText().includes('render');`,
    symptom: `const d=new mod.DiagnosticsStore(); d.accept({kind:'private prompt text',milliseconds:4}); return !d.exportText().includes('private prompt text');`
  },
  13: {
    source: String.raw`import { usageDetail } from './module.mjs';
export function usagePopover(usage) {
  return {heading:'Request usage',detail:usageDetail(usage),total:usage.inputTokens+usage.outputTokens};
}`,
    normal: `const view=mod.usagePopover({inputTokens:800,outputTokens:200,requests:1}); return view.total===1000&&view.detail.includes('1,000 tokens');`,
    symptom: `const view=mod.usagePopover({inputTokens:800,outputTokens:200,requests:40}); return view.detail.includes('40 requests');`
  },
  14: {
    source: String.raw`import { SpendIndex } from './module.mjs';
export function watchSpend(notices) {
  const scanned=[];
  const index=new SpendIndex(file=>scanned.push(file.path));
  for (const notice of notices) index.onFile(notice);
  return scanned;
}`,
    normal: `return mod.watchSpend([{path:'a',size:1,modifiedAt:1},{path:'a',size:2,modifiedAt:2}]).length===2;`,
    symptom: `const f={path:'a',size:1,modifiedAt:1}; return mod.watchSpend(Array.from({length:20},()=>f)).length===1;`
  },
  15: {
    source: String.raw`import { costRows } from './module.mjs';
export const categoryOrder=['own','delegated','tool'];
export function turnCostDetail(costs) {
  return costRows(costs).map(row=>({id:row.kind,label:row.kind+' cost',amount:row.dollars}));
}`,
    normal: `const rows=mod.turnCostDetail({own:1,delegated:1,tool:1}); return rows.map(x=>x.id).join(',')===mod.categoryOrder.join(',');`,
    symptom: `const rows=mod.turnCostDetail({own:1,delegated:8,tool:3}); return rows.map(x=>x.id).join(',')===mod.categoryOrder.join(',');`
  },
  16: {
    source: String.raw`import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { absoluteTextSize } from './module.mjs';
export async function stylesheetIsRelative(root, name) {
  const css=await readFile(join(root,'src',name),'utf8');
  return !absoluteTextSize(css);
}`,
    files: {'src/relative.css': '.badge { font-size: .9em; line-height: 1.2; }\n', 'src/panel.css': '.badge { FONT-SIZE: 10PX; line-height: 1.2; }\n'},
    normal: `return mod.stylesheetIsRelative(root,'relative.css');`,
    symptom: `return !(await mod.stylesheetIsRelative(root,'panel.css'));`
  },
  17: {
    source: String.raw`import { workspaceRoots } from './module.mjs';
export async function discoverWindows(windows, lookup) {
  const result=[];
  for (const window of windows) result.push({id:window.id,roots:await workspaceRoots(window.folders,lookup)});
  return result;
}`,
    normal: `const rows=await mod.discoverWindows([{id:'one',folders:['a']}],async()=>['a-worktree']); return rows[0].roots.includes('a-worktree');`,
    symptom: `const windows=[{id:'one',folders:['a','b']}]; const retained=rows=>rows[0].roots.includes('a')&&rows[0].roots.includes('a-worktree')&&rows[0].roots.includes('b'); const rejected=await mod.discoverWindows(windows,async f=>{if(f==='b')throw Error('offline');return ['a-worktree']}); if(!retained(rejected))return false; try { const thrown=await mod.discoverWindows(windows,f=>{if(f==='b')throw Error('offline');return ['a-worktree']}); return retained(thrown); } catch { return false; }`
  },
  18: {
    source: String.raw`import { routeDraft } from './module.mjs';
export class DraftInbox {
  constructor(hosts) { this.hosts=hosts; }
  send(source,text) { return routeDraft(this.hosts,source,text); }
}`,
    normal: `const made=[]; const inbox=new mod.DraftInbox([{sessionId:'a',windowId:'one',createDraft:t=>made.push(t)}]); return inbox.send({sessionId:'a',windowId:'one'},'quote')&&made.length===1;`,
    symptom: `const made=[]; const inbox=new mod.DraftInbox(['one','two'].map(windowId=>({sessionId:'a',windowId,createDraft:t=>made.push([windowId,t])}))); return inbox.send({sessionId:'a',windowId:'two'},'quote')&&made.length===1&&made[0][0]==='two';`
  },
  19: {
    source: String.raw`import { SpendRefresher } from './module.mjs';
export function scanNotices(notices) {
  const scans=[];
  const refresh=new SpendRefresher(file=>scans.push(file.path));
  for (const notice of notices) refresh.notify(notice);
  return scans;
}`,
    normal: `return mod.scanNotices([{path:'a',bytes:1,modifiedAt:1},{path:'a',bytes:2,modifiedAt:2}]).length===2;`,
    symptom: `const f={path:'a',bytes:1,modifiedAt:1}; return mod.scanNotices([f,f,{path:'b',bytes:1,modifiedAt:1}]).join(',')==='a,b';`
  },
  20: {
    source: String.raw`import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { textSizesAreRelative } from './module.mjs';
export async function checkPanelCss(root,name) {
  return textSizesAreRelative(await readFile(join(root,'src',name),'utf8'));
}
export function checkSnippet(css) { return textSizesAreRelative(css); }`,
    files: {'src/panel.css': '.badge { font-size: .9em; line-height: 1.2; }\n'},
    normal: `return mod.checkPanelCss(root,'panel.css');`,
    symptom: `return !mod.checkSnippet('.badge { FONT-SIZE: 10PX; line-height: 40q; }');`
  },
};

const diffBases = {
  2: String.raw`export class RepositoryScope {
  constructor() { this.byFolder = new Map(); }
  async refresh(folders, lookup) {
    const roots = await Promise.all(folders.map(lookup));
    folders.forEach((folder, index) => this.byFolder.set(folder, roots[index]));
    return [...this.byFolder.values()].flat();
  }
}`,
  5: String.raw`export function applyLimit(state, event) {
  if (event.kind !== 'account') return state;
  return { ...state, account: event.percent };
}`,
  6: String.raw`export function attachChildren(turns, children) {
  return turns.map(turn => ({ ...turn, children: [] }));
}`,
  7: String.raw`export function childState(child, fileModifiedAt) {
  return fileModifiedAt - child.lastEventAt < 30_000 ? 'running' : 'unknown';
}`,
  8: String.raw`export function parseTranscript(lines) {
  const text = [];
  for (const line of lines) {
    const event = JSON.parse(line);
    if (event.type === 'text' && typeof event.value === 'string') text.push(event.value);
  }
  return text;
}`,
  9: String.raw`export class HistoryView {
  constructor() { this.children = []; this.page = []; this.revision = 0; }
  updateChildren(children) { this.children = children; this.revision++; }
  async loadPage(read) {
    const page = await read();
    this.page = page.map(turn => ({...turn, children: []}));
    return this.page;
  }
}`,
  10: String.raw`export function sendSelectedText(hosts, source, text) {
  hosts[0]?.createDraft(text);
}`,
  11: String.raw`export function railRowsWithinLimit(rows, limit) {
  return Buffer.byteLength(JSON.stringify(rows)) <= limit * rows.length;
}`,
  12: String.raw`export function timingRecord(message) {
  if (message.kind !== 'render') return null;
  if (!Number.isFinite(message.milliseconds)) return null;
  return { render: message.milliseconds };
}`,
  13: String.raw`export function usageDetail(usage) {
  return usage.inputTokens.toLocaleString() + ' input tokens';
}`,
  14: String.raw`export class SpendIndex {
  constructor(recompute) { this.recompute = recompute; }
  onFile(file) { this.recompute(file); }
}`,
  15: String.raw`const order = ['own','delegated'];
export function costRows(costs) {
  return order.map(kind => ({kind, dollars: costs[kind] ?? 0}));
}`,
  16: String.raw`export function absoluteTextSize(css) {
  return /font-size\s*:\s*\d+(?:\.\d+)?(?:px|pt|q)\b/i.test(css);
}`
};

async function writeCase(item) {
  const id = `portable-${String(item.id).padStart(3,'0')}`;
  const fixture = join(root,'fixtures',id);
  const kind = item.kind ?? 'bug';
  const context = contexts[item.id];
  const sourceName = sourceNames[item.id];
  const contextName = contextNames[item.id];
  let before = (diffBases[item.id] ?? item.before).trim() + '\n';
  const candidate = item.candidate.trim() + '\n';
  const corrected = item.corrected.trim() + '\n';
  if (kind === 'bug' && before === corrected) throw new Error(`${id} diff base equals corrected reference`);
  const prompt = `${casePrompts[item.id] ?? prompts[item.family]}\n\nReview the attached diff and source files for concrete correctness defects. Give each finding a file path, failure scenario, and severity.\n`;
  const patch = diff(before, candidate, sourceName);
  await mkdir(join(fixture,'input','src'),{recursive:true});
  await mkdir(join(fixture,'reference','src'),{recursive:true});
  await writeFile(join(fixture,'input','src',sourceName),candidate);
  await writeFile(join(fixture,'reference','src',sourceName),corrected);
  const inputs = [{path:`src/${sourceName}`,sha256:sha(candidate)}];
  if (context) {
    const consumer = context.source.replaceAll('./module.mjs',`./${sourceName}`).trim() + '\n';
    await writeFile(join(fixture,'input','src',contextName),consumer);
    await writeFile(join(fixture,'reference','src',contextName),consumer);
    inputs.push({path:`src/${contextName}`,sha256:sha(consumer)});
    for (const [path,content] of Object.entries(context.files ?? {})) {
      await writeFile(join(fixture,'input',path),content);
      await writeFile(join(fixture,'reference',path),content);
      inputs.push({path,sha256:sha(content)});
    }
  }
  await writeFile(join(fixture,'candidate.diff'),patch);
  await writeFile(join(fixture,'prompt.txt'),prompt);
  const qualification = `import { join } from 'node:path';\nimport { pathToFileURL } from 'node:url';\nconst root = process.argv[2];\nconst mod = await import(pathToFileURL(join(root, 'src', '${context ? contextName : sourceName}')).href);\nasync function normal() { ${context?.normal ?? item.normal} }\nasync function symptom() { ${context?.symptom ?? item.symptom} }\nconst normalPass = !!(await normal());\nconst symptomPass = !!(await symptom());\nconsole.log(JSON.stringify({checks:[{id:'normal-001',role:'normal',pass:normalPass},{id:'symptom-001',role:'symptom',pass:symptomPass}]}));\n`;
  await writeFile(join(fixture,'qualify.mjs'),qualification);
  const definition = {
    schema:'arc-portable-review-case-v1',id,revision:item.revision ?? 1,family:item.family,split:item.split,kind,source_mode:'fixed',title:item.title,
    provenance:{classification:'adapted',reference:item.reference,limitations:item.limitations ?? (item.split==='holdout' ? 'Focused adaptation of recorded Arc behavior. This public holdout is a selection split, not a secret benchmark.' : 'Focused adaptation of recorded Arc behavior, not an exact historical replay.')},
    inputs,prompt_sha256:sha(prompt),diff_sha256:sha(patch),
    keys:kind==='bug'?[{id:'finding-001',severity:item.severity,summary:item.summary,paths:[`src/${sourceName}`],scenario:item.scenario}]:[],audit:item.audit
  };
  await mkdir(join(root,'portable','cases'),{recursive:true});
  await writeFile(join(root,'portable','cases',`${id}.json`),JSON.stringify(definition,null,2)+'\n');
}
caseData(14, 'spend-refresh', 'holdout', 'Repeated spend refresh on unchanged record', 'extension/src/projectspend.ts @ e9e3c461', 'medium', 'Unchanged file notifications trigger a full spend recomputation.', 'A watcher sends repeated notifications for the same transcript size and modified time.', String.raw`
export class SpendIndex {
  constructor(recompute) { this.recompute = recompute; this.stamp = null; }
  onFile(file) {
    const stamp = file.path + ':' + file.size + ':' + file.modifiedAt;
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    this.recompute(file);
  }
}
`, String.raw`
export class SpendIndex {
  constructor(recompute) { this.recompute = recompute; this.stamp = null; }
  onFile(file) {
    const stamp = file.path + ':' + file.size + ':' + file.modifiedAt;
    this.stamp = stamp;
    this.recompute(file);
  }
}
`, String.raw`
export class SpendIndex {
  constructor(recompute) { this.recompute = recompute; this.stamp = null; }
  onFile(file) {
    const stamp = file.path + ':' + file.size + ':' + file.modifiedAt;
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    this.recompute(file);
  }
}
`, `let n=0; const s=new mod.SpendIndex(()=>n++); s.onFile({path:'a',size:1,modifiedAt:1}); s.onFile({path:'a',size:2,modifiedAt:2}); return n===2;`, `let n=0; const s=new mod.SpendIndex(()=>n++); const f={path:'a',size:1,modifiedAt:1}; for(let i=0;i<20;i++) s.onFile(f); return n===1;`, 'Adapted watcher reducer. It checks redundant recomputation count, not wall-clock saturation.');
cases.find((item) => item.id === 14).limitations = 'The historical fault refreshed Project cost on repeated passes. This adaptation models identical watcher notices. The public holdout is a selection split.';

caseData(15, 'cost-order-contract', 'holdout', 'Equal-cost fixture misses reordered categories', 'extension/src/turncard.test.ts @ d1602cd', 'medium', 'Cost categories reorder when their values differ.', 'Two contribution categories have unequal costs and the display must keep canonical category order.', String.raw`
const order = ['own','delegated','tool'];
export function costRows(costs) {
  return order.map(kind => ({kind, dollars: costs[kind] ?? 0}));
}
`, String.raw`
const order = ['own','delegated','tool'];
export function costRows(costs) {
  return order.map(kind => ({kind, dollars: costs[kind] ?? 0})).sort((a,b) => b.dollars - a.dollars);
}
`, String.raw`
const order = ['own','delegated','tool'];
export function costRows(costs) {
  return order.map(kind => ({kind, dollars: costs[kind] ?? 0}));
}
`, `return mod.costRows({own:1,delegated:1,tool:1}).map(x=>x.kind).join(',')==='own,delegated,tool';`, `return mod.costRows({own:1,delegated:8,tool:3}).map(x=>x.kind).join(',')==='own,delegated,tool';`, 'Adapted renderer contract. A tied normal case mirrors the weak historical fixture. The unequal case exposes the drift.');

caseData(16, 'style-guard', 'holdout', 'Mixed-case absolute CSS unit escapes guard', 'extension/src/timeline.webview.test.ts @ 698bfed', 'medium', 'A mixed-case absolute font size passes the style guard.', 'A stylesheet includes FONT-SIZE: 10PX and should fail the relative-unit rule.', String.raw`
export function absoluteTextSize(css) {
  return /(?:font-size|line-height)\s*:\s*\d+(?:\.\d+)?(?:px|pt|q)\b/i.test(css);
}
`, String.raw`
export function absoluteTextSize(css) {
  return /(?:font-size|line-height)\s*:\s*\d+(?:\.\d+)?(?:px|pt|q)\b/.test(css);
}
`, String.raw`
export function absoluteTextSize(css) {
  return /(?:font-size|line-height)\s*:\s*\d+(?:\.\d+)?(?:px|pt|q)\b/i.test(css);
}
`, `return !mod.absoluteTextSize('.badge { font-size: .9em; }');`, `return mod.absoluteTextSize('.badge { FONT-SIZE: 10PX; }');`, 'Adapted text guard. It checks a mixed-case property and unit, not full CSS grammar.');

for (const item of cases) await writeCase(item);
console.log(`Wrote ${cases.length} portable cases`);
