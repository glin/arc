// Keep a measured editor open after startup, give it dispatched work to chase, and read its counters.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { projectSlug } from '../../src/transcript.ts';

// Each appended child turn grows the rollout by this many bytes of reasoning text, so a spend read has bytes to chase.
const CHILD_TURN_PADDING = 256 * 1024;

// Save performance diagnostics when the runner leaves a request file. The overlay sits at module scope, so it needs no
// activation boundary and applies to any baseline.
export const SOAK_OVERLAY = `
if (process.env.ARC_MEASURE_BLOCK_AGENTS === '1' && process.env.ARC_MEASURE_SOAK) {
  const soakFs = require('node:fs');
  const soakPath = require('node:path');
  const soakDirectory = process.env.ARC_MEASURE_SOAK;
  let soakBusy = false;
  const soakTimer = setInterval(() => {
    if (soakBusy) return;
    let names: string[] = [];
    try { names = soakFs.readdirSync(soakDirectory); } catch { return; }
    const next = names.filter((name: string) => name.endsWith('.request')).map((name: string) => name.slice(0, -'.request'.length))
      .find((name: string) => !names.includes(name + '.json') && !names.includes(name + '.failed'));
    if (!next) return;
    soakBusy = true;
    const snapshotFile = soakPath.join(soakDirectory, next + (process.env.ARC_MEASURE_MATCHED ? '.snapshot' : '.json'));
    Promise.resolve(vscode.commands.executeCommand('arc.savePerformanceDiagnostics', snapshotFile))
      .then((written: unknown) => {
        if (!written) soakFs.writeFileSync(soakPath.join(soakDirectory, next + '.failed'), 'null');
        else if (process.env.ARC_MEASURE_MATCHED) {
          const file = soakPath.join(soakDirectory, next + '.json');
          const snapshot = JSON.parse(soakFs.readFileSync(snapshotFile, 'utf8'));
          snapshot.matchedWork = (globalThis as any).__arcMatchedWork ?? null;
          soakFs.writeFileSync(file, JSON.stringify(snapshot));
        }
      },
        (error: unknown) => soakFs.writeFileSync(soakPath.join(soakDirectory, next + '.failed'), JSON.stringify(String(error))))
      .finally(() => { soakBusy = false; });
  }, 1000);
  soakTimer.unref?.();
}
`;

export function instrumentSoak(tree: string): void {
  const file = path.join(tree, 'extension', 'src', 'extension.ts');
  const text = fs.readFileSync(file, 'utf8');
  if (!/^import \* as vscode from 'vscode';$/m.test(text))
    throw new Error('The baseline lacks its editor import: extension.ts');
  fs.writeFileSync(file, text + SOAK_OVERLAY);
}

// Hard-link every file of a frozen tree into a run's own tree. New files then never reach the fixture, and linked files
// keep their identity, so a store a warm-up launch filled stays valid. A file the run appends to must be new. When the
// run directory sits on another filesystem, the tree is copied instead, and the warm-up fills the store from the copy.
export function linkTree(source: string, target: string): number {
  let linked = 0;
  const walk = (from: string, to: string) => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const a = path.join(from, entry.name);
      const b = path.join(to, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Frozen input contains a link: ${a}`);
      if (entry.isDirectory()) walk(a, b);
      else {
        try {
          fs.linkSync(a, b);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
          fs.copyFileSync(a, b);
        }
        fs.utimesSync(b, fs.statSync(a).atime, fs.statSync(a).mtime);
        linked++;
      }
    }
  };
  walk(source, target);
  return linked;
}

export interface DispatchSimulation {
  parent: string;
  child: string;
  childId: string;
  appends: number;
  bytes: number;
  seedClock?: number;
  initialTurns?: number;
}

function line(record: unknown): string {
  return JSON.stringify(record) + '\n';
}

// Start one dispatched Codex session: a new Claude parent whose shell call launched `codex exec --json`, and the child
// rollout that call named. Both files are new, so no frozen file changes.
export function startDispatch(
  projects: string,
  codex: string,
  workspace: string,
  now = Date.now(),
  identities = { parent: randomUUID(), child: randomUUID() },
): DispatchSimulation {
  const parentId = identities.parent;
  const childId = identities.child;
  const at = (offset: number) => new Date(now + offset).toISOString();
  const parent = path.join(projects, projectSlug(workspace), `${parentId}.jsonl`);
  const toolUseId = `toolu_soak${parentId.replace(/-/g, '').slice(0, 16)}`;
  const command = 'codex exec --json "Measure a dispatched session"';
  const stdout = line({ type: 'thread.started', thread_id: childId });
  fs.mkdirSync(path.dirname(parent), { recursive: true });
  fs.writeFileSync(
    parent,
    [
      {
        type: 'user',
        sessionId: parentId,
        cwd: workspace,
        uuid: 'soak-u1',
        timestamp: at(0),
        message: { role: 'user', content: 'Dispatch a measured child.' },
      },
      {
        type: 'assistant',
        sessionId: parentId,
        cwd: workspace,
        uuid: 'soak-a1',
        parentUuid: 'soak-u1',
        timestamp: at(1),
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command } }],
        },
      },
      {
        type: 'user',
        sessionId: parentId,
        cwd: workspace,
        uuid: 'soak-u2',
        parentUuid: 'soak-a1',
        timestamp: at(2),
        toolUseResult: { stdout, stderr: '', interrupted: false },
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: stdout }] },
      },
      {
        type: 'assistant',
        sessionId: parentId,
        cwd: workspace,
        uuid: 'soak-a2',
        parentUuid: 'soak-u2',
        timestamp: at(3),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'The child is running.' }],
          stop_reason: 'end_turn',
        },
      },
    ]
      .map(line)
      .join(''),
    { flag: 'wx' },
  );
  const date = new Date(now);
  const day = [
    String(date.getUTCFullYear()),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ];
  const stamp = date.toISOString().slice(0, 19).replace(/:/g, '-');
  const child = path.join(codex, ...day, `rollout-${stamp}-${childId}.jsonl`);
  fs.mkdirSync(path.dirname(child), { recursive: true });
  const opening = line({
    timestamp: at(2),
    type: 'session_meta',
    payload: {
      id: childId,
      session_id: childId,
      timestamp: at(2),
      cwd: workspace,
      originator: 'codex_exec',
      source: 'exec',
      cli_version: '0.164.0',
      model_provider: 'openai',
    },
  });
  fs.writeFileSync(child, opening, { flag: 'wx' });
  return { parent, child, childId, appends: 0, bytes: Buffer.byteLength(opening) };
}

// Append one completed child turn with growing token totals.
export function appendDispatchTurn(simulation: DispatchSimulation, workspace: string, now = Date.now()): void {
  const turn = simulation.appends + (simulation.initialTurns ?? 0) + 1;
  if (simulation.seedClock !== undefined) now = simulation.seedClock + turn * 30_000;
  const turnId = simulation.seedClock === undefined ? randomUUID() : `matched-turn-${turn}`;
  const at = (offset: number) => new Date(now + offset).toISOString();
  const usage = (scale: number) => ({
    input_tokens: 20_000 * scale,
    cached_input_tokens: 8_000 * scale,
    cache_write_input_tokens: 0,
    output_tokens: 400 * scale,
    reasoning_output_tokens: 100 * scale,
    total_tokens: 20_400 * scale,
  });
  const text = `Measured child turn ${turn}.`;
  const bytes = [
    {
      timestamp: at(0),
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: turnId, model_context_window: 475000 },
    },
    {
      timestamp: at(1),
      type: 'turn_context',
      payload: { turn_id: turnId, cwd: workspace, model: 'gpt-6.1-sol', effort: 'high' },
    },
    { timestamp: at(2), type: 'event_msg', payload: { type: 'user_message', message: `Continue turn ${turn}.` } },
    {
      timestamp: at(3),
      type: 'response_item',
      payload: {
        type: 'reasoning',
        summary: [],
        content: [{ type: 'reasoning_text', text: 'x'.repeat(CHILD_TURN_PADDING) }],
      },
    },
    {
      timestamp: at(4),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: usage(turn), last_token_usage: usage(1), model_context_window: 475000 },
      },
    },
    { timestamp: at(5), type: 'event_msg', payload: { type: 'agent_message', phase: 'final_answer', message: text } },
    {
      timestamp: at(6),
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: turnId, last_agent_message: text },
    },
  ]
    .map(line)
    .join('');
  fs.appendFileSync(simulation.child, bytes);
  simulation.appends++;
  simulation.bytes += Buffer.byteLength(bytes);
  if (simulation.seedClock !== undefined) fs.utimesSync(simulation.child, now / 1000, now / 1000);
}

// A private prompted child exists before either launch. Exclusive creation refuses fixture collisions.
export function seedDispatch(
  projects: string,
  codex: string,
  workspace: string,
  clock = Date.parse('2026-10-28T08:00:00.000Z'),
): DispatchSimulation {
  const simulation = startDispatch(projects, codex, workspace, clock, {
    parent: '8bef578d-91e2-46c0-83ae-d9e67dfd5a01',
    child: '8bef578d-91e2-46c0-83ae-d9e67dfd5a02',
  });
  simulation.seedClock = clock;
  appendDispatchTurn(simulation, workspace);
  simulation.initialTurns = 1;
  simulation.appends = 0;
  fs.utimesSync(simulation.parent, clock / 1000, clock / 1000);
  return simulation;
}

export interface MatchedEvent {
  kind: string;
  size?: number;
  mtimeMs?: number;
  activity?: number;
}

export interface MatchedObservation {
  run: string;
  selected: string | null;
  parentListed: boolean;
  childListed: boolean;
  watched: boolean;
  qualification: { path: string; entries: number; admitted: number };
  discovery: { entries: number; completed: number };
  relationshipComplete: boolean;
  spendComplete: boolean;
  overflow: boolean;
  events: MatchedEvent[];
  work: { members: number; childSize: number; childMtimeMs: number; childActivity: number; parentSize: number } | null;
  parent: string | null;
  relation: string | null;
}

export interface MatchedTurn {
  turn: number;
  size: number;
  mtimeMs: number;
  activity: number;
  sha256: string;
}

export interface MatchedEvidence {
  ready: MatchedObservation | null;
  end: MatchedObservation | null;
  turns: MatchedTurn[];
  childId: string;
  parentId: string;
  seed: { parentSha256: string; childSha256: string };
}

export function matchedReadiness(observation: MatchedObservation | null, childId: string): string[] {
  if (!observation) return ['matched observation'];
  const missing: string[] = [];
  if (!observation.parentListed || !observation.childListed) missing.push('listed parent and child');
  if (!observation.watched) missing.push('child directory subscription');
  if (!observation.selected || observation.selected === childId) missing.push('unselected child');
  if (!(observation.qualification.entries > 0) || !observation.qualification.path)
    missing.push('qualification path entry');
  if (!(observation.discovery.entries > 0) || !(observation.discovery.completed > 0))
    missing.push('completed discovery path');
  if (!Object.hasOwn(observation, 'overflow') || observation.overflow) missing.push('bounded complete trace');
  return missing;
}

// Equal scheduled writes alone establish no completed work. Every revision needs each observable boundary.
export function missingMatchedEvidence(evidence: MatchedEvidence | undefined, scheduled: number): string[] {
  if (!evidence) return ['matched evidence'];
  const missing = matchedReadiness(evidence.ready, evidence.childId);
  const end = evidence.end;
  if (!end) return [...missing, 'matched end observation'];
  if (!evidence.ready?.run || evidence.ready.run !== end.run || evidence.ready.selected !== end.selected)
    missing.push('single measured host and selection');
  if (!Object.hasOwn(end, 'overflow') || end.overflow) missing.push('bounded complete end trace');
  if (evidence.turns.length !== scheduled) missing.push('scheduled revisions');
  if (!end.relationshipComplete || !end.spendComplete) missing.push('settled relationship and spend work');
  if (end.parent !== evidence.parentId || end.relation !== 'dispatched') missing.push('completed child relationship');
  if (
    !evidence.seed ||
    Object.values(evidence.seed).length !== 2 ||
    Object.values(evidence.seed).some((hash) => !/^[a-f0-9]{64}$/.test(hash))
  )
    missing.push('seed hashes');
  if (
    !end.work ||
    ['members', 'childSize', 'childMtimeMs', 'childActivity', 'parentSize'].some(
      (key) => !Number.isFinite(end.work![key as keyof NonNullable<MatchedObservation['work']>]),
    )
  )
    missing.push('completed source work');
  const last = evidence.turns.at(-1);
  if (
    last &&
    (end.work?.childSize !== last.size ||
      end.work.childMtimeMs !== last.mtimeMs ||
      end.work.childActivity !== last.activity)
  )
    missing.push('final completed revision');
  for (const [index, turn] of evidence.turns.entries()) {
    if (
      turn.turn !== index + 1 ||
      !/^[a-f0-9]{64}$/.test(turn.sha256) ||
      !Number.isFinite(turn.size) ||
      !Number.isFinite(turn.mtimeMs) ||
      !Number.isFinite(turn.activity) ||
      (index > 0 && turn.size <= evidence.turns[index - 1].size)
    )
      missing.push(`turn ${index + 1} source revision`);
    for (const kind of ['notification', 'refreshed', 'accepted', 'published']) {
      if (
        !end.events.some(
          (event) =>
            event.kind === kind &&
            event.size === turn.size &&
            event.mtimeMs === turn.mtimeMs &&
            (kind !== 'published' || event.activity === turn.activity),
        )
      )
        missing.push(`turn ${turn.turn} ${kind}`);
    }
  }
  return missing;
}

export function unmatchedWork(a: MatchedEvidence | undefined, b: MatchedEvidence | undefined): string[] {
  if (!a || !b) return ['matched pair evidence'];
  const different: string[] = [];
  if (a.childId !== b.childId || a.parentId !== b.parentId || a.ready?.selected !== b.ready?.selected)
    different.push('session identities');
  if (JSON.stringify(a.turns) !== JSON.stringify(b.turns)) different.push('source revisions and bytes');
  if (JSON.stringify(a.seed) !== JSON.stringify(b.seed)) different.push('seed bytes');
  if (a.end?.relationshipComplete !== b.end?.relationshipComplete || a.end?.spendComplete !== b.end?.spendComplete)
    different.push('completed work');
  if (JSON.stringify(a.end?.work) !== JSON.stringify(b.end?.work)) different.push('completed source work');
  return different;
}

// These wrappers exist only in measured build trees. Both revisions receive this runner's identical overlay.
export const MATCHED_OVERLAY = `
if (process.env.ARC_MEASURE_MATCHED) {
  const matchedFs = require('node:fs');
  const matchedPath = require('node:path');
  const config = JSON.parse(process.env.ARC_MEASURE_MATCHED);
  const state = { run: process.env.ARC_MEASURE_RUN, selected: null, parentListed: false, childListed: false,
    watched: false, qualification: { path: '', entries: 0, admitted: 0 }, discovery: { entries: 0, completed: 0 },
    relationshipComplete: false, spendComplete: false, overflow: false, events: [], work: null, parent: null, relation: null };
  (globalThis as any).__arcMatchedWork = state;
  const emit = (event: any) => { if (state.events.length < 4096) (state.events as any[]).push(event); else state.overflow = true; };
  const revision = () => { const s = matchedFs.statSync(config.child); return { size: s.size, mtimeMs: s.mtimeMs }; };
  const proto = PanelProvider.prototype as any;
  const observe = (owner: any) => {
    state.selected = owner.showing;
    state.watched = owner.watchers.has(matchedPath.dirname(config.child));
    state.relationshipComplete = owner.dispatchDiscoveryPending === false;
    state.spendComplete = owner.dispatchSpendPending === false;
    const accepted = owner.titles.get(config.child);
    const parent = owner.titles.get(config.parent);
    const edge = owner.sessionParentsOf().get(config.childId);
    state.parent = edge?.parent ?? null;
    state.relation = edge?.relation ?? null;
    state.work = { members: owner.authoritativeCatalog?.length, childSize: accepted?.size,
      childMtimeMs: accepted?.mtimeMs, childActivity: accepted?.activityMs, parentSize: parent?.size } as any;
    if (accepted) emit({ kind: 'accepted', size: accepted.size, mtimeMs: accepted.mtimeMs });
  };
  const qualify = typeof proto.qualifiedPendingSources === 'function' ? 'qualifiedPendingSources' : 'startedSources';
  state.qualification.path = qualify;
  const originalQualify = proto[qualify];
  if (typeof originalQualify !== 'function') throw new Error('Missing matched qualification path');
  proto[qualify] = function(...args: any[]) {
    state.qualification.entries++;
    const out = originalQualify.apply(this, args);
    state.qualification.admitted += out.length;
    return out;
  };
  for (const method of ['refresh', 'prepareClaudeChildren']) {
    const original = proto[method];
    if (typeof original !== 'function') throw new Error('Missing matched path: ' + method);
    proto[method] = async function(...args: any[]) {
      if (method === 'prepareClaudeChildren') state.discovery.entries++;
      const result = await original.apply(this, args);
      if (method === 'prepareClaudeChildren' && result === true) state.discovery.completed++;
      observe(this);
      if (method === 'refresh') {
        const accepted = this.titles.get(config.child);
        if (accepted) emit({ kind: 'refreshed', size: accepted.size, mtimeMs: accepted.mtimeMs });
      }
      return result;
    };
  }
  const wake = proto.wakeFromWatch;
  proto.wakeFromWatch = function(directory: string, kind: string, filename: unknown) {
    if (typeof filename === 'string' && matchedPath.join(directory, filename) === config.child)
      emit({ kind: 'notification', ...revision() });
    return wake.call(this, directory, kind, filename);
  };
  const post = proto.postRows;
  proto.postRows = function(...args: any[]) {
    const message = args[1];
    const rows = message.sessions;
    const child = rows?.find((row: any) => row.id === config.childId);
    const parent = rows?.find((row: any) => row.id === config.parentId);
    const accepted = this.titles.get(config.child);
    const event = child && accepted ? { kind: 'published', size: accepted.size, mtimeMs: accepted.mtimeMs, activity: child.at } : null;
    const result = post.apply(this, args);
    Promise.resolve(result).then((ok) => {
      if (!ok) return;
      if (rows && message.type !== 'selection') { state.childListed = !!child; state.parentListed = !!parent; }
      if (event) emit(event);
      observe(this);
    });
    return result;
  };
}
`;

export function instrumentMatchedWork(tree: string): void {
  const file = path.join(tree, 'extension', 'src', 'panelhost.ts');
  const source = fs.readFileSync(file, 'utf8');
  for (const method of ['prepareClaudeChildren', 'wakeFromWatch', 'postRows'])
    if (!source.includes(`${method}(`)) throw new Error(`The baseline lacks its matched path: ${method}`);
  fs.writeFileSync(file, source + MATCHED_OVERLAY);
}

export interface HostMemory {
  pid: number;
  workingSetBytes: number;
  peakWorkingSetBytes: number | null;
  privateBytes: number | null;
}

// Read the measured extension host's memory by its process ID. Windows reports the process's own peak working set.
// Linux reports its peak resident size. macOS reports current resident size only, so the caller keeps the sampled maximum.
export function hostMemory(pid: number): HostMemory | null {
  if (process.platform === 'win32') {
    const query = `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object ProcessId,WorkingSetSize,PeakWorkingSetSize,PrivatePageCount | ConvertTo-Json -Compress`;
    const result = spawnSync('powershell', ['-NoProfile', '-Command', query], { encoding: 'utf8' });
    if (result.status !== 0 || !result.stdout.trim()) return null;
    const row = JSON.parse(result.stdout) as Record<string, number>;
    // Win32_Process reports PeakWorkingSetSize in kibibytes and the other sizes in bytes.
    return {
      pid,
      workingSetBytes: row.WorkingSetSize,
      peakWorkingSetBytes: row.PeakWorkingSetSize * 1024,
      privateBytes: row.PrivatePageCount,
    };
  }
  if (process.platform === 'linux') {
    let status: string;
    try {
      status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    } catch {
      return null;
    }
    const kib = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)\\s+kB`, 'm').exec(status)?.[1] ?? NaN) * 1024;
    const rss = kib('VmRSS');
    const peak = kib('VmHWM');
    return Number.isFinite(rss)
      ? { pid, workingSetBytes: rss, peakWorkingSetBytes: Number.isFinite(peak) ? peak : null, privateBytes: null }
      : null;
  }
  const rss = Number(spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim());
  return rss > 0 ? { pid, workingSetBytes: rss * 1024, peakWorkingSetBytes: null, privateBytes: null } : null;
}

// The discovery counters every build since the comparison landed reports. A soak whose end snapshot lacks one is
// incomplete, so a missing counter never passes as within its margin.
export const REQUIRED_DISCOVERY_MEASURES = [
  'publications',
  'continuations',
  'passMs',
  'readBytes',
  'dispatchSpendVisits',
  'dispatchSpendBytes',
] as const;

export function missingSoakMeasures(measures: Record<string, number>): string[] {
  return REQUIRED_DISCOVERY_MEASURES.filter((name) => !Number.isFinite(measures[name]));
}

// The host counters the measure table names, by measure name. A refresh count reads the refreshes of its reason. Every
// other counter reads the `work` counter that `WORK_COUNTERS` names, or the `work` counter of its own name. A build that
// never counted one reports 0.
export const NAMED_COUNTERS = [
  'catalogWalks',
  'compressedDecodes',
  'compressedStoreWriteBytes',
  'refreshCount:compressed-facts',
] as const;
const WORK_COUNTERS: Readonly<Record<string, string>> = { catalogWalks: 'catalogWalk' };

// The measures a soak snapshot supplies, in the units the comparison reads. Every gauge passes through by its own name.
export function soakMeasures(snapshot: {
  counters?: {
    discovery?: Record<string, number>;
    refreshes?: Record<string, { count: number; totalDurationMs: number; maximumDurationMs?: number }>;
    work?: Record<string, number>;
    gauges?: Record<string, number>;
    loopDelay?: { maxMs: number; p99Ms: number } | null;
  };
}): Record<string, number> {
  const discovery = snapshot.counters?.discovery ?? {};
  const out: Record<string, number> = {};
  for (const name of [
    'publications',
    'partialPublications',
    'continuations',
    'passMs',
    'readBytes',
    'dispatchSpendVisits',
    'dispatchSpendBytes',
    'dispatchSpendRootRestarts',
  ])
    if (typeof discovery[name] === 'number') out[name] = discovery[name];
  for (const [reason, counts] of Object.entries(snapshot.counters?.refreshes ?? {})) {
    out[`refreshMs:${reason}`] = counts.totalDurationMs;
    out[`refreshCount:${reason}`] = counts.count;
    if (typeof counts.maximumDurationMs === 'number') out[`refreshMaxMs:${reason}`] = counts.maximumDurationMs;
  }
  const work = snapshot.counters?.work ?? {};
  for (const measure of NAMED_COUNTERS) {
    if (typeof out[measure] === 'number') continue;
    const value = measure.startsWith('refreshCount:') ? undefined : work[WORK_COUNTERS[measure] ?? measure];
    out[measure] = typeof value === 'number' ? value : 0;
  }
  for (const [name, value] of Object.entries(snapshot.counters?.gauges ?? {}))
    if (typeof value === 'number') out[name] = value;
  const loopDelay = snapshot.counters?.loopDelay;
  if (loopDelay) {
    out.loopDelayMaxMs = loopDelay.maxMs;
    out.loopDelayP99Ms = loopDelay.p99Ms;
  }
  return out;
}
