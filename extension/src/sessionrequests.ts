import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeFileAtomically } from './atomicfile.ts';
import { arcHome } from './store.ts';

export const SESSION_REQUEST_VERSION = 1;
export const SESSION_REQUEST_LIMITS = {
  lineBytes: 64 * 1024,
  lineDeadlineMs: 1_000,
  connections: 16,
  inFlight: 32,
} as const;
const HOST_ID = /^[a-f0-9]{24}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const REGISTRY_BYTES = 64 * 1024;
export const WINDOW_DISCOVERY_LIMITS = { directoryEntries: 1024, hosts: 256, concurrency: 8 } as const;

export interface WindowState {
  folders: string[];
  scopeReady: boolean;
  panelReady: boolean;
  panelVisible: boolean;
}

export interface WindowInfo extends WindowState {
  hostId: string;
  pid: number;
  version: number;
}

export interface HostRegistration extends WindowInfo {
  address: string;
  token: string;
}

export interface WindowDiscovery {
  windows: WindowInfo[];
  complete: boolean;
}

export interface SessionRequest {
  id: string;
  version: typeof SESSION_REQUEST_VERSION;
  token: string;
  method: 'ping';
  requester: string | null;
  params: Record<string, never>;
}

export type SessionReply = { id: string | null; result: WindowInfo } | { id: string | null; error: string };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function windowInfo(value: unknown): value is WindowInfo {
  return (
    record(value) &&
    typeof value.hostId === 'string' &&
    HOST_ID.test(value.hostId) &&
    Number.isSafeInteger(value.pid) &&
    (value.pid as number) > 0 &&
    value.version === SESSION_REQUEST_VERSION &&
    Array.isArray(value.folders) &&
    value.folders.length <= 64 &&
    value.folders.every((folder) => typeof folder === 'string' && folder.length <= 2048) &&
    typeof value.scopeReady === 'boolean' &&
    typeof value.panelReady === 'boolean' &&
    typeof value.panelVisible === 'boolean'
  );
}

export function parseSessionRequest(value: unknown): SessionRequest | null {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'id,method,params,requester,token,version') return null;
  if (
    typeof value.id !== 'string' ||
    !value.id.length ||
    value.id.length > 128 ||
    value.version !== SESSION_REQUEST_VERSION ||
    typeof value.token !== 'string' ||
    !TOKEN.test(value.token) ||
    value.method !== 'ping' ||
    !(
      value.requester === null ||
      (typeof value.requester === 'string' && value.requester.length > 0 && value.requester.length <= 256)
    ) ||
    !record(value.params) ||
    Object.keys(value.params).length !== 0
  )
    return null;
  return value as unknown as SessionRequest;
}

export function hostAddress(
  home: string,
  hostId: string,
  platform: NodeJS.Platform = process.platform,
  temporaryRoot: string = os.tmpdir(),
): string {
  if (!HOST_ID.test(hostId)) throw new Error('Invalid Arc window identifier.');
  if (platform === 'win32') return `\\\\.\\pipe\\arc-${hostId}`;
  const normal = path.posix.join(path.posix.resolve(home), 'hosts', `${hostId}.sock`);
  if (Buffer.byteLength(normal) < 104) return normal;
  const suffix = path.posix.join(fallbackDirectory(home), `${hostId}.sock`);
  for (const root of [temporaryRoot, '/tmp']) {
    const fallback = path.posix.join(path.posix.resolve(root), suffix);
    if (Buffer.byteLength(fallback) < 104) return fallback;
  }
  throw new Error('The Arc window channel path is too long.');
}

function fallbackDirectory(home: string): string {
  const key = crypto.createHash('sha256').update(path.posix.resolve(home)).digest('hex').slice(0, 16);
  return `a-${key}`;
}

export function validHostAddress(
  home: string,
  hostId: string,
  address: unknown,
  platform = process.platform,
): address is string {
  if (!HOST_ID.test(hostId) || typeof address !== 'string') return false;
  if (platform === 'win32') return address === hostAddress(home, hostId, platform);
  if (
    address.includes('\0') ||
    !path.posix.isAbsolute(address) ||
    path.posix.normalize(address) !== address ||
    Buffer.byteLength(address) >= 104
  )
    return false;
  const normal = path.posix.join(path.posix.resolve(home), 'hosts', `${hostId}.sock`);
  return (
    address === normal ||
    (path.posix.basename(address) === `${hostId}.sock` &&
      path.posix.basename(path.posix.dirname(address)) === fallbackDirectory(home))
  );
}

function privateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) {
    throw new Error('The Arc window directory is unavailable.');
  }
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
}

// Each connection holds at most one bounded unfinished line. Its deadline never advances on partial input.
function receiveLines(
  socket: net.Socket,
  limits: typeof SESSION_REQUEST_LIMITS | RequestLimits,
  line: (text: string) => void,
): void {
  let pending = Buffer.alloc(0);
  let deadline = setTimeout(() => socket.destroy(), limits.lineDeadlineMs);
  const restart = () => {
    clearTimeout(deadline);
    deadline = setTimeout(() => socket.destroy(), limits.lineDeadlineMs);
  };
  socket.on('close', () => clearTimeout(deadline));
  socket.on('error', () => socket.destroy());
  socket.on('data', (chunk: Buffer) => {
    let start = 0;
    while (start < chunk.length && !socket.destroyed) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      if (pending.length + end - start > limits.lineBytes) {
        socket.destroy();
        return;
      }
      pending = Buffer.concat([pending, chunk.subarray(start, end)]);
      if (newline < 0) return;
      const text = pending.toString('utf8');
      pending = Buffer.alloc(0);
      restart();
      line(text);
      start = newline + 1;
    }
  });
}

export interface RequestLimits {
  lineBytes: number;
  lineDeadlineMs: number;
  connections: number;
  inFlight: number;
}

export class WindowChannel {
  readonly hostId = crypto.randomBytes(12).toString('hex');
  private readonly token = crypto.randomBytes(32).toString('hex');
  private readonly address: string;
  private readonly registryFile: string;
  private readonly sockets = new Set<net.Socket>();
  private readonly server: net.Server;
  private state: WindowState | null = null;
  private registeredBytes: string | null = null;
  private listening = false;
  private starting: Promise<void> | null = null;
  private closed = false;
  private inFlight = 0;
  private disposal: Promise<void> | null = null;

  constructor(
    private readonly home = arcHome(),
    private readonly limits: RequestLimits = SESSION_REQUEST_LIMITS,
    private readonly ping: (info: WindowInfo) => WindowInfo | Promise<WindowInfo> = (info) => info,
  ) {
    this.address = hostAddress(home, this.hostId);
    this.registryFile = path.join(home, 'hosts', `${this.hostId}.json`);
    this.server = net.createServer((socket) => this.accept(socket));
    this.server.on('error', () => {
      void this.dispose();
    });
  }

  // The provider calls update only after it restores saved state.
  async update(state: WindowState): Promise<void> {
    if (this.closed) return Promise.resolve();
    try {
      this.state = { ...state, folders: [...state.folders] };
      if (this.listening) {
        this.publish();
        return;
      }
      if (!this.starting) this.starting = this.listen();
      await this.starting;
    } catch (error) {
      void this.dispose();
      throw error;
    }
  }

  get windowId(): string | null {
    return this.closed ? null : this.hostId;
  }

  private info(): WindowInfo {
    return {
      ...this.state!,
      folders: [...this.state!.folders],
      hostId: this.hostId,
      pid: process.pid,
      version: SESSION_REQUEST_VERSION,
    };
  }

  private publish(): void {
    if (this.closed || !this.state) return;
    const registration: HostRegistration = { ...this.info(), address: this.address, token: this.token };
    if (!windowInfo(registration)) throw new Error('The Arc window state is too large.');
    const bytes = JSON.stringify(registration);
    if (Buffer.byteLength(bytes) > REGISTRY_BYTES) throw new Error('The Arc window state is too large.');
    if (bytes === this.registeredBytes) {
      try {
        if (readRegistration(this.registryFile) === bytes) return;
      } catch {
        /* Restore a missing or unreadable registration on the next state publication. */
      }
    }
    writeFileAtomically(this.registryFile, bytes, fs.renameSync, 0o600, false);
    this.registeredBytes = bytes;
  }

  private async listen(): Promise<void> {
    privateDirectory(path.dirname(this.registryFile));
    if (process.platform !== 'win32') privateDirectory(path.dirname(this.address));
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      this.server.once('error', failed);
      this.server.listen(this.address, () => {
        this.server.removeListener('error', failed);
        this.listening = true;
        resolve();
      });
    });
    if (this.closed) return;
    try {
      if (process.platform !== 'win32') fs.chmodSync(this.address, 0o600);
      this.publish();
    } catch (error) {
      void this.dispose();
      throw error;
    }
  }

  private accept(socket: net.Socket): void {
    if (this.closed || this.sockets.size >= this.limits.connections) {
      socket.on('error', () => {});
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    receiveLines(socket, this.limits, (text) => {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        this.answer(socket, { id: null, error: 'Invalid request.' });
        return;
      }
      const request = parseSessionRequest(value);
      if (!request) {
        this.answer(socket, { id: null, error: 'Invalid request.' });
        return;
      }
      if (!crypto.timingSafeEqual(Buffer.from(request.token, 'hex'), Buffer.from(this.token, 'hex'))) {
        this.answer(socket, { id: request.id, error: 'Access denied.' });
        return;
      }
      if (this.inFlight >= this.limits.inFlight) {
        socket.destroy();
        return;
      }
      this.inFlight++;
      void Promise.resolve()
        .then(() => this.ping(this.info()))
        .then(
          (result) => this.answer(socket, { id: request.id, result }),
          () => this.answer(socket, { id: request.id, error: 'Window unavailable.' }),
        )
        .finally(() => {
          this.inFlight--;
        });
    });
  }

  private answer(socket: net.Socket, reply: SessionReply): void {
    if (this.closed || socket.destroyed) return;
    const bytes = JSON.stringify(reply) + '\n';
    if (socket.writableLength + Buffer.byteLength(bytes) > this.limits.lineBytes) socket.destroy();
    else socket.write(bytes);
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    this.disposal = this.close();
    return this.disposal;
  }

  private async close(): Promise<void> {
    // A listen already submitted to Node must finish before its listener can close.
    await this.starting?.catch(() => {});
    if (this.listening) await new Promise<void>((resolve) => this.server.close(() => resolve()));
    removeOwnedRegistration(this.registryFile, this.registeredBytes, this.address, this.home);
    this.server.removeAllListeners();
  }
}

function removeOwnedRegistration(
  file: string,
  expected: string | null,
  address: string,
  home: string,
  removeSocket = true,
): boolean {
  if (expected === null) return false;
  let removed = false;
  try {
    if (readRegistration(file) !== expected) return false;
    fs.unlinkSync(file);
    removed = true;
    if (removeSocket && process.platform !== 'win32') {
      if (fs.lstatSync(address).isSocket()) fs.unlinkSync(address);
    }
  } catch {
    /* Preserve paths whose ownership cannot be established. */
  }
  if (
    removeSocket &&
    process.platform !== 'win32' &&
    path.dirname(address) !== path.join(path.resolve(home), 'hosts')
  ) {
    try {
      fs.rmdirSync(path.dirname(address));
    } catch {
      /* Another host retains the shared directory. */
    }
  }
  return removed;
}

// Folderless ownership's bounded reader has a different byte allowance and no registry file-kind check.
function readRegistration(file: string): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('Invalid Arc window registration.');
    const buffer = Buffer.alloc(REGISTRY_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    if (length > REGISTRY_BYTES) throw new Error('Invalid Arc window registration.');
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

export function pingWindow(entry: HostRegistration, deadlineMs = 1_000): Promise<WindowInfo | null> {
  return new Promise((resolve) => {
    const socket = net.createConnection(entry.address);
    const id = crypto.randomBytes(12).toString('hex');
    let settled = false;
    const finish = (info: WindowInfo | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(info);
    };
    const deadline = setTimeout(() => finish(null), deadlineMs);
    socket.on('error', () => finish(null));
    socket.on('close', () => finish(null));
    receiveLines(socket, { ...SESSION_REQUEST_LIMITS, lineDeadlineMs: deadlineMs }, (text) => {
      try {
        const reply: unknown = JSON.parse(text);
        if (!record(reply) || reply.id !== id || !windowInfo(reply.result) || reply.result.hostId !== entry.hostId) {
          finish(null);
          return;
        }
        const { hostId, pid, version, folders, scopeReady, panelReady, panelVisible } = reply.result;
        finish({ hostId, pid, version, folders, scopeReady, panelReady, panelVisible });
      } catch {
        finish(null);
      }
    });
    socket.on('connect', () => {
      const request: SessionRequest = {
        id,
        version: SESSION_REQUEST_VERSION,
        token: entry.token,
        method: 'ping',
        requester: process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_THREAD_ID || null,
        params: {},
      };
      socket.write(JSON.stringify(request) + '\n');
    });
  });
}

function processIsDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

export async function discoverWindows(home = arcHome()): Promise<WindowDiscovery> {
  const directory = path.join(home, 'hosts');
  let entries: fs.Dir;
  try {
    entries = await fs.promises.opendir(directory, { bufferSize: WINDOW_DISCOVERY_LIMITS.concurrency });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { windows: [], complete: true };
    throw new Error('Arc windows are unavailable.', { cause: error });
  }
  const live: WindowInfo[] = [];
  let complete = true;
  let visited = 0;
  let admitted = 0;
  let batch: Promise<void>[] = [];
  try {
    while (true) {
      const next = await entries.read();
      if (!next) break;
      if (visited++ >= WINDOW_DISCOVERY_LIMITS.directoryEntries || admitted >= WINDOW_DISCOVERY_LIMITS.hosts) {
        complete = false;
        break;
      }
      const name = next.name;
      if (!/^[a-f0-9]{24}\.json$/.test(name)) continue;
      const file = path.join(directory, name);
      let bytes: string;
      let entry: HostRegistration;
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.size > REGISTRY_BYTES) continue;
        bytes = readRegistration(file);
        const value: unknown = JSON.parse(bytes);
        if (
          !windowInfo(value) ||
          !record(value) ||
          typeof value.token !== 'string' ||
          !TOKEN.test(value.token) ||
          value.hostId !== name.slice(0, -5) ||
          !validHostAddress(home, value.hostId, value.address)
        )
          continue;
        entry = value as unknown as HostRegistration;
      } catch {
        continue;
      }
      admitted++;
      batch.push(
        (async () => {
          const info = await pingWindow(entry).catch(() => null);
          if (info) live.push(info);
          else if (processIsDead(entry.pid)) {
            if (!removeOwnedRegistration(file, bytes, entry.address, home, false)) complete = false;
          } else complete = false;
        })(),
      );
      if (batch.length === WINDOW_DISCOVERY_LIMITS.concurrency) {
        await Promise.all(batch);
        batch = [];
      }
    }
  } catch (error) {
    throw new Error('Arc windows are unavailable.', { cause: error });
  } finally {
    try {
      await Promise.all(batch);
    } finally {
      await entries.close();
    }
  }
  return { windows: live.sort((a, b) => a.hostId.localeCompare(b.hostId)), complete };
}
