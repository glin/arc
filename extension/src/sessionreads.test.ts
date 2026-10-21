import { revisionOf, supportedFileIdentity, type SessionFile } from './transcript';
import {
  guardedSourceRevision,
  guardedSourceIdentity,
  AgentReadSources,
  AGENT_SOURCE_LIMITS,
  sessionSourceAdmitted,
} from './sessionreads';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import filesystem from 'node:fs';
import * as crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import * as path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { tempDir } from './temproot.ts';
import {
  boundedSessionRead,
  encodeSessionCursor,
  readSessionCursor,
  sessionAttention,
  sessionReadStatus,
  sessionPageSources,
  sessionScopeDigest,
  sessionSourceKey,
  SESSION_PAGE_LIMITS,
  SESSION_READ_LIMITS,
} from './sessionreads.ts';
import { openReadWindow, closeReadWindow } from './readmeter.ts';
import { projectAgentRead, currentAgentRead, type AgentReadRecord } from './domain/read.ts';

import { PageOptions, pageFile, pageBytes, variedName, createSessionPages } from '../test/session-pages';

let pageProjections = 0;
const { pageSecret, pageScope, listPage, traverse } = createSessionPages(() => pageProjections++);

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

test('read receipts contain only completed turns retained after the bounded response budget', () => {
  const directory = tempDir('read-receipt-budget-');
  const file = path.join(directory, 'session.jsonl');
  const records: unknown[] = [];
  for (let index = 1; index <= 3; index++) {
    const timestamp = `2026-10-08T12:00:0${index}Z`;
    records.push({
      type: 'user',
      promptId: `prompt-${index}`,
      sessionId: 'known',
      cwd: directory,
      timestamp,
      message: { role: 'user', content: index === 3 ? 'unfinished' : 'p'.repeat(22000) },
    });
    if (index < 3)
      records.push({
        type: 'assistant',
        timestamp,
        message: {
          id: `reply-${index}`,
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [{ type: 'text', text: 'answer' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
  }
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const stat = revisionOf(fs.statSync(file, { bigint: true }));
  const source = { agent: 'claude' as const, sessionId: 'known', file, size: stat.size, mtimeMs: stat.mtimeMs };
  let delivered: AgentReadRecord[] = [];
  const read = () =>
    boundedSessionRead(
      source,
      3,
      () => 'scope',
      'reader',
      [directory],
      undefined,
      (facts) => {
        delivered = facts.records;
        return 'signed';
      },
    );
  const result = read();
  assert.equal(result.turns.length, 2);
  assert.equal(
    delivered.length,
    1,
    JSON.stringify(result.turns.map(({ promptId, finished, endedAt }) => ({ promptId, finished, endedAt }))),
  );
  assert.equal(delivered[0].promptId, result.turns[1].promptId);
  assert.equal(result.turns[0].finished, false);
  assert.equal(delivered[0].sourceRevision, guardedSourceRevision(file));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= SESSION_READ_LIMITS.outputBytes);
  const overflow = boundedSessionRead(
    source,
    3,
    () => 'scope',
    'reader',
    [directory],
    undefined,
    () => 'x'.repeat(13000),
  );
  assert.equal('readObservation' in overflow, false);
});

test('bounded session reads preserve native provider turns and reject stale scope and source revisions', () => {
  const directory = tempDir('session-read-');
  for (const agent of ['claude', 'codex'] as const) {
    const file = path.join(directory, `${agent}.jsonl`);
    const head =
      agent === 'claude'
        ? {
            type: 'user',
            promptId: 'first',
            sessionId: 'known',
            cwd: directory,
            timestamp: '2026-10-08T12:00:00Z',
            message: { role: 'user', content: 'first prompt' },
          }
        : {
            type: 'session_meta',
            timestamp: '2026-10-08T12:00:00Z',
            payload: { id: 'known', cwd: directory, source: 'cli' },
          };
    const records: unknown[] = [head, { type: 'ignored', text: 'x'.repeat(SESSION_READ_LIMITS.bytes * 2) }];
    for (let n = 1; n <= 3; n++) {
      const timestamp = `2026-10-08T12:00:0${n}Z`;
      if (agent === 'claude')
        records.push(
          {
            type: 'user',
            promptId: `prompt-${n}`,
            sessionId: 'known',
            cwd: directory,
            timestamp,
            message: { role: 'user', content: `prompt ${n}` },
          },
          {
            type: 'assistant',
            timestamp,
            message: {
              id: `reply-${n}`,
              role: 'assistant',
              model: 'claude-opus-5-5',
              content: [{ type: 'text', text: `answer ${n}` }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
        );
      else
        records.push(
          { type: 'event_msg', timestamp, payload: { type: 'task_started', turn_id: `turn-${n}` } },
          { type: 'turn_context', timestamp, payload: { turn_id: `turn-${n}`, model: 'gpt-6.1-sol', effort: 'high' } },
          { type: 'event_msg', timestamp, payload: { type: 'user_message', message: `prompt ${n}` } },
          {
            type: 'event_msg',
            timestamp,
            payload: { type: 'task_complete', turn_id: `turn-${n}`, last_agent_message: `answer ${n}` },
          },
        );
    }
    fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    const stat = revisionOf(fs.statSync(file, { bigint: true }));
    const source = { agent, file, sessionId: 'known', cwd: directory, ...stat };
    const window = openReadWindow();
    const result = boundedSessionRead(source, 2, () => 'scope', 'local-agent', [directory]);
    const tally = closeReadWindow(window);
    assert.ok(tally.bytes <= 512 * 1024, `${agent} read ${tally.bytes} bytes`);
    assert.equal(result.state, 'current');
    assert.equal(result.partial, true);
    assert.equal(result.turns.length, 2);
    assert.equal(result.turns[0].prompt, 'prompt 3');
    assert.equal(result.turns[0].summary, 'answer 3');
    assert.equal(result.requester, 'local-agent');
    assert.equal('observation' in result, false);
    const sourceFacts = new AgentReadSources().resolve(source, () => 'scope', [directory])!;
    assert.equal(sourceFacts.identitiesComplete, true);
    let completed = 0;
    const partial = boundedSessionRead(
      source,
      2,
      () => 'scope',
      'local-agent',
      [directory],
      undefined,
      (facts) => {
        completed = facts.records.length;
        for (const record of facts.records) assert.equal(currentAgentRead(record, sourceFacts), true);
        return 'signed';
      },
    );
    assert.equal(partial.partial, true);
    assert.equal(completed, 2);
    assert.equal('readObservation' in partial, true);
    const observed = boundedSessionRead(
      source,
      2,
      () => 'scope',
      'local-agent',
      [directory],
      (facts) => JSON.stringify(facts),
    ) as { observation?: string; turns: { promptId: string }[] };
    assert.deepEqual(JSON.parse(observed.observation!), {
      scope: 'scope',
      sourceRevision: guardedSourceRevision(file),
      latestTurn: observed.turns[0].promptId,
    });
    assert.equal(
      'observation' in
        boundedSessionRead(
          source,
          2,
          () => 'scope',
          null,
          [directory],
          () => null,
        ),
      false,
    );
    assert.equal(
      boundedSessionRead({ ...source, dev: '999999999999999999999' }, 2, () => 'scope', null, [directory]).state,
      'stale',
    );
    assert.equal(boundedSessionRead(source, 2, () => 'scope', null, [path.join(directory, 'other')]).state, 'stale');
    // Current opening checks must distinguish identity and directory changes from an append.
    const original = fs.readFileSync(file);
    for (const change of ['identity', 'missing identity', 'directory', 'outside'] as const) {
      const altered = structuredClone(head);
      const opening = agent === 'codex' ? (altered as any).payload : (altered as any);
      if (change === 'identity') opening[agent === 'codex' ? 'id' : 'sessionId'] = 'other';
      else if (change === 'missing identity') delete opening[agent === 'codex' ? 'id' : 'sessionId'];
      else
        opening.cwd = change === 'directory' ? path.join(directory, 'nested') : path.join(directory, '..', 'outside');
      fs.writeFileSync(
        file,
        [altered, ...records.slice(1), { type: 'ignored', text: 'x'.repeat(512) }]
          .map((record) => JSON.stringify(record))
          .join('\n') + '\n',
      );
      const refused = boundedSessionRead(source, 2, () => 'scope', null, [directory]);
      assert.equal(refused.state, 'stale');
      assert.deepEqual(refused.turns, []);
      assert.match(
        refused.notes.join(' '),
        change === 'identity'
          ? /different session/
          : change === 'missing identity'
            ? /unavailable/
            : change === 'directory'
              ? /working directory changed/
              : /repository scope/,
      );
      fs.writeFileSync(file, original);
    }
    fs.renameSync(file, `${file}.retained`);
    fs.writeFileSync(file, original);
    const replaced = boundedSessionRead(source, 2, () => 'scope', null, [directory]);
    assert.equal(replaced.state, 'stale');
    assert.match(replaced.notes.join(' '), /replaced/);
    fs.unlinkSync(file);
    fs.renameSync(`${file}.retained`, file);
    const openingRead = filesystem.openSync;
    const unavailable = vi.spyOn(filesystem, 'openSync').mockImplementation((...args: any[]) => {
      if (args[0] === file) throw Object.assign(new Error('unread opening'), { code: 'EACCES' });
      return (openingRead as any)(...args);
    });
    syncBuiltinESMExports();
    try {
      const refused = boundedSessionRead(source, 2, () => 'scope', null, [directory]);
      assert.equal(refused.state, 'stale');
      assert.match(refused.notes.join(' '), /opening is unavailable/);
    } finally {
      unavailable.mockRestore();
      syncBuiltinESMExports();
    }
    const clock = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(SESSION_READ_LIMITS.qualificationMs + 1);
    try {
      const refused = boundedSessionRead(source, 2, () => 'scope', null, [directory]);
      assert.equal(refused.state, 'stale');
      assert.match(refused.notes.join(' '), /time limit/);
    } finally {
      clock.mockRestore();
    }
    const nativeRead = filesystem.readSync;
    let wrote = false;
    const writing = vi.spyOn(filesystem, 'readSync').mockImplementation((...args: any[]) => {
      const bytes = (nativeRead as any)(...args);
      if (!wrote) {
        wrote = true;
        fs.appendFileSync(file, '\n');
      }
      return bytes;
    });
    syncBuiltinESMExports();
    try {
      const refused = boundedSessionRead(source, 2, () => 'scope', null, [directory]);
      assert.equal(refused.state, 'stale');
      assert.deepEqual(refused.turns, []);
      assert.match(refused.notes.join(' '), /changed during qualification/);
    } finally {
      writing.mockRestore();
      syncBuiltinESMExports();
      fs.writeFileSync(file, original);
    }
    let calls = 0;
    const stale = boundedSessionRead(source, 2, () => (++calls === 1 ? 'before' : 'after'), null, [directory]);
    assert.equal(stale.state, 'stale');
    assert.deepEqual(stale.turns, []);
    calls = 0;
    const changed = boundedSessionRead(
      source,
      2,
      () => {
        if (++calls === 3) fs.appendFileSync(file, '\n');
        return 'scope';
      },
      null,
      [directory],
    );
    assert.equal(changed.state, 'stale');
    assert.deepEqual(changed.turns, []);
  }
  // A latest turn too large for the response leaves the reply without that turn, so it carries no observation.
  const file = path.join(directory, 'oversized.jsonl');
  const prompt = (content: string, timestamp: string) => ({
    type: 'user',
    sessionId: 'known',
    cwd: directory,
    timestamp,
    message: { role: 'user', content },
  });
  const reply = (n: number, timestamp: string) => ({
    type: 'assistant',
    timestamp,
    message: {
      id: `reply-${n}`,
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text: `answer ${n}` }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  const records = [
    prompt('small prompt', '2026-10-08T12:00:01Z'),
    reply(1, '2026-10-08T12:00:01Z'),
    prompt('y'.repeat(SESSION_READ_LIMITS.outputBytes), '2026-10-08T12:00:02Z'),
    reply(2, '2026-10-08T12:00:02Z'),
  ];
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const stat = revisionOf(fs.statSync(file, { bigint: true }));
  const source = {
    agent: 'claude' as const,
    file,
    sessionId: 'known',
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ino: stat.ino,
  };
  const oversized = boundedSessionRead(
    source,
    2,
    () => 'scope',
    'local-agent',
    [directory],
    () => 'signed',
  );
  assert.equal(oversized.state, 'current');
  assert.deepEqual(oversized.turns, []);
  assert.equal('observation' in oversized, false);
});

test('session attention stays unknown for hidden panels and unavailable facts', () => {
  assert.equal(sessionAttention(false, 'waiting', true), 'unknown');
  assert.equal(sessionAttention(true, 'waiting', false), 'input');
  for (const status of ['running', 'subagents', 'background'] as const)
    assert.equal(sessionAttention(true, status, false), 'running');
  assert.equal(sessionAttention(true, 'done', true), 'unread');
  assert.equal(sessionAttention(true, 'done', false), 'idle');
  assert.equal(sessionAttention(true, undefined, null), 'unknown');
});

// Agents must read every scoped session when the catalog exceeds one page of rows or of bytes.
test('session pages reach every source exactly once above the row and byte limits in measured pages', () => {
  const files = Array.from({ length: 300 }, (_, n) => pageFile(n));
  const keys = sessionPageSources(files).map((entry) => entry.source);
  for (const replyBytes of [undefined, 6000]) {
    pageProjections = 0;
    const pages = traverse(
      () => files,
      () => ({ replyBytes, row: variedName }),
    );
    const served = pages.flatMap((page) => page.sessions.map((row) => row.source));
    assert.deepEqual(served, keys);
    assert.ok(pages.reduce((sum, page) => sum + pageBytes(page), 0) > 4 * SESSION_READ_LIMITS.outputBytes);
    assert.ok(pages.length > 300 / SESSION_PAGE_LIMITS.rows + 1);
    assert.ok(pageProjections <= files.length + pages.length);
    for (const [index, page] of pages.entries()) {
      assert.ok(pageBytes(page) <= Math.min(SESSION_READ_LIMITS.outputBytes, replyBytes ?? Infinity));
      assert.ok(page.sessions.length > 0);
      assert.equal(page.complete, index === pages.length - 1);
      assert.equal(page.coverage, 'complete');
      assert.equal(page.freshness, 'current');
    }
  }
  const noted = traverse(
    () => files,
    () => ({
      replyBytes: 6000,
      fresh: false,
      row: (session) => ({ ...variedName(session), facts: 'stale', attention: 'unknown' }),
    }),
  );
  assert.deepEqual(
    noted.flatMap((page) => page.sessions.map((row) => row.source)),
    keys,
  );
  for (const page of noted) assert.ok(page.notes.length === 3 && pageBytes(page) <= 6000);
  const rows = traverse(
    () => files,
    () => ({ limit: 7 }),
  );
  assert.ok(rows.every((page) => page.sessions.length <= 7));
  assert.equal(rows.length, Math.ceil(300 / 7));
});

// A forged or stale cursor must refuse instead of serving a wrong or empty page, and every cursor stays short.
test('session cursors refuse forgery, modification, truncation, other secrets, and foreign bodies, and report scope changes separately', () => {
  const files = Array.from({ length: 3 }, (_, n) => pageFile(n, { sessionId: `${'L'.repeat(100_000)}${n}` }));
  const first = listPage(files, null, { limit: 1 });
  const cursor = first.next!;
  assert.ok(cursor.length <= 512);
  assert.equal(readSessionCursor(cursor, pageSecret, pageScope).status, 'valid');
  const bytes = Buffer.from(cursor, 'base64url');
  const flipped = (index: number) => {
    const copy = Buffer.from(bytes);
    copy[index] ^= 1;
    return copy.toString('base64url');
  };
  const body = JSON.parse(bytes.subarray(32).toString('utf8'));
  const signed = (value: unknown) => {
    const text = Buffer.from(JSON.stringify(value));
    return Buffer.concat([crypto.createHmac('sha256', pageSecret).update(text).digest(), text]).toString('base64url');
  };
  assert.equal(readSessionCursor(signed(body), pageSecret, pageScope).status, 'valid');
  for (const refused of [
    crypto.randomBytes(200).toString('base64url'),
    flipped(0),
    flipped(bytes.length - 3),
    cursor.slice(0, -4),
    cursor.slice(0, 40),
    `${cursor}A`,
    `${cursor}=`,
    'A'.repeat(513),
    '',
    signed({ ...body, extra: true }),
    signed({ ...body, coverage: 'true' }),
    signed({ ...body, version: 2 }),
    signed({ ...body, last: 'short' }),
    signed([body]),
    Buffer.concat([crypto.createHmac('sha256', pageSecret).update('{').digest(), Buffer.from('{')]).toString(
      'base64url',
    ),
    12,
    null,
  ])
    assert.equal(readSessionCursor(refused, pageSecret, pageScope).status, 'refused');
  assert.equal(readSessionCursor(cursor, crypto.randomBytes(32), pageScope).status, 'refused');
  assert.equal(readSessionCursor(cursor, pageSecret, sessionScopeDigest('other scope')).status, 'scope');
  assert.equal(readSessionCursor(cursor, crypto.randomBytes(32), sessionScopeDigest('other scope')).status, 'refused');
  for (const coverage of [true, false])
    for (const fresh of [true, false])
      assert.ok(encodeSessionCursor({ ...body, coverage, fresh }, pageSecret).length <= 512);
});

// Oversized recorded values must not hide a session or push the reply past its budget.
test('session pages cap oversized fields, reduce a row to its identity, and refuse when no row or empty page fits', () => {
  const huge = 'x'.repeat(20_000);
  const file = pageFile(1, { sessionId: 'I'.repeat(5000), file: `C:/Users/Mixed/${'P'.repeat(5000)}.jsonl` });
  const capped = listPage([file], null, {
    row: () => ({
      name: '\u{1F600}'.repeat(3000),
      setup: { model: huge, effort: huge, source: 'recorded' },
      labels: Array.from({ length: 300 }, (_, n) => ({ name: `label-${n}`, source: 'reader' as const })),
      parent: { id: huge, relation: 'reader' },
    }),
  });
  const [row] = capped.sessions;
  assert.deepEqual(row.truncated, ['id', 'path', 'name', 'setup.model', 'setup.effort', 'labels', 'parent.id']);
  assert.deepEqual([row.id, row.path, row.setup.model, row.setup.effort, row.labels], [null, null, null, null, null]);
  assert.deepEqual(row.parent, { id: null, relation: 'reader' });
  assert.ok(row.name!.length > 2000 && pageBytes(row.name) <= SESSION_PAGE_LIMITS.fieldBytes);
  assert.equal(row.name, '\u{1F600}'.repeat(row.name!.length / 2));
  assert.equal(row.source, sessionSourceKey(file.agent, file.sessionId, file.file));
  assert.ok(capped.notes.some((note) => note.includes('truncated')));
  const edge = 'n'.repeat(SESSION_PAGE_LIMITS.fieldBytes - 2);
  const kept = listPage([pageFile(2)], null, {
    row: () => ({ name: edge, setup: { model: edge, effort: null, source: 'recorded' } }),
  });
  assert.deepEqual([kept.sessions[0].name, kept.sessions[0].setup.model, kept.sessions[0].truncated], [edge, edge, []]);
  const tight = traverse(
    () => [pageFile(3), pageFile(4)],
    () => ({ replyBytes: 1500, row: () => ({ name: 'n'.repeat(4000) }) }),
  );
  assert.equal(tight.length, 2);
  for (const page of tight) {
    assert.ok(pageBytes(page) <= 1500);
    assert.equal(page.sessions.length, 1);
    const [minimal] = page.sessions;
    assert.deepEqual(
      [minimal.id, minimal.path, minimal.name, minimal.setup.model, minimal.labels],
      [null, null, null, null, null],
    );
    assert.deepEqual(minimal.truncated, ['id', 'path', 'name', 'setup.model', 'setup.effort', 'labels']);
    assert.deepEqual([minimal.runStatus, minimal.facts, minimal.ambiguous], ['done', 'current', false]);
  }
  assert.throws(() => listPage([pageFile(3)], null, { replyBytes: 300 }), /window metadata/);
  const pair = sessionPageSources([pageFile(5), pageFile(6)]).map((entry) => entry.session);
  const exhausted = listPage(pair, null, { limit: 1 }).next;
  for (const [files, cursor, catalog] of [
    [[], null, 'complete'],
    [[], null, 'unavailable'],
    [pair.slice(0, 1), exhausted, 'complete'],
  ] as const) {
    const empty = listPage([...files], cursor, { catalog });
    assert.deepEqual([empty.sessions, empty.next], [[], null]);
    const bytes = pageBytes(empty);
    assert.deepEqual(listPage([...files], cursor, { catalog, replyBytes: bytes }), empty);
    assert.throws(() => listPage([...files], cursor, { catalog, replyBytes: bytes - 1 }), /window metadata/);
  }
});

// Agents must tell apart transcripts that share a session ID, and notes must not echo that ID.
test('session pages mark every source of a shared session ID, including an oversized one, without naming it in notes', () => {
  const longId = 'S'.repeat(9000);
  const files = [
    pageFile(1, { sessionId: 'shared-id' }),
    pageFile(2, { sessionId: 'shared-id' }),
    pageFile(3, { sessionId: longId }),
    pageFile(4, { sessionId: longId }),
    pageFile(5),
  ];
  const pages = traverse(
    () => files,
    () => ({ limit: 1 }),
  );
  const rows = pages.flatMap((page) => page.sessions);
  assert.deepEqual(
    rows.map((row) => row.source),
    sessionPageSources(files).map((entry) => entry.source),
  );
  assert.deepEqual(
    rows
      .filter((row) => row.ambiguous)
      .map((row) => sessionSourceKey(row.provider, row.id ?? longId, row.path!))
      .sort(),
    files
      .slice(0, 4)
      .map((file) => sessionSourceKey(file.agent, file.sessionId, file.file))
      .sort(),
  );
  for (const page of pages) {
    const notes = page.notes.join(' ');
    assert.ok(!notes.includes('shared-id') && !notes.includes('SSS'));
    assert.equal(notes.includes('more than one transcript'), page.sessions[0].ambiguous);
  }
});

// A traversal must report incomplete coverage whenever a source before the cursor could have been missed.
test('session page coverage survives appends and later additions but clears on earlier changes, missing identity, and incomplete discovery', () => {
  const sorted = sessionPageSources(Array.from({ length: 6 }, (_, n) => pageFile(n))).map((entry) => entry.session);
  const key = (file: SessionFile) => sessionSourceKey(file.agent, file.sessionId, file.file);
  const extras = Array.from({ length: 200 }, (_, n) => pageFile(100 + n));
  const after = extras.find((file) => key(file) > key(sorted.at(-1)!))!;
  const before = extras.find((file) => key(file) < key(sorted[0]))!;
  const run = (change: (page: number) => SessionFile[], options: (page: number) => PageOptions = () => ({})) =>
    traverse(change, (page) => ({ limit: 2, ...options(page) }));
  const grown = run((page) => sorted.map((file) => ({ ...file, size: file.size + page * 100, mtimeMs: page + 1 })));
  assert.deepEqual([grown.at(-1)!.coverage, grown.at(-1)!.complete], ['complete', true]);
  for (const dev of [0, '0']) {
    const zero = run(() => [{ ...sorted[0], dev }, ...sorted.slice(1)]);
    assert.deepEqual([zero.at(-1)!.coverage, zero.at(-1)!.complete], ['complete', true]);
  }
  const added = run((page) => (page ? [...sorted, after] : sorted));
  assert.deepEqual(
    added.flatMap((page) => page.sessions.map((row) => row.source)),
    sessionPageSources([...sorted, after]).map((entry) => entry.source),
  );
  assert.deepEqual([added.at(-1)!.coverage, added.at(-1)!.complete], ['complete', true]);
  for (const change of [
    (page: number) => (page === 1 ? [before, ...sorted] : sorted),
    (page: number) => (page ? sorted.slice(1) : sorted),
    (page: number) => (page ? [{ ...sorted[0], dev: '8' }, ...sorted.slice(1)] : sorted),
    () => [{ ...sorted[0], dev: undefined }, ...sorted.slice(1)],
    () => [{ ...sorted[0], ino: 2 ** 60 }, ...sorted.slice(1)],
    () => [{ ...sorted[0], ino: 0 }, ...sorted.slice(1)],
    () => [{ ...sorted[0], ino: '0' }, ...sorted.slice(1)],
  ]) {
    const pages = run(change);
    assert.deepEqual(
      pages.slice(1).map((page) => [page.coverage, page.complete]),
      pages.slice(1).map(() => ['incomplete', false]),
    );
    assert.ok(pages.at(-1)!.notes.some((note) => note.includes('incomplete')));
  }
  const discovery = run(
    () => sorted,
    (page) => ({ catalog: page === 1 ? 'incomplete' : 'complete' }),
  );
  assert.deepEqual(
    discovery.map((page) => page.coverage),
    ['complete', 'incomplete', 'incomplete'],
  );
  for (const [options, freshness] of [
    [(page: number): PageOptions => ({ fresh: page !== 0 }), ['stale', 'stale', 'stale']],
    [
      (page: number): PageOptions => ({ current: (file) => page !== 1 || file !== sorted[2] }),
      ['current', 'stale', 'stale'],
    ],
  ] as const) {
    const pages = run(() => sorted, options);
    assert.deepEqual(
      pages.map((page) => page.freshness),
      freshness,
    );
    assert.deepEqual([pages.at(-1)!.coverage, pages.at(-1)!.complete], ['complete', false]);
  }
  assert.throws(() => listPage(sorted, grown[0].next, { catalog: 'unavailable' }), /catalog is unavailable/);
  const empty = listPage([], null, { catalog: 'unavailable' });
  assert.deepEqual([empty.sessions, empty.next, empty.coverage, empty.complete], [[], null, 'unavailable', false]);
});

test('exact decimal source identity distinguishes adjacent Windows inodes and keeps conservative fallback', () => {
  const snapshot = fs.statSync(__filename, { bigint: true });
  const before = revisionOf(
    Object.assign(Object.create(snapshot), { dev: 0n, ino: 56576470320201115n, size: 100n, mtimeNs: 1234567890n }),
  );
  const after = revisionOf(
    Object.assign(Object.create(snapshot), { dev: 0n, ino: 56576470320201114n, size: 150n, mtimeNs: 1234567890n }),
  );
  const source = { agent: 'claude' as const, file: 'source', sessionId: 's', ...before };
  assert.equal(before.dev, '0');
  assert.equal(before.ino, '56576470320201115');
  assert.equal(before.mtimeMs, 1234.56789);
  assert.notEqual(before.ino, after.ino, 'adjacent inodes collapsed');
  assert.equal(supportedFileIdentity(before), true);
  assert.equal(sessionSourceAdmitted(source, { ...before, size: 150 }), true);
  assert.equal(sessionSourceAdmitted(source, after), false, 'a larger replacement acquired source ownership');
  assert.equal(sessionSourceAdmitted({ ...source, dev: undefined, ino: undefined }, { ...before, size: 150 }), false);
  assert.equal(sessionSourceAdmitted({ ...source, dev: undefined, ino: undefined }, before), true);
  assert.equal(sessionSourceAdmitted({ ...source, dev: undefined, ino: 0 }, { ...before, ino: 0 }), true);
  for (const ino of ['01', 'NaN', '-1', '1.5']) {
    assert.equal(sessionSourceAdmitted({ ...source, ino }, { ...before, ino }), false);
  }
  for (const change of [
    { size: -1 },
    { size: 0.5 },
    { size: Number.MAX_SAFE_INTEGER + 1 },
    { mtimeMs: NaN },
    { mtimeMs: Infinity },
  ]) {
    assert.equal(sessionSourceAdmitted(source, { ...before, ...change }), false);
  }
});

test('cold source facts validate restored completed identities and invalidate exact source changes', () => {
  const directory = tempDir('agent-source-facts-');
  const file = path.join(directory, 'session.jsonl');
  const timestamp = '2026-10-08T12:00:01Z';
  const records = [
    {
      type: 'user',
      promptId: 'p1',
      sessionId: 'known',
      cwd: directory,
      timestamp,
      message: { role: 'user', content: 'prompt' },
    },
    {
      type: 'assistant',
      timestamp,
      message: {
        id: 'answer',
        role: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
        stop_reason: 'end_turn',
      },
    },
  ];
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const source = () => ({
    agent: 'claude' as const,
    file,
    sessionId: 'known',
    ...revisionOf(fs.statSync(file, { bigint: true })),
  });
  const cache = new AgentReadSources();
  const facts = cache.resolve(source(), () => 'scope', [directory])!;
  assert.equal(facts.identitiesComplete, true);
  assert.equal(facts.historyComplete, true);
  assert.equal(facts.source, guardedSourceIdentity(source()));
  const record = {
    provider: facts.provider,
    sessionId: facts.sessionId,
    source: facts.source,
    scope: facts.scope,
    sourceRevision: facts.sourceRevision,
    promptId: 'p1',
    startedAt: Date.parse(timestamp),
  };
  const restored = JSON.parse(JSON.stringify([record])) as AgentReadRecord[];
  assert.equal(
    projectAgentRead(restored, (one) =>
      new AgentReadSources().resolve(source(), () => 'scope', [directory], one.sourceRevision),
    ).size,
    1,
  );
  assert.equal(
    cache.resolve(source(), () => 'scope', [directory]),
    facts,
  );
  const snapshot = fs.statSync(file, { bigint: true });
  const stamp = vi.spyOn(filesystem, 'statSync').mockReturnValue({ ...snapshot, ctimeNs: snapshot.ctimeNs + 1n });
  syncBuiltinESMExports();
  try {
    assert.equal(
      cache.resolve(source(), () => 'scope', [directory], record.sourceRevision),
      null,
    );
    assert.notEqual(guardedSourceRevision(file), record.sourceRevision);
  } finally {
    stamp.mockRestore();
    syncBuiltinESMExports();
  }
  fs.appendFileSync(file, '\n');
  assert.equal(
    projectAgentRead(restored, (one) => cache.resolve(source(), () => 'scope', [directory], one.sourceRevision)).size,
    0,
  );
  const appended = cache.resolve(source(), () => 'scope', [directory])!;
  assert.notEqual(appended.sourceRevision, record.sourceRevision);
  assert.equal(cache.resolve(source(), () => 'other', [directory])!.scope, 'other');
  fs.writeFileSync(file, '{}\n');
  assert.equal(
    projectAgentRead(restored, (one) => cache.resolve(source(), () => 'scope', [directory], one.sourceRevision)).size,
    0,
  );
  fs.renameSync(file, `${file}.old`);
  fs.writeFileSync(file, records.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  assert.notEqual(guardedSourceIdentity(source()), record.source);
  assert.equal(
    projectAgentRead(restored, (one) => cache.resolve(source(), () => 'scope', [directory], one.sourceRevision)).size,
    0,
  );
  assert.equal(
    cache.resolve(source(), () => null, [directory]),
    null,
  );
  assert.equal(
    cache.resolve(source(), () => 'scope', [path.join(directory, 'elsewhere')]),
    null,
  );
  fs.rmSync(file);
  assert.equal(
    cache.resolve({ agent: 'claude', file, sessionId: 'known', size: 0, mtimeMs: 0 }, () => 'scope', [directory]),
    null,
  );
});

test('source facts bound bytes and identity coverage without certifying omitted identities', () => {
  const directory = tempDir('agent-source-bounds-');
  const file = path.join(directory, 'session.jsonl');
  const source = () => ({
    agent: 'claude' as const,
    file,
    sessionId: 'known',
    ...revisionOf(fs.statSync(file, { bigint: true })),
  });
  const records = Array.from({ length: AGENT_SOURCE_LIMITS.identities + 1 }, (_, index) => [
    {
      type: 'user',
      promptId: `p${index}`,
      sessionId: 'known',
      cwd: directory,
      timestamp: new Date(1000000 + index * 1000).toISOString(),
      message: { role: 'user', content: 'prompt' },
    },
    {
      type: 'assistant',
      timestamp: new Date(1000000 + index * 1000).toISOString(),
      message: {
        id: `a${index}`,
        role: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
        stop_reason: 'end_turn',
      },
    },
  ]).flat();
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const cache = new AgentReadSources();
  const facts = cache.resolve(source(), () => 'scope', [directory])!;
  assert.equal(facts.identitiesComplete, false);
  assert.equal(facts.historyComplete, false);
  assert.equal(facts.turns.length, AGENT_SOURCE_LIMITS.identities);
  const last = facts.turns.at(-1)!;
  assert.equal(currentAgentRead({ ...facts, ...last }, facts), false);
  const firstBytes = source().size;
  const other = path.join(directory, 'other.jsonl');
  fs.writeFileSync(other, JSON.stringify(records[0]) + '\n');
  cache.resolve(
    { agent: 'claude', file: other, sessionId: 'known', ...revisionOf(fs.statSync(other, { bigint: true })) },
    () => 'scope',
    [directory],
  );
  const evictedWindow = openReadWindow();
  cache.resolve(source(), () => 'scope', [directory]);
  assert.ok(closeReadWindow(evictedWindow).bytes > firstBytes);
  fs.writeFileSync(file, JSON.stringify(records[0]) + '\n' + ' '.repeat(AGENT_SOURCE_LIMITS.bytes));
  const window = openReadWindow();
  const large = cache.resolve(source(), () => 'scope', [directory])!;
  const tally = closeReadWindow(window);
  assert.ok(tally.bytes <= AGENT_SOURCE_LIMITS.bytes);
  assert.equal(large.identitiesComplete, false);
  assert.deepEqual(large.turns, []);
  cache.clear();
  for (let index = 0; index <= AGENT_SOURCE_LIMITS.sources; index++) {
    const next = path.join(directory, `source-${index}.jsonl`);
    fs.writeFileSync(next, JSON.stringify(records[0]) + '\n');
    cache.resolve(
      { agent: 'claude', file: next, sessionId: 'known', ...revisionOf(fs.statSync(next, { bigint: true })) },
      () => 'scope',
      [directory],
    );
  }
  const oldest = path.join(directory, 'source-0.jsonl');
  const evictedSources = openReadWindow();
  cache.resolve(
    { agent: 'claude', file: oldest, sessionId: 'known', ...revisionOf(fs.statSync(oldest, { bigint: true })) },
    () => 'scope',
    [directory],
  );
  assert.equal(closeReadWindow(evictedSources).bytes, 2 * fs.statSync(oldest).size);
});

test('guarded source revisions refuse growth that ordinary admission accepts, replacement, and unreadable sources', () => {
  const file = path.join(tempDir('guarded-source-'), 'session.jsonl');
  fs.writeFileSync(file, '{}\n');
  const observed = guardedSourceRevision(file)!;
  assert.equal(guardedSourceRevision(file), observed);
  const before = revisionOf(fs.statSync(file, { bigint: true }));
  fs.appendFileSync(file, '{"type":"summary"}\n');
  const after = revisionOf(fs.statSync(file, { bigint: true }));
  if (supportedFileIdentity(before) && supportedFileIdentity(after))
    assert.equal(
      sessionSourceAdmitted(
        {
          agent: 'claude',
          file,
          sessionId: 's',
          size: before.size,
          mtimeMs: before.mtimeMs,
          dev: before.dev,
          ino: before.ino,
        },
        after,
      ),
      true,
    );
  const grown = guardedSourceRevision(file);
  assert.notEqual(grown, observed);
  fs.writeFileSync(file, '{"a":1}\n');
  assert.notEqual(guardedSourceRevision(file), observed);
  assert.notEqual(guardedSourceRevision(file), grown);
  fs.rmSync(file);
  assert.equal(guardedSourceRevision(file), null);
});

test('accepted no-turn commands retain positive status until qualified process closure', () => {
  const commands = [{ id: 'command', startedAt: 100 }];
  const status = (running: boolean, waiting: boolean, exited?: number, unchanged = true) =>
    sessionReadStatus('session', null, running, waiting, undefined, exited, { unchanged, mtimeMs: 150 }, commands);
  assert.equal(status(false, false), 'background');
  assert.equal(status(true, false), 'running');
  assert.equal(status(false, true), 'waiting');
  assert.equal(status(false, false, 200), 'stopped');
  assert.equal(status(false, false, 200, false), 'background');
  assert.equal(status(false, false, 99), 'background');
  assert.equal(status(false, false, 149), 'background');
});
