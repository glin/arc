import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { EXPORT_LIMITS, ExportLimitError } from './exportlimits';

type Identity = { dev: number; ino: number; size: number; mtimeMs: number };
type OwnedFile = Identity & { file: string };

export class ExportCancelled extends Error {
  constructor() {
    super('The export was cancelled.');
    this.name = 'ExportCancelled';
  }
}

export function checkExportCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ExportCancelled();
}

function sameIdentity(a: Identity, b: Identity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
function fileIdentity(stat: Identity): Identity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

async function ownedDirectory(directory: string, identity: Identity): Promise<boolean> {
  try {
    const stat = await fs.lstat(directory);
    return stat.isDirectory() && !stat.isSymbolicLink() && sameIdentity(stat, identity);
  } catch {
    return false;
  }
}

/** Flat, generated assets keep cleanup independent of source paths and directory links. */
export class ExportTransaction {
  private files = new Map<string, OwnedFile>();
  private sequence = 0;
  private published = false;
  private constructor(
    readonly staging: string,
    private readonly identity: Identity,
    private readonly parent: string,
    readonly signal?: AbortSignal,
    private readonly assetBytes: number = EXPORT_LIMITS.assetBytes,
  ) {}

  static async create(
    parent: string,
    signal?: AbortSignal,
    assetBytes: number = EXPORT_LIMITS.assetBytes,
  ): Promise<ExportTransaction> {
    checkExportCancellation(signal);
    const staging = await fs.mkdtemp(path.join(parent, '.arc-export-'));
    return new ExportTransaction(staging, await fs.lstat(staging), parent, signal, assetBytes);
  }

  private async check(): Promise<void> {
    checkExportCancellation(this.signal);
    if (this.published || !(await ownedDirectory(this.staging, this.identity))) {
      throw new Error('The export folder changed.');
    }
  }

  async writeAsset(kind: 'js' | 'css' | 'json', bytes: string | Uint8Array): Promise<string> {
    return this.write(`a-${(++this.sequence).toString(36)}.${kind}`, bytes, this.assetBytes);
  }

  async writeIndexChunks(chunks: AsyncIterable<string>): Promise<string> {
    await this.check();
    const key = 'index.html';
    const file = path.join(this.staging, key);
    const handle = await fs.open(file, 'wx');
    this.files.set(key, { file, ...fileIdentity(await handle.stat()) });
    let position = 0;
    try {
      for await (const chunk of chunks) {
        await this.check();
        const buffer = Buffer.from(chunk);
        for (let offset = 0; offset < buffer.length;) {
          checkExportCancellation(this.signal);
          const result = await handle.write(
            buffer,
            offset,
            Math.min(EXPORT_LIMITS.sliceBytes, buffer.length - offset),
            position,
          );
          if (!result.bytesWritten) throw new Error('The export file could not be saved.');
          offset += result.bytesWritten;
          position += result.bytesWritten;
        }
      }
    } finally {
      try {
        this.files.set(key, { file, ...fileIdentity(await handle.stat()) });
      } finally {
        await handle.close();
      }
    }
    return key;
  }

  async spool(page: unknown): Promise<string> {
    await this.check();
    // Spools contain one admitted semantic page and never enter the published directory.
    const text = JSON.stringify(page);
    return this.write(`s-${(++this.sequence).toString(36)}.json`, text, EXPORT_LIMITS.pageBytes * 8);
  }

  async readSpool<T>(key: string): Promise<T> {
    await this.check();
    if (!/^s-[a-z0-9]+\.json$/.test(key) || !this.files.has(key)) throw new Error('The export page is unavailable.');
    const owned = this.files.get(key)!;
    const stat = await fs.lstat(owned.file);
    if (
      stat.isSymbolicLink() ||
      !sameIdentity(stat, owned) ||
      stat.size !== owned.size ||
      stat.mtimeMs !== owned.mtimeMs
    ) {
      throw new Error('The export page changed.');
    }
    return JSON.parse(await fs.readFile(owned.file, 'utf8')) as T;
  }

  private async write(key: string, bytes: string | Uint8Array, limit: number): Promise<string> {
    await this.check();
    const size = typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.byteLength;
    if (size > limit) throw new ExportLimitError('asset', limit);
    const file = path.join(this.staging, key);
    const handle = await fs.open(file, 'wx');
    this.files.set(key, { file, ...fileIdentity(await handle.stat()) });
    try {
      const buffer = typeof bytes === 'string' ? Buffer.from(bytes) : bytes;
      for (let offset = 0; offset < buffer.length;) {
        checkExportCancellation(this.signal);
        const result = await handle.write(
          buffer,
          offset,
          Math.min(EXPORT_LIMITS.sliceBytes, buffer.length - offset),
          offset,
        );
        if (!result.bytesWritten) throw new Error('The export file could not be saved.');
        offset += result.bytesWritten;
      }
    } finally {
      try {
        this.files.set(key, { file, ...fileIdentity(await handle.stat()) });
      } finally {
        await handle.close();
      }
    }
    return key;
  }

  private async removeFile(key: string): Promise<void> {
    const owned = this.files.get(key)!;
    if (!(await ownedDirectory(this.staging, this.identity))) throw new Error('The export folder changed.');
    const stat = await fs.lstat(owned.file);
    if (
      stat.isSymbolicLink() ||
      !sameIdentity(stat, owned) ||
      stat.size !== owned.size ||
      stat.mtimeMs !== owned.mtimeMs
    ) {
      throw new Error('The export file changed.');
    }
    await fs.unlink(owned.file);
    this.files.delete(key);
  }

  async reset(): Promise<void> {
    await this.check();
    for (const key of [...this.files.keys()]) await this.removeFile(key);
  }

  async publish(recheck: () => Promise<void>): Promise<{ directory: string; index: string }> {
    await this.check();
    if (!this.files.has('index.html')) throw new Error('The export page is unavailable.');
    for (const key of [...this.files.keys()]) if (key.startsWith('s-')) await this.removeFile(key);
    await recheck();
    await this.check();
    // An exclusive reservation owns the publication parent on platforms whose rename replaces empty directories.
    let reservation: string;
    for (;;) {
      checkExportCancellation(this.signal);
      reservation = path.join(this.parent, `arc-session-${randomBytes(16).toString('hex')}`);
      try {
        await fs.mkdir(reservation);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const identity = await fs.lstat(reservation);
    try {
      checkExportCancellation(this.signal);
      if (!(await ownedDirectory(reservation, identity)) || (await fs.readdir(reservation)).length) {
        throw new Error('The export folder changed.');
      }
      const directory = path.join(reservation, 'site');
      await fs.rename(this.staging, directory);
      this.published = true;
      return { directory, index: path.join(directory, 'index.html') };
    } catch (error) {
      if (await ownedDirectory(reservation, identity)) await fs.rmdir(reservation).catch(() => {});
      throw error;
    }
  }

  async dispose(): Promise<void> {
    if (this.published || !(await ownedDirectory(this.staging, this.identity))) return;
    for (const key of [...this.files.keys()]) await this.removeFile(key);
    await fs.rmdir(this.staging);
  }
}

export async function withExportTransaction<T>(
  parent: string,
  operation: (writer: ExportTransaction) => Promise<T>,
  signal?: AbortSignal,
  assetBytes?: number,
): Promise<T> {
  const writer = await ExportTransaction.create(parent, signal, assetBytes);
  try {
    return await operation(writer);
  } finally {
    await writer.dispose();
  }
}
