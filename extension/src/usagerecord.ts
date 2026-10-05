import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { gzip } from 'node:zlib';
import type { FileHandle } from 'node:fs/promises';
import { RateLimit, UsageReading } from './agentwire';

export const USAGE_STORE_DIRECTORY = 'bounded-v1';
export const USAGE_SLOT_COUNT = 30;
export const USAGE_PAYLOAD_BYTES = 4 * 1024 * 1024;
export const USAGE_OVERHEAD_BYTES = 8 * 1024;
export const USAGE_DAY_RAW_BYTES = 64 * 1024 * 1024;
export const USAGE_BATCH_BYTES = 64 * 1024;
export const USAGE_QUEUE_BYTES = 256 * 1024;
const DAY_MS = 86_400_000;
const FORMAT = 'arc-usage-gzip-v1\n';
const MAX_STRING_LENGTH = 256;
const MAX_LIMITS = 64;

export interface UsageSlotMetadata {
  v: 1;
  day: number;
  generation: string;
  compressed: number;
  raw: number;
}

interface UsageRecorderOptions {
  now?: () => number;
  compress?: (raw: Buffer) => Promise<Buffer>;
  filesystem?: typeof fs.promises;
}

interface UsageRecordLine {
  v: 1;
  agent: string;
  readAt: number;
  complete: boolean;
  plan: string;
  window: string;
  group: string;
  scope: string;
  utilization: number | null;
  resetsAt: number | null;
  creditResetsAt: number | null;
  status: string;
  spendUsedMinor?: number;
  spendLimitMinor?: number;
  spendCurrency?: string;
}

function recordLine(agent: string, reading: UsageReading, limit: RateLimit | null): UsageRecordLine {
  const line: UsageRecordLine = {
    v: 1,
    agent,
    readAt: reading.readAt,
    complete: reading.complete,
    plan: reading.plan,
    window: limit?.window ?? '',
    group: limit?.group ?? '',
    scope: limit?.scope ?? '',
    utilization: limit?.utilization ?? null,
    resetsAt: limit?.resetsAtSeconds ?? null,
    creditResetsAt: reading.creditResetsAtSeconds ?? null,
    status: limit?.status ?? '',
  };
  if (reading.spend) {
    line.spendUsedMinor = reading.spend.usedMinor;
    line.spendLimitMinor = reading.spend.limitMinor;
    line.spendCurrency = reading.spend.currency;
  }
  return line;
}

export function usageRecordLines(agent: string, reading: UsageReading): string[] {
  const strings = [agent, reading.plan, reading.spend?.currency ?? ''];
  if (!Array.isArray(reading.limits) || reading.limits.length > MAX_LIMITS) return [];
  let upperBytes = Math.max(1, reading.limits.length) * 512;
  for (const limit of reading.limits) {
    strings.push(limit.window, limit.group, limit.scope, limit.status);
    if (
      !Number.isFinite(limit.utilization) ||
      (limit.resetsAtSeconds !== null && !Number.isFinite(limit.resetsAtSeconds))
    )
      return [];
  }
  if (strings.some((value) => typeof value !== 'string' || value.length > MAX_STRING_LENGTH)) return [];
  upperBytes +=
    6 *
    ((agent.length + reading.plan.length + (reading.spend?.currency.length ?? 0)) * Math.max(1, reading.limits.length) +
      strings.slice(3).reduce((sum, value) => sum + value.length, 0));
  if (
    upperBytes > USAGE_BATCH_BYTES ||
    !Number.isFinite(reading.readAt) ||
    Number.isNaN(new Date(reading.readAt).getTime())
  )
    return [];
  if (reading.spend && ![reading.spend.usedMinor, reading.spend.limitMinor].every(Number.isFinite)) return [];
  if (reading.creditResetsAtSeconds != null && !Number.isFinite(reading.creditResetsAtSeconds)) return [];
  if (!reading.limits.length && !reading.spend && reading.creditResetsAtSeconds == null) {
    return [];
  }
  const limits: (RateLimit | null)[] = reading.limits.length ? reading.limits : [null];
  return limits.map((limit) => JSON.stringify(recordLine(agent, reading, limit)));
}

export class UsageRecorder {
  private readonly filesystem: typeof fs.promises;
  private readonly now: () => number;
  private readonly compress: (raw: Buffer) => Promise<Buffer>;
  private queue: { day: number; raw: Buffer }[] = [];
  private admittedBytes = 0;
  private pending: Promise<void> = Promise.resolve();
  private running = false;
  private closed = false;

  constructor(
    private readonly directory: string,
    options: UsageRecorderOptions = {},
  ) {
    this.filesystem = options.filesystem ?? fs.promises;
    this.now = options.now ?? Date.now;
    this.compress =
      options.compress ??
      ((raw) =>
        new Promise((resolve, reject) => {
          gzip(raw, { maxOutputLength: USAGE_BATCH_BYTES + 1024 }, (error, result) =>
            error ? reject(error) : resolve(result),
          );
        }));
  }

  record(agent: string, reading: UsageReading): void {
    try {
      if (this.closed) return;
      const day = Math.floor(reading.readAt / DAY_MS);
      const current = Math.floor(this.now() / DAY_MS);
      if (!Number.isSafeInteger(current) || day > current || day < current - USAGE_SLOT_COUNT + 1) return;
      const lines = usageRecordLines(agent, reading);
      if (!lines.length) return;
      const raw = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
      if (raw.length > USAGE_BATCH_BYTES || this.admittedBytes + raw.length > USAGE_QUEUE_BYTES) return;
      this.queue.push({ day, raw });
      this.admittedBytes += raw.length;
      if (this.running) return;
      this.running = true;
      this.pending = Promise.resolve()
        .then(() => this.run())
        .catch(() => undefined);
    } catch {
      // Historical recording failures leave current account figures available.
    }
  }

  drain(): Promise<void> {
    return this.pending;
  }

  dispose(): Promise<void> {
    this.closed = true;
    for (const item of this.queue) this.admittedBytes -= item.raw.length;
    this.queue = [];
    return this.pending;
  }

  private async run(): Promise<void> {
    try {
      while (!this.closed && this.queue.length) {
        const first = this.queue.shift()!;
        const parts = [first.raw];
        let length = first.raw.length;
        while (this.queue[0]?.day === first.day && length + this.queue[0].raw.length <= USAGE_BATCH_BYTES) {
          const next = this.queue.shift()!;
          parts.push(next.raw);
          length += next.raw.length;
        }
        try {
          const compressed = await this.compress(Buffer.concat(parts, length));
          if (!this.closed && compressed.length <= USAGE_BATCH_BYTES + 1024)
            await this.append(first.day, compressed, length);
        } catch {
          // A failed batch does not stop later readings or the live account state.
        } finally {
          this.admittedBytes -= length;
        }
      }
    } finally {
      this.running = false;
    }
  }

  private slot(day: number): string {
    return String(((day % USAGE_SLOT_COUNT) + USAGE_SLOT_COUNT) % USAGE_SLOT_COUNT).padStart(2, '0');
  }

  private async regular(file: string): Promise<fs.Stats | null> {
    try {
      const stat = await this.filesystem.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsupported usage file');
      return stat;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async prepare(): Promise<void> {
    let ancestor = path.resolve(this.directory);
    for (let depth = 0; ; depth++) {
      if (this.closed) return;
      if (depth > 64) throw new Error('Usage directory exceeds path bound');
      try {
        const stat = await this.filesystem.lstat(ancestor);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsupported usage directory');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    if (this.closed) return;
    await this.filesystem.mkdir(this.directory, { recursive: true });
    if (this.closed) return;
    const entries = await this.inspect();
    if (this.closed) return;
    const format = path.join(this.directory, 'format');
    if (entries.has('format')) {
      if ((await this.filesystem.readFile(format, 'utf8')) !== FORMAT) throw new Error('Unsupported usage format');
    } else {
      if (entries.size) throw new Error('Missing usage format');
      const handle = await this.filesystem.open(format, 'wx');
      if (this.closed) {
        await handle.close();
        return;
      }
      await this.finish(handle, Buffer.from(FORMAT), 0, false);
    }
  }

  private async inspect(owned = false): Promise<Map<string, number>> {
    const sizes = new Map<string, number>();
    const overhead = new Map<string, number>();
    const directory = await this.filesystem.opendir(this.directory);
    let count = 0;
    try {
      while (true) {
        if (!owned && this.closed) break;
        const entry = await directory.read();
        if (!entry || (!owned && this.closed)) break;
        if (++count > 1 + 4 * USAGE_SLOT_COUNT) throw new Error('Usage directory exceeds entry bound');
        const name = entry.name;
        const match = /^(\d{2})\.(gz|json|tmp|lock)$/.exec(name);
        if (name !== 'format' && (!match || Number(match[1]) >= USAGE_SLOT_COUNT))
          throw new Error('Unknown usage file');
        const stat = await this.regular(path.join(this.directory, name));
        if (!owned && this.closed) break;
        if (!stat) continue;
        sizes.set(name, stat.size);
        if (name === 'format') {
          if (stat.size !== Buffer.byteLength(FORMAT)) throw new Error('Invalid usage format size');
        } else if (match![2] === 'gz') {
          if (stat.size > USAGE_PAYLOAD_BYTES) throw new Error('Usage payload exceeds quota');
        } else {
          const bytes = (overhead.get(match![1]) ?? 0) + stat.size;
          if (bytes > USAGE_OVERHEAD_BYTES) throw new Error('Usage metadata exceeds quota');
          overhead.set(match![1], bytes);
        }
      }
    } finally {
      await directory.close();
    }
    return sizes;
  }

  private async finish(
    handle: FileHandle,
    bytes: Buffer,
    position: number,
    owned: boolean,
    expectedSize?: number,
  ): Promise<void> {
    try {
      if (expectedSize !== undefined) {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== expectedSize) throw new Error('Changed usage payload');
      }
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.write(bytes, offset, bytes.length - offset, position + offset);
        if (!owned && this.closed) return;
        if (
          !Number.isInteger(result.bytesWritten) ||
          result.bytesWritten <= 0 ||
          result.bytesWritten > bytes.length - offset
        )
          throw new Error('Incomplete usage write');
        offset += result.bytesWritten;
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async metadata(file: string, slot: string, sizes: Map<string, number>): Promise<UsageSlotMetadata | null> {
    if (!sizes.has(`${slot}.json`)) return null;
    if (sizes.get(`${slot}.json`)! > 1024) throw new Error('Oversized usage metadata');
    const value = JSON.parse(await this.filesystem.readFile(file, 'utf8')) as UsageSlotMetadata;
    if (
      value.v !== 1 ||
      !Number.isSafeInteger(value.day) ||
      Math.abs(value.day) > 100_000_000 ||
      this.slot(value.day) !== slot ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.generation) ||
      !Number.isSafeInteger(value.compressed) ||
      value.compressed < 0 ||
      value.compressed > USAGE_PAYLOAD_BYTES ||
      !Number.isSafeInteger(value.raw) ||
      value.raw < 0 ||
      value.raw > USAGE_DAY_RAW_BYTES ||
      (value.compressed === 0) !== (value.raw === 0)
    )
      throw new Error('Invalid usage metadata');
    return value;
  }

  private async publish(slot: string, value: UsageSlotMetadata, sizes: Map<string, number>): Promise<void> {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    const overhead = (sizes.get(`${slot}.json`) ?? 0) + (sizes.get(`${slot}.lock`) ?? 0);
    if (bytes.length > 1024 || overhead + bytes.length > USAGE_OVERHEAD_BYTES || sizes.has(`${slot}.tmp`))
      throw new Error('Usage publication exceeds quota');
    const temporary = path.join(this.directory, `${slot}.tmp`);
    await this.finish(await this.filesystem.open(temporary, 'wx'), bytes, 0, true);
    await this.filesystem.rename(temporary, path.join(this.directory, `${slot}.json`));
    sizes.set(`${slot}.json`, bytes.length);
  }

  private async append(day: number, compressed: Buffer, raw: number): Promise<void> {
    if (this.closed) return;
    await this.prepare();
    if (this.closed) return;
    const slot = this.slot(day);
    const lock = path.join(this.directory, `${slot}.lock`);
    let owner: FileHandle;
    try {
      owner = await this.filesystem.open(lock, 'wx');
    } catch {
      return;
    }
    let success = false;
    try {
      await owner.close();
      const sizes = await this.inspect(true);
      const current = Math.floor(this.now() / DAY_MS);
      if (!Number.isSafeInteger(current) || day > current || day < current - USAGE_SLOT_COUNT + 1) {
        success = true;
        return;
      }
      const data = path.join(this.directory, `${slot}.gz`);
      const meta = path.join(this.directory, `${slot}.json`);
      let value = await this.metadata(meta, slot, sizes);
      if (
        sizes.has(`${slot}.tmp`) ||
        (value && (!sizes.has(`${slot}.gz`) || sizes.get(`${slot}.gz`) !== value.compressed))
      )
        throw new Error('Uncertain usage prefix');
      if (!value && sizes.has(`${slot}.gz`)) throw new Error('Missing usage metadata');
      if (
        value &&
        (value.day > current || value.day > day || (value.day !== day && value.day >= current - USAGE_SLOT_COUNT + 1))
      ) {
        success = true;
        return;
      }
      if (value?.day !== day) {
        if (value) await this.filesystem.unlink(data);
        await this.finish(await this.filesystem.open(data, 'wx'), Buffer.alloc(0), 0, true);
        value = { v: 1, day, generation: randomUUID(), compressed: 0, raw: 0 };
        await this.publish(slot, value, sizes);
        sizes.set(`${slot}.gz`, 0);
      }
      if (value.compressed + compressed.length > USAGE_PAYLOAD_BYTES || value.raw + raw > USAGE_DAY_RAW_BYTES) {
        success = true;
        return;
      }
      const handle = await this.filesystem.open(data, 'r+');
      await this.finish(handle, compressed, value.compressed, true, value.compressed);
      await this.publish(
        slot,
        { ...value, compressed: value.compressed + compressed.length, raw: value.raw + raw },
        sizes,
      );
      success = true;
    } finally {
      if (success) await this.filesystem.unlink(lock);
    }
  }
}
