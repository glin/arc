import fs from 'node:fs';
import * as path from 'node:path';
import os from 'node:os';
import * as zlib from 'node:zlib';
import { Worker, isMainThread, threadId } from 'node:worker_threads';
import { revisionOf } from './filerevision';

type Zstd = { createZstdDecompress?: (options?: { chunkSize: number }) => zlib.Gunzip };
const nativeZstd = zlib as unknown as Zstd;
export const isCompressedRollout = (file: string) => file.toLowerCase().endsWith('.jsonl.zst');
export function rolloutStem(file: string): string {
  return file.replace(/\.jsonl(?:\.zst)?$/i, '');
}
export function alternateRolloutPath(file: string): string | null {
  return isCompressedRollout(file) ? file.slice(0, -4) : file.endsWith('.jsonl') ? file + '.zst' : null;
}
export function rolloutThreadId(file: string): string | null {
  return (
    /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(rolloutStem(path.basename(file)))?.[1] ??
    null
  );
}
export function isRolloutName(file: string): boolean {
  return file.endsWith('.jsonl') || (file.endsWith('.jsonl.zst') && rolloutSources.supported());
}
// Apply this to a complete directory or inventory before admitting any source.
export function preferPlainRollouts<T>(values: readonly T[], name: (value: T) => string): T[] {
  const plain = new Set(values.map(name).filter((file) => /\.jsonl$/i.test(file)));
  return values.filter((value) => !isCompressedRollout(name(value)) || !plain.has(name(value).slice(0, -4)));
}
function revisionKey(stat: fs.BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}
function sized<S extends fs.Stats | fs.BigIntStats>(stat: S, size: number): S {
  return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
    size: typeof stat.size === 'bigint' ? BigInt(size) : size,
  });
}

export class RolloutSource {
  private closed = false;
  constructor(
    readonly identity: string,
    readonly descriptor: number,
    private readonly physical?: fs.BigIntStats,
    private readonly io: typeof fs = fs,
    private readonly release: () => void = () => undefined,
  ) {}
  get size(): number {
    return Number(this.stat({ bigint: true }).size);
  }
  get mtimeMs(): number {
    return this.stat().mtimeMs;
  }
  physicalStat(): fs.BigIntStats {
    const stat = this.physical
      ? this.io.statSync(this.identity, { bigint: true })
      : this.io.fstatSync(this.descriptor, { bigint: true });
    if (this.physical && revisionKey(stat) !== revisionKey(this.physical)) throw new Error('The session file changed.');
    return stat;
  }
  read(offset: number, length: number): Buffer {
    const buffer = Buffer.allocUnsafe(Math.max(0, Math.min(length, this.size - offset)));
    return buffer.subarray(0, this.readInto(buffer, 0, buffer.length, offset));
  }
  readInto(buffer: Buffer, offset: number, length: number, position: number | null): number {
    return this.io.readSync(this.descriptor, buffer, offset, length, position);
  }
  stat(options: { bigint: true }): fs.BigIntStats;
  stat(options?: { bigint?: false }): fs.Stats;
  stat(options?: { bigint?: boolean }): fs.Stats | fs.BigIntStats {
    if (!this.physical)
      return options?.bigint
        ? this.io.fstatSync(this.descriptor, { bigint: true })
        : this.io.fstatSync(this.descriptor);
    const stat = this.physicalStat();
    const size = Number(this.io.fstatSync(this.descriptor, { bigint: true }).size);
    return options?.bigint ? sized(stat, size) : sized(this.io.statSync(this.identity), size);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.io.closeSync(this.descriptor);
    } finally {
      this.release();
    }
  }
}

interface Decoded {
  key: string;
  file: string;
  size: number;
  stat: fs.BigIntStats;
  users: number;
}
const temporaryFiles = new Set<string>();
const temporaryDirectories = new Set<string>();
function temporaryOwner(name: string): { pid: number; thread?: number } | null {
  const match = /^arc-rollouts-([1-9]\d*)-(?:(0|[1-9]\d*)-)?[A-Za-z0-9]{6}$/.exec(name);
  if (!match) return null;
  const pid = Number(match[1]);
  const thread = match[2] === undefined ? undefined : Number(match[2]);
  return Number.isSafeInteger(pid) && (thread === undefined || Number.isSafeInteger(thread)) ? { pid, thread } : null;
}

// An omitted owner admits only directories whose process is definitively absent.
export async function cleanupRolloutDirectories(
  owner?: { pid: number; thread: number },
  root = os.tmpdir(),
  kill: (pid: number, signal: 0) => unknown = process.kill,
): Promise<void> {
  try {
    for (const name of await fs.promises.readdir(root)) {
      const identity = temporaryOwner(name);
      if (!identity) continue;
      if (owner) {
        if (identity.pid !== owner.pid || identity.thread !== owner.thread) continue;
      } else {
        try {
          kill(identity.pid, 0);
          continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue;
        }
      }
      const directory = path.join(root, name);
      try {
        const stat = await fs.promises.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        const children = await fs.promises.readdir(directory, { withFileTypes: true });
        if (children.some((child) => !/^[1-9]\d*$/.test(child.name) || !child.isFile() || child.isSymbolicLink()))
          continue;
        const current = await fs.promises.lstat(directory);
        if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino)
          continue;
        for (const child of children) {
          const file = path.join(directory, child.name);
          try {
            const childStat = await fs.promises.lstat(file);
            if (childStat.isFile() && !childStat.isSymbolicLink()) await fs.promises.unlink(file);
          } catch {
            /* Retry retained files on a later cleanup. */
          }
        }
        await fs.promises.rmdir(directory);
      } catch {
        /* Retain unavailable or occupied directories. */
      }
    }
  } catch {
    /* Temporary storage is unavailable. */
  }
}
if (isMainThread) void cleanupRolloutDirectories();

process.once('exit', () => {
  // Parser threads share the host process. Its exit also removes their temporary files.
  if (isMainThread) {
    try {
      for (const name of fs.readdirSync(os.tmpdir())) {
        if (temporaryOwner(name)?.pid !== process.pid) continue;
        const directory = path.join(os.tmpdir(), name);
        if (fs.lstatSync(directory).isSymbolicLink() || !fs.lstatSync(directory).isDirectory()) continue;
        const children = fs.readdirSync(directory, { withFileTypes: true });
        if (children.some((child) => !/^[1-9]\d*$/.test(child.name) || !child.isFile() || child.isSymbolicLink()))
          continue;
        for (const { name: child } of children) {
          const file = path.join(directory, child);
          try {
            if (/^[1-9]\d*$/.test(child) && fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink())
              fs.unlinkSync(file);
          } catch {
            /* still open */
          }
        }
        try {
          fs.rmdirSync(directory);
        } catch {
          /* still open */
        }
      }
    } catch {
      /* temporary storage is unavailable */
    }
  }
  for (const file of temporaryFiles) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* already removed */
    }
  }
  for (const directory of temporaryDirectories) {
    try {
      fs.rmdirSync(directory);
    } catch {
      /* still open */
    }
  }
});

// Synchronous CLI and parser callers wait for a streaming decoder in a separate thread.
// The extension host uses the asynchronous decoder and never waits on this thread.
const decoderWorker = String.raw`
const fs = require('node:fs');
const zlib = require('node:zlib');
const { parentPort } = require('node:worker_threads');
parentPort.on('message', async ({ file, destination, limit, firstLine, shared }) => {
  const status = new Int32Array(shared);
  const input = fs.createReadStream(file, { highWaterMark: 16384 });
  const decoder = zlib.createZstdDecompress({ chunkSize: 16384 });
  input.on('error', error => decoder.destroy(error));
  input.pipe(decoder);
  let fd;
  try {
    fd = fs.openSync(destination, 'wx', 0o600);
    let length = 0;
    for await (const bytes of decoder) {
      const newline = firstLine ? bytes.indexOf(10) : -1;
      const used = limit ? Math.min(newline < 0 ? bytes.length : newline + 1, limit - length) : bytes.length;
      fs.writeSync(fd, bytes, 0, used);
      length += used;
      if (limit && (newline >= 0 || length >= limit)) break;
    }
    Atomics.store(status, 0, 1);
  } catch {
    Atomics.store(status, 0, -1);
  } finally {
    input.destroy();
    decoder.destroy();
    if (fd !== undefined) fs.closeSync(fd);
    if (Atomics.load(status, 0) !== 1) {
      try { fs.unlinkSync(destination); } catch { /* no decoded file */ }
    }
    Atomics.notify(status, 0);
  }
});`;

// Decoded bodies live in private temporary files. Leases pin files, never decoded buffers.
export class RolloutSources {
  private readonly cache = new Map<string, Decoded>();
  private readonly files = new Map<string, { size: number; users: number }>();
  private readonly discarded = new Set<string>();
  private readonly sizes = new Map<string, { key: string; size: number }>();
  private readonly pending = new Map<string, Promise<Decoded>>();
  private gate: Promise<unknown> = Promise.resolve();
  private worker?: Worker;
  private directory?: string;
  private sequence = 0;
  private warned = false;
  private asyncOnly: boolean;
  private logger: ((message: string) => void) | undefined;
  private readonly ready = new Set<(file: string) => void>();
  constructor(
    private readonly options: {
      zstd?: Zstd;
      budget?: number;
      asyncOnly?: boolean;
      log?: (message: string) => void;
      openingBytes?: (bytes: number) => void;
      decodedBytes?: (bytes: number) => void;
      decodeStarted?: (file: string) => void;
    } = {},
  ) {
    this.logger = options.log;
    this.asyncOnly = options.asyncOnly ?? false;
  }
  setLogger(log: (message: string) => void): void {
    this.logger = log;
    this.asyncOnly = true;
    this.supported();
  }
  onReady(callback: (file: string) => void): () => void {
    this.ready.add(callback);
    return () => {
      this.ready.delete(callback);
    };
  }
  supported(): boolean {
    const yes = !!this.codec.createZstdDecompress;
    if (!yes && !this.warned && this.logger) {
      this.warned = true;
      this.logger('Compressed Codex sessions are unavailable in this Node version.');
    }
    return yes;
  }
  private get codec(): Zstd {
    return this.options.zstd ?? nativeZstd;
  }
  private physical(file: string): fs.BigIntStats {
    if (!this.supported())
      throw Object.assign(new Error('Compressed Codex sessions are unavailable.'), { code: 'ENOTSUP' });
    const stat = fs.statSync(file, { bigint: true });
    if (!stat.isFile()) throw new Error('The session file is unavailable.');
    return stat;
  }
  private destination(): string {
    if (!this.directory) {
      this.directory = fs.mkdtempSync(path.join(os.tmpdir(), `arc-rollouts-${process.pid}-${threadId}-`));
      temporaryDirectories.add(this.directory);
    }
    const file = path.join(this.directory, String(++this.sequence));
    temporaryFiles.add(file);
    this.files.set(file, { size: 0, users: 0 });
    return file;
  }
  private remove(entry: Pick<Decoded, 'file'>): boolean {
    try {
      fs.unlinkSync(entry.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        const held = this.files.get(entry.file);
        try {
          this.files.set(entry.file, { size: fs.statSync(entry.file).size, users: held?.users ?? 0 });
        } catch {
          /* Keep the last known size. */
        }
        this.discarded.add(entry.file);
        return false;
      }
    }
    temporaryFiles.delete(entry.file);
    this.discarded.delete(entry.file);
    this.files.delete(entry.file);
    return true;
  }
  private retryDiscarded(): void {
    for (const file of [...this.discarded].slice(0, 8)) {
      this.discarded.delete(file);
      if (!this.files.get(file)?.users) this.remove({ file });
    }
  }
  private trim(keep?: Decoded): void {
    this.retryDiscarded();
    let used = [...this.files.values()].reduce((total, entry) => total + entry.size, 0);
    for (const [key, entry] of this.cache) {
      if (used <= (this.options.budget ?? 256 * 1024 * 1024)) break;
      if (entry.users || entry === keep) continue;
      this.cache.delete(key);
      if (this.remove(entry)) used -= entry.size;
    }
  }
  private hit(key: string, stat: fs.BigIntStats): Decoded | undefined {
    const entry = this.cache.get(key);
    if (!entry || entry.key !== revisionKey(stat)) return undefined;
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry;
  }
  private remember(key: string, entry: Decoded): void {
    const old = this.cache.get(key);
    if (old && !old.users) this.remove(old);
    this.cache.set(key, entry);
    if (!key.includes('\n')) {
      this.sizes.set(key, { key: entry.key, size: entry.size });
      if (this.sizes.size > 50000) this.sizes.delete(this.sizes.keys().next().value!);
    }
    this.trim(entry);
  }
  private pin(entry: Decoded): () => void {
    entry.users++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        entry.users--;
        if (!entry.users && ![...this.cache.values()].includes(entry)) this.remove(entry);
        this.trim(entry);
      }
    };
  }
  private accepted(file: string, destination: string, before: fs.BigIntStats): Decoded {
    if (revisionKey(this.physical(file)) !== revisionKey(before)) throw new Error('The session file changed.');
    const entry = {
      key: revisionKey(before),
      file: destination,
      size: fs.statSync(destination).size,
      stat: before,
      users: 0,
    };
    this.files.set(destination, entry);
    return entry;
  }
  private synchronous(file: string, opening: boolean, stat: fs.BigIntStats, prefixBytes?: number): Decoded {
    const destination = this.destination();
    this.worker ??= new Worker(decoderWorker, { eval: true });
    this.worker.unref();
    const shared = new SharedArrayBuffer(4);
    const status = new Int32Array(shared);
    this.worker.postMessage({
      file,
      destination,
      limit: prefixBytes ?? (opening ? 1024 * 1024 : 0),
      firstLine: opening && prefixBytes === undefined,
      shared,
    });
    try {
      if (Atomics.wait(status, 0, 0, 120000) === 'timed-out' || Atomics.load(status, 0) !== 1)
        throw new Error('The session file is unreadable.');
      return this.accepted(file, destination, stat);
    } catch (error) {
      this.remove({ file: destination });
      throw error;
    }
  }
  open(file: string, opening = false, io: typeof fs = fs, prefixBytes?: number): RolloutSource {
    this.retryDiscarded();
    if (!isCompressedRollout(file)) return new RolloutSource(file, io.openSync(file, 'r'), undefined, io);
    const stat = this.physical(file);
    const key = opening
      ? file + (prefixBytes === undefined ? '\nopening:' + 1024 * 1024 : '\nprefix:' + prefixBytes)
      : file;
    let entry = this.hit(file, stat) ?? (opening ? this.hit(key, stat) : undefined);
    if (!entry) {
      if (this.asyncOnly) {
        void this.load(file, opening, prefixBytes ?? 1024 * 1024, prefixBytes === undefined).catch(() => undefined);
        throw Object.assign(new Error('The session is still loading.'), { code: 'EAGAIN' });
      }
      entry = this.synchronous(file, opening, stat, prefixBytes);
      this.remember(key, entry);
    }
    const release = this.pin(entry);
    try {
      return new RolloutSource(file, fs.openSync(entry.file, 'r'), entry.stat, fs, release);
    } catch (error) {
      release();
      throw error;
    }
  }
  private load(file: string, opening = false, limit = 1024 * 1024, firstLine = true): Promise<Decoded> {
    this.retryDiscarded();
    const stat = this.physical(file);
    const key = opening ? file + (firstLine ? '\nopening:' + limit : '\nprefix:' + limit) : file;
    const hit = this.hit(file, stat) ?? this.hit(key, stat);
    if (hit) return Promise.resolve(hit);
    const held = this.pending.get(key);
    if (held) return held;
    const pending = this.gate
      .catch(() => undefined)
      .then(async () => {
        const before = this.physical(file);
        const destination = this.destination();
        let handle: fs.promises.FileHandle | undefined;
        let output: fs.promises.FileHandle | undefined;
        let input: fs.ReadStream | undefined;
        let decoder: zlib.Gunzip | undefined;
        try {
          try {
            handle = await fs.promises.open(file, 'r');
            output = await fs.promises.open(destination, 'wx', 0o600);
            input = handle.createReadStream({ autoClose: false, highWaterMark: 16 * 1024 });
            const stream = this.codec.createZstdDecompress!({ chunkSize: 16 * 1024 });
            decoder = stream;
            input.on('error', (error) => stream.destroy(error));
            input.pipe(stream);
            if (!opening) this.options.decodeStarted?.(file);
            if (revisionKey(await handle.stat({ bigint: true })) !== revisionKey(before))
              throw new Error('The session file changed.');
            let length = 0;
            for await (const chunk of decoder) {
              const bytes = chunk as Buffer;
              this.options.decodedBytes?.(bytes.length);
              const newline = opening && firstLine ? bytes.indexOf(10) : -1;
              const used = opening ? Math.min(newline < 0 ? bytes.length : newline + 1, limit - length) : bytes.length;
              let written = 0;
              while (written < used) {
                const result = await output.write(bytes, written, used - written);
                written += result.bytesWritten;
              }
              length += used;
              if (opening) this.options.openingBytes?.(bytes.length);
              if (opening && (newline >= 0 || length >= limit)) break;
            }
            if (revisionKey(await handle.stat({ bigint: true })) !== revisionKey(before))
              throw new Error('The session file changed.');
          } finally {
            input?.destroy();
            decoder?.destroy();
            try {
              await output?.close();
            } finally {
              await handle?.close();
            }
          }
          const entry = this.accepted(file, destination, before);
          this.remember(key, entry);
          return entry;
        } catch (error) {
          this.remove({ file: destination });
          throw error;
        }
      });
    this.pending.set(key, pending);
    this.gate = pending.then(
      () => undefined,
      () => undefined,
    );
    void pending.then(
      () => {
        this.pending.delete(key);
        for (const callback of this.ready) callback(file);
      },
      () => {
        this.pending.delete(key);
      },
    );
    return pending;
  }
  async prepare(file: string): Promise<() => void> {
    if (!isCompressedRollout(file)) return () => undefined;
    return this.pin(await this.load(file));
  }
  async opening(file: string, limit = 1024 * 1024): Promise<Buffer> {
    let release: (() => void) | undefined;
    let handle: fs.promises.FileHandle | undefined;
    try {
      if (isCompressedRollout(file)) {
        const entry = await this.load(file, true, limit);
        release = this.pin(entry);
        handle = await fs.promises.open(entry.file, 'r');
      } else handle = await fs.promises.open(file, 'r');
      const buffer = Buffer.allocUnsafe(limit);
      const { bytesRead } = await handle.read(buffer, 0, limit, 0);
      const newline = buffer.subarray(0, bytesRead).indexOf(10);
      return Buffer.from(buffer.subarray(0, newline < 0 ? bytesRead : newline + 1));
    } finally {
      await handle?.close();
      release?.();
    }
  }
  knownStat(file: string): fs.BigIntStats | null {
    const physical = this.physical(file);
    const known = this.sizes.get(file);
    return known?.key === revisionKey(physical) ? sized(physical, known.size) : null;
  }
  stat(file: string, options: { bigint: true }): fs.BigIntStats;
  stat(file: string, options?: { bigint?: false }): fs.Stats;
  stat(file: string, options?: { bigint?: boolean }): fs.Stats | fs.BigIntStats {
    if (!isCompressedRollout(file)) return options?.bigint ? fs.statSync(file, { bigint: true }) : fs.statSync(file);
    let stat = this.knownStat(file);
    if (!stat) {
      const source = this.open(file);
      try {
        stat = source.stat({ bigint: true });
      } finally {
        source.close();
      }
    }
    return options?.bigint ? stat : sized(fs.statSync(file), Number(stat.size));
  }
}
const rolloutSources = new RolloutSources();
export const openRolloutSource = (file: string, opening = false, io: typeof fs = fs, prefixBytes?: number) =>
  rolloutSources.open(file, opening, io, prefixBytes);
export const prepareRolloutSource = (file: string) => rolloutSources.prepare(file);
export const readRolloutOpening = (file: string, limit?: number) => rolloutSources.opening(file, limit);
export const onRolloutReady = (callback: (file: string) => void) => rolloutSources.onReady(callback);
export const rolloutPhysicalRevision = (file: string) => revisionKey(fs.statSync(file, { bigint: true }));
export function rolloutSourceReady(file: string): boolean {
  try {
    const source = openRolloutSource(file);
    source.close();
    return true;
  } catch {
    return false;
  }
}
export async function rolloutStatAsync(
  file: string,
  previous?: { size: number; mtimeMs: number; sourceIdentity?: string; rolloutRevision?: string },
  io: typeof fs = fs,
): Promise<fs.BigIntStats> {
  if (!isCompressedRollout(file)) return io.promises.stat(file, { bigint: true });
  const known = rolloutSources.knownStat(file);
  if (known) return known;
  const physical = await io.promises.stat(file, { bigint: true });
  const unchanged =
    previous?.rolloutRevision === revisionKey(physical) && previous.mtimeMs === revisionOf(physical).mtimeMs;
  return sized(physical, unchanged ? previous.size : 0);
}
// Catalog admission has no decoded length until a body reader prepares the source.
export const rolloutCatalogStat = (file: string, io: typeof fs = fs): fs.BigIntStats =>
  isCompressedRollout(file)
    ? (rolloutSources.knownStat(file) ?? sized(io.statSync(file, { bigint: true }), 0))
    : io.statSync(file, { bigint: true });
export function rolloutStat(file: string, options: { bigint: true }, io?: typeof fs): fs.BigIntStats;
export function rolloutStat(file: string, options?: { bigint?: false }, io?: typeof fs): fs.Stats;
export function rolloutStat(
  file: string,
  options?: { bigint?: boolean },
  io: typeof fs = fs,
): fs.Stats | fs.BigIntStats {
  if (!isCompressedRollout(file)) return options?.bigint ? io.statSync(file, { bigint: true }) : io.statSync(file);
  return options?.bigint ? rolloutSources.stat(file, { bigint: true }) : rolloutSources.stat(file);
}
export const setRolloutLogger = (log: (message: string) => void) => rolloutSources.setLogger(log);
