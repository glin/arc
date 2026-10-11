import { revisionOf, supportedFileIdentity, type SessionFile } from './transcript';
import { sessionSourceAdmitted } from './sessionreads';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import filesystem from 'node:fs';
import * as net from 'node:net';
import * as crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import type { Duplex } from 'node:stream';
import { WindowsPipeServer } from './windowpipe.ts';
import { WINDOW_PIPE_SOURCE } from './windowpipe-source.ts';
import network from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import * as path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { tempDir } from './temproot.ts';
import {
  boundedSessionRead,
  encodeSessionCursor,
  readSessionCursor,
  sessionAttention,
  sessionListingPage,
  sessionPageSources,
  sessionScopeDigest,
  sessionSourceKey,
  SESSION_PAGE_LIMITS,
  SESSION_READ_LIMITS,
  type SessionListingRow,
  type SessionPage,
  type SessionPageRequest,
} from './sessionreads.ts';
import { openReadWindow, closeReadWindow } from './readmeter.ts';
import { requestWindow } from './sessionrequests.ts';
import { SessionWriteRequests, archiveRefusal } from './sessionwrites.ts';
import { arcCliSpawner, childEnv } from './agenthost.ts';
import {
  discoverWindows,
  hostAddress,
  validHostAddress,
  parseSessionRequest,
  pingWindow,
  SESSION_REQUEST_LIMITS,
  WINDOW_DISCOVERY_LIMITS,
  WindowChannel,
  type HostRegistration,
  type WindowInfo,
  type WindowState,
} from './sessionrequests.ts';

// These Node guards catch access, resource exhaustion, wrong-window discovery, and lifecycle leaks without browser startup.
const state: WindowState = { folders: [], scopeReady: true, panelReady: false, panelVisible: false };
const channels: WindowChannel[] = [];
// These cases catch duplicate acceptance and unsafe archive admission with no provider or browser startup.
test('session writes retain one acceptance across equal concurrent retries and refuse conflicts, capacity and old activations', async () => {
  const book = new SessionWriteRequests('window', 1);
  let finish!: (value: unknown) => void;
  let calls = 0;
  const apply = () => {
    calls++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const first = book.run('window:1', { prompt: 'work', setup: { model: 'a', effort: 'high' } }, apply);
  const second = book.run('window:1', { setup: { effort: 'high', model: 'a' }, prompt: 'work' }, apply);
  await vi.waitFor(() => assert.equal(calls, 1));
  await assert.rejects(book.run('window:1', { prompt: 'different' }, apply), /different request/);
  await assert.rejects(book.run('window:2', {}, apply), /limit/);
  await assert.rejects(new SessionWriteRequests('reloaded').run('window:1', {}, apply), /unknown/);
  finish({ sessionId: 'accepted' });
  assert.deepEqual(await first, await second);
  assert.deepEqual(await book.run('window:1', { prompt: 'work', setup: { model: 'a', effort: 'high' } }, apply), {
    sessionId: 'accepted',
  });
  assert.equal(calls, 1);
});

test('archive refuses current live work and stale attention even with force, while completed unread requires force', () => {
  const row = { facts: 'current', runStatus: 'done', attention: 'idle' } as SessionListingRow;
  assert.equal(archiveRefusal(row, false), null);
  assert.equal(archiveRefusal({ ...row, runStatus: 'none' }, false), null);
  assert.match(archiveRefusal({ ...row, attention: 'unread' }, false)!, /--force/);
  assert.equal(archiveRefusal({ ...row, attention: 'unread' }, true), null);
  for (const runStatus of ['running', 'waiting', 'subagents', 'background'] as const)
    assert.match(archiveRefusal({ ...row, runStatus }, true)!, /running or needs input/);
  for (const facts of ['stale', 'unparsed'] as const)
    assert.match(archiveRefusal({ ...row, facts }, true)!, /unavailable/);
  assert.match(archiveRefusal({ ...row, attention: 'unknown' }, true)!, /unavailable/);
  assert.match(archiveRefusal({ ...row, runStatus: 'unknown' }, true)!, /unavailable/);
});

test('the authenticated window channel retains write acceptance across a disconnected caller and rejects conflicting retries', async () => {
  const { channel, home, entry } = await fixture();
  let calls = 0;
  let release!: () => void;
  channel.setRequestHandler(async () => {
    calls++;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { status: 'accepted', sessionId: 'only-launch' };
  });
  const params = {
    prompt: 'work',
    agentRun: false,
    setup: { kind: 'custom' as const, agent: 'codex', model: '', effort: '', permissionMode: '' },
  };
  const id = channel.hostId + ':one';
  const socket =
    process.platform === 'win32'
      ? await WindowsPipeServer.connect(
          entry.address,
          entry.pid,
          entry.transportPid!,
          path.join(home, 'hosts', `${channel.hostId}.json`),
        )
      : net.createConnection(entry.address);
  sockets.push(socket);
  socket.on('error', () => {});
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  socket.write(JSON.stringify(request(entry, { id, method: 'start', params })) + '\n');
  await vi.waitFor(() => assert.equal(calls, 1));
  socket.destroy();
  const retried = requestWindow('start', params, channel.hostId, home, id);
  release();
  assert.equal(((await retried) as { sessionId: string }).sessionId, 'only-launch');
  assert.equal(calls, 1);
  await assert.rejects(
    requestWindow('start', { ...params, prompt: 'other' }, channel.hostId, home, id),
    /different request/,
  );
});
const sockets: Duplex[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(channels.splice(0).map((channel) => channel.dispose()));
});

async function fixture(
  limits = { ...SESSION_REQUEST_LIMITS } as {
    lineBytes: number;
    lineDeadlineMs: number;
    connections: number;
    inFlight: number;
  },
  handler?: ConstructorParameters<typeof WindowChannel>[2],
) {
  const home = tempDir('window-channel-');
  const channel = new WindowChannel(home, limits, handler);
  channels.push(channel);
  await channel.update(state);
  const file = path.join(home, 'hosts', `${channel.hostId}.json`);
  const entry = JSON.parse(fs.readFileSync(file, 'utf8')) as HostRegistration;
  return { home, channel, file, entry };
}

function request(entry: HostRegistration, changes = {}) {
  return { id: 'request-1', version: 1, token: entry.token, method: 'ping', requester: null, params: {}, ...changes };
}

async function connect(address: string): Promise<net.Socket> {
  const socket = net.createConnection(address);
  sockets.push(socket);
  socket.on('error', () => {});
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return socket;
}

function closed(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => socket.once('close', () => resolve()));
}

function reply(socket: net.Socket): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let text = '';
    socket.on('data', (chunk) => {
      text += chunk.toString();
      if (text.includes('\n')) resolve(JSON.parse(text.split('\n')[0]));
    });
    socket.once('close', () => reject(new Error('Channel closed before its reply.')));
  });
}

test('addresses use Windows pipes and bounded macOS and Linux socket paths', () => {
  const id = 'a'.repeat(24);
  assert.equal(hostAddress('/Arc/Home', id, 'win32'), `\\\\.\\pipe\\arc-${id}`);
  for (const platform of ['darwin', 'linux'] as const) {
    const home = '/Arc/MixedCase/Home';
    assert.equal(hostAddress(home, id, platform), path.posix.join(home, 'hosts', `${id}.sock`));
    const longHome = path.posix.join(home, 'MixedCase'.repeat(20));
    const address = hostAddress(longHome, id, platform, '/tmp');
    assert.equal(Buffer.byteLength(address) < 104, true);
    assert.notEqual(address, hostAddress(longHome + 'other', id, platform, '/tmp'));
    const macRoot = '/var/folders/ab/abcdefghijklmnopqrstuvwxyz012345/T';
    const published = hostAddress(longHome, id, platform, macRoot);
    assert.equal(Buffer.byteLength(published) < 104, true);
    assert.equal(validHostAddress(longHome, id, published, platform), true);
    assert.equal(validHostAddress(longHome, id, published.replace('/var/', '/var\0/'), platform), false);
    assert.notEqual(published, hostAddress(longHome, id, platform, '/var/tmp'));
    assert.equal(validHostAddress(longHome, id, published.replace('a-', 'other-'), platform), false);
    assert.equal(validHostAddress(longHome, id, published.replace(id, 'b'.repeat(24)), platform), false);
    assert.equal(validHostAddress(longHome, id, published, 'win32'), false);
    const oversizedRoot = '/TemporaryMixedCase'.repeat(20);
    assert.equal(hostAddress(longHome, id, platform, oversizedRoot).startsWith('/tmp/'), true);
  }
  assert.throws(() => hostAddress('/home', '../other', 'linux'));
});

test('request schema rejects unsupported versions, methods, identifiers, and parameters', () => {
  const valid = request({ token: 'b'.repeat(64) } as HostRegistration);
  assert.deepEqual(parseSessionRequest(valid), valid);
  for (const invalid of [
    null,
    [],
    {},
    { ...valid, id: '' },
    { ...valid, id: 1 },
    { ...valid, id: 'a'.repeat(129) },
    { ...valid, version: 2 },
    { ...valid, token: 'no' },
    { ...valid, method: 'start' },
    { ...valid, params: null },
    { ...valid, params: { value: 1 } },
    { ...valid, requester: [] },
    { ...valid, requester: '' },
    { ...valid, extra: true },
    { ...valid, method: 'sessions', replyBytes: 1000 },
    { ...valid, method: 'sessions', params: { replyBytes: 1000 } },
    { ...valid, method: 'sessions', params: { sessionId: 'known' } },
    { ...valid, method: 'sessions', params: { limit: 0 } },
    { ...valid, method: 'sessions', params: { limit: 129 } },
    { ...valid, method: 'sessions', params: { limit: 1.5 } },
    { ...valid, method: 'sessions', params: { limit: '5' } },
    { ...valid, method: 'sessions', params: { cursor: '' } },
    { ...valid, method: 'sessions', params: { cursor: 'a'.repeat(513) } },
    { ...valid, method: 'sessions', params: { cursor: 'abc=' } },
    { ...valid, method: 'sessions', params: { cursor: 7 } },
  ]) {
    assert.equal(parseSessionRequest(invalid), null);
  }
  for (const params of [{ cursor: 'A-_z'.repeat(128), limit: 128 }, { limit: 1 }, { cursor: 'c' }]) {
    const paged = { ...valid, method: 'sessions', params };
    assert.deepEqual(parseSessionRequest(paged), paged);
  }
});

test('session requests reject paths, extra parameters, and invalid turn counts before dispatch', async () => {
  const { home, channel, entry } = await fixture();
  const valid = request(entry, { method: 'session', params: { sessionId: 'known', turns: 2 } });
  assert.deepEqual(parseSessionRequest(valid), valid);
  for (const params of [
    { sessionId: 'known', turns: 0 },
    { sessionId: 'known', turns: 21 },
    { sessionId: 'known', turns: 1.5 },
    { sessionId: 'known', turns: 1, file: '/other' },
  ])
    assert.equal(parseSessionRequest({ ...valid, params }), null);
  channel.setRequestHandler((value) => {
    if (value.params.sessionId !== 'known') throw new Error('Unknown session.');
    return { session: value.params.sessionId, turns: value.params.turns, requester: value.requester };
  });
  const result = await requestWindow('session', valid.params, channel.hostId, home);
  assert.equal((result as any).session, 'known');
  await assert.rejects(
    requestWindow('session', { sessionId: '/other/file', turns: 1 }, channel.hostId, home),
    /Unknown session/,
  );
  const second = new WindowChannel(home);
  channels.push(second);
  await second.update(state);
  await assert.rejects(requestWindow('sessions', {}, '', home), /Select one Arc window/);
});

test('bounded session reads preserve native provider turns and reject stale scope and source revisions', () => {
  const directory = tempDir('session-read-');
  for (const agent of ['claude', 'codex'] as const) {
    const file = path.join(directory, `${agent}.jsonl`);
    const head =
      agent === 'claude'
        ? {
            type: 'user',
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
    const source = { agent, file, sessionId: 'known', size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
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
    assert.equal(
      boundedSessionRead({ ...source, dev: '999999999999999999999' }, 2, () => 'scope', null, [directory]).state,
      'stale',
    );
    assert.equal(boundedSessionRead(source, 2, () => 'scope', null, [path.join(directory, 'other')]).state, 'stale');
    let calls = 0;
    const stale = boundedSessionRead(source, 2, () => (++calls === 1 ? 'before' : 'after'), null, [directory]);
    assert.equal(stale.state, 'stale');
    assert.deepEqual(stale.turns, []);
    calls = 0;
    const changed = boundedSessionRead(
      source,
      2,
      () => {
        if (++calls === 2) fs.appendFileSync(file, '\n');
        return 'scope';
      },
      null,
      [directory],
    );
    assert.equal(changed.state, 'stale');
    assert.deepEqual(changed.turns, []);
  }
});

test('session replies with valid large window metadata refuse excess envelope bytes without losing the channel', async () => {
  const data = { content: 'x'.repeat(48 * 1024 - 1000) };
  const { home, channel } = await fixture();
  channel.setRequestHandler(() => data);
  const folders = Array.from({ length: 12 }, (_, n) => `C:/project-${n}/${'folder'.repeat(280)}`);
  await channel.update({ ...state, folders });
  for (const method of ['sessions', 'session'] as const) {
    await assert.rejects(
      requestWindow(method, method === 'session' ? { sessionId: 'known', turns: 1 } : {}, channel.hostId, home),
      /session response exceeds.*channel limit/,
    );
  }
  let replyBytes = 0;
  let extra = 0;
  channel.setRequestHandler((request) => {
    replyBytes = request.replyBytes ?? -1;
    return { fill: 'x'.repeat(replyBytes - Buffer.byteLength('{"fill":""}') + extra) };
  });
  const filled = await requestWindow('sessions', {}, channel.hostId, home);
  assert.ok(replyBytes > 0 && replyBytes < SESSION_READ_LIMITS.outputBytes);
  assert.equal(pageBytes(filled), replyBytes);
  extra = 1;
  await assert.rejects(requestWindow('sessions', {}, channel.hostId, home), /channel limit/);
  channel.setRequestHandler((request) => {
    void channel.update({ ...state, folders: [...folders, 'C:/added-during-the-read'] });
    return { fill: 'x'.repeat(request.replyBytes! - Buffer.byteLength('{"fill":""}')) };
  });
  assert.ok(pageBytes(await requestWindow('sessions', {}, channel.hostId, home)) > 0);
  await channel.update({ ...state, folders });
  channel.setRequestHandler((request) => ({ replyBytes: request.replyBytes ?? null }));
  assert.deepEqual(await requestWindow('session', { sessionId: 'known', turns: 1 }, channel.hostId, home), {
    replyBytes: null,
  });
  const files = Array.from({ length: 300 }, (_, n) => pageFile(n));
  channel.setRequestHandler((request) => listPage(files, null, { replyBytes: request.replyBytes, row: variedName }));
  const page = (await requestWindow('sessions', {}, channel.hostId, home)) as SessionPage;
  assert.ok(page.next && page.sessions.length > 0 && pageBytes(page) <= replyBytes);
  channel.setRequestHandler(() => ({ complete: false, notes: ['Bounded listing.'] }));
  assert.deepEqual(await requestWindow('sessions', {}, channel.hostId, home), {
    complete: false,
    notes: ['Bounded listing.'],
  });
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

const pageSecret = crypto.randomBytes(32);
const pageScope = sessionScopeDigest('mixed-case scope');
let pageProjections = 0;
type PageOptions = Partial<SessionPageRequest<SessionFile>> & {
  row?: (session: SessionFile) => Partial<SessionListingRow>;
  current?: (session: SessionFile) => boolean;
};

function pageFile(n: number, changes: Partial<SessionFile> = {}): SessionFile {
  return {
    agent: n % 2 ? 'codex' : 'claude',
    file: `C:/Users/Mixed/Sessions/${n}.jsonl`,
    sessionId: `session-${n}`,
    mtimeMs: 1,
    size: 10,
    dev: '7',
    ino: String(1000 + n),
    ...changes,
  };
}

function listPage(files: SessionFile[], cursor: string | null, options: PageOptions = {}): SessionPage {
  const { row, current, ...request } = options;
  const check = cursor === null ? null : readSessionCursor(cursor, pageSecret, pageScope);
  if (check && check.status !== 'valid') throw new Error(`Cursor ${check.status}.`);
  return sessionListingPage({
    sources: sessionPageSources(files),
    cursor: check?.status === 'valid' ? check.body : null,
    limit: 128,
    catalog: 'complete',
    fresh: true,
    scope: pageScope,
    secret: pageSecret,
    requester: null,
    project: ({ session }) => {
      pageProjections++;
      return {
        row: {
          id: session.sessionId,
          provider: session.agent,
          name: `Session ${session.sessionId}`,
          setup: { model: 'model', effort: 'high', source: 'recorded' },
          labels: [],
          pinned: false,
          archived: false,
          runStatus: 'done',
          attention: 'idle',
          lastActivity: 1,
          parent: null,
          agentRun: false,
          facts: 'current',
          ...row?.(session),
        },
        current: current?.(session) ?? true,
      };
    },
    ...request,
  });
}

function traverse(files: (page: number) => SessionFile[], options: (page: number) => PageOptions = () => ({})) {
  const pages: SessionPage[] = [];
  let cursor: string | null = null;
  do {
    const page = listPage(files(pages.length), cursor, options(pages.length));
    pages.push(page);
    cursor = page.next;
  } while (cursor && pages.length < 2000);
  assert.equal(cursor, null);
  return pages;
}

const pageBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
// Row sizes vary, so pages end at different distances from their budget.
const variedName = (session: SessionFile) => ({
  name: 'n'.repeat(400 + ((Number(session.sessionId.slice('session-'.length)) * 7919) % 600)),
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
  assert.equal(new Set(rows.map((row) => row.source)).size, 5);
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

test('ARC_HOME selects the registry and independent same-folder hosts retain distinct identities', async () => {
  const home = tempDir('window-home-');
  vi.stubEnv('ARC_HOME', home);
  try {
    const first = new WindowChannel();
    const second = new WindowChannel();
    channels.push(first, second);
    assert.equal(fs.existsSync(path.join(home, 'hosts')), false);
    await Promise.all([
      first.update({ ...state, scopeReady: false, folders: ['C:/MixedCase/Project'] }),
      second.update({ ...state, folders: ['C:/MixedCase/Project'] }),
    ]);
    const { windows: found, complete } = await discoverWindows();
    assert.equal(complete, true);
    assert.equal(found.length, 2);
    assert.notEqual(first.hostId, second.hostId);
    assert.equal(found.find((window) => window.hostId === first.hostId)?.scopeReady, false);
    assert.equal(JSON.stringify(found).includes('token'), false);
    assert.equal(JSON.stringify(found).includes('address'), false);
  } finally {
    vi.unstubAllEnvs();
  }
});

test('folderless hosts publish readiness and visibility changes and disappear on disposal', async () => {
  const { home, channel, file, entry } = await fixture();
  assert.deepEqual((await discoverWindows(home)).windows[0].folders, []);
  await channel.update({ folders: ['/MixedCase/Project'], scopeReady: false, panelReady: true, panelVisible: false });
  const hidden = (await discoverWindows(home)).windows[0];
  assert.deepEqual(hidden.folders, ['/MixedCase/Project']);
  assert.equal(hidden.scopeReady, false);
  assert.equal(hidden.panelReady, true);
  assert.equal(hidden.panelVisible, false);
  await channel.update({ ...state, panelReady: true, panelVisible: true });
  assert.equal((await pingWindow(entry))?.panelVisible, true);
  const socket = await connect(entry.address);
  const ended = closed(socket);
  await channel.dispose();
  await ended;
  assert.equal(fs.existsSync(file), false);
  assert.equal(await pingWindow(entry), null);
  assert.deepEqual(await discoverWindows(home), { windows: [], complete: true });
  if (process.platform !== 'win32') assert.equal(fs.existsSync(entry.address), false);
});

test.skipIf(process.platform === 'win32')(
  'POSIX registry and long-path fallback directories and files are private',
  async () => {
    const home = path.join(tempDir('long-window-home-'), 'LongMixedCase'.repeat(15));
    const channel = new WindowChannel(home);
    channels.push(channel);
    await channel.update(state);
    const file = path.join(home, 'hosts', `${channel.hostId}.json`);
    const entry = JSON.parse(fs.readFileSync(file, 'utf8')) as HostRegistration;
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(entry.address)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(entry.address).mode & 0o777, 0o600);
    await channel.dispose();
    assert.equal(fs.existsSync(path.dirname(entry.address)), false);
  },
);

test('ping refuses the wrong token without calling the handler or changing window state', async () => {
  const handler = vi.fn<(info: WindowInfo) => WindowInfo>((info) => info);
  const { entry, file } = await fixture(undefined, handler);
  const before = fs.readFileSync(file);
  const socket = await connect(entry.address);
  const received = reply(socket);
  socket.write(JSON.stringify(request(entry, { token: '0'.repeat(64) })) + '\n');
  assert.deepEqual(await received, { id: 'request-1', error: 'Access denied.' });
  assert.equal(handler.mock.calls.length, 0);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal((await pingWindow(entry))?.hostId, entry.hostId);
});

test('invalid JSON and schema receive errors', async () => {
  const { entry } = await fixture();
  for (const text of ['not JSON', JSON.stringify(request(entry, { version: 2 }))]) {
    const socket = await connect(entry.address);
    const received = reply(socket);
    socket.write(text + '\n');
    assert.deepEqual(await received, { id: null, error: 'Invalid request.' });
    socket.destroy();
  }
});

test('oversized complete and fragmented UTF-8 lines close before parsing', async () => {
  const handler = vi.fn<(info: WindowInfo) => WindowInfo>((info) => info);
  const { entry } = await fixture({ ...SESSION_REQUEST_LIMITS, lineBytes: 256 }, handler);
  const complete = JSON.stringify(request(entry, { id: 'a'.repeat(128) })) + '\n';
  const fragmented = JSON.stringify(request(entry, { requester: 'é'.repeat(128) })) + '\n';
  for (const chunks of [[complete], [fragmented.slice(0, 180), fragmented.slice(180)]]) {
    assert.equal(Buffer.byteLength(chunks.join('')) > 256, true);
    const socket = await connect(entry.address);
    const ended = closed(socket);
    for (const chunk of chunks) socket.write(chunk);
    await ended;
  }
  assert.equal(handler.mock.calls.length, 0);
});

test.each([0, 50])(
  'an unfinished line keeps its original deadline after acceptance delayed by %i ms',
  async (acceptDelay) => {
    const prototype = process.platform === 'win32' ? WindowsPipeServer.prototype : net.Server.prototype;
    const emit = prototype.emit;
    let accepted!: (connection: { socket: Duplex; accept: () => void }) => void;
    const connection = new Promise<{ socket: Duplex; accept: () => void }>((resolve) => {
      accepted = resolve;
    });
    const emission = vi.spyOn(prototype, 'emit').mockImplementation(function (
      this: net.Server | WindowsPipeServer,
      event: string | symbol,
      ...args: any[]
    ) {
      if (event !== 'connection') return emit.call(this, event, ...args);
      accepted({ socket: args[0], accept: () => emit.call(this, event, ...args) });
      return true;
    });
    try {
      const { entry } = await fixture({ ...SESSION_REQUEST_LIMITS, lineDeadlineMs: 100 });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const socket = await connect(entry.address);
      const ended = closed(socket);
      const server = await connection;
      assert.equal(vi.getTimerCount(), 0);
      await vi.advanceTimersByTimeAsync(acceptDelay);
      server.accept();
      assert.equal(vi.getTimerCount(), 1);
      const first = new Promise<Buffer>((resolve) => server.socket.once('data', resolve));
      socket.write('{');
      assert.equal((await first).toString(), '{');
      await vi.advanceTimersByTimeAsync(99);
      assert.equal(server.socket.destroyed, false);
      assert.equal(socket.destroyed, false);
      const second = new Promise<Buffer>((resolve) => server.socket.once('data', resolve));
      socket.write('"');
      assert.equal((await second).toString(), '"');
      await vi.advanceTimersByTimeAsync(1);
      assert.equal(server.socket.destroyed, true);
      await ended;
    } finally {
      emission.mockRestore();
    }
  },
);

test('open connection bounds refuse excess clients and release closed clients', async () => {
  const { entry } = await fixture({ ...SESSION_REQUEST_LIMITS, connections: 1 });
  const first = await connect(entry.address);
  const second = await connect(entry.address);
  const outcome = new Promise<string>((resolve) => {
    second.once('data', () => resolve('reply'));
    second.once('close', () => resolve('closed'));
  });
  second.write(JSON.stringify(request(entry)) + '\n');
  assert.equal(await outcome, 'closed');
  assert.equal(first.destroyed, false);
  const firstClosed = closed(first);
  first.destroy();
  await firstClosed;
  await vi.waitFor(async () => assert.equal((await pingWindow(entry))?.hostId, entry.hostId));
});

test('in-flight bounds span connections until pending handlers settle', async () => {
  let complete!: (info: WindowInfo) => void;
  const handler = vi.fn<() => Promise<WindowInfo>>(
    () =>
      new Promise<WindowInfo>((resolve) => {
        complete = resolve;
      }),
  );
  const { entry } = await fixture({ ...SESSION_REQUEST_LIMITS, inFlight: 1 }, handler);
  const first = await connect(entry.address);
  first.write(JSON.stringify(request(entry)) + '\n');
  await vi.waitFor(() => assert.equal(handler.mock.calls.length, 1));
  const second = await connect(entry.address);
  const rejected = closed(second);
  second.write(JSON.stringify(request(entry)) + '\n');
  await rejected;
  assert.equal(handler.mock.calls.length, 1);
  const received = reply(first);
  complete({ ...state, hostId: entry.hostId, pid: process.pid, version: 1 });
  assert.equal((await received).result.hostId, entry.hostId);
});

test('discovery rejects the wrong ping identity and retains uncertain ownership and arbitrary addresses', async () => {
  const { home, file, entry } = await fixture(undefined, (info) => ({ ...info, hostId: 'f'.repeat(24) }));
  assert.deepEqual(await discoverWindows(home), { windows: [], complete: false });
  assert.equal(fs.existsSync(file), true);
  const arbitrary = path.join(home, 'retain.txt');
  fs.writeFileSync(arbitrary, 'keep');
  fs.writeFileSync(file, JSON.stringify({ ...entry, address: arbitrary }));
  assert.deepEqual(await discoverWindows(home), { windows: [], complete: true });
  assert.equal(fs.readFileSync(arbitrary, 'utf8'), 'keep');
  assert.equal(fs.existsSync(file), true);
});

// These guards catch forged liveness and credential disclosure before transcript reads become available.
test('discovery rejects a forged reply process identity from an otherwise authenticated window', async () => {
  const { home, file, entry } = await fixture(undefined, (info) => ({ ...info, pid: info.pid + 1 }));
  assert.equal(await pingWindow(entry), null);
  assert.deepEqual(await discoverWindows(home), { windows: [], complete: false });
  assert.equal(fs.existsSync(file), true);
});

test('an endpoint without server knowledge receives no token or requester', async () => {
  const { entry } = await fixture();
  const otherId = 'd'.repeat(24);
  const address = hostAddress(tempDir('window-forged-'), otherId);
  if (process.platform !== 'win32') fs.mkdirSync(path.dirname(address), { recursive: true });
  const inputs: string[] = [];
  const accepted = (socket: Duplex) => {
    sockets.push(socket);
    socket.on('data', (bytes) => {
      inputs.push(bytes.toString());
      socket.end(JSON.stringify({ proof: '0'.repeat(64) }) + '\n');
    });
  };
  const server = process.platform === 'win32' ? new WindowsPipeServer() : net.createServer(accepted);
  if (server instanceof WindowsPipeServer) {
    server.on('connection', accepted);
    await server.listen(address);
  } else await new Promise<void>((resolve) => server.listen(address, resolve));
  try {
    assert.equal(await pingWindow({ ...entry, hostId: otherId, address }), null);
    assert.equal(inputs.join('').includes(entry.token), false);
    assert.equal(inputs.join('').includes('requester'), false);
    assert.equal(inputs.length, 1);
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server instanceof WindowsPipeServer) server.close();
    else await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test.skipIf(process.platform !== 'win32')('Windows rejects a forged endpoint before any bytes reach it', async () => {
  const { entry } = await fixture();
  const hostId = 'c'.repeat(24);
  const address = hostAddress('', hostId);
  const inputs: Buffer[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on('data', (bytes) => {
      inputs.push(bytes);
      socket.end('{"proof":"' + '0'.repeat(64) + '"}\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(address, resolve));
  try {
    assert.equal(await pingWindow({ ...entry, hostId, address }), null);
    assert.equal(inputs.length, 0);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test.skipIf(process.platform !== 'win32')('eight simultaneous clients reach one Windows listener', async () => {
  const { entry, file } = await fixture();
  for (let batch = 0; batch < 5; batch++) {
    const replies = await Promise.all(Array.from({ length: 8 }, () => pingWindow(entry, 1_000, file)));
    assert.deepEqual(
      replies.map((info) => info?.hostId),
      Array(8).fill(entry.hostId),
    );
  }
});

function nativeFixture(source: string) {
  const directory = tempDir('window-native-');
  const input = path.join(directory, 'bridge.cs');
  const output = path.join(directory, 'bridge.exe');
  fs.writeFileSync(input, source);
  const built = spawnSync(
    path.join(process.env.SystemRoot ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    ['/nologo', '/target:exe', `/out:${output}`, input],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(built.status, 0, built.stdout + built.stderr);
  const child = spawn(output, [], { stdio: 'pipe', windowsHide: true });
  let text = '';
  child.stdout.on('data', (bytes) => {
    text += bytes.toString();
  });
  child.stderr.on('data', (bytes) => {
    text += bytes.toString();
  });
  return {
    child,
    send: (line: string) => child.stdin.write(line + '\n'),
    wait: async (pattern: RegExp) => {
      await vi.waitFor(() => assert.match(text, pattern), { timeout: 5_000 });
      return text.match(pattern)!;
    },
    close: async () => {
      child.stdin.end();
      await vi.waitFor(() => assert.equal(child.exitCode, 0), { timeout: 5_000 });
    },
  };
}

const gatedNativeSource = () =>
  WINDOW_PIPE_SOURCE.replace(/\r\n/g, '\n')
    .replace(
      'class ArcPipe {',
      'class ArcPipe { static readonly ManualResetEvent acceptGate = new ManualResetEvent(false);',
    )
    .replace('Output("listen:" + id); first = false;', 'Output("listen:" + id); acceptGate.WaitOne(); first = false;')
    .replace('if(parts[0] == "listen")', 'if(parts[0] == "resume") acceptGate.Set(); else if(parts[0] == "listen")');

test.skipIf(process.platform !== 'win32')(
  'Windows busy opens honor deadline and cancellation before availability returns',
  async () => {
    const source = gatedNativeSource().replace(
      'if(error != 231 && error != 2)',
      'Output("busy:" + id); if(error != 231 && error != 2)',
    );
    const native = nativeFixture(source);
    const address = hostAddress('', crypto.randomBytes(12).toString('hex'));
    const encoded = Buffer.from(address).toString('base64');
    try {
      native.send(`listen:1:${encoded}`);
      await native.wait(/listen:1/);
      const occupied = await connect(address);
      native.send(`connect:2:${encoded}:${process.pid}:${native.child.pid!}::10000`);
      await native.wait(/busy:2/);
      native.send('close:2');
      await native.wait(/close:2/);
      native.send(`connect:3:${encoded}:${process.pid}:${native.child.pid!}::50`);
      await native.wait(/busy:3/);
      assert.equal((await native.wait(/close:3/))[0], 'close:3');
      occupied.destroy();
      native.send('resume:0');
    } finally {
      await native.close();
    }
  },
);

test.skipIf(process.platform !== 'win32')(
  'Windows listening survives a disconnect before native acceptance',
  async () => {
    const native = nativeFixture(gatedNativeSource());
    const address = hostAddress('', crypto.randomBytes(12).toString('hex'));
    try {
      native.send(`listen:1:${Buffer.from(address).toString('base64')}`);
      await native.wait(/listen:1/);
      const early = await connect(address);
      const ended = closed(early);
      early.destroy();
      await ended;
      native.send('resume:0');
      const next = await WindowsPipeServer.connect(address, process.pid, native.child.pid!);
      sockets.push(next);
      await new Promise<void>((resolve, reject) => {
        next.once('connect', resolve);
        next.once('close', () => reject(new Error('Listener closed after the early disconnect.')));
      });
      assert.equal((await native.wait(/accept:1:/))[0], 'accept:1:');
      next.destroy();
    } finally {
      await native.close();
    }
  },
);

test.skipIf(process.platform !== 'win32')(
  'Windows close retains the native handle until pending I/O completes',
  async () => {
    const source = WINDOW_PIPE_SOURCE.replace(/\r\n/g, '\n')
      .replace(
        'class ArcPipe {',
        'class ArcPipe { static readonly ManualResetEvent completionGate = new ManualResetEvent(false); [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetFileType(IntPtr handle);',
      )
      .replace(
        'if(bytes == null && error == 535) return true;',
        'if(bytes == null && error == 535) return true; if(bytes != null && error == 997) { Output("pending:0"); completionGate.WaitOne(); }',
      )
      .replace(
        'if(stream != null) stream.Close(); if(listener != null)',
        'if(stream != null) { stream.Close(); Output("retained:" + GetFileType(stream.handle.DangerousGetHandle())); completionGate.Set(); } if(listener != null)',
      );
    const native = nativeFixture(source);
    const address = hostAddress('', crypto.randomBytes(12).toString('hex'));
    try {
      native.send(`listen:1:${Buffer.from(address).toString('base64')}`);
      await native.wait(/listen:1/);
      const socket = await connect(address);
      const accepted = await native.wait(/accept:1:(\d+)/);
      await native.wait(/pending:0/);
      native.send(`close:${accepted[1]}`);
      assert.equal((await native.wait(/retained:3/))[0], 'retained:3');
      await native.wait(new RegExp(`close:${accepted[1]}`));
      socket.destroy();
    } finally {
      await native.close();
    }
  },
);

test.skipIf(process.platform !== 'win32')(
  'Windows excludes the machine-name UNC pipe route on each instance',
  async () => {
    const { entry } = await fixture();
    const unc = entry.address.replace('\\\\.\\pipe\\', `\\\\${process.env.COMPUTERNAME}\\pipe\\`);
    for (let index = 0; index < 2; index++) {
      assert.equal((await pingWindow(entry))?.hostId, entry.hostId);
      const socket = net.createConnection(unc);
      sockets.push(socket);
      const result = await new Promise<string>((resolve) => {
        socket.once('connect', () => {
          socket.destroy();
          resolve('connected');
        });
        socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'));
      });
      assert.notEqual(result, 'connected');
    }
  },
);

test('ping deadlines reject silent hosts and preserve a replaced registry during stale cleanup', async () => {
  const { home, file, entry } = await fixture(undefined, () => new Promise(() => {}));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const pending = discoverWindows(home);
  await vi.waitFor(() => assert.equal(vi.getTimerCount() >= 2, true));
  const replacement = JSON.stringify({ ...entry, token: 'c'.repeat(64) });
  fs.writeFileSync(file, replacement);
  await vi.advanceTimersByTimeAsync(1_000);
  assert.deepEqual(await pending, { windows: [], complete: false });
  assert.equal(fs.readFileSync(file, 'utf8'), replacement);
});

test('a saturated live listener remains discoverable after admission recovers', async () => {
  const { home, file, entry, channel } = await fixture({ ...SESSION_REQUEST_LIMITS, connections: 1 });
  const occupied = await connect(entry.address);
  const unavailable = await discoverWindows(home);
  assert.equal(fs.existsSync(file), true);
  assert.deepEqual(unavailable, { windows: [], complete: false });
  if (process.platform !== 'win32') assert.equal(fs.lstatSync(entry.address).isSocket(), true);
  occupied.destroy();
  await vi.waitFor(async () => assert.equal((await discoverWindows(home)).windows[0]?.hostId, entry.hostId));
  fs.unlinkSync(file);
  await channel.update(state);
  assert.equal((await discoverWindows(home)).windows[0]?.hostId, entry.hostId);
});

test('a ping timeout retains a silent live host until it responds again', async () => {
  const handler = vi.fn<(info: WindowInfo) => WindowInfo | Promise<WindowInfo>>(() => new Promise(() => {}));
  const { home, file, entry } = await fixture(undefined, handler);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const pending = discoverWindows(home);
  await vi.waitFor(() => assert.equal(handler.mock.calls.length, 1));
  await vi.advanceTimersByTimeAsync(1_000);
  const unavailable = await pending;
  assert.equal(fs.existsSync(file), true);
  assert.deepEqual(unavailable, { windows: [], complete: false });
  vi.useRealTimers();
  handler.mockImplementation((info) => info);
  assert.equal((await discoverWindows(home)).windows[0]?.hostId, entry.hostId);
});

test('invalid registry prefixes do not consume the live-host allowance', async () => {
  const { home, entry } = await fixture();
  for (let index = 0; index < 256; index++) {
    fs.writeFileSync(path.join(home, 'hosts', `${index.toString(16).padStart(24, '0')}.json`), '{}');
  }
  const result = await discoverWindows(home);
  assert.deepEqual(
    result.windows.map((window) => window.hostId),
    [entry.hostId],
  );
  assert.equal(result.complete, true);
});

test('directory coverage is explicitly incomplete at a bounded iteration limit', async () => {
  const home = tempDir('window-population-');
  const directory = path.join(home, 'hosts');
  fs.mkdirSync(directory);
  for (let index = 0; index <= WINDOW_DISCOVERY_LIMITS.directoryEntries; index++) {
    fs.writeFileSync(path.join(directory, `unrelated-${index}`), '');
  }
  const original = fs.promises.opendir;
  const enumerate = vi.spyOn(filesystem, 'readdirSync').mockImplementation(() => {
    throw new Error('Unbounded registry enumeration');
  });
  syncBuiltinESMExports();
  let reads = () => 0;
  let closes = () => 0;
  const opened = vi.spyOn(fs.promises, 'opendir').mockImplementation(async (...args) => {
    const handle = await original(...args);
    const read = vi.spyOn(handle, 'read');
    const close = vi.spyOn(handle, 'close');
    reads = () => read.mock.calls.length;
    closes = () => close.mock.calls.length;
    return handle;
  });
  try {
    assert.deepEqual(await discoverWindows(home), { windows: [], complete: false });
    assert.equal(reads(), WINDOW_DISCOVERY_LIMITS.directoryEntries + 1);
    assert.equal(closes(), 1);
    assert.equal(enumerate.mock.calls.length, 0);
  } finally {
    opened.mockRestore();
    enumerate.mockRestore();
    syncBuiltinESMExports();
  }
});

test('a host population beyond the ping allowance returns an explicitly partial list', async () => {
  const home = tempDir('window-host-limit-');
  const population = Array.from({ length: WINDOW_DISCOVERY_LIMITS.hosts + 1 }, () => new WindowChannel(home));
  channels.push(...population);
  await Promise.all(population.map((channel) => channel.update(state)));
  const result = await discoverWindows(home);
  assert.equal(result.complete, false);
  assert.equal(result.windows.length, WINDOW_DISCOVERY_LIMITS.hosts);
});

test('publication never enumerates the shared registry to remove atomic temporaries', async () => {
  const { channel } = await fixture();
  const enumerate = vi.spyOn(filesystem, 'readdirSync').mockImplementation(() => {
    throw new Error('Shared registry enumeration');
  });
  syncBuiltinESMExports();
  try {
    await channel.update({ ...state, panelReady: true });
    assert.equal(enumerate.mock.calls.length, 0);
  } finally {
    enumerate.mockRestore();
    syncBuiltinESMExports();
  }
});

test('connection creation failure retains live ownership and closes the registry directory', async () => {
  const { home, file } = await fixture();
  const original = fs.promises.opendir;
  let closeCalls = () => 0;
  const opened = vi.spyOn(fs.promises, 'opendir').mockImplementation(async (...args) => {
    const directory = await original(...args);
    const close = vi.spyOn(directory, 'close');
    closeCalls = () => close.mock.calls.length;
    return directory;
  });
  const connection =
    process.platform === 'win32'
      ? vi.spyOn(WindowsPipeServer, 'connect').mockImplementation(async () => {
          throw Object.assign(new Error('Connection unavailable'), { code: 'EMFILE' });
        })
      : vi.spyOn(network, 'createConnection').mockImplementation(() => {
          throw Object.assign(new Error('Connection unavailable'), { code: 'EMFILE' });
        });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await discoverWindows(home), { windows: [], complete: false });
    assert.equal(fs.existsSync(file), true);
    assert.equal(closeCalls(), 1);
  } finally {
    connection.mockRestore();
    opened.mockRestore();
    syncBuiltinESMExports();
  }
});

test('only confirmed process death removes unchanged registry bytes and never a foreign socket', async () => {
  const { home, file, entry, channel } = await fixture();
  await channel.dispose();
  const dead = JSON.stringify({ ...entry, pid: 424242 });
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('Stopped'), { code: 'ESRCH' });
  });
  try {
    fs.writeFileSync(file, dead);
    assert.deepEqual(await discoverWindows(home), { windows: [], complete: true });
    assert.equal(fs.existsSync(file), false);
    fs.writeFileSync(file, dead);
    kill.mockImplementation(() => {
      throw Object.assign(new Error('Denied'), { code: 'EPERM' });
    });
    assert.deepEqual(await discoverWindows(home), { windows: [], complete: false });
    assert.equal(fs.readFileSync(file, 'utf8'), dead);
    const replacement = JSON.stringify({ ...entry, pid: 424242, token: 'c'.repeat(64) });
    kill.mockImplementation(() => {
      fs.writeFileSync(file, replacement);
      throw Object.assign(new Error('Stopped'), { code: 'ESRCH' });
    });
    assert.deepEqual(await discoverWindows(home), { windows: [], complete: false });
    assert.equal(fs.readFileSync(file, 'utf8'), replacement);
  } finally {
    kill.mockRestore();
  }
});

test('POSIX discovery preserves socket ownership after a registered process dies', async () => {
  const { home, file, entry, channel } = await fixture();
  await channel.dispose();
  const address = hostAddress(home, entry.hostId, 'linux', '/Host/Temporary');
  fs.writeFileSync(file, JSON.stringify({ ...entry, pid: 424242, address }));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const lstat = filesystem.lstatSync;
  const inspection = vi.spyOn(filesystem, 'lstatSync').mockImplementation((target: fs.PathLike) => {
    assert.notEqual(target, address, 'Discovery cannot establish socket ownership from a stopped PID.');
    return lstat(target);
  });
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('Stopped'), { code: 'ESRCH' });
  });
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await discoverWindows(home), { windows: [], complete: true });
    assert.equal(fs.existsSync(file), false);
    assert.equal(
      inspection.mock.calls.some(([target]) => target === address),
      false,
    );
  } finally {
    Object.defineProperty(process, 'platform', platform);
    inspection.mockRestore();
    kill.mockRestore();
    syncBuiltinESMExports();
  }
});

test('discovery uses the published fallback from a different temporary environment', async () => {
  const { home, file, entry } = await fixture();
  const longHome = path.join(home, 'MixedCase'.repeat(20));
  fs.mkdirSync(path.join(longHome, 'hosts'), { recursive: true });
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const createConnection = net.createConnection;
  const published = hostAddress(longHome, entry.hostId, 'linux', '/Host/TemporaryMixedCase');
  assert.equal(published.startsWith('/Host/TemporaryMixedCase/'), true);
  fs.writeFileSync(
    path.join(longHome, 'hosts', `${entry.hostId}.json`),
    JSON.stringify({ ...entry, address: published }),
  );
  const connections = vi.spyOn(network, 'createConnection').mockImplementation((address: string) => {
    assert.equal(address, published);
    return createConnection(entry.address);
  });
  syncBuiltinESMExports();
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  try {
    vi.stubEnv('TMPDIR', '/Client/OtherTemporary');
    assert.equal((await discoverWindows(longHome)).windows[0]?.hostId, entry.hostId);
    assert.equal(connections.mock.calls.length, 1);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    connections.mockRestore();
    syncBuiltinESMExports();
    vi.unstubAllEnvs();
    fs.writeFileSync(file, JSON.stringify(entry));
  }
});

test('ping identifies Claude and Codex requesters and leaves an absent requester unknown', async () => {
  const requests: any[] = [];
  const { entry } = await fixture();
  const otherId = 'e'.repeat(24);
  const address = hostAddress(tempDir('window-requester-'), otherId);
  if (process.platform !== 'win32') fs.mkdirSync(path.dirname(address), { recursive: true });
  const accepted = (socket: Duplex) => {
    sockets.push(socket);
    socket.on('error', () => {});
    socket.on('data', (bytes) => {
      const input = JSON.parse(bytes.toString());
      if (input.challenge) {
        socket.write(
          JSON.stringify({
            proof: crypto.createHmac('sha256', Buffer.from(entry.token, 'hex')).update(input.challenge).digest('hex'),
          }) + '\n',
        );
        return;
      }
      requests.push(input);
      socket.end(
        JSON.stringify({
          id: input.id,
          result: { ...state, hostId: otherId, pid: process.pid, version: 1, token: entry.token, address },
        }) + '\n',
      );
    });
  };
  const server = process.platform === 'win32' ? new WindowsPipeServer() : net.createServer(accepted);
  if (server instanceof WindowsPipeServer) {
    server.on('connection', accepted);
    await server.listen(address);
  } else await new Promise<void>((resolve) => server.listen(address, resolve));
  try {
    const cases: [string, string, string | null][] = [
      ['claude-session', 'codex-session', 'claude-session'],
      ['', 'codex-session', 'codex-session'],
      ['', '', null],
    ];
    for (const [claude, codex, expected] of cases) {
      vi.stubEnv('CLAUDE_CODE_SESSION_ID', claude);
      vi.stubEnv('CODEX_THREAD_ID', codex);
      const result = await pingWindow({ ...entry, hostId: otherId, address });
      assert.equal(result?.hostId, otherId);
      assert.equal('token' in result, false);
      assert.equal('address' in result, false);
      assert.equal(requests.at(-1).requester, expected);
    }
  } finally {
    vi.unstubAllEnvs();
    for (const socket of sockets) socket.destroy();
    if (server instanceof WindowsPipeServer) server.close();
    else await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('disposal during listener startup removes the listener without publishing a registry', async () => {
  const home = tempDir('window-start-close-');
  const channel = new WindowChannel(home);
  channels.push(channel);
  const start = channel.update(state);
  await channel.dispose();
  await start;
  assert.deepEqual(await discoverWindows(home), { windows: [], complete: true });
  assert.equal(fs.existsSync(hostAddress(home, channel.hostId)), false);
});

test('constructor failure leaves an activation spawner without a foreign window target', () => {
  let channel: WindowChannel | null = null;
  const create = vi.spyOn(network, 'createServer').mockImplementation(() => {
    throw new Error('Listener unavailable');
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => {
      channel = new WindowChannel(tempDir('window-constructor-failed-'));
    }, /Listener unavailable/);
    const spawner = arcCliSpawner(
      () => ({ directory: 'Arc bin', editorExecutable: '/editor', windowId: channel?.windowId ?? null }),
      (_command, _args, cwd, wanted, agent, cli) => {
        assert.equal(childEnv({ ARC_WINDOW: 'foreign-window' }, wanted, agent, cwd, cli).ARC_WINDOW, undefined);
        return {} as never;
      },
    );
    spawner('unused', [], '.', {});
  } finally {
    create.mockRestore();
    syncBuiltinESMExports();
  }
});

test('activation spawners clear their window target after asynchronous startup and later channel failures', async () => {
  for (const failure of ['directory', 'listener-start', 'publish-start', 'listener-later', 'publish-later']) {
    const home = tempDir('window-failed-target-');
    const original = network.createServer;
    let server: net.Server | null = null;
    const create = vi
      .spyOn(network, 'createServer')
      .mockImplementation((...args: Parameters<typeof network.createServer>) => {
        server = original(...args);
        return server;
      });
    syncBuiltinESMExports();
    let channel: WindowChannel;
    try {
      channel = new WindowChannel(home);
      channels.push(channel);
    } finally {
      create.mockRestore();
      syncBuiltinESMExports();
    }
    const targets: (string | undefined)[] = [];
    const spawner = arcCliSpawner(
      () => ({ directory: 'Arc bin', editorExecutable: '/editor', windowId: channel.windowId }),
      (_command, _args, cwd, wanted, agent, cli) => {
        targets.push(childEnv({ ARC_WINDOW: 'foreign-window' }, wanted, agent, cwd, cli).ARC_WINDOW);
        return {} as never;
      },
    );
    spawner('unused', [], '.', {});
    const oversized = { ...state, folders: ['x'.repeat(100_000)] };
    if (failure === 'directory') {
      fs.writeFileSync(path.join(home, 'hosts'), 'not a directory');
      await assert.rejects(channel.update(state));
    } else if (failure === 'listener-start') {
      const listen =
        process.platform === 'win32'
          ? vi.spyOn(WindowsPipeServer.prototype, 'listen').mockRejectedValue(new Error('Listener unavailable'))
          : vi.spyOn(server!, 'listen').mockImplementation(() => {
              queueMicrotask(() => server!.emit('error', new Error('Listener unavailable')));
              return server!;
            });
      try {
        await assert.rejects(channel.update(state), /Listener unavailable/);
      } finally {
        listen.mockRestore();
      }
    } else if (failure === 'publish-start') {
      await assert.rejects(channel.update(oversized), /too large/);
    } else {
      await channel.update(state);
      if (failure === 'publish-later') await assert.rejects(channel.update(oversized), /too large/);
      else server!.emit('error', new Error('Listener unavailable'));
    }
    spawner('unused', [], '.', {});
    assert.deepEqual(targets, [channel.hostId, undefined], failure);
    await channel.dispose();
  }
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
