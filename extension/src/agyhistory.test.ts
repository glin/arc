import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readAgyHistoryPage, readAgySession, createAgyUsageReducer } from './agyhistory';
import { AGY_DISCOVERY_BYTES, omitAgyCollisions, scanAgySessions } from './agydiscovery';
import {
  indexSpendFile,
  loadSpendLedger,
  prepareProjectSpendView,
  publicProjectSpendPrice,
  saveSpendLedger,
} from './projectspend';
import { findSessionTranscript, sessionCostReport } from './sessioncost';
import { boundedSessionRead } from './sessionreads';
import { closeReadWindow, openReadWindow } from './readmeter';
import { tempDir } from './temproot';
import { searchTurns, searchablePrompt, searchableSummary } from './turnsearch';
import { loadDerivedCache, saveDerivedCache } from './derivedcache';
import { sessionOutcomeOf, sessionStatFactsOf } from './transcript';
import { sessionCostStats, sessionStatsFromFacts, statusOf, toCard, turnCost } from './turncard';

const fixtures = path.resolve(__dirname, '../../.claude/artifacts/2026-11-22-agy-phase1/fixtures');
const acp = '3352f6ae-5337-44ed-a42a-df1b4d26bbc8';
const plain = 'bfa22475-65ef-4767-9b2f-fb1b5678dc02';
const terminal = 'dc3898dc-42e6-491e-bd77-c2530e0f5359';
const interrupt = '668c0fbb-6f7a-4440-8e92-7e1854e0719c';

function fixture(name: string): string {
  return fs.readFileSync(path.join(fixtures, name + '-transcript_full.jsonl'), 'utf8');
}

function saved(brain: string, id: string, contents: string, name = 'transcript_full.jsonl'): string {
  const file = path.join(brain, id, '.system_generated', 'logs', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

test('POSIX discovery checks path case and completed edit targets against both worktrees', () => {
  const brain = tempDir('agy-');
  try {
    const roots = ['/fixture/Arc/worktree-a', '/fixture/Arc/worktree-b'];
    const modern = fixture('acp-id')
      .replaceAll('C:/TEMP/agy-phase1', '/fixture/Arc')
      .replaceAll(String.fromCharCode(92, 92), '/');
    const missed = '00000000-0000-0000-0000-000000000001';
    const sibling = '00000000-0000-0000-0000-000000000002';
    const conflicting = '00000000-0000-0000-0000-000000000003';
    const trailing = '00000000-0000-0000-0000-000000000004';
    const final = JSON.stringify({
      step_index: 22,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-22T05:01:00Z',
      tool_calls: [{ name: 'run_command', args: { Cwd: roots[1] } }],
    });
    saved(brain, acp, modern);
    saved(brain, missed, modern.replaceAll('/fixture/Arc', '/fixture/arc'));
    saved(brain, sibling, modern.replaceAll('worktree-a', 'worktree-ab'));
    saved(
      brain,
      conflicting,
      modern.replace(
        'Made 1 replacement in /fixture/Arc/worktree-a/',
        'Made 1 replacement in /fixture/Arc/worktree-b/',
      ),
    );
    saved(brain, trailing, modern + final);
    for (const platform of ['darwin', 'linux'] as const) {
      const cache = new Map();
      const scan = scanAgySessions(brain, roots, [], { platform, cache, rows: 9, bytes: 800 });
      let step = scan.next();
      for (let slices = 0; !step.done && slices < 200; slices++) step = scan.next();
      assert.ok(step.done);
      assert.deepEqual(
        step.value.rows.map((row) => row.sessionId),
        [acp],
      );

      const second = scanAgySessions(brain, roots, [], { platform, cache, rows: 1 });
      let repeat = second.next();
      for (let slices = 0; !repeat.done && slices < 20; slices++) {
        assert.equal(repeat.value.bytes, 0);
        repeat = second.next();
      }
      assert.ok(repeat.done);
      assert.equal(repeat.value.rows[0], step.value.rows[0]);
    }
  } finally {
    fs.rmSync(brain, { recursive: true, force: true });
  }
});

test('a saved prompt without a reply does not report a running Antigravity session', () => {
  const brain = tempDir('agy-');
  try {
    const file = saved(brain, plain, fixture('print-id-plain').split('\n')[0] + '\n');
    const read = readAgySession(file, plain).read!;
    const outcome = sessionOutcomeOf(read)!;
    assert.equal(statusOf(outcome, true, outcome.endedAt + 1), 'stopped');
    const cost = sessionStatsFromFacts(sessionStatFactsOf(read)).find((chip) => chip.metric === 'cost');
    assert.equal(cost?.label, 'Cost unavailable');
    assert.equal(
      cost?.detail,
      'Token usage unavailable\nAntigravity did not report enough usage to estimate this cost.',
    );
  } finally {
    fs.rmSync(brain, { recursive: true, force: true });
  }
});

test('saved ACP history keeps recorded requests, edit hunks, tool output and interrupted calls', async () => {
  const file = path.join(fixtures, 'acp-id-transcript_full.jsonl');
  const read = readAgySession(file, acp).read!;
  assert.equal(read.turns.length, 6);
  const [first, write, edit, result, secondEdit, stopped] = read.turns;
  assert.equal(first.prompt, 'Reply with the single word OK. Do not use tools.');
  assert.equal(first.model, 'gemini-3.8-flash-low');
  assert.equal(write.files[0].edits[0].content, 'OK\nTWO\n');
  assert.equal(write.files[0].edits[0].originalFile, '');
  assert.deepEqual([write.usage.input, write.usage.cacheRead, write.usage.output], [4450, 14487, 58]);
  assert.deepEqual(turnCost(write), { dollars: null, partial: true });
  assert.deepEqual(edit.files[0].edits[0].hunks[0].lines, ['-TWO', '+THREE']);
  assert.equal(edit.files[0].edits[0].originalFile, null);
  assert.equal(edit.steps[0].status, 'done');
  assert.match(result.updates.at(-1)!.text, /Showing lines 1-2/);
  assert.equal(secondEdit.finished, true);
  assert.equal(stopped.interrupted, true);
  assert.equal(stopped.steps[0].status, 'interrupted');
  assert.equal(stopped.finished, false);

  let older = await readAgyHistoryPage(file, acp, null, { chunkBytes: 141, targetTurns: 2 });
  const pages: string[] = [];
  for (let count = 0; count < 3; count++) {
    assert.equal(older.kind, 'page');
    pages.push(...older.page.turns.map((turn) => turn.promptId));
    const cursor = older.page.nextOlderCursor;
    if (count === 2) {
      assert.equal(cursor, null);
      break;
    }
    assert.ok(cursor);
    older = await readAgyHistoryPage(file, acp, cursor, { chunkBytes: 141, targetTurns: 2 });
  }
  assert.deepEqual(pages, ['agy:16', 'agy:20', 'agy:7', 'agy:11', 'agy:0', 'agy:2']);
  const corpus = read.turns.map((turn) => ({
    key: turn.promptId,
    sessionId: acp,
    sessionTitle: 'Fixture',
    agent: 'Antigravity',
    startedAt: turn.startedAt,
    prompt: searchablePrompt(turn),
    summary: searchableSummary(turn),
  }));
  assert.equal(searchTurns(corpus, 'find: first line', first.startedAt)[0]?.key, 'agy:2');
});

test('partial transcript writes do not create a turn and missing files refuse further pages', async () => {
  const brain = tempDir('agy-');
  try {
    const contents = fixture('interrupt-id');
    const file = saved(brain, interrupt, contents + '{"step_index":2,"type":"USER_INPUT"');
    assert.equal(readAgySession(file, interrupt).read!.turns.length, 1);
    const page = await readAgyHistoryPage(file, interrupt, null, { targetTurns: 1, chunkBytes: 64 });
    assert.equal(page.page?.turns[0].steps[0].status, 'interrupted');
    fs.unlinkSync(file);
    assert.equal((await readAgyHistoryPage(file, interrupt, null)).kind, 'missing');
  } finally {
    fs.rmSync(brain, { recursive: true, force: true });
  }
});

test('bounded discovery resumes and admits only sessions with independent workspace evidence', () => {
  const brain = tempDir('agy-');
  try {
    const root = 'C:/TEMP/agy-phase1';
    const roots = [root + '/worktree-a', root + '/worktree-b', root + '/project'];
    const modern = fixture('acp-id');
    const readOnly = modern.replaceAll('edit_file', 'read_file').replaceAll('write_file', 'read_file');
    const ambiguous = modern.replaceAll('worktree-a', 'worktree-b');
    const writeTarget = 'worktree-a';
    const crossRoot = modern.replace(writeTarget, 'worktree-b');
    saved(brain, acp, modern);
    saved(brain, plain, fixture('print-id-plain'));
    const terminalFile = saved(
      brain,
      terminal,
      fs.readFileSync(path.join(fixtures, 'terminal-id-transcript.jsonl'), 'utf8'),
      'transcript.jsonl',
    );
    const [terminalReply, terminalEdit] = readAgySession(terminalFile, terminal).read!.turns;
    assert.match(terminalReply.prompt, /^Reply with the single word OK/);
    assert.equal(terminalReply.summary, 'OK');
    assert.equal(terminalEdit.summary, 'OK');
    assert.equal(terminalEdit.files[0].edits[0].content, 'OK');
    assert.ok(terminalEdit.updates.some((update) => update.text.includes('Created file.')));
    saved(brain, interrupt, fixture('interrupt-id'));
    saved(brain, '00000000-0000-0000-0000-000000000001', crossRoot);
    saved(brain, '00000000-0000-0000-0000-000000000002', readOnly);
    saved(brain, '00000000-0000-0000-0000-000000000003', ambiguous);
    const scan = scanAgySessions(brain, roots, [{ brain, sessionId: interrupt, cwd: roots[0] }], {
      rows: 2,
      bytes: 125,
      platform: 'win32',
    });
    let batches = 0;
    let step = scan.next();
    while (!step.done && batches < 400) {
      assert.ok(step.value.rows <= 2 && step.value.bytes <= 125);
      batches++;
      step = scan.next();
    }
    assert.ok(step.done && batches > 10);
    const rows = step.value.rows;
    assert.deepEqual(
      rows.map((row) => row.sessionId).sort(),
      ['00000000-0000-0000-0000-000000000003', acp, terminal, interrupt].sort(),
    );
    assert.equal(rows.find((row) => row.sessionId === acp)?.cwd, undefined);
    assert.equal(rows.find((row) => row.sessionId === interrupt)?.cwd, roots[0]);
    const toolOnly = rows.find((row) => row.sessionId === acp)!;
    assert.equal(
      omitAgyCollisions(rows, [{ ...toolOnly, sessionId: acp.toUpperCase(), agent: 'codex' }]).some(
        (row) => row.sessionId === acp,
      ),
      false,
    );
    const read = boundedSessionRead(toolOnly, 2, () => 'scope', 'fixture', roots);
    assert.equal(read.state, 'current');
    assert.equal(read.provider, 'agy');
    assert.equal(read.turns[0].interrupted, true);
  } finally {
    fs.rmSync(brain, { recursive: true, force: true });
  }
});

test('discovery rechecks ownership when trusted Antigravity launch evidence changes', () => {
  const brain = tempDir('agy-');
  try {
    const root = path.join(brain, 'worktree');
    const file = saved(brain, plain, fixture('print-id-plain'));
    const launches = [{ brain, sessionId: plain, cwd: root }];
    const options = { cache: new Map(), rows: 1, bytes: 500 };
    const all = (identities: typeof launches) => {
      const scan = scanAgySessions(brain, [root], identities, options);
      let step = scan.next();
      while (!step.done) step = scan.next();
      return step.value.rows;
    };

    assert.deepEqual(
      all(launches).map((row) => row.file),
      [file],
    );
    assert.deepEqual(all([]), []);
  } finally {
    fs.rmSync(brain, { recursive: true, force: true });
  }
});

test('discovery skips a file that changes during a slice and revisits it at its completed revision', () => {
  const brain = tempDir('agy-');
  try {
    const root = 'C:/TEMP/agy-phase1';
    const roots = [root + '/worktree-a', root + '/project'];
    const contents = fixture('acp-id');
    const file = saved(brain, acp, contents);
    const options = { cache: new Map(), rows: 2, bytes: 150, platform: 'win32' as const };
    const scan = scanAgySessions(brain, roots, [], options);
    let step = scan.next();
    let changed = false;
    while (!step.done) {
      assert.ok(step.value.rows <= options.rows && step.value.bytes <= options.bytes);
      if (!changed && step.value.bytes > 0) {
        fs.appendFileSync(file, '{"step_index":22,"type":"USER_INPUT"');
        changed = true;
      }
      step = scan.next();
    }
    assert.ok(changed);
    assert.deepEqual(step.value.rows, []);
    assert.equal(step.value.complete, false);

    fs.appendFileSync(file, ',"created_at":"2026-11-22T05:01:00Z","status":"DONE","content":"Continue."}\n');
    fs.appendFileSync(
      file,
      JSON.stringify({
        step_index: 23,
        type: 'UNKNOWN_VENDOR_STEP',
        status: 'DONE',
        created_at: '2026-11-22T05:01:01Z',
        content: 'Recorded activity.',
      }) + '\n',
    );
    saved(brain, terminal, fixture('terminal-id'));
    // An oversized record uses several bounded slices and does not block later files.
    saved(brain, plain, 'x'.repeat(1024 * 1024 + 1) + '\n');
    const retry = scanAgySessions(brain, roots, [], { ...options, bytes: 128 * 1024 });
    step = retry.next();
    let slices = 0;
    while (!step.done && slices++ < 100) {
      assert.ok(step.value.rows <= options.rows && step.value.bytes <= 128 * 1024);
      step = retry.next();
    }
    assert.ok(step.done);
    assert.deepEqual(step.value.rows.map((row) => row.sessionId).sort(), [acp, terminal].sort());
    const admitted = step.value.rows.find((row) => row.sessionId === acp)!;
    assert.equal(admitted.size, fs.statSync(file).size);
    assert.equal(admitted.cwd, undefined);
    assert.equal(boundedSessionRead(admitted, 1, () => 'scope', 'fixture', roots).turns[0].prompt, 'Continue.');
    assert.equal(readAgySession(file, acp).read?.turns.at(-1)?.updates.at(-1)?.text, 'Recorded activity.');
  } finally {
    fs.rmSync(brain, { recursive: true, force: true });
  }
});

test('recorded Antigravity counts survive cost lookup while the project keeps its priced subtotal incomplete', () => {
  const brain = tempDir('agy-');
  try {
    const now = Date.parse('2026-11-22T12:00:00Z');
    const file = saved(brain, acp, fixture('acp-id'));
    const roots = { agyBrain: brain, projects: path.join(brain, 'claude'), codexSessions: path.join(brain, 'codex') };
    assert.equal(findSessionTranscript(acp, roots), file);
    assert.equal(findSessionTranscript(file, roots), file);
    const report = sessionCostReport(file, {
      roots,
      since: '2026-11-22T05:00:06Z',
      until: '2026-11-22T05:00:10Z',
    });
    assert.equal(report.combined.costUsd, null);
    assert.equal(report.combined.toolCalls, 1);
    assert.deepEqual(
      [report.combined.uncachedInputTokens, report.combined.cachedInputTokens, report.combined.outputTokens],
      [4450, 14487, 58],
    );
    const read = readAgySession(file, acp).read!;
    const stats = sessionStatFactsOf(read);
    const cache = path.join(brain, 'derived.json');
    vi.stubEnv('ARC_AGY_BRAIN_ROOT', brain);
    saveDerivedCache(
      cache,
      [
        [
          file,
          {
            label: 'Fixture',
            fullLabel: 'Fixture',
            foldedLabel: 'fixture',
            size: fs.statSync(file).size,
            mtimeMs: 1,
            activityMs: now,
            agentRun: false,
            outcome: null,
            stats,
          },
        ],
      ],
      [],
      [],
      fs.renameSync,
    );
    const restored = loadDerivedCache(cache);
    assert.equal(restored.titles.get(file)?.stats?.turns[1].usage.cacheRead, 14487);
    assert.equal(restored.titles.get(file)?.stats?.turns[1].agyUsage?.cacheRead, 14487);

    const existing = path.join(roots.projects, 'project', acp + '.jsonl');
    fs.mkdirSync(path.dirname(existing), { recursive: true });
    fs.writeFileSync(existing, '');
    assert.equal(findSessionTranscript(acp, roots), existing);
    assert.equal(findSessionTranscript(file, roots), file);

    const agy = indexSpendFile(undefined, file, brain, createAgyUsageReducer).record;
    assert.ok(agy.buckets.some((bucket) => bucket.incomplete));
    const other = {
      ...agy,
      file: path.join(brain, 'claude.jsonl'),
      parserKind: 'claude' as const,
      buckets: [
        {
          ...agy.buckets[0],
          agent: 'claude',
          incomplete: false,
          reportedCost: 4,
        },
      ],
    };
    const view = prepareProjectSpendView([other, agy], publicProjectSpendPrice, { now });
    const today = view.windows.find((window) => window.id === 'sevenDays')!;
    assert.equal(today.dollars, 4);
    assert.equal(today.partial, true);
    assert.equal(
      view.categories.find((category) => category.id === 'agy')?.windows.find((window) => window.id === 'sevenDays')
        ?.display,
      'Cost unavailable',
    );
  } finally {
    vi.unstubAllEnvs();
    fs.rmSync(brain, { recursive: true, force: true });
  }
});

test('cost reports keep recorded counts and omit missing categories in an older Antigravity transcript', () => {
  const brain = tempDir('agy-');
  try {
    const rows = fixture('print-id-plain').trimEnd().split('\n');
    const partial = JSON.parse(rows[1]);
    delete partial.input_tokens;
    delete partial.cache_read_tokens;
    const file = saved(brain, plain, [rows[0], JSON.stringify(partial), ''].join('\n'));
    const report = sessionCostReport(file, { byModel: true });
    assert.equal(report.combined.costUsd, null);
    assert.equal(report.combined.outputTokens, 1);
    assert.equal(report.combined.uncachedInputTokens, undefined);
    assert.equal(report.combined.cachedInputTokens, undefined);
    assert.equal(report.parent.modelCosts?.[0].outputTokens, 1);
    assert.equal(report.combined.modelCosts, undefined);
    assert.equal(report.rateNote, 'Antigravity did not report enough usage to estimate this cost.');
  } finally {
    fs.rmSync(brain, { recursive: true, force: true });
  }
});

test('Antigravity Activity counts repeated edit calls by name and preserves the saved diff lines', () => {
  const brain = tempDir('agy-');
  try {
    const diff = '[diff_block_start]\r\n@@ -1,2 +1,2 @@\r\n-old\r\n+new  \r\n \r\n[diff_block_end]';
    const final = '[diff_block_start]\n@@ -1 +1 @@\n-old\n+new \t\n[diff_block_end]';
    const contents =
      [
        { type: 'USER_INPUT', content: 'Edit both files.' },
        { type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'edit_file', args: { Path: 'first.txt' } }] },
        { type: 'GENERIC', content: diff },
        { type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'edit_file', args: { Path: 'second.txt' } }] },
        { type: 'GENERIC', content: final },
        { type: 'PLANNER_RESPONSE', content: 'Done.' },
      ]
        .map((row, step_index) =>
          JSON.stringify({ ...row, step_index, created_at: '2026-11-22T05:00:00Z', status: 'DONE' }),
        )
        .join('\n') + '\n';
    const file = saved(brain, plain, contents);
    const turn = readAgySession(file, plain).read!.turns[0];
    const card = toCard(turn, true, turn.endedAt);
    const checks = {
      edits: card.activityToolCategories.find(({ key }) => key === 'edits')?.count,
      namedEdits: card.toolTally.filter(({ category }) => category === 'edits'),
      hunks: turn.files.map((file) => file.edits[0].hunks[0].lines),
    };
    assert.deepEqual(checks, {
      edits: 2,
      namedEdits: [{ name: 'edit_file', count: 2, category: 'edits' }],
      hunks: [
        ['-old', '+new  ', ' '],
        ['-old', '+new \t'],
      ],
    });
  } finally {
    fs.rmSync(brain, { recursive: true, force: true });
  }
});

test('Antigravity ownership refuses an oversized record even when its newline starts a chunk', () => {
  const brain = tempDir('agy-');
  try {
    const root = 'C:/TEMP/agy-phase1/worktree-a';
    saved(brain, acp, 'x'.repeat(9 * AGY_DISCOVERY_BYTES) + '\n' + fixture('acp-id'));
    const scan = scanAgySessions(brain, [root], [], { platform: 'win32' });
    let step = scan.next();
    while (!step.done) step = scan.next();
    assert.deepEqual(step.value.rows, []);
  } finally {
    fs.rmSync(brain, { recursive: true, force: true });
  }
});

test('Antigravity ownership reads only a bounded prefix check and the new bytes after an append', () => {
  const brain = tempDir('agy-');
  try {
    const roots = ['C:/TEMP/agy-phase1/worktree-a', 'C:/TEMP/agy-phase1/worktree-b'];
    const line = JSON.stringify({
      type: 'SYSTEM_MESSAGE',
      step_index: 30,
      created_at: '2026-11-22T05:00:30Z',
      status: 'DONE',
      content: 'x'.repeat(1024),
    });
    const file = saved(brain, acp, fixture('acp-id') + (line + '\n').repeat(2048));
    const options = { platform: 'win32' as const, bytes: 16 * 1024, passBytes: 1024 * 1024, cache: new Map() };
    const pass = () => {
      const window = openReadWindow();
      const scan = scanAgySessions(brain, roots, [], options);
      let step = scan.next();
      while (!step.done) {
        assert.ok(step.value.bytes <= options.bytes);
        step = scan.next();
      }
      const { bytes } = closeReadWindow(window);
      assert.ok(bytes <= options.passBytes);
      return { bytes, ...step.value };
    };
    const initial = pass();
    assert.equal(initial.complete, false);
    assert.deepEqual(initial.rows, []);
    assert.equal(initial.bytes, options.passBytes);
    assert.equal(pass().complete, false);
    const admitted = pass();
    assert.equal(admitted.complete, true);
    assert.equal(admitted.rows[0]?.file, file);
    const append =
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        step_index: 31,
        created_at: '2026-11-22T05:00:31Z',
        status: 'DONE',
        tool_calls: [{ name: 'run_command', args: { Cwd: roots[1] } }],
      }) + '\n';
    fs.appendFileSync(file, append);
    const next = pass();
    assert.deepEqual(next.rows, []);
    assert.ok(next.bytes <= 2 * options.bytes, 'an append reread the existing transcript');
  } finally {
    fs.rmSync(brain, { recursive: true, force: true });
  }
});

test.each([
  ['recorded zero', { input_tokens: 0, output_tokens: 1 }, 'Input tokens 0\nOutput tokens 1'],
  ['no usable counts', {}, 'Token usage unavailable'],
])('Antigravity Session list cost detail handles %s', (_case, counts, usageDetail) => {
  const brain = tempDir('agy-');
  try {
    const rows = fixture('print-id-plain').trimEnd().split('\n');
    const reply = JSON.parse(rows[1]);
    delete reply.input_tokens;
    delete reply.cache_read_tokens;
    delete reply.output_tokens;
    const file = saved(brain, plain, [rows[0], JSON.stringify({ ...reply, ...counts }), ''].join('\n'));
    const read = readAgySession(file, plain).read!;
    const window = sessionStatsFromFacts(sessionStatFactsOf(read)).find((chip) => chip.metric === 'cost');
    const indexed = indexSpendFile(undefined, file, brain, createAgyUsageReducer).record;
    const storage = path.join(brain, 'ledger');
    saveSpendLedger(storage, brain, [indexed]);
    const restored = loadSpendLedger(storage, brain).files[0];
    const lifetime = sessionCostStats(restored.lifetimeBuckets ?? []).find((chip) => chip.metric === 'cost');
    const expected = usageDetail + '\nAntigravity did not report enough usage to estimate this cost.';
    assert.deepEqual([window?.detail, lifetime?.detail], [expected, expected]);
  } finally {
    fs.rmSync(brain, { recursive: true, force: true });
  }
});
