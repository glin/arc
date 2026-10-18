import { test } from 'vitest';
import assert from 'node:assert';
import * as fs from 'node:fs';
import { tempDir } from './temproot.ts';
import * as path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import {
  createCommitRepositoryCursor,
  scanCommitRepositorySource,
  COMMIT_REPOSITORY_RECORD_BYTES,
  COMMIT_REPOSITORY_FACT_LIMIT,
} from './codexhistory.ts';
import { worktreeCreationCommand } from './turnfixtures.ts';

import {
  SessionHistory,
  HISTORY_BUDGET_MAX_MIB,
  HISTORY_BUDGET_MIN_MIB,
  HISTORY_EMPTY_RUN_LIMIT,
  HISTORY_PAGE_READ_CEILING,
  HISTORY_PAGE_TURNS,
  HistoryPageOutcome,
  admitHistoryRecords,
  afterHistoryPage,
  afterHistoryRequest,
  historyAfterRevision,
  historyBudgetBytes,
  historyBytes,
  historyEvictions,
  historyPageBytes,
  historyPageReads,
  historyRecordKeys,
  historyRecordsOutside,
  historyRequestContinues,
  historyStateAfterRevision,
  retainDisplacedWindow,
  olderHistoryControl,
  olderHistoryPossible,
  restartHistoryCoverage,
  staleCursorIsStuck,
  startSessionHistory,
} from './historypages.ts';
import { ClaudeHistoryCursor, readClaudeHistoryPageAsync } from './claudehistory.ts';
import { CodexHistoryCursor, readCodexHistoryPageAsync } from './codexhistory.ts';
import { readCodexSession } from './codex.ts';
import { Compaction, Turn, readSession, revisionOf } from './transcript.ts';
import { compaction, turn } from './turnfixtures.ts';
import { turnKey } from './turnread.ts';
import { EXPORT_LIMITS, ExportLimitError } from './exportlimits.ts';
import { readSemanticHistoryPageAsync, type SemanticSourceAdapter, type SemanticHistoryResult } from './history.ts';

type HistoryCursor = ClaudeHistoryCursor | CodexHistoryCursor;

// These captures catch lost recorded text and source admission before reducer accumulation.
for (const agent of ['claude', 'codex'] as const) {
  const captureRecords = (finished: boolean, asks = 13, identity = 'first'): string[] => {
    let sequence = 0;
    const at = () => new Date(Date.UTC(2026, 8, 29, 12, 0, sequence++)).toISOString();
    const record = (type: string, data: object) => JSON.stringify({ type, timestamp: at(), ...data });
    const opening = agent === 'codex' ? [record('session_meta', { payload: { id: 'capture', cwd: '/project' } })] : [];
    const start =
      agent === 'claude'
        ? [record('user', { promptId: identity, message: { role: 'user', content: 'opening prompt' } })]
        : [
            record('event_msg', { payload: { type: 'task_started', turn_id: identity } }),
            record('response_item', {
              payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'opening prompt' }] },
            }),
          ];
    const followups = Array.from({ length: asks }, (_item, index) =>
      agent === 'claude'
        ? record('attachment', {
            attachment: { type: 'queued_command', commandMode: 'prompt', prompt: `submission ${index}` },
          })
        : record('response_item', {
            payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `submission ${index}` }] },
          }),
    );
    const body = 'commentary '.repeat(1000);
    const commentary =
      agent === 'claude'
        ? record('assistant', {
            uuid: `${identity}-commentary`,
            message: {
              id: 'commentary',
              role: 'assistant',
              stop_reason: 'tool_use',
              content: [{ type: 'text', text: body }],
            },
          })
        : record('response_item', {
            payload: {
              type: 'message',
              id: 'commentary',
              role: 'assistant',
              phase: 'commentary',
              content: [{ type: 'output_text', text: body }],
            },
          });
    const answer =
      agent === 'claude'
        ? record('assistant', {
            uuid: `${identity}-answer`,
            message: {
              id: 'answer',
              role: 'assistant',
              stop_reason: finished ? 'end_turn' : undefined,
              content: [{ type: 'text', text: 'recorded answer' }],
            },
          })
        : record('response_item', {
            payload: {
              type: 'message',
              id: 'answer',
              role: 'assistant',
              phase: 'final_answer',
              content: [{ type: 'output_text', text: 'recorded answer' }],
            },
          });
    const end =
      finished && agent === 'codex'
        ? [record('event_msg', { payload: { type: 'task_complete', turn_id: identity } })]
        : [];
    return [...opening, ...start, ...followups, commentary, answer, ...end];
  };

  test(`${agent} capture retains thirteen submissions and full commentary on an unfinished first turn`, async () => {
    const file = path.join(tempDir('capture-unfinished-'), 'capture.jsonl');
    fs.writeFileSync(file, captureRecords(false).join('\n') + '\n');
    const options = { targetTurns: 1, chunkBytes: 127, exportLimits: EXPORT_LIMITS };
    const result: SemanticHistoryResult =
      agent === 'claude'
        ? await readClaudeHistoryPageAsync(file, 'capture', null, options)
        : await readCodexHistoryPageAsync(file, 'capture', null, options);
    assert.equal(result.kind, 'page');
    if (result.kind !== 'page') return;
    const unfinished = result.page.unfinished;
    assert.ok(unfinished, 'the first unfinished turn has no recorded body');
    assert.equal(unfinished.turn.finished, false);
    assert.equal(unfinished.turn.prompt, 'opening prompt');
    assert.deepEqual(
      unfinished.turn.laterPrompts.map((ask) => ask.text),
      Array.from({ length: 13 }, (_item, index) => `submission ${index}`),
    );
    assert.equal(
      unfinished.turn.updates.find((update) => update.kind === 'commentary')?.text,
      'commentary '.repeat(1000),
    );
    assert.ok(
      [unfinished.turn.summary, ...unfinished.turn.answers.map((answer) => answer.text)].includes('recorded answer'),
    );
    assert.equal(result.page.turns.length, 0);
    assert.equal(result.page.nextOlderCursor, null);
  });

  test(`${agent} capture admits bounded records and rejects oversized records and indivisible turns`, async () => {
    const file = path.join(tempDir('capture-limits-'), 'capture.jsonl');
    fs.writeFileSync(file, captureRecords(true, 0).join('\n') + '\n');
    const read = (
      limits: typeof EXPORT_LIMITS | { sliceBytes: number; recordBytes: number; turnBytes: number; pageBytes: number },
    ) =>
      agent === 'claude'
        ? readClaudeHistoryPageAsync(file, 'capture', null, { targetTurns: 1, exportLimits: limits })
        : readCodexHistoryPageAsync(file, 'capture', null, { targetTurns: 1, exportLimits: limits });
    assert.equal((await read(EXPORT_LIMITS)).kind, 'page');
    await assert.rejects(
      read({ ...EXPORT_LIMITS, recordBytes: 1024 }),
      (error) => error instanceof ExportLimitError && error.boundary === 'record',
    );
    await assert.rejects(
      read({ ...EXPORT_LIMITS, turnBytes: 1024 }),
      (error) => error instanceof ExportLimitError && error.boundary === 'turn',
    );
    await assert.rejects(
      read({ ...EXPORT_LIMITS, pageBytes: 1024 }),
      (error) => error instanceof ExportLimitError && error.boundary === 'page',
    );
  });

  test(`${agent} capture pages every completed turn and returns its unfinished body once at equal timestamps`, async () => {
    const file = path.join(tempDir('capture-pages-'), 'capture.jsonl');
    const records = [
      captureRecords(true, 13, 'first'),
      captureRecords(true, 13, 'second'),
      captureRecords(false, 13, 'third'),
    ].flatMap((rows, index) => (agent === 'codex' && index > 0 ? rows.slice(1) : rows));
    fs.writeFileSync(file, records.join('\n') + '\n');
    let cursor: HistoryCursor | null = null;
    const completed: string[] = [];
    const unfinished: string[] = [];
    do {
      const options = { exportLimits: EXPORT_LIMITS, chunkBytes: 4096 };
      const result:
        | Awaited<ReturnType<typeof readClaudeHistoryPageAsync>>
        | Awaited<ReturnType<typeof readCodexHistoryPageAsync>> =
        agent === 'claude'
          ? await readClaudeHistoryPageAsync(file, 'capture', cursor as ClaudeHistoryCursor | null, options)
          : await readCodexHistoryPageAsync(file, 'capture', cursor as CodexHistoryCursor | null, options);
      assert.equal(result.kind, 'page');
      if (result.kind !== 'page') break;
      assert.ok(result.page.turns.length <= 1);
      completed.push(...result.page.turns.map((turn) => turn.promptId));
      if (result.page.unfinished) unfinished.push(result.page.unfinished.turn.promptId);
      for (const turn of [...result.page.turns, ...(result.page.unfinished ? [result.page.unfinished.turn] : [])]) {
        assert.equal(turn.laterPrompts.length, 13);
        assert.ok((turn.laterPrompts[0].sourceOrder ?? Infinity) < (turn.updates[0].sourceOrder ?? 0));
      }
      cursor = result.page.nextOlderCursor;
    } while (cursor);
    assert.deepEqual(completed, ['second', 'first']);
    assert.deepEqual(unfinished, ['third']);
  });

  test(`${agent} capture accounts omitted records in the raw turn limit`, async () => {
    const file = path.join(tempDir('capture-omitted-bytes-'), 'capture.jsonl');
    fs.writeFileSync(
      file,
      captureRecords(true, 0).join('\n') +
        '\n' +
        JSON.stringify({ type: 'ignored', payload: 'x'.repeat(16000) }) +
        '\n',
    );
    const options = { exportLimits: { ...EXPORT_LIMITS, turnBytes: 20000 } };
    await assert.rejects(
      agent === 'claude'
        ? readClaudeHistoryPageAsync(file, 'capture', null, options)
        : readCodexHistoryPageAsync(file, 'capture', null, options),
      (error) => error instanceof ExportLimitError && error.boundary === 'turn',
    );
  });
}

test('capture rejects an oversized held page before calling the semantic parser', async () => {
  const file = path.join(tempDir('capture-page-admission-'), 'capture.jsonl');
  fs.writeFileSync(
    file,
    Array.from({ length: 8 }, () => JSON.stringify({ type: 'ignored', payload: 'x'.repeat(100) })).join('\n') + '\n',
  );
  let parsed = 0;
  const adapter: SemanticSourceAdapter<null> = {
    source: 'claude',
    initialState: () => null,
    accepts: () => true,
    parse() {
      parsed++;
      return { turns: [], compactions: [], openRange: null, adapterState: null };
    },
  };
  await assert.rejects(
    readSemanticHistoryPageAsync(file, 'capture', adapter, null, {
      exportLimits: { ...EXPORT_LIMITS, pageBytes: 128 },
    }),
    (error) => error instanceof ExportLimitError && error.boundary === 'page',
  );
  assert.equal(parsed, 0);
});

test('Claude capture retains every unfinished assistant text block before a closing answer', async () => {
  const file = path.join(tempDir('capture-text-blocks-'), 'capture.jsonl');
  const record = (type: string, message: object) =>
    JSON.stringify({ type, timestamp: '2026-09-29T12:00:00Z', promptId: 'same-clock', message });
  fs.writeFileSync(
    file,
    [
      record('user', { role: 'user', content: 'question' }),
      record('assistant', {
        role: 'assistant',
        content: [
          { type: 'text', text: 'first text' },
          { type: 'text', text: 'second text' },
        ],
      }),
      record('assistant', {
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [
          { type: 'text', text: 'first answer' },
          { type: 'text', text: 'second answer' },
        ],
      }),
    ].join('\n') + '\n',
  );
  const result = await readClaudeHistoryPageAsync(file, 'capture', null, { exportLimits: EXPORT_LIMITS });
  assert.equal(result.kind, 'page');
  if (result.kind !== 'page') return;
  assert.deepEqual(
    result.page.turns[0].recordedAnswers?.map((answer) => answer.text),
    ['first text', 'second text', 'first answer', 'second answer'],
  );
  assert.deepEqual(
    result.page.turns[0].answers.map((answer) => answer.text),
    ['first answer', 'second answer'],
  );
});

// Request records hold the whole request body, so a filtered page keeps only their id and send time.
test('filtered Claude history pages time responses from compact request records', async () => {
  const file = path.join(tempDir('request-timing-'), 'session.jsonl');
  const at = (second: number) => new Date(Date.UTC(2026, 0, 2, 0, 0, second)).toISOString();
  const body = { system: 'x'.repeat(20 * 1024) };
  const request = (id: string, second: number) =>
    JSON.stringify({ type: 'api-request', sessionId: 'timed', id, timestamp: at(second), params: body });
  const prompt = (promptId: string, second: number) =>
    JSON.stringify({ type: 'user', promptId, timestamp: at(second), message: { role: 'user', content: promptId } });
  const answer = (id: string, requestRef: string, second: number, output: number) =>
    JSON.stringify({
      type: 'assistant',
      requestRef,
      timestamp: at(second),
      message: {
        role: 'assistant',
        id,
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: `answer ${id}` }],
        usage: { input_tokens: 10, output_tokens: output },
      },
    });
  fs.writeFileSync(
    file,
    [
      prompt('older', 0),
      ...Array.from({ length: 200 }, (_, index) => request(`older-${index}`, 2)),
      answer('m-older', 'older-199', 6, 200),
      prompt('newest', 10),
      request('newest', 11),
      answer('m-newest', 'newest', 13, 300),
    ].join('\n') + '\n',
  );
  const options = { targetTurns: 1, chunkBytes: 64 * 1024 };
  const first = await readClaudeHistoryPageAsync(file, 'timed', null, options);
  assert.equal(first.kind, 'page');
  if (first.kind !== 'page') return;
  assert.deepEqual(
    first.page.turns.map((turn) => turn.outputRate),
    [{ output: 300, milliseconds: 2000 }],
  );
  assert.equal(first.page.turns[0].outputRateBasis, 'request');
  const cursor = first.page.nextOlderCursor;
  assert.ok(cursor);
  const heldText = cursor.heldRecords.reduce((total, record) => total + record.text.length, 0);
  assert.ok(heldText < 256 * 1024, `the page held ${heldText} characters of request text`);
  const older = await readClaudeHistoryPageAsync(file, 'timed', cursor, options);
  assert.equal(older.kind, 'page');
  if (older.kind !== 'page') return;
  assert.deepEqual(
    older.page.turns.map((turn) => turn.outputRate),
    [{ output: 200, milliseconds: 4000 }],
  );
});

test('commit ownership quanta count every range read and preserve split UTF-8 and ownership records', async () => {
  const directory = tempDir('commit-ownership-quanta-');
  const file = path.join(directory, 'parent.jsonl');
  const record = (type: string, payload: object) =>
    JSON.stringify({ type, timestamp: '2026-08-25T12:00:00Z', payload }) + '\n';
  fs.writeFileSync(
    file,
    record('session_meta', { id: 'parent' }) +
      record('event_msg', { type: 'task_started', turn_id: 'turn' }) +
      record('turn_context', { turn_id: 'turn', current_date: '2026-08-25' }) +
      record('ignored', { text: '🙂'.repeat(400_000) }) +
      record('event_msg', {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          command: ['powershell.exe', '-Command', worktreeCreationCommand(['C:/first'])],
          parsed_cmd: [{ cmd: worktreeCreationCommand(['C:/first']) }],
          cwd: 'file:///C:/outer',
          stdout: '',
          status: 'completed',
          exit_code: 0,
          started_at_ms: 1,
          completed_at_ms: 2,
        },
      }),
  );
  const { size, mtimeMs, dev, ino } = revisionOf(fs.statSync(file, { bigint: true }));
  const cursor = createCommitRepositoryCursor(
    { file, sessionId: 'parent', revision: { size, mtimeMs, dev, ino } },
    null,
  );
  const rawFs = createRequire(__filename)('node:fs') as typeof fs;
  const originalRead = rawFs.readSync;
  let observed = 0;
  rawFs.readSync = ((...args: unknown[]) => {
    const read = Reflect.apply(originalRead, rawFs, args);
    observed += read;
    return read;
  }) as typeof fs.readSync;
  syncBuiltinESMExports();
  try {
    let requests = 0;
    for (; requests < 32; requests++) {
      observed = 0;
      const result = await scanCommitRepositorySource(cursor, 64 * 1024 + 1, undefined, () => 0);
      assert.equal(result.readBytes, observed, 'opening or boundary reads were omitted');
      assert.ok(observed <= 64 * 1024 + 1, 'a request exceeded its reserved allowance');
      if (result.status !== 'pending') {
        assert.equal(result.status, 'complete');
        break;
      }
    }
    assert.ok(requests > 1, 'the long parent turn did not require continuation');
    assert.equal(cursor.facts[0].relationships[0].repository, 'C:/first');
    assert.equal(cursor.through, size);
    let clock = 0;
    const timed = createCommitRepositoryCursor(cursor.source, null);
    const quantum = await scanCommitRepositorySource(timed, 1024 * 1024, undefined, () => (clock += 20));
    assert.equal(quantum.status, 'pending');
    assert.ok(timed.through < size);
  } finally {
    rawFs.readSync = originalRead;
    syncBuiltinESMExports();
  }
});

test('a processing deadline at the final record preserves resumable ownership coverage', async () => {
  const file = path.join(tempDir('commit-ownership-eof-'), 'parent.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: 'parent' } }) + '\n');
  const { size, mtimeMs, dev, ino } = revisionOf(fs.statSync(file, { bigint: true }));
  const cursor = createCommitRepositoryCursor(
    { file, sessionId: 'parent', revision: { size, mtimeMs, dev, ino } },
    null,
  );
  let clock = 0;
  const first = await scanCommitRepositorySource(cursor, 1024, undefined, () => (clock += 20));
  assert.notEqual(first.status, 'exhausted');
  const final = await scanCommitRepositorySource(cursor, 1024, undefined, () => 0);
  assert.equal(final.status, 'complete');
  assert.equal(cursor.through, size);
});

test('a resumed ownership cursor whose allowance cannot fund its head check ends exhausted', async () => {
  const file = path.join(tempDir('commit-ownership-unfunded-'), 'parent.jsonl');
  fs.writeFileSync(
    file,
    Array.from({ length: 8 }, () => JSON.stringify({ type: 'ignored', payload: 'x'.repeat(64) }) + '\n').join(''),
  );
  const { size, mtimeMs, dev, ino } = revisionOf(fs.statSync(file, { bigint: true }));
  const cursor = createCommitRepositoryCursor(
    { file, sessionId: 'parent', revision: { size, mtimeMs, dev, ino } },
    null,
  );
  const first = await scanCommitRepositorySource(cursor, 128, undefined, () => 0);
  assert.equal(first.status, 'pending');
  assert.ok(cursor.offset > 0 && cursor.head.length > 1);
  const unfunded = await scanCommitRepositorySource(cursor, cursor.head.length - 1, undefined, () => 0);
  assert.deepEqual(unfunded, { status: 'exhausted', readBytes: 0 });
});

test('commit ownership record exhaustion and cancellation provide no complete coverage', async () => {
  const file = path.join(tempDir('commit-ownership-limit-'), 'parent.jsonl');
  fs.writeFileSync(
    file,
    JSON.stringify({ type: 'session_meta', payload: { id: 'parent' } }) +
      '\n' +
      JSON.stringify({ type: 'ignored', payload: 'x'.repeat(COMMIT_REPOSITORY_RECORD_BYTES) }) +
      '\n',
  );
  const { size, mtimeMs, dev, ino } = revisionOf(fs.statSync(file, { bigint: true }));
  const source = { file, sessionId: 'parent', revision: { size, mtimeMs, dev, ino } };
  const cursor = createCommitRepositoryCursor(source, null);
  let outcome;
  for (let request = 0; request < 16; request++) {
    outcome = await scanCommitRepositorySource(cursor, 1024 * 1024, undefined, () => 0);
    assert.ok(cursor.fragment.length <= COMMIT_REPOSITORY_RECORD_BYTES);
    if (outcome.status !== 'pending') break;
  }
  assert.equal(outcome?.status, 'exhausted');
  assert.equal(cursor.complete, false);
  const controller = new AbortController();
  controller.abort();
  const cancelled = await scanCommitRepositorySource(
    createCommitRepositoryCursor(source, null),
    1024 * 1024,
    controller.signal,
  );
  assert.equal(cancelled.status, 'cancelled');
  const operation = JSON.stringify({
    type: 'event_msg',
    timestamp: '2026-08-25T12:00:01Z',
    payload: { type: 'patch_apply_end', success: true, changes: { 'C:/first/.git': { type: 'update' } } },
  });
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: 'session_meta', payload: { id: 'parent' } }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-08-25T12:00:00Z',
        payload: { type: 'task_started', turn_id: 'turn' },
      }),
      JSON.stringify({
        type: 'turn_context',
        timestamp: '2026-08-25T12:00:00Z',
        payload: { turn_id: 'turn', current_date: '2026-08-25' },
      }),
      ...Array.from({ length: COMMIT_REPOSITORY_FACT_LIMIT + 1 }, () => operation),
      '',
    ].join('\n'),
  );
  const revision = revisionOf(fs.statSync(file, { bigint: true }));
  const operations = createCommitRepositoryCursor(
    { ...source, revision: { size: revision.size, mtimeMs: revision.mtimeMs, dev: revision.dev, ino: revision.ino } },
    null,
  );
  const capped = await scanCommitRepositorySource(operations, 1024 * 1024, undefined, () => 0);
  assert.equal(capped.status, 'exhausted');
  assert.equal(operations.complete, false);
  assert.equal(operations.facts.length, COMMIT_REPOSITORY_FACT_LIMIT);
});

const at = (minute: number) => new Date(2026, 7, 23, 14, minute).getTime();

const page = (starts: number[], compactions: number[] = []) => ({
  turns: starts.map((minute) => turn({ startedAt: at(minute) })),
  compactions: compactions.map((minute) => compaction({ at: at(minute) })),
});

function held<Cursor = string>(over: Partial<SessionHistory<Cursor>> = {}): SessionHistory<Cursor> {
  return { ...startSessionHistory<Cursor>({ sessionId: 'sess', size: 900, mtimeMs: 5 }, 100), ...over };
}

test('older history is offered while the tail misses bytes or lost a turn to the limit', () => {
  assert.equal(
    olderHistoryPossible({ size: 900, readBytes: 400, turnLimitReached: false }),
    true,
    'a tail short of the file offers nothing to load',
  );
  assert.equal(
    olderHistoryPossible({ size: 400, readBytes: 400, turnLimitReached: true }),
    true,
    'a whole file whose parser cut older turns offers nothing to load',
  );
  assert.equal(
    olderHistoryPossible({ size: 400, readBytes: 400, turnLimitReached: false }),
    false,
    'a session with nothing left to read still offers a request',
  );
  assert.equal(
    olderHistoryPossible({ size: 400, readBytes: 900, turnLimitReached: false }),
    false,
    'a retained tail wider than the file offers a request that cannot add a turn',
  );
});

test('a page adds each turn once, whatever the tail and the earlier pages already hold', () => {
  const admitted = admitHistoryRecords([turnKey({ sessionId: 'sess', startedAt: at(30) })], page([20, 30, 40], [25]));
  assert.deepEqual(
    admitted.turns.map((t) => t.startedAt),
    [at(20), at(40)],
    'a turn the tail already lists is drawn twice',
  );
  assert.equal(admitted.compactions.length, 1, 'a new compaction is dropped with the duplicate turns');

  const again = admitHistoryRecords(['sess:compact:' + at(25)], page([20], [25]));
  assert.equal(again.compactions.length, 0, 'a compaction on a page boundary is drawn twice');
});

test('retained pages give the list everything the ordinary tail does not already list', () => {
  const pages = [
    { ...page([40, 50], [45]), bytes: 10 },
    { ...page([20, 30]), bytes: 10 },
    { ...page([20, 10]), bytes: 10 },
  ];
  const outside = historyRecordsOutside(pages, page([50, 60], [45]));
  assert.deepEqual(
    outside.turns.map((t) => t.startedAt),
    [at(40), at(20), at(30), at(10)],
    'loading three pages does not add each turn exactly once',
  );
  assert.equal(outside.compactions.length, 0, 'a compaction already in the tail is listed twice');
  assert.deepEqual(historyRecordKeys(pages).length, 7, 'the retained identities are not all counted');
});

test('retaining displaced turns respects the recent limit and keeps explicit older pages', () => {
  const older = turn({ startedAt: at(10), summary: 'Older response' });
  const middle = turn({ startedAt: at(20), summary: 'Middle response' });
  const recent = turn({ startedAt: at(30), summary: 'Recent response' });
  const prior = turn({ startedAt: at(40), summary: 'Prior response' });
  const current = turn({ startedAt: at(50), summary: 'Current response' });
  const explicit = { turns: [older], compactions: [], bytes: historyPageBytes({ turns: [older], compactions: [] }) };
  const retained = retainDisplacedWindow(
    held({ pages: [explicit] }),
    { turns: [older, middle, recent, prior], compactions: [] },
    { turns: [current], compactions: [] },
    3,
    Number.MAX_SAFE_INTEGER,
    200,
  );
  assert.equal(retained.pages[0], explicit, 'an accepted window replaced an explicitly loaded page');
  assert.deepEqual(
    [current, ...historyRecordsOutside(retained.pages, { turns: [current], compactions: [] }).turns]
      .map((record) => record.summary)
      .sort(),
    ['Current response', 'Older response', 'Prior response', 'Recent response'],
    'the recent limit or deduplication changed the visible turns',
  );
  const bytesForOne = historyPageBytes({ turns: [prior], compactions: [] });
  const bounded = retainDisplacedWindow(
    held(),
    { turns: [middle, recent, prior], compactions: [] },
    { turns: [current], compactions: [] },
    3,
    bytesForOne,
    200,
  );
  assert.deepEqual(
    bounded.pages[0].turns.map((record) => record.summary),
    ['Prior response'],
    'the recent page exceeded the selected cache budget',
  );
});

test('a page that adds nothing still moves the cursor on', () => {
  const first = afterHistoryPage(
    held(),
    {
      kind: 'page',
      ...page([50, 60]),
      cursor: 'older',
      ownedRange: { start: 500, end: 900 },
      openRange: null,
    },
    page([50, 60]),
    200,
  );
  assert.equal(first.added, 0, 'a page inside the tail is counted as progress');
  assert.deepEqual(first.history.pages, [], 'a page with nothing new is retained and charged for');
  assert.equal(
    first.history.cursor,
    'older',
    'the cursor stays put, so the next request reads the same bytes for ever',
  );
  assert.equal(
    first.history.emptyRuns,
    0,
    'a read inside a request counts as an empty request, so a long walk back stops the sentinel asking',
  );
  assert.equal(first.history.requests, 1, 'the request is not counted, so the panel cannot tell it happened');

  const second = afterHistoryPage(
    first.history,
    {
      kind: 'page',
      ...page([30, 40]),
      cursor: null,
      ownedRange: { start: 0, end: 500 },
      openRange: { start: 500, end: 700 },
    },
    page([50, 60]),
    300,
  );
  assert.equal(second.added, 2, 'the older page is not admitted');
  assert.equal(second.history.atBeginning, true, 'a null cursor is not read as the beginning of the file');
  assert.deepEqual(
    second.history.coverage,
    {
      ownedRange: { start: 0, end: 500 },
      openRange: { start: 500, end: 700 },
      tailTurnKeys: page([50, 60]).turns.map(turnKey),
    },
    'the completed prefix keeps no evidence that a later append can validate',
  );
  assert.ok(second.history.pages[0].bytes > 0, 'an admitted page is charged nothing against the budget');
});

test('completed coverage keeps dependencies from every page in the scan', () => {
  const firstTail = page([30, 40]);
  const skipped = afterHistoryPage(
    held(),
    {
      kind: 'page',
      ...page([30, 40]),
      cursor: 'older',
      ownedRange: { start: 400, end: 900 },
      openRange: null,
    },
    firstTail,
    200,
  );
  assert.deepEqual(
    skipped.history.scanTailTurnKeys,
    firstTail.turns.map(turnKey),
    'an intermediate page forgets the tail turns that let it advance',
  );

  const rotatedTail = page([40, 50]);
  const revision = { sessionId: 'sess', size: 1200, mtimeMs: 6 };
  assert.equal(
    historyAfterRevision(skipped.history, revision, true, rotatedTail),
    'restart',
    'an append keeps scanning after an intermediate dependency leaves the tail',
  );
  const restarted = restartHistoryCoverage(skipped.history, revision, 250);
  const incomplete = afterHistoryPage(
    skipped.history,
    {
      kind: 'page',
      ...page([10, 20]),
      cursor: null,
      ownedRange: { start: 0, end: 400 },
      openRange: null,
    },
    rotatedTail,
    300,
  );
  assert.equal(
    incomplete.history.atBeginning,
    false,
    'the final page certifies complete coverage after an earlier dependency left the tail',
  );
  assert.equal(incomplete.history.coverage, null, 'invalid coverage stays available for a later append to accept');

  const recovered = afterHistoryPage(
    restarted,
    {
      kind: 'page',
      ...page([30, 40, 50]),
      cursor: 'older',
      ownedRange: { start: 400, end: 1200 },
      openRange: null,
    },
    rotatedTail,
    400,
  );
  const completed = afterHistoryPage(
    recovered.history,
    {
      kind: 'page',
      ...page([10, 20]),
      cursor: null,
      ownedRange: { start: 0, end: 400 },
      openRange: null,
    },
    rotatedTail,
    500,
  );
  const visible = [...rotatedTail.turns, ...historyRecordsOutside(completed.history.pages, rotatedTail).turns].map(
    turnKey,
  );
  assert.equal(completed.history.atBeginning, true, 'the recovery scan does not certify the rebuilt prefix');
  assert.deepEqual(
    new Set(visible),
    new Set(page([10, 20, 30, 40, 50]).turns.map(turnKey)),
    'the turn that left the tail remains missing after the recovery scan',
  );
});

test('a completed first turn returns after it leaves the ordinary tail', () => {
  const openFirst = turn({ startedAt: at(10), finished: false });
  const completedFirst = { ...openFirst, finished: true };
  const activeSecond = turn({ startedAt: at(20), finished: false });
  const firstTail = { turns: [openFirst], compactions: [] };
  const initial = afterHistoryPage(
    held<HistoryCursor>(),
    {
      kind: 'page',
      turns: [],
      compactions: [],
      cursor: null,
      ownedRange: { start: 0, end: 400 },
      openRange: { start: 400, end: 700 },
    },
    firstTail,
    200,
  ).history;
  assert.equal(initial.atBeginning, true, 'the empty page did not preserve the open first turn as tail-owned coverage');

  const completedTail = { turns: [completedFirst, activeSecond], compactions: [] };
  const completedRevision = { sessionId: 'sess', size: 1200, mtimeMs: 6 };
  const completed = historyStateAfterRevision(initial, completedRevision, true, completedTail, 250);
  assert.ok(completed, 'completing the first turn drops history while the tail still covers it');
  assert.equal(
    completed.atBeginning,
    true,
    'completing the first turn restarts history while the tail still covers it',
  );

  const secondOnlyTail = { turns: [activeSecond], compactions: [] };
  const rotatedRevision = { sessionId: 'sess', size: 1500, mtimeMs: 7 };
  let rotated = historyStateAfterRevision(completed, rotatedRevision, true, secondOnlyTail, 300);
  assert.ok(rotated, 'the selected append drops retained history when coverage becomes incomplete');
  if (!rotated.atBeginning) {
    rotated = afterHistoryPage(
      rotated,
      {
        kind: 'page',
        turns: [completedFirst],
        compactions: [],
        cursor: null,
        ownedRange: { start: 0, end: 1200 },
        openRange: { start: 1200, end: 1500 },
      },
      secondOnlyTail,
      400,
    ).history;
  }

  const visibleKeys = [...secondOnlyTail.turns, ...historyRecordsOutside(rotated.pages, secondOnlyTail).turns].map(
    turnKey,
  );
  assert.deepEqual(
    new Set(visibleKeys),
    new Set([turnKey(completedFirst), turnKey(activeSecond)]),
    'the completed first turn disappeared after it left the ordinary tail',
  );
  assert.equal(visibleKeys.length, 2, 'the recovered first turn duplicates a turn already in the tail');
  const control = olderHistoryControl({
    sessionId: 'sess',
    possible: true,
    paged: true,
    atBeginning: rotated.atBeginning,
    busy: false,
    failed: false,
    emptyRuns: 0,
    requests: rotated.requests,
    loadedTurns: visibleKeys.length,
  });
  assert.equal(
    control?.label,
    'The whole session is loaded. 2 turns.',
    'the completed session does not report both visible turns',
  );
  assert.notEqual(
    control?.label,
    'The whole session is loaded. 1 turn.',
    'the two-turn session still reports the original one-turn symptom',
  );
});

test('ordinary appends keep completed coverage while its witnessed turn remains in the tail', () => {
  const openFirst = turn({ startedAt: at(10), finished: false });
  const initial = afterHistoryPage(
    held<HistoryCursor>(),
    {
      kind: 'page',
      turns: [],
      compactions: [],
      cursor: null,
      ownedRange: { start: 0, end: 400 },
      openRange: { start: 400, end: 700 },
    },
    { turns: [openFirst], compactions: [] },
    200,
  ).history;
  const pages = initial.pages;
  const coverage = initial.coverage;
  let current = initial;
  const appendedTails = [
    {
      revision: { sessionId: 'sess', size: 1200, mtimeMs: 6 },
      turns: [{ ...openFirst, finished: true }, turn({ startedAt: at(20), finished: false })],
    },
    {
      revision: { sessionId: 'sess', size: 1500, mtimeMs: 7 },
      turns: [
        { ...openFirst, finished: true },
        turn({ startedAt: at(20) }),
        turn({ startedAt: at(30), finished: false }),
      ],
    },
  ];
  for (const [index, append] of appendedTails.entries()) {
    const updated = historyStateAfterRevision(
      current,
      append.revision,
      true,
      {
        turns: append.turns,
      },
      300 + index,
    );
    assert.ok(updated, 'an ordinary append drops completed history');
    current = updated;
  }
  assert.equal(current.atBeginning, true, 'ordinary appends clear valid completed coverage');
  assert.strictEqual(current.pages, pages, 'ordinary appends replace retained pages');
  assert.strictEqual(current.coverage, coverage, 'ordinary appends replace an unchanged coverage witness');
  assert.equal(current.requests, initial.requests, 'ordinary appends start another history read');
});

test('an append during a page read keeps the pages and leaves the reader nothing to press', () => {
  // An append leaves earlier page bytes intact, so those pages and their cursor remain usable.
  // The next request uses the rebased cursor.
  const first = afterHistoryPage(
    held({ cursor: 'older', pages: [{ ...page([30]), bytes: 9 }] }),
    {
      kind: 'page',
      ...page([20]),
      cursor: 'older2',
      ownedRange: { start: 300, end: 600 },
      openRange: null,
    },
    page([]),
    200,
  );
  const stale = afterHistoryPage(first.history, { kind: 'stale' }, page([]), 300);
  assert.equal(stale.added, 0);
  assert.equal(stale.history.failed, false, 'an append while a page was read makes the reader press a retry button');
  assert.deepEqual(stale.history.pages, first.history.pages, 'an append throws away pages the reader can still see');
  assert.equal(stale.history.cursor, 'older2', 'an append throws away the cursor it never used');
  assert.equal(stale.history.requests, 2, 'the read is not counted, so the sentinel cannot ask again');
});

test('a failed read keeps the cursor and asks the reader rather than looping', () => {
  const after = afterHistoryPage(held({ cursor: 'older', requests: 2 }), { kind: 'failed' }, page([]), 400);
  assert.equal(after.history.failed, true, 'a failed read is not remembered');
  assert.equal(after.history.cursor, 'older', 'a failed read throws away the cursor it never used');
  assert.equal(after.history.requests, 3, 'a failed read is not counted, so the panel repeats it');

  const recovered = afterHistoryPage(
    after.history,
    {
      kind: 'page',
      ...page([30]),
      cursor: 'older2',
      ownedRange: { start: 300, end: 600 },
      openRange: null,
    },
    page([]),
    500,
  );
  assert.equal(recovered.history.failed, false, 'a session stays marked as failed after it recovered');
});

test('a request stops on the first page that adds a turn, and on anything that is not a page', () => {
  const outcome = (over: Partial<{ added: number; atBeginning: boolean }> = {}) => ({
    history: held({ atBeginning: over.atBeginning ?? false }),
    added: over.added ?? 0,
  });
  const pageOutcome: HistoryPageOutcome<string> = {
    kind: 'page',
    ...page([10]),
    cursor: 'older',
    ownedRange: { start: 100, end: 200 },
    openRange: null,
  };
  assert.equal(
    historyRequestContinues(pageOutcome, outcome()),
    true,
    'a request gives up before it walks past the turns the tail already lists',
  );
  assert.equal(
    historyRequestContinues(pageOutcome, outcome({ added: 1 })),
    false,
    'a request keeps reading after it found the turn it went for',
  );
  assert.equal(
    historyRequestContinues(pageOutcome, outcome({ atBeginning: true })),
    false,
    'a request keeps reading past the beginning of the file',
  );
  assert.equal(
    historyRequestContinues({ kind: 'stale' }, outcome()),
    false,
    'a request reads on through a file that moved under it',
  );
  assert.equal(historyRequestContinues({ kind: 'failed' }, outcome()), false, 'a request repeats a read that failed');
});

test('the automatic trigger counts requests, never the reads inside one', () => {
  // One request can read several pages already present in the ordinary tail.
  // Count empty requests rather than internal reads when limiting automatic loading.
  // Internal reads must not exhaust the limit within a single request.
  const before = held({ emptyRuns: 1 });
  const walked = held({ emptyRuns: 1, requests: 8, pages: [] });
  assert.equal(
    afterHistoryRequest(walked, before).emptyRuns,
    2,
    'a request that read eight pages and found nothing counts as eight',
  );

  const found = held({ emptyRuns: 1, requests: 3, pages: [{ ...page([10]), bytes: 5 }] });
  assert.equal(
    afterHistoryRequest(found, before).emptyRuns,
    0,
    'a request that added a page leaves the empty run standing',
  );

  // Three requests in a row that add nothing, and the sentinel stops asking on its own. The
  // button is still there, so the reader can still go further.
  let run = held();
  for (let request = 0; request < HISTORY_EMPTY_RUN_LIMIT; request++) {
    run = afterHistoryRequest(held({ emptyRuns: run.emptyRuns, requests: run.requests + 1 }), run);
  }
  assert.equal(run.emptyRuns, HISTORY_EMPTY_RUN_LIMIT);
  const control = olderHistoryControl({
    sessionId: 'sess',
    possible: true,
    paged: true,
    atBeginning: false,
    busy: false,
    failed: false,
    emptyRuns: run.emptyRuns,
    requests: run.requests,
    loadedTurns: 40,
  });
  assert.equal(control?.auto, false, 'requests that add nothing keep asking on their own');
  assert.equal(control?.kind, 'load', 'the reader loses the button after the automatic requests stopped');
});

test('a stale answer over a file that never moved is a cursor nothing can repair', () => {
  // The ordinary case: the agent appended while the page was read. The next refresh rebases
  // the cursor and the next request reads it through.
  assert.equal(
    staleCursorIsStuck({ size: 900, mtimeMs: 5 }, { size: 1200, mtimeMs: 6 }),
    false,
    'an append during a read throws the session back to the end of the file',
  );
  // The stuck case: a transcript copied over its own path keeps its size and its write time
  // and takes a new inode, which no rebase reaches. Every later request would answer stale.
  assert.equal(
    staleCursorIsStuck({ size: 900, mtimeMs: 5 }, { size: 900, mtimeMs: 5 }),
    true,
    'a cursor that can never be used again is kept, so every press returns nothing',
  );
  assert.equal(
    staleCursorIsStuck({ size: 900, mtimeMs: 5 }, { size: -1, mtimeMs: -1 }),
    false,
    'a transcript that cannot be read at all is treated as a cursor to throw away',
  );
});

test('the first request pays one read per page of loaded turns, and never more than the ceiling', () => {
  assert.equal(historyPageReads(0, HISTORY_PAGE_TURNS), 1, 'an empty session pays for skipped pages');
  assert.equal(historyPageReads(40, 20), 3, 'a 40-turn tail gives up before it reaches a new turn');
  assert.equal(
    historyPageReads(10_000, 20),
    HISTORY_PAGE_READ_CEILING,
    'a long session reads without a ceiling on one request',
  );
});

test('an append keeps validated coverage until a witnessed tail turn leaves the tail', () => {
  const tail = page([50, 60]);
  const was = held({
    atBeginning: true,
    coverage: {
      ownedRange: { start: 0, end: 500 },
      openRange: { start: 500, end: 700 },
      tailTurnKeys: tail.turns.map(turnKey),
    },
  });
  assert.equal(historyAfterRevision(was, { ...was }, true, tail), 'keep', 'an unchanged file is read again');
  assert.equal(
    historyAfterRevision(was, { ...was, size: 1200, mtimeMs: 6 }, true),
    'rebase',
    'an append to the session on screen throws its loaded history away',
  );
  assert.equal(
    historyAfterRevision(was, { ...was, size: 1200, mtimeMs: 6 }, true, page([50, 60, 70])),
    'rebase',
    'an append restarts a completed scan while every witnessed turn remains in the tail',
  );
  const cursor = { revision: { size: 900, mtimeMs: 5 }, end: 600 };
  const rebased = historyStateAfterRevision(
    held<typeof cursor>({ cursor }),
    {
      sessionId: 'sess',
      size: 1200,
      mtimeMs: 6,
    },
    true,
    page([50, 60, 70]),
    200,
  );
  assert.ok(rebased, 'an append drops retained history instead of rebasing it');
  assert.deepEqual(
    rebased.cursor?.revision,
    { size: 1200, mtimeMs: 6 },
    'an append leaves the history cursor on the old revision',
  );
  assert.equal(
    historyAfterRevision(was, { ...was, size: 1200, mtimeMs: 6 }, true, page([60, 70])),
    'restart',
    'a completed scan survives after a witnessed turn leaves the tail',
  );
  assert.equal(
    historyAfterRevision({ ...was, size: 1200, mtimeMs: 6 }, { ...was, size: 1200, mtimeMs: 6 }, true, page([60, 70])),
    'restart',
    'a tail accepted after the revision rebase cannot invalidate completed coverage',
  );
  const restarted = restartHistoryCoverage(was, { size: 1200, mtimeMs: 6 }, 200);
  assert.equal(restarted.cursor, null, 'incomplete coverage restarts from the retained cursor');
  assert.equal(restarted.atBeginning, false, 'incomplete coverage still claims the first byte is covered');
  assert.equal(restarted.coverage, null, 'an invalid witness remains available as completed evidence');
  assert.strictEqual(restarted.pages, was.pages, 'incomplete coverage discards retained pages');
  assert.equal(
    historyAfterRevision(was, { ...was, size: 1200, mtimeMs: 6 }, false),
    'reset',
    'a session off screen keeps pages nothing validated',
  );
  assert.equal(
    historyAfterRevision(was, { ...was, size: 400, mtimeMs: 6 }, true),
    'reset',
    'a truncated file keeps byte positions that name other records',
  );
  assert.equal(
    historyAfterRevision(was, { ...was, mtimeMs: 6 }, true),
    'reset',
    'a same-size rewrite keeps pages read from the replaced bytes',
  );
  assert.equal(
    historyAfterRevision(was, { ...was, sessionId: 'other' }, true),
    'reset',
    'another session at the same path inherits these pages',
  );
});

test('eviction keeps every session while the total fits, then releases the least recently used first', () => {
  const entries = [
    { sessionId: 'shown', bytes: 4000, usedAt: 10 },
    { sessionId: 'recent', bytes: 4000, usedAt: 30 },
    { sessionId: 'older', bytes: 4000, usedAt: 20 },
    { sessionId: 'oldest', bytes: 4000, usedAt: 5 },
  ];
  assert.deepEqual(
    historyEvictions(entries, new Set(['shown']), 1_000_000),
    [],
    'every optional session fits the budget and none is evicted',
  );
  assert.deepEqual(
    historyEvictions(entries, new Set(['shown']), 13_000),
    ['oldest'],
    'the least recently used optional session alone brings the total under budget',
  );
  assert.deepEqual(
    historyEvictions(entries, new Set(['shown']), 9_000),
    ['older', 'oldest'],
    'the two least recently used optional sessions are evicted and the rest stay',
  );
  assert.deepEqual(
    historyEvictions([{ sessionId: 'shown', bytes: 99_000_000, usedAt: 10 }], new Set(['shown']), 5000),
    [],
    'the session on screen is never evicted, even when it alone exceeds the budget',
  );
  assert.deepEqual(
    historyEvictions(entries, new Set(['shown', 'oldest']), 5000),
    ['older', 'recent'],
    'every session shown by an open panel survives after optional windows are exhausted',
  );
});

test('historyBudgetBytes clamps a MiB setting to the supported range and bytes', () => {
  assert.equal(historyBudgetBytes(0), HISTORY_BUDGET_MIN_MIB * 1024 * 1024, 'a value below the minimum is clamped up');
  assert.equal(historyBudgetBytes(1), HISTORY_BUDGET_MIN_MIB * 1024 * 1024);
  assert.equal(historyBudgetBytes(16), 16 * 1024 * 1024);
  assert.equal(
    historyBudgetBytes(1.5),
    1 * 1024 * 1024,
    'a fractional MiB value is floored before it is scaled to bytes',
  );
  assert.equal(historyBudgetBytes(256), HISTORY_BUDGET_MAX_MIB * 1024 * 1024);
  assert.equal(
    historyBudgetBytes(1000),
    HISTORY_BUDGET_MAX_MIB * 1024 * 1024,
    'a value above the maximum is clamped down',
  );
  assert.equal(historyBudgetBytes(NaN), 16 * 1024 * 1024, 'a non-finite value falls back to the setting default');
});

test('a page is charged what it retains, and an unserializable page is still charged', () => {
  const small = historyPageBytes(page([10]));
  const large = historyPageBytes(page([10, 20, 30]));
  assert.ok(large > small, 'a page holding more turns is charged the same as a page holding one');

  const cyclic = turn({ startedAt: at(10) }) as unknown as { self?: unknown };
  cyclic.self = cyclic;
  assert.ok(
    historyPageBytes({ turns: [cyclic as never], compactions: [] }) > 0,
    'a page the serializer refuses is charged nothing and never evicted',
  );

  assert.equal(
    historyBytes([
      { ...page([10]), bytes: 7 },
      { ...page([20]), bytes: 11 },
    ]),
    18,
    'the retained total does not add its pages',
  );
});

test('the sentinel offers a real button, and never a request that cannot add a turn', () => {
  const base = {
    sessionId: 'sess',
    possible: true,
    paged: false,
    atBeginning: false,
    busy: false,
    failed: false,
    emptyRuns: 0,
    requests: 0,
    loadedTurns: 40,
  };
  const load = olderHistoryControl(base);
  assert.equal(load?.kind, 'load', 'a session with older history offers no way to reach it');
  assert.equal(load?.auto, true, 'the sentinel never asks on its own');
  assert.equal(load?.label, 'Load older turns');
  assert.equal(load?.name, 'Load older turns. 40 turns loaded now.', 'the spoken name leaves out how much is loaded');

  assert.equal(
    olderHistoryControl({ ...base, possible: false }),
    null,
    'a fully read session still offers a request that cannot add a turn',
  );
  assert.equal(
    olderHistoryControl({ ...base, busy: true })?.kind,
    'busy',
    'a request in flight leaves a button that would start a second one',
  );
  assert.equal(
    olderHistoryControl({ ...base, paged: true, atBeginning: true, possible: false })?.kind,
    'beginning',
    'the beginning of the file leaves the request control in place',
  );
  assert.equal(
    olderHistoryControl({
      ...base,
      paged: true,
      atBeginning: true,
      possible: false,
      loadedTurns: 1,
    })?.label,
    'The whole session is loaded. 1 turn.',
    'the closing line does not count one turn',
  );
  assert.equal(
    olderHistoryControl({ ...base, possible: false, paged: true })?.kind,
    'load',
    'a paged session short of the beginning loses its way further back',
  );

  const retry = olderHistoryControl({ ...base, failed: true });
  assert.equal(retry?.kind, 'retry', 'a failed read leaves nothing to press');
  assert.equal(retry?.auto, false, 'a failed read is repeated on its own, in a loop nobody pressed for');

  assert.equal(
    olderHistoryControl({ ...base, emptyRuns: HISTORY_EMPTY_RUN_LIMIT })?.auto,
    false,
    'requests that add nothing keep asking on their own',
  );
  assert.equal(
    olderHistoryControl({ ...base, emptyRuns: HISTORY_EMPTY_RUN_LIMIT })?.kind,
    'load',
    'the reader loses the button after the automatic requests stopped',
  );
});

test('the sentinel token moves whenever another request could answer differently', () => {
  const base = {
    sessionId: 'sess',
    possible: true,
    paged: true,
    atBeginning: false,
    busy: false,
    failed: false,
    emptyRuns: 0,
    requests: 1,
    loadedTurns: 40,
  };
  const first = olderHistoryControl(base)?.token;
  assert.notEqual(
    olderHistoryControl({ ...base, requests: 2 })?.token,
    first,
    'a completed request leaves the token where it was, so the panel never asks again',
  );
  assert.notEqual(
    olderHistoryControl({ ...base, loadedTurns: 60 })?.token,
    first,
    'turns arriving leave the token where it was',
  );
  assert.notEqual(
    olderHistoryControl({ ...base, sessionId: 'other' })?.token,
    first,
    'two sessions share one token, so one answers for the other',
  );
});

// Generate transcripts whose ordinary tail excludes older turns.
// Loading their earlier history requires at least three page requests.
// These fixtures serve the page-loading tests in this file.
let generated = 0;

function transcriptDir(): string {
  return tempDir('older-pages-');
}

function stamp(second: number): string {
  return new Date(Date.UTC(2026, 7, 23, 12, 0, second)).toISOString();
}

function claudeTranscript(turns: number, bodyBytes: number): string {
  const file = path.join(transcriptDir(), 'sess.jsonl');
  const lines: string[] = [];
  for (let index = 1; index <= turns; index++) {
    const second = index * 10;
    lines.push(
      JSON.stringify({
        type: 'user',
        promptId: `p${index}`,
        timestamp: stamp(second),
        message: { role: 'user', content: [{ type: 'text', text: `Generated request ${index}` }] },
      }),
    );
    lines.push(
      JSON.stringify({
        type: 'assistant',
        timestamp: stamp(second + 1),
        message: {
          role: 'assistant',
          id: `pad-${index}`,
          model: 'claude-opus-5',
          content: [{ type: 'text', text: 'x'.repeat(bodyBytes) }],
        },
      }),
    );
    lines.push(
      JSON.stringify({
        type: 'assistant',
        timestamp: stamp(second + 2),
        message: {
          role: 'assistant',
          id: `answer-${index}`,
          model: 'claude-opus-5',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: `Completed generated request ${index}.` }],
          usage: { input_tokens: 20, output_tokens: 10 },
        },
      }),
    );
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  generated += 1;
  return file;
}

function codexTranscript(turns: number, bodyBytes: number, dispatchFirst = false): string {
  const file = path.join(transcriptDir(), 'rollout.jsonl');
  const lines: string[] = [
    JSON.stringify({
      timestamp: stamp(0),
      type: 'session_meta',
      payload: {
        session_id: '01a032c9-1a92-7931-845c-723117d24dbe',
        id: '01a032c9-1a92-7931-845c-723117d24dbe',
        cwd: 'c:\\generated',
        originator: 'codex_vscode',
        source: 'vscode',
        model_provider: 'openai',
      },
    }),
  ];
  for (let index = 1; index <= turns; index++) {
    const second = index * 10;
    const turnId = `01a032c9-1e07-78b2-ae0c-${index.toString().padStart(12, '0')}`;
    lines.push(
      JSON.stringify({
        timestamp: stamp(second),
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: turnId, model_context_window: 258400 },
      }),
    );
    lines.push(
      JSON.stringify({
        timestamp: stamp(second + 1),
        type: 'turn_context',
        payload: { turn_id: turnId, cwd: 'c:\\generated', model: 'gpt-5.6-sol', effort: 'high' },
      }),
    );
    lines.push(
      JSON.stringify({
        timestamp: stamp(second + 2),
        type: 'event_msg',
        payload: { type: 'user_message', message: `Generated request ${index}` },
      }),
    );
    if (index === 1 && dispatchFirst) {
      lines.push(
        JSON.stringify({
          timestamp: stamp(second + 2),
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            item: {
              type: 'CommandExecution',
              id: 'older-launch',
              status: 'completed',
              exit_code: 0,
              parsed_cmd: [{ type: 'unknown', cmd: 'python dispatch.py --arc-dispatch' }],
              stdout: 'ARC_DISPATCH_SESSION={"agent":"claude","session_id":"5a7b07c1-bfcf-4d96-9eb2-8ef1fb609881"}',
            },
          },
        }),
      );
    }
    lines.push(
      JSON.stringify({
        timestamp: stamp(second + 3),
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: `call-${index}`,
          output: [{ type: 'input_text', text: 'x'.repeat(bodyBytes) }],
        },
      }),
    );
    lines.push(
      JSON.stringify({
        timestamp: stamp(second + 4),
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: turnId,
          last_agent_message: `Completed generated request ${index}.`,
          duration_ms: 1000,
        },
      }),
    );
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  generated += 1;
  return file;
}

// Match loadOlderHistory's request loop in panelhost.ts.
// Read until a page adds a turn not already held by the session.
// historyPageReads limits the number of internal reads.
async function requestOlderPage(
  source: 'claude' | 'codex',
  file: string,
  sessionId: string,
  held: SessionHistory<HistoryCursor>,
  tail: { turns: Turn[]; compactions: Compaction[] },
  targetTurns: number,
): Promise<{ history: SessionHistory<HistoryCursor>; reads: number }> {
  const loaded = tail.turns.length + historyRecordsOutside(held.pages, tail).turns.length;
  const allowed = historyPageReads(loaded, targetTurns);
  let reads = 0;
  let current = held;
  const before = held;
  for (let attempt = 0; attempt < allowed; attempt++) {
    reads += 1;
    const result =
      source === 'codex'
        ? await readCodexHistoryPageAsync(file, sessionId, current.cursor as CodexHistoryCursor | null, { targetTurns })
        : await readClaudeHistoryPageAsync(file, sessionId, current.cursor as ClaudeHistoryCursor | null, {
            targetTurns,
          });
    const outcome: HistoryPageOutcome<HistoryCursor> =
      result.kind === 'page'
        ? {
            kind: 'page',
            turns: result.page.turns,
            compactions: result.page.compactions,
            cursor: result.page.nextOlderCursor,
            ownedRange: result.page.ownedRange,
            openRange: result.openRange,
          }
        : { kind: 'failed' };
    const applied = afterHistoryPage(current, outcome, tail, Date.now());
    current = applied.history;
    if (!historyRequestContinues(outcome, applied)) {
      break;
    }
  }
  return { history: afterHistoryRequest(current, before), reads };
}

for (const source of ['claude', 'codex'] as const) {
  test(`three ${source} pages add each turn exactly once and reach the first turn`, async () => {
    // Twelve complete turns exceed the four-turn tail and two-turn page targets.
    // At least three page requests must add older history before loading reaches the beginning.
    const turns = 12;
    const body = 6 * 1024;
    const file = source === 'codex' ? codexTranscript(turns, body, true) : claudeTranscript(turns, body);
    const sessionId = 'sess';
    const size = fs.statSync(file).size;
    const options = { maxTurns: 4, tailBytes: Math.floor(size / 3) };
    const tail =
      source === 'codex' ? readCodexSession(file, sessionId, options) : readSession(file, sessionId, options);
    assert.ok(
      tail.turns.length > 0 && tail.turns.length < turns,
      'the generated tail already holds the whole session, so this proves nothing',
    );
    assert.equal(
      olderHistoryPossible({
        size,
        readBytes: tail.readBytes,
        turnLimitReached: tail.turnLimitReached,
      }),
      true,
      'the generated session offers no older history to load',
    );

    let held = startSessionHistory<HistoryCursor>({ sessionId, size, mtimeMs: fs.statSync(file).mtimeMs }, 1);
    let pages = 0;
    let loaded = 0;
    while (!held.atBeginning && pages < 12) {
      const before = held.requests;
      const answer = await requestOlderPage(source, file, sessionId, held, tail, 2);
      held = answer.history;
      assert.ok(held.requests > before, 'a request completed without being counted');
      pages += 1;
      // Every request either adds turns or reaches the beginning of the file. A page whose
      // turns were all in the tail is skipped inside the request, not handed back as a
      // press that did nothing.
      const outside = historyRecordsOutside(held.pages, tail);
      const keys = [...tail.turns, ...outside.turns].map(turnKey);
      assert.equal(new Set(keys).size, keys.length, `page ${pages} put a turn on the list that was already there`);
      if (pages <= 3) {
        assert.ok(
          outside.turns.length > loaded || held.atBeginning,
          `page ${pages} added no turn and did not reach the beginning of the file`,
        );
      }
      loaded = outside.turns.length;
    }
    assert.equal(held.atBeginning, true, 'paging never reached the beginning of the file');
    assert.ok(pages >= 3, `the whole session loaded in ${pages} pages, so three pages prove nothing`);

    // Each turn exactly once, over the tail and every page together, and the same turns a
    // single read of the whole file produces.
    const outside = historyRecordsOutside(held.pages, tail);
    const merged = [...tail.turns, ...outside.turns].map(turnKey);
    assert.equal(new Set(merged).size, merged.length, 'a turn reached the list more than once');
    const whole =
      source === 'codex'
        ? readCodexSession(file, sessionId, { maxTurns: Number.MAX_SAFE_INTEGER, tailBytes: size })
        : readSession(file, sessionId, { maxTurns: Number.MAX_SAFE_INTEGER, tailBytes: size });
    assert.deepEqual(
      [...merged].sort(),
      whole.turns.map(turnKey).sort(),
      'the paged session is not the session a single read produces',
    );
    assert.equal(merged.length, turns, 'the paged session lost or gained a turn');
    if (source === 'codex') {
      assert.deepEqual(
        outside.turns.find(
          (turn) =>
            turnKey(turn) === turnKey(whole.turns.find((turn) => turn.dispatchToolUseIds?.includes('older-launch'))!),
        )?.dispatchToolUseIds,
        ['older-launch'],
      );
    }

    // Nothing is loaded for a session with no pages, whatever another one has read.
    assert.deepEqual(historyRecordsOutside([], tail).turns, [], 'a session with no pages of its own is widened anyway');

    // The sentinel goes once the file has no older bytes, and says what is loaded.
    const control = olderHistoryControl({
      sessionId,
      possible: false,
      paged: true,
      atBeginning: true,
      busy: false,
      failed: false,
      emptyRuns: 0,
      requests: held.requests,
      loadedTurns: merged.length,
    });
    assert.equal(control?.kind, 'beginning', 'the sentinel still offers a page at the first turn');
    assert.equal(control?.label, `The whole session is loaded. ${turns} turns.`);
  });
}

// History pages use the backward adapter rather than the tail's forward reducer.
// The adapter reads a background subagent's completion attachment from the transcript.
// Completion updates the subagent's status and identifies its child session.
// The child identity makes its usage available for the launching turn's total.
// Both attachment and launch must survive page boundaries.
test('a paged turn reads a background agent that reported back as an attachment', async () => {
  const file = path.join(transcriptDir(), 'sess.jsonl');
  const body = 8 * 1024;
  const lines: string[] = [
    JSON.stringify({
      type: 'user',
      promptId: 'p1',
      timestamp: stamp(10),
      message: { role: 'user', content: [{ type: 'text', text: 'trace the submit path in the background' }] },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: stamp(11),
      message: {
        role: 'assistant',
        id: 'launch-1',
        model: 'claude-opus-5',
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'bg4',
            name: 'Agent',
            input: { description: 'Trace webview submit render path', subagent_type: 'Explore' },
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: stamp(12),
      message: {
        role: 'assistant',
        id: 'answer-1',
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'x'.repeat(body) }],
        usage: { input_tokens: 20, output_tokens: 10 },
      },
    }),
  ];
  for (let index = 2; index <= 4; index++) {
    const second = index * 100;
    lines.push(
      JSON.stringify({
        type: 'user',
        promptId: `p${index}`,
        timestamp: stamp(second),
        message: { role: 'user', content: [{ type: 'text', text: `Generated request ${index}` }] },
      }),
    );
    lines.push(
      JSON.stringify({
        type: 'assistant',
        timestamp: stamp(second + 2),
        message: {
          role: 'assistant',
          id: `answer-${index}`,
          model: 'claude-opus-5',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'x'.repeat(body) }],
          usage: { input_tokens: 20, output_tokens: 10 },
        },
      }),
    );
    // The completion attachment belongs to a later turn than its launch.
    // A typed prompt separates their pages.
    // An attachment beside its launch is handled by the page's forward reducer.
    // Separating them exercises the backward adapter's child-status update.
    if (index === 2) {
      lines.push(
        JSON.stringify({
          type: 'attachment',
          timestamp: stamp(second + 5),
          attachment: {
            type: 'queued_command',
            timestamp: stamp(second + 5),
            commandMode: 'task-notification',
            prompt:
              '<task-notification><task-id>child-bg4</task-id><tool-use-id>bg4</tool-use-id><status>completed</status></task-notification>' +
              '<subagent_tokens>204311</subagent_tokens><tool_uses>31</tool_uses><duration_ms>512000</duration_ms>',
          },
        }),
      );
    }
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`);

  const sessionId = 'sess';
  const size = fs.statSync(file).size;
  const tail = readSession(file, sessionId, { maxTurns: 2, tailBytes: Math.floor(size / 3) });
  assert.ok(
    tail.turns.every((entry) => entry.agents.length === 0),
    'the tail already holds the launch, so paging proves nothing here',
  );

  let cursor: ClaudeHistoryCursor | null = null;
  let launch: Turn | undefined;
  let launchPage: readonly Turn[] = [];
  for (let page = 0; page < 8 && !launch; page++) {
    const result = await readClaudeHistoryPageAsync(file, sessionId, cursor, { targetTurns: 1 });
    assert.equal(result.kind, 'page', 'the backward reader refused a page');
    if (result.kind !== 'page') {
      break;
    }
    launch = result.page.turns.find((entry) => entry.agents.length > 0);
    if (launch) {
      launchPage = result.page.turns;
    }
    cursor = result.page.nextOlderCursor;
    if (!cursor) {
      break;
    }
  }
  assert.ok(launch, 'the paged session never produced the turn that launched the agent');
  assert.deepEqual(
    launchPage.map((entry) => entry.startedAt),
    [Date.parse(stamp(10))],
    'the notice reached the page that holds its launch, so the forward reducer answered it and the backward path was never asked',
  );
  assert.equal(launch.agents[0].status, 'completed', 'the paged row kept the status its launch wrote');
  assert.equal(launch.agents[0].id, 'child-bg4', 'the paged row never learned the child id');
  assert.equal(launch.agents[0].tokens, 204311);
  assert.equal(launch.agents[0].toolUses, 31);
  assert.equal(launch.agents[0].durationMs, 512000);
});

test('Codex capture reuses older evidence bytes across semantic pages within the raw page allowance', async () => {
  const file = path.join(tempDir('capture-evidence-reads-'), 'capture.jsonl');
  const record = (type: string, payload: object) =>
    JSON.stringify({ type, timestamp: '2026-09-29T12:00:00Z', payload });
  const rows = [record('session_meta', { id: 'capture', cwd: '/project' })];
  const ids = Array.from({ length: 96 }, (_value, index) => `turn-${index}`);
  for (const id of ids)
    rows.push(
      record('event_msg', { type: 'task_started', turn_id: id }),
      record('event_msg', { type: 'user_message', message: id }),
      record('event_msg', { type: 'task_complete', turn_id: id, last_agent_message: 'answer '.repeat(100) }),
    );
  fs.writeFileSync(file, rows.join('\n') + '\n');
  const size = fs.statSync(file).size;
  const readRange = (source: string, start: number, length: number) => {
    const fd = fs.openSync(source, 'r');
    try {
      const bytes = Buffer.alloc(length);
      assert.equal(fs.readSync(fd, bytes, 0, length, start), length);
      physicalBytes += length;
      return bytes;
    } finally {
      fs.closeSync(fd);
    }
  };
  let physicalBytes = 0;
  let cursor: CodexHistoryCursor | null = null;
  const found: string[] = [];
  do {
    const result = await readCodexHistoryPageAsync(file, 'capture', cursor, {
      exportLimits: EXPORT_LIMITS,
      chunkBytes: Math.ceil(size * 0.72),
      readRange,
    });
    assert.equal(result.kind, 'page');
    if (result.kind !== 'page') break;
    found.push(...result.page.turns.map((turn) => turn.promptId));
    cursor = result.page.nextOlderCursor;
    if (cursor) {
      const retained = (cursor.exportRanges ?? []).reduce((bytes, range) => bytes + range.bytes.length, 0);
      const held = cursor.heldRecords.reduce((bytes, record) => bytes + record.end - record.start + 1, 0);
      assert.ok(retained + held + cursor.fragment.length <= EXPORT_LIMITS.pageBytes);
    }
  } while (cursor);
  assert.deepEqual(found, ids.slice().reverse());
  assert.equal(physicalBytes, size);
});

test('Codex capture shares the raw page allowance with growing unfinished fragments', async () => {
  const file = path.join(tempDir('capture-fragment-budget-'), 'capture.jsonl');
  const limits = {
    ...EXPORT_LIMITS,
    sliceBytes: 4 * 1024,
    recordBytes: 128 * 1024,
    turnBytes: 256 * 1024,
    pageBytes: 768 * 1024,
  };
  const record = (type: string, payload: object) =>
    JSON.stringify({ type, timestamp: '2026-09-29T12:00:00Z', payload });
  const rows = [record('session_meta', { id: 'capture', cwd: '/project' })];
  for (let index = 0; index < 7; index++) rows.push(record('ignored', { padding: 'x'.repeat(112 * 1024) }));
  const ids = Array.from({ length: 96 }, (_value, index) => `turn-${index}`);
  for (const id of ids)
    rows.push(
      record('event_msg', { type: 'task_started', turn_id: id }),
      record('event_msg', { type: 'user_message', message: id }),
      record('event_msg', { type: 'task_complete', turn_id: id, last_agent_message: 'answer '.repeat(100) }),
    );
  fs.writeFileSync(file, rows.join('\n') + '\n');
  let cursor: CodexHistoryCursor | null = null;
  const found: string[] = [];
  let fragments = 0;
  let reachedPageLimit = false;
  do {
    let result: Awaited<ReturnType<typeof readCodexHistoryPageAsync>>;
    try {
      result = await readCodexHistoryPageAsync(file, 'capture', cursor, { exportLimits: limits });
    } catch (error) {
      assert.ok(error instanceof ExportLimitError && error.boundary === 'page');
      reachedPageLimit = true;
      break;
    }
    assert.equal(result.kind, 'page');
    if (result.kind !== 'page') break;
    found.push(...result.page.turns.map((turn) => turn.promptId));
    cursor = result.page.nextOlderCursor;
    if (cursor) {
      if (cursor.fragment.length) fragments++;
      const retained = (cursor.exportRanges ?? []).reduce((bytes, range) => bytes + range.bytes.length, 0);
      const held = cursor.heldRecords.reduce((bytes, record) => bytes + record.end - record.start + 1, 0);
      assert.ok(
        retained + held + cursor.fragment.length <= limits.pageBytes,
        `cursor retains ${retained + held + cursor.fragment.length} bytes against ${limits.pageBytes}`,
      );
    }
  } while (cursor);
  assert.ok(found.length > 0);
  assert.deepEqual(found, ids.slice(-found.length).reverse());
  assert.ok(fragments > 0);
  assert.equal(reachedPageLimit, true);
});
