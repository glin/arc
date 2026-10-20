import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as crypto from 'node:crypto';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Duplex, PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import {
  WindowsPipeServer,
  PipeBridge,
  compileWindowsPipe,
  reportWindowTransport,
  windowTransportErrorCode,
  type WindowTransportRecord,
  type WindowTransportSink,
} from './windowpipe.ts';
import { createDiagnosticsLog } from './diagnosticslog';
import { WINDOW_PIPE_SOURCE } from './windowpipe-source.ts';
import * as path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { tempDir } from './temproot.ts';
import { hostAddress, pingWindow, WindowChannel } from './sessionrequests.ts';

import { closed, createWindowFixtures } from '../test/window-channel';

const sockets: Duplex[] = [];

const channels: WindowChannel[] = [];

const { fixture, connect } = createWindowFixtures(channels, sockets);

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(channels.splice(0).map((channel) => channel.dispose()));
});

function bridgeFixture(sink?: WindowTransportSink) {
  const child = Object.assign(new EventEmitter(), {
    pid: 12345,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn<() => boolean>(() => true),
  });
  const records: WindowTransportRecord[] = [];
  const owner = new PipeBridge(
    child as unknown as ChildProcessWithoutNullStreams,
    sink ?? ((_event, record) => records.push(record)),
  );
  return { child, owner, records };
}

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

function replaceNativeLiteral(source: string, before: string, after: string): string {
  assert.ok(source.includes(before), `Native fixture replacement is absent: ${before}`);
  return source.replace(before, after);
}

const gatedNativeSource = () =>
  [
    ['class ArcPipe {', 'class ArcPipe { static readonly ManualResetEvent acceptGate = new ManualResetEvent(false);'],
    ['Output("listen:" + id); first = false;', 'Output("listen:" + id); acceptGate.WaitOne(); first = false;'],
    ['if(parts[0] == "listen")', 'if(parts[0] == "resume") acceptGate.Set(); else if(parts[0] == "listen")'],
  ].reduce(
    (source, [before, after]) => replaceNativeLiteral(source, before, after),
    WINDOW_PIPE_SOURCE.replace(/\r\n/g, '\n'),
  );

test('bridge failures retain one bounded reason before empty-owner teardown without stream or error contents', () => {
  const secret = 'secret-token-registration-path-prompt';
  const cases: [WindowTransportRecord['reason'], (fixture: ReturnType<typeof bridgeFixture>) => void][] = [
    ['stderr', ({ child }) => child.stderr.emit('data', Buffer.from(secret))],
    ['stdoutOverflow', ({ child }) => child.stdout.emit('data', secret.repeat(4000))],
    [
      'stdinDestroyed',
      ({ child, owner }) => {
        child.stdin.destroy();
        owner.send(secret);
      },
    ],
    [
      'stdinBacklog',
      ({ child, owner }) => {
        Object.defineProperty(child.stdin, 'writableLength', { value: 2 * 1024 * 1024 });
        owner.send(secret);
      },
    ],
    [
      'stdinError',
      ({ child }) => child.stdin.emit('error', Object.assign(new Error(secret), { code: 'EPIPE', stack: secret })),
    ],
    [
      'childError',
      ({ child }) => child.emit('error', Object.assign(new Error(secret), { code: secret, stack: secret })),
    ],
    ['childClose', ({ child }) => child.emit('close', 17, 'SIGTERM')],
    ['listenerError', ({ child }) => child.stdout.emit('data', 'error:12\n')],
  ];
  for (const [reason, trigger] of cases) {
    const fixture = bridgeFixture();
    trigger(fixture);
    trigger(fixture);
    assert.equal(fixture.records.length, 1, reason);
    const record = fixture.records[0];
    assert.equal(record.reason, reason);
    assert.deepEqual(
      [record.childPid, record.servers, record.sockets, record.released, record.stdinEnded],
      [12345, 0, 0, false, false],
    );
    if (reason === 'stderr') assert.equal(record.stderrBytes, Buffer.byteLength(secret));
    if (reason === 'stdinError') assert.equal(record.errorCode, 'EPIPE');
    if (reason === 'childError') assert.equal(record.errorCode, 'unknown');
    if (reason === 'childClose') assert.deepEqual([record.exitCode, record.signal], [17, 'SIGTERM']);
    if (reason === 'listenerError') assert.equal(record.serverId, 12);
    if (['stderr', 'stdoutOverflow', 'stdinDestroyed', 'stdinBacklog'].includes(reason))
      assert.equal(fixture.child.kill.mock.calls.length, 2);
    const serialized = JSON.stringify(record);
    assert.ok(Buffer.byteLength(serialized) <= 1024);
    assert.equal(serialized.includes(secret), false);
    assert.equal(/message|stack|token|payload|address|registrationFile/.test(serialized), false);
  }
});

test('bridge release records ownership transitions and child close retains stdin-end state when logging fails', () => {
  const { owner, child, records } = bridgeFixture();
  owner.servers.set(7, new WindowsPipeServer());
  owner.release();
  assert.equal(records.length, 0);
  assert.equal(child.stdin.writableEnded, false);
  owner.servers.delete(7);
  owner.release();
  owner.release();
  child.emit('close', null, 'SIGKILL');
  assert.deepEqual(
    records.map((record) => record.reason),
    ['release', 'childClose'],
  );
  assert.deepEqual([records[0].released, records[0].stdinEnded, records[1].stdinEnded], [true, false, true]);
  assert.deepEqual([records[1].exitCode, records[1].signal], [null, 'SIGKILL']);
  const throwing = bridgeFixture(() => {
    throw new Error('diagnostic failure');
  });
  assert.doesNotThrow(() => throwing.child.stderr.emit('data', Buffer.from('secret')));
  assert.equal(throwing.child.kill.mock.calls.length, 1);
  assert.doesNotThrow(() => throwing.owner.release());
  assert.equal(throwing.child.stdin.writableEnded, true);
  assert.equal(windowTransportErrorCode({ code: 'EACCES', message: 'secret' }), 'EACCES');
  assert.equal(
    windowTransportErrorCode({
      get code() {
        throw new Error('secret');
      },
    }),
    'unknown',
  );
});

test('window transport warnings persist with detailed diagnostics disabled and omit unsafe fields', () => {
  const log = createDiagnosticsLog({
    enabled: false,
    directory: tempDir('window-diagnostics-'),
    workspace: 'fixture',
    pid: 54321,
    startedAt: 1,
  });
  reportWindowTransport((event, record) => log.warn(event, record), 'childError', {
    errorCode: 'private-path-secret',
    signal: 'private-path-secret' as NodeJS.Signals,
    ...({ payload: 'private-path-secret', message: 'private-path-secret', stack: 'private-path-secret' } as object),
  });
  assert.equal(log.enabled(), false);
  const line = fs.readFileSync(log.file()!, 'utf8');
  const record = JSON.parse(line);
  assert.deepEqual([record.event, record.reason, record.errorCode], ['windowTransport', 'childError', 'unknown']);
  assert.equal(line.includes('private-path-secret'), false);
  assert.equal(record.signal, undefined);
  assert.ok(Buffer.byteLength(line) <= 1024);
  const { child } = bridgeFixture((event, fields) => log.warn(event, fields));
  child.emit('close', 23, null);
  const close = JSON.parse(fs.readFileSync(log.file()!, 'utf8').trim().split('\n').at(-1)!);
  assert.deepEqual(
    [close.event, close.reason, close.pid, close.childPid, close.instance, close.exitCode],
    ['windowTransport', 'childClose', 54321, 12345, '54321-1', 23],
  );
});

test('compiler termination and setup rejection retain reason, operation and exit evidence without compiler text', async () => {
  vi.useFakeTimers();
  for (const reason of ['compilerTimeout', 'compilerOutputOverflow', 'compilerError', 'compilerClose'] as const) {
    const { child } = bridgeFixture();
    const records: WindowTransportRecord[] = [];
    const launch = vi.fn<() => ChildProcessWithoutNullStreams>(
      () => child as unknown as ChildProcessWithoutNullStreams,
    );
    const run = vi.fn<() => Promise<{ stdout: string; stderr: string }>>(async () => ({
      stdout: 'S-1-5-21-123',
      stderr: '',
    }));
    const pending = compileWindowsPipe((_event, record) => records.push(record), run as never, launch as never);
    const rejected = assert.rejects(pending);
    await vi.waitFor(() => assert.equal(launch.mock.calls.length, 1));
    if (reason === 'compilerTimeout') vi.advanceTimersByTime(10_000);
    if (reason === 'compilerOutputOverflow') {
      child.stderr.emit('data', Buffer.alloc(65537, 's'));
      child.stderr.emit('data', Buffer.alloc(1, 's'));
    }
    if (reason === 'compilerError') child.emit('error', Object.assign(new Error('secret'), { code: 'ENOENT' }));
    child.emit('close', 23, null);
    await rejected;
    assert.equal(records.filter((record) => record.reason === reason).length, 1, reason);
    assert.deepEqual(
      records.find((record) => record.reason === 'compilerClose'),
      {
        reason: 'compilerClose',
        childPid: 12345,
        outputBytes: reason === 'compilerOutputOverflow' ? 65538 : 0,
        stage: 'compiler',
        exitCode: 23,
        signal: null,
      },
    );
    assert.equal(records.at(-1)!.reason, 'setupRejected');
    assert.equal(records.at(-1)!.stage, 'compiler');
    assert.equal(JSON.stringify(records).includes('secret'), false);
  }
  const records: WindowTransportRecord[] = [];
  await assert.rejects(
    compileWindowsPipe((_event, record) => records.push(record), (async () => {
      throw Object.assign(new Error('secret'), { code: 'EACCES' });
    }) as never),
  );
  assert.deepEqual(records, [{ reason: 'setupRejected', stage: 'identity', errorCode: 'EACCES' }]);
});

test.skipIf(process.platform !== 'win32')(
  'Windows listener errors and native child exit reach bounded Node evidence',
  { tags: ['subprocess'] },
  async () => {
    const source = replaceNativeLiteral(
      gatedNativeSource(),
      'if(parts[0] == "resume")',
      'if(parts[0] == "fixtureExit") Environment.Exit(23); else if(parts[0] == "resume")',
    );
    const native = nativeFixture(source);
    const records: WindowTransportRecord[] = [];
    const owner = new PipeBridge(native.child, (_event, record) => records.push(record));
    const server = new WindowsPipeServer();
    const errors: Error[] = [];
    server.on('error', (error) => errors.push(error));
    owner.servers.set(1, server);
    const ended = new Promise<void>((resolve) => native.child.once('close', () => resolve()));
    try {
      native.send(`listen:1:${Buffer.from('invalid-private-fixture-address').toString('base64')}`);
      await vi.waitFor(() => assert.equal(errors.length, 1));
      assert.equal(records[0].reason, 'listenerError');
      assert.equal(records[0].serverId, 1);
      assert.equal(records[0].servers, 1);
      native.send('fixtureExit:0');
      await ended;
      assert.deepEqual(
        records.filter((record) => record.reason === 'childClose').map(({ exitCode, signal }) => [exitCode, signal]),
        [[23, null]],
      );
      assert.equal(errors.length, 2);
      assert.equal(JSON.stringify(records).includes('private-fixture-address'), false);
    } finally {
      if (native.child.exitCode === null && native.child.signalCode === null) {
        native.child.kill();
        await ended;
      }
    }
  },
);

test.skipIf(process.platform !== 'win32')(
  'Windows busy opens honor deadline and cancellation before availability returns',
  { tags: ['subprocess'] },
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
  { tags: ['subprocess'] },
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
  { tags: ['subprocess'] },
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
  { tags: ['subprocess'] },
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

// Pending queries and the selection lease must preserve one bridge without keeping abandoned helpers alive.
test('process queries retain the bridge through resolution and release their scoped lease once', async () => {
  const { child, owner } = bridgeFixture();
  const release = owner.lease();
  let command = '';
  child.stdin.on('data', (chunk) => {
    command += chunk.toString();
  });
  const pending = owner.query('ancestry', [73]);
  const id = command.trim().split(':')[1];
  const rows = [{ pid: 73, parent: 12, birth: '100' }];
  child.stdout.emit('data', `process:${id}:${Buffer.from(JSON.stringify(rows)).toString('base64')}\n`);
  assert.deepEqual(await pending, rows);
  assert.equal(child.stdin.writableEnded, false);
  owner.release();
  assert.equal(child.stdin.writableEnded, false);
  release();
  release();
  assert.equal(child.stdin.writableEnded, true);
});

test.each(['cancel', 'timeout', 'malformed', 'child-error', 'child-close', 'stdin-error'] as const)(
  'process query %s settles without affecting an unrelated listener',
  async (failure) => {
    vi.useFakeTimers();
    const { child, owner } = bridgeFixture();
    owner.servers.set(17, new EventEmitter() as WindowsPipeServer);
    owner.servers.get(17)!.on('error', () => {});
    let command = '';
    child.stdin.on('data', (chunk) => {
      command += chunk.toString();
    });
    const cancellation = new AbortController();
    const pending = owner.query('identities', [73], cancellation.signal);
    const rejected = assert.rejects(pending, /Process details unavailable/);
    const id = command.trim().split(':')[1];
    if (failure === 'cancel') cancellation.abort();
    else if (failure === 'timeout') await vi.advanceTimersByTimeAsync(2000);
    else if (failure === 'malformed') child.stdout.emit('data', `process:${id}:invalid!\n`);
    else if (failure === 'child-error') child.emit('error', new Error('unavailable'));
    else if (failure === 'child-close') child.emit('close', 1, null);
    else child.stdin.emit('error', new Error('unavailable'));
    await rejected;
    child.stdout.emit('data', `process:${id}:W10=\n`);
    if (['cancel', 'timeout', 'malformed'].includes(failure)) {
      assert.equal(owner.servers.has(17), true);
      assert.equal(child.kill.mock.calls.length, 0);
      assert.equal(child.stdin.writableEnded, false);
    }
    owner.servers.clear();
    owner.release();
  },
);
