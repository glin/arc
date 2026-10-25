import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import filesystem from 'node:fs';
import * as net from 'node:net';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Duplex, PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { buildSync } from 'esbuild';
import { WindowsPipeServer, PipeBridge, type WindowTransportRecord } from './windowpipe.ts';
import network from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import * as path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { tempDir } from './temproot.ts';
import { SESSION_READ_LIMITS, type SessionPage } from './sessionreads.ts';
import { terminalOwnership, type ProcessAncestry, type TerminalShell } from './terminalownership.ts';
import { requestWindow } from './sessionrequests.ts';
import { arcCliSpawner, childEnv } from './agenthost.ts';
import { DispatchReceipts } from './dispatchreceipts';
import { HostedDispatch } from './dispatchhost';
import {
  discoverWindows,
  hostAddress,
  parseSessionRequest,
  pingWindow,
  SESSION_REQUEST_LIMITS,
  WindowChannel,
  type HostRegistration,
  type WindowInfo,
} from './sessionrequests.ts';

import { state, request, closed, reply, createWindowFixtures } from '../test/window-channel';

import { pageFile, pageBytes, variedName, createSessionPages } from '../test/session-pages';

import { compactPayload } from '../test/compact-request';

const ancestryRead = vi.hoisted(() => ({ failure: null as Error | null }));
vi.mock('./terminalownership.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./terminalownership.ts')>()),
  collectProcessAncestry: async (): Promise<ProcessAncestry> => {
    if (ancestryRead.failure) throw ancestryRead.failure;
    return {
      platform: process.platform as ProcessAncestry['platform'],
      chain: [{ pid: process.pid, parent: 0, birth: callerBirth }],
    };
  },
}));

const sockets: Duplex[] = [];

const channels: WindowChannel[] = [];

const { listPage } = createSessionPages();

const { fixture, connect } = createWindowFixtures(channels, sockets);

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(channels.splice(0).map((channel) => channel.dispose()));
});

// Terminal cases route on a fixed caller ancestry and fixed identities.
// The real process table can take longer than the product deadline on a loaded machine.
// terminalownership.test.ts reads the real process table.
const callerBirth = '1000';

const identities = async (pids: number[]) => pids.map((pid) => ({ pid, birth: callerBirth }));

// These cases keep clocks controlled while exercising the activation's publication and disposal boundaries.
async function recoveryFixture(pending = false) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const servers: WindowsPipeServer[] = [];
  const ready: (() => void)[] = [];
  const listen = vi.spyOn(WindowsPipeServer.prototype, 'listen').mockImplementation(function (this: WindowsPipeServer) {
    servers.push(this);
    return new Promise<void>((resolve) => {
      const acknowledge = () => {
        this.pid = 1000 + servers.indexOf(this);
        resolve();
      };
      ready.push(acknowledge);
      if (!pending) acknowledge();
    });
  });
  const close = vi.spyOn(WindowsPipeServer.prototype, 'close').mockResolvedValue();
  const home = tempDir('window-recovery-');
  const channel = new WindowChannel(home);
  const file = path.join(home, 'hosts', `${channel.hostId}.json`);
  const started = channel.update(state);
  if (!pending) await started;
  const settle = async () => {
    await (channel as unknown as { retirement: Promise<void> }).retirement;
  };
  return {
    channel,
    file,
    servers,
    ready,
    started,
    close,
    settle,
    fail: () => servers.at(-1)!.emit('error', new Error('Fixture listener unavailable')),
    finish: async () => {
      for (const acknowledge of ready) acknowledge();
      await channel.dispose();
      listen.mockRestore();
      close.mockRestore();
      vi.useRealTimers();
      Object.defineProperty(process, 'platform', descriptor);
    },
  };
}

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
  const start = {
    setup: { kind: 'custom', agent: 'claude', model: '', effort: '', permissionMode: '' },
    prompt: 'coordinate',
    agentRun: true,
  };
  for (const params of [start, { ...start, cacheLifetime: '5m' }, { ...start, cacheLifetime: '1h' }]) {
    const accepted = { ...valid, method: 'start', params };
    assert.deepEqual(parseSessionRequest(accepted), accepted);
  }
  for (const cacheLifetime of ['2h', '1H', '', null, 3600, ['1h']])
    assert.equal(parseSessionRequest({ ...valid, method: 'start', params: { ...start, cacheLifetime } }), null);
});

test(
  'session requests reject paths, extra parameters, and invalid turn counts before dispatch',
  { tags: ['subprocess'] },
  async () => {
    for (const key of ['TERM_PROGRAM', 'VSCODE_PID', 'VSCODE_IPC_HOOK_CLI']) vi.stubEnv(key, '');
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
  },
);

test.each(['sessions', 'session', 'setups', 'compact-ready', 'compact-status'] as const)(
  'a busy ready window answers %s reads after the discovery deadline',
  { tags: ['subprocess'] },
  async (method) => {
    const { home, channel } = await fixture();
    await channel.update({ ...state, panelReady: true, panelVisible: true });
    let answer!: (value: unknown) => void;
    const handler = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    channel.setRequestHandler(handler);
    channel.setCompactRequestHandler(handler);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const params =
      method === 'session'
        ? { sessionId: 'known', turns: 1 }
        : method === 'compact-status'
          ? { requestId: channel.hostId + ':aaaaaaaa-1111-2222-3333-444444444444' }
          : method === 'compact-ready'
            ? {
                ...compactPayload,
                window: channel.hostId,
                requestId: channel.hostId + ':aaaaaaaa-1111-2222-3333-444444444444',
              }
            : {};
    const result = requestWindow(method, params, channel.hostId, home);
    const completed = result.then(
      (value) => ({ value }),
      (error: Error) => ({ error: error.message }),
    );
    await vi.waitFor(() => assert.equal(typeof answer, 'function'));
    await vi.advanceTimersByTimeAsync(2_100);
    answer({ sessionId: 'known', turns: [{ responseSummary: 'Still available.' }] });
    assert.deepEqual(await completed, {
      value: { sessionId: 'known', turns: [{ responseSummary: 'Still available.' }] },
    });
  },
);

test.each(['sessions', 'session'] as const)(
  'a silent ready window bounds %s reads and names the timeout',
  { tags: ['subprocess'] },
  async (method) => {
    const { home, channel, file } = await fixture();
    await channel.update({ ...state, panelReady: true, panelVisible: true });
    let admitted = false;
    channel.setRequestHandler(() => {
      admitted = true;
      return new Promise(() => {});
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const result = requestWindow(
      method,
      method === 'session' ? { sessionId: 'known', turns: 1 } : {},
      channel.hostId,
      home,
    );
    const rejection = assert.rejects(result, /The selected Arc window did not answer in time\./);
    await vi.waitFor(() => assert.equal(admitted, true));
    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
    assert.equal(fs.existsSync(file), true);
  },
);

test.runIf(process.platform === 'win32')(
  'a vanished Windows pipe remains unavailable when a session read expires before connecting',
  { tags: ['subprocess'] },
  async () => {
    const { home, entry } = await fixture();
    const hostId = crypto.randomBytes(12).toString('hex');
    const address = hostAddress(home, hostId);
    const file = path.join(home, 'hosts', `${hostId}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...entry, hostId, address }));
    const connect = WindowsPipeServer.connect;
    let socket: Duplex | undefined;
    let connected = false;
    vi.spyOn(WindowsPipeServer, 'connect').mockImplementation(async (...args) => {
      socket = await connect(...args);
      socket.on('connect', () => {
        connected = true;
      });
      return socket;
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const result = requestWindow('session', { sessionId: 'known', turns: 1 }, hostId, home);
    const completed = result.then(
      (value) => ({ value }),
      (error: Error) => ({ error: error.message }),
    );
    await vi.waitFor(() => assert.ok(socket));
    await vi.advanceTimersByTimeAsync(5_000);
    assert.deepEqual(await completed, { error: 'The selected Arc window is unavailable.' });
    assert.equal(connected, false);
    assert.equal(fs.existsSync(file), true);
  },
);

test(
  'a disconnected or unreadable window remains unavailable for session reads',
  { tags: ['subprocess'] },
  async () => {
    const { home, channel, file } = await fixture();
    let admitted = false;
    channel.setRequestHandler(() => {
      admitted = true;
      return new Promise(() => {});
    });
    const result = requestWindow('session', { sessionId: 'known', turns: 1 }, channel.hostId, home);
    const rejection = assert.rejects(result, /The selected Arc window is unavailable\./);
    await vi.waitFor(() => assert.equal(admitted, true));
    await channel.dispose();
    await rejection;
    fs.writeFileSync(file, '{}');
    await assert.rejects(
      requestWindow('sessions', {}, channel.hostId, home),
      /The selected Arc window is unavailable\./,
    );
  },
);

test(
  'session replies with valid large window metadata refuse excess envelope bytes without losing the channel',
  { tags: ['subprocess'] },
  async () => {
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
  },
);

test(
  'folderless hosts publish readiness and visibility changes and disappear on disposal',
  { tags: ['subprocess'] },
  async () => {
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
  },
);

test(
  'ping refuses the wrong token without calling the handler or changing window state',
  { tags: ['subprocess'] },
  async () => {
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
  },
);

test('invalid JSON and schema receive errors', { tags: ['subprocess'] }, async () => {
  const { entry } = await fixture();
  for (const text of ['not JSON', JSON.stringify(request(entry, { version: 2 }))]) {
    const socket = await connect(entry.address);
    const received = reply(socket);
    socket.write(text + '\n');
    assert.deepEqual(await received, { id: null, error: 'Invalid request.' });
    socket.destroy();
  }
});

test('oversized complete and fragmented UTF-8 lines close before parsing', { tags: ['subprocess'] }, async () => {
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
  { tags: ['subprocess'] },
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

test('open connection bounds refuse excess clients and release closed clients', { tags: ['subprocess'] }, async () => {
  const { entry } = await fixture({ ...SESSION_REQUEST_LIMITS, connections: 1 });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const first = await connect(entry.address);
    const received = reply(first);
    const firstRequest = request(entry);
    first.write(JSON.stringify(firstRequest) + '\n');
    const response = await received;
    assert.equal(response.id, firstRequest.id);
    assert.equal(response.result.hostId, entry.hostId);
    assert.equal(response.result.pid, entry.pid);
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
    vi.useRealTimers();
    await vi.waitFor(async () => assert.equal((await pingWindow(entry))?.hostId, entry.hostId));
  } finally {
    vi.useRealTimers();
  }
});

test('in-flight bounds span connections until pending handlers settle', { tags: ['subprocess'] }, async () => {
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

test(
  'discovery rejects the wrong ping identity and retains uncertain ownership and arbitrary addresses',
  { tags: ['subprocess'] },
  async () => {
    const { home, file, entry } = await fixture(undefined, (info) => ({ ...info, hostId: 'f'.repeat(24) }));
    assert.deepEqual(await discoverWindows(home), { windows: [], complete: false });
    assert.equal(fs.existsSync(file), true);
    const arbitrary = path.join(home, 'retain.txt');
    fs.writeFileSync(arbitrary, 'keep');
    fs.writeFileSync(file, JSON.stringify({ ...entry, address: arbitrary }));
    assert.deepEqual(await discoverWindows(home), { windows: [], complete: true });
    assert.equal(fs.readFileSync(arbitrary, 'utf8'), 'keep');
    assert.equal(fs.existsSync(file), true);
  },
);

// These guards catch forged liveness and credential disclosure before transcript reads become available.
test(
  'discovery rejects a forged reply process identity from an otherwise authenticated window',
  { tags: ['subprocess'] },
  async () => {
    const { home, file, entry } = await fixture(undefined, (info) => ({ ...info, pid: info.pid + 1 }));
    assert.equal(await pingWindow(entry), null);
    assert.deepEqual(await discoverWindows(home), { windows: [], complete: false });
    assert.equal(fs.existsSync(file), true);
  },
);

test('an endpoint without server knowledge receives no token or requester', { tags: ['subprocess'] }, async () => {
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
    if (server instanceof WindowsPipeServer) await server.close();
    else await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test.skipIf(process.platform !== 'win32')(
  'Windows rejects a forged endpoint before any bytes reach it',
  { tags: ['subprocess'] },
  async () => {
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
  },
);

test.skipIf(process.platform !== 'win32')(
  'eight simultaneous clients reach one Windows listener',
  { tags: ['subprocess'] },
  async () => {
    const { entry, file } = await fixture();
    for (let batch = 0; batch < 5; batch++) {
      const replies = await Promise.all(Array.from({ length: 8 }, () => pingWindow(entry, 1_000, file)));
      assert.deepEqual(
        replies.map((info) => info?.hostId),
        Array(8).fill(entry.hostId),
      );
    }
  },
);

test(
  'channel disposal reports exact registration ownership outcomes and classified removal failure',
  { tags: ['subprocess'] },
  async () => {
    for (const outcome of ['noExpectedBytes', 'ownershipMismatch', 'removed', 'failed'] as const) {
      const records: WindowTransportRecord[] = [];
      const home = tempDir('window-removal-evidence-');
      const channel = new WindowChannel(home);
      channels.push(channel);
      channel.setDiagnostics((_event, record) => records.push(record));
      const file = path.join(home, 'hosts', `${channel.hostId}.json`);
      if (outcome !== 'noExpectedBytes') await channel.update(state);
      if (outcome === 'ownershipMismatch') fs.writeFileSync(file, 'private-registration');
      const unlink = filesystem.unlinkSync;
      const mocked = vi.spyOn(filesystem, 'unlinkSync').mockImplementation((target) => {
        if (outcome === 'failed' && target === file)
          throw Object.assign(new Error('private-registration'), { code: 'EBUSY' });
        return unlink(target);
      });
      syncBuiltinESMExports();
      try {
        await channel.dispose();
        await channel.dispose();
      } finally {
        mocked.mockRestore();
        syncBuiltinESMExports();
      }
      assert.deepEqual(
        records
          .filter((record) => ['channelDispose', 'registrationRemoval'].includes(record.reason))
          .map((record) => record.reason),
        ['channelDispose', 'registrationRemoval'],
      );
      const removal = records.find((record) => record.reason === 'registrationRemoval')!;
      assert.equal(removal.outcome, outcome);
      assert.equal(removal.registrationRemoved, outcome === 'removed');
      if (outcome === 'failed') assert.deepEqual([removal.stage, removal.errorCode], ['unlink', 'EBUSY']);
      if (outcome === 'ownershipMismatch') assert.equal(fs.readFileSync(file, 'utf8'), 'private-registration');
      assert.equal(JSON.stringify(records).includes('private-registration'), false);
      assert.equal(JSON.stringify(records).includes(home), false);
    }
  },
);

test.each(['linux', 'darwin'] as const)(
  '%s disposal reports completed cleanup when the closed listener socket is absent',
  { tags: ['subprocess'] },
  async (platform) => {
    for (const fallback of [false, true]) {
      for (const errorCode of ['ENOENT', 'EACCES', 'EIO']) {
        const home = tempDir('window-closed-socket-');
        const channel = new WindowChannel(home);
        channels.push(channel);
        const directory = path.join(home, fallback ? 'socket' : 'hosts');
        fs.mkdirSync(path.join(home, 'hosts'));
        if (fallback) fs.mkdirSync(directory);
        const address = path.join(directory, 'closed.sock');
        const file = path.join(home, 'hosts', `${channel.hostId}.json`);
        fs.writeFileSync(file, 'owned-registration');
        Object.assign(channel, { address, registeredBytes: 'owned-registration' });
        assert.equal(fs.existsSync(address), false);
        const records: WindowTransportRecord[] = [];
        channel.setDiagnostics((_event, record) => records.push(record));
        const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
        const original = filesystem.lstatSync;
        const stat = vi.spyOn(filesystem, 'lstatSync').mockImplementation((...args) => {
          if (args[0] === address && errorCode !== 'ENOENT')
            throw Object.assign(new Error('private-socket'), { code: errorCode });
          return original(...args);
        });
        syncBuiltinESMExports();
        Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
        try {
          await channel.dispose();
        } finally {
          Object.defineProperty(process, 'platform', descriptor);
          stat.mockRestore();
          syncBuiltinESMExports();
        }
        assert.equal(fs.existsSync(file), false);
        assert.equal(fs.existsSync(directory), !fallback);
        const removal = records.find((record) => record.reason === 'registrationRemoval')!;
        assert.equal(removal.registrationRemoved, true);
        assert.equal(removal.outcome, errorCode === 'ENOENT' ? 'removed' : 'failed');
        if (errorCode === 'ENOENT') assert.equal(removal.errorCode, undefined);
        else assert.deepEqual([removal.stage, removal.errorCode], ['socketStat', errorCode]);
        assert.equal(JSON.stringify(records).includes('private-socket'), false);
      }
    }
  },
);

test(
  'channel setup rejection retains error and disposal evidence before registration exists',
  { tags: ['subprocess'] },
  async () => {
    const home = tempDir('window-setup-evidence-');
    fs.writeFileSync(path.join(home, 'hosts'), 'private-registration');
    const records: WindowTransportRecord[] = [];
    const channel = new WindowChannel(home);
    channels.push(channel);
    channel.setDiagnostics((_event, record) => records.push(record));
    await assert.rejects(channel.update(state));
    await channel.dispose();
    assert.deepEqual(
      records.map((record) => record.reason),
      ['channelSetupRejected', 'channelDispose', 'registrationRemoval'],
    );
    assert.equal(JSON.stringify(records).includes('private-registration'), false);
  },
);

test(
  'channel listener failure records its classified error and leaves diagnostics failure harmless',
  { tags: ['subprocess'] },
  async () => {
    const { channel, file } = await fixture();
    const records: WindowTransportRecord[] = [];
    channel.setDiagnostics((_event, record) => {
      records.push(record);
      throw new Error('secret');
    });
    const server = (channel as unknown as { server: net.Server }).server;
    assert.doesNotThrow(() => server.emit('error', Object.assign(new Error('secret'), { code: 'EIO' })));
    await channel.dispose();
    assert.deepEqual(
      records
        .filter((record) => record.reason === 'channelError' || record.reason === 'channelDispose')
        .map((record) => record.reason),
      ['channelError', 'channelDispose'],
    );
    assert.equal(records[0].errorCode, 'EIO');
    assert.equal(fs.existsSync(file), false);
    assert.equal(JSON.stringify(records).includes('secret'), false);
  },
);

test('one activation replaces failed listeners with bounded retries and ignores obsolete errors', async () => {
  const f = await recoveryFixture();
  try {
    const entry = JSON.parse(fs.readFileSync(f.file, 'utf8')) as HostRegistration;
    for (const [index, delay] of [100, 500, 2000].entries()) {
      f.fail();
      await f.settle();
      await vi.advanceTimersByTimeAsync(delay - 1);
      assert.equal(f.servers.length, index + 1);
      await vi.advanceTimersByTimeAsync(1);
      assert.equal(f.servers.length, index + 2);
      const next = JSON.parse(fs.readFileSync(f.file, 'utf8')) as HostRegistration;
      assert.equal(next.hostId, entry.hostId);
      assert.equal(next.token, entry.token);
      assert.equal(next.address, entry.address);
      assert.equal(next.transportPid, 1001 + index);
      f.servers[index].emit('error', new Error('Obsolete listener'));
      const obsolete = new PassThrough();
      f.servers[index].emit('connection', obsolete);
      assert.equal(obsolete.destroyed, true);
      await f.settle();
      assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).transportPid, next.transportPid);
    }
    f.fail();
    await f.settle();
    assert.equal(f.channel.windowId, null);
    await f.channel.dispose();
    assert.equal(fs.existsSync(f.file), false);
    await vi.advanceTimersByTimeAsync(100_000);
    assert.equal(f.servers.length, 4);
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    await f.finish();
  }
});

test('thirty continuously healthy seconds reset recovery and disposal cancels a queued retry', async () => {
  const f = await recoveryFixture();
  try {
    f.fail();
    await f.settle();
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(29_999);
    f.fail();
    await f.settle();
    await vi.advanceTimersByTimeAsync(499);
    assert.equal(f.servers.length, 2);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(30_000);
    f.fail();
    await f.settle();
    await vi.advanceTimersByTimeAsync(100);
    assert.equal(f.servers.length, 4);
    f.fail();
    await f.settle();
    await f.channel.dispose();
    await vi.advanceTimersByTimeAsync(100_000);
    assert.equal(f.servers.length, 4);
    assert.equal(vi.getTimerCount(), 0);
    assert.equal(fs.existsSync(f.file), false);
  } finally {
    await f.finish();
  }
});

test('pending listener publication retains updates and read capability without publishing an obsolete PID', async () => {
  const f = await recoveryFixture(true);
  try {
    const updated = f.channel.update({ ...state, panelReady: true });
    f.channel.setGuardedReadHandler(async () => ({ status: 'refused' }) as never);
    assert.equal(fs.existsSync(f.file), false);
    f.ready[0]();
    await Promise.all([f.started, updated]);
    assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).panelReady, true);
    assert.ok(JSON.parse(fs.readFileSync(f.file, 'utf8')).capabilities.includes('sessionRead'));
    f.fail();
    await f.settle();
    await vi.advanceTimersByTimeAsync(100);
    const before = fs.readFileSync(f.file, 'utf8');
    const update = f.channel.update({ ...state, panelVisible: true });
    f.channel.setGuardedReadHandler(async () => ({ status: 'refused' }) as never);
    assert.equal(fs.readFileSync(f.file, 'utf8'), before);
    const disposed = f.channel.dispose();
    f.ready[1]();
    await Promise.all([disposed, update]);
    assert.equal(fs.existsSync(f.file), false);
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    await f.finish();
  }
});

test('replacement waits for retirement and disposal before initial acknowledgement prevents resurrection', async () => {
  const f = await recoveryFixture(true);
  try {
    const disposed = f.channel.dispose();
    f.ready[0]();
    await Promise.all([disposed, f.started]);
    await vi.advanceTimersByTimeAsync(100_000);
    assert.equal(f.servers.length, 1);
    assert.equal(fs.existsSync(f.file), false);
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    await f.finish();
  }
  const g = await recoveryFixture();
  let retired!: () => void;
  g.close.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        retired = resolve;
      }),
  );
  try {
    g.fail();
    await vi.advanceTimersByTimeAsync(100_000);
    assert.equal(g.servers.length, 1);
    retired();
    await g.settle();
    await vi.advanceTimersByTimeAsync(100);
    assert.equal(g.servers.length, 2);
  } finally {
    retired?.();
    await g.finish();
  }
});

test.skipIf(process.platform !== 'win32')(
  'disposal during native listener submission leaves no listener while a shared peer stays reachable',
  { tags: ['subprocess'] },
  async () => {
    const peer = await fixture();
    const channel = new WindowChannel(tempDir('window-startup-disposal-'));
    channels.push(channel);
    const server = (channel as unknown as { windowsServer: WindowsPipeServer }).windowsServer;
    const address = (channel as unknown as { address: string }).address;
    const file = (channel as unknown as { registryFile: string }).registryFile;
    const send = PipeBridge.prototype.send;
    let disposal: Promise<void> | undefined;
    const submission = vi.spyOn(PipeBridge.prototype, 'send').mockImplementation(function (
      this: PipeBridge,
      line: string,
      callback?: (error?: Error | null) => void,
    ) {
      send.call(this, line, callback);
      if (line.startsWith(`listen:${server.id}:`)) disposal = channel.dispose();
    });
    const replacement = new WindowsPipeServer();
    replacement.on('error', () => {});
    try {
      await channel.update(state);
      assert.ok(disposal, 'Disposal did not run at native listen submission');
      await disposal;
      assert.equal(channel.windowId, null);
      assert.equal(server.pid, 0);
      assert.equal(fs.existsSync(file), false);
      await vi.waitFor(
        async () => {
          const socket = net.createConnection(address);
          const outcome = await new Promise<string>((resolve) => {
            socket.once('connect', () => resolve('connected'));
            socket.once('error', () => resolve('unavailable'));
          });
          socket.destroy();
          assert.equal(outcome, 'unavailable', 'Disposed native listener still accepts connections');
        },
        { timeout: 5_000 },
      );
      await replacement.listen(address);
      assert.equal(replacement.pid, peer.entry.transportPid);
      assert.equal((await pingWindow(peer.entry, 500, peer.file))?.hostId, peer.channel.hostId);
    } finally {
      submission.mockRestore();
      await channel.dispose();
      await replacement.close();
      await peer.channel.dispose();
      assert.throws(() => process.kill(peer.entry.transportPid!, 0));
    }
  },
);

test.skipIf(process.platform !== 'win32')(
  'a listener failure retires its connected clients while another helper owner remains reachable',
  { tags: ['subprocess'] },
  async () => {
    const first = await fixture();
    const other = await fixture();
    const socket = await connect(first.entry.address);
    const disconnected = closed(socket);
    await vi.waitFor(() => assert.equal((first.channel as unknown as { sockets: Set<Duplex> }).sockets.size, 1));
    const server = (first.channel as unknown as { windowsServer: WindowsPipeServer }).windowsServer;
    server.emit('error', new Error('Fixture listener unavailable'));
    await disconnected;
    await vi.waitFor(
      async () => assert.equal((await pingWindow(first.entry, 500, first.file))?.hostId, first.channel.hostId),
      { timeout: 10_000 },
    );
    assert.equal((await pingWindow(other.entry, 500, other.file))?.hostId, other.channel.hostId);
    assert.equal(JSON.parse(fs.readFileSync(first.file, 'utf8')).transportPid, other.entry.transportPid);
  },
);

test.each(['linux', 'darwin'] as const)(
  '%s listener replacement retains current state and removes its owned socket on disposal',
  { tags: ['subprocess'] },
  async (platform) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const servers: (EventEmitter & {
      listening: boolean;
      listen: (address: string, ready: () => void) => void;
      close: (done: () => void) => void;
    })[] = [];
    const create = vi.spyOn(network, 'createServer').mockImplementation(() => {
      let address = '';
      const server = Object.assign(new EventEmitter(), {
        listening: false,
        listen: (target: string, ready: () => void) => {
          address = target;
          fs.writeFileSync(address, '');
          server.listening = true;
          queueMicrotask(ready);
        },
        close: (done: () => void) => {
          server.listening = false;
          fs.unlinkSync(address);
          queueMicrotask(done);
        },
      });
      servers.push(server);
      return server as unknown as net.Server;
    });
    syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const home = tempDir('window-posix-recovery-');
    const channel = new WindowChannel(home);
    const file = path.join(home, 'hosts', `${channel.hostId}.json`);
    try {
      await channel.update(state);
      const original = JSON.parse(fs.readFileSync(file, 'utf8')) as HostRegistration;
      servers[0].emit('error', new Error('Fixture listener unavailable'));
      await channel.update({ ...state, panelVisible: true });
      await vi.advanceTimersByTimeAsync(100);
      assert.equal(servers.length, 2);
      assert.equal(servers[0].listening, false);
      const current = JSON.parse(fs.readFileSync(file, 'utf8')) as HostRegistration;
      assert.equal(current.token, original.token);
      assert.equal(current.hostId, original.hostId);
      assert.equal(current.panelVisible, true);
      assert.equal(current.transportPid, undefined);
      await channel.dispose();
      assert.equal(fs.existsSync(file), false);
      assert.equal(fs.existsSync(original.address), false);
      assert.equal(vi.getTimerCount(), 0);
    } finally {
      await channel.dispose();
      create.mockRestore();
      syncBuiltinESMExports();
      vi.useRealTimers();
      Object.defineProperty(process, 'platform', descriptor);
    }
  },
);

test.skipIf(process.platform !== 'win32')(
  'an external authenticated caller regains the same activation after helper loss without replaying an accepted write',
  { tags: ['subprocess'] },
  async () => {
    const { channel, home, file, entry } = await fixture();
    const oldServer = (channel as unknown as { windowsServer: WindowsPipeServer }).windowsServer;
    const oldOwner = (oldServer as unknown as { owner: PipeBridge }).owner;
    const directory = tempDir('window-recovery-client-');
    const script = path.join(directory, 'client.cjs');
    buildSync({
      stdin: {
        contents: `import { discoverWindows, requestWindow } from './sessionrequests.ts';
          import { WindowsPipeServer } from './windowpipe.ts';
          const bridgePids = new Set();
          const connect = WindowsPipeServer.connect;
          WindowsPipeServer.connect = async (...args) => {
            const socket = await connect(...args); bridgePids.add(socket.owner.child.pid); return socket;
          };
          process.on('message', async ({ id, method, home, hostId, requestId, params }) => {
            try {
              const data = method === 'discover' ? await discoverWindows(home) : await requestWindow(method, params, hostId, home, requestId);
              process.send({id, data, bridgePids: [...bridgePids]});
            } catch (error) { process.send({id, error: error.message, bridgePids: [...bridgePids]}); }
          });`,
        resolveDir: __dirname,
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: script,
      logLevel: 'silent',
    });
    const client = spawn(process.execPath, [script], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: '', CODEX_THREAD_ID: '' },
    });
    const ended = new Promise<void>((resolve) => client.once('close', () => resolve()));
    let sequence = 0;
    const clientBridges = new Set<number>();
    const responses = new Map<number, { data?: any; error?: string }>();
    client.on('message', (value: { id: number; data?: unknown; error?: string; bridgePids?: number[] }) => {
      responses.set(value.id, value);
      for (const pid of value.bridgePids ?? []) clientBridges.add(pid);
    });
    const send = (method: string, params = {}, requestId?: string) => {
      const id = ++sequence;
      client.send({ id, method, home, hostId: channel.hostId, params, requestId });
      return id;
    };
    const response = async (id: number) => {
      await vi.waitFor(() => assert.ok(responses.has(id)), { timeout: 15_000 });
      return responses.get(id)!;
    };
    let writes = 0;
    let release!: () => void;
    // The write reaches the handler through the client process and its pipe helper, so the test awaits the handler itself.
    let written!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      written = resolve;
    });
    channel.setRequestHandler(async () => {
      writes++;
      written();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { status: 'accepted', sessionId: 'surviving-write' };
    });
    const params = {
      prompt: 'recover',
      agentRun: false,
      setup: { kind: 'custom', agent: 'codex', model: '', effort: '', permissionMode: '' },
    };
    const requestId = channel.hostId + ':recovery';
    let replacementPid = 0;
    try {
      await vi.waitFor(
        async () => {
          const discovered = await response(send('discover'));
          assert.equal(discovered.data.windows[0].hostId, channel.hostId);
        },
        { timeout: 15_000 },
      );
      const accepted = send('start', params, requestId);
      await firstWrite;
      assert.equal(writes, 1);
      oldOwner.child.kill();
      const disconnected = await response(accepted);
      assert.equal(disconnected.data.status, 'unknown');
      await vi.waitFor(
        async () => {
          const current = JSON.parse(fs.readFileSync(file, 'utf8')) as HostRegistration;
          assert.notEqual(current.transportPid, entry.transportPid);
          assert.equal(current.hostId, entry.hostId);
          assert.equal(current.token, entry.token);
          assert.equal(current.address, entry.address);
          replacementPid = current.transportPid!;
          const rediscovered = await response(send('discover'));
          assert.equal(rediscovered.data.windows[0].hostId, channel.hostId);
        },
        { timeout: 15_000 },
      );
      const retry = send('start', params, requestId);
      release();
      assert.equal((await response(retry)).data.sessionId, 'surviving-write');
      assert.equal(writes, 1);
      oldOwner.child.emit('close', 0, null);
      oldOwner.release();
      const peer = await fixture();
      assert.equal(peer.entry.transportPid, replacementPid, 'Obsolete bridge callbacks detached the current helper');
      await peer.channel.dispose();
      await channel.dispose();
      assert.equal(fs.existsSync(file), false);
      assert.throws(() => process.kill(replacementPid, 0));
      assert.throws(() => process.kill(entry.transportPid!, 0));
    } finally {
      release?.();
      await channel.dispose();
      client.kill();
      await ended;
      await vi.waitFor(
        () => {
          for (const pid of clientBridges) assert.throws(() => process.kill(pid, 0));
        },
        { timeout: 5_000 },
      );
      console.info(
        'Window recovery fixture resources',
        JSON.stringify({
          clientPid: client.pid,
          initialPid: entry.transportPid,
          replacementPid,
          clientBridgePids: [...clientBridges],
          disposed: true,
        }),
      );
    }
  },
);

test(
  'ping identifies Claude and Codex requesters and leaves an absent requester unknown',
  { tags: ['subprocess'] },
  async () => {
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
      if (server instanceof WindowsPipeServer) await server.close();
      else await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test(
  'disposal during listener startup removes the listener without publishing a registry',
  { tags: ['subprocess'] },
  async () => {
    const home = tempDir('window-start-close-');
    const channel = new WindowChannel(home);
    channels.push(channel);
    const start = channel.update(state);
    await channel.dispose();
    await start;
    assert.deepEqual(await discoverWindows(home), { windows: [], complete: true });
    assert.equal(fs.existsSync(hostAddress(home, channel.hostId)), false);
  },
);

test(
  'constructor failure leaves an activation spawner without a foreign window target',
  { tags: ['subprocess'] },
  () => {
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
  },
);

test(
  'activation spawners retain their activation target through recoverable startup and later channel failures',
  { tags: ['subprocess'] },
  async () => {
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
      assert.deepEqual(targets, [channel.hostId, channel.hostId], failure);
      await channel.dispose();
    }
  },
);

test('filter wire requests admit only bounded query payloads and the listing subset', () => {
  const base = { id: 'filter-one', version: 1, token: 'a'.repeat(64), requester: null };
  for (const request of [
    { ...base, method: 'filter', params: { query: '' } },
    { ...base, method: 'filter', params: { query: 'session:one OR session:codex:two' } },
    { ...base, method: 'sessions', params: { query: 'session:one', limit: 3 } },
  ])
    assert.deepEqual(parseSessionRequest(request), request);
  for (const request of [
    { ...base, method: 'filter', params: {} },
    { ...base, method: 'filter', params: { query: '', extra: true } },
    { ...base, method: 'filter', params: { query: 'session:one OR' } },
    { ...base, method: 'filter', params: { query: 'x'.repeat(201) } },
    { ...base, method: 'sessions', params: { query: 'is:unread' } },
    { ...base, method: 'sessions', params: { query: 'find:needle' } },
    { ...base, method: 'filter', params: { query: '' }, filterContext: {} },
  ])
    assert.equal(parseSessionRequest(request), null);
});

test(
  'filter channel exchanges wait beyond the read deadline and carry connection cancellation',
  { tags: ['subprocess'] },
  async () => {
    const home = tempDir('filter-channel-');
    const channel = new WindowChannel(home);
    channels.push(channel);
    let admitted: any;
    let finish!: () => void;
    channel.setRequestHandler((request) => {
      admitted = request;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    await channel.update({ folders: [], scopeReady: true, panelReady: false, panelVisible: false });
    vi.useFakeTimers();
    try {
      const result = requestWindow('filter', { query: 'session:one' }, channel.hostId, home);
      await vi.waitFor(() => assert.equal(admitted?.method, 'filter'));
      assert.equal(admitted.filterContext.signal.aborted, false);
      assert.ok(admitted.filterContext.deadline > Date.now() + 25_000);
      await vi.advanceTimersByTimeAsync(2_000);
      assert.equal(admitted.filterContext.signal.aborted, false);
      finish();
      await result;
    } finally {
      vi.useRealTimers();
    }
  },
);

test(
  'a disconnected filter transport reports an unknown outcome and cancels host admission',
  { tags: ['subprocess'] },
  async () => {
    const home = tempDir('filter-disconnect-');
    const channel = new WindowChannel(home);
    channels.push(channel);
    let admitted: any;
    let finish!: () => void;
    channel.setRequestHandler((request) => {
      admitted = request;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    await channel.update({ folders: [], scopeReady: true, panelReady: true, panelVisible: true });
    const result = requestWindow('filter', { query: 'session:one' }, channel.hostId, home);
    await vi.waitFor(() => assert.ok(admitted));
    await channel.dispose();
    assert.equal(((await result) as any).status, 'unknown');
    await vi.waitFor(() => assert.equal(admitted.filterContext.signal.aborted, true));
    finish();
  },
);

test(
  'older hosts refuse shorthand before either query route connects and retain exact requests',
  { tags: ['subprocess'] },
  async () => {
    const home = tempDir('shorthand-negotiation-');
    const channel = new WindowChannel(home);
    const seen: any[] = [];
    channel.setRequestHandler((request) => {
      seen.push(request);
      return {};
    });
    await channel.update({ folders: [], scopeReady: true, panelReady: false, panelVisible: false });
    const registration = path.join(home, 'hosts', `${channel.hostId}.json`);
    const old = JSON.parse(fs.readFileSync(registration, 'utf8'));
    old.capabilities = ['requesterProvider'];
    fs.writeFileSync(registration, JSON.stringify(old));
    try {
      for (const method of ['filter', 'sessions'] as const)
        await assert.rejects(
          requestWindow(method, { query: 'session:one' }, channel.hostId, home),
          /must reload before it can accept filter queries/,
        );
      assert.equal(seen.length, 0);
      old.capabilities = ['sessionQuery'];
      fs.writeFileSync(registration, JSON.stringify(old));
      for (const method of ['filter', 'sessions'] as const) {
        for (const query of [
          'id:01a12cef id:01a12a6b',
          '-id:claude:abcdefgh',
          'id:codex:abcdefgh',
          'session:claude:abcdefgh',
          '-session:codex:abcdefgh',
        ])
          await assert.rejects(requestWindow(method, { query }, channel.hostId, home), /must reload/);
        assert.equal(seen.length, method === 'filter' ? 0 : 5);
        for (const query of [
          'session:one',
          'session:one session:two',
          'session:one OR session:two',
          'session:ef5a03c3-f255-41b6-b57c-c15af453ac8a',
          '"id:abcdefgh"',
        ])
          await requestWindow(method, { query }, channel.hostId, home);
      }
      await requestWindow('filter', { query: '' }, channel.hostId, home);
      await requestWindow('sessions', {}, channel.hostId, home);
      assert.equal(seen.length, 12);
    } finally {
      await channel.dispose();
    }
  },
);

test(
  'dispatch channel schema, capability admission, bounds and explicit refusals remain distinct',
  { tags: ['subprocess'] },
  async () => {
    const { channel, home, entry } = await fixture();
    const launchId = 'aaaaaaaa-1111-2222-3333-444444444444';
    const params = { dispatchAction: 'wait' as const, launchId, deadlineMs: 1 };
    const valid = request(entry, { method: 'dispatch', params });
    assert.deepEqual(parseSessionRequest(valid), valid);
    const status = { dispatchAction: 'status', launchId, cursor: `${launchId}:1`, limit: 128 };
    assert.deepEqual(parseSessionRequest({ ...valid, params: status })?.params, status);
    for (const changed of [
      { ...status, launchId: '(' },
      { ...status, launchId: null },
      { ...status, cursor: 'bbbbbbbb-1111-2222-3333-444444444444:1' },
      { ...status, cursor: `${launchId}:12345678901234567` },
    ]) {
      assert.doesNotThrow(() => assert.equal(parseSessionRequest({ ...valid, params: changed }), null));
    }
    for (const changed of [
      { ...params, deadlineMs: 0 },
      { ...params, deadlineMs: 110001 },
      { ...params, launchId: '../unsafe' },
      { ...params, eventId: launchId },
      { ...params, dispatchAction: 'callback' },
    ])
      assert.equal(parseSessionRequest({ ...valid, params: changed }), null);
    await assert.rejects(requestWindow('dispatch', params, channel.hostId, home), /must reload/);
    const start = {
      setup: { kind: 'custom' as const, agent: 'codex', model: '', effort: '', permissionMode: '' },
      prompt: 'review',
      agentRun: false,
      dispatch: true,
      completion: 'manual' as const,
    };
    const writes = vi.fn<() => { status: string }>(() => ({ status: 'accepted' }));
    channel.setRequestHandler(writes);
    await assert.rejects(requestWindow('start', start, channel.hostId, home), /must reload/);
    assert.equal(writes.mock.calls.length, 0);
    const receipts = new DispatchReceipts(home);
    const host = new HostedDispatch(receipts, () => null);
    const launch = receipts.reserve({
      origin: 'b'.repeat(24),
      requester: null,
      policy: null,
      promptSha256: 'a'.repeat(64),
      completion: 'wait',
      alias: null,
    });
    channel.setDispatchHandler((request) =>
      host.request(channel.hostId, request.params, request.filterContext!.signal),
    );
    await channel.update(state);
    await assert.rejects(
      requestWindow('dispatch', { ...params, launchId: launch.launchId }, channel.hostId, home),
      /another Arc activation/,
    );
    channel.setDispatchHandler(() => ({ text: 'x'.repeat(SESSION_REQUEST_LIMITS.lineBytes + 1) }));
    await assert.rejects(
      requestWindow('dispatch', { dispatchAction: 'status', launchId }, channel.hostId, home),
      /allowance/,
    );
    const manual = receipts.reserve({ ...launch, origin: channel.hostId, completion: 'manual' });
    channel.setDispatchHandler((request) =>
      host.request(channel.hostId, request.params, request.filterContext!.signal),
    );
    await assert.rejects(
      requestWindow('dispatch', { ...params, launchId: manual.launchId }, channel.hostId, home),
      /did not select waited/,
    );
    const waited = receipts.reserve({ ...launch, origin: channel.hostId });
    vi.useFakeTimers();
    let admitted = false;
    channel.setDispatchHandler((request) => {
      admitted = true;
      return host.request(channel.hostId, request.params, request.filterContext!.signal);
    });
    const pending = requestWindow(
      'dispatch',
      { ...params, launchId: waited.launchId, deadlineMs: 100 },
      channel.hostId,
      home,
    );
    await vi.waitFor(() => assert.equal(admitted, true));
    await vi.advanceTimersByTimeAsync(100);
    assert.equal(((await pending) as any).state, 'deadline');
    vi.useRealTimers();
  },
);

test(
  'dispatch wait disconnect cancels the channel subscription and retains its launch identity',
  { tags: ['subprocess'] },
  async () => {
    const { channel, home } = await fixture();
    const receipts = new DispatchReceipts(home);
    const host = new HostedDispatch(receipts, () => null);
    const launch = receipts.reserve({
      origin: channel.hostId,
      requester: null,
      policy: null,
      promptSha256: 'a'.repeat(64),
      completion: 'wait',
      alias: null,
    });
    let admitted: any;
    channel.setDispatchHandler((request) => {
      admitted = request;
      return host.request(channel.hostId, request.params, request.filterContext!.signal);
    });
    await channel.update(state);
    const launchId = launch.launchId;
    const pending = requestWindow(
      'dispatch',
      { dispatchAction: 'wait', launchId, deadlineMs: 1000 },
      channel.hostId,
      home,
    );
    await vi.waitFor(() => assert.ok(admitted));
    await channel.dispose();
    const result = (await pending) as any;
    assert.equal(result.state, 'uncertain');
    assert.equal(result.launchId, launchId);
    await vi.waitFor(() => assert.equal(admitted.filterContext.signal.aborted, true));
    assert.equal(receipts.launch(launchId).launchId, launchId);
  },
);

// Two real channels expose wrong-window dispatch and admission races without editor startup.
test(
  'integrated setups selects its owning window among competing same-folder channels',
  { tags: ['subprocess'] },
  async () => {
    vi.stubEnv('TERM_PROGRAM', 'vscode');
    for (const key of [
      'WSL_DISTRO_NAME',
      'SSH_CONNECTION',
      'SSH_CLIENT',
      'REMOTE_CONTAINERS',
      'VSCODE_REMOTE_CONTAINERS_SESSION',
    ])
      vi.stubEnv(key, '');
    const { home, channel } = await fixture();
    const competitor = new WindowChannel(home);
    channels.push(competitor);
    let roots: TerminalShell[] = [{ processId: Promise.resolve(process.pid) }];
    const source = { allowed: () => true, terminals: () => roots };
    channel.setTerminalOwnership(terminalOwnership(source, identities));
    competitor.setTerminalOwnership(terminalOwnership({ allowed: () => true, terminals: () => [] }, identities));
    const first = vi.fn<() => Record<string, unknown>>(() => ({ owner: channel.hostId }));
    const second = vi.fn<() => Record<string, unknown>>(() => ({ owner: competitor.hostId }));
    channel.setRequestHandler(first);
    competitor.setRequestHandler(second);
    await competitor.update(state);
    assert.deepEqual(await requestWindow('setups', {}, '', home), { owner: channel.hostId });
    assert.equal(first.mock.calls.length, 1);
    assert.equal(second.mock.calls.length, 0);
    vi.stubEnv('ARC_WINDOW', competitor.hostId);
    assert.deepEqual(await requestWindow('setups', {}, undefined, home), { owner: competitor.hostId });
    assert.deepEqual(await requestWindow('setups', {}, channel.hostId, home), { owner: channel.hostId });
    roots = [];
    await assert.rejects(requestWindow('setups', {}, '', home), /terminal owner is not unique/);
    assert.equal(first.mock.calls.length, 2);
    assert.equal(second.mock.calls.length, 1);
    roots = [{ processId: Promise.resolve(process.pid) }];
    channel.setRequestHandler(() => {
      void channel.dispose();
      return { status: 'started' };
    });
    const uncertain = (await requestWindow(
      'start',
      {
        setup: { kind: 'custom', agent: 'codex', model: '', effort: '', permissionMode: '' },
        agentRun: false,
        prompt: 'owned test',
      },
      '',
      home,
    )) as { status: string; window: string };
    assert.equal(uncertain.status, 'unknown');
    assert.equal(uncertain.window, channel.hostId);
    assert.equal(second.mock.calls.length, 1);
  },
);

test(
  'integrated ownership refuses ambiguous, unsupported and unknown windows without dispatch',
  { tags: ['subprocess'] },
  async () => {
    vi.stubEnv('TERM_PROGRAM', 'vscode');
    const { home, channel } = await fixture();
    const competitor = new WindowChannel(home);
    channels.push(competitor);
    const handler = vi.fn<() => Record<string, unknown>>(() => ({}));
    channel.setRequestHandler(handler);
    competitor.setRequestHandler(handler);
    const roots = [{ processId: Promise.resolve(process.pid) }];
    channel.setTerminalOwnership(terminalOwnership({ allowed: () => true, terminals: () => roots }));
    await competitor.update(state);
    await assert.rejects(requestWindow('setups', {}, '', home), /Reload Arc windows/);
    competitor.setTerminalOwnership(terminalOwnership({ allowed: () => true, terminals: () => roots }));
    await assert.rejects(requestWindow('setups', {}, '', home), /not unique/);
    competitor.setTerminalOwnership(terminalOwnership({ allowed: () => false, terminals: () => [] }));
    await assert.rejects(requestWindow('setups', {}, '', home), /terminal owner is unavailable/);
    assert.equal(handler.mock.calls.length, 0);
  },
);

test.each([
  ['Process collection expired.', /took too long/],
  ['Process unavailable.', /terminal owner is unavailable/],
])('a terminal process read that fails with "%s" reports %s', { tags: ['subprocess'] }, async (failure, message) => {
  vi.stubEnv('TERM_PROGRAM', 'vscode');
  const { home, channel } = await fixture();
  const handler = vi.fn<() => Record<string, unknown>>(() => ({}));
  channel.setRequestHandler(handler);
  ancestryRead.failure = new Error(failure);
  try {
    await assert.rejects(requestWindow('setups', {}, '', home), message);
  } finally {
    ancestryRead.failure = null;
  }
  assert.equal(handler.mock.calls.length, 0);
});

test.each(['transfer', 'caller-reuse', 'root-reuse', 'disposed'] as const)(
  'final terminal admission refuses %s before handler effects',
  { tags: ['subprocess'] },
  async (change) => {
    vi.stubEnv('TERM_PROGRAM', 'vscode');
    const { home, channel } = await fixture();
    const competitor = new WindowChannel(home);
    channels.push(competitor);
    let roots: TerminalShell[] = [{ processId: Promise.resolve(process.pid) }];
    const source = { allowed: () => true, terminals: () => roots };
    const ownership = terminalOwnership(source);
    const originalInquire = ownership.inquire;
    let observedBirth = '';
    ownership.inquire = async (ancestry) => {
      observedBirth = ancestry.chain[0].birth;
      return originalInquire(ancestry);
    };
    const admission = terminalOwnership(source, async (pids) => {
      if (change === 'transfer') roots = [];
      if (change === 'disposed') void channel.dispose();
      return pids.map((pid, index) => ({
        pid,
        birth:
          (change === 'caller-reuse' && index === 0) || (change === 'root-reuse' && index === 1) ? '1' : observedBirth,
      }));
    });
    channel.setTerminalOwnership({ inquire: ownership.inquire, admit: admission.admit });
    competitor.setTerminalOwnership(terminalOwnership({ allowed: () => true, terminals: () => [] }));
    const first = vi.fn<() => Record<string, unknown>>(() => ({ status: 'started' }));
    const second = vi.fn<() => Record<string, unknown>>(() => ({ status: 'started' }));
    channel.setRequestHandler(first);
    competitor.setRequestHandler(second);
    await competitor.update(state);
    const result = requestWindow(
      'start',
      {
        setup: { kind: 'custom', agent: 'codex', model: '', effort: '', permissionMode: '' },
        agentRun: false,
        prompt: 'owned test',
        cwd: home,
      },
      '',
      home,
    );
    if (change === 'disposed') assert.equal(((await result) as { status: string }).status, 'unknown');
    else await assert.rejects(result, /terminal no longer belongs/);
    assert.equal(first.mock.calls.length, 0);
    assert.equal(second.mock.calls.length, 0);
  },
);
