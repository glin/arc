import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { test, vi } from 'vitest';
import { tempDir } from './temproot';
import { claudeCostState, timelineCheckRecords, turn } from './turnfixtures';
import {
  checkTimeline,
  createTimelineEvidenceReader,
  sweepTimeline,
  type TimelineCheckState,
  type TimelineRule,
} from './timelinecheck';
import {
  createClaudeSessionReducer,
  projectSlug,
  readSessionWork,
  sessionOutcomeOf,
  type ClaudeChildSessionFile,
} from './transcript';
import {
  ClaudeChildWorkCache,
  carriedSubagentCount,
  liveTimelineChildren,
  outcomesFor,
  timelineRailState,
} from './timelinestate';
import { toCard } from './turncard';
import { CHILD_CLOSE_MARGIN_MS } from './turnrail';
import * as transcript from './transcript';

const NOW = Date.parse('2026-10-03T03:15:00Z');
const CLOSE = Date.parse('2026-10-03T03:00:05Z');

function fixture(
  options: Parameters<typeof timelineCheckRecords>[1] = {},
  write = CLOSE,
  work: { rows?: object[]; file?: string; cache?: ClaudeChildWorkCache } = {},
) {
  const records = timelineCheckRecords('/repo', options);
  const file = work.file ?? path.join(tempDir('timeline-child-'), 'child.jsonl');
  const childRows = work.rows ?? records.child;
  fs.writeFileSync(file, childRows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const parser = createClaudeSessionReducer('parent', { agentSessionTargetOf: (agent) => agent.id });
  const parent = createTimelineEvidenceReader(NOW, write);
  for (const record of records.parent) {
    parser.pushLine(JSON.stringify(record));
    parent.apply(record);
  }
  const child = createTimelineEvidenceReader(NOW, write);
  for (const record of childRows) child.apply(record);
  const read = parser.read();
  const session = { agent: 'claude' as const, file: '/parent', sessionId: 'parent', mtimeMs: write, size: 1 };
  const children: ClaudeChildSessionFile[] = [
    {
      ...session,
      file,
      sessionId: 'child',
      parentSessionId: 'parent',
      toolUseIds: ['launch'],
      childTranscript: true,
      agentRun: true,
      cwd: '/repo',
    },
  ];
  const outcomes = outcomesFor(
    [session],
    {},
    () => read,
    () => ({ outcome: sessionOutcomeOf(read), backgroundCommands: [] }),
  );
  const cache = work.cache ?? new ClaudeChildWorkCache();
  const live = liveTimelineChildren(outcomes, children, [], new Map(), new Map(), NOW, (target) =>
    cache.read(target, `${write}:${fs.statSync(target).size}`),
  );
  const liveChildren = new Set(live.get('parent') ?? []);
  const rail = timelineRailState(outcomes, live, new Set(), new Set(), new Map(), new Map(), NOW);
  const cards = read.turns.map((value, index) =>
    toCard(value, index === read.turns.length - 1, NOW, [], null, false, liveChildren),
  );
  const state: TimelineCheckState = {
    session: 'parent',
    cards,
    liveChildren,
    carried: carriedSubagentCount(read.turns.at(-1)!, true, cards.at(-1)!.status, liveChildren),
    rail: rail.statuses.get('parent'),
    parent: parent.evidence,
    children: new Map([['child', child.evidence]]),
  };
  return state;
}

const result = (state: TimelineCheckState, rule: TimelineRule) =>
  checkTimeline(state, NOW).filter((finding) => finding.rule === rule);

test('a delayed file write leaves the completed child, running figure, and session list closed', () => {
  const close = Date.parse('2026-10-03T03:10:04.365Z');
  const lastWork = Date.parse('2026-10-03T03:10:04.337Z');
  const write = Date.parse('2026-10-03T03:10:05.899Z');
  const state = fixture({ close, lastWork }, write);
  assert.equal(state.cards[0].agents[0].state, 'done');
  assert.equal(state.cards[0].chips.find((chip) => chip.metric === 'agents')?.running, undefined);
  assert.equal(state.rail, 'done');
  assert.deepEqual([...state.liveChildren], []);
  const resumed = fixture({ close, lastWork, resume: close + 2000 }, close + 2001);
  assert.equal(resumed.cards[0].agents[0].state, 'running');
  assert.equal(resumed.cards[0].chips.find((chip) => chip.metric === 'agents')?.running, 1);
  assert.equal(resumed.rail, 'subagents');
});

test('child work ignores bookkeeping and caches both known and absent work by file version', () => {
  const file = path.join(tempDir('child-work-'), 'child.jsonl');
  const write = (rows: object[]) => fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n'));
  const work = CLOSE + 2000;
  write([
    { type: 'user', timestamp: new Date(CLOSE).toISOString() },
    { type: 'assistant', timestamp: new Date(work).toISOString() },
    { type: 'user', timestamp: new Date(work - 1).toISOString() },
    { type: 'system', subtype: 'turn_duration', timestamp: new Date(NOW).toISOString() },
    { type: 'assistant', timestamp: 'invalid' },
  ]);
  const cache = new ClaudeChildWorkCache();
  const reader = vi.fn<typeof readSessionWork>(readSessionWork);
  assert.equal(cache.read(file, 'v1', reader), work);
  assert.equal(cache.read(file, 'v1', reader), work);
  assert.equal(reader.mock.calls.length, 1);
  write([{ type: 'system', subtype: 'turn_duration', timestamp: new Date(NOW).toISOString() }]);
  assert.equal(cache.read(file, 'v2', reader), undefined);
  assert.equal(cache.read(file, 'v2', reader), undefined);
  assert.equal(reader.mock.calls.length, 2);
  write([{ type: 'user', timestamp: work + 1000 }]);
  assert.equal(cache.read(file, 'v3', reader), work + 1000);
  assert.equal(reader.mock.calls.length, 3);
  cache.retain(new Set());
  assert.equal(cache.read(file, 'v3', reader), work + 1000);
  assert.equal(reader.mock.calls.length, 4);
});

test.each(['user', 'assistant'])('large %s work reopens the child row, running figure, and session list', (type) => {
  const resume = CLOSE + 2000;
  const records = timelineCheckRecords('/repo', { close: CLOSE, resume });
  const rows = records.child.map((row) =>
    'timestamp' in row && row.timestamp === new Date(resume).toISOString()
      ? { ...row, type, message: { role: type, content: 'Work '.repeat(70_000) } }
      : row,
  );
  const state = fixture({ close: CLOSE, resume }, resume + 1, { rows });
  assert.equal(state.cards[0].agents[0].state, 'running');
  assert.equal(state.cards[0].chips.find((chip) => chip.metric === 'agents')?.running, 1);
  assert.equal(state.rail, 'subagents');
  assert.equal(result(state, 'R2')[0].result, 'pass');
});

test('large bookkeeping preserves accepted resumed child work across file versions', () => {
  const resume = CLOSE + 2000;
  const file = path.join(tempDir('timeline-child-'), 'child.jsonl');
  const cache = new ClaudeChildWorkCache();
  const options = { close: CLOSE, resume };
  const before = fixture(options, resume + 1, { file, cache });
  assert.equal(before.cards[0].agents[0].state, 'running');
  const rows = [
    ...timelineCheckRecords('/repo', options).child,
    { type: 'system', timestamp: new Date(resume + 2).toISOString(), content: 'Bookkeeping '.repeat(30_000) },
  ];
  const after = fixture(options, resume + 2, { rows, file, cache });
  assert.equal(after.cards[0].agents[0].state, 'running');
  assert.equal(after.cards[0].chips.find((chip) => chip.metric === 'agents')?.running, 1);
  assert.equal(after.rail, 'subagents');
  assert.equal(result(after, 'R2')[0].result, 'pass');
});

test.each([CHILD_CLOSE_MARGIN_MS - 1, CHILD_CLOSE_MARGIN_MS, CHILD_CLOSE_MARGIN_MS + 1])(
  'R2 applies the close margin to work %s milliseconds after closure',
  (elapsed) => {
    const state = fixture({ close: CLOSE, resume: CLOSE + elapsed }, CLOSE + 4000);
    const reopens = elapsed > CHILD_CLOSE_MARGIN_MS;
    assert.equal(state.cards[0].agents[0].state, reopens ? 'running' : 'done');
    assert.equal(result(state, 'R2')[0].result, 'pass');
    if (reopens) {
      state.cards[0].agents[0].state = 'done';
      assert.equal(result(state, 'R2')[0].result, 'violation');
    }
  },
);

test('R1 reports a closed child reopened by a write without new work', () => {
  const passing = fixture({ close: CLOSE });
  assert.equal(result(passing, 'R1')[0].result, 'pass');
  const broken = fixture({ close: CLOSE }, CLOSE + 2000);
  broken.cards[0].agents[0].state = 'running';
  assert.equal(broken.cards[0].agents[0].state, 'running');
  assert.equal(result(broken, 'R1')[0].result, 'violation');
  broken.cards[0].agents.push({ ...broken.cards[0].agents[0] });
  assert.equal(result(broken, 'R1').length, 1);
  broken.children = new Map();
  assert.equal(result(broken, 'R1')[0].result, 'unknown');
});

test('R2 reports recent resumed work when the child stays finished', () => {
  const state = fixture({ close: CLOSE, resume: CLOSE + 3000 }, CLOSE + 4000);
  assert.equal(state.cards[0].agents[0].state, 'running');
  assert.equal(result(state, 'R2')[0].result, 'pass');
  state.cards[0].agents[0].state = 'done';
  assert.equal(result(state, 'R2')[0].result, 'violation');
  state.parent = undefined;
  assert.equal(result(state, 'R2')[0].result, 'unknown');
});

test('R3 counts a carried child once across older rows and the newest figure', () => {
  const state = fixture({ carried: true }, CLOSE + 4000);
  assert.equal(state.cards.length, 2);
  assert.equal(state.carried, 1);
  assert.equal(result(state, 'R3')[0].result, 'pass');
  state.cards.at(-1)!.chips.find((chip) => chip.metric === 'agents')!.running = 2;
  assert.equal(result(state, 'R3')[0].result, 'violation');
  state.cards = [];
  assert.equal(result(state, 'R3')[0].result, 'unknown');
});

test('R4 catches session-list and card output disagreement in either direction', () => {
  const state = fixture({}, CLOSE + 4000);
  assert.equal(result(state, 'R4')[0].result, 'pass');
  state.rail = 'done';
  assert.equal(result(state, 'R4')[0].result, 'violation');
  state.rail = undefined;
  assert.equal(result(state, 'R4')[0].result, 'unknown');
  const idle = fixture({ close: CLOSE });
  idle.rail = 'subagents';
  assert.equal(result(idle, 'R4')[0].result, 'violation');
});

test('R5 checks both figures against their records and permits carried children', () => {
  const state = fixture({ carried: true }, CLOSE + 4000);
  assert.ok(result(state, 'R5').every((finding) => finding.result === 'pass'));
  const card = toCard(
    turn({ files: [{ path: '/repo/file.ts', added: 1, removed: 0, isNew: true, edits: [] }] }),
    true,
    NOW,
  );
  state.cards = [card];
  state.carried = 0;
  assert.ok(result(state, 'R5').every((finding) => finding.result === 'pass'));
  const files = card.chips.find((chip) => chip.metric === 'files')!;
  files.label = '2 files';
  assert.equal(result(state, 'R5').find((finding) => finding.reason.startsWith('files'))!.result, 'violation');
  files.label = '1 file';
  files.detailList = undefined;
  assert.equal(result(state, 'R5').find((finding) => finding.reason.startsWith('files'))!.result, 'unknown');
  const agents = fixture();
  agents.cards[0].chips.find((chip) => chip.metric === 'agents')!.label = '2 subagents';
  assert.equal(result(agents, 'R5').find((finding) => finding.reason.startsWith('agents'))!.result, 'violation');
});

test('foreground and no-ID children return unknown independent-work checks', () => {
  for (const options of [{ foreground: true }, { noId: true }]) {
    const state = fixture(options);
    assert.equal(result(state, 'R1')[0].result, 'unknown');
    assert.equal(result(state, 'R2')[0].result, 'unknown');
    assert.ok(!checkTimeline(state, NOW).some((finding) => finding.result === 'violation'));
  }
});

test('evidence excludes bookkeeping, retains close status, and drops future work and closes', () => {
  const records = timelineCheckRecords('/repo', { close: CLOSE, resume: NOW + 1000 });
  const reader = createTimelineEvidenceReader(NOW, NOW + 4000);
  for (const record of [...records.child, ...records.parent]) reader.apply(record);
  assert.equal(reader.evidence.lastWork, CLOSE);
  assert.equal(reader.evidence.closes.get('child')?.status, 'completed');
  assert.equal(reader.evidence.writtenAt, NOW);
  reader.apply({
    type: 'attachment',
    timestamp: new Date(NOW + 500).toISOString(),
    attachment: {
      type: 'queued_command',
      commandMode: 'task-notification',
      prompt: '<task-id>child</task-id><status>failed</status>',
    },
  });
  assert.equal(reader.evidence.closes.get('child')?.at, CLOSE);
  reader.apply(claudeCostState({}, NOW, 'parent'));
  assert.equal(reader.evidence.processEndedAt, undefined);
  reader.apply(claudeCostState({}, CLOSE, 'parent'));
  assert.equal(reader.evidence.processEndedAt, CLOSE + 1);
  const work = createTimelineEvidenceReader(NOW);
  records.child.forEach((record) => work.apply(record));
  assert.equal(work.evidence.lastWork, records.start + 4000);
  work.apply({ type: 'assistant', message: { content: [] } });
  assert.equal(work.evidence.workComplete, false);
});

function diskFixture(project: string, options: Parameters<typeof timelineCheckRecords>[1] = {}) {
  const root = tempDir('timeline-projects-');
  const dir = path.join(root, projectSlug(project));
  fs.mkdirSync(path.join(dir, 'parent', 'subagents'), { recursive: true });
  const records = timelineCheckRecords(project, options);
  const parent = path.join(dir, 'parent.jsonl');
  const child = path.join(dir, 'parent', 'subagents', 'agent-child.jsonl');
  for (const [file, rows] of [
    [parent, records.parent],
    [child, records.child],
  ] as const) {
    fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    fs.utimesSync(file, new Date(CLOSE + 4000), new Date(CLOSE + 4000));
  }
  return { root, parent, child };
}

test('project sweep uses production child reopening and historical timestamp filtering', async () => {
  const project = tempDir('timeline-workspace-');
  const disk = diskFixture(project, { close: CLOSE, resume: NOW + 1000 });
  fs.appendFileSync(disk.parent, JSON.stringify({ ...claudeCostState({}, NOW, 'parent'), totalDuration: 1000 }) + '\n');
  const copyDir = path.join(disk.root, projectSlug(project) + '-copy');
  fs.mkdirSync(copyDir);
  const copy = path.join(copyDir, 'parent.jsonl');
  fs.copyFileSync(disk.parent, copy);
  fs.utimesSync(copy, new Date(CLOSE), new Date(CLOSE));
  const before = [fs.readFileSync(disk.parent), fs.readFileSync(disk.child), fs.statSync(disk.child).mtimeMs];
  const report = await sweepTimeline(project, NOW - 7 * 86400000, NOW, disk.root);
  assert.equal(report.sessions, 2);
  assert.deepEqual(report.violations, []);
  assert.deepEqual(
    [fs.readFileSync(disk.parent), fs.readFileSync(disk.child), fs.statSync(disk.child).mtimeMs],
    before,
  );
});

test('project sweep detects resumed work missed by the production reader', async () => {
  const project = tempDir('timeline-workspace-');
  const resume = CLOSE + 3000;
  const disk = diskFixture(project, { close: CLOSE, resume });
  const original = transcript.readSessionWork;
  const failed = vi
    .spyOn(transcript, 'readSessionWork')
    .mockImplementation((file, bytes, now) => (file === disk.child ? null : original(file, bytes, now)));
  try {
    const report = await sweepTimeline(project, NOW - 86400000, NOW, disk.root);
    assert.ok(
      report.violations.some(
        (finding) => finding.rule === 'R2' && finding.child === 'child' && finding.lastWork === resume,
      ),
    );
  } finally {
    failed.mockRestore();
  }
});

test.each(['opening', 'old turns'])('project sweep retains unknown coverage for incomplete %s', async (prefix) => {
  const project = tempDir('timeline-workspace-');
  const since = NOW - 60_000;
  const disk = diskFixture(project, { close: CLOSE });
  if (prefix === 'opening') {
    fs.writeFileSync(disk.parent, JSON.stringify({ type: 'system', cwd: project }) + '\n');
  }
  fs.appendFileSync(disk.parent, '{malformed\n');
  fs.utimesSync(disk.parent, new Date(NOW), new Date(NOW));
  const report = await sweepTimeline(project, since, NOW, disk.root);
  assert.equal(report.sessions, 1, prefix);
  assert.equal(report.unknown, 1, prefix);
  assert.deepEqual(report.violations, [], prefix);
  const complete = fs.readFileSync(disk.parent, 'utf8').replace('{malformed\n', '');
  fs.writeFileSync(disk.parent, complete);
  fs.utimesSync(disk.parent, new Date(NOW), new Date(NOW));
  const emptyWindow = await sweepTimeline(project, since, NOW, disk.root);
  assert.equal(emptyWindow.sessions, 0, prefix);
  assert.equal(emptyWindow.unknown, 0, prefix);
});

test('project sweep retains unknown coverage when an admitted parent read fails', async () => {
  const project = tempDir('timeline-workspace-');
  const disk = diskFixture(project, { close: CLOSE });
  const nativeFs = createRequire(__filename)('node:fs') as typeof fs;
  const original = nativeFs.createReadStream;
  const failed = vi.spyOn(nativeFs, 'createReadStream').mockImplementation((file, options) => {
    if (file === disk.parent) throw new Error('Synthetic parent read failure');
    return original(file, options);
  });
  syncBuiltinESMExports();
  try {
    const report = await sweepTimeline(project, NOW - 86400000, NOW, disk.root);
    assert.equal(report.sessions, 1);
    assert.equal(report.unknown, 1);
    assert.deepEqual(report.violations, []);
  } finally {
    failed.mockRestore();
    syncBuiltinESMExports();
  }
});

test.each([CLOSE + 6000, NOW + 1000])('project sweep accepts the observed process-end boundary %s', async (end) => {
  const project = tempDir('timeline-workspace-');
  const disk = diskFixture(project, { close: CLOSE, resume: CLOSE + 3000 });
  const answer = timelineCheckRecords(project).child[1];
  fs.appendFileSync(disk.child, JSON.stringify({ ...answer, timestamp: new Date(CLOSE + 4000).toISOString() }) + '\n');
  fs.utimesSync(disk.child, new Date(CLOSE + 4000), new Date(CLOSE + 4000));
  fs.appendFileSync(disk.parent, JSON.stringify(claudeCostState({}, end - 1, 'parent')) + '\n');
  const report = await sweepTimeline(project, NOW - 86400000, NOW, disk.root);
  assert.equal(report.sessions, 2);
  assert.deepEqual(report.violations, [], new Date(end).toISOString());
  assert.equal(report.unknown, 0);
});

test('project sweep checks later resumed work after a parent process end', async () => {
  const project = tempDir('timeline-workspace-');
  const disk = diskFixture(project, { close: CLOSE, resume: CLOSE + 3000 });
  const end = CLOSE + 6000;
  const later = CLOSE + 8000;
  fs.appendFileSync(disk.parent, JSON.stringify(claudeCostState({}, end - 1, 'parent')) + '\n');
  const records = timelineCheckRecords(project);
  fs.appendFileSync(
    disk.parent,
    [records.parent[0], records.parent.at(-1)]
      .map((record) => JSON.stringify({ ...record, timestamp: new Date(later).toISOString() }))
      .join('\n') + '\n',
  );
  fs.appendFileSync(
    disk.child,
    JSON.stringify({ ...records.child[0], timestamp: new Date(later).toISOString() }) + '\n',
  );
  fs.utimesSync(disk.child, new Date(later + 1), new Date(later + 1));
  const report = await sweepTimeline(project, NOW - 86400000, NOW, disk.root);
  assert.equal(report.sessions, 2);
  assert.ok(
    report.violations.some(
      (finding) => finding.rule === 'R2' && finding.child === 'child' && finding.lastWork === later,
    ),
  );
});

test('npm prefix and extension-directory invocations default to the caller project', { tags: ['subprocess'] }, () => {
  const repository = path.resolve(__dirname, '../..');
  const locations = [repository, path.join(repository, 'extension')];
  for (const cwd of locations) {
    const disk = diskFixture(cwd, { close: CLOSE });
    const args = cwd === repository ? ['--prefix', 'extension', 'run', 'check:timeline'] : ['run', 'check:timeline'];
    const launch = spawnSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      [...args, '--', '--now', new Date(NOW).toISOString()],
      {
        cwd,
        env: { ...process.env, INIT_CWD: undefined, ARC_PROJECTS_ROOT: disk.root },
        encoding: 'utf8',
        shell: process.platform === 'win32',
      },
    );
    assert.equal(launch.status, 0, launch.stderr + launch.stdout);
    assert.ok(launch.stdout.split(/\r?\n/).includes(`Project ${cwd}`), launch.stdout);
    assert.ok(launch.stdout.includes('0 violations'), launch.stdout);
  }
});

test('project membership preserves drive-path case folding and Unix platform case rules', async () => {
  const windows = diskFixture('C:/Mixed/Project', { close: CLOSE });
  const unix = diskFixture('/Mixed/Project', { close: CLOSE });
  const nativeProcess = process;
  try {
    for (const platform of ['win32', 'darwin', 'linux']) {
      vi.stubGlobal('process', { ...nativeProcess, platform });
      assert.ok((await sweepTimeline('c:/mixed/project', NOW - 86400000, NOW, windows.root)).sessions > 0, platform);
      assert.equal(
        (await sweepTimeline('/mixed/project', NOW - 86400000, NOW, unix.root)).sessions > 0,
        platform === 'win32',
        platform,
      );
    }
  } finally {
    vi.unstubAllGlobals();
  }
});
