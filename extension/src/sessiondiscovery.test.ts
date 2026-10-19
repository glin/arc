import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import filesystem from 'node:fs';
import * as net from 'node:net';
import { Duplex } from 'node:stream';
import { WindowsPipeServer } from './windowpipe.ts';
import network from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import * as path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { tempDir } from './temproot.ts';
import { requestWindow } from './sessionrequests.ts';
import {
  discoverWindows,
  hostAddress,
  validHostAddress,
  pingWindow,
  SESSION_REQUEST_LIMITS,
  WINDOW_DISCOVERY_LIMITS,
  WindowUnavailableError,
  WindowChannel,
  type HostRegistration,
  type WindowInfo,
} from './sessionrequests.ts';

import { state, createWindowFixtures } from '../test/window-channel';

const sockets: Duplex[] = [];

const channels: WindowChannel[] = [];

const { fixture, connect } = createWindowFixtures(channels, sockets);

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(channels.splice(0).map((channel) => channel.dispose()));
});

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

test.each([undefined, ['sessionRead', 'dispatchResults', 'dispatchNotices']] as const)(
  'authenticated discovery retains optional capabilities %j without reply secrets',
  async (capabilities) => {
    const { home, entry } = await fixture(undefined, (info) => {
      const reply = { ...info, token: 'private-token', address: 'private-address', stack: 'private-stack' };
      if (capabilities === undefined) delete reply.capabilities;
      else reply.capabilities = [...capabilities];
      return reply;
    });
    const ping = await pingWindow(entry);
    assert.ok(ping);
    assert.deepEqual(ping.capabilities, capabilities);
    assert.equal(Object.hasOwn(ping, 'capabilities'), capabilities !== undefined);
    const report = await discoverWindows(home);
    assert.equal(report.complete, true);
    assert.deepEqual(report.windows, [ping]);
    for (const secret of ['token', 'address', 'stack', 'private-'])
      assert.equal(JSON.stringify(report).includes(secret), false);
  },
);

test.each([null, [1], Array(17).fill('read'), ['x'.repeat(65)]])(
  'authenticated discovery rejects malformed capabilities %j without diagnosing access denial',
  async (capabilities) => {
    const { home, entry } = await fixture(undefined, (info) => ({ ...info, capabilities }) as WindowInfo);
    assert.equal(await pingWindow(entry), null);
    assert.deepEqual(await discoverWindows(home), { windows: [], complete: false });
  },
);

test('a missing explicit or inherited window requires fresh selection and keeps its error class', async () => {
  const { home, channel } = await fixture();
  const missing = 'f'.repeat(24);
  for (const inherited of [false, true]) {
    vi.stubEnv('ARC_WINDOW', missing);
    await assert.rejects(requestWindow('sessions', {}, inherited ? undefined : missing, home), (error: unknown) => {
      assert.ok(error instanceof WindowUnavailableError);
      assert.match(error.message, /not registered.*Run arc windows and select the intended folders/);
      assert.doesNotMatch(error.message, /EACCES|EPERM|token|address/);
      return true;
    });
  }
  assert.equal((await discoverWindows(home)).windows[0].hostId, channel.hostId);
});

test.each(['ENOENT', 'EACCES', 'EPERM', 'EMFILE'] as const)(
  'registry %s retains observed bounded diagnostics and reachable windows',
  async (code) => {
    const { home, file, entry } = await fixture();
    const reachable = new WindowChannel(home);
    channels.push(reachable);
    await reachable.update(state);
    const original = filesystem.openSync;
    const open = vi.spyOn(filesystem, 'openSync').mockImplementation((...args) => {
      if (args[0] === file) throw Object.assign(new Error('secret token address stack'), { code });
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      const report = await discoverWindows(home);
      assert.deepEqual(
        report.windows.map((window) => window.hostId),
        [reachable.hostId],
      );
      assert.equal(report.complete, code !== 'EACCES' && code !== 'EPERM');
      assert.deepEqual(
        report.diagnostics,
        code === 'EMFILE' || code === 'ENOENT' ? undefined : [{ code, stage: 'registry', hostId: entry.hostId }],
      );
      for (const inherited of [false, true]) {
        vi.stubEnv('ARC_WINDOW', entry.hostId);
        await assert.rejects(
          requestWindow('sessions', {}, inherited ? undefined : entry.hostId, home),
          (error: unknown) => {
            assert.ok(error instanceof WindowUnavailableError);
            assert.match(
              error.message,
              code === 'ENOENT'
                ? /not registered/
                : code === 'EMFILE'
                  ? /unavailable/
                  : new RegExp(
                      `Arc window ${entry.hostId} failed \\(${code}\\).*Check that your current permissions allow reading`,
                    ),
            );
            assert.doesNotMatch(error.message, /secret|token|address|stack/);
            return true;
          },
        );
      }
      assert.equal(JSON.stringify(report).includes('secret'), false);
    } finally {
      open.mockRestore();
      syncBuiltinESMExports();
    }
  },
);

test('discovery accounts for a registration that vanishes before inspection', async () => {
  const { home, file } = await fixture();
  const original = filesystem.lstatSync;
  const stat = vi.spyOn(filesystem, 'lstatSync').mockImplementation((...args) => {
    if (args[0] === file) fs.unlinkSync(file);
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await discoverWindows(home), { windows: [], complete: true });
    assert.equal(fs.existsSync(file), false);
  } finally {
    stat.mockRestore();
    syncBuiltinESMExports();
  }
});

test('registry access diagnostics stop at their bound without declaring complete coverage', async () => {
  const home = tempDir('window-diagnostics-');
  const directory = path.join(home, 'hosts');
  fs.mkdirSync(directory);
  for (let i = 0; i <= WINDOW_DISCOVERY_LIMITS.diagnostics; i++)
    fs.writeFileSync(path.join(directory, `${i.toString(16).padStart(24, '0')}.json`), '{}');
  const original = filesystem.lstatSync;
  const stat = vi.spyOn(filesystem, 'lstatSync').mockImplementation((...args) => {
    if (path.dirname(String(args[0])) === directory) throw Object.assign(new Error('secret'), { code: 'EACCES' });
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    const report = await discoverWindows(home);
    assert.equal(report.complete, false);
    assert.equal(report.diagnostics?.length, WINDOW_DISCOVERY_LIMITS.diagnostics);
    assert.ok(report.diagnostics.every((one) => one.code === 'EACCES' && one.stage === 'registry'));
    assert.equal(JSON.stringify(report).includes('secret'), false);
  } finally {
    stat.mockRestore();
    syncBuiltinESMExports();
  }
});

test.each(['linux', 'darwin'] as const)(
  '%s socket errors retain observed causes while write outcomes keep the same identity',
  async (platform) => {
    const { home, file, entry } = await fixture();
    fs.writeFileSync(file, JSON.stringify({ ...entry, address: hostAddress(home, entry.hostId, platform, '/tmp') }));
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
    const connection = vi.spyOn(network, 'createConnection');
    syncBuiltinESMExports();
    try {
      for (const code of ['ENOENT', 'EACCES', 'EPERM', 'ECONNRESET']) {
        for (const creationFailure of [false, true]) {
          connection.mockImplementation(() => {
            const error = Object.assign(new Error('secret token address stack'), { code });
            if (creationFailure) throw error;
            const socket = new net.Socket();
            sockets.push(socket);
            queueMicrotask(() => socket.emit('error', error));
            return socket;
          });
          syncBuiltinESMExports();
          const report = await discoverWindows(home);
          assert.equal(report.complete, false);
          assert.deepEqual(report.windows, []);
          assert.deepEqual(
            report.diagnostics,
            code === 'ECONNRESET' ? undefined : [{ code, stage: 'connection', hostId: entry.hostId }],
          );
          await assert.rejects(requestWindow('sessions', {}, entry.hostId, home), (error: unknown) => {
            assert.ok(error instanceof Error);
            if (code === 'EACCES' || code === 'EPERM') {
              assert.ok(error instanceof WindowUnavailableError);
              assert.match(error.message, new RegExp(`Arc window ${entry.hostId} failed \\(${code}\\)`));
              assert.match(error.message, /Check that your current permissions allow connecting.*local socket/);
            } else assert.match(error.message, /unavailable/);
            assert.doesNotMatch(error.message, /secret|token|address|stack/);
            return true;
          });
          const id = entry.hostId + ':aaaaaaaa-1111-2222-3333-444444444444';
          assert.deepEqual(await requestWindow('curate', {}, entry.hostId, home, id), {
            version: 1,
            status: 'unknown',
            requestId: id,
            window: entry.hostId,
            reason: 'Delivery is unknown. Retry only this request ID in this window.',
          });
          assert.equal(JSON.stringify(report).includes('secret'), false);
        }
      }
    } finally {
      connection.mockRestore();
      Object.defineProperty(process, 'platform', descriptor);
      syncBuiltinESMExports();
    }
  },
);

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

test.each(['win32', 'darwin', 'linux'] as const)(
  '%s connection creation failure retains live ownership and reports only window failures',
  async (platform) => {
    const { home, file, entry } = await fixture();
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...entry,
        transportPid: process.pid,
        address: hostAddress(home, entry.hostId, platform, '/tmp'),
      }),
    );
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
    const original = fs.promises.opendir;
    let closeCalls = () => 0;
    const opened = vi.spyOn(fs.promises, 'opendir').mockImplementation(async (...args) => {
      const directory = await original(...args);
      const close = vi.spyOn(directory, 'close');
      const previousCloseCalls = closeCalls;
      closeCalls = () => previousCloseCalls() + close.mock.calls.length;
      return directory;
    });
    const connection =
      platform === 'win32' ? vi.spyOn(WindowsPipeServer, 'connect') : vi.spyOn(network, 'createConnection');
    syncBuiltinESMExports();
    try {
      for (const code of ['EMFILE', 'ENOENT', 'EACCES', 'EPERM']) {
        connection.mockImplementation(() => {
          throw Object.assign(new Error('secret token address stack'), { code });
        });
        syncBuiltinESMExports();
        const before = closeCalls();
        assert.deepEqual(await discoverWindows(home), {
          windows: [],
          complete: false,
          ...(platform === 'win32' || code === 'EMFILE'
            ? {}
            : { diagnostics: [{ code, stage: 'connection', hostId: entry.hostId }] }),
        });
        assert.equal(fs.existsSync(file), true);
        assert.equal(closeCalls(), before + 1);
        await assert.rejects(
          requestWindow('sessions', {}, entry.hostId, home),
          platform !== 'win32' && (code === 'EACCES' || code === 'EPERM')
            ? new RegExp(`failed \\(${code}\\)`)
            : /unavailable/,
        );
      }
    } finally {
      connection.mockRestore();
      opened.mockRestore();
      Object.defineProperty(process, 'platform', descriptor);
      syncBuiltinESMExports();
    }
  },
);

test('only confirmed process death removes unchanged registry bytes and never a foreign socket', async () => {
  const { home, file, entry, channel } = await fixture();
  await channel.dispose();
  const dead = JSON.stringify({ ...entry, pid: 424242 });
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('Stopped'), { code: 'ESRCH' });
  });
  try {
    fs.writeFileSync(file, dead);
    const diagnostics =
      process.platform === 'win32'
        ? {}
        : { diagnostics: [{ code: 'ENOENT', stage: 'connection', hostId: entry.hostId }] };
    assert.deepEqual(await discoverWindows(home), { windows: [], complete: true });
    assert.equal(fs.existsSync(file), false);
    fs.writeFileSync(file, dead);
    kill.mockImplementation(() => {
      throw Object.assign(new Error('Denied'), { code: 'EPERM' });
    });
    assert.deepEqual(await discoverWindows(home), { windows: [], complete: false, ...diagnostics });
    assert.equal(fs.readFileSync(file, 'utf8'), dead);
    const replacement = JSON.stringify({ ...entry, pid: 424242, token: 'c'.repeat(64) });
    kill.mockImplementation(() => {
      fs.writeFileSync(file, replacement);
      throw Object.assign(new Error('Stopped'), { code: 'ESRCH' });
    });
    assert.deepEqual(await discoverWindows(home), { windows: [], complete: false, ...diagnostics });
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
    assert.deepEqual(await discoverWindows(home), {
      windows: [],
      complete: true,
    });
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
