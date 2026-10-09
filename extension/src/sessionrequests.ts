import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Duplex } from 'node:stream';
import { writeFileAtomically } from './atomicfile.ts';
import { ARC_IDENTITY } from './identity.ts';
import { arcHome } from './store.ts';
import { WindowsPipeServer } from './windowpipe.ts';
import { SessionWriteRequests, validSessionWrite, type SessionWriteParams } from './sessionwrites.ts';

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
  transportPid?: number;
}

export interface WindowDiscovery {
  windows: WindowInfo[];
  complete: boolean;
}

export interface SessionRequest {
  id: string;
  version: typeof SESSION_REQUEST_VERSION;
  token: string;
  method: 'ping' | 'sessions' | 'session' | 'setups' | 'start' | 'curate';
  requester: string | null;
  params: SessionWriteParams;
}

export type SessionReply = { id: string | null; result: unknown } | { id: string | null; error: string };

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
    !['ping', 'sessions', 'session', 'setups', 'start', 'curate'].includes(value.method as string) ||
    !(
      value.requester === null ||
      (typeof value.requester === 'string' && value.requester.length > 0 && value.requester.length <= 256)
    ) ||
    !record(value.params)
  )
    return null;
  if (value.method === 'session') {
    if (
      Object.keys(value.params).sort().join(',') !== 'sessionId,turns' ||
      typeof value.params.sessionId !== 'string' ||
      !value.params.sessionId.length ||
      value.params.sessionId.length > 256 ||
      !Number.isSafeInteger(value.params.turns) ||
      (value.params.turns as number) < 1 ||
      (value.params.turns as number) > 20
    )
      return null;
  } else if (['setups', 'start', 'curate'].includes(value.method as string)) {
    if (!validSessionWrite(value.method as string, value.params)) return null;
  } else if (Object.keys(value.params).length !== 0) return null;
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
  socket: Duplex,
  limits: typeof SESSION_REQUEST_LIMITS | RequestLimits,
  line: (text: string) => void,
  idleDeadlineMs = limits.lineDeadlineMs,
): void {
  let pending = Buffer.alloc(0);
  let idle = false;
  let deadline = setTimeout(() => socket.destroy(), limits.lineDeadlineMs);
  const restart = (ms = idleDeadlineMs, betweenLines = true) => {
    idle = betweenLines;
    clearTimeout(deadline);
    deadline = setTimeout(() => socket.destroy(), ms);
  };
  socket.on('close', () => clearTimeout(deadline));
  socket.on('error', () => socket.destroy());
  socket.on('data', (chunk: Buffer) => {
    let start = 0;
    while (start < chunk.length && !socket.destroyed) {
      if (idle) restart(limits.lineDeadlineMs, false);
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
  private readonly writes = new SessionWriteRequests(this.hostId);
  private readonly token = crypto.randomBytes(32).toString('hex');
  private readonly address: string;
  private readonly registryFile: string;
  private readonly sockets = new Set<Duplex>();
  private readonly server: net.Server;
  private readonly windowsServer: WindowsPipeServer | null;
  private state: WindowState | null = null;
  private registeredBytes: string | null = null;
  private listening = false;
  private starting: Promise<void> | null = null;
  private closed = false;
  private inFlight = 0;
  private disposal: Promise<void> | null = null;
  private requestHandler: ((request: SessionRequest) => unknown | Promise<unknown>) | null = null;

  setRequestHandler(handler: (request: SessionRequest) => unknown | Promise<unknown>): void {
    this.requestHandler = handler;
  }

  constructor(
    private readonly home = arcHome(),
    private readonly limits: RequestLimits = SESSION_REQUEST_LIMITS,
    private readonly ping: (info: WindowInfo) => WindowInfo | Promise<WindowInfo> = (info) => info,
  ) {
    this.address = hostAddress(home, this.hostId);
    this.registryFile = path.join(home, 'hosts', `${this.hostId}.json`);
    this.server = net.createServer((socket) => this.accept(socket));
    this.windowsServer = process.platform === 'win32' ? new WindowsPipeServer() : null;
    this.windowsServer?.on('connection', (socket: Duplex) => this.accept(socket));
    this.windowsServer?.on('error', (error: Error) => this.server.emit('error', error));
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
    const registration: HostRegistration = {
      ...this.info(),
      address: this.address,
      token: this.token,
      ...(this.windowsServer ? { transportPid: this.windowsServer.pid } : {}),
    };
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
    if (this.windowsServer) {
      await this.windowsServer.listen(this.address);
      this.listening = true;
    } else {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => reject(error);
        this.server.once('error', failed);
        this.server.listen(this.address, () => {
          this.server.removeListener('error', failed);
          this.listening = true;
          resolve();
        });
      });
    }
    if (this.closed) return;
    try {
      if (process.platform !== 'win32') fs.chmodSync(this.address, 0o600);
      this.publish();
    } catch (error) {
      void this.dispose();
      throw error;
    }
  }

  private accept(socket: Duplex): void {
    if (this.closed || this.sockets.size >= this.limits.connections) {
      socket.on('error', () => {});
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    receiveLines(
      socket,
      this.limits,
      (text) => {
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch {
          this.answer(socket, { id: null, error: 'Invalid request.' });
          return;
        }
        if (
          record(value) &&
          Object.keys(value).join(',') === 'challenge' &&
          typeof value.challenge === 'string' &&
          TOKEN.test(value.challenge)
        ) {
          const proof = crypto
            .createHmac('sha256', Buffer.from(this.token, 'hex'))
            .update(value.challenge)
            .digest('hex');
          const bytes = JSON.stringify({ proof }) + '\n';
          if (socket.writableLength + Buffer.byteLength(bytes) > this.limits.lineBytes) socket.destroy();
          else socket.write(bytes);
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
          .then<unknown>(() => {
            if (this.closed) throw new Error('Window unavailable.');
            if (request.method === 'ping') return this.ping(this.info());
            if (!this.requestHandler) throw new Error('Session reads are unavailable in this window.');
            const apply = () => this.requestHandler!(request);
            const data =
              request.method === 'start' || request.method === 'curate'
                ? this.writes.run(request.id, { method: request.method, params: request.params }, apply)
                : Promise.resolve().then(apply);
            return Promise.resolve(data).then((data) => {
              if (request.method === 'start' || request.method === 'curate')
                data = { ...(data as object), requestId: request.id };
              const result = { window: this.info(), data };
              if (Buffer.byteLength(JSON.stringify({ id: request.id, result }) + '\n') > this.limits.lineBytes)
                throw new Error("The session response exceeds this window's channel limit.");
              return result;
            });
          })
          .then(
            (result) => this.answer(socket, { id: request.id, result }),
            (error: unknown) =>
              this.answer(socket, {
                id: request.id,
                error: error instanceof Error ? error.message : 'Window unavailable.',
              }),
          )
          .finally(() => {
            this.inFlight--;
          });
      },
      120_000,
    );
  }

  private answer(socket: Duplex, reply: SessionReply): void {
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
    // A submitted listener must finish before its channel can close.
    await this.starting?.catch(() => {});
    if (this.windowsServer) this.windowsServer.close();
    else if (this.listening) await new Promise<void>((resolve) => this.server.close(() => resolve()));
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

async function exchangeWindow(
  entry: HostRegistration,
  deadlineMs = 1_000,
  registrationFile = '',
  method: SessionRequest['method'] = 'ping',
  params: SessionRequest['params'] = {},
  requestId?: string,
): Promise<unknown | null> {
  if (process.platform === 'win32' && (!Number.isSafeInteger(entry.transportPid) || entry.transportPid! <= 0))
    return null;
  const socket =
    process.platform === 'win32'
      ? await WindowsPipeServer.connect(entry.address, entry.pid, entry.transportPid!, registrationFile, deadlineMs)
      : net.createConnection(entry.address);
  return new Promise((resolve, reject) => {
    const id = requestId ?? `${entry.hostId}:${crypto.randomBytes(12).toString('hex')}`;
    const challenge = crypto.randomBytes(32).toString('hex');
    let authenticated = false;
    let settled = false;
    const finish = (info: unknown | null) => {
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
        if (!authenticated) {
          const expected = crypto.createHmac('sha256', Buffer.from(entry.token, 'hex')).update(challenge).digest('hex');
          if (
            !record(reply) ||
            typeof reply.proof !== 'string' ||
            !TOKEN.test(reply.proof) ||
            !crypto.timingSafeEqual(Buffer.from(reply.proof, 'hex'), Buffer.from(expected, 'hex'))
          ) {
            finish(null);
            return;
          }
          authenticated = true;
          const request: SessionRequest = {
            id,
            version: SESSION_REQUEST_VERSION,
            token: entry.token,
            method,
            requester: process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_THREAD_ID || null,
            params,
          };
          socket.write(JSON.stringify(request) + '\n');
          return;
        }
        if (record(reply) && reply.id === id && typeof reply.error === 'string') {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          socket.destroy();
          reject(new Error(reply.error));
          return;
        }
        const info =
          method === 'ping'
            ? record(reply)
              ? reply.result
              : null
            : record(reply) && record(reply.result)
              ? reply.result.window
              : null;
        if (
          !record(reply) ||
          reply.id !== id ||
          !windowInfo(info) ||
          info.hostId !== entry.hostId ||
          info.pid !== entry.pid
        ) {
          finish(null);
          return;
        }
        const { hostId, pid, version, folders, scopeReady, panelReady, panelVisible } = info;
        finish(
          method === 'ping'
            ? { hostId, pid, version, folders, scopeReady, panelReady, panelVisible }
            : (reply.result as Record<string, unknown>).data,
        );
      } catch {
        finish(null);
      }
    });
    socket.on('connect', () => {
      socket.write(JSON.stringify({ challenge }) + '\n');
    });
  });
}

export async function pingWindow(
  entry: HostRegistration,
  deadlineMs = 1_000,
  registrationFile = '',
): Promise<WindowInfo | null> {
  return (await exchangeWindow(entry, deadlineMs, registrationFile).catch(() => null)) as WindowInfo | null;
}

export async function requestWindow(
  method: Exclude<SessionRequest['method'], 'ping'>,
  params: SessionRequest['params'],
  selector = process.env[`${ARC_IDENTITY.environmentPrefix}WINDOW`],
  home = arcHome(),
  requestId?: string,
): Promise<unknown> {
  let selected = selector;
  if (!selected) {
    const discovery = await discoverWindows(home);
    if (!discovery.complete) throw new Error('Arc window discovery is incomplete. Select a window with --window.');
    if (discovery.windows.length !== 1)
      throw new Error(`Select one Arc window with --window or ${ARC_IDENTITY.environmentPrefix}WINDOW.`);
    selected = discovery.windows[0].hostId;
  }
  if (!HOST_ID.test(selected)) throw new Error('Invalid Arc window identifier.');
  const file = path.join(home, 'hosts', `${selected}.json`);
  let entry: HostRegistration;
  try {
    const value: unknown = JSON.parse(readRegistration(file));
    if (
      !windowInfo(value) ||
      !record(value) ||
      value.hostId !== selected ||
      typeof value.token !== 'string' ||
      !TOKEN.test(value.token) ||
      !validHostAddress(home, selected, value.address)
    )
      throw new Error();
    entry = value as unknown as HostRegistration;
  } catch {
    throw new Error('The selected Arc window is unavailable.');
  }
  const id = requestId ?? `${entry.hostId}:${crypto.randomBytes(12).toString('hex')}`;
  if (requestId && !requestId.startsWith(entry.hostId + ':'))
    throw new Error(`Request ${requestId} has an unknown outcome in this activation.`);
  const write = method === 'start' || method === 'curate';
  const result = await exchangeWindow(entry, write ? 120_000 : 1_000, file, method, params, id);
  if (result === null) {
    if (write)
      return {
        version: 1,
        status: 'unknown',
        requestId: id,
        window: entry.hostId,
        reason: 'Delivery is unknown. Retry only this request ID in this window.',
      };
    throw new Error('The selected Arc window is unavailable.');
  }
  return result;
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
          !validHostAddress(home, value.hostId, value.address) ||
          (process.platform === 'win32' &&
            (!Number.isSafeInteger(value.transportPid) || (value.transportPid as number) <= 0))
        )
          continue;
        entry = value as unknown as HostRegistration;
      } catch {
        continue;
      }
      admitted++;
      batch.push(
        (async () => {
          const info = await pingWindow(entry, 1_000, file).catch(() => null);
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
