import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Duplex } from 'node:stream';
import { promisify } from 'node:util';
import { WINDOW_PIPE_SOURCE } from './windowpipe-source.ts';

let bridge: Promise<PipeBridge> | null = null;
let executable: Promise<string> | null = null;
let nextId = 0;

async function compile(): Promise<string> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-window-pipe-'));
  const source = path.join(directory, 'bridge.cs');
  const output = path.join(directory, 'bridge.exe');
  const system = process.env.SystemRoot ?? 'C:/Windows';
  const compiler = path.join(system, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  try {
    const run = promisify(execFile);
    const options = { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 };
    const identity = await run(path.join(system, 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], options);
    const sid = identity.stdout.match(/S-1-\d+(?:-\d+)+/)?.[0];
    if (!sid) throw new Error('The Arc window channel is unavailable.');
    await run(
      path.join(system, 'System32', 'icacls.exe'),
      [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'],
      options,
    );
    fs.writeFileSync(source, WINDOW_PIPE_SOURCE);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(compiler, ['/nologo', '/optimize+', '/target:exe', `/out:${output}`, source], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let bytes = 0;
      const deadline = setTimeout(() => child.kill(), 10_000);
      const count = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024) child.kill();
      };
      child.stdout.on('data', count);
      child.stderr.on('data', count);
      child.once('error', reject);
      child.once('close', (code) => {
        clearTimeout(deadline);
        if (code === 0) resolve();
        else reject(new Error('The Arc window channel is unavailable.'));
      });
    });
    process.once('exit', () => {
      try {
        fs.rmSync(directory, { recursive: true, force: true });
      } catch {
        /* A terminated bridge retains its private build directory. */
      }
    });
    return output;
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

class PipeSocket extends Duplex {
  constructor(
    readonly id: number,
    private readonly owner: PipeBridge,
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
  async listen(address: string): Promise<void> {
    const owner = await getBridge();
    if (this.ended) return;
    this.owner = owner;
    this.pid = owner.child.pid!;
    owner.servers.set(this.id, this);
    await new Promise<void>((resolve, reject) => {
      this.once('listening', resolve);
      this.once('error', reject);
      owner.send(`listen:${this.id}:${Buffer.from(address).toString('base64')}`);
    });
  }
  close(): void {
    this.ended = true;
    this.owner?.servers.delete(this.id);
    this.owner?.send(`close:${this.id}`);
    this.owner?.release();
  }
}

class PipeBridge {
  readonly sockets = new Map<number, PipeSocket>();
  readonly servers = new Map<number, WindowsPipeServer>();
  private pending = '';
  constructor(readonly child: ChildProcessWithoutNullStreams) {
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
        else if (parts[0] === 'error') server?.emit('error', new Error('The Arc window channel is unavailable.'));
        else if (parts[0] === 'accept') {
          const accepted = new PipeSocket(Number(parts[2]), this);
          this.sockets.set(accepted.id, accepted);
          if (server) server.emit('connection', accepted);
          else accepted.destroy();
        } else if (parts[0] === 'open') socket?.emit('connect');
        else if (parts[0] === 'data') {
          if (socket && !socket.push(Buffer.from(parts[2], 'base64'))) socket.destroy();
        } else if (parts[0] === 'close') socket?.destroy();
      }
      if (this.pending.length > 100_000) child.kill();
    });
    child.stderr.on('data', () => child.kill());
    child.on('error', () => this.failed());
    child.on('close', () => this.failed());
    child.stdin.on('error', () => this.failed());
  }
  send(line: string, callback: (error?: Error | null) => void = () => {}): void {
    if (this.child.stdin.destroyed || this.child.stdin.writableLength + line.length > 2 * 1024 * 1024) {
      this.child.kill();
      callback(new Error('The Arc window channel is unavailable.'));
      return;
    }
    this.child.stdin.write(line + '\n', callback);
  }
  release(): void {
    if (!this.servers.size && !this.sockets.size) {
      bridge = null;
      this.child.stdin.end();
    }
  }
  private failed(): void {
    if (!this.servers.size && !this.sockets.size) return;
    bridge = null;
    for (const socket of this.sockets.values()) socket.destroy();
    for (const server of this.servers.values())
      server.emit('error', new Error('The Arc window channel is unavailable.'));
    this.servers.clear();
  }
}

async function getBridge(): Promise<PipeBridge> {
  const packaged = path.join(__dirname, 'windowpipe.exe');
  executable ??= fs.existsSync(packaged) ? Promise.resolve(packaged) : compile();
  bridge ??= executable.then((file) => new PipeBridge(spawn(file, [], { windowsHide: true, stdio: 'pipe' })));
  try {
    return await bridge;
  } catch (error) {
    bridge = null;
    executable = null;
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
  queueMicrotask(() =>
    owner.send(
      `connect:${socket.id}:${Buffer.from(address).toString('base64')}:${hostPid}:${serverPid}:${Buffer.from(registrationFile).toString('base64')}:${Math.max(1, Math.min(2_147_483_647, Math.trunc(deadlineMs)))}`,
    ),
  );
  return socket;
}
