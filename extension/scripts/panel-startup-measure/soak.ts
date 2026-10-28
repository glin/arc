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
    Promise.resolve(vscode.commands.executeCommand('arc.savePerformanceDiagnostics', soakPath.join(soakDirectory, next + '.json')))
      .then((written: unknown) => { if (!written) soakFs.writeFileSync(soakPath.join(soakDirectory, next + '.failed'), 'null'); },
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
// keep their identity, so a store a warm-up launch filled stays valid. A file the run appends to must be new.
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
        fs.linkSync(a, b);
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
): DispatchSimulation {
  const parentId = randomUUID();
  const childId = randomUUID();
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
  fs.writeFileSync(child, opening);
  return { parent, child, childId, appends: 0, bytes: Buffer.byteLength(opening) };
}

// Append one completed child turn with growing token totals.
export function appendDispatchTurn(simulation: DispatchSimulation, workspace: string, now = Date.now()): void {
  const turn = simulation.appends + 1;
  const turnId = randomUUID();
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
  simulation.appends = turn;
  simulation.bytes += Buffer.byteLength(bytes);
}

export interface HostMemory {
  pid: number;
  workingSetBytes: number;
  peakWorkingSetBytes: number | null;
  privateBytes: number | null;
}

// Read the extension host of the editor that owns this profile. Windows reports the process's own peak working set.
// Linux reports its peak resident size. macOS reports current resident size only, so the caller keeps the sampled maximum.
export function hostMemory(profile: string): HostMemory | null {
  if (process.platform === 'win32') {
    const escaped = profile.replaceAll("'", "''");
    const query = `$p='${escaped}'; Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($p) -and $_.CommandLine.Contains('node.mojom.NodeService') } | Select-Object ProcessId,WorkingSetSize,PeakWorkingSetSize,PrivatePageCount | ConvertTo-Json -Compress`;
    const result = spawnSync('powershell', ['-NoProfile', '-Command', query], { encoding: 'utf8' });
    if (result.status !== 0 || !result.stdout.trim()) return null;
    const parsed = JSON.parse(result.stdout) as Record<string, number> | Array<Record<string, number>>;
    const row = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!row) return null;
    // Win32_Process reports PeakWorkingSetSize in kibibytes and the other sizes in bytes.
    return {
      pid: row.ProcessId,
      workingSetBytes: row.WorkingSetSize,
      peakWorkingSetBytes: row.PeakWorkingSetSize * 1024,
      privateBytes: row.PrivatePageCount,
    };
  }
  const listing = spawnSync('ps', ['-eo', 'pid=,rss=,args='], { encoding: 'utf8' }).stdout.split('\n');
  const row = listing.find((entry) => entry.includes(profile) && entry.includes('node.mojom.NodeService'));
  if (!row) return null;
  const [pid, rss] = row.trim().split(/\s+/).map(Number);
  let peak: number | null = null;
  if (process.platform === 'linux') {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const hwm = /^VmHWM:\s+(\d+)\s+kB/m.exec(status);
    peak = hwm ? Number(hwm[1]) * 1024 : null;
  }
  return { pid, workingSetBytes: rss * 1024, peakWorkingSetBytes: peak, privateBytes: null };
}

// Count running test-suite and verify-landing processes, including runs that take no suite lock.
export function activeTestRuns(): number {
  const pattern = /(?:test-suite|verify-landing)\.mjs/;
  if (process.platform === 'win32') {
    const query =
      "@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match '(test-suite|verify-landing)\\.mjs' }).Count";
    const count = Number(
      spawnSync('powershell', ['-NoProfile', '-Command', query], { encoding: 'utf8' }).stdout.trim(),
    );
    return Number.isFinite(count) ? count : 0;
  }
  return spawnSync('ps', ['-eo', 'args='], { encoding: 'utf8' })
    .stdout.split('\n')
    .filter((entry) => pattern.test(entry)).length;
}

// The measures a soak snapshot supplies, in the units the comparison reads.
export function soakMeasures(snapshot: {
  counters?: {
    discovery?: Record<string, number>;
    refreshes?: Record<string, { count: number; totalDurationMs: number }>;
    work?: Record<string, number>;
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
  }
  if (typeof snapshot.counters?.work?.catalogWalk === 'number') out.catalogWalks = snapshot.counters.work.catalogWalk;
  return out;
}
