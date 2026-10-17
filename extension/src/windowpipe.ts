import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Duplex } from 'node:stream';
import { promisify } from 'node:util';
import { WINDOW_PIPE_SOURCE } from './windowpipe-source.ts';

let bridge: Promise<PipeBridge> | null = null;
let currentBridge: PipeBridge | null = null;
let executable: Promise<string> | null = null;
let nextId = 0;

export type WindowTransportReason =
  | 'compilerTimeout'
  | 'compilerOutputOverflow'
  | 'compilerError'
  | 'compilerClose'
  | 'setupRejected'
  | 'stderr'
  | 'stdoutOverflow'
  | 'stdinDestroyed'
  | 'stdinBacklog'
  | 'stdinError'
  | 'childError'
  | 'childClose'
  | 'listenerError'
  | 'release'
  | 'channelError'
  | 'channelSetupRejected'
  | 'channelDispose'
  | 'registrationRemoval'
  | 'channelConstructionRejected';
type TransportFields = {
  stage?:
    | 'directory'
    | 'identity'
    | 'permissions'
    | 'source'
    | 'compiler'
    | 'spawn'
    | 'read'
    | 'unlink'
    | 'socketStat'
    | 'socketUnlink'
    | 'directoryRemove';
  outcome?: 'noExpectedBytes' | 'ownershipMismatch' | 'removed' | 'failed';
  errorCode?: string;
  childPid?: number;
  serverId?: number;
  servers?: number;
  sockets?: number;
  stdoutCharacters?: number;
  stderrBytes?: number;
  outputBytes?: number;
  stdinBytes?: number;
  released?: boolean;
  stdinEnded?: boolean;
  stdinDestroyed?: boolean;
  registrationRemoved?: boolean;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
};
export type WindowTransportRecord = { reason: WindowTransportReason } & TransportFields;
export type WindowTransportSink = (event: 'windowTransport', record: WindowTransportRecord) => void;
const ERROR_CODES = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'EBUSY',
  'EPIPE',
  'ECONNRESET',
  'ENOBUFS',
  'EIO',
  'ETIMEDOUT',
]);

export function windowTransportErrorCode(error: unknown): string {
  try {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return typeof code === 'string' && ERROR_CODES.has(code) ? code : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function reportWindowTransport(
  sink: WindowTransportSink | undefined,
  reason: WindowTransportReason,
  fields: TransportFields = {},
): void {
  if (!sink) return;
  try {
    // Copy only the fixed transport fields. No stream or error object reaches the sink.
    const record: WindowTransportRecord = { reason };
    for (const key of [
      'childPid',
      'serverId',
      'servers',
      'sockets',
      'stdoutCharacters',
      'stderrBytes',
      'outputBytes',
      'stdinBytes',
      'exitCode',
    ] as const) {
      const value = fields[key];
      if (typeof value === 'number' && Number.isSafeInteger(value)) record[key] = value;
    }
    if (fields.exitCode === null) record.exitCode = null;
    for (const key of ['released', 'stdinEnded', 'stdinDestroyed', 'registrationRemoved'] as const)
      if (typeof fields[key] === 'boolean') record[key] = fields[key];
    if (fields.stage) record.stage = fields.stage;
    if (fields.outcome) record.outcome = fields.outcome;
    if (fields.errorCode) record.errorCode = ERROR_CODES.has(fields.errorCode) ? fields.errorCode : 'unknown';
    if (fields.signal === null) record.signal = null;
    else if (fields.signal && Object.hasOwn(os.constants.signals, fields.signal)) record.signal = fields.signal;
    if (Buffer.byteLength(JSON.stringify({ event: 'windowTransport', ...record })) <= 1024)
      sink('windowTransport', record);
  } catch {
    /* Diagnostic failure leaves transport behavior unchanged. */
  }
}

export async function compileWindowsPipe(
  diagnostics?: WindowTransportSink,
  run = promisify(execFile),
  launch = spawn,
): Promise<string> {
  let stage: TransportFields['stage'] = 'directory';
  const reasons = new Set<WindowTransportReason>();
  const report = (reason: WindowTransportReason, fields: TransportFields = {}) => {
    if (reasons.has(reason)) return;
    reasons.add(reason);
    reportWindowTransport(diagnostics, reason, { stage, ...fields });
  };
  let directory: string | undefined;
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-window-pipe-'));
    const source = path.join(directory, 'bridge.cs');
    const output = path.join(directory, 'bridge.exe');
    const system = process.env.SystemRoot ?? 'C:/Windows';
    const compiler = path.join(system, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    const options = { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 };
    stage = 'identity';
    const identity = await run(path.join(system, 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], options);
    const sid = identity.stdout.match(/S-1-\d+(?:-\d+)+/)?.[0];
    if (!sid) throw new Error('The Arc window channel is unavailable.');
    stage = 'permissions';
    await run(
      path.join(system, 'System32', 'icacls.exe'),
      [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'],
      options,
    );
    stage = 'source';
    fs.writeFileSync(source, WINDOW_PIPE_SOURCE);
    stage = 'compiler';
    await new Promise<void>((resolve, reject) => {
      const child = launch(compiler, ['/nologo', '/optimize+', '/target:exe', `/out:${output}`, source], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let bytes = 0;
      const deadline = setTimeout(() => {
        report('compilerTimeout', { childPid: child.pid, outputBytes: bytes });
        child.kill();
      }, 10_000);
      const count = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024) {
          report('compilerOutputOverflow', { childPid: child.pid, outputBytes: bytes });
          child.kill();
        }
      };
      child.stdout.on('data', count);
      child.stderr.on('data', count);
      child.once('error', (error) => {
        report('compilerError', { childPid: child.pid, errorCode: windowTransportErrorCode(error) });
        reject(error);
      });
      child.once('close', (code, signal) => {
        clearTimeout(deadline);
        if (code !== 0) report('compilerClose', { childPid: child.pid, exitCode: code, signal, outputBytes: bytes });
        if (code === 0) resolve();
        else reject(new Error('The Arc window channel is unavailable.'));
      });
    });
    process.once('exit', () => {
      try {
        fs.rmSync(directory!, { recursive: true, force: true });
      } catch {
        /* A terminated bridge retains its private build directory. */
      }
    });
    return output;
  } catch (error) {
    if (stage === 'compiler' && reasons.size === 0)
      report('compilerError', { errorCode: windowTransportErrorCode(error) });
    report('setupRejected', { errorCode: windowTransportErrorCode(error) });
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

class PipeSocket extends Duplex {
  constructor(
    readonly id: number,
    private readonly owner: PipeBridge,
    readonly serverId?: number,
  ) {
    super();
  }
  _read(): void {}
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.owner.send(`write:${this.id}:${chunk.toString('base64')}`, callback);
  }
  _destroy(_error: Error | null, callback: (error?: Error | null) => void): void {
    this.owner.sockets.delete(this.id);
    this.owner.send(`close:${this.id}`, () => callback());
    this.owner.release();
  }
}

export class WindowsPipeServer extends EventEmitter {
  static connect = connectWindowsPipe;
  readonly id = ++nextId;
  pid = 0;
  private owner: PipeBridge | null = null;
  private ended = false;
  private acquiring: Promise<PipeBridge> | null = null;
  private cancelListen: (() => void) | null = null;
  private startup: Promise<void> | null = null;
  private disposal: Promise<void> | null = null;
  constructor(private readonly diagnostics?: WindowTransportSink) {
    super();
  }
  async listen(address: string): Promise<void> {
    const owner = await (this.acquiring = getBridge(this.diagnostics));
    if (this.ended) {
      owner.release();
      throw new Error('The Arc window channel is unavailable.');
    }
    this.owner = owner;
    owner.servers.set(this.id, this);
    owner.retain();
    let settled!: () => void;
    this.startup = new Promise<void>((resolve) => {
      settled = resolve;
    });
    await new Promise<void>((resolve, reject) => {
      const listening = () => {
        cleanup();
        if (!this.ended) this.pid = owner.child.pid!;
        resolve();
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        this.removeListener('listening', listening);
        this.removeListener('error', failed);
        this.cancelListen = null;
        settled();
      };
      // Public cancellation preserves the native outcome needed to order listener retirement.
      this.cancelListen = () => reject(new Error('The Arc window channel is unavailable.'));
      this.once('listening', listening);
      this.once('error', failed);
      owner.send(`listen:${this.id}:${Buffer.from(address).toString('base64')}`);
    });
  }
  close(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.ended = true;
    this.cancelListen?.();
    return (this.disposal = (async () => {
      const owner = this.owner ?? (await this.acquiring?.catch(() => null));
      await this.startup;
      if (owner) await owner.retire(this.id);
    })());
  }
}

export class PipeBridge {
  readonly sockets = new Map<number, PipeSocket>();
  readonly servers = new Map<number, WindowsPipeServer>();
  private pending = '';
  private released = false;
  private dead = false;
  private closed = false;
  private readonly closing = new Map<number, () => void>();
  private readonly childClosed: Promise<void>;
  private resolveClosed!: () => void;
  private readonly reasons = new Set<WindowTransportReason>();
  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    private diagnostics?: WindowTransportSink,
  ) {
    this.childClosed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.pending += chunk;
      let end: number;
      while ((end = this.pending.indexOf('\n')) >= 0) {
        const parts = this.pending.slice(0, end).trim().split(':');
        this.pending = this.pending.slice(end + 1);
        const id = Number(parts[1]);
        const socket = this.sockets.get(id);
        const server = this.servers.get(id);
        if (parts[0] === 'listen') server?.emit('listening');
        else if (parts[0] === 'error') {
          this.report('listenerError', { serverId: id });
          server?.emit('error', new Error('The Arc window channel is unavailable.'));
        } else if (parts[0] === 'accept') {
          const accepted = new PipeSocket(Number(parts[2]), this, id);
          this.sockets.set(accepted.id, accepted);
          if (server) server.emit('connection', accepted);
          else accepted.destroy();
        } else if (parts[0] === 'open') socket?.emit('connect');
        else if (parts[0] === 'data') {
          if (socket && !socket.push(Buffer.from(parts[2], 'base64'))) socket.destroy();
        } else if (parts[0] === 'close') {
          socket?.destroy();
          this.closing.get(id)?.();
          this.closing.delete(id);
        }
      }
      if (this.pending.length > 100_000) {
        this.report('stdoutOverflow', { stdoutCharacters: this.pending.length });
        child.kill();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      this.report('stderr', { stderrBytes: chunk.length });
      child.kill();
    });
    child.on('error', (error) => {
      this.report('childError', { errorCode: windowTransportErrorCode(error) });
      this.failed();
    });
    child.on('close', (exitCode, signal) => {
      this.report('childClose', { exitCode, signal });
      this.closed = true;
      this.resolveClosed();
      for (const resolve of this.closing.values()) resolve();
      this.closing.clear();
      this.failed();
    });
    child.stdin.on('error', (error) => {
      this.report('stdinError', { errorCode: windowTransportErrorCode(error) });
      this.failed();
    });
  }
  observe(diagnostics?: WindowTransportSink): void {
    this.diagnostics ??= diagnostics;
  }
  retain(): void {
    this.released = false;
  }
  async retire(serverId: number): Promise<void> {
    this.servers.delete(serverId);
    const pending: Promise<void>[] = [];
    for (const socket of this.sockets.values()) {
      if (socket.serverId !== serverId) continue;
      if (!this.closed) pending.push(new Promise((resolve) => this.closing.set(socket.id, resolve)));
      socket.destroy();
    }
    if (!this.closed && !this.dead && !this.released) this.send(`close:${serverId}`);
    this.release();
    if (this.released || this.dead) await this.childClosed;
    else {
      // A rejected connect acknowledges consumption of the preceding close command.
      const id = ++nextId;
      const consumed = new Promise<void>((resolve) => this.closing.set(id, resolve));
      this.send(`connect:${id}::0:0::1`);
      await Promise.all([...pending, consumed]);
    }
  }
  private report(reason: WindowTransportReason, fields: TransportFields = {}): void {
    if (reason !== 'release' && this.reasons.has(reason)) return;
    this.reasons.add(reason);
    reportWindowTransport(this.diagnostics, reason, {
      childPid: this.child.pid,
      servers: this.servers.size,
      sockets: this.sockets.size,
      released: this.released,
      stdinEnded: this.child.stdin.writableEnded,
      stdinDestroyed: this.child.stdin.destroyed,
      ...fields,
    });
  }
  send(line: string, callback: (error?: Error | null) => void = () => {}): void {
    if (this.child.stdin.destroyed || this.child.stdin.writableLength + line.length > 2 * 1024 * 1024) {
      this.report(this.child.stdin.destroyed ? 'stdinDestroyed' : 'stdinBacklog', {
        stdinBytes: this.child.stdin.writableLength + line.length,
      });
      this.child.kill();
      callback(new Error('The Arc window channel is unavailable.'));
      return;
    }
    this.child.stdin.write(line + '\n', callback);
  }
  release(): void {
    if (!this.servers.size && !this.sockets.size) {
      if (!this.released) {
        this.released = true;
        this.report('release');
      }
      this.detach();
      this.child.stdin.end();
    }
  }
  private failed(): void {
    this.dead = true;
    this.detach();
    if (!this.closed) this.child.kill();
    if (!this.servers.size && !this.sockets.size) return;
    for (const socket of this.sockets.values()) socket.destroy();
    for (const server of this.servers.values())
      server.emit('error', new Error('The Arc window channel is unavailable.'));
    this.servers.clear();
  }
  private detach(): void {
    if (currentBridge !== this) return;
    currentBridge = null;
    bridge = null;
  }
}

async function getBridge(diagnostics?: WindowTransportSink): Promise<PipeBridge> {
  const packaged = path.join(__dirname, 'windowpipe.exe');
  executable ??= fs.existsSync(packaged) ? Promise.resolve(packaged) : compileWindowsPipe(diagnostics);
  bridge ??= executable.then((file) => {
    try {
      const owner = new PipeBridge(spawn(file, [], { windowsHide: true, stdio: 'pipe' }), diagnostics);
      currentBridge = owner;
      return owner;
    } catch (error) {
      reportWindowTransport(diagnostics, 'setupRejected', {
        stage: 'spawn',
        errorCode: windowTransportErrorCode(error),
      });
      throw error;
    }
  });
  const pending = bridge;
  try {
    const owner = await pending;
    owner.observe(diagnostics);
    return owner;
  } catch (error) {
    if (bridge === pending) {
      bridge = null;
      executable = null;
    }
    throw error;
  }
}

export async function connectWindowsPipe(
  address: string,
  hostPid: number,
  serverPid: number,
  registrationFile = '',
  deadlineMs = 1_000,
): Promise<Duplex> {
  const owner = await getBridge();
  const socket = new PipeSocket(++nextId, owner);
  owner.sockets.set(socket.id, socket);
  owner.retain();
  queueMicrotask(() =>
    owner.send(
      `connect:${socket.id}:${Buffer.from(address).toString('base64')}:${hostPid}:${serverPid}:${Buffer.from(registrationFile).toString('base64')}:${Math.max(1, Math.min(2_147_483_647, Math.trunc(deadlineMs)))}`,
    ),
  );
  return socket;
}
