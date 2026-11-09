import * as fs from 'node:fs';
import * as path from 'node:path';
import { ARC_IDENTITY } from './identity';
import { DispatchReceipts } from './dispatchreceipts';
import { payloadSha256 } from './sessionwrites';
import { projectSlug } from './transcript';

// A synthetic workspace for the count budget test. The seed decides every size and link, so two calls with one seed and
// one clock write the same bytes and the same timestamps under different roots.

export const BUDGET_SEED = 20261108;
export const BUDGET_CLOCK = Date.parse('2026-10-20T12:00:00.000Z');

const PARENTS = 150;
const CHILDREN = 60;
const ROLLOUTS = 30;
const COLLISIONS = 3;
const DISPATCHES = 6;
const FOLDERS = ['alpha', 'beta', 'gamma'];

export interface BudgetSource {
  agent: 'claude' | 'codex';
  sessionId: string;
  file: string;
  cwd: string;
}

export interface BudgetChild extends BudgetSource {
  parent: BudgetSource;
}

export interface BudgetDispatch {
  requester: BudgetSource;
  target: BudgetSource;
}

export interface BudgetWorkspace {
  root: string;
  home: string;
  projects: string;
  codexSessions: string;
  folders: string[];
  derivedCacheFile: string;
  codexOpeningsFile: string;
  parents: BudgetSource[];
  children: BudgetChild[];
  rollouts: BudgetSource[];
  dispatches: BudgetDispatch[];
  // The dispatched rollout whose last turn has no end. A final reply completes it.
  runningRollout: BudgetSource;
  completeRunningRollout(at: number): void;
  growChild(child: BudgetChild, at: number): void;
  // Adds rollouts that share a session id with a Claude parent, so the next walk reads their qualified openings.
  addCollisions(at: number): void;
}

function randomFrom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function sessionId(kind: number, index: number): string {
  return `${kind.toString(16).padStart(8, '0')}-${index.toString(16).padStart(4, '0')}-4000-8000-000000000000`;
}

function stamp(at: number): string {
  return new Date(at).toISOString();
}

function writeRecords(file: string, records: unknown[], at: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  fs.utimesSync(file, new Date(at), new Date(at));
}

function appendRecords(file: string, records: unknown[], at: number): void {
  fs.appendFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  fs.utimesSync(file, new Date(at), new Date(at));
}

function claudeRecords(id: string, cwd: string, at: number, padding: number, childIds: string[], prompt: string) {
  const launches = childIds.flatMap((child, index) => [
    {
      type: 'assistant',
      timestamp: stamp(at + 10 + index),
      message: {
        id: `${id}-launch-${index}`,
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'tool_use', id: `toolu-${index}`, name: 'Agent', input: { prompt: 'Review.' } }],
      },
    },
    {
      type: 'user',
      timestamp: stamp(at + 20 + index),
      toolUseResult: { agentId: child, status: 'completed' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu-${index}`, content: 'Done.' }] },
    },
  ]);
  return [
    {
      type: 'user',
      uuid: id,
      sessionId: id,
      cwd,
      timestamp: stamp(at),
      message: { role: 'user', content: `${prompt} ${'x'.repeat(padding)}` },
    },
    ...launches,
    {
      type: 'assistant',
      timestamp: stamp(at + 40),
      message: {
        id: `${id}-reply`,
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: 'Complete.',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1000, output_tokens: 200 },
      },
    },
  ];
}

function rolloutRecords(id: string, cwd: string, at: number, complete: boolean) {
  return [
    { type: 'session_meta', timestamp: stamp(at), payload: { id, cwd, source: 'exec', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: stamp(at + 1), payload: { type: 'user_message', message: 'Review the work.' } },
    { type: 'event_msg', timestamp: stamp(at + 2), payload: { type: 'task_started', turn_id: id } },
    { type: 'turn_context', timestamp: stamp(at + 3), payload: { turn_id: id, model: 'gpt-6-sol' } },
    ...(complete ? rolloutEnd(id, at + 4) : []),
  ];
}

function rolloutEnd(id: string, at: number) {
  return [
    {
      type: 'event_msg',
      timestamp: stamp(at),
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 },
          total_token_usage: { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 },
        },
      },
    },
    { type: 'event_msg', timestamp: stamp(at + 1), payload: { type: 'task_complete', turn_id: id } },
  ];
}

// Writes the workspace beneath `root`.
export function budgetWorkspace(root: string, seed = BUDGET_SEED, clock = BUDGET_CLOCK): BudgetWorkspace {
  const random = randomFrom(seed);
  const pick = (count: number) => Math.floor(random() * count);
  const home = path.join(root, 'arc');
  const projects = path.join(root, 'projects');
  const codexSessions = path.join(root, 'sessions');
  const folders = FOLDERS.map((name) => path.join(root, name));
  for (const folder of folders) fs.mkdirSync(folder, { recursive: true });

  // The children go to parents the seed picks, so some parents hold several and most hold none.
  const childrenOfParent = new Map<number, number[]>();
  for (let child = 0; child < CHILDREN; child++) {
    const parent = pick(PARENTS);
    childrenOfParent.set(parent, [...(childrenOfParent.get(parent) ?? []), child]);
  }
  const childId = (child: number) => `child${child.toString(16).padStart(4, '0')}`;

  const parents: BudgetSource[] = [];
  const children: BudgetChild[] = [];
  for (let index = 0; index < PARENTS; index++) {
    const cwd = folders[index % folders.length];
    const id = sessionId(1, index);
    const directory = path.join(projects, projectSlug(cwd));
    const file = path.join(directory, `${id}.jsonl`);
    const at = clock - (index + 1) * 60_000;
    const owned = childrenOfParent.get(index) ?? [];
    writeRecords(file, claudeRecords(id, cwd, at, pick(2048), owned.map(childId), `Parent task ${index}.`), at);
    const parent: BudgetSource = { agent: 'claude', sessionId: id, file, cwd };
    parents.push(parent);
    for (const child of owned) {
      const agentId = childId(child);
      const childFile = path.join(directory, id, 'subagents', `agent-${agentId}.jsonl`);
      const childAt = at + 5_000 + child;
      writeRecords(childFile, claudeRecords(agentId, cwd, childAt, pick(1024), [], `Child task ${child}.`), childAt);
      children.push({ agent: 'claude', sessionId: agentId, file: childFile, cwd, parent });
    }
  }

  const rollouts: BudgetSource[] = [];
  for (let index = 0; index < ROLLOUTS; index++) {
    const id = sessionId(2, index);
    const cwd = folders[index % folders.length];
    const file = path.join(codexSessions, '2026', '10', '20', `rollout-2026-10-20T00-00-00-${id}.jsonl`);
    const at = clock - (index + 1) * 90_000;
    writeRecords(file, rolloutRecords(id, cwd, at, index !== COLLISIONS + DISPATCHES - 1), at);
    rollouts.push({ agent: 'codex', sessionId: id, file, cwd });
  }

  const receipts = new DispatchReceipts(home);
  const dispatches: BudgetDispatch[] = [];
  for (let index = 0; index < DISPATCHES; index++) {
    const requester = parents[COLLISIONS + index];
    const target = rollouts[COLLISIONS + index];
    const { launchId } = receipts.reserve({
      origin: 'a'.repeat(24),
      requester: { provider: requester.agent, id: requester.sessionId },
      policy: null,
      promptSha256: payloadSha256('Review the assigned work.'),
      completion: 'manual',
      alias: null,
      transport: 'standalone',
      standalone: {
        provider: target.agent,
        command: target.agent,
        args: [],
        cwd: target.cwd,
        model: 'test',
        effort: 'high',
        name: `Review ${index}`,
        agentRun: true,
        background: false,
        env: {
          [`${ARC_IDENTITY.environmentPrefix}PROJECTS_ROOT`]: projects,
          [`${ARC_IDENTITY.environmentPrefix}CODEX_ROOT`]: codexSessions,
        },
        sessionHint: null,
        logAlias: null,
        deadlineMs: 1000,
      },
    });
    const bytes = fs.readFileSync(target.file);
    const opening = bytes.subarray(0, bytes.indexOf(10) + 1);
    const stat = fs.statSync(target.file, { bigint: true });
    const ancestor = path.dirname(target.file);
    const directory = fs.statSync(ancestor, { bigint: true });
    receipts.startup(launchId, {
      file: target.file,
      identity: `${stat.dev}:${stat.ino}`,
      ancestor,
      directory: `${directory.dev}:${directory.ino}`,
      cwd: fs.realpathSync.native(target.cwd),
      bytes: opening.length,
      sha256: payloadSha256(opening.toString()),
    });
    receipts.standaloneSession(launchId, target.sessionId);
    dispatches.push({ requester, target });
  }
  // A directory takes a time of the fixed clock, so a poll that compares its time reads no move.
  const directories = new Set<string>([projects, codexSessions]);
  for (const source of [...parents, ...children, ...rollouts])
    for (let directory = path.dirname(source.file); directory.length > root.length; directory = path.dirname(directory))
      directories.add(directory);
  const settled = new Date(clock - 3_600_000);
  for (const directory of directories) fs.utimesSync(directory, settled, settled);

  const runningRollout = rollouts[COLLISIONS + DISPATCHES - 1];
  return {
    root,
    home,
    projects,
    codexSessions,
    folders,
    derivedCacheFile: path.join(root, 'derived-session-cache.json'),
    codexOpeningsFile: path.join(root, 'codex-openings.json'),
    parents,
    children,
    rollouts,
    dispatches,
    runningRollout,
    completeRunningRollout(at) {
      appendRecords(runningRollout.file, rolloutEnd(runningRollout.sessionId, at), at);
    },
    growChild(child, at) {
      appendRecords(
        child.file,
        [{ type: 'user', timestamp: stamp(at), message: { role: 'user', content: 'One more step.' } }],
        at,
      );
    },
    addCollisions(at) {
      for (const parent of parents.slice(0, COLLISIONS)) {
        const file = path.join(
          codexSessions,
          '2026',
          '10',
          '20',
          `rollout-2026-10-20T00-00-01-${parent.sessionId}.jsonl`,
        );
        writeRecords(file, rolloutRecords(parent.sessionId, parent.cwd, at, true), at);
      }
    },
  };
}
